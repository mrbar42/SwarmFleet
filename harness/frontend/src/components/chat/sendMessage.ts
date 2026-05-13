import type {
  ImageAttachment,
  PermissionMode,
  SessionMessageResponse,
  SessionMetadata,
} from "../../types";
import type { ConversationImageAsset } from "@shared/types";
import { getSessionCreateUrl, getSessionMessageUrl } from "../../config/api";
import { clearChatDraft, useChatStore } from "../../stores/chatStore";
import { generateId } from "../../utils/id";
import {
  closeSessionConnection,
  closeOtherSessionConnections,
  openSessionConnection,
} from "../../stores/sessionConnectionStore";
import { getOverallConnectionState } from "../../stores/connectionStateStore";
import { insertCreatedSession } from "../../stores/sessions";
import type { StreamStoreApi } from "../../utils/streamProcessor";

async function readErrorDetail(response: Response): Promise<string> {
  const fallback = `${response.status} ${response.statusText}`.trim();
  const contentType = response.headers.get("content-type") ?? "";

  try {
    if (contentType.includes("application/json")) {
      const body = (await response.json()) as unknown;
      if (
        body &&
        typeof body === "object" &&
        "error" in body &&
        typeof body.error === "string" &&
        body.error.trim()
      ) {
        return body.error.trim();
      }
      if (
        body &&
        typeof body === "object" &&
        "message" in body &&
        typeof body.message === "string" &&
        body.message.trim()
      ) {
        return body.message.trim();
      }
      return fallback;
    }

    const text = await response.text();
    if (contentType.includes("text/html") || /^\s*<!doctype html/i.test(text)) {
      return `${fallback}: SwarmFleet backend returned an HTML startup page; it is likely starting or restarting. Please retry in a few seconds.`;
    }
    return text.trim() || fallback;
  } catch {
    return fallback;
  }
}

function attachmentsToImageAssets(
  attachments?: ImageAttachment[],
): ConversationImageAsset[] | undefined {
  if (!attachments?.length) return undefined;
  return attachments.map((attachment, index) => {
    const url = `data:${attachment.media_type};base64,${attachment.base64}`;
    return {
      assetId: `local-attachment-${Date.now()}-${index}`,
      mimeType: attachment.media_type,
      url,
      thumbnailUrl: url,
      createdAt: Date.now(),
      sourceToolName: "attachment",
    };
  });
}

/**
 * Send a chat message, creating a session first if needed.
 *
 * Reads all mutable state via `useChatStore.getState()` so the only
 * closure dependencies are the project identifiers (workingDirectory
 * and encodedName), which change infrequently.
 */
