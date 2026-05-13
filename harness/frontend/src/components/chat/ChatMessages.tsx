import {
  useRef,
  useEffect,
  useLayoutEffect,
  useCallback,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type WheelEvent,
} from "react";
import type {
  AllMessage,
  SubagentLaneMessage,
  TaskLifecycleUpdate,
  TodoItem,
} from "../../types";
import { getSessionsMap, subscribeSessions } from "../../stores/sessions";
import {
  isChatMessage,
  isImageMessage,
  isCompactMessage,
  isSystemMessage,
  isToolMessage,
  isToolResultMessage,
  isPlanMessage,
  isThinkingMessage,
  isTodoMessage,
  isSubagentLaneMessage,
} from "../../types";
import {
  ChatMessageComponent,
  ImageMessageComponent,
  CompactMessageComponent,
  SystemMessageComponent,
  ToolMessageComponent,
  ToolResultMessageComponent,
  PlanMessageComponent,
  ThinkingMessageComponent,
  TodoMessageComponent,
  SubagentLaneComponent,
  LoadingComponent,
  InlineToolCallRow,
  InlineProseRow,
} from "./MessageComponents";
import { BlockedOnHumanBanner } from "./BlockedOnHumanBanner";
import { useChatStore } from "../../stores/chatStore";
import { useAppStore } from "../../stores/appStore";
import { normalizeWindowsPath } from "../../utils/pathUtils";
import { sendMessage } from "./sendMessage";
import {
  consumeUnreadScrollTarget,
  getUnreadSessions,
  markSessionRead,
  subscribeUnreadSessions,
} from "../../stores/unreadSessions";

const READ_DISMISS_ROWS = 20;
const READ_DISMISS_ROW_HEIGHT_PX = 20;
const READ_DISMISS_TAIL_PX = 40;

function getResultText(message: AllMessage): string {
  if (!isSystemMessage(message) || message.type !== "result") return "";
  const result = (message as { result?: unknown }).result;
  return typeof result === "string" ? result.trim() : "";
}

function isProviderErrorResult(message: AllMessage): boolean {
  if (!isSystemMessage(message) || message.type !== "result") return false;
  const raw = message as Record<string, unknown>;
  return (
    raw.is_error === true &&
    (typeof raw.api_error_status === "number" || getResultText(message) !== "")
  );
}

function isTrailingClaudeTransportError(message: AllMessage): boolean {
  const text = getResultText(message);
  return (
    text.startsWith("Claude CLI exited with code ") &&
    text.includes("Decompression error: ZlibError")
  );
}

