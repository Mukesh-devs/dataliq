
### Step 2 — Open files from a URL (HTTP(S) and S3) ✅

- "Open URL…" in the palette (or `bigview <url>`) opens `https://`, `http://` and `s3://`
  CSV, TSV, JSON and Parquet files, gzipped or not, named after the file in the URL (no query)
  with "remote" in the header. Parquet is queried in place in byte ranges; CSV and JSON
  import into the session and are never cached (D44).
- DuckDB's httpfs extension is installed once into the app's cache folder and loaded only when
  the first URL opens; extensions still never autoload. HTTP errors are said in words (404,
  401/403 with a pointer to the S3 settings).
- "S3 settings…" (also in the Open URL box): key ID, secret, region, endpoint, URL style, HTTPS,
  kept as one OS keychain entry (`keyring`) and applied as a temporary DuckDB secret. The UI
  never receives the secret; saving with it empty keeps the stored one. With no keychain
  service the box says so in words.
- Tested: unit tests for URL names, the secret SQL and a keychain round trip (mock), CLI URLs;
  integration tests against a local HTTP server with HEAD and ranges (CSV preview and import
  with nothing cached, gzip, Parquet in place with a page from the middle, 404, a URL without
  an extension, Excel); Vitest for URL names; Playwright for Open URL (validation, tab title,
  header) and saving, reloading, keeping and removing S3 settings.
- Smoke (real app, `python -m http.server`): `bigview http://127.0.0.1:8765/people.csv.gz` →
  httpfs installed into `~/.cache/app.bigview.desktop/duckdb-extensions`, "CSV · GZIP · REMOTE",
  1,000 rows imported in 172 ms; `types.parquet` from the Open URL box → 3 rows queried in
  place, all 18 types; `missing.csv` → "The server has no file at this address (HTTP 404)."
- Left over: the container has no Secret Service, so storing S3 settings in a real keychain was
  checked only with the keyring mock and in Playwright; S3 itself was not tested against a live
  bucket.

### Step 3 — SQLite and DuckDB files ✅

- SQLite (`.sqlite`, `.sqlite3`, `.db`, `.db3`) and DuckDB (`.duckdb`, `.ddb`) files open like
  any file (dialog, drop, `bigview shop.duckdb`), told apart by their header bytes, attached
  read-only once per session under a name from the file (`Shop Data.duckdb` → `shop_data`),
  so the SQL panel can join their tables with anything else.
- A "Table" picker in the header lists tables (DuckDB with row counts), views, and other
  schemas as `schema.table`; the first table opens. DuckDB tables are queried in place;
  SQLite tables are imported and cached per table. The sqlite extension installs on first use,
  as httpfs does (D44); a changed file is attached afresh; a file locked for writing, another
  DuckDB version, no tables, a database URL or folder are said in words (D45).
- Buttons no longer shrink or wrap in a crowded header; the file name truncates instead.
- Tested: unit tests for detection by header (`.db` either way, no extension), attached names,
  attach error wording; integration tests for a DuckDB file (tables, views, other schema, row
  counts, in place with a deep page, the SQL name, read-only, a missing table), a SQLite file
  (types, preview, import, cache per table, `sqlite_scan` Copy-as-SQL in plain DuckDB), a
  changed SQLite file read again, an empty database and a database URL; Playwright for the
  picker (labels, SQL name, picking a table in another schema). UI recordings gained
  `database`.
- Smoke (real app): `bigview "Shop Data.duckdb" chinook.sqlite` → "DUCKDB · 9.8 MB",
  customers (97 rows) queried in place; picking orders (2,000,000 rows) → in place, the last
  page at once; chinook → sqlite extension installed, artists imported in 12 ms; in the SQL
  panel `chinook.tracks JOIN chinook.artists` with `shop_data.orders` → 4 rows in 25 ms.
- Left over: none.
