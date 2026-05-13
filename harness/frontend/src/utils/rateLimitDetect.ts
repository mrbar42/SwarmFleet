/**
 * Heuristic rate-limit signal extraction from error strings.
 *
 * The Claude Agent SDK surfaces API rate limits as plain-text error messages
 * (on stream errors or on result messages with `is_error: true`). The text
 * format isn't stable, so we match a handful of common keywords and
 * opportunistically pull a reset timestamp out when we can find one.
 *
 * False negatives are acceptable (we'll just not update the status line);
 * false positives are worse (we'd show a bogus "rate limited" indicator), so
 * the keyword list is intentionally narrow.
 */

export interface DetectedRateLimit {
  /** Always "limit_reached" — emitted only when we're confident it's a rate-limit error. */
  status: "limit_reached";
  /** Unix ms at which the limit resets, if we could parse one. */
  resets_at?: number;
  /** Short excerpt of the original error for rendering tooltips / debug. */
  raw: string;
  /** Tag so the UI can distinguish error-derived entries from rate_limit_event entries. */
  source: "error_message";
}

const RATE_LIMIT_KEYWORDS: RegExp[] = [
  /rate.?limit/i,
  /usage.?limit/i,
  /too many requests/i,
  /\b429\b/,
  /quota.*exceed/i,
  /claude (code )?usage limit/i,
];

function looksLikeRateLimit(text: string): boolean {
  return RATE_LIMIT_KEYWORDS.some((re) => re.test(text));
}

function parseIsoReset(text: string): number | undefined {
  // e.g. "reset at 2025-01-01T00:00:00Z", "resets_at: 2025-01-01T00:00:00+00:00"
  const m = text.match(
    /reset(?:s)?(?:_at|\s*at|\s*in)?[^a-z0-9+\-]*(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)/i,
  );
  if (!m) return undefined;
  const ms = Date.parse(m[1]);
  return Number.isFinite(ms) ? ms : undefined;
}

function parseUnixReset(text: string): number | undefined {
  // e.g. "reset at 1735689600" (seconds) or 13-digit ms
  const m = text.match(/reset[^a-z0-9]*(\d{10,13})/i);
  if (!m) return undefined;
  const n = parseInt(m[1], 10);
  if (!Number.isFinite(n)) return undefined;
  return n < 1e12 ? n * 1000 : n;
}

function parseRelativeReset(text: string, now: number): number | undefined {
  // e.g. "try again in 15 minutes", "in 2 hours", "in 45 seconds"
  const m = text.match(/in\s+(\d+)\s*(second|minute|hour)s?/i);
  if (!m) return undefined;
  const n = parseInt(m[1], 10);
  const unit = m[2].toLowerCase();
  const multMs =
    unit.startsWith("sec") ? 1000 : unit.startsWith("min") ? 60_000 : 3_600_000;
  return now + n * multMs;
}

export function detectRateLimitFromText(
  text: string | null | undefined,
  now: number = Date.now(),
): DetectedRateLimit | null {
  if (!text || typeof text !== "string") return null;
  if (!looksLikeRateLimit(text)) return null;

  const resetsAt =
    parseIsoReset(text) ?? parseUnixReset(text) ?? parseRelativeReset(text, now);

  return {
    status: "limit_reached",
    resets_at: resetsAt,
    raw: text.slice(0, 500),
    source: "error_message",
  };
}
