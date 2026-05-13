import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import { ChatSessionStore } from "./chatSessionStore.ts";
import { logger } from "../utils/logger.ts";

const STORE_VERSION = 1;
const JOBS_DIR = "shell-jobs";
const INDEX_FILE = "index.json";
const ENV_SESSION_ID = "SWARMFLEET_SESSION_ID";
const ENV_JOB_ID = "SWARMFLEET_SHELL_JOB_ID";
const ENV_JOB_LABEL = "SWARMFLEET_SHELL_JOB_LABEL";
const MAX_COMMAND_LENGTH = 16_000;
const MAX_LABEL_LENGTH = 120;
const MAX_TAIL_BYTES = 64 * 1024;
const KILL_GRACE_MS = 2000;

type ShellJobStatus = "running" | "exited" | "killed" | "error";

interface ShellJobRecord {
  jobId: string;
  sessionId: string;
  command: string;
  cwd: string;
  label: string | null;
  pid: number;
  startedAt: number;
  updatedAt: number;
  status: ShellJobStatus;
  exitCode: number | null;
  signal: string | null;
  stdoutPath: string;
  stderrPath: string;
}

interface ShellJobStoreFile {
  version: number;
  jobs: ShellJobRecord[];
}

export interface DetachedShellJob extends ShellJobRecord {
  alive: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeRecord(value: unknown): ShellJobRecord | null {
  if (!isRecord(value)) return null;
  const jobId = typeof value.jobId === "string" ? value.jobId : "";
  const sessionId = typeof value.sessionId === "string" ? value.sessionId : "";
  const command = typeof value.command === "string" ? value.command : "";
  const cwd = typeof value.cwd === "string" ? value.cwd : "";
  const pid = typeof value.pid === "number" ? value.pid : NaN;
  if (!jobId || !sessionId || !command || !cwd || !Number.isFinite(pid)) {
    return null;
  }
  const status =
    value.status === "running" ||
    value.status === "exited" ||
    value.status === "killed" ||
    value.status === "error"
      ? value.status
      : "running";
  return {
    jobId,
    sessionId,
    command,
    cwd,
    label: typeof value.label === "string" ? value.label : null,
    pid,
    startedAt:
      typeof value.startedAt === "number" && Number.isFinite(value.startedAt)
        ? value.startedAt
        : Date.now(),
    updatedAt:
      typeof value.updatedAt === "number" && Number.isFinite(value.updatedAt)
        ? value.updatedAt
        : Date.now(),
    status,
    exitCode:
      typeof value.exitCode === "number" && Number.isFinite(value.exitCode)
        ? value.exitCode
        : null,
    signal: typeof value.signal === "string" ? value.signal : null,
    stdoutPath: typeof value.stdoutPath === "string" ? value.stdoutPath : "",
    stderrPath: typeof value.stderrPath === "string" ? value.stderrPath : "",
  };
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !rel.includes(`..${sep}`));
}

function trimLabel(label: unknown): string | null {
  if (typeof label !== "string") return null;
  const trimmed = label.trim();
  return trimmed ? trimmed.slice(0, MAX_LABEL_LENGTH) : null;
}

async function readProcFile(pid: number, file: string): Promise<Buffer | null> {
  try {
    return await readFile(`/proc/${pid}/${file}`);
  } catch {
    return null;
  }
}

function parseEnviron(raw: Buffer): Map<string, string> {
  const entries = new Map<string, string>();
  for (const entry of raw.toString("latin1").split("\0")) {
    const idx = entry.indexOf("=");
    if (idx <= 0) continue;
    entries.set(entry.slice(0, idx), entry.slice(idx + 1));
  }
  return entries;
}

async function isTaggedProcessAlive(
  pid: number,
  sessionId: string,
  jobId: string,
): Promise<boolean> {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  const environRaw = await readProcFile(pid, "environ");
  if (!environRaw) return false;
  const environ = parseEnviron(environRaw);
  return (
    environ.get(ENV_SESSION_ID) === sessionId &&
    environ.get(ENV_JOB_ID) === jobId
  );
}

