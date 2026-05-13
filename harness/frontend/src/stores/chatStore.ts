import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import type {
  BlockedOnHumanInfo,
  ChatProvider,
  ConversationHistory,
  SessionKind,
} from "@shared/types";

import type {
  AllMessage,
  ChatMessage,
  CompactMessage,
  LiveSessionPhase,
  PermissionRequestState,
  PermissionMode,
  PlanMessage,
  PlanModeRequestState,
  QueuedMessage,
  SessionMetadata,
  SubagentLaneMessage,
  SessionPhase,
  TimestampedSDKMessage,
} from "../types";
import { isPlanMessage } from "../types";
import {
  getConversationUrl,
  getRenameSessionUrl,
  getSessionAbortUrl,
  getSessionUrl,
} from "../config/api";
import {
  STORAGE_KEYS,
  getStorageItem,
  setStorageItem,
  removeStorageItem,
} from "../utils/storage";
import { convertConversationHistory } from "../utils/messageConversion";
import {
  persistSessionHistorySnapshot,
  readSessionHistoryCache,
  writeSessionHistoryCache,
} from "../utils/sessionHistoryCache";
import { generateId } from "../utils/id";
import { normalizeWindowsPath } from "../utils/pathUtils";
import {
  closeAllSessionConnections,
  closeOtherSessionConnections,
  openSessionConnection,
} from "./sessionConnectionStore";
import { fetchSessions } from "./sessions";
import type { StreamStoreApi } from "../utils/streamProcessor";

type PermissionRequest = PermissionRequestState & { isOpen: boolean };
type PlanModeRequest = PlanModeRequestState & { isOpen: boolean };
const HISTORY_PAGE_SIZE = 80;
const HISTORY_LOAD_RETRY_DELAYS_MS = [250, 750, 1500];

interface SessionHistoryMetadata {
  sessionId: string;
  metadata: ConversationHistory["metadata"];
}

export interface ChatStoreState {
  // Session identity and request metadata.
  sessionId: string | null;
  projectPath: string | null;
  projectEncodedName: string | null;
  requestId: string | null;
  phase: SessionPhase;

  // Messages.
  messages: AllMessage[];
  currentAssistantMessage: ChatMessage | null;

  // Pending message queue — messages typed while the agent is running that
  // will auto-dispatch when the current turn ends. Kept in sync with the
  // server via SSE "queue" events so every open device sees the same list.
  queuedMessages: QueuedMessage[];

  // Draft input and conversation preferences.
  input: string;
  model: string;
  effort: string;
  showBackgroundActivity: boolean;

  // Provider lock. When a session exists on the server, this is the provider
  // it was created with; the user can only pick models from the same provider
  // for the rest of the session. `null` means no
  // session yet (new chat) — any provider is still available.
  sessionProvider: ChatProvider | null;
  sessionKind: SessionKind | null;

  // Permissions.
  allowedTools: string[];
  permissionMode: PermissionMode;
  permissionRequest: PermissionRequest | null;
  planModeRequest: PlanModeRequest | null;

  // Paused for human review. Set when the active session reports status
  // `blocked_on_human`; cleared when the backend transitions out of that state.
  blockedOnHuman: BlockedOnHumanInfo | null;

  // History/session metadata.
  historyLoading: boolean;
  historyError: string | null;
  sessionNotFound: boolean;
  streamError: string | null;
  preserveBlankSession: boolean;
  hasReceivedInit: boolean;
  hasShownInitMessage: boolean;
  sessionTitle: string | null;
  historyMetadata: SessionHistoryMetadata | null;
  historyPage: ConversationHistory["page"] | null;
  olderHistoryLoading: boolean;
  olderHistoryError: string | null;
  lastUpdatedAt: number | null;
  lastHydratedSessionKey: string | null;
  inputDraftKey: string | null;
  newSessionDraftSlotId: string | null;

  // Session lifecycle.
  setProjectContext: (
    projectPath: string | null,
    projectEncodedName?: string | null,
  ) => void;
  setProjectPath: (projectPath: string | null) => void;
  loadSession: (
    projectPath: string,
    sessionId: string,
    projectEncodedName?: string | null,
  ) => Promise<void>;
  loadOlderHistory: () => Promise<void>;
  startNewSession: () => void;
  setSessionId: (sessionId: string | null) => void;
  applyLivePhase: (
    phase: LiveSessionPhase,
    sessionId?: string | null,
    blockedOnHuman?: BlockedOnHumanInfo | null,
  ) => void;
  orchestrateSession: (
    projectPath: string,
    sessionId: string | null,
    encodedName: string | null,
  ) => void;

  // Streaming.
  generateRequestId: () => string;
  beginStream: (requestId: string) => void;
  appendAssistantContent: (content: string) => void;
  addMessage: (message: AllMessage) => void;
  updateLastMessage: (content: string) => void;
  completeSubagentLane: (
    toolUseId: string,
    result: string,
    completedAt?: number,
  ) => void;
  failSubagentLane: (
    toolUseId: string,
    error: string,
    completedAt?: number,
  ) => void;
  attachSubagentIdToLane: (toolUseId: string, subagentId: string) => void;
  completeSubagentLaneBySubagentId: (
    subagentId: string,
    result: string,
    completedAt?: number,
  ) => void;
  failSubagentLaneBySubagentId: (
    subagentId: string,
    error: string,
    completedAt?: number,
  ) => void;
  updateLastCompactMessage: (updates: Partial<CompactMessage>) => void;
  finalizeAssistantMessage: () => void;
  endStream: (sessionId?: string) => void;
  resetRequestState: () => void;
  startRequest: () => string;

