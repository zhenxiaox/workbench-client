// workbench-timeline.js - 千牛采集宝工作台：时间线/时光轴模块（P2-1 拆模块第三步）
// 说明：本文件**不用 IIFE**（全局声明），workbench.html 加载顺序：
// db.js → workbench-utils.js → workbench-store.js → workbench-timeline.js → workbench.js。
// 依赖：utils（uid/esc/todayStr/pad2/dateStr）、store（state/save）、db.js（getAllFromDB 等）。

// ========= 时间线模块状态 =========
var tlDateSet = new Set();
var tlCalendarOpen = false;
var calYear = 0;
var calMonth = 0;
var tlFlashTimer = null;

// ========= 心情记录（Mood Tracker） =========
// 5 个预设心情，统一使用 Tabler Icons（<i class="ti ti-..."> 字体图标，非 Emoji），
// 每个心情带专属色调，用于时光轴节点的轻量背景色块与图标着色。
var MOODS = [
  { key: 'great',     icon: 'mood-smile-beam', label: '极佳/高效', color: '#22c55e' },
  { key: 'calm',      icon: 'mood-smile',      label: '平静/正常', color: '#3b82f6' },
  { key: 'energetic', icon: 'flame',           label: '充满干劲', color: '#f97316' },
  { key: 'tired',     icon: 'mood-sad',        label: '疲惫/劳累', color: '#a855f7' },
  { key: 'anxious',   icon: 'mood-empty',      label: '焦虑/低谷', color: '#ef4444' }
];
var _moodSelected = null; // 当前选中的心情 key（用于“选图标 + 填文字”保存流程）

function moodByKey(key) {
  for (var i = 0; i < MOODS.length; i++) if (MOODS[i].key === key) return MOODS[i];
  return null;
}

// #rrggbb -> rgba()，用于心情节点轻量背景色块（带透明度）
function hexToRgba(hex, a) {
  var h = (hex || '#888888').replace('#', '');
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  var r = parseInt(h.slice(0, 2), 16) || 0;
  var g = parseInt(h.slice(2, 4), 16) || 0;
  var b = parseInt(h.slice(4, 6), 16) || 0;
  return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
}

// 保存一条心情记录：写入 state.moodLogs，并顺势接入后台静默镜像同步 / 关页兜底
function saveMood(moodKey, text) {
  var m = moodByKey(moodKey);
  if (!m) return;
  if (!state.moodLogs) state.moodLogs = [];
  var rec = {
    id: uid(),
    mood: m.key,
    icon: m.icon,
    label: m.label,
    color: m.color,
    text: text || '',
    ts: Date.now(),
    date: todayStr()
  };
  state.moodLogs.push(rec);
  save(true);              // 持久化到 IndexedDB workbench 表
  renderTimeline();        // 重渲染时光轴（心情节点按时序并入）
  requestMoodMirror();     // 立即触发后台静默镜像（5 分钟定时 / beforeunload 还会兜底）
  if (window.QNLogger) QNLogger.info('[心情记录] 已保存：' + m.label + (text ? ' · ' + text : '（无文字）'));
}

// 防抖触发镜像同步：把心情数据写入后台沙盒（轨道 A）与关页物理文件（轨道 B 自动覆盖）
var _moodMirrorTimer = null;
function requestMoodMirror() {
  if (typeof syncMirrorSilent !== 'function') return;
  if (_moodMirrorTimer) clearTimeout(_moodMirrorTimer);
  _moodMirrorTimer = setTimeout(function () {
    _moodMirrorTimer = null;
    try { syncMirrorSilent().catch(function () {}); } catch (e) {}
  }, 1200);
}

// 初始化心情记录栏交互
function initMoodTracker() {
  var iconsWrap = document.getElementById('mood-icons');
  if (!iconsWrap) return;
  var btns = iconsWrap.querySelectorAll('.mood-btn');
  var input = document.getElementById('mood-text');
  var saveBtn = document.getElementById('mood-save');

  function clearSelection() {
    _moodSelected = null;
    for (var j = 0; j < btns.length; j++) btns[j].classList.remove('active');
  }
  function selectMood(key, btn) {
    _moodSelected = key;
    clearSelection();
    _moodSelected = key;
    if (btn) btn.classList.add('active');
  }

  for (var i = 0; i < btns.length; i++) {
    btns[i].addEventListener('click', (function (btn) {
      return function () {
        var key = btn.getAttribute('data-mood');
        selectMood(key, btn);
        var txt = input ? input.value.trim() : '';
        if (txt === '') {
          // 仅点击图标：直接保存（无需文字）——满足“仅点 Mood 图标直接保存”
          saveMood(key, '');
          if (input) input.value = '';
          clearSelection();
        }
        // 已填文字：保持选中，等待点“保存”按钮（满足“选图标 + 填文字 保存”）
      };
    })(btns[i]));
  }

  if (saveBtn) saveBtn.addEventListener('click', function () {
    if (!_moodSelected) { toast('请先选择一个心情图标'); return; }
    var txt = input ? input.value.trim() : '';
    saveMood(_moodSelected, txt);
    if (input) input.value = '';
    clearSelection();
  });

  if (input) input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (_moodSelected) { if (saveBtn) saveBtn.click(); }
      else { toast('请先选择一个心情图标'); }
    }
  });
}

