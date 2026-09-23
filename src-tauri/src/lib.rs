//! 运营工作台桌面客户端 —— Tauri 薄壳
//!
//! 职责（刻意保持轻薄）：
//!   1. 启动 sidecar：用 node.exe 跑 wb-server.js（监听 127.0.0.1:8787）。
//!   2. 等端口就绪后，开主窗口指向 http://127.0.0.1:8787/工作台.html。
//!   3. 开一个无边框置顶透明「悬浮球」窗口（待办球 + AI 球），常驻桌面。
//!   4. 挂一个系统托盘，主窗口关闭时只隐藏不退出，托盘/悬浮球可再唤起。
//!   5. 客户端退出时，把 sidecar 子进程一并结束。
//!   6. 数据目录统一落到用户 LocalAppData，卸载 / 升级不丢数据。
//!   7. **单实例**：同一台机器只允许跑一个客户端（见 acquire/request_focus 的注释）。

use std::fs::File;
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

/// 悬浮球显隐存档（放在 data 目录，卸载 / 升级不丢）。
/// 与前端 localStorage 的 `wb_ai_fab` / `wb_todo_fab` 是同一份「用户意图」，
/// 两边每次变更都会同时写 —— 缺省=显示，与前端 `wbFabOn()` 的「缺省=开」一致。
const VIS_FILE: &str = "fab-vis.json";

/// 桌面上两个悬浮球窗口的元数据（独立拖动、独立记忆位置）。
const FABS: &[(&str, &str, &str)] = &[
    // (label, 悬浮球.html 的 which 参数, 位置存档文件名)
    (FAB_AI_LABEL, "ai", "fab-ai-pos.json"),
    (FAB_TODO_LABEL, "todo", "fab-todo-pos.json"),
];

/// 持有 sidecar 子进程句柄，便于退出时回收。
struct ServerProcess(Mutex<Option<Child>>);

/// 单实例锁文件（放在 app_local_data_dir 根，不放 data/ 子目录 ——
/// 免得被 `WB_CLIENT_DATA_DIR` 改道后两个实例各拿一把锁）。
const LOCK_FILE: &str = "wb-client.lock";
/// 「请把主窗口提到前台」的请求文件（第二个实例退出前写它）。
const FOCUS_FILE: &str = "focus.request";

/// 单实例锁的持有者：**只要这个 File 活着，排他锁就一直在**，
/// 所以必须 manage 进 Tauri 状态里、不能让它被 drop（drop 即解锁）。
struct SingleInstanceLock(#[allow(dead_code)] File);

/// 尝试取得单实例排他锁，返回 `(能否启动, 锁句柄)`。
///
/// ★ 为什么必须有这个（2026-09-18 用户报「客户端可以无限打开」）：
///   多开时**只有第一个进程的 node 抢得到 8787**，其余进程的 node 起不来，
///   但 `wait_port()` 会因为「别人在监听」而返回 true → 窗口照常打开、看着一切正常。
///   用户一旦关掉第一个，剩下的实例就全部失去后端：页面请求失败、手填数据存不下去。
///   而且每个实例都会各建一套悬浮球 + 托盘图标，桌面上叠一堆球。
///
/// 用 std 的文件锁实现（Rust 1.89+ 的 `File::try_lock`），不引额外依赖
/// （`tauri-plugin-single-instance` 本地缓存里没有，离线装不了）。
/// ⚠️ 锁文件建不出来 / 打不开时**放行启动** —— 宁可多开一次，
///    也别因为锁机制出异常让用户彻底打不开客户端（fail-open）。
fn acquire_single_instance(dir: &Path) -> (bool, Option<File>) {
    if std::fs::create_dir_all(dir).is_err() {
        return (true, None);
    }
    let f = match std::fs::OpenOptions::new().create(true).read(true).write(true).open(dir.join(LOCK_FILE)) {
        Ok(f) => f,
        Err(_) => return (true, None),
    };
    if f.try_lock().is_ok() {
        (true, Some(f))
    } else {
        (false, None)
    }
}

/// 请已经在跑的那个实例把主窗口提到前台。
/// 用文件轮询而不是 IPC：不引依赖，也**不弹模态对话框** ——
/// 用户误双击时被一个「已运行」的框挡住、还要手动点确定，体验很差。
fn request_focus(dir: &Path) {
    let _ = std::fs::write(dir.join(FOCUS_FILE), "1");
}

/// 后台轮询「提到前台」的请求：发现就删掉并唤起主窗口。
fn spawn_focus_watcher(app: &tauri::AppHandle, dir: PathBuf) {
    let handle = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(800));
        let p = dir.join(FOCUS_FILE);
        if p.exists() {
            let _ = std::fs::remove_file(&p);
            show_main(&handle);
        }
    });
}

