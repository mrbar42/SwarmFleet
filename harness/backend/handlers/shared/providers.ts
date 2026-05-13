import type { Context } from "hono";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import type {
  OpenRouterClaudeProfileRequest,
  PiProviderProfileRequest,
  ProviderStatusInfo,
  ProviderStatusResponse,
  ProviderGlobalSettings,
  ProviderModelOption,
} from "../../../shared/types.ts";
import type { AppConfig } from "../../types.ts";
import {
  buildProviderCatalog,
  encodeHermesCodexModelId,
  encodeHermesOpenRouterModelId,
  encodeHermesProviderModelId,
  providerProfileStore,
  redactProviderSettings,
  redactOpenRouterClaudeProfile,
  redactPiProfile,
} from "../../services/providerProfiles.ts";
import { sendTelegramOperatorNotification } from "../../services/telegramNotifications.ts";
import { logger } from "../../utils/logger.ts";

const CACHE_TTL_MS = 10 * 60_000;
const CLAUDE_AUTH_TIMEOUT_MS = 3_000;
let providerCache: {
  data: Record<string, ProviderStatusInfo>;
  hermesModels: ProviderModelOption[];
  ts: number;
} | null = null;
let providerStatusInFlight: Promise<BuiltinProviderSnapshot> | null = null;
let lastClaudeAuthStatus: Omit<ProviderStatusInfo, "name"> | null = null;

function isClaudeLoggedOutOutput(output: string): boolean {
  const normalized = output.toLowerCase();
  return (
    normalized.includes("not logged in") ||
    normalized.includes("not authenticated") ||
    normalized.includes("invalid") ||
    normalized.includes("no api key") ||
    normalized.includes("login required") ||
    (normalized.includes("run") && normalized.includes("login")) ||
    normalized.includes("authenticate")
  );
}

function isTransientClaudeAuthError(err: unknown, output: string): boolean {
  const error = err as NodeJS.ErrnoException & {
    killed?: boolean;
    signal?: NodeJS.Signals | null;
  };
  return (
    error.killed === true ||
    error.signal === "SIGTERM" ||
    error.code === "ETIMEDOUT" ||
    output.trim().length === 0
  );
}

async function checkClaudeAuth(
  cliPath?: string,
): Promise<Omit<ProviderStatusInfo, "name">> {
  return new Promise((resolve) => {
    const cmd = cliPath || "claude";
    execFile(
      cmd,
      ["auth", "status"],
      { timeout: CLAUDE_AUTH_TIMEOUT_MS },
      (err, stdout, stderr) => {
        const output = ((stdout || "") + (stderr || "")).trim();
        if (!err) {
          lastClaudeAuthStatus = { authenticated: true };
          resolve(lastClaudeAuthStatus);
          return;
        }

        if (isClaudeLoggedOutOutput(output)) {
          lastClaudeAuthStatus = {
            authenticated: false,
            error: "Not logged in",
          };
          resolve(lastClaudeAuthStatus);
          return;
        }

        if (
          lastClaudeAuthStatus?.authenticated === true &&
          isTransientClaudeAuthError(err, output)
        ) {
          resolve(lastClaudeAuthStatus);
          return;
        }

        const error =
          output ||
          ((err as NodeJS.ErrnoException).code === "ENOENT"
            ? "Claude CLI not found"
            : "Auth check failed");
        lastClaudeAuthStatus = { authenticated: false, error };
        resolve(lastClaudeAuthStatus);
      },
    );
  });
}

async function checkCodexAuth(): Promise<Omit<ProviderStatusInfo, "name">> {
  if (process.env.OPENAI_API_KEY) {
    return { authenticated: true };
  }
  return new Promise((resolve) => {
    execFile(
      "codex",
      ["login", "status"],
      { timeout: 5000 },
      (err, stdout, stderr) => {
        const output = ((stdout || "") + (stderr || "")).trim();
        if (err) {
          resolve({ authenticated: false, error: output || "Not logged in" });
          return;
        }
        resolve({ authenticated: true });
      },
    );
  });
}

function execFileText(
  command: string,
  args: string[],
  timeout = 5000,
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout, ...options }, (err, stdout, stderr) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(((stdout || "") + (stderr || "")).trim());
    });
  });
}

interface HermesProviderDiscovery {
  authenticated: boolean;
  error?: string;
  models: ProviderModelOption[];
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is string => typeof item === "string" && item.length > 0,
      )
    : [];
}

