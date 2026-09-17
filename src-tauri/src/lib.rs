//! 运营工作台桌面客户端 —— Tauri 薄壳
//!
//! 职责（刻意保持轻薄）：
//!   1. 启动 sidecar：用 node.exe 跑 wb-server.js（监听 127.0.0.1:8787）。
//!   2. 等端口就绪后，开主窗口指向 http://127.0.0.1:8787/工作台.html。
//!   3. 开一个无边框置顶透明「悬浮球」窗口（待办球 + AI 球），常驻桌面。
//!   4. 挂一个系统托盘，主窗口关闭时只隐藏不退出，托盘/悬浮球可再唤起。
//!   5. 客户端退出时，把 sidecar 子进程一并结束。
//!   6. 数据目录统一落到用户 LocalAppData，卸载 / 升级不丢数据。

use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_updater::UpdaterExt;
use url::Url;

const PORT: u16 = 8787;
const MAIN_LABEL: &str = "main";
const FAB_AI_LABEL: &str = "fab_ai";
const FAB_TODO_LABEL: &str = "fab_todo";
const FAB_ACTION_EVENT: &str = "wb-fab-action";

/// 桌面上两个悬浮球窗口的元数据（独立拖动、独立记忆位置）。
const FABS: &[(&str, &str, &str)] = &[
    // (label, 悬浮球.html 的 which 参数, 位置存档文件名)
    (FAB_AI_LABEL, "ai", "fab-ai-pos.json"),
    (FAB_TODO_LABEL, "todo", "fab-todo-pos.json"),
];

/// 持有 sidecar 子进程句柄，便于退出时回收。
struct ServerProcess(Mutex<Option<Child>>);

/// 定位工作台根目录（node.exe / wb-server.js / 全部 HTML 都在这里）。
/// 优先级：打包后的资源目录 > 可执行文件同目录 > 开发者本机桌面路径（兜底）。
fn resolve_workbench_dir(app: &tauri::App) -> PathBuf {
    if let Ok(res) = app.path().resource_dir() {
        let candidate = res.join("app");
        if candidate.join("wb-server.js").exists() {
            return candidate;
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let dir = dir.to_path_buf();
            if dir.join("wb-server.js").exists() {
                return dir;
            }
        }
    }
    PathBuf::from(r"C:\Users\admin\Desktop\运营工作台")
}

fn start_server(root: &Path, data_dir: &Path) -> Result<Child, String> {
    let node_exe = root.join("node.exe");

    let mut cmd = Command::new(&node_exe);
    // 脚本名用相对路径（配合 current_dir），避免 argv 里带中文被解析坏。
    cmd.arg("wb-server.js")
        .env("WB_DATA_DIR", data_dir)
        .current_dir(root)
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    // Windows：CREATE_NO_WINDOW，让 node 服务静默后台运行，不弹黑窗。
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }

    cmd.spawn()
        .map_err(|e| format!("启动本地服务失败（{}）：{}", node_exe.display(), e))
}

