import os from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const e2eRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

export const BACKEND_PORT = Number(process.env.SWARMFLEET_E2E_BACKEND_PORT ?? "4567");
export const FRONTEND_PORT = Number(process.env.SWARMFLEET_E2E_FRONTEND_PORT ?? "7070");
export const BASE_URL =
  process.env.SWARMFLEET_E2E_BASE_URL ?? `http://127.0.0.1:${FRONTEND_PORT}`;
export const WORKSPACE_ROOT =
  process.env.SWARMFLEET_E2E_WORKSPACE_ROOT ??
  join(os.tmpdir(), "swarmfleet-e2e-workspace");
export const RUNTIME_DIR = join(e2eRoot, ".runtime");
export const CONFIG_DIR = join(RUNTIME_DIR, "config");
export const SERVER_STATE_PATH = join(RUNTIME_DIR, "server-state.json");
export const STORAGE_STATE_PATH = join(RUNTIME_DIR, "storage-state.json");
export const PROVIDER_STATE_PATH = join(RUNTIME_DIR, "provider-state.json");

export const PROJECTS = {
  anthropic: "e2e-anthropic",
  openai: "e2e-openai",
  files: "e2e-files",
  terminal: "e2e-terminal",
  settings: "e2e-settings",
  sessions: "e2e-sessions",
} as const;

export interface ServerState {
  backendPid: number;
  frontendPid: number;
  backendPort: number;
  frontendPort: number;
  baseURL: string;
  workspaceRoot: string;
  startedAt: string;
}

export function projectPath(projectName: string): string {
  return join(WORKSPACE_ROOT, projectName);
}

export async function ensureRuntimeDir(): Promise<void> {
  await mkdir(RUNTIME_DIR, { recursive: true });
}

export async function writeServerState(state: ServerState): Promise<void> {
  await ensureRuntimeDir();
  await writeFile(SERVER_STATE_PATH, JSON.stringify(state, null, 2), "utf8");
}

export function readServerState(): ServerState | null {
  if (!existsSync(SERVER_STATE_PATH)) return null;
  return JSON.parse(readFileSync(SERVER_STATE_PATH, "utf8")) as ServerState;
}

export async function clearRuntimeState(): Promise<void> {
  await rm(RUNTIME_DIR, { recursive: true, force: true });
}

export async function resetProjectDir(projectName: string): Promise<void> {
  const dir = projectPath(projectName);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
}

export async function seedFilesProject(): Promise<void> {
  const dir = projectPath(PROJECTS.files);
  await resetProjectDir(PROJECTS.files);
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "src", "main.ts"), 'console.log("main");\n', "utf8");
  await writeFile(join(dir, "src", "utils.ts"), "export const sum = (a: number, b: number) => a + b;\n", "utf8");
  await writeFile(join(dir, "README.md"), "# e2e-files\n", "utf8");
  await writeFile(
    join(dir, "wide-natural-size.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 440 550" width="1080" height="1350"><rect width="440" height="550" fill="#fff"/><circle cx="220" cy="275" r="220" fill="#0f8a6c"/><text x="220" y="290" text-anchor="middle" font-size="48" fill="#fff">SVG</text></svg>\n',
    "utf8",
  );
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify(
      {
        name: "e2e-files",
        private: true,
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
}

export async function prepareWorkspaceRoot(): Promise<void> {
  await rm(WORKSPACE_ROOT, { recursive: true, force: true });
  await mkdir(WORKSPACE_ROOT, { recursive: true });

  await Promise.all([
    resetProjectDir(PROJECTS.anthropic),
    resetProjectDir(PROJECTS.openai),
    resetProjectDir(PROJECTS.terminal),
    resetProjectDir(PROJECTS.settings),
    resetProjectDir(PROJECTS.sessions),
    seedFilesProject(),
  ]);
}

export async function cleanupWorkspaceRoot(): Promise<void> {
  await rm(WORKSPACE_ROOT, { recursive: true, force: true });
}

export async function cleanupChatSessionStore(): Promise<void> {
  const homeDir = process.env.HOME ?? process.env.USERPROFILE;
  if (!homeDir) return;

  const storageRoot = join(homeDir, ".swarmfleet", "chat-sessions");
  const indexPath = join(storageRoot, "index.json");
  const sessionsRoot = join(storageRoot, "sessions");

  if (!existsSync(indexPath)) return;

  type SessionIndex = {
    version: number;
    importedLegacyAt: string | null;
    sessions: Array<{
      sessionId: string;
      projectPath: string;
      encodedProjectName: string | null;
      archivedAt: string | null;
    }>;
  };

  const index = JSON.parse(
    await readFile(indexPath, "utf8"),
  ) as SessionIndex;
  const retainedSessions = [];

  for (const session of index.sessions) {
    if (session.projectPath.startsWith(WORKSPACE_ROOT)) {
      await rm(join(sessionsRoot, session.sessionId), {
        recursive: true,
        force: true,
      });
      continue;
    }
    retainedSessions.push(session);
  }

  index.sessions = retainedSessions;
  await writeFile(indexPath, JSON.stringify(index, null, 2), "utf8");
}
