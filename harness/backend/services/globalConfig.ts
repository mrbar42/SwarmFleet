import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { AuthState } from "./authStore.ts";

export type { AuthState } from "./authStore.ts";

const AUTH_STATE_FILE = "auth.json";
const AUTH_STATE_BACKUP_FILE = "auth.json.bak";
const LEGACY_AUTH_STATE_FILES = ["auth-state.json", "auth-state.json.bak"];
const AUTH_STATE_READ_RETRIES = 8;
const AUTH_STATE_READ_RETRY_DELAY_MS = 25;

export interface Origin {
  hostname: string;
  rpId: string;
  origin: string;
}

export interface ServerConfig {
  hostname: string;
  containerHttpsPort: number;
  publicPort: number;
  rp: { id: string; name: string };
  session: { maxAgeDays: number; renewOnUseAfterDays: number };
  credential: { maxAgeDays: number };
  enrollmentToken: { maxAgeHours: number };
  publicOrigin: string;
  enrollment: { tokenTtlHours: number };
  additionalOrigins: Origin[];
  origins: Origin[];
}

const DEFAULT_SERVER_CONFIG: ServerConfig = {
  hostname: "localhost",
  containerHttpsPort: 443,
  publicPort: 7070,
  rp: { id: "localhost", name: "Swarmfleet" },
  session: { maxAgeDays: 30, renewOnUseAfterDays: 1 },
  credential: { maxAgeDays: 30 },
  enrollmentToken: { maxAgeHours: 5 / 60 },
  publicOrigin: "https://localhost:7070",
  enrollment: { tokenTtlHours: 5 / 60 },
  additionalOrigins: [],
  origins: [
    {
      hostname: "localhost",
      rpId: "localhost",
      origin: "https://localhost:7070",
    },
  ],
};

let authStateWriteQueue: Promise<void> = Promise.resolve();

export function getConfigDir(): string {
  return process.env.SWARMFLEET_CONFIG_DIR ?? "/config";
}

function serverConfigPath(): string {
  return join(getConfigDir(), "server.json");
}

function authStatePath(): string {
  return join(getConfigDir(), AUTH_STATE_FILE);
}

function authStateBackupPath(): string {
  return join(getConfigDir(), AUTH_STATE_BACKUP_FILE);
}

function legacyAuthStatePaths(): string[] {
  return LEGACY_AUTH_STATE_FILES.map((file) => join(getConfigDir(), file));
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

function nonEmptyString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .map((item) => (typeof item === "string" ? item.trim() : ""))
        .filter(Boolean),
    ),
  );
}

function enrollmentMaxAgeHours(input: {
  enrollmentTokenMaxAgeHours?: unknown;
  enrollmentTokenTtlHours?: unknown;
}): number {
  const fallback = DEFAULT_SERVER_CONFIG.enrollmentToken.maxAgeHours;
  const value = positiveNumber(
    input.enrollmentTokenMaxAgeHours,
    positiveNumber(input.enrollmentTokenTtlHours, fallback),
  );

  // server.json persisted the old default as 24. Migrate that default to the
  // shorter first-device enrollment window instead of keeping old dev installs
  // on a day-long bootstrap URL.
  return value === 24 ? fallback : value;
}

function publicOrigin(hostname: string, port: number): string {
  return port === 443 ? `https://${hostname}` : `https://${hostname}:${port}`;
}

function normalizeOrigin(value: unknown): Origin | null {
  if (!isRecord(value)) return null;
  const hostname = nullableString(value.hostname);
  const rpId = nullableString(value.rpId);
  const origin = nullableString(value.origin);
  if (!hostname || !rpId || !origin) return null;
  return { hostname, rpId, origin };
}

function originList(value: unknown): Origin[] {
  if (!Array.isArray(value)) return [];
  const origins = value
    .map((item) => normalizeOrigin(item))
    .filter((origin): origin is Origin => Boolean(origin));
  return dedupeOrigins(origins);
}

