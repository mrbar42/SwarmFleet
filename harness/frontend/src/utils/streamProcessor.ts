import type {
  AbortMessage,
  AllMessage,
  ChatMessage,
  CompactMessage,
  LiveSessionPhase,
  PermissionRequestState,
  PlanModeRequestState,
  QueueSnapshot,
  SDKMessage,
  SessionEvent,
  SessionPhase,
  SessionStatusSnapshot,
  StreamResponse,
} from "../types";
import type { SubagentLaneMessage } from "../types";
import type { BlockedOnHumanInfo, SubprocessUpdate } from "@shared/types";
import {
  UnifiedMessageProcessor,
  type ProcessingContext,
} from "./UnifiedMessageProcessor";
import { recordRateLimit } from "../stores/rateLimitStatus";
import { detectRateLimitFromText } from "./rateLimitDetect";
import { applySubprocessUpdate } from "../stores/subprocessStore";
import { updateBackgroundSessionStatus } from "../stores/sessionStatus";
import { useAppStore } from "../stores/appStore";

export interface StreamStoreState {
  messages?: AllMessage[];
  currentAssistantMessage?: ChatMessage | null;
  hasReceivedInit?: boolean;
  hasShownInitMessage?: boolean;
  phase?: SessionPhase;
  requestId?: string | null;
  sessionId?: string | null;
  permissionRequest?: PermissionRequestState | null;
  planModeRequest?: PlanModeRequestState | null;
  addMessage?: (message: AllMessage) => void;
  updateLastMessage?: (content: string) => void;
  completeSubagentLane?: (
    toolUseId: string,
    result: string,
    completedAt?: number,
  ) => void;
  failSubagentLane?: (
    toolUseId: string,
    error: string,
    completedAt?: number,
  ) => void;
  attachSubagentIdToLane?: (toolUseId: string, subagentId: string) => void;
  completeSubagentLaneBySubagentId?: (
    subagentId: string,
    result: string,
    completedAt?: number,
  ) => void;
  failSubagentLaneBySubagentId?: (
    subagentId: string,
    error: string,
    completedAt?: number,
  ) => void;
  updateLastCompactMessage?: (updates: Partial<CompactMessage>) => void;
  setCurrentAssistantMessage?: (message: ChatMessage | null) => void;
  setCurrentSessionId?: (sessionId: string | null) => void;
  setSessionId?: (sessionId: string | null) => void;
  setHasReceivedInit?: (received: boolean) => void;
  setHasShownInitMessage?: (shown: boolean) => void;
  applyLivePhase?: (
    phase: LiveSessionPhase,
    sessionId?: string | null,
    blockedOnHuman?: BlockedOnHumanInfo | null,
  ) => void;
  shouldShowInitMessage?: () => boolean;
  onInitMessageShown?: () => void;
  requestPermission?: (
    toolName: string,
    patterns: string[],
    toolUseId: string,
  ) => void;
  requestPlanApproval?: (content: string, toolUseId?: string) => void;
  onPermissionError?: (
    toolName: string,
    patterns: string[],
    toolUseId: string,
  ) => void;
  endStream?: (sessionId?: string) => void;
  onAbortRequest?: () => void;
  abortStream?: () => void;
  [key: string]: unknown;
}

export interface StreamStoreApi {
  getState: () => StreamStoreState;
  setState?: (
    nextStateOrUpdater:
      | Partial<StreamStoreState>
      | ((state: StreamStoreState) => Partial<StreamStoreState>),
    replace?: boolean,
  ) => void;
}

let registeredStoreApi: StreamStoreApi | null = null;
let activeSessionId: string | null = null;
let loggedRateLimitSample = false;
const processor = new UnifiedMessageProcessor();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isKnownClaudeMessageType(type: unknown): type is SDKMessage["type"] {
  return (
    type === "system" ||
    type === "assistant" ||
    type === "result" ||
    type === "user" ||
    type === "image"
  );
}

function resolveStoreApi(storeApi?: StreamStoreApi): StreamStoreApi {
  const resolved = storeApi ?? registeredStoreApi;
  if (!resolved) {
    throw new Error(
      "streamProcessor requires an explicit chat store api or a registered store. " +
        "Ensure registerStreamStore() is called during app initialization.",
    );
  }
  return resolved;
}