/// 读 `WB_APP_ROOT` 环境变量（本地开发模式的项目根目录）。
/// 目录下必须有 `wb-server.js` 才认，否则打印告警并忽略 —— 免得路径写错时
/// 悄悄退回资源目录、让人以为「改了 HTML 没生效」。
fn workbench_root_from_env() -> Option<PathBuf> {
    let raw = std::env::var("WB_APP_ROOT").ok()?;
    let dir = raw.trim().trim_matches('"').trim();
    if dir.is_empty() {
        return None;
    }
    let p = PathBuf::from(dir);
    if p.join("wb-server.js").exists() {
        Some(p)
    } else {
        eprintln!("WB_APP_ROOT 指向的目录下没有 wb-server.js，已忽略：{}", dir);
        None
    }
}

/// 定位工作台根目录（node.exe / wb-server.js / 全部 HTML 都在这里）。
/// 优先级：环境变量 WB_APP_ROOT（本地开发模式）> 打包后的资源目录 > 可执行文件同目录 > 兜底路径。
///
/// ★ 本地开发模式（2026-09-18）：设置 WB_APP_ROOT=<项目根绝对路径> 后，客户端直接读项目目录，
///   改 HTML 只需刷新窗口即生效 —— 不用重新构建、不用重装。
///   入口见项目根目录的「启动客户端-开发模式.bat」。
///   注意：窗口加载的是 http://127.0.0.1:8787/工作台.html，由这里的 root 起 node 服务提供，
///   所以「换 root」= 换整套页面，`dist/` 那个前端目录跟运行时无关。
fn resolve_workbench_dir(app: &tauri::App) -> PathBuf {
    if let Some(p) = workbench_root_from_env() {
        return p;
    }
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

/// 解析数据目录：默认跟正式版同一份（`%LOCALAPPDATA%\com.workbench.client\data`），
/// 这样开发模式下看到的就是用户的真实数据。
/// 想拿假数据练手时，设 `WB_CLIENT_DATA_DIR=<绝对路径>` 切到隔离目录，
/// 免得开发期的误操作写坏生产数据（本项目真出过这种事）。
fn resolve_data_dir(app: &tauri::App, root: &Path) -> PathBuf {
    if let Ok(raw) = std::env::var("WB_CLIENT_DATA_DIR") {
        let dir = raw.trim().trim_matches('"').trim();
        if !dir.is_empty() {
            eprintln!("WB_CLIENT_DATA_DIR 生效，数据目录切到隔离目录：{}", dir);
            return PathBuf::from(dir);
        }
    }
    app.path()
        .app_local_data_dir()
        .map(|d| d.join("data"))
        .unwrap_or_else(|_| root.join("data"))
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

/// 读取悬浮球显隐存档（缺省=显示）。
fn fab_visible_saved(data_dir: &Path, which: &str) -> bool {
    std::fs::read_to_string(data_dir.join(VIS_FILE))
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v.get(which).and_then(|x| x.as_bool()))
        .unwrap_or(true)
}

/// 写入某个球的显隐状态（读-改-写，保留另一个球的值）。
fn save_fab_visible(data_dir: &Path, which: &str, visible: bool) {
    let mut v = std::fs::read_to_string(data_dir.join(VIS_FILE))
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .filter(|x| x.is_object())
        .unwrap_or_else(|| serde_json::json!({}));
    if let Some(obj) = v.as_object_mut() {
        obj.insert(which.to_string(), serde_json::Value::Bool(visible));
    }
    if std::fs::create_dir_all(data_dir).is_err() {
        return;
    }
    let _ = std::fs::write(data_dir.join(VIS_FILE), v.to_string());
}

fn fab_label_of(which: &str) -> &'static str {
    if which == "todo" {
        FAB_TODO_LABEL
    } else {
        FAB_AI_LABEL
    }
}

