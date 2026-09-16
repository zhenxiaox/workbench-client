// workbench-todos.js - 千牛采集宝工作台：待办看板 / 便签 / 网址分类 / 分类管理 模块（P2-1 拆模块第五步）
// 说明：本文件**不用 IIFE**（全局声明），workbench.html 加载顺序：
// db.js → workbench-utils.js → workbench-store.js → workbench-timeline.js →
// workbench-pomodoro.js → workbench-modal.js → workbench-todos.js → workbench-quote.js → workbench.js。
// 依赖：utils（uid/esc/hostOf/fmtTime/normalizeUrl）、store（state/save/defaultState）、
//       timeline（addTimeline/removeTodoTimeline）、modal（showModal）、pomodoro（chime/updatePomoCatSelector）、
//       workbench.js（render 全局渲染编排函数）。

// ========= 待办模块状态（全局） =========
var currentTodoFilter = 'all';
var editingTodoId = null;

// ========= 待办看板渲染 =========

function todoCardHTML() {
  return '<section class="card todo-card">' +
    '<div class="mod-head">' +
      '<i class="ti ti-checkbox" style="color:#10B981;"></i>' +
      '<h3>待办看板</h3>' +
      '<button class="btn-help" type="button" data-act="show-guide" title="四象限使用指南"><i class="ti ti-help-circle"></i></button>' +
      '<button class="btn-xs" id="btn-add-todo" data-act="add-todo" type="button"><i class="ti ti-plus"></i>新建待办</button>' +
    '</div>' +
    '<div class="todo-filter-bar">' +
      '<button class="todo-filter-btn active" data-filter="all" type="button">全部</button>' +
      '<button class="todo-filter-btn" data-filter="today" type="button">今日</button>' +
      '<button class="todo-filter-btn" data-filter="7days" type="button">近7天</button>' +
      '<button class="todo-filter-btn" data-filter="30days" type="button">近30天</button>' +
      '<button class="todo-filter-btn" data-filter="completed" type="button">已完成</button>' +
    '</div>' +
    '<div class="tianzige-container">' +
      '<div class="quadrant q1" data-quad="q1">' +
        '<div class="quad-head"><span class="tag q1-tag">P1</span> 重要且紧急</div>' +
        '<ul class="todo-list" id="todo-q1"></ul>' +
      '</div>' +
      '<div class="quadrant q2" data-quad="q2">' +
        '<div class="quad-head"><span class="tag q2-tag">P2</span> 重要不紧急</div>' +
        '<ul class="todo-list" id="todo-q2"></ul>' +
      '</div>' +
      '<div class="quadrant q3" data-quad="q3">' +
        '<div class="quad-head"><span class="tag q3-tag">P3</span> 紧急不重要</div>' +
        '<ul class="todo-list" id="todo-q3"></ul>' +
      '</div>' +
      '<div class="quadrant q4" data-quad="q4">' +
        '<div class="quad-head"><span class="tag q4-tag">P4</span> 不紧急不重要</div>' +
        '<ul class="todo-list" id="todo-q4"></ul>' +
      '</div>' +
    '</div>' +
  '</section>';
}

function getFilteredTodos() {
  var todos = state.todos || [];
  var now = new Date();

  var todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0).getTime();
  var todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999).getTime();

  var next7DaysEnd = todayStart + 7 * 24 * 3600 * 1000 - 1;
  var next30DaysEnd = todayStart + 30 * 24 * 3600 * 1000 - 1;

  return todos.filter(function (t) {
    if (currentTodoFilter === 'completed') {
      return t.done;
    }
    if (t.done) return false;
    if (currentTodoFilter === 'all') return true;
    if (!t.remindTime) return false;
    if (currentTodoFilter === 'today') return t.remindTime <= todayEnd;
    if (currentTodoFilter === '7days') return t.remindTime <= next7DaysEnd;
    if (currentTodoFilter === '30days') return t.remindTime <= next30DaysEnd;
    return true;
  });
}

function noteHTML(t) {
  var noteText = t.note || '';
  var hasNoteClass = noteText ? ' has-note' : '';
  return '<span class="todo-note-icon-btn' + hasNoteClass + '" data-id="' + esc(t.id) + '" title="' + (noteText ? esc(noteText) : '添加便签') + '"><i class="ti ti-notebook"></i></span>';
}

