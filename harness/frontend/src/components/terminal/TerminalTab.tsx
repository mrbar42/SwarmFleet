import { useState, useCallback, useRef, useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import type { TerminalHistoryEntry } from "../../types";

interface TerminalSession {
  id: string;
  name: string;
  createdAt: string;
  cwd?: string;
  alive: boolean;
}

interface TerminalTabProps {
  projectPath: string | null;
  isVisible?: boolean;
}

/** Format a history entry for display in the dead-session view */
function formatHistoryEntry(entry: TerminalHistoryEntry): string | null {
  if (entry.type === "command" && entry.input) {
    const time = new Date(entry.ts).toLocaleTimeString();
    const cmd = entry.input.replace(/\n$/, "");
    return `[${time}] $ ${cmd}`;
  }
  if (entry.type === "session_start") {
    const time = new Date(entry.ts).toLocaleTimeString();
    return `[${time}] Session started in ${entry.cwd}`;
  }
  if (entry.type === "session_end") {
    const time = new Date(entry.ts).toLocaleTimeString();
    const reason = entry.reason || "unknown";
    const code = entry.exitCode != null ? ` (exit ${entry.exitCode})` : "";
    return `[${time}] Session ended: ${reason}${code}`;
  }
  return null;
}

// GitHub Dark theme for xterm.js
const GITHUB_DARK_THEME = {
  background: "#0d1117",
  foreground: "#c9d1d9",
  cursor: "#c9d1d9",
  cursorAccent: "#0d1117",
  selectionBackground: "#264f78",
  selectionForeground: "#c9d1d9",
  black: "#484f58",
  red: "#ff7b72",
  green: "#3fb950",
  yellow: "#d29922",
  blue: "#58a6ff",
  magenta: "#bc8cff",
  cyan: "#39c5cf",
  white: "#b1bac4",
  brightBlack: "#6e7681",
  brightRed: "#ffa198",
  brightGreen: "#56d364",
  brightYellow: "#e3b341",
  brightBlue: "#79c0ff",
  brightMagenta: "#d2a8ff",
  brightCyan: "#56d4dd",
  brightWhite: "#f0f6fc",
};

const LAST_TERMINAL_KEY = "swarmfleet-last-terminal-session";
const WRAP_LINES_KEY = "swarmfleet-terminal-wrap-lines";
const MIN_UNWRAPPED_COLS = 1000;
const DEFAULT_SESSION_NAME = "Terminal";

function isDefaultSession(session: TerminalSession): boolean {
  return session.name === DEFAULT_SESSION_NAME;
}

function getNextManualSessionName(sessions: TerminalSession[]): string {
  const used = new Set(
    sessions
      .map((session) => session.name.match(/^Terminal (\d+)$/))
      .filter((match): match is RegExpMatchArray => match !== null)
      .map((match) => Number.parseInt(match[1], 10)),
  );

  let next = 2;
  while (used.has(next)) {
    next += 1;
  }
  return `Terminal ${next}`;
}

export default function TerminalTab({ projectPath, isVisible = true }: TerminalTabProps) {
  const [searchParams, setSearchParams] = useSearchParams();
  const sessionParam = searchParams.get("session");
  const [sessions, setSessions] = useState<TerminalSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [sessionListOpen, setSessionListOpen] = useState(false);
  const [wrapLines, setWrapLines] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(WRAP_LINES_KEY) === "true";
  });

  // xterm instances per session
  const terminalsRef = useRef<
    Map<
      string,
      { term: Terminal; fit: FitAddon; container: HTMLDivElement | null }
    >
  >(new Map());
  const termContainerRef = useRef<HTMLDivElement>(null);
  const abortControllers = useRef<Record<string, AbortController>>({});
  // Track dead-session history so we don't re-fetch
  const historyLoaded = useRef<Set<string>>(new Set());
  const sessionPreludeRef = useRef<Map<string, string>>(new Map());
  const sessionsLoadedRef = useRef(false);

  const activeSession = sessions.find((s) => s.id === activeSessionId) ?? null;

  // ---------- helpers ----------

  function getCellWidth(term: Terminal): number | null {
    const width = (term as Terminal & {
      _core?: { _renderService?: { dimensions?: { css?: { cell?: { width?: number } } } } };
    })._core?._renderService?.dimensions?.css?.cell?.width;
    return typeof width === "number" && width > 0 ? width : null;
  }

  function disposeSessionResources(sessionId: string) {
    if (abortControllers.current[sessionId]) {
      abortControllers.current[sessionId].abort();
      delete abortControllers.current[sessionId];
    }
    const entry = terminalsRef.current.get(sessionId);
    if (entry) {
      entry.term.dispose();
      entry.container?.remove();
      terminalsRef.current.delete(sessionId);
    }
    historyLoaded.current.delete(sessionId);
    sessionPreludeRef.current.delete(sessionId);
  }

  function getOrCreateTerminal(sessionId: string): {
    term: Terminal;
    fit: FitAddon;
  } {
    const existing = terminalsRef.current.get(sessionId);
    if (existing) return existing;

    const term = new Terminal({
      theme: GITHUB_DARK_THEME,
      fontFamily: "'SF Mono', Menlo, Monaco, 'Courier New', monospace",
      fontSize: 13,
      lineHeight: 1.4,
      cursorBlink: true,
      cursorStyle: "bar",
      scrollback: 10000,
      allowProposedApi: true,
      logLevel: "off",
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());

    terminalsRef.current.set(sessionId, { term, fit, container: null });
    return { term, fit };
  }

  function syncTerminalLayout(sessionId: string) {
    const entry = terminalsRef.current.get(sessionId);
    if (!entry?.container) return;

    const proposed = entry.fit.proposeDimensions();
    if (!proposed) return;

    if (wrapLines) {
      entry.container.style.width = "100%";
      entry.container.style.minWidth = "100%";
      entry.fit.fit();
      return;
    }

    const cols = Math.max(proposed.cols, MIN_UNWRAPPED_COLS);
    const rows = proposed.rows;
    if (entry.term.cols !== cols || entry.term.rows !== rows) {
      entry.term.resize(cols, rows);
    }

    const cellWidth = getCellWidth(entry.term);
    entry.container.style.minWidth = "100%";
    entry.container.style.width = cellWidth
      ? `${Math.ceil(cellWidth * cols)}px`
      : "max-content";
  }

  function getTerminalDimensions(
    sessionId: string,
  ): { cols: number; rows: number } | null {
    const entry = terminalsRef.current.get(sessionId);
    if (!entry) return null;
    return { cols: entry.term.cols, rows: entry.term.rows };
  }

  // ---------- Sync activeSessionId -> localStorage (and URL only when visible) ----------
  useEffect(() => {
    if (activeSessionId) {
      localStorage.setItem(LAST_TERMINAL_KEY, activeSessionId);
      if (isVisible) {
        setSearchParams({ session: activeSessionId }, { replace: true });
      }
    }
  }, [activeSessionId, isVisible, setSearchParams]);

  useEffect(() => {
    localStorage.setItem(WRAP_LINES_KEY, wrapLines ? "true" : "false");
  }, [wrapLines]);

  const loadSessions = useCallback(async (): Promise<TerminalSession[]> => {
    if (!projectPath) return [];

    try {
      const q = `?project=${encodeURIComponent(projectPath)}`;
      const res = await fetch(`/api/terminal/sessions${q}`);
      const data = await res.json();
      const allSessions: TerminalSession[] = data.sessions || [];
      const aliveSessions = allSessions.filter((s) => s.alive);
      const lastStored = localStorage.getItem(LAST_TERMINAL_KEY);

      setSessions(allSessions);
      sessionsLoadedRef.current = true;

      setActiveSessionId((current) => {
        const pick =
          (sessionParam && allSessions.find((s) => s.id === sessionParam)) ||
          (current && allSessions.find((s) => s.id === current)) ||
          (lastStored && allSessions.find((s) => s.id === lastStored && s.alive)) ||
          aliveSessions[0] ||
          allSessions[0] ||
          null;
        return pick?.id ?? null;
      });

      return allSessions;
    } catch {
      return [];
    }
  }, [projectPath, sessionParam]);

  // ---------- Fetch sessions and restore last active ----------
  useEffect(() => {
    if (!projectPath) {
      sessionsLoadedRef.current = false;
      return;
    }
    let cancelled = false;

    (async () => {
      const loaded = await loadSessions();
      if (cancelled) return;
      sessionsLoadedRef.current = loaded.length >= 0;
    })();

    return () => { cancelled = true; };
  }, [projectPath, loadSessions]);

  // ---------- Mount / unmount xterm into DOM for active session ----------
  useEffect(() => {
    if (!activeSessionId || !termContainerRef.current) return;

    const container = termContainerRef.current;

    // Hide all other terminals
    for (const [sid, entry] of terminalsRef.current) {
      if (entry.container && sid !== activeSessionId) {
        entry.container.style.display = "none";
      }
    }

    const { term } = getOrCreateTerminal(activeSessionId);
    let entry = terminalsRef.current.get(activeSessionId)!;

    if (!entry.container) {
      // First mount: create wrapper div and open terminal into it
      const wrapper = document.createElement("div");
      wrapper.style.height = "100%";
      wrapper.style.minWidth = "100%";
      container.appendChild(wrapper);
      term.open(wrapper);
      entry.container = wrapper;
      terminalsRef.current.set(activeSessionId, { ...entry, container: wrapper });

      // Initial fit
      requestAnimationFrame(() => {
        syncTerminalLayout(activeSessionId);
      });
    } else {
      // Already mounted, just show
      entry.container.style.display = "";
      requestAnimationFrame(() => {
        syncTerminalLayout(activeSessionId);
      });
    }

    term.focus();

    // Resize observer for auto-fit
    const resizeObserver = new ResizeObserver(() => {
      requestAnimationFrame(() => {
        try {
          syncTerminalLayout(activeSessionId);
        } catch {
          // ignore
        }
      });
    });
    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionId, wrapLines]);

  // ---------- Wire xterm input -> backend for alive sessions ----------
  useEffect(() => {
    if (!activeSessionId) return;
    const session = sessions.find((s) => s.id === activeSessionId);
    if (!session?.alive) return;

    const { term } = getOrCreateTerminal(activeSessionId);

    // Send keystrokes to backend
    const inputDisposable = term.onData((data: string) => {
      fetch(`/api/terminal/sessions/${activeSessionId}/input`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: data }),
      }).catch(() => {});
    });

    // Send resize events to backend
    const resizeDisposable = term.onResize(
      ({ cols, rows }: { cols: number; rows: number }) => {
        fetch(`/api/terminal/sessions/${activeSessionId}/resize`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cols, rows }),
        }).catch(() => {});
      },
    );

    // Trigger a fit so initial size is sent
    requestAnimationFrame(() => {
      try {
        syncTerminalLayout(activeSessionId);
      } catch {
        // ignore
      }
    });

    return () => {
      inputDisposable.dispose();
      resizeDisposable.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionId, sessions]);

  // ---------- Stream output for alive sessions ----------
  useEffect(() => {
    if (!activeSessionId) return;
    const session = sessions.find((s) => s.id === activeSessionId);
    if (!session?.alive) return;
    if (abortControllers.current[activeSessionId]) return;

    const controller = new AbortController();
    abortControllers.current[activeSessionId] = controller;

    const { term } = getOrCreateTerminal(activeSessionId);
    const prelude = sessionPreludeRef.current.get(activeSessionId);
    if (prelude) {
      term.write(prelude);
      sessionPreludeRef.current.delete(activeSessionId);
    }

    const stream = async () => {
      try {
        const res = await fetch(
          `/api/terminal/sessions/${activeSessionId}/stream`,
          { signal: controller.signal },
        );
        const reader = res.body?.getReader();
        if (!reader) return;
        const decoder = new TextDecoder();

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const text = decoder.decode(value, { stream: true });
          for (const line of text.split("\n")) {
            if (!line.trim()) continue;
            try {
              const msg = JSON.parse(line);
              if (msg.type === "output") {
                term.write(msg.data);
              } else if (msg.type === "exit") {
                const exitedId = activeSessionId;
                if (msg.code === 0) {
                  // Clean exit — auto-dismiss the tab and remove from server
                  fetch(`/api/terminal/sessions/${exitedId}`, { method: "DELETE" }).catch(() => {});
                  disposeSessionResources(exitedId);
                  setSessions((prev) => {
                    const remaining = prev.filter((s) => s.id !== exitedId);
                    return remaining;
                  });
                  setActiveSessionId((prevId) => {
                    if (prevId !== exitedId) return prevId;
                    // Find another session to switch to
                    const others = [...sessions].filter((s) => s.id !== exitedId);
                    return others.length > 0 ? others[0].id : null;
                  });
                } else {
                  // Non-zero exit — keep tab, show as dead
                  setSessions((prev) =>
                    prev.map((s) =>
                      s.id === exitedId ? { ...s, alive: false } : s,
                    ),
                  );
                }
              }
            } catch {
              // ignore parse errors
            }
          }
        }
      } catch (e) {
        if ((e as Error).name !== "AbortError") {
          console.error("Stream error:", e);
        }
      }
    };

    stream();

    return () => {
      controller.abort();
      delete abortControllers.current[activeSessionId];
    };
  }, [activeSessionId, sessions]);

  // ---------- Load history for dead sessions ----------
  useEffect(() => {
    if (!activeSessionId) return;
    const session = sessions.find((s) => s.id === activeSessionId);
    if (!session || session.alive) return;
    if (historyLoaded.current.has(activeSessionId)) return;

    const { term } = getOrCreateTerminal(activeSessionId);

    fetch(`/api/terminal/sessions/${activeSessionId}/history`)
      .then((r) => r.json())
      .then((data) => {
        if (data.entries) {
          const lines = (data.entries as TerminalHistoryEntry[])
            .map(formatHistoryEntry)
            .filter((l): l is string => l !== null);
          term.write(lines.join("\r\n"));
          term.write("\r\n\x1b[90m[Process exited]\x1b[0m\r\n");
          historyLoaded.current.add(activeSessionId);
        }
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionId, sessions]);

  // ---------- Re-fit terminal when tab becomes visible ----------
  useEffect(() => {
    if (!isVisible || !activeSessionId) return;
    const entry = terminalsRef.current.get(activeSessionId);
    if (entry) {
      requestAnimationFrame(() => {
        try {
          syncTerminalLayout(activeSessionId);
          entry.term.focus();
        } catch {
          // ignore
        }
      });
    }
  }, [isVisible, activeSessionId, wrapLines]);

  // ---------- Cleanup terminals on unmount ----------
  useEffect(() => {
    return () => {
      for (const [, entry] of terminalsRef.current) {
        entry.term.dispose();
      }
      terminalsRef.current.clear();
    };
  }, []);

  // ---------- Listen for "run-terminal-command" events ----------
  useEffect(() => {
    const handler = async (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!detail?.command || detail.switchToTerminal) return;

      const alwaysNewSession = detail.alwaysNewSession === true;

      // Usually reuse an alive terminal, but allow actions like provider config to
      // open a dedicated shell instead of typing into an existing editor/process.
      let sessionId: string | null = null;
      if (!alwaysNewSession) {
        try {
          const q = projectPath ? `?project=${encodeURIComponent(projectPath)}` : "";
          const listRes = await fetch(`/api/terminal/sessions${q}`);
          const listData = await listRes.json();
          const alive = (listData.sessions || []).find(
            (s: TerminalSession) => s.alive,
          );
          if (alive) {
            sessionId = alive.id;
            setActiveSessionId(alive.id);
          }
        } catch {
          // ignore
        }
      }

      // No reusable session found, or caller requested isolation — create one.
      if (!sessionId) {
        try {
          const res = await fetch("/api/terminal/sessions", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              cwd: projectPath || undefined,
              name: detail.sessionName,
            }),
          });
          const newSession = await res.json();
          if (newSession.id) {
            setSessions((prev) => [...prev, newSession]);
            setActiveSessionId(newSession.id);
            sessionId = newSession.id;
            // Wait for stream to connect
            await new Promise((r) => setTimeout(r, 500));
          }
        } catch {
          return;
        }
      }

      if (sessionId) {
        try {
          await fetch(`/api/terminal/sessions/${sessionId}/input`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ input: detail.command + "\n" }),
          });
        } catch {
          // ignore
        }
      }
    };
    window.addEventListener("run-terminal-command", handler);
    return () => window.removeEventListener("run-terminal-command", handler);
  }, [projectPath]);

  // ---------- Actions ----------

  const restartDefaultSession = useCallback(async () => {
    if (!projectPath) return;

    let cols = 120;
    let rows = 30;
    if (activeSessionId) {
      const dims = getTerminalDimensions(activeSessionId);
      if (dims) {
        cols = dims.cols;
        rows = dims.rows;
      }
    }

    try {
      const res = await fetch("/api/terminal/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cwd: projectPath,
          cols,
          rows,
          name: DEFAULT_SESSION_NAME,
          restartDefault: true,
        }),
      });
      const session = await res.json();
      if (session.id) {
        const removedDefaultIds = sessions
          .filter((existing) => isDefaultSession(existing))
          .map((existing) => existing.id);
        for (const id of removedDefaultIds) {
          disposeSessionResources(id);
        }
        if (session.historyPrelude) {
          sessionPreludeRef.current.set(session.id, session.historyPrelude as string);
        }
        setSessions((prev) => [
          ...prev.filter((existing) => !isDefaultSession(existing)),
          session,
        ]);
        setActiveSessionId(session.id);
        setSessionListOpen(false);
      }
    } catch (e) {
      console.error("Failed to restart default session:", e);
    }
  }, [projectPath, activeSessionId, sessions]);

  const createSession = useCallback(async () => {
    // Get dimensions from existing terminal if available
    let cols = 120;
    let rows = 30;
    if (activeSessionId) {
      const dims = getTerminalDimensions(activeSessionId);
      if (dims) {
        cols = dims.cols;
        rows = dims.rows;
      }
    }

    try {
      const res = await fetch("/api/terminal/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cwd: projectPath || undefined,
          cols,
          rows,
          name: getNextManualSessionName(sessions),
        }),
      });
      const session = await res.json();
      if (session.id) {
        setSessions((prev) => [...prev, session]);
        setActiveSessionId(session.id);
        setSessionListOpen(false);
      }
    } catch (e) {
      console.error("Failed to create session:", e);
    }
  }, [projectPath, activeSessionId, sessions]);

  const killSession = useCallback(
    async (id: string) => {
      try {
        await fetch(`/api/terminal/sessions/${id}`, { method: "DELETE" });
        disposeSessionResources(id);
        setSessions((prev) => prev.filter((s) => s.id !== id));
        if (activeSessionId === id) {
          const remaining = sessions.filter((s) => s.id !== id);
          setActiveSessionId(
            remaining.length > 0 ? remaining[0].id : null,
          );
        }
      } catch {
        // ignore
      }
    },
    [activeSessionId, sessions],
  );

  const restoreSession = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/terminal/sessions/${id}/restore`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const session = await res.json();
      if (session.id) {
        setSessions((prev) => [...prev, session]);
        setActiveSessionId(session.id);
      }
    } catch (e) {
      console.error("Failed to restore session:", e);
    }
  }, []);

  const dismissSession = useCallback(
    (id: string) => {
      // Remove from server so it doesn't reappear on refresh
      fetch(`/api/terminal/sessions/${id}`, { method: "DELETE" }).catch(() => {});
      disposeSessionResources(id);
      setSessions((prev) => prev.filter((s) => s.id !== id));
      if (activeSessionId === id) {
        const remaining = sessions.filter((s) => s.id !== id);
        setActiveSessionId(
          remaining.length > 0 ? remaining[0].id : null,
        );
      }
    },
    [activeSessionId, sessions],
  );

  useEffect(() => {
    if (!projectPath || !isVisible || !sessionsLoadedRef.current) return;
    if (sessions.length > 0) return;

    void restartDefaultSession();
  }, [projectPath, isVisible, sessions.length, restartDefaultSession]);

  // ---------- Render ----------

  if (!projectPath) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm text-[#484f58]">
        Select a project to use the terminal
      </div>
    );
  }

  return (
    <div
      data-testid="terminal-tab"
      data-active-session-id={activeSessionId ?? undefined}
      data-active-session-alive={activeSession?.alive ? "true" : "false"}
      data-wrap-lines={wrapLines ? "true" : "false"}
      className="flex-1 flex flex-col overflow-hidden bg-[#0d1117] relative"
    >
      {/* Terminal container — xterm mounts here */}
      <div
        ref={termContainerRef}
        data-testid="terminal-surface"
        data-wrap-lines={wrapLines ? "true" : "false"}
        className={`flex-1 relative ${wrapLines ? "overflow-hidden" : "overflow-x-auto overflow-y-hidden"}`}
        style={{ minHeight: 0 }}
      />

      {/* Restore bar for dead sessions */}
      {activeSession && !activeSession.alive && (
        <div className="flex items-center justify-center gap-3 border-t border-[#30363d] bg-[#161b22] px-3 py-2 shrink-0">
          <span className="text-xs text-[#484f58]">Session ended</span>
          <button
            onClick={() => restoreSession(activeSession.id)}
            data-testid="terminal-restore"
            className="text-[10px] px-3 py-1 rounded bg-[#238636] text-white hover:bg-[#2ea043] transition-colors"
          >
            Restore
          </button>
          <button
            onClick={() => dismissSession(activeSession.id)}
            data-testid="terminal-dismiss"
            className="text-[10px] px-3 py-1 rounded bg-[#30363d] text-[#8b949e] hover:text-[#c9d1d9] transition-colors"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Sessions list overlay */}
      {sessionListOpen && (
        <div className="absolute inset-0 z-20 flex flex-col justify-end">
          <div
            className="flex-1 bg-black/50"
            onClick={() => setSessionListOpen(false)}
          />
          <div className="w-full max-h-[60%] bg-[#0d1117] border-t border-[#30363d] flex flex-col">
            <div className="flex items-center justify-between px-3 py-2 border-b border-[#30363d]">
              <span className="text-xs font-medium text-[#c9d1d9]">
                Terminal Sessions
              </span>
              <button
                onClick={createSession}
                data-testid="terminal-new-session"
                className="text-[10px] px-2 py-0.5 rounded bg-[#238636] text-white hover:bg-[#2ea043]"
              >
                New
              </button>
            </div>
            <div className="flex-1 overflow-y-auto">
              {sessions.length === 0 && (
                <div className="px-3 py-4 text-xs text-[#484f58] text-center">
                  No sessions
                </div>
              )}
              {sessions.map((s) => (
                <div
                  key={s.id}
                  data-testid="terminal-session-row"
                  data-session-id={s.id}
                  data-alive={s.alive ? "true" : "false"}
                  data-active={s.id === activeSessionId ? "true" : "false"}
                  className={`flex items-center gap-2 px-3 py-2 text-xs cursor-pointer hover:bg-[#1c2129] ${
                    s.id === activeSessionId
                      ? "bg-[#1c2129] text-[#c9d1d9]"
                      : "text-[#8b949e]"
                  }`}
                  onClick={() => {
                    setActiveSessionId(s.id);
                    setSessionListOpen(false);
                  }}
                >
                  {s.alive ? (
                    <span className="w-2 h-2 rounded-full shrink-0 bg-[#3fb950]" />
                  ) : (
                    <svg
                      viewBox="0 0 16 16"
                      fill="currentColor"
                      className="w-3 h-3 shrink-0 text-[#484f58]"
                    >
                      <path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Zm7-3.25v2.992l2.028.812a.75.75 0 0 1-.556 1.392l-2.5-1A.75.75 0 0 1 7 8.25v-3.5a.75.75 0 0 1 1.5 0Z" />
                    </svg>
                  )}
                  <span className="flex-1 truncate">{s.name}</span>
                  {s.alive ? (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        killSession(s.id);
                      }}
                      className="text-[#f85149] hover:text-[#ff7b72]"
                    >
                      Kill
                    </button>
                  ) : (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        restoreSession(s.id);
                      }}
                      className="text-[#58a6ff] hover:text-[#79c0ff]"
                    >
                      Restore
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Bottom nav bar with session tabs */}
      <div className="flex items-stretch h-9 bg-[#161b22] border-t border-[#30363d] overflow-hidden shrink-0">
        {/* Sessions list toggle */}
        <button
          onClick={() => setSessionListOpen((p) => !p)}
          data-testid="terminal-sessions-toggle"
          className={`shrink-0 px-3 flex items-center gap-1.5 text-xs font-medium border-r border-[#30363d] transition-colors ${
            sessionListOpen
              ? "text-[#58a6ff] bg-[#0d1117]"
              : "text-[#8b949e] hover:text-[#c9d1d9]"
          }`}
        >
          <svg
            viewBox="0 0 16 16"
            fill="currentColor"
            className="w-3.5 h-3.5"
          >
            <path d="M0 1.75C0 .784.784 0 1.75 0h12.5C15.216 0 16 .784 16 1.75v12.5A1.75 1.75 0 0 1 14.25 16H1.75A1.75 1.75 0 0 1 0 14.25Zm1.75-.25a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25h12.5a.25.25 0 0 0 .25-.25V1.75a.25.25 0 0 0-.25-.25ZM3.5 5a.75.75 0 0 1 .75-.75h7.5a.75.75 0 0 1 0 1.5h-7.5A.75.75 0 0 1 3.5 5Zm.75 2.25a.75.75 0 0 0 0 1.5h7.5a.75.75 0 0 0 0-1.5h-7.5Z" />
          </svg>
          Sessions
        </button>

        <label className="shrink-0 px-3 flex items-center gap-2 text-xs text-[#8b949e] border-r border-[#30363d] select-none cursor-pointer">
          <input
            type="checkbox"
            checked={wrapLines}
            onChange={(e) => setWrapLines(e.target.checked)}
            data-testid="terminal-wrap-lines"
            className="h-3.5 w-3.5 rounded border border-[#484f58] bg-[#0d1117] accent-[#58a6ff]"
          />
          <span>Wrap lines</span>
        </label>

        {/* Scrollable session tabs */}
        <div
          className="flex-1 flex items-stretch overflow-x-auto"
          style={{ scrollbarWidth: "none" }}
        >
          {sessions.map((s) => (
            <div
              key={s.id}
              role="button"
              tabIndex={0}
              data-testid="terminal-session-tab"
              data-session-id={s.id}
              data-alive={s.alive ? "true" : "false"}
              data-active={s.id === activeSessionId ? "true" : "false"}
              onClick={() => {
                setActiveSessionId(s.id);
                setSessionListOpen(false);
              }}
              className={`shrink-0 min-w-[100px] max-w-[180px] px-3 flex items-center gap-1.5 text-xs transition-colors cursor-pointer ${
                s.id === activeSessionId
                  ? "text-[#c9d1d9] bg-[#0d1117] border-b-2 border-b-[#58a6ff]"
                  : "text-[#8b949e] hover:text-[#c9d1d9] border-b-2 border-b-transparent"
              }`}
            >
              {s.alive ? (
                <span className="w-1.5 h-1.5 rounded-full shrink-0 bg-[#3fb950]" />
              ) : (
                <svg
                  viewBox="0 0 16 16"
                  fill="currentColor"
                  className="w-3 h-3 shrink-0 text-[#484f58]"
                >
                  <path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Zm7-3.25v2.992l2.028.812a.75.75 0 0 1-.556 1.392l-2.5-1A.75.75 0 0 1 7 8.25v-3.5a.75.75 0 0 1 1.5 0Z" />
                </svg>
              )}
              <span className="truncate">{s.name}</span>
              {s.id === activeSessionId && s.alive && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    killSession(s.id);
                  }}
                  data-testid="terminal-kill-session"
                  className="shrink-0 min-w-[28px] min-h-[28px] flex items-center justify-center rounded hover:bg-[#30363d] text-[#8b949e] hover:text-[#c9d1d9]"
                  aria-label="Kill session"
                >
                  &times;
                </button>
              )}
              {s.id === activeSessionId && !s.alive && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    dismissSession(s.id);
                  }}
                  data-testid="terminal-dismiss-session"
                  className="shrink-0 min-w-[28px] min-h-[28px] flex items-center justify-center rounded hover:bg-[#30363d] text-[#8b949e] hover:text-[#c9d1d9]"
                  title="Dismiss from list"
                  aria-label="Dismiss session"
                >
                  &times;
                </button>
              )}
            </div>
          ))}

          {/* New session button */}
          <button
            onClick={createSession}
            data-testid="terminal-new-session"
            className="shrink-0 px-3 min-h-[36px] text-[#8b949e] hover:text-[#c9d1d9] flex items-center"
          >
            <svg
              viewBox="0 0 16 16"
              fill="currentColor"
              className="w-3.5 h-3.5"
            >
              <path d="M7.75 2a.75.75 0 0 1 .75.75V7h4.25a.75.75 0 0 1 0 1.5H8.5v4.25a.75.75 0 0 1-1.5 0V8.5H2.75a.75.75 0 0 1 0-1.5H7V2.75A.75.75 0 0 1 7.75 2Z" />
            </svg>
          </button>
        </div>
      </div>

      {/* No active session */}
      {!activeSession && sessions.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center">
          <button
            onClick={createSession}
            data-testid="terminal-new-session"
            className="px-4 py-2 rounded-md bg-[#238636] text-white text-sm hover:bg-[#2ea043] transition-colors"
          >
            New Terminal
          </button>
        </div>
      )}
    </div>
  );
}
