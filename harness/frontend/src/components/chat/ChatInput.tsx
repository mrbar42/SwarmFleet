import React, {
  useRef,
  useEffect,
  useState,
  useCallback,
  useContext,
} from "react";
import { StopIcon, PhotoIcon } from "@heroicons/react/24/solid";
import { XMarkIcon, ChevronUpIcon } from "@heroicons/react/24/outline";
import { PlanPermissionInputPanel } from "./PlanPermissionInputPanel";
import { PendingMessagesQueue } from "./PendingMessagesQueue";
import { LoopControlBar } from "./LoopControlBar";
import { LoopCountdownBanner } from "./LoopCountdownBanner";
import {
  ModelPicker,
  deriveProviderFromModel,
  isClaudeModel,
} from "./ModelPicker";
import type { ImageAttachment } from "../../types";
import { useChatStore } from "../../stores/chatStore";
import { SettingsContext } from "../../contexts/SettingsContextTypes";
import { getPlanModeShortcutLabel } from "../../utils/keyboardShortcuts";
import { getDefaultEnterBehavior } from "../../utils/storage";

const MAX_ATTACHMENTS = 5;
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB
const TEXTAREA_MAX_ROWS_MOBILE = 6;
const TEXTAREA_MAX_ROWS_DESKTOP = 15;
const DESKTOP_MEDIA_QUERY = "(min-width: 768px)";
const CHAT_INPUT_FOCUS_STATE_KEY = "swarmfleet-chat-input-focus-state";

type ChatInputFocusState = {
  shouldRestore: boolean;
  sessionId: string | null;
  selectionStart: number | null;
  selectionEnd: number | null;
};

