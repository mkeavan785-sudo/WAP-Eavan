/* WAP-Eavan · transform.js
   「模型移动和旋转」模式。
   与左上角两个「视角」圆形图标并列：激活后操作对象由相机变为模型本体。
   提供三种操控方式：
     ① 3D 变换手柄：X / Y / Z 六向箭头（四面八方平移）＋ 水平旋转环；
     ② 视口自由拖拽：平面八向移动 / Shift 升降 / Alt 水平旋转；
     ③ 左侧浮层控制台：八向方向盘、升降、旋转滑块与键盘微调。
   模型变换作用于 scene.modelRoot，rackRoot 与 handleRoot 作为子组同步跟随，
   地面、网格与接地阴影保持独立，因此晶格控制点始终与库体严丝合缝。 */
(function (global) {
  'use strict';
  var WAP = global.WAP = global.WAP || {};
  var T = global.THREE;
  var D = global.document;
  var $ = function (id) { return D.getElementById(id); };
  var clamp = function (v, a, b) { return Math.max(a, Math.min(b, v)); };
  var STORE = 'wap-eavan.transform.v1';

  var AXIS = {
    x: { hex: 0xef4b6b, name: 'X', dir: [1, 0, 0] },
    y: { hex: 0xf5a524, name: 'Y', dir: [0, 1, 0] },
    z: { hex: 0x16a9c9, name: 'Z', dir: [0, 0, 1] }
  };
  var RING_HEX = 0x18b47f;

  var G = {
    active: false, root: null, canvas: null, rc: null, v2: null,
    picks: [], hoverMats: [], hoverObj: null, billboard: [],
    drag: null, sizeKey: '', L: 5, R: 3,
    hud: null, hudTxt: null, panel: null
  };

  /* ---------------- 状态 ---------------- */
  function loadState() {
    var t = { x: 0, y: 0, z: 0, yaw: 0 };
    try {
      var raw = global.localStorage && global.localStorage.getItem(STORE);
      if (raw) {
        var o = JSON.parse(raw);
        t.x = clamp(Number(o.x) || 0, -60, 60);
        t.y = clamp(Number(o.y) || 0, -12, 24);
        t.z = clamp(Number(o.z) || 0, -60, 60);
        t.yaw = clamp(Number(o.yaw) || 0, -180, 180);
      }
    } catch (e) { /* ignore */ }
    return t;
  }
  function saveState() {
    try {
      var t = WAP.state.transform;
      global.localStorage && global.localStorage.setItem(STORE, JSON.stringify({ x: t.x, y: t.y, z: t.z, yaw: t.yaw }));
    } catch (e) { /* ignore */ }
  }

  /* ---------------- 小工具 ---------------- */
  function basic(hex, opacity) {
    return new T.MeshBasicMaterial({
      color: hex, transparent: true, opacity: opacity == null ? 1 : opacity,
      depthTest: false, depthWrite: false, toneMapped: false
    });
  }
  function ghost() {
    return new T.MeshBasicMaterial({ transparent: true, opacity: 0, colorWrite: false, depthTest: false, depthWrite: false });
  }
  function labelSprite(text, hex) {
    var c = D.createElement('canvas'), x = c.getContext('2d');
    x.font = '800 44px "Microsoft YaHei",Arial,sans-serif';
    var w = Math.ceil(x.measureText(text).width) + 34;
    c.width = w; c.height = 64;
    x = c.getContext('2d');
    x.fillStyle = 'rgba(255,255,255,.94)';
    var r = 16;
    x.beginPath();
    x.moveTo(r, 2); x.lineTo(w - r, 2); x.quadraticCurveTo(w - 2, 2, w - 2, r);
    x.lineTo(w - 2, 62 - r); x.quadraticCurveTo(w - 2, 62, w - r, 62);
    x.lineTo(r, 62); x.quadraticCurveTo(2, 62, 2, 62 - r);
    x.lineTo(2, r); x.quadraticCurveTo(2, 2, r, 2); x.fill();
    x.strokeStyle = '#' + new T.Color(hex).getHexString(); x.lineWidth = 3; x.stroke();
    x.fillStyle = '#' + new T.Color(hex).getHexString();
    x.font = '800 44px "Microsoft YaHei",Arial,sans-serif';
    x.textBaseline = 'middle'; x.fillText(text, 17, 33);
    var tex = new T.CanvasTexture(c);
    tex.encoding = T.sRGBEncoding;
    var sp = new T.Sprite(new T.SpriteMaterial({ map: tex, transparent: true, depthTest: false, toneMapped: false }));
    sp.scale.set(w / 64 * 0.78, 0.78, 1);
    sp.renderOrder = 1200;
    return sp;
  }
  function orient(o, dir) {
    o.quaternion.setFromUnitVectors(new T.Vector3(0, 1, 0), dir.clone().normalize());
  }
  function clearGizmo() {
    var r = G.root;
    if (!r) return;
    while (r.children.length) {
      var o = r.children[0];
      r.remove(o);
      o.traverse(function (n) {
        if (n.geometry) n.geometry.dispose();
        if (n.material) {
          var ms = Array.isArray(n.material) ? n.material : [n.material];
          ms.forEach(function (m) { if (m.map) m.map.dispose(); m.dispose(); });
        }
      });
    }
    G.picks = []; G.hoverMats = []; G.billboard = []; G.hoverObj = null;
  }

  /* ---------------- 构建 3D 变换手柄 ---------------- */
  function buildGizmo() {
    clearGizmo();
    var g = WAP.state.geom;
    if (!g) return;
    var L = clamp(Math.max(g.len, g.tot) * 0.17 + 2.4, 3.6, 9);
    var R = clamp(L * 0.68, 2.6, 6.4);
    G.L = L; G.R = R;

    /* 中心枢纽 */
    var hub = new T.Mesh(new T.SphereGeometry(0.28, 20, 14), basic(0x2b3550));
    hub.renderOrder = 1100;
    G.root.add(hub);
    var hubRing = new T.Mesh(new T.TorusGeometry(0.46, 0.055, 8, 28), basic(0xffffff, 0.95));
    hubRing.renderOrder = 1101;
    G.root.add(hubRing);
    G.billboard.push(hubRing);

    /* 六向平移箭头 */
    Object.keys(AXIS).forEach(function (ak) {
      var def = AXIS[ak];
      [1, -1].forEach(function (sg) {
        var dir = new T.Vector3(def.dir[0] * sg, def.dir[1] * sg, def.dir[2] * sg);
        var m = basic(def.hex);
        m.userData.base = def.hex;
        G.hoverMats.push(m);
        var sl = L - 0.62;

        var shaft = new T.Mesh(new T.CylinderGeometry(0.085, 0.085, sl, 12), m);
        shaft.position.copy(dir.clone().multiplyScalar(0.34 + sl / 2));
        orient(shaft, dir);
        shaft.renderOrder = 1102;
        G.root.add(shaft);

        var cone = new T.Mesh(new T.ConeGeometry(0.27, 0.60, 16), m);
        cone.position.copy(dir.clone().multiplyScalar(L - 0.16));
        orient(cone, dir);
        cone.renderOrder = 1103;
        G.root.add(cone);

        /* 拾取代理 */
        var tf = { kind: 'axis', axis: ak, sign: sg, dir: [dir.x, dir.y, dir.z], mat: m };
        var ps = new T.Mesh(new T.CylinderGeometry(0.30, 0.30, sl, 8), ghost());
        ps.position.copy(shaft.position); ps.quaternion.copy(shaft.quaternion);
        ps.userData.tf = tf; ps.renderOrder = 1090;
        G.root.add(ps); G.picks.push(ps);
        var pt = new T.Mesh(new T.SphereGeometry(0.52, 12, 10), ghost());
        pt.position.copy(cone.position);
        pt.userData.tf = tf; pt.renderOrder = 1091;
        G.root.add(pt); G.picks.push(pt);

        var lb = labelSprite(def.name, def.hex);
        lb.position.copy(dir.clone().multiplyScalar(L + 0.62));
        lb.userData.tf = tf;
        G.root.add(lb);
      });
    });

    /* 水平旋转环 */
    var ringMat = basic(RING_HEX);
    ringMat.userData.base = RING_HEX;
    G.hoverMats.push(ringMat);
    var ring = new T.Mesh(new T.TorusGeometry(R, 0.13, 10, 80), ringMat);
    ring.rotation.x = Math.PI / 2;
    ring.renderOrder = 1104;
    G.root.add(ring);

    var tickMat = basic(0xffffff, 0.9);
    for (var i = 0; i < 16; i++) {
      var a = i * Math.PI * 2 / 16;
      var tick = new T.Mesh(new T.BoxGeometry(i % 4 === 0 ? 0.30 : 0.16, 0.07, 0.07), tickMat);
      tick.position.set(Math.cos(a) * R, 0, Math.sin(a) * R);
      tick.rotation.y = -a;
      tick.renderOrder = 1105;
      G.root.add(tick);
    }
    /* 环上的方向箭头 */
    [0, Math.PI].forEach(function (a) {
      var p = new T.Vector3(Math.cos(a) * R, 0, Math.sin(a) * R);
      var tangent = new T.Vector3(-Math.sin(a), 0, Math.cos(a));
      var c = new T.Mesh(new T.ConeGeometry(0.20, 0.46, 12), basic(0x8ff0c4));
      c.position.copy(p); orient(c, tangent);
      c.renderOrder = 1106;
      G.root.add(c);
    });

    var tfRing = { kind: 'yaw', mat: ringMat };
    var pr = new T.Mesh(new T.TorusGeometry(R, 0.42, 8, 56), ghost());
    pr.rotation.x = Math.PI / 2;
    pr.userData.tf = tfRing; pr.renderOrder = 1089;
    G.root.add(pr); G.picks.push(pr);

    var lbR = labelSprite('↻ 水平旋转', RING_HEX);
    lbR.position.set(R + 1.5, 0.35, 0);
    lbR.userData.tf = tfRing;
    G.root.add(lbR);

    G.root.updateMatrixWorld(true);
  }

  function sizeKey() {
    var g = WAP.state.geom;
    return g ? (g.len.toFixed(1) + '/' + g.tot.toFixed(1) + '/' + g.top.toFixed(1)) : '';
  }

  /* 把手根节点始终对齐模型中心（世界轴对齐，不随模型旋转） */
  function sync() {
    var t = WAP.state.transform, g = WAP.state.geom;
    if (!G.root) return;
    if (G.sizeKey !== sizeKey()) { G.sizeKey = sizeKey(); buildGizmo(); }
    if (g) G.root.position.set(t.x, t.y + g.top * 0.52, t.z);
    G.root.visible = G.active;
    WAP.scene.applyTransform(t);
    if (g) WAP.scene.setShadowSize(g.len, g.tot);
    updatePanel();
  }

  /* ---------------- 数值与界面 ---------------- */
  function fmt(v) { return (v >= 0 ? '+' : '') + v.toFixed(1); }

  function updatePanel() {
    var t = WAP.state.transform;
    if ($('tfXVal')) $('tfXVal').textContent = fmt(t.x) + ' m';
    if ($('tfYVal')) $('tfYVal').textContent = fmt(t.y) + ' m';
    if ($('tfZVal')) $('tfZVal').textContent = fmt(t.z) + ' m';
    if ($('tfYawVal')) $('tfYawVal').textContent = Math.round(t.yaw) + '°';
    if ($('rngYaw') && D.activeElement !== $('rngYaw')) $('rngYaw').value = Math.round(t.yaw);
    if ($('sbSel') && G.active) $('sbSel').textContent = '模型变换中 · X' + fmt(t.x) + ' Y' + fmt(t.y) + ' Z' + fmt(t.z);
  }

  function showHud() {
    var t = WAP.state.transform;
    G.hudTxt.textContent = 'X ' + fmt(t.x) + '  Y ' + fmt(t.y) + '  Z ' + fmt(t.z) + ' m   ↻ ' + Math.round(t.yaw) + '°';
    G.hud.classList.add('show');
  }
  function hideHud() { G.hud.classList.remove('show'); }

  function apply() {
    var t = WAP.state.transform;
    t.x = clamp(t.x, -60, 60);
    t.y = clamp(t.y, -12, 24);
    t.z = clamp(t.z, -60, 60);
    t.yaw = ((t.yaw + 180) % 360 + 360) % 360 - 180;
    WAP.scene.applyTransform(t);
    var g = WAP.state.geom;
    if (g) G.root.position.set(t.x, t.y + g.top * 0.52, t.z);
    G.root.updateMatrixWorld(true);
    updatePanel();
    saveState();
    if (G.drag) showHud();
  }

  function nudge(dx, dy, dz, dyaw) {
    var t = WAP.state.transform;
    t.x += dx || 0; t.y += dy || 0; t.z += dz || 0; t.yaw += dyaw || 0;
    apply();
  }

  function reset() {
    var t = WAP.state.transform;
    t.x = 0; t.y = 0; t.z = 0; t.yaw = 0;
    apply();
    WAP.ui.toast('模型已复位到原点');
  }

  /* ---------------- 拾取与拖拽 ---------------- */
  function ndc(e) {
    var r = G.canvas.getBoundingClientRect();
    G.v2.set((e.clientX - r.left) / r.width * 2 - 1, -(e.clientY - r.top) / r.height * 2 + 1);
    return G.v2;
  }
  function hitTest(e) {
    if (!G.active || !G.picks.length) return null;
    G.rc.setFromCamera(ndc(e), WAP.scene.S.camera);
    var hits = G.rc.intersectObjects(G.picks, false);
    return hits.length ? hits[0] : null;
  }
  function rayPlane(e, plane) {
    G.rc.setFromCamera(ndc(e), WAP.scene.S.camera);
    var p = new T.Vector3();
    return G.rc.ray.intersectPlane(plane, p) ? p : null;
  }
  function screenAxis(worldPoint, dir) {
    var r = G.canvas.getBoundingClientRect();
    var cam = WAP.scene.S.camera;
    var a = worldPoint.clone().project(cam);
    var b = worldPoint.clone().add(dir).project(cam);
    var dx = (b.x - a.x) / 2 * r.width;
    var dy = -(b.y - a.y) / 2 * r.height;
    var len = Math.hypot(dx, dy);
    return { vx: dx / (len || 1), vy: dy / (len || 1), ppm: Math.max(6, len) };
  }

  function setHover(tf) {
    var obj = tf ? tf.mat : null;
    if (G.hoverObj === obj) return;
    G.hoverMats.forEach(function (m) { m.color.setHex(m.userData.base); m.opacity = 1; });
    if (obj && obj.userData.base != null) { obj.color.setHex(0xffffff); }
    G.hoverObj = obj;
  }

  function down(e) {
    if (!G.active || e.button !== 0) return false;
    var t = WAP.state.transform;
    var hit = hitTest(e);
    var base = {
      id: e.pointerId, sx: e.clientX, sy: e.clientY,
      x0: t.x, y0: t.y, z0: t.z, yaw0: t.yaw, moved: false
    };
    if (hit) {
      var tf = hit.object.userData.tf;
      e.preventDefault();
      setHover(null);
      G.canvas.style.cursor = tf.kind === 'yaw' ? 'ew-resize' : 'grabbing';
      if (tf.kind === 'axis') {
        var dir = new T.Vector3(tf.dir[0], tf.dir[1], tf.dir[2]);
        var origin = G.root.position.clone();
        var sa = screenAxis(origin, dir);
        G.drag = Object.assign(base, {
          kind: 'axis', tf: tf, vx: sa.vx, vy: sa.vy, ppm: sa.ppm,
          dirComp: { x: dir.x, y: dir.y, z: dir.z }
        });
      } else {
        G.drag = Object.assign(base, { kind: 'yaw', tf: tf });
      }
    } else {
      /* 视口自由拖拽：默认水平面八向，Shift 升降，Alt 水平旋转 */
      var g = WAP.state.geom;
      var plane = new T.Plane(new T.Vector3(0, 1, 0), -(t.y + (g ? g.top * 0.5 : 4)));
      var p0 = rayPlane(e, plane);
      G.drag = Object.assign(base, {
        kind: e.altKey ? 'yaw' : (e.shiftKey ? 'lift' : 'plane'),
        plane: plane, p0: p0
      });
      G.canvas.style.cursor = 'move';
    }
    try { G.canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    $('viewBadgeTxt').textContent = '模型变换 · ' + (G.drag.kind === 'yaw' ? '水平旋转' : (G.drag.kind === 'lift' ? '升降' : '移动'));
    showHud();
    return true;
  }

  function hover(e) {
    if (!G.active) return false;
    if (G.drag) return true;
    var hit = hitTest(e);
    var tf = hit ? hit.object.userData.tf : null;
    setHover(tf);
    G.canvas.style.cursor = tf ? (tf.kind === 'yaw' ? 'ew-resize' : 'grab') : 'move';
    return true;
  }

  function move(e) {
    var d = G.drag;
    if (!d || (e.pointerId != null && d.id !== e.pointerId)) return;
    var t = WAP.state.transform;
    var dx = e.clientX - d.sx, dy = e.clientY - d.sy;
    if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
    if (d.kind === 'axis') {
      var px = dx * d.vx + dy * d.vy;
      var meters = clamp(px / d.ppm, -40, 40);
      t.x = d.x0 + meters * d.dirComp.x;
      t.y = d.y0 + meters * d.dirComp.y;
      t.z = d.z0 + meters * d.dirComp.z;
    } else if (d.kind === 'yaw') {
      var snap = e.shiftKey ? 15 : 1;
      t.yaw = d.yaw0 + Math.round(dx * 0.55 / snap) * snap;
    } else if (d.kind === 'lift') {
      t.y = d.y0 + clamp(-dy * 0.045, -24, 24);
    } else {
      var p = rayPlane(e, d.plane);
      if (p && d.p0) {
        t.x = d.x0 + clamp(p.x - d.p0.x, -60, 60);
        t.z = d.z0 + clamp(p.z - d.p0.z, -60, 60);
      }
    }
    apply();
  }

  function up(e) {
    var d = G.drag;
    if (!d || (e && e.pointerId != null && d.id !== e.pointerId)) return;
    G.drag = null;
    try { G.canvas.releasePointerCapture(d.id); } catch (err) { /* ignore */ }
    G.canvas.style.cursor = G.active ? 'move' : 'grab';
    hideHud();
    setHover(null);
    if (!d.moved && !d.tf && WAP.scene.S.onPick) {
      /* 单击仍保留货位拾取能力 */
      var r = G.canvas.getBoundingClientRect();
      var pt = e || { clientX: d.sx, clientY: d.sy };
      WAP.scene.S.onPick(new T.Vector2(
        (pt.clientX - r.left) / r.width * 2 - 1,
        -(pt.clientY - r.top) / r.height * 2 + 1
      ), pt);
    }
    $('viewBadgeTxt').textContent = '模型变换 · 拖拽 Gizmo 或视口';
  }

  function frame() {
    if (!G.active || !G.billboard.length) return;
    var q = WAP.scene.S.camera.quaternion;
    for (var i = 0; i < G.billboard.length; i++) G.billboard[i].quaternion.copy(q);
  }

  /* ---------------- 模式切换 ---------------- */
  function setActive(on) {
    var S = WAP.scene.S;
    on = !!on;
    if (G.active === on) return;
    G.active = on;
    if (on) {
      S.prevMode = (S.mode === 'object') ? (S.prevMode || 'rotate') : S.mode;
      S.mode = 'object';
    } else {
      S.mode = S.prevMode || 'rotate';
      if (G.drag) up(null);
    }
    G.root.visible = on;
    G.panel.classList.toggle('show', on);
    $('btnObject').classList.toggle('is-on', on);
    $('btnObject').setAttribute('aria-pressed', String(on));
    $('viewportTip').innerHTML = on
      ? '拖拽<b>Gizmo 箭头</b>移动 · 拖拽<b>绿环</b>水平旋转 · 视口空白处拖拽八向移动 · <b>Shift</b> 升降 · <b>Alt</b> 旋转'
      : '点击库体显示<b>晶格框块</b> · 拖拽彩色<b>控制点</b>调整长宽高 · 滚轮缩放';
    $('viewportTip').classList.remove('hide');
    if (S.onMode) S.onMode(S.mode);
    WAP.rack.applyView();       // 变换模式下隐藏尺寸控制点，避免与 Gizmo 混淆
    if (!on) WAP.ui.hideCell();
    updatePanel();
    WAP.ui.toast(on ? '已进入模型移动与旋转模式' : '已返回视角控制模式');
  }

  function toggle() { setActive(!G.active); }

  /* ---------------- 控制台绑定 ---------------- */
  function bindPanel() {
    var STEP = 0.5;
    [['x', 'tfX'], ['y', 'tfY'], ['z', 'tfZ']].forEach(function (p) {
      var axis = p[0], id = p[1];
      $(id + 'Minus').addEventListener('click', function () {
        nudge(axis === 'x' ? -STEP : 0, axis === 'y' ? -STEP : 0, axis === 'z' ? -STEP : 0);
      });
      $(id + 'Plus').addEventListener('click', function () { nudge(axis === 'x' ? STEP : 0, axis === 'y' ? STEP : 0, axis === 'z' ? STEP : 0); });
    });
    D.querySelectorAll('#dpad [data-dx]').forEach(function (b) {
      b.addEventListener('click', function () {
        nudge(+b.dataset.dx * STEP, 0, +b.dataset.dz * STEP);
      });
    });
    $('dpHome').addEventListener('click', function () {
      var t = WAP.state.transform; t.x = 0; t.z = 0; apply();
    });
    $('btnLiftUp').addEventListener('click', function () { nudge(0, STEP, 0); });
    $('btnLiftDown').addEventListener('click', function () { nudge(0, -STEP, 0); });
    $('yawLeft').addEventListener('click', function () { nudge(0, 0, 0, -15); });
    $('yawRight').addEventListener('click', function () { nudge(0, 0, 0, 15); });
    $('rngYaw').addEventListener('input', function () {
      WAP.state.transform.yaw = +$('rngYaw').value; apply();
    });
    $('btnTfReset').addEventListener('click', reset);
    $('mpClose').addEventListener('click', function () { setActive(false); });
    $('btnObject').addEventListener('click', toggle);
  }

  function bindKeys() {
    D.addEventListener('keydown', function (e) {
      if (/^(INPUT|TEXTAREA|SELECT)$/.test((e.target.tagName || '').toUpperCase())) return;
      if (e.key === '3') { toggle(); return; }
      if (!G.active) return;
      var s = e.shiftKey ? 1.0 : 0.5;
      var k = e.key;
      if (k === 'ArrowLeft') { nudge(-s, 0, 0); e.preventDefault(); }
      else if (k === 'ArrowRight') { nudge(s, 0, 0); e.preventDefault(); }
      else if (k === 'ArrowUp') { nudge(0, e.shiftKey ? s : 0, e.shiftKey ? 0 : -s); e.preventDefault(); }
      else if (k === 'ArrowDown') { nudge(0, e.shiftKey ? -s : 0, e.shiftKey ? 0 : s); e.preventDefault(); }
      else if (k === 'q' || k === 'Q') nudge(0, 0, 0, -5);
      else if (k === 'e' || k === 'E') nudge(0, 0, 0, 5);
      else if (k === 'r' || k === 'R') reset();
    });
  }

  function init() {
    G.canvas = $('c');
    G.root = WAP.scene.S.gizmoRoot;
    G.panel = $('modelPanel');
    G.hud = $('tfHud');
    G.hudTxt = $('tfHudTxt');
    G.rc = new T.Raycaster();
    G.v2 = new T.Vector2();

    WAP.state.transform = loadState();
    var S = WAP.scene.S;
    S.onTransformDown = down;
    S.onTransformMove = hover;
    S.onTransformFrame = frame;

    global.addEventListener('pointermove', move);
    global.addEventListener('pointerup', up);
    global.addEventListener('pointercancel', up);
    global.addEventListener('blur', function () { if (G.drag) up(null); });
    global.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && G.drag) { G.drag.moved = true; up(null); }
      else if (e.key === 'Escape' && G.active) setActive(false);
    });

    bindPanel();
    bindKeys();
    buildGizmo();
    G.sizeKey = sizeKey();
    apply();
    G.root.visible = false;
  }

  WAP.transform = {
    init: init, sync: sync, setActive: setActive, toggle: toggle,
    nudge: nudge, reset: reset,
    get active() { return G.active; },
    get dragging() { return !!G.drag; },
    get dragKind() { return G.drag ? G.drag.kind : '-'; }
  };
})(window);
