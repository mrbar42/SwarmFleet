/**
 * SwarmFleet frontend types
 *
 * SDK types are defined locally (no @anthropic-ai/claude-code dependency).
 */

import type { ConversationImageAsset, ProjectFeatures } from "@shared/types";

// --- SDK type stubs (minimal shapes needed for streaming/history) ---

export interface SDKSystemMessage {
  type: "system";
  subtype?:
    | "init"
    | "abort"
    | "task_notification"
    | "task_started"
    | "task_updated"
    | "status"
    | "compact_boundary"
    | "runner_interrupted"
    | "wakeup_armed"
    | "wakeup_trigger"
    | "loop_trigger"
    | "loop_paused"
    | "model_no_final_message"
    | "api_retry";
  session_id?: string;
  model?: string;
  tools?: string[];
  cwd?: string;
  permissionMode?: string;
  message?: string;
  trigger_source?: "user" | "cron" | "hook" | "loop";
  visible_to_user?: boolean;
  [key: string]: unknown;
}

export interface SDKResultMessage {
  type: "result";
  duration_ms: number;
  total_cost_usd: number;
  usage: { input_tokens: number; output_tokens: number };
  session_id?: string;
  trigger_source?: "user" | "cron" | "hook" | "loop";
  visible_to_user?: boolean;
  [key: string]: unknown;
}

export interface SDKAssistantMessage {
  type: "assistant";
  session_id?: string;
  trigger_source?: "user" | "cron" | "hook" | "loop";
  visible_to_user?: boolean;
  message: {
    content: Array<{
      type: string;
      text?: string;
      id?: string;
      name?: string;
      input?: Record<string, unknown>;
      thinking?: string;
      tool_use_id?: string;
      content?: string;
      is_error?: boolean;
      [key: string]: unknown;
    }>;
  };
  [key: string]: unknown;
}

export interface SDKUserMessage {
  type: "user";
  trigger_source?: "user" | "cron" | "hook" | "loop";
  visible_to_user?: boolean;
  message: {
    content:
      | string
      | Array<{
          type: string;
          text?: string;
          tool_use_id?: string;
          content?: string;
          is_error?: boolean;
          [key: string]: unknown;
        }>;
  };
  toolUseResult?: unknown;
  [key: string]: unknown;
}

export interface SDKImageMessage {
  type: "image";
  role?: "assistant" | "user";
  asset: ConversationImageAsset;
  caption?: string;
  timestamp?: string;
  trigger_source?: "user" | "cron" | "hook" | "loop";
  visible_to_user?: boolean;
  [key: string]: unknown;
}

export type SDKMessage =
  | SDKSystemMessage
  | SDKResultMessage
  | SDKAssistantMessage
  | SDKUserMessage
  | SDKImageMessage;

// Timestamped variants for conversation history API
type WithTimestamp<T> = T & { timestamp: string };

export type TimestampedSDKUserMessage = WithTimestamp<SDKUserMessage>;
export type TimestampedSDKAssistantMessage = WithTimestamp<SDKAssistantMessage>;
export type TimestampedSDKSystemMessage = WithTimestamp<SDKSystemMessage>;
export type TimestampedSDKResultMessage = WithTimestamp<SDKResultMessage>;
export type TimestampedSDKImageMessage = WithTimestamp<SDKImageMessage>;

export type TimestampedSDKMessage =
  | TimestampedSDKUserMessage
  | TimestampedSDKAssistantMessage
  | TimestampedSDKSystemMessage
  | TimestampedSDKResultMessage
  | TimestampedSDKImageMessage;

// --- Chat message types ---

/** Lightweight chat message for user/assistant interactions */
export interface ChatMessage {
  type: "chat";
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  assets?: ConversationImageAsset[];
  trigger_source?: "user" | "cron" | "hook" | "loop";
  visible_to_user?: boolean;
}

/** Error message for streaming errors */
export interface ErrorMessage {
  type: "error";
  subtype: "stream_error";
  message: string;
  timestamp: number;
  trigger_source?: "user" | "cron" | "hook" | "loop";
  visible_to_user?: boolean;
}

/** Abort message */
export type AbortMessage = {
  type: "system";
  subtype: "abort";
  message: string;
  timestamp: number;
  trigger_source?: "user" | "cron" | "hook" | "loop";
  visible_to_user?: boolean;
};

/** Hooks message for hook execution notifications */
export type HooksMessage = {
  type: "system";
  content: string;
  level?: string;
  toolUseID?: string;
  trigger_source?: "user" | "cron" | "hook" | "loop";
  visible_to_user?: boolean;
};

/** System message — union of SDK system/result and custom error/abort/hooks */
export type SystemMessage = (
  | SDKSystemMessage
  | SDKResultMessage
  | ErrorMessage
  | AbortMessage
  | HooksMessage
) & {
  timestamp: number;
};

export interface TaskLifecycleUpdate {
  status?: string;
  endTime?: number;
  timestamp?: number;
}

/** Tool message for tool usage display */
export interface ToolMessage {
  type: "tool";
  content: string;
  timestamp: number;
  toolName?: string;
  toolUseId?: string;
  toolInput?: Record<string, unknown>;
  trigger_source?: "user" | "cron" | "hook" | "loop";
  visible_to_user?: boolean;
}

/** Tool result message */
export interface ToolResultMessage {
  type: "tool_result";
  toolName: string;
  content: string;
  summary: string;
  timestamp: number;
  toolUseId?: string;
  toolInput?: Record<string, unknown>;
  toolUseResult?: unknown;
  assets?: ConversationImageAsset[];
  trigger_source?: "user" | "cron" | "hook" | "loop";
  visible_to_user?: boolean;
}

