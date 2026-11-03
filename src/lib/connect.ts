import { quoteIdent } from "./copyAs";
import { call } from "./ipc";

/** Live MySQL and PostgreSQL databases, attached read-only (see the backend's `connect`). */

export type Driver = "mysql" | "postgres";

export const DRIVERS: { driver: Driver; label: string; port: number }[] = [
  { driver: "mysql", label: "MySQL / MariaDB", port: 3306 },
  { driver: "postgres", label: "PostgreSQL", port: 5432 },
];

export interface DbConnection {
  /** Its tables' prefix in SQL: `cdr` in `cdr.calls`. */
  name: string;
  driver: Driver;
  host: string;
  port: number;
  database: string;
  user: string;
}

export interface SavedConnection extends DbConnection {
  hasPassword: boolean;
  connected: boolean;
}

export interface LiveTable {
  schema: string;
  name: string;
  /** "BASE TABLE" or "VIEW". */
  kind: string;
}

export interface Connected {
  name: string;
  tables: LiveTable[];
}

export function listConnections(): Promise<SavedConnection[]> {
  return call("list_connections");
}

/** Connects; without `password`, the one saved in the keychain is used. */
export function connectDatabase(
  connection: DbConnection,
  password: string | undefined,
  remember: boolean,
): Promise<Connected> {
  return call("connect_database", {
    request: { connection, password: password ?? null, remember },
  });
}

export function disconnectDatabase(name: string): Promise<void> {
  return call("disconnect_database", { name });
}

export function forgetConnection(name: string): Promise<void> {
  return call("forget_connection", { name });
}

/** A name for SQL made from a database name: `CDR Prod-2024` → `cdr_prod_2024`. */
export function connectionName(database: string): string {
  const n = database
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!n) return "db";
  return /^[a-z_]/.test(n) ? n : `db_${n}`;
}

/** A table of an attached database in SQL: `"cdr"."public"."calls"`. */
export function liveTableSql(connection: string, t: LiveTable): string {
  return `${quoteIdent(connection)}.${quoteIdent(t.schema)}.${quoteIdent(t.name)}`;
}

/** The query that opens a table as a tab: every row, or the first `limit`. */
export function openTableSql(connection: string, t: LiveTable, limit?: number): string {
  return `SELECT * FROM ${liveTableSql(connection, t)}${limit ? `\nLIMIT ${Math.floor(limit)}` : ""}`;
}
