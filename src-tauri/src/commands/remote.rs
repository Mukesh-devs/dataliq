use std::sync::Arc;

use tauri::State;

use crate::engine::Engine;
use crate::error::Result;
use crate::remote::{self, S3Settings, S3Summary};

/// The S3 settings stored in the keychain, without the secret key.
#[tauri::command]
pub fn get_s3_settings() -> Result<Option<S3Summary>> {
    Ok(remote::load_s3()?.as_ref().map(S3Summary::from))
}

/// Stores the S3 settings in the keychain and uses them from now on. An
/// empty secret keeps the stored one (the UI never gets it back).
#[tauri::command]
pub fn save_s3_settings(engine: State<'_, Arc<Engine>>, mut settings: S3Settings) -> Result<()> {
    if settings.secret.is_empty() {
        if let Some(old) = remote::load_s3()? {
            settings.secret = old.secret;
        }
    }
    remote::save_s3(&settings)?;
    engine.use_s3(Some(&settings))
}

/// Removes the S3 settings from the keychain and this session.
#[tauri::command]
pub fn clear_s3_settings(engine: State<'_, Arc<Engine>>) -> Result<()> {
    remote::clear_s3()?;
    engine.use_s3(None)
}
