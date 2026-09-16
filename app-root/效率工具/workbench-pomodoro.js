// workbench-pomodoro.js - 千牛采集宝工作台：番茄钟模块（P2-1 拆模块第四步）
// 说明：本文件**不用 IIFE**（全局声明），workbench.html 加载顺序：
// db.js → utils → store → timeline → workbench-pomodoro.js → workbench.js。
// 依赖：utils（fmtClock/todayStr/esc）、store（state/save/defaultState）、timeline（addTimeline）、
//       workbench.js（showModal 通用弹窗，后续随"名言+通用弹窗"模块拆出）。

// ========= 番茄钟模块状态（全局，workbench.js 内 modal-ok 亦引用 pendingNext） =========
var timerIntv = null;    // 计时器句柄
var pendingNext = false; // 是否等待用户确认进入下一时段

// ========= 番茄钟函数 =========

// 某模式总时长（秒）：work 用 pomoConfig.workMin，rest 用 breakMin
function fullSec(mode) {
  var c = (state && state.pomoConfig) || defaultState().pomoConfig;
  return mode === 'rest' ? (c.breakMin || REST_SEC / 60) * 60 : (c.workMin || WORK_SEC / 60) * 60;
}

function renderTimer() {
  var t = state.timer;
  var today = todayStr();
  if (t.statDate !== today) {
    t.statDate = today;
    t.totalCount = 0;
    t.totalSec = 0;
    t.count = 0;
    save(true);
  }
  var modeEl = document.getElementById('timer-mode');
  var mode = t.mode === 'rest' ? '休息中' : '专注中';
  modeEl.textContent = mode;
  if (t.mode === 'rest') {
    modeEl.style.color = '#7C3AED';
    modeEl.style.background = '#f5f0ff';
  } else {
    modeEl.style.color = '#4A90E2';
    modeEl.style.background = '#eef5fe';
  }
  document.getElementById('timer-time').textContent = fmtClock(t.remaining);
  document.getElementById('timer-fill').style.width =
    Math.min(100, Math.round((fullSec(t.mode) - t.remaining) / fullSec(t.mode) * 100)) + '%';
  var tog = document.getElementById('tog');
  tog.innerHTML = t.running ? '<i class="ti ti-player-pause"></i>暂停' : '<i class="ti ti-player-play"></i>开始';
  var roundEl = document.getElementById('pomo-round');
  var totalEl = document.getElementById('pomo-total');
  if (roundEl) roundEl.textContent = t.mode === 'rest'
    ? '休息中'
    : '第 ' + Math.min(t.count + 1, 4) + '/4 轮';
  if (totalEl) {
    var mins = Math.round((t.totalSec || 0) / 60);
    totalEl.textContent = '今日累计 ' + (t.totalCount || 0) + ' 次 · ' + mins + ' 分钟';
  }
}

function startTick() {
  if (timerIntv) clearInterval(timerIntv);
  timerIntv = setInterval(function () {
    var t = state.timer;
    if (!t.running || !t.endTs) return;
    var rem = Math.max(0, Math.floor((t.endTs - Date.now()) / 1000));
    if (rem !== t.remaining) {
      t.remaining = rem;
      if (rem === 0) {
        t.running = false;
        t.endTs = null;
        chime();
        complete();
      }
      save(true);
      renderTimer();
    }
  }, 500);
}

// ========= 番茄钟事件绑定 =========

document.getElementById('tog').addEventListener('click', function () {
  var t = state.timer;
  if (t.running) {
    t.running = false;
    t.endTs = null;
    if (t.mode === 'work') t.startTs = null;
  } else {
    if (t.remaining <= 0) t.remaining = fullSec(t.mode);
    t.running = true;
    t.endTs = Date.now() + t.remaining * 1000;
    if (t.mode === 'work' && !t.startTs) t.startTs = Date.now();
    else if (t.mode !== 'work') t.startTs = null;
  }
  save(); renderTimer();
});

document.getElementById('reset').addEventListener('click', function () {
  var t = state.timer;
  pendingNext = false;
  t.count = 0;
  t.running = false;
  t.endTs = null;
  t.startTs = null;
  t.mode = 'work';
  t.remaining = fullSec(t.mode);
  save(); renderTimer();
});

