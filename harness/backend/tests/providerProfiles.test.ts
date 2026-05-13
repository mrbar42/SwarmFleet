import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildProviderCatalog,
  encodeOpenRouterClaudeModelId,
  encodePiModelId,
  parseHermesModelId,
  parseOpenRouterClaudeModelId,
  parsePiModelId,
  ProviderProfileStore,
  redactProviderSettings,
} from "../services/providerProfiles.ts";
import { resolveHermesPythonRuntimeFromShebang } from "../handlers/shared/providers.ts";

const tempDirs: string[] = [];
const originalFetch = globalThis.fetch;
const originalOpenRouterApiKey = process.env.OPENROUTER_API_KEY;

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
  globalThis.fetch = originalFetch;
  if (originalOpenRouterApiKey === undefined) {
    delete process.env.OPENROUTER_API_KEY;
  } else {
    process.env.OPENROUTER_API_KEY = originalOpenRouterApiKey;
  }
});

async function createStore(): Promise<{
  store: ProviderProfileStore;
  path: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), "swarmfleet-provider-profiles-"));
  tempDirs.push(dir);
  const path = join(dir, "profiles.json");
  return { store: new ProviderProfileStore(path), path };
}

describe("ProviderProfileStore", () => {
  it("redacts api keys and preserves them on profile updates", async () => {
    const { store, path } = await createStore();
    const created = await store.createPiProfile({
      name: "OpenRouter A",
      provider: "openrouter",
      apiKey: "sk-secret",
      manualModels: ["openai/gpt-oss-120b"],
    });

    expect(created.hasApiKey).toBe(true);
    expect(created.denyOpenRouterDataCollection).toBe(true);
    expect(JSON.stringify(created)).not.toContain("sk-secret");

    const updated = await store.updatePiProfile(created.id, {
      name: "OpenRouter B",
      apiKey: "",
      denyOpenRouterDataCollection: false,
    });
    expect(updated?.name).toBe("OpenRouter B");
    expect(updated?.denyOpenRouterDataCollection).toBe(false);
    expect((await store.getPiProfile(created.id))?.apiKey).toBe("sk-secret");
    expect(
      (await store.getPiProfile(created.id))?.denyOpenRouterDataCollection,
    ).toBe(false);

    const raw = await readFile(path, "utf-8");
    expect(raw).toContain("sk-secret");
  });

  it("uses a readable provider name when a Pi profile has no explicit name", async () => {
    const { store } = await createStore();
    const created = await store.createPiProfile({
      provider: "openrouter",
      apiKey: "sk-secret",
    });

    expect(created.name).toBe("OpenRouter");
  });

  it("builds catalog groups for duplicate underlying Pi providers", async () => {
    const { store } = await createStore();
    const first = await store.createPiProfile({
      name: "Router One",
      provider: "openrouter",
      apiKey: "key-one",
      manualModels: ["custom/model:one"],
    });
    const second = await store.createPiProfile({
      name: "Router Two",
      provider: "openrouter",
      apiKey: "key-two",
      manualModels: ["custom/model:two"],
    });

    const catalog = await buildProviderCatalog({
      claudeAuthenticated: false,
      codexAuthenticated: false,
      store,
    });

    expect(catalog.groups.some((group) => group.id === "claude")).toBe(true);
    expect(catalog.groups.some((group) => group.id === "codex")).toBe(true);
    expect(
      catalog.groups.filter((group) => group.provider === "pi"),
    ).toHaveLength(2);
    expect(
      catalog.groups.some((group) =>
        group.models.some(
          (model) => model.id === encodePiModelId(first.id, "custom/model:one"),
        ),
      ),
    ).toBe(true);
    expect(
      catalog.groups.some((group) =>
        group.models.some(
          (model) =>
            model.id === encodePiModelId(second.id, "custom/model:two"),
        ),
      ),
    ).toBe(true);
  });

  it("uses explicit Hermes discovery results instead of static Codex/OpenRouter fallbacks", async () => {
    delete process.env.OPENROUTER_API_KEY;
    const { store } = await createStore();

    const unavailable = await buildProviderCatalog({
      claudeAuthenticated: false,
      codexAuthenticated: false,
      hermesAuthenticated: false,
      hermesModels: [],
      store,
    });
    expect(
      unavailable.groups.find((group) => group.id === "hermes")?.models,
    ).toEqual([]);

    const available = await buildProviderCatalog({
      claudeAuthenticated: false,
      codexAuthenticated: false,
      hermesAuthenticated: true,
      hermesModels: [
        {
          id: "hermes:codex:gpt-live",
          rawId: "gpt-live",
          label: "codex:gpt-live",
          provider: "hermes",
        },
      ],
      store,
    });
    expect(
      available.groups.find((group) => group.id === "hermes")?.models,
    ).toEqual([
      {
        id: "hermes:codex:gpt-live",
        rawId: "gpt-live",
        label: "codex:gpt-live",
        provider: "hermes",
      },
    ]);
  });

  it("parses Hermes provider model ids beyond Codex and OpenRouter", () => {
    expect(parseHermesModelId("hermes:lmstudio:local-model:Q4_K_M")).toEqual({
      provider: "lmstudio",
      rawModelId: "local-model:Q4_K_M",
    });
  });

  it("keeps explicit Hermes LM Studio discovery results selectable", async () => {
    const { store } = await createStore();
    const catalog = await buildProviderCatalog({
      claudeAuthenticated: false,
      codexAuthenticated: false,
      hermesAuthenticated: true,
      hermesModels: [
        {
          id: "hermes:lmstudio:local-model",
          rawId: "local-model",
          label: "lmstudio:local-model",
          provider: "hermes",
        },
      ],
      store,
    });

    expect(
      catalog.groups.find((group) => group.id === "hermes")?.models,
    ).toEqual([
      {
        id: "hermes:lmstudio:local-model",
        rawId: "local-model",
        label: "lmstudio:local-model",
        provider: "hermes",
      },
    ]);
  });

  it("parses Pi model ids with slashes and colons in the raw model id", () => {
    expect(parsePiModelId("pi:profile-1:openrouter/vendor/model:beta")).toEqual(
      {
        profileId: "profile-1",
        rawModelId: "openrouter/vendor/model:beta",
      },
    );
  });

  it("redacts OpenRouterClaude keys and catalogs all OpenRouter models", async () => {
    delete process.env.OPENROUTER_API_KEY;
    const { store } = await createStore();
    const created = await store.createOpenRouterClaudeProfile({
      name: "OR Claude",
      apiKey: "sk-or-secret",
      baseUrl: "https://openrouter.ai/api",
      manualModels: ["anthropic/custom-claude:beta"],
    });
    expect(created.hasApiKey).toBe(true);
    expect(JSON.stringify(created)).not.toContain("sk-or-secret");

    const requestedUrls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      requestedUrls.push(String(url));
      return new Response(
        JSON.stringify({
          data: [
            {
              id: "anthropic/claude-sonnet-4.5",
              name: "Claude Sonnet 4.5",
              context_length: 200000,
              supported_parameters: ["tools", "reasoning"],
            },
            { id: "openai/gpt-5", name: "GPT-5" },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const catalog = await buildProviderCatalog({
      claudeAuthenticated: false,
      codexAuthenticated: false,
      store,
    });
    const group = catalog.groups.find(
      (candidate) => candidate.provider === "openrouter-claude",
    );

    expect(requestedUrls).toEqual(["https://openrouter.ai/api/v1/models"]);
    expect(group?.label).toBe("OR Claude");
    expect(group?.models.map((model) => model.rawId)).toEqual([
      "anthropic/claude-sonnet-4.5",
      "openai/gpt-5",
      "anthropic/custom-claude:beta",
    ]);
    expect(group?.models[0]?.id).toBe(
      encodeOpenRouterClaudeModelId(created.id, "anthropic/claude-sonnet-4.5"),
    );
  });

  it("parses OpenRouterClaude model ids with slashes and colons", () => {
    expect(
      parseOpenRouterClaudeModelId(
        "openrouter-claude:profile-1:anthropic/claude:beta",
      ),
    ).toEqual({
      profileId: "profile-1",
      rawModelId: "anthropic/claude:beta",
    });
  });

  it("persists the OpenRouterClaude proxy setting", async () => {
    const { store } = await createStore();

    expect((await store.getSettings()).openRouterClaudeProxyEnabled).toBe(true);
    expect((await store.getSettings()).openRouterClaudeProxyZdrEnabled).toBe(
      true,
    );

    const enabled = await store.updateSettings({
      openRouterClaudeProxyEnabled: true,
      openRouterClaudeProxyZdrEnabled: false,
    });
    expect(enabled.openRouterClaudeProxyEnabled).toBe(true);
    expect(enabled.openRouterClaudeProxyZdrEnabled).toBe(false);

    const reloaded = await store.getSettings();
    expect(reloaded.openRouterClaudeProxyEnabled).toBe(true);
    expect(reloaded.openRouterClaudeProxyZdrEnabled).toBe(false);
  });

  it("persists Telegram notification settings without exposing the token in redacted settings", async () => {
    const { store } = await createStore();

    const configured = await store.updateSettings({
      telegramOperatorNotificationsEnabled: true,
      telegramBotToken: "  123456:secret-token  ",
      telegramChatId: "  987654321  ",
    });

    expect(configured.telegramOperatorNotificationsEnabled).toBe(true);
    expect(configured.telegramBotToken).toBe("123456:secret-token");
    expect(configured.telegramChatId).toBe("987654321");

    const redacted = redactProviderSettings(configured);
    expect(JSON.stringify(redacted)).not.toContain("secret-token");
    expect(redacted.telegramBotTokenConfigured).toBe(true);

    const disabled = await store.updateSettings({
      telegramOperatorNotificationsEnabled: false,
    });
    expect(disabled.telegramBotToken).toBe("123456:secret-token");
    expect(disabled.telegramChatId).toBe("987654321");

    const cleared = await store.updateSettings({ telegramBotToken: "" });
    expect(cleared.telegramBotToken).toBeUndefined();
    expect(redactProviderSettings(cleared).telegramBotTokenConfigured).toBe(
      false,
    );
  });
});

describe("resolveHermesPythonRuntimeFromShebang", () => {
  it("preserves /usr/bin/env interpreter arguments", () => {
    expect(
      resolveHermesPythonRuntimeFromShebang("#!/usr/bin/env python3"),
    ).toEqual({
      command: "/usr/bin/env",
      args: ["python3"],
      cwd: undefined,
    });
  });

  it("does not treat shell wrapper shebangs as Python runtimes", () => {
    expect(
      resolveHermesPythonRuntimeFromShebang("#!/usr/bin/env bash"),
    ).toBeNull();
  });

  it("derives cwd from direct Hermes venv python shebangs", () => {
    expect(
      resolveHermesPythonRuntimeFromShebang("#!/opt/hermes/venv/bin/python"),
    ).toEqual({
      command: "/opt/hermes/venv/bin/python",
      args: [],
      cwd: "/opt/hermes",
    });
  });
});
