#!/usr/bin/env node
/**
 * SwarmFleet MCP subagent server — stdio entrypoint.
 *
 * Launched by the Claude CLI via --mcp-config, one process per parent run.
 * Speaks MCP (JSON-RPC 2.0 over stdio) and exposes SwarmFleet-owned tools:
 *   - spawn_subagent  — create a child SwarmFleet session + start it
 *   - monitor_subagent — long-poll until the child reaches a terminal state
 *   - schedule_wakeup / wait_until — backend-owned session wakeups
 *   - run_detached_shell / list_shell_jobs / read_shell_job / kill_shell_job
 *     — backend-owned durable shell jobs
 *   - notify_operator — send a Telegram notification to the operator
 *
 * Both tools are thin wrappers over the backend's /internal/subagents/*
 * HTTP routes, authenticated with SWARMFLEET_INTERNAL_TOKEN. The parent session id
 * and backend URL are injected via env when the backend writes the per-run
 * mcp-config file (see chatCli.ts wireSubagentMcpConfig).
 */

import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const BACKEND_URL =
  process.env.SWARMFLEET_BACKEND_URL ?? "http://127.0.0.1:3000";
const INTERNAL_TOKEN = process.env.SWARMFLEET_INTERNAL_TOKEN ?? "";
const PARENT_SESSION_ID = process.env.SWARMFLEET_PARENT_SESSION_ID ?? "";

function send(response: JsonRpcResponse): void {
  process.stdout.write(JSON.stringify(response) + "\n");
}

function replyError(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): void {
  send({ jsonrpc: "2.0", id, error: { code, message, data } });
}

function replyOk(id: string | number | null, result: unknown): void {
  send({ jsonrpc: "2.0", id, result });
}

