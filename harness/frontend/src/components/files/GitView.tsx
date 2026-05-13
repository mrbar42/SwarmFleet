import { useState, useCallback, useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import type { GitStatus, GitStatusFile } from "./useFileStore";
import { useAppStore } from "../../stores/appStore";

interface GitViewProps {
  status: GitStatus | null;
  projectPath: string;
  onRefresh: () => void;
  onOpenFile: (path: string) => void;
}

const STATUS_COLORS: Record<string, string> = {
  M: "text-[#d29922]",
  A: "text-[#3fb950]",
  D: "text-[#f85149]",
  R: "text-[#a371f7]",
  "?": "text-[#8b949e]",
  U: "text-[#f85149]",
};

// ── Tree helpers ──

interface TreeNode {
  name: string;
  path: string;
  children: Map<string, TreeNode>;
  files: GitStatusFile[];
}

function buildTree(files: GitStatusFile[]): TreeNode {
  const root: TreeNode = { name: "", path: "", children: new Map(), files: [] };
  for (const f of files) {
    const parts = f.path.split("/");
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const dir = parts[i];
      if (!node.children.has(dir)) {
        const dirPath = parts.slice(0, i + 1).join("/");
        node.children.set(dir, { name: dir, path: dirPath, children: new Map(), files: [] });
      }
      node = node.children.get(dir)!;
    }
    node.files.push(f);
  }
  return root;
}

function countFiles(node: TreeNode): number {
  let count = node.files.length;
  for (const child of node.children.values()) count += countFiles(child);
  return count;
}

// ── Sub-components ──

