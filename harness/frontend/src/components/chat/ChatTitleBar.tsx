import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  ChevronLeftIcon,
  CommandLineIcon,
  DevicePhoneMobileIcon,
} from "@heroicons/react/24/outline";
import type { ChatMessage, ConversationSummary } from "../../types";
import { useAppStore } from "../../stores/appStore";
import { useChatStore } from "../../stores/chatStore";
import { SubagentTabStrip } from "../SubagentTabStrip";
import { HistoryButton } from "./HistoryButton";
import {
  useSubprocessCount,
  useSubprocesses,
} from "../../stores/subprocessStore";
import { SubprocessOverlay } from "./SubprocessOverlay";

interface ChatTitleBarProps {
  isHistoryView: boolean;
  activeSessionId: string | null;
  onHistoryClick: () => void;
  onBackToChat: () => void;
}

export function ChatTitleBar({
  isHistoryView,
  activeSessionId,
  onHistoryClick,
  onBackToChat,
}: ChatTitleBarProps) {
  const currentProject = useAppStore((state) => state.currentProject);
  const sessionIndex = useAppStore((state) => state.sessionIndex);
  const updateIndexedSessionTitle = useAppStore(
    (state) => state.updateSessionTitle,
  );

  const messages = useChatStore((state) => state.messages);
  const chatSessionTitle = useChatStore((state) => state.sessionTitle);
  const updateChatSessionTitle = useChatStore(
    (state) => state.updateSessionTitle,
  );
  const showBackgroundActivity = useChatStore(
    (state) => state.showBackgroundActivity,
  );
  const setShowBackgroundActivity = useChatStore(
    (state) => state.setShowBackgroundActivity,
  );

  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [editTitleValue, setEditTitleValue] = useState("");
  const titleInputRef = useRef<HTMLInputElement>(null);

  const subprocessCount = useSubprocessCount(activeSessionId);
  const subprocesses = useSubprocesses(activeSessionId);
  const [subprocessOverlayOpen, setSubprocessOverlayOpen] = useState(false);
  const subprocessButtonRef = useRef<HTMLButtonElement | null>(null);

  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const handleSelectSubagent = useCallback(
    (childId: string) => {
      const next = new URLSearchParams(searchParams);
      next.set("sessionId", childId);
      navigate({ search: next.toString() });
    },
    [navigate, searchParams],
  );

  const projectSessions: ConversationSummary[] = currentProject?.path
    ? (sessionIndex.get(currentProject.path) ?? [])
    : [];

  const activeSession = activeSessionId
    ? (projectSessions.find((entry) => entry.sessionId === activeSessionId) ??
      null)
    : null;

  // The tab strip is always keyed on the *parent* session id — either the
  // active session itself (when viewing the parent) or its parentSessionId
  // (when viewing a subagent). The title always reflects the session the user
  // is currently viewing; while on a subagent, the title and back-chevron both
  // navigate back to the parent conversation.
  const parentSessionId = activeSession?.parentSessionId ?? activeSessionId;
  const isViewingSubagent = Boolean(activeSession?.parentSessionId);
  const canRenameSession =
    !isViewingSubagent && (activeSession?.kind ?? "chat") === "chat";
  const canClickTitle = canRenameSession || isViewingSubagent;

  const storeTitle = activeSession?.title ?? null;

  const handleBackToParent = useCallback(() => {
    if (!parentSessionId) return;
    const next = new URLSearchParams(searchParams);
    next.set("sessionId", parentSessionId);
    navigate({ search: next.toString() });
  }, [parentSessionId, navigate, searchParams]);

  const defaultTitle =
    messages.length > 0
      ? (
          messages.find(
            (message) => message.type === "chat" && message.role === "user",
          ) as ChatMessage | undefined
        )?.content
          ?.split("\n")[0]
          ?.substring(0, 80) || "New conversation"
      : "New conversation";

  const conversationTitle = chatSessionTitle || storeTitle || defaultTitle;

  useEffect(() => {
    setIsEditingTitle(false);
  }, [activeSessionId]);

  const handleTitleClick = useCallback(() => {
    if (isHistoryView) return;
    if (isViewingSubagent) {
      handleBackToParent();
      return;
    }
    if (!canRenameSession) return;
    setEditTitleValue(conversationTitle);
    setIsEditingTitle(true);
    setTimeout(() => titleInputRef.current?.select(), 0);
  }, [
    canRenameSession,
    conversationTitle,
    handleBackToParent,
    isHistoryView,
    isViewingSubagent,
  ]);

  const handleTitleSave = useCallback(() => {
    const newTitle = editTitleValue.trim();
    setIsEditingTitle(false);

    if (!newTitle || newTitle === conversationTitle || !activeSessionId) {
      return;
    }

    updateIndexedSessionTitle(activeSessionId, newTitle);
    void updateChatSessionTitle(activeSessionId, newTitle);
  }, [
    conversationTitle,
    editTitleValue,
    activeSessionId,
    updateChatSessionTitle,
    updateIndexedSessionTitle,
  ]);

  const handleTitleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter") {
        handleTitleSave();
      } else if (event.key === "Escape") {
        setIsEditingTitle(false);
      }
    },
    [handleTitleSave],
  );

  return (
    <div className="flex items-center gap-1.5 px-3 h-8 bg-[#161b22] border-b border-[#30363d] shrink-0 min-w-0">
      {isHistoryView && (
        <button
          onClick={onBackToChat}
          className="text-[#8b949e] hover:text-[#c9d1d9] transition-colors shrink-0"
          aria-label="Back"
        >
          <ChevronLeftIcon className="w-4 h-4" />
        </button>
      )}
      {!isHistoryView && isViewingSubagent && (
        <button
          onClick={handleBackToParent}
          data-testid="subagent-back-button"
          className="text-[#8b949e] hover:text-[#c9d1d9] transition-colors shrink-0"
          title="Back to parent session"
          aria-label="Back to parent session"
        >
          <ChevronLeftIcon className="w-4 h-4" />
        </button>
      )}
      {isHistoryView ? (
        <span className="text-xs text-[#c9d1d9] font-medium">History</span>
      ) : (
        <div className="flex items-center gap-1.5 min-w-0 flex-1 overflow-hidden self-stretch">
          {currentProject && (
            <>
              <span className="text-xs text-[#8b949e] shrink-0">
                {currentProject.name}
              </span>
              <span className="text-xs text-[#484f58] shrink-0">&gt;</span>
            </>
          )}
          {isEditingTitle ? (
            <input
              ref={titleInputRef}
              data-testid="session-title-input"
              value={editTitleValue}
              onChange={(event) => setEditTitleValue(event.target.value)}
              onBlur={handleTitleSave}
              onKeyDown={handleTitleKeyDown}
              className="text-xs text-[#e6edf3] bg-[#0d1117] border border-[#58a6ff] rounded px-1.5 py-0.5 outline-none min-w-[100px] flex-1"
              maxLength={120}
              autoFocus
            />
          ) : (
            <button
              onClick={handleTitleClick}
              data-testid="session-title-button"
              data-session-id={activeSessionId ?? undefined}
              className={`text-xs text-left truncate min-w-[80px] transition-colors ${
                canClickTitle
                  ? "text-[#c9d1d9] hover:text-[#e6edf3]"
                  : "text-[#c9d1d9] cursor-default"
              }`}
              title={
                isViewingSubagent
                  ? "Back to main session"
                  : canRenameSession
                    ? "Click to rename"
                    : undefined
              }
              disabled={!canClickTitle}
            >
              {conversationTitle}
            </button>
          )}
          {parentSessionId && (
            <SubagentTabStrip
              parentId={parentSessionId}
              siblings={projectSessions}
              activeSessionId={activeSessionId}
              onSelect={handleSelectSubagent}
            />
          )}
        </div>
      )}
      <div className="shrink-0" />
      {!isHistoryView && (
        <button
          data-testid="background-activity-toggle"
          data-state={showBackgroundActivity ? "on" : "off"}
          onClick={() => setShowBackgroundActivity(!showBackgroundActivity)}
          title={
            showBackgroundActivity
              ? "Hide background activity"
              : "Show background activity"
          }
          className="text-[10px] px-2 py-1 rounded border border-[#30363d] text-[#8b949e] hover:text-[#c9d1d9] hover:border-[#484f58] transition-colors shrink-0"
        >
          {showBackgroundActivity ? "Hide bg" : "Show bg"}
        </button>
      )}
      {!isHistoryView && subprocessCount > 0 && (
        <div className="relative shrink-0">
          <button
            ref={subprocessButtonRef}
            onClick={() => setSubprocessOverlayOpen((prev) => !prev)}
            className="flex items-center gap-1 px-1.5 py-0.5 rounded border border-[#30363d] text-[#8b949e] hover:text-[#c9d1d9] hover:border-[#484f58] transition-colors"
            title="Running processes"
            aria-label={`${subprocessCount} running process${subprocessCount === 1 ? "" : "es"}`}
          >
            <CommandLineIcon className="w-3.5 h-3.5" />
            <span className="text-[10px] tabular-nums">{subprocessCount}</span>
          </button>
          {subprocessOverlayOpen && activeSessionId && (
            <SubprocessOverlay
              sessionId={activeSessionId}
              processes={subprocesses}
              anchorRef={subprocessButtonRef}
              onClose={() => setSubprocessOverlayOpen(false)}
            />
          )}
        </div>
      )}
      {!isHistoryView && <HistoryButton onClick={onHistoryClick} />}
      {!isHistoryView && currentProject?.features?.preview?.enabled && (
        <button
          onClick={() =>
            window.dispatchEvent(new CustomEvent("toggle-mobile-preview"))
          }
          data-testid="mobile-preview-toggle"
          className="rounded p-1 text-[#8b949e] transition-colors hover:text-[#c9d1d9]"
          aria-label="Open mobile preview"
          title="Mobile preview"
        >
          <DevicePhoneMobileIcon className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}
