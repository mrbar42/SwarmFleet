/**
 * Shared OS utilities using Node.js os and process modules
 */

import { homedir } from "node:os";
import process from "node:process";

/**
 * Get environment variable
 */
export function getEnv(key: string): string | undefined {
  return process.env[key];
}

/**
 * Get command line arguments (excluding node/deno and script path)
 */
export function getArgs(): string[] {
  return process.argv.slice(2);
}

/**
 * Get platform identifier
 */
export function getPlatform(): "windows" | "darwin" | "linux" {
  switch (process.platform) {
    case "win32":
      return "windows";
    case "darwin":
      return "darwin";
    case "linux":
      return "linux";
    default:
      return "linux";
  }
}

/**
 * Get home directory path
 */
export function getHomeDir(): string | undefined {
  try {
    return homedir();
  } catch {
    return undefined;
  }
}

/**
 * Exit the process with given code
 */
export function exit(code: number): never {
  process.exit(code);
}
