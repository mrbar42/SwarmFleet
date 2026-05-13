/**
 * Timestamp restoration utilities
 */

import type { RawHistoryLine } from "./parser.ts";

/**
 * Preserve each JSONL line's timestamp.
 *
 * Claude can emit multiple assistant records with the same `message.id` as a
 * turn progresses through tool calls and final text. Rewriting all of those
 * records to the first timestamp moves later assistant output ahead of tool
 * results and terminal errors during history replay.
 */
export function restoreTimestamps(
  messages: RawHistoryLine[],
): RawHistoryLine[] {
  return messages;
}

/**
 * Sort messages by timestamp (chronological order)
 */
export function sortMessagesByTimestamp(
  messages: RawHistoryLine[],
): RawHistoryLine[] {
  return [...messages].sort((a, b) => {
    return new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
  });
}

/**
 * Calculate conversation metadata from messages
 */
export function calculateConversationMetadata(messages: RawHistoryLine[]): {
  startTime: string;
  endTime: string;
  messageCount: number;
} {
  if (messages.length === 0) {
    const now = new Date().toISOString();
    return {
      startTime: now,
      endTime: now,
      messageCount: 0,
    };
  }

  const sortedMessages = sortMessagesByTimestamp(messages);
  const startTime = sortedMessages[0].timestamp;
  const endTime = sortedMessages[sortedMessages.length - 1].timestamp;

  return {
    startTime,
    endTime,
    messageCount: messages.length,
  };
}

/**
 * Process messages with timestamp restoration and sorting
 */
export function processConversationMessages(
  messages: RawHistoryLine[],
  _sessionId: string,
): {
  messages: unknown[];
  metadata: {
    startTime: string;
    endTime: string;
    messageCount: number;
  };
} {
  const restoredMessages = restoreTimestamps(messages);
  const sortedMessages = sortMessagesByTimestamp(restoredMessages);
  const metadata = calculateConversationMetadata(sortedMessages);

  return {
    messages: sortedMessages as unknown[],
    metadata,
  };
}
