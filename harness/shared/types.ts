/**
 * Shared types for SwarmFleet frontend and backend.
 */

/** Per-project feature capabilities. Features are additive; none are exclusive. */
export type ProjectFeatureKey = "preview";

export interface ProjectFeatureConfig {
  enabled: boolean;
  command?: string;
  devServer?: {
    enabled: boolean;
    publishToHost: boolean;
    port?: number | null;
  };
}

export type ProjectFeatures = {
  [K in ProjectFeatureKey]: ProjectFeatureConfig;
};

/** Default feature state — everything disabled. Used as the zero state for new projects. */
export const DEFAULT_PROJECT_FEATURES: ProjectFeatures = {
  preview: { enabled: false },
};

/** Session kinds. Ordinary user chats plus child sessions spawned by agents. */
export type SessionKind = "chat" | "subagent";

export interface StreamResponse {
  type: "claude_json" | "error" | "done" | "aborted" | "subprocess-update";
  data?: unknown;
  error?: string;
}

export interface SubprocessEntry {
  pid: number;
  ppid: number;
  command: string;
  startedAt: number | null;
  displayable: boolean;
}

export interface SubprocessUpdate {
  type: "subprocess-update";
  sessionId: string;
  processes: SubprocessEntry[];
}

export type PreviewState =
  | "idle"
  | "starting"
  | "running"
  | "error"
  | "stopped";

export interface PreviewStatus {
  id: string;
  projectPath: string;
  configuredCommand: string;
  resolvedCommand: string | null;
  state: PreviewState;
  port: number | null;
  url: string | null;
  hostUrl: string | null;
  devServer: {
    enabled: boolean;
    publishToHost: boolean;
    port: number | null;
    pid: number | null;
    pgid: number | null;
    startedAt: number | null;
  };
  error: string | null;
  logs: string;
  retryAt: number | null;
  startedAt: number | null;
  updatedAt: number;
}

export interface ImageAttachment {
  type: "image";
  media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
  base64: string;
}

export interface ConversationImageAsset {
  assetId: string;
  mimeType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
  url: string;
  thumbnailUrl: string;
  createdAt: number;
  sourceToolName?: string;
}

export type PermissionMode =
  | "default"
  | "plan"
  | "acceptEdits"
  | "bypassPermissions";

export type ChatProvider =
  | "claude"
  | "codex"
  | "pi"
  | "openrouter-claude"
  | "hermes";

export interface ProviderStatusInfo {
  name: string;
  authenticated: boolean;
  error?: string;
}