interface HermesPythonRuntime {
  command: string;
  args: string[];
  cwd?: string;
}

function isPythonExecutable(value: string | undefined): boolean {
  if (!value) return false;
  const name = value.split(/[\\/]/).pop() ?? value;
  return /^python(?:\d+(?:\.\d+)?)?$/.test(name);
}

function cwdFromPythonExecutable(
  pythonExecutable: string | undefined,
): string | undefined {
  const marker = "/venv/bin/";
  const markerIndex = pythonExecutable?.indexOf(marker) ?? -1;
  return markerIndex > 0 ? pythonExecutable?.slice(0, markerIndex) : undefined;
}

export function resolveHermesPythonRuntimeFromShebang(
  firstLine: string,
): HermesPythonRuntime | null {
  if (!firstLine.startsWith("#!")) return null;
  const parts = firstLine.slice(2).trim().split(/\s+/).filter(Boolean);
  const [command, ...args] = parts;
  if (!command) return null;

  if (!command.endsWith("/env") && !isPythonExecutable(command)) return null;
  const envPythonArg = command.endsWith("/env")
    ? args.find((arg) => !arg.startsWith("-") && isPythonExecutable(arg))
    : undefined;
  const pythonExecutable = command.endsWith("/env") ? envPythonArg : command;
  if (!pythonExecutable) return null;
  const cwd = cwdFromPythonExecutable(pythonExecutable);
  return { command, args, cwd };
}

