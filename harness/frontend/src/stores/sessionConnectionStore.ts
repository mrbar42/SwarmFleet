import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import { shallow } from "zustand/shallow";
import { getSessionStreamUrl } from "../config/api";
import type {
  QueueSnapshot,
  SessionEvent,
  SessionStatusSnapshot,
} from "@shared/types";
import {
  processStatusEventData,
  processSessionEventData,
  processQueueEventData,
  processStreamPayload,
  type StreamStoreApi,
} from "../utils/streamProcessor";
import {
  clearStreamConnection,
  getLastStreamVersion,
  markStreamEvent,
  sessionStreamKey,
  setStreamReadyState,
} from "./connectionStateStore";

export type SessionConnectionStatus =
  | "connecting"
  | "open"
  | "closed"
  | "error";

export interface SessionConnectionSnapshot {
  sessionId: string;
  url: string;
  status: SessionConnectionStatus;
  readyState: number;
  lastEventAt: number | null;
  lastError: string | null;
}

interface TrackedListener {
  event: string;
  handler: EventListenerOrEventListenerObject;
}

interface ManagedSessionConnection extends SessionConnectionSnapshot {
  eventSource: EventSource;
  storeApi: StreamStoreApi;
  listeners: TrackedListener[];
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  retryAttempt: number;
}

export interface SessionConnectionStoreState {
  connections: Map<string, SessionConnectionSnapshot>;
}

const managedConnections = new Map<string, ManagedSessionConnection>();
const MAX_RECONNECT_DELAY_MS = 60_000;
const BASE_RECONNECT_DELAY_MS = 1_000;

function getEventSourceConstructor(): typeof EventSource {
  if (typeof EventSource === "undefined") {
    throw new Error("EventSource is not available in this environment");
  }
  return EventSource;
}

function parseEventData(data: string): unknown {
  try {
    return JSON.parse(data);
  } catch (err) {
    console.warn(
      "[sessionConnectionStore] Failed to parse event data as JSON, returning raw string:",
      err,
      data.slice(0, 200),
    );
    return data;
  }
}

function syncStore(): void {
  const snapshot = new Map<string, SessionConnectionSnapshot>();
  for (const [sessionId, connection] of managedConnections.entries()) {
    snapshot.set(sessionId, {
      sessionId,
      url: connection.url,
      status: connection.status,
      readyState: connection.readyState,
      lastEventAt: connection.lastEventAt,
      lastError: connection.lastError,
    });
  }
  useSessionConnectionStore.setState({ connections: snapshot });
}

function buildStreamUrl(sessionId: string, lastEventId?: number): string {
  const replayId =
    lastEventId ?? getLastStreamVersion(sessionStreamKey(sessionId));
  const base = getSessionStreamUrl(sessionId);
  if (replayId == null || replayId < 0) {
    return base;
  }

  const url = new URL(base, window.location.origin);
  url.searchParams.set("lastEventId", String(replayId));
  return `${url.pathname}${url.search}`;
}

function attachHandlers(connection: ManagedSessionConnection): void {
  const { eventSource } = connection;
  const EventSourceCtor = getEventSourceConstructor();

  const touch = () => {
    connection.lastEventAt = Date.now();
    connection.readyState = eventSource.readyState;
    markStreamEvent(
      sessionStreamKey(connection.sessionId),
      eventSource.readyState,
    );
    syncStore();
  };

  const addTrackedListener = (
    event: string,
    handler: (event: Event) => void,
  ) => {
    eventSource.addEventListener(event, handler);
    connection.listeners.push({ event, handler });
  };

  addTrackedListener("open", () => {
    connection.retryAttempt = 0;
    connection.status = "open";
    connection.lastError = null;
    connection.readyState = eventSource.readyState;
    setStreamReadyState(
      sessionStreamKey(connection.sessionId),
      eventSource.readyState,
    );
    syncStore();
  });

  addTrackedListener("error", () => {
    connection.status =
      eventSource.readyState === EventSourceCtor.CLOSED ? "closed" : "error";
    connection.lastError = `Session stream error for ${connection.sessionId}`;
    connection.readyState = eventSource.readyState;
    setStreamReadyState(
      sessionStreamKey(connection.sessionId),
      connection.readyState,
      {
        reconnecting: connection.readyState !== EventSourceCtor.OPEN,
      },
    );
    syncStore();
    if (connection.readyState !== EventSourceCtor.OPEN) {
      scheduleSessionReopen(connection);
    }
  });

  const handleStream = (event: Event) => {
    const messageEvent = event as MessageEvent<string>;
    processStreamPayload(
      parseEventData(messageEvent.data),
      connection.storeApi,
    );
    markStreamEvent(
      sessionStreamKey(connection.sessionId),
      eventSource.readyState,
      messageEvent.lastEventId,
    );
    touch();
  };

  const handleSession = (event: Event) => {
    const messageEvent = event as MessageEvent<string>;
    processSessionEventData(
      parseEventData(messageEvent.data) as SessionEvent,
      connection.storeApi,
    );
    markStreamEvent(
      sessionStreamKey(connection.sessionId),
      eventSource.readyState,
      messageEvent.lastEventId,
    );
    touch();
  };

  const handleStatus = (event: Event) => {
    const messageEvent = event as MessageEvent<string>;
    processStatusEventData(
      parseEventData(messageEvent.data) as SessionStatusSnapshot,
      connection.storeApi,
    );
    markStreamEvent(
      sessionStreamKey(connection.sessionId),
      eventSource.readyState,
      messageEvent.lastEventId,
    );
    touch();
  };

  const handleQueue = (event: Event) => {
    const messageEvent = event as MessageEvent<string>;
    processQueueEventData(
      parseEventData(messageEvent.data) as QueueSnapshot,
      connection.storeApi,
    );
    markStreamEvent(
      sessionStreamKey(connection.sessionId),
      eventSource.readyState,
      messageEvent.lastEventId,
    );
    touch();
  };

  addTrackedListener("message", handleStream);
  addTrackedListener("stream", handleStream);
  addTrackedListener("subprocess", handleStream);
  addTrackedListener("session", handleSession);
  addTrackedListener("status", handleStatus);
  addTrackedListener("queue", handleQueue);
}

