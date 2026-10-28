//! All integration tests in one binary: each test binary links DuckDB
//! statically, so one binary keeps builds fast and `target/` small.
//!
//! Run everything: `cargo test -p bigview --test it`
//! On-demand perf checks (need `pnpm fixtures ...`):
//!   `cargo test -p bigview --test it perf_ -- --ignored --nocapture --test-threads=1`
//! Small benchmark suite for the CI regression guard: `node scripts/bench.mjs`

mod bench_small;
mod charts;
mod compare;
mod copy_sql;
mod csv_sources;
mod engine_query;
mod excel_sources;
mod export;
mod filters;
mod folders;
mod import_cache;
mod json_parquet_sources;
mod paging;
mod perf_export;
mod perf_import;
mod perf_preview;
mod perf_sort;
mod profile;
mod quality;
mod recipes;
mod remote;
mod sort;
mod sql_results;
mod sql_tables;
mod ui_recordings;
mod view_sql;
