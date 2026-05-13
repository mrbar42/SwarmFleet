import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { ChatSessionStore } from "../services/chatSessionStore.ts";
import { DetachedShellJobService } from "../services/detachedShellJobs.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function createFixture(): Promise<{
  projectDir: string;
  sessionId: string;
  service: DetachedShellJobService;
}> {
  const root = await mkdtemp(join(tmpdir(), "swarmfleet-shell-jobs-store-"));
  const projectDir = await mkdtemp(
    join(tmpdir(), "swarmfleet-shell-jobs-project-"),
  );
  tempDirs.push(root, projectDir);

  const store = new ChatSessionStore(root, { skipLegacyImport: true });
  await store.ensureInitialized();
  const session = await store.createSession({
    projectPath: projectDir,
    encodedProjectName: "shell-job-test",
  });

  return {
    projectDir,
    sessionId: session.sessionId,
    service: new DetachedShellJobService(store),
  };
}

async function waitForStatus(
  service: DetachedShellJobService,
  sessionId: string,
  jobId: string,
  status: string,
): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const job = await service.get(sessionId, jobId);
    if (job?.status === status) return;
    await setTimeout(100);
  }
  const latest = await service.get(sessionId, jobId);
  throw new Error(`Timed out waiting for ${status}; saw ${latest?.status}`);
}

describe("DetachedShellJobService", () => {
  it("runs a detached shell job and persists readable output", async () => {
    const { projectDir, sessionId, service } = await createFixture();

    const job = await service.run({
      sessionId,
      projectPath: projectDir,
      command: "printf 'hello detached shell\\n'",
      label: "hello",
    });

    expect(job.status).toBe("running");
    expect(job.pid).toBeGreaterThan(0);

    await waitForStatus(service, sessionId, job.jobId, "exited");
    const completed = await service.get(sessionId, job.jobId);

    expect(completed?.alive).toBe(false);
    expect(completed?.stdout).toContain("hello detached shell");
    expect(completed?.stderr).toBe("");
  });

  it("rejects cwd outside the session project", async () => {
    const { projectDir, sessionId, service } = await createFixture();

    await expect(
      service.run({
        sessionId,
        projectPath: projectDir,
        command: "pwd",
        cwd: "..",
      }),
    ).rejects.toThrow("cwd must stay inside");
  });

  it("kills a running detached job by job id", async () => {
    const { projectDir, sessionId, service } = await createFixture();
    await mkdir(join(projectDir, "nested"));

    const job = await service.run({
      sessionId,
      projectPath: projectDir,
      cwd: "nested",
      command: "sleep 30",
      label: "sleeper",
    });

    const killed = await service.kill(sessionId, job.jobId);

    expect(killed?.status).toBe("killed");
    expect(killed?.alive).toBe(false);
  });
});