function renderTodos() {
  var todos = getFilteredTodos();
  ['q1', 'q2', 'q3', 'q4'].forEach(function (q) {
    var el = document.getElementById('todo-' + q);
    if (!el) return;
    var items = todos.filter(function (t) { return t.quad === q; }).map(function (t) {
      var timeHTML = '';
      if (t.remindTime) {
        var isDue = Date.now() >= t.remindTime;
        var d = new Date(t.remindTime);
        var timeStr = ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2) + ' ' + ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
        timeHTML = '<span class="todo-time-tag ' + (isDue ? 'due' : '') + '" title="截止/提醒时间"><i class="ti ti-clock"></i>' + timeStr + '</span>';
      }
      var repeatLabel = '';
      if (t.repeat && t.repeat !== 'none') {
        var repMap = { daily: '每天', workday: '工作日', weekly: '每周', monthly: '每月', yearly: '每年', custom: '自定义' };
        repeatLabel = '<span class="todo-repeat-tag" title="重复：' + (repMap[t.repeat] || '重复') + '"><i class="ti ti-repeat"></i></span>';
      }
      var promoteLabel = t.autoPromoted ? '<span class="todo-promote-tag" title="截止临近，已自动升级至 P1"><i class="ti ti-alert-circle"></i></span>' : '';
      return '<li class="todo-item' + (t.done ? ' done' : '') + '" data-id="' + esc(t.id) + '" draggable="true">' +
        '<div class="todo-main-row">' +
          '<input type="checkbox" data-id="' + esc(t.id) + '"' + (t.done ? ' checked' : '') + '>' +
          '<span class="todo-title" title="' + esc(t.text) + '">' + esc(t.text) + '</span>' +
          '<span class="todo-item-right">' + timeHTML + repeatLabel + promoteLabel + noteHTML(t) +
            '<button class="edit-todo" data-act="edit-todo" data-id="' + esc(t.id) + '" title="编辑"><i class="ti ti-edit"></i></button>' +
            '<button class="del-todo" data-act="del-todo" data-id="' + esc(t.id) + '" title="删除"><i class="ti ti-x"></i></button>' +
          '</span>' +
        '</div>' +
      '</li>';
    }).join('');
    el.innerHTML = items || '<li class="empty-placeholder"><i class="ti ti-plus" style="font-size:18px;"></i><span>新建待办事项</span></li>';
  });
}

// ========= 便签 / 网址分类 卡片 =========

function notesCardHTML() {
  var notes = state.notes.map(function (n) {
    return '<div class="note">' +
      '<textarea class="note-ta" data-id="' + esc(n.id) + '" rows="3" placeholder="写点什么…">' + esc(n.text) + '</textarea>' +
      '<div class="note-foot">' +
        '<span class="note-time">' + (n.updatedAt ? '更新于 ' + fmtTime(n.updatedAt) : '未保存') + '</span>' +
        '<button class="del" type="button" data-act="del-note" data-id="' + esc(n.id) + '" title="删除便签"><i class="ti ti-trash"></i></button>' +
      '</div>' +
    '</div>';
  }).join('');
  var body = notes || '<p class="empty">还没有便签，点下方按钮新建一张</p>';
  return '<section class="card">' +
    '<div class="mod-head"><i class="ti ti-notes" style="color:#7C3AED"></i><h3>随手记 / 便签</h3></div>' +
    '<div class="notes-wrap">' + body + '</div>' +
    '<button class="btn block" id="add-note" data-act="add-note" type="button"><i class="ti ti-plus"></i>新增便签</button>' +
  '</section>';
}

