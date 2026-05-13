import {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import { useLocation, useNavigate } from "react-router-dom";
import { Cog6ToothIcon } from "@heroicons/react/24/outline";
import { getSessionArchiveUrl, getUserPreferencesUrl } from "../config/api";
import { useChatStore } from "../stores/chatStore";
import { useAppStore } from "../stores/appStore";
import {
  getSessionStatusMap,
  subscribeSessionStatus,
  removeBackgroundSessionStatus,
  type SessionStatusEntry,
} from "../stores/sessionStatus";
import {
  getSessionsMap,
  subscribeSessions,
  fetchSessions,
  isFetchingSessions,
  removeSession,
} from "../stores/sessions";
import { getOverallConnectionState } from "../stores/connectionStateStore";
import {
  getUnreadBoundary,
  getUnreadSessions,
  markSessionRead,
  queueUnreadScrollTarget,
  subscribeUnreadSessions,
} from "../stores/unreadSessions";
import { RateLimitStatusLine } from "./RateLimitStatusLine";
import { GlobalSettingsOverlay } from "./GlobalSettingsOverlay";
import { ConnectionPill } from "./ConnectionPill";
import {
  formatProviderLabel,
  providerTextColorClass,
} from "../utils/providerColors";
import type { Project } from "../types";
import type {
  ArmedWakeupInfo,
  SessionKind,
  SessionStatus,
} from "@shared/types";

function useSessionStatusMap(): Map<string, SessionStatusEntry> {
  return useSyncExternalStore(subscribeSessionStatus, getSessionStatusMap);
}

function useUnreadSessions(): ReadonlyMap<string, number> {
  return useSyncExternalStore(subscribeUnreadSessions, getUnreadSessions);
}

const PROJECT_ORDER_KEY = "swarmfleet-project-order";
const SIDEBAR_WIDTH_KEY = "swarmfleet-sidebar-width";
const COLLAPSED_PROJECTS_KEY = "swarmfleet-collapsed-projects";
const SIDEBAR_MIN_WIDTH = 200;
const SIDEBAR_MAX_WIDTH = 480;
const SIDEBAR_DEFAULT_WIDTH = 256;

interface UserPreferencesResponse {
  projectOrder?: unknown;
  projectOrderUpdatedAt?: unknown;
}

interface SavedProjectOrder {
  order: string[];
  updatedAt: number;
}

function normalizeSavedOrder(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function normalizeSavedOrderTimestamp(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, value)
    : 0;
}

function loadSavedOrder(): SavedProjectOrder {
  try {
    const raw = localStorage.getItem(PROJECT_ORDER_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const envelope = parsed as { order?: unknown; updatedAt?: unknown };
      return {
        order: normalizeSavedOrder(envelope.order),
        updatedAt: normalizeSavedOrderTimestamp(envelope.updatedAt),
      };
    }
    return { order: normalizeSavedOrder(parsed), updatedAt: 0 };
  } catch {
    return { order: [], updatedAt: 0 };
  }
}

function saveSavedOrder(savedOrder: SavedProjectOrder) {
  localStorage.setItem(PROJECT_ORDER_KEY, JSON.stringify(savedOrder));
}

async function fetchSavedProjectOrder(): Promise<SavedProjectOrder> {
  const response = await fetch(getUserPreferencesUrl());
  if (!response.ok) throw new Error("Failed to load preferences");
  const data = (await response.json()) as UserPreferencesResponse;
  return {
    order: normalizeSavedOrder(data.projectOrder),
    updatedAt: normalizeSavedOrderTimestamp(data.projectOrderUpdatedAt),
  };
}

function persistSavedProjectOrder(order: string[]): void {
  const updatedAt = Date.now();
  saveSavedOrder({ order, updatedAt });
  void fetch(getUserPreferencesUrl(), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      projectOrder: order,
      projectOrderUpdatedAt: updatedAt,
    }),
  }).catch(() => {
    // Keep the local cache; the next successful write will sync the latest order.
  });
}

/** Apply saved order to projects, appending any new ones at the end */
function applyOrder(projects: Project[], savedOrder: string[]): Project[] {
  if (savedOrder.length === 0) return projects;
  const byPath = new Map(projects.map((p) => [p.path, p]));
  const ordered: Project[] = [];
  for (const path of savedOrder) {
    const p = byPath.get(path);
    if (p) {
      ordered.push(p);
      byPath.delete(path);
    }
  }
  // Append any projects not in saved order
  for (const p of byPath.values()) {
    ordered.push(p);
  }
  return ordered;
}

