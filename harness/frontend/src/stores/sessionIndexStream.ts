import type {
  ConversationSummary,
  SessionIndexEvent,
  SessionIndexStreamEvent,
  SessionStatus,
} from "@shared/types";
import { getSessionIndexStreamUrl } from "../config/api";
import { useAppStore } from "./appStore";
import {
  clearAllBackgroundSessionStatuses,
  updateBackgroundSessionStatus,
} from "./sessionStatus";
import { applyServerUnreadBoundary } from "./unreadSessions";
import {
  handleServerNotification,
  handleStatusCompletionNotification,
} from "../utils/notifications";
import {
  getLastStreamVersion,
  INDEX_STREAM_KEY,
  markStreamEvent,
  setStreamReadyState,
} from "./connectionStateStore";

/**
 * Long-lived EventSource subscription to `/api/sessions/index/stream` that
 * keeps the sidebar session list in sync across devices. When the phone
 * creates a new session the laptop's sidebar updates immediately (and vice
 * versa) without a page refresh.
 *
 * The browser's EventSource auto-reconnects on network hiccups, so we only
 * need to open it once per app load. If the backend ever sends a close, we
 * defensively re-open after a short backoff.
 */

let source: EventSource | null = null;
let reopenTimer: ReturnType<typeof setTimeout> | null = null;
let retryAttempt = 0;
const activeSessionProjects = new Map<string, string>();
const MAX_RECONNECT_DELAY_MS = 60_000;
const BASE_RECONNECT_DELAY_MS = 1_000;

function upsertSession(
  projectPath: string,
  incoming: ConversationSummary,
  mode: "created" | "updated",
): void {
  applyServerUnreadBoundary(incoming.sessionId, incoming.unreadBoundary);
  const state = useAppStore.getState();
  const existing = state.sessionIndex.get(projectPath);
  // If this project hasn't been expanded yet, don't seed it here — the next
  // fetchSessions() on expand will pull the full list. This keeps the index
  // a cache of what the UI has actually shown.
  if (!existing) return;

  const withoutDup = existing.filter(
    (session) => session.sessionId !== incoming.sessionId,
  );

  let next: ConversationSummary[];
  if (mode === "updated") {
    // Preserve position on rename; fall back to created-insert if the session
    // wasn't in the list yet (e.g. event arrived during a race).
    const index = existing.findIndex(
      (session) => session.sessionId === incoming.sessionId,
    );
    if (index === -1) {
      next = insertByKind(withoutDup, incoming);
    } else {
      next = [...existing];
      next[index] = incoming;
    }
  } else {
    next = insertByKind(withoutDup, incoming);
  }

  state.updateSessionIndex(projectPath, next);
}

/**
 * Insert child sessions above ordinary chats while preserving newest-chat-first
 * ordering for regular sessions.
 */
function insertByKind(
  list: ConversationSummary[],
  incoming: ConversationSummary,
): ConversationSummary[] {
  if (incoming.kind !== "chat") {
    return [incoming, ...list];
  }
  const firstChatIndex = list.findIndex((session) => session.kind === "chat");
  if (firstChatIndex === -1) {
    return [...list, incoming];
  }
  return [
    ...list.slice(0, firstChatIndex),
    incoming,
    ...list.slice(firstChatIndex),
  ];
}

function removeFromIndex(projectPath: string, sessionId: string): void {
  const state = useAppStore.getState();
  const existing = state.sessionIndex.get(projectPath);
  if (!existing) return;
  const filtered = existing.filter(
    (session) => session.sessionId !== sessionId,
  );
  if (filtered.length !== existing.length) {
    state.updateSessionIndex(projectPath, filtered);
  }
}

function isActiveStatus(status: SessionStatus | undefined): boolean {
  return (
    status === "running" ||
    status === "backend_wakeup" ||
    status === "awaiting_input" ||
    status === "blocked_on_human"
  );
}

function applySessionStatusTransition(
  event: Extract<SessionIndexEvent, { type: "session-status" }>,
): void {
  const wasTrackedActive = activeSessionProjects.has(event.sessionId);
  const isActive = isActiveStatus(event.status);
  if (!isActive) {
    activeSessionProjects.delete(event.sessionId);
  } else {
    activeSessionProjects.set(event.sessionId, event.projectPath);
  }
  if (wasTrackedActive && event.status === "idle") {
    handleStatusCompletionNotification(event);
  }
  applyServerUnreadBoundary(event.sessionId, event.unreadBoundary);
  updateBackgroundSessionStatus(
    event.sessionId,
    event.status,
    event.blockedOnHuman,
  );
  useAppStore
    .getState()
    .updateSessionStatus(
      event.sessionId,
      event.status,
      event.lastMessagePreview,
      event.unreadBoundary,
      event.armedWakeup,
      (event as Record<string, unknown>).activeLoop as ConversationSummary["activeLoop"],
    );
}

