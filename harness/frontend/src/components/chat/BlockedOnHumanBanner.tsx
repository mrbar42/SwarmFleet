import { useEffect, useState } from "react";
import type { BlockedOnHumanInfo } from "@shared/types";

interface BlockedOnHumanBannerProps {
  /**
   * Reason payload from the backend status event. When null, the banner
   * still renders (status said `blocked_on_human` but no payload arrived) —
   * we surface a fallback rather than silently hide the block.
   */
  blockedOnHuman: BlockedOnHumanInfo | null;
}

const TEST_LABELS: Record<BlockedOnHumanInfo["whichTest"], string> = {
  irreversibility: "About to take an irreversible action",
  scope_breach: "About to act outside the original mission",
};

function formatElapsed(requestedAt: string, now: number): string | null {
  const startedMs = Date.parse(requestedAt);
  if (!Number.isFinite(startedMs)) return null;
  const deltaSec = Math.max(0, Math.floor((now - startedMs) / 1000));
  if (deltaSec < 60) return `Paused ${deltaSec}s ago`;
  const deltaMin = Math.floor(deltaSec / 60);
  if (deltaMin < 60) return `Paused ${deltaMin}m ago`;
  const deltaHr = Math.floor(deltaMin / 60);
  const remMin = deltaMin - deltaHr * 60;
  return remMin > 0
    ? `Paused ${deltaHr}h${remMin}m ago`
    : `Paused ${deltaHr}h ago`;
}

/**
 * Prominent banner shown at the top of the chat when a session has paused and
 * asked the operator to weigh in.
 */
export function BlockedOnHumanBanner({
  blockedOnHuman,
}: BlockedOnHumanBannerProps) {
  // Tick once a minute so the elapsed-time line stays roughly accurate
  // without firing a re-render every second.
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  const headline = blockedOnHuman
    ? TEST_LABELS[blockedOnHuman.whichTest]
    : "Reason unavailable";
  const action = blockedOnHuman?.specificIrreversibleAction;
  const why = blockedOnHuman?.whyPlannerCannotDecide;
  const elapsed = blockedOnHuman ? formatElapsed(blockedOnHuman.requestedAt, now) : null;

  return (
    <div
      data-testid="blocked-on-human-banner"
      role="alert"
      aria-live="assertive"
      className="flex-shrink-0 mx-3 sm:mx-4 mt-3 mb-2 px-4 py-4 bg-[#3a2a08] border-2 border-[#d29922] rounded-xl shadow-lg"
    >
      <div className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className="mt-0.5 inline-flex w-6 h-6 shrink-0 items-center justify-center rounded-full bg-[#d29922]/20 text-[#fbbf24] text-base"
        >
          ⏸
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-sm font-semibold text-[#fde68a]">
              Session paused — review requested
            </h3>
            <span className="inline-flex w-2 h-2 rounded-full bg-[#fbbf24] animate-pulse" />
          </div>
          <p className="mt-1 text-xs uppercase tracking-wider text-[#fbbf24]/80 font-semibold">
            {headline}
          </p>

          {action ? (
            <div
              data-testid="blocked-on-human-action"
              className="mt-3 px-3 py-2 bg-[#0d1117] border border-[#d29922]/40 rounded-md font-mono text-sm text-[#e6edf3] whitespace-pre-wrap break-words"
            >
              {action}
            </div>
          ) : (
            <p className="mt-3 text-sm text-[#8b949e] italic">
              The session did not provide a specific action.
            </p>
          )}

          {why ? (
            <p
              data-testid="blocked-on-human-why"
              className="mt-3 text-sm text-[#c9d1d9] whitespace-pre-wrap break-words"
            >
              <span className="font-semibold text-[#fde68a]">Why the planner can't decide: </span>
              {why}
            </p>
          ) : null}

          <div className="mt-4 flex items-center justify-between gap-3 flex-wrap">
            <p className="text-xs text-[#fde68a]/90 font-medium">
              Reply below to unblock the session.
            </p>
            {elapsed ? (
              <span className="text-xs text-[#8b949e] font-mono">{elapsed}</span>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