function modulesHTML() {
  return state.modules.map(function (m) {
    var items = m.links.length ? m.links.map(function (l) {
      return '<li><i class="ti ti-link"></i><a href="' + esc(l.url) + '" target="_blank" rel="noopener">' + esc(l.label) + '</a>' +
        '<button class="del" type="button" data-act="del-link" data-mod="' + esc(m.id) + '" data-id="' + esc(l.id) + '" title="删除链接"><i class="ti ti-x"></i></button></li>';
    }).join('') : '<li class="empty">暂无链接，下面添加一个</li>';
    var title = document.body.classList.contains('manage')
      ? '<input class="mod-name-input" data-id="' + esc(m.id) + '" value="' + esc(m.name) + '" maxlength="30" title="点击修改分类名称">'
      : '<h3>' + esc(m.name) + '</h3>';
    return '<section class="card">' +
      '<div class="mod-head">' +
        '<i class="ti ti-folder"></i>' + title +
        '<span class="mod-count">' + m.links.length + '</span>' +
        '<button class="open-all" type="button" data-act="open-all" data-id="' + esc(m.id) + '" title="一次打开全部网址"><i class="ti ti-external-link"></i></button>' +
        '<button class="del" type="button" data-act="del-mod" data-id="' + esc(m.id) + '" title="删除分类"><i class="ti ti-trash"></i></button>' +
      '</div>' +
      '<ul class="links">' + items + '</ul>' +
      '<form class="add-link" data-id="' + esc(m.id) + '">' +
        '<input class="lab" placeholder="名称（可选）" autocomplete="off">' +
        '<input class="url" placeholder="网址，如 taobao.com" autocomplete="off">' +
        '<button class="btn primary" type="submit"><i class="ti ti-plus"></i>添加</button>' +
      '</form>' +
    '</section>';
  }).join('');
}

function addModHTML() {
  return '<section class="card add-mod">' +
    '<form id="add-mod-form">' +
      '<input id="new-mod-name" placeholder="新分类名称，如：日常工具" autocomplete="off">' +
      '<button class="btn primary" type="submit"><i class="ti ti-plus"></i>新建网址分类</button>' +
    '</form>' +
  '</section>';
}

function bindNotesTextareas() {
  var tas = document.querySelectorAll('.note-ta');
  for (var i = 0; i < tas.length; i++) {
    (function (ta) {
      ta.addEventListener('input', function () {
        var n = state.notes.find(function (x) { return x.id === ta.dataset.id; });
        if (!n) return;
        n.text = ta.value;
        n.updatedAt = Date.now();
        save(true);
        var foot = ta.closest('.note').querySelector('.note-time');
        if (foot) foot.textContent = '更新于 ' + fmtTime(n.updatedAt);
      });
    })(tas[i]);
  }
}

function bindModNameInputs() {
  var ins = document.querySelectorAll('.mod-name-input');
  for (var i = 0; i < ins.length; i++) {
    (function (inp) {
      inp.addEventListener('change', function () {
        var m = state.modules.find(function (x) { return x.id === inp.dataset.id; });
        if (!m) return;
        var name = inp.value.trim();
        if (!name) { inp.value = m.name; return; }
        m.name = name;
        save();
        render();
      });
    })(ins[i]);
  }
}

// ========= 重复规则 UI =========

function resetRepeatUI() {
  var sel = document.getElementById('todo-input-repeat');
  if (sel) sel.value = 'none';
  document.getElementById('custom-repeat-panel').style.display = 'none';
  document.getElementById('custom-repeat-num').value = 1;
  document.getElementById('custom-repeat-unit').value = 'week';
  document.getElementById('custom-week-days-row').style.display = 'flex';
  document.querySelectorAll('.week-picker input').forEach(function (cb) { cb.checked = false; });
  document.getElementById('custom-end-type').value = 'never';
  document.getElementById('end-val-row').style.display = 'none';
  document.getElementById('end-val-container').innerHTML = '';
}

function fillRepeatUI(item) {
  var repeat = item.repeat || 'none';
  document.getElementById('todo-input-repeat').value = repeat;
  document.getElementById('custom-repeat-panel').style.display = repeat === 'custom' ? 'flex' : 'none';
  var cr = item.customRepeat || {};
  document.getElementById('custom-repeat-num').value = cr.num || 1;
  var unit = cr.unit || 'week';
  document.getElementById('custom-repeat-unit').value = unit;
  var days = (cr.days || []).map(String);
  document.querySelectorAll('.week-picker input').forEach(function (cb) {
    cb.checked = days.indexOf(cb.value) !== -1;
  });
  document.getElementById('custom-week-days-row').style.display = unit === 'week' ? 'flex' : 'none';
  var endType = item.repeatEndType || 'never';
  document.getElementById('custom-end-type').value = endType;
  var row = document.getElementById('end-val-row');
  var container = document.getElementById('end-val-container');
  if (endType === 'count') {
    row.style.display = 'flex';
    container.innerHTML = '重复 <input type="number" id="custom-end-count" value="' + (item.maxRepeatCount || 10) + '" min="1" class="input-num"> 次后停止';
  } else if (endType === 'date') {
    row.style.display = 'flex';
    container.innerHTML = '<input type="date" id="custom-end-date" class="form-control" style="width:auto;" value="' + (item.repeatEndDate || '') + '">';
  } else {
    row.style.display = 'none';
    container.innerHTML = '';
  }
}

