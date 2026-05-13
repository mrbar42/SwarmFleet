import type {
  AllMessage,
  SystemMessage,
  ToolMessage,
  ToolResultMessage,
  ThinkingMessage,
  TodoMessage,
  TodoItem,
  SDKMessage,
  TimestampedSDKMessage,
  SDKImageMessage,
} from "../types";
import { MESSAGE_CONSTANTS } from "./constants";
import { formatToolArguments } from "./toolUtils";
import { UnifiedMessageProcessor } from "./UnifiedMessageProcessor";

type MessageVisibilityMetadata = {
  trigger_source?: "user" | "cron" | "hook" | "loop";
  visible_to_user?: boolean;
};

function generateSummary(content: string): string {
  if (content.includes("\n")) {
    const lines = content.split("\n").filter((line) => line.trim());
    if (lines.length > 0) {
      return `${lines.length} ${lines.length === 1 ? "line" : "lines"}`;
    }
  } else if (content.includes("Found")) {
    const match = content.match(/Found (\d+)/);
    if (match) return `Found ${match[1]}`;
  } else if (content.includes("files")) {
    const match = content.match(/(\d+)\s+files?/);
    if (match) return `${match[1]} files`;
  } else if (content.length < MESSAGE_CONSTANTS.SUMMARY_MAX_LENGTH) {
    return content.trim();
  }
  return `${content.length} chars`;
}

export function convertSystemMessage(
  claudeData: Extract<SDKMessage, { type: "system" }>,
  timestamp?: number,
): SystemMessage {
  return { ...claudeData, timestamp: timestamp ?? Date.now() };
}

export function convertResultMessage(
  claudeData: Extract<SDKMessage, { type: "result" }>,
  timestamp?: number,
): SystemMessage {
  return { ...claudeData, timestamp: timestamp ?? Date.now() };
}

export function createToolMessage(
  contentItem: { id?: string; name?: string; input?: Record<string, unknown> },
  timestamp?: number,
  metadata?: MessageVisibilityMetadata,
): ToolMessage {
  const toolName = contentItem.name || "Unknown";
  const argsDisplay = formatToolArguments(contentItem.input);
  return {
    type: "tool",
    content: `${toolName}${argsDisplay}`,
    toolName,
    toolUseId: contentItem.id,
    toolInput: contentItem.input,
    timestamp: timestamp ?? Date.now(),
    ...metadata,
  };
}

export function createToolResultMessage(
  toolName: string,
  content: string,
  timestamp?: number,
  toolUseResult?: unknown,
  metadata?: MessageVisibilityMetadata,
  toolInput?: Record<string, unknown>,
  toolUseId?: string,
  assets?: ToolResultMessage["assets"],
): ToolResultMessage {
  const summary = generateSummary(content);
  return {
    type: "tool_result",
    toolName,
    content,
    summary,
    timestamp: timestamp ?? Date.now(),
    toolUseId,
    toolInput,
    toolUseResult,
    ...(assets && assets.length > 0 ? { assets } : {}),
    ...metadata,
  };
}

export function convertImageMessage(
  imageData: SDKImageMessage,
  timestamp?: number,
) {
  return {
    type: "image" as const,
    role: imageData.role ?? "assistant",
    asset: imageData.asset,
    caption: imageData.caption,
    timestamp: timestamp ?? Date.now(),
    trigger_source: imageData.trigger_source,
    visible_to_user: imageData.visible_to_user,
  };
}

export function createThinkingMessage(
  thinkingContent: string,
  timestamp?: number,
  metadata?: MessageVisibilityMetadata,
): ThinkingMessage {
  return {
    type: "thinking",
    content: thinkingContent,
    timestamp: timestamp ?? Date.now(),
    ...metadata,
  };
}

function isValidTodoItem(item: unknown): item is TodoItem {
  if (typeof item !== "object" || item === null) return false;
  const obj = item as Record<string, unknown>;
  return (
    typeof obj.content === "string" &&
    typeof obj.status === "string" &&
    ["pending", "in_progress", "completed"].includes(obj.status) &&
    typeof obj.activeForm === "string"
  );
}

export function extractTodoDataFromInput(
  input: Record<string, unknown>,
): TodoItem[] | null {
  try {
    if (input.todos && Array.isArray(input.todos)) {
      if (input.todos.every(isValidTodoItem)) {
        return input.todos as TodoItem[];
      }
    }
  } catch {
    // ignore
  }
  return null;
}

export function createTodoMessageFromInput(
  input: Record<string, unknown>,
  timestamp?: number,
  metadata?: MessageVisibilityMetadata,
): TodoMessage | null {
  const todos = extractTodoDataFromInput(input);
  if (!todos) return null;
  return {
    type: "todo",
    todos,
    timestamp: timestamp ?? Date.now(),
    ...metadata,
  };
}

export function convertTimestampedSDKMessage(
  message: TimestampedSDKMessage,
): AllMessage[] {
  const processor = new UnifiedMessageProcessor();
  return processor.processMessage(
    message,
    { addMessage: () => {} },
    { isStreaming: false, timestamp: new Date(message.timestamp).getTime() },
  );
}

export function convertConversationHistory(
  timestampedMessages: TimestampedSDKMessage[],
): AllMessage[] {
  const processor = new UnifiedMessageProcessor();
  return processor.processMessagesBatch(timestampedMessages);
}
