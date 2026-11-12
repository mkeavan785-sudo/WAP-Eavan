/* WAP-Eavan · sim.js
   四向库「货物运行」仿真引擎 —— 按实际四向库作业逻辑重建：
     · X 方向主通道换列、Z 方向子通道进出货位，全部在同一层内完成；
       货架中间保留子通道、不挖空，本期不制作维修通道。
     · 每层至少 1 台四向车，固定层作业，不跨层、不搭乘提升机。
     · 提升机均匀对接前端「子通道口」；货物上升到位后，以可见的水平转运
       进入该层「层间输送线」（两条平行黑色长方体）并静置，绝不自行移动。
     · 货物到位之后，当层四向车才从主通道出发前往输送线接驳，再送进目标货位；
       出库反向。货物单元与货架静态货物共用同一份外观定义，流转中不会变样。
     · 存货遵循「两端有主通道先存中间、一端有主通道先存最里面」的真实规则。
   货位状态通过 WAP.rack.setCellOcc 局部更新实例矩阵，不重建整库。 */
(function (global) {
  'use strict';
  var WAP = global.WAP = global.WAP || {};
  var T = global.THREE;
  var D = global.document;

  var MM = WAP.materials;
  var clamp = WAP.core.clamp;

  var G = {
    root: null, devices: [], lifts: [], buffers: {}, marks: [],
    playing: false, stepPending: false, speed: 1, mode: 'auto',
    t: 0, uiAt: 0,
    stats: { inb: 0, outb: 0, cycles: 0, duration: 0 },
    completions: [], logs: [], seq: 0,
    reserved: {}, bufRes: {},
    sparsed: false, focusId: null, focusMark: null,
    ready: false
  };

  /* ---------------- 小工具 ---------------- */
  function cfg() { return WAP.state.cfg; }
  function geom() { return WAP.state.geom; }
  function rack() { return WAP.rack.current; }
  function levelY(l) { return cfg().y0 + l * cfg().pitch - 0.19; }
  function cellY(l) { return cfg().y0 + l * cfg().pitch; }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function fmtClock(t) {
    var m = Math.floor(t / 60), s = Math.floor(t % 60);
    return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }
  function rnd(n) { return Math.floor(Math.random() * n); }
  function same(a, b) { return Math.abs(a - b) < 0.02; }
  function bufKey(lf, l) { return lf.id + ':' + l; }

  function log(kind, text) {
    G.seq++;
    G.logs.unshift({ id: G.seq, t: fmtClock(G.t), kind: kind, text: text });
    if (G.logs.length > 36) G.logs.pop();
    if (WAP.ui && WAP.ui.simLog) WAP.ui.simLog(G.logs);
  }

  /* 在途货物 = 货架静态货物的同一份外观定义（尺寸 / 贴图 / 堆叠完全一致） */
  function makeLoad(kind, seed) {
    return WAP.rack.makeCargoUnit(kind || 'carton', seed || 0);
  }
  function setSkin(holder, kind, seed) {
    WAP.rack.setUnitSkin(holder, kind, seed);
  }

  function disposeVisual() {
    if (!G.root) return;
    while (G.root.children.length) {
      var o = G.root.children[0];
      G.root.remove(o);
      o.traverse(function (n) {
        if (n.geometry && !n.geometry.userData.shared) n.geometry.dispose();
        if (n.material) {
          var ms = Array.isArray(n.material) ? n.material : [n.material];
          ms.forEach(function (m) {
            if (m.userData && m.userData.shared) return;
            if (m.map && !m.map.userData) m.map.dispose();
            m.dispose();
          });
        }
      });
    }
  }

  /* 作业货位脉冲框：每台车一个 */
  function makeMark() {
    var g = new T.Group();
    var m = new T.Mesh(
      new T.BoxGeometry(1, 1, 1),
      new T.MeshBasicMaterial({ color: 0x22c1a4, transparent: true, opacity: 0.16, depthTest: false, depthWrite: false })
    );
    var e = new T.LineSegments(
      new T.EdgesGeometry(new T.BoxGeometry(1, 1, 1)),
      new T.LineBasicMaterial({ color: 0x0d9488, transparent: true, opacity: 0.95, depthTest: false })
    );
    m.renderOrder = 970; e.renderOrder = 971;
    m.add(e); g.add(m); g.visible = false;
    g.userData.mat = m.material; g.userData.edge = e.material;
    return g;
  }

  /* 设备聚焦环：跟随被点选的设备，明确告诉使用者镜头对的是哪一台 */
  function makeFocusRing() {
    var g = new T.Group();
    [[0.70, 0.84, 0.90], [1.02, 1.09, 0.45]].forEach(function (p) {
      var ring = new T.Mesh(
        new T.RingGeometry(p[0], p[1], 40),
        new T.MeshBasicMaterial({ color: 0x10b981, transparent: true, opacity: p[2],
          side: T.DoubleSide, depthTest: false, depthWrite: false, toneMapped: false })
      );
      ring.rotation.x = -Math.PI / 2;
      ring.renderOrder = 962;
      g.add(ring);
    });
    g.visible = false;
    return g;
  }

  function setMark(a, cell, kind) {
    var mark = a.mark;
    if (!cell) { mark.visible = false; a.markCell = null; return; }
    var c = new T.Color(kind === 'in' ? 0x10b981 : 0xf59e0b);
    mark.userData.mat.color.copy(c);
    mark.userData.edge.color.copy(c);
    mark.position.set(cell.x, cell.y + cfg().pitch * 0.43, cell.z);
    mark.scale.set(cfg().bayW * 0.94, cfg().pitch * 0.88, cfg().dp * 0.94);
    mark.visible = true;
    a.markCell = cell.id;
  }

  /* ---------------- 设备装配 ---------------- */
  function buildDevices() {
    disposeVisual();
    G.devices = []; G.lifts = []; G.buffers = {}; G.marks = [];
    G.reserved = {}; G.bufRes = {};
    var c = cfg(), g = geom(), r = rack();
    G.focusId = null;
    if (!g || !r) return;

    G.focusMark = makeFocusRing();
    G.root.add(G.focusMark);

    /* 提升机：复用 rack 里已建好的载货台，编号与名称完整 */
    (r.liftPlats || []).forEach(function (lp) {
      lp.unit.visible = false;
      lp.mesh.position.y = lp.y0;
      var lf = {
        id: lp.id, name: lp.name, code: lp.id, ref: lp, unit: lp.unit,
        site: lp.site, x: lp.x, z: lp.z, convZ: lp.convZ,
        y: lp.y0, reqs: [], phase: 'idle', at: -1,
        has: false, kind: 'carton', tr: null
      };
      /* 转运货物：提升机台板 ↔ 层间输送线之间的水平移动，全程可见 */
      var tr = new T.Group();
      tr.userData.kind = 'cargo';
      setSkin(tr, 'carton', 0);
      tr.visible = false;
      G.root.add(tr);
      lf.transfer = tr;
      G.lifts.push(lf);

      /* 每台提升机 × 每层的层间输送线缓存位：货物在此静置等车 / 等提升机 */
      var map = G.buffers[lf.id] = {};
      for (var l = 0; l < c.levels; l++) {
        var holder = new T.Group();
        holder.userData.kind = 'cargo';
        setSkin(holder, 'carton', 1);
        holder.position.set(lf.x, cellY(l), lf.convZ);
        holder.visible = false;
        G.root.add(holder);
        map[l] = { obj: holder, l: l, lift: lf, state: 'empty', owner: null, kind: 'carton' };
      }
    });

    /* 四向车：每层 perLevel 台，编号 SC-01…，固定绑定层 L，永不跨层 */
    var per = clamp(c.perLevel, 1, 3), total = c.levels * per, n = 0;
    for (var lv = 0; lv < c.levels; lv++) {
      for (var j = 0; j < per; j++) {
        n++;
        var id = 'SC-' + pad2(n);
        var sh = WAP.rack.buildShuttle(c);
        var obj = sh.group;
        obj.userData.kind = 'shuttle';
        var A = (n - 1) % Math.max(1, g.tracks.length);
        var startI = clamp(Math.floor((n - 0.5) * g.bayX.length / total), 0, g.bayX.length - 1);
        obj.position.set(g.bayX[startI], levelY(lv), g.tracks[A] || 0);
        G.root.add(obj);
        var mark = makeMark(); G.root.add(mark);
        var a = {
          id: id, code: id, name: '四向穿梭车 ' + id,
          obj: obj, sh: sh, p: obj.position,
          q: [], wait: 0.5 + n * 0.28, S: {},
          vE: c.vE / 100, vL: c.vL / 100, ramp: 1.6,
          fy: sh.deckY, fork: sh.plate, lamp: sh.lamp,
          carry: null, L: lv, A: A,
          st: '待机', task: null, done: 0, needCharge: false, charging: false,
          mark: mark, markCell: null, guard: 0
        };
        G.devices.push(a);
        G.marks.push(mark);
      }
    }
  }

  /* ---------------- Mover：S 曲线速度，固定层内行走 ---------------- */
  function spR(a, k, t, d, V, Ta, dt) {
    var st = a.S[k];
    if (!st || st.t !== t) {
      var v = V, ta = Ta;
      if (d < V * Ta) { v = Math.sqrt(d * V / Ta); ta = Ta * v / V; }
      st = a.S[k] = { t: t, D: d, V: v, ta: ta, T: 2 * ta + (d - v * ta) / v, time: 0, done: 0 };
    }
    st.time += dt;
    var S1 = function (u) { return u * u * u - u * u * u * u / 2; };
    var tt = Math.min(st.time, st.T);
    var s = tt < st.ta ? st.V * st.ta * S1(tt / st.ta)
      : (tt > st.T - st.ta ? st.D - st.V * st.ta * S1((st.T - tt) / st.ta)
        : st.V * st.ta / 2 + st.V * (tt - st.ta));
    var dd = s - st.done; st.done = s;
    if (st.time >= st.T) { a.S[k] = null; return d; }
    return Math.max(0, Math.min(dd, d));
  }

  function stepAgent(a, dt) {
    if (a.wait > 0) { a.wait -= dt; return; }
    if (!a.q.length) { gen(a); if (!a.q.length) return; }
    var t = a.q[0];
    if (t.until && !t.until(a)) { a.st = t.st || a.st; return; }
    if (t.st) a.st = t.st;

    var p = a.p;
    var tx = t.x != null ? t.x : p.x;
    var ty = levelY(a.L);                 // 固定层：车永不升降、不坐提升机
    var tz = t.zTrack ? trackZ(a.A) : (t.z != null ? t.z : p.z);
    var tf = t.fy != null ? t.fy : a.fy;
    var dx = tx - p.x, dz = tz - p.z, df = tf - a.fy;
    var d = Math.hypot(dx, dz);
    var v = a.carry ? a.vL : a.vE;
    if (d > 1e-4) {
      var s = spR(a, 'h', t, d, v, a.ramp, dt);
      p.x += dx / d * s; p.z += dz / d * s;
    }
    if (Math.abs(df) > 1e-5) {
      a.fy += Math.sign(df) * Math.min(Math.abs(df), 0.16 * dt);
      a.fork.position.y = a.fy;
    }
    if (a.carry) a.carry.position.set(p.x, p.y + a.fy + 0.02, p.z);

    if (Math.abs(tx - p.x) < 1e-3 && Math.abs(tz - p.z) < 1e-3 && Math.abs(tf - a.fy) < 1e-3) {
      p.set(tx, ty, tz); a.fy = tf; a.fork.position.y = tf;
      if (t.fn) t.fn(a);
      a.wait = t.wait || 0;
      a.q.shift();
    }
  }

  /* ---------------- 层内路径：主通道（X） + 子通道（Z） ----------------
     路径目标延迟到执行时才求值，避免生成队列时 A 值被后续路径污染。 */
  function nearestTrack(z) {
    var g = geom(), bi = 0, bd = 1e9;
    g.tracks.forEach(function (tz, i) { var d = Math.abs(tz - z); if (d < bd) { bd = d; bi = i; } });
    return bi;
  }
  function trackZ(A) {
    var g = geom();
    return g.tracks[clamp(A, 0, g.tracks.length - 1)] || 0;
  }
  function route(a, x, z, st) {
    a.q.push({ zTrack: true, st: st || '返回主通道' });
    a.q.push({ x: x, st: '主通道行驶' });
    a.q.push({ z: z, st: '子通道行驶', fn: function () { a.A = nearestTrack(z); } });
  }

  /* 选择本层空闲的层间输送线（兼顾队列负载与水平距离） */
  function pickLift(a) {
    var best = null, bd = 1e9;
    G.lifts.forEach(function (lf) {
      var b = G.buffers[lf.id] && G.buffers[lf.id][a.L];
      if (!b || b.state !== 'empty') return;
      var key = bufKey(lf, a.L);
      if (G.bufRes[key] && G.bufRes[key] !== a.id) return;
      var d = Math.abs(a.p.x - lf.x) * 0.65 + lf.reqs.length * 7 + (lf.at === a.L ? 0 : 2.5);
      if (d < bd) { bd = d; best = lf; }
    });
    return best;
  }

  /* ---------------- 任务收尾 ---------------- */
  function release(a, hard) {
    var task = a.task;
    if (task && task.cell) delete G.reserved[task.cell.id];
    if (task && task.lift) delete G.bufRes[bufKey(task.lift, a.L)];
    if (hard && task) {
      G.lifts.forEach(function (lf) {
        lf.reqs = lf.reqs.filter(function (r) { return !(r.owner === a.id && !r.detached); });
      });
      var b = task.buf;
      /* 已交给提升机待出库的货物保留，避免永久滞留 */
      if (b && b.owner === a.id && b.state !== 'out-waiting') {
        b.obj.visible = false; b.state = 'empty'; b.owner = null;
      }
    }
    a.task = null; a.st = '待机'; a.mark.visible = false; a.markCell = null;
    if (a.carry) { G.root.remove(a.carry); a.carry = null; }
    a.fy = a.sh.deckY; a.fork.position.y = a.fy;
  }

  function finish(a, kind) {
    var task = a.task;
    if (!task) return;
    /* 入/出库数在货位状态变更的同一处累加，保证账面数字与在库货位严格一致 */
    if (!task.applied) {
      log('warn', a.name + ' 货位状态未变更，本次任务不计入统计');
      release(a); return;
    }
    var label = task.label, lf = task.lift;
    if (kind === 'in') {
      log('in', a.name + ' 入库完成 → ' + label + '（经 ' + (lf ? lf.name : '层间输送线') + ' 接驳）');
    } else {
      log('out', a.name + ' 出库交接完成 → ' + label + ' · 货物已静置在第 ' + (a.L + 1) +
        ' 层层间输送线，等待 ' + (lf ? lf.name : '提升机') + ' 取走');
    }
    G.stats.cycles++;
    G.stats.duration += Math.max(0, G.t - a.guard);
    G.completions.push(G.t);
    a.done++;
    if (a.done > 0 && a.done % 6 === 0 && cfg().chg) a.needCharge = true;
    release(a);
  }

  /* ---------------- 运行前疏解：按存放优先级清空通道口与行车路线 ----------------
     播放时把在库率降到约 42%，优先隐藏 rank 大（靠近主通道）的零散货物，
     让四向车的行动路线上不放货物挡着，货架也不会被塞满。 */
  function sparseForSim() {
    /* 守恒作业模式：货物总量恒定，禁止「运行前疏解」凭空删除货物 */
    if (WAP.flow && WAP.flow.conserve) return;
    var g = geom(), c = cfg();
    if (!g) return;
    var all = g.cells.filter(function (x) { return !x.chg && x.conv < 0; });
    var used = all.filter(function (x) { return x.occ; });
    var want = Math.round(all.length * 0.42);
    if (used.length <= want) return;
    used.sort(function (p, q) {
      return WAP.core.storageRank(c, q.b, q.k) - WAP.core.storageRank(c, p.b, p.k);
    });
    var removed = 0;
    for (var i = 0; i < used.length && used.length - removed > want; i++) {
      if (WAP.rack.setCellOcc(used[i].id, false)) removed++;
    }
    if (removed) {
      log('sys', '运行仿真：按存放优先级疏解 ' + removed + ' 位零散货物，清空主通道口与四向车行车路线');
      if (WAP.ui && WAP.ui.refresh) WAP.ui.refresh();
    }
  }

  /* ---------------- 任务生成 ---------------- */
  function gen(a) {
    /* 守恒作业调度器接管「任务生成」：不再随机凭空出/入库，
       运动状态机（stepAgent / tickLifts / route）保持原样。 */
    if (WAP.flow && WAP.flow.conserve && WAP.flow.plan(a)) return;
    var c = cfg(), g = geom();
    if (!g || !G.lifts.length) { a.q.push({ wait: 1 }); return; }

    /* 充电停靠：只在本层充电位，不换层、不搭提升机 */
    if (a.needCharge) {
      a.needCharge = false;
      var cx = g.bayX[g.chgBay] || g.bayX[0];
      var cz = g.blocks[0][0] + c.dp * 0.5;
      route(a, cx, cz, '前往本层充电位');
      a.q.push(
        { fn: function () { a.charging = true; }, wait: 3.0, st: '本层充电中' },
        { fn: function () { a.charging = false; log('chg', a.name + ' 充电完成，恢复运行'); }, st: '充电结束' }
      );
      return;
    }

    var doIn = G.mode === 'in' ? true : (G.mode === 'out' ? false : Math.random() < 0.5);
    /* 只取本层、非充电、非层间输送线、未预留的真实货位 */
    var base = g.cells.filter(function (x) {
      return x.l === a.L && !x.chg && x.conv < 0 && !G.reserved[x.id];
    });
    var free = base.filter(function (x) { return !x.occ; }).length;
    var used = base.filter(function (x) { return x.occ; }).length;
    if (G.mode !== 'out' && !free && used) doIn = false;
    if (G.mode !== 'in' && !used && free) doIn = true;
    if ((doIn && !free) || (!doIn && !used)) {
      a.q.push({ wait: 1.2, st: '等待可作业货位' }); return;
    }
    var cand = base.filter(function (x) { return x.occ === !doIn; });
    /* 入库优先选最内侧 / 中间的空位；出库优先选最外侧（靠近主通道）的占用位 */
    cand.sort(function (p, q) {
      var rp = p.rank != null ? p.rank : WAP.core.storageRank(c, p.b, p.k);
      var rq = q.rank != null ? q.rank : WAP.core.storageRank(c, q.b, q.k);
      return doIn ? rp - rq : rq - rp;
    });
    var windowN = Math.max(1, Math.ceil(cand.length * 0.25));
    var cell = cand[rnd(Math.min(windowN, cand.length))];
    if (!cell) { a.q.push({ wait: 1, st: '等待可作业货位' }); return; }

    var lf = pickLift(a);
    if (!lf) { a.q.push({ wait: 1.2, st: '等待层间输送线空闲' }); return; }
    var buf = G.buffers[lf.id][a.L];

    G.reserved[cell.id] = a.id;
    G.bufRes[bufKey(lf, a.L)] = a.id;
    var kind = WAP.rack.cargoKindOf(cell);
    var label = 'L' + (cell.l + 1) + ' · B' + (cell.i + 1) + ' · Z' + (cell.b + 1) + ' · D' + (cell.k + 1);
    var task = {
      cell: cell, label: label, kind: kind, type: doIn ? 'in' : 'out',
      lift: lf, buf: buf, req: null, start: G.t, applied: false
    };
    a.task = task; a.guard = G.t;
    a.st = doIn ? '入库作业' : '出库作业';
    setMark(a, cell, doIn ? 'in' : 'out');
    log(doIn ? 'in' : 'out', a.name + '（第 ' + (a.L + 1) + ' 层）' +
      (doIn ? ' 开始入库 → ' : ' 开始出库 → ') + label + ' · 接驳 ' + lf.name);

    if (doIn) {
      /* 入库：先请提升机把货物送到层间输送线，货物静置之后四向车才出发接驳。
         车在等待期间退到主通道待命，绝不提前停到输送线上。 */
      var req = { type: 'deliver', l: a.L, kind: kind, owner: a.id, buf: buf, done: false, detached: false };
      task.req = req;
      setSkin(buf.obj, kind, 5);
      lf.reqs.push(req);
      log('sys', lf.name + ' 收到第 ' + (a.L + 1) + ' 层入库送货请求');

      a.q.push(
        { zTrack: true, st: '返回主通道待命' },
        { until: function () { return buf.state === 'in-ready' && buf.owner === a.id; },
          st: '等待货物进入层间输送线' }
      );
      route(a, lf.x, lf.convZ, '驶向层间输送线接驳');
      a.q.push(
        { fn: function () {
            /* 货物在输送线上静止，只有四向车到达才被取走 */
            buf.obj.visible = false; buf.state = 'empty'; buf.owner = null; req.done = true;
            a.carry = makeLoad(kind, 6); G.root.add(a.carry);
            log('sys', a.name + ' 已在层间输送线完成接驳取货');
          }, st: '四向车接驳取货' },
        { fy: a.sh.deckY + 0.06, wait: 0.18, st: '举升台板' }
      );
      route(a, cell.x, cell.z, '驶向目标货位');
      a.q.push(
        { fy: a.sh.deckY, wait: 0.25,
          fn: function () {
            if (a.carry) { G.root.remove(a.carry); a.carry = null; }
            task.applied = WAP.rack.setCellOcc(cell.id, true);
            if (task.applied) { G.stats.inb++; task.counted = 'in'; }
            finish(a, 'in');
          }, st: '落板存货' },
        { zTrack: true, wait: 0.2, st: '返回主通道' }
      );
    } else {
      /* 出库：货位 → 当层四向车 → 层间输送线（静置） → 提升机上升取走 */
      route(a, cell.x, cell.z, '驶向目标货位');
      a.q.push(
        { fy: a.sh.deckY + 0.06, wait: 0.22,
          fn: function () {
            task.applied = WAP.rack.setCellOcc(cell.id, false);
            if (task.applied) { G.stats.outb++; task.counted = 'out'; }
            a.carry = makeLoad(kind, 7); G.root.add(a.carry);
          }, st: '举升取货' },
        { zTrack: true, wait: 0.15, st: '载货返回主通道' },
        { fy: a.sh.deckY }
      );
      route(a, lf.x, lf.convZ, '驶向层间输送线');
      var rq = { type: 'collect', l: a.L, kind: kind, owner: a.id, buf: buf, done: false, detached: true };
      task.req = rq;
      a.q.push(
        { fn: function () {
            if (a.carry) { G.root.remove(a.carry); a.carry = null; }
            setSkin(buf.obj, kind, 8); buf.kind = kind;
            buf.obj.visible = true; buf.state = 'out-waiting'; buf.owner = null;
          }, st: '货物静置在层间输送线' },
        { fn: function () {
            lf.reqs.push(rq);
            log('sys', '货物已在第 ' + (a.L + 1) + ' 层层间输送线静置，等待 ' + lf.name + ' 上升取走');
          }, st: '请求提升机取货' },
        { fn: function () { finish(a, 'out'); }, wait: 0.25, st: '出库交接完成' }
      );
    }
  }

  /* ---------------- 提升机状态机 ----------------
     载货上升 → 可见水平转运到层间输送线（货物随即静止）→ 空载回底；
     空载上升 → 可见水平转运把输送线上的货物拉进提升机 → 载货回底出库。 */
  function beginTransfer(lf, kind, fromZ, toZ, onDone) {
    var holder = lf.transfer;
    setSkin(holder, kind, 9);
    holder.position.set(lf.x, lf.y + 0.06, fromZ);
    holder.visible = true;
    lf.tr = {
      fromZ: fromZ, toZ: toZ, t: 0,
      dur: Math.max(0.5, Math.abs(toZ - fromZ) / (1.15 * cfg().liftRate / 45)),
      done: onDone
    };
  }
  function tickTransfer(lf, dt) {
    if (!lf.tr) return false;
    var tr = lf.tr;
    tr.t += dt;
    var u = Math.min(1, tr.t / tr.dur);
    lf.transfer.position.set(lf.x, lf.y + 0.06, tr.fromZ + (tr.toZ - tr.fromZ) * u);
    if (u >= 1) {
      lf.transfer.visible = false;
      lf.tr = null;
      if (tr.done) tr.done();
    }
    return true;
  }

  function tickLifts(dt) {
    var c = cfg();
    var speed = 1.8 * c.liftRate / 45;
    G.lifts.forEach(function (lf) {
      var ref = lf.ref, r = lf.reqs[0];
      if (!r) {
        /* 请求被超时清理时，取消转运、卸掉台上货物并平滑回底，避免幽灵货物；
           立即复位 phase，保证下一帧新请求可以从任意高度正常起步。 */
        if (lf.tr) { lf.tr = null; lf.transfer.visible = false; }
        if (lf.has) { lf.has = false; lf.unit.visible = false; }
        lf.phase = 'idle';
        if (lf.y > ref.y0 + 0.001) {
          lf.y -= Math.min(lf.y - ref.y0, speed * dt);
        } else { lf.y = ref.y0; lf.at = -1; }
        ref.mesh.position.y = lf.y;
        return;
      }
      /* 转运过程中载货台停在本层，不上升也不下降 */
      if (tickTransfer(lf, dt)) { ref.mesh.position.y = lf.y; return; }

      var targetY = cellY(r.l) - 0.06;         // 载货台面与层间输送线齐平
      if (lf.phase === 'idle') {
        if (r.type === 'deliver') {
          lf.kind = r.kind;
          setSkin(lf.unit, r.kind, 2);
          lf.has = true; lf.unit.visible = true; lf.phase = 'rise';
        } else {
          lf.has = false; lf.unit.visible = false; lf.phase = 'riseEmpty';
        }
      }
      if (lf.phase === 'rise' || lf.phase === 'riseEmpty') {
        lf.y += Math.sign(targetY - lf.y) * Math.min(Math.abs(targetY - lf.y), speed * dt);
        if (Math.abs(targetY - lf.y) < 0.002) {
          lf.y = targetY; lf.at = r.l;
          var buf = G.buffers[lf.id][r.l];
          if (r.type === 'deliver') {
            /* 货物从提升机台板被推出，沿 Z 移动到层间输送线，全程可见 */
            lf.unit.visible = false; lf.has = false;
            var k1 = r.kind, owner = r.owner;
            beginTransfer(lf, k1, lf.z, lf.convZ, function () {
              setSkin(buf.obj, k1, 3);
              buf.kind = k1; buf.obj.visible = true;
              buf.state = 'in-ready'; buf.owner = owner;
              r.done = true; lf.phase = 'fall';
              log('sys', lf.name + ' 已把货物送至第 ' + (r.l + 1) +
                ' 层层间输送线，货物静止等待四向车接驳');
            });
            lf.phase = 'transfer';
          } else if (buf && buf.state === 'out-waiting') {
            /* 货物从层间输送线被拉进提升机，全程可见 */
            var k2 = buf.kind || 'carton';
            buf.obj.visible = false;
            beginTransfer(lf, k2, lf.convZ, lf.z, function () {
              lf.kind = k2;
              setSkin(lf.unit, k2, 4);
              lf.has = true; lf.unit.visible = true;
              buf.state = 'empty'; buf.owner = null;
              r.done = true; lf.phase = 'fall';
              log('sys', lf.name + ' 已取走第 ' + (r.l + 1) + ' 层层间输送线上的出库货物');
            });
            lf.phase = 'transfer';
          } else {
            /* 出库货物尚未送达输送线：停在本层逐帧重试，绝不丢弃该取货请求 */
          }
        }
      } else if (lf.phase === 'fall') {
        lf.y += Math.sign(ref.y0 - lf.y) * Math.min(Math.abs(ref.y0 - lf.y), speed * dt);
        if (Math.abs(ref.y0 - lf.y) < 0.002) {
          lf.y = ref.y0;
          lf.has = false; lf.unit.visible = false; lf.at = -1;
          lf.reqs.shift(); lf.phase = 'idle';
        }
      }
      ref.mesh.position.y = lf.y;
    });
  }

  /* ---------------- 超时保护 ---------------- */
  function guard(a) {
    if (!a.task) return;
    /* 守恒作业接驳中的车由 flow 驱动，超时保护不应打断它 */
    if (WAP.flow && a.task.flow && WAP.flow.conserve) return;
    if (G.t - a.guard < 100) return;
    var task = a.task, cell = task.cell;
    if (task.applied) {
      if (task.type === 'in' && cell.occ && WAP.rack.setCellOcc(cell.id, false) && task.counted === 'in') {
        G.stats.inb--; task.counted = null;
      }
      if (task.type === 'out' && !cell.occ && WAP.rack.setCellOcc(cell.id, true) && task.counted === 'out') {
        G.stats.outb--; task.counted = null;
      }
    }
    log('warn', a.name + ' 任务超时，已自动释放并重新排队');
    release(a, true);
    a.q.length = 0; a.S = {}; a.wait = 0.6;
    a.q.push({ zTrack: true, st: '返回主通道' });
  }

  /* ---------------- 聚焦环跟随 ---------------- */
  function updateFocusMark() {
    if (!G.focusMark) return;
    if (!G.focusId) { G.focusMark.visible = false; return; }
    var a = G.devices.filter(function (x) { return x.id === G.focusId; })[0];
    var l = G.lifts.filter(function (x) { return x.id === G.focusId; })[0];
    if (a) {
      G.focusMark.position.set(a.p.x, levelY(a.L) + 0.02, a.p.z);
    } else if (l) {
      G.focusMark.position.set(l.x, cellY(0) - 0.05, l.convZ);
    } else {
      G.focusMark.visible = false; G.focusId = null; return;
    }
    G.focusMark.visible = true;
    var s = 1 + 0.07 * Math.sin(G.t * 4);
    G.focusMark.scale.set(s, s, s);
  }

  /* ---------------- 主循环 ---------------- */
  function tick(dt) {
    if (!G.ready) return;
    var d;
    if (G.stepPending) { d = 0.22; G.stepPending = false; }
    else if (G.playing) d = dt * G.speed;
    else { updateLamps(0); updateFocusMark(); return; }
    d = Math.min(d, 0.35);
    G.t += d;

    tickLifts(d);
    for (var i = 0; i < G.devices.length; i++) {
      var a = G.devices[i];
      stepAgent(a, d);
      guard(a);
    }
    updateLamps(d);
    updateFocusMark();

    G.uiAt += d;
    if (G.uiAt >= 0.2) { G.uiAt = 0; pushUI(); }
  }

  function updateLamps() {
    G.devices.forEach(function (a) {
      var want;
      if (a.charging) want = (Math.floor(G.t * 3) % 2) ? 0xff2a2a : 0x3a0606;
      else if (!G.playing || (a.wait > 0 && !a.q.length)) want = 0xf0b429;
      else want = 0x2ee66b;
      if (a.lamp.color.getHex() !== want) a.lamp.color.setHex(want);
      if (a.mark.visible) {
        var k = 0.55 + 0.35 * Math.sin(G.t * 5);
        a.mark.userData.mat.opacity = 0.10 + 0.14 * k;
        a.mark.userData.edge.opacity = 0.55 + 0.45 * k;
      }
    });
  }

  function liftText(l) {
    if (l.tr || l.phase === 'transfer') return '层间转运中';
    if (l.phase === 'rise') return '载货上升';
    if (l.phase === 'riseEmpty') return '空载上升';
    if (l.phase === 'fall') return '下降回底';
    return '待机';
  }

  function snapshot() {
    var g = geom();
    var used = g ? g.used : 0, slots = g ? g.slots : 0;
    var recent = G.completions.filter(function (t) { return G.t - t <= 60; }).length;
    return {
      playing: G.playing, speed: G.speed, mode: G.mode, clock: fmtClock(G.t),
      inb: G.stats.inb, outb: G.stats.outb, cycles: G.stats.cycles,
      avg: G.stats.cycles ? G.stats.duration / G.stats.cycles : 0,
      rate: slots ? used / slots * 100 : 0, used: used, slots: slots,
      thru: recent * 60,
      active: G.devices.filter(function (a) { return !!a.task; }).length,
      devices: G.devices.map(function (a) {
        return {
          id: a.id, code: a.code, name: a.name,
          L: a.L + 1, level: '第 ' + (a.L + 1) + ' 层', st: a.st,
          task: a.task ? a.task.label : '—', carry: !!a.carry, done: a.done
        };
      }),
      lifts: G.lifts.map(function (l) {
        return {
          id: l.id, code: l.code, name: l.name, st: liftText(l),
          level: l.at >= 0 ? '第 ' + (l.at + 1) + ' 层' : '底层待机',
          col: l.site.col + ' 子通道口', y: l.y, queue: l.reqs.length
        };
      })
    };
  }

  function pushUI() {
    if (WAP.ui && WAP.ui.simUpdate) WAP.ui.simUpdate(snapshot());
  }

  /* ---------------- 控制 ---------------- */
  function setPlaying(on) {
    if (G.playing === !!on) return;
    G.playing = !!on;
    if (G.playing) log('sys', '仿真开始 · ' + (G.mode === 'in' ? '仅入库' : G.mode === 'out' ? '仅出库' : '自动混合') + ' · ' + G.speed + '×');
    else log('sys', '仿真暂停');
    pushUI();
  }
  function play() {
    /* 首次运行先按存放优先级疏解货物，避免塞满货架、挡住四向车行车路线 */
    if (!G.sparsed) { G.sparsed = true; sparseForSim(); }
    setPlaying(true);
  }
  function pause() { setPlaying(false); }
  function toggle() { if (G.playing) pause(); else play(); }

  function stop() {
    G.playing = false; G.t = 0; G.completions = [];
    G.stats = { inb: 0, outb: 0, cycles: 0, duration: 0 };
    G.logs = []; G.seq = 0; G.sparsed = false;
    buildDevices();
    WAP.rack.applyOccupancy();
    log('sys', '仿真已复位 · 统计清零、设备回位，货位保持当前状态');
    pushUI();
  }

  function stepOnce() {
    if (G.playing) setPlaying(false);
    else if (!G.sparsed) { G.sparsed = true; sparseForSim(); }
    G.stepPending = true;
  }

  function setSpeed(v) { G.speed = clamp(Number(v) || 1, 0.25, 4); pushUI(); }
  function setMode(m) {
    G.mode = (m === 'in' || m === 'out') ? m : 'auto';
    log('sys', '作业模式切换为' + (G.mode === 'in' ? '仅入库' : G.mode === 'out' ? '仅出库' : '自动混合') + '（对后续任务生效）');
    pushUI();
  }
  function clearLogs() {
    G.logs = [];
    if (WAP.ui && WAP.ui.simLog) WAP.ui.simLog(G.logs);
  }

  /* 聚焦某台设备：直接把镜头 target 定位到设备真实世界坐标，
     并给该设备套一圈绿色聚焦环，避免「点了 A 却对准 B」。 */
  function focus(id) {
    var a = G.devices.filter(function (x) { return x.id === id; })[0];
    var l = G.lifts.filter(function (x) { return x.id === id; })[0];
    if (!a && !l) return;
    var S = WAP.scene.S, v = new T.Vector3();
    if (a) {
      a.obj.getWorldPosition(v);
      v.y += 0.30;
      S.ctrl.radius = 5.2; S.ctrl.phi = 0.86;
    } else {
      v.set(l.site.x, (cfg().y0 + geom().top) * 0.42, l.z + 1.0);
      S.modelRoot.localToWorld(v);
      S.ctrl.radius = 8.0; S.ctrl.phi = 0.90;
    }
    S.ctrl.target.copy(v);
    S.ctrl.theta = 0.78;
    WAP.scene.applyCamera();
    G.focusId = id;
    updateFocusMark();          // 暂停状态下也能立刻看到聚焦环
    log('sys', '视角已聚焦 ' + (a ? a.name : l.name) + ' · 点顶栏「适应视图」返回总览');
  }

  /* ---------------- 生命周期 ---------------- */
  function onRebuild() {
    if (!G.root) return;
    buildDevices();          // 参数变化后重新就位，不写日志
    pushUI();
  }

  function init() {
    G.root = WAP.scene.S.simRoot;
    WAP.scene.S.onTick = tick;
    G.ready = true;
    buildDevices();
    var c = cfg();
    log('sys', '仿真就绪 · 四向穿梭车 ' + G.devices.length + ' 台（每层 ' + c.perLevel +
      ' 台 · 固定层作业）· 提升机 ' + G.lifts.length + ' 台（均匀对接子通道口）');
    pushUI();
  }

  WAP.sim = {
    init: init, onRebuild: onRebuild, tick: tick,
    play: play, pause: pause, toggle: toggle, stop: stop, stepOnce: stepOnce,
    setSpeed: setSpeed, setMode: setMode, snapshot: snapshot, clearLogs: clearLogs, focus: focus,
    get playing() { return G.playing; },
    get speed() { return G.speed; },
    get mode() { return G.mode; },
    get logs() { return G.logs; },
    get devices() { return G.devices; },
    get lifts() { return G.lifts; },
    get buffers() { return G.buffers; }
  };
})(window);
