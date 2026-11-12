/* WAP-Eavan · carrier.js (v1)
   「设备职能执行器」——所有在途货物必须由真实承载体带动，绝不自己平移。

   用户规则（2026-11-12 强调）：
   · 货架内水平移动  → 当层真实四向穿梭车（WAP.sim.devices，绝不新造车）
   · 上下移动        → 提升机载货台（WAP.sim.lifts[].ref.mesh，塔位纯垂直）
   · 货架外转运      → 场景内已有输送设备（engaged，按自身功能动作）
   · 没有设备接驳    → 超出设备末端后重力掉到下一个网格地面并静止
   · 同一设备同一时刻只转运一件货物（互斥锁）
   · 路线是唯一路径来源：steps 来自 WAP.routes.planSeq / 路线显式规划

   约束：sim.js 运动状态机一行不动。本模块包装 S.onTick（最后执行，覆盖
   sim.tickLifts 对载货台的回落），并在 sim.stop / onRebuild 时统一复位。 */
(function (global) {
  'use strict';
  var WAP = global.WAP = global.WAP || {};
  var T = global.THREE;

  var SPEED = 1.55;
  var CONVEY_Y = 0.86;
  var LAND_Y = 0.02;
  var GRAVITY = 9.8;
  var EXIT = 0.62;

  var C = {
    ready: false, root: null,
    runners: [],            // 在途 runner（每件货物一个）
    rest: [],               // 已到达并静止保留的货物
    hidden: {},             // cargoId -> 引用计数（临时取下的货架货物）
    locks: {},              // agent: / lift: / dev: -> runnerId
    t: 0, seq: 1, maxJump: 0, conflicts: 0
  };

  function eq() { return WAP.equipment; }
  function sim() { return WAP.sim; }
  function routes() { return WAP.routes; }
  function rack() { return WAP.rack; }
  function cfg() { return WAP.state.cfg; }
  function geom() { return WAP.state.geom; }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function levelOf(y) { var c = cfg(); return clamp(Math.round((y - c.y0) / c.pitch), 0, c.levels - 1); }
  function levelY(l) { var c = cfg(); return c.y0 + clamp(l, 0, c.levels - 1) * c.pitch; }

  /* 货位显隐只改运行态，不写持久化覆盖（刷新后货架恢复原状） */
  function setOcc(id, occ) {
    if (!id) return false;
    var ov = WAP.state.overrides || (WAP.state.overrides = {});
    var had = Object.prototype.hasOwnProperty.call(ov, id), old = ov[id];
    var ok = false;
    try { ok = rack().setCellOcc(id, occ); } catch (e) { return false; }
    if (had) ov[id] = old; else delete ov[id];
    return ok;
  }
  function hideCargo(id) {
    if (!id || !setOcc(id, false)) return false;
    C.hidden[id] = (C.hidden[id] || 0) + 1;
    return true;
  }
  /* 调用方接管账本：只注销引用，不把货物放回原货位 */
  function forgetCargo(id) {
    if (!id) return;
    var n = C.hidden[id] || 0;
    if (n <= 1) delete C.hidden[id]; else C.hidden[id] = n - 1;
  }
  /* 中断 / 复位：把临时取下的货物放回原货位 */
  function restoreCargo(id) {
    if (!id) return;
    var n = C.hidden[id] || 0;
    if (n <= 1) { delete C.hidden[id]; setOcc(id, true); }
    else { C.hidden[id] = n - 1; setOcc(id, true); }
  }
  function restoreAll() {
    Object.keys(C.hidden).forEach(function (id) { setOcc(id, true); });
    C.hidden = {};
  }

  function lock(key, id) {
    if (!key) return true;
    if (C.locks[key] && C.locks[key] !== id) { C.conflicts++; return false; }
    C.locks[key] = id;
    return true;
  }
  function unlock(key, id) { if (key && C.locks[key] === id) delete C.locks[key]; }

  /* ---------------- 真实承载体 ----------------
     主通道＝沿 X 行驶（z 取 tracks 之一），子通道＝沿 Z 行驶（x 取 bayX 之一）。
     四向车绝不允许在子通道里平行于主通道行走：所有腿都严格轴对齐。 */
  function nearestTrackZ(z) {
    var tracks = ((geom() && geom().tracks) || []), best = 0, bd = 1e9;
    tracks.forEach(function (tz) {
      var d = Math.abs(tz - z);
      if (d < bd) { bd = d; best = tz; }
    });
    return best;
  }
  function borrowCar(r, level, x, z) {
    if (r.car) return r.car;
    var list = (sim().devices || []).filter(function (a) {
      return a.L === level && !C.locks['agent:' + a.id];
    });
    var best = null, bd = 1e9;
    list.forEach(function (a) {
      var d = Math.hypot(a.p.x - x, a.p.z - z);
      if (d < bd) { bd = d; best = a; }
    });
    if (!best || !lock('agent:' + best.id, r.id)) return null;
    var a = best;
    var saved = {
      q: (a.q || []).slice(), task: a.task, wait: a.wait,
      guard: a.guard, st: a.st, S: a.S || {}
    };
    /* 冻结自身任务队列：sim.stepAgent 不再驱动这台车，车由本 runner 驱动 */
    a.q = [];
    a.task = { label: '路线作业 · 四向车接驳', kind: 'flow', type: 'flow', flow: true };
    a.wait = 1e9; a.S = {};
    r.car = { a: a, saved: saved, deckY: levelY(level), legs: null, li: 0 };
    /* ① 子通道 Z 回主通道 → ② 主通道 X 到目标列 → ③ 子通道 Z 到接驳点。
       一次只动一根轴，绝不斜穿货架、也不在子通道里横向平移。 */
    var ax = a.p.x, az = a.p.z, tz = nearestTrackZ(az);
    var legs = [
      { x: ax, z: tz, tag: '回主通道' },
      { x: x, z: tz, tag: '主通道 X 行驶' },
      { x: x, z: z, tag: '子通道 Z 到接驳点' }
    ];
    var prev = { x: ax, z: az }, out = [];
    legs.forEach(function (p) {
      if (Math.abs(p.x - prev.x) > 0.02 || Math.abs(p.z - prev.z) > 0.02) {
        out.push({ x: p.x, z: p.z, tag: p.tag }); prev = p;
      }
    });
    r.car.legs = out;
    r.car.li = 0;
    return r.car;
  }
  function releaseCar(r) {
    var c = r.car;
    if (!c) return;
    unlock('agent:' + c.a.id, r.id);
    var a = c.a, s = c.saved;
    a.q = s.q.slice(); a.task = s.task; a.wait = s.wait;
    a.guard = s.guard; a.st = s.st; a.S = s.S || {};
    a.p.y = levelY(a.L);          // 车留在当前层继续被仿真调度，不消失、不复位
    r.car = null;
  }
  function moveCarAlong(r, dt) {
    var c = r.car, leg = c.legs[c.li];
    if (!leg) return true;
    var a = c.a, dx = leg.x - a.p.x, dz = leg.z - a.p.z;
    /* 空车去接驳点可以更快；两根轴严格分开，一次只动一根 */
    var step = SPEED * 1.8 * dt;
    if (Math.abs(dx) > 0.002) {
      if (Math.abs(dx) > step) a.p.x += Math.sign(dx) * step;
      else a.p.x = leg.x;
    } else if (Math.abs(dz) > 0.002) {
      if (Math.abs(dz) > step) a.p.z += Math.sign(dz) * step;
      else a.p.z = leg.z;
    }
    if (Math.abs(leg.x - a.p.x) < 0.002 && Math.abs(leg.z - a.p.z) < 0.002) {
      a.p.x = leg.x; a.p.z = leg.z; c.li++;
    }
    a.p.y = c.deckY;
    a.st = '路线接驳 · ' + (leg.tag || '前往取货点');
    return c.li >= c.legs.length;
  }
  function borrowLift(r, x, z, siteId) {
    if (r.lift) return r.lift;
    var best = null, bd = 1e9;
    (sim().lifts || []).forEach(function (lf) {
      /* 路线显式指定塔位时只用那一台，避免多塔时借错升降台 */
      if (siteId && lf.id !== siteId) return;
      var d = Math.hypot(lf.x - x, lf.z - z);
      if (d < bd) { bd = d; best = lf; }
    });
    if (!best || !lock('lift:' + best.id, r.id)) return null;
    var lf = best;
    lf.reqs = [];                 // sim.tickLifts 不再驱动这台提升机
    lf.phase = 'idle';
    lf.has = false;
    if (lf.unit) lf.unit.visible = false;
    if (lf.transfer) lf.transfer.visible = false;
    r.lift = { lf: lf, deckY: lf.ref ? lf.ref.mesh.position.y : lf.y };
    return r.lift;
  }
  /* 把原装载货台固定在指定高度：设备本体静止（覆盖 sim.tickLifts 的回落），
     只有货物沿输送线 / 台板表面做短距离平移。 */
  function holdLiftDeck(r, deckY) {
    var L = r.lift;
    if (!L || !L.lf.ref) return;
    var lf = L.lf;
    L.deckY = deckY;
    lf.y = deckY;
    lf.ref.mesh.position.y = deckY;
    lf.reqs = []; lf.phase = 'idle'; lf.has = false; lf.at = -1;
    if (lf.unit) lf.unit.visible = false;
    if (lf.transfer) lf.transfer.visible = false;
  }
  function liftDeckY(r) {
    var L = r.lift;
    if (!L) return levelY(0) - 0.06;
    /* 用 runner 自己维护的台板高度做状态量：sim.tickLifts 每帧会把台板
       往底层拉，若直接读 mesh 会导致「匀速平层」被抵消而永远走不到。 */
    if (isFinite(L.deckY)) return L.deckY;
    return L.lf.ref ? L.lf.ref.mesh.position.y : L.lf.y;
  }
  function liftRelated(st) {
    return !!st && (st.mode === 'lift' || st.mode === 'liftWait' ||
      st.mode === 'liftIdle' || st.transferToLift || st.transferFromLift);
  }
  function releaseLift(r) {
    var L = r.lift;
    if (!L) return;
    var lf = L.lf;
    unlock('lift:' + lf.id, r.id);
    if (lf.ref) { lf.y = lf.ref.y0; lf.ref.mesh.position.y = lf.y; }
    lf.at = -1; lf.has = false; lf.phase = 'idle';
    if (lf.unit) lf.unit.visible = false;
    r.lift = null;
  }
  function syncLift(r) {
    /* 载货换层时台板与货物一同匀速垂直移动 */
    holdLiftDeck(r, r.y - 0.06);
  }
  function engage(r, ids) {
    var list = (ids || []).filter(function (id) { return !!id; });
    if (!list.length) return true;
    var got = [], i;
    for (i = 0; i < list.length; i++) {
      if (!lock('dev:' + list[i], r.id)) {
        /* 回滚已取得的锁，避免半占用造成死锁 */
        got.forEach(function (id) { unlock('dev:' + id, r.id); });
        return false;                                     // 设备被占用 → 排队
      }
      got.push(list[i]);
    }
    r.engaged = r.engaged.concat(got);
    if (eq() && eq().setEngaged) eq().setEngaged(got, true);
    return true;
  }
  function disengage(r) {
    if (r.engaged && r.engaged.length) {
      if (eq() && eq().setEngaged) eq().setEngaged(r.engaged, false);
      r.engaged.forEach(function (id) { unlock('dev:' + id, r.id); });
    }
    r.engaged = [];
  }

  /* ---------------- 步骤规整 ----------------
     通道拓扑硬约束（用户 2026-11-12 第 11 轮强调）：
     · 层间输送线所在的那一排是「子通道货架」，不是主通道；
     · 子通道（横轴 Z）里四向车只能沿 Z 走，主通道（纵轴 X）里只能沿 X 走；
     · 任何「在子通道里横向 X 平移」或斜穿货架的 shuttle 段都要改写成
       「Z 回主通道 → X 沿主通道 → Z 进目标子通道」三段。
     纯 Z 段（固定 x，在子通道内前后走）本身合法，保持原样。 */
  function mainTrackZ(z) {
    return nearestTrackZ(z);
  }
  function canonicalShuttle(s) {
    var x1 = s.fromX, z1 = s.fromZ, x2 = s.toX, z2 = s.toZ;
    var dx = Math.abs(x2 - x1), dz = Math.abs(z2 - z1);
    if (dx <= 0.02) return [s];                 // 纯子通道 Z 段：合法
    if (dz <= 0.02 && Math.abs(z1 - mainTrackZ(z1)) <= 0.05) return [s]; // 合法主通道 X 段
    var mz = mainTrackZ(z1), legs = [];
    if (Math.abs(mz - z1) > 0.02) legs.push([x1, z1, x1, mz, '子通道 Z 回主通道']);
    if (dx > 0.02) legs.push([x1, mz, x2, mz, '主通道 X 行驶']);
    if (Math.abs(z2 - mz) > 0.02) legs.push([x2, mz, x2, z2, '子通道 Z 到目标位']);
    if (!legs.length) return [s];
    return legs.map(function (q) {
      var n = {};
      Object.keys(s).forEach(function (k) {
        n[k] = Array.isArray(s[k]) ? s[k].slice() : s[k];
      });
      n.fromX = q[0]; n.fromZ = q[1]; n.toX = q[2]; n.toZ = q[3];
      n.note = '四向车 · ' + q[4];
      delete n.distance; delete n.dirX; delete n.dirZ;
      delete n.exitX; delete n.exitZ;
      return n;
    });
  }
  function normalizeSteps(arr) {
    var out = [];
    (arr || []).forEach(function (s) {
      if (s.mode !== 'shuttle') { out.push(s); return; }
      canonicalShuttle(s).forEach(function (q) { out.push(q); });
    });
    return out.map(cloneStep);
  }
  function cloneStep(s) {
    var q = {};
    Object.keys(s).forEach(function (k) {
      var v = s[k];
      q[k] = Array.isArray(v) ? v.slice() : v;
    });
    var dx = q.toX - q.fromX, dz = q.toZ - q.fromZ;
    var d = Math.hypot(dx, dz);
    q.distance = d;
    q.dirX = d > 1e-6 ? dx / d : 0;
    q.dirZ = d > 1e-6 ? dz / d : 0;
    if (!isFinite(q.exitX)) q.exitX = q.fromX + q.dirX * EXIT;
    if (!isFinite(q.exitZ)) q.exitZ = q.fromZ + q.dirZ * EXIT;
    return q;
  }
  function nearestGroundCell(x, z, maxD) {
    var best = null, bd = 1e9;
    ((eq() && eq().cells) || []).forEach(function (c) {
      if (c.kind !== 'ground') return;
      var d = Math.hypot(c.x - x, c.z - z);
      if (maxD != null && d > maxD) return;
      if (d < bd) { bd = d; best = c; }
    });
    return best;
  }

  /* ---------------- runner ----------------
     opt = { seq | steps, kind, cls, cargoId, unit, tag, onArrive, end, meta }
     onArrive(info) 返回 true 表示调用方接管 unit（自行移除 / 复用）。 */
  function run(opt) {
    opt = opt || {};
    var steps = opt.steps;
    if (!steps) {
      var rs = routes();
      if (!rs || !rs.planSeq || !opt.seq || opt.seq.length < 2) return null;
      steps = rs.planSeq(opt.seq);
    }
    if (!steps || !steps.length) return null;
    /* 所有来源（planSeq / 外部传入的 raw steps）统一做通道轴向规整 */
    steps = normalizeSteps(steps);
    var first = steps[0];
    var x0 = first.fromX, z0 = first.fromZ;
    var y0 = Math.max(LAND_Y, first.fromY);

    var unit = opt.unit || rack().makeCargoUnit(opt.kind || 'carton',
      (C.seq * 17) % 997, opt.cls || 'single');
    if (!unit.parent) C.root.add(unit);
    unit.position.set(x0, y0, z0);

    var r = {
      id: 'cr' + (C.seq++), tag: opt.tag || 'route',
      unit: unit, steps: steps, idx: 0,
      x: x0, y: y0, z: z0, phase: 'move',
      cargoId: opt.cargoId || null, onArrive: opt.onArrive || null,
      /* 起点货物「绝不临时消失」：静态货物一直留在货位上，
         四向车到位后才在同一坐标换成交由车承载的移动单元。 */
      hiddenDone: false, pendingHide: !!opt.cargoId,
      loadY0: y0, loadT: 0,
      car: null, lift: null, engaged: [], engagedFor: -1, fall: null,
      justAdvanced: false,
      landed: false, done: false, meta: opt.meta || {},
      kind: opt.kind || 'carton', cls: opt.cls || 'single',
      seq: (opt.seq || []).slice()
    };
    /* 首段在库内水平 → 真实四向车先开过来接驳，货物在货位上等车 */
    var rec = null;
    if (first.mode === 'shuttle') rec = borrowCar(r, levelOf(first.fromY), x0, z0);
    if (r.cargoId) {
      if (rec) {
        r.phase = 'approach';
        unit.visible = false;              // 静态货物仍在货架上，移动单元先不显示
      } else {
        /* 首段不是四向车（如直接换层 / 输送线）：同一帧内一 hide 一 show，
           坐标完全一致，画面上不会出现货物消失的空档。 */
        if (hideCargo(r.cargoId)) r.hiddenDone = true;
        r.pendingHide = false;
        unit.visible = true;
      }
    } else unit.visible = true;
    C.runners.push(r);
    return r;
  }

  function beginFall(r, st) {
    var ex = st && isFinite(st.exitX) ? st.exitX : r.x;
    var ez = st && isFinite(st.exitZ) ? st.exitZ : r.z;
    var lx = st && isFinite(st.landX) ? st.landX : ex;
    var lz = st && isFinite(st.landZ) ? st.landZ : ez;
    if (st && st.landKey) {
      var cell = nearestGroundCell(lx, lz, 2.6);
      if (cell) { lx = cell.x; lz = cell.z; }
    } else {
      var near = nearestGroundCell(lx, lz, 3.2);
      if (near) { lx = near.x; lz = near.z; }
    }
    r.fall = { ex: ex, ez: ez, lx: lx, lz: lz, y0: Math.max(CONVEY_Y, r.y), vy: 0, vx: 0, vz: 0,
      fallT: 0, elapsed: 0 };
    r.phase = 'exit';
  }
  function tickFall(r, dt) {
    var f = r.fall;
    if (!f) { r.phase = 'move'; return; }
    if (r.phase === 'exit') {
      var dx = f.ex - r.x, dz = f.ez - r.z, d = Math.hypot(dx, dz), step = SPEED * dt;
      C.maxJump = Math.max(C.maxJump, Math.min(d, step));
      if (d > step) { r.x += dx / d * step; r.z += dz / d * step; }
      else {
        r.x = f.ex; r.z = f.ez;
        var gravityT = Math.sqrt(2 * Math.max(0.1, r.y - LAND_Y) / GRAVITY);
        var hdist = Math.hypot(f.lx - r.x, f.lz - r.z);
        f.fallT = Math.max(gravityT, hdist / SPEED, 0.16);
        f.vx = (f.lx - r.x) / f.fallT;
        f.vz = (f.lz - r.z) / f.fallT;
        f.vyScale = Math.pow(gravityT / f.fallT, 2);
        r.phase = 'fall';
      }
      r.unit.position.set(r.x, r.y, r.z);
      return;
    }
    /* 自由落体（不是空中直线补间），落地后静止保留 */
    f.elapsed += dt;
    r.x += f.vx * dt; r.z += f.vz * dt;
    f.vy -= GRAVITY * (f.vyScale || 1) * dt;
    r.y += f.vy * dt;
    C.maxJump = Math.max(C.maxJump, Math.hypot(f.vx * dt, f.vy * dt, f.vz * dt));
    if (r.y <= LAND_Y) {
      r.y = LAND_Y; r.x = f.lx; r.z = f.lz;
      r.unit.position.set(r.x, r.y, r.z);
      r.landed = true;
      finish(r);
    } else r.unit.position.set(r.x, r.y, r.z);
  }

  function next(r) {
    disengage(r);
    r.engagedFor = -1;
    var nxt = r.steps[r.idx + 1];
    /* 平层等待 / 上台转运 / 载货换层 / 离台转运 / 空台续动 属于同一台提升机，
       整段结束前不能提前把台板交还仿真。 */
    if (r.lift && !liftRelated(nxt)) releaseLift(r);
    if (r.car && (!nxt || nxt.mode !== 'shuttle')) releaseCar(r);
    r.idx++; r.fall = null; r.phase = 'move';
    /* 段尾那一小步属于上一段的承载体；新段承载体在下一帧申请，
       标记为 pending 而不是 waiting，避免误判成「没有承载体却在移动」 */
    r.justAdvanced = true;
    if (r.idx >= r.steps.length) finish(r);
  }
  function finish(r) {
    if (r.done) return;
    releaseCar(r); releaseLift(r); disengage(r);
    r.done = true; r.phase = 'done';
    var info = {
      x: r.x, y: r.y, z: r.z, landed: r.landed,
      unit: r.unit, tag: r.tag, cargoId: r.cargoId,
      steps: r.steps, runnerId: r.id, meta: r.meta
    };
    var took = false;
    if (r.onArrive) {
      try { took = r.onArrive(info) === true; } catch (e) { took = false; }
    }
    if (r.cargoId && r.hiddenDone) forgetCargo(r.cargoId);   // 调用方负责账本（放池 / 换货位）
    if (took) {
      if (r.unit.parent) r.unit.parent.remove(r.unit);
    } else {
      C.rest.push({ id: r.id, tag: r.tag, unit: r.unit,
        x: r.x, y: r.y, z: r.z, kind: r.kind, cls: r.cls,
        landed: r.landed, meta: r.meta });
      if (!r.onArrive && r.cargoId) setOcc(r.cargoId, true);
    }
  }
  function tickRunner(r, dt) {
    if (r.done) return;
    if (r.justAdvanced) r.justAdvanced = false;
    if (r.phase === 'approach') {
      if (!r.car) { r.phase = 'move'; return; }
      if (moveCarAlong(r, dt)) {
        /* 车已到货位：此刻才把静态货物取下，并在「完全相同的位置」
           显示移动单元，避免先消失、后突然出现。 */
        var doLoad = !!(r.cargoId && r.pendingHide);
        if (doLoad) {
          if (hideCargo(r.cargoId)) r.hiddenDone = true;
          r.pendingHide = false;
        }
        r.x = r.car.a.p.x; r.z = r.car.a.p.z;
        r.unit.visible = true;
        r.unit.position.set(r.x, r.y, r.z);
        if (doLoad) {
          r.loadY0 = r.y; r.loadT = 0;
          r.phase = 'load';               // 顶升取货：车停着，货物缓缓抬到车板
        } else {
          r.y = r.car.deckY + 0.30;      // 中途交接：直接放到车板高度
          r.unit.position.set(r.x, r.y, r.z);
          r.phase = 'move';
        }
      }
      return;
    }
    if (r.phase === 'load') {
      if (!r.car) { r.phase = 'move'; return; }
      var top = r.car.deckY + 0.30;
      r.loadT += dt;
      var u = clamp(r.loadT / 0.34, 0, 1);
      r.y = r.loadY0 + (top - r.loadY0) * u;
      r.x = r.car.a.p.x; r.z = r.car.a.p.z;
      r.unit.visible = true;
      r.unit.position.set(r.x, r.y, r.z);
      C.maxJump = Math.max(C.maxJump, Math.abs(top - r.loadY0) * dt / 0.34);
      if (u >= 1) r.phase = 'move';
      return;
    }
    if (r.phase === 'exit' || r.phase === 'fall') { tickFall(r, dt); return; }
    var st = r.steps[r.idx];
    if (!st) { finish(r); return; }
    var step = SPEED * dt;

    if (st.mode === 'shuttle') {
      /* 货架内水平移动：必须骑在当层真实四向车上 */
      var rec = r.car || borrowCar(r, levelOf(st.fromY), st.fromX, st.fromZ);
      if (!rec) return;                        // 车被占用 → 等待，不裸移
      if (r.car && r.car.li < r.car.legs.length) {
        r.phase = 'approach';                 // 中途接驳：车先开到层间输送线
        if (moveCarAlong(r, dt)) {
          r.phase = 'move'; r.unit.visible = true;
          r.x = rec.a.p.x; r.z = rec.a.p.z; r.y = rec.deckY + 0.30;
        }
        return;
      }
      var a = rec.a;
      /* 通道轴向硬约束：X 段只动 x（且 z 保持在主通道），Z 段只动 z。
         即使规划给出斜线，也一律拆成「先 X 后 Z」的 L 形，绝不斜穿。 */
      var diagonal = Math.abs(st.dirX) > 0.02 && Math.abs(st.dirZ) > 0.02;
      var useX = diagonal ? Math.abs(st.toX - r.x) > 0.002 : Math.abs(st.dirX) >= Math.abs(st.dirZ);
      if (!diagonal) { if (useX) r.z = st.fromZ; else r.x = st.fromX; }
      var delta = useX ? (st.toX - r.x) : (st.toZ - r.z);
      var ad = Math.abs(delta), mv = Math.min(ad, step);
      if (ad > 1e-6) { if (useX) r.x += Math.sign(delta) * mv; else r.z += Math.sign(delta) * mv; }
      r.y = rec.deckY + 0.30;
      a.p.set(r.x, rec.deckY, r.z);
      a.st = '路线接驳 · ' + (useX ? '主通道 X 载货行驶' : '子通道 Z 载货行驶');
      r.unit.visible = true;
      r.unit.position.set(r.x, r.y, r.z);
      C.maxJump = Math.max(C.maxJump, mv);
      var rest = Math.abs(st.toX - r.x) + Math.abs(st.toZ - r.z);
      if (rest <= step || (diagonal && rest < 0.003)) {
        r.x = st.toX; r.z = st.toZ; next(r);
      }
      return;
    }
    if (st.mode === 'liftWait') {
      /* 货物已到层间输送线静置位并暂停；空升降台匀速移动到等高平层。
         这段时间货物完全静止，只有台板在动。 */
      if (!borrowLift(r, st.fromX, st.towerZ != null ? st.towerZ : st.fromZ, st.siteId)) return;
      var want = (st.deckY != null ? st.deckY : st.fromY) - 0.06;
      var cur = liftDeckY(r), dd = want - cur, vw = 1.25 * dt;
      if (Math.abs(dd) > vw) cur += Math.sign(dd) * vw; else cur = want;
      holdLiftDeck(r, cur);
      r.unit.visible = true;
      r.unit.position.set(r.x, r.y, r.z);
      C.maxJump = Math.max(C.maxJump, Math.min(Math.abs(dd), vw));
      if (cur === want) next(r);
      return;
    }
    if (st.mode === 'lift') {
      /* 上下移动：真实提升机载货台带着货物匀速垂直转运，绝不斜飞 */
      if (!borrowLift(r, st.fromX, st.towerZ != null ? st.towerZ : st.fromZ, st.siteId)) return;
      var dy = st.toY - r.y, vs = 1.25 * dt;
      if (Math.abs(dy) > vs) r.y += Math.sign(dy) * vs;
      else r.y = st.toY;
      r.x = st.fromX; r.z = st.fromZ;
      syncLift(r);
      r.unit.visible = true;
      r.unit.position.set(r.x, r.y, r.z);
      C.maxJump = Math.max(C.maxJump, vs);
      if (r.y === st.toY) next(r);
      return;
    }
    if (st.mode === 'liftIdle') {
      /* 货物已被转运走之后，空台才继续匀速移动（回到底层待命） */
      if (!borrowLift(r, st.fromX, st.towerZ != null ? st.towerZ : st.fromZ, st.siteId)) return;
      var lf = r.lift.lf, base = lf.ref ? lf.ref.y0 : liftDeckY(r);
      var now = liftDeckY(r), back = base - now, vi = 1.25 * dt;
      if (Math.abs(back) > vi) now += Math.sign(back) * vi; else now = base;
      holdLiftDeck(r, now);
      r.unit.visible = true;
      r.unit.position.set(r.x, r.y, r.z);
      C.maxJump = Math.max(C.maxJump, Math.min(Math.abs(back), vi));
      if (now === base) { releaseLift(r); next(r); }
      return;
    }
    if (st.mode === 'conveyor') {
      /* 货架外转运：必须由场景内输送设备（engaged）承担；
         没有设备且不是库内层间输送线 → 不允许裸移，改为掉落 */
      var ids = (st.devices || []).map(function (d) { return d.id || d; });
      if (!ids.length && !st.innerConveyor) { beginFall(r, st); return; }
      if (r.engagedFor !== r.idx) {          // 每段只需申请一次设备
        if (!engage(r, ids)) return;         // 设备被占用 → 等待
        r.engagedFor = r.idx;
      }
      /* 层间输送线 ↔ 升降台接驳：台板与输送线都保持静止，
         只有货物沿设备表面做短距离 Z 向平移（用户明确要求的转运语义）。 */
      if (st.transferToLift || st.transferFromLift) {
        if (!r.lift) borrowLift(r, st.fromX, st.towerZ != null ? st.towerZ : st.fromZ, st.siteId);
        if (r.lift) holdLiftDeck(r, st.fromY - 0.06);
      }
      var ex = st.toX - r.x, ez = st.toZ - r.z;
      var d2 = Math.hypot(ex, ez);
      if (d2 > step) { r.x += st.dirX * step; r.z += st.dirZ * step; }
      else { r.x = st.toX; r.z = st.toZ; }
      r.y = Math.max(LAND_Y, st.fromY);
      r.unit.visible = true;
      r.unit.position.set(r.x, r.y, r.z);
      C.maxJump = Math.max(C.maxJump, Math.min(d2, step));
      if (d2 <= step) next(r);
      return;
    }
    /* drop：无设备接驳 → 超出末端后重力落地静止 */
    beginFall(r, st);
  }

  /* ---------------- 主循环 / 管理 ---------------- */
  function tick(dt) {
    if (!C.ready) return;
    C.t += dt;
    var snap = C.runners.slice();
    for (var i = 0; i < snap.length; i++) {
      if (!snap[i].done) tickRunner(snap[i], dt);
    }
    C.runners = C.runners.filter(function (r) { return !r.done; });
    /* 每个 runner 在本帧已经把台板高度算好；这里只重申「仿真不接管这台提升机」，
       绝不改写高度，否则会破坏「等待平层 / 台板静止 / 空台匀速续动」的时序。 */
    C.runners.forEach(function (r) {
      if (!r.lift) return;
      var lf = r.lift.lf;
      lf.reqs = []; lf.phase = 'idle'; lf.has = false; lf.at = -1;
      if (lf.unit) lf.unit.visible = false;
      if (lf.transfer) lf.transfer.visible = false;
    });
  }
  function dropRunner(r, restore) {
    if (r.done) return;
    releaseCar(r); releaseLift(r); disengage(r);
    if (restore && r.cargoId && r.hiddenDone) restoreCargo(r.cargoId);
    else if (r.cargoId && r.hiddenDone) forgetCargo(r.cargoId);
    if (r.unit && r.unit.parent) r.unit.parent.remove(r.unit);
    r.done = true; r.phase = 'done';
  }
  function cancel(tag) {
    var n = 0;
    C.runners.slice().forEach(function (r) {
      if (tag && r.tag !== tag) return;
      dropRunner(r, true); n++;
    });
    C.runners = C.runners.filter(function (r) { return !r.done; });
    return n;
  }
  function clear(tag) {
    var n = cancel(tag);
    var keep = [];
    C.rest.forEach(function (q) {
      if (tag && q.tag !== tag) { keep.push(q); return; }
      if (q.unit && q.unit.parent) q.unit.parent.remove(q.unit);
      n++;
    });
    C.rest = keep;
    return n;
  }
  /* 收货器：半径内的在途 / 静止货物全部消失 */
  function purgeAt(x, z, radius) {
    var rr = radius == null ? 1.35 : radius, n = 0;
    C.runners.slice().forEach(function (r) {
      if (Math.hypot(r.x - x, r.z - z) < rr) {
        dropRunner(r, false); n++;
      }
    });
    C.runners = C.runners.filter(function (r) { return !r.done; });
    var keep = [];
    C.rest.forEach(function (q) {
      if (Math.hypot(q.x - x, q.z - z) < rr) {
        if (q.unit && q.unit.parent) q.unit.parent.remove(q.unit);
        n++;
      } else keep.push(q);
    });
    C.rest = keep;
    return n;
  }
  function detachRest(unit) {
    for (var i = 0; i < C.rest.length; i++) {
      if (C.rest[i].unit === unit) { C.rest.splice(i, 1); return unit; }
    }
    return unit;
  }
  function count(tag) {
    var active = 0, rest = 0;
    C.runners.forEach(function (r) { if (!tag || r.tag === tag) active++; });
    C.rest.forEach(function (q) { if (!tag || q.tag === tag) rest++; });
    return { active: active, rest: rest };
  }
  function reset() {
    C.runners.slice().forEach(function (r) { dropRunner(r, true); });
    C.runners = [];
    C.rest.forEach(function (q) { if (q.unit && q.unit.parent) q.unit.parent.remove(q.unit); });
    C.rest = [];
    restoreAll();
    C.locks = {}; C.conflicts = 0; C.maxJump = 0;
    if (eq() && eq().clearEngaged) eq().clearEngaged();
  }
  function snapshot() {
    var byTag = {}, carriers = { shuttle: 0, lift: 0, liftWait: 0, liftIdle: 0,
      handoff: 0, conveyor: 0, drop: 0 };
    C.runners.forEach(function (r) {
      byTag[r.tag] = (byTag[r.tag] || 0) + 1;
      var st = r.steps[r.idx];
      if (st) {
        var key = (st.transferToLift || st.transferFromLift) ? 'handoff' : st.mode;
        carriers[key] = (carriers[key] || 0) + 1;
      }
    });
    var locks = {};
    Object.keys(C.locks).forEach(function (k) { locks[k] = C.locks[k]; });
    return {
      ready: C.ready, active: C.runners.length, rest: C.rest.length,
      byTag: byTag, carriers: carriers, locks: locks, conflicts: C.conflicts,
      hidden: Object.keys(C.hidden).length,
      maxJump: +C.maxJump.toFixed(3), noFly: C.maxJump < 1.3,
      runners: C.runners.map(function (r) {
        var st = r.steps[r.idx] || {};
        var carry = (st.transferToLift || st.transferFromLift) ? 'handoff'
          : r.car ? 'shuttle:' + r.car.a.id
          : (r.lift ? 'lift:' + r.lift.lf.id
            : (r.engaged.length ? 'conveyor:' + r.engaged.length
              : (st.innerConveyor ? 'inner-conveyor'
                : (r.phase === 'fall' || r.phase === 'exit' ? 'gravity'
                  : (r.justAdvanced ? 'pending'
                    : (st.mode === 'drop' ? 'gravity' : 'waiting'))))));
        return { id: r.id, tag: r.tag, phase: r.phase, idx: r.idx,
          mode: st.mode || null, x: +r.x.toFixed(2), y: +r.y.toFixed(2), z: +r.z.toFixed(2),
          car: r.car ? r.car.a.id : null, lift: r.lift ? r.lift.lf.id : null,
          engaged: r.engaged.slice(), cargoId: r.cargoId,
          carrier: carry, waiting: carry === 'waiting', inner: !!st.innerConveyor };
      })
    };
  }
  function init() {
    C.root = new T.Group();
    C.root.userData.kind = 'carrier';
    WAP.scene.S.modelRoot.add(C.root);
    /* 必须最后包装：carrier.tick 在 sim.tickLifts 之后执行，
       才能覆盖载货台回落、冻结车位置，保证画面上货物确实骑在设备上 */
    var prevTick = WAP.scene.S.onTick;
    WAP.scene.S.onTick = function (dt) { if (prevTick) prevTick(dt); tick(dt); };
    var prevStop = WAP.sim.stop;
    WAP.sim.stop = function () { prevStop(); reset(); };
    var prevRebuild = WAP.sim.onRebuild;
    WAP.sim.onRebuild = function () { prevRebuild(); reset(); };
    C.ready = true;
  }

  WAP.carrier = {
    init: init, tick: tick, run: run, reset: reset,
    cancel: cancel, clear: clear, purgeAt: purgeAt,
    detachRest: detachRest, count: count, snapshot: snapshot,
    /* 与「路线设计」旧运行器共用同一套设备互斥锁，避免两台提升机被同时抢用 */
    claim: function (key, id) { return lock(key, id); },
    releaseLock: function (key, id) { unlock(key, id); },
    cargoPoints: function () {
      var out = [];
      C.runners.forEach(function (r) {
        if (r.unit && r.unit.visible) out.push({ x: r.x, y: r.y, z: r.z });
      });
      C.rest.forEach(function (q) {
        if (q.unit && q.unit.visible) out.push({ x: q.x, y: q.y, z: q.z });
      });
      return out;
    },
    setOcc: setOcc, normalizeSteps: normalizeSteps, cloneStep: cloneStep,
    get rest() { return C.rest; },
    get runners() { return C.runners; }
  };
})(window);
