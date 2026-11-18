; DataLiq's additions to Tauri's Windows installer (bundle > windows > nsis >
; installerHooks in tauri.conf.json).
;
; Tauri's installer makes the app the default program for every file type
; in `fileAssociations` (and saves the previous default as
; "<class>_backup"). DataLiq should be the default only for its own types
; (.parquet, .duckdb, .ddb, .dataliq). For the common ones (CSV, Excel,
; JSON, SQLite) the previous default and its icon come back, and DataLiq is
; only listed under "Open with". See docs/DECISIONS.md, D79.
;
; The list below must match tauri.conf.json (scripts/installer.test.mjs
; checks it).

!macro DATALIQ_OPEN_WITH_ONLY EXT FILECLASS
  ReadRegStr $R0 SHCTX "Software\Classes\.${EXT}" "${FILECLASS}_backup"
  ; Saved by an earlier DataLiq install: the real previous default is unknown.
  ${If} $R0 == "${FILECLASS}"
    StrCpy $R0 ""
  ${EndIf}
  ${If} $R0 == ""
    ; No default of this user's own: Windows uses the system-wide one
    ; (e.g. Excel's, registered for all users), or asks.
    DeleteRegValue SHCTX "Software\Classes\.${EXT}" ""
  ${Else}
    WriteRegStr SHCTX "Software\Classes\.${EXT}" "" "$R0"
  ${EndIf}
  ; Tauri's uninstaller puts the backup back: keep it what is the default now.
  WriteRegStr SHCTX "Software\Classes\.${EXT}" "${FILECLASS}_backup" "$R0"
  ; Listed under Open with.
  WriteRegStr SHCTX "Software\Classes\.${EXT}\OpenWithProgids" "${FILECLASS}" ""
!macroend

!macro DATALIQ_FORGET_OPEN_WITH EXT FILECLASS
  DeleteRegValue SHCTX "Software\Classes\.${EXT}\OpenWithProgids" "${FILECLASS}"
  DeleteRegKey /ifempty SHCTX "Software\Classes\.${EXT}\OpenWithProgids"
  ; Tauri's uninstaller writes back an empty default when there was none:
  ; an empty value would hide the system-wide default, so remove it.
  ReadRegStr $R0 SHCTX "Software\Classes\.${EXT}" ""
  ${If} $R0 == ""
    DeleteRegValue SHCTX "Software\Classes\.${EXT}" ""
  ${EndIf}
  DeleteRegValue SHCTX "Software\Classes\.${EXT}" "${FILECLASS}_backup"
  DeleteRegKey /ifempty SHCTX "Software\Classes\.${EXT}"
!macroend

; The common types: "Open with" only. (extension, then its class: the
; association's name in tauri.conf.json)
!macro DATALIQ_COMMON_TYPES DO
  !insertmacro ${DO} "csv" "Delimited text data"
  !insertmacro ${DO} "tsv" "Delimited text data"
  !insertmacro ${DO} "tab" "Delimited text data"
  !insertmacro ${DO} "json" "JSON data"
  !insertmacro ${DO} "ndjson" "JSON data"
  !insertmacro ${DO} "jsonl" "JSON data"
  !insertmacro ${DO} "xlsx" "Excel workbook"
  !insertmacro ${DO} "xls" "Excel workbook"
  !insertmacro ${DO} "sqlite" "SQLite database"
  !insertmacro ${DO} "sqlite3" "SQLite database"
  !insertmacro ${DO} "db3" "SQLite database"
!macroend

; DataLiq's own types: it stays their default (Tauri's install does that).
!macro DATALIQ_OWN_TYPES DO
  !insertmacro ${DO} "parquet" "Parquet data"
  !insertmacro ${DO} "duckdb" "DuckDB database"
  !insertmacro ${DO} "ddb" "DuckDB database"
  !insertmacro ${DO} "dataliq" "DataLiq workspace"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  !insertmacro DATALIQ_COMMON_TYPES DATALIQ_OPEN_WITH_ONLY
  ; Explorer shows the restored icons at once.
  !insertmacro UPDATEFILEASSOC
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  !insertmacro DATALIQ_COMMON_TYPES DATALIQ_FORGET_OPEN_WITH
  ; Tauri's uninstall leaves an empty default and the backup on these.
  !insertmacro DATALIQ_OWN_TYPES DATALIQ_FORGET_OPEN_WITH
  !insertmacro UPDATEFILEASSOC
!macroend
