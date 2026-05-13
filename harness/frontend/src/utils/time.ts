import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";

dayjs.extend(relativeTime);

/**
 * Format a timestamp as an absolute time string
 */
export function formatAbsoluteTime(timestamp: number): string {
  const messageTime = dayjs(timestamp);
  const now = dayjs();

  if (messageTime.isSame(now, "day")) {
    return messageTime.format("HH:mm");
  }
  if (messageTime.isSame(now, "year")) {
    return messageTime.format("MMM D, HH:mm");
  }
  return messageTime.format("MMM D, YYYY HH:mm");
}

/**
 * Format a timestamp as a relative time string
 */
export function formatRelativeTime(timestamp: number): string {
  const messageTime = dayjs(timestamp);
  const now = dayjs();

  if (messageTime.isAfter(now)) {
    return "just now";
  }

  const diffInMinutes = now.diff(messageTime, "minute");
  if (diffInMinutes < 1) {
    return "just now";
  }

  return messageTime.fromNow();
}

/**
 * Format a timestamp as compact relative time, e.g. "4m ago".
 */
export function formatShortRelativeTime(timestamp: number): string {
  const messageTime = dayjs(timestamp);
  const now = dayjs();

  if (messageTime.isAfter(now)) {
    return "now";
  }

  const diffInSeconds = now.diff(messageTime, "second");
  if (diffInSeconds < 60) {
    return "now";
  }

  const diffInMinutes = now.diff(messageTime, "minute");
  if (diffInMinutes < 60) {
    return `${diffInMinutes}m ago`;
  }

  const diffInHours = now.diff(messageTime, "hour");
  if (diffInHours < 24) {
    return `${diffInHours}h ago`;
  }

  const diffInDays = now.diff(messageTime, "day");
  if (diffInDays < 30) {
    return `${diffInDays}d ago`;
  }

  const diffInMonths = now.diff(messageTime, "month");
  if (diffInMonths < 12) {
    return `${diffInMonths}mo ago`;
  }

  return `${now.diff(messageTime, "year")}y ago`;
}
