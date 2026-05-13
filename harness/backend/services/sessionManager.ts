import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  BlockedOnHumanInfo,
  ConversationHistory,
  ConversationImageAsset,
  ConversationSummary,
  CreateSessionRequest,
  ImageAttachment,
  QueuedMessage,
  SessionAbortResponse,
  SessionInterruptionReason,
  SessionMessageRequest,
  SessionMetadata,
} from "../../shared/types.ts";
import { randomUUID } from "node:crypto";
import {
  ChatSessionStore,
  deriveProvider,
  type ConversationPageOptions,
  type SessionImageAssetData,
  type StoredSessionEvent,
} from "./chatSessionStore.ts";
import { sessionIndexBus, metadataToSummary } from "./sessionIndexBus.ts";
import { buildNotificationEvent } from "./sessionNotifications.ts";
import { sessionStatusWatcher } from "./sessionStatusWatcher.ts";
import { subprocessTracker } from "./subprocessTracker.ts";
import { logger } from "../utils/logger.ts";

function buildUserTranscriptMessage(
  message: string,
  assets?: ConversationImageAsset[],
  triggerSource?: string,
): Record<string, unknown> {
  return {
    type: "user",
    timestamp: new Date().toISOString(),
    message: {
      role: "user",
      content: message,
    },
    ...(assets && assets.length > 0 ? { assets } : {}),
    ...(triggerSource && triggerSource !== "user" ? { trigger_source: triggerSource } : {}),
  };
}

async function saveAttachmentAssets(
  store: ChatSessionStore,
  sessionId: string,
  attachments?: ImageAttachment[],
): Promise<ConversationImageAsset[] | undefined> {
  if (!attachments?.length) return undefined;
  const assets: ConversationImageAsset[] = [];
  for (const attachment of attachments) {
    assets.push(
      await store.saveImageAsset(sessionId, {
        bytes: Buffer.from(attachment.base64, "base64"),
        mimeType: attachment.media_type,
        sourceToolName: "attachment",
      }),
    );
  }
  return assets;
}

function hasSendableContent(params: SessionMessageRequest): boolean {
  if (typeof params.message === "string" && params.message.trim()) {
    return true;
  }
  return (params.attachments?.length ?? 0) > 0;
}

function queuedMessageToRequest(entry: QueuedMessage): SessionMessageRequest {
  return {
    message: entry.message,
    requestId: entry.requestId,
    triggerSource: entry.triggerSource,
    permissionMode: entry.permissionMode,
    model: entry.model,
    effort: entry.effort,
    allowedTools: entry.allowedTools,
    attachments: entry.attachments,
  };
}

function isAbortableStatus(status: SessionMetadata["status"]): boolean {
  return (
    status === "running" ||
    status === "awaiting_input" ||
    status === "backend_wakeup"
  );
}

function getUnreadBoundary(metadata: SessionMetadata): number | null {
  if (metadata.status === "running" || metadata.status === "backend_wakeup") {
    return null;
  }
  if (metadata.armedWakeup) {
    return null;
  }
  return metadata.updatedAt > metadata.lastReadAt ? metadata.lastReadAt : null;
}

export function canAutoDispatchQueuedMessage(metadata: SessionMetadata): boolean {
  // An armed wakeup means the backend still owns the next turn. Leave queued
  // human messages untouched until the wake either fires, expires, or is
  // cancelled and armedWakeup is cleared.
  return metadata.status === "idle" && !metadata.armedWakeup;
}

function isNoSuchProcessError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ESRCH"
  );
}

function interruptionDetail(reason: SessionInterruptionReason): string {
  switch (reason) {
    case "user_abort":
      return "Session stop requested by client";
    case "archive":
      return "Session was archived while active";
    case "cascade_abort":
      return "Parent session was stopped";
    case "process_kill":
      return "A session process was killed";
    case "runner_signal":
      return "Session runner received a process signal";
    case "runner_missing":
      return "Recorded session runner was not alive";
    case "backend_resume_failed":
      return "Backend wakeup resume failed";
    case "runner_exited":
      return "Session runner exited before completing the turn";
    case "unknown":
    default:
      return "Session was interrupted";
  }
}