  // Permissions and plan requests.
  requestPermission: (
    toolName: string,
    patterns: string[],
    toolUseId: string,
  ) => void;
  resolvePermission: (allowedTools: string[]) => void;
  requestPlanApproval: (content: string, toolUseId?: string) => void;
  resolvePlanApproval: () => void;
  setPermissionMode: (mode: PermissionMode) => void;

  // Draft/preferences.
  setInput: (input: string) => void;
  clearInput: () => void;
  setModel: (model: string) => void;
  setEffort: (effort: string) => void;
  setShowBackgroundActivity: (show: boolean) => void;

  // Error/title updates.
  setError: (error: string) => void;
  abortStream: () => Promise<void>;
  updateSessionTitle: (sessionId: string, title: string) => Promise<void>;

  setQueuedMessages: (queued: QueuedMessage[]) => void;

  // Compatibility helpers for current processor wiring.
  setCurrentAssistantMessage: (message: ChatMessage | null) => void;
  setHasReceivedInit: (received: boolean) => void;
  setHasShownInitMessage: (shown: boolean) => void;
  setMessages: (messages: AllMessage[]) => void;
}

const DEFAULT_MODEL = "claude-sonnet-4-6";
const DEFAULT_EFFORT = "auto";
const EFFORT_STORAGE_PREFIX = "swarmfleet-webui-effort:";
const ACTIVE_SESSION_STORAGE_KEY = "swarmfleet-active-session";
const DRAFT_STORAGE_PREFIX = "swarmfleet-webui-draft:";

let historyLoadToken = 0;

function mapLivePhaseToUiPhase(
  phase: LiveSessionPhase,
  hasSession: boolean,
): SessionPhase {
  switch (phase) {
    case "running":
    case "backend_wakeup":
      return "streaming";
    case "awaiting_input":
    case "blocked_on_human":
      // Both states pause the agent until human action. The UI only needs to
      // know it's parked, not why; the dedicated banner/store field carries
      // the blocked-on-human reason.
      return "awaiting-permission";
    case "error":
    case "interrupted":
      return "error";
    case "idle":
    default:
      return hasSession ? "ready" : "idle";
  }
}

function canUseSessionStorage(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.sessionStorage !== "undefined"
  );
}

function readActiveSessionId(): string | null {
  if (!canUseSessionStorage()) return null;
  try {
    return window.sessionStorage.getItem(ACTIVE_SESSION_STORAGE_KEY);
  } catch {
    return null;
  }
}

function persistActiveSessionId(sessionId: string | null): void {
  if (!canUseSessionStorage()) return;
  try {
    if (sessionId) {
      window.sessionStorage.setItem(ACTIVE_SESSION_STORAGE_KEY, sessionId);
    } else {
      window.sessionStorage.removeItem(ACTIVE_SESSION_STORAGE_KEY);
    }
  } catch {
    // Ignore storage failures.
  }
}

function getProjectPreferenceKey(projectPath: string, prefix: string): string {
  return `${prefix}${normalizeWindowsPath(projectPath)}`;
}

function getDraftKey(
  projectPath: string | null,
  sessionId: string | null,
  newSessionDraftSlotId?: string | null,
): string | null {
  if (!projectPath) return null;
  const draftSlot = sessionId ?? `new:${newSessionDraftSlotId ?? "default"}`;
  return `${DRAFT_STORAGE_PREFIX}${normalizeWindowsPath(projectPath)}::${draftSlot}`;
}

function readDraftWithKey(
  projectPath: string | null,
  sessionId: string | null,
  newSessionDraftSlotId?: string | null,
): { key: string | null; input: string } {
  const key = getDraftKey(projectPath, sessionId, newSessionDraftSlotId);
  if (!key) return { key: null, input: "" };
  return { key, input: getStorageItem<string>(key, "") };
}

function writeDraft(
  projectPath: string | null,
  sessionId: string | null,
  newSessionDraftSlotId: string | null,
  input: string,
): void {
  const key = getDraftKey(projectPath, sessionId, newSessionDraftSlotId);
  if (!key) return;
  if (input === "") {
    removeStorageItem(key);
  } else {
    setStorageItem(key, input);
  }
}

export function clearChatDraft(
  projectPath: string | null,
  sessionId: string | null,
  newSessionDraftSlotId?: string | null,
): void {
  writeDraft(projectPath, sessionId, newSessionDraftSlotId ?? null, "");
}

function hydrateProjectPreferences(projectPath: string): {
  model: string;
  effort: string;
} {
  return {
    model: getStorageItem(
      getProjectPreferenceKey(projectPath, STORAGE_KEYS.MODEL_PREFIX),
      DEFAULT_MODEL,
    ),
    effort: getStorageItem(
      getProjectPreferenceKey(projectPath, EFFORT_STORAGE_PREFIX),
      DEFAULT_EFFORT,
    ),
  };
}

function isTimestampedSDKMessage(
  message: unknown,
): message is TimestampedSDKMessage {
  return (
    typeof message === "object" &&
    message !== null &&
    "type" in message &&
    "timestamp" in message &&
    typeof (message as { timestamp: unknown }).timestamp === "string"
  );
}

function isAssistantChatMessage(
  message: AllMessage | undefined,
): message is ChatMessage {
  return !!message && message.type === "chat" && message.role === "assistant";
}

