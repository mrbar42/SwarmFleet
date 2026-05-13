/**
 * Shared CLI validation utilities
 *
 * Finds the `claude` native binary on PATH and validates it runs.
 */

import type { Runtime } from "../runtime/types.ts";
import { logger } from "../utils/logger.ts";
import { getPlatform, exit } from "../utils/os.ts";

export async function validateClaudeCli(
  runtime: Runtime,
  customPath?: string,
): Promise<string> {
  try {
    const platform = getPlatform();
    const isWindows = platform === "windows";

    let claudePath = "";

    if (customPath) {
      claudePath = customPath;
      logger.cli.info(`Validating custom Claude path: ${customPath}`);
    } else {
      logger.cli.info("Searching for Claude CLI in PATH...");
      const candidates = await runtime.findExecutable("claude");

      if (candidates.length === 0) {
        logger.cli.error("Claude CLI not found in PATH");
        logger.cli.error(
          "   Install: curl -fsSL https://claude.ai/install.sh | bash",
        );
        exit(1);
      }

      if (isWindows && candidates.length > 1) {
        const cmdCandidate = candidates.find((path) => path.endsWith(".cmd"));
        claudePath = cmdCandidate || candidates[0];
      } else {
        claudePath = candidates[0];
      }
    }

    // Verify the binary runs
    try {
      const versionResult = await runtime.runCommand(claudePath, ["--version"]);
      if (versionResult.success && versionResult.stdout.trim()) {
        logger.cli.info(`Claude CLI found: ${versionResult.stdout.trim()}`);
      }
    } catch {
      // Version check is non-critical
    }

    return claudePath;
  } catch (error) {
    logger.cli.error("Failed to validate Claude CLI");
    logger.cli.error(
      `   Error: ${error instanceof Error ? error.message : String(error)}`,
    );
    exit(1);
  }
}
