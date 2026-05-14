import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ChevronUpIcon } from "@heroicons/react/24/outline";
import type {
  ChatProvider,
  ProviderCatalogGroup,
  ProviderCatalogResponse,
  ProviderModelOption,
} from "@shared/types";
import modelsConfig from "@shared/models.json";
import {
  getProvidersCatalogUrl,
  getUserPreferencesUrl,
} from "../../config/api";
import { providerTextColorClass } from "../../utils/providerColors";

interface StaticModelOption {
  id: string;
  label: string;
  provider: ChatProvider;
}

const STATIC_MODEL_OPTIONS: StaticModelOption[] =
  modelsConfig.providers.flatMap((p) =>
    p.models.map((m) => ({
      id: m.id,
      label: m.label,
      provider: p.id === "openai" ? "codex" : "claude",
    })),
  );

const dynamicModelLabels = new Map<string, string>();
const MODEL_POPULARITY_KEY = "swarmfleet-model-popularity";
const PROVIDER_CATALOG_CACHE_KEY = "swarmfleet-provider-catalog-v3";
const PROVIDER_CATALOG_CACHE_TTL_MS = 60 * 60_000;
let cachedProviderCatalog: ProviderCatalogResponse | null = null;
let cachedProviderCatalogPromise: Promise<ProviderCatalogResponse | null> | null =
  null;

type ProviderTab = ChatProvider | "all";

interface ModelPopularityEntry {
  count: number;
  lastUsed: number;
}

type ModelPopularity = Record<string, ModelPopularityEntry>;

interface UserPreferencesResponse {
  modelPopularity?: unknown;
}

type ModelWithGroup = ProviderModelOption & {
  groupId: string;
  groupLabel: string;
  groupProvider: ChatProvider;
  groupStatus: string;
  originalIndex: number;
};

type SearchField = "label" | "rawId" | "id" | "groupLabel" | "groupStatus";
type MatchRange = [number, number];

interface SearchMatch {
  rank: number;
  ranges: Partial<Record<SearchField, MatchRange[]>>;
}

type MatchedModel = ModelWithGroup & {
  searchMatch: SearchMatch | null;
};

function rawProviderModelId(modelId: string): string {
  const hermesMatch = modelId.match(/^hermes:([^:]+):(.+)$/);
  if (hermesMatch) {
    const provider = hermesMatch[1] === "codex" ? "codex" : hermesMatch[1];
    return `${provider}:${hermesMatch[2]}`;
  }
  const match = modelId.match(/^(?:pi|openrouter-claude):[^:]+:(.+)$/);
  return match?.[1] ?? modelId;
}

