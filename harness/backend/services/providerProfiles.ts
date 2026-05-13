import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  getModels,
  getProviders,
  type KnownProvider,
  type Model,
} from "@mariozechner/pi-ai";
import modelsConfig from "../../shared/models.json" with { type: "json" };
import type {
  ChatProvider,
  OpenRouterClaudeProfileRequest,
  PiProviderProfileRequest,
  ProviderCatalogGroup,
  ProviderCatalogResponse,
  ProviderGlobalSettings,
  ProviderModelOption,
  RedactedProviderGlobalSettings,
  RedactedOpenRouterClaudeProfile,
  RedactedPiProviderProfile,
} from "../../shared/types.ts";
import { getHomeDir } from "../utils/os.ts";

const PROFILE_STORE_VERSION = 1;
const PROFILE_FILE_NAME = "provider-profiles.json";

export interface StoredPiProviderProfile {
  id: string;
  name: string;
  provider: string;
  apiKey: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
  denyOpenRouterDataCollection: boolean;
  manualModels: string[];
  createdAt: number;
  updatedAt: number;
}

export interface StoredOpenRouterClaudeProfile {
  id: string;
  name: string;
  apiKey: string;
  baseUrl?: string;
  manualModels: string[];
  createdAt: number;
  updatedAt: number;
}

interface ProviderProfileFile {
  version: number;
  piProfiles: StoredPiProviderProfile[];
  openRouterClaudeProfiles: StoredOpenRouterClaudeProfile[];
  settings: ProviderGlobalSettings;
}

function profileStorePath(): string {
  const home = getHomeDir();
  if (!home) {
    throw new Error("Home directory not found");
  }
  return join(home, ".swarmfleet", PROFILE_FILE_NAME);
}

function emptyStore(): ProviderProfileFile {
  return {
    version: PROFILE_STORE_VERSION,
    piProfiles: [],
    openRouterClaudeProfiles: [],
    settings: defaultProviderSettings(),
  };
}

function defaultCodexSubagentModel(): string {
  const openai = modelsConfig.providers.find(
    (provider) => provider.id === "openai",
  );
  const codexModel = openai?.models.find((model) =>
    model.id.startsWith("codex:"),
  )?.id;
  return codexModel || "codex:gpt-5.5";
}

function defaultProviderSettings(): ProviderGlobalSettings {
  return {
    defaultSubagentModel: defaultCodexSubagentModel(),
    openRouterClaudeProxyEnabled: true,
    openRouterClaudeProxyZdrEnabled: true,
    telegramOperatorNotificationsEnabled: false,
  };
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizeManualModels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .map((item) => (typeof item === "string" ? item.trim() : ""))
        .filter(Boolean),
    ),
  );
}

function normalizeHeaders(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === "string") out[key] = raw;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  return value as Record<string, unknown>;
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function piProviderDisplayName(provider: string): string {
  const labels: Record<string, string> = {
    "amazon-bedrock": "Amazon Bedrock",
    anthropic: "Anthropic",
    "azure-openai-responses": "Azure OpenAI",
    cerebras: "Cerebras",
    "github-copilot": "GitHub Copilot",
    google: "Google",
    "google-antigravity": "Google Antigravity",
    "google-gemini-cli": "Google Gemini CLI",
    "google-vertex": "Google Vertex",
    groq: "Groq",
    huggingface: "Hugging Face",
    "kimi-coding": "Kimi For Coding",
    minimax: "MiniMax",
    "minimax-cn": "MiniMax CN",
    mistral: "Mistral",
    opencode: "OpenCode Zen",
    "opencode-go": "OpenCode Go",
    openai: "OpenAI",
    "openai-codex": "OpenAI Codex",
    openrouter: "OpenRouter",
    "vercel-ai-gateway": "Vercel AI Gateway",
    xai: "xAI",
    zai: "Z.ai",
  };
  return (
    labels[provider] ??
    provider
      .split("-")
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ")
  );
}

function isSupportedPiProvider(provider: string): boolean {
  return (getProviders() as string[]).includes(provider);
}

function assertValidProvider(provider: string): void {
  if (!isSupportedPiProvider(provider)) {
    throw new Error(`Unsupported Pi provider: ${provider}`);
  }
}

