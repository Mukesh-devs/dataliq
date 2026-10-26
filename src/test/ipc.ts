import { tableFromArrays, tableToIPC } from "apache-arrow";

/** Arrow IPC bytes for a small table, as the backend would send them. */
export function ipcBytes(columns: Record<string, unknown[] | ArrayLike<unknown>>): ArrayBuffer {
  const table = tableFromArrays(columns as Parameters<typeof tableFromArrays>[0]);
  const bytes = tableToIPC(table, "stream");
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export const sampleInfo = {
  path: "/data/sales.csv.gz",
  fileName: "sales.csv.gz",
  sizeBytes: 5 * 1024 ** 3,
  format: "csv",
  compression: "gzip",
  sniffed: {
    delimiter: ";",
    quote: '"',
    escape: '"',
    newLine: "\\n",
    skipRows: 0,
    hasHeader: true,
    dateFormat: null,
    timestampFormat: null,
  },
  columns: [
    { name: "id", type: "BIGINT" },
    { name: "name", type: "VARCHAR" },
  ],
  readerSql: "read_csv('/data/sales.csv.gz', compression = 'gzip')",
};
