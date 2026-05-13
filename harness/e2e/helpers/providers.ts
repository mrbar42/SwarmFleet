import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ensureRuntimeDir, PROVIDER_STATE_PATH } from "./projects";

const execFileAsync = promisify(execFile);

export const PROVIDER_CONFIG = {
  anthropic: {
    name: "Anthropic",
    modelId: "claude-haiku-4-5-20251001",
    providerId: "claude",
    skipMessage: "Anthropic not authenticated",
  },
  openai: {
    name: "OpenAI",
    modelId: "codex:gpt-5.4-mini",
    providerId: "codex",
    skipMessage: "OpenAI not authenticated",
  },
} as const;

export interface ProviderAvailability {
  available: boolean;
  reason: string | null;
}

export interface ProviderState {
  anthropic: ProviderAvailability;
  openai: ProviderAvailability;
}

async function checkAnthropicAuth(): Promise<ProviderAvailability> {
  try {
    const { stdout, stderr } = await execFileAsync("claude", ["auth", "status"], {
      timeout: 5_000,
    });
    const output = `${stdout}${stderr}`.toLowerCase();
    if (
      output.includes("not logged in") ||
      output.includes("authenticate") ||
      output.includes("invalid")
    ) {
      return {
        available: false,
        reason: PROVIDER_CONFIG.anthropic.skipMessage,
      };
    }
    return { available: true, reason: null };
  } catch (error) {
    const output = [
      error instanceof Error ? error.message : String(error),
      typeof error === "object" && error !== null && "stdout" in error
        ? String((error as { stdout?: string }).stdout ?? "")
        : "",
      typeof error === "object" && error !== null && "stderr" in error
        ? String((error as { stderr?: string }).stderr ?? "")
        : "",
    ]
      .join(" ")
      .toLowerCase();
    if (
      output.includes("not logged in") ||
      output.includes("authenticate") ||
      output.includes("invalid")
    ) {
      return {
        available: false,
        reason: PROVIDER_CONFIG.anthropic.skipMessage,
      };
    }
    return {
      available: false,
      reason: `Anthropic auth check failed: ${output.trim() || "unknown error"}`,
    };
  }
}

async function checkOpenAIAuth(): Promise<ProviderAvailability> {
  if (process.env.OPENAI_API_KEY) {
    return { available: true, reason: null };
  }

  const authPath = join(homedir(), ".codex", "auth.json");
  if (existsSync(authPath)) {
    return { available: true, reason: null };
  }

  return {
    available: false,
    reason: PROVIDER_CONFIG.openai.skipMessage,
  };
}

export async function detectProviderState(): Promise<ProviderState> {
  return {
    anthropic: await checkAnthropicAuth(),
    openai: await checkOpenAIAuth(),
  };
}

export async function writeProviderState(state: ProviderState): Promise<void> {
  await ensureRuntimeDir();
  await import("node:fs/promises").then(({ writeFile }) =>
    writeFile(PROVIDER_STATE_PATH, JSON.stringify(state, null, 2), "utf8"),
  );
}

export function loadProviderState(): ProviderState {
  if (!existsSync(PROVIDER_STATE_PATH)) {
    return {
      anthropic: {
        available: false,
        reason: "Provider state not initialized",
      },
      openai: {
        available: false,
        reason: "Provider state not initialized",
      },
    };
  }
  return JSON.parse(readFileSync(PROVIDER_STATE_PATH, "utf8")) as ProviderState;
}

export function chooseAnyAvailableProvider(
  state: ProviderState,
): keyof ProviderState | null {
  if (state.openai.available) return "openai";
  if (state.anthropic.available) return "anthropic";
  return null;
}
