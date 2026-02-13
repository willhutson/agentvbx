// AGENTVBX Desktop — Tauri application shell
//
// The desktop app is the zero-infrastructure hub for AGENTVBX:
// 1. Provider login — embedded webview for ChatGPT/Claude/Gemini login,
//    captures session cookies for the session adapter layer
// 2. File access — local filesystem, Obsidian vault discovery, cloud storage
// 3. WhatsApp bridge — QR code scan to link WhatsApp account
// 4. Orchestrator bridge — connects to local or remote API server
//
// The Rust backend provides native capabilities that the webview can't:
// - Filesystem scanning and file reading
// - Obsidian vault discovery (scan for .obsidian directories)
// - Session data directory management
// - Content hashing for artifact versioning

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::Manager;

// ─── Types ──────────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone)]
struct HealthInfo {
    status: String,
    version: String,
    platform: String,
}

#[derive(Serialize, Deserialize, Clone)]
struct FileEntry {
    path: String,
    name: String,
    is_directory: bool,
    size_bytes: u64,
    modified_at: String,
    mime_type: String,
}

#[derive(Serialize, Deserialize, Clone)]
struct ObsidianVault {
    name: String,
    path: String,
    note_count: usize,
}

#[derive(Serialize, Deserialize, Clone)]
struct ProviderLoginConfig {
    provider_id: String,
    login_url: String,
    success_indicators: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone)]
struct ConnectedStore {
    id: String,
    name: String,
    store_type: String,
    path: String,
    file_count: usize,
}

// ─── Core Commands ──────────────────────────────────────────────────────────

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
    let home = agentvbx_home();
    format!("{}/tenants/{}", home, tenant_id)
}

#[tauri::command]
fn get_sessions_path() -> String {
    let home = agentvbx_home();
    format!("{}/sessions", home)
}

// ─── File Store Commands ────────────────────────────────────────────────────

/// List files in a directory (for the file store connection flow).
#[tauri::command]
fn list_directory(path: String) -> Result<Vec<FileEntry>, String> {
    let dir = Path::new(&path);
    if !dir.exists() {
        return Err(format!("Directory not found: {}", path));
    }
    if !dir.is_dir() {
        return Err(format!("Not a directory: {}", path));
    }

    let mut entries = Vec::new();
    let read_dir = fs::read_dir(dir).map_err(|e| e.to_string())?;

    for entry in read_dir.flatten() {
        let file_name = entry.file_name().to_string_lossy().to_string();

        // Skip hidden files
        if file_name.starts_with('.') {
            continue;
        }

        let metadata = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };

        let modified = metadata
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| {
                chrono::DateTime::from_timestamp(d.as_secs() as i64, 0)
                    .map(|dt| dt.to_rfc3339())
                    .unwrap_or_default()
            })
            .unwrap_or_default();

        entries.push(FileEntry {
            path: entry.path().to_string_lossy().to_string(),
            name: file_name.clone(),
            is_directory: metadata.is_dir(),
            size_bytes: metadata.len(),
            modified_at: modified,
            mime_type: guess_mime(&file_name),
        });
    }

    // Directories first, then sort by name
    entries.sort_by(|a, b| {
        b.is_directory
            .cmp(&a.is_directory)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(entries)
}

/// Read a text file's content (for preview in the app).
#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    let file_path = Path::new(&path);
    if !file_path.exists() {
        return Err(format!("File not found: {}", path));
    }

    // Safety: limit to 10MB
    let metadata = fs::metadata(&path).map_err(|e| e.to_string())?;
    if metadata.len() > 10 * 1024 * 1024 {
        return Err("File too large (>10MB)".to_string());
    }

    fs::read_to_string(&path).map_err(|e| e.to_string())
}

/// Compute SHA-256 hash of file content (for artifact versioning).
#[tauri::command]
fn hash_file(path: String) -> Result<String, String> {
    use sha2::{Digest, Sha256};

    let content = fs::read(&path).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    hasher.update(&content);
    let result = hasher.finalize();
    Ok(hex::encode(result))
}

/// Get common user directories (Desktop, Documents, Downloads).
#[tauri::command]
fn get_user_directories() -> serde_json::Value {
    let home = home_dir();

    serde_json::json!({
        "home": home,
        "desktop": format!("{}/Desktop", home),
        "documents": format!("{}/Documents", home),
        "downloads": format!("{}/Downloads", home),
    })
}

// ─── Obsidian Vault Discovery ───────────────────────────────────────────────

/// Scan common locations for Obsidian vaults.
/// Looks for directories containing a .obsidian subfolder.
#[tauri::command]
fn discover_obsidian_vaults() -> Vec<ObsidianVault> {
    let home = home_dir();
    let search_roots = vec![
        format!("{}/Documents", home),
        format!("{}/Desktop", home),
        format!("{}/Obsidian", home),
        home.clone(),
    ];

    let mut vaults = Vec::new();

    for root in search_roots {
        let root_path = Path::new(&root);
        if !root_path.exists() {
            continue;
        }

        // Use walkdir with max_depth to avoid deep traversals
        if let Ok(walker) = walkdir_scan(&root, 4) {
            for vault_path in walker {
                let vault_name = vault_path
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string();

                let note_count = count_markdown_files(&vault_path);

                vaults.push(ObsidianVault {
                    name: vault_name,
                    path: vault_path.to_string_lossy().to_string(),
                    note_count,
                });
            }
        }
    }

    // Deduplicate by path
    vaults.sort_by(|a, b| a.path.cmp(&b.path));
    vaults.dedup_by(|a, b| a.path == b.path);

    vaults
}

