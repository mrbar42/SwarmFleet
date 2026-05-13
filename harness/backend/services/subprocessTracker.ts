import { readdir, readFile } from "node:fs/promises";
import type { SubprocessEntry, SubprocessUpdate } from "../../shared/types.ts";
import { logger } from "../utils/logger.ts";

const SCAN_INTERVAL_MS = 2000;
const KILL_GRACE_MS = 2000;
const ENV_TAG = "SWARMFLEET_SESSION_ID";
const ENV_SHELL_JOB_ID = "SWARMFLEET_SHELL_JOB_ID";
const COMMAND_MAX_LEN = 4096;

type Listener = (update: SubprocessUpdate) => void;

// Tracks first-seen timestamps keyed by pid (string) so they survive
// across scan ticks.
const firstSeenAt = new Map<string, number>();

async function readProcFile(pid: string, file: string): Promise<Buffer | null> {
  try {
    return await readFile(`/proc/${pid}/${file}`);
  } catch {
    // EACCES (other user's proc) or ENOENT (proc exited) — both expected.
    return null;
  }
}

/**
 * Parse the NUL-separated KEY=VALUE pairs from /proc/<pid>/environ.
 * Returns the value of ENV_TAG, or null if absent.
 */
function parseSessionIdFromEnviron(raw: Buffer): string | null {
  const text = raw.toString("latin1");
  for (const entry of text.split("\0")) {
    if (entry.startsWith(`${ENV_TAG}=`)) {
      return entry.slice(ENV_TAG.length + 1);
    }
  }
  return null;
}

function hasShellJobId(raw: Buffer): boolean {
  const text = raw.toString("latin1");
  for (const entry of text.split("\0")) {
    if (entry.startsWith(`${ENV_SHELL_JOB_ID}=`)) {
      return entry.length > ENV_SHELL_JOB_ID.length + 1;
    }
  }
  return false;
}

/**
 * Parse ppid from /proc/<pid>/stat.
 * Field layout: pid (comm) state ppid ...
 * The comm field may contain spaces and parentheses; we scan for the last ')'.
 */
function parsePpidFromStat(raw: Buffer): number | null {
  const text = raw.toString("latin1");
  const rparenIdx = text.lastIndexOf(")");
  if (rparenIdx === -1) return null;
  const rest = text.slice(rparenIdx + 1).trimStart();
  // rest: "state ppid ..."
  const parts = rest.split(/\s+/);
  // parts[0] = state, parts[1] = ppid
  if (parts.length < 2) return null;
  const ppid = Number.parseInt(parts[1], 10);
  return Number.isFinite(ppid) ? ppid : null;
}

/**
 * Parse command from /proc/<pid>/cmdline (NUL-separated argv).
 */
function parseCmdline(raw: Buffer): string {
  return raw
    .toString("latin1")
    .replace(/\0/g, " ")
    .trim()
    .slice(0, COMMAND_MAX_LEN);
}

function normalizeCommandForMatch(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}

function commandMatchScore(
  processCommand: string,
  targetCommand: string,
): number {
  const processNormalized = normalizeCommandForMatch(processCommand);
  const targetNormalized = normalizeCommandForMatch(targetCommand);
  if (!processNormalized || !targetNormalized) return 0;
  if (processNormalized === targetNormalized) return 100;
  if (processNormalized.endsWith(` ${targetNormalized}`)) return 80;
  if (processNormalized.includes(targetNormalized)) return 60;
  return 0;
}

/**
 * Parse starttime (jiffies since boot, field 22) from /proc/<pid>/stat.
 * We convert to epoch ms using /proc/uptime if available. On failure returns null.
 */