function dedupeOrigins(origins: Origin[]): Origin[] {
  const seen = new Set<string>();
  const result: Origin[] = [];
  for (const origin of origins) {
    if (seen.has(origin.origin)) continue;
    seen.add(origin.origin);
    result.push(origin);
  }
  return result;
}

function envPublicPort(): number | null {
  const parsed = Number.parseInt(process.env.SWARMFLEET_PUBLIC_PORT ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function defaultPublicPort(): number {
  return envPublicPort() ?? DEFAULT_SERVER_CONFIG.publicPort;
}

function normalizeServerConfig(value: unknown): ServerConfig {
  const input = isRecord(value) ? value : {};
  const inputRp = isRecord(input.rp) ? input.rp : {};
  const inputSession = isRecord(input.session) ? input.session : {};
  const inputCredential = isRecord(input.credential) ? input.credential : {};
  const inputEnrollmentToken = isRecord(input.enrollmentToken)
    ? input.enrollmentToken
    : {};
  const inputEnrollment = isRecord(input.enrollment) ? input.enrollment : {};

  const configuredHostname = nonEmptyString(
    input.hostname,
    DEFAULT_SERVER_CONFIG.hostname,
  );
  const hostname = configuredHostname;
  const containerHttpsPort = positiveNumber(
    input.containerHttpsPort,
    DEFAULT_SERVER_CONFIG.containerHttpsPort,
  );
  const publicPort =
    envPublicPort() ?? positiveNumber(input.publicPort, defaultPublicPort());
  const configuredRpId = nonEmptyString(inputRp.id, hostname);
  const rpId = configuredRpId;
  const resolvedPublicOrigin = publicOrigin(hostname, publicPort);
  const additionalOrigins = originList(input.additionalOrigins);
  const tailscaleHost = process.env.SWARMFLEET_TAILSCALE_HOST?.trim();
  const origins = dedupeOrigins([
    { hostname, rpId, origin: resolvedPublicOrigin },
    ...(tailscaleHost
      ? [
          {
            hostname: tailscaleHost,
            rpId: tailscaleHost,
            origin: publicOrigin(tailscaleHost, publicPort),
          },
        ]
      : []),
    ...additionalOrigins,
  ]);
  const resolvedEnrollmentMaxAgeHours = enrollmentMaxAgeHours({
    enrollmentTokenMaxAgeHours: inputEnrollmentToken.maxAgeHours,
    enrollmentTokenTtlHours: inputEnrollment.tokenTtlHours,
  });

  return {
    hostname,
    containerHttpsPort,
    publicPort,
    rp: {
      id: rpId,
      name: nonEmptyString(inputRp.name, DEFAULT_SERVER_CONFIG.rp.name),
    },
    session: {
      maxAgeDays: positiveNumber(
        inputSession.maxAgeDays,
        DEFAULT_SERVER_CONFIG.session.maxAgeDays,
      ),
      renewOnUseAfterDays: positiveNumber(
        inputSession.renewOnUseAfterDays,
        DEFAULT_SERVER_CONFIG.session.renewOnUseAfterDays,
      ),
    },
    credential: {
      maxAgeDays: positiveNumber(
        inputCredential.maxAgeDays,
        DEFAULT_SERVER_CONFIG.credential.maxAgeDays,
      ),
    },
    enrollmentToken: {
      maxAgeHours: resolvedEnrollmentMaxAgeHours,
    },
    publicOrigin: resolvedPublicOrigin,
    enrollment: {
      tokenTtlHours: resolvedEnrollmentMaxAgeHours,
    },
    additionalOrigins,
    origins,
  };
}

function persistedServerConfig(
  config: ServerConfig,
): Omit<ServerConfig, "publicOrigin" | "enrollment" | "origins"> {
  return {
    hostname: config.hostname,
    containerHttpsPort: config.containerHttpsPort,
    publicPort: config.publicPort,
    rp: config.rp,
    session: config.session,
    credential: config.credential,
    enrollmentToken: config.enrollmentToken,
    additionalOrigins: config.additionalOrigins,
  };
}

function hostWithoutPort(hostHeader: string): string {
  const trimmed = hostHeader.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    return end === -1 ? trimmed : trimmed.slice(1, end);
  }
  return trimmed.split(":")[0] ?? "";
}

export function originForHost(
  hostHeader: string | null | undefined,
  cfg: ServerConfig,
): Origin | null {
  const hostname = hostWithoutPort(hostHeader ?? "").toLowerCase();
  if (!hostname) return null;
  return (
    cfg.origins.find((origin) => origin.hostname.toLowerCase() === hostname) ??
    null
  );
}

function emptyAuthState(): AuthState {
  return {
    sessionSigningKey: randomBytes(32).toString("base64"),
    credentials: [],
    sessions: [],
    enrollmentTokens: [],
  };
}

function normalizeCredential(
  value: unknown,
): AuthState["credentials"][number] | null {
  if (!isRecord(value)) return null;
  const id = nullableString(value.id);
  const publicKey = nullableString(value.publicKey);
  if (!id || !publicKey) return null;

  return {
    id,
    rpId: nonEmptyString(value.rpId, DEFAULT_SERVER_CONFIG.rp.id),
    publicKey,
    counter:
      typeof value.counter === "number" && Number.isFinite(value.counter)
        ? value.counter
        : 0,
    transports: stringArray(value.transports),
    label: nonEmptyString(value.label, "Unnamed device"),
    createdAt: nonEmptyString(value.createdAt, new Date().toISOString()),
    expiresAt: nullableString(value.expiresAt),
    lastUsedAt: nullableString(value.lastUsedAt),
  };
}

function normalizeSession(
  value: unknown,
): AuthState["sessions"][number] | null {
  if (!isRecord(value)) return null;
  const token = nullableString(value.token);
  const credentialId = nullableString(value.credentialId);
  const expiresAt = nullableString(value.expiresAt);
  if (!token || !credentialId || !expiresAt) return null;

  return {
    token,
    credentialId,
    createdAt: nonEmptyString(value.createdAt, new Date().toISOString()),
    lastUsedAt: nonEmptyString(value.lastUsedAt, new Date().toISOString()),
    expiresAt,
  };
}

function normalizeEnrollmentToken(
  value: unknown,
): AuthState["enrollmentTokens"][number] | null {
  if (!isRecord(value)) return null;
  const token = nullableString(value.token);
  const expiresAt = nullableString(value.expiresAt);
  if (!token || !expiresAt) return null;

  return {
    token,
    createdAt: nonEmptyString(value.createdAt, new Date().toISOString()),
    expiresAt,
    issuedBy: nonEmptyString(
      value.issuedBy,
      nonEmptyString(value.createdByCredentialId, "unknown"),
    ),
  };
}

function normalizeAuthState(value: unknown): AuthState {
  if (!isRecord(value)) return emptyAuthState();

  return {
    sessionSigningKey: nonEmptyString(
      value.sessionSigningKey,
      randomBytes(32).toString("base64"),
    ),
    credentials: Array.isArray(value.credentials)
      ? value.credentials
          .map((credential) => normalizeCredential(credential))
          .filter(
            (credential): credential is AuthState["credentials"][number] =>
              Boolean(credential),
          )
      : [],
    sessions: Array.isArray(value.sessions)
      ? value.sessions
          .map((session) => normalizeSession(session))
          .filter((session): session is AuthState["sessions"][number] =>
            Boolean(session),
          )
      : [],
    enrollmentTokens: Array.isArray(value.enrollmentTokens)
      ? value.enrollmentTokens
          .map((token) => normalizeEnrollmentToken(token))
          .filter((token): token is AuthState["enrollmentTokens"][number] =>
            Boolean(token),
          )
      : [],
  };
}

function hasCredentials(state: AuthState): boolean {
  return state.credentials.length > 0;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function fsyncPath(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  const handle = await open(tmp, "w", 0o600);
  try {
    await handle.writeFile(payload, "utf-8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmp, path);
  await fsyncPath(dirname(path)).catch(() => undefined);
}

async function readJsonFile(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf-8")) as unknown;
}

function isRetryableAuthStateReadError(error: unknown): boolean {
  return (
    (error as NodeJS.ErrnoException).code === "ENOENT" ||
    error instanceof SyntaxError
  );
}

async function readAuthStateFile(path: string): Promise<AuthState> {
  return normalizeAuthState(await readJsonFile(path));
}

async function findRecoverableAuthState(
  paths: string[],
): Promise<AuthState | null> {
  for (const path of paths) {
    try {
      const state = await readAuthStateFile(path);
      if (hasCredentials(state)) return state;
    } catch {
      // Recovery candidates are best-effort. Keep trying the next one.
    }
  }
  return null;
}

async function readPrimaryAuthStateWithRetries(
  path: string,
): Promise<AuthState> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= AUTH_STATE_READ_RETRIES; attempt += 1) {
    try {
      return await readAuthStateFile(path);
    } catch (error) {
      lastError = error;
      if (
        !isRetryableAuthStateReadError(error) ||
        attempt === AUTH_STATE_READ_RETRIES
      ) {
        break;
      }
      await delay(AUTH_STATE_READ_RETRY_DELAY_MS);
    }
  }
  throw lastError;
}

export async function getServerConfig(): Promise<ServerConfig> {
  const path = serverConfigPath();
  await mkdir(dirname(path), { recursive: true });

  const raw = (await exists(path)) ? await readJsonFile(path) : {};
  const config = normalizeServerConfig(raw);
  const persisted = persistedServerConfig(config);
  if (JSON.stringify(raw) !== JSON.stringify(persisted)) {
    await writeJsonAtomic(path, persisted);
  }
  return clone(config);
}

export async function readAuthState(): Promise<AuthState> {
  await authStateWriteQueue;
  return readAuthStateUnlocked();
}

async function readAuthStateUnlocked(): Promise<AuthState> {
  const path = authStatePath();
  await mkdir(dirname(path), { recursive: true });

  try {
    const primary = await readPrimaryAuthStateWithRetries(path);
    if (!hasCredentials(primary)) {
      const legacy = await findRecoverableAuthState(legacyAuthStatePaths());
      if (legacy) {
        await writeAuthStateUnlocked(legacy);
        return clone(legacy);
      }
    }
    return clone(primary);
  } catch (error) {
    if (!isRetryableAuthStateReadError(error)) throw error;
  }

  const recovered = await findRecoverableAuthState([
    authStateBackupPath(),
    ...legacyAuthStatePaths(),
  ]);
  if (recovered) {
    await writeAuthStateUnlocked(recovered);
    return clone(recovered);
  }

  if (!(await exists(path))) {
    const state = emptyAuthState();
    await writeAuthStateUnlocked(state);
    return clone(state);
  }

  return clone(await readAuthStateFile(path));
}

export async function mutateAuthState(
  fn: (state: AuthState) => AuthState | Promise<AuthState>,
): Promise<AuthState> {
  const run = authStateWriteQueue.then(async () => {
    const current = await readAuthStateUnlocked();
    const next = await fn(clone(current));
    const normalized = normalizeAuthState(next);
    await writeAuthStateUnlocked(normalized);
    return clone(normalized);
  });

  authStateWriteQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export async function writeAuthState(state: AuthState): Promise<void> {
  const run = authStateWriteQueue.then(() => writeAuthStateUnlocked(state));
  authStateWriteQueue = run.then(
    () => undefined,
    () => undefined,
  );
  await run;
}

async function writeAuthStateUnlocked(state: AuthState): Promise<void> {
  const normalized = normalizeAuthState(state);
  const path = authStatePath();
  await writeJsonAtomic(path, normalized);
  if (hasCredentials(normalized)) {
    await writeJsonAtomic(authStateBackupPath(), normalized).catch(
      () => undefined,
    );
  }

  await unlink(`${path}.tmp`).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}