// ========= 时间线函数 =========

function monthHasData(y, m) {
  var last = new Date(y, m + 1, 0).getDate();
  for (var d = 1; d <= last; d++) {
    if (tlDateSet.has(dateStr(y, m, d))) return true;
  }
  return false;
}

function normalizedCalDate() {
  var now = new Date();
  var y = now.getFullYear(), m = now.getMonth();
  if (!monthHasData(y, m)) {
    var dates = Array.from(tlDateSet).sort().reverse();
    if (dates.length) {
      var last = new Date(dates[0]);
      y = last.getFullYear(); m = last.getMonth();
    }
  }
  return { y: y, m: m };
}

function renderCalendar(year, month) {
  var cal = document.getElementById('tl-calendar');
  if (!cal) return;
  var first = new Date(year, month, 1).getDay();
  var lead = (first + 6) % 7;
  var days = new Date(year, month + 1, 0).getDate();
  var html = '<div class="tl-cal-head">' +
    '<button type="button" class="tl-cal-nav" data-nav="-1" title="上月"><i class="ti ti-chevron-left"></i></button>' +
    '<span class="tl-cal-title">' + year + '年 ' + pad2(month + 1) + ' 月</span>' +
    '<button type="button" class="tl-cal-nav" data-nav="1" title="下月"><i class="ti ti-chevron-right"></i></button>' +
    '</div>';
  html += '<div class="tl-cal-grid">';
  var week = ['一', '二', '三', '四', '五', '六', '日'];
  for (var wi = 0; wi < 7; wi++) html += '<div class="tl-cal-week">' + week[wi] + '</div>';
  var now = new Date();
  for (var i = 0; i < lead; i++) html += '<div class="tl-cal-cell empty"></div>';
  for (var d = 1; d <= days; d++) {
    var ds = dateStr(year, month, d);
    var cls = 'tl-cal-cell';
    if (tlDateSet.has(ds)) cls += ' has-data';
    if (year === now.getFullYear() && month === now.getMonth() && d === now.getDate()) cls += ' today';
    html += '<div class="' + cls + '" data-date="' + ds + '">' + d + '</div>';
  }
  html += '</div>';
  cal.innerHTML = html;
}

function openTlCalendar() {
  var cal = document.getElementById('tl-calendar');
  if (!cal) return;
  var n = normalizedCalDate();
  calYear = n.y; calMonth = n.m;
  renderCalendar(calYear, calMonth);
  cal.classList.add('show');
  tlCalendarOpen = true;
}

function closeTlCalendar() {
  var cal = document.getElementById('tl-calendar');
  if (!cal) return;
  cal.classList.remove('show');
  tlCalendarOpen = false;
}

function jumpToDate(dateStr) {
  closeTlCalendar();
  var list = document.getElementById('timeline-list');
  var target = list.querySelector('.tl-group[data-date="' + dateStr + '"]');
  if (!target) return;
  var ctop = target.getBoundingClientRect().top;
  var stop = list.getBoundingClientRect().top;
  var top = (ctop - stop) + list.scrollTop - 8;
  list.scrollTo({ top: top, behavior: 'smooth' });
  if (tlFlashTimer) clearTimeout(tlFlashTimer);
  target.classList.remove('tl-flash');
  void target.offsetHeight;
  target.classList.add('tl-flash');
  tlFlashTimer = setTimeout(function () { target.classList.remove('tl-flash'); tlFlashTimer = null; }, 1200);
}

// 新增时间线记录（番茄钟完成 / 待办完成 / 手动记录共用）
function addTimeline(type, text, refId, extra) {
  if (!state.timeline) state.timeline = [];
  var rec = { id: uid(), type: type, text: text, ts: Date.now(), date: todayStr() };
  if (refId) rec.todoId = refId;
  if (extra) {
    if (extra.category) rec.category = extra.category;
    if (extra.duration) rec.duration = extra.duration;
    if (extra.startTs) rec.startTs = extra.startTs;
  }
  state.timeline.push(rec);
  save(true);
  renderTimeline();
}

