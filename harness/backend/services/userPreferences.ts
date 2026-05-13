import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getConfigDir } from "./globalConfig.ts";

const PREFERENCES_VERSION = 1;
const PREFERENCES_FILE_NAME = "user-preferences.json";

export interface ModelPopularityEntry {
  count: number;
  lastUsed: number;
}

export type ModelPopularity = Record<string, ModelPopularityEntry>;

export interface UserPreferences {
  version: number;
  projectOrder: string[];
  projectOrderUpdatedAt: number;
  modelPopularity: ModelPopularity;
}

export interface UserPreferenceUpdates {
  projectOrder?: unknown;
  projectOrderUpdatedAt?: unknown;
  modelPopularity?: unknown;
}

function preferencesPath(): string {
  return join(getConfigDir(), PREFERENCES_FILE_NAME);
}

function emptyPreferences(): UserPreferences {
  return {
    version: PREFERENCES_VERSION,
    projectOrder: [],
    projectOrderUpdatedAt: 0,
    modelPopularity: {},
  };
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .map((item) => (typeof item === "string" ? item.trim() : ""))
        .filter(Boolean),
    ),
  );
}

function normalizeModelPopularity(value: unknown): ModelPopularity {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: ModelPopularity = {};
  for (const [modelId, rawEntry] of Object.entries(value)) {
    if (!modelId.trim() || !rawEntry || typeof rawEntry !== "object") continue;
    const entry = rawEntry as Partial<ModelPopularityEntry>;
    const count =
      typeof entry.count === "number" && Number.isFinite(entry.count)
        ? Math.max(0, Math.floor(entry.count))
        : 0;
    const lastUsed =
      typeof entry.lastUsed === "number" && Number.isFinite(entry.lastUsed)
        ? Math.max(0, entry.lastUsed)
        : 0;
    if (count > 0 || lastUsed > 0) {
      out[modelId] = { count, lastUsed };
    }
  }
  return out;
}

function normalizeTimestamp(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, value)
    : 0;
}

function normalizePreferences(value: unknown): UserPreferences {
  const input =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Partial<UserPreferences>)
      : {};
  return {
    version: PREFERENCES_VERSION,
    projectOrder: normalizeStringArray(input.projectOrder),
    projectOrderUpdatedAt: normalizeTimestamp(input.projectOrderUpdatedAt),
    modelPopularity: normalizeModelPopularity(input.modelPopularity),
  };
}

export class UserPreferenceStore {
  private updateQueue: Promise<void> = Promise.resolve();

  constructor(private readonly path = preferencesPath()) {}

  async read(): Promise<UserPreferences> {
    try {
      return normalizePreferences(
        JSON.parse(await readFile(this.path, "utf-8")),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return emptyPreferences();
      }
      throw error;
    }
  }

  async update(updates: UserPreferenceUpdates): Promise<UserPreferences> {
    const run = this.updateQueue.then(async () => {
      const current = await this.read();
      const hasProjectOrderUpdate = Object.prototype.hasOwnProperty.call(
        updates,
        "projectOrder",
      );
      const next: UserPreferences = {
        ...current,
        version: PREFERENCES_VERSION,
        ...(hasProjectOrderUpdate
          ? { projectOrder: normalizeStringArray(updates.projectOrder) }
          : {}),
        ...(hasProjectOrderUpdate
          ? {
              projectOrderUpdatedAt:
                normalizeTimestamp(updates.projectOrderUpdatedAt) || Date.now(),
            }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(updates, "modelPopularity")
          ? { modelPopularity: normalizeModelPopularity(updates.modelPopularity) }
          : {}),
      };
      await this.write(next);
      return next;
    });
    this.updateQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async write(preferences: UserPreferences): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify(preferences, null, 2), { mode: 0o600 });
    await rename(tmp, this.path);
  }
}

export const userPreferenceStore = new UserPreferenceStore();
