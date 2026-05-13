import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import {
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createInterface } from "node:readline";
import { dirname, join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import type {
  ImageAttachment,
  PermissionMode,
  StreamResponse,
} from "../../shared/types.ts";
import { logger } from "../utils/logger.ts";

const CHROME_DEVTOOLS_MCP_SERVER = {
  command: "npx",
  args: [
    "-y",
    "chrome-devtools-mcp@latest",
    "--isolated",
    "--headless",
    "--executablePath=/usr/bin/chromium",
    "--chromeArg=--no-sandbox",
    "--chromeArg=--disable-dev-shm-usage",
  ],
} as const;

const CLAUDE_DISABLED_NATIVE_TOOLS = [
  "Task",
  "Agent",
  "ScheduleWakeup",
] as const;

/**
 * MCP tool names exposed by the SwarmFleet subagent server. The server itself lives
 * at harness/backend/mcp/ and is mounted per-run via --mcp-config.
 */
export const SWARMFLEET_SUBAGENT_TOOLS = [
  "mcp__swarmfleet__spawn_subagent",
  "mcp__swarmfleet__monitor_subagent",
  "mcp__swarmfleet__schedule_wakeup",
  "mcp__swarmfleet__wait_until",
] as const;

export const SWARMFLEET_SHELL_JOB_TOOLS = [
  "mcp__swarmfleet__run_detached_shell",
  "mcp__swarmfleet__list_shell_jobs",
  "mcp__swarmfleet__read_shell_job",
  "mcp__swarmfleet__kill_shell_job",
] as const;

export const SWARMFLEET_IMAGE_TOOLS = [
  "mcp__swarmfleet__post_latest_screenshot",
  "mcp__swarmfleet__post_image",
  "mcp__swarmfleet__list_recent_images",
] as const;

export const SWARMFLEET_MODEL_TOOLS = [
  "mcp__swarmfleet__list_providers_and_models",
] as const;

export const SWARMFLEET_NOTIFICATION_TOOLS = [
  "mcp__swarmfleet__notify_operator",
] as const;

/**
 * Tools every regular chat session gets when the caller didn't specify its
 * own allowedTools. The native `Task` / `Agent` tool is deliberately absent:
 * we route agent spawning through our own MCP tools so subagents become real
 * SwarmFleet sessions with parent/child metadata and UI tabs. See the subagent
 * plan for details.
 */
export const DEFAULT_ALLOWED_TOOLS = [
  "Bash",
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "TodoWrite",
  "NotebookEdit",
  ...SWARMFLEET_SUBAGENT_TOOLS,
  ...SWARMFLEET_SHELL_JOB_TOOLS,
  ...SWARMFLEET_IMAGE_TOOLS,
  ...SWARMFLEET_MODEL_TOOLS,
  ...SWARMFLEET_NOTIFICATION_TOOLS,
] as const;

/**
 * Default tools for a spawned subagent. Recursion is disabled in v1 by
 * stripping `spawn_subagent` from the child's allowlist (monitor is harmless
 * but also useless without spawn). Change here if we ever revisit recursion.
 */
export const DEFAULT_SUBAGENT_ALLOWED_TOOLS = DEFAULT_ALLOWED_TOOLS.filter(
  (tool) =>
    !SWARMFLEET_SUBAGENT_TOOLS.includes(
      tool as (typeof SWARMFLEET_SUBAGENT_TOOLS)[number],
    ),
);

/**
 * Locate the MCP subagent server entrypoint. Bundled builds still support the
 * historical dist path, but source-based Docker/dev runs use tsx directly.
 * Mirrors resolveRunnerEntry in sessionManager.
 */
export function resolveSubagentMcpEntry(): { command: string; args: string[] } {
  const currentPath = fileURLToPath(import.meta.url);
  const currentDir = dirname(currentPath);
  const isBundled = currentPath.includes("/dist/");

  if (isBundled) {
    return {
      command: process.execPath,
      args: [resolve(currentDir, "../mcp/bin.js")],
    };
  }

  return {
    command: "tsx",
    args: [resolve(currentDir, "../mcp/bin.ts")],
  };
}

/**
 * Write a per-run Claude MCP config that mounts our subagent server as a
 * stdio child, injecting the parent session id + backend auth via env. The
 * caller MUST unlink the returned path after the Claude CLI exits; the
 * caller is the only one who knows when that is.
 */
export async function writeSubagentMcpConfig(args: {
  parentSessionId: string;
  requestId: string;
  backendUrl: string;
  internalToken: string;
}): Promise<string> {
  const root = join(tmpdir(), "swarmfleet-mcp");
  await mkdir(root, { recursive: true });
  const path = join(root, `${args.parentSessionId}-${args.requestId}.json`);
  const entry = resolveSubagentMcpEntry();
  const config = {
    mcpServers: {
      "chrome-devtools": CHROME_DEVTOOLS_MCP_SERVER,
      swarmfleet: {
        command: entry.command,
        args: entry.args,
        env: {
          SWARMFLEET_PARENT_SESSION_ID: args.parentSessionId,
          SWARMFLEET_INTERNAL_TOKEN: args.internalToken,
          SWARMFLEET_BACKEND_URL: args.backendUrl,
        },
      },
    },
  };
  await writeFile(path, JSON.stringify(config, null, 2), "utf-8");
  return path;
}

export function buildCodexSubagentMcpConfigArgs(args: {
  parentSessionId: string;
  backendUrl: string;
  internalToken: string;
}): string[] {
  const entry = resolveSubagentMcpEntry();
  // codex --config parses values as TOML, not JSON. An inline table
  // {KEY = "val", ...} is valid TOML; a JSON object {"KEY":"val"} is not.
  const envEntries = [
    `SWARMFLEET_PARENT_SESSION_ID = ${JSON.stringify(args.parentSessionId)}`,
    `SWARMFLEET_INTERNAL_TOKEN = ${JSON.stringify(args.internalToken)}`,
    `SWARMFLEET_BACKEND_URL = ${JSON.stringify(args.backendUrl)}`,
  ];
  return [
    "--config",
    `mcp_servers.swarmfleet.command=${JSON.stringify(entry.command)}`,
    "--config",
    `mcp_servers.swarmfleet.args=${JSON.stringify(entry.args)}`,
    "--config",
    `mcp_servers.swarmfleet.env={${envEntries.join(", ")}}`,
  ];
}

export async function removeSubagentMcpConfig(path: string): Promise<void> {
  try {
    await rm(path, { force: true });
  } catch {
    // Best effort — if cleanup fails the file is in tmp and self-evicts.
  }
}

export async function writeCodexInstructionsFile(
  contents: string,
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "swarmfleet-codex-instructions-"));
  const path = join(root, "model-instructions.md");
  await writeFile(path, contents, "utf-8");
  return path;
}

