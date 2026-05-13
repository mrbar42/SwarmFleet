import type {
  AppSettings,
  Theme,
  EnterBehavior,
  ComposerDevice,
} from "../types/settings";
import { CURRENT_SETTINGS_VERSION, DEFAULT_SETTINGS } from "../types/settings";

export const STORAGE_KEYS = {
  SETTINGS: "swarmfleet-webui-settings",
  MODEL_PREFIX: "swarmfleet-webui-model:",
  THEME: "swarmfleet-webui-theme",
  ENTER_BEHAVIOR: "swarmfleet-webui-enter-behavior",
} as const;

export function getStorageItem<T>(key: string, defaultValue: T): T {
  try {
    const item = localStorage.getItem(key);
    return item ? JSON.parse(item) : defaultValue;
  } catch {
    return defaultValue;
  }
}

export function setStorageItem<T>(key: string, value: T): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Silently fail if localStorage is not available
  }
}

export function removeStorageItem(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // Silently fail if localStorage is not available
  }
}

export const MOBILE_COMPOSER_MEDIA_QUERY =
  "(max-width: 767px), (pointer: coarse)";

export function getComposerDevice(): ComposerDevice {
  if (typeof window === "undefined" || !window.matchMedia) return "desktop";
  return window.matchMedia(MOBILE_COMPOSER_MEDIA_QUERY).matches
    ? "mobile"
    : "desktop";
}

export function getDefaultEnterBehavior(
  device: ComposerDevice = getComposerDevice(),
): EnterBehavior {
  return DEFAULT_SETTINGS.enterBehaviorByDevice[device];
}

export function getSettings(
  device: ComposerDevice = getComposerDevice(),
): AppSettings {
  const unifiedSettings = getStorageItem<AppSettings | null>(
    STORAGE_KEYS.SETTINGS,
    null,
  );

  if (unifiedSettings && unifiedSettings.version === CURRENT_SETTINGS_VERSION) {
    const enterBehaviorByDevice = {
      ...DEFAULT_SETTINGS.enterBehaviorByDevice,
      ...unifiedSettings.enterBehaviorByDevice,
    };
    return {
      ...DEFAULT_SETTINGS,
      ...unifiedSettings,
      enterBehaviorByDevice,
      enterBehavior: enterBehaviorByDevice[device],
      version: CURRENT_SETTINGS_VERSION,
    };
  }

  return migrateSettings(unifiedSettings, device);
}

export function setSettings(settings: AppSettings): void {
  setStorageItem(STORAGE_KEYS.SETTINGS, settings);
}

function migrateSettings(
  existingSettings: Partial<AppSettings> | null,
  device: ComposerDevice,
): AppSettings {
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const systemDefaultTheme: Theme = prefersDark ? "dark" : "light";

  const legacyTheme = getStorageItem<Theme>(
    STORAGE_KEYS.THEME,
    systemDefaultTheme,
  );
  const legacyEnterBehaviorRaw = (() => {
    try {
      return localStorage.getItem(STORAGE_KEYS.ENTER_BEHAVIOR);
    } catch {
      return null;
    }
  })();
  const legacyEnterBehavior = legacyEnterBehaviorRaw
    ? getStorageItem<EnterBehavior>(
        STORAGE_KEYS.ENTER_BEHAVIOR,
        getDefaultEnterBehavior(device),
      )
    : undefined;

  const enterBehaviorByDevice = {
    ...DEFAULT_SETTINGS.enterBehaviorByDevice,
    ...existingSettings?.enterBehaviorByDevice,
  };
  const previousEnterBehavior =
    existingSettings?.enterBehavior ?? legacyEnterBehavior;
  if (previousEnterBehavior) {
    enterBehaviorByDevice[device] = previousEnterBehavior;
  }

  const migratedSettings: AppSettings = {
    theme: existingSettings?.theme ?? legacyTheme,
    enterBehavior: enterBehaviorByDevice[device],
    enterBehaviorByDevice,
    taskCompletionNotifications:
      existingSettings?.taskCompletionNotifications ??
      DEFAULT_SETTINGS.taskCompletionNotifications,
    hideNotificationsWhenActive:
      existingSettings?.hideNotificationsWhenActive ??
      DEFAULT_SETTINGS.hideNotificationsWhenActive,
    flipFaviconOnUnread:
      existingSettings?.flipFaviconOnUnread ??
      DEFAULT_SETTINGS.flipFaviconOnUnread,
    version: CURRENT_SETTINGS_VERSION,
  };

  setSettings(migratedSettings);
  removeStorageItem(STORAGE_KEYS.THEME);
  removeStorageItem(STORAGE_KEYS.ENTER_BEHAVIOR);

  return migratedSettings;
}
