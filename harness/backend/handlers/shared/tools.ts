import { execFile, spawn } from "node:child_process";
import { constants, existsSync } from "node:fs";
import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { Context } from "hono";
import type {
  ToolManagerConfig,
  ToolManagerStatus,
  ToolManagerUpdateRequest,
} from "../../../shared/types.ts";
import { getHomeDir } from "../../utils/os.ts";

const TOOL_IDS = ["hermes", "chrome-devtools-mcp", "claude", "codex"] as const;
const execFileAsync = promisify(execFile);

const TOOL_NAMES: Record<(typeof TOOL_IDS)[number], string> = {
  hermes: "Hermes Agent",
  "chrome-devtools-mcp": "Chrome DevTools MCP",
  claude: "Claude Code",
  codex: "Codex",
};

function homeDir(): string {
  return process.env.HOME || getHomeDir() || "/home/user";
}

function toolsRoot(): string {
  const home = homeDir();
  return (
    process.env.SWARMFLEET_TOOLS_ROOT || join(home, ".swarmfleet", "tools")
  );
}

function configPath(): string {
  return join(toolsRoot(), "config.json");
}

function statusPath(): string {
  return join(toolsRoot(), "state", "status.json");
}

function toolManagerBinaryPath(): string {
  return (
    process.env.SWARMFLEET_TOOL_MANAGER_PATH ||
    "/usr/local/bin/swarmfleet-tool-manager"
  );
}

function toolSearchPaths(): string[] {
  const home = homeDir();
  const root = toolsRoot();
  return [
    join(root, "bin"),
    join(root, "npm", "bin"),
    join(root, "python", "bin"),
    join(home, ".local", "share", "mise", "shims"),
    ...(process.env.PATH ?? "").split(":").filter(Boolean),
  ];
}

async function executablePath(command: string): Promise<string | null> {
  for (const dir of [...new Set(toolSearchPaths())]) {
    const candidate = join(dir, command);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue searching.
    }
  }
  return null;
}

async function commandVersion(
  command: string,
): Promise<{ path: string | null; version: string | null }> {
  const path = await executablePath(command);
  if (!path) return { path: null, version: null };
  try {
    const { stdout, stderr } = await execFileAsync(path, ["--version"], {
      timeout: 8000,
      env: {
        ...process.env,
        HOME: homeDir(),
        PATH: toolSearchPaths().join(":"),
      },
    });
    const version = `${stdout}${stderr}`.trim().split(/\r?\n/)[0] || null;
    return { path, version };
  } catch {
    return { path, version: null };
  }
}

function signedIn(tool: (typeof TOOL_IDS)[number]): boolean | null {
  const home = homeDir();
  if (tool === "claude")
    return (
      existsSync(join(home, ".claude.json")) ||
      existsSync(join(home, ".claude"))
    );
  if (tool === "codex") return existsSync(join(home, ".codex", "auth.json"));
  if (tool === "hermes") return existsSync(join(home, ".hermes", "auth.json"));
  return null;
}

