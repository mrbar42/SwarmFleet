import { useState, useEffect } from "react";
import {
  formatAbsoluteTime,
  formatRelativeTime,
  formatShortRelativeTime,
} from "../utils/time";

interface TimestampProps {
  timestamp: number;
  className?: string;
  mode?: "absolute" | "relative" | "absolute-relative" | "absolute-short-relative";
}

export function TimestampComponent({
  timestamp,
  className = "",
  mode = "absolute",
}: TimestampProps) {
  const [displayTime, setDisplayTime] = useState<string>("");

  useEffect(() => {
    const updateTime = () => {
      setDisplayTime(
        mode === "absolute"
          ? formatAbsoluteTime(timestamp)
          : mode === "relative"
            ? formatRelativeTime(timestamp)
            : mode === "absolute-relative"
              ? `${formatAbsoluteTime(timestamp)} (${formatRelativeTime(timestamp)})`
              : `${formatAbsoluteTime(timestamp)} (${formatShortRelativeTime(timestamp)})`,
      );
    };

    updateTime();

    if (
      mode === "relative" ||
      mode === "absolute-relative" ||
      mode === "absolute-short-relative"
    ) {
      const interval = setInterval(updateTime, 60000);
      return () => clearInterval(interval);
    }
  }, [timestamp, mode]);

  return (
    <span className={className} aria-label={`Sent at ${displayTime}`}>
      {displayTime}
    </span>
  );
}
