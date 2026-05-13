import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let configDir: string;

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), "swarmfleet-auth-store-"));
  vi.stubEnv("SWARMFLEET_CONFIG_DIR", configDir);
  vi.useRealTimers();
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await rm(configDir, { recursive: true, force: true });
});

describe("auth store", () => {
  it("round-trips credentials, sessions, and enrollment tokens", async () => {
    const {
      addCredential,
      createSession,
      findCredentialById,
      findSession,
      listCredentials,
      mintEnrollmentToken,
      removeCredential,
      revokeSession,
    } = await import("../services/authStore.ts");

    const credential = await addCredential({
      id: "cred-1",
      rpId: "localhost",
      publicKey: "public-key",
      counter: 1,
      transports: ["internal"],
      label: "Laptop",
    });
    expect(await findCredentialById("cred-1")).toEqual(credential);
    expect(await listCredentials()).toEqual([credential]);

    const session = await createSession("cred-1");
    expect(session.token).toMatch(/^[0-9a-f]{64}$/);
    expect(await findSession(session.token)).toEqual(session);

    const enrollmentToken = await mintEnrollmentToken("cred-1");
    expect(enrollmentToken.token).toMatch(/^[0-9a-f]{32}$/);
    expect(enrollmentToken.issuedBy).toBe("cred-1");
    expect(
      Date.parse(enrollmentToken.expiresAt) -
        Date.parse(enrollmentToken.createdAt),
    ).toBe(5 * 60 * 1000);

    await revokeSession(session.token);
    expect(await findSession(session.token)).toBeNull();

    await removeCredential("cred-1");
    expect(await findCredentialById("cred-1")).toBeNull();
  });

  it("filters expired credentials from listCredentials", async () => {
    const { listCredentials } = await import("../services/authStore.ts");
    const { mutateAuthState } = await import("../services/globalConfig.ts");

    await mutateAuthState((state) => ({
      ...state,
      credentials: [
        {
          id: "expired",
          rpId: "localhost",
          publicKey: "public-key",
          counter: 0,
          transports: [],
          label: "Expired",
          createdAt: "2026-01-01T00:00:00.000Z",
          expiresAt: "2026-01-02T00:00:00.000Z",
          lastUsedAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "non-expiring",
          rpId: "localhost",
          publicKey: "public-key",
          counter: 0,
          transports: [],
          label: "Non-expiring",
          createdAt: "2026-01-01T00:00:00.000Z",
          expiresAt: null,
          lastUsedAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "valid",
          rpId: "localhost",
          publicKey: "public-key",
          counter: 0,
          transports: [],
          label: "Valid",
          createdAt: "2026-01-01T00:00:00.000Z",
          expiresAt: "2999-01-02T00:00:00.000Z",
          lastUsedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    }));

    expect(
      (await listCredentials()).map((credential) => credential.id),
    ).toEqual(["non-expiring", "valid"]);
  });

  it("consumes enrollment tokens once", async () => {
    const { consumeEnrollmentToken, mintEnrollmentToken } =
      await import("../services/authStore.ts");

    const token = await mintEnrollmentToken("cred-1");
    expect(await consumeEnrollmentToken(token.token)).toEqual(token);
    expect(await consumeEnrollmentToken(token.token)).toBeNull();
  });

  it("slides session expiry only after the renewal threshold", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    const { createSession, findSession, touchSession } =
      await import("../services/authStore.ts");
    const session = await createSession("cred-1");

    vi.setSystemTime(new Date("2026-01-01T12:00:00.000Z"));
    await touchSession(session.token);
    expect(await findSession(session.token)).toEqual(session);

    vi.setSystemTime(new Date("2026-01-02T00:00:01.000Z"));
    await touchSession(session.token);
    const touched = await findSession(session.token);

    expect(touched?.lastUsedAt).toBe("2026-01-02T00:00:01.000Z");
    expect(touched?.expiresAt).toBe("2026-02-01T00:00:01.000Z");
  });
});
