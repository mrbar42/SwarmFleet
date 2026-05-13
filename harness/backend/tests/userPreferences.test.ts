import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UserPreferenceStore } from "../services/userPreferences.ts";

let configDir: string;

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), "swarmfleet-user-preferences-"));
});

afterEach(async () => {
  await rm(configDir, { recursive: true, force: true });
});

describe("user preference store", () => {
  it("preserves independent fields across concurrent updates", async () => {
    const store = new UserPreferenceStore(join(configDir, "preferences.json"));

    await Promise.all([
      store.update({ projectOrder: ["/workspace/b", "/workspace/a"] }),
      store.update({
        modelPopularity: {
          "claude-sonnet-4-5": { count: 3, lastUsed: 123 },
        },
      }),
    ]);

    const preferences = await store.read();
    expect(preferences).toEqual({
      version: 1,
      projectOrder: ["/workspace/b", "/workspace/a"],
      projectOrderUpdatedAt: expect.any(Number),
      modelPopularity: {
        "claude-sonnet-4-5": { count: 3, lastUsed: 123 },
      },
    });
    expect(preferences.projectOrderUpdatedAt).toBeGreaterThan(0);
  });

  it("normalizes malformed preference updates", async () => {
    const store = new UserPreferenceStore(join(configDir, "preferences.json"));

    await store.update({
      projectOrder: ["/workspace/a", " ", "/workspace/a", "/workspace/b"],
      projectOrderUpdatedAt: 123,
      modelPopularity: {
        good: { count: 2.9, lastUsed: 456 },
        zero: { count: -1, lastUsed: 0 },
        bad: { count: "lots", lastUsed: "never" },
      },
    });

    await expect(store.read()).resolves.toEqual({
      version: 1,
      projectOrder: ["/workspace/a", "/workspace/b"],
      projectOrderUpdatedAt: 123,
      modelPopularity: {
        good: { count: 2, lastUsed: 456 },
      },
    });
  });
});
