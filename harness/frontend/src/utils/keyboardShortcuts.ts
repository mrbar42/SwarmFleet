const MAC_PLATFORM_RE = /Mac|iPhone|iPad|iPod/;

export function isMacPlatform(): boolean {
  return (
    typeof navigator !== "undefined" && MAC_PLATFORM_RE.test(navigator.platform)
  );
}

export function getPlanModeShortcutLabel(): string {
  return isMacPlatform() ? "Cmd+Shift+P" : "Ctrl+Shift+P";
}

export function isPlanModeShortcut(event: KeyboardEvent): boolean {
  const hasPlatformModifier = isMacPlatform()
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey;

  return (
    event.key.toLowerCase() === "p" &&
    event.shiftKey &&
    !event.altKey &&
    hasPlatformModifier
  );
}
