import { useState, useCallback, useRef, useEffect } from "react";
import { usePoll } from "../../hooks/usePoll";

export interface OpenFile {
  path: string;
  name: string;
  content: string;
  extension: string;
  dirty: boolean;
  originalContent: string;
}

export interface TreeEntry {
  name: string;
  path: string;
  type: "file" | "directory";
  size?: number;
}

export interface GitStatusFile {
  path: string;
  status: string;
  staged: boolean;
}

export interface GitStatus {
  branch: string;
  ahead: number;
  behind: number;
  files: GitStatusFile[];
  hasConflicts: boolean;
  conflictFiles: string[];
}

interface FileStoreSnapshot {
  openFiles: OpenFile[];
  activeFilePath: string | null;
  treeByDir: Record<string, TreeEntry[]>;
  expandedDirs: string[];
  selectedPath: string | null;
}

const fileStoreSnapshots = new Map<string, FileStoreSnapshot>();

function emptySnapshot(): FileStoreSnapshot {
  return {
    openFiles: [],
    activeFilePath: null,
    treeByDir: {},
    expandedDirs: [],
    selectedPath: null,
  };
}

function snapshotForProject(projectPath: string | null): FileStoreSnapshot {
  if (!projectPath) return emptySnapshot();
  return fileStoreSnapshots.get(projectPath) ?? emptySnapshot();
}