export function redactPiProfile(
  profile: StoredPiProviderProfile,
): RedactedPiProviderProfile {
  return {
    id: profile.id,
    name: profile.name,
    provider: profile.provider,
    baseUrl: profile.baseUrl,
    headers: profile.headers,
    compat: profile.compat,
    denyOpenRouterDataCollection:
      profile.denyOpenRouterDataCollection !== false,
    manualModels: [...profile.manualModels],
    hasApiKey: Boolean(profile.apiKey),
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  };
}

export function redactOpenRouterClaudeProfile(
  profile: StoredOpenRouterClaudeProfile,
): RedactedOpenRouterClaudeProfile {
  return {
    id: profile.id,
    name: profile.name,
    baseUrl: profile.baseUrl,
    manualModels: [...profile.manualModels],
    hasApiKey: Boolean(profile.apiKey),
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  };
}

export function redactProviderSettings(
  settings: ProviderGlobalSettings,
): RedactedProviderGlobalSettings {
  const { telegramBotToken: _telegramBotToken, ...redacted } = settings;
  return {
    ...redacted,
    telegramBotTokenConfigured: Boolean(settings.telegramBotToken),
  };
}

export function parsePiModelId(
  modelId: string,
): { profileId: string; rawModelId: string } | null {
  const match = modelId.match(/^pi:([^:]+):(.+)$/);
  if (!match) return null;
  return { profileId: match[1], rawModelId: match[2] };
}

export function encodePiModelId(profileId: string, rawModelId: string): string {
  return `pi:${profileId}:${rawModelId}`;
}

export function parseOpenRouterClaudeModelId(
  modelId: string,
): { profileId: string; rawModelId: string } | null {
  const match = modelId.match(/^openrouter-claude:([^:]+):(.+)$/);
  if (!match) return null;
  return { profileId: match[1], rawModelId: match[2] };
}

export function encodeOpenRouterClaudeModelId(
  profileId: string,
  rawModelId: string,
): string {
  return `openrouter-claude:${profileId}:${rawModelId}`;
}

export function parseHermesModelId(
  modelId: string,
): { provider: string; rawModelId: string } | null {
  const match = modelId.match(/^hermes:([^:]+):(.+)$/);
  if (!match) return null;
  return {
    provider: match[1],
    rawModelId: match[2],
  };
}

export function encodeHermesProviderModelId(
  provider: string,
  rawModelId: string,
): string {
  const normalizedProvider = provider.trim() || "openai-codex";
  return `hermes:${normalizedProvider}:${rawModelId}`;
}

export function encodeHermesCodexModelId(codexModelId: string): string {
  const rawModelId = codexModelId.startsWith("codex:")
    ? codexModelId.slice("codex:".length)
    : codexModelId;
  return encodeHermesProviderModelId("codex", rawModelId);
}

export function encodeHermesOpenRouterModelId(rawModelId: string): string {
  return encodeHermesProviderModelId("openrouter", rawModelId);
}

export class ProviderProfileStore {
  constructor(private readonly path = profileStorePath()) {}

  async listPiProfiles(): Promise<StoredPiProviderProfile[]> {
    return (await this.readStore()).piProfiles;
  }

  async getPiProfile(id: string): Promise<StoredPiProviderProfile | null> {
    return (
      (await this.listPiProfiles()).find((profile) => profile.id === id) ?? null
    );
  }

  async listOpenRouterClaudeProfiles(): Promise<StoredOpenRouterClaudeProfile[]> {
    return (await this.readStore()).openRouterClaudeProfiles;
  }

  async getOpenRouterClaudeProfile(
    id: string,
  ): Promise<StoredOpenRouterClaudeProfile | null> {
    return (
      (await this.listOpenRouterClaudeProfiles()).find(
        (profile) => profile.id === id,
      ) ?? null
    );
  }

  async createPiProfile(
    input: PiProviderProfileRequest,
  ): Promise<RedactedPiProviderProfile> {
    const provider = normalizeString(input.provider);
    if (!provider) throw new Error("Provider is required");
    assertValidProvider(provider);
    const apiKey = normalizeString(input.apiKey);
    if (!apiKey) throw new Error("API key is required");

    const now = Date.now();
    const profile: StoredPiProviderProfile = {
      id: randomUUID(),
      name: normalizeString(input.name) ?? piProviderDisplayName(provider),
      provider,
      apiKey,
      baseUrl: normalizeString(input.baseUrl),
      headers: normalizeHeaders(input.headers),
      compat: normalizeObject(input.compat),
      denyOpenRouterDataCollection: normalizeBoolean(
        input.denyOpenRouterDataCollection,
        true,
      ),
      manualModels: normalizeManualModels(input.manualModels),
      createdAt: now,
      updatedAt: now,
    };

    const store = await this.readStore();
    store.piProfiles.push(profile);
    await this.writeStore(store);
    return redactPiProfile(profile);
  }

