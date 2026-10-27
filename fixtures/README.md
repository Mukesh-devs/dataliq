# Test fixtures

Small fixtures (each < 1 MB) are committed here. They are written by
`pnpm fixtures committed` (`scripts/gen_fixtures/src/committed.rs`), and the
output is reproducible byte-for-byte, so edit the generator rather than the files.

| File | What it covers |
| --- | --- |
| `csv/comma.csv`, `semicolon.csv`, `tab.tsv`, `pipe.csv` | delimiters (semicolon file uses decimal commas and umlauts) |
| `csv/quoted.csv` | quoted fields with commas, doubled quotes and embedded newlines |
| `csv/utf8_bom.csv` | UTF-8 with a byte-order mark, non-Latin text |
| `csv/latin1.csv` | ISO-8859-1 encoded text |
| `csv/nulls.csv` | empty field vs `NULL` vs `""` |
| `csv/mixed_types.csv` | a column mixing numbers and text, boolean spellings |
| `csv/dates.csv` | ISO, US, EU dates; timestamps with and without offsets |
| `csv/header_only.csv`, `csv/empty.csv` | header without rows; zero-byte file |
| `csv/bad_rows.csv` | a row with too many columns |
| `csv/wide_500.csv` | 500 columns |
| `csv/people.csv` | 1,000 seeded rows for filter tests: text with case and unicode variants, numbers, dates, booleans, NULLs and `""` empty strings |
| `csv/corrupted.csv.gz` | truncated gzip stream |
| `*.gz` twins | gzip versions of comma, tab, quoted, JSON array and NDJSON |
| `json/array.json`, `json/records.ndjson`, `json/nested.json` | JSON array, newline-delimited JSON, nested objects and arrays |
| `parquet/types.parquet` | many DuckDB types (ints, floats, decimal, text, date, timestamp, time, blob, list, struct, map, uuid) with nulls |
| `excel/multi_sheet.xlsx` | two sheets, dates, formulas with cached values, an empty row, a title row above the header |
| `excel/legacy.xls` | Excel 97-2003 (BIFF8): numbers, text with umlauts, dates, booleans, an empty sheet — written by `scripts/make_xls.py` |
| `ipc/known_query.arrows` | Arrow IPC bytes written by the Rust engine tests and decoded by the frontend tests |

## Large generated fixtures

Large files are generated into the git-ignored `fixtures/generated/` folder:

```sh
pnpm fixtures list      # show all targets and sizes
pnpm fixtures small     # 100 MB set used by the benchmark regression job
pnpm fixtures large     # 1 GB / 5 GB CSV, 5 GB .csv.gz and .ndjson.gz, 50M-row Parquet, 1M-row .xlsx
pnpm fixtures verify    # re-check checksums against manifest.json
```

Data is seeded and deterministic. `fixtures/generated/manifest.json` records
each file's row count, byte size, SHA-256 and the sum of its id column so
tests can check that a reader saw every row.