function compactModelLabel(value: string): string {
  const normalized = value
    .trim()
    .replace(/^openrouter:/i, "")
    .replace(/^~anthropic\//i, "")
    .replace(/^anthropic:\s*/i, "")
    .replace(/^anthropic\//i, "")
    .replace(/^anthropic\s+/i, "")
    .replace(/^claude[-\s]+/i, "");

  const idMatch = normalized.match(
    /^(?:claude-)?(opus|sonnet|haiku)[-\s]+(.+)$/i,
  );
  if (idMatch) {
    return `${idMatch[1].toLowerCase()}-${idMatch[2]
      .replace(/[\s_]+/g, "-")
      .replace(/\(([^)]+)\)/g, "[$1]")
      .toLowerCase()}`;
  }

  return normalized;
}

export function getModelLabel(modelId: string): string {
  const dynamic = dynamicModelLabels.get(modelId);
  if (dynamic) return compactModelLabel(dynamic);
  const found = STATIC_MODEL_OPTIONS.find((m) => m.id === modelId);
  if (found) return compactModelLabel(found.label);
  return modelId.startsWith("pi:") ||
    modelId.startsWith("openrouter-claude:") ||
    modelId.startsWith("hermes:")
    ? compactModelLabel(rawProviderModelId(modelId))
    : compactModelLabel(modelId);
}

export function getCurrentModelDisplay(modelId: string): string {
  const label = getModelLabel(modelId);
  const provider = deriveProviderFromModel(modelId);
  if (label.toLowerCase().startsWith(`${provider}:`.toLowerCase())) {
    return label;
  }
  return `${provider}:${label}`;
}

export function isClaudeModel(modelId: string): boolean {
  return deriveProviderFromModel(modelId) === "claude";
}

// Mirror of backend `deriveProvider` in chatSessionStore.ts — keep in sync.
export function deriveProviderFromModel(modelId: string): ChatProvider {
  if (modelId.startsWith("codex")) return "codex";
  if (modelId.startsWith("pi:")) return "pi";
  if (modelId.startsWith("openrouter-claude:")) return "openrouter-claude";
  if (modelId.startsWith("hermes:")) return "hermes";
  return "claude";
}

function displayProviderForModel(modelId: string, fallback: string): string {
  const hermesMatch = modelId.match(/^hermes:([^:]+):/);
  if (hermesMatch) {
    const hermesProvider = hermesMatch[1];
    if (hermesProvider === "openai-codex") return "codex";
    return hermesProvider;
  }
  return fallback;
}

function builtinCatalog(): ProviderCatalogResponse {
  const anthropic = modelsConfig.providers.find(
    (provider) => provider.id === "anthropic",
  );
  const openai = modelsConfig.providers.find(
    (provider) => provider.id === "openai",
  );
  return {
    piProfiles: [],
    piSupportedProviders: [],
    openRouterClaudeProfiles: [],
    groups: [
      {
        id: "claude",
        label: "Claude",
        provider: "claude",
        sourceProvider: "anthropic",
        authenticated: false,
        models: (anthropic?.models ?? []).map((model) => ({
          id: model.id,
          rawId: model.id,
          label: model.label,
          provider: "claude",
        })),
      },
      {
        id: "codex",
        label: "Codex",
        provider: "codex",
        sourceProvider: "openai",
        authenticated: false,
        models: (openai?.models ?? []).map((model) => ({
          id: model.id,
          rawId: model.id,
          label: model.label,
          provider: "codex",
        })),
      },
      {
        id: "hermes",
        label: "Hermes",
        provider: "hermes",
        sourceProvider: "hermes-agent",
        authenticated: false,
        models: [],
      },
    ],
  };
}

function readCachedProviderCatalog(): ProviderCatalogResponse | null {
  if (cachedProviderCatalog) return cachedProviderCatalog;
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(PROVIDER_CATALOG_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as {
      ts?: unknown;
      catalog?: unknown;
    };
    if (
      typeof parsed.ts !== "number" ||
      Date.now() - parsed.ts > PROVIDER_CATALOG_CACHE_TTL_MS
    ) {
      return null;
    }
    const catalog = parsed.catalog as ProviderCatalogResponse;
    if (!catalog || !Array.isArray(catalog.groups)) return null;
    cachedProviderCatalog = catalog;
    return catalog;
  } catch {
    return null;
  }
}

function writeCachedProviderCatalog(catalog: ProviderCatalogResponse): void {
  cachedProviderCatalog = catalog;
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      PROVIDER_CATALOG_CACHE_KEY,
      JSON.stringify({ ts: Date.now(), catalog }),
    );
  } catch {
    // Ignore storage failures; the in-memory cache still avoids duplicate fetches.
  }
}

function invalidateCachedProviderCatalog(): void {
  cachedProviderCatalog = null;
  cachedProviderCatalogPromise = null;
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(PROVIDER_CATALOG_CACHE_KEY);
  } catch {
    // Ignore storage failures; a fresh network fetch will still update memory.
  }
}

