import { tableFromIPC, Type, type DataType, type Field, type Table } from "apache-arrow";

/** Display category of a column, used for icons, alignment and formatting. */
export type ColumnKind =
  | "integer"
  | "number"
  | "text"
  | "boolean"
  | "date"
  | "timestamp"
  | "time"
  | "json"
  | "binary"
  | "other";

export interface ColumnInfo {
  name: string;
  kind: ColumnKind;
  /** Arrow type as text, e.g. "Int64" or "Timestamp<MICROSECOND>". */
  type: string;
  nullable: boolean;
  /** Digits after the decimal point (DECIMAL columns). */
  scale?: number;
  /** Ticks per second for TIME columns (1, 1e3, 1e6 or 1e9). */
  timeTicksPerSecond?: number;
}

/** What the formatter needs to know about a column. */
export type ValueFormat = Pick<ColumnInfo, "kind" | "scale" | "timeTicksPerSecond">;

/** Decodes Arrow IPC stream bytes (as returned by the backend) into a Table. */
export function decodeIpc(bytes: ArrayBuffer | Uint8Array): Table {
  return tableFromIPC(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
}

/** Maps an Arrow data type to a display kind. */
export function columnKind(type: DataType): ColumnKind {
  switch (type.typeId) {
    case Type.Int:
      return "integer";
    case Type.Float:
    case Type.Decimal:
      return "number";
    case Type.Utf8:
    case Type.LargeUtf8:
    case Type.Utf8View:
      return "text";
    case Type.Bool:
      return "boolean";
    case Type.Date:
      return "date";
    case Type.Timestamp:
      return "timestamp";
    case Type.Time:
      return "time";
    case Type.List:
    case Type.LargeList:
    case Type.FixedSizeList:
    case Type.Struct:
    case Type.Map:
    case Type.Union:
      return "json";
    case Type.Binary:
    case Type.LargeBinary:
    case Type.BinaryView:
    case Type.FixedSizeBinary:
      return "binary";
    case Type.Dictionary:
      // Dictionary-encoded columns display like their value type.
      return columnKind((type as unknown as { dictionary: DataType }).dictionary);
    default:
      return "other";
  }
}

const TICKS_PER_SECOND = [1, 1e3, 1e6, 1e9]; // by TimeUnit: s, ms, µs, ns

export function describeField(field: Field): ColumnInfo {
  const type = field.type as DataType & { scale?: number; unit?: number };
  const info: ColumnInfo = {
    name: field.name,
    kind: columnKind(field.type),
    type: String(field.type),
    nullable: field.nullable,
  };
  if (type.typeId === Type.Decimal) info.scale = type.scale ?? 0;
  if (type.typeId === Type.Time) info.timeTicksPerSecond = TICKS_PER_SECOND[type.unit ?? 0];
  return info;
}

export function describeColumns(table: Table): ColumnInfo[] {
  return table.schema.fields.map(describeField);
}

/** Reads one cell. Returns `null` for SQL NULL. */
export function cellValue(table: Table, row: number, col: number): unknown {
  const value = table.getChildAt(col)?.get(row);
  return value === undefined ? null : value;
}