function resolveRunnerEntry(): { command: string; args: string[] } {
  const currentPath = fileURLToPath(import.meta.url);
  const currentDir = dirname(currentPath);
  const isBundled = currentPath.includes("/dist/");

  if (isBundled) {
    return {
      command: process.execPath,
      args: [resolve(currentDir, "session-runner.js")],
    };
  }

  return {
    command: "tsx",
    args: [resolve(currentDir, "../cli/session-runner.ts")],
  };
}

export class SessionManager {
  private readonly store = new ChatSessionStore();

  private cliPath: string | null = null;
  private backendUrl: string | null = null;

  configure(options: { cliPath?: string; backendUrl?: string }): void {
    if (options.cliPath) {
      this.cliPath = options.cliPath;
    }
    if (options.backendUrl) {
      this.backendUrl = options.backendUrl;
    }
    void this.store.ensureInitialized().catch((error) => {
      logger.chat.warn("Failed to initialize chat session store: {error}", {
        error,
      });
    });
  }

  async ensureInitialized(): Promise<void> {
    await this.store.ensureInitialized();
  }

  /** Starts the status watcher against this manager's store. Idempotent. */
  async startStatusWatcher(): Promise<void> {
    await this.store.ensureInitialized();
    sessionStatusWatcher.setOnIdleTransition((sessionId) =>
      this.dispatchNextQueuedIfIdle(sessionId),
    );
    await sessionStatusWatcher.start(this.store);
    await this.resumeBackendWakeupSessions();
  }

  async create(config: CreateSessionRequest): Promise<SessionMetadata> {
    await this.store.ensureInitialized();
    const session = await this.store.createSession(config);
    const displaySummary = await this.metadataToDisplaySummary(session);
    if (!displaySummary) {
      return session;
    }
    sessionIndexBus.publish({
      type: "session-created",
      projectPath: session.projectPath,
      encodedProjectName: session.encodedProjectName,
      session: displaySummary,
    });
    return session;
  }

  async get(id: string): Promise<SessionMetadata | null> {
    return await this.store.getSession(id);
  }

  async getConversation(
    id: string,
    options?: ConversationPageOptions,
  ): Promise<ConversationHistory | null> {
    return await this.store.getConversation(id, options);
  }

  async saveImageAsset(
    sessionId: string,
    input: {
      bytes: Buffer;
      mimeType: ConversationImageAsset["mimeType"];
      sourceToolName?: string;
    },
  ): Promise<ConversationImageAsset> {
    return await this.store.saveImageAsset(sessionId, input);
  }

  async readImageAsset(
    sessionId: string,
    assetId: string,
  ): Promise<SessionImageAssetData | null> {
    return await this.store.readImageAsset(sessionId, assetId);
  }

  async listImageAssets(sessionId: string): Promise<ConversationImageAsset[]> {
    return await this.store.listImageAssets(sessionId);
  }

  async listImageAssetsIncludingSubagents(
    sessionId: string,
  ): Promise<ConversationImageAsset[]> {
    return await this.store.listImageAssetsIncludingDescendants(sessionId);
  }

  async listByProject(projectPath: string): Promise<ConversationSummary[]> {
    return await this.store.listSessionsByProject(projectPath);
  }

  async listByEncodedProjectName(
    encodedProjectName: string,
  ): Promise<ConversationSummary[]> {
    return await this.store.listSessionsByEncodedProjectName(
      encodedProjectName,
    );
  }

  /**
   * Returns a "session-status" snapshot for every session that is currently
   * running or awaiting_input. The index-stream SSE endpoint sends these on
   * connect so a freshly-loaded sidebar can paint spinners for in-flight
   * background sessions, not just the one the user has open.
   *
   * Without this, subscribers only learn about status via transitions —
   * anything that was already running when the tab opened stays invisible
   * until it next changes state.
   */
  async listAllActiveSessionIds(): Promise<string[]> {
    await this.store.ensureInitialized();
    const all = await this.store.listAllActiveMetadata();
    return all.map((m) => m.sessionId);
  }

  async getActiveStatusSnapshot(): Promise<
    Array<{
      projectPath: string;
      encodedProjectName: string | null;
      sessionId: string;
      status: SessionMetadata["status"];
      updatedAt: number;
    }>
  > {
    await this.store.ensureInitialized();
    const all = await this.store.listAllActiveMetadata();
    return all
      .filter(
        (meta) =>
          meta.status === "running" ||
          meta.status === "awaiting_input" ||
          meta.status === "backend_wakeup",
      )
      .map((meta) => ({
        projectPath: meta.projectPath,
        encodedProjectName: meta.encodedProjectName,
        sessionId: meta.sessionId,
        status: meta.status,
        updatedAt: meta.updatedAt,
      }));
  }