const TOOL_DEFINITIONS = [
  {
    name: "spawn_subagent",
    description:
      "Spawn a child SwarmFleet agent session in the same project. Returns immediately with a subagent_id; call monitor_subagent to wait for completion. The child runs with the default tool set but cannot spawn further subagents.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description:
            "Initial prompt sent to the child agent. Be specific — the child starts with no context from this conversation other than this prompt.",
        },
        title: {
          type: "string",
          description:
            "Optional short title shown in the subagent tab. Defaults to the first 60 chars of prompt.",
        },
        model: {
          type: "string",
          description:
            "Optional model override. Omit unless the user explicitly asks for a model. Defaults: Codex and Pi inherit the parent model; Claude uses the configured default subagent model, or the global Codex default.",
        },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
  },
  {
    name: "monitor_subagent",
    description:
      "Block until a previously spawned subagent reaches a terminal state (idle, error, or interrupted). Returns the subagent's final assistant message as `result`, or an `error` string on failure.",
    inputSchema: {
      type: "object",
      properties: {
        subagent_id: {
          type: "string",
          description: "The id returned by spawn_subagent.",
        },
        timeout_ms: {
          type: "number",
          description:
            "Max milliseconds to wait. Defaults to 10 minutes; capped at 30 minutes by the server.",
        },
      },
      required: ["subagent_id"],
      additionalProperties: false,
    },
  },
  {
    name: "schedule_wakeup",
    description:
      "Schedule this SwarmFleet session to be resumed after a relative delay. Use this instead of Claude Code's native ScheduleWakeup. The backend owns the timer and will still fire it up to 15 minutes late after a server restart, unless the user continues the session first.",
    inputSchema: {
      type: "object",
      properties: {
        delay: {
          type: "string",
          description:
            "Relative delay such as '30s', '5m', or '1h'. Absolute times are not accepted.",
        },
        reason: {
          type: "string",
          description:
            "Short reason shown in logs/UI for why the session is waking.",
        },
        prompt: {
          type: "string",
          description:
            "Prompt to send back into this same session when the wakeup fires.",
        },
      },
      required: ["delay", "prompt"],
      additionalProperties: false,
    },
  },
  {
    name: "wait_until",
    description:
      "Resume this SwarmFleet session when structured wait conditions are met, or when a mandatory timeout fires. Timeout is capped at 15 minutes. Use mode='all' to wait for every condition, or mode='any' to wake when the first condition completes.",
    inputSchema: {
      type: "object",
      properties: {
        conditions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              type: {
                type: "string",
                enum: ["subagent_completed", "background_task_completed"],
              },
              subagent_id: {
                type: "string",
                description: "Required when type is subagent_completed.",
              },
              task_id: {
                type: "string",
                description: "Required when type is background_task_completed.",
              },
            },
            required: ["type"],
            additionalProperties: false,
          },
        },
        mode: {
          type: "string",
          enum: ["all", "any"],
          description: "Defaults to all.",
        },
        timeout: {
          type: "string",
          description:
            "Relative timeout such as '30s' or '5m'. Required and capped at 15m.",
        },
        reason: {
          type: "string",
          description:
            "Short reason shown in logs/UI for why the session is waiting.",
        },
        prompt: {
          type: "string",
          description:
            "Prompt to send back into this same session when conditions resolve or the timeout fires.",
        },
      },
      required: ["conditions", "timeout", "prompt"],
      additionalProperties: false,
    },
  },
  {
    name: "list_providers_and_models",
    description:
      "List provider groups, model ids, and the configured default subagent model. Use this before passing a model override to spawn_subagent.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "run_detached_shell",
    description:
      "Start a backend-owned detached shell command in this session's project. Returns a job_id, pid, and log paths. Use list_shell_jobs/read_shell_job/kill_shell_job to manage it after this turn or after a backend restart.",
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "Shell command to run via bash -lc.",
        },
        cwd: {
          type: "string",
          description:
            "Optional working directory. Relative paths resolve inside the session project; paths outside the project are rejected.",
        },
        label: {
          type: "string",
          description: "Optional short label shown in job metadata.",
        },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
  {
    name: "list_shell_jobs",
    description:
      "List backend-owned detached shell jobs for this session, refreshing whether their recorded pids are still alive.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "read_shell_job",
    description:
      "Read metadata and recent stdout/stderr for a backend-owned detached shell job.",
    inputSchema: {
      type: "object",
      properties: {
        job_id: {
          type: "string",
          description: "Job id returned by run_detached_shell.",
        },
      },
      required: ["job_id"],
      additionalProperties: false,
    },
  },
  {
    name: "kill_shell_job",
    description:
      "Stop a backend-owned detached shell job and any still-running tagged descendants.",
    inputSchema: {
      type: "object",
      properties: {
        job_id: {
          type: "string",
          description: "Job id returned by run_detached_shell.",
        },
      },
      required: ["job_id"],
      additionalProperties: false,
    },
  },
  {
    name: "notify_operator",
    description:
      "Send a Telegram notification to the human operator when they have configured and enabled Telegram operator notifications in SwarmFleet global settings. Use this for important agent updates that need human attention.",
    inputSchema: {
      type: "object",
      properties: {
        message: {
          type: "string",
          description:
            "Notification text to send to the operator. Keep it concise and actionable.",
        },
      },
      required: ["message"],
      additionalProperties: false,
    },
  },
  {
    name: "post_latest_screenshot",
    description:
      "Post the latest screenshot captured by browser/devtools tools into the visible conversation as an image. Use this only when the screenshot is useful for the user to see.",
    inputSchema: {
      type: "object",
      properties: {
        caption: {
          type: "string",
          description: "Optional caption shown under the image.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "post_image",
    description:
      "Post a previously captured image asset into the visible conversation. Use list_recent_images to discover asset ids.",
    inputSchema: {
      type: "object",
      properties: {
        asset_id: {
          type: "string",
          description: "Image asset id returned by list_recent_images.",
        },
        caption: {
          type: "string",
          description: "Optional caption shown under the image.",
        },
      },
      required: ["asset_id"],
      additionalProperties: false,
    },
  },
  {
    name: "list_recent_images",
    description:
      "List recently captured image assets in this conversation so one can be posted with post_image.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
];

type InternalJsonResult = {
  ok: boolean;
  status: number;
  json: Record<string, unknown>;
};

type RetryOptions = {
  attempts?: number;
  baseDelayMs?: number;
};

type InternalJsonOptions = {
  method?: string;
  body?: unknown;
  backendUrl?: string;
  internalToken?: string;
  retry?: RetryOptions;
};

const DEFAULT_BACKEND_RETRY_ATTEMPTS = 3;
const DEFAULT_BACKEND_RETRY_BASE_DELAY_MS = 250;

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeBackendUrl(backendUrl: string): string {
  return backendUrl.replace(/\/+$/, "");
}

function resolveInternalUrl(
  pathOrUrl: string | URL,
  backendUrl: string,
): string {
  if (pathOrUrl instanceof URL) return pathOrUrl.toString();
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  const normalizedBase = normalizeBackendUrl(backendUrl);
  const normalizedPath = pathOrUrl.startsWith("/")
    ? pathOrUrl
    : `/${pathOrUrl}`;
  return `${normalizedBase}${normalizedPath}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function shouldRetryStatus(status: number): boolean {
  return (
    status === 408 ||
    status === 429 ||
    status === 502 ||
    status === 503 ||
    status === 504
  );
}

export async function callInternalJson(
  path: string | URL,
  options: InternalJsonOptions = {},
): Promise<InternalJsonResult> {
  const backendUrl = options.backendUrl ?? BACKEND_URL;
  const internalToken = options.internalToken ?? INTERNAL_TOKEN;
  const url = resolveInternalUrl(path, backendUrl);
  const attempts = Math.max(
    1,
    options.retry?.attempts ?? DEFAULT_BACKEND_RETRY_ATTEMPTS,
  );
  const baseDelayMs = Math.max(
    0,
    options.retry?.baseDelayMs ?? DEFAULT_BACKEND_RETRY_BASE_DELAY_MS,
  );

  let lastFetchError: unknown = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: options.method ?? "GET",
        headers: {
          "content-type": "application/json",
          "x-swarmfleet-internal-token": internalToken,
        },
        ...(options.body === undefined
          ? {}
          : { body: JSON.stringify(options.body) }),
      });

      if (
        !response.ok &&
        shouldRetryStatus(response.status) &&
        attempt < attempts
      ) {
        await sleep(baseDelayMs * attempt);
        continue;
      }

      const json = (await response.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      return { ok: response.ok, status: response.status, json };
    } catch (error) {
      lastFetchError = error;
      if (attempt < attempts) {
        await sleep(baseDelayMs * attempt);
        continue;
      }
    }
  }

  return {
    ok: false,
    status: 0,
    json: {
      error: `SwarmFleet backend unreachable at ${url} after ${attempts} attempts: ${errorMessage(lastFetchError)}`,
    },
  };
}

export function formatInternalBackendError(
  toolName: string,
  result: Pick<InternalJsonResult, "status" | "json">,
): string {
  const error =
    typeof result.json.error === "string" ? result.json.error : "unknown";
  if (result.status === 0) return `${toolName} failed: ${error}`;
  return `${toolName} failed (${result.status}): ${error}`;
}

async function callSpawn(args: Record<string, unknown>): Promise<unknown> {
  const prompt = typeof args.prompt === "string" ? args.prompt : "";
  if (!prompt.trim()) {
    return {
      content: [
        {
          type: "text",
          text: "Error: prompt is required and must be non-empty.",
        },
      ],
      isError: true,
    };
  }
  const body = {
    parentSessionId: PARENT_SESSION_ID,
    prompt,
    title: typeof args.title === "string" ? args.title : undefined,
    model: typeof args.model === "string" ? args.model : undefined,
  };
  const result = await callInternalJson("/internal/subagents/spawn", {
    method: "POST",
    body,
  });
  if (!result.ok) {
    return {
      content: [
        {
          type: "text",
          text: formatInternalBackendError("spawn_subagent", result),
        },
      ],
      isError: true,
    };
  }
  const id =
    typeof result.json.subagent_id === "string" ? result.json.subagent_id : "";
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ subagent_id: id }),
      },
    ],
  };
}

async function callMonitor(args: Record<string, unknown>): Promise<unknown> {
  const subagentId =
    typeof args.subagent_id === "string" ? args.subagent_id : "";
  if (!subagentId) {
    return {
      content: [{ type: "text", text: "Error: subagent_id is required." }],
      isError: true,
    };
  }
  const timeoutMs =
    typeof args.timeout_ms === "number" ? args.timeout_ms : undefined;
  const url = new URL(
    `${BACKEND_URL}/internal/subagents/${encodeURIComponent(subagentId)}/wait`,
  );
  if (timeoutMs) url.searchParams.set("timeout_ms", String(timeoutMs));

  const backendResult = await callInternalJson(url);
  if (!backendResult.ok) {
    return {
      content: [
        {
          type: "text",
          text: formatInternalBackendError("monitor_subagent", backendResult),
        },
      ],
      isError: true,
    };
  }
  const json = backendResult.json;
  const error = typeof json.error === "string" ? json.error : "";
  if (error) {
    return {
      content: [{ type: "text", text: error }],
      isError: true,
    };
  }

  const result = typeof json.result === "string" ? json.result : "";
  return {
    content: [
      {
        type: "text",
        text:
          result ||
          `Subagent finished with status: ${String(json.status ?? "unknown")}`,
      },
    ],
  };
}

async function callScheduleWakeup(
  args: Record<string, unknown>,
): Promise<unknown> {
  const delay = args.delay;
  const prompt = typeof args.prompt === "string" ? args.prompt : "";
  if (!prompt.trim()) {
    return {
      content: [{ type: "text", text: "Error: prompt is required." }],
      isError: true,
    };
  }
  const { ok, status, json } = await callInternalJson(
    "/internal/wakeups/schedule",
    {
      method: "POST",
      body: {
        parentSessionId: PARENT_SESSION_ID,
        delay,
        reason: typeof args.reason === "string" ? args.reason : undefined,
        prompt,
      },
    },
  );
  if (!ok) {
    return {
      content: [
        {
          type: "text",
          text: formatInternalBackendError("schedule_wakeup", { status, json }),
        },
      ],
      isError: true,
    };
  }
  return { content: [{ type: "text", text: JSON.stringify(json) }] };
}

async function callWaitUntil(args: Record<string, unknown>): Promise<unknown> {
  const conditions = Array.isArray(args.conditions) ? args.conditions : [];
  const prompt = typeof args.prompt === "string" ? args.prompt : "";
  if (conditions.length === 0) {
    return {
      content: [{ type: "text", text: "Error: conditions is required." }],
      isError: true,
    };
  }
  if (!prompt.trim()) {
    return {
      content: [{ type: "text", text: "Error: prompt is required." }],
      isError: true,
    };
  }
  const { ok, status, json } = await callInternalJson(
    "/internal/wakeups/wait-until",
    {
      method: "POST",
      body: {
        parentSessionId: PARENT_SESSION_ID,
        conditions,
        mode: args.mode,
        timeout: args.timeout,
        reason: typeof args.reason === "string" ? args.reason : undefined,
        prompt,
      },
    },
  );
  if (!ok) {
    return {
      content: [
        {
          type: "text",
          text: formatInternalBackendError("wait_until", { status, json }),
        },
      ],
      isError: true,
    };
  }
  return { content: [{ type: "text", text: JSON.stringify(json) }] };
}

async function callListProvidersAndModels(): Promise<unknown> {
  const { ok, status, json } = await callInternalJson(
    "/internal/providers/models",
  );
  if (!ok) {
    return {
      content: [
        {
          type: "text",
          text: formatInternalBackendError("list_providers_and_models", {
            status,
            json,
          }),
        },
      ],
      isError: true,
    };
  }
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(json),
      },
    ],
  };
}

async function callNotifyOperator(
  args: Record<string, unknown>,
): Promise<unknown> {
  const message = typeof args.message === "string" ? args.message.trim() : "";
  if (!message) {
    return {
      content: [{ type: "text", text: "Error: message is required." }],
      isError: true,
    };
  }
  const { ok, status, json } = await callInternalJson(
    "/internal/operator-notifications/telegram",
    {
      method: "POST",
      body: {
        parentSessionId: PARENT_SESSION_ID,
        message,
      },
    },
  );
  if (!ok) {
    return {
      content: [
        {
          type: "text",
          text: formatInternalBackendError("notify_operator", { status, json }),
        },
      ],
      isError: true,
    };
  }
  return { content: [{ type: "text", text: "Operator notified." }] };
}

async function callRunDetachedShell(
  args: Record<string, unknown>,
): Promise<unknown> {
  const command = typeof args.command === "string" ? args.command : "";
  if (!command.trim()) {
    return {
      content: [{ type: "text", text: "Error: command is required." }],
      isError: true,
    };
  }
  const { ok, status, json } = await callInternalJson(
    "/internal/shell-jobs/run",
    {
      method: "POST",
      body: {
        parentSessionId: PARENT_SESSION_ID,
        command,
        cwd: typeof args.cwd === "string" ? args.cwd : undefined,
        label: typeof args.label === "string" ? args.label : undefined,
      },
    },
  );
  if (!ok) {
    return {
      content: [
        {
          type: "text",
          text: formatInternalBackendError("run_detached_shell", {
            status,
            json,
          }),
        },
      ],
      isError: true,
    };
  }
  return { content: [{ type: "text", text: JSON.stringify(json) }] };
}

async function callListShellJobs(): Promise<unknown> {
  const { ok, status, json } = await callInternalJson(
    `/internal/shell-jobs/list?parentSessionId=${encodeURIComponent(PARENT_SESSION_ID)}`,
  );
  if (!ok) {
    return {
      content: [
        {
          type: "text",
          text: formatInternalBackendError("list_shell_jobs", { status, json }),
        },
      ],
      isError: true,
    };
  }
  return { content: [{ type: "text", text: JSON.stringify(json) }] };
}

async function callReadShellJob(
  args: Record<string, unknown>,
): Promise<unknown> {
  const jobId = typeof args.job_id === "string" ? args.job_id : "";
  if (!jobId) {
    return {
      content: [{ type: "text", text: "Error: job_id is required." }],
      isError: true,
    };
  }
  const { ok, status, json } = await callInternalJson(
    `/internal/shell-jobs/${encodeURIComponent(jobId)}?parentSessionId=${encodeURIComponent(PARENT_SESSION_ID)}`,
  );
  if (!ok) {
    return {
      content: [
        {
          type: "text",
          text: formatInternalBackendError("read_shell_job", { status, json }),
        },
      ],
      isError: true,
    };
  }
  return { content: [{ type: "text", text: JSON.stringify(json) }] };
}

async function callKillShellJob(
  args: Record<string, unknown>,
): Promise<unknown> {
  const jobId = typeof args.job_id === "string" ? args.job_id : "";
  if (!jobId) {
    return {
      content: [{ type: "text", text: "Error: job_id is required." }],
      isError: true,
    };
  }
  const { ok, status, json } = await callInternalJson(
    `/internal/shell-jobs/${encodeURIComponent(jobId)}/kill`,
    {
      method: "POST",
      body: {
        parentSessionId: PARENT_SESSION_ID,
      },
    },
  );
  if (!ok) {
    return {
      content: [
        {
          type: "text",
          text: formatInternalBackendError("kill_shell_job", { status, json }),
        },
      ],
      isError: true,
    };
  }
  return { content: [{ type: "text", text: JSON.stringify(json) }] };
}

async function callPostLatestScreenshot(
  args: Record<string, unknown>,
): Promise<unknown> {
  const { ok, status, json } = await callInternalJson(
    "/internal/assets/post-latest",
    {
      method: "POST",
      body: {
        parentSessionId: PARENT_SESSION_ID,
        caption: typeof args.caption === "string" ? args.caption : undefined,
      },
    },
  );
  if (!ok) {
    return {
      content: [
        {
          type: "text",
          text: formatInternalBackendError("post_latest_screenshot", {
            status,
            json,
          }),
        },
      ],
      isError: true,
    };
  }
  return { content: [{ type: "text", text: JSON.stringify(json) }] };
}

async function callPostImage(args: Record<string, unknown>): Promise<unknown> {
  const assetId = typeof args.asset_id === "string" ? args.asset_id : "";
  if (!assetId) {
    return {
      content: [{ type: "text", text: "Error: asset_id is required." }],
      isError: true,
    };
  }
  const { ok, status, json } = await callInternalJson("/internal/assets/post", {
    method: "POST",
    body: {
      parentSessionId: PARENT_SESSION_ID,
      assetId,
      caption: typeof args.caption === "string" ? args.caption : undefined,
    },
  });
  if (!ok) {
    return {
      content: [
        {
          type: "text",
          text: formatInternalBackendError("post_image", { status, json }),
        },
      ],
      isError: true,
    };
  }
  return { content: [{ type: "text", text: JSON.stringify(json) }] };
}

async function callListRecentImages(): Promise<unknown> {
  const { ok, status, json } = await callInternalJson(
    `/internal/assets/list?parentSessionId=${encodeURIComponent(PARENT_SESSION_ID)}`,
  );
  if (!ok) {
    return {
      content: [
        {
          type: "text",
          text: formatInternalBackendError("list_recent_images", {
            status,
            json,
          }),
        },
      ],
      isError: true,
    };
  }
  return { content: [{ type: "text", text: JSON.stringify(json) }] };
}

async function handleToolCall(
  id: string | number | null,
  params: unknown,
): Promise<void> {
  if (!params || typeof params !== "object") {
    replyError(id, -32602, "invalid params");
    return;
  }
  const { name, arguments: args } = params as {
    name?: string;
    arguments?: Record<string, unknown>;
  };
  if (!name) {
    replyError(id, -32602, "tool name missing");
    return;
  }
  const a = args ?? {};
  try {
    if (name === "spawn_subagent") {
      replyOk(id, await callSpawn(a));
      return;
    }
    if (name === "monitor_subagent") {
      replyOk(id, await callMonitor(a));
      return;
    }
    if (name === "schedule_wakeup") {
      replyOk(id, await callScheduleWakeup(a));
      return;
    }
    if (name === "wait_until") {
      replyOk(id, await callWaitUntil(a));
      return;
    }
    if (name === "list_providers_and_models") {
      replyOk(id, await callListProvidersAndModels());
      return;
    }
    if (name === "run_detached_shell") {
      replyOk(id, await callRunDetachedShell(a));
      return;
    }
    if (name === "list_shell_jobs") {
      replyOk(id, await callListShellJobs());
      return;
    }
    if (name === "read_shell_job") {
      replyOk(id, await callReadShellJob(a));
      return;
    }
    if (name === "kill_shell_job") {
      replyOk(id, await callKillShellJob(a));
      return;
    }
    if (name === "notify_operator") {
      replyOk(id, await callNotifyOperator(a));
      return;
    }
    if (name === "post_latest_screenshot") {
      replyOk(id, await callPostLatestScreenshot(a));
      return;
    }
    if (name === "post_image") {
      replyOk(id, await callPostImage(a));
      return;
    }
    if (name === "list_recent_images") {
      replyOk(id, await callListRecentImages());
      return;
    }
    replyError(id, -32601, `unknown tool: ${name}`);
  } catch (error) {
    replyError(id, -32000, (error as Error).message);
  }
}

async function handleRequest(request: JsonRpcRequest): Promise<void> {
  const { id = null, method, params } = request;
  switch (method) {
    case "initialize":
      replyOk(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "swarmfleet-subagent", version: "0.1.0" },
      });
      return;
    case "notifications/initialized":
      // Notification — no response per JSON-RPC spec.
      return;
    case "tools/list":
      replyOk(id, { tools: TOOL_DEFINITIONS });
      return;
    case "tools/call":
      await handleToolCall(id, params);
      return;
    case "ping":
      replyOk(id, {});
      return;
    default:
      if (id !== null && id !== undefined) {
        replyError(id, -32601, `method not found: ${method}`);
      }
  }
}

function main(): void {
  // Guard against a runaway server if required env is missing.
  if (!INTERNAL_TOKEN || !PARENT_SESSION_ID) {
    // Write to stderr so it shows up in the Claude CLI process log, not
    // stdout (which is reserved for JSON-RPC frames).
    process.stderr.write(
      "[swarmfleet-mcp] missing SWARMFLEET_INTERNAL_TOKEN or SWARMFLEET_PARENT_SESSION_ID; tools will fail\n",
    );
  }

  const reader = createInterface({ input: process.stdin });
  reader.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed: JsonRpcRequest;
    try {
      parsed = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      return;
    }
    void handleRequest(parsed).catch((error) => {
      process.stderr.write(
        `[swarmfleet-mcp] handler error: ${(error as Error).message}\n`,
      );
    });
  });

  reader.on("close", () => {
    process.exit(0);
  });
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  main();
}
