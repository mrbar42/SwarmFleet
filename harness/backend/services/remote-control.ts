/**
 * Remote Control process manager for SwarmFleet.
 * Spawns and supervises `claude remote-control` processes, one per project directory.
 * Auto-restarts if the process dies while enabled (treated as a project service).
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { logger } from "../utils/logger.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RemoteControlInfo {
  pid: number;
  startedAt: string;
  projectDir: string;
  process?: ChildProcess;
  enabled: boolean;
  cliPath: string;
  restartTimer?: ReturnType<typeof setTimeout>;
  /** First URL scraped from stdout/stderr after spawn (e.g. the share link). */
  url: string | null;
  /** Whether we've already written "y\n" to stdin to confirm the prompt. */
  confirmed: boolean;
}

// The claude CLI presents an interactive "Enable Remote Control? (y/n)" prompt
// that has no --yes flag we can pass. We auto-answer by piping stdin and
// sending "y\n" the first time we see the prompt text. Without this the CLI
// exits immediately and never prints the share URL.
const ENABLE_PROMPT_MARKER = "Enable Remote Control?";

export interface RemoteControlStatus {
  enabled: boolean;
  running: boolean;
  pid: number | null;
  startedAt: string | null;
  url: string | null;
}

// Conservative URL matcher: the claude CLI prints an http(s):// link when
// the tunnel is ready. Grab the first URL we see and surface it via status.
const URL_REGEX = /https?:\/\/[^\s<>"']+/;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const RESTART_DELAY_MS = 3000;
const ENV_PROJECT_TAG = "SWARMFLEET_REMOTE_CONTROL_PROJECT";
const STATE_FILE = "remote-control-state.json";
const STDOUT_LOG_FILE = "remote-control.out.log";
const STDERR_LOG_FILE = "remote-control.err.log";

function readProjectName(projectDir: string): string {
  try {
    const pkgPath = path.join(projectDir, "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
    if (typeof pkg.name === "string" && pkg.name.trim()) {
      return pkg.name.trim();
    }
  } catch {
    // no package.json or invalid
  }
  return path.basename(projectDir);
}

interface RemoteControlState {
  pid: number;
  startedAt: string;
  url: string | null;
}

function statePath(absDir: string): string {
  return path.join(absDir, ".swarmfleet", STATE_FILE);
}

function swarmFleetDir(absDir: string): string {
  return path.join(absDir, ".swarmfleet");
}

function ensureSwarmFleetDir(absDir: string): string {
  const dir = swarmFleetDir(absDir);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function stdoutLogPath(absDir: string): string {
  return path.join(swarmFleetDir(absDir), STDOUT_LOG_FILE);
}

function stderrLogPath(absDir: string): string {
  return path.join(swarmFleetDir(absDir), STDERR_LOG_FILE);
}

function readState(absDir: string): RemoteControlState | null {
  try {
    const raw = fs.readFileSync(statePath(absDir), "utf-8");
    const parsed = JSON.parse(raw);
    if (
      typeof parsed.pid === "number" &&
      typeof parsed.startedAt === "string"
    ) {
      return {
        pid: parsed.pid,
        startedAt: parsed.startedAt,
        url: typeof parsed.url === "string" ? parsed.url : null,
      };
    }
  } catch {
    // No state yet, or invalid state from an older run.
  }
  return null;
}

function writeState(
  absDir: string,
  info: Pick<RemoteControlInfo, "pid" | "startedAt" | "url">,
): void {
  try {
    ensureSwarmFleetDir(absDir);
    fs.writeFileSync(
      statePath(absDir),
      JSON.stringify(
        {
          pid: info.pid,
          startedAt: info.startedAt,
          url: info.url,
        },
        null,
        2,
      ),
      "utf-8",
    );
  } catch (error) {
    logger.app.warn(
      "Failed to persist remote-control state for {dir}: {error}",
      {
        dir: absDir,
        error,
      },
    );
  }
}

function readUrlFromLogs(absDir: string): string | null {
  for (const filePath of [stdoutLogPath(absDir), stderrLogPath(absDir)]) {
    try {
      const text = fs.readFileSync(filePath, "utf-8");
      const match = URL_REGEX.exec(text);
      if (match) return match[0];
    } catch {
      // Log may not exist yet.
    }
  }
  return null;
}

function removeState(absDir: string): void {
  try {
    fs.unlinkSync(statePath(absDir));
  } catch {
    // Already absent.
  }
}

function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readProcFile(pid: string, file: string): Buffer | null {
  try {
    return fs.readFileSync(`/proc/${pid}/${file}`);
  } catch {
    return null;
  }
}

function parseTaggedProject(raw: Buffer): string | null {
  const text = raw.toString("latin1");
  for (const entry of text.split("\0")) {
    if (entry.startsWith(`${ENV_PROJECT_TAG}=`)) {
      return entry.slice(ENV_PROJECT_TAG.length + 1);
    }
  }
  return null;
}

function findTaggedProcess(absDir: string): number | null {
  let entries: string[];
  try {
    entries = fs.readdirSync("/proc");
  } catch {
    return null;
  }

  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const environ = readProcFile(entry, "environ");
    if (!environ) continue;
    if (parseTaggedProject(environ) === absDir) {
      const pid = Number.parseInt(entry, 10);
      return Number.isFinite(pid) ? pid : null;
    }
  }

  return null;
}

function signalProcessGroupOrPid(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
    return;
  } catch {
    // Process may not be a process-group leader; fall back to the pid.
  }

  try {
    process.kill(pid, signal);
  } catch {
    // Already gone.
  }
}

// ---------------------------------------------------------------------------
// Singleton manager
// ---------------------------------------------------------------------------

class RemoteControlManager {
  private processes = new Map<string, RemoteControlInfo>();
  private monitorTimer: ReturnType<typeof setInterval> | null = null;

  // -----------------------------------------------------------------------
  // Start
  // -----------------------------------------------------------------------

  start(projectDir: string, cliPath: string): void {
    const absDir = path.resolve(projectDir);

    // If already running, just ensure enabled flag is set
    const existing = this.processes.get(absDir);
    if (existing) {
      if (!isPidAlive(existing.pid)) {
        this.processes.delete(absDir);
        removeState(absDir);
      } else {
        existing.enabled = true;
        return;
      }
    }

    if (this.adoptExistingProcess(absDir, cliPath)) {
      return;
    }

    this.spawnProcess(absDir, cliPath);
  }

  // -----------------------------------------------------------------------
  // Stop
  // -----------------------------------------------------------------------

  stop(projectDir: string): boolean {
    const absDir = path.resolve(projectDir);
    this.adoptExistingProcess(absDir);
    const info = this.processes.get(absDir);
    if (!info) return false;

    info.enabled = false;

    if (info.restartTimer) {
      clearTimeout(info.restartTimer);
      info.restartTimer = undefined;
    }

    const pid = info.pid;
    signalProcessGroupOrPid(pid, "SIGTERM");
    this.processes.delete(absDir);
    removeState(absDir);
    setTimeout(() => {
      if (isPidAlive(pid)) {
        signalProcessGroupOrPid(pid, "SIGKILL");
      }
    }, 5000);

    return true;
  }

  // -----------------------------------------------------------------------
  // Status
  // -----------------------------------------------------------------------

  getStatus(projectDir: string): {
    running: boolean;
    pid: number | null;
    startedAt: string | null;
    url: string | null;
  } {
    const absDir = path.resolve(projectDir);
    this.adoptExistingProcess(absDir);
    const info = this.processes.get(absDir);
    if (info) {
      if (info.restartTimer) {
        return { running: false, pid: null, startedAt: null, url: info.url };
      }
      if (!isPidAlive(info.pid)) {
        this.processes.delete(absDir);
        removeState(absDir);
        return { running: false, pid: null, startedAt: null, url: null };
      }
      return {
        running: true,
        pid: info.pid,
        startedAt: info.startedAt,
        url: info.url,
      };
    }
    return { running: false, pid: null, startedAt: null, url: null };
  }

  isRunning(projectDir: string): boolean {
    return this.getStatus(projectDir).running;
  }

  // -----------------------------------------------------------------------
  // Shutdown all (graceful server shutdown)
  // -----------------------------------------------------------------------

  shutdownAll(): void {
    for (const [absDir, info] of this.processes) {
      info.enabled = false;
      if (info.restartTimer) {
        clearTimeout(info.restartTimer);
      }
      signalProcessGroupOrPid(info.pid, "SIGTERM");
    }
    // Force-kill anything still alive after 5s
    const snapshot = [...this.processes.entries()];
    setTimeout(() => {
      for (const [absDir, info] of snapshot) {
        if (this.processes.has(absDir)) {
          signalProcessGroupOrPid(info.pid, "SIGKILL");
        }
      }
    }, 5000);
  }

  // -----------------------------------------------------------------------
  // Restore from config (called at server startup)
  // -----------------------------------------------------------------------

  async restoreFromConfig(
    workspacesRoot: string,
    cliPath: string,
  ): Promise<void> {
    if (!workspacesRoot || !fs.existsSync(workspacesRoot)) return;

    try {
      const entries = fs.readdirSync(workspacesRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith(".")) continue;

        const projectDir = path.join(workspacesRoot, entry.name);
        const settingsPath = path.join(projectDir, ".swarmfleet", "settings.json");

        try {
          const content = fs.readFileSync(settingsPath, "utf-8");
          const settings = JSON.parse(content);
          if (settings.remoteControl === true) {
            logger.app.info("Restoring remote-control for project: {dir}", {
              dir: projectDir,
            });
            if (this.adoptExistingProcess(projectDir, cliPath)) {
              continue;
            }
            this.start(projectDir, cliPath);
          }
        } catch {
          // no settings or invalid — skip
        }
      }
    } catch (e) {
      logger.app.warn(
        "Failed to scan workspace for remote-control restore: {error}",
        { error: e },
      );
    }
  }

  // -----------------------------------------------------------------------
  // Private: spawn
  // -----------------------------------------------------------------------

  private spawnProcess(absDir: string, cliPath: string): void {
    const projectName = readProjectName(absDir);
    const projectSwarmFleetDir = ensureSwarmFleetDir(absDir);
    const stdoutFd = fs.openSync(
      path.join(projectSwarmFleetDir, STDOUT_LOG_FILE),
      "w",
    );
    const stderrFd = fs.openSync(
      path.join(projectSwarmFleetDir, STDERR_LOG_FILE),
      "w",
    );

    logger.app.info(
      "Spawning remote-control for project: {dir} (name: {name})",
      {
        dir: absDir,
        name: projectName,
      },
    );

    const child = spawn(
      cliPath,
      [
        "remote-control",
        "--no-create-session-in-dir",
        "--spawn",
        "same-dir",
        "--name",
        projectName,
        "--no-sandbox",
        "--permission-mode",
        "bypassPermissions",
      ],
      {
        cwd: absDir,
        env: {
          ...process.env,
          [ENV_PROJECT_TAG]: absDir,
          DISABLE_AUTOUPDATER: "1",
          CLAUDE_CODE_EFFORT_LEVEL: "high",
        },
        // stdin is piped so we can auto-answer the enable prompt. stdout/stderr
        // go to project log files so the detached service is not tied to backend
        // process pipes across dev reloads.
        stdio: ["pipe", stdoutFd, stderrFd],
        detached: true,
      },
    );
    fs.closeSync(stdoutFd);
    fs.closeSync(stderrFd);

    const captureUrl = (text: string): void => {
      const info = this.processes.get(absDir);
      if (!info || info.url) return;
      const match = URL_REGEX.exec(text);
      if (match) {
        info.url = match[0];
        writeState(absDir, info);
        logger.app.info("remote-control URL ready for {dir}: {url}", {
          dir: absDir,
          url: info.url,
        });
      }
    };

    const maybeConfirmPrompt = (text: string): void => {
      const info = this.processes.get(absDir);
      if (!info || info.confirmed) return;
      if (!text.includes(ENABLE_PROMPT_MARKER)) return;
      try {
        child.stdin?.write("y\n");
        info.confirmed = true;
        logger.app.info(
          "remote-control: auto-answered enable prompt for {dir}",
          { dir: absDir },
        );
      } catch (err) {
        logger.app.warn(
          "remote-control: failed to auto-answer prompt for {dir}: {error}",
          { dir: absDir, error: err },
        );
      }
    };

    let stdoutOffset = 0;
    let stderrOffset = 0;
    const readAppended = (filePath: string, offset: number): number => {
      try {
        const stat = fs.statSync(filePath);
        if (stat.size < offset) offset = 0;
        if (stat.size === offset) return offset;
        const fd = fs.openSync(filePath, "r");
        try {
          const length = Math.min(stat.size - offset, 64 * 1024);
          const buffer = Buffer.alloc(length);
          fs.readSync(fd, buffer, 0, length, offset);
          const text = buffer.toString();
          maybeConfirmPrompt(text);
          captureUrl(text);
          return offset + length;
        } finally {
          fs.closeSync(fd);
        }
      } catch {
        return offset;
      }
    };

    const logMonitor = setInterval(() => {
      stdoutOffset = readAppended(stdoutLogPath(absDir), stdoutOffset);
      stderrOffset = readAppended(stderrLogPath(absDir), stderrOffset);
    }, 250);

    child.on("error", (err: Error) => {
      clearInterval(logMonitor);
      logger.app.error("remote-control process error [{dir}]: {error}", {
        dir: absDir,
        error: err.message,
      });
      this.processes.delete(absDir);
      removeState(absDir);
    });

    child.on("close", (code: number | null) => {
      clearInterval(logMonitor);
      logger.app.info("remote-control exited with code {code} for {dir}", {
        code: String(code),
        dir: absDir,
      });

      const info = this.processes.get(absDir);
      this.processes.delete(absDir);
      removeState(absDir);

      // Auto-restart if still enabled
      if (info?.enabled) {
        logger.app.info(
          "Scheduling remote-control restart in {ms}ms for {dir}",
          {
            ms: String(RESTART_DELAY_MS),
            dir: absDir,
          },
        );
        const timer = setTimeout(() => {
          // Re-check: the user may have toggled off during the delay
          if (info.enabled) {
            this.spawnProcess(absDir, info.cliPath);
          }
        }, RESTART_DELAY_MS);
        // Store the timer on a temporary entry so stop() can cancel it
        this.processes.set(absDir, this.pendingRestartInfo(info, timer));
      }
    });

    const rcInfo: RemoteControlInfo = {
      pid: child.pid ?? 0,
      startedAt: new Date().toISOString(),
      projectDir: absDir,
      process: child,
      enabled: true,
      cliPath,
      url: null,
      confirmed: false,
    };
    this.processes.set(absDir, rcInfo);
    writeState(absDir, rcInfo);
    this.ensureMonitorLoop();
  }

  private adoptExistingProcess(absDir: string, cliPath?: string): boolean {
    const resolvedDir = path.resolve(absDir);
    const existing = this.processes.get(resolvedDir);
    if (existing && isPidAlive(existing.pid)) {
      return true;
    }

    const taggedPid = findTaggedProcess(resolvedDir);
    const state = readState(resolvedDir);
    const pid = taggedPid;
    if (!pid || !isPidAlive(pid)) {
      if (existing) {
        this.processes.delete(resolvedDir);
      }
      return false;
    }

    const adopted: RemoteControlInfo = {
      pid,
      startedAt: state?.startedAt ?? new Date().toISOString(),
      projectDir: resolvedDir,
      enabled: true,
      cliPath: cliPath ?? existing?.cliPath ?? "claude",
      url: state?.url ?? readUrlFromLogs(resolvedDir),
      confirmed: true,
    };
    this.processes.set(resolvedDir, adopted);
    writeState(resolvedDir, adopted);
    this.ensureMonitorLoop();
    logger.app.info("Adopted remote-control service for {dir} (pid {pid})", {
      dir: resolvedDir,
      pid: String(pid),
    });
    return true;
  }

  private pendingRestartInfo(
    info: RemoteControlInfo,
    timer: ReturnType<typeof setTimeout>,
  ): RemoteControlInfo {
    return {
      ...info,
      pid: 0,
      process: undefined,
      restartTimer: timer,
    };
  }

  private scheduleRestart(absDir: string, info: RemoteControlInfo): void {
    if (info.restartTimer) return;
    logger.app.info("Scheduling remote-control restart in {ms}ms for {dir}", {
      ms: String(RESTART_DELAY_MS),
      dir: absDir,
    });
    const timer = setTimeout(() => {
      const latest = this.processes.get(absDir);
      if (latest?.enabled) {
        this.processes.delete(absDir);
        this.spawnProcess(absDir, latest.cliPath);
      }
    }, RESTART_DELAY_MS);
    this.processes.set(absDir, this.pendingRestartInfo(info, timer));
  }

  private ensureMonitorLoop(): void {
    if (this.monitorTimer) return;
    this.monitorTimer = setInterval(() => {
      for (const [absDir, info] of this.processes) {
        if (!info.enabled || info.restartTimer || isPidAlive(info.pid)) {
          continue;
        }
        this.processes.delete(absDir);
        removeState(absDir);
        this.scheduleRestart(absDir, info);
      }
    }, 5000);
  }
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

export const remoteControlManager = new RemoteControlManager();
