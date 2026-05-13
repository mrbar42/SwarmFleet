import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tempDirs: string[] = [];
const originalEnv: Record<string, string | undefined> = {};

function captureEnv(name: string): void {
  if (!(name in originalEnv)) {
    originalEnv[name] = process.env[name];
  }
}

function restoreCapturedEnv(): void {
  for (const [name, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
}

beforeEach(async () => {
  vi.resetModules();
  const home = await mkdtemp(join(tmpdir(), "swarmfleet-token-home-"));
  tempDirs.push(home);

  captureEnv("HOME");
  captureEnv("SWARMFLEET_CHAT_SESSION_ROOT");
  captureEnv("SWARMFLEET_INTERNAL_TOKEN");

  process.env.HOME = home;
  delete process.env.SWARMFLEET_CHAT_SESSION_ROOT;
  delete process.env.SWARMFLEET_INTERNAL_TOKEN;
});

afterEach(async () => {
  restoreCapturedEnv();
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("getInternalSubagentToken", () => {
  it("persists the generated token across backend restarts", async () => {
    const tokenPath = join(
      process.env.HOME!,
      ".swarmfleet",
      "chat-sessions",
      ".internal-subagent-token",
    );
    const firstModule = await import("../handlers/internal/subagents.ts");
    const first = firstModule.getInternalSubagentToken();

    delete process.env.SWARMFLEET_INTERNAL_TOKEN;
    vi.resetModules();

    const secondModule = await import("../handlers/internal/subagents.ts");
    const second = secondModule.getInternalSubagentToken();

    expect(second).toBe(first);
    await expect(readFile(tokenPath, "utf-8")).resolves.toBe(`${first}\n`);
    expect((await stat(tokenPath)).mode & 0o777).toBe(0o600);
  });

  it("lets SWARMFLEET_INTERNAL_TOKEN explicitly override the durable token", async () => {
    const firstModule = await import("../handlers/internal/subagents.ts");
    const persisted = firstModule.getInternalSubagentToken();

    process.env.SWARMFLEET_INTERNAL_TOKEN = "explicit-token";
    vi.resetModules();

    const secondModule = await import("../handlers/internal/subagents.ts");
    const token = secondModule.getInternalSubagentToken();

    expect(token).toBe("explicit-token");
    expect(token).not.toBe(persisted);
  });
});
