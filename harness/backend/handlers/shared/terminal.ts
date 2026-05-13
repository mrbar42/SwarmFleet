import type { ConfigContext } from "../../middleware/config.ts";
import type { AppConfig } from "../../types.ts";
import * as pty from "node-pty";
import type { IPty } from "node-pty";
import { resolve } from "path";
import {
  persistSessionStart,
  persistCommand,
  persistSessionEnd,
  readSessionHistory,
  loadSessionIndex,
  updateSessionIndex,
  getHighestSessionCounter,
  type SessionIndexEntry,
} from "../../utils/terminalPersistence.ts";
import { logger } from "../../utils/logger.ts";

const DEFAULT_WORKSPACES_ROOT = process.env.WORKSPACES_ROOT || "/workspace";
const DEFAULT_SESSION_NAME = "Terminal";
const TERMINAL_PS1 = "\\u:\\w\\$ ";

interface TerminalSession {
  id: string;
  name: string;
  pty: IPty | null;
  buffer: string[];
  createdAt: string;
  cwd: string;
  alive: boolean;
}

const sessions = new Map<string, TerminalSession>();
let sessionCounter = 0;

function generateId(): string {
  return `term-${++sessionCounter}-${Date.now().toString(36)}`;
}

function isDefaultSession(session: Pick<TerminalSession, "name">): boolean {
  return session.name === DEFAULT_SESSION_NAME;
}

function isSessionInProject(session: Pick<TerminalSession, "cwd">, projectPath: string): boolean {
  return session.cwd === projectPath || session.cwd.startsWith(projectPath + "/");
}

async function syncIndex(): Promise<void> {
  const entries: SessionIndexEntry[] = Array.from(sessions.values()).map(
    (s) => ({
      id: s.id,
      name: s.name,
      createdAt: s.createdAt,
      endedAt: s.alive ? null : new Date().toISOString(),
      cwd: s.cwd,
      alive: s.alive,
    }),
  );
  await updateSessionIndex(entries).catch((err) => {
    logger.app.debug(`Failed to sync session index: ${err}`);
  });
}

async function loadPersistedSessions(): Promise<void> {
  const index = await loadSessionIndex().catch(() => []);
  if (index.length === 0) return;

  sessionCounter = getHighestSessionCounter(index);

  for (const entry of index) {
    if (entry.alive) {
      persistSessionEnd(entry.id, null, "server_shutdown").catch(() => {});
    }
    sessions.set(entry.id, {
      id: entry.id,
      name: entry.name,
      pty: null,
      buffer: [],
      createdAt: entry.createdAt,
      cwd: entry.cwd,
      alive: false,
    });
  }

  await syncIndex();
  logger.app.info(
    `Restored ${index.length} persisted terminal session(s) from history`,
  );
}

function getWorkspacesRoot(c: { get: (key: "config") => AppConfig | undefined }): string {
  return c.get("config")?.workspacesRoot || DEFAULT_WORKSPACES_ROOT;
}

function allowedRoots(workspacesRoot: string): string[] {
  return [workspacesRoot, process.env.SWARMFLEET_HARNESS_DIR].filter(
    (value): value is string => Boolean(value),
  );
}

function pathBelongsToRoot(path: string, root: string): boolean {
  const resolved = resolve(path);
  const resolvedRoot = resolve(root);
  return resolved === resolvedRoot || resolved.startsWith(resolvedRoot + "/");
}

function isAllowedCwd(cwd: string, workspacesRoot: string): boolean {
  return allowedRoots(workspacesRoot).some((root) => pathBelongsToRoot(cwd, root));
}

