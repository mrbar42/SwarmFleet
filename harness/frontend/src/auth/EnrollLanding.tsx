import { useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { startRegistration } from "@simplewebauthn/browser";
import { AuthFetchError, beginRegistration, finishRegistration } from "./api";
import { useAuthStatus } from "./useAuthStatus";

function guessDeviceLabel(): string {
  const ua = navigator.userAgent;
  const platform = navigator.platform;
  const device = /iPhone/i.test(ua)
    ? "iPhone"
    : /iPad/i.test(ua)
      ? "iPad"
      : /Android/i.test(ua)
        ? "Android"
        : /Mac/i.test(platform)
          ? "MacBook"
          : /Win/i.test(platform)
            ? "Windows"
            : "Device";
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Chrome\//.test(ua)
      ? "Chrome"
      : /Safari\//.test(ua)
        ? "Safari"
        : /Firefox\//.test(ua)
          ? "Firefox"
          : "Browser";
  return `${device} ${browser}`;
}

function errorCode(error: unknown): string | null {
  if (!(error instanceof AuthFetchError)) return null;
  const body = error.body;
  return body && typeof body === "object" && "error" in body
    ? String((body as { error: unknown }).error)
    : null;
}

function isUserCancellation(error: unknown): boolean {
  return error instanceof DOMException && error.name === "NotAllowedError";
}

export default function EnrollLanding() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token");
  const defaultLabel = useMemo(() => guessDeviceLabel(), []);
  const [label, setLabel] = useState(defaultLabel);
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refresh = useAuthStatus((state) => state.refresh);
  const navigate = useNavigate();

  const createPasskey = async () => {
    if (!token) return;
    setIsCreating(true);
    setError(null);
    try {
      const begin = await beginRegistration(token);
      const response = await startRegistration({
        optionsJSON: begin.options as Parameters<
          typeof startRegistration
        >[0]["optionsJSON"],
      });
      await finishRegistration(token, response, label.trim() || defaultLabel);
      await refresh();
      navigate("/", { replace: true });
    } catch (err) {
      if (isUserCancellation(err)) return;
      const code = errorCode(err);
      if (code === "enrollment-invalid") {
        setError(
          "This enrollment link is no longer valid. Ask the laptop owner to generate a new one.",
        );
      } else if (code === "token-consumed") {
        setError("This link has already been used.");
      } else {
        setError(
          err instanceof Error ? err.message : "Could not create passkey",
        );
      }
    } finally {
      setIsCreating(false);
    }
  };

  if (!token) {
    return (
      <div className="min-h-dvh flex items-center justify-center bg-[#0d1117] px-4">
        <div className="rounded-lg border border-[#30363d] bg-[#161b22] px-5 py-4 text-sm text-[#c9d1d9]">
          Invalid enrollment link.
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-dvh flex items-center justify-center bg-[#0d1117] px-4">
      <div className="w-full max-w-sm rounded-lg border border-[#30363d] bg-[#161b22] px-5 py-6 shadow-2xl">
        <div className="mb-5 text-center">
          <h1 className="text-xl font-semibold text-[#e6edf3]">
            Create passkey
          </h1>
          <p className="mt-1 text-sm text-[#8b949e]">Enroll this device</p>
        </div>
        <label className="block text-xs font-medium text-[#8b949e]">
          Device label
        </label>
        <input
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          className="mt-1 w-full rounded-md border border-[#30363d] bg-[#0d1117] px-3 py-2 text-sm text-[#e6edf3] outline-none transition-colors placeholder:text-[#484f58] focus:border-[#58a6ff]"
        />
        <button
          onClick={() => void createPasskey()}
          disabled={isCreating}
          className="mt-4 w-full rounded-md bg-[#238636] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[#2ea043] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isCreating ? "Creating…" : "Create passkey"}
        </button>
        {error && (
          <p className="mt-3 text-xs leading-relaxed text-[#f85149]">{error}</p>
        )}
      </div>
    </div>
  );
}
