import type {
  AllMessage,
  ChatMessage,
  CompactMessage,
  ImageMessage,
  ThinkingMessage,
  SDKMessage,
  TimestampedSDKMessage,
  SubagentLaneMessage,
} from "../types";
import type { ConversationImageAsset } from "@shared/types";
import {
  convertSystemMessage,
  convertResultMessage,
  convertImageMessage,
  createToolMessage,
  createToolResultMessage,
  createThinkingMessage,
  createTodoMessageFromInput,
} from "./messageConversion";
import { isThinkingContentItem } from "./messageTypes";
import { extractToolInfo, generateToolPatterns } from "./toolUtils";
import { detectRateLimitFromText } from "./rateLimitDetect";
import { recordRateLimit } from "../stores/rateLimitStatus";

interface ToolCache {
  name: string;
  input: Record<string, unknown>;
}

function stringifyToolResultContent(content: unknown): string {
  if (typeof content === "string") return content;

  if (Array.isArray(content)) {
    const pieces: string[] = [];
    for (const item of content) {
      if (typeof item === "string") {
        pieces.push(item);
        continue;
      }
      if (!item || typeof item !== "object") continue;
      const block = item as Record<string, unknown>;
      if (typeof block.text === "string") {
        pieces.push(block.text);
      } else if (typeof block.content === "string") {
        pieces.push(block.content);
      }
    }
    if (pieces.length > 0) return pieces.join("\n");
  }

  if (content && typeof content === "object") {
    const obj = content as Record<string, unknown>;
    if (typeof obj.text === "string") return obj.text;
    if (typeof obj.content === "string") return obj.content;
  }

  return JSON.stringify(content);
}

function extractSubagentIdFromSpawnResult(content: string): string | null {
  // spawn_subagent's MCP wrapper stringifies `{ subagent_id: "..." }` into
  // the content field. The Claude CLI sometimes further wraps tool_result
  // content in its own JSON envelope, so be lenient.
  const extractValue = (value: unknown, depth = 0): string | null => {
    if (depth > 4) return null;
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!trimmed) return null;
      if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        try {
          const inner = extractValue(JSON.parse(trimmed), depth + 1);
          if (inner) return inner;
        } catch {
          // Not JSON — try the regex fallback below.
        }
      }
      const match = value.match(/"subagent_id"\s*:\s*"([^"]+)"/);
      return match ? match[1] : null;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        const inner = extractValue(item, depth + 1);
        if (inner) return inner;
      }
      return null;
    }
    if (value && typeof value === "object") {
      const obj = value as Record<string, unknown>;
      if (typeof obj.subagent_id === "string" && obj.subagent_id) {
        return obj.subagent_id;
      }
      if (Array.isArray(obj.content)) {
        const inner = extractValue(obj.content, depth + 1);
        if (inner) return inner;
      }
      if (typeof obj.text === "string") {
        const inner = extractValue(obj.text, depth + 1);
        if (inner) return inner;
      }
      if (typeof obj.result === "string") {
        const inner = extractValue(obj.result, depth + 1);
        if (inner) return inner;
      }
    }
    return null;
  };

  try {
    const parsed = extractValue(JSON.parse(content));
    if (parsed) return parsed;
  } catch {
    // Not JSON — fall through.
  }
  const match = content.match(/"subagent_id"\s*:\s*"([^"]+)"/);
  return match ? match[1] : null;
}

function getSubagentIdFromMonitorInput(
  input?: Record<string, unknown>,
): string | null {
  if (!input) return null;
  const raw = input.subagent_id;
  return typeof raw === "string" && raw ? raw : null;
}

function isSwarmFleetSpawnSubagentTool(toolName: string): boolean {
  return toolName === "mcp__swarmfleet__spawn_subagent";
}

function isSwarmFleetMonitorSubagentTool(toolName: string): boolean {
  return toolName === "mcp__swarmfleet__monitor_subagent";
}

