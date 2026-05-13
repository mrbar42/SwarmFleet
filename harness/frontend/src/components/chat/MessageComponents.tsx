import {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
  type ComponentType,
  type SVGProps,
} from "react";
import {
  ClipboardIcon,
  PencilSquareIcon,
  ArrowPathIcon,
  CheckIcon,
} from "@heroicons/react/24/outline";
import SignInOverlay from "./SignInOverlay";
import { invalidateProvidersCache } from "./ChatMessages";
import { useNavigate, useLocation } from "react-router-dom";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type {
  ChatMessage,
  CompactMessage,
  SystemMessage,
  ToolMessage,
  ToolResultMessage,
  ImageMessage,
  PlanMessage,
  ThinkingMessage,
  TodoMessage,
  TodoItem,
  AllMessage,
  HooksMessage,
  SubagentLaneMessage,
  TaskLifecycleUpdate,
} from "../../types";
import type { ConversationImageAsset, SessionMetadata } from "@shared/types";
import { TimestampComponent } from "../TimestampComponent";
import { MESSAGE_CONSTANTS } from "../../utils/constants";
import {
  createEditResult,
  isEditToolUseResult,
  isBashToolUseResult,
} from "../../utils/contentUtils";
import { useAppStore } from "../../stores/appStore";
import { useChatStore } from "../../stores/chatStore";
import { usePoll } from "../../hooks/usePoll";
import {
  getSessionStatusMap,
  subscribeSessionStatus,
} from "../../stores/sessionStatus";
import { getSessionsMap, subscribeSessions } from "../../stores/sessions";
import { sendMessage } from "./sendMessage";
import { isChatMessage } from "../../types";
import { normalizeWindowsPath } from "../../utils/pathUtils";
import { getSessionTaskStopUrl, getSessionUrl } from "../../config/api";
// ANSI escape sequence regex
const ANSI_REGEX = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const MIDDLE_ELLIPSIS_SEPARATOR = "...";
const COLLAPSED_USER_MESSAGE_LINES = 10;

function splitMessageLines(content: string): string[] {
  return content.split(/\r?\n/);
}

function ImageLightbox({
  asset,
  caption,
  onClose,
}: {
  asset: ConversationImageAsset;
  caption?: string;
  onClose: () => void;
}) {
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <div
        className="max-w-[95vw] max-h-[95vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <img
          src={asset.url}
          alt={caption || "Screenshot"}
          className="max-w-[95vw] max-h-[88vh] object-contain rounded border border-[#30363d] bg-[#0d1117]"
        />
        {caption && (
          <div className="mt-2 text-sm text-[#c9d1d9] text-center">
            {caption}
          </div>
        )}
      </div>
    </div>
  );
}

