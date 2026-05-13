import { useEffect, useState } from "react";
import { PlayIcon, PauseIcon } from "@heroicons/react/24/outline";
import { useLoopStore } from "../../stores/loopStore";
import { LoopConfigDialog } from "./LoopConfigDialog";

interface LoopControlBarProps {
  sessionId: string;
}

export function LoopControlBar({ sessionId }: LoopControlBarProps) {
  const [dialogOpen, setDialogOpen] = useState(false);

  const loop = useLoopStore((state) => state.loops.get(sessionId));
  const fetchLoop = useLoopStore((state) => state.fetchLoop);
  const playLoop = useLoopStore((state) => state.playLoop);
  const pauseLoop = useLoopStore((state) => state.pauseLoop);

  useEffect(() => {
    void fetchLoop(sessionId);
  }, [sessionId, fetchLoop]);

  const isRunning = loop?.state === "running";
  const isActive = loop && (loop.state === "running" || loop.state === "paused");

  function loopLabel() {
    if (!loop) return <span className="text-[#8b949e]">Loop</span>;
    if (loop.state === "running") {
      return (
        <span className="flex items-center gap-1">
          <span className="w-1.5 h-1.5 rounded-full bg-[#a371f7] shrink-0" />
          <span className="text-[#a371f7]">Loop #{loop.iterationCount}</span>
        </span>
      );
    }
    if (loop.state === "paused") {
      return <span className="text-[#8b949e]">Loop ⏸</span>;
    }
    if (loop.state === "error") {
      return <span className="text-[#8b949e]">Loop !</span>;
    }
    return (
      <span className="flex items-center gap-1">
        <span className="w-1.5 h-1.5 rounded-full bg-[#a371f7] shrink-0" />
        <span className="text-[#8b949e]">Loop</span>
      </span>
    );
  }

  const btnBase =
    "flex items-center justify-center px-1.5 py-0.5 rounded text-[10px] border border-[#30363d] hover:border-[#484f58] transition-colors";

  return (
    <>
      <div className="flex items-center gap-0.5">
        {loop && !isRunning && (
          <button
            onClick={() => void playLoop(loop.id)}
            className={`${btnBase} text-[#8b949e] hover:text-[#a371f7]`}
            title="Resume loop"
            aria-label="Resume loop"
          >
            <PlayIcon className="w-3 h-3" />
          </button>
        )}
        {loop && isRunning && (
          <button
            onClick={() => void pauseLoop(loop.id)}
            className={`${btnBase} text-[#a371f7] hover:text-[#8957e5]`}
            title="Pause loop"
            aria-label="Pause loop"
          >
            <PauseIcon className="w-3 h-3" />
          </button>
        )}
        <button
          onClick={() => setDialogOpen(true)}
          className={`${btnBase} ${isActive ? "text-[#a371f7]" : "text-[#8b949e] hover:text-[#c9d1d9]"}`}
          title={loop ? "Edit loop configuration" : "Configure loop"}
        >
          {loopLabel()}
        </button>
      </div>

      <LoopConfigDialog
        sessionId={sessionId}
        isOpen={dialogOpen}
        onClose={() => setDialogOpen(false)}
        existingLoop={loop}
      />
    </>
  );
}
