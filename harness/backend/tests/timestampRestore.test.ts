import { describe, expect, it } from "vitest";

import { processConversationMessages } from "../history/timestampRestore.ts";
import type { RawHistoryLine } from "../history/parser.ts";

describe("processConversationMessages", () => {
  it("preserves chronological order for assistant lines that share a message id", () => {
    const messages: RawHistoryLine[] = [
      {
        type: "assistant",
        timestamp: "2026-04-22T00:00:01.000Z",
        uuid: "assistant-tool",
        sessionId: "session-id",
        message: {
          id: "msg_shared",
          role: "assistant",
          content: [{ type: "tool_use", name: "Bash" }],
        },
      },
      {
        type: "user",
        timestamp: "2026-04-22T00:00:02.000Z",
        uuid: "tool-result",
        sessionId: "session-id",
        message: {
          role: "user",
          content: [{ type: "tool_result", content: "tool output" }],
        },
      },
      {
        type: "assistant",
        timestamp: "2026-04-22T00:00:03.000Z",
        uuid: "assistant-summary",
        sessionId: "session-id",
        message: {
          id: "msg_shared",
          role: "assistant",
          content: [{ type: "text", text: "Tried a foreground Claude run" }],
        },
      },
      {
        type: "result",
        timestamp: "2026-04-22T00:00:04.000Z",
        uuid: "rate-limit",
        sessionId: "session-id",
      },
    ];

    const processed = processConversationMessages(messages, "session-id")
      .messages as RawHistoryLine[];

    expect(processed.map((message) => message.uuid)).toEqual([
      "assistant-tool",
      "tool-result",
      "assistant-summary",
      "rate-limit",
    ]);
  });
});