async function findTaggedPids(
  sessionId: string,
  jobId: string,
): Promise<number[]> {
  let entries: string[];
  try {
    entries = await readdir("/proc");
  } catch {
    return [];
  }
  const pids: number[] = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number.parseInt(entry, 10);
    const environRaw = await readProcFile(pid, "environ");
    if (!environRaw) continue;
    const environ = parseEnviron(environRaw);
    if (
      environ.get(ENV_SESSION_ID) === sessionId &&
      environ.get(ENV_JOB_ID) === jobId
    ) {
      pids.push(pid);
    }
  }
  return pids;
}

async function terminatePid(pid: number): Promise<void> {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  await new Promise<void>((resolveWait) =>
    setTimeout(resolveWait, KILL_GRACE_MS),
  );
  try {
    process.kill(pid, 0);
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

async function readTail(
  path: string,
  maxBytes = MAX_TAIL_BYTES,
): Promise<string> {
  try {
    const bytes = await readFile(path);
    return bytes.length <= maxBytes
      ? bytes.toString("utf-8")
      : bytes.subarray(bytes.length - maxBytes).toString("utf-8");
  } catch {
    return "";
  }
}

export class DetachedShellJobService {
  private readonly store: ChatSessionStore;

  constructor(
    store = new ChatSessionStore(process.env.SWARMFLEET_CHAT_SESSION_ROOT),
  ) {
    this.store = store;
  }

  async run(args: {
    sessionId: string;
    projectPath: string;
    command: unknown;
    cwd?: unknown;
    label?: unknown;
  }): Promise<DetachedShellJob> {
    const command = typeof args.command === "string" ? args.command.trim() : "";
    if (!command) throw new Error("command is required");
    if (command.length > MAX_COMMAND_LENGTH) {
      throw new Error(`command cannot exceed ${MAX_COMMAND_LENGTH} characters`);
    }

    const projectPath = resolve(args.projectPath);
    const requestedCwd =
      typeof args.cwd === "string" && args.cwd.trim()
        ? args.cwd.trim()
        : projectPath;
    const cwd = resolve(projectPath, requestedCwd);
    if (!isInside(projectPath, cwd)) {
      throw new Error("cwd must stay inside the session project");
    }
    if (!existsSync(cwd)) throw new Error(`cwd does not exist: ${cwd}`);

    const jobId = randomUUID();
    const dir = this.jobsDir(args.sessionId);
    mkdirSync(dir, { recursive: true });
    const stdoutPath = join(dir, `${jobId}.stdout.log`);
    const stderrPath = join(dir, `${jobId}.stderr.log`);
    const stdoutFd = openSync(stdoutPath, "w");
    const stderrFd = openSync(stderrPath, "w");
    const now = Date.now();

    let child;
    try {
      child = spawn("bash", ["-lc", command], {
        cwd,
        detached: true,
        stdio: ["ignore", stdoutFd, stderrFd],
        env: {
          ...process.env,
          [ENV_SESSION_ID]: args.sessionId,
          [ENV_JOB_ID]: jobId,
          ...(trimLabel(args.label)
            ? { [ENV_JOB_LABEL]: trimLabel(args.label)! }
            : {}),
        },
      });
    } finally {
      closeSync(stdoutFd);
      closeSync(stderrFd);
    }

    const pid = child.pid;
    if (!pid) throw new Error("failed to spawn detached shell job");

    const record: ShellJobRecord = {
      jobId,
      sessionId: args.sessionId,
      command,
      cwd,
      label: trimLabel(args.label),
      pid,
      startedAt: now,
      updatedAt: now,
      status: "running",
      exitCode: null,
      signal: null,
      stdoutPath,
      stderrPath,
    };
    await this.upsert(record);

    child.once("error", (error) => {
      void this.markFinished(args.sessionId, jobId, {
        status: "error",
        exitCode: null,
        signal: error.message,
      });
    });
    child.once("exit", (code, signal) => {
      void this.markFinished(args.sessionId, jobId, {
        status: "exited",
        exitCode: code,
        signal,
      });
    });
    child.unref();

    return { ...record, alive: true };
  }

  async list(sessionId: string): Promise<DetachedShellJob[]> {
    const store = await this.load(sessionId);
    const refreshed = await Promise.all(
      store.jobs.map(async (job) => this.refreshJob(job)),
    );
    await this.save(sessionId, { version: STORE_VERSION, jobs: refreshed });
    return refreshed.map((job) => ({
      ...job,
      alive: job.status === "running",
    }));
  }

  async get(
    sessionId: string,
    jobId: string,
  ): Promise<(DetachedShellJob & { stdout: string; stderr: string }) | null> {
    const jobs = await this.list(sessionId);
    const job = jobs.find((candidate) => candidate.jobId === jobId) ?? null;
    if (!job) return null;
    return {
      ...job,
      stdout: await readTail(job.stdoutPath),
      stderr: await readTail(job.stderrPath),
    };
  }

  async kill(
    sessionId: string,
    jobId: string,
  ): Promise<DetachedShellJob | null> {
    const job = await this.get(sessionId, jobId);
    if (!job) return null;
    const pids = await findTaggedPids(sessionId, jobId);
    await Promise.all(pids.map((pid) => terminatePid(pid)));
    await this.markFinished(sessionId, jobId, {
      status: "killed",
      exitCode: null,
      signal: "SIGTERM",
    });
    return await this.get(sessionId, jobId);
  }

  private jobsDir(sessionId: string): string {
    return join(this.store.storageRoot, "sessions", sessionId, JOBS_DIR);
  }

  private indexPath(sessionId: string): string {
    return join(this.jobsDir(sessionId), INDEX_FILE);
  }

  private async load(sessionId: string): Promise<ShellJobStoreFile> {
    await this.store.ensureInitialized();
    const path = this.indexPath(sessionId);
    const raw = await readFile(path, "utf-8").catch(() => "");
    if (!raw.trim()) return { version: STORE_VERSION, jobs: [] };
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const jobs = Array.isArray(parsed.jobs)
        ? parsed.jobs
            .map(normalizeRecord)
            .filter((job): job is ShellJobRecord => job !== null)
        : [];
      return { version: STORE_VERSION, jobs };
    } catch (error) {
      logger.chat.warn(
        "Failed to read detached shell job index {path}: {error}",
        {
          path: basename(path),
          error,
        },
      );
      return { version: STORE_VERSION, jobs: [] };
    }
  }

  private async save(
    sessionId: string,
    store: ShellJobStoreFile,
  ): Promise<void> {
    const dir = this.jobsDir(sessionId);
    await this.store.ensureInitialized();
    mkdirSync(dir, { recursive: true });
    await writeFile(
      this.indexPath(sessionId),
      JSON.stringify(store, null, 2),
      "utf-8",
    );
  }

  private async upsert(record: ShellJobRecord): Promise<void> {
    const store = await this.load(record.sessionId);
    const index = store.jobs.findIndex((job) => job.jobId === record.jobId);
    if (index >= 0) {
      store.jobs[index] = record;
    } else {
      store.jobs.push(record);
    }
    await this.save(record.sessionId, store);
  }

  private async markFinished(
    sessionId: string,
    jobId: string,
    patch: Pick<ShellJobRecord, "status" | "exitCode" | "signal">,
  ): Promise<void> {
    const store = await this.load(sessionId);
    const job = store.jobs.find((candidate) => candidate.jobId === jobId);
    if (!job) return;
    job.status = patch.status;
    job.exitCode = patch.exitCode;
    job.signal = patch.signal;
    job.updatedAt = Date.now();
    await this.save(sessionId, store);
  }

  private async refreshJob(job: ShellJobRecord): Promise<ShellJobRecord> {
    if (job.status !== "running") return job;
    const alive = await isTaggedProcessAlive(job.pid, job.sessionId, job.jobId);
    if (alive) return job;
    return {
      ...job,
      status: "exited",
      updatedAt: Date.now(),
    };
  }
}

export const detachedShellJobs = new DetachedShellJobService();
