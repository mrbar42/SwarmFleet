import type { ConversationHistory } from "@shared/types";

import type { AllMessage } from "../types";

const DB_NAME = "swarmfleet-session-history-cache";
const DB_VERSION = 1;
const STORE_NAME = "recentHistory";
const CACHE_VERSION = 1;
const MAX_CACHE_MESSAGES = 200;

export interface SessionHistoryCacheEntry {
  version: number;
  key: string;
  projectPath: string;
  sessionId: string;
  cachedAt: number;
  messages: AllMessage[];
  historyMetadata: {
    sessionId: string;
    metadata: ConversationHistory["metadata"];
  } | null;
  historyPage: ConversationHistory["page"] | null;
}

interface PersistableSessionHistory {
  projectPath: string | null;
  sessionId: string | null;
  messages: AllMessage[];
  historyMetadata: SessionHistoryCacheEntry["historyMetadata"];
  historyPage: ConversationHistory["page"] | null;
}

function canUseIndexedDb(): boolean {
  return typeof indexedDB !== "undefined";
}

export function getSessionHistoryCacheKey(
  projectPath: string,
  sessionId: string,
): string {
  return `${projectPath}::${sessionId}`;
}

function openCacheDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!canUseIndexedDb()) {
      reject(new Error("IndexedDB is not available"));
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: "key" });
        store.createIndex("cachedAt", "cachedAt");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Failed to open cache"));
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openCacheDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, mode);
      const request = run(transaction.objectStore(STORE_NAME));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("Cache request failed"));
      transaction.onerror = () =>
        reject(transaction.error ?? new Error("Cache transaction failed"));
    });
  } finally {
    db.close();
  }
}

export async function readSessionHistoryCache(
  projectPath: string,
  sessionId: string,
): Promise<SessionHistoryCacheEntry | null> {
  try {
    const key = getSessionHistoryCacheKey(projectPath, sessionId);
    const entry = await withStore<SessionHistoryCacheEntry | undefined>(
      "readonly",
      (store) => store.get(key),
    );
    if (!entry || entry.version !== CACHE_VERSION) return null;
    if (entry.projectPath !== projectPath || entry.sessionId !== sessionId) return null;
    return entry;
  } catch {
    return null;
  }
}

export async function writeSessionHistoryCache(
  entry: Omit<SessionHistoryCacheEntry, "version" | "key" | "cachedAt">,
): Promise<void> {
  try {
    if (!entry.projectPath || !entry.sessionId || entry.messages.length === 0) return;
    const messages = entry.messages.slice(-MAX_CACHE_MESSAGES);
    const key = getSessionHistoryCacheKey(entry.projectPath, entry.sessionId);
    await withStore<IDBValidKey>("readwrite", (store) =>
      store.put({
        ...entry,
        key,
        version: CACHE_VERSION,
        cachedAt: Date.now(),
        messages,
      } satisfies SessionHistoryCacheEntry),
    );
  } catch {
    // Cache is an optimization only. Never break chat if storage is unavailable.
  }
}

export function persistSessionHistorySnapshot(
  state: PersistableSessionHistory,
): void {
  if (!state.projectPath || !state.sessionId || state.messages.length === 0) return;
  void writeSessionHistoryCache({
    projectPath: state.projectPath,
    sessionId: state.sessionId,
    messages: state.messages,
    historyMetadata: state.historyMetadata,
    historyPage: state.historyPage,
  });
}
