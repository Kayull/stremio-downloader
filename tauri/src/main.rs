#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io;
use std::path::PathBuf;
use std::sync::{mpsc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use reqwest::blocking::Client;
use serde::Deserialize;
use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;
use url::Url;

const MAIN_WINDOW_LABEL: &str = "main";
const STARTUP_TIMEOUT: Duration = Duration::from_secs(20);
const HEALTHCHECK_INTERVAL: Duration = Duration::from_millis(250);
const APP_DEEP_LINK_SCHEME: &str = "stremio-downloader";

#[derive(Default)]
struct SidecarState {
    child: Mutex<Option<CommandChild>>,
}

#[derive(Clone, Debug, Deserialize)]
struct ReadyPayload {
    event: String,
    #[serde(rename = "baseUrl")]
    base_url: String,
    #[serde(rename = "downloaderUrl")]
    downloader_url: String,
    #[serde(rename = "alreadyRunning")]
    already_running: bool,
}

enum StartupMessage {
    Ready(ReadyPayload),
    Error(String),
}

fn io_error(message: impl Into<String>) -> io::Error {
    io::Error::other(message.into())
}

fn desktop_runtime_candidates(app: &AppHandle) -> io::Result<Vec<PathBuf>> {
    let mut candidates = Vec::new();

    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|err| io_error(format!("Could not resolve app resource directory: {err}")))?;
    candidates.push(
        resource_dir
            .join("_up_")
            .join("build")
            .join("desktop-runtime")
            .join("scripts")
            .join("desktop-sidecar.js"),
    );
    candidates.push(
        resource_dir
            .join("desktop-runtime")
            .join("scripts")
            .join("desktop-sidecar.js"),
    );

    let dev_runtime_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("build")
        .join("desktop-runtime")
        .join("scripts")
        .join("desktop-sidecar.js");
    candidates.push(dev_runtime_path);

    Ok(candidates)
}

fn resource_script_path(app: &AppHandle) -> io::Result<String> {
    let candidates = desktop_runtime_candidates(app)?;
    if let Some(script_path) = candidates.iter().find(|candidate| candidate.exists()) {
        return Ok(script_path.to_string_lossy().into_owned());
    }

    let attempted_paths = candidates
        .iter()
        .map(|candidate| candidate.display().to_string())
        .collect::<Vec<_>>()
        .join(", ");

    Err(io_error(format!(
        "Desktop runtime script was not found. Checked: {attempted_paths}. Run `npm run desktop:prepare` first."
    )))
}

fn wait_for_healthcheck(base_url: &str, downloader_url: &str) -> io::Result<()> {
    let client = Client::builder()
        .timeout(Duration::from_millis(800))
        .build()
        .map_err(|err| {
            io_error(format!(
                "Could not create desktop healthcheck client: {err}"
            ))
        })?;
    let deadline = Instant::now() + STARTUP_TIMEOUT;
    let healthcheck_url = format!(
        "{}/api?method=download-settings",
        base_url.trim_end_matches('/')
    );
    let downloader_healthcheck_url = downloader_url.to_string();

    loop {
        let api_ready = client
            .get(&healthcheck_url)
            .send()
            .map(|response| response.status().is_success())
            .unwrap_or(false);
        let ui_ready = client
            .get(&downloader_healthcheck_url)
            .send()
            .and_then(|response| response.error_for_status())
            .and_then(|response| response.text())
            .map(|body| body.contains("Stremio Downloader"))
            .unwrap_or(false);

        if api_ready && ui_ready {
            return Ok(());
        }

        if Instant::now() >= deadline {
            return Err(io_error(format!(
                "Timed out waiting for the local downloader service at {healthcheck_url} and {downloader_healthcheck_url}"
            )));
        }

        thread::sleep(HEALTHCHECK_INTERVAL)
    }
}

fn build_desktop_url(downloader_url: &str) -> io::Result<Url> {
    let mut url = Url::parse(downloader_url).map_err(|err| {
        io_error(format!(
            "Invalid downloader URL returned by the sidecar: {err}"
        ))
    })?;
    url.query_pairs_mut().append_pair("desktop", "1");
    Ok(url)
}

fn store_child(app: &AppHandle, child: CommandChild) {
    let state = app.state::<SidecarState>();
    let mut lock = state
        .child
        .lock()
        .expect("sidecar state mutex poisoned while storing child");
    lock.replace(child);
}

fn shutdown_sidecar(app: &AppHandle) {
    let state = app.state::<SidecarState>();
    let child = {
        let mut lock = state
            .child
            .lock()
            .expect("sidecar state mutex poisoned while shutting down");
        lock.take()
    };

    if let Some(child) = child {
        let _ = child.kill();
    }
}

