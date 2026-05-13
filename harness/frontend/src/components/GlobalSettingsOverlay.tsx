import { useCallback, useContext, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { XMarkIcon } from "@heroicons/react/24/outline";
import type {
  OpenRouterClaudeProfileRequest,
  PiProviderProfileRequest,
  ProviderCatalogResponse,
  ProviderGlobalSettings,
  ProviderStatusResponse,
  RedactedProviderGlobalSettings,
  RedactedOpenRouterClaudeProfile,
  RedactedPiProviderProfile,
  ToolId,
  ToolManagerStatus,
} from "@shared/types";
import {
  getOpenRouterClaudeProfileUrl,
  getOpenRouterClaudeProfilesUrl,
  getProviderSettingsUrl,
  getProviderSettingsTelegramTestUrl,
  getPiProviderProfileUrl,
  getPiProviderProfilesUrl,
  getProvidersCatalogUrl,
  getProvidersStatusUrl,
  getToolsConfigUrl,
  getToolsStatusUrl,
  getToolsUpdateUrl,
} from "../config/api";
import { SettingsContext } from "../contexts/SettingsContextTypes";
import { usePoll } from "../hooks/usePoll";
import {
  getBrowserNotificationSupport,
  requestBrowserNotificationPermission,
  sendTestNotification,
} from "../utils/notifications";
import EnrollDevice from "../auth/EnrollDevice";
import CredentialsList from "../auth/CredentialsList";

interface GlobalSettingsOverlayProps {
  isOpen: boolean;
  onClose: () => void;
}

interface FormState {
  kind: "pi" | "openrouter-claude";
  id: string | null;
  name: string;
  provider: string;
  apiKey: string;
  baseUrl: string;
  headersJson: string;
  compatJson: string;
  denyOpenRouterDataCollection: boolean;
  manualModels: string;
}

const EMPTY_FORM: FormState = {
  kind: "pi",
  id: null,
  name: "",
  provider: "openrouter",
  apiKey: "",
  baseUrl: "",
  headersJson: "",
  compatJson: "",
  denyOpenRouterDataCollection: true,
  manualModels: "",
};

const EMPTY_OPENROUTER_CLAUDE_FORM: FormState = {
  ...EMPTY_FORM,
  kind: "openrouter-claude",
  name: "OpenRouterClaude",
  provider: "openrouter",
  baseUrl: "https://openrouter.ai/api",
};

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

function statusDot(ok: boolean): string {
  return ok ? "bg-[#3fb950]" : "bg-[#da3633]";
}

function parseJsonObject(
  value: string,
  label: string,
): Record<string, unknown> | null | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = JSON.parse(trimmed);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function profileToForm(profile: RedactedPiProviderProfile): FormState {
  return {
    kind: "pi",
    id: profile.id,
    name: profile.name,
    provider: profile.provider,
    apiKey: "",
    baseUrl: profile.baseUrl ?? "",
    headersJson: profile.headers
      ? JSON.stringify(profile.headers, null, 2)
      : "",
    compatJson: profile.compat ? JSON.stringify(profile.compat, null, 2) : "",
    denyOpenRouterDataCollection: profile.denyOpenRouterDataCollection ?? true,
    manualModels: profile.manualModels.join("\n"),
  };
}

function openRouterClaudeProfileToForm(
  profile: RedactedOpenRouterClaudeProfile,
): FormState {
  return {
    ...EMPTY_OPENROUTER_CLAUDE_FORM,
    id: profile.id,
    name: profile.name,
    apiKey: "",
    baseUrl: profile.baseUrl ?? "https://openrouter.ai/api",
    manualModels: profile.manualModels.join("\n"),
  };
}

function buildPayload(form: FormState): PiProviderProfileRequest {
  const headers = parseJsonObject(form.headersJson, "Headers") as
    | Record<string, string>
    | undefined;
  const compat = parseJsonObject(form.compatJson, "Compat");
  return {
    name: form.name.trim(),
    provider: form.provider,
    ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}),
    baseUrl: form.baseUrl.trim() || null,
    headers: headers ?? null,
    compat: compat ?? null,
    denyOpenRouterDataCollection: form.denyOpenRouterDataCollection,
    manualModels: form.manualModels
      .split(/\r?\n|,/)
      .map((item) => item.trim())
      .filter(Boolean),
  };
}

function buildOpenRouterClaudePayload(
  form: FormState,
): OpenRouterClaudeProfileRequest {
  return {
    name: form.name.trim(),
    ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}),
    baseUrl: form.baseUrl.trim() || null,
    manualModels: form.manualModels
      .split(/\r?\n|,/)
      .map((item) => item.trim())
      .filter(Boolean),
  };
}

