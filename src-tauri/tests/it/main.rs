//! All integration tests in one binary: each test binary links DuckDB
//! statically, so one binary keeps builds fast and `target/` small.
//!
//! Run everything: `cargo test -p dataliq --test it`
//! On-demand perf checks (need `pnpm fixtures ...`):
//!   `cargo test -p dataliq --test it perf_ -- --ignored --nocapture --test-threads=1`
//! Small benchmark suite for the CI regression guard: `node scripts/bench.mjs`

mod bench_small;
mod charts;
mod cli_run;
mod compare;
mod convert;
mod copy_sql;
mod csv_sources;
mod databases;
mod engine_query;
mod excel_sources;
mod export;
mod filters;
mod folders;
mod import_cache;
mod json_parquet_sources;
mod json_shape;
mod live_db;
mod mcp;
mod paging;
mod perf_export;
mod perf_import;
mod perf_preview;
mod perf_sort;
mod perf_sources;
mod profile;
mod quality;
mod recipes;
mod remote;
mod sample;
mod selection;
mod sort;
mod sql_results;
mod sql_tables;
mod ui_recordings;
mod view_sql;
