import { createMiddleware } from "hono/factory";
import { deleteCookie } from "hono/cookie";
import {
  resolveSessionFromCookieHeader,
  touchSession,
} from "../services/authStore.ts";
import { getSessionCookieName } from "../lib/sessionCookie.ts";

export const requireAuth = createMiddleware<{
  Variables: { credentialId: string; sessionToken: string };
}>(async (c, next) => {
  const resolved = await resolveSessionFromCookieHeader(
    c.req.raw.headers.get("Cookie"),
  );
  if (!resolved) {
    deleteCookie(c, getSessionCookieName(), { path: "/" });
    return c.json({ error: "unauthorized" }, 401);
  }

  await touchSession(resolved.token);
  c.set("credentialId", resolved.session.credentialId);
  c.set("sessionToken", resolved.token);
  await next();
});