function parseMonitorResult(content: string): {
  status?: string;
  result?: string;
  error?: string;
} {
  const parseValue = (
    value: unknown,
    depth = 0,
  ): { status?: string; result?: string; error?: string } => {
    if (depth > 4) return {};

    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!trimmed) return { result: "" };
      if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        try {
          return parseValue(JSON.parse(trimmed), depth + 1);
        } catch {
          // Surface non-JSON strings as normal result text.
        }
      }
      return { result: value };
    }

    if (Array.isArray(value)) {
      for (const block of value) {
        const parsed = parseValue(block, depth + 1);
        if (parsed.status || parsed.result || parsed.error) return parsed;
      }
      return {};
    }

    if (value && typeof value === "object") {
      const obj = value as Record<string, unknown>;
      // The MCP server wraps the JSON in a content array; unwrap if present.
      if (Array.isArray(obj.content)) {
        const inner = parseValue(obj.content, depth + 1);
        if (inner.status || inner.result || inner.error) return inner;
      }
      if (typeof obj.text === "string") {
        const inner = parseValue(obj.text, depth + 1);
        if (inner.status || inner.result || inner.error) return inner;
      }
      return {
        status: typeof obj.status === "string" ? obj.status : undefined,
        result: typeof obj.result === "string" ? obj.result : undefined,
        error: typeof obj.error === "string" ? obj.error : undefined,
      };
    }

    return {};
  };

  try {
    const parsed = parseValue(JSON.parse(content));
    if (parsed.status || parsed.result || parsed.error) return parsed;
  } catch {
    // Not JSON — surface the raw string as result/error.
  }
  return { result: content };
}

function parsePostedImageResult(content: string): {
  asset?: ConversationImageAsset;
  caption?: string;
} {
  const parseValue = (
    value: unknown,
    depth = 0,
  ): { asset?: ConversationImageAsset; caption?: string } => {
    if (depth > 4) return {};

    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!trimmed) return {};
      if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        try {
          return parseValue(JSON.parse(trimmed), depth + 1);
        } catch {
          return {};
        }
      }
      return {};
    }

    if (Array.isArray(value)) {
      for (const block of value) {
        const parsed = parseValue(block, depth + 1);
        if (parsed.asset) return parsed;
      }
      return {};
    }

    if (value && typeof value === "object") {
      const obj = value as Record<string, unknown>;
      if (Array.isArray(obj.content)) {
        const parsed = parseValue(obj.content, depth + 1);
        if (parsed.asset) return parsed;
      }
      if (typeof obj.text === "string") {
        const parsed = parseValue(obj.text, depth + 1);
        if (parsed.asset) return parsed;
      }
      const asset = obj.asset;
      if (asset && typeof asset === "object") {
        return {
          asset: asset as ConversationImageAsset,
          caption: typeof obj.caption === "string" ? obj.caption : undefined,
        };
      }
    }

    return {};
  };

  return parseValue(content);
}

type StatefulSubagentLaneMessage = SubagentLaneMessage & {
  agentType?: string;
  state?: "running" | "complete" | "error";
  startedAt?: number;
  completedAt?: number;
  error?: string;
};

export interface ProcessingContext {
  addMessage: (message: AllMessage) => void;
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
  /**
   * For SwarmFleet custom subagents only: record the child session id on an
   * already-rendered lane so the user can click through to inspect the
   * child. Called when spawn_subagent's tool_result arrives.
   */
  attachSubagentIdToLane?: (toolUseId: string, subagentId: string) => void;
  /**
   * For SwarmFleet custom subagents only: complete / fail the lane keyed by the
   * child session id (not the spawn tool_use id). Called when
   * monitor_subagent's tool_result arrives, which happens long after the
   * original spawn.
   */
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
  currentAssistantMessage?: ChatMessage | null;
  setCurrentAssistantMessage?: (message: ChatMessage | null) => void;
  onSessionId?: (sessionId: string) => void;
  hasReceivedInit?: boolean;
  setHasReceivedInit?: (received: boolean) => void;
  shouldShowInitMessage?: () => boolean;
  onInitMessageShown?: () => void;
  onPermissionError?: (
    toolName: string,
    patterns: string[],
    toolUseId: string,
  ) => void;
  onPlanApproval?: (content: string, toolUseId: string) => void;
  onAbortRequest?: () => void;
  sourceMessage?: SDKMessage | TimestampedSDKMessage;
}