/// Scan a directory for Obsidian vaults (directories with .obsidian subdir).
fn walkdir_scan(root: &str, max_depth: usize) -> Result<Vec<PathBuf>, String> {
    let mut vaults = Vec::new();
    let root_path = Path::new(root);

    if !root_path.exists() {
        return Ok(vaults);
    }

    // Simple recursive scan with depth limit
    scan_for_obsidian(root_path, 0, max_depth, &mut vaults);
    Ok(vaults)
}

fn scan_for_obsidian(dir: &Path, depth: usize, max_depth: usize, vaults: &mut Vec<PathBuf>) {
    if depth > max_depth {
        return;
    }

    // Check if this directory is an Obsidian vault
    let obsidian_dir = dir.join(".obsidian");
    if obsidian_dir.exists() && obsidian_dir.is_dir() {
        vaults.push(dir.to_path_buf());
        return; // Don't scan inside vaults for nested vaults
    }

    // Skip common non-vault directories
    if let Some(name) = dir.file_name().and_then(|n| n.to_str()) {
        if name.starts_with('.')
            || name == "node_modules"
            || name == "Library"
            || name == ".Trash"
            || name == "dist"
            || name == "target"
        {
            return;
        }
    }

    // Recurse into subdirectories
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                scan_for_obsidian(&entry.path(), depth + 1, max_depth, vaults);
            }
        }
    }
}

fn count_markdown_files(vault_path: &Path) -> usize {
    let mut count = 0;
    if let Ok(entries) = fs::read_dir(vault_path) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() {
                if let Some(ext) = path.extension() {
                    if ext == "md" {
                        count += 1;
                    }
                }
            } else if path.is_dir() {
                // Skip .obsidian and .trash
                if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                    if !name.starts_with('.') {
                        count += count_markdown_files(&path);
                    }
                }
            }
        }
    }
    count
}

// ─── Provider Login Support ─────────────────────────────────────────────────

/// Get the login config for a provider (URL and success indicators).
#[tauri::command]
fn get_provider_login_config(provider_id: String) -> Result<ProviderLoginConfig, String> {
    match provider_id.as_str() {
        "chatgpt" => Ok(ProviderLoginConfig {
            provider_id: "chatgpt".into(),
            login_url: "https://chatgpt.com/auth/login".into(),
            success_indicators: vec![
                "chatgpt.com".into(),
                "chat.openai.com".into(),
            ],
        }),
        "claude" => Ok(ProviderLoginConfig {
            provider_id: "claude".into(),
            login_url: "https://claude.ai/login".into(),
            success_indicators: vec![
                "claude.ai/new".into(),
                "claude.ai/chat".into(),
            ],
        }),
        "gemini" => Ok(ProviderLoginConfig {
            provider_id: "gemini".into(),
            login_url: "https://accounts.google.com".into(),
            success_indicators: vec![
                "gemini.google.com".into(),
            ],
        }),
        "perplexity" => Ok(ProviderLoginConfig {
            provider_id: "perplexity".into(),
            login_url: "https://www.perplexity.ai/signin".into(),
            success_indicators: vec![
                "perplexity.ai".into(),
            ],
        }),
        _ => Err(format!("Unknown provider: {}", provider_id)),
    }
}

/// Ensure the session storage directory exists and return its path.
#[tauri::command]
fn ensure_session_dir(provider_id: String, tenant_id: String) -> Result<String, String> {
    let home = agentvbx_home();
    let session_dir = format!("{}/sessions/{}_{}", home, tenant_id, provider_id);
    fs::create_dir_all(&session_dir).map_err(|e| e.to_string())?;
    Ok(session_dir)
}

// ─── Helpers ────────────────────────────────────────────────────────────────

fn home_dir() -> String {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_else(|_| String::from("."))
}

fn agentvbx_home() -> String {
    let home = home_dir();
    let agentvbx_dir = format!("{}/.agentvbx", home);
    // Ensure base directory exists
    let _ = fs::create_dir_all(&agentvbx_dir);
    agentvbx_dir
}

fn guess_mime(filename: &str) -> String {
    let ext = filename
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_lowercase();

    match ext.as_str() {
        "md" => "text/markdown",
        "txt" => "text/plain",
        "json" => "application/json",
        "yaml" | "yml" => "text/yaml",
        "csv" => "text/csv",
        "pdf" => "application/pdf",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "mp4" => "video/mp4",
        "mp3" => "audio/mpeg",
        "doc" | "docx" => "application/msword",
        "xls" | "xlsx" => "application/vnd.ms-excel",
        "pptx" => "application/vnd.ms-powerpoint",
        "html" => "text/html",
        "js" => "text/javascript",
        "ts" => "text/typescript",
        "py" => "text/x-python",
        "rs" => "text/x-rust",
        "go" => "text/x-go",
        _ => "application/octet-stream",
    }
    .to_string()
}

// ─── App Entry ──────────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            // Core
            get_health,
            get_tenant_path,
            get_sessions_path,
            // File stores
            list_directory,
            read_text_file,
            hash_file,
            get_user_directories,
            // Obsidian
            discover_obsidian_vaults,
            // Provider login
            get_provider_login_config,
            ensure_session_dir,
        ])
        .setup(|app| {
            // Ensure AGENTVBX data directory exists
            let _ = agentvbx_home();

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
