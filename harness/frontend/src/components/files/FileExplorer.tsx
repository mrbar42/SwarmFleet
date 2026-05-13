import { useState, useCallback, useRef, useEffect } from "react";
import type { TreeEntry, GitStatusFile, GitStatus } from "./useFileStore";

interface FileExplorerProps {
  treeByDir: Record<string, TreeEntry[]>;
  expandedDirs: Set<string>;
  selectedPath: string | null;
  gitFiles: GitStatusFile[];
  gitStatus?: GitStatus | null;
  onOpenFile: (path: string) => void;
  onToggleDir: (path: string) => void;
  onSelectPath: (path: string | null) => void;
  onRefreshAll: () => void;
  onCollapseAll: () => void;
  onCreateFile: (parentDir: string, name: string) => Promise<{ ok: boolean; error?: string }>;
  onCreateDir: (parentDir: string, name: string) => Promise<{ ok: boolean; error?: string }>;
  onClose: () => void;
  onLongPressFile: (path: string, rect: DOMRect) => void;
  onGitTabClick?: () => void;
  variant?: "overlay" | "docked";
}

const STATUS_COLORS: Record<string, string> = {
  M: "text-[#d29922]",
  A: "text-[#3fb950]",
  D: "text-[#f85149]",
  "?": "text-[#8b949e]",
  U: "text-[#f85149]",
};

function StatusBadge({ path, gitFiles }: { path: string; gitFiles: GitStatusFile[] }) {
  const match = gitFiles.find((f) => f.path === path || path.endsWith(f.path));
  if (!match) return null;
  return (
    <span className={`text-[10px] font-bold shrink-0 ${STATUS_COLORS[match.status] || "text-[#8b949e]"}`}>
      {match.status}
    </span>
  );
}

function findEntry(
  treeByDir: Record<string, TreeEntry[]>,
  path: string,
): TreeEntry | null {
  for (const entries of Object.values(treeByDir)) {
    for (const e of entries) {
      if (e.path === path) return e;
    }
  }
  return null;
}

