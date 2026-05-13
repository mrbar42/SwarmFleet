import type { ConversationSummary, SessionMetadata } from "@shared/types";
import { getHistoriesUrl } from "../config/api";
import { useAppStore } from "./appStore";
import { updateBackgroundSessionStatus } from "./sessionStatus";
import { applyServerUnreadBoundary } from "./unreadSessions";

type Listener = () => void;

const fetching = new Set<string>();
const DEFAULT_PREVIEW = "No preview available";

function metadataToSummary(session: SessionMetadata): ConversationSummary {
  return {
    sessionId: session.sessionId,
    title: session.title,
    startTime: new Date(session.createdAt).toISOString(),
    lastTime: new Date(session.updatedAt).toISOString(),
    provider: session.provider,
    messageCount: session.messageCount,
    lastMessagePreview: session.lastMessagePreview || DEFAULT_PREVIEW,
    status: session.status,
    sourceKind: session.sourceKind,
    kind: session.kind ?? "chat",
    parentSessionId: session.parentSessionId ?? null,
    parentToolUseId: session.parentToolUseId ?? null,
    armedWakeup: session.armedWakeup ?? null,
    activeLoop: session.activeLoop ?? null,
    unreadBoundary:
      session.status === "running" ||
      session.status === "backend_wakeup" ||
      session.armedWakeup ||
      session.updatedAt <= session.lastReadAt
        ? null
        : session.lastReadAt,
  };
}

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

export function getSessionsMap(): Map<string, ConversationSummary[]> {
  return useAppStore.getState().sessionIndex;
}

export function subscribeSessions(fn: Listener): () => void {
  return useAppStore.subscribe((state) => state.sessionIndex, () => fn());
}

export function fetchSessions(
  projectPath: string,
  _encodedName: string,
  force = false,
): Promise<ConversationSummary[]> {
  const { sessionIndex, updateSessionIndex } = useAppStore.getState();

  if (!force && sessionIndex.has(projectPath)) {
    return Promise.resolve(sessionIndex.get(projectPath) ?? []);
  }
  if (fetching.has(projectPath)) {
    return Promise.resolve(sessionIndex.get(projectPath) ?? []);
  }

  fetching.add(projectPath);

  return fetch(getHistoriesUrl(projectPath))
    .then((res) => (res.ok ? res.json() : { conversations: [] }))
    .then((data) => {
      fetching.delete(projectPath);
      const conversations = ((data.conversations ?? []) as ConversationSummary[]).slice(0, 20);
      updateSessionIndex(projectPath, conversations);
      // Reconcile the live-status cache against the fetched summaries. This
      // clears stale "running" spinners if a terminal session-status SSE frame
      // was missed but the authoritative session list already reflects rest.
      for (const conversation of conversations) {
        updateBackgroundSessionStatus(
          conversation.sessionId,
          conversation.status ?? "idle",
        );
        applyServerUnreadBoundary(
          conversation.sessionId,
          conversation.unreadBoundary,
        );
      }
      return conversations;
    })
    .catch(() => {
      fetching.delete(projectPath);
      return useAppStore.getState().sessionIndex.get(projectPath) ?? [];
    });
}

export function isFetchingSessions(projectPath: string): boolean {
  return fetching.has(projectPath);
}

export function updateSessionTitle(sessionId: string, title: string): void {
  useAppStore.getState().updateSessionTitle(sessionId, title);
}

export function removeSession(sessionId: string): void {
  useAppStore.getState().removeSession(sessionId);
}

export function clearProjectSessions(projectPath: string): void {
  useAppStore.getState().clearProjectSessions(projectPath);
}

export function insertCreatedSession(
  projectPath: string,
  session: SessionMetadata,
): void {
  const state = useAppStore.getState();
  const existing = state.sessionIndex.get(projectPath);
  if (!existing) return;

  const incoming = metadataToSummary(session);
  const withoutDup = existing.filter(
    (entry) => entry.sessionId !== incoming.sessionId,
  );
  state.updateSessionIndex(projectPath, insertByKind(withoutDup, incoming));
  updateBackgroundSessionStatus(session.sessionId, session.status ?? "idle");
  applyServerUnreadBoundary(session.sessionId, incoming.unreadBoundary);
}
