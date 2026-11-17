/* WAP-Eavan · sceneClear.js
   ① 清空场景：带确认的模态框，勾选要删除的项目（复位动画 / 删路线 /
      删设备 / 清外观覆盖），确认后按序清理并一次重建。
   ② 整库操作：整库复制（配置+设备+路线序列化到剪贴板）/ 删除整库（带确认），
      按钮仅晶格网显示时凸显，平时隐藏。
   只调用各模块已公开的 API，不改 sim.js 状态机，不裸移货物。
*/
(function (global) {
  'use strict';
  var WAP = global.WAP = global.WAP || {};
  var D = global.document;
  var SC = { mask: null, ready: false };

  function $(id) { return D.getElementById(id); }
  function toast(m) { if (WAP.ui && WAP.ui.toast) WAP.ui.toast(m); }

  /* ---------- 清空场景 ---------- */
  function openClear() {
    if (!SC.mask) return;
    SC.mask.hidden = false;
    /* 默认勾选常用三项，外观覆盖默认不勾 */
    $('clrAnim').checked = true;
    $('clrRoutes').checked = true;
    $('clrEquip').checked = true;
    $('clrLook').checked = false;
    updateWarn();
  }
  function closeClear() { if (SC.mask) SC.mask.hidden = true; }
  function anyChecked() {
    return ['clrAnim', 'clrRoutes', 'clrEquip', 'clrLook'].some(function (id) {
      var el = $(id); return el && el.checked;
    });
  }
  function updateWarn() {
    var w = $('clearWarn'), btn = $('clearConfirm');
    var any = anyChecked();
    if (w) w.textContent = any
      ? '⚠ 此操作不可撤销，请确认已勾选正确的项目。'
      : '请至少勾选一项要清除的内容。';
    if (btn) btn.disabled = !any;
  }

  function doClear() {
    var cAnim = $('clrAnim') && $('clrAnim').checked;
    var cRoutes = $('clrRoutes') && $('clrRoutes').checked;
    var cEquip = $('clrEquip') && $('clrEquip').checked;
    var cLook = $('clrLook') && $('clrLook').checked;
    if (!cAnim && !cRoutes && !cEquip && !cLook) { toast('请至少勾选一项'); return; }

    /* 1) 复位所有动画：sim.stop 已是级联包装（carrier/flow/pallets/terminals/routes） */
    if (cAnim) {
      try { if (WAP.sim && WAP.sim.stop) WAP.sim.stop(); } catch (e) {}
      try { if (WAP.routes && WAP.routes.stop) WAP.routes.stop(); } catch (e) {}
      try { if (WAP.equipment && WAP.equipment.clearEngaged) WAP.equipment.clearEngaged(); } catch (e) {}
    }
    /* 2) 删路线（公开函数内部已 stop + 重绘） */
    if (cRoutes) {
      try { if (WAP.routes && WAP.routes.clearAllRoutes) WAP.routes.clearAllRoutes(true); } catch (e) {}
    }
    /* 3) 删全部设备（含提升机，同步 cfg.liftCols 并 commit） */
    if (cEquip) {
      try { if (WAP.equipment && WAP.equipment.clearDevices) WAP.equipment.clearDevices(true); } catch (e) {}
    }
    /* 4) 外观与货物覆盖恢复默认 */
    if (cLook) {
      var st = WAP.state;
      st.overrides = {}; st.cargoOverrides = {}; st.cargoClassOverrides = {}; st.shuttleColors = {};
      try { WAP.core.saveCargoOverrides({}); } catch (e) {}
      try { WAP.core.saveCargoClassOverrides({}); } catch (e) {}
      try { WAP.core.saveShuttleColors({}); } catch (e) {}
    }
    /* 一次重建：库体占用/设备/路线/动画全部回到干净状态 */
    try { if (WAP.app && WAP.app.commit) WAP.app.commit(); } catch (e) {}
    closeClear();
    toast('场景已清空（' + describe(cAnim, cRoutes, cEquip, cLook) + '）');
  }
  function describe(a, r, e, l) {
    var parts = [];
    if (a) parts.push('动画已复位');
    if (r) parts.push('路线已删');
    if (e) parts.push('设备已删');
    if (l) parts.push('外观已清');
    return parts.join(' / ');
  }

  /* ---------- 整库复制 / 删除 ---------- */
  function snapshot() {
    var st = WAP.state;
    return {
      _kind: 'wap-eavan-warehouse', _v: 1, _at: Date.now(),
      cfg: WAP.core.clone ? WAP.core.clone(st.cfg) : JSON.parse(JSON.stringify(st.cfg)),
      overrides: st.overrides, cargoOverrides: st.cargoOverrides,
      cargoClassOverrides: st.cargoClassOverrides, shuttleColors: st.shuttleColors,
      devices: snapshotDevices(), routes: snapshotRoutes(),
      loop: WAP.flow && WAP.flow.loop
    };
  }
  function snapshotDevices() {
    try {
      var raw = global.localStorage && global.localStorage.getItem('wap-eavan.equipment.v2');
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }
  function snapshotRoutes() {
    try {
      var raw = global.localStorage && global.localStorage.getItem('wap-eavan.routes.v3');
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  var CLIP_KEY = 'wap-eavan.clipboard.v1';   // 内部剪贴板：不依赖浏览器剪贴板权限，可靠
  function copyAll() {
    var snap = snapshot();
    var text = JSON.stringify(snap);
    /* 主通道：写入内部剪贴板，立即给出可见反馈（按钮态 + toast） */
    var ok = false;
    try { global.localStorage.setItem(CLIP_KEY, text); ok = true; } catch (e) {}
    SC.clip = snap;
    try { if (global.navigator && navigator.clipboard && navigator.clipboard.writeText)
      navigator.clipboard.writeText(text).catch(function () {}); } catch (e) {}
    syncClipButtons();
    var n = (snap.devices && snap.devices.devices ? snap.devices.devices.length : 0);
    toast(ok ? '整库已复制（' + snap.cfg.bays + ' 列 · ' + n + ' 台设备）· 点 📋 可粘贴恢复' : '整库已复制到当前会话');
  }
  function pasteAll() {
    var raw = null;
    try { raw = global.localStorage.getItem(CLIP_KEY); } catch (e) {}
    if (!raw && SC.clip) raw = JSON.stringify(SC.clip);
    if (!raw) { toast('剪贴板为空，请先点 ⧉ 复制整库'); return; }
    var snap = null;
    try { snap = JSON.parse(raw); } catch (e) {}
    if (!snap || !snap.cfg) { toast('剪贴板内容无效'); return; }
    applySnapshot(snap);
    toast('整库已粘贴恢复（' + snap.cfg.bays + ' 列）');
  }
  /* 把一份快照写回 state / localStorage 并一次重建；复制/粘贴共用 */
  function applySnapshot(snap) {
    try { if (WAP.sim && WAP.sim.stop) WAP.sim.stop(); } catch (e) {}
    try { if (WAP.routes && WAP.routes.clearAllRoutes) WAP.routes.clearAllRoutes(true); } catch (e) {}
    try { if (WAP.equipment && WAP.equipment.clearDevices) WAP.equipment.clearDevices(true); } catch (e) {}
    var st = WAP.state;
    st.overrides = snap.overrides || {}; st.cargoOverrides = snap.cargoOverrides || {};
    st.cargoClassOverrides = snap.cargoClassOverrides || {}; st.shuttleColors = snap.shuttleColors || {};
    try { WAP.core.saveCargoOverrides(st.cargoOverrides); WAP.core.saveCargoClassOverrides(st.cargoClassOverrides); WAP.core.saveShuttleColors(st.shuttleColors); } catch (e) {}
    st.cfg = WAP.core.normalize(WAP.core.clone(snap.cfg));
    try { WAP.core.save(st.cfg); } catch (e) {}
    /* 还原设备 / 路线 localStorage（在 commit 重建前写回，onRebuild 会读取） */
    try { if (snap.devices) global.localStorage.setItem('wap-eavan.equipment.v2', JSON.stringify(snap.devices)); } catch (e) {}
    try { if (snap.routes) global.localStorage.setItem('wap-eavan.routes.v3', JSON.stringify(snap.routes)); } catch (e) {}
    try { if (WAP.equipment && WAP.equipment.load) WAP.equipment.load(); } catch (e) {}
    try { if (WAP.routes && WAP.routes.load) WAP.routes.load(); } catch (e) {}
    try { if (WAP.app && WAP.app.commit) WAP.app.commit(); } catch (e) {}
  }
  /* 粘贴按钮可用态：剪贴板有内容才亮 */
  function syncClipButtons() {
    var btn = $('btnPasteAll'); if (!btn) return;
    var has = false;
    try { has = !!(global.localStorage && global.localStorage.getItem(CLIP_KEY)); } catch (e) { has = !!SC.clip; }
    btn.classList.toggle('has-clip', has);
    btn.disabled = !has;
  }

  function deleteAll() {
    /* 点击即删：无二次确认（顶部 ⌫ 清空场景才是带勾选的确认入口） */
    try { if (WAP.sim && WAP.sim.stop) WAP.sim.stop(); } catch (e) {}
    try { if (WAP.routes && WAP.routes.clearAllRoutes) WAP.routes.clearAllRoutes(true); } catch (e) {}
    try { if (WAP.equipment && WAP.equipment.clearDevices) WAP.equipment.clearDevices(true); } catch (e) {}
    var st = WAP.state;
    st.overrides = {}; st.cargoOverrides = {}; st.cargoClassOverrides = {}; st.shuttleColors = {};
    try { WAP.core.saveCargoOverrides({}); WAP.core.saveCargoClassOverrides({}); WAP.core.saveShuttleColors({}); } catch (e) {}
    var fresh = WAP.core.clone(WAP.core.DEFAULT);
    st.cfg = fresh;
    try { WAP.core.save(fresh); } catch (e) {}
    try { if (WAP.app && WAP.app.commit) WAP.app.commit(); } catch (e) {}
    toast('整库已删除，已恢复默认空库（点 📋 可粘贴恢复）');
  }

  /* ---------- 晶格显隐 → 整库按钮凸显 ---------- */
  function syncBulk() {
    var box = $('rackBulk'); if (!box) return;
    var st = WAP.state;
    var show = !!(st.selection && st.selection.rack && !st.selection.crystalHidden && st.view && st.view.crystal);
    box.classList.toggle('show', show);
  }

  function bind() {
    var btn = $('btnClearScene');
    if (btn) btn.addEventListener('click', openClear);
    if ($('clearCancel')) $('clearCancel').addEventListener('click', closeClear);
    if ($('clearCancelTop')) $('clearCancelTop').addEventListener('click', closeClear);
    if ($('clearConfirm')) $('clearConfirm').addEventListener('click', doClear);
    if (SC.mask) SC.mask.addEventListener('click', function (e) { if (e.target === SC.mask) closeClear(); });
    ['clrAnim', 'clrRoutes', 'clrEquip', 'clrLook'].forEach(function (id) {
      var el = $(id); if (el) el.addEventListener('change', updateWarn);
    });
    global.addEventListener('keydown', function (e) {
      if (SC.mask && !SC.mask.hidden && e.key === 'Escape') closeClear();
    });

    /* 顶栏常驻整库按钮：点击即执行，不再依赖晶格显隐 */
    if ($('btnCopyAll')) $('btnCopyAll').addEventListener('click', copyAll);
    if ($('btnPasteAll')) $('btnPasteAll').addEventListener('click', pasteAll);
    if ($('btnDelAll')) $('btnDelAll').addEventListener('click', deleteAll);
    /* 晶格区旧按钮仍指向同一函数（保留原入口） */
    if ($('btnRackCopy')) $('btnRackCopy').addEventListener('click', copyAll);
    if ($('btnRackDelete')) $('btnRackDelete').addEventListener('click', deleteAll);

    /* 挂到 commit 之后的 UI 同步：晶格显隐变化时更新整库按钮 */
    var prevCommit = WAP.app && WAP.app.commit;
    if (prevCommit) {
      WAP.app.commit = function (keep) { var r = prevCommit(keep); syncBulk(); return r; };
    }
    /* 视图开关 / 选中变化也同步（用轻量轮询首帧 + 视图按钮点击） */
    ['btnCrystal', 'btnFrame', 'btnCargo'].forEach(function (id) {
      var el = $(id); if (el) el.addEventListener('click', function () { global.setTimeout(syncBulk, 0); });
    });
    var vp = $('viewport');
    if (vp) vp.addEventListener('pointerup', function () { global.setTimeout(syncBulk, 0); });
  }

  function init() {
    if (SC.ready) return;
    SC.mask = $('clearMask');
    bind(); syncBulk(); syncClipButtons();
    SC.ready = true;
  }

  WAP.sceneClear = { init: init, open: openClear, syncBulk: syncBulk };
})(window);
