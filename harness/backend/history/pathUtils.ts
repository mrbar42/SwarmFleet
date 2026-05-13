/**
 * Path utilities for conversation history functionality
 */

import { readDir } from "../utils/fs.ts";
import { getHomeDir } from "../utils/os.ts";

/**
 * Get the encoded directory name for a project path by checking what actually exists
 */
export async function getEncodedProjectName(
  projectPath: string,
): Promise<string | null> {
  const homeDir = getHomeDir();
  if (!homeDir) {
    return null;
  }

  const projectsDir = `${homeDir}/.claude/projects`;

  try {
    const entries = [];
    for await (const entry of readDir(projectsDir)) {
      if (entry.isDirectory) {
        entries.push(entry.name);
      }
    }

    const normalizedPath = projectPath.replace(/\/$/, "");
    const expectedEncoded = normalizedPath.replace(/[/\\:._]/g, "-");

    if (entries.includes(expectedEncoded)) {
      return expectedEncoded;
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Validate that an encoded project name is safe
 */
export function validateEncodedProjectName(encodedName: string): boolean {
  if (!encodedName) {
    return false;
  }

  // deno-lint-ignore no-control-regex
  const dangerousChars = /[<>:"|?*\x00-\x1f\/\\]/;
  if (dangerousChars.test(encodedName)) {
    return false;
  }

  return true;
}
