import { format } from "sql-formatter";

/** Formats DuckDB SQL; throws when it can't be parsed. */
export function formatSql(text: string): string {
  return format(text, { language: "duckdb", keywordCase: "upper", tabWidth: 2 });
}
