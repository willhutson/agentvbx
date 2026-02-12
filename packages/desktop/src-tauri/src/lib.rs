// AGENTVBX Desktop — Tauri application shell
//
// This is the Rust backend for the Tauri desktop app.
// It provides native capabilities:
// - Filesystem access for Obsidian vaults and local files
// - Process management (launching/monitoring agent workers)
// - System tray and notifications
// - IPC bridge to the frontend WebView

use tauri::Manager;

#[tauri::command]
fn get_health() -> serde_json::Value {
    serde_json::json!({
        "status": "healthy",
        "version": env!("CARGO_PKG_VERSION"),
        "platform": std::env::consts::OS,
    })
}

#[tauri::command]
fn get_tenant_path(tenant_id: String) -> String {
    let home = dirs_fallback();
    format!("{}/agentvbx/tenants/{}", home, tenant_id)
}

fn dirs_fallback() -> String {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_else(|_| String::from("."))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![get_health, get_tenant_path])
        .setup(|app| {
            #[cfg(debug_assertions)]
            {
                let window = app.get_webview_window("main").unwrap();
                window.open_devtools();
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