export function ChatMessages() {
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const assistantStartRef = useRef<HTMLDivElement>(null);
  const userMessageRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const stickyCloneRef = useRef<HTMLDivElement>(null);
  const lastScrollTopRef = useRef(0);
  const restoreScrollHeightAfterOlderLoadRef = useRef<number | null>(null);
  const [stickyState, setStickyState] = useState<{
    index: number;
    pushOffset: number;
  }>({ index: -1, pushOffset: 0 });
  const activeStickyIndex = stickyState.index;
  const isAtBottomRef = useRef(true);
  const prevLastUserTimestampRef = useRef<number | null>(null);
  const assistantStartScrollKeyRef = useRef<string | null>(null);
  const messages = useChatStore((state) => state.messages);
  const currentSessionId = useChatStore((state) => state.sessionId);
  const sessionsMap = useSyncExternalStore(subscribeSessions, getSessionsMap);
  const unreadSessions = useSyncExternalStore(
    subscribeUnreadSessions,
    getUnreadSessions,
  );
  const currentUnreadBoundary = currentSessionId
    ? unreadSessions.get(currentSessionId)
    : undefined;
  // Subagent sessions are chats whose first user message was written by the
  // parent assistant (via mcp__swarmfleet__spawn_subagent). We look up the current
  // session's kind in the sessions index to decide whether to render that
  // first user bubble in the purple "parent agent" variant.
  const isSubagentSession = (() => {
    if (!currentSessionId) return false;
    for (const list of sessionsMap.values()) {
      for (const entry of list) {
        if (entry.sessionId === currentSessionId) {
          return entry.kind === "subagent";
        }
      }
    }
    return false;
  })();
  const showBackgroundActivity = useChatStore((state) => {
    const chatState = state as {
      showBackgroundActivity?: boolean;
    };
    return chatState.showBackgroundActivity ?? false;
  });
  const currentAssistantMessage = useChatStore(
    (state) => state.currentAssistantMessage,
  );
  const phase = useChatStore((state) => state.phase);
  const historyLoading = useChatStore((state) => state.historyLoading);
  const historyPage = useChatStore((state) => state.historyPage);
  const olderHistoryLoading = useChatStore((state) => state.olderHistoryLoading);
  const loadOlderHistory = useChatStore((state) => state.loadOlderHistory);
  const setInput = useChatStore((state) => state.setInput);
  const blockedOnHuman = useChatStore((state) => state.blockedOnHuman);
  const isBlockedOnHuman = blockedOnHuman !== null;

  // Pending scroll target for "jump to first unread" when the user opens a
  // session that had accumulated background activity. The Sidebar hands off
  // the unread boundary through a transient store slot; we consume it
  // synchronously on the first render that sees a new session id so the
  // chosen target is stable for the rest of this session's mount.
  const pendingUnreadBoundaryRef = useRef<number | null>(null);
  const consumedForSessionRef = useRef<string | null | undefined>(undefined);
  const unreadScrollDoneForSessionRef = useRef<string | null>(null);
  const lastMessageOpenScrollDoneForSessionRef = useRef<string | null>(null);
  const unreadTargetRef = useRef<HTMLDivElement | null>(null);
  const lastMessageOpenTargetRef = useRef<HTMLDivElement | null>(null);
  const lastViewportReadKeyRef = useRef<string | null>(null);
  if (consumedForSessionRef.current !== currentSessionId) {
    consumedForSessionRef.current = currentSessionId;
    unreadScrollDoneForSessionRef.current = null;
    lastMessageOpenScrollDoneForSessionRef.current = null;
    assistantStartScrollKeyRef.current = null;
    pendingUnreadBoundaryRef.current = currentSessionId
      ? (consumeUnreadScrollTarget(currentSessionId) ?? null)
      : null;
  }
  const currentProject = useAppStore((state) => state.currentProject);
  const projectPath = currentProject?.path ?? null;
  const workingDirectory = currentProject?.path
    ? normalizeWindowsPath(currentProject.path)
    : undefined;
  const encodedName = currentProject?.encodedName ?? null;
  const canSend =
    phase !== "streaming" &&
    phase !== "awaiting-permission" &&
    phase !== "loading-history";

  const handleEditUserMessage = useCallback(
    (content: string) => {
      setInput(content);
      requestAnimationFrame(() => {
        const ta = document.querySelector<HTMLTextAreaElement>(
          '[data-testid="chat-input"]',
        );
        if (ta) {
          ta.focus();
          ta.setSelectionRange(content.length, content.length);
        }
      });
    },
    [setInput],
  );

  const handleSendAgain = useCallback(
    (content: string) => {
      if (!canSend) return;
      void sendMessage(workingDirectory, encodedName, content);
    },
    [workingDirectory, encodedName, canSend],
  );
  const lastMessage = messages[messages.length - 1];
  const hasMatchingAssistantTail =
    !!currentAssistantMessage &&
    isChatMessage(lastMessage) &&
    lastMessage.role === currentAssistantMessage.role &&
    lastMessage.content === currentAssistantMessage.content &&
    lastMessage.timestamp === currentAssistantMessage.timestamp;
  const displayMessages =
    currentAssistantMessage && !hasMatchingAssistantTail
      ? [...messages, currentAssistantMessage]
      : messages;
  // When a `result` message's body text matches the immediately preceding
  // assistant chat bubble verbatim, hide that inline bubble — the result
  // card will own the rendering. Only kicks in on exact match.
  const hiddenAssistantIndices = new Set<number>();
  for (let i = 0; i < displayMessages.length; i++) {
    const m = displayMessages[i];
    if (!isSystemMessage(m) || m.type !== "result") {
      continue;
    }
    const resultText = getResultText(m);
    if (!resultText) continue;
    // Walk back to the most recent assistant chat message.
    for (let j = i - 1; j >= 0; j--) {
      const prev = displayMessages[j];
      if (isChatMessage(prev) && prev.role === "assistant") {
        if (prev.content.trim() === resultText) {
          hiddenAssistantIndices.add(j);
        }
        break;
      }
    }
  }
  const hiddenTransportErrorIndices = new Set<number>();
  for (let i = 1; i < displayMessages.length; i++) {
    if (
      isTrailingClaudeTransportError(displayMessages[i]) &&
      isProviderErrorResult(displayMessages[i - 1])
    ) {
      hiddenTransportErrorIndices.add(i);
    }
  }
  const visibleMessages = displayMessages.filter((message, idx) => {
    if (!showBackgroundActivity && isBackgroundActivityMessage(message)) {
      return false;
    }
    if (hiddenAssistantIndices.has(idx)) return false;
    if (hiddenTransportErrorIndices.has(idx)) return false;
    return true;
  });
  const lastVisibleMessage =
    visibleMessages[visibleMessages.length - 1] ?? null;
  const lastVisibleTimestamp = (
    lastVisibleMessage as { timestamp?: unknown } | null
  )?.timestamp;
  const viewportReadKey =
    currentSessionId && visibleMessages.length > 0
      ? `${currentSessionId}:${visibleMessages.length}:${typeof lastVisibleTimestamp === "number" ? lastVisibleTimestamp : ""}`
      : null;
  const isLoading = phase === "streaming" || phase === "awaiting-permission";
  const taskLifecycle = useMemo(
    () => buildTaskLifecycleState(visibleMessages),
    [visibleMessages],
  );
  const bashCommandsByToolUseId = useMemo(
    () => buildBashCommandsByToolUseId(visibleMessages),
    [visibleMessages],
  );
  const { rendered: renderedMessages, resultIndicesWithMovedStats } =
    buildRenderedMessages(visibleMessages, taskLifecycle.hiddenUpdateIndices);
  const lastRenderedIdx = renderedMessages.length - 1;

  // For each TodoMessage index, remember the previous TodoMessage's todos so
  // the component can render only the diff.
  const prevTodosByIndex = new Map<number, TodoItem[] | null>();
  {
    let lastTodos: TodoItem[] | null = null;
    for (let i = 0; i < visibleMessages.length; i++) {
      const m = visibleMessages[i];
      if (isTodoMessage(m)) {
        prevTodosByIndex.set(i, lastTodos);
        lastTodos = m.todos;
      }
    }
  }

  let lastUserMessageIndex = -1;
  for (let i = visibleMessages.length - 1; i >= 0; i--) {
    const m = visibleMessages[i];
    if (isChatMessage(m) && m.role === "user") {
      lastUserMessageIndex = i;
      break;
    }
  }

  // First user message index — only meaningful in subagent sessions where we
  // paint that single bubble purple (the spawn prompt from the parent
  // assistant). Later user messages in a subagent session stay blue so a
  // human resuming the thread still looks like a human.
  let firstUserMessageIndex = -1;
  for (let i = 0; i < visibleMessages.length; i += 1) {
    const m = visibleMessages[i];
    if (isChatMessage(m) && m.role === "user") {
      firstUserMessageIndex = i;
      break;
    }
  }

  let firstAssistantAfterLastUserMessageIdx = -1;
  if (lastUserMessageIndex >= 0) {
    for (let i = lastUserMessageIndex + 1; i < visibleMessages.length; i += 1) {
      const m = visibleMessages[i];
      if (isChatMessage(m) && m.role === "assistant") {
        firstAssistantAfterLastUserMessageIdx = i;
        break;
      }
    }
  }

  let firstAssistantAfterLastUserRenderedIdx = -1;
  if (firstAssistantAfterLastUserMessageIdx >= 0) {
    for (let i = 0; i < renderedMessages.length; i += 1) {
      const entry = renderedMessages[i];
      if (
        entry.type === "message" &&
        entry.index === firstAssistantAfterLastUserMessageIdx
      ) {
        firstAssistantAfterLastUserRenderedIdx = i;
        break;
      }
    }
  }
  const firstAssistantAfterLastUserMessage =
    firstAssistantAfterLastUserMessageIdx >= 0
      ? visibleMessages[firstAssistantAfterLastUserMessageIdx]
      : null;
  const assistantStartScrollKey =
    currentSessionId &&
    firstAssistantAfterLastUserMessageIdx >= 0 &&
    firstAssistantAfterLastUserMessage
      ? `${currentSessionId}:${firstAssistantAfterLastUserMessageIdx}:${String(
          (firstAssistantAfterLastUserMessage as { timestamp?: unknown })
            .timestamp ?? "",
        )}`
      : null;

  // First unread message (timestamp strictly greater than the stored
  // boundary). Translated to an index into `renderedMessages` so we can
  // attach a ref to the actual DOM element that may be a group wrapper.
  const pendingUnreadBoundary = pendingUnreadBoundaryRef.current;
  let firstUnreadRenderedIdx = -1;
  let firstUnreadMessageIdx = -1;
  if (pendingUnreadBoundary !== null && visibleMessages.length > 0) {
    for (let i = 0; i < visibleMessages.length; i += 1) {
      const m = visibleMessages[i];
      const ts = (m as { timestamp?: unknown }).timestamp;
      if (typeof ts === "number" && ts > pendingUnreadBoundary) {
        firstUnreadMessageIdx = i;
        break;
      }
    }
    if (firstUnreadMessageIdx >= 0) {
      for (let i = 0; i < renderedMessages.length; i += 1) {
        const entry = renderedMessages[i];
        const entryFirstIdx =
          entry.type === "message" ? entry.index : entry.firstIndex;
        if (entryFirstIdx <= firstUnreadMessageIdx) {
          firstUnreadRenderedIdx = i;
        } else {
          break;
        }
      }
      // If no entry starts at/before the unread index (all groups start
      // later), scroll to the first rendered entry containing it.
      if (firstUnreadRenderedIdx < 0 && renderedMessages.length > 0) {
        firstUnreadRenderedIdx = 0;
      }
    }
  }

  let previousUserBeforeUnreadIdx = -1;
  if (firstUnreadMessageIdx >= 0) {
    for (let i = firstUnreadMessageIdx - 1; i >= 0; i -= 1) {
      const message = visibleMessages[i];
      if (isChatMessage(message) && message.role === "user") {
        previousUserBeforeUnreadIdx = i;
        break;
      }
    }
  }

  const activeStickyMessage =
    activeStickyIndex >= 0 ? visibleMessages[activeStickyIndex] : null;
  const activeStickyContent =
    activeStickyMessage && isChatMessage(activeStickyMessage)
      ? activeStickyMessage.content
      : null;
  const activeStickyTimestamp =
    activeStickyMessage && isChatMessage(activeStickyMessage)
      ? activeStickyMessage.timestamp
      : null;

  const attachUserRef = useCallback(
    (idx: number) => (el: HTMLDivElement | null) => {
      if (el) userMessageRefs.current.set(idx, el);
      else userMessageRefs.current.delete(idx);
    },
    [],
  );

  const recomputeActiveSticky = useCallback(() => {
    const container = messagesContainerRef.current;
    const setHidden = () =>
      setStickyState((prev) =>
        prev.index === -1 && prev.pushOffset === 0
          ? prev
          : { index: -1, pushOffset: 0 },
      );
    if (!container) {
      setHidden();
      return;
    }
    const containerTop = container.getBoundingClientRect().top;
    const entries = Array.from(userMessageRefs.current.entries()).sort(
      (a, b) => a[0] - b[0],
    );

    // Header = latest user message whose TOP has scrolled past (or is at)
    // the container top. Next = the first user message still below it.
    let headerIdx = -1;
    let nextIdx = -1;
    for (const [idx, el] of entries) {
      const rect = el.getBoundingClientRect();
      if (rect.top <= containerTop) {
        headerIdx = idx;
      } else {
        nextIdx = idx;
        break;
      }
    }

    if (headerIdx === -1) {
      setHidden();
      return;
    }

    // If the real header bubble is still (partially) visible at the top
    // of the viewport, don't show the clone — the real bubble plays the
    // role of the pinned message naturally.
    const headerEl = userMessageRefs.current.get(headerIdx);
    if (headerEl) {
      const headerRect = headerEl.getBoundingClientRect();
      if (headerRect.bottom > containerTop) {
        setHidden();
        return;
      }
    }

    // Push: as the next user bubble approaches the top, translate the
    // floating clone upward so that the incoming bubble appears to shove
    // it out of view.
    let pushOffset = 0;
    if (nextIdx !== -1 && stickyCloneRef.current) {
      const nextEl = userMessageRefs.current.get(nextIdx);
      if (nextEl) {
        const distToTop = nextEl.getBoundingClientRect().top - containerTop;
        const cloneHeight = stickyCloneRef.current.offsetHeight;
        if (cloneHeight > 0 && distToTop < cloneHeight) {
          pushOffset = -(cloneHeight - Math.max(0, distToTop));
        }
      }
    }

    setStickyState((prev) =>
      prev.index === headerIdx && prev.pushOffset === pushOffset
        ? prev
        : { index: headerIdx, pushOffset },
    );
  }, []);

  const scrollToActiveSticky = useCallback(() => {
    if (activeStickyIndex < 0) return;
    const el = userMessageRefs.current.get(activeStickyIndex);
    el?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [activeStickyIndex]);

  // The jump-to-bottom arrow appears once the user has scrolled far enough
  // away from the tail — far enough that the message they sent (or the
  // spinner) is well out of sight. 240px is roughly two short bubbles of
  // padding.
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const handleWheel = useCallback((event: WheelEvent<HTMLDivElement>) => {
    if (event.deltaY < 0) {
      isAtBottomRef.current = false;
    }
  }, []);
  const handlePointerDown = useCallback(() => {}, []);
  const handleTouchMove = useCallback(() => {}, []);
  const markReadIfLatestVisible = useCallback(() => {
    const container = messagesContainerRef.current;
    const tail = messagesEndRef.current;
    if (
      !container ||
      !tail ||
      !currentSessionId ||
      !viewportReadKey ||
      currentUnreadBoundary === undefined
    ) {
      return;
    }

    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    const containerRect = container.getBoundingClientRect();
    const tailRect = tail.getBoundingClientRect();
    const visibleInsetFromBottom = containerRect.bottom - tailRect.top;
    const requestedInset = READ_DISMISS_ROWS * READ_DISMISS_ROW_HEIGHT_PX;
    const requiredInset = Math.min(
      requestedInset,
      Math.max(0, container.clientHeight * 0.6),
    );
    const latestIsSeen =
      distanceFromBottom < READ_DISMISS_TAIL_PX ||
      visibleInsetFromBottom >= requiredInset;

    if (!latestIsSeen || lastViewportReadKeyRef.current === viewportReadKey)
      return;
    lastViewportReadKeyRef.current = viewportReadKey;
    void markSessionRead(currentSessionId);
  }, [currentSessionId, currentUnreadBoundary, viewportReadKey]);
  const maybeLoadOlderHistory = useCallback(() => {
    const el = messagesContainerRef.current;
    if (
      !el ||
      !historyPage?.hasMoreBefore ||
      olderHistoryLoading ||
      historyLoading
    ) {
      return;
    }

    // Keep initial history fast by loading only one page up front, but make the
    // lazy loader reliable: if the rendered page is short/collapsed enough that
    // there is no meaningful upward scroll range, or the user is already near
    // the top, fetch the previous page. Otherwise long sessions can look like
    // they have only the final message because no scroll event can reach the
    // top-loader threshold.
    const nearTop = el.scrollTop < 120;
    const cannotScrollUpEnough = el.scrollHeight - el.clientHeight < 120;
    if (!nearTop && !cannotScrollUpEnough) return;

    restoreScrollHeightAfterOlderLoadRef.current = el.scrollHeight;
    void loadOlderHistory();
  }, [
    historyPage?.hasMoreBefore,
    olderHistoryLoading,
    historyLoading,
    loadOlderHistory,
  ]);

  const handleScroll = useCallback(() => {
    const el = messagesContainerRef.current;
    if (!el) return;
    const previousScrollTop = lastScrollTopRef.current;
    const movedUp = el.scrollTop < previousScrollTop;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (movedUp) {
      isAtBottomRef.current = false;
    } else if (distanceFromBottom < 40) {
      isAtBottomRef.current = true;
    }
    lastScrollTopRef.current = el.scrollTop;
    setShowScrollToBottom((prev) => {
      const next = distanceFromBottom > 240;
      return prev === next ? prev : next;
    });
    maybeLoadOlderHistory();
    recomputeActiveSticky();
    markReadIfLatestVisible();
  }, [
    recomputeActiveSticky,
    markReadIfLatestVisible,
    maybeLoadOlderHistory,
  ]);

  const scrollToBottom = useCallback(() => {
    const el = messagesContainerRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, []);

  useEffect(() => {
    const lastUserMsg =
      lastUserMessageIndex >= 0 ? visibleMessages[lastUserMessageIndex] : null;
    const lastUserTimestamp =
      lastUserMsg && isChatMessage(lastUserMsg) ? lastUserMsg.timestamp : null;
    const isNewUserMessage =
      lastUserTimestamp !== null &&
      prevLastUserTimestampRef.current !== null &&
      lastUserTimestamp !== prevLastUserTimestampRef.current;
    prevLastUserTimestampRef.current = lastUserTimestamp;

    if (isNewUserMessage) {
      // New user turn — always snap, and re-engage auto-scroll.
      isAtBottomRef.current = true;
      assistantStartScrollKeyRef.current = null;
      messagesEndRef.current?.scrollIntoView({ behavior: "instant" });
    } else if (isAtBottomRef.current) {
      // Anchor the first render of a new assistant turn at its start. After
      // that, keep the tail pinned so manual scrolling to the bottom during a
      // long response doesn't jump back to the first assistant prose row.
      if (
        assistantStartRef.current &&
        assistantStartScrollKey &&
        assistantStartScrollKeyRef.current !== assistantStartScrollKey
      ) {
        assistantStartScrollKeyRef.current = assistantStartScrollKey;
        assistantStartRef.current.scrollIntoView({
          behavior: "instant",
          block: "start",
        });
      } else {
        messagesEndRef.current?.scrollIntoView({ behavior: "instant" });
      }
    }
    recomputeActiveSticky();
    markReadIfLatestVisible();
  }, [
    visibleMessages,
    recomputeActiveSticky,
    lastUserMessageIndex,
    firstAssistantAfterLastUserRenderedIdx,
    assistantStartScrollKey,
    markReadIfLatestVisible,
  ]);

  useLayoutEffect(() => {
    const previousHeight = restoreScrollHeightAfterOlderLoadRef.current;
    const container = messagesContainerRef.current;
    if (previousHeight === null || !container || olderHistoryLoading) return;
    restoreScrollHeightAfterOlderLoadRef.current = null;
    container.scrollTop += Math.max(0, container.scrollHeight - previousHeight);
  }, [olderHistoryLoading, visibleMessages.length]);

  // After opening an unread session, scroll to the first unread entry. If
  // that unread entry is a completed-turn result, bias the landing position
  // so the tail of the preceding user prompt remains visible above it,
  // capped at roughly seven lines.
  useLayoutEffect(() => {
    if (firstUnreadRenderedIdx < 0) return;
    if (historyLoading) return;
    if (!currentSessionId) return;
    if (unreadScrollDoneForSessionRef.current === currentSessionId) return;

    const container = messagesContainerRef.current;
    const target = unreadTargetRef.current;
    if (!container || !target) return;

    unreadScrollDoneForSessionRef.current = currentSessionId;
    pendingUnreadBoundaryRef.current = null;
    // Don't let the ResizeObserver's "pin to bottom" path clobber this.
    isAtBottomRef.current = false;

    const unreadMessage =
      firstUnreadMessageIdx >= 0
        ? visibleMessages[firstUnreadMessageIdx]
        : null;
    let desiredOffset = container.clientHeight * 0.7;
    if (
      unreadMessage &&
      isSystemMessage(unreadMessage) &&
      unreadMessage.type === "result" &&
      previousUserBeforeUnreadIdx >= 0
    ) {
      const userWrapper = userMessageRefs.current.get(
        previousUserBeforeUnreadIdx,
      );
      const userBubble = userWrapper?.querySelector<HTMLElement>(
        "[data-message-bubble='user']",
      );
      const userBody = userWrapper?.querySelector<HTMLElement>(
        "[data-message-body='user']",
      );
      if (userWrapper && userBubble && userBody) {
        const targetRect = target.getBoundingClientRect();
        const userRect = userBubble.getBoundingClientRect();
        const gap = Math.max(0, targetRect.top - userRect.bottom);
        const bodyStyle = window.getComputedStyle(userBody);
        const lineHeight = parseFloat(bodyStyle.lineHeight) || 22;
        const bodyRect = userBody.getBoundingClientRect();
        const bodyTopInset = Math.max(0, bodyRect.top - userRect.top);
        const visibleInputHeight = Math.min(bodyRect.height, lineHeight * 6);
        const maxVisibleUserHeight = Math.min(
          userBubble.offsetHeight,
          bodyTopInset + visibleInputHeight,
        );
        desiredOffset = maxVisibleUserHeight + gap;
      }
    }

    const containerRect = container.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const delta = targetRect.top - containerRect.top - desiredOffset;
    container.scrollTop += delta;
  }, [
    firstUnreadRenderedIdx,
    firstUnreadMessageIdx,
    historyLoading,
    currentSessionId,
    previousUserBeforeUnreadIdx,
    visibleMessages,
  ]);

  // When opening a session with no unread-specific target, land at the top of
  // the latest rendered message instead of the absolute bottom. That keeps long
  // final replies readable from their beginning.
  useLayoutEffect(() => {
    if (historyLoading) return;
    if (!currentSessionId) return;
    if (visibleMessages.length === 0) return;
    if (firstUnreadRenderedIdx >= 0) return;
    if (lastMessageOpenScrollDoneForSessionRef.current === currentSessionId) {
      return;
    }

    const container = messagesContainerRef.current;
    const target = lastMessageOpenTargetRef.current;
    if (!container || !target) return;

    lastMessageOpenScrollDoneForSessionRef.current = currentSessionId;
    isAtBottomRef.current = false;
    target.scrollIntoView({ behavior: "instant", block: "start" });
    recomputeActiveSticky();
    markReadIfLatestVisible();
  }, [
    currentSessionId,
    firstUnreadRenderedIdx,
    historyLoading,
    recomputeActiveSticky,
    markReadIfLatestVisible,
    visibleMessages.length,
  ]);

  useLayoutEffect(() => {
    if (historyLoading || olderHistoryLoading) return;
    const initialOpenScrollDone =
      !currentSessionId ||
      unreadScrollDoneForSessionRef.current === currentSessionId ||
      lastMessageOpenScrollDoneForSessionRef.current === currentSessionId;
    if (!initialOpenScrollDone) return;
    maybeLoadOlderHistory();
  }, [
    currentSessionId,
    historyLoading,
    olderHistoryLoading,
    maybeLoadOlderHistory,
    visibleMessages.length,
  ]);

  // Keep the bottom pinned when the container resizes — e.g., when the chat
  // input grows with a multiline message and pushes this area smaller.
  useEffect(() => {
    const el = messagesContainerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (isAtBottomRef.current) {
        messagesEndRef.current?.scrollIntoView({ behavior: "instant" });
      }
      recomputeActiveSticky();
      markReadIfLatestVisible();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [recomputeActiveSticky, markReadIfLatestVisible]);

  const renderMessage = (message: AllMessage, index: number) => {
    const key = `${message.timestamp}-${index}`;
    const isBackgroundMessage =
      showBackgroundActivity && isBackgroundActivityMessage(message);

    if (isSystemMessage(message)) {
      const hideStats = resultIndicesWithMovedStats.has(index);
      const taskId = getTaskStartedId(message);
      const taskUpdate = taskId
        ? taskLifecycle.updatesByTaskId.get(taskId)
        : undefined;
      const taskToolUseId = getTaskToolUseId(message);
      const taskCommand = taskToolUseId
        ? bashCommandsByToolUseId.get(taskToolUseId)
        : undefined;
      return isBackgroundMessage ? (
        <div
          key={key}
          className="rounded-md border border-dashed border-[#30363d] bg-[#11161d]/80 px-2 py-1 opacity-80"
        >
          <SystemMessageComponent
            message={message}
            hideStats={hideStats}
            taskUpdate={taskUpdate}
            taskCommand={taskCommand}
          />
        </div>
      ) : (
        <SystemMessageComponent
          key={key}
          message={message}
          hideStats={hideStats}
          taskUpdate={taskUpdate}
          taskCommand={taskCommand}
        />
      );
    } else if (isCompactMessage(message)) {
      return <CompactMessageComponent key={key} message={message} />;
    } else if (isToolMessage(message)) {
      return isBackgroundMessage ? (
        <div
          key={key}
          className="rounded-md border border-dashed border-[#30363d] bg-[#11161d]/80 px-2 py-1 opacity-80"
        >
          <ToolMessageComponent message={message} projectPath={projectPath} />
        </div>
      ) : (
        <ToolMessageComponent
          key={key}
          message={message}
          projectPath={projectPath}
        />
      );
    } else if (isToolResultMessage(message)) {
      return isBackgroundMessage ? (
        <div
          key={key}
          className="rounded-md border border-dashed border-[#30363d] bg-[#11161d]/80 px-2 py-1 opacity-80"
        >
          <ToolResultMessageComponent
            message={message}
            projectPath={projectPath}
          />
        </div>
      ) : (
        <ToolResultMessageComponent
          key={key}
          message={message}
          projectPath={projectPath}
        />
      );
    } else if (isPlanMessage(message)) {
      return isBackgroundMessage ? (
        <div
          key={key}
          className="rounded-md border border-dashed border-[#30363d] bg-[#11161d]/80 px-2 py-1 opacity-80"
        >
          <PlanMessageComponent message={message} />
        </div>
      ) : (
        <PlanMessageComponent key={key} message={message} />
      );
    } else if (isThinkingMessage(message)) {
      return isBackgroundMessage ? (
        <div
          key={key}
          className="rounded-md border border-dashed border-[#30363d] bg-[#11161d]/80 px-2 py-1 opacity-80"
        >
          <ThinkingMessageComponent
            message={message}
            nextMessage={visibleMessages[index + 1]}
          />
        </div>
      ) : (
        <ThinkingMessageComponent
          key={key}
          message={message}
          nextMessage={visibleMessages[index + 1]}
        />
      );
    } else if (isTodoMessage(message)) {
      const prevTodos = prevTodosByIndex.get(index) ?? null;
      // If no todos actually changed since the previous TodoMessage, the
      // diff renderer returns null — render nothing at all (no wrapper).
      const hasDiff =
        !prevTodos ||
        prevTodos.length !== message.todos.length ||
        prevTodos.some((p, i) => {
          const n = message.todos[i];
          return !n || n.content !== p.content || n.status !== p.status;
        });
      if (!hasDiff) return null;
      return isBackgroundMessage ? (
        <div
          key={key}
          className="rounded-md border border-dashed border-[#30363d] bg-[#11161d]/80 px-2 py-1 opacity-80"
        >
          <TodoMessageComponent message={message} prevTodos={prevTodos} />
        </div>
      ) : (
        <TodoMessageComponent
          key={key}
          message={message}
          prevTodos={prevTodos}
        />
      );
    } else if (isChatMessage(message)) {
      const isLastUserMessage = index === lastUserMessageIndex;
      const isUser = message.role === "user";
      const variant: "user" | "parent-agent" | "loop" =
        isSubagentSession && isUser && index === firstUserMessageIndex
          ? "parent-agent"
          : isUser && message.trigger_source === "loop"
            ? "loop"
            : "user";
      const inner = (
        <ChatMessageComponent
          message={message}
          isLastUserMessage={isLastUserMessage}
          onEdit={handleEditUserMessage}
          onSendAgain={canSend ? handleSendAgain : undefined}
          variant={variant}
        />
      );
      const body = isBackgroundMessage ? (
        <div className="rounded-md border border-dashed border-[#30363d] bg-[#11161d]/80 px-2 py-1 opacity-80">
          {inner}
        </div>
      ) : (
        inner
      );
      if (isUser) {
        return (
          <div
            key={key}
            ref={attachUserRef(index)}
            data-user-msg-index={index}
            data-testid={isLastUserMessage ? "last-user-message" : undefined}
          >
            {body}
          </div>
        );
      }
      return isBackgroundMessage ? (
        <div
          key={key}
          className="rounded-md border border-dashed border-[#30363d] bg-[#11161d]/80 px-2 py-1 opacity-80"
        >
          {inner}
        </div>
      ) : (
        <ChatMessageComponent
          key={key}
          message={message}
          isLastUserMessage={isLastUserMessage}
          onEdit={handleEditUserMessage}
          onSendAgain={canSend ? handleSendAgain : undefined}
        />
      );
    } else if (isImageMessage(message)) {
      return isBackgroundMessage ? (
        <div
          key={key}
          className="rounded-md border border-dashed border-[#30363d] bg-[#11161d]/80 px-2 py-1 opacity-80"
        >
          <ImageMessageComponent message={message} />
        </div>
      ) : (
        <ImageMessageComponent key={key} message={message} />
      );
    }
    return null;
  };

  return (
    <div className="relative flex-1 min-h-0 min-w-0 flex flex-col overflow-x-hidden">
      {isBlockedOnHuman && (
        <BlockedOnHumanBanner blockedOnHuman={blockedOnHuman} />
      )}
      <div
        ref={messagesContainerRef}
        onPointerDown={handlePointerDown}
        onTouchMove={handleTouchMove}
        onWheel={handleWheel}
        onScroll={handleScroll}
        className="chat-message-scroll flex-1 min-h-0 min-w-0 overflow-y-auto overflow-x-hidden overscroll-contain bg-[#0d1117] px-3 sm:px-4 py-2"
      >
        {visibleMessages.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="min-h-full min-w-0 max-w-full flex flex-col justify-end">
            {activeStickyContent !== null && (
              <div
                key={`sticky-${activeStickyTimestamp}-${activeStickyIndex}`}
                ref={stickyCloneRef}
                data-testid="sticky-user-message"
                className="sticky top-0 z-10 py-1 pointer-events-none"
                style={{
                  transform: `translateY(${stickyState.pushOffset}px)`,
                  willChange: "transform",
                }}
              >
                <div className="flex justify-end">
                  <button
                    type="button"
                    onClick={scrollToActiveSticky}
                    title="Scroll to this message"
                    className="bg-[#1f6feb] text-white rounded-xl px-4 py-1.5 max-w-[85%] sm:max-w-[70%] text-left pointer-events-auto cursor-pointer shadow-md hover:brightness-110 transition-[filter]"
                  >
                    <pre className="m-0 whitespace-pre-wrap text-sm font-mono leading-relaxed line-clamp-2 overflow-hidden">
                      {activeStickyContent}
                    </pre>
                  </button>
                </div>
              </div>
            )}
            {olderHistoryLoading && (
              <div className="py-2 text-center font-mono text-xs text-[#8b949e]">
                Loading older history…
              </div>
            )}
            {renderedMessages.flatMap((entry, entryIdx) => {
              const body =
                entry.type === "subagent_group" ? (
                  <SubagentLaneGroupComponent
                    key={entry.key}
                    messages={entry.messages}
                  />
                ) : entry.type === "tool_group" ? (
                  <ToolGroupComponent
                    key={entry.key}
                    items={entry.items}
                    renderChild={renderMessage}
                    projectPath={projectPath}
                    stats={entry.stats}
                  />
                ) : entry.type === "wakeup_countdown" ? (
                  <WakeupCountdown key={entry.key} dueAt={entry.dueAt} />
                ) : (
                  renderMessage(entry.message, entry.index)
                );
              const anchors: ReactNode[] = [];
              if (entryIdx === lastRenderedIdx) {
                anchors.push(
                  <div
                    key="last-message-open-anchor"
                    ref={lastMessageOpenTargetRef}
                    aria-hidden
                    data-testid="last-message-open-anchor"
                    className="h-0"
                  />,
                );
              }
              // Insert a zero-height anchor immediately above the first unread
              // entry. Its top rect coincides with the top of that entry, so
              // scroll math against this anchor works exactly as if we wrapped
              // the entry — without altering its layout.
              if (entryIdx === firstUnreadRenderedIdx) {
                anchors.push(
                  <div
                    key="first-unread-anchor"
                    ref={unreadTargetRef}
                    aria-hidden
                    data-testid="first-unread-anchor"
                    className="h-0"
                  />,
                );
              }
              if (entryIdx === firstAssistantAfterLastUserRenderedIdx) {
                anchors.push(
                  <div
                    key="assistant-start-anchor"
                    ref={assistantStartRef}
                    aria-hidden
                    data-testid="assistant-start-anchor"
                    className="h-0"
                  />,
                );
              }
              return [...anchors, body];
            })}
            {isLoading && <LoadingComponent />}
            <div ref={messagesEndRef} />
          </div>
        )}
      </div>
      {showScrollToBottom && visibleMessages.length > 0 && (
        <button
          type="button"
          onClick={scrollToBottom}
          aria-label="Scroll to latest"
          title="Scroll to latest"
          data-testid="scroll-to-bottom"
          className="absolute bottom-4 right-4 z-20 w-9 h-9 rounded-full bg-[#21262d] text-[#c9d1d9] border border-[#30363d] shadow-lg flex items-center justify-center hover:bg-[#30363d] hover:text-white transition-colors"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            className="w-5 h-5"
            aria-hidden="true"
          >
            <path d="M12 5v14" />
            <path d="M5 12l7 7 7-7" />
          </svg>
        </button>
      )}
    </div>
  );
}

type RenderedMessage =
  | {
      type: "message";
      message: AllMessage;
      index: number;
    }
  | {
      type: "subagent_group";
      key: string;
      messages: SubagentLaneMessage[];
      firstIndex: number;
    }
  | {
      type: "tool_group";
      key: string;
      items: Array<{ message: AllMessage; index: number }>;
      firstIndex: number;
      stats: TurnStats | null;
    }
  | {
      type: "wakeup_countdown";
      key: string;
      toolUseId: string;
      dueAt: number;
      firstIndex: number;
    };

export interface TurnStats {
  duration: string;
  cost: string;
  inputTokens: number;
  outputTokens: number;
  isError: boolean;
}

/**
 * Format elapsed time with units that match the magnitude:
 * under a minute → `12.3s`, under an hour → `5m12s`, otherwise → `2h15m`.
 */
function formatDuration(ms: number): string {
  const totalSec = ms / 1000;
  if (totalSec < 60) return `${totalSec.toFixed(1)}s`;
  const totalMin = Math.floor(totalSec / 60);
  if (totalMin < 60) {
    const remSec = Math.round(totalSec - totalMin * 60);
    return `${totalMin}m${remSec}s`;
  }
  const totalHr = Math.floor(totalMin / 60);
  const remMin = totalMin - totalHr * 60;
  return `${totalHr}h${remMin}m`;
}

/**
 * Compact token count with human-scale suffixes.
 */
function formatTokens(n: number): string {
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  }
  if (n >= 1_000) {
    return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  }
  return String(n);
}

function extractTurnStats(message: AllMessage): TurnStats | null {
  if (!(isSystemMessage(message) && message.type === "result")) return null;
  const raw = message as Record<string, unknown>;
  const durationMs = raw.duration_ms;
  const totalCost = raw.total_cost_usd;
  const usage = raw.usage as
    | { input_tokens?: unknown; output_tokens?: unknown }
    | undefined;
  if (
    typeof durationMs !== "number" ||
    typeof totalCost !== "number" ||
    !usage ||
    typeof usage.input_tokens !== "number" ||
    typeof usage.output_tokens !== "number"
  ) {
    return null;
  }
  const subtype = typeof raw.subtype === "string" ? raw.subtype : "";
  return {
    duration: formatDuration(durationMs),
    cost: totalCost.toFixed(2),
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    isError: raw.is_error === true || subtype.startsWith("error"),
  };
}

export interface BuildRenderedMessagesResult {
  rendered: RenderedMessage[];
  /**
   * Indices of `result` system messages whose per-turn stats have been
   * promoted up into the tool-group header. Those messages should suppress
   * their own stats row to avoid duplication.
   */
  resultIndicesWithMovedStats: Set<number>;
}

function getSystemSubtype(message: AllMessage): string {
  if (!isSystemMessage(message) || message.type !== "system") return "";
  const subtype = (message as Record<string, unknown>).subtype;
  return typeof subtype === "string" ? subtype : "";
}

function getTaskStartedId(message: AllMessage): string | null {
  if (getSystemSubtype(message) !== "task_started") return null;
  const taskId = (message as Record<string, unknown>).task_id;
  return typeof taskId === "string" && taskId ? taskId : null;
}

function getTaskUpdatedId(message: AllMessage): string | null {
  if (getSystemSubtype(message) !== "task_updated") return null;
  const taskId = (message as Record<string, unknown>).task_id;
  return typeof taskId === "string" && taskId ? taskId : null;
}

function getTaskToolUseId(message: AllMessage): string | null {
  if (getSystemSubtype(message) !== "task_started") return null;
  const toolUseId = (message as Record<string, unknown>).tool_use_id;
  return typeof toolUseId === "string" && toolUseId ? toolUseId : null;
}

function isTaskLifecycleSystemMessage(message: AllMessage): boolean {
  const subtype = getSystemSubtype(message);
  return subtype === "task_started" || subtype === "task_updated";
}

function isWakeupTriggerSystemMessage(message: AllMessage): boolean {
  return getSystemSubtype(message) === "wakeup_trigger";
}

function buildBashCommandsByToolUseId(
  messages: AllMessage[],
): Map<string, string> {
  const commands = new Map<string, string>();
  messages.forEach((message) => {
    if (
      !isToolMessage(message) ||
      message.toolName !== "Bash" ||
      !message.toolUseId
    ) {
      return;
    }
    const command = message.toolInput?.command;
    if (typeof command === "string" && command.trim()) {
      commands.set(message.toolUseId, command.trim());
    }
  });
  return commands;
}

function readTaskUpdate(message: AllMessage): TaskLifecycleUpdate {
  const raw = message as Record<string, unknown>;
  const patch =
    raw.patch && typeof raw.patch === "object"
      ? (raw.patch as Record<string, unknown>)
      : null;
  return {
    status: typeof patch?.status === "string" ? patch.status : undefined,
    endTime: typeof patch?.end_time === "number" ? patch.end_time : undefined,
    timestamp: typeof raw.timestamp === "number" ? raw.timestamp : undefined,
  };
}

function buildTaskLifecycleState(messages: AllMessage[]): {
  updatesByTaskId: Map<string, TaskLifecycleUpdate>;
  hiddenUpdateIndices: Set<number>;
} {
  const startedTaskIds = new Set<string>();
  const updatesByTaskId = new Map<string, TaskLifecycleUpdate>();
  const hiddenUpdateIndices = new Set<number>();

  messages.forEach((message) => {
    const taskId = getTaskStartedId(message);
    if (taskId) startedTaskIds.add(taskId);
  });

  messages.forEach((message, index) => {
    const taskId = getTaskUpdatedId(message);
    if (!taskId) return;
    updatesByTaskId.set(taskId, readTaskUpdate(message));
    if (startedTaskIds.has(taskId)) {
      hiddenUpdateIndices.add(index);
    }
  });

  return { updatesByTaskId, hiddenUpdateIndices };
}

function parseDurationMs(value: string): number | null {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return null;
  const numeric = Number(trimmed);
  if (Number.isFinite(numeric) && numeric > 0) return numeric * 1000;

  const match = trimmed.match(
    /(\d+(?:\.\d+)?)\s*(milliseconds?|msecs?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)\b/,
  );
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const unit = match[2];
  if (
    unit.startsWith("ms") ||
    unit.startsWith("millisecond") ||
    unit.startsWith("msec")
  ) {
    return amount;
  }
  if (unit === "s" || unit.startsWith("sec")) return amount * 1000;
  if (unit === "m" || unit.startsWith("min")) return amount * 60_000;
  if (unit === "h" || unit.startsWith("hour") || unit.startsWith("hr")) {
    return amount * 3_600_000;
  }
  return null;
}

function parseAbsoluteTimeMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value < 10_000_000_000 ? value * 1000 : value;
  }
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function getScheduleWakeupResultDueAt(message: AllMessage): number | null {
  if (
    !isToolResultMessage(message) ||
    (message.toolName !== "ScheduleWakeup" &&
      message.toolName !== "mcp__swarmfleet__schedule_wakeup" &&
      message.toolName !== "mcp__swarmfleet__schedule_wakeup")
  ) {
    return null;
  }
  const result = message.toolUseResult;
  if (result && typeof result === "object") {
    const dueAt = parseAbsoluteTimeMs(
      (result as Record<string, unknown>).scheduledFor ??
        (result as Record<string, unknown>).scheduled_for,
    );
    if (dueAt !== null) return dueAt;
  }
  if (typeof message.content === "string") {
    try {
      const parsed = JSON.parse(message.content) as Record<string, unknown>;
      return parseAbsoluteTimeMs(parsed.scheduledFor ?? parsed.scheduled_for);
    } catch {
      return null;
    }
  }
  return null;
}

