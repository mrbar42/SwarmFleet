import { useEffect, useState, useCallback } from "react";
import { useLoopStore } from "../../stores/loopStore";

interface LoopCountdownBannerProps {
  sessionId: string;
}

export function LoopCountdownBanner({ sessionId }: LoopCountdownBannerProps) {
  const countdown = useLoopStore((state) => state.countdown);
  const playLoop = useLoopStore((state) => state.playLoop);
  const clearCountdown = useLoopStore((state) => state.clearCountdown);
  const [secondsLeft, setSecondsLeft] = useState(0);

  const isVisible =
    countdown !== null && countdown.sessionId === sessionId;

  useEffect(() => {
    if (!isVisible) return;
    const update = () => {
      const remaining = Math.max(
        0,
        Math.ceil((countdown!.endsAt - Date.now()) / 1000),
      );
      setSecondsLeft(remaining);
    };
    update();
    const id = setInterval(update, 200);
    return () => clearInterval(id);
  }, [isVisible, countdown]);

  const handleStart = useCallback(() => {
    if (!countdown) return;
    clearCountdown();
    void playLoop(countdown.loopId);
  }, [countdown, clearCountdown, playLoop]);

  const handleCancel = useCallback(() => {
    clearCountdown();
  }, [clearCountdown]);

  useEffect(() => {
    if (!isVisible) return;
    if (secondsLeft <= 0) {
      handleStart();
    }
  }, [isVisible, secondsLeft, handleStart]);

  if (!isVisible) return null;

  return (
    <div className="md:max-w-[750px] mx-auto w-full">
      <div className="flex items-center justify-between bg-[#161b22] border-x border-t border-[#a371f7]/30 rounded-t-xl px-4 py-2">
        <span className="text-sm text-[#a371f7]">
          Starting loop in… {secondsLeft}s
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleStart}
            className="text-xs font-medium text-[#a371f7] hover:text-[#c4a5fb] px-2.5 py-1 rounded border border-[#a371f7]/40 hover:border-[#a371f7]/70 transition-colors"
          >
            Start
          </button>
          <button
            type="button"
            onClick={handleCancel}
            className="text-xs font-medium text-[#8b949e] hover:text-[#c9d1d9] px-2.5 py-1 rounded border border-[#30363d] hover:border-[#484f58] transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
