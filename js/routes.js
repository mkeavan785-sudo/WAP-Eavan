/* WAP-Eavan · routes.js  (v3)
   「输送线路线设计」——点位与实体融合、严格按设备职能流转、衔接运行仿真。

   用户规则（2026-11-11）：
   ① 起点与货物融合：选中哪个货物，仿真就接驳哪个货物；
      途经点与设备融合；终点是空白网格，意味着最终要往这个目的地运；
      三点齐备后自动计算并生成「小绿点成线」示意运输过程；路线名称可编辑。
   ② 货物绝不乱飘：货架内水平移动＝四向车接驳；上下移动＝提升机转运；
      货架外转运＝输送设备运输；没有输送线接就掉到地面并保留，不凭空消失。
   ③ 运行仿真面板「一键添加输送线」：搭一套含入库 / 出库流程的模板，
      仿真时可演示；模板只装一次，之后改了布局，仿真以后续修改的布局为准。
   ④ 只有「新建路线」才出现起点 / 途经点 / 终点按钮，且专属当前序列；
      按钮从面板拖到 3D，点位不占网格名额、以实际放置位置为准，途经点无限次。
   ⑤ Alt + 左键拖动在任何场景都只旋转视角（scene.js 全局处理）。

   约束：绝不改写 sim.js 文件；运行动画只包装 WAP.scene.S.onTick / sim 运行时钩子。 */
