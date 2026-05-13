import { useCallback, useEffect, useRef, useState } from "react";
import { XMarkIcon, ChevronDownIcon, ChevronRightIcon } from "@heroicons/react/24/outline";
import type {
  LoopConfig,
  LoopStrategy,
  LoopTerminationCondition,
  PermissionMode,
} from "@shared/types";
import { useLoopStore } from "../../stores/loopStore";
import { getStorageItem, setStorageItem, removeStorageItem } from "../../utils/storage";

interface LoopConfigDialogProps {
  sessionId: string;
  isOpen: boolean;
  onClose: () => void;
  existingLoop?: LoopConfig | null;
}

type StrategyType = "interval" | "on_idle" | "hybrid" | "burst";

interface TerminationState {
  maxIterations: { enabled: boolean; value: string };
  maxDurationMin: { enabled: boolean; value: string };
  contentMatch: { enabled: boolean; pattern: string };
  consecutiveErrors: { enabled: boolean; value: string };
}

interface LoopDraft {
  name: string;
  prompt: string;
  strategyType: StrategyType;
  intervalSec: string;
  cooldownSec: string;
  maxIdleSec: string;
  burstCount: string;
  termination: TerminationState;
  permissionMode: string;
  model: string;
  effort: string;
}

function draftKey(sessionId: string): string {
  return `swarmfleet-loop-draft:${sessionId}`;
}

function loadDraft(sessionId: string): LoopDraft | null {
  return getStorageItem<LoopDraft | null>(draftKey(sessionId), null);
}

function saveDraft(sessionId: string, draft: LoopDraft): void {
  setStorageItem(draftKey(sessionId), draft);
}

function clearDraft(sessionId: string): void {
  removeStorageItem(draftKey(sessionId));
}

function defaultTermination(): TerminationState {
  return {
    maxIterations: { enabled: false, value: "10" },
    maxDurationMin: { enabled: false, value: "60" },
    contentMatch: { enabled: false, pattern: "" },
    consecutiveErrors: { enabled: false, value: "3" },
  };
}

function terminationFromLoop(loop: LoopConfig): TerminationState {
  const s = defaultTermination();
  for (const cond of loop.terminationConditions) {
    if (cond.type === "max_iterations") {
      s.maxIterations = { enabled: true, value: String(cond.value) };
    } else if (cond.type === "max_duration_ms") {
      s.maxDurationMin = { enabled: true, value: String(Math.round(cond.value / 60000)) };
    } else if (cond.type === "content_match") {
      s.contentMatch = { enabled: true, pattern: cond.pattern };
    } else if (cond.type === "consecutive_errors") {
      s.consecutiveErrors = { enabled: true, value: String(cond.value) };
    }
  }
  return s;
}

function buildTerminationConditions(s: TerminationState): LoopTerminationCondition[] {
  const conds: LoopTerminationCondition[] = [];
  if (s.maxIterations.enabled && s.maxIterations.value) {
    conds.push({ type: "max_iterations", value: parseInt(s.maxIterations.value, 10) });
  }
  if (s.maxDurationMin.enabled && s.maxDurationMin.value) {
    conds.push({ type: "max_duration_ms", value: parseFloat(s.maxDurationMin.value) * 60000 });
  }
  if (s.contentMatch.enabled && s.contentMatch.pattern) {
    conds.push({ type: "content_match", pattern: s.contentMatch.pattern });
  }
  if (s.consecutiveErrors.enabled && s.consecutiveErrors.value) {
    conds.push({ type: "consecutive_errors", value: parseInt(s.consecutiveErrors.value, 10) });
  }
  return conds;
}