function setStoreState(
  storeApi: StreamStoreApi,
  updater: (state: StreamStoreState) => Partial<StreamStoreState>,
): void {
  storeApi.setState?.(updater);
}

function appendMessage(storeApi: StreamStoreApi, message: AllMessage): void {
  const state = storeApi.getState();
  if (state.addMessage) {
    state.addMessage(message);
    return;
  }

  setStoreState(storeApi, (current) => ({
    messages: [...(current.messages ?? []), message],
  }));
}

function updateLastMessage(storeApi: StreamStoreApi, content: string): void {
  const state = storeApi.getState();
  if (state.updateLastMessage) {
    state.updateLastMessage(content);
    return;
  }

  setStoreState(storeApi, (current) => ({
    messages: (current.messages ?? []).map((message, index, messages) =>
      index === messages.length - 1 && message.type === "chat"
        ? { ...message, content }
        : message,
    ),
  }));
}

function completeSubagentLane(
  storeApi: StreamStoreApi,
  toolUseId: string,
  result: string,
  completedAt?: number,
): void {
  const state = storeApi.getState();
  if (state.completeSubagentLane) {
    state.completeSubagentLane(toolUseId, result, completedAt);
    return;
  }

  setStoreState(storeApi, (current) => ({
    messages: (current.messages ?? []).map((message) =>
      message.type === "subagent_lane" &&
      (message as SubagentLaneMessage).toolUseId === toolUseId
        ? ({
            ...message,
            result,
            state: "complete",
            completedAt: completedAt ?? Date.now(),
          } as SubagentLaneMessage)
        : message,
    ),
  }));
}

function failSubagentLane(
  storeApi: StreamStoreApi,
  toolUseId: string,
  error: string,
  completedAt?: number,
): void {
  const state = storeApi.getState();
  if (state.failSubagentLane) {
    state.failSubagentLane(toolUseId, error, completedAt);
    return;
  }

  setStoreState(storeApi, (current) => ({
    messages: (current.messages ?? []).map((message) =>
      message.type === "subagent_lane" &&
      (message as SubagentLaneMessage).toolUseId === toolUseId
        ? ({
            ...message,
            error,
            state: "error",
            completedAt: completedAt ?? Date.now(),
          } as SubagentLaneMessage)
        : message,
    ),
  }));
}

function attachSubagentIdToLane(
  storeApi: StreamStoreApi,
  toolUseId: string,
  subagentId: string,
): void {
  const state = storeApi.getState();
  if (state.attachSubagentIdToLane) {
    state.attachSubagentIdToLane(toolUseId, subagentId);
    return;
  }

  setStoreState(storeApi, (current) => ({
    messages: (current.messages ?? []).map((message) =>
      message.type === "subagent_lane" &&
      (message as SubagentLaneMessage).toolUseId === toolUseId
        ? ({
            ...message,
            subagentId,
          } as SubagentLaneMessage)
        : message,
    ),
  }));
}

function completeSubagentLaneBySubagentId(
  storeApi: StreamStoreApi,
  subagentId: string,
  result: string,
  completedAt?: number,
): void {
  const state = storeApi.getState();
  if (state.completeSubagentLaneBySubagentId) {
    state.completeSubagentLaneBySubagentId(subagentId, result, completedAt);
    return;
  }

  setStoreState(storeApi, (current) => ({
    messages: (current.messages ?? []).map((message) =>
      message.type === "subagent_lane" &&
      (message as SubagentLaneMessage).subagentId === subagentId
        ? ({
            ...message,
            result,
            state: "complete",
            completedAt: completedAt ?? Date.now(),
          } as SubagentLaneMessage)
        : message,
    ),
  }));
}

