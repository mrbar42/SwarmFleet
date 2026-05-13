import type { Hono } from "hono";
import type { ConfigContext } from "../../middleware/config.ts";
import {
  type ProviderProfileStore,
  providerProfileStore,
} from "../../services/providerProfiles.ts";
import { logger } from "../../utils/logger.ts";
import { checkInternalToken } from "./subagents.ts";

const PROXY_PREFIX = "/internal/openrouter-claude-proxy";
const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api";
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function normalizeBaseUrl(value: string | undefined): string {
  const trimmed = (value || DEFAULT_OPENROUTER_BASE_URL).replace(/\/+$/, "");
  return trimmed.endsWith("/api/v1") ? trimmed.slice(0, -3) : trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function injectOpenRouterPolicy(
  body: unknown,
  options: { zdr: boolean } = { zdr: true },
): unknown {
  if (!isRecord(body)) return body;
  const existingProvider = isRecord(body.provider) ? body.provider : {};
  return {
    ...body,
    provider: {
      ...existingProvider,
      data_collection: "deny",
      ...(options.zdr ? { zdr: true } : {}),
    },
  };
}

function forwardedRequestHeaders(
  incoming: Headers,
  apiKey: string,
  body: string | undefined,
): Headers {
  const headers = new Headers();
  incoming.forEach((value, key) => {
    const normalized = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(normalized)) return;
    if (normalized === "authorization") return;
    if (normalized === "x-api-key") return;
    if (normalized.startsWith("x-swarmfleet-")) return;
    headers.set(key, value);
  });
  headers.set("authorization", `Bearer ${apiKey}`);
  if (body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  return headers;
}

function forwardedResponseHeaders(incoming: Headers): Headers {
  const headers = new Headers();
  incoming.forEach((value, key) => {
    const normalized = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(normalized)) return;
    headers.set(key, value);
  });
  return headers;
}

function extractOpenRouterErrorMessage(body: unknown): string | null {
  if (!isRecord(body)) return null;
  const error = body.error;
  if (typeof error === "string" && error.trim()) return error.trim();
  if (isRecord(error)) {
    const message = error.message;
    if (typeof message === "string" && message.trim()) {
      return message.trim();
    }
    const code = error.code;
    if (typeof code === "string" && code.trim()) return code.trim();
  }
  const message = body.message;
  return typeof message === "string" && message.trim()
    ? message.trim()
    : null;
}

async function buildOpenRouterErrorResponse(response: Response): Promise<Response> {
  const rawBody = await response.text();
  let parsedBody: unknown = null;
  if (rawBody.trim()) {
    try {
      parsedBody = JSON.parse(rawBody);
    } catch {
      parsedBody = rawBody;
    }
  }
  const upstreamMessage =
    extractOpenRouterErrorMessage(parsedBody) ||
    rawBody.trim() ||
    `${response.status} ${response.statusText}`.trim();
  const headers = forwardedResponseHeaders(response.headers);
  headers.set("content-type", "application/json");
  const status = response.status === 404 ? 400 : response.status;
  const statusText =
    response.status === 404 ? "Bad Request" : response.statusText;
  return new Response(
    JSON.stringify({
      type: "error",
      error: {
        type: "invalid_request_error",
        message: upstreamMessage,
        upstream_status: response.status,
        upstream_body: parsedBody,
      },
    }),
    {
      status,
      statusText,
      headers,
    },
  );
}

export function registerOpenRouterClaudeProxyRoutes(
  app: Hono<ConfigContext>,
  store: ProviderProfileStore = providerProfileStore,
): void {
  app.all(`${PROXY_PREFIX}/*`, async (c) => {
    if (!checkInternalToken(c.req.header("x-swarmfleet-internal-token") ?? null)) {
      return c.json({ error: "unauthorized" }, 401);
    }

    const profileId = c.req.header("x-swarmfleet-openrouter-profile-id")?.trim();
    if (!profileId) return c.json({ error: "profile_required" }, 400);

    const settings = await store.getSettings();
    if (!settings.openRouterClaudeProxyEnabled) {
      return c.json({ error: "proxy_disabled" }, 403);
    }
    const zdrEnabled = settings.openRouterClaudeProxyZdrEnabled !== false;

    const profile = await store.getOpenRouterClaudeProfile(profileId);
    if (!profile?.apiKey) return c.json({ error: "profile_not_found" }, 404);

    const path = c.req.path.slice(PROXY_PREFIX.length) || "/";
    const targetUrl = new URL(`${normalizeBaseUrl(profile.baseUrl)}${path}`);
    const sourceUrl = new URL(c.req.url);
    targetUrl.search = sourceUrl.search;

    let body: string | undefined;
    const method = c.req.method.toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
      const raw = await c.req.text();
      if (raw.trim()) {
        const contentType = c.req.header("content-type") ?? "";
        if (contentType.toLowerCase().includes("json")) {
          try {
            body = JSON.stringify(
              injectOpenRouterPolicy(JSON.parse(raw), { zdr: zdrEnabled }),
            );
          } catch {
            body = raw;
          }
        } else {
          body = raw;
        }
      }
    }

    try {
      const response = await fetch(targetUrl, {
        method,
        headers: forwardedRequestHeaders(c.req.raw.headers, profile.apiKey, body),
        body,
        redirect: "manual",
      });
      if (!response.ok) {
        return await buildOpenRouterErrorResponse(response);
      }
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: forwardedResponseHeaders(response.headers),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.api.error("OpenRouterClaude proxy request failed: {error}", {
        error,
      });
      return c.json({ error: "proxy_request_failed", message }, 502);
    }
  });
}