export async function removeCodexInstructionsFile(path: string): Promise<void> {
  try {
    await rm(dirname(path), { recursive: true, force: true });
  } catch {
    // Best effort.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

interface CodexUsageTotals {
  input_tokens: number;
  output_tokens: number;
}

function zeroCodexUsageTotals(): CodexUsageTotals {
  return {
    input_tokens: 0,
    output_tokens: 0,
  };
}

function readCodexUsageTotals(value: unknown): CodexUsageTotals | null {
  if (!isRecord(value)) return null;
  const inputTokens = value.input_tokens;
  const outputTokens = value.output_tokens;
  if (
    typeof inputTokens !== "number" ||
    !Number.isFinite(inputTokens) ||
    typeof outputTokens !== "number" ||
    !Number.isFinite(outputTokens)
  ) {
    return null;
  }
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
  };
}

export function resolveCodexTurnUsage(
  accumulatedUsage: CodexUsageTotals,
  completedUsage: unknown,
): CodexUsageTotals {
  const completed = readCodexUsageTotals(completedUsage);
  if (completed) {
    return completed;
  }
  if (accumulatedUsage.input_tokens > 0 || accumulatedUsage.output_tokens > 0) {
    return accumulatedUsage;
  }
  return zeroCodexUsageTotals();
}

export function buildImageStdinPayload(
  message: string,
  attachments: ImageAttachment[],
): string {
  const content: Array<
    | { type: "text"; text: string }
    | {
        type: "image";
        source: { type: "base64"; media_type: string; data: string };
      }
  > = [];

  for (const attachment of attachments) {
    content.push({
      type: "image",
      source: {
        type: "base64",
        media_type: attachment.media_type,
        data: attachment.base64,
      },
    });
  }

  content.push({ type: "text", text: message });

  return JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content,
    },
  });
}

export function sanitizeMessage(message: string): string {
  return message.startsWith("/") ? message.slice(1) : message;
}

export function extractProviderSessionId(
  response: StreamResponse,
): string | null {
  if (response.type !== "claude_json" || !isRecord(response.data)) {
    return null;
  }

  const sessionId = response.data.session_id;
  return typeof sessionId === "string" && sessionId ? sessionId : null;
}

export function extractClaudeStructuredError(data: unknown): string | null {
  if (!isRecord(data)) return null;

  const topLevelError =
    typeof data.error === "string" && data.error.trim()
      ? data.error.trim()
      : "";
  if (data.type === "result" && data.is_error === true) {
    const result =
      typeof data.result === "string" && data.result.trim()
        ? data.result.trim()
        : "";
    return result || topLevelError || null;
  }

  const message = isRecord(data.message) ? data.message : null;
  const content = Array.isArray(message?.content) ? message.content : [];
  const text = content
    .map((item) =>
      isRecord(item) && item.type === "text" && typeof item.text === "string"
        ? item.text
        : "",
    )
    .join("")
    .trim();
  if (topLevelError && text) return text;
  return null;
}

export function isClaudeTerminalResult(data: unknown): boolean {
  return isRecord(data) && data.type === "result";
}

export function detectAwaitingInput(
  response: StreamResponse,
): { kind: "plan" | "question"; toolName: string } | null {
  if (response.type !== "claude_json" || !isRecord(response.data)) {
    return null;
  }

  if (response.data.type !== "assistant") {
    return null;
  }

  const message = response.data.message;
  if (!isRecord(message) || !Array.isArray(message.content)) {
    return null;
  }

  for (const item of message.content) {
    if (!isRecord(item) || item.type !== "tool_use") {
      continue;
    }

    const toolName = typeof item.name === "string" ? item.name : "";
    if (toolName === "ExitPlanMode") {
      return { kind: "plan", toolName };
    }
    if (toolName === "AskUserQuestion") {
      return { kind: "question", toolName };
    }
  }

  return null;
}

