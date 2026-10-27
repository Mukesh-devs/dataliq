use std::path::{Path, PathBuf};
use std::sync::Arc;

use tauri::State;

use crate::chart::{ChartData, ChartSpec};
use crate::engine::{Engine, RequestKey};
use crate::error::{AppError, Result};
use crate::view::ViewSpec;

/// A chart of the view `spec` on dataset `dataset_id`. A newer request in
/// the same `group` (one per tab) cancels this one.
#[tauri::command]
pub async fn chart_data(
    engine: State<'_, Arc<Engine>>,
    dataset_id: String,
    spec: ViewSpec,
    chart: ChartSpec,
    request_id: Option<String>,
    group: Option<String>,
) -> Result<ChartData> {
    let engine = Arc::clone(&engine);
    tauri::async_runtime::spawn_blocking(move || {
        let key = RequestKey {
            id: request_id,
            group,
        };
        engine.chart_data(&dataset_id, &spec, &chart, &key)
    })
    .await
    .map_err(|e| AppError::Internal(format!("task failed: {e}")))?
}

/// The chart as standalone DuckDB SQL over `reader` (for "Copy chart SQL").
#[tauri::command]
pub fn chart_sql(
    engine: State<'_, Arc<Engine>>,
    dataset_id: String,
    spec: ViewSpec,
    chart: ChartSpec,
    reader: String,
) -> Result<String> {
    engine.chart_sql(&dataset_id, &spec, &chart, &reader)
}

/// The file contents of an exported chart: `.svg` takes an SVG document,
/// `.png` a PNG data URL (as the chart canvas gives it).
fn image_bytes(path: &Path, data: &str) -> Result<Vec<u8>> {
    use base64::Engine as _;
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase);
    match ext.as_deref() {
        Some("svg") if data.trim_start().starts_with("<svg") => Ok(data.as_bytes().to_vec()),
        Some("png") => {
            let b64 = data
                .strip_prefix("data:image/png;base64,")
                .ok_or_else(|| AppError::Query("The chart image is not a PNG.".into()))?;
            base64::engine::general_purpose::STANDARD
                .decode(b64)
                .map_err(|e| AppError::Query(format!("The chart image is damaged: {e}")))
        }
        _ => Err(AppError::Query(
            "Charts are saved as .png or .svg files.".into(),
        )),
    }
}

/// Saves an exported chart at `path` (chosen in the save dialog), written
/// whole: a temporary file next to it, then renamed.
#[tauri::command]
pub fn save_chart_image(path: PathBuf, data: String) -> Result<()> {
    let bytes = image_bytes(&path, &data)?;
    let mut partial = path.clone().into_os_string();
    partial.push(".partial");
    std::fs::write(&partial, bytes)?;
    std::fs::rename(&partial, &path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chart_images_are_png_or_svg() {
        let png = image_bytes(Path::new("/x/a.PNG"), "data:image/png;base64,iVBORw0KGgo=").unwrap();
        assert_eq!(png, b"\x89PNG\r\n\x1a\n");
        let svg = image_bytes(
            Path::new("a.svg"),
            "<svg xmlns=\"http://www.w3.org/2000/svg\"/>",
        )
        .unwrap();
        assert!(svg.starts_with(b"<svg"));
        for (path, data) in [
            ("a.png", "not a data url"),
            ("a.svg", "data:image/png;base64,AAAA"),
            ("a.exe", "<svg/>"),
            ("a.png", "data:image/png;base64,***"),
        ] {
            assert!(image_bytes(Path::new(path), data).is_err(), "{path} {data}");
        }
    }

    #[test]
    fn saving_writes_the_whole_file() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("chart.svg");
        save_chart_image(path.clone(), "<svg/>".into()).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "<svg/>");
        assert_eq!(std::fs::read_dir(tmp.path()).unwrap().count(), 1);
    }
}
