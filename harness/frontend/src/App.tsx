import {
  BrowserRouter as Router,
  Routes,
  Route,
  useNavigate,
  useLocation,
} from "react-router-dom";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ChatPage } from "./components/chat/ChatPage";
import { SettingsProvider } from "./contexts/SettingsContext";
import type { Project } from "./types";
import { BottomNav } from "./components/BottomNav";
import { FaviconUnreadIndicator } from "./components/FaviconUnreadIndicator";
import { Sidebar } from "./components/Sidebar";
import PreviewTab from "./components/preview/PreviewTab";
import { MobilePreviewSidebar } from "./components/preview/MobilePreviewSidebar";
import FilesTab from "./components/files/FilesTab";
import TerminalTab from "./components/terminal/TerminalTab";
import ProjectSettingsTab from "./components/settings/ProjectSettingsTab";
import { usePoll } from "./hooks/usePoll";
import { useAppStore } from "./stores/appStore";
import {
  connectSessionIndexStream,
  disconnectSessionIndexStream,
} from "./stores/sessionIndexStream";
import EnrollLanding from "./auth/EnrollLanding";
import Login from "./auth/Login";
import { useAuthBootstrap, useAuthStatus } from "./auth/useAuthStatus";
import type { PreviewStatus } from "@shared/types";

const VALID_TABS = new Set(["chat", "files", "terminal", "preview", "project"]);
const LAST_PROJECT_KEY = "swarmfleet-last-project";

function projectRouteName(project: Project): string {
  return encodeURIComponent(project.name);
}

