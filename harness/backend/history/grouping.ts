/**
 * Conversation grouping algorithm
 */

import type { ConversationSummary } from "../../shared/types.ts";
import type { ConversationFile } from "./parser.ts";
import { isSubset } from "./parser.ts";

/**
 * Group conversations and remove duplicates from continued sessions
 */
export function groupConversations(
  conversationFiles: ConversationFile[],
  customTitles?: Record<string, string>,
): ConversationSummary[] {
  if (conversationFiles.length === 0) {
    return [];
  }

  const sortedConversations = [...conversationFiles].sort((a, b) => {
    return a.messageIds.size - b.messageIds.size;
  });

  const uniqueConversations: ConversationFile[] = [];

  for (const currentConv of sortedConversations) {
    const isSubsetOfExisting = uniqueConversations.some((existingConv) =>
      isSubset(currentConv.messageIds, existingConv.messageIds),
    );

    if (!isSubsetOfExisting) {
      uniqueConversations.push(currentConv);
    }
  }

  const summaries = uniqueConversations.map((conv) =>
    createConversationSummary(conv, customTitles?.[conv.sessionId]),
  );

  summaries.sort(
    (a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime(),
  );

  return summaries;
}

function createConversationSummary(
  conversationFile: ConversationFile,
  customTitle?: string,
): ConversationSummary {
  return {
    sessionId: conversationFile.sessionId,
    title: customTitle || conversationFile.title,
    startTime: conversationFile.startTime,
    lastTime: conversationFile.lastTime,
    provider: "claude",
    messageCount: conversationFile.messageCount,
    lastMessagePreview: conversationFile.lastMessagePreview,
    kind: "chat",
  };
}
