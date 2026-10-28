//! macOS menu bar: the standard menus plus File > Open / Open Folder / Close Tab. On
//! Windows and Linux the app has no menu bar (see docs/DECISIONS.md, D22);
//! the same actions are in the UI and on the keyboard.

use tauri::menu::{Menu, MenuItemBuilder, SubmenuBuilder};
use tauri::{App, Emitter};

pub fn install(app: &App) -> tauri::Result<()> {
    let handle = app.handle();
    let menu = Menu::default(handle)?;
    let open = MenuItemBuilder::with_id("open-file", "Open…")
        .accelerator("CmdOrCtrl+O")
        .build(handle)?;
    let folder = MenuItemBuilder::with_id("open-folder", "Open Folder…")
        .accelerator("CmdOrCtrl+Shift+O")
        .build(handle)?;
    let close = MenuItemBuilder::with_id("close-tab", "Close Tab")
        .accelerator("CmdOrCtrl+W")
        .build(handle)?;
    let file = SubmenuBuilder::new(handle, "File")
        .item(&open)
        .item(&folder)
        .item(&close)
        .build()?;
    // After the app menu, before Edit.
    menu.insert(&file, 1)?;
    app.set_menu(menu)?;
    app.on_menu_event(|app, event| {
        let id = event.id().as_ref();
        if ["open-file", "open-folder", "close-tab"].contains(&id) {
            let _ = app.emit("menu", id.to_string());
        }
    });
    Ok(())
}
