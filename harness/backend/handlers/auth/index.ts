import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import type { Context } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import {
  addCredential,
  consumeEnrollmentToken,
  createSession,
  findCredentialById,
  listCredentials,
  mintEnrollmentToken,
  removeCredential,
  revokeSession,
  resolveSessionFromCookieHeader,
  updateCredentialAfterUse,
} from "../../services/authStore.ts";
import {
  type Origin,
  type ServerConfig,
  getServerConfig,
  originForHost,
  readAuthState,
} from "../../services/globalConfig.ts";
import {
  getSessionCookieName,
  signSessionToken,
} from "../../lib/sessionCookie.ts";
import { requireAuth } from "../../middleware/requireAuth.ts";

type ChallengeEntry = { challenge: string; expiresAt: number };
type StoredCredential = {
  id: string;
  rpId: string;
  publicKey: string;
  counter: number;
  transports: string[];
  label: string;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
};
type EnrollmentTokenRecord = {
  token: string;
  expiresAt: string;
};
type AuthenticatorResponse = {
  id: string;
  response: {
    transports?: string[];
  };
};

const challenges = new Map<string, ChallengeEntry>();
const authRoutes = new Hono();

type RateLimitEntry = { windowStartedAt: number; count: number };
const authRateLimits = new Map<string, RateLimitEntry>();
const AUTH_RATE_LIMIT_WINDOW_MS = Number.parseInt(
  process.env.SWARMFLEET_AUTH_RATE_LIMIT_WINDOW_MS ?? "60000",
  10,
);
const AUTH_RATE_LIMIT_MAX = Number.parseInt(
  process.env.SWARMFLEET_AUTH_RATE_LIMIT_MAX ?? "20",
  10,
);

function clientAddress(c: Context): string {
  return (
    c.req.header("cf-connecting-ip") ??
    c.req.header("x-real-ip") ??
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown"
  );
}

function isRateLimited(c: Context): boolean {
  const now = Date.now();
  const route = new URL(c.req.url).pathname;
  const key = `${clientAddress(c)}:${route}`;
  const entry = authRateLimits.get(key);
  if (!entry || now - entry.windowStartedAt >= AUTH_RATE_LIMIT_WINDOW_MS) {
    authRateLimits.set(key, { windowStartedAt: now, count: 1 });
    return false;
  }
  entry.count += 1;
  return entry.count > AUTH_RATE_LIMIT_MAX;
}

authRoutes.use("/login/*", async (c, next) => {
  if (isRateLimited(c)) return c.json({ error: "rate-limited" }, 429);
  await next();
});

authRoutes.use("/register/*", async (c, next) => {
  if (isRateLimited(c)) return c.json({ error: "rate-limited" }, 429);
  await next();
});

function pruneChallenges() {
  const now = Date.now();
  for (const [key, value] of challenges) {
    if (value.expiresAt < now) challenges.delete(key);
  }
}

function stash(challengeId: string, challenge: string, ttlMs = 5 * 60 * 1000) {
  pruneChallenges();
  challenges.set(challengeId, { challenge, expiresAt: Date.now() + ttlMs });
}

function take(challengeId: string): string | null {
  pruneChallenges();
  const entry = challenges.get(challengeId);
  if (!entry) return null;
  challenges.delete(challengeId);
  return entry.challenge;
}

function b64urlToBuffer(s: string): Buffer {
  return Buffer.from(
    s
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(s.length + ((4 - (s.length % 4)) % 4), "="),
    "base64",
  );
}

