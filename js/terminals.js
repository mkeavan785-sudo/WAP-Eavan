/* WAP-Eavan · terminals.js (v2)
   发货器 / 收货器运行器：点设备接入运行仿真。

   用户规则（2026-11-12）：
   · 发货器＝淡绿点，不占网格名额，可绑定任意设备；有它存在才会吐货。
     面板可选货物种类 / 大类与吐货速度；被选作路线起点时，发出的货物
     **沿该条路线**送到货架 / 目的地。
   · 多个终点有了货物，发货器不再吐货；同一路线可拖出多个起点 / 终点，
     仿真按「随机优先级 + 先送最远」挑分支，规避先存的货物挡住后续货物。
   · 收货器＝红点，所有到达它位置的货物都会消失。
   · 存在发货器 / 收货器时总量不再守恒（发货 +N / 收货 −N）。

   关键修正：货物不再由本模块自己平移。所有吐出的货物都通过
   WAP.carrier 按 routes.planSeq 的职能分段执行：
     货架内水平 → 真实四向车；上下 → 提升机载货台；
     货架外 → 场景输送设备（engaged）；无设备接 → 重力落地静止。 */
(function (global) {
  'use strict';
  var WAP = global.WAP = global.WAP || {};
  var T3 = global.THREE;
  var D = global.document;
  var $ = function (id) { return D.getElementById(id); };

  var CELL = 2.0;
  var CONVEY_Y = 0.86;
  var LAND_Y = 0.02;
  var MAX_FLIGHT = 10;
  var RECV_R = 1.35;

  var T = {
    ready: false, root: null,
    delivered: [],          // 已到达终点 / 货位的货物（含入库货位 id）
    timers: {},             // emitterId -> 累计秒
    endLoad: {},            // endKey -> 该终点停留的货物数
    emitted: 0, received: 0, removed: 0, receivedBy: {},
    open: false, blocked: false, t: 0, seed: 1,
    lastChoice: null, lastRoute: null,
    chainWarned: false
  };

  function eq() { return WAP.equipment; }
  function routes() { return WAP.routes; }
  function flow() { return WAP.flow; }
  function sim() { return WAP.sim; }
  function carrier() { return WAP.carrier; }
  function geom() { return WAP.state.geom; }
  function toast(m) { if (WAP.ui && WAP.ui.toast) WAP.ui.toast(m); }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

  function snapshotDevices() {
    var e = eq();
    if (!e || !e.snapshot) return { emitters: [], receivers: [] };
    var s = e.snapshot();
    return { emitters: s.emitters || [], receivers: s.receivers || [], devices: s.devices || [] };
  }
  function insideRack(x, z) {
    var g = geom();
    return !!g && x > g.x0 - 0.15 && x < g.x1 + 0.15 && z > g.z0 - 0.15 && z < g.z1 + 0.15;
  }
  /* 入库目标：优先最深的空货位，避免先存近处挡住后续货物 */
  function farFreeCell(x, z) {
    var g = geom();
    if (!g || !g.cells) return null;
    var best = null, bd = -1e9;
    g.cells.forEach(function (c) {
      if (c.chg || c.conv >= 0 || c.occ || c.flowReserved) return;
      var rank = c.rank == null ? 0 : c.rank;
      var score = (1 - rank) * 6 - Math.hypot(c.x - x, c.z - z) * 0.25 + (c.l >= 1 ? 1.2 : 0);
      if (score > bd) { bd = score; best = c; }
    });
    return best;
  }
  /* 收货器无论是否绑定设备都生效：
     · own  = 收货器自身所在的网格（3D 红点位置）
     · point= 绑定设备的位置（面板上可指定）
     两处都算「收货器位置」，货物到达任意一处都必须消失。 */
  function receiverPoints(list) {
    var out = [];
    (list || []).forEach(function (r) {
      var seen = {};
      [r.own, r.point].forEach(function (p, i) {
        if (!p || !isFinite(p.x) || !isFinite(p.z)) return;
        var key = p.x.toFixed(2) + ',' + p.z.toFixed(2);
        if (seen[key]) return;
        seen[key] = 1;
        out.push({ id: r.id, x: p.x, z: p.z, y: p.y, from: i === 0 ? 'own' : 'bound' });
      });
      if (!r.own && !r.point) out.push({ id: r.id, x: 0, z: 0, from: 'fallback' });
    });
    return out;
  }
  function hitReceiver(x, z, pts) {
    for (var i = 0; i < pts.length; i++) {
      if (Math.hypot(x - pts[i].x, z - pts[i].z) < RECV_R) return pts[i];
    }
    return null;
  }
  function noteReceive(rc, n) {
    var k = Number(n) || 0;
    if (!rc || k <= 0) return;            // 没有货物被吞掉时绝不计 1
    T.received += k;
    T.receivedBy[rc.id] = (T.receivedBy[rc.id] || 0) + k;
  }
  function decrementEnd(key) {
    if (!key) return;
    T.endLoad[key] = Math.max(0, (T.endLoad[key] || 0) - 1);
    if (!T.endLoad[key]) delete T.endLoad[key];
  }
  function loadedEnds() { return Object.keys(T.endLoad).length; }

  /* ---------------- 路线分支：发货器替换起点 ----------------
     每条可用分支都必须是 routes.planSeq 能规划出「至少 2 段且首段不是掉落」
     的真实路径，货物才会沿这条路线走，绝不自己平移。 */
  function variantsFor(em) {
    var rs = routes(), out = [];
    var snap = eq() && eq().snapshot ? eq().snapshot() : { devices: [] };
    var conv = (snap.devices || []).filter(function (d) {
      return ['roller', 'chain', 'transfer', 'destacker'].indexOf(d.type) >= 0;
    });
    /* 发货器「吐货进入输送线」：绑定设备时吐在绑定设备上；
       未绑定且脚下没有输送设备时，吐在最近的输送设备上（不让货物凭空平移） */
    var spawn = { x: em.point.x, y: Math.max(CONVEY_Y, em.point.y), z: em.point.z };
    var bound = em.bindId ? conv.filter(function (d) { return d.id === em.bindId; })[0] : null;
    if (bound) { spawn = { x: bound.x, y: CONVEY_Y, z: bound.z }; }
    else {
      var nearest = null, nd = 1e9;
      conv.forEach(function (d) {
        var q = Math.hypot(d.x - spawn.x, d.z - spawn.z);
        if (q < nd) { nd = q; nearest = d; }
      });
      if (nearest && nd > CELL * 0.8) spawn = { x: nearest.x, y: CONVEY_Y, z: nearest.z };
    }
    var startNode = { role: 'start', kind: 'emitter', label: em.name,
      emitterId: em.id, x: spawn.x, y: spawn.y, z: spawn.z };

    /* 设计路线第一优先级：发货器发出的货物优先沿用户设计的输送线路线走 */
    var all = (rs && rs.priorityVariants ? rs.priorityVariants() :
      (rs && rs.autoVariants ? rs.autoVariants() : []));
    all.forEach(function (v) {
      var seq = [startNode].concat(v.nodes.slice(1));
      if (bound && !seq.slice(1).some(function (n) { return n.targetId === bound.id; })) {
        seq.splice(1, 0, { role: 'via', kind: 'device', label: bound.name,
          targetId: bound.id, x: bound.x, y: CONVEY_Y, z: bound.z });
      }
      var steps = rs.planSeq(seq);
      if (steps.length < 2 || steps[0].mode === 'drop') return;
      out.push({ seq: seq, steps: steps, end: v.end, endKey: v.endKey,
        dist: Math.hypot(v.end.x - spawn.x, v.end.z - spawn.z),
        routeId: v.routeId, routeName: v.name, flow: v.flow,
        designed: !!v.designed, priority: v.priority || null,
        modes: steps.map(function (s) { return s.mode; }) });
    });
    /* 没有可用预设路线：沿场景内已有输送设备链生成一条序列 */
    if (!out.length && conv.length) {
      var used = {}, chain = [];
      if (bound) { chain.push(bound); used[bound.id] = 1; }
      conv.slice().sort(function (a, b) {
        return Math.hypot(a.x - spawn.x, a.z - spawn.z) -
          Math.hypot(b.x - spawn.x, b.z - spawn.z);
      }).forEach(function (d) {
        if (used[d.id] || chain.length >= 8) return;
        used[d.id] = 1; chain.push(d);
      });
      var tail = chain.length ? chain[chain.length - 1] : null;
      var end = tail ? { x: tail.x, y: LAND_Y, z: tail.z }
        : { x: spawn.x + 2, y: LAND_Y, z: spawn.z };
      var seq2 = [startNode].concat(chain.map(function (d) {
        return { role: 'via', kind: 'device', label: d.name, targetId: d.id,
          x: d.x, y: CONVEY_Y, z: d.z };
      })).concat([{ role: 'end', kind: 'grid', label: '输送线末端',
        x: end.x, y: end.y, z: end.z }]);
      var steps2 = rs.planSeq(seq2);
      if (steps2.length && steps2[0].mode !== 'drop') {
        out.push({ seq: seq2, steps: steps2, end: end, endKey: 'CHAIN-' + em.id,
          dist: Math.hypot(end.x - spawn.x, end.z - spawn.z),
          routeId: null, routeName: '场景输送设备链', flow: null,
          modes: steps2.map(function (s) { return s.mode; }) });
      }
    }
    if (!out.length && !T.chainWarned) {
      T.chainWarned = true;
      toast('发货器未找到可用输送线：请先用「一键添加 / 识别输送线」生成路线');
    }
    /* 发货器的货物应送进货架：优先「终点在货架内」的路线分支 */
    var toRack = out.filter(function (v) { return insideRack(v.end.x, v.end.z); });
    if (toRack.length) out = toRack;
    /* 设计路线 > 模板路线；同档先送最远 */
    out.sort(function (a, b) {
      var da = a.designed || a.priority === 'designed' ? 1 : 0;
      var db = b.designed || b.priority === 'designed' ? 1 : 0;
      if (da !== db) return db - da;
      return b.dist - a.dist;
    });
    return out;
  }

  function emit(em, pts) {
    var c = carrier();
    if (!c) return false;
    var vs = variantsFor(em).filter(function (v) { return !T.endLoad[v.endKey]; });
    if (!vs.length) return false;
    var top = vs.slice(0, Math.min(3, vs.length));
    var idx = Math.min(top.length - 1, Math.floor(-Math.log(1 - Math.random() * 0.9) * 1.4));
    var v = top[clamp(idx, 0, top.length - 1)];
    T.lastChoice = { endKey: v.endKey, dist: +v.dist.toFixed(2),
      candidates: vs.length, priority: 'farthest-first+random',
      routeId: v.routeId, routeName: v.routeName, modes: v.modes,
      stations: v.steps.filter(function (s) { return s.mode === 'conveyor'; }).length };
    T.lastRoute = v.endKey;
    var kind = em.cargoKind && WAP.core.CARGO_REAL.indexOf(em.cargoKind) >= 0 ? em.cargoKind : 'carton';
    var cls = WAP.core.CARGO_CLASS_KEYS.indexOf(em.cargoClass) >= 0 ? em.cargoClass : 'single';
    var r = c.run({
      seq: v.seq, tag: 'terminal', kind: kind, cls: cls,
      meta: { endKey: v.endKey, emitterId: em.id, routeId: v.routeId },
      onArrive: function (info) {
        /* 未开启循环时终点一旦有货就不再往这里派新货：货物到终点即静止；
           开启循环后货物会原路返回，终点名额随之释放。 */
        if (!(WAP.flow && WAP.flow.loop)) {
          T.endLoad[v.endKey] = (T.endLoad[v.endKey] || 0) + 1;
        }
        /* 终点在货架内 → 真的放进最深的空货位（发货器增加总量） */
        var cell = insideRack(info.x, info.z) ? farFreeCell(info.x, info.z) : null;
        var x = cell ? cell.x : info.x, y = cell ? cell.y : LAND_Y, z = cell ? cell.z : info.z;
        T.delivered.push({ unit: info.unit, x: x, y: y, z: z,
          endKey: v.endKey, cellId: cell ? cell.id : null, emitterId: em.id });
        if (cell) { c.setOcc(cell.id, true); return true; }   // 移除移动单元，货架显示静态货物
        return false;                                          // carrier.rest 托管
      }
    });
    if (!r) return false;
    T.emitted++;
    return true;
  }

  /* ---------------- 收货器 ----------------
     一次扫描把「carrier 的在途/静止单元 + 本地登记（含入库货位）」全部对齐，
     并同步释放终点占用计数，否则发货器会一直误判为「终点已有货」。 */
  function purgeAt(pts) {
    var total = 0;
    pts.forEach(function (rc) {
      var n = 0;
      /* 货物被单独取走（收货器吞货）时，带托盘货物会遗留一片母托盘；
         交给拆叠盘机沿输送线收走并堆成托盘垛。 */
      if (WAP.pallets && WAP.pallets.onGoodsTaken && carrier()) {
        var seen = {};
        (carrier().runners || []).concat(carrier().rest || []).forEach(function (q) {
          if (seen[q.unit && q.unit.uuid]) return;
          if (q.unit) seen[q.unit.uuid] = 1;
          if (Math.hypot(q.x - rc.x, q.z - rc.z) >= RECV_R) return;
          var cls = q.cls || (q.unit && q.unit.userData && q.unit.userData.cargoClass) || '';
          if (cls === 'combo' || cls === 'mother' || cls === 'sub') {
            WAP.pallets.onGoodsTaken(q.x, q.y, q.z, cls === 'sub' ? 'sub' : 'mother');
          }
        });
      }
      if (carrier()) n += carrier().purgeAt(rc.x, rc.z, RECV_R) || 0;
      if (flow() && flow().purgeAt) n += flow().purgeAt(rc.x, rc.z, RECV_R) || 0;
      if (routes() && routes().purgeGroundAt) n += routes().purgeGroundAt(rc.x, rc.z, RECV_R) || 0;
      /* 路线设计面板「运行路线」的在途货物也必须被收走（不受隐藏 / 绑定影响） */
      if (routes() && routes().purgeActiveAt) n += routes().purgeActiveAt(rc.x, rc.z, RECV_R) || 0;
      noteReceive(rc, n);
      total += n;
    });
    var keep = [];
    T.delivered.forEach(function (q) {
      var rc = hitReceiver(q.x, q.z, pts);
      var goneByCarrier = !(q.unit && q.unit.parent);
      if (!rc && !goneByCarrier) { keep.push(q); return; }
      if (q.cellId) {
        carrier().setOcc(q.cellId, false);
        T.received += 1; total += 1;      // 静态货位货物也被收货器吞掉
      }
      if (q.unit && q.unit.parent) q.unit.parent.remove(q.unit);
      decrementEnd(q.endKey);
    });
    T.delivered = keep;
    if (total) T.removed += total;
    return total;
  }

  /* ---------------- 主循环 ---------------- */
  function tick(dt) {
    if (!T.ready || !carrier()) return;
    var devs = snapshotDevices();
    var has = devs.emitters.length > 0 || devs.receivers.length > 0;
    if (has !== T.open) {
      T.open = has;
      if (flow() && flow().setOpen) flow().setOpen(has);
    }
    var pts = receiverPoints(devs.receivers);
    /* 收货器是位置触发：无论是否绑定设备、无论仿真是否播放、无论运行的是
       守恒作业还是「运行路线」，货物一旦到达收货器位置就必须消失。 */
    if (pts.length) purgeAt(pts);
    if (!(sim() && sim().playing)) return;      // 暂停：不吐货，但收货照常触发
    T.t += dt;
    /* 多个终点有货（或单终点堆到 2 件）→ 暂停吐货 */
    T.blocked = loadedEnds() >= 2 || T.delivered.length >= 2;
    if (T.blocked) return;
    devs.emitters.forEach(function (em) {
      T.timers[em.id] = (T.timers[em.id] || 0) + dt;
      var rate = clamp(Number(em.rate) || 2.5, 0.4, 12);
      if (T.timers[em.id] < rate) return;
      if (carrier().count('terminal').active >= MAX_FLIGHT) return;
      T.timers[em.id] = 0;
      emit(em, pts);
    });
  }
  function reset() {
    if (carrier()) carrier().clear('terminal');
    T.delivered.forEach(function (q) {
      if (q.cellId) carrier().setOcc(q.cellId, false);
      if (q.unit && q.unit.parent) q.unit.parent.remove(q.unit);
    });
    T.delivered = []; T.timers = {}; T.endLoad = {};
    T.emitted = 0; T.received = 0; T.removed = 0; T.receivedBy = {};
    T.blocked = false; T.lastChoice = null; T.lastRoute = null;
    T.t = 0; T.chainWarned = false;
    if (flow() && flow().setOpen) {
      var d = snapshotDevices();
      flow().setOpen(d.emitters.length > 0 || d.receivers.length > 0);
    }
  }
  function init() {
    T.root = new T3.Group();
    T.root.userData.kind = 'terminals';
    WAP.scene.S.modelRoot.add(T.root);
    var prevTick = WAP.scene.S.onTick;
    WAP.scene.S.onTick = function (dt) { if (prevTick) prevTick(dt); tick(dt); };
    var prevStop = WAP.sim.stop;
    WAP.sim.stop = function () { prevStop(); reset(); };
    var prevRebuild = WAP.sim.onRebuild;
    WAP.sim.onRebuild = function () { prevRebuild(); reset(); };
    T.ready = true;
  }
  function releaseUnit(unit) {
    T.delivered = T.delivered.filter(function (q) { return q.unit !== unit; });
  }
  function receivedCount(id) { return T.receivedBy[id] || 0; }
  function snapshot() {
    var devs = snapshotDevices();
    var c = carrier(), cs = c ? c.snapshot() : { maxJump: 0 };
    var cn = c ? c.count('terminal') : { active: 0, rest: 0 };
    return {
      ready: T.ready, open: T.open, blocked: T.blocked,
      emitters: devs.emitters.map(function (e) {
        return { id: e.id, name: e.name, bindId: e.bindId, rate: e.rate,
          cargoKind: e.cargoKind, cargoClass: e.cargoClass, point: e.point,
          timer: +(T.timers[e.id] || 0).toFixed(2) };
      }),
      receivers: devs.receivers.map(function (r) {
        return { id: r.id, name: r.name, bindId: r.bindId, point: r.point,
          received: receivedCount(r.id) };
      }),
      emitted: T.emitted, received: T.received, removed: T.removed,
      inFlight: cn.active, resting: T.delivered.length,
      endLoad: Object.assign({}, T.endLoad), loadedEnds: loadedEnds(),
      alive: cn.active + cn.rest + T.delivered.filter(function (q) { return q.cellId; }).length,
      lastChoice: T.lastChoice, lastRoute: T.lastRoute,
      maxJump: +cs.maxJump.toFixed(3), noFly: cs.maxJump < 1.3,
      carriers: cs.carriers || {},
      conserveOff: !!(flow() && flow().snapshot && flow().snapshot().open),
      t: +T.t.toFixed(2)
    };
  }
  WAP.terminals = {
    init: init, tick: tick, reset: reset, snapshot: snapshot,
    receivedCount: receivedCount, releaseUnit: releaseUnit,
    emitNow: function (id) {
      var devs = snapshotDevices();
      var em = devs.emitters.filter(function (e) { return !id || e.id === id; })[0];
      return em ? emit(em, receiverPoints(devs.receivers)) : false;
    },
    variants: function (id) {
      var em = snapshotDevices().emitters.filter(function (e) { return !id || e.id === id; })[0];
      return em ? variantsFor(em).map(function (v) {
        return { endKey: v.endKey, dist: +v.dist.toFixed(2), routeId: v.routeId,
          routeName: v.routeName, modes: v.modes };
      }) : [];
    },
    get open() { return T.open; }
  };
})(window);
