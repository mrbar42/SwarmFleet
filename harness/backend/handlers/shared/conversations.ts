import { Context } from "hono";
import { validateEncodedProjectName } from "../../history/pathUtils.ts";
import { sessionManager } from "../../services/sessionManager.ts";
import { logger } from "../../utils/logger.ts";

/**
 * Legacy compatibility route backed by canonical app-owned session transcripts.
 */
export async function handleConversationRequest(c: Context) {
  try {
    const encodedProjectName = c.req.param("encodedProjectName");
    const sessionId = c.req.param("sessionId");

    if (!encodedProjectName) {
      return c.json({ error: "Encoded project name is required" }, 400);
    }

    if (!sessionId) {
      return c.json({ error: "Session ID is required" }, 400);
    }

    if (!validateEncodedProjectName(encodedProjectName)) {
      return c.json({ error: "Invalid encoded project name" }, 400);
    }

    const session = await sessionManager.get(sessionId);
    if (!session || session.encodedProjectName !== encodedProjectName) {
      return c.json(
        {
          error: "Conversation not found",
          sessionId,
        },
        404,
      );
    }

    const conversationHistory = await sessionManager.getConversation(sessionId);
    if (!conversationHistory) {
      return c.json(
        {
          error: "Conversation not found",
          sessionId,
        },
        404,
      );
    }

    return c.json(conversationHistory);
  } catch (error) {
    logger.history.error("Error fetching conversation details: {error}", {
      error,
    });

    return c.json(
      {
        error: "Failed to fetch conversation details",
        details: error instanceof Error ? error.message : String(error),
      },
      500,
    );
  }
}
