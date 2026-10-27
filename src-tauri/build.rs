fn main() {
    // Listing the app's commands makes Tauri generate one permission per command
    // (`allow-<command>`), so capabilities/default.json can grant only what the UI needs.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "run_query",
            "cancel_query",
            "fetch_rows",
            "open_file",
            "preview_file",
            "import_file",
            "cancel_import",
            "open_direct",
            "close_dataset",
            "cache_info",
            "clear_cache",
            "get_settings",
            "take_startup_files",
            "open_view",
            "column_values",
            "column_profile",
            "column_histograms",
        ]),
    ))
    .expect("failed to run tauri-build");
}
