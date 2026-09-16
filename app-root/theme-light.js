/* 运营工作台 · 日间/护眼模式动态修复（单品分析/店铺分析专用）
   1) 把深色中性背景（近黑/深灰蓝）刷成浅色底：light=白，eye=暖米黄；
   2) 把浅色文字在浅底上刷成深色：light=冷黑/灰，eye=暖棕。
   用 MutationObserver 监听 DOM 变化即时修复（切换子页/虚拟表格渲染时不再闪黑），并保留定时兜底。 */
(function () {
  /* 两套目标色：light 冷白、eye 暖米黄 */
  var PALETTE = {
    light: { bg: '#FFFFFF', text1: '#111827', text2: '#475569', mode: 'light' },
    eye:   { bg: '#FBF8F1', text1: '#3C3229', text2: '#7A6E5F', mode: 'eye' }
  };
  function curTheme() {
    var t = document.documentElement.getAttribute('data-theme');
    return (t === 'light' || t === 'eye') ? t : null;
  }
  function rgb(s) {
    var m = String(s).match(/[\d.]+/g);
    if (!m || m.length < 3) return null;
    return { r: +m[0], g: +m[1], b: +m[2], a: m.length >= 4 ? +m[3] : 1 };
  }
  function effBg(el) {
    var e = el;
    while (e) {
      var p = rgb(getComputedStyle(e).backgroundColor);
      if (p && p.a !== 0) return p;
      e = e.parentElement;
    }
    return null;
  }
  function fix() {
    var theme = curTheme();
    if (!theme) return;
    var pal = PALETTE[theme];
    var nodes = document.querySelectorAll('body *:not(script):not(style):not(canvas):not(svg):not(path)');
    // 第一遍：把深色中性背景刷成目标浅底
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var cs = getComputedStyle(el);
      if (cs.backdropFilter && cs.backdropFilter !== 'none') continue;
      if (/(modal-overlay|modal-backdrop)/.test(el.className || '')) continue;
      var p = rgb(cs.backgroundColor);
      if (p && p.a >= 0.9 && p.r < 65 && p.g < 65 && p.b < 65) {
        el.style.setProperty('background-color', pal.bg, 'important');
      }
    }
    // 第二遍：浅色文字在浅底上改成深色
    for (var j = 0; j < nodes.length; j++) {
      var e2 = nodes[j];
      var c = rgb(getComputedStyle(e2).color);
      if (!c || c.a === 0) continue;
      if (c.r > 135 && c.g > 135 && c.b > 135) {
        var bg = effBg(e2);
        if (!bg || (bg.r > 200 && bg.g > 200 && bg.b > 200)) {
          var dark = (c.r > 220 && c.g > 220 && c.b > 220) ? pal.text1 : pal.text2;
          e2.style.setProperty('color', dark, 'important');
        }
      }
    }
  }
  function run() { try { fix(); } catch (e) {} }
  var debounce = null;
  function schedule() {
    if (debounce) return;
    debounce = setTimeout(function () { debounce = null; run(); }, 120);
  }
  window.addEventListener('load', function () { setTimeout(run, 200); });
  try {
    var mo = new MutationObserver(function () { schedule(); });
    mo.observe(document.documentElement || document.body, { childList: true, subtree: true });
  } catch (e) { setInterval(run, 2000); }
  // 兜底定时（含属性/样式类变化）
  setInterval(run, 3000);
  window.addEventListener('message', function (e) {
    if (e.data && e.data.type === 'wb-theme') setTimeout(run, 50);
  });
})();