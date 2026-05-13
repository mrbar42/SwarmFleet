import { useMemo, useSyncExternalStore } from "react";
import type { ConversationSummary } from "@shared/types";
import {
  getSessionStatusMap,
  subscribeSessionStatus,
  type SessionStatusEntry,
} from "../stores/sessionStatus";

interface SubagentTabStripProps {
  parentId: string;
  siblings: ConversationSummary[] | undefined;
  activeSessionId: string | null;
  onSelect: (sessionId: string) => void;
}

function isActive(entry: SessionStatusEntry | undefined): boolean {
  if (!entry) return false;
  return Boolean(entry.isStreaming || entry.isWaitingForHuman);
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * Renders subagent child sessions of a given parent as inline chips next to
 * the parent's sidebar row. Active children (streaming or waiting for human)
 * sort to the left with a spinner; historic children sort to the right,
 * desaturated. Clicking a chip opens the child's conversation.
 */
export function SubagentTabStrip({
  parentId,
  siblings,
  activeSessionId,
  onSelect,
}: SubagentTabStripProps) {
  const statusMap = useSyncExternalStore(
    subscribeSessionStatus,
    getSessionStatusMap,
  );

  const children = useMemo(() => {
    if (!siblings) return [] as ConversationSummary[];
    return siblings.filter((s) => s.parentSessionId === parentId);
  }, [siblings, parentId]);

  const sorted = useMemo(() => {
    const withStatus = children.map((child) => ({
      child,
      active: isActive(statusMap.get(child.sessionId)),
    }));
    // Active first (left), then historic (right). Stable by startTime within
    // each group so order doesn't shuffle on every render.
    withStatus.sort((a, b) => {
      if (a.active !== b.active) return a.active ? -1 : 1;
      return (
        new Date(a.child.startTime).getTime() -
        new Date(b.child.startTime).getTime()
      );
    });
    return withStatus;
  }, [children, statusMap]);

  if (sorted.length === 0) return null;

  return (
    <div
      className="flex flex-1 min-w-0 max-w-full items-stretch self-stretch overflow-x-auto overflow-y-hidden"
      data-testid="subagent-tab-strip"
      data-parent-id={parentId}
    >
      {sorted.map(({ child, active }) => {
        const isCurrent = activeSessionId === child.sessionId;
        const label = truncate(
          child.title || child.lastMessagePreview || "subagent",
          14,
        );
        return (
          <div
            key={child.sessionId}
            role="tab"
            tabIndex={0}
            aria-selected={isCurrent}
            onClick={(e) => {
              e.stopPropagation();
              onSelect(child.sessionId);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                e.stopPropagation();
                onSelect(child.sessionId);
              }
            }}
            data-testid={`subagent-tab-${child.sessionId}`}
            data-active={active ? "true" : "false"}
            data-current={isCurrent ? "true" : "false"}
            title={child.title || child.lastMessagePreview || child.sessionId}
            className={`flex shrink-0 items-center gap-1.5 px-2 text-[11px] cursor-pointer select-none transition-colors border-b-2 ${
              isCurrent
                ? "border-[var(--accent-purple,#a371f7)] text-[#e6edf3]"
                : active
                  ? "border-transparent text-[#c9d1d9] hover:text-[#e6edf3]"
                  : "border-transparent text-[#484f58] hover:text-[#8b949e]"
            }`}
          >
            {active ? (
              <span className="w-1.5 h-1.5 inline-block">
                <span className="block w-1.5 h-1.5 rounded-full border border-[var(--accent-purple,#a371f7)] border-t-transparent animate-spin" />
              </span>
            ) : (
              <span className="w-1.5 h-1.5 rounded-full bg-[#30363d] inline-block" />
            )}
            <span className="truncate max-w-[96px]">{label}</span>
          </div>
        );
      })}
    </div>
  );
}