(function (global) {
  'use strict';
  var WAP = global.WAP = global.WAP || {};
  var T = global.THREE;
  var D = global.document;
  var $ = function (id) { return D.getElementById(id); };
  var STORE = 'wap-eavan.routes.v3';
  var STORE_OLD = 'wap-eavan.routes.v2';

  var CELL = 2.0;
  var GRAVITY = 9.8;
  var LAND_Y = 0.02;
  var CONVEY_Y = 0.86;
  var SPEED = 1.55;
  var EXIT = 0.62;
  var DOT_STEP = 0.55;
  var MAX_GROUND = 48;

  var CARRIERS = {
    none: { n: '无（货物掉落）', stub: false },
    person: { n: '人物搬运（后续设计）', stub: true },
    forklift: { n: '叉车搬运（后续设计）', stub: true }
  };

  /* 设备功能 / 动作档案：来自 world-rack.com 与公开资料（只读研究） */
  var DEVICE_PROFILES = {
    roller:    { n: '辊道机',     action: '滚筒自转 + 货物沿长轴匀速直行',       move: 'linear' },
    chain:     { n: '链条输送机', action: '链节循环平移 + 货物直行',             move: 'linear' },
    transfer:  { n: '移载机',     action: '顶升脱离原线 → 横向移载 → 落下复位', move: 'transfer' },
    destacker: { n: '拆叠盘机',   action: '升降台托举 + 拨叉伸缩 + 单片输出',    move: 'lift' },
    lift:      { n: '提升机',     action: '载货台垂直升降 → 平层停 → 水平推出',  move: 'vertical' },
    platform:  { n: '钢平台',     action: '静止承载（额外地面）',               move: 'none' },
    wall:      { n: '墙面',       action: '静止（分区边界）',                   move: 'none' }
  };
  var INNER_PROFILES = {
    shuttle:  { n: '四向穿梭车', action: '同层主通道 X / 子通道 Z 行驶 + 顶升取放', move: 'shuttle' },
    conveyor: { n: '层间输送线', action: '提升机口接驳，静置等四向车',              move: 'wait' },
    lift:     { n: '提升机',     action: '跨层垂直转运 + 平层对位',                 move: 'vertical' }
  };
  var CONVEY_TYPES = ['roller', 'chain', 'transfer', 'destacker'];

  var R = {
    ready: false, canvas: null, rc: null, v2: null,
    root: null, pathRoot: null, dotRoot: null, markerRoot: null,
    placeRoot: null, groundRoot: null, proxyRoot: null,
    unit: null, markerPicks: [], ghost: null,
    dragPoint: null, dragMarker: null,
    routes: [], draft: null, selected: null,
    run: null, playing: false, t: 0, seq: 1, stubNotified: false,
    greenDots: 0, lastSteps: [], hiddenCell: null,
    groundCargo: [], watch: {}, deviceWatch: {}, holderCount: 0, droppedCarries: 0, demo: null,
    template: false, templateDevices: [], templateRoutes: [],
    liftProxy: null, borrow: null, borrowLift: null,
    lineHidden: false, hideTerminals: false, selNode: -1, hlRoot: null,
    lastKeyMove: null
  };

  /* ---------------- 基础工具 ---------------- */
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (m) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m];
    });
  }
  function toast(msg) { if (WAP.ui && WAP.ui.toast) WAP.ui.toast(msg); }
  function modelRoot() { return WAP.scene.S.modelRoot; }
  function equipment() { return WAP.equipment; }
  function cfg() { return WAP.state.cfg; }
  function geom() { return WAP.state.geom; }
  function hud(txt, show) {
    var h = $('routeHud');
    if (!h) return;
    h.textContent = txt;
    h.classList.toggle('show', show !== false);
  }
  function hideHud() { var h = $('routeHud'); if (h) h.classList.remove('show'); }
  function stringify(o) { try { return JSON.stringify(o); } catch (e) { return '{}'; } }
  function insideRack(x, z) {
    var g = geom();
    return !!g && x > g.x0 - 0.15 && x < g.x1 + 0.15 && z > g.z0 - 0.15 && z < g.z1 + 0.15;
  }
  function levelOf(y) {
    var c = cfg();
    return clamp(Math.round((y - c.y0) / c.pitch), 0, c.levels - 1);
  }
  function levelY(l) { var c = cfg(); return c.y0 + clamp(l, 0, c.levels - 1) * c.pitch; }
  function liftSites() { return (geom() && geom().liftSites) || []; }
  function nearestLift(x, z) {
    var best = null, bd = 1e9;
    liftSites().forEach(function (s) {
      var d = Math.hypot(s.x - x, s.z - z);
      if (d < bd) { bd = d; best = s; }
    });
    return best;
  }
  function conveyorDevices() {
    var eq = equipment();
    if (!eq || !eq.devices) return [];
    return eq.devices.filter(function (d) { return CONVEY_TYPES.indexOf(d.type) >= 0; });
  }
  function nearestGroundCell(x, z, maxD) {
    var eq = equipment(), best = null, bd = 1e9;
    ((eq && eq.cells) || []).forEach(function (c) {
      if (c.kind !== 'ground') return;
      var d = Math.hypot(c.x - x, c.z - z);
      if (maxD != null && d > maxD) return;
      if (d < bd) { bd = d; best = c; }
    });
    return best;
  }

  /* ---------------- 数据模型 ----------------
     node = { role, kind, label, targetId, cargoId, cargoKind, x, y, z }
     · start：与货物融合（cargoId = 货位 id；模板货物用 TPL- 前缀的虚拟货物）
     · via  ：与设备融合（targetId = 设备 id），也可放空白网格作为路径点
     · end  ：空白网格 = 最终目的地
     点位不写入任何格子的 base / platform 槽，绝不占网格名额。 */
  function nodeLabel(n) {
    if (!n) return '—';
    return (n.label || n.kind) + ' (' + n.x.toFixed(1) + ', ' + n.y.toFixed(2) + ', ' + n.z.toFixed(1) + ')';
  }
  function roleName(role) { return role === 'start' ? '起点' : (role === 'end' ? '终点' : '途经点'); }
  function makeNode(role, pos) {
    return {
      role: role, kind: pos.kind || 'grid', label: pos.label || '',
      targetId: pos.targetId || null,
      siteId: pos.siteId || null,            // 模板塔口：显式指定提升机，避免多塔挑错
      emitterId: pos.emitterId || null,      // 发货器作为起点时保留，供发货运行器找路线
      cargoId: pos.cargoId || null, cargoKind: pos.cargoKind || null,
      cargoClass: pos.cargoClass || null,
      /* bind：点位与实体强绑定。货架改尺寸 / 设备移动后由 rebind() 重解析坐标 */
      bind: pos.bind || null,
      x: +Number(pos.x).toFixed(3), y: +Number(pos.y).toFixed(3), z: +Number(pos.z).toFixed(3)
    };
  }
  /* 生成绑定信息：设备记 id、货物记货位坐标层级、空格记格子 key + 相对偏移 */
  function makeBind(pos) {
    var g = geom(), eq = equipment();
    if ((pos.kind === 'device' || pos.kind === 'emitter') && pos.targetId) {
      var dev = eq ? eq.devices.filter(function (d) { return d.id === pos.targetId; })[0] : null;
      return { t: 'device', id: pos.targetId,
        oy: dev ? Math.min(dev.dims[1], CONVEY_Y) : CONVEY_Y,
        yAbs: dev ? dev.y + Math.min(dev.dims[1], CONVEY_Y) : CONVEY_Y,
        virtual: pos.targetId.indexOf('TPL-') === 0,
        emitter: pos.kind === 'emitter' };
    }
    if (pos.kind === 'cargo' && pos.cargoId) {
      var c = cargoCellAt(pos.cargoId);
      if (pos.cargoId.indexOf('TPL-') === 0) {
        return { t: 'virtual', id: pos.cargoId, y: pos.y, key: nearestGroundCell(pos.x, pos.z) ?
          nearestGroundCell(pos.x, pos.z).key : null, ox: 0, oz: 0 };
      }
      return { t: 'cargo', id: pos.cargoId,
        l: c ? c.l : levelOf(pos.y), i: c ? c.i : 0, b: c ? c.b : 0, k: c ? c.k : 0 };
    }
    /* 空白网格：记录格子 key（网格随货架变化后 key 仍可解析到新坐标） */
    var cell = eq ? nearestGroundCell(pos.x, pos.z) : null;
    return { t: 'grid', key: cell ? cell.key : null,
      ox: cell ? pos.x - cell.x : 0, oz: cell ? pos.z - cell.z : 0,
      /* 兜底：相对库体中心的归一化锚点 */
      nx: g ? (pos.x - (g.x0 + g.x1) / 2) : pos.x,
      nz: g ? (pos.z - (g.z0 + g.z1) / 2) : pos.z, y: pos.y };
  }
  function hasTriple(route) {
    if (!route || !route.nodes) return false;
    var s = false, v = false, e = false;
    route.nodes.forEach(function (n) {
      if (n.role === 'start') s = true;
      else if (n.role === 'end') e = true;
      else v = true;
    });
    return s && v && e;
  }
  function activeRoute() { return R.draft || routeById(R.selected); }
  function routeById(id) {
    for (var i = 0; i < R.routes.length; i++) if (R.routes[i].id === id) return R.routes[i];
    return null;
  }
  function save() {
    try {
      global.localStorage && global.localStorage.setItem(STORE, stringify({
        seq: R.seq, routes: R.routes, template: R.template,
        templateDevices: R.templateDevices, templateRoutes: R.templateRoutes
      }));
    } catch (e) { /* ignore */ }
  }
  function load() {
    R.routes = []; R.seq = 1; R.template = false;
    R.templateDevices = []; R.templateRoutes = [];
    var raw = null;
    try { raw = global.localStorage && (global.localStorage.getItem(STORE) || global.localStorage.getItem(STORE_OLD)); }
    catch (e) { raw = null; }
    try {
      if (!raw) return;
      var o = JSON.parse(raw);
      if (o && Array.isArray(o.routes)) {
        R.routes = o.routes.filter(function (r) {
          return r && r.id && Array.isArray(r.nodes) && r.nodes.length >= 2;
        }).map(function (r) {
          r.carrier = CARRIERS[r.carrier] ? r.carrier : 'none';
          r.code = r.code || ('RT-' + pad2(parseInt(String(r.id).replace(/\D/g, ''), 10) || 1));
          r.name = r.name || ('路线 ' + r.code);
          r.nodes.forEach(function (n) { if (!n.role) n.role = 'via'; });
          return r;
        });
        R.seq = Math.max(1, Number(o.seq) || 1, R.routes.length + 1);
        R.template = !!o.template;
        R.templateDevices = Array.isArray(o.templateDevices) ? o.templateDevices : [];
        R.templateRoutes = Array.isArray(o.templateRoutes) ? o.templateRoutes : [];
      }
    } catch (e) { R.routes = []; }
  }

  /* ---------------- 路径规划：严格按设备职能 ----------------
     · 货架内水平移动 → shuttle（四向车，X 主通道 → Z 子通道，轴对齐不斜飞）
     · 上下移动       → lift（提升机，塔位垂直换层）
     · 货架外         → conveyor（场景内已有输送设备）
     · 无输送线接     → drop（超出设备末端后重力落地并静止，绝不直线补间到终点） */
  function devicesOnLeg(x1, y1, z1, x2, y2, z2) {
    var out = [], dx = x2 - x1, dz = z2 - z1, len2 = dx * dx + dz * dz;
    conveyorDevices().forEach(function (d) {
      var t = len2 > 1e-6 ? clamp(((d.x - x1) * dx + (d.z - z1) * dz) / len2, 0, 1) : 0;
      var px = x1 + dx * t, pz = z1 + dz * t;
      var dist = Math.hypot(d.x - px, d.z - pz);
      if (dist < 1.7) out.push({ id: d.id, type: d.type, name: d.name, dist: dist,
        move: DEVICE_PROFILES[d.type] ? DEVICE_PROFILES[d.type].move : 'linear' });
    });
    out.sort(function (a, b) { return a.dist - b.dist; });
    return out;
  }
  function makeStep(mode, x1, y1, z1, x2, y2, z2, note, devices) {
    var dx = x2 - x1, dz = z2 - z1, d = Math.hypot(dx, dz);
    return {
      mode: mode, type: mode, note: note || '',
      fromX: x1, fromY: y1, fromZ: z1, toX: x2, toY: y2, toZ: z2,
      dirX: d > 1e-6 ? dx / d : 0, dirZ: d > 1e-6 ? dz / d : 0,
      distance: d, dy: y2 - y1,
      devices: devices || [], covered: (devices || []).length,
      exitX: x1 + (d > 1e-6 ? dx / d : 0) * EXIT,
      exitZ: z1 + (d > 1e-6 ? dz / d : 0) * EXIT
    };
  }
  function addShuttleLeg(steps, x1, y, z1, x2, z2, note) {
    /* 通道轴向硬约束：子通道（横轴 Z）只能沿 Z 走，主通道（纵轴 X）只能沿 X 走。
       因此一律拆成「Z 回主通道 → X 沿主通道 → Z 进目标子通道」三段轴对齐，
       绝不允许在子通道里平行于主通道横向平移，也绝不斜穿货架。 */
    var mainZ = nearestTrackZ(z1);
    var legs = [];
    if (Math.abs(mainZ - z1) > 0.02) legs.push([x1, z1, x1, mainZ, '子通道 Z 回主通道']);
    if (Math.abs(x2 - x1) > 0.02) legs.push([x1, mainZ, x2, mainZ, '主通道 X 行驶']);
    if (Math.abs(z2 - mainZ) > 0.02) legs.push([x2, mainZ, x2, z2, '子通道 Z 到目标位']);
    if (!legs.length) {
      steps.push(makeStep('shuttle', x1, y, z1, x2, y, z2, '四向车顶升接驳', []));
      return;
    }
    legs.forEach(function (q) {
      steps.push(makeStep('shuttle', q[0], y, q[1], q[2], y, q[3],
        note || ('四向车 · ' + q[4]), []));
    });
  }
  function addOutsideLeg(steps, x1, z1, x2, z2, note, y) {
    var y0 = y == null ? CONVEY_Y : y;   // 与提升机平层 / 输送设备顶面齐平，不产生高度跳变
    var devs = devicesOnLeg(x1, y0, z1, x2, y0, z2);
    var len = Math.hypot(x2 - x1, z2 - z1);
    if (devs.length && len > 0.02) {
      steps.push(makeStep('conveyor', x1, y0, z1, x2, y0, z2,
        note || (devs[0].name + '：' + (DEVICE_PROFILES[devs[0].type] || {}).action), devs));
      return;
    }
    /* 没有直达输送设备：货物只能超出设备末端后掉到下一个网格地面并静止 */
    if (len > 0.02) {
      var dirX = (x2 - x1) / len, dirZ = (z2 - z1) / len;
      var ex = x1 + dirX * EXIT, ez = z1 + dirZ * EXIT;
      var wantX = ex + dirX * CELL, wantZ = ez + dirZ * CELL;
      /* 落点只在「下一个网格」附近，绝不滑行到很远的终点 */
      var cell = nearestGroundCell(wantX, wantZ, CELL * 1.6);
      var st = makeStep('drop', x1, y0, z1, x2, y0, z2,
        '无直达输送设备 · 掉到下一个网格地面并静止', []);
      st.exitX = ex; st.exitZ = ez;
      st.landX = cell ? cell.x : wantX;
      st.landZ = cell ? cell.z : wantZ;
      st.landKey = cell ? cell.key : null;
      st.stopAfter = true;
      steps.push(st);
    }
  }
  function boundarySplit(a, b) {
    /* 从库内到库外：先四向车送到库体边缘，再交给外部输送设备 */
    var g = geom();
    if (!g) return null;
    var dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz);
    if (len < 1e-6) return null;
    var t = 1, edges = [
      { n: [0, 0, -1], v: g.z0 }, { n: [0, 0, 1], v: g.z1 },
      { n: [-1, 0, 0], v: g.x0 }, { n: [1, 0, 0], v: g.x1 }
    ];
    /* 求射线离开库体矩形的 t（0..1） */
    var tx0 = dx > 0 ? (g.x1 - a.x) / dx : (dx < 0 ? (g.x0 - a.x) / dx : Infinity);
    var tx1 = dx > 0 ? Infinity : (dx < 0 ? Infinity : Infinity);
    var tz0 = dz > 0 ? (g.z1 - a.z) / dz : (dz < 0 ? (g.z0 - a.z) / dz : Infinity);
    var exitT = Math.min(Math.max(0, tx0), Math.max(0, tz0), 1);
    if (!isFinite(exitT)) exitT = 0.98;
    t = clamp(exitT, 0.02, 0.98);
    return { x: a.x + dx * t, z: a.z + dz * t, y: a.y };
  }
  function planRoute(route, seq) {
    var steps = [];
    if (!route || !route.nodes || route.nodes.length < 2) return steps;
    /* 多起终点：默认用「最远分支」生成绿点路径；传入 seq 可按指定分支规划 */
    var nodes = seq || activeSeq(route), c = cfg();
    if (!nodes || nodes.length < 2) return steps;
    for (var i = 0; i < nodes.length - 1; i++) {
      var a = nodes[i], b = nodes[i + 1];
      var ay = a.y, by = b.y;
      var la = levelOf(ay), lb = levelOf(by);
      /* 只有「两个端点都在货位层高度」才属于换层，必须由提升机完成。
         终点是地面网格时不是换层：货物沿输送设备抵达后落到该地面并保留。 */
      var rackLow = c.y0 - 0.35;
      var change = (la !== lb || Math.abs(ay - by) > c.pitch * 0.55) &&
        ay >= rackLow && by >= rackLow;
      if (change) {
        /* 提升机只有「正面 / 后面」可进，侧面（X 向）不通：
           进出塔位一律是纯 Z 段。出库 = 库内四向车 → 层间输送线 →
           提升机下降到地面 → 塔口推出 → 地面输送设备；入库完全对称。 */
        /* 模板 / 点位可显式指定提升机，避免多台提升机时挑错塔位 */
        var siteId = b.siteId || a.siteId || (seq && seq.__siteId);
        var s = (siteId ? liftSites().filter(function (q) { return q.id === siteId; })[0] : null) ||
          nearestLift((a.x + b.x) / 2, (a.z + b.z) / 2);
        if (s) {
          var tx = s.x, tz = s.z, back = s.side === 'back';
          var dock = dockAnchor(s);
          var gateZ = dock ? dock.z : tz + (back ? 1.2 : -1.2);   // 塔口外侧对接格
          var convZ = s.convZ;                                     // 层间输送线静置位
          var side = back ? 'back' : 'front';
          var inA = insideRack(a.x, a.z), inB = insideRack(b.x, b.z);
          var topY = Math.max(ay, by), groundY = CONVEY_Y;
          var rackLeg = function (fromX, fromZ, toX, toZ, y, note, replace) {
            var m = steps.length;
            addShuttleLeg(steps, fromX, y, fromZ, toX, toZ, note);
            for (var q = m; q < steps.length; q++) {
              steps[q].byShuttle = true;
              if (replace) steps[q].pickupReplace = true;
            }
          };
          /* 层间输送线 / 地面接驳口 ↔ 升降台的转运段：
             设备本体完全静止，只有货物沿设备表面做短距离 Z 向平移。 */
          var handoff = function (z1, z2, y, note, onto) {
            var st = makeStep('conveyor', tx, y, z1, tx, y, z2, note, []);
            st.innerConveyor = true; st.entry = side; st.pureZ = true;
            st.siteId = s.id; st.convZ = convZ; st.towerZ = tz;
            if (onto) st.transferToLift = true; else st.transferFromLift = true;
            steps.push(st);
          };
          var boardY = inA ? topY : groundY;    // 货物上 / 下台板所在层
          var exitY = inA ? groundY : topY;
          var boardZ = inA ? convZ : gateZ;     // 货物等待上台的静置位
          var exitZ = inB ? convZ : gateZ;      // 货物离台后的静置位
          /* ① 到达塔口前的「库内侧」或「地面侧」接驳 */
          if (inA) rackLeg(a.x, a.z, tx, convZ, topY,
            '当层四向车沿主通道 X → 子通道 Z 送到层间输送线静置位', true);
          else addOutsideLeg(steps, a.x, a.z, tx, gateZ, '地面输送设备送货物至提升机口', groundY);
          /* ② 货物在静置位暂时停顿，空升降台匀速移动到这里等高平层 */
          var wait = makeStep('liftWait', tx, boardY, boardZ, tx, boardY, boardZ,
            '货物暂歇 · 等待 ' + s.id + ' 升降台匀速平层到等高', []);
          wait.siteId = s.id; wait.deckY = boardY; wait.towerZ = tz; wait.entry = side;
          steps.push(wait);
          /* ③ 货物被层间输送线 / 接驳口转运到升降台上（设备静止） */
          handoff(boardZ, tz, boardY,
            (inA ? '层间输送线' : '地面接驳口') + '把货物转运至 ' + s.id + ' 升降台（设备静止）', true);
          /* ④ 升降台带着货物匀速移动到其它楼层 / 底层接驳口 */
          var liftStep = makeStep('lift', tx, boardY, tz, tx, exitY, tz,
            '提升机 ' + s.id + ' 升降台载货匀速换层', []);
          liftStep.entry = side; liftStep.siteId = s.id; liftStep.towerZ = tz;
          steps.push(liftStep);
          /* ⑤ 货物被升降台转运走（升降台静止，货物沿设备面移动） */
          handoff(tz, exitZ, exitY,
            '货物被 ' + s.id + ' 升降台转运到' +
            (inB ? '层间输送线' : '地面接驳口') + '（设备静止）', false);
          /* ⑥ 货物离开后，升降台才继续移动（空台匀速回到底层待命） */
          var idle = makeStep('liftIdle', tx, exitY, tz, tx, exitY, tz,
            '货物已离台 · ' + s.id + ' 升降台继续匀速移动', []);
          idle.siteId = s.id; idle.towerZ = tz; idle.entry = side;
          steps.push(idle);
          /* ⑦ 离开塔口后交给四向车 / 地面输送设备 */
          if (inB) rackLeg(tx, convZ, b.x, b.z, topY, '当层四向车从层间输送线接驳', false);
          else addOutsideLeg(steps, tx, gateZ, b.x, b.z, '地面输送设备从提升机口接出', groundY);
        } else {
          if (insideRack(a.x, a.z)) addShuttleLeg(steps, a.x, ay, a.z, b.x, b.z);
          else addOutsideLeg(steps, a.x, a.z, b.x, b.z);
        }
        continue;
      }
      var inA = insideRack(a.x, a.z), inB = insideRack(b.x, b.z);
      if (inA && inB) {
        addShuttleLeg(steps, a.x, ay, a.z, b.x, b.z);
      } else if (!inA && !inB) {
        addOutsideLeg(steps, a.x, a.z, b.x, b.z);
      } else {
        var p = boundarySplit(a, b);
        if (!p) { addOutsideLeg(steps, a.x, a.z, b.x, b.z); continue; }
        if (inA) {
          addShuttleLeg(steps, a.x, ay, a.z, p.x, p.z, '四向车送货物到库体接驳口');
          addOutsideLeg(steps, p.x, p.z, b.x, b.z, '输送设备从库体接驳口接出', ay);
        } else {
          addOutsideLeg(steps, a.x, a.z, p.x, p.z, '输送设备送货物到库体接驳口', by);
          addShuttleLeg(steps, p.x, by, p.z, b.x, b.z, '四向车从库体接驳口接驳');
        }
      }
      /* drop 段之后货物已落地静止，后续段不再执行 */
      if (steps.length && steps[steps.length - 1].mode === 'drop') break;
    }
    /* 终点是空白地面网格：运到目的地后落到地面并保留（不是凭空消失） */
    var last = nodes[nodes.length - 1];
    if (last && last.role === 'end' && last.kind === 'grid' && last.y < 0.25 &&
        steps.length && steps[steps.length - 1].mode !== 'drop') {
      var prev = steps[steps.length - 1];
      var px = prev.toX, pz = prev.toZ, py = Math.max(CONVEY_Y, prev.toY);
      var cell = nearestGroundCell(px, pz, CELL * 1.6);
      var settle = makeStep('drop', px, py, pz, px, py, pz,
        '抵达目的地网格 · 落到地面并保留', []);
      settle.exitX = px; settle.exitZ = pz;
      settle.landX = cell ? cell.x : px;
      settle.landZ = cell ? cell.z : pz;
      settle.landKey = cell ? cell.key : null;
      settle.stopAfter = true;
      steps.push(settle);
    }
    return steps;
  }

  /* ---------------- 3D：绿点路径 / 点位标记 / 拖出网格 ---------------- */
  function clearGroup(gr) {
    if (!gr) return;
    while (gr.children.length) {
      var o = gr.children[0];
      gr.remove(o);
      if (o.geometry && !(o.geometry.userData && o.geometry.userData.shared)) o.geometry.dispose();
      var ms = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
      ms.forEach(function (m) { if (!(m.userData && m.userData.shared)) m.dispose(); });
    }
  }
  function addLine(gr, pts, color, dashed) {
    var geo = new T.BufferGeometry().setFromPoints(pts.map(function (p) { return new T.Vector3(p[0], p[1], p[2]); }));
    var line = new T.Line(geo, dashed
      ? new T.LineDashedMaterial({ color: color, dashSize: 0.24, gapSize: 0.18, transparent: true, opacity: 0.9, depthTest: false })
      : new T.LineBasicMaterial({ color: color, transparent: true, opacity: 0.85, depthTest: false }));
    if (dashed) line.computeLineDistances();
    line.renderOrder = 1180;
    gr.add(line);
  }
  function stepPoints(s) {
    var pts = [];
    if (s.mode === 'drop') {
      pts.push([s.fromX, Math.max(LAND_Y, s.fromY), s.fromZ]);
      pts.push([s.exitX, Math.max(LAND_Y, s.fromY), s.exitZ]);
      pts.push([s.landX, LAND_Y, s.landZ]);
    } else {
      pts.push([s.fromX, s.fromY, s.fromZ]);
      pts.push([s.toX, s.toY, s.toZ]);
    }
    return pts;
  }
  function samplePolyline(pts) {
    var out = [];
    for (var i = 0; i < pts.length - 1; i++) {
      var a = pts[i], b = pts[i + 1];
      var d = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      var n = Math.max(1, Math.floor(d / DOT_STEP));
      for (var k = 0; k < n; k++) {
        var t = k / n;
        out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
      }
    }
    var last = pts[pts.length - 1];
    if (last) out.push(last.slice());
    return out;
  }
  function drawPath() {
    clearGroup(R.pathRoot); clearGroup(R.dotRoot);
    R.greenDots = 0;
    var route = activeRoute();
    if (!route) { R.pathRoot.visible = false; R.dotRoot.visible = false; return; }
    var steps = planRoute(route);
    R.lastSteps = steps;
    var triple = hasTriple(route);
    steps.forEach(function (s) {
      var pts = stepPoints(s);
      if (s.mode === 'drop') {
        addLine(R.pathRoot, [pts[0], pts[1]], 0xf59e0b, false);
        addLine(R.pathRoot, [pts[1], pts[2]], 0xf59e0b, true);
        var ring = new T.Mesh(new T.TorusGeometry(0.40, 0.045, 6, 22),
          new T.MeshBasicMaterial({ color: 0xef6c2b, transparent: true, depthTest: false, toneMapped: false }));
        ring.rotation.x = Math.PI / 2;
        ring.position.set(s.landX, 0.05, s.landZ);
        ring.renderOrder = 1181;
        R.pathRoot.add(ring);
      } else if (s.mode === 'lift') {
        addLine(R.pathRoot, pts, 0x8b5cf6, false);
      } else if (!triple) {
        addLine(R.pathRoot, pts, 0x18b47f, false);
      }
    });
    /* 三点齐备：自动计算并生成一串「小绿点成线」示意运输过程 */
    if (triple) {
      var all = [];
      steps.forEach(function (s) { all = all.concat(samplePolyline(stepPoints(s))); });
      var geo = new T.SphereGeometry(0.085, 8, 6);
      var mat = new T.MeshBasicMaterial({ color: 0x22c55e, transparent: true, opacity: 0.96,
        depthTest: false, toneMapped: false });
      var inst = new T.InstancedMesh(geo, mat, Math.max(1, all.length));
      inst.userData.shared = false;
      var m = new T.Matrix4();
      for (var i = 0; i < all.length; i++) {
        m.makeTranslation(all[i][0], all[i][1] + 0.06, all[i][2]);
        inst.setMatrixAt(i, m);
      }
      inst.count = all.length;
      inst.instanceMatrix.needsUpdate = true;
      inst.renderOrder = 1190;
      inst.frustumCulled = false;
      R.dotRoot.add(inst);
      R.greenDots = all.length;
      if (all.length > 1) {
        addLine(R.dotRoot, all.map(function (p) { return [p[0], p[1] + 0.06, p[2]]; }), 0x22c55e, false);
      }
    }
    R.pathRoot.visible = !R.lineHidden;
    R.dotRoot.visible = triple && !R.lineHidden;
  }
  function markerColor(role) { return role === 'start' ? 0x22c55e : (role === 'end' ? 0xef4b6b : 0x38bdf8); }
  function drawMarkers() {
    clearGroup(R.markerRoot);
    R.markerPicks = [];
    var route = activeRoute();
    if (!route) { R.markerRoot.visible = false; return; }
    route.nodes.forEach(function (n, i) {
      var col = markerColor(n.role);
      var ball = new T.Mesh(new T.SphereGeometry(0.22, 14, 10),
        new T.MeshBasicMaterial({ color: col, transparent: true, depthTest: false, toneMapped: false }));
      ball.position.set(n.x, n.y + 0.22, n.z);
      ball.renderOrder = 1220;
      R.markerRoot.add(ball);
      var pole = new T.Mesh(new T.CylinderGeometry(0.025, 0.025, 0.42, 6),
        new T.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.8, depthTest: false }));
      pole.position.set(n.x, n.y + 0.21, n.z);
      pole.renderOrder = 1219;
      R.markerRoot.add(pole);
      var pr = new T.Mesh(new T.SphereGeometry(0.48, 10, 8), ghostMat());
      pr.position.set(n.x, n.y + 0.24, n.z);
      pr.renderOrder = 1210;
      pr.userData.eq = { kind: 'routeMarker', index: i };
      R.markerRoot.add(pr);
      R.markerPicks.push(pr);
      if (i === R.selNode) {
        var ring = new T.Mesh(new T.TorusGeometry(0.34, 0.035, 6, 26),
          new T.MeshBasicMaterial({ color: 0xf59e0b, transparent: true, opacity: 0.95,
            depthTest: false, toneMapped: false }));
        ring.rotation.x = Math.PI / 2;
        ring.position.set(n.x, n.y + 0.05, n.z);
        ring.renderOrder = 1222;
        R.markerRoot.add(ring);
      }
    });
    R.markerRoot.updateMatrixWorld(true);
    /* 隐藏完整线路时，起点 / 途经点 / 终点标记球也一并隐藏；
       点位数据、绑定与线路规划完全保留，功能不受影响。 */
    R.markerRoot.visible = !R.lineHidden;
    drawHighlight();
  }
  function ghostMat() {
    if (!R._ghost) {
      R._ghost = new T.MeshBasicMaterial({ transparent: true, opacity: 0, colorWrite: false, depthWrite: false, side: T.DoubleSide });
      R._ghost.userData.shared = true;
    }
    return R._ghost;
  }
  function showPointGrid(on) {
    clearGroup(R.placeRoot);
    if (!on) { R.placeRoot.visible = false; return; }
    var grid = new T.GridHelper(64, 64, 0x8b5cf6, 0xc4b5fd);
    grid.position.y = 0.015;
    grid.material.transparent = true;
    grid.material.opacity = 0.42;
    grid.material.depthTest = false;
    grid.renderOrder = 1150;
    R.placeRoot.add(grid);
    var c = cfg();
    for (var l = 0; l < c.levels; l++) {
      var y = c.y0 + l * c.pitch;
      var m = new T.LineSegments(
        new T.EdgesGeometry(new T.BoxGeometry(geom().len + 6, 0.02, geom().tot + 6)),
        new T.LineBasicMaterial({ color: 0x8b5cf6, transparent: true, opacity: 0.18, depthTest: false }));
      m.position.y = y;
      m.renderOrder = 1149;
      R.placeRoot.add(m);
    }
    R.placeRoot.visible = true;
  }

  /* ---------------- 采点：与货物 / 设备融合 ---------------- */
  function ndc(e) {
    var r = R.canvas.getBoundingClientRect();
    R.v2.set((e.clientX - r.left) / r.width * 2 - 1, -(e.clientY - r.top) / r.height * 2 + 1);
    return R.v2;
  }
  function cargoCellAt(id) {
    var cur = WAP.rack && WAP.rack.current;
    return cur && cur.cellById ? cur.cellById[id] : null;
  }
  function nearestCargoCell(x, z, l) {
    var g = geom(), best = null, bd = 1e9;
    (g ? g.cells : []).forEach(function (c) {
      if (!c.occ || c.conv >= 0 || c.chg) return;
      if (l != null && Math.abs(c.l - l) > 0.5) return;
      var d = Math.hypot(c.x - x, c.z - z);
      if (d < bd) { bd = d; best = c; }
    });
    return best;
  }
  function cargoPos(cell, fallback) {
    if (!cell) return fallback;
    return {
      kind: 'cargo', label: '货物 ' + cell.id, targetId: cell.id,
      cargoId: cell.id, cargoKind: WAP.rack.cargoKindOf(cell) || 'carton',
      x: cell.x, y: cell.y, z: cell.z
    };
  }
  function pickPosition(e) {
    var S = WAP.scene.S, eq = equipment();
    S.modelRoot.updateMatrixWorld(true);
    R.rc.setFromCamera(ndc(e), S.camera);
    /* ① 设备本体 */
    if (eq && eq.root) {
      var dh = R.rc.intersectObjects([eq.root], true);
      for (var i = 0; i < dh.length; i++) {
        var id = dh[i].object.userData && dh[i].object.userData.devId;
        if (!id) continue;
        var dev = null;
        eq.devices.forEach(function (o) { if (o.id === id) dev = o; });
        if (!dev) continue;
        return { kind: 'device', targetId: dev.id, label: dev.name,
          x: dev.x, y: dev.y + Math.min(dev.dims[1], CONVEY_Y), z: dev.z };
      }
    }
    /* ② 货架 / 货物 / 库内模型：命中货位 → 与具体货物融合 */
    var part = WAP.scene.pickPart(R.v2.clone());
    if (part && part.hit) {
      var p = part.point.clone();
      modelRoot().worldToLocal(p);
      if (part.cellId && cargoCellAt(part.cellId)) {
        return cargoPos(cargoCellAt(part.cellId), null);
      }
      var kind = (part.kind === 'cargo' || part.kind === 'cell') ? 'cargo' : 'rack';
      return { kind: kind, targetId: part.cellId || null, label: part.cellId || ('库内' + part.kind),
        x: p.x, y: Math.max(0.02, p.y), z: p.z };
    }
    /* ③ 空白网格 / 任意地面位置 */
    var plane = new T.Plane(new T.Vector3(0, 1, 0), -modelRoot().position.y);
    var hit = new T.Vector3();
    if (R.rc.ray.intersectPlane(plane, hit)) {
      var loc = modelRoot().worldToLocal(hit.clone());
      return { kind: 'grid', targetId: null, label: '空白位置',
        x: loc.x, y: 0.02, z: loc.z };
    }
    return null;
  }
  function bindStart(pos) {
    if (pos && pos.kind === 'cargo' && pos.cargoId) return pos;
    /* 发货器作为起点：从它发出的货物都沿本路线送到货架 / 终点 */
    if (pos && pos.kind === 'device' && pos.targetId) {
      var eqd = (equipment() && equipment().devices || []).filter(function (d) {
        return d.id === pos.targetId;
      })[0];
      if (eqd && eqd.type === 'emitter') {
        return { kind: 'emitter', label: eqd.name, targetId: eqd.id, emitterId: eqd.id,
          cargoId: null, cargoKind: eqd.cargoKind || 'carton',
          cargoClass: eqd.cargoClass || 'single',
          x: pos.x, y: pos.y, z: pos.z };
      }
    }
    /* 没直接点到货物：自动融合到离放置位置最近的在库货物 */
    var cell = nearestCargoCell(pos ? pos.x : 0, pos ? pos.z : geom().z0,
      pos ? levelOf(pos.y) : null);
    if (cell) {
      var q = cargoPos(cell, null);
      toast('起点已与最近的在库货物 ' + cell.id + ' 融合');
      return q;
    }
    return { kind: 'cargo', label: '模板入库货物', targetId: 'TPL-IN-01',
      cargoId: 'TPL-IN-01', cargoKind: 'carton',
      x: pos ? pos.x : 0, y: pos ? pos.y : CONVEY_Y, z: pos ? pos.z : geom().z0 - 2 };
  }
  function bindVia(pos) {
    if (pos && pos.kind === 'device' && pos.targetId) return pos;
    /* 途经点与设备融合：吸附到附近最近的输送设备 */
    var best = null, bd = 1e9;
    conveyorDevices().forEach(function (d) {
      var q = Math.hypot(d.x - pos.x, d.z - pos.z);
      if (q < bd) { bd = q; best = d; }
    });
    if (best && bd < 2.6) {
      return { kind: 'device', targetId: best.id, label: best.name,
        x: best.x, y: best.y + Math.min(best.dims[1], CONVEY_Y), z: best.z };
    }
    /* 库内提升机也允许作为途经设备 */
    var s = nearestLift(pos.x, pos.z);
    if (s && Math.hypot(s.x - pos.x, s.z - pos.z) < 2.6) {
      return { kind: 'device', targetId: s.id, label: '提升机 ' + s.id,
        x: s.x, y: levelY(0), z: s.z };
    }
    return { kind: 'grid', label: '路径点', targetId: null,
      x: pos.x, y: pos.y, z: pos.z };
  }
  function bindEnd(pos) {
    /* 终点＝空白网格，意味着最终要往这个目的地运 */
    return { kind: 'grid', label: '目的地', targetId: null,
      x: pos.x, y: pos.y, z: pos.z };
  }
  function addPoint(role, pos) {
    if (!R.draft) newDraft();
    if (!pos) return null;
    var q = role === 'start' ? bindStart(pos) : (role === 'end' ? bindEnd(pos) : bindVia(pos));
    q.bind = makeBind(q);
    var n = makeNode(role, q);
    /* 同一路线序列允许拖出多个起点 / 多个终点，绑定不同运输分支。
       仿真时按「随机优先级 + 先送最远」挑一条具体分支（见 routeVariants）。 */
    if (role === 'start') {
      var starts = R.draft.nodes.filter(function (x) { return x.role === 'start'; });
      R.draft.nodes = starts.concat([n], R.draft.nodes.filter(function (x) { return x.role !== 'start'; }));
    } else if (role === 'end') {
      R.draft.nodes.push(n);
    } else {
      var tail = R.draft.nodes.filter(function (x) { return x.role === 'end'; });
      var body = R.draft.nodes.filter(function (x) { return x.role !== 'end'; });
      R.draft.nodes = body.concat([n], tail);
    }
    R.selNode = R.draft.nodes.indexOf(n);
    drawMarkers(); drawPath(); renderPanel();
    toast('已放置' + roleName(role) + '：' + nodeLabel(n) + (hasTriple(R.draft) ? ' · 已生成绿点路径' : ''));
    hud(hasTriple(R.draft) ? '三点齐备 · 绿点路径已生成，可继续拖出多个起点 / 终点或点「完成路线」'
      : roleName(role) + ' 已放置 · 继续拖出点位');
    return n;
  }
  /* 一条路线的所有「起点 → 途经 → 终点」分支；按距离降序＝先送最远，
     避免近处先存的货物挡住后续要送到更远货位的货物。 */
  function routeVariants(r) {
    if (!r || !r.nodes || !r.nodes.length) return [];
    var starts = r.nodes.filter(function (x) { return x.role === 'start'; });
    var ends = r.nodes.filter(function (x) { return x.role === 'end'; });
    var vias = r.nodes.filter(function (x) { return x.role !== 'start' && x.role !== 'end'; });
    if (!starts.length || !ends.length) return [];
    var out = [];
    starts.forEach(function (s) {
      ends.forEach(function (e) {
        var seq = [s].concat(vias, [e]);
        var d = Math.hypot(e.x - s.x, e.z - s.z) + Math.abs(e.y - s.y) * 0.4;
        out.push({ start: s, end: e, nodes: seq, dist: d,
          startId: s.targetId || s.cargoId || s.id, endKey: e.bind && e.bind.key ? e.bind.key :
            (e.x.toFixed(2) + ',' + e.z.toFixed(2)) });
      });
    });
    out.sort(function (a, b) { return b.dist - a.dist; });
    return out;
  }
  function activeSeq(r) {
    var v = routeVariants(r);
    return v.length ? v[0].nodes : (r && r.nodes ? r.nodes : []);
  }
  /* 运行仿真 / 发货器共用的路线分支清单：按「先送最远」排序，
     每条分支带完整节点序列，可直接交给 routes.planSeq → carrier.run。
     这是仿真「依据路线行动」的唯一入口。 */
  function autoVariants() {
    var out = [];
    R.routes.forEach(function (r) {
      if (!r.nodes || r.nodes.length < 2) return;
      routeVariants(r).forEach(function (v) {
        out.push({
          routeId: r.id, code: r.code, name: r.name,
          flow: r.flow || null, template: !!r.template,
          /* 用户手工设计的输送线路线＝运行仿真第一优先级 */
          priority: r.template ? 'template' : 'designed',
          designed: !r.template,
          carrier: r.carrier || 'none',
          dist: v.dist, endKey: v.endKey,
          start: v.start, end: v.end, nodes: v.nodes
        });
      });
    });
    /* 先按「设计路线 > 模板路线」排序，同档再按先送最远 */
    out.sort(function (a, b) {
      if (a.designed !== b.designed) return a.designed ? -1 : 1;
      return b.dist - a.dist;
    });
    return out;
  }
  /* 仿真调度器 / 发货器统一取这份清单：设计路线绝对优先 */
  function priorityVariants() {
    var all = autoVariants();
    var designed = all.filter(function (v) { return v.designed; });
    return designed.length ? designed.concat(all.filter(function (v) { return !v.designed; })) : all;
  }

  /* ---------------- 序列 ---------------- */
  function newDraft() {
    R.draft = { id: 'rt' + R.seq, code: 'RT-' + pad2(R.seq), name: '', nodes: [], carrier: 'none', draft: true };
    R.draft.name = '路线 ' + R.draft.code;
    R.selected = null; R.selNode = -1;
    drawMarkers(); drawPath(); renderPanel();
    hud('新建路线 · 把「起点 / 途经点 / 终点」从面板拖到 3D 场景');
    toast('已新建路线序列，点位按钮已显示（仅属于本序列）');
    return R.draft;
  }
  function cancelDraft() {
    R.draft = null;
    showPointGrid(false);
    if (equipment() && equipment().setPickGrid) equipment().setPickGrid(false);
    drawMarkers(); drawPath(); renderPanel(); hideHud();
    toast('已取消路线草稿');
  }
  function finishDraft() {
    if (!R.draft) { toast('请先新建路线'); return false; }
    if (R.draft.nodes.length < 2) { toast('至少需要起点与终点'); return false; }
    if (!R.draft.nodes.some(function (n) { return n.role === 'start'; }) ||
        !R.draft.nodes.some(function (n) { return n.role === 'end'; })) {
      toast('请分别拖出起点与终点'); return false;
    }
    var r = R.draft;
    delete r.draft;
    R.seq++;
    R.routes.push(r);
    R.selected = r.id;
    R.draft = null;
    showPointGrid(false);
    if (equipment() && equipment().setPickGrid) equipment().setPickGrid(false);
    save(); drawMarkers(); drawPath(); renderPanel();
    hud('路线 ' + r.code + ' 已保存 · 可点「运行路线」');
    toast('路线 ' + r.code + ' 已保存（' + r.nodes.length + ' 个点位）');
    return true;
  }
  function selectRoute(id) {
    var r = routeById(id);
    if (!r) return false;
    R.selected = id;
    R.draft = null; R.selNode = -1;
    showPointGrid(false);
    if (equipment() && equipment().setPickGrid) equipment().setPickGrid(false);
    drawMarkers(); drawPath(); renderPanel();
    return true;
  }
  function removeNode(idx) {
    if (!R.draft) return;
    R.draft.nodes.splice(idx, 1);
    drawMarkers(); drawPath(); renderPanel();
  }
  function setRouteName(v) {
    var r = activeRoute();
    if (!r) return false;
    r.name = String(v || '').slice(0, 40) || ('路线 ' + r.code);
    if (!r.draft) save();
    var list = $('rtList');
    if (list) renderPanel();
    return true;
  }
  /* ---------------- 点位强绑定：参数 / 设备变化后重新解析 ----------------
     · 设备点：按 targetId 找当前设备坐标（设备移动 / 复制后自动跟随）
     · 货物点：按 l/i/b/k 层级在当前几何里找同一货位（改长宽高后自动跟随）
     · 空格点：按格子 key 在「随货架变化的新网格」里重定位
     解析后重画标记与绿点路径，planRoute 每次实时计算，线路规划随之更新。 */
  function resolveBind(n) {
    var b = n.bind;
    if (!b) return null;
    var eq = equipment(), g = geom();
    if (b.t === 'device') {
      var dev = eq ? eq.devices.filter(function (d) { return d.id === b.id; })[0] : null;
      if (dev) return { x: dev.x,
        y: b.yAbs != null ? b.yAbs : dev.y + Math.min(dev.dims[1], CONVEY_Y), z: dev.z };
      /* 提升机 id 作为途经设备：直接按最新塔位解析 */
      var site = (g.liftSites || []).filter(function (s) { return s.id === b.id; })[0];
      if (site) return { x: site.x, y: levelY(0), z: site.z };
      return null;
    }
    if (b.t === 'cargo') {
      var cur = WAP.rack && WAP.rack.current;
      var cell = cur && cur.cellById ? cur.cellById[b.id] : null;
      if (!cell && g && g.cells) {
        var l = clamp(b.l || 0, 0, cfg().levels - 1);
        var hit = g.cells.filter(function (c) {
          return c.l === l && c.i === b.i && c.b === b.b && c.k === b.k && c.conv < 0 && !c.chg;
        })[0];
        if (!hit) {
          var best = null, bd = 1e9;
          g.cells.forEach(function (c) {
            if (c.l !== l || c.conv >= 0 || c.chg) return;
            var d = (c.i - b.i) * (c.i - b.i) * 4 + (c.b - b.b) * (c.b - b.b) * 4 + (c.k - b.k) * (c.k - b.k);
            if (d < bd) { bd = d; best = c; }
          });
          hit = best;
        }
        cell = hit;
      }
      if (cell) return { x: cell.x, y: cell.y, z: cell.z };
      return null;
    }
    if (b.t === 'virtual') {
      var c0 = b.key && eq ? eq.cells.filter(function (c) { return c.key === b.key; })[0] : null;
      if (c0) return { x: c0.x + (b.ox || 0), y: b.y, z: c0.z + (b.oz || 0) };
      if (g) return { x: (g.x0 + g.x1) / 2 + b.nx, y: b.y, z: (g.z0 + g.z1) / 2 + b.nz };
      return null;
    }
    /* grid */
    var c1 = b.key && eq ? eq.cells.filter(function (c) { return c.key === b.key; })[0] : null;
    if (c1) return { x: c1.x + (b.ox || 0), y: b.y == null ? LAND_Y : b.y, z: c1.z + (b.oz || 0) };
    if (g) return { x: (g.x0 + g.x1) / 2 + (b.nx || 0), y: b.y == null ? LAND_Y : b.y,
      z: (g.z0 + g.z1) / 2 + (b.nz || 0) };
    return null;
  }
  function rebind() {
    if (!R.ready) return 0;
    var moved = 0, lost = 0;
    function walk(r) {
      if (!r || !r.nodes) return;
      r.nodes.forEach(function (n) {
        if (!n.bind) return;
        var p = resolveBind(n);
        if (!p) { lost++; return; }
        if (Math.abs(p.x - n.x) > 1e-4 || Math.abs(p.y - n.y) > 1e-4 || Math.abs(p.z - n.z) > 1e-4) {
          n.x = +p.x.toFixed(3); n.y = +p.y.toFixed(3); n.z = +p.z.toFixed(3);
          moved++;
        }
      });
    }
    R.routes.forEach(walk);
    if (R.draft) walk(R.draft);
    /* 模板路线的节点也带 bind（templateRoutesFor 生成时补齐），随后重新规划 */
    drawMarkers(); drawPath(); renderPanel();
    R.lastRebind = { moved: moved, lost: lost, at: Date.now() };
    return moved;
  }
  function attachBinds() {
    function walk(r) {
      if (!r || !r.nodes) return;
      r.nodes.forEach(function (n) { if (!n.bind) n.bind = makeBind(n); });
    }
    R.routes.forEach(walk);
    if (R.draft) walk(R.draft);
  }
  function setCarrier(v) {
    var r = activeRoute();
    if (!r || !CARRIERS[v]) return false;
    r.carrier = v;
    if (!r.draft) save();
    drawPath(); renderPanel();
    toast('搬运方式 → ' + CARRIERS[v].n + (CARRIERS[v].stub ? '（设备后续设计，暂按掉落）' : ''));
    return true;
  }

  /* ---------------- 3D 载体代理：四向车 / 提升机 ---------------- */
  function makeUnit(kind) {
    var k = kind || 'carton';
    var u = WAP.rack.makeCargoUnit(k, 7);
    u.userData.kind = 'routeCargo';
    return u;
  }
  /* 绝不凭空生成新的升降台：直接借用 sim.lifts[].ref.mesh（库内原装载货台），
     由路线逐帧驱动它的高度，并与 carrier 共用同一把设备互斥锁。 */
  function ensureProxies() {
    if (R.liftProxy) { R.proxyRoot.remove(R.liftProxy); R.liftProxy = null; }
    hideProxies();
  }
  function hideProxies() {
    if (R.liftProxy) R.liftProxy.visible = false;
  }
  function borrowRealLift(x, z, siteId) {
    if (R.borrowLift) return R.borrowLift;
    var best = null, bd = 1e9;
    ((WAP.sim && WAP.sim.lifts) || []).forEach(function (lf) {
      if (siteId && lf.id !== siteId) return;
      var d = Math.hypot(lf.x - x, lf.z - z);
      if (d < bd) { bd = d; best = lf; }
    });
    if (!best) return null;
    if (WAP.carrier && !WAP.carrier.claim('lift:' + best.id, 'route')) return null;
    R.borrowLift = { lf: best, deckY: best.ref ? best.ref.mesh.position.y : best.y };
    best.reqs = []; best.phase = 'idle'; best.has = false; best.at = -1;
    if (best.unit) best.unit.visible = false;
    if (best.transfer) best.transfer.visible = false;
    return R.borrowLift;
  }
  function liftDeckY() {
    var L = R.borrowLift;
    if (!L) return levelY(0) - 0.06;
    /* 状态量优先，避免 sim.tickLifts 每帧回落抵消匀速平层 */
    if (isFinite(L.deckY)) return L.deckY;
    return L.lf.ref ? L.lf.ref.mesh.position.y : L.lf.y;
  }
  function holdRealLiftDeck(y) {
    var L = R.borrowLift;
    if (!L || !L.lf.ref) return;
    var lf = L.lf;
    L.deckY = y;
    lf.y = y; lf.ref.mesh.position.y = y;
    lf.reqs = []; lf.at = -1; lf.has = false; lf.phase = 'idle';
    if (lf.unit) lf.unit.visible = false;
    if (lf.transfer) lf.transfer.visible = false;
  }
  function liftRelated(st) {
    return !!st && (st.mode === 'lift' || st.mode === 'liftWait' ||
      st.mode === 'liftIdle' || st.transferToLift || st.transferFromLift);
  }
  function releaseBorrowedLift() {
    var L = R.borrowLift;
    if (!L) return;
    var lf = L.lf;
    if (WAP.carrier) WAP.carrier.releaseLock('lift:' + lf.id, 'route');
    if (lf.ref) { lf.y = lf.ref.y0; lf.ref.mesh.position.y = lf.y; }
    lf.reqs = []; lf.at = -1; lf.has = false; lf.phase = 'idle';
    if (lf.unit) lf.unit.visible = false;
    if (lf.transfer) lf.transfer.visible = false;
    R.borrowLift = null;
  }
  function syncRealLift(y) {
    var L = R.borrowLift;
    if (!L || !L.lf.ref) return;
    var lf = L.lf;
    L.deckY = y - 0.06;
    lf.y = y - 0.06;
    lf.ref.mesh.position.y = lf.y;    // 覆盖 sim.tickLifts 的回落，画面用原装台板
    lf.reqs = []; lf.at = -1; lf.has = false; lf.phase = 'idle';
    if (lf.unit) lf.unit.visible = false;
    if (lf.transfer) lf.transfer.visible = false;
  }
  /* ---------------- 借用当层最近的真实四向车（不改 sim.js） ----------------
     通过暂停该车的任务队列 / wait，让 sim.stepAgent 不再驱动它；位置由路线
     逐帧写入 a.p（即 a.obj.position）。交接完成后恢复队列，车留在主通道上
     继续被仿真派活 —— 车不会消失，也不会凭空多出一台。 */
  function simAgents() { return (WAP.sim && WAP.sim.devices) || []; }
  function nearestTrackZ(z) {
    var g = geom(), best = 0, bd = 1e9;
    (g.tracks || []).forEach(function (tz) {
      var d = Math.abs(tz - z);
      if (d < bd) { bd = d; best = tz; }
    });
    return best;
  }
  function borrowShuttle(cell) {
    var agents = simAgents(), best = null, bd = 1e9;
    agents.forEach(function (a) {
      if (a.L !== cell.l || !a.p) return;
      var d = Math.hypot(a.p.x - cell.x, a.p.z - cell.z);
      if (d < bd) { bd = d; best = a; }
    });
    if (!best) return null;
    R.borrow = {
      agent: best, cell: cell,
      q0: (best.q || []).slice(), task0: best.task || null,
      wait0: best.wait || 0, guard0: best.guard || 0,
      st0: best.st || '待机', S0: best.S || {}, fy0: best.fy,
      hidden: [], dockY: levelY(cell.l),
      lastX: best.p.x, lastZ: best.p.z
    };
    best.q = []; best.task = null; best.wait = 1e9;
    best.S = {}; best.guard = 0; best.st = '路线接驳';
    return best;
  }
  function releaseShuttle() {
    var b = R.borrow;
    if (!b) return;
    var a = b.agent;
    b.hidden.forEach(function (id) {
      try { WAP.rack.setCellOcc(id, true); } catch (e) { /* ignore */ }
    });
    /* 车留在「离开层间输送线」后的主通道位置，恢复仿真调度后继续干活 */
    a.q = b.q0.slice(); a.task = b.task0; a.wait = b.wait0;
    a.st = b.st0; a.S = b.S0 || {};
    a.guard = Math.max(b.guard0 || 0, simClockSeconds());
    a.p.set(b.lastX, b.dockY, b.lastZ);
    R.borrow = null;
  }
  /* 接驳腿：主通道 X → 子通道 Z，全程轴对齐；最后一段到「层间输送线」交接，
     之后车空车驶离主通道去干别的活（不隐藏、不复位到原位）。 */
  function pickupLegs(agent, cell, handoff) {
    var tz = nearestTrackZ(cell.z), ax = agent.p.x, az = agent.p.z;
    return [
      { x: ax, z: tz, tag: '回主通道' },
      { x: cell.x, z: tz, tag: '主通道 X 行驶' },
      { x: cell.x, z: cell.z, tag: '子通道 Z 到货位', pickup: true },
      { x: cell.x, z: tz, tag: '载货返回主通道' },
      { x: handoff.x, z: tz, tag: '主通道驶向提升机口' },
      { x: handoff.x, z: handoff.z, tag: '层间输送线交接', handoff: true },
      { x: handoff.x, z: tz, tag: '空车离开层间输送线' },
      { x: handoff.x + CELL, z: tz, tag: '去执行下一项任务' }
    ];
  }
  /* 临时清障：把接驳走廊上挡路的在库货物隐藏，交接后恢复（避免穿模） */
  function hideCorridorCargo(legs, cell) {
    var b = R.borrow, g = geom(), c = cfg();
    if (!b || !g) return;
    var ids = {};
    function consider(q, ax, az, bx, bz) {
      if (q.l !== cell.l || !q.occ || q.chg || q.conv >= 0 || q.id === cell.id) return;
      var horizontal = Math.abs(bx - ax) > Math.abs(bz - az);
      var hit = horizontal
        ? (Math.abs(q.z - az) < c.dp * 0.8 && q.x > Math.min(ax, bx) - c.bayW && q.x < Math.max(ax, bx) + c.bayW)
        : (Math.abs(q.x - ax) < c.bayW * 0.8 && q.z > Math.min(az, bz) - c.dp && q.z < Math.max(az, bz) + c.dp);
      if (hit) ids[q.id] = 1;
    }
    for (var i = 0; i < legs.length; i++) {
      var p = i === 0 ? { x: b.agent.p.x, z: b.agent.p.z } : legs[i - 1];
      var ax = p.x, az = p.z, bx = legs[i].x, bz = legs[i].z;
      (g.cells || []).forEach(function (q) { consider(q, ax, az, bx, bz); });
    }
    Object.keys(ids).forEach(function (id) {
      if (WAP.rack.setCellOcc(id, false)) b.hidden.push(id);
    });
  }
  function engage(ids, on) {
    if (equipment() && equipment().setEngaged) equipment().setEngaged(ids, on);
  }
  function disengageAll() { if (equipment() && equipment().clearEngaged) equipment().clearEngaged(); }

  /* ---------------- 运行：只包装 onTick，绝不碰 sim.js ---------------- */
  function restoreHiddenCell() {
    if (R.hiddenCell) {
      try { WAP.rack.setCellOcc(R.hiddenCell, true); } catch (e) { /* ignore */ }
      R.hiddenCell = null;
    }
  }
  function play(id) {
    var r = routeById(id || R.selected);
    if (!r) { toast('请先选择一条已保存的路线'); return false; }
    stop();
    R.selected = r.id;
    var seq = activeSeq(r);                // 多起终点时运行「最远分支」
    var steps = planRoute(r, seq);
    if (!steps.length) { toast('路线没有可用路段'); return false; }
    var n0 = seq[0] || r.nodes[0];
    var kind = n0.cargoKind || 'carton';
    /* 起点与货物融合：静态货物在四向车到达前一直留在货位上（绝不临时消失），
       车到位那一刻才在同一坐标换成移动单元，并顶升到车板。 */
    var cell = null, pendingHideId = null;
    if (n0.cargoId && n0.cargoId.indexOf('TPL-') !== 0) {
      cell = cargoCellAt(n0.cargoId);
      if (cell && cell.occ) pendingHideId = n0.cargoId;
    }
    R.pendingHideId = pendingHideId;
    R.loadCell = cell;
    R.unit = makeUnit(kind);
    R.root.add(R.unit);
    ensureProxies();

    /* 库内水平接驳一律借用「当层最近的真实四向车」：
       车从它当前所在的主通道开过来，沿 X 主通道 → Z 子通道到货位取货，
       送到层间输送线后不消失，空车驶离去执行下一项任务。 */
    var borrowed = cell ? borrowShuttle(cell) : null;
    var exec = steps;
    var pickup = null;
    if (borrowed) {
      /* 与规划用同一台提升机：从第一个塔位 Z 段里取塔位坐标 */
      var gate = steps.filter(function (q) { return q.innerConveyor && q.siteId; })[0];
      var s = gate ? liftSites().filter(function (q) { return q.id === gate.siteId; })[0]
        : (nearestLift(cell.x, cell.z) || liftSites()[0]);
      var handoff = s ? { x: s.x, y: cell.y, z: s.convZ }
        : (gate ? { x: gate.fromX, y: cell.y, z: gate.convZ } : { x: cell.x, y: cell.y, z: cell.z });
      var legs = pickupLegs(borrowed, cell, handoff);
      hideCorridorCargo(legs, cell);
      exec = steps.filter(function (q) { return !q.pickupReplace; });
      pickup = { legs: legs, i: 0, handoff: handoff, loaded: false, unloaded: false,
        loading: false, leaveI: -1 };
      R.unit.visible = false;      // 车还没到：静态货物仍在货架上，移动单元先不显示
    } else if (R.pendingHideId && WAP.rack.setCellOcc(R.pendingHideId, false)) {
      /* 没有借到车：同一帧内一 hide 一 show，坐标重合，不会有空档 */
      R.hiddenCell = R.pendingHideId;
      R.pendingHideId = null;
      R.unit.visible = true;
    }
    /* 通道轴向规整：层间输送线同排是子通道，四向车不得在此横向 X 行驶；
       所有 shuttle 段统一拆成「Z 回主通道 → X 主通道 → Z 进子通道」。 */
    if (WAP.carrier && WAP.carrier.normalizeSteps) {
      exec = WAP.carrier.normalizeSteps(exec);
    }

    R.run = {
      routeId: r.id, steps: exec, idx: 0,
      phase: pickup ? 'pickup' : 'move', pickup: pickup,
      borrowed: !!borrowed,
      x: n0.x, y: Math.max(n0.y, LAND_Y), z: n0.z,
      vy: 0, elapsed: 0, landedKey: null, landed: false, finished: false,
      activeDevices: [], action: pickup ? 'shuttle-pickup' : exec[0].mode
    };
    R.unit.position.set(R.run.x, R.run.y, R.run.z);
    R.playing = true;
    R.stubNotified = false;
    renderPanel();
    hud(pickup
      ? '运行 ' + r.name + ' · 当层四向车正沿通道来接驳这件货物'
      : '运行 ' + r.name + ' · ' + (exec[0].note || exec[0].mode));
    return true;
  }
  /* ---------------- 真实四向车接驳阶段 ----------------
     车沿主通道 X → 子通道 Z 到货位取货 → 送到层间输送线交接 →
     空车驶离去干别的活（不隐藏、不复位），全程不新造四向车。 */
  function simClockSeconds() {
    try {
      var s = WAP.sim.snapshot().clock.split(':');
      return (+s[0]) * 60 + (+s[1]);
    } catch (e) { return 0; }
  }
  function alignFirstStep(exec, h) {
    if (!exec.length) return;
    var q = exec[0];
    q.fromX = h.x; q.fromZ = h.z; q.fromY = h.y;
    var dx = q.toX - q.fromX, dz = q.toZ - q.fromZ;
    var d = Math.hypot(dx, dz);
    q.distance = d;
    q.dirX = d > 1e-6 ? dx / d : 0;
    q.dirZ = d > 1e-6 ? dz / d : 0;
  }
  function finishPickup(run, p) {
    var h = p.handoff;
    releaseShuttle();
    run.borrowed = false;
    run.pickup = null;
    run.phase = 'move';
    run.idx = 0;
    run.x = h.x; run.y = h.y; run.z = h.z;
    if (R.unit) {
      R.unit.visible = true;
      R.unit.position.set(h.x, h.y, h.z);
    }
    alignFirstStep(run.steps, h);
    /* 接驳点改写首段后可能变成斜段：重新做一次通道轴向规整 */
    if (WAP.carrier && WAP.carrier.normalizeSteps) {
      run.steps = WAP.carrier.normalizeSteps(run.steps);
    }
    run.idx = 0;
    run.action = run.steps.length ? run.steps[0].mode : 'done';
    if (!run.steps.length) { finishRun('货物已由当层四向车送达层间输送线并保留'); return; }
    hud('四向车已把货物送到层间输送线 · 空车驶离去执行下一项任务');
  }
  /* 顶升取货：车停在货位不动，货物从「原静态货物所在的同一坐标」缓缓抬到车板，
     期间静态货物刚被取下、移动单元已在原地显示，画面上不会先消失再突然出现。 */
  function tickLoad(dt) {
    var run = R.run, p = run.pickup, b = R.borrow;
    if (!p || !b || !R.unit) { run.phase = 'pickup'; return; }
    p.loadT = (p.loadT || 0) + dt;
    var u = clamp(p.loadT / 0.34, 0, 1);
    run.y = (p.loadY0 == null ? run.y : p.loadY0) + (p.loadTarget - (p.loadY0 == null ? run.y : p.loadY0)) * u;
    R.unit.position.set(run.x, run.y, run.z);
    if (u >= 1) { p.loading = false; run.phase = 'pickup'; }
  }
  function tickPickup(dt) {
    var run = R.run, p = run.pickup, b = R.borrow;
    if (!p || !b) { run.phase = 'move'; return; }
    if (p.loading) { tickLoad(dt); return; }
    var a = b.agent, leg = p.legs[p.i];
    if (!leg) { finishPickup(run, p); return; }
    /* 通道轴向：一次只动一根轴，Z 段沿子通道、X 段沿主通道 */
    var dx = leg.x - a.p.x, dz = leg.z - a.p.z, step = SPEED * dt;
    if (Math.abs(dx) > 0.002) {
      if (Math.abs(dx) > step) a.p.x += Math.sign(dx) * step; else a.p.x = leg.x;
    } else if (Math.abs(dz) > 0.002) {
      if (Math.abs(dz) > step) a.p.z += Math.sign(dz) * step; else a.p.z = leg.z;
    }
    var arrived = Math.abs(leg.x - a.p.x) < 0.002 && Math.abs(leg.z - a.p.z) < 0.002;
    if (arrived) {
      a.p.x = leg.x; a.p.z = leg.z;
      p.i++;
      if (leg.pickup) {
        p.loaded = true;
        /* 车到货位这一刻才取下静态货物，并在完全相同的位置显示移动单元 */
        if (R.pendingHideId && WAP.rack.setCellOcc(R.pendingHideId, false)) {
          R.hiddenCell = R.pendingHideId;
        }
        R.pendingHideId = null;
        if (R.unit) {
          R.unit.visible = true;
          run.x = a.p.x; run.z = a.p.z;
          var cell = R.loadCell;
          run.y = cell ? cell.y : run.y;
          R.unit.position.set(run.x, run.y, run.z);
        }
        p.loadY0 = run.y; p.loadTarget = b.dockY + 0.30;
        p.loadT = 0; p.loading = true;
        run.phase = 'load';
        hud('当层四向车已到货位 · 顶升接驳这件货物');
        return;
      }
      if (leg.handoff) {
        p.unloaded = true;
        if (R.unit) R.unit.position.set(p.handoff.x, p.handoff.y, p.handoff.z);
      }
    }
    a.p.y = b.dockY;                 // 四向车固守单层，绝不跨层
    b.lastX = a.p.x; b.lastZ = a.p.z;
    if (p.loaded && !p.unloaded && R.unit) {
      R.unit.position.set(a.p.x, b.dockY + 0.30, a.p.z);
      run.x = a.p.x; run.y = b.dockY + 0.30; run.z = a.p.z;
    }
    if (p.i >= p.legs.length) finishPickup(run, p);
  }
  function stop() {
    if (R.borrow) releaseShuttle();
    releaseBorrowedLift();
    restoreHiddenCell();
    R.pendingHideId = null; R.loadCell = null;
    disengageAll();
    R.playing = false;
    R.run = null;
    if (R.unit) { R.root.remove(R.unit); R.unit = null; }
    hideProxies();
    /* 仅复位本路线送出的货物；仿真落地货物不清除（货物不凭空消失） */
    R.groundCargo = R.groundCargo.filter(function (q) {
      if (q.from !== 'route') return true;
      if (q.unit && q.unit.parent) q.unit.parent.remove(q.unit);
      return false;
    });
    renderPanel();
  }
  function finishRun(msg) {
    if (R.borrow) releaseShuttle();      // 车不消失，留在主通道继续干活
    releaseBorrowedLift();
    hideProxies();
    disengageAll();
    /* 返程循环开启：货物沿原路线反向返回起点（复用同一件货物，不凭空生成） */
    if (WAP.flow && WAP.flow.loop && R.run && R.run.steps && R.run.steps.length &&
        !R.run.returning) {
      var back = R.run.steps.slice().reverse().map(function (s) {
        var q = {};
        Object.keys(s).forEach(function (k) { q[k] = s[k]; });
        var fx = q.fromX, fz = q.fromZ, fy = q.fromY;
        q.fromX = q.toX; q.fromZ = q.toZ; q.fromY = q.toY;
        q.toX = fx; q.toZ = fz; q.toY = fy;
        q.dirX = -q.dirX; q.dirZ = -q.dirZ;
        q.note = '返程 · ' + (q.note || '');
        return q;
      });
      R.run.steps = R.run.steps.concat(back);
      R.run.returning = true;
      R.run.landed = false;
      R.run.idx++;
      R.run.phase = 'move';
      R.run.vy = 0;
      if (R.unit) R.unit.visible = true;
      R.playing = true;
      renderPanel();
      hud('返程循环已开启 · 货物沿原路线返回起点');
      return;
    }
    R.playing = false;
    if (R.unit) {
      /* 送达后货物留在目的地，绝不凭空消失 */
      R.groundRoot.add(R.unit);
      R.groundCargo.push({ unit: R.unit, from: 'route', phase: 'rest',
        x: R.run.x, y: R.run.y, z: R.run.z });
      R.unit = null;
    }
    if (R.run) R.run.finished = true;
    hud(msg || '路线完成 · 货物已按设备职能送达目的地并保留');
    renderPanel();
    toast(msg || '货物已送达终点并保留');
  }
  function nextStep(run) {
    engage(run.activeDevices, false);
    run.activeDevices = [];
    run.idx++; run.elapsed = 0; run.phase = 'move';
    /* 连续 shuttle 段共用同一台真实车；离开库内段后才把车交还仿真 */
    var next = run.steps[run.idx];
    if (R.borrow && (!next || next.mode !== 'shuttle')) releaseShuttle();
    if (R.borrowLift && !liftRelated(next)) releaseBorrowedLift();
    if (run.idx >= run.steps.length) { finishRun(); return; }
    run.action = run.steps[run.idx].mode;
    hideProxies();
  }
  /* 没有任何承载体接手时，把当前段改成「掉落」：超出设备末端后重力落地，
     绝不允许货物在空中直线补间 / 凭空飞行到终点。 */
  function convertToDrop(st, run) {
    st.mode = 'drop'; st.type = 'drop';
    st.note = '无承载体接驳 · 超出末端后掉到下一个网格地面并静止';
    var dirX = st.dirX || 0, dirZ = st.dirZ || 0;
    st.exitX = run.x + dirX * EXIT;
    st.exitZ = run.z + dirZ * EXIT;
    var wantX = st.exitX + dirX * CELL, wantZ = st.exitZ + dirZ * CELL;
    var cell = nearestGroundCell(wantX, wantZ, CELL * 1.6);
    st.landX = cell ? cell.x : wantX;
    st.landZ = cell ? cell.z : wantZ;
    st.landKey = cell ? cell.key : null;
    st.stopAfter = true;
    run.phase = 'move';
    hideProxies();
  }
  function tick(dt) {
    if (!R.playing || !R.run || !R.unit) return;
    var run = R.run;
    if (run.phase === 'pickup') { tickPickup(dt); return; }
    if (run.phase === 'load') { tickLoad(dt); return; }
    var st = run.steps[run.idx];
    if (!st) { finishRun(); return; }
    run.elapsed += dt;
    var step = SPEED * dt;

    if (st.mode === 'conveyor') {
      /* 货架外：只能由场景内已有输送设备运输（层间输送线是库内固定设备）。
         没有承载体绝不允许货物自己平移：超出末端后重力落地静止。 */
      if (!st.devices.length && !st.innerConveyor) { convertToDrop(st, run); return; }
      if (!run.activeDevices.length) {
        run.activeDevices = st.devices.map(function (q) { return q.id; });
        engage(run.activeDevices, true);
      }
      hideProxies();
      if (st.transferToLift || st.transferFromLift) {
        /* 层间输送线 ↔ 升降台接驳：两台设备都保持静止，只有货物沿设备面平移 */
        if (!R.borrowLift) borrowRealLift(st.fromX, st.towerZ != null ? st.towerZ : st.fromZ, st.siteId);
        if (R.borrowLift) holdRealLiftDeck(st.fromY - 0.06);
      } else releaseBorrowedLift();
      var left = Math.hypot(st.toX - run.x, st.toZ - run.z);
      if (left > step) { run.x += st.dirX * step; run.z += st.dirZ * step; }
      else { run.x = st.toX; run.z = st.toZ; }
      run.y = Math.max(LAND_Y, st.fromY);
      if (left <= step) { R.unit.position.set(run.x, run.y, run.z); nextStep(run); return; }
      R.unit.position.set(run.x, run.y, run.z);
      return;
    }
    if (st.mode === 'liftWait') {
      /* 货物在静置位暂停；空升降台匀速平层到等高 */
      if (!borrowRealLift(st.fromX, st.towerZ != null ? st.towerZ : st.fromZ, st.siteId)) return;
      hideProxies();
      var want = (st.deckY != null ? st.deckY : st.fromY) - 0.06;
      var cur = liftDeckY(), dd = want - cur, vw = 1.25 * dt;
      if (Math.abs(dd) > vw) cur += Math.sign(dd) * vw; else cur = want;
      holdRealLiftDeck(cur);
      R.unit.position.set(run.x, run.y, run.z);
      if (cur === want) nextStep(run);
      return;
    }
    if (st.mode === 'liftIdle') {
      /* 货物被转运走之后，空台才继续匀速移动回到底层待命 */
      if (!borrowRealLift(st.fromX, st.towerZ != null ? st.towerZ : st.fromZ, st.siteId)) return;
      hideProxies();
      var lf = R.borrowLift.lf, base = lf.ref ? lf.ref.y0 : liftDeckY();
      var now = liftDeckY(), back = base - now, vi = 1.25 * dt;
      if (Math.abs(back) > vi) now += Math.sign(back) * vi; else now = base;
      holdRealLiftDeck(now);
      R.unit.position.set(run.x, run.y, run.z);
      if (now === base) { releaseBorrowedLift(); nextStep(run); }
      return;
    }
    if (st.mode === 'shuttle') {
      /* 货架内水平移动一定是四向车接驳：借用当层最近的真实车，
         绝不新建车、也不让货物自己飘。 */
      if (!R.borrow) {
        borrowShuttle({ l: levelOf(st.fromY), x: st.fromX, z: st.fromZ });
        if (R.borrow) R.borrow.agent.p.set(run.x, levelOf(st.fromY) >= 0 ? R.borrow.dockY : run.y, run.z);
      }
      /* 没有真实四向车就原地等车，货物绝不自行平移 / 凭空飞行 */
      if (!R.borrow) return;
      releaseBorrowedLift(); hideProxies();
      /* 通道轴向硬约束：X 段只动 x，Z 段只动 z；斜段拆成 L 形 */
      var diagonal = Math.abs(st.dirX) > 0.02 && Math.abs(st.dirZ) > 0.02;
      var useX = diagonal ? Math.abs(st.toX - run.x) > 0.002 : Math.abs(st.dirX) >= Math.abs(st.dirZ);
      if (!diagonal) { if (useX) run.z = st.fromZ; else run.x = st.fromX; }
      var delta = useX ? (st.toX - run.x) : (st.toZ - run.z);
      var ad = Math.abs(delta), move = Math.min(ad, step);
      if (ad > 1e-6) { if (useX) run.x += Math.sign(delta) * move; else run.z += Math.sign(delta) * move; }
      run.y = st.fromY;
      var a = R.borrow.agent;
      a.p.set(run.x, R.borrow.dockY, run.z);
      a.st = useX ? '主通道 X 载货行驶' : '子通道 Z 载货行驶';
      R.borrow.lastX = run.x; R.borrow.lastZ = run.z;
      R.unit.position.set(run.x, R.borrow.dockY + 0.30, run.z);
      var rest = Math.abs(st.toX - run.x) + Math.abs(st.toZ - run.z);
      if (rest <= step || (diagonal && rest < 0.003)) {
        run.x = st.toX; run.z = st.toZ; nextStep(run);
      }
      return;
    }
    if (st.mode === 'lift') {
      /* 上下移动：必须用 sim.lifts[].ref.mesh 原装载货台，绝不新建代理 */
      if (!borrowRealLift(st.fromX, st.towerZ != null ? st.towerZ : st.fromZ, st.siteId)) return;   // 提升机被占用 → 等待
      hideProxies();
      var dy = st.toY - run.y;
      var vs = 1.25 * dt;
      if (Math.abs(dy) > vs) run.y += Math.sign(dy) * vs;
      else run.y = st.toY;
      run.x = st.fromX; run.z = st.fromZ;
      syncRealLift(run.y);
      R.unit.position.set(run.x, run.y, run.z);
      if (run.y === st.toY) nextStep(run);
      return;
    }
    /* drop：超出设备末端 → 重力掉到下一个网格地面 → 静止保留 */
    if (run.phase === 'move') {
      hideProxies();
      var ex = st.exitX - run.x, ez = st.exitZ - run.z;
      var l2 = Math.hypot(ex, ez);
      run.y = Math.max(LAND_Y, st.fromY);
      if (l2 > step) { run.x += ex / l2 * step; run.z += ez / l2 * step; }
      else {
        run.x = st.exitX; run.z = st.exitZ;
        run.phase = 'fall'; run.vy = 0;
        var gravityT = Math.sqrt(2 * Math.max(0.1, run.y - LAND_Y) / GRAVITY);
        var hdist = Math.hypot(st.landX - run.x, st.landZ - run.z);
        run.fallT = Math.max(gravityT, hdist / SPEED, 0.14);
        /* 落体只带有限水平速度，不会「飞」到很远的终点 */
        run.vx = (st.landX - run.x) / run.fallT;
        run.vz = (st.landZ - run.z) / run.fallT;
        run.vyScale = Math.pow(gravityT / run.fallT, 2);
      }
    } else if (run.phase === 'fall') {
      run.x += run.vx * dt; run.z += run.vz * dt;
      run.vy -= GRAVITY * (run.vyScale || 1) * dt;
      run.y += run.vy * dt;
      if (run.y <= LAND_Y) {
        run.y = LAND_Y; run.x = st.landX; run.z = st.landZ;
        run.phase = 'landed'; run.landed = true; run.landedKey = st.landKey;
        R.unit.position.set(run.x, run.y, run.z);
        var settle = (st.note || '').indexOf('抵达目的地') >= 0;
        finishRun(settle
          ? '已运到终点网格 ' + (st.landKey || '') + ' · 货物落地并保留'
          : '货物掉到地面 ' + (st.landKey || '') + ' · 已静止保留（无输送线接）');
        return;
      }
    }
    R.unit.position.set(run.x, run.y, run.z);
  }

  /* ---------------- 与运行仿真衔接：出库货物绝不凭空消失 ----------------
     sim.js 里出库货物随提升机回到塔底后会把台板货物隐藏。这里在外部观察
     提升机状态，在那一刻把货物接管过来：有输送线接 → 沿设备转运后留在末端；
     没有输送线接 → 掉到塔前地面并静止保留。全程不改 sim.js 一行。 */
  function clearSimGroundCargo() {
    if (R.borrow) releaseShuttle();      // 仿真复位/重建时归还借用的车与临时隐藏的货物
    releaseBorrowedLift();
    R.groundCargo = R.groundCargo.filter(function (q) {
      if (q.from !== 'sim') return true;
      if (q.unit && q.unit.parent) q.unit.parent.remove(q.unit);
      return false;
    });
    R.watch = {};
    R.deviceWatch = {}; R.holderCount = 0;
    if (R.demo && R.demo.unit && R.demo.unit.parent) R.demo.unit.parent.remove(R.demo.unit);
    R.demo = null;
  }
  /* 仿真任务超时时四向车上的货物会被直接移除，这里接管并让它落地保留 */
  function onDroppedCarry(pos, kind) {
    if (!pos || R.groundCargo.length >= MAX_GROUND) return;
    var unit = makeUnit(kind || 'carton');
    unit.position.set(pos.x, Math.max(CONVEY_Y, pos.y), pos.z);
    R.groundRoot.add(unit);
    var cell = nearestGroundCell(pos.x, pos.z, CELL * 2);
    R.groundCargo.push({
      unit: unit, from: 'sim', kind: kind || 'carton',
      x: pos.x, y: Math.max(CONVEY_Y, pos.y), z: pos.z, vy: 0,
      phase: 'fall', chain: [], ci: 0, engaged: false,
      landX: cell ? cell.x : pos.x, landZ: cell ? cell.z : pos.z
    });
    R.droppedCarries++;
  }
  function onOutboundArrival(lf) {
    if (R.groundCargo.length >= MAX_GROUND) return;   // 上限保护：已落地货物不删除
    var g = geom(), eq = equipment();
    var site = lf.site || {}, back = site.side === 'back';
    var mouthZ = lf.z + (back ? 1.05 : -1.05);
    var chain = conveyorDevices().filter(function (d) {
      return Math.hypot(d.x - lf.x, d.z - mouthZ) < 3.6;
    }).sort(function (a, b) {
      return Math.hypot(a.x - lf.x, a.z - mouthZ) - Math.hypot(b.x - lf.x, b.z - mouthZ);
    }).slice(0, 6);
    var unit = makeUnit(lf.kind || 'carton');
    /* 接管时货物在「原装提升机台板被隐藏的那个位置」续上，绝不从别处凭空冒出 */
    var startY = Math.max(LAND_Y, (lf.y || 0) + 0.06);
    unit.position.set(lf.x, startY, lf.z);
    R.groundRoot.add(unit);
    var rec = {
      unit: unit, from: 'sim', kind: lf.kind || 'carton',
      x: lf.x, y: startY, z: lf.z, vy: 0,
      phase: chain.length ? 'convey' : 'fall',
      chain: chain, ci: 0, engaged: false,
      landX: lf.x, landZ: mouthZ
    };
    if (!chain.length) {
      var cell = nearestGroundCell(lf.x + (back ? 0 : 0.7), mouthZ + (back ? 0.7 : -0.7));
      rec.landX = cell ? cell.x : lf.x;
      rec.landZ = cell ? cell.z : mouthZ;
    }
    R.groundCargo.push(rec);
  }
  function watchSim() {
    var lifts = (WAP.sim && WAP.sim.lifts) || [];
    var devs = (WAP.sim && WAP.sim.devices) || [];
    var ids = {}, holders = 0;
    /* 统计所有「货物承载体」：层间输送线缓存位 / 提升机台板 / 转运货物 */
    var bufs = (WAP.sim && WAP.sim.buffers) || {};
    Object.keys(bufs).forEach(function (k) {
      Object.keys(bufs[k] || {}).forEach(function (l) {
        if (bufs[k][l] && bufs[k][l].obj && bufs[k][l].obj.visible) holders++;
      });
    });
    lifts.forEach(function (lf) {
      if (lf.unit && lf.unit.visible) holders++;
      if (lf.transfer && lf.transfer.visible) holders++;
    });
    /* 货架静态货位也是承载体：入库落板时 used+1，避免误判成「货物消失」 */
    if (geom()) holders += geom().used;
    /* 车上货物消失且没有新的承载体接手 → 让它掉到地面保留，而不是凭空不见 */
    devs.forEach(function (a) {
      var prev = R.deviceWatch[a.id] || {};
      var carry = a.carry || null;
      /* 接驳期间会临时隐藏走廊货物，used 下降属正常，不作为「消失」判定 */
      var carrierBusy = !!(WAP.carrier && WAP.carrier.snapshot().active);
      if (!R.borrow && !carrierBusy && prev.carry && !carry && holders <= (R.holderCount || 0)) {
        onDroppedCarry(prev.pos, prev.kind);
      }
      var pos = null;
      if (carry) {
        var v = new T.Vector3();
        carry.getWorldPosition(v);
        modelRoot().worldToLocal(v);
        pos = { x: v.x, y: v.y, z: v.z };
      }
      R.deviceWatch[a.id] = { carry: !!carry, pos: pos, kind: (a.task && a.task.kind) || prev.kind || 'carton' };
    });
    R.holderCount = holders;
    lifts.forEach(function (lf) {
      ids[lf.id] = 1;
      var prev = R.watch[lf.id];
      if (!prev) {
        R.watch[lf.id] = { has: lf.has, phase: lf.phase, visible: lf.unit.visible };
        return;
      }
      /* 载货下降回底 → 台板货物被隐藏：接管这件货物 */
      var arrived = prev.has && (prev.visible || prev.phase === 'fall') &&
        !lf.has && !lf.unit.visible && lf.phase === 'idle';
      if (arrived) onOutboundArrival(lf);
      prev.has = lf.has; prev.phase = lf.phase; prev.visible = lf.unit.visible;
    });
    Object.keys(R.watch).forEach(function (k) { if (!ids[k]) delete R.watch[k]; });
  }
  function tickGroundCargo(dt) {
    R.groundCargo.forEach(function (q) {
      if (!q.unit || q.phase === 'rest') return;
      if (q.phase === 'convey') {
        if (!q.engaged) {
          engage(q.chain.map(function (d) { return d.id; }), true);
          q.engaged = true;
        }
        var d = q.chain[q.ci];
        if (!d) { q.phase = 'rest'; return; }
        var dx = d.x - q.x, dz = d.z - q.z, len = Math.hypot(dx, dz);
        var step = SPEED * 0.7 * dt;
        q.y = CONVEY_Y;
        if (len > step) { q.x += dx / len * step; q.z += dz / len * step; }
        else {
          q.x = d.x; q.z = d.z; q.ci++;
          if (q.ci >= q.chain.length) q.phase = 'rest';   // 留在线上，不消失
        }
      } else if (q.phase === 'fall') {
        q.vy -= GRAVITY * dt;
        q.y += q.vy * dt;
        var hd = Math.hypot(q.landX - q.x, q.landZ - q.z);
        if (hd > 1e-4) {
          var t = Math.max(0.1, Math.sqrt(2 * Math.max(0.1, CONVEY_Y - LAND_Y) / GRAVITY));
          q.x += (q.landX - q.x) / Math.max(dt, t) * dt;
          q.z += (q.landZ - q.z) / Math.max(dt, t) * dt;
        }
        if (q.y <= LAND_Y) {
          q.y = LAND_Y; q.x = q.landX; q.z = q.landZ; q.phase = 'rest';
        }
      }
      q.unit.position.set(q.x, q.y, q.z);
      q.unit.visible = true;
    });
  }
  /* ---------------- 线路识别 ----------------
     按用户设计的线路理解场景：提升机正面口 →（对准口子的第 1 台辊道/链条）
     → 直线若干台辊道 → 转弯处 1 台移载机 → 转向后再衔接辊道机。
     顺序由「从对接格出发的贪心最近邻」得到，不写死坐标，
     因此之后用户改动布局，识别结果自动以修改后的线路为准。 */
  function lineDevices() {
    return conveyorDevices().filter(function (d) {
      return CONVEY_TYPES.indexOf(d.type) >= 0;
    });
  }
  function dockAnchor(site) {
    var s = site || liftSites()[0];
    if (!s) return null;
    var eq = equipment();
    var c = eq && eq.dockCellFor ? eq.dockCellFor(s.id, s.side) : null;
    return { site: s, x: c ? c.x : s.x,
      z: c ? c.z : s.z + (s.side === 'back' ? 2.8 : -2.8) };
  }
  /* 从提升机正面/背面对接格出发，沿「相邻格」逐台串起输送线。
     距离阈值收紧到一格（CELL*1.35），避免跨过空格抓到别的支线设备；
     同距离时优先直行，遇到转弯位（移载机）才允许改向，保证 L 形线路顺序正确。 */
  function orderLine() {
    var anchor = dockAnchor();
    if (!anchor) return [];
    var left = lineDevices(), chain = [], cur = { x: anchor.x, z: anchor.z };
    var vx = 0, vz = 0;
    while (left.length && chain.length < 12) {
      var best = null, bi = -1, bs = 1e9;
      left.forEach(function (d, i) {
        var dx = d.x - cur.x, dz = d.z - cur.z;
        var dist = Math.hypot(dx, dz);
        /* dist≈0 是「正好摆在对接格上的第 1 台辊道机」，必须收进链路 */
        if (dist > CELL * 1.35) return;
        /* 转弯设备（移载机 / 拆叠盘机）允许改向；其余优先沿当前方向直行 */
        var turn = d.type === 'transfer' || d.type === 'destacker';
        var penalty = 0;
        if (!turn && (vx || vz) && dist > 0.1) {
          var cos = (dx * vx + dz * vz) / (dist * Math.hypot(vx, vz));
          if (cos < 0.62) penalty = CELL * 0.9;
        }
        var score = dist + penalty;
        if (score < bs) { bs = score; best = d; bi = i; }
      });
      if (!best) break;
      chain.push(best);
      left.splice(bi, 1);
      vx = best.x - cur.x; vz = best.z - cur.z;
      cur = best;
    }
    return chain;
  }
  function turnIndexes(chain) {
    var anchor = dockAnchor(), out = [];
    for (var i = 1; i < chain.length; i++) {
      var a = i === 1 ? anchor : chain[i - 2], b = chain[i - 1], c = chain[i];
      var v1x = b.x - a.x, v1z = b.z - a.z, v2x = c.x - b.x, v2z = c.z - b.z;
      var n1 = Math.hypot(v1x, v1z), n2 = Math.hypot(v2x, v2z);
      if (n1 < 0.1 || n2 < 0.1) continue;
      var cos = (v1x * v2x + v1z * v2z) / (n1 * n2);
      if (cos < 0.62) out.push(i);             // 方向明显改变 = 转弯位
    }
    return out;
  }
  function templateChain() {
    return orderLine().slice(0, 12).map(function (d) {
      return { id: d.id, x: d.x, z: d.z, name: d.name, type: d.type };
    });
  }
  function tickDemo(dt) {
    /* 货物一律由 WAP.carrier 按「路线 + 真实承载体」驱动。
       这里不再生成任何自行平移的演示货物（设备动作由 equipment.equipTick
       在仿真播放时统一驱动），避免货物脱离四向车 / 提升机 / 输送设备。 */
    if (R.demo && R.demo.unit && R.demo.unit.parent) R.demo.unit.parent.remove(R.demo.unit);
    R.demo = null;
  }

  /* ---------------- 模板输送线（一键添加） ---------------- */
  function nearestFreeCell(x, z, used) {
    var eq = equipment(), best = null, bd = 1e9;
    ((eq && eq.cells) || []).forEach(function (c) {
      if (c.kind !== 'ground' || used[c.key] || c.base || c.platform) return;
      var d = Math.hypot(c.x - x, c.z - z);
      if (d < bd) { bd = d; best = c; }
    });
    return best;
  }
  /* 模板搭建后把镜头带到库前输送线，方便直接看到入 / 出库设备链 */
  function frameTemplate() {
    var g = geom(), s = liftSites()[0], S = WAP.scene.S;
    if (!g || !s) return;
    S.ctrl.target.set(s.x, Math.max(2.2, g.top * 0.32), g.z0 - 2.6);
    S.ctrl.radius = clamp(Math.max(g.len, g.tot + 12) * 1.34, 20, 70);
    S.ctrl.theta = Math.PI - 0.78;
    S.ctrl.phi = 1.02;
    WAP.scene.applyCamera();
  }
  /* 按用户设计的 L 形线路自动搭建（仅在场景里还没有输送线时）：
     提升机正面口精确对接格 → 3 台辊道机直线运输 → 转弯位 1 台移载机
     → 转向后 1 台辊道机。第一台必须落在 dock 格，保证与塔位口严格对齐；
     只有转弯位才放换向设备（移载机），直线段一律辊道机。
     拆叠盘机是空托盘工位，不参与转向，不在本线路里。 */
  function buildDesignedLine(eq, s) {
    var g = geom(), back = s.side === 'back', dir = back ? 1 : -1;
    var dock = eq.dockCellFor ? eq.dockCellFor(s.id, s.side) : null;
    var made = [], used = {};
    /* 同一列的格子 key 只改行号 j，X 严格一致 → 辊道机整条直线不歪。
       精确对接格的 key 是 D|提升机|侧，直接用它自带的 col/row 索引。 */
    var ci = dock && isFinite(dock.col) ? dock.col : null;
    var cj = dock && isFinite(dock.row) ? dock.row : null;
    var m = (ci == null || cj == null) && dock
      ? /^G\|(-?\d+)\|(-?\d+)$/.exec(dock.key) : null;
    if (m) { ci = +m[1]; cj = +m[2]; }
    function colKey(i, j) { return 'G|' + i + '|' + j; }
    function put(type, key, yaw, x, z) {
      var cell = key ? eq.cells.filter(function (c) { return c.key === key; })[0]
        : nearestFreeCell(x, z, used);
      if (!cell || used[cell.key]) return;
      used[cell.key] = 1;
      var d = eq.add(type, { key: cell.key, quiet: true, template: true, yaw: yaw });
      if (d) made.push(d);
    }
    var x0 = dock ? dock.x : s.x, z0 = dock ? dock.z : s.z + dir * 2.8;
    var hasCol = ci != null && cj != null;
    put('roller', dock ? dock.key : null, 90, x0, z0);
    for (var k = 1; k <= 2; k++) {
      var zk = z0 + dir * CELL * k;
      put('roller', hasCol ? colKey(ci, cj + dir * k) : null, 90, x0, zk);
    }
    /* 转弯位 = 移载机（顶升移载做 90° 换向）。
       拆叠盘机只做空托盘堆叠/拆分，不参与转向，不应放在转弯位。 */
    var turnZ = z0 + dir * CELL * 3;
    put('transfer', hasCol ? colKey(ci, cj + dir * 3) : null, 0, x0, turnZ);
    put('roller', hasCol ? colKey(ci - 1, cj + dir * 3) : null, 0, x0 - CELL, turnZ);
    return made;
  }
  /* 模板路线＝用户设计的那条 L 形线路，节点顺序就是货物流转顺序：
     出库  货架货物 → 提升机正面口 → 第 1 台对准塔口的辊道 → 直线 3 台
           → 转弯位移载机 → 转向后辊道 → 出库目的地
     入库  完全反向：线尾 → 转向后辊道 → 转弯位 → 直线 3 台 → 第 1 台辊道
           → 提升机正面口 → 提升机换层 → 当层四向车 → 货位
     关键点：塔口途经点放在「对接格」(gate) 而不是塔心，且高度是输送面
     CONVEY_Y。这样 planRoute 的换层分支会生成
     「层间输送线 Z → 提升机垂直 → 塔口 Z 推出」，随后各对节点才沿设备链
     逐台走 conveyor，不会在塔口处误判无设备而提前 drop 中断整条路线。 */
  function templateRoutesFor(chain, s) {
    var g = geom(), eq = equipment();
    var dock = eq && eq.dockCellFor ? eq.dockCellFor(s.id, s.side) : null;
    var gateX = dock ? dock.x : s.x;
    var gateZ = dock ? dock.z : s.z + (s.side === 'back' ? 2.8 : -2.8);
    var back = s.side === 'back';

    function gateNode() {
      var n = makeNode('via', { kind: 'grid', label: '提升机 ' + s.id + (back ? '背面' : '正面') + '口',
        siteId: s.id, x: gateX, y: CONVEY_Y, z: gateZ });
      /* 绑定到对接格：改货架尺寸 / 移动塔位后自动跟随 */
      n.bind = { t: 'virtual', key: dock ? dock.key : null, ox: 0, oz: 0, y: CONVEY_Y,
        nx: gateX - (g.x0 + g.x1) / 2, nz: gateZ - (g.z0 + g.z1) / 2 };
      return n;
    }
    function viaNode(d) {
      var n = makeNode('via', { kind: 'device', label: d.name, targetId: d.id,
        x: d.x, y: CONVEY_Y, z: d.z });
      n.bind = { t: 'device', id: d.id, yAbs: CONVEY_Y };
      return n;
    }
    var chainNodes = chain.map(viaNode);

    /* 出库源：优先非底层在库货物，才能演示「四向车 → 提升机换层」 */
    var occ = null, occAny = null;
    (g.cells || []).forEach(function (c) {
      if (!c.occ || c.conv >= 0 || c.chg) return;
      if (!occAny) occAny = c;
      if (!occ && c.l >= 1) occ = c;
    });
    var src = occ || occAny;
    /* 入库目的地：非底层的空闲深货位，避免与出库源撞车 */
    var dst = null;
    (g.cells || []).forEach(function (c) {
      if (c.occ || c.conv >= 0 || c.chg || c.l < 1 || c.id === (src && src.id)) return;
      if (!dst || (c.rank || 0) < (dst.rank || 0)) dst = c;
    });
    if (!dst) {
      (g.cells || []).some(function (c) {
        if (c.occ || c.conv >= 0 || c.chg || c.id === (src && src.id)) return false;
        dst = c; return true;
      });
    }

    /* 出库终点：沿线路最后一段方向再前进一格的地面网格 */
    var last = chain[chain.length - 1], prev = chain[chain.length - 2] || last;
    var vx = last.x - prev.x, vz = last.z - prev.z;
    var vn = Math.hypot(vx, vz) || 1;
    var wantX = last.x + vx / vn * CELL, wantZ = last.z + vz / vn * CELL;
    var outCell = nearestGroundCell(wantX, wantZ, CELL * 2.2) || { x: wantX, z: wantZ, key: null };

    var outStart = makeNode('start', {
      kind: 'cargo', label: src ? '货物 ' + src.id : '出库货物',
      cargoId: src ? src.id : null,
      cargoKind: src ? (WAP.rack.cargoKindOf(src) || 'carton') : 'carton',
      x: src ? src.x : s.x, y: src ? src.y : levelY(1),
      z: src ? src.z : g.z0 + 1
    });
    var outEnd = makeNode('end', { kind: 'grid', label: '出库目的地',
      x: outCell.x, y: LAND_Y, z: outCell.z });
    var outNodes = [outStart, gateNode()].concat(chainNodes, [outEnd]);

    /* 入库起点＝线尾（供发货器替换），终点＝货架深货位 */
    var inStart = makeNode('start', { kind: 'cargo', label: '入库货物（线尾）',
      targetId: 'TPL-IN-01', cargoId: 'TPL-IN-01', cargoKind: 'carton',
      x: last.x, y: CONVEY_Y, z: last.z });
    var inEnd = makeNode('end', { kind: 'grid', label: '入库货位',
      cargoId: dst ? dst.id : null,
      x: dst ? dst.x : s.x, y: dst ? dst.y : levelY(1),
      z: dst ? dst.z : g.z0 + 1 });
    if (dst) inEnd.bind = { t: 'cargo', id: dst.id, l: dst.l, i: dst.i, b: dst.b, k: dst.k };
    var inNodes = [inStart].concat(chainNodes.slice().reverse(), [gateNode(), inEnd]);

    return [
      { id: 'rtpl-in', code: 'TP-IN', name: '模板 · 入库流程', carrier: 'none',
        template: true, flow: 'in', nodes: inNodes },
      { id: 'rtpl-out', code: 'TP-OUT', name: '模板 · 出库流程', carrier: 'none',
        template: true, flow: 'out', nodes: outNodes }
    ];
  }
  function installTemplate() {
    var eq = equipment(), g = geom();
    if (!eq || !g) return false;
    var s = liftSites()[0];
    if (!s) { toast('请先确保库体至少有一台提升机'); return false; }
    var existing = lineDevices(), made = [];
    /* 用户已在场景里搭好线路 → 直接识别为模板，绝不新增 / 删除 / 改动其它设备 */
    var captured = existing.length >= 3;
    if (!captured) made = buildDesignedLine(eq, s);
    var chain = orderLine();
    if (chain.length < 2) { toast('可用网格不足，无法识别输送线路'); return false; }
    var routes = templateRoutesFor(chain, s);
    R.templateDevices = chain.map(function (d) { return d.id; });
    R.routes = R.routes.filter(function (r) { return !r.template; });
    routes.forEach(function (r) { R.routes.push(r); });
    R.templateRoutes = routes.map(function (r) { return r.id; });
    R.template = true;
    R.selected = routes[0].id;
    R.seq = Math.max(R.seq, R.routes.length + 1);
    attachBinds();              // 模板点位同样与设备/货物强绑定
    save(); drawMarkers(); drawPath(); renderPanel(); updateTemplateState();
    if (made.length) frameTemplate();
    toast(captured
      ? '已把你场景内的 ' + chain.length + ' 台设备识别为输送线模板（其它设备未改动）· 入库 / 出库 2 条流程'
      : '已按你的设计搭好 ' + made.length + ' 台设备并设为模板 · 入库 / 出库 2 条流程');
    return true;
  }
  function updateTemplateState() {
    var el = $('simTemplateState');
    if (!el) return;
    var eq = equipment();
    var n = eq ? eq.devices.filter(function (d) { return CONVEY_TYPES.indexOf(d.type) >= 0; }).length : 0;
    var chain = templateChain();
    el.textContent = R.template
      ? ('已识别线路 ' + chain.length + ' 台设备 · 场景共 ' + n + ' 台输送设备 · 仿真按当前布局演示')
      : '尚未识别输送线路模板';
    var btn = $('simTemplate');
    if (btn) btn.textContent = R.template ? '✓ 输送线路模板已生效' : '＋ 一键添加 / 识别输送线';
  }

  /* ---------------- 面板 ---------------- */
  function renderPanel() {
    var cnt = $('rtCount');
    if (cnt) cnt.textContent = R.routes.length + ' 条路线';
    var tools = $('rtPointTools');
    if (tools) tools.hidden = !R.draft;
    var nameInput = $('rtName');
    if (nameInput) {
      var ar = activeRoute();
      nameInput.disabled = !ar;
      nameInput.value = ar ? ar.name : '';
    }
    var hint = $('rtHint');
    if (hint) {
      hint.innerHTML = R.draft
        ? '当前序列 <b>' + esc(R.draft.code) + '</b> 专属点位：<b>起点融合货物</b> / <b>途经点融合设备</b> / <b>终点＝目的地网格</b>；三点齐备自动生成绿点路径'
        : (R.playing ? '路线运行中 · 货物严格按四向车 / 提升机 / 输送设备职能流转'
          : (R.selected ? '已选中其它路线序列 · 点位按钮隐藏；路线名称可在上方修改'
            : '点「新建路线」后才会出现起点 / 途经点 / 终点按钮'));
    }
    var nc = $('rtNodeCount');
    if (nc) nc.textContent = (R.draft ? R.draft.nodes.length : (activeRoute() ? activeRoute().nodes.length : 0)) + ' 个点位';
    var dots = $('rtDots');
    if (dots) dots.textContent = hasTriple(activeRoute()) ? (R.greenDots + ' 个绿点') : '待三点齐备';
    var nodes = $('rtNodes');
    if (nodes) {
      var r = R.draft || routeById(R.selected);
      if (!r || !r.nodes.length) nodes.innerHTML = '<p class="rt-empty">还没有点位。新建路线后把按钮拖到 3D 场景。</p>';
      else nodes.innerHTML = r.nodes.map(function (n, i) {
        var extra = n.role === 'start' && n.cargoId ? ' · 接驳 ' + esc(n.cargoId) :
          (n.role === 'via' && n.targetId ? ' · 融合 ' + esc(n.targetId) : '');
        return '<div class="rt-node rt-' + n.role + (R.selNode === i ? ' is-sel' : '') + '" data-sel="' + i + '" title="点选后可用方向键微调">' +
          '<i></i><div><b>' + roleName(n.role) + ' · ' + esc(nodeLabel(n)) + esc(extra) + '</b>' +
          '<span>' + esc(n.kind) + ' · 不占网格名额 · 方向键可微调</span></div>' +
          (R.selNode === i ? '<span class="rt-node-sel">已选中</span>' : '') +
          (r.draft ? '<button type="button" class="rt-node-del" data-node="' + i + '" title="移除">✕</button>' : '') + '</div>';
      }).join('');
    }
    var carrier = $('rtCarrier');
    if (carrier) carrier.value = (R.draft || routeById(R.selected) || { carrier: 'none' }).carrier || 'none';
    var list = $('rtList');
    if (list) {
      if (!R.routes.length) list.innerHTML = '<p class="rt-empty">尚未保存路线。</p>';
      else list.innerHTML = R.routes.map(function (r) {
        var segs = planRoute(r);
        var modes = {};
        segs.forEach(function (s) { modes[s.mode] = (modes[s.mode] || 0) + 1; });
        return '<div class="rt-item' + (R.selected === r.id ? ' is-on' : '') + '" data-route="' + esc(r.id) + '">' +
          '<i></i><div><b>' + esc(r.name) + (r.template ? ' <em class="rt-tpl">模板</em>' : '') + '</b><span>' +
          r.nodes.length + ' 点位 · ' + (modes.shuttle || 0) + ' 段四向车 / ' +
          (modes.lift || 0) + ' 段提升机 / ' + (modes.conveyor || 0) + ' 段输送 / ' +
          (modes.drop || 0) + ' 段掉落</span></div>' +
          '<button type="button" class="rt-play" data-play="' + esc(r.id) + '" title="运行">▶</button>' +
          '<button type="button" class="rt-del" data-rtdel="' + esc(r.id) + '" title="删除">✕</button></div>';
      }).join('');
    }
    var st = $('rtRunState');
    if (st) {
      if (R.run && R.run.landed) {
        st.textContent = '已落地静止并保留 · ' + (R.run.landedKey || '') + ' · y=' + R.run.y.toFixed(2) + ' m';
        st.className = 'rt-run-state is-drop';
      } else if (R.run && R.run.finished) {
        st.textContent = '已送达目的地 · 货物保留在终点';
        st.className = 'rt-run-state is-ok';
      } else if (R.playing && R.run) {
        var s = R.run.steps[R.run.idx];
        st.textContent = '运行中 · 第 ' + (R.run.idx + 1) + '/' + R.run.steps.length + ' 段 · ' +
          (s ? (s.mode + '：' + (s.note || '')) : '');
        st.className = 'rt-run-state is-run';
      } else { st.textContent = '待机'; st.className = 'rt-run-state'; }
    }
    var playBtn = $('rtPlay'); if (playBtn) playBtn.disabled = !R.routes.length || R.playing;
    var stopBtn = $('rtStop'); if (stopBtn) stopBtn.disabled = !R.playing && !R.run;
    var doneBtn = $('rtDone'); if (doneBtn) doneBtn.disabled = !R.draft || R.draft.nodes.length < 2;
    /* 循环 / 显隐开关（隐藏只改显示，不影响运行功能） */
    var loopOn = !!(WAP.flow && WAP.flow.loop);
    var lp = $('rtLoop');
    if (lp) {
      lp.textContent = loopOn ? '↻ 循环：开' : '↻ 循环：关';
      lp.classList.toggle('is-on', loopOn);
      lp.setAttribute('aria-pressed', String(loopOn));
    }
    var hl = $('rtHideLine');
    if (hl) {
      hl.textContent = R.lineHidden ? '▦ 路线隐藏' : '▦ 路线显示';
      hl.classList.toggle('is-on', !R.lineHidden);
      hl.setAttribute('aria-pressed', String(!R.lineHidden));
    }
    var ht = $('rtHideTerminals');
    if (ht) {
      ht.textContent = R.hideTerminals ? '◉ 收发器隐藏' : '◉ 收发器显示';
      ht.classList.toggle('is-on', !R.hideTerminals);
      ht.setAttribute('aria-pressed', String(!R.hideTerminals));
    }
    var ks = $('rtKeyState');
    if (ks) {
      var ar = activeNodeRoute();
      ks.textContent = (R.selNode >= 0 && ar && ar.nodes[R.selNode])
        ? '已选中 ' + roleName(ar.nodes[R.selNode].role) + ' · ←→ 沿 X / ↑↓ 沿 Z / Shift+↑↓ 换层' +
          (R.hlBound && R.hlBound.bound ? ' · 绑定格已异色高亮' : '')
        : '未选中点位 · 点上方点位条目或 3D 标记球即可用方向键微调';
      ks.className = 'rt-run-state' + (R.selNode >= 0 ? ' is-run' : '');
    }
    var profiles = $('rtProfiles');
    if (profiles && !profiles.dataset.filled) {
      profiles.dataset.filled = '1';
      var all = Object.keys(DEVICE_PROFILES).filter(function (k) { return DEVICE_PROFILES[k].move !== 'none'; })
        .map(function (k) { return '<div class="rt-prof"><b>' + esc(DEVICE_PROFILES[k].n) + '</b><span>' + esc(DEVICE_PROFILES[k].action) + '</span></div>'; });
      Object.keys(INNER_PROFILES).forEach(function (k) {
        all.push('<div class="rt-prof"><b>' + esc(INNER_PROFILES[k].n) + '</b><span>' + esc(INNER_PROFILES[k].action) + '</span></div>');
      });
      profiles.innerHTML = '<div class="rt-prof-t">设备动作档案（运行仿真时启用）</div>' + all.join('');
    }
    updateTemplateState();
  }

  /* ---------------- 从面板拖出点位 ---------------- */
  function ghostEl() {
    if (!R.ghost) {
      R.ghost = D.createElement('div');
      R.ghost.className = 'rt-ghost';
      D.body.appendChild(R.ghost);
    }
    return R.ghost;
  }
  function showGhost(role, x, y) {
    var g = ghostEl();
    g.textContent = roleName(role) + ' · 拖到 3D 场景放置';
    g.className = 'rt-ghost show rt-ghost-' + role;
    g.style.left = x + 14 + 'px';
    g.style.top = y + 14 + 'px';
  }
  function moveGhost(x, y) {
    if (R.ghost) { R.ghost.style.left = x + 14 + 'px'; R.ghost.style.top = y + 14 + 'px'; }
  }
  function hideGhost() { if (R.ghost) R.ghost.classList.remove('show'); }
  function onDown(e) {
    if (!R.ready || e.button !== 0 || e.altKey) return false;
    /* 线路隐藏时点位标记不可见，禁止抓取看不见的球 */
    if (R.lineHidden) return false;
    R.rc.setFromCamera(ndc(e), WAP.scene.S.camera);
    var hits = R.rc.intersectObjects(R.markerPicks, false);
    if (hits.length && hits[0].object.userData.eq) {
      R.dragMarker = { index: hits[0].object.userData.eq.index, id: e.pointerId };
      R.selNode = R.dragMarker.index;
      drawMarkers(); renderPanel();
      showPointGrid(true);
      if (equipment() && equipment().setPickGrid) equipment().setPickGrid(true);
      hud('拖动点位调整位置 · 松手生效');
      return true;
    }
    return false;
  }
  function onMove(e) {
    if (R.dragPoint) { moveGhost(e.clientX, e.clientY); return false; }
    if (R.dragMarker) return false;
    return false;
  }
  function bindPointDrag() {
    var host = $('rtPointTools');
    if (host) host.addEventListener('pointerdown', function (e) {
      var b = e.target.closest ? e.target.closest('[data-pt]') : null;
      if (!b || !R.draft || e.altKey) return;
      R.dragPoint = { role: b.dataset.pt, id: e.pointerId };
      showGhost(R.dragPoint.role, e.clientX, e.clientY);
      showPointGrid(true);
      if (equipment() && equipment().setPickGrid) equipment().setPickGrid(true);
      hud('把「' + roleName(R.dragPoint.role) + '」放到货物 / 设备 / 空白网格上');
      e.preventDefault();
    });
    global.addEventListener('pointermove', function (e) {
      if (R.dragPoint) moveGhost(e.clientX, e.clientY);
      if (R.dragMarker) {
        var pos = pickPosition(e);
        var route = activeRoute();
        if (pos && route && route.nodes[R.dragMarker.index]) {
          var old = route.nodes[R.dragMarker.index];
          var q = old.role === 'start' ? bindStart(pos) : (old.role === 'end' ? bindEnd(pos) : bindVia(pos));
          route.nodes[R.dragMarker.index] = makeNode(old.role, q);
          drawMarkers(); drawPath();
        }
      }
    });
    global.addEventListener('pointerup', function (e) {
      if (R.dragPoint) {
        var role = R.dragPoint.role;
        var wasAlt = !!e.altKey;
        R.dragPoint = null;
        hideGhost(); showPointGrid(false);
        if (equipment() && equipment().setPickGrid) equipment().setPickGrid(false);
        var r = R.canvas.getBoundingClientRect();
        if (!wasAlt && e.clientX >= r.left && e.clientX <= r.right &&
            e.clientY >= r.top && e.clientY <= r.bottom) {
          var pos = pickPosition(e);
          if (pos) addPoint(role, pos);
          else toast('这里无法放置点位');
        } else if (wasAlt) hud('Alt 拖动已用于旋转视角，点位未放置');
        return;
      }
      if (R.dragMarker) {
        R.dragMarker = null;
        showPointGrid(false);
        if (equipment() && equipment().setPickGrid) equipment().setPickGrid(false);
        if (!R.draft) save();
        renderPanel();
        toast('点位位置已更新');
      }
    });
    global.addEventListener('pointercancel', function () {
      R.dragPoint = null; R.dragMarker = null;
      hideGhost(); showPointGrid(false);
      if (equipment() && equipment().setPickGrid) equipment().setPickGrid(false);
    });
  }

  function bindPanel() {
    function bind(id, fn) { var el = $(id); if (el) el.addEventListener('click', fn); }
    bind('btnRoutes', function () { WAP.ctx.nav('routes'); });
    bind('rtNew', newDraft);
    bind('rtCancel', cancelDraft);
    bind('rtDone', finishDraft);
    bind('rtPlay', function () { play(R.selected || (R.routes[0] && R.routes[0].id)); });
    bind('rtStop', function () { stop(); hideHud(); toast('已停止并复位路线货物'); });
    bind('simTemplate', installTemplate);
    bind('rtClear', function () {
      stop();
      disengageAll();
      R.routes = []; R.selected = null; R.draft = null; R.seq = 1;
      save(); showPointGrid(false);
      if (equipment() && equipment().setPickGrid) equipment().setPickGrid(false);
      drawMarkers(); drawPath(); renderPanel(); hideHud();
      toast('已清空全部路线');
    });
    var nameInput = $('rtName');
    if (nameInput) nameInput.addEventListener('input', function () { setRouteName(nameInput.value); });
    var nodes = $('rtNodes');
    if (nodes) nodes.addEventListener('click', function (e) {
      var b = e.target.closest('[data-node]');
      if (b) { removeNode(parseInt(b.dataset.node, 10)); return; }
      var s = e.target.closest('[data-sel]');
      if (s) selectNode(parseInt(s.dataset.sel, 10));
    });
    bind('rtLoop', function () {
      if (WAP.flow) WAP.flow.toggleLoop();
      if (WAP.ui && WAP.ui.syncLoopUI) WAP.ui.syncLoopUI();
      else renderPanel();
      toast(WAP.flow && WAP.flow.loop
        ? '已开启循环 · 货物到终点后原路返回' : '未开启循环 · 货物到终点后必须停止');
    });
    bind('rtHideLine', function () {
      setLineHidden(!R.lineHidden);
      toast(R.lineHidden ? '完整路线已隐藏（功能不受影响）' : '完整路线已显示');
    });
    bind('rtHideTerminals', function () {
      setTerminalsHidden(!R.hideTerminals);
      toast(R.hideTerminals ? '发货器 / 收货器已隐藏（收发功能不受影响）' : '发货器 / 收货器已显示');
    });
    var list = $('rtList');
    if (list) list.addEventListener('click', function (e) {
      var p = e.target.closest('[data-play]');
      if (p) { play(p.dataset.play); return; }
      var d = e.target.closest('[data-rtdel]');
      if (d) {
        var id = d.dataset.rtdel;
        if (R.run && R.run.routeId === id) stop();
        R.routes = R.routes.filter(function (r) { return r.id !== id; });
        if (R.selected === id) R.selected = R.routes.length ? R.routes[0].id : null;
        save(); drawMarkers(); drawPath(); renderPanel();
        toast('已删除路线 ' + id);
        return;
      }
      var it = e.target.closest('[data-route]');
      if (it) selectRoute(it.dataset.route);
    });
    var carrier = $('rtCarrier');
    if (carrier) carrier.addEventListener('change', function () { setCarrier(carrier.value); });
    bindPointDrag();
  }

  /* ---------------- 启动 ---------------- */
  function init() {
    R.canvas = $('c');
    R.rc = new T.Raycaster();
    R.v2 = new T.Vector2();
    var S = WAP.scene.S;
    R.pathRoot = new T.Group(); R.pathRoot.visible = false;
    R.dotRoot = new T.Group(); R.dotRoot.visible = false;
    R.markerRoot = new T.Group(); R.markerRoot.visible = false;
    R.placeRoot = new T.Group(); R.placeRoot.visible = false;
    R.groundRoot = new T.Group();
    R.proxyRoot = new T.Group();
    R.hlRoot = new T.Group(); R.hlRoot.visible = false;
    R.hlRoot.userData.kind = 'routeHighlight';
    R.root = new T.Group();
    S.modelRoot.add(R.pathRoot, R.dotRoot, R.markerRoot, R.placeRoot, R.groundRoot,
      R.proxyRoot, R.hlRoot, R.root);
    S.onRouteDown = onDown;
    S.onRouteMove = onMove;

    var prevTick = S.onTick;
    S.onTick = function (dt) {
      if (prevTick) prevTick(dt);
      watchSim();
      tick(dt);
      tickGroundCargo(dt);
      tickDemo(dt);
    };
    /* sim 复位 / 库体重建时清理仿真落地货物，但不改动 sim.js 文件 */
    var prevStop = WAP.sim.stop;
    WAP.sim.stop = function () { prevStop(); clearSimGroundCargo(); renderPanel(); };
    var prevRebuild = WAP.sim.onRebuild;
    WAP.sim.onRebuild = function () {
      prevRebuild();
      clearSimGroundCargo();
      rebind();               // 库体长宽高变化 → 点位跟随、线路重新规划
    };

    load();
    R.ready = true;
    if (R.routes.length) R.selected = R.routes[0].id;
    attachBinds();            // 旧存档点位补齐绑定元数据
    ensureProxies();
    bindPanel();
    bindKeys();
    renderPanel();
    drawMarkers();
    drawPath();
    updateTemplateState();
    /* 恢复控制面板显隐状态：只改显示，不影响路线 / 收发器功能 */
    setLineHidden(false);
    setTerminalsHidden(!!(WAP.equipment && WAP.equipment.hideTerminals));
    if (WAP.ui && WAP.ui.syncLoopUI) WAP.ui.syncLoopUI();
  }

  /* ---------------- 点位键盘微调 / 绑定异色高亮 ----------------
     方向键每按一次把选中点位移动一个立体空间网格（水平 CELL、竖直层距），
     并重新解析该格上的设备 / 货架货物绑定，用琥珀色框把那一块网格异色标出。 */
  function activeNodeRoute() { return R.draft || activeRoute(); }
  function nearestCellAt(x, z, level) {
    var eq = equipment(), best = null, bd = 1e9;
    ((eq && eq.cells) || []).forEach(function (c) {
      if (c.kind !== 'ground') return;
      var d = Math.hypot(c.x - x, c.z - z);
      if (d < bd) { bd = d; best = c; }
    });
    return best;
  }
  function cellInDirection(x, z, dx, dz, level) {
    var eq = equipment(), g = geom(), c = cfg();
    /* 库内按「货位级」网格（bayW × dp）走，库外按设备网格（CELL）走 */
    var inRack = insideRack(x, z);
    var tx = x + dx * (inRack ? c.bayW : CELL);
    var tz = z + dz * (inRack ? c.dp : CELL);
    var best = null, bd = 1e9;
    if (g && g.cells) g.cells.forEach(function (q) {
      if (q.l !== level || q.chg || q.conv >= 0) return;
      var d = Math.hypot(q.x - tx, q.z - tz);
      if (d < bd) { bd = d; best = { x: q.x, z: q.z, y: q.y, kind: 'rack', cell: q }; }
    });
    ((eq && eq.cells) || []).forEach(function (q) {
      if (q.kind !== 'ground') return;
      var d = Math.hypot(q.x - tx, q.z - tz);
      if (d < bd) { bd = d; best = { x: q.x, z: q.z, y: q.y, kind: 'grid', cell: q }; }
    });
    return best;
  }
  function rebindNodeAt(route, i, x, y, z, targetCell) {
    var old = route.nodes[i], eq = equipment();
    var pos = { kind: 'grid', label: old.label || '路径点', x: x, y: y, z: z };
    /* 优先保留同格上的实体绑定：设备 / 在库货物 / 发货器 */
    var cell = nearestCellAt(x, z, levelOf(y));
    var dev = null;
    if (cell && eq && eq.devices) {
      var q = eq.devices.filter(function (d) {
        return d.cellKey === cell.key && d.type !== 'emitter' && d.type !== 'receiver' &&
          d.type !== 'lift' && d.type !== 'wall' && d.type !== 'single';
      })[0];
      if (q) dev = q;
    }
    if (old.kind === 'cargo' || old.role === 'start') {
      var c = (targetCell && targetCell.kind === 'rack' && targetCell.cell &&
        !targetCell.cell.chg && targetCell.cell.conv < 0)
        ? targetCell.cell : nearestCargoCell(x, z, levelOf(y));
      if (c && Math.hypot(c.x - x, c.z - z) < CELL * 0.9) {
        var cp = cargoPos(c, null);
        cp.label = old.label || cp.label;
        var n = makeNode(old.role, cp); n.bind = makeBind(cp);
        route.nodes[i] = n; return n;
      }
    }
    if (dev && (old.kind === 'device' || old.role === 'via')) {
      pos = { kind: 'device', targetId: dev.id, label: dev.name,
        x: dev.x, y: dev.y + Math.min(dev.dims[1], CONVEY_Y), z: dev.z };
    } else if (cell) {
      pos.x = cell.x; pos.z = cell.z; pos.y = y;
      pos.kind = old.kind === 'emitter' ? 'grid' : (old.kind === 'device' ? 'grid' : old.kind);
    }
    var n = makeNode(old.role, pos);
    n.bind = makeBind(pos);
    route.nodes[i] = n;
    return n;
  }
  function moveSelectedNode(dx, dy, dz) {
    var route = activeNodeRoute();
    if (!route || !route.nodes.length) return false;
    var i = clamp(R.selNode, 0, route.nodes.length - 1);
    var n = route.nodes[i];
    var c = cfg();
    var x = n.x, y = n.y, z = n.z, targetCell = null;
    if (dx || dz) {
      targetCell = cellInDirection(x, z, dx, dz, levelOf(y));
      if (!targetCell) return false;
      x = targetCell.x; z = targetCell.z;
      if (targetCell.kind === 'rack' && !dy) y = targetCell.y;
    }
    if (dy) y = clamp(y + dy * c.pitch, LAND_Y, levelY(c.levels - 1));
    rebindNodeAt(route, i, x, y, z, targetCell);
    if (!route.draft) save();
    R.lastKeyMove = { index: i, x: +x.toFixed(2), y: +y.toFixed(2), z: +z.toFixed(2) };
    drawMarkers(); drawPath(); drawHighlight(); renderPanel();
    if (equipment() && equipment().setPickGrid) equipment().setPickGrid(true);
    return true;
  }
  /* 绑定实体所在的那一块网格 / 结构用琥珀色异色框标出 */
  function drawHighlight() {
    if (!R.hlRoot) return;
    clearGroup(R.hlRoot);
    var route = activeNodeRoute();
    if (R.lineHidden || !route || R.selNode < 0 || !route.nodes[R.selNode]) {
      R.hlRoot.visible = false; return;
    }
    var n = route.nodes[R.selNode], eq = equipment();
    var w = CELL * 0.92, d = CELL * 0.92, h = 0.9, y = 0.45;
    var x = n.x, z = n.z, color = 0xf59e0b;
    var bound = false;
    if (n.targetId && eq && eq.devices) {
      var dev = eq.devices.filter(function (q) { return q.id === n.targetId; })[0];
      if (dev) {
        x = dev.x; z = dev.z;
        w = (dev.dims && dev.dims[0] ? dev.dims[0] : CELL * 0.9) + 0.12;
        d = (dev.dims && dev.dims[2] ? dev.dims[2] : CELL * 0.9) + 0.12;
        h = (dev.dims && dev.dims[1] ? Math.min(dev.dims[1], 2.4) : 0.9) + 0.10;
        y = h / 2 + (dev.y || 0);
        color = 0xfb923c; bound = true;
      }
    }
    if (!bound && n.cargoId) {
      var cell = cargoCellAt(n.cargoId);
      if (cell) {
        x = cell.x; z = cell.z; w = cfg().bayW * 1.02; d = cfg().dp * 1.02;
        h = cfg().pitch * 0.86; y = cell.y + h / 2;
        color = 0xfbbf24; bound = true;
      }
    }
    var mesh = new T.Mesh(new T.BoxGeometry(w, h, d),
      new T.MeshBasicMaterial({ color: color, transparent: true, opacity: 0.20,
        depthWrite: false, depthTest: false, toneMapped: false }));
    mesh.position.set(x, y, z); mesh.renderOrder = 1170;
    R.hlRoot.add(mesh);
    var edges = new T.LineSegments(new T.EdgesGeometry(new T.BoxGeometry(w, h, d)),
      new T.LineBasicMaterial({ color: color, transparent: true, opacity: 0.95,
        depthTest: false, toneMapped: false }));
    edges.position.set(x, y, z); edges.renderOrder = 1171;
    R.hlRoot.add(edges);
    R.hlRoot.visible = true;
    R.hlBound = { bound: bound, color: color, label: nodeLabel(n) };
  }
  function selectNode(i) {
    var route = activeNodeRoute();
    if (!route || !route.nodes.length) { R.selNode = -1; drawHighlight(); renderPanel(); return; }
    R.selNode = clamp(i, 0, route.nodes.length - 1);
    drawHighlight(); renderPanel();
  }
  function bindKeys() {
    D.addEventListener('keydown', function (e) {
      if (/^(INPUT|TEXTAREA|SELECT)$/.test((e.target.tagName || '').toUpperCase())) return;
      if (R.selNode < 0 || !activeNodeRoute()) return;
      /* 设备编辑模式的方向键属于设备移动，点位微调要让路 */
      if (WAP.equipment && WAP.equipment.editMode) return;
      var dx = 0, dy = 0, dz = 0;
      if (e.key === 'ArrowLeft') dx = -1;
      else if (e.key === 'ArrowRight') dx = 1;
      else if (e.key === 'ArrowUp') { if (e.shiftKey) dy = 1; else dz = -1; }
      else if (e.key === 'ArrowDown') { if (e.shiftKey) dy = -1; else dz = 1; }
      else if (e.key === 'PageUp') dy = 1;
      else if (e.key === 'PageDown') dy = -1;
      else return;
      e.preventDefault();
      if (moveSelectedNode(dx, dy, dz)) {
        var n = activeNodeRoute().nodes[R.selNode];
        hud(roleName(n.role) + ' 已移动 1 格 → ' + nodeLabel(n) +
          (R.hlBound && R.hlBound.bound ? ' · 已重新绑定到异色网格上的实体' : ''));
        toast('点位移动 1 格 · 绑定与线路已同步重算');
      }
    });
  }
  /* 隐藏只影响显示：绿点 / 线路、发货器 / 收货器依然参与运行与收发 */
  function setLineHidden(on) {
    R.lineHidden = !!on;
    R.pathRoot.visible = !R.lineHidden;
    R.dotRoot.visible = !R.lineHidden && hasTriple(activeRoute());
    R.markerRoot.visible = !R.lineHidden;       // 点位标记球同步隐藏 / 显示
    if (R.hlRoot) R.hlRoot.visible = !R.lineHidden && R.selNode >= 0;
    if (R.placeRoot) R.placeRoot.visible = !R.lineHidden && R.placeRoot.visible;
    drawPath(); drawMarkers(); renderPanel();
    return R.lineHidden;
  }
  function setTerminalsHidden(on) {
    R.hideTerminals = !!on;
    if (equipment() && equipment().setHidden) equipment().setHidden('terminals', R.hideTerminals);
    renderPanel();
    return R.hideTerminals;
  }
  /* 检测门 / 收货器共用的货物坐标清单 */
  function cargoPoints() {
    var out = [];
    if (R.unit && R.unit.visible) {
      out.push({ x: R.unit.position.x, y: R.unit.position.y, z: R.unit.position.z });
    }
    R.groundCargo.forEach(function (q) {
      if (q.unit && q.unit.visible) {
        out.push({ x: q.unit.position.x, y: q.unit.position.y, z: q.unit.position.z });
      }
    });
    return out;
  }
  /* 收货器吞掉「路线设计」运行中的货物：不复位、不还原货位，货物就此消失 */
  function purgeActiveAt(x, z, r) {
    var rr = r == null ? 1.35 : r;
    if (!R.playing || !R.run || !R.unit || !R.unit.visible) return 0;
    if (Math.hypot(R.run.x - x, R.run.z - z) >= rr) return 0;
    if (R.unit.parent) R.unit.parent.remove(R.unit);
    R.unit = null;
    if (R.borrow) releaseShuttle();
    releaseBorrowedLift();
    disengageAll();
    R.pendingHideId = null; R.loadCell = null;
    R.playing = false;
    if (R.run) { R.run.finished = true; R.run.received = true; }
    renderPanel();
    hud('货物已到达收货器位置 · 已被收走');
    return 1;
  }

  WAP.routes = {
    init: init, newDraft: newDraft, finishDraft: finishDraft, cancelDraft: cancelDraft,
    selectRoute: selectRoute, addPoint: addPoint, removeNode: removeNode,
    setCarrier: setCarrier, setRouteName: setRouteName,
    play: play, stop: stop, tick: tick, rebind: rebind, attachBinds: attachBinds,
    variants: routeVariants, activeSeq: activeSeq, autoVariants: autoVariants,
    priorityVariants: priorityVariants,
    selectNode: selectNode, moveSelectedNode: moveSelectedNode,
    setLineHidden: setLineHidden, setTerminalsHidden: setTerminalsHidden,
    syncLoopUI: renderPanel,
    cargoPoints: cargoPoints, purgeActiveAt: purgeActiveAt,
    /* 托盘系统接管「仅剩托盘」单元时，从落地货物清单里注销 */
    releaseUnit: function (unit) {
      R.groundCargo = R.groundCargo.filter(function (q) { return q.unit !== unit; });
    },
    planSeq: function (seq) { return planRoute({ nodes: seq || [] }, seq); },
    plan: function (id) { return planRoute(routeById(id || R.selected) || activeRoute()); },
    /* 收货器吞货：删掉落在半径内的落地货物（含路线运行 / 仿真接管保留的货物） */
    purgeGroundAt: function (x, z, r) {
      var n = 0, keep = [];
      R.groundCargo.forEach(function (q) {
        if (Math.hypot(q.x - x, q.z - z) < r) {
          if (q.unit && q.unit.parent) q.unit.parent.remove(q.unit);
          n++;
        } else keep.push(q);
      });
      R.groundCargo = keep;
      return n;
    },
    pickPosition: pickPosition, installTemplate: installTemplate,
    templateChain: templateChain, orderLine: orderLine,
    deviceProfiles: function () { return DEVICE_PROFILES; },
    snapshot: function () {
      var r = activeRoute();
      return {
        count: R.routes.length, selected: R.selected,
        draft: !!R.draft, draftCode: R.draft ? R.draft.code : null,
        draftNodes: R.draft ? R.draft.nodes.slice() : [],
        pointToolsVisible: $('rtPointTools') ? !$('rtPointTools').hidden : false,
        nameEditable: $('rtName') ? !$('rtName').disabled : false,
        routeNames: R.routes.map(function (q) { return q.name; }),
        markers: R.markerPicks.length,
        routeMarkers: r ? r.nodes.length : 0,
        placeGridVisible: R.placeRoot ? R.placeRoot.visible : false,
        dragging: !!R.dragPoint || !!R.dragMarker,
        greenDots: R.greenDots, dotRootVisible: R.dotRoot ? R.dotRoot.visible : false,
        steps: R.lastSteps.map(function (s) { return { mode: s.mode, note: s.note,
          entry: s.entry || null, pureZ: !!s.pureZ, innerConveyor: !!s.innerConveyor,
          byShuttle: !!s.byShuttle, pickupReplace: !!s.pickupReplace,
          dirX: s.dirX, dirZ: s.dirZ, fromX: s.fromX, fromZ: s.fromZ, toX: s.toX, toZ: s.toZ,
          devices: s.devices.map(function (d) { return d.id; }), stopAfter: !!s.stopAfter }; }),
        routes: R.routes.map(function (q) {
          return { id: q.id, code: q.code, name: q.name, carrier: q.carrier || 'none',
            template: !!q.template, flow: q.flow || null,
            nodes: q.nodes.slice(), segments: planRoute(q).map(function (s) {
              return { type: s.mode, mode: s.mode, action: s.mode, stub: false,
                devices: s.devices.map(function (d) { return { id: d.id, type: d.type, move: d.move }; }),
                landKey: s.landKey || null, covered: s.covered, from: s.fromX, to: s.toX };
            }) };
        }),
        activeSegments: planRoute(r).map(function (s) { return s.mode; }),
        playing: R.playing,
        lineHidden: R.lineHidden, hideTerminals: R.hideTerminals,
        selNode: R.selNode, hlBound: R.hlBound || null, lastKeyMove: R.lastKeyMove,
        run: R.run ? { idx: R.run.idx, phase: R.run.phase, x: R.run.x, y: R.run.y, z: R.run.z,
          landed: R.run.landed, landedKey: R.run.landedKey, finished: R.run.finished,
          borrowed: !!R.run.borrowed, returning: !!R.run.returning,
          pickupLeg: R.run.pickup ? R.run.pickup.i : -1,
          activeDevices: R.run.activeDevices.slice(), action: (R.run.steps[R.run.idx] || {}).mode || null } : null,
        borrow: R.borrow ? { id: R.borrow.agent.id, level: R.borrow.agent.L,
          x: R.borrow.agent.p.x, z: R.borrow.agent.p.z, y: R.borrow.agent.p.y,
          hiddenCargo: R.borrow.hidden.length, visible: !!R.borrow.agent.obj.visible } : null,
        hasUnit: !!R.unit,
        unitVisible: R.unit ? R.unit.visible : false,
        dockCells: equipment() && equipment().dockCells ? equipment().dockCells() : [],
        lineOrder: templateChain().map(function (d) { return { id: d.id, type: d.type, x: d.x, z: d.z }; }),
        turnIndexes: turnIndexes(orderLine()),
        gridSnap: equipment() && equipment().snapshot ? equipment().snapshot().gridSnap : null,
        lastRebind: R.lastRebind || null,
        boundNodes: R.routes.reduce(function (n, q) {
          return n + q.nodes.filter(function (x) { return !!x.bind; }).length;
        }, 0),
        boundKinds: R.routes.map(function (q) { return q.nodes.map(function (x) { return x.bind ? x.bind.t : null; }); }),
        groundCargo: R.groundCargo.map(function (q) {
          return { from: q.from, phase: q.phase, x: q.x, y: q.y, z: q.z, visible: !!q.unit.visible };
        }),
        droppedCarries: R.droppedCarries,
        template: R.template, templateDevices: R.templateDevices.slice(),
        templateRoutes: R.templateRoutes.slice(), templateChain: templateChain().map(function (d) { return d.id; }),
        demo: R.demo ? { x: R.demo.x, z: R.demo.z, i: R.demo.i } : null,
        hiddenCell: R.hiddenCell,
        nodeTypes: ['cargo', 'device', 'grid', 'rack'],
        carriers: Object.keys(CARRIERS)
      };
    },
    get routes() { return R.routes; },
    get draft() { return R.draft; },
    get playing() { return R.playing; },
    get run() { return R.run; },
    get unit() { return R.unit; },
    get pathRoot() { return R.pathRoot; },
    get dotRoot() { return R.dotRoot; },
    get markerRoot() { return R.markerRoot; },
    get placeRoot() { return R.placeRoot; },
    get groundRoot() { return R.groundRoot; }
  };
})(window);
