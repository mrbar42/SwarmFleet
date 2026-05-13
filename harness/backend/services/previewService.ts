import { createHash } from "node:crypto";
import { createConnection } from "node:net";
import { existsSync, type Dirent } from "node:fs";
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { logger } from "../utils/logger.ts";

const SETTINGS_DIR = ".swarmfleet";
const SETTINGS_FILE = "settings.json";
const DEFAULT_COMMAND = "auto";
const PACKAGE_SCRIPT_NAME_RE = /^[A-Za-z0-9:_-]+$/;

type PreviewCommandSpec = {
  display: string;
  file: string;
  args: string[];
};
const DEFAULT_PORT_START = 41000;
const DEFAULT_PORT_END = 41999;
const DEFAULT_HOST_PORT_START = 42000;
const DEFAULT_HOST_PORT_END = 42009;
const READY_POLL_MS = 750;
const READY_TIMEOUT_MS = 30000;
const RETRY_DELAY_MS = 5000;
const LOG_MAX_CHARS = 12000;
const INSTALL_TIMEOUT_MS = 120000;
const ENV_PREVIEW_ID = "SWARMFLEET_PREVIEW_ID";
const ENV_PREVIEW_PROJECT = "SWARMFLEET_PREVIEW_PROJECT";
const ENV_PREVIEW_PORT = "SWARMFLEET_PREVIEW_PORT";

type PackageRunner = "npm" | "pnpm" | "yarn" | "bun";

interface PackageJson {
  scripts?: Record<string, unknown>;
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
}

interface PackageLockPackage {
  optional?: unknown;
  os?: unknown;
  cpu?: unknown;
}

interface PackageLockFile {
  packages?: Record<string, PackageLockPackage | undefined>;
}

export type PreviewState =
  | "idle"
  | "starting"
  | "running"
  | "error"
  | "stopped";

export interface PreviewStatus {
  id: string;
  projectPath: string;
  configuredCommand: string;
  resolvedCommand: string | null;
  state: PreviewState;
  port: number | null;
  url: string | null;
  hostUrl: string | null;
  devServer: PreviewDevServerSettings;
  error: string | null;
  logs: string;
  retryAt: number | null;
  startedAt: number | null;
  updatedAt: number;
}

interface PreviewRuntime {
  id: string;
  projectPath: string;
  configuredCommand: string;
  resolvedCommand: string | null;
  devServer: PreviewDevServerSettings;
  state: PreviewState;
  port: number | null;
  pid: number | null;
  pgid: number | null;
  process: ChildProcess | null;
  error: string | null;
  logs: string;
  retryTimer: ReturnType<typeof setTimeout> | null;
  readyTimer: ReturnType<typeof setTimeout> | null;
  retryAt: number | null;
  startedAt: number | null;
  updatedAt: number;
  stopRequested: boolean;
  startAttempt: number;
}

interface PreviewDevServerSettings {
  enabled: boolean;
  publishToHost: boolean;
  port: number | null;
  pid: number | null;
  pgid: number | null;
  startedAt: number | null;
}

interface PreviewFeatureSettings {
  enabled?: boolean;
  command?: unknown;
  devServer?: {
    enabled?: unknown;
    publishToHost?: unknown;
    port?: unknown;
    pid?: unknown;
    pgid?: unknown;
    startedAt?: unknown;
  };
}

interface PreviewSettingsFile {
  features?: Record<string, PreviewFeatureSettings | undefined>;
  [key: string]: unknown;
}

function getPortRange(): { start: number; end: number } {
  const start = Number.parseInt(
    process.env.SWARMFLEET_PREVIEW_PORT_START ?? "",
    10,
  );
  const end = Number.parseInt(
    process.env.SWARMFLEET_PREVIEW_PORT_END ?? "",
    10,
  );
  return {
    start: Number.isFinite(start) ? start : DEFAULT_PORT_START,
    end: Number.isFinite(end) ? end : DEFAULT_PORT_END,
  };
}

function getHostPortRange(): { start: number; end: number } {
  const start = Number.parseInt(
    process.env.SWARMFLEET_HOST_DEV_PORT_START ?? "",
    10,
  );
  const end = Number.parseInt(
    process.env.SWARMFLEET_HOST_DEV_PORT_END ?? "",
    10,
  );
  return {
    start: Number.isFinite(start) ? start : DEFAULT_HOST_PORT_START,
    end: Number.isFinite(end) ? end : DEFAULT_HOST_PORT_END,
  };
}

function previewIdForProject(projectPath: string): string {
  return createHash("sha256").update(projectPath).digest("hex").slice(0, 16);
}

