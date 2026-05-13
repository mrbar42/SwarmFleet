/**
 * CLI argument parsing
 */

import { program } from "commander";
import { VERSION } from "./version.ts";
import { getEnv, getArgs } from "../utils/os.ts";

export interface ParsedArgs {
  debug: boolean;
  port: number;
  host: string;
  claudePath?: string;
  workspacesRoot?: string;
}

export function parseCliArgs(): ParsedArgs {
  const version = VERSION;
  const defaultPort = parseInt(getEnv("PORT") || "7080", 10);

  program
    .name("swarmfleet-harness")
    .version(version, "-v, --version", "display version number")
    .description("SwarmFleet Web UI Backend Server")
    .option(
      "-p, --port <port>",
      "Port to listen on",
      (value) => {
        const parsed = parseInt(value, 10);
        if (isNaN(parsed)) {
          throw new Error(`Invalid port number: ${value}`);
        }
        return parsed;
      },
      defaultPort,
    )
    .option(
      "--host <host>",
      "Host address to bind to (use 0.0.0.0 for all interfaces)",
      "127.0.0.1",
    )
    .option(
      "--claude-path <path>",
      "Path to claude executable (overrides automatic detection)",
    )
    .option("-d, --debug", "Enable debug mode", false)
    .option(
      "--workspaces-root <path>",
      "Root directory to scope project discovery (defaults to WORKSPACES_ROOT env or cwd)",
    );

  program.parse(getArgs(), { from: "user" });
  const options = program.opts();

  const debugEnv = getEnv("DEBUG");
  const debugFromEnv = debugEnv?.toLowerCase() === "true" || debugEnv === "1";

  return {
    debug: options.debug || debugFromEnv,
    port: options.port,
    host: options.host,
    claudePath: options.claudePath,
    workspacesRoot: options.workspacesRoot || getEnv("SWARMFLEET_WORKSPACE") || getEnv("WORKSPACES_ROOT") || undefined,
  };
}
