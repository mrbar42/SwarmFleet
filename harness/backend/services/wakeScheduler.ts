import crypto from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SessionMetadata, SessionStatus } from "../../shared/types.ts";
import { ChatSessionStore } from "./chatSessionStore.ts";
import { sessionManager } from "./sessionManager.ts";
import { logger } from "../utils/logger.ts";

const STORE_FILE_NAME = "wakeups.json";
const STORE_VERSION = 1;
const POLL_MS = 5_000;
const MISSED_WAKE_GRACE_MS = 15 * 60 * 1000;
const MAX_WAIT_TIMEOUT_MS = 15 * 60 * 1000;

type WakeKind = "scheduled_wakeup" | "wait_until";
type WakeStatus = "pending" | "fired" | "expired" | "cancelled";
type WaitMode = "all" | "any";

export type WakeCondition =
  | { type: "subagent_completed"; subagentId: string }
  | { type: "background_task_completed"; taskId: string };

export interface StoredWake {
  id: string;
  kind: WakeKind;
  sessionId: string;
  prompt: string;
  reason: string;
  createdAt: number;
  dueAt: number;
  expireAt: number;
  status: WakeStatus;
  mode?: WaitMode;
  conditions?: WakeCondition[];
  firedAt?: number;
  terminalReason?: string;
}

interface WakeTriggerMessage {
  type: "system";
  subtype: "wakeup_trigger";
  wakeup_id: string;
  wakeup_kind: WakeKind;
  reason: string;
  terminal_reason?: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  prompt: string;
  message: string;
  timestamp: string;
  trigger_source: "hook";
  visible_to_user: true;
}

interface WakeArmedMessage {
  type: "system";
  subtype: "wakeup_armed";
  wakeup_id: string;
  wakeup_kind: WakeKind;
  reason: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  message: string;
  timestamp: string;
  trigger_source: "hook";
  visible_to_user: true;
}

interface WakeStoreFile {
  version: number;
  wakeups: StoredWake[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseDelayMs(value: unknown, fieldName: string): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.round(value * 1000);
  }
  if (typeof value !== "string") {
    throw new Error(`${fieldName} must be a relative duration string or seconds number`);
  }
  const trimmed = value.trim().toLowerCase();
  const match = trimmed.match(/^(\d+(?:\.\d+)?)\s*(ms|s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours)$/);
  if (!match) {
    throw new Error(`${fieldName} must look like "30s", "5m", or "1h"`);
  }
  const amount = Number(match[1]);
  const unit = match[2];
  const multiplier =
    unit === "ms"
      ? 1
      : unit.startsWith("s")
        ? 1000
        : unit.startsWith("m")
          ? 60_000
          : 60 * 60_000;
  return Math.round(amount * multiplier);
}

function normalizeCondition(value: unknown): WakeCondition {
  if (!isRecord(value)) {
    throw new Error("Each wait condition must be an object");
  }
  const type = typeof value.type === "string" ? value.type : "";
  if (type === "subagent_completed") {
    const subagentId =
      typeof value.subagent_id === "string"
        ? value.subagent_id
        : typeof value.subagentId === "string"
          ? value.subagentId
          : "";
    if (!subagentId) throw new Error("subagent_completed requires subagent_id");
    return { type, subagentId };
  }
  if (type === "background_task_completed") {
    const taskId =
      typeof value.task_id === "string"
        ? value.task_id
        : typeof value.taskId === "string"
          ? value.taskId
          : "";
    if (!taskId) throw new Error("background_task_completed requires task_id");
    return { type, taskId };
  }
  throw new Error(`Unsupported wait condition type: ${type || "<missing>"}`);
}

function terminalSessionStatus(status: SessionStatus): boolean {
  return status === "idle" || status === "error" || status === "interrupted";
}

async function loadJsonLines(path: string): Promise<unknown[]> {
  const text = await readFile(path, "utf-8").catch(() => "");
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as unknown;
      } catch {
        return null;
      }
    })
    .filter((value): value is unknown => value !== null);
}