export function buildClaudeArgs(args: {
  message: string;
  sessionId?: string;
  permissionMode?: PermissionMode;
  model?: string;
  effort?: string;
  appendSystemPrompt?: string;
  allowedTools?: string[];
  mcpConfigPath?: string;
  hasAttachments?: boolean;
}): string[] {
  const cliArgs: string[] = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--disallowedTools",
    CLAUDE_DISABLED_NATIVE_TOOLS.join(","),
  ];

  if (args.sessionId) cliArgs.push("--resume", args.sessionId);
  if (args.permissionMode)
    cliArgs.push("--permission-mode", args.permissionMode);
  if (args.model) cliArgs.push("--model", args.model);
  if (args.effort && args.effort !== "auto")
    cliArgs.push("--effort", args.effort);
  if (args.appendSystemPrompt) {
    cliArgs.push("--append-system-prompt", args.appendSystemPrompt);
  }
  if (args.allowedTools && args.allowedTools.length > 0) {
    cliArgs.push("--allowedTools", args.allowedTools.join(","));
  }
  if (args.mcpConfigPath) {
    cliArgs.push("--strict-mcp-config", "--mcp-config", args.mcpConfigPath);
  }

  if (args.hasAttachments) {
    cliArgs.push("--input-format", "stream-json");
  } else {
    cliArgs.push("--", args.message);
  }

  return cliArgs;
}

export async function* executeClaudeCommand(
  message: string,
  cliPath: string,
  sessionId?: string,
  allowedTools?: string[],
  workingDirectory?: string,
  permissionMode?: PermissionMode,
  attachments?: ImageAttachment[],
  model?: string,
  appendSystemPrompt?: string,
  effort?: string,
  wasAborted?: () => boolean,
  onProcess?: (process: ChildProcess) => void,
  mcpConfigPath?: string,
  extraEnv?: Record<string, string>,
): AsyncGenerator<StreamResponse> {
  const stderrChunks: string[] = [];
  let childProcess: ChildProcess | null = null;
  let aborted = false;
  let lastStructuredError: string | null = null;

  try {
    const hasAttachments = (attachments?.length ?? 0) > 0;
    const args = buildClaudeArgs({
      message,
      sessionId,
      permissionMode,
      model,
      effort,
      appendSystemPrompt,
      allowedTools,
      mcpConfigPath,
      hasAttachments,
    });

    childProcess = spawn(cliPath, args, {
      cwd: workingDirectory || undefined,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...globalThis.process.env, ...extraEnv },
    });
    onProcess?.(childProcess);

    if (hasAttachments && childProcess.stdin) {
      childProcess.stdin.write(
        buildImageStdinPayload(message, attachments ?? []) + "\n",
      );
      childProcess.stdin.end();
    } else {
      childProcess.stdin?.end();
    }

    childProcess.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (!text) return;
      stderrChunks.push(text);
      logger.chat.debug("Claude stderr: {data}", { data: text });
    });

    const lineReader = createInterface({
      input: childProcess.stdout!,
      crlfDelay: Infinity,
    });

    for await (const line of lineReader) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const parsed = JSON.parse(trimmed) as unknown;
        const structuredError = extractClaudeStructuredError(parsed);
        if (structuredError) {
          lastStructuredError = structuredError;
        }
        yield { type: "claude_json", data: parsed };
      } catch {
        logger.chat.debug("Skipping non-JSON line from CLI: {line}", {
          line: trimmed,
        });
      }
    }

    const exitCode = await new Promise<number | null>((resolveExit) => {
      if (!childProcess) {
        resolveExit(null);
        return;
      }

      if (childProcess.exitCode !== null) {
        resolveExit(childProcess.exitCode);
      } else {
        childProcess.once("exit", (code) => resolveExit(code));
      }
    });

    aborted ||= wasAborted?.() ?? false;
    if (aborted) {
      yield { type: "aborted" };
      return;
    }

    if (exitCode !== 0 && exitCode !== null) {
      if (lastStructuredError) {
        yield { type: "error", error: lastStructuredError };
        return;
      }
      const stderrText = stderrChunks.join("\n");
      const errorLineMatch = stderrText.match(/^(Error:.+)$/m);
      const detail = errorLineMatch
        ? errorLineMatch[1]
        : stderrText.slice(0, 500);
      yield {
        type: "error",
        error: `Claude CLI exited with code ${exitCode}${detail ? `\n${detail}` : ""}`,
      };
      return;
    }

    yield { type: "done" };
  } catch (error) {
    const baseMessage = error instanceof Error ? error.message : String(error);
    const stderrText = stderrChunks.join("\n");
    const errorLineMatch = stderrText.match(/^(Error:.+)$/m);
    const detail = errorLineMatch ? errorLineMatch[1] : "";
    yield {
      type: "error",
      error: detail ? `${baseMessage}\n${detail}` : baseMessage,
    };
  } finally {
    if (childProcess && childProcess.exitCode === null) {
      try {
        childProcess.kill("SIGTERM");
      } catch {
        // Best effort.
      }
    }
  }
}

