
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
