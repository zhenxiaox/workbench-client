// workbench.js - 千牛采集宝工作台：主编排脚本（P2-1 拆模块第五步）
// 说明：本文件**不用 IIFE**（全局声明）。workbench.html 加载顺序（最后）：
// db.js → workbench-utils.js → workbench-store.js → workbench-timeline.js → workbench-pomodoro.js →
// workbench-modal.js → workbench-todos.js → workbench-quote.js → workbench.js。
// 各功能模块（待办/名言/番茄钟/时间线/弹窗）已拆至独立文件并暴露全局函数；
// 本文件只负责 render() 全局渲染编排、顶层按钮绑定、剩余弹窗关闭与初始化加载。
// 依赖：utils / store / timeline / pomodoro / modal / todos / quote 提供的全部全局函数。

// ========= 全局渲染编排 =========
function render() {
  document.getElementById('grid').innerHTML = todoCardHTML() + notesCardHTML() + modulesHTML() + addModHTML();
  bindNotesTextareas();
  bindModNameInputs();
  renderTodos();
  renderTimer();
  renderTimeline();
  updatePomoCatSelector();
}

// ========= 顶层按钮绑定 =========

// 使用说明
document.getElementById('btn-help').addEventListener('click', function () {
  window.open('/使用说明.txt', '_blank', 'noopener');
});

// 同步设置弹窗开关
document.getElementById('btn-sync-settings').addEventListener('click', function () {
  document.getElementById('sync-settings-mask').classList.add('show');
});
document.getElementById('btn-close-sync-settings').addEventListener('click', function () {
  document.getElementById('sync-settings-mask').classList.remove('show');
});
document.getElementById('sync-settings-mask').addEventListener('click', function (e) {
  if (e.target === this) this.classList.remove('show');
});

// 备份与导入弹窗开关
document.getElementById('btn-backup-import').addEventListener('click', function () {
  document.getElementById('backup-import-mask').classList.add('show');
});
document.getElementById('btn-close-backup-import').addEventListener('click', function () {
  document.getElementById('backup-import-mask').classList.remove('show');
});
document.getElementById('backup-import-mask').addEventListener('click', function (e) {
  if (e.target === this) this.classList.remove('show');
});

// 导出全量备份（四象限待办 + 便签 + 网址分类 + 番茄钟状态/配置 + 金句库 + 待办分类 + 时光轴）
document.getElementById('btn-export-data').addEventListener('click', function () {
  var data = JSON.stringify({
    app: '效率工具',
    version: 2,                       // 备份格式版本
    stateVersion: DATA_VERSION,       // 数据模型版本（与 IndexedDB 落盘一致）
    exportedAt: new Date().toISOString(),
    state: {
      modules: state.modules,
      notes: state.notes,
      timer: state.timer,
      todos: state.todos,
      quoteConfig: state.quoteConfig,
      pomoConfig: state.pomoConfig,
      pomoCat: state.pomoCat,
      cats: state.cats,
      timeline: state.timeline,
      moodLogs: state.moodLogs || []
    }
  }, null, 2);
  var blob = new Blob([data], { type: 'application/json' });
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = '效率工具-备份-' + new Date().toISOString().slice(0, 10) + '.json';
  document.body.appendChild(a);
  a.click();
  URL.revokeObjectURL(a.href);
  a.remove();
});