/// 轮询端口，直到服务可连接或超时。
fn wait_port(port: u16, timeout: Duration) -> bool {
    let start = Instant::now();
    while start.elapsed() < timeout {
        if TcpStream::connect(("127.0.0.1", port)).is_ok() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    false
}

/// 数据目录（与 wb-server 的 WB_DATA_DIR 一致），用于存放悬浮球位置等客户端状态。
fn data_dir_of(app: &tauri::AppHandle) -> PathBuf {
    app.path()
        .app_local_data_dir()
        .map(|d| d.join("data"))
        .unwrap_or_default()
}

#[derive(serde::Serialize, serde::Deserialize)]
struct FabPos {
    x: i32,
    y: i32,
}

fn load_fab_pos(data_dir: &Path, pos_file: &str) -> Option<(i32, i32)> {
    let p = data_dir.join(pos_file);
    let s = std::fs::read_to_string(p).ok()?;
    let v: FabPos = serde_json::from_str(&s).ok()?;
    Some((v.x, v.y))
}

fn save_fab_pos(app: &tauri::AppHandle, data_dir: &Path) {
    for (label, _, pos_file) in FABS {
        if let Some(w) = app.get_webview_window(label) {
            if let Ok(pos) = w.outer_position() {
                let json = serde_json::to_string(&FabPos {
                    x: pos.x,
                    y: pos.y,
                })
                .unwrap_or_default();
                let _ = std::fs::write(data_dir.join(pos_file), json);
            }
        }
    }
}

/// 唤起主窗口（若隐藏则显示，若最小化则还原，最后聚焦）。
fn show_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window(MAIN_LABEL) {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

fn open_main_window(app: &tauri::AppHandle) {
    let target = Url::parse(&format!("http://127.0.0.1:{}/工作台.html", PORT))
        .expect("工作台 URL 解析失败");

    let res = WebviewWindowBuilder::new(app, MAIN_LABEL, WebviewUrl::External(target))
        .title("运营工作台")
        .inner_size(1280.0, 800.0)
        .build();

    if let Err(e) = res {
        eprintln!("创建主窗口失败：{}", e);
    }
}

fn open_fab_window(app: &tauri::AppHandle, data_dir: &Path, label: &str, which: &str, pos_file: &str) {
    let target = Url::parse(&format!("http://127.0.0.1:{}/悬浮球.html?which={}", PORT, which))
        .expect("悬浮球 URL 解析失败");

    // 单个球窗口：56px 球 + 四周留 12px 边距 → 80×80。
    let res = WebviewWindowBuilder::new(app, label, WebviewUrl::External(target))
        .title("运营工作台悬浮球")
        .inner_size(80.0, 80.0)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .shadow(false)
        .focused(false)
        .build();

    if let Ok(w) = res {
        if let Some((x, y)) = load_fab_pos(data_dir, pos_file) {
            let _ = w.set_position(tauri::PhysicalPosition::new(x, y));
        } else if let Ok(Some(mon)) = app.primary_monitor() {
            // 首次启动：两个球纵向排列贴屏幕右缘、垂直居中。
            let size = mon.size();
            let pos = mon.position();
            let ww = w.outer_size().map(|s| s.width as i32).unwrap_or(80);
            let wh = w.outer_size().map(|s| s.height as i32).unwrap_or(80);
            let x = (pos.x + size.width as i32 - ww - 16).max(0);
            let base_y = pos.y + (size.height as i32 - wh) / 2;
            let offset = if which == "ai" { -52 } else { 52 };
            let y = (base_y + offset).max(0);
            let _ = w.set_position(tauri::PhysicalPosition::new(x, y));
        }
    } else if let Err(e) = res {
        eprintln!("创建悬浮球窗口（{}）失败：{}", which, e);
    }
}

/// 显示或隐藏某个桌面悬浮球窗口（which: "ai" / "todo"）。
#[tauri::command]
fn fab_set_visible(app: tauri::AppHandle, which: String, visible: bool) {
    let label = if which == "todo" { FAB_TODO_LABEL } else { FAB_AI_LABEL };
    if let Some(w) = app.get_webview_window(label) {
        if visible {
            let _ = w.show();
        } else {
            let _ = w.hide();
        }
    }
}

fn setup_tray(app: &tauri::App) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "打开工作台", true, None::<&str>)?;
    let hide_tray = MenuItem::with_id(app, "hide_tray", "隐藏到托盘", true, None::<&str>)?;
    let hide_fab = MenuItem::with_id(app, "hide_fab", "隐藏浮球", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "设置…", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出客户端", true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(
        app,
        &[&open, &hide_tray, &hide_fab, &sep1, &settings, &sep2, &quit],
    )?;

    let mut builder = TrayIconBuilder::with_id("main-tray")
        .tooltip("运营工作台")
        .menu(&menu)
        .show_menu_on_left_click(true);
    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }
    builder.build(app.handle())?;
    Ok(())
}

/// 悬浮球左侧按钮点击：唤起主窗口 + 让主窗口跳转到对应页（AI 面板 / 待办页）。
#[tauri::command]
fn fab_action(app: tauri::AppHandle, action: String) {
    show_main(&app);
    let _ = app.emit_to(
        tauri::EventTarget::labeled(MAIN_LABEL),
        FAB_ACTION_EVENT,
        action,
    );
}

