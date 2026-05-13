import React, { useRef, useEffect, useCallback, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { OpenFile } from "./useFileStore";

interface FileViewerProps {
  file: OpenFile;
  editing: boolean;
  onContentChange: (content: string) => void;
  onSave: () => void;
  onStartEdit: () => void;
  onStopEdit: () => void;
}

// Minimal syntax tokens by extension
const KEYWORD_MAP: Record<string, string[]> = {
  ts: ["import", "export", "from", "const", "let", "var", "function", "return", "if", "else", "for", "while", "class", "interface", "type", "extends", "implements", "new", "this", "async", "await", "try", "catch", "throw", "switch", "case", "default", "break", "continue", "typeof", "instanceof", "in", "of", "as", "is", "void", "null", "undefined", "true", "false"],
  tsx: ["import", "export", "from", "const", "let", "var", "function", "return", "if", "else", "for", "while", "class", "interface", "type", "extends", "implements", "new", "this", "async", "await", "try", "catch", "throw", "switch", "case", "default", "break", "continue", "typeof", "instanceof", "in", "of", "as", "is", "void", "null", "undefined", "true", "false"],
  js: ["import", "export", "from", "const", "let", "var", "function", "return", "if", "else", "for", "while", "class", "extends", "new", "this", "async", "await", "try", "catch", "throw", "switch", "case", "default", "break", "continue", "typeof", "instanceof", "in", "of", "void", "null", "undefined", "true", "false"],
  py: ["import", "from", "def", "return", "if", "elif", "else", "for", "while", "class", "with", "as", "try", "except", "raise", "finally", "pass", "break", "continue", "and", "or", "not", "in", "is", "lambda", "yield", "async", "await", "None", "True", "False", "self"],
  sh: ["if", "then", "else", "elif", "fi", "for", "do", "done", "while", "until", "case", "esac", "function", "return", "local", "export", "source", "echo", "exit", "set", "unset", "readonly", "shift", "true", "false"],
  go: ["package", "import", "func", "return", "if", "else", "for", "range", "switch", "case", "default", "break", "continue", "type", "struct", "interface", "map", "chan", "go", "defer", "select", "var", "const", "nil", "true", "false"],
  rs: ["use", "mod", "pub", "fn", "return", "if", "else", "for", "while", "loop", "match", "struct", "enum", "impl", "trait", "where", "let", "mut", "const", "static", "self", "super", "crate", "async", "await", "move", "unsafe", "true", "false", "None", "Some"],
};

function highlightLine(line: string, ext: string): (React.ReactNode | string)[] {
  const keywords = KEYWORD_MAP[ext];
  if (!keywords) return [line];

  const parts: (React.ReactNode | string)[] = [];
  let remaining = line;
  let key = 0;

  while (remaining.length > 0) {
    // Comments
    const commentIdx = remaining.indexOf("//");
    if (commentIdx === 0) {
      parts.push(<span key={key++} className="text-[#8b949e]">{remaining}</span>);
      break;
    }
    if (commentIdx > 0 && remaining[commentIdx - 1] !== ":") {
      parts.push(remaining.slice(0, commentIdx));
      parts.push(<span key={key++} className="text-[#8b949e]">{remaining.slice(commentIdx)}</span>);
      break;
    }

    // Hash comments (python, shell)
    if ((ext === "py" || ext === "sh") && remaining.trimStart().startsWith("#")) {
      const hashIdx = remaining.indexOf("#");
      if (hashIdx >= 0) {
        parts.push(remaining.slice(0, hashIdx));
        parts.push(<span key={key++} className="text-[#8b949e]">{remaining.slice(hashIdx)}</span>);
        break;
      }
    }

    // Strings
    const strMatch = remaining.match(/^(.*?)(["'`])((?:(?!\2|\\).|\\.)*)\2/);
    if (strMatch) {
      parts.push(tokenizeWords(strMatch[1], keywords, key));
      key += 100;
      parts.push(
        <span key={key++} className="text-[#a5d6ff]">
          {strMatch[2]}{strMatch[3]}{strMatch[2]}
        </span>,
      );
      remaining = remaining.slice(strMatch[0].length);
      continue;
    }

    // Just tokenize words for keywords
    parts.push(tokenizeWords(remaining, keywords, key));
    break;
  }

  return parts;
}

function tokenizeWords(text: string, keywords: string[], startKey: number): React.ReactNode {
  const parts: (React.ReactNode | string)[] = [];
  let key = startKey;
  // Split on word boundaries
  const tokens = text.split(/\b/);
  for (const token of tokens) {
    if (keywords.includes(token)) {
      parts.push(<span key={key++} className="text-[#ff7b72]">{token}</span>);
    } else {
      parts.push(token);
    }
  }
  return <span key={`tw-${startKey}`}>{parts}</span>;
}

type SvgViewMode = "xml" | "preview" | "split";
type MarkdownViewMode = "code" | "preview" | "split";

function defaultSvgViewMode(): SvgViewMode {
  if (typeof window === "undefined") return "split";
  return window.matchMedia("(min-width: 768px)").matches ? "split" : "preview";
}

function isMarkdownFile(file: OpenFile): boolean {
  const ext = file.extension.toLowerCase();
  return ext === "md" || ext === "markdown" || ext === "mdx";
}

const markdownPreviewComponents = {
  h1: ({ children, ...props }: React.ComponentPropsWithoutRef<"h1">) => (
    <h1 className="mt-0 mb-4 pb-2 border-b border-[#30363d] text-3xl font-bold tracking-tight text-[#f0f6fc]" {...props}>
      {children}
    </h1>
  ),
  h2: ({ children, ...props }: React.ComponentPropsWithoutRef<"h2">) => (
    <h2 className="mt-7 mb-3 pb-1 border-b border-[#21262d] text-2xl font-semibold tracking-tight text-[#f0f6fc]" {...props}>
      {children}
    </h2>
  ),
  h3: ({ children, ...props }: React.ComponentPropsWithoutRef<"h3">) => (
    <h3 className="mt-6 mb-2 text-xl font-semibold text-[#f0f6fc]" {...props}>
      {children}
    </h3>
  ),
  h4: ({ children, ...props }: React.ComponentPropsWithoutRef<"h4">) => (
    <h4 className="mt-5 mb-2 text-base font-semibold text-[#f0f6fc]" {...props}>
      {children}
    </h4>
  ),
  p: ({ children, ...props }: React.ComponentPropsWithoutRef<"p">) => (
    <p className="my-3 leading-7 text-[#c9d1d9]" {...props}>
      {children}
    </p>
  ),
  a: ({ children, ...props }: React.ComponentPropsWithoutRef<"a">) => (
    <a className="text-[#58a6ff] underline underline-offset-2 hover:text-[#79c0ff]" target="_blank" rel="noopener noreferrer" {...props}>
      {children}
    </a>
  ),
  ul: ({ children, ...props }: React.ComponentPropsWithoutRef<"ul">) => (
    <ul className="my-3 ml-6 list-disc space-y-1.5" {...props}>
      {children}
    </ul>
  ),
  ol: ({ children, ...props }: React.ComponentPropsWithoutRef<"ol">) => (
    <ol className="my-3 ml-6 list-decimal space-y-1.5" {...props}>
      {children}
    </ol>
  ),
  li: ({ children, ...props }: React.ComponentPropsWithoutRef<"li">) => (
    <li className="pl-1 leading-7 text-[#c9d1d9]" {...props}>
      {children}
    </li>
  ),
  blockquote: ({ children, ...props }: React.ComponentPropsWithoutRef<"blockquote">) => (
    <blockquote className="my-4 border-l-4 border-[#3b82f6] bg-[#161b22] px-4 py-2 text-[#8b949e]" {...props}>
      {children}
    </blockquote>
  ),
  code: ({ children, className, ...props }: React.ComponentPropsWithoutRef<"code"> & { className?: string }) => {
    const isBlock = className?.includes("language-");
    return (
      <code
        className={
          isBlock
            ? `block overflow-x-auto rounded-md bg-[#010409] px-3 py-2 font-mono text-xs leading-6 text-[#c9d1d9] ${className || ""}`
            : "rounded bg-[#161b22] px-1.5 py-0.5 font-mono text-[0.9em] text-[#ffab70]"
        }
        {...props}
      >
        {children}
      </code>
    );
  },
  pre: ({ children, ...props }: React.ComponentPropsWithoutRef<"pre">) => (
    <pre className="my-4 overflow-x-auto rounded-md border border-[#30363d] bg-[#010409] p-0" {...props}>
      {children}
    </pre>
  ),
  table: ({ children, ...props }: React.ComponentPropsWithoutRef<"table">) => (
    <div className="my-4 overflow-x-auto">
      <table className="w-full border-collapse text-sm" {...props}>
        {children}
      </table>
    </div>
  ),
  th: ({ children, ...props }: React.ComponentPropsWithoutRef<"th">) => (
    <th className="border border-[#30363d] bg-[#161b22] px-3 py-2 text-left font-semibold text-[#f0f6fc]" {...props}>
      {children}
    </th>
  ),
  td: ({ children, ...props }: React.ComponentPropsWithoutRef<"td">) => (
    <td className="border border-[#30363d] px-3 py-2 align-top text-[#c9d1d9]" {...props}>
      {children}
    </td>
  ),
  hr: (props: React.ComponentPropsWithoutRef<"hr">) => (
    <hr className="my-6 border-[#30363d]" {...props} />
  ),
  strong: ({ children, ...props }: React.ComponentPropsWithoutRef<"strong">) => (
    <strong className="font-semibold text-[#f0f6fc]" {...props}>
      {children}
    </strong>
  ),
};

function MarkdownPreview({ content }: { content: string }) {
  return (
    <div className="min-w-0 max-w-[980px] px-6 py-5 text-[15px] text-[#c9d1d9]">
      <Markdown remarkPlugins={[remarkGfm]} components={markdownPreviewComponents}>
        {content}
      </Markdown>
    </div>
  );
}

function CodePreviewPane({
  lines,
  extension,
  onDoubleClick,
}: {
  lines: string[];
  extension: string;
  onDoubleClick?: () => void;
}) {
  return (
    <div className="font-mono text-[12px] leading-[1.6]" onDoubleClick={onDoubleClick}>
      {lines.map((line, i) => (
        <div key={i} className="flex hover:bg-[#161b22]">
          <span className="shrink-0 w-10 text-right pr-3 select-none text-[#484f58] text-[11px]">
            {i + 1}
          </span>
          <span className="flex-1 whitespace-pre-wrap break-all text-[#c9d1d9] pr-2">
            {highlightLine(line, extension)}
          </span>
        </div>
      ))}
    </div>
  );
}

function MarkdownFileViewer({
  file,
  onStartEdit,
}: {
  file: OpenFile;
  onStartEdit: () => void;
}) {
  const [mode, setMode] = useState<MarkdownViewMode>("preview");
  const lines = file.content.split("\n");
  const showCode = mode === "code" || mode === "split";
  const showPreview = mode === "preview" || mode === "split";

  useEffect(() => {
    setMode("preview");
  }, [file.path]);

  return (
    <div
      data-testid="file-viewer"
      data-editing="false"
      data-path={file.path}
      className="flex-1 min-h-0 flex flex-col bg-[#0d1117]"
    >
      <div className="flex items-center justify-between gap-2 px-3 min-h-10 bg-[#161b22] border-b border-[#30363d] shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="hidden sm:inline text-[10px] text-[#484f58] whitespace-nowrap">
            {lines.length} lines &middot; {file.extension || "md"}
          </span>
          <div className="flex items-center gap-1 rounded-md border border-[#30363d] bg-[#0d1117] p-0.5">
            {(["code", "preview", "split"] as const).map((viewMode) => (
              <button
                key={viewMode}
                type="button"
                onClick={() => setMode(viewMode)}
                data-testid={`markdown-view-mode-${viewMode}`}
                className={`px-2 py-1 rounded text-[11px] ${
                  mode === viewMode
                    ? "bg-[#1f6feb] text-white"
                    : "text-[#8b949e] hover:text-[#c9d1d9] hover:bg-[#21262d]"
                }`}
              >
                {viewMode === "split" ? "Side by side" : viewMode}
              </button>
            ))}
          </div>
        </div>
        <button
          onClick={onStartEdit}
          className="text-[10px] px-2 py-0.5 rounded bg-[#21262d] text-[#8b949e] hover:text-[#c9d1d9] border border-[#30363d]"
        >
          Edit
        </button>
      </div>

      <div
        className={`flex-1 min-h-0 grid ${
          showCode && showPreview ? "grid-rows-2 md:grid-rows-1 md:grid-cols-2" : "grid-cols-1"
        }`}
      >
        {showCode && (
          <div className="min-h-0 overflow-auto border-b md:border-b-0 md:border-r border-[#30363d]">
            {showPreview && (
              <div className="sticky top-0 z-10 h-7 px-3 flex items-center bg-[#0d1117] border-b border-[#21262d] text-[10px] uppercase tracking-wide text-[#484f58]">
                Code
              </div>
            )}
            <CodePreviewPane lines={lines} extension={file.extension} onDoubleClick={onStartEdit} />
          </div>
        )}

        {showPreview && (
          <div className="min-h-0 overflow-auto">
            {showCode && (
              <div className="sticky top-0 z-10 h-7 px-3 flex items-center bg-[#0d1117] border-b border-[#21262d] text-[10px] uppercase tracking-wide text-[#484f58]">
                Preview
              </div>
            )}
            <MarkdownPreview content={file.content} />
          </div>
        )}
      </div>
    </div>
  );
}

function SvgFileViewer({
  file,
  onContentChange,
  onSave,
}: {
  file: OpenFile;
  onContentChange: (content: string) => void;
  onSave: () => void;
}) {
  const [mode, setMode] = useState<SvgViewMode>(() => defaultSvgViewMode());
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [svgUrl, setSvgUrl] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    panX: number;
    panY: number;
  } | null>(null);
  const showXml = mode === "xml" || mode === "split";
  const showPreview = mode === "preview" || mode === "split";

  useEffect(() => {
    const blob = new Blob([file.content], { type: "image/svg+xml;charset=utf-8" });
    const nextUrl = URL.createObjectURL(blob);
    setSvgUrl(nextUrl);
    setPreviewError(null);
    return () => URL.revokeObjectURL(nextUrl);
  }, [file.content]);

  useEffect(() => {
    setMode(defaultSvgViewMode());
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, [file.path]);

  const updateZoom = useCallback((nextZoom: number) => {
    setZoom(Math.min(8, Math.max(0.1, nextZoom)));
  }, []);

  const resetView = useCallback(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, []);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      dragRef.current = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        panX: pan.x,
        panY: pan.y,
      };
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    [pan.x, pan.y],
  );

  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    setPan({
      x: drag.panX + e.clientX - drag.startX,
      y: drag.panY + e.clientY - drag.startY,
    });
  }, []);

  const handlePointerEnd = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId === e.pointerId) {
      dragRef.current = null;
    }
  }, []);

  const handleWheel = useCallback(
    (e: React.WheelEvent<HTMLDivElement>) => {
      e.preventDefault();
      updateZoom(zoom * (e.deltaY > 0 ? 0.9 : 1.1));
    },
    [updateZoom, zoom],
  );

  return (
    <div
      data-testid="file-viewer"
      data-editing="svg"
      data-path={file.path}
      className="flex-1 min-h-0 flex flex-col bg-[#0d1117]"
    >
      <div className="flex items-center justify-between gap-2 px-3 min-h-10 bg-[#161b22] border-b border-[#30363d] shrink-0">
        <div className="flex items-center gap-1 rounded-md border border-[#30363d] bg-[#0d1117] p-0.5">
          {(["xml", "preview", "split"] as const).map((viewMode) => (
            <button
              key={viewMode}
              type="button"
              onClick={() => setMode(viewMode)}
              data-testid={`svg-view-mode-${viewMode}`}
              className={`px-2 py-1 rounded text-[11px] capitalize ${
                mode === viewMode
                  ? "bg-[#1f6feb] text-white"
                  : "text-[#8b949e] hover:text-[#c9d1d9] hover:bg-[#21262d]"
              }`}
            >
              {viewMode}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => updateZoom(zoom / 1.2)}
            className="min-w-8 h-7 rounded border border-[#30363d] bg-[#21262d] text-xs text-[#c9d1d9] hover:bg-[#30363d]"
            aria-label="Zoom out"
            title="Zoom out"
          >
            -
          </button>
          <button
            type="button"
            onClick={resetView}
            className="min-w-12 h-7 rounded border border-[#30363d] bg-[#21262d] text-[11px] text-[#c9d1d9] hover:bg-[#30363d]"
            title="Reset preview"
          >
            {Math.round(zoom * 100)}%
          </button>
          <button
            type="button"
            onClick={() => updateZoom(zoom * 1.2)}
            className="min-w-8 h-7 rounded border border-[#30363d] bg-[#21262d] text-xs text-[#c9d1d9] hover:bg-[#30363d]"
            aria-label="Zoom in"
            title="Zoom in"
          >
            +
          </button>
          <button
            type="button"
            onClick={onSave}
            className={`h-7 px-2 rounded text-[11px] border ${
              file.dirty
                ? "bg-[#238636] border-[#2ea043] text-white"
                : "bg-[#21262d] border-[#30363d] text-[#484f58]"
            }`}
            disabled={!file.dirty}
          >
            Save
          </button>
        </div>
      </div>

      <div
        className={`flex-1 min-h-0 grid ${
          showXml && showPreview ? "grid-rows-2 md:grid-rows-1 md:grid-cols-2" : "grid-cols-1"
        }`}
      >
        {showXml && (
          <div className="min-h-0 flex flex-col border-b md:border-b-0 md:border-r border-[#30363d]">
            <div className="h-7 px-3 flex items-center bg-[#0d1117] border-b border-[#21262d] text-[10px] uppercase tracking-wide text-[#484f58]">
              XML
            </div>
            <textarea
              value={file.content}
              onChange={(e) => onContentChange(e.target.value)}
              spellCheck={false}
              className="flex-1 min-h-0 w-full resize-none bg-[#0d1117] text-[#c9d1d9] font-mono text-[12px] leading-[1.55] p-3 focus:outline-none"
              style={{ tabSize: 2 }}
            />
          </div>
        )}

        {showPreview && (
          <div className="min-h-0 flex flex-col">
            <div className="h-7 px-3 flex items-center justify-between bg-[#0d1117] border-b border-[#21262d] text-[10px] uppercase tracking-wide text-[#484f58]">
              <span>SVG Preview</span>
              <span className="normal-case tracking-normal text-[#6e7681]">drag to pan</span>
            </div>
            <div
              data-testid="svg-preview-canvas"
              className="relative flex-1 min-h-0 overflow-hidden bg-[#0d1117] cursor-grab active:cursor-grabbing"
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerEnd}
              onPointerCancel={handlePointerEnd}
              onWheel={handleWheel}
            >
              <div
                className="absolute inset-3 will-change-transform"
                style={{
                  transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                  transformOrigin: "center",
                }}
              >
                <div className="w-full h-full bg-white shadow-[0_0_0_1px_#30363d]">
                  {svgUrl && !previewError ? (
                    <img
                      key={svgUrl}
                      src={svgUrl}
                      alt={file.name}
                      data-testid="svg-preview-image"
                      onError={() => setPreviewError("SVG preview failed to render")}
                      className="w-full h-full object-contain pointer-events-none bg-white"
                      draggable={false}
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center px-4 text-center text-xs text-[#6e7681]">
                      {previewError || "Preparing preview..."}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export function FileViewer({
  file,
  editing,
  onContentChange,
  onSave,
  onStartEdit,
  onStopEdit,
}: FileViewerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const viewerRef = useRef<HTMLDivElement>(null);
  const lines = file.content.split("\n");

  // Handle Ctrl+S / Cmd+S
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        onSave();
      }
      if (e.key === "Escape" && editing) {
        onStopEdit();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onSave, editing, onStopEdit]);

  // Focus textarea on edit mode
  useEffect(() => {
    if (editing && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [editing]);

  const handleTextareaInput = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      onContentChange(e.target.value);
    },
    [onContentChange],
  );

  if (!editing && file.extension.toLowerCase() === "svg") {
    return (
      <SvgFileViewer
        file={file}
        onContentChange={(content) => onContentChange(content)}
        onSave={onSave}
      />
    );
  }

  if (!editing && isMarkdownFile(file)) {
    return <MarkdownFileViewer file={file} onStartEdit={onStartEdit} />;
  }

  if (editing) {
    // Full-screen edit mode
    return (
      <div data-testid="file-viewer" data-editing="true" className="fixed inset-0 z-50 flex flex-col bg-[#0d1117]">
        {/* Minimal toolbar */}
        <div className="flex items-center justify-between px-3 h-10 bg-[#161b22] border-b border-[#30363d] shrink-0">
          <button
            onClick={onStopEdit}
            className="text-xs text-[#8b949e] hover:text-[#c9d1d9]"
          >
            Done
          </button>
          <span className="text-xs text-[#8b949e] truncate mx-2">{file.name}</span>
          <button
            onClick={onSave}
            className={`text-xs px-2 py-0.5 rounded ${
              file.dirty
                ? "bg-[#238636] text-white"
                : "text-[#484f58]"
            }`}
            disabled={!file.dirty}
          >
            Save
          </button>
        </div>
        <textarea
          ref={textareaRef}
          value={file.content}
          onChange={handleTextareaInput}
          spellCheck={false}
          className="flex-1 w-full bg-[#0d1117] text-[#c9d1d9] font-mono text-[13px] leading-[1.5] p-3 resize-none focus:outline-none"
          style={{ tabSize: 2 }}
        />
      </div>
    );
  }

  // Read-only code view
  return (
    <div
      ref={viewerRef}
      data-testid="file-viewer"
      data-editing="false"
      data-path={file.path}
      className="flex-1 overflow-auto bg-[#0d1117]"
    >
      {/* Toolbar */}
      <div className="sticky top-0 z-10 flex items-center justify-between px-3 h-8 bg-[#161b22] border-b border-[#30363d]">
        <span className="text-[10px] text-[#484f58]">
          {lines.length} lines &middot; {file.extension || "txt"}
        </span>
        <button
          onClick={onStartEdit}
          className="text-[10px] px-2 py-0.5 rounded bg-[#21262d] text-[#8b949e] hover:text-[#c9d1d9] border border-[#30363d]"
        >
          Edit
        </button>
      </div>

      {/* Code */}
      <CodePreviewPane lines={lines} extension={file.extension} onDoubleClick={onStartEdit} />
    </div>
  );
}