export function GlobalSettingsOverlay({
  isOpen,
  onClose,
}: GlobalSettingsOverlayProps) {
  const settingsCtx = useContext(SettingsContext);
  const [status, setStatus] = useState<ProviderStatusResponse | null>(null);
  const [toolsStatus, setToolsStatus] = useState<ToolManagerStatus | null>(
    null,
  );
  const [nodeVersionsInput, setNodeVersionsInput] = useState("22");
  const [nodeVersionsDirty, setNodeVersionsDirty] = useState(false);
  const [activeSection, setActiveSection] = useState<"general" | "tools">(
    "general",
  );
  const [catalog, setCatalog] = useState<ProviderCatalogResponse | null>(null);
  const [providerSettings, setProviderSettings] =
    useState<RedactedProviderGlobalSettings>({
      defaultSubagentModel: "codex:gpt-5.5",
      openRouterClaudeProxyEnabled: true,
      openRouterClaudeProxyZdrEnabled: true,
      telegramOperatorNotificationsEnabled: false,
      telegramChatId: "",
      telegramBotTokenConfigured: false,
    });
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notificationError, setNotificationError] = useState<string | null>(
    null,
  );
  const [notificationInfo, setNotificationInfo] = useState<string | null>(null);
  const [telegramBotToken, setTelegramBotToken] = useState("");
  const [telegramChatId, setTelegramChatId] = useState("");
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [showForm, setShowForm] = useState(false);
  const [showAddOptions, setShowAddOptions] = useState(false);

  const refreshTools = useCallback(async (options?: {
    signal?: AbortSignal;
    syncNodeInput?: boolean;
  }) => {
    const response = await fetch(`${getToolsStatusUrl()}?fresh=1`, {
      signal: options?.signal,
    });
    if (!response.ok) {
      const json = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      throw new Error(json.error || "Failed to refresh tools status");
    }
    const nextToolsStatus = (await response.json()) as ToolManagerStatus;
    setToolsStatus(nextToolsStatus);
    if (options?.syncNodeInput !== false && !nodeVersionsDirty) {
      setNodeVersionsInput(
        nextToolsStatus.runtimes?.node.versions.join("\n") || "22",
      );
    }
    return nextToolsStatus;
  }, [nodeVersionsDirty]);

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      const [statusResponse, catalogResponse, providerSettingsResponse] =
        await Promise.all([
          fetch(`${getProvidersStatusUrl()}?fresh=1`),
          fetch(`${getProvidersCatalogUrl()}?fresh=1`),
          fetch(getProviderSettingsUrl()),
        ]);
      if (!statusResponse.ok)
        throw new Error("Failed to refresh provider status");
      if (!catalogResponse.ok)
        throw new Error("Failed to refresh provider catalog");
      if (!providerSettingsResponse.ok) {
        throw new Error("Failed to refresh provider settings");
      }
      setStatus((await statusResponse.json()) as ProviderStatusResponse);
      setCatalog((await catalogResponse.json()) as ProviderCatalogResponse);
      const nextProviderSettings =
        (await providerSettingsResponse.json()) as RedactedProviderGlobalSettings;
      await refreshTools();
      setProviderSettings(nextProviderSettings);
      setTelegramBotToken("");
      setTelegramChatId(nextProviderSettings.telegramChatId ?? "");
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Failed to load providers",
      );
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!isOpen) return;
    void refresh();
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, onClose]);

  const pollTools = useCallback(
    async (signal: AbortSignal) => {
      try {
        await refreshTools({ signal, syncNodeInput: false });
      } catch {
        // Keep the existing visible error; transient polling failures should not
        // make the controls feel broken while the backend/tool manager restarts.
      }
    },
    [refreshTools],
  );

  usePoll(pollTools, 5000, {
    enabled: isOpen && activeSection === "tools",
  });

  const piProviders = useMemo(
    () => catalog?.piSupportedProviders ?? ["openrouter"],
    [catalog],
  );
  const allModelOptions = useMemo(
    () =>
      catalog?.groups.flatMap((group) =>
        group.models.map((model) => ({
          ...model,
          groupLabel: group.label,
        })),
      ) ?? [],
    [catalog],
  );
  const defaultCodexModel = useMemo(
    () =>
      catalog?.groups
        .find((group) => group.provider === "codex")
        ?.models.find((model) => model.id.startsWith("codex:")) ?? null,
    [catalog],
  );
  const selectedDefaultSubagentModel =
    providerSettings.defaultSubagentModel ?? "";
  const selectedDefaultModelKnown = allModelOptions.some(
    (model) => model.id === selectedDefaultSubagentModel,
  );

  const notificationSupport = getBrowserNotificationSupport();

  if (!isOpen) return null;
  if (!settingsCtx) return null;

  const piProfiles = status?.piProfiles ?? catalog?.piProfiles ?? [];
  const openRouterClaudeProfiles =
    status?.openRouterClaudeProfiles ?? catalog?.openRouterClaudeProfiles ?? [];
  const { settings, updateSettings, toggleEnterBehavior } = settingsCtx;
  const flipFaviconOnUnread = settings.flipFaviconOnUnread ?? true;
  const telegramSettingsDirty =
    Boolean(telegramBotToken.trim()) ||
    telegramChatId !== (providerSettings.telegramChatId ?? "");
  const profileGroup = (id: string) => {
    return catalog?.groups.find((group) => group.profileId === id) ?? null;
  };

  const saveProviderSettings = async (
    updates: Partial<ProviderGlobalSettings>,
  ) => {
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(getProviderSettingsUrl(), {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(updates),
      });
      if (!response.ok) {
        const json = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(json.error || "Failed to save provider settings");
      }
      const nextProviderSettings =
        (await response.json()) as RedactedProviderGlobalSettings;
      setProviderSettings(nextProviderSettings);
      setTelegramChatId(nextProviderSettings.telegramChatId ?? "");
      if (
        Object.prototype.hasOwnProperty.call(updates, "telegramBotToken") &&
        updates.telegramBotToken
      ) {
        setTelegramBotToken("");
      }
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Failed to save provider settings",
      );
    } finally {
      setSaving(false);
    }
  };

  const toggleTaskCompletionNotifications = async () => {
    setNotificationError(null);
    setNotificationInfo(null);

    if (settings.taskCompletionNotifications) {
      updateSettings({ taskCompletionNotifications: false });
      return;
    }

    if (!notificationSupport.supported) {
      setNotificationError(
        "This browser does not support system notifications.",
      );
      return;
    }

    const permission =
      notificationSupport.permission === "granted"
        ? "granted"
        : await requestBrowserNotificationPermission();

    if (permission === "granted") {
      updateSettings({ taskCompletionNotifications: true });
      return;
    }

    setNotificationError(
      permission === "denied"
        ? "Browser notification permission is denied."
        : "Notification permission was not granted.",
    );
  };

  const testNotification = () => {
    setNotificationError(null);
    setNotificationInfo(null);
    const result = sendTestNotification();
    if (result.ok) {
      setNotificationInfo("Test notification sent.");
    } else {
      setNotificationError(result.error);
    }
  };

  const testTelegramNotification = async () => {
    setNotificationError(null);
    setNotificationInfo(null);
    try {
      const response = await fetch(getProviderSettingsTelegramTestUrl(), {
        method: "POST",
      });
      if (!response.ok) {
        const json = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(json.error || "Telegram notification failed");
      }
      setNotificationInfo("Telegram test notification sent.");
    } catch (caught) {
      setNotificationError(
        caught instanceof Error
          ? caught.message
          : "Telegram notification failed",
      );
    }
  };

  const updateToolsConfig = async (updates: {
    autoUpdate?: { enabled?: boolean; frequencyDays?: number };
    tools?: Partial<
      Record<ToolId, { enabled?: boolean; autoUpdate?: boolean }>
    >;
    runtimes?: {
      node?: {
        enabled?: boolean;
        autoInstallProjectVersions?: boolean;
        versions?: string[];
      };
    };
  }) => {
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(getToolsConfigUrl(), {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(updates),
      });
      if (!response.ok) {
        const json = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(json.error || "Failed to save tools settings");
      }
      await refreshTools();
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Failed to save tools settings",
      );
    } finally {
      setSaving(false);
    }
  };

  const updateToolsNow = async () => {
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(getToolsUpdateUrl(), { method: "POST" });
      if (!response.ok) {
        const json = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(json.error || "Failed to start tool update");
      }
      setToolsStatus((current) =>
        current
          ? {
              ...current,
              state: "updating",
              message: "Tool update started",
              updatedAt: Date.now(),
            }
          : current,
      );
      await refreshTools();
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Failed to start tool update",
      );
    } finally {
      setSaving(false);
    }
  };

  const openHermesConfigTerminal = () => {
    onClose();
    window.dispatchEvent(
      new CustomEvent("run-terminal-command", {
        detail: {
          command: "EDITOR=nano VISUAL=nano hermes config edit",
          switchToTerminal: true,
          alwaysNewSession: true,
          sessionName: "Hermes Config",
        },
      }),
    );
  };

  const startAdd = () => {
    const provider = piProviders.includes("openrouter")
      ? "openrouter"
      : (piProviders[0] ?? "openrouter");
    setForm({
      ...EMPTY_FORM,
      name: piProviderDisplayName(provider),
      provider,
    });
    setShowAddOptions(false);
    setShowForm(true);
    setError(null);
  };

  const startAddOpenRouterClaude = () => {
    setForm(EMPTY_OPENROUTER_CLAUDE_FORM);
    setShowAddOptions(false);
    setShowForm(true);
    setError(null);
  };

  const startEdit = (profile: RedactedPiProviderProfile) => {
    setForm(profileToForm(profile));
    setShowForm(true);
    setError(null);
  };

  const startEditOpenRouterClaude = (
    profile: RedactedOpenRouterClaudeProfile,
  ) => {
    setForm(openRouterClaudeProfileToForm(profile));
    setShowForm(true);
    setError(null);
  };

  const saveProfile = async () => {
    setSaving(true);
    setError(null);
    try {
      if (!form.name.trim()) throw new Error("Name is required");
      if (form.kind === "pi" && !form.provider)
        throw new Error("Provider is required");
      if (!form.id && !form.apiKey.trim())
        throw new Error("API key is required");
      const payload =
        form.kind === "openrouter-claude"
          ? buildOpenRouterClaudePayload(form)
          : buildPayload(form);
      const response = await fetch(
        form.kind === "openrouter-claude"
          ? form.id
            ? getOpenRouterClaudeProfileUrl(form.id)
            : getOpenRouterClaudeProfilesUrl()
          : form.id
            ? getPiProviderProfileUrl(form.id)
            : getPiProviderProfilesUrl(),
        {
          method: form.id ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(body.error ?? "Failed to save profile");
      }
      setShowForm(false);
      setForm(EMPTY_FORM);
      await refresh();
      window.dispatchEvent(new Event("providers-invalidated"));
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Failed to save profile",
      );
    } finally {
      setSaving(false);
    }
  };

  const deleteProfile = async (profile: RedactedPiProviderProfile) => {
    setError(null);
    const response = await fetch(getPiProviderProfileUrl(profile.id), {
      method: "DELETE",
    });
    if (!response.ok) {
      setError("Failed to delete profile");
      return;
    }
    await refresh();
    window.dispatchEvent(new Event("providers-invalidated"));
  };

  const deleteOpenRouterClaudeProfile = async (
    profile: RedactedOpenRouterClaudeProfile,
  ) => {
    setError(null);
    const response = await fetch(getOpenRouterClaudeProfileUrl(profile.id), {
      method: "DELETE",
    });
    if (!response.ok) {
      setError("Failed to delete profile");
      return;
    }
    await refresh();
    window.dispatchEvent(new Event("providers-invalidated"));
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[300] bg-[#0d1117] text-[#e6edf3] flex flex-col"
      data-testid="global-provider-settings"
    >
      <div className="h-12 px-4 border-b border-[#30363d] flex items-center gap-3 shrink-0">
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold">Global Settings</h2>
          <p className="text-[11px] text-[#8b949e]">
            Authentication, providers, and notifications
          </p>
        </div>
        {loading && (
          <span className="text-xs text-[#8b949e]">Refreshing...</span>
        )}
        <button
          type="button"
          onClick={onClose}
          className="p-2 rounded-md text-[#8b949e] hover:text-[#e6edf3] hover:bg-[#21262d]"
          aria-label="Close global settings"
          data-testid="provider-settings-close"
        >
          <XMarkIcon className="w-5 h-5" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-3 md:p-6">
        <div className="max-w-6xl mx-auto grid gap-4 md:grid-cols-[150px_minmax(0,1fr)]">
          <nav
            className="md:sticky md:top-0 md:self-start flex md:flex-col gap-2 overflow-x-auto pb-1 md:pb-0"
            aria-label="Settings sections"
          >
            {(["general", "tools"] as const).map((section) => (
              <button
                key={section}
                type="button"
                onClick={() => setActiveSection(section)}
                className={`shrink-0 rounded-md px-3 py-2 text-left text-sm capitalize transition-colors ${
                  activeSection === section
                    ? "bg-[#1f6feb] text-white"
                    : "text-[#8b949e] hover:bg-[#21262d] hover:text-[#e6edf3]"
                }`}
                aria-current={activeSection === section ? "page" : undefined}
              >
                {section}
              </button>
            ))}
          </nav>
          <div
            className={`min-w-0 grid gap-6 ${
              activeSection === "general" && showForm
                ? "lg:grid-cols-[minmax(0,1fr)_360px]"
                : ""
            }`}
          >
            <main className="space-y-6">
              {error && (
                <div className="border border-[#f85149]/40 bg-[#3d1214]/30 text-[#ff7b72] rounded-md px-3 py-2 text-sm">
                  {error}
                </div>
              )}

              {activeSection === "general" && (
                <>
                  <section className="space-y-3">
                    <div className="flex items-center justify-between gap-3">
                      <h3 className="text-sm font-medium text-[#c9d1d9]">
                        Subagents
                      </h3>
                      {saving && (
                        <span className="text-xs text-[#8b949e]">
                          Saving...
                        </span>
                      )}
                    </div>
                    <div className="border border-[#30363d] bg-[#161b22] rounded-lg px-3 py-3">
                      <label className="block space-y-1">
                        <span className="text-sm text-[#c9d1d9]">
                          Default Claude subagent model
                        </span>
                        <select
                          value={selectedDefaultSubagentModel}
                          onChange={(event) =>
                            void saveProviderSettings({
                              defaultSubagentModel: event.target.value,
                            })
                          }
                          className="w-full bg-[#0d1117] border border-[#30363d] rounded-md px-2 py-1.5 text-sm focus:outline-none focus:border-[#58a6ff]"
                          data-testid="default-subagent-model"
                        >
                          {!selectedDefaultModelKnown &&
                            selectedDefaultSubagentModel && (
                              <option value={selectedDefaultSubagentModel}>
                                {selectedDefaultSubagentModel}
                              </option>
                            )}
                          {allModelOptions.map((model) => (
                            <option key={model.id} value={model.id}>
                              {model.label} · {model.groupLabel}
                            </option>
                          ))}
                        </select>
                      </label>
                      <p className="text-xs text-[#8b949e] mt-2">
                        Used for any subagent spawned without an explicit model.
                        The initial default is{" "}
                        {defaultCodexModel?.label ?? "gpt-5.5"}.
                      </p>
                    </div>
                  </section>

                  <section className="space-y-3">
                    <div className="flex items-center justify-between gap-3">
                      <h3 className="text-sm font-medium text-[#c9d1d9]">
                        Built-in Providers
                      </h3>
                      <button
                        type="button"
                        onClick={() => void refresh()}
                        className="text-xs px-2 py-1 rounded-md border border-[#30363d] text-[#8b949e] hover:text-[#e6edf3] hover:bg-[#21262d]"
                      >
                        Refresh
                      </button>
                    </div>
                    <div className="grid gap-2 sm:grid-cols-2">
                      {(["claude", "codex", "hermes"] as const).map((id) => {
                        const provider = status?.providers?.[id];
                        const authenticated = provider?.authenticated ?? false;
                        return (
                          <div
                            key={id}
                            className="border border-[#30363d] bg-[#161b22] rounded-lg px-3 py-3"
                          >
                            <div className="flex items-center gap-2">
                              <span
                                className={`w-2 h-2 rounded-full ${statusDot(authenticated)}`}
                              />
                              <span className="text-sm font-medium">
                                {provider?.name ??
                                  (id === "claude"
                                    ? "Claude"
                                    : id === "codex"
                                      ? "Codex"
                                      : "Hermes")}
                              </span>
                              <span className="ml-auto text-[10px] text-[#8b949e]">
                                {id === "hermes"
                                  ? authenticated
                                    ? "Configured"
                                    : "Needs config"
                                  : authenticated
                                    ? "Signed in"
                                    : "Not signed in"}
                              </span>
                            </div>
                            {provider?.error && !authenticated && (
                              <p className="mt-1 text-xs text-[#d29922]">
                                {provider.error}
                              </p>
                            )}
                            {id === "hermes" && (
                              <button
                                type="button"
                                onClick={openHermesConfigTerminal}
                                className="mt-2 rounded-md border border-[#30363d] px-2 py-1 text-xs font-medium text-[#8b949e] transition-colors hover:bg-[#21262d] hover:text-[#e6edf3]"
                                data-testid="configure-hermes-provider"
                              >
                                Configure
                              </button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </section>
                </>
              )}

              {activeSection === "tools" && (
                <section className="space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <h3 className="text-sm font-medium text-[#c9d1d9]">
                      Tools
                    </h3>
                    <button
                      type="button"
                      onClick={() => void updateToolsNow()}
                      className="text-xs px-2 py-1 rounded-md border border-[#30363d] text-[#8b949e] hover:text-[#e6edf3] hover:bg-[#21262d]"
                    >
                      Update now
                    </button>
                  </div>
                  <div className="border border-[#30363d] bg-[#161b22] rounded-lg px-3 py-3 space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <div className="text-sm text-[#c9d1d9]">
                          Persistent tool manager
                        </div>
                        <p className="text-xs text-[#8b949e] mt-1">
                          Installs mutable CLIs into{" "}
                          {toolsStatus?.toolsRoot ?? "~/.swarmfleet/tools"}.
                        </p>
                        {toolsStatus && (
                          <p className="text-xs text-[#8b949e] mt-1">
                            {toolsStatus.state === "updating"
                              ? "Updating"
                              : toolsStatus.state === "error"
                                ? "Error"
                                : "Ready"}{" "}
                            · {toolsStatus.message}
                          </p>
                        )}
                      </div>
                      <button
                        type="button"
                        onClick={() =>
                          void updateToolsConfig({
                            autoUpdate: {
                              enabled: !(
                                toolsStatus?.autoUpdate.enabled ?? true
                              ),
                            },
                          })
                        }
                        role="switch"
                        aria-checked={toolsStatus?.autoUpdate.enabled ?? true}
                        className={`relative w-10 h-5 rounded-full transition-colors ${
                          (toolsStatus?.autoUpdate.enabled ?? true)
                            ? "bg-[#58a6ff]"
                            : "bg-[#484f58]"
                        }`}
                      >
                        <span
                          className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                            (toolsStatus?.autoUpdate.enabled ?? true)
                              ? "translate-x-5"
                              : ""
                          }`}
                        />
                      </button>
                    </div>
                    <label className="block space-y-1">
                      <span className="text-xs text-[#8b949e]">
                        Update frequency
                      </span>
                      <select
                        value={toolsStatus?.autoUpdate.frequencyDays ?? 7}
                        onChange={(event) =>
                          void updateToolsConfig({
                            autoUpdate: {
                              frequencyDays: Number(event.target.value),
                            },
                          })
                        }
                        className="w-full bg-[#0d1117] border border-[#30363d] rounded-md px-2 py-1.5 text-sm focus:outline-none focus:border-[#58a6ff]"
                      >
                        <option value={1}>Daily</option>
                        <option value={3}>Every 3 days</option>
                        <option value={7}>Weekly</option>
                        <option value={14}>Every 2 weeks</option>
                        <option value={28}>Every 4 weeks</option>
                      </select>
                    </label>
                    <div className="border border-[#30363d] bg-[#0d1117] rounded-lg px-3 py-3 space-y-2">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <div className="text-sm font-medium text-[#c9d1d9]">
                            Node runtimes
                          </div>
                          <p className="text-xs text-[#8b949e]">
                            User shells use persisted mise and honor
                            .node-version.
                          </p>
                        </div>
                        <label className="flex items-center gap-2 text-xs text-[#8b949e]">
                          <input
                            type="checkbox"
                            checked={
                              toolsStatus?.runtimes?.node.enabled ?? true
                            }
                            onChange={(event) =>
                              void updateToolsConfig({
                                runtimes: {
                                  node: { enabled: event.target.checked },
                                },
                              })
                            }
                            className="h-4 w-4 accent-[#238636]"
                          />
                          Manage
                        </label>
                      </div>
                      <label className="flex items-start gap-2 text-xs text-[#8b949e]">
                        <input
                          type="checkbox"
                          checked={
                            toolsStatus?.runtimes?.node
                              .autoInstallProjectVersions ?? true
                          }
                          onChange={(event) =>
                            void updateToolsConfig({
                              runtimes: {
                                node: {
                                  autoInstallProjectVersions:
                                    event.target.checked,
                                },
                              },
                            })
                          }
                          className="mt-0.5 h-4 w-4 accent-[#238636]"
                        />
                        Auto-install .node-version/.nvmrc versions found under
                        /workspace
                      </label>
                      <label className="block space-y-1">
                        <span className="text-xs text-[#8b949e]">
                          Pinned Node versions
                        </span>
                        <textarea
                          value={nodeVersionsInput}
                          onChange={(event) => {
                            setNodeVersionsDirty(true);
                            setNodeVersionsInput(event.target.value);
                          }}
                          onBlur={() => {
                            setNodeVersionsDirty(false);
                            void updateToolsConfig({
                              runtimes: {
                                node: {
                                  versions: nodeVersionsInput
                                    .split(/\r?\n|,/)
                                    .map((item) => item.trim())
                                    .filter(Boolean),
                                },
                              },
                            });
                          }}
                          rows={2}
                          className="w-full bg-[#010409] border border-[#30363d] rounded-md px-2 py-1.5 text-xs font-mono focus:outline-none focus:border-[#58a6ff]"
                        />
                      </label>
                      <p className="text-[11px] text-[#8b949e]">
                        Installed:{" "}
                        {toolsStatus?.runtimes?.node.installedVersions.join(
                          ", ",
                        ) || "none yet"}
                      </p>
                      <p className="text-[11px] text-[#8b949e] truncate">
                        mise:{" "}
                        {toolsStatus?.runtimes?.node.miseDataDir ??
                          "~/.local/share/mise"}
                      </p>
                    </div>
                    <div className="grid gap-2 sm:grid-cols-2">
                      {(
                        [
                          "hermes",
                          "chrome-devtools-mcp",
                          "claude",
                          "codex",
                        ] as ToolId[]
                      ).map((id) => {
                        const tool = toolsStatus?.tools[id];
                        return (
                          <div
                            key={id}
                            className="border border-[#30363d] bg-[#0d1117] rounded-lg px-3 py-3"
                          >
                            <div className="flex items-center gap-2">
                              <span
                                className={`w-2 h-2 rounded-full ${statusDot(Boolean(tool?.installed))}`}
                              />
                              <span className="text-sm font-medium">
                                {tool?.name ?? id}
                              </span>
                              <span className="ml-auto text-[10px] text-[#8b949e]">
                                {tool?.installed ? "Installed" : "Missing"}
                              </span>
                            </div>
                            <p className="mt-1 text-xs text-[#8b949e] truncate">
                              {tool?.version ?? "No version reported"}
                            </p>
                            {tool?.signedIn !== null &&
                              tool?.signedIn !== undefined && (
                                <p className="mt-1 text-[11px] text-[#8b949e]">
                                  {tool.signedIn
                                    ? "Signed in"
                                    : "Not signed in"}
                                </p>
                              )}
                            <label className="mt-2 flex items-center gap-2 text-xs text-[#8b949e]">
                              <input
                                type="checkbox"
                                checked={tool?.enabled ?? false}
                                onChange={(event) =>
                                  void updateToolsConfig({
                                    tools: {
                                      [id]: { enabled: event.target.checked },
                                    },
                                  })
                                }
                                className="h-4 w-4 accent-[#238636]"
                              />
                              Enabled
                            </label>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </section>
              )}

              {activeSection === "general" && (
                <>
                  <section className="space-y-2">
                    <div className="flex items-center justify-between gap-3">
                      <h3 className="text-sm font-medium text-[#c9d1d9]">
                        Additional Providers
                      </h3>
                      <div className="relative">
                        <button
                          type="button"
                          onClick={() => setShowAddOptions((open) => !open)}
                          className="text-xs px-3 py-1.5 rounded-md bg-[#238636] text-white hover:bg-[#2ea043]"
                          data-testid="add-provider-profile"
                          aria-label="Add provider"
                        >
                          +
                        </button>
                        {showAddOptions && (
                          <div className="absolute right-0 top-full mt-1 w-56 rounded-md border border-[#30363d] bg-[#161b22] shadow-xl z-10 overflow-hidden">
                            <button
                              type="button"
                              onClick={startAdd}
                              className="block w-full px-3 py-2 text-left text-xs text-[#c9d1d9] hover:bg-[#21262d]"
                            >
                              Pi agent
                            </button>
                            <button
                              type="button"
                              onClick={startAddOpenRouterClaude}
                              className="block w-full px-3 py-2 text-left text-xs text-[#c9d1d9] hover:bg-[#21262d]"
                            >
                              OpenRouter through Claude Code
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                    <label className="flex items-start gap-2 rounded-md border border-[#30363d] bg-[#161b22] px-3 py-2">
                      <input
                        type="checkbox"
                        checked={providerSettings.openRouterClaudeProxyEnabled}
                        onChange={(event) =>
                          void saveProviderSettings({
                            openRouterClaudeProxyEnabled: event.target.checked,
                          })
                        }
                        className="mt-0.5 h-4 w-4 accent-[#238636]"
                        data-testid="openrouter-claude-proxy-enabled"
                      />
                      <span className="min-w-0">
                        <span className="block text-xs text-[#c9d1d9]">
                          Use SwarmFleet proxy for OpenRouter through Claude
                          Code
                        </span>
                        <span className="block text-[11px] text-[#8b949e]">
                          Injects the stored API key and
                          provider.data_collection = deny.
                        </span>
                      </span>
                    </label>
                    <label className="flex items-start gap-2 rounded-md border border-[#30363d] bg-[#161b22] px-3 py-2">
                      <input
                        type="checkbox"
                        checked={
                          providerSettings.openRouterClaudeProxyZdrEnabled
                        }
                        onChange={(event) =>
                          void saveProviderSettings({
                            openRouterClaudeProxyZdrEnabled:
                              event.target.checked,
                          })
                        }
                        className="mt-0.5 h-4 w-4 accent-[#238636]"
                        data-testid="openrouter-claude-proxy-zdr-enabled"
                      />
                      <span className="min-w-0">
                        <span className="block text-xs text-[#c9d1d9]">
                          Require Zero Data Retention endpoints
                        </span>
                        <span className="block text-[11px] text-[#8b949e]">
                          Adds provider.zdr = true to proxied OpenRouter
                          requests.
                        </span>
                      </span>
                    </label>
                    <div className="space-y-2">
                      {openRouterClaudeProfiles.map((profile) => {
                        const group =
                          catalog?.groups.find(
                            (candidate) =>
                              candidate.provider === "openrouter-claude" &&
                              candidate.profileId === profile.id,
                          ) ?? null;
                        return (
                          <div
                            key={profile.id}
                            className="border border-[#30363d] bg-[#161b22] rounded-lg px-3 py-3"
                          >
                            <div className="flex items-start gap-3">
                              <span
                                className={`mt-1.5 w-2 h-2 rounded-full ${statusDot(profile.hasApiKey)}`}
                              />
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2">
                                  <span className="text-sm font-medium truncate">
                                    {profile.name}
                                  </span>
                                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#21262d] text-[#8b949e]">
                                    OpenRouterClaude
                                  </span>
                                </div>
                                <p className="mt-1 text-xs text-[#8b949e]">
                                  {profile.hasApiKey
                                    ? "API key stored"
                                    : "No API key"}{" "}
                                  · {group?.models.length ?? 0} models
                                </p>
                                <p className="mt-0.5 text-[11px] text-[#8b949e] truncate">
                                  {profile.baseUrl ??
                                    "https://openrouter.ai/api"}
                                </p>
                                {group?.error && (
                                  <p className="mt-0.5 text-xs text-[#d29922] truncate">
                                    {group.error}
                                  </p>
                                )}
                              </div>
                              <div className="flex items-center gap-1 shrink-0">
                                <button
                                  type="button"
                                  onClick={() =>
                                    startEditOpenRouterClaude(profile)
                                  }
                                  className="text-xs px-2 py-1 rounded-md border border-[#30363d] text-[#58a6ff] hover:bg-[#21262d]"
                                >
                                  Edit
                                </button>
                                <button
                                  type="button"
                                  onClick={() =>
                                    void deleteOpenRouterClaudeProfile(profile)
                                  }
                                  className="text-xs px-2 py-1 rounded-md border border-[#30363d] text-[#ff7b72] hover:bg-[#3d1214]"
                                >
                                  Delete
                                </button>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                      {piProfiles.map((profile) => {
                        const group = profileGroup(profile.id);
                        return (
                          <div
                            key={profile.id}
                            className="border border-[#30363d] bg-[#161b22] rounded-lg px-3 py-3"
                          >
                            <div className="flex items-start gap-3">
                              <span
                                className={`mt-1.5 w-2 h-2 rounded-full ${statusDot(profile.hasApiKey)}`}
                              />
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2">
                                  <span className="text-sm font-medium truncate">
                                    {profile.name}
                                  </span>
                                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#21262d] text-[#8b949e]">
                                    {profile.provider}
                                  </span>
                                </div>
                                <p className="mt-1 text-xs text-[#8b949e]">
                                  {profile.hasApiKey
                                    ? "API key stored"
                                    : "No API key"}{" "}
                                  · {group?.models.length ?? 0} models
                                </p>
                                {group?.error && (
                                  <p className="mt-0.5 text-xs text-[#d29922] truncate">
                                    {group.error}
                                  </p>
                                )}
                                {profile.baseUrl && (
                                  <p className="mt-0.5 text-[11px] text-[#8b949e] truncate">
                                    {profile.baseUrl}
                                  </p>
                                )}
                                {profile.provider === "openrouter" &&
                                  profile.denyOpenRouterDataCollection && (
                                    <p className="mt-0.5 text-[11px] text-[#8b949e]">
                                      Data collection denied
                                    </p>
                                  )}
                              </div>
                              <div className="flex items-center gap-1 shrink-0">
                                <button
                                  type="button"
                                  onClick={() => startEdit(profile)}
                                  className="text-xs px-2 py-1 rounded-md border border-[#30363d] text-[#58a6ff] hover:bg-[#21262d]"
                                >
                                  Edit
                                </button>
                                <button
                                  type="button"
                                  onClick={() => void deleteProfile(profile)}
                                  className="text-xs px-2 py-1 rounded-md border border-[#30363d] text-[#ff7b72] hover:bg-[#3d1214]"
                                >
                                  Delete
                                </button>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                      {piProfiles.length === 0 &&
                        openRouterClaudeProfiles.length === 0 && (
                          <div className="border border-dashed border-[#30363d] rounded-lg px-3 py-6 text-center text-sm text-[#8b949e]">
                            No additional providers yet.
                          </div>
                        )}
                    </div>
                  </section>

                  <section className="space-y-3">
                    <div className="flex items-center justify-between gap-3">
                      <h3 className="text-sm font-medium text-[#c9d1d9]">
                        Notifications
                      </h3>
                    </div>
                    <div className="border border-[#30363d] bg-[#161b22] rounded-lg px-3 py-3">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <div className="text-sm text-[#c9d1d9]">
                            Task completion notifications
                          </div>
                          <p className="text-xs text-[#8b949e] mt-1">
                            Show a browser notification with project, session,
                            and the latest event excerpt when a task finishes.
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() =>
                            void toggleTaskCompletionNotifications()
                          }
                          data-testid="task-notification-toggle"
                          role="switch"
                          aria-checked={settings.taskCompletionNotifications}
                          className={`relative w-10 h-5 rounded-full transition-colors ${
                            settings.taskCompletionNotifications
                              ? "bg-[#58a6ff]"
                              : "bg-[#484f58]"
                          }`}
                        >
                          <span
                            className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                              settings.taskCompletionNotifications
                                ? "translate-x-5"
                                : ""
                            }`}
                          />
                        </button>
                      </div>
                      <div className="mt-3 flex items-center justify-between gap-3">
                        <p className="text-xs text-[#8b949e]">
                          Browser permission:{" "}
                          <span className="text-[#c9d1d9]">
                            {notificationSupport.permission}
                          </span>
                        </p>
                        <button
                          type="button"
                          onClick={testNotification}
                          disabled={
                            !notificationSupport.supported ||
                            notificationSupport.permission !== "granted"
                          }
                          className={`text-xs px-2 py-1 rounded-md border border-[#30363d] ${
                            notificationSupport.supported &&
                            notificationSupport.permission === "granted"
                              ? "text-[#8b949e] hover:text-[#e6edf3] hover:bg-[#21262d]"
                              : "text-[#484f58] cursor-not-allowed"
                          }`}
                        >
                          Send test
                        </button>
                      </div>
                      <div className="mt-4 pt-4 border-t border-[#30363d] flex items-center justify-between gap-3">
                        <div>
                          <div className="text-sm text-[#c9d1d9]">
                            Hide notifications if activity is detected
                          </div>
                          <p className="text-xs text-[#8b949e] mt-1">
                            Suppress task notifications while this UI is visible
                            and user activity was detected in the last minute.
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() =>
                            updateSettings({
                              hideNotificationsWhenActive:
                                !settings.hideNotificationsWhenActive,
                            })
                          }
                          role="switch"
                          aria-checked={settings.hideNotificationsWhenActive}
                          disabled={!settings.taskCompletionNotifications}
                          className={`relative w-10 h-5 rounded-full transition-colors ${
                            settings.hideNotificationsWhenActive
                              ? "bg-[#58a6ff]"
                              : "bg-[#484f58]"
                          } ${
                            settings.taskCompletionNotifications
                              ? ""
                              : "opacity-50 cursor-not-allowed"
                          }`}
                        >
                          <span
                            className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                              settings.hideNotificationsWhenActive
                                ? "translate-x-5"
                                : ""
                            }`}
                          />
                        </button>
                      </div>
                      <div className="mt-4 pt-4 border-t border-[#30363d] flex items-center justify-between gap-3">
                        <div>
                          <div className="text-sm text-[#c9d1d9]">
                            Agent operator Telegram notifications
                          </div>
                          <p className="text-xs text-[#8b949e] mt-1">
                            Expose notify_operator(message) to agents through
                            SwarmFleet MCP.
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() =>
                            void saveProviderSettings({
                              telegramOperatorNotificationsEnabled:
                                !providerSettings.telegramOperatorNotificationsEnabled,
                            })
                          }
                          role="switch"
                          aria-checked={
                            providerSettings.telegramOperatorNotificationsEnabled
                          }
                          className={`relative w-10 h-5 rounded-full transition-colors ${
                            providerSettings.telegramOperatorNotificationsEnabled
                              ? "bg-[#58a6ff]"
                              : "bg-[#484f58]"
                          }`}
                        >
                          <span
                            className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                              providerSettings.telegramOperatorNotificationsEnabled
                                ? "translate-x-5"
                                : ""
                            }`}
                          />
                        </button>
                      </div>
                      <div className="mt-3 grid gap-3 md:grid-cols-[1fr_180px]">
                        <label className="block space-y-1">
                          <span className="text-xs text-[#8b949e]">
                            Telegram bot token
                          </span>
                          <input
                            type="password"
                            value={telegramBotToken}
                            onChange={(event) =>
                              setTelegramBotToken(event.target.value)
                            }
                            placeholder={
                              providerSettings.telegramBotTokenConfigured
                                ? "Stored"
                                : "123456:ABC..."
                            }
                            className="w-full bg-[#0d1117] border border-[#30363d] rounded-md px-2 py-1.5 text-sm focus:outline-none focus:border-[#58a6ff]"
                          />
                        </label>
                        <label className="block space-y-1">
                          <span className="text-xs text-[#8b949e]">
                            Telegram chat ID
                          </span>
                          <input
                            type="text"
                            value={telegramChatId}
                            onChange={(event) =>
                              setTelegramChatId(event.target.value)
                            }
                            placeholder="123456789"
                            className="w-full bg-[#0d1117] border border-[#30363d] rounded-md px-2 py-1.5 text-sm focus:outline-none focus:border-[#58a6ff]"
                          />
                        </label>
                      </div>
                      <div className="mt-3 flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          onClick={() =>
                            void saveProviderSettings({
                              telegramBotToken,
                              telegramChatId,
                            })
                          }
                          disabled={!telegramSettingsDirty}
                          className={`text-xs px-2 py-1 rounded-md border border-[#30363d] ${
                            telegramSettingsDirty
                              ? "text-[#8b949e] hover:text-[#e6edf3] hover:bg-[#21262d]"
                              : "text-[#484f58] cursor-not-allowed"
                          }`}
                        >
                          Save Telegram settings
                        </button>
                        {providerSettings.telegramBotTokenConfigured && (
                          <button
                            type="button"
                            onClick={() =>
                              void saveProviderSettings({
                                telegramBotToken: "",
                              })
                            }
                            className="text-xs px-2 py-1 rounded-md border border-[#30363d] text-[#ff7b72] hover:bg-[#3d1214]"
                          >
                            Clear token
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => void testTelegramNotification()}
                          disabled={
                            !providerSettings.telegramOperatorNotificationsEnabled ||
                            !providerSettings.telegramBotTokenConfigured ||
                            !providerSettings.telegramChatId
                          }
                          className={`text-xs px-2 py-1 rounded-md border border-[#30363d] ${
                            providerSettings.telegramOperatorNotificationsEnabled &&
                            providerSettings.telegramBotTokenConfigured &&
                            providerSettings.telegramChatId
                              ? "text-[#8b949e] hover:text-[#e6edf3] hover:bg-[#21262d]"
                              : "text-[#484f58] cursor-not-allowed"
                          }`}
                        >
                          Send Telegram test
                        </button>
                      </div>
                      <div className="mt-4 pt-4 border-t border-[#30363d] flex items-center justify-between gap-3">
                        <div>
                          <div className="text-sm text-[#c9d1d9]">
                            Flip favicon for unread sessions
                          </div>
                          <p className="text-xs text-[#8b949e] mt-1">
                            Turn the browser tab icon upside down while any
                            session has unread activity.
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() =>
                            updateSettings({
                              flipFaviconOnUnread: !flipFaviconOnUnread,
                            })
                          }
                          role="switch"
                          aria-checked={flipFaviconOnUnread}
                          className={`relative w-10 h-5 rounded-full transition-colors ${
                            flipFaviconOnUnread
                              ? "bg-[#58a6ff]"
                              : "bg-[#484f58]"
                          }`}
                        >
                          <span
                            className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                              flipFaviconOnUnread ? "translate-x-5" : ""
                            }`}
                          />
                        </button>
                      </div>
                      {!notificationSupport.supported && (
                        <p className="text-xs text-[#d29922] mt-3">
                          System notifications are not available in this
                          browser.
                        </p>
                      )}
                      {notificationSupport.supported &&
                        notificationSupport.permission === "denied" && (
                          <p className="text-xs text-[#d29922] mt-3">
                            Browser permission is denied. Re-enable
                            notifications in the browser site settings.
                          </p>
                        )}
                      {notificationError && (
                        <p className="text-xs text-[#f85149] mt-3">
                          {notificationError}
                        </p>
                      )}
                      {notificationInfo && (
                        <p className="text-xs text-[#3fb950] mt-3">
                          {notificationInfo}
                        </p>
                      )}
                    </div>
                  </section>

                  <section className="space-y-3">
                    <div className="flex items-center justify-between gap-3">
                      <h3 className="text-sm font-medium text-[#c9d1d9]">
                        Composer
                      </h3>
                    </div>
                    <div className="border border-[#30363d] bg-[#161b22] rounded-lg px-3 py-3">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <div className="text-sm text-[#c9d1d9]">
                            {settings.enterBehavior === "send"
                              ? "Enter sends message"
                              : "Enter adds new line"}
                          </div>
                          <p className="text-xs text-[#8b949e] mt-1">
                            This {settingsCtx?.composerDevice ?? "desktop"}{" "}
                            setting is saved locally on this device.{" "}
                            {settings.enterBehavior === "send"
                              ? "Shift+Enter always adds a new line."
                              : "Use Ctrl/Cmd+Enter or the send button to send."}
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={toggleEnterBehavior}
                          data-testid="enter-behavior-toggle"
                          role="switch"
                          aria-checked={settings.enterBehavior === "send"}
                          className={`relative w-10 h-5 rounded-full transition-colors ${
                            settings.enterBehavior === "send"
                              ? "bg-[#58a6ff]"
                              : "bg-[#484f58]"
                          }`}
                        >
                          <span
                            className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                              settings.enterBehavior === "send"
                                ? "translate-x-5"
                                : ""
                            }`}
                          />
                        </button>
                      </div>
                    </div>
                  </section>

                  <section className="space-y-2">
                    <h3 className="text-sm font-medium text-[#c9d1d9]">
                      Devices & Authentication
                    </h3>
                    <div className="space-y-2">
                      <EnrollDevice />
                      <CredentialsList />
                    </div>
                  </section>
                </>
              )}
            </main>

            {activeSection === "general" && showForm && (
              <aside className="border border-[#30363d] bg-[#161b22] rounded-lg p-4 h-fit space-y-3">
                <div>
                  <h3 className="text-sm font-medium">
                    {form.id
                      ? form.kind === "openrouter-claude"
                        ? "Edit OpenRouterClaude"
                        : "Edit Pi Profile"
                      : form.kind === "openrouter-claude"
                        ? "Add OpenRouterClaude"
                        : "Add Pi Profile"}
                  </h3>
                  <p className="text-xs text-[#8b949e] mt-0.5">
                    Keys stay in the backend profile store.
                  </p>
                </div>

                <label className="block space-y-1">
                  <span className="text-xs text-[#8b949e]">Display name</span>
                  <input
                    value={form.name}
                    onChange={(event) =>
                      setForm({ ...form, name: event.target.value })
                    }
                    className="w-full bg-[#0d1117] border border-[#30363d] rounded-md px-2 py-1.5 text-sm focus:outline-none focus:border-[#58a6ff]"
                    data-testid="pi-profile-name"
                  />
                </label>

                {form.kind === "pi" && (
                  <label className="block space-y-1">
                    <span className="text-xs text-[#8b949e]">Pi provider</span>
                    <select
                      value={form.provider}
                      onChange={(event) => {
                        const provider = event.target.value;
                        const currentDefault = piProviderDisplayName(
                          form.provider,
                        );
                        const shouldUpdateName =
                          !form.name.trim() ||
                          form.name.trim() === currentDefault;
                        setForm({
                          ...form,
                          name: shouldUpdateName
                            ? piProviderDisplayName(provider)
                            : form.name,
                          provider,
                        });
                      }}
                      className="w-full bg-[#0d1117] border border-[#30363d] rounded-md px-2 py-1.5 text-sm focus:outline-none focus:border-[#58a6ff]"
                      data-testid="pi-profile-provider"
                    >
                      {piProviders.map((provider) => (
                        <option key={provider} value={provider}>
                          {piProviderDisplayName(provider)}
                        </option>
                      ))}
                    </select>
                  </label>
                )}

                <label className="block space-y-1">
                  <span className="text-xs text-[#8b949e]">
                    {form.id ? "Replacement API key" : "API key"}
                  </span>
                  <input
                    value={form.apiKey}
                    type="password"
                    onChange={(event) =>
                      setForm({ ...form, apiKey: event.target.value })
                    }
                    placeholder={
                      form.id ? "Leave blank to keep current key" : ""
                    }
                    className="w-full bg-[#0d1117] border border-[#30363d] rounded-md px-2 py-1.5 text-sm focus:outline-none focus:border-[#58a6ff]"
                    data-testid="pi-profile-api-key"
                  />
                </label>

                <label className="block space-y-1">
                  <span className="text-xs text-[#8b949e]">Base URL</span>
                  <input
                    value={form.baseUrl}
                    onChange={(event) =>
                      setForm({ ...form, baseUrl: event.target.value })
                    }
                    className="w-full bg-[#0d1117] border border-[#30363d] rounded-md px-2 py-1.5 text-sm focus:outline-none focus:border-[#58a6ff]"
                  />
                </label>

                {form.kind === "pi" && form.provider === "openrouter" && (
                  <label className="flex items-start gap-2 rounded-md border border-[#30363d] bg-[#0d1117] px-3 py-2">
                    <input
                      type="checkbox"
                      checked={form.denyOpenRouterDataCollection}
                      onChange={(event) =>
                        setForm({
                          ...form,
                          denyOpenRouterDataCollection: event.target.checked,
                        })
                      }
                      className="mt-0.5 h-4 w-4 accent-[#238636]"
                      data-testid="pi-profile-deny-openrouter-data-collection"
                    />
                    <span className="min-w-0">
                      <span className="block text-xs text-[#c9d1d9]">
                        Deny OpenRouter data collection
                      </span>
                      <span className="block text-[11px] text-[#8b949e]">
                        Send provider.data_collection = deny
                      </span>
                    </span>
                  </label>
                )}

                <label className="block space-y-1">
                  <span className="text-xs text-[#8b949e]">
                    Manual model IDs
                  </span>
                  <textarea
                    value={form.manualModels}
                    onChange={(event) =>
                      setForm({ ...form, manualModels: event.target.value })
                    }
                    rows={3}
                    placeholder="one per line"
                    className="w-full bg-[#0d1117] border border-[#30363d] rounded-md px-2 py-1.5 text-sm focus:outline-none focus:border-[#58a6ff]"
                  />
                </label>

                {form.kind === "pi" && (
                  <>
                    <label className="block space-y-1">
                      <span className="text-xs text-[#8b949e]">
                        Headers JSON
                      </span>
                      <textarea
                        value={form.headersJson}
                        onChange={(event) =>
                          setForm({ ...form, headersJson: event.target.value })
                        }
                        rows={3}
                        placeholder='{"X-Header":"value"}'
                        className="w-full bg-[#0d1117] border border-[#30363d] rounded-md px-2 py-1.5 text-xs font-mono focus:outline-none focus:border-[#58a6ff]"
                      />
                    </label>

                    <label className="block space-y-1">
                      <span className="text-xs text-[#8b949e]">
                        Compat JSON
                      </span>
                      <textarea
                        value={form.compatJson}
                        onChange={(event) =>
                          setForm({ ...form, compatJson: event.target.value })
                        }
                        rows={3}
                        placeholder='{"supportsStore":false}'
                        className="w-full bg-[#0d1117] border border-[#30363d] rounded-md px-2 py-1.5 text-xs font-mono focus:outline-none focus:border-[#58a6ff]"
                      />
                    </label>
                  </>
                )}

                <div className="flex justify-end gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => {
                      setShowForm(false);
                      setForm(EMPTY_FORM);
                    }}
                    className="px-3 py-1.5 rounded-md text-xs text-[#8b949e] hover:text-[#e6edf3]"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => void saveProfile()}
                    className="px-3 py-1.5 rounded-md text-xs font-medium bg-[#1f6feb] text-white hover:bg-[#388bfd] disabled:opacity-50"
                    data-testid="pi-profile-save"
                  >
                    {saving ? "Saving..." : "Save"}
                  </button>
                </div>
              </aside>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