  async updatePiProfile(
    id: string,
    input: PiProviderProfileRequest,
  ): Promise<RedactedPiProviderProfile | null> {
    const store = await this.readStore();
    const profile = store.piProfiles.find((candidate) => candidate.id === id);
    if (!profile) return null;

    const provider = normalizeString(input.provider);
    if (provider) {
      assertValidProvider(provider);
      profile.provider = provider;
    }
    const name = normalizeString(input.name);
    if (name) profile.name = name;
    const apiKey = normalizeString(input.apiKey);
    if (apiKey) profile.apiKey = apiKey;

    if ("baseUrl" in input) profile.baseUrl = normalizeString(input.baseUrl);
    if ("headers" in input) profile.headers = normalizeHeaders(input.headers);
    if ("compat" in input) profile.compat = normalizeObject(input.compat);
    if ("denyOpenRouterDataCollection" in input) {
      profile.denyOpenRouterDataCollection = normalizeBoolean(
        input.denyOpenRouterDataCollection,
        true,
      );
    }
    if ("manualModels" in input) {
      profile.manualModels = normalizeManualModels(input.manualModels);
    }
    profile.updatedAt = Date.now();
    await this.writeStore(store);
    return redactPiProfile(profile);
  }

  async deletePiProfile(id: string): Promise<boolean> {
    const store = await this.readStore();
    const before = store.piProfiles.length;
    store.piProfiles = store.piProfiles.filter((profile) => profile.id !== id);
    if (store.piProfiles.length === before) return false;
    await this.writeStore(store);
    return true;
  }

  async createOpenRouterClaudeProfile(
    input: OpenRouterClaudeProfileRequest,
  ): Promise<RedactedOpenRouterClaudeProfile> {
    const apiKey = normalizeString(input.apiKey);
    if (!apiKey) throw new Error("OpenRouter API key is required");
    const now = Date.now();
    const profile: StoredOpenRouterClaudeProfile = {
      id: randomUUID(),
      name: normalizeString(input.name) ?? "OpenRouterClaude",
      apiKey,
      baseUrl: normalizeString(input.baseUrl),
      manualModels: normalizeManualModels(input.manualModels),
      createdAt: now,
      updatedAt: now,
    };
    const store = await this.readStore();
    store.openRouterClaudeProfiles.push(profile);
    await this.writeStore(store);
    return redactOpenRouterClaudeProfile(profile);
  }

  async updateOpenRouterClaudeProfile(
    id: string,
    input: OpenRouterClaudeProfileRequest,
  ): Promise<RedactedOpenRouterClaudeProfile | null> {
    const store = await this.readStore();
    const profile = store.openRouterClaudeProfiles.find(
      (candidate) => candidate.id === id,
    );
    if (!profile) return null;
    const name = normalizeString(input.name);
    if (name) profile.name = name;
    const apiKey = normalizeString(input.apiKey);
    if (apiKey) profile.apiKey = apiKey;
    if ("baseUrl" in input) profile.baseUrl = normalizeString(input.baseUrl);
    if ("manualModels" in input) {
      profile.manualModels = normalizeManualModels(input.manualModels);
    }
    profile.updatedAt = Date.now();
    await this.writeStore(store);
    return redactOpenRouterClaudeProfile(profile);
  }

  async deleteOpenRouterClaudeProfile(id: string): Promise<boolean> {
    const store = await this.readStore();
    const before = store.openRouterClaudeProfiles.length;
    store.openRouterClaudeProfiles = store.openRouterClaudeProfiles.filter(
      (profile) => profile.id !== id,
    );
    if (store.openRouterClaudeProfiles.length === before) return false;
    await this.writeStore(store);
    return true;
  }

  async getSettings(): Promise<ProviderGlobalSettings> {
    const store = await this.readStore();
    return { ...defaultProviderSettings(), ...store.settings };
  }

