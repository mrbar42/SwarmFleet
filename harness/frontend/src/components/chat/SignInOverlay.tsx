import { useRef, useEffect, useCallback } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";

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

interface SignInOverlayProps {
  providerName: string;
  command: string;
  onClose: () => void;
}

export default function SignInOverlay({
  providerName,
  command,
  onClose,
}: SignInOverlayProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Create terminal session and wire up xterm
  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Terminal({
      theme: GITHUB_DARK_THEME,
      fontFamily: "'SF Mono', Menlo, Monaco, 'Courier New', monospace",
      fontSize: 13,
      lineHeight: 1.4,
      cursorBlink: true,
      cursorStyle: "bar",
      scrollback: 5000,
      allowProposedApi: true,
      logLevel: "off",
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(containerRef.current);
    termRef.current = term;
    fitRef.current = fit;

    requestAnimationFrame(() => fit.fit());

    const resizeObserver = new ResizeObserver(() => {
      requestAnimationFrame(() => {
        try {
          fit.fit();
        } catch {
          // ignore
        }
      });
    });
    resizeObserver.observe(containerRef.current);

    // Create backend session
    const setup = async () => {
      try {
        const cols = term.cols;
        const rows = term.rows;
        const res = await fetch("/api/terminal/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cwd: "/workspace", cols, rows }),
        });
        const session = await res.json();
        if (!session.id) return;

        sessionIdRef.current = session.id;

        // Wire input
        term.onData((data: string) => {
          fetch(`/api/terminal/sessions/${session.id}/input`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ input: data }),
          }).catch(() => {});
        });

        // Wire resize
        term.onResize(({ cols, rows }: { cols: number; rows: number }) => {
          fetch(`/api/terminal/sessions/${session.id}/resize`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ cols, rows }),
          }).catch(() => {});
        });

        // Stream output
        const controller = new AbortController();
        abortRef.current = controller;

        const streamRes = await fetch(
          `/api/terminal/sessions/${session.id}/stream`,
          { signal: controller.signal },
        );
        const reader = streamRes.body?.getReader();
        if (!reader) return;
        const decoder = new TextDecoder();

        // Send the command after stream is connected
        await fetch(`/api/terminal/sessions/${session.id}/input`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ input: command + "\n" }),
        });

        // Read stream
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
              }
            } catch {
              // ignore
            }
          }
        }
      } catch (e) {
        if ((e as Error).name !== "AbortError") {
          console.error("SignIn terminal error:", e);
        }
      }
    };

    setup();

    return () => {
      resizeObserver.disconnect();
      abortRef.current?.abort();
      term.dispose();
      // Kill the session
      if (sessionIdRef.current) {
        fetch(`/api/terminal/sessions/${sessionIdRef.current}`, {
          method: "DELETE",
        }).catch(() => {});
      }
    };
  }, [command]);

  const handleDone = useCallback(() => {
    onClose();
  }, [onClose]);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") handleDone();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handleDone]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-[700px] max-w-[90vw] h-[500px] max-h-[80vh] flex flex-col rounded-lg border border-[#30363d] bg-[#0d1117] shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-[#30363d] bg-[#161b22] shrink-0">
          <span className="text-sm font-medium text-[#c9d1d9]">
            Sign in to {providerName}
          </span>
          <button
            onClick={handleDone}
            className="text-[#8b949e] hover:text-[#c9d1d9] transition-colors"
            aria-label="Close"
          >
            <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
              <path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.75.75 0 1 1 1.06 1.06L9.06 8l3.22 3.22a.75.75 0 1 1-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 0 1-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z" />
            </svg>
          </button>
        </div>

        {/* Terminal */}
        <div ref={containerRef} className="flex-1 overflow-hidden" />

        {/* Footer */}
        <div className="flex items-center justify-end px-4 py-3 border-t border-[#30363d] bg-[#161b22] shrink-0">
          <button
            onClick={handleDone}
            className="px-4 py-1.5 rounded-md text-xs font-medium bg-[#238636] text-white hover:bg-[#2ea043] transition-colors"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
