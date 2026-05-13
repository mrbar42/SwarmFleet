import { createHmac, randomBytes } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import {
  BACKEND_PORT,
  BASE_URL,
  CONFIG_DIR,
  FRONTEND_PORT,
  RUNTIME_DIR,
  STORAGE_STATE_PATH,
  WORKSPACE_ROOT,
  cleanupChatSessionStore,
  clearRuntimeState,
  ensureRuntimeDir,
  prepareWorkspaceRoot,
  writeServerState,
} from "../helpers/projects";
import { detectProviderState, writeProviderState } from "../helpers/providers";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..", "..");

function signSessionToken(token: string, key: Buffer): string {
  const signature = createHmac("sha256", key).update(token).digest("base64url");
  return `${token}.${signature}`;
}

async function seedAuthState(): Promise<string> {
  await mkdir(CONFIG_DIR, { recursive: true });

  const now = new Date();
  const expires = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const signingKey = randomBytes(32);
  const token = randomBytes(32).toString("hex");
  const signedToken = signSessionToken(token, signingKey);
  const credentialId = "e2e-credential";
  const base = new URL(BASE_URL);

  await writeFile(
    join(CONFIG_DIR, "server.json"),
    JSON.stringify(
      {
        hostname: base.hostname,
        publicPort: Number(base.port || "80"),
        publicOrigin: BASE_URL,
        rp: { id: base.hostname, name: "SwarmFleet E2E" },
        additionalOrigins: [
          {
            hostname: base.hostname,
            rpId: base.hostname,
            origin: BASE_URL,
          },
        ],
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  await writeFile(
    join(CONFIG_DIR, "auth.json"),
    JSON.stringify(
      {
        version: 1,
        sessionSigningKey: signingKey.toString("base64"),
        credentials: [
          {
            id: credentialId,
            rpId: base.hostname,
            publicKey: "e2e-public-key",
            counter: 0,
            transports: [],
            label: "E2E",
            createdAt: now.toISOString(),
            expiresAt: expires.toISOString(),
            lastUsedAt: now.toISOString(),
          },
        ],
        sessions: [
          {
            token,
            credentialId,
            createdAt: now.toISOString(),
            lastUsedAt: now.toISOString(),
            expiresAt: expires.toISOString(),
          },
        ],
        enrollmentTokens: [],
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  await writeFile(
    STORAGE_STATE_PATH,
    JSON.stringify(
      {
        cookies: [
          {
            name: "swarmfleet_session",
            value: signedToken,
            domain: base.hostname,
            path: "/",
            expires: Math.floor(expires.getTime() / 1000),
            httpOnly: false,
            secure: base.protocol === "https:",
            sameSite: "Lax",
          },
        ],
        origins: [],
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  return `swarmfleet_session=${encodeURIComponent(signedToken)}`;
}

async function createFakeClaudeCli(): Promise<string> {
  const fakeClaudePath = join(RUNTIME_DIR, "fake-claude");
  await writeFile(
    fakeClaudePath,
    [
      "#!/usr/bin/env bash",
      'if [ "$1" = "--version" ]; then',
      '  echo "Claude Code 0.0.0-e2e"',
      "  exit 0",
      "fi",
      'echo "E2E fake Claude CLI: no real provider is configured" >&2',
      "exit 1",
      "",
    ].join("\n"),
    "utf8",
  );
  await chmod(fakeClaudePath, 0o755);
  return fakeClaudePath;
}

async function waitForServerReady(cookieHeader: string): Promise<void> {
  const deadline = Date.now() + 30_000;

  while (Date.now() < deadline) {
    try {
      const [frontendResponse, apiResponse] = await Promise.all([
        fetch(BASE_URL),
        fetch(`${BASE_URL}/api/projects`, {
          headers: { cookie: cookieHeader },
        }),
      ]);
      if (
        frontendResponse.ok &&
        apiResponse.ok &&
        apiResponse.headers.get("content-type")?.includes("application/json")
      ) {
        return;
      }
    } catch {
      // Retry until timeout.
    }
    await delay(500);
  }

  throw new Error(`Backend did not become ready at ${BASE_URL} before timeout`);
}

export default async function globalSetup(): Promise<void> {
  await clearRuntimeState();
  await ensureRuntimeDir();
  const fakeClaudePath = await createFakeClaudeCli();
  await cleanupChatSessionStore();
  await prepareWorkspaceRoot();
  const authCookie = await seedAuthState();

  const providerState = await detectProviderState();
  await writeProviderState(providerState);

  const backendLog = createWriteStream(join(RUNTIME_DIR, "backend.log"), {
    flags: "a",
  });
  const frontendLog = createWriteStream(join(RUNTIME_DIR, "frontend.log"), {
    flags: "a",
  });

  const backend = spawn(
    "npx",
    [
      "tsx",
      "cli/node.ts",
      "--port",
      String(BACKEND_PORT),
      "--workspaces-root",
      WORKSPACE_ROOT,
      "--claude-path",
      fakeClaudePath,
    ],
    {
      cwd: join(repoRoot, "harness", "backend"),
      env: {
        ...process.env,
        SWARMFLEET_CONFIG_DIR: CONFIG_DIR,
        WORKSPACES_ROOT: WORKSPACE_ROOT,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  backend.stdout.pipe(backendLog);
  backend.stderr.pipe(backendLog);

  backend.once("exit", (code, signal) => {
    backendLog.write(
      `\n[backend-exit] code=${code ?? "null"} signal=${signal ?? "null"}\n`,
    );
  });

  const frontend = spawn(
    "npm",
    ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(FRONTEND_PORT)],
    {
      cwd: join(repoRoot, "harness", "frontend"),
      env: {
        ...process.env,
        // vite.config.ts reads API_PORT / SWARMFLEET_PORT (not PORT) to wire its
        // /api proxy. Set both so the e2e frontend talks to the e2e backend
        // instead of falling back to the default 7080 (which on dev machines
        // happens to be the long-running docker backend, contaminating tests).
        API_PORT: String(BACKEND_PORT),
        SWARMFLEET_PORT: String(BACKEND_PORT),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  frontend.stdout.pipe(frontendLog);
  frontend.stderr.pipe(frontendLog);

  frontend.once("exit", (code, signal) => {
    frontendLog.write(
      `\n[frontend-exit] code=${code ?? "null"} signal=${signal ?? "null"}\n`,
    );
  });

  await waitForServerReady(authCookie);
  await writeServerState({
    backendPid: backend.pid ?? -1,
    frontendPid: frontend.pid ?? -1,
    backendPort: BACKEND_PORT,
    frontendPort: FRONTEND_PORT,
    baseURL: BASE_URL,
    workspaceRoot: WORKSPACE_ROOT,
    startedAt: new Date().toISOString(),
  });
}
