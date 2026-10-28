//! The native menu bar on macOS (D47). The frontend owns the menus: it sends
//! them (built from its commands, with what's enabled and the recent files)
//! whenever they change, and a click sends the item's command id back as a
//! `menu` event. macOS's own items are added here: the app menu (About,
//! Settings…, Hide, Quit), text editing in Edit, and the Window menu.
//!
//! Windows and Linux show the same menus inside the window instead, so the
//! app's keyboard shortcuts stay with the web view.

use serde::Deserialize;
use tauri::menu::{IsMenuItem, Menu, MenuItemBuilder, PredefinedMenuItem, Submenu, SubmenuBuilder};
use tauri::{App, AppHandle, Emitter, Runtime};

/// One entry of a menu as the frontend describes it.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum NativeItem {
    #[serde(rename_all = "camelCase")]
    Item {
        id: String,
        label: String,
        /// e.g. `CmdOrCtrl+S`; only for shortcuts the app handles anywhere.
        accelerator: Option<String>,
        enabled: bool,
    },
    Separator,
    Submenu {
        label: String,
        items: Vec<NativeItem>,
    },
}

#[derive(Debug, Clone, Deserialize)]
pub struct NativeMenu {
    pub label: String,
    pub items: Vec<NativeItem>,
}

/// The standard menu until the frontend sends its own, and the click handler.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn install(app: &App) -> tauri::Result<()> {
    let handle = app.handle();
    app.set_menu(Menu::default(handle)?)?;
    app.on_menu_event(|app, event| {
        let _ = app.emit("menu", event.id().as_ref().to_string());
    });
    Ok(())
}

fn submenu<R: Runtime>(
    app: &AppHandle<R>,
    label: &str,
    items: &[NativeItem],
) -> tauri::Result<Submenu<R>> {
    let mut built: Vec<Box<dyn IsMenuItem<R>>> = Vec::new();
    for item in items {
        match item {
            NativeItem::Item {
                id,
                label,
                accelerator,
                enabled,
            } => {
                let mut b = MenuItemBuilder::with_id(id.as_str(), label).enabled(*enabled);
                if let Some(acc) = accelerator {
                    b = b.accelerator(acc);
                }
                built.push(Box::new(b.build(app)?));
            }
            NativeItem::Separator => built.push(Box::new(PredefinedMenuItem::separator(app)?)),
            NativeItem::Submenu { label, items } => {
                built.push(Box::new(submenu(app, label, items)?));
            }
        }
    }
    let refs: Vec<&dyn IsMenuItem<R>> = built.iter().map(|b| b.as_ref()).collect();
    SubmenuBuilder::new(app, label).items(&refs).build()
}

/// The whole menu bar: macOS's app menu, then the frontend's menus (Edit
/// gets text editing first), then Window.
pub fn build<R: Runtime>(app: &AppHandle<R>, menus: &[NativeMenu]) -> tauri::Result<Menu<R>> {
    let name = app.package_info().name.clone();
    let settings = MenuItemBuilder::with_id("settings", "Settings…")
        .accelerator("CmdOrCtrl+,")
        .build(app)?;
    let app_menu = SubmenuBuilder::new(app, &name)
        .item(&PredefinedMenuItem::about(app, None, None)?)
        .separator()
        .item(&settings)
        .separator()
        .item(&PredefinedMenuItem::services(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::hide(app, None)?)
        .item(&PredefinedMenuItem::hide_others(app, None)?)
        .item(&PredefinedMenuItem::show_all(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::quit(app, None)?)
        .build()?;
    let menu = Menu::with_items(app, &[&app_menu])?;
    for m in menus {
        if m.label == "Edit" {
            let text = SubmenuBuilder::new(app, "Edit")
                .item(&PredefinedMenuItem::undo(app, None)?)
                .item(&PredefinedMenuItem::redo(app, None)?)
                .separator()
                .item(&PredefinedMenuItem::cut(app, None)?)
                .item(&PredefinedMenuItem::copy(app, None)?)
                .item(&PredefinedMenuItem::paste(app, None)?)
                .item(&PredefinedMenuItem::select_all(app, None)?)
                .separator()
                .build()?;
            let ours = submenu(app, "Edit", &m.items)?;
            for item in ours.items()? {
                text.append(&item)?;
            }
            menu.append(&text)?;
        } else {
            menu.append(&submenu(app, &m.label, &m.items)?)?;
        }
    }
    let window = SubmenuBuilder::new(app, "Window")
        .item(&PredefinedMenuItem::minimize(app, None)?)
        .item(&PredefinedMenuItem::maximize(app, None)?)
        .item(&PredefinedMenuItem::fullscreen(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::close_window(app, None)?)
        .build()?;
    menu.append(&window)?;
    Ok(menu)
}