async function fetchProviderCatalog(options?: {
  fresh?: boolean;
}): Promise<ProviderCatalogResponse | null> {
  const cached = options?.fresh ? null : readCachedProviderCatalog();
  if (cached) return cached;
  if (!options?.fresh && cachedProviderCatalogPromise) {
    return cachedProviderCatalogPromise;
  }
  const promise = fetch(
    options?.fresh
      ? `${getProvidersCatalogUrl()}?fresh=1`
      : getProvidersCatalogUrl(),
  )
    .then((response) => response.json())
    .then((data: ProviderCatalogResponse) => {
      if (Array.isArray(data.groups)) {
        writeCachedProviderCatalog(data);
        return data;
      }
      return null;
    })
    .catch(() => null)
    .finally(() => {
      if (!options?.fresh) cachedProviderCatalogPromise = null;
    });
  if (!options?.fresh) cachedProviderCatalogPromise = promise;
  return promise;
}

function providerStatusText(group: ProviderCatalogGroup): string {
  if (group.provider === "pi") return group.sourceProvider ?? "pi";
  if (group.provider === "hermes") {
    return group.authenticated ? "configured" : (group.error ?? "needs config");
  }
  return group.authenticated ? "signed in" : (group.error ?? "not signed in");
}

function providerTabLabel(provider: ProviderTab): string {
  switch (provider) {
    case "all":
      return "All";
    case "claude":
      return "Claude";
    case "codex":
      return "Codex";
    case "pi":
      return "Pi";
    case "openrouter-claude":
      return "OpenRouterClaude";
    case "hermes":
      return "Hermes";
  }
}

function providerHasSelectableModelsWithoutAuth(
  group: ProviderCatalogGroup,
): boolean {
  return group.provider === "hermes" && group.models.length > 0;
}

function readModelPopularity(): ModelPopularity {
  try {
    const raw = window.localStorage.getItem(MODEL_POPULARITY_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    return parsed as ModelPopularity;
  } catch {
    return {};
  }
}

function parseModelPopularity(value: unknown): ModelPopularity {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const parsed: ModelPopularity = {};
  for (const [modelId, rawEntry] of Object.entries(value)) {
    if (!rawEntry || typeof rawEntry !== "object") continue;
    const entry = rawEntry as Partial<ModelPopularityEntry>;
    if (
      typeof entry.count === "number" &&
      Number.isFinite(entry.count) &&
      typeof entry.lastUsed === "number" &&
      Number.isFinite(entry.lastUsed)
    ) {
      parsed[modelId] = {
        count: entry.count,
        lastUsed: entry.lastUsed,
      };
    }
  }
  return parsed;
}

function writeModelPopularity(popularity: ModelPopularity): void {
  try {
    window.localStorage.setItem(
      MODEL_POPULARITY_KEY,
      JSON.stringify(popularity),
    );
  } catch {
    // Ignore storage failures; sorting falls back to catalog order.
  }
}

function mergeModelPopularity(
  localPopularity: ModelPopularity,
  serverPopularity: ModelPopularity,
): ModelPopularity {
  const merged: ModelPopularity = {};
  for (const modelId of new Set([
    ...Object.keys(localPopularity),
    ...Object.keys(serverPopularity),
  ])) {
    const localEntry = localPopularity[modelId];
    const serverEntry = serverPopularity[modelId];
    merged[modelId] = {
      count: Math.max(localEntry?.count ?? 0, serverEntry?.count ?? 0),
      lastUsed: Math.max(localEntry?.lastUsed ?? 0, serverEntry?.lastUsed ?? 0),
    };
  }
  return merged;
}

function modelPopularityEquals(
  left: ModelPopularity,
  right: ModelPopularity,
): boolean {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if ((left[key]?.count ?? 0) !== (right[key]?.count ?? 0)) return false;
    if ((left[key]?.lastUsed ?? 0) !== (right[key]?.lastUsed ?? 0))
      return false;
  }
  return true;
}

