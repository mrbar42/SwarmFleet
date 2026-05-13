import { create } from "zustand";
import {
  createJSONStorage,
  persist,
  subscribeWithSelector,
} from "zustand/middleware";

export type ConnectionState =
  | "connecting"
  | "reconnecting"
  | "live"
  | "offline";

export interface StreamConnectionSnapshot {
  key: string;
  readyState: number;
  lastEventAt: number | null;
  reconnecting: boolean;
  disconnectedAt: number | null;
}

interface ConnectionStateStore {
  streams: Record<string, StreamConnectionSnapshot>;
  lastStreamVersions: Record<string, number>;
}

interface PersistedConnectionState {
  lastStreamVersions: Record<string, number>;
}

const READY_STATE_CONNECTING = 0;
const READY_STATE_OPEN = 1;
const READY_STATE_CLOSED = 2;
const OFFLINE_GRACE_MS = 60_000;

export const INDEX_STREAM_KEY = "index";
const offlineTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function sessionStreamKey(sessionId: string): string {
  return `session:${sessionId}`;
}

export const useConnectionStateStore = create<ConnectionStateStore>()(
  persist(
    subscribeWithSelector(() => ({
      streams: {},
      lastStreamVersions: {},
    })),
    {
      name: "swarmfleet-stream-versions",
      storage: createJSONStorage(() => localStorage),
      partialize: (state): PersistedConnectionState => ({
        lastStreamVersions: state.lastStreamVersions,
      }),
      merge: (persisted, current) => ({
        ...current,
        lastStreamVersions:
          (persisted as Partial<PersistedConnectionState> | undefined)
            ?.lastStreamVersions ?? {},
      }),
    },
  ),
);

function parseLastEventId(lastEventId: string): number | null {
  if (!lastEventId) return null;
  const parsed = Number.parseInt(lastEventId, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export function getConnectionState(
  snapshot: StreamConnectionSnapshot | undefined,
): ConnectionState {
  if (!snapshot) return "connecting";
  if (
    snapshot.reconnecting &&
    (snapshot.disconnectedAt === null ||
      Date.now() - snapshot.disconnectedAt < OFFLINE_GRACE_MS)
  ) {
    return "reconnecting";
  }
  if (snapshot.readyState === READY_STATE_CONNECTING) return "connecting";
  if (snapshot.readyState === READY_STATE_CLOSED) return "offline";
  if (snapshot.readyState !== READY_STATE_OPEN) return "offline";
  return "live";
}

export function getOverallConnectionState(): ConnectionState {
  const streams = Object.values(useConnectionStateStore.getState().streams);
  if (streams.length === 0) return "connecting";
  const states = streams.map((stream) => getConnectionState(stream));
  if (states.includes("reconnecting")) return "reconnecting";
  if (states.includes("offline")) return "offline";
  if (states.includes("connecting")) return "connecting";
  return "live";
}

export function getLastStreamVersion(key: string): number | undefined {
  return useConnectionStateStore.getState().lastStreamVersions[key];
}

export function setStreamReadyState(
  key: string,
  readyState: number,
  options: { reconnecting?: boolean } = {},
): void {
  const previous = useConnectionStateStore.getState().streams[key];
  const reconnecting =
    options.reconnecting ??
    (readyState === READY_STATE_CONNECTING &&
      previous?.lastEventAt !== null &&
      previous?.lastEventAt !== undefined);
  const disconnectedAt =
    reconnecting || readyState === READY_STATE_CLOSED
      ? (previous?.disconnectedAt ?? Date.now())
      : null;

  scheduleOfflineTransition(key, disconnectedAt, reconnecting);

  useConnectionStateStore.setState((state) => ({
    streams: {
      ...state.streams,
      [key]: {
        key,
        readyState,
        lastEventAt: previous?.lastEventAt ?? null,
        reconnecting,
        disconnectedAt,
      },
    },
  }));
}

export function markStreamEvent(
  key: string,
  readyState: number,
  lastEventId?: string,
): void {
  clearOfflineTimer(key);
  const version = parseLastEventId(lastEventId ?? "");
  useConnectionStateStore.setState((state) => ({
    streams: {
      ...state.streams,
      [key]: {
        key,
        readyState,
        lastEventAt: Date.now(),
        reconnecting: false,
        disconnectedAt: null,
      },
    },
    lastStreamVersions:
      version === null
        ? state.lastStreamVersions
        : {
            ...state.lastStreamVersions,
            [key]: version,
          },
  }));
}

export function clearStreamConnection(key: string): void {
  clearOfflineTimer(key);
  useConnectionStateStore.setState((state) => {
    const next = { ...state.streams };
    delete next[key];
    return { streams: next };
  });
}

function scheduleOfflineTransition(
  key: string,
  disconnectedAt: number | null,
  reconnecting: boolean,
): void {
  clearOfflineTimer(key);
  if (!reconnecting || disconnectedAt === null) {
    return;
  }

  const remaining = Math.max(
    0,
    OFFLINE_GRACE_MS - (Date.now() - disconnectedAt),
  );
  offlineTimers.set(
    key,
    setTimeout(() => {
      offlineTimers.delete(key);
      useConnectionStateStore.setState((state) => {
        const current = state.streams[key];
        if (!current || !current.reconnecting) {
          return state;
        }
        return {
          streams: {
            ...state.streams,
            [key]: {
              ...current,
              readyState: READY_STATE_CLOSED,
              reconnecting: false,
            },
          },
        };
      });
    }, remaining),
  );
}

function clearOfflineTimer(key: string): void {
  const timer = offlineTimers.get(key);
  if (timer) {
    clearTimeout(timer);
    offlineTimers.delete(key);
  }
}
