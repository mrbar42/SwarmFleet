import type { Hono } from "hono";
import type {
  ConversationSummary,
  CreateSessionRequest,
  HistoryListResponse,
  QueuedMessage,
  QueueSnapshot,
  SessionAbortResponse,
  SessionIndexEvent,
  SessionIndexStreamEvent,
  SessionMessageRequest,
  SessionMessageResponse,
  SessionReadyEvent,
  SessionStatusSnapshot,
  SessionMetadata,
  SubprocessUpdate,
} from "../../../shared/types.ts";
import type { ConfigContext } from "../../middleware/config.ts";
import {
  sessionManager,
  type SessionManager,
} from "../../services/sessionManager.ts";
import { sessionIndexBus } from "../../services/sessionIndexBus.ts";
import type { StoredSessionEvent } from "../../services/chatSessionStore.ts";
import { subprocessTracker } from "../../services/subprocessTracker.ts";
import {
  getWorkspacesRootFromContext,
  ProjectPathError,
  projectPathErrorResponse,
  validateExistingProjectPath,
} from "../../utils/projectPaths.ts";

function parseLastEventId(rawValue: string | null | undefined): number {
  if (!rawValue) {
    return -1;
  }

  const parsed = Number.parseInt(rawValue, 10);
  return Number.isFinite(parsed) ? parsed : -1;
}

function encodeSseFrame(
  event:
    | StoredSessionEvent
    | {
        channel: "session" | "status" | "queue";
        id?: number;
        version?: number;
        eventId?: string;
        data: SessionReadyEvent | SessionStatusSnapshot | QueueSnapshot;
      },
): Uint8Array {
  const encoder = new TextEncoder();
  const version = event.version ?? event.id;
  const eventId =
    event.eventId ??
    (typeof event.id === "number" ? String(event.id) : undefined);
  const payload = JSON.stringify(
    typeof version === "number" && eventId
      ? { ...event.data, version, eventId }
      : event.data,
  );
  const idLine = eventId ? `id: ${eventId}\n` : "";
  return encoder.encode(
    `${idLine}event: ${event.channel}\ndata: ${payload}\n\n`,
  );
}

function encodeSessionIndexSseFrame(
  event: SessionIndexStreamEvent,
): Uint8Array {
  const encoder = new TextEncoder();
  return encoder.encode(
    `id: ${event.eventId}\nevent: session-index\ndata: ${JSON.stringify(event)}\n\n`,
  );
}

function encodeSubprocessSseFrame(update: SubprocessUpdate): Uint8Array {
  const encoder = new TextEncoder();
  return encoder.encode(
    `event: subprocess\ndata: ${JSON.stringify(update)}\n\n`,
  );
}

function buildConversationSummary(
  session: SessionMetadata,
): ConversationSummary {
  return {
    sessionId: session.sessionId,
    title: session.title,
    startTime: new Date(session.createdAt).toISOString(),
    lastTime: new Date(session.updatedAt).toISOString(),
    provider: session.provider,
    messageCount: session.messageCount,
    lastMessagePreview: session.lastMessagePreview,
    status: session.status,
    sourceKind: session.sourceKind,
    kind: session.kind,
    parentSessionId: session.parentSessionId ?? null,
    parentToolUseId: session.parentToolUseId ?? null,
    activeLoop: session.activeLoop ?? null,
  };
}

export async function canArchiveSession(
  session: SessionMetadata,
): Promise<boolean> {
  return session.kind === "chat" || session.kind === "subagent";
}

function sortSessionsNewestFirst(
  sessions: ConversationSummary[],
): ConversationSummary[] {
  return [...sessions].sort((a, b) => {
    return Date.parse(b.lastTime) - Date.parse(a.lastTime);
  });
}