// ========= 待办弹窗 =========

function openAddTodoModal(quad) {
  editingTodoId = null;
  document.getElementById('todo-modal-title').textContent = '新建待办事项';
  document.getElementById('todo-input-text').value = '';
  document.getElementById('todo-input-time').value = '';
  document.getElementById('todo-estimate-hours').value = '0';
  document.getElementById('todo-input-note').value = '';
  var qRadio = document.querySelector('input[name="todo-quad"][value="' + (quad || 'q1') + '"]');
  if (qRadio) qRadio.checked = true;
  resetRepeatUI();
  document.getElementById('todo-modal-mask').classList.add('show');
  setTimeout(function () { document.getElementById('todo-input-text').focus(); }, 50);
}

function closeTodoModal() {
  document.getElementById('todo-modal-mask').classList.remove('show');
}
document.getElementById('btn-close-todo-modal').addEventListener('click', closeTodoModal);
document.getElementById('btn-cancel-todo').addEventListener('click', closeTodoModal);

// ========= 待办看板：grid 点击委托 =========

document.getElementById('grid').addEventListener('click', function (e) {
  if (e.target.closest('.todo-note-icon-btn')) return;
  var fb = e.target.closest('.todo-filter-btn');
  if (fb) {
    document.querySelectorAll('.todo-filter-btn').forEach(function (b) { b.classList.remove('active'); });
    fb.classList.add('active');
    currentTodoFilter = fb.dataset.filter;
    renderTodos();
    return;
  }
  var cb = e.target.closest('input[type="checkbox"]');
  if (cb) {
    var it = state.todos.find(function (x) { return x.id === cb.dataset.id; });
    if (it) {
      var prevDone = it.done;
      if (cb.checked && it.repeat && it.repeat !== 'none') {
        var nextTime = getNextRepeatTimeSamsung(it);
        if (nextTime) {
          it.remindTime = nextTime;
          it.done = false;
          it.notified = false;
        } else {
          it.done = true;
        }
      } else {
        it.done = cb.checked;
      }
      if (it.done && !prevDone) addTimeline('todo', '完成待办：' + it.text, it.id);
      else if (!it.done && prevDone) removeTodoTimeline(it.id);
      save(true);
      renderTodos();
    }
    return;
  }
  var b = e.target.closest('button');
  if (!b) {
    // 点击待办卡片非按钮区域 → 整卡切换勾选（复用下方 checkbox 分支的完整逻辑：
    // 重复待办、完成入时间线、保存、重渲染；按钮区域已在上面分支处理，不会冒泡误触发）
    var tItem = e.target.closest('.todo-item');
    if (tItem) {
      var cbEl = tItem.querySelector('input[type="checkbox"]');
      if (cbEl) cbEl.click();
      return;
    }
    var quadEl = e.target.closest('.quadrant');
    if (quadEl) openAddTodoModal(quadEl.dataset.quad || 'q1');
    return;
  }
  var act = b.dataset.act || b.id;

  if (act === 'add-todo') {
    openAddTodoModal('q1');
    return;
  }

  if (act === 'show-guide') {
    document.getElementById('guide-modal-mask').classList.add('show');
    return;
  }

  if (act === 'edit-todo') {
    var eItem = state.todos.find(function (x) { return x.id === b.dataset.id; });
    if (!eItem) return;
    editingTodoId = eItem.id;
    document.getElementById('todo-modal-title').textContent = '编辑待办事项';
    document.getElementById('todo-input-text').value = eItem.text;
    var qRadio = document.querySelector('input[name="todo-quad"][value="' + eItem.quad + '"]');
    if (qRadio) qRadio.checked = true;
    if (eItem.remindTime) {
      var ed = new Date(eItem.remindTime);
      document.getElementById('todo-input-time').value =
        ed.getFullYear() + '-' + ('0' + (ed.getMonth() + 1)).slice(-2) + '-' + ('0' + ed.getDate()).slice(-2) +
        'T' + ('0' + ed.getHours()).slice(-2) + ':' + ('0' + ed.getMinutes()).slice(-2);
    } else {
      document.getElementById('todo-input-time').value = '';
    }
    document.getElementById('todo-estimate-hours').value = String(eItem.estimatedHours || 0);
    document.getElementById('todo-input-note').value = eItem.note || '';
    fillRepeatUI(eItem);
    document.getElementById('todo-modal-mask').classList.add('show');
    setTimeout(function () { document.getElementById('todo-input-text').focus(); }, 50);
    return;
  }

  if (act === 'del-todo') {
    var tgt = state.todos.find(function (x) { return x.id === b.dataset.id; });
    if (tgt && confirm('确定删除这条待办吗？')) {
      state.todos = state.todos.filter(function (x) { return x.id !== b.dataset.id; });
      save(); renderTodos();
    }
    return;
  }

  if (act === 'open-all') {
    var mo = state.modules.find(function (x) { return x.id === b.dataset.id; });
    if (!mo) return;
    if (!mo.links.length) { showModal('该分类下还没有链接'); return; }
    mo.links.forEach(function (l) {
      window.open(l.url, '_blank', 'noopener');
    });
    return;
  }

  if (act === 'add-note') {
    state.notes.push({ id: uid(), text: '', updatedAt: Date.now() });
    save();
    render();
    var tas = document.querySelectorAll('.note-ta');
    if (tas.length) tas[tas.length - 1].focus();
    return;
  }

  if (act === 'del-mod') {
    var m = state.modules.find(function (x) { return x.id === b.dataset.id; });
    if (!m) return;
    if (!confirm('确定删除分类「' + m.name + '」以及其中的 ' + m.links.length + ' 个链接吗？')) return;
    state.modules = state.modules.filter(function (x) { return x.id !== m.id; });
    save(); render();
    return;
  }

  if (act === 'del-link') {
    var mm = state.modules.find(function (x) { return x.id === b.dataset.mod; });
    if (mm && confirm('确定删除这个链接吗？')) {
      mm.links = mm.links.filter(function (x) { return x.id !== b.dataset.id; });
      save(); render();
    }
    return;
  }

  if (act === 'del-note') {
    var n = state.notes.find(function (x) { return x.id === b.dataset.id; });
    if (n && confirm('确定删除这张便签吗？')) {
      state.notes = state.notes.filter(function (x) { return x.id !== b.dataset.id; });
      save(); render();
    }
  }
});