function getWakeupDueAt(
  message: AllMessage,
  messages?: AllMessage[],
  index?: number,
): number | null {
  if (
    !isToolMessage(message) ||
    (message.toolName !== "ScheduleWakeup" &&
      message.toolName !== "mcp__swarmfleet__schedule_wakeup" &&
      message.toolName !== "mcp__swarmfleet__schedule_wakeup")
  ) {
    return null;
  }
  if (messages && typeof index === "number" && message.toolUseId) {
    for (let i = index + 1; i < messages.length; i += 1) {
      const candidate = messages[i];
      if (
        isToolResultMessage(candidate) &&
        candidate.toolUseId === message.toolUseId
      ) {
        const dueAt = getScheduleWakeupResultDueAt(candidate);
        if (dueAt !== null) return dueAt;
        break;
      }
    }
  }
  const input = message.toolInput ?? {};
  const absoluteKeys = [
    "wake_at",
    "wakeAt",
    "wakeup_at",
    "wakeupAt",
    "scheduled_at",
    "scheduledAt",
    "time",
    "timestamp",
  ];
  for (const key of absoluteKeys) {
    const dueAt = parseAbsoluteTimeMs(input[key]);
    if (dueAt !== null) return dueAt;
  }

  const relativeKeys = [
    "delay_ms",
    "delayMs",
    "duration_ms",
    "durationMs",
    "milliseconds",
  ];
  for (const key of relativeKeys) {
    const value = input[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return message.timestamp + value;
    }
  }

  const secondsKeys = [
    "delay_seconds",
    "delaySeconds",
    "duration_seconds",
    "durationSeconds",
    "seconds",
    "wait_seconds",
    "waitSeconds",
  ];
  for (const key of secondsKeys) {
    const value = input[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return message.timestamp + value * 1000;
    }
  }

  const stringKeys = ["delay", "duration", "in", "after", "when"];
  for (const key of stringKeys) {
    const value = input[key];
    if (typeof value !== "string") continue;
    const absolute = parseAbsoluteTimeMs(value);
    if (absolute !== null && absolute > message.timestamp) return absolute;
    const duration = parseDurationMs(value);
    if (duration !== null) return message.timestamp + duration;
  }

  return null;
}