// 一轮专注/休息完成（到点由 startTick 触发）
function complete() {
  var t = state.timer;
  var c = state.pomoConfig || defaultState().pomoConfig;
  var workMin = c.workMin || 25;
  var breakMin = c.breakMin || 5;
  if (t.mode === 'work') {
    t.count = (t.count || 0) + 1;
    t.totalCount = (t.totalCount || 0) + 1;
    t.totalSec = (t.totalSec || 0) + workMin * 60;
    var cat = state.pomoCat || '专注';
    var extra = {
      category: cat,
      startTs: t.startTs || (Date.now() - workMin * 60 * 1000),
      duration: workMin
    };
    t.startTs = null;
    addTimeline('focus', '完成 1 轮专注（' + workMin + ' 分钟）· ' + cat, null, extra);
    if (t.count >= 4) {
      t.count = 0;
      t.mode = 'rest';
      t.remaining = fullSec('rest');
      pendingNext = true;
      showModal('已完成 4 组专注，下一时段：休息（' + breakMin + ' 分钟）');
    } else {
      t.mode = 'rest';
      t.remaining = fullSec('rest');
      pendingNext = true;
      showModal('专注结束（第 ' + t.count + '/4 组完成），下一时段：休息（' + breakMin + ' 分钟）');
    }
  } else {
    addTimeline('focus', '完成 1 轮休息（' + breakMin + ' 分钟）', null, {
      category: '休息',
      startTs: Date.now() - breakMin * 60 * 1000,
      duration: breakMin
    });
    t.mode = 'work';
    t.remaining = fullSec('work');
    pendingNext = true;
    showModal('休息结束，下一时段：专注（' + workMin + ' 分钟）');
  }
  renderTimer();
  save();
}

// 提示音（Web Audio 三连音）
function chime() {
  try {
    var ac = new (window.AudioContext || window.webkitAudioContext)();
    [0, 0.28, 0.56].forEach(function (d, i) {
      var o = ac.createOscillator();
      var g = ac.createGain();
      o.type = 'sine';
      o.frequency.value = i === 2 ? 1320 : 880;
      o.connect(g);
      g.connect(ac.destination);
      var t = ac.currentTime + d;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.4, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
      o.start(t);
      o.stop(t + 0.32);
    });
  } catch (e) {}
}

// ========= 番茄钟分类选择器 =========
function updatePomoCatSelector() {
  var selector = document.getElementById('pomo-cat');
  if (!selector) return;
  var currentVal = selector.value || state.pomoCat || '';
  var optionsHTML = '<option value="">-- 选择分类 (可选) --</option>';
  (state.cats || []).forEach(function (c) {
    optionsHTML += '<option value="' + esc(c) + '">' + esc(c) + '</option>';
  });
  selector.innerHTML = optionsHTML;
  if ((state.cats || []).indexOf(currentVal) !== -1) {
    selector.value = currentVal;
  } else {
    state.pomoCat = '';
  }
}
document.getElementById('pomo-cat').addEventListener('change', function (e) {
  state.pomoCat = e.target.value || '';
  save();
});
document.getElementById('pomo-cat').addEventListener('focus', function () {
  updatePomoCatSelector();
});

// ========= 番茄钟设置弹窗 =========
var pomoSettingsMask = document.getElementById('pomo-settings-modal-mask');
function openPomoSettings() {
  var c = state.pomoConfig || defaultState().pomoConfig;
  document.getElementById('pomo-set-work').value = c.workMin;
  document.getElementById('pomo-set-break').value = c.breakMin;
  if (pomoSettingsMask) pomoSettingsMask.classList.add('show');
}
function closePomoSettings() {
  if (pomoSettingsMask) pomoSettingsMask.classList.remove('show');
}
document.getElementById('btn-open-pomo-settings').addEventListener('click', openPomoSettings);
document.getElementById('btn-close-pomo-settings').addEventListener('click', closePomoSettings);
document.getElementById('btn-cancel-pomo-settings').addEventListener('click', closePomoSettings);
if (pomoSettingsMask) {
  pomoSettingsMask.addEventListener('click', function (e) {
    if (e.target === pomoSettingsMask) closePomoSettings();
  });
}
document.getElementById('btn-save-pomo-settings').addEventListener('click', function () {
  var work = parseInt(document.getElementById('pomo-set-work').value, 10) || 25;
  var brk = parseInt(document.getElementById('pomo-set-break').value, 10) || 5;
  work = Math.max(1, Math.min(120, work));
  brk = Math.max(1, Math.min(60, brk));
  state.pomoConfig = { workMin: work, breakMin: brk };
  save();
  var t = state.timer;
  if (!t.running && !pendingNext) {
    t.mode = 'work';
    t.remaining = fullSec('work');
    renderTimer();
  }
  closePomoSettings();
  showModal('已保存：专注 ' + work + ' 分钟 / 休息 ' + brk + ' 分钟');
});
