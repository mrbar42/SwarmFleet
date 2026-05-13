/**
 * Per-provider rate-limit status snapshots.
 *
 * The Claude Agent SDK emits `rate_limit_event` messages over the session
 * stream. They are operational metadata — not chat content — and each event
 * overwrites the previous snapshot for that provider. We persist the latest
 * snapshot per provider to localStorage so a reload doesn't erase the most
 * recent reading.
 *
 * Aging is handled at render time by the consumer: entries 1–2h old render
 * grayed out; entries older than 2h are hidden (and pruned on load).
 */

const STORAGE_KEY = "swarmfleet-rate-limit-status";
const MAX_AGE_MS = 2 * 60 * 60 * 1000; // 2h — older entries are dropped

export interface RateLimitSnapshot {
  /** Raw event payload as delivered by the provider. Shape is provider-specific. */
  data: Record<string, unknown>;
  /** Wall-clock time we received the event, ms since epoch. */
  receivedAt: number;
}

export type RateLimitEntries = Record<string, RateLimitSnapshot>;

type Listener = () => void;

const listeners = new Set<Listener>();
let entries: RateLimitEntries = loadFromStorage();

function loadFromStorage(): RateLimitEntries {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const now = Date.now();
    const out: RateLimitEntries = {};
    for (const [provider, value] of Object.entries(parsed)) {
      if (!value || typeof value !== "object") continue;
      const v = value as { data?: unknown; receivedAt?: unknown };
      if (typeof v.receivedAt !== "number") continue;
      if (now - v.receivedAt > MAX_AGE_MS) continue;
      if (!v.data || typeof v.data !== "object") continue;
      out[provider] = {
        data: v.data as Record<string, unknown>,
        receivedAt: v.receivedAt,
      };
    }
    return out;
  } catch {
    return {};
  }
}

function persist(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // Best-effort — storage can be full or disabled.
  }
}

function notify(): void {
  for (const fn of Array.from(listeners)) {
    try {
      fn();
    } catch {
      // One listener's failure must not stop the others.
    }
  }
}

export function getRateLimitEntries(): RateLimitEntries {
  return entries;
}

export function recordRateLimit(
  provider: string,
  data: Record<string, unknown>,
  receivedAt: number = Date.now(),
): void {
  // Guard: if we already have a snapshot that is newer than this one (common
  // during history replay of an old error after a fresh rate_limit_event has
  // landed on reload), ignore the older incoming data.
  const existing = entries[provider];
  if (existing && existing.receivedAt > receivedAt) return;

  entries = { ...entries, [provider]: { data, receivedAt } };
  persist();
  notify();
}

export function subscribeRateLimitStatus(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
