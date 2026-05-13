import type { ReactNode } from "react";
import { useEffect, useRef } from "react";
import type {
  PreviewState,
  ProjectFeatureKey,
  ProjectFeatures,
} from "../types";
import { ProjectGestureTab } from "./ProjectGestureTab";

interface BottomNavProps {
  activeTab: string;
  onTabChange: (tab: string) => void;
  features: ProjectFeatures;
  previewState?: PreviewState | null;
  onOpenSidebar?: () => void;
}

interface TabDef {
  id: string;
  label: string;
  icon: ReactNode;
  /**
   * If set, the tab is only visible when this feature is enabled on the
   * current project. Undefined = always visible.
   */
  feature?: ProjectFeatureKey;
}

const allTabs: TabDef[] = [
  {
    id: "chat",
    label: "Chat",
    icon: (
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
          d="M8.625 12a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0H8.25m4.125 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0H12m4.125 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 0 1-2.555-.337A5.972 5.972 0 0 1 5.41 20.97a5.969 5.969 0 0 1-.474-.065 4.48 4.48 0 0 0 .978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25Z"
        />
      </svg>
    ),
  },
  {
    id: "files",
    label: "Files",
    icon: (
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
          d="M17.25 6.75 22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3-4.5 16.5"
        />
      </svg>
    ),
  },
  {
    id: "terminal",
    label: "Terminal",
    icon: (
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
          d="m6.75 7.5 3 2.25-3 2.25m4.5 0h3m-9 8.25h13.5A2.25 2.25 0 0 0 21 18V6a2.25 2.25 0 0 0-2.25-2.25H5.25A2.25 2.25 0 0 0 3 6v12a2.25 2.25 0 0 0 2.25 2.25Z"
        />
      </svg>
    ),
  },
  {
    id: "preview",
    label: "Preview",
    feature: "preview",
    icon: (
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
          d="M9 17.25v1.007a3 3 0 0 1-.879 2.122L7.5 21h9l-.621-.621A3 3 0 0 1 15 18.257V17.25m6-12V15a2.25 2.25 0 0 1-2.25 2.25H5.25A2.25 2.25 0 0 1 3 15V5.25A2.25 2.25 0 0 1 5.25 3h13.5A2.25 2.25 0 0 1 21 5.25Z"
        />
      </svg>
    ),
  },
  {
    id: "project",
    label: "Project",
    icon: (
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
          d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z"
        />
      </svg>
    ),
  },
];

export function BottomNav({
  activeTab,
  onTabChange,
  features,
  previewState = null,
  onOpenSidebar,
}: BottomNavProps) {
  // Track the last tab visited before project so we can return to it.
  const lastNonProjectTab = useRef("chat");
  useEffect(() => {
    if (activeTab !== "project") {
      lastNonProjectTab.current = activeTab;
    }
  }, [activeTab]);

  // Filter tabs based on which features the current project has enabled.
  const visibleTabs = allTabs.filter(
    (tab) => !tab.feature || features[tab.feature].enabled,
  );

  return (
    <nav
      className="bg-[#0d1117] border-t border-[#30363d] flex items-stretch shrink-0"
      style={{ height: "var(--bottomnav-height)" }}
    >
      {visibleTabs.map((tab) => {
        const isActive = activeTab === tab.id;

        // Project tab doubles as a pull-up gesture that opens the sidebar.
        if (tab.id === "project") {
          return (
            <ProjectGestureTab
              key={tab.id}
              isActive={isActive}
              onOpenSidebar={() => onOpenSidebar?.()}
              onNavigateToProject={() =>
                activeTab === "project"
                  ? onTabChange(lastNonProjectTab.current)
                  : onTabChange("project")
              }
            />
          );
        }

        return (
          <button
            key={tab.id}
            onClick={() => onTabChange(tab.id)}
            data-testid={`tab-${tab.id}`}
            data-active={isActive ? "true" : "false"}
            className={`flex-1 flex flex-col items-center justify-center gap-0.5 transition-colors duration-150 min-h-[48px] relative ${
              isActive
                ? "text-[#58a6ff] tab-active-indicator"
                : "text-[#8b949e] hover:text-[#c9d1d9] active:text-[#c9d1d9]"
            }`}
          >
            <span className="relative">
              {tab.icon}
              {tab.id === "preview" && previewState === "error" && (
                <span
                  className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full border border-[#0d1117] bg-[#f85149]"
                  aria-label="Preview error"
                />
              )}
            </span>
            <span
              className={`text-[10px] leading-tight ${isActive ? "font-semibold" : "font-medium"}`}
            >
              {tab.label}
            </span>
          </button>
        );
      })}
    </nav>
  );
}