export function buildCodexArgs(
  message: string,
  workingDirectory?: string,
  model?: string,
  sessionId?: string,
  instructionsFilePath?: string,
  swarmfleetMcpConfig?: {
    parentSessionId: string;
    backendUrl: string;
    internalToken: string;
  },
): string[] {
  // `codex exec` persists a session on disk by default; resuming it later with
  // `codex exec resume <id>` replays that transcript so the model has full
  // prior context. Passing `--ephemeral` disables that persistence, which is
  // why the original implementation always started a fresh conversation.
  const args: string[] = ["exec"];
  if (sessionId) {
    args.push("resume");
  }

  args.push(
    "--dangerously-bypass-approvals-and-sandbox",
    "--json",
    "--skip-git-repo-check",
    "--disable",
    "multi_agent",
  );

  if (model && model.includes(":")) {
    const codexModel = model.split(":")[1];
    if (codexModel) {
      args.push("--model", codexModel);
    }
  }
  if (instructionsFilePath) {
    args.push(
      "--config",
      `model_instructions_file=${JSON.stringify(instructionsFilePath)}`,
    );
  }
  if (swarmfleetMcpConfig) {
    args.push(...buildCodexSubagentMcpConfigArgs(swarmfleetMcpConfig));
  }

  if (sessionId) {
    // `codex exec resume` does not accept -C; working directory is honoured
    // via the spawned process's cwd instead.
    args.push(sessionId);
  } else if (workingDirectory) {
    args.push("-C", workingDirectory);
  }

  // Always separate the prompt from flags. This matters for first turns too:
  // bullet-list prompts that start with "- " are otherwise parsed as CLI args.
  args.push("--", message);

  return args;
}

export function buildCodexPlanPrompt(message: string): string {
  return [
    "You are in plan mode.",
    "Do not modify files or implement changes.",
    "Before writing the plan, inspect the relevant project files and validate assumptions when repo context matters.",
    "You may use read-only tools and non-mutating shell commands for discovery, such as pwd, ls, rg, find, git status, and reading package scripts.",
    "Do not run mutating commands, dependency installs, formatters, builds, tests, or long-running commands unless the user explicitly asked for that discovery.",
    "Produce a concise planning plan in Markdown, not a generic implementation plan.",
    "Include the known files to edit, elements to modify, relevant architecture, validated assumptions, and general commands to run during implementation or verification.",
    "Stop after the plan and wait for the user to approve or revise it.",
    "",
    "User request:",
    message,
  ].join("\n");
}