  async updateSettings(
    updates: Partial<ProviderGlobalSettings>,
  ): Promise<ProviderGlobalSettings> {
    const store = await this.readStore();
    const next: ProviderGlobalSettings = {
      ...defaultProviderSettings(),
      ...store.settings,
      ...(Object.prototype.hasOwnProperty.call(updates, "defaultSubagentModel")
        ? {
            defaultSubagentModel:
              typeof updates.defaultSubagentModel === "string" &&
              updates.defaultSubagentModel.trim()
                ? updates.defaultSubagentModel.trim()
                : defaultCodexSubagentModel(),
          }
        : {}),
      ...(Object.prototype.hasOwnProperty.call(
        updates,
        "openRouterClaudeProxyEnabled",
      )
        ? {
            openRouterClaudeProxyEnabled:
              updates.openRouterClaudeProxyEnabled === true,
          }
        : {}),
      ...(Object.prototype.hasOwnProperty.call(
        updates,
        "openRouterClaudeProxyZdrEnabled",
      )
        ? {
            openRouterClaudeProxyZdrEnabled:
              updates.openRouterClaudeProxyZdrEnabled === true,
          }
        : {}),
      ...(Object.prototype.hasOwnProperty.call(
        updates,
        "telegramOperatorNotificationsEnabled",
      )
        ? {
            telegramOperatorNotificationsEnabled:
              updates.telegramOperatorNotificationsEnabled === true,
          }
        : {}),
      ...(Object.prototype.hasOwnProperty.call(updates, "telegramBotToken")
        ? {
            telegramBotToken:
              typeof updates.telegramBotToken === "string" &&
              updates.telegramBotToken.trim()
                ? updates.telegramBotToken.trim()
                : undefined,
          }
        : {}),
      ...(Object.prototype.hasOwnProperty.call(updates, "telegramChatId")
        ? {
            telegramChatId:
              typeof updates.telegramChatId === "string" &&
              updates.telegramChatId.trim()
                ? updates.telegramChatId.trim()
                : undefined,
          }
        : {}),
    };
    store.settings = next;
    await this.writeStore(store);
    return next;
  }

  private async readStore(): Promise<ProviderProfileFile> {
    try {
      const raw = await readFile(this.path, "utf-8");
      const parsed = JSON.parse(raw) as Partial<ProviderProfileFile>;
      return {
        version: PROFILE_STORE_VERSION,
        piProfiles: Array.isArray(parsed.piProfiles)
          ? (parsed.piProfiles.map((profile) => ({
              ...profile,
              denyOpenRouterDataCollection:
                profile.denyOpenRouterDataCollection !== false,
              manualModels: normalizeManualModels(profile.manualModels),
            })) as StoredPiProviderProfile[])
          : [],
        openRouterClaudeProfiles: Array.isArray(
          parsed.openRouterClaudeProfiles,
        )
          ? (parsed.openRouterClaudeProfiles.map((profile) => ({
              ...profile,
              manualModels: normalizeManualModels(profile.manualModels),
            })) as StoredOpenRouterClaudeProfile[])
          : [],
        settings: {
          ...defaultProviderSettings(),
          ...(parsed.settings && typeof parsed.settings === "object"
            ? parsed.settings
            : {}),
          defaultSubagentModel:
            typeof parsed.settings?.defaultSubagentModel === "string" &&
            parsed.settings.defaultSubagentModel.trim()
              ? parsed.settings.defaultSubagentModel.trim()
              : defaultCodexSubagentModel(),
          openRouterClaudeProxyEnabled:
            parsed.settings?.openRouterClaudeProxyEnabled !== false,
          openRouterClaudeProxyZdrEnabled:
            parsed.settings?.openRouterClaudeProxyZdrEnabled !== false,
          telegramOperatorNotificationsEnabled:
            parsed.settings?.telegramOperatorNotificationsEnabled === true,
          telegramBotToken: normalizeString(parsed.settings?.telegramBotToken),
          telegramChatId: normalizeString(parsed.settings?.telegramChatId),
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return emptyStore();
      throw error;
    }
  }

  private async writeStore(store: ProviderProfileFile): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, this.path);
    await chmod(this.path, 0o600);
  }
}

function builtinModelGroup(
  provider: ChatProvider,
  label: string,
  sourceProvider: string,
  models: Array<{ id: string; label: string }>,
  authenticated: boolean,
  error?: string,
): ProviderCatalogGroup {
  return {
    id: provider,
    label,
    provider,
    sourceProvider,
    authenticated,
    error,
    models: models.map((model) => ({
      id: model.id,
      rawId: model.id,
      label: model.label,
      provider,
    })),
  };
}

