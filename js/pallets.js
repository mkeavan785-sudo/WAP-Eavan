/* WAP-Eavan · pallets.js (v1)
   拆叠盘机 / 托盘流转子系统。

   用户规则（2026-11-12 第 12 轮）：
   · 拆叠盘机模型本身【没有托盘】；动画上它只接收托盘，不接收货物。
   · 仿真中货物被单独取走、仅剩一个托盘时，该托盘可被拆叠盘机接收；
     沿输送线送过来的托盘会在机内堆积成托盘垛。
   · 拆叠盘机【只收集母托盘】；子托盘不收集。
   · 现场货物被送到输送线上只有子托盘和货（缺母托盘）时，所需母托盘由
     拆叠盘机从垛里分离出【单个母托盘】，沿输送线送过去合体。

   约束：不改 sim.js；托盘一律沿场景里已有的输送设备链移动（设备不动、
   托盘沿设备表面平移），绝不空中直线补间 / 凭空飞行。 */
(function (global) {
  'use strict';
  var WAP = global.WAP = global.WAP || {};
  var T = global.THREE;
  var CELL = 2.0;
  var SPEED = 1.35;
  var PALLET_Y = 0.90;

  var P = {
    ready: false, root: null, t: 0, seq: 1,
    units: [],                 // 在途 / 静置托盘
    received: 0,              // 收进垛的母托盘数
    separated: 0,             // 分离出去的母托盘数
    rejected: 0,              // 拒收（货物 / 子托盘）
    waiting: 0                // 缺母托盘、等待拆分的子托盘货物
  };

  function eq() { return WAP.equipment; }
  function carrier() { return WAP.carrier; }
  function routes() { return WAP.routes; }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function toast(m) { if (WAP.ui && WAP.ui.toast) WAP.ui.toast(m); }

  /* ---------------- 场景数据 ---------------- */
  function destackers() {
    var e = eq();
    return e ? (e.devices || []).filter(function (d) { return d.type === 'destacker'; }) : [];
  }
  /* 输送链：优先用路线系统识别出的有序链（含拆叠盘机这个换向工位） */
  function chain() {
    var rs = routes(), e = eq(), out = [];
    var line = rs && rs.orderLine ? rs.orderLine() : [];
    if (line.length) {
      line.forEach(function (d) { out.push({ id: d.id, x: d.x, z: d.z, type: d.type }); });
    } else if (e) {
      (e.devices || []).forEach(function (d) {
        if (['roller', 'chain', 'transfer', 'destacker'].indexOf(d.type) >= 0) {
          out.push({ id: d.id, x: d.x, z: d.z, type: d.type });
        }
      });
      out.sort(function (a, b) { return a.z - b.z || a.x - b.x; });
    }
    return out;
  }
  function nearestIndex(list, x, z) {
    var bi = -1, bd = 1e9;
    list.forEach(function (p, i) {
      var d = Math.hypot(p.x - x, p.z - z);
      if (d < bd) { bd = d; bi = i; }
    });
    return { i: bi, d: bd };
  }
  /* 从 (x,z) 沿输送设备链走到 target 设备；没有设备链就返回空路径（托盘静止等待） */
  function pathTo(x, z, target) {
    var line = chain();
    if (!line.length) return [];
    var si = nearestIndex(line, x, z).i;
    var ti = target ? nearestIndex(line, target.x, target.z).i : line.length - 1;
    if (si < 0 || ti < 0) return [];
    var dir = ti >= si ? 1 : -1, out = [], last = { x: x, z: z };
    for (var i = si; dir > 0 ? i <= ti : i >= ti; i += dir) {
      var p = line[i];
      if (Math.hypot(p.x - last.x, p.z - last.z) > CELL * 1.6) break;
      out.push({ x: p.x, z: p.z });
      last = p;
    }
    /* 目标设备不在链上时，只有贴得足够近才允许最后一段贴设备面平移 */
    if (target && out.length && target.id !== line[clamp(ti, 0, line.length - 1)].id) {
      if (Math.hypot(target.x - last.x, target.z - last.z) <= CELL * 1.35) {
        out.push({ x: target.x, z: target.z });
      }
    }
    return out;
  }
  function nearestDestacker(x, z) {
    var best = null, bd = 1e9;
    destackers().forEach(function (d) {
      var q = Math.hypot(d.x - x, d.z - z);
      if (q < bd) { bd = q; best = d; }
    });
    return best;
  }
  function stackOf(id) {
    return eq() && eq().destackerStackOf ? eq().destackerStackOf(id) : 0;
  }
  function setStack(id, n) {
    if (eq() && eq().setDestackerStack) eq().setDestackerStack(id, n);
  }

  /* ---------------- 托盘实体 ---------------- */
  function makePallet(cls) {
    var rack = WAP.rack;
    var u = rack.makeCargoUnit('carton', (P.seq * 37) % 997, cls);
    u.userData.kind = 'pallet';
    u.userData.palletClass = cls;
    return u;
  }
  function releaseFromOtherLedgers(unit) {
    [WAP.flow, WAP.terminals, routes()].forEach(function (m) {
      if (m && m.releaseUnit) { try { m.releaseUnit(unit); } catch (e) { } }
    });
  }
  function spawnPallet(cls, x, y, z, meta) {
    meta = meta || {};
    var unit = meta.unit || makePallet(cls);
    if (!unit.parent) P.root.add(unit);
    unit.visible = true;
    unit.position.set(x, Math.max(0.06, y), z);
    unit.userData.palletOwned = true;
    unit.userData.palletClass = cls;
    var rec = {
      id: 'pl' + (P.seq++), cls: cls, unit: unit,
      x: x, y: Math.max(0.06, y), z: z,
      phase: 'idle', path: [], pi: 0,
      targetId: meta.targetId || null, targetUnit: meta.targetUnit || null,
      note: meta.note || ''
    };
    P.units.push(rec);
    return rec;
  }
  function removeUnit(rec) {
    if (rec.unit && rec.unit.parent) rec.unit.parent.remove(rec.unit);
    var i = P.units.indexOf(rec);
    if (i >= 0) P.units.splice(i, 1);
  }
  /* 把一个已经存在的「仅剩托盘」单元接管过来（不凭空生成第二件） */
  function adopt(unit, cls, x, y, z, note) {
    if (!unit || unit.userData.palletOwned) return null;
    if (carrier()) carrier().detachRest(unit);
    releaseFromOtherLedgers(unit);
    if (unit.parent) unit.parent.remove(unit);
    P.root.add(unit);
    unit.userData.palletOwned = true;
    unit.userData.palletClass = cls;
    unit.visible = true;
    unit.position.set(x, Math.max(0.06, y), z);
    var rec = { id: 'pl' + (P.seq++), cls: cls, unit: unit,
      x: x, y: Math.max(0.06, y), z: z, phase: 'idle', path: [], pi: 0,
      targetId: null, targetUnit: null, note: note || '遗留托盘' };
    P.units.push(rec);
    return rec;
  }

  /* ---------------- 收集 / 拆分 ---------------- */
  function sendToDestacker(rec) {
    var dev = nearestDestacker(rec.x, rec.z);
    if (!dev) return false;
    var path = pathTo(rec.x, rec.z, dev);
    if (!path.length) return false;              // 无输送线 → 原地等待，绝不飞过去
    rec.targetId = dev.id;
    rec.path = path;
    rec.pi = 0;
    rec.phase = 'convey';
    return true;
  }
  function onArrive(rec) {
    var dev = rec.targetId ? (eq().devices || []).filter(function (d) { return d.id === rec.targetId; })[0] : null;
    if (!dev || dev.type !== 'destacker') { rec.phase = 'idle'; return; }
    if (rec.cls !== 'mother') {
      /* 只收集母托盘：子托盘 / 带货物一律拒收 */
      P.rejected++;
      rec.phase = 'idle';
      rec.path = [];
      rec.note = '子托盘 · 拆叠盘机只收母托盘';
      return;
    }
    var n = stackOf(dev.id) + 1;
    setStack(dev.id, n);
    P.received++;
    removeUnit(rec);
    if (eq() && eq().refreshPanel) { try { eq().refreshPanel(); } catch (e) { } }
  }
  /* 货物被单独取走 → 留下母托盘，沿输送线送进拆叠盘机 */
  function onGoodsTaken(x, y, z, cls) {
    if (!P.ready) return null;
    var use = cls === 'sub' ? 'sub' : 'mother';
    var rec = spawnPallet(use, x, y, z, { note: '货物被取走 · 仅剩托盘' });
    if (!sendToDestacker(rec)) rec.phase = 'idle';
    return rec;
  }
  /* 缺母托盘的子托盘货物 → 从垛里分离单片母托盘沿输送线送过去 */
  function requestMother(targetUnit, x, y, z) {
    if (!P.ready || !targetUnit || targetUnit.userData.motherRequested) return null;
    var donor = null, best = -1;
    destackers().forEach(function (d) {
      var n = stackOf(d.id);
      if (n > best) { best = n; donor = d; }
    });
    if (!donor || best <= 0) { P.waiting++; return null; }
    targetUnit.userData.motherRequested = true;
    setStack(donor.id, best - 1);
    P.separated++;
    if (eq() && eq().refreshPanel) { try { eq().refreshPanel(); } catch (e) { } }
    var rec = spawnPallet('mother', donor.x, PALLET_Y, donor.z,
      { note: '从托盘垛分离的单个母托盘' });
    /* 沿输送设备链送到缺母托盘的货物处（与收集共用同一套链路径） */
    var path = pathTo(donor.x, donor.z, { id: null, x: x, z: z });
    if (!path.length) { /* 没有链可走：把母托盘留在机旁，不凭空飞行 */
      targetUnit.userData.motherRequested = false;
      return rec;
    }
    rec.targetUnit = targetUnit;
    rec.path = path; rec.pi = 0; rec.phase = 'convey';
    return rec;
  }
  function mergeMother(rec) {
    var u = rec.targetUnit;
    if (u && u.parent && !u.userData.motherAdded) {
      /* 把母托盘垫到单元下方，形成「子母托盘」完整货物 */
      var slab = new T.Mesh(new T.BoxGeometry(1.06, 0.10, 0.92),
        WAP.materials.palletMother());
      slab.position.set(0, -0.02, 0);
      slab.userData.kind = 'pallet';
      u.add(slab);
      u.userData.motherAdded = true;
      u.userData.motherRequested = false;
    }
    removeUnit(rec);
  }

  /* ---------------- 观察：仅剩托盘 / 缺母托盘 ---------------- */
  function watchCarrier() {
    var c = carrier();
    if (!c) return;
    var all = (c.runners || []).slice().concat(c.rest || []);
    all.forEach(function (q) {
      var u = q.unit;
      if (!u || u.userData.palletOwned) return;
      var cls = q.cls || u.userData.cargoClass || '';
      /* 静止的「仅托盘」单元：接管为托盘实体，交给拆叠盘机 */
      if (c.rest.indexOf(q) >= 0 && (cls === 'mother' || cls === 'sub')) {
        var rec = adopt(u, cls, q.x, q.y, q.z, '仅剩托盘');
        if (rec && cls === 'mother') sendToDestacker(rec);
        else if (rec) requestMother(u, q.x, q.y, q.z);
        return;
      }
      /* 只有子托盘和货（缺母托盘）→ 向拆叠盘机申请分离单个母托盘 */
      if (cls === 'sub' && !u.userData.motherRequested && !u.userData.motherAdded) {
        requestMother(u, q.x, q.y, q.z);
      }
    });
  }

  /* ---------------- 主循环 ---------------- */
  function tick(dt) {
    if (!P.ready) return;
    P.t += dt;
    watchCarrier();
    var step = SPEED * dt;
    P.units.slice().forEach(function (rec) {
      if (rec.phase !== 'convey' || !rec.path.length) return;
      var p = rec.path[rec.pi];
      if (!p) { rec.phase = 'idle'; return; }
      var dx = p.x - rec.x, dz = p.z - rec.z, d = Math.hypot(dx, dz);
      if (d > step) { rec.x += dx / d * step; rec.z += dz / d * step; }
      else { rec.x = p.x; rec.z = p.z; rec.pi++; }
      if (rec.unit) rec.unit.position.set(rec.x, rec.y, rec.z);
      if (rec.pi >= rec.path.length) {
        rec.phase = 'idle';
        if (rec.targetUnit) mergeMother(rec);
        else onArrive(rec);
      }
    });
  }
  function reset() {
    P.units.slice().forEach(removeUnit);
    P.units = [];
    destackers().forEach(function (d) { setStack(d.id, 0); });
    P.received = 0; P.separated = 0; P.rejected = 0; P.waiting = 0;
    P.t = 0;
  }
  function snapshot() {
    var stacks = {};
    destackers().forEach(function (d) { stacks[d.id] = stackOf(d.id); });
    return {
      ready: P.ready, units: P.units.length,
      inTransit: P.units.filter(function (q) { return q.phase === 'convey'; }).length,
      stacks: stacks, totalStacked: Object.keys(stacks).reduce(function (a, k) { return a + stacks[k]; }, 0),
      received: P.received, separated: P.separated, rejected: P.rejected, waiting: P.waiting,
      chainLength: chain().length,
      destackers: destackers().map(function (d) { return { id: d.id, x: d.x, z: d.z, stack: stackOf(d.id) }; }),
      units: P.units.map(function (q) { return { id: q.id, cls: q.cls, phase: q.phase,
        x: +q.x.toFixed(2), z: +q.z.toFixed(2), targetId: q.targetId, note: q.note }; })
    };
  }
  function init() {
    P.root = new T.Group();
    P.root.userData.kind = 'pallets';
    WAP.scene.S.modelRoot.add(P.root);
    var prevTick = WAP.scene.S.onTick;
    WAP.scene.S.onTick = function (dt) { if (prevTick) prevTick(dt); tick(dt); };
    var prevStop = WAP.sim.stop;
    WAP.sim.stop = function () { prevStop(); reset(); };
    var prevRebuild = WAP.sim.onRebuild;
    WAP.sim.onRebuild = function () { prevRebuild(); reset(); };
    P.ready = true;
  }

  WAP.pallets = {
    init: init, tick: tick, reset: reset, snapshot: snapshot,
    onGoodsTaken: onGoodsTaken, requestMother: requestMother,
    /* 供外部把「仅剩托盘」直接交给本系统 */
    leavePallet: function (x, y, z, cls) { return spawnPallet(cls === 'sub' ? 'sub' : 'mother', x, y, z, {}); },
    stackOf: stackOf, setStack: setStack,
    chain: chain,
    get units() { return P.units; }
  };
})(window);
