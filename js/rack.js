/* WAP-Eavan · rack.js
   四向穿梭车立体库 3D 建模。吸收参考平台 G 区建模思路后全新实现：
   立柱片 / 横梁 / 子巷轨道 / 主轨道 / 横向通道 / 提升机 / 安全护网 /
   充电区 / 托盘货物 / 晶格框块（货位线框）/ 拾取代理。 */
(function (global) {
  'use strict';
  var WAP = global.WAP = global.WAP || {};
  var T = global.THREE;

  var COL = {
    beam: 0xf08a2c,
    rail: 0x9fb0c4,
    railMain: 0x7c8fa8,
    lift: 0xf2c200,
    liftTop: 0x2b3446,
    conv: 0x68788e,
    pallet: 0x414c60,
    carton: 0xb9823f,
    crate: 0x2b5fc4,
    crate2: 0x1c47a4,
    charger: 0xe04b4b,
    shuttle: 0x2a6fd6,
    ao: 0x8899b4
  };
  var UPR = {
    blue: 0x1c4bc4, gray: 0x93a1b5, orange: 0xef8a2c, green: 0x2f9e6e,
    yellow: 0xe3b505, red: 0xd64545, white: 0xdde5ef, black: 0x3a4557
  };
  var CRYSTAL = { free: 0x38bdf8, used: 0xf7a93b, chg: 0xef5b5b, wall: 0xa78bfa, conv: 0x2f3d50, outer: 0x4f46e5 };
  var MM = WAP.materials;

  function mat(color, opts) {
    return new T.MeshStandardMaterial(Object.assign({
      color: color, roughness: 0.62, metalness: 0.14,
      envMap: MM.envMap, envMapIntensity: 0.7
    }, opts || {}));
  }

  /* 麻布包枕形几何：面中心向外鼓胀、四角收紧，配合六面麻布贴图形成鼓袋立体感。
     每次构建新建（clearModel 会释放几何），成本极低。 */
  function sackGeometry() {
    var g = new T.BoxGeometry(1, 1, 1, 3, 3, 3);
    var p = g.attributes.position;
    for (var i = 0; i < p.count; i++) {
      var vx = p.getX(i) * 2, vy = p.getY(i) * 2, vz = p.getZ(i) * 2;
      var r2 = (vx * vx + vy * vy + vz * vz) / 3;   // 角≈1，面心≈1/3
      var s = 1 + 0.22 * (1 - r2);
      p.setXYZ(i, p.getX(i) * s, p.getY(i) * s, p.getZ(i) * s);
    }
    p.needsUpdate = true;
    g.computeVertexNormals();
    return g;
  }

  /* ---------------- 四向穿梭车（静态展示与运行仿真共用同一套模型） ----------------
     参考 World Rack 款式：蓝色烤漆六面贴图车身、可升降 60 mm 的不锈钢花纹台板、
     两组互相垂直的四向轮、黄色保险杠、前后状态灯、传感器与急停细节。 */
  function buildShuttle(cfg) {
    var w = cfg.shW / 100, l = cfg.shL / 100;
    var g = new T.Group();
    var bodyH = 0.15;

    var body = new T.Mesh(new T.BoxGeometry(w, bodyH, l), MM.shuttleFaces(cfg.shuttleColor));
    body.position.y = bodyH / 2;
    body.userData.shuttleBody = true;       // 换色时只替换这一处的材质数组
    body.castShadow = true; body.receiveShadow = true;
    g.add(body);

    /* 底盘下沿（车体嵌入轨道槽内） */
    var base = new T.Mesh(new T.BoxGeometry(w * 0.92, 0.035, l * 0.94), MM.shuttleDark());
    base.position.y = 0.018;
    g.add(base);

    /* 升降台板：托盘随台板一起举升 */
    var plate = new T.Group();
    plate.position.y = bodyH + 0.015;
    /* 台板主体为蓝色烤漆；两侧才是承托托盘的不锈钢花纹防滑垫（参考站做法） */
    var deck = new T.Mesh(new T.BoxGeometry(w * 0.94, 0.026, l * 0.93), MM.shuttleDeckBody(cfg.shuttleColor));
    deck.userData.shuttleDeck = true;
    deck.castShadow = true; deck.receiveShadow = true;
    plate.add(deck);
    [-1, 1].forEach(function (sx) {
      var strip = new T.Mesh(new T.BoxGeometry(w * 0.18, 0.008, l * 0.9), MM.shuttleDeck());
      strip.position.set(sx * w * 0.37, 0.017, 0);
      plate.add(strip);
    });
    /* 检修盖缝与状态窗 */
    var seamMat = MM.shuttleDark(), lidW = w * 0.52, lidL = l * 0.46;
    [[0, lidL / 2, lidW, 0.010], [0, -lidL / 2, lidW, 0.010],
     [lidW / 2, 0, 0.010, lidL], [-lidW / 2, 0, 0.010, lidL]].forEach(function (p) {
      var seam = new T.Mesh(new T.BoxGeometry(p[2], 0.006, p[3]), seamMat);
      seam.position.set(p[0], 0.018, p[1]);
      plate.add(seam);
    });
    [-0.09, 0.09].forEach(function (dz) {
      var win = new T.Mesh(new T.BoxGeometry(w * 0.10, 0.006, l * 0.05), MM.shuttleSteel());
      win.position.set(w * 0.12, 0.019, dz);
      plate.add(win);
    });
    [-0.3, 0, 0.3].forEach(function (dx) {
      var rib = new T.Mesh(new T.BoxGeometry(0.045, 0.028, l * 0.9), MM.shuttleSteel());
      rib.position.set(dx * w, -0.014, 0);
      plate.add(rib);
    });
    g.add(plate);

    /* 四向轮组：每个角一组「沿 X 行驶」＋一组「沿 Z 行驶」的轮子 */
    var wheelMat = MM.shuttleWheel();
    var wr = 0.045, wt = 0.032;
    var wheelGeo = new T.CylinderGeometry(wr, wr, wt, 12);
    [-1, 1].forEach(function (sx) {
      [-1, 1].forEach(function (sz) {
        var px = sx * w * 0.43, pz = sz * l * 0.42;
        var wx = new T.Mesh(wheelGeo, wheelMat);
        wx.rotation.x = Math.PI / 2;                 // 轮轴沿 Z → 沿 X 行驶
        wx.position.set(px, wr, pz);
        g.add(wx);
        var wz = new T.Mesh(wheelGeo, wheelMat);
        wz.rotation.z = Math.PI / 2;                 // 轮轴沿 X → 沿 Z 行驶
        wz.position.set(px, wr, pz + sz * 0.075);
        g.add(wz);
      });
    });

    /* 四角黄色缓冲块 */
    var bumpMat = MM.shuttleBumper();
    [-1, 1].forEach(function (sx) {
      [-1, 1].forEach(function (sz) {
        var b = new T.Mesh(new T.BoxGeometry(0.06, 0.11, 0.06), bumpMat);
        b.position.set(sx * w * 0.48, 0.09, sz * l * 0.49);
        g.add(b);
      });
    });

    /* 状态灯（每台车独立材质，可单独变色） */
    var lampMat = MM.shuttleLamp();
    [-1, 1].forEach(function (sz) {
      [[0, bodyH + 0.028, sz * l * 0.52, w * 0.30, 0.022, 0.018],
       [0, 0.055, sz * l * 0.505, w * 0.46, 0.032, 0.024]].forEach(function (p) {
        var led = new T.Mesh(new T.BoxGeometry(p[3], p[4], p[5]), lampMat);
        led.position.set(p[0], p[1], p[2]);
        g.add(led);
      });
    });

    /* 前端激光避障探头外壳 */
    var sensor = new T.Mesh(new T.BoxGeometry(0.13, 0.055, 0.035), MM.shuttleDark());
    sensor.position.set(0, 0.10, l * 0.505);
    g.add(sensor);
    var lens = new T.Mesh(new T.BoxGeometry(0.055, 0.024, 0.012), new T.MeshBasicMaterial({ color: 0xe8503f, toneMapped: false }));
    lens.position.set(0.032, 0.10, l * 0.526);
    g.add(lens);

    return { group: g, plate: plate, lamp: lampMat, deckY: plate.position.y, w: w, l: l };
  }

  /* InstancedMesh 支持材质数组（BoxGeometry 六面各自贴图）、任意轴旋转、
     逐实例明暗微调与阴影投射。cid 用于把实例映射到货位，供运行时局部显隐。 */
  function makeInstances(geo, material, list, kind, opt) {
    if (!list.length) return null;
    opt = opt || {};
    var m = new T.InstancedMesh(geo, material, list.length);
    var d = new T.Object3D();
    var col = new T.Color();
    for (var i = 0; i < list.length; i++) {
      var o = list[i];
      d.position.set(o.x, o.y, o.z);
      d.scale.set(o.sx, o.sy, o.sz);
      d.rotation.set(o.rx || 0, o.ry || 0, o.rz || 0);
      d.updateMatrix();
      m.setMatrixAt(i, d.matrix);
      if (opt.tint) {
        var v = 0.90 + 0.10 * WAP.core.hash(i * 3.71 + (opt.tintSeed || 0));
        col.setRGB(v, v, v);
        m.setColorAt(i, col);
      }
    }
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
    m.frustumCulled = false;
    m.castShadow = opt.shadow !== false;
    m.receiveShadow = opt.shadow !== false;
    m.userData.kind = kind || 'frame';
    m.userData.cids = list.map(function (o) { return o.cid || null; });
    return m;
  }

  function boxEdges(buf, cx, cy, cz, sx, sy, sz, color) {
    var hx = sx / 2, hy = sy / 2, hz = sz / 2;
    var v = [
      [-hx, -hy, -hz], [hx, -hy, -hz], [hx, hy, -hz], [-hx, hy, -hz],
      [-hx, -hy, hz], [hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz]
    ];
    var e = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
    var c = new T.Color(color);
    for (var i = 0; i < e.length; i++) {
      var a = v[e[i][0]], b = v[e[i][1]];
      buf.pos.push(cx + a[0], cy + a[1], cz + a[2], cx + b[0], cy + b[1], cz + b[2]);
      buf.col.push(c.r, c.g, c.b, c.r, c.g, c.b);
    }
  }

  function lineGeometry(buf) {
    var g = new T.BufferGeometry();
    g.setAttribute('position', new T.Float32BufferAttribute(buf.pos, 3));
    g.setAttribute('color', new T.Float32BufferAttribute(buf.col, 3));
    return g;
  }

  function addNet(group, w, h, cx, cy, cz, rotY, baseTex) {
    var tex = baseTex.clone();
    tex.needsUpdate = true;
    tex.repeat.set(Math.max(1, w / 0.8), Math.max(1, h / 0.8));
    var m = new T.Mesh(
      new T.PlaneGeometry(w, h),
      new T.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0.30, side: T.DoubleSide, depthWrite: false, toneMapped: false })
    );
    m.position.set(cx, cy, cz);
    m.rotation.y = rotY;
    m.renderOrder = 4;
    group.add(m);
  }

  /* 单一数据源：某货位实际使用的货物种类（供建模与货位信息卡共用） */
  function cargoKindOf(cell) {
    var ov = WAP.state.cargoOverrides || {};
    var k = ov[cell.id];
    if (k && k !== 'auto' && WAP.core.CARGO_REAL.indexOf(k) >= 0) return k;
    var gk = WAP.state.cfg.cargoType;
    if (gk !== 'mix' && WAP.core.CARGO_REAL.indexOf(gk) >= 0) return gk;
    var h = WAP.core.hash(cell.l * 7.13 + cell.i * 3.77 + cell.b * 11.9 + cell.k * 5.31 + 1.7);
    var real = WAP.core.CARGO_REAL;
    return real[Math.min(real.length - 1, Math.floor(h * real.length))];
  }
  /* 货物大类（托盘组合）：单货位覆盖 > 全局配置 */
  function cargoClassOf(cell) {
    var ov = WAP.state.cargoClassOverrides || {};
    var k = cell && ov[cell.id];
    if (k && k !== 'auto' && WAP.core.CARGO_CLASS_KEYS.indexOf(k) >= 0) return k;
    var g = WAP.state.cfg.cargoClass;
    return WAP.core.CARGO_CLASS_KEYS.indexOf(g) >= 0 ? g : 'single';
  }

  /* ---------------- 单一货源：静态实例与在途货物共用同一份外观 ----------------
     货架上的货物、四向车搬运的货物、提升机载货台上的货物、层间输送线缓存位的货物
     全部由 cargoUnitParts() 生成，尺寸 / 贴图 / 麻布包堆叠 / 料箱盖完全一致，
     因此货物在「货架 ↔ 提升机 ↔ 输送线」之间流转时不会发生任何外观变化。 */
  var UNIT_BOX = null, UNIT_SACK = null;
  function unitGeo() {
    if (!UNIT_BOX) {
      UNIT_BOX = new T.BoxGeometry(1, 1, 1); UNIT_BOX.userData.shared = true;
      UNIT_SACK = sackGeometry(); UNIT_SACK.userData.shared = true;
    }
  }

  function cargoUnitParts(kind, cfg, g, seed, cls) {
    unitGeo();
    cls = cls || 'single';
    var bw = Math.min(1.2, cfg.bayW * 0.84);
    var bd = Math.min(1.0, cfg.dp * 0.86);
    var ch = Math.max(0.2, Math.min(g.loadH, cfg.pitch - 0.34));
    var parts = [];
    function part(key, geo, mat, x, y, z, sx, sy, sz, ry, rz) {
      parts.push({ key: key, geo: geo, mat: mat, x: x, y: y, z: z,
        sx: sx, sy: sy, sz: sz, ry: ry || 0, rz: rz || 0 });
    }
    /* 空托盘大类：光子托盘（棕）/ 光母托盘（银），完全没有货物箱体 */
    if (cls === 'sub' || cls === 'mother') {
      var isSub = cls === 'sub';
      part(isSub ? 'palletSub' : 'palletMother', UNIT_BOX,
        isSub ? MM.palletSub() : MM.palletMother(),
        0, 0.055, 0, bw * (isSub ? 0.92 : 1.06), 0.11, bd * (isSub ? 0.92 : 1.06));
      return parts;
    }
    /* 无托盘单货物：货物直接坐在货位梁面上，不带任何托盘；
       子母托盘：下银母托盘 + 上棕子托盘，货物再叠在上面。 */
    var baseY;
    if (cls === 'combo') {
      part('palletMother', UNIT_BOX, MM.palletMother(), 0, 0.05, 0, bw * 1.06, 0.10, bd * 1.06);
      part('palletSub', UNIT_BOX, MM.palletSub(), 0, 0.145, 0, bw * 0.94, 0.09, bd * 0.94);
      baseY = 0.19;
      ch = Math.max(0.2, Math.min(ch, cfg.pitch - 0.55));   // 两层托盘更高，货箱相应收矮
    } else {
      baseY = 0.02;
    }
    var by = baseY + ch / 2;
    if (kind === 'sack') {
      var sw = bw * 0.47, sd = bd * 0.44, sh = Math.max(0.14, Math.min(ch * 0.46, 0.34));
      var y0 = baseY + sh / 2;
      for (var r = 0; r < 2; r++) {
        for (var cc = 0; cc < 2; cc++) {
          var pk = r * 2 + cc + seed * 0.37;
          part('sack', UNIT_SACK, MM.sackFaces(),
            (cc ? 1 : -1) * bw * 0.245, y0, (r ? 1 : -1) * bd * 0.235,
            sw, sh, sd,
            (WAP.core.hash(pk + 2.1) - 0.5) * 0.20,
            (WAP.core.hash(pk + 8.7) - 0.5) * 0.08);
        }
      }
      if (ch > 0.40) {
        for (var t = 0; t < 2; t++) {
          part('sack', UNIT_SACK, MM.sackFaces(),
            (t ? 1 : -1) * bw * 0.20, y0 + sh * 0.96, 0,
            bw * 0.44, sh * 0.86, bd * 0.70,
            Math.PI / 2 + (WAP.core.hash(seed + t * 3.3) - 0.5) * 0.14,
            (WAP.core.hash(seed * 1.9 + t) - 0.5) * 0.07);
        }
      }
    } else if (kind === 'carton') {
      var wrap = WAP.core.hash(seed * 1.37 + 9) > 0.42;
      part(wrap ? 'wrap' : 'carton', UNIT_BOX, wrap ? MM.wrapFaces() : MM.cartonFaces(),
        0, by, 0, bw, ch, bd);
    } else if (kind === 'crate') {
      part('crate', UNIT_BOX, MM.crateFaces(), 0, by, 0, bw, ch, bd);
      part('crateLid', UNIT_BOX, MM.crateLid(), 0, baseY + ch + 0.016, 0, bw * 0.96, 0.032, bd * 0.96);
    } else {
      var key = kind === 'metal' ? 'metal' : 'foam';
      var mat = kind === 'metal' ? MM.metalFaces() : MM.foamFaces();
      part(key, UNIT_BOX, mat, 0, by, 0, bw, ch, bd);
    }
    return parts;
  }

  /* 生成一个独立货物单元（原点在货位中心、y=0 为该层梁面） */
  function makeCargoUnit(kind, seed, cls) {
    var parts = cargoUnitParts(kind, WAP.state.cfg, WAP.state.geom, seed || 0,
      cls || WAP.state.cfg.cargoClass || 'single');
    var grp = new T.Group();
    grp.userData.kind = 'cargo';
    grp.userData.cargoClass = cls || WAP.state.cfg.cargoClass || 'single';
    parts.forEach(function (p) {
      var m = new T.Mesh(p.geo, p.mat);
      m.position.set(p.x, p.y, p.z);
      m.scale.set(p.sx, p.sy, p.sz);
      m.rotation.set(0, p.ry, p.rz);
      m.castShadow = true; m.receiveShadow = true;
      m.userData.kind = 'cargo';
      grp.add(m);
    });
    return grp;
  }

  /* 给一个容器换上指定种类的货物（用于提升机载货台 / 输送线缓存位 / 转运动画） */
  function setUnitSkin(holder, kind, seed, cls) {
    var cc = cls || WAP.state.cfg.cargoClass || 'single';
    if (holder.userData.cargoKind === kind && holder.userData.cargoClass === cc) return;
    while (holder.children.length) holder.remove(holder.children[0]);
    holder.add(makeCargoUnit(kind, seed, cc));
    holder.userData.cargoKind = kind;
    holder.userData.cargoClass = cc;
  }

  /* ---------------- 四向车换色 ----------------
     只替换车身六面贴图与升降台板主体的材质（贴图结构完全一致，仅主色不同），
     不改任何几何 / 位置 / 运动状态，因此 sim.js 的调度完全不受影响。 */
  function setShuttleColor(id, key) {
    var list = (WAP.sim && WAP.sim.devices) || [];
    var colors = WAP.state.shuttleColors || (WAP.state.shuttleColors = {});
    if (WAP.core.SH_TINTS.indexOf(key) < 0) return false;
    if (id === 'all') colors.all = key;
    else colors[id] = key;
    WAP.core.saveShuttleColors(colors);
    var applied = 0;
    list.forEach(function (a) {
      var want = colors[a.id] || colors.all || WAP.state.cfg.shuttleColor || 'blue';
      paintShuttle(a, want); applied++;
    });
    return applied > 0;
  }
  function paintShuttle(a, key) {
    if (!a || !a.obj) return;
    var faces = MM.shuttleFaces(key), deck = MM.shuttleDeckBody(key);
    a.obj.traverse(function (o) {
      if (!o.isMesh) return;
      if (o.userData.shuttleBody) o.material = faces;
      else if (o.userData.shuttleDeck) o.material = deck;
    });
    a.obj.userData.shuttleColor = key;
  }
  /* 库体重建后 sim.buildDevices() 会重新造车，这里把用户选的颜色再套一遍 */
  function applyShuttleColors() {
    var colors = WAP.state.shuttleColors || {};
    ((WAP.sim && WAP.sim.devices) || []).forEach(function (a) {
      var key = colors[a.id] || colors.all || WAP.state.cfg.shuttleColor || 'blue';
      if (a.obj.userData.shuttleColor !== key) paintShuttle(a, key);
    });
  }
  /* 单货位大类覆盖 */
  function setCellClass(id, cls) {
    var ov = WAP.state.cargoClassOverrides || (WAP.state.cargoClassOverrides = {});
    if (cls === 'auto' || WAP.core.CARGO_CLASS_KEYS.indexOf(cls) < 0) delete ov[id];
    else ov[id] = cls;
    WAP.core.saveCargoClassOverrides(ov);
  }
  function setCargoClass(cls) {
    if (WAP.core.CARGO_CLASS_KEYS.indexOf(cls) < 0) return false;
    WAP.state.cfg.cargoClass = cls;
    WAP.core.save(WAP.state.cfg);
    return true;
  }

  /* ---------------- 主构建 ---------------- */
  function build(cfg, g) {
    var root = new T.Group();
    var frame = new T.Group();      // 结构：立柱、横梁、轨道、提升机、护网
    var cargo = new T.Group();      // 托盘货物
    var crystal = new T.Group();    // 晶格框块
    var pickables = [];
    root.add(frame, cargo, crystal);

    var uprColor = UPR[cfg.upr] || UPR.blue;
    var uprMat = MM.upright(uprColor);
    var beamMat = MM.beam();
    var railMat = MM.rail();
    var liftMat = MM.lift();
    var liftTopMat = MM.liftTop();
    var footMat = MM.foot();
    var platformMat = MM.platform();

    /* 1. 立柱片：每个 BAY 边界 × 每个站位 */
    var uprList = [];
    var xLines = [];
    g.gEdges.forEach(function (seg) {
      var n = Math.round((seg[1] - seg[0]) / cfg.bayW);
      for (var k = 0; k <= n; k++) xLines.push(seg[0] + k * cfg.bayW);
    });
    xLines.forEach(function (xx) {
      g.stations.forEach(function (zz) {
        uprList.push({ x: xx, y: g.top / 2, z: zz, sx: 0.09, sy: g.top, sz: 0.09 });
      });
    });
    var uprMesh = makeInstances(new T.BoxGeometry(1, 1, 1), uprMat, uprList, 'frame');
    if (uprMesh) { frame.add(uprMesh); pickables.push(uprMesh); }

    /* 柱脚底板 */
    var footList = [];
    xLines.forEach(function (xx) {
      g.stations.forEach(function (zz) { footList.push({ x: xx, y: 0.012, z: zz, sx: 0.24, sy: 0.024, sz: 0.24 }); });
    });
    var footMesh = makeInstances(new T.BoxGeometry(1, 1, 1), footMat, footList, 'frame');
    if (footMesh) frame.add(footMesh);

    /* 2. 横梁：每层 × 每个 BAY 分段 × 每个站位 */
    var beamList = [];
    for (var l = 0; l < cfg.levels; l++) {
      var y = cfg.y0 + l * cfg.pitch;
      g.gEdges.forEach(function (seg) {
        g.stations.forEach(function (zz) {
          beamList.push({
            x: (seg[0] + seg[1]) / 2, y: y - 0.22, z: zz,
            sx: seg[1] - seg[0], sy: 0.15, sz: 0.10
          });
        });
      });
    }
    var beamMesh = makeInstances(new T.BoxGeometry(1, 1, 1), beamMat, beamList, 'frame');
    if (beamMesh) { frame.add(beamMesh); pickables.push(beamMesh); }

    /* 顶部横向拉杆 */
    var capList = [];
    g.gEdges.forEach(function (seg) {
      g.stations.forEach(function (zz) {
        capList.push({ x: (seg[0] + seg[1]) / 2, y: g.top - 0.09, z: zz, sx: seg[1] - seg[0], sy: 0.12, sz: 0.11 });
      });
    });
    var capMesh = makeInstances(new T.BoxGeometry(1, 1, 1), uprMat, capList, 'frame');
    if (capMesh) frame.add(capMesh);

    /* 3. 子巷轨道：每个 BAY × 每个储区 × 每层，两条导轨 */
    var railList = [];
    for (var lv = 0; lv < cfg.levels; lv++) {
      var yy = cfg.y0 + lv * cfg.pitch;
      g.bayX.forEach(function (cx) {
        g.blocks.forEach(function (bk) {
          [-0.55, 0.55].forEach(function (off) {
            railList.push({
              x: cx + off * (cfg.bayW / 1.4), y: yy - 0.07, z: (bk[0] + bk[1]) / 2,
              sx: 0.085, sy: 0.11, sz: bk[1] - bk[0]
            });
          });
        });
      });
      /* 主轨道（沿 X 贯穿） */
      g.tracks.forEach(function (tz) {
        [-0.62, 0.62].forEach(function (rz) {
          railList.push({ x: 0, y: yy - 0.07, z: tz + rz, sx: g.len, sy: 0.11, sz: 0.085 });
        });
      });
      /* 横向通道轨道（沿 Z 贯穿） */
      g.cross.forEach(function (xc) {
        [-0.62, 0.62].forEach(function (rx) {
          railList.push({ x: xc + rx, y: yy - 0.07, z: 0, sx: 0.085, sy: 0.11, sz: g.tot });
        });
      });
    }
    var railMesh = makeInstances(new T.BoxGeometry(1, 1, 1), railMat, railList, 'frame');
    if (railMesh) { frame.add(railMesh); pickables.push(railMesh); }

    /* 主轨道黄色安全网（在轨道下方，参考原平台做法） */
    var netYList = [];
    for (var l2 = 1; l2 < cfg.levels; l2++) {
      var y2 = cfg.y0 + l2 * cfg.pitch;
      g.tracks.forEach(function (tz) {
        netYList.push({ x: 0, y: y2 - 0.185, z: tz, sx: g.len, sy: 0.012, sz: 1.28 });
      });
    }
    var netYMesh = makeInstances(new T.BoxGeometry(1, 1, 1),
      new T.MeshBasicMaterial({ color: 0xd8c34a, transparent: true, opacity: 0.42, depthWrite: false }), netYList, 'frame');
    if (netYMesh) { netYMesh.renderOrder = 3; frame.add(netYMesh); }

    /* 4. 安全护网 */
    var netH = cfg.netH === '3m' ? Math.min(3, g.top) : g.top;
    if (cfg.netSide !== 'none') {
      var tex = MM.netTexture();
      if (cfg.netSide === 'back' || cfg.netSide === 'both') {
        addNet(frame, g.len + 0.2, netH, 0, netH / 2, g.z0 - 0.12, 0, tex);
        addNet(frame, g.len + 0.2, netH, 0, netH / 2, g.z1 + 0.12, 0, tex);
      }
      if (cfg.netSide === 'side' || cfg.netSide === 'both') {
        g.blocks.forEach(function (bk) {
          var d = bk[1] - bk[0];
          addNet(frame, d, netH, g.x0 - 0.12, netH / 2, (bk[0] + bk[1]) / 2, Math.PI / 2, tex);
          addNet(frame, d, netH, g.x1 + 0.12, netH / 2, (bk[0] + bk[1]) / 2, Math.PI / 2, tex);
        });
      }
    }

    /* 5. 提升机塔 + 层间输送线（已删除提升机底部前方的外接长板：那部分其实是链条机，
       现由「设备面板」的链条机在移动网格里摆放，空出的位置全部纳入四周移动网格）。
       提升机位于前端 Z 端「子通道口」，对接的不是主通道；载货台由 sim 动态驱动。
       塔高由控制面板的「层数 / 加高」按台独立控制（加高仅在有钢平台时允许）。 */
    var liftPlats = [];
    var convBarMat = MM.convBar(), convRollerMat = MM.convRoller(), convEndMat = MM.convEnd();
    var liftNet = MM.netTexture();
    var towerBase = Math.max(0.9, g.loadH + 0.5) + 0.6;

    function tagLift(o, id) { o.userData.kind = 'lift'; o.userData.liftId = id; return o; }

    g.liftSites.forEach(function (site) {
      var lx = site.x, lz = site.z, lid = site.id;
      var lt = Math.max(cfg.y0 + 1.2,
        cfg.y0 + (site.lv - 1) * cfg.pitch + towerBase + site.boost * cfg.pitch);
      var grp = new T.Group();
      grp.userData.kind = 'lift';
      grp.userData.liftId = lid;
      var posts = [];
      [[-0.78, -0.82], [0.78, -0.82], [-0.78, 0.82], [0.78, 0.82]].forEach(function (p) {
        var m = tagLift(new T.Mesh(new T.BoxGeometry(0.13, lt, 0.13), liftMat), lid);
        m.position.set(lx + p[0], lt / 2, lz + p[1]);
        grp.add(m); posts.push(m);
      });
      var cap = tagLift(new T.Mesh(new T.BoxGeometry(1.82, 0.2, 1.86), liftTopMat), lid);
      cap.position.set(lx, lt + 0.1, lz);
      grp.add(cap); posts.push(cap);
      /* 塔两侧黄色护网，朝向货架的一端敞开 */
      [-1, 1].forEach(function (sx) {
        var t = liftNet.clone(); t.needsUpdate = true;
        t.repeat.set(2.1, Math.max(2, lt / 0.8));
        var net = tagLift(new T.Mesh(
          new T.PlaneGeometry(1.74, lt - 0.25),
          new T.MeshBasicMaterial({ map: t, transparent: true, opacity: 0.38, side: T.DoubleSide, depthWrite: false, toneMapped: false })
        ), lid);
        net.position.set(lx + sx * 0.84, (lt - 0.25) / 2, lz);
        net.rotation.y = Math.PI / 2;
        net.renderOrder = 4;
        grp.add(net);
      });
      /* 载货台：台上的货物是「容器」，由仿真按当前货物种类换成与货架完全一致的单元 */
      var plat = tagLift(new T.Mesh(new T.BoxGeometry(1.42, 0.12, 1.38), platformMat), lid);
      plat.position.set(lx, cfg.y0 - 0.15, lz);
      grp.add(plat);
      var unit = tagLift(new T.Group(), lid);
      unit.position.y = 0.06;
      unit.visible = false;
      plat.add(unit);
      liftPlats.push({
        mesh: plat, unit: unit,
        site: site, id: site.id, name: site.name,
        x: lx, z: lz, convZ: site.convZ, liftTop: lt,
        y0: cfg.y0 - 0.15
      });
      frame.add(grp);
      posts.forEach(function (p) { p.castShadow = true; p.receiveShadow = true; pickables.push(p); });
    });

    /* 5.5 层间输送线：已匹配的提升机 × 每层，两条平行黑色长方体。
       长度恒为【1 个货位网格】，位置紧贴最近主通道那一排（front 用第一
       储区最后一排 / back 用最后储区第一排）。拉伸货架宽度时它不会被拉长，
       主通道始终相邻；前后两侧可以同时存在。 */
    var barList = [], rollerList = [], endList = [];
    var barOff = cfg.bayW * 0.27;
    g.liftSites.forEach(function (site) {
      if (!site.matched) return;
      var barLen = cfg.dp * 0.92;
      var barMid = (site.convFrom + site.convTo) / 2;
      for (var lv = 0; lv < cfg.levels; lv++) {
        var cy = cfg.y0 + lv * cfg.pitch;
        [-1, 1].forEach(function (s) {
          barList.push({
            x: site.x + s * barOff, y: cy - 0.05, z: barMid,
            sx: 0.12, sy: 0.12, sz: barLen
          });
        });
        for (var r = -2; r <= 2; r++) {
          rollerList.push({
            x: site.x, y: cy - 0.012, z: barMid + r * barLen / 5.6,
            sx: barOff * 2 - 0.10, sy: 0.030, sz: 0.045
          });
        }
        endList.push({
          x: site.x, y: cy - 0.02, z: site.convFrom - 0.035,
          sx: barOff * 2 + 0.13, sy: 0.075, sz: 0.055
        });
        /* 主通道一端的端挡：明确标出层间输送线与主通道的接驳口 */
        endList.push({
          x: site.x, y: cy - 0.02, z: site.convTo + 0.035,
          sx: barOff * 2 + 0.13, sy: 0.075, sz: 0.055
        });
      }
    });
    [[convBarMat, barList], [convRollerMat, rollerList], [convEndMat, endList]].forEach(function (p) {
      var m = makeInstances(new T.BoxGeometry(1, 1, 1), p[0], p[1], 'conveyor');
      if (m) { frame.add(m); pickables.push(m); }
    });

    /* 6. 充电展示区：第一储区、非提升机子通道的第一列、对应层 */
    if (cfg.chg && g.chgLevels.length && g.bayX.length) {
      var b0 = g.blocks[0], cxg = g.bayX[g.chgBay];
      g.chgLevels.forEach(function (lv) {
        var yy = cfg.y0 + lv * cfg.pitch;
        var zone = new T.Mesh(
          new T.BoxGeometry(cfg.bayW - 0.1, cfg.pitch - 0.3, b0[1] - b0[0] - 0.08),
          new T.MeshBasicMaterial({ color: COL.charger, transparent: true, opacity: 0.17, depthWrite: false })
        );
        zone.position.set(cxg, yy + cfg.pitch * 0.35, (b0[0] + b0[1]) / 2);
        crystal.add(zone);
        var ch = new T.Mesh(new T.BoxGeometry(0.62, 0.55, 0.2), MM.charger());
        ch.position.set(cxg, yy + 0.28, b0[0] - 0.14);
        crystal.add(ch);
        var led = new T.Mesh(new T.BoxGeometry(0.4, 0.06, 0.03), MM.led());
        led.position.set(cxg, yy + 0.38, b0[0] - 0.03);
        crystal.add(led);
      });
    }

    /* 7. 四向穿梭车由运行仿真层（WAP.sim）统一创建与管理：
       未播放时静止停放在主轨道上，播放时按任务队列运行，避免两套车重叠。 */

    /* 8. 托盘货物：为「全部」非充电货位预生成实例（含当前空闲货位），
       再用实例矩阵控制显隐。运行仿真入/出库时只需改矩阵，无需重建整库。
       每个货位的货物种类由「全局货位种类」或「单货位覆盖」决定。 */
    var buckets = {};   // key -> { geo, mat, list }，与 makeCargoUnit 使用同一份外观定义
    var counts = {}, custom = 0;
    WAP.core.CARGO_REAL.forEach(function (k) { counts[k] = 0; });
    var seed = 0;

    var cellInstances = {};   // id -> [{ mesh, idx, m }]，m 为原始实例矩阵
    var cellIndex = {};       // id -> 晶格线框的起始顶点序号
    g.cells.forEach(function (o, ci) { cellIndex[o.id] = ci; });

    g.cells.forEach(function (o) {
      /* 充电位与层间输送线位都不放货：货物绝不落在主通道 / 子通道 / 输送线上 */
      if (o.chg || o.conv >= 0) return;
      var cid = o.id;
      var kind = cargoKindOf(o);
      var ovk = (WAP.state.cargoOverrides || {})[cid];
      if (o.occ) {
        if (ovk && ovk !== 'auto' && WAP.core.CARGO_REAL.indexOf(ovk) >= 0) custom++;
        counts[kind] = (counts[kind] || 0) + 1;
      }
      cargoUnitParts(kind, cfg, g, seed, cargoClassOf(o)).forEach(function (p) {
        var b = buckets[p.key] || (buckets[p.key] = { geo: p.geo, mat: p.mat, list: [] });
        b.list.push({
          cid: cid, x: o.x + p.x, y: o.y + p.y, z: o.z + p.z,
          sx: p.sx, sy: p.sy, sz: p.sz, ry: p.ry, rz: p.rz
        });
      });
      seed++;
    });

    /* 登记每个货位对应的实例，供运行时局部显隐 */
    function addCargo(mesh) {
      if (!mesh) return;
      cargo.add(mesh);
      var cids = mesh.userData.cids || [];
      var m = new T.Matrix4();
      for (var i = 0; i < cids.length; i++) {
        if (!cids[i]) continue;
        mesh.getMatrixAt(i, m);
        (cellInstances[cids[i]] || (cellInstances[cids[i]] = [])).push({ mesh: mesh, idx: i, m: m.clone() });
      }
    }

    var bi = 0;
    Object.keys(buckets).forEach(function (key) {
      var b = buckets[key];
      addCargo(makeInstances(b.geo, b.mat, b.list, 'cargo', { tint: true, tintSeed: 3 + (bi++) * 13 }));
    });

    WAP.state.cargoCounts = counts;
    WAP.state.cargoCustom = custom;

    /* 9. 晶格框块：每个货位一个线框立方体，合并为单次绘制 */
    var buf = { pos: [], col: [] };
    var cw = cfg.bayW * 0.92, cd = cfg.dp * 0.92, ccy = cfg.pitch * 0.86;
    g.cells.forEach(function (o) {
      var c = o.conv >= 0 ? CRYSTAL.conv : (o.chg ? CRYSTAL.chg : (o.occ ? CRYSTAL.used : (o.wall ? CRYSTAL.wall : CRYSTAL.free)));
      boxEdges(buf, o.x, o.y + cfg.pitch * 0.43, o.z, cw, ccy, cd, c);
    });
    var cellLines = new T.LineSegments(
      lineGeometry(buf),
      new T.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.45, depthTest: false, depthWrite: false })
    );
    cellLines.frustumCulled = false;
    cellLines.renderOrder = 800;
    crystal.add(cellLines);

    /* 晶格外框：整库包围盒 + 分层参考线 */
    var outerBuf = { pos: [], col: [] };
    boxEdges(outerBuf, 0, g.top / 2, 0, g.len + 0.5, g.top, g.tot + 0.5, CRYSTAL.outer);
    for (var li = 1; li < cfg.levels; li++) {
      var ly = cfg.y0 + li * cfg.pitch - 0.22;
      var hx = (g.len + 0.5) / 2, hz = (g.tot + 0.5) / 2;
      var pts = [[-hx, -hz], [hx, -hz], [hx, hz], [-hx, hz], [-hx, -hz]];
      var cc = new T.Color(0x8b93f8);
      for (var pi = 0; pi < 4; pi++) {
        outerBuf.pos.push(pts[pi][0], ly, pts[pi][1], pts[pi + 1][0], ly, pts[pi + 1][1]);
        outerBuf.col.push(cc.r, cc.g, cc.b, cc.r, cc.g, cc.b);
      }
    }
    var outer = new T.LineSegments(
      lineGeometry(outerBuf),
      new T.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9, depthTest: false, depthWrite: false })
    );
    outer.renderOrder = 900;
    crystal.add(outer);

    /* 10. 拾取代理：每个货位一个不可见实例 */
    var pickList = g.cells.map(function (o) {
      return { x: o.x, y: o.y + cfg.pitch * 0.43, z: o.z, sx: cw, sy: ccy, sz: cd };
    });
    var pickMesh = makeInstances(
      new T.BoxGeometry(1, 1, 1),
      new T.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, colorWrite: false }),
      pickList, 'cell', { shadow: false }
    );
    if (pickMesh) {
      pickMesh.renderOrder = -1;
      root.add(pickMesh);
      pickables.unshift(pickMesh);
    }

    /* 11. 选中货位高亮 */
    var hiGeo = new T.BoxGeometry(cw * 1.03, ccy * 1.03, cd * 1.03);
    var hi = new T.Mesh(hiGeo, new T.MeshBasicMaterial({
      color: 0x4f46e5, transparent: true, opacity: 0.22, depthTest: false, depthWrite: false
    }));
    hi.renderOrder = 950;
    var hiEdge = new T.LineSegments(
      new T.EdgesGeometry(hiGeo),
      new T.LineBasicMaterial({ color: 0x4338ca, depthTest: false, transparent: true, opacity: 1 })
    );
    hiEdge.renderOrder = 951;
    hi.add(hiEdge);
    hi.visible = false;
    crystal.add(hi);

    var cellById = {};
    g.cells.forEach(function (o) { cellById[o.id] = o; });

    return {
      root: root, frame: frame, cargo: cargo, crystal: crystal,
      outer: outer, cellLines: cellLines, highlight: hi,
      pickables: pickables, cells: g.cells, cellById: cellById, pickMesh: pickMesh,
      cellInstances: cellInstances, cellIndex: cellIndex, liftPlats: liftPlats
    };
  }

  /* ---------------- 对外接口 ---------------- */
  var current = null;
  var ZERO_M = null;

  /* 运行仿真的关键接口：不重建整库，只改实例矩阵 / 线框顶点色 / 统计 */
  function applyOccupancy() {
    if (!current) return;
    if (!ZERO_M) ZERO_M = new T.Matrix4().makeScale(0, 0, 0);
    var dirty = [];
    current.cells.forEach(function (cell) {
      var list = current.cellInstances[cell.id];
      if (!list) return;
      var on = !!cell.occ && !cell.chg;
      list.forEach(function (e) {
        e.mesh.setMatrixAt(e.idx, on ? e.m : ZERO_M);
        if (dirty.indexOf(e.mesh) < 0) dirty.push(e.mesh);
      });
    });
    dirty.forEach(function (m) { m.instanceMatrix.needsUpdate = true; });
  }

  function setCellLineColor(id, hex) {
    if (!current || !Object.prototype.hasOwnProperty.call(current.cellIndex, id)) return;
    var attr = current.cellLines.geometry.attributes.color;
    var c = new T.Color(hex), base = current.cellIndex[id] * 24 * 3;
    if (base + 72 > attr.array.length) return;
    for (var i = 0; i < 24; i++) {
      attr.array[base + i * 3] = c.r;
      attr.array[base + i * 3 + 1] = c.g;
      attr.array[base + i * 3 + 2] = c.b;
    }
    attr.needsUpdate = true;
  }

  function setCellOcc(id, occ) {
    if (!current) return false;
    var cell = current.cellById[id];
    if (!cell || cell.chg || cell.conv >= 0 || cell.occ === !!occ) return false;
    cell.occ = !!occ;
    if (!ZERO_M) ZERO_M = new T.Matrix4().makeScale(0, 0, 0);
    var dirty = [];
    (current.cellInstances[id] || []).forEach(function (e) {
      e.mesh.setMatrixAt(e.idx, cell.occ ? e.m : ZERO_M);
      if (dirty.indexOf(e.mesh) < 0) dirty.push(e.mesh);
    });
    dirty.forEach(function (m) { m.instanceMatrix.needsUpdate = true; });
    setCellLineColor(id, cell.occ ? CRYSTAL.used : (cell.wall ? CRYSTAL.wall : CRYSTAL.free));
    var kind = cargoKindOf(cell);
    var counts = WAP.state.cargoCounts || (WAP.state.cargoCounts = {});
    counts[kind] = Math.max(0, (counts[kind] || 0) + (cell.occ ? 1 : -1));
    if (WAP.state.geom) WAP.state.geom.used += cell.occ ? 1 : -1;
    WAP.state.overrides[id] = cell.occ;   // 让后续重建保留仿真产生的在库状态
    return true;
  }

  function rebuild() {
    var st = WAP.state;
    var cfg = st.cfg;
    var g = WAP.core.geom(cfg, st.overrides);
    st.geom = g;
    WAP.scene.clearModel();
    current = build(cfg, g);
    WAP.scene.S.rackRoot.add(current.root);
    WAP.scene.S.pickables = current.pickables.slice();
    WAP.scene.setShadowSize(g.len, g.tot);
    applyOccupancy();
    applyView();
    if (WAP.handles) WAP.handles.sync();
    if (WAP.transform) WAP.transform.sync();
    if (WAP.sim) WAP.sim.onRebuild();
    applyShuttleColors();     // 车被重建后重新套用用户选的车身色
    return current;
  }

  function applyView() {
    if (!current) return;
    var st = WAP.state, v = st.view, sel = st.selection;
    /* 选中具体个体时「暂时隐藏」晶格，但保留整体选中态以便继续使用货位信息 */
    var showCrystal = !!sel.rack && !sel.crystalHidden;
    current.frame.visible = !!v.frame;
    current.cargo.visible = !!v.cargo;
    current.crystal.visible = true;                 // 组内元素单独控制
    current.cellLines.visible = !!v.crystal && showCrystal;
    current.outer.visible = showCrystal;
    /* 充电区与高亮在 crystal 组内，按选中态控制 */
    current.crystal.children.forEach(function (o) {
      if (o === current.cellLines || o === current.outer || o === current.highlight) return;
      o.visible = showCrystal;
    });
    current.highlight.visible = showCrystal && !!sel.cell;
    if (sel.cell && current.cellById[sel.cell]) {
      var c = current.cellById[sel.cell];
      current.highlight.position.set(c.x, c.y + st.cfg.pitch * 0.43, c.z);
    }
    /* 晶格显示时同步显示尺寸控制点 */
    if (WAP.handles) WAP.handles.setVisible(showCrystal && !!v.crystal);
  }

  function selectRack(on) {
    WAP.state.selection.rack = !!on;
    if (!on) WAP.state.selection.cell = null;
    applyView();
  }

  function selectCell(id) {
    WAP.state.selection.rack = true;
    WAP.state.selection.cell = id;
    applyView();
  }

  function setOverride(id, val) {
    WAP.state.overrides[id] = val;
  }

  WAP.rack = {
    build: build, rebuild: rebuild, applyView: applyView,
    cargoKindOf: cargoKindOf, cargoClassOf: cargoClassOf, setCellClass: setCellClass,
    setCargoClass: setCargoClass,
    selectRack: selectRack, selectCell: selectCell, setOverride: setOverride,
    buildShuttle: buildShuttle, makeCargoUnit: makeCargoUnit, setUnitSkin: setUnitSkin,
    setShuttleColor: setShuttleColor, applyShuttleColors: applyShuttleColors,
    cargoUnitParts: cargoUnitParts, applyOccupancy: applyOccupancy, setCellOcc: setCellOcc,
    get current() { return current; },
    COL: COL, UPR: UPR, CRYSTAL: CRYSTAL
  };
})(window);
