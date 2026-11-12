/* WAP-Eavan · equipment.js  (v2)
   输送设备系统。既有运行仿真 sim.js 的运动逻辑保持不动，本模块只通过
   包装 scene.S.onTick / sim.onRebuild 两个钩子接入新增设备的展示动画。

   v2 要点（按需求）：
   ① 移动网格围绕库体四周共 10 层，库体前方（原提升机外接长板处）也在网格内。
   ② 设备模型一律不带货物，尺度按 BAY 宽 / 货位深度换算，与货架货物配套。
   ③ 设备目录：辊道机 / 链条输送机 / 拆底盘机 / 移载机 / 提升机 / 钢平台 / 墙面。
      （删除四向车、层间输送线；移载机＝横置链条机 + 中间纵置的层间输送机，
        两结构顶部齐高，纵向长度 ≤ 链条机宽，纵向宽度 = 链条输送线宽。）
   ④ 提升机与库内提升机是同一台设备：共用控制面板，可控制层数 / 加高，
      加高仅在存在钢平台时允许，可删除；「匹配层间输送线模型」在提升机靠拢
      子通道口时可用（清空该子通道每层货物 + 铺输送线 + 前移最近主通道）。
   ⑤ 钢平台不是每层都有：单块与格子同大的板，可指定所在层 / 方位，
      可实体显示或仅轮廓线，放好后作为该层的额外地面（其格子可再放一台设备）。
   ⑥ 墙是一块灰黄色长方体板，无专门控制面板；选中显示独立晶格子，
      拖拽本体自由移动、拖拽六个控制点自由拉伸。
   ⑦ 控制面板不再浮动，统一停靠到右侧「库体概览」位置；点空白恢复概览。 */
