/**
 * Runtime-agnostic Hono application for SwarmFleet
 *
 * Registers all routes:
 * - Shared routes: projects, chat, abort, files, git, terminal
 * - Static file serving with SPA fallback
 */

import { existsSync } from "node:fs";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Runtime } from "./runtime/types.ts";
import {
  type ConfigContext,
  createConfigMiddleware,
} from "./middleware/config.ts";
import { requireAuth } from "./middleware/requireAuth.ts";
import authRoutes from "./handlers/auth/index.ts";
import { bootstrapFirstDevice } from "./handlers/auth/bootstrap.ts";
import {
  handleProjectsRequest,
  handleSetProjectFeatureRequest,
  handleResetProjectFeatureRequest,
  handleCreateProjectRequest,
  handleRemoteControlToggle,
  handleRemoteControlStatus,
} from "./handlers/shared/projects.ts";
import {
  handleCreateOpenRouterClaudeProfile,
  handleCreatePiProviderProfile,
  handleDeleteOpenRouterClaudeProfile,
  handleDeletePiProviderProfile,
  handleProviderCatalogRequest,
  handleProviderSettingsRequest,
  handleProvidersStatusRequest,
  handleTestTelegramProviderSettingsRequest,
  handleUpdateOpenRouterClaudeProfile,
  handleUpdatePiProviderProfile,
  handleUpdateProviderSettingsRequest,
} from "./handlers/shared/providers.ts";
import {
  handleToolsConfigRequest,
  handleToolsStatusRequest,
  handleToolsUpdateNowRequest,
  handleUpdateToolsConfigRequest,
} from "./handlers/shared/tools.ts";
import {
  handleUpdateUserPreferencesRequest,
  handleUserPreferencesRequest,
} from "./handlers/shared/preferences.ts";
import { remoteControlManager } from "./services/remote-control.ts";
import {
  handleHistoriesRequest,
  handleArchiveSessionRequest,
  handleRenameSessionRequest,
} from "./handlers/shared/histories.ts";
import { handleConversationRequest } from "./handlers/shared/conversations.ts";
import { handleChatRequest } from "./handlers/shared/chat.ts";
import { handleAbortRequest } from "./handlers/shared/abort.ts";
import { registerSessionRoutes } from "./handlers/shared/sessions.ts";
import {
  handleCreateLoop,
  handleListLoops,
  handleGetLoop,
  handleUpdateLoop,
  handlePlayLoop,
  handlePauseLoop,
  handleDeleteLoop,
} from "./handlers/shared/loops.ts";
import {
  registerInternalSubagentRoutes,
  getInternalSubagentToken,
} from "./handlers/internal/subagents.ts";
import { registerOpenRouterClaudeProxyRoutes } from "./handlers/internal/openRouterClaudeProxy.ts";
import { registerFileRoutes } from "./handlers/shared/files.ts";
import { registerGitRoutes } from "./handlers/shared/git.ts";
import { registerPreviewRoutes } from "./handlers/shared/preview.ts";
import {
  registerTerminalRoutes,
  shutdownAllSessions,
} from "./handlers/shared/terminal.ts";
import { sessionManager } from "./services/sessionManager.ts";
import { sessionStatusWatcher } from "./services/sessionStatusWatcher.ts";
import { wakeScheduler } from "./services/wakeScheduler.ts";
import { loopController } from "./services/loopController.ts";
import { previewService } from "./services/previewService.ts";
import { logger } from "./utils/logger.ts";
import { readBinaryFile } from "./utils/fs.ts";
import { getServerConfig } from "./services/globalConfig.ts";

export interface AppConfig {
  debugMode: boolean;
  staticPath: string;
  cliPath: string;
  workspacesRoot?: string;
  /** Loopback URL the MCP subagent server uses to call back into us. */
  backendUrl?: string;
}

