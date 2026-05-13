import type { Hono } from "hono";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { ConfigContext } from "../../middleware/config.ts";
import { sessionManager } from "../../services/sessionManager.ts";
import { sessionIndexBus } from "../../services/sessionIndexBus.ts";
import { wakeScheduler } from "../../services/wakeScheduler.ts";
import {
  buildProviderCatalog,
  providerProfileStore,
} from "../../services/providerProfiles.ts";
import { sendTelegramOperatorNotification } from "../../services/telegramNotifications.ts";
import { detachedShellJobs } from "../../services/detachedShellJobs.ts";
import { logger } from "../../utils/logger.ts";
import modelsConfig from "../../../shared/models.json" with { type: "json" };
import type { SessionMetadata, SessionStatus } from "../../../shared/types.ts";

/**
 * Internal HTTP endpoints backing the SwarmFleet MCP subagent server. The MCP
 * server runs as a stdio child process of the Claude CLI (one per parent run)
 * and calls back into the backend over localhost to:
 *
 *   POST /internal/subagents/spawn     — create + start a child session
 *   GET  /internal/subagents/:id/wait  — long-poll until terminal state
 *
 * Auth: a shared token read from SWARMFLEET_INTERNAL_TOKEN, or from a durable token
 * file under the chat-session storage root. The backend exports it to MCP
 * servers via env when it writes the per-run --mcp-config file, so no token
 * ever crosses a network.
 *
 * These routes must never be exposed to browsers. The main frontend uses
 * /api/* and must not hit /internal/*; a naive reverse-proxy could leak them,
 * hence the token check.
 */

const MAX_ACTIVE_CHILDREN_PER_PARENT = 20;
const WAIT_TIMEOUT_MS_DEFAULT = 10 * 60 * 1000; // 10 min — caller passes its own
const INTERNAL_TOKEN_FILENAME = ".internal-subagent-token";
const PARENT_LOOKUP_RETRY_DELAYS_MS = [50, 150, 350];
const BACKEND_STARTED_AT = new Date().toISOString();

function defaultCodexSubagentModel(): string {
  const openai = modelsConfig.providers.find(
    (provider) => provider.id === "openai",
  );
  const codexModel = openai?.models.find((model) =>
    model.id.startsWith("codex:"),
  )?.id;
  return codexModel || "codex:gpt-5.5";
}