function decodeProjectRouteName(value: string | null): string | null {
  if (!value) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
const MOBILE_SIDEBAR_BREAKPOINT = 768;
const SIDEBAR_EDGE_SWIPE_ZONE = 96;
const SIDEBAR_SWIPE_START_THRESHOLD = 6;
const SIDEBAR_SWIPE_VELOCITY_THRESHOLD = 0.2;
const SIDEBAR_SWIPE_PROGRESS_THRESHOLD = 0.3;
const PULL_REFRESH_START_THRESHOLD = 8;
const PULL_REFRESH_SHOW_THRESHOLD = 64;
const PULL_REFRESH_HIDE_DELAY_MS = 6000;
const MOBILE_PREVIEW_OPEN_KEY_PREFIX = "swarmfleet-mobile-preview-open:";

function mobilePreviewOpenKey(projectPath: string): string {
  return `${MOBILE_PREVIEW_OPEN_KEY_PREFIX}${projectPath}`;
}

function getScrollableParent(element: EventTarget | null): HTMLElement | null {
  let current = element instanceof HTMLElement ? element : null;

  while (
    current &&
    current !== document.body &&
    current !== document.documentElement
  ) {
    const { overflowY } = window.getComputedStyle(current);
    if (
      /(auto|scroll)/.test(overflowY) &&
      current.scrollHeight > current.clientHeight
    ) {
      return current;
    }
    current = current.parentElement;
  }

  return null;
}

function isAtTopOfScrollBoundary(element: EventTarget | null): boolean {
  const scrollableParent = getScrollableParent(element);
  if (scrollableParent) return scrollableParent.scrollTop <= 0;
  return window.scrollY <= 0 && document.documentElement.scrollTop <= 0;
}

function EmptyProjectState() {
  return (
    <div className="flex-1 flex items-center justify-center bg-[#0d1117]">
      <div className="text-center max-w-lg px-6">
        <div className="w-20 h-20 mx-auto mb-6 bg-[#161b22] rounded-2xl border border-[#30363d] flex items-center justify-center">
          <svg
            className="w-10 h-10 text-[#58a6ff]"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M12 10.5v6m3-3H9m4.06-7.19l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z"
            />
          </svg>
        </div>
        <h2 className="text-[#e6edf3] text-2xl font-bold mb-3">
          No Projects Found
        </h2>
        <p className="text-[#8b949e] text-sm mb-6 leading-relaxed">
          SwarmFleet discovers projects from your Claude Code history. Create a
          project to get started:
        </p>

        <div className="space-y-3 text-left">
          <div className="p-4 bg-[#161b22] rounded-lg border border-[#30363d]">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-[9px] px-1.5 py-0.5 rounded bg-[#a371f7]/20 text-[#a371f7] uppercase font-bold">
                Chat
              </span>
              <span className="text-sm font-medium text-[#e6edf3]">
                Use Claude Code in any directory
              </span>
            </div>
            <code className="block text-xs text-[#7ee787] bg-[#0d1117] px-3 py-2 rounded font-mono">
              cd ~/my-project && claude
            </code>
          </div>

          <div className="p-4 bg-[#161b22] rounded-lg border border-[#30363d]">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-[9px] px-1.5 py-0.5 rounded bg-[#f0883e]/20 text-[#f0883e] uppercase font-bold">
                Docker
              </span>
              <span className="text-sm font-medium text-[#e6edf3]">
                Run the full container
              </span>
            </div>
            <code className="block text-xs text-[#7ee787] bg-[#0d1117] px-3 py-2 rounded font-mono">
              ./swarmfleet.sh
            </code>
          </div>
        </div>

        <p className="text-[#484f58] text-xs mt-6">
          Projects appear here automatically once Claude Code has been used in a
          directory.
        </p>
      </div>
    </div>
  );
}

function BackendConnectionError({
  message,
  onRetry,
  title = "Starting SwarmFleet",
  description,
  fullScreen = false,
  autoRetry = false,
}: {
  message: string;
  onRetry: () => Promise<void>;
  title?: string;
  description?: ReactNode;
  fullScreen?: boolean;
  autoRetry?: boolean;
}) {
  const [isRetrying, setIsRetrying] = useState(false);
  const [retryCount, setRetryCount] = useState(0);

  const handleRetry = useCallback(async () => {
    setIsRetrying(true);
    setRetryCount((count) => count + 1);
    try {
      await onRetry();
    } finally {
      setIsRetrying(false);
    }
  }, [onRetry]);

  useEffect(() => {
    if (!autoRetry) return;
    const timer = window.setTimeout(() => {
      void handleRetry();
    }, 1500);
    return () => window.clearTimeout(timer);
  }, [autoRetry, handleRetry, retryCount]);

  return (
    <div
      className={`${fullScreen ? "min-h-dvh" : "flex-1"} flex items-center justify-center bg-[#0d1117]`}
    >
      <div className="text-center max-w-md px-6">
        <div className="w-16 h-16 mx-auto mb-4 bg-[#161b22] rounded-full border border-[#30363d] flex items-center justify-center">
          <span className="w-8 h-8 border-2 border-[#30363d] border-t-[#58a6ff] rounded-full animate-spin" />
        </div>
        <h2 className="text-[#e6edf3] text-xl font-semibold mb-2">{title}</h2>
        <p className="text-[#8b949e] text-sm mb-2">
          {description ??
            "The backend is still coming online. This screen will continue checking and resume automatically."}
        </p>
        <p className="text-[#484f58] text-xs mb-6 font-mono break-all">
          {message}
        </p>
        <button
          onClick={() => void handleRetry()}
          disabled={isRetrying}
          className="px-4 py-2 bg-[#1f6feb] text-white rounded-lg hover:bg-[#388bfd] transition-colors disabled:opacity-60 disabled:cursor-not-allowed inline-flex items-center gap-2"
        >
          {isRetrying ? (
            <>
              <span className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" />
              Checking…
            </>
          ) : autoRetry ? (
            "Check now"
          ) : (
            "Retry"
          )}
        </button>
      </div>
    </div>
  );
}

function AppLayout() {
  const [sidebarOpen, setSidebarOpen] = useState(
    () => window.innerWidth >= MOBILE_SIDEBAR_BREAKPOINT,
  );
  const [projectsHydrated, setProjectsHydrated] = useState(false);
  const [previewStatus, setPreviewStatus] = useState<PreviewStatus | null>(
    null,
  );
  const [mobilePreviewOpen, setMobilePreviewOpen] = useState(false);
  const [pullRefreshButtonVisible, setPullRefreshButtonVisible] =
    useState(false);
  const currentProject = useAppStore((state) => state.currentProject);
  const projects = useAppStore((state) => state.projects);
  const features = useAppStore((state) => state.currentFeatures);
  const setProject = useAppStore((state) => state.setCurrentProject);
  const refreshProjects = useAppStore((state) => state.fetchProjects);
  const projectsLoadError = useAppStore((state) => state.projectsLoadError);

  // Continuous swipe gesture for sidebar (native listeners for preventDefault)
  const sidebarPanelRef = useRef<HTMLDivElement>(null);
  const scrimRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const sidebarOpenRef = useRef(sidebarOpen);
  const pullRefreshHideTimerRef = useRef<number | null>(null);
  sidebarOpenRef.current = sidebarOpen;

  const touchState = useRef<{
    startX: number;
    startY: number;
    started: boolean;
    direction: "open" | "close" | null;
    lastX: number;
    lastTime: number;
    sidebarWidth: number;
  } | null>(null);

  const pullRefreshTouchState = useRef<{
    startX: number;
    startY: number;
    eligible: boolean;
    capturing: boolean;
  } | null>(null);

  const showPullRefreshButton = useCallback(() => {
    setPullRefreshButtonVisible(true);
    if (pullRefreshHideTimerRef.current !== null) {
      window.clearTimeout(pullRefreshHideTimerRef.current);
    }
    pullRefreshHideTimerRef.current = window.setTimeout(() => {
      setPullRefreshButtonVisible(false);
      pullRefreshHideTimerRef.current = null;
    }, PULL_REFRESH_HIDE_DELAY_MS);
  }, []);

  useEffect(() => {
    return () => {
      if (pullRefreshHideTimerRef.current !== null) {
        window.clearTimeout(pullRefreshHideTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      pullRefreshTouchState.current = {
        startX: e.touches[0].clientX,
        startY: e.touches[0].clientY,
        eligible: isAtTopOfScrollBoundary(e.target),
        capturing: false,
      };
    };

    const onTouchMove = (e: TouchEvent) => {
      const state = pullRefreshTouchState.current;
      if (!state?.eligible || e.touches.length !== 1) return;

      const deltaX = e.touches[0].clientX - state.startX;
      const deltaY = e.touches[0].clientY - state.startY;
      if (deltaY <= PULL_REFRESH_START_THRESHOLD) return;
      if (Math.abs(deltaX) > deltaY) {
        pullRefreshTouchState.current = null;
        return;
      }

      state.capturing = true;
      e.preventDefault();

      if (deltaY >= PULL_REFRESH_SHOW_THRESHOLD) {
        showPullRefreshButton();
      }
    };

    const onTouchEnd = () => {
      pullRefreshTouchState.current = null;
    };

    const onTouchCancel = () => {
      pullRefreshTouchState.current = null;
    };

    root.addEventListener("touchstart", onTouchStart, { passive: true });
    root.addEventListener("touchmove", onTouchMove, { passive: false });
    root.addEventListener("touchend", onTouchEnd, { passive: true });
    root.addEventListener("touchcancel", onTouchCancel, { passive: true });
    return () => {
      root.removeEventListener("touchstart", onTouchStart);
      root.removeEventListener("touchmove", onTouchMove);
      root.removeEventListener("touchend", onTouchEnd);
      root.removeEventListener("touchcancel", onTouchCancel);
    };
  }, [showPullRefreshButton]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const onTouchStart = (e: TouchEvent) => {
      if (window.innerWidth >= MOBILE_SIDEBAR_BREAKPOINT) return;
      const x = e.touches[0].clientX;
      if (!sidebarOpenRef.current && x > SIDEBAR_EDGE_SWIPE_ZONE) return;
      touchState.current = {
        startX: x,
        startY: e.touches[0].clientY,
        started: false,
        direction: null,
        lastX: x,
        lastTime: Date.now(),
        sidebarWidth:
          sidebarPanelRef.current?.offsetWidth ?? window.innerWidth * 0.96,
      };
    };

    const onTouchMove = (e: TouchEvent) => {
      const state = touchState.current;
      if (!state) return;
      const x = e.touches[0].clientX;
      const y = e.touches[0].clientY;
      const deltaX = x - state.startX;
      const deltaY = Math.abs(y - state.startY);

      if (!state.started) {
        if (deltaY > Math.abs(deltaX)) {
          touchState.current = null;
          return;
        }
        if (Math.abs(deltaX) < SIDEBAR_SWIPE_START_THRESHOLD) return;
        if (deltaX > 0 && !sidebarOpenRef.current) state.direction = "open";
        else if (deltaX < 0 && sidebarOpenRef.current)
          state.direction = "close";
        else {
          touchState.current = null;
          return;
        }
        state.started = true;
        if (sidebarPanelRef.current)
          sidebarPanelRef.current.style.transition = "none";
        if (scrimRef.current) scrimRef.current.style.transition = "none";
      }

      // Prevent browser overscroll / back-navigation
      e.preventDefault();

      state.lastX = x;
      state.lastTime = Date.now();

      const { sidebarWidth } = state;
      const offset =
        state.direction === "open"
          ? Math.max(0, Math.min(sidebarWidth, deltaX))
          : Math.max(0, Math.min(sidebarWidth, sidebarWidth + deltaX));
      const progress = offset / sidebarWidth;

      if (sidebarPanelRef.current) {
        sidebarPanelRef.current.style.transform = `translateX(${offset - sidebarWidth}px)`;
        sidebarPanelRef.current.style.position = "fixed";
      }
      if (scrimRef.current) {
        scrimRef.current.style.opacity = String(progress);
        scrimRef.current.style.pointerEvents = progress > 0 ? "auto" : "none";
      }
    };

    const onTouchEnd = (e: TouchEvent) => {
      const state = touchState.current;
      if (!state?.started) {
        touchState.current = null;
        return;
      }

      const endX = e.changedTouches[0].clientX;
      const { sidebarWidth } = state;
      const deltaX = endX - state.startX;
      const offset =
        state.direction === "open"
          ? Math.max(0, Math.min(sidebarWidth, deltaX))
          : Math.max(0, Math.min(sidebarWidth, sidebarWidth + deltaX));
      const progress = offset / sidebarWidth;

      const dt = Math.max(1, Date.now() - state.lastTime);
      const velocity = (endX - state.lastX) / dt;

      let finalOpen: boolean;
      if (velocity > SIDEBAR_SWIPE_VELOCITY_THRESHOLD) finalOpen = true;
      else if (velocity < -SIDEBAR_SWIPE_VELOCITY_THRESHOLD) finalOpen = false;
      else finalOpen = progress > SIDEBAR_SWIPE_PROGRESS_THRESHOLD;

      if (sidebarPanelRef.current) {
        sidebarPanelRef.current.style.transition = "";
        sidebarPanelRef.current.style.transform = "";
        sidebarPanelRef.current.style.position = "";
      }
      if (scrimRef.current) {
        scrimRef.current.style.transition = "";
        scrimRef.current.style.opacity = "";
        scrimRef.current.style.pointerEvents = "";
      }

      setSidebarOpen(finalOpen);
      touchState.current = null;
    };

    root.addEventListener("touchstart", onTouchStart, { passive: true });
    root.addEventListener("touchmove", onTouchMove, { passive: false });
    root.addEventListener("touchend", onTouchEnd, { passive: true });
    return () => {
      root.removeEventListener("touchstart", onTouchStart);
      root.removeEventListener("touchmove", onTouchMove);
      root.removeEventListener("touchend", onTouchEnd);
    };
  }, []);

  useEffect(() => {
    const mediaQuery = window.matchMedia(
      `(min-width: ${MOBILE_SIDEBAR_BREAKPOINT}px)`,
    );

    const syncSidebarForViewport = (matchesDesktop: boolean) => {
      if (!matchesDesktop) return;
      if (sidebarPanelRef.current) {
        sidebarPanelRef.current.style.transition = "";
        sidebarPanelRef.current.style.transform = "";
        sidebarPanelRef.current.style.position = "";
      }
      if (scrimRef.current) {
        scrimRef.current.style.transition = "";
        scrimRef.current.style.opacity = "";
        scrimRef.current.style.pointerEvents = "";
      }
      touchState.current = null;
      setSidebarOpen(true);
    };

    syncSidebarForViewport(mediaQuery.matches);
    const onChange = (event: MediaQueryListEvent) => {
      syncSidebarForViewport(event.matches);
    };
    mediaQuery.addEventListener("change", onChange);
    return () => mediaQuery.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    let cancelled = false;

    void refreshProjects().finally(() => {
      if (!cancelled) {
        setProjectsHydrated(true);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [refreshProjects]);

  // Subscribe to session-index SSE so new sessions created on other devices
  // show up here immediately (and vice versa) without needing a refresh.
  useEffect(() => {
    connectSessionIndexStream();
    return () => {
      disconnectSessionIndexStream();
    };
  }, []);

  const previewPollStartingRef = useRef(false);
  const pollPreviewStatus = useCallback(
    async (signal: AbortSignal) => {
      if (!currentProject || !features.preview.enabled) return;

      try {
        const res = await fetch(
          `/api/preview/status?project=${encodeURIComponent(currentProject.path)}`,
          { signal },
        );
        const next = res.ok ? ((await res.json()) as PreviewStatus) : null;
        if (signal.aborted) return;
        setPreviewStatus(next);
        if (!next || next.state !== "idle" || previewPollStartingRef.current) {
          return;
        }

        previewPollStartingRef.current = true;
        try {
          const startRes = await fetch("/api/preview/start", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ projectPath: currentProject.path }),
            signal,
          });
          if (!signal.aborted && startRes.ok) {
            setPreviewStatus((await startRes.json()) as PreviewStatus);
          }
        } finally {
          previewPollStartingRef.current = false;
        }
      } catch {
        if (!signal.aborted) setPreviewStatus(null);
      }
    },
    [currentProject, features.preview.enabled],
  );

  usePoll(pollPreviewStatus, 3000, {
    enabled: Boolean(currentProject && features.preview.enabled),
  });

  useEffect(() => {
    if (!currentProject || !features.preview.enabled) {
      setPreviewStatus(null);
      setMobilePreviewOpen(false);
    }
  }, [currentProject, features.preview.enabled]);

  useEffect(() => {
    if (!currentProject?.path || !features.preview.enabled) return;
    try {
      setMobilePreviewOpen(
        localStorage.getItem(mobilePreviewOpenKey(currentProject.path)) ===
          "true",
      );
    } catch {
      setMobilePreviewOpen(false);
    }
  }, [currentProject?.path, features.preview.enabled]);

  useEffect(() => {
    const handler = () => {
      setMobilePreviewOpen((open) => {
        const next = !open;
        if (currentProject?.path) {
          try {
            localStorage.setItem(
              mobilePreviewOpenKey(currentProject.path),
              String(next),
            );
          } catch {
            // storage not available
          }
        }
        return next;
      });
    };
    window.addEventListener("toggle-mobile-preview", handler);
    return () => window.removeEventListener("toggle-mobile-preview", handler);
  }, [currentProject?.path]);

  const navigate = useNavigate();
  const location = useLocation();
  const urlSessionId = new URLSearchParams(location.search).get("sessionId");
  // Parse /:tab/:projectName from pathname
  const pathSegments = location.pathname.split("/").filter(Boolean);
  const tabParam =
    pathSegments[0] && VALID_TABS.has(pathSegments[0]) ? pathSegments[0] : null;
  const projectNameParam = decodeProjectRouteName(pathSegments[1] || null);
  const activeTab = tabParam ?? "chat";
  const routeSessionId = urlSessionId;

  // Resolve which project should be active. Explicit URLs win; opening the UI
  // without a project/session specifier starts a fresh chat in the first
  // discovered project instead of restoring a previous project.
  const resolvedProject = (() => {
    if (projects.length === 0) return null;
    if (projectNameParam) {
      return projects.find((p: Project) => p.name === projectNameParam) ?? null;
    }
    return projects[0];
  })();

  // Keep context and URL in sync with the resolved project
  useEffect(() => {
    if (!resolvedProject) return;

    // Sync context
    if (resolvedProject.path !== currentProject?.path) {
      setProject(resolvedProject);
    }

    // Sync URL — always ensure project name is in the path
    if (projectNameParam !== resolvedProject.name) {
      navigate(
        `/${activeTab}/${projectRouteName(resolvedProject)}${location.search}`,
        {
          replace: true,
        },
      );
    }

    localStorage.setItem(LAST_PROJECT_KEY, resolvedProject.name);
  }, [
    resolvedProject,
    currentProject,
    projectNameParam,
    setProject,
    navigate,
    activeTab,
    location.search,
  ]);

  const handleTabChange = useCallback(
    (tab: string) => {
      const slug = currentProject ? projectRouteName(currentProject) : "";
      const sessionId = new URLSearchParams(location.search).get("sessionId");
      const search = sessionId
        ? `?sessionId=${encodeURIComponent(sessionId)}`
        : "";
      navigate(slug ? `/${tab}/${slug}${search}` : `/${tab}${search}`);
    },
    [currentProject, navigate, location.search],
  );

  // Listen for "run-terminal-command" events to switch to terminal tab
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.switchToTerminal) {
        handleTabChange("terminal");
        // Re-dispatch the command after terminal tab has mounted
        setTimeout(() => {
          window.dispatchEvent(
            new CustomEvent("run-terminal-command", {
              detail: { ...detail, switchToTerminal: false },
            }),
          );
        }, 1000);
      }
    };
    window.addEventListener("run-terminal-command", handler);
    return () => window.removeEventListener("run-terminal-command", handler);
  }, [handleTabChange]);

  const handleSidebarSessionSelect = useCallback(
    (project: Project, sessionId: string) => {
      const searchParams = new URLSearchParams();
      searchParams.set("sessionId", sessionId);
      navigate({
        pathname: `/chat/${projectRouteName(project)}`,
        search: searchParams.toString(),
      });
    },
    [navigate],
  );

  // Show empty project state when no projects exist (and not in dev mock mode).
  // Prefer the backend-unreachable message when the last fetch failed so users
  // don't see a misleading "No Projects Found" screen during a backend outage.
  const showBackendError =
    !!projectsLoadError && projects.length === 0 && !currentProject;
  const showEmptyState =
    !showBackendError && projects.length === 0 && !currentProject;
  const isProjectSynced = resolvedProject
    ? currentProject?.path === resolvedProject.path &&
      projectNameParam === resolvedProject.name
    : !projectNameParam && !currentProject;
  const isAppReady =
    projectsHydrated && (showBackendError || showEmptyState || isProjectSynced);

  return (
    <div
      ref={rootRef}
      data-testid={isAppReady ? "app-ready" : undefined}
      data-ready={isAppReady ? "true" : "false"}
      className="h-dvh flex flex-col bg-[#0d1117]"
    >
      <FaviconUnreadIndicator />
      {pullRefreshButtonVisible && (
        <div className="fixed left-0 right-0 top-0 z-[60] flex justify-center px-3 pt-[calc(env(safe-area-inset-top)+8px)] pointer-events-none md:hidden">
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="pointer-events-auto rounded-full border border-[#30363d] bg-[#1f6feb] px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-black/30 transition-colors hover:bg-[#388bfd] active:bg-[#1f6feb]"
            aria-label="refresh page"
          >
            refresh page
          </button>
        </div>
      )}
      {/* Top Nav Bar — mobile only */}
      <header className="h-11 bg-[#161b22] border-b border-[#30363d] flex items-center px-3 shrink-0 relative z-30 md:hidden">
        {/* Left: hamburger + app name */}
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() => setSidebarOpen((prev) => !prev)}
            className="text-[#8b949e] hover:text-[#c9d1d9] p-1 transition-colors"
            aria-label="Toggle sidebar"
            title="Toggle sidebar"
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
                d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5"
              />
            </svg>
          </button>
          <span className="text-xs font-bold text-[#8b949e] tracking-wider uppercase">
            SwarmFleet
          </span>
        </div>

        {/* Center: Project title — opens sidebar */}
        <div className="flex-1 flex justify-center min-w-0">
          <button
            onClick={() => setSidebarOpen((prev) => !prev)}
            className="text-[#c9d1d9] text-sm font-semibold hover:text-white transition-colors max-w-[200px] truncate"
          >
            {currentProject?.name ?? "Select Project"}
          </button>
        </div>

        {/* Right: New Chat + Status */}
        <div className="flex items-center gap-2 shrink-0">
          {currentProject && (
            <button
              onClick={() => {
                navigate(`/chat/${projectRouteName(currentProject)}`);
                window.dispatchEvent(new CustomEvent("new-chat-session"));
              }}
              className="text-[#8b949e] hover:text-[#c9d1d9] p-1 transition-colors"
              aria-label="New chat"
              title="New chat"
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
                  d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10"
                />
              </svg>
            </button>
          )}
        </div>
      </header>

      {/* Body: Sidebar + Main */}
      <div className="flex-1 flex overflow-hidden">
        {/* Sidebar */}
        <Sidebar
          isOpen={sidebarOpen}
          onClose={() => setSidebarOpen(false)}
          activeSessionId={routeSessionId}
          onSelectSession={handleSidebarSessionSelect}
          onNewSessionForProject={(project) => {
            navigate(`/chat/${projectRouteName(project)}`);
            window.dispatchEvent(new CustomEvent("new-chat-session"));
          }}
          projects={projects}
          currentProject={currentProject}
          panelRef={sidebarPanelRef}
          scrimRef={scrimRef}
        />

        {/* Main content area */}
        {showBackendError ? (
          <BackendConnectionError
            message={projectsLoadError ?? "Unknown error"}
            onRetry={refreshProjects}
          />
        ) : showEmptyState ? (
          <EmptyProjectState />
        ) : (
          <div className="flex-1 flex flex-col overflow-hidden min-w-0">
            {/* Tab content */}
            <div className="flex-1 flex flex-col overflow-hidden">
              <div
                className={`flex-1 flex flex-col overflow-hidden ${activeTab === "chat" ? "" : "hidden"}`}
              >
                <ChatPage />
              </div>
              {activeTab === "files" && (
                <FilesTab
                  projectPath={currentProject?.path ?? null}
                  gitEnabled={currentProject?.gitEnabled !== false}
                />
              )}
              {activeTab === "terminal" && (
                <TerminalTab
                  projectPath={currentProject?.path ?? null}
                  isVisible={activeTab === "terminal"}
                />
              )}
              {features.preview.enabled && (
                <div
                  className={`flex-1 min-h-0 flex flex-col overflow-hidden ${
                    activeTab === "preview" ? "" : "hidden"
                  }`}
                >
                  <PreviewTab projectPath={currentProject?.path ?? null} />
                </div>
              )}
              {activeTab === "project" && (
                <ProjectSettingsTab
                  currentProject={currentProject}
                  features={features}
                />
              )}
            </div>

            {/* Bottom nav */}
            <BottomNav
              activeTab={activeTab}
              onTabChange={handleTabChange}
              features={features}
              previewState={previewStatus?.state ?? null}
              onOpenSidebar={() => setSidebarOpen(true)}
            />
          </div>
        )}
        <MobilePreviewSidebar
          isOpen={
            mobilePreviewOpen &&
            activeTab === "chat" &&
            features.preview.enabled &&
            !showBackendError &&
            !showEmptyState
          }
          onClose={() => {
            setMobilePreviewOpen(false);
            if (!currentProject?.path) return;
            try {
              localStorage.setItem(
                mobilePreviewOpenKey(currentProject.path),
                "false",
              );
            } catch {
              // storage not available
            }
          }}
          projectPath={currentProject?.path ?? null}
          status={previewStatus}
        />
      </div>
    </div>
  );
}