(function (global) {
  'use strict';
  var WAP = global.WAP = global.WAP || {};
  var T = global.THREE;
  var D = global.document;
  var $ = function (id) { return D.getElementById(id); };
  var MM = WAP.materials;
  var STORE = 'wap-eavan.equipment.v2';

  var CELL = 2.0;      // 移动格子边长（m）
  var RINGS = 10;      // 围绕库体四周的网格层数
  var CLEAR = 1.15;    // 网格内边界距库体外缘（删掉提升机前长板后，该区域纳入网格）
  var GHOST = null;

  var TYPES = {
    roller:    { n: '辊道机',     code: 'RG', d: '滚筒输送 · 无载具', flow: 'X' },
    chain:     { n: '链条输送机', code: 'CH', d: '双侧链条 · 托盘移载', flow: 'X' },
    destacker: { n: '拆叠盘机',   code: 'DS', d: '外围四边框 · 空托盘堆叠/拆分 · 非转向工位', flow: 'Y' },
    transfer:  { n: '移载机',     code: 'TR', d: '顶升移载 90° 换向 · 用在转弯位', flow: 'XZ' },
    lift:      { n: '提升机',     code: 'LF', d: '垂直提升 · 与库内共用', flow: 'Y' },
    platform:  { n: '钢平台',     code: 'MP', d: '单层板 · 额外地面', flow: '-' },
    wall:      { n: '墙面',       code: 'WL', d: '灰黄板 · 独立晶格子', flow: '-' },
    /* 物流终端：不占网格名额的「点」设备，与点位逻辑一致 */
    emitter:   { n: '发货器',     code: 'EM', d: '淡绿点 · 绑定设备吐货', flow: '-' },
    receiver:  { n: '收货器',     code: 'RC', d: '红点 · 到货即消失', flow: '-' },
    /* 单货架：特殊机制，选最多 4 个网格后生成链接主体货架的独立货架 */
    single:    { n: '单货架',     code: 'SR', d: '延伸排/列 · 可定制层数与层高', flow: '-' },
    /* 搬运设备（参考 world-rack.com「material handling equipment / operated
       manually or remotely」先凑合建模，后续再完善动作与业务） */
    person:    { n: '人',         code: 'PS', d: '人工搬运 / 巡检 · 参考站素材占位', flow: '-' },
    forklift:  { n: '叉车',       code: 'FK', d: '手动或远程操作 · 物料搬运设备', flow: '-' },
    agv:       { n: 'AGV',       code: 'AG', d: '自动导引车 · 远程调度搬运', flow: '-' },
    truck:     { n: '卡车',       code: 'TK', d: '月台收发 · 外运输车辆', flow: '-' },
    /* 外形检测门：套在链条机 / 辊道机外围，货物过中心亮 5 秒光幕 */
    gate:      { n: '外形检测门', code: 'GD', d: '单片门 · 光幕与门平行 · 过中心亮 5 秒', flow: '-' }
  };
  var ORDER = ['roller', 'chain', 'destacker', 'transfer', 'lift', 'platform', 'wall',
    'emitter', 'receiver', 'single', 'person', 'forklift', 'agv', 'truck', 'gate'];
  /* 点位型设备（不占网格名额，可叠放在已有设备上） */
  var VIRTUAL = { emitter: 1, receiver: 1, single: 1, lift: 1 };
  /* 外覆型设备：套在已有输送设备外围，同样不占网格名额 */
  var OVERLAY = { gate: 1 };

  var ICON = {
    roller: '<rect x="3" y="9" width="34" height="10" rx="2"/><path d="M7 12h26M7 16h26M11 19v6M29 19v6"/>',
    chain: '<rect x="3" y="8" width="34" height="12" rx="2"/><path d="M6 11h28M6 17h28M11 20v5M29 20v5"/><path d="M8 8v12M32 8v12"/>',
    destacker: '<path d="M5 24V5h30v19"/><path d="M5 5h30M35 5v19"/><path d="M12 15h16v7H12z"/><path d="M4 14h9M27 14h9"/>',
    transfer: '<path d="M3 11h34M3 19h34"/><path d="M13 4v22M27 4v22"/><path d="M9 11h22M9 19h22"/><path d="M20 5v20"/>',
    lift: '<path d="M7 26V4M33 26V4M7 4h26M7 26h26"/><path d="M11 18h18v5H11z"/><path d="M20 4v22"/>',
    platform: '<path d="M4 20l8-5h24l-8 5z"/><path d="M4 20v3l24 2 8-5v-3"/><path d="M12 15v3M28 15v5"/>',
    wall: '<rect x="4" y="6" width="32" height="18" rx="1"/><path d="M4 15h32M20 6v18"/>',
    person: '<circle cx="20" cy="7" r="3"/><path d="M20 10v10M14 13h12M20 20l-5 8M20 20l5 8"/>',
    forklift: '<path d="M5 20h18v6H5zM23 15h4v11h-4zM27 18h8M27 22h8"/><circle cx="10" cy="27" r="2"/><circle cx="19" cy="27" r="2"/>',
    agv: '<rect x="5" y="14" width="30" height="10" rx="3"/><path d="M10 24v3M30 24v3"/><circle cx="20" cy="11" r="2"/>',
    truck: '<path d="M3 12h21v12H3zM24 15h10v9H24z"/><circle cx="9" cy="26" r="2.5"/><circle cx="29" cy="26" r="2.5"/>',
    gate: '<path d="M6 26V4h6v22M28 4h6v22M6 4h28"/><rect x="14" y="9" width="12" height="14"/>'
  };

  var E = {
    ready: false, canvas: null, rc: null, v2: null,
    root: null, gridRoot: null, gizmoRoot: null, markRoot: null, wallRoot: null,
    snapRoot: null, cellRoot: null, slotRoot: null,
    cellPick: null,          // 单货架选格模式：正在选格的 single 设备 id
    slotCells: [], slotMap: {}, slotPicks: [],
    hover: null, gridPicks: [], gizmoPicks: [], wallPicks: [], snapPicks: [],
    groundProxyGeo: null,
    devices: [], cells: [], cellMap: {}, counters: {}, seq: 1,
    selected: null, editMode: false, drag: null, t: 0,
    hideTerminals: false,   // 控制面板隐藏收发器：只改显示，不改功能
    pickGrid: false      // 「输送线路线设计」采点时显示四周网格供点选空白格
  };

  /* ---------------- 通用工具 ---------------- */
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (m) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m];
    });
  }
  function toast(msg) { if (WAP.ui && WAP.ui.toast) WAP.ui.toast(msg); }
  function ghostMat() {
    if (!GHOST) {
      GHOST = new T.MeshBasicMaterial({ transparent: true, opacity: 0, colorWrite: false, depthWrite: false, side: T.DoubleSide });
      GHOST.userData.shared = true;
    }
    return GHOST;
  }
  function basic(hex) {
    return new T.MeshBasicMaterial({ color: hex, transparent: true, depthTest: false, depthWrite: false, toneMapped: false });
  }
  function mat(hex, opts) {
    return new T.MeshStandardMaterial(Object.assign({
      color: hex, roughness: 0.58, metalness: 0.22,
      envMap: MM.envMap, envMapIntensity: 0.66
    }, opts || {}));
  }
  var SHARED = null;
  function shared() {
    if (SHARED) return SHARED;
    SHARED = {
      steel: mat(0xa8b5c6, { roughness: 0.50, metalness: 0.44 }),
      steelLight: mat(0xd3dde9, { roughness: 0.54, metalness: 0.30 }),
      steelDark: mat(0x67768b, { roughness: 0.56, metalness: 0.42 }),
      black: mat(0x12171f, { roughness: 0.88, metalness: 0.06 }),
      wall: mat(0xc9b785, { roughness: 0.86, metalness: 0.04 }),
      board: mat(0x4e5a68, { roughness: 0.62, metalness: 0.55 }),   // 暗银色、无网格贴图
      marker: mat(0xf2b53c, { roughness: 0.45, metalness: 0.30, transparent: true, opacity: 0.82 }),
      roller: MM.convRoller(), bar: MM.convBar(), end: MM.convEnd(),
      pallet: MM.pallet(), lift: MM.lift(), liftTop: MM.liftTop(), foot: MM.foot(),
      platform: MM.platform()
    };
    Object.keys(SHARED).forEach(function (k) {
      (Array.isArray(SHARED[k]) ? SHARED[k] : [SHARED[k]]).forEach(function (m) { m.userData.shared = true; });
    });
    return SHARED;
  }
  function box(parent, w, h, d, m, x, y, z) {
    var o = new T.Mesh(new T.BoxGeometry(w, h, d), m);
    o.position.set(x || 0, y || 0, z || 0);
    o.castShadow = true; o.receiveShadow = true;
    parent.add(o);
    return o;
  }
  function tagAll(group, id) {
    group.userData.kind = 'equipment';
    group.userData.devId = id;
    group.traverse(function (n) { n.userData.kind = 'equipment'; n.userData.devId = id; });
  }
  function disposeGroup(o) {
    if (!o) return;
    o.traverse(function (n) {
      if (n.geometry && !(n.geometry.userData && n.geometry.userData.shared)) n.geometry.dispose();
      var ms = n.material ? (Array.isArray(n.material) ? n.material : [n.material]) : [];
      ms.forEach(function (m) {
        if (m.userData && m.userData.shared) return;
        if (m.map && !m.map.userData) m.map.dispose();
        m.dispose();
      });
    });
  }
  function clearGroup(gr) {
    while (gr.children.length) {
      var o = gr.children[0];
      gr.remove(o);
      disposeGroup(o);
    }
  }
  /* 设备尺度与货架货位配套：按 BAY 宽 / 货位深度换算，货物单元宽约 0.76 m */
  function unit() {
    var c = WAP.state.cfg;
    return {
      W: +(c.bayW * 1.15).toFixed(3),
      D: +(c.dp * 1.14).toFixed(3),
      H: 0.72,
      lineW: +(c.dp * 1.14 - 0.24).toFixed(3)
    };
  }

  /* ---------------- 7 类设备建模（不含任何货物） ---------------- */
  function frameLegs(g, u) {
    var S = shared();
    [-1, 1].forEach(function (sx) {
      [-1, 1].forEach(function (sz) {
        var x = sx * (u.W / 2 - 0.09), z = sz * (u.D / 2 - 0.09);
        box(g, 0.09, u.H, 0.09, S.steel, x, u.H / 2, z);
        box(g, 0.22, 0.03, 0.22, S.foot, x, 0.015, z);
      });
    });
  }
  function buildRoller(d) {
    var S = shared(), u = unit(), g = new T.Group();
    frameLegs(g, u);
    [-1, 1].forEach(function (sz) { box(g, u.W, 0.09, 0.08, S.steel, 0, u.H - 0.045, sz * (u.D / 2 - 0.02)); });
    [-1, 1].forEach(function (sx) { box(g, 0.08, 0.09, u.D, S.steel, sx * (u.W / 2 - 0.02), u.H - 0.045, 0); });
    var rollers = [], n = 9, rr = 0.075;
    for (var i = 0; i < n; i++) {
      var holder = new T.Group();
      holder.position.set(-u.W / 2 + 0.14 + i * (u.W - 0.28) / (n - 1), u.H + 0.03, 0);
      holder.rotation.x = Math.PI / 2;
      var cyl = new T.Mesh(new T.CylinderGeometry(rr, rr, u.D - 0.16, 14), S.roller);
      cyl.castShadow = true; cyl.receiveShadow = true;
      holder.add(cyl); g.add(holder); rollers.push(cyl);
    }
    return { group: g, dims: [u.W, u.H + 0.16, u.D], anim: { step: function (dt, run) {
      if (!run) return;
      rollers.forEach(function (r) { r.rotation.y += dt * 3.4; });
    } } };
  }

  function chainParts(g, u, anim) {
    var S = shared();
    frameLegs(g, u);
    [-1, 1].forEach(function (sx) { box(g, 0.08, 0.09, u.D, S.steelLight, sx * (u.W / 2 - 0.02), u.H - 0.045, 0); });
    [-0.5, 0, 0.5].forEach(function (x) { box(g, 0.09, 0.07, u.D - 0.10, S.steelLight, x, u.H - 0.02, 0); });
    var linkCount = 20, linkGeo = new T.BoxGeometry(0.07, 0.022, 0.075);
    var links = new T.InstancedMesh(linkGeo, S.black, linkCount * 2);
    links.frustumCulled = false; links.castShadow = true;
    var dummy = new T.Object3D(), offset = 0, span = u.W - 0.2;
    [-1, 1].forEach(function (sz) {
      box(g, u.W, 0.09, 0.12, S.steelLight, 0, u.H - 0.03, sz * (u.D / 2 - 0.07));
      box(g, u.W, 0.032, 0.09, S.black, 0, u.H + 0.04, sz * (u.D / 2 - 0.07));
    });
    function placeLinks() {
      for (var k = 0; k < linkCount * 2; k++) {
        var side = k < linkCount ? -1 : 1, i = k % linkCount;
        var x = -u.W / 2 + 0.10 + ((i * span / linkCount + offset) % span);
        dummy.position.set(x, u.H + 0.066, side * (u.D / 2 - 0.07));
        dummy.rotation.set(0, 0, 0); dummy.scale.set(1, 1, 1);
        dummy.updateMatrix(); links.setMatrixAt(k, dummy.matrix);
      }
      links.instanceMatrix.needsUpdate = true;
    }
    placeLinks(); g.add(links);
    anim.chain = function (dt) { offset = (offset + dt * 0.42) % span; placeLinks(); };
    return links;
  }
  function buildChain(d) {
    var u = unit(), g = new T.Group(), anim = {};
    chainParts(g, u, anim);
    return { group: g, dims: [u.W, u.H + 0.16, u.D], anim: { step: function (dt, run) {
      if (run && anim.chain) anim.chain(dt);
    } } };
  }

  /* 移载机：链条机横向（长轴 X）+ 中间纵置层间输送机（长轴 Z）。
     纵向长度 ≤ 链条机宽 u.D；纵向宽度 = 链条输送线宽 u.lineW；两结构顶部齐高。 */
  function buildTransfer(d) {
    var S = shared(), u = unit(), g = new T.Group(), anim = {};
    chainParts(g, u, anim);
    var topY = u.H + 0.066;
    var len = Math.min(u.D * 0.92, u.D);   // ≤ 链条机宽
    var wid = u.lineW;                     // = 链条输送线宽
    [-1, 1].forEach(function (sx) {
      box(g, 0.11, 0.10, len, S.bar, sx * wid * 0.34, topY, 0);
    });
    var rollers = [];
    for (var r = -2; r <= 2; r++) {
      var holder = new T.Group();
      holder.position.set(0, topY + 0.006, r * len / 5.4);
      var cyl = new T.Mesh(new T.CylinderGeometry(0.028, 0.028, wid * 0.62, 10), S.roller);
      cyl.rotation.z = Math.PI / 2;
      holder.add(cyl); g.add(holder); rollers.push(cyl);
    }
    box(g, wid + 0.10, 0.055, 0.05, S.end, 0, topY, -len / 2 - 0.03);
    box(g, wid + 0.10, 0.055, 0.05, S.end, 0, topY, len / 2 + 0.03);
    g.userData.eqMeta = { role: 'turn', device: '移载机',
      len: len, wid: wid, top: topY, chainW: u.W, chainD: u.D, lineW: u.lineW };
    return { group: g, dims: [u.W, u.H + 0.16, u.D], anim: { step: function (dt, run) {
      if (!run) return;
      if (anim.chain) anim.chain(dt);
      rollers.forEach(function (o) { o.rotation.x += dt * 2.6; });
    } } };
  }

  /* 拆叠盘机：外围四边框（四角立柱 + 上下四边横梁）+ 内部升降台 / 拨叉。
     · 模型本身【没有任何托盘】——托盘垛是运行时由 WAP.pallets 收进来才堆起来的；
     · 只接收托盘，不接收货物；只收集母托盘（光母托盘），子托盘不收；
     · 需要母托盘时可从垛里分离出单片母托盘，沿输送线送出去。
     不参与 90° 换向。 */
  function buildDestacker(d) {
    var S = shared(), u = unit(), g = new T.Group();
    var H = 1.52, W = u.W + 0.22, D = u.D + 0.24, t = 0.085;
    var frame = mat(0x475569, { roughness: 0.48, metalness: 0.52 });
    outerFrame(g, W, H, D, t, frame);
    [-1, 1].forEach(function (sx) {
      [-1, 1].forEach(function (sz) {
        box(g, 0.24, 0.03, 0.24, S.foot, sx * W / 2, 0.015, sz * D / 2);
      });
    });
    var lift = new T.Group();
    [-1, 1].forEach(function (sx) {
      [-1, 1].forEach(function (sz) {
        box(lift, 0.07, 0.42, 0.07, S.steelLight, sx * 0.40, 0.21, sz * 0.34);
      });
    });
    box(lift, 0.96, 0.05, 0.80, S.steelLight, 0, 0.44, 0);
    g.add(lift);
    [-1, 1].forEach(function (sx) {
      [-1, 1].forEach(function (sz) {
        var arm = box(g, 0.52, 0.05, 0.10, S.black, sx * 0.56, 0.56, sz * 0.36);
        arm.rotation.z = sx * 0.14;
      });
    });
    /* 托盘垛容器：初始为空，收进母托盘后由 setDestackerStack 逐片堆起来 */
    var stack = new T.Group();
    stack.userData.eqPart = 'palletStack';
    g.add(stack);
    g.userData.eqMeta = { role: 'pallet', device: '拆叠盘机', outerFrame: true,
      palletStack: stack, stackCount: 0, hasPallet: false };
    return { group: g, dims: [W, H, D], anim: { step: function (dt, run, t) {
      lift.position.y = run ? 0.08 * (0.5 + 0.5 * Math.sin(t * 1.7)) : 0;
    } } };
  }
  /* 运行时：把收到的母托盘堆成垛（最多显示 8 片），模型本身不带任何托盘 */
  function setDestackerStack(id, count) {
    var d = devById(id || E.selected);
    if (!d || d.type !== 'destacker' || !d.group) return 0;
    var meta = d.group.userData.eqMeta;
    var stack = meta && meta.palletStack;
    if (!stack) return 0;
    var n = clamp(Math.round(Number(count) || 0), 0, 12);
    while (stack.children.length) {
      var o = stack.children[0];
      stack.remove(o); disposeGroup(o);
    }
    var m = MM.palletMother();
    for (var i = 0; i < Math.min(n, 8); i++) {
      var slab = new T.Mesh(new T.BoxGeometry(0.86, 0.075, 0.72), m);
      slab.position.set(0, 0.50 + i * 0.082, 0);
      slab.castShadow = true; slab.receiveShadow = true;
      slab.userData.eqPart = 'stackPallet';
      stack.add(slab);
    }
    meta.stackCount = n; meta.hasPallet = n > 0;
    return n;
  }
  function destackerStackOf(id) {
    var d = devById(id);
    var m = d && d.group && d.group.userData && d.group.userData.eqMeta;
    return m ? (m.stackCount || 0) : 0;
  }

  /* 提升机设备＝库内提升机本体，这里只放一个可拖动的「接驳标记」，不重复建塔。
     标记平时隐藏，仅选中该提升机时显示，避免塔底出现无意义的装饰。 */
  function buildLiftDev(d) {
    var S = shared(), g = new T.Group();
    var plate = box(g, 0.82, 0.05, 0.82, S.marker, 0, 0.03, 0);
    plate.userData.eqPart = 'markerPlate';
    var edges = new T.LineSegments(new T.EdgesGeometry(new T.BoxGeometry(0.82, 0.05, 0.82)),
      new T.LineBasicMaterial({ color: 0xc4861a, transparent: true, opacity: 0.95, depthTest: false }));
    edges.position.y = 0.03; edges.renderOrder = 900;
    g.add(edges);
    var g2 = WAP.state.geom;
    var h = g2 ? g2.top + 0.6 : 3;
    return { group: g, dims: [1.82, h, 1.86], anim: null };
  }

  /* 钢平台：单块与格子同大的长方体板，放在指定层（deck）的位置上，
     可实体显示或仅显示轮廓线；完成后该层格子成为「额外地面」。 */
  function buildPlatform(d) {
    var S = shared(), cfg = WAP.state.cfg, g = new T.Group();
    var W = CELL * 0.92, TH = 0.10;
    var deck = clamp(d.deck || 0, 0, Math.max(0, cfg.levels - 1));
    var y = cfg.y0 + deck * cfg.pitch - TH / 2;   // 板面 = 该层货位高度
    var board = box(g, W, TH, W, S.board, 0, y, 0);
    board.userData.eqPart = 'board';
    /* 纯暗银板，不带格栅线 / 网格贴图；轮廓模式只显示边框 */
    var outline = new T.LineSegments(new T.EdgesGeometry(new T.BoxGeometry(W, TH, W)),
      new T.LineBasicMaterial({ color: 0x9aa7b6, transparent: true, opacity: 0.95, depthTest: false }));
    outline.position.y = y; outline.renderOrder = 902;
    outline.userData.eqPart = 'outline';
    g.add(outline);
    setPlatformVisual(d, g);
    g.userData.eqMeta = { boardW: W, boardY: y, deck: deck, oneBoard: true };
    return { group: g, dims: [W, TH, W], anim: null };
  }
  function setPlatformVisual(d, group) {
    var g = group || (d && d.group);
    if (!g) return;
    var solid = d.solid !== false;
    g.traverse(function (o) {
      var p = o.userData && o.userData.eqPart;
      if (p === 'board' || p === 'lines') o.visible = solid;
      else if (p === 'outline') o.visible = !solid;
    });
  }

  /* 墙：一块灰黄色长方体板；选中后由 wallRoot 生成独立晶格子 */
  function buildWall(d) {
    var S = shared(), g = new T.Group();
    var size = d.size || [CELL * 0.90, 2.40, 0.12];
    d.size = size.slice();
    var panel = box(g, size[0], size[1], size[2], S.wall, 0, size[1] / 2, 0);
    panel.userData.eqPart = 'wallPanel';
    g.userData.eqMeta = { size: size.slice(), onePanel: true, color: 0xc9b785 };
    return { group: g, dims: size.slice(), anim: null };
  }

  /* ---------------- 物流终端：发货器 / 收货器 ----------------
     两者都是「点」：一个淡绿色 / 红色小球 + 细光环，不占网格名额，
     可以叠放在已有设备格子上，也能被路线起点 / 终点选中。 */
  function buildTerminal(d) {
    var emit = d.type === 'emitter';
    var color = emit ? 0x86efac : 0xf87171;
    var g = new T.Group();
    var dotMat = new T.MeshBasicMaterial({ color: color, toneMapped: false,
      transparent: true, opacity: 0.96, depthTest: false, depthWrite: false });
    var dot = new T.Mesh(new T.SphereGeometry(0.19, 16, 12), dotMat);
    dot.position.y = 0.26; dot.renderOrder = 1200;
    dot.userData.eqPart = 'terminalDot';
    g.add(dot);
    var ring = new T.Mesh(new T.TorusGeometry(0.30, 0.025, 6, 28),
      new T.MeshBasicMaterial({ color: color, toneMapped: false, transparent: true,
        opacity: 0.85, depthTest: false, depthWrite: false }));
    ring.rotation.x = Math.PI / 2; ring.position.y = 0.055; ring.renderOrder = 1199;
    g.add(ring);
    /* 细立柱把点抬到设备顶面附近，避免和输送线面重叠穿模 */
    var stem = box(g, 0.035, 0.20, 0.035,
      new T.MeshBasicMaterial({ color: color, toneMapped: false, transparent: true, opacity: 0.55 }),
      0, 0.10, 0);
    stem.userData.eqPart = 'terminalStem';
    /* 透明大球作为拾取代理，方便在 3D 中点到小小的点 */
    var pick = new T.Mesh(new T.SphereGeometry(0.44, 10, 8), ghostMat());
    pick.position.y = 0.24; pick.renderOrder = 1198;
    pick.userData.eqPart = 'terminalPick';
    g.add(pick);
    g.userData.eqMeta = { terminal: emit ? 'emitter' : 'receiver', color: color };
    return { group: g, dims: [0.62, 0.52, 0.62], anim: { step: function (dt, run, t) {
      dot.scale.setScalar(run ? 1 + 0.16 * Math.sin(t * 4.2) : 1);
      ring.scale.setScalar(run ? 1 + 0.08 * Math.sin(t * 2.6) : 1);
    } } };
  }

  /* ---------------- 搬运设备（参考站素材占位，后续再完善） ----------------
     world-rack.com / as-rs.html：「ASRS is assembled with racking system,
     stacker, conveyor, cranes, material handling equipment. Operated manually
     or remotely...」。这里先给人员 / 叉车 / AGV / 卡车做可摆放的简化模型，
     不参与货物承载（货物仍只由四向车 / 提升机 / 输送设备承担）。 */
  function buildPerson(d) {
    var g = new T.Group();
    var skin = mat(0xe8b48c, { roughness: 0.9, metalness: 0 });
    var vest = mat(0xf59e0b, { roughness: 0.78, metalness: 0.02 });
    var pants = mat(0x27364a, { roughness: 0.86, metalness: 0.02 });
    var helm = mat(0xffd43b, { roughness: 0.6, metalness: 0.05 });
    box(g, 0.42, 0.62, 0.27, vest, 0, 1.12, 0);
    box(g, 0.34, 0.30, 0.25, pants, 0, 0.72, 0);
    [-1, 1].forEach(function (sx) {
      var leg = box(g, 0.14, 0.68, 0.16, pants, sx * 0.11, 0.35, 0);
      leg.userData.eqPart = 'leg';
      box(g, 0.12, 0.56, 0.13, vest, sx * 0.29, 1.10, 0);
    });
    var head = new T.Mesh(new T.SphereGeometry(0.16, 14, 10), skin);
    head.position.set(0, 1.57, 0); g.add(head);
    var cap = new T.Mesh(new T.SphereGeometry(0.175, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.55), helm);
    cap.position.set(0, 1.60, 0); g.add(cap);
    g.userData.eqMeta = { actor: 'person' };
    return { group: g, dims: [0.62, 1.78, 0.42], anim: { step: function (dt, run, t) {
      g.traverse(function (o) {
        if (o.userData.eqPart === 'leg') o.rotation.x = run ? 0.24 * Math.sin(t * 5) : 0;
      });
    } } };
  }
  function buildForklift(d) {
    var g = new T.Group(), S = shared();
    var body = mat(0xf0a500, { roughness: 0.55, metalness: 0.22 });
    var dark = mat(0x222b38, { roughness: 0.8, metalness: 0.1 });
    box(g, 1.32, 0.52, 0.86, body, -0.30, 0.42, 0);
    box(g, 0.62, 0.44, 0.80, body, -0.62, 0.94, 0);
    box(g, 0.66, 0.07, 0.88, dark, -0.30, 1.20, 0);
    [-1, 1].forEach(function (sz) {
      box(g, 0.07, 0.07, 0.07, dark, -0.62, 1.24, sz * 0.42);
      box(g, 0.09, 1.42, 0.09, S.steelDark, 0.58, 0.71, sz * 0.31);
      box(g, 0.90, 0.055, 0.10, S.steelDark, 1.00, 0.13, sz * 0.27);
      [-1, 1].forEach(function (sx) {
        var w = new T.Mesh(new T.CylinderGeometry(0.19, 0.19, 0.13, 14), dark);
        w.rotation.x = Math.PI / 2;
        w.position.set(sx > 0 ? 0.16 : -0.86, 0.19, sz * 0.46);
        g.add(w);
      });
    });
    var mast = box(g, 0.56, 0.30, 0.70, S.steelDark, 0.58, 1.32, 0);
    mast.userData.eqPart = 'mast';
    g.userData.eqMeta = { actor: 'forklift' };
    return { group: g, dims: [2.15, 1.55, 1.02], anim: { step: function (dt, run, t) {
      mast.position.y = run ? 1.32 + 0.10 * Math.sin(t * 1.6) : 1.32;
    } } };
  }
  function buildAGV(d) {
    var g = new T.Group();
    var shell = mat(0x3b82f6, { roughness: 0.48, metalness: 0.32 });
    var dark = mat(0x1f2937, { roughness: 0.82, metalness: 0.08 });
    box(g, 1.42, 0.30, 1.02, shell, 0, 0.25, 0);
    box(g, 1.16, 0.05, 0.86, dark, 0, 0.42, 0);
    [-1, 1].forEach(function (sz) {
      [-1, 1].forEach(function (sx) {
        var w = new T.Mesh(new T.CylinderGeometry(0.12, 0.12, 0.09, 12), dark);
        w.rotation.x = Math.PI / 2;
        w.position.set(sx * 0.52, 0.12, sz * 0.52);
        g.add(w);
      });
    });
    var beacon = new T.Mesh(new T.CylinderGeometry(0.075, 0.075, 0.10, 12),
      new T.MeshBasicMaterial({ color: 0xfbbf24, toneMapped: false }));
    beacon.position.set(0, 0.50, 0);
    beacon.userData.eqPart = 'beacon';
    g.add(beacon);
    g.userData.eqMeta = { actor: 'agv' };
    return { group: g, dims: [1.46, 0.58, 1.06], anim: { step: function (dt, run, t) {
      beacon.material.opacity = run ? 0.45 + 0.55 * Math.abs(Math.sin(t * 4)) : 1;
      beacon.material.transparent = true;
    } } };
  }
  function buildTruck(d) {
    var g = new T.Group();
    var cab = mat(0x2563eb, { roughness: 0.5, metalness: 0.28 });
    var boxM = mat(0xdbe3ee, { roughness: 0.72, metalness: 0.12 });
    var dark = mat(0x1b2430, { roughness: 0.85, metalness: 0.06 });
    box(g, 3.30, 2.02, 1.86, boxM, -0.60, 1.42, 0);
    box(g, 1.18, 1.48, 1.80, cab, 1.72, 1.08, 0);
    box(g, 0.06, 0.52, 1.56, dark, 2.31, 1.30, 0);
    box(g, 4.10, 0.20, 1.90, dark, 0.30, 0.40, 0);
    [-1, 1].forEach(function (sz) {
      [-1.55, 0.35, 1.86].forEach(function (x) {
        var w = new T.Mesh(new T.CylinderGeometry(0.34, 0.34, 0.18, 16), dark);
        w.rotation.x = Math.PI / 2;
        w.position.set(x, 0.34, sz * 0.94);
        g.add(w);
      });
    });
    g.userData.eqMeta = { actor: 'truck' };
    return { group: g, dims: [4.30, 2.44, 1.92], anim: null };
  }
  /* 外围四边框：四角立柱 + 上/下四边横梁的长方体镂空框架。
     原本用在检测门上，现在按用户要求改作「拆叠盘机」的主体外形。 */
  function outerFrame(parent, W, H, D, t, m) {
    [-1, 1].forEach(function (sx) {
      [-1, 1].forEach(function (sz) {
        box(parent, t, H, t, m, sx * W / 2, H / 2, sz * D / 2);
      });
    });
    [0, H].forEach(function (y) {
      [-1, 1].forEach(function (sz) { box(parent, W, t, t, m, 0, y, sz * D / 2); });
      [-1, 1].forEach(function (sx) { box(parent, t, t, D, m, sx * W / 2, y, 0); });
    });
  }
  /* 外形检测门：就是「一个门」—— 单片矩形门框 + 与门平行的长方形光幕。
     · 绿色框（原光幕框）拉高到 200%（原门高 ×2），并旋转 90°：
       门面法线从 X 改为 Z，正好横跨链条机 / 辊道机的行进方向；
     · 删掉外围四边框（移去 buildDestacker 使用）；
     · 货物经过门中心时，门内光幕亮 5 秒（透明度 50%，颜色红 / 绿可选）。 */
  function buildGate(d) {
    var g = new T.Group(), u = unit();
    var chainH = u.H + 0.16;
    var baseH = chainH * 1.5;
    var DOOR_H = baseH * 2;                 // 拉高到 200%
    var DOOR_W = u.W + 0.22, t = 0.075;
    var color = d.gateColor === 'red' ? 0xef4444 : 0x22c55e;
    /* 门框（绿色框）：两根立柱 + 顶梁 + 底梁，全在 z=0 平面内 */
    var edgeMat = new T.MeshBasicMaterial({ color: color, transparent: true,
      opacity: 0.92, toneMapped: false, depthWrite: false });
    [-1, 1].forEach(function (sx) {
      box(g, t, DOOR_H, t, edgeMat, sx * DOOR_W / 2, DOOR_H / 2, 0);
      box(g, 0.26, 0.05, 0.26, shared().steelDark, sx * DOOR_W / 2, 0.025, 0);
    });
    box(g, DOOR_W, t, t, edgeMat, 0, DOOR_H, 0);
    box(g, DOOR_W, t, t, edgeMat, 0, 0.045, 0);
    /* 光幕与门平行：同一 z=0 平面，长方形半透明面（rotation.y=0 ＝ 旋转 90°） */
    var cm = new T.MeshBasicMaterial({ color: color, transparent: true, opacity: 0.5,
      side: T.DoubleSide, depthWrite: false, toneMapped: false });
    var curtain = new T.Mesh(new T.PlaneGeometry(DOOR_W * 0.88, DOOR_H * 0.90), cm);
    curtain.rotation.y = 0;
    curtain.position.set(0, DOOR_H / 2, 0);
    curtain.visible = false;
    curtain.userData.eqPart = 'gateCurtain';
    curtain.renderOrder = 1160;
    g.add(curtain);
    g.userData.eqMeta = { gate: true, height: DOOR_H, curtain: curtain, curtainMat: cm,
      doorFrameMat: edgeMat, curtainColor: d.gateColor === 'red' ? 'red' : 'green',
      heightRatio: 3, scale: 2, rotated: 90, opacity: 0.5, seconds: 5 };
    return { group: g, dims: [DOOR_W, DOOR_H, 0.14], anim: { step: function (dt, run, t) {
      if (!curtain.visible) return;
      cm.opacity = 0.5;                 // 光幕透明度恒为 50%
      curtain.scale.y = 1 + 0.012 * Math.sin(t * 9);
    } } };
  }

  /* ---------------- 单货架：主体货架同款结构 / 贴图，按货位格生成 ----------------
     用户点「单货架」后不产生任何常驻模型，直接进入货位网格选最多 4 格；
     选格 / 改参数时实时重建预览（与主体货架同样用 upright / beam / rail / foot
     材质和 makeCargoUnit 货物），点「确认生成」后才落定。
     格子尺寸 = bayW × dp，与主体货位同轴对齐；生成时自动吸附贴合主体货架。 */
  var SLOT_MAT = null;
  function slotMaterials() {
    if (SLOT_MAT) return SLOT_MAT;
    var c = cfg();
    var upr = (WAP.rack.UPR && WAP.rack.UPR[c.upr]) || 0x1c4bc4;
    SLOT_MAT = {
      upr: MM.upright(upr), beam: MM.beam(), rail: MM.rail(), foot: MM.foot()
    };
    Object.keys(SLOT_MAT).forEach(function (k) {
      var m = SLOT_MAT[k];
      (Array.isArray(m) ? m : [m]).forEach(function (q) { if (q) q.userData.shared = true; });
    });
    return SLOT_MAT;
  }
  function cargoKindForSingle(d, lv) {
    var kind = d.cargoKind || cfg().cargoType;
    if (kind === 'mix') {
      var real = WAP.core.CARGO_REAL;
      return real[lv % real.length];
    }
    return kind;
  }
  /* 单货架默认尺寸比例始终取自「当时主体货架」的当前参数 */
  function mainLevels() { return clamp((cfg() && cfg().levels) || 6, 2, 12); }
  function mainPitch() { return clamp((cfg() && cfg().pitch) || 1.25, 0.8, 3); }
  function buildSingleRack(d) {
    var g = new T.Group();
    var keys = snapSlotsToRack(d.singleCells || []);
    if (!keys.length) {
      g.userData.eqMeta = { single: true, built: false, cells: [], cargoCount: 0 };
      return { group: g, dims: [0, 0, 0], anim: null };   // 无选中格＝完全不显示任何东西
    }
    var S = slotMaterials(), c = cfg(), gg = geom();
    /* 比例与主体货架一致：默认层数 / 层距 / 梁面标高 / 总高全部取自当前主体参数，
       货位净高 loadH 也由主体 geom 提供（货物单元沿用 makeCargoUnit 同一套外观）。 */
    var levels = clamp(d.singleLevels || mainLevels(), 1, 12);
    var pitch = clamp(d.singlePitch || c.pitch, 0.8, 3);
    var y0 = clamp(c.y0, 0.1, 2);
    var loadH = gg && isFinite(gg.loadH) ? gg.loadH : 0.5;
    var hasCargo = d.singleCargo !== false;
    var top = y0 + (levels - 1) * pitch + Math.max(0.9, loadH + 0.5);
    var bw = c.bayW, dp = c.dp;
    var cargoCount = 0;
    /* 与主体货架完全一致的构件尺寸：0.09 立柱片 / 0.15×0.10 横梁 /
       0.085×0.11 子巷导轨 / 0.24 柱脚 / 0.12×0.11 顶部拉杆 */
    var postGeo = new T.BoxGeometry(0.09, top, 0.09);
    var footGeo = new T.BoxGeometry(0.24, 0.024, 0.24);
    var beamXGeo = new T.BoxGeometry(bw, 0.15, 0.10);
    var railZGeo = new T.BoxGeometry(0.085, 0.11, dp);
    var capGeo = new T.BoxGeometry(bw, 0.12, 0.11);
    keys.forEach(function (key, idx) {
      var cell = E.slotMap[key];
      if (!cell) return;
      var cx = cell.x, cz = cell.z;
      [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(function (p) {
        var px = cx + p[0] * bw * 0.5, pz = cz + p[1] * dp * 0.5;
        var post = new T.Mesh(postGeo, S.upr);
        post.position.set(px, top / 2, pz);
        post.castShadow = true; g.add(post);
        var foot = new T.Mesh(footGeo, S.foot);
        foot.position.set(px, 0.012, pz); g.add(foot);
      });
      for (var lv = 0; lv < levels; lv++) {
        var y = y0 + lv * pitch;
        [-1, 1].forEach(function (sz) {
          var beam = new T.Mesh(beamXGeo, S.beam);
          beam.position.set(cx, y - 0.22, cz + sz * dp * 0.5);
          beam.castShadow = true; g.add(beam);
          var rail = new T.Mesh(railZGeo, S.rail);
          rail.position.set(cx + sz * bw * 0.5, y - 0.07, cz);
          g.add(rail);
        });
        if (hasCargo) {
          var unit = WAP.rack.makeCargoUnit(cargoKindForSingle(d, lv), lv * 7 + idx + 3,
            d.cargoClass || c.cargoClass || 'single');
          unit.position.set(cx, y, cz);
          g.add(unit); cargoCount++;
        }
      }
      /* 顶部横向拉杆，与主体货架同款同尺寸 */
      var cap = new T.Mesh(capGeo, S.upr);
      cap.position.set(cx, top - 0.09, cz);
      g.add(cap);
      /* 自动吸附贴合主体货架：从该货位格拉一段连接梁到最近的库体外缘 */
      if (gg) {
        var ex = clamp(cx, gg.x0, gg.x1), ez = clamp(cz, gg.z0, gg.z1);
        var len = Math.hypot(ex - cx, ez - cz);
        if (len > 0.04) {
          var link = new T.Mesh(new T.BoxGeometry(0.10, 0.09, len), S.beam);
          link.position.set((cx + ex) / 2, y0 - 0.22, (cz + ez) / 2);
          link.rotation.y = Math.atan2(ex - cx, ez - cz) - Math.PI / 2;
          g.add(link);
        }
      }
    });
    var cell0 = E.slotMap[keys[0]];
    g.userData.eqMeta = { single: true, built: !!d.singleBuilt, levels: levels,
      pitch: pitch, y0: y0, top: top, loadH: loadH, bayW: bw, dp: dp,
      cargo: hasCargo, cells: keys.slice(), cargoCount: cargoCount,
      x: cell0 ? cell0.x : 0, z: cell0 ? cell0.z : 0 };
    return { group: g, dims: [bw, top, dp], anim: null };
  }

  function buildDevice(d) {
    var out;
    switch (d.type) {
      case 'roller': out = buildRoller(d); break;
      case 'chain': out = buildChain(d); break;
      case 'transfer': out = buildTransfer(d); break;
      case 'destacker': out = buildDestacker(d); break;
      case 'lift': out = buildLiftDev(d); break;
      case 'platform': out = buildPlatform(d); break;
      case 'emitter': case 'receiver': out = buildTerminal(d); break;
      case 'single': out = buildSingleRack(d); break;
      case 'person': out = buildPerson(d); break;
      case 'forklift': out = buildForklift(d); break;
      case 'agv': out = buildAGV(d); break;
      case 'truck': out = buildTruck(d); break;
      case 'gate': out = buildGate(d); break;
      default: out = buildWall(d);
    }
    tagAll(out.group, d.id);
    return out;
  }

  /* ---------------- 网格数据 ----------------
     · G|i|j：围绕库体四周共 10 层的地面移动格子，y=0，与库体地面同高。
     · P|平台id|层：该钢平台所在层的立体格子，y = y0 + 层*层距（对齐货位高度），
       可同时容纳平台本体 + 1 台设备。无钢平台时只有单层地面网格。 */
  function geom() { return WAP.state.geom; }
  function cfg() { return WAP.state.cfg; }
  function hasPlatform() { return E.devices.some(function (d) { return d.type === 'platform'; }); }
  function devById(id) {
    for (var i = 0; i < E.devices.length; i++) if (E.devices[i].id === id) return E.devices[i];
    return null;
  }
  function devByLiftId(lid) {
    for (var i = 0; i < E.devices.length; i++) if (E.devices[i].type === 'lift' && E.devices[i].liftId === lid) return E.devices[i];
    return null;
  }
  function selectedDevice() { return devById(E.selected); }
  function liftSite(d) {
    if (!d || !d.liftId || !geom()) return null;
    var arr = geom().liftSites || [];
    for (var i = 0; i < arr.length; i++) if (arr[i].id === d.liftId) return arr[i];
    return null;
  }
  function liftCfg(d) {
    var c = cfg();
    c.liftCfg = c.liftCfg || {};
    if (!d || !d.liftId) return null;
    if (!c.liftCfg[d.liftId]) c.liftCfg[d.liftId] = { lv: c.levels, boost: 0, matched: true, side: 'front' };
    var cf = c.liftCfg[d.liftId];
    if (!cf.side) cf.side = 'front';
    return cf;
  }

  /* 网格随货架参数变化而调整：
     · 规则格子的坐标 = i*CELL + snapX / j*CELL + snapZ，其中 snap 由库体外边界推导。
       改变长/宽/层数时网格整体跟着平移，格子 key 不变，已摆放设备随网格一起移动，
       不会再出现「库体变了、格子还留在旧绝对坐标」的错位。
     · 每台提升机的 front / back 正面口，额外把最近的一个 ring0 格子吸附成
       「精确对接格」：x 严格等于塔位 x，z 落在口子外侧一格。
       第一台辊道 / 链条机放到这格上即可与提升机正面口完美对准。 */
  /* 塔中心 z=z0-1.15、塔半深 0.93（前缘约 z0-2.08）；对接格放在塔口
     外侧一格，使第一台辊道机既正对塔位 X，又不会插进塔身里。 */
  var DOCK_OFF = 2.8;
  function gridSnap() {
    var g = geom();
    if (!g) return { x: 0, z: 0 };
    /* 整个网格的坐标原点直接锚到「第一台提升机正面口」：
       X 用塔位 x、Z 用塔口外侧对接位，某个格子的中心就严格落在口子上。
       改长 / 宽 / 层数时 snap 随 g 变化，四周所有格子整体跟着平移，
       且整列格子保持等距，后续辊道机不会再与第一台错开半格。 */
    var sites = g.liftSites || [], s = sites[0];
    var ax = s ? s.x : g.x0;
    var az = s ? (s.side === 'back' ? g.z1 + DOCK_OFF : g.z0 - DOCK_OFF) : g.z0 - CLEAR;
    function mod(v) { return ((v % CELL) + CELL) % CELL; }
    return { x: mod(ax), z: mod(az), anchorX: ax, anchorZ: az };
  }
  function dockZ(site) {
    var g = geom();
    var back = site.side === 'back';
    return back ? g.z1 + DOCK_OFF : g.z0 - DOCK_OFF;
  }

  /* ---------------- 单货架专用网格（货位级） ----------------
     与主体货架共用同一套坐标基准：X 用 bayX 列心、Z 用真实货位中心，
     格子尺寸 = bayW × dp。只铺在库体投影之外，前后左右各延伸 EXT 圈，
     因此格子与货架货位严格对齐；生成时再用 snapSlotToRack 自动吸附贴合。 */
  /* 货位级网格外扩层数：主体货架两侧各留 7 层（原 2 层 + 用户要求两侧各多 5 层） */
  var SLOT_EXT = 7;
  function buildSlotGrid(g, c) {
    var arr = [], map = {};
    E.slotCells = arr; E.slotMap = map;
    E.slotBayCount = 0; E.slotRowCount = 0;
    if (!g || !c) return;
    var bw = c.bayW, dp = c.dp;
    var xs = [], zs = [], k;
    var nBay = (g.bayX || []).length;
    /* X：左侧外扩 → 主体列心 → 右侧外扩，步长严格等于 bayW */
    for (k = SLOT_EXT; k >= 1; k--) xs.push({ x: g.x0 - (k - 0.5) * bw, i: -k });
    (g.bayX || []).forEach(function (x, i) { xs.push({ x: x, i: i }); });
    for (k = 1; k <= SLOT_EXT; k++) xs.push({ x: g.x1 + (k - 0.5) * bw, i: nBay - 1 + k });
    /* Z：前侧外扩 → 主体真实货位中心 → 后侧外扩，步长严格等于 dp */
    var seenZ = {};
    (g.cells || []).forEach(function (cell) {
      if (cell.l !== 0) return;
      var key = cell.z.toFixed(3);
      if (!seenZ[key]) { seenZ[key] = 1; zs.push(cell.z); }
    });
    zs.sort(function (a, b) { return a - b; });
    var nRow = zs.length, allZ = [];
    E.slotBayCount = nBay; E.slotRowCount = nRow;
    for (k = SLOT_EXT; k >= 1; k--) allZ.push({ z: g.z0 - (k - 0.5) * dp, j: -k });
    zs.forEach(function (z, j) { allZ.push({ z: z, j: j }); });
    for (k = 1; k <= SLOT_EXT; k++) allZ.push({ z: g.z1 + (k - 0.5) * dp, j: nRow - 1 + k });
    xs.forEach(function (cx) {
      allZ.forEach(function (cz) {
        var inFoot = cx.x > g.x0 + 0.02 && cx.x < g.x1 - 0.02 &&
          cz.z > g.z0 + 0.02 && cz.z < g.z1 - 0.02;
        if (inFoot) return;                 // 主体库体内部不铺网格
        var key = 'S|' + cx.i + '|' + cz.j;
        var dx = cx.i < 0 ? -cx.i - 1 : (cx.i >= nBay ? cx.i - nBay + 1 : 99);
        var dz = cz.j < 0 ? -cz.j - 1 : (cz.j >= nRow ? cz.j - nRow + 1 : 99);
        var cell = {
          key: key, kind: 'slot', level: 0, deck: -1, ring: 0,
          x: cx.x, y: 0, z: cz.z, w: bw, d: dp,
          col: cx.i, row: cz.j,
          ringOut: Math.max(0, Math.min(SLOT_EXT, Math.min(dx, dz))),
          base: null, platform: null, platformId: null
        };
        arr.push(cell); map[key] = cell;
      });
    });
  }
  function cellOf(d) {
    /* 单货架没有「常驻锚点格」，用已选货位格的中心作为面板 / 聚焦坐标 */
    if (d && d.type === 'single') {
      var meta = d.group && d.group.userData && d.group.userData.eqMeta;
      var snapped = (meta && meta.cells && meta.cells.length) ? meta.cells : (d.singleCells || []);
      var s = E.slotMap[snapped[0]], g = geom(), cc = cfg();
      return {
        key: snapped[0] || 'S|anchor', kind: 'slot', level: 0, deck: -1,
        x: s ? s.x : (meta && isFinite(meta.x) ? meta.x : (g ? (g.x0 + g.x1) / 2 : 0)),
        y: 0,
        z: s ? s.z : (meta && isFinite(meta.z) ? meta.z : (g ? g.z0 - cc.dp : 0)),
        w: cc.bayW, d: cc.dp, base: null, platform: null, platformId: null
      };
    }
    return d ? (E.cellMap[d.cellKey] || null) : null;
  }
  /* 自动吸附贴合主体货架：把选中的货位格沿最短方向平移到紧贴库体的一圈，
     同时保留选中格之间的相对排列（不生成整排整列）。 */
  function snapSlotsToRack(keys) {
    var out = [], used = {}, nBay = E.slotBayCount || 1, nRow = E.slotRowCount || 1;
    var inner = E.slotCells.filter(function (c) { return c.ringOut === 0; });
    (keys || []).forEach(function (key) {
      var c = E.slotMap[key];
      if (!c) return;
      var want = key;
      if (c.ringOut > 0) {
        /* 按方位把外圈坐标压到紧贴主体的一圈，保留同排 / 同列的相对排列 */
        var i = clamp(c.col, -1, nBay), j = clamp(c.row, -1, nRow);
        var projected = 'S|' + i + '|' + j;
        if (E.slotMap[projected] && E.slotMap[projected].ringOut === 0) want = projected;
        else {
          var best = null, bd = 1e9;
          inner.forEach(function (q) {
            if (used[q.key]) return;
            var d = Math.hypot(q.x - c.x, q.z - c.z);
            if (d < bd) { bd = d; best = q.key; }
          });
          if (best) want = best;
        }
      }
      if (!E.slotMap[want] || used[want]) return;
      used[want] = 1; out.push(want);
    });
    return out.slice(0, 4);
  }
  function rebuildGrid() {
    var g = geom(), c = cfg();
    if (!g) return;
    var snap = gridSnap();
    var list = [], map = {}, seen = {};
    var i0 = Math.floor((g.x0 - CLEAR - snap.x) / CELL), i1 = Math.ceil((g.x1 + CLEAR - snap.x) / CELL);
    var j0 = Math.floor((g.z0 - CLEAR - snap.z) / CELL), j1 = Math.ceil((g.z1 + CLEAR - snap.z) / CELL);
    /* 十层「实心」环绕网格：只挖掉主体库体正下方的格子，其余四周全部铺满。
       旧版每圈只取矩形外框，导致提升机塔之间的那一排（贴近库体前缘）没有格子；
       现在按「是否落在库体投影内」过滤，提升机左右两侧、塔与塔之间都有网格。 */
    for (var r = 0; r < RINGS; r++) {
      var a = i0 - r, b = i1 + r, cc = j0 - r, dd = j1 + r;
      for (var i = a; i <= b; i++) {
        for (var j = cc; j <= dd; j++) {
          var key = 'G|' + i + '|' + j;
          if (seen[key]) continue;
          var x = i * CELL + snap.x, z = j * CELL + snap.z;
          var inFootprint = x > g.x0 + 0.05 && x < g.x1 - 0.05 &&
            z > g.z0 + 0.05 && z < g.z1 - 0.05;
          if (inFootprint) continue;
          seen[key] = 1;
          var rec = r === 0 && z < g.z0 && (g.liftSites || []).some(function (s) {
            return Math.abs(x - s.x) <= CELL * 0.8;
          });
          var cell = {
            key: key, kind: 'ground', level: 0, deck: -1, ring: r,
            x: x, y: 0, z: z, row: j, col: i,
            rawX: x, rawZ: z, dockLift: null, dockSide: null,
            recommend: rec, base: null, platform: null, platformId: null
          };
          list.push(cell); map[key] = cell;
        }
      }
    }
    /* 提升机正面 / 背面口「精确对接格」：
       绝不再挪用 / 移动 ring0 的规则格（那样会把提升机左右两侧的网格挖空），
       而是新增一个独立的 D| 格子，x 严格等于塔位 X、z 落在口子外侧一格。
       规则网格因此保持完整整齐，第一台辊道机放到 D 格上即可完美对准塔口。 */
    (g.liftSites || []).forEach(function (s) {
      var wantZ = dockZ(s), side = s.side === 'back' ? 'back' : 'front';
      var best = null, bd = 1e9;
      list.forEach(function (q) {
        if (q.ring !== 0 || q.dockLift) return;
        var onSide = side === 'back' ? q.z > g.z1 - 0.2 : q.z < g.z0 + 0.2;
        if (!onSide) return;
        var d = Math.hypot(q.rawX - s.x, q.rawZ - wantZ);
        if (d < bd) { bd = d; best = q; }
      });
      if (!best || bd > CELL * 2.2) return;
      best.recommend = true;                       // 规则格原样保留、只做推荐高亮
      var key = 'D|' + s.id + '|' + side;
      var dock = {
        key: key, kind: 'ground', level: 0, deck: -1, ring: 0,
        x: s.x, y: 0, z: wantZ, row: best.row, col: best.col,
        rawX: s.x, rawZ: wantZ, dockLift: s.id, dockSide: side,
        recommend: true, base: null, platform: null, platformId: null
      };
      list.push(dock); map[key] = dock;
    });
    /* 单货架专用「货位级」网格：尺寸 = bayW × dp，与主体货位同轴对齐，
       只铺在库体投影之外（前后左右各延伸数列/排），生成后自动贴合主体货架。 */
    buildSlotGrid(g, c);
    /* 每层钢平台只生成「它所在那一层」的一个立体格子 */
    E.devices.forEach(function (d) {
      if (d.type !== 'platform') return;
      var home = map[d.cellKey];
      if (!home) return;
      var deck = clamp(d.deck || 0, 0, Math.max(0, c.levels - 1));
      var key = 'P|' + d.id + '|' + deck;
      var cell = {
        key: key, kind: 'platform', level: deck + 1, deck: deck, ring: home.ring,
        x: home.x, y: c.y0 + deck * c.pitch, z: home.z,
        row: home.row, col: home.col,
        recommend: false, base: null, platform: null, platformId: d.id
      };
      list.push(cell); map[key] = cell;
    });
    /* 占用登记。提升机「接驳标记」只是库内塔体的锚点，不是独立设备：
       它不占据任何网格名额，避免货架变尺寸后残留旧格、挤占其它设备的格子。 */
    E.devices.forEach(function (d) {
      var cell = map[d.cellKey];
      if (!cell || VIRTUAL[d.type] || OVERLAY[d.type]) return;   // 点位 / 外覆设备不登记 base，不占网格名额
      if (d.type === 'platform') cell.platform = d.id;
      else cell.base = d.id;
    });
    E.cells = list; E.cellMap = map;
    refreshAllTerminalBinds();        // 设备移动 / 删除 / 新增后同步重算收发器绑定
    positionAll();
    drawGrid();
    if (E.cellPick) drawCellPick();       // 货架改尺寸后货位网格随之重排
    if (E.editMode) buildGizmo();
    if (E.selected && selectedDevice() && selectedDevice().type === 'wall') updateWallLattice();
    updateSnapButtons();
  }

  function positionAll() {
    E.devices.forEach(function (d) {
      /* 单货架用货位格的绝对坐标建模、自动贴合主体货架，
         因此 group 固定在原点，d.x/d.z 只用于面板 / 聚焦 / 快照。 */
      if (d.type === 'single') {
        d.group.position.set(0, 0, 0);
        d.group.rotation.y = 0;
        var ac = cellOf(d);
        d.level = 0; d.x = ac ? ac.x : 0; d.y = 0; d.z = ac ? ac.z : 0;
        return;
      }
      var c = E.cellMap[d.cellKey];
      if (!c) return;
      var f = d.free || { x: 0, y: 0, z: 0 };
      var px = c.x + f.x, py = c.y + f.y, pz = c.z + f.z;
      /* 提升机接驳标记必须紧跟库内塔体真实位置（而非旧锚格中心）。
         用户手动拖动换 BAY / 换侧时由 syncLiftFromCell 改写 cfg，塔体会
         跟着移动，这里始终读取最新 liftSites，因此不会再留在旧的网格上。 */
      if (d.type === 'lift') {
        var s = liftSite(d);
        if (s) { px = s.x; py = f.y; pz = s.z; }
      }
      d.group.position.set(px, py, pz);
      d.group.rotation.y = d.yaw * Math.PI / 180;
      d.level = c.level; d.x = px; d.y = py; d.z = pz;
    });
    syncLiftMarkers();
  }
  /* 货架长宽高自由变化后，按最新 liftSites 重新给每个接驳标记锚定
     「离塔体最近、且位于正确一侧」的地面格，使其不再占据无关网格。 */
  function relocateLiftMarkers() {
    var g = geom();
    if (!g) return;
    var changed = false;
    E.devices.forEach(function (d) {
      if (d.type !== 'lift') return;
      var s = liftSite(d);
      if (!s) return;
      /* 首选该提升机的精确对接格；没有则退回本侧最近地面格 */
      var best = E.cells.filter(function (c) {
        return c.kind === 'ground' && c.dockLift === s.id;
      })[0] || null, bd = best ? 0 : 1e9;
      if (!best) E.cells.forEach(function (c) {
        if (c.kind !== 'ground') return;
        var onSide = s.side === 'back' ? c.z > g.z1 + 0.2 : c.z < g.z0 - 0.2;
        if (!onSide) return;
        var dd = Math.hypot(c.x - s.x, c.z - s.z);
        if (dd < bd) { bd = dd; best = c; }
      });
      if (best && best.key !== d.cellKey) { d.cellKey = best.key; changed = true; }
    });
    if (changed) { rebuildGrid(); save(); }
  }
  /* 接驳标记不是设备实体：平时隐藏，只在选中该提升机时显示，保持塔底干净 */
  function syncLiftMarkers() {
    var sel = selectedDevice();
    E.devices.forEach(function (d) {
      if (d.type !== 'lift' || !d.group) return;
      d.group.visible = !!sel && sel.id === d.id;
    });
  }

  function canPlace(dev, c) {
    if (!dev || !c) return false;
    /* 发货器 / 收货器 / 单货架 / 提升机接驳标记都是「点位设备」；
       外形检测门是「外覆设备」：同样不占网格名额，可以套在已有输送设备外围。 */
    if (VIRTUAL[dev.type] || OVERLAY[dev.type]) return true;
    /* 钢平台不占据网格名额：它的地面锚格可以同时停一台输送设备，
       因此「下方已有输送线」也能摆钢平台；仅限制同一格最多一块钢平台。 */
    if (dev.type === 'platform') {
      if (c.kind !== 'ground') return false;
      return !c.platform || c.platform === dev.id;
    }
    /* 地面格上有钢平台时，其它设备照样可放（钢平台是额外地面，不是占位） */
    return !c.base || c.base === dev.id;
  }

  /* ---------------- 钢平台边缘吸附 / 邻边贴合 ---------------- */
  function platformDevices() {
    return E.devices.filter(function (d) { return d.type === 'platform'; });
  }
  function adjacentPlatformPairs() {
    var arr = platformDevices(), out = [];
    for (var i = 0; i < arr.length; i++) {
      for (var j = i + 1; j < arr.length; j++) {
        var a = arr[i], b = arr[j];
        if ((a.deck || 0) !== (b.deck || 0)) continue;
        var ca = E.cellMap[a.cellKey], cb = E.cellMap[b.cellKey];
        if (!ca || !cb) continue;
        var dx = Math.abs(ca.x - cb.x), dz = Math.abs(ca.z - cb.z);
        if (!((dx < 0.05 && Math.abs(dz - CELL) < 0.05) ||
              (dz < 0.05 && Math.abs(dx - CELL) < 0.05))) continue;
        out.push({ a: a.id, b: b.id, axis: dx > dz ? 'x' : 'z',
          joined: !!(a.joined && a.joined === b.id) });
      }
    }
    return out;
  }
  /* 两块相邻钢平台中间显示可点击的「贴合按钮」 */
  function updateSnapButtons() {
    if (!E.snapRoot) return;
    clearGroup(E.snapRoot);
    E.snapPicks = [];
    adjacentPlatformPairs().forEach(function (p) {
      var a = devById(p.a), b = devById(p.b);
      if (!a || !b) return;
      var ca = E.cellMap[a.cellKey], cb = E.cellMap[b.cellKey];
      if (!ca || !cb) return;
      var y = cfg().y0 + (a.deck || 0) * cfg().pitch + 0.18;
      var x = (ca.x + cb.x) / 2, z = (ca.z + cb.z) / 2;
      var col = p.joined ? 0x16a34a : 0x8b5cf6;
      var ring = new T.Mesh(new T.TorusGeometry(0.30, 0.055, 8, 24), basic(col));
      ring.rotation.x = Math.PI / 2; ring.position.set(x, y, z); ring.renderOrder = 1200;
      E.snapRoot.add(ring);
      var dot = new T.Mesh(new T.SphereGeometry(0.16, 12, 9), basic(col));
      dot.position.set(x, y + 0.03, z); dot.renderOrder = 1201;
      E.snapRoot.add(dot);
      var pr = new T.Mesh(new T.SphereGeometry(0.42, 10, 8), ghostMat());
      pr.position.set(x, y + 0.06, z); pr.renderOrder = 1190;
      pr.userData.eq = { kind: 'platSnap', a: p.a, b: p.b };
      E.snapRoot.add(pr); E.snapPicks.push(pr);
    });
    E.snapRoot.visible = true;
  }
  /* 点击贴合按钮：让两块板的邻边正好相接；再点一次取消 */
  function joinPlatforms(idA, idB) {
    var a = devById(idA), b = devById(idB);
    if (!a || !b || a.type !== 'platform' || b.type !== 'platform') return false;
    var pair = adjacentPlatformPairs().filter(function (p) {
      return (p.a === idA && p.b === idB) || (p.a === idB && p.b === idA);
    })[0];
    if (!pair) { toast('两块钢平台不相邻，无法贴合'); return false; }
    var ca = E.cellMap[a.cellKey], cb = E.cellMap[b.cellKey];
    var axis = pair.axis;
    var sign = cb[axis] > ca[axis] ? 1 : -1;
    if (a.joined === b.id) {
      a.free = null; b.free = null;
      a.joined = null; b.joined = null;
      toast('已取消钢平台邻边贴合');
    } else {
      var shift = (CELL - CELL * 0.92) / 2;      // 两块板各让出半个缝隙
      var fa = a.free || { x: 0, y: 0, z: 0 }, fb = b.free || { x: 0, y: 0, z: 0 };
      var na = { x: fa.x || 0, y: fa.y || 0, z: fa.z || 0 };
      var nb = { x: fb.x || 0, y: fb.y || 0, z: fb.z || 0 };
      na[axis] += sign * shift;
      nb[axis] -= sign * shift;
      a.free = na; b.free = nb;
      a.joined = b.id; b.joined = a.id;
      toast('两块钢平台邻边已贴合');
    }
    rebuildGrid(); save(); renderCatalog();
    if (E.selected) updateDevPanel();
    return true;
  }
  /* 边缘吸附：新放/复制的钢平台自动与相邻平台在垂直轴对齐 */
  function alignPlatformEdge(dev) {
    if (!dev || dev.type !== 'platform') return null;
    var c = E.cellMap[dev.cellKey];
    if (!c) return null;
    var best = null;
    platformDevices().forEach(function (o) {
      if (o.id === dev.id || (o.deck || 0) !== (dev.deck || 0)) return;
      var oc = E.cellMap[o.cellKey];
      if (!oc) return;
      var dx = Math.abs(c.x - oc.x), dz = Math.abs(c.z - oc.z);
      if (!((dx < 0.05 && Math.abs(dz - CELL) < 0.05) ||
            (dz < 0.05 && Math.abs(dx - CELL) < 0.05))) return;
      var axis = dx > dz ? 'z' : 'x';
      var delta = oc[axis] - c[axis];
      if (!best || Math.abs(delta) < Math.abs(best.delta)) best = { axis: axis, delta: delta, other: o.id };
    });
    if (!best || Math.abs(best.delta) < 1e-6) return null;
    var f = dev.free || { x: 0, y: 0, z: 0 };
    var nf = { x: f.x || 0, y: f.y || 0, z: f.z || 0 };
    nf[best.axis] += best.delta;
    dev.free = nf;
    return best;
  }

  function addEdges(buf, x, y, z, w, h, d, color) {
    var col = new T.Color(color), hx = w / 2, hy = h / 2, hz = d / 2;
    var v = [[-hx, -hy, -hz], [hx, -hy, -hz], [hx, hy, -hz], [-hx, hy, -hz],
             [-hx, -hy, hz], [hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz]];
    var e = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
    for (var i = 0; i < e.length; i++) {
      var a = v[e[i][0]], b = v[e[i][1]];
      buf.pos.push(x + a[0], y + a[1], z + a[2], x + b[0], y + b[1], z + b[2]);
      buf.col.push(col.r, col.g, col.b, col.r, col.g, col.b);
    }
  }
  function addRect(buf, x, y, z, w, d, color) {
    var col = new T.Color(color), hx = w / 2, hz = d / 2;
    var p = [[x - hx, y, z - hz], [x + hx, y, z - hz], [x + hx, y, z + hz], [x - hx, y, z + hz]];
    for (var i = 0; i < 4; i++) {
      var a = p[i], b = p[(i + 1) % 4];
      buf.pos.push(a[0], a[1], a[2], b[0], b[1], b[2]);
      buf.col.push(col.r, col.g, col.b, col.r, col.g, col.b);
    }
  }

  function drawGrid() {
    var gr = E.gridRoot;
    clearGroup(gr);
    E.gridPicks = [];
    var buf = { pos: [], col: [] };
    var sel = selectedDevice(), c = cfg();
    E.cells.forEach(function (cell) {
      var isSel = sel && sel.cellKey === cell.key;
      var occ = cell.kind === 'ground' ? (!!cell.base || !!cell.platform) : !!cell.base;
      var color = isSel ? 0x10b981 : (occ ? 0xf59e0b : (cell.dockLift ? 0x16a34a : (cell.recommend ? 0x22c55e : 0x38bdf8)));
      if (cell.kind === 'ground') {
        addRect(buf, cell.x, 0.025, cell.z, CELL * 0.92, CELL * 0.92, color);
        /* 提升机正面口对接格：内圈加深，明确「第一台设备放这里就对准口子」 */
        if (cell.dockLift) addRect(buf, cell.x, 0.033, cell.z, CELL * 0.66, CELL * 0.66, 0x0f7a3d);
        if (cell.platform) addRect(buf, cell.x, 0.032, cell.z, CELL * 0.72, CELL * 0.72, 0x8b5cf6);
        var pr = new T.Mesh(E.groundProxyGeo, ghostMat());
        pr.position.set(cell.x, 0.04, cell.z);
        pr.userData.eq = { kind: 'cell', key: cell.key };
        gr.add(pr); E.gridPicks.push(pr);
      } else {
        var hh = Math.min(c.pitch * 0.72, 0.95);
        addEdges(buf, cell.x, cell.y + hh / 2, cell.z, CELL * 0.86, hh, CELL * 0.86, color);
        var pb = new T.Mesh(new T.BoxGeometry(CELL * 0.86, hh, CELL * 0.86), ghostMat());
        pb.position.set(cell.x, cell.y + hh / 2, cell.z);
        pb.userData.eq = { kind: 'cell', key: cell.key };
        gr.add(pb); E.gridPicks.push(pb);
      }
    });
    var lg = new T.BufferGeometry();
    lg.setAttribute('position', new T.Float32BufferAttribute(buf.pos, 3));
    lg.setAttribute('color', new T.Float32BufferAttribute(buf.col, 3));
    var lines = new T.LineSegments(lg, new T.LineBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.68, depthTest: true, depthWrite: false
    }));
    lines.renderOrder = 860; lines.frustumCulled = false;
    gr.add(lines);
    E.hover = new T.Mesh(
      new T.PlaneGeometry(CELL * 0.86, CELL * 0.86),
      new T.MeshBasicMaterial({ color: 0x18b47f, transparent: true, opacity: 0.24, depthTest: false, depthWrite: false, side: T.DoubleSide, toneMapped: false })
    );
    E.hover.rotation.x = -Math.PI / 2;
    E.hover.renderOrder = 861; E.hover.visible = false;
    gr.add(E.hover);
    gr.visible = E.pickGrid || (E.editMode && !!E.selected && !(sel && sel.type === 'wall'));
  }
  /* 路线设计采点：让四周移动网格常显，供「空白网格」节点点选 */
  function setPickGrid(on) {
    E.pickGrid = !!on;
    var sel = selectedDevice();
    if (E.gridRoot) {
      E.gridRoot.visible = E.pickGrid ||
        (E.editMode && !!E.selected && !(sel && sel.type === 'wall'));
    }
    return E.pickGrid;
  }
  function setHoverCell(c) {
    if (!E.hover) return;
    if (!c) { E.hover.visible = false; return; }
    E.hover.visible = true;
    E.hover.position.set(c.x, (c.kind === 'ground' ? 0.05 : c.y + 0.05), c.z);
  }
  function cellLabel(cell) {
    if (!cell) return '—';
    if (cell.kind === 'slot') return '货位级网格 · 与主体货位对齐（自动贴合）';
    if (cell.kind === 'ground') {
      return cell.dockLift
        ? cell.dockLift + ' ' + (cell.dockSide === 'back' ? '背面' : '正面') + '口 · 精确对接格'
        : '地面第 ' + (cell.ring + 1) + ' 层 · X' + cell.col + ' / Z' + cell.row;
    }
    var p = devById(cell.platformId);
    return '钢平台 ' + (p ? p.code : '') + ' · 第 ' + (cell.deck + 1) +
      ' 层（货位高度 ' + cell.y.toFixed(2) + ' m）';
  }
  /* 新增设备以「最近的提升机」为基准，直线距离固定 5 层网格即可。
     不再随最外侧设备递增，避免越加越远；钢平台/墙面同样适用此基准。 */
  var LIFT_DIST_CELLS = 5;
  function liftAnchorCells() {
    /* 优先用「精确对接格」当基准：新增设备距提升机 5 层网格从真实口子算起 */
    var out = E.cells.filter(function (c) { return c.kind === 'ground' && c.dockLift; });
    if (out.length) return out;
    E.devices.forEach(function (d) {
      if (d.type !== 'lift') return;
      var c = E.cellMap[d.cellKey];
      if (c) out.push(c);
    });
    if (out.length) return out;
    /* 兜底：用几何里的提升机塔中心换算到最近地面格 */
    var g = geom();
    (g.liftSites || []).forEach(function (s) {
      var best = null, bd = 1e9;
      E.cells.forEach(function (c) {
        if (c.kind !== 'ground') return;
        var d = Math.hypot(c.x - s.x, c.z - s.z);
        if (d < bd) { bd = d; best = c; }
      });
      if (best) out.push(best);
    });
    return out;
  }
  function preferredRing() { return LIFT_DIST_CELLS; }
  function findFreeCellKey(type, opt) {
    opt = opt || {};
    var fake = { type: type, id: opt.id || '__probe__' };
    var anchors = liftAnchorCells();
    var exclude = opt.exclude || null;    // 点位设备：避开其它点位已占的格，防叠放
    var list = E.cells.filter(function (c) {
      return c.kind === 'ground' && !(exclude && exclude[c.key]);
    });
    list.sort(function (a, b) {
      function score(c) {
        var s;
        if (anchors.length) {
          var best = 1e9;
          anchors.forEach(function (q) {
            var d = Math.hypot(c.x - q.x, c.z - q.z) / CELL;
            if (d < best) best = d;
          });
          s = Math.abs(best - LIFT_DIST_CELLS) * 8;
        } else {
          s = Math.abs(c.ring - LIFT_DIST_CELLS) * 6;
        }
        s += c.ring * 0.02 + Math.abs(c.x) * 0.008;
        if (opt.x != null) s += Math.hypot(c.x - opt.x, c.z - opt.z) * 0.12;
        return s;
      }
      return score(a) - score(b);
    });
    for (var i = 0; i < list.length; i++) if (canPlace(fake, list[i])) return list[i].key;
    return null;
  }
  /* 外形检测门优先落在「已有辊道机 / 链条机、且还没装门」的格子 */
  function findGateCellKey() {
    var taken = {};
    E.devices.forEach(function (d) { if (d.type === 'gate') taken[d.cellKey] = 1; });
    var hosts = E.devices.filter(function (d) {
      return (d.type === 'roller' || d.type === 'chain') && !taken[d.cellKey];
    });
    var best = null, bd = 1e9;
    hosts.forEach(function (h) {
      var c = E.cellMap[h.cellKey];
      if (!c || c.kind !== 'ground') return;
      var s = (geom().liftSites || [])[0];
      var d = s ? Math.hypot(c.x - s.x, c.z - s.z) : c.ring;
      if (d < bd) { bd = d; best = c.key; }
    });
    return best;
  }
  /* 拆叠盘机是输送线上的工位：优先落在某台辊道 / 链条机旁的空格，
     这样遗留母托盘和分离出的母托盘都有真实的输送线可走，不会凭空飞过去。 */
  function findDestackerCellKey() {
    var taken = {};
    E.devices.forEach(function (d) { if (d.type === 'destacker') taken[d.cellKey] = 1; });
    var hosts = E.devices.filter(function (d) {
      return ['roller', 'chain', 'transfer'].indexOf(d.type) >= 0 && !taken[d.cellKey];
    });
    var best = null, bd = 1e9;
    hosts.forEach(function (h) {
      var hc = E.cellMap[h.cellKey];
      if (!hc) return;
      E.cells.forEach(function (c) {
        if (c.kind !== 'ground' || c.base || taken[c.key]) return;
        var d = Math.hypot(c.x - hc.x, c.z - hc.z);
        if (d > 0.1 && d <= CELL * 1.05 && d < bd) { bd = d; best = c.key; }
      });
    });
    return best;
  }
  function ensureValidCells() {
    var changed = false;
    E.devices.forEach(function (d) {
      if (E.cellMap[d.cellKey]) return;
      var key = findFreeCellKey(d.type, { id: d.id, x: d.x, z: d.z });
      if (key) { d.cellKey = key; d.level = 0; changed = true; }
    });
    if (changed) { rebuildGrid(); save(); }
  }
  /* 提升机接驳标记：可在货架前端（-Z）或对面（+Z），按 side 取该侧最近的地面格 */
  function frontCellKeyFor(x, side) {
    var g = geom();
    if (!g) return null;
    var back = side === 'back';
    /* 有对应提升机的精确对接格时直接返回，保证标记与塔位口严格对齐 */
    var dock = E.cells.filter(function (c) {
      return c.kind === 'ground' && c.dockLift && c.dockSide === (back ? 'back' : 'front');
    }).sort(function (a, b) { return Math.abs(a.x - x) - Math.abs(b.x - x); })[0];
    if (dock && Math.abs(dock.x - x) < CELL * 1.2) return dock.key;
    var cands = E.cells.filter(function (c) {
      return c.kind === 'ground' && c.ring === 0 &&
        (back ? c.z > g.z1 + 0.2 : c.z < g.z0 - 0.2);
    });
    cands.sort(function (a, b) { return Math.abs(a.x - x) - Math.abs(b.x - x); });
    return cands.length ? cands[0].key : null;
  }
  function sideOfCell(cell) {
    var g = geom();
    if (!g || !cell) return 'front';
    return cell.z > g.z1 + 0.2 ? 'back' : (cell.z < g.z0 - 0.2 ? 'front' : null);
  }
  function cellForKey(key) { return E.cellMap[key] || null; }
  function freeCellNearBay(bay, side, ring) {
    var g = geom(), c = cfg();
    var wantX = g.x0 + (bay + 0.5) * c.bayW;
    var cands = E.cells.filter(function (q) {
      if (q.kind !== 'ground' || q.base || q.platform) return false;
      if (ring != null && q.ring !== ring) return false;
      return sideOfCell(q) === side;   // 必须真的落在 front / back 侧
    });
    cands.sort(function (a, b) { return Math.abs(a.x - wantX) - Math.abs(b.x - wantX); });
    return cands[0] || null;
  }
  function bayFromCell(cell) {
    var g = geom(), c = cfg();
    if (!g || !cell) return 0;
    return clamp(Math.round((cell.x - g.x0) / c.bayW - 0.5), 0, c.bays - 1);
  }
  function currentLiftCols() {
    var c = cfg(), g = geom();
    if (c.liftCols) return c.liftCols.map(function (o) { return { id: o.id, i: o.i }; });
    return (g.liftSites || []).map(function (s) { return { id: s.id, i: s.i }; });
  }

  /* ---------------- 生命周期 / 持久化 ---------------- */
  function nextCode(type) {
    var n = (E.counters[type] || 0) + 1;
    E.counters[type] = n;
    return TYPES[type].code + '-' + pad2(n);
  }
  function save() {
    try {
      global.localStorage && global.localStorage.setItem(STORE, JSON.stringify({
        seq: E.seq, hideTerminals: !!E.hideTerminals,
        devices: E.devices.map(function (d) {
          return {
            id: d.id, type: d.type, code: d.code, cellKey: d.cellKey, yaw: d.yaw,
            demo: !!d.demo, liftId: d.liftId || null, deck: d.deck || 0,
            solid: d.solid !== false, free: d.free || null, size: d.size || null,
            joined: d.joined || null, template: !!d.template,
            /* 发货器 / 收货器 / 单货架 */
            bindId: d.bindId || null, cargoKind: d.cargoKind || null,
            cargoClass: d.cargoClass || null, rate: d.rate == null ? 2.5 : d.rate,
            singleCells: d.singleCells ? d.singleCells.slice() : [],
            singleLevels: d.singleLevels || mainLevels(), singlePitch: d.singlePitch || null,
            singleCargo: d.singleCargo !== false, singleBuilt: !!d.singleBuilt,
            gateColor: d.gateColor === 'red' ? 'red' : 'green'
          };
        })
      }));
    } catch (e) { /* ignore */ }
  }
  function load() {
    E.devices = []; E.counters = {}; E.seq = 1;
    try {
      var raw = global.localStorage && global.localStorage.getItem(STORE);
      if (!raw) return;
      var o = JSON.parse(raw);
      if (!o || !Array.isArray(o.devices)) return;
      E.hideTerminals = !!o.hideTerminals;
      o.devices.forEach(function (s) {
        if (!s || !TYPES[s.type] || !s.cellKey) return;
        var d = {
          id: s.id || ('eq' + E.seq), type: s.type, code: s.code || nextCode(s.type), name: '',
          cellKey: s.cellKey, yaw: clamp(Number(s.yaw) || 0, -360, 360),
          demo: !!s.demo, liftId: s.liftId || null,
          deck: clamp(Number(s.deck) || 0, 0, 11), solid: s.solid !== false,
          free: s.free || null, size: Array.isArray(s.size) ? s.size.slice(0, 3) : null,
          joined: s.joined || null, template: !!s.template,
          bindId: s.bindId || null, cargoKind: s.cargoKind || null,
          cargoClass: s.cargoClass || null, rate: clamp(Number(s.rate) || 2.5, 0.4, 12),
          singleCells: Array.isArray(s.singleCells) ? s.singleCells.slice(0, 4) : [],
          singleLevels: clamp(Number(s.singleLevels) || mainLevels(), 1, 12),
          singlePitch: s.singlePitch || null,
          singleCargo: s.singleCargo !== false, singleBuilt: !!s.singleBuilt,
          gateColor: s.gateColor === 'red' ? 'red' : 'green',
          gateUntil: 0, gateInside: false,
          group: null, anim: null, dims: [1.6, 1, 1.4]
        };
        d.name = d.type === 'lift' && d.liftId ? '提升机 ' + d.liftId : TYPES[d.type].n + ' ' + d.code;
        E.devices.push(d);
        E.seq = Math.max(E.seq, (parseInt(String(d.id).replace(/\D/g, ''), 10) || 0) + 1);
      });
    } catch (e) { E.devices = []; }
    E.devices.forEach(function (d) {
      if (d.type === 'lift') return;
      var m = /-(\d+)$/.exec(d.code);
      E.counters[d.type] = Math.max(E.counters[d.type] || 0, m ? parseInt(m[1], 10) : 1);
    });
  }
  function rebuildDevices() {
    if (!E.root) return;
    clearGroup(E.root);
    E.devices.forEach(function (d) {
      var built = buildDevice(d);
      d.group = built.group; d.anim = built.anim; d.dims = built.dims;
      E.root.add(d.group);
    });
    rebuildGrid();
    /* 单货架按货位格的绝对坐标建模：网格 / 货架尺寸就绪后，
       所有单货架（含未确认的实时预览）都要按新坐标重建一次。 */
    E.devices.forEach(function (d) {
      if (d.type === 'single') rebuildOne(d);
    });
    applyVisibility();
  }
  /* 提升机设备与库内 liftSites 一一对应（同一台设备，不重复建塔） */
  function syncLiftDevices() {
    var g = geom();
    if (!g) return;
    var ids = {};
    (g.liftSites || []).forEach(function (s) { ids[s.id] = s; });
    var stale = E.devices.filter(function (d) { return d.type === 'lift' && !ids[d.liftId]; });
    stale.forEach(function (d) { E.root.remove(d.group); disposeGroup(d.group); });
    if (stale.length) E.devices = E.devices.filter(function (d) { return !(d.type === 'lift' && !ids[d.liftId]); });
    var added = false;
    (g.liftSites || []).forEach(function (s) {
      if (devByLiftId(s.id)) return;
      var key = frontCellKeyFor(s.x, s.side) || findFreeCellKey('lift', { x: s.x, z: g.z0 - 2 });
      if (!key) return;
      var d = {
        id: 'eq' + (E.seq++), type: 'lift', code: s.id, name: s.name,
        liftId: s.id, cellKey: key, yaw: 0, demo: false, deck: 0, solid: true,
        free: null, size: null, group: null, anim: null, dims: [1.82, 3, 1.86]
      };
      var built = buildDevice(d);
      d.group = built.group; d.anim = built.anim; d.dims = built.dims;
      E.root.add(d.group); E.devices.push(d); added = true;
    });
    if (added || stale.length) { rebuildGrid(); save(); }
  }

  /* 摆放后取景：网格围绕四周，镜头略拉远但仍能看清设备 */
  function reveal() {
    var g = geom(), S = WAP.scene.S;
    if (!g) return;
    S.ctrl.target.set(0, Math.max(2.2, g.top * 0.34), g.z0 - 2.0);
    S.ctrl.radius = clamp(Math.max(g.len, g.tot + 12) * 1.34, 20, 70);
    S.ctrl.theta = Math.PI - 0.78;
    S.ctrl.phi = 1.02;
    WAP.scene.applyCamera();
  }

  function add(type, opt) {
    if (!TYPES[type]) return null;
    if (type === 'lift') return addLift();
    opt = opt || {};
    var g = geom();
    /* 点位设备不占网格名额，但连续新增时仍要避开已有点位格，避免叠在同一点 */
    var exclude = null;
    if (VIRTUAL[type] && type !== 'lift') {
      exclude = {};
      E.devices.forEach(function (q) { if (VIRTUAL[q.type]) exclude[q.cellKey] = 1; });
    }
    /* 单货架不类比其它设备：不预先占用任何远处格子、不显示锚点模型，
       创建后直接进入货位网格选格，由用户自选自多 4 格。 */
    var isSingle = type === 'single';
    /* 外形检测门优先套到已有辊道机 / 链条机所在格，其次才找空格 */
    var key = isSingle ? ('S|draft|' + E.seq)
      : (opt.key || (type === 'gate' ? findGateCellKey() : null) ||
         (type === 'destacker' ? findDestackerCellKey() : null) ||
         findFreeCellKey(type, { x: 0, z: g.z0 - CELL * 1.5, exclude: exclude }));
    var cell = isSingle ? cellOf({ type: 'single', cellKey: key, singleCells: [] }) : E.cellMap[key];
    var probe = { id: '__new__', type: type };
    if (!cell || !canPlace(probe, cell)) { toast('当前没有可用的移动格子'); return null; }
    var d = {
      id: 'eq' + (E.seq++), type: type, code: nextCode(type), name: '',
      cellKey: key, yaw: clamp(Number(opt.yaw) || 0, -360, 360),
      demo: false, liftId: null, deck: 0, solid: true,
      free: null, size: null, group: null, anim: null, dims: [1.6, 1, 1.4],
      template: !!opt.template,
      bindId: opt.bindId || null,
      cargoKind: opt.cargoKind || cfg().cargoType || 'carton',
      cargoClass: opt.cargoClass || cfg().cargoClass || 'single',
      rate: clamp(Number(opt.rate) || 2.5, 0.4, 12),
      singleCells: [], singleLevels: opt.singleLevels || mainLevels(),
      singlePitch: opt.singlePitch || null,
      singleCargo: opt.singleCargo !== false, singleBuilt: false,
      gateColor: opt.gateColor === 'red' ? 'red' : 'green',
      gateUntil: 0, gateInside: false
    };
    d.name = TYPES[type].n + ' ' + d.code;
    /* 单货架：零预选格，没有「取消不掉的远处格子」 */
    var built = buildDevice(d);
    d.group = built.group; d.anim = built.anim; d.dims = built.dims;
    E.root.add(d.group); E.devices.push(d);
    applyVisibility();
    if (type === 'platform') alignPlatformEdge(d);
    if (type === 'wall') snapWallEdges(d);
    rebuildGrid(); save();
    /* quiet：模板流程批量搭线时不抢镜头、不改选中态 */
    if (!opt.quiet) { reveal(); select(d.id, true); }
    if (type === 'single') {
      startCellPick(d.id);
      if (!opt.quiet) toast('单货架：在货位网格上自选 1~4 格（可随时取消），调参数即时预览，最后确认生成');
    }
    renderCatalog();
    if (!opt.quiet && type !== 'single') toast('已摆放 ' + d.name + ' · ' + cellLabel(cellOf(d)));
    return d;
  }

  function addLift(opt) {
    opt = opt || {};
    var c = cfg(), g = geom();
    var cols = currentLiftCols();
    var used = cols.map(function (o) { return o.i; });
    var bi = opt.bay;
    if (bi == null) {
      bi = -1;
      for (var k = 0; k < c.bays; k++) if (used.indexOf(k) < 0) { bi = k; break; }
    }
    if (bi == null || bi < 0 || used.indexOf(bi) >= 0) {
      toast('没有空闲的子通道口可新增提升机'); return null;
    }
    var n = 1;
    while (cols.some(function (o) { return o.id === 'LF-' + pad2(n); })) n++;
    var id = 'LF-' + pad2(n);
    var side = opt.side === 'back' ? 'back' : 'front';
    cols.push({ id: id, i: bi });
    c.liftN = cols.length;
    c.liftCols = cols;
    c.liftCfg = c.liftCfg || {};
    c.liftCfg[id] = { lv: c.levels, boost: 0, matched: false, side: side };
    WAP.core.save(c);
    WAP.app.commit(true);      // 重建货架 / 提升机塔，sim 运动逻辑不变
    var d = devByLiftId(id);
    if (d) {
      if (opt.cellKey && E.cellMap[opt.cellKey]) {
        d.cellKey = opt.cellKey;
        rebuildGrid(); save();
      }
      select(d.id, true); renderCatalog();
      toast('新增 ' + id + '（' + (side === 'back' ? '货架对面' : '货架前端') + '）· 靠拢子通道口后可匹配层间输送线');
    }
    return d;
  }

  /* 复制：普通设备生成到当前格「前方」的相邻空格；
     提升机例外——复制到同排（同 ring）任意空闲子通道口的前方。 */
  function frontCellFrom(src, dev) {
    var m = /^G\|(-?\d+)\|(-?\d+)$/.exec(src.key);
    if (m) {
      var i = parseInt(m[1], 10), j = parseInt(m[2], 10);
      for (var step = 1; step <= RINGS; step++) {
        var a = E.cellMap['G|' + i + '|' + (j - step)];
        if (a && canPlace(dev, a)) return a;
        var b = E.cellMap['G|' + i + '|' + (j + step)];
        if (b && canPlace(dev, b)) return b;
      }
    }
    var key = findFreeCellKey(dev.type, { x: src.x, z: src.z });
    return key ? E.cellMap[key] : null;
  }
  function copyLiftDevice(d) {
    var c = cfg(), cf = liftCfg(d);
    var cols = currentLiftCols(), used = cols.map(function (o) { return o.i; });
    var bi = -1;
    for (var k = 0; k < c.bays; k++) if (used.indexOf(k) < 0) { bi = k; break; }
    if (bi < 0) { toast('没有空闲子通道口可复制提升机'); return null; }
    var side = cf.side || 'front', src = cellOf(d);
    var dest = freeCellNearBay(bi, side, src ? src.ring : 0) || freeCellNearBay(bi, side, 0);
    return addLift({ bay: bi, side: side, cellKey: dest ? dest.key : null });
  }
  function copyDevice() {
    var d = selectedDevice();
    if (!d) { toast('请先选中一台设备'); return null; }
    if (d.type === 'lift') return copyLiftDevice(d);
    /* 单货架：复制一份同款，选区整体右移一列（格子存在时），避免与原货架重叠 */
    if (d.type === 'single') {
      var shifted = (d.singleCells || []).map(function (k) {
        var m = /^S\|(-?\d+)\|(-?\d+)$/.exec(k);
        if (!m) return k;
        var cand = 'S|' + (parseInt(m[1], 10) + 1) + '|' + m[2];
        return E.slotMap[cand] ? cand : k;
      });
      var sn = {
        id: 'eq' + (E.seq++), type: 'single', code: nextCode('single'), name: '',
        cellKey: 'S|draft|' + E.seq, yaw: d.yaw, liftId: null, deck: 0,
        solid: true, free: null, size: null,
        bindId: null, cargoKind: d.cargoKind || null, cargoClass: d.cargoClass || null,
        rate: 2.5, singleCells: shifted.slice(), singleLevels: d.singleLevels || mainLevels(),
        singlePitch: d.singlePitch || null, singleCargo: d.singleCargo !== false,
        singleBuilt: !!d.singleBuilt, gateColor: 'green',
        group: null, anim: null, dims: [1.6, 1, 1.4]
      };
      sn.name = TYPES.single.n + ' ' + sn.code;
      var sb = buildDevice(sn);
      sn.group = sb.group; sn.anim = sb.anim; sn.dims = sb.dims;
      E.root.add(sn.group); E.devices.push(sn);
      applyVisibility(); rebuildGrid(); save();
      select(sn.id, true); renderCatalog();
      toast('已复制 ' + d.name + ' → ' + sn.name);
      return sn;
    }
    var src = cellOf(d);
    if (!src) return null;
    var target = frontCellFrom(src, d);
    if (!target) { toast('前方没有空闲的移动格子'); return null; }
    var n = {
      id: 'eq' + (E.seq++), type: d.type, code: nextCode(d.type), name: '',
      cellKey: target.key, yaw: d.yaw, liftId: null,
      deck: d.deck || 0, solid: d.solid !== false,
      free: d.free ? { x: d.free.x, y: d.free.y, z: d.free.z } : null,
      size: d.size ? d.size.slice() : null,
      bindId: d.bindId || null, cargoKind: d.cargoKind || null,
      cargoClass: d.cargoClass || null, rate: d.rate || 2.5,
      singleCells: (d.singleCells || []).slice(), singleLevels: d.singleLevels || mainLevels(),
      singlePitch: d.singlePitch || null, singleCargo: d.singleCargo !== false,
      singleBuilt: !!d.singleBuilt,
      gateColor: d.gateColor === 'red' ? 'red' : 'green',
      group: null, anim: null, dims: [1.6, 1, 1.4]
    };
    n.name = TYPES[d.type].n + ' ' + n.code;
    var built = buildDevice(n);
    n.group = built.group; n.anim = built.anim; n.dims = built.dims;
    E.root.add(n.group); E.devices.push(n);
    if (n.type === 'platform') alignPlatformEdge(n);
    if (n.type === 'wall') snapWallEdges(n);
    rebuildGrid(); save();
    select(n.id, true); renderCatalog();
    toast('已复制 ' + d.name + ' → ' + n.name + ' · ' + cellLabel(cellOf(n)));
    return n;
  }

  function remove(id) {
    var d = devById(id);
    if (!d) return;
    if (E.cellPick === id) stopCellPick();
    if (d.type === 'lift') {
      var c = cfg();
      var cols = currentLiftCols().filter(function (o) { return o.id !== d.liftId; });
      if (cols.length < 1) { toast('至少需要保留一台提升机'); return; }
      c.liftN = cols.length; c.liftCols = cols;
      if (c.liftCfg) delete c.liftCfg[d.liftId];
      E.root.remove(d.group); disposeGroup(d.group);
      E.devices = E.devices.filter(function (o) { return o.id !== id; });
      if (E.selected === id) deselect();
      WAP.core.save(c);
      WAP.app.commit(true);
      renderCatalog();
      toast('已删除 ' + d.name + '（库内提升机同步移除）');
      return;
    }
    if (d.type === 'platform') {
      /* 平台上的设备回落到地面空格子 */
      E.devices.forEach(function (o) {
        if (o.id === id) return;
        var oc = E.cellMap[o.cellKey];
        if (oc && oc.platformId === id) {
          var key = findFreeCellKey(o.type, { id: o.id, x: o.x, z: o.z });
          if (key) { o.cellKey = key; o.level = 0; }
        }
      });
    }
    E.root.remove(d.group); disposeGroup(d.group);
    E.devices = E.devices.filter(function (o) { return o.id !== id; });
    if (E.selected === id) deselect();
    rebuildGrid(); save(); renderCatalog();
    toast('已删除 ' + d.name);
  }

  function refreshAfterChange() {
    rebuildGrid(); save(); updateMark();
    if (selectedDevice() && selectedDevice().type === 'wall') updateWallLattice();
    updateDevPanel(); renderCatalog();
    /* 设备移动 / 复制 / 删除后，路线点位与线路规划跟随更新 */
    if (WAP.routes && WAP.routes.rebind) WAP.routes.rebind();
  }
  /* 发货器 / 收货器的绑定完全由「放置到哪个网格」决定：
     落到已有设备的格子上 → 自动绑定该设备；落到空格 → 解除绑定。
     点位设备不占网格名额，所以可以叠放在输送设备所在格。 */
  function autoBindTerminal(dev, cell) {
    if (!dev || (dev.type !== 'emitter' && dev.type !== 'receiver')) return null;
    var target = null;
    if (cell && cell.base) {
      var owner = devById(cell.base);
      if (owner && owner.id !== dev.id && !VIRTUAL[owner.type]) target = owner;
    }
    dev.bindId = target ? target.id : null;
    return target;
  }
  function refreshAllTerminalBinds() {
    E.devices.forEach(function (d) {
      if (d.type === 'emitter' || d.type === 'receiver') autoBindTerminal(d, E.cellMap[d.cellKey]);
    });
  }
  function applyCell(dev, c) {
    dev.cellKey = c.key;
    dev.level = c.level;
    dev.group.position.set(c.x, c.y, c.z);
    dev.x = c.x; dev.y = c.y; dev.z = c.z;
    autoBindTerminal(dev, c);
  }
  /* 提升机移动到新格子后：同步 BAY 列、前端/对面侧，并让离开子通道口的
     提升机失去「已匹配」状态 —— 对应层间输送线随之消失。 */
  function syncLiftFromCell(dev, cell) {
    if (!dev || dev.type !== 'lift' || !cell || cell.kind !== 'ground') return false;
    var c = cfg(), cf = liftCfg(dev), changed = false;
    var side = sideOfCell(cell);
    var near = liftNearMouthCell(cell);
    if (!near && cf.matched !== false) { cf.matched = false; changed = true; }
    if (side && cf.side !== side) { cf.side = side; changed = true; }
    var bi = bayFromCell(cell), cols = currentLiftCols();
    var hit = cols.filter(function (o) { return o.id === dev.liftId; })[0];
    if (hit && hit.i !== bi && !cols.some(function (o) { return o.id !== dev.liftId && o.i === bi; })) {
      hit.i = bi; c.liftCols = cols; changed = true;
    }
    if (changed) { WAP.core.save(c); WAP.app.commit(true); }
    return changed;
  }
  function updateLiftColumnFromCell(dev, cell) { return syncLiftFromCell(dev, cell); }
  /* 提升机切到货架对面 / 前端：换到另一侧同 BAY 的空格，并需重新匹配输送线 */
  function toggleLiftSide() {
    var d = selectedDevice();
    if (!d || d.type !== 'lift') return false;
    var g = geom(), cf = liftCfg(d);
    var next = cf.side === 'back' ? 'front' : 'back';
    var cell = freeCellNearBay(bayFromCell(cellOf(d)), next, 0);
    if (!cell) { toast('货架' + (next === 'back' ? '对面' : '前端') + '没有空闲接驳格'); return false; }
    cf.matched = false;                 // 换侧后原层间输送线立即消失
    cf.side = next;
    WAP.app.commit(true);               // 先重建库体，让原输送线消失
    placeOnCell(cell.key);              // 再把接驳标记移到另一侧
    select(d.id, true);
    toast(d.name + ' 已移到货架' + (next === 'back' ? '对面' : '前端') + ' · 请重新匹配层间输送线');
    return true;
  }

  /* ---------------- 选中 / 编辑 / 控制器 ---------------- */
  function select(id, keepCtx) {
    var d = devById(id);
    if (!d) return;
    if (E.cellPick && E.cellPick !== id) stopCellPick();
    E.selected = id;
    var sel = WAP.state.selection;
    sel.phase = 0; sel.rack = false; sel.crystalHidden = false; sel.cell = null; sel.part = 'equipment';
    WAP.rack.applyView();
    if (!keepCtx) WAP.ctx.close();
    WAP.ui.hideCell();
    if (WAP.ui.showDeviceDock) WAP.ui.showDeviceDock(true);
    $('sbSel').textContent = '已选中：' + d.name;
    $('viewBadgeTxt').textContent = '输送设备 · ' + d.name;
    E.wallRoot.visible = d.type === 'wall';
    if (d.type === 'wall') {
      E.editMode = false; E.gridRoot.visible = false; E.gizmoRoot.visible = false;
      clearGroup(E.gizmoRoot); E.gizmoPicks = [];
      updateWallLattice();
      E.markRoot.visible = false;
    } else {
      clearGroup(E.wallRoot); E.wallPicks = [];
      updateMark();
    }
    syncLiftMarkers();
    updateDevPanel(); renderCatalog();
  }
  function selectLift(liftId) {
    var d = devByLiftId(liftId);
    if (!d) return false;
    WAP.ctx.close();
    select(d.id, true);
    return true;
  }
  function deselect() {
    E.selected = null; E.editMode = false; E.drag = null;
    stopCellPick();
    E.gridRoot.visible = false; E.gizmoRoot.visible = false;
    E.markRoot.visible = false; E.wallRoot.visible = false;
    clearGroup(E.gizmoRoot); clearGroup(E.wallRoot);
    E.gizmoPicks = []; E.wallPicks = [];
    syncLiftMarkers();
    if (WAP.ui.showDeviceDock) WAP.ui.showDeviceDock(false);
    renderCatalog();
  }
  function edit(on) {
    var d = selectedDevice();
    if (!d) { toast('请先点选一台设备'); return; }
    if (d.type === 'wall') { toast('墙面请用独立晶格子直接拖拽 / 拉伸'); return; }
    E.editMode = !!on;
    if (on) WAP.ctx.close();
    E.gridRoot.visible = E.editMode;
    E.gizmoRoot.visible = E.editMode;
    rebuildGrid();
    updateDevPanel();
    toast(E.editMode
      ? '编辑模式 · 拖拽设备或箭头吸附到移动格子' + (hasPlatform() ? ' · 上下箭头切换钢平台层' : '')
      : '已退出编辑模式');
  }

  function updateMark() {
    var gr = E.markRoot;
    clearGroup(gr);
    var d = selectedDevice(), c = cellOf(d);
    if (!d || !c || d.type === 'wall') { gr.visible = false; return; }
    var x = c.x, z = c.z, y = c.y, w = d.dims[0] + 0.16, h = d.dims[1] + 0.16, dd = d.dims[2] + 0.16;
    if (d.type === 'lift') {
      var s = liftSite(d);
      if (s) { x = s.x; z = s.z; y = 0; }
    } else if (d.type === 'platform') {
      y = cfg().y0 + clamp(d.deck || 0, 0, cfg().levels - 1) * cfg().pitch;
      h = 0.34;
    } else if (d.free) {
      x += d.free.x; z += d.free.z;
    }
    var edge = new T.LineSegments(new T.EdgesGeometry(new T.BoxGeometry(w, h, dd)),
      new T.LineBasicMaterial({ color: 0x4f46e5, transparent: true, opacity: 0.95, depthTest: false, depthWrite: false }));
    edge.position.set(x, y + h / 2 - 0.08, z);
    edge.renderOrder = 970;
    gr.add(edge);
    gr.visible = true;
  }

  /* 墙：选中线框（尺寸改由控制面板滑动轴控制，不再有 3D 拉伸控制点） */
  function wallBox(d) {
    var c = cellOf(d);
    if (!c) return null;
    var f = d.free || { x: 0, y: 0, z: 0 };
    var size = d.size || [CELL * 0.9, 2.4, 0.12];
    var turned = Math.abs(Math.round(d.yaw / 90) % 2) === 1;   // 90°/270° 时长宽互换
    var ew = turned ? size[2] : size[0];
    var ed = turned ? size[0] : size[2];
    var x = c.x + f.x, z = c.z + f.z;
    return { minX: x - ew / 2, maxX: x + ew / 2, minZ: z - ed / 2, maxZ: z + ed / 2,
      cx: x, cz: z, w: ew, d: ed, h: size[1] };
  }
  function updateWallLattice() {
    var gr = E.wallRoot;
    clearGroup(gr); E.wallPicks = [];
    var d = selectedDevice(), c = cellOf(d);
    if (!d || d.type !== 'wall' || !c) { gr.visible = false; return; }
    var size = d.size || [CELL * 0.9, 2.4, 0.12], f = d.free || { x: 0, y: 0, z: 0 };
    gr.position.set(c.x + f.x, c.y + f.y + size[1] / 2, c.z + f.z);
    gr.rotation.y = d.yaw * Math.PI / 180;
    var wire = new T.LineSegments(new T.EdgesGeometry(new T.BoxGeometry(size[0] + 0.18, size[1] + 0.18, size[2] + 0.18)),
      new T.LineBasicMaterial({ color: 0x4f46e5, transparent: true, opacity: 0.95, depthTest: false, depthWrite: false }));
    wire.renderOrder = 972; gr.add(wire);
    gr.updateMatrixWorld(true);
    gr.visible = true;
  }
  /* 外边缘磁吸：把当前墙的一条外边吸到附近另一面墙的外边，方便横纵墙对接。
     返回 {axis, delta, other}；未命中返回 null。 */
  function snapWallEdges(d) {
    if (!d || d.type !== 'wall') return null;
    var me = wallBox(d);
    if (!me) return null;
    var best = null, SNAP = 1.2;
    E.devices.forEach(function (o) {
      if (o.type !== 'wall' || o.id === d.id) return;
      var b = wallBox(o);
      if (!b) return;
      var ovZ = Math.min(me.maxZ, b.maxZ) - Math.max(me.minZ, b.minZ);
      var ovX = Math.min(me.maxX, b.maxX) - Math.max(me.minX, b.minX);
      var cands = [
        { axis: 'x', delta: b.maxX - me.minX, ov: ovZ },
        { axis: 'x', delta: b.minX - me.maxX, ov: ovZ },
        { axis: 'z', delta: b.maxZ - me.minZ, ov: ovX },
        { axis: 'z', delta: b.minZ - me.maxZ, ov: ovX }
      ];
      cands.forEach(function (cd) {
        var ad = Math.abs(cd.delta);
        if (ad > SNAP || ad < 1e-4 || cd.ov < -0.8) return;
        if (!best || ad < Math.abs(best.delta)) best = { axis: cd.axis, delta: cd.delta, other: o.id, dist: ad };
      });
    });
    if (!best) return null;
    var f = d.free || { x: 0, y: 0, z: 0 };
    var nf = { x: f.x || 0, y: f.y || 0, z: f.z || 0 };
    nf[best.axis] += best.delta;
    d.free = nf;
    positionAll();
    if (E.selected === d.id) updateWallLattice();
    return best;
  }
  /* 墙面三轴滑动控制：宽 / 高 / 厚；拉伸上限为原来的 5 倍 */
  var WALL_MIN = [0.4, 0.4, 0.04];
  var WALL_MAX = [CELL * 15, 40, 6];
  function setWallSize(axis, value) {
    var d = selectedDevice();
    if (!d || d.type !== 'wall') return false;
    var ai = axis === 'w' ? 0 : (axis === 'h' ? 1 : 2);
    var v = clamp(Number(value) || WALL_MIN[ai], WALL_MIN[ai], WALL_MAX[ai]);
    var size = (d.size || [CELL * 0.9, 2.4, 0.12]).slice();
    if (Math.abs(size[ai] - v) < 1e-6) return false;
    size[ai] = +v.toFixed(3);
    d.size = size;
    var panel = null;
    d.group.traverse(function (o) { if (o.userData && o.userData.eqPart === 'wallPanel') panel = o; });
    if (panel) {
      panel.geometry.dispose();
      panel.geometry = new T.BoxGeometry(size[0], size[1], size[2]);
      panel.position.y = size[1] / 2;    // 始终贴合地面
    }
    d.group.userData.eqMeta = { size: size.slice(), onePanel: true, color: 0xc9b785 };
    d.dims = size.slice();
    updateWallLattice();
    snapWallEdges(d);
    save(); updateDevPanel(); renderCatalog();
    return true;
  }

  /* ---------------- 单货架选格 + 终端配置（发货器 / 收货器） ---------------- */
  function rebuildOne(d) {
    if (!d || !E.root) return;
    if (d.group) { E.root.remove(d.group); disposeGroup(d.group); }
    var built = buildDevice(d);
    d.group = built.group; d.anim = built.anim; d.dims = built.dims;
    E.root.add(d.group);
    positionAll();
    applyVisibility();
    if (E.selected === d.id) updateMark();
  }
  /* 选格模式：显示「货位级」网格（格子 bayW × dp，与主体货位同轴对齐），
     每个格子都有拾取代理；选中的格子用紫色实心框 + 紫色边线强调。
     不再显示四周 2 m 的设备网格，也不会出现任何常驻锚点模型。 */
  function drawCellPick() {
    var gr = E.cellRoot, sg = E.slotRoot;
    if (!gr || !sg) return;
    clearGroup(gr); clearGroup(sg); E.slotPicks = [];
    var d = devById(E.cellPick);
    if (!d || d.type !== 'single') { gr.visible = false; sg.visible = false; return; }
    var chosen = d.singleCells || [];
    var buf = { pos: [], col: [] };
    var w0 = cfg().bayW, d0 = cfg().dp;
    if (E.slotProxyGeo) { E.slotProxyGeo.dispose(); E.slotProxyGeo = null; }
    var proxyGeo = new T.BoxGeometry(w0 * 0.92, 0.10, d0 * 0.92);
    proxyGeo.userData.shared = true;             // 所有货位格共用，避免反复创建
    E.slotProxyGeo = proxyGeo;
    E.slotCells.forEach(function (c) {
      var on = chosen.indexOf(c.key) >= 0;
      addRect(buf, c.x, 0.032, c.z, c.w * 0.94, c.d * 0.94,
        on ? 0x8b5cf6 : (c.ringOut === 0 ? 0x22c55e : 0x38bdf8));
      var pr = new T.Mesh(proxyGeo, ghostMat());
      pr.position.set(c.x, 0.05, c.z);
      pr.userData.eq = { kind: 'slot', key: c.key };
      sg.add(pr); E.slotPicks.push(pr);
      if (on) {
        var wire = new T.LineSegments(
          new T.EdgesGeometry(new T.BoxGeometry(c.w * 0.94, 0.10, c.d * 0.94)),
          new T.LineBasicMaterial({ color: 0x8b5cf6, transparent: true, opacity: 0.98, depthTest: false }));
        wire.position.set(c.x, 0.07, c.z); wire.renderOrder = 970;
        gr.add(wire);
      }
    });
    var lg = new T.BufferGeometry();
    lg.setAttribute('position', new T.Float32BufferAttribute(buf.pos, 3));
    lg.setAttribute('color', new T.Float32BufferAttribute(buf.col, 3));
    var lines = new T.LineSegments(lg, new T.LineBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.78, depthTest: true, depthWrite: false
    }));
    lines.renderOrder = 962; sg.add(lines);
    gr.visible = true; sg.visible = true;
    /* 选格时隐藏普通的 2 m 设备网格，只留货位网格 */
    E.gridRoot.visible = false;
  }
  function startCellPick(id) {
    var d = devById(id);
    if (!d || d.type !== 'single') return false;
    E.cellPick = id;
    E.editMode = false; E.gizmoRoot.visible = false;
    drawCellPick(); updateDevPanel();
    return true;
  }
  function stopCellPick() {
    if (!E.cellPick) return;
    E.cellPick = null;
    if (E.cellRoot) E.cellRoot.visible = false;
    if (E.slotRoot) E.slotRoot.visible = false;
    E.slotPicks = [];
    /* 不打断路线设计的采点网格显示 */
    if (!(WAP.routes && WAP.routes.snapshot && WAP.routes.snapshot().placeGridVisible)) {
      E.gridRoot.visible = E.pickGrid || E.editMode;
    }
  }
  function toggleCellPick(key) {
    var d = devById(E.cellPick), c = E.slotMap[key];
    if (!d || d.type !== 'single' || !c) return false;
    var arr = d.singleCells || (d.singleCells = []);
    var i = arr.indexOf(key);
    if (i >= 0) arr.splice(i, 1);                 // 允许全部取消，没有「取消不掉的格子」
    else {
      if (arr.length >= 4) { toast('单货架最多选 4 个货位格'); return false; }
      arr.push(key);
    }
    /* 实时生成：选格、改层数 / 层距 / 有无货物都立即重建可见预览 */
    rebuildOne(d);
    save(); drawCellPick(); updateDevPanel(); renderCatalog();
    toast('已选 ' + arr.length + ' / 4 个货位格 · 结构已实时更新');
    return true;
  }
  function setSingleOpt(key, value) {
    var d = devById(E.selected);
    if (!d || d.type !== 'single') return false;
    if (key === 'levels') d.singleLevels = clamp(Number(value) || mainLevels(), 1, 12);
    else if (key === 'pitch') d.singlePitch = clamp(Number(value) || cfg().pitch, 0.8, 3);
    else if (key === 'cargo') d.singleCargo = !!value;
    else if (key === 'kind') d.cargoKind = value;
    else if (key === 'class') d.cargoClass = value;
    else return false;
    rebuildOne(d);                                // 参数改动即时可见
    save(); updateDevPanel(); renderCatalog();
    return true;
  }
  function confirmSingleRack() {
    var d = devById(E.selected);
    if (!d || d.type !== 'single') return false;
    if (!d.singleCells || !d.singleCells.length) { toast('请先在货位网格上选自 1~4 格'); return false; }
    /* 确认时自动吸附贴紧主体货架 */
    d.singleCells = snapSlotsToRack(d.singleCells);
    d.singleBuilt = true;
    stopCellPick();
    rebuildOne(d); save(); updateDevPanel(); renderCatalog();
    toast(d.name + ' 已生成：' + d.singleCells.length + ' 格 · ' +
      d.singleLevels + ' 层' + (d.singleCargo !== false ? ' · 带货' : '') + ' · 已贴合主体货架');
    return true;
  }
  /* 发货器 / 收货器配置 */
  function setTerminalOpt(key, value) {
    var d = devById(E.selected);
    if (!d || (d.type !== 'emitter' && d.type !== 'receiver')) return false;
    if (key === 'bind') d.bindId = value || null;
    else if (key === 'kind') d.cargoKind = value;
    else if (key === 'class') d.cargoClass = value;
    else if (key === 'rate') d.rate = clamp(Number(value) || 2.5, 0.4, 12);
    else return false;
    save(); updateDevPanel(); renderCatalog();
    return true;
  }
  /* 绑定设备的世界坐标：发货器吐货 / 收货器吞货的落点 */
  function terminalPoint(d) {
    if (!d) return null;
    var c = E.cellMap[d.cellKey];
    var x = c ? c.x : 0, z = c ? c.z : 0, y = 0.86;
    if (d.bindId) {
      var b = devById(d.bindId);
      if (b) {
        var bc = E.cellMap[b.cellKey];
        if (bc) { x = bc.x; z = bc.z; }
        y = (b.dims && b.dims[1] ? Math.min(b.dims[1], 1.3) : 0.86) + 0.06;
      }
    }
    return { x: x, y: y, z: z };
  }

  function orient(o, dir) { o.quaternion.setFromUnitVectors(new T.Vector3(0, 1, 0), dir.clone().normalize()); }
  function axisArrow(gr, picks, def, sign, hex, L, offset) {
    var dir = new T.Vector3(def[0] * sign, def[1] * sign, def[2] * sign);
    var off = new T.Vector3(offset ? offset[0] : 0, offset ? offset[1] : 0, offset ? offset[2] : 0);
    var m = basic(hex), sl = L - 0.30;
    var shaft = new T.Mesh(new T.CylinderGeometry(0.055, 0.055, sl, 10), m);
    shaft.position.copy(dir.clone().multiplyScalar(0.22 + sl / 2).add(off));
    orient(shaft, dir); shaft.renderOrder = 1120; gr.add(shaft);
    var cone = new T.Mesh(new T.ConeGeometry(0.17, 0.34, 14), m);
    cone.position.copy(dir.clone().multiplyScalar(L - 0.05).add(off));
    orient(cone, dir); cone.renderOrder = 1121; gr.add(cone);
    var eq = { kind: 'axis', axis: Math.abs(def[0]) ? 'x' : (Math.abs(def[2]) ? 'z' : 'y'), sign: sign };
    /* picks 为 null 时只画灰色可见箭头，不生成拾取代理（禁用态） */
    if (picks) {
      var ps = new T.Mesh(new T.CylinderGeometry(0.20, 0.20, L, 8), ghostMat());
      ps.position.copy(shaft.position); ps.quaternion.copy(shaft.quaternion); ps.renderOrder = 1110;
      ps.userData.eq = eq; gr.add(ps); picks.push(ps);
      var pt = new T.Mesh(new T.SphereGeometry(0.30, 10, 8), ghostMat());
      pt.position.copy(cone.position); pt.renderOrder = 1111;
      pt.userData.eq = eq; gr.add(pt); picks.push(pt);
    }
    return eq;
  }
  function buildGizmo() {
    var gr = E.gizmoRoot;
    clearGroup(gr); E.gizmoPicks = [];
    var d = selectedDevice(), c = cellOf(d);
    if (!d || !c || !E.editMode || d.type === 'wall') { gr.visible = false; return; }
    var L = 1.28;
    var cy = Math.min(c.y + d.dims[1] * 0.5, c.y + 1.15);
    gr.position.set(c.x, cy, c.z);
    gr.visible = true;
    axisArrow(gr, E.gizmoPicks, [1, 0, 0], 1, 0xef4b6b, L, 0);
    axisArrow(gr, E.gizmoPicks, [1, 0, 0], -1, 0xef4b6b, L, 0);
    axisArrow(gr, E.gizmoPicks, [0, 0, 1], 1, 0x16a9c9, L, 0);
    axisArrow(gr, E.gizmoPicks, [0, 0, 1], -1, 0x16a9c9, L, 0);
    /* 编辑模式不再有水平旋转环：旋转统一由控制面板的「↻ 旋转 90°」完成 */
    var off = [L * 1.10, 0, 0];
    if (hasPlatform()) {
      var up = axisArrow(gr, E.gizmoPicks, [0, 1, 0], 1, 0xf5a524, 0.78, off);
      up.kind = 'level'; up.sign = 1;
      var dn = axisArrow(gr, E.gizmoPicks, [0, 1, 0], -1, 0x6366f1, 0.78, off);
      dn.kind = 'level'; dn.sign = -1;
    } else {
      /* 无钢平台：上下键仍在，但置灰且不可点击 */
      axisArrow(gr, null, [0, 1, 0], 1, 0x9aa4b2, 0.78, off);
      axisArrow(gr, null, [0, 1, 0], -1, 0x9aa4b2, 0.78, off);
    }
    gr.updateMatrixWorld(true);
  }

  /* ---------------- 控制面板（停靠到库体概览位置） ---------------- */
  /* 靠拢子通道口：前端（-Z）或货架对面（+Z）都在最近两层网格内 */
  function liftNearMouthCell(cell) {
    var g = geom();
    if (!g || !cell || cell.kind !== 'ground') return false;
    var inX = cell.x > g.x0 - CELL && cell.x < g.x1 + CELL;
    var front = cell.z < g.z0 - 0.2 && cell.z > g.z0 - CELL * 2.4;
    var back = cell.z > g.z1 + 0.2 && cell.z < g.z1 + CELL * 2.4;
    return inX && (front || back);
  }
  function liftNearMouth(d) { return liftNearMouthCell(cellOf(d)); }
  function updateDevPanel() {
    var d = selectedDevice(), cell = cellOf(d);
    if (!d || !cell) return;
    var c = cfg();
    $('dpTitle').textContent = d.name;
    $('dpSub').textContent = TYPES[d.type].d + ' · ' + (WAP.sim.playing ? '随仿真运行中' : '待机');
    var site = d.type === 'lift' ? liftSite(d) : null;
    var cf = d.type === 'lift' ? liftCfg(d) : null;
    var rows = [
      ['设备编号', d.code],
      ['所在格子', cellLabel(cell)],
      ['坐标', cell.x.toFixed(1) + ', ' + cell.y.toFixed(2) + ', ' + cell.z.toFixed(1)],
      ['水平角度', Math.round(d.yaw) + '°']
    ];
    var isEmit = d.type === 'emitter', isRecv = d.type === 'receiver', isSingle = d.type === 'single';
    var isGate = d.type === 'gate', isTerm = isEmit || isRecv;
    if (isTerm) {
      rows.push(['点位类型', isEmit ? '发货器（淡绿点）' : '收货器（红点）']);
      rows.push(['绑定设备', d.bindId ? (devById(d.bindId) || {}).name || '已失效' : '未绑定（用自身位置）']);
      rows.push(['网格名额', '不占用 · 可叠放']);
      if (isEmit) {
        rows.push(['货物类型', WAP.core.CARGO_NAME[d.cargoKind] || d.cargoKind || '—']);
        rows.push(['货物大类', WAP.core.CARGO_CLASS_NAME[d.cargoClass] || '无托盘单货物']);
        rows.push(['吐货速度', (d.rate || 2.5).toFixed(1) + ' 秒/件']);
      } else {
        rows.push(['已收货', (WAP.terminals ? WAP.terminals.receivedCount(d.id) : 0) + ' 件']);
      }
    } else if (isSingle) {
      rows.push(['已选货位格', (d.singleCells || []).length + ' / 4 格']);
      rows.push(['格子尺寸', c.bayW.toFixed(2) + ' × ' + c.dp.toFixed(2) + ' m（对齐主体货位）']);
      rows.push(['层数', (d.singleLevels || mainLevels()) + ' 层']);
      rows.push(['层距', (d.singlePitch || c.pitch).toFixed(2) + ' m']);
      rows.push(['货物', d.singleCargo !== false ? '有' : '无']);
      rows.push(['状态', d.singleBuilt ? '已确认生成 · 贴合主体货架' : '实时预览中 · 待确认']);
    } else if (d.type === 'lift') {
      rows.push(['对接子通道', site ? site.col : '—']);
      rows.push(['摆放侧', cf && cf.side === 'back' ? '货架对面（+Z）' : '货架前端（-Z）']);
      rows.push(['层间输送线', cf && cf.matched === false ? '未匹配' : '已匹配 → 主通道']);
      rows.push(['可用层', cf ? cf.lv + ' / ' + c.levels + ' 层' : '—']);
      rows.push(['加高', cf ? '+' + (cf.boost * c.pitch).toFixed(2) + ' m' : '—']);
    } else if (d.type === 'platform') {
      rows.push(['所在层', '第 ' + ((d.deck || 0) + 1) + ' / ' + c.levels + ' 层']);
      rows.push(['显示', d.solid !== false ? '实体' : '仅轮廓线']);
      rows.push(['作用', '该层额外地面 · 可再放 1 台设备']);
    } else if (d.type === 'wall') {
      rows.push(['尺寸', (d.size || []).map(function (v) { return (+v).toFixed(2); }).join(' × ') + ' m']);
      rows.push(['编辑', '独立晶格子 · 自由移动 / 拉伸']);
    } else if (isGate) {
      rows.push(['门高', ((d.dims && d.dims[1]) || 2.64).toFixed(2) + ' m · 原门高 200%']);
      rows.push(['门面', '单片门 · 旋转 90° · 无外围四边框']);
      rows.push(['光幕', (d.gateColor === 'red' ? '红色' : '绿色') + ' · 与门平行 · 50% 透明度 · 5 秒']);
      rows.push(['检测状态', E.t < (d.gateUntil || 0) ? '光幕点亮中' : '待货物经过']);
      rows.push(['网格名额', '不占用 · 套在输送设备外围']);
    } else if (d.type === 'destacker') {
      rows.push(['外形', '外围四边框 · 本体无托盘']);
      rows.push(['职能', '只收母托盘 · 不接收货物 · 不参与 90° 换向']);
      rows.push(['托盘垛', destackerStackOf(d.id) + ' 片母托盘']);
      rows.push(['拆分输出', '缺母托盘时分离单片，沿输送线送出']);
    } else if (['person', 'forklift', 'agv', 'truck'].indexOf(d.type) >= 0) {
      rows.push(['类型', '参考站素材占位 · 后续完善动作']);
      rows.push(['承载货物', '不参与 · 货物仅由四向车 / 提升机 / 输送设备带动']);
    } else {
      rows.push(['格子占用', cell.kind === 'platform' ? '钢平台 + 1 台设备' : (cell.base ? '已占用' : '空闲')]);
      rows.push(['可用层', hasPlatform() ? '地面 + ' + hasPlatformCount() + ' 个钢平台格子' : '仅地面一层']);
    }
    $('dpInfo').innerHTML = rows.map(function (r) {
      return '<div class="dp-kv"><span>' + r[0] + '</span><b>' + esc(r[1]) + '</b></div>';
    }).join('');

    var isLift = d.type === 'lift', isPlat = d.type === 'platform', isWall = d.type === 'wall';
    var isSpecial = isWall || isTerm || isSingle || isGate;
    $('dpCommon').hidden = isSpecial;      // 特殊设备用专属面板，通用编辑/旋转不显示
    $('dpLift').hidden = !isLift;
    $('dpPlat').hidden = !isPlat;
    $('dpWall').hidden = !isWall;
    $('dpEmitter').hidden = !isEmit;
    $('dpReceiver').hidden = !isRecv;
    $('dpSingle').hidden = !isSingle;
    $('dpGate').hidden = !isGate;
    if (isGate) {
      $('dpGateColorVal').textContent = d.gateColor === 'red' ? '红色' : '绿色';
      $('dpGateRed').classList.toggle('is-on', d.gateColor === 'red');
      $('dpGateGreen').classList.toggle('is-on', d.gateColor !== 'red');
    }
    if (isTerm) {
      /* 绑定只读展示：由「拖到设备所在网格」自动决定，面板不提供选择 */
      var bname = d.bindId ? ((devById(d.bindId) || {}).name || '已失效') : '未绑定';
      if (isEmit) {
        $('dpEmBindVal').textContent = bname;
        if (!$('dpEmKind').dataset.filled) {
          $('dpEmKind').dataset.filled = '1';
          $('dpEmKind').innerHTML = WAP.core.CARGO_REAL.map(function (k) {
            return '<option value="' + k + '">' + esc(WAP.core.CARGO_NAME[k]) + '</option>';
          }).join('');
          $('dpEmClass').innerHTML = WAP.core.CARGO_CLASSES.map(function (o) {
            return '<option value="' + o.k + '">' + esc(o.n) + '</option>';
          }).join('');
        }
        $('dpEmKind').value = d.cargoKind && WAP.core.CARGO_REAL.indexOf(d.cargoKind) >= 0 ? d.cargoKind : 'carton';
        $('dpEmClass').value = d.cargoClass || 'single';
        $('dpEmRate').value = d.rate || 2.5;
        $('dpEmRateVal').textContent = (d.rate || 2.5).toFixed(1) + ' 秒/件';
      } else {
        $('dpRcBindVal').textContent = bname;
        $('dpRcCount').textContent = (WAP.terminals ? WAP.terminals.receivedCount(d.id) : 0) + ' 件';
      }
    }
    if (isSingle) {
      $('dpSrCells').textContent = (d.singleCells || []).length + ' / 4 格';
      $('dpSrPick').textContent = E.cellPick ? '✓ 选格中 · 点货位格' : '✥ 选格 / 重选';
      $('dpSrLvVal').textContent = (d.singleLevels || mainLevels()) + ' 层';
      $('dpSrPitchVal').textContent = (d.singlePitch || c.pitch).toFixed(2) + ' m';
      $('dpSrCargo').textContent = d.singleCargo !== false ? '▣ 有货物' : '▢ 无货物';
      $('dpSrCargo').classList.toggle('is-on', d.singleCargo !== false);
      $('dpSrKind').textContent = WAP.core.CARGO_NAME[d.cargoKind] || '智能混放';
      $('dpSrConfirm').textContent = d.singleBuilt ? '✓ 重新生成货架' : '✓ 确认生成货架';
    }
    if (!isWall) {
      $('dpEdit').textContent = E.editMode ? '✓ 退出编辑模式' : '✥ 进入编辑模式';
      $('dpEdit').classList.toggle('is-on', E.editMode);
      /* 钢平台用「所在层」控制，不再提供层间上下移动 */
      $('dpLevelRow').hidden = isPlat;
      if (!isPlat) {
        $('dpUp').disabled = !hasPlatform();
        $('dpDown').disabled = !hasPlatform();
        $('dpLevelHint').textContent = hasPlatform()
          ? (cell.kind === 'platform' ? '钢平台额外地面' : '可上到钢平台层')
          : '需先放置钢平台（灰色不可用）';
      }
    }
    if (isLift) {
      var lv = cf.lv || c.levels, boost = cf.boost || 0;
      $('dpLvVal').textContent = lv + ' / ' + c.levels + ' 层';
      $('dpLvMinus').disabled = lv <= 1;
      $('dpLvPlus').disabled = lv >= c.levels;
      $('dpBoostVal').textContent = '+' + (boost * c.pitch).toFixed(2) + ' m';
      $('dpBoostMinus').disabled = boost <= 0;
      $('dpBoostPlus').disabled = !hasPlatform() || boost >= 6;
      $('dpLiftSide').textContent = cf.side === 'back' ? '⇅ 切回货架前端' : '⇅ 切换到货架对面';
      var near = liftNearMouth(d), matched = cf.matched !== false;
      $('dpMatch').disabled = !near || matched;
      $('dpMatch').textContent = matched ? '✓ 已匹配层间输送线' : '⇄ 匹配层间输送线模型';
      $('dpMatchHint').textContent = matched
        ? '已清空该子通道每层货物并铺设层间输送线，末端对接最近的主通道。'
        : (near ? '已靠拢子通道口，点击即可匹配。' : '请先在编辑模式把提升机拖到靠近子通道口的地面格子。');
    }
    if (isPlat) {
      $('dpDeckVal').textContent = '第 ' + ((d.deck || 0) + 1) + ' / ' + c.levels + ' 层';
      $('dpDeckMinus').disabled = (d.deck || 0) <= 0;
      $('dpDeckPlus').disabled = (d.deck || 0) >= c.levels - 1;
      $('dpSolid').classList.toggle('dp-ghost', true);
      $('dpSolid').classList.toggle('is-on', d.solid !== false);
      $('dpOutline').classList.toggle('dp-ghost', true);
      $('dpOutline').classList.toggle('is-on', d.solid === false);
      var pair = adjacentPlatformPairs().filter(function (p) { return p.a === d.id || p.b === d.id; })[0];
      $('dpPlatJoin').disabled = !pair;
      $('dpPlatJoin').textContent = d.joined ? '✓ 已贴合 · 点击取消' :
        (pair ? '⇄ 与相邻钢平台贴合' : '⇄ 暂无相邻钢平台');
    }
    if (isWall) {
      var sz = d.size || [CELL * 0.9, 2.4, 0.12];
      $('dpWallW').value = sz[0]; $('dpWallH').value = sz[1]; $('dpWallD').value = sz[2];
      $('dpWallWVal').textContent = sz[0].toFixed(2) + ' m';
      $('dpWallHVal').textContent = sz[1].toFixed(2) + ' m';
      $('dpWallDVal').textContent = sz[2].toFixed(2) + ' m';
      $('dpWallW').max = WALL_MAX[0]; $('dpWallH').max = WALL_MAX[1]; $('dpWallD').max = WALL_MAX[2];
    }
    $('dpTip').innerHTML = isWall
      ? '拖动本体移动并自动<b>外边缘磁吸</b>；宽 / 高 / 厚用上方滑动轴调整，墙体始终贴合地面。'
      : (isEmit ? '发货器<b>不占网格名额</b>；绑定设备后按速度吐货进入输送线，把它拖作路线起点即可让货物沿路线到货架。'
        : (isRecv ? '收货器<b>不占网格名额</b>；所有到达它位置的货物都会消失，总量随之减少。'
          : (isSingle ? '先点网格选最多 4 格，再设层数 / 层距 / 有无货物，点「确认生成货架」链接主体货架。'
            : (E.editMode
              ? '拖拽<b>设备本体 / 彩色箭头</b>吸附到格子 · 点击<b>立体网格</b>换层 · 按 <b>Alt + 左键拖动</b>只旋转视角 · Esc 取消'
              : '双击设备或点「进入编辑模式」显示四周网格；用面板「↻ 旋转 90°」旋转；无钢平台时上下键为灰色。'))));
  }
  function hasPlatformCount() {
    return E.cells.filter(function (c) { return c.kind === 'platform'; }).length;
  }

  function rotate(delta) {
    var d = selectedDevice();
    if (!d) return;
    d.yaw = ((Math.round((d.yaw + delta) / 90) * 90) % 360 + 360) % 360;
    d.group.rotation.y = d.yaw * Math.PI / 180;
    if (d.type === 'wall') {
      snapWallEdges(d);
      updateWallLattice();
      updateSnapButtons();
    }
    save(); updateDevPanel();
  }
  function stepLevel(dir) {
    var d = selectedDevice(), cell = cellOf(d);
    if (!d || !cell) return false;
    if (d.type === 'wall') { toast('墙面请用独立晶格子自由移动'); return false; }
    if (d.type === 'platform') { toast('钢平台请用「所在层」控制高度，不提供层间上下移动'); return false; }
    if (!hasPlatform()) { toast('请先放置钢平台，才可使用层间上下移动'); return false; }
    var plats = E.cells.filter(function (q) { return q.kind === 'platform' && canPlace(d, q); });
    if (!plats.length) { toast('没有可用的钢平台格子'); return false; }
    plats.sort(function (a, b) { return a.y - b.y || Math.hypot(a.x - cell.x, a.z - cell.z) - Math.hypot(b.x - cell.x, b.z - cell.z); });
    var target = null;
    if (cell.kind === 'ground') {
      if (dir < 0) { toast('已在地面层'); return false; }
      target = plats[0];
    } else {
      var idx = -1;
      plats.forEach(function (q, i) { if (q.key === cell.key) idx = i; });
      if (idx < 0) idx = 0;
      if (dir > 0) target = plats[idx + 1] || null;
      else {
        if (idx > 0) target = plats[idx - 1];
        else {
          var gkey = findFreeCellKey(d.type, { id: d.id, x: cell.x, z: cell.z });
          target = gkey ? E.cellMap[gkey] : null;
        }
      }
    }
    if (!target) { toast(dir > 0 ? '已到最高一层' : '地面没有空闲格子'); return false; }
    if (!canPlace(d, target)) { toast('目标格子已被其它设备占用'); return false; }
    applyCell(d, target);
    refreshAfterChange();
    toast(d.name + ' → ' + cellLabel(target));
    return true;
  }
  function placeOnCell(key) {
    var d = selectedDevice(), cell = E.cellMap[key];
    if (!d || !cell) return false;
    if (!canPlace(d, cell)) { toast('该格子已被其它设备占用'); return false; }
    var moved = d.cellKey !== key;
    applyCell(d, cell);
    if (moved) updateLiftColumnFromCell(d, cell);
    if (d.type === 'platform') alignPlatformEdge(d);
    if (d.type === 'wall') snapWallEdges(d);
    refreshAfterChange();
    toast(d.name + ' 已吸附 → ' + cellLabel(cell));
    return true;
  }
  function focus(id) {
    var d = devById(id), cell = cellOf(d);
    if (!d || !cell) return;
    var S = WAP.scene.S, x = cell.x, y = cell.y + d.dims[1] * 0.5, z = cell.z;
    if (d.type === 'lift') {
      var s = liftSite(d);
      if (s) { x = s.x; z = s.z; y = (geom().top || 6) * 0.45; }
    }
    var wp = S.modelRoot.localToWorld(new T.Vector3(x, y, z));
    S.ctrl.target.copy(wp);
    S.ctrl.radius = clamp(Math.max(d.dims[0], d.dims[2]) * (d.type === 'lift' ? 5.2 : 3.4), 4.5, 18);
    S.ctrl.phi = 1.04; S.ctrl.theta = Math.PI - 0.72;
    WAP.scene.applyCamera();
    toast('视角已聚焦 ' + d.name);
  }

  /* 提升机 / 钢平台 / 墙面的专属控制 */
  function setLiftLevels(delta) {
    var d = selectedDevice();
    if (!d || d.type !== 'lift') return false;
    var c = cfg(), cf = liftCfg(d);
    var lv = clamp((cf.lv || c.levels) + delta, 1, c.levels);
    if (lv === (cf.lv || c.levels)) return false;
    cf.lv = lv; WAP.core.save(c); WAP.app.commit(true);
    select(d.id, true); updateDevPanel(); renderCatalog();
    toast(d.name + ' 层数 → ' + lv + ' 层');
    return true;
  }
  function setLiftBoost(delta) {
    var d = selectedDevice();
    if (!d || d.type !== 'lift') return false;
    var c = cfg(), cf = liftCfg(d);
    if (delta > 0 && !hasPlatform()) { toast('需先放置钢平台，才允许升高提升机'); return false; }
    var b = clamp((cf.boost || 0) + delta, 0, 6);
    if (b === (cf.boost || 0)) return false;
    cf.boost = b; WAP.core.save(c); WAP.app.commit(true);
    select(d.id, true); updateDevPanel(); renderCatalog();
    toast(d.name + ' 高度 → +' + (b * c.pitch).toFixed(2) + ' m');
    return true;
  }
  function matchConveyor() {
    var d = selectedDevice();
    if (!d || d.type !== 'lift') return false;
    if (!liftNearMouth(d)) { toast('请先把提升机拖到靠近子通道口的格子'); return false; }
    var c = cfg(), cf = liftCfg(d);
    if (cf.matched !== false) return false;
    var cell = cellOf(d), bi = bayFromCell(cell), cols = currentLiftCols();
    var side = sideOfCell(cell) || 'front';
    cf.side = side;
    /* 对齐到最近的子通道口 */
    var hit = cols.filter(function (o) { return o.id === d.liftId; })[0];
    if (hit && !cols.some(function (o) { return o.id !== d.liftId && o.i === bi; })) hit.i = bi;
    /* 把最近的主通道前移到紧邻层间输送线的位置：
       front 压第一储区、back 压最后储区，多出的排并入相邻储区，总货位数不变。 */
    var bIdx = side === 'back' ? c.depths.length - 1 : 0;
    var nbIdx = side === 'back' ? bIdx - 1 : bIdx + 1;
    if (c.depths[bIdx] > 1 && c.depths.length > 1 && nbIdx >= 0) {
      var extra = c.depths[bIdx] - 1;
      c.depths[bIdx] = 1; c.depths[nbIdx] += extra;
    }
    cf.matched = true;
    c.liftCols = cols;
    WAP.core.save(c);
    WAP.app.commit(true);
    select(d.id, true); updateDevPanel(); renderCatalog();
    toast(d.name + ' 已匹配：' + (hit ? hit.i + 1 : bi + 1) + ' 号子通道每层货物清空、铺设层间输送线并对接最近主通道');
    return true;
  }
  function setPlatformDeck(delta) {
    var d = selectedDevice();
    if (!d || d.type !== 'platform') return false;
    var c = cfg(), deck = clamp((d.deck || 0) + delta, 0, c.levels - 1);
    if (deck === (d.deck || 0)) return false;
    d.deck = deck;
    rebuildDevices(); refreshAfterChange();
    toast(d.name + ' → 第 ' + (deck + 1) + ' 层（货位高度 ' + (c.y0 + deck * c.pitch).toFixed(2) + ' m）');
    return true;
  }
  function setPlatformSide(side) {
    var d = selectedDevice();
    if (!d || d.type !== 'platform') return false;
    var g = geom();
    var cands = E.cells.filter(function (cell) {
      if (cell.kind !== 'ground' || !canPlace(d, cell)) return false;
      if (side === 'front') return cell.z < g.z0 - 0.2;
      if (side === 'back') return cell.z > g.z1 + 0.2;
      if (side === 'left') return cell.x < g.x0 - 0.2;
      return cell.x > g.x1 + 0.2;
    });
    cands.sort(function (a, b) { return a.ring - b.ring || Math.abs(a.x) + Math.abs(a.z) - Math.abs(b.x) - Math.abs(b.z); });
    if (!cands.length) { toast('该方位没有空闲格子'); return false; }
    return placeOnCell(cands[0].key);
  }
  function setPlatformSolid(solid) {
    var d = selectedDevice();
    if (!d || d.type !== 'platform') return false;
    d.solid = !!solid;
    setPlatformVisual(d, d.group);
    save(); updateDevPanel(); renderCatalog();
    toast(d.name + (solid ? ' 实体显示' : ' 仅显示轮廓线'));
    return true;
  }

  /* ---------------- 指针交互 ---------------- */
  function ndc(e) {
    var r = E.canvas.getBoundingClientRect();
    E.v2.set((e.clientX - r.left) / r.width * 2 - 1, -(e.clientY - r.top) / r.height * 2 + 1);
    return E.v2;
  }
  function firstHit(objects, e) {
    if (!objects || !objects.length) return null;
    E.rc.setFromCamera(ndc(e), WAP.scene.S.camera);
    var hits = E.rc.intersectObjects(objects, false);
    return hits.length ? hits[0] : null;
  }
  function deviceHit(e) {
    E.rc.setFromCamera(ndc(e), WAP.scene.S.camera);
    var hits = E.rc.intersectObjects([E.root], true);
    for (var i = 0; i < hits.length; i++) {
      var o = hits[i].object;
      if (o.userData && o.userData.devId) return { hit: hits[i], id: o.userData.devId };
    }
    return null;
  }
  function rayPlaneWorld(e, y) {
    E.rc.setFromCamera(ndc(e), WAP.scene.S.camera);
    var p = new T.Vector3();
    var plane = new T.Plane(new T.Vector3(0, 1, 0), -y);
    return E.rc.ray.intersectPlane(plane, p) ? p : null;
  }
  function nearestCell(x, z, level, axis, dev, start) {
    var cands = E.cells.filter(function (c) {
      if (c.level !== level) return false;
      if (dev.type === 'platform' && c.kind !== 'ground') return false;
      if (!canPlace(dev, c)) return false;
      if (axis === 'x' && Math.abs(c.z - start.z) > 0.05) return false;
      if (axis === 'z' && Math.abs(c.x - start.x) > 0.05) return false;
      return true;
    });
    var best = null, bd = 1e9;
    cands.forEach(function (c) {
      var d = (c.x - x) * (c.x - x) + (c.z - z) * (c.z - z);
      if (d < bd) { bd = d; best = c; }
    });
    return best;
  }
  function showHud(txt) {
    var h = $('eqHud');
    if (!h) return;
    h.textContent = txt; h.classList.add('show');
  }
  function hideHud() { var h = $('eqHud'); if (h) h.classList.remove('show'); }
  function planeY(dev, cell) {
    return WAP.scene.S.modelRoot.position.y + cell.y +
      (dev.type === 'wall' ? (dev.size ? dev.size[1] * 0.5 : 1) : Math.min(dev.dims[1] * 0.5, 0.6));
  }
  function startDrag(e, id, axis, sign, kind) {
    var dev = devById(id), cell = cellOf(dev);
    if (!dev || !cell) return false;
    var d = {
      id: e.pointerId, sx: e.clientX, sy: e.clientY, kind: kind || (axis ? 'axis' : 'move'),
      axis: axis || null, sign: sign || 1, devId: id,
      startCell: cell, level: cell.level, planeY: planeY(dev, cell),
      origYaw: dev.yaw, newYaw: dev.yaw, origKey: dev.cellKey,
      origFree: dev.free ? dev.free.slice ? dev.free.slice() : { x: dev.free.x, y: dev.free.y, z: dev.free.z } : null,
      origSize: dev.size ? dev.size.slice() : null,
      target: null, moved: false
    };
    if (kind === 'wallMove') {
      var p = rayPlaneWorld(e, d.planeY);
      if (p) {
        var loc = WAP.scene.S.modelRoot.worldToLocal(p.clone());
        d.sx0 = loc.x; d.sz0 = loc.z;
      } else { d.sx0 = 0; d.sz0 = 0; }
    }
    E.drag = d;
    try { E.canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    E.canvas.style.cursor = kind === 'yaw' ? 'ew-resize' : 'grabbing';
    return true;
  }
  function onDown(e) {
    if (!E.ready || e.button !== 0) return false;
    /* 编辑模式下 Alt + 左键拖动：交回相机做视角旋转，不触发网格 / 设备移动 */
    if (e.altKey && E.editMode) return false;
    var S = WAP.scene.S;
    S.modelRoot.updateMatrixWorld(true);
    /* 单货架选格模式：点「货位级」网格格子＝加入 / 移出选区（最多 4 格） */
    if (E.cellPick && !e.altKey) {
      var cp = firstHit(E.slotPicks, e);
      if (cp && cp.object.userData.eq && cp.object.userData.eq.kind === 'slot') {
        toggleCellPick(cp.object.userData.eq.key);
        return true;
      }
      return false;                        // 点空白交给场景清选中 / 退出选格
    }
    var sel = selectedDevice();
    /* 相邻钢平台中间的「贴合按钮」优先 */
    var sp = firstHit(E.snapPicks, e);
    if (sp && sp.object.userData.eq && sp.object.userData.eq.kind === 'platSnap') {
      var q = sp.object.userData.eq;
      joinPlatforms(q.a, q.b);
      return true;
    }
    /* 墙面不再用 3D 拉伸控制点，尺寸统一由控制面板的滑动轴调整 */
    var gz = E.editMode && !(sel && sel.type === 'wall') ? firstHit(E.gizmoPicks, e) : null;
    var dh = deviceHit(e);
    var useGizmo = gz && gz.object.userData.eq && (!dh || gz.distance <= dh.hit.distance + 0.01);
    if (useGizmo) {
      var a = gz.object.userData.eq;
      if (a.kind === 'level') { stepLevel(a.sign); return true; }
      if (a.kind === 'yaw') { startDrag(e, E.selected, null, 1, 'yaw'); showHud('拖拽绿环 · 水平旋转 90°'); return true; }
      startDrag(e, E.selected, a.axis, a.sign, 'axis');
      showHud('沿 ' + a.axis.toUpperCase() + ' 轴移动 · 松手吸附格子');
      return true;
    }
    if (dh) {
      if (E.selected !== dh.id) select(dh.id);
      var dev = devById(dh.id);
      if (dev && dev.type === 'wall') {
        startDrag(e, dev.id, null, 1, 'wallMove');
        showHud('自由移动墙面 · 松手生效');
        return true;
      }
      /* 发货器 / 收货器无需编辑模式即可拖动：松手落在哪个设备格，
         就自动绑定该格上的设备。拖动时显示网格便于瞄准。 */
      if (dev && (dev.type === 'emitter' || dev.type === 'receiver')) {
        setPickGrid(true);
        startDrag(e, dev.id, null, 1, 'termMove');
        showHud('拖到设备所在网格 · 松手自动绑定');
        return true;
      }
      if (E.editMode && E.selected === dh.id) {
        startDrag(e, dh.id, null, 1, 'move');
        showHud('拖拽 ' + dev.name + ' · 松手吸附格子');
      }
      return true;
    }
    if (E.editMode && !(sel && sel.type === 'wall')) {
      var ch = firstHit(E.gridPicks, e);
      if (ch && ch.object.userData.eq) { placeOnCell(ch.object.userData.eq.key); return true; }
    }
    return false;
  }
  function onCanvasMove(e) {
    if (E.drag) return true;
    if (!E.editMode || !E.selected) return false;
    var gz = firstHit(E.gizmoPicks, e);
    var dh = deviceHit(e);
    var ch = firstHit(E.gridPicks, e);
    E.canvas.style.cursor = gz ? 'grab' : (dh ? 'move' : (ch ? 'pointer' : 'crosshair'));
    var dev = selectedDevice(), cell = cellOf(dev);
    if (cell && ch && ch.object.userData.eq) setHoverCell(E.cellMap[ch.object.userData.eq.key]);
    else if (cell) {
      var p = rayPlaneWorld(e, planeY(dev, cell));
      if (p) {
        var loc = WAP.scene.S.modelRoot.worldToLocal(p.clone());
        setHoverCell(nearestCell(loc.x, loc.z, cell.level, null, dev, cell));
      }
    }
    return true;
  }
  function onMove(e) {
    var d = E.drag;
    if (!d || (e.pointerId != null && d.id !== e.pointerId)) return;
    var dev = devById(d.devId);
    if (!dev) { E.drag = null; return; }
    var dx = e.clientX - d.sx, dy = e.clientY - d.sy;
    if (Math.abs(dx) + Math.abs(dy) > 4) d.moved = true;
    if (d.kind === 'yaw') {
      d.newYaw = ((Math.round((d.origYaw + dx * 0.55) / 90) * 90) % 360 + 360) % 360;
      dev.group.rotation.y = d.newYaw * Math.PI / 180;
      showHud('水平旋转 ' + d.newYaw + '°');
      return;
    }
    /* 墙面自由移动 / 自由拉伸：不吸附格子 */
    if (d.kind === 'wallMove' || d.kind === 'wallSize') {
      var S = WAP.scene.S;
      if (d.kind === 'wallMove') {
        var p = rayPlaneWorld(e, d.planeY);
        if (p) {
          var loc = S.modelRoot.worldToLocal(p.clone());
          var base = d.origFree || { x: 0, y: 0, z: 0 };
          dev.free = { x: base.x + (loc.x - d.sx0), y: base.y, z: base.z + (loc.z - d.sz0) };
          positionAll(); updateWallLattice();
          showHud('自由移动 · X ' + dev.free.x.toFixed(2) + ' / Z ' + dev.free.z.toFixed(2));
        }
      } else {
        var os = d.origSize || [CELL * 0.9, 2.4, 0.12];
        var ai = d.axis === 'x' ? 0 : (d.axis === 'y' ? 1 : 2);
        var step = (dx - dy) * 0.014 * d.sign;
        var size = os.slice();
        size[ai] = clamp(os[ai] + step * 2, WALL_MIN[ai], WALL_MAX[ai]);
        dev.size = size;
        var panel = null;
        dev.group.traverse(function (o) { if (o.userData && o.userData.eqPart === 'wallPanel') panel = o; });
        if (panel) {
          panel.geometry.dispose();
          panel.geometry = new T.BoxGeometry(size[0], size[1], size[2]);
          panel.position.y = size[1] / 2;
        }
        dev.dims = size.slice();
        updateWallLattice(); updateDevPanel();
        showHud('拉伸 ' + d.axis.toUpperCase() + ' → ' + size[ai].toFixed(2) + ' m');
      }
      return;
    }
    var pw = rayPlaneWorld(e, d.planeY);
    if (!pw) return;
    var local = WAP.scene.S.modelRoot.worldToLocal(pw.clone());
    var cell = nearestCell(local.x, local.z, d.level, d.kind === 'axis' ? d.axis : null, dev, d.startCell);
    if (cell) {
      d.target = cell;
      dev.group.position.set(cell.x, cell.y, cell.z);
      setHoverCell(cell);
      showHud('吸附 → ' + cellLabel(cell));
    }
  }
  function onUp(e) {
    var d = E.drag;
    if (!d || (e && e.pointerId != null && d.id !== e.pointerId)) return;
    var dev = devById(d.devId);
    if (!dev) { E.drag = null; hideHud(); return; }
    if (!d.moved && d.kind === 'axis') {
      var wanted = (d.axis === 'x' ? d.startCell.x : d.startCell.z) + d.sign * CELL;
      var cand = E.cells.filter(function (q) {
        if (q.level !== d.level) return false;
        var v = d.axis === 'x' ? q.x : q.z;
        var fixed = d.axis === 'x' ? q.z - d.startCell.z : q.x - d.startCell.x;
        return Math.abs(v - wanted) < 0.05 && Math.abs(fixed) < 0.05;
      })[0];
      if (cand && canPlace(dev, cand)) d.target = cand;
    }
    if (!d.moved && d.kind === 'yaw') d.newYaw = ((d.origYaw + 90) % 360 + 360) % 360;
    E.drag = null;
    try { E.canvas.releasePointerCapture(d.id); } catch (err) { /* ignore */ }
    E.canvas.style.cursor = E.editMode ? 'crosshair' : 'grab';
    hideHud();
    /* 墙移动结束后自动磁吸到相邻墙的外边缘 */
    if (d.kind === 'wallMove' || d.kind === 'wallSize') {
      var snapped = snapWallEdges(dev);
      if (snapped) toast('墙体已磁吸到相邻墙的外边缘');
    }
    if (d.kind === 'termMove') setPickGrid(false);
    if (d.kind === 'yaw') dev.yaw = d.newYaw;
    if (d.target && canPlace(dev, d.target) && d.target.key !== dev.cellKey) {
      var changed = true;
      applyCell(dev, d.target);
      if (changed) updateLiftColumnFromCell(dev, d.target);
    }
    refreshAfterChange();
    if (d.kind === 'termMove') {
      var bound = dev.bindId ? devById(dev.bindId) : null;
      if (bound) toast(dev.name + ' 已自动绑定 → ' + bound.name);
      else toast(dev.name + ' 所在网格没有设备 · 已解除绑定');
    }
  }
  function cancelDrag() {
    var d = E.drag;
    if (!d) return;
    var dev = devById(d.devId);
    if (dev) {
      dev.cellKey = d.origKey;
      dev.yaw = d.origYaw;
      dev.group.rotation.y = dev.yaw * Math.PI / 180;
      dev.free = d.origFree;
      dev.size = d.origSize;
      if (d.kind === 'wallSize' && dev.size) {
        var panel = null;
        dev.group.traverse(function (o) { if (o.userData && o.userData.eqPart === 'wallPanel') panel = o; });
        if (panel) {
          panel.geometry.dispose();
          panel.geometry = new T.BoxGeometry(dev.size[0], dev.size[1], dev.size[2]);
          panel.position.y = dev.size[1] / 2;
        }
        dev.dims = dev.size.slice();
      }
    }
    E.drag = null; hideHud(); refreshAfterChange();
  }

  /* ---------------- 运行动画（包装钩子，不触碰 sim.js） ---------------- */
  /* 路线运行时把路径上的设备标记 engaged，使其按自身功能动作参与仿真 */
  function setEngaged(ids, on) {
    (ids || []).forEach(function (id) {
      var d = devById(id);
      if (d) d.engaged = !!on;
    });
  }
  function clearEngaged() {
    E.devices.forEach(function (d) { d.engaged = false; });
  }
  /* 只改显示、不改功能：隐藏收发器后其绑定、吐货 / 收货逻辑完全保留 */
  function applyVisibility() {
    E.devices.forEach(function (d) {
      if (!d.group) return;
      if (d.type === 'emitter' || d.type === 'receiver') d.group.visible = !E.hideTerminals;
    });
  }
  function setHidden(kind, on) {
    if (kind === 'terminals') E.hideTerminals = !!on;
    else return false;
    applyVisibility(); save();
    return E.hideTerminals;
  }
  /* 外形检测门光幕颜色（红 / 绿），可在设备面板切换 */
  function setGateColor(id, color) {
    var d = devById(id || E.selected);
    if (!d || d.type !== 'gate') return false;
    d.gateColor = color === 'red' ? 'red' : 'green';
    var meta = d.group && d.group.userData && d.group.userData.eqMeta;
    if (meta) {
      var hex = d.gateColor === 'red' ? 0xef4444 : 0x22c55e;
      if (meta.curtainMat) meta.curtainMat.color.setHex(hex);
      if (meta.doorFrameMat) meta.doorFrameMat.color.setHex(hex);
      meta.curtainColor = d.gateColor;
    }
    save(); updateDevPanel();
    toast('外形检测门光幕 → ' + (d.gateColor === 'red' ? '红色' : '绿色'));
    return true;
  }
  /* 收集场景内所有可见货物的世界（模型）坐标，用于检测门触发判定。
     只读取，不改动任何承载体或运动状态机。 */
  function cargoPoints() {
    var out = [], v = new T.Vector3(), root = WAP.scene.S.modelRoot;
    function push(x, y, z) { if (isFinite(x) && isFinite(y) && isFinite(z)) out.push({ x: x, y: y, z: z }); }
    var c = WAP.carrier;
    if (c) {
      (c.runners || []).forEach(function (r) { if (r.unit && r.unit.visible) push(r.x, r.y, r.z); });
      (c.rest || []).forEach(function (q) { if (q.unit && q.unit.visible) push(q.x, q.y, q.z); });
    }
    var rt = WAP.routes;
    if (rt && rt.cargoPoints) rt.cargoPoints().forEach(function (p) { push(p.x, p.y, p.z); });
    ((WAP.sim && WAP.sim.devices) || []).forEach(function (a) {
      if (!a.carry || !a.carry.visible) return;
      a.carry.getWorldPosition(v); root.worldToLocal(v); push(v.x, v.y, v.z);
    });
    ((WAP.sim && WAP.sim.lifts) || []).forEach(function (lf) {
      [lf.unit, lf.transfer].forEach(function (u) {
        if (!u || !u.visible) return;
        u.getWorldPosition(v); root.worldToLocal(v); push(v.x, v.y, v.z);
      });
    });
    return out;
  }
  function tickGates(dt, pts) {
    E.devices.forEach(function (d) {
      if (d.type !== 'gate' || !d.group) return;
      var meta = d.group.userData && d.group.userData.eqMeta;
      if (!meta || !meta.curtain) return;
      var H = meta.height || 2.64;
      var halfW = (d.dims && d.dims[0] ? d.dims[0] : 1.8) * 0.5 + 0.25;
      var near = false;
      for (var i = 0; i < pts.length; i++) {
        var p = pts[i];
        /* 门面在 z=0（法线沿 Z）：货物沿 Z 穿过门中心即触发 */
        if (Math.abs(p.x - d.x) < halfW && Math.abs(p.z - d.z) < 1.05 &&
            p.y > 0.10 && p.y < H + 0.35) { near = true; break; }
      }
      /* 进入检测截面才触发一次；货物停在门里不会无限续亮 */
      if (near && !d.gateInside) d.gateUntil = E.t + 5;
      d.gateInside = near;
      var on = E.t < (d.gateUntil || 0);
      meta.curtain.visible = on;
      if (on) meta.curtainMat.opacity = 0.5;
    });
  }
  function equipTick(dt) {
    E.t += dt;
    var run = !!(WAP.sim && WAP.sim.playing);
    E.devices.forEach(function (d) {
      if (d.anim && d.anim.step) d.anim.step(dt, run || !!d.engaged, E.t);
    });
    /* 门在「仿真 / 路线运行 / 货物静止」时都检测，不必依赖 sim.playing */
    tickGates(dt, cargoPoints());
  }
  function onRebuild() {
    if (!E.ready) return;
    rebuildDevices();
    syncLiftDevices();
    relocateLiftMarkers();   // 库体尺寸变化后，接驳标记紧跟塔位、不占无关格
    ensureValidCells();
    drawCellPick();           // 单货架选区随网格一起重定位
    if (E.selected) { updateMark(); updateDevPanel(); }
    renderCatalog();
  }

  /* ---------------- 设备面板 UI ---------------- */
  function icon(type) { return '<svg viewBox="0 0 40 30" aria-hidden="true">' + ICON[type] + '</svg>'; }
  function renderCatalog() {
    var box = $('equipCatalog');
    if (box) {
      /* 需求：设备目录只显示设备名称，不出现小字描述（说明放在 title 里） */
      box.innerHTML = ORDER.map(function (k) {
        var t = TYPES[k];
        return '<button type="button" class="eq-cat" data-type="' + k + '" title="' + esc(t.n) + '">' +
          '<span class="eq-cat-t"><b>' + esc(t.n) + '</b></span>' +
          '<em>' + t.code + '</em></button>';
      }).join('');
    }
    var list = $('equipList');
    if (list) {
      if (!E.devices.length) list.innerHTML = '<p class="eq-empty">尚未摆放设备。点击上方在四周移动格子中新增。</p>';
      else list.innerHTML = E.devices.map(function (d) {
        var cell = cellOf(d);
        var st = E.selected === d.id ? '选中' : (WAP.sim.playing ? '运行中' : '待机');
        return '<div class="eq-item' + (E.selected === d.id ? ' is-on' : '') + '" data-dev="' + esc(d.id) + '">' +
          '<i></i><div class="eq-item-b"><b>' + esc(d.name) + '</b><span>' + esc(cellLabel(cell)) + ' · ' + st + '</span></div>' +
          '<button type="button" class="eq-focus" data-focus="' + esc(d.id) + '" title="聚焦">◎</button></div>';
      }).join('');
    }
    var bi = $('equipBuiltin');
    if (bi) {
      var s = WAP.sim && WAP.sim.snapshot ? WAP.sim.snapshot() : { devices: [], lifts: [] };
      var lines = [];
      (s.devices || []).forEach(function (o) {
        lines.push('<div class="eq-builtin"><b>' + esc(o.name) + '</b><span>' + esc(o.level) + ' · 库内固定设备</span></div>');
      });
      var g = geom();
      var matched = (g.liftSites || []).filter(function (o) { return o.matched; }).length;
      lines.push('<div class="eq-builtin"><b>层间输送线 CV · ' + matched + ' 组</b><span>' +
        esc(cfg().levels) + ' 层 × ' + matched + ' 台提升机 · 末端对接主通道</span></div>');
      lines.push('<div class="eq-builtin"><b>提升机（库内 / 设备栏共用）</b><span>' +
        esc((g.liftSites || []).map(function (o) { return o.id; }).join(' / ')) + ' · 可在上方列表选中、删除</span></div>');
      bi.innerHTML = lines.join('');
    }
    var cnt = $('equipCount');
    if (cnt) cnt.textContent = E.devices.length + ' 台设备 / ' +
      ((geom() && geom().shuttles || 0)) + ' 台库内车';
    var ovCnt = $('ovDevCount');
    if (ovCnt) ovCnt.textContent = E.devices.length + ' 台';
  }

  function bindPanel() {
    var cat = $('equipCatalog');
    if (cat) cat.addEventListener('click', function (e) {
      var b = e.target.closest('[data-type]');
      if (b) add(b.dataset.type);
    });
    var list = $('equipList');
    if (list) list.addEventListener('click', function (e) {
      var f = e.target.closest('[data-focus]');
      if (f) { focus(f.dataset.focus); return; }
      var it = e.target.closest('[data-dev]');
      if (it) { select(it.dataset.dev, true); focus(it.dataset.dev); }
    });
    $('dpClose').addEventListener('click', deselect);
    $('dpEdit').addEventListener('click', function () { edit(!E.editMode); });
    $('dpFocus').addEventListener('click', function () { focus(E.selected); });
    $('dpRot90').addEventListener('click', function () { rotate(90); });
    $('dpCopy').addEventListener('click', copyDevice);
    $('dpUp').addEventListener('click', function () { stepLevel(1); });
    $('dpDown').addEventListener('click', function () { stepLevel(-1); });
    $('dpDel').addEventListener('click', function () { if (E.selected) remove(E.selected); });
    $('dpLiftSide').addEventListener('click', toggleLiftSide);
    $('dpLvMinus').addEventListener('click', function () { setLiftLevels(-1); });
    $('dpLvPlus').addEventListener('click', function () { setLiftLevels(1); });
    $('dpBoostMinus').addEventListener('click', function () { setLiftBoost(-1); });
    $('dpBoostPlus').addEventListener('click', function () { setLiftBoost(1); });
    $('dpMatch').addEventListener('click', matchConveyor);
    $('dpDeckMinus').addEventListener('click', function () { setPlatformDeck(-1); });
    $('dpDeckPlus').addEventListener('click', function () { setPlatformDeck(1); });
    $('dpSolid').addEventListener('click', function () { setPlatformSolid(true); });
    $('dpOutline').addEventListener('click', function () { setPlatformSolid(false); });
    $('dpPlat').querySelectorAll('[data-side]').forEach(function (b) {
      b.addEventListener('click', function () { setPlatformSide(b.dataset.side); });
    });
    if ($('dpWallDel')) $('dpWallDel').addEventListener('click', function () { if (E.selected) remove(E.selected); });
    /* 墙面三轴滑动轴 */
    [['dpWallW', 'w'], ['dpWallH', 'h'], ['dpWallD', 'd']].forEach(function (pair) {
      var el = $(pair[0]);
      if (el) el.addEventListener('input', function () { setWallSize(pair[1], el.value); });
    });
    if ($('dpWallRot')) $('dpWallRot').addEventListener('click', function () { rotate(90); });
    if ($('dpWallCopy')) $('dpWallCopy').addEventListener('click', copyDevice);
    $('dpPlatJoin').addEventListener('click', function () {
      var d = selectedDevice();
      if (!d || d.type !== 'platform') return;
      var p = adjacentPlatformPairs().filter(function (q) { return q.a === d.id || q.b === d.id; })[0];
      if (p) joinPlatforms(p.a, p.b);
    });
    /* 发货器 / 收货器：绑定由拖格自动完成，面板不再有 select */
    $('dpEmKind').addEventListener('change', function () { setTerminalOpt('kind', $('dpEmKind').value); });
    $('dpEmClass').addEventListener('change', function () { setTerminalOpt('class', $('dpEmClass').value); });
    $('dpEmRate').addEventListener('input', function () {
      setTerminalOpt('rate', $('dpEmRate').value);
      $('dpEmRateVal').textContent = Number($('dpEmRate').value).toFixed(1) + ' 秒/件';
    });
    /* 单货架 */
    $('dpSrPick').addEventListener('click', function () {
      if (E.selected) { startCellPick(E.selected); toast('在货位网格上点格子加入 / 移出选区（最多 4 格）'); }
    });
    $('dpSrClear').addEventListener('click', function () {
      var d = selectedDevice();
      if (!d || d.type !== 'single') return;
      d.singleCells = []; d.singleBuilt = false;
      rebuildOne(d);                       // 预览同步消失，不再残留任何格子
      save(); drawCellPick(); updateDevPanel(); renderCatalog();
      toast('已清空选格 · 可在货位网格上重新自选 1~4 格');
    });
    $('dpSrLvMinus').addEventListener('click', function () {
      var d = selectedDevice(); if (d) setSingleOpt('levels', (d.singleLevels || mainLevels()) - 1);
    });
    $('dpSrLvPlus').addEventListener('click', function () {
      var d = selectedDevice(); if (d) setSingleOpt('levels', (d.singleLevels || mainLevels()) + 1);
    });
    $('dpSrPitchMinus').addEventListener('click', function () {
      var d = selectedDevice(); if (d) setSingleOpt('pitch', (d.singlePitch || cfg().pitch) - 0.15);
    });
    $('dpSrPitchPlus').addEventListener('click', function () {
      var d = selectedDevice(); if (d) setSingleOpt('pitch', (d.singlePitch || cfg().pitch) + 0.15);
    });
    $('dpSrCargo').addEventListener('click', function () {
      var d = selectedDevice(); if (d) setSingleOpt('cargo', d.singleCargo === false);
    });
    $('dpSrKind').addEventListener('click', function () {
      var d = selectedDevice();
      if (!d || d.type !== 'single') return;
      var real = WAP.core.CARGO_REAL, cur = d.cargoKind || 'carton';
      var i = real.indexOf(cur);
      setSingleOpt('kind', real[(i + 1 + real.length) % real.length]);
    });
    $('dpSrConfirm').addEventListener('click', confirmSingleRack);
    ['dpEmDel', 'dpRcDel', 'dpSrDel', 'dpGateDel'].forEach(function (id) {
      var el = $(id);
      if (el) el.addEventListener('click', function () { if (E.selected) remove(E.selected); });
    });
    if ($('dpGateRed')) $('dpGateRed').addEventListener('click', function () { setGateColor(null, 'red'); });
    if ($('dpGateGreen')) $('dpGateGreen').addEventListener('click', function () { setGateColor(null, 'green'); });
    if ($('btnEquip')) $('btnEquip').addEventListener('click', function () { WAP.ctx.nav('equip'); });
    if ($('equipClear')) $('equipClear').addEventListener('click', function () {
      if (!E.devices.length) { toast('当前没有设备'); return; }
      E.devices.filter(function (d) { return d.type !== 'lift'; }).map(function (d) { return d.id; }).forEach(remove);
      toast('已清空外置设备（提升机需逐台删除）');
    });
  }
  function bindGlobal() {
    global.addEventListener('pointermove', onMove);
    global.addEventListener('pointerup', onUp);
    global.addEventListener('pointercancel', onUp);
    global.addEventListener('blur', cancelDrag);
    /* 双击设备直接打开编辑模式（库内提升机塔身也支持） */
    if (E.canvas) E.canvas.addEventListener('dblclick', function (e) {
      if (!E.ready) return;
      var S = WAP.scene.S;
      S.modelRoot.updateMatrixWorld(true);
      var dh = deviceHit(e);
      if (dh) { select(dh.id); edit(true); return; }
      var part = WAP.scene.pickPart(ndc(e));
      if (!part || part.kind !== 'lift') return;
      var o = part.hit.object, lid = null;
      while (o && !lid) { lid = o.userData && o.userData.liftId; o = o.parent; }
      if (lid && devByLiftId(lid)) { selectLift(lid); edit(true); }
    });
    global.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && E.drag) { cancelDrag(); e.stopImmediatePropagation(); return; }
      if (/^(INPUT|TEXTAREA|SELECT)$/.test((e.target.tagName || '').toUpperCase())) return;
      var dev = selectedDevice();
      /* 通用快捷键：只要选中设备就生效，不需要进入编辑模式 */
      if (dev && (e.ctrlKey || e.metaKey) && (e.key === 'v' || e.key === 'V')) {
        e.preventDefault(); copyDevice(); return;
      }
      if (dev && (e.key === 'Delete' || e.key === 'Backspace')) {
        e.preventDefault(); remove(dev.id); return;
      }
      if (!E.editMode || !E.selected) return;
      var cell = cellOf(dev);
      if (!dev || !cell || dev.type === 'wall') return;
      if (e.key === 'q' || e.key === 'Q') rotate(-90);
      else if (e.key === 'e' || e.key === 'E') rotate(90);
      else if (e.key === 'PageUp') stepLevel(1);
      else if (e.key === 'PageDown') stepLevel(-1);
      else {
        var axis = null, sign = 1;
        if (e.key === 'ArrowLeft') { axis = 'x'; sign = -1; }
        else if (e.key === 'ArrowRight') { axis = 'x'; sign = 1; }
        else if (e.key === 'ArrowUp') { axis = 'z'; sign = -1; }
        else if (e.key === 'ArrowDown') { axis = 'z'; sign = 1; }
        if (!axis) return;
        var wanted = (axis === 'x' ? cell.x : cell.z) + sign * CELL;
        var cand = E.cells.filter(function (q) {
          if (q.level !== cell.level) return false;
          var v = axis === 'x' ? q.x : q.z;
          var fixed = axis === 'x' ? q.z - cell.z : q.x - cell.x;
          return Math.abs(v - wanted) < 0.05 && Math.abs(fixed) < 0.05;
        })[0];
        if (cand && canPlace(dev, cand)) { placeOnCell(cand.key); e.preventDefault(); }
      }
    });
  }

  /* ---------------- 启动 ---------------- */
  function init() {
    E.canvas = $('c');
    E.rc = new T.Raycaster();
    E.v2 = new T.Vector2();
    var S = WAP.scene.S;
    E.root = new T.Group(); E.root.userData.kind = 'equipment';
    E.gridRoot = new T.Group(); E.gridRoot.visible = false;
    E.gizmoRoot = new T.Group(); E.gizmoRoot.visible = false;
    E.markRoot = new T.Group(); E.markRoot.visible = false;
    E.wallRoot = new T.Group(); E.wallRoot.visible = false;
    E.snapRoot = new T.Group(); E.snapRoot.visible = true;
    E.cellRoot = new T.Group(); E.cellRoot.visible = false;
    E.slotRoot = new T.Group(); E.slotRoot.visible = false;
    E.groundProxyGeo = new T.BoxGeometry(CELL * 0.92, 0.08, CELL * 0.92);
    E.groundProxyGeo.userData.shared = true;
    S.modelRoot.add(E.root, E.gridRoot, E.gizmoRoot, E.markRoot, E.wallRoot,
      E.snapRoot, E.cellRoot, E.slotRoot);
    S.onEquipDown = onDown;
    S.onEquipMove = onCanvasMove;

    /* 只包装既有钩子，绝不改写 sim.js 内部运动逻辑 */
    var prevTick = S.onTick;
    S.onTick = function (dt) { if (prevTick) prevTick(dt); equipTick(dt); };
    var prevRebuild = WAP.sim.onRebuild;
    WAP.sim.onRebuild = function () { prevRebuild(); onRebuild(); };

    load();
    E.ready = true;
    rebuildDevices();
    syncLiftDevices();
    ensureValidCells();
    if (WAP.ui.showDeviceDock) WAP.ui.showDeviceDock(false);
    renderCatalog();
    bindPanel();
    bindGlobal();
  }

  WAP.equipment = {
    init: init, add: add, remove: remove, select: select, selectLift: selectLift,
    deselect: deselect, edit: edit, focus: focus, rotate: rotate, stepLevel: stepLevel,
    placeOnCell: placeOnCell, onRebuild: onRebuild,
    setLiftLevels: setLiftLevels, setLiftBoost: setLiftBoost, matchConveyor: matchConveyor,
    toggleLiftSide: toggleLiftSide, copyDevice: copyDevice, addLift: addLift,
    setPlatformDeck: setPlatformDeck, setPlatformSide: setPlatformSide, setPlatformSolid: setPlatformSolid,
    joinPlatforms: joinPlatforms, adjacentPlatformPairs: adjacentPlatformPairs,
    setWallSize: setWallSize, snapWallEdges: snapWallEdges, wallBox: wallBox,
    wallMax: function () { return WALL_MAX.slice(); },
    setTerminalOpt: setTerminalOpt, terminalPoint: terminalPoint,
    startCellPick: startCellPick, stopCellPick: stopCellPick, toggleCellPick: toggleCellPick,
    setSingleOpt: setSingleOpt, confirmSingleRack: confirmSingleRack,
    slotCells: function () { return E.slotCells.slice(); },
    slotCellFor: function (key) { return E.slotMap[key] || null; },
    get cellPick() { return E.cellPick; },
    get editMode() { return E.editMode; },
    get vTypes() { return Object.keys(VIRTUAL); },
    preferredRing: preferredRing, liftAnchorCells: liftAnchorCells,
    catalog: function () { return ORDER.map(function (k) { return { type: k, name: TYPES[k].n, desc: TYPES[k].d, code: TYPES[k].code }; }); },
    liftNearMouth: function (id) { return liftNearMouth(devById(id) || selectedDevice()); },
    setPickGrid: setPickGrid, setEngaged: setEngaged, clearEngaged: clearEngaged,
    setHidden: setHidden, setGateColor: setGateColor, cargoPoints: cargoPoints,
    setDestackerStack: setDestackerStack, destackerStackOf: destackerStackOf,
    refreshPanel: updateDevPanel,
    get hideTerminals() { return E.hideTerminals; },
    dockCells: function () {
      return E.cells.filter(function (c) { return c.kind === 'ground' && c.dockLift; })
        .map(function (c) { return { key: c.key, liftId: c.dockLift, side: c.dockSide,
          x: c.x, z: c.z, base: c.base, ring: c.ring }; });
    },
    dockCellFor: function (liftId, side) {
      var want = side || 'front';
      for (var i = 0; i < E.cells.length; i++) {
        var c = E.cells[i];
        if (c.kind === 'ground' && c.dockLift === liftId && c.dockSide === want) return c;
      }
      return null;
    },
    snapshot: function () {
      var g = geom(), c = cfg();
      return {
        count: E.devices.length, cells: E.cells.length, rings: RINGS,
        groundCells: E.cells.filter(function (x) { return x.kind === 'ground'; }).length,
        platformCells: E.cells.filter(function (x) { return x.kind === 'platform'; }).length,
        platforms: E.devices.filter(function (d) { return d.type === 'platform'; }).length,
        selected: E.selected, editMode: E.editMode, hasPlatform: hasPlatform(),
        liftSites: (g.liftSites || []).map(function (s) {
          return { id: s.id, i: s.i, side: s.side, bIdx: s.bIdx, z: s.z,
            matched: s.matched, lv: s.lv, boost: s.boost,
            convFrom: s.convFrom, convTo: s.convTo, convZ: s.convZ, mainZ: s.mainZ };
        }),
        convCells: g ? Object.keys(g.convCell || {}).length : 0,
        tracks: g ? g.tracks.slice() : [],
        depths: c.depths.slice(), liftCols: c.liftCols ? c.liftCols.slice() : null,
        platformPairs: adjacentPlatformPairs(), snapPicks: E.snapPicks.length,
        wallMax: WALL_MAX.slice(), wallFacePicks: E.wallPicks.length,
        liftAnchors: liftAnchorCells().map(function (q) { return { key: q.key, x: q.x, z: q.z }; }),
        gridSnap: gridSnap(),
        dockCells: E.cells.filter(function (c) { return c.kind === 'ground' && c.dockLift; })
          .map(function (q) { return { key: q.key, liftId: q.dockLift, side: q.dockSide, x: q.x, z: q.z, base: q.base }; }),
        devices: E.devices.map(function (d) {
          var cell = cellOf(d);
          return {
            id: d.id, type: d.type, code: d.code, name: d.name,
            cellKey: d.cellKey, level: cell ? cell.level : -1,
            x: d.x, y: d.y, z: d.z, yaw: d.yaw, demo: !!d.demo,
            liftId: d.liftId || null, deck: d.deck || 0, solid: d.solid !== false,
            size: d.size ? d.size.slice() : null, free: d.free ? { x: d.free.x, y: d.free.y, z: d.free.z } : null,
            joined: d.joined || null, dims: d.dims.slice(), template: !!d.template,
            bindId: d.bindId || null, cargoKind: d.cargoKind || null,
            cargoClass: d.cargoClass || null, rate: d.rate == null ? 2.5 : d.rate,
            singleCells: (d.singleCells || []).slice(), singleLevels: d.singleLevels || mainLevels(),
            singlePitch: d.singlePitch || null, singleCargo: d.singleCargo !== false,
            singleBuilt: !!d.singleBuilt,
            virtual: !!VIRTUAL[d.type], point: terminalPoint(d)
          };
        }),
        emitters: E.devices.filter(function (d) { return d.type === 'emitter'; }).map(function (d) {
          return { id: d.id, name: d.name, bindId: d.bindId || null,
            cargoKind: d.cargoKind, cargoClass: d.cargoClass, rate: d.rate,
            point: terminalPoint(d) };
        }),
        receivers: E.devices.filter(function (d) { return d.type === 'receiver'; }).map(function (d) {
          var c = E.cellMap[d.cellKey];
          return { id: d.id, name: d.name, bindId: d.bindId || null, point: terminalPoint(d),
            /* 自身所在格：无论是否绑定设备，货物到了这里同样必须被收走 */
            own: { x: c ? c.x : d.x, y: 0.86, z: c ? c.z : d.z } };
        }),
        singles: E.devices.filter(function (d) { return d.type === 'single'; }).map(function (d) {
          var built = d.group && d.group.userData && d.group.userData.eqMeta
            ? d.group.userData.eqMeta : {};
          return { id: d.id, name: d.name, cells: (d.singleCells || []).slice(),
            snapped: (built.cells || []).slice(), levels: d.singleLevels || mainLevels(),
            pitch: d.singlePitch || c.pitch, cargo: d.singleCargo !== false,
            built: !!d.singleBuilt, preview: !!built.cargoCount,
            cargoCount: built.cargoCount || 0, meshes: d.group ? d.group.children.length : 0 };
        }),
        cellPick: E.cellPick,
        slotCells: E.slotCells.length,
        slotGridVisible: !!(E.slotRoot && E.slotRoot.visible),
        slotPicks: E.slotPicks.length,
        cells: E.cells.map(function (x) {
          return { key: x.key, kind: x.kind, level: x.level, deck: x.deck, y: x.y,
            x: x.x, z: x.z, ring: x.ring, base: x.base, platform: x.platform,
            platformId: x.platformId, recommend: x.recommend,
            dockLift: x.dockLift || null, dockSide: x.dockSide || null };
        })
      };
    },
    get devices() { return E.devices; },
    get cells() { return E.cells; },
    get root() { return E.root; },
    get gridPicks() { return E.gridPicks; },
    get gridRoot() { return E.gridRoot; },
    get pickGrid() { return E.pickGrid; },
    get editMode() { return E.editMode; },
    get selected() { return E.selected; },
    get dragKind() { return E.drag ? E.drag.kind : null; },
    get debugDrag() { return E.drag ? {
      kind: E.drag.kind, id: E.drag.id, planeY: E.drag.planeY,
      target: E.drag.target ? E.drag.target.key : null,
      sx: E.drag.sx, sy: E.drag.sy, moved: E.drag.moved
    } : null; }
  };
})(window);