/// 悬浮球右键：弹出原生菜单（隐藏悬浮球 / 设置）。
#[tauri::command]
fn fab_menu(app: tauri::AppHandle, which: String) {
    let label = if which == "todo" { FAB_TODO_LABEL } else { FAB_AI_LABEL };
    if let Some(w) = app.get_webview_window(label) {
        let hide_id = if which == "todo" { "hide_fab_todo" } else { "hide_fab_ai" };
        let hide = MenuItem::with_id(&app, hide_id, "隐藏悬浮球", true, None::<&str>);
        let settings = MenuItem::with_id(&app, "fab_settings", "设置", true, None::<&str>);
        if let (Ok(hide), Ok(settings)) = (hide, settings) {
            if let Ok(menu) = Menu::with_items(&app, &[&hide, &settings]) {
                let _ = w.popup_menu(&menu);
            }
        }
    }
}

const IGNORE_FILE: &str = "ignored-update.txt";

/// 已忽略的版本（用户点了「忽略本版本」后，后台与手动检查都不再提示它）。
fn read_ignored(data_dir: &Path) -> String {
    std::fs::read_to_string(data_dir.join(IGNORE_FILE))
        .ok()
        .map(|s| s.trim().to_string())
        .unwrap_or_default()
}

/// 更新结果（供前端展示 / 手动触发检查）。
#[derive(serde::Serialize)]
struct UpdateInfo {
    available: bool,
    version: String,
    current_version: String,
    date: Option<i64>,
    body: Option<String>,
    ignored: bool,
}

/// 检查更新：返回是否有可用版本（无更新 / 已被忽略 时 available=false）。
#[tauri::command]
async fn check_update(app: tauri::AppHandle) -> Result<UpdateInfo, String> {
    let current = app.package_info().version.to_string();
    let updater = app.updater().map_err(|e| e.to_string())?;
    let ignored = read_ignored(&data_dir_of(&app));
    match updater.check().await {
        Ok(Some(u)) => {
            let is_ignored = ignored == u.version.as_str();
            Ok(UpdateInfo {
                available: !is_ignored,
                version: u.version.clone(),
                current_version: current,
                date: u.date.map(|d| d.unix_timestamp()),
                body: u.body.clone(),
                ignored: is_ignored,
            })
        }
        Ok(None) => Ok(UpdateInfo {
            available: false,
            version: String::new(),
            current_version: current,
            date: None,
            body: None,
            ignored: false,
        }),
        Err(e) => Err(e.to_string()),
    }
}

/// 忽略某个版本：以后检查更新不再提示该版本。
#[tauri::command]
fn ignore_update(app: tauri::AppHandle, version: String) -> Result<(), String> {
    let dir = data_dir_of(&app);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(IGNORE_FILE), version.trim()).map_err(|e| e.to_string())
}

