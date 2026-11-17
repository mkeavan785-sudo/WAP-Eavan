/* WAP-Eavan · physics.js
   物理规则仿真模块（FWS-H150 四向穿梭车厂家参数）。

   总开关 cfg.physicsMode（默认关）：关闭时一切运动与现状逐帧一致；
   开启后生效：
     · 载重质量连续插值加速度与极速（空载 1.0 m/s²/1.2 m/s → 满载 0.5/0.9，
       主通道长直道允许冲到峰值 1.5/1.2），车自重 330kg 已含在厂家空/满载数据里；
     · 轴向换向驻留 2s（轮盘 90°，四向车本体不转向）；
     · 顶升台板 40mm ≈ 2s（0.02 m/s）；
     · 主通道防撞避让：同向跟车 1.4m 安全间距、对向按「作业车 > 巡航车、
       编号小者先行」裁决路权，输家让位倒车（2 格 + 停 1.6s）；
     · 超载 1.5T 拒载（按货物大类质量：无托盘单货物 / 子母托盘吃 cfg.kg，
       光子托盘 18kg / 光母托盘 28kg），超限报警红闪 + 跳过该货位。
   参数档 cfg.simPreset：demo = 现有快节奏（2.56/1.6 m/s），real = 厂家参数。

   接入范围（全部经 WAP.physics.enabled 门控，关闭时零开销零行为差）：
     sim.js —— stepAgent 的 V/Ta 来源、顶升速度、换向保持、route() 的避让
               until、gen() 超载过滤、警示灯、快照 kg（任务生成层与参数注入，
               运动状态机结构零改动）；
     carrier.js —— moveCarAlong 走 physics.advance / 换向 / 避让；
     flow.js —— 选格超载过滤；flow.plan 巡航任务由本模块包装挂避让。 */
