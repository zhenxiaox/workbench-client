/* ============================================================
   运营工作台 · 手机端适配器（零侵入）
   仅窄屏 / 移动 UA 启用，桌面端直接 return。
   - 给数据表 <td> 注入 data-label → 配合 mobile-ui.css 转堆叠卡
   - 动态渲染（innerHTML 重绘）后用 MutationObserver 自动补 label
   - 注入返回手机工作台入口（按页类型自适应：抽屉 / 顶栏 / 悬浮）
   - ECharts 实例宽度 100% + resize 自适应
   ============================================================ */
(function () {
  'use strict';

  var isMobileUA = /Mobile|Android|iPhone|iPad|iPod|Windows Phone|webOS|BlackBerry|Opera Mini/i.test(navigator.userAgent);
  var mq = window.matchMedia ? window.matchMedia('(max-width: 860px)') : { matches: false };
  if (!isMobileUA && !mq.matches) return;

  function $(s, c) { return (c || document).querySelector(s); }
  function $all(s, c) { return Array.prototype.slice.call((c || document).querySelectorAll(s)); }

  function pageTitle() {
    var t = $('.mobile-header h1') || $('header h1') || $('.sidebar-logo h1');
    var txt = t ? t.textContent.trim() : (document.title || '运营工作台');
    return txt.replace(/\s*[-—–]\s*运营工作台.*$/, '').trim() || '运营工作台';
  }

  // 合格表格：有 thead，且属于数据表（data-table 类 或 包在 wrapper/card 内）
  function eligibleTables() {
    return $all('table').filter(function (t) {
      if (t.hasAttribute('data-mobile-scroll')) return false;
      if (t.closest('[data-mobile-scroll]')) return false;
      var hasHead = !!t.querySelector('thead th');
      if (!hasHead) return false;
      var cls = t.classList.contains('data-table');
      var inWrap = !!t.closest('.data-table-wrapper, .table-wrap, .card, .content');
      return cls || inWrap;
    });
  }

  function applyTable(t) {
    t.setAttribute('data-mobile-cards', '1');
    var heads = $all('thead tr:last-child th', t).map(function (th) {
      return th.textContent.replace(/[▲▼↑↓\s·]+$/g, ' ').replace(/\s+/g, ' ').trim();
    });
    if (!heads.length) heads = $all('thead th', t).map(function (th) { return th.textContent.trim(); });
    $all('tbody tr', t).forEach(function (tr) {
      var tds = $all('td', tr);
      if (tds.length === 1 && tds[0].hasAttribute('colspan')) { tr.classList.add('mobile-skip'); return; }
      tr.classList.remove('mobile-skip');
      tds.forEach(function (td, i) {
        if (td.hasAttribute('colspan')) { td.setAttribute('data-label', ''); return; }
        var lab = heads[i] || '';
        if (td.getAttribute('data-label') !== lab) td.setAttribute('data-label', lab);
      });
    });
  }

  var _t;
  function applyAll() {
    clearTimeout(_t);
    _t = setTimeout(function () { eligibleTables().forEach(applyTable); }, 120);
  }

  function injectBack() {
    var HUB = '手机工作台.html';
    if ($('.mobile-header')) {
      // 单品分析等：悬浮返回
      var fab = document.createElement('a');
      fab.className = 'm-back-fab'; fab.href = HUB; fab.textContent = '‹'; fab.title = '返回手机工作台';
      document.body.appendChild(fab);
    } else if ($('header')) {
      // 客服/SKU/评价/聊天记录/需求分析：在现成 header 前插入返回
      var a = document.createElement('a');
      a.className = 'm-back-link'; a.href = HUB; a.textContent = '‹ 工作台';
      var h = $('header');
      h.insertBefore(a, h.firstChild);
    } else if ($('.sidebar')) {
      // 店铺分析：注入顶栏 + 抽屉
      var bar = document.createElement('div');
      bar.className = 'm-topbar'; bar.id = 'mTopbar';
      bar.innerHTML = '<button class="m-menu" id="mMenu">☰</button>' +
                      '<span class="m-title">' + pageTitle() + '</span>' +
                      '<a class="m-back" href="' + HUB + '">‹ 工作台</a>';
      document.body.insertBefore(bar, document.body.firstChild);
      var bd = document.createElement('div');
      bd.className = 'm-backdrop'; bd.id = 'mBackdrop';
      document.body.appendChild(bd);
      var sb = $('.sidebar');
      sb.classList.add('m-drawer');
      function toggle() { document.body.classList.toggle('m-nav'); }
      var menu = document.getElementById('mMenu');
      if (menu) menu.addEventListener('click', toggle);
      bd.addEventListener('click', function () { document.body.classList.remove('m-nav'); });
    }
  }

  function resizeCharts() {
    if (!window.echarts || !echarts.getInstanceByDom) return;
    $all('[_echarts_instance_]').forEach(function (el) {
      try { el.style.width = '100%'; var inst = echarts.getInstanceByDom(el); if (inst) inst.resize(); } catch (e) {}
    });
  }

  function init() {
    applyAll();
    setTimeout(applyAll, 400);
    setTimeout(applyAll, 1200);
    injectBack();
    if (window.MutationObserver) {
      try {
        new MutationObserver(function () { applyAll(); }).observe(document.body, { childList: true, subtree: true });
      } catch (e) {}
    }
    resizeCharts();
    setTimeout(resizeCharts, 500);
    setTimeout(resizeCharts, 1500);
    var dt, d = function () { clearTimeout(dt); dt = setTimeout(resizeCharts, 200); };
    window.addEventListener('resize', d);
    window.addEventListener('orientationchange', d);
  }

  if (document.readyState !== 'loading') init();
  else document.addEventListener('DOMContentLoaded', init);
})();