  async getStatusSnapshot(): Promise<
    Array<{
      projectPath: string;
      encodedProjectName: string | null;
      sessionId: string;
      status: SessionMetadata["status"];
      updatedAt: number;
      lastMessagePreview?: string;
      unreadBoundary?: number | null;
      armedWakeup?: SessionMetadata["armedWakeup"];
      blockedOnHuman?: BlockedOnHumanInfo;
      interruptionReason?: SessionInterruptionReason;
      interruptionDetail?: string;
    }>
  > {
    await this.store.ensureInitialized();
    const all = await this.store.listAllActiveMetadata();
    return all.map((meta) => ({
      projectPath: meta.projectPath,
      encodedProjectName: meta.encodedProjectName,
      sessionId: meta.sessionId,
      status: meta.status,
      updatedAt: meta.updatedAt,
      lastMessagePreview: meta.lastMessagePreview,
      unreadBoundary: getUnreadBoundary(meta),
      armedWakeup: meta.armedWakeup ?? null,
      blockedOnHuman: meta.blockedOnHuman,
      interruptionReason: meta.lastInterruptionReason ?? undefined,
      interruptionDetail: meta.lastInterruptionDetail ?? undefined,
    }));
  }

  async getIndexSnapshot(): Promise<
    Array<{
      projectPath: string;
      encodedProjectName: string | null;
      session: ConversationSummary;
    }>
  > {
    await this.store.ensureInitialized();
    const all = await this.store.listAllActiveMetadata();
    const summaries: Array<{
      projectPath: string;
      encodedProjectName: string | null;
      session: ConversationSummary;
    }> = [];
    for (const meta of all) {
      const displaySummary = await this.metadataToDisplaySummary(meta);
      if (!displaySummary) continue;
      summaries.push({
        projectPath: meta.projectPath,
        encodedProjectName: meta.encodedProjectName,
        session: displaySummary,
      });
    }
    return summaries.sort(
      (a, b) => Date.parse(b.session.lastTime) - Date.parse(a.session.lastTime),
    );
  }

  async markSessionRead(sessionId: string): Promise<SessionMetadata | null> {
    const session = await this.store.markSessionRead(sessionId);
    if (session) {
      this.publishStatus(session);
    }
    return session;
  }

  async getEventsSince(
    id: string,
    lastEventId: number,
  ): Promise<StoredSessionEvent[] | null> {
    return await this.store.readEventsSince(id, lastEventId);
  }

  async getByProviderSessionId(
    providerSessionId: string,
    projectPath?: string,
  ): Promise<SessionMetadata | null> {
    return await this.store.findSessionByProviderSessionId(
      providerSessionId,
      projectPath,
    );
  }

  async getByRequestId(requestId: string): Promise<SessionMetadata | null> {
    return await this.store.findSessionByRequestId(requestId);
  }