function failSubagentLaneBySubagentId(
  storeApi: StreamStoreApi,
  subagentId: string,
  error: string,
  completedAt?: number,
): void {
  const state = storeApi.getState();
  if (state.failSubagentLaneBySubagentId) {
    state.failSubagentLaneBySubagentId(subagentId, error, completedAt);
    return;
  }

  setStoreState(storeApi, (current) => ({
    messages: (current.messages ?? []).map((message) =>
      message.type === "subagent_lane" &&
      (message as SubagentLaneMessage).subagentId === subagentId
        ? ({
            ...message,
            error,
            state: "error",
            completedAt: completedAt ?? Date.now(),
          } as SubagentLaneMessage)
        : message,
    ),
  }));
}

function updateLastCompactMessage(
  storeApi: StreamStoreApi,
  updates: Partial<CompactMessage>,
): void {
  const state = storeApi.getState();
  if (state.updateLastCompactMessage) {
    state.updateLastCompactMessage(updates);
    return;
  }

  setStoreState(storeApi, (current) => {
    const messages = [...(current.messages ?? [])];
    for (let idx = messages.length - 1; idx >= 0; idx -= 1) {
      if (messages[idx].type === "compact") {
        messages[idx] = {
          ...(messages[idx] as CompactMessage),
          ...updates,
        };
        return { messages };
      }
    }
    return {};
  });
}

function setCurrentAssistantMessage(
  storeApi: StreamStoreApi,
  message: ChatMessage | null,
): void {
  const state = storeApi.getState();
  if (state.setCurrentAssistantMessage) {
    state.setCurrentAssistantMessage(message);
    return;
  }

  setStoreState(storeApi, () => ({ currentAssistantMessage: message }));
}

function setCurrentSessionId(
  storeApi: StreamStoreApi,
  sessionId: string | null,
): void {
  const state = storeApi.getState();
  if (state.setCurrentSessionId) {
    state.setCurrentSessionId(sessionId);
    return;
  }

  if (state.setSessionId) {
    state.setSessionId(sessionId);
    return;
  }

  setStoreState(storeApi, () => ({ sessionId }));
}

function mapLivePhaseToUiPhase(
  phase: LiveSessionPhase,
  hasSession: boolean,
): SessionPhase {
  switch (phase) {
    case "running":
    case "backend_wakeup":
      return "streaming";
    case "awaiting_input":
      return "awaiting-permission";
    case "error":
    case "interrupted":
      return "error";
    case "idle":
    default:
      return hasSession ? "ready" : "idle";
  }
}

function applyLivePhase(
  storeApi: StreamStoreApi,
  phase: LiveSessionPhase,
  sessionId?: string | null,
  blockedOnHuman?: BlockedOnHumanInfo | null,
): void {
  const state = storeApi.getState();
  if (state.applyLivePhase) {
    state.applyLivePhase(phase, sessionId, blockedOnHuman);
    return;
  }

  const resolvedSessionId = sessionId ?? state.sessionId ?? null;
  setStoreState(storeApi, () => ({
    phase: mapLivePhaseToUiPhase(phase, Boolean(resolvedSessionId)),
    requestId: phase === "running" ? state.requestId ?? null : null,
  }));
}

function setHasReceivedInit(
  storeApi: StreamStoreApi,
  received: boolean,
): void {
  const state = storeApi.getState();
  if (state.setHasReceivedInit) {
    state.setHasReceivedInit(received);
    return;
  }

  setStoreState(storeApi, () => ({ hasReceivedInit: received }));
}

function showInitMessage(storeApi: StreamStoreApi): boolean {
  const state = storeApi.getState();
  return state.shouldShowInitMessage?.() ?? !state.hasShownInitMessage;
}

function markInitMessageShown(storeApi: StreamStoreApi): void {
  const state = storeApi.getState();
  if (state.onInitMessageShown) {
    state.onInitMessageShown();
    return;
  }

  if (state.setHasShownInitMessage) {
    state.setHasShownInitMessage(true);
    return;
  }

  setStoreState(storeApi, () => ({ hasShownInitMessage: true }));
}

function requestPlanApproval(
  storeApi: StreamStoreApi,
  content: string,
  toolUseId: string,
): void {
  const state = storeApi.getState();
  if (state.requestPlanApproval) {
    state.requestPlanApproval(content, toolUseId);
    return;
  }

  setStoreState(storeApi, () => ({
    phase: "awaiting-permission",
    planModeRequest: { planContent: content, toolUseId },
  }));
}

