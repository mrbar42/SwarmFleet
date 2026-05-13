import { afterEach, describe, expect, it, vi } from "vitest";
import { callInternalJson, formatInternalBackendError } from "../mcp/bin.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("SwarmFleet MCP backend calls", () => {
  it("retries transient backend fetch failures before returning JSON", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await callInternalJson("/internal/health", {
      retry: { attempts: 2, baseDelayMs: 0 },
      backendUrl: "http://127.0.0.1:7080",
      internalToken: "token",
    });

    expect(result).toEqual({ ok: true, status: 200, json: { ok: true } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns a clear backend-unreachable error after retry exhaustion", async () => {
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(
        new TypeError("fetch failed"),
      ) as unknown as typeof fetch;

    const result = await callInternalJson("/internal/health", {
      retry: { attempts: 2, baseDelayMs: 0 },
      backendUrl: "http://127.0.0.1:7080",
      internalToken: "token",
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe(0);
    expect(result.json.error).toContain(
      "SwarmFleet backend unreachable at http://127.0.0.1:7080/internal/health",
    );
    expect(result.json.error).toContain("after 2 attempts");
    expect(result.json.error).toContain("fetch failed");
  });

  it("formats status 0 as backend unreachable instead of a generic status failure", () => {
    expect(
      formatInternalBackendError("monitor_subagent", {
        status: 0,
        json: {
          error:
            "SwarmFleet backend unreachable at http://127.0.0.1:7080/internal/subagents/child/wait after 3 attempts: fetch failed",
        },
      }),
    ).toBe(
      "monitor_subagent failed: SwarmFleet backend unreachable at http://127.0.0.1:7080/internal/subagents/child/wait after 3 attempts: fetch failed",
    );
  });
});