// ========= 待办看板：拖拽排序 / 跨象限移动 =========

var gridEl = document.getElementById('grid');
var draggedTodoId = null;
gridEl.addEventListener('dragstart', function (e) {
  var item = e.target.closest('.todo-item');
  if (!item) return;
  if (e.target.closest('input, button, i')) return;
  draggedTodoId = item.dataset.id;
  e.dataTransfer.setData('text/plain', draggedTodoId);
  e.dataTransfer.effectAllowed = 'move';
  setTimeout(function () { item.classList.add('dragging'); }, 0);
});
gridEl.addEventListener('dragover', function (e) {
  var quad = e.target.closest('.quadrant');
  if (!quad) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  gridEl.querySelectorAll('.quadrant').forEach(function (q) { q.classList.remove('drag-over'); });
  quad.classList.add('drag-over');
});
gridEl.addEventListener('dragleave', function (e) {
  var quad = e.target.closest('.quadrant');
  if (quad && !quad.contains(e.relatedTarget)) quad.classList.remove('drag-over');
});
gridEl.addEventListener('drop', function (e) {
  var quad = e.target.closest('.quadrant');
  if (!quad || !draggedTodoId) return;
  e.preventDefault();
  gridEl.querySelectorAll('.quadrant').forEach(function (q) { q.classList.remove('drag-over'); });
  var todo = state.todos.find(function (t) { return t.id === draggedTodoId; });
  if (todo && todo.quad !== quad.dataset.quad) {
    todo.quad = quad.dataset.quad;
    save(true);
    renderTodos();
  }
  draggedTodoId = null;
});
gridEl.addEventListener('dragend', function (e) {
  var item = e.target.closest('.todo-item');
  if (item) item.classList.remove('dragging');
  gridEl.querySelectorAll('.quadrant').forEach(function (q) { q.classList.remove('drag-over'); });
  draggedTodoId = null;
});

