import { mkdir, rm, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfigContext } from "../middleware/config.ts";
import { registerFileRoutes } from "../handlers/shared/files.ts";

let workspaceRoot: string;

beforeEach(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), "swarmfleet-files-routes-"));
  vi.stubEnv("WORKSPACES_ROOT", workspaceRoot);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(workspaceRoot, { recursive: true, force: true });
});

function buildApp() {
  const app = new Hono<ConfigContext>();
  registerFileRoutes(app);
  return app;
}

describe("files routes", () => {
  it("lists expanded directories by workspace-relative path", async () => {
    const projectPath = join(workspaceRoot, "demo");
    await mkdir(join(projectPath, "src"), { recursive: true });
    await writeFile(
      join(projectPath, "src", "main.ts"),
      "console.log('main');\n",
      "utf8",
    );
    await writeFile(join(projectPath, "README.md"), "# demo\n", "utf8");

    const app = buildApp();
    const rootResponse = await app.request(
      `/api/files/tree?path=${encodeURIComponent(projectPath)}`,
    );
    expect(rootResponse.status).toBe(200);
    const rootData = (await rootResponse.json()) as {
      entries: Array<{ name: string; path: string; type: string }>;
    };
    expect(rootData.entries).toContainEqual({
      name: "src",
      path: "demo/src",
      type: "directory",
    });

    const expandedResponse = await app.request(
      `/api/files/tree?path=${encodeURIComponent("demo/src")}`,
    );
    expect(expandedResponse.status).toBe(200);
    const expandedData = (await expandedResponse.json()) as {
      entries: Array<{
        name: string;
        path: string;
        type: string;
        size?: number;
      }>;
    };
    expect(expandedData.entries).toContainEqual({
      name: "main.ts",
      path: "demo/src/main.ts",
      type: "file",
      size: 21,
    });
  });

  it("reads preview content by workspace-relative path", async () => {
    await mkdir(join(workspaceRoot, "demo"), { recursive: true });
    await writeFile(
      join(workspaceRoot, "demo", "README.md"),
      "# demo\n",
      "utf8",
    );

    const app = buildApp();
    const response = await app.request(
      `/api/files/read?path=${encodeURIComponent("demo/README.md")}`,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      content: "# demo\n",
      extension: "md",
    });
  });
});
