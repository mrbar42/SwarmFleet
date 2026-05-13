import { Context } from "hono";
import type { HistoryListResponse } from "../../../shared/types.ts";
import { validateEncodedProjectName } from "../../history/pathUtils.ts";
import { sessionManager } from "../../services/sessionManager.ts";
import { logger } from "../../utils/logger.ts";

/**
 * Legacy compatibility routes backed by canonical app-owned sessions.
 */
export async function handleHistoriesRequest(c: Context) {
  try {
    const encodedProjectName = c.req.param("encodedProjectName");

    if (!encodedProjectName) {
      return c.json({ error: "Encoded project name is required" }, 400);
    }

    if (!validateEncodedProjectName(encodedProjectName)) {
      return c.json({ error: "Invalid encoded project name" }, 400);
    }

    const conversations = await sessionManager.listByEncodedProjectName(
      encodedProjectName,
    );

    return c.json({ conversations } satisfies HistoryListResponse);
  } catch (error) {
    logger.history.error("Error fetching conversation histories: {error}", {
      error,
    });

    return c.json(
      {
        error: "Failed to fetch conversation histories",
        details: error instanceof Error ? error.message : String(error),
      },
      500,
    );
  }
}

export async function handleArchiveSessionRequest(c: Context) {
  try {
    const encodedProjectName = c.req.param("encodedProjectName");
    const sessionId = c.req.param("sessionId");

    if (!encodedProjectName || !sessionId) {
      return c.json({ error: "Project name and session ID are required" }, 400);
    }

    if (!validateEncodedProjectName(encodedProjectName)) {
      return c.json({ error: "Invalid encoded project name" }, 400);
    }

    const session = await sessionManager.get(sessionId);
    if (!session || session.encodedProjectName !== encodedProjectName) {
      return c.json({ error: "Session not found" }, 404);
    }

    await sessionManager.archiveSession(sessionId);
    return c.json({ ok: true });
  } catch (error) {
    logger.history.error("Error archiving session: {error}", { error });
    return c.json({ error: "Failed to archive session" }, 500);
  }
}

export async function handleRenameSessionRequest(c: Context) {
  try {
    const encodedProjectName = c.req.param("encodedProjectName");
    const sessionId = c.req.param("sessionId");

    if (!encodedProjectName || !sessionId) {
      return c.json({ error: "Project name and session ID are required" }, 400);
    }

    if (!validateEncodedProjectName(encodedProjectName)) {
      return c.json({ error: "Invalid encoded project name" }, 400);
    }

    const body = await c.req.json<{ title?: string }>();
    const title = typeof body.title === "string" ? body.title.trim().substring(0, 120) : "";

    if (!title) {
      return c.json({ error: "Title is required" }, 400);
    }

    const session = await sessionManager.get(sessionId);
    if (!session || session.encodedProjectName !== encodedProjectName) {
      return c.json({ error: "Session not found" }, 404);
    }
    if (session.kind !== "chat") {
      return c.json({ error: "Only chat sessions can be renamed" }, 409);
    }

    const updated = await sessionManager.renameSession(sessionId, title);
    return c.json({ ok: true, title: updated.title });
  } catch (error) {
    logger.history.error("Error renaming session: {error}", { error });
    return c.json({ error: "Failed to rename session" }, 500);
  }
}
