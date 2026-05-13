import type { SessionIndexEvent } from "@shared/types";
import { getSettings } from "./storage";
import { useAppStore } from "../stores/appStore";

const MAX_SEEN_NOTIFICATIONS = 100;
const RECENT_ACTIVITY_WINDOW_MS = 60_000;
const CLAIM_WINDOW_MS = 50;
const NOTIFICATION_CHANNEL_NAME = "swarmfleet-notifications";
const seenNotificationKeys: string[] = [];
const seenNotificationSet = new Set<string>();
const pendingClaims = new Map<string, { tiebreak: number; suppressed: boolean }>();
let activityTrackingInitialized = false;
let lastUserActivityAt = 0;
let notificationChannel: BroadcastChannel | null = null;

type NotificationEvent = Extract<SessionIndexEvent, { type: "notification" }>;
type StatusEvent = Extract<SessionIndexEvent, { type: "session-status" }>;
type NotificationClaim = {
  type: "claim";
  eventId: string;
  tiebreak: number;
};

function isNotificationSupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

function canSendNotifications(): boolean {
  if (!isNotificationSupported()) return false;
  const settings = getSettings();
  return (
    settings.taskCompletionNotifications &&
    window.Notification.permission === "granted"
  );
}

function markUserActivity(): void {
  lastUserActivityAt = Date.now();
}

function ensureActivityTracking(): void {
  if (activityTrackingInitialized || typeof window === "undefined") return;
  activityTrackingInitialized = true;

  const activityEvents: Array<keyof WindowEventMap> = [
    "pointerdown",
    "keydown",
    "mousemove",
    "scroll",
    "focus",
  ];

  for (const eventName of activityEvents) {
    window.addEventListener(eventName, markUserActivity, { passive: true });
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      markUserActivity();
    }
  });
}

function shouldHideNotificationForRecentActivity(): boolean {
  if (typeof document === "undefined") return false;
  ensureActivityTracking();

  const settings = getSettings();
  if (!settings.hideNotificationsWhenActive) return false;
  if (document.visibilityState !== "visible") return false;

  return Date.now() - lastUserActivityAt < RECENT_ACTIVITY_WINDOW_MS;
}

function rememberNotification(key: string): boolean {
  if (seenNotificationSet.has(key)) return false;
  seenNotificationSet.add(key);
  seenNotificationKeys.push(key);
  if (seenNotificationKeys.length > MAX_SEEN_NOTIFICATIONS) {
    const oldest = seenNotificationKeys.shift();
    if (oldest) seenNotificationSet.delete(oldest);
  }
  return true;
}

export function getBrowserNotificationSupport(): {
  supported: boolean;
  permission: NotificationPermission | "unsupported";
} {
  if (!isNotificationSupported()) {
    return { supported: false, permission: "unsupported" };
  }
  return { supported: true, permission: window.Notification.permission };
}

export async function requestBrowserNotificationPermission(): Promise<NotificationPermission | "unsupported"> {
  if (!isNotificationSupported()) return "unsupported";
  return await window.Notification.requestPermission();
}

export function sendTestNotification(): { ok: true } | { ok: false; error: string } {
  if (!isNotificationSupported()) {
    return { ok: false, error: "This browser does not support system notifications." };
  }
  if (window.Notification.permission !== "granted") {
    return {
      ok: false,
      error: `Browser notification permission is ${window.Notification.permission}.`,
    };
  }

  const notification = new window.Notification("Notification test", {
    body: "SwarmFleet notifications are working.",
    tag: "swarmfleet-notification-test",
  });
  window.setTimeout(() => notification.close(), 5000);
  return { ok: true };
}

function getNotificationChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel === "undefined") return null;
  if (!notificationChannel) {
    try {
      notificationChannel = new BroadcastChannel(NOTIFICATION_CHANNEL_NAME);
    } catch {
      return null;
    }
    notificationChannel.addEventListener("message", (message) => {
      const claim = message.data as Partial<NotificationClaim>;
      if (claim.type !== "claim" || typeof claim.eventId !== "string") return;
      if (typeof claim.tiebreak !== "number") return;
      const pending = pendingClaims.get(claim.eventId);
      if (!pending) return;
      if (claim.tiebreak <= pending.tiebreak) {
        pending.suppressed = true;
      }
    });
  }
  return notificationChannel;
}

function navigateToSession(event: NotificationEvent): void {
  const project = useAppStore
    .getState()
    .projects.find((entry) => entry.path === event.projectPath);
  if (!project?.name) return;

  window.location.assign(
    `/chat/${encodeURIComponent(project.name)}?sessionId=${encodeURIComponent(event.sessionId)}`,
  );
}

function fireNotification(event: NotificationEvent): void {
  const notification = new window.Notification(event.title, {
    tag: `swarmfleet-${event.kind}:${event.sessionId}`,
    ...(event.body ? { body: event.body } : {}),
  });

  notification.onclick = () => {
    window.focus();
    navigateToSession(event);
    notification.close();
  };
}

export function handleServerNotification(event: NotificationEvent): void {
  if (!canSendNotifications()) return;
  if (shouldHideNotificationForRecentActivity()) return;
  if (!rememberNotification(event.eventId)) return;

  const channel = getNotificationChannel();
  if (!channel) {
    fireNotification(event);
    return;
  }
  const claim = {
    type: "claim" as const,
    eventId: event.eventId,
    tiebreak: Math.random(),
  };
  pendingClaims.set(event.eventId, {
    tiebreak: claim.tiebreak,
    suppressed: false,
  });
  channel.postMessage(claim);

  window.setTimeout(() => {
    const pending = pendingClaims.get(event.eventId);
    pendingClaims.delete(event.eventId);
    if (!pending?.suppressed) {
      fireNotification(event);
    }
  }, CLAIM_WINDOW_MS);
}

function buildBody(preview: string | undefined): string | undefined {
  const collapsed = (preview ?? "").replace(/\s+/g, " ").trim();
  if (!collapsed) return undefined;
  if (collapsed.toLowerCase() === "completed response") return undefined;
  return collapsed.length > 140 ? `${collapsed.slice(0, 137)}...` : collapsed;
}

export function handleStatusCompletionNotification(event: StatusEvent): void {
  if (event.status !== "idle") return;
  handleServerNotification({
    ...event,
    type: "notification",
    kind: "task-completion",
    occurredAt: event.updatedAt,
    title: "Session completed",
    eventId: `status:${event.sessionId}:${event.updatedAt}`,
    body: buildBody(event.lastMessagePreview),
  });
}
