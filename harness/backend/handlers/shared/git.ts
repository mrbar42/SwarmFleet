import type { Context } from "hono";
import type { ConfigContext } from "../../middleware/config.ts";
import { execFile } from "child_process";
import { promisify } from "util";
import { resolve } from "path";

const execFileAsync = promisify(execFile);

function getWorkspacesRoot(c: Context): string {
  const config = c.get("config" as never) as { workspacesRoot?: string } | undefined;
  return config?.workspacesRoot || process.env.WORKSPACES_ROOT || process.cwd();
}

function allowedRoots(workspacesRoot: string): string[] {
  return [workspacesRoot, process.env.SWARMFLEET_HARNESS_DIR].filter(
    (value): value is string => Boolean(value),
  );
}

function validateProjectPath(projectPath: string, root: string): string | null {
  const resolved = resolve(projectPath);
  for (const allowedRoot of allowedRoots(root)) {
    const resolvedRoot = resolve(allowedRoot);
    if (resolved === resolvedRoot || resolved.startsWith(resolvedRoot + "/")) return resolved;
  }
  return null;
}

async function git(
  cwd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("git", args, {
    cwd,
    maxBuffer: 10 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
}

async function ensureGitRepository(cwd: string): Promise<void> {
  try {
    await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  } catch {
    await git(cwd, ["init"]);
  }
}

export interface GitStatusFile {
  path: string;
  status: string;
  staged: boolean;
}

export interface GitStatusResult {
  branch: string;
  ahead: number;
  behind: number;
  files: GitStatusFile[];
  hasConflicts: boolean;
  conflictFiles: string[];
}

function parseStatusLine(line: string): GitStatusFile[] {
  const files: GitStatusFile[] = [];
  if (line.length < 4) return files;

  const staged = line[0];
  const unstaged = line[1];
  const path = line.slice(3);

  if (staged !== " " && staged !== "?") {
    files.push({ path, status: staged, staged: true });
  }
  if (unstaged !== " " && unstaged !== "?") {
    files.push({ path, status: unstaged, staged: false });
  }
  if (staged === "?" && unstaged === "?") {
    files.push({ path, status: "?", staged: false });
  }
  if (staged === "U" || unstaged === "U" || (staged === "A" && unstaged === "A") || (staged === "D" && unstaged === "D")) {
    files.push({ path, status: "U", staged: false });
  }

  return files;
}

export function registerGitRoutes(
  app: import("hono").Hono<ConfigContext>,
): void {
  // Git status
  app.get("/api/git/status", async (c: Context) => {
    const wsRoot = getWorkspacesRoot(c);
    const project = c.req.query("project") || wsRoot;
    const validated = validateProjectPath(project, wsRoot);
    if (!validated) return c.json({ error: "Path outside workspace" }, 403);

    try {
      await ensureGitRepository(validated);

      const [statusResult, branchResult] = await Promise.all([
        git(validated, ["status", "--porcelain=v1", "-uall"]),
        git(validated, ["status", "--branch", "--porcelain=v1"]),
      ]);

      const branchLine = branchResult.stdout.split("\n")[0] || "";
      const initialBranchMatch = branchLine.match(
        /^## (?:No commits yet on|Initial commit on) (.+)$/,
      );
      const branchMatch = branchLine.match(/^## (.+?)(?:\.\.\..+)?$/);
      const branch = initialBranchMatch?.[1] ?? branchMatch?.[1] ?? "unknown";

      const aheadMatch = branchLine.match(/ahead (\d+)/);
      const behindMatch = branchLine.match(/behind (\d+)/);

      const allFiles: GitStatusFile[] = [];
      const conflictFiles: string[] = [];

      for (const line of statusResult.stdout.split("\n")) {
        if (!line) continue;
        const files = parseStatusLine(line);
        for (const f of files) {
          if (f.status === "U") {
            if (!conflictFiles.includes(f.path)) conflictFiles.push(f.path);
          } else {
            allFiles.push(f);
          }
        }
      }

      const seen = new Set<string>();
      const dedupedFiles = allFiles.filter((f) => {
        const key = `${f.path}:${f.staged}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      const result: GitStatusResult = {
        branch,
        ahead: aheadMatch ? parseInt(aheadMatch[1]) : 0,
        behind: behindMatch ? parseInt(behindMatch[1]) : 0,
        files: dedupedFiles,
        hasConflicts: conflictFiles.length > 0,
        conflictFiles,
      };

      return c.json(result);
    } catch (e) {
      return c.json(
        { error: `Git status failed: ${e instanceof Error ? e.message : e}` },
        500,
      );
    }
  });

  // Git diff for a file
  app.get("/api/git/diff", async (c: Context) => {
    const wsRoot = getWorkspacesRoot(c);
    const project = c.req.query("project") || wsRoot;
    const file = c.req.query("file");
    const staged = c.req.query("staged") === "true";
    const validated = validateProjectPath(project, wsRoot);
    if (!validated) return c.json({ error: "Path outside workspace" }, 403);

    try {
      const args = ["diff"];
      if (staged) args.push("--cached");
      if (file) args.push("--", file);
      const result = await git(validated, args);
      return c.json({ diff: result.stdout });
    } catch (e) {
      return c.json(
        { error: `Git diff failed: ${e instanceof Error ? e.message : e}` },
        500,
      );
    }
  });

  // Git log
  app.get("/api/git/log", async (c: Context) => {
    const wsRoot = getWorkspacesRoot(c);
    const project = c.req.query("project") || wsRoot;
    const limit = parseInt(c.req.query("limit") || "20");
    const validated = validateProjectPath(project, wsRoot);
    if (!validated) return c.json({ error: "Path outside workspace" }, 403);

    try {
      const result = await git(validated, [
        "log",
        `--max-count=${limit}`,
        "--format=%H%n%h%n%an%n%ae%n%s%n%aI%n---",
      ]);

      const commits = result.stdout
        .split("---\n")
        .filter(Boolean)
        .map((block) => {
          const [hash, shortHash, author, email, message, date] =
            block.trim().split("\n");
          return { hash, shortHash, author, email, message, date };
        });

      return c.json({ commits });
    } catch (e) {
      return c.json(
        { error: `Git log failed: ${e instanceof Error ? e.message : e}` },
        500,
      );
    }
  });

  // Git actions
  app.post("/api/git/action", async (c: Context) => {
    const body = await c.req.json<{
      project?: string;
      action: string;
      files?: string[];
      message?: string;
      branch?: string;
    }>();

    const wsRoot = getWorkspacesRoot(c);
    const project = body.project || wsRoot;
    const validated = validateProjectPath(project, wsRoot);
    if (!validated) return c.json({ error: "Path outside workspace" }, 403);

    try {
      let result: { stdout: string; stderr: string };

      switch (body.action) {
        case "stage":
          if (!body.files?.length) return c.json({ error: "No files specified" }, 400);
          result = await git(validated, ["add", ...body.files]);
          break;

        case "stage-all":
          result = await git(validated, ["add", "-A"]);
          break;

        case "unstage":
          if (!body.files?.length) return c.json({ error: "No files specified" }, 400);
          result = await git(validated, ["reset", "HEAD", "--", ...body.files]);
          break;

        case "unstage-all":
          result = await git(validated, ["reset", "HEAD"]);
          break;

        case "discard":
          if (!body.files?.length) return c.json({ error: "No files specified" }, 400);
          result = await git(validated, ["checkout", "--", ...body.files]);
          break;

        case "commit":
          if (!body.message) return c.json({ error: "No commit message" }, 400);
          result = await git(validated, ["commit", "-m", body.message]);
          break;

        case "push":
          result = await git(validated, ["push"]);
          break;

        case "pull":
          result = await git(validated, ["pull", "--rebase"]);
          break;

        case "checkout":
          if (!body.branch) return c.json({ error: "No branch specified" }, 400);
          result = await git(validated, ["checkout", body.branch]);
          break;

        case "resolve-accept-ours":
          if (!body.files?.length) return c.json({ error: "No files specified" }, 400);
          await git(validated, ["checkout", "--ours", "--", ...body.files]);
          result = await git(validated, ["add", ...body.files]);
          break;

        case "resolve-accept-theirs":
          if (!body.files?.length) return c.json({ error: "No files specified" }, 400);
          await git(validated, ["checkout", "--theirs", "--", ...body.files]);
          result = await git(validated, ["add", ...body.files]);
          break;

        case "resolve-mark-resolved":
          if (!body.files?.length) return c.json({ error: "No files specified" }, 400);
          result = await git(validated, ["add", ...body.files]);
          break;

        default:
          return c.json({ error: `Unknown action: ${body.action}` }, 400);
      }

      return c.json({ ok: true, stdout: result.stdout, stderr: result.stderr });
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; message?: string };
      return c.json(
        {
          error: err.stderr || err.message || "Git action failed",
          stdout: err.stdout,
        },
        500,
      );
    }
  });

  // List remotes
  app.get("/api/git/remotes", async (c: Context) => {
    const wsRoot = getWorkspacesRoot(c);
    const project = c.req.query("project") || wsRoot;
    const validated = validateProjectPath(project, wsRoot);
    if (!validated) return c.json({ error: "Path outside workspace" }, 403);

    try {
      const result = await git(validated, ["remote", "-v"]);
      const remotes: { name: string; url: string; type: string }[] = [];
      const seen = new Set<string>();
      for (const line of result.stdout.split("\n")) {
        if (!line.trim()) continue;
        const match = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)/);
        if (match) {
          const key = `${match[1]}:${match[3]}`;
          if (!seen.has(key)) {
            seen.add(key);
            remotes.push({ name: match[1], url: match[2], type: match[3] });
          }
        }
      }
      return c.json({ remotes, hasRemote: remotes.length > 0 });
    } catch (e) {
      return c.json(
        { error: `Failed to list remotes: ${e instanceof Error ? e.message : e}` },
        500,
      );
    }
  });

  // List branches
  app.get("/api/git/branches", async (c: Context) => {
    const wsRoot = getWorkspacesRoot(c);
    const project = c.req.query("project") || wsRoot;
    const validated = validateProjectPath(project, wsRoot);
    if (!validated) return c.json({ error: "Path outside workspace" }, 403);

    try {
      const result = await git(validated, [
        "branch",
        "-a",
        "--format=%(refname:short)%09%(objectname:short)%09%(HEAD)",
      ]);

      const branches = result.stdout
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [name, hash, head] = line.split("\t");
          return { name, hash, current: head === "*" };
        });

      return c.json({ branches });
    } catch (e) {
      return c.json(
        { error: `Failed to list branches: ${e instanceof Error ? e.message : e}` },
        500,
      );
    }
  });
}
