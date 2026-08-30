mod api;
mod error;
mod game;
mod launcher;
mod storage;

use launcher::{commands, state::AppState};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder, webview::PageLoadEvent};

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .on_page_load(|webview, payload| {
            if payload.event() == PageLoadEvent::Finished {
                let _ = webview.window().show();
            }
        })
        .setup(|app| {
            let local_root = dirs::data_local_dir()
                .ok_or_else(|| std::io::Error::other("The local app data path is unavailable."))?
                .join("Undaunted Launcher");
            let state = AppState::new(app.handle())
                .map_err(|error| std::io::Error::other(error.message))?;
            state
                .import_legacy_once()
                .map_err(|error| std::io::Error::other(error.message))?;
            app.manage(state);
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Undaunted Launcher")
                .inner_size(1080.0, 608.0)
                .resizable(false)
                .decorations(false)
                .visible(false)
                .center()
                .data_directory(local_root.join("WebView"))
                .build()
                .map_err(|error| std::io::Error::other(error.to_string()))?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_launcher_state,
            commands::get_credential_bootstrap,
            commands::get_credential_profile_key,
            commands::delete_credential_profile,
            commands::copy_user_api_key,
            commands::get_background,
            commands::set_background,
            commands::clear_background,
            commands::get_registration_mode,
            commands::login,
            commands::logout,
            commands::register_account,
            commands::migrate_legacy_install,
            commands::use_existing_install,
            commands::get_dashboard,
            commands::get_admin_state,
            commands::set_registration_mode,
            commands::create_invite_code,
            commands::delete_invite_code,
            commands::launch_game,
            commands::stop_game,
            commands::is_game_running,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Undaunted Launcher");
}