function applySnapshot(
  event: Extract<SessionIndexStreamEvent, { type: "session-index-snapshot" }>,
): void {
  clearAllBackgroundSessionStatuses();
  activeSessionProjects.clear();

  const grouped = new Map<string, ConversationSummary[]>();
  for (const entry of event.sessions) {
    applyServerUnreadBoundary(
      entry.session.sessionId,
      entry.session.unreadBoundary,
    );
    const sessions = grouped.get(entry.projectPath) ?? [];
    sessions.push(entry.session);
    grouped.set(entry.projectPath, sessions);
    const status = entry.session.status;
    if (isActiveStatus(status) && status !== undefined) {
      activeSessionProjects.set(entry.session.sessionId, entry.projectPath);
      updateBackgroundSessionStatus(entry.session.sessionId, status);
    }
  }

  const state = useAppStore.getState();
  for (const projectPath of Array.from(state.sessionIndex.keys())) {
    state.clearProjectSessions(projectPath);
  }
  for (const [projectPath, sessions] of grouped.entries()) {
    state.updateSessionIndex(projectPath, sessions);
  }
}

function handleEvent(raw: MessageEvent): void {
  if (source) {
    markStreamEvent(INDEX_STREAM_KEY, source.readyState, raw.lastEventId);
  }
  try {
    const event = JSON.parse(raw.data) as SessionIndexStreamEvent;
    if (event.type === "session-index-snapshot") {
      applySnapshot(event);
      return;
    }
    switch (event.type) {
      case "session-created":
        upsertSession(event.projectPath, event.session, "created");
        break;
      case "session-updated":
        upsertSession(event.projectPath, event.session, "updated");
        break;
      case "session-archived":
        removeFromIndex(event.projectPath, event.sessionId);
        break;
      case "session-status": {
        applySessionStatusTransition(event);
        break;
      }
      case "notification":
        handleServerNotification(event);
        break;
    }
  } catch {
    // Malformed frame — skip.
  }
}

function scheduleReopen(): void {
  if (reopenTimer) return;
  setStreamReadyState(INDEX_STREAM_KEY, EventSource.CONNECTING, {
    reconnecting: true,
  });
  const delay = Math.min(
    MAX_RECONNECT_DELAY_MS,
    BASE_RECONNECT_DELAY_MS * 2 ** retryAttempt,
  );
  retryAttempt += 1;
  reopenTimer = setTimeout(() => {
    reopenTimer = null;
    connectSessionIndexStream();
  }, delay);
}

function handleReady(): void {
  retryAttempt = 0;
  if (source) {
    markStreamEvent(INDEX_STREAM_KEY, source.readyState);
  }
  // The following snapshot or replayed deltas are authoritative for this
  // connection; no client-side reconcile probe is needed.
}

function buildSessionIndexStreamUrl(): string {
  const base = getSessionIndexStreamUrl();
  const lastVersion = getLastStreamVersion(INDEX_STREAM_KEY);
  if (lastVersion === undefined) {
    return base;
  }
  const url = new URL(base, window.location.origin);
  url.searchParams.set("lastEventId", String(lastVersion));
  return `${url.pathname}${url.search}`;
}

export function connectSessionIndexStream(): () => void {
  if (source) {
    return disconnectSessionIndexStream;
  }

  try {
    source = new EventSource(buildSessionIndexStreamUrl());
    setStreamReadyState(INDEX_STREAM_KEY, source.readyState);
  } catch {
    setStreamReadyState(INDEX_STREAM_KEY, EventSource.CONNECTING, {
      reconnecting: true,
    });
    scheduleReopen();
    return disconnectSessionIndexStream;
  }

  source.addEventListener("session-index", handleEvent as EventListener);
  source.addEventListener("ready", handleReady as EventListener);
  source.addEventListener("error", () => {
    if (source) {
      setStreamReadyState(INDEX_STREAM_KEY, source.readyState, {
        reconnecting: source.readyState !== EventSource.OPEN,
      });
    }
    // EventSource will auto-reconnect on transient errors; if it moves to
    // CLOSED we force a fresh connection and keep doing so with capped
    // exponential backoff.
    if (source && source.readyState !== EventSource.OPEN) {
      source.close();
      source = null;
      scheduleReopen();
    }
  });

  return disconnectSessionIndexStream;
}

export function reconnectSessionIndexStream(): void {
  retryAttempt = 0;
  if (reopenTimer) {
    clearTimeout(reopenTimer);
    reopenTimer = null;
  }
  if (source) {
    source.close();
    source = null;
  }
  connectSessionIndexStream();
}

export function disconnectSessionIndexStream(): void {
  activeSessionProjects.clear();
  retryAttempt = 0;
  if (reopenTimer) {
    clearTimeout(reopenTimer);
    reopenTimer = null;
  }
  if (source) {
    source.close();
    source = null;
  }
}
