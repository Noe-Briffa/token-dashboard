#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    io::{BufRead, BufReader},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    thread,
};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};

#[derive(Default)]
struct ServerState(Mutex<Option<Child>>);

#[derive(Default)]
struct QuitState(AtomicBool);

fn resource_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().resource_dir().map_err(|error| error.to_string())
}

fn app_root(app: &AppHandle) -> Result<PathBuf, String> {
    if cfg!(debug_assertions) {
        Ok(PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .ok_or_else(|| "Tauri project root unavailable".to_string())?
            .to_path_buf())
    } else {
        let resources = resource_dir(app)?;
        let unpacked = resources.join("_up_");
        if unpacked.join("src").exists() {
            Ok(unpacked)
        } else {
            Ok(resources)
        }
    }
}

fn node_runtime(app: &AppHandle) -> Result<PathBuf, String> {
    let resources = resource_dir(app)?;
    let root = app_root(app)?;
    [
        resources.join("runtime").join("node.exe"),
        root.join("runtime").join("node.exe"),
    ]
    .into_iter()
    .find(|path| path.exists())
    .ok_or_else(|| "Bundled Node runtime not found".to_string())
}

fn stop_server(app: &AppHandle) {
    let state = app.state::<ServerState>();
    let child = state.0.lock().expect("server state poisoned").take();
    if let Some(mut child) = child {
        let _ = child.kill();
        let _ = child.wait();
    }
}

fn open_window(app: &AppHandle, url: &str) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        window.show().map_err(|error| error.to_string())?;
        window.set_focus().map_err(|error| error.to_string())?;
        return Ok(());
    }

    let parsed = url
        .parse()
        .map_err(|error: url::ParseError| error.to_string())?;
    let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(parsed))
        .title("AI Usage Monitor")
        .inner_size(1440.0, 960.0)
        .min_inner_size(960.0, 680.0)
        .build()
        .map_err(|error| error.to_string())?;
    let handle = app.clone();
    let window_to_destroy = window.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let _ = window_to_destroy.destroy();
            stop_server(&handle);
        }
    });
    Ok(())
}

fn start_server(app: &AppHandle) -> Result<(), String> {
    if app
        .state::<ServerState>()
        .0
        .lock()
        .expect("server state poisoned")
        .is_some()
    {
        return Ok(());
    }

    let root = app_root(app)?;
    let script = PathBuf::from("src").join("server.js");
    let node = if cfg!(debug_assertions) {
        PathBuf::from("node")
    } else {
        node_runtime(app)?
    };
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("data");
    let legacy_data_dir = if cfg!(windows) {
        std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| root.clone())
            .join("ai-usage-monitor")
            .join("data")
    } else {
        root.join("data")
    };
    let mut command = Command::new(node);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let mut child = command
        .arg(script)
        .current_dir(&root)
        .env("AI_USAGE_DATA_DIR", data_dir)
        .env("AI_USAGE_LEGACY_DATA_DIR", legacy_data_dir)
        .stdout(Stdio::piped())
        .stderr(if cfg!(debug_assertions) {
            Stdio::inherit()
        } else {
            Stdio::null()
        })
        .spawn()
        .map_err(|error| format!("Unable to start Node server: {error}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Node server stdout unavailable".to_string())?;
    app.state::<ServerState>()
        .0
        .lock()
        .expect("server state poisoned")
        .replace(child);

    let handle = app.clone();
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Some(url) = line.strip_prefix("AI Usage Monitor: ") {
                if let Err(error) = open_window(&handle, url) {
                    eprintln!("Unable to open dashboard: {error}");
                }
                break;
            }
        }
    });
    Ok(())
}

fn show_or_start(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }
    if let Err(error) = start_server(app) {
        eprintln!("Unable to start dashboard: {error}");
    }
}

fn main() {
    tauri::Builder::default()
        .manage(ServerState::default())
        .manage(QuitState::default())
        .setup(|app| {
            let open = MenuItemBuilder::with_id("open", "Ouvrir le dashboard").build(app)?;
            let quit = MenuItemBuilder::with_id("quit", "Quitter").build(app)?;
            let menu = MenuBuilder::new(app).items(&[&open, &quit]).build()?;
            let handle = app.handle().clone();
            let icon = app
                .default_window_icon()
                .cloned()
                .ok_or_else(|| "Tauri default icon unavailable".to_string())?;
            TrayIconBuilder::with_id("main")
                .menu(&menu)
                .icon(icon)
                .tooltip("AI Usage Monitor")
                .on_menu_event(move |app, event| match event.id().as_ref() {
                    "open" => show_or_start(app),
                    "quit" => {
                        app.state::<QuitState>().0.store(true, Ordering::SeqCst);
                        stop_server(app);
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(move |_tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_or_start(&handle);
                    }
                })
                .build(app)?;
            show_or_start(app.handle());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building AI Usage Monitor")
        .run(|app: &AppHandle, event| {
            if let RunEvent::ExitRequested { api, .. } = event {
                if !app.state::<QuitState>().0.load(Ordering::SeqCst) {
                    api.prevent_exit();
                }
            }
        });
}