async function parseStartedAt(
  pid: string,
  statRaw: Buffer,
): Promise<number | null> {
  try {
    const text = statRaw.toString("latin1");
    const rparenIdx = text.lastIndexOf(")");
    if (rparenIdx === -1) return null;
    const rest = text
      .slice(rparenIdx + 1)
      .trimStart()
      .split(/\s+/);
    // field indices after comm+state (0-indexed from "state" onward):
    // 0=state,1=ppid,2=pgrp,3=session,4=tty,5=tpgid,6=flags,7=minflt,8=cminflt,
    // 9=majflt,10=cmajflt,11=utime,12=stime,13=cutime,14=cstime,15=priority,
    // 16=nice,17=num_threads,18=itrealvalue,19=starttime
    const starttimeJiffies = Number.parseFloat(rest[19] ?? "");
    if (!Number.isFinite(starttimeJiffies)) return null;

    const uptimeRaw = await readFile("/proc/uptime");
    const uptimeSeconds = Number.parseFloat(
      uptimeRaw.toString().split(" ")[0] ?? "",
    );
    if (!Number.isFinite(uptimeSeconds)) return null;

    const clkTck = 100; // sysconf(_SC_CLK_TCK) — 100 Hz on virtually all Linux
    const startedSecondsAgo = uptimeSeconds - starttimeJiffies / clkTck;
    return Math.round(Date.now() - startedSecondsAgo * 1000);
  } catch {
    return null;
  }
}

interface ProcessSnapshot {
  pid: number;
  ppid: number;
  command: string;
  startedAt: number | null;
  sessionId: string;
  shellJob: boolean;
}

async function scanAllTagged(): Promise<ProcessSnapshot[]> {
  let entries: string[];
  try {
    entries = await readdir("/proc");
  } catch {
    return [];
  }

  const results: ProcessSnapshot[] = [];

  for (const entry of entries) {
    // Only numeric entries are pid directories.
    if (!/^\d+$/.test(entry)) continue;

    const environRaw = await readProcFile(entry, "environ");
    if (!environRaw) continue;

    const sessionId = parseSessionIdFromEnviron(environRaw);
    if (!sessionId) continue;
    const shellJob = hasShellJobId(environRaw);

    const statRaw = await readProcFile(entry, "stat");
    if (!statRaw) continue;

    const ppid = parsePpidFromStat(statRaw);
    if (ppid === null) continue;

    const cmdlineRaw = await readProcFile(entry, "cmdline");
    const command = cmdlineRaw ? parseCmdline(cmdlineRaw) : "";

    const pid = Number.parseInt(entry, 10);
    const pidKey = `${sessionId}:${pid}`;

    if (!firstSeenAt.has(pidKey)) {
      const startedAt = await parseStartedAt(entry, statRaw);
      firstSeenAt.set(pidKey, startedAt ?? Date.now());
    }

    results.push({
      pid,
      ppid,
      command,
      startedAt: firstSeenAt.get(pidKey) ?? null,
      sessionId,
      shellJob,
    });
  }

  return results;
}

type CliPidResolver = () => number | null | undefined;

interface SubscriberEntry {
  listener: Listener;
  getCliPid?: CliPidResolver;
}

export class SubprocessTracker {
  private readonly subscribers = new Map<string, Set<SubscriberEntry>>();
  private scanTimer: ReturnType<typeof setInterval> | null = null;
  private previousSnapshot = new Map<string, ProcessSnapshot[]>();

  /**
   * Subscribe to subprocess updates for a session.
   * `getCliPid` is called on each tick to get the session's current CLI pid
   * for computing `displayable`. Pass it as a closure over live session metadata.
   */
  subscribe(
    sessionId: string,
    listener: Listener,
    getCliPid?: CliPidResolver,
  ): () => void {
    let set = this.subscribers.get(sessionId);
    if (!set) {
      set = new Set();
      this.subscribers.set(sessionId, set);
    }
    const entry: SubscriberEntry = { listener, getCliPid };
    set.add(entry);
    this.maybeStartLoop();
    void this.emitSnapshotToSubscriber(sessionId, entry);

    return () => {
      const s = this.subscribers.get(sessionId);
      if (!s) return;
      s.delete(entry);
      if (s.size === 0) {
        this.subscribers.delete(sessionId);
        this.previousSnapshot.delete(sessionId);
      }
      if (this.totalSubscribers() === 0) {
        this.stopLoop();
      }
    };
  }

  async listForSession(
    sessionId: string,
    cliPid?: number | null,
  ): Promise<SubprocessEntry[]> {
    const all = await scanAllTagged();
    return this.buildEntries(
      all.filter((p) => p.sessionId === sessionId),
      cliPid ?? null,
    );
  }