function removeTrackedListeners(connection: ManagedSessionConnection): void {
  for (const { event, handler } of connection.listeners) {
    connection.eventSource.removeEventListener(event, handler);
  }
  connection.listeners = [];
}

function getReconnectDelay(retryAttempt: number): number {
  return Math.min(
    MAX_RECONNECT_DELAY_MS,
    BASE_RECONNECT_DELAY_MS * 2 ** retryAttempt,
  );
}

function clearReconnectTimer(connection: ManagedSessionConnection): void {
  if (connection.reconnectTimer) {
    clearTimeout(connection.reconnectTimer);
    connection.reconnectTimer = null;
  }
}

function scheduleSessionReopen(connection: ManagedSessionConnection): void {
  if (connection.reconnectTimer) {
    return;
  }

  const EventSourceCtor = getEventSourceConstructor();
  setStreamReadyState(
    sessionStreamKey(connection.sessionId),
    EventSourceCtor.CONNECTING,
    {
      reconnecting: true,
    },
  );
  connection.status = "error";
  connection.readyState = EventSourceCtor.CONNECTING;
  removeTrackedListeners(connection);
  connection.eventSource.close();

  const delay = getReconnectDelay(connection.retryAttempt);
  connection.retryAttempt += 1;
  connection.reconnectTimer = setTimeout(() => {
    connection.reconnectTimer = null;
    reopenSessionConnection(connection);
  }, delay);
  syncStore();
}

function reopenSessionConnection(connection: ManagedSessionConnection): void {
  if (managedConnections.get(connection.sessionId) !== connection) {
    return;
  }

  const EventSourceCtor = getEventSourceConstructor();
  const url = buildStreamUrl(connection.sessionId);
  connection.url = url;
  connection.status = "connecting";
  connection.readyState = EventSourceCtor.CONNECTING;
  connection.lastError = null;
  connection.eventSource = new EventSourceCtor(url, { withCredentials: true });
  setStreamReadyState(
    sessionStreamKey(connection.sessionId),
    EventSourceCtor.CONNECTING,
    {
      reconnecting: true,
    },
  );
  attachHandlers(connection);
  syncStore();
}

export function openSessionConnection(
  sessionId: string,
  storeApi: StreamStoreApi,
  options: { lastEventId?: number } = {},
): EventSource {
  const existing = managedConnections.get(sessionId);
  if (existing && existing.eventSource.readyState !== EventSource.CLOSED) {
    existing.storeApi = storeApi;
    syncStore();
    return existing.eventSource;
  }

  if (existing) {
    clearReconnectTimer(existing);
    removeTrackedListeners(existing);
    existing.eventSource.close();
    managedConnections.delete(sessionId);
  }

  const EventSourceCtor = getEventSourceConstructor();
  const url = buildStreamUrl(sessionId, options.lastEventId);
  const connection: ManagedSessionConnection = {
    sessionId,
    url,
    status: "connecting",
    readyState: EventSourceCtor.CONNECTING,
    lastEventAt: null,
    lastError: null,
    eventSource: new EventSourceCtor(url, { withCredentials: true }),
    storeApi,
    listeners: [],
    reconnectTimer: null,
    retryAttempt: 0,
  };

  managedConnections.set(sessionId, connection);
  setStreamReadyState(sessionStreamKey(sessionId), EventSourceCtor.CONNECTING);
  attachHandlers(connection);
  syncStore();
  return connection.eventSource;
}

export function closeSessionConnection(sessionId: string): void {
  const connection = managedConnections.get(sessionId);
  if (!connection) {
    return;
  }
  connection.status = "closed";
  clearReconnectTimer(connection);
  removeTrackedListeners(connection);
  connection.eventSource.close();
  managedConnections.delete(sessionId);
  clearStreamConnection(sessionStreamKey(sessionId));
  syncStore();
}

export function closeOtherSessionConnections(activeSessionId: string): void {
  for (const sessionId of managedConnections.keys()) {
    if (sessionId !== activeSessionId) {
      closeSessionConnection(sessionId);
    }
  }
}

export function closeAllSessionConnections(): void {
  for (const connection of managedConnections.values()) {
    clearReconnectTimer(connection);
    removeTrackedListeners(connection);
    connection.eventSource.close();
    clearStreamConnection(sessionStreamKey(connection.sessionId));
  }
  managedConnections.clear();
  syncStore();
}

export function subscribeSessionConnections(fn: () => void): () => void {
  return useSessionConnectionStore.subscribe(
    (state) => state.connections,
    () => fn(),
    { equalityFn: shallow },
  );
}

export function getSessionConnectionMap(): Map<
  string,
  SessionConnectionSnapshot
> {
  return useSessionConnectionStore.getState().connections;
}

export const useSessionConnectionStore = create<SessionConnectionStoreState>()(
  subscribeWithSelector(() => ({
    connections: new Map<string, SessionConnectionSnapshot>(),
  })),
);