function bufferToB64url(b: Buffer | Uint8Array): string {
  return Buffer.from(b)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function currentOrigin(c: Context, cfg: ServerConfig): Origin {
  const hostHeader = c.req.header("x-forwarded-host") ?? c.req.header("host");
  const matched = originForHost(hostHeader, cfg);
  if (matched) return matched;
  return cfg.origins[0] ?? {
    hostname: cfg.hostname,
    rpId: cfg.rp.id,
    origin: cfg.publicOrigin,
  };
}

async function signAndSetSessionCookie(
  c: Context,
  sessionToken: string,
  maxAgeDays: number,
): Promise<void> {
  const state = await readAuthState();
  const signed = signSessionToken(
    sessionToken,
    Buffer.from(state.sessionSigningKey, "base64"),
  );
  setCookie(c, getSessionCookieName(), signed, {
    httpOnly: true,
    secure: true,
    sameSite: "Strict",
    path: "/",
    maxAge: maxAgeDays * 86400,
  });
}

authRoutes.get("/status", async (c) => {
  const resolved = await resolveSessionFromCookieHeader(
    c.req.raw.headers.get("Cookie"),
  );
  if (resolved) {
    return c.json({ authenticated: true, hasCredentials: true });
  }

  return c.json({
    authenticated: false,
    hasCredentials: (await listCredentials()).length > 0,
  });
});

authRoutes.post("/login/begin", async (c) => {
  const cfg = await getServerConfig();
  const origin = currentOrigin(c, cfg);
  const creds = (await listCredentials()) as StoredCredential[];
  if (creds.length === 0) return c.json({ error: "no-credentials" }, 400);

  const options = await generateAuthenticationOptions({
    rpID: origin.rpId,
    userVerification: "preferred",
  });
  const challengeId = randomBytes(16).toString("hex");
  stash(challengeId, options.challenge);

  return c.json({ options, challengeId });
});

authRoutes.post("/login/finish", async (c) => {
  const cfg = await getServerConfig();
  const current = currentOrigin(c, cfg);
  const validOrigins = cfg.origins.length > 0 ? cfg.origins : [current];
  const body = await c.req.json<{
    challengeId?: string;
    response?: AuthenticatorResponse;
  }>();
  if (!body.challengeId || !body.response) {
    return c.json({ error: "auth-failed" }, 401);
  }

  const challenge = take(body.challengeId);
  if (!challenge) return c.json({ error: "challenge-expired" }, 401);

  const cred = await findCredentialById(body.response.id);
  if (!cred) return c.json({ error: "auth-failed" }, 401);

  const verification = await verifyAuthenticationResponse({
    response: body.response as never,
    expectedChallenge: challenge,
    expectedOrigin: validOrigins.map((origin) => origin.origin),
    expectedRPID: validOrigins.map((origin) => origin.rpId),
    credential: {
      id: cred.id,
      publicKey: b64urlToBuffer(cred.publicKey),
      counter: cred.counter,
      transports: cred.transports as never,
    },
  });
  if (!verification.verified) {
    return c.json({ error: "auth-failed" }, 401);
  }

  await updateCredentialAfterUse(
    cred.id,
    verification.authenticationInfo.newCounter,
  );
  const session = await createSession(cred.id);
  await signAndSetSessionCookie(c, session.token, cfg.session.maxAgeDays);

  return c.json({ ok: true });
});

authRoutes.post("/register/begin", async (c) => {
  const cfg = await getServerConfig();
  const origin = currentOrigin(c, cfg);
  const body = await c.req.json<{ enrollmentToken?: string }>();
  const enrollmentToken = body.enrollmentToken ?? "";
  const state = await readAuthState();
  const tokenRecord = (state.enrollmentTokens as EnrollmentTokenRecord[]).find(
    (token) => token.token === enrollmentToken,
  );
  if (!tokenRecord || new Date(tokenRecord.expiresAt).getTime() <= Date.now()) {
    return c.json({ error: "enrollment-invalid" }, 401);
  }

  const options = await generateRegistrationOptions({
    rpName: cfg.rp.name,
    rpID: origin.rpId,
    userID: randomBytes(16),
    userName: enrollmentToken.slice(0, 8),
    userDisplayName: "Swarmfleet User",
    attestationType: "none",
    authenticatorSelection: {
      residentKey: "required",
      userVerification: "preferred",
    },
  });
  stash(enrollmentToken, options.challenge);

  return c.json({ options, challengeId: enrollmentToken });
});

authRoutes.post("/register/finish", async (c) => {
  const cfg = await getServerConfig();
  const origin = currentOrigin(c, cfg);
  const body = await c.req.json<{
    enrollmentToken?: string;
    response?: AuthenticatorResponse;
    label?: string;
  }>();
  const enrollmentToken = body.enrollmentToken ?? "";
  if (!body.response) return c.json({ error: "register-failed" }, 400);

  const challenge = take(enrollmentToken);
  if (!challenge) return c.json({ error: "challenge-expired" }, 401);

  const verification = await verifyRegistrationResponse({
    response: body.response as never,
    expectedChallenge: challenge,
    expectedOrigin: origin.origin,
    expectedRPID: origin.rpId,
  });
  const registrationInfo = verification.registrationInfo;
  if (!verification.verified || !registrationInfo) {
    return c.json({ error: "register-failed" }, 400);
  }

  const consumed = await consumeEnrollmentToken(enrollmentToken);
  if (!consumed) return c.json({ error: "token-consumed" }, 409);

  const credentialId = registrationInfo.credential.id;
  const publicKey = bufferToB64url(registrationInfo.credential.publicKey);
  await addCredential({
    id: credentialId,
    rpId: origin.rpId,
    publicKey,
    counter: registrationInfo.credential.counter,
    transports: body.response.response.transports ?? [],
    label: body.label || "Unnamed device",
  });

  const session = await createSession(credentialId);
  await signAndSetSessionCookie(c, session.token, cfg.session.maxAgeDays);

  return c.json({ ok: true });
});

authRoutes.post("/logout", async (c) => {
  try {
    const resolved = await resolveSessionFromCookieHeader(
      c.req.raw.headers.get("Cookie"),
    );
    if (resolved) await revokeSession(resolved.token);
  } catch {
    // Logout should succeed even if the stored cookie is stale or malformed.
  }
  deleteCookie(c, getSessionCookieName(), { path: "/" });

  return c.json({ ok: true });
});

authRoutes.post("/enroll/qr", requireAuth, async (c) => {
  const cfg = await getServerConfig();
  const origin = currentOrigin(c, cfg);
  const credentialId = c.get("credentialId" as never) as string;
  const token = await mintEnrollmentToken(credentialId);
  const url = `${origin.origin}/enroll?token=${token.token}`;

  return c.json({ url, expiresAt: token.expiresAt });
});

authRoutes.get("/credentials", requireAuth, async (c) => {
  const credentials = (await listCredentials()) as StoredCredential[];

  return c.json({
    credentials: credentials.map((cred) => ({
      id: cred.id,
      label: cred.label,
      createdAt: cred.createdAt,
      expiresAt: cred.expiresAt,
      lastUsedAt: cred.lastUsedAt,
    })),
  });
});

authRoutes.delete("/credentials/:id", requireAuth, async (c) => {
  const id = c.req.param("id");
  await removeCredential(id);

  if (id === (c.get("credentialId" as never) as string)) {
    const sessionToken = c.get("sessionToken" as never) as string;
    await revokeSession(sessionToken);
    deleteCookie(c, getSessionCookieName(), { path: "/" });
  }

  return c.json({ ok: true });
});

export default authRoutes;
