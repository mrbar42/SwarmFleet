import type { Context } from "hono";
import type { ConfigContext } from "../../middleware/config.ts";
import { readdir, readFile, writeFile, stat, realpath, mkdir } from "fs/promises";
import { resolve, join, relative, extname, dirname } from "path";

function getWorkspacesRoot(c: Context): string {
  const config = c.get("config" as never) as { workspacesRoot?: string } | undefined;
  return config?.workspacesRoot || process.env.WORKSPACES_ROOT || process.cwd();
}

interface ValidatedPath {
  path: string;
  root: string;
}

function allowedRoots(workspacesRoot: string): string[] {
  return [workspacesRoot, process.env.SWARMFLEET_HARNESS_DIR].filter(
    (value): value is string => Boolean(value),
  );
}

async function validatePath(
  requestedPath: string,
  root: string,
): Promise<ValidatedPath | null> {
  try {
    const resolved = await realpath(resolve(requestedPath));
    for (const allowedRoot of allowedRoots(root)) {
      try {
        const resolvedRoot = await realpath(resolve(allowedRoot));
        if (resolved === resolvedRoot || resolved.startsWith(resolvedRoot + "/")) {
          return { path: resolved, root: resolvedRoot };
        }
      } catch {
        // Ignore missing optional roots, e.g. harness dir outside container.
      }
    }
    return null;
  } catch {
    return null;
  }
}

function resolveWorkspacePath(requestedPath: string, root: string): string {
  return requestedPath.startsWith("/") ? requestedPath : join(root, requestedPath);
}

function entryPath(fullPath: string, validatedRoot: string, workspaceRoot: string): string {
  return validatedRoot === workspaceRoot ? relative(workspaceRoot, fullPath) : fullPath;
}

interface TreeEntry {
  name: string;
  path: string;
  type: "file" | "directory";
  size?: number;
}

