import { useEffect } from "react";

interface UsePollOptions {
  enabled?: boolean;
  timeoutMs?: number;
}

export function usePoll(
  callback: (signal: AbortSignal) => Promise<void>,
  intervalMs: number,
  options: UsePollOptions = {},
) {
  const { enabled = true, timeoutMs = 15000 } = options;

  useEffect(() => {
    if (!enabled) return;

    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let controller: AbortController | null = null;
    let timeout: ReturnType<typeof setTimeout> | null = null;

    const clearRequestTimeout = () => {
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
    };

    const tick = async () => {
      controller = new AbortController();
      timeout = setTimeout(() => controller?.abort(), timeoutMs);
      try {
        await callback(controller.signal).catch(() => undefined);
      } finally {
        clearRequestTimeout();
        controller = null;
        if (!stopped) {
          timer = setTimeout(() => {
            void tick();
          }, intervalMs);
        }
      }
    };

    void tick();

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      clearRequestTimeout();
      controller?.abort();
    };
  }, [callback, enabled, intervalMs, timeoutMs]);
}
