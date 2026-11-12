/* WAP-Eavan · flow.js (v2)
   守恒作业调度器：运行仿真不再凭空生成 / 删除货物，且**严格依据路线 + 真实承载体**作业。

   用户规则：
   · 开启仿真后货物总量恒定 = 货架货位 + 输送线/地面 + 在途。
   · 所有动作来自 WAP.routes 的预设路线（autoVariants），不再随机入/出库，
     不再由本模块自己平移货物；货物移动统一交给 WAP.carrier：
       货架内水平 → 真实四向车；上下 → 提升机载货台；
       货架外 → 场景输送设备；无设备接 → 重力落地静止。
   · 提升机地面有输送线 → 高优先级运「至多 2 件」货物到线终点；
     没有输送线或终点已满 → 改做不同楼层调拨（同样走四向车/提升机）。
   · 一台设备同一时刻只转运一件货物（互斥锁由 carrier 统一维护）。
   · 「返程循环」默认关：货物到终点静止；开启后才从线终点原路运回货架。
   · 存在发货器 / 收货器时进入开放模式，总量可增可减，不做守恒自愈。

   约束：sim.js 运动状态机一行不动；本模块只在 gen() 任务生成处接管，
   并把在途货物交给 carrier 执行器。 */
(function (global) {
  'use strict';
  var WAP = global.WAP = global.WAP || {};
  var T = global.THREE;
  var D = global.document;
  var $ = function (id) { return D.getElementById(id); };
  var STORE = 'wap-eavan.flow.v1';

  var LINE_CAP = 2;
  var CONVEY_Y = 0.86;
  var LAND_Y = 0.02;
  var CELL = 2.0;

  var F = {
    ready: false,
    conserve: true,
    open: false,
    loop: false,
    root: null,
    pool: [],               // 静止在输送线终点 / 地面（unit 由 carrier 托管）
    seq: 1, jobSeq: 0, cruiseIdx: 0, seed: 11,
    baseline: null, delivered: 0, relocated: 0, cycles: 0,
    lastPlaying: false, t: 0,
    /* 未开启循环时，已送达终点的设计路线不再重复派工 */
    doneRoutes: {}, priority: 'designed',
    locks: {}, conflicts: 0, overlaps: 0
  };

  function cfg() { return WAP.state.cfg; }
  function geom() { return WAP.state.geom; }
  function rack() { return WAP.rack; }
  function sim() { return WAP.sim; }
  function routes() { return WAP.routes; }
  function eq() { return WAP.equipment; }
  function carrier() { return WAP.carrier; }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function levelY(l) { var c = cfg(); return c.y0 + clamp(l, 0, c.levels - 1) * c.pitch; }
  function toast(m) { if (WAP.ui && WAP.ui.toast) WAP.ui.toast(m); }
  function insideRack(x, z) {
    var g = geom();
    return !!g && x > g.x0 - 0.15 && x < g.x1 + 0.15 && z > g.z0 - 0.15 && z < g.z1 + 0.15;
  }
  function setOcc(id, occ) { return !!(carrier() && carrier().setOcc(id, occ)); }

  /* ---------------- 守恒账本 ---------------- */
  function spawn(kind) {
    var u = rack().makeCargoUnit(kind || 'carton', F.seed++);
    u.userData.kind = 'flowCargo';
    return u;
  }
  function inTransit() {
    var c = carrier();
    return c ? (c.count('flow').active || 0) : 0;
  }
  function total() { return (geom() ? geom().used : 0) + F.pool.length + inTransit(); }
  function baseline() { if (F.baseline == null) F.baseline = total(); return F.baseline; }
  function lineEndCargo() {
    return F.pool.filter(function (p) { return p.atLineEnd; }).length;
  }
  function addPool(kind, x, y, z, meta) {
    meta = meta || {};
    var unit = meta.unit || spawn(kind || 'carton');
    if (!unit.parent) F.root.add(unit);
    unit.position.set(x, y, z);
    unit.visible = true;
    var rec = { id: 'fg' + (F.seq++), unit: unit, kind: kind || 'carton',
      x: x, y: y, z: z, atLineEnd: !!meta.atLineEnd, srcId: meta.srcId || null };
    F.pool.push(rec);
    return rec;
  }
  function takePool(pred) {
    for (var i = 0; i < F.pool.length; i++) {
      if (pred && !pred(F.pool[i])) continue;
      var r = F.pool.splice(i, 1)[0];
      if (carrier()) carrier().detachRest(r.unit);
      return r;
    }
    return null;
  }
  function chain() {
    try {
      var r = routes();
      if (r.templateChain) return r.templateChain().slice();
      var s = r.snapshot ? r.snapshot() : null;
      return s && s.lineOrder ? s.lineOrder.slice() : [];
    } catch (e) { return []; }
  }

  /* ---------------- 作业来源：路线分支 ---------------- */
  function cellOf(id) {
    if (!id) return null;
    var cur = rack() && rack().current;
    if (cur && cur.cellById && cur.cellById[id]) return cur.cellById[id];
    var hit = null;
    (geom().cells || []).some(function (c) { if (c.id === id) { hit = c; return true; } return false; });
    return hit;
  }
  function pickOccupied(near) {
    var best = null, bd = 1e9;
    (geom().cells || []).forEach(function (c) {
      if (!c.occ || c.conv >= 0 || c.chg || c.flowReserved) return;
      var d = Math.hypot(c.x - near.x, c.z - near.z) - (c.l >= 1 ? 2.5 : 0);
      if (d < bd) { bd = d; best = c; }
    });
    return best;
  }
  function pickFree(near, level) {
    var want = level == null ? 1 : level;
    var best = null, bd = 1e9;
    (geom().cells || []).forEach(function (c) {
      if (c.occ || c.conv >= 0 || c.chg || c.flowReserved) return;
      var penalty = c.l === want ? 0 : 6;
      var d = Math.hypot(c.x - near.x, c.z - near.z) + penalty + (c.rank || 0);
      if (d < bd) { bd = d; best = c; }
    });
    return best;
  }
  function nearestLift(x, z) {
    var arr = (geom() && geom().liftSites) || [], best = null, bd = 1e9;
    arr.forEach(function (s) {
      var d = Math.hypot(s.x - x, s.z - z);
      if (d < bd) { bd = d; best = s; }
    });
    return best;
  }
  function nodeFrom(n, patch) {
    var q = {};
    Object.keys(n).forEach(function (k) { q[k] = n[k]; });
    Object.keys(patch || {}).forEach(function (k) { q[k] = patch[k]; });
    return q;
  }

  /* 出库作业：按路线把某个真实货位货物送到输送线终点 / 目的地 */
  function startOutbound(v) {
    var src = cellOf(v.start.cargoId);
    if (!src || !src.occ) src = pickOccupied(v.start);
    if (!src) return null;
    src.flowReserved = true;
    var kind = rack().cargoKindOf(src) || 'carton';
    var seq = [nodeFrom(v.start, { kind: 'cargo', cargoId: src.id,
      x: src.x, y: src.y, z: src.z })].concat(v.nodes.slice(1));
    var r = carrier().run({
      seq: seq, tag: 'flow', kind: kind,
      cargoId: src.id, meta: { flow: 'out', routeId: v.routeId, srcId: src.id },
      onArrive: function (info) {
        addPool(kind, info.x, Math.max(LAND_Y, info.y), info.z,
          { unit: info.unit, atLineEnd: true, srcId: src.id });
        src.flowReserved = false;
        F.delivered++; F.cycles++;
        /* 未开启循环：这条设计路线到此为止，货物停在终点不再自动返程 / 重复派工 */
        if (!F.loop && v.routeId) F.doneRoutes[v.routeId] = true;
        return false;                    // unit 由 carrier.rest 托管
      }
    });
    if (!r) { src.flowReserved = false; return null; }
    return r;
  }
  /* 返程 / 入库作业：从线终点取一件货物，按路线反送回货架货位 */
  function startInbound(v) {
    var dst = cellOf(v.end.cargoId);
    if (!dst || dst.occ || dst.flowReserved) dst = pickFree(v.end, dst ? dst.l : 1);
    if (!dst) return null;
    var p = takePool(function (q) { return q.atLineEnd; }) || takePool();
    if (!p) return null;
    dst.flowReserved = true;
    var seq = [{ role: 'start', kind: 'grid', label: '输送线货物',
      x: p.x, y: CONVEY_Y, z: p.z }].concat(v.nodes.slice(1));
    var r = carrier().run({
      seq: seq, tag: 'flow', kind: p.kind, unit: p.unit,
      meta: { flow: 'in', routeId: v.routeId, dstId: dst.id, srcId: p.srcId },
      onArrive: function (info) {
        setOcc(dst.id, true);
        dst.flowReserved = false;
        F.relocated++; F.cycles++;
        return true;                    // 接管并移除移动单元，货架显示静态货物
      }
    });
    if (!r) { F.pool.push(p); dst.flowReserved = false; return null; }
    return r;
  }
  /* 没有任何预设路线时：合成「四向车 → 层间输送线 → 提升机 → 四向车」
     的层间调拨步骤，依然由真实承载体执行，绝不裸移货物。

     通道拓扑（用户第 11 轮强调）：层间输送线所在那一排是「子通道货架」，
     不是主通道！四向车不能在子通道里直接横向 X 移动，必须先沿 Z 回到
     主通道 tracks[]，在主通道上沿 X 走到目标列，再沿 Z 进入子通道。 */
  function trackNearZ(z) {
    var tracks = (geom().tracks || []), best = tracks.length ? tracks[0] : 0, bd = 1e9;
    tracks.forEach(function (tz) {
      var d = Math.abs(tz - z);
      if (d < bd) { bd = d; best = tz; }
    });
    return best;
  }
  function syntheticRelocation() {
    var src = pickOccupied({ x: 0, z: geom().z0 + 1 });
    if (!src) return null;
    var s = nearestLift(src.x, src.z);
    if (!s) return null;
    var dst = pickFree({ x: src.x, z: src.z }, src.l === 0 ? 1 : 0);
    if (!dst) return null;
    dst.flowReserved = true;
    var y0 = src.y, y1 = dst.y, tx = s.x, tz = s.z, cz = s.convZ;
    var mz0 = trackNearZ(src.z), mz1 = trackNearZ(dst.z);
    var SH = function (x1, z1, x2, z2, y, note) {
      return { mode: 'shuttle', fromX: x1, fromY: y, fromZ: z1,
        toX: x2, toY: y, toZ: z2, note: note, devices: [] };
    };
    var CV = function (z1, z2, y, note, onto) {
      var q = { mode: 'conveyor', fromX: tx, fromY: y, fromZ: z1,
        toX: tx, toY: y, toZ: z2, innerConveyor: true, note: note, devices: [] };
      q.siteId = s.id; q.towerZ = tz;
      if (onto) q.transferToLift = true; else q.transferFromLift = true;
      return q;
    };
    var raw = [
      SH(src.x, src.z, src.x, mz0, y0, '当层四向车沿子通道 Z 回主通道'),
      SH(src.x, mz0, tx, mz0, y0, '当层四向车沿主通道 X 行驶'),
      SH(tx, mz0, tx, cz, y0, '当层四向车沿子通道 Z 送层间输送线静置位'),
      /* 货物暂停，空台匀速平层；随后货物被转运上台（设备静止） */
      { mode: 'liftWait', fromX: tx, fromY: y0, fromZ: cz, toX: tx, toY: y0, toZ: cz,
        deckY: y0, siteId: s.id, towerZ: tz, devices: [], note: '等待升降台匀速平层' },
      CV(cz, tz, y0, '层间输送线把货物转运上升降台（设备静止）', true),
      { mode: 'lift', fromX: tx, fromY: y0, fromZ: tz, toX: tx, toY: y1, toZ: tz,
        siteId: s.id, towerZ: tz, note: '升降台载货匀速换层', devices: [] },
      CV(tz, cz, y1, '货物被升降台转运到层间输送线（设备静止）', false),
      { mode: 'liftIdle', fromX: tx, fromY: y1, fromZ: tz, toX: tx, toY: y1, toZ: tz,
        siteId: s.id, towerZ: tz, devices: [], note: '货物离台后升降台继续移动' },
      SH(tx, cz, tx, mz1, y1, '目标层四向车沿子通道 Z 回主通道'),
      SH(tx, mz1, dst.x, mz1, y1, '目标层四向车沿主通道 X 接驳'),
      SH(dst.x, mz1, dst.x, dst.z, y1, '目标层四向车沿子通道 Z 入货位')
    ];
    var kind = rack().cargoKindOf(src) || 'carton';
    var r = carrier().run({
      steps: carrier().normalizeSteps(raw), tag: 'flow', kind: kind,
      cargoId: src.id, meta: { flow: 'relocate', srcId: src.id, dstId: dst.id },
      onArrive: function () {
        setOcc(dst.id, true); dst.flowReserved = false;
        F.relocated++; F.cycles++; return true;
      }
    });
    if (!r) dst.flowReserved = false;
    return r;
  }
  function isDesigned(v) { return !!(v.designed || (!v.template && v.priority === 'designed')); }
  function newJob() {
    var rs = routes(), c = carrier();
    if (!c) return null;
    /* 运行仿真第一优先级：用户手工设计的输送线路线（模板路线排在其后）。 */
    var all = (rs && rs.priorityVariants ? rs.priorityVariants() :
      (rs && rs.autoVariants ? rs.autoVariants() : [])).filter(function (v) {
        return v.start && v.start.kind !== 'emitter' && !v.start.emitterId;
      });
    var designed = all.filter(isDesigned);
    F.priority = designed.length ? 'designed' : (all.length ? 'template' : 'synthetic');
    /* 未开启循环：已完成的设计路线退役，货物留在终点不再重复作业 */
    var live = (!F.loop ? all.filter(function (v) { return !F.doneRoutes[v.routeId]; }) : all);
    var outs = live.filter(function (v) {
      return v.flow === 'out' || (v.end && v.end.y < 0.3 && !insideRack(v.end.x, v.end.z));
    });
    var ins = live.filter(function (v) {
      return v.flow === 'in' || (v.end && v.end.y > 0.3 && insideRack(v.end.x, v.end.z));
    });
    /* 终点名额（含在途）达到 2 件时停止继续送货，避免堆叠穿模 */
    var pending = c.snapshot().runners.filter(function (q) {
      return q.tag === 'flow' && q.cargoId;
    }).length;
    var canSend = lineEndCargo() + pending < LINE_CAP;
    /* 返程循环未开启：货物到终点就静止，不安排返程 / 入库作业 */
    var seqNo = F.jobSeq++;
    var wantIn = F.loop && F.pool.length > 0 && (seqNo % 2 === 1);
    if (wantIn && ins.length) return startInbound(ins[0]);
    if (canSend && outs.length) return startOutbound(outs[0]);
    /* 有设计路线时绝不插入随机层间调拨，也不让货物自己再动：
       没开循环、路线已跑完 / 终点已满 → 仿真到此静止。 */
    if (designed.length) return null;
    /* 没有任何设计路线：沿用「四向车 + 提升机 + 层间输送线」的调拨演示 */
    return syntheticRelocation();
  }

  /* ---------------- sim 任务生成钩子 ----------------
     借用的车由 carrier 冻结，sim 不会再调用 gen；空闲车巡航保持不闲着。 */
  function plan(a) {
    if (!F.ready || !F.conserve) return false;
    var c = carrier();
    if (c && c.snapshot().locks['agent:' + a.id]) return true;
    var playing = !!(sim() && sim().playing);
    if (!playing) { a.q.push({ wait: 0.8, st: '待机' }); return true; }
    var g = geom(), track = (g.tracks || [])[0] || 0;
    var x0 = g.x0 + (g.len || 10) * 0.2, x1 = g.x0 + (g.len || 10) * 0.8;
    F.cruiseIdx++;
    var from = (F.cruiseIdx % 2) ? x0 : x1, to = (F.cruiseIdx % 2) ? x1 : x0;
    a.q.push({ zTrack: true, st: '返回主通道待命' });
    a.q.push({ x: from, st: '巡航待命' }, { x: to, st: '巡航待命' });
    return true;
  }

  /* 作业被收货器吞掉 / 中断时，释放不再被任何在途作业引用的预留货位 */
  function sweepReserved() {
    var c = carrier();
    if (!c) return;
    var ids = {};
    (c.runners || []).forEach(function (r) {
      if (r.cargoId) ids[r.cargoId] = 1;
      if (r.meta && r.meta.dstId) ids[r.meta.dstId] = 1;
      if (r.meta && r.meta.srcId) ids[r.meta.srcId] = 1;
    });
    (geom().cells || []).forEach(function (cell) {
      if (cell.flowReserved && !ids[cell.id]) cell.flowReserved = false;
    });
  }

  /* ---------------- 主循环 ---------------- */
  function tick(dt) {
    if (!F.ready || !F.conserve || !carrier()) return;
    var playing = !!(sim() && sim().playing);
    if (playing && !F.lastPlaying) baseline();
    if (!playing) { F.lastPlaying = false; return; }
    F.lastPlaying = true;
    F.t += dt;
    sweepReserved();
    var lifts = sim().lifts || [];
    var maxJobs = clamp(lifts.length, 1, 3);
    var guard = 0;
    while (carrier().count('flow').active < maxJobs && guard++ < 3) {
      if (!newJob()) break;
    }
    reconcile();
  }
  /* 只补「外部改货架造成的凭空消失」，绝不删除货物；开放模式不补 */
  function reconcile() {
    if (F.open) return;
    var want = baseline(), now = total(), diff = want - now;
    if (diff <= 0 || diff > 32) return;
    var s = ((geom() && geom().liftSites) || [])[0];
    if (!s) return;
    for (var i = 0; i < diff; i++) {
      addPool('carton', s.x + (i % 3) * 0.9, LAND_Y,
        s.z + (s.side === 'back' ? 1.8 : -1.8), {});
    }
  }
  function reset() {
    if (carrier()) carrier().clear('flow');
    /* 复位：线终点 / 地面货物回到原货位，保证货架总量复原 */
    F.pool.slice().forEach(function (p) {
      if (p.srcId) setOcc(p.srcId, true);
      if (p.unit && p.unit.parent) p.unit.parent.remove(p.unit);
    });
    F.pool = [];
    (geom().cells || []).forEach(function (c) { c.flowReserved = false; });
    F.locks = {}; F.conflicts = 0; F.overlaps = 0;
    F.delivered = 0; F.relocated = 0; F.cycles = 0;
    F.baseline = null; F.lastPlaying = false; F.jobSeq = 0;
    F.doneRoutes = {}; F.priority = 'designed';
  }

  /* ---------------- 对外 ---------------- */
  function setLoop(on) {
    F.loop = !!on;
    /* 重新开启循环时，之前因「到终点即停止」退役的路线恢复可用 */
    if (F.loop) F.doneRoutes = {};
    try { global.localStorage.setItem(STORE, JSON.stringify({ loop: F.loop })); } catch (e) { }
    return F.loop;
  }
  function toggleLoop() { return setLoop(!F.loop); }
  function setOpen(on) { F.open = !!on; return F.open; }
  function purgeAt(x, z, r) {
    var n = carrier() ? carrier().purgeAt(x, z, r) : 0;
    F.pool = F.pool.filter(function (p) { return p.unit && p.unit.parent; });
    return n;
  }
  /* 托盘系统接管「仅剩托盘」单元时，从守恒作业池里注销，避免重复调度 */
  function releaseUnit(unit) {
    F.pool = F.pool.filter(function (q) { return q.unit !== unit; });
  }
  function claim(key, id) {
    if (!key) return true;
    if (F.locks[key] && F.locks[key] !== id) { F.conflicts++; return false; }
    F.locks[key] = id; return true;
  }
  function release(key, id) { if (key && F.locks[key] === id) delete F.locks[key]; }
  function snapshot() {
    var c = carrier(), cs = c ? c.snapshot() : { active: 0, rest: 0, carriers: {}, locks: {}, conflicts: 0, runners: [] };
    var jobs = cs.runners.filter(function (r) { return r.tag === 'flow'; }).map(function (r) {
      return { id: r.id, type: (r.cargoId ? 'toLine' : 'return'), phase: r.phase,
        taken: true, src: r.cargoId, lift: r.lift, agent: r.car,
        mode: r.mode, held: r.engaged.map(function (d) { return 'dev:' + d; }) };
    });
    var locks = {};
    Object.keys(cs.locks).forEach(function (k) { locks[k] = cs.locks[k]; });
    Object.keys(F.locks).forEach(function (k) { locks[k] = F.locks[k]; });
    return {
      active: !!F.conserve, playing: !!(sim() && sim().playing), loop: F.loop,
      priority: F.priority, doneRoutes: Object.keys(F.doneRoutes).length,
      baseline: baseline(), total: total(), used: geom().used,
      pool: F.pool.length, inTransit: inTransit(),
      lineEndCargo: lineEndCargo(), lineCap: LINE_CAP,
      delivered: F.delivered, relocated: F.relocated, cycles: F.cycles,
      jobs: jobs, locks: locks, conflicts: cs.conflicts + F.conflicts, overlaps: F.overlaps,
      conserved: F.open ? false : baseline() === total(), open: F.open,
      hasLine: chain().length >= 2, chainLength: chain().length,
      carriers: cs.carriers, carrierActive: cs.active, carrierRest: cs.rest
    };
  }
  function init() {
    F.root = new T.Group();
    WAP.scene.S.modelRoot.add(F.root);
    try {
      var raw = global.localStorage.getItem(STORE);
      if (raw) F.loop = !!JSON.parse(raw).loop;
    } catch (e) { }
    var prevTick = WAP.scene.S.onTick;
    WAP.scene.S.onTick = function (dt) { if (prevTick) prevTick(dt); tick(dt); };
    var prevStop = WAP.sim.stop;
    WAP.sim.stop = function () { prevStop(); reset(); };
    var prevRebuild = WAP.sim.onRebuild;
    WAP.sim.onRebuild = function () { prevRebuild(); reset(); };
    var btn = $('simLoop');
    if (btn) {
      btn.textContent = F.loop ? '⇄ 返程循环：开' : '⇄ 返程循环：关';
      btn.classList.toggle('is-on', F.loop);
      btn.setAttribute('aria-pressed', String(F.loop));
      var tip = $('simLoopTip');
      if (tip) tip.textContent = F.loop
        ? '已开启：货物到达输送线终点后沿原路线返回'
        : '默认货物到终点后静止；开启后原路返回';
    }
    F.ready = true;
  }
  WAP.flow = {
    init: init, tick: tick, plan: plan, snapshot: snapshot,
    setLoop: setLoop, toggleLoop: toggleLoop, setOpen: setOpen, purgeAt: purgeAt, reset: reset,
    claim: claim, release: release, releaseUnit: releaseUnit,
    get loop() { return F.loop; },
    get conserve() { return F.conserve; },
    get busy() { return carrier() ? carrier().count('flow').active > 0 : false; }
  };
})(window);