function isContinuationAfterWakeup(message: AllMessage): boolean {
  if (isChatMessage(message)) return true;
  if (
    isToolMessage(message) ||
    isToolResultMessage(message) ||
    isThinkingMessage(message) ||
    isTodoMessage(message) ||
    isImageMessage(message)
  ) {
    return true;
  }
  if (!isSystemMessage(message)) return false;
  if (message.type === "result") return false;
  const subtype = getSystemSubtype(message);
  return (
    subtype === "init" ||
    subtype === "abort" ||
    subtype === "runner_interrupted"
  );
}

function isWakeupCountdownRelevant(
  messages: AllMessage[],
  index: number,
): boolean {
  const message = messages[index];
  const dueAt = getWakeupDueAt(message, messages, index);
  if (dueAt === null || dueAt <= Date.now()) return false;

  const closeIndex = messages.findIndex(
    (candidate, candidateIndex) =>
      candidateIndex > index &&
      isSystemMessage(candidate) &&
      candidate.type === "result",
  );
  if (closeIndex < 0) return true;

  for (let i = closeIndex + 1; i < messages.length; i += 1) {
    if (isContinuationAfterWakeup(messages[i])) return false;
  }
  return true;
}

function buildRenderedMessages(
  messages: AllMessage[],
  hiddenIndices: Set<number> = new Set(),
): BuildRenderedMessagesResult {
  // Pre-scan: EVERYTHING that happens inside a completed turn — tool calls,
  // tool results, assistant prose, thinking notes, todo diffs, hook/system
  // messages, compact events — gets folded into a single collapsible row in
  // chronological order. A turn closes on a `result` system message. User
  // messages open a new turn and reset any still-pending accumulation (that
  // belongs to an unclosed streaming turn and keeps rendering inline).
  //
  // Subagent lane messages have their own grouping scheme and are excluded
  // from the turn fold — they get their own `subagent_group` entries.
  const groupIdOf = new Map<number, number>();
  const groupStats = new Map<number, TurnStats>();
  const resultIndicesWithMovedStats = new Set<number>();
  let nextGroupId = 0;
  let pendingIdxs: number[] = [];

  const closePendingGroup = (stats: TurnStats | null = null): boolean => {
    if (pendingIdxs.length === 0) return false;
    const gid = nextGroupId++;
    for (const idx of pendingIdxs) groupIdOf.set(idx, gid);
    if (stats) {
      groupStats.set(gid, stats);
    }
    pendingIdxs = [];
    return true;
  };

  messages.forEach((message, index) => {
    if (hiddenIndices.has(index)) return;
    if (isChatMessage(message) && message.role === "user") {
      pendingIdxs = [];
      return;
    }
    if (isSystemMessage(message) && message.type === "result") {
      const stats = extractTurnStats(message);
      const closedGroup = closePendingGroup(stats);
      if (stats && closedGroup) {
        resultIndicesWithMovedStats.add(index);
      }
      return;
    }
    if (isSubagentLaneMessage(message)) {
      // Subagent messages are grouped separately. Close the current folded
      // turn segment here so later tool/prose events are not appended into an
      // earlier group and rendered before the subagent lane.
      closePendingGroup();
      return;
    }
    if (isImageMessage(message)) {
      // Posted images are the user-visible payload of the turn. Keep them
      // inline instead of hiding them inside the collapsed tool summary.
      closePendingGroup();
      return;
    }
    if (isTaskLifecycleSystemMessage(message)) {
      // Background tasks have their own controls and should stay outside the
      // folded tool-call summary even when they occur within a completed turn.
      closePendingGroup();
      return;
    }
    if (isWakeupTriggerSystemMessage(message)) {
      // Wake triggers are backend-owned tool-like events. Keep them visible
      // outside folded agent tool groups so the resume cause is explicit.
      closePendingGroup();
      return;
    }
    pendingIdxs.push(index);
  });
  // Any indices left in `pendingIdxs` belong to an open (streaming) turn —
  // they render inline as usual.

  const rendered: RenderedMessage[] = [];
  let pendingSubagentMessages: SubagentLaneMessage[] = [];
  let pendingStartIndex = 0;
  const emittedWakeupCountdownToolUseIds = new Set<string>();
  const toolGroupAccum = new Map<
    number,
    { items: Array<{ message: AllMessage; index: number }>; firstIndex: number }
  >();

  const flushPendingSubagentMessages = () => {
    if (pendingSubagentMessages.length === 0) return;
    const firstMessage = pendingSubagentMessages[0];
    const lastMessage =
      pendingSubagentMessages[pendingSubagentMessages.length - 1];
    rendered.push({
      type: "subagent_group",
      key: `subagent-group-${pendingStartIndex}-${pendingSubagentMessages.length}-${firstMessage.toolUseId}-${lastMessage.toolUseId}`,
      messages: pendingSubagentMessages,
      firstIndex: pendingStartIndex,
    });
    pendingSubagentMessages = [];
  };

  messages.forEach((message, index) => {
    if (hiddenIndices.has(index)) return;
    if (isSubagentLaneMessage(message)) {
      if (pendingSubagentMessages.length === 0) {
        pendingStartIndex = index;
      }
      pendingSubagentMessages.push(message);
      return;
    }

    flushPendingSubagentMessages();

    const gid = groupIdOf.get(index);
    if (gid !== undefined) {
      let acc = toolGroupAccum.get(gid);
      if (!acc) {
        acc = { items: [], firstIndex: index };
        toolGroupAccum.set(gid, acc);
        rendered.push({
          type: "tool_group",
          key: `tool-group-${gid}-${index}`,
          items: acc.items,
          firstIndex: index,
          stats: groupStats.get(gid) ?? null,
        });
      }
      acc.items.push({ message, index });
      const dueAt = getWakeupDueAt(message, messages, index);
      if (
        dueAt !== null &&
        isWakeupCountdownRelevant(messages, index) &&
        isToolMessage(message) &&
        message.toolUseId &&
        !emittedWakeupCountdownToolUseIds.has(message.toolUseId)
      ) {
        emittedWakeupCountdownToolUseIds.add(message.toolUseId);
        rendered.push({
          type: "wakeup_countdown",
          key: `wakeup-countdown-${message.toolUseId}`,
          toolUseId: message.toolUseId,
          dueAt,
          firstIndex: index,
        });
      }
      return;
    }

    rendered.push({
      type: "message",
      message,
      index,
    });
    const dueAt = getWakeupDueAt(message, messages, index);
    if (
      dueAt !== null &&
      isWakeupCountdownRelevant(messages, index) &&
      isToolMessage(message) &&
      message.toolUseId &&
      !emittedWakeupCountdownToolUseIds.has(message.toolUseId)
    ) {
      emittedWakeupCountdownToolUseIds.add(message.toolUseId);
      rendered.push({
        type: "wakeup_countdown",
        key: `wakeup-countdown-${message.toolUseId}`,
        toolUseId: message.toolUseId,
        dueAt,
        firstIndex: index,
      });
    }
  });

  flushPendingSubagentMessages();
  return { rendered, resultIndicesWithMovedStats };
}