// ========= 待办看板：表单提交（新增链接 / 新建分类） =========

document.getElementById('grid').addEventListener('submit', function (e) {
  var form = e.target.closest('form');
  if (!form) return;

  if (form.classList.contains('add-link')) {
    e.preventDefault();
    var lab = form.querySelector('.lab').value.trim();
    var url = form.querySelector('.url').value.trim();
    if (!url) return;
    url = normalizeUrl(url);
    var m = state.modules.find(function (x) { return x.id === form.dataset.id; });
    if (m) {
      m.links.push({ id: uid(), label: lab || hostOf(url), url: url });
      save(); render();
    }
    return;
  }

  if (form.id === 'add-mod-form') {
    e.preventDefault();
    var nameInput = document.getElementById('new-mod-name');
    var name = nameInput ? nameInput.value.trim() : '';
    if (!name) return;
    state.modules.push({ id: uid(), name: name, links: [] });
    save(); render();
  }
});

// ========= 待办便签气泡（document 级委托） =========

function closeNotePopover() {
  var el = document.getElementById('active-note-popover');
  if (el) el.remove();
}

document.addEventListener('click', function (e) {
  var iconBtn = e.target.closest('.todo-note-icon-btn');
  if (iconBtn) {
    e.stopPropagation();
    var todoId = iconBtn.dataset.id;
    var todo = (state.todos || []).find(function (x) { return x.id === todoId; });
    if (!todo) return;
    closeNotePopover();
    var popover = document.createElement('div');
    popover.className = 'note-popover';
    popover.id = 'active-note-popover';
    popover.innerHTML = '<textarea id="popover-note-input" placeholder="输入便签说明...">' + esc(todo.note || '') + '</textarea>' +
      '<div class="note-popover-actions">' +
        '<button class="btn-note-cancel" type="button">取消</button>' +
        '<button class="btn-note-save" type="button">保存</button>' +
      '</div>';
    document.body.appendChild(popover);
    var rect = iconBtn.getBoundingClientRect();
    popover.style.top = (rect.bottom + window.scrollY + 4) + 'px';
    popover.style.left = Math.min(rect.left + window.scrollX, window.innerWidth - 240) + 'px';
    var textarea = popover.querySelector('textarea');
    textarea.focus();
    popover.querySelector('.btn-note-save').addEventListener('click', function () {
      todo.note = textarea.value.trim();
      save();
      renderTodos();
      closeNotePopover();
    });
    popover.querySelector('.btn-note-cancel').addEventListener('click', closeNotePopover);
    return;
  }
  if (!e.target.closest('#active-note-popover')) closeNotePopover();
});

// ========= 重复规则相关 change 监听 =========

document.getElementById('todo-input-repeat').addEventListener('change', function () {
  var panel = document.getElementById('custom-repeat-panel');
  panel.style.display = this.value === 'custom' ? 'flex' : 'none';
});

document.getElementById('custom-repeat-unit').addEventListener('change', function () {
  var weekRow = document.getElementById('custom-week-days-row');
  weekRow.style.display = this.value === 'week' ? 'flex' : 'none';
});

document.getElementById('custom-end-type').addEventListener('change', function () {
  var row = document.getElementById('end-val-row');
  var container = document.getElementById('end-val-container');
  if (this.value === 'count') {
    row.style.display = 'flex';
    container.innerHTML = '重复 <input type="number" id="custom-end-count" value="10" min="1" class="input-num"> 次后停止';
  } else if (this.value === 'date') {
    row.style.display = 'flex';
    container.innerHTML = '<input type="date" id="custom-end-date" class="form-control" style="width:auto;">';
  } else {
    row.style.display = 'none';
    container.innerHTML = '';
  }
});

// ========= 重复时间计算 =========

