import { invoke } from "@tauri-apps/api/core";
import type { Table } from "apache-arrow";
import { decodeIpc } from "./arrow";

/** Value bound to a `?` / `$1` placeholder. Never spliced into SQL text. */
export type Param = null | boolean | number | string;

export interface QueryOptions {
  params?: Param[];
  /** Maximum rows to return (backend caps this at 100,000). */
  maxRows?: number;
  /** Id used to cancel this request with `cancelQuery`. */
  requestId?: string;
  /** Starting a request in a group cancels older requests in that group. */
  group?: string;
  /** Run on the SQL panel's session connection (temp tables and SET persist). */
  session?: boolean;
}

export type ErrorKind = "query" | "cancelled" | "io" | "settings" | "internal";

/** Error raised by a backend command, with a user-facing message. */
export class DataLiqError extends Error {
  readonly kind: ErrorKind;
  constructor(kind: ErrorKind, message: string) {
    super(message);
    this.name = "DataLiqError";
    this.kind = kind;
  }
}

function toError(err: unknown): DataLiqError {
  if (err && typeof err === "object" && "kind" in err && "message" in err) {
    const e = err as { kind: ErrorKind; message: string };
    return new DataLiqError(e.kind, e.message);
  }
  return new DataLiqError("internal", String(err));
}

/** Calls a backend command, normalizing errors to DataLiqError. */
export async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (err) {
    throw toError(err);
  }
}

/** Runs SQL in DuckDB and decodes the Arrow IPC response. */
export async function runQuery(sql: string, options: QueryOptions = {}): Promise<Table> {
  const bytes = await call<ArrayBuffer>("run_query", { sql, options });
  return decodeIpc(bytes);
}

/** Cancels a running request. Resolves to false if it already finished. */
export function cancelQuery(requestId: string): Promise<boolean> {
  return call<boolean>("cancel_query", { requestId });
}
