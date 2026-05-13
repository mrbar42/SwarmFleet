import { Context } from "hono";
import { sessionManager } from "../../services/sessionManager.ts";

/**
 * Legacy compatibility route for request-id based aborts.
 */
export async function handleAbortRequest(c: Context) {
  const requestId = c.req.param("requestId");
  if (!requestId) {
    return c.json({ error: "requestId is required" }, 400);
  }

  const aborted = await sessionManager.abortByRequestId(requestId);
  if (!aborted) {
    return c.json({ error: "Request not found or not running" }, 404);
  }

  return c.json({ ok: true });
}
