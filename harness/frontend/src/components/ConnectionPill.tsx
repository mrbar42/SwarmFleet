import { useMemo } from "react";
import {
  ArrowPathIcon,
  SignalIcon,
  SignalSlashIcon,
} from "@heroicons/react/24/outline";
import {
  getConnectionState,
  getOverallConnectionState,
  INDEX_STREAM_KEY,
  useConnectionStateStore,
  type ConnectionState,
} from "../stores/connectionStateStore";
import { reconnectSessionIndexStream } from "../stores/sessionIndexStream";

const STATE_STYLES: Record<
  ConnectionState,
  { label: string; className: string; dot: string }
> = {
  live: {
    label: "Live",
    className: "border-[#238636] bg-[#0f2d1a] text-[#3fb950]",
    dot: "bg-[#3fb950]",
  },
  reconnecting: {
    label: "Reconnecting",
    className: "border-[#1f6feb] bg-[#0d2d57] text-[#79c0ff]",
    dot: "bg-[#58a6ff]",
  },
  offline: {
    label: "Offline",
    className: "border-[#8e1519] bg-[#3d1214] text-[#ff7b72]",
    dot: "bg-[#f85149]",
  },
  connecting: {
    label: "Connecting",
    className: "border-[#30363d] bg-[#21262d] text-[#8b949e]",
    dot: "bg-[#8b949e]",
  },
};

export function ConnectionPill() {
  const streams = useConnectionStateStore((state) => state.streams);

  const state = useMemo(() => getOverallConnectionState(), [streams]);
  const indexState = getConnectionState(streams[INDEX_STREAM_KEY]);
  const style = STATE_STYLES[state];
  const Icon = state === "offline" ? SignalSlashIcon : SignalIcon;

  return (
    <button
      type="button"
      onClick={reconnectSessionIndexStream}
      className={`h-6 inline-flex items-center gap-1.5 rounded-md border px-2 text-[11px] font-medium transition-colors hover:brightness-110 ${style.className}`}
      title={`Session index: ${STATE_STYLES[indexState].label}. Click to reconnect.`}
      aria-label={`Connection ${style.label}. Click to reconnect.`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${style.dot}`} />
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      <span className="hidden sm:inline">{style.label}</span>
      {state !== "live" && (
        <ArrowPathIcon
          className={`h-3 w-3 opacity-80 ${
            state === "reconnecting" ? "animate-spin" : ""
          }`}
          aria-hidden="true"
        />
      )}
    </button>
  );
}
