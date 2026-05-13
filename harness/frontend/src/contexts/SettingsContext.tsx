import React, { useState, useEffect, useCallback, useMemo } from "react";
import type { AppSettings, SettingsContextType } from "../types/settings";
import {
  getComposerDevice,
  getSettings,
  MOBILE_COMPOSER_MEDIA_QUERY,
  setSettings,
} from "../utils/storage";
import { SettingsContext } from "./SettingsContextTypes";

export function SettingsProvider({ children }: { children: React.ReactNode }) {
  const [composerDevice, setComposerDevice] = useState(() =>
    getComposerDevice(),
  );
  const [settings, setSettingsState] = useState<AppSettings>(() =>
    getSettings(composerDevice),
  );
  const [isInitialized, setIsInitialized] = useState(false);

  useEffect(() => {
    const device = getComposerDevice();
    setComposerDevice(device);
    const initialSettings = getSettings(device);
    setSettingsState(initialSettings);
    setIsInitialized(true);
  }, []);

  useEffect(() => {
    const media = window.matchMedia(MOBILE_COMPOSER_MEDIA_QUERY);
    const handleChange = () => {
      const nextDevice = getComposerDevice();
      setComposerDevice(nextDevice);
      setSettingsState(getSettings(nextDevice));
    };
    media.addEventListener("change", handleChange);
    return () => media.removeEventListener("change", handleChange);
  }, []);

  useEffect(() => {
    if (!isInitialized) return;

    const root = window.document.documentElement;

    if (settings.theme === "dark") {
      root.classList.add("dark");
    } else {
      root.classList.remove("dark");
    }
    root.dataset.theme = settings.theme;

    setSettings(settings);
  }, [settings, isInitialized]);

  const updateSettings = useCallback(
    (updates: Partial<AppSettings>) => {
      setSettingsState((prev) => {
        const base = { ...getSettings(composerDevice), ...prev };
        const enterBehaviorByDevice = { ...base.enterBehaviorByDevice };
        if (updates.enterBehavior) {
          enterBehaviorByDevice[composerDevice] = updates.enterBehavior;
        }
        return {
          ...base,
          ...updates,
          enterBehaviorByDevice,
          enterBehavior: enterBehaviorByDevice[composerDevice],
        };
      });
    },
    [composerDevice],
  );

  const toggleTheme = useCallback(() => {
    updateSettings({
      theme: settings.theme === "light" ? "dark" : "light",
    });
  }, [settings.theme, updateSettings]);

  const toggleEnterBehavior = useCallback(() => {
    updateSettings({
      enterBehavior: settings.enterBehavior === "send" ? "newline" : "send",
    });
  }, [settings.enterBehavior, updateSettings]);

  const value = useMemo(
    (): SettingsContextType => ({
      settings,
      theme: settings.theme,
      enterBehavior: settings.enterBehavior,
      composerDevice,
      taskCompletionNotifications: settings.taskCompletionNotifications,
      flipFaviconOnUnread: settings.flipFaviconOnUnread,
      toggleTheme,
      toggleEnterBehavior,
      updateSettings,
    }),
    [
      settings,
      composerDevice,
      toggleTheme,
      toggleEnterBehavior,
      updateSettings,
    ],
  );

  return (
    <SettingsContext.Provider value={value}>
      {children}
    </SettingsContext.Provider>
  );
}