  async sendMessage(
    sessionId: string,
    params: SessionMessageRequest,
    options?: { extraEnv?: Record<string, string> },
  ): Promise<SessionMetadata> {
    await this.store.ensureInitialized();
    const session = await this.store.getSession(sessionId);
    if (!session) {
      throw new Error("Session not found");
    }

    if (!hasSendableContent(params)) {
      throw new Error("message is required");
    }

    if (session.status === "running") {
      throw new Error("Session is already running");
    }

    if (params.model) {
      const requestedProvider = deriveProvider(params.model);
      if (requestedProvider !== session.provider) {
        // Provider is locked at session creation. Reject here, before any
        // pending-request / transcript writes, so a rejected switch doesn't
        // leave an orphan user message in the conversation.
        throw new Error(
          `Cannot switch provider mid-session: session is locked to "${session.provider}", ` +
            `but model "${params.model}" requires provider "${requestedProvider}". ` +
            `Start a new session to use a different provider.`,
        );
      }
    }

    await this.store.writePendingRequest(sessionId, params.requestId, params);
    if (!params.skipTranscript) {
      const attachmentAssets = await saveAttachmentAssets(
        this.store,
        sessionId,
        params.attachments,
      );
      const userMessage = buildUserTranscriptMessage(
        params.message,
        attachmentAssets,
        params.triggerSource,
      );
      await this.store.appendMessage(sessionId, userMessage);
      // Also push onto events.jsonl as a "claude_json" stream chunk so that
      // every SSE subscriber (including other devices viewing this same
      // session) sees the user's turn appear in real time — not only the
      // assistant's response. The origin requestId lets the sending device
      // recognise and suppress its own echo so it doesn't double up on its
      // optimistic bubble.
      await this.store.appendEvent(sessionId, "stream", {
        type: "claude_json",
        data: {
          ...userMessage,
          swarmfleetOriginRequestId: params.requestId,
        },
      });
    }
    const runStarted = await this.store.markRunStarted(
      sessionId,
      params.requestId,
      {
        model: params.model,
        effort: params.effort,
        permissionMode: params.permissionMode,
        allowedTools: params.allowedTools,
      },
    );
    this.publishStatus(runStarted);

    const cliPath = this.cliPath ?? "claude";
    const child = this.spawnDetachedRunner(
      sessionId,
      params.requestId,
      cliPath,
      options?.extraEnv,
    );
    if (!child.pid) {
      const failed = await this.store.updateStatus(sessionId, "error", {
        clearActiveRequest: true,
        clearRunnerPid: true,
      });
      this.publishStatus(failed);
      throw new Error("Failed to start session runner");
    }

    await this.store.updateRunnerPid(sessionId, child.pid);
    const updated = await this.store.getSession(sessionId);
    if (!updated) {
      throw new Error("Session disappeared after runner start");
    }
    return updated;
  }

  async abort(
    id: string,
    options: {
      reason?: SessionInterruptionReason;
      detail?: string;
      auditSource?: string;
    } = {},
  ): Promise<boolean> {
    await this.store.ensureInitialized();
    const session = await this.store.getSession(id);
    if (!session) {
      return false;
    }
    const reason = options.reason ?? "user_abort";
    const detail = options.detail ?? interruptionDetail(reason);
    await this.recordInterruptionAudit(session.sessionId, {
      reason,
      detail,
      source: options.auditSource ?? "session_abort",
    });

    if (!session.runnerPid) {
      // Still cascade — a parent whose CLI is no longer running but who has
      // active subagent children (e.g. the user stopped the parent via UI
      // while monitor was pending) should drag those children down too.
      const locallyInterrupted = await this.interruptSessionLocally(
        session.sessionId,
        undefined,
        reason,
        detail,
      );
      await this.cascadeAbortChildren(session.sessionId, session.projectPath, {
        reason: "cascade_abort",
        detail,
      });
      await subprocessTracker.killSession(session.sessionId);
      return locallyInterrupted;
    }

    try {
      process.kill(session.runnerPid, "SIGTERM");
    } catch (error) {
      if (isNoSuchProcessError(error)) {
        logger.chat.debug(
          "Session runner already exited before abort {sessionId}",
          {
            sessionId: id,
          },
        );
        await this.clearMissingRunnerAfterAbort(
          session.sessionId,
          session.runnerPid,
          reason,
          detail,
        );
      } else {
        logger.chat.warn(
          "Failed to abort session runner {sessionId}: {error}",
          {
            sessionId: id,
            error,
          },
        );
      }
    }

    // Always cascade, regardless of whether the parent kill succeeded. If the
    // parent process was already gone, its children still need an explicit
    // stop — they don't inherit a signal.
    await this.cascadeAbortChildren(session.sessionId, session.projectPath, {
      reason: "cascade_abort",
      detail,
    });

    // Kill any detached subprocesses that the CLI spawned but that aren't
    // direct children of the runner (they survive a runner SIGTERM because
    // they were already reparented to PID 1).
    await subprocessTracker.killSession(id, {
      excludePids: [session.runnerPid],
    });

    return true;
  }

