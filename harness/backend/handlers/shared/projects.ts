import { Context } from "hono";
import type {
  ProjectInfo,
  ProjectsResponse,
  ProjectFeatures,
  ProjectFeatureKey,
} from "../../../shared/types.ts";
import { DEFAULT_PROJECT_FEATURES } from "../../../shared/types.ts";
import { getEncodedProjectName } from "../../history/pathUtils.ts";
import { logger } from "../../utils/logger.ts";
import { readDir } from "../../utils/fs.ts";
import type { AppConfig } from "../../types.ts";
import { existsSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { remoteControlManager } from "../../services/remote-control.ts";
import { previewService } from "../../services/previewService.ts";

const FEATURE_KEYS: ProjectFeatureKey[] = ["preview"];

function isFeatureKey(value: string): value is ProjectFeatureKey {
  return (FEATURE_KEYS as string[]).includes(value);
}

/**
 * Read the features block from .swarmfleet/settings.json. Missing file or missing
 * `features` key → all features disabled. Unknown feature keys in the file
 * are ignored. Known keys missing from the file default to disabled.
 */
export async function readProjectFeatures(
  projectPath: string,
): Promise<ProjectFeatures> {
  const features: ProjectFeatures = {
    preview: { enabled: false },
  };
  try {
    const raw = await readFile(
      join(projectPath, ".swarmfleet", "settings.json"),
      "utf-8",
    );
    const settings = JSON.parse(raw) as {
      features?: Partial<
        Record<
          string,
          {
            enabled?: unknown;
            command?: unknown;
            devServer?: {
              enabled?: unknown;
              publishToHost?: unknown;
              port?: unknown;
            };
          }
        >
      >;
    };
    const stored = settings.features;
    if (stored && typeof stored === "object") {
      for (const key of FEATURE_KEYS) {
        const entry = stored[key];
        if (entry && entry.enabled === true) {
          features[key] = { enabled: true };
        }
        if (
          key === "preview" &&
          entry &&
          typeof entry.command === "string" &&
          entry.command.trim()
        ) {
          features.preview.command = entry.command.trim();
        }
        if (key === "preview" && entry?.devServer) {
          features.preview.devServer = {
            enabled:
              entry.devServer.enabled === false
                ? false
                : features.preview.enabled,
            publishToHost: entry.devServer.publishToHost === true,
            port:
              typeof entry.devServer.port === "number" &&
              Number.isInteger(entry.devServer.port)
                ? entry.devServer.port
                : null,
          };
        }
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      logger.api.warn("Failed to read project features for {path}: {error}", {
        path: projectPath,
        error: err,
      });
    }
  }
  return features;
}

async function writeProjectFeatures(
  projectPath: string,
  features: ProjectFeatures,
): Promise<void> {
  const settingsDir = join(projectPath, ".swarmfleet");
  const settingsPath = join(settingsDir, "settings.json");

  let settings: Record<string, unknown> = {};
  try {
    const content = await readFile(settingsPath, "utf-8");
    settings = JSON.parse(content);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  settings.features = features;

  if (!existsSync(settingsDir)) {
    await mkdir(settingsDir, { recursive: true });
  }
  await writeFile(settingsPath, JSON.stringify(settings, null, 2), "utf-8");
}

/**
 * Discover projects by scanning top-level subdirectories of the workspace root.
 * Every immediate subdirectory is treated as a project.
 */
function getHarnessProject(): ProjectInfo | null {
  const harnessDir = process.env.SWARMFLEET_HARNESS_DIR;
  if (!harnessDir || !existsSync(harnessDir)) return null;

  return {
    name: "SwarmFleet Harness",
    path: harnessDir,
    encodedName: "__swarmfleet_harness",
    features: { ...DEFAULT_PROJECT_FEATURES },
    kind: "system",
    gitEnabled: false,
  };
}

async function discoverProjects(rootDir: string): Promise<ProjectInfo[]> {
  const projects: ProjectInfo[] = [];
  const harnessProject = getHarnessProject();
  if (harnessProject) projects.push(harnessProject);

  try {
    for await (const entry of readDir(rootDir)) {
      if (!entry.isDirectory) continue;
      if (entry.name.startsWith(".")) continue;
      if (entry.name === "node_modules") continue;

      const subdir = join(rootDir, entry.name);
      const name = entry.name;
      const encodedName = (await getEncodedProjectName(subdir)) || name;
      const features = await readProjectFeatures(subdir);
      if (features.preview.enabled) {
        void previewService.start(subdir).catch((error) => {
          logger.api.warn("Failed to start preview for {path}: {error}", {
            path: subdir,
            error,
          });
        });
      }

      projects.push({ name, path: subdir, encodedName, features });
    }
  } catch (e) {
    logger.api.warn("Failed to scan workspace directory: {error}", {
      error: e,
    });
  }

  return projects;
}

/**
 * Handles GET /api/projects requests
 * Discovers projects as top-level directories inside the workspace root
 * (SWARMFLEET_WORKSPACE env var or --workspaces-root CLI flag).
 */
export async function handleProjectsRequest(c: Context) {
  try {
    const config = c.get("config") as AppConfig | undefined;
    const workspacesRoot = config?.workspacesRoot;

    if (!workspacesRoot) {
      logger.api.warn(
        "No workspace root configured (set SWARMFLEET_WORKSPACE or --workspaces-root)",
      );
      return c.json({ projects: [] } satisfies ProjectsResponse);
    }

    if (!existsSync(workspacesRoot)) {
      logger.api.warn("Workspace root does not exist: {path}", {
        path: workspacesRoot,
      });
      return c.json({ projects: [] } satisfies ProjectsResponse);
    }

    const projects = await discoverProjects(workspacesRoot);

    const response: ProjectsResponse = { projects };
    return c.json(response);
  } catch (error) {
    logger.api.error("Error reading projects: {error}", { error });
    return c.json({ error: "Failed to read projects" }, 500);
  }
}

/**
 * Destructive reset of feature-owned on-disk state. Chat sessionManager
 * history is NOT touched — only filesystem state the feature created.
 */
async function resetFeatureData(
  projectPath: string,
  feature: ProjectFeatureKey,
): Promise<void> {
  switch (feature) {
    case "preview":
      {
        const settingsPath = join(projectPath, ".swarmfleet", "settings.json");
        try {
          const raw = await readFile(settingsPath, "utf-8");
          const settings = JSON.parse(raw) as {
            features?: {
              preview?: Record<string, unknown>;
            };
          };
          if (settings.features?.preview) {
            delete settings.features.preview.devServer;
            await writeFile(
              settingsPath,
              JSON.stringify(settings, null, 2),
              "utf-8",
            );
          }
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        }
      }
      return;
  }
}

/**
 * Handles PATCH /api/projects/features
 * Body: { projectPath, feature, enabled }.
 * Applies per-feature side effects.
 */
export async function handleSetProjectFeatureRequest(c: Context) {
  try {
    const body = await c.req.json<{
      projectPath: string;
      feature: string;
      enabled: boolean;
    }>();
    const { projectPath, feature, enabled } = body;

    if (!projectPath || !feature || typeof enabled !== "boolean") {
      return c.json(
        { error: "projectPath, feature, and enabled (boolean) are required" },
        400,
      );
    }

    if (!isFeatureKey(feature)) {
      return c.json(
        { error: `feature must be one of: ${FEATURE_KEYS.join(", ")}` },
        400,
      );
    }

    if (!existsSync(projectPath)) {
      return c.json({ error: "Project path does not exist" }, 404);
    }

    const features = await readProjectFeatures(projectPath);
    const wasEnabled = features[feature].enabled;
    features[feature] = { ...features[feature], enabled };
    await writeProjectFeatures(projectPath, features);

    if (enabled && !wasEnabled) {
      try {
        if (feature === "preview") await previewService.start(projectPath);
      } catch (error) {
        logger.api.error(
          "Failed to apply enable side-effects for {feature} on {path}: {error}",
          { feature, path: projectPath, error },
        );
      }
    } else if (!enabled) {
      try {
        if (feature === "preview") await previewService.stop(projectPath);
      } catch (error) {
        logger.api.error(
          "Failed to apply disable side-effects for {feature} on {path}: {error}",
          { feature, path: projectPath, error },
        );
      }
    }

    logger.api.info("Feature {feature} {state} for {path}", {
      feature,
      state: enabled ? "enabled" : "disabled",
      path: projectPath,
    });
    return c.json({ ok: true, features });
  } catch (error) {
    logger.api.error("Error setting project feature: {error}", { error });
    return c.json({ error: "Failed to set project feature" }, 500);
  }
}

/**
 * Handles POST /api/projects/features/reset
 * Body: { projectPath, feature }. Destructive — wipes feature-owned on-disk state.
 * Does not modify the enabled flag; caller should disable separately if desired.
 */
export async function handleResetProjectFeatureRequest(c: Context) {
  try {
    const body = await c.req.json<{ projectPath: string; feature: string }>();
    const { projectPath, feature } = body;

    if (!projectPath || !feature) {
      return c.json({ error: "projectPath and feature are required" }, 400);
    }

    if (!isFeatureKey(feature)) {
      return c.json(
        { error: `feature must be one of: ${FEATURE_KEYS.join(", ")}` },
        400,
      );
    }

    if (!existsSync(projectPath)) {
      return c.json({ error: "Project path does not exist" }, 404);
    }

    await resetFeatureData(projectPath, feature);

    logger.api.info("Reset feature data: {feature} on {path}", {
      feature,
      path: projectPath,
    });
    return c.json({ ok: true });
  } catch (error) {
    logger.api.error("Error resetting project feature: {error}", { error });
    return c.json({ error: "Failed to reset project feature" }, 500);
  }
}

/**
 * Handles POST /api/projects/create
 * Creates a new project directory in the workspace root.
 */
export async function handleCreateProjectRequest(c: Context) {
  try {
    const config = c.get("config") as AppConfig | undefined;
    const workspacesRoot = config?.workspacesRoot;

    if (!workspacesRoot) {
      return c.json({ error: "No workspace root configured" }, 400);
    }

    const body = await c.req.json<{ name: string }>();
    const { name } = body;

    if (!name || typeof name !== "string") {
      return c.json({ error: "name is required" }, 400);
    }

    // Sanitize name: only allow alphanumeric, dash, underscore, dot
    const sanitized = name
      .replace(/[^a-zA-Z0-9_.-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
    if (!sanitized) {
      return c.json({ error: "Invalid project name" }, 400);
    }

    const projectPath = join(workspacesRoot, sanitized);

    if (existsSync(projectPath)) {
      return c.json({ error: "Project already exists" }, 409);
    }

    await mkdir(projectPath, { recursive: true });

    // Initialize git repo
    await new Promise<void>((resolve, reject) => {
      execFile("git", ["init", projectPath], (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    const encodedName = (await getEncodedProjectName(projectPath)) || sanitized;

    const project: ProjectInfo = {
      name: sanitized,
      path: projectPath,
      encodedName,
      features: { ...DEFAULT_PROJECT_FEATURES },
    };

    logger.api.info("Created project {name} at {path}", {
      name: sanitized,
      path: projectPath,
    });
    return c.json({ ok: true, project });
  } catch (error) {
    logger.api.error("Error creating project: {error}", { error });
    return c.json({ error: "Failed to create project" }, 500);
  }
}

/**
 * Handles PATCH /api/remote-control
 * Toggles the Claude remote-control process for a project.
 */
export async function handleRemoteControlToggle(c: Context) {
  try {
    const config = c.get("config") as AppConfig | undefined;
    const body = await c.req.json<{ projectPath: string; enabled: boolean }>();
    const { projectPath, enabled } = body;

    if (!projectPath || typeof enabled !== "boolean") {
      return c.json(
        { error: "projectPath and enabled (boolean) are required" },
        400,
      );
    }

    if (!existsSync(projectPath)) {
      return c.json({ error: "Project path does not exist" }, 404);
    }

    // Persist to .swarmfleet/settings.json
    const settingsDir = join(projectPath, ".swarmfleet");
    const settingsPath = join(settingsDir, "settings.json");

    let settings: Record<string, unknown> = {};
    try {
      const content = await readFile(settingsPath, "utf-8");
      settings = JSON.parse(content);
    } catch {
      // File doesn't exist or invalid — start fresh
    }

    settings.remoteControl = enabled;

    if (!existsSync(settingsDir)) {
      await mkdir(settingsDir, { recursive: true });
    }
    await writeFile(settingsPath, JSON.stringify(settings, null, 2), "utf-8");

    const cliPath = config?.cliPath || "claude";

    if (enabled) {
      remoteControlManager.start(projectPath, cliPath);
      logger.api.info("Enabled remote-control for {path}", {
        path: projectPath,
      });
    } else {
      remoteControlManager.stop(projectPath);
      logger.api.info("Disabled remote-control for {path}", {
        path: projectPath,
      });
    }

    return c.json({ ok: true, enabled });
  } catch (error) {
    logger.api.error("Error toggling remote-control: {error}", { error });
    return c.json({ error: "Failed to toggle remote-control" }, 500);
  }
}

/**
 * Handles GET /api/remote-control/status
 * Returns the current remote-control status for a project.
 */
export async function handleRemoteControlStatus(c: Context) {
  try {
    const projectPath = c.req.query("project");
    if (!projectPath) {
      return c.json({ error: "project query param is required" }, 400);
    }

    // Read persisted setting
    let enabled = false;
    try {
      const settingsPath = join(projectPath, ".swarmfleet", "settings.json");
      const content = await readFile(settingsPath, "utf-8");
      const settings = JSON.parse(content);
      enabled = settings.remoteControl === true;
    } catch {
      // no settings — default disabled
    }

    const liveStatus = remoteControlManager.getStatus(projectPath);

    return c.json({
      enabled,
      running: liveStatus.running,
      pid: liveStatus.pid,
      startedAt: liveStatus.startedAt,
      url: liveStatus.url,
    });
  } catch (error) {
    logger.api.error("Error checking remote-control status: {error}", {
      error,
    });
    return c.json({ error: "Failed to check remote-control status" }, 500);
  }
}
