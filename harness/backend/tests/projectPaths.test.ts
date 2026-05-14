import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ProjectPathError,
  validateExistingProjectPath,
} from "../utils/projectPaths.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
  vi.unstubAllEnvs();
});

async function tempRoot(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  const resolved = await realpath(dir);
  tempDirs.push(resolved);
  return resolved;
}

describe("project path validation", () => {
  it("accepts existing project directories inside the workspace root", async () => {
    const workspace = await tempRoot("swarmfleet-path-workspace-");
    const project = join(workspace, "demo");
    await mkdir(project);

    await expect(validateExistingProjectPath(project, workspace)).resolves.toBe(
      project,
    );
    await expect(validateExistingProjectPath("demo", workspace)).resolves.toBe(
      project,
    );
  });

  it("rejects existing directories outside the workspace root", async () => {
    const workspace = await tempRoot("swarmfleet-path-workspace-");
    const outside = await tempRoot("swarmfleet-path-outside-");

    await expect(
      validateExistingProjectPath(outside, workspace),
    ).rejects.toMatchObject({
      code: "outside_workspace",
    } satisfies Partial<ProjectPathError>);
  });

  it("accepts the configured harness system project outside the workspace root", async () => {
    const workspace = await tempRoot("swarmfleet-path-workspace-");
    const harness = await tempRoot("swarmfleet-path-harness-");
    vi.stubEnv("SWARMFLEET_HARNESS_DIR", harness);

    await expect(validateExistingProjectPath(harness, workspace)).resolves.toBe(
      harness,
    );
  });

  it("rejects symlinks that escape the workspace root", async () => {
    const workspace = await tempRoot("swarmfleet-path-workspace-");
    const outside = await tempRoot("swarmfleet-path-outside-");
    await symlink(outside, join(workspace, "escape"));

    await expect(
      validateExistingProjectPath(join(workspace, "escape"), workspace),
    ).rejects.toMatchObject({
      code: "outside_workspace",
    } satisfies Partial<ProjectPathError>);
  });
});