  private publishStatus(metadata: SessionMetadata): void {
    const previousStatus = sessionStatusWatcher.getLastPublishedStatus(
      metadata.sessionId,
    );
    const notification = buildNotificationEvent(previousStatus, metadata);
    sessionStatusWatcher.notePublished(metadata.sessionId, metadata.status);
    sessionIndexBus.publish({
      type: "session-status",
      projectPath: metadata.projectPath,
      encodedProjectName: metadata.encodedProjectName,
      sessionId: metadata.sessionId,
      status: metadata.status,
      updatedAt: metadata.updatedAt,
      lastMessagePreview: metadata.lastMessagePreview,
      unreadBoundary: getUnreadBoundary(metadata),
      armedWakeup: metadata.armedWakeup ?? null,
      activeLoop: metadata.activeLoop ?? null,
      blockedOnHuman: metadata.blockedOnHuman,
      interruptionReason: metadata.lastInterruptionReason ?? undefined,
      interruptionDetail: metadata.lastInterruptionDetail ?? undefined,
    });
    if (notification) {
      sessionIndexBus.publish(notification);
    }
  }

  async publishStoredStatus(
    sessionId: string,
    expectedStatus?: SessionMetadata["status"],
  ): Promise<SessionMetadata | null> {
    const metadata = await this.store.getSession(sessionId);
    if (!metadata) {
      return null;
    }
    if (expectedStatus && metadata.status !== expectedStatus) {
      throw new Error(
        `Status publish mismatch for ${sessionId}: expected ${expectedStatus}, found ${metadata.status}`,
      );
    }
    this.publishStatus(metadata);
    if (metadata.status === "idle") {
      void this.dispatchNextQueuedIfIdle(sessionId);
    }
    return metadata;
  }

  private async interruptSessionLocally(
    sessionId: string,
    expectedRunnerPid?: number,
    reason: SessionInterruptionReason = "user_abort",
    detail: string = interruptionDetail(reason),
  ): Promise<boolean> {
    const current = await this.store.getSession(sessionId);
    if (!current) {
      return false;
    }
    if (
      expectedRunnerPid !== undefined &&
      current.runnerPid !== expectedRunnerPid
    ) {
      return false;
    }
    if (!isAbortableStatus(current.status)) {
      return false;
    }

    const updated = await this.store.updateStatus(sessionId, "interrupted", {
      clearActiveRequest: true,
      clearRunnerPid: true,
      interruptionReason: reason,
      interruptionDetail: detail,
    });
    if (current.activeRequestId) {
      try {
        await this.store.deletePendingRequest(
          sessionId,
          current.activeRequestId,
        );
      } catch (error) {
        logger.chat.warn(
          "Failed to delete pending request after abort {sessionId}: {error}",
          { sessionId, error },
        );
      }
    }
    this.publishStatus(updated);
    return true;
  }

  private async clearMissingRunnerAfterAbort(
    sessionId: string,
    expectedRunnerPid: number,
    reason: SessionInterruptionReason = "runner_missing",
    detail: string = interruptionDetail(reason),
  ): Promise<void> {
    const interrupted = await this.interruptSessionLocally(
      sessionId,
      expectedRunnerPid,
      reason,
      detail,
    );
    if (interrupted) {
      return;
    }

    const current = await this.store.getSession(sessionId);
    if (!current || current.runnerPid !== expectedRunnerPid) {
      return;
    }

    await this.store.updateStatus(sessionId, current.status, {
      clearRunnerPid: true,
    });
  }

  /**
   * Kill any active subagent children whose parent is being aborted. v1
   * disallows recursion, so children themselves have no children — no need
   * to traverse deeper than one level.
   */
  private async cascadeAbortChildren(
    parentSessionId: string,
    projectPath: string,
    options: {
      reason: SessionInterruptionReason;
      detail: string;
    },
  ): Promise<void> {
    let siblings: ConversationSummary[];
    try {
      siblings = await this.store.listSessionsByProject(projectPath);
    } catch (error) {
      logger.chat.warn(
        "Failed to enumerate children for cascade abort on {parent}: {error}",
        { parent: parentSessionId, error },
      );
      return;
    }
    const activeChildren = siblings.filter(
      (s) =>
        s.parentSessionId === parentSessionId &&
        (s.status === "running" ||
          s.status === "awaiting_input" ||
          s.status === "backend_wakeup"),
    );
    for (const child of activeChildren) {
      const childMeta = await this.store.getSession(child.sessionId);
      if (!childMeta?.runnerPid) {
        if (childMeta) {
          await this.recordInterruptionAudit(childMeta.sessionId, {
            reason: options.reason,
            detail: options.detail,
            source: "cascade_abort",
          });
          await this.interruptSessionLocally(
            childMeta.sessionId,
            undefined,
            options.reason,
            options.detail,
          );
          await subprocessTracker.killSession(childMeta.sessionId);
        }
        continue;
      }
      try {
        process.kill(childMeta.runnerPid, "SIGTERM");
      } catch (error) {
        if (isNoSuchProcessError(error)) {
          await this.clearMissingRunnerAfterAbort(
            childMeta.sessionId,
            childMeta.runnerPid,
            options.reason,
            options.detail,
          );
        } else {
          logger.chat.warn(
            "Failed to cascade-abort child {child} of {parent}: {error}",
            { child: child.sessionId, parent: parentSessionId, error },
          );
        }
      }
      await subprocessTracker.killSession(childMeta.sessionId, {
        excludePids: [childMeta.runnerPid],
      });
    }
  }