function toPiModelOption(
  profileId: string,
  model: Model<any>,
): ProviderModelOption {
  return {
    id: encodePiModelId(profileId, model.id),
    rawId: model.id,
    label: model.name || model.id,
    provider: "pi",
    contextWindow: model.contextWindow,
    reasoning: model.reasoning,
    input: model.input,
  };
}

interface OpenRouterModel {
  id?: unknown;
  name?: unknown;
  context_length?: unknown;
  supported_parameters?: unknown;
  architecture?: unknown;
}

async function fetchOpenRouterModels(
  profile: StoredOpenRouterClaudeProfile,
): Promise<ProviderModelOption[]> {
  const configuredBaseUrl = (
    profile.baseUrl || "https://openrouter.ai/api/v1"
  ).replace(/\/+$/, "");
  const baseUrl = configuredBaseUrl.endsWith("/api")
    ? `${configuredBaseUrl}/v1`
    : configuredBaseUrl;
  const response = await fetch(`${baseUrl}/models`, {
    headers: {
      authorization: `Bearer ${profile.apiKey}`,
    },
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `OpenRouter models request failed: ${response.status}${body ? ` ${body.slice(0, 160)}` : ""}`,
    );
  }
  const json = (await response.json()) as { data?: OpenRouterModel[] };
  const models = Array.isArray(json.data) ? json.data : [];
  return models
    .filter((model) => typeof model.id === "string" && model.id)
    .map((model) => {
      const rawId = String(model.id);
      const supportedParameters = Array.isArray(model.supported_parameters)
        ? model.supported_parameters
        : [];
      return {
        id: encodeOpenRouterClaudeModelId(profile.id, rawId),
        rawId,
        label: typeof model.name === "string" && model.name ? model.name : rawId,
        provider: "openrouter-claude" as const,
        contextWindow:
          typeof model.context_length === "number"
            ? model.context_length
            : undefined,
        reasoning: supportedParameters.includes("reasoning"),
      };
    });
}

function manualHermesOpenRouterModels(): ProviderModelOption[] {
  const configured = [
    process.env.HERMES_OPENROUTER_MODEL,
    process.env.OPENROUTER_MODEL,
  ]
    .flatMap((value) => (value ?? "").split(","))
    .map((value) => value.trim())
    .filter(Boolean);

  return Array.from(new Set(configured)).map((rawId) => ({
    id: encodeHermesOpenRouterModelId(rawId),
    rawId,
    label: `openrouter:${rawId}`,
    provider: "hermes" as const,
  }));
}

async function fetchHermesOpenRouterModels(): Promise<ProviderModelOption[]> {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) return manualHermesOpenRouterModels();

  const configuredBaseUrl = (
    process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1"
  ).replace(/\/+$/, "");
  const baseUrl = configuredBaseUrl.endsWith("/api")
    ? `${configuredBaseUrl}/v1`
    : configuredBaseUrl;
  const response = await fetch(`${baseUrl}/models`, {
    headers: {
      authorization: `Bearer ${apiKey}`,
    },
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `OpenRouter models request failed: ${response.status}${body ? ` ${body.slice(0, 160)}` : ""}`,
    );
  }
  const json = (await response.json()) as { data?: OpenRouterModel[] };
  const models = Array.isArray(json.data) ? json.data : [];
  const options: ProviderModelOption[] = models
    .filter((model) => typeof model.id === "string" && model.id)
    .map((model) => {
      const rawId = String(model.id);
      const supportedParameters = Array.isArray(model.supported_parameters)
        ? model.supported_parameters
        : [];
      return {
        id: encodeHermesOpenRouterModelId(rawId),
        rawId,
        label:
          typeof model.name === "string" && model.name
            ? `openrouter:${model.name}`
            : `openrouter:${rawId}`,
        provider: "hermes" as const,
        contextWindow:
          typeof model.context_length === "number"
            ? model.context_length
            : undefined,
        reasoning: supportedParameters.includes("reasoning"),
      };
    });

  const existing = new Set(options.map((model) => model.rawId));
  for (const manual of manualHermesOpenRouterModels()) {
    if (!existing.has(manual.rawId)) options.push(manual);
  }
  return options;
}