function mergeRanges(ranges: MatchRange[]): MatchRange[] {
  const sorted = [...ranges]
    .filter(([start, end]) => end > start)
    .sort((left, right) => left[0] - right[0] || right[1] - left[1]);
  const merged: MatchRange[] = [];
  for (const range of sorted) {
    const previous = merged[merged.length - 1];
    if (previous && range[0] <= previous[1]) {
      previous[1] = Math.max(previous[1], range[1]);
    } else {
      merged.push([...range] as MatchRange);
    }
  }
  return merged;
}

function substringRanges(text: string, query: string): MatchRange[] {
  if (!query) return [];
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const ranges: MatchRange[] = [];
  let index = lowerText.indexOf(lowerQuery);
  while (index !== -1) {
    ranges.push([index, index + lowerQuery.length]);
    index = lowerText.indexOf(lowerQuery, index + 1);
  }
  return ranges;
}

function orderedCharacterRanges(
  text: string,
  token: string,
  allowOneMiss: boolean,
): MatchRange[] | null {
  if (!token) return [];
  const lowerText = text.toLowerCase();
  const lowerToken = token.toLowerCase();
  const ranges: MatchRange[] = [];
  let textIndex = 0;
  let misses = 0;
  for (const char of lowerToken) {
    const found = lowerText.indexOf(char, textIndex);
    if (found === -1) {
      misses += 1;
      if (!allowOneMiss || misses > 1) return null;
      continue;
    }
    ranges.push([found, found + 1]);
    textIndex = found + 1;
  }
  return ranges.length > 0 ? ranges : null;
}

function scoreField(
  text: string,
  query: string,
  tokens: string[],
): SearchMatch | null {
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  if (!lowerText) return null;

  if (lowerText === lowerQuery) {
    return { rank: 0, ranges: { label: [[0, text.length]] } };
  }
  if (lowerText.startsWith(lowerQuery)) {
    return { rank: 1, ranges: { label: [[0, query.length]] } };
  }

  const fullSubstring = substringRanges(text, query);
  if (fullSubstring.length > 0) {
    return { rank: 2, ranges: { label: fullSubstring } };
  }

  const tokenSubstringMatches = tokens.map((token) =>
    substringRanges(text, token),
  );
  if (
    tokens.length > 0 &&
    tokenSubstringMatches.every((ranges) => ranges.length > 0)
  ) {
    return {
      rank: 3,
      ranges: { label: mergeRanges(tokenSubstringMatches.flat()) },
    };
  }

  const strictMatches = tokens.map((token) =>
    orderedCharacterRanges(text, token, false),
  );
  if (tokens.length > 0 && strictMatches.every(Boolean)) {
    return {
      rank: 4,
      ranges: {
        label: mergeRanges(strictMatches.flatMap((ranges) => ranges ?? [])),
      },
    };
  }

  const fuzzyMatches = tokens.map((token) =>
    orderedCharacterRanges(text, token, token.length >= 3),
  );
  if (tokens.length > 0 && fuzzyMatches.every(Boolean)) {
    return {
      rank: 5,
      ranges: {
        label: mergeRanges(fuzzyMatches.flatMap((ranges) => ranges ?? [])),
      },
    };
  }

  return null;
}

function matchModel(option: ModelWithGroup, query: string): SearchMatch | null {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  const fields: Array<[SearchField, string]> = [
    ["label", option.label],
    ["rawId", option.rawId],
    ["id", option.id],
    ["groupLabel", option.groupLabel],
    ["groupStatus", option.groupStatus],
  ];

  let bestRank = Number.POSITIVE_INFINITY;
  const ranges: Partial<Record<SearchField, MatchRange[]>> = {};
  for (const [field, value] of fields) {
    const match = scoreField(value, query, tokens);
    if (!match) continue;
    bestRank = Math.min(bestRank, match.rank);
    ranges[field] = mergeRanges(match.ranges.label ?? []);
  }

  return Number.isFinite(bestRank) ? { rank: bestRank, ranges } : null;
}

