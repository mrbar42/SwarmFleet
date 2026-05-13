/**
 * Normalize Windows paths for cross-platform compatibility
 */
export function normalizeWindowsPath(path: string): string {
  return path.replace(/^\/([A-Za-z]:)/, "$1").replace(/\\/g, "/");
}