function settingsPath(projectPath: string): string {
  return join(projectPath, SETTINGS_DIR, SETTINGS_FILE);
}

async function readSettings(projectPath: string): Promise<PreviewSettingsFile> {
  try {
    return JSON.parse(await readFile(settingsPath(projectPath), "utf-8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

async function writeSettings(
  projectPath: string,
  settings: PreviewSettingsFile,
): Promise<void> {
  await mkdir(join(projectPath, SETTINGS_DIR), { recursive: true });
  await writeFile(
    settingsPath(projectPath),
    JSON.stringify(settings, null, 2),
    "utf-8",
  );
}

async function readDevServerSettings(
  projectPath: string,
): Promise<PreviewDevServerSettings> {
  const settings = await readSettings(projectPath);
  const preview = settings.features?.preview;
  const devServer = preview?.devServer;
  const port =
    typeof devServer?.port === "number" && Number.isInteger(devServer.port)
      ? devServer.port
      : null;
  return {
    enabled: devServer?.enabled === false ? false : preview?.enabled === true,
    publishToHost: devServer?.publishToHost === true,
    port,
    pid:
      typeof devServer?.pid === "number" && Number.isInteger(devServer.pid)
        ? devServer.pid
        : null,
    pgid:
      typeof devServer?.pgid === "number" && Number.isInteger(devServer.pgid)
        ? devServer.pgid
        : null,
    startedAt:
      typeof devServer?.startedAt === "number" &&
      Number.isFinite(devServer.startedAt)
        ? devServer.startedAt
        : null,
  };
}

async function writeDevServerSettings(
  projectPath: string,
  patch: Partial<PreviewDevServerSettings>,
): Promise<PreviewDevServerSettings> {
  const settings = await readSettings(projectPath);
  settings.features = settings.features ?? {};
  const preview = settings.features.preview ?? {};
  const current = await readDevServerSettings(projectPath);
  const next = { ...current, ...patch };
  settings.features.preview = {
    ...preview,
    devServer: {
      enabled: next.enabled,
      publishToHost: next.publishToHost,
      port: next.port,
      pid: next.pid,
      pgid: next.pgid,
      startedAt: next.startedAt,
    },
  };
  await writeSettings(projectPath, settings);
  return next;
}

async function readConfiguredCommand(projectPath: string): Promise<string> {
  const settings = await readSettings(projectPath);
  const command = settings.features?.preview?.command;
  return typeof command === "string" && command.trim()
    ? command.trim()
    : DEFAULT_COMMAND;
}

function normalizeConfiguredCommand(command: string): string {
  const normalized = command.trim() || DEFAULT_COMMAND;
  if (normalized === DEFAULT_COMMAND) return normalized;
  parseConfiguredCommand(normalized);
  return normalized;
}

function parseConfiguredCommand(command: string): PreviewCommandSpec {
  const parts = command.trim().split(/\s+/);
  const [runner, second, third, ...rest] = parts;
  if (!runner || rest.length > 0) {
    throw new Error(
      "Preview command must be auto or a package script like 'npm run dev'",
    );
  }
  if (runner === "npm" && second === "start" && third === undefined) {
    return { display: "npm start", file: "npm", args: ["start"] };
  }
  if (
    (runner === "npm" || runner === "pnpm" || runner === "bun") &&
    second === "run" &&
    third &&
    PACKAGE_SCRIPT_NAME_RE.test(third)
  ) {
    return {
      display: `${runner} run ${third}`,
      file: runner,
      args: ["run", third],
    };
  }
  if (
    runner === "yarn" &&
    third === undefined &&
    second &&
    PACKAGE_SCRIPT_NAME_RE.test(second)
  ) {
    return { display: `yarn ${second}`, file: "yarn", args: [second] };
  }
  if (
    runner === "yarn" &&
    second === "run" &&
    third &&
    PACKAGE_SCRIPT_NAME_RE.test(third)
  ) {
    return { display: `yarn run ${third}`, file: "yarn", args: ["run", third] };
  }
  throw new Error(
    "Preview command must be auto or a package script like 'npm run dev'",
  );
}

async function writeConfiguredCommand(
  projectPath: string,
  command: string,
): Promise<string> {
  const normalized = normalizeConfiguredCommand(command);
  const settings = await readSettings(projectPath);
  settings.features = settings.features ?? {};
  settings.features.preview = {
    ...(settings.features.preview ?? {}),
    enabled: settings.features.preview?.enabled === true,
    command: normalized,
  };
  await writeSettings(projectPath, settings);
  return normalized;
}

function detectPackageRunner(projectPath: string): PackageRunner {
  if (existsSync(join(projectPath, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(projectPath, "yarn.lock"))) return "yarn";
  if (
    existsSync(join(projectPath, "bun.lockb")) ||
    existsSync(join(projectPath, "bun.lock"))
  ) {
    return "bun";
  }
  return "npm";
}

async function readPackageJson(projectPath: string): Promise<PackageJson | null> {
  const packageJsonPath = join(projectPath, "package.json");
  if (!existsSync(packageJsonPath)) return null;
  return JSON.parse(await readFile(packageJsonPath, "utf-8")) as PackageJson;
}

function nodeModulesPathForPackage(packageName: string): string {
  return join("node_modules", ...packageName.split("/"));
}

function packageNameFromNodeModulesPath(path: string): string | null {
  const parts = path.split("/");
  if (parts[0] !== "node_modules") return null;
  if (parts[1]?.startsWith("@")) {
    return parts[1] && parts[2] ? `${parts[1]}/${parts[2]}` : null;
  }
  return parts[1] ?? null;
}

function currentLibcTag(): "gnu" | "musl" | null {
  if (process.platform !== "linux") return null;
  const report = process.report?.getReport?.() as
    | { header?: { glibcVersionRuntime?: string } }
    | undefined;
  const glibcVersion = report?.header?.glibcVersionRuntime;
  return glibcVersion ? "gnu" : "musl";
}

function allowsCurrentValue(values: unknown, current: string): boolean {
  if (!Array.isArray(values) || values.length === 0) return true;
  const entries = values.filter(
    (value): value is string => typeof value === "string",
  );
  const excludes = entries
    .filter((value) => value.startsWith("!"))
    .map((value) => value.slice(1));
  if (excludes.includes(current)) return false;
  const includes = entries.filter((value) => !value.startsWith("!"));
  return includes.length === 0 || includes.includes(current);
}

function isPackageCompatible(
  packageName: string | null,
  spec: PackageLockPackage | undefined,
): boolean {
  if (!spec) return true;
  if (!allowsCurrentValue(spec.os, process.platform)) return false;
  if (!allowsCurrentValue(spec.cpu, process.arch)) return false;

  // npm lockfiles do not consistently record libc. Avoid treating the opposite
  // Linux libc native package as missing on every preview start.
  const libc = currentLibcTag();
  if (process.platform === "linux" && packageName && libc) {
    if (packageName.endsWith("-musl") && libc !== "musl") return false;
    if (packageName.endsWith("-gnu") && libc !== "gnu") return false;
  }
  return true;
}

async function shouldRunPackageInstall(projectPath: string): Promise<boolean> {
  const pkg = await readPackageJson(projectPath);
  if (!pkg) return false;

  if (!existsSync(join(projectPath, "node_modules"))) return true;

  for (const dependencyName of Object.keys({
    ...(pkg.dependencies ?? {}),
    ...(pkg.devDependencies ?? {}),
  })) {
    if (!existsSync(join(projectPath, nodeModulesPathForPackage(dependencyName)))) {
      return true;
    }
  }

  const lockPath = join(projectPath, "package-lock.json");
  if (!existsSync(lockPath)) return false;

  const lock = JSON.parse(await readFile(lockPath, "utf-8")) as PackageLockFile;
  for (const [packagePath, spec] of Object.entries(lock.packages ?? {})) {
    if (!packagePath.startsWith("node_modules/")) continue;
    if (spec?.optional !== true) continue;
    const packageName = packageNameFromNodeModulesPath(packagePath);
    if (!isPackageCompatible(packageName, spec)) continue;
    if (!existsSync(join(projectPath, packagePath))) return true;
  }

  return false;
}

function installArgsForRunner(runner: PackageRunner): string[] {
  if (runner === "npm") return ["install"];
  if (runner === "pnpm") return ["install"];
  if (runner === "yarn") return ["install"];
  return ["install"];
}

async function runPackageInstall(
  projectPath: string,
  runner: PackageRunner,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      runner,
      installArgsForRunner(runner),
      {
        cwd: projectPath,
        timeout: INSTALL_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        env: process.env,
      },
      (error, stdout, stderr) => {
        const output = `${stdout}${stderr}`.slice(-LOG_MAX_CHARS);
        if (error) {
          reject(new Error(`Dependency install failed: ${error.message}\n${output}`));
          return;
        }
        resolve(output);
      },
    );
    child.stdin?.end();
  });
}

function previewCommandUsesPackageRunner(command: string): boolean {
  return /^(npm|pnpm|yarn|bun)(\s+|$)/.test(command);
}

async function resolveAutoCommandSpec(projectPath: string): Promise<PreviewCommandSpec> {
  const pkg = await readPackageJson(projectPath);
  if (pkg) {
    const scripts = pkg.scripts ?? {};
    const runner = detectPackageRunner(projectPath);

    if (typeof scripts.dev === "string") {
      const hasVite =
        pkg.dependencies?.vite !== undefined ||
        pkg.devDependencies?.vite !== undefined;
      const args = ["run", "dev"];
      if (hasVite) {
        args.push(
          "--",
          "--host",
          "$HOST",
          "--port",
          "$SWARMFLEET_PREVIEW_PORT",
          "--strictPort",
        );
      }
      return {
        display: `${runner} run dev${hasVite ? " -- --host <host> --port <port> --strictPort" : ""}`,
        file: runner,
        args,
      };
    }
    if (typeof scripts.start === "string") {
      return runner === "npm"
        ? { display: "npm start", file: "npm", args: ["start"] }
        : { display: `${runner} run start`, file: runner, args: ["run", "start"] };
    }
  }

  throw new Error(
    "Auto preview could not find a package.json with a dev or start script",
  );
}

function appendLog(runtime: PreviewRuntime, chunk: Buffer | string): void {
  runtime.logs = (runtime.logs + chunk.toString()).slice(-LOG_MAX_CHARS);
  runtime.updatedAt = Date.now();
}

async function readProcFile(
  pid: number | string,
  file: string,
): Promise<Buffer | null> {
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

function parsePgidFromStat(raw: Buffer): number | null {
  const text = raw.toString("latin1");
  const rparenIdx = text.lastIndexOf(")");
  if (rparenIdx === -1) return null;
  const parts = text
    .slice(rparenIdx + 1)
    .trimStart()
    .split(/\s+/);
  const pgid = Number.parseInt(parts[2] ?? "", 10);
  return Number.isFinite(pgid) ? pgid : null;
}

async function processExists(pid: number | null): Promise<boolean> {
  if (pid === null) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function findTaggedPreviewProcess(
  id: string,
  projectPath: string,
): Promise<{ pid: number; pgid: number | null; port: number | null } | null> {
  let entries: string[];
  try {
    entries = await readdir("/proc");
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const environRaw = await readProcFile(entry, "environ");
    if (!environRaw) continue;
    const environ = parseEnviron(environRaw);
    if (
      environ.get(ENV_PREVIEW_ID) !== id ||
      environ.get(ENV_PREVIEW_PROJECT) !== projectPath
    ) {
      continue;
    }
    const pid = Number.parseInt(entry, 10);
    const port = Number.parseInt(environ.get(ENV_PREVIEW_PORT) ?? "", 10);
    const statRaw = await readProcFile(entry, "stat");
    return {
      pid,
      pgid: statRaw ? parsePgidFromStat(statRaw) : null,
      port: Number.isFinite(port) ? port : null,
    };
  }
  return null;
}

function isPortOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const done = (ok: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(500);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

async function findAvailablePort(usedPorts: Set<number>): Promise<number> {
  const { start, end } = getPortRange();
  for (let port = start; port <= end; port += 1) {
    if (usedPorts.has(port)) continue;
    if (!(await isPortOpen(port))) return port;
  }
  throw new Error(`No available preview ports in ${start}-${end}`);
}

async function findAvailableHostPort(usedPorts: Set<number>): Promise<number> {
  const { start, end } = getHostPortRange();
  for (let port = start; port <= end; port += 1) {
    if (usedPorts.has(port)) continue;
    if (!(await isPortOpen(port))) return port;
  }
  throw new Error(`No available host dev ports in ${start}-${end}`);
}

function hostUrlForPort(port: number | null): string | null {
  if (port === null) return null;
  const protocol = (
    process.env.SWARMFLEET_HOST_DEV_PUBLIC_PROTOCOL ?? "http"
  ).replace(/:$/, "");
  const host = process.env.SWARMFLEET_HOST_DEV_PUBLIC_HOST ?? "localhost";
  return `${protocol}://${host}:${port}/`;
}

function toPublicStatus(runtime: PreviewRuntime): PreviewStatus {
  return {
    id: runtime.id,
    projectPath: runtime.projectPath,
    configuredCommand: runtime.configuredCommand,
    resolvedCommand: runtime.resolvedCommand,
    state: runtime.state,
    port: runtime.port,
    url:
      runtime.state === "running"
        ? `/api/preview/proxy/${encodeURIComponent(runtime.id)}/`
        : null,
    hostUrl:
      runtime.devServer.publishToHost && runtime.devServer.port !== null
        ? hostUrlForPort(runtime.devServer.port)
        : null,
    devServer: {
      ...runtime.devServer,
      pid: runtime.pid,
      pgid: runtime.pgid,
      startedAt: runtime.startedAt,
    },
    error: runtime.error,
    logs: runtime.logs,
    retryAt: runtime.retryAt,
    startedAt: runtime.startedAt,
    updatedAt: runtime.updatedAt,
  };
}

export class PreviewService {
  private readonly runtimes = new Map<string, PreviewRuntime>();
  private hostPortAllocation = Promise.resolve();

  async status(projectPath: string): Promise<PreviewStatus> {
    const runtime = await this.getRuntime(projectPath);
    await this.reconnectDetachedRuntime(runtime);
    return toPublicStatus(runtime);
  }

  async configure(
    projectPath: string,
    command: string,
    options: { publishToHost?: boolean } = {},
  ): Promise<PreviewStatus> {
    const runtime = await this.getRuntime(projectPath);
    runtime.configuredCommand = await writeConfiguredCommand(
      projectPath,
      command,
    );
    if (typeof options.publishToHost === "boolean") {
      runtime.devServer = await this.setPublishToHost(
        projectPath,
        options.publishToHost,
      );
      if (options.publishToHost) {
        runtime.devServer = await this.ensureHostPort(runtime);
      }
    }
    runtime.updatedAt = Date.now();
    if (runtime.process || runtime.retryTimer) {
      await this.restart(projectPath);
    }
    return toPublicStatus(runtime);
  }

  async start(projectPath: string): Promise<PreviewStatus> {
    const runtime = await this.getRuntime(projectPath);
    await this.reconnectDetachedRuntime(runtime);
    if (runtime.state === "running" || runtime.state === "starting") {
      return toPublicStatus(runtime);
    }
    await this.startRuntime(runtime);
    return toPublicStatus(runtime);
  }

  async restart(projectPath: string): Promise<PreviewStatus> {
    const runtime = await this.getRuntime(projectPath);
    await this.stopRuntime(runtime, false);
    await this.startRuntime(runtime);
    return toPublicStatus(runtime);
  }

  async stop(projectPath: string): Promise<PreviewStatus> {
    const runtime = await this.getRuntime(projectPath);
    await this.stopRuntime(runtime, true);
    return toPublicStatus(runtime);
  }

  getById(id: string): PreviewStatus | null {
    const runtime = this.runtimes.get(id);
    return runtime ? toPublicStatus(runtime) : null;
  }

  async shutdownAll(): Promise<void> {
    await Promise.all(
      [...this.runtimes.values()].map((runtime) =>
        this.detachRuntime(runtime).catch(() => undefined),
      ),
    );
  }

  async restoreFromConfig(workspacesRoot: string): Promise<void> {
    let entries: Dirent<string>[];
    try {
      entries = await readdir(workspacesRoot, { withFileTypes: true });
    } catch (error) {
      logger.app.warn("Failed to scan preview workspace root {root}: {error}", {
        root: workspacesRoot,
        error,
      });
      return;
    }

    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
        .map(async (entry) => {
          const projectPath = join(workspacesRoot, entry.name);
          try {
            const settings = await readDevServerSettings(projectPath);
            if (!settings.enabled && settings.pid === null) return;
            const runtime = await this.getRuntime(projectPath);
            if (await this.reconnectDetachedRuntime(runtime)) {
              logger.app.info(
                "Reconnected detached preview for {path} on port {port}",
                {
                  path: projectPath,
                  port: runtime.port,
                },
              );
            }
          } catch (error) {
            logger.app.warn("Failed to reconnect preview for {path}: {error}", {
              path: projectPath,
              error,
            });
          }
        }),
    );
  }

  private async getRuntime(projectPath: string): Promise<PreviewRuntime> {
    const id = previewIdForProject(projectPath);
    const existing = this.runtimes.get(id);
    if (existing) return existing;

    const runtime: PreviewRuntime = {
      id,
      projectPath,
      configuredCommand: await readConfiguredCommand(projectPath),
      resolvedCommand: null,
      devServer: await readDevServerSettings(projectPath),
      state: "idle",
      port: null,
      pid: null,
      pgid: null,
      process: null,
      error: null,
      logs: "",
      retryTimer: null,
      readyTimer: null,
      retryAt: null,
      startedAt: null,
      updatedAt: Date.now(),
      stopRequested: false,
      startAttempt: 0,
    };
    this.runtimes.set(id, runtime);
    return runtime;
  }

  private async startRuntime(runtime: PreviewRuntime): Promise<void> {
    this.clearTimers(runtime);
    runtime.stopRequested = false;
    runtime.state = "starting";
    runtime.error = null;
    runtime.retryAt = null;
    runtime.startedAt = Date.now();
    runtime.updatedAt = Date.now();
    runtime.startAttempt += 1;
    const attempt = runtime.startAttempt;
    let commandSpec: PreviewCommandSpec | null = null;

    try {
      runtime.configuredCommand = await readConfiguredCommand(
        runtime.projectPath,
      );
      runtime.devServer = await readDevServerSettings(runtime.projectPath);
      commandSpec =
        runtime.configuredCommand === DEFAULT_COMMAND
          ? await resolveAutoCommandSpec(runtime.projectPath)
          : parseConfiguredCommand(runtime.configuredCommand);
      runtime.resolvedCommand = commandSpec.display;
      if (previewCommandUsesPackageRunner(commandSpec.display)) {
        const runner = detectPackageRunner(runtime.projectPath);
        if (await shouldRunPackageInstall(runtime.projectPath)) {
          appendLog(
            runtime,
            `[swarmfleet-preview] missing dependencies detected; running ${runner} install\n`,
          );
          const installOutput = await runPackageInstall(runtime.projectPath, runner);
          appendLog(runtime, installOutput);
          appendLog(runtime, `\n[swarmfleet-preview] dependency install completed\n`);
        }
      }
      if (runtime.devServer.publishToHost) {
        runtime.devServer = await this.ensureHostPort(runtime);
        runtime.port = runtime.devServer.port;
      } else {
        runtime.port = await findAvailablePort(this.usedPorts(runtime.id));
      }
    } catch (error) {
      this.markError(runtime, error);
      this.scheduleRetry(runtime);
      return;
    }

    const previewHost = process.env.SWARMFLEET_PREVIEW_HOST ?? "0.0.0.0";
    const env = {
      ...process.env,
      PORT: String(runtime.port),
      HOST: previewHost,
      [ENV_PREVIEW_PORT]: String(runtime.port),
      [ENV_PREVIEW_ID]: runtime.id,
      [ENV_PREVIEW_PROJECT]: runtime.projectPath,
      SWARMFLEET_PREVIEW: "1",
    };

    if (!commandSpec) {
      this.markError(runtime, new Error("Preview command was not resolved"));
      this.scheduleRetry(runtime);
      return;
    }
    const commandArgs = commandSpec.args.map((arg) =>
      arg === "$SWARMFLEET_PREVIEW_PORT"
        ? String(runtime.port)
        : arg === "$HOST"
          ? previewHost
          : arg,
    );
    const child = spawn(commandSpec.file, commandArgs, {
      cwd: runtime.projectPath,
      env,
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["ignore", "ignore", "ignore"],
    });
    const pid = child.pid ?? null;
    runtime.process = child;
    runtime.pid = pid;
    runtime.pgid = process.platform !== "win32" ? pid : null;
    runtime.logs = "";
    appendLog(
      runtime,
      `[swarmfleet-preview] detached preview started${pid ? ` pid=${pid}` : ""}\n`,
    );
    runtime.devServer = await writeDevServerSettings(runtime.projectPath, {
      pid: runtime.pid,
      pgid: runtime.pgid,
      startedAt: runtime.startedAt,
      port: runtime.port,
      enabled: runtime.devServer.enabled,
      publishToHost: runtime.devServer.publishToHost,
    });

    child.once("error", (error) => {
      if (runtime.startAttempt !== attempt) return;
      this.markError(runtime, error);
      this.scheduleRetry(runtime);
    });
    child.once("exit", (code, signal) => {
      if (runtime.startAttempt !== attempt) return;
      runtime.process = null;
      runtime.pid = null;
      runtime.pgid = null;
      runtime.port = null;
      runtime.updatedAt = Date.now();
      if (runtime.stopRequested) {
        runtime.state = "stopped";
        return;
      }
      this.markError(
        runtime,
        new Error(
          `Preview command exited${code === null ? "" : ` with code ${code}`}${signal ? ` (${signal})` : ""}`,
        ),
      );
      void writeDevServerSettings(runtime.projectPath, {
        pid: null,
        pgid: null,
        startedAt: null,
      }).catch(() => undefined);
      this.scheduleRetry(runtime);
    });
    child.unref();

    this.waitUntilReady(runtime, attempt);
  }

  private waitUntilReady(runtime: PreviewRuntime, attempt: number): void {
    const startedAt = Date.now();
    const tick = async () => {
      if (runtime.startAttempt !== attempt || runtime.stopRequested) return;
      const port = runtime.port;
      if (!port) return;

      if (await isPortOpen(port)) {
        runtime.state = "running";
        runtime.error = null;
        runtime.updatedAt = Date.now();
        return;
      }

      if (!(await processExists(runtime.pid))) return;

      if (Date.now() - startedAt > READY_TIMEOUT_MS) {
        this.markError(
          runtime,
          new Error("Preview did not open its port in time"),
        );
        this.terminateRuntimeProcess(runtime);
        runtime.process = null;
        runtime.pid = null;
        runtime.pgid = null;
        runtime.port = null;
        void writeDevServerSettings(runtime.projectPath, {
          pid: null,
          pgid: null,
          startedAt: null,
        }).catch(() => undefined);
        this.scheduleRetry(runtime);
        return;
      }

      runtime.readyTimer = setTimeout(tick, READY_POLL_MS);
    };
    runtime.readyTimer = setTimeout(tick, READY_POLL_MS);
  }

  private scheduleRetry(runtime: PreviewRuntime): void {
    if (runtime.stopRequested || runtime.retryTimer) return;
    runtime.retryAt = Date.now() + RETRY_DELAY_MS;
    runtime.updatedAt = Date.now();
    runtime.retryTimer = setTimeout(() => {
      runtime.retryTimer = null;
      runtime.retryAt = null;
      void this.startRuntime(runtime).catch((error) => {
        logger.app.warn("Preview retry failed: {error}", { error });
      });
    }, RETRY_DELAY_MS);
  }

  private markError(runtime: PreviewRuntime, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    runtime.state = "error";
    runtime.error = message;
    runtime.updatedAt = Date.now();
    appendLog(runtime, `\n[swarmfleet-preview] ${message}\n`);
  }

  private async stopRuntime(
    runtime: PreviewRuntime,
    userRequested: boolean,
  ): Promise<void> {
    runtime.stopRequested = true;
    this.clearTimers(runtime);
    this.terminateRuntimeProcess(runtime);
    runtime.process = null;
    await this.terminateOrphanedPreviewProcesses(runtime);
    runtime.pid = null;
    runtime.pgid = null;
    runtime.port = null;
    runtime.retryAt = null;
    runtime.startedAt = null;
    runtime.devServer = await writeDevServerSettings(runtime.projectPath, {
      pid: null,
      pgid: null,
      startedAt: null,
    });
    runtime.state = userRequested ? "stopped" : "idle";
    runtime.updatedAt = Date.now();
  }

  private async detachRuntime(runtime: PreviewRuntime): Promise<void> {
    this.clearTimers(runtime);
    if (runtime.process) runtime.process.unref();
    runtime.process = null;
    runtime.updatedAt = Date.now();
  }

  private async reconnectDetachedRuntime(
    runtime: PreviewRuntime,
  ): Promise<boolean> {
    runtime.devServer = await readDevServerSettings(runtime.projectPath);
    const tagged = await findTaggedPreviewProcess(
      runtime.id,
      runtime.projectPath,
    );
    const pid = tagged?.pid ?? runtime.devServer.pid;
    const pgid = tagged?.pgid ?? runtime.devServer.pgid;
    const port = tagged?.port ?? runtime.devServer.port;
    if (
      pid !== null &&
      port !== null &&
      (await processExists(pid)) &&
      (await isPortOpen(port))
    ) {
      runtime.pid = pid;
      runtime.pgid = pgid;
      runtime.port = port;
      runtime.process = null;
      runtime.startedAt =
        runtime.devServer.startedAt ?? runtime.startedAt ?? Date.now();
      runtime.state = "running";
      runtime.error = null;
      runtime.retryAt = null;
      runtime.updatedAt = Date.now();
      runtime.devServer = await writeDevServerSettings(runtime.projectPath, {
        pid,
        pgid,
        port,
        startedAt: runtime.startedAt,
      });
      return true;
    }
    if (runtime.state === "running") {
      runtime.state = "idle";
      runtime.pid = null;
      runtime.pgid = null;
      runtime.port = null;
      runtime.startedAt = null;
      runtime.updatedAt = Date.now();
    }
    return false;
  }

  private terminateRuntimeProcess(runtime: PreviewRuntime): void {
    if (runtime.pgid !== null && process.platform !== "win32") {
      try {
        process.kill(-runtime.pgid, "SIGTERM");
        return;
      } catch {
        // Fall through to child/pid termination.
      }
    }
    if (runtime.process) {
      this.terminateProcess(runtime.process);
      return;
    }
    if (runtime.pid !== null) {
      try {
        process.kill(runtime.pid, "SIGTERM");
      } catch {
        // already gone
      }
    }
  }

  private async terminateOrphanedPreviewProcesses(
    runtime: PreviewRuntime,
  ): Promise<void> {
    if (process.platform === "win32") return;
    const output = await new Promise<string>((resolve) => {
      execFile("ps", ["-eo", "pid=,pgid=,command="], (error, stdout) => {
        if (error) resolve("");
        else resolve(stdout);
      });
    });

    const processGroups = new Set<number>();
    for (const line of output.split("\n")) {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
      if (!match) continue;
      const pid = Number.parseInt(match[1], 10);
      const pgid = Number.parseInt(match[2], 10);
      const command = match[3];
      if (!Number.isFinite(pid) || !Number.isFinite(pgid)) continue;
      if (pid === process.pid || pgid === process.pid) continue;
      if (!command.includes(runtime.projectPath)) continue;
      if (!/\b(vite|npm|pnpm|yarn|bun|node)\b/.test(command)) continue;
      processGroups.add(pgid);
    }

    for (const pgid of processGroups) {
      try {
        process.kill(-pgid, "SIGTERM");
        logger.app.info(
          "Stopped orphaned preview process group {pgid} for {path}",
          {
            pgid,
            path: runtime.projectPath,
          },
        );
      } catch {
        // already gone or not ours
      }
    }
  }

  private terminateProcess(child: ChildProcess): void {
    try {
      if (process.platform !== "win32" && child.pid) {
        process.kill(-child.pid, "SIGTERM");
      } else {
        child.kill("SIGTERM");
      }
    } catch {
      try {
        child.kill("SIGTERM");
      } catch {
        // already gone
      }
    }
  }

  private clearTimers(runtime: PreviewRuntime): void {
    if (runtime.retryTimer) clearTimeout(runtime.retryTimer);
    if (runtime.readyTimer) clearTimeout(runtime.readyTimer);
    runtime.retryTimer = null;
    runtime.readyTimer = null;
  }

  private usedPorts(exceptId: string): Set<number> {
    const used = new Set<number>();
    for (const [id, runtime] of this.runtimes) {
      if (id === exceptId) continue;
      if (runtime.port !== null) used.add(runtime.port);
    }
    return used;
  }

  private async setPublishToHost(
    projectPath: string,
    publishToHost: boolean,
  ): Promise<PreviewDevServerSettings> {
    const current = await readDevServerSettings(projectPath);
    if (!publishToHost) {
      return writeDevServerSettings(projectPath, { publishToHost: false });
    }
    return writeDevServerSettings(projectPath, {
      enabled: true,
      publishToHost: true,
      port: current.port,
    });
  }

  private async ensureHostPort(
    runtime: PreviewRuntime,
  ): Promise<PreviewDevServerSettings> {
    const allocate = async () => {
      const current = await readDevServerSettings(runtime.projectPath);
      if (current.port !== null) return current;
      const port = await findAvailableHostPort(
        await this.usedHostPorts(runtime.id, runtime.projectPath),
      );
      return writeDevServerSettings(runtime.projectPath, {
        enabled: true,
        publishToHost: true,
        port,
      });
    };
    const previous = this.hostPortAllocation;
    let release: () => void = () => undefined;
    this.hostPortAllocation = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await allocate();
    } finally {
      release();
    }
  }

  private async usedHostPorts(
    exceptId: string,
    exceptProjectPath: string,
  ): Promise<Set<number>> {
    const used = new Set<number>();
    for (const [id, runtime] of this.runtimes) {
      if (id === exceptId) continue;
      if (runtime.devServer.publishToHost && runtime.devServer.port !== null) {
        used.add(runtime.devServer.port);
      }
    }
    const workspaceRoot = process.env.WORKSPACES_ROOT ?? "/workspace";
    try {
      const entries = await readdir(workspaceRoot, { withFileTypes: true });
      await Promise.all(
        entries
          .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
          .map(async (entry) => {
            const projectPath = join(workspaceRoot, entry.name);
            if (projectPath === exceptProjectPath) return;
            try {
              const settings = await readDevServerSettings(projectPath);
              if (settings.publishToHost && settings.port !== null) {
                used.add(settings.port);
              }
            } catch {
              // Ignore projects with unreadable settings during allocation.
            }
          }),
      );
    } catch {
      // Runtime state still protects ports allocated during this process.
    }
    return used;
  }
}

export const previewService = new PreviewService();