function ImageThumbnail({
  asset,
  caption,
  compact = false,
}: {
  asset: ConversationImageAsset;
  caption?: string;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className={`block text-left rounded-md border border-[#30363d] bg-[#0d1117] overflow-hidden hover:border-[#58a6ff] transition-colors ${
          compact ? "w-40" : "max-w-md"
        }`}
        onClick={() => setOpen(true)}
        title="Open full image"
      >
        <img
          src={asset.thumbnailUrl || asset.url}
          alt={caption || "Screenshot"}
          className={`${compact ? "h-24 w-40" : "max-h-72 w-full"} object-contain bg-black`}
        />
        {caption && (
          <div className="px-2 py-1 text-xs text-[#8b949e] truncate">
            {caption}
          </div>
        )}
      </button>
      {open && (
        <ImageLightbox
          asset={asset}
          caption={caption}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function inferImageMimeType(src: string): ConversationImageAsset["mimeType"] {
  const path = src.split(/[?#]/, 1)[0]?.toLowerCase() || "";
  if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
  if (path.endsWith(".gif")) return "image/gif";
  if (path.endsWith(".webp")) return "image/webp";
  return "image/png";
}

function normalizeMarkdownImageSrc(src: string): string {
  if (src.startsWith("/api/sessions/")) return src;
  try {
    const url = new URL(src);
    if (url.pathname.startsWith("/api/sessions/")) {
      return `${url.pathname}${url.search}${url.hash}`;
    }
  } catch {
    // Relative non-API images should be left exactly as authored.
  }
  return src;
}

function withThumbnailParam(src: string): string {
  if (!src.includes("/api/sessions/") || !src.includes("/assets/")) {
    return src;
  }
  if (/[?&]thumbnail=/.test(src)) return src;
  return `${src}${src.includes("?") ? "&" : "?"}thumbnail=1`;
}

function MarkdownImage({ src, alt }: React.ComponentPropsWithoutRef<"img">) {
  if (!src) return null;
  const normalizedSrc = normalizeMarkdownImageSrc(src);
  const asset: ConversationImageAsset = {
    assetId: normalizedSrc,
    mimeType: inferImageMimeType(normalizedSrc),
    url: normalizedSrc,
    thumbnailUrl: withThumbnailParam(normalizedSrc),
    createdAt: Date.now(),
    sourceToolName: "markdown",
  };
  return (
    <span className="my-2 block">
      <ImageThumbnail asset={asset} caption={alt || undefined} compact />
    </span>
  );
}

function inferAuthProvider(text: string): { name: string; command: string } {
  if (/codex|openai|api\.openai\.com|bearer/i.test(text)) {
    return { name: "Codex", command: "codex login --device-auth" };
  }
  return { name: "Claude", command: "cd /workspace && claude" };
}

function isProviderAuthError(text: string): boolean {
  return [
    /\bnot logged in\b/i,
    /\bnot authenticated\b/i,
    /\blogged out\b/i,
    /\beauth\b/i,
    /\binvalid api key\b/i,
    /\bapi key (?:is )?(?:missing|required|not found|invalid)\b/i,
    /\bno api key\b/i,
    /\bunauthorized\b/i,
    /\bauthentication (?:failed|required)\b/i,
    /\bplease run (?:\/login|claude auth login|codex login)\b/i,
    /\bmust authenticate\b/i,
  ].some((pattern) => pattern.test(text));
}

function isTransientProviderError(text: string): boolean {
  if (isProviderAuthError(text)) return false;
  return [
    /\bapi error:\s*(?:5\d\d|429)\b/i,
    /\b(?:http|status)\s*(?:500|502|503|504|429)\b/i,
    /\b(?:fetch failed|network error|network request failed)\b/i,
    /\b(?:econnreset|econnrefused|etimedout|enotfound|eai_again)\b/i,
    /\b(?:socket hang up|connection (?:reset|refused|timed out))\b/i,
    /\b(?:timeout|timed out|temporarily unavailable|service unavailable|bad gateway|gateway timeout)\b/i,
    /\b(?:overloaded|rate limit|too many requests)\b/i,
    /\b(?:claude|codex) cli exited with code 1\b/i,
  ].some((pattern) => pattern.test(text));
}

function useLastUserRetry() {
  const currentProject = useAppStore((state) => state.currentProject);
  const messages = useChatStore((state) => state.messages);
  const phase = useChatStore((state) => state.phase);
  const canRetry =
    phase !== "streaming" &&
    phase !== "awaiting-permission" &&
    phase !== "loading-history";
  const workingDirectory = currentProject?.path
    ? normalizeWindowsPath(currentProject.path)
    : undefined;
  const encodedName = currentProject?.encodedName ?? null;
  const retryText = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (isChatMessage(m) && m.role === "user") return m.content;
    }
    return null;
  }, [messages]);

  const retry = useCallback(() => {
    if (!canRetry || !retryText) return;
    void sendMessage(
      workingDirectory,
      encodedName,
      retryText,
      undefined,
      true,
      undefined,
      undefined,
      { skipTranscript: true },
    );
  }, [canRetry, retryText, workingDirectory, encodedName]);

  return { canRetry: canRetry && Boolean(retryText), retry };
}

function isHooksMessage(
  msg: SystemMessage,
): msg is HooksMessage & { timestamp: number } {
  return (
    msg.type === "system" &&
    "content" in msg &&
    typeof msg.content === "string" &&
    !("subtype" in msg)
  );
}

// Per-tool color mapping
const TOOL_COLORS: Record<string, string> = {
  Bash: "text-[#d2a8ff]",
  Read: "text-[#79c0ff]",
  Write: "text-[#7ee787]",
  Edit: "text-[#ffa657]",
  Grep: "text-[#ff7b72]",
  Glob: "text-[#f778ba]",
  Agent: "text-[#d29922]",
  TodoWrite: "text-[#58a6ff]",
  ScheduleWakeup: "text-[#d29922]",
  WaitUntil: "text-[#d29922]",
  MCP: "text-[#8b949e]",
};

function getToolColor(toolName: string): string {
  return TOOL_COLORS[toolName] || "text-[#8b949e]";
}

function stripProjectPrefix(text: string, projectPath: string | null): string {
  if (!projectPath) return text;
  const prefix = projectPath.endsWith("/") ? projectPath : projectPath + "/";
  return text.split(prefix).join("").split(projectPath).join(".");
}

function extractPaths(
  text: string,
): { start: number; end: number; path: string }[] {
  const paths: { start: number; end: number; path: string }[] = [];
  const pathRegex =
    /(?:\.{1,2}\/[\w@./-]+)|(?:[\w@-]+\/[\w@./-]*[\w@.-])|(?:\.[\w-]+(?:\/[\w@./-]*)?)|(?:[\w@-]+\.[\w]+)/g;
  let match;
  while ((match = pathRegex.exec(text)) !== null) {
    if (match[0].startsWith("-")) continue;
    if (match[0].length < 2) continue;
    paths.push({
      start: match.index,
      end: match.index + match[0].length,
      path: match[0],
    });
  }
  return paths;
}

function getProjectNameFromPathname(pathname: string): string {
  const segments = pathname.split("/").filter(Boolean);
  return segments[1] ?? "";
}

function unwrapBashLcCommand(command: string): string {
  const trimmed = command.trim();
  const match = trimmed.match(/^(?:\/bin\/)?bash\s+-lc\s+(['"])([\s\S]*)\1$/);
  return match ? match[2] : trimmed;
}

function trimShellQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function formatBashSummary(command: string): string {
  const unwrapped = unwrapBashLcCommand(command);
  const readLinesMatch = unwrapped.match(
    /^sed\s+-n\s+(['"])(\d+),(\d+)p\1\s+(.+)$/,
  );
  if (readLinesMatch) {
    const [, , from, to, rawPath] = readLinesMatch;
    const filePath = trimShellQuotes(rawPath);
    return `ReadLines(${from}-${to}, ${filePath})`;
  }
  return unwrapped;
}

function getDisplayedToolCall(
  toolName: string,
  args: Record<string, unknown>,
): { toolName: string; argsText: string; colorName: string } {
  if (isTodoToolCall(toolName, args)) {
    return {
      toolName: "TodoWrite",
      argsText: formatTodoToolSummary(args),
      colorName: "TodoWrite",
    };
  }
  if (isOmcScheduleWakeupTool(toolName)) {
    return {
      toolName: "ScheduleWakeup",
      argsText: formatOmcScheduleWakeupSummary(args),
      colorName: "ScheduleWakeup",
    };
  }
  if (isOmcWaitUntilTool(toolName)) {
    return {
      toolName: "WaitUntil",
      argsText: formatOmcWaitUntilSummary(args),
      colorName: "WaitUntil",
    };
  }
  if (toolName === "mcp__swarmfleet__run_detached_shell") {
    return {
      toolName: "swarmfleet.run_detached_shell",
      argsText: formatDetachedShellCommandSummary(args),
      colorName: "MCP",
    };
  }
  if (toolName === "Bash") {
    const summary = formatBashSummary(String(args.command || ""));
    const readLinesMatch = summary.match(/^ReadLines\((.+)\)$/);
    if (readLinesMatch) {
      return {
        toolName: "ReadLines",
        argsText: readLinesMatch[1],
        colorName: "Read",
      };
    }
    return { toolName, argsText: summary, colorName: toolName };
  }
  if (isMcpToolName(toolName)) {
    return {
      toolName: formatMcpToolName(toolName),
      argsText: formatStructuredToolSummary(args),
      colorName: "MCP",
    };
  }
  return {
    toolName,
    argsText: getToolCallSummary(toolName, args),
    colorName: toolName,
  };
}

function isOmcScheduleWakeupTool(toolName: string): boolean {
  return (
    toolName === "mcp__swarmfleet__schedule_wakeup" ||
    toolName === "mcp__omc__schedule_wakeup" ||
    toolName === "mcp__omcv8__schedule_wakeup"
  );
}

function isOmcWaitUntilTool(toolName: string): boolean {
  return (
    toolName === "mcp__swarmfleet__wait_until" ||
    toolName === "mcp__omc__wait_until" ||
    toolName === "mcp__omcv8__wait_until"
  );
}

function isMcpToolName(toolName: string): boolean {
  return /^mcp__[^_].+__[^_].+/.test(toolName);
}

function formatMcpToolName(toolName: string): string {
  const match = toolName.match(/^mcp__([^_].*?)__(.+)$/);
  if (!match) return toolName;
  return `${match[1]}.${match[2]}`;
}

function isTodoToolCall(
  toolName: string,
  args: Record<string, unknown>,
): boolean {
  return (
    toolName === "TodoWrite" ||
    (toolName.toLowerCase() === "todo" && Array.isArray(args.todos))
  );
}

function getToolCallSummary(
  toolName: string,
  args: Record<string, unknown>,
): string {
  switch (toolName) {
    case "Read":
    case "Write":
    case "Edit":
      return args.file_path ? String(args.file_path) : "";
    case "Bash":
      return formatBashSummary(String(args.command || ""));
    case "Grep":
    case "Glob":
      return args.pattern ? String(args.pattern) : "";
    case "ScheduleWakeup":
      return formatScheduleWakeupSummary(args);
    case "WaitUntil":
      return formatOmcWaitUntilSummary(args);
    default: {
      return formatStructuredToolSummary(args);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function formatPrimitiveToolValue(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  return null;
}

function formatTodoToolSummary(args: Record<string, unknown>): string {
  const todos = Array.isArray(args.todos) ? args.todos : [];
  if (todos.length === 0) return "0 todos";
  const inProgress = todos.filter(
    (item) => isRecord(item) && item.status === "in_progress",
  ).length;
  const completed = todos.filter(
    (item) => isRecord(item) && item.status === "completed",
  ).length;
  const parts = [`${todos.length} ${todos.length === 1 ? "todo" : "todos"}`];
  if (inProgress > 0) parts.push(`${inProgress} in progress`);
  if (completed > 0) parts.push(`${completed} done`);
  return parts.join(", ");
}

function formatArrayToolValue(value: unknown[]): string {
  if (value.length === 0) return "[]";
  const primitiveItems = value
    .map(formatPrimitiveToolValue)
    .filter((item): item is string => item !== null);
  if (primitiveItems.length === value.length) {
    return primitiveItems.slice(0, 3).join(", ");
  }
  return `${value.length} ${value.length === 1 ? "item" : "items"}`;
}

function formatObjectToolValue(value: Record<string, unknown>): string {
  const preferredKeys = [
    "title",
    "description",
    "prompt",
    "query",
    "url",
    "path",
    "file_path",
  ];
  for (const key of preferredKeys) {
    const primitive = formatPrimitiveToolValue(value[key]);
    if (primitive) return primitive;
  }
  const keys = Object.keys(value).filter((key) => key !== "_raw");
  return keys.length > 0 ? `{${keys.slice(0, 3).join(", ")}}` : "{}";
}

function formatToolValue(value: unknown): string {
  const primitive = formatPrimitiveToolValue(value);
  if (primitive !== null) return primitive;
  if (Array.isArray(value)) return formatArrayToolValue(value);
  if (isRecord(value)) return formatObjectToolValue(value);
  if (value == null) return "";
  return String(value);
}

function formatStructuredToolSummary(args: Record<string, unknown>): string {
  if (Array.isArray(args.todos)) return formatTodoToolSummary(args);

  const preferredKeys = [
    "file_path",
    "path",
    "command",
    "pattern",
    "query",
    "q",
    "url",
    "name",
    "title",
    "description",
    "prompt",
  ];
  for (const key of preferredKeys) {
    if (Object.prototype.hasOwnProperty.call(args, key)) {
      const formatted = formatToolValue(args[key]);
      if (formatted) return formatted;
    }
  }

  const keys = Object.keys(args).filter((key) => key !== "_raw");
  if (keys.length === 0) return "";
  if (keys.length === 1) return formatToolValue(args[keys[0]]);
  return keys
    .slice(0, 3)
    .map((key) => `${key}=${formatToolValue(args[key])}`)
    .join(", ");
}

function formatDetachedShellCommandSummary(
  args: Record<string, unknown>,
): string {
  const command = typeof args.command === "string" ? args.command.trim() : "";
  if (!command) return formatStructuredToolSummary(args);
  return command.replace(/\s+/g, " ");
}

function parseToolJsonContent(content: string): Record<string, unknown> | null {
  const trimmed = content.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function shortId(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  return value.length <= 8 ? value : value.slice(0, 8);
}

function formatDetachedShellResultSummary(
  toolName: string,
  content: string,
  fallback: string,
): { summary: string; isError: boolean } | null {
  const isShellJobTool =
    toolName === "mcp__swarmfleet__run_detached_shell" ||
    toolName === "mcp__swarmfleet__read_shell_job" ||
    toolName === "mcp__swarmfleet__kill_shell_job" ||
    toolName === "mcp__swarmfleet__list_shell_jobs";
  if (!isShellJobTool) return null;

  const trimmed = content.trim();
  if (trimmed.includes("failed")) {
    return { summary: trimmed.split("\n")[0] || fallback, isError: true };
  }

  const json = parseToolJsonContent(trimmed);
  if (!json) return { summary: fallback, isError: false };

  if (Array.isArray(json.jobs)) {
    return {
      summary: `${json.jobs.length} ${json.jobs.length === 1 ? "job" : "jobs"}`,
      isError: false,
    };
  }

  const status = typeof json.status === "string" ? json.status : "";
  const pid = typeof json.pid === "number" ? `pid ${json.pid}` : "";
  const id = shortId(json.jobId) ?? shortId(json.job_id);
  const parts = [status, pid, id ? `job ${id}` : ""].filter(Boolean);
  return {
    summary: parts.length > 0 ? parts.join(" · ") : fallback,
    isError: false,
  };
}

function formatPrettyDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "?";
  const totalSeconds = Math.max(1, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0 && hours === 0) parts.push(`${seconds}s`);
  return parts.join(" ") || "0s";
}

function parseDurationSummaryMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value * 1000;
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  const match = trimmed.match(
    /^(\d+(?:\.\d+)?)\s*(ms|s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours)$/,
  );
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = match[2];
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const multiplier =
    unit === "ms"
      ? 1
      : unit.startsWith("s")
        ? 1000
        : unit.startsWith("m")
          ? 60_000
          : 3_600_000;
  return amount * multiplier;
}

function readTimestampMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value < 10_000_000_000 ? value * 1000 : value;
  }
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function shortSymbolId(value: string): string {
  if (value.length <= 18) return value;
  return `${value.slice(0, 10)}...${value.slice(-4)}`;
}

function formatWaitConditionSymbol(condition: unknown): string {
  if (!condition || typeof condition !== "object") return "?";
  const record = condition as Record<string, unknown>;
  if (typeof record.display === "string" && record.display.trim()) {
    return record.display.trim();
  }
  const type = typeof record.type === "string" ? record.type : "";
  if (type === "background_task_completed") {
    const taskId =
      typeof record.task_id === "string"
        ? record.task_id
        : typeof record.taskId === "string"
          ? record.taskId
          : "";
    return taskId ? `task:${shortSymbolId(taskId)}` : "task:?";
  }
  if (type === "subagent_completed") {
    const subagentId =
      typeof record.subagent_id === "string"
        ? record.subagent_id
        : typeof record.subagentId === "string"
          ? record.subagentId
          : "";
    return subagentId ? `subagent:${shortSymbolId(subagentId)}` : "subagent:?";
  }
  return type || "?";
}

function formatOmcWaitUntilSummary(args: Record<string, unknown>): string {
  const explicitTimeoutMs =
    parseDurationSummaryMs(args.timeout) ??
    parseDurationSummaryMs(args.timeout_seconds) ??
    parseDurationSummaryMs(args.timeoutSeconds);
  const createdAt = readTimestampMs(args.created_at ?? args.createdAt);
  const timeoutAt = readTimestampMs(args.timeout_at ?? args.timeoutAt);
  const duration =
    explicitTimeoutMs !== null
      ? formatPrettyDuration(explicitTimeoutMs)
      : createdAt !== null && timeoutAt !== null
        ? formatPrettyDuration(timeoutAt - createdAt)
        : "?";
  const conditions = Array.isArray(args.conditions)
    ? args.conditions.map(formatWaitConditionSymbol)
    : [];
  return `${duration}, [${conditions.join(", ")}]`;
}

function formatOmcScheduleWakeupSummary(args: Record<string, unknown>): string {
  const explicitDelayMs =
    parseDurationSummaryMs(args.delay) ??
    parseDurationSummaryMs(args.delay_seconds) ??
    parseDurationSummaryMs(args.delaySeconds);
  const createdAt = readTimestampMs(args.created_at ?? args.createdAt);
  const delayUntil = readTimestampMs(
    args.delay_until ??
      args.delayUntil ??
      args.scheduled_for ??
      args.scheduledFor,
  );
  if (explicitDelayMs !== null) return formatPrettyDuration(explicitDelayMs);
  if (createdAt !== null && delayUntil !== null) {
    return formatPrettyDuration(delayUntil - createdAt);
  }
  return getToolCallSummary("ScheduleWakeup", args);
}

function parseScheduleAbsoluteTime(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value < 10_000_000_000 ? value * 1000 : value;
  }
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatBrowserLocalTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatScheduleWakeupSummary(args: Record<string, unknown>): string {
  const absoluteKeys = [
    "wake_at",
    "wakeAt",
    "wakeup_at",
    "wakeupAt",
    "scheduled_at",
    "scheduledAt",
    "time",
    "timestamp",
  ];
  for (const key of absoluteKeys) {
    const timestamp = parseScheduleAbsoluteTime(args[key]);
    if (timestamp !== null) {
      return formatBrowserLocalTime(timestamp);
    }
  }
  const firstKey = Object.keys(args).filter((key) => key !== "_raw")[0];
  return firstKey ? String(args[firstKey]) : "";
}

function getScheduleWakeupResultTimestamp(result: unknown): number | null {
  if (!result || typeof result !== "object") return null;
  return parseScheduleAbsoluteTime(
    (result as Record<string, unknown>).scheduledFor ??
      (result as Record<string, unknown>).scheduled_for,
  );
}

function formatScheduleWakeupResultSummary(result: unknown): string | null {
  const scheduledFor = getScheduleWakeupResultTimestamp(result);
  if (scheduledFor === null) return null;
  return `Next wakeup ${formatBrowserLocalTime(scheduledFor)}`;
}

function getCanvasTextMeasurer(font: string): (text: string) => number {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) {
    return (text: string) => text.length * 7.2;
  }
  context.font = font;
  return (text: string) => context.measureText(text).width;
}

function fitMiddleText(text: string, width: number, font: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized || width <= 0) return normalized;

  const measure = getCanvasTextMeasurer(font);
  if (measure(normalized) <= width) return normalized;

  const separator = MIDDLE_ELLIPSIS_SEPARATOR;
  if (measure(separator) >= width) return "...";

  let best = "...";
  let low = 1;
  let high = Math.max(1, normalized.length - 1);

  while (low <= high) {
    const totalChars = Math.floor((low + high) / 2);
    const tailChars = Math.max(1, Math.floor(totalChars * 0.42));
    const headChars = Math.max(1, totalChars - tailChars);
    const candidate = `${normalized.slice(0, headChars)}${separator}${normalized.slice(-tailChars)}`;

    if (measure(candidate) <= width) {
      best = candidate;
      low = totalChars + 1;
    } else {
      high = totalChars - 1;
    }
  }

  return best;
}

function MiddleEllipsisText({ text }: { text: string }) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const [displayText, setDisplayText] = useState(() =>
    text.replace(/\s+/g, " ").trim(),
  );

  useEffect(() => {
    const node = ref.current;
    if (!node) return;

    const update = () => {
      const width = node.getBoundingClientRect().width;
      const font = window.getComputedStyle(node).font;
      setDisplayText(fitMiddleText(text, width, font));
    };
    update();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", update);
      return () => window.removeEventListener("resize", update);
    }

    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, [text]);

  return (
    <span
      ref={ref}
      title={text}
      className="block min-w-0 max-w-full overflow-hidden whitespace-nowrap"
    >
      {displayText}
    </span>
  );
}

function ToolCallLine({
  toolName,
  argsText,
  resultText,
  resultIsError = false,
  toolColor,
  isExpanded,
  onToggle,
}: {
  toolName: string;
  argsText: string;
  resultText?: string;
  resultIsError?: boolean;
  toolColor: string;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const resultColor = resultIsError ? "text-[#f85149]" : "text-[#8b949e]";
  const argsClassName =
    resultText !== undefined
      ? "min-w-0 max-w-[45%] flex-none text-[#8b949e]"
      : "min-w-0 max-w-full flex-none text-[#8b949e]";

  return (
    <div
      className="flex w-full min-w-0 items-center overflow-hidden whitespace-nowrap text-xs font-mono cursor-pointer"
      onClick={onToggle}
      title={`${toolName}(${argsText})${resultText ? ` -> ${resultText}` : ""}`}
    >
      <span className={`${toolColor} font-semibold shrink-0`}>{toolName}</span>
      <span className="shrink-0 text-[#8b949e]">(</span>
      <span className={argsClassName}>
        <MiddleEllipsisText text={argsText} />
      </span>
      <span className="shrink-0 text-[#8b949e]">)</span>
      {resultText !== undefined && (
        <>
          <span className="shrink-0 text-[#6e7681]">-&gt;</span>
          <span className={`min-w-0 max-w-[45%] flex-none ${resultColor}`}>
            <MiddleEllipsisText text={resultText} />
          </span>
        </>
      )}
      <svg
        viewBox="0 0 20 20"
        fill="currentColor"
        className={`w-3 h-3 ml-1.5 shrink-0 text-[#484f58] transition-transform duration-150 ${
          isExpanded ? "rotate-90" : ""
        }`}
      >
        <path
          fillRule="evenodd"
          d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z"
          clipRule="evenodd"
        />
      </svg>
    </div>
  );
}

function formatAgentType(agentType: string): string {
  const normalized = agentType.trim().replace(/[_-]+/g, " ");
  if (!normalized) return "General Purpose Agent";
  return normalized
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function formatElapsedTime(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) {
    return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${String(remainingMinutes).padStart(2, "0")}m`;
}

function summarizeText(text: string, maxLength = 140): string {
  const firstLine =
    text
      .trim()
      .split("\n")
      .find((line) => line.trim().length > 0)
      ?.trim() ?? "";
  if (!firstLine) return "";
  return firstLine.length > maxLength
    ? `${firstLine.slice(0, maxLength - 1)}…`
    : firstLine;
}

function formatProviderLabel(provider: string | undefined): string {
  if (!provider) return "Agent";
  return provider.trim() || "Agent";
}

function formatModelLabel(model: string | undefined): string {
  if (!model) return "unknown model";
  const normalized = model.trim();
  const modelId = normalized.includes(":")
    ? normalized.split(":").slice(1).join(":")
    : normalized;
  const claudeModern = modelId.match(
    /^claude-(opus|sonnet|haiku)-(\d+)(?:[-.](\d+))?(?:-|$)/i,
  );
  if (claudeModern) {
    return [
      claudeModern[1].toLowerCase(),
      formatModelVersion(claudeModern[2], claudeModern[3]),
    ]
      .filter(Boolean)
      .join(" ");
  }

  const claudeLegacy = modelId.match(
    /^claude-(\d+)(?:[-.](\d+))?-(opus|sonnet|haiku)(?:-|$)/i,
  );
  if (claudeLegacy) {
    return [
      claudeLegacy[3].toLowerCase(),
      formatModelVersion(claudeLegacy[1], claudeLegacy[2]),
    ]
      .filter(Boolean)
      .join(" ");
  }

  return modelId;
}

function formatModelVersion(
  major: string | undefined,
  minor: string | undefined,
): string {
  if (!major) return "";
  return minor ? `${major}.${minor}` : major;
}

function formatSubagentStats(stats: SubagentLaneStats | null): string {
  const input =
    typeof stats?.inputTokens === "number"
      ? formatWholeTokens(stats.inputTokens)
      : "?";
  const output =
    typeof stats?.outputTokens === "number"
      ? formatWholeTokens(stats.outputTokens)
      : "?";
  const toolCalls =
    typeof stats?.toolCallCount === "number" ? stats.toolCallCount : "?";
  return `↑${input}↓${output} ${toolCalls} tools`;
}

function formatSubagentStatsTitle(stats: SubagentLaneStats | null): string {
  const input =
    typeof stats?.inputTokens === "number"
      ? stats.inputTokens.toLocaleString()
      : "?";
  const output =
    typeof stats?.outputTokens === "number"
      ? stats.outputTokens.toLocaleString()
      : "?";
  const toolCalls =
    typeof stats?.toolCallCount === "number" ? stats.toolCallCount : "?";
  return `${input} input tokens, ${output} output tokens, ${toolCalls} tool calls`;
}

function formatWholeTokens(value: number): string {
  if (!Number.isFinite(value)) return "?";
  if (value >= 1_000_000) return `${Math.round(value / 1_000_000)}m`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(Math.round(value));
}

function extractSubagentLaneStats(
  conversation: unknown,
): SubagentLaneStats | null {
  if (!conversation || typeof conversation !== "object") return null;
  const messages = (conversation as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return null;

  let inputTokens = 0;
  let outputTokens = 0;
  let sawUsage = false;
  let toolCallCount = 0;

  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const record = message as Record<string, unknown>;
    const usage = record.usage;
    if (usage && typeof usage === "object") {
      const usageRecord = usage as Record<string, unknown>;
      const input = usageRecord.input_tokens;
      const output = usageRecord.output_tokens;
      if (typeof input === "number") {
        inputTokens += input;
        sawUsage = true;
      }
      if (typeof output === "number") {
        outputTokens += output;
        sawUsage = true;
      }
    }

    const nestedMessage = record.message;
    if (nestedMessage && typeof nestedMessage === "object") {
      const content = (nestedMessage as { content?: unknown }).content;
      if (Array.isArray(content)) {
        toolCallCount += content.filter(
          (item) =>
            item &&
            typeof item === "object" &&
            (item as { type?: unknown }).type === "tool_use",
        ).length;
      }
    }
  }

  return {
    ...(sawUsage ? { inputTokens, outputTokens } : {}),
    toolCallCount,
  };
}

function getSubagentStatusMeta(state: SubagentLaneMessage["state"]) {
  switch (state) {
    case "complete":
      return {
        label: "Complete",
        containerClass: "border-[#30363d] bg-[#161b22]",
        bodyTextClass: "text-[#c9d1d9]",
      };
    case "error":
      return {
        label: "Error",
        containerClass: "border-[#30363d] bg-[#161b22]",
        bodyTextClass: "text-[#f85149]",
      };
    case "running":
    default:
      return {
        label: "Running",
        containerClass: "border-[#30363d] bg-[#161b22]",
        bodyTextClass: "text-[#8b949e]",
      };
  }
}

function SubagentStatusIndicator({
  state,
  label,
}: {
  state: SubagentLaneMessage["state"];
  label: string;
}) {
  if (state === "running") {
    return (
      <span
        className="h-3.5 w-3.5 rounded-full border-2 border-[#58a6ff]/25 border-t-[#58a6ff] animate-spin"
        aria-label={label}
        title={label}
      />
    );
  }

  if (state === "complete") {
    return (
      <svg
        viewBox="0 0 16 16"
        className="h-3.5 w-3.5 text-[#3fb950]"
        fill="none"
        aria-label={label}
        title={label}
      >
        <path
          d="M3.25 8.25L6.25 11.25L12.75 4.75"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  return (
    <svg
      viewBox="0 0 16 16"
      className="h-3.5 w-3.5 text-[#f85149]"
      fill="none"
      aria-label={label}
      title={label}
    >
      <path
        d="M4.25 4.25L11.75 11.75M11.75 4.25L4.25 11.75"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

// --- Markdown components for assistant messages ---

const markdownComponents = {
  p: ({ children, ...props }: React.ComponentPropsWithoutRef<"p">) => (
    <p className="mb-2 last:mb-0" {...props}>
      {children}
    </p>
  ),
  strong: ({
    children,
    ...props
  }: React.ComponentPropsWithoutRef<"strong">) => (
    <strong className="font-bold text-[#e6edf3]" {...props}>
      {children}
    </strong>
  ),
  em: ({ children, ...props }: React.ComponentPropsWithoutRef<"em">) => (
    <em className="italic" {...props}>
      {children}
    </em>
  ),
  code: ({
    children,
    className,
    ...props
  }: React.ComponentPropsWithoutRef<"code"> & { className?: string }) => {
    const isBlock = className?.includes("language-");
    if (isBlock) {
      return (
        <code
          className={`block max-w-full bg-[#161b22] rounded px-3 py-2 text-xs whitespace-pre-wrap break-words overflow-x-auto my-1 ${className || ""}`}
          {...props}
        >
          {children}
        </code>
      );
    }
    return (
      <code
        className="bg-[#161b22] text-[#f0883e] rounded px-1 py-0.5 text-[0.85em] break-words"
        {...props}
      >
        {children}
      </code>
    );
  },
  pre: ({ children, ...props }: React.ComponentPropsWithoutRef<"pre">) => (
    <pre
      className="max-w-full bg-[#161b22] rounded-md overflow-x-auto my-2 text-sm whitespace-pre-wrap"
      {...props}
    >
      {children}
    </pre>
  ),
  ul: ({ children, ...props }: React.ComponentPropsWithoutRef<"ul">) => (
    <ul className="list-disc mb-2 pl-5 space-y-0.5" {...props}>
      {children}
    </ul>
  ),
  ol: ({ children, ...props }: React.ComponentPropsWithoutRef<"ol">) => (
    <ol className="list-decimal mb-2 pl-5 space-y-0.5" {...props}>
      {children}
    </ol>
  ),
  li: ({ children, ...props }: React.ComponentPropsWithoutRef<"li">) => (
    <li className="leading-relaxed [&>p]:inline [&>p]:m-0" {...props}>
      {children}
    </li>
  ),
  h1: ({ children, ...props }: React.ComponentPropsWithoutRef<"h1">) => (
    <h1 className="text-lg font-bold text-[#e6edf3] mt-3 mb-1" {...props}>
      {children}
    </h1>
  ),
  h2: ({ children, ...props }: React.ComponentPropsWithoutRef<"h2">) => (
    <h2 className="text-base font-bold text-[#e6edf3] mt-3 mb-1" {...props}>
      {children}
    </h2>
  ),
  h3: ({ children, ...props }: React.ComponentPropsWithoutRef<"h3">) => (
    <h3 className="text-sm font-bold text-[#e6edf3] mt-2 mb-1" {...props}>
      {children}
    </h3>
  ),
  a: ({ children, ...props }: React.ComponentPropsWithoutRef<"a">) => (
    <a
      className="text-[#58a6ff] hover:underline"
      target="_blank"
      rel="noopener noreferrer"
      {...props}
    >
      {children}
    </a>
  ),
  img: MarkdownImage,
  blockquote: ({
    children,
    ...props
  }: React.ComponentPropsWithoutRef<"blockquote">) => (
    <blockquote
      className="border-l-2 border-[#30363d] pl-3 text-[#8b949e] my-2"
      {...props}
    >
      {children}
    </blockquote>
  ),
  hr: (props: React.ComponentPropsWithoutRef<"hr">) => (
    <hr className="border-[#21262d] my-3" {...props} />
  ),
};

// --- Chat Message (user + assistant) ---

interface MessageAction {
  label: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  onClick: () => void;
  testId?: string;
}

function MessageActions({
  align,
  actions,
  timestamp,
  timestampPosition = "after",
}: {
  align: "left" | "right";
  actions: MessageAction[];
  timestamp?: number;
  timestampPosition?: "before" | "after";
}) {
  if (actions.length === 0) return null;
  const timestampElement =
    timestamp !== undefined ? (
      <TimestampComponent
        timestamp={timestamp}
        mode="absolute-short-relative"
        className="text-[11px] leading-none text-[#6e7681]"
      />
    ) : null;
  return (
    <div
      className={`mt-1 hidden md:flex items-center gap-1.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity duration-150 ${
        align === "right" ? "justify-end" : "justify-start"
      }`}
    >
      {timestampPosition === "before" && timestampElement}
      {actions.map((action) => {
        const Icon = action.icon;
        return (
          <button
            key={action.label}
            type="button"
            onClick={action.onClick}
            data-testid={action.testId}
            title={action.label}
            aria-label={action.label}
            className="p-1 rounded text-[#8b949e] hover:text-[#e6edf3] hover:bg-[#21262d] transition-colors"
          >
            <Icon className="w-3.5 h-3.5" />
          </button>
        );
      })}
      {timestampPosition === "after" && timestampElement}
    </div>
  );
}

function useCopyAction(content: string) {
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(() => {
    void navigator.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [content]);
  return { copied, handleCopy };
}

interface ChatMessageComponentProps {
  message: ChatMessage;
  isLastUserMessage?: boolean;
  onEdit?: (content: string) => void;
  onSendAgain?: (content: string) => void;
  /**
   * Visual variant for the user bubble.
   * - "user": regular blue (default)
   * - "parent-agent": purple, labeled "Parent agent" — used for the first
   *   user message in a subagent session, which is authored by the parent
   *   assistant, not a human.
   * - "loop": purple, labeled "Loop" — used for messages dispatched by a loop.
   */
  variant?: "user" | "parent-agent" | "loop";
}

export function ChatMessageComponent({
  message,
  isLastUserMessage = false,
  onEdit,
  onSendAgain,
  variant = "user",
}: ChatMessageComponentProps) {
  const isUser = message.role === "user";
  const [isExpanded, setIsExpanded] = useState(false);
  const [showSignIn, setShowSignIn] = useState(false);
  const { copied, handleCopy } = useCopyAction(message.content);
  const { canRetry, retry } = useLastUserRetry();

  if (isUser) {
    const isParentAgent = variant === "parent-agent";
    const isLoop = variant === "loop";
    const isPurple = isParentAgent || isLoop;
    const contentLines = splitMessageLines(message.content);
    const shouldFold = contentLines.length > COLLAPSED_USER_MESSAGE_LINES;
    const visibleContent =
      shouldFold && !isExpanded
        ? contentLines.slice(0, COLLAPSED_USER_MESSAGE_LINES).join("\n")
        : message.content;
    const actions: MessageAction[] = [
      {
        label: copied ? "Copied" : "Copy",
        icon: copied ? CheckIcon : ClipboardIcon,
        onClick: handleCopy,
        testId: "msg-action-copy",
      },
    ];
    if (!isPurple && isLastUserMessage && onEdit) {
      actions.push({
        label: "Edit",
        icon: PencilSquareIcon,
        onClick: () => onEdit(message.content),
        testId: "msg-action-edit",
      });
    }
    if (!isPurple && isLastUserMessage && onSendAgain) {
      actions.push({
        label: "Send again",
        icon: ArrowPathIcon,
        onClick: () => onSendAgain(message.content),
        testId: "msg-action-send-again",
      });
    }
    return (
      <div
        data-testid="chat-message-user"
        data-variant={variant}
        className="group mb-3 flex min-w-0 max-w-full flex-col items-end"
      >
        {isParentAgent && (
          <span className="text-[10px] uppercase tracking-wide text-[var(--accent-purple,#a371f7)] mb-0.5 mr-1">
            Parent agent
          </span>
        )}
        {isLoop && (
          <span className="text-[10px] uppercase tracking-wide text-[#a371f7] mb-0.5 mr-1">
            Loop
          </span>
        )}
        <div
          data-message-bubble="user"
          className={`min-w-0 max-w-[85%] overflow-hidden rounded-xl px-4 py-2 text-white sm:max-w-[70%] ${
            isPurple ? "bg-[#a371f7]" : "bg-[#1f6feb]"
          }`}
        >
          <pre
            data-message-body="user"
            className="m-0 max-w-full whitespace-pre-wrap break-words text-sm font-mono leading-relaxed [overflow-wrap:anywhere]"
          >
            {visibleContent}
          </pre>
          {message.assets && message.assets.length > 0 && (
            <div className="mt-2 flex flex-wrap justify-end gap-2">
              {message.assets.map((asset) => (
                <ImageThumbnail
                  key={asset.assetId}
                  asset={asset}
                  caption={
                    asset.sourceToolName === "attachment"
                      ? undefined
                      : asset.sourceToolName
                  }
                  compact
                />
              ))}
            </div>
          )}
          {shouldFold && (
            <button
              type="button"
              data-testid="user-message-fold-toggle"
              className={`mt-2 text-xs font-semibold underline-offset-2 hover:underline ${
                isPurple ? "text-[#f0e6ff]" : "text-[#c9e4ff]"
              }`}
              onClick={() => setIsExpanded((expanded) => !expanded)}
              aria-expanded={isExpanded}
            >
              {isExpanded ? "Show less" : "Show more"}
            </button>
          )}
          <span data-message-timestamp="user" className="block">
            <TimestampComponent
              timestamp={message.timestamp}
              className={`text-xs opacity-60 mt-1 block text-right ${
                isPurple ? "text-[#e5d5ff]" : "text-[#a5d6ff]"
              }`}
            />
          </span>
        </div>
        <MessageActions
          align="right"
          actions={actions}
          timestamp={message.timestamp}
          timestampPosition="before"
        />
      </div>
    );
  }

  const isAuthError = isProviderAuthError(message.content);
  const isTransientError = isTransientProviderError(message.content);
  const authProvider = inferAuthProvider(message.content);

  return (
    <div
      data-testid="chat-message-assistant"
      className="chat-markdown group mb-1 min-w-0 max-w-full text-sm text-[#e6edf3] leading-relaxed"
    >
      <Markdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
        {message.content}
      </Markdown>
      <MessageActions
        align="left"
        timestamp={message.timestamp}
        actions={[
          {
            label: copied ? "Copied" : "Copy",
            icon: copied ? CheckIcon : ClipboardIcon,
            onClick: handleCopy,
            testId: "msg-action-copy",
          },
        ]}
      />
      {isAuthError && (
        <button
          onClick={() => setShowSignIn(true)}
          className="mt-2 px-3 py-1.5 rounded-md text-xs font-medium bg-[#238636] text-white hover:bg-[#2ea043] transition-colors"
        >
          Sign in to {authProvider.name}
        </button>
      )}
      {!isAuthError && isTransientError && (
        <div className="mt-2 inline-flex items-center gap-2 rounded-md border border-[#d29922]/40 bg-[#3b2607]/20 px-2.5 py-1.5 text-xs text-[#d29922]">
          <span>Temporary provider error</span>
          {canRetry && (
            <button
              onClick={retry}
              className="inline-flex items-center gap-1 rounded border border-[#30363d] bg-[#161b22] px-2 py-0.5 font-medium text-[#c9d1d9] hover:bg-[#1f2630] transition-colors"
            >
              <ArrowPathIcon className="w-3 h-3" />
              Retry
            </button>
          )}
        </div>
      )}
      {showSignIn && (
        <SignInOverlay
          providerName={authProvider.name}
          command={authProvider.command}
          onClose={() => {
            setShowSignIn(false);
            invalidateProvidersCache();
          }}
        />
      )}
    </div>
  );
}

export function ImageMessageComponent({ message }: { message: ImageMessage }) {
  const isUser = message.role === "user";
  return (
    <div className={`group ${isUser ? "flex justify-end" : ""}`}>
      <div className={isUser ? "max-w-[80%]" : "max-w-md"}>
        <ImageThumbnail asset={message.asset} caption={message.caption} />
      </div>
    </div>
  );
}

// --- System Message ---

interface SystemMessageComponentProps {
  message: SystemMessage;
  hideStats?: boolean;
  taskUpdate?: TaskLifecycleUpdate;
  taskCommand?: string;
}

export function SystemMessageComponent({
  message,
  hideStats = false,
  taskUpdate,
  taskCommand,
}: SystemMessageComponentProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const rawResultTextForCopy =
    message.type === "result" &&
    typeof (message as Record<string, unknown>).result === "string"
      ? ((message as Record<string, unknown>).result as string)
      : "";
  const { copied, handleCopy } = useCopyAction(rawResultTextForCopy);

  if (message.type === "result") {
    const raw = message as Record<string, unknown>;
    const durationSec = ((raw.duration_ms as number) / 1000).toFixed(1);
    const cost = (raw.total_cost_usd as number).toFixed(2);
    const usage = raw.usage as {
      input_tokens: number;
      output_tokens: number;
    };
    const resultText = typeof raw.result === "string" ? raw.result.trim() : "";
    const subtype = typeof raw.subtype === "string" ? raw.subtype : "";
    const isError = raw.is_error === true || subtype.startsWith("error");
    const label = isError ? subtype || "error" : "done";

    // When hideStats is set, the duration/cost/tokens row has been rolled up
    // into the preceding tool-group summary line. If there's no extra result
    // text either, the card would be an empty "done" badge — skip it.
    if (hideStats && !resultText) {
      return null;
    }

    return (
      <div
        className="group my-2 inline-flex max-w-full flex-col items-start"
        data-testid="result-card"
      >
        <div
          className={`rounded-lg border px-3 py-2 max-w-full font-mono ${
            isError
              ? "border-[#da3633]/40 bg-[#da3633]/5"
              : "border-[#30363d] bg-[#161b22]/60"
          }`}
        >
          {!hideStats && (
            <div className="flex items-center gap-2 text-xs">
              <span
                className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                  isError ? "bg-[#da3633]" : "bg-[#3fb950]"
                }`}
              />
              <span
                className={`font-semibold ${
                  isError ? "text-[#ff7b72]" : "text-[#c9d1d9]"
                }`}
              >
                {label}
              </span>
              <span className="text-[#6e7681]">·</span>
              <span className="text-[#8b949e]">{durationSec}s</span>
              <span className="text-[#6e7681]">·</span>
              <span className="text-[#8b949e]">${cost}</span>
              <span className="text-[#6e7681]">·</span>
              <span className="text-[#8b949e]">
                {usage.input_tokens}in / {usage.output_tokens}out
              </span>
            </div>
          )}
          {resultText && (
            <div
              className={`chat-markdown ${hideStats ? "" : "mt-1.5"} text-sm leading-relaxed text-[#c9d1d9] font-sans`}
            >
              <Markdown
                remarkPlugins={[remarkGfm]}
                components={markdownComponents}
              >
                {resultText}
              </Markdown>
            </div>
          )}
        </div>
        {rawResultTextForCopy && (
          <MessageActions
            align="left"
            timestamp={message.timestamp}
            actions={[
              {
                label: copied ? "Copied" : "Copy",
                icon: copied ? CheckIcon : ClipboardIcon,
                onClick: handleCopy,
                testId: "result-action-copy",
              },
            ]}
          />
        )}
      </div>
    );
  }

  if (message.type === "error") {
    const errorMsg = (message as { message: string }).message || "";
    const isAuthError = isProviderAuthError(errorMsg);
    const isTransientError = isTransientProviderError(errorMsg);

    return (
      <ProviderErrorCard
        errorMsg={errorMsg}
        isAuthError={isAuthError}
        isTransientError={isTransientError}
      />
    );
  }

  if (isHooksMessage(message)) {
    const cleaned = message.content.replace(ANSI_REGEX, "");
    return (
      <div className="py-0.5">
        <span className="text-xs font-mono text-[#8b949e]">{cleaned}</span>
      </div>
    );
  }

  if (
    message.type === "system" &&
    "subtype" in message &&
    message.subtype === "wakeup_trigger"
  ) {
    return <WakeupTriggerMessage message={message} />;
  }

  if (
    message.type === "system" &&
    "subtype" in message &&
    message.subtype === "wakeup_armed"
  ) {
    return <WakeupArmedMessage message={message} />;
  }

  if (
    message.type === "system" &&
    "subtype" in message &&
    message.subtype === "loop_trigger"
  ) {
    return <LoopTriggerMessage message={message} />;
  }

  if (
    message.type === "system" &&
    "subtype" in message &&
    message.subtype === "loop_paused"
  ) {
    return <LoopPausedMessage message={message} />;
  }

  if (
    message.type === "system" &&
    "subtype" in message &&
    message.subtype === "model_no_final_message"
  ) {
    const text =
      "message" in message && typeof message.message === "string"
        ? message.message
        : "model didn't provide final message";
    return (
      <div className="py-0.5">
        <span className="text-xs font-mono text-[#8b949e]">{text}</span>
      </div>
    );
  }

  if (
    message.type === "system" &&
    "subtype" in message &&
    message.subtype === "api_retry"
  ) {
    return <ApiRetryMessage message={message} />;
  }

  const isInit =
    message.type === "system" &&
    "subtype" in message &&
    message.subtype === "init";

  if (isInit) {
    const modelName = "model" in message ? String(message.model) : "unknown";
    const details = [
      `Model: ${modelName}`,
      `Session: ${"session_id" in message ? String(message.session_id).substring(0, MESSAGE_CONSTANTS.SESSION_ID_DISPLAY_LENGTH) : ""}`,
      `Tools: ${"tools" in message && Array.isArray(message.tools) ? message.tools.length : 0} available`,
      `CWD: ${"cwd" in message ? String(message.cwd) : ""}`,
      `Permission Mode: ${"permissionMode" in message ? String(message.permissionMode) : ""}`,
    ].join("\n");

    return (
      <div className="py-0.5">
        <span
          className="text-xs font-mono text-[#8b949e] cursor-pointer hover:text-[#c9d1d9]"
          onClick={() => setIsExpanded(!isExpanded)}
        >
          {isExpanded ? "v" : ">"} session: {modelName}
        </span>
        {isExpanded && (
          <pre className="text-xs font-mono text-[#8b949e] mt-1 ml-4 whitespace-pre-wrap">
            {details}
          </pre>
        )}
      </div>
    );
  }

  if (
    message.type === "system" &&
    "subtype" in message &&
    (message.subtype === "task_started" || message.subtype === "task_updated")
  ) {
    return (
      <TaskLifecycleMessage
        message={message}
        taskUpdate={message.subtype === "task_started" ? taskUpdate : undefined}
        taskCommand={
          message.subtype === "task_started" ? taskCommand : undefined
        }
      />
    );
  }

  if (
    message.type === "system" &&
    "subtype" in message &&
    message.subtype === "abort"
  ) {
    return (
      <div className="my-2 flex">
        <div className="rounded-lg border border-[#da3633]/40 bg-[#da3633]/5 px-3 py-2 font-mono">
          <div className="flex items-center gap-2 text-xs">
            <span className="w-1.5 h-1.5 rounded-full shrink-0 bg-[#da3633]" />
            <span className="font-semibold text-[#ff7b72]">agent aborted</span>
          </div>
        </div>
      </div>
    );
  }

  if (
    message.type === "system" &&
    "subtype" in message &&
    message.subtype === "runner_interrupted"
  ) {
    return <RunnerInterruptedCard message={message} />;
  }

  return (
    <div className="py-0.5">
      <span
        className="text-xs font-mono text-[#8b949e] cursor-pointer hover:text-[#c9d1d9]"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        {isExpanded ? "v" : ">"} system
      </span>
      {isExpanded && (
        <pre className="text-xs font-mono text-[#8b949e] mt-1 ml-4 whitespace-pre-wrap">
          {JSON.stringify(message, null, 2)}
        </pre>
      )}
    </div>
  );
}

function formatRetryDelay(ms: unknown): string {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) {
    return "soon";
  }
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
}

function ApiRetryMessage({ message }: { message: SystemMessage }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const raw = message as Record<string, unknown>;
  const attempt = typeof raw.attempt === "number" ? raw.attempt : undefined;
  const maxRetries =
    typeof raw.max_retries === "number" ? raw.max_retries : undefined;
  const status =
    typeof raw.error_status === "number" ? String(raw.error_status) : "error";
  const error =
    typeof raw.error === "string" && raw.error.trim()
      ? raw.error.trim()
      : "api_error";
  const attemptText =
    attempt !== undefined && maxRetries !== undefined
      ? `${attempt}/${maxRetries}`
      : attempt !== undefined
        ? String(attempt)
        : "retry";

  return (
    <div className="py-0.5">
      <ToolCallLine
        toolName="ApiRetry"
        argsText={`${status}, ${error}`}
        resultText={`${attemptText} in ${formatRetryDelay(raw.retry_delay_ms)}`}
        toolColor="text-[#8b949e]"
        isExpanded={isExpanded}
        onToggle={() => setIsExpanded((value) => !value)}
      />
      {isExpanded && (
        <pre className="text-xs font-mono text-[#8b949e] mt-1 ml-4 whitespace-pre-wrap max-h-[400px] overflow-y-auto">
          {JSON.stringify(message, null, 2)}
        </pre>
      )}
    </div>
  );
}

function WakeupTriggerMessage({ message }: { message: SystemMessage }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const raw = message as Record<string, unknown>;
  const wakeupKind =
    typeof raw.wakeup_kind === "string" ? raw.wakeup_kind : "scheduled_wakeup";
  const reason =
    typeof raw.reason === "string" && raw.reason.trim()
      ? raw.reason.trim()
      : "resume";
  const terminalReason =
    typeof raw.terminal_reason === "string" ? raw.terminal_reason : "";
  const toolName =
    typeof raw.tool_name === "string" && raw.tool_name.trim()
      ? raw.tool_name.trim()
      : wakeupKind === "wait_until"
        ? "mcp__swarmfleet__wait_until"
        : "mcp__swarmfleet__schedule_wakeup";
  const toolInput =
    raw.tool_input && typeof raw.tool_input === "object"
      ? (raw.tool_input as Record<string, unknown>)
      : {};
  const prompt = typeof raw.prompt === "string" ? raw.prompt.trim() : "";
  const status =
    wakeupKind === "wait_until" && terminalReason ? terminalReason : "fired";
  const displayedCall = getDisplayedToolCall(toolName, toolInput);
  const inputPreview = JSON.stringify(toolInput, null, 2);

  return (
    <div className="my-1.5 inline-flex max-w-full flex-col items-start">
      <div className="w-full max-w-full rounded-md border border-[#30363d] bg-[#161b22]/60 px-2.5 py-1.5 font-mono text-xs">
        <ToolCallLine
          toolName={displayedCall.toolName}
          argsText={displayedCall.argsText}
          resultText={status}
          toolColor={getToolColor(displayedCall.colorName)}
          isExpanded={isExpanded}
          onToggle={() => setIsExpanded((value) => !value)}
        />
        {isExpanded && (
          <div className="mt-2 space-y-2 border-t border-[#30363d] pt-2">
            <div className="text-[#8b949e]">{reason}</div>
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words text-[#8b949e]">
              {inputPreview}
            </pre>
            {prompt && (
              <div className="max-h-40 overflow-auto whitespace-pre-wrap break-words text-[#c9d1d9]">
                {prompt}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function WakeupArmedMessage({ message }: { message: SystemMessage }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const raw = message as Record<string, unknown>;
  const wakeupKind =
    typeof raw.wakeup_kind === "string" ? raw.wakeup_kind : "scheduled_wakeup";
  const reason =
    typeof raw.reason === "string" && raw.reason.trim()
      ? raw.reason.trim()
      : "resume";
  const toolName =
    typeof raw.tool_name === "string" && raw.tool_name.trim()
      ? raw.tool_name.trim()
      : wakeupKind === "wait_until"
        ? "mcp__swarmfleet__wait_until"
        : "mcp__swarmfleet__schedule_wakeup";
  const toolInput =
    raw.tool_input && typeof raw.tool_input === "object"
      ? (raw.tool_input as Record<string, unknown>)
      : {};
  const displayedCall = getDisplayedToolCall(toolName, toolInput);
  const inputPreview = JSON.stringify(toolInput, null, 2);

  return (
    <div className="my-1.5 inline-flex max-w-full flex-col items-start">
      <div className="w-full max-w-full rounded-md border border-[#30363d] bg-[#161b22]/60 px-2.5 py-1.5 font-mono text-xs">
        <ToolCallLine
          toolName={displayedCall.toolName}
          argsText={displayedCall.argsText}
          resultText="armed"
          toolColor={getToolColor(displayedCall.colorName)}
          isExpanded={isExpanded}
          onToggle={() => setIsExpanded((value) => !value)}
        />
        {isExpanded && (
          <div className="mt-2 space-y-2 border-t border-[#30363d] pt-2">
            <div className="text-[#8b949e]">{reason}</div>
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words text-[#8b949e]">
              {inputPreview}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}

function LoopTriggerMessage({ message }: { message: SystemMessage }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const raw = message as Record<string, unknown>;
  const loopName = typeof raw.loop_name === "string" ? raw.loop_name : "Loop";
  const iteration = typeof raw.iteration === "number" ? raw.iteration : 0;
  const strategy = typeof raw.strategy === "string" ? raw.strategy : "";
  const prompt = typeof raw.prompt === "string" ? raw.prompt.trim() : "";

  return (
    <div className="my-1.5 inline-flex max-w-full flex-col items-start">
      <div
        className="w-full max-w-full rounded-md border border-[#a371f7]/30 bg-[#a371f7]/5 px-2.5 py-1.5 font-mono text-xs cursor-pointer select-none"
        onClick={() => setIsExpanded((v) => !v)}
      >
        <div className="flex items-center gap-2">
          <span className="text-[#a371f7]">⟳</span>
          <span className="text-[#a371f7] font-medium">{loopName}</span>
          <span className="text-[#8b949e]">iteration {iteration}</span>
          {strategy && <span className="text-[#8b949e]">· {strategy}</span>}
          <span className="text-[#484f58] ml-auto">
            {isExpanded ? "▾" : "▸"}
          </span>
        </div>
        {isExpanded && prompt && (
          <div className="mt-2 pt-2 border-t border-[#a371f7]/20">
            <div className="text-[#c9d1d9] whitespace-pre-wrap break-words max-h-40 overflow-auto">
              {prompt}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function LoopPausedMessage({ message }: { message: SystemMessage }) {
  const raw = message as Record<string, unknown>;
  const loopName = typeof raw.loop_name === "string" ? raw.loop_name : "Loop";
  const reason = typeof raw.reason === "string" ? raw.reason : "paused";

  return (
    <div className="my-1.5 inline-flex max-w-full flex-col items-start">
      <div className="w-full max-w-full rounded-md border border-[#a371f7]/30 bg-[#a371f7]/5 px-2.5 py-1.5 font-mono text-xs">
        <div className="flex items-center gap-2">
          <span className="text-[#a371f7]">⏸</span>
          <span className="text-[#a371f7] font-medium">{loopName}</span>
          <span className="text-[#8b949e]">
            auto-paused · {reason.replace(/_/g, " ")}
          </span>
        </div>
      </div>
    </div>
  );
}

function TaskLifecycleMessage({
  message,
  taskUpdate,
  taskCommand,
}: {
  message: SystemMessage;
  taskUpdate?: TaskLifecycleUpdate;
  taskCommand?: string;
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);
  const sessionId = useChatStore((state) => state.sessionId);
  const raw = message as Record<string, unknown>;
  const subtype = typeof raw.subtype === "string" ? raw.subtype : "";
  const taskId = typeof raw.task_id === "string" ? raw.task_id : "";
  const toolUseId = typeof raw.tool_use_id === "string" ? raw.tool_use_id : "";
  const taskType = typeof raw.task_type === "string" ? raw.task_type : "task";
  const description =
    typeof raw.description === "string" && raw.description.trim()
      ? raw.description.trim()
      : taskType;
  const patch =
    raw.patch && typeof raw.patch === "object"
      ? (raw.patch as Record<string, unknown>)
      : null;
  const ownStatus =
    typeof patch?.status === "string" ? patch.status : undefined;
  const ownEndTime =
    typeof patch?.end_time === "number" ? patch.end_time : undefined;
  const status =
    taskUpdate?.status ??
    ownStatus ??
    (subtype === "task_started" ? "running" : "updated");
  const endTime = taskUpdate?.endTime ?? ownEndTime;
  const startedAt =
    typeof raw.timestamp === "number" ? raw.timestamp : undefined;
  const elapsedMs =
    startedAt !== undefined && endTime !== undefined && endTime >= startedAt
      ? endTime - startedAt
      : undefined;
  const isError = /fail|error|cancel|abort/i.test(status);
  const isDone = /complete|success|done/i.test(status);
  const dotClass = isError
    ? "bg-[#f85149]"
    : isDone
      ? "bg-[#3fb950]"
      : "bg-[#58a6ff]";
  const statusClass = isError
    ? "text-[#ff7b72]"
    : isDone
      ? "text-[#3fb950]"
      : "text-[#8b949e]";
  const label =
    subtype === "task_started"
      ? taskType === "local_bash"
        ? "background shell task"
        : `background ${taskType}`
      : "background task update";
  const canForceStop =
    subtype === "task_started" &&
    Boolean(sessionId && taskId && taskCommand && !isDone && !isError);

  const handleForceStop = async (
    event: React.MouseEvent<HTMLButtonElement>,
  ) => {
    event.stopPropagation();
    if (!sessionId || !taskId || !taskCommand || isStopping) return;
    setIsStopping(true);
    setStopError(null);
    try {
      const response = await fetch(getSessionTaskStopUrl(sessionId, taskId), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: taskCommand }),
      });
      if (!response.ok) {
        let messageText = `Failed to stop task (${response.status})`;
        try {
          const payload = (await response.json()) as { error?: unknown };
          if (typeof payload.error === "string" && payload.error.trim()) {
            messageText = payload.error;
          }
        } catch {
          // Keep the status-derived fallback.
        }
        throw new Error(messageText);
      }
    } catch (error) {
      setStopError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsStopping(false);
    }
  };

  return (
    <div className="my-1.5 inline-flex max-w-full flex-col items-start">
      <div className="max-w-full rounded-md border border-[#30363d] bg-[#161b22]/60 px-2.5 py-1.5 font-mono text-xs">
        <div className="flex max-w-full items-center gap-2">
          <button
            type="button"
            onClick={() => setIsExpanded((value) => !value)}
            className="flex min-w-0 flex-1 items-center gap-2 text-left"
            title={taskId ? `Task ${taskId}` : undefined}
          >
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dotClass}`} />
            <span className="shrink-0 font-semibold text-[#c9d1d9]">
              {label}
            </span>
            <span className="min-w-0 truncate text-[#8b949e]">
              {description}
            </span>
            <span className={`shrink-0 ${statusClass}`}>{status}</span>
            {elapsedMs !== undefined && (
              <span className="shrink-0 text-[#6e7681]">
                {(elapsedMs / 1000).toFixed(elapsedMs < 60_000 ? 1 : 0)}s
              </span>
            )}
          </button>
          {canForceStop && (
            <button
              type="button"
              onClick={handleForceStop}
              disabled={isStopping}
              className="shrink-0 rounded border border-[#da3633]/40 bg-[#3d1214]/60 px-2 py-0.5 text-[11px] font-semibold text-[#ff7b72] hover:bg-[#4a171a] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isStopping ? "Stopping" : "Force stop"}
            </button>
          )}
        </div>
        {taskCommand && (
          <pre
            className="mt-1 max-h-[2.5rem] max-w-full overflow-hidden whitespace-pre-wrap break-words rounded border border-[#21262d] bg-[#0d1117] px-2 py-1 text-[11px] leading-4 text-[#8b949e]"
            title={taskCommand}
          >
            {taskCommand}
          </pre>
        )}
        {stopError && (
          <div className="mt-1 text-[11px] text-[#ff7b72]">{stopError}</div>
        )}
      </div>
      {isExpanded && (
        <pre className="mt-1 ml-4 max-h-[400px] overflow-y-auto whitespace-pre-wrap border-l border-[#21262d] pl-2 text-xs font-mono text-[#8b949e]">
          {JSON.stringify(
            {
              task_id: taskId || undefined,
              tool_use_id: toolUseId || undefined,
              task_type: taskType,
              command: taskCommand,
              status,
              end_time: endTime,
              raw: message,
            },
            null,
            2,
          )}
        </pre>
      )}
    </div>
  );
}

function isInterruptedRetryContinuation(messages: AllMessage[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];

    if (
      message.type === "system" &&
      "subtype" in message &&
      message.subtype === "runner_interrupted"
    ) {
      continue;
    }

    if (isChatMessage(message)) {
      return false;
    }

    if (
      message.type === "tool" ||
      message.type === "tool_result" ||
      message.type === "subagent_lane" ||
      message.type === "todo"
    ) {
      return true;
    }

    if (message.type === "result") {
      return false;
    }
  }

  return false;
}

function RunnerInterruptedCard({ message }: { message: SystemMessage }) {
  const currentProject = useAppStore((state) => state.currentProject);
  const messages = useChatStore((state) => state.messages);
  const phase = useChatStore((state) => state.phase);
  const canRetry =
    phase !== "streaming" &&
    phase !== "awaiting-permission" &&
    phase !== "loading-history";
  const workingDirectory = currentProject?.path
    ? normalizeWindowsPath(currentProject.path)
    : undefined;
  const encodedName = currentProject?.encodedName ?? null;

  const lastUserText = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (isChatMessage(m) && m.role === "user") return m.content;
    }
    return null;
  }, [messages]);
  const retryText = useMemo(
    () => (isInterruptedRetryContinuation(messages) ? "go on" : lastUserText),
    [lastUserText, messages],
  );

  const errorText =
    "message" in message &&
    typeof (message as Record<string, unknown>).message === "string"
      ? ((message as Record<string, unknown>).message as string)
      : "Session runner stopped unexpectedly";

  const handleRetry = useCallback(() => {
    if (!canRetry || !retryText) return;
    void sendMessage(
      workingDirectory,
      encodedName,
      retryText,
      undefined,
      true,
      undefined,
      undefined,
      { skipTranscript: true },
    );
  }, [canRetry, retryText, workingDirectory, encodedName]);

  return (
    <div className="my-2 flex">
      <div className="rounded-lg border border-[#d29922]/40 bg-[#3b2607]/20 px-3 py-2 font-mono max-w-full">
        <div className="flex items-center gap-2 text-xs">
          <span className="w-1.5 h-1.5 rounded-full shrink-0 bg-[#d29922]" />
          <span className="font-semibold text-[#d29922]">interrupted</span>
          <span className="text-[#6e7681]">·</span>
          <span className="text-[#8b949e] font-sans">{errorText}</span>
        </div>
        {lastUserText && canRetry && (
          <div className="mt-2">
            <button
              onClick={handleRetry}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded text-[11px] font-medium border border-[#30363d] bg-[#161b22] text-[#c9d1d9] hover:bg-[#1f2630] transition-colors"
            >
              <ArrowPathIcon className="w-3 h-3" />
              Retry
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// --- Tool Message ---

interface ToolMessageComponentProps {
  message: ToolMessage;
  projectPath?: string | null;
}

function ClickablePaths({
  text,
  projectPath,
}: {
  text: string;
  projectPath: string | null;
}) {
  const navigate = useNavigate();
  const location = useLocation();

  const handlePathClick = useCallback(
    (filePath: string, e: React.MouseEvent) => {
      e.stopPropagation();
      const base = projectPath || "";
      const absPath = filePath.startsWith("/")
        ? filePath
        : `${base}/${filePath}`;
      const projectName = getProjectNameFromPathname(location.pathname);
      navigate(
        `/files/${projectName}?panel=editor&file=${encodeURIComponent(absPath)}`,
      );
    },
    [projectPath, location.pathname, navigate],
  );

  const displayed = stripProjectPrefix(text, projectPath ?? null);
  const paths = extractPaths(displayed);

  if (paths.length === 0) return <>{displayed}</>;

  const segments: ReactNode[] = [];
  let lastEnd = 0;
  for (let i = 0; i < paths.length; i++) {
    const p = paths[i];
    if (p.start > lastEnd) {
      segments.push(
        <span key={`t${i}`}>{displayed.slice(lastEnd, p.start)}</span>,
      );
    }
    segments.push(
      <span
        key={`p${i}`}
        className="text-[#58a6ff] hover:underline cursor-pointer"
        onClick={(e) => handlePathClick(p.path, e)}
        title={p.path}
      >
        {p.path}
      </span>,
    );
    lastEnd = p.end;
  }
  if (lastEnd < displayed.length) {
    segments.push(<span key="tail">{displayed.slice(lastEnd)}</span>);
  }

  return <>{segments}</>;
}

function ProviderErrorCard({
  errorMsg,
  isAuthError,
  isTransientError,
}: {
  errorMsg: string;
  isAuthError: boolean;
  isTransientError: boolean;
}) {
  const [showSignIn, setShowSignIn] = useState(false);
  const authProvider = inferAuthProvider(errorMsg);
  const { canRetry, retry } = useLastUserRetry();
  const isWarning = !isAuthError && isTransientError;

  return (
    <div
      className={`py-1 px-2 my-1 rounded border ${
        isWarning
          ? "bg-[#3b2607]/20 border-[#d29922]/40"
          : "bg-[#f8514910] border-[#f8514920]"
      }`}
    >
      {isWarning && (
        <div className="mb-1 flex items-center gap-2 text-xs font-semibold text-[#d29922]">
          <span className="w-1.5 h-1.5 rounded-full shrink-0 bg-[#d29922]" />
          <span>Temporary provider error</span>
        </div>
      )}
      <pre
        className={`text-xs font-mono whitespace-pre-wrap break-words ${
          isWarning ? "text-[#d29922]" : "text-[#f85149]"
        }`}
      >
        {errorMsg}
      </pre>
      {isAuthError && (
        <button
          onClick={() => setShowSignIn(true)}
          className="mt-2 mb-1 px-3 py-1.5 rounded-md text-xs font-medium bg-[#238636] text-white hover:bg-[#2ea043] transition-colors"
        >
          Sign in to {authProvider.name}
        </button>
      )}
      {isWarning && canRetry && (
        <button
          onClick={retry}
          className="mt-2 mb-1 inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-[11px] font-medium border border-[#30363d] bg-[#161b22] text-[#c9d1d9] hover:bg-[#1f2630] transition-colors"
        >
          <ArrowPathIcon className="w-3 h-3" />
          Retry
        </button>
      )}
      {showSignIn && (
        <SignInOverlay
          providerName={authProvider.name}
          command={authProvider.command}
          onClose={() => {
            setShowSignIn(false);
            invalidateProvidersCache();
          }}
        />
      )}
    </div>
  );
}

export function ToolMessageComponent({
  message,
  projectPath,
}: ToolMessageComponentProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  const toolName = message.toolName || message.content.split("(")[0] || "Tool";
  const args = message.toolInput || {};
  const displayedCall = useMemo(
    () => getDisplayedToolCall(toolName, args),
    [toolName, args],
  );
  const displaySummary = stripProjectPrefix(
    displayedCall.argsText,
    projectPath ?? null,
  );
  const toolColor = getToolColor(displayedCall.colorName);

  return (
    <div data-testid="tool-call" data-tool-name={toolName} className="py-0.5">
      <div className="flex items-center min-w-0">
        <ToolCallLine
          toolName={displayedCall.toolName}
          argsText={displaySummary}
          toolColor={toolColor}
          isExpanded={isExpanded}
          onToggle={() => setIsExpanded((value) => !value)}
        />
      </div>
      {isExpanded && (
        <pre className="text-xs font-mono text-[#8b949e] mt-1 ml-4 whitespace-pre-wrap max-h-[400px] overflow-y-auto border-l border-[#21262d] pl-2">
          {JSON.stringify(args, null, 2)}
        </pre>
      )}
    </div>
  );
}

// --- Tool Result Message ---

interface ToolResultMessageComponentProps {
  message: ToolResultMessage;
  projectPath?: string | null;
}

export function ToolResultMessageComponent({
  message,
  projectPath,
}: ToolResultMessageComponentProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const toolUseResult = message.toolUseResult;

  let summaryLine = "";
  let isError = false;
  let fullContent = message.content;

  if (message.toolName === "Edit" && isEditToolUseResult(toolUseResult)) {
    const editResult = createEditResult(
      toolUseResult.structuredPatch,
      message.content,
      20,
    );
    summaryLine = editResult.summary || message.summary || "ok";
    fullContent = editResult.details;
  } else if (message.toolName === "ScheduleWakeup") {
    summaryLine =
      formatScheduleWakeupResultSummary(toolUseResult) ||
      message.summary ||
      "scheduled";
    fullContent =
      summaryLine === message.content
        ? message.content
        : `${summaryLine}\n${message.content}`;
  } else if (
    message.toolName === "Bash" &&
    isBashToolUseResult(toolUseResult)
  ) {
    const hasStderr = Boolean(toolUseResult.stderr?.trim());
    isError = hasStderr;
    if (hasStderr) {
      const firstLine = toolUseResult.stderr.trim().split("\n")[0];
      summaryLine = firstLine;
    } else {
      const stdout = toolUseResult.stdout?.trim() || "";
      const lines = stdout.split("\n").filter((line) => line.trim());
      summaryLine =
        lines.length > 1 ? `${lines.length} lines` : (lines[0] ?? "");
      if (!summaryLine) summaryLine = "(empty)";
    }
    fullContent =
      (toolUseResult.stdout || "") +
      (toolUseResult.stderr ? "\nSTDERR:\n" + toolUseResult.stderr : "");
  } else {
    const detachedShellSummary = formatDetachedShellResultSummary(
      message.toolName,
      message.content,
      message.summary,
    );
    if (detachedShellSummary) {
      summaryLine = detachedShellSummary.summary;
      isError = detachedShellSummary.isError;
    } else if (message.summary) {
      summaryLine = message.summary;
    } else {
      const firstLine = message.content.trim().split("\n")[0];
      summaryLine = firstLine;
      if (!summaryLine) summaryLine = "ok";
    }
  }

  const args = message.toolInput || {};
  const displayedCall = useMemo(
    () => getDisplayedToolCall(message.toolName, args),
    [message.toolName, args],
  );
  const displaySummary = stripProjectPrefix(
    displayedCall.argsText,
    projectPath ?? null,
  );

  return (
    <div
      data-testid="tool-result"
      data-tool-name={message.toolName}
      data-error={isError ? "true" : "false"}
      className="py-0.5"
    >
      <ToolCallLine
        toolName={displayedCall.toolName}
        argsText={displaySummary}
        resultText={summaryLine}
        resultIsError={isError}
        toolColor={getToolColor(displayedCall.colorName)}
        isExpanded={isExpanded}
        onToggle={() => setIsExpanded((value) => !value)}
      />
      {message.assets && message.assets.length > 0 && (
        <div className="mt-1 ml-4 flex flex-wrap gap-2">
          {message.assets.map((asset) => (
            <ImageThumbnail
              key={asset.assetId}
              asset={asset}
              caption={asset.sourceToolName || "Screenshot"}
              compact
            />
          ))}
        </div>
      )}
      {isExpanded && (
        <pre className="text-xs font-mono text-[#8b949e] mt-1 ml-4 whitespace-pre-wrap max-h-[400px] overflow-y-auto">
          {fullContent}
        </pre>
      )}
    </div>
  );
}

// --- Inline Tool Call Row (tool + result on a single line) ---
//
// Used inside the folded tool_group. Renders the tool call label and its
// paired result summary on one line; click to expand both the tool arguments
// and the full result body below.

interface InlineToolCallRowProps {
  tool: ToolMessage;
  result?: ToolResultMessage;
  projectPath?: string | null;
}

export function InlineToolCallRow({
  tool,
  result,
  projectPath,
}: InlineToolCallRowProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const toolName = tool.toolName || tool.content.split("(")[0] || "Tool";
  const args = tool.toolInput || {};
  const displayedCall = useMemo(
    () => getDisplayedToolCall(toolName, args),
    [toolName, args],
  );
  const displaySummary = stripProjectPrefix(
    displayedCall.argsText,
    projectPath ?? null,
  );
  const toolColor = getToolColor(displayedCall.colorName);

  let resultSummary = "";
  let resultIsError = false;
  let resultFullContent = "";
  if (result) {
    const toolUseResult = result.toolUseResult;
    if (result.toolName === "Edit" && isEditToolUseResult(toolUseResult)) {
      const editResult = createEditResult(
        toolUseResult.structuredPatch,
        result.content,
        20,
      );
      resultSummary = editResult.summary || result.summary || "ok";
      resultFullContent = editResult.details;
    } else if (result.toolName === "ScheduleWakeup") {
      resultSummary =
        formatScheduleWakeupResultSummary(toolUseResult) ||
        result.summary ||
        "scheduled";
      resultFullContent =
        resultSummary === result.content
          ? result.content
          : `${resultSummary}\n${result.content}`;
    } else if (
      result.toolName === "Bash" &&
      isBashToolUseResult(toolUseResult)
    ) {
      const hasStderr = Boolean(toolUseResult.stderr?.trim());
      resultIsError = hasStderr;
      const line = hasStderr
        ? toolUseResult.stderr.trim().split("\n")[0]
        : (toolUseResult.stdout?.trim() || "").split("\n")[0];
      if (hasStderr) {
        resultSummary = line;
      } else {
        const lines = (toolUseResult.stdout?.trim() || "")
          .split("\n")
          .filter((entry) => entry.trim());
        resultSummary =
          lines.length > 1 ? `${lines.length} lines` : line || "(empty)";
      }
      resultFullContent =
        (toolUseResult.stdout || "") +
        (toolUseResult.stderr ? "\nSTDERR:\n" + toolUseResult.stderr : "");
    } else {
      const detachedShellSummary = formatDetachedShellResultSummary(
        result.toolName,
        result.content,
        result.summary,
      );
      if (detachedShellSummary) {
        resultSummary = detachedShellSummary.summary;
        resultIsError = detachedShellSummary.isError;
      } else if (result.summary) {
        resultSummary = result.summary;
      } else {
        const line = result.content.trim().split("\n")[0];
        resultSummary = line || "ok";
      }
      resultFullContent = result.content;
    }
  }

  return (
    <div
      data-testid="tool-call"
      data-tool-name={toolName}
      data-error={resultIsError ? "true" : "false"}
      className="py-0.5"
    >
      <ToolCallLine
        toolName={displayedCall.toolName}
        argsText={displaySummary}
        resultText={result ? resultSummary : undefined}
        resultIsError={resultIsError}
        toolColor={toolColor}
        isExpanded={isExpanded}
        onToggle={() => setIsExpanded((value) => !value)}
      />
      {result?.assets && result.assets.length > 0 && (
        <div className="mt-1 ml-4 flex flex-wrap gap-2">
          {result.assets.map((asset) => (
            <ImageThumbnail
              key={asset.assetId}
              asset={asset}
              caption={asset.sourceToolName || "Screenshot"}
              compact
            />
          ))}
        </div>
      )}
      {isExpanded && (
        <div className="mt-1 ml-4 border-l border-[#21262d] pl-2 space-y-1">
          <pre className="text-xs font-mono text-[#8b949e] whitespace-pre-wrap max-h-[400px] overflow-y-auto">
            {JSON.stringify(args, null, 2)}
          </pre>
          {result && (
            <pre
              className={`text-xs font-mono whitespace-pre-wrap max-h-[400px] overflow-y-auto ${
                resultIsError ? "text-[#f85149]" : "text-[#8b949e]"
              }`}
            >
              {resultFullContent || resultSummary}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

// --- Inline Prose Row (assistant narration with trailing copy button) ---

export function InlineProseRow({
  content,
  timestamp,
}: {
  content: string;
  timestamp?: number;
}) {
  const { copied, handleCopy } = useCopyAction(content);
  const Icon = copied ? CheckIcon : ClipboardIcon;
  return (
    <div className="group py-0.5 text-sm text-[#e6edf3] leading-relaxed">
      <div className="chat-markdown min-w-0">
        <Markdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
          {content}
        </Markdown>
      </div>
      <div className="mt-1 inline-flex items-center gap-1.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
        <button
          type="button"
          onClick={handleCopy}
          aria-label={copied ? "Copied" : "Copy"}
          title={copied ? "Copied" : "Copy"}
          className="inline-flex p-0.5 rounded text-[#484f58] hover:text-[#c9d1d9] hover:bg-[#21262d]"
        >
          <Icon className="w-3 h-3" />
        </button>
        {timestamp !== undefined && (
          <TimestampComponent
            timestamp={timestamp}
            mode="absolute-short-relative"
            className="text-[11px] leading-none text-[#6e7681]"
          />
        )}
      </div>
    </div>
  );
}

// --- Plan Message ---

interface PlanMessageComponentProps {
  message: PlanMessage;
}

const PLAN_PREVIEW_LINES = 10;

export function PlanMessageComponent({ message }: PlanMessageComponentProps) {
  const planModeRequest = useChatStore((state) => state.planModeRequest);
  const currentProject = useAppStore((state) => state.currentProject);
  const workingDirectory = currentProject?.path;
  const encodedName = currentProject?.encodedName ?? null;

  const lines = message.plan.split("\n");
  const hasMore = lines.length > PLAN_PREVIEW_LINES;
  const [expanded, setExpanded] = useState(!hasMore);

  const isPending =
    planModeRequest?.isOpen === true &&
    (planModeRequest.toolUseId === undefined ||
      planModeRequest.toolUseId === "" ||
      planModeRequest.toolUseId === message.toolUseId);

  const visiblePlan = expanded
    ? message.plan
    : lines.slice(0, PLAN_PREVIEW_LINES).join("\n");

  const handleApprove = useCallback(() => {
    const store = useChatStore.getState();
    store.setPermissionMode("bypassPermissions");
    void sendMessage(
      workingDirectory,
      encodedName,
      "accept",
      store.allowedTools,
      true,
      "bypassPermissions",
    );
  }, [workingDirectory, encodedName]);

  return (
    <div className="my-2 border-l-2 border-[#30363d] pl-3">
      <div className="text-xs font-mono text-[#8b949e] mb-1">plan</div>
      <div className="chat-markdown text-sm text-[#e6edf3] leading-relaxed prose prose-invert max-w-none prose-sm">
        <Markdown remarkPlugins={[remarkGfm]}>{visiblePlan}</Markdown>
      </div>
      {hasMore && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-2 text-xs font-mono text-[#58a6ff] hover:text-[#79c0ff] cursor-pointer"
        >
          {expanded
            ? "Show less"
            : `Show more (${lines.length - PLAN_PREVIEW_LINES} more lines)`}
        </button>
      )}
      {isPending && (
        <div className="mt-3">
          <button
            type="button"
            onClick={handleApprove}
            className="px-3 py-1.5 rounded-md bg-[#238636] hover:bg-[#2ea043] text-white text-sm font-medium cursor-pointer transition-colors"
          >
            Approve plan
          </button>
          <span className="ml-3 text-xs text-[#8b949e]">
            or type below to push back
          </span>
        </div>
      )}
    </div>
  );
}

// --- Thinking Message ---

interface ThinkingMessageComponentProps {
  message: ThinkingMessage;
  nextMessage?: AllMessage;
}

export function ThinkingMessageComponent({
  message,
  nextMessage,
}: ThinkingMessageComponentProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  let durationLabel = "thinking...";
  if (nextMessage && nextMessage.timestamp) {
    const deltaSec = (nextMessage.timestamp - message.timestamp) / 1000;
    if (deltaSec > 5) {
      durationLabel = `thinking (${Math.round(deltaSec)}s)`;
    }
  }

  return (
    <div className="py-0.5">
      <span
        className="text-xs font-mono text-[#8b949e] italic cursor-pointer hover:text-[#c9d1d9]"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        {isExpanded ? "v" : ">"} {durationLabel}
      </span>
      {isExpanded && (
        <pre className="text-xs font-mono text-[#8b949e] italic mt-1 ml-4 whitespace-pre-wrap">
          {message.content}
        </pre>
      )}
    </div>
  );
}

// --- Todo Message ---

type TodoStatus = TodoItem["status"];

function getTodoStatusColor(status: TodoStatus): string {
  switch (status) {
    case "completed":
      return "text-[#3fb950]";
    case "in_progress":
      return "text-[#58a6ff]";
    case "pending":
    default:
      return "text-[#8b949e]";
  }
}

function TodoCheckbox({
  status,
  variant = "default",
}: {
  status: TodoStatus;
  variant?: "default" | "new";
}) {
  // Small SVG square with a green check when completed, solid dot when in
  // progress, empty outline when pending. `variant="new"` draws the outline
  // in blue (for freshly-added pending tasks).
  const stroke =
    status === "completed"
      ? "#3fb950"
      : variant === "new"
        ? "#58a6ff"
        : status === "in_progress"
          ? "#58a6ff"
          : "#8b949e";
  return (
    <span className="inline-flex items-center justify-center flex-shrink-0">
      <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
        <rect
          x="1"
          y="1"
          width="10"
          height="10"
          rx="2"
          fill="none"
          stroke={stroke}
          strokeWidth="1.5"
        />
        {status === "completed" && (
          <path
            d="M3 6.2 L5 8.2 L9 4"
            fill="none"
            stroke="#3fb950"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}
        {status === "in_progress" && (
          <circle cx="6" cy="6" r="1.6" fill="#58a6ff" />
        )}
      </svg>
    </span>
  );
}

type TodoDiffEntry =
  | { kind: "added"; item: TodoItem }
  | { kind: "removed"; item: TodoItem }
  | { kind: "changed"; from: TodoStatus; to: TodoStatus; item: TodoItem };

export function diffTodos(
  prev: TodoItem[] | null | undefined,
  next: TodoItem[],
): TodoDiffEntry[] {
  const prevMap = new Map<string, TodoItem>();
  for (const t of prev || []) prevMap.set(t.content, t);
  const nextMap = new Map<string, TodoItem>();
  for (const t of next) nextMap.set(t.content, t);

  const diff: TodoDiffEntry[] = [];

  for (const t of next) {
    const before = prevMap.get(t.content);
    if (!before) {
      diff.push({ kind: "added", item: t });
    } else if (before.status !== t.status) {
      diff.push({
        kind: "changed",
        from: before.status,
        to: t.status,
        item: t,
      });
    }
  }
  for (const t of prev || []) {
    if (!nextMap.has(t.content)) {
      diff.push({ kind: "removed", item: t });
    }
  }

  return diff;
}

interface TodoMessageComponentProps {
  message: TodoMessage;
  prevTodos?: TodoItem[] | null;
}

export function TodoMessageComponent({
  message,
  prevTodos,
}: TodoMessageComponentProps) {
  const diff = diffTodos(prevTodos ?? null, message.todos);
  if (diff.length === 0) return null;

  return (
    <div className="my-1 space-y-0.5" data-testid="todo-diff">
      {diff.map((entry, i) => {
        if (entry.kind === "added") {
          return (
            <div
              key={i}
              className="flex items-center gap-1.5 text-xs font-mono"
            >
              <span className="text-[#58a6ff] font-semibold w-2.5 text-center">
                +
              </span>
              <TodoCheckbox status="pending" variant="new" />
              <span className="text-[#c9d1d9]">{entry.item.content}</span>
            </div>
          );
        }
        if (entry.kind === "removed") {
          return (
            <div
              key={i}
              className="flex items-center gap-1.5 text-xs font-mono"
            >
              <span className="text-[#8b949e] font-semibold w-2.5 text-center">
                −
              </span>
              <TodoCheckbox status={entry.item.status} />
              <span className="text-[#6e7681] line-through">
                {entry.item.content}
              </span>
            </div>
          );
        }
        return (
          <div key={i} className="flex items-center gap-1.5 text-xs font-mono">
            <span className="w-2.5" />
            <TodoCheckbox status={entry.from} />
            <span className="text-[#6e7681]">→</span>
            <TodoCheckbox status={entry.to} />
            <span className={getTodoStatusColor(entry.to)}>
              {entry.item.content}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// --- Todo Row (floating above chat input) ---

interface TodoRowProps {
  todos: TodoItem[];
  onDismiss?: () => void;
}

export function TodoRow({ todos, onDismiss }: TodoRowProps) {
  const [expanded, setExpanded] = useState(false);
  if (!todos || todos.length === 0) return null;

  const completed = todos.filter((t) => t.status === "completed").length;
  const total = todos.length;
  const inProgress = todos.find((t) => t.status === "in_progress");
  const nextPending = todos.find((t) => t.status === "pending");
  const allDone = completed === total;
  const currentLabel = inProgress
    ? inProgress.activeForm || inProgress.content
    : allDone
      ? "All tasks complete"
      : nextPending
        ? `Next: ${nextPending.content}`
        : "Idle";

  return (
    <div
      data-testid="todo-row"
      className="border-t border-[#30363d] bg-[#0d1117]"
    >
      <div className="flex items-stretch">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex-1 flex items-center gap-2 px-3 py-1.5 text-xs font-mono text-[#c9d1d9] hover:bg-[#161b22] transition-colors select-none min-w-0"
        >
          <span className="text-[10px] text-[#6e7681] w-2.5">
            {expanded ? "▼" : "▶"}
          </span>
          <TodoCheckbox
            status={
              inProgress ? "in_progress" : allDone ? "completed" : "pending"
            }
          />
          <span className="flex-1 text-left truncate">{currentLabel}</span>
          <span className="text-[#8b949e] shrink-0">
            {completed}/{total} tasks
          </span>
        </button>
        {onDismiss && (
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Dismiss tasks"
            title="Dismiss"
            className="px-2 text-[#484f58] hover:text-[#c9d1d9] hover:bg-[#161b22] transition-colors shrink-0"
          >
            <svg
              viewBox="0 0 16 16"
              fill="currentColor"
              className="w-3.5 h-3.5"
            >
              <path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.75.75 0 1 1 1.06 1.06L9.06 8l3.22 3.22a.75.75 0 1 1-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 0 1-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06z" />
            </svg>
          </button>
        )}
      </div>
      {expanded && (
        <div className="px-3 pb-2 pt-0.5 space-y-0.5 border-t border-[#21262d]">
          {todos.map((todo, i) => (
            <div
              key={i}
              className="flex items-center gap-1.5 text-xs font-mono"
            >
              <TodoCheckbox status={todo.status} />
              <span className={getTodoStatusColor(todo.status)}>
                {todo.status === "in_progress"
                  ? todo.activeForm || todo.content
                  : todo.content}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// --- Subagent Lane ---

interface SubagentLaneComponentProps {
  message: SubagentLaneMessage;
}

interface SubagentLaneStats {
  inputTokens?: number;
  outputTokens?: number;
  toolCallCount?: number;
}

export function SubagentLaneComponent({ message }: SubagentLaneComponentProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const subagentId = message.subagentId;

  // Derive live child session state. The lane's `message.state` only flips
  // once monitor_subagent returns its tool_result — but the child can finish
  // before (or without) that ever being called, and on history reload the
  // stored lane may remain `running` forever.
  //
  // Two complementary signals:
  //  1. statusMap (live): active entry → child is streaming/waiting.
  //     Once we've ever seen the child active and the entry disappears,
  //     the child reached a terminal state.
  //  2. sessionsIndex (persisted): `status` field is now kept in sync with
  //     every `session-status` SSE event, so it survives page reloads.
  const statusMap = useSyncExternalStore(
    subscribeSessionStatus,
    getSessionStatusMap,
  );
  const sessionsMap = useSyncExternalStore(subscribeSessions, getSessionsMap);
  const [childMetadata, setChildMetadata] = useState<SessionMetadata | null>(
    null,
  );
  const [childStats, setChildStats] = useState<SubagentLaneStats | null>(null);
  const [inlineExpanded, setInlineExpanded] = useState(false);

  // Latch: once the child appeared active, we know it actually ran.
  const hasBeenActiveRef = useRef(false);

  const indexedChild = useMemo(() => {
    if (!subagentId) return null;
    for (const list of sessionsMap.values()) {
      for (const entry of list) {
        if (entry.sessionId === subagentId) return entry;
      }
    }
    return null;
  }, [subagentId, sessionsMap]);

  useEffect(() => {
    setChildMetadata(null);
  }, [subagentId]);

  const shouldLoadMetadata =
    message.state === "running" ||
    indexedChild?.status === "running" ||
    indexedChild?.status === "awaiting_input" ||
    indexedChild?.status === "backend_wakeup";

  const pollMetadata = useCallback(
    async (signal: AbortSignal) => {
      if (!subagentId) return;
      try {
        const res = await fetch(getSessionUrl(subagentId), { signal });
        const metadata = res.ok
          ? ((await res.json()) as SessionMetadata)
          : null;
        if (!signal.aborted) setChildMetadata(metadata);
      } catch {
        if (!signal.aborted) setChildMetadata(null);
      }
    },
    [subagentId, indexedChild?.updatedAt],
  );

  usePoll(pollMetadata, 2500, {
    enabled: Boolean(subagentId && shouldLoadMetadata),
  });

  useEffect(() => {
    setChildStats(null);
  }, [subagentId]);

  const liveChildStatus = useMemo(() => {
    if (!subagentId) return null;

    const active = statusMap.get(subagentId);
    if (active?.isStreaming || active?.isWaitingForHuman) {
      hasBeenActiveRef.current = true;
      return "active";
    }
    if (active?.isInterrupted) return "interrupted";

    // Check the sessions index (status field is kept up-to-date by SSE).
    const persistedStatus = indexedChild?.status ?? childMetadata?.status;
    if (
      persistedStatus === "running" ||
      persistedStatus === "awaiting_input" ||
      persistedStatus === "backend_wakeup"
    ) {
      hasBeenActiveRef.current = true;
      return "active";
    }
    if (persistedStatus === "error" || persistedStatus === "interrupted") {
      return persistedStatus;
    }
    if (persistedStatus) return "terminal"; // idle / blocked_on_human / other rest states

    // Fallback: if we latched as active and it's no longer in statusMap →
    // the child transitioned to a terminal state (status event may have fired
    // before the sessions-index entry was updated).
    if (hasBeenActiveRef.current) return "terminal";

    return null;
  }, [subagentId, statusMap, indexedChild, childMetadata]);

  const effectiveState: SubagentLaneMessage["state"] =
    liveChildStatus === "error" || liveChildStatus === "interrupted"
      ? "error"
      : liveChildStatus === "terminal"
        ? "complete"
        : message.state;

  const [now, setNow] = useState(() => Date.now());
  const statusMeta = getSubagentStatusMeta(effectiveState);
  const canOpenChild = Boolean(subagentId);
  const isLegacyNativeAgent = !subagentId && message.agentType !== "swarmfleet";

  const handleOpenChild = useCallback(() => {
    if (!subagentId) return;
    const next = new URLSearchParams(location.search);
    next.set("sessionId", subagentId);
    navigate({ search: next.toString() });
  }, [location.search, navigate, subagentId]);
  const handleToggleInline = useCallback(() => {
    setInlineExpanded((expanded) => !expanded);
  }, []);

  useEffect(() => {
    if (effectiveState !== "running") return;
    const timer = window.setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => window.clearInterval(timer);
  }, [effectiveState, message.toolUseId]);

  const elapsedMs =
    effectiveState === "running"
      ? now - message.startedAt
      : (message.completedAt ?? now) - message.startedAt;
  const elapsedLabel = formatElapsedTime(elapsedMs);

  // Pull the child's most-recently-broadcast preview from the sessions index.
  // `lastMessagePreview` is updated on every `session-status` SSE event, so
  // it reflects the child's last output at the time of the status transition.
  const childPreview = useMemo(() => {
    if (!subagentId) return null;
    return (
      indexedChild?.lastMessagePreview ||
      childMetadata?.lastMessagePreview ||
      null
    );
  }, [subagentId, indexedChild, childMetadata]);

  const bodyText =
    effectiveState === "error"
      ? message.error || "Agent failed without an error message."
      : message.result ||
        childPreview ||
        (effectiveState === "running"
          ? "Working..."
          : "Sub-agent finished. Open the session to view its transcript.");
  const actualProvider =
    indexedChild?.provider ?? childMetadata?.provider ?? null;
  const actualModel = indexedChild?.model ?? childMetadata?.model ?? null;
  const providerLabel = isLegacyNativeAgent
    ? "Claude Agent (legacy)"
    : actualProvider
      ? formatProviderLabel(actualProvider)
      : subagentId
        ? "..."
        : "SwarmFleet subagent";
  const modelLabel = isLegacyNativeAgent
    ? "Native task"
    : actualModel
      ? formatModelLabel(actualModel)
      : subagentId
        ? "..."
        : "Starting...";
  const statsLabel = formatSubagentStats(childStats);
  const statsTitle = formatSubagentStatsTitle(childStats);
  const detailText =
    effectiveState === "running"
      ? summarizeText(childPreview || bodyText || "Starting...", 180)
      : summarizeText(bodyText, 180);
  const canInspectInline =
    !canOpenChild && effectiveState !== "running" && Boolean(bodyText.trim());
  const isInteractive = canOpenChild || canInspectInline;

  return (
    <>
      <button
        type="button"
        data-testid="subagent-lane"
        data-tool-use-id={message.toolUseId}
        data-agent-type={message.agentType}
        data-state={effectiveState}
        onClick={
          canOpenChild
            ? handleOpenChild
            : canInspectInline
              ? handleToggleInline
              : undefined
        }
        disabled={!isInteractive}
        aria-expanded={canInspectInline ? inlineExpanded : undefined}
        className={`grid w-full grid-cols-[auto_4.25rem_5.25rem_minmax(0,1fr)_auto] items-center gap-2 rounded-md border px-3 py-2 text-left shadow-[0_1px_2px_rgba(0,0,0,0.12)] transition-colors sm:gap-3 ${statusMeta.containerClass} ${
          isInteractive ? "cursor-pointer hover:bg-[#21262d]" : "cursor-default"
        } max-sm:grid-cols-[auto_minmax(0,1fr)_auto] max-sm:gap-x-2 max-sm:gap-y-1.5`}
      >
        <SubagentStatusIndicator
          state={effectiveState}
          label={statusMeta.label}
        />

        <span className="min-w-0 max-sm:col-start-2">
          <span
            className="block truncate text-xs font-semibold text-[#e6edf3]"
            title={modelLabel}
          >
            {modelLabel}
          </span>
          <span
            className="block truncate font-mono text-[11px] text-[#8b949e]"
            title={providerLabel}
          >
            {providerLabel}
          </span>
        </span>

        <span className="min-w-0 max-sm:col-span-2 max-sm:col-start-2">
          <span
            className="block truncate font-mono text-xs font-semibold text-[#e6edf3]"
            title={elapsedLabel}
          >
            {elapsedLabel}
          </span>
          <span
            className="block truncate font-mono text-[11px] text-[#8b949e]"
            title={statsTitle}
          >
            {statsLabel}
          </span>
        </span>

        <span className="min-w-0 max-sm:col-span-3">
          <span
            className="block truncate text-sm font-semibold text-[#e6edf3]"
            title={message.description}
          >
            {message.description}
          </span>
          <span
            className={`block truncate text-xs ${statusMeta.bodyTextClass}`}
            title={bodyText}
          >
            {detailText}
          </span>
        </span>

        <svg
          viewBox="0 0 20 20"
          fill="currentColor"
          className={`h-4 w-4 shrink-0 text-[#8b949e] transition-transform max-sm:col-start-3 max-sm:row-start-1 ${
            canInspectInline && inlineExpanded ? "rotate-90" : ""
          }`}
          aria-hidden="true"
          data-testid="subagent-lane-open"
          data-subagent-id={subagentId}
        >
          <path
            fillRule="evenodd"
            d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z"
            clipRule="evenodd"
          />
        </svg>
      </button>
      {canInspectInline && inlineExpanded && (
        <div className="rounded-md border border-[#30363d] bg-[#0d1117] px-3 py-2">
          <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words text-xs leading-5 text-[#c9d1d9]">
            {bodyText}
          </pre>
        </div>
      )}
    </>
  );
}

// --- Compact Message (context compaction lifecycle) ---

function formatTokens(n: number | undefined): string {
  if (typeof n !== "number" || !isFinite(n)) return "?";
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return String(n);
}

export function CompactMessageComponent({
  message,
}: {
  message: CompactMessage;
}) {
  const [expanded, setExpanded] = useState(false);
  const isRunning = message.state === "running";
  const canExpand = !isRunning && !!message.summary;

  const statsText = (() => {
    if (isRunning) return "compacting context";
    const parts: string[] = ["context compacted"];
    if (
      typeof message.preTokens === "number" &&
      typeof message.postTokens === "number"
    ) {
      parts.push(
        `${formatTokens(message.preTokens)} → ${formatTokens(message.postTokens)} tokens`,
      );
    }
    if (typeof message.durationMs === "number") {
      parts.push(`${(message.durationMs / 1000).toFixed(1)}s`);
    }
    return parts.join(" · ");
  })();

  return (
    <div
      className="my-2 -mx-3 sm:-mx-4 select-none"
      data-testid="compact-message"
      data-state={message.state}
    >
      <button
        type="button"
        onClick={() => {
          if (canExpand) setExpanded((prev) => !prev);
        }}
        disabled={!canExpand}
        className={`w-full flex items-center gap-3 px-3 sm:px-4 py-0.5 text-left ${
          canExpand ? "cursor-pointer hover:bg-[#161b22]/40" : "cursor-default"
        }`}
      >
        <span className="h-px flex-1 bg-[#30363d]" aria-hidden="true" />
        <span
          className={`flex items-center gap-1.5 text-[11px] font-mono uppercase tracking-wider ${
            isRunning ? "text-[#58a6ff]" : "text-[#8b949e]"
          }`}
        >
          {isRunning && (
            <span
              className="h-1.5 w-1.5 rounded-full bg-[#58a6ff] animate-pulse"
              aria-hidden="true"
            />
          )}
          <span className={isRunning ? "compact-pulse" : ""}>{statsText}</span>
          {isRunning && (
            <span className="compact-ellipsis" aria-hidden="true" />
          )}
          {canExpand && (
            <svg
              viewBox="0 0 12 12"
              className={`h-2.5 w-2.5 transition-transform ${
                expanded ? "rotate-180" : ""
              }`}
              fill="none"
              aria-hidden="true"
            >
              <path
                d="M2.5 4.5L6 8L9.5 4.5"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          )}
        </span>
        <span className="h-px flex-1 bg-[#30363d]" aria-hidden="true" />
      </button>
      {canExpand && expanded && (
        <div className="px-3 sm:px-4 mt-2">
          <pre className="text-xs font-mono text-[#c9d1d9] whitespace-pre-wrap bg-[#0d1117] border border-[#30363d] rounded-md p-3 max-h-96 overflow-auto">
            {message.summary}
          </pre>
        </div>
      )}
    </div>
  );
}

// --- Loading ---

export function LoadingComponent() {
  return (
    <div className="py-2 flex items-center gap-2">
      <div className="flex items-center gap-1">
        <span className="typing-dot" />
        <span className="typing-dot" />
        <span className="typing-dot" />
      </div>
      <span className="text-xs font-mono text-[#484f58]">thinking</span>
    </div>
  );
}