function resolveHermesPythonRuntimeFromWrapperScript(
  script: string,
): HermesPythonRuntime | null {
  const pythonPath = script.match(
    /(["']?)(\/[^\s"'$;]+\/venv\/bin\/python(?:\d+(?:\.\d+)?)?)\1/,
  )?.[2];
  if (!pythonPath) return null;
  return {
    command: pythonPath,
    args: [],
    cwd: cwdFromPythonExecutable(pythonPath),
  };
}

async function resolveHermesPython(): Promise<HermesPythonRuntime> {
  const hermesPath = await execFileText("which", ["hermes"]);
  const script = await readFile(hermesPath, "utf8");
  const firstLine = script.split(/\r?\n/, 1)[0] ?? "";
  return (
    resolveHermesPythonRuntimeFromShebang(firstLine) ??
    resolveHermesPythonRuntimeFromWrapperScript(script) ?? {
      command: "python3",
      args: [],
    }
  );
}

async function discoverHermesAvailableModels(): Promise<HermesProviderDiscovery> {
  const runtime = await resolveHermesPython();
  const script = String.raw`
import json, os, urllib.error, urllib.request
from hermes_cli.env_loader import load_hermes_dotenv
load_hermes_dotenv()
from hermes_cli.auth import get_auth_status, has_usable_secret
from hermes_cli.config import load_config
from hermes_cli.models import provider_model_ids

result = {"providers": {}, "errors": {}}

_PROVIDER_ALIASES = {
    "codex": "openai-codex",
    "openrouter": "openrouter",
    "lm-studio": "lmstudio",
    "lm_studio": "lmstudio",
}

def normalize_provider(provider):
    raw = str(provider or "").strip().lower()
    return _PROVIDER_ALIASES.get(raw, raw)

def add_models(provider, models):
    normalized = normalize_provider(provider)
    cleaned = []
    for model in models or []:
        model_id = str(model or "").strip()
        if model_id and model_id not in cleaned:
            cleaned.append(model_id)
    if cleaned:
        result["providers"][normalized] = cleaned

def provider_available(provider):
    try:
        status = get_auth_status(provider)
        return bool(status.get("logged_in") or status.get("configured")), status.get("error")
    except Exception as exc:
        return False, str(exc)

def add_provider_catalog(provider):
    available, error = provider_available(provider)
    if available:
        try:
            add_models(provider, provider_model_ids(provider))
        except Exception as exc:
            result["errors"][provider] = str(exc)
    elif error:
        result["errors"][provider] = error

def local_model_ids(base_url):
    base = str(base_url or "").strip().rstrip("/")
    if not base:
        return []
    if not base.endswith("/v1"):
        base = base + "/v1"
    try:
        with urllib.request.urlopen(base + "/models", timeout=5) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except (OSError, ValueError, urllib.error.URLError):
        return []
    data = payload.get("data") if isinstance(payload, dict) else []
    if not isinstance(data, list):
        return []
    ids = []
    for item in data:
        if isinstance(item, dict):
            model_id = str(item.get("id") or "").strip()
            if model_id and model_id not in ids:
                ids.append(model_id)
    return ids

# Local/custom providers often have no API key and may expose only the user's
# configured default model. Treat config.yaml as the source of truth instead of
# showing static fallbacks or an unrelated Codex default.
try:
    config = load_config()
    configured_providers = set()
    model_config = config.get("model", {})
    if isinstance(model_config, dict):
        config_provider = normalize_provider(model_config.get("provider"))
        if config_provider:
            configured_providers.add(config_provider)
        config_model = str(model_config.get("default") or model_config.get("model") or "").strip()
        base_url = str(model_config.get("base_url") or "").strip()
        localish_base_url = base_url.lower().startswith((
            "http://127.0.0.1",
            "http://localhost",
            "http://0.0.0.0",
            "http://host.docker.internal",
            "https://127.0.0.1",
            "https://localhost",
            "https://host.docker.internal",
        ))
        if config_provider in {"lmstudio", "custom"} or (config_provider and localish_base_url):
            discovered_models = local_model_ids(base_url) if localish_base_url else []
            add_models(config_provider, [config_model, *discovered_models])
        elif config_provider and config_model:
            add_models(config_provider, [config_model])
    elif isinstance(model_config, str) and model_config.strip():
        env_provider = normalize_provider(os.getenv("HERMES_INFERENCE_PROVIDER"))
        if env_provider:
            configured_providers.add(env_provider)
            add_models(env_provider, [model_config.strip()])

    model_aliases = config.get("model_aliases", {})
    if isinstance(model_aliases, dict):
        for entry in model_aliases.values():
            if not isinstance(entry, dict):
                continue
            alias_provider = normalize_provider(entry.get("provider") or "custom")
            if alias_provider:
                configured_providers.add(alias_provider)
            alias_model = str(entry.get("model") or "").strip()
            alias_base_url = str(entry.get("base_url") or "").strip()
            alias_localish = alias_base_url.lower().startswith((
                "http://127.0.0.1",
                "http://localhost",
                "http://0.0.0.0",
                "http://host.docker.internal",
                "https://127.0.0.1",
                "https://localhost",
                "https://host.docker.internal",
            ))
            if alias_model:
                add_models(alias_provider, [alias_model])
            elif alias_localish:
                add_models(alias_provider, local_model_ids(alias_base_url))

    if "openai-codex" in configured_providers:
        add_provider_catalog("openai-codex")

    if "openrouter" in configured_providers:
        openrouter_key = os.getenv("OPENROUTER_API_KEY", "")
        if has_usable_secret(openrouter_key):
            try:
                add_models("openrouter", provider_model_ids("openrouter", force_refresh=True))
            except Exception as exc:
                result["errors"]["openrouter"] = str(exc)
except Exception as exc:
    result["errors"]["config"] = str(exc)

print(json.dumps(result))
`;
  const output = await execFileText(
    runtime.command,
    [...runtime.args, "-c", script],
    15_000,
    {
      cwd: runtime.cwd,
    },
  );
  const parsed = JSON.parse(output) as {
    providers?: Record<string, unknown>;
    errors?: Record<string, unknown>;
  };
  const codexModels = toStringArray(parsed.providers?.["openai-codex"]);
  const openRouterModels = toStringArray(parsed.providers?.openrouter);
  const genericProviderModels = parsed.providers
    ? Object.entries(parsed.providers).flatMap(([provider, value]) => {
        if (provider === "openai-codex" || provider === "openrouter") return [];
        return toStringArray(value).map((rawId) => ({ provider, rawId }));
      })
    : [];
  const models: ProviderModelOption[] = [
    ...codexModels.map((rawId) => ({
      id: encodeHermesCodexModelId(rawId),
      rawId,
      label: `codex:${rawId}`,
      provider: "hermes" as const,
    })),
    ...openRouterModels.map((rawId) => ({
      id: encodeHermesOpenRouterModelId(rawId),
      rawId,
      label: `openrouter:${rawId}`,
      provider: "hermes" as const,
    })),
    ...genericProviderModels.map(({ provider, rawId }) => ({
      id: encodeHermesProviderModelId(provider, rawId),
      rawId,
      label: `${provider}:${rawId}`,
      provider: "hermes" as const,
    })),
  ];
  const errors = parsed.errors
    ? Object.entries(parsed.errors)
        .filter(([, value]) => typeof value === "string" && value)
        .map(([provider, value]) => `${provider}: ${value}`)
    : [];
  return {
    authenticated: models.length > 0,
    error:
      models.length > 0
        ? undefined
        : errors.join("; ") || "No Hermes model provider is configured",
    models,
  };
}

interface BuiltinProviderSnapshot {
  providers: Record<string, ProviderStatusInfo>;
  hermesModels: ProviderModelOption[];
}

async function getBuiltinProviderStatus(
  cliPath?: string,
  fresh = false,
): Promise<BuiltinProviderSnapshot> {
  if (!fresh && providerCache && Date.now() - providerCache.ts < CACHE_TTL_MS) {
    return {
      providers: providerCache.data,
      hermesModels: providerCache.hermesModels,
    };
  }
  if (providerStatusInFlight) return providerStatusInFlight;

  providerStatusInFlight = (async () => {
    const [claudeStatus, codexStatus, hermesDiscovery] = await Promise.all([
      checkClaudeAuth(cliPath),
      checkCodexAuth(),
      discoverHermesAvailableModels().catch((error: unknown) => ({
        authenticated: false,
        error: error instanceof Error ? error.message : String(error),
        models: [],
      })),
    ]);
    const providers = {
      claude: { name: "Claude", ...claudeStatus },
      codex: { name: "Codex", ...codexStatus },
      hermes: {
        name: "Hermes",
        authenticated: hermesDiscovery.authenticated,
        error: hermesDiscovery.error,
      },
    };
    providerCache = {
      data: providers,
      hermesModels: hermesDiscovery.models,
      ts: Date.now(),
    };
    return { providers, hermesModels: hermesDiscovery.models };
  })();

  try {
    return await providerStatusInFlight;
  } finally {
    providerStatusInFlight = null;
  }
}

export async function handleProvidersStatusRequest(c: Context) {
  try {
    const config = c.get("config") as AppConfig | undefined;
    const cliPath = config?.cliPath;
    const fresh = c.req.query("fresh") === "1";
    const snapshot = await getBuiltinProviderStatus(cliPath, fresh);
    const providers = snapshot.providers;
    const piProfiles = (await providerProfileStore.listPiProfiles()).map(
      redactPiProfile,
    );
    const openRouterClaudeProfiles = (
      await providerProfileStore.listOpenRouterClaudeProfiles()
    ).map(redactOpenRouterClaudeProfile);

    const response: ProviderStatusResponse = {
      providers,
      piProfiles,
      openRouterClaudeProfiles,
      cliPath: cliPath || "claude",
    };
    return c.json(response);
  } catch (error) {
    logger.api.error("Error checking provider status: {error}", { error });
    return c.json({ error: "Failed to check provider status" }, 500);
  }
}

export async function handleProviderCatalogRequest(c: Context) {
  try {
    const config = c.get("config") as AppConfig | undefined;
    const snapshot = await getBuiltinProviderStatus(
      config?.cliPath,
      c.req.query("fresh") === "1",
    );
    const statuses = snapshot.providers;
    const catalog = await buildProviderCatalog({
      claudeAuthenticated: statuses.claude?.authenticated ?? false,
      claudeError: statuses.claude?.error,
      codexAuthenticated: statuses.codex?.authenticated ?? false,
      codexError: statuses.codex?.error,
      hermesAuthenticated: statuses.hermes?.authenticated ?? false,
      hermesError: statuses.hermes?.error,
      hermesModels: snapshot.hermesModels,
    });
    return c.json(catalog);
  } catch (error) {
    logger.api.error("Error building provider catalog: {error}", { error });
    return c.json({ error: "Failed to build provider catalog" }, 500);
  }
}

export async function handleProviderSettingsRequest(c: Context) {
  try {
    const settings = await providerProfileStore.getSettings();
    return c.json(redactProviderSettings(settings));
  } catch (error) {
    logger.api.error("Error reading provider settings: {error}", { error });
    return c.json({ error: "Failed to read provider settings" }, 500);
  }
}

export async function handleUpdateProviderSettingsRequest(c: Context) {
  try {
    const body = await c.req.json<Partial<ProviderGlobalSettings>>();
    const updates: Partial<ProviderGlobalSettings> = {};
    if (Object.prototype.hasOwnProperty.call(body, "defaultSubagentModel")) {
      updates.defaultSubagentModel =
        typeof body.defaultSubagentModel === "string"
          ? body.defaultSubagentModel
          : "";
    }
    if (
      Object.prototype.hasOwnProperty.call(body, "openRouterClaudeProxyEnabled")
    ) {
      updates.openRouterClaudeProxyEnabled =
        body.openRouterClaudeProxyEnabled === true;
    }
    if (
      Object.prototype.hasOwnProperty.call(
        body,
        "openRouterClaudeProxyZdrEnabled",
      )
    ) {
      updates.openRouterClaudeProxyZdrEnabled =
        body.openRouterClaudeProxyZdrEnabled === true;
    }
    if (
      Object.prototype.hasOwnProperty.call(
        body,
        "telegramOperatorNotificationsEnabled",
      )
    ) {
      updates.telegramOperatorNotificationsEnabled =
        body.telegramOperatorNotificationsEnabled === true;
    }
    if (Object.prototype.hasOwnProperty.call(body, "telegramBotToken")) {
      updates.telegramBotToken =
        typeof body.telegramBotToken === "string" ? body.telegramBotToken : "";
    }
    if (Object.prototype.hasOwnProperty.call(body, "telegramChatId")) {
      updates.telegramChatId =
        typeof body.telegramChatId === "string" ? body.telegramChatId : "";
    }

    const settings = await providerProfileStore.updateSettings(updates);
    return c.json(redactProviderSettings(settings));
  } catch (error) {
    logger.api.error("Error updating provider settings: {error}", { error });
    return c.json({ error: "Failed to update provider settings" }, 500);
  }
}

export async function handleTestTelegramProviderSettingsRequest(c: Context) {
  try {
    const result = await sendTelegramOperatorNotification(
      "SwarmFleet Telegram notifications are working.",
    );
    if (!result.ok) {
      return c.json(
        { error: result.error ?? "Telegram notification failed" },
        400,
      );
    }
    return c.json({ ok: true });
  } catch (error) {
    logger.api.error("Error sending Telegram test notification: {error}", {
      error,
    });
    return c.json({ error: "Failed to send Telegram test notification" }, 500);
  }
}

export async function handleCreatePiProviderProfile(c: Context) {
  try {
    const body = await c.req.json<PiProviderProfileRequest>();
    const profile = await providerProfileStore.createPiProfile(body);
    providerCache = null;
    return c.json({ profile }, 201);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to create Pi profile";
    return c.json({ error: message }, 400);
  }
}

export async function handleUpdatePiProviderProfile(c: Context) {
  try {
    const id = c.req.param("id");
    if (!id) return c.json({ error: "Profile id is required" }, 400);
    const body = await c.req.json<PiProviderProfileRequest>();
    const profile = await providerProfileStore.updatePiProfile(id, body);
    if (!profile) return c.json({ error: "Profile not found" }, 404);
    providerCache = null;
    return c.json({ profile });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to update Pi profile";
    return c.json({ error: message }, 400);
  }
}

export async function handleDeletePiProviderProfile(c: Context) {
  const id = c.req.param("id");
  if (!id) return c.json({ error: "Profile id is required" }, 400);
  const deleted = await providerProfileStore.deletePiProfile(id);
  if (!deleted) return c.json({ error: "Profile not found" }, 404);
  providerCache = null;
  return c.json({ ok: true });
}

export async function handleCreateOpenRouterClaudeProfile(c: Context) {
  try {
    const body = await c.req.json<OpenRouterClaudeProfileRequest>();
    const profile =
      await providerProfileStore.createOpenRouterClaudeProfile(body);
    providerCache = null;
    return c.json({ profile }, 201);
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Failed to create OpenRouterClaude profile";
    return c.json({ error: message }, 400);
  }
}

export async function handleUpdateOpenRouterClaudeProfile(c: Context) {
  try {
    const id = c.req.param("id");
    if (!id) return c.json({ error: "Profile id is required" }, 400);
    const body = await c.req.json<OpenRouterClaudeProfileRequest>();
    const profile = await providerProfileStore.updateOpenRouterClaudeProfile(
      id,
      body,
    );
    if (!profile) return c.json({ error: "Profile not found" }, 404);
    providerCache = null;
    return c.json({ profile });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Failed to update OpenRouterClaude profile";
    return c.json({ error: message }, 400);
  }
}

export async function handleDeleteOpenRouterClaudeProfile(c: Context) {
  const id = c.req.param("id");
  if (!id) return c.json({ error: "Profile id is required" }, 400);
  const deleted = await providerProfileStore.deleteOpenRouterClaudeProfile(id);
  if (!deleted) return c.json({ error: "Profile not found" }, 404);
  providerCache = null;
  return c.json({ ok: true });
}