export interface ProcessingOptions {
  isStreaming?: boolean;
  timestamp?: number;
}

export class UnifiedMessageProcessor {
  private toolUseCache = new Map<string, ToolCache>();
  // Set when a compact_boundary arrives; causes the *next* user message to
  // be folded into the last compact message's `summary` instead of rendering
  // as a chat bubble.
  private pendingCompactBoundary = false;

  public clearCache(): void {
    this.toolUseCache.clear();
    this.pendingCompactBoundary = false;
  }

  private cacheToolUse(
    id: string,
    name: string,
    input: Record<string, unknown>,
  ): void {
    this.toolUseCache.set(id, { name, input });
  }

  private getCachedToolInfo(id: string): ToolCache | undefined {
    return this.toolUseCache.get(id);
  }

  private handlePermissionError(
    toolUseId: string,
    context: ProcessingContext,
  ): void {
    if (context.onAbortRequest) context.onAbortRequest();

    const cachedToolInfo = this.getCachedToolInfo(toolUseId);
    const { toolName, commands } = extractToolInfo(
      cachedToolInfo?.name,
      cachedToolInfo?.input,
    );
    const patterns = generateToolPatterns(toolName, commands);

    if (context.onPermissionError) {
      context.onPermissionError(toolName, patterns, toolUseId);
    }
  }

  private getMessageVisibilityMetadata(
    message?: SDKMessage | TimestampedSDKMessage,
  ): {
    trigger_source?: "user" | "cron" | "hook" | "loop";
    visible_to_user?: boolean;
  } {
    if (!message) {
      return {};
    }
    return {
      trigger_source: message.trigger_source,
      visible_to_user: message.visible_to_user,
    };
  }

  private processToolResult(
    contentItem: {
      tool_use_id?: string;
      content: unknown;
      is_error?: boolean;
      swarmfleetAssets?: unknown;
    },
    context: ProcessingContext,
    options: ProcessingOptions,
    toolUseResult?: unknown,
  ): void {
    const content = stringifyToolResultContent(contentItem.content);
    const toolUseId = contentItem.tool_use_id || "";
    const cachedToolInfo = this.getCachedToolInfo(toolUseId);
    const toolName = cachedToolInfo?.name || "Tool";
    const completedAt = options.timestamp || Date.now();
    const metadata = this.getMessageVisibilityMetadata(context.sourceMessage);

    // Legacy: native Claude `Agent` tool. Kept so sessions that ran before
    // the MCP subagent feature still render cleanly. Our own tools
    // (mcp__swarmfleet__*) flow through the branches below.
    if (toolName === "Agent") {
      if (contentItem.is_error === true) {
        context.failSubagentLane?.(toolUseId, content, completedAt);
      } else {
        context.completeSubagentLane?.(toolUseId, content, completedAt);
      }
      return;
    }

    if (isSwarmFleetSpawnSubagentTool(toolName)) {
      // Success means the child was dispatched, not that it finished. Parse
      // the returned JSON, attach the subagent id to the lane, and leave it
      // in "running" state. The real completion arrives via
      // monitor_subagent's tool_result below.
      if (contentItem.is_error === true) {
        context.failSubagentLane?.(toolUseId, content, completedAt);
        return;
      }
      const subagentId = extractSubagentIdFromSpawnResult(content);
      if (subagentId) {
        context.attachSubagentIdToLane?.(toolUseId, subagentId);
      }
      return;
    }

    if (isSwarmFleetMonitorSubagentTool(toolName)) {
      const subagentId = getSubagentIdFromMonitorInput(cachedToolInfo?.input);
      if (!subagentId) {
        // Fall through to regular tool-result rendering so the user can at
        // least see what came back.
      } else {
        const parsed = parseMonitorResult(content);
        if (contentItem.is_error === true || parsed.status === "error") {
          context.failSubagentLaneBySubagentId?.(
            subagentId,
            parsed.error ?? content,
            completedAt,
          );
        } else {
          context.completeSubagentLaneBySubagentId?.(
            subagentId,
            parsed.result ?? "",
            completedAt,
          );
        }
        return;
      }
    }

    if (
      toolName === "mcp__swarmfleet__post_latest_screenshot" ||
      toolName === "mcp__swarmfleet__post_image"
    ) {
      const parsed = parsePostedImageResult(content);
      if (parsed.asset) {
        const imageMessage: ImageMessage = {
          type: "image",
          role: "assistant",
          asset: parsed.asset,
          caption: parsed.caption,
          timestamp: completedAt,
          ...metadata,
        };
        context.addMessage(imageMessage);
        return;
      }
    }

    if (toolName === "TodoWrite") return;

    const toolResultMessage = createToolResultMessage(
      toolName,
      content,
      options.timestamp,
      toolUseResult,
      metadata,
      cachedToolInfo?.input,
      toolUseId,
      Array.isArray(contentItem.swarmfleetAssets)
        ? (contentItem.swarmfleetAssets as never)
        : undefined,
    );
    context.addMessage(toolResultMessage);
  }

