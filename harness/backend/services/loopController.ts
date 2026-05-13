import crypto from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  CreateLoopRequest,
  LoopConfig,
  LoopStatusInfo,
  LoopTerminationCondition,
  UpdateLoopRequest,
} from "../../shared/types.ts";
import { ChatSessionStore } from "./chatSessionStore.ts";
import { sessionManager } from "./sessionManager.ts";
import { logger } from "../utils/logger.ts";

const STORE_FILE_NAME = "loops.json";
const STORE_VERSION = 1;
const POLL_MS = 5_000;

interface LoopStoreFile {
  version: number;
  loops: LoopConfig[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export class LoopController {
  private readonly store: ChatSessionStore;
  private timer: ReturnType<typeof setInterval> | null = null;
  private tickRunning = false;

  constructor(store = new ChatSessionStore(process.env.SWARMFLEET_CHAT_SESSION_ROOT)) {
    this.store = store;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch((error) => {
        logger.chat.warn("Loop controller tick failed: {error}", { error });
      });
    }, POLL_MS);
    this.timer.unref?.();
    void this.tick().catch(() => undefined);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  async create(req: CreateLoopRequest): Promise<LoopConfig> {
    const file = await this.loadStore();
    const existing = file.loops.find(
      (l) => l.sessionId === req.sessionId && l.state !== "completed" && l.state !== "error",
    );
    if (existing) {
      throw new Error(`Session ${req.sessionId} already has an active loop`);
    }
    const now = Date.now();
    const loop: LoopConfig = {
      id: crypto.randomUUID(),
      sessionId: req.sessionId,
      name: req.name,
      prompt: req.prompt,
      strategy: req.strategy,
      terminationConditions: req.terminationConditions ?? [],
      state: "paused",
      iterationCount: 0,
      consecutiveErrorCount: 0,
      createdAt: now,
      permissionMode: req.permissionMode,
      model: req.model,
      effort: req.effort,
    };
    file.loops.push(loop);
    await this.saveStore(file);
    await this.syncLoopToSession(loop);
    return loop;
  }

  async get(loopId: string): Promise<LoopConfig | null> {
    const file = await this.loadStore();
    return file.loops.find((l) => l.id === loopId) ?? null;
  }

  async getBySession(sessionId: string): Promise<LoopConfig | null> {
    const file = await this.loadStore();
    return (
      file.loops.find(
        (l) => l.sessionId === sessionId && l.state !== "completed" && l.state !== "error",
      ) ?? null
    );
  }

  async list(sessionId?: string): Promise<LoopConfig[]> {
    const file = await this.loadStore();
    if (sessionId !== undefined) {
      return file.loops.filter((l) => l.sessionId === sessionId);
    }
    return [...file.loops];
  }

  async update(loopId: string, req: UpdateLoopRequest): Promise<LoopConfig> {
    const file = await this.loadStore();
    const loop = file.loops.find((l) => l.id === loopId);
    if (!loop) throw new Error(`Loop ${loopId} not found`);
    if (req.name !== undefined) loop.name = req.name;
    if (req.prompt !== undefined) loop.prompt = req.prompt;
    if (req.strategy !== undefined) loop.strategy = req.strategy;
    if (req.terminationConditions !== undefined) loop.terminationConditions = req.terminationConditions;
    if (req.permissionMode !== undefined) loop.permissionMode = req.permissionMode;
    if (req.model !== undefined) loop.model = req.model;
    if (req.effort !== undefined) loop.effort = req.effort;
    await this.saveStore(file);
    return loop;
  }

  async remove(loopId: string): Promise<void> {
    const file = await this.loadStore();
    const loop = file.loops.find((l) => l.id === loopId);
    if (loop) {
      await this.store.clearActiveLoop(loop.sessionId);
    }
    file.loops = file.loops.filter((l) => l.id !== loopId);
    await this.saveStore(file);
  }

  async play(loopId: string): Promise<LoopConfig> {
    const file = await this.loadStore();
    const loop = file.loops.find((l) => l.id === loopId);
    if (!loop) throw new Error(`Loop ${loopId} not found`);
    const wasCompleted = loop.state === "completed";
    const now = Date.now();
    loop.state = "running";
    if (!loop.startedAt) {
      loop.startedAt = now;
    }
    delete loop.pausedAt;
    if (loop.strategy.type === "burst" && wasCompleted) {
      loop.iterationCount = 0;
    }
    await this.saveStore(file);
    await this.syncLoopToSession(loop);
    return loop;
  }

  async pause(loopId: string): Promise<LoopConfig> {
    const file = await this.loadStore();
    const loop = file.loops.find((l) => l.id === loopId);
    if (!loop) throw new Error(`Loop ${loopId} not found`);
    loop.state = "paused";
    loop.pausedAt = Date.now();
    await this.saveStore(file);
    await this.syncLoopToSession(loop);
    return loop;
  }

  private storePath(): string {
    return join(this.store.storageRoot, STORE_FILE_NAME);
  }

  private sessionMessagesPath(sessionId: string): string {
    return join(this.store.storageRoot, "sessions", sessionId, "messages.jsonl");
  }

  private async loadStore(): Promise<LoopStoreFile> {
    await this.store.ensureInitialized();
    const text = await readFile(this.storePath(), "utf-8").catch(() => "");
    if (!text.trim()) return { version: STORE_VERSION, loops: [] };
    const parsed = JSON.parse(text) as LoopStoreFile;
    return {
      version: STORE_VERSION,
      loops: Array.isArray(parsed.loops) ? parsed.loops : [],
    };
  }

  private async saveStore(file: LoopStoreFile): Promise<void> {
    await mkdir(this.store.storageRoot, { recursive: true });
    await writeFile(
      this.storePath(),
      JSON.stringify({ version: STORE_VERSION, loops: file.loops }, null, 2),
      "utf-8",
    );
  }

  private async tick(): Promise<void> {
    if (this.tickRunning) return;
    this.tickRunning = true;
    try {
      const file = await this.loadStore();
      let changed = false;
      for (const loop of file.loops) {
        if (loop.state !== "running") continue;
        try {
          const updated = await this.processLoop(loop);
          if (updated) changed = true;
        } catch (error) {
          logger.chat.warn("Loop {id} tick error: {error}", { id: loop.id, error });
        }
      }
      if (changed) await this.saveStore(file);
    } finally {
      this.tickRunning = false;
    }
  }

  private async processLoop(loop: LoopConfig): Promise<boolean> {
    const session = await sessionManager.get(loop.sessionId);
    if (!session || session.archivedAt) {
      return false;
    }

    const now = Date.now();
    let changed = false;

    // Track outcomes of loop-triggered runs for on_idle/hybrid cooldown and error counting.
    // A pending outcome exists when lastFiredAt is set and lastCompletedAt hasn't caught up.
    const pendingOutcome =
      loop.lastFiredAt !== undefined &&
      (loop.lastCompletedAt === undefined || loop.lastCompletedAt < loop.lastFiredAt);

    if (pendingOutcome) {
      if (session.status === "idle") {
        loop.lastCompletedAt = now;
        loop.consecutiveErrorCount = 0;
        changed = true;
      } else if (session.status === "error" || session.status === "interrupted") {
        loop.consecutiveErrorCount += 1;
        loop.lastCompletedAt = now;
        changed = true;
      }
    }

    if (session.status === "blocked_on_human") {
      loop.state = "paused";
      loop.pausedAt = now;
      await this.appendLoopPaused(loop, "blocked_on_human");
      await this.syncLoopToSession(loop);
      return true;
    }

    if (session.status === "running" || session.status === "backend_wakeup") {
      return changed;
    }

    if (await this.isTerminated(loop)) {
      loop.state = "completed";
      loop.completedAt = now;
      await this.syncLoopToSession(loop);
      logger.chat.info("Loop {id} ({name}) completed", { id: loop.id, name: loop.name });
      return true;
    }

    if (!this.shouldFire(loop, now)) {
      return changed;
    }

    try {
      await sessionManager.sendMessage(loop.sessionId, {
        message: loop.prompt,
        requestId: crypto.randomUUID(),
        triggerSource: "loop",
        permissionMode: loop.permissionMode,
        model: loop.model,
        effort: loop.effort,
      });
    } catch (error) {
      logger.chat.warn("Loop {id} dispatch failed: {error}", { id: loop.id, error });
      return changed;
    }

    loop.iterationCount += 1;
    loop.lastFiredAt = now;
    await this.appendLoopTrigger(loop);
    await this.syncLoopToSession(loop);
    return true;
  }

  private shouldFire(loop: LoopConfig, now: number): boolean {
    const strategy = loop.strategy;
    const startedAt = loop.startedAt ?? now;

    switch (strategy.type) {
      case "interval": {
        const lastRef = loop.lastFiredAt ?? startedAt;
        return now - lastRef >= strategy.intervalMs;
      }
      case "on_idle": {
        const lastRef = loop.lastCompletedAt ?? startedAt;
        return now - lastRef >= strategy.cooldownMs;
      }
      case "hybrid": {
        const lastCompleted = loop.lastCompletedAt ?? startedAt;
        const cooldownMet = now - lastCompleted >= strategy.cooldownMs;
        const maxIdleExceeded = now - (loop.lastFiredAt ?? startedAt) >= strategy.maxIdleMs;
        return cooldownMet || maxIdleExceeded;
      }
      case "burst": {
        return loop.iterationCount < strategy.count;
      }
    }
  }

  private async isTerminated(loop: LoopConfig): Promise<boolean> {
    // Burst completes naturally when count is reached
    if (loop.strategy.type === "burst" && loop.iterationCount >= loop.strategy.count) {
      return true;
    }
    for (const condition of loop.terminationConditions) {
      if (await this.conditionMet(loop, condition)) return true;
    }
    return false;
  }

  private async conditionMet(loop: LoopConfig, condition: LoopTerminationCondition): Promise<boolean> {
    switch (condition.type) {
      case "max_iterations":
        return loop.iterationCount >= condition.value;
      case "max_duration_ms":
        return Date.now() - (loop.startedAt ?? loop.createdAt) >= condition.value;
      case "content_match":
        return await this.lastAssistantMessageMatches(loop.sessionId, condition.pattern);
      case "consecutive_errors":
        return loop.consecutiveErrorCount >= condition.value;
    }
  }

  private async lastAssistantMessageMatches(sessionId: string, pattern: string): Promise<boolean> {
    const text = await readFile(this.sessionMessagesPath(sessionId), "utf-8").catch(() => "");
    const lines = text.split("\n").filter((line) => line.trim());
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const msg = JSON.parse(lines[i]!) as unknown;
        if (!isRecord(msg) || msg.type !== "assistant") continue;
        const inner = isRecord(msg.message) ? msg.message : null;
        if (!inner) continue;
        const content = inner.content;
        if (typeof content === "string") return content.includes(pattern);
        if (Array.isArray(content)) {
          for (const item of content) {
            if (isRecord(item) && item.type === "text" && typeof item.text === "string") {
              if (item.text.includes(pattern)) return true;
            }
          }
        }
        return false;
      } catch {
        continue;
      }
    }
    return false;
  }

  private async appendLoopTrigger(loop: LoopConfig): Promise<void> {
    const message = {
      type: "system",
      subtype: "loop_trigger",
      loop_id: loop.id,
      loop_name: loop.name,
      iteration: loop.iterationCount,
      strategy: loop.strategy.type,
      prompt: loop.prompt,
      message: `Loop "${loop.name}" — iteration ${loop.iterationCount} (${loop.strategy.type})`,
      timestamp: new Date().toISOString(),
      trigger_source: "loop",
      visible_to_user: true,
    };
    await this.store.appendMessage(loop.sessionId, message);
    await this.store.appendEvent(loop.sessionId, "stream", {
      type: "claude_json",
      data: message,
    });
  }

  private async appendLoopPaused(loop: LoopConfig, reason: string): Promise<void> {
    const message = {
      type: "system",
      subtype: "loop_paused",
      loop_id: loop.id,
      loop_name: loop.name,
      reason,
      message: `Loop "${loop.name}" auto-paused: session requires human intervention`,
      timestamp: new Date().toISOString(),
      trigger_source: "loop",
      visible_to_user: true,
    };
    await this.store.appendMessage(loop.sessionId, message);
    await this.store.appendEvent(loop.sessionId, "stream", {
      type: "claude_json",
      data: message,
    });
  }

  private toStatusInfo(loop: LoopConfig): LoopStatusInfo {
    return {
      id: loop.id,
      sessionId: loop.sessionId,
      name: loop.name,
      state: loop.state,
      iterationCount: loop.iterationCount,
      strategy: loop.strategy,
      terminationConditions: loop.terminationConditions,
      createdAt: loop.createdAt,
      startedAt: loop.startedAt,
      lastFiredAt: loop.lastFiredAt,
      completedAt: loop.completedAt,
      errorMessage: loop.errorMessage,
    };
  }

  private async syncLoopToSession(loop: LoopConfig): Promise<void> {
    const info = this.toStatusInfo(loop);
    if (loop.state === "completed" || loop.state === "error") {
      await this.store.clearActiveLoop(loop.sessionId);
    } else {
      await this.store.setActiveLoop(loop.sessionId, info);
    }
  }

}

export const loopController = new LoopController();
