export type Theme = "light" | "dark";
export type EnterBehavior = "send" | "newline";
export type ComposerDevice = "desktop" | "mobile";

export interface AppSettings {
  theme: Theme;
  enterBehavior: EnterBehavior;
  enterBehaviorByDevice: Record<ComposerDevice, EnterBehavior>;
  taskCompletionNotifications: boolean;
  hideNotificationsWhenActive: boolean;
  flipFaviconOnUnread: boolean;
  version: number;
}

export interface SettingsContextType {
  settings: AppSettings;
  theme: Theme;
  enterBehavior: EnterBehavior;
  composerDevice: ComposerDevice;
  taskCompletionNotifications: boolean;
  flipFaviconOnUnread: boolean;
  toggleTheme: () => void;
  toggleEnterBehavior: () => void;
  updateSettings: (updates: Partial<AppSettings>) => void;
}

// Default settings
export const DEFAULT_SETTINGS: AppSettings = {
  theme: "dark",
  enterBehavior: "send",
  enterBehaviorByDevice: {
    desktop: "send",
    mobile: "newline",
  },
  taskCompletionNotifications: false,
  hideNotificationsWhenActive: false,
  flipFaviconOnUnread: true,
  version: 5,
};

// Current settings version for migration
export const CURRENT_SETTINGS_VERSION = 5;