function registerCanonicalMessageRoute(
  app: Hono<ConfigContext>,
  path: string,
  manager: SessionManager,
): void {
  app.post(path, async (c) => {
    const sessionId = c.req.param("sessionId");
    let existing = sessionId ? await manager.get(sessionId) : null;
    if (!existing) {
      return c.json({ error: "Session not found" }, 404);
    }

    const body = await c.req.json<SessionMessageRequest>();
    if (!body.requestId) {
      return c.json({ error: "requestId is required" }, 400);
    }
    if (
      typeof body.message !== "string" ||
      (!body.message.trim() && (body.attachments?.length ?? 0) === 0)
    ) {
      return c.json({ error: "message is required" }, 400);
    }

    // If the session is already running, don't reject — enqueue the message
    // so it auto-dispatches when the current turn ends. This is the same
    // `/message` endpoint the client uses for idle sessions; the queue is a
    // transparent fallback, not a separate contract.
    if (existing.status === "running" || existing.status === "backend_wakeup") {
      try {
        const queued = await manager.enqueueMessage(sessionId!, body);
        const response: SessionMessageResponse = {
          requestId: body.requestId,
          queued: true,
          queuedId: queued.id,
        };
        return c.json(response, 202);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // 409 is the right code for "queue is full" — same class of
        // back-pressure signal the client already handles.
        if (message.includes("Queue is full")) {
          return c.json({ error: message }, 409);
        }
        return c.json({ error: message }, 500);
      }
    }

    try {
      await manager.sendMessage(sessionId!, body);
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : String(error) },
        500,
      );
    }

    const response: SessionMessageResponse = { requestId: body.requestId };
    return c.json(response, 202);
  });
}

