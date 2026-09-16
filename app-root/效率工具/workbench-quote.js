// workbench-quote.js - 千牛采集宝工作台：名言 / 金句库模块（P2-1 拆模块第五步）
// 说明：本文件**不用 IIFE**（全局声明），workbench.html 加载顺序：
// db.js → workbench-utils.js → workbench-store.js → workbench-timeline.js →
// workbench-pomodoro.js → workbench-modal.js → workbench-todos.js → workbench-quote.js → workbench.js。
// 依赖：utils（uid/esc）、store（state/save/defaultState）。
// 被调用：workbench.js 的 init（syncQuoteUI/loadQuote）、btn-manage 处理（syncQuoteUI）。

// ========= 名言 / 金句函数 =========

// 加载一条名言（API 模式：fetch 一言接口；自制模式：随机取 customList）
function loadQuote() {
  var cfg = state.quoteConfig || (state.quoteConfig = defaultState().quoteConfig);
  var textEl = document.getElementById('quote-text');
  var fromEl = document.getElementById('quote-from');
  if (cfg.mode === 'api') {
    textEl.textContent = '加载中...';
    fetch(cfg.apiUrl)
      .then(function (res) { return res.json(); })
      .then(function (data) {
        textEl.textContent = '“' + (data.hitokoto || '') + '”';
        fromEl.textContent = data.from ? '—— ' + data.from : '';
      })
      .catch(function () {
        textEl.textContent = '“保持专注，解决复杂问题。”';
        fromEl.textContent = '';
      });
  } else {
    var list = cfg.customList || [];
    if (!list.length) {
      textEl.textContent = '“暂无自制金句，请在管理模式下添加。”';
      fromEl.textContent = '';
      return;
    }
    var item = list[Math.floor(Math.random() * list.length)];
    textEl.textContent = '“' + item.text + '”';
    fromEl.textContent = item.from ? '—— ' + item.from : '';
  }
}

// 根据当前模式同步"管理自制库"按钮与接口选择的显隐
function syncQuoteUI() {
  var cfg = state.quoteConfig;
  var modeSel = document.getElementById('quote-mode-select');
  var apiSel = document.getElementById('quote-api-select');
  var customBtn = document.getElementById('btn-manage-custom');
  if (modeSel) modeSel.value = cfg.mode;
  if (apiSel) {
    apiSel.value = cfg.apiUrl;
    apiSel.style.display = cfg.mode === 'api' ? 'inline-block' : 'none';
  }
  if (customBtn) {
    customBtn.style.display = cfg.mode === 'custom' ? 'inline-block' : 'none';
  }
}

// ========= 自制金句库弹窗 =========

// 渲染自制金句列表
function renderCustomQuoteList() {
  var list = state.quoteConfig.customList || [];
  var el = document.getElementById('custom-quote-list');
  if (!list.length) {
    el.innerHTML = '<li class="empty">暂无自制金句</li>';
    return;
  }
  el.innerHTML = list.map(function (q, idx) {
    return '<li class="quote-item-row" data-idx="' + idx + '">' +
      '<span class="quote-item-text">“' + esc(q.text) + '”</span>' +
      (q.from ? '<span class="quote-item-from">—— ' + esc(q.from) + '</span>' : '') +
      '<button class="del" data-act="del-custom-quote" type="button" title="删除"><i class="ti ti-x"></i></button>' +
    '</li>';
  }).join('');
}

// ========= 名言模块事件绑定 =========

document.getElementById('btn-refresh-quote').addEventListener('click', loadQuote);

document.getElementById('quote-mode-select').addEventListener('change', function (e) {
  state.quoteConfig.mode = e.target.value;
  save();
  syncQuoteUI();
  loadQuote();
});

document.getElementById('quote-api-select').addEventListener('change', function (e) {
  state.quoteConfig.apiUrl = e.target.value;
  save();
  loadQuote();
});

document.getElementById('btn-manage-custom').addEventListener('click', function () {
  renderCustomQuoteList();
  document.getElementById('quote-modal-mask').classList.add('show');
});

document.getElementById('btn-close-quote-modal').addEventListener('click', function () {
  document.getElementById('quote-modal-mask').classList.remove('show');
});

document.getElementById('btn-add-custom-quote').addEventListener('click', function () {
  var tInput = document.getElementById('custom-quote-text');
  var fInput = document.getElementById('custom-quote-from');
  if (!tInput.value.trim()) return;
  state.quoteConfig.customList.push({ id: uid(), text: tInput.value.trim(), from: fInput.value.trim() });
  save();
  tInput.value = '';
  fInput.value = '';
  renderCustomQuoteList();
  loadQuote();
});

document.getElementById('custom-quote-list').addEventListener('click', function (e) {
  var btn = e.target.closest('[data-act="del-custom-quote"]');
  if (!btn) return;
  var row = btn.closest('.quote-item-row');
  if (!row) return;
  state.quoteConfig.customList.splice(parseInt(row.dataset.idx, 10), 1);
  save();
  renderCustomQuoteList();
  loadQuote();
});

document.getElementById('btn-download-quote-tpl').addEventListener('click', function () {
  var csvContent = '\uFEFF内容,出处(可选)\n行动是治愈恐惧的良药,励志格言\n保持专注解决复杂问题,佚名\n';
  var blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  var link = document.createElement('a');
  var url = URL.createObjectURL(blob);
  link.setAttribute('href', url);
  link.setAttribute('download', '自制金句导入模板.csv');
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
});

document.getElementById('btn-import-quotes').addEventListener('click', function () {
  document.getElementById('quote-import-file').click();
});

document.getElementById('quote-import-file').addEventListener('change', function (e) {
  var file = e.target.files[0];
  if (!file) return;
  var reader = new FileReader();
  reader.onload = function (evt) {
    var text = evt.target.result;
    var lines = text.split(/\r\n|\n/);
    var count = 0;
    for (var i = 1; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line) continue;
      var parts = line.split(',');
      var qText = parts[0] ? parts[0].trim() : '';
      var qFrom = parts[1] ? parts[1].trim() : '';
      if (qText) {
        state.quoteConfig.customList.push({ id: uid(), text: qText, from: qFrom });
        count++;
      }
    }
    if (count > 0) {
      save();
      renderCustomQuoteList();
      loadQuote();
      alert('成功批量导入 ' + count + ' 条金句！');
    } else {
      alert('未识别到有效内容，请检查模板格式。');
    }
    e.target.value = '';
  };
  reader.readAsText(file, 'UTF-8');
});
