// workbench-utils.js - 千牛采集宝工作台：常量 + 纯工具函数（P2-1 拆模块第一步）
// 注意：本文件**不用 IIFE 包裹**，函数/常量以全局形式声明（workbench.html 中先于 workbench.js 加载），
// workbench.js 的 IIFE 通过自由变量解析直接引用，无需改动内部调用。
// 这些函数均为纯函数（零闭包依赖、零 DOM），抽离后 workbench.js 保持行为不变。

// ========= 常量 =========
var DATA_VERSION = 2;
var WORK_SEC = 25 * 60;
var REST_SEC = 5 * 60;
var DEFAULT_CATS = ['专注', '沟通', '学习', '办公', '生活', '休息'];

// ========= 纯工具函数 =========

// 生成唯一 ID
function uid() {
  return 'id_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// HTML 转义（防 XSS）
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

// 提取域名（去 www 前缀）
function hostOf(u) {
  try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return u; }
}

// 秒 → mm:ss
function fmtClock(sec) {
  sec = Math.max(0, Math.floor(sec));
  return ('0' + Math.floor(sec / 60)).slice(-2) + ':' + ('0' + (sec % 60)).slice(-2);
}

// 时间戳 → HH:MM
function fmtTime(ts) {
  if (!ts) return '未保存';
  var d = new Date(ts);
  return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
}

// 今天 → YYYY-MM-DD
function todayStr() {
  var d = new Date();
  return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
}

// 补零
function pad2(n) { return ('0' + n).slice(-2); }

// 日期 → YYYY-MM-DD（月从 0 开始）
function dateStr(y, m, d) { return y + '-' + pad2(m + 1) + '-' + pad2(d); }

// URL 规范化（无协议时补 https://）
function normalizeUrl(v) {
  v = v.trim();
  if (!v) return v;
  if (!/^https?:\/\//i.test(v)) return 'https://' + v;
  return v;
}