function DirNode({
  node,
  depth,
  onOpenFile,
  onStage,
  onUnstage,
  onDiscard,
  loading,
}: {
  node: TreeNode;
  depth: number;
  onOpenFile: (path: string) => void;
  onStage: (path: string) => void;
  onUnstage: (path: string) => void;
  onDiscard: (path: string) => void;
  loading: string | null;
}) {
  const [expanded, setExpanded] = useState(depth < 2);

  const sortedDirs = useMemo(
    () => [...node.children.entries()].sort(([a], [b]) => a.localeCompare(b)),
    [node.children],
  );
  const sortedFiles = useMemo(
    () => [...node.files].sort((a, b) => a.path.localeCompare(b.path)),
    [node.files],
  );

  return (
    <>
      {node.name && (
        <button
          onClick={() => setExpanded(!expanded)}
          data-testid="git-directory"
          data-path={node.path}
          className="w-full flex items-center gap-1 px-2 py-1 text-xs text-[#8b949e] hover:bg-[#1c2129] hover:text-[#c9d1d9]"
          style={{ paddingLeft: `${depth * 12 + 8}px` }}
        >
          <svg
            viewBox="0 0 16 16"
            fill="currentColor"
            className={`w-3 h-3 shrink-0 transition-transform ${expanded ? "rotate-90" : ""}`}
          >
            <path d="M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06Z" />
          </svg>
          <span className="truncate font-medium">{node.name}</span>
          <span className="text-[10px] text-[#484f58] ml-1">{countFiles(node)}</span>
        </button>
      )}
      {(expanded || !node.name) && (
        <>
          {sortedDirs.map(([key, child]) => (
            <DirNode
              key={key}
              node={child}
              depth={node.name ? depth + 1 : depth}
              onOpenFile={onOpenFile}
              onStage={onStage}
              onUnstage={onUnstage}
              onDiscard={onDiscard}
              loading={loading}
            />
          ))}
          {sortedFiles.map((f) => {
            const fileName = f.path.split("/").pop() || f.path;
            return (
              <div
                key={f.path}
                data-testid="git-file"
                data-path={f.path}
                data-status={f.status}
                data-staged={f.staged ? "true" : "false"}
                className="flex items-center gap-1.5 py-1 text-xs hover:bg-[#1c2129] group"
                style={{ paddingLeft: `${(node.name ? depth + 1 : depth) * 12 + 8}px`, paddingRight: 8 }}
              >
                <span className={`font-bold shrink-0 w-3 text-center ${STATUS_COLORS[f.status] || ""}`}>
                  {f.status}
                </span>
                <button
                  onClick={() => onOpenFile(f.path)}
                  className="truncate flex-1 text-left text-[#c9d1d9]"
                  title={f.path}
                >
                  {fileName}
                </button>
                <div className="flex gap-1 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                  {f.staged ? (
                    <button
                      onClick={() => onUnstage(f.path)}
                      disabled={loading !== null}
                      className="text-[10px] px-1 text-[#8b949e] hover:text-[#c9d1d9]"
                      title="Unstage"
                    >
                      −
                    </button>
                  ) : (
                    <>
                      <button
                        onClick={() => onStage(f.path)}
                        disabled={loading !== null}
                        className="text-[10px] px-1 text-[#8b949e] hover:text-[#3fb950]"
                        title="Stage"
                      >
                        +
                      </button>
                      {f.status !== "?" && (
                        <button
                          onClick={() => onDiscard(f.path)}
                          disabled={loading !== null}
                          className="text-[10px] px-1 text-[#8b949e] hover:text-[#f85149]"
                          title="Discard changes"
                        >
                          ✕
                        </button>
                      )}
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </>
      )}
    </>
  );
}

function CommitDialog({
  onCommit,
  onClose,
  loading,
}: {
  onCommit: (msg: string) => void;
  onClose: () => void;
  loading: boolean;
}) {
  const [msg, setMsg] = useState("");

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="w-[90vw] max-w-md bg-[#161b22] border border-[#30363d] rounded-lg shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-[#30363d]">
          <h3 className="text-sm font-medium text-[#c9d1d9]">Commit Changes</h3>
        </div>
        <div className="p-4">
          <textarea
            value={msg}
            onChange={(e) => setMsg(e.target.value)}
            placeholder="Commit message..."
            rows={4}
            autoFocus
            className="w-full bg-[#0d1117] border border-[#30363d] rounded-md px-3 py-2 text-sm text-[#c9d1d9] placeholder-[#484f58] resize-none focus:outline-none focus:border-[#58a6ff]"
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && msg.trim()) {
                onCommit(msg.trim());
              }
            }}
          />
          <div className="text-[10px] text-[#484f58] mt-1">⌘+Enter to commit</div>
        </div>
        <div className="flex justify-end gap-2 px-4 py-3 border-t border-[#30363d]">
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded-md text-xs text-[#c9d1d9] hover:bg-[#21262d] border border-[#30363d]"
          >
            Cancel
          </button>
          <button
            onClick={() => msg.trim() && onCommit(msg.trim())}
            disabled={!msg.trim() || loading}
            className="px-3 py-1.5 rounded-md bg-[#238636] hover:bg-[#2ea043] text-white text-xs font-medium disabled:opacity-50 transition-colors"
          >
            {loading ? "Committing..." : "Commit"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main component ──

const AGENT_COMMIT_PROMPT = `Review the current git changes. Before committing:
1. Check if .gitignore exists and covers common patterns (node_modules, .env, build artifacts, OS files). If not, create or update it.
2. Review the staged/unstaged files for any sensitive or problematic files (credentials, secrets, large binaries, temp files). If found, add them to .gitignore and unstage them.
3. Stage all appropriate changes and commit them in one or multiple logical commits as you see fit. Use Conventional Commits format for every commit message, for example: feat: add initial project files.

Do NOT push. Only commit locally.`;

export function GitView({ status, projectPath, onRefresh, onOpenFile }: GitViewProps) {
  const navigate = useNavigate();
  const currentProject = useAppStore((state) => state.currentProject);
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hasRemote, setHasRemote] = useState<boolean | null>(null);
  const [showCommitDialog, setShowCommitDialog] = useState(false);
  const [agentWorking, setAgentWorking] = useState(false);

  // Check for remote
  useEffect(() => {
    if (!projectPath) return;
    fetch(`/api/git/remotes?project=${encodeURIComponent(projectPath)}`)
      .then((r) => r.json())
      .then((d) => setHasRemote(d.hasRemote ?? false))
      .catch(() => setHasRemote(false));
  }, [projectPath]);

  const gitAction = useCallback(
    async (action: string, extra?: Record<string, unknown>) => {
      setLoading(action);
      setError(null);
      try {
        const res = await fetch("/api/git/action", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ project: projectPath, action, ...extra }),
        });
        const data = await res.json();
        if (data.error) setError(data.error);
        onRefresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Action failed");
      } finally {
        setLoading(null);
      }
    },
    [projectPath, onRefresh],
  );

  const handleManualCommit = useCallback(
    async (msg: string) => {
      // Stage all first, then commit
      await gitAction("stage-all");
      await gitAction("commit", { message: msg });
      setShowCommitDialog(false);
    },
    [gitAction],
  );

  const handleAgentCommit = useCallback(async () => {
    if (!currentProject?.name) {
      setError("No project selected");
      return;
    }

    setAgentWorking(true);
    setError(null);
    try {
      navigate(`/chat/${encodeURIComponent(currentProject.name)}`);
      window.setTimeout(() => {
        window.dispatchEvent(
          new CustomEvent("send-chat-message", {
            detail: { message: AGENT_COMMIT_PROMPT },
          }),
        );
      }, 0);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Agent commit failed");
      setAgentWorking(false);
    } finally {
      window.setTimeout(() => {
        onRefresh();
      }, 1000);
    }
  }, [currentProject?.name, navigate, onRefresh]);

  const handleStage = useCallback((path: string) => gitAction("stage", { files: [path] }), [gitAction]);
  const handleUnstage = useCallback((path: string) => gitAction("unstage", { files: [path] }), [gitAction]);
  const handleDiscard = useCallback((path: string) => gitAction("discard", { files: [path] }), [gitAction]);

  if (!status) {
    return (
      <div data-testid="git-loading" className="flex-1 flex items-center justify-center text-sm text-[#484f58]">
        Loading git status...
      </div>
    );
  }

  const stagedFiles = status.files.filter((f) => f.staged);
  const unstagedFiles = status.files.filter((f) => !f.staged);
  const allChanges = status.files.length + status.conflictFiles.length;
  const stagedTree = buildTree(stagedFiles);
  const unstagedTree = buildTree(unstagedFiles);

  return (
    <div data-testid="git-view" className="flex-1 flex flex-col overflow-hidden bg-[#0d1117]">
      {/* Branch bar */}
      <div data-testid="git-branch-bar" className="flex items-center gap-2 px-3 py-2 border-b border-[#30363d] bg-[#161b22]">
        <svg viewBox="0 0 16 16" fill="#8b949e" className="w-4 h-4 shrink-0">
          <path d="M5.45 5.154A4.25 4.25 0 0 0 9.25 7.5h1.378a2.251 2.251 0 1 1 0 1.5H9.25A5.734 5.734 0 0 1 5 7.123v3.505a2.25 2.25 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.95-.218Z" />
        </svg>
        <span className="text-sm text-[#c9d1d9] font-medium">{status.branch}</span>
        {status.ahead > 0 && (
          <span className="text-[10px] text-[#3fb950]">&uarr;{status.ahead}</span>
        )}
        {status.behind > 0 && (
          <span className="text-[10px] text-[#f85149]">&darr;{status.behind}</span>
        )}
        <div className="flex-1" />
        <button
          onClick={onRefresh}
          data-testid="git-refresh"
          className="text-[#8b949e] hover:text-[#c9d1d9] p-1"
          title="Refresh"
        >
          <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
            <path d="M8 2.5a5.487 5.487 0 0 0-4.131 1.869l1.204 1.204A.25.25 0 0 1 4.896 6H1.25A.25.25 0 0 1 1 5.75V2.104a.25.25 0 0 1 .427-.177l1.38 1.38A7.002 7.002 0 0 1 14.95 7.16a.75.75 0 0 1-1.49.178A5.5 5.5 0 0 0 8 2.5ZM1.705 8.005a.75.75 0 0 1 .834.656 5.5 5.5 0 0 0 9.592 2.97l-1.204-1.204a.25.25 0 0 1 .177-.427h3.646a.25.25 0 0 1 .25.25v3.646a.25.25 0 0 1-.427.177l-1.38-1.38A7.002 7.002 0 0 1 1.05 8.84a.75.75 0 0 1 .656-.834Z" />
          </svg>
        </button>
      </div>

      {/* Action buttons */}
      <div className="flex items-center gap-1.5 px-3 py-2 border-b border-[#30363d] bg-[#161b22]">
        {hasRemote && (
          <button
            onClick={() => gitAction("pull")}
            data-testid="git-pull"
            disabled={loading !== null || agentWorking}
            className="flex items-center gap-1 px-2.5 py-1 rounded-md text-xs text-[#c9d1d9] bg-[#21262d] hover:bg-[#30363d] border border-[#30363d] disabled:opacity-50 transition-colors"
          >
            <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3">
              <path d="M7.47 10.78a.749.749 0 0 0 1.06 0l3.75-3.75a.749.749 0 1 0-1.06-1.06L8.75 8.44V1.75a.75.75 0 0 0-1.5 0v6.69L4.78 5.97a.749.749 0 1 0-1.06 1.06l3.75 3.75ZM3.75 13a.75.75 0 0 0 0 1.5h8.5a.75.75 0 0 0 0-1.5h-8.5Z" />
            </svg>
            {loading === "pull" ? "Pulling..." : "Pull"}
          </button>
        )}
        {hasRemote && status.ahead > 0 && (
          <button
            onClick={() => gitAction("push")}
            data-testid="git-push"
            disabled={loading !== null || agentWorking}
            className="flex items-center gap-1 px-2.5 py-1 rounded-md text-xs text-white bg-[#1f6feb] hover:bg-[#388bfd] disabled:opacity-50 transition-colors"
          >
            <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3">
              <path d="M4.53 4.75a.749.749 0 0 1-.06-1.06l3.25-3.5a.749.749 0 0 1 1.06-.02l3.5 3.5a.749.749 0 1 1-1.06 1.06L8.75 2.28v6.97a.75.75 0 0 1-1.5 0V2.28L4.78 4.78a.749.749 0 0 1-1.06-.02l.81-.01ZM3.75 13a.75.75 0 0 0 0 1.5h8.5a.75.75 0 0 0 0-1.5h-8.5Z" />
            </svg>
            Push ({status.ahead})
          </button>
        )}
        <div className="flex-1" />
        <button
          onClick={handleAgentCommit}
          data-testid="agent-commit"
          disabled={allChanges === 0 || loading !== null || agentWorking}
          className="flex items-center gap-1 px-2.5 py-1 rounded-md text-xs text-[#c9d1d9] bg-[#21262d] hover:bg-[#30363d] border border-[#30363d] disabled:opacity-50 transition-colors"
          title="Let the agent review and commit changes intelligently"
        >
          <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3">
            <path d="M9.504.43a1.516 1.516 0 0 1 2.437 1.713L10.415 5.5h2.123c1.57 0 2.346 1.909 1.22 3.004l-7.34 7.142a1.249 1.249 0 0 1-.871.354h-.302a1.25 1.25 0 0 1-1.157-1.723L5.633 10.5H3.462c-1.57 0-2.346-1.909-1.22-3.004L9.504.43Z" />
          </svg>
          {agentWorking ? "Agent working..." : "Agent Commit"}
        </button>
        <button
          onClick={() => setShowCommitDialog(true)}
          data-testid="git-commit"
          disabled={allChanges === 0 || loading !== null || agentWorking}
          className="flex items-center gap-1 px-2.5 py-1 rounded-md text-xs text-white bg-[#238636] hover:bg-[#2ea043] disabled:opacity-50 transition-colors"
        >
          <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3">
            <path d="M11.93 8.5a4.002 4.002 0 0 1-7.86 0H.75a.75.75 0 0 1 0-1.5h3.32a4.002 4.002 0 0 1 7.86 0h3.32a.75.75 0 0 1 0 1.5Zm-1.43-.75a2.5 2.5 0 1 0-5 0 2.5 2.5 0 0 0 5 0Z" />
          </svg>
          Commit
        </button>
      </div>

      {/* File tree */}
      <div className="flex-1 overflow-y-auto">
        {/* Conflicts */}
        {status.hasConflicts && (
          <div data-testid="git-conflicts" className="border-b border-[#30363d]">
            <div className="flex items-center gap-2 px-3 py-2 bg-[#f8514920]">
              <span className="text-xs font-medium text-[#f85149]">
                Conflicts ({status.conflictFiles.length})
              </span>
              <div className="flex-1" />
              <button
                onClick={() => gitAction("resolve-accept-theirs", { files: status.conflictFiles })}
                disabled={loading !== null}
                className="text-[10px] px-2 py-0.5 rounded bg-[#21262d] text-[#8b949e] hover:text-[#c9d1d9] border border-[#30363d]"
              >
                Accept theirs
              </button>
              <button
                onClick={() => gitAction("resolve-accept-ours", { files: status.conflictFiles })}
                disabled={loading !== null}
                className="text-[10px] px-2 py-0.5 rounded bg-[#21262d] text-[#8b949e] hover:text-[#c9d1d9] border border-[#30363d]"
              >
                Accept ours
              </button>
            </div>
            {status.conflictFiles.map((f) => (
              <button
                key={f}
                onClick={() => onOpenFile(f)}
                className="w-full text-left px-3 py-1.5 flex items-center gap-2 text-xs text-[#f85149] hover:bg-[#1c2129]"
              >
                <span className="font-bold w-3 text-center">U</span>
                <span className="truncate">{f.split("/").pop()}</span>
              </button>
            ))}
          </div>
        )}

        {/* Staged */}
        {stagedFiles.length > 0 && (
          <div data-testid="git-staged-section" className="border-b border-[#30363d]">
            <div className="flex items-center gap-2 px-3 py-2 bg-[#161b22]">
              <span className="text-xs font-medium text-[#3fb950]">
                Staged ({stagedFiles.length})
              </span>
              <div className="flex-1" />
              <button
                onClick={() => gitAction("unstage-all")}
                data-testid="git-unstage-all"
                disabled={loading !== null}
                className="text-[10px] px-2 py-0.5 rounded bg-[#21262d] text-[#8b949e] hover:text-[#c9d1d9] border border-[#30363d]"
              >
                Unstage all
              </button>
            </div>
            <DirNode
              node={stagedTree}
              depth={0}
              onOpenFile={onOpenFile}
              onStage={handleStage}
              onUnstage={handleUnstage}
              onDiscard={handleDiscard}
              loading={loading}
            />
          </div>
        )}

        {/* Unstaged */}
        {unstagedFiles.length > 0 && (
          <div data-testid="git-unstaged-section" className="border-b border-[#30363d]">
            <div className="flex items-center gap-2 px-3 py-2 bg-[#161b22]">
              <span className="text-xs font-medium text-[#d29922]">
                Changes ({unstagedFiles.length})
              </span>
              <div className="flex-1" />
              <button
                onClick={() => gitAction("stage-all")}
                data-testid="git-stage-all"
                disabled={loading !== null}
                className="text-[10px] px-2 py-0.5 rounded bg-[#21262d] text-[#8b949e] hover:text-[#c9d1d9] border border-[#30363d]"
              >
                Stage all
              </button>
            </div>
            <DirNode
              node={unstagedTree}
              depth={0}
              onOpenFile={onOpenFile}
              onStage={handleStage}
              onUnstage={handleUnstage}
              onDiscard={handleDiscard}
              loading={loading}
            />
          </div>
        )}

        {allChanges === 0 && (
          <div className="flex items-center justify-center py-12 text-sm text-[#484f58]">
            Working tree clean
          </div>
        )}
      </div>

      {/* Error */}
      {error && (
        <div className="px-3 py-2 bg-[#f8514920] text-xs text-[#f85149] border-t border-[#30363d]">
          {error}
        </div>
      )}

      {/* Commit dialog */}
      {showCommitDialog && (
        <CommitDialog
          onCommit={handleManualCommit}
          onClose={() => setShowCommitDialog(false)}
          loading={loading === "commit"}
        />
      )}
    </div>
  );
}
