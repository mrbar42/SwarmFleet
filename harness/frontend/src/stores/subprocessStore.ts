import { useSyncExternalStore } from "react";
import type { SubprocessEntry, SubprocessUpdate } from "@shared/types";

type Listener = () => void;

interface DisplayableCacheEntry {
  source: SubprocessEntry[];
  value: SubprocessEntry[];
}

const subprocessMap = new Map<string, SubprocessEntry[]>();
const displayableCache = new Map<string, DisplayableCacheEntry>();
const listeners = new Set<Listener>();

let rev = 0;
let cachedRev = -1;
let cachedSnapshot: Map<string, SubprocessEntry[]> = new Map();

function notify(): void {
  for (const fn of Array.from(listeners)) {
    try {
      fn();
    } catch {
      // Listener errors shouldn't break others.
    }
  }
}

function getSnapshot(): Map<string, SubprocessEntry[]> {
  if (rev === cachedRev) return cachedSnapshot;
  cachedRev = rev;
  cachedSnapshot = new Map(subprocessMap);
  return cachedSnapshot;
}

function subprocessEntriesEqual(
  a: SubprocessEntry[] | undefined,
  b: SubprocessEntry[],
): boolean {
  if (!a || a.length !== b.length) return false;
  return a.every((entry, index) => {
    const other = b[index];
    return (
      entry.pid === other.pid &&
      entry.ppid === other.ppid &&
      entry.command === other.command &&
      entry.startedAt === other.startedAt &&
      entry.displayable === other.displayable
    );
  });
}

function getDisplayableSubprocesses(
  sessionId: string | null,
): SubprocessEntry[] {
  if (!sessionId) return EMPTY;
  const entries = getSnapshot().get(sessionId);
  if (!entries) return EMPTY;

  const cached = displayableCache.get(sessionId);
  if (cached?.source === entries) return cached.value;

  const filtered = entries.filter((e) => e.displayable);
  const value = subprocessEntriesEqual(cached?.value, filtered)
    ? (cached?.value ?? EMPTY)
    : filtered.length > 0
      ? filtered
      : EMPTY;

  displayableCache.set(sessionId, { source: entries, value });
  return value;
}

export function applySubprocessUpdate(update: SubprocessUpdate): void {
  const previous = subprocessMap.get(update.sessionId);
  if (subprocessEntriesEqual(previous, update.processes)) return;

  subprocessMap.set(update.sessionId, update.processes);
  displayableCache.delete(update.sessionId);
  rev += 1;
  notify();
}

export function clearSession(sessionId: string): void {
  if (!subprocessMap.has(sessionId)) return;
  subprocessMap.delete(sessionId);
  displayableCache.delete(sessionId);
  rev += 1;
  notify();
}

function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function useSubprocessCount(sessionId: string | null): number {
  return useSyncExternalStore(
    subscribe,
    () => getDisplayableSubprocesses(sessionId).length,
  );
}

export function useSubprocesses(sessionId: string | null): SubprocessEntry[] {
  return useSyncExternalStore(subscribe, () =>
    getDisplayableSubprocesses(sessionId),
  );
}

// Stable empty array to avoid unnecessary re-renders.
const EMPTY: SubprocessEntry[] = [];