  private handleAssistantText(
    contentItem: { text?: string },
    message: Extract<SDKMessage | TimestampedSDKMessage, { type: "assistant" }>,
    context: ProcessingContext,
    options: ProcessingOptions,
  ): void {
    if (!options.isStreaming) return;

    let messageToUpdate = context.currentAssistantMessage;

    if (!messageToUpdate) {
      messageToUpdate = {
        type: "chat",
        role: "assistant",
        content: "",
        timestamp: options.timestamp || Date.now(),
        trigger_source: message.trigger_source,
        visible_to_user: message.visible_to_user,
      };
      context.setCurrentAssistantMessage?.(messageToUpdate);
      context.addMessage(messageToUpdate);
    }

    const updatedContent =
      (messageToUpdate.content || "") + (contentItem.text || "");
    const updatedMessage = { ...messageToUpdate, content: updatedContent };
    context.setCurrentAssistantMessage?.(updatedMessage);
    context.updateLastMessage?.(updatedContent);
  }

  private handleToolUse(
    contentItem: {
      id?: string;
      name?: string;
      input?: Record<string, unknown>;
    },
    context: ProcessingContext,
    options: ProcessingOptions,
  ): void {
    if (options.isStreaming) {
      context.setCurrentAssistantMessage?.(null);
    }

    if (contentItem.id && contentItem.name) {
      this.cacheToolUse(
        contentItem.id,
        contentItem.name,
        contentItem.input || {},
      );
    }

    if (contentItem.name === "ExitPlanMode") {
      const metadata = this.getMessageVisibilityMetadata(context.sourceMessage);
      const planContent = (contentItem.input?.plan as string) || "";
      const toolUseId = contentItem.id || "";
      context.addMessage({
        type: "plan" as const,
        plan: planContent,
        toolUseId,
        timestamp: options.timestamp || Date.now(),
        ...metadata,
      });
      // The Claude CLI pauses after emitting ExitPlanMode in plan mode — the
      // stream ends naturally, no client-side abort needed. Just surface the
      // plan content to the approval state so the plan bubble can render its
      // approve button.
      if (options.isStreaming && context.onPlanApproval) {
        context.onPlanApproval(planContent, toolUseId);
      }
    } else if (contentItem.name === "TodoWrite") {
      const metadata = this.getMessageVisibilityMetadata(context.sourceMessage);
      const todoMessage = createTodoMessageFromInput(
        contentItem.input || {},
        options.timestamp,
        metadata,
      );
      if (todoMessage) {
        context.addMessage(todoMessage);
      } else {
        context.addMessage(
          createToolMessage(contentItem, options.timestamp, metadata),
        );
      }
    } else if (
      contentItem.name === "Agent" ||
      isSwarmFleetSpawnSubagentTool(contentItem.name ?? "")
    ) {
      const metadata = this.getMessageVisibilityMetadata(context.sourceMessage);
      const input = contentItem.input || {};
      const description =
        String(
          input.description || input.prompt || input.title || "",
        ).substring(0, 120) || "subagent";
      const agentType =
        contentItem.name === "Agent"
          ? String(input.subagent_type || "general-purpose")
          : "swarmfleet";
      const now = options.timestamp || Date.now();
      const laneMessage: StatefulSubagentLaneMessage = {
        type: "subagent_lane",
        toolUseId: contentItem.id || "",
        description,
        agentType,
        state: "running",
        startedAt: now,
        timestamp: now,
        ...metadata,
      };
      context.addMessage(laneMessage);
    } else if (isSwarmFleetMonitorSubagentTool(contentItem.name ?? "")) {
      // Intentionally hidden from the chat. The monitor call is bookkeeping —
      // it just waits for the child and its result feeds back into the
      // existing lane (see processToolResult). Rendering it as a tool card
      // would clutter the transcript with a confusing duplicate.
      return;
    } else if (contentItem.name === "AskUserQuestion") {
      const metadata = this.getMessageVisibilityMetadata(context.sourceMessage);
      context.addMessage(
        createToolMessage(contentItem, options.timestamp, metadata),
      );
      if (options.isStreaming) {
        this.handlePermissionError(contentItem.id || "", context);
      }
    } else {
      const metadata = this.getMessageVisibilityMetadata(context.sourceMessage);
      context.addMessage(
        createToolMessage(contentItem, options.timestamp, metadata),
      );
    }
  }