  async killPid(sessionId: string, pid: number): Promise<void> {
    // Verify ownership before killing.
    const environRaw = await readProcFile(String(pid), "environ");
    if (!environRaw) {
      throw new Error(`Process ${pid} not found or not accessible`);
    }
    const ownerSession = parseSessionIdFromEnviron(environRaw);
    if (ownerSession !== sessionId) {
      throw new Error(`Process ${pid} does not belong to session ${sessionId}`);
    }
    await this.terminatePid(pid);
    await this.emitSnapshot(sessionId);
  }

  async killMatchingCommand(
    sessionId: string,
    command: string,
    cliPid?: number | null,
    options: { excludePids?: Iterable<number | null | undefined> } = {},
  ): Promise<SubprocessEntry> {
    const excluded = new Set(
      Array.from(options.excludePids ?? []).filter(
        (pid): pid is number => typeof pid === "number" && Number.isFinite(pid),
      ),
    );
    const entries = await this.listForSession(sessionId, cliPid);
    const candidates = entries
      .filter((entry) => !excluded.has(entry.pid))
      .map((entry) => ({
        entry,
        score: commandMatchScore(entry.command, command),
      }))
      .filter((candidate) => candidate.score > 0)
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        if (a.entry.displayable !== b.entry.displayable) {
          return a.entry.displayable ? -1 : 1;
        }
        return (b.entry.startedAt ?? 0) - (a.entry.startedAt ?? 0);
      });

    const match = candidates[0]?.entry;
    if (!match) {
      throw new Error("No running process matched this task command");
    }

    await this.killPidTree(sessionId, match.pid);
    return match;
  }

  async killSession(
    sessionId: string,
    options: { excludePids?: Iterable<number> } = {},
  ): Promise<void> {
    const all = await scanAllTagged();
    const excluded = new Set(options.excludePids ?? []);
    const pids = all
      .filter((p) => p.sessionId === sessionId && !excluded.has(p.pid))
      .map((p) => p.pid);
    await Promise.all(
      pids.map((pid) => this.terminatePid(pid).catch(() => undefined)),
    );
    await this.emitSnapshot(sessionId);
  }

  async reclaimOrphans(knownSessionIds: Set<string>): Promise<void> {
    const all = await scanAllTagged();
    const unknown = all.filter((p) => !knownSessionIds.has(p.sessionId));
    if (unknown.length > 0) {
      logger.app.info(
        "reclaimOrphans: killing {count} processes from {sessions} unknown sessions",
        {
          count: unknown.length,
          sessions: [...new Set(unknown.map((p) => p.sessionId))].length,
        },
      );
    }
    await Promise.all(
      unknown.map((p) => this.terminatePid(p.pid).catch(() => undefined)),
    );
    for (const sessionId of new Set(unknown.map((p) => p.sessionId))) {
      await this.emitSnapshot(sessionId);
    }
  }

  private async terminatePid(pid: number): Promise<void> {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Already gone.
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, KILL_GRACE_MS));
    try {
      process.kill(pid, 0); // Check if still alive.
      process.kill(pid, "SIGKILL");
    } catch {
      // Gone — expected.
      return;
    }

    const deadline = Date.now() + 500;
    while (Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      try {
        process.kill(pid, 0);
      } catch {
        return;
      }
    }
  }

  private async killPidTree(sessionId: string, rootPid: number): Promise<void> {
    const environRaw = await readProcFile(String(rootPid), "environ");
    if (!environRaw) {
      throw new Error(`Process ${rootPid} not found or not accessible`);
    }
    const ownerSession = parseSessionIdFromEnviron(environRaw);
    if (ownerSession !== sessionId) {
      throw new Error(
        `Process ${rootPid} does not belong to session ${sessionId}`,
      );
    }

    const all = await scanAllTagged();
    const childrenByParent = new Map<number, number[]>();
    for (const proc of all) {
      if (proc.sessionId !== sessionId) continue;
      const children = childrenByParent.get(proc.ppid) ?? [];
      children.push(proc.pid);
      childrenByParent.set(proc.ppid, children);
    }

    const ordered: number[] = [];
    const visit = (pid: number) => {
      for (const child of childrenByParent.get(pid) ?? []) {
        visit(child);
      }
      ordered.push(pid);
    };
    visit(rootPid);

    await Promise.all(
      ordered.map((pid) => this.terminatePid(pid).catch(() => undefined)),
    );
    await this.emitSnapshot(sessionId);
  }

  private buildEntries(
    procs: ProcessSnapshot[],
    cliPid: number | null,
  ): SubprocessEntry[] {
    const taggedPids = new Set(procs.map((p) => p.pid));
    return procs.map((p) => ({
      pid: p.pid,
      ppid: p.ppid,
      command: p.command,
      startedAt: p.startedAt,
      displayable:
        p.shellJob ||
        (cliPid !== null && p.ppid === cliPid) ||
        (p.ppid === 1 && taggedPids.has(p.pid)),
    }));
  }

  private maybeStartLoop(): void {
    if (this.scanTimer !== null) return;
    this.scanTimer = setInterval(() => {
      void this.tick();
    }, SCAN_INTERVAL_MS);
  }

  private stopLoop(): void {
    if (this.scanTimer !== null) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }
  }

  async emitSnapshot(sessionId: string): Promise<void> {
    const entries = this.subscribers.get(sessionId);
    if (!entries || entries.size === 0) return;

    const all = await scanAllTagged();
    const procs = all.filter((p) => p.sessionId === sessionId);
    this.previousSnapshot.set(sessionId, procs);

    for (const entry of entries) {
      const cliPid = entry.getCliPid?.() ?? null;
      try {
        entry.listener({
          type: "subprocess-update",
          sessionId,
          processes: this.buildEntries(procs, cliPid),
        });
      } catch (error) {
        logger.app.warn("SubprocessTracker listener error: {error}", {
          error,
        });
      }
    }
  }

  private async emitSnapshotToSubscriber(
    sessionId: string,
    entry: SubscriberEntry,
  ): Promise<void> {
    try {
      const processes = await this.listForSession(
        sessionId,
        entry.getCliPid?.() ?? null,
      );
      if (!this.subscribers.get(sessionId)?.has(entry)) return;
      entry.listener({
        type: "subprocess-update",
        sessionId,
        processes,
      });
    } catch (error) {
      logger.app.warn("SubprocessTracker initial scan failed: {error}", {
        error,
      });
    }
  }

  private async tick(): Promise<void> {
    if (this.totalSubscribers() === 0) {
      this.stopLoop();
      return;
    }

    let all: ProcessSnapshot[];
    try {
      all = await scanAllTagged();
    } catch (error) {
      logger.app.warn("SubprocessTracker scan failed: {error}", { error });
      return;
    }

    // Group by sessionId.
    const bySession = new Map<string, ProcessSnapshot[]>();
    for (const proc of all) {
      let arr = bySession.get(proc.sessionId);
      if (!arr) {
        arr = [];
        bySession.set(proc.sessionId, arr);
      }
      arr.push(proc);
    }

    // Emit to each subscribed session.
    for (const [sessionId, entries] of this.subscribers) {
      if (entries.size === 0) continue;
      const procs = bySession.get(sessionId) ?? [];
      const prevProcs = this.previousSnapshot.get(sessionId) ?? [];

      // Simple diff: check if pid sets changed.
      const changed = this.hasChanged(prevProcs, procs);
      this.previousSnapshot.set(sessionId, procs);

      if (!changed) continue;

      for (const entry of entries) {
        const cliPid = entry.getCliPid?.() ?? null;
        const update: SubprocessUpdate = {
          type: "subprocess-update",
          sessionId,
          processes: this.buildEntries(procs, cliPid),
        };
        try {
          entry.listener(update);
        } catch (error) {
          logger.app.warn("SubprocessTracker listener error: {error}", {
            error,
          });
        }
      }
    }

    // Evict stale firstSeenAt entries for dead pids.
    const livePidKeys = new Set(all.map((p) => `${p.sessionId}:${p.pid}`));
    for (const key of firstSeenAt.keys()) {
      if (!livePidKeys.has(key)) {
        firstSeenAt.delete(key);
      }
    }
  }

  private hasChanged(
    prev: ProcessSnapshot[],
    next: ProcessSnapshot[],
  ): boolean {
    if (prev.length !== next.length) return true;
    const prevPids = new Set(prev.map((p) => p.pid));
    for (const p of next) {
      if (!prevPids.has(p.pid)) return true;
    }
    return false;
  }

  private totalSubscribers(): number {
    let total = 0;
    for (const s of this.subscribers.values()) {
      total += s.size;
    }
    return total;
  }
}

export const subprocessTracker = new SubprocessTracker();
