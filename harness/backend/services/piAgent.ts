import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  Agent,
  type AgentEvent,
  type AgentMessage,
  type AgentTool,
} from "@mariozechner/pi-agent-core";
import {
  getModel,
  getModels,
  Type,
  type AssistantMessage,
  type Message,
  type Model,
  type TextContent,
  type ToolCall,
  type ToolResultMessage,
} from "@mariozechner/pi-ai";
import type {
  ImageAttachment,
  PermissionMode,
  SessionKind,
  StreamResponse,
} from "../../shared/types.ts";
import {
  parsePiModelId,
  providerProfileStore,
  type StoredPiProviderProfile,
} from "./providerProfiles.ts";

type QueueItem =
  | StreamResponse
  | {
      type: "close";
    };

interface ExecutePiAgentOptions {
  message: string;
  requestId: string;
  sessionId: string;
  providerSessionId?: string | null;
  model?: string;
  workingDirectory?: string;
  permissionMode?: PermissionMode;
  effort?: string;
  transcript: unknown[];
  attachments?: ImageAttachment[];
  appendSystemPrompt?: string;
  sessionKind?: SessionKind;
  wasAborted?: () => boolean;
  onAbort?: (abort: () => void) => void;
}

interface AsyncQueue<T> {
  push(item: T): void;
  close(): void;
  next(): Promise<T | undefined>;
}

