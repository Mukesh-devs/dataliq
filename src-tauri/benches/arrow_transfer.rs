//! Arrow transfer of 1,000 rows: query DuckDB + encode as IPC bytes, which is
//! what one grid page costs on the Rust side. Run with `cargo bench`.

use std::hint::black_box;

use bigview_lib::engine::{Engine, EngineConfig, RequestKey};
use criterion::{Criterion, criterion_group, criterion_main};

const PAGE_SQL: &str = "SELECT i AS id, 'name_' || i AS name, i * 1.5 AS amount, \
     i % 2 = 0 AS flag, DATE '2024-01-01' + (i % 365)::INTEGER AS day, \
     TIMESTAMP '2024-01-01' + to_seconds(i) AS ts \
     FROM range(1000) t(i)";

fn bench(c: &mut Criterion) {
    let tmp = tempfile::tempdir().unwrap();
    let engine = Engine::open_in_memory(&EngineConfig {
        memory_limit_bytes: 1 << 30,
        temp_dir: tmp.path().to_path_buf(),
        threads: None,
    })
    .unwrap();
    engine
        .execute_batch(&format!("CREATE TABLE page AS {PAGE_SQL}"))
        .unwrap();
    let key = RequestKey::default();

    c.bench_function("arrow_ipc_1000_rows_table", |b| {
        b.iter(|| {
            let bytes = engine
                .query_ipc("SELECT * FROM page", &[], 1000, &key)
                .unwrap();
            black_box(bytes.len())
        })
    });
    c.bench_function("arrow_ipc_1000_rows_generated", |b| {
        b.iter(|| black_box(engine.query_ipc(PAGE_SQL, &[], 1000, &key).unwrap().len()))
    });
}

criterion_group!(benches, bench);
criterion_main!(benches);
