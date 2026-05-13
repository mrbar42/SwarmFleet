import { useEffect, useState } from "react";
import { type CredentialRecord, getCredentials, removeCredential } from "./api";
import { useAuthStatus } from "./useAuthStatus";

function formatRelative(dateValue: string | null, now: number): string {
  if (!dateValue) return "never";
  const dateMs = Date.parse(dateValue);
  if (!Number.isFinite(dateMs)) return "unknown";
  const deltaMs = dateMs - now;
  const absMs = Math.abs(deltaMs);
  const suffix = deltaMs >= 0 ? "from now" : "ago";
  const minutes = Math.round(absMs / 60000);
  if (minutes < 1) return deltaMs >= 0 ? "now" : "just now";
  if (minutes < 60) return `${minutes}m ${suffix}`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ${suffix}`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? "" : "s"} ${suffix}`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months} month${months === 1 ? "" : "s"} ${suffix}`;
  const years = Math.round(months / 12);
  return `${years} year${years === 1 ? "" : "s"} ${suffix}`;
}

export default function CredentialsList() {
  const refreshAuth = useAuthStatus((state) => state.refresh);
  const [credentials, setCredentials] = useState<CredentialRecord[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const refreshList = async () => {
    setError(null);
    const result = await getCredentials();
    setCredentials(result.credentials);
  };

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    getCredentials()
      .then((result) => {
        if (!cancelled) setCredentials(result.credentials);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : "Could not load devices",
          );
        }
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 60000);
    return () => window.clearInterval(interval);
  }, []);

  const handleRemove = async (credential: CredentialRecord) => {
    setRemovingId(credential.id);
    setError(null);
    try {
      await removeCredential(credential.id);
      await refreshList();
      await refreshAuth();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not remove device");
    } finally {
      setRemovingId(null);
    }
  };

  return (
    <div className="rounded-lg border border-[#30363d] bg-[#161b22] px-3 py-3">
      <div className="mb-3">
        <div className="text-sm font-medium text-[#e6edf3]">Passkeys</div>
        <p className="text-xs text-[#8b949e]">
          Devices that can sign in to this SwarmFleet instance.
        </p>
      </div>

      {isLoading ? (
        <p className="text-xs text-[#8b949e]">Loading devices…</p>
      ) : credentials.length === 0 ? (
        <p className="text-xs text-[#8b949e]">No devices enrolled.</p>
      ) : (
        <div className="space-y-2">
          {credentials.map((credential) => (
            <div
              key={credential.id}
              className="rounded-md border border-[#30363d] bg-[#0d1117] px-3 py-2"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-[#c9d1d9]">
                    {credential.label || "Unnamed device"}
                  </div>
                  <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-[#8b949e]">
                    <span>
                      created {formatRelative(credential.createdAt, now)}
                    </span>
                    <span>
                      expires {formatRelative(credential.expiresAt, now)}
                    </span>
                    <span>
                      last used {formatRelative(credential.lastUsedAt, now)}
                    </span>
                  </div>
                </div>
                <button
                  onClick={() => void handleRemove(credential)}
                  disabled={removingId === credential.id}
                  className="shrink-0 rounded-md border border-[#30363d] px-2 py-1 text-xs text-[#f85149] transition-colors hover:bg-[#3d1214]/30 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {removingId === credential.id ? "Removing…" : "Remove"}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {error && <p className="mt-2 text-xs text-[#f85149]">{error}</p>}
    </div>
  );
}
