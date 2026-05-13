import { realpath } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import type { Context } from "hono";
import type { ConfigContext } from "../middleware/config.ts";

const DANGEROUS_EXACT_PATHS = new Set(["/", "/home", "/root", "/tmp"]);

export class ProjectPathError extends Error {
  constructor(
    public readonly code: "missing" | "not_found" | "outside_workspace" | "unsafe_root",
    message: string,
  ) {
    super(message);
    this.name = "ProjectPathError";
  }
}

export function getWorkspacesRootFromContext(c: Context<ConfigContext>): string {
  return c.get("config")?.workspacesRoot || process.env.WORKSPACES_ROOT || "/workspace";
}

function isEqualOrDescendant(child: string, parent: string): boolean {
  const normalizedParent = parent.endsWith(sep) ? parent.slice(0, -1) : parent;
  return child === normalizedParent || child.startsWith(`${normalizedParent}${sep}`);
}

function looksLikeUnsafeRoot(path: string): boolean {
  if (DANGEROUS_EXACT_PATHS.has(path)) return true;
  if (/^\/home\/[^/]+$/.test(path)) return true;
  return false;
}

export async function validateExistingProjectPath(
  rawProjectPath: string | null | undefined,
  workspacesRoot: string,
): Promise<string> {
  const requested = rawProjectPath?.trim();
  if (!requested) {
    throw new ProjectPathError("missing", "projectPath is required");
  }

  let resolvedProject: string;
  let resolvedWorkspace: string;
  try {
    resolvedProject = await realpath(isAbsolute(requested) ? requested : resolve(workspacesRoot, requested));
    resolvedWorkspace = await realpath(workspacesRoot);
  } catch {
    throw new ProjectPathError("not_found", "Project path does not exist");
  }

  if (looksLikeUnsafeRoot(resolvedProject)) {
    throw new ProjectPathError("unsafe_root", "Project path is not a safe project directory");
  }

  if (!isEqualOrDescendant(resolvedProject, resolvedWorkspace)) {
    throw new ProjectPathError("outside_workspace", "Project path must be inside the workspace root");
  }

  return resolvedProject;
}

export function projectPathErrorResponse(error: ProjectPathError): Response {
  const status = error.code === "missing" ? 400 : error.code === "not_found" ? 404 : 403;
  return Response.json({ error: error.message, code: error.code }, { status });
}