export interface ImageMessage {
  type: "image";
  role: "assistant" | "user";
  asset: ConversationImageAsset;
  caption?: string;
  timestamp: number;
  trigger_source?: "user" | "cron" | "hook" | "loop";
  visible_to_user?: boolean;
}

/** Plan message type for UI display */
export interface PlanMessage {
  type: "plan";
  plan: string;
  toolUseId: string;
  timestamp: number;
  trigger_source?: "user" | "cron" | "hook" | "loop";
  visible_to_user?: boolean;
}

/** Thinking message for Claude's reasoning process */
export interface ThinkingMessage {
  type: "thinking";
  content: string;
  timestamp: number;
  trigger_source?: "user" | "cron" | "hook" | "loop";
  visible_to_user?: boolean;
}

/** Todo item structure */
export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm: string;
}

/** Todo message for TodoWrite tool result display */
export interface TodoMessage {
  type: "todo";
  todos: TodoItem[];
  timestamp: number;
  trigger_source?: "user" | "cron" | "hook" | "loop";
  visible_to_user?: boolean;
}

/** Context-compaction lifecycle state */
export type CompactState = "running" | "complete";

/**
 * Compact message — represents a context-compacting event.
 *
 * Folds together three incoming system events plus the follow-up user message:
 *   1. { subtype: "status", status: "compacting" }       → state="running"
 *   2. { subtype: "status", status: null, compact_result } → state="complete"
 *   3. { subtype: "compact_boundary", compact_metadata }  → attaches metadata
 *   4. The next user message (the compaction summary)    → stored in `summary`
 */
export interface CompactMessage {
  type: "compact";
  state: CompactState;
  startedAt: number;
  completedAt?: number;
  compactResult?: string;
  preTokens?: number;
  postTokens?: number;
  durationMs?: number;
  trigger?: string;
  summary?: string;
  timestamp: number;
  trigger_source?: "user" | "cron" | "hook" | "loop";
  visible_to_user?: boolean;
}

/** Subagent lifecycle state */
export type SubagentState = "running" | "complete" | "error";

/** Subagent lane message — groups an Agent tool call and its result */
export interface SubagentLaneMessage {
  type: "subagent_lane";
  toolUseId: string;
  description: string;
  agentType: string;
  state: SubagentState;
  result?: string;
  error?: string;
  startedAt: number;
  completedAt?: number;
  timestamp: number;
  trigger_source?: "user" | "cron" | "hook" | "loop";
  visible_to_user?: boolean;
  /**
   * Session id of the spawned child when this lane represents a SwarmFleet
   * custom subagent. Absent for legacy native Agent tool calls. Used by the UI
   * to navigate into the child session.
   */
  subagentId?: string;
}

/** Thinking content item from Claude SDK */
export interface ThinkingContentItem {
  type: "thinking";
  thinking: string;
}

export type AllMessage =
  | ChatMessage
  | ImageMessage
  | SystemMessage
  | ToolMessage
  | ToolResultMessage
  | PlanMessage
  | ThinkingMessage
  | TodoMessage
  | SubagentLaneMessage
  | CompactMessage;

// --- Type guard functions ---

export function isChatMessage(message: AllMessage): message is ChatMessage {
  return message.type === "chat";
}

export function isImageMessage(message: AllMessage): message is ImageMessage {
  return message.type === "image";
}

export function isSystemMessage(message: AllMessage): message is SystemMessage {
  return (
    message.type === "system" ||
    message.type === "result" ||
    message.type === "error"
  );
}

export function isToolMessage(message: AllMessage): message is ToolMessage {
  return message.type === "tool";
}

export function isToolResultMessage(
  message: AllMessage,
): message is ToolResultMessage {
  return message.type === "tool_result";
}

export function isPlanMessage(message: AllMessage): message is PlanMessage {
  return message.type === "plan";
}

export function isThinkingMessage(
  message: AllMessage,
): message is ThinkingMessage {
  return message.type === "thinking";
}

export function isTodoMessage(message: AllMessage): message is TodoMessage {
  return message.type === "todo";
}

export function isSubagentLaneMessage(
  message: AllMessage,
): message is SubagentLaneMessage {
  return message.type === "subagent_lane";
}

export function isCompactMessage(
  message: AllMessage,
): message is CompactMessage {
  return message.type === "compact";
}

// --- Permission mode types ---

export type PermissionMode =
  | "default"
  | "plan"
  | "acceptEdits"
  | "bypassPermissions";

export type SessionPhase =
  | "idle"
  | "loading-history"
  | "ready"
  | "streaming"
  | "awaiting-permission"
  | "error";

export interface PermissionRequestState {
  toolName: string;
  patterns: string[];
  toolUseId: string;
}

export interface PlanModeRequestState {
  planContent: string;
  toolUseId?: string;
}

export interface Project {
  name: string;
  path: string;
  features: ProjectFeatures;
  encodedName?: string;
  kind?: "workspace" | "system";
  gitEnabled?: boolean;
}

// --- Re-export shared types ---

export type {
  CreateSessionRequest,
  CreateSessionResponse,
  StreamResponse,
  ChatRequest,
  ImageAttachment,
  LiveSessionPhase,
  ProjectsResponse,
  ProjectInfo,
  QueuedMessage,
  QueueSnapshot,
  SessionAbortResponse,
  SessionEvent,
  SessionMessageRequest,
  SessionMessageResponse,
  SessionMetadata,
  SessionPhaseSnapshot,
  SessionStatusSnapshot,
  SessionReadyEvent,
  TerminalHistoryEntry,
  TerminalHistoryResponse,
  ProjectFeatures,
  ProjectFeatureKey,
  PreviewState,
  PreviewStatus,
  SessionKind,
  ConversationSummary,
  ConversationHistory,
} from "@shared/types";