function extractTimestampMs(message: unknown): number | null {
  if (!isRecord(message)) return null;
  const timestamp = message.timestamp;
  if (typeof timestamp === "number" && Number.isFinite(timestamp)) return timestamp;
  if (typeof timestamp === "string") {
    const parsed = Date.parse(timestamp);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function isExternalUserMessageAfter(message: unknown, timestamp: number): boolean {
  if (!isRecord(message) || message.type !== "user") return false;
  if (message.trigger_source && message.trigger_source !== "user") return false;
  if (message.visible_to_user === false) return false;
  const ts = extractTimestampMs(message);
  if (ts === null || ts <= timestamp) return false;
  const payload = isRecord(message.message) ? message.message : null;
  const content = payload?.content;
  if (typeof content === "string") return content.trim().length > 0;
  if (!Array.isArray(content)) return false;
  return content.some((item) => !isRecord(item) || item.type !== "tool_result");
}

function backgroundTaskCompleted(message: unknown, taskId: string): boolean {
  if (!isRecord(message) || message.type !== "system") return false;
  if (message.task_id !== taskId) return false;
  if (message.subtype === "task_notification") {
    return message.status === "completed";
  }
  if (message.subtype !== "task_updated") return false;
  const patch = isRecord(message.patch) ? message.patch : null;
  return patch?.status === "completed";
}

function shortenSymbolId(value: string): string {
  if (value.length <= 12) return value;
  return `${value.slice(0, 8)}...`;
}

function findToolNameForToolUseId(messages: unknown[], toolUseId: string): string | null {
  for (const message of messages) {
    if (!isRecord(message) || message.type !== "assistant") continue;
    const payload = isRecord(message.message) ? message.message : null;
    const content = payload?.content;
    if (!Array.isArray(content)) continue;
    for (const item of content) {
      if (!isRecord(item) || item.type !== "tool_use") continue;
      if (item.id !== toolUseId) continue;
      return typeof item.name === "string" && item.name ? item.name : null;
    }
  }
  return null;
}

function findTaskStartedMessage(messages: unknown[], taskId: string): Record<string, unknown> | null {
  for (const message of messages) {
    if (!isRecord(message)) continue;
    if (
      message.type === "system" &&
      message.subtype === "task_started" &&
      message.task_id === taskId
    ) {
      return message;
    }
  }
  return null;
}

export class WakeScheduler {
  private readonly store: ChatSessionStore;
  private readonly wakeSession: (sessionId: string, message: string) => Promise<void>;
  private timer: ReturnType<typeof setInterval> | null = null;
  private tickRunning = false;

  constructor(
    store = new ChatSessionStore(process.env.SWARMFLEET_CHAT_SESSION_ROOT),
    wakeSession = async (sessionId: string, message: string) => {
      await sessionManager.sendMessage(sessionId, {
        requestId: crypto.randomUUID(),
        message,
        triggerSource: "hook",
        skipTranscript: true,
      });
    },
  ) {
    this.store = store;
    this.wakeSession = wakeSession;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch((error) => {
        logger.chat.warn("Wake scheduler tick failed: {error}", { error });
      });
    }, POLL_MS);
    this.timer.unref?.();
    void this.reconcileArmedWakeups().catch(() => undefined);
    void this.tick().catch(() => undefined);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  async scheduleWakeup(args: {
    sessionId: string;
    delay: unknown;
    prompt: string;
    reason?: string;
  }): Promise<StoredWake> {
    const delayMs = parseDelayMs(args.delay, "delay");
    if (delayMs <= 0) throw new Error("delay must be greater than 0");
    if (!args.prompt.trim()) throw new Error("prompt is required");
    const now = Date.now();
    return await this.armWake(await this.addWake({
      id: crypto.randomUUID(),
      kind: "scheduled_wakeup",
      sessionId: args.sessionId,
      prompt: args.prompt.trim(),
      reason: args.reason?.trim() || "scheduled wakeup",
      createdAt: now,
      dueAt: now + delayMs,
      expireAt: now + delayMs + MISSED_WAKE_GRACE_MS,
      status: "pending",
    }));
  }

  async waitUntil(args: {
    sessionId: string;
    conditions: unknown[];
    mode?: unknown;
    timeout: unknown;
    prompt: string;
    reason?: string;
  }): Promise<StoredWake> {
    if (!Array.isArray(args.conditions) || args.conditions.length === 0) {
      throw new Error("wait_until requires at least one condition");
    }
    const timeoutMs = parseDelayMs(args.timeout, "timeout");
    if (timeoutMs <= 0) throw new Error("timeout must be greater than 0");
    if (timeoutMs > MAX_WAIT_TIMEOUT_MS) {
      throw new Error("timeout cannot be more than 15m");
    }
    if (!args.prompt.trim()) throw new Error("prompt is required");
    const mode = args.mode === "any" ? "any" : "all";
    const conditions = args.conditions.map(normalizeCondition);
    const now = Date.now();
    return await this.armWake(await this.addWake({
      id: crypto.randomUUID(),
      kind: "wait_until",
      sessionId: args.sessionId,
      prompt: args.prompt.trim(),
      reason: args.reason?.trim() || "wait_until",
      createdAt: now,
      dueAt: now + timeoutMs,
      expireAt: now + timeoutMs + MISSED_WAKE_GRACE_MS,
      status: "pending",
      mode,
      conditions,
    }));
  }

  private storePath(): string {
    return join(this.store.storageRoot, STORE_FILE_NAME);
  }

  private sessionMessagesPath(sessionId: string): string {
    return join(this.store.storageRoot, "sessions", sessionId, "messages.jsonl");
  }

  private async loadStore(): Promise<WakeStoreFile> {
    await this.store.ensureInitialized();
    const text = await readFile(this.storePath(), "utf-8").catch(() => "");
    if (!text.trim()) return { version: STORE_VERSION, wakeups: [] };
    const parsed = JSON.parse(text) as WakeStoreFile;
    return {
      version: STORE_VERSION,
      wakeups: Array.isArray(parsed.wakeups) ? parsed.wakeups : [],
    };
  }

  private async saveStore(file: WakeStoreFile): Promise<void> {
    await mkdir(this.store.storageRoot, { recursive: true });
    await writeFile(
      this.storePath(),
      JSON.stringify({ version: STORE_VERSION, wakeups: file.wakeups }, null, 2),
      "utf-8",
    );
  }

  private async addWake(wake: StoredWake): Promise<StoredWake> {
    const file = await this.loadStore();
    file.wakeups.push(wake);
    await this.saveStore(file);
    return wake;
  }

  private async armWake(wake: StoredWake): Promise<StoredWake> {
    const session = await this.store.setArmedWakeup(
      wake.sessionId,
      this.armedWakeupFromStoredWake(wake),
    );
    if (session) {
      await this.appendWakeArmed(wake);
    }
    return wake;
  }

  private armedWakeupFromStoredWake(
    wake: StoredWake,
  ): NonNullable<SessionMetadata["armedWakeup"]> {
    return {
      id: wake.id,
      kind: wake.kind,
      reason: wake.reason,
      dueAt: wake.dueAt,
      createdAt: wake.createdAt,
      mode: wake.mode,
    };
  }

  private async syncArmedWakeupFromWakes(
    wakes: StoredWake[],
    sessionId: string,
  ): Promise<void> {
    const pending = wakes
      .filter((wake) => wake.sessionId === sessionId && wake.status === "pending")
      .sort((a, b) => b.createdAt - a.createdAt);
    const active = pending[0];
    if (active) {
      await this.store.setArmedWakeup(
        sessionId,
        this.armedWakeupFromStoredWake(active),
      );
      return;
    }
    await this.store.clearArmedWakeup(sessionId);
  }

  private async reconcileArmedWakeups(): Promise<void> {
    const file = await this.loadStore();
    const sessionIds = new Set(file.wakeups.map((wake) => wake.sessionId));
    await Promise.all(
      Array.from(sessionIds).map((sessionId) =>
        this.syncArmedWakeupFromWakes(file.wakeups, sessionId),
      ),
    );
  }

  async runPendingWakeupsForTests(): Promise<void> {
    await this.tick();
  }

  private async tick(): Promise<void> {
    if (this.tickRunning) return;
    this.tickRunning = true;
    try {
      const file = await this.loadStore();
      let changed = false;
      for (const wake of file.wakeups) {
        if (wake.status !== "pending") continue;
        const result = await this.evaluateWake(wake);
        if (result) {
          await this.syncArmedWakeupFromWakes(file.wakeups, wake.sessionId);
          changed = true;
        }
      }
      if (changed) await this.saveStore(file);
    } finally {
      this.tickRunning = false;
    }
  }

  private async evaluateWake(wake: StoredWake): Promise<boolean> {
    const now = Date.now();
    const session = await this.store.getSession(wake.sessionId);
    if (!session || session.archivedAt) {
      wake.status = "cancelled";
      wake.terminalReason = "session_not_found";
      return true;
    }

    if (await this.sessionReceivedExternalUserMessage(wake)) {
      wake.status = "cancelled";
      wake.terminalReason = "session_continued";
      return true;
    }

    const ready = wake.kind === "scheduled_wakeup"
      ? now >= wake.dueAt
      : await this.waitConditionReady(wake, session, now);

    if (!ready) return false;

    if (now > wake.expireAt) {
      wake.status = "expired";
      wake.terminalReason = "missed_grace_window";
      return true;
    }

    if (session.status === "running" || session.status === "backend_wakeup") {
      return false;
    }

    await this.wakeSession(wake.sessionId, wake.prompt);
    await this.appendWakeTrigger(wake);
    wake.status = "fired";
    wake.firedAt = now;
    return true;
  }

  private async waitConditionReady(
    wake: StoredWake,
    session: SessionMetadata,
    now: number,
  ): Promise<boolean> {
    const conditions = wake.conditions ?? [];
    const states = await Promise.all(
      conditions.map((condition) => this.conditionResolved(condition, session)),
    );
    const conditionMet =
      wake.mode === "any" ? states.some(Boolean) : states.every(Boolean);
    if (conditionMet) {
      wake.terminalReason = "conditions_met";
      return true;
    }
    if (now >= wake.dueAt) {
      wake.terminalReason = "timeout";
      return true;
    }
    return false;
  }

  private async conditionResolved(
    condition: WakeCondition,
    session: SessionMetadata,
  ): Promise<boolean> {
    if (condition.type === "subagent_completed") {
      const subagent = await this.store.getSession(condition.subagentId);
      return Boolean(
        subagent &&
          subagent.parentSessionId === session.sessionId &&
          terminalSessionStatus(subagent.status),
      );
    }
    const messages = await loadJsonLines(this.sessionMessagesPath(session.sessionId));
    return messages.some((message) =>
      backgroundTaskCompleted(message, condition.taskId),
    );
  }

  private async sessionReceivedExternalUserMessage(wake: StoredWake): Promise<boolean> {
    const messages = await loadJsonLines(this.sessionMessagesPath(wake.sessionId));
    return messages.some((message) =>
      isExternalUserMessageAfter(message, wake.createdAt),
    );
  }

  private async buildWakeTriggerMessage(wake: StoredWake): Promise<WakeTriggerMessage> {
    const toolName =
      wake.kind === "scheduled_wakeup"
        ? "mcp__swarmfleet__schedule_wakeup"
        : "mcp__swarmfleet__wait_until";
    const conditions =
      wake.kind === "wait_until"
        ? await this.buildDisplayConditions(wake)
        : [];
    const toolInput =
      wake.kind === "scheduled_wakeup"
        ? {
            created_at: wake.createdAt,
            delay_until: wake.dueAt,
            reason: wake.reason,
          }
        : {
            created_at: wake.createdAt,
            mode: wake.mode ?? "all",
            conditions,
            timeout_at: wake.dueAt,
            reason: wake.reason,
          };
    const terminalReason = wake.terminalReason ?? "ready";
    const message =
      wake.kind === "scheduled_wakeup"
        ? `Scheduled wakeup fired: ${wake.reason}`
        : `wait_until fired: ${wake.reason} (${terminalReason})`;

    return {
      type: "system",
      subtype: "wakeup_trigger",
      wakeup_id: wake.id,
      wakeup_kind: wake.kind,
      reason: wake.reason,
      terminal_reason: wake.kind === "wait_until" ? terminalReason : undefined,
      tool_name: toolName,
      tool_input: toolInput,
      prompt: wake.prompt,
      message,
      timestamp: new Date().toISOString(),
      trigger_source: "hook",
      visible_to_user: true,
    };
  }

  private async buildWakeArmedMessage(wake: StoredWake): Promise<WakeArmedMessage> {
    const toolName =
      wake.kind === "scheduled_wakeup"
        ? "mcp__swarmfleet__schedule_wakeup"
        : "mcp__swarmfleet__wait_until";
    const conditions =
      wake.kind === "wait_until"
        ? await this.buildDisplayConditions(wake)
        : [];
    const toolInput =
      wake.kind === "scheduled_wakeup"
        ? {
            created_at: wake.createdAt,
            delay_until: wake.dueAt,
            reason: wake.reason,
          }
        : {
            created_at: wake.createdAt,
            mode: wake.mode ?? "all",
            conditions,
            timeout_at: wake.dueAt,
            reason: wake.reason,
          };
    const message =
      wake.kind === "scheduled_wakeup"
        ? `Scheduled wakeup armed: ${wake.reason}`
        : `wait_until armed: ${wake.reason}`;

    return {
      type: "system",
      subtype: "wakeup_armed",
      wakeup_id: wake.id,
      wakeup_kind: wake.kind,
      reason: wake.reason,
      tool_name: toolName,
      tool_input: toolInput,
      message,
      timestamp: new Date().toISOString(),
      trigger_source: "hook",
      visible_to_user: true,
    };
  }

  private async appendWakeTrigger(wake: StoredWake): Promise<void> {
    const message = await this.buildWakeTriggerMessage(wake);
    await this.store.appendMessage(wake.sessionId, message);
    await this.store.appendEvent(wake.sessionId, "stream", {
      type: "claude_json",
      data: message,
    });
  }

  private async appendWakeArmed(wake: StoredWake): Promise<void> {
    const message = await this.buildWakeArmedMessage(wake);
    await this.store.appendMessage(wake.sessionId, message);
    await this.store.appendEvent(wake.sessionId, "stream", {
      type: "claude_json",
      data: message,
    });
  }

  private async buildDisplayConditions(wake: StoredWake): Promise<Array<Record<string, unknown>>> {
    const conditions = wake.conditions ?? [];
    const messages = await loadJsonLines(this.sessionMessagesPath(wake.sessionId));
    const out: Array<Record<string, unknown>> = [];
    for (const condition of conditions) {
      if (condition.type === "subagent_completed") {
        out.push({
          ...condition,
          display: `Agent(${shortenSymbolId(condition.subagentId)})`,
        });
        continue;
      }

      const taskStarted = findTaskStartedMessage(messages, condition.taskId);
      const toolUseId =
        typeof taskStarted?.tool_use_id === "string" ? taskStarted.tool_use_id : "";
      const taskType =
        typeof taskStarted?.task_type === "string" ? taskStarted.task_type : "";
      const toolName = toolUseId ? findToolNameForToolUseId(messages, toolUseId) : null;
      const displayName =
        toolName ??
        (taskType === "local_bash" ? "Bash" : taskType ? taskType : "Task");
      out.push({
        ...condition,
        display: `${displayName}(${shortenSymbolId(toolUseId || condition.taskId)})`,
      });
    }
    return out;
  }
}

export const wakeScheduler = new WakeScheduler();
