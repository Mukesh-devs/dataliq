//! Arrow IPC encoding of query results (sent raw to the UI, no JSON).

use arrow::datatypes::Schema;
use arrow::ipc::writer::StreamWriter;
use arrow::record_batch::RecordBatch;

use crate::error::Result;

/// Encodes batches in the Arrow IPC *stream* format, which `apache-arrow`'s
/// `tableFromIPC` reads directly. An empty result still carries the schema.
pub fn batches_to_ipc(schema: &Schema, batches: &[RecordBatch]) -> Result<Vec<u8>> {
    let size: usize = batches.iter().map(|b| b.get_array_memory_size()).sum();
    let mut writer = StreamWriter::try_new(Vec::with_capacity(size + 1024), schema)?;
    for batch in batches {
        writer.write(batch)?;
    }
    writer.finish()?;
    Ok(writer.into_inner()?)
}