  async abortByRequestId(requestId: string): Promise<boolean> {
    const session = await this.getByRequestId(requestId);
    if (!session) {
      return false;
    }
    return await this.abort(session.sessionId);
  }

  async renameSession(
    sessionId: string,
    title: string,
  ): Promise<SessionMetadata> {
    const current = await this.store.getSession(sessionId);
    if (!current) {
      throw new Error("Session not found");
    }

    const updated = await this.store.renameSession(sessionId, title);
    const displaySummary = await this.metadataToDisplaySummary(updated);
    if (!displaySummary) {
      return updated;
    }
    sessionIndexBus.publish({
      type: "session-updated",
      projectPath: updated.projectPath,
      encodedProjectName: updated.encodedProjectName,
      session: displaySummary,
    });
    return updated;
  }

  async archiveSession(sessionId: string): Promise<SessionMetadata> {
    const session = await this.store.getSession(sessionId);
    if (!session) {
      throw new Error("Session not found");
    }

    if (session.runnerPid) {
      await this.abort(sessionId, {
        reason: "archive",
        detail: interruptionDetail("archive"),
        auditSource: "archive_session",
      });
    }
    // Kill any surviving detached subprocesses even if the runner was already
    // gone (abort is a no-op when runnerPid is null).
    await subprocessTracker.killSession(sessionId);
    const archived = await this.store.archiveSession(sessionId);
    if (archived.status !== session.status) {
      this.publishStatus(archived);
    }
    sessionIndexBus.publish({
      type: "session-archived",
      projectPath: archived.projectPath,
      encodedProjectName: archived.encodedProjectName,
      sessionId: archived.sessionId,
    });
    return archived;
  }

  async appendSystemNotice(sessionId: string, message: string): Promise<void> {
    const systemMessage = {
      type: "system",
      timestamp: new Date().toISOString(),
      message,
    };
    await this.store.appendMessage(sessionId, systemMessage);
    await this.store.appendEvent(sessionId, "stream", {
      type: "claude_json",
      data: systemMessage,
    });
  }

  async recordInterruptionIntent(
    sessionId: string,
    input: {
      reason: SessionInterruptionReason;
      detail: string;
      source: string;
    },
  ): Promise<void> {
    await this.recordInterruptionAudit(sessionId, input);
  }

  private async recordInterruptionAudit(
    sessionId: string,
    input: {
      reason: SessionInterruptionReason;
      detail: string;
      source: string;
    },
  ): Promise<void> {
    await this.store.recordInterruptionIntent(
      sessionId,
      input.reason,
      input.detail,
    );
    const systemMessage = {
      type: "system",
      subtype: "session_interruption_audit",
      timestamp: new Date().toISOString(),
      reason: input.reason,
      source: input.source,
      message: input.detail,
    };
    await this.store.appendMessage(sessionId, systemMessage);
    await this.store.appendEvent(sessionId, "stream", {
      type: "claude_json",
      data: systemMessage,
    });
  }

  async setBlockedOnHuman(
    sessionId: string,
    info: BlockedOnHumanInfo,
  ): Promise<SessionMetadata> {
    const updated = await this.store.setBlockedOnHuman(sessionId, info);
    this.publishStatus(updated);
    return updated;
  }

  async clearBlockedOnHuman(sessionId: string): Promise<SessionMetadata> {
    const updated = await this.store.clearBlockedOnHuman(sessionId);
    this.publishStatus(updated);
    return updated;
  }