  private processSystemMessage(
    message: Extract<SDKMessage | TimestampedSDKMessage, { type: "system" }>,
    context: ProcessingContext,
    options: ProcessingOptions,
  ): void {
    const timestamp = options.timestamp || Date.now();

    if (options.isStreaming && message.subtype === "init") {
      context.setHasReceivedInit?.(true);
      const shouldShow = context.shouldShowInitMessage?.() ?? true;
      if (shouldShow) {
        context.addMessage(convertSystemMessage(message, timestamp));
        context.onInitMessageShown?.();
      }
      return;
    }

    // task_notification pings referencing a tool we already rendered add no
    // new information — hide them. When the referenced tool isn't in the
    // cache we fall through to the generic system rendering so nothing is
    // silently lost.
    if (message.subtype === "task_notification") {
      const rawToolUseId = (message as unknown as { tool_use_id?: unknown })
        .tool_use_id;
      const toolUseId = typeof rawToolUseId === "string" ? rawToolUseId : "";
      if (toolUseId && this.toolUseCache.has(toolUseId)) {
        return;
      }
      context.addMessage(convertSystemMessage(message, timestamp));
      return;
    }

    // Compaction lifecycle: turn the status/boundary trio into a single
    // CompactMessage that renders as a full-width line with an animation
    // while running and an expandable summary once done.
    if (message.subtype === "status") {
      const status = (message as { status?: unknown }).status;
      if (status === "compacting") {
        const compactMessage: CompactMessage = {
          type: "compact",
          state: "running",
          startedAt: timestamp,
          timestamp,
          ...this.getMessageVisibilityMetadata(message),
        };
        context.addMessage(compactMessage);
        return;
      }
      // Status-end frame (status: null) with a compact_result closes the
      // running compact message.
      const compactResult = (message as { compact_result?: unknown })
        .compact_result;
      if (compactResult !== undefined) {
        context.updateLastCompactMessage?.({
          state: "complete",
          completedAt: timestamp,
          compactResult:
            typeof compactResult === "string"
              ? compactResult
              : String(compactResult),
        });
        return;
      }
      // Unknown status frame — render generic so we don't silently drop it.
      context.addMessage(convertSystemMessage(message, timestamp));
      return;
    }

    if (message.subtype === "compact_boundary") {
      const meta = (message as { compact_metadata?: Record<string, unknown> })
        .compact_metadata;
      context.updateLastCompactMessage?.({
        state: "complete",
        completedAt: timestamp,
        preTokens:
          typeof meta?.pre_tokens === "number"
            ? (meta.pre_tokens as number)
            : undefined,
        postTokens:
          typeof meta?.post_tokens === "number"
            ? (meta.post_tokens as number)
            : undefined,
        durationMs:
          typeof meta?.duration_ms === "number"
            ? (meta.duration_ms as number)
            : undefined,
        trigger:
          typeof meta?.trigger === "string"
            ? (meta.trigger as string)
            : undefined,
      });
      this.pendingCompactBoundary = true;
      return;
    }

    context.addMessage(convertSystemMessage(message, timestamp));
  }