// 删除某待办关联的时间线记录（取消勾选时）
function removeTodoTimeline(todoId) {
  if (!todoId) return;
  var before = state.timeline ? state.timeline.length : 0;
  state.timeline = (state.timeline || []).filter(function (x) { return !(x.type === 'todo' && x.todoId === todoId); });
  if (before !== state.timeline.length) {
    save(true);
    renderTimeline();
  }
}

function renderTodaySummary() {
  var el = document.getElementById('today-summary');
  if (!el) return;
  var today = todayStr();
  var sum = {};
  (state.timeline || []).forEach(function (it) {
    if (it.date !== today || !it.duration) return;
    var cat = it.category || '专注';
    sum[cat] = (sum[cat] || 0) + it.duration;
  });
  var cats = Object.keys(sum);
  if (!cats.length) {
    el.innerHTML = '<span class="ts-label"><i class="ti ti-chart-pie"></i>今日时间统计</span><span class="ts-empty">暂无记录，完成专注后自动盘点</span>';
    return;
  }
  var html = '<span class="ts-label"><i class="ti ti-chart-pie"></i>今日时间统计</span>';
  cats.forEach(function (cat) {
    var total = sum[cat];
    var hh = Math.floor(total / 60);
    var mm = total % 60;
    var disp = (hh > 0 ? hh + 'h' : '') + mm + 'm';
    html += '<span class="ts-item"><span class="ts-cat">' + esc(cat) + '</span><span class="ts-amt">' + disp + '</span></span>';
  });
  el.innerHTML = html;
}

function renderTimeline() {
  renderTodaySummary();
  var el = document.getElementById('timeline-list');
  if (!el) return;
  // 合并「专注/待办时间线」与「心情记录」，统一按时间倒序、按日期分组
  var merged = [];
  (state.timeline || []).forEach(function (it) { merged.push({ kind: 'tl', it: it }); });
  (state.moodLogs || []).forEach(function (m) { merged.push({ kind: 'mood', m: m }); });
  merged.sort(function (a, b) {
    var ta = a.kind === 'tl' ? a.it.ts : a.m.ts;
    var tb = b.kind === 'tl' ? b.it.ts : b.m.ts;
    return tb - ta;
  });
  if (!merged.length) {
    el.innerHTML = '<div class="empty">暂无活动记录<br>完成专注 / 待办，或点击「+」手动记录时间块</div>';
    return;
  }
  var groups = {};
  merged.forEach(function (rec) {
    var d = rec.kind === 'tl' ? rec.it.date : rec.m.date;
    (groups[d] = groups[d] || []).push(rec);
  });
  el.innerHTML = Object.keys(groups).sort().reverse().map(function (date) {
    var list = groups[date].map(function (rec) {
      if (rec.kind === 'tl') {
        var it = rec.it;
        var d = new Date(it.ts);
        var hh = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
        var cls = it.type === 'focus' ? 'tl-focus' : 'tl-todo';
        var iconHtml = it.type === 'focus'
          ? '<img class="tl-focus-icon" src="icons/tomato_timer.svg" alt="">'
          : '<i class="ti ti-check"></i>';
        return '<div class="tl-item ' + cls + '">' +
          '<span class="tl-time">' + hh + '</span>' +
          '<span class="tl-text">' + iconHtml + esc(it.text) + '</span>' +
          (it.duration ? '<span class="tl-dur">' + it.duration + 'min</span>' : '') +
          '<button class="tl-del" data-act="del-timeline" data-id="' + esc(it.id) + '" title="删除"><i class="ti ti-x"></i></button>' +
        '</div>';
      }
      // 心情节点：Tabler Mood 图标 + 按心情微调的轻量背景色块
      var m = rec.m;
      var d = new Date(m.ts);
      var hh = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
      var c = m.color || '#8B5CF6';
      var inlineStyle = '--mood-c:' + esc(c) + ';background:' + hexToRgba(c, 0.10) + ';border-left:3px solid ' + esc(c) + ';padding-left:8px;border-radius:0 6px 6px 0;';
      var textHtml = m.text
        ? '<span class="tl-mood-text">' + esc(m.text) + '</span>'
        : '<span class="tl-mood-label">' + esc(m.label) + '</span>';
      return '<div class="tl-item tl-mood" style="' + inlineStyle + '">' +
        '<span class="tl-time">' + hh + '</span>' +
        '<span class="tl-text"><i class="ti ti-' + esc(m.icon) + '"></i>' + textHtml + '</span>' +
        '<button class="tl-del" data-act="del-mood" data-id="' + esc(m.id) + '" title="删除心情"><i class="ti ti-trash"></i></button>' +
      '</div>';
    }).join('');
    return '<div class="tl-group" data-date="' + esc(date) + '"><h4><i class="ti ti-calendar-event"></i>' + esc(date) + '</h4><div class="tl-items">' + list + '</div></div>';
  }).join('');
  tlDateSet = new Set(merged.map(function (rec) { return rec.kind === 'tl' ? rec.it.date : rec.m.date; }));
  if (tlCalendarOpen) renderCalendar(calYear, calMonth);
}

