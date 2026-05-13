import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import {
  injectOpenRouterPolicy,
  registerOpenRouterClaudeProxyRoutes,
} from "../handlers/internal/openRouterClaudeProxy.ts";
import { getInternalSubagentToken } from "../handlers/internal/subagents.ts";
import { ProviderProfileStore } from "../services/providerProfiles.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConfigContext } from "../middleware/config.ts";

describe("OpenRouterClaude proxy", () => {
  it("injects data collection denial without selecting a provider", () => {
    expect(
      injectOpenRouterPolicy({
        model: "anthropic/claude-sonnet-4.5",
        messages: [],
      }),
    ).toEqual({
      model: "anthropic/claude-sonnet-4.5",
      messages: [],
      provider: {
        data_collection: "deny",
        zdr: true,
      },
    });
  });

  it("preserves existing provider routing while enforcing the data policy", () => {
    expect(
      injectOpenRouterPolicy({
        model: "anthropic/claude-sonnet-4.5",
        provider: {
          order: ["anthropic", "bedrock"],
          data_collection: "allow",
        },
      }),
    ).toEqual({
      model: "anthropic/claude-sonnet-4.5",
      provider: {
        order: ["anthropic", "bedrock"],
        data_collection: "deny",
        zdr: true,
      },
    });
  });

  it("can leave ZDR unset when that proxy option is disabled", () => {
    expect(
      injectOpenRouterPolicy(
        {
          model: "anthropic/claude-sonnet-4.5",
          provider: {
            order: ["anthropic", "bedrock"],
          },
        },
        { zdr: false },
      ),
    ).toEqual({
      model: "anthropic/claude-sonnet-4.5",
      provider: {
        order: ["anthropic", "bedrock"],
        data_collection: "deny",
      },
    });
  });

  it("forwards through the real proxy route with stored key and policy", async () => {
    const dir = await mkdtemp(join(tmpdir(), "swarmfleet-openrouter-proxy-"));
    const originalFetch = globalThis.fetch;
    try {
      const store = new ProviderProfileStore(join(dir, "profiles.json"));
      const profile = await store.createOpenRouterClaudeProfile({
        name: "OpenRouter",
        apiKey: "sk-stored",
        baseUrl: "https://openrouter.ai/api",
      });
      const app = new Hono<ConfigContext>();
      registerOpenRouterClaudeProxyRoutes(app, store);

      let capturedUrl = "";
      let capturedAuthorization: string | null = null;
      let capturedInternalToken: string | null = null;
      let capturedProfileId: string | null = null;
      let capturedBody: Record<string, unknown> | null = null;
      globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        capturedUrl = String(url);
        const capturedHeaders = new Headers(init?.headers);
        capturedAuthorization = capturedHeaders.get("authorization");
        capturedInternalToken = capturedHeaders.get("x-swarmfleet-internal-token");
        capturedProfileId = capturedHeaders.get("x-swarmfleet-openrouter-profile-id");
        capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response("ok", {
          status: 200,
          headers: { "content-type": "text/plain" },
        });
      }) as typeof fetch;

      const response = await app.request(
        "/internal/openrouter-claude-proxy/v1/messages?beta=1",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer caller-token",
            "x-swarmfleet-internal-token": getInternalSubagentToken(),
            "x-swarmfleet-openrouter-profile-id": profile.id,
          },
          body: JSON.stringify({
            model: "anthropic/claude-sonnet-4.5",
            messages: [],
            provider: { order: ["anthropic"] },
          }),
        },
      );

      expect(response.status).toBe(200);
      expect(capturedUrl).toBe(
        "https://openrouter.ai/api/v1/messages?beta=1",
      );
      expect(capturedAuthorization).toBe("Bearer sk-stored");
      expect(capturedInternalToken).toBeNull();
      expect(capturedProfileId).toBeNull();
      expect(capturedBody).toEqual({
        model: "anthropic/claude-sonnet-4.5",
        messages: [],
        provider: {
          order: ["anthropic"],
          data_collection: "deny",
          zdr: true,
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("preserves the actual OpenRouter error without triggering Claude's 404 model fallback", async () => {
    const dir = await mkdtemp(join(tmpdir(), "swarmfleet-openrouter-proxy-"));
    const originalFetch = globalThis.fetch;
    try {
      const store = new ProviderProfileStore(join(dir, "profiles.json"));
      const profile = await store.createOpenRouterClaudeProfile({
        name: "OpenRouter",
        apiKey: "sk-stored",
        baseUrl: "https://openrouter.ai/api",
      });
      const app = new Hono<ConfigContext>();
      registerOpenRouterClaudeProxyRoutes(app, store);

      const upstreamError = {
        error: {
          message:
            "No endpoints found that support data_collection=deny for qwen/qwen3.6-plus.",
          code: 404,
          metadata: { provider_name: "OpenRouter" },
        },
      };
      globalThis.fetch = (async () =>
        new Response(JSON.stringify(upstreamError), {
          status: 404,
          statusText: "Not Found",
          headers: {
            "content-type": "application/json",
            "x-openrouter-trace": "trace-1",
          },
        })) as typeof fetch;

      const response = await app.request(
        "/internal/openrouter-claude-proxy/v1/messages",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-swarmfleet-internal-token": getInternalSubagentToken(),
            "x-swarmfleet-openrouter-profile-id": profile.id,
          },
          body: JSON.stringify({
            model: "qwen/qwen3.6-plus",
            messages: [],
          }),
        },
      );

      expect(response.status).toBe(400);
      expect(response.statusText).toBe("Bad Request");
      expect(response.headers.get("content-type")).toContain(
        "application/json",
      );
      expect(response.headers.get("x-openrouter-trace")).toBe("trace-1");
      expect(await response.json()).toEqual({
        type: "error",
        error: {
          type: "invalid_request_error",
          message:
            "No endpoints found that support data_collection=deny for qwen/qwen3.6-plus.",
          upstream_status: 404,
          upstream_body: upstreamError,
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("includes transport failure detail when no upstream response is received", async () => {
    const dir = await mkdtemp(join(tmpdir(), "swarmfleet-openrouter-proxy-"));
    const originalFetch = globalThis.fetch;
    try {
      const store = new ProviderProfileStore(join(dir, "profiles.json"));
      const profile = await store.createOpenRouterClaudeProfile({
        name: "OpenRouter",
        apiKey: "sk-stored",
        baseUrl: "https://openrouter.ai/api",
      });
      const app = new Hono<ConfigContext>();
      registerOpenRouterClaudeProxyRoutes(app, store);

      globalThis.fetch = (async () => {
        throw new Error("socket hang up");
      }) as typeof fetch;

      const response = await app.request(
        "/internal/openrouter-claude-proxy/v1/messages",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-swarmfleet-internal-token": getInternalSubagentToken(),
            "x-swarmfleet-openrouter-profile-id": profile.id,
          },
          body: JSON.stringify({
            model: "qwen/qwen3.6-plus",
            messages: [],
          }),
        },
      );

      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({
        error: "proxy_request_failed",
        message: "socket hang up",
      });
    } finally {
      globalThis.fetch = originalFetch;
      await rm(dir, { recursive: true, force: true });
    }
  });
});