function getNextRepeatTimeSamsung(item) {
  var base = new Date(item.remindTime || Date.now());
  var type = item.repeat;

  if (item.repeatEndType === 'count') {
    item.repeatCount = (item.repeatCount || 0) + 1;
    if (item.repeatCount >= item.maxRepeatCount) return null;
  } else if (item.repeatEndType === 'date' && item.repeatEndDate) {
    if (base.getTime() >= new Date(item.repeatEndDate).getTime()) return null;
  }

  if (type === 'daily') {
    base.setDate(base.getDate() + 1);
  } else if (type === 'workday') {
    do {
      base.setDate(base.getDate() + 1);
    } while (base.getDay() === 0 || base.getDay() === 6);
  } else if (type === 'weekly') {
    base.setDate(base.getDate() + 7);
  } else if (type === 'monthly') {
    base.setMonth(base.getMonth() + 1);
  } else if (type === 'yearly') {
    base.setFullYear(base.getFullYear() + 1);
  } else if (type === 'custom' && item.customRepeat) {
    var num = item.customRepeat.num || 1;
    var unit = item.customRepeat.unit || 'day';
    if (unit === 'day') {
      base.setDate(base.getDate() + num);
    } else if (unit === 'month') {
      base.setMonth(base.getMonth() + num);
    } else if (unit === 'year') {
      base.setFullYear(base.getFullYear() + num);
    } else if (unit === 'week') {
      var days = item.customRepeat.days || [];
      if (days.length === 0) {
        base.setDate(base.getDate() + num * 7);
      } else {
        var found = false;
        for (var i = 1; i <= 7 * num; i++) {
          base.setDate(base.getDate() + 1);
          if (days.indexOf(String(base.getDay())) !== -1) { found = true; break; }
        }
        if (!found) base.setDate(base.getDate() + 7 * num);
      }
    }
  }

  return base.getTime();
}

// ========= 保存待办（新建 / 编辑） =========

document.getElementById('btn-save-todo').addEventListener('click', function () {
  var text = document.getElementById('todo-input-text').value.trim();
  var quadChecked = document.querySelector('input[name="todo-quad"]:checked');
  var quad = quadChecked ? quadChecked.value : 'q1';
  var timeVal = document.getElementById('todo-input-time').value;
  var remindTime = timeVal ? new Date(timeVal).getTime() : null;
  var estHours = parseFloat(document.getElementById('todo-estimate-hours').value) || 0;
  var noteVal = document.getElementById('todo-input-note').value.trim();
  if (!text) { alert('请输入待办内容'); return; }

  var repeat = document.getElementById('todo-input-repeat').value;
  var customConfig = null;
  var endType = 'never';
  var endVal = null;
  if (repeat === 'custom') {
    var selectedDays = [];
    document.querySelectorAll('.week-picker input:checked').forEach(function (c) {
      selectedDays.push(c.value);
    });
    customConfig = {
      num: parseInt(document.getElementById('custom-repeat-num').value, 10) || 1,
      unit: document.getElementById('custom-repeat-unit').value,
      days: selectedDays
    };
    endType = document.getElementById('custom-end-type').value;
    if (endType === 'count') {
      endVal = parseInt(document.getElementById('custom-end-count').value, 10) || 10;
    } else if (endType === 'date') {
      endVal = document.getElementById('custom-end-date').value || null;
      if (!endVal) endType = 'never';
    }
  }

  if (editingTodoId) {
    var eItem = state.todos.find(function (x) { return x.id === editingTodoId; });
    if (eItem) {
      eItem.text = text;
      eItem.quad = quad;
      eItem.repeat = repeat;
      eItem.customRepeat = customConfig;
      eItem.repeatEndType = endType;
      eItem.maxRepeatCount = endType === 'count' ? endVal : null;
      eItem.repeatEndDate = endType === 'date' ? endVal : null;
      eItem.repeatCount = eItem.repeatCount || 0;
      if (eItem.remindTime !== remindTime) eItem.notified = false;
      eItem.remindTime = remindTime;
      eItem.estimatedHours = estHours;
      eItem.autoPromoted = false;
      eItem.note = noteVal;
    }
  } else {
    state.todos.push({
      id: uid(),
      text: text,
      quad: quad,
      repeat: repeat,
      customRepeat: customConfig,
      repeatEndType: endType,
      maxRepeatCount: endType === 'count' ? endVal : null,
      repeatEndDate: endType === 'date' ? endVal : null,
      repeatCount: 0,
      remindTime: remindTime,
      estimatedHours: estHours,
      note: noteVal,
      done: false,
      notified: false
    });
  }
  save();
  updateTaskQuadrantByDueDate();
  renderTodos();
  closeTodoModal();
});

// ========= 分类管理弹窗 =========

