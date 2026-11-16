/* WAP-Eavan · device.js
   设备模式：电脑 / 平板 / 手机。只负责模式切换、持久化、提示文案与
   面板抽屉联动；不改动任何运动逻辑与面板业务。
   - 首次访问按「指针类型 + 屏宽」自动选择（粗指针 ≤700px = 手机、
     ≤1366px = 平板，其余电脑），之后以用户手动选择为准（localStorage）。
   - 平板＝画布全幅 + 右侧抽屉；手机＝底部面板 + 浮层重排；
     电脑＝一切维持原样（不加任何布局改动）。
   - 面板（整体模型 / 设备 / 货位）出现时自动展开抽屉 / 底部面板。 */
(function (global) {
  'use strict';
  var WAP = global.WAP = global.WAP || {};
  var D = global.document;
  var KEY = 'wap-eavan.device.v1';
  var MODES = ['pc', 'tablet', 'phone'];
  var NAMES = { pc: '电脑', tablet: '平板', phone: '手机' };
  /* 触屏设备替换首屏提示：鼠标专属说法改为触控手势说法 */
  var TIP_TOUCH = '点击模型显示<b>晶格框块</b> · 再点选中<b>具体个体</b>并弹出面板 · ' +
    '单指拖动旋转视角 · 双指捏合缩放 / 平移';
  var mode = 'pc';

  function load() {
    try {
      var v = global.localStorage && global.localStorage.getItem(KEY);
      return MODES.indexOf(v) >= 0 ? v : null;
    } catch (e) { return null; }
  }
  function save(m) {
    try { global.localStorage && global.localStorage.setItem(KEY, m); } catch (e) { /* ignore */ }
  }

  function detect() {
    var coarse = false;
    try { coarse = global.matchMedia && global.matchMedia('(pointer: coarse)').matches; } catch (e) { /* ignore */ }
    if (!coarse) return 'pc';
    var w = global.innerWidth || 1024;
    if (w <= 700) return 'phone';
    if (w <= 1366) return 'tablet';
    return 'pc';
  }

  function syncSeg() {
    var seg = D.getElementById('deviceSeg');
    if (!seg) return;
    seg.querySelectorAll('[data-dev]').forEach(function (b) {
      var on = b.dataset.dev === mode;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-pressed', String(on));
    });
  }

  function apply(m, silent) {
    mode = m;
    var root = D.documentElement;
    root.dataset.device = m;
    root.classList.remove('sheet-open');     /* 切模式后抽屉一律收起，重新开始 */
    syncSeg();
    var tip = D.getElementById('viewportTip');
    if (tip && m !== 'pc') tip.innerHTML = TIP_TOUCH;
    if (!silent && WAP.ui && WAP.ui.toast) WAP.ui.toast('已切换到' + NAMES[m] + '模式');
    /* 布局类名变化会改变画布尺寸：稍等过渡后重算画面；
       触屏端还按新视口重新取景（PC 模式不改动用户视角）。 */
    global.setTimeout(function () {
      if (WAP.scene && WAP.scene.resize) WAP.scene.resize();
      if (m !== 'pc' && WAP.scene && WAP.scene.growFit && WAP.state && WAP.state.geom) {
        var g = WAP.state.geom;
        WAP.scene.growFit([g.len, g.top, g.tot], true);
      }
    }, 90);
  }

  function set(m) {
    if (MODES.indexOf(m) < 0 || m === mode) return;
    apply(m);
    save(m);
  }

  function openSheet() {
    if (mode === 'pc') return;
    D.documentElement.classList.add('sheet-open');
  }
  function closeSheet() { D.documentElement.classList.remove('sheet-open'); }
  function toggleSheet() {
    if (mode === 'pc') return;
    D.documentElement.classList.toggle('sheet-open');
  }

  /* 控制面板（整体模型 / 设备 / 货位 / 上下文浮层）出现 → 自动展开抽屉。
     只监听 hidden 属性变化，不挂钩任何业务函数，对既有代码零侵入。 */
  function watchPanels() {
    if (!global.MutationObserver) return;
    var ids = ['sideDock', 'ctxPanel', 'devPanel', 'selCard'];
    var obs = new global.MutationObserver(function () {
      for (var i = 0; i < ids.length; i++) {
        var el = D.getElementById(ids[i]);
        if (el && !el.hidden) { openSheet(); return; }
      }
    });
    ids.forEach(function (id) {
      var el = D.getElementById(id);
      if (el) obs.observe(el, { attributes: true, attributeFilter: ['hidden'] });
    });
  }

  function bindChrome() {
    var seg = D.getElementById('deviceSeg');
    if (seg) seg.addEventListener('click', function (e) {
      var b = e.target && e.target.closest ? e.target.closest('[data-dev]') : null;
      if (b) set(b.dataset.dev);
    });
    var fab = D.getElementById('sheetFab');
    if (fab) fab.addEventListener('click', toggleSheet);
    var close = D.getElementById('sbSheetClose');
    if (close) close.addEventListener('click', closeSheet);
  }

  /* 触屏模式下拦截 iOS 页面级捏合（gesturestart/gesturechange），
     画布内的双指由 Pointer Events 接管做相机缩放；电脑模式不拦截。 */
  function blockPageZoom() {
    ['gesturestart', 'gesturechange'].forEach(function (t) {
      D.addEventListener(t, function (e) { if (mode !== 'pc') e.preventDefault(); });
    });
  }

  /* 横竖屏翻转：触屏端视口宽高比突变后强制重新取景（保留视角角度）。
     用「宽>高 翻转」判定，比 orientationchange 事件更可靠。 */
  function watchOrientation() {
    var lw = global.innerWidth, lh = global.innerHeight;
    global.addEventListener('resize', function () {
      var w = global.innerWidth, h = global.innerHeight;
      var flipped = (w > h) !== (lw > lh);
      lw = w; lh = h;
      if (!flipped || mode === 'pc') return;
      global.setTimeout(function () {
        if (WAP.scene && WAP.scene.growFit && WAP.state && WAP.state.geom) {
          var g = WAP.state.geom;
          WAP.scene.growFit([g.len, g.top, g.tot], true);
        }
      }, 120);
    });
  }

  function init() {
    var saved = load();
    apply(saved || detect(), true);
    bindChrome();
    watchPanels();
    watchOrientation();
    blockPageZoom();
  }

  WAP.device = {
    init: init, set: set,
    openSheet: openSheet, closeSheet: closeSheet,
    get mode() { return mode; }
  };
})(window);
