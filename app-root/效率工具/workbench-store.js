// workbench-store.js - 千牛采集宝工作台：全局状态 + 数据层（P2-1 拆模块第二步）
// 说明：本文件**不用 IIFE**，`state`/`saveTimer` 以全局 var 声明。
// workbench.html 加载顺序：db.js → workbench-utils.js → workbench-store.js → workbench.js。
// workbench.js 的 IIFE 内已删除同名声明，通过自由变量解析共享同一个全局 state，行为零变化。

// ========= 全局状态（唯一数据源，各功能模块共享） =========
var state = null;       // 工作台全部数据（modules/notes/timer/todos/quoteConfig/pomoConfig/cats/timeline）
var saveTimer = null;   // 保存提示防抖计时器

// ========= 数据层 =========

// ========= 状态归一化（防脏数据导致渲染崩溃 / 空白） =========
// 任何来源的 state（IndexedDB 旧数据 / 采集宝同库数据 / 旧版本备份）只要字段缺失或类型漂移，
// 都在此统一补齐为合法结构，保证 render() 永不因 undefined 字段而抛错（此前 m.links 缺失会直接空白）。
function normState(s) {
  var def = defaultState();
  if (!s || typeof s !== 'object') s = def;
  s.modules = Array.isArray(s.modules)
    ? s.modules.map(function (m) {
        m = m || {};
        return {
          id: m.id || uid(),
          name: String(m.name || '未命名'),
          links: Array.isArray(m.links)
            ? m.links.map(function (l) {
                l = l || {};
                return { id: l.id || uid(), label: String(l.label || l.url || ''), url: String(l.url || '') };
              })
            : []
        };
      })
    : def.modules;
  s.notes = Array.isArray(s.notes)
    ? s.notes.map(function (n) {
        n = n || {};
        return { id: n.id || uid(), text: String(n.text || ''), updatedAt: n.updatedAt || Date.now() };
      })
    : def.notes;
  s.todos = Array.isArray(s.todos)
    ? s.todos.map(function (x) {
        x = x || {};
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
      })
    : def.todos;
  s.timer = (s.timer && typeof s.timer === 'object') ? Object.assign({}, def.timer, s.timer) : def.timer;
  if (typeof s.timer.statDate !== 'string') s.timer.statDate = todayStr();
  s.quoteConfig = (s.quoteConfig && s.quoteConfig.mode) ? s.quoteConfig : def.quoteConfig;
  s.pomoConfig = (s.pomoConfig && s.pomoConfig.workMin) ? { workMin: s.pomoConfig.workMin, breakMin: s.pomoConfig.breakMin || 5 } : def.pomoConfig;
  s.pomoCat = typeof s.pomoCat === 'string' ? s.pomoCat : '';
  s.cats = (Array.isArray(s.cats) && s.cats.length) ? s.cats.slice() : def.cats;
  s.timeline = Array.isArray(s.timeline) ? s.timeline : [];
  s.moodLogs = Array.isArray(s.moodLogs) ? s.moodLogs : [];
  return s;
}

// 从 IndexedDB 加载工作台状态（带版本校验与字段兜底迁移）
function load() {
  return getAllFromDB('workbench').then(function (rows) {
    var rec = (rows || []).filter(function (r) { return r.key === 'state'; })[0];
    if (rec && rec.v === DATA_VERSION && Array.isArray(rec.modules) && Array.isArray(rec.notes) && rec.timer) {
      return normState({
        modules: rec.modules,
        notes: rec.notes,
        timer: rec.timer,
        todos: rec.todos,
        quoteConfig: rec.quoteConfig,
        pomoConfig: rec.pomoConfig,
        pomoCat: rec.pomoCat,
        cats: rec.cats,
        timeline: rec.timeline,
        moodLogs: rec.moodLogs
      });
    }
    return normState(defaultState());
  }).catch(function () {
    return normState(defaultState());
  });
}

// 默认初始状态
function defaultState() {
  return {
    modules: [
      {
        id: uid(),
        name: '常用网址',
        links: [
          { id: uid(), label: '评价管理', url: 'https://myseller.taobao.com/home.htm/comment-manage/list/' },
          { id: uid(), label: '聊天记录导出', url: 'https://market.m.taobao.com/app/qn/im-history-search/index.html' }
        ]
      }
    ],
    notes: [
      { id: uid(), text: '欢迎使用工作台！开启右上方“管理模式”可删除分类或链接。', updatedAt: Date.now() }
    ],
    timer: { mode: 'work', remaining: WORK_SEC, running: false, endTs: null, startTs: null, count: 0, totalCount: 0, totalSec: 0, statDate: todayStr() },
    todos: [
      { id: uid(), text: '完成本周核心业务需求', quad: 'q1', done: false },
      { id: uid(), text: '制定下月技术优化计划', quad: 'q2', done: false },
      { id: uid(), text: '回复日常非紧急邮件', quad: 'q3', done: false },
      { id: uid(), text: '整理桌面与临时下载文件', quad: 'q4', done: false }
    ],
    quoteConfig: {
      mode: 'api',
      apiUrl: 'https://v1.hitokoto.cn/?c=i',
      customList: [
        { id: uid(), text: '行动是治愈恐惧的良药，拖延只会滋养恐惧。', from: '励志格言' },
        { id: uid(), text: '种一棵树最好的时间是十年前，其次就是现在。', from: '谚语' }
      ]
    },
    pomoConfig: { workMin: 25, breakMin: 5 },
    pomoCat: '',
    cats: DEFAULT_CATS.slice(),
    timeline: [],
    moodLogs: []
  };
}

// 全局唯一持久化入口（各功能块共用）
function save(quiet) {
  try {
    saveItemsToDB('workbench', [{ key: 'state', v: DATA_VERSION, modules: state.modules, notes: state.notes, timer: state.timer, todos: state.todos, quoteConfig: state.quoteConfig, pomoConfig: state.pomoConfig, pomoCat: state.pomoCat, cats: state.cats, timeline: state.timeline, moodLogs: state.moodLogs || [], savedAt: Date.now() }]).then(function () {
      flashSave(quiet);
    }).catch(function () {});
  } catch (e) {}
  syncTodoReminders();
}

// 把未完成且设了提醒时间的待办同步到 chrome.storage.local，
// 供 background service worker 在页面关闭时也能触发系统通知（P1-3）
function syncTodoReminders() {
  if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return;
  var list = (state.todos || [])
    .filter(function (t) { return t && t.remindTime && !t.done; })
    .map(function (t) {
      return { id: t.id, text: t.text, remindTime: Number(t.remindTime), done: !!t.done, notified: !!t.notified };
    });
  chrome.storage.local.set({ qn_todoReminders: list });
}

// 保存成功提示（防抖 1.6s 自动消失）
function flashSave(quiet) {
  if (quiet) return;
  var hint = document.getElementById('save-hint');
  if (!hint) return;
  var t = new Date();
  hint.textContent = '已自动保存 ' + ('0' + t.getHours()).slice(-2) + ':' + ('0' + t.getMinutes()).slice(-2) + ':' + ('0' + t.getSeconds()).slice(-2);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(function () { hint.textContent = ''; }, 1600);
}
