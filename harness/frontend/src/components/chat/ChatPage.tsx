import { useCallback, useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ChatInput } from "./ChatInput";
import { ChatMessages } from "./ChatMessages";
import { ChatTitleBar } from "./ChatTitleBar";
import { TodoRow } from "./MessageComponents";
import { HistoryView } from "../HistoryView";
import { useAppStore } from "../../stores/appStore";
import { useChatStore } from "../../stores/chatStore";
import { KEYBOARD_SHORTCUTS } from "../../utils/constants";
import { isPlanModeShortcut } from "../../utils/keyboardShortcuts";
import { normalizeWindowsPath } from "../../utils/pathUtils";
import { sendMessage } from "./sendMessage";
import { isTodoMessage, type TodoItem, type TodoMessage } from "../../types";

export function ChatPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const currentProject = useAppStore((state) => state.currentProject);

  const sessionId = useChatStore((state) => state.sessionId);
  const storedProjectPath = useChatStore((state) => state.projectPath);
  const phase = useChatStore((state) => state.phase);
  const historyLoading = useChatStore((state) => state.historyLoading);
  const historyError = useChatStore((state) => state.historyError);
  const sessionNotFound = useChatStore((state) => state.sessionNotFound);
  const streamError = useChatStore((state) => state.streamError);
  const permissionMode = useChatStore((state) => state.permissionMode);
  const setProjectContext = useChatStore((state) => state.setProjectContext);
  const orchestrateSession = useChatStore((state) => state.orchestrateSession);
  const loadSession = useChatStore((state) => state.loadSession);
  const startNewSession = useChatStore((state) => state.startNewSession);
  const setPermissionMode = useChatStore((state) => state.setPermissionMode);
  const abortStream = useChatStore((state) => state.abortStream);
  // Derive the latest todo list for the floating row above ChatInput. Walk
  // from the end of the message timeline to find the most recent TodoMessage.
  // Return the message object itself (stable reference) — not a new wrapper —
  // so Zustand's Object.is check can bail out and avoid infinite re-renders.
  const latestTodoMessage = useChatStore((state): TodoMessage | null => {
    const msgs = state.messages;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const message = msgs[i];
      if (isTodoMessage(message)) return message;
    }
    return null;
  });
  const latestTodoEntry = latestTodoMessage
    ? { todos: latestTodoMessage.todos as TodoItem[], timestamp: latestTodoMessage.timestamp }
    : null;

  // Dismiss state: store the timestamp of the TodoMessage the user dismissed.
  // When a newer TodoMessage arrives (different timestamp), the row reappears.
  const [dismissedTimestamp, setDismissedTimestamp] = useState<number | null>(null);
  const todoVisible =
    latestTodoEntry !== null &&
    latestTodoEntry.todos.length > 0 &&
    latestTodoEntry.timestamp !== dismissedTimestamp;

  const currentView = searchParams.get("view");
  const sessionIdFromUrl = searchParams.get("sessionId");
  const isHistoryView = currentView === "history";
  const workingDirectory = currentProject?.path
    ? normalizeWindowsPath(currentProject.path)
    : undefined;
  const encodedName = currentProject?.encodedName ?? null;
  // Whether the chatStore's session state belongs to the project that's currently
  // mounted. When the user navigates to a different project, the store still holds
  // the *previous* project's sessionId for one render cycle; we must NOT fall back
  // to it as the active session, otherwise we'll carry the stale id into the new
  // project's URL.
  const storeBelongsToCurrentProject =
    !!workingDirectory && storedProjectPath === workingDirectory;
  const activeSessionId = isHistoryView ? null : sessionIdFromUrl;
  const isLoading =
    phase === "streaming" ||
    phase === "loading-history" ||
    phase === "awaiting-permission";
  const isPlanMode = permissionMode === "plan";
  const handleRetryLoadConversation = useCallback(() => {
    if (!currentProject?.path || !activeSessionId) return;
    void loadSession(
      currentProject.path,
      activeSessionId,
      currentProject.encodedName ?? null,
    );
  }, [activeSessionId, currentProject?.path, currentProject?.encodedName, loadSession]);

  // --- Project context sync ---
  useEffect(() => {
    setProjectContext(
      currentProject?.path ?? null,
      currentProject?.encodedName ?? null,
    );
  }, [currentProject?.path, currentProject?.encodedName, setProjectContext]);

  // --- Session orchestration ---
  useEffect(() => {
    if (!currentProject?.path || isHistoryView) return;
    orchestrateSession(
      currentProject.path,
      activeSessionId ?? null,
      currentProject.encodedName ?? null,
    );
  }, [activeSessionId, currentProject?.path, currentProject?.encodedName, isHistoryView, orchestrateSession]);

  // --- URL sync ---
  useEffect(() => {
    if (isHistoryView) return;
    const next = new URLSearchParams(searchParams);
    // Only push the store's sessionId into the URL after the user creates or
    // loads a session in this mounted project. A URL without a sessionId is an
    // explicit new-session state, so a remembered sessionStorage id must not be
    // restored into it.
    if (
      sessionId &&
      storeBelongsToCurrentProject &&
      !sessionIdFromUrl &&
      !useChatStore.getState().preserveBlankSession
    ) {
      next.set("sessionId", sessionId);
      navigate({ search: next.toString() }, { replace: true });
    } else if (!activeSessionId && sessionIdFromUrl) {
      next.delete("sessionId");
      navigate({ search: next.toString() }, { replace: true });
    }
  }, [
    sessionId,
    activeSessionId,
    isHistoryView,
    navigate,
    searchParams,
    sessionIdFromUrl,
    storeBelongsToCurrentProject,
  ]);

  // --- Missing-session URL cleanup ---
  // If the URL points to a session that doesn't exist (404), drop the sessionId
  // param so we drop into a fresh new-conversation view instead of an error.
  useEffect(() => {
    if (!sessionNotFound) return;
    if (!searchParams.has("sessionId")) return;
    const next = new URLSearchParams(searchParams);
    next.delete("sessionId");
    navigate({ search: next.toString() }, { replace: true });
  }, [sessionNotFound, navigate, searchParams]);

  // --- New-chat event listener ---
  useEffect(() => {
    const handler = () => startNewSession();
    window.addEventListener("new-chat-session", handler);
    return () => window.removeEventListener("new-chat-session", handler);
  }, [startNewSession]);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ message?: string }>).detail;
      const message = detail?.message?.trim();
      if (!message || !workingDirectory) return;
      void sendMessage(workingDirectory, encodedName, message);
    };

    window.addEventListener("send-chat-message", handler);
    return () => window.removeEventListener("send-chat-message", handler);
  }, [encodedName, workingDirectory]);

  // --- Keyboard shortcuts ---
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const { requestId } = useChatStore.getState();
      if (event.key === KEYBOARD_SHORTCUTS.ABORT && isLoading && requestId) {
        event.preventDefault();
        void abortStream();
        return;
      }

      if (isPlanModeShortcut(event)) {
        event.preventDefault();
        setPermissionMode("plan");
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [abortStream, isLoading, setPermissionMode]);

  const handleHistoryClick = useCallback(() => {
    navigate({ search: new URLSearchParams({ view: "history" }).toString() });
  }, [navigate]);

  const handleBackToChat = useCallback(() => {
    navigate({ search: "" });
  }, [navigate]);

  const hasActiveSession = !!activeSessionId;

  return (
    <div className="h-full bg-[#0d1117]">
      <div className="h-full flex flex-col">
        {(isHistoryView || hasActiveSession) && (
          <ChatTitleBar
            isHistoryView={isHistoryView}
            activeSessionId={activeSessionId ?? null}
            onHistoryClick={handleHistoryClick}
            onBackToChat={handleBackToChat}
          />
        )}

        {isHistoryView ? (
          <HistoryView
            workingDirectory={workingDirectory || ""}
            encodedName={encodedName}
            onBack={handleBackToChat}
          />
        ) : historyLoading ? (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center">
              <div className="w-8 h-8 border-2 border-[#30363d] border-t-[#8b949e] rounded-full animate-spin mx-auto mb-4" />
              <p className="text-[#8b949e]">Loading conversation history...</p>
            </div>
          </div>
        ) : historyError ? (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center max-w-md">
              <div className="w-16 h-16 mx-auto mb-4 bg-[#3d1214] rounded-full flex items-center justify-center">
                <svg
                  className="w-8 h-8 text-[#f85149]"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                  />
                </svg>
              </div>
              <h2 className="text-[#e6edf3] text-xl font-semibold mb-2">
                Error Loading Conversation
              </h2>
              <p className="text-[#8b949e] text-sm mb-4">{historyError}</p>
              <div className="flex items-center justify-center gap-2">
                <button
                  onClick={handleRetryLoadConversation}
                  disabled={!currentProject?.path || !activeSessionId}
                  className="px-4 py-2 bg-[#238636] text-white rounded-lg hover:bg-[#2ea043] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  Retry
                </button>
                <button
                  onClick={() => navigate({ search: "" })}
                  className="px-4 py-2 bg-[#1f6feb] text-white rounded-lg hover:bg-[#388bfd] transition-colors"
                >
                  Start New Conversation
                </button>
              </div>
            </div>
          </div>
        ) : (
          <>
            {streamError && (
              <div className="px-4 py-2 text-sm text-[#f85149] bg-[#3d1214]/30 border-b border-[#5d1a1d]">
                {streamError}
              </div>
            )}
            <ChatMessages />
            {todoVisible && (
              <TodoRow
                todos={latestTodoEntry!.todos}
                onDismiss={() => setDismissedTimestamp(latestTodoEntry!.timestamp)}
              />
            )}
            <ChatInput
              onSubmit={() => void sendMessage(workingDirectory, encodedName)}
              onSubmitWithAttachments={(message, attachments) => {
                void sendMessage(workingDirectory, encodedName, message, undefined, false, undefined, attachments);
              }}
              onAbort={abortStream}
              isPlanMode={isPlanMode}
              onPlanToggle={() => {
                setPermissionMode(isPlanMode ? "bypassPermissions" : "plan");
              }}
            />
          </>
        )}
      </div>
    </div>
  );
}