export function createApp(
  runtime: Runtime,
  config: AppConfig,
): Hono<ConfigContext> {
  const app = new Hono<ConfigContext>();
  sessionManager.configure({
    cliPath: config.cliPath,
    backendUrl: config.backendUrl,
  });
  void sessionManager.ensureInitialized().catch((error) => {
    logger.app.warn("Failed to initialize canonical chat sessions: {error}", {
      error,
    });
  });
  // Kicks off the poller that watches detached runners for status
  // transitions so every connected sidebar can react (spinner on/off,
  // unread badge) without the user opening the session first.
  void sessionManager.startStatusWatcher().catch((error) => {
    logger.app.warn("Failed to start session status watcher: {error}", {
      error,
    });
  });
  wakeScheduler.start();
  loopController.start();

  // Do not kill tagged chat processes on backend startup. A bad or stale
  // session index would turn a harmless backend restart into a bulk session
  // abort, and detached runners are intentionally allowed to outlive the
  // backend so they can keep streaming into the canonical store.

  // CORS middleware: only reflect configured SwarmFleet origins. Do not use
  // wildcard CORS because authenticated browser contexts can reach sensitive
  // local-agent APIs.
  app.use("*", async (c, next) => {
    const requestOrigin = c.req.header("Origin");
    if (requestOrigin) {
      const cfg = await getServerConfig();
      const allowedOrigins = new Set(cfg.origins.map((origin) => origin.origin));
      if (allowedOrigins.has(requestOrigin)) {
        c.header("Access-Control-Allow-Origin", requestOrigin);
        c.header("Access-Control-Allow-Credentials", "true");
        c.header("Vary", "Origin");
      }
    }
    c.header("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
    c.header(
      "Access-Control-Allow-Headers",
      "Content-Type,Authorization,X-Internal-Subagent-Token",
    );
    if (c.req.method === "OPTIONS") {
      return c.body(null, requestOrigin ? 204 : 403);
    }
    await next();
  });

  // Body size limit - increased to support base64 image attachments
  app.use(
    "*",
    bodyLimit({
      maxSize: 30 * 1024 * 1024, // 30MB
    }),
  );

  // Configuration middleware
  app.use(
    "*",
    createConfigMiddleware({
      debugMode: config.debugMode,
      runtime,
      cliPath: config.cliPath,
      workspacesRoot: config.workspacesRoot,
    }),
  );

  app.route("/auth", authRoutes);
  app.use("/api/*", requireAuth);

  // --- Shared API routes ---
  app.get("/api/projects", (c) => handleProjectsRequest(c));
  app.patch("/api/projects/features", (c) => handleSetProjectFeatureRequest(c));
  app.post("/api/projects/features/reset", (c) =>
    handleResetProjectFeatureRequest(c),
  );
  app.post("/api/projects/create", (c) => handleCreateProjectRequest(c));
  app.get("/api/providers/status", (c) => handleProvidersStatusRequest(c));
  app.get("/api/providers/catalog", (c) => handleProviderCatalogRequest(c));
  app.get("/api/providers/settings", (c) => handleProviderSettingsRequest(c));
  app.patch("/api/providers/settings", (c) =>
    handleUpdateProviderSettingsRequest(c),
  );
  app.post("/api/providers/settings/telegram/test", (c) =>
    handleTestTelegramProviderSettingsRequest(c),
  );
  app.get("/api/preferences", (c) => handleUserPreferencesRequest(c));
  app.patch("/api/preferences", (c) => handleUpdateUserPreferencesRequest(c));
  app.get("/api/tools/status", (c) => handleToolsStatusRequest(c));
  app.get("/api/tools/config", (c) => handleToolsConfigRequest(c));
  app.patch("/api/tools/config", (c) => handleUpdateToolsConfigRequest(c));
  app.post("/api/tools/update", (c) => handleToolsUpdateNowRequest(c));
  app.post("/api/providers/pi-profiles", (c) =>
    handleCreatePiProviderProfile(c),
  );
  app.patch("/api/providers/pi-profiles/:id", (c) =>
    handleUpdatePiProviderProfile(c),
  );
  app.delete("/api/providers/pi-profiles/:id", (c) =>
    handleDeletePiProviderProfile(c),
  );
  app.post("/api/providers/openrouter-claude-profiles", (c) =>
    handleCreateOpenRouterClaudeProfile(c),
  );
  app.patch("/api/providers/openrouter-claude-profiles/:id", (c) =>
    handleUpdateOpenRouterClaudeProfile(c),
  );
  app.delete("/api/providers/openrouter-claude-profiles/:id", (c) =>
    handleDeleteOpenRouterClaudeProfile(c),
  );
  app.patch("/api/remote-control", (c) => handleRemoteControlToggle(c));
  app.get("/api/remote-control/status", (c) => handleRemoteControlStatus(c));

  app.post("/api/loops", (c) => handleCreateLoop(c));
  app.get("/api/loops", (c) => handleListLoops(c));
  app.get("/api/loops/:loopId", (c) => handleGetLoop(c));
  app.patch("/api/loops/:loopId", (c) => handleUpdateLoop(c));
  app.post("/api/loops/:loopId/play", (c) => handlePlayLoop(c));
  app.post("/api/loops/:loopId/pause", (c) => handlePauseLoop(c));
  app.delete("/api/loops/:loopId", (c) => handleDeleteLoop(c));

  app.get("/api/projects/:encodedProjectName/histories", (c) =>
    handleHistoriesRequest(c),
  );

  app.get("/api/projects/:encodedProjectName/histories/:sessionId", (c) =>
    handleConversationRequest(c),
  );

  app.post(
    "/api/projects/:encodedProjectName/histories/:sessionId/archive",
    (c) => handleArchiveSessionRequest(c),
  );

  app.post(
    "/api/projects/:encodedProjectName/histories/:sessionId/rename",
    (c) => handleRenameSessionRequest(c),
  );

  registerSessionRoutes(app);
  // Initialize the internal token + register loopback subagent routes. The
  // token is generated lazily on first read; getting it here ensures the env
  // var is set before the Claude CLI subprocess inherits it.
  getInternalSubagentToken();
  registerInternalSubagentRoutes(app);
  registerOpenRouterClaudeProxyRoutes(app);
  app.post("/api/abort/:requestId", (c) => handleAbortRequest(c));
  app.post("/api/chat", (c) => handleChatRequest(c));

  // --- File browser, Git, and Terminal API routes ---
  registerFileRoutes(app);
  registerGitRoutes(app);
  registerTerminalRoutes(app);
  registerPreviewRoutes(app);

  // --- Static file serving with SPA fallback ---
  // Skip in dev mode (Vite serves the frontend, staticPath won't exist)
  if (existsSync(config.staticPath)) {
    const serveStatic = runtime.createStaticFileMiddleware({
      root: config.staticPath,
    });
    app.use("/assets/*", serveStatic);
    app.use("/*", serveStatic);
  }

  // SPA fallback
  app.get("*", async (c) => {
    const path = c.req.path;

    if (path.startsWith("/api/")) {
      return c.text("Not found", 404);
    }

    try {
      const indexPath = `${config.staticPath}/index.html`;
      const indexFile = await readBinaryFile(indexPath);
      return c.html(new TextDecoder().decode(indexFile));
    } catch {
      // In dev mode, frontend is served by Vite — no static files here
      return c.text("OK", 200);
    }
  });

  // Restore preview process handles for projects with detached dev servers.
  if (config.workspacesRoot) {
    previewService.restoreFromConfig(config.workspacesRoot).catch((e) => {
      logger.app.warn("Failed to restore preview dev servers: {error}", {
        error: e,
      });
    });
  }

  // Restore remote-control processes for projects that had it enabled
  if (config.workspacesRoot) {
    remoteControlManager
      .restoreFromConfig(config.workspacesRoot, config.cliPath)
      .catch((e) => {
        logger.app.warn("Failed to restore remote-control processes: {error}", {
          error: e,
        });
      });
  }

  void bootstrapFirstDevice(logger.app).catch((error) => {
    logger.app.warn("Failed to bootstrap first passkey device: {error}", {
      error,
    });
  });

  return app;
}

export async function shutdownAppServices(
  options: {
    shutdownRemoteControl?: boolean;
  } = {},
): Promise<void> {
  logger.app.info("Shutting down — persisting terminal sessions...");
  sessionStatusWatcher.stop();
  wakeScheduler.stop();
  loopController.stop();
  if (options.shutdownRemoteControl) {
    remoteControlManager.shutdownAll();
  }
  await previewService.shutdownAll();
  await sessionManager.closeAll();
  await shutdownAllSessions();
}
