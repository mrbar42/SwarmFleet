import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowPathIcon, XMarkIcon } from "@heroicons/react/24/outline";
import type { PreviewStatus } from "@shared/types";
import { installPreviewNavigationGuard } from "./navigationGuard";
import {
  getPreviewProxySrc,
  previewPathFromUrl,
  writeStoredPreviewPath,
} from "./previewUrls";

interface MobilePreviewSidebarProps {
  isOpen: boolean;
  onClose: () => void;
  projectPath: string | null;
  status: PreviewStatus | null;
}

function statusText(status: PreviewStatus | null): string {
  if (!status) return "Preview unavailable";
  if (status.state === "running") return status.resolvedCommand ?? "Preview";
  if (status.state === "error") return status.error ?? "Preview failed";
  if (status.state === "starting") return "Starting preview";
  return "Preview stopped";
}

export function MobilePreviewSidebar({
  isOpen,
  onClose,
  projectPath,
  status,
}: MobilePreviewSidebarProps) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [displayPath, setDisplayPath] = useState("/");
  const [iframeKey, setIframeKey] = useState(0);
  const iframeSrc = getPreviewProxySrc(status, projectPath);

  const syncDisplayPath = useCallback(() => {
    let frameUrl = iframeSrc ?? null;
    try {
      frameUrl = iframeRef.current?.contentWindow?.location.href ?? frameUrl;
    } catch {
      // External navigations are possible; keep the last proxy URL display.
    }
    const nextPath = previewPathFromUrl(frameUrl, status);
    setDisplayPath(nextPath);
    writeStoredPreviewPath(projectPath, nextPath);
  }, [iframeSrc, projectPath, status]);

  useEffect(() => {
    setDisplayPath(previewPathFromUrl(iframeSrc, status));
  }, [iframeSrc, status]);

  useEffect(() => {
    if (!isOpen || !iframeSrc) return;
    syncDisplayPath();
    const interval = window.setInterval(syncDisplayPath, 500);
    return () => window.clearInterval(interval);
  }, [iframeSrc, isOpen, syncDisplayPath]);

  return (
    <aside
      data-testid="mobile-preview-sidebar"
      data-open={isOpen ? "true" : "false"}
      className={`h-full shrink-0 overflow-hidden bg-[#0d1117] transition-[width] duration-200 ${
        isOpen ? "border-l border-[#30363d]" : "border-l-0"
      }`}
      style={{ width: isOpen ? "min(430px, 100vw)" : "0px" }}
      aria-hidden={!isOpen}
    >
      <div
        className="flex h-full flex-col"
        style={{ width: "min(430px, 100vw)" }}
      >
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-[#30363d] bg-[#161b22] px-3">
          <div className="shrink-0">
            <div className="text-xs font-semibold text-[#c9d1d9]">
              Mobile Preview
            </div>
          </div>
          <input
            value={iframeSrc ? displayPath : statusText(status)}
            readOnly
            className="h-7 min-w-0 flex-1 rounded-md border border-[#30363d] bg-[#0d1117] px-2 font-mono text-[11px] text-[#c9d1d9] outline-none"
            aria-label="Mobile preview URL"
            title={iframeSrc ? displayPath : statusText(status)}
          />
          <button
            onClick={() => setIframeKey((key) => key + 1)}
            disabled={!iframeSrc}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-[#8b949e] transition-colors hover:bg-[#21262d] hover:text-[#c9d1d9] disabled:cursor-not-allowed disabled:opacity-40"
            aria-label="Refresh mobile preview"
            title="Refresh"
          >
            <ArrowPathIcon className="h-4 w-4" />
          </button>
          <button
            onClick={onClose}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-[#8b949e] transition-colors hover:bg-[#21262d] hover:text-[#c9d1d9]"
            aria-label="Close mobile preview"
            title="Close"
          >
            <XMarkIcon className="h-4 w-4" />
          </button>
        </div>
        <div className="flex min-h-0 flex-1 items-start justify-center overflow-auto bg-[#010409] p-3">
          <div
            className="overflow-hidden rounded-[28px] border-4 border-[#30363d] bg-white shadow-xl"
            style={{
              width: "min(390px, calc(100vw - 32px))",
              height: "min(844px, calc(100dvh - 72px))",
            }}
          >
            {iframeSrc ? (
              <iframe
                key={iframeKey}
                ref={iframeRef}
                src={iframeSrc}
                title="Mobile Preview"
                className="h-full w-full border-0 bg-white"
                onLoad={() => {
                  installPreviewNavigationGuard(iframeRef.current, status);
                  syncDisplayPath();
                }}
              />
            ) : (
              <div className="flex h-full items-center justify-center bg-[#0d1117] px-6 text-center text-sm text-[#8b949e]">
                {statusText(status)}
              </div>
            )}
          </div>
        </div>
      </div>
    </aside>
  );
}
