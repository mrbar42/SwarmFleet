/**
 * Minimal runtime abstraction layer
 */

import type { MiddlewareHandler } from "hono";

// Command execution result
export interface CommandResult {
  success: boolean;
  stdout: string;
  stderr: string;
  code: number;
}

export interface ServerHandle {
  close(): Promise<void>;
}

// Simplified runtime interface - only truly platform-specific operations
export interface Runtime {
  // Process execution
  runCommand(
    command: string,
    args: string[],
    options?: { env?: Record<string, string> },
  ): Promise<CommandResult>;
  findExecutable(name: string): Promise<string[]>;

  // HTTP server
  serve(
    port: number,
    hostname: string,
    handler: (req: Request, env?: unknown) => Response | Promise<Response>,
  ): ServerHandle;

  // Static file serving
  createStaticFileMiddleware(options: { root: string }): MiddlewareHandler;
}
