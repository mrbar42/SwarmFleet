import { create } from "zustand";
import { createJSONStorage, persist, subscribeWithSelector } from "zustand/middleware";
import type { ConversationSummary } from "../types";
import type { Project, ProjectFeatures, ProjectFeatureKey } from "../types";
import { getCreateProjectUrl } from "../config/api";
import { DEFAULT_PROJECT_FEATURES } from "@shared/types";

export interface AppStoreState {
  projects: Project[];
  currentProject: Project | null;
  /**
   * Mirrors currentProject.features for subscribers that want to react to
   * feature toggles without pulling the whole project object.
   */
  currentFeatures: ProjectFeatures;
  sessionIndex: Map<string, ConversationSummary[]>;
  projectsLoadError: string | null;
  fetchProjects: () => Promise<void>;
  setCurrentProject: (project: Project | null) => void;
  setProjectFeature: (feature: ProjectFeatureKey, enabled: boolean) => Promise<void>;
  resetProjectFeature: (feature: ProjectFeatureKey) => Promise<void>;
  updateSessionIndex: (projectPath: string, sessions: ConversationSummary[]) => void;
  updateSessionTitle: (sessionId: string, title: string) => void;
  updateSessionStatus: (
    sessionId: string,
    status: import("@shared/types").SessionStatus,
    lastMessagePreview?: string,
    unreadBoundary?: number | null,
    armedWakeup?: ConversationSummary["armedWakeup"],
    activeLoop?: ConversationSummary["activeLoop"],
  ) => void;
  removeSession: (sessionId: string) => void;
  clearProjectSessions: (projectPath: string) => void;
  createProject: (name: string) => Promise<Project>;
}

function normalizeFeatures(raw: unknown): ProjectFeatures {
  const features: ProjectFeatures = {
    preview: { enabled: false },
  };
  if (raw && typeof raw === "object") {
    const rec = raw as Record<
      string,
      {
        enabled?: unknown;
        command?: unknown;
        devServer?: {
          enabled?: unknown;
          publishToHost?: unknown;
          port?: unknown;
        };
      } | undefined
    >;
    for (const key of ["preview"] as ProjectFeatureKey[]) {
      const entry = rec[key];
      if (entry?.enabled === true) {
        features[key] = { enabled: true };
      }
      if (key === "preview") {
        const devServer = entry?.devServer;
        if (typeof entry?.command === "string" && entry.command) {
          features.preview.command = entry.command;
        }
        if (devServer) {
          features.preview.devServer = {
            enabled:
              devServer.enabled === false ? false : features.preview.enabled,
            publishToHost: devServer.publishToHost === true,
            port:
              typeof devServer.port === "number" &&
              Number.isInteger(devServer.port)
                ? devServer.port
                : null,
          };
        }
      }
    }
  }
  return features;
}

function cloneSessionIndex(source: Map<string, ConversationSummary[]>): Map<string, ConversationSummary[]> {
  return new Map(Array.from(source.entries(), ([key, sessions]) => [key, sessions.map((session) => ({ ...session }))]));
}

function getFeaturesForProjectPath(
  state: AppStoreState,
  projectPath: string,
): ProjectFeatures | null {
  if (state.currentProject?.path === projectPath) {
    return state.currentFeatures;
  }
  return state.projects.find((project) => project.path === projectPath)?.features ?? null;
}

function filterSessionsForProject(
  sessions: ConversationSummary[],
  features: ProjectFeatures | null,
): ConversationSummary[] {
  const filtered = features
    ? sessions
    : sessions;
  return filtered.map((session) => ({ ...session }));
}

let projectsFetchToken = 0;

interface PersistedAppState {
  projects: Project[];
  currentProject: Project | null;
  currentFeatures: ProjectFeatures;
  sessionIndexEntries: [string, ConversationSummary[]][];
}

