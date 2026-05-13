import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  handleToolsStatusRequest,
  handleToolsUpdateNowRequest,
  handleUpdateToolsConfigRequest,
} from "../handlers/shared/tools.ts";

let tempDir: string;
let oldHome: string | undefined;
let oldPath: string | undefined;
let oldToolsRoot: string | undefined;
let oldToolManagerPath: string | undefined;

function context(body?: unknown): Context {
  return {
    req: {
      json: async () => body ?? {},
    },
    json: (payload: unknown, status?: number) =>
      Response.json(payload, status ? { status } : undefined),
  } as unknown as Context;
}

async function executable(path: string, contents: string): Promise<void> {
  await writeFile(path, contents);
  await chmod(path, 0o755);
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "swarmfleet-tools-handlers-"));
  oldHome = process.env.HOME;
  oldPath = process.env.PATH;
  oldToolsRoot = process.env.SWARMFLEET_TOOLS_ROOT;
  oldToolManagerPath = process.env.SWARMFLEET_TOOL_MANAGER_PATH;
  process.env.HOME = tempDir;
  process.env.SWARMFLEET_TOOLS_ROOT = join(tempDir, ".swarmfleet", "tools");
});

afterEach(async () => {
  if (oldHome === undefined) delete process.env.HOME;
  else process.env.HOME = oldHome;
  if (oldPath === undefined) delete process.env.PATH;
  else process.env.PATH = oldPath;
  if (oldToolsRoot === undefined) delete process.env.SWARMFLEET_TOOLS_ROOT;
  else process.env.SWARMFLEET_TOOLS_ROOT = oldToolsRoot;
  if (oldToolManagerPath === undefined)
    delete process.env.SWARMFLEET_TOOL_MANAGER_PATH;
  else process.env.SWARMFLEET_TOOL_MANAGER_PATH = oldToolManagerPath;
  await rm(tempDir, { recursive: true, force: true });
});

describe("tools handlers", () => {
  it("reports live binary, version, auth, and config state", async () => {
    const binDir = join(tempDir, "bin");
    await rm(binDir, { recursive: true, force: true });
    await import("node:fs/promises").then(({ mkdir }) =>
      mkdir(binDir, { recursive: true }),
    );
    await executable(
      join(binDir, "hermes"),
      "#!/usr/bin/env bash\necho hermes live 1.2.3\n",
    );
    await import("node:fs/promises").then(({ mkdir }) =>
      mkdir(join(tempDir, ".hermes"), { recursive: true }),
    );
    await writeFile(join(tempDir, ".hermes", "auth.json"), "{}");
    process.env.PATH = `${binDir}:${oldPath ?? ""}`;

    let response = await handleUpdateToolsConfigRequest(
      context({ tools: { hermes: { enabled: false } } }),
    );
    expect(response.status).toBe(200);

    response = await handleToolsStatusRequest(context());
    expect(response.status).toBe(200);
    const status = await response.json();
    expect(status.tools.hermes).toMatchObject({
      enabled: false,
      installed: true,
      binaryPath: join(binDir, "hermes"),
      version: "hermes live 1.2.3",
      signedIn: true,
    });
  });

  it("persists controls updates and reflects them in status", async () => {
    const response = await handleUpdateToolsConfigRequest(
      context({
        autoUpdate: { enabled: false, frequencyDays: 14 },
        runtimes: { node: { enabled: false, versions: ["20", "22", "20"] } },
      }),
    );
    expect(response.status).toBe(200);

    const statusResponse = await handleToolsStatusRequest(context());
    const status = await statusResponse.json();
    expect(status.autoUpdate).toEqual({ enabled: false, frequencyDays: 14 });
    expect(status.runtimes.node.enabled).toBe(false);
    expect(status.runtimes.node.versions).toEqual(["20", "22"]);
  });

  it("returns a visible error when the update manager is missing", async () => {
    process.env.SWARMFLEET_TOOL_MANAGER_PATH = join(tempDir, "missing-manager");
    const response = await handleToolsUpdateNowRequest(context());
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("Tool manager is not executable"),
    });
  });

  it("starts update manager with the persisted tools root", async () => {
    const marker = join(tempDir, "manager-env.txt");
    const manager = join(tempDir, "manager.sh");
    await executable(
      manager,
      `#!/usr/bin/env bash\nprintf '%s %s' "$SWARMFLEET_TOOLS_ROOT" "$SWARMFLEET_TOOL_MANAGER_RUN_ONCE" > ${JSON.stringify(marker)}\n`,
    );
    process.env.SWARMFLEET_TOOL_MANAGER_PATH = manager;

    const response = await handleToolsUpdateNowRequest(context());
    expect(response.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const markerText = await import("node:fs/promises").then(({ readFile }) =>
      readFile(marker, "utf-8"),
    );
    expect(markerText).toBe(`${process.env.SWARMFLEET_TOOLS_ROOT} 1`);
  });
});