/// 「显隐 + 落盘」的唯一入口：前端命令、托盘菜单、启动恢复都走这里，
/// 避免窗口状态与存档分叉（分叉的表现就是「设置里写着已隐藏，球却还在」）。
fn apply_fab_visible(app: &tauri::AppHandle, which: &str, visible: bool) {
    if let Some(w) = app.get_webview_window(fab_label_of(which)) {
        if visible {
            let _ = w.show();
        } else {
            let _ = w.hide();
        }
    }
    save_fab_visible(&data_dir_of(app), if which == "todo" { "todo" } else { "ai" }, visible);
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
        // 去掉原生标题栏：改用工作台.html 里自绘的顶部标题栏（折叠+搜索+窗口控制），与主题融合。
        .decorations(false)
        /* ★ 必须关掉 Tauri 自带的拖放处理器（默认是开的）—— 官方注释原话：
           "This is required to use HTML5 drag and drop APIs on the frontend on Windows."
           开着的时候 Tauri 会把文件拖放截走：前端 dragover 还有反应（所以高亮会亮），
           但 drop 事件里 dataTransfer.files 是**空的** → 页面表现为「拖进去没反应」。
           2026-09-20 用户报障「店铺推广页拖 Excel 没反应」，根因就在这。 */
        .disable_drag_drop_handler()
        .build();

    if let Err(e) = res {
        eprintln!("创建主窗口失败：{}", e);
    }
}

