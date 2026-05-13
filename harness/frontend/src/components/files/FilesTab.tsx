import { useState, useCallback, useEffect, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import { useFileStore } from "./useFileStore";
import { IdeNavBar } from "./IdeNavBar";
import { FileExplorer } from "./FileExplorer";
import { FileViewer } from "./FileViewer";
import { FileTabMenu } from "./FileTabMenu";
import { GitView } from "./GitView";

type Panel = "files" | "git" | "editor";

interface FilesTabProps {
  projectPath: string | null;
  gitEnabled?: boolean;
}

interface FilesTabUiSnapshot {
  activePanel: Panel;
  explorerOpen: boolean;
}

const filesTabUiSnapshots = new Map<string, FilesTabUiSnapshot>();

function useDesktopLayout() {
  const [isDesktop, setIsDesktop] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia("(min-width: 768px)").matches;
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    const query = window.matchMedia("(min-width: 768px)");
    const handleChange = () => setIsDesktop(query.matches);
    handleChange();
    query.addEventListener("change", handleChange);
    return () => query.removeEventListener("change", handleChange);
  }, []);

  return isDesktop;
}

function isPanel(value: string | null): value is Panel {
  return value === "files" || value === "git" || value === "editor";
}

function initialUiState(
  projectPath: string | null,
  searchParams: URLSearchParams,
): FilesTabUiSnapshot {
  const urlPanel = searchParams.get("panel");
  if (isPanel(urlPanel)) {
    return {
      activePanel: urlPanel,
      explorerOpen: urlPanel === "files",
    };
  }
  if (projectPath) {
    const cached = filesTabUiSnapshots.get(projectPath);
    if (cached) return cached;
  }
  return {
    activePanel: "files",
    explorerOpen: true,
  };
}