// 从备份恢复（兼容旧备份 version 1，并完整恢复所有模块字段）
document.getElementById('btn-import-data').addEventListener('click', function () {
  document.getElementById('import-file').click();
});
document.getElementById('import-file').addEventListener('change', function (e) {
  var f = e.target.files[0];
  if (!f) return;
  var reader = new FileReader();
  reader.onload = function () {
    try {
      var p = JSON.parse(reader.result);
      // 兼容旧备份（version 1：字段在顶层）与新备份（version 2：包在 state 内）
      var root = (p && p.state) ? p.state : p;
      if (!p || !root || !Array.isArray(root.modules) || !Array.isArray(root.notes)) throw new Error('bad');
      if (!confirm('导入将覆盖当前所有数据，确定继续吗？')) return;
      var def = defaultState();
      state = {
        modules: (root.modules || []).map(function (m) {
          return {
            id: m.id || uid(),
            name: String(m.name || '未命名'),
            links: (m.links || []).map(function (l) {
              return { id: l.id || uid(), label: String(l.label || l.url || ''), url: String(l.url || '') };
            })
          };
        }),
        notes: (root.notes || []).map(function (n) {
          return { id: n.id || uid(), text: String(n.text || ''), updatedAt: n.updatedAt || Date.now() };
        }),
        // 番茄钟计时状态：从备份恢复（旧备份无此字段则退回默认，避免丢失累计数据）
        timer: (root.timer && root.timer.mode) ? root.timer : def.timer,
        todos: (root.todos || []).map(function (x) {
          return {
            id: x.id || uid(),
            text: String(x.text || ''),
            quad: ['q1', 'q2', 'q3', 'q4'].indexOf(x.quad) !== -1 ? x.quad : 'q1',
            done: !!x.done,
            remindTime: x.remindTime ? Number(x.remindTime) : null,
            notified: !!x.notified,
            repeat: x.repeat || 'none',
            customRepeat: x.customRepeat || null,
            repeatEndType: x.repeatEndType || 'never',
            maxRepeatCount: x.maxRepeatCount || null,
            repeatEndDate: x.repeatEndDate || null,
            repeatCount: x.repeatCount || 0,
            estimatedHours: x.estimatedHours || 0,
            autoPromoted: !!x.autoPromoted,
            note: x.note || '',
            dueDate: x.dueDate || null,
            quadByDue: x.quadByDue || null
          };
        }),
        quoteConfig: (root.quoteConfig && root.quoteConfig.mode) ? root.quoteConfig : def.quoteConfig,
        // 番茄钟配置与分类：从备份恢复（旧备份无则退回默认）
        pomoConfig: (root.pomoConfig && root.pomoConfig.workMin) ? { workMin: root.pomoConfig.workMin, breakMin: root.pomoConfig.breakMin || def.pomoConfig.breakMin } : def.pomoConfig,
        pomoCat: typeof root.pomoCat === 'string' ? root.pomoCat : '',
        // 待办分类：从备份恢复（旧备份无则退回默认）
        cats: (root.cats && root.cats.length) ? root.cats.slice() : def.cats,
        // 时光轴：完整恢复每条记录的全部字段
        timeline: Array.isArray(root.timeline) ? root.timeline.map(function (t) {
          return {
            id: t.id || uid(),
            type: t.type,
            text: t.text,
            ts: t.ts,
            date: t.date,
            todoId: t.todoId || null,
            category: t.category || null,
            duration: t.duration || null,
            startTs: t.startTs || null
          };
        }) : [],
        // 心情记录：完整恢复每条记录的全部字段
        moodLogs: Array.isArray(root.moodLogs) ? root.moodLogs.map(function (m) {
          return {
            id: m.id || uid(),
            mood: m.mood,
            icon: m.icon,
            label: m.label,
            color: m.color || '#8B5CF6',
            text: m.text || '',
            ts: m.ts,
            date: m.date
          };
        }) : []
      };
      save(); render(); loadQuote(); syncQuoteUI();
      showModal('导入成功');
    } catch (err) {
      showModal('备份文件格式不正确');
    }
    e.target.value = '';
  };
  reader.readAsText(f, 'UTF-8');
});

// ========= 剩余弹窗：关闭逻辑 =========

// 四象限使用指南弹窗（打开由 workbench-todos.js 的 grid 委托处理）
var guideModal = document.getElementById('guide-modal-mask');
var btnCloseGuide = document.getElementById('btn-close-guide-modal');
var btnKnowGuide = document.getElementById('btn-know-guide');
function closeGuideModal() {
  if (guideModal) guideModal.classList.remove('show');
}
if (btnCloseGuide) btnCloseGuide.addEventListener('click', closeGuideModal);
if (btnKnowGuide) btnKnowGuide.addEventListener('click', closeGuideModal);
if (guideModal) {
  guideModal.addEventListener('click', function (e) {
    if (e.target === guideModal) closeGuideModal();
  });
}