(function (global) {
  'use strict';
  var WAP = global.WAP = global.WAP || {};
  var clamp = WAP.core.clamp;

  /* ---------- 厂家参数档（FWS-H150 · 2025 年型更改点：加速度 1.0/0.5） ---------- */
  var PRESET = {
    demo: { vE: 2.56, vL: 1.60, aE: 1.6, aL: 1.0, peakE: 2.56, peakL: 1.60 },
    real: { vE: 1.10, vL: 0.90, aE: 1.0, aL: 0.5, peakE: 1.50, peakL: 1.20 }
  };
  var TURN_TIME = 2.0;          // 换向时间 s（轮盘 90°）
  var FORK_SPEED = 0.02;        // 顶升 40mm ≈ 2s
  var CAP_KG = 1500;            // 额定载重 kg
  var PALLET_KG = { sub: 18, mother: 28 };
  var FOLLOW_GAP = 1.4;         // 同向跟车安全间距 m
  var HEADON_GAP = 3.2;         // 对向让位触发距离 m
  var TRACK_TOL = 0.75;         // 同巷道判定横向容差 m
  var DODGE_CELLS = 2;          // 让位倒车格数
  var DODGE_HOLD = 1.6;         // 让行等待 s
  var DODGE_COOLDOWN = 6;       // 两次让位之间的防抖 s
  var BLOCK_WARN = 20;          // 静置挡路等待提醒阈值 s

  function on() {
    return !!(WAP.state && WAP.state.cfg && WAP.state.cfg.physicsMode);
  }
  function presetName() {
    return (WAP.state.cfg && WAP.state.cfg.simPreset) === 'real' ? 'real' : 'demo';
  }
  function preset() { return PRESET[presetName()]; }
  function cfg() { return WAP.state.cfg || {}; }
  function geom() { return WAP.state.geom; }
  function devices() { return (WAP.sim && WAP.sim.devices) || []; }
  function now() {
    return (global.performance && global.performance.now) ? global.performance.now() / 1000 : Date.now() / 1000;
  }

  /* ---------- 载重质量模型（按货物大类） ---------- */
  function cellClass(cell) {
    var st = WAP.state;
    if (cell && st.cargoClassOverrides && st.cargoClassOverrides[cell.id]) {
      return st.cargoClassOverrides[cell.id];
    }
    var g = cfg().cargoClass || 'goods';
    return WAP.core.CARGO_CLASS_ALIAS[g] || g;
  }
  /* 质量按「货物/子托/母托」三层组合计算，与 7 大类定义同源 */
  function classKg(cls) {
    var def = WAP.core.CARGO_CLASS_DEF[cls] || WAP.core.CARGO_CLASS_DEF.goods;
    var kg = 0;
    if (def.goods) kg += (cfg().kg || 800);
    if (def.sub) kg += PALLET_KG.sub;
    if (def.mother) kg += PALLET_KG.mother;
    return kg;
  }
  function cargoKg(cell) { return classKg(cellClass(cell)); }
  /* 货物 / 托盘单元的自身质量（读 stamp，未 stamp 时按大类现算）。
     这是运行态「货物有质量、托盘有质量」的唯一读取入口。 */
  function unitMass(unit) {
    if (!unit) return 0;
    var ud = unit.userData || {};
    if (ud.massKg != null) return ud.massKg;
    if (ud.palletClass) return classKg(ud.palletClass);
    if (ud.cargoClass) return classKg(ud.cargoClass);
    return 0;
  }
  function cellById(id) {
    if (!id) return null;
    var cur = WAP.rack && WAP.rack.current;
    if (cur && cur.cellById && cur.cellById[id]) return cur.cellById[id];
    var g = geom(), hit = null;
    ((g && g.cells) || []).some(function (c) { if (c.id === id) { hit = c; return true; } return false; });
    return hit;
  }
  /* runner 载重：出库看源货位、入库看目标货位（守恒模式） */
  function runnerKg(r) {
    if (!r || !r.meta) return null;
    var cell = cellById(r.meta.srcId) || cellById(r.meta.dstId);
    return cell ? cargoKg(cell) : null;
  }
  /* 四向车当前载重 kg：0 = 空载 */
  function massOf(a) {
    if (!a) return 0;
    if (a._borrowed) {
      var car = a._carRef;
      if (car && car.r && car.r.taken) {
        return (car.r.unit && car.r.unit.userData && car.r.unit.userData.massKg != null)
          ? car.r.unit.userData.massKg : (runnerKg(car.r) || cfg().kg || 800);
      }
      return 0;
    }
    if (a.carry) return unitMass(a.carry) || (a.task && a.task.cell ? cargoKg(a.task.cell) : cfg().kg || 800);
    return 0;
  }
  function overloaded(cell) { return on() && cargoKg(cell) > CAP_KG; }
  /* 超载拒载告警（节流 5s）：flow 选格全部被过滤时调用 */
  var _ovAt = 0;
  function noteOverloadBlock() {
    if (!on()) return false;
    var t0 = now();
    if (t0 - _ovAt < 5) return false;
    _ovAt = t0;
    if (WAP.sim && WAP.sim.log) WAP.sim.log('warn', '超载拒载：额定 1.5T，超限货物所在货位已跳过（或无可作业货位）');
    if (WAP.ui && WAP.ui.toast) WAP.ui.toast('物理模式 · 超载拒载生效（额定 1.5T，超限货位已跳过）');
    return true;
  }
  function stampLoad(a, cell) {
    if (a && a.carry) a.carry.userData.massKg = cargoKg(cell);
  }

  /* ---------- 运动规划：返回 {V, Ta} 喂给 sim.spR / carrier.advance ----------
     spR 的 S 曲线峰值加速度 ≈ 1.5V/Ta，令其等于当前载重对应的 a0 → Ta = 1.5V/a0。 */
  function plan(a, d, kg) {
    var p = preset();
    var m = clamp(kg != null ? kg : massOf(a), 0, CAP_KG);
    var u = m / CAP_KG;                                  // 0 空载 → 1 满载
    var v0 = p.vE + (p.vL - p.vE) * u;
    var a0 = p.aE + (p.aL - p.aE) * u;
    var pk = p.peakE + (p.peakL - p.peakE) * u;
    var V = (d >= 8 && pk > v0) ? pk : v0;               // 长直道冲刺峰值
    return { V: V, Ta: 1.5 * V / a0 };
  }
  /* 顶升台板速度：物理开 = 40mm/2s，关 = 原值 */
  function forkSpeed() { return on() ? FORK_SPEED : 0.16; }

  /* ---------- 通用 S 曲线推进（carrier 用；数学与 sim.spR 一致） ---------- */
  function advance(st, d, V, Ta, dt) {
    if (!st.init) {
      var v = V, ta = Ta;
      if (d < V * Ta) { v = Math.sqrt(d * V / Ta); ta = Ta * v / V; }
      st.init = true; st.D = d; st.V = v; st.ta = ta;
      st.T = 2 * ta + (d - v * ta) / v; st.time = 0; st.done = 0;
    }
    st.time += dt;
    var S1 = function (u) { return u * u * u - u * u * u * u / 2; };
    var tt = Math.min(st.time, st.T);
    var s = tt < st.ta ? st.V * st.ta * S1(tt / st.ta)
      : (tt > st.T - st.ta ? st.D - st.V * st.ta * S1((st.T - tt) / st.ta)
        : st.V * st.ta / 2 + st.V * (tt - st.ta));
    var dd = s - st.done; st.done = s;
    if (st.time >= st.T) return d;
    return Math.max(0, Math.min(dd, d));
  }

  /* ---------- 换向驻留（轮盘 90°，本体不转向） ---------- */
  /* sim.stepAgent 每帧询问：新任务主轴与上一执行轴不同 → 停 2s 再走 */
  function turnHold(a, t, dx, dz, d, dt) {
    if (a._holdT !== t) {
      a._holdT = t;
      a._axis = Math.abs(dx) >= Math.abs(dz) ? 'x' : 'z';
      a._moved = d > 0.05;
      a._turn = (a.pAxis && a.pAxis !== a._axis && a._moved) ? TURN_TIME : 0;
    }
    if (a._turn > 0) { a._turn -= dt; return true; }
    return false;
  }
  /* 任务完成时回写上一执行轴 */
  function noteDone(a, t) {
    if (a._holdT === t && a._moved) a.pAxis = a._axis;
  }
  /* carrier 腿间换向：换腿时轴向改变 → 驻留 */
  function legHold(car, leg, dt) {
    if (car._leg !== leg) {
      car._leg = leg;
      var dx = Math.abs(leg.x - car.a.p.x), dz = Math.abs(leg.z - car.a.p.z);
      car._legAxis = dx >= dz ? 'x' : 'z';
      car._turn = (car.pAxis && car.pAxis !== car._legAxis) ? TURN_TIME : 0;
    }
    if (car._turn > 0) { car._turn -= dt; return true; }
    return false;
  }
  function legDone(car, leg) {
    if (car._leg === leg) car.pAxis = car._legAxis;
  }

  /* ---------- 主通道防撞避让 ---------- */
  function roleOf(a) {
    if (a._borrowed) return 2;                    // carrier 借用的作业车
    if (a.task && !a.task.flow) return 2;         // sim 作业车
    return 1;                                     // 巡航 / 待命
  }
  function idNum(a) { return parseInt((a.id || 'SC-99').slice(3), 10) || 99; }
  function beats(me, opp) {
    var rm = roleOf(me), ro = roleOf(opp);
    if (rm !== ro) return rm > ro;
    return idNum(me) < idNum(opp);                // 同级：编号小者先行
  }
  /* 对手当前的主通道运动意图（0 = 静置 / 非主通道运动） */
  function curXTarget(o) {
    if (o._borrowed) return o._carX != null ? o._carX : null;
    var t = o.q && o.q[0];
    if (t && t.x != null && !t.zTrack) return t.x;
    return null;
  }
  function laneOpponent(a, tx) {
    var lo = Math.min(a.p.x, tx) - 0.3, hi = Math.max(a.p.x, tx) + 0.3;
    var best = null, bd = 1e9;
    devices().forEach(function (o) {
      if (o === a || o.L !== a.L) return;
      if (Math.abs(o.p.z - a.p.z) > TRACK_TOL) return;
      if (o.p.x < lo || o.p.x > hi) return;
      var d = Math.abs(o.p.x - a.p.x);
      if (d < bd) { bd = d; best = o; }
    });
    return best;
  }
  /* 让位倒车：sim 任务队列 / carrier 腿序列两条上下文 */
  function dodge(a, opp) {
    var back = -Math.sign(opp.p.x - a.p.x) || 1;
    var g = geom();
    if (!g) return false;
    var t0 = now();
    if (a._dodgeAt && t0 - a._dodgeAt < DODGE_COOLDOWN) return false;
    a._dodgeAt = t0;
    var bayW = cfg().bayW || 1.4;
    var x0 = g.x0 || 0;
    var backX = clamp(a.p.x + back * DODGE_CELLS * bayW, x0 + 0.4, x0 + (g.len || 10) - 0.4);
    if (Math.abs(backX - a.p.x) < 0.3) return false;
    if (a._borrowed && a._carRef) {
      var c = a._carRef;
      c.legs.splice(c.li, 0,
        { x: backX, z: a.p.z, tag: '让位倒车' },
        { x: backX, z: a.p.z, tag: '让行等待', hold: DODGE_HOLD });
    } else {
      var cur = a.q.shift();
      if (cur) a.q.unshift({ x: backX, st: '让位倒车' }, { wait: DODGE_HOLD, st: '让行等待' }, cur);
    }
    if (WAP.ui && WAP.ui.toast) WAP.ui.toast(a.name + ' 检测对向来车，让位倒车避让');
    return true;
  }
  /* 是否被挡：被挡返回 true（调用方原地等待 / 让位） */
  function laneBlocked(a, tx) {
    var opp = laneOpponent(a, tx);
    if (!opp) return false;
    var myDir = Math.sign(tx - a.p.x) || 1;
    var oDir = 0;
    var oTx = curXTarget(opp);
    if (oTx != null && Math.abs(oTx - opp.p.x) > 0.02) oDir = Math.sign(oTx - opp.p.x);
    var gap = Math.abs(opp.p.x - a.p.x);
    var towardMe = oDir !== 0 && Math.sign(a.p.x - opp.p.x) === oDir;
    if (oDir === myDir && Math.sign(opp.p.x - a.p.x) === myDir) {
      if (gap < FOLLOW_GAP) { blockWarn(a, opp); return true; }   // 同向追尾
      return false;
    }
    if (towardMe) {
      if (beats(a, opp)) { blockWarn(a, opp); return true; }      // 有路权：等对手让位退出
      dodge(a, opp);                                              // 没路权：倒车让位
      return true;
    }
    /* 静置 / 让位中挡路：若互堵且我该让 → 让位；否则等待其任务推进 */
    if (oTx != null) {
      var oOpp = laneOpponent(opp, oTx);
      if (oOpp === a && !beats(a, opp)) { dodge(a, opp); return true; }
    }
    blockWarn(a, opp);
    return true;
  }
  function blockWarn(a, opp) {
    var t0 = now();
    if (!a._blockAt) a._blockAt = t0;
    else if (t0 - a._blockAt > BLOCK_WARN) {
      a._blockAt = t0;
      if (WAP.ui && WAP.ui.toast) WAP.ui.toast(a.name + ' 等待前方 ' + opp.name + ' 让行');
    }
  }
  /* sim.route() 的主通道任务挂此 until；flow.plan 巡航任务由包装器挂同款 */
  function laneUntil(a, task) {
    return function () { return !laneBlocked(a, task.x); };
  }

  /* ---------- UI：物理开关 + 参数档（运行仿真卡内，physics 自包含） ---------- */
  function syncUI() {
    var b = global.document.getElementById('btnPhys');
    if (b) {
      var v = on();
      b.classList.toggle('is-on', v);
      b.setAttribute('aria-pressed', String(v));
      b.innerHTML = '⚗ 物理规则仿真：' + (v ? '开' : '关');
    }
    var seg = global.document.getElementById('simPreset');
    if (seg) seg.querySelectorAll('[data-preset]').forEach(function (x) {
      x.classList.toggle('is-on', x.dataset.preset === presetName());
    });
    var tip = global.document.getElementById('physTip');
    if (tip) tip.innerHTML = on()
      ? '已启用：质量插值加减速 · 换向 2s · 顶升 2s · 主通道避让 · 超载 1.5T 拒载（当前档：' +
        (presetName() === 'real' ? '真实 FWS-H150' : '演示') + '）'
      : '关闭中（与原行为一致）；开启后按当前参数档计算质量、换向、避让与拒载';
  }
  function bindUI() {
    var D = global.document;
    var b = D.getElementById('btnPhys');
    if (b) b.addEventListener('click', function () {
      cfg().physicsMode = !on();
      try { WAP.core.save(cfg()); } catch (e) { /* ignore */ }
      syncUI();
      if (WAP.ui && WAP.ui.toast) WAP.ui.toast('物理规则仿真已' + (on() ? '开启' : '关闭') + '（对后续动作生效）');
    });
    var seg = D.getElementById('simPreset');
    if (seg) seg.addEventListener('click', function (e) {
      var t = e.target && e.target.closest ? e.target.closest('[data-preset]') : null;
      if (!t) return;
      cfg().simPreset = t.dataset.preset;
      try { WAP.core.save(cfg()); } catch (e2) { /* ignore */ }
      syncUI();
      if (WAP.ui && WAP.ui.toast) WAP.ui.toast('参数档切换：' +
        (t.dataset.preset === 'real' ? '真实 FWS-H150（1.5T · 空载 1.2 / 满载 0.9 m/s · a 1.0/0.5）' : '演示快节奏'));
    });
  }
  /* 守恒巡航任务包装：flow.plan 新推的主通道任务挂避让 until */
  function wrapFlow() {
    if (!WAP.flow || !WAP.flow.plan || WAP.flow._phWrap) return;
    WAP.flow._phWrap = true;
    var fp = WAP.flow.plan;
    WAP.flow.plan = function (a) {
      var len0 = (a.q || []).length;
      var r = fp.call(WAP.flow, a);
      if (r && on()) {
        for (var i = len0; i < (a.q || []).length; i++) {
          var t = a.q[i];
          if (t && t.x != null && !t.zTrack && !t.until) t.until = laneUntil(a, t);
        }
      }
      return r;
    };
  }
  function init() {
    bindUI();
    syncUI();
    wrapFlow();
  }

  WAP.physics = {
    init: init, syncUI: syncUI,
    on: on, plan: plan, advance: advance, forkSpeed: forkSpeed,
    turnHold: turnHold, noteDone: noteDone, legHold: legHold, legDone: legDone,
    laneBlocked: laneBlocked, laneUntil: laneUntil,
    cargoKg: cargoKg, classKg: classKg, unitMass: unitMass,
    palletKg: PALLET_KG,
    runnerKg: runnerKg, massOf: massOf,
    overloaded: overloaded, stampLoad: stampLoad, noteOverloadBlock: noteOverloadBlock,
    get enabled() { return on(); },
    get CAP_KG() { return CAP_KG; }
  };
})(window);
