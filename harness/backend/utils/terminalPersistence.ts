/**
 * Terminal session persistence -- JSONL file-based storage.
 *
 * Stores per-session command history and metadata in
 * ${HOME}/.swarmfleet/terminal-history/
 */

import { appendFile, readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { redactEnvVars, redactText } from "./redact.ts";

const HOME_DIR = process.env.HOME || "/home/user";
const HISTORY_DIR =
  process.env.SWARMFLEET_TERMINAL_HISTORY_DIR ||
  join(HOME_DIR, ".swarmfleet", "terminal-history");
const INDEX_FILE = join(HISTORY_DIR, "sessions-index.json");

// -- Entry types --

export interface SessionStartEntry {
  type: "session_start";
  ts: string;
  sessionId: string;
  name: string;
  cwd: string;
  env: Record<string, string>;
}

export interface CommandEntry {
  type: "command";
  ts: string;
  input: string;
}

export interface StateSnapshotEntry {
  type: "state_snapshot";
  ts: string;
  cwd: string;
  env: Record<string, string>;
}

export interface SessionEndEntry {
  type: "session_end";
  ts: string;
  exitCode: number | null;
  reason: "killed" | "exited" | "server_shutdown";
}

export type HistoryEntry =
  | SessionStartEntry
  | CommandEntry
  | StateSnapshotEntry
  | SessionEndEntry;

export interface SessionIndexEntry {
  id: string;
  name: string;
  createdAt: string;
  endedAt: string | null;
  cwd: string;
  alive: boolean;
}

// -- Directory / file helpers --

export async function ensureHistoryDir(): Promise<void> {
  await mkdir(HISTORY_DIR, { recursive: true });
}

function sessionFile(sessionId: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9_\-]/g, "_");
  return join(HISTORY_DIR, `${safe}.jsonl`);
}

async function appendEntry(
  sessionId: string,
  entry: HistoryEntry,
): Promise<void> {
  await appendFile(sessionFile(sessionId), JSON.stringify(entry) + "\n", "utf-8");
}

// -- Persist operations --

export async function persistSessionStart(
  sessionId: string,
  name: string,
  cwd: string,
  env: Record<string, string | undefined>,
): Promise<void> {
  await ensureHistoryDir();
  const entry: SessionStartEntry = {
    type: "session_start",
    ts: new Date().toISOString(),
    sessionId,
    name,
    cwd,
    env: redactEnvVars(env),
  };
  await appendEntry(sessionId, entry);
}

export async function persistCommand(
  sessionId: string,
  input: string,
): Promise<void> {
  if (input.length <= 2 && /^[\x00-\x1f]+$/.test(input)) return;

  const entry: CommandEntry = {
    type: "command",
    ts: new Date().toISOString(),
    input: redactText(input),
  };
  await appendEntry(sessionId, entry);
}

export async function persistSessionEnd(
  sessionId: string,
  exitCode: number | null,
  reason: "killed" | "exited" | "server_shutdown",
): Promise<void> {
  const entry: SessionEndEntry = {
    type: "session_end",
    ts: new Date().toISOString(),
    exitCode,
    reason,
  };
  await appendEntry(sessionId, entry);
}

// -- Read operations --

export async function readSessionHistory(
  sessionId: string,
): Promise<HistoryEntry[]> {
  try {
    const content = await readFile(sessionFile(sessionId), "utf-8");
    return content
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => {
        try {
          return JSON.parse(line) as HistoryEntry;
        } catch {
          return null;
        }
      })
      .filter((entry): entry is HistoryEntry => entry !== null);
  } catch {
    return [];
  }
}

// -- Session index --

export async function loadSessionIndex(): Promise<SessionIndexEntry[]> {
  try {
    const content = await readFile(INDEX_FILE, "utf-8");
    const data = JSON.parse(content);
    if (Array.isArray(data.sessions)) {
      return data.sessions as SessionIndexEntry[];
    }
    return [];
  } catch {
    return [];
  }
}

export async function updateSessionIndex(
  sessions: SessionIndexEntry[],
): Promise<void> {
  await ensureHistoryDir();
  await writeFile(
    INDEX_FILE,
    JSON.stringify({ sessions }, null, 2) + "\n",
    "utf-8",
  );
}

/**
 * Scans the session index for the highest counter value in session IDs.
 */
export function getHighestSessionCounter(
  sessions: SessionIndexEntry[],
): number {
  let max = 0;
  for (const s of sessions) {
    const match = s.id.match(/^term-(\d+)-/);
    if (match) {
      const n = parseInt(match[1], 10);
      if (n > max) max = n;
    }
  }
  return max;
}