export function useFileStore(projectPath: string | null, gitEnabled = true) {
  const initialSnapshot = snapshotForProject(projectPath);
  const [openFiles, setOpenFiles] = useState<OpenFile[]>(initialSnapshot.openFiles);
  const [activeFilePath, setActiveFilePath] = useState<string | null>(initialSnapshot.activeFilePath);
  const [treeByDir, setTreeByDir] = useState<Record<string, TreeEntry[]>>(initialSnapshot.treeByDir);
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set(initialSnapshot.expandedDirs));
  const [selectedPath, setSelectedPath] = useState<string | null>(initialSnapshot.selectedPath);
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState(false);
  const projectPathRef = useRef(projectPath);
  const skipCacheProjectRef = useRef<string | null>(null);

  const activeFile = openFiles.find((f) => f.path === activeFilePath) ?? null;

  // Derived: root entries for backward compat
  const treeEntries = treeByDir["."] ?? [];

  const cacheSnapshot = useCallback(
    (path: string | null) => {
      if (!path) return;
      fileStoreSnapshots.set(path, {
        openFiles,
        activeFilePath,
        treeByDir,
        expandedDirs: Array.from(expandedDirs),
        selectedPath,
      });
    },
    [activeFilePath, expandedDirs, openFiles, selectedPath, treeByDir],
  );

  useEffect(() => {
    const previousProjectPath = projectPathRef.current;
    if (previousProjectPath !== projectPath) {
      cacheSnapshot(previousProjectPath);
      const nextSnapshot = snapshotForProject(projectPath);
      setOpenFiles(nextSnapshot.openFiles);
      setActiveFilePath(nextSnapshot.activeFilePath);
      setTreeByDir(nextSnapshot.treeByDir);
      setExpandedDirs(new Set(nextSnapshot.expandedDirs));
      setSelectedPath(nextSnapshot.selectedPath);
      setGitStatus(null);
      setLoading(false);
      setEditing(false);
      projectPathRef.current = projectPath;
      skipCacheProjectRef.current = projectPath;
    }
  }, [cacheSnapshot, projectPath]);

  useEffect(() => {
    if (projectPath && skipCacheProjectRef.current === projectPath) {
      skipCacheProjectRef.current = null;
      return;
    }
    cacheSnapshot(projectPath);
  }, [cacheSnapshot, projectPath]);

  useEffect(() => {
    return () => cacheSnapshot(projectPathRef.current);
  }, [cacheSnapshot]);

  const fetchDir = useCallback(
    async (dirPath: string): Promise<TreeEntry[] | null> => {
      if (!projectPath) return null;
      // For root, fetch the absolute projectPath. For subdirs, entry paths
      // returned by the API are already relative to wsRoot — pass as-is, the
      // backend resolves them (matches the original fetchTree behavior).
      const apiPath = dirPath === "." ? projectPath : dirPath;
      try {
        const res = await fetch(`/api/files/tree?path=${encodeURIComponent(apiPath)}`);
        const data = await res.json();
        if (data.entries) {
          setTreeByDir((prev) => ({ ...prev, [dirPath]: data.entries as TreeEntry[] }));
          return data.entries as TreeEntry[];
        }
      } catch {
        // ignore
      }
      return null;
    },
    [projectPath],
  );

  const fetchTree = useCallback(
    async (_dirPath?: string) => {
      // Always refresh root "." entries (treeEntries is derived from "." )
      await fetchDir(".");
    },
    [fetchDir],
  );

  const toggleDir = useCallback(
    async (path: string) => {
      const isExpanded = expandedDirs.has(path);
      if (isExpanded) {
        setExpandedDirs((prev) => {
          const next = new Set(prev);
          next.delete(path);
          return next;
        });
        return;
      }
      // Expanding: fetch if not cached
      if (!treeByDir[path]) {
        await fetchDir(path);
      }
      setExpandedDirs((prev) => {
        const next = new Set(prev);
        next.add(path);
        return next;
      });
    },
    [expandedDirs, treeByDir, fetchDir],
  );

  const collapseAll = useCallback(() => {
    setExpandedDirs(new Set());
  }, []);

  const refreshAll = useCallback(async () => {
    const dirs = new Set<string>(["."]);
    for (const p of expandedDirs) dirs.add(p);
    await Promise.all(Array.from(dirs).map((d) => fetchDir(d)));
  }, [expandedDirs, fetchDir]);

  const selectPath = useCallback((path: string | null) => {
    setSelectedPath(path);
  }, []);

  // For parentDir === "." the API needs an absolute path rooted at projectPath;
  // for subdirs, entry paths are already wsRoot-relative and resolve correctly.
  const resolveCreatePath = useCallback(
    (parentDir: string, name: string): string | null => {
      if (parentDir === ".") {
        if (!projectPath) return null;
        return `${projectPath.replace(/\/$/, "")}/${name}`;
      }
      return `${parentDir}/${name}`;
    },
    [projectPath],
  );

  const createFile = useCallback(
    async (parentDir: string, name: string, content = ""): Promise<{ ok: boolean; error?: string }> => {
      const path = resolveCreatePath(parentDir, name);
      if (!path) return { ok: false, error: "No project selected" };
      try {
        const res = await fetch("/api/files/write", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path, content }),
        });
        const data = await res.json();
        if (data.ok) {
          await fetchDir(parentDir);
          return { ok: true };
        }
        return { ok: false, error: data.error || "Failed to create file" };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
    [fetchDir, resolveCreatePath],
  );

  const createDir = useCallback(
    async (parentDir: string, name: string): Promise<{ ok: boolean; error?: string }> => {
      const path = resolveCreatePath(parentDir, name);
      if (!path) return { ok: false, error: "No project selected" };
      try {
        const res = await fetch("/api/files/mkdir", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path }),
        });
        const data = await res.json();
        if (data.ok) {
          await fetchDir(parentDir);
          return { ok: true };
        }
        return { ok: false, error: data.error || "Failed to create directory" };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
    [fetchDir, resolveCreatePath],
  );

  const openFile = useCallback(
    async (path: string) => {
      // If already open, just activate
      const existing = openFiles.find((f) => f.path === path);
      if (existing) {
        setActiveFilePath(path);
        return;
      }

      setLoading(true);
      try {
        const res = await fetch(`/api/files/read?path=${encodeURIComponent(path)}`);
        const data = await res.json();
        if (data.error) {
          console.error(data.error);
          return;
        }

        const name = path.split("/").pop() || path;
        const file: OpenFile = {
          path,
          name,
          content: data.content,
          extension: data.extension || "",
          dirty: false,
          originalContent: data.content,
        };
        setOpenFiles((prev) => [...prev, file]);
        setActiveFilePath(path);
      } catch (e) {
        console.error("Failed to open file:", e);
      } finally {
        setLoading(false);
      }
    },
    [openFiles],
  );

  const closeFile = useCallback(
    (path: string) => {
      setOpenFiles((prev) => prev.filter((f) => f.path !== path));
      if (activeFilePath === path) {
        setActiveFilePath(() => {
          const remaining = openFiles.filter((f) => f.path !== path);
          return remaining.length > 0 ? remaining[remaining.length - 1].path : null;
        });
      }
    },
    [activeFilePath, openFiles],
  );

  const closeOtherFiles = useCallback(
    (keepPath: string) => {
      setOpenFiles((prev) => prev.filter((f) => f.path === keepPath));
      setActiveFilePath(keepPath);
    },
    [],
  );

  const closeAllFiles = useCallback(() => {
    setOpenFiles([]);
    setActiveFilePath(null);
  }, []);

  const updateFileContent = useCallback((path: string, content: string) => {
    setOpenFiles((prev) =>
      prev.map((f) =>
        f.path === path
          ? { ...f, content, dirty: content !== f.originalContent }
          : f,
      ),
    );
  }, []);

  const saveFile = useCallback(
    async (path: string) => {
      const file = openFiles.find((f) => f.path === path);
      if (!file) return;

      try {
        const res = await fetch("/api/files/write", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path, content: file.content }),
        });
        const data = await res.json();
        if (data.ok) {
          setOpenFiles((prev) =>
            prev.map((f) =>
              f.path === path
                ? { ...f, dirty: false, originalContent: f.content }
                : f,
            ),
          );
        }
      } catch (e) {
        console.error("Failed to save file:", e);
      }
    },
    [openFiles],
  );

  const fetchGitStatus = useCallback(async (signal?: AbortSignal) => {
    if (!projectPath || !gitEnabled) {
      setGitStatus(null);
      return;
    }
    try {
      const res = await fetch(
        `/api/git/status?project=${encodeURIComponent(projectPath)}`,
        { signal },
      );
      const data = await res.json();
      if (!signal?.aborted && !data.error) setGitStatus(data);
    } catch {
      // ignore
    }
  }, [projectPath, gitEnabled]);

  usePoll(fetchGitStatus, 10000, {
    enabled: Boolean(projectPath && gitEnabled),
  });

  useEffect(() => {
    if (!projectPath || !gitEnabled) {
      setGitStatus(null);
    }
  }, [projectPath, gitEnabled]);

  // Load initial tree
  useEffect(() => {
    if (projectPath) fetchTree();
  }, [projectPath, fetchTree]);

  return {
    openFiles,
    activeFile,
    activeFilePath,
    setActiveFilePath,
    treeEntries,
    treeByDir,
    expandedDirs,
    selectedPath,
    gitStatus,
    loading,
    editing,
    setEditing,
    fetchTree,
    toggleDir,
    collapseAll,
    refreshAll,
    selectPath,
    createFile,
    createDir,
    openFile,
    closeFile,
    closeOtherFiles,
    closeAllFiles,
    updateFileContent,
    saveFile,
    fetchGitStatus,
  };
}