fn open_fab_window(app: &tauri::AppHandle, data_dir: &Path, label: &str, which: &str, pos_file: &str) {
    let target = Url::parse(&format!("http://127.0.0.1:{}/悬浮球.html?which={}", PORT, which))
        .expect("悬浮球 URL 解析失败");

    // 单个球窗口：56px 球 + 四周留 12px 边距 → 80×80。
    // ★ 初始显隐按存档恢复：上次在设置里关掉的球，启动时不再「先冒出来」——
    //   否则会出现「设置里写着已隐藏、球却显示」的不一致（用户报障）。
    let visible = fab_visible_saved(data_dir, which);
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
        .visible(visible)
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
/// 同时把状态写进存档 —— 下次启动按它恢复，保证「开关状态 = 球的实际显隐」。
#[tauri::command]
fn fab_set_visible(app: tauri::AppHandle, which: String, visible: bool) {
    apply_fab_visible(&app, &which, visible);
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
    // 与后台检查保持一致：开发模式下手动检查也直接说明原因，避免误装正式版覆盖开发环境。
    if is_dev_mode() {
        return Err("当前是本地开发模式（WB_APP_ROOT 生效），已跳过更新检查".to_string());
    }
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

/// 是否处于本地开发模式（WB_APP_ROOT 有效即视为开发模式）。
fn is_dev_mode() -> bool {
    workbench_root_from_env().is_some()
}

/// 启动后后台检查一次更新，发现新版本则通知主窗口。
fn spawn_update_check(app: &tauri::AppHandle) {
    // 开发模式下不检查更新：否则 dev 客户端会提示「有新版本」并把正式版装进去，
    // 把「改 HTML 立刻生效」的开发环境覆盖掉，容易让人一头雾水。
    if is_dev_mode() {
        return;
    }
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
            let data_dir = resolve_data_dir(app, &root);

            /* ★ 单实例保护（2026-09-18）：必须排在 start_server / 开窗口**之前** ——
               否则第二个实例已经起了 node、建好了球和托盘，再退出就留下残影。 */
            let lock_dir = app.path().app_local_data_dir().unwrap_or_else(|_| root.clone());
            let (can_start, lock) = acquire_single_instance(&lock_dir);
            if !can_start {
                // 已经有实例在跑：请它把主窗口提到前台，本进程立刻退出。
                // 不用模态对话框 —— 用户误双击时不该被一个框挡住还要手动点确定。
                request_focus(&lock_dir);
                std::process::exit(0);
            }
            if let Some(f) = lock {
                // 锁句柄必须活到进程结束（drop 即解锁），交给 Tauri 托管
                app.manage(SingleInstanceLock(f));
            }
            spawn_focus_watcher(app.handle(), lock_dir);

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
                // 走统一入口：隐藏窗口 + 落盘存档（下次启动不会又冒出来）
                apply_fab_visible(app, "ai", false);
                apply_fab_visible(app, "todo", false);
                let _ = app.emit_to(
                    tauri::EventTarget::labeled(MAIN_LABEL),
                    "tray-event",
                    "hide_fab",
                );
            }
            "hide_fab_ai" | "hide_fab_todo" => {
                let is_todo = event.id().as_ref() == "hide_fab_todo";
                let which = if is_todo { "todo" } else { "ai" };
                apply_fab_visible(app, which, false);
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

#[cfg(test)]
mod tests {
    use super::*;

    /// 本地开发模式（WB_APP_ROOT）的解析规则。
    /// 写成一个函数而不是多个 `#[test]`：这几个用例都要改**进程级**环境变量，
    /// 拆开会被 cargo 的并行测试线程互相踩。
    #[test]
    fn wb_app_root_env_resolution() {
        let tmp = std::env::temp_dir().join(format!("wb-approot-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).expect("建临时目录失败");

        // 1) 没有这个环境变量 → 不算开发模式
        std::env::remove_var("WB_APP_ROOT");
        assert_eq!(workbench_root_from_env(), None, "未设变量时不应命中");
        assert!(!is_dev_mode(), "未设变量时不应是开发模式");

        // 2) 目录里没有 wb-server.js → 忽略（防路径写错时静默退回资源目录）
        std::env::set_var("WB_APP_ROOT", &tmp);
        assert_eq!(workbench_root_from_env(), None, "缺 wb-server.js 时应忽略");
        assert!(!is_dev_mode(), "无效路径不应算开发模式");

        // 3) 空串 / 纯空白 → 忽略
        std::env::set_var("WB_APP_ROOT", "   ");
        assert_eq!(workbench_root_from_env(), None, "空串时应忽略");

        // 4) 正常命中
        std::fs::write(tmp.join("wb-server.js"), "// stub").unwrap();
        std::env::set_var("WB_APP_ROOT", &tmp);
        assert_eq!(workbench_root_from_env(), Some(tmp.clone()), "应返回项目根");
        assert!(is_dev_mode(), "有效路径应算开发模式");

        // 5) 路径被引号 / 空格包住（.bat 里 `set "VAR=..."` 容易带出来）→ 要能剥掉
        let quoted = format!("  \"{}\"  ", tmp.display());
        std::env::set_var("WB_APP_ROOT", &quoted);
        assert_eq!(
            workbench_root_from_env(),
            Some(tmp.clone()),
            "应剥掉引号与首尾空白"
        );

        std::env::remove_var("WB_APP_ROOT");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// 单实例锁：同一个锁文件第二次取锁必须失败 —— 第二个实例就是靠这个退出的。
    #[test]
    fn single_instance_lock_is_exclusive() {
        let tmp = std::env::temp_dir().join(format!("wb-lock-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).expect("建临时目录失败");

        let (ok1, l1) = acquire_single_instance(&tmp);
        assert!(ok1, "第一个实例应该能拿到锁");
        let l1 = l1.expect("第一个实例应持有锁句柄");

        let (ok2, l2) = acquire_single_instance(&tmp);
        assert!(!ok2, "第二个实例不该拿到锁（否则单实例保护失效）");
        assert!(l2.is_none());

        drop(l1);
        let (ok3, l3) = acquire_single_instance(&tmp);
        assert!(ok3, "锁释放后应能重新拿到");
        drop(l3);

        let _ = std::fs::remove_dir_all(&tmp);
    }
}