  async demoteSessionToChat(
    sessionId: string,
    title?: string,
  ): Promise<SessionMetadata> {
    const updated = await this.store.demoteSessionToChat(sessionId, title);
    const displaySummary = await this.metadataToDisplaySummary(updated);
    if (!displaySummary) {
      return updated;
    }
    sessionIndexBus.publish({
      type: "session-updated",
      projectPath: updated.projectPath,
      encodedProjectName: updated.encodedProjectName,
      session: displaySummary,
    });
    return updated;
  }

  async closeAll(): Promise<void> {
    await this.store.ensureInitialized();
  }

  private async metadataToDisplaySummary(
    metadata: SessionMetadata,
  ): Promise<ConversationSummary | null> {
    return metadataToSummary(metadata);
  }

  async getQueue(sessionId: string): Promise<QueuedMessage[]> {
    return await this.store.readQueue(sessionId);
  }

  /**
   * Append a message to the pending queue for `sessionId`. The caller is
   * expected to be the canonical-send handler rerouting because the session
   * is already running. We reuse `params.requestId` — the client generated
   * it and will be watching for the echo.
   */
  async enqueueMessage(
    sessionId: string,
    params: SessionMessageRequest,
  ): Promise<QueuedMessage> {
    await this.store.ensureInitialized();
    const session = await this.store.getSession(sessionId);
    if (!session) {
      throw new Error("Session not found");
    }
    if (!hasSendableContent(params)) {
      throw new Error("message is required");
    }
    const entry: QueuedMessage = {
      id: randomUUID(),
      message: params.message,
      createdAt: Date.now(),
      requestId: params.requestId,
      triggerSource: params.triggerSource,
      permissionMode: params.permissionMode,
      model: params.model,
      effort: params.effort,
      allowedTools: params.allowedTools,
      attachments: params.attachments,
    };
    const queued = await this.store.enqueueMessage(sessionId, entry);

    // Race hardening: the current turn can transition to idle between the
    // caller deciding to queue and the queue write landing on disk. In that
    // case the idle-transition watcher has already spent its one shot, so the
    // new head would otherwise sit until the user clicks "send now". If the
    // session is already idle after enqueueing, dispatch immediately.
    const refreshed = await this.store.getSession(sessionId);
    if (refreshed && canAutoDispatchQueuedMessage(refreshed)) {
      void this.dispatchNextQueuedIfIdle(sessionId);
    }

    return queued;
  }

  async removeQueued(
    sessionId: string,
    queuedId: string,
  ): Promise<QueuedMessage | null> {
    return await this.store.removeFromQueue(sessionId, queuedId);
  }

  /**
   * Immediately dispatch the head of the queue. Only valid when:
   *  - `queuedId` matches the first queued message, and
   *  - the session is not currently running.
   *
   * Send-now never interrupts an active turn. Callers must surface the
   * thrown errors to the client as appropriate HTTP statuses.
   */
  async sendNowFromQueue(
    sessionId: string,
    queuedId: string,
  ): Promise<SessionMetadata> {
    await this.store.ensureInitialized();
    const session = await this.store.getSession(sessionId);
    if (!session) {
      throw new Error("Session not found");
    }
    if (session.status === "running" || session.status === "backend_wakeup") {
      throw new Error("Session is running; cannot send now");
    }
    const queue = await this.store.readQueue(sessionId);
    if (queue.length === 0 || queue[0].id !== queuedId) {
      throw new Error("Only the first queued message can be sent now");
    }
    const first = await this.store.popFirstFromQueue(sessionId);
    if (!first) {
      throw new Error("Queue entry disappeared");
    }
    return await this.sendMessage(sessionId, queuedMessageToRequest(first));
  }

  /**
   * If the session just transitioned into `idle` with a non-empty queue,
   * pop the head and dispatch it. Called by the status watcher.
   */
  async dispatchNextQueuedIfIdle(sessionId: string): Promise<void> {
    await this.store.ensureInitialized();
    const session = await this.store.getSession(sessionId);
    if (!session) return;
    if (!canAutoDispatchQueuedMessage(session)) return;
    const next = await this.store.popFirstFromQueue(sessionId);
    if (!next) return;
    try {
      await this.sendMessage(sessionId, queuedMessageToRequest(next));
    } catch (error) {
      logger.chat.warn(
        "Auto-dispatch of queued message failed for {sessionId}: {error}",
        { sessionId, error },
      );
    }
  }

