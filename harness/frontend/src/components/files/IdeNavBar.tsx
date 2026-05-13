import { useRef, useEffect, useState, useCallback } from "react";
import type { OpenFile, GitStatus } from "./useFileStore";

interface IdeNavBarProps {
  openFiles: OpenFile[];
  activeFilePath: string | null;
  onSelectFile: (path: string) => void;
  onCloseFile: (path: string) => void;
  onFilesTabClick: () => void;
  onGitTabClick: () => void;
  showGit: boolean;
  activePanel: "files" | "git" | "editor";
  gitStatus: GitStatus | null;
  onLongPressFile: (path: string, rect: DOMRect) => void;
}

export function IdeNavBar({
  openFiles,
  activeFilePath,
  onSelectFile,
  onCloseFile,
  onFilesTabClick,
  onGitTabClick,
  showGit,
  activePanel,
  gitStatus,
  onLongPressFile,
}: IdeNavBarProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [pressedPath, setPressedPath] = useState<string | null>(null);

  // Scroll active tab into view
  useEffect(() => {
    if (!activeFilePath || !scrollRef.current) return;
    const el = scrollRef.current.querySelector(`[data-path="${CSS.escape(activeFilePath)}"]`);
    el?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
  }, [activeFilePath]);

  const handlePointerDown = useCallback(
    (path: string, e: React.PointerEvent) => {
      setPressedPath(path);
      const target = e.currentTarget as HTMLElement;
      longPressTimer.current = setTimeout(() => {
        const rect = target.getBoundingClientRect();
        onLongPressFile(path, rect);
        setPressedPath(null);
      }, 500);
    },
    [onLongPressFile],
  );

  const handlePointerUp = useCallback(() => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
    setPressedPath(null);
  }, []);

  const changedCount = gitStatus
    ? gitStatus.files.length + gitStatus.conflictFiles.length
    : 0;

  return (
    <div className="flex items-stretch h-9 bg-[#161b22] border-t border-[#30363d] overflow-hidden shrink-0">
      {/* Fixed: Files tab */}
      <button
        onClick={onFilesTabClick}
        data-testid="files-panel-tab"
        className={`shrink-0 px-3 flex items-center gap-1.5 text-xs font-medium border-r border-[#30363d] transition-colors ${
          activePanel === "files"
            ? "text-[#58a6ff] bg-[#0d1117]"
            : "text-[#8b949e] hover:text-[#c9d1d9]"
        }`}
      >
        <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
          <path d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75Z" />
        </svg>
        Files
      </button>

      {/* Fixed: Git tab */}
      {showGit && (
        <button
          onClick={onGitTabClick}
          data-testid="git-panel-tab"
          className={`shrink-0 px-3 flex items-center gap-1.5 text-xs font-medium border-r border-[#30363d] transition-colors ${
            activePanel === "git"
              ? "text-[#58a6ff] bg-[#0d1117]"
              : "text-[#8b949e] hover:text-[#c9d1d9]"
          }`}
        >
          <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
            <path d="M5.45 5.154A4.25 4.25 0 0 0 9.25 7.5h1.378a2.251 2.251 0 1 1 0 1.5H9.25A5.734 5.734 0 0 1 5 7.123v3.505a2.25 2.25 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.95-.218ZM4.25 13.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm8-9a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5ZM4.25 5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Z" />
          </svg>
          Git
          {changedCount > 0 && (
            <span className="bg-[#30363d] text-[#c9d1d9] rounded-full text-[10px] px-1.5 min-w-[18px] text-center">
              {changedCount}
            </span>
          )}
        </button>
      )}

      {/* Scrollable file tabs */}
      <div
        ref={scrollRef}
        className="flex-1 flex items-stretch overflow-x-auto scrollbar-hide"
        style={{ scrollbarWidth: "none" }}
      >
        {openFiles.map((file) => {
          const isActive = file.path === activeFilePath;
          return (
            <button
              key={file.path}
              data-path={file.path}
              data-testid="file-tab"
              onClick={() => onSelectFile(file.path)}
              onPointerDown={(e) => handlePointerDown(file.path, e)}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerUp}
              className={`shrink-0 min-w-[100px] max-w-[180px] px-3 flex items-center gap-1.5 text-xs transition-colors select-none ${
                isActive
                  ? "text-[#c9d1d9] bg-[#0d1117] border-b-2 border-b-[#58a6ff]"
                  : pressedPath === file.path
                    ? "text-[#c9d1d9] bg-[#1c2129]"
                    : "text-[#8b949e] hover:text-[#c9d1d9] border-b-2 border-b-transparent"
              }`}
            >
              {file.dirty && (
                <span className="w-2 h-2 rounded-full bg-[#d29922] shrink-0" />
              )}
              <span className="truncate flex-1">{file.name}</span>
              {isActive && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onCloseFile(file.path);
                  }}
                  className="shrink-0 min-w-[28px] min-h-[28px] flex items-center justify-center rounded hover:bg-[#30363d] text-[#8b949e] hover:text-[#c9d1d9]"
                  aria-label="Close file"
                >
                  &times;
                </button>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
