import type { PreviewStatus } from "@shared/types";

const PREVIEW_PATH_KEY_PREFIX = "swarmfleet-preview-path:";

function previewPathKey(projectPath: string): string {
  return `${PREVIEW_PATH_KEY_PREFIX}${projectPath}`;
}

export function normalizePreviewPath(value: string | null | undefined): string {
  if (!value) return "/";
  const trimmed = value.trim();
  if (!trimmed.startsWith("/") || trimmed.startsWith("/api/")) return "/";
  return trimmed;
}

export function readStoredPreviewPath(projectPath: string | null): string {
  if (!projectPath) return "/";
  try {
    return normalizePreviewPath(
      localStorage.getItem(previewPathKey(projectPath)),
    );
  } catch {
    return "/";
  }
}

export function writeStoredPreviewPath(
  projectPath: string | null,
  value: string,
): void {
  if (!projectPath) return;
  try {
    localStorage.setItem(
      previewPathKey(projectPath),
      normalizePreviewPath(value),
    );
  } catch {
    // storage not available
  }
}

export function previewPathFromUrl(
  rawUrl: string | null | undefined,
  status: PreviewStatus | null,
): string {
  if (!rawUrl || !status?.id) return "/";
  try {
    const url = new URL(rawUrl, window.location.origin);
    const prefix = `/api/preview/proxy/${status.id}`;
    const path = url.pathname.startsWith(prefix)
      ? url.pathname.slice(prefix.length) || "/"
      : url.pathname || "/";
    return normalizePreviewPath(`${path}${url.search}${url.hash}`);
  } catch {
    return "/";
  }
}

export function getPreviewIframeSrc(
  status: PreviewStatus | null,
  projectPath: string | null = null,
): string | null {
  if (status?.state !== "running" || !status.id) return null;
  return `/api/preview/proxy/${encodeURIComponent(status.id)}${readStoredPreviewPath(projectPath)}`;
}

export const getPreviewProxySrc = getPreviewIframeSrc;