/// 结束 sidecar（node.exe）进程，释放 app\node.exe 等文件锁。
/// Windows 下 sidecar 是独立子进程，更新安装器覆盖文件前必须先结束它，
/// 否则会报 "Error opening file for writing: ...\app\node.exe"。
fn kill_server(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<ServerProcess>() {
        if let Ok(mut guard) = state.0.lock() {
            if let Some(mut child) = guard.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

/// 下载并安装新版本。下载进度通过 `wb-update-progress` 事件逐块报给前端。
/// 下载完成后立刻拉起 NSIS 安装器（passive 模式），客户端会自动退出，装完自动重回新版本。
#[tauri::command]
async fn download_update(app: tauri::AppHandle) -> Result<(), String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    let update = updater
        .check()
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "当前已是最新版本，无需更新".to_string())?;

    let bytes = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let target = tauri::EventTarget::labeled(MAIN_LABEL);
    let handle = app.clone();
    let installer_handle = app.clone();
    update
        .download_and_install(
            move |chunk, total| {
                let cur = bytes.fetch_add(chunk, std::sync::atomic::Ordering::SeqCst) + chunk;
                let _ = handle.emit_to(
                    target.clone(),
                    "wb-update-progress",
                    serde_json::json!({
                        "downloaded": cur,
                        "total": total,
                    }),
                );
            },
            move || {
                // 下载完成、拉起安装器前：先结束 sidecar，释放 node.exe 文件锁。
                kill_server(&installer_handle);
            },
        )
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 启动后后台检查一次更新，发现新版本则通知主窗口。
fn spawn_update_check(app: &tauri::AppHandle) {
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let updater = match handle.updater() {
            Ok(u) => u,
            Err(_) => return,
        };
        if let Ok(Some(u)) = updater.check().await {
            let ignored = read_ignored(&data_dir_of(&handle));
            if ignored == u.version.as_str() {
                return;
            }
            let _ = handle.emit_to(
                tauri::EventTarget::labeled(MAIN_LABEL),
                "wb-update-available",
                serde_json::json!({
                    "version": u.version,
                    "current_version": u.current_version,
                    "date": u.date.map(|d| d.unix_timestamp()),
                    "body": u.body,
                }),
            );
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let root = resolve_workbench_dir(app);
            let data_dir = app
                .path()
                .app_local_data_dir()
                .map(|d| d.join("data"))
                .unwrap_or_else(|_| root.join("data"));

            match start_server(&root, &data_dir) {
                Ok(child) => {
                    app.manage(ServerProcess(Mutex::new(Some(child))));
                }
                Err(e) => eprintln!("{}", e),
            }

            // 等服务就绪再开窗口，避免窗口先起来时 8787 还没监听导致白屏。
            if !wait_port(PORT, Duration::from_secs(15)) {
                eprintln!("警告：{} 端口在 15 秒内未就绪", PORT);
            }

            open_main_window(app.handle());
            for (label, which, pos_file) in FABS {
                open_fab_window(app.handle(), &data_dir, label, which, pos_file);
            }
            if let Err(e) = setup_tray(app) {
                eprintln!("创建系统托盘失败：{}", e);
            }
            spawn_update_check(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            fab_action,
            fab_menu,
            fab_set_visible,
            check_update,
            ignore_update,
            download_update
        ])
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show_main(app),
            "hide_tray" => {
                if let Some(w) = app.get_webview_window(MAIN_LABEL) {
                    let _ = w.hide();
                }
            }
            "hide_fab" => {
                for (label, _, _) in FABS {
                    if let Some(w) = app.get_webview_window(label) {
                        let _ = w.hide();
                    }
                }
                let _ = app.emit_to(
                    tauri::EventTarget::labeled(MAIN_LABEL),
                    "tray-event",
                    "hide_fab",
                );
            }
            "hide_fab_ai" | "hide_fab_todo" => {
                let is_todo = event.id().as_ref() == "hide_fab_todo";
                let label = if is_todo { FAB_TODO_LABEL } else { FAB_AI_LABEL };
                if let Some(w) = app.get_webview_window(label) {
                    let _ = w.hide();
                }
                let which = if is_todo { "todo" } else { "ai" };
                let _ = app.emit_to(
                    tauri::EventTarget::labeled(MAIN_LABEL),
                    "tray-event",
                    format!("hide_fab:{}", which),
                );
            }
            "settings" | "fab_settings" => {
                show_main(app);
                let _ = app.emit_to(
                    tauri::EventTarget::labeled(MAIN_LABEL),
                    "tray-event",
                    "settings",
                );
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_window_event(|window, event| {
            // 主窗口关闭 → 只隐藏不退出，悬浮球和托盘继续常驻桌面。
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == MAIN_LABEL {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("Tauri 初始化失败")
        .run(|app_handle, event| {
            // 进程退出时：保存悬浮球位置 + 回收 sidecar，避免残留 node.exe 占用 8787。
            if let tauri::RunEvent::Exit = event {
                let data_dir = data_dir_of(app_handle);
                save_fab_pos(app_handle, &data_dir);
                kill_server(app_handle);
            }
        });
}