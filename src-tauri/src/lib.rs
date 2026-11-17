use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, RunEvent, WindowEvent, Wry};
use tauri_plugin_dialog::DialogExt;

#[cfg(windows)]
mod cable;
#[cfg(windows)]
mod winaudio;

struct TrayItems {
    toggle: MenuItem<Wry>,
    monitor: CheckMenuItem<Wry>,
}

#[derive(Default)]
struct AppState {
    /// Windows default mic to put back when VoxShift stops overriding it.
    restore_mic: Mutex<Option<String>>,
    tray: Mutex<Option<TrayItems>>,
    close_to_tray: AtomicBool,
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

fn restore_default_mic(app: &AppHandle) {
    let state = app.state::<AppState>();
    let id = state.restore_mic.lock().unwrap().take();
    #[cfg(windows)]
    if let Some(id) = id {
        let _ = winaudio::set_default_capture(&id);
    }
    #[cfg(not(windows))]
    let _ = id;
}

// ---------------- commands ----------------

/// Downloads and installs the VB-Audio Virtual Cable driver (asks Windows for admin rights).
#[cfg(windows)]
#[tauri::command]
async fn install_virtual_cable(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || cable::install(&app))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(windows)]
#[tauri::command]
fn list_mics() -> Result<Vec<winaudio::CaptureDevice>, String> {
    winaudio::list_capture().map_err(|e| e.to_string())
}

/// Makes `cable_id` the Windows default microphone. Returns the device it replaced.
#[cfg(windows)]
#[tauri::command]
fn system_mic_enable(state: tauri::State<AppState>, cable_id: String) -> Result<Option<String>, String> {
    let current = winaudio::default_capture_id().map_err(|e| e.to_string())?;
    let mut restore = state.restore_mic.lock().unwrap();
    if current != cable_id && restore.is_none() {
        *restore = Some(current);
    }
    winaudio::set_default_capture(&cable_id).map_err(|e| e.to_string())?;
    Ok(restore.clone())
}

/// Puts the original default microphone back. `fallback` is used after a crash, when only the UI remembers it.
#[cfg(windows)]
#[tauri::command]
fn system_mic_disable(state: tauri::State<AppState>, fallback: Option<String>) -> Result<(), String> {
    let id = state.restore_mic.lock().unwrap().take().or(fallback);
    if let Some(id) = id {
        winaudio::set_default_capture(&id).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn set_tray_state(state: tauri::State<AppState>, app: AppHandle, live: bool, monitor: bool, voice: String) {
    if let Some(items) = state.tray.lock().unwrap().as_ref() {
        let _ = items.toggle.set_text(if live { "Turn voice off" } else { "Turn voice on" });
        let _ = items.monitor.set_checked(monitor);
    }
    if let Some(tray) = app.tray_by_id("main") {
        let tip = format!("VoxShift — {voice} ({})", if live { "live" } else { "off" });
        let _ = tray.set_tooltip(Some(tip));
    }
}

#[tauri::command]
fn set_close_to_tray(state: tauri::State<AppState>, enabled: bool) {
    state.close_to_tray.store(enabled, Ordering::Relaxed);
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

#[tauri::command]
async fn save_recording(app: AppHandle, request: tauri::ipc::Request<'_>) -> Result<Option<String>, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected raw audio bytes".into());
    };
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let picked = app
        .dialog()
        .file()
        .set_title("Save recording")
        .add_filter("WebM audio", &["webm"])
        .set_file_name(format!("voxshift-{secs}.webm"))
        .blocking_save_file();
    let Some(picked) = picked else { return Ok(None) };
    let path = picked.into_path().map_err(|e| e.to_string())?;
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(Some(path.display().to_string()))
}

// ---------------- updates ----------------

/// Only installers attached to this project's GitHub releases may be downloaded.
const RELEASE_PREFIX: &str = "https://github.com/raymanitis/Voice-Changer/releases/download/";

#[derive(Clone, serde::Serialize)]
struct UpdateProgress {
    downloaded: u64,
    total: u64,
}

fn download_update(app: &AppHandle, url: &str, sha256: Option<&str>) -> Result<std::path::PathBuf, String> {
    use sha2::{Digest, Sha256};
    use std::io::{Read, Write};

    let resp = ureq::get(url)
        .set("User-Agent", "VoxShift-Updater")
        .call()
        .map_err(|e| format!("Download failed: {e}"))?;
    let total: u64 = resp.header("Content-Length").and_then(|v| v.parse().ok()).unwrap_or(0);
    let mut reader = resp.into_reader();
    let path = std::env::temp_dir().join("VoxShift-Setup-update.exe");
    let mut file = std::fs::File::create(&path).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    let (mut done, mut last_emit) = (0u64, 0u64);
    loop {
        let n = reader.read(&mut buf).map_err(|e| format!("Download failed: {e}"))?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        hasher.update(&buf[..n]);
        done += n as u64;
        if done - last_emit >= 128 * 1024 {
            last_emit = done;
            let _ = app.emit("update-progress", UpdateProgress { downloaded: done, total });
        }
    }
    file.flush().map_err(|e| e.to_string())?;
    drop(file);
    let _ = app.emit("update-progress", UpdateProgress { downloaded: done, total: done });

    if let Some(expected) = sha256 {
        let expected = expected.trim().trim_start_matches("sha256:");
        let got = format!("{:x}", hasher.finalize());
        if !got.eq_ignore_ascii_case(expected) {
            let _ = std::fs::remove_file(&path);
            return Err("The downloaded update failed its integrity check.".into());
        }
    }
    Ok(path)
}

/// Downloads the release installer, runs it in passive update mode (it relaunches VoxShift
/// when done) and quits so the installer can replace the files.
#[tauri::command]
async fn install_update(app: AppHandle, url: String, sha256: Option<String>) -> Result<(), String> {
    if !url.starts_with(RELEASE_PREFIX) || !url.ends_with(".exe") {
        return Err("Refusing to download an update from an unexpected address.".into());
    }
    let handle = app.clone();
    let path = tauri::async_runtime::spawn_blocking(move || download_update(&handle, &url, sha256.as_deref()))
        .await
        .map_err(|e| e.to_string())??;
    std::process::Command::new(&path)
        .args(["/P", "/R", "/UPDATE"])
        .spawn()
        .map_err(|e| format!("Could not start the installer: {e}"))?;
    app.exit(0);
    Ok(())
}

// ---------------- setup helpers ----------------

/// Grants microphone access to our own page without WebView2's permission prompt.
#[cfg(windows)]
fn allow_microphone(win: &tauri::WebviewWindow) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_PERMISSION_KIND, COREWEBVIEW2_PERMISSION_KIND_MICROPHONE, COREWEBVIEW2_PERMISSION_STATE_ALLOW,
    };
    use webview2_com::PermissionRequestedEventHandler;

    let _ = win.with_webview(|wv| unsafe {
        let Ok(core) = wv.controller().CoreWebView2() else { return };
        let handler = PermissionRequestedEventHandler::create(Box::new(|_, args| {
            if let Some(args) = args {
                let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
                args.PermissionKind(&mut kind)?;
                if kind == COREWEBVIEW2_PERMISSION_KIND_MICROPHONE {
                    args.SetState(COREWEBVIEW2_PERMISSION_STATE_ALLOW)?;
                }
            }
            Ok(())
        }));
        let mut token = Default::default();
        let _ = core.add_PermissionRequested(&handler, &mut token);
    });
}

fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open VoxShift", true, None::<&str>)?;
    let toggle = MenuItem::with_id(app, "toggle", "Turn voice on", true, None::<&str>)?;
    let monitor = CheckMenuItem::with_id(app, "monitor", "Hear myself", true, false, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Quit VoxShift", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &toggle, &monitor, &sep, &quit])?;

    TrayIconBuilder::with_id("main")
        .icon(app.default_window_icon().cloned().expect("app icon"))
        .tooltip("VoxShift")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_main(app),
            "toggle" => {
                let _ = app.emit("tray-toggle", ());
            }
            "monitor" => {
                let _ = app.emit("tray-monitor", ());
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_main(tray.app_handle());
            }
        })
        .build(app)?;

    *app.state::<AppState>().tray.lock().unwrap() = Some(TrayItems { toggle, monitor });
    Ok(())
}

pub fn run() {
    let state = AppState { close_to_tray: AtomicBool::new(true), ..Default::default() };

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--minimized"]),
        ))
        .manage(state)
        .setup(|app| {
            build_tray(app)?;
            let win = app.get_webview_window("main").expect("main window");
            #[cfg(windows)]
            allow_microphone(&win);
            // Started by "Start with Windows": stay in the tray.
            if !std::env::args().any(|a| a == "--minimized") {
                let _ = win.show();
                let _ = win.set_focus();
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let state = window.state::<AppState>();
                if state.close_to_tray.load(Ordering::Relaxed) {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        });

    #[cfg(windows)]
    let builder = builder.invoke_handler(tauri::generate_handler![
        install_virtual_cable,
        list_mics,
        system_mic_enable,
        system_mic_disable,
        set_tray_state,
        set_close_to_tray,
        quit_app,
        save_recording,
        install_update
    ]);
    #[cfg(not(windows))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        set_tray_state,
        set_close_to_tray,
        quit_app,
        save_recording,
        install_update
    ]);

    builder
        .build(tauri::generate_context!())
        .expect("error while building VoxShift")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                restore_default_mic(app);
            }
        });
}