function resolveDefaultSubagentModel(parent: {
  provider: string;
  model: string;
}): string {
  if (parent.provider === "claude") return defaultCodexSubagentModel();
  return parent.model;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

let cachedToken: string | null = null;

function getDefaultChatSessionRoot(): string | null {
  const fromEnv = process.env.SWARMFLEET_CHAT_SESSION_ROOT?.trim();
  if (fromEnv) return fromEnv;
  const home = process.env.HOME?.trim();
  if (!home) return null;
  return join(home, ".swarmfleet", "chat-sessions");
}

function readDurableToken(): string | null {
  const root = getDefaultChatSessionRoot();
  if (!root) return null;
  const tokenPath = join(root, INTERNAL_TOKEN_FILENAME);
  if (!existsSync(tokenPath)) return null;
  try {
    const token = readFileSync(tokenPath, "utf-8").trim();
    return token || null;
  } catch (error) {
    logger.chat.warn("Failed to read internal subagent token: {error}", {
      error,
    });
    return null;
  }
}

function writeDurableToken(token: string): void {
  const root = getDefaultChatSessionRoot();
  if (!root) return;
  const tokenPath = join(root, INTERNAL_TOKEN_FILENAME);
  try {
    mkdirSync(root, { recursive: true });
    writeFileSync(tokenPath, `${token}\n`, { encoding: "utf-8", mode: 0o600 });
    chmodSync(tokenPath, 0o600);
  } catch (error) {
    logger.chat.warn("Failed to persist internal subagent token: {error}", {
      error,
    });
  }
}

export function getInternalSubagentToken(): string {
  if (cachedToken) return cachedToken;
  const fromEnv = process.env.SWARMFLEET_INTERNAL_TOKEN;
  if (fromEnv && fromEnv.trim()) {
    cachedToken = fromEnv.trim();
    return cachedToken;
  }
  const persisted = readDurableToken();
  if (persisted) {
    process.env.SWARMFLEET_INTERNAL_TOKEN = persisted;
    cachedToken = persisted;
    return persisted;
  }
  const generated = randomUUID() + randomUUID();
  writeDurableToken(generated);
  process.env.SWARMFLEET_INTERNAL_TOKEN = generated;
  cachedToken = generated;
  return generated;
}

export function checkInternalToken(headerValue: string | null): boolean {
  if (!headerValue) return false;
  const expected = getInternalSubagentToken();
  // Constant-time-ish compare; inputs are small and already server-local.
  if (headerValue.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < headerValue.length; i += 1) {
    diff |= headerValue.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parentMetadataDiagnostics(parentSessionId: string) {
  const chatSessionRoot = getDefaultChatSessionRoot();
  const metadataPath = chatSessionRoot
    ? join(chatSessionRoot, "sessions", parentSessionId, "metadata.json")
    : null;
  return {
    error: "parent_not_found",
    parentSessionId,
    chatSessionRoot,
    metadataPath,
    metadataExists: metadataPath ? existsSync(metadataPath) : false,
    backendPid: process.pid,
    backendStartedAt: BACKEND_STARTED_AT,
    hint:
      "The MCP tool reached this backend, but this backend could not load the parent session metadata. Likely causes: stale/orphan MCP process, backend/store mismatch, deleted metadata, or a transient metadata/index read during backend/session churn.",
  };
}

async function getParentSessionWithRetry(
  parentSessionId: string,
): Promise<SessionMetadata | null> {
  let parent = await sessionManager.get(parentSessionId);
  if (parent) return parent;

  for (const delay of PARENT_LOOKUP_RETRY_DELAYS_MS) {
    await sleep(delay);
    parent = await sessionManager.get(parentSessionId);
    if (parent) {
      logger.app.warn(
        "Recovered parent session lookup after retry for {parentSessionId}",
        { parentSessionId },
      );
      return parent;
    }
  }

  const diagnostics = parentMetadataDiagnostics(parentSessionId);
  logger.app.error("Parent session lookup failed: {diagnostics}", {
    diagnostics,
  });
  return null;
}

function extractFinalAssistantText(messages: unknown[]): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const candidate = messages[i];
    if (!candidate || typeof candidate !== "object") continue;
    const record = candidate as Record<string, unknown>;
    if (record.type !== "assistant" && record.role !== "assistant") continue;
    const payload =
      (record.message as Record<string, unknown> | undefined) ?? record;
    const content = payload.content;
    if (typeof content === "string") {
      const trimmed = content.trim();
      if (trimmed) return trimmed;
      continue;
    }
    if (!Array.isArray(content)) continue;
    const textPieces: string[] = [];
    for (const item of content) {
      if (!item || typeof item !== "object") continue;
      const block = item as Record<string, unknown>;
      if (block.type === "text" && typeof block.text === "string") {
        textPieces.push(block.text);
      }
    }
    const joined = textPieces.join("\n").trim();
    if (joined) return joined;
  }
  return null;
}

function isTerminalStatus(status: string): boolean {
  return status === "idle" || status === "error" || status === "interrupted";
}

function isSessionStatus(status: unknown): status is SessionStatus {
  return (
    status === "idle" ||
    status === "running" ||
    status === "awaiting_input" ||
    status === "error" ||
    status === "interrupted"
  );
}

export function registerInternalSubagentRoutes(app: Hono<ConfigContext>): void {
  app.post("/internal/sessions/:id/status-published", async (c) => {
    if (
      !checkInternalToken(c.req.header("x-swarmfleet-internal-token") ?? null)
    ) {
      return c.json({ error: "unauthorized" }, 401);
    }

    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }

    const expectedStatus = body.status;
    if (!isSessionStatus(expectedStatus)) {
      return c.json({ error: "status_required" }, 400);
    }

    try {
      const published = await sessionManager.publishStoredStatus(
        c.req.param("id"),
        expectedStatus,
      );
      if (!published) return c.json({ error: "not_found" }, 404);
      return c.json({ ok: true, status: published.status });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ error: message }, 409);
    }
  });

  app.post("/internal/subagents/spawn", async (c) => {
    if (
      !checkInternalToken(c.req.header("x-swarmfleet-internal-token") ?? null)
    ) {
      return c.json({ error: "unauthorized" }, 401);
    }

    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }

    const parentSessionId =
      typeof body.parentSessionId === "string" ? body.parentSessionId : "";
    const parentToolUseId =
      typeof body.parentToolUseId === "string" ? body.parentToolUseId : null;
    const prompt = typeof body.prompt === "string" ? body.prompt : "";
    const title = typeof body.title === "string" ? body.title : null;
    const model = typeof body.model === "string" ? body.model : undefined;

    if (!parentSessionId)
      return c.json({ error: "parentSessionId_required" }, 400);
    if (!prompt.trim()) return c.json({ error: "prompt_required" }, 400);

    const parent = await getParentSessionWithRetry(parentSessionId);
    if (!parent) return c.json(parentMetadataDiagnostics(parentSessionId), 404);

    if (parent.kind === "subagent") {
      // v1 disallows recursion. Also enforced by the child's allowlist
      // omitting spawn_subagent, but checking here gives a clean error if a
      // future change ever reintroduces the tool.
      return c.json({ error: "recursion_disabled" }, 400);
    }

    // Concurrency cap — count active children of this parent.
    try {
      const siblings = await sessionManager.listByProject(parent.projectPath);
      const active = siblings.filter(
        (s) =>
          s.parentSessionId === parentSessionId &&
          (s.status === "running" ||
            s.status === "awaiting_input" ||
            s.status === "backend_wakeup"),
      );
      if (active.length >= MAX_ACTIVE_CHILDREN_PER_PARENT) {
        return c.json(
          {
            error: "too_many_active_children",
            max: MAX_ACTIVE_CHILDREN_PER_PARENT,
          },
          429,
        );
      }
    } catch (error) {
      logger.app.warn(
        "Failed to enumerate siblings when capping spawn: {error}",
        { error },
      );
    }

    const resolvedTitle = title?.trim() || prompt.trim().slice(0, 60);
    const requestId = randomUUID();
    const providerSettings = await providerProfileStore.getSettings();
    const childModel =
      model ??
      (providerSettings.defaultSubagentModel ||
        resolveDefaultSubagentModel(parent));

    let child;
    try {
      child = await sessionManager.create({
        projectPath: parent.projectPath,
        encodedProjectName: parent.encodedProjectName,
        model: childModel,
        permissionMode: parent.permissionMode,
        effort: parent.effort,
        title: resolvedTitle,
        kind: "subagent",
        parentSessionId,
        parentToolUseId,
      });
    } catch (error) {
      logger.app.error("Subagent create failed: {error}", { error });
      return c.json({ error: "create_failed" }, 500);
    }

    try {
      await sessionManager.sendMessage(child.sessionId, {
        message: prompt,
        requestId,
        triggerSource: "user",
      });
    } catch (error) {
      logger.app.error("Subagent initial run failed: {error}", { error });
      return c.json({ error: "run_failed" }, 500);
    }

    return c.json({ subagent_id: child.sessionId });
  });

  app.get("/internal/subagents/:id/wait", async (c) => {
    if (
      !checkInternalToken(c.req.header("x-swarmfleet-internal-token") ?? null)
    ) {
      return c.json({ error: "unauthorized" }, 401);
    }

    const sessionId = c.req.param("id");
    const timeoutParam = Number.parseInt(c.req.query("timeout_ms") ?? "", 10);
    const timeoutMs =
      Number.isFinite(timeoutParam) && timeoutParam > 0
        ? Math.min(timeoutParam, 30 * 60 * 1000)
        : WAIT_TIMEOUT_MS_DEFAULT;

    const current = await sessionManager.get(sessionId);
    if (!current) return c.json({ error: "not_found" }, 404);
    if (current.kind !== "subagent") {
      return c.json({ error: "not_a_subagent" }, 400);
    }

    if (isTerminalStatus(current.status) && current.runnerPid == null) {
      return c.json(await buildWaitResponse(sessionId, current.status));
    }

    const result = await new Promise<{ status: string } | { timeout: true }>(
      (resolve) => {
        const timer = setTimeout(() => {
          unsubscribe();
          resolve({ timeout: true });
        }, timeoutMs);

        const unsubscribe = sessionIndexBus.subscribe((event) => {
          if (event.type !== "session-status") return;
          if (event.sessionId !== sessionId) return;
          if (!isTerminalStatus(event.status)) return;
          clearTimeout(timer);
          unsubscribe();
          resolve({ status: event.status });
        });

        // Safety net: re-check disk once in case the transition already fired
        // between our first read and the subscribe. Watcher republishes on
        // every tick for tracked sessions, so at worst this costs one extra
        // metadata read.
        void sessionManager.get(sessionId).then((meta) => {
          if (meta && isTerminalStatus(meta.status) && meta.runnerPid == null) {
            clearTimeout(timer);
            unsubscribe();
            resolve({ status: meta.status });
          }
        });
      },
    );

    if ("timeout" in result) {
      const latest = await sessionManager.get(sessionId);
      return c.json({
        status: latest?.status ?? "unknown",
        timed_out: true,
      });
    }

    return c.json(await buildWaitResponse(sessionId, result.status));
  });

  app.post("/internal/assets/post-latest", async (c) => {
    if (
      !checkInternalToken(c.req.header("x-swarmfleet-internal-token") ?? null)
    ) {
      return c.json({ error: "unauthorized" }, 401);
    }
    const body = (await c.req.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const parentSessionId =
      typeof body.parentSessionId === "string" ? body.parentSessionId : "";
    if (!parentSessionId)
      return c.json({ error: "parentSessionId_required" }, 400);
    const caption = typeof body.caption === "string" ? body.caption : undefined;
    const images =
      await sessionManager.listImageAssetsIncludingSubagents(parentSessionId);
    const asset = images.at(-1) ?? null;
    if (!asset) return c.json({ error: "no_images_available" }, 404);
    return c.json({ posted: true, asset, caption });
  });

  app.post("/internal/assets/post", async (c) => {
    if (
      !checkInternalToken(c.req.header("x-swarmfleet-internal-token") ?? null)
    ) {
      return c.json({ error: "unauthorized" }, 401);
    }
    const body = (await c.req.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const parentSessionId =
      typeof body.parentSessionId === "string" ? body.parentSessionId : "";
    const assetId = typeof body.assetId === "string" ? body.assetId : "";
    if (!parentSessionId)
      return c.json({ error: "parentSessionId_required" }, 400);
    if (!assetId) return c.json({ error: "assetId_required" }, 400);
    const caption = typeof body.caption === "string" ? body.caption : undefined;
    const images =
      await sessionManager.listImageAssetsIncludingSubagents(parentSessionId);
    const asset =
      images.find((candidate) => candidate.assetId === assetId) ?? null;
    if (!asset) return c.json({ error: "asset_not_found" }, 404);
    return c.json({ posted: true, asset, caption });
  });

  app.get("/internal/assets/list", async (c) => {
    if (
      !checkInternalToken(c.req.header("x-swarmfleet-internal-token") ?? null)
    ) {
      return c.json({ error: "unauthorized" }, 401);
    }
    const parentSessionId = c.req.query("parentSessionId") ?? "";
    if (!parentSessionId)
      return c.json({ error: "parentSessionId_required" }, 400);
    const images =
      await sessionManager.listImageAssetsIncludingSubagents(parentSessionId);
    return c.json({ images: images.slice(-20).reverse() });
  });

  app.get("/internal/providers/models", async (c) => {
    if (
      !checkInternalToken(c.req.header("x-swarmfleet-internal-token") ?? null)
    ) {
      return c.json({ error: "unauthorized" }, 401);
    }
    const [settings, catalog] = await Promise.all([
      providerProfileStore.getSettings(),
      buildProviderCatalog({
        claudeAuthenticated: true,
        codexAuthenticated: true,
        hermesAuthenticated: true,
      }),
    ]);
    return c.json({
      defaultSubagentModel: settings.defaultSubagentModel,
      groups: catalog.groups.map((group) => ({
        id: group.id,
        label: group.label,
        provider: group.provider,
        sourceProvider: group.sourceProvider,
        profileId: group.profileId,
        models: group.models.map((model) => ({
          id: model.id,
          rawId: model.rawId,
          label: model.label,
          provider: model.provider,
          contextWindow: model.contextWindow,
          reasoning: model.reasoning,
          input: model.input,
        })),
      })),
    });
  });

  app.post("/internal/shell-jobs/run", async (c) => {
    if (
      !checkInternalToken(c.req.header("x-swarmfleet-internal-token") ?? null)
    ) {
      return c.json({ error: "unauthorized" }, 401);
    }
    const body = await c.req.json().catch(() => ({}));
    if (!isRecord(body)) {
      return c.json({ error: "invalid_body" }, 400);
    }
    const parentSessionId =
      typeof body.parentSessionId === "string" ? body.parentSessionId : "";
    if (!parentSessionId) {
      return c.json({ error: "parentSessionId_required" }, 400);
    }
    const parent = await getParentSessionWithRetry(parentSessionId);
    if (!parent) return c.json(parentMetadataDiagnostics(parentSessionId), 404);

    try {
      const job = await detachedShellJobs.run({
        sessionId: parentSessionId,
        projectPath: parent.projectPath,
        command: body.command,
        cwd: body.cwd,
        label: body.label,
      });
      return c.json(job);
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }
  });

  app.get("/internal/shell-jobs/list", async (c) => {
    if (
      !checkInternalToken(c.req.header("x-swarmfleet-internal-token") ?? null)
    ) {
      return c.json({ error: "unauthorized" }, 401);
    }
    const parentSessionId = c.req.query("parentSessionId") ?? "";
    if (!parentSessionId) {
      return c.json({ error: "parentSessionId_required" }, 400);
    }
    const parent = await getParentSessionWithRetry(parentSessionId);
    if (!parent) return c.json(parentMetadataDiagnostics(parentSessionId), 404);
    return c.json({ jobs: await detachedShellJobs.list(parentSessionId) });
  });

  app.get("/internal/shell-jobs/:jobId", async (c) => {
    if (
      !checkInternalToken(c.req.header("x-swarmfleet-internal-token") ?? null)
    ) {
      return c.json({ error: "unauthorized" }, 401);
    }
    const parentSessionId = c.req.query("parentSessionId") ?? "";
    if (!parentSessionId) {
      return c.json({ error: "parentSessionId_required" }, 400);
    }
    const parent = await getParentSessionWithRetry(parentSessionId);
    if (!parent) return c.json(parentMetadataDiagnostics(parentSessionId), 404);
    const job = await detachedShellJobs.get(
      parentSessionId,
      c.req.param("jobId"),
    );
    if (!job) return c.json({ error: "job_not_found" }, 404);
    return c.json(job);
  });

  app.post("/internal/shell-jobs/:jobId/kill", async (c) => {
    if (
      !checkInternalToken(c.req.header("x-swarmfleet-internal-token") ?? null)
    ) {
      return c.json({ error: "unauthorized" }, 401);
    }
    const body = await c.req.json().catch(() => ({}));
    if (!isRecord(body)) {
      return c.json({ error: "invalid_body" }, 400);
    }
    const parentSessionId =
      typeof body.parentSessionId === "string" ? body.parentSessionId : "";
    if (!parentSessionId) {
      return c.json({ error: "parentSessionId_required" }, 400);
    }
    const parent = await getParentSessionWithRetry(parentSessionId);
    if (!parent) return c.json(parentMetadataDiagnostics(parentSessionId), 404);
    const job = await detachedShellJobs.kill(
      parentSessionId,
      c.req.param("jobId"),
    );
    if (!job) return c.json({ error: "job_not_found" }, 404);
    return c.json(job);
  });

  app.post("/internal/operator-notifications/telegram", async (c) => {
    if (
      !checkInternalToken(c.req.header("x-swarmfleet-internal-token") ?? null)
    ) {
      return c.json({ error: "unauthorized" }, 401);
    }
    const body = await c.req.json().catch(() => ({}));
    if (!isRecord(body)) {
      return c.json({ error: "invalid_body" }, 400);
    }
    const parentSessionId =
      typeof body.parentSessionId === "string" ? body.parentSessionId : "";
    if (!parentSessionId) {
      return c.json({ error: "parentSessionId_required" }, 400);
    }
    const message = typeof body.message === "string" ? body.message.trim() : "";
    if (!message) return c.json({ error: "message_required" }, 400);

    const result = await sendTelegramOperatorNotification(message);
    if (!result.ok) {
      return c.json({ error: result.error ?? "notification_failed" }, 400);
    }
    return c.json({ ok: true });
  });

  app.post("/internal/wakeups/schedule", async (c) => {
    if (
      !checkInternalToken(c.req.header("x-swarmfleet-internal-token") ?? null)
    ) {
      return c.json({ error: "unauthorized" }, 401);
    }
    const body = await c.req.json().catch(() => ({}));
    if (!isRecord(body)) {
      return c.json({ error: "invalid_body" }, 400);
    }
    const parentSessionId =
      typeof body.parentSessionId === "string" ? body.parentSessionId : "";
    if (!parentSessionId) {
      return c.json({ error: "parentSessionId_required" }, 400);
    }
    try {
      const wake = await wakeScheduler.scheduleWakeup({
        sessionId: parentSessionId,
        delay: body.delay ?? body.delaySeconds ?? body.delay_seconds,
        prompt: typeof body.prompt === "string" ? body.prompt : "",
        reason: typeof body.reason === "string" ? body.reason : undefined,
      });
      return c.json({
        wakeup_id: wake.id,
        scheduled_for: wake.dueAt,
        expires_at: wake.expireAt,
      });
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }
  });

  app.post("/internal/wakeups/wait-until", async (c) => {
    if (
      !checkInternalToken(c.req.header("x-swarmfleet-internal-token") ?? null)
    ) {
      return c.json({ error: "unauthorized" }, 401);
    }
    const body = await c.req.json().catch(() => ({}));
    if (!isRecord(body)) {
      return c.json({ error: "invalid_body" }, 400);
    }
    const parentSessionId =
      typeof body.parentSessionId === "string" ? body.parentSessionId : "";
    if (!parentSessionId) {
      return c.json({ error: "parentSessionId_required" }, 400);
    }
    try {
      const wake = await wakeScheduler.waitUntil({
        sessionId: parentSessionId,
        conditions: Array.isArray(body.conditions) ? body.conditions : [],
        mode: body.mode,
        timeout: body.timeout ?? body.timeoutSeconds ?? body.timeout_seconds,
        prompt: typeof body.prompt === "string" ? body.prompt : "",
        reason: typeof body.reason === "string" ? body.reason : undefined,
      });
      return c.json({
        wait_id: wake.id,
        mode: wake.mode,
        timeout_at: wake.dueAt,
        expires_at: wake.expireAt,
      });
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }
  });
}

async function buildWaitResponse(
  sessionId: string,
  status: string,
): Promise<{ status: string; result?: string; error?: string }> {
  const conversation = await sessionManager.getConversation(sessionId);
  const text = conversation
    ? extractFinalAssistantText(conversation.messages)
    : null;
  if (status === "error") {
    return {
      status,
      error: text ?? "subagent failed without producing a message",
    };
  }
  return {
    status,
    result: text ?? "",
  };
}
