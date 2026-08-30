#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Older builds placed the game's DXGI proxy beside the launcher executable.
    // WebView2 then side-loaded it for video rendering, and the proxy injected
    // UndauntedInternalServer.dll into this process. Remove those legacy payloads
    // before WebView2 is initialized; current resources live under game-patch/.
    if let Ok(executable) = std::env::current_exe()
        && let Some(directory) = executable.parent()
    {
        let _ = std::fs::remove_file(directory.join("dxgi.dll"));
        let _ = std::fs::remove_file(directory.join("UndauntedInternalServer.dll"));
    }
    undaunted_launcher_lib::run();
}
