// 发布模式下不弹出控制台黑窗口（仅 Windows 生效）
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    workbench_client_lib::run()
}