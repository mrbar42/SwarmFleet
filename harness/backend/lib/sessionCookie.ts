import { createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE_NAME = "swarmfleet_session";

function sanitizeCookieNamePart(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_");
}

/**
 * Cookie scope is host/path, not port. Two local SwarmFleet instances on
 * localhost:7070 and localhost:7071 would otherwise overwrite each other's
 * `swarmfleet_session` cookie. Keep the historical name for the default port,
 * but namespace non-default/dev instances by public port unless explicitly set.
 */
export function getSessionCookieName(): string {
  const configured = process.env.SWARMFLEET_SESSION_COOKIE_NAME?.trim();
  if (configured) return configured;

  const publicPort = process.env.SWARMFLEET_PUBLIC_PORT?.trim();
  if (!publicPort || publicPort === "7070") return SESSION_COOKIE_NAME;
  return `${SESSION_COOKIE_NAME}_${sanitizeCookieNamePart(publicPort)}`;
}

function signature(token: string, key: Buffer): string {
  return createHmac("sha256", key).update(token).digest("base64url");
}

export function signSessionToken(token: string, key: Buffer): string {
  return `${token}.${signature(token, key)}`;
}

export function verifySessionToken(signed: string, key: Buffer): string | null {
  const separator = signed.lastIndexOf(".");
  if (separator <= 0 || separator === signed.length - 1) return null;

  const token = signed.slice(0, separator);
  const supplied = signed.slice(separator + 1);
  const expected = signature(token, key);
  const suppliedBuffer = Buffer.from(supplied, "base64url");
  const expectedBuffer = Buffer.from(expected, "base64url");

  if (suppliedBuffer.length !== expectedBuffer.length) return null;
  if (!timingSafeEqual(suppliedBuffer, expectedBuffer)) return null;
  return token;
}

export function getSessionCookieCandidates(
  cookieHeader: string | null | undefined,
  cookieName = getSessionCookieName(),
): string[] {
  if (!cookieHeader) return [];

  const values: string[] = [];
  for (const pair of cookieHeader.split(";")) {
    const separator = pair.indexOf("=");
    if (separator < 0) continue;
    if (pair.slice(0, separator).trim() !== cookieName) continue;

    const rawValue = pair.slice(separator + 1).trim();
    const value =
      rawValue.startsWith('"') && rawValue.endsWith('"')
        ? rawValue.slice(1, -1)
        : rawValue;
    if (!value) continue;

    try {
      values.push(decodeURIComponent(value));
    } catch {
      values.push(value);
    }
  }
  return values;
}
