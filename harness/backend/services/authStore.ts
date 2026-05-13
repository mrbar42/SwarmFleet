import { randomBytes } from "node:crypto";
import {
  getServerConfig,
  mutateAuthState,
  readAuthState,
} from "./globalConfig.ts";
import {
  getSessionCookieCandidates,
  verifySessionToken,
} from "../lib/sessionCookie.ts";

export interface Credential {
  id: string;
  rpId: string;
  publicKey: string;
  counter: number;
  transports: string[];
  label: string;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
}

export interface Session {
  token: string;
  credentialId: string;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
}

export interface EnrollmentToken {
  token: string;
  createdAt: string;
  expiresAt: string;
  issuedBy: string;
}

export interface AuthState {
  version?: number;
  sessionSigningKey: string;
  credentials: Credential[];
  sessions: Session[];
  enrollmentTokens: EnrollmentToken[];
}

function nowIso(): string {
  return new Date().toISOString();
}

function addDays(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

function addHours(hours: number): string {
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}

function isNonExpired(expiresAt: string | null): boolean {
  return Boolean(expiresAt && Date.parse(expiresAt) > Date.now());
}

function isActiveCredential(credential: Credential): boolean {
  return (
    credential.expiresAt === null ||
    Date.parse(credential.expiresAt) > Date.now()
  );
}

function pruneState(state: AuthState): AuthState {
  return {
    ...state,
    credentials: state.credentials.filter((credential) =>
      isActiveCredential(credential),
    ),
    sessions: state.sessions.filter((session) =>
      isNonExpired(session.expiresAt),
    ),
    enrollmentTokens: state.enrollmentTokens.filter((token) =>
      isNonExpired(token.expiresAt),
    ),
  };
}

async function mutatePruned(
  fn: (state: AuthState) => AuthState | Promise<AuthState>,
): Promise<AuthState> {
  return mutateAuthState(async (state) => fn(pruneState(state)));
}

export async function findCredentialById(
  id: string,
): Promise<Credential | null> {
  const state = pruneState(await readAuthState());
  return state.credentials.find((credential) => credential.id === id) ?? null;
}

export async function listCredentials(): Promise<Credential[]> {
  return pruneState(await readAuthState()).credentials;
}

export async function addCredential(input: {
  id: string;
  rpId: string;
  publicKey: string;
  counter: number;
  transports: string[];
  label: string;
}): Promise<Credential> {
  const config = await getServerConfig();
  const timestamp = nowIso();
  const credential: Credential = {
    id: input.id,
    rpId: input.rpId,
    publicKey: input.publicKey,
    counter: input.counter,
    transports: [...input.transports],
    label: input.label,
    createdAt: timestamp,
    expiresAt: addDays(config.credential.maxAgeDays),
    lastUsedAt: timestamp,
  };

  await mutatePruned((state) => ({
    ...state,
    credentials: [
      ...state.credentials.filter((existing) => existing.id !== input.id),
      credential,
    ],
  }));
  return credential;
}

export async function updateCredentialAfterUse(
  id: string,
  counter: number,
): Promise<void> {
  await mutatePruned((state) => ({
    ...state,
    credentials: state.credentials.map((credential) =>
      credential.id === id
        ? { ...credential, counter, lastUsedAt: nowIso() }
        : credential,
    ),
  }));
}

export async function removeCredential(id: string): Promise<void> {
  await mutatePruned((state) => ({
    ...state,
    credentials: state.credentials.filter((credential) => credential.id !== id),
    sessions: state.sessions.filter((session) => session.credentialId !== id),
  }));
}

export async function createSession(credentialId: string): Promise<Session> {
  const config = await getServerConfig();
  const timestamp = nowIso();
  const session: Session = {
    token: randomBytes(32).toString("hex"),
    credentialId,
    createdAt: timestamp,
    lastUsedAt: timestamp,
    expiresAt: addDays(config.session.maxAgeDays),
  };

  await mutatePruned((state) => ({
    ...state,
    sessions: [...state.sessions, session],
  }));
  return session;
}

export async function findSession(token: string): Promise<Session | null> {
  const state = pruneState(await readAuthState());
  return state.sessions.find((session) => session.token === token) ?? null;
}

export async function touchSession(token: string): Promise<void> {
  const config = await getServerConfig();
  await mutatePruned((state) => ({
    ...state,
    sessions: state.sessions.map((session) => {
      if (session.token !== token) return session;

      const lastUsedAt = Date.parse(session.lastUsedAt);
      const renewAfterMs =
        config.session.renewOnUseAfterDays * 24 * 60 * 60 * 1000;
      if (
        Number.isFinite(lastUsedAt) &&
        Date.now() - lastUsedAt <= renewAfterMs
      ) {
        return session;
      }

      return {
        ...session,
        lastUsedAt: nowIso(),
        expiresAt: addDays(config.session.maxAgeDays),
      };
    }),
  }));
}

export async function revokeSession(token: string): Promise<void> {
  await mutatePruned((state) => ({
    ...state,
    sessions: state.sessions.filter((session) => session.token !== token),
  }));
}

export async function mintEnrollmentToken(
  issuedBy: string,
): Promise<EnrollmentToken> {
  const config = await getServerConfig();
  const timestamp = nowIso();
  const token: EnrollmentToken = {
    token: randomBytes(16).toString("hex"),
    createdAt: timestamp,
    expiresAt: addHours(config.enrollmentToken.maxAgeHours),
    issuedBy,
  };

  await mutatePruned((state) => ({
    ...state,
    enrollmentTokens: [...state.enrollmentTokens, token],
  }));
  return token;
}

export async function consumeEnrollmentToken(
  token: string,
): Promise<EnrollmentToken | null> {
  let consumed: EnrollmentToken | null = null;
  await mutatePruned((state) => {
    const entry = state.enrollmentTokens.find((item) => item.token === token);
    consumed = entry ?? null;
    return {
      ...state,
      enrollmentTokens: state.enrollmentTokens.filter(
        (item) => item.token !== token,
      ),
    };
  });
  return consumed;
}

export async function pruneExpired(): Promise<void> {
  await mutateAuthState((state) => pruneState(state));
}

export async function resolveSessionFromCookieHeader(
  cookieHeader: string | null | undefined,
): Promise<{ token: string; session: Session } | null> {
  const candidates = getSessionCookieCandidates(cookieHeader);
  if (candidates.length === 0) return null;

  const state = pruneState(await readAuthState());
  const key = Buffer.from(state.sessionSigningKey, "base64");

  for (const candidate of candidates) {
    const token = verifySessionToken(candidate, key);
    if (!token) continue;
    const session = state.sessions.find((entry) => entry.token === token);
    if (session) return { token, session };
  }

  return null;
}