export async function* executeCodexCommand(
  message: string,
  requestId: string,
  workingDirectory?: string,
  model?: string,
  sessionId?: string,
  permissionMode?: PermissionMode,
  instructionsFilePath?: string,
  swarmfleetMcpConfig?: {
    parentSessionId: string;
    backendUrl: string;
    internalToken: string;
  },
  wasAborted?: () => boolean,
  onProcess?: (process: ChildProcess) => void,
): AsyncGenerator<StreamResponse> {
  const stderrChunks: string[] = [];
  const startTime = Date.now();
  let childProcess: ChildProcess | null = null;
  let threadId = sessionId ?? `codex-${requestId}`;
  let lastCodexError: string | null = null;

  try {
    const isPlanMode = permissionMode === "plan";
    const prompt = isPlanMode ? buildCodexPlanPrompt(message) : message;
    const args = buildCodexArgs(
      prompt,
      workingDirectory,
      model,
      sessionId,
      instructionsFilePath,
      swarmfleetMcpConfig,
    );

    childProcess = spawn("codex", args, {
      cwd: workingDirectory || undefined,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...globalThis.process.env },
    });
    onProcess?.(childProcess);
    childProcess.stdin?.end();

    childProcess.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) {
        stderrChunks.push(text);
      }
    });

    const spawnError = new Promise<Error>((resolveError) => {
      childProcess!.once("error", (error) => resolveError(error));
    });
    const earlyError = await Promise.race([
      spawnError.then((error) => error),
      new Promise<null>((resolveWait) =>
        setTimeout(() => resolveWait(null), 500),
      ),
    ]);
    if (earlyError) {
      const hint =
        (earlyError as NodeJS.ErrnoException).code === "ENOENT"
          ? "Codex CLI not found. Install with: npm install -g @openai/codex"
          : earlyError.message;
      yield { type: "error", error: hint };
      return;
    }

    const lineReader = createInterface({
      input: childProcess.stdout!,
      crlfDelay: Infinity,
    });

    let initEmitted = false;
    let lastAgentMessageText: string | null = null;
    let accumulatedTurnUsage = zeroCodexUsageTotals();
    for await (const line of lineReader) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let event: Record<string, unknown>;
      try {
        event = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        continue;
      }

      if (event.type === "thread.started") {
        if (typeof event.thread_id === "string" && event.thread_id) {
          threadId = event.thread_id;
        }
        if (!initEmitted) {
          yield {
            type: "claude_json",
            data: {
              type: "system",
              subtype: "init",
              session_id: threadId,
              model: "codex",
              tools: [],
              cwd: workingDirectory ?? globalThis.process.cwd(),
              permissionMode: permissionMode ?? "bypassPermissions",
            },
          };
          initEmitted = true;
        }
        continue;
      }

      if (event.type === "item.started" && isRecord(event.item)) {
        if (
          event.item.type === "command_execution" &&
          typeof event.item.command === "string"
        ) {
          lastAgentMessageText = null;
          yield {
            type: "claude_json",
            data: {
              type: "assistant",
              session_id: threadId,
              message: {
                role: "assistant",
                content: [
                  {
                    type: "tool_use",
                    id: event.item.id,
                    name: "Bash",
                    input: { command: event.item.command },
                  },
                ],
              },
            },
          };
        }
        if (
          event.item.type === "mcp_tool_call" &&
          typeof event.item.id === "string" &&
          typeof event.item.server === "string" &&
          typeof event.item.tool === "string"
        ) {
          lastAgentMessageText = null;
          yield {
            type: "claude_json",
            data: {
              type: "assistant",
              session_id: threadId,
              message: {
                role: "assistant",
                content: [
                  {
                    type: "tool_use",
                    id: event.item.id,
                    name: `mcp__${event.item.server}__${event.item.tool}`,
                    input: isRecord(event.item.arguments)
                      ? event.item.arguments
                      : {},
                  },
                ],
              },
            },
          };
        }
        continue;
      }

      if (event.type === "token_count" && isRecord(event.info)) {
        const usage = readCodexUsageTotals(event.info.last_token_usage);
        if (usage) {
          // Codex token_count events report the latest observed usage snapshot
          // for the turn, not a delta to be summed across progress updates.
          accumulatedTurnUsage = usage;
        }
        continue;
      }

      if (event.type === "item.completed" && isRecord(event.item)) {
        if (
          event.item.type === "agent_message" &&
          typeof event.item.text === "string"
        ) {
          if (event.item.text.trim()) {
            lastAgentMessageText = event.item.text;
          }
          if (isPlanMode) {
            continue;
          }
          yield {
            type: "claude_json",
            data: {
              type: "assistant",
              session_id: threadId,
              message: {
                role: "assistant",
                content: [{ type: "text", text: event.item.text }],
              },
            },
          };
          continue;
        }

        if (event.item.type === "command_execution") {
          lastAgentMessageText = null;
          const output =
            typeof event.item.aggregated_output === "string" &&
            event.item.aggregated_output
              ? event.item.aggregated_output
              : `(exit code: ${String(event.item.exit_code ?? "unknown")})`;
          yield {
            type: "claude_json",
            data: {
              type: "user",
              message: {
                role: "user",
                content: [
                  {
                    type: "tool_result",
                    tool_use_id: event.item.id,
                    content: output,
                    is_error: event.item.exit_code !== 0,
                  },
                ],
              },
            },
          };
          continue;
        }

        if (
          event.item.type === "mcp_tool_call" &&
          typeof event.item.id === "string"
        ) {
          lastAgentMessageText = null;
          const errorMessage =
            isRecord(event.item.error) &&
            typeof event.item.error.message === "string"
              ? event.item.error.message
              : "";
          const resultContent =
            isRecord(event.item.result) &&
            Array.isArray(event.item.result.content)
              ? event.item.result.content
              : JSON.stringify(event.item.result ?? {});
          const content = errorMessage ? errorMessage : resultContent;
          yield {
            type: "claude_json",
            data: {
              type: "user",
              message: {
                role: "user",
                content: [
                  {
                    type: "tool_result",
                    tool_use_id: event.item.id,
                    content,
                    is_error:
                      event.item.status === "failed" || Boolean(errorMessage),
                  },
                ],
              },
            },
          };
          continue;
        }
      }

      if (event.type === "error" || event.type === "turn.failed") {
        const msg =
          (isRecord(event.error) &&
            typeof event.error.message === "string" &&
            event.error.message) ||
          (typeof event.message === "string" && event.message) ||
          "Codex reported an error";
        if (event.type === "error") {
          lastCodexError = msg;
          continue;
        }
        yield { type: "error", error: msg };
        return;
      }

      if (event.type === "turn.completed") {
        if (isPlanMode) {
          yield {
            type: "claude_json",
            data: {
              type: "assistant",
              session_id: threadId,
              message: {
                role: "assistant",
                content: [
                  {
                    type: "tool_use",
                    id: `codex-plan-${requestId}`,
                    name: "ExitPlanMode",
                    input: {
                      plan:
                        lastAgentMessageText?.trim() ||
                        "Codex finished without returning a plan.",
                    },
                  },
                ],
              },
            },
          };
          yield { type: "done" };
          return;
        }

        const usage = resolveCodexTurnUsage(accumulatedTurnUsage, event.usage);
        yield {
          type: "claude_json",
          data: {
            type: "result",
            session_id: threadId,
            ...(lastAgentMessageText ? { result: lastAgentMessageText } : {}),
            duration_ms: Date.now() - startTime,
            total_cost_usd: 0,
            usage,
          },
        };
        yield { type: "done" };
        return;
      }
    }

    const exitCode = await new Promise<number | null>((resolveExit) => {
      if (!childProcess) {
        resolveExit(null);
        return;
      }

      if (childProcess.exitCode !== null) {
        resolveExit(childProcess.exitCode);
      } else {
        childProcess.once("exit", (code) => resolveExit(code));
      }
    });

    if (wasAborted?.()) {
      yield { type: "aborted" };
      return;
    }

    if (exitCode !== 0 && exitCode !== null) {
      const errorDetail =
        lastCodexError ??
        (stderrChunks.length > 0 ? stderrChunks.join("\n").slice(0, 500) : "");
      yield {
        type: "error",
        error: `Codex CLI exited with code ${exitCode}${errorDetail ? `\n${errorDetail}` : ""}`,
      };
      return;
    }

    // Codex exited 0 but recorded an error event and never emitted turn.completed
    // (e.g. auth failure that exits cleanly). Surface it instead of silently
    // finishing with an empty session.
    if (lastCodexError) {
      yield { type: "error", error: lastCodexError };
      return;
    }

    yield { type: "done" };
  } catch (error) {
    yield {
      type: "error",
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (childProcess && childProcess.exitCode === null) {
      try {
        childProcess.kill("SIGTERM");
      } catch {
        // Best effort.
      }
    }
  }
}