export async function sendMessage(
  workingDirectory: string | undefined,
  encodedName: string | null,
  messageContent?: string,
  tools?: string[],
  hideUserMessage?: boolean,
  overridePermissionMode?: PermissionMode,
  attachments?: ImageAttachment[],
  options?: { skipTranscript?: boolean },
): Promise<void> {
  const store = useChatStore.getState();
  const draftInput = store.input;
  const content = messageContent ?? draftInput.trim();
  const hasAttachments = (attachments?.length ?? 0) > 0;
  const previousSessionId = store.sessionId;
  const draftProjectPath = store.projectPath ?? workingDirectory ?? null;
  const draftSlotId = store.newSessionDraftSlotId;
  let createdSessionId: string | null = null;
  let messageAccepted = false;
  let clearedDraftForSend = false;
  let optimisticUserMessageTimestamp: number | null = null;

  if ((!content && !hasAttachments) || store.phase === "loading-history")
    return;
  // When a plan approval is pending, allow the user to push back by sending a
  // regular message — treat it as "keep planning + new instruction".
  const isPlanPushback =
    store.phase === "awaiting-permission" &&
    Boolean(store.planModeRequest?.isOpen);

  // While the agent is actively running (streaming), messages can still be
  // sent — the backend will enqueue them and dispatch them when the current
  // turn ends. Skip this path only for plan-permission prompts (those need
  // explicit Accept/Reject and never queue).
  const isAgentBusy =
    (store.phase === "streaming" || store.phase === "awaiting-permission") &&
    !isPlanPushback;

  // Guard: if the user is NOT actively hiding the bubble (hideUserMessage is
  // used for programmatic sends that shouldn't appear in the transcript), skip
  // mid-run sends entirely. Normal user-facing sends are always allowed even
  // when the agent is busy; the server decides whether to run or queue.
  const suppressUserTranscript = hideUserMessage || options?.skipTranscript;
  const isDraftSubmission =
    !suppressUserTranscript &&
    (messageContent === undefined || messageContent === draftInput);

  if (isAgentBusy && suppressUserTranscript) return;

  if (getOverallConnectionState() === "offline") {
    store.setError(
      "Offline: reconnect to the backend before sending a message.",
    );
    return;
  }

  if (isDraftSubmission) {
    store.clearInput();
    clearedDraftForSend = true;
  }

  if (!suppressUserTranscript && !isAgentBusy) {
    // Only add the optimistic transcript bubble when the agent is idle and will
    // actually run this message. Clear the submitted draft first so the visible
    // input and visible sent row are mutually exclusive in the same render pass.
    // When the agent is busy the message goes into the queue and shows as a
    // pending-queue row instead — no transcript bubble until it's dispatched
    // and the auto-send path echoes it back via SSE.
    optimisticUserMessageTimestamp = Date.now();
    store.addMessage({
      type: "chat",
      role: "user",
      content,
      timestamp: optimisticUserMessageTimestamp,
      assets: attachmentsToImageAssets(attachments),
    });
  }

  try {
    let liveSessionId = store.sessionId;

    if (!liveSessionId) {
      if (!workingDirectory) throw new Error("No project selected");

      const createResponse = await fetch(getSessionCreateUrl(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectPath: workingDirectory,
          encodedProjectName: encodedName,
          model: store.model,
          permissionMode: overridePermissionMode || store.permissionMode,
          effort: store.effort,
          allowedTools: tools || store.allowedTools,
        }),
      });

      if (!createResponse.ok) {
        throw new Error(
          `Failed to create session: ${await readErrorDetail(createResponse)}`,
        );
      }

      const createdSession = (await createResponse.json()) as SessionMetadata;
      createdSessionId = createdSession.sessionId;
      insertCreatedSession(workingDirectory, createdSession);
      useChatStore.getState().setSessionId(createdSession.sessionId);
      useChatStore.setState({
        sessionProvider: createdSession.provider,
        sessionKind: createdSession.kind,
        model: createdSession.model || store.model,
      });
      useChatStore
        .getState()
        .applyLivePhase(createdSession.status, createdSession.sessionId);

      closeOtherSessionConnections(createdSession.sessionId);
      openSessionConnection(
        createdSession.sessionId,
        useChatStore as unknown as StreamStoreApi,
        {
          lastEventId:
            createdSession.latestEventId >= 0
              ? createdSession.latestEventId
              : undefined,
        },
      );

      liveSessionId = createdSession.sessionId;
    } else {
      closeOtherSessionConnections(liveSessionId);
      openSessionConnection(
        liveSessionId,
        useChatStore as unknown as StreamStoreApi,
      );
    }

    if (!liveSessionId) throw new Error("No active session");

    const nextRequestId = isAgentBusy
      ? generateId()
      : useChatStore.getState().startRequest();
    const response = await fetch(getSessionMessageUrl(liveSessionId), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: content || "What do you see in this image?",
        requestId: nextRequestId,
        allowedTools: tools || store.allowedTools,
        permissionMode: overridePermissionMode || store.permissionMode,
        skipTranscript: options?.skipTranscript,
        ...(hasAttachments ? { attachments } : {}),
        model: store.model,
        effort: store.effort,
      }),
    });

    if (!response.ok) {
      const detail = await readErrorDetail(response);
      throw new Error(
        response.status === 409 && detail.includes("Queue is full")
          ? detail
          : `Failed to send message: ${detail}`,
      );
    }

    const body = (await response.json()) as SessionMessageResponse;
    messageAccepted = true;
    if (!messageContent) {
      const latestStore = useChatStore.getState();
      latestStore.clearInput();
      if (!previousSessionId && createdSessionId) {
        clearChatDraft(draftProjectPath, null, draftSlotId);
      }
    }
    if (body.queued) {
      // The server accepted the message into the queue while a turn is running.
      // Do not touch active request state here: the current turn's requestId
      // still owns the stream and abort button. Seed the row immediately so the
      // message does not appear to vanish while waiting for the queue SSE poll.
      if (body.queuedId) {
        const latestStore = useChatStore.getState();
        latestStore.setQueuedMessages(
          latestStore.queuedMessages.some((item) => item.id === body.queuedId)
            ? latestStore.queuedMessages
            : [
                ...latestStore.queuedMessages,
                {
                  id: body.queuedId,
                  message: content || "What do you see in this image?",
                  createdAt: Date.now(),
                  requestId: nextRequestId,
                  permissionMode:
                    overridePermissionMode || store.permissionMode,
                  model: store.model,
                  effort: store.effort,
                  allowedTools: tools || store.allowedTools,
                  ...(hasAttachments ? { attachments } : {}),
                },
              ],
        );
      }
      return;
    }
  } catch (error) {
    console.error("Failed to send message:", error);
    const nextStore = useChatStore.getState();
    if (createdSessionId && !messageAccepted) {
      closeSessionConnection(createdSessionId);
      useChatStore.setState({
        sessionId: previousSessionId,
        sessionProvider: previousSessionId ? nextStore.sessionProvider : null,
        sessionKind: previousSessionId ? nextStore.sessionKind : null,
      });
      nextStore.resetRequestState();
    }
    if (optimisticUserMessageTimestamp !== null && !messageAccepted) {
      nextStore.setMessages(
        useChatStore.getState().messages.filter(
          (message) =>
            !(
              message.type === "chat" &&
              message.role === "user" &&
              message.timestamp === optimisticUserMessageTimestamp &&
              message.content === content
            ),
        ),
      );
    }
    if (clearedDraftForSend && !messageAccepted) {
      useChatStore.getState().setInput(draftInput);
    }
    useChatStore.getState().addMessage({
      type: "chat",
      role: "assistant",
      content: `Error: ${
        error instanceof Error ? error.message : "Failed to get response"
      }`,
      timestamp: Date.now(),
    });
    nextStore.setError(
      error instanceof Error ? error.message : "Failed to get response",
    );
  }
}
