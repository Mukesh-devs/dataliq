import type { ColumnKind } from "./arrow";

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

function isoDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function isoTimestamp(ms: number): string {
  const d = new Date(ms);
  const base = `${isoDate(ms)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  const frac = d.getUTCMilliseconds();
  return frac ? `${base}.${pad(frac, 3)}` : base;
}

/** JSON.stringify that survives BigInt and Arrow vectors/structs. */
export function toJsonText(value: unknown): string {
  const plain =
    value && typeof value === "object" && "toJSON" in value
      ? (value as { toJSON: () => unknown }).toJSON()
      : value;
  return JSON.stringify(plain, (_k, v: unknown) => {
    if (typeof v === "bigint") return v.toString();
    if (ArrayBuffer.isView(v) && !(v instanceof DataView)) return Array.from(v as Int32Array);
    if (v && typeof v === "object" && "toJSON" in v)
      return (v as { toJSON: () => unknown }).toJSON();
    return v;
  });
}

/**
 * Formats one cell for display. Returns `null` for SQL NULL so callers can
 * render it distinctly; an empty string stays an empty string.
 */
export function formatValue(value: unknown, kind: ColumnKind): string | null {
  if (value === null || value === undefined) return null;
  switch (kind) {
    case "date":
      return typeof value === "number" ? isoDate(value) : String(value);
    case "timestamp":
      return typeof value === "number" ? isoTimestamp(value) : String(value);
    case "json":
      return toJsonText(value);
    case "binary": {
      if (!(value instanceof Uint8Array)) return String(value);
      const hex = Array.from(value.subarray(0, 32), (b) => b.toString(16).padStart(2, "0")).join(
        "",
      );
      return `\\x${hex}${value.length > 32 ? "…" : ""}`;
    }
    default:
      return typeof value === "bigint" ? value.toString() : String(value);
  }
}

/** "1,234,567" with a thin, locale-independent grouping. */
export function formatCount(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

/** Human-readable byte size, e.g. "5.2 GB". */
export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i === 0 ? v : v.toFixed(1)} ${units[i]}`;
}

/** "0.21 s" / "1.4 s" / "850 ms". */
export function formatDuration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}