function requestPermission(
  storeApi: StreamStoreApi,
  toolName: string,
  patterns: string[],
  toolUseId: string,
): void {
  const state = storeApi.getState();
  if (patterns.includes("ExitPlanMode")) {
    requestPlanApproval(storeApi, "", toolUseId);
    return;
  }

  if (state.requestPermission) {
    state.requestPermission(toolName, patterns, toolUseId);
    return;
  }

  if (state.onPermissionError) {
    state.onPermissionError(toolName, patterns, toolUseId);
    return;
  }

  setStoreState(storeApi, () => ({
    phase: "awaiting-permission",
    permissionRequest: { toolName, patterns, toolUseId },
  }));
}

function abortRequest(storeApi: StreamStoreApi): void {
  const state = storeApi.getState();
  if (state.onAbortRequest) {
    state.onAbortRequest();
    return;
  }

  state.abortStream?.();
}

function resetStreamCache(): void {
  processor.clearCache();
  activeSessionId = null;
}

function maybeResetForSession(sessionId: string | undefined): void {
  if (!sessionId) return;
  if (activeSessionId !== sessionId) {
    resetStreamCache();
    activeSessionId = sessionId;
  }
}

function createStreamProcessingContext(
  storeApi: StreamStoreApi,
): ProcessingContext {
  return {
    addMessage: (message: AllMessage) => appendMessage(storeApi, message),
    updateLastMessage: (content: string) =>
      updateLastMessage(storeApi, content),
    completeSubagentLane: (
      toolUseId: string,
      result: string,
      completedAt?: number,
    ) => completeSubagentLane(storeApi, toolUseId, result, completedAt),
    failSubagentLane: (
      toolUseId: string,
      error: string,
      completedAt?: number,
    ) => failSubagentLane(storeApi, toolUseId, error, completedAt),
    attachSubagentIdToLane: (toolUseId: string, subagentId: string) =>
      attachSubagentIdToLane(storeApi, toolUseId, subagentId),
    completeSubagentLaneBySubagentId: (
      subagentId: string,
      result: string,
      completedAt?: number,
    ) =>
      completeSubagentLaneBySubagentId(
        storeApi,
        subagentId,
        result,
        completedAt,
      ),
    failSubagentLaneBySubagentId: (
      subagentId: string,
      error: string,
      completedAt?: number,
    ) =>
      failSubagentLaneBySubagentId(storeApi, subagentId, error, completedAt),
    updateLastCompactMessage: (updates: Partial<CompactMessage>) =>
      updateLastCompactMessage(storeApi, updates),
    get currentAssistantMessage() {
      return storeApi.getState().currentAssistantMessage ?? null;
    },
    setCurrentAssistantMessage: (message: ChatMessage | null) =>
      setCurrentAssistantMessage(storeApi, message),
    onSessionId: (_sessionId: string) => {},
    get hasReceivedInit() {
      return storeApi.getState().hasReceivedInit;
    },
    setHasReceivedInit: (received: boolean) =>
      setHasReceivedInit(storeApi, received),
    shouldShowInitMessage: () => showInitMessage(storeApi),
    onInitMessageShown: () => markInitMessageShown(storeApi),
    onPermissionError: (
      toolName: string,
      patterns: string[],
      toolUseId: string,
    ) => requestPermission(storeApi, toolName, patterns, toolUseId),
    onPlanApproval: (content: string, toolUseId: string) =>
      requestPlanApproval(storeApi, content, toolUseId),
    onAbortRequest: () => abortRequest(storeApi),
  };
}

function syncTerminalSessionState(
  storeApi: StreamStoreApi,
  terminalStatus: LiveSessionPhase,
): void {
  const sessionId = storeApi.getState().sessionId;
  if (!sessionId) return;
  updateBackgroundSessionStatus(sessionId, terminalStatus);
  useAppStore.getState().updateSessionStatus(sessionId, terminalStatus);
}