  private processAssistantMessage(
    message: Extract<SDKMessage | TimestampedSDKMessage, { type: "assistant" }>,
    context: ProcessingContext,
    options: ProcessingOptions,
  ): AllMessage[] {
    const timestamp = options.timestamp || Date.now();
    const messages: AllMessage[] = [];

    if (
      options.isStreaming &&
      context.hasReceivedInit &&
      message.session_id &&
      context.onSessionId
    ) {
      context.onSessionId(message.session_id);
    }

    const localContext = options.isStreaming
      ? { ...context, sourceMessage: message }
      : {
          ...context,
          sourceMessage: message,
          addMessage: (msg: AllMessage) => messages.push(msg),
        };

    let assistantContent = "";
    const thinkingMessages: ThinkingMessage[] = [];

    if (message.message?.content && Array.isArray(message.message.content)) {
      for (const item of message.message.content) {
        if (item.type === "text") {
          if (options.isStreaming) {
            this.handleAssistantText(item, message, context, options);
          } else {
            assistantContent += (item as { text: string }).text;
          }
        } else if (item.type === "tool_use") {
          this.handleToolUse(item, localContext, options);
        } else if (isThinkingContentItem(item)) {
          if (!item.thinking.trim()) continue;
          const thinkingMessage = createThinkingMessage(
            item.thinking,
            timestamp,
            this.getMessageVisibilityMetadata(message),
          );
          if (options.isStreaming) {
            context.addMessage(thinkingMessage);
          } else {
            thinkingMessages.push(thinkingMessage);
          }
        }
      }
    }

    if (!options.isStreaming) {
      const orderedMessages: AllMessage[] = [];
      orderedMessages.push(...thinkingMessages);
      orderedMessages.push(...messages);
      if (assistantContent.trim()) {
        const assistantMessage: ChatMessage = {
          type: "chat",
          role: "assistant",
          content: assistantContent.trim(),
          timestamp,
          trigger_source: message.trigger_source,
          visible_to_user: message.visible_to_user,
        };
        orderedMessages.push(assistantMessage);
      }
      return orderedMessages;
    }

    return messages;
  }

  private processResultMessage(
    message: Extract<SDKMessage | TimestampedSDKMessage, { type: "result" }>,
    context: ProcessingContext,
    options: ProcessingOptions,
  ): void {
    const timestamp = options.timestamp || Date.now();

    // Treat error result messages as a rate-limit signal when the text matches.
    // The SDK's result payload carries `is_error`, `subtype`, and `result`
    // text on the loosely-typed index signature — read them defensively.
    const raw = message as Record<string, unknown>;
    const isError = raw.is_error === true;
    const subtype = typeof raw.subtype === "string" ? raw.subtype : "";
    if (isError || subtype.startsWith("error")) {
      const text = [
        typeof raw.result === "string" ? raw.result : "",
        typeof raw.error === "string" ? raw.error : "",
        subtype,
      ]
        .filter(Boolean)
        .join(" ");
      const detected = detectRateLimitFromText(text, timestamp);
      if (detected) {
        // Use the message's own timestamp so the store's ordering guard can
        // suppress replays of old errors that would otherwise clobber a
        // newer rate_limit_event reading.
        recordRateLimit(
          "claude",
          detected as unknown as Record<string, unknown>,
          timestamp,
        );
      }
    }

    context.addMessage(convertResultMessage(message, timestamp));
    if (options.isStreaming) {
      context.setCurrentAssistantMessage?.(null);
    }
  }