export function registerFileRoutes(
  app: import("hono").Hono<ConfigContext>,
): void {
  // List directory contents
  app.get("/api/files/tree", async (c: Context) => {
    const wsRoot = getWorkspacesRoot(c);
    const dirPath = (c.req.query("path") || wsRoot).replace(/\/$/, "");
    const candidate = resolveWorkspacePath(dirPath, wsRoot);
    const validated = await validatePath(candidate, wsRoot);
    if (!validated) return c.json({ error: "Path outside workspace" }, 403);

    try {
      const entries = await readdir(validated.path, { withFileTypes: true });
      const result: TreeEntry[] = [];

      for (const entry of entries) {
        if (entry.name.startsWith(".") && entry.name !== ".env") continue;
        if (entry.name === "node_modules") continue;

        const fullPath = join(validated.path, entry.name);
        const relativePath = entryPath(fullPath, validated.root, wsRoot);

        if (entry.isDirectory()) {
          result.push({ name: entry.name, path: relativePath, type: "directory" });
        } else if (entry.isFile()) {
          try {
            const s = await stat(fullPath);
            result.push({
              name: entry.name,
              path: relativePath,
              type: "file",
              size: s.size,
            });
          } catch {
            result.push({ name: entry.name, path: relativePath, type: "file" });
          }
        }
      }

      result.sort((a, b) => {
        if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

      return c.json({
        entries: result,
        path: validated.root === wsRoot ? relative(wsRoot, validated.path) || "." : validated.path,
      });
    } catch (e) {
      return c.json(
        { error: `Failed to read directory: ${e instanceof Error ? e.message : e}` },
        500,
      );
    }
  });

  // Read file content
  app.get("/api/files/read", async (c: Context) => {
    const wsRoot = getWorkspacesRoot(c);
    const filePath = c.req.query("path");
    if (!filePath) return c.json({ error: "Missing path" }, 400);

    // Try as absolute path first (tool calls store absolute paths), then relative
    const candidate = resolveWorkspacePath(filePath, wsRoot);
    const validated = await validatePath(candidate, wsRoot);
    if (!validated) return c.json({ error: "Path outside workspace" }, 403);

    try {
      const s = await stat(validated.path);
      if (!s.isFile()) return c.json({ error: "Not a file" }, 400);

      if (s.size > 2 * 1024 * 1024) {
        return c.json({ error: "File too large (>2MB)" }, 413);
      }

      const content = await readFile(validated.path, "utf8");
      const ext = extname(validated.path).slice(1);

      return c.json({ content, path: filePath, size: s.size, extension: ext });
    } catch (e) {
      return c.json(
        { error: `Failed to read file: ${e instanceof Error ? e.message : e}` },
        500,
      );
    }
  });

  // Write file content
  app.post("/api/files/write", async (c: Context) => {
    const wsRoot = getWorkspacesRoot(c);
    const body = await c.req.json<{ path: string; content: string }>();
    if (!body.path || body.content === undefined) {
      return c.json({ error: "Missing path or content" }, 400);
    }

    const candidate = resolveWorkspacePath(body.path, wsRoot);

    // Try to validate as existing file; if it doesn't exist, validate parent dir instead
    let target: string | null = null;
    const existingTarget = await validatePath(candidate, wsRoot);
    if (existingTarget) target = existingTarget.path;
    if (!target) {
      // File might not exist yet — validate the parent dir is inside wsRoot
      const parent = dirname(candidate);
      const parentValidated = await validatePath(parent, wsRoot);
      if (!parentValidated) return c.json({ error: "Path outside workspace" }, 403);
      // Compute the target as parentValidated + basename
      target = join(parentValidated.path, candidate.slice(parent.length + 1));
    }

    try {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, body.content, "utf8");
      return c.json({ ok: true, path: body.path });
    } catch (e) {
      return c.json(
        { error: `Failed to write file: ${e instanceof Error ? e.message : e}` },
        500,
      );
    }
  });

  // Create directory
  app.post("/api/files/mkdir", async (c: Context) => {
    const wsRoot = getWorkspacesRoot(c);
    const body = await c.req.json<{ path: string }>();
    if (!body.path) {
      return c.json({ error: "Missing path" }, 400);
    }

    const candidate = resolveWorkspacePath(body.path, wsRoot);

    // The new directory doesn't exist yet — validate the parent
    const parent = dirname(candidate);
    const parentValidated = await validatePath(parent, wsRoot);
    if (!parentValidated) return c.json({ error: "Path outside workspace" }, 403);

    const target = join(parentValidated.path, candidate.slice(parent.length + 1));

    try {
      await mkdir(target, { recursive: false });
      return c.json({ ok: true, path: body.path });
    } catch (e) {
      return c.json(
        { error: `Failed to create directory: ${e instanceof Error ? e.message : e}` },
        500,
      );
    }
  });

  // Search files by name (fuzzy)
  app.get("/api/files/search", async (c: Context) => {
    const wsRoot = getWorkspacesRoot(c);
    const query = c.req.query("q");
    if (!query || query.length < 2) return c.json({ results: [] });

    try {
      const results: Array<{ name: string; path: string }> = [];
      const lowerQuery = query.toLowerCase();

      async function walk(dir: string, depth: number) {
        if (depth > 8 || results.length >= 50) return;
        const entries = await readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (results.length >= 50) break;
          if (entry.name.startsWith(".") || entry.name === "node_modules") continue;

          const fullPath = join(dir, entry.name);
          const relPath = relative(wsRoot, fullPath);

          if (entry.name.toLowerCase().includes(lowerQuery)) {
            results.push({ name: entry.name, path: relPath });
          }
          if (entry.isDirectory()) {
            await walk(fullPath, depth + 1);
          }
        }
      }

      await walk(wsRoot, 0);
      return c.json({ results });
    } catch (e) {
      return c.json(
        { error: `Search failed: ${e instanceof Error ? e.message : e}` },
        500,
      );
    }
  });
}
