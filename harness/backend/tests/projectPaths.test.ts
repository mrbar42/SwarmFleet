import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectPathError, validateExistingProjectPath } from "../utils/projectPaths.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempRoot(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe("project path validation", () => {
  it("accepts existing project directories inside the workspace root", async () => {
    const workspace = await tempRoot("swarmfleet-path-workspace-");
    const project = join(workspace, "demo");
    await mkdir(project);

    await expect(validateExistingProjectPath(project, workspace)).resolves.toBe(project);
    await expect(validateExistingProjectPath("demo", workspace)).resolves.toBe(project);
  });

  it("rejects existing directories outside the workspace root", async () => {
    const workspace = await tempRoot("swarmfleet-path-workspace-");
    const outside = await tempRoot("swarmfleet-path-outside-");

    await expect(validateExistingProjectPath(outside, workspace)).rejects.toMatchObject({
      code: "outside_workspace",
    } satisfies Partial<ProjectPathError>);
  });

  it("rejects symlinks that escape the workspace root", async () => {
    const workspace = await tempRoot("swarmfleet-path-workspace-");
    const outside = await tempRoot("swarmfleet-path-outside-");
    await symlink(outside, join(workspace, "escape"));

    await expect(validateExistingProjectPath(join(workspace, "escape"), workspace)).rejects.toMatchObject({
      code: "outside_workspace",
    } satisfies Partial<ProjectPathError>);
  });
});