interface HermesSessionLog {
  session_id?: unknown;
  model?: unknown;
  messages?: unknown;
}

interface HermesToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function parseHermesModelId(model?: string): {
  provider: string;
  rawModelId: string;
} {
  const match = (model ?? "").match(/^hermes:([^:]+):(.+)$/);
  if (!match) {
    return { provider: "", rawModelId: "" };
  }
  const provider = match[1] === "codex" ? "openai-codex" : match[1];
  return {
    provider,
    rawModelId: match[2],
  };
}

function hermesHomePath(): string {
  const configured = process.env.HERMES_HOME?.trim();
  if (configured) return configured;
  const home = process.env.HOME?.trim() || homedir();
  if (home === "/root" && existsSync("/home/user")) {
    return "/home/user/.hermes";
  }
  return join(home, ".hermes");
}

function hermesSessionLogPath(sessionId: string): string {
  return join(hermesHomePath(), "sessions", `session_${sessionId}.json`);
}

async function listHermesSessionFiles(): Promise<Map<string, number>> {
  const sessionsDir = join(hermesHomePath(), "sessions");
  const files = new Map<string, number>();
  let entries;
  try {
    entries = await readdir(sessionsDir, { withFileTypes: true });
  } catch {
    return files;
  }
  await Promise.all(
    entries.map(async (entry) => {
      if (!entry.isFile() || !/^session_.+\.json$/.test(entry.name)) return;
      const path = join(sessionsDir, entry.name);
      try {
        files.set(path, (await stat(path)).mtimeMs);
      } catch {
        // Best effort; the file may rotate while Hermes is writing it.
      }
    }),
  );
  return files;
}

function sessionIdFromHermesLogFile(path: string): string | null {
  const match = path.match(/(?:^|\/)session_(.+)\.json$/);
  return match?.[1] ?? null;
}

async function findNewHermesSessionId(
  startTime: number,
  beforeFiles: Map<string, number>,
): Promise<string | null> {
  const files = await listHermesSessionFiles();
  let bestPath: string | null = null;
  let bestMtime = 0;
  for (const [path, mtime] of files) {
    const previousMtime = beforeFiles.get(path);
    const isNewFile = previousMtime === undefined;
    const wasUpdated = previousMtime !== undefined && mtime > previousMtime;
    if (!isNewFile && !wasUpdated) continue;
    if (mtime < startTime - 1000) continue;
    if (mtime > bestMtime) {
      bestPath = path;
      bestMtime = mtime;
    }
  }
  return bestPath ? sessionIdFromHermesLogFile(bestPath) : null;
}

async function readHermesSessionLog(
  sessionId: string,
): Promise<HermesSessionLog | null> {
  try {
    return JSON.parse(
      await readFile(hermesSessionLogPath(sessionId), "utf-8"),
    ) as HermesSessionLog;
  } catch {
    return null;
  }
}

function textFromHermesContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (content == null) return "";
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") return item;
        if (isRecord(item) && typeof item.text === "string") return item.text;
        if (isRecord(item) && typeof item.content === "string")
          return item.content;
        return "";
      })
      .join("");
  }
  if (isRecord(content) && typeof content.text === "string")
    return content.text;
  return JSON.stringify(content);
}

function parseHermesToolArguments(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value;
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeHermesToolName(name: string): string {
  if (name === "terminal") return "Bash";
  if (name.toLowerCase() === "todo") return "TodoWrite";
  const swarmfleetPrefix = "mcp_swarmfleet_";
  if (name.startsWith(swarmfleetPrefix)) {
    return `mcp__swarmfleet__${name.slice(swarmfleetPrefix.length)}`;
  }
  const mcpMatch = name.match(/^mcp_([A-Za-z0-9_]+)_(.+)$/);
  if (mcpMatch) {
    return `mcp__${mcpMatch[1]}__${mcpMatch[2]}`;
  }
  return name;
}

function normalizeHermesToolInput(
  name: string,
  input: Record<string, unknown>,
): Record<string, unknown> {
  if (name !== "terminal") return input;
  const command =
    typeof input.command === "string"
      ? input.command
      : typeof input.cmd === "string"
        ? input.cmd
        : JSON.stringify(input);
  return { command };
}

function parseHermesToolCalls(value: unknown): HermesToolCall[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item, index) => {
    if (!isRecord(item)) return [];
    const fn = isRecord(item.function) ? item.function : null;
    const rawName =
      (fn && typeof fn.name === "string" ? fn.name : "") ||
      (typeof item.name === "string" ? item.name : "");
    if (!rawName) return [];
    const input = parseHermesToolArguments(
      fn && Object.prototype.hasOwnProperty.call(fn, "arguments")
        ? fn.arguments
        : item.arguments,
    );
    return [
      {
        id:
          typeof item.id === "string" && item.id
            ? item.id
            : `hermes-tool-${index}`,
        name: normalizeHermesToolName(rawName),
        input: normalizeHermesToolInput(rawName, input),
      },
    ];
  });
}

function formatHermesToolResult(content: unknown): string {
  if (typeof content === "string") return content;
  if (content == null) return "";
  try {
    return JSON.stringify(content, null, 2);
  } catch {
    return String(content);
  }
}

