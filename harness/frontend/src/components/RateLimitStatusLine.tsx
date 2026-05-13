import { useEffect, useState, useSyncExternalStore, type ReactElement } from "react";
import {
  getRateLimitEntries,
  subscribeRateLimitStatus,
  type RateLimitSnapshot,
} from "../stores/rateLimitStatus";

const ONE_HOUR_MS = 60 * 60 * 1000;
const TWO_HOURS_MS = 2 * ONE_HOUR_MS;
const TICK_INTERVAL_MS = 60 * 1000; // age transitions in 1h/2h — a 1min tick is plenty

const PROVIDER_LABELS: Record<string, string> = {
  claude: "Claude",
  codex: "OpenAI",
};

function providerLabel(provider: string): string {
  return (
    PROVIDER_LABELS[provider] ||
    provider.charAt(0).toUpperCase() + provider.slice(1)
  );
}

/**
 * Recursively find the first primitive value whose key matches any of the
 * given patterns. Rate-limit payload shapes vary by SDK version (fields can
 * live at the top level or nested under `rate_limit` / `limits` / etc.),
 * so we search the whole tree instead of hardcoding paths.
 */
function findField<T extends string | number>(
  obj: unknown,
  keyPatterns: RegExp[],
  accept: (v: unknown) => v is T,
  seen: Set<object> = new Set(),
): T | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  if (seen.has(obj as object)) return undefined;
  seen.add(obj as object);

  const entries = Array.isArray(obj)
    ? obj.map((v, i) => [String(i), v] as const)
    : Object.entries(obj as Record<string, unknown>);

  // First pass: direct matches on primitive values at this level.
  for (const [key, value] of entries) {
    if (keyPatterns.some((re) => re.test(key)) && accept(value)) {
      return value;
    }
  }
  // Second pass: recurse into nested objects.
  for (const [, value] of entries) {
    if (value && typeof value === "object") {
      const nested = findField(value, keyPatterns, accept, seen);
      if (nested !== undefined) return nested;
    }
  }
  return undefined;
}

const isNumber = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);
const isStringOrNumber = (v: unknown): v is string | number =>
  typeof v === "string" || isNumber(v);

