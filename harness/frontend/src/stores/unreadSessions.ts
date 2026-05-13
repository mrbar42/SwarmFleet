/**
 * Server-backed tracking of sessions that have new activity the user hasn't
 * opened yet.
 *
 * The stored value for each unread session is the *unread-boundary timestamp*:
 * any message with `timestamp > boundary` is considered unread. This lets the
 * chat view scroll to the first unread message when the session is opened.
 *
 * The server owns read state so multiple open clients converge: opening a
 * session on one device clears the unread badge everywhere.
 */

import { getSessionReadUrl } from "../config/api";

type Listener = () => void;

const listeners = new Set<Listener>();
let unread: Map<string, number> = new Map();

// Transient, in-memory signal from Sidebar → ChatMessages: when the user
// opens an unread session we stash the boundary here so the chat view can
// scroll to the first unread message even though the unread flag has
// already been cleared by the time ChatMessages mounts the session.
const pendingScrollTargets = new Map<string, number>();

function notify(): void {
  for (const fn of Array.from(listeners)) {
    try {
      fn();
    } catch {
      // Listener errors shouldn't break others.
    }
  }
}

export function getUnreadSessions(): ReadonlyMap<string, number> {
  return unread;
}

export function isSessionUnread(sessionId: string): boolean {
  return unread.has(sessionId);
}

export function getUnreadBoundary(sessionId: string): number | undefined {
  return unread.get(sessionId);
}

export function applyServerUnreadBoundary(
  sessionId: string,
  boundary: number | null | undefined,
): void {
  const existing = unread.get(sessionId);
  if (typeof boundary !== "number") {
    if (existing === undefined) return;
    unread = new Map(unread);
    unread.delete(sessionId);
    notify();
    return;
  }
  if (existing === boundary) return;
  unread = new Map(unread);
  unread.set(sessionId, boundary);
  notify();
}

export function markSessionRead(
  sessionId: string,
  options: { force?: boolean } = {},
): void {
  const wasUnread = unread.has(sessionId);
  if (wasUnread) {
    unread = new Map(unread);
    unread.delete(sessionId);
    notify();
  }
  if (!wasUnread && !options.force) return;
  void fetch(getSessionReadUrl(sessionId), { method: "POST" }).catch(() => {
    // The SSE/status snapshot will restore the badge if the server write fails.
  });
}

export function clearAllUnread(): void {
  if (unread.size === 0) return;
  unread = new Map();
  notify();
}

export function subscribeUnreadSessions(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * Stash a pending scroll target so that ChatMessages can scroll to the
 * first unread message once the session's history finishes loading.
 */
export function queueUnreadScrollTarget(sessionId: string, boundary: number): void {
  pendingScrollTargets.set(sessionId, boundary);
}

/**
 * Read-and-clear the pending scroll target for a session. Returns undefined
 * if there was nothing queued.
 */
export function consumeUnreadScrollTarget(sessionId: string): number | undefined {
  const boundary = pendingScrollTargets.get(sessionId);
  if (boundary === undefined) return undefined;
  pendingScrollTargets.delete(sessionId);
  return boundary;
}
