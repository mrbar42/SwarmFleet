#!/usr/bin/env tsx

import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  readdirSync,
  statSync,
  watch,
  type FSWatcher,
} from "node:fs";
import path from "node:path";

const DEFAULT_RESTART_DELAY_MS = 15_000;
const DEFAULT_SHUTDOWN_GRACE_MS = 3_000;

const restartDelayMs = Number.parseInt(
  process.env.SWARMFLEET_RESTART_DELAY_MS ?? String(DEFAULT_RESTART_DELAY_MS),
  10,
);
const shutdownGraceMs = Number.parseInt(
  process.env.SWARMFLEET_SHUTDOWN_GRACE_MS ?? String(DEFAULT_SHUTDOWN_GRACE_MS),
  10,
);

const separatorIndex = process.argv.indexOf("--");
const childArgs =
  separatorIndex === -1
    ? process.argv.slice(2)
    : process.argv.slice(separatorIndex + 1);

if (childArgs.length === 0) {
  console.error(
    "Usage: tsx scripts/dev-supervisor.ts -- <entrypoint> [args...]",
  );
  process.exit(1);
}

const cwd = process.cwd();
const watchRoots = [cwd, path.resolve(cwd, "../shared")].filter((dir) =>
  existsSync(dir),
);

const ignoredDirs = new Set([
  ".git",
  ".turbo",
  ".vite",
  "coverage",
  "dist",
  "logs",
  "node_modules",
  "tmp",
]);

const ignoredFiles = new Set([
  ".DS_Store",
  "package-lock.json",
  "npm-debug.log",
  "yarn.lock",
  "pnpm-lock.yaml",
  "cli/version.ts",
]);

let child: ChildProcess | null = null;
let restartTimer: ReturnType<typeof setTimeout> | null = null;
let restarting = false;
let queuedReason: string | null = null;
let shuttingDown = false;
const watchers = new Map<string, FSWatcher>();

function relativeToRoot(filePath: string): string {
  for (const root of watchRoots) {
    const relative = path.relative(root, filePath);
    if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
      return relative.split(path.sep).join("/");
    }
  }
  return filePath;
}

function shouldIgnore(filePath: string): boolean {
  const relative = relativeToRoot(filePath);
  const parts = relative.split("/");
  if (parts.some((part) => ignoredDirs.has(part))) return true;
  if (ignoredFiles.has(relative) || ignoredFiles.has(path.basename(relative))) {
    return true;
  }
  if (relative.endsWith(".log") || relative.endsWith(".tmp")) return true;
  if (relative.endsWith(".test.ts") || relative.endsWith(".test.tsx"))
    return true;
  if (parts.includes("tests") || parts.includes("__tests__")) return true;
  if (relative === "scripts/dev-supervisor.ts") return true;
  return false;
}

function watchDirectory(dir: string): void {
  if (watchers.has(dir) || shouldIgnore(dir)) return;

  let watcher: FSWatcher;
  try {
    watcher = watch(dir, (eventType, filename) => {
      if (!filename) return;
      const changedPath = path.join(dir, filename.toString());
      if (shouldIgnore(changedPath)) return;

      if (eventType === "rename") {
        maybeWatchNewDirectory(changedPath);
      }

      scheduleRestart(relativeToRoot(changedPath));
    });
  } catch {
    return;
  }

  watchers.set(dir, watcher);
}

function maybeWatchNewDirectory(filePath: string): void {
  try {
    if (statSync(filePath).isDirectory()) {
      watchTree(filePath);
    }
  } catch {
    // Rename events also fire for deletes.
  }
}

function watchTree(root: string): void {
  if (shouldIgnore(root)) return;
  watchDirectory(root);

  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const childDir = path.join(root, entry.name);
    if (!shouldIgnore(childDir)) {
      watchTree(childDir);
    }
  }
}

function startChild(): void {
  console.log(`[dev-supervisor] starting: tsx ${childArgs.join(" ")}`);
  child = spawn("tsx", childArgs, {
    cwd,
    env: process.env,
    stdio: "inherit",
  });

  child.on("exit", (code, signal) => {
    if (shuttingDown || restarting) return;
    console.log(
      `[dev-supervisor] backend exited unexpectedly code=${code ?? "null"} signal=${signal ?? "null"}; restarting`,
    );
    startChild();
  });
}

async function stopChild(): Promise<void> {
  const current = child;
  if (!current || current.exitCode !== null || current.signalCode !== null) {
    return;
  }

  await new Promise<void>((resolve) => {
    const forceKill = setTimeout(() => {
      if (current.exitCode === null && current.signalCode === null) {
        console.log(
          `[dev-supervisor] graceful shutdown exceeded ${shutdownGraceMs}ms; sending SIGKILL`,
        );
        current.kill("SIGKILL");
      }
    }, shutdownGraceMs + 250);

    current.once("exit", () => {
      clearTimeout(forceKill);
      resolve();
    });

    current.kill("SIGTERM");
  });
}

function scheduleRestart(reason: string): void {
  if (shuttingDown) return;
  queuedReason = reason;
  if (restartTimer) {
    clearTimeout(restartTimer);
  }

  console.log(
    `[dev-supervisor] change detected: ${reason}; restarting after ${Math.round(restartDelayMs / 1000)}s quiet period`,
  );
  restartTimer = setTimeout(() => {
    restartTimer = null;
    void restart();
  }, restartDelayMs);
}

async function restart(): Promise<void> {
  if (restarting) return;
  restarting = true;
  const reason = queuedReason;
  queuedReason = null;
  console.log(
    `[dev-supervisor] restarting backend${reason ? ` after ${reason}` : ""}`,
  );
  await stopChild();
  startChild();
  restarting = false;

  if (queuedReason) {
    scheduleRestart(queuedReason);
  }
}

async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
  for (const watcher of watchers.values()) {
    watcher.close();
  }
  await stopChild();
  process.exit(0);
}

for (const root of watchRoots) {
  watchTree(root);
}

console.log(
  `[dev-supervisor] watching ${watchRoots.map((root) => relativeToRoot(root)).join(", ")}; restart delay ${restartDelayMs}ms`,
);
startChild();

process.on("SIGINT", () => {
  void shutdown();
});
process.on("SIGTERM", () => {
  void shutdown();
});