export async function buildProviderCatalog(args: {
  claudeAuthenticated: boolean;
  claudeError?: string;
  codexAuthenticated: boolean;
  codexError?: string;
  hermesAuthenticated?: boolean;
  hermesError?: string;
  hermesModels?: ProviderModelOption[];
  store?: ProviderProfileStore;
}): Promise<ProviderCatalogResponse> {
  const anthropic = modelsConfig.providers.find(
    (provider) => provider.id === "anthropic",
  );
  const openai = modelsConfig.providers.find(
    (provider) => provider.id === "openai",
  );
  const store = args.store ?? providerProfileStore;
  const piProfiles = await store.listPiProfiles();
  const openRouterClaudeProfiles = await store.listOpenRouterClaudeProfiles();

  const groups: ProviderCatalogGroup[] = [
    builtinModelGroup(
      "claude",
      "Claude",
      "anthropic",
      anthropic?.models ?? [],
      args.claudeAuthenticated,
      args.claudeError,
    ),
    builtinModelGroup(
      "codex",
      "Codex",
      "openai",
      openai?.models ?? [],
      args.codexAuthenticated,
      args.codexError,
    ),
  ];

  let hermesModels: ProviderModelOption[] = args.hermesModels ?? [];
  let hermesCatalogError: string | undefined;
  if (!args.hermesModels) {
    // Legacy fallback for tests/development callers that do not run Hermes CLI
    // discovery. Runtime provider requests pass hermesModels explicitly so the
    // selector only exposes providers Hermes can actually use now.
    hermesModels = (openai?.models ?? []).map((model) => ({
      id: encodeHermesCodexModelId(model.id),
      rawId: model.id,
      label: model.id,
      provider: "hermes" as const,
    }));
    try {
      hermesModels = [...hermesModels, ...(await fetchHermesOpenRouterModels())];
    } catch (caught) {
      hermesCatalogError =
        caught instanceof Error ? caught.message : String(caught);
      hermesModels = [...hermesModels, ...manualHermesOpenRouterModels()];
    }
  }
  groups.push({
    id: "hermes",
    label: "Hermes",
    provider: "hermes",
    sourceProvider: "hermes-agent",
    authenticated: args.hermesAuthenticated ?? false,
    error: args.hermesError ?? hermesCatalogError,
    models: hermesModels,
  });

  for (const profile of piProfiles) {
    let models: ProviderModelOption[] = [];
    let error: string | undefined;
    try {
      const registryModels = getModels(profile.provider as KnownProvider);
      models = registryModels.map((model) =>
        toPiModelOption(profile.id, model),
      );
      const existing = new Set(models.map((model) => model.rawId));
      for (const rawId of profile.manualModels) {
        if (existing.has(rawId)) continue;
        models.push({
          id: encodePiModelId(profile.id, rawId),
          rawId,
          label: rawId,
          provider: "pi",
        });
      }
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
      models = profile.manualModels.map((rawId) => ({
        id: encodePiModelId(profile.id, rawId),
        rawId,
        label: rawId,
        provider: "pi",
      }));
    }

    groups.push({
      id: `pi:${profile.id}`,
      label: profile.name,
      provider: "pi",
      sourceProvider: profile.provider,
      profileId: profile.id,
      authenticated: Boolean(profile.apiKey),
      error,
      models,
    });
  }

  for (const profile of openRouterClaudeProfiles) {
    let models: ProviderModelOption[] = [];
    let error: string | undefined;
    try {
      models = await fetchOpenRouterModels(profile);
      const existing = new Set(models.map((model) => model.rawId));
      for (const rawId of profile.manualModels) {
        if (existing.has(rawId)) continue;
        models.push({
          id: encodeOpenRouterClaudeModelId(profile.id, rawId),
          rawId,
          label: rawId,
          provider: "openrouter-claude",
        });
      }
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
      models = profile.manualModels.map((rawId) => ({
        id: encodeOpenRouterClaudeModelId(profile.id, rawId),
        rawId,
        label: rawId,
        provider: "openrouter-claude",
      }));
    }

    groups.push({
      id: `openrouter-claude:${profile.id}`,
      label: profile.name,
      provider: "openrouter-claude",
      sourceProvider: "openrouter",
      profileId: profile.id,
      authenticated: Boolean(profile.apiKey),
      error,
      models,
    });
  }

  return {
    groups,
    piSupportedProviders: getProviders(),
    piProfiles: piProfiles.map(redactPiProfile),
    openRouterClaudeProfiles: openRouterClaudeProfiles.map(
      redactOpenRouterClaudeProfile,
    ),
  };
}

export const providerProfileStore = new ProviderProfileStore();
