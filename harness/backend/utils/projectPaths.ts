import { realpath } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import type { Context } from "hono";
import type { ConfigContext } from "../middleware/config.ts";

const DANGEROUS_EXACT_PATHS = new Set(["/", "/home", "/root", "/tmp"]);

export class ProjectPathError extends Error {
  constructor(
    public readonly code:
      | "missing"
      | "not_found"
      | "outside_workspace"
      | "unsafe_root",
    message: string,
  ) {
    super(message);
    this.name = "ProjectPathError";
  }
}

export function getWorkspacesRootFromContext(
  c: Context<ConfigContext>,
): string {
  return (
    c.get("config")?.workspacesRoot ||
    process.env.WORKSPACES_ROOT ||
    "/workspace"
  );
}

function isEqualOrDescendant(child: string, parent: string): boolean {
  const normalizedParent = parent.endsWith(sep) ? parent.slice(0, -1) : parent;
  return (
    child === normalizedParent || child.startsWith(`${normalizedParent}${sep}`)
  );
}

function looksLikeUnsafeRoot(path: string): boolean {
  if (DANGEROUS_EXACT_PATHS.has(path)) return true;
  if (/^\/home\/[^/]+$/.test(path)) return true;
  return false;
}

async function resolveAllowedProjectRoots(
  workspacesRoot: string,
): Promise<string[]> {
  const roots = [workspacesRoot, process.env.SWARMFLEET_HARNESS_DIR].filter(
    (value): value is string => Boolean(value?.trim()),
  );
  const resolved: string[] = [];

  for (const root of roots) {
    try {
      const path = await realpath(root);
      if (!resolved.includes(path)) {
        resolved.push(path);
      }
    } catch {
      // Optional roots, such as the source-mounted harness path, may not exist
      // in every runtime or test environment.
    }
  }

  return resolved;
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
  try {
    resolvedProject = await realpath(
      isAbsolute(requested) ? requested : resolve(workspacesRoot, requested),
    );
  } catch {
    throw new ProjectPathError("not_found", "Project path does not exist");
  }

  if (looksLikeUnsafeRoot(resolvedProject)) {
    throw new ProjectPathError(
      "unsafe_root",
      "Project path is not a safe project directory",
    );
  }

  const allowedRoots = await resolveAllowedProjectRoots(workspacesRoot);
  if (
    !allowedRoots.some((root) => isEqualOrDescendant(resolvedProject, root))
  ) {
    throw new ProjectPathError(
      "outside_workspace",
      "Project path must be inside the workspace root or an allowed system project",
    );
  }

  return resolvedProject;
}

export function projectPathErrorResponse(error: ProjectPathError): Response {
  const status =
    error.code === "missing" ? 400 : error.code === "not_found" ? 404 : 403;
  return Response.json({ error: error.message, code: error.code }, { status });
}
