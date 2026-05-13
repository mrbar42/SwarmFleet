import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowPathIcon,
  ExclamationTriangleIcon,
  PlayIcon,
  StopIcon,
} from "@heroicons/react/24/outline";
import type { PreviewStatus } from "@shared/types";
import { installPreviewNavigationGuard } from "./navigationGuard";
import {
  getPreviewIframeSrc,
  previewPathFromUrl,
  writeStoredPreviewPath,
} from "./previewUrls";
import { usePoll } from "../../hooks/usePoll";

interface PreviewTabProps {
  projectPath: string | null;
}

async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    return body.error || res.statusText;
  } catch {
    return res.statusText;
  }
}

async function fetchStatus(
  projectPath: string,
  signal?: AbortSignal,
): Promise<PreviewStatus> {
  const res = await fetch(
    `/api/preview/status?project=${encodeURIComponent(projectPath)}`,
    { signal },
  );
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as PreviewStatus;
}

async function postPreview(
  endpoint: "start" | "restart" | "stop",
  projectPath: string,
  signal?: AbortSignal,
): Promise<PreviewStatus> {
  const res = await fetch(`/api/preview/${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projectPath }),
    signal,
  });
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as PreviewStatus;
}

async function saveCommand(
  projectPath: string,
  command: string,
): Promise<PreviewStatus> {
  const res = await fetch("/api/preview/config", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projectPath, command }),
  });
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as PreviewStatus;
}

function StatusPill({ status }: { status: PreviewStatus | null }) {
  const label = status?.state ?? "idle";
  const className =
    status?.state === "running"
      ? "border-[#238636] bg-[#12301d] text-[#7ee787]"
      : status?.state === "error"
        ? "border-[#f85149] bg-[#3d1214] text-[#ffb3ad]"
        : status?.state === "starting"
          ? "border-[#d29922] bg-[#3a2a08] text-[#fde68a]"
          : "border-[#30363d] bg-[#21262d] text-[#8b949e]";

  return (
    <span
      className={`inline-flex h-6 items-center rounded-full border px-2 text-[11px] font-semibold uppercase ${className}`}
    >
      {label}
    </span>
  );
}

export default function PreviewTab({ projectPath }: PreviewTabProps) {
  const [status, setStatus] = useState<PreviewStatus | null>(null);
  const [command, setCommand] = useState("auto");
  const [error, setError] = useState<string | null>(null);
  const [iframeKey, setIframeKey] = useState(0);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const firstPollRef = useRef(true);

  const iframeSrc = getPreviewIframeSrc(status, projectPath);
  const isDirty = !!status && command.trim() !== status.configuredCommand;

  const syncStoredPath = useCallback(() => {
    let frameUrl = iframeSrc;
    try {
      frameUrl = iframeRef.current?.contentWindow?.location.href ?? frameUrl;
    } catch {
      // keep the last stored path
    }
    writeStoredPreviewPath(projectPath, previewPathFromUrl(frameUrl, status));
  }, [iframeSrc, projectPath, status]);

  const refresh = useCallback(async () => {
    if (!projectPath) return null;
    const next = await fetchStatus(projectPath);
    setStatus(next);
    setCommand(next.configuredCommand);
    return next;
  }, [projectPath]);

  useEffect(() => {
    firstPollRef.current = true;
    if (!projectPath) {
      setStatus(null);
      setCommand("auto");
    }
  }, [projectPath]);

  const pollStatus = useCallback(
    async (signal: AbortSignal) => {
      if (!projectPath) return;
      try {
        const next = await fetchStatus(projectPath, signal);
        if (signal.aborted) return;
        setStatus(next);
        setCommand(next.configuredCommand);
        setError(null);
        if (firstPollRef.current && next.state === "idle") {
          const started = await postPreview("start", projectPath, signal);
          if (!signal.aborted) setStatus(started);
        }
      } catch (err) {
        if (!signal.aborted) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        firstPollRef.current = false;
      }
    },
    [projectPath],
  );

  usePoll(pollStatus, 2000, { enabled: Boolean(projectPath) });

  const runAction = useCallback(
    async (action: "start" | "restart" | "stop" | "save") => {
      if (!projectPath) return;
      setBusyAction(action);
      setError(null);
      try {
        const next =
          action === "save"
            ? await saveCommand(projectPath, command)
            : await postPreview(action, projectPath);
        setStatus(next);
        setCommand(next.configuredCommand);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusyAction(null);
      }
    },
    [command, projectPath],
  );

  const retryText = useMemo(() => {
    if (!status?.retryAt) return null;
    const seconds = Math.max(
      0,
      Math.ceil((status.retryAt - Date.now()) / 1000),
    );
    return `retrying in ${seconds}s`;
  }, [status?.retryAt, status?.updatedAt]);

  useEffect(() => {
    if (!iframeSrc) return;
    syncStoredPath();
    const interval = window.setInterval(syncStoredPath, 500);
    return () => window.clearInterval(interval);
  }, [iframeSrc, syncStoredPath]);

  if (!projectPath) {
    return (
      <div className="flex-1 flex items-center justify-center bg-[#0d1117] text-sm text-[#8b949e]">
        Select a project to run a preview.
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col bg-[#0d1117] overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b border-[#30363d] bg-[#161b22] px-3 py-2 shrink-0">
        <StatusPill status={status} />
        {status?.hostUrl && (
          <a
            href={status.hostUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="h-8 max-w-[220px] truncate rounded-md border border-[#30363d] px-2.5 py-1.5 text-xs text-[#58a6ff] hover:border-[#58a6ff]/60 hover:underline"
            title={status.hostUrl}
          >
            {status.hostUrl}
          </a>
        )}
        <input
          type="text"
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && isDirty) void runAction("save");
          }}
          placeholder="auto"
          className="min-w-[180px] flex-1 rounded-md border border-[#30363d] bg-[#0d1117] px-2.5 py-1.5 font-mono text-xs text-[#e6edf3] placeholder-[#484f58] focus:border-[#58a6ff] focus:outline-none"
        />
        {isDirty && (
          <button
            onClick={() => void runAction("save")}
            disabled={busyAction !== null}
            className="h-8 rounded-md border border-[#1f6feb] bg-[#1f6feb] px-3 text-xs font-semibold text-white transition-colors hover:bg-[#388bfd] disabled:opacity-60"
          >
            Save
          </button>
        )}
        {status?.state !== "running" && (
          <button
            onClick={() => void runAction("start")}
            disabled={busyAction !== null}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-[#30363d] text-[#8b949e] transition-colors hover:text-[#c9d1d9] disabled:opacity-60"
            title="Start"
          >
            <PlayIcon className="h-4 w-4" />
          </button>
        )}
        <button
          onClick={() => void runAction("stop")}
          disabled={
            busyAction !== null || !status || status.state === "stopped"
          }
          className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-[#30363d] text-[#8b949e] transition-colors hover:text-[#c9d1d9] disabled:opacity-40"
          title="Stop"
        >
          <StopIcon className="h-4 w-4" />
        </button>
        <button
          onClick={() => {
            setIframeKey((key) => key + 1);
            void refresh();
          }}
          disabled={busyAction !== null}
          className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-[#30363d] text-[#8b949e] transition-colors hover:text-[#c9d1d9] disabled:opacity-60"
          title="Refresh"
        >
          <ArrowPathIcon className="h-4 w-4" />
        </button>
      </div>

      {(error || status?.error || retryText) && (
        <div className="flex items-start gap-2 border-b border-[#4a2323] bg-[#2e1c1c] px-3 py-2 text-xs text-[#ffb3ad]">
          <ExclamationTriangleIcon className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="min-w-0">
            <div className="break-words">{error || status?.error}</div>
            {retryText && (
              <div className="mt-1 text-[#f0a6a0]">{retryText}</div>
            )}
          </div>
        </div>
      )}

      {iframeSrc ? (
        <iframe
          key={iframeKey}
          ref={iframeRef}
          src={iframeSrc}
          className="flex-1 w-full border-none bg-white"
          title="Preview"
          onLoad={() => {
            installPreviewNavigationGuard(iframeRef.current, status);
            syncStoredPath();
          }}
        />
      ) : (
        <div className="flex-1 flex min-h-0 flex-col items-center justify-center gap-4 p-6 text-center text-[#8b949e]">
          <div className="h-10 w-10 rounded-lg border border-[#30363d] bg-[#161b22] flex items-center justify-center">
            {status?.state === "error" ? (
              <ExclamationTriangleIcon className="h-5 w-5 text-[#f85149]" />
            ) : (
              <ArrowPathIcon className="h-5 w-5 animate-spin text-[#d29922]" />
            )}
          </div>
          <div>
            <p className="text-sm font-medium text-[#c9d1d9]">
              {status?.state === "error"
                ? "Preview failed"
                : "Starting preview"}
            </p>
            {status?.resolvedCommand && (
              <p className="mt-1 max-w-[560px] truncate font-mono text-xs text-[#8b949e]">
                {status.resolvedCommand}
              </p>
            )}
          </div>
        </div>
      )}

      {status?.logs && (
        <details className="max-h-48 shrink-0 overflow-auto border-t border-[#30363d] bg-[#0d1117]">
          <summary className="cursor-pointer px-3 py-2 text-xs font-semibold text-[#8b949e]">
            Logs
          </summary>
          <pre className="whitespace-pre-wrap px-3 pb-3 font-mono text-[11px] leading-relaxed text-[#c9d1d9]">
            {status.logs}
          </pre>
        </details>
      )}
    </div>
  );
}