fn focus_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn is_app_focus_deep_link(url: &Url) -> bool {
    url.scheme() == APP_DEEP_LINK_SCHEME
}

fn register_deep_link_handlers(app: &AppHandle) -> io::Result<()> {
    #[cfg(any(target_os = "linux", all(debug_assertions, windows)))]
    app.deep_link()
        .register_all()
        .map_err(|err| io_error(format!("Could not register deep links in development: {err}")))?;

    let startup_urls = app
        .deep_link()
        .get_current()
        .map_err(|err| io_error(format!("Could not inspect startup deep links: {err}")))?;
    if let Some(urls) = startup_urls {
        if urls.iter().any(is_app_focus_deep_link) {
            focus_main_window(app);
        }
    }

    let app_handle = app.clone();
    app.deep_link().on_open_url(move |event| {
        if event.urls().iter().any(is_app_focus_deep_link) {
            focus_main_window(&app_handle);
        }
    });

    Ok(())
}

fn create_main_window(app: &AppHandle, ready: &ReadyPayload) -> io::Result<()> {
    if app.get_webview_window(MAIN_WINDOW_LABEL).is_some() {
        focus_main_window(app);
        return Ok(());
    }

    let desktop_url = build_desktop_url(&ready.downloader_url)?;
    WebviewWindowBuilder::new(app, MAIN_WINDOW_LABEL, WebviewUrl::External(desktop_url))
        .title("Stremio Downloader")
        .inner_size(1280.0, 820.0)
        .min_inner_size(1140.0, 700.0)
        .center()
        .build()
        .map_err(|err| io_error(format!("Could not create the main desktop window: {err}")))?;
    Ok(())
}

fn start_sidecar(app: &AppHandle) -> io::Result<ReadyPayload> {
    let script_path = resource_script_path(app)?;
    let sidecar = app
        .shell()
        .sidecar("node-launcher")
        .map_err(|err| io_error(format!("Could not resolve the bundled Node sidecar: {err}")))?;
    let (mut rx, child) = sidecar
        .args([script_path])
        .spawn()
        .map_err(|err| io_error(format!("Could not spawn the bundled Node sidecar: {err}")))?;

    store_child(app, child);

    let (startup_tx, startup_rx) = mpsc::sync_channel::<StartupMessage>(1);
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    let text = String::from_utf8_lossy(&line).trim().to_string();
                    if text.is_empty() {
                        continue;
                    }

                    if let Ok(payload) = serde_json::from_str::<ReadyPayload>(&text) {
                        if payload.event == "ready" {
                            let _ = startup_tx.send(StartupMessage::Ready(payload));
                            return;
                        }
                    }
                }
                CommandEvent::Stderr(line) => {
                    let text = String::from_utf8_lossy(&line).trim().to_string();
                    if !text.is_empty() {
                        eprintln!("{text}");
                    }
                }
                CommandEvent::Error(message) => {
                    let _ = startup_tx.send(StartupMessage::Error(format!(
                        "Node sidecar error before ready: {message}"
                    )));
                    return;
                }
                CommandEvent::Terminated(payload) => {
                    let code = payload
                        .code
                        .map(|value| value.to_string())
                        .unwrap_or_else(|| "unknown".to_string());
                    let _ = startup_tx.send(StartupMessage::Error(format!(
                        "Node sidecar exited before ready with code {code}"
                    )));
                    return;
                }
                _ => {}
            }
        }

        let _ = startup_tx.send(StartupMessage::Error(
            "Node sidecar output closed before the ready message was received.".to_string(),
        ));
    });

    let startup_message = startup_rx
        .recv_timeout(STARTUP_TIMEOUT)
        .map_err(|_| io_error("Timed out waiting for the Node sidecar ready event."))?;

    let ready = match startup_message {
        StartupMessage::Ready(payload) => payload,
        StartupMessage::Error(message) => return Err(io_error(message)),
    };

    wait_for_healthcheck(&ready.base_url, &ready.downloader_url)?;
    if ready.already_running {
        eprintln!(
            "Using existing local downloader service at {}",
            ready.base_url
        );
    }
    Ok(ready)
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            focus_main_window(app);
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_shell::init())
        .manage(SidecarState::default())
        .setup(|app| {
            let ready = start_sidecar(app.handle())?;
            create_main_window(app.handle(), &ready)?;
            register_deep_link_handlers(app.handle())?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Stremio Downloader desktop shell");

    app.run(|app_handle, event| {
        if matches!(event, RunEvent::Exit | RunEvent::ExitRequested { .. }) {
            shutdown_sidecar(app_handle);
        }
    });
}
