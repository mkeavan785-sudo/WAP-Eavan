/* WAP-Eavan · app.js
   装配与启动：数据 → 场景 → 模型 → 界面 → 拾取交互。 */
(function (global) {
  'use strict';
  var WAP = global.WAP;
  var D = global.document;
  var $ = function (id) { return D.getElementById(id); };

  var App = {
    ready: false,
    commitTimer: null
  };

  function visibleChain(o) {
    while (o) {
      if (o.visible === false) return false;
      o = o.parent;
    }
    return true;
  }

  /* 统一提交：重建模型 + 刷新界面 + 持久化 */
  function commit(keepSelection) {
    var st = WAP.state;
    var c = WAP.core.normalize(st.cfg);
    st.cfg = c;
    WAP.core.save(c);
    var r = WAP.rack.rebuild();
    WAP.ui.refresh();

    if (!keepSelection && st.selection.cell && !r.cellById[st.selection.cell]) {
      st.selection.cell = null;
    }
    WAP.rack.applyView();
    if (st.selection.cell && r.cellById[st.selection.cell]) WAP.ui.showCell(st.selection.cell);
    else WAP.ui.hideCell();
    if (!(WAP.handles && WAP.handles.dragging) && !WAP.transform.active && !(WAP.transform && WAP.transform.dragging)) {
      $('viewBadgeTxt').textContent = st.selection.rack
        ? (st.selection.crystalHidden ? '已选中具体个体 · 晶格暂时隐藏' : '晶格框块已显示 · 拖拽控制点可改尺寸')
        : (st.view.mode === 'move' ? '移动模式' : '旋转模式');
    }
  }

  var PART_NAME = {
    cell: '货位 / 货物', cargo: '货物', frame: '货架结构',
    shuttle: '四向穿梭车', lift: '提升机', conveyor: '层间输送设备',
    equipment: '输送设备'
  };

  /* 两段式点击交互：
     ① 第一次点模型 → 显示晶格框块，弹出「整体建构 + 运行仿真」控制面板；
     ② 再点模型 → 暂时隐藏晶格，选中点击到的具体小个体（货架 / 货物 / 四向车 /
        提升机 / 输送设备），弹出与之对应的完整控制面板，位置靠近模型但不遮挡；
     ③ 点击空白处 → 清除选中并关闭浮层。 */
  function onPick(ndc) {
    var p = WAP.scene.pickPart(ndc);
    if (!p || !visibleChain(p.hit.object)) { clearSelection(); return; }
    var sel = WAP.state.selection;
    var screen = WAP.scene.project(p.point);

    if (!sel.phase) {
      sel.phase = 1; sel.rack = true; sel.crystalHidden = false;
      sel.cell = null; sel.part = null;
      WAP.rack.applyView();
      WAP.ui.hideCell();
      WAP.ctx.open('rack', screen);
      WAP.ui.toast('已显示晶格框块 · 拖拽彩色控制点可调整长宽高');
      $('viewBadgeTxt').textContent = '晶格框块已显示 · 拖拽控制点可改尺寸';
      $('sbSel').textContent = '已选中四向库（晶格已显示）';
      fadeTip();
      return;
    }

    sel.phase = 2; sel.rack = true; sel.crystalHidden = true;
    sel.cell = null; sel.part = p.kind;
    WAP.rack.applyView();

    /* 库内提升机与设备栏提升机是同一台设备：点塔身直接进入同一控制面板 */
    if (p.kind === 'lift' && WAP.equipment) {
      var o = p.hit.object, lid = null;
      while (o && !lid) { lid = o.userData && o.userData.liftId; o = o.parent; }
      if (lid && WAP.equipment.selectLift(lid)) {
        sel.part = 'equipment';
        WAP.ui.hideCell();
        $('viewBadgeTxt').textContent = '已选中具体个体 · 提升机';
        $('sbSel').textContent = '已选中：' + lid;
        return;
      }
    }

    WAP.ctx.open(p.kind, screen);

    /* 点击四向车：找出具体是哪台车（沿命中对象向上找 sim.devices 的 obj），
       打开「换颜色」面板，换色只替换车身材质，不动运动状态机。 */
    if (p.kind === 'shuttle') {
      var node = p.hit.object, agent = null;
      var devs = (WAP.sim && WAP.sim.devices) || [];
      while (node && !agent) {
        agent = devs.filter(function (a) { return a.obj === node; })[0] || null;
        node = node.parent;
      }
      WAP.ui.showShuttlePanel(agent ? agent.id : null);
    } else WAP.ui.showShuttlePanel(null);

    if (p.kind === 'cell' || p.kind === 'cargo') {
      var cid = p.cellId;
      if (!cid && p.hit.instanceId != null) {
        var cids = p.hit.object.userData && p.hit.object.userData.cids;
        if (cids && cids[p.hit.instanceId]) cid = cids[p.hit.instanceId];
      }
      var r = WAP.rack.current;
      if (cid && r && r.cellById[cid]) {
        sel.cell = cid;
        WAP.ui.showCell(cid);
      } else {
        WAP.ui.hideCell();
        $('sbSel').textContent = '已选中：' + (PART_NAME[p.kind] || p.kind);
      }
    } else {
      WAP.ui.hideCell();
      $('sbSel').textContent = '已选中：' + (PART_NAME[p.kind] || p.kind);
    }
    $('viewBadgeTxt').textContent = '已选中具体个体 · ' + (PART_NAME[p.kind] || p.kind);
  }

  function clearSelection() {
    var sel = WAP.state.selection;
    sel.phase = 0; sel.rack = false; sel.crystalHidden = false;
    sel.cell = null; sel.part = null; sel.shuttleId = null;
    WAP.rack.applyView();
    WAP.ui.hideCell();
    WAP.ctx.close();
    if (WAP.equipment) WAP.equipment.deselect();
    $('viewBadgeTxt').textContent = '透视视图';
    $('sbSel').textContent = '未选中对象';
  }

  var tipFaded = false;
  function fadeTip() {
    if (tipFaded) return;
    tipFaded = true;
    global.setTimeout(function () { $('viewportTip').classList.add('hide'); }, 2600);
  }

  function bindKeys() {
    D.addEventListener('keydown', function (e) {
      if (/^(INPUT|TEXTAREA|SELECT)$/.test((e.target.tagName || '').toUpperCase())) return;
      if (e.key === 'Escape') {
        clearSelection();
      } else if (e.key === '1') WAP.ui.cameraMode('move');
      else if (e.key === '2') WAP.ui.cameraMode('rotate');
      else if (e.key === 'p' || e.key === 'P') WAP.sim.toggle();
      else if (e.key === 'o' || e.key === 'O') WAP.sim.stepOnce();
      else if (e.key === 'f' || e.key === 'F') {
        var g = WAP.state.geom; WAP.scene.fit([g.len, g.top, g.tot]);
      }
    });
  }

  function boot() {
    var canvas = $('c'), viewport = $('viewport');
    WAP.state.cfg = WAP.core.load();
    WAP.state.cargoOverrides = WAP.core.loadCargoOverrides();
    WAP.state.cargoClassOverrides = WAP.core.loadCargoClassOverrides();
    WAP.state.shuttleColors = WAP.core.loadShuttleColors();
    WAP.scene.init(canvas, viewport);
    WAP.handles.init();
    WAP.transform.init();
    WAP.ui.init();
    WAP.scene.S.onPick = onPick;
    commit(false);
    WAP.sim.init();          // 挂逐帧时钟并按当前库体装配设备
    WAP.equipment.init();    // 输送设备系统：包装 onTick / onRebuild，不改动 sim.js
    WAP.routes.init();       // 输送线路线设计：仅包装 onTick，不改动 sim.js 运动逻辑
    WAP.flow.init();         // 守恒作业调度：按路线创建承载体作业
    WAP.terminals.init();    // 发货器 / 收货器：按路线吐货、到点收走
    WAP.carrier.init();      // 设备职能执行器（包装 onTick，覆盖 sim 的载货台回落）
    WAP.pallets.init();      // 拆叠盘机托盘收集 / 拆分（最后包装 onTick，读取最终货物状态）
    var g = WAP.state.geom;
    WAP.scene.fit([g.len, g.top, g.tot]);
    bindKeys();
    App.ready = true;
    global.setTimeout(function () { $('loading').classList.add('done'); }, 260);
    global.setTimeout(fadeTip, 7000);
  }

  WAP.app = { commit: commit, boot: boot, clearSelection: clearSelection, get ready() { return App.ready; } };

  if (D.readyState === 'loading') D.addEventListener('DOMContentLoaded', boot);
  else boot();
})(window);
