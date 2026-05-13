import { createMiddleware } from "hono/factory";
import type { AppConfig } from "../types.ts";

/**
 * Creates configuration middleware that makes app-wide settings available to all handlers
 * via context variables.
 */
export function createConfigMiddleware(options: AppConfig) {
  return createMiddleware<{
    Variables: {
      config: AppConfig;
    };
  }>(async (c, next) => {
    c.set("config", options);
    await next();
  });
}

/**
 * Type helper to ensure handlers can access the config variable
 */
export type ConfigContext = {
  Variables: {
    config: AppConfig;
  };
};
