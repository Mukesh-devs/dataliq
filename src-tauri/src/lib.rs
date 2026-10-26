//! BigView desktop app: Tauri entry point.

/// Builds and runs the Tauri application.
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running BigView");
}