export function registerSessionRoutes(app: Hono<ConfigContext>): void {
  void sessionManager.ensureInitialized();

  app.get("/api/sessions/:sessionId/assets/:assetId", async (c) => {
    const sessionId = c.req.param("sessionId");
    const assetId = c.req.param("assetId");
    const image = await sessionManager.readImageAsset(sessionId, assetId);
    if (!image) {
      return c.json({ error: "asset_not_found" }, 404);
    }
    return new Response(new Uint8Array(image.bytes), {
      headers: {
        "content-type": image.asset.mimeType,
        "cache-control": "private, max-age=31536000, immutable",
      },
    });
  });

  app.get("/api/sessions", async (c) => {
    const projectPath = c.req.query("project");
    if (!projectPath) {
      return c.json({ error: "project is required" }, 400);
    }

    const all = await sessionManager.listByProject(projectPath);
    const conversations = sortSessionsNewestFirst(all);
    return c.json({ conversations } satisfies HistoryListResponse);
  });

  app.post("/api/sessions", async (c) => {
    const body = await c.req.json<CreateSessionRequest>();
    let projectPath: string;
    try {
      projectPath = await validateExistingProjectPath(
        body.projectPath,
        getWorkspacesRootFromContext(c),
      );
    } catch (error) {
      if (error instanceof ProjectPathError) return projectPathErrorResponse(error);
      throw error;
    }

    // POST always creates an ordinary chat. Force kind to "chat" to prevent
    // clients from forging specialized session kinds.
    const session = await sessionManager.create({
      ...body,
      projectPath,
      kind: "chat",
    });
    return c.json(session, 201);
  });

  app.get("/api/sessions/:sessionId", async (c) => {
    const sessionId = c.req.param("sessionId");
    const session = sessionId ? await sessionManager.get(sessionId) : null;
    if (!session) {
      return c.json({ error: "Session not found" }, 404);
    }
    return c.json(session);
  });

  app.get("/api/sessions/:sessionId/messages", async (c) => {
    const sessionId = c.req.param("sessionId");
    const limitParam = c.req.query("limit");
    const beforeParam = c.req.query("before");
    const limit = limitParam ? Number(limitParam) : undefined;
    const before = beforeParam ? Number(beforeParam) : undefined;
    const conversation = sessionId
      ? await sessionManager.getConversation(sessionId, { limit, before })
      : null;
    if (!conversation) {
      return c.json({ error: "Session not found" }, 404);
    }
    return c.json(conversation);
  });

  // Long-lived SSE stream that broadcasts session-index changes (create,
  // rename, archive) to every connected client. The sidebar subscribes on
  // load so new sessions created on one device appear on another without
  // needing a manual refresh.
  app.get("/api/sessions/index/stream", (c) => {
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    let unsubscribe: (() => void) | null = null;
    let closed = false;

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const encoder = new TextEncoder();
        const queued: SessionIndexEvent[] = [];
        let replaying = true;
        let cursor = -1;

        const send = (event: SessionIndexStreamEvent) => {
          if (closed) return;
          try {
            controller.enqueue(encodeSessionIndexSseFrame(event));
          } catch {
            close();
          }
        };

        const sendTracked = (event: SessionIndexEvent) => {
          if (replaying) {
            queued.push(event);
            return;
          }
          send(event);
        };

        const sendSnapshot = async () => {
          // Capture the bus version before reading the session store. Any
          // publish that happens during the read is queued by sendTracked and
          // replayed after the snapshot, so it cannot be hidden by the
          // snapshot cursor.
          const version = sessionIndexBus.getCurrentVersion();
          const sessions = await sessionManager.getIndexSnapshot();
          const snapshot: SessionIndexStreamEvent = {
            type: "session-index-snapshot",
            sessions,
            version,
            eventId: String(version),
          };
          cursor = version;
          send(snapshot);
        };

        const close = () => {
          if (closed) return;
          closed = true;
          if (heartbeat) clearInterval(heartbeat);
          if (unsubscribe) unsubscribe();
          try {
            controller.close();
          } catch {
            // Already closed.
          }
        };

        // Signal readiness so clients know the subscription is live.
        controller.enqueue(encoder.encode(`event: ready\ndata: {}\n\n`));

        unsubscribe = sessionIndexBus.subscribe(sendTracked);

        try {
          // Every browser keeps its own persisted sidebar cache, so a version
          // replay alone cannot prove that the local cache is correct. Send an
          // authoritative snapshot on every new connection; queued live events
          // below preserve changes that arrive while the snapshot is loading.
          await sendSnapshot();
        } catch {
          close();
          return;
        } finally {
          replaying = false;
        }

        for (const event of queued) {
          if (event.version > cursor) {
            cursor = event.version;
            send(event);
          }
        }
        queued.length = 0;

        heartbeat = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(": ping\n\n"));
          } catch {
            close();
          }
        }, 15000);

        c.req.raw.signal.addEventListener("abort", close, { once: true });
      },
      cancel() {
        if (heartbeat) clearInterval(heartbeat);
        if (unsubscribe) unsubscribe();
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
      },
    });
  });

  app.get("/api/sessions/:sessionId/stream", async (c) => {
    const sessionId = c.req.param("sessionId");
    const session = sessionId ? await sessionManager.get(sessionId) : null;
    if (!session) {
      return c.json({ error: "Session not found" }, 404);
    }

    const headerLastEventId = parseLastEventId(c.req.header("Last-Event-ID"));
    const queryLastEventId = parseLastEventId(c.req.query("lastEventId"));
    let cursor = headerLastEventId >= 0 ? headerLastEventId : queryLastEventId;

    let heartbeat: ReturnType<typeof setInterval> | null = null;
    let pollHandle: ReturnType<typeof setInterval> | null = null;
    let unsubscribeTracker: (() => void) | null = null;
    let closed = false;

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const close = () => {
          if (closed) return;
          closed = true;
          if (heartbeat) clearInterval(heartbeat);
          if (pollHandle) clearInterval(pollHandle);
          if (unsubscribeTracker) unsubscribeTracker();
          try {
            controller.close();
          } catch {
            // Already closed.
          }
        };

        controller.enqueue(
          encodeSseFrame({
            channel: "session",
            data: {
              type: "session_ready",
              sessionId: session.sessionId,
            },
          }),
        );
        controller.enqueue(
          encodeSseFrame({
            channel: "status",
            data: {
              sessionId: session.sessionId,
              status: session.status,
              interruptionReason: session.lastInterruptionReason ?? undefined,
              interruptionDetail: session.lastInterruptionDetail ?? undefined,
            },
          }),
        );

        // Seed the current queue so a freshly-opened tab (or a second device
        // joining mid-turn) shows the pending messages immediately, without
        // waiting for the next queue mutation.
        try {
          const queued = await sessionManager.getQueue(session.sessionId);
          controller.enqueue(
            encodeSseFrame({
              channel: "queue",
              data: { sessionId: session.sessionId, queued },
            }),
          );
        } catch {
          // Best effort — a missing queue.json just means empty queue.
        }

        // Track the current cliPid for the displayable filter. Refreshed each
        // time the poll interval fires so it stays in sync as the CLI starts.
        let currentCliPid: number | null = session.cliPid ?? null;

        unsubscribeTracker = subprocessTracker.subscribe(
          session.sessionId,
          (update) => {
            if (closed) return;
            try {
              controller.enqueue(encodeSubprocessSseFrame(update));
            } catch {
              close();
            }
          },
          () => currentCliPid,
        );

        pollHandle = setInterval(async () => {
          try {
            const events = await sessionManager.getEventsSince(
              sessionId,
              cursor,
            );
            if (events === null) {
              const freshMeta = await sessionManager.get(sessionId);
              if (!freshMeta) {
                close();
                return;
              }
              currentCliPid = freshMeta.cliPid ?? null;
              cursor = freshMeta.latestEventId;
              controller.enqueue(
                encodeSseFrame({
                  channel: "status",
                  id: cursor >= 0 ? cursor : undefined,
                  version: cursor >= 0 ? cursor : undefined,
                  eventId: cursor >= 0 ? String(cursor) : undefined,
                  data: {
                    sessionId: freshMeta.sessionId,
                    status: freshMeta.status,
                    interruptionReason:
                      freshMeta.lastInterruptionReason ?? undefined,
                    interruptionDetail:
                      freshMeta.lastInterruptionDetail ?? undefined,
                  },
                }),
              );
              const queued = await sessionManager.getQueue(freshMeta.sessionId);
              controller.enqueue(
                encodeSseFrame({
                  channel: "queue",
                  id: cursor >= 0 ? cursor : undefined,
                  version: cursor >= 0 ? cursor : undefined,
                  eventId: cursor >= 0 ? String(cursor) : undefined,
                  data: { sessionId: freshMeta.sessionId, queued },
                }),
              );
              return;
            }
            for (const event of events) {
              controller.enqueue(encodeSseFrame(event));
              cursor = event.id;
            }
            // Refresh cliPid so subprocess entries stay correctly labelled.
            const freshMeta = await sessionManager.get(sessionId);
            if (freshMeta) {
              currentCliPid = freshMeta.cliPid ?? null;
            }
          } catch {
            close();
          }
        }, 500);

        heartbeat = setInterval(() => {
          try {
            controller.enqueue(new TextEncoder().encode(": ping\n\n"));
          } catch {
            close();
          }
        }, 15000);

        c.req.raw.signal.addEventListener("abort", close, { once: true });
      },
      cancel() {
        if (heartbeat) clearInterval(heartbeat);
        if (pollHandle) clearInterval(pollHandle);
        if (unsubscribeTracker) unsubscribeTracker();
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
      },
    });
  });

  registerCanonicalMessageRoute(
    app,
    "/api/sessions/:sessionId/messages",
    sessionManager,
  );
  registerCanonicalMessageRoute(
    app,
    "/api/sessions/:sessionId/message",
    sessionManager,
  );

  app.get("/api/sessions/:sessionId/queue", async (c) => {
    const sessionId = c.req.param("sessionId");
    const existing = sessionId ? await sessionManager.get(sessionId) : null;
    if (!existing) {
      return c.json({ error: "Session not found" }, 404);
    }
    const queued = await sessionManager.getQueue(sessionId!);
    return c.json({ queued } satisfies { queued: QueuedMessage[] });
  });

  app.delete("/api/sessions/:sessionId/queue/:queuedId", async (c) => {
    const sessionId = c.req.param("sessionId");
    const queuedId = c.req.param("queuedId");
    if (!sessionId || !queuedId) {
      return c.json({ error: "sessionId and queuedId are required" }, 400);
    }
    const existing = await sessionManager.get(sessionId);
    if (!existing) {
      return c.json({ error: "Session not found" }, 404);
    }
    const removed = await sessionManager.removeQueued(sessionId, queuedId);
    if (!removed) {
      return c.json({ error: "Queued message not found" }, 404);
    }
    return c.json({ ok: true, removed });
  });

  app.post("/api/sessions/:sessionId/queue/:queuedId/send-now", async (c) => {
    const sessionId = c.req.param("sessionId");
    const queuedId = c.req.param("queuedId");
    if (!sessionId || !queuedId) {
      return c.json({ error: "sessionId and queuedId are required" }, 400);
    }
    const existing = await sessionManager.get(sessionId);
    if (!existing) {
      return c.json({ error: "Session not found" }, 404);
    }
    try {
      const updated = await sessionManager.sendNowFromQueue(
        sessionId,
        queuedId,
      );
      return c.json({ ok: true, status: updated.status });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("Session is running")) {
        return c.json({ error: message }, 409);
      }
      if (message.includes("Only the first")) {
        return c.json({ error: message }, 409);
      }
      return c.json({ error: message }, 500);
    }
  });

  app.post("/api/sessions/:sessionId/abort", async (c) => {
    const sessionId = c.req.param("sessionId");
    const aborted = sessionId ? await sessionManager.abort(sessionId) : false;
    if (!aborted) {
      return c.json({ error: "Session not found or not running" }, 404);
    }

    const response: SessionAbortResponse = { aborted: true };
    return c.json(response);
  });

  app.post("/api/sessions/:sessionId/rename", async (c) => {
    const sessionId = c.req.param("sessionId");
    const body = await c.req.json<{ title?: string }>();
    const title =
      typeof body.title === "string" ? body.title.trim().slice(0, 120) : "";
    if (!sessionId || !title) {
      return c.json({ error: "title is required" }, 400);
    }

    const session = await sessionManager.get(sessionId);
    if (!session) {
      return c.json({ error: "Session not found" }, 404);
    }
    if (session.kind !== "chat") {
      return c.json({ error: "only chat sessions can be renamed" }, 409);
    }

    const updated = await sessionManager.renameSession(sessionId, title);
    return c.json({ ok: true, title: updated.title });
  });

  app.post("/api/sessions/:sessionId/read", async (c) => {
    const sessionId = c.req.param("sessionId");
    const updated = sessionId
      ? await sessionManager.markSessionRead(sessionId)
      : null;
    if (!updated) {
      return c.json({ error: "Session not found" }, 404);
    }
    return c.json({ ok: true });
  });

  app.post("/api/sessions/:sessionId/archive", async (c) => {
    const sessionId = c.req.param("sessionId");
    if (!sessionId) {
      return c.json({ error: "Session not found" }, 404);
    }

    const session = await sessionManager.get(sessionId);
    if (!session) {
      return c.json({ error: "Session not found" }, 404);
    }

    if (!(await canArchiveSession(session))) {
      return c.json({ error: "session cannot be archived" }, 409);
    }

    await sessionManager.archiveSession(sessionId);
    return c.json({ ok: true });
  });

  app.post("/api/sessions/:sessionId/processes/:pid/kill", async (c) => {
    const sessionId = c.req.param("sessionId");
    const pidStr = c.req.param("pid");
    if (!sessionId || !pidStr) {
      return c.json({ error: "sessionId and pid are required" }, 400);
    }
    const pid = Number.parseInt(pidStr, 10);
    if (!Number.isFinite(pid) || pid <= 0) {
      return c.json({ error: "Invalid pid" }, 400);
    }
    const session = await sessionManager.get(sessionId);
    if (!session) {
      return c.json({ error: "Session not found" }, 404);
    }
    let body: { allowSessionControlProcess?: unknown } = {};
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    const protectedPids = new Set(
      [session.runnerPid, session.cliPid].filter(
        (value): value is number =>
          typeof value === "number" && Number.isFinite(value),
      ),
    );
    if (protectedPids.has(pid) && body.allowSessionControlProcess !== true) {
      return c.json(
        {
          error:
            "Refusing to kill the session runner/provider process without allowSessionControlProcess=true",
        },
        409,
      );
    }
    if (protectedPids.has(pid)) {
      await sessionManager.recordInterruptionIntent(sessionId, {
        reason: "process_kill",
        detail: `Session control process kill requested for PID ${pid}`,
        source: "process_kill_route",
      });
    }
    try {
      await subprocessTracker.killPid(sessionId, pid);
      return c.json({ ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("does not belong")) {
        return c.json({ error: message }, 403);
      }
      if (message.includes("not found")) {
        return c.json({ error: message }, 404);
      }
      return c.json({ error: message }, 500);
    }
  });

  app.post("/api/sessions/:sessionId/tasks/:taskId/stop", async (c) => {
    const sessionId = c.req.param("sessionId");
    const taskId = c.req.param("taskId");
    if (!sessionId || !taskId) {
      return c.json({ error: "sessionId and taskId are required" }, 400);
    }

    const session = await sessionManager.get(sessionId);
    if (!session) {
      return c.json({ error: "Session not found" }, 404);
    }

    let body: { command?: unknown } = {};
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }

    const command = typeof body.command === "string" ? body.command.trim() : "";
    if (!command) {
      return c.json({ error: "Task command is required" }, 400);
    }

    try {
      const killed = await subprocessTracker.killMatchingCommand(
        sessionId,
        command,
        session.cliPid,
        { excludePids: [session.runnerPid, session.cliPid] },
      );
      return c.json({
        ok: true,
        taskId,
        killed: {
          pid: killed.pid,
          command: killed.command,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("does not belong")) {
        return c.json({ error: message }, 403);
      }
      if (
        message.includes("not found") ||
        message.includes("No running process")
      ) {
        return c.json({ error: message }, 404);
      }
      return c.json({ error: message }, 500);
    }
  });
}
