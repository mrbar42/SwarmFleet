import { describe, expect, it } from "vitest";
import {
  getSessionCookieCandidates,
  getSessionCookieName,
  signSessionToken,
  verifySessionToken,
} from "../lib/sessionCookie.ts";

describe("session cookie signing", () => {
  it("round-trips a signed token", () => {
    const key = Buffer.alloc(32, 7);
    const signed = signSessionToken("session-token", key);

    expect(signed).toMatch(/^session-token\.[A-Za-z0-9_-]+$/);
    expect(verifySessionToken(signed, key)).toBe("session-token");
  });

  it("rejects tampered tokens and signatures", () => {
    const key = Buffer.alloc(32, 7);
    const signed = signSessionToken("session-token", key);
    const [token, sig] = signed.split(".");

    expect(verifySessionToken(`other-token.${sig}`, key)).toBeNull();
    expect(verifySessionToken(`${token}.${sig.slice(0, -1)}A`, key)).toBeNull();
  });

  it("rejects garbled signed values", () => {
    const key = Buffer.alloc(32, 7);

    expect(verifySessionToken("", key)).toBeNull();
    expect(verifySessionToken("missing-dot", key)).toBeNull();
    expect(verifySessionToken("token.", key)).toBeNull();
    expect(verifySessionToken(".signature", key)).toBeNull();
  });

  it("namespaces non-default local instances by public port", () => {
    const previous = process.env.SWARMFLEET_PUBLIC_PORT;
    try {
      delete process.env.SWARMFLEET_PUBLIC_PORT;
      expect(getSessionCookieName()).toBe("swarmfleet_session");

      process.env.SWARMFLEET_PUBLIC_PORT = "7070";
      expect(getSessionCookieName()).toBe("swarmfleet_session");

      process.env.SWARMFLEET_PUBLIC_PORT = "7071";
      expect(getSessionCookieName()).toBe("swarmfleet_session_7071");
    } finally {
      if (previous === undefined) delete process.env.SWARMFLEET_PUBLIC_PORT;
      else process.env.SWARMFLEET_PUBLIC_PORT = previous;
    }
  });

  it("reads only the selected session cookie name", () => {
    const cookieHeader = [
      "swarmfleet_session=first",
      "swarmfleet_session_7071=second",
    ].join("; ");

    expect(getSessionCookieCandidates(cookieHeader, "swarmfleet_session")).toEqual([
      "first",
    ]);
    expect(
      getSessionCookieCandidates(cookieHeader, "swarmfleet_session_7071"),
    ).toEqual(["second"]);
  });
});