function processTerminalResponse(
  storeApi: StreamStoreApi,
  terminalStatus: LiveSessionPhase,
): void {
  resetStreamCache();
  syncTerminalSessionState(storeApi, terminalStatus);

  const state = storeApi.getState();
  if (state.endStream) {
    state.endStream(state.sessionId ?? undefined);
    return;
  }

  setCurrentAssistantMessage(storeApi, null);
  setStoreState(storeApi, () => ({
    phase: "ready",
    requestId: null,
    permissionRequest: null,
    planModeRequest: null,
    hasReceivedInit: false,
  }));
}

export function registerStreamStore(storeApi: StreamStoreApi): void {
  registeredStoreApi = storeApi;
}

export function resetProcessor(): void {
  resetStreamCache();
}

export function processClaudeData(
  claudeData: SDKMessage,
  storeApi?: StreamStoreApi,
): void {
  const resolvedStoreApi = resolveStoreApi(storeApi);

  if (!isKnownClaudeMessageType((claudeData as { type?: unknown }).type)) {
    const messageType = (claudeData as { type?: string }).type;
    if (messageType === "rate_limit_event") {
      // The Claude Agent SDK is the only emitter of rate_limit_event, so we
      // tag every sighting with the "claude" provider. If we ever wrap codex
      // rate-limit signals similarly, the backend should include a provider
      // field on the event and we can read it here instead of hardcoding.
      //
      // Log the raw payload once per page load so we can see the actual
      // field shape the SDK uses in this install — useful for tuning the
      // status-line formatter.
      if (!loggedRateLimitSample) {
        loggedRateLimitSample = true;
        console.log("[rate_limit_event sample]", claudeData);
      }
      recordRateLimit("claude", claudeData as unknown as Record<string, unknown>);
    } else {
      console.log("Unknown Claude message type:", claudeData);
    }
    return;
  }

  maybeResetForSession((claudeData as { session_id?: string }).session_id);

  processor.processMessage(
    claudeData,
    createStreamProcessingContext(resolvedStoreApi),
    { isStreaming: true },
  );
}

export function processStreamResponse(
  response: StreamResponse,
  storeApi?: StreamStoreApi,
): void {
  const resolvedStoreApi = resolveStoreApi(storeApi);

  switch (response.type) {
    case "claude_json":
      if (response.data && isRecord(response.data)) {
        // Cross-device user-message echo: the backend re-broadcasts the
        // sender's own turn as a stream event so other devices viewing the
        // same session see it immediately. The sender has already rendered
        // an optimistic bubble from sendMessage(), so suppress the matching
        // echo here to avoid a duplicate.
        const originRequestId = (response.data as { swarmfleetOriginRequestId?: unknown })
          .swarmfleetOriginRequestId;
        if (typeof originRequestId === "string") {
          const currentRequestId = resolvedStoreApi.getState().requestId;
          if (currentRequestId && currentRequestId === originRequestId) {
            return;
          }
        }
        processClaudeData(response.data as SDKMessage, resolvedStoreApi);
      }
      return;
    case "error": {
      const errorText = response.error || "Unknown error";
      const rateLimit = detectRateLimitFromText(errorText);
      if (rateLimit) {
        recordRateLimit("claude", rateLimit as unknown as Record<string, unknown>);
      }
      appendMessage(resolvedStoreApi, {
        type: "error",
        subtype: "stream_error",
        message: errorText,
        timestamp: Date.now(),
      });
      processTerminalResponse(resolvedStoreApi, "error");
      return;
    }
    case "aborted":
      appendMessage(resolvedStoreApi, {
        type: "system",
        subtype: "abort",
        message: "Operation was aborted by user",
        timestamp: Date.now(),
      } as AbortMessage);
      setCurrentAssistantMessage(resolvedStoreApi, null);
      processTerminalResponse(resolvedStoreApi, "interrupted");
      return;
    case "done":
      processTerminalResponse(resolvedStoreApi, "idle");
      return;
    default:
      return;
  }
}

