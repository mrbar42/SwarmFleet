import { useEffect, useRef, useState } from "react";
import { XMarkIcon } from "@heroicons/react/24/outline";
import type { SubprocessEntry } from "@shared/types";

function formatElapsed(startedAt: number | null): string {
  if (startedAt === null) return "";
  const secs = Math.floor((Date.now() - startedAt) / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  if (mins < 60) return remSecs > 0 ? `${mins}m ${remSecs}s` : `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return remMins > 0 ? `${hours}h ${remMins}m` : `${hours}h`;
}

interface ProcessRowProps {
  entry: SubprocessEntry;
  sessionId: string;
  onKilled: () => void;
}

function ProcessRow({ entry, sessionId, onKilled }: ProcessRowProps) {
  const [killing, setKilling] = useState(false);
  const [killError, setKillError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(() => formatElapsed(entry.startedAt));
  const reenableTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (entry.startedAt === null) return;
    const id = setInterval(() => {
      setElapsed(formatElapsed(entry.startedAt));
    }, 1000);
    return () => clearInterval(id);
  }, [entry.startedAt]);

  useEffect(() => {
    return () => {
      if (reenableTimerRef.current !== null) {
        clearTimeout(reenableTimerRef.current);
      }
    };
  }, []);

  const handleKill = async () => {
    setKilling(true);
    setKillError(null);
    reenableTimerRef.current = setTimeout(() => {
      setKilling(false);
    }, 3000);

    try {
      const res = await fetch(
        `/api/sessions/${encodeURIComponent(sessionId)}/processes/${entry.pid}/kill`,
        { method: "POST" },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({ error: `HTTP ${res.status}` }))) as {
          error?: string;
        };
        setKillError(body.error ?? `HTTP ${res.status}`);
        setKilling(false);
        if (reenableTimerRef.current !== null) {
          clearTimeout(reenableTimerRef.current);
          reenableTimerRef.current = null;
        }
      } else {
        onKilled();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Network error";
      console.error("[SubprocessOverlay] kill failed:", err);
      setKillError(message);
      setKilling(false);
      if (reenableTimerRef.current !== null) {
        clearTimeout(reenableTimerRef.current);
        reenableTimerRef.current = null;
      }
    }
  };

  return (
    <div className="flex items-center gap-2 px-3 py-2 border-b border-[#21262d] last:border-0">
      <span
        className="text-xs text-[#c9d1d9] truncate flex-1 min-w-0"
        title={entry.command}
      >
        {entry.command}
      </span>
      {elapsed && (
        <span className="text-[10px] text-[#484f58] shrink-0 tabular-nums">
          {elapsed}
        </span>
      )}
      <button
        onClick={() => void handleKill()}
        disabled={killing}
        className="shrink-0 p-0.5 rounded text-[#8b949e] hover:text-[#f85149] hover:bg-[#3d1214]/40 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        aria-label={`Kill process ${entry.pid}`}
        title={`Kill PID ${entry.pid}`}
      >
        <XMarkIcon className="w-3.5 h-3.5" />
      </button>
      {killError && (
        <span className="text-[10px] text-[#f85149] truncate max-w-[120px]" title={killError}>
          {killError}
        </span>
      )}
    </div>
  );
}

interface SubprocessOverlayProps {
  sessionId: string;
  processes: SubprocessEntry[];
  anchorRef: React.RefObject<HTMLButtonElement | null>;
  onClose: () => void;
}

export function SubprocessOverlay({
  sessionId,
  processes,
  anchorRef,
  onClose,
}: SubprocessOverlayProps) {
  const overlayRef = useRef<HTMLDivElement>(null);

  // Close when clicking outside.
  useEffect(() => {
    const handler = (event: MouseEvent) => {
      if (
        overlayRef.current &&
        !overlayRef.current.contains(event.target as Node) &&
        anchorRef.current &&
        !anchorRef.current.contains(event.target as Node)
      ) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [anchorRef, onClose]);

  // Close on Escape.
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <div
      ref={overlayRef}
      className="absolute right-0 top-full mt-1 z-50 w-80 bg-[#161b22] border border-[#30363d] rounded-md shadow-lg"
    >
      <div className="flex items-center justify-between px-3 py-2 border-b border-[#30363d]">
        <span className="text-xs font-medium text-[#c9d1d9]">
          Running processes
        </span>
        <button
          onClick={onClose}
          className="p-0.5 rounded text-[#8b949e] hover:text-[#c9d1d9] transition-colors"
          aria-label="Close"
        >
          <XMarkIcon className="w-3.5 h-3.5" />
        </button>
      </div>
      <div className="max-h-64 overflow-y-auto">
        {processes.length === 0 ? (
          <div className="px-3 py-4 text-xs text-[#484f58] text-center">
            No running processes
          </div>
        ) : (
          processes.map((entry) => (
            <ProcessRow
              key={entry.pid}
              entry={entry}
              sessionId={sessionId}
              onKilled={onClose}
            />
          ))
        )}
      </div>
    </div>
  );
}
