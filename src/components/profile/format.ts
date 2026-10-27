import type { ProfileKind } from "../../lib/view";

/** A statistic for display: whole numbers with separators, others to 4 decimals. */
export function formatStat(n: number): string {
  if (Number.isInteger(n)) return n.toLocaleString("en-US");
  return n.toLocaleString("en-US", { maximumFractionDigits: 4 });
}

export function formatPercent(part: number, whole: number): string {
  if (whole === 0) return "0%";
  const p = (part / whole) * 100;
  if (p > 0 && p < 0.1) return "<0.1%";
  return `${p.toFixed(p < 10 ? 1 : 0)}%`;
}

/**
 * A histogram edge: dates (seconds since 1970) as ISO dates, or with the
 * time when the whole range spans less than two days.
 */
export function formatEdge(v: number, kind: ProfileKind, rangeSeconds = Infinity): string {
  if (kind !== "temporal") return formatStat(v);
  const iso = new Date(v * 1000).toISOString();
  return rangeSeconds < 2 * 86400 ? iso.slice(0, 19).replace("T", " ") : iso.slice(0, 10);
}