  private processUserMessage(
    message: Extract<SDKMessage | TimestampedSDKMessage, { type: "user" }>,
    context: ProcessingContext,
    options: ProcessingOptions,
  ): AllMessage[] {
    const timestamp = options.timestamp || Date.now();
    const messages: AllMessage[] = [];

    const localContext = options.isStreaming
      ? { ...context, sourceMessage: message }
      : {
          ...context,
          sourceMessage: message,
          addMessage: (msg: AllMessage) => messages.push(msg),
        };

    const messageContent = message.message.content;
    let hasUserVisibleContent = false;

    // If we're sitting on a pending compact boundary, the very next user
    // message *is* the compaction summary — fold it into the last compact
    // message instead of rendering a bubble.
    const consumeForCompact = (text: string): boolean => {
      if (!this.pendingCompactBoundary) return false;
      if (!text || !text.trim()) return false;
      this.pendingCompactBoundary = false;
      localContext.updateLastCompactMessage?.({ summary: text });
      return true;
    };

    if (Array.isArray(messageContent)) {
      const containsToolResult = messageContent.some(
        (contentItem) => contentItem.type === "tool_result",
      );
      for (const contentItem of messageContent) {
        if (contentItem.type === "tool_result") {
          const toolUseResult = (message as { toolUseResult?: unknown })
            .toolUseResult;
          this.processToolResult(
            contentItem as {
              tool_use_id?: string;
              content: unknown;
              is_error?: boolean;
            },
            localContext,
            options,
            toolUseResult,
          );
        } else if (contentItem.type === "text") {
          if (containsToolResult) {
            continue;
          }
          const text = (contentItem as { text: string }).text;
          if (consumeForCompact(text)) {
            hasUserVisibleContent = true; // suppresses the early-return below
            continue;
          }
          const assets = (message as { assets?: ConversationImageAsset[] })
            .assets;
          localContext.addMessage({
            type: "chat",
            role: "user",
            content: text,
            timestamp,
            ...(assets && assets.length > 0 ? { assets } : {}),
            ...this.getMessageVisibilityMetadata(message),
          });
          hasUserVisibleContent = true;
        }
      }
      if (!hasUserVisibleContent) {
        return messages;
      }
    } else if (typeof messageContent === "string" && messageContent.trim()) {
      if (consumeForCompact(messageContent)) {
        return messages;
      }
      // Tool-result-only user payloads are handled above and should not render
      // as a user chat bubble.
      const assets = (message as { assets?: ConversationImageAsset[] }).assets;
      localContext.addMessage({
        type: "chat",
        role: "user",
        content: messageContent,
        timestamp,
        ...(assets && assets.length > 0 ? { assets } : {}),
        ...this.getMessageVisibilityMetadata(message),
      });
    }

    return messages;
  }

  public processMessage(
    message: SDKMessage | TimestampedSDKMessage,
    context: ProcessingContext,
    options: ProcessingOptions = {},
  ): AllMessage[] {
    const timestamp =
      options.timestamp ||
      ("timestamp" in message
        ? new Date(message.timestamp as string).getTime()
        : Date.now());

    const finalOptions = { ...options, timestamp };

    switch (message.type) {
      case "system":
        this.processSystemMessage(
          message as Extract<SDKMessage, { type: "system" }>,
          context,
          finalOptions,
        );
        return [];
      case "assistant":
        return this.processAssistantMessage(
          message as Extract<SDKMessage, { type: "assistant" }>,
          context,
          finalOptions,
        );
      case "result":
        this.processResultMessage(
          message as Extract<SDKMessage, { type: "result" }>,
          context,
          finalOptions,
        );
        return [];
      case "user":
        return this.processUserMessage(
          message as Extract<SDKMessage, { type: "user" }>,
          context,
          finalOptions,
        );
      case "image":
        context.addMessage(
          convertImageMessage(
            message as Extract<SDKMessage, { type: "image" }>,
            finalOptions.timestamp,
          ),
        );
        return [];
      default:
        // Silently ignore known metadata-only types emitted by Claude Code
        {
          const ignoredTypes = new Set([
            "queue-operation",
            "attachment",
            "rate_limit_event",
          ]);
          if (!ignoredTypes.has((message as { type: string }).type)) {
            console.warn(
              "Unknown message type:",
              (message as { type: string }).type,
            );
          }
        }
        return [];
    }
  }