  private async resumeBackendWakeupSessions(): Promise<void> {
    const sessions = await this.store.listAllActiveMetadata();
    for (const session of sessions) {
      if (session.status !== "backend_wakeup") continue;
      const requestId = session.activeRequestId;
      if (!requestId) {
        await this.store.updateStatus(session.sessionId, "interrupted", {
          clearActiveRequest: true,
          clearRunnerPid: true,
          interruptionReason: "backend_resume_failed",
          interruptionDetail: "Backend wakeup session had no active request id",
        });
        continue;
      }

      const request = await this.store.readPendingRequest(
        session.sessionId,
        requestId,
      );
      if (!request) {
        await this.store.updateStatus(session.sessionId, "interrupted", {
          clearActiveRequest: true,
          clearRunnerPid: true,
          interruptionReason: "backend_resume_failed",
          interruptionDetail: "Backend wakeup pending request file was missing",
        });
        continue;
      }

      try {
        await this.sendMessage(session.sessionId, {
          ...request,
          requestId,
          skipTranscript: true,
          triggerSource: request.triggerSource ?? "hook",
        });
      } catch (error) {
        logger.chat.warn(
          "Auto-resume of backend wakeup session failed for {sessionId}: {error}",
          { sessionId: session.sessionId, error },
        );
        await this.store
          .deletePendingRequest(session.sessionId, requestId)
          .catch(() => {
            // Best effort cleanup; the status transition below is authoritative.
          });
        await this.store.updateStatus(session.sessionId, "interrupted", {
          clearActiveRequest: true,
          clearRunnerPid: true,
          interruptionReason: "backend_resume_failed",
          interruptionDetail:
            error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private spawnDetachedRunner(
    sessionId: string,
    requestId: string,
    cliPath: string,
    extraEnv?: Record<string, string>,
  ) {
    const runner = resolveRunnerEntry();
    const child = spawn(
      runner.command,
      [
        ...runner.args,
        "--session-id",
        sessionId,
        "--request-id",
        requestId,
        "--cli-path",
        cliPath,
      ],
      {
        detached: true,
        stdio: "ignore",
        env: {
          ...process.env,
          SWARMFLEET_CHAT_SESSION_ROOT: this.store.storageRoot,
          // Propagate so the detached runner can write per-run MCP configs
          // that let our subagent server call back into the backend.
          // SWARMFLEET_INTERNAL_TOKEN is already set on process.env by the
          // backend on startup (getInternalSubagentToken), but we spell it
          // out here to make the dependency visible.
          SWARMFLEET_INTERNAL_TOKEN:
            process.env.SWARMFLEET_INTERNAL_TOKEN ?? "",
          SWARMFLEET_BACKEND_URL:
            this.backendUrl ?? process.env.SWARMFLEET_BACKEND_URL ?? "",
          // Tag the runner and all its descendants so SubprocessTracker can
          // find them by scanning /proc/<pid>/environ.
          SWARMFLEET_SESSION_ID: sessionId,
          // Caller-supplied env layers on last so per-call values win over
          // anything inherited from the backend process. node spawn forwards
          // env to descendants, so the CLI subprocess will inherit these too.
          ...(extraEnv ?? {}),
        },
      },
    );

    child.once("error", (error) => {
      logger.chat.warn(
        "Detached runner process errored for {sessionId}: {error}",
        { sessionId, error },
      );
    });

    child.once("exit", (code, signal) => {
      void (async () => {
        const current = await this.store.getSession(sessionId);
        if (!current || current.runnerPid !== child.pid) {
          return;
        }
        if (
          current.status !== "running" &&
          current.status !== "awaiting_input"
        ) {
          return;
        }
        const details: string[] = [];
        if (code !== null) {
          details.push(`exit code ${code}`);
        }
        if (signal) {
          details.push(`signal ${signal}`);
        }
        const updated = await this.store.reconcileUnexpectedRunnerExit(
          sessionId,
          details.length > 0
            ? `Session runner stopped unexpectedly (${details.join(", ")})`
            : "Session runner stopped unexpectedly",
        );
        if (updated) {
          this.publishStatus(updated);
        }
      })().catch((error) => {
        logger.chat.warn(
          "Failed to reconcile detached runner exit for {sessionId}: {error}",
          { sessionId, error },
        );
      });
    });

    child.unref();
    return child;
  }
}

export const sessionManager = new SessionManager();