function AppRoutes() {
  // unstable_useTransitions={false} disables React Router's internal
  // `React.startTransition` wrapping of location updates. With transitions on
  // (the default), `useLocation` lags behind `window.location` for a tick, and
  // any effect that reads URL state right after a click handler that also
  // mutates other stores (e.g. zustand) sees a stale URL — which caused the
  // sidebar to revert to the previous project/session.
  return (
    <Router unstable_useTransitions={false}>
      <AuthGate>
        <Routes>
          <Route path="/enroll" element={<EnrollLanding />} />
          <Route path="/*" element={<AppLayout />} />
        </Routes>
      </AuthGate>
    </Router>
  );
}

function AuthGate({ children }: { children: ReactNode }) {
  const { error, refresh, status } = useAuthStatus();
  const location = useLocation();

  if (location.pathname === "/enroll") return <>{children}</>;

  if (status === "loading") {
    return (
      <div className="min-h-dvh flex items-center justify-center bg-[#0d1117] text-sm text-[#8b949e]">
        Loading…
      </div>
    );
  }

  if (status === "unauthenticated") return <Login />;

  if (status === "error") {
    return (
      <BackendConnectionError
        fullScreen
        autoRetry
        title="Starting SwarmFleet"
        description="The backend is still coming online. SwarmFleet will keep checking and open automatically when ready."
        message={error ?? "Auth status request failed"}
        onRetry={refresh}
      />
    );
  }

  return <>{children}</>;
}

function App() {
  useAuthBootstrap();

  return (
    <SettingsProvider>
      <AppRoutes />
    </SettingsProvider>
  );
}

export default App;