export function FileExplorer({
  treeByDir,
  expandedDirs,
  selectedPath,
  gitFiles,
  gitStatus,
  onOpenFile,
  onToggleDir,
  onSelectPath,
  onRefreshAll,
  onCollapseAll,
  onCreateFile,
  onCreateDir,
  onClose,
  onLongPressFile,
  onGitTabClick,
  variant = "overlay",
}: FileExplorerProps) {
  const [search, setSearch] = useState("");
  const [searchResults, setSearchResults] = useState<Array<{ name: string; path: string }> | null>(null);
  const [searching, setSearching] = useState(false);
  const [pendingCreate, setPendingCreate] = useState<{
    parentDir: string;
    kind: "file" | "dir";
  } | null>(null);
  const [pendingName, setPendingName] = useState("");
  const pendingInputRef = useRef<HTMLInputElement | null>(null);

  const handleSearch = useCallback(async (q: string) => {
    setSearch(q);
    if (q.length < 2) {
      setSearchResults(null);
      return;
    }
    setSearching(true);
    try {
      const res = await fetch(`/api/files/search?q=${encodeURIComponent(q)}`);
      const data = await res.json();
      setSearchResults(data.results || []);
    } catch {
      setSearchResults([]);
    } finally {
      setSearching(false);
    }
  }, []);

  const handleFileClick = (path: string) => {
    onOpenFile(path);
    onClose();
  };

  // Autofocus pending input
  useEffect(() => {
    if (pendingCreate && pendingInputRef.current) {
      pendingInputRef.current.focus();
    }
  }, [pendingCreate]);

  const startCreate = useCallback(
    (kind: "file" | "dir") => {
      let parentDir = ".";
      if (selectedPath) {
        const entry = findEntry(treeByDir, selectedPath);
        if (entry && entry.type === "directory") {
          parentDir = selectedPath;
        } else if (entry && entry.type === "file") {
          parentDir = selectedPath.includes("/")
            ? selectedPath.slice(0, selectedPath.lastIndexOf("/"))
            : ".";
        }
      }
      // Ensure parentDir is expanded (unless it's root)
      if (parentDir !== "." && !expandedDirs.has(parentDir)) {
        onToggleDir(parentDir);
      }
      setPendingCreate({ parentDir, kind });
      setPendingName("");
    },
    [selectedPath, treeByDir, expandedDirs, onToggleDir],
  );

  const commitPending = useCallback(async () => {
    if (!pendingCreate) return;
    const name = pendingName.trim();
    if (!name) {
      setPendingCreate(null);
      return;
    }
    const result =
      pendingCreate.kind === "file"
        ? await onCreateFile(pendingCreate.parentDir, name)
        : await onCreateDir(pendingCreate.parentDir, name);
    if (result.ok) {
      setPendingCreate(null);
      setPendingName("");
    }
    // On failure, leave input open for retry
  }, [pendingCreate, pendingName, onCreateFile, onCreateDir]);

  const cancelPending = useCallback(() => {
    setPendingCreate(null);
    setPendingName("");
  }, []);

  const handlePendingKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commitPending();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelPending();
    }
  };

  const handlePendingBlur = () => {
    // On blur: only cancel if name is empty. Use small delay so button clicks register.
    setTimeout(() => {
      if (pendingName.trim() === "") {
        setPendingCreate(null);
      }
    }, 120);
  };

  const renderPendingInput = (depth: number) => {
    if (!pendingCreate) return null;
    return (
      <div
        key="__pending__"
        style={{ paddingLeft: `${depth * 12 + 12}px` }}
        className="flex items-center gap-2 py-1 pr-2"
        data-testid="file-create-input-row"
      >
        {pendingCreate.kind === "dir" ? (
          <svg viewBox="0 0 16 16" fill="#8b949e" className="w-3.5 h-3.5 shrink-0">
            <path d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75Z" />
          </svg>
        ) : (
          <svg viewBox="0 0 16 16" fill="#8b949e" className="w-3.5 h-3.5 shrink-0">
            <path d="M3.75 1.5a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25h8.5a.25.25 0 0 0 .25-.25V6H9.75A1.75 1.75 0 0 1 8 4.25V1.5H3.75ZM10 1.5v2.75c0 .138.112.25.25.25h2.75L10 1.5Z" />
          </svg>
        )}
        <input
          ref={pendingInputRef}
          type="text"
          value={pendingName}
          onChange={(e) => setPendingName(e.target.value)}
          onKeyDown={handlePendingKeyDown}
          onBlur={handlePendingBlur}
          data-testid="file-create-input"
          placeholder={pendingCreate.kind === "file" ? "filename" : "dirname"}
          className="flex-1 min-w-0 bg-[#161b22] border border-[#58a6ff] rounded px-1.5 py-0.5 text-xs text-[#c9d1d9] focus:outline-none"
        />
      </div>
    );
  };

  const renderEntry = (entry: TreeEntry, depth: number): React.ReactNode => {
    const isDir = entry.type === "directory";
    const isExpanded = isDir && expandedDirs.has(entry.path);
    const isSelected = selectedPath === entry.path;
    const children = isExpanded ? treeByDir[entry.path] ?? null : null;

    const onClick = () => {
      onSelectPath(entry.path);
      if (isDir) {
        onToggleDir(entry.path);
      } else {
        handleFileClick(entry.path);
      }
    };

    return (
      <div key={entry.path}>
        <button
          onClick={onClick}
          data-testid="file-entry"
          data-path={entry.path}
          data-entry-type={entry.type}
          onContextMenu={(e) => {
            e.preventDefault();
            const rect = (e.target as HTMLElement).getBoundingClientRect();
            onLongPressFile(entry.path, rect);
          }}
          style={{ paddingLeft: `${depth * 12 + 12}px` }}
          className={`w-full text-left pr-3 py-1 flex items-center gap-1.5 text-xs text-[#c9d1d9] transition-colors ${
            isSelected ? "bg-[#1c2129]" : "hover:bg-[#1c2129]"
          }`}
        >
          {isDir ? (
            <span className="w-3 text-[10px] text-[#8b949e] shrink-0 inline-flex justify-center">
              {isExpanded ? "▼" : "▶"}
            </span>
          ) : (
            <span className="w-3 shrink-0" />
          )}
          {isDir ? (
            <svg viewBox="0 0 16 16" fill="#8b949e" className="w-3.5 h-3.5 shrink-0">
              <path d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75Z" />
            </svg>
          ) : (
            <svg viewBox="0 0 16 16" fill="#8b949e" className="w-3.5 h-3.5 shrink-0">
              <path d="M3.75 1.5a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25h8.5a.25.25 0 0 0 .25-.25V6H9.75A1.75 1.75 0 0 1 8 4.25V1.5H3.75ZM10 1.5v2.75c0 .138.112.25.25.25h2.75L10 1.5Z" />
            </svg>
          )}
          <span className="truncate flex-1">{entry.name}</span>
          <StatusBadge path={entry.path} gitFiles={gitFiles} />
          {entry.size !== undefined && entry.type === "file" && (
            <span className="text-[10px] text-[#484f58] shrink-0">
              {entry.size > 1024 * 1024
                ? `${(entry.size / (1024 * 1024)).toFixed(1)}M`
                : entry.size > 1024
                  ? `${(entry.size / 1024).toFixed(1)}K`
                  : `${entry.size}B`}
            </span>
          )}
        </button>
        {isDir && isExpanded && (
          <>
            {pendingCreate && pendingCreate.parentDir === entry.path &&
              renderPendingInput(depth + 1)}
            {children && children.map((child) => renderEntry(child, depth + 1))}
          </>
        )}
      </div>
    );
  };

  const rootEntries = treeByDir["."] ?? [];
  const showSearchResults = searchResults !== null && searchResults.length > 0;
  const inSearchMode = searchResults !== null;

  return (
    <div
      data-testid="file-explorer"
      data-variant={variant}
      className={
        variant === "docked"
          ? "shrink-0 flex h-full"
          : "absolute inset-0 z-20 flex"
      }
    >
      {/* Explorer panel */}
      <div className="w-72 max-w-[85vw] bg-[#0d1117] border-r border-[#30363d] flex flex-col h-full">
        {/* Search */}
        <div className="p-2 border-b border-[#30363d]">
          <div className="relative">
            <svg
              viewBox="0 0 16 16"
              fill="#484f58"
              className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2"
            >
              <path d="M11.5 7a4.499 4.499 0 1 1-8.998 0A4.499 4.499 0 0 1 11.5 7Zm-.82 4.74a6 6 0 1 1 1.06-1.06l3.04 3.04a.75.75 0 1 1-1.06 1.06l-3.04-3.04Z" />
            </svg>
            <input
              type="text"
              value={search}
              onChange={(e) => handleSearch(e.target.value)}
              data-testid="file-search"
              placeholder="Search files..."
              className="w-full bg-[#161b22] border border-[#30363d] rounded-md pl-8 pr-2 py-1.5 text-xs text-[#c9d1d9] placeholder-[#484f58] focus:outline-none focus:border-[#58a6ff]"
            />
          </div>
        </div>

        {/* Controls row */}
        {!inSearchMode && (
          <div className="flex items-center gap-1 px-2 py-1 border-b border-[#21262d] bg-[#0d1117]">
            <button
              onClick={() => startCreate("file")}
              data-testid="file-ctrl-new-file"
              title="New file"
              className="p-1 rounded text-[#c9d1d9] hover:bg-[#1c2129] transition-colors"
            >
              <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                <path d="M2 1.75C2 .784 2.784 0 3.75 0h6.586c.464 0 .909.184 1.237.513l2.914 2.914c.329.328.513.773.513 1.237v9.586A1.75 1.75 0 0 1 13.25 16h-9.5A1.75 1.75 0 0 1 2 14.25V1.75Zm1.75-.25a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25h9.5a.25.25 0 0 0 .25-.25V6h-2.75A1.75 1.75 0 0 1 9 4.25V1.5H3.75ZM10.5 1.5v2.75c0 .138.112.25.25.25h2.438l-.177-.177a.25.25 0 0 0-.177-.073H10.5ZM8 7a.75.75 0 0 1 .75.75v1.5h1.5a.75.75 0 0 1 0 1.5h-1.5v1.5a.75.75 0 0 1-1.5 0v-1.5h-1.5a.75.75 0 0 1 0-1.5h1.5v-1.5A.75.75 0 0 1 8 7Z" />
              </svg>
            </button>
            <button
              onClick={() => startCreate("dir")}
              data-testid="file-ctrl-new-dir"
              title="New folder"
              className="p-1 rounded text-[#c9d1d9] hover:bg-[#1c2129] transition-colors"
            >
              <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                <path d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75ZM8 7a.5.5 0 0 1 .5.5V9h1.5a.5.5 0 0 1 0 1H8.5v1.5a.5.5 0 0 1-1 0V10H6a.5.5 0 0 1 0-1h1.5V7.5A.5.5 0 0 1 8 7Z" />
              </svg>
            </button>
            <button
              onClick={() => onRefreshAll()}
              data-testid="file-ctrl-refresh"
              title="Refresh"
              className="p-1 rounded text-[#c9d1d9] hover:bg-[#1c2129] transition-colors"
            >
              <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                <path d="M1.705 8.005a.75.75 0 0 1 .834.656 5.5 5.5 0 0 0 9.592 2.97l-1.204-1.204a.25.25 0 0 1 .177-.427h3.646a.25.25 0 0 1 .25.25v3.646a.25.25 0 0 1-.427.177l-1.38-1.38A7 7 0 0 1 1.05 8.84a.75.75 0 0 1 .656-.834ZM8 2.5a5.487 5.487 0 0 0-4.131 1.869l1.204 1.204A.25.25 0 0 1 4.896 6H1.25A.25.25 0 0 1 1 5.75V2.104a.25.25 0 0 1 .427-.177l1.38 1.38A7 7 0 0 1 14.95 7.16a.75.75 0 0 1-1.49.178A5.5 5.5 0 0 0 8 2.5Z" />
              </svg>
            </button>
            <button
              onClick={() => onCollapseAll()}
              data-testid="file-ctrl-collapse"
              title="Collapse all"
              className="p-1 rounded text-[#c9d1d9] hover:bg-[#1c2129] transition-colors"
            >
              <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                <path d="M2 3.75A.75.75 0 0 1 2.75 3h10.5a.75.75 0 0 1 0 1.5H2.75A.75.75 0 0 1 2 3.75Zm2 4A.75.75 0 0 1 4.75 7h6.5a.75.75 0 0 1 0 1.5h-6.5A.75.75 0 0 1 4 7.75Zm2 4a.75.75 0 0 1 .75-.75h2.5a.75.75 0 0 1 0 1.5h-2.5a.75.75 0 0 1-.75-.75Z" />
              </svg>
            </button>
          </div>
        )}

        {/* File list */}
        <div className="flex-1 overflow-y-auto">
          {searching && (
            <div className="px-3 py-4 text-xs text-[#8b949e] text-center">Searching...</div>
          )}

          {showSearchResults &&
            searchResults!.map((r) => (
              <button
                key={r.path}
                onClick={() => handleFileClick(r.path)}
                data-testid="file-search-result"
                data-path={r.path}
                className="w-full text-left px-3 py-1.5 flex items-center gap-2 text-xs text-[#c9d1d9] hover:bg-[#1c2129] transition-colors"
              >
                <svg viewBox="0 0 16 16" fill="#8b949e" className="w-3.5 h-3.5 shrink-0">
                  <path d="M3.75 1.5a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25h8.5a.25.25 0 0 0 .25-.25V6H9.75A1.75 1.75 0 0 1 8 4.25V1.5H3.75ZM10 1.5v2.75c0 .138.112.25.25.25h2.75L10 1.5Z" />
                </svg>
                <div className="min-w-0">
                  <div className="truncate">{r.name}</div>
                  <div className="text-[10px] text-[#484f58] truncate">{r.path}</div>
                </div>
              </button>
            ))}

          {searchResults !== null && searchResults.length === 0 && !searching && (
            <div className="px-3 py-4 text-xs text-[#484f58] text-center">No results</div>
          )}

          {!inSearchMode && !searching && (
            <>
              {pendingCreate && pendingCreate.parentDir === "." && renderPendingInput(0)}
              {rootEntries.map((entry) => renderEntry(entry, 0))}
            </>
          )}
        </div>

        {/* Git status bar */}
        {gitStatus && (
          <div
            data-testid="file-git-summary"
            className="flex items-center gap-3 px-3 h-7 bg-[#161b22] border-t border-[#21262d] shrink-0"
          >
            <span className="text-[10px] text-[#8b949e]">{gitStatus.branch}</span>
            {gitStatus.files.filter((f) => f.status === "M").length > 0 && (
              <span className="text-[10px] text-[#d29922]">
                {gitStatus.files.filter((f) => f.status === "M").length}M
              </span>
            )}
            {gitStatus.files.filter((f) => f.status === "?" || f.status === "A").length > 0 && (
              <span className="text-[10px] text-[#3fb950]">
                {gitStatus.files.filter((f) => f.status === "?" || f.status === "A").length}A
              </span>
            )}
            {gitStatus.files.filter((f) => f.status === "D").length > 0 && (
              <span className="text-[10px] text-[#f85149]">
                {gitStatus.files.filter((f) => f.status === "D").length}D
              </span>
            )}
            {gitStatus.hasConflicts && (
              <button
                onClick={onGitTabClick}
                className="text-[10px] px-1.5 py-0.5 rounded bg-[#da3633] text-white font-medium"
              >
                {gitStatus.conflictFiles.length} conflict{gitStatus.conflictFiles.length !== 1 ? "s" : ""}
              </button>
            )}
          </div>
        )}
      </div>

      {/* Backdrop */}
      {variant === "overlay" && (
        <div className="flex-1 bg-black/50" onClick={onClose} />
      )}
    </div>
  );
}