  public processMessagesBatch(
    messages: TimestampedSDKMessage[],
    context?: Partial<ProcessingContext>,
  ): AllMessage[] {
    const allMessages: AllMessage[] = [];
    const laneIndexByToolUseId = new Map<string, number>();
    const laneIndexBySubagentId = new Map<string, number>();

    const setLaneAt = (
      idx: number | undefined,
      updates: Partial<StatefulSubagentLaneMessage>,
    ) => {
      if (idx === undefined) return;
      const existing = allMessages[idx];
      if (!existing || existing.type !== "subagent_lane") return;
      allMessages[idx] = {
        ...(existing as StatefulSubagentLaneMessage),
        ...updates,
      };
    };

    const completeSubagentLane = (
      toolUseId: string,
      result: string,
      completedAt?: number,
    ) => {
      setLaneAt(laneIndexByToolUseId.get(toolUseId), {
        result,
        state: "complete",
        completedAt: completedAt ?? Date.now(),
      });
    };

    const failSubagentLane = (
      toolUseId: string,
      error: string,
      completedAt?: number,
    ) => {
      setLaneAt(laneIndexByToolUseId.get(toolUseId), {
        error,
        state: "error",
        completedAt: completedAt ?? Date.now(),
      });
    };

    const attachSubagentIdToLane = (toolUseId: string, subagentId: string) => {
      const idx = laneIndexByToolUseId.get(toolUseId);
      setLaneAt(idx, { subagentId });
      if (idx !== undefined) laneIndexBySubagentId.set(subagentId, idx);
    };

    const completeSubagentLaneBySubagentId = (
      subagentId: string,
      result: string,
      completedAt?: number,
    ) => {
      setLaneAt(laneIndexBySubagentId.get(subagentId), {
        result,
        state: "complete",
        completedAt: completedAt ?? Date.now(),
      });
    };

    const failSubagentLaneBySubagentId = (
      subagentId: string,
      error: string,
      completedAt?: number,
    ) => {
      setLaneAt(laneIndexBySubagentId.get(subagentId), {
        error,
        state: "error",
        completedAt: completedAt ?? Date.now(),
      });
    };

    const updateLastCompactMessage = (updates: Partial<CompactMessage>) => {
      for (let idx = allMessages.length - 1; idx >= 0; idx -= 1) {
        if (allMessages[idx].type === "compact") {
          allMessages[idx] = {
            ...(allMessages[idx] as CompactMessage),
            ...updates,
          };
          return;
        }
      }
    };

    const appendMessage = (msg: AllMessage) => {
      const idx = allMessages.length;
      allMessages.push(msg);
      if (msg.type === "subagent_lane") {
        const lane = msg as SubagentLaneMessage;
        if (lane.toolUseId) laneIndexByToolUseId.set(lane.toolUseId, idx);
        if (lane.subagentId) laneIndexBySubagentId.set(lane.subagentId, idx);
      }
    };

    const batchContext: ProcessingContext = {
      ...context,
      addMessage: appendMessage,
      completeSubagentLane,
      failSubagentLane,
      attachSubagentIdToLane,
      completeSubagentLaneBySubagentId,
      failSubagentLaneBySubagentId,
      updateLastCompactMessage,
    };

    this.clearCache();

    for (const message of messages) {
      const processedMessages = this.processMessage(message, batchContext, {
        isStreaming: false,
        timestamp: new Date(message.timestamp).getTime(),
      });
      for (const processedMessage of processedMessages) {
        appendMessage(processedMessage);
      }
    }

    return allMessages;
  }
}
