import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const tempDirs: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.resetModules();
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe("terminal persistence", () => {
  it("stores terminal history under the persisted home state", async () => {
    const home = await tempDir("swarmfleet-terminal-home-");
    vi.stubEnv("HOME", home);
    vi.stubEnv("WORKSPACES_ROOT", "/workspace");

    const { persistSessionStart } = await import(
      "../utils/terminalPersistence.ts"
    );
    await persistSessionStart("term-test", "Terminal", "/workspace/project", {
      HOME: home,
    });

    const history = await readFile(
      join(home, ".swarmfleet", "terminal-history", "term-test.jsonl"),
      "utf-8",
    );
    expect(history).toContain('"type":"session_start"');
  });

  it("allows an explicit terminal history directory override", async () => {
    const home = await tempDir("swarmfleet-terminal-home-");
    const historyRoot = await tempDir("swarmfleet-terminal-history-");
    vi.stubEnv("HOME", home);
    vi.stubEnv("SWARMFLEET_TERMINAL_HISTORY_DIR", historyRoot);

    const { persistSessionStart } = await import(
      "../utils/terminalPersistence.ts"
    );
    await persistSessionStart("term-override", "Terminal", "/workspace", {});

    const history = await readFile(
      join(historyRoot, "term-override.jsonl"),
      "utf-8",
    );
    expect(history).toContain('"type":"session_start"');
  });
});