/** Session status indicator based on per-session live state */
function getSessionIndicator(
  sessionId: string,
  statusMap: Map<string, SessionStatusEntry>,
  summaryStatus?: SessionStatus,
  activePhase?:
    | "streaming"
    | "awaiting-permission"
    | "error"
    | "ready"
    | "idle"
    | "loading-history",
  armedWakeup?: ArmedWakeupInfo | null,
  activeLoop?: { state: string; name: string; iterationCount: number } | null,
): { indicator: React.ReactNode; label?: string; labelClass?: string } {
  if (activePhase === "streaming") {
    return {
      indicator: (
        <span className="w-2 h-2 inline-block">
          <span className="block w-2 h-2 rounded-full border border-[#58a6ff] border-t-transparent animate-spin" />
        </span>
      ),
    };
  }
  if (activePhase === "awaiting-permission") {
    return {
      indicator: (
        <span className="w-2 h-2 rounded-full bg-[#3fb950] inline-block" />
      ),
      label: "Waiting",
      labelClass: "text-[#3fb950]",
    };
  }

  // The session-index stream is the fastest source for live transitions.
  // Let it overlay a persisted row summary so background sessions show as
  // running before the row is refetched; full backend snapshots clear this
  // cache again when the session reaches a terminal/rest state.
  const liveStatus = statusMap.get(sessionId);
  // Blocked-on-human takes precedence over generic interrupted/waiting
  // because it's the only state that demands operator action.
  if (liveStatus?.isBlockedOnHuman) {
    return {
      indicator: (
        <span
          className="w-2 h-2 rounded-full bg-[#d29922] inline-block animate-pulse"
          title="Session requested human review"
        />
      ),
      label: "Paused",
      labelClass: "text-[#d29922]",
    };
  }
  if (liveStatus?.isInterrupted) {
    return {
      indicator: (
        <span className="w-2 h-2 rounded-full bg-[#da3633] inline-block" />
      ),
      label: "Aborted",
      labelClass: "text-[#ff7b72]",
    };
  }
  if (liveStatus?.isWaitingForHuman) {
    return {
      indicator: (
        <span className="w-2 h-2 rounded-full bg-[#3fb950] inline-block" />
      ),
      label: "Waiting",
      labelClass: "text-[#3fb950]",
    };
  }
  if (liveStatus?.isStreaming) {
    return {
      indicator: (
        <span className="w-2 h-2 inline-block">
          <span className="block w-2 h-2 rounded-full border border-[#58a6ff] border-t-transparent animate-spin" />
        </span>
      ),
    };
  }

  if (summaryStatus === "blocked_on_human") {
    return {
      indicator: (
        <span
          className="w-2 h-2 rounded-full bg-[#d29922] inline-block animate-pulse"
          title="Session requested human review"
        />
      ),
      label: "Paused",
      labelClass: "text-[#d29922]",
    };
  }
  if (summaryStatus === "interrupted") {
    return {
      indicator: (
        <span className="w-2 h-2 rounded-full bg-[#da3633] inline-block" />
      ),
      label: "Aborted",
      labelClass: "text-[#ff7b72]",
    };
  }
  if (summaryStatus === "awaiting_input") {
    return {
      indicator: (
        <span className="w-2 h-2 rounded-full bg-[#3fb950] inline-block" />
      ),
      label: "Waiting",
      labelClass: "text-[#3fb950]",
    };
  }
  if (summaryStatus === "running" || summaryStatus === "backend_wakeup") {
    return {
      indicator: (
        <span className="w-2 h-2 inline-block">
          <span className="block w-2 h-2 rounded-full border border-[#58a6ff] border-t-transparent animate-spin" />
        </span>
      ),
    };
  }

  if (summaryStatus === "error") {
    return {
      indicator: (
        <span className="w-2 h-2 rounded-full bg-[#da3633] inline-block" />
      ),
      label: "Error",
      labelClass: "text-[#ff7b72]",
    };
  }
  if (
    activeLoop &&
    (activeLoop.state === "running" || activeLoop.state === "paused")
  ) {
    const isLoopRunning = activeLoop.state === "running";
    return {
      indicator: (
        <span
          className={`w-2 h-2 rounded-full inline-block ${isLoopRunning ? "bg-[#a371f7] animate-pulse" : "bg-[#a371f7]/50"}`}
          title={`Loop: ${activeLoop.name}`}
        />
      ),
      label: isLoopRunning ? `Loop #${activeLoop.iterationCount}` : "Loop ⏸",
      labelClass: "text-[#a371f7]",
    };
  }
  if (armedWakeup) {
    return {
      indicator: (
        <span
          className="w-2 h-2 rounded-full bg-[#d29922] inline-block"
          title="Auto wake armed"
        />
      ),
      label: "Armed",
      labelClass: "text-[#d29922]",
    };
  }
  // No active status — no dot
  return {
    indicator: <span className="w-2 h-2 inline-block" />,
  };
}

/**
 * Compute the badge-color class for a feature on a given project, using live
 * status data where available. Only relevant when the feature is enabled.
 */
function featureBadgeClasses(): string {
  return "bg-[#21262d] text-[#8b949e]";
}

const FEATURE_LABELS: Record<"preview", string> = {
  preview: "preview",
};

function sessionKindBadge(
  kind: SessionKind,
): { label: string; title: string } | null {
  if (kind === "chat") return null;
  if (kind === "subagent") {
    return { label: "subagent", title: "Subagent session" };
  }
  return { label: kind, title: `${kind} session` };
}

interface SidebarProps {
  isOpen: boolean;
  onClose: () => void;
  activeSessionId?: string | null;
  onSelectSession: (project: Project, sessionId: string) => void;
  onNewSessionForProject?: (project: Project) => void;
  projects: Project[];
  currentProject: Project | null;
  panelRef?: React.RefObject<HTMLDivElement | null>;
  scrimRef?: React.RefObject<HTMLDivElement | null>;
}