export default function FilesTab({ projectPath, gitEnabled = true }: FilesTabProps) {
  const store = useFileStore(projectPath, gitEnabled);
  const [searchParams, setSearchParams] = useSearchParams();
  const initialUi = initialUiState(projectPath, searchParams);
  const [activePanel, setActivePanel] = useState<Panel>(initialUi.activePanel);
  const [explorerOpen, setExplorerOpen] = useState(initialUi.explorerOpen);
  const isDesktop = useDesktopLayout();
  const restoredFromUrl = useRef(false);
  const projectPathRef = useRef(projectPath);
  const skipUiCacheProjectRef = useRef<string | null>(null);

  const cacheUiState = useCallback(
    (path: string | null) => {
      if (!path) return;
      filesTabUiSnapshots.set(path, { activePanel, explorerOpen });
    },
    [activePanel, explorerOpen],
  );

  useEffect(() => {
    const previousProjectPath = projectPathRef.current;
    if (previousProjectPath !== projectPath) {
      cacheUiState(previousProjectPath);
      const nextUi = initialUiState(projectPath, searchParams);
      setActivePanel(nextUi.activePanel);
      setExplorerOpen(nextUi.explorerOpen);
      restoredFromUrl.current = false;
      projectPathRef.current = projectPath;
      skipUiCacheProjectRef.current = projectPath;
    }
  }, [cacheUiState, projectPath, searchParams]);

  useEffect(() => {
    if (projectPath && skipUiCacheProjectRef.current === projectPath) {
      skipUiCacheProjectRef.current = null;
      return;
    }
    cacheUiState(projectPath);
  }, [cacheUiState, projectPath]);

  useEffect(() => {
    return () => cacheUiState(projectPathRef.current);
  }, [cacheUiState]);

  // Restore file from URL on mount
  useEffect(() => {
    if (restoredFromUrl.current || !projectPath || store.openFiles.length > 0) return;
    const fileParam = searchParams.get("file");
    if (fileParam) {
      restoredFromUrl.current = true;
      store.openFile(fileParam).then(() => {
        setActivePanel("editor");
        setExplorerOpen(false);
      });
    }
  }, [projectPath, searchParams, store, store.openFiles.length]);

  // Sync state → URL
  useEffect(() => {
    setSearchParams((previousParams) => {
      const params = new URLSearchParams();
      const sessionId = previousParams.get("sessionId");
      if (sessionId) params.set("sessionId", sessionId);
      if (activePanel !== "files") params.set("panel", activePanel);
      if (store.activeFilePath) params.set("file", store.activeFilePath);
      return params;
    }, { replace: true });
  }, [activePanel, store.activeFilePath, setSearchParams]);
  const [menuState, setMenuState] = useState<{
    path: string;
    isTab: boolean;
  } | null>(null);

  // When files are opened, switch to editor. Desktop keeps the explorer docked.
  const handleOpenFile = useCallback(
    async (path: string) => {
      await store.openFile(path);
      setActivePanel("editor");
    },
    [store],
  );

  const handleCloseExplorer = useCallback(() => {
    if (!isDesktop) setExplorerOpen(false);
  }, [isDesktop]);

  const handleFilesTabClick = useCallback(() => {
    setActivePanel("files");
    setExplorerOpen(true);
  }, []);

  const handleGitTabClick = useCallback(() => {
    if (!gitEnabled) return;
    setActivePanel("git");
    setExplorerOpen(false);
  }, [gitEnabled]);

  const handleSelectFileTab = useCallback(
    (path: string) => {
      store.setActiveFilePath(path);
      setActivePanel("editor");
      setExplorerOpen(false);
    },
    [store],
  );

  const handleLongPressTab = useCallback((_path: string, _rect: DOMRect) => {
    setMenuState({ path: _path, isTab: true });
  }, []);

  const handleLongPressExplorer = useCallback((path: string, _rect: DOMRect) => {
    setMenuState({ path, isTab: false });
  }, []);

  const handleCopyPath = useCallback(() => {
    if (menuState) {
      navigator.clipboard.writeText(menuState.path).catch(() => {});
    }
  }, [menuState]);

  const handleMentionInChat = useCallback(() => {
    if (menuState) {
      // Dispatch event for ChatInput to pick up
      window.dispatchEvent(
        new CustomEvent("mention-file", { detail: { path: menuState.path } }),
      );
    }
  }, [menuState]);

  // If no project selected
  if (!projectPath) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm text-[#484f58]">
        Select a project to browse files
      </div>
    );
  }

  // Full-screen editor mode on mobile
  if (store.editing && store.activeFile && !isDesktop) {
    return (
      <FileViewer
        file={store.activeFile}
        editing={true}
        onContentChange={(c) => store.updateFileContent(store.activeFile!.path, c)}
        onSave={() => store.saveFile(store.activeFile!.path)}
        onStartEdit={() => store.setEditing(true)}
        onStopEdit={() => store.setEditing(false)}
      />
    );
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-[#0d1117] relative">
      {/* IDE nav bar — fixed to top */}
      <IdeNavBar
        openFiles={store.openFiles}
        activeFilePath={store.activeFilePath}
        onSelectFile={handleSelectFileTab}
        onCloseFile={store.closeFile}
        onFilesTabClick={handleFilesTabClick}
        onGitTabClick={handleGitTabClick}
        showGit={gitEnabled}
        activePanel={activePanel}
        gitStatus={store.gitStatus}
        onLongPressFile={handleLongPressTab}
      />

      {/* Main content area */}
      <div className="flex-1 flex overflow-hidden relative">
        {(isDesktop || explorerOpen) && (
          <FileExplorer
            treeByDir={store.treeByDir}
            expandedDirs={store.expandedDirs}
            selectedPath={store.selectedPath}
            gitFiles={store.gitStatus?.files || []}
            gitStatus={store.gitStatus}
            onOpenFile={handleOpenFile}
            onToggleDir={store.toggleDir}
            onSelectPath={store.selectPath}
            onRefreshAll={store.refreshAll}
            onCollapseAll={store.collapseAll}
            onCreateFile={store.createFile}
            onCreateDir={store.createDir}
            onClose={handleCloseExplorer}
            onLongPressFile={handleLongPressExplorer}
            onGitTabClick={gitEnabled ? handleGitTabClick : undefined}
            variant={isDesktop ? "docked" : "overlay"}
          />
        )}

        <div className="flex-1 min-w-0 flex flex-col overflow-hidden relative">
          {/* Git view */}
          {gitEnabled && activePanel === "git" && (
            <GitView
              status={store.gitStatus}
              projectPath={projectPath}
              onRefresh={store.fetchGitStatus}
              onOpenFile={handleOpenFile}
            />
          )}

          {/* Editor view */}
          {activePanel === "editor" && store.activeFile && (
            <FileViewer
              file={store.activeFile}
              editing={store.editing}
              onContentChange={(c) =>
                store.updateFileContent(store.activeFile!.path, c)
              }
              onSave={() => store.saveFile(store.activeFile!.path)}
              onStartEdit={() => store.setEditing(true)}
              onStopEdit={() => store.setEditing(false)}
            />
          )}

          {/* Empty state for editor when no file is open */}
          {activePanel === "editor" && !store.activeFile && (
            <div className="flex-1 flex items-center justify-center h-full text-sm text-[#484f58]">
              No file open
            </div>
          )}

          {/* Files panel placeholder (explorer is the overlay on mobile) */}
          {activePanel === "files" &&
            store.openFiles.length === 0 &&
            !explorerOpen &&
            !isDesktop && (
              <div className="flex-1 flex items-center justify-center h-full text-sm text-[#484f58]">
                <button
                  onClick={() => setExplorerOpen(true)}
                  className="text-[#58a6ff] hover:underline"
                >
                  Open file explorer
                </button>
              </div>
            )}

          {/* Files panel when there's an active file but we're on the files panel */}
          {activePanel === "files" && store.activeFile && (
            <FileViewer
              file={store.activeFile}
              editing={store.editing}
              onContentChange={(c) =>
                store.updateFileContent(store.activeFile!.path, c)
              }
              onSave={() => store.saveFile(store.activeFile!.path)}
              onStartEdit={() => store.setEditing(true)}
              onStopEdit={() => store.setEditing(false)}
            />
          )}
        </div>
      </div>

      {/* Tab context menu */}
      {menuState && (
        <FileTabMenu
          filePath={menuState.path}
          isTab={menuState.isTab}
          onClose={() => setMenuState(null)}
          onCopyPath={handleCopyPath}
          onMentionInChat={handleMentionInChat}
          onCloseOtherTabs={() => store.closeOtherFiles(menuState.path)}
          onCloseAllTabs={store.closeAllFiles}
        />
      )}
    </div>
  );
}
