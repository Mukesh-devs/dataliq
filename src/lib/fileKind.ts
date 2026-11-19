import type { FileFormat, SourceInfo } from "./files";
import { isUrl } from "./remote";

/** What a tab shows, for its icon: the kind of file, or what made it. */
export type FileKind =
  | "csv"
  | "excel"
  | "json"
  | "parquet"
  | "database"
  | "folder"
  | "url"
  | "sql"
  | "compare"
  | "table";

const BY_FORMAT: Record<FileFormat, FileKind> = {
  csv: "csv",
  tsv: "csv",
  json: "json",
  ndjson: "json",
  parquet: "parquet",
  xlsx: "excel",
  xls: "excel",
  sqlite: "database",
  duckdb: "database",
  sql: "sql",
};

const BY_EXTENSION: Record<string, FileKind> = {
  csv: "csv",
  tsv: "csv",
  tab: "csv",
  txt: "csv",
  json: "json",
  jsonl: "json",
  ndjson: "json",
  parquet: "parquet",
  pq: "parquet",
  xlsx: "excel",
  xlsm: "excel",
  xls: "excel",
  sqlite: "database",
  sqlite3: "database",
  db: "database",
  duckdb: "database",
};

/** "orders.csv.gz" → "csv": the extension under any compression. */
function extension(name: string): string {
  const parts = name.toLowerCase().split(/[\\/]/).pop()!.split(".");
  while (parts.length > 1 && ["gz", "gzip", "zst", "zstd"].includes(parts.at(-1)!)) parts.pop();
  return parts.length > 1 ? parts.at(-1)! : "";
}

/**
 * A tab's kind: what the app learned when it opened the file (its format,
 * a folder of files, a comparison, a SQL result), or, while it's still
 * opening, the file name's extension.
 */
export function fileKind(tab: {
  title: string;
  path?: string;
  info?: Pick<SourceInfo, "format" | "files"> | null;
  compare?: unknown;
}): FileKind {
  if (tab.compare) return "compare";
  if (tab.info?.format === "sql") return "sql";
  if (tab.info?.files) return "folder";
  if (tab.path && isUrl(tab.path)) return "url";
  if (tab.info?.format) return BY_FORMAT[tab.info.format] ?? "table";
  return BY_EXTENSION[extension(tab.path || tab.title)] ?? "table";
}