export function Sidebar({
  isOpen,
  onClose,
  activeSessionId,
  onSelectSession,
  onNewSessionForProject,
  projects,
  currentProject,
  panelRef,
  scrimRef,
}: SidebarProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  const createProjectAction = useAppStore((state) => state.createProject);
  const selectProject = useAppStore((state) => state.setCurrentProject);
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [showGlobalSettings, setShowGlobalSettings] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const newProjectNameRef = useRef(newProjectName);
  newProjectNameRef.current = newProjectName;
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const creatingRef = useRef(creating);
  creatingRef.current = creating;
  const activeChatPhase = useChatStore((state) => state.phase);
  const sessionStatusMap = useSessionStatusMap();
  const sessionsMap = useSyncExternalStore(subscribeSessions, getSessionsMap);
  const unreadSet = useUnreadSessions();
  const [dismissedArmedWakeups, setDismissedArmedWakeups] = useState<
    Map<string, string>
  >(() => new Map());
  const previousActiveSessionIdRef = useRef<string | null | undefined>(null);
  const [orderedProjects, setOrderedProjects] = useState<Project[]>([]);
  const [savedProjectOrder, setSavedProjectOrder] = useState<string[]>(
    () => loadSavedOrder().order,
  );
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(
    () => {
      try {
        const raw = localStorage.getItem(COLLAPSED_PROJECTS_KEY);
        return raw ? new Set(JSON.parse(raw)) : new Set();
      } catch {
        return new Set();
      }
    },
  );

  // Drag state
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const dragNodeRef = useRef<HTMLDivElement | null>(null);

  const localPanelRef = useRef<HTMLDivElement>(null);
  const resolvedPanelRef = panelRef ?? localPanelRef;

  // Desktop resize state
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    try {
      const saved = localStorage.getItem(SIDEBAR_WIDTH_KEY);
      if (saved) {
        const w = Number(saved);
        if (w >= SIDEBAR_MIN_WIDTH && w <= SIDEBAR_MAX_WIDTH) return w;
      }
    } catch {
      /* ignore */
    }
    return SIDEBAR_DEFAULT_WIDTH;
  });
  const resizing = useRef(false);

  useEffect(() => {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth));
  }, [sidebarWidth]);

  useEffect(() => {
    const handleOpenProviderSettings = () => setShowGlobalSettings(true);
    window.addEventListener(
      "open-provider-settings",
      handleOpenProviderSettings,
    );
    return () => {
      window.removeEventListener(
        "open-provider-settings",
        handleOpenProviderSettings,
      );
    };
  }, []);

  const handleResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      resizing.current = true;
      const startX = e.clientX;
      const startWidth = sidebarWidth;

      const onMouseMove = (ev: MouseEvent) => {
        const newWidth = Math.min(
          SIDEBAR_MAX_WIDTH,
          Math.max(SIDEBAR_MIN_WIDTH, startWidth + (ev.clientX - startX)),
        );
        setSidebarWidth(newWidth);
      };
      const onMouseUp = () => {
        resizing.current = false;
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    },
    [sidebarWidth],
  );

  useEffect(() => {
    let cancelled = false;
    const localOrder = loadSavedOrder();
    fetchSavedProjectOrder()
      .then((serverOrder) => {
        if (cancelled) return;
        const nextOrder =
          serverOrder.order.length > 0 &&
          serverOrder.updatedAt >= localOrder.updatedAt
            ? serverOrder
            : localOrder;
        setSavedProjectOrder(nextOrder.order);
        if (
          nextOrder.order.length > 0 &&
          (serverOrder.order.length === 0 ||
            nextOrder.updatedAt > serverOrder.updatedAt)
        ) {
          persistSavedProjectOrder(nextOrder.order);
        }
      })
      .catch(() => {
        if (!cancelled) setSavedProjectOrder(localOrder.order);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Apply saved order whenever projects or persisted preferences change.
  useEffect(() => {
    setOrderedProjects(applyOrder(projects, savedProjectOrder));
  }, [projects, savedProjectOrder]);

  // Derive expanded set: everything not in collapsed. Memoize it so effects
  // don't re-run on every render just because a fresh Set instance was created.
  const expandedProjects = useMemo(
    () =>
      new Set(
        orderedProjects
          .map((p) => p.path)
          .filter((path) => !collapsedProjects.has(path)),
      ),
    [orderedProjects, collapsedProjects],
  );
  const currentTab = location.pathname.split("/").filter(Boolean)[0] ?? "chat";

  // Persist collapsed state
  useEffect(() => {
    localStorage.setItem(
      COLLAPSED_PROJECTS_KEY,
      JSON.stringify([...collapsedProjects]),
    );
  }, [collapsedProjects]);

  // Fetch the active project's sessions immediately, but don't let the sidebar
  // fan out slow /api/sessions?project=... requests for every expanded project
  // during chat history load. Background-fill the rest after the session has had
  // a chance to paint.
  useEffect(() => {
    const timers: number[] = [];

    const fetchProject = (path: string) => {
      const project = projects.find((p) => p.path === path);
      if (!project?.encodedName) return;
      void fetchSessions(path, project.encodedName);
    };

    if (currentProject?.path && expandedProjects.has(currentProject.path)) {
      fetchProject(currentProject.path);
    }

    const backgroundPaths = [...expandedProjects].filter(
      (path) => path !== currentProject?.path,
    );
    backgroundPaths.forEach((path, index) => {
      timers.push(
        window.setTimeout(() => fetchProject(path), 1500 + index * 300),
      );
    });

    return () => {
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, [expandedProjects, projects, currentProject?.path]);

  // Archive state: sessionId -> timestamp of first click (for confirm window)
  const [archiveConfirm, setArchiveConfirm] = useState<Record<string, number>>(
    {},
  );

  const archiveSessionOptimistically = useCallback(
    (sessionId: string, project: Project) => {
      const state = useAppStore.getState();
      const projectSessions = state.sessionIndex.get(project.path) ?? [];
      const removedIndex = projectSessions.findIndex(
        (session) => session.sessionId === sessionId,
      );
      const removedSession =
        removedIndex === -1 ? null : projectSessions[removedIndex];

      // Make the sidebar feel instant. The backend may still spend time
      // aborting runners/subprocesses, but that should not block the UI.
      removeSession(sessionId);
      if (activeSessionId === sessionId) {
        onNewSessionForProject?.(project);
      }

      const restoreRemovedSession = () => {
        if (!removedSession) return;
        const latestState = useAppStore.getState();
        const latestProjectSessions =
          latestState.sessionIndex.get(project.path) ?? [];
        if (
          latestProjectSessions.some(
            (session) => session.sessionId === sessionId,
          )
        ) {
          return;
        }
        const restored = [...latestProjectSessions];
        restored.splice(
          Math.min(removedIndex, restored.length),
          0,
          removedSession,
        );
        latestState.updateSessionIndex(project.path, restored);
      };

      fetch(getSessionArchiveUrl(sessionId), { method: "POST" })
        .then((res) => {
          if (!res.ok) {
            restoreRemovedSession();
          }
        })
        .catch(restoreRemovedSession);
    },
    [activeSessionId, onNewSessionForProject],
  );

  const handleArchiveClick = useCallback(
    (sessionId: string, _encodedName: string, project: Project) => {
      const now = Date.now();
      const firstClick = archiveConfirm[sessionId];

      if (firstClick && now - firstClick < 3000) {
        // Second click within 3s — archive it
        setArchiveConfirm((prev) => {
          const next = { ...prev };
          delete next[sessionId];
          return next;
        });
        archiveSessionOptimistically(sessionId, project);
      } else {
        // First click — set confirm state, auto-revert after 3s
        setArchiveConfirm((prev) => ({ ...prev, [sessionId]: now }));
        setTimeout(() => {
          setArchiveConfirm((prev) => {
            if (prev[sessionId] === now) {
              const next = { ...prev };
              delete next[sessionId];
              return next;
            }
            return prev;
          });
        }, 3000);
      }
    },
    [archiveConfirm, archiveSessionOptimistically],
  );

  // Context menu (long-press)
  const [contextMenu, setContextMenu] = useState<{
    sessionId: string;
    project: Project;
    title: string;
    kind: SessionKind;
  } | null>(null);

  const longPressRef = useRef<{
    timerId: ReturnType<typeof setTimeout> | null;
    activated: boolean;
    startX: number;
    startY: number;
  }>({ timerId: null, activated: false, startX: 0, startY: 0 });

  const startLongPress = useCallback(
    (
      e: React.PointerEvent,
      sessionId: string,
      project: Project,
      title: string,
      kind: SessionKind,
    ) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      if (longPressRef.current.timerId !== null) {
        clearTimeout(longPressRef.current.timerId);
      }
      longPressRef.current.activated = false;
      longPressRef.current.startX = e.clientX;
      longPressRef.current.startY = e.clientY;
      longPressRef.current.timerId = setTimeout(() => {
        longPressRef.current.timerId = null;
        longPressRef.current.activated = true;
        setContextMenu({ sessionId, project, title, kind });
        if (navigator.vibrate) navigator.vibrate(50);
      }, 500);
    },
    [],
  );

  const cancelLongPress = useCallback(() => {
    if (longPressRef.current.timerId !== null) {
      clearTimeout(longPressRef.current.timerId);
      longPressRef.current.timerId = null;
    }
  }, []);

  const moveLongPress = useCallback((e: React.PointerEvent) => {
    if (longPressRef.current.timerId === null) return;
    const dx = e.clientX - longPressRef.current.startX;
    const dy = e.clientY - longPressRef.current.startY;
    if (Math.sqrt(dx * dx + dy * dy) > 10) {
      clearTimeout(longPressRef.current.timerId);
      longPressRef.current.timerId = null;
    }
  }, []);

  const handleArchiveFromMenu = useCallback(() => {
    if (!contextMenu) return;
    const { sessionId, project } = contextMenu;
    setContextMenu(null);
    archiveSessionOptimistically(sessionId, project);
  }, [contextMenu, archiveSessionOptimistically]);

  const handleCreateProject = useCallback(async () => {
    const name = newProjectNameRef.current.trim();
    if (!name || creatingRef.current) return;
    if (getOverallConnectionState() === "offline") {
      setCreateError(
        "Offline: reconnect to the backend before creating a project.",
      );
      return;
    }
    setCreating(true);
    setCreateError(null);
    try {
      const newProject = await createProjectAction(name);
      setShowCreateDialog(false);
      navigateRef.current(`/chat/${encodeURIComponent(newProject.name)}`);
      setTimeout(
        () => window.dispatchEvent(new CustomEvent("new-chat-session")),
        0,
      );
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Network error");
    } finally {
      setCreating(false);
    }
  }, [createProjectAction]);

  const toggleProject = (path: string) => {
    setCollapsedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  const handleNewSession = (project: Project) => {
    onNewSessionForProject?.(project);
    if (window.innerWidth < 768) {
      onClose();
    }
  };

  const handleFeatureBadgeClick = (
    event: React.MouseEvent,
    project: Project,
    feature: "preview",
  ) => {
    event.preventDefault();
    event.stopPropagation();
    selectProject(project);
    navigate(`/${feature}/${encodeURIComponent(project.name)}`);
    if (window.innerWidth < 768) {
      onClose();
    }
  };

  const dismissArmedWakeup = useCallback(
    (sessionId: string, wakeupId: string | undefined) => {
      if (!wakeupId) return;
      setDismissedArmedWakeups((current) => {
        if (current.get(sessionId) === wakeupId) return current;
        const next = new Map(current);
        next.set(sessionId, wakeupId);
        return next;
      });
    },
    [],
  );

  const handleSelectSession = (
    project: Project,
    sessionId: string,
    armedWakeupId?: string,
  ) => {
    dismissArmedWakeup(sessionId, armedWakeupId);
    if (activeSessionId === sessionId) {
      if (currentTab !== "chat") {
        const searchParams = new URLSearchParams();
        searchParams.set("sessionId", sessionId);
        navigate({
          pathname: `/chat/${encodeURIComponent(project.name)}`,
          search: searchParams.toString(),
        });
      }
      if (window.innerWidth < 768) {
        onClose();
      }
      return;
    }

    // Opening a session is "reading" it — drop any unread flag set while the
    // message was completing in the background. Before clearing, hand the
    // boundary off to ChatMessages so it can scroll to the first unread.
    const boundary = getUnreadBoundary(sessionId);
    if (boundary !== undefined) {
      queueUnreadScrollTarget(sessionId, boundary);
    }
    markSessionRead(sessionId, { force: true });
    // Clear the interrupted indicator when the user explicitly opens the session.
    removeBackgroundSessionStatus(sessionId);
    onSelectSession(project, sessionId);
    if (window.innerWidth < 768) {
      onClose();
    }
  };

  // Also clear unread when the URL-driven activeSessionId lands on a session
  // we had flagged (e.g. direct navigation, or phone-to-laptop handoff where
  // the user clicked elsewhere).
  useEffect(() => {
    if (activeSessionId) {
      const boundary = getUnreadBoundary(activeSessionId);
      if (boundary !== undefined) {
        queueUnreadScrollTarget(activeSessionId, boundary);
      }
      markSessionRead(activeSessionId, { force: true });
    }
  }, [activeSessionId]);

  // Opening a session also acknowledges the armed-wake indicator. This is
  // local UI state only; it does not cancel the backend wake.
  useEffect(() => {
    if (previousActiveSessionIdRef.current === activeSessionId) return;
    previousActiveSessionIdRef.current = activeSessionId;
    if (!activeSessionId) return;
    for (const sessions of sessionsMap.values()) {
      const activeSession = sessions.find(
        (session) => session.sessionId === activeSessionId,
      );
      if (activeSession) {
        dismissArmedWakeup(activeSessionId, activeSession.armedWakeup?.id);
        break;
      }
    }
  }, [activeSessionId, dismissArmedWakeup, sessionsMap]);

  // --- Drag handlers ---
  const handleDragStart = useCallback(
    (e: React.DragEvent<HTMLDivElement>, index: number) => {
      setDragIndex(index);
      dragNodeRef.current = e.currentTarget;
      e.dataTransfer.effectAllowed = "move";
      // Make the drag image slightly transparent
      requestAnimationFrame(() => {
        if (dragNodeRef.current) {
          dragNodeRef.current.style.opacity = "0.4";
        }
      });
    },
    [],
  );

  const handleDragOver = useCallback(
    (e: React.DragEvent<HTMLDivElement>, index: number) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      if (dragIndex === null || index === dragIndex) return;
      setDragOverIndex(index);
    },
    [dragIndex],
  );

  const handleDragEnd = useCallback(() => {
    if (dragNodeRef.current) {
      dragNodeRef.current.style.opacity = "";
    }
    if (
      dragIndex !== null &&
      dragOverIndex !== null &&
      dragIndex !== dragOverIndex
    ) {
      setOrderedProjects((prev) => {
        const next = [...prev];
        const [moved] = next.splice(dragIndex, 1);
        next.splice(dragOverIndex, 0, moved);
        const nextOrder = next.map((p) => p.path);
        setSavedProjectOrder(nextOrder);
        persistSavedProjectOrder(nextOrder);
        return next;
      });
    }
    setDragIndex(null);
    setDragOverIndex(null);
    dragNodeRef.current = null;
  }, [dragIndex, dragOverIndex]);

  const handleDragLeave = useCallback(() => {
    setDragOverIndex(null);
  }, []);

  const formatSessionTime = (timeStr: string) => {
    try {
      const date = new Date(timeStr);
      const now = new Date();
      const diffMs = now.getTime() - date.getTime();
      const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

      if (diffDays === 0) {
        return date.toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        });
      } else if (diffDays === 1) {
        return "Yesterday";
      } else if (diffDays < 7) {
        return date.toLocaleDateString([], { weekday: "short" });
      } else {
        return date.toLocaleDateString([], { month: "short", day: "numeric" });
      }
    } catch {
      return "";
    }
  };

  return (
    <>
      {/* Scrim overlay for mobile */}
      <div
        ref={scrimRef}
        className={`fixed inset-0 bg-black/60 z-40 md:hidden transition-opacity duration-300 ${
          isOpen
            ? "opacity-100 pointer-events-auto"
            : "opacity-0 pointer-events-none"
        }`}
        onClick={onClose}
      />

      {/* Sidebar panel */}
      <aside
        ref={resolvedPanelRef}
        style={{ "--sidebar-w": `${sidebarWidth}px` } as React.CSSProperties}
        className={`
          z-50 top-0 left-0 h-full
          w-[90vw] md:w-[var(--sidebar-w)]
          bg-[#161b22] border-r border-[#30363d]
          flex flex-col
          transition-transform duration-300 ease-in-out
          md:shrink-0
          ${isOpen ? "fixed md:relative translate-x-0" : "fixed -translate-x-full"}
        `}
      >
        {/* Sidebar header */}
        <div className="h-11 flex items-center px-3 border-b border-[#30363d] shrink-0">
          <span className="text-[#c9d1d9] text-sm font-semibold tracking-wide">
            Projects
          </span>
          <div className="ml-auto flex items-center gap-1.5">
            <span className="flex items-center gap-1.5">
              <ConnectionPill />
            </span>
            {/* Mobile: close button */}
            <button
              onClick={onClose}
              className="text-[#8b949e] hover:text-[#c9d1d9] md:hidden"
              aria-label="Close sidebar"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.5}
                className="w-5 h-5"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </button>
          </div>
        </div>

        {/* Project list */}
        <div className="flex-1 overflow-y-auto">
          {orderedProjects.map((project, index) => {
            const isExpanded = expandedProjects.has(project.path);
            const isSelected = currentProject?.path === project.path;
            const sessions = sessionsMap.get(project.path);
            // Subagent sessions are hidden from the top-level list — they only
            // appear as tabs on their parent session's row.
            const visibleSessions = sessions?.filter((s) => !s.parentSessionId);
            const projectHasUnread =
              sessions?.some((session) => unreadSet.has(session.sessionId)) ??
              false;
            const isLoadingSessions = isFetchingSessions(project.path);
            const isDragOver = dragOverIndex === index && dragIndex !== index;
            const enabledFeatures = (["preview"] as const).filter(
              (key) => project.features[key]?.enabled,
            );

            return (
              <div
                key={project.path}
                data-testid="project-group"
                data-project-path={project.path}
                draggable
                onDragStart={(e) => handleDragStart(e, index)}
                onDragOver={(e) => handleDragOver(e, index)}
                onDragEnd={handleDragEnd}
                onDragLeave={handleDragLeave}
                className={
                  isDragOver
                    ? "border-t-2 border-[#58a6ff]"
                    : "border-t-2 border-transparent"
                }
              >
                {/* Project row */}
                <div
                  className={`flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-[#1c2129] transition-colors ${
                    isSelected
                      ? "bg-[#1c2129] border-l-2 border-l-[#58a6ff]"
                      : ""
                  }`}
                >
                  {/* Fold chevron */}
                  <button
                    onClick={() => toggleProject(project.path)}
                    className="text-[#8b949e] hover:text-[#c9d1d9] shrink-0"
                    aria-label={isExpanded ? "Collapse" : "Expand"}
                  >
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={2}
                      className={`w-3.5 h-3.5 transition-transform duration-200 ${
                        isExpanded ? "rotate-90" : ""
                      }`}
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M8.25 4.5l7.5 7.5-7.5 7.5"
                      />
                    </svg>
                  </button>

                  {/* Project name — toggles expand */}
                  <button
                    onClick={() => toggleProject(project.path)}
                    className={`text-sm truncate text-left flex-1 ${
                      isSelected ? "text-[#58a6ff]" : "text-[#c9d1d9]"
                    } ${projectHasUnread ? "font-semibold" : "font-normal"}`}
                  >
                    {project.name}
                  </button>

                  {/* New chat button — always available for each project. */}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleNewSession(project);
                    }}
                    data-testid="new-session"
                    data-project-path={project.path}
                    className="text-[#484f58] hover:text-[#c9d1d9] p-0.5 transition-colors shrink-0"
                    aria-label="New session"
                    title="New session"
                  >
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={1.5}
                      className="w-3.5 h-3.5"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.087.16 2.185.283 3.293.369V21l4.076-4.076a1.526 1.526 0 0 1 1.037-.443 48.3 48.3 0 0 0 5.887-.512c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.4 48.4 0 0 0 12 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018Z"
                      />
                    </svg>
                  </button>

                  {/* Feature badges — one per enabled feature. Colors
                      reflect live status for the selected project. */}
                  {enabledFeatures.map((key) => (
                    <button
                      key={key}
                      type="button"
                      data-feature={key}
                      data-testid={`project-feature-${key}`}
                      draggable={false}
                      onMouseDown={(event) => event.stopPropagation()}
                      onPointerDown={(event) => event.stopPropagation()}
                      onDragStart={(event) => event.preventDefault()}
                      onClick={(event) =>
                        handleFeatureBadgeClick(event, project, key)
                      }
                      className={`text-[9px] px-1.5 py-0.5 rounded uppercase shrink-0 ${featureBadgeClasses()} hover:brightness-110 transition-[filter]`}
                      title="Open Preview"
                    >
                      {FEATURE_LABELS[key]}
                    </button>
                  ))}

                  {/* Drag handle — right side so it doesn't compete with the
                      chevron/name for the leading column. */}
                  <span
                    aria-label="Drag to reorder"
                    title="Drag to reorder"
                    className="text-[#30363d] hover:text-[#484f58] cursor-grab active:cursor-grabbing shrink-0"
                  >
                    <svg
                      viewBox="0 0 16 16"
                      fill="currentColor"
                      className="w-3 h-3"
                    >
                      <path d="M5.5 3a1 1 0 1 1 0 2 1 1 0 0 1 0-2Zm5 0a1 1 0 1 1 0 2 1 1 0 0 1 0-2ZM5.5 7a1 1 0 1 1 0 2 1 1 0 0 1 0-2Zm5 0a1 1 0 1 1 0 2 1 1 0 0 1 0-2ZM5.5 11a1 1 0 1 1 0 2 1 1 0 0 1 0-2Zm5 0a1 1 0 1 1 0 2 1 1 0 0 1 0-2Z" />
                    </svg>
                  </span>
                </div>

                {/* Expanded section: sessions */}
                {isExpanded && (
                  <div className="ml-5 border-l border-[#30363d]">
                    {/* Loading state */}
                    {isLoadingSessions && (
                      <div className="px-3 py-2 flex items-center gap-2">
                        <div className="w-3 h-3 border border-[#30363d] border-t-[#8b949e] rounded-full animate-spin" />
                        <span className="text-[10px] text-[#484f58]">
                          Loading sessions...
                        </span>
                      </div>
                    )}

                    {/* Session list */}
                    {visibleSessions && visibleSessions.length > 0 && (
                      <div className="py-1">
                        {visibleSessions.map((session) => {
                          const kindBadge = sessionKindBadge(session.kind);
                          const visibleArmedWakeup =
                            session.armedWakeup &&
                            dismissedArmedWakeups.get(session.sessionId) !==
                              session.armedWakeup.id
                              ? session.armedWakeup
                              : null;
                          const status = getSessionIndicator(
                            session.sessionId,
                            sessionStatusMap,
                            session.status,
                            activeSessionId === session.sessionId
                              ? activeChatPhase
                              : undefined,
                            visibleArmedWakeup,
                            session.activeLoop,
                          );
                          const isActiveSession =
                            activeSessionId === session.sessionId;
                          const isConfirming =
                            !!archiveConfirm[session.sessionId];
                          // Unread only shows when the session isn't the
                          // active one — if the user is on it now, anything
                          // new is being read live.
                          const isUnread =
                            !isActiveSession &&
                            unreadSet.has(session.sessionId);
                          return (
                            <div
                              key={session.sessionId}
                              className="relative flex items-stretch group"
                            >
                              <div
                                role="button"
                                tabIndex={0}
                                onClick={() => {
                                  if (longPressRef.current.activated) {
                                    longPressRef.current.activated = false;
                                    return;
                                  }
                                  handleSelectSession(
                                    project,
                                    session.sessionId,
                                    session.armedWakeup?.id,
                                  );
                                }}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter" || e.key === " ") {
                                    e.preventDefault();
                                    handleSelectSession(
                                      project,
                                      session.sessionId,
                                      session.armedWakeup?.id,
                                    );
                                  }
                                }}
                                onPointerDown={(e) =>
                                  startLongPress(
                                    e,
                                    session.sessionId,
                                    project,
                                    session.title ||
                                      session.lastMessagePreview ||
                                      "New conversation",
                                    session.kind,
                                  )
                                }
                                onPointerUp={cancelLongPress}
                                onPointerCancel={cancelLongPress}
                                onPointerMove={moveLongPress}
                                onContextMenu={(e) => e.preventDefault()}
                                data-testid={`session-item-${session.sessionId}`}
                                data-session-id={session.sessionId}
                                data-session-kind={session.kind}
                                data-active={isActiveSession ? "true" : "false"}
                                data-unread={isUnread ? "true" : "false"}
                                className={`w-full text-left px-3 py-1.5 hover:bg-[#1c2129] transition-colors border-l-2 cursor-pointer focus:outline-none focus-visible:ring-1 focus-visible:ring-[#58a6ff] ${
                                  isActiveSession
                                    ? "bg-[#1c2129] border-l-[#58a6ff]"
                                    : "border-l-transparent"
                                }`}
                              >
                                <div className="flex items-center justify-between gap-1">
                                  <span className="shrink-0 mr-1.5 flex items-center">
                                    {isUnread && !status.label ? (
                                      <span
                                        className="w-2 h-2 rounded-full bg-[#58a6ff] inline-block"
                                        title="Unread — new activity since you last opened this session"
                                      />
                                    ) : (
                                      status.indicator
                                    )}
                                  </span>
                                  {kindBadge && (
                                    <span
                                      className="shrink-0 text-[9px] px-1 rounded bg-[#1f2a3a] text-[#58a6ff] uppercase tracking-wide"
                                      title={kindBadge.title}
                                    >
                                      {kindBadge.label}
                                    </span>
                                  )}
                                  <span
                                    className={`text-xs truncate flex-1 ${
                                      session.activeLoop?.state === "running"
                                        ? "text-[#a371f7]"
                                        : isActiveSession
                                          ? "text-[#e6edf3]"
                                          : isUnread
                                            ? "text-[#e6edf3] font-semibold"
                                            : "text-[#c9d1d9]"
                                    }`}
                                  >
                                    {session.title ||
                                      session.lastMessagePreview ||
                                      "New conversation"}
                                    {session.activeLoop?.state === "running" && (
                                      <span className="text-[#a371f7]/70"> ({session.activeLoop.iterationCount})</span>
                                    )}
                                  </span>
                                  {status.label && (
                                    <span
                                      className={`text-[9px] shrink-0 ${status.labelClass}`}
                                    >
                                      {status.label}
                                    </span>
                                  )}
                                  <span className="text-[9px] text-[#8b949e] shrink-0">
                                    {formatSessionTime(session.startTime)}
                                  </span>
                                </div>
                                <div className="flex items-center gap-2 mt-0.5">
                                  <span className="text-[9px] text-[#8b949e] font-mono ml-[14px]">
                                    {session.sessionId.substring(0, 8)}
                                  </span>
                                  <span className="text-[9px] text-[#8b949e]">
                                    {session.messageCount} msg
                                    {session.messageCount !== 1 ? "s" : ""}
                                  </span>
                                  <span
                                    className={`text-[9px] ${providerTextColorClass(session.provider)}`}
                                    title={`Locked provider: ${formatProviderLabel(session.provider)}`}
                                  >
                                    {formatProviderLabel(session.provider)}
                                  </span>
                                </div>
                              </div>
                              {project.encodedName && (
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleArchiveClick(
                                      session.sessionId,
                                      project.encodedName!,
                                      project,
                                    );
                                  }}
                                  className={`absolute right-1 top-1/2 -translate-y-1/2 p-1 rounded transition-all hidden md:group-hover:block ${
                                    isConfirming
                                      ? "!block bg-[#3d1214] text-[#f85149] hover:text-[#ff7b72]"
                                      : "text-[#484f58] hover:text-[#8b949e]"
                                  }`}
                                  aria-label={
                                    isConfirming
                                      ? "Click again to confirm archive"
                                      : "Archive session"
                                  }
                                  title={
                                    isConfirming
                                      ? "Click again to confirm"
                                      : "Archive"
                                  }
                                >
                                  <svg
                                    viewBox="0 0 16 16"
                                    fill="currentColor"
                                    className="w-3 h-3"
                                  >
                                    <path d="M0 2.75C0 1.784.784 1 1.75 1h12.5c.966 0 1.75.784 1.75 1.75v1.5A1.75 1.75 0 0 1 14.25 6H1.75A1.75 1.75 0 0 1 0 4.25ZM1.75 7a.75.75 0 0 0-.75.75v5.5c0 .966.784 1.75 1.75 1.75h10.5A1.75 1.75 0 0 0 15 13.25v-5.5a.75.75 0 0 0-.75-.75Zm4.5 2.25a.75.75 0 0 1 .75-.75h2a.75.75 0 0 1 0 1.5H7a.75.75 0 0 1-.75-.75Z" />
                                  </svg>
                                </button>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {/* Empty state — clickable "New session" placeholder */}
                    {sessions &&
                      sessions.length === 0 &&
                      !isLoadingSessions && (
                        <button
                          onClick={() => handleNewSession(project)}
                          data-testid="new-session"
                          data-project-path={project.path}
                          className="w-full text-left px-3 py-2 text-xs text-[#484f58] hover:text-[#c9d1d9] hover:bg-[#1c2129] transition-colors"
                        >
                          New session
                        </button>
                      )}
                  </div>
                )}
              </div>
            );
          })}

          {projects.length === 0 && (
            <div className="px-3 py-4 text-xs text-[#484f58] text-center">
              No projects yet
            </div>
          )}
        </div>

        {/* Per-provider rate-limit status (auto-hides when empty) */}
        <RateLimitStatusLine />

        {/* Create project button */}
        <div className="px-3 h-14 flex items-center gap-2 border-t border-[#30363d] shrink-0">
          <button
            onClick={() => setShowGlobalSettings(true)}
            className="w-10 h-9 shrink-0 flex items-center justify-center rounded-md bg-[#21262d] hover:bg-[#30363d] text-[#c9d1d9] transition-colors border border-[#30363d]"
            aria-label="Global settings"
            title="Global settings"
            data-testid="provider-settings-button"
          >
            <Cog6ToothIcon className="w-4 h-4" />
          </button>
          <button
            onClick={() => {
              setShowCreateDialog(true);
              setNewProjectName("");
              setCreateError(null);
            }}
            className="min-w-0 flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-md bg-[#21262d] hover:bg-[#30363d] text-[#c9d1d9] text-xs font-medium transition-colors border border-[#30363d]"
          >
            <svg
              viewBox="0 0 16 16"
              fill="currentColor"
              className="w-3.5 h-3.5"
            >
              <path d="M7.75 2a.75.75 0 0 1 .75.75V7h4.25a.75.75 0 0 1 0 1.5H8.5v4.25a.75.75 0 0 1-1.5 0V8.5H2.75a.75.75 0 0 1 0-1.5H7V2.75A.75.75 0 0 1 7.75 2Z" />
            </svg>
            Create Project
          </button>
        </div>

        <GlobalSettingsOverlay
          isOpen={showGlobalSettings}
          onClose={() => setShowGlobalSettings(false)}
        />

        {/* Create project dialog */}
        {showCreateDialog && (
          <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/60">
            <div className="bg-[#161b22] border border-[#30363d] rounded-lg p-4 w-[90%] max-w-sm shadow-xl">
              <h3 className="text-sm font-semibold text-[#e6edf3] mb-3">
                Create Project
              </h3>
              <input
                type="text"
                value={newProjectName}
                onChange={(e) => {
                  setNewProjectName(e.target.value);
                  setCreateError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && newProjectName.trim() && !creating) {
                    handleCreateProject();
                  }
                  if (e.key === "Escape") setShowCreateDialog(false);
                }}
                placeholder="Project name (e.g. SpaceCalculator)"
                className="w-full bg-[#0d1117] border border-[#30363d] rounded-md px-3 py-2 text-sm text-[#e6edf3] placeholder-[#484f58] focus:outline-none focus:border-[#58a6ff] mb-2"
                autoFocus
              />
              {createError && (
                <p className="text-xs text-[#f85149] mb-2">{createError}</p>
              )}
              <div className="flex gap-2 justify-end">
                <button
                  onClick={() => setShowCreateDialog(false)}
                  className="px-3 py-1.5 rounded-md text-xs text-[#8b949e] hover:text-[#c9d1d9] transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleCreateProject}
                  disabled={!newProjectName.trim() || creating}
                  className="px-3 py-1.5 rounded-md text-xs font-medium bg-[#238636] text-white hover:bg-[#2ea043] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  {creating ? "Creating..." : "Create"}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Resize handle — desktop only */}
        <div
          onMouseDown={handleResizeStart}
          className="hidden md:block absolute top-0 right-0 w-1 h-full cursor-col-resize hover:bg-[#58a6ff]/40 transition-colors z-10"
        />
      </aside>

      {/* Long-press context menu — portal to escape the sidebar's CSS
          transform context so it always centers on the viewport. */}
      {contextMenu &&
        createPortal(
          <div
            className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60"
            onClick={() => setContextMenu(null)}
          >
            <div
              className="bg-[#161b22] border border-[#30363d] rounded-xl shadow-2xl w-72 overflow-hidden"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="px-4 py-3 border-b border-[#30363d]">
                <p className="text-[10px] text-[#8b949e] uppercase tracking-wide mb-0.5">
                  Session
                </p>
                <p className="text-sm text-[#e6edf3] font-medium truncate">
                  {contextMenu.title}
                </p>
              </div>
              <div className="py-1">
                {contextMenu.kind === "chat" && (
                  <button
                    onClick={handleArchiveFromMenu}
                    className="w-full flex items-center gap-3 px-4 py-3 text-sm text-[#f85149] hover:bg-[#3d1214] transition-colors"
                  >
                    <svg
                      viewBox="0 0 16 16"
                      fill="currentColor"
                      className="w-4 h-4 shrink-0"
                    >
                      <path d="M0 2.75C0 1.784.784 1 1.75 1h12.5c.966 0 1.75.784 1.75 1.75v1.5A1.75 1.75 0 0 1 14.25 6H1.75A1.75 1.75 0 0 1 0 4.25ZM1.75 7a.75.75 0 0 0-.75.75v5.5c0 .966.784 1.75 1.75 1.75h10.5A1.75 1.75 0 0 0 15 13.25v-5.5a.75.75 0 0 0-.75-.75Zm4.5 2.25a.75.75 0 0 1 .75-.75h2a.75.75 0 0 1 0 1.5H7a.75.75 0 0 1-.75-.75Z" />
                    </svg>
                    Archive session
                  </button>
                )}
              </div>
              <div className="px-4 py-2 border-t border-[#30363d]">
                <button
                  onClick={() => setContextMenu(null)}
                  className="w-full py-2 text-xs text-[#8b949e] hover:text-[#c9d1d9] transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
