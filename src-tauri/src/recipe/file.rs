//! Recipes saved as JSON files (to apply to the same file later, or to
//! another file with the same columns) and as SQL scripts.

use std::path::Path;

use serde::{Deserialize, Serialize};

use super::RecipeStep;
use crate::error::{AppError, Result};
use crate::sources::ColumnMeta;

/// What a recipe file says it is.
pub const FORMAT: &str = "bigview-recipe";
/// The newest file version this build reads (and the one it writes).
pub const VERSION: u32 = 1;

/// A saved recipe.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecipeFile {
    pub format: String,
    pub version: u32,
    /// Name of the file it was made on (shown when loading it elsewhere).
    #[serde(default)]
    pub source: Option<String>,
    /// The columns it was made for, to tell what another file lacks.
    #[serde(default)]
    pub columns: Vec<ColumnMeta>,
    pub steps: Vec<RecipeStep>,
}

/// Writes `bytes` at `path` whole: a temporary file next to it, renamed.
fn write_whole(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut partial = path.to_path_buf().into_os_string();
    partial.push(".partial");
    std::fs::write(&partial, bytes)?;
    std::fs::rename(&partial, path)?;
    Ok(())
}

fn has_extension(path: &Path, ext: &str) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case(ext))
}

/// Saves a recipe as pretty-printed JSON (`.json` only).
pub fn save_recipe(path: &Path, recipe: &RecipeFile) -> Result<()> {
    if !has_extension(path, "json") {
        return Err(AppError::Query("Recipes are saved as .json files.".into()));
    }
    let file = RecipeFile {
        format: FORMAT.into(),
        version: VERSION,
        ..recipe.clone()
    };
    let mut json = serde_json::to_vec_pretty(&file)
        .map_err(|e| AppError::Internal(format!("could not write the recipe: {e}")))?;
    json.push(b'\n');
    write_whole(path, &json)
}

/// Reads a recipe saved by [`save_recipe`].
pub fn load_recipe(path: &Path) -> Result<RecipeFile> {
    let text = std::fs::read_to_string(path)?;
    let value: serde_json::Value = serde_json::from_str(&text)
        .map_err(|e| AppError::Query(format!("This file is not valid JSON: {e}")))?;
    if value.get("format").and_then(|f| f.as_str()) != Some(FORMAT) {
        return Err(AppError::Query("This file is not a BigView recipe.".into()));
    }
    let version = value.get("version").and_then(|v| v.as_u64()).unwrap_or(0);
    if version == 0 || version > u64::from(VERSION) {
        return Err(AppError::Query(format!(
            "This recipe was saved by a newer BigView (version {version}); update BigView to open it."
        )));
    }
    serde_json::from_value(value)
        .map_err(|e| AppError::Query(format!("This recipe is damaged: {e}")))
}

/// Saves a recipe's SQL script (`.sql` only).
pub fn save_script(path: &Path, script: &str) -> Result<()> {
    if !has_extension(path, "sql") {
        return Err(AppError::Query(
            "Recipe scripts are saved as .sql files.".into(),
        ));
    }
    let mut text = script.to_string();
    if !text.ends_with('\n') {
        text.push('\n');
    }
    write_whole(path, text.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::recipe::{Case, Step};

    fn recipe() -> RecipeFile {
        RecipeFile {
            format: String::new(),
            version: 0,
            source: Some("people.csv".into()),
            columns: vec![ColumnMeta {
                name: "name".into(),
                r#type: "VARCHAR".into(),
            }],
            steps: vec![
                RecipeStep {
                    step: Step::ChangeCase {
                        column: "name".into(),
                        case: Case::Title,
                    },
                    enabled: true,
                },
                RecipeStep {
                    step: Step::Trim {
                        column: "name".into(),
                    },
                    enabled: false,
                },
            ],
        }
    }

    #[test]
    fn saved_recipes_load_back() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("clean.json");
        save_recipe(&path, &recipe()).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains(r#""format": "bigview-recipe""#), "{text}");
        assert!(text.contains(r#""op": "changeCase""#), "{text}");
        let back = load_recipe(&path).unwrap();
        assert_eq!(back.version, VERSION);
        assert_eq!(back.steps, recipe().steps);
        assert_eq!(back.source.as_deref(), Some("people.csv"));
        // Nothing left over from writing it whole.
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[test]
    fn other_files_are_refused_in_words() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("x.json");
        let msg = |text: &str| {
            std::fs::write(&p, text).unwrap();
            load_recipe(&p).unwrap_err().to_string()
        };
        assert!(msg("not json").contains("not valid JSON"));
        assert!(msg(r#"{"a": 1}"#).contains("not a BigView recipe"));
        assert!(
            msg(r#"{"format": "bigview-recipe", "version": 9, "steps": []}"#)
                .contains("newer BigView")
        );
        assert!(
            msg(r#"{"format": "bigview-recipe", "version": 1, "steps": [{"op": "nope"}]}"#)
                .contains("damaged")
        );
        assert!(save_recipe(&dir.path().join("x.txt"), &recipe()).is_err());
        assert!(save_script(&dir.path().join("x.json"), "SELECT 1;").is_err());
        save_script(&dir.path().join("x.SQL"), "SELECT 1;").unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.path().join("x.SQL")).unwrap(),
            "SELECT 1;\n"
        );
    }
}