async function installedNodeVersions(miseDataDir: string): Promise<string[]> {
  try {
    const entries = await readdir(join(miseDataDir, "installs", "node"), {
      withFileTypes: true,
    });
    return entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

function defaultConfig(): ToolManagerConfig {
  const home = homeDir();
  const signedInClaude =
    existsSync(join(home, ".claude.json")) || existsSync(join(home, ".claude"));
  const signedInCodex = existsSync(join(home, ".codex", "auth.json"));
  return {
    version: 1,
    autoUpdate: { enabled: true, frequencyDays: 7 },
    tools: {
      hermes: { enabled: true, autoUpdate: true },
      "chrome-devtools-mcp": { enabled: true, autoUpdate: true },
      claude: { enabled: signedInClaude, autoUpdate: true },
      codex: { enabled: signedInCodex, autoUpdate: true },
    },
    runtimes: {
      node: {
        enabled: true,
        autoInstallProjectVersions: true,
        versions: ["22"],
      },
    },
  };
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

async function writeConfig(config: ToolManagerConfig): Promise<void> {
  const path = configPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(config, null, 2) + "\n", {
    mode: 0o600,
  });
}

function normalizeFrequencyDays(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if ([1, 3, 7, 14, 28].includes(parsed)) return parsed;
  return 7;
}

function normalizeNodeVersions(value: unknown): string[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/\r?\n|,/)
      : [];
  const versions = raw.map((item) => String(item).trim()).filter(Boolean);
  return [...new Set(versions)].slice(0, 12);
}

function mergeWithDefaultConfig(config: ToolManagerConfig): ToolManagerConfig {
  const defaults = defaultConfig();
  const normalizedVersions = normalizeNodeVersions(
    config.runtimes?.node?.versions,
  );
  return {
    version: 1,
    autoUpdate: {
      enabled: config.autoUpdate?.enabled ?? defaults.autoUpdate.enabled,
      frequencyDays: normalizeFrequencyDays(config.autoUpdate?.frequencyDays),
    },
    tools: { ...defaults.tools, ...(config.tools ?? {}) },
    runtimes: {
      node: {
        ...defaults.runtimes!.node,
        ...(config.runtimes?.node ?? {}),
        versions: normalizedVersions.length
          ? normalizedVersions
          : defaults.runtimes!.node.versions,
      },
    },
  };
}

export async function handleToolsStatusRequest(c: Context): Promise<Response> {
  const config = mergeWithDefaultConfig(
    await readJson<ToolManagerConfig>(configPath(), defaultConfig()),
  );
  const fallbackStatus: ToolManagerStatus = {
    version: 1,
    state: "ready",
    message: "Tool manager has not reported yet",
    updatedAt: Date.now(),
    toolsRoot: toolsRoot(),
    autoUpdate: config.autoUpdate,
    tools: {},
  };
  const status = await readJson<ToolManagerStatus>(
    statusPath(),
    fallbackStatus,
  );
  status.autoUpdate = config.autoUpdate;
  status.toolsRoot = status.toolsRoot || toolsRoot();
  const miseDataDir =
    status.runtimes?.node?.miseDataDir ??
    process.env.MISE_DATA_DIR ??
    join(homeDir(), ".local", "share", "mise");
  const liveNode = await commandVersion("node");
  status.runtimes = {
    node: {
      ...config.runtimes!.node,
      installedVersions: await installedNodeVersions(miseDataDir),
      miseDataDir,
      defaultBinaryPath: liveNode.path,
      defaultVersion: liveNode.version,
    },
  };
  for (const id of TOOL_IDS) {
    const live = await commandVersion(id);
    status.tools[id] = {
      id,
      name: TOOL_NAMES[id],
      enabled: config.tools[id]?.enabled ?? false,
      autoUpdate: config.tools[id]?.autoUpdate !== false,
      installed: Boolean(live.path),
      binaryPath: live.path,
      version: live.version,
      signedIn: signedIn(id),
    };
  }
  return c.json(status);
}

export async function handleToolsConfigRequest(c: Context): Promise<Response> {
  const config = mergeWithDefaultConfig(
    await readJson<ToolManagerConfig>(configPath(), defaultConfig()),
  );
  return c.json(config);
}

export async function handleUpdateToolsConfigRequest(
  c: Context,
): Promise<Response> {
  const body = (await c.req
    .json()
    .catch(() => ({}))) as ToolManagerUpdateRequest;
  const current = mergeWithDefaultConfig(
    await readJson<ToolManagerConfig>(configPath(), defaultConfig()),
  );
  const next: ToolManagerConfig = {
    version: 1,
    autoUpdate: {
      enabled:
        typeof body.autoUpdate?.enabled === "boolean"
          ? body.autoUpdate.enabled
          : current.autoUpdate.enabled,
      frequencyDays: Object.prototype.hasOwnProperty.call(
        body.autoUpdate ?? {},
        "frequencyDays",
      )
        ? normalizeFrequencyDays(body.autoUpdate?.frequencyDays)
        : normalizeFrequencyDays(current.autoUpdate.frequencyDays),
    },
    tools: { ...current.tools },
    runtimes: { node: { ...current.runtimes!.node } },
  };
  if (body.tools && typeof body.tools === "object") {
    for (const id of TOOL_IDS) {
      const update = body.tools[id];
      if (!update) continue;
      next.tools[id] = {
        enabled:
          typeof update.enabled === "boolean"
            ? update.enabled
            : (next.tools[id]?.enabled ?? false),
        autoUpdate:
          typeof update.autoUpdate === "boolean"
            ? update.autoUpdate
            : next.tools[id]?.autoUpdate !== false,
      };
    }
  }
  const nodeUpdate = body.runtimes?.node;
  if (nodeUpdate && typeof nodeUpdate === "object") {
    next.runtimes = {
      node: {
        enabled:
          typeof nodeUpdate.enabled === "boolean"
            ? nodeUpdate.enabled
            : next.runtimes!.node.enabled,
        autoInstallProjectVersions:
          typeof nodeUpdate.autoInstallProjectVersions === "boolean"
            ? nodeUpdate.autoInstallProjectVersions
            : next.runtimes!.node.autoInstallProjectVersions,
        versions: Object.prototype.hasOwnProperty.call(nodeUpdate, "versions")
          ? normalizeNodeVersions(nodeUpdate.versions)
          : next.runtimes!.node.versions,
      },
    };
  }
  await writeConfig(next);
  return c.json(next);
}

export async function handleToolsUpdateNowRequest(
  c: Context,
): Promise<Response> {
  const root = toolsRoot();
  const managerPath = toolManagerBinaryPath();
  try {
    await access(managerPath, constants.X_OK);
  } catch {
    return c.json(
      { error: `Tool manager is not executable: ${managerPath}` },
      503,
    );
  }
  const child = spawn(managerPath, [], {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      HOME: homeDir(),
      SWARMFLEET_TOOLS_ROOT: root,
      SWARMFLEET_TOOL_MANAGER_RUN_ONCE: "1",
    },
  });
  child.on("error", () => {
    // The preflight access check catches the usual ENOENT/EACCES cases. Keep an
    // error listener so a late spawn failure cannot crash the backend process.
  });
  child.unref();
  return c.json({ ok: true, message: "Tool update started", toolsRoot: root });
}