// ========= 时间线事件绑定（页面加载时执行，DOM 就绪） =========

// 滚动防抖（高亮 class 临时移除）
(function () {
  var list = document.getElementById('timeline-list');
  var scrollTimer = null;
  if (!list) return;
  list.addEventListener('scroll', function () {
    list.classList.add('scrolling');
    if (scrollTimer) clearTimeout(scrollTimer);
    scrollTimer = setTimeout(function () { list.classList.remove('scrolling'); }, 300);
  });
})();

// 日历开合 + 翻月 + 日期跳转
var tlCalBtn = document.getElementById('tl-cal-btn');
if (tlCalBtn) tlCalBtn.addEventListener('click', function (e) {
  e.stopPropagation();
  if (tlCalendarOpen) closeTlCalendar();
  else openTlCalendar();
});
var tlCal = document.getElementById('tl-calendar');
if (tlCal) tlCal.addEventListener('click', function (e) {
  e.stopPropagation();
  var nav = e.target.closest('.tl-cal-nav');
  if (nav) {
    calMonth += parseInt(nav.dataset.nav, 10);
    if (calMonth < 0) { calMonth = 11; calYear--; }
    else if (calMonth > 11) { calMonth = 0; calYear++; }
    renderCalendar(calYear, calMonth);
    return;
  }
  var cell = e.target.closest('.tl-cal-cell');
  if (!cell || cell.classList.contains('empty')) return;
  if (!tlDateSet.has(cell.dataset.date)) {
    cell.classList.remove('no-data');
    void cell.offsetHeight;
    cell.classList.add('no-data');
    return;
  }
  jumpToDate(cell.dataset.date);
});
document.addEventListener('click', function (e) {
  if (!tlCalendarOpen) return;
  if (e.target.closest('.timeline-card')) return;
  closeTlCalendar();
});

// 手动增加时间块弹窗
var tlAddMask = document.getElementById('tl-add-modal-mask');
function fillCatSelect(sel) {
  var options = (state.cats || []).map(function (c) {
    return '<option value="' + esc(c) + '">' + esc(c) + '</option>';
  }).join('');
  sel.innerHTML = options || '<option value="">无分类</option>';
}
document.getElementById('tl-add-btn').addEventListener('click', function () {
  fillCatSelect(document.getElementById('tl-add-cat'));
  document.getElementById('tl-add-min').value = '25';
  tlAddMask.classList.add('show');
});
function closeTlAdd() { tlAddMask.classList.remove('show'); }
document.getElementById('btn-close-tl-add-modal').addEventListener('click', closeTlAdd);
document.getElementById('btn-cancel-tl-add').addEventListener('click', closeTlAdd);
tlAddMask.addEventListener('click', function (e) {
  if (e.target === tlAddMask) closeTlAdd();
});
document.getElementById('btn-save-tl-add').addEventListener('click', function () {
  var cat = document.getElementById('tl-add-cat').value;
  var mins = parseInt(document.getElementById('tl-add-min').value, 10);
  if (!cat) { alert('请选择分类'); return; }
  if (!mins || mins <= 0) { alert('请输入有效的时长（分钟）'); return; }
  addTimeline('focus', '手动记录：' + cat + ' ' + mins + ' 分钟', null, { category: cat, duration: mins, startTs: Date.now() });
  closeTlAdd();
});

// 删除某条记录（卡片上的删除按钮）：时间线记录 / 心情记录
document.getElementById('timeline-list').addEventListener('click', function (e) {
  var btn = e.target.closest('[data-act="del-timeline"]');
  if (btn) {
    state.timeline = (state.timeline || []).filter(function (x) { return x.id !== btn.dataset.id; });
    save(true);
    renderTimeline();
    return;
  }
  var mbtn = e.target.closest('[data-act="del-mood"]');
  if (mbtn) {
    if (!window.confirm('确定删除这条心情记录吗？')) return;
    state.moodLogs = (state.moodLogs || []).filter(function (x) { return x.id !== mbtn.dataset.id; });
    save(true);
    renderTimeline();
    requestMoodMirror();
  }
});