function buildStrategy(
  type: StrategyType,
  intervalSec: string,
  cooldownSec: string,
  maxIdleSec: string,
  burstCount: string,
): LoopStrategy {
  if (type === "interval") {
    return { type: "interval", intervalMs: parseFloat(intervalSec) * 1000 };
  }
  if (type === "on_idle") {
    return { type: "on_idle", cooldownMs: parseFloat(cooldownSec) * 1000 };
  }
  if (type === "hybrid") {
    return {
      type: "hybrid",
      cooldownMs: parseFloat(cooldownSec) * 1000,
      maxIdleMs: parseFloat(maxIdleSec) * 1000,
    };
  }
  return { type: "burst", count: parseInt(burstCount, 10) };
}

const inputCls =
  "w-full bg-[#0d1117] border border-[#30363d] rounded px-3 py-2 text-sm text-[#c9d1d9] focus:border-[#a371f7] focus:outline-none";
const labelCls = "block text-xs text-[#8b949e] mb-1";

export function LoopConfigDialog({
  sessionId,
  isOpen,
  onClose,
  existingLoop,
}: LoopConfigDialogProps) {
  const createLoop = useLoopStore((state) => state.createLoop);
  const updateLoop = useLoopStore((state) => state.updateLoop);
  const deleteLoop = useLoopStore((state) => state.deleteLoop);
  const startCountdown = useLoopStore((state) => state.startCountdown);
  const storeError = useLoopStore((state) => state.error);
  const clearError = useLoopStore((state) => state.clearError);

  const initDraft = useCallback((): LoopDraft => {
    if (existingLoop) {
      const s = existingLoop.strategy;
      return {
        name: existingLoop.name,
        prompt: existingLoop.prompt,
        strategyType: s.type,
        intervalSec: s.type === "interval" ? String(s.intervalMs / 1000) : "60",
        cooldownSec:
          s.type === "on_idle"
            ? String(s.cooldownMs / 1000)
            : s.type === "hybrid"
              ? String(s.cooldownMs / 1000)
              : "30",
        maxIdleSec: s.type === "hybrid" ? String(s.maxIdleMs / 1000) : "300",
        burstCount: s.type === "burst" ? String(s.count) : "5",
        termination: terminationFromLoop(existingLoop),
        permissionMode: existingLoop.permissionMode ?? "",
        model: existingLoop.model ?? "",
        effort: existingLoop.effort ?? "",
      };
    }
    const saved = loadDraft(sessionId);
    if (saved) return saved;
    return {
      name: "Loop",
      prompt: "",
      strategyType: "interval",
      intervalSec: "60",
      cooldownSec: "30",
      maxIdleSec: "300",
      burstCount: "5",
      termination: defaultTermination(),
      permissionMode: "",
      model: "",
      effort: "",
    };
  }, [existingLoop, sessionId]);

  const [name, setName] = useState(() => initDraft().name);
  const [prompt, setPrompt] = useState(() => initDraft().prompt);
  const [strategyType, setStrategyType] = useState<StrategyType>(() => initDraft().strategyType);
  const [intervalSec, setIntervalSec] = useState(() => initDraft().intervalSec);
  const [cooldownSec, setCooldownSec] = useState(() => initDraft().cooldownSec);
  const [maxIdleSec, setMaxIdleSec] = useState(() => initDraft().maxIdleSec);
  const [burstCount, setBurstCount] = useState(() => initDraft().burstCount);
  const [termination, setTermination] = useState<TerminationState>(() => initDraft().termination);
  const [terminationOpen, setTerminationOpen] = useState(false);
  const [overridesOpen, setOverridesOpen] = useState(false);
  const [permissionMode, setPermissionMode] = useState<PermissionMode | "">(() => (initDraft().permissionMode as PermissionMode | ""));
  const [model, setModel] = useState(() => initDraft().model);
  const [effort, setEffort] = useState(() => initDraft().effort);
  const [submitting, setSubmitting] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const backdropRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    saveDraft(sessionId, {
      name, prompt, strategyType, intervalSec, cooldownSec,
      maxIdleSec, burstCount, termination, permissionMode, model, effort,
    });
  }, [sessionId, name, prompt, strategyType, intervalSec, cooldownSec, maxIdleSec, burstCount, termination, permissionMode, model, effort]);

  useEffect(() => {
    if (!isOpen) return;
    clearError();
    setLocalError(null);
    const d = initDraft();
    setName(d.name);
    setPrompt(d.prompt);
    setStrategyType(d.strategyType);
    setIntervalSec(d.intervalSec);
    setCooldownSec(d.cooldownSec);
    setMaxIdleSec(d.maxIdleSec);
    setBurstCount(d.burstCount);
    setTermination(d.termination);
    setPermissionMode(d.permissionMode as PermissionMode | "");
    setModel(d.model);
    setEffort(d.effort);
  }, [isOpen, initDraft, clearError]);

  useEffect(() => {
    if (!isOpen) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const error = localError ?? storeError;

  async function handleSubmit() {
    if (!prompt.trim()) {
      setLocalError("Prompt is required.");
      return;
    }
    setSubmitting(true);
    setLocalError(null);
    try {
      const strategy = buildStrategy(strategyType, intervalSec, cooldownSec, maxIdleSec, burstCount);
      const terminationConditions = buildTerminationConditions(termination);
      const overrides = {
        permissionMode: permissionMode || undefined,
        model: model.trim() || undefined,
        effort: effort.trim() || undefined,
      };
      if (existingLoop) {
        await updateLoop(existingLoop.id, { name, prompt, strategy, terminationConditions, ...overrides });
      } else {
        const loop = await createLoop({ sessionId, name, prompt, strategy, terminationConditions, ...overrides });
        clearDraft(sessionId);
        startCountdown(loop.id, sessionId);
      }
      onClose();
    } catch {
      // storeError is set by the store
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete() {
    if (!existingLoop) return;
    setSubmitting(true);
    try {
      await deleteLoop(existingLoop.id, sessionId);
      clearDraft(sessionId);
      onClose();
    } catch {
      // storeError is set by the store
    } finally {
      setSubmitting(false);
    }
  }

  function handleBackdropClick(e: React.MouseEvent) {
    if (e.target === backdropRef.current) onClose();
  }

  function updateTerm<K extends keyof TerminationState>(
    key: K,
    patch: Partial<TerminationState[K]>,
  ) {
    setTermination((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } }));
  }

  return (
    <div
      ref={backdropRef}
      onClick={handleBackdropClick}
      className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center"
    >
      <div className="bg-[#161b22] border border-[#30363d] rounded-lg shadow-xl w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto md:max-w-lg md:mx-4 max-md:max-w-none max-md:mx-0 max-md:rounded-none max-md:h-full max-md:max-h-full flex flex-col">
        <div className="h-1 bg-[#a371f7] rounded-t-lg shrink-0" />

        <div className="flex items-center justify-between px-4 py-3 border-b border-[#30363d] shrink-0">
          <span className="text-sm font-semibold text-[#e6edf3]">Loop Configuration</span>
          <button
            onClick={onClose}
            className="text-[#8b949e] hover:text-[#c9d1d9] transition-colors"
            aria-label="Close"
          >
            <XMarkIcon className="w-4 h-4" />
          </button>
        </div>

        <div className="px-4 py-4 flex flex-col gap-4 overflow-y-auto flex-1">
          {error && (
            <div className="text-xs text-[#f85149] bg-[#f85149]/10 border border-[#f85149]/30 rounded px-3 py-2">
              {error}
            </div>
          )}

          <div>
            <label className={labelCls}>Name</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className={inputCls}
              placeholder="Loop"
            />
          </div>

          <div>
            <label className={labelCls}>Prompt <span className="text-[#f85149]">*</span></label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              className={`${inputCls} resize-y min-h-[80px]`}
              placeholder="Message to send each iteration…"
              rows={3}
            />
          </div>

          <div>
            <label className={labelCls}>Strategy</label>
            <select
              value={strategyType}
              onChange={(e) => setStrategyType(e.target.value as StrategyType)}
              className={inputCls}
            >
              <option value="interval">Interval</option>
              <option value="on_idle">On Idle (cooldown)</option>
              <option value="hybrid">Hybrid (cooldown + max idle)</option>
              <option value="burst">Burst</option>
            </select>

            {strategyType === "interval" && (
              <div className="mt-2">
                <label className={labelCls}>Interval (seconds)</label>
                <input
                  type="number"
                  min="1"
                  value={intervalSec}
                  onChange={(e) => setIntervalSec(e.target.value)}
                  className={inputCls}
                />
              </div>
            )}
            {(strategyType === "on_idle" || strategyType === "hybrid") && (
              <div className="mt-2">
                <label className={labelCls}>Cooldown after session ends (seconds)</label>
                <input
                  type="number"
                  min="1"
                  value={cooldownSec}
                  onChange={(e) => setCooldownSec(e.target.value)}
                  className={inputCls}
                />
              </div>
            )}
            {strategyType === "hybrid" && (
              <div className="mt-2">
                <label className={labelCls}>Max idle before forcing next iteration (seconds)</label>
                <input
                  type="number"
                  min="1"
                  value={maxIdleSec}
                  onChange={(e) => setMaxIdleSec(e.target.value)}
                  className={inputCls}
                />
              </div>
            )}
            {strategyType === "burst" && (
              <div className="mt-2">
                <label className={labelCls}>Number of iterations</label>
                <input
                  type="number"
                  min="1"
                  value={burstCount}
                  onChange={(e) => setBurstCount(e.target.value)}
                  className={inputCls}
                />
              </div>
            )}
          </div>

          <div>
            <button
              type="button"
              onClick={() => setTerminationOpen((o) => !o)}
              className="flex items-center gap-1.5 text-xs text-[#8b949e] hover:text-[#c9d1d9] transition-colors w-full"
            >
              {terminationOpen ? (
                <ChevronDownIcon className="w-3 h-3" />
              ) : (
                <ChevronRightIcon className="w-3 h-3" />
              )}
              Termination Conditions
            </button>
            {terminationOpen && (
              <div className="mt-3 flex flex-col gap-3 pl-1">
                <TerminationRow
                  label="Max iterations"
                  checked={termination.maxIterations.enabled}
                  onCheck={(v) => updateTerm("maxIterations", { enabled: v })}
                >
                  <input
                    type="number"
                    min="1"
                    value={termination.maxIterations.value}
                    onChange={(e) => updateTerm("maxIterations", { value: e.target.value })}
                    className={`${inputCls} w-24`}
                    disabled={!termination.maxIterations.enabled}
                  />
                </TerminationRow>

                <TerminationRow
                  label="Max duration (minutes)"
                  checked={termination.maxDurationMin.enabled}
                  onCheck={(v) => updateTerm("maxDurationMin", { enabled: v })}
                >
                  <input
                    type="number"
                    min="1"
                    value={termination.maxDurationMin.value}
                    onChange={(e) => updateTerm("maxDurationMin", { value: e.target.value })}
                    className={`${inputCls} w-24`}
                    disabled={!termination.maxDurationMin.enabled}
                  />
                </TerminationRow>

                <TerminationRow
                  label="Stop on content match"
                  checked={termination.contentMatch.enabled}
                  onCheck={(v) => updateTerm("contentMatch", { enabled: v })}
                >
                  <input
                    type="text"
                    value={termination.contentMatch.pattern}
                    onChange={(e) => updateTerm("contentMatch", { pattern: e.target.value })}
                    className={`${inputCls} flex-1`}
                    placeholder="Pattern…"
                    disabled={!termination.contentMatch.enabled}
                  />
                </TerminationRow>

                <TerminationRow
                  label="Max consecutive errors"
                  checked={termination.consecutiveErrors.enabled}
                  onCheck={(v) => updateTerm("consecutiveErrors", { enabled: v })}
                >
                  <input
                    type="number"
                    min="1"
                    value={termination.consecutiveErrors.value}
                    onChange={(e) => updateTerm("consecutiveErrors", { value: e.target.value })}
                    className={`${inputCls} w-24`}
                    disabled={!termination.consecutiveErrors.enabled}
                  />
                </TerminationRow>
              </div>
            )}
          </div>

          <div>
            <button
              type="button"
              onClick={() => setOverridesOpen((o) => !o)}
              className="flex items-center gap-1.5 text-xs text-[#8b949e] hover:text-[#c9d1d9] transition-colors w-full"
            >
              {overridesOpen ? (
                <ChevronDownIcon className="w-3 h-3" />
              ) : (
                <ChevronRightIcon className="w-3 h-3" />
              )}
              Per-iteration Overrides
            </button>
            {overridesOpen && (
              <div className="mt-3 flex flex-col gap-3 pl-1">
                <div>
                  <label className={labelCls}>Permission mode</label>
                  <select
                    value={permissionMode}
                    onChange={(e) => setPermissionMode(e.target.value as PermissionMode | "")}
                    className={inputCls}
                  >
                    <option value="">— inherit —</option>
                    <option value="default">Default</option>
                    <option value="plan">Plan</option>
                    <option value="acceptEdits">Accept Edits</option>
                    <option value="bypassPermissions">Bypass Permissions</option>
                  </select>
                </div>
                <div>
                  <label className={labelCls}>Model</label>
                  <input
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    className={inputCls}
                    placeholder="— inherit —"
                  />
                </div>
                <div>
                  <label className={labelCls}>Effort</label>
                  <select
                    value={effort}
                    onChange={(e) => setEffort(e.target.value)}
                    className={inputCls}
                  >
                    <option value="">— inherit —</option>
                    <option value="low">Low</option>
                    <option value="normal">Normal</option>
                    <option value="high">High</option>
                  </select>
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center justify-between px-4 py-3 border-t border-[#30363d] shrink-0 gap-2">
          {existingLoop ? (
            <>
              <button
                onClick={() => void handleDelete()}
                disabled={submitting}
                className="text-xs text-[#f85149] hover:bg-[#f85149]/10 px-3 py-1.5 rounded transition-colors disabled:opacity-50"
              >
                Delete Loop
              </button>
              <div className="flex gap-2">
                <button
                  onClick={onClose}
                  className="text-xs text-[#8b949e] hover:text-[#c9d1d9] px-3 py-1.5 rounded border border-[#30363d] hover:border-[#484f58] transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={() => void handleSubmit()}
                  disabled={submitting}
                  className="text-xs bg-[#a371f7] hover:bg-[#8957e5] text-white px-3 py-1.5 rounded transition-colors disabled:opacity-50"
                >
                  {submitting ? "Saving…" : "Update"}
                </button>
              </div>
            </>
          ) : (
            <>
              <button
                onClick={onClose}
                className="text-xs text-[#8b949e] hover:text-[#c9d1d9] px-3 py-1.5 rounded border border-[#30363d] hover:border-[#484f58] transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => void handleSubmit()}
                disabled={submitting}
                className="text-xs bg-[#a371f7] hover:bg-[#8957e5] text-white px-3 py-1.5 rounded transition-colors disabled:opacity-50"
              >
                {submitting ? "Creating…" : "Create Loop"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

interface TerminationRowProps {
  label: string;
  checked: boolean;
  onCheck: (v: boolean) => void;
  children: React.ReactNode;
}

function TerminationRow({ label, checked, onCheck, children }: TerminationRowProps) {
  return (
    <div className="flex items-center gap-3">
      <label className="flex items-center gap-2 shrink-0 cursor-pointer">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onCheck(e.target.checked)}
          className="accent-[#a371f7]"
        />
        <span className="text-xs text-[#8b949e]">{label}</span>
      </label>
      {children}
    </div>
  );
}