function resolveCwd(cwd: string, workspacesRoot = DEFAULT_WORKSPACES_ROOT): string {
  const resolved = resolve(cwd);
  return isAllowedCwd(resolved, workspacesRoot) ? resolved : resolve(workspacesRoot);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function isBashShell(shell: string): boolean {
  return /(^|\/)bash$/.test(shell);
}

export function buildTerminalSpawnOptions(
  shell: string = process.env.SHELL || "/bin/bash",
  env: Record<string, string | undefined> = process.env,
): { shell: string; args: string[]; env: Record<string, string> } {
  const terminalEnv = {
    ...(env as Record<string, string>),
    PS1: TERMINAL_PS1,
  };

  if (!isBashShell(shell)) {
    return { shell, args: ["-l"], env: terminalEnv };
  }

  // Debian's /etc/bash.bashrc overwrites PS1 with \u@\h:\w\$ even when PS1
  // is supplied in the environment. Start bash with a generated rcfile so the
  // normal shell setup still runs, then force the prompt back to user:path.
  const bashRc = [
    `if [ -r /etc/bash.bashrc ]; then . /etc/bash.bashrc; fi`,
    `if [ -r "$HOME/.bashrc" ]; then . "$HOME/.bashrc"; fi`,
    `PS1=${shellQuote(TERMINAL_PS1)}`,
    `export PS1`,
  ].join("\n");

  return {
    shell,
    args: [
      "-lc",
      `exec ${shellQuote(shell)} --rcfile <(printf %s ${shellQuote(bashRc)}) -i`,
    ],
    env: terminalEnv,
  };
}

function spawnPty(
  cwd: string,
  cols: number = 120,
  rows: number = 30,
): IPty {
  const spawn = buildTerminalSpawnOptions();
  return pty.spawn(spawn.shell, spawn.args, {
    name: "xterm-256color",
    cols,
    rows,
    cwd,
    env: spawn.env,
  });
}

function createSessionFromPty(
  id: string,
  name: string,
  cwd: string,
  proc: IPty,
): TerminalSession {
  const session: TerminalSession = {
    id,
    name,
    pty: proc,
    buffer: [],
    createdAt: new Date().toISOString(),
    cwd,
    alive: true,
  };

  proc.onData((data: string) => {
    session.buffer.push(data);
    if (session.buffer.length > 5000) {
      session.buffer = session.buffer.slice(-4000);
    }
  });

  proc.onExit(({ exitCode }) => {
    const shouldPersistExit = session.alive;
    session.alive = false;
    if (shouldPersistExit) {
      persistSessionEnd(session.id, exitCode, "exited").catch(() => {});
    }
    syncIndex().catch(() => {});
  });

  sessions.set(id, session);

  persistSessionStart(
    id,
    name,
    cwd,
    process.env as Record<string, string>,
  ).catch(() => {});
  syncIndex().catch(() => {});

  return session;
}

async function retireSession(
  session: TerminalSession,
  reason: "killed" | "server_shutdown",
  remove: boolean = true,
): Promise<void> {
  if (session.alive) {
    session.alive = false;
    await persistSessionEnd(session.id, null, reason).catch(() => {});
    try {
      session.pty?.kill();
    } catch {
      // already dead
    }
  }
  session.pty = null;
  if (remove) {
    sessions.delete(session.id);
  }
}

function formatHistoryLine(entry: Awaited<ReturnType<typeof readSessionHistory>>[number]): string | null {
  if (entry.type === "command" && entry.input) {
    const time = new Date(entry.ts).toLocaleTimeString();
    const cmd = entry.input.replace(/\n$/, "");
    return `[${time}] $ ${cmd}`;
  }
  if (entry.type === "session_start") {
    const time = new Date(entry.ts).toLocaleTimeString();
    return `[${time}] Session started in ${entry.cwd}`;
  }
  if (entry.type === "session_end") {
    const time = new Date(entry.ts).toLocaleTimeString();
    const reason = entry.reason || "unknown";
    const code = entry.exitCode != null ? ` (exit ${entry.exitCode})` : "";
    return `[${time}] Session ended: ${reason}${code}`;
  }
  return null;
}

async function buildDefaultHistoryPrelude(previousSessions: TerminalSession[]): Promise<string> {
  if (previousSessions.length === 0) return "";

  const ordered = [...previousSessions].sort(
    (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt),
  );
  const chunks: string[] = [];

  for (const session of ordered) {
    const history = await readSessionHistory(session.id);
    const lines = history
      .map(formatHistoryLine)
      .filter((line): line is string => line !== null);
    if (lines.length > 0) {
      chunks.push(lines.join("\r\n"));
    }
  }

  const restartTime = new Date().toLocaleTimeString();
  chunks.push(`\x1b[90m[${restartTime}] Session restarted\x1b[0m`);

  return chunks.join("\r\n") + "\r\n";
}

/**
 * Graceful shutdown: persist session_end for all alive sessions.
 */
export async function shutdownAllSessions(): Promise<void> {
  const promises: Promise<void>[] = [];
  for (const session of sessions.values()) {
    if (session.alive) {
      promises.push(
        retireSession(session, "server_shutdown", false).catch(() => {}),
      );
    }
  }
  await Promise.all(promises);
  await syncIndex();
}

export function registerTerminalRoutes(
  app: import("hono").Hono<ConfigContext>,
): void {
  const ready = loadPersistedSessions().catch((err) => {
    logger.app.debug(`Failed to load persisted terminal sessions: ${err}`);
  });

  // List terminal sessions (optionally scoped by project path)
  app.get("/api/terminal/sessions", async (c) => {
    await ready;
    const projectFilter = c.req.query("project");
    let filtered = Array.from(sessions.values());
    if (projectFilter) {
      const resolved = resolve(projectFilter);
      filtered = filtered.filter(
        (s) => s.cwd === resolved || s.cwd.startsWith(resolved + "/"),
      );
    }
    const list = filtered.map((s) => ({
      id: s.id,
      name: s.name,
      createdAt: s.createdAt,
      cwd: s.cwd,
      alive: s.alive,
    }));
    return c.json({ sessions: list });
  });

  // Create a new terminal session
  app.post("/api/terminal/sessions", async (c) => {
    const body = await c.req
      .json<{
        cwd?: string;
        name?: string;
        cols?: number;
        rows?: number;
        restartDefault?: boolean;
      }>()
      .catch(() => ({} as {
        cwd?: string;
        name?: string;
        cols?: number;
        rows?: number;
        restartDefault?: boolean;
      }));

    const workspacesRoot = getWorkspacesRoot(c);
    const cwd = body.cwd || workspacesRoot;
    const resolved = resolve(cwd);
    if (!isAllowedCwd(resolved, workspacesRoot)) {
      return c.json(
        {
          error: "Path outside workspace",
          cwd: resolved,
          allowedRoots: allowedRoots(workspacesRoot).map((root) => resolve(root)),
        },
        403,
      );
    }

    let historyPrelude = "";
    if (body.restartDefault) {
      const previousDefaultSessions = Array.from(sessions.values()).filter(
        (session) => isDefaultSession(session) && isSessionInProject(session, resolved),
      );
      historyPrelude = await buildDefaultHistoryPrelude(previousDefaultSessions);
      for (const session of previousDefaultSessions) {
        await retireSession(session, "killed");
      }
      await syncIndex().catch(() => {});
    }

    const id = generateId();
    const name = body.name || (body.restartDefault ? DEFAULT_SESSION_NAME : `Terminal ${sessions.size + 1}`);
    const cols = (body as { cols?: number }).cols || 120;
    const rows = (body as { rows?: number }).rows || 30;

    const proc = spawnPty(resolved, cols, rows);
    const session = createSessionFromPty(id, name, resolved, proc);

    return c.json({
      id,
      name,
      createdAt: session.createdAt,
      cwd: session.cwd,
      alive: true,
      historyPrelude,
    });
  });

  // Send input to terminal
  app.post("/api/terminal/sessions/:id/input", async (c) => {
    const id = c.req.param("id");
    const session = sessions.get(id);
    if (!session) return c.json({ error: "Session not found" }, 404);
    if (!session.alive) return c.json({ error: "Session is dead" }, 410);

    const body = await c.req.json<{ input: string }>();
    if (body.input === undefined)
      return c.json({ error: "Missing input" }, 400);

    session.pty?.write(body.input);

    // Only persist complete commands (containing newline), not individual keystrokes
    if (body.input.includes("\n") || body.input.includes("\r")) {
      persistCommand(id, body.input).catch(() => {});
    }

    return c.json({ ok: true });
  });

  // Stream terminal output (SSE-like NDJSON)
  app.get("/api/terminal/sessions/:id/stream", (c) => {
    const id = c.req.param("id");
    const session = sessions.get(id);
    if (!session) return c.json({ error: "Session not found" }, 404);
    if (!session.pty)
      return c.json({ error: "Session has no active process" }, 410);

    const sinceIdx = parseInt(c.req.query("since") || "0");

    const sess = session;
    const proc = session.pty;
    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();

        if (sinceIdx < sess.buffer.length) {
          const chunk = sess.buffer.slice(sinceIdx);
          controller.enqueue(
            encoder.encode(
              JSON.stringify({
                type: "output",
                data: chunk.join(""),
                index: sess.buffer.length,
              }) + "\n",
            ),
          );
        }

        const disposable = proc.onData((data: string) => {
          try {
            controller.enqueue(
              encoder.encode(
                JSON.stringify({
                  type: "output",
                  data,
                  index: sess.buffer.length,
                }) + "\n",
              ),
            );
          } catch {
            cleanup();
          }
        });

        const exitDisposable = proc.onExit(({ exitCode }) => {
          try {
            controller.enqueue(
              encoder.encode(
                JSON.stringify({ type: "exit", code: exitCode }) + "\n",
              ),
            );
            controller.close();
          } catch {
            // already closed
          }
        });

        function cleanup() {
          disposable.dispose();
          exitDisposable.dispose();
        }

        const pingInterval = setInterval(() => {
          try {
            controller.enqueue(
              encoder.encode(JSON.stringify({ type: "ping" }) + "\n"),
            );
          } catch {
            clearInterval(pingInterval);
            cleanup();
          }
        }, 15000);

        c.req.raw.signal.addEventListener("abort", () => {
          clearInterval(pingInterval);
          cleanup();
        });
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "application/x-ndjson",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  });

  // Get persisted command history for a session
  app.get("/api/terminal/sessions/:id/history", async (c) => {
    const id = c.req.param("id");
    const entries = await readSessionHistory(id);
    return c.json({ entries });
  });

  // Restore a dead session (spawn new PTY in same directory)
  app.post("/api/terminal/sessions/:id/restore", async (c) => {
    const id = c.req.param("id");
    const oldSession = sessions.get(id);
    if (!oldSession) return c.json({ error: "Session not found" }, 404);
    if (oldSession.alive)
      return c.json({ error: "Session is still alive" }, 400);

    const history = await readSessionHistory(id);
    let lastCwd = oldSession.cwd;
    for (const entry of history) {
      if (entry.type === "state_snapshot" || entry.type === "session_start") {
        lastCwd = entry.cwd!;
      }
    }

    const cwd = resolveCwd(lastCwd, getWorkspacesRoot(c));
    const newId = generateId();
    const name = `${oldSession.name} (restored)`;

    const body = await c.req
      .json<{ cols?: number; rows?: number }>()
      .catch(() => ({} as { cols?: number; rows?: number }));
    const cols = body.cols || 120;
    const rows = body.rows || 30;

    const proc = spawnPty(cwd, cols, rows);
    const session = createSessionFromPty(newId, name, cwd, proc);

    return c.json({
      id: newId,
      name,
      createdAt: session.createdAt,
      cwd: session.cwd,
      alive: true,
    });
  });

  // Resize terminal
  app.post("/api/terminal/sessions/:id/resize", async (c) => {
    const id = c.req.param("id");
    const session = sessions.get(id);
    if (!session) return c.json({ error: "Session not found" }, 404);
    if (!session.alive) return c.json({ error: "Session is dead" }, 410);

    const body = await c.req.json<{ cols: number; rows: number }>();
    if (!body.cols || !body.rows)
      return c.json({ error: "Missing cols/rows" }, 400);

    session.pty?.resize(body.cols, body.rows);
    return c.json({ ok: true });
  });

  // Kill terminal session
  app.delete("/api/terminal/sessions/:id", async (c) => {
    const id = c.req.param("id");
    const session = sessions.get(id);
    if (!session) return c.json({ error: "Session not found" }, 404);

    await retireSession(session, "killed");
    await syncIndex().catch(() => {});
    return c.json({ ok: true });
  });
}
