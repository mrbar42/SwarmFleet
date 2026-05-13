#!/usr/bin/env node
/**
 * Node.js-specific entry point for SwarmFleet Web UI
 */

import { createApp, shutdownAppServices } from "../app.ts";
import { NodeRuntime } from "../runtime/node.ts";
import { parseCliArgs } from "./args.ts";
import { validateClaudeCli } from "./validation.ts";
import { setupLogger, logger } from "../utils/logger.ts";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { exit } from "../utils/os.ts";

const SHUTDOWN_GRACE_MS = 3000;

async function main(runtime: NodeRuntime) {
  // Parse CLI arguments
  const args = parseCliArgs();

  // Initialize logging system
  await setupLogger(args.debug);

  if (args.debug) {
    logger.cli.info("Debug mode enabled");
  }

  // Validate Claude CLI availability and get the detected CLI path
  const cliPath = await validateClaudeCli(runtime, args.claudePath);

  // Use absolute path for static files
  const __dirname =
    import.meta.dirname ?? dirname(fileURLToPath(import.meta.url));
  const staticPath = join(__dirname, "../static");

  // Create application
  const app = createApp(runtime, {
    debugMode: args.debug,
    staticPath,
    cliPath,
    workspacesRoot: args.workspacesRoot,
    // MCP subagent servers spawned as children of the Claude CLI need to
    // call back into the backend. The address they use is loopback + the
    // port we're about to listen on; `args.host` may be 0.0.0.0 for LAN
    // access but MCP traffic always stays on 127.0.0.1.
    backendUrl: `http://127.0.0.1:${args.port}`,
  });

  // Start server
  logger.cli.info(`Server starting on ${args.host}:${args.port}`);
  const server = runtime.serve(args.port, args.host, app.fetch);
  let shuttingDown = false;

  const handleShutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.cli.info(
      `Received ${signal}; allowing up to ${SHUTDOWN_GRACE_MS}ms for graceful shutdown`,
    );

    const forceExit = setTimeout(() => {
      logger.cli.warn("Graceful shutdown timed out; exiting");
      exit(0);
    }, SHUTDOWN_GRACE_MS);

    try {
      await Promise.allSettled([
        server.close(),
        shutdownAppServices({ shutdownRemoteControl: false }),
      ]);
    } finally {
      clearTimeout(forceExit);
      exit(0);
    }
  };

  process.on("SIGTERM", (signal) => {
    void handleShutdown(signal);
  });
  process.on("SIGINT", (signal) => {
    void handleShutdown(signal);
  });
}

// Run the application
const runtime = new NodeRuntime();
main(runtime).catch((error) => {
  console.error("Failed to start server:", error);
  exit(1);
});