async function fetchModelPopularity(): Promise<ModelPopularity> {
  const response = await fetch(getUserPreferencesUrl());
  if (!response.ok) throw new Error("Failed to load preferences");
  const data = (await response.json()) as UserPreferencesResponse;
  return parseModelPopularity(data.modelPopularity);
}

function persistModelPopularity(popularity: ModelPopularity): void {
  writeModelPopularity(popularity);
  void fetch(getUserPreferencesUrl(), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ modelPopularity: popularity }),
  }).catch(() => {
    // Keep the local cache; a later successful model selection will resync.
  });
}

export function ModelPicker({
  model,
  onModelChange,
  disabled,
  lockedProvider,
  dropdownPlacement = "top",
  onAvailabilityChange,
}: {
  model: string;
  onModelChange: (model: string) => void;
  disabled?: boolean;
  lockedProvider: ChatProvider | null;
  dropdownPlacement?: "top" | "bottom";
  onAvailabilityChange?: (available: boolean) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [catalog, setCatalog] = useState<ProviderCatalogResponse>(
    () => readCachedProviderCatalog() ?? builtinCatalog(),
  );
  const [activeTab, setActiveTab] = useState<ProviderTab>(
    lockedProvider ?? "all",
  );
  const [query, setQuery] = useState("");
  const [popularity, setPopularity] = useState<ModelPopularity>(() =>
    typeof window === "undefined" ? {} : readModelPopularity(),
  );
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    const localPopularity = readModelPopularity();
    fetchModelPopularity()
      .then((serverPopularity) => {
        if (cancelled) return;
        const nextPopularity = mergeModelPopularity(
          localPopularity,
          serverPopularity,
        );
        setPopularity(nextPopularity);
        if (!modelPopularityEquals(nextPopularity, serverPopularity)) {
          persistModelPopularity(nextPopularity);
        }
      })
      .catch(() => {
        if (!cancelled) setPopularity(localPopularity);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    for (const group of catalog.groups) {
      for (const option of group.models) {
        dynamicModelLabels.set(option.id, option.label);
      }
    }
  }, [catalog]);

  useEffect(() => {
    let cancelled = false;
    fetchProviderCatalog().then((data) => {
      if (!cancelled && data) setCatalog(data);
    });

    const onInvalidated = () => {
      invalidateCachedProviderCatalog();
      fetchProviderCatalog({ fresh: true }).then((data) => {
        if (!cancelled && data) setCatalog(data);
      });
    };
    window.addEventListener("providers-invalidated", onInvalidated);
    return () => {
      cancelled = true;
      window.removeEventListener("providers-invalidated", onInvalidated);
    };
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [isOpen]);

  const groups = useMemo(
    () =>
      catalog.groups.filter((group) => {
        if (lockedProvider) {
          return (
            group.provider === lockedProvider &&
            (group.authenticated ||
              providerHasSelectableModelsWithoutAuth(group) ||
              deriveProviderFromModel(model) === lockedProvider)
          );
        }
        return (
          group.authenticated || providerHasSelectableModelsWithoutAuth(group)
        );
      }),
    [catalog.groups, lockedProvider, model],
  );

  const tabs = useMemo(() => {
    if (lockedProvider) return [lockedProvider] as ProviderTab[];
    const providers = Array.from(
      new Set(groups.map((group) => group.provider)),
    );
    return ["all", ...providers] as ProviderTab[];
  }, [groups, lockedProvider]);

  useEffect(() => {
    if (lockedProvider) {
      setActiveTab(lockedProvider);
      return;
    }
    setActiveTab((current) => (tabs.includes(current) ? current : "all"));
  }, [lockedProvider, tabs]);

  const flattenedModels = useMemo<ModelWithGroup[]>(() => {
    let originalIndex = 0;
    return groups.flatMap((group) =>
      group.models.map((option) => ({
        ...option,
        groupId: group.id,
        groupLabel: group.label,
        groupProvider: group.provider,
        groupStatus: providerStatusText(group),
        originalIndex: originalIndex++,
      })),
    );
  }, [groups]);

  const filteredModels = useMemo<MatchedModel[]>(() => {
    const q = query.trim().toLowerCase();
    const modelsForTab = flattenedModels.filter((option) =>
      activeTab === "all" ? true : option.groupProvider === activeTab,
    );
    const matching = q
      ? modelsForTab.flatMap((option) => {
          const searchMatch = matchModel(option, q);
          return searchMatch ? [{ ...option, searchMatch }] : [];
        })
      : modelsForTab.map((option) => ({ ...option, searchMatch: null }));
    return [...matching].sort((left, right) => {
      const rankDelta =
        (left.searchMatch?.rank ?? 0) - (right.searchMatch?.rank ?? 0);
      if (rankDelta !== 0) return rankDelta;
      const leftPopularity = popularity[left.id];
      const rightPopularity = popularity[right.id];
      const countDelta =
        (rightPopularity?.count ?? 0) - (leftPopularity?.count ?? 0);
      if (countDelta !== 0) return countDelta;
      const recencyDelta =
        (rightPopularity?.lastUsed ?? 0) - (leftPopularity?.lastUsed ?? 0);
      if (recencyDelta !== 0) return recencyDelta;
      return left.originalIndex - right.originalIndex;
    });
  }, [activeTab, flattenedModels, popularity, query]);

  useEffect(() => {
    if (flattenedModels.length === 0) return;
    if (flattenedModels.some((option) => option.id === model)) return;
    onModelChange(flattenedModels[0].id);
  }, [flattenedModels, model, onModelChange]);

  const hasAvailableModels = flattenedModels.length > 0;
  const currentModelMatchesLockedProvider =
    Boolean(model) &&
    Boolean(lockedProvider) &&
    deriveProviderFromModel(model) === lockedProvider;
  const canSendWithCurrentModel =
    hasAvailableModels || currentModelMatchesLockedProvider;

  useEffect(() => {
    onAvailabilityChange?.(canSendWithCurrentModel);
  }, [canSendWithCurrentModel, onAvailabilityChange]);

  const mobileDropdownPosition =
    dropdownPlacement === "top" ? "bottom-0" : "top-0";
  const desktopDropdownPosition =
    dropdownPlacement === "top"
      ? "sm:bottom-full sm:mb-1"
      : "sm:top-full sm:mt-1";

  const openPicker = () => {
    if (disabled || !hasAvailableModels) return;
    setIsOpen((open) => !open);
    setActiveTab(lockedProvider ?? "all");
    setQuery("");
  };

  const chooseModel = (option: ModelWithGroup) => {
    dynamicModelLabels.set(option.id, option.label);
    setPopularity((current) => {
      const existing = current[option.id] ?? { count: 0, lastUsed: 0 };
      const next = {
        ...current,
        [option.id]: {
          count: existing.count + 1,
          lastUsed: Date.now(),
        },
      };
      persistModelPopularity(next);
      return next;
    });
    onModelChange(option.id);
    setIsOpen(false);
    setQuery("");
  };

  const currentModelDisplay = model
    ? getCurrentModelDisplay(model)
    : hasAvailableModels
      ? "select model"
      : "no provider";
  const currentProvider = displayProviderForModel(
    model,
    deriveProviderFromModel(model),
  );

  const renderMatchedText = (text: string, ranges?: MatchRange[]) => {
    const merged = mergeRanges(ranges ?? []);
    if (merged.length === 0) return text;
    const parts: ReactNode[] = [];
    let cursor = 0;
    merged.forEach(([start, end], index) => {
      if (start > cursor) parts.push(text.slice(cursor, start));
      parts.push(
        <mark
          key={`${start}-${end}-${index}`}
          className="rounded-sm bg-[#3d2f00] px-0.5 text-[#ffd33d]"
        >
          {text.slice(start, end)}
        </mark>,
      );
      cursor = end;
    });
    if (cursor < text.length) parts.push(text.slice(cursor));
    return parts;
  };

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        type="button"
        onClick={openPicker}
        disabled={disabled || !hasAvailableModels}
        data-testid="model-selector"
        data-model-id={model}
        data-no-provider={hasAvailableModels ? undefined : "true"}
        title={currentModelDisplay}
        className="flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium hover:bg-[#21262d] transition-colors duration-150 disabled:opacity-40 disabled:cursor-not-allowed max-w-[420px]"
      >
        <span
          className={`truncate ${
            hasAvailableModels
              ? providerTextColorClass(currentProvider)
              : "text-[#f85149]"
          }`}
        >
          {currentModelDisplay}
        </span>
        <ChevronUpIcon
          className={`w-3 h-3 shrink-0 transition-transform duration-150 ${
            isOpen ? "" : "rotate-180"
          }`}
        />
      </button>

      {isOpen && (
        <div
          className={`fixed ${mobileDropdownPosition} left-0 right-0 w-screen max-w-none bg-[#161b22] border border-[#30363d] rounded-t-lg shadow-xl z-50 overflow-hidden sm:absolute ${desktopDropdownPosition} sm:left-auto sm:right-0 sm:w-[28rem] sm:max-w-[calc(100vw-2rem)] sm:rounded-lg`}
        >
          <div className="max-h-96 flex flex-col">
            <div className="p-2 border-b border-[#30363d]">
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search models"
                data-testid="model-search"
                className="w-full bg-[#0d1117] border border-[#30363d] rounded-md px-2 py-1.5 text-xs text-[#e6edf3] placeholder-[#484f58] focus:outline-none focus:border-[#58a6ff]"
                autoFocus
              />
            </div>

            <div className="flex items-center gap-1 overflow-x-auto border-b border-[#30363d] px-2 py-1.5">
              {tabs.map((tab) => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => setActiveTab(tab)}
                  data-testid="model-provider-tab"
                  data-provider-id={tab}
                  className={`shrink-0 rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors ${
                    activeTab === tab
                      ? "bg-[#1f2937] text-[#e6edf3]"
                      : "text-[#8b949e] hover:bg-[#21262d] hover:text-[#c9d1d9]"
                  }`}
                >
                  {providerTabLabel(tab)}
                </button>
              ))}
            </div>

            <div className="overflow-y-auto py-1">
              {filteredModels.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => chooseModel(option)}
                  data-testid="model-option"
                  data-model-id={option.id}
                  className={`w-full text-left px-3 py-2 text-xs transition-colors duration-100 ${
                    option.id === model
                      ? "text-[#e6edf3] bg-[#1f2937]"
                      : "text-[#c9d1d9] hover:bg-[#1c2129]"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <div className="min-w-0 flex-1">
                      <div
                        className={`font-medium truncate ${providerTextColorClass(
                          displayProviderForModel(option.id, option.provider),
                        )}`}
                      >
                        {renderMatchedText(compactModelLabel(option.label))}
                      </div>
                      <div className="text-[10px] text-[#8b949e] truncate">
                        {renderMatchedText(
                          option.rawId,
                          option.searchMatch?.ranges.rawId,
                        )}
                      </div>
                    </div>
                    {(activeTab === "all" || option.groupProvider === "pi") && (
                      <div className="max-w-[120px] shrink-0 text-right">
                        <div
                          className={`truncate text-[10px] font-medium ${providerTextColorClass(
                            option.groupProvider,
                          )}`}
                        >
                          {renderMatchedText(
                            option.groupLabel,
                            option.searchMatch?.ranges.groupLabel,
                          )}
                        </div>
                        <div className="truncate text-[10px] text-[#6e7681]">
                          {renderMatchedText(
                            option.groupStatus,
                            option.searchMatch?.ranges.groupStatus,
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                </button>
              ))}
              {filteredModels.length === 0 && (
                <div className="px-3 py-3 text-xs text-[#8b949e]">
                  No matching models.
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