function hermesToolResultIsError(content: unknown): boolean {
  const value =
    typeof content === "string"
      ? (() => {
          try {
            return JSON.parse(content) as unknown;
          } catch {
            return content;
          }
        })()
      : content;
  if (!isRecord(value)) return false;
  if (typeof value.error === "string" && value.error.trim()) return true;
  if (value.is_error === true) return true;
  if (typeof value.exit_code === "number" && value.exit_code !== 0) return true;
  if (typeof value.exitCode === "number" && value.exitCode !== 0) return true;
  return false;
}

function convertHermesMessageToEvents(args: {
  message: unknown;
  sessionId: string;
  isPlanMode: boolean;
}): { events: StreamResponse[]; assistantText: string | null } {
  const { message, sessionId, isPlanMode } = args;
  if (!isRecord(message)) {
    return { events: [], assistantText: null };
  }

  if (message.role === "assistant") {
    const text = textFromHermesContent(message.content);
    const toolCalls = parseHermesToolCalls(message.tool_calls);
    const content: unknown[] = [];
    if (text.trim() && !isPlanMode) {
      content.push({ type: "text", text });
    }
    for (const toolCall of toolCalls) {
      content.push({
        type: "tool_use",
        id: toolCall.id,
        name: toolCall.name,
        input: toolCall.input,
      });
    }
    return {
      events:
        content.length > 0
          ? [
              {
                type: "claude_json",
                data: {
                  type: "assistant",
                  session_id: sessionId,
                  message: {
                    role: "assistant",
                    content,
                  },
                },
              },
            ]
          : [],
      assistantText: text.trim() ? text : null,
    };
  }

  if (message.role === "tool") {
    const toolUseId =
      typeof message.tool_call_id === "string" && message.tool_call_id
        ? message.tool_call_id
        : `hermes-tool-result-${Date.now()}`;
    return {
      events: [
        {
          type: "claude_json",
          data: {
            type: "user",
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: toolUseId,
                  content: formatHermesToolResult(message.content),
                  is_error: hermesToolResultIsError(message.content),
                },
              ],
            },
          },
        },
      ],
      assistantText: null,
    };
  }

  return { events: [], assistantText: null };
}