function readFocusState(): ChatInputFocusState | null {
  try {
    const raw = window.sessionStorage.getItem(CHAT_INPUT_FOCUS_STATE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ChatInputFocusState>;
    return {
      shouldRestore: parsed.shouldRestore === true,
      sessionId: typeof parsed.sessionId === "string" ? parsed.sessionId : null,
      selectionStart:
        typeof parsed.selectionStart === "number"
          ? parsed.selectionStart
          : null,
      selectionEnd:
        typeof parsed.selectionEnd === "number" ? parsed.selectionEnd : null,
    };
  } catch {
    return null;
  }
}

function writeFocusState(
  sessionId: string | null,
  state: Omit<ChatInputFocusState, "sessionId">,
): void {
  try {
    window.sessionStorage.setItem(
      CHAT_INPUT_FOCUS_STATE_KEY,
      JSON.stringify({ ...state, sessionId }),
    );
  } catch {
    // Best effort only; focus restore is a convenience.
  }
}

async function fileToAttachment(file: File): Promise<ImageAttachment | null> {
  const validTypes = ["image/jpeg", "image/png", "image/gif", "image/webp"];
  if (!validTypes.includes(file.type)) return null;
  if (file.size > MAX_FILE_SIZE) return null;

  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const base64 = dataUrl.split(",")[1];
      resolve({
        type: "image",
        media_type: file.type as ImageAttachment["media_type"],
        base64,
      });
    };
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

import modelsConfig from "@shared/models.json";

const EFFORT_LEVELS = ["auto", ...modelsConfig.effortLevels];

interface PlanPermissionData {
  onAcceptWithEdits: () => void;
  onAcceptDefault: () => void;
  onKeepPlanning: () => void;
  getButtonClassName?: (
    buttonType: "acceptWithEdits" | "acceptDefault" | "keepPlanning",
    defaultClassName: string,
  ) => string;
  onSelectionChange?: (
    selection: "acceptWithEdits" | "acceptDefault" | "keepPlanning",
  ) => void;
  externalSelectedOption?:
    | "acceptWithEdits"
    | "acceptDefault"
    | "keepPlanning"
    | null;
}

interface ChatInputProps {
  onSubmit: () => void;
  onSubmitWithAttachments?: (
    message: string,
    attachments: ImageAttachment[],
  ) => void;
  onAbort: () => void | Promise<void>;
  isPlanMode: boolean;
  onPlanToggle: () => void;
  planPermissionData?: PlanPermissionData;
}

function EffortPicker({
  effort,
  onEffortChange,
  disabled,
}: {
  effort: string;
  onEffortChange: (effort: string) => void;
  disabled?: boolean;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [isOpen]);

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        type="button"
        data-testid="effort-picker"
        data-effort={effort}
        onClick={() => !disabled && setIsOpen(!isOpen)}
        disabled={disabled}
        className="flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium text-[#8b949e] hover:text-[#e6edf3] transition-colors duration-150 disabled:opacity-40 disabled:cursor-not-allowed"
      >
        <span>{effort}</span>
        <ChevronUpIcon
          className={`w-3 h-3 transition-transform duration-150 ${isOpen ? "" : "rotate-180"}`}
        />
      </button>

      {isOpen && (
        <div className="absolute bottom-full mb-1 right-0 w-32 bg-[#161b22] border border-[#30363d] rounded-lg shadow-xl z-50 py-1 overflow-hidden">
          {EFFORT_LEVELS.map((level) => (
            <button
              key={level}
              type="button"
              onClick={() => {
                onEffortChange(level);
                setIsOpen(false);
              }}
              className={`w-full text-left px-3 py-1.5 text-xs transition-colors duration-100 ${
                level === effort
                  ? "text-[#e6edf3] bg-[#1f2937]"
                  : "text-[#c9d1d9] hover:bg-[#1c2129]"
              }`}
            >
              {level}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function ChatInput({
  onSubmit,
  onSubmitWithAttachments,
  onAbort,
  isPlanMode,
  onPlanToggle,
  planPermissionData,
}: ChatInputProps) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const focusIntentRef = useRef(false);
  const isUnmountingRef = useRef(false);
  const previousSessionIdRef = useRef<string | null | undefined>(undefined);
  const selectionRef = useRef<{
    selectionStart: number | null;
    selectionEnd: number | null;
  }>({ selectionStart: null, selectionEnd: null });
  const settingsCtx = useContext(SettingsContext);
  const [isComposing, setIsComposing] = useState(false);
  const [attachments, setAttachments] = useState<ImageAttachment[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const [isAbortPending, setIsAbortPending] = useState(false);
  const [hasAvailableProvider, setHasAvailableProvider] = useState(false);
  const input = useChatStore((state) => state.input);
  const phase = useChatStore((state) => state.phase);
  const requestId = useChatStore((state) => state.requestId);
  const model = useChatStore((state) => state.model);
  const effort = useChatStore((state) => state.effort);
  const sessionId = useChatStore((state) => state.sessionId);
  const sessionProvider = useChatStore((state) => state.sessionProvider);
  const queuedMessages = useChatStore((state) => state.queuedMessages);
  const planModeRequestOpen = useChatStore(
    (state) => state.planModeRequest?.isOpen === true,
  );
  const setInput = useChatStore((state) => state.setInput);
  const setModel = useChatStore((state) => state.setModel);
  const setEffort = useChatStore((state) => state.setEffort);
  // Hard-lock the input only while history is loading or a plan-permission
  // dialog is waiting for an explicit Accept/Reject — in those states typing
  // makes no sense. During normal streaming the input stays enabled so the
  // user can compose and send the next message (it will be queued and
  // auto-dispatched when the current turn ends).
  const isPlanPermissionPending =
    phase === "awaiting-permission" && !planModeRequestOpen;
  const isInputLocked = phase === "loading-history" || isPlanPermissionPending;
  // Visual "busy" indicator for the STOP button area and button label swap.
  const isLoading =
    phase === "streaming" ||
    phase === "loading-history" ||
    isPlanPermissionPending;
  // When the agent is running, sends queue instead of dispatching immediately.
  const willQueue = phase === "streaming";
  const enterBehavior = settingsCtx?.enterBehavior ?? getDefaultEnterBehavior();
  const planModeShortcutLabel = getPlanModeShortcutLabel();

  const resizeTextarea = useCallback(() => {
    const textarea = inputRef.current;
    if (!textarea) return;

    textarea.style.height = "auto";
    const computedStyle = getComputedStyle(textarea);
    const lineHeight = parseFloat(computedStyle.lineHeight) || 20;
    const paddingTop = parseFloat(computedStyle.paddingTop) || 0;
    const paddingBottom = parseFloat(computedStyle.paddingBottom) || 0;
    const maxRows = window.matchMedia(DESKTOP_MEDIA_QUERY).matches
      ? TEXTAREA_MAX_ROWS_DESKTOP
      : TEXTAREA_MAX_ROWS_MOBILE;
    const maxHeight = lineHeight * maxRows + paddingTop + paddingBottom;
    const scrollHeight = Math.min(textarea.scrollHeight, maxHeight);
    textarea.style.height = `${scrollHeight}px`;
    textarea.style.overflowY =
      textarea.scrollHeight > maxHeight ? "auto" : "hidden";
  }, []);

  const keepFocusedInputVisible = useCallback(() => {
    const textarea = inputRef.current;
    if (!textarea || document.activeElement !== textarea) return;

    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        const current = inputRef.current;
        if (!current || document.activeElement !== current) return;
        current.scrollIntoView({ block: "nearest", inline: "nearest" });
      });
    });
  }, []);

  const handleModelChange = useCallback(
    async (nextModel: string) => {
      const nextProvider = deriveProviderFromModel(nextModel);
      if (sessionProvider && nextProvider !== sessionProvider) return;
      setModel(nextModel);
    },
    [sessionProvider, setModel],
  );

  const addAttachments = useCallback(async (files: FileList | File[]) => {
    const fileArray = Array.from(files);
    const results = await Promise.all(fileArray.map(fileToAttachment));
    const valid = results.filter((a): a is ImageAttachment => a !== null);
    setAttachments((prev) => {
      const combined = [...prev, ...valid];
      return combined.slice(0, MAX_ATTACHMENTS);
    });
  }, []);

  const removeAttachment = useCallback((index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handlePaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const imageFiles: File[] = [];
      for (const item of Array.from(items)) {
        if (item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (file) imageFiles.push(file);
        }
      }
      if (imageFiles.length > 0) {
        e.preventDefault();
        addAttachments(imageFiles);
      }
    },
    [addAttachments],
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragOver(false);
      if (e.dataTransfer?.files) {
        addAttachments(e.dataTransfer.files);
      }
    },
    [addAttachments],
  );

  const handleFileInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.files) {
        addAttachments(e.target.files);
      }
      e.target.value = "";
    },
    [addAttachments],
  );

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      focusIntentRef.current = true;
      selectionRef.current = {
        selectionStart: e.target.selectionStart,
        selectionEnd: e.target.selectionEnd,
      };
      writeFocusState(sessionId, {
        shouldRestore: true,
        ...selectionRef.current,
      });
      setInput(e.target.value);
    },
    [sessionId, setInput],
  );

  useEffect(() => {
    setAttachments([]);
  }, [sessionId]);

  useEffect(() => {
    if (previousSessionIdRef.current === undefined) {
      previousSessionIdRef.current = sessionId;
      return;
    }
    if (previousSessionIdRef.current === sessionId) return;
    previousSessionIdRef.current = sessionId;

    focusIntentRef.current = false;
    writeFocusState(sessionId, {
      shouldRestore: false,
      ...selectionRef.current,
    });
    if (document.activeElement === inputRef.current) {
      inputRef.current?.blur();
    }
  }, [sessionId]);

  useEffect(() => {
    isUnmountingRef.current = false;
    return () => {
      isUnmountingRef.current = true;
      if (focusIntentRef.current) {
        writeFocusState(sessionId, {
          shouldRestore: true,
          ...selectionRef.current,
        });
      }
    };
  }, [sessionId]);

  useEffect(() => {
    if (isInputLocked) return;
    const saved = readFocusState();
    if (!saved?.shouldRestore) return;
    if (saved.sessionId !== sessionId) return;
    const textarea = inputRef.current;
    if (!textarea) return;

    window.requestAnimationFrame(() => {
      const current = inputRef.current;
      if (!current || current.disabled) return;
      current.focus({ preventScroll: true });
      const valueLength = current.value.length;
      const start = Math.min(saved.selectionStart ?? valueLength, valueLength);
      const end = Math.min(saved.selectionEnd ?? start, valueLength);
      current.setSelectionRange(start, end);
      focusIntentRef.current = true;
      selectionRef.current = { selectionStart: start, selectionEnd: end };
    });
  }, [input, isInputLocked, sessionId]);

  useEffect(() => {
    resizeTextarea();
  }, [input, resizeTextarea]);

  useEffect(() => {
    window.addEventListener("resize", resizeTextarea);
    return () => window.removeEventListener("resize", resizeTextarea);
  }, [resizeTextarea]);

  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    viewport.addEventListener("resize", keepFocusedInputVisible);
    viewport.addEventListener("scroll", keepFocusedInputVisible);
    return () => {
      viewport.removeEventListener("resize", keepFocusedInputVisible);
      viewport.removeEventListener("scroll", keepFocusedInputVisible);
    };
  }, [keepFocusedInputVisible]);

  useEffect(() => {
    if (!isLoading || !requestId) {
      setIsAbortPending(false);
    }
  }, [isLoading, requestId]);

  const handleAbortClick = useCallback(async () => {
    if (isAbortPending) return;
    setIsAbortPending(true);
    try {
      await onAbort();
    } finally {
      setIsAbortPending(false);
    }
  }, [isAbortPending, onAbort]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    doSubmit();
  };

  const doSubmit = () => {
    if (!hasAvailableProvider) return;
    if (attachments.length > 0 && onSubmitWithAttachments) {
      onSubmitWithAttachments(input, attachments);
      setAttachments([]);
    } else {
      onSubmit();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !isComposing) {
      if (e.shiftKey) {
        return;
      }

      if (e.metaKey || e.ctrlKey) {
        e.preventDefault();
        doSubmit();
        return;
      }

      const shouldSubmit = enterBehavior === "send";

      if (shouldSubmit) {
        e.preventDefault();
        doSubmit();
      }
    }
  };

  const handleCompositionStart = () => setIsComposing(true);
  const handleCompositionEnd = () => setTimeout(() => setIsComposing(false), 0);
  const rememberSelection = useCallback(() => {
    const textarea = inputRef.current;
    if (!textarea) return;
    selectionRef.current = {
      selectionStart: textarea.selectionStart,
      selectionEnd: textarea.selectionEnd,
    };
    if (focusIntentRef.current) {
      writeFocusState(sessionId, {
        shouldRestore: true,
        ...selectionRef.current,
      });
    }
  }, [sessionId]);

  const handleInputFocus = useCallback(() => {
    focusIntentRef.current = true;
    rememberSelection();
    keepFocusedInputVisible();
  }, [keepFocusedInputVisible, rememberSelection]);

  const handleInputBlur = useCallback(() => {
    window.setTimeout(() => {
      if (isUnmountingRef.current || document.visibilityState === "hidden") {
        return;
      }
      if (document.activeElement === inputRef.current) return;
      focusIntentRef.current = false;
      writeFocusState(sessionId, {
        shouldRestore: false,
        ...selectionRef.current,
      });
    }, 0);
  }, [sessionId]);

  if (planPermissionData) {
    return (
      <PlanPermissionInputPanel
        onAcceptWithEdits={planPermissionData.onAcceptWithEdits}
        onAcceptDefault={planPermissionData.onAcceptDefault}
        onKeepPlanning={planPermissionData.onKeepPlanning}
        getButtonClassName={planPermissionData.getButtonClassName}
        onSelectionChange={planPermissionData.onSelectionChange}
        externalSelectedOption={planPermissionData.externalSelectedOption}
      />
    );
  }

  return (
    <div className="flex-shrink-0 md:max-w-[750px] mx-auto w-full md:mb-[5px]">
      {sessionId && <LoopCountdownBanner sessionId={sessionId} />}
      {sessionId && queuedMessages.length > 0 && (
        <PendingMessagesQueue sessionId={sessionId} queued={queuedMessages} />
      )}
      <form
        onSubmit={handleSubmit}
        className={`${isDragOver ? "ring-2 ring-[#58a6ff]" : ""}`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept="image/jpeg,image/png,image/gif,image/webp"
          multiple
          className="hidden"
          onChange={handleFileInputChange}
        />

        <div className="bg-[#161b22] border-t md:border border-[#30363d] md:rounded-xl">
          {attachments.length > 0 && (
            <div className="flex gap-2 px-4 pt-3 pb-1">
              {attachments.map((att, idx) => (
                <div key={idx} className="relative group">
                  <img
                    src={`data:${att.media_type};base64,${att.base64}`}
                    alt={`Attachment ${idx + 1}`}
                    className="w-12 h-12 object-cover rounded-lg border border-[#30363d]"
                  />
                  <button
                    type="button"
                    onClick={() => removeAttachment(idx)}
                    className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-[#30363d] text-[#e6edf3] rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity duration-150 hover:bg-[#da3633]"
                    title="Remove"
                  >
                    <XMarkIcon className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>
          )}

          <textarea
            ref={inputRef}
            data-testid="chat-input"
            value={input}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            onCompositionStart={handleCompositionStart}
            onCompositionEnd={handleCompositionEnd}
            onPaste={handlePaste}
            onFocus={handleInputFocus}
            onBlur={handleInputBlur}
            onClick={rememberSelection}
            onKeyUp={rememberSelection}
            onSelect={rememberSelection}
            placeholder={
              willQueue
                ? "Message will be queued..."
                : isDragOver
                  ? "Drop images here..."
                  : enterBehavior === "send"
                    ? "Message... (Shift+Enter for new line)"
                    : "Message... (Enter for new line)"
            }
            rows={1}
            className="w-full bg-transparent text-[#e6edf3] placeholder-[#484f58] px-4 pt-3 pb-2 resize-none overflow-hidden focus:outline-none leading-5"
            disabled={isInputLocked}
          />

          <div className="px-3 pb-2 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={
                  isInputLocked || attachments.length >= MAX_ATTACHMENTS
                }
                className="p-2 text-[#484f58] hover:text-[#e6edf3] disabled:opacity-30 disabled:cursor-not-allowed transition-colors duration-200"
                title={
                  attachments.length >= MAX_ATTACHMENTS
                    ? `Max ${MAX_ATTACHMENTS} images`
                    : "Attach image"
                }
              >
                <PhotoIcon className="w-5 h-5" />
              </button>

              <button
                type="button"
                data-testid="plan-toggle"
                data-state={isPlanMode ? "on" : "off"}
                onClick={onPlanToggle}
                className={`px-2 py-1 rounded-md text-xs font-medium transition-all duration-200 border ${
                  isPlanMode
                    ? "bg-[#78350f30] text-[#fbbf24] border-[#92400e]"
                    : "bg-[#21262d] text-[#484f58] border-[#30363d] hover:text-[#c9d1d9]"
                }`}
                title={
                  isPlanMode
                    ? `Plan mode ON - click to disable (${planModeShortcutLabel})`
                    : `Plan mode OFF - click to enable (${planModeShortcutLabel})`
                }
              >
                Plan
              </button>

              {sessionId && <LoopControlBar sessionId={sessionId} />}
            </div>

            <div className="flex items-center gap-2">
              <ModelPicker
                model={model}
                onModelChange={handleModelChange}
                disabled={isInputLocked}
                lockedProvider={sessionProvider}
                onAvailabilityChange={setHasAvailableProvider}
              />

              {isClaudeModel(model) && (
                <EffortPicker
                  effort={effort}
                  onEffortChange={setEffort}
                  disabled={isInputLocked}
                />
              )}

              {isLoading && requestId && (
                <button
                  type="button"
                  onClick={() => void handleAbortClick()}
                  disabled={isAbortPending}
                  data-testid="chat-abort"
                  data-state={isAbortPending ? "stopping" : "idle"}
                  aria-busy={isAbortPending}
                  className="p-2 bg-[#3d1214] hover:bg-[#5d1a1d] text-[#f85149] rounded-lg transition-all duration-200 disabled:opacity-80 disabled:cursor-wait"
                  title={isAbortPending ? "Stopping..." : "Stop (ESC)"}
                >
                  {isAbortPending ? (
                    <span className="block w-4 h-4 rounded-full border-2 border-[#f85149] border-t-transparent animate-spin" />
                  ) : (
                    <StopIcon className="w-4 h-4" />
                  )}
                </button>
              )}
              <button
                type="submit"
                data-testid="chat-send"
                disabled={
                  (!input.trim() && attachments.length === 0) ||
                  isInputLocked ||
                  !hasAvailableProvider
                }
                className="px-4 py-1.5 bg-[#1f6feb] hover:bg-[#388bfd] disabled:bg-[#21262d] disabled:text-[#484f58] text-white rounded-lg font-medium transition-all duration-200 disabled:cursor-not-allowed text-sm"
              >
                {isPlanMode ? "Plan" : willQueue ? "Queue" : "Send"}
              </button>
            </div>
          </div>
        </div>
      </form>
    </div>
  );
}
