import type {
  SessionIndexDeltaEvent,
  SessionMetadata,
  SessionStatus,
} from "../../shared/types.ts";

type NotificationKind = Extract<
  SessionIndexDeltaEvent,
  { type: "notification" }
>["kind"];

function notificationKindForTransition(
  previousStatus: SessionStatus | undefined,
  nextStatus: SessionStatus,
): NotificationKind | null {
  if (previousStatus !== "running") return null;
  if (nextStatus === "idle") return "task-completion";
  if (nextStatus === "awaiting_input") return "awaiting-input";
  if (nextStatus === "error") return "error";
  if (nextStatus === "interrupted") return "interrupted";
  return null;
}

function titleForKind(kind: NotificationKind): string {
  switch (kind) {
    case "task-completion":
      return "Session completed";
    case "awaiting-input":
      return "Session awaiting input";
    case "error":
      return "Session error";
    case "interrupted":
      return "Session interrupted";
  }
}

function buildBody(preview: string | undefined): string | undefined {
  const collapsed = (preview ?? "").replace(/\s+/g, " ").trim();
  if (!collapsed) return undefined;
  if (collapsed.toLowerCase() === "completed response") return undefined;
  return collapsed.length > 140 ? `${collapsed.slice(0, 137)}...` : collapsed;
}

export function buildNotificationEvent(
  previousStatus: SessionStatus | undefined,
  metadata: SessionMetadata,
): Extract<SessionIndexDeltaEvent, { type: "notification" }> | null {
  const kind = notificationKindForTransition(previousStatus, metadata.status);
  if (!kind) return null;

  const body = buildBody(metadata.lastMessagePreview);
  return {
    type: "notification",
    projectPath: metadata.projectPath,
    encodedProjectName: metadata.encodedProjectName,
    sessionId: metadata.sessionId,
    kind,
    occurredAt: metadata.updatedAt,
    title: titleForKind(kind),
    ...(body ? { body } : {}),
  };
}
