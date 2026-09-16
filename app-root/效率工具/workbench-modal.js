// workbench-modal.js - 千牛采集宝工作台：通用确认弹窗模块（P2-1 拆模块第四步）
// 说明：本文件**不用 IIFE**（全局声明），workbench.html 加载顺序：
// db.js → utils → store → timeline → pomodoro → modal → workbench.js。
// showModal 被番茄钟/待办/名言/提醒轮询等多模块调用，必须为全局函数。
// 依赖：store（state/save）、pomodoro（pendingNext/renderTimer）。

// 通用提示弹窗（带唯一确认按钮）
function showModal(text) {
  document.getElementById('modal-text').textContent = text;
  document.getElementById('mask').classList.add('show');
}

// 确认按钮：关闭弹窗；若番茄钟处于"等待确认进入下一时段"，同时启动下一轮
document.getElementById('modal-ok').addEventListener('click', function () {
  document.getElementById('mask').classList.remove('show');
  if (pendingNext) {
    pendingNext = false;
    var t = state.timer;
    t.running = true;
    t.endTs = Date.now() + t.remaining * 1000;
    save();
    renderTimer();
  }
});
