import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let configDir: string;

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), "swarmfleet-global-config-"));
  vi.stubEnv("SWARMFLEET_CONFIG_DIR", configDir);
  vi.stubEnv("SWARMFLEET_TAILSCALE_HOST", "");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(configDir, { recursive: true, force: true });
});

describe("global config", () => {
  it("reads the config directory from the environment on every call", async () => {
    const { getConfigDir } = await import("../services/globalConfig.ts");
    expect(getConfigDir()).toBe(configDir);

    const nextDir = await mkdtemp(
      join(tmpdir(), "swarmfleet-global-config-next-"),
    );
    vi.stubEnv("SWARMFLEET_CONFIG_DIR", nextDir);
    expect(getConfigDir()).toBe(nextDir);
    await rm(nextDir, { recursive: true, force: true });
  });

  it("writes default server config when server.json is missing", async () => {
    const { getServerConfig } = await import("../services/globalConfig.ts");

    const config = await getServerConfig();
    const raw = JSON.parse(
      await readFile(join(configDir, "server.json"), "utf-8"),
    ) as unknown;

    expect(config).toMatchObject({
      hostname: "localhost",
      containerHttpsPort: 443,
      publicPort: 7070,
      rp: { id: "localhost", name: "Swarmfleet" },
      session: { maxAgeDays: 30, renewOnUseAfterDays: 1 },
      credential: { maxAgeDays: 30 },
      enrollmentToken: { maxAgeHours: 5 / 60 },
    });
    expect(config.publicOrigin).toBe("https://localhost:7070");
    expect(config.origins).toEqual([
      {
        hostname: "localhost",
        rpId: "localhost",
        origin: "https://localhost:7070",
      },
    ]);
    expect(raw).toEqual({
      hostname: config.hostname,
      containerHttpsPort: config.containerHttpsPort,
      publicPort: config.publicPort,
      rp: config.rp,
      session: config.session,
      credential: config.credential,
      enrollmentToken: config.enrollmentToken,
      additionalOrigins: [],
    });
  });

  it("uses SWARMFLEET_PUBLIC_PORT even when server.json has an old port", async () => {
    vi.stubEnv("SWARMFLEET_PUBLIC_PORT", "7071");
    await writeFile(
      join(configDir, "server.json"),
      `${JSON.stringify({
        hostname: "localhost",
        containerHttpsPort: 443,
        publicPort: 7070,
        rp: { id: "localhost", name: "Swarmfleet" },
        session: { maxAgeDays: 30, renewOnUseAfterDays: 1 },
        credential: { maxAgeDays: 30 },
        enrollmentToken: { maxAgeHours: 5 / 60 },
        additionalOrigins: [],
      })}\n`,
    );

    const { getServerConfig } = await import("../services/globalConfig.ts");
    const config = await getServerConfig();
    const raw = JSON.parse(
      await readFile(join(configDir, "server.json"), "utf-8"),
    ) as { publicPort?: number };

    expect(config.publicPort).toBe(7071);
    expect(config.publicOrigin).toBe("https://localhost:7071");
    expect(config.origins[0]?.origin).toBe("https://localhost:7071");
    expect(raw.publicPort).toBe(7071);
  });

  it("migrates the old 24h default enrollment token ttl to 5 minutes", async () => {
    await writeFile(
      join(configDir, "server.json"),
      `${JSON.stringify({
        hostname: "localhost",
        containerHttpsPort: 443,
        publicPort: 7070,
        rp: { id: "localhost", name: "Swarmfleet" },
        session: { maxAgeDays: 30, renewOnUseAfterDays: 1 },
        credential: { maxAgeDays: 30 },
        enrollmentToken: { maxAgeHours: 24 },
        additionalOrigins: [],
      })}\n`,
    );

    const { getServerConfig } = await import("../services/globalConfig.ts");
    const config = await getServerConfig();
    const raw = JSON.parse(
      await readFile(join(configDir, "server.json"), "utf-8"),
    ) as { enrollmentToken?: { maxAgeHours?: number } };

    expect(config.enrollmentToken.maxAgeHours).toBe(5 / 60);
    expect(raw.enrollmentToken?.maxAgeHours).toBe(5 / 60);
  });

  it("adds the Tailscale origin from the environment", async () => {
    vi.stubEnv("SWARMFLEET_TAILSCALE_HOST", "machine.tailnet.ts.net");

    const { getServerConfig, originForHost } =
      await import("../services/globalConfig.ts");

    const config = await getServerConfig();

    expect(config.origins).toEqual([
      {
        hostname: "localhost",
        rpId: "localhost",
        origin: "https://localhost:7070",
      },
      {
        hostname: "machine.tailnet.ts.net",
        rpId: "machine.tailnet.ts.net",
        origin: "https://machine.tailnet.ts.net:7070",
      },
    ]);
    expect(originForHost("machine.tailnet.ts.net:7070", config)).toEqual(
      config.origins[1],
    );
  });

  it("creates auth state with a generated signing key", async () => {
    const { readAuthState } = await import("../services/globalConfig.ts");

    const state = await readAuthState();
    const raw = JSON.parse(
      await readFile(join(configDir, "auth.json"), "utf-8"),
    ) as typeof state;

    expect(Buffer.from(state.sessionSigningKey, "base64")).toHaveLength(32);
    expect(state.credentials).toEqual([]);
    expect(state.sessions).toEqual([]);
    expect(state.enrollmentTokens).toEqual([]);
    expect(raw).toEqual(state);
  });

  it("migrates legacy auth-state.json credentials into auth.json", async () => {
    await writeFile(
      join(configDir, "auth-state.json"),
      `${JSON.stringify({
        version: 1,
        sessionSigningKey: Buffer.alloc(32, 1).toString("base64"),
        credentials: [
          {
            id: "legacy-cred",
            rpId: "localhost",
            publicKey: "public-key",
            counter: 0,
            transports: ["internal"],
            label: "Legacy laptop",
            createdAt: "2026-01-01T00:00:00.000Z",
            expiresAt: null,
            lastUsedAt: null,
          },
        ],
        sessions: [],
        enrollmentTokens: [
          {
            token: "legacy-token",
            createdByCredentialId: "bootstrap",
            createdAt: "2026-01-01T00:00:00.000Z",
            expiresAt: "2999-01-01T00:00:00.000Z",
          },
        ],
      })}\n`,
    );

    const { readAuthState } = await import("../services/globalConfig.ts");
    const state = await readAuthState();
    const raw = JSON.parse(
      await readFile(join(configDir, "auth.json"), "utf-8"),
    ) as typeof state;

    expect(state.credentials.map((credential) => credential.id)).toEqual([
      "legacy-cred",
    ]);
    expect(state.credentials[0]?.expiresAt).toBeNull();
    expect(state.enrollmentTokens[0]?.issuedBy).toBe("bootstrap");
    expect(raw).toEqual(state);
  });

  it("recovers legacy credentials when a valid auth.json is empty", async () => {
    await writeFile(
      join(configDir, "auth.json"),
      `${JSON.stringify({
        sessionSigningKey: Buffer.alloc(32, 2).toString("base64"),
        credentials: [],
        sessions: [],
        enrollmentTokens: [],
      })}\n`,
    );
    await writeFile(
      join(configDir, "auth-state.json"),
      `${JSON.stringify({
        version: 1,
        sessionSigningKey: Buffer.alloc(32, 3).toString("base64"),
        credentials: [
          {
            id: "legacy-cred",
            rpId: "localhost",
            publicKey: "public-key",
            counter: 0,
            transports: ["internal"],
            label: "Legacy laptop",
            createdAt: "2026-01-01T00:00:00.000Z",
            expiresAt: null,
            lastUsedAt: null,
          },
        ],
        sessions: [],
        enrollmentTokens: [],
      })}\n`,
    );

    const { readAuthState } = await import("../services/globalConfig.ts");
    const state = await readAuthState();

    expect(state.sessionSigningKey).toBe(
      Buffer.alloc(32, 3).toString("base64"),
    );
    expect(state.credentials.map((credential) => credential.id)).toEqual([
      "legacy-cred",
    ]);
  });

  it("serializes auth state mutations and leaves no temp file after success", async () => {
    const { mutateAuthState, readAuthState } =
      await import("../services/globalConfig.ts");

    await mutateAuthState((state) => ({
      ...state,
      credentials: [
        ...state.credentials,
        {
          id: "cred-1",
          rpId: "localhost",
          publicKey: "public-key",
          counter: 0,
          transports: ["internal"],
          label: "Laptop",
          createdAt: "2026-01-01T00:00:00.000Z",
          expiresAt: "2026-02-01T00:00:00.000Z",
          lastUsedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    }));

    expect((await readAuthState()).credentials).toHaveLength(1);
    expect(
      (await readdir(configDir)).filter((name) => name.endsWith(".tmp")),
    ).toEqual([]);
  });
});