function createAsyncQueue<T>(): AsyncQueue<T> {
  const items: T[] = [];
  const waiters: Array<(item: T | undefined) => void> = [];
  let closed = false;
  return {
    push(item) {
      if (closed) return;
      const waiter = waiters.shift();
      if (waiter) waiter(item);
      else items.push(item);
    },
    close() {
      if (closed) return;
      closed = true;
      while (waiters.length > 0) {
        waiters.shift()?.(undefined);
      }
    },
    next() {
      const item = items.shift();
      if (item) return Promise.resolve(item);
      if (closed) return Promise.resolve(undefined);
      return new Promise((resolveNext) => waiters.push(resolveNext));
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function truncate(text: string, limit = 20_000): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n...[truncated ${text.length - limit} chars]`;
}

function timestamp(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
}

function textFromPiContent(
  content: AssistantMessage["content"] | ToolResultMessage["content"],
): string {
  return content
    .filter((item): item is TextContent => item.type === "text")
    .map((item) => item.text)
    .join("");
}

function textBlocksToString(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => {
      if (!isRecord(item)) return "";
      if (typeof item.text === "string") return item.text;
      if (typeof item.content === "string") return item.content;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function defaultUsage(): AssistantMessage["usage"] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
}

function isToolCallOnlyAssistant(
  message: Message,
): message is AssistantMessage {
  return (
    message.role === "assistant" &&
    message.content.length > 0 &&
    message.content.every((item) => item.type === "toolCall")
  );
}

function coalesceAssistantToolCallMessages(messages: Message[]): Message[] {
  const coalesced: Message[] = [];
  for (const message of messages) {
    const previous = coalesced[coalesced.length - 1];
    if (
      previous &&
      isToolCallOnlyAssistant(previous) &&
      isToolCallOnlyAssistant(message)
    ) {
      previous.content.push(...message.content);
      previous.stopReason = "toolUse";
      continue;
    }
    coalesced.push(message);
  }
  return coalesced;
}

function toPiMessages(
  transcript: unknown[],
  fallbackModel: Model<any>,
): Message[] {
  const messages: Message[] = [];
  for (const raw of transcript) {
    if (!isRecord(raw)) continue;
    const ts = timestamp(raw.timestamp);

    if (raw.type === "user" || raw.role === "user") {
      const payload = isRecord(raw.message) ? raw.message : raw;
      const content = payload.content;
      if (Array.isArray(content)) {
        for (const item of content) {
          if (!isRecord(item)) continue;
          if (item.type === "tool_result") {
            messages.push({
              role: "toolResult",
              toolCallId:
                typeof item.tool_use_id === "string" ? item.tool_use_id : "",
              toolName: "Tool",
              content: [
                { type: "text", text: textBlocksToString(item.content) },
              ],
              isError: item.is_error === true,
              timestamp: ts,
            });
          } else if (item.type === "text" && typeof item.text === "string") {
            messages.push({ role: "user", content: item.text, timestamp: ts });
          }
        }
      } else if (typeof content === "string" && content.trim()) {
        messages.push({ role: "user", content, timestamp: ts });
      }
      continue;
    }

    if (raw.type === "assistant" || raw.role === "assistant") {
      const payload = isRecord(raw.message) ? raw.message : raw;
      const content = Array.isArray(payload.content) ? payload.content : [];
      const piContent: AssistantMessage["content"] = [];
      for (const item of content) {
        if (!isRecord(item)) continue;
        if (item.type === "text" && typeof item.text === "string") {
          piContent.push({ type: "text", text: item.text });
        } else if (
          item.type === "thinking" &&
          typeof item.thinking === "string"
        ) {
          piContent.push({ type: "thinking", thinking: item.thinking });
        } else if (item.type === "tool_use") {
          piContent.push({
            type: "toolCall",
            id: typeof item.id === "string" ? item.id : randomUUID(),
            name: typeof item.name === "string" ? item.name : "Tool",
            arguments: isRecord(item.input) ? item.input : {},
          });
        }
      }
      if (piContent.length > 0) {
        messages.push({
          role: "assistant",
          content: piContent,
          api: fallbackModel.api,
          provider: fallbackModel.provider,
          model: fallbackModel.id,
          usage: defaultUsage(),
          stopReason: piContent.some((item) => item.type === "toolCall")
            ? "toolUse"
            : "stop",
          timestamp: ts,
        });
      }
    }
  }
  return coalesceAssistantToolCallMessages(messages);
}

function withPiModelOverrides(
  profile: StoredPiProviderProfile,
  model: Model<any>,
): Model<any> {
  const compat = withOpenRouterDataPolicy(profile, model);
  return {
    ...model,
    ...(profile.baseUrl ? { baseUrl: profile.baseUrl } : {}),
    ...(profile.headers ? { headers: profile.headers } : {}),
    ...(compat ? { compat: compat as never } : {}),
  };
}

function withOpenRouterDataPolicy(
  profile: StoredPiProviderProfile,
  model: Model<any>,
): Record<string, unknown> | undefined {
  const compat = profile.compat ? { ...profile.compat } : {};
  const baseUrl = profile.baseUrl ?? model.baseUrl ?? "";
  const isOpenRouter =
    profile.provider === "openrouter" ||
    baseUrl.toLowerCase().includes("openrouter.ai");

  if (!isOpenRouter || profile.denyOpenRouterDataCollection === false) {
    return Object.keys(compat).length > 0 ? compat : undefined;
  }

  const existingRouting = isRecord(compat.openRouterRouting)
    ? compat.openRouterRouting
    : {};
  compat.openRouterRouting = {
    ...existingRouting,
    data_collection: "deny",
  };
  return compat;
}

function resolvePiModel(
  profile: StoredPiProviderProfile,
  rawModelId: string,
): Model<any> {
  try {
    const model = getModel(
      profile.provider as never,
      rawModelId as never,
    ) as Model<any> | undefined;
    if (model) return withPiModelOverrides(profile, model);
  } catch {
    // Fall through to the manual-model template path below.
  }

  const [template] = getModels(profile.provider as never) as Model<any>[];
  if (!template)
    throw new Error(`No models are registered for ${profile.provider}`);
  return withPiModelOverrides(profile, {
    ...template,
    id: rawModelId,
    name: rawModelId,
  });
}

function resolveToolPath(root: string, requested: string): string {
  const base = resolve(root);
  const candidate = isAbsolute(requested)
    ? resolve(requested)
    : resolve(base, requested);
  if (candidate !== base && !candidate.startsWith(`${base}/`)) {
    throw new Error(`Path outside project: ${requested}`);
  }
  return candidate;
}

async function walkFiles(root: string, limit = 500): Promise<string[]> {
  const files: string[] = [];
  async function walk(dir: string): Promise<void> {
    if (files.length >= limit) return;
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (files.length >= limit) break;
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) files.push(full);
    }
  }
  await walk(root);
  return files;
}

function globToRegex(pattern: string): RegExp {
  let source = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    const next = pattern[i + 1];
    const afterNext = pattern[i + 2];

    if (char === "*" && next === "*" && afterNext === "/") {
      source += "(?:.*/)?";
      i += 2;
      continue;
    }
    if (char === "*" && next === "*") {
      source += ".*";
      i += 1;
      continue;
    }
    if (char === "*") {
      source += "[^/]*";
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      continue;
    }
    if ("\\.^$+{}()|[]".includes(char)) {
      source += `\\${char}`;
      continue;
    }
    source += char;
  }
  return new RegExp(`^${source}$`);
}

function makeTextResult(
  text: string,
  details: unknown = {},
): { content: TextContent[]; details: unknown } {
  return { content: [{ type: "text", text: truncate(text) }], details };
}

function buildCoreTools(root: string): AgentTool[] {
  return [
    {
      name: "Read",
      label: "Read",
      description: "Read a UTF-8 text file in the current project.",
      parameters: Type.Object({
        file_path: Type.String({ description: "File path to read." }),
      }),
      execute: async (_id, params) => {
        const args = params as { file_path: string };
        const path = resolveToolPath(root, args.file_path);
        const s = await stat(path);
        if (!s.isFile()) throw new Error("Path is not a file");
        if (s.size > 2_000_000) throw new Error("File is too large to read");
        return makeTextResult(await readFile(path, "utf-8"), { path });
      },
    },
    {
      name: "Write",
      label: "Write",
      description: "Write a UTF-8 text file in the current project.",
      parameters: Type.Object({
        file_path: Type.String({ description: "File path to write." }),
        content: Type.String({ description: "Complete file contents." }),
      }),
      execute: async (_id, params) => {
        const args = params as { file_path: string; content: string };
        const path = resolveToolPath(root, args.file_path);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, args.content, "utf-8");
        return makeTextResult(`Wrote ${relative(root, path) || path}`, {
          path,
        });
      },
    },
    {
      name: "Edit",
      label: "Edit",
      description:
        "Replace text in an existing UTF-8 file in the current project.",
      parameters: Type.Object({
        file_path: Type.String({ description: "File path to edit." }),
        old_string: Type.String({ description: "Existing text to replace." }),
        new_string: Type.String({ description: "Replacement text." }),
        replace_all: Type.Optional(
          Type.Boolean({ description: "Replace every occurrence." }),
        ),
      }),
      execute: async (_id, params) => {
        const args = params as {
          file_path: string;
          old_string: string;
          new_string: string;
          replace_all?: boolean;
        };
        const path = resolveToolPath(root, args.file_path);
        const before = await readFile(path, "utf-8");
        if (!before.includes(args.old_string)) {
          throw new Error("old_string was not found");
        }
        const after = args.replace_all
          ? before.split(args.old_string).join(args.new_string)
          : before.replace(args.old_string, args.new_string);
        await writeFile(path, after, "utf-8");
        return makeTextResult(`Edited ${relative(root, path) || path}`, {
          structuredPatch: [
            {
              lines: [
                `- ${args.old_string.split("\n")[0] ?? ""}`,
                `+ ${args.new_string.split("\n")[0] ?? ""}`,
              ],
            },
          ],
        });
      },
    },
    {
      name: "Glob",
      label: "Glob",
      description: "Find files in the current project using a glob pattern.",
      parameters: Type.Object({
        pattern: Type.String({ description: "Glob pattern, e.g. **/*.ts." }),
        path: Type.Optional(
          Type.String({ description: "Directory to search from." }),
        ),
      }),
      execute: async (_id, params) => {
        const args = params as { pattern: string; path?: string };
        const searchRoot = resolveToolPath(root, args.path ?? ".");
        const matcher = globToRegex(args.pattern);
        const files = await walkFiles(searchRoot);
        const matches = files
          .map((file) => relative(searchRoot, file))
          .filter((file) => matcher.test(file))
          .slice(0, 200);
        return makeTextResult(matches.join("\n") || "No matches", { matches });
      },
    },
    {
      name: "Grep",
      label: "Grep",
      description: "Search text files in the current project.",
      parameters: Type.Object({
        pattern: Type.String({
          description: "Substring or regular expression to search for.",
        }),
        path: Type.Optional(
          Type.String({ description: "Directory to search from." }),
        ),
        glob: Type.Optional(
          Type.String({ description: "Optional file glob." }),
        ),
      }),
      execute: async (_id, params) => {
        const args = params as {
          pattern: string;
          path?: string;
          glob?: string;
        };
        const searchRoot = resolveToolPath(root, args.path ?? ".");
        const globMatcher = args.glob ? globToRegex(args.glob) : null;
        let regex: RegExp | null = null;
        try {
          regex = new RegExp(args.pattern);
        } catch {
          regex = null;
        }
        const lines: string[] = [];
        for (const file of await walkFiles(searchRoot, 1000)) {
          const rel = relative(searchRoot, file);
          if (globMatcher && !globMatcher.test(rel)) continue;
          const s = await stat(file);
          if (s.size > 1_000_000) continue;
          let content = "";
          try {
            content = await readFile(file, "utf-8");
          } catch {
            continue;
          }
          content.split("\n").forEach((line, index) => {
            if (lines.length >= 200) return;
            const matched = regex
              ? regex.test(line)
              : line.includes(args.pattern);
            if (matched) lines.push(`${rel}:${index + 1}:${line}`);
          });
          if (lines.length >= 200) break;
        }
        return makeTextResult(lines.join("\n") || "No matches", {
          matches: lines,
        });
      },
    },
    {
      name: "Bash",
      label: "Bash",
      description: "Run a shell command in the current project.",
      parameters: Type.Object({
        command: Type.String({ description: "Shell command to run." }),
        timeout_ms: Type.Optional(
          Type.Number({ description: "Optional timeout in milliseconds." }),
        ),
      }),
      executionMode: "sequential",
      execute: async (_id, params, signal) =>
        new Promise((resolveRun, rejectRun) => {
          const args = params as { command: string; timeout_ms?: number };
          const timeoutMs = Math.min(
            Math.max(args.timeout_ms ?? 120_000, 1_000),
            600_000,
          );
          const child = spawn(args.command, {
            cwd: root,
            shell: true,
            stdio: ["ignore", "pipe", "pipe"],
            env: { ...process.env },
          });
          let stdout = "";
          let stderr = "";
          let interrupted = false;
          const timer = setTimeout(() => {
            interrupted = true;
            child.kill("SIGTERM");
          }, timeoutMs);
          signal?.addEventListener("abort", () => {
            interrupted = true;
            child.kill("SIGTERM");
          });
          child.stdout?.on("data", (chunk: Buffer) => {
            stdout += chunk.toString();
          });
          child.stderr?.on("data", (chunk: Buffer) => {
            stderr += chunk.toString();
          });
          child.once("error", rejectRun);
          child.once("close", (code) => {
            clearTimeout(timer);
            const body = [stdout.trim(), stderr.trim()]
              .filter(Boolean)
              .join("\n");
            resolveRun({
              content: [
                {
                  type: "text",
                  text: truncate(body || `(exit code: ${code ?? "unknown"})`),
                },
              ],
              details: {
                stdout,
                stderr,
                interrupted,
                isImage: false,
                exitCode: code,
              },
            });
          });
        }),
    },
    {
      name: "TodoWrite",
      label: "TodoWrite",
      description: "Record the current task todo list.",
      parameters: Type.Object({
        todos: Type.Array(Type.Any()),
      }),
      execute: async (_id, params) => {
        const args = params as { todos: unknown[] };
        return makeTextResult("Todo list updated", { todos: args.todos });
      },
    },
  ];
}

function buildSubagentTools(args: {
  backendUrl: string;
  internalToken: string;
  parentSessionId: string;
}): AgentTool[] {
  const headers = {
    "content-type": "application/json",
    "x-swarmfleet-internal-token": args.internalToken,
  };
  return [
    {
      name: "mcp__swarmfleet__spawn_subagent",
      label: "spawn_subagent",
      description:
        "Spawn a child SwarmFleet agent session in the same project. Returns a subagent_id; call mcp__swarmfleet__monitor_subagent to wait for completion.",
      parameters: Type.Object({
        prompt: Type.String({
          description: "Initial prompt sent to the child agent.",
        }),
        title: Type.Optional(
          Type.String({ description: "Optional short title." }),
        ),
        model: Type.Optional(
          Type.String({
            description:
              "Optional model override. Omit unless the user explicitly asks for a model. Defaults: Codex and Pi inherit the parent model; Claude uses the configured default subagent model, or the global Codex default.",
          }),
        ),
      }),
      execute: async (id, params) => {
        const toolArgs = params as {
          prompt: string;
          title?: string;
          model?: string;
        };
        if (!args.backendUrl || !args.internalToken) {
          throw new Error("Subagent backend is not configured");
        }
        const response = await fetch(
          `${args.backendUrl}/internal/subagents/spawn`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({
              parentSessionId: args.parentSessionId,
              prompt: toolArgs.prompt,
              title: toolArgs.title,
              model: toolArgs.model,
              parentToolUseId: typeof id === "string" ? id : undefined,
            }),
          },
        );
        const json = await response.json().catch(() => ({}));
        if (!response.ok)
          throw new Error(`spawn_subagent failed: ${JSON.stringify(json)}`);
        return makeTextResult(JSON.stringify(json), json);
      },
    },
    {
      name: "mcp__swarmfleet__monitor_subagent",
      label: "monitor_subagent",
      description: "Wait for a child SwarmFleet subagent to finish.",
      parameters: Type.Object({
        subagent_id: Type.String({
          description: "Subagent id returned by spawn.",
        }),
        timeout_ms: Type.Optional(
          Type.Number({ description: "Optional timeout in milliseconds." }),
        ),
      }),
      execute: async (_id, params) => {
        const toolArgs = params as { subagent_id: string; timeout_ms?: number };
        if (!args.backendUrl || !args.internalToken) {
          throw new Error("Subagent backend is not configured");
        }
        const url = new URL(
          `${args.backendUrl}/internal/subagents/${encodeURIComponent(toolArgs.subagent_id)}/wait`,
        );
        if (toolArgs.timeout_ms)
          url.searchParams.set("timeout_ms", String(toolArgs.timeout_ms));
        const response = await fetch(url, { headers });
        const json = await response.json().catch(() => ({}));
        if (!response.ok)
          throw new Error(`monitor_subagent failed: ${JSON.stringify(json)}`);
        return makeTextResult(JSON.stringify(json), json);
      },
    },
    {
      name: "mcp__swarmfleet__list_providers_and_models",
      label: "list_providers_and_models",
      description:
        "List provider groups, model ids, and the configured default subagent model. Use this before passing a model override to spawn_subagent.",
      parameters: Type.Object({}),
      execute: async () => {
        const response = await fetch(
          `${args.backendUrl}/internal/providers/models`,
          {
            headers,
          },
        );
        const json = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(
            `list_providers_and_models failed: ${JSON.stringify(json)}`,
          );
        }
        return makeTextResult(JSON.stringify(json), json);
      },
    },
    {
      name: "mcp__swarmfleet__run_detached_shell",
      label: "run_detached_shell",
      description:
        "Start a backend-owned detached shell command in this session's project. Returns a job id, pid, and log paths.",
      parameters: Type.Object({
        command: Type.String({
          description: "Shell command to run via bash -lc.",
        }),
        cwd: Type.Optional(
          Type.String({
            description: "Optional working directory inside the project.",
          }),
        ),
        label: Type.Optional(
          Type.String({ description: "Optional short label." }),
        ),
      }),
      execute: async (_id, params) => {
        const toolArgs = params as {
          command: string;
          cwd?: string;
          label?: string;
        };
        const response = await fetch(
          `${args.backendUrl}/internal/shell-jobs/run`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({
              parentSessionId: args.parentSessionId,
              command: toolArgs.command,
              cwd: toolArgs.cwd,
              label: toolArgs.label,
            }),
          },
        );
        const json = await response.json().catch(() => ({}));
        if (!response.ok)
          throw new Error(`run_detached_shell failed: ${JSON.stringify(json)}`);
        return makeTextResult(JSON.stringify(json), json);
      },
    },
    {
      name: "mcp__swarmfleet__list_shell_jobs",
      label: "list_shell_jobs",
      description: "List backend-owned detached shell jobs for this session.",
      parameters: Type.Object({}),
      execute: async () => {
        const url = new URL(`${args.backendUrl}/internal/shell-jobs/list`);
        url.searchParams.set("parentSessionId", args.parentSessionId);
        const response = await fetch(url, { headers });
        const json = await response.json().catch(() => ({}));
        if (!response.ok)
          throw new Error(`list_shell_jobs failed: ${JSON.stringify(json)}`);
        return makeTextResult(JSON.stringify(json), json);
      },
    },
    {
      name: "mcp__swarmfleet__read_shell_job",
      label: "read_shell_job",
      description:
        "Read metadata and recent stdout/stderr for a detached shell job.",
      parameters: Type.Object({
        job_id: Type.String({
          description: "Job id returned by run_detached_shell.",
        }),
      }),
      execute: async (_id, params) => {
        const toolArgs = params as { job_id: string };
        const url = new URL(
          `${args.backendUrl}/internal/shell-jobs/${encodeURIComponent(toolArgs.job_id)}`,
        );
        url.searchParams.set("parentSessionId", args.parentSessionId);
        const response = await fetch(url, { headers });
        const json = await response.json().catch(() => ({}));
        if (!response.ok)
          throw new Error(`read_shell_job failed: ${JSON.stringify(json)}`);
        return makeTextResult(JSON.stringify(json), json);
      },
    },
    {
      name: "mcp__swarmfleet__kill_shell_job",
      label: "kill_shell_job",
      description:
        "Stop a backend-owned detached shell job and tagged descendants.",
      parameters: Type.Object({
        job_id: Type.String({
          description: "Job id returned by run_detached_shell.",
        }),
      }),
      execute: async (_id, params) => {
        const toolArgs = params as { job_id: string };
        const response = await fetch(
          `${args.backendUrl}/internal/shell-jobs/${encodeURIComponent(toolArgs.job_id)}/kill`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({ parentSessionId: args.parentSessionId }),
          },
        );
        const json = await response.json().catch(() => ({}));
        if (!response.ok)
          throw new Error(`kill_shell_job failed: ${JSON.stringify(json)}`);
        return makeTextResult(JSON.stringify(json), json);
      },
    },
    {
      name: "mcp__swarmfleet__post_latest_screenshot",
      label: "post_latest_screenshot",
      description:
        "Post the latest screenshot captured by browser/devtools tools into the visible conversation as an image.",
      parameters: Type.Object({
        caption: Type.Optional(
          Type.String({
            description: "Optional caption shown under the image.",
          }),
        ),
      }),
      execute: async (_id, params) => {
        const toolArgs = params as { caption?: string };
        const response = await fetch(
          `${args.backendUrl}/internal/assets/post-latest`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({
              parentSessionId: args.parentSessionId,
              caption: toolArgs.caption,
            }),
          },
        );
        const json = await response.json().catch(() => ({}));
        if (!response.ok)
          throw new Error(
            `post_latest_screenshot failed: ${JSON.stringify(json)}`,
          );
        return makeTextResult(JSON.stringify(json), json);
      },
    },
    {
      name: "mcp__swarmfleet__post_image",
      label: "post_image",
      description:
        "Post a previously captured image asset into the visible conversation.",
      parameters: Type.Object({
        asset_id: Type.String({ description: "Image asset id." }),
        caption: Type.Optional(
          Type.String({
            description: "Optional caption shown under the image.",
          }),
        ),
      }),
      execute: async (_id, params) => {
        const toolArgs = params as { asset_id: string; caption?: string };
        const response = await fetch(
          `${args.backendUrl}/internal/assets/post`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({
              parentSessionId: args.parentSessionId,
              assetId: toolArgs.asset_id,
              caption: toolArgs.caption,
            }),
          },
        );
        const json = await response.json().catch(() => ({}));
        if (!response.ok)
          throw new Error(`post_image failed: ${JSON.stringify(json)}`);
        return makeTextResult(JSON.stringify(json), json);
      },
    },
    {
      name: "mcp__swarmfleet__list_recent_images",
      label: "list_recent_images",
      description: "List recently captured image assets in this conversation.",
      parameters: Type.Object({}),
      execute: async () => {
        const url = new URL(`${args.backendUrl}/internal/assets/list`);
        url.searchParams.set("parentSessionId", args.parentSessionId);
        const response = await fetch(url, { headers });
        const json = await response.json().catch(() => ({}));
        if (!response.ok)
          throw new Error(`list_recent_images failed: ${JSON.stringify(json)}`);
        return makeTextResult(JSON.stringify(json), json);
      },
    },
  ];
}

function buildTools(options: ExecutePiAgentOptions): AgentTool[] {
  const root = resolve(options.workingDirectory ?? process.cwd());
  const coreTools = buildCoreTools(root);
  if (options.permissionMode === "plan") {
    return coreTools.filter((tool) =>
      ["Read", "Glob", "Grep"].includes(tool.name),
    );
  }
  const tools = coreTools;
  if (options.sessionKind !== "subagent") {
    const backendUrl = process.env.SWARMFLEET_BACKEND_URL ?? "";
    const internalToken = process.env.SWARMFLEET_INTERNAL_TOKEN ?? "";
    if (backendUrl && internalToken) {
      tools.push(
        ...buildSubagentTools({
          backendUrl,
          internalToken,
          parentSessionId: options.sessionId,
        }),
      );
    }
  }
  return tools;
}

function piSystemPrompt(
  root: string,
  planMode: boolean,
  appendSystemPrompt?: string,
): string {
  const base = [
    "You are SwarmFleet's Pi coding agent.",
    `Work in this project directory: ${root}.`,
    "Use tools to inspect and modify files when needed. Keep responses concise and actionable.",
  ];
  if (appendSystemPrompt) {
    base.push("", "SwarmFleet project context:", appendSystemPrompt);
  }
  if (planMode) {
    base.push(
      "Plan mode is active. Do not modify files or implement changes.",
      "Inspect relevant project files with read-only tools before writing the plan, and validate assumptions when repo context matters.",
      "Produce only a concise planning plan with known files to edit, elements to modify, relevant architecture, validated assumptions, and general implementation or verification commands.",
    );
  }
  return base.join("\n");
}

function reasoningFromEffort(
  effort?: string,
): "minimal" | "low" | "medium" | "high" | "xhigh" {
  if (
    effort === "minimal" ||
    effort === "low" ||
    effort === "medium" ||
    effort === "high" ||
    effort === "xhigh"
  ) {
    return effort;
  }
  if (effort === "max") return "xhigh";
  return "low";
}

function assistantTextResponse(
  sessionId: string,
  text: string,
  flags?: Record<string, unknown>,
): StreamResponse {
  return {
    type: "claude_json",
    data: {
      type: "assistant",
      session_id: sessionId,
      message: {
        role: "assistant",
        content: [{ type: "text", text }],
      },
      ...flags,
    },
  };
}

function assistantToolResponse(
  sessionId: string,
  calls: ToolCall[],
): StreamResponse {
  return {
    type: "claude_json",
    data: {
      type: "assistant",
      session_id: sessionId,
      message: {
        role: "assistant",
        content: calls.map((call) => ({
          type: "tool_use",
          id: call.id,
          name: call.name,
          input: call.arguments,
        })),
      },
    },
  };
}

function toolResultResponse(
  sessionId: string,
  event: Extract<AgentEvent, { type: "tool_execution_end" }>,
): StreamResponse {
  const content = Array.isArray(event.result?.content)
    ? event.result.content
        .map((item: TextContent) => item.text ?? "")
        .join("\n")
    : String(event.result ?? "");
  return {
    type: "claude_json",
    data: {
      type: "user",
      session_id: sessionId,
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: event.toolCallId,
            content,
            is_error: event.isError,
          },
        ],
      },
      toolUseResult: event.result?.details,
    },
  };
}

function resultResponse(sessionId: string, startedAt: number): StreamResponse {
  return {
    type: "claude_json",
    data: {
      type: "result",
      session_id: sessionId,
      duration_ms: Date.now() - startedAt,
      total_cost_usd: 0,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
      },
    },
  };
}

function noFinalMessageNoticeResponse(sessionId: string): StreamResponse {
  return {
    type: "claude_json",
    data: {
      type: "system",
      subtype: "model_no_final_message",
      session_id: sessionId,
      message: "model didn't provide final message",
    },
  };
}

export async function* executePiAgentCommand(
  options: ExecutePiAgentOptions,
): AsyncGenerator<StreamResponse> {
  const parsed = options.model ? parsePiModelId(options.model) : null;
  if (!parsed) {
    yield {
      type: "error",
      error: `Invalid Pi model id: ${options.model ?? ""}`,
    };
    return;
  }

  const profile = await providerProfileStore.getPiProfile(parsed.profileId);
  if (!profile) {
    yield { type: "error", error: "Pi provider profile not found" };
    return;
  }

  const root = resolve(options.workingDirectory ?? process.cwd());
  const providerSessionId =
    options.providerSessionId || `pi-${options.sessionId}`;
  const startedAt = Date.now();
  const model = resolvePiModel(profile, parsed.rawModelId);
  const planMode = options.permissionMode === "plan";
  const queue = createAsyncQueue<QueueItem>();
  let streamedTextForCurrentMessage = false;
  let planText = "";
  let finalText = "";
  let hasFinalAssistantText = false;
  let sawToolActivity = false;
  let attemptedNoFinalRecovery = false;

  const transcript = toPiMessages(options.transcript, model);
  const agent = new Agent({
    initialState: {
      systemPrompt: piSystemPrompt(
        root,
        planMode,
        options.appendSystemPrompt,
      ),
      model,
      thinkingLevel: reasoningFromEffort(options.effort),
      tools: buildTools(options),
      messages: transcript as AgentMessage[],
    },
    sessionId: providerSessionId,
    getApiKey: () => profile.apiKey,
    toolExecution: "sequential",
  });
  options.onAbort?.(() => agent.abort());

  queue.push({
    type: "claude_json",
    data: {
      type: "system",
      subtype: "init",
      session_id: providerSessionId,
      model: `pi:${profile.provider}/${parsed.rawModelId}`,
      tools: agent.state.tools.map((tool) => tool.name),
      cwd: root,
      permissionMode: options.permissionMode ?? "bypassPermissions",
    },
  });

  agent.subscribe((event) => {
    if (options.wasAborted?.()) {
      agent.abort();
      return;
    }

    if (
      event.type === "message_start" &&
      isRecord(event.message) &&
      event.message.role === "assistant"
    ) {
      streamedTextForCurrentMessage = false;
      finalText = "";
      return;
    }

    if (event.type === "message_update") {
      if (planMode) return;
      if (event.assistantMessageEvent.type === "text_delta") {
        streamedTextForCurrentMessage = true;
        finalText += event.assistantMessageEvent.delta;
        queue.push(
          assistantTextResponse(
            providerSessionId,
            event.assistantMessageEvent.delta,
            {
              swarmfleetTransient: true,
            },
          ),
        );
      }
      return;
    }

    if (
      event.type === "message_end" &&
      isRecord(event.message) &&
      event.message.role === "assistant"
    ) {
      const message = event.message as AssistantMessage;
      const toolCalls = message.content.filter(
        (item): item is ToolCall => item.type === "toolCall",
      );
      if (toolCalls.length > 0) {
        sawToolActivity = true;
        queue.push(assistantToolResponse(providerSessionId, toolCalls));
      }

      const text = textFromPiContent(message.content);
      if (planMode) {
        if (text.trim()) planText = text.trim();
        return;
      }

      if (text.trim() && toolCalls.length === 0) {
        hasFinalAssistantText = true;
        queue.push(
          assistantTextResponse(providerSessionId, text, {
            swarmfleetHistoryOnly: streamedTextForCurrentMessage,
          }),
        );
      }
      if (
        !text.trim() &&
        toolCalls.length === 0 &&
        sawToolActivity &&
        !attemptedNoFinalRecovery
      ) {
        attemptedNoFinalRecovery = true;
        agent.followUp({
          role: "user",
          content: [
            {
              type: "text",
              text: "Based on the tool results you just received, provide the final answer to the user's request now. Do not call more tools unless absolutely necessary.",
            },
          ],
          timestamp: Date.now(),
        });
      }
      return;
    }

    if (event.type === "tool_execution_end") {
      sawToolActivity = true;
      queue.push(toolResultResponse(providerSessionId, event));
      return;
    }

    if (event.type === "agent_end") {
      if (planMode) {
        queue.push({
          type: "claude_json",
          data: {
            type: "assistant",
            session_id: providerSessionId,
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: `pi-plan-${options.requestId}`,
                  name: "ExitPlanMode",
                  input: {
                    plan:
                      planText ||
                      finalText ||
                      "Pi finished without returning a plan.",
                  },
                },
              ],
            },
          },
        });
      } else {
        if (!hasFinalAssistantText) {
          queue.push(noFinalMessageNoticeResponse(providerSessionId));
        }
        queue.push(resultResponse(providerSessionId, startedAt));
      }
      queue.push({ type: "done" });
      queue.close();
    }
  });

  const runPromise = (async () => {
    try {
      const last = agent.state.messages[agent.state.messages.length - 1];
      if (last && isRecord(last) && last.role === "user") {
        await agent.continue();
      } else {
        await agent.prompt(options.message);
      }
    } catch (error) {
      queue.push({
        type: "error",
        error: error instanceof Error ? error.message : String(error),
      });
      queue.close();
    }
  })();

  while (true) {
    const next = await queue.next();
    if (!next) break;
    if (next.type === "close") break;
    yield next;
    if (
      next.type === "done" ||
      next.type === "error" ||
      next.type === "aborted"
    )
      break;
  }

  await runPromise.catch(() => {});
}