function toResetMs(v: string | number): number | undefined {
  if (typeof v === "number") {
    // Unix seconds (10 digits) → ms; ms (13 digits) passthrough.
    return v < 1e12 ? v * 1000 : v;
  }
  const parsed = Date.parse(v);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function formatResetDelta(resetMs: number, now: number): string | null {
  const deltaMin = Math.round((resetMs - now) / 60000);
  if (deltaMin > 24 * 60) {
    // Over a day out — collapse to compact "NdNh" form.
    const totalHours = Math.floor(deltaMin / 60);
    const d = Math.floor(totalHours / 24);
    const h = totalHours % 24;
    return `resets in ${d}d${h}h`;
  }
  if (deltaMin > 60) {
    const h = Math.floor(deltaMin / 60);
    const m = deltaMin % 60;
    return `resets in ${h}h${m ? ` ${m}m` : ""}`;
  }
  if (deltaMin > 0) return `resets in ${deltaMin}m`;
  if (deltaMin > -5) return "resetting";
  return null;
}

function formatSnapshot(snapshot: RateLimitSnapshot, now: number): string {
  const data = snapshot.data;
  const parts: string[] = [];

  // 1) Utilization %: look for explicit percentage fields first, otherwise
  //    derive from remaining/limit or used/limit pairs.
  let pct = findField(
    data,
    [/percent/i, /utiliz/i, /\bused.*pct\b/i, /pct.*used/i],
    isNumber,
  );
  if (pct !== undefined && pct <= 1) pct = pct * 100; // handle 0–1 fractions

  if (pct === undefined) {
    const used = findField(data, [/^used$/i, /\bused\b/i], isNumber);
    const limit = findField(
      data,
      [/^limit$/i, /\blimit\b/i, /\btotal\b/i, /\bmax\b/i],
      isNumber,
    );
    const remaining = findField(
      data,
      [/^remaining$/i, /\bremaining\b/i, /\bleft\b/i],
      isNumber,
    );
    if (limit && typeof limit === "number" && limit > 0) {
      if (used !== undefined) pct = (used / limit) * 100;
      else if (remaining !== undefined) pct = ((limit - remaining) / limit) * 100;
    }
  }
  if (pct !== undefined) {
    parts.push(`${Math.round(pct)}% used`);
  }

  // 2) Reset time: any key containing "reset" or "expir".
  const resetRaw = findField(
    data,
    [/reset/i, /expir/i],
    isStringOrNumber,
  );
  if (resetRaw !== undefined) {
    const resetMs = toResetMs(resetRaw);
    if (resetMs !== undefined) {
      const delta = formatResetDelta(resetMs, now);
      if (delta) parts.push(delta);
    }
  }

  // 3) Status label (e.g. "allowed_warning", "exceeded", "limit_reached").
  const status = findField(
    data,
    [/^status$/i, /\bstate\b/i],
    (v): v is string => typeof v === "string",
  );
  if (status && !parts.some((p) => p.includes("used"))) {
    parts.unshift(status.replace(/_/g, " "));
  } else if (status) {
    parts.push(status.replace(/_/g, " "));
  }

  if (parts.length > 0) return parts.join(" · ");

  // Final fallback: dump the primitive fields of the payload so the user
  // sees the actual data instead of "status received". This also gives us
  // visibility into what fields to add to the search lists above.
  const flat: string[] = [];
  const walk = (obj: unknown, prefix = ""): void => {
    if (!obj || typeof obj !== "object") return;
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (k === "type" || k === "source" || k === "raw") continue;
      const path = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === "object") walk(v, path);
      else if (v !== undefined && v !== null)
        flat.push(`${path}=${String(v).slice(0, 40)}`);
    }
  };
  walk(data);
  return flat.length > 0 ? flat.slice(0, 4).join(" · ") : "(no data)";
}

function formatAgeHint(receivedAt: number, now: number): string {
  const ageMin = Math.floor((now - receivedAt) / 60000);
  if (ageMin < 1) return "just now";
  if (ageMin < 60) return `${ageMin}m ago`;
  const ageH = Math.floor(ageMin / 60);
  return `${ageH}h ago`;
}

export function RateLimitStatusLine(): ReactElement | null {
  const entries = useSyncExternalStore(
    subscribeRateLimitStatus,
    getRateLimitEntries,
  );

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), TICK_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, []);

  const visible = Object.entries(entries)
    .filter(([, snap]) => now - snap.receivedAt < TWO_HOURS_MS)
    .sort(([a], [b]) => a.localeCompare(b));

  if (visible.length === 0) return null;

  return (
    <div className="px-3 py-1.5 border-t border-[#30363d] shrink-0 flex flex-col gap-0.5">
      {visible.map(([provider, snap]) => {
        const age = now - snap.receivedAt;
        const stale = age >= ONE_HOUR_MS;
        const fromError = snap.data.source === "error_message";
        // Fresh error → warning red. Fresh event → neutral gray. Stale → dim.
        const textClass = stale
          ? "text-[#484f58]"
          : fromError
            ? "text-[#f85149]"
            : "text-[#8b949e]";
        const body = formatSnapshot(snap, now);
        const tooltip = [
          `${providerLabel(provider)}: ${body}`,
          `Received ${formatAgeHint(snap.receivedAt, now)}${stale ? " — may be stale" : ""}`,
        ].join("\n");
        return (
          <div
            key={provider}
            className={`text-[11px] leading-tight ${textClass} flex items-baseline gap-1.5 truncate`}
            title={tooltip}
          >
            <span className="font-medium">{providerLabel(provider)}:</span>
            <span className="truncate">{body}</span>
          </div>
        );
      })}
    </div>
  );
}