export function processStreamPayload(
  payload: unknown,
  storeApi?: StreamStoreApi,
): void {
  const resolvedStoreApi = resolveStoreApi(storeApi);

  if (typeof payload === "string") {
    processStreamLine(payload, resolvedStoreApi);
    return;
  }

  if (isRecord(payload) && payload.type === "subprocess-update") {
    applySubprocessUpdate(payload as unknown as SubprocessUpdate);
    return;
  }

  if (
    isRecord(payload) &&
    (payload.type === "claude_json" ||
      payload.type === "error" ||
      payload.type === "aborted" ||
      payload.type === "done")
  ) {
    processStreamResponse(payload as unknown as StreamResponse, resolvedStoreApi);
    return;
  }

  processStreamLine(JSON.stringify(payload), resolvedStoreApi);
}

export function processSessionEventData(
  event: SessionEvent,
  storeApi?: StreamStoreApi,
): void {
  const resolvedStoreApi = resolveStoreApi(storeApi);

  if (event.type === "session_ready") {
    setCurrentSessionId(resolvedStoreApi, event.sessionId);
    return;
  }

  if (event.type === "session_status") {
    applyLivePhase(resolvedStoreApi, event.status, event.sessionId);
  }
}

export function processStatusEventData(
  snapshot: SessionStatusSnapshot,
  storeApi?: StreamStoreApi,
): void {
  const resolvedStoreApi = resolveStoreApi(storeApi);
  const state = resolvedStoreApi.getState();
  const isStaleIdleForLocalRun =
    snapshot.status === "idle" &&
    state.phase === "streaming" &&
    Boolean(state.requestId) &&
    snapshot.sessionId === state.sessionId;

  if (!isStaleIdleForLocalRun) {
    updateBackgroundSessionStatus(
      snapshot.sessionId,
      snapshot.status,
      snapshot.blockedOnHuman,
    );
  }
  // Surface a console warning when the backend reports the head is blocked
  // but didn't include the articulated reason — the UI can still render a
  // fallback, but the operator deserves to know the payload was missing.
  if (snapshot.status === "blocked_on_human" && !snapshot.blockedOnHuman) {
    console.warn(
      "[streamProcessor] blocked_on_human status received without payload",
      { sessionId: snapshot.sessionId },
    );
  }
  applyLivePhase(
    resolvedStoreApi,
    snapshot.status,
    snapshot.sessionId,
    snapshot.status === "blocked_on_human"
      ? (snapshot.blockedOnHuman ?? null)
      : null,
  );
}

export function processQueueEventData(
  snapshot: QueueSnapshot,
  storeApi?: StreamStoreApi,
): void {
  const resolvedStoreApi = resolveStoreApi(storeApi);
  const state = resolvedStoreApi.getState();
  if (typeof state.setQueuedMessages === "function") {
    (state.setQueuedMessages as (q: QueueSnapshot["queued"]) => void)(snapshot.queued);
  }
}

export function processStreamLine(
  line: string,
  storeApi?: StreamStoreApi,
): void {
  const resolvedStoreApi = resolveStoreApi(storeApi);

  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;

    if (parsed.type === "permission_error") {
      const toolName = typeof parsed.toolName === "string" ? parsed.toolName : "Tool";
      const patterns = Array.isArray(parsed.patterns)
        ? parsed.patterns.filter((pattern): pattern is string => typeof pattern === "string")
        : [];
      const toolUseId =
        typeof parsed.toolUseId === "string" ? parsed.toolUseId : "";
      requestPermission(resolvedStoreApi, toolName, patterns, toolUseId);
      return;
    }

    if (parsed.type === "session_id") {
      const sessionId =
        typeof parsed.sessionId === "string" ? parsed.sessionId : undefined;
      maybeResetForSession(sessionId);
      return;
    }

    if (parsed.type === "subprocess-update") {
      applySubprocessUpdate(parsed as unknown as SubprocessUpdate);
      return;
    }

    if (parsed.type === "claude_json") {
      processStreamResponse(
        { type: "claude_json", data: parsed.data },
        resolvedStoreApi,
      );
      return;
    }

    if (
      parsed.type === "error" ||
      parsed.type === "aborted" ||
      parsed.type === "done"
    ) {
      processStreamResponse(parsed as unknown as StreamResponse, resolvedStoreApi);
    }
  } catch (parseError) {
    console.error("Failed to parse stream line:", parseError);
  }
}