function isBackgroundActivityMessage(message: AllMessage): boolean {
  return (
    typeof message === "object" &&
    message !== null &&
    "visible_to_user" in message &&
    message.visible_to_user === false
  );
}

function formatCountdown(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function formatLocalWakeupTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

function WakeupCountdown({ dueAt }: { dueAt: number }) {
  const [now, setNow] = useState(() => Date.now());
  const remainingMs = dueAt - now;

  useEffect(() => {
    if (remainingMs <= 0) return;
    const timer = window.setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => window.clearInterval(timer);
  }, [remainingMs]);

  if (remainingMs <= 0) return null;

  return (
    <div className="my-1.5 inline-flex max-w-full items-center gap-2 rounded-md border border-[#30363d] bg-[#0d1117] px-2.5 py-1.5 font-mono text-xs">
      <span className="h-1.5 w-1.5 rounded-full bg-[#d29922]" />
      <span className="font-semibold text-[#c9d1d9]">scheduled wakeup</span>
      <span className="text-[#8b949e]">in</span>
      <span className="tabular-nums text-[#d29922]">
        {formatCountdown(remainingMs)}
      </span>
      <span className="text-[#6e7681]">at {formatLocalWakeupTime(dueAt)}</span>
    </div>
  );
}

function ToolGroupComponent({
  items,
  renderChild,
  projectPath,
  stats,
}: {
  items: Array<{ message: AllMessage; index: number }>;
  renderChild: (message: AllMessage, index: number) => ReactNode;
  projectPath: string | null;
  stats: TurnStats | null;
}) {
  const [expanded, setExpanded] = useState(false);

  // Count by tool name — tool_result messages pair with tool calls so they
  // aren't double-counted. Everything else folded in (prose, thinking,
  // todos, etc.) is summarised in aggregate.
  const counts = new Map<string, number>();
  for (const { message: m } of items) {
    if (isToolMessage(m)) {
      const name = m.toolName || "Unknown";
      counts.set(name, (counts.get(name) || 0) + 1);
    }
  }
  const toolParts = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([name, n]) => `${n} ${name}`);
  const statsParts: string[] = [];
  if (stats) {
    statsParts.push(stats.duration);
    statsParts.push(`$${stats.cost}`);
    statsParts.push(
      `↑${formatTokens(stats.inputTokens)} ↓${formatTokens(stats.outputTokens)}`,
    );
  }
  // Final shape: `73.4s · $4.37 · ↑0.1k ↓88k (4 Read · 3 Edit · 1 Bash)`.
  // Stats lead because they describe the whole turn; the tool breakdown is
  // the detail view of *how* that turn was spent and lives in parentheses.
  const summary =
    statsParts.length > 0 && toolParts.length > 0
      ? `${statsParts.join(" · ")} (${toolParts.join(" · ")})`
      : statsParts.length > 0
        ? statsParts.join(" · ")
        : toolParts.join(" · ");

  // Pair tool calls with their results by tool_use id when available. Parallel
  // commands can arrive as call, call, result, result; matching only the next
  // row renders duplicate Bash lines with missing results.
  type ToolMsg = Extract<AllMessage, { type: "tool" }>;
  type ToolResultMsg = Extract<AllMessage, { type: "tool_result" }>;
  type Rendered =
    | {
        kind: "pair";
        tool: ToolMsg;
        result: ToolResultMsg | undefined;
        key: string;
      }
    | { kind: "prose"; content: string; key: string; timestamp?: number }
    | { kind: "other"; message: AllMessage; index: number; key: string };

  const out: Rendered[] = [];
  const consumedResultIndices = new Set<number>();

  const findPairedResult = (
    tool: ToolMsg,
    itemPosition: number,
  ): { result: ToolResultMsg; itemIndex: number } | undefined => {
    if (tool.toolUseId) {
      for (let j = itemPosition + 1; j < items.length; j += 1) {
        if (consumedResultIndices.has(j)) continue;
        const candidate = items[j].message;
        if (
          isToolResultMessage(candidate) &&
          candidate.toolUseId === tool.toolUseId
        ) {
          return { result: candidate, itemIndex: j };
        }
      }
    }

    const next = items[itemPosition + 1];
    const nextMsg = next?.message;
    if (
      nextMsg &&
      !consumedResultIndices.has(itemPosition + 1) &&
      isToolResultMessage(nextMsg) &&
      nextMsg.toolName === tool.toolName
    ) {
      return { result: nextMsg, itemIndex: itemPosition + 1 };
    }

    for (let j = itemPosition + 1; j < items.length; j += 1) {
      if (consumedResultIndices.has(j)) continue;
      const candidate = items[j].message;
      if (
        isToolResultMessage(candidate) &&
        candidate.toolName === tool.toolName &&
        (!candidate.toolUseId ||
          !tool.toolUseId ||
          candidate.toolUseId === tool.toolUseId)
      ) {
        return { result: candidate, itemIndex: j };
      }
    }

    return undefined;
  };

  for (let i = 0; i < items.length; i++) {
    const { message, index } = items[i];
    if (consumedResultIndices.has(i)) {
      continue;
    }
    if (isToolMessage(message)) {
      const paired = findPairedResult(message, i);
      out.push({
        kind: "pair",
        tool: message,
        result: paired?.result,
        key: `${message.timestamp}-${index}`,
      });
      if (paired) {
        consumedResultIndices.add(paired.itemIndex);
      }
      continue;
    }
    if (isToolResultMessage(message)) {
      // Orphan tool result (no preceding tool_use captured) — render via
      // the generic dispatcher so it still appears.
      out.push({
        kind: "other",
        message,
        index,
        key: `${message.timestamp}-${index}`,
      });
      continue;
    }
    if (isChatMessage(message) && message.role === "assistant") {
      out.push({
        kind: "prose",
        content: message.content,
        timestamp: message.timestamp,
        key: `${message.timestamp}-${index}`,
      });
      continue;
    }
    out.push({
      kind: "other",
      message,
      index,
      key: `${message.timestamp}-${index}`,
    });
  }

  return (
    <div data-testid="tool-group" className="my-1.5 min-w-0 max-w-full">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex max-w-full min-w-0 items-center gap-2 overflow-hidden text-xs font-mono text-[#8b949e] transition-colors select-none hover:text-[#c9d1d9]"
      >
        <span className="text-[10px] text-[#6e7681]">
          {expanded ? "▼" : "▶"}
        </span>
        {summary.length > 0 && (
          <span
            className={
              stats?.isError
                ? "min-w-0 truncate text-[#ff7b72]"
                : "min-w-0 truncate"
            }
          >
            {summary}
          </span>
        )}
      </button>
      {expanded && (
        <div className="mt-1.5 min-w-0 max-w-full space-y-1 border-l border-[#30363d] pl-3">
          {out.map((entry) => {
            if (entry.kind === "pair") {
              return (
                <InlineToolCallRow
                  key={entry.key}
                  tool={entry.tool}
                  result={entry.result}
                  projectPath={projectPath}
                />
              );
            }
            if (entry.kind === "prose") {
              return (
                <InlineProseRow
                  key={entry.key}
                  content={entry.content}
                  timestamp={entry.timestamp}
                />
              );
            }
            return (
              <div key={entry.key} className="min-w-0 max-w-full">
                {renderChild(entry.message, entry.index)}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function SubagentLaneGroupComponent({
  messages,
}: {
  messages: SubagentLaneMessage[];
}) {
  return (
    <div
      data-testid="subagent-group"
      data-count={String(messages.length)}
      className="my-1.5 shrink-0 space-y-1"
    >
      {messages.map((message) => (
        <SubagentLaneComponent key={message.toolUseId} message={message} />
      ))}
    </div>
  );
}

// Cache key shared with provider auth flows.
const PROVIDERS_STATUS_CACHE_KEY = "swarmfleet-providers-status";

/** Force a fresh fetch (e.g. after signing in) */
export function invalidateProvidersCache() {
  try {
    window.localStorage.removeItem(PROVIDERS_STATUS_CACHE_KEY);
  } catch {
    // Ignore storage failures; future fetches still bypass the in-memory cache.
  }
  window.dispatchEvent(new Event("providers-invalidated"));
}

function EmptyState() {
  const currentProject = useAppStore((state) => state.currentProject);

  const handleManageProviders = useCallback(() => {
    window.dispatchEvent(new Event("open-provider-settings"));
  }, []);

  return (
    <div className="flex-1 flex items-center justify-center text-center text-[#8b949e]">
      <div className="max-w-sm animate-fade-in-up">
        <div className="w-12 h-12 mx-auto mb-4 rounded-xl bg-[#161b22] border border-[#30363d] flex items-center justify-center">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            className="w-6 h-6 text-[#58a6ff]"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M8.625 12a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0H8.25m4.125 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0H12m4.125 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 0 1-2.555-.337A5.972 5.972 0 0 1 5.41 20.97a5.969 5.969 0 0 1-.474-.065 4.48 4.48 0 0 0 .978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25Z"
            />
          </svg>
        </div>
        <p className="text-lg font-medium text-[#e6edf3]">
          {currentProject?.name ?? "project"}
        </p>
        <p className="text-sm mt-1 opacity-80">
          Type a message to start a new session
        </p>
        <button
          type="button"
          onClick={handleManageProviders}
          className="mt-5 rounded-md border border-[#30363d] bg-[#21262d] px-3 py-1.5 text-xs font-medium text-[#c9d1d9] transition-colors hover:bg-[#30363d] hover:text-[#e6edf3]"
          data-testid="manage-providers-button"
        >
          Manage providers
        </button>
      </div>
    </div>
  );
}