function buildAssistantMessage(
  content: string,
  timestamp = Date.now(),
  metadata?: Pick<ChatMessage, "trigger_source" | "visible_to_user">,
): ChatMessage {
  return {
    type: "chat",
    role: "assistant",
    content,
    timestamp,
    ...metadata,
  };
}

function extractConversationMessages(
  conversationHistory: ConversationHistory,
): TimestampedSDKMessage[] {
  if (!Array.isArray(conversationHistory.messages)) return [];
  return conversationHistory.messages.filter(isTimestampedSDKMessage);
}

/**
 * Find the most recent PlanMessage that has no follow-up user message after
 * it — i.e. the plan is still waiting on an approval/pushback. If a user
 * message appears after the plan, the user has already responded and the plan
 * bubble is historical.
 */
function findTrailingPlanMessage(messages: AllMessage[]): PlanMessage | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg.type === "chat" && (msg as ChatMessage).role === "user") {
      return null;
    }
    if (isPlanMessage(msg)) {
      return msg;
    }
  }
  return null;
}

function commitAssistantMessage(
  state: Pick<ChatStoreState, "messages" | "currentAssistantMessage">,
): {
  messages: AllMessage[];
  currentAssistantMessage: ChatMessage | null;
} {
  const current = state.currentAssistantMessage;
  if (!current) {
    return {
      messages: state.messages,
      currentAssistantMessage: null,
    };
  }

  const last = state.messages[state.messages.length - 1];
  const shouldAppend =
    !isAssistantChatMessage(last) || last.content !== current.content;

  return {
    messages: shouldAppend ? [...state.messages, current] : state.messages,
    currentAssistantMessage: null,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}

function shouldRetryHistoryLoad(errorOrResponse: Error | Response): boolean {
  if (errorOrResponse instanceof Response) {
    return (
      errorOrResponse.status === 408 ||
      errorOrResponse.status === 425 ||
      errorOrResponse.status === 429 ||
      errorOrResponse.status >= 500
    );
  }

  return true;
}

async function fetchHistoryResourceWithRetry(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  let lastError: Error | null = null;

  for (
    let attempt = 0;
    attempt <= HISTORY_LOAD_RETRY_DELAYS_MS.length;
    attempt += 1
  ) {
    try {
      const response = await fetch(input, init);
      if (response.ok || !shouldRetryHistoryLoad(response)) {
        return response;
      }
      if (attempt === HISTORY_LOAD_RETRY_DELAYS_MS.length) {
        return response;
      }
    } catch (error) {
      if (error instanceof Error) {
        lastError = error;
      } else {
        lastError = new Error("Failed to load conversation history");
      }
      if (
        !shouldRetryHistoryLoad(lastError) ||
        attempt === HISTORY_LOAD_RETRY_DELAYS_MS.length
      ) {
        throw lastError;
      }
    }

    await sleep(HISTORY_LOAD_RETRY_DELAYS_MS[attempt]);
  }

  throw lastError ?? new Error("Failed to load conversation history");
}

function hasDuplicateStableMessage(
  messages: AllMessage[],
  message: AllMessage,
): boolean {
  if (message.type === "tool" && message.toolUseId) {
    return messages.some(
      (existing) =>
        existing.type === "tool" && existing.toolUseId === message.toolUseId,
    );
  }

  if (message.type === "tool_result" && message.toolUseId) {
    return messages.some(
      (existing) =>
        existing.type === "tool_result" &&
        existing.toolUseId === message.toolUseId,
    );
  }

  if (message.type === "plan" && message.toolUseId) {
    return messages.some(
      (existing) =>
        existing.type === "plan" && existing.toolUseId === message.toolUseId,
    );
  }

  if (message.type === "subagent_lane" && message.toolUseId) {
    return messages.some(
      (existing) =>
        existing.type === "subagent_lane" &&
        existing.toolUseId === message.toolUseId,
    );
  }

  if (message.type === "image" && message.asset?.assetId) {
    return messages.some(
      (existing) =>
        existing.type === "image" &&
        existing.asset.assetId === message.asset.assetId,
    );
  }

  return false;
}

let sessionHistoryPersistTimer: ReturnType<typeof setTimeout> | null = null;

function flushSessionHistoryCache(): void {
  if (sessionHistoryPersistTimer !== null) {
    clearTimeout(sessionHistoryPersistTimer);
    sessionHistoryPersistTimer = null;
  }
  persistSessionHistorySnapshot(useChatStore.getState());
}

function scheduleSessionHistoryCacheWrite(): void {
  if (typeof window === "undefined") return;
  if (sessionHistoryPersistTimer !== null) {
    clearTimeout(sessionHistoryPersistTimer);
  }
  sessionHistoryPersistTimer = setTimeout(() => {
    sessionHistoryPersistTimer = null;
    persistSessionHistorySnapshot(useChatStore.getState());
  }, 350);
}

export const useChatStore = create<ChatStoreState>()(
  subscribeWithSelector((set, get) => ({
    sessionId: readActiveSessionId(),
    projectPath: null,
    projectEncodedName: null,
    requestId: null,
    phase: "idle",

    messages: [],
    currentAssistantMessage: null,
    queuedMessages: [],

    input: "",
    model: DEFAULT_MODEL,
    effort: DEFAULT_EFFORT,
    showBackgroundActivity: false,

    allowedTools: [],
    permissionMode: "default",
    permissionRequest: null,
    planModeRequest: null,
    blockedOnHuman: null,

    historyLoading: false,
    historyError: null,
    sessionNotFound: false,
    streamError: null,
    preserveBlankSession: false,
    hasReceivedInit: false,
    hasShownInitMessage: false,
    sessionTitle: null,
    historyMetadata: null,
    historyPage: null,
    olderHistoryLoading: false,
    olderHistoryError: null,
    lastUpdatedAt: null,
    lastHydratedSessionKey: null,
    inputDraftKey: null,
    newSessionDraftSlotId: null,
    sessionProvider: null,
    sessionKind: null,

    setProjectContext: (projectPath, projectEncodedName) => {
      if (!projectPath) {
        set({
          projectPath: null,
          projectEncodedName: null,
          lastHydratedSessionKey: null,
        });
        return;
      }

      const normalized = normalizeWindowsPath(projectPath);
      const prefs = hydrateProjectPreferences(normalized);
      set({
        projectPath: normalized,
        projectEncodedName: projectEncodedName ?? null,
        model: prefs.model,
        effort: prefs.effort,
        lastHydratedSessionKey: null,
      });
    },

    setProjectPath: (projectPath) => {
      get().setProjectContext(projectPath);
    },

    loadSession: async (projectPath, sessionIdentifier, projectEncodedName) => {
      const normalizedProjectPath = normalizeWindowsPath(projectPath);
      const loadToken = ++historyLoadToken;
      const prefs = hydrateProjectPreferences(normalizedProjectPath);
      const encodedProjectName = projectEncodedName ?? get().projectEncodedName;
      const draft = readDraftWithKey(normalizedProjectPath, sessionIdentifier);
      const cachedHistoryPromise = readSessionHistoryCache(
        normalizedProjectPath,
        sessionIdentifier,
      );

      set({
        projectPath: normalizedProjectPath,
        projectEncodedName: encodedProjectName,
        sessionId: sessionIdentifier,
        requestId: null,
        phase: "loading-history",
        messages: [],
        currentAssistantMessage: null,
        queuedMessages: [],
        historyLoading: true,
        historyError: null,
        sessionNotFound: false,
        streamError: null,
        preserveBlankSession: false,
        allowedTools: [],
        permissionRequest: null,
        planModeRequest: null,
        blockedOnHuman: null,
        hasReceivedInit: false,
        sessionTitle: null,
        historyMetadata: null,
        historyPage: null,
        olderHistoryLoading: false,
        olderHistoryError: null,
        lastUpdatedAt: Date.now(),
        model: prefs.model,
        effort: prefs.effort,
        sessionProvider: null,
        sessionKind: null,
        input: draft.input,
        inputDraftKey: draft.key,
        newSessionDraftSlotId: null,
      });

      cachedHistoryPromise.then((cachedHistory) => {
        const current = get();
        if (
          loadToken !== historyLoadToken ||
          !cachedHistory ||
          !current.historyLoading ||
          current.messages.length > 0
        ) {
          return;
        }
        set({
          messages: cachedHistory.messages,
          historyLoading: false,
          historyError: null,
          historyMetadata: cachedHistory.historyMetadata,
          historyPage: cachedHistory.historyPage,
          olderHistoryLoading: false,
          olderHistoryError: null,
          lastUpdatedAt: Date.now(),
        });
      });

      try {
        const sessionResponse = await fetchHistoryResourceWithRetry(
          getSessionUrl(sessionIdentifier),
        );
        if (!sessionResponse.ok) {
          if (sessionResponse.status === 404) {
            if (loadToken !== historyLoadToken) return;
            set({
              sessionId: null,
              phase: "idle",
              messages: [],
              currentAssistantMessage: null,
              historyLoading: false,
              historyError: null,
              sessionNotFound: true,
              preserveBlankSession: true,
              historyMetadata: null,
              historyPage: null,
              olderHistoryLoading: false,
              olderHistoryError: null,
              sessionTitle: null,
              sessionProvider: null,
              sessionKind: null,
              lastUpdatedAt: Date.now(),
            });
            persistActiveSessionId(null);
            return;
          }
          throw new Error(
            `Failed to resolve session: ${sessionResponse.status} ${sessionResponse.statusText}`,
          );
        }
        const sessionMetadata =
          (await sessionResponse.json()) as SessionMetadata;

        if (loadToken !== historyLoadToken) return;

        const replayLastEventId = sessionMetadata.latestEventId;

        // Provider is locked at session creation on the server. Seed the
        // model from the session-stored value (not local prefs) when it
        // matches the lock, so ChatInput's picker starts in a legal state.
        const storedProvider = sessionMetadata.provider;
        const prefsProviderMatchesLock =
          (prefs.model?.startsWith("codex")
            ? "codex"
            : prefs.model?.startsWith("pi:")
              ? "pi"
              : prefs.model?.startsWith("openrouter-claude:")
                ? "openrouter-claude"
                : prefs.model?.startsWith("hermes:")
                  ? "hermes"
                  : "claude") === storedProvider;
        const seedModel =
          sessionMetadata.model ||
          (prefsProviderMatchesLock ? prefs.model : sessionMetadata.model);

        set({
          sessionId: sessionMetadata.sessionId,
          sessionTitle: sessionMetadata.title,
          permissionMode: sessionMetadata.permissionMode,
          allowedTools: sessionMetadata.allowedTools ?? [],
          model: seedModel,
          effort: sessionMetadata.effort || prefs.effort,
          sessionProvider: storedProvider,
          sessionKind: sessionMetadata.kind,
          phase: mapLivePhaseToUiPhase(sessionMetadata.status, true),
          requestId:
            sessionMetadata.status === "running" ||
            sessionMetadata.status === "backend_wakeup"
              ? sessionMetadata.activeRequestId
              : null,
          blockedOnHuman:
            sessionMetadata.status === "blocked_on_human"
              ? (sessionMetadata.blockedOnHuman ?? null)
              : null,
          lastUpdatedAt: Date.now(),
        });
        persistActiveSessionId(sessionMetadata.sessionId);

        const response = await fetchHistoryResourceWithRetry(
          getConversationUrl(normalizedProjectPath, sessionMetadata.sessionId, {
            limit: HISTORY_PAGE_SIZE,
          }),
        );

        if (loadToken !== historyLoadToken) return;

        if (!response.ok) {
          if (response.status === 404) {
            set({
              historyLoading: false,
              historyError: null,
              messages: [],
              currentAssistantMessage: null,
              historyMetadata: null,
              historyPage: null,
              olderHistoryLoading: false,
              olderHistoryError: null,
              lastUpdatedAt: Date.now(),
            });
            closeOtherSessionConnections(sessionMetadata.sessionId);
            openSessionConnection(
              sessionMetadata.sessionId,
              useChatStore as unknown as StreamStoreApi,
              {
                lastEventId:
                  replayLastEventId >= 0 ? replayLastEventId : undefined,
              },
            );
            return;
          }

          throw new Error(
            `Failed to load conversation history: ${response.status} ${response.statusText}`,
          );
        }

        const conversationHistory =
          (await response.json()) as ConversationHistory;
        const timestampedMessages =
          extractConversationMessages(conversationHistory);
        const messages = convertConversationHistory(timestampedMessages);

        if (loadToken !== historyLoadToken) return;

        // If the session is parked on an ExitPlanMode (status=awaiting_input +
        // trailing plan message), restore the plan approval state so the
        // bubble's Approve button shows after a reload.
        const pendingPlan =
          sessionMetadata.status === "awaiting_input"
            ? findTrailingPlanMessage(messages)
            : null;

        set((state) => ({
          phase:
            state.phase === "loading-history"
              ? mapLivePhaseToUiPhase(sessionMetadata.status, true)
              : state.phase,
          messages,
          currentAssistantMessage: null,
          historyLoading: false,
          historyError: null,
          historyMetadata: {
            sessionId: conversationHistory.sessionId,
            metadata: conversationHistory.metadata,
          },
          historyPage: conversationHistory.page ?? null,
          olderHistoryLoading: false,
          olderHistoryError: null,
          sessionTitle: sessionMetadata.title,
          planModeRequest: pendingPlan
            ? {
                isOpen: true,
                planContent: pendingPlan.plan,
                toolUseId: pendingPlan.toolUseId,
              }
            : null,
          lastUpdatedAt: Date.now(),
        }));
        void writeSessionHistoryCache({
          projectPath: normalizedProjectPath,
          sessionId: conversationHistory.sessionId,
          messages,
          historyMetadata: {
            sessionId: conversationHistory.sessionId,
            metadata: conversationHistory.metadata,
          },
          historyPage: conversationHistory.page ?? null,
        });
        closeOtherSessionConnections(sessionMetadata.sessionId);
        openSessionConnection(
          sessionMetadata.sessionId,
          useChatStore as unknown as StreamStoreApi,
          {
            lastEventId: replayLastEventId >= 0 ? replayLastEventId : undefined,
          },
        );
      } catch (error) {
        if (loadToken !== historyLoadToken) return;

        set({
          phase: "error",
          historyLoading: false,
          historyError:
            error instanceof Error
              ? error.message
              : "Failed to load conversation history",
          lastUpdatedAt: Date.now(),
        });
      }
    },

    loadOlderHistory: async () => {
      const state = get();
      if (
        !state.sessionId ||
        !state.projectPath ||
        state.historyLoading ||
        state.olderHistoryLoading ||
        !state.historyPage?.hasMoreBefore
      ) {
        return;
      }
      const sessionId = state.sessionId;
      const projectPath = state.projectPath;
      const before = state.historyPage.startIndex;
      set({ olderHistoryLoading: true, olderHistoryError: null });
      try {
        const response = await fetchHistoryResourceWithRetry(
          getConversationUrl(projectPath, sessionId, {
            limit: HISTORY_PAGE_SIZE,
            before,
          }),
        );
        if (!response.ok) {
          throw new Error(
            `Failed to load older history: ${response.status} ${response.statusText}`,
          );
        }
        const conversationHistory =
          (await response.json()) as ConversationHistory;
        const timestampedMessages =
          extractConversationMessages(conversationHistory);
        const olderMessages = convertConversationHistory(timestampedMessages);
        const latest = get();
        if (latest.sessionId !== sessionId) return;
        set({
          messages: [...olderMessages, ...latest.messages],
          historyPage: conversationHistory.page ?? latest.historyPage,
          olderHistoryLoading: false,
          olderHistoryError: null,
          lastUpdatedAt: Date.now(),
        });
      } catch (error) {
        if (get().sessionId !== sessionId) return;
        set({
          olderHistoryLoading: false,
          olderHistoryError:
            error instanceof Error
              ? error.message
              : "Failed to load older history",
        });
      }
    },

    startNewSession: () => {
      historyLoadToken++;
      closeAllSessionConnections();
      const currentProjectPath = get().projectPath;
      const newSessionDraftSlotId = generateId();
      const draft = readDraftWithKey(
        currentProjectPath,
        null,
        newSessionDraftSlotId,
      );
      const prefs = currentProjectPath
        ? hydrateProjectPreferences(currentProjectPath)
        : { model: DEFAULT_MODEL, effort: DEFAULT_EFFORT };
      set({
        sessionId: null,
        requestId: null,
        phase: "idle",
        messages: [],
        currentAssistantMessage: null,
        input: draft.input,
        inputDraftKey: draft.key,
        newSessionDraftSlotId,
        model: prefs.model,
        effort: prefs.effort,
        allowedTools: [],
        permissionRequest: null,
        planModeRequest: null,
        blockedOnHuman: null,
        historyLoading: false,
        historyError: null,
        sessionNotFound: false,
        streamError: null,
        preserveBlankSession: true,
        hasReceivedInit: false,
        hasShownInitMessage: false,
        sessionTitle: null,
        historyMetadata: null,
        historyPage: null,
        olderHistoryLoading: false,
        olderHistoryError: null,
        sessionProvider: null,
        sessionKind: null,
        lastUpdatedAt: Date.now(),
        lastHydratedSessionKey: null,
      });
      persistActiveSessionId(null);
    },

    setSessionId: (sessionId) => {
      set((state) => ({
        sessionId,
        inputDraftKey: getDraftKey(
          state.projectPath,
          sessionId,
          state.newSessionDraftSlotId,
        ),
        preserveBlankSession: sessionId ? false : state.preserveBlankSession,
        lastUpdatedAt: Date.now(),
      }));
      persistActiveSessionId(sessionId);
    },

    applyLivePhase: (livePhase, sessionId, blockedOnHuman) => {
      const state = get();
      const resolvedSessionId = sessionId ?? state.sessionId ?? null;
      if (
        livePhase === "idle" &&
        state.phase === "streaming" &&
        state.requestId &&
        resolvedSessionId === state.sessionId
      ) {
        // The per-session SSE emits a snapshot status as soon as it opens.
        // sendMessage opens that stream before the POST marks the new run as
        // running, so an old idle snapshot can arrive after startRequest().
        // Keep the local in-flight request alive; the real terminal state
        // comes from the stream's done/error/aborted event.
        return;
      }
      const isBlocked = livePhase === "blocked_on_human";
      const blockedPayload: BlockedOnHumanInfo | null = isBlocked
        ? (blockedOnHuman ?? state.blockedOnHuman ?? null)
        : null;
      set({
        sessionId: resolvedSessionId,
        phase: mapLivePhaseToUiPhase(livePhase, Boolean(resolvedSessionId)),
        requestId:
          livePhase === "running" || livePhase === "backend_wakeup"
            ? state.requestId
            : null,
        historyLoading: false,
        preserveBlankSession: resolvedSessionId
          ? false
          : state.preserveBlankSession,
        blockedOnHuman: blockedPayload,
        lastUpdatedAt: Date.now(),
      });
      persistActiveSessionId(resolvedSessionId);
    },

    orchestrateSession: (projectPath, activeSessionId, encodedName) => {
      const state = get();
      const normalizedPath = normalizeWindowsPath(projectPath);
      const sessionKey = `${normalizedPath}::${activeSessionId ?? ""}`;

      if (state.lastHydratedSessionKey === sessionKey) return;

      const isCurrentLiveSession =
        activeSessionId != null &&
        state.sessionId === activeSessionId &&
        (state.messages.length > 0 ||
          state.requestId != null ||
          state.phase !== "idle");
      if (isCurrentLiveSession) {
        const draft = readDraftWithKey(
          normalizedPath,
          activeSessionId,
          state.newSessionDraftSlotId,
        );
        set((currentState) => ({
          lastHydratedSessionKey: sessionKey,
          input:
            currentState.inputDraftKey !== draft.key ||
            currentState.input === ""
              ? draft.input
              : currentState.input,
          inputDraftKey: draft.key,
        }));
        return;
      }

      set({ lastHydratedSessionKey: sessionKey });

      if (activeSessionId) {
        void get().loadSession(projectPath, activeSessionId, encodedName);
      } else {
        get().startNewSession();
      }
    },

    generateRequestId: () => {
      const requestId = generateId();
      set({ requestId, lastUpdatedAt: Date.now() });
      return requestId;
    },

    beginStream: (requestId) => {
      set({
        phase: "streaming",
        requestId,
        currentAssistantMessage: null,
        historyLoading: false,
        historyError: null,
        streamError: null,
        permissionRequest: null,
        planModeRequest: null,
        blockedOnHuman: null,
        hasReceivedInit: false,
        lastUpdatedAt: Date.now(),
      });
    },

    appendAssistantContent: (content) => {
      set((state) => {
        const current = state.currentAssistantMessage;
        const nextContent = `${current?.content ?? ""}${content}`;
        const nextMessage = current
          ? { ...current, content: nextContent }
          : buildAssistantMessage(content);

        const messages = [...state.messages];
        const last = messages[messages.length - 1];
        if (isAssistantChatMessage(last)) {
          messages[messages.length - 1] = {
            ...last,
            content: nextContent,
          };
        } else {
          messages.push(nextMessage);
        }

        return {
          messages,
          currentAssistantMessage: nextMessage,
          lastUpdatedAt: Date.now(),
        };
      });
    },

    addMessage: (message) => {
      set((state) => {
        if (hasDuplicateStableMessage(state.messages, message)) {
          return { lastUpdatedAt: Date.now() };
        }

        const messages = [...state.messages, message];
        const nextState: Partial<ChatStoreState> = {
          messages,
          lastUpdatedAt: Date.now(),
        };

        if (message.type === "chat" && message.role === "assistant") {
          nextState.currentAssistantMessage = message;
        }

        return nextState as Pick<
          ChatStoreState,
          "messages" | "currentAssistantMessage" | "lastUpdatedAt"
        >;
      });
    },

    updateLastMessage: (content) => {
      set((state) => {
        const messages = [...state.messages];
        for (let index = messages.length - 1; index >= 0; index -= 1) {
          if (isAssistantChatMessage(messages[index])) {
            messages[index] = {
              ...messages[index],
              content,
            } as ChatMessage;
            break;
          }
        }

        const currentAssistantMessage = state.currentAssistantMessage
          ? { ...state.currentAssistantMessage, content }
          : state.currentAssistantMessage;

        return {
          messages,
          currentAssistantMessage,
          lastUpdatedAt: Date.now(),
        };
      });
    },

    completeSubagentLane: (toolUseId, result, completedAt) => {
      set((state) => ({
        messages: state.messages.map((message) => {
          if (
            message.type === "subagent_lane" &&
            (message as SubagentLaneMessage).toolUseId === toolUseId
          ) {
            return {
              ...(message as SubagentLaneMessage),
              result,
              state: "complete",
              completedAt: completedAt ?? Date.now(),
            };
          }
          return message;
        }),
        lastUpdatedAt: Date.now(),
      }));
    },

    failSubagentLane: (toolUseId, error, completedAt) => {
      set((state) => ({
        messages: state.messages.map((message) => {
          if (
            message.type === "subagent_lane" &&
            (message as SubagentLaneMessage).toolUseId === toolUseId
          ) {
            return {
              ...(message as SubagentLaneMessage),
              error,
              state: "error",
              completedAt: completedAt ?? Date.now(),
            };
          }
          return message;
        }),
        lastUpdatedAt: Date.now(),
      }));
    },

    attachSubagentIdToLane: (toolUseId, subagentId) => {
      set((state) => ({
        messages: state.messages.map((message) => {
          if (
            message.type === "subagent_lane" &&
            (message as SubagentLaneMessage).toolUseId === toolUseId
          ) {
            return {
              ...(message as SubagentLaneMessage),
              subagentId,
            };
          }
          return message;
        }),
        lastUpdatedAt: Date.now(),
      }));
    },

    completeSubagentLaneBySubagentId: (subagentId, result, completedAt) => {
      set((state) => ({
        messages: state.messages.map((message) => {
          if (
            message.type === "subagent_lane" &&
            (message as SubagentLaneMessage).subagentId === subagentId
          ) {
            return {
              ...(message as SubagentLaneMessage),
              result,
              state: "complete",
              completedAt: completedAt ?? Date.now(),
            };
          }
          return message;
        }),
        lastUpdatedAt: Date.now(),
      }));
    },

    failSubagentLaneBySubagentId: (subagentId, error, completedAt) => {
      set((state) => ({
        messages: state.messages.map((message) => {
          if (
            message.type === "subagent_lane" &&
            (message as SubagentLaneMessage).subagentId === subagentId
          ) {
            return {
              ...(message as SubagentLaneMessage),
              error,
              state: "error",
              completedAt: completedAt ?? Date.now(),
            };
          }
          return message;
        }),
        lastUpdatedAt: Date.now(),
      }));
    },

    updateLastCompactMessage: (updates) => {
      set((state) => {
        const messages = [...state.messages];
        for (let idx = messages.length - 1; idx >= 0; idx -= 1) {
          if (messages[idx].type === "compact") {
            messages[idx] = {
              ...(messages[idx] as CompactMessage),
              ...updates,
            };
            return { messages, lastUpdatedAt: Date.now() };
          }
        }
        return { lastUpdatedAt: Date.now() };
      });
    },

    finalizeAssistantMessage: () => {
      set((state) => ({
        ...commitAssistantMessage(state),
        lastUpdatedAt: Date.now(),
      }));
    },

    endStream: (sessionId) => {
      const state = get();
      // If a session switch happened mid-stream, the store already has the new
      // session's data. Drop this end-stream event to avoid overwriting it.
      if (sessionId && state.sessionId !== sessionId) return;
      const committed = commitAssistantMessage(state);
      const nextSessionId = sessionId ?? state.sessionId;

      // When a plan approval is pending (ExitPlanMode was emitted), the CLI's
      // `done` event is the natural end of the plan turn — preserve the
      // approval state so the plan bubble's approve button stays live.
      const hasPendingPlan = Boolean(state.planModeRequest?.isOpen);

      set({
        ...committed,
        sessionId: nextSessionId,
        requestId: null,
        phase: hasPendingPlan
          ? "awaiting-permission"
          : nextSessionId
            ? "ready"
            : "idle",
        historyLoading: false,
        permissionRequest: null,
        planModeRequest: hasPendingPlan ? state.planModeRequest : null,
        hasReceivedInit: false,
        streamError: null,
        lastUpdatedAt: Date.now(),
      });
      persistActiveSessionId(nextSessionId);
      persistSessionHistorySnapshot(get());

      if (state.projectPath) {
        fetchSessions(state.projectPath, state.projectEncodedName ?? "", true);
      }
    },

    resetRequestState: () => {
      const state = get();
      set({
        requestId: null,
        phase: state.sessionId ? "ready" : "idle",
        currentAssistantMessage: null,
        historyLoading: false,
        permissionRequest: null,
        planModeRequest: null,
        hasReceivedInit: false,
        streamError: null,
        lastUpdatedAt: Date.now(),
      });
    },

    startRequest: () => {
      const requestId = generateId();
      set({
        requestId,
        phase: "streaming",
        currentAssistantMessage: null,
        historyLoading: false,
        historyError: null,
        streamError: null,
        permissionRequest: null,
        planModeRequest: null,
        blockedOnHuman: null,
        hasReceivedInit: false,
        lastUpdatedAt: Date.now(),
      });
      return requestId;
    },

    requestPermission: (toolName, patterns, toolUseId) => {
      set({
        phase: "awaiting-permission",
        permissionRequest: {
          isOpen: true,
          toolName,
          patterns,
          toolUseId,
        },
        planModeRequest: null,
        lastUpdatedAt: Date.now(),
      });
    },

    resolvePermission: (allowedTools) => {
      set((state) => ({
        phase: "streaming",
        permissionRequest: null,
        allowedTools: Array.from(
          new Set([...state.allowedTools, ...allowedTools]),
        ),
        lastUpdatedAt: Date.now(),
      }));
    },

    requestPlanApproval: (content, toolUseId) => {
      set({
        phase: "awaiting-permission",
        permissionRequest: null,
        planModeRequest: {
          isOpen: true,
          planContent: content,
          toolUseId,
        },
        lastUpdatedAt: Date.now(),
      });
    },

    resolvePlanApproval: () => {
      set({
        phase: "streaming",
        planModeRequest: null,
        lastUpdatedAt: Date.now(),
      });
    },

    setPermissionMode: (mode) => {
      set({ permissionMode: mode, lastUpdatedAt: Date.now() });
    },

    setInput: (input) => {
      const state = get();
      writeDraft(
        state.projectPath,
        state.sessionId,
        state.newSessionDraftSlotId,
        input,
      );
      set({
        input,
        inputDraftKey: getDraftKey(
          state.projectPath,
          state.sessionId,
          state.newSessionDraftSlotId,
        ),
        lastUpdatedAt: Date.now(),
      });
    },

    clearInput: () => {
      const state = get();
      writeDraft(
        state.projectPath,
        state.sessionId,
        state.newSessionDraftSlotId,
        "",
      );
      set({
        input: "",
        inputDraftKey: getDraftKey(
          state.projectPath,
          state.sessionId,
          state.newSessionDraftSlotId,
        ),
        lastUpdatedAt: Date.now(),
      });
    },

    setModel: (model) => {
      const projectPath = get().projectPath;
      set({
        model,
        lastUpdatedAt: Date.now(),
      });

      if (projectPath) {
        setStorageItem(
          getProjectPreferenceKey(projectPath, STORAGE_KEYS.MODEL_PREFIX),
          model,
        );
      }
    },

    setEffort: (effort) => {
      const projectPath = get().projectPath;
      set({
        effort,
        lastUpdatedAt: Date.now(),
      });

      if (projectPath) {
        setStorageItem(
          getProjectPreferenceKey(projectPath, EFFORT_STORAGE_PREFIX),
          effort,
        );
      }
    },

    setShowBackgroundActivity: (showBackgroundActivity) => {
      set({ showBackgroundActivity, lastUpdatedAt: Date.now() });
    },

    setError: (error) => {
      set({
        phase: "error",
        streamError: error,
        requestId: null,
        historyLoading: false,
        currentAssistantMessage: null,
        lastUpdatedAt: Date.now(),
      });
    },

    abortStream: async () => {
      const state = get();
      const liveSessionId = state.sessionId;
      if (!liveSessionId) return;

      try {
        await fetch(getSessionAbortUrl(liveSessionId), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        });
      } catch (error) {
        console.error("Failed to abort request:", error);
      } finally {
        set({
          phase: state.sessionId ? "ready" : "idle",
          requestId: null,
          currentAssistantMessage: null,
          historyLoading: false,
          permissionRequest: null,
          planModeRequest: null,
          hasReceivedInit: false,
          streamError: null,
          lastUpdatedAt: Date.now(),
        });
      }
    },

    updateSessionTitle: async (sessionId, title) => {
      const { projectPath, projectEncodedName } = get();
      const isActiveHistorySession = (state: ChatStoreState) =>
        state.sessionId === sessionId ||
        state.historyMetadata?.sessionId === sessionId;

      set((state) =>
        isActiveHistorySession(state)
          ? { sessionTitle: title, lastUpdatedAt: Date.now() }
          : { lastUpdatedAt: Date.now() },
      );

      if (!projectPath) {
        return;
      }

      try {
        await fetch(
          getRenameSessionUrl(
            projectPath ?? projectEncodedName ?? "",
            sessionId,
          ),
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ title }),
          },
        );
      } catch {
        // Best effort only. Title updates should not block the UI.
      }
    },

    setCurrentAssistantMessage: (message) => {
      set({ currentAssistantMessage: message, lastUpdatedAt: Date.now() });
    },

    setHasReceivedInit: (received) => {
      set({ hasReceivedInit: received, lastUpdatedAt: Date.now() });
    },

    setHasShownInitMessage: (shown) => {
      set({ hasShownInitMessage: shown, lastUpdatedAt: Date.now() });
    },

    setMessages: (messages) => {
      set({ messages, lastUpdatedAt: Date.now() });
    },

    setQueuedMessages: (queued) => {
      set({ queuedMessages: queued });
    },
  })),
);

useChatStore.subscribe(
  (state) => state.messages,
  () => {
    scheduleSessionHistoryCacheWrite();
  },
);

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", flushSessionHistoryCache);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      flushSessionHistoryCache();
    }
  });
}