export interface RedactedPiProviderProfile {
  id: string;
  name: string;
  provider: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
  denyOpenRouterDataCollection: boolean;
  manualModels: string[];
  hasApiKey: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface RedactedOpenRouterClaudeProfile {
  id: string;
  name: string;
  baseUrl?: string;
  manualModels: string[];
  hasApiKey: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface ProviderStatusResponse {
  providers: Record<string, ProviderStatusInfo>;
  piProfiles: RedactedPiProviderProfile[];
  openRouterClaudeProfiles: RedactedOpenRouterClaudeProfile[];
  cliPath?: string;
}

export interface ProviderModelOption {
  id: string;
  rawId: string;
  label: string;
  provider: ChatProvider;
  contextWindow?: number;
  reasoning?: boolean;
  input?: ("text" | "image")[];
}

export interface ProviderCatalogGroup {
  id: string;
  label: string;
  provider: ChatProvider;
  sourceProvider?: string;
  profileId?: string;
  authenticated: boolean;
  error?: string;
  models: ProviderModelOption[];
}

export interface ProviderCatalogResponse {
  groups: ProviderCatalogGroup[];
  piSupportedProviders: string[];
  piProfiles: RedactedPiProviderProfile[];
  openRouterClaudeProfiles: RedactedOpenRouterClaudeProfile[];
}

export interface ProviderGlobalSettings {
  defaultSubagentModel: string;
  openRouterClaudeProxyEnabled: boolean;
  openRouterClaudeProxyZdrEnabled: boolean;
  telegramOperatorNotificationsEnabled: boolean;
  telegramBotToken?: string;
  telegramChatId?: string;
}

export type ToolId = "hermes" | "chrome-devtools-mcp" | "claude" | "codex";

export interface ToolManagerToolConfig {
  enabled: boolean;
  autoUpdate: boolean;
}

export interface ToolManagerNodeRuntimeConfig {
  enabled: boolean;
  autoInstallProjectVersions: boolean;
  versions: string[];
}

export interface ToolManagerConfig {
  version: number;
  autoUpdate: {
    enabled: boolean;
    frequencyDays: number;
  };
  tools: Record<ToolId, ToolManagerToolConfig>;
  runtimes?: {
    node: ToolManagerNodeRuntimeConfig;
  };
}

export interface ToolManagerToolStatus extends ToolManagerToolConfig {
  id: ToolId;
  name: string;
  installed: boolean;
  binaryPath: string | null;
  version: string | null;
  signedIn: boolean | null;
}

export interface ToolManagerNodeRuntimeStatus
  extends ToolManagerNodeRuntimeConfig {
  installedVersions: string[];
  miseDataDir: string;
  defaultBinaryPath: string | null;
  defaultVersion: string | null;
}

export interface ToolManagerStatus {
  version: number;
  state: "ready" | "updating" | "error";
  message: string;
  updatedAt: number;
  toolsRoot: string;
  autoUpdate: ToolManagerConfig["autoUpdate"];
  tools: Partial<Record<ToolId, ToolManagerToolStatus>>;
  runtimes?: {
    node: ToolManagerNodeRuntimeStatus;
  };
}

export interface ToolManagerUpdateRequest {
  autoUpdate?: Partial<ToolManagerConfig["autoUpdate"]>;
  tools?: Partial<Record<ToolId, Partial<ToolManagerToolConfig>>>;
  runtimes?: {
    node?: Partial<ToolManagerNodeRuntimeConfig>;
  };
}

export type RedactedProviderGlobalSettings = Omit<
  ProviderGlobalSettings,
  "telegramBotToken"
> & {
  telegramBotTokenConfigured: boolean;
};

export interface PiProviderProfileRequest {
  name?: string;
  provider?: string;
  apiKey?: string;
  baseUrl?: string | null;
  headers?: Record<string, string> | null;
  compat?: Record<string, unknown> | null;
  denyOpenRouterDataCollection?: boolean | null;
  manualModels?: string[] | null;
}

export interface OpenRouterClaudeProfileRequest {
  name?: string;
  apiKey?: string;
  baseUrl?: string | null;
  manualModels?: string[] | null;
}

export type SessionStatus =
  | "idle"
  | "running"
  | "awaiting_input"
  | "error"
  | "interrupted"
  | "backend_wakeup"
  | "blocked_on_human";

export type SessionInterruptionReason =
  | "user_abort"
  | "archive"
  | "cascade_abort"
  | "process_kill"
  | "runner_signal"
  | "runner_missing"
  | "runner_exited"
  | "backend_resume_failed"
  | "unknown";

export interface BlockedOnHumanInfo {
  whichTest: "irreversibility" | "scope_breach";
  specificIrreversibleAction: string;
  whyPlannerCannotDecide: string;
  /** ISO 8601 timestamp set server-side when the session requested intervention. */
  requestedAt: string;
}

export interface ArmedWakeupInfo {
  id: string;
  kind: "scheduled_wakeup" | "wait_until";
  reason: string;
  dueAt: number;
  createdAt: number;
  mode?: "all" | "any";
}

/**
 * Compatibility alias retained while the frontend moves fully to `status`.
 */
export type LiveSessionPhase = SessionStatus;

export type SessionSourceKind = "native" | "imported";

export interface SessionMetadata {
  sessionId: string;
  projectPath: string;
  encodedProjectName: string | null;
  provider: ChatProvider;
  providerSessionId: string | null;
  createdAt: number;
  updatedAt: number;
  status: SessionStatus;
  title: string;
  lastMessagePreview: string;
  model: string;
  effort: string;
  permissionMode: PermissionMode;
  allowedTools?: string[];
  activeRequestId: string | null;
  runnerPid: number | null;
  /** PID of the Claude / Codex CLI child process spawned by the session runner. */
  cliPid: number | null;
  sourceKind: SessionSourceKind;
  kind: SessionKind;
  latestEventId: number;
  retainedEventId: number;
  messageCount: number;
  lastReadAt: number;
  archivedAt?: string | null;
  /** Parent session id if this session was spawned via spawn_subagent. */
  parentSessionId?: string | null;
  /** tool_use id from the parent's stream that created this subagent. */
  parentToolUseId?: string | null;
  /**
   * Present only while `status === "blocked_on_human"`. Cleared back to
   * undefined when a human reply unblocks the session.
   */
  blockedOnHuman?: BlockedOnHumanInfo;
  lastInterruptionReason?: SessionInterruptionReason | null;
  lastInterruptionDetail?: string | null;
  /** Present while the session has a pending backend-owned wake trigger. */
  armedWakeup?: ArmedWakeupInfo | null;
  /** Present when this session has an active loop. */
  activeLoop?: LoopStatusInfo | null;
}

export type BackendSessionMetadata = SessionMetadata;

export interface CreateSessionRequest {
  projectPath: string;
  encodedProjectName?: string | null;
  sessionId?: string;
  providerSessionId?: string | null;
  model?: string;
  permissionMode?: PermissionMode;
  effort?: string;
  allowedTools?: string[];
  title?: string | null;
  kind?: SessionKind;
  parentSessionId?: string | null;
  parentToolUseId?: string | null;
}

export type CreateSessionResponse = SessionMetadata;

export interface SessionMessageRequest {
  message: string;
  requestId: string;
  triggerSource?: "user" | "cron" | "hook" | "loop";
  skipTranscript?: boolean;
  permissionMode?: PermissionMode;
  model?: string;
  effort?: string;
  allowedTools?: string[];
  attachments?: ImageAttachment[];
}

export interface SessionMessageResponse {
  requestId: string;
  /** True when the send was deferred into the session's pending queue. */
  queued?: boolean;
  /** Id of the queue entry when `queued` is true. */
  queuedId?: string;
}

/**
 * One pending message waiting to auto-dispatch when the current turn ends.
 * Stored server-side so it survives frontend close and is visible on every
 * device viewing the session.
 */
export interface QueuedMessage {
  id: string;
  message: string;
  createdAt: number;
  /** The original `requestId` the client generated. Reused when we dispatch. */
  requestId: string;
  triggerSource?: "user" | "cron" | "hook" | "loop";
  permissionMode?: PermissionMode;
  model?: string;
  effort?: string;
  allowedTools?: string[];
  attachments?: ImageAttachment[];
}

export interface QueueSnapshot {
  sessionId: string;
  queued: QueuedMessage[];
}

/** Max number of queued messages per session. Enforced at enqueue time. */
export const MAX_QUEUED_MESSAGES = 20;

export interface SessionAbortResponse {
  aborted: boolean;
}

export interface SessionReadyEvent {
  type: "session_ready";
  sessionId: string;
}

export interface SessionStatusEvent {
  type: "session_status";
  sessionId: string;
  status: SessionStatus;
}

export interface SessionStatusSnapshot {
  sessionId: string;
  status: SessionStatus;
  /**
   * Set on per-session "status" SSE frames when a session has paused for human
   * review. The payload carries the three articulated reasons the UI renders
   * in its blocked-on-human banner.
   */
  blockedOnHuman?: BlockedOnHumanInfo;
  interruptionReason?: SessionInterruptionReason;
  interruptionDetail?: string;
}

/**
 * Compatibility alias retained while the frontend migrates.
 */
export type SessionPhaseSnapshot = SessionStatusSnapshot;
export type SessionPhaseEvent = SessionStatusEvent;

export type SessionEvent = SessionReadyEvent | SessionStatusEvent;

/**
 * Legacy `/api/chat` request.
 * `sessionId` may be either a canonical SwarmFleet session id or a provider
 * session id.
 */
export interface ChatRequest {
  message: string;
  sessionId?: string;
  requestId: string;
  allowedTools?: string[];
  workingDirectory?: string;
  permissionMode?: PermissionMode;
  attachments?: ImageAttachment[];
  model?: string;
  effort?: string;
}

export interface AbortRequest {
  requestId: string;
}

export interface ProjectInfo {
  name: string;
  path: string;
  encodedName: string;
  features: ProjectFeatures;
  kind?: "workspace" | "system";
  gitEnabled?: boolean;
}

export interface ProjectsResponse {
  projects: ProjectInfo[];
}

export interface ConversationSummary {
  sessionId: string;
  title: string;
  startTime: string;
  lastTime: string;
  provider: ChatProvider;
  messageCount: number;
  lastMessagePreview: string;
  status?: SessionStatus;
  sourceKind?: SessionSourceKind;
  kind: SessionKind;
  parentSessionId?: string | null;
  parentToolUseId?: string | null;
  unreadBoundary?: number | null;
  armedWakeup?: ArmedWakeupInfo | null;
  activeLoop?: LoopStatusInfo | null;
}

/**
 * Events broadcast on the session-index SSE stream so connected clients can
 * keep their sidebar session list in sync without polling or refreshing.
 * - "created" fires for any new session.
 * - "updated" fires on rename and other metadata changes.
 * - "archived" fires when a session should be removed from the list.
 * - "status" fires when a session transitions between running / idle /
 *   awaiting_input / error / interrupted. Unlike the per-session stream,
 *   this fires for every session so the sidebar can show the correct
 *   indicator (spinner, waiting dot, unread badge) for background sessions
 *   the user hasn't opened.
 */
export interface VersionedEvent {
  version: number;
  eventId: string;
}

export type SessionIndexDeltaEvent =
  | {
      type: "session-created";
      projectPath: string;
      encodedProjectName: string | null;
      session: ConversationSummary;
    }
  | {
      type: "session-updated";
      projectPath: string;
      encodedProjectName: string | null;
      session: ConversationSummary;
    }
  | {
      type: "session-archived";
      projectPath: string;
      encodedProjectName: string | null;
      sessionId: string;
    }
  | {
      type: "session-status";
      projectPath: string;
      encodedProjectName: string | null;
      sessionId: string;
      status: SessionStatus;
      /** Milliseconds since epoch of the transition (metadata.updatedAt). */
      updatedAt: number;
      /** Most recent assistant output snippet (up to 200 chars). */
      lastMessagePreview?: string;
      unreadBoundary?: number | null;
      armedWakeup?: ArmedWakeupInfo | null;
      activeLoop?: LoopStatusInfo | null;
      /**
       * Present on transitions into `blocked_on_human` so the sidebar
       * indicator and any background tooltip can render the session's articulated
       * reason without re-fetching the session.
       */
      blockedOnHuman?: BlockedOnHumanInfo;
      interruptionReason?: SessionInterruptionReason;
      interruptionDetail?: string;
    }
  | {
      type: "notification";
      projectPath: string;
      encodedProjectName: string | null;
      sessionId: string;
      kind: "task-completion" | "awaiting-input" | "error" | "interrupted";
      occurredAt: number;
      title: string;
      body?: string;
    };
export type SessionIndexEvent = SessionIndexDeltaEvent & VersionedEvent;

export type SessionIndexSnapshotEvent = {
  type: "session-index-snapshot";
  sessions: Array<{
    projectPath: string;
    encodedProjectName: string | null;
    session: ConversationSummary;
  }>;
} & VersionedEvent;

export type SessionIndexStreamEvent =
  | SessionIndexEvent
  | SessionIndexSnapshotEvent;

export interface HistoryListResponse {
  conversations: ConversationSummary[];
}

/**
 * Messages are intentionally `unknown[]` because raw stored transcript items are
 * provider-shaped SDK envelopes.
 */
export interface ConversationHistory {
  sessionId: string;
  messages: unknown[];
  metadata: {
    startTime: string;
    endTime: string;
    messageCount: number;
  };
  page?: {
    /** Absolute zero-based index of messages[0] in the full transcript. */
    startIndex: number;
    /** Absolute zero-based index after the final returned message. */
    endIndex: number;
    /** True when older messages exist before startIndex. */
    hasMoreBefore: boolean;
  };
}

export interface TerminalHistoryEntry {
  type: "session_start" | "command" | "state_snapshot" | "session_end";
  ts: string;
  sessionId?: string;
  name?: string;
  cwd?: string;
  env?: Record<string, string>;
  input?: string;
  exitCode?: number | null;
  reason?: "killed" | "exited" | "server_shutdown";
}

export interface TerminalHistoryResponse {
  entries: TerminalHistoryEntry[];
}

// --- Loop types ---

export type LoopStrategy =
  | { type: "interval"; intervalMs: number }
  | { type: "on_idle"; cooldownMs: number }
  | { type: "hybrid"; cooldownMs: number; maxIdleMs: number }
  | { type: "burst"; count: number };

export type LoopState = "paused" | "running" | "completed" | "error";

export type LoopTerminationCondition =
  | { type: "max_iterations"; value: number }
  | { type: "max_duration_ms"; value: number }
  | { type: "content_match"; pattern: string }
  | { type: "consecutive_errors"; value: number };

export interface LoopConfig {
  id: string;
  sessionId: string;
  name: string;
  prompt: string;
  strategy: LoopStrategy;
  terminationConditions: LoopTerminationCondition[];
  state: LoopState;
  iterationCount: number;
  consecutiveErrorCount: number;
  createdAt: number;
  startedAt?: number;
  lastFiredAt?: number;
  lastCompletedAt?: number;
  pausedAt?: number;
  completedAt?: number;
  errorMessage?: string;
  permissionMode?: PermissionMode;
  model?: string;
  effort?: string;
}

export interface CreateLoopRequest {
  sessionId: string;
  name: string;
  prompt: string;
  strategy: LoopStrategy;
  terminationConditions?: LoopTerminationCondition[];
  permissionMode?: PermissionMode;
  model?: string;
  effort?: string;
}

export interface UpdateLoopRequest {
  name?: string;
  prompt?: string;
  strategy?: LoopStrategy;
  terminationConditions?: LoopTerminationCondition[];
  permissionMode?: PermissionMode;
  model?: string;
  effort?: string;
}

export interface LoopStatusInfo {
  id: string;
  sessionId: string;
  name: string;
  state: LoopState;
  iterationCount: number;
  strategy: LoopStrategy;
  terminationConditions: LoopTerminationCondition[];
  createdAt: number;
  startedAt?: number;
  lastFiredAt?: number;
  completedAt?: number;
  errorMessage?: string;
}