var catsMask = document.getElementById('cats-modal-mask');
function renderCatsList() {
  var el = document.getElementById('cats-list');
  if (!state.cats || !state.cats.length) {
    el.innerHTML = '<li class="empty">暂无分类</li>';
    return;
  }
  el.innerHTML = state.cats.map(function (c, i) {
    return '<li class="cats-item-row">' +
      '<span class="cats-item-text">' + esc(c) + '</span>' +
      '<button class="cats-item-del" data-index="' + i + '" type="button" title="删除"><i class="ti ti-x"></i></button>' +
    '</li>';
  }).join('');
}
document.getElementById('btn-manage-cats').addEventListener('click', function () {
  renderCatsList();
  catsMask.classList.add('show');
});
function closeCats() { catsMask.classList.remove('show'); }
document.getElementById('btn-close-cats-modal').addEventListener('click', closeCats);
document.getElementById('btn-close-cats-modal-foot').addEventListener('click', closeCats);
catsMask.addEventListener('click', function (e) {
  if (e.target === catsMask) closeCats();
});
document.getElementById('btn-add-cat').addEventListener('click', function () {
  var name = document.getElementById('cats-input').value.trim();
  if (!name) { alert('请输入分类名称'); return; }
  if ((state.cats || []).indexOf(name) !== -1) { alert('该分类已存在'); return; }
  state.cats.push(name);
  document.getElementById('cats-input').value = '';
  save();
  renderCatsList();
  updatePomoCatSelector();
});
document.getElementById('cats-list').addEventListener('click', function (e) {
  var btn = e.target.closest('.cats-item-del');
  if (!btn) return;
  var idx = parseInt(btn.dataset.index, 10);
  var name = state.cats[idx];
  if (!confirm('删除分类【' + name + '】？已有时间块记录保留，但不再出现在选项中。')) return;
  state.cats.splice(idx, 1);
  if (state.pomoCat === name) state.pomoCat = '';
  save();
  renderCatsList();
  updatePomoCatSelector();
});

// ========= 艾森豪威尔自动升/降档 =========

// 临近截止（剩余 ≤ 预估时长）且未完成的非紧急象限，自动升级为紧急象限
function checkAutoPromoteTodos() {
  if (!state || !state.todos || !state.todos.length) return;
  var now = Date.now();
  var hasChanged = false;
  var map = { q2: 'q1', q4: 'q3' };
  state.todos.forEach(function (todo) {
    if (!todo.done && (todo.quad === 'q2' || todo.quad === 'q4') && todo.remindTime && todo.estimatedHours > 0) {
      var dueTime = todo.remindTime;
      var estimateMs = todo.estimatedHours * 60 * 60 * 1000;
      if (now + estimateMs >= dueTime) {
        todo.quad = map[todo.quad];
        todo.autoPromoted = true;
        hasChanged = true;
      }
    }
  });
  if (hasChanged) {
    save();
    renderTodos();
  }
}

// 剩余超过 3 天时，紧急象限降档为不紧急（P1->P2 / P3->P4）
function updateTaskQuadrantByDueDate() {
  if (!state || !state.todos || !state.todos.length) return;
  var now = Date.now();
  var THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
  var hasChanged = false;
  state.todos.forEach(function (todo) {
    if (todo.done || todo.autoPromoted || !todo.remindTime) return;
    var diffMs = todo.remindTime - now;
    if (diffMs > THREE_DAYS_MS) {
      if (todo.quad === 'q1') {
        todo.quad = 'q2';
        hasChanged = true;
      } else if (todo.quad === 'q3') {
        todo.quad = 'q4';
        hasChanged = true;
      }
    }
  });
  if (hasChanged) {
    save();
    renderTodos();
  }
}

// ========= 待办定时提醒轮询 =========

setInterval(function () {
  if (!state || !state.todos) return;
  var now = Date.now();
  state.todos.forEach(function (t) {
    if (t.remindTime && !t.done && !t.notified && now >= t.remindTime) {
      t.notified = true;
      save(true);
      chime();
      showModal('【待办提醒】' + t.text);
      renderTodos();
    }
  });
  checkAutoPromoteTodos();
  updateTaskQuadrantByDueDate();
}, 10000);

// 艾森豪威尔自动升档轮询（每分钟）
setInterval(function () {
  checkAutoPromoteTodos();
  updateTaskQuadrantByDueDate();
}, 60 * 1000);