// 番茄工作法指南弹窗
var pomoGuideModal = document.getElementById('pomo-guide-modal-mask');
var btnShowPomoGuide = document.getElementById('btn-show-pomo-guide');
var btnClosePomoGuide = document.getElementById('btn-close-pomo-modal');
var btnKnowPomoGuide = document.getElementById('btn-know-pomo-guide');
function closePomoGuideModal() {
  if (pomoGuideModal) pomoGuideModal.classList.remove('show');
}
if (btnShowPomoGuide) btnShowPomoGuide.addEventListener('click', function () {
  if (pomoGuideModal) pomoGuideModal.classList.add('show');
});
if (btnClosePomoGuide) btnClosePomoGuide.addEventListener('click', closePomoGuideModal);
if (btnKnowPomoGuide) btnKnowPomoGuide.addEventListener('click', closePomoGuideModal);
if (pomoGuideModal) {
  pomoGuideModal.addEventListener('click', function (e) {
    if (e.target === pomoGuideModal) closePomoGuideModal();
  });
}

// 柳比歇夫时间管理法说明弹窗
var lyuModal = document.getElementById('lyu-modal-mask');
var btnShowLyu = document.getElementById('tl-lyu-btn');
var btnCloseLyu = document.getElementById('btn-close-lyu-modal');
var btnKnowLyu = document.getElementById('btn-know-lyu');
function closeLyuModal() {
  if (lyuModal) lyuModal.classList.remove('show');
}
if (btnShowLyu) btnShowLyu.addEventListener('click', function () {
  if (lyuModal) lyuModal.classList.add('show');
});
if (btnCloseLyu) btnCloseLyu.addEventListener('click', closeLyuModal);
if (btnKnowLyu) btnKnowLyu.addEventListener('click', closeLyuModal);
if (lyuModal) {
  lyuModal.addEventListener('click', function (e) {
    if (e.target === lyuModal) closeLyuModal();
  });
}

// ========= 主题（light / dark / eye） =========
// 初始化与「跟随工作台主题」已由 <head> 内的引导脚本完成（避免首屏闪烁）。
// 这里只补：顶部按钮的手动切换（亮 ⇄ 暗），并写回本页记忆，不改工作台全局设置。
var themeToggleBtn = document.getElementById('btn-theme-toggle');
if (themeToggleBtn) {
  themeToggleBtn.addEventListener('click', function () {
    var cur = document.documentElement.getAttribute('data-theme');
    var next = (cur === 'dark') ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    document.body.classList.toggle('dark-mode', next === 'dark');
    document.body.classList.toggle('theme-bright', next === 'light');
    try { localStorage.setItem('theme', next); } catch (e) {}
  });
}

// ========= 初始化加载 =========
// 先以默认数据渲染一次：即使 IndexedDB 打开慢/挂起/被浏览器拦截，页面也绝不会空白。
try { state = defaultState(); } catch (e) {}
try { render(); } catch (e) { if (window.__wbShowFatal) window.__wbShowFatal('初始渲染失败：' + (e && e.message)); }

load().then(function (s) {
  try {
    state = s;
    if (!state.timeline) state.timeline = [];
    if (!state.moodLogs) state.moodLogs = [];
    if (!state.timer.statDate) state.timer.statDate = todayStr();
    if (state.timer.statDate !== todayStr()) {
      state.timer.statDate = todayStr();
      state.timer.totalCount = 0;
      state.timer.totalSec = 0;
      state.timer.count = 0;
      save(true);
    }
    if (state.timer.running && state.timer.endTs) {
      if (state.timer.endTs <= Date.now()) {
        state.timer.running = false;
        state.timer.endTs = null;
        state.timer.remaining = 0;
        state.timer.startTs = null;
        save(true);
      }
    }
    startTick();
    checkAutoPromoteTodos();
    updateTaskQuadrantByDueDate();
    render();
    syncQuoteUI();
    loadQuote();
    // 心情记录栏交互初始化
    if (typeof initMoodTracker === 'function') initMoodTracker();
    // IndexedDB 单文件实时镜像同步：初始化控件、启动自动调度、冷启动合并
    if (typeof initIDBSyncUI === 'function') initIDBSyncUI();
    if (typeof startMirrorAutoSync === 'function') startMirrorAutoSync();
    if (typeof checkAndAutoMirrorSync === 'function') checkAndAutoMirrorSync();
  } catch (err) {
    if (window.__wbShowFatal) window.__wbShowFatal('渲染失败：' + (err && err.message));
  }
}).catch(function (err) {
  if (window.__wbShowFatal) window.__wbShowFatal('数据加载失败：' + (err && err.message));
});