export const useAppStore = create<AppStoreState>()(
  persist(
    subscribeWithSelector((set, get) => ({
      projects: [],
      currentProject: null,
      currentFeatures: { ...DEFAULT_PROJECT_FEATURES },
      sessionIndex: new Map(),
      projectsLoadError: null,

      fetchProjects: async () => {
        // Token guards against out-of-order responses when retries overlap.
        const fetchToken = ++projectsFetchToken;
        try {
          const res = await fetch("/api/projects");
          if (fetchToken !== projectsFetchToken) return;
          if (!res.ok) {
            set({
              projectsLoadError: `Backend returned ${res.status} ${res.statusText || ""}`.trim(),
            });
            return;
          }

          const data = await res.json();
          if (fetchToken !== projectsFetchToken) return;
          const projectList: Project[] = (data.projects ?? []).map(
            (project: {
              name?: string;
              path: string;
              encodedName?: string;
              features?: unknown;
              kind?: "workspace" | "system";
              gitEnabled?: boolean;
            }) => ({
              name:
                project.name ||
                project.path.split("/").filter(Boolean).pop() ||
                project.encodedName ||
                "unknown",
              path: project.path,
              features: normalizeFeatures(project.features),
              encodedName: project.encodedName,
              kind: project.kind,
              gitEnabled: project.gitEnabled !== false,
            }),
          );

          set((state) => {
            const currentPath = state.currentProject?.path;
            const refreshedCurrent = currentPath
              ? projectList.find((p) => p.path === currentPath)
              : null;
            const featuresByPath = new Map(
              projectList.map((project) => [project.path, project.features]),
            );
            const sessionIndex = new Map(state.sessionIndex);
            for (const [projectPath, sessions] of sessionIndex.entries()) {
              sessionIndex.set(
                projectPath,
                filterSessionsForProject(
                  sessions,
                  featuresByPath.get(projectPath) ?? null,
                ),
              );
            }
            return {
              projects: projectList,
              currentProject: refreshedCurrent ?? state.currentProject,
              currentFeatures: refreshedCurrent?.features ?? state.currentFeatures,
              sessionIndex,
              projectsLoadError: null,
            };
          });
        } catch (error) {
          if (fetchToken !== projectsFetchToken) return;
          set({
            projectsLoadError:
              error instanceof Error && error.message
                ? error.message
                : "Could not reach the backend.",
          });
        }
      },

      setCurrentProject: (project) => {
        set((state) => {
          if (project) {
            const projects = state.projects.some((entry) => entry.path === project.path)
              ? state.projects.map((entry) => (entry.path === project.path ? project : entry))
              : state.projects;

            return {
              projects,
              currentProject: project,
              currentFeatures: project.features,
            };
          }

          return {
            currentProject: null,
            currentFeatures: { ...DEFAULT_PROJECT_FEATURES },
          };
        });
      },

      createProject: async (name) => {
        const res = await fetch(getCreateProjectUrl(), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name }),
        });
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error || "Failed to create project");
        }
        await get().fetchProjects();
        if (data.project) {
          const newProject: Project = {
            name: data.project.name,
            path: data.project.path,
            features: normalizeFeatures(data.project.features),
            encodedName: data.project.encodedName,
            kind: data.project.kind,
            gitEnabled: data.project.gitEnabled !== false,
          };
          get().setCurrentProject(newProject);
          return newProject;
        }
        throw new Error("No project returned from server");
      },

      setProjectFeature: async (feature, enabled) => {
        const { currentProject } = get();
        if (!currentProject) return;
        const res = await fetch("/api/projects/features", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            projectPath: currentProject.path,
            feature,
            enabled,
          }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || "Failed to toggle feature");
        }
        const data = (await res.json()) as { features: unknown };
        const features = normalizeFeatures(data.features);
        set((state) => {
          const updatedProject = state.currentProject
            ? { ...state.currentProject, features }
            : null;
          const projects = updatedProject
            ? state.projects.map((p) => (p.path === updatedProject.path ? updatedProject : p))
            : state.projects;
          const sessionIndex = new Map(state.sessionIndex);
          if (updatedProject && sessionIndex.has(updatedProject.path)) {
            sessionIndex.set(
              updatedProject.path,
              filterSessionsForProject(
                sessionIndex.get(updatedProject.path) ?? [],
                features,
              ),
            );
          }
          return {
            projects,
            currentProject: updatedProject,
            currentFeatures: features,
            sessionIndex,
          };
        });
      },

      resetProjectFeature: async (feature) => {
        const { currentProject } = get();
        if (!currentProject) return;
        const res = await fetch("/api/projects/features/reset", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            projectPath: currentProject.path,
            feature,
          }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || "Failed to reset feature data");
        }
        await get().fetchProjects();
      },

      updateSessionIndex: (projectPath, sessions) => {
        set((state) => ({
          sessionIndex: new Map(state.sessionIndex).set(
            projectPath,
            filterSessionsForProject(
              sessions,
              getFeaturesForProjectPath(state, projectPath),
            ),
          ),
        }));
      },

      updateSessionTitle: (sessionId, title) => {
        set((state) => {
          const next = cloneSessionIndex(state.sessionIndex);

          for (const [projectPath, sessions] of next.entries()) {
            const index = sessions.findIndex((session) => session.sessionId === sessionId);
            if (index !== -1) {
              const updated = [...sessions];
              updated[index] = { ...updated[index], title };
              next.set(projectPath, updated);
              return { sessionIndex: next };
            }
          }

          return {};
        });
      },

      updateSessionStatus: (
        sessionId,
        status,
        lastMessagePreview,
        unreadBoundary,
        armedWakeup,
        activeLoop,
      ) => {
        set((state) => {
          const next = cloneSessionIndex(state.sessionIndex);

          for (const [projectPath, sessions] of next.entries()) {
            const idx = sessions.findIndex((s) => s.sessionId === sessionId);
            if (idx !== -1) {
              const updated = [...sessions];
              const patch: Partial<ConversationSummary> = { status };
              if (lastMessagePreview !== undefined) {
                patch.lastMessagePreview = lastMessagePreview;
              }
              if (unreadBoundary !== undefined) {
                patch.unreadBoundary = unreadBoundary;
              }
              if (armedWakeup !== undefined) {
                patch.armedWakeup = armedWakeup;
              }
              if (activeLoop !== undefined) {
                patch.activeLoop = activeLoop;
              }
              updated[idx] = { ...updated[idx], ...patch };
              next.set(projectPath, updated);
              return { sessionIndex: next };
            }
          }

          return {};
        });
      },

      removeSession: (sessionId) => {
        set((state) => {
          const next = cloneSessionIndex(state.sessionIndex);

          for (const [projectPath, sessions] of next.entries()) {
            const filtered = sessions.filter((session) => session.sessionId !== sessionId);
            if (filtered.length !== sessions.length) {
              next.set(projectPath, filtered);
              return { sessionIndex: next };
            }
          }

          return {};
        });
      },

      clearProjectSessions: (projectPath) => {
        set((state) => {
          if (!state.sessionIndex.has(projectPath)) return {};
          const next = new Map(state.sessionIndex);
          next.delete(projectPath);
          return { sessionIndex: next };
        });
      },
    })),
    {
      name: "swarmfleet-session-index",
      storage: createJSONStorage(() => localStorage),
      partialize: (state): PersistedAppState => ({
        projects: state.projects,
        currentProject: state.currentProject,
        currentFeatures: state.currentFeatures,
        sessionIndexEntries: Array.from(state.sessionIndex.entries()),
      }),
      merge: (persisted, current) => {
        const saved = persisted as Partial<PersistedAppState> | undefined;
        return {
          ...current,
          projects: saved?.projects ?? current.projects,
          currentProject: saved?.currentProject ?? current.currentProject,
          currentFeatures: saved?.currentFeatures ?? current.currentFeatures,
          sessionIndex: new Map(saved?.sessionIndexEntries ?? []),
        };
      },
    },
  ),
);
