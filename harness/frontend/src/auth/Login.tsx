import { useState } from "react";
import { startAuthentication } from "@simplewebauthn/browser";
import { beginLogin, finishLogin } from "./api";
import { useAuthStatus } from "./useAuthStatus";

function isUserCancellation(error: unknown): boolean {
  return error instanceof DOMException && error.name === "NotAllowedError";
}

export default function Login() {
  const hasCredentials = useAuthStatus((state) => state.hasCredentials);
  const refresh = useAuthStatus((state) => state.refresh);
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const signIn = async () => {
    setIsSigningIn(true);
    setError(null);
    try {
      const begin = await beginLogin();
      const response = await startAuthentication({
        optionsJSON: begin.options as Parameters<
          typeof startAuthentication
        >[0]["optionsJSON"],
      });
      await finishLogin(begin.challengeId, response);
      await refresh();
    } catch (err) {
      if (!isUserCancellation(err)) {
        setError(err instanceof Error ? err.message : "Sign in failed");
      }
    } finally {
      setIsSigningIn(false);
    }
  };

  return (
    <div className="min-h-dvh flex items-center justify-center bg-[#0d1117] px-4">
      <div className="w-full max-w-sm rounded-lg border border-[#30363d] bg-[#161b22] px-5 py-6 shadow-2xl">
        {hasCredentials === false ? (
          <p className="text-sm leading-relaxed text-[#c9d1d9]">
            No passkeys registered yet. Check container logs (
            <code className="font-mono text-[#7ee787]">
              docker logs swarmfleet-dev
            </code>
            ) for the bootstrap enrollment URL.
          </p>
        ) : (
          <>
            <div className="mb-5 text-center">
              <h1 className="text-xl font-semibold text-[#e6edf3]">
                Swarmfleet
              </h1>
              <p className="mt-1 text-sm text-[#8b949e]">
                Sign in with passkey
              </p>
            </div>
            <button
              onClick={() => void signIn()}
              disabled={isSigningIn}
              className="w-full rounded-md bg-[#238636] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[#2ea043] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isSigningIn ? "Signing in…" : "Sign in"}
            </button>
            <p
              className={`mt-3 min-h-5 text-xs text-[#f85149] transition-opacity ${
                error ? "opacity-100" : "opacity-0"
              }`}
            >
              {error}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
