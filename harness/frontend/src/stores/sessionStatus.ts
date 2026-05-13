import type { BlockedOnHumanInfo, SessionStatus } from "@shared/types";

export interface SessionStatusEntry {
  isStreaming: boolean;
  isWaitingForHuman: boolean;
  isInterrupted: boolean;
  isBlockedOnHuman: boolean;
  /** Reason payload — only set when `isBlockedOnHuman` is true. */
  blockedOnHuman?: BlockedOnHumanInfo;
}

type Listener = () => void;

/**
 * Per-session live status, driven by backend status events. The session-index
 * SSE is the broad source for background sessions, while the currently-open
 * session stream can also mirror its own status so the active indicator does
 * not depend on the global index transition being observed.
 *
 * Why no chatStore overlay: the per-session SSE opens *before* a send's POST
 * completes, and its one-shot "status" event can deliver a stale
 * `status:idle` between startRequest() setting phase=streaming and the
 * backend's `running` transition. Callers that mirror the per-session stream
 * must ignore that stale idle while a local request is in flight.
 */

interface BackgroundStatusRecord {
  status: SessionStatus;
  blockedOnHuman?: BlockedOnHumanInfo;
}

const backgroundStatus = new Map<string, BackgroundStatusRecord>();
const listeners = new Set<Listener>();

let cachedSnapshot: Map<string, SessionStatusEntry> = new Map();
let cachedBackgroundRev = -1;
let backgroundRev = 0;

function statusToEntry(record: BackgroundStatusRecord): SessionStatusEntry {
  const { status, blockedOnHuman } = record;
  const isBlockedOnHuman = status === "blocked_on_human";
  return {
    isStreaming: status === "running" || status === "backend_wakeup",
    isWaitingForHuman: status === "awaiting_input",
    isInterrupted: status === "interrupted",
    isBlockedOnHuman,
    ...(isBlockedOnHuman && blockedOnHuman ? { blockedOnHuman } : {}),
  };
}

function notify(): void {
  for (const fn of Array.from(listeners)) {
    try {
      fn();
    } catch {
      // Listener errors shouldn't break others.
    }
  }
}

export function getSessionStatusMap(): Map<string, SessionStatusEntry> {
  if (backgroundRev === cachedBackgroundRev) return cachedSnapshot;
  cachedBackgroundRev = backgroundRev;

  const next = new Map<string, SessionStatusEntry>();
  for (const [sessionId, record] of backgroundStatus) {
    const entry = statusToEntry(record);
    if (
      entry.isStreaming ||
      entry.isWaitingForHuman ||
      entry.isInterrupted ||
      entry.isBlockedOnHuman
    ) {
      next.set(sessionId, entry);
    }
  }
  cachedSnapshot = next;
  return cachedSnapshot;
}

/**
 * Update the cached backend-reported status for a session. Called by the
 * session-index SSE handler whenever the backend announces a transition
 * (or during the initial snapshot on connect).
 */
export function updateBackgroundSessionStatus(
  sessionId: string,
  status: SessionStatus,
  blockedOnHuman?: BlockedOnHumanInfo,
): void {
  const prev = backgroundStatus.get(sessionId);
  // Non-rest states occupy the map. "interrupted" is included so the red
  // indicator persists in the sidebar until the user opens the session.
  // "blocked_on_human" persists too — losing it from the map would silently
  // drop the warning indicator.
  if (
    status === "running" ||
    status === "backend_wakeup" ||
    status === "awaiting_input" ||
    status === "interrupted" ||
    status === "blocked_on_human"
  ) {
    const nextRecord: BackgroundStatusRecord =
      status === "blocked_on_human"
        ? { status, blockedOnHuman }
        : { status };
    if (
      prev?.status === nextRecord.status &&
      prev.blockedOnHuman === nextRecord.blockedOnHuman
    ) {
      return;
    }
    backgroundStatus.set(sessionId, nextRecord);
  } else {
    if (!prev) return;
    backgroundStatus.delete(sessionId);
  }
  backgroundRev += 1;
  notify();
}

export function removeBackgroundSessionStatus(sessionId: string): void {
  if (!backgroundStatus.has(sessionId)) return;
  backgroundStatus.delete(sessionId);
  backgroundRev += 1;
  notify();
}

export function clearAllBackgroundSessionStatuses(): void {
  if (backgroundStatus.size === 0) return;
  backgroundStatus.clear();
  backgroundRev += 1;
  notify();
}

export function getRawBackgroundStatus(
  sessionId: string,
): SessionStatus | undefined {
  return backgroundStatus.get(sessionId)?.status;
}

/**
 * Legacy compatibility shims — kept so any older call sites don't break.
 */
export function setSessionStatus(_sessionId: string, _entry: SessionStatusEntry) {}
export function clearSessionStatus(sessionId: string) {
  removeBackgroundSessionStatus(sessionId);
}

export function subscribeSessionStatus(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