export async function* executeHermesCommand(
  message: string,
  requestId: string,
  workingDirectory?: string,
  model?: string,
  sessionId?: string,
  permissionMode?: PermissionMode,
  swarmfleetMcpConfig?: {
    parentSessionId: string;
    backendUrl: string;
    internalToken: string;
  },
  appendSystemPrompt?: string,
  wasAborted?: () => boolean,
  onProcess?: (process: ChildProcess) => void,
): AsyncGenerator<StreamResponse> {
  const stderrChunks: string[] = [];
  const stdoutChunks: string[] = [];
  const startTime = Date.now();
  const beforeSessionFiles = await listHermesSessionFiles();
  const parsedModel = parseHermesModelId(model);
  const promptBase = appendSystemPrompt
    ? [
        "SwarmFleet project context:",
        appendSystemPrompt,
        "",
        "User request:",
        message,
      ].join("\n")
    : message;
  const prompt =
    permissionMode === "plan" ? buildCodexPlanPrompt(promptBase) : promptBase;
  const args = [
    "chat",
    "--quiet",
  ];
  if (parsedModel.provider) {
    args.push("--provider", parsedModel.provider);
  }
  if (parsedModel.rawModelId) {
    args.push("--model", parsedModel.rawModelId);
  }
  args.push("--query", prompt);
  if (permissionMode === "bypassPermissions") args.push("--yolo");
  if (sessionId) args.push("--resume", sessionId);

  let childProcess: ChildProcess | null = null;
  let threadId = sessionId ?? `hermes-${requestId}`;
  let realSessionIdKnown = Boolean(sessionId);
  let lastEmittedMessageIndex = 0;
  let lastReadHermesSessionId: string | null = sessionId ?? null;
  let lastAgentMessageText: string | null = null;
  let emittedVisibleHermesEvent = false;
  let initEmitted = false;

  if (sessionId) {
    const existingLog = await readHermesSessionLog(sessionId);
    lastEmittedMessageIndex = Array.isArray(existingLog?.messages)
      ? existingLog.messages.length
      : 0;
  }

  try {
    childProcess = spawn("hermes", args, {
      cwd: workingDirectory || undefined,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...globalThis.process.env,
        HERMES_HOME: hermesHomePath(),
        HERMES_SESSION_SOURCE: "swarmfleet",
        SWARMFLEET_PARENT_SESSION_ID:
          swarmfleetMcpConfig?.parentSessionId ?? "",
        SWARMFLEET_INTERNAL_TOKEN: swarmfleetMcpConfig?.internalToken ?? "",
        SWARMFLEET_BACKEND_URL: swarmfleetMcpConfig?.backendUrl ?? "",
      },
    });
    onProcess?.(childProcess);
    childProcess.stdin?.end();

    childProcess.stdout?.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk.toString());
    });
    childProcess.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderrChunks.push(text.trim());
      const match = text.match(/session_id:\s*(\S+)/);
      if (match?.[1]) {
        threadId = match[1];
        realSessionIdKnown = true;
      }
    });

    const spawnError = new Promise<Error>((resolveError) => {
      childProcess!.once("error", (error) => resolveError(error));
    });
    const earlyError = await Promise.race([
      spawnError.then((error) => error),
      new Promise<null>((resolveWait) =>
        setTimeout(() => resolveWait(null), 500),
      ),
    ]);
    if (earlyError) {
      const hint =
        (earlyError as NodeJS.ErrnoException).code === "ENOENT"
          ? "Hermes CLI not found. Install hermes-agent in the container image."
          : earlyError.message;
      yield { type: "error", error: hint };
      return;
    }

    const emitInit = (): StreamResponse => ({
      type: "claude_json",
      data: {
        type: "system",
        subtype: "init",
        session_id: threadId,
        model: "hermes",
        tools: [],
        cwd: workingDirectory ?? globalThis.process.cwd(),
        permissionMode: permissionMode ?? "bypassPermissions",
      },
    });

    yield emitInit();
    initEmitted = true;

    let exited = false;
    let exitCode: number | null = null;
    const exitPromise = new Promise<void>((resolveExit) => {
      childProcess!.once("exit", (code) => {
        exited = true;
        exitCode = code;
        resolveExit();
      });
    });
    if (childProcess.exitCode !== null) {
      exited = true;
      exitCode = childProcess.exitCode;
    }

    const flushHermesLog = async (): Promise<StreamResponse[]> => {
      if (!realSessionIdKnown) {
        const discovered = await findNewHermesSessionId(
          startTime,
          beforeSessionFiles,
        );
        if (discovered) {
          threadId = discovered;
          realSessionIdKnown = true;
        }
      }
      const log = realSessionIdKnown
        ? await readHermesSessionLog(threadId)
        : null;
      if (!log || !Array.isArray(log.messages)) return [];
      const logSessionId =
        typeof log.session_id === "string" && log.session_id
          ? log.session_id
          : threadId;
      if (logSessionId !== threadId) {
        threadId = logSessionId;
        realSessionIdKnown = true;
      }
      if (logSessionId !== lastReadHermesSessionId) {
        lastReadHermesSessionId = logSessionId;
        lastEmittedMessageIndex = 0;
      }
      const messages = log.messages.slice(lastEmittedMessageIndex);
      lastEmittedMessageIndex = log.messages.length;
      const events: StreamResponse[] = [];
      for (const hermesMessage of messages) {
        const converted = convertHermesMessageToEvents({
          message: hermesMessage,
          sessionId: threadId,
          isPlanMode: permissionMode === "plan",
        });
        if (converted.assistantText) {
          lastAgentMessageText = converted.assistantText;
        }
        if (converted.events.length > 0) {
          emittedVisibleHermesEvent = true;
        }
        events.push(...converted.events);
      }
      return events;
    };

    while (!exited) {
      for (const event of await flushHermesLog()) {
        yield event;
      }
      await Promise.race([sleep(1000), exitPromise]);
      if (wasAborted?.()) {
        yield { type: "aborted" };
        return;
      }
    }

    for (const event of await flushHermesLog()) {
      yield event;
    }

    if (wasAborted?.()) {
      yield { type: "aborted" };
      return;
    }

    if (exitCode !== 0 && exitCode !== null) {
      const detail = stderrChunks.join("\n").trim().slice(0, 1000);
      yield {
        type: "error",
        error: `Hermes CLI exited with code ${exitCode}${detail ? `\n${detail}` : ""}`,
      };
      return;
    }

    const stdoutText = stdoutChunks.join("").trim();
    if (stdoutText && !lastAgentMessageText && !emittedVisibleHermesEvent) {
      lastAgentMessageText = stdoutText;
      if (permissionMode !== "plan") {
        yield {
          type: "claude_json",
          data: {
            type: "assistant",
            session_id: threadId,
            message: {
              role: "assistant",
              content: [{ type: "text", text: stdoutText }],
            },
          },
        };
        emittedVisibleHermesEvent = true;
      }
    }

    if (permissionMode === "plan") {
      yield {
        type: "claude_json",
        data: {
          type: "assistant",
          session_id: threadId,
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: `hermes-plan-${requestId}`,
                name: "ExitPlanMode",
                input: {
                  plan:
                    lastAgentMessageText?.trim() ||
                    "Hermes finished without returning a plan.",
                },
              },
            ],
          },
        },
      };
      emittedVisibleHermesEvent = true;
    } else if (!lastAgentMessageText && !emittedVisibleHermesEvent) {
      const detail = stderrChunks.join("\n").trim().slice(0, 1000);
      yield {
        type: "error",
        error: `Hermes CLI exited successfully without emitting assistant output${detail ? `\n${detail}` : ""}`,
      };
      return;
    }

    yield {
      type: "claude_json",
      data: {
        type: "result",
        session_id: threadId,
        ...(lastAgentMessageText ? { result: lastAgentMessageText } : {}),
        duration_ms: Date.now() - startTime,
        total_cost_usd: 0,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
        },
      },
    };
    yield { type: "done" };
  } catch (error) {
    const baseMessage = error instanceof Error ? error.message : String(error);
    const detail = stderrChunks.join("\n").trim().slice(0, 1000);
    yield {
      type: "error",
      error: detail ? `${baseMessage}\n${detail}` : baseMessage,
    };
  } finally {
    if (childProcess && childProcess.exitCode === null) {
      try {
        childProcess.kill("SIGTERM");
      } catch {
        // Best effort.
      }
    }
    if (!initEmitted) {
      logger.chat.debug("Hermes command exited before init event");
    }
  }
}
