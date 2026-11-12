/* WAP-Eavan · handles.js
   晶格框块上的「尺寸控制点」。
   吸收参考平台 h3Sync / resHandles / pointerdown 拖拽机制后全新实现：
   外框四条边中点＝长 / 宽控制点（横向拖拽改 BAY 列数、储区排数），
   顶面中心＝高度控制点（纵向拖拽改层数）。拖拽期间锁定相机、实时重建模型。 */
(function (global) {
  'use strict';
  var WAP = global.WAP = global.WAP || {};
  var T = global.THREE;
  var D = global.document;
  var core = WAP.core;

  var OFF = 1.55;      // 水平控制点离外框的距离（m）
  var OFFY = 1.65;     // 高度控制点离顶面的距离（m）

  var AX = {
    len: { c: 0x6366f1, name: '长度', unit: '列', min: 2, max: 40, arrow: '↔', cursor: 'ew-resize' },
    wid: { c: 0x0891b2, name: '宽度', unit: '排', min: 3, max: 24, arrow: '↔', cursor: 'ew-resize' },
    hei: { c: 0xf59e0b, name: '高度', unit: '层', min: 2, max: 12, arrow: '↕', cursor: 'ns-resize' }
  };

  var H = {
    root: null, knobs: [], rings: [], hoverSpec: null,
    drag: null, raf: 0, pending: 0,
    rc: null, v2: null, canvas: null,
    hud: null, hudAxis: null, hudMain: null, hudSub: null
  };

  function basic(color, opacity) {
    return new T.MeshBasicMaterial({
      color: color, depthTest: false, depthWrite: false, transparent: true,
      opacity: opacity == null ? 1 : opacity, toneMapped: false
    });
  }

  function labelSprite(text, color) {
    var FONT = '700 34px "Microsoft YaHei","PingFang SC",sans-serif';
    var c = D.createElement('canvas');
    var x = c.getContext('2d');
    x.font = FONT;
    var w = Math.ceil(x.measureText(text).width) + 40;
    c.width = w; c.height = 62;
    x = c.getContext('2d');
    x.fillStyle = '#' + new T.Color(color).getHexString();
    var r = 14;
    x.beginPath();
    x.moveTo(r, 0); x.lineTo(w - r, 0); x.quadraticCurveTo(w, 0, w, r);
    x.lineTo(w, 62 - r); x.quadraticCurveTo(w, 62, w - r, 62);
    x.lineTo(r, 62); x.quadraticCurveTo(0, 62, 0, 62 - r);
    x.lineTo(0, r); x.quadraticCurveTo(0, 0, r, 0); x.fill();
    x.strokeStyle = 'rgba(255,255,255,.85)'; x.lineWidth = 2; x.stroke();
    x.fillStyle = '#fff'; x.font = FONT; x.textBaseline = 'middle';
    x.fillText(text, 20, 32);
    var tex = new T.CanvasTexture(c);
    tex.encoding = T.sRGBEncoding;
    var sp = new T.Sprite(new T.SpriteMaterial({ map: tex, depthTest: false, transparent: true, toneMapped: false }));
    sp.scale.set(w / 62 * 0.92, 0.92, 1);
    sp.renderOrder = 1006;
    return sp;
  }

  /* 清理旧控制点（几何、材质、贴图都释放，避免长时间拖拽内存增长） */
  function clear() {
    if (!H.root) return;
    while (H.root.children.length) {
      var o = H.root.children[0];
      H.root.remove(o);
      o.traverse(function (n) {
        if (n.geometry) n.geometry.dispose();
        if (n.material) {
          var ms = Array.isArray(n.material) ? n.material : [n.material];
          ms.forEach(function (m) {
            if (m.map) m.map.dispose();
            m.dispose();
          });
        }
      });
    }
    H.knobs = [];
    H.rings = [];
    H.hoverSpec = null;
  }

  function knobSpecs() {
    var st = WAP.state, g = st.geom, c = st.cfg;
    if (!g) return [];
    var hx = (g.len + 0.5) / 2, hz = (g.tot + 0.5) / 2, top = g.top;
    var my = Math.max(1.1, top * 0.54);
    var cur = {
      len: c.bays,
      wid: c.depths.reduce(function (a, b) { return a + b; }, 0),
      hei: c.levels
    };
    var dim = { len: g.len, wid: g.tot, hei: g.top };
    var list = [
      { axis: 'len', sign: 1, pos: [hx + OFF, my, 0], anchor: [hx, my, 0], dir: [1, 0, 0], main: true },
      { axis: 'len', sign: -1, pos: [-hx - OFF, my, 0], anchor: [-hx, my, 0], dir: [-1, 0, 0], main: false },
      { axis: 'wid', sign: 1, pos: [0, my, hz + OFF], anchor: [0, my, hz], dir: [0, 0, 1], main: true },
      { axis: 'wid', sign: -1, pos: [0, my, -hz - OFF], anchor: [0, my, -hz], dir: [0, 0, -1], main: false },
      { axis: 'hei', sign: 1, pos: [0, top + OFFY, 0], anchor: [0, top, 0], dir: [0, 1, 0], main: true }
    ];
    list.forEach(function (s) {
      s.def = AX[s.axis];
      s.n = cur[s.axis];
      s.dim = dim[s.axis];
    });
    return list;
  }

  function addKnob(spec) {
    var g = H.root, def = spec.def;
    var p = new T.Vector3(spec.pos[0], spec.pos[1], spec.pos[2]);
    var a = new T.Vector3(spec.anchor[0], spec.anchor[1], spec.anchor[2]);
    var dir = new T.Vector3(spec.dir[0], spec.dir[1], spec.dir[2]);
    var R = spec.main ? 0.52 : 0.42;

    /* 引导线：从晶格外框中点连到控制点 */
    var guide = new T.Line(
      new T.BufferGeometry().setFromPoints([a, p]),
      new T.LineBasicMaterial({ color: def.c, depthTest: false, transparent: true, opacity: 0.85, toneMapped: false })
    );
    guide.renderOrder = 1000;
    g.add(guide);

    /* 晶格线中点的「点位」：白心小球 + 外圈 */
    var dot = new T.Mesh(new T.SphereGeometry(0.19, 16, 12), basic(def.c));
    dot.position.copy(a); dot.renderOrder = 1001;
    g.add(dot);
    var dotRing = new T.Mesh(new T.TorusGeometry(0.3, 0.045, 8, 24), basic(0xffffff, 0.95));
    dotRing.position.copy(a); dotRing.renderOrder = 1002;
    dotRing.quaternion.copy(camLocalQuat());
    H.rings.push(dotRing);
    g.add(dotRing);

    /* 双向箭头 */
    [-1, 1].forEach(function (sg) {
      var cone = new T.Mesh(new T.ConeGeometry(0.24, 0.58, 12), basic(0xffc22e));
      cone.position.copy(p).addScaledVector(dir, sg * (R + 0.56));
      cone.quaternion.setFromUnitVectors(new T.Vector3(0, 1, 0), dir.clone().multiplyScalar(sg));
      cone.renderOrder = 1003;
      g.add(cone);
    });

    /* 主球形把手 */
    var knob = new T.Mesh(new T.SphereGeometry(R, 22, 16), basic(def.c));
    knob.position.copy(p);
    knob.renderOrder = 1004;
    knob.userData.spec = spec;
    g.add(knob);
    H.knobs.push(knob);

    /* 白色面向相机的圆环 */
    var ring = new T.Mesh(new T.TorusGeometry(R + 0.15, 0.07, 8, 28), basic(0xffffff, 0.98));
    ring.position.copy(p);
    ring.quaternion.copy(camLocalQuat());
    ring.renderOrder = 1005;
    H.rings.push(ring);
    g.add(ring);

    /* 更大的透明拾取代理，方便鼠标点中 */
    var proxy = new T.Mesh(
      new T.SphereGeometry(R + 0.38, 12, 10),
      new T.MeshBasicMaterial({ transparent: true, opacity: 0, colorWrite: false, depthTest: false, depthWrite: false })
    );
    proxy.position.copy(p);
    proxy.renderOrder = 999;
    proxy.userData.spec = spec;
    g.add(proxy);
    H.knobs.push(proxy);

    /* 主控制点带数值标签 */
    if (spec.main) {
      var text = def.arrow + ' ' + def.name + ' ' + spec.n + ' ' + def.unit + ' · ' + spec.dim.toFixed(1) + ' m';
      var sp = labelSprite(text, def.c);
      sp.position.set(p.x, p.y + 1.05, p.z);
      g.add(sp);
    }
  }

  /* 重建控制点：几何常驻，由 root.visible 控制显隐。
     拖拽中也跟随新尺寸同步（拖拽起点 sx/sy 与 n0 固定，故不会跟手抖动），
     标签与球体数值始终和右侧面板、HUD 一致 */
  function sync() {
    if (!H.root) return;
    clear();
    knobSpecs().forEach(addKnob);
    /* 新建对象立即具备正确的世界矩阵，保证松手后可马上再次拾取 */
    WAP.scene.S.modelRoot.updateMatrixWorld(true);
    H.root.updateMatrixWorld(true);
    var st = WAP.state;
    H.root.visible = !!(st.selection.rack && st.view.crystal);
  }

  /* 相机四元数换算到 handleRoot 的局部空间：
     模型水平旋转后，父组带旋转，圆环仍要正对相机。 */
  var _pq = null;
  function camLocalQuat() {
    if (!_pq) _pq = new T.Quaternion();
    _pq.set(0, 0, 0, 1);
    H.root.getWorldQuaternion(_pq);
    _pq.invert().multiply(WAP.scene.S.camera.quaternion);
    return _pq;
  }

  function setVisible(on) {
    if (!H.root) return;
    /* 模型变换模式下让位给 3D 变换手柄 */
    var busy = !!(WAP.transform && WAP.transform.active);
    var want = !!(on && WAP.state.view.crystal && !busy);
    if (want && !H.root.children.length) { sync(); return; }
    H.root.visible = want;
  }

  function hitTest(e) {
    if (!H.root || !H.root.visible || !H.knobs.length) return null;
    var r = H.canvas.getBoundingClientRect();
    H.v2.set((e.clientX - r.left) / r.width * 2 - 1, -(e.clientY - r.top) / r.height * 2 + 1);
    H.rc.setFromCamera(H.v2, WAP.scene.S.camera);
    var hits = H.rc.intersectObjects(H.knobs, false);
    return hits.length ? hits[0] : null;
  }

  /* 把该控制点的世界轴向投影到屏幕：得到拖拽方向单位向量与「每米像素数」。
     纵向拉只作用于高度，横向拉只作用于长 / 宽，斜向拖动互不影响。 */
  function screenAxis(spec) {
    var r = H.canvas.getBoundingClientRect();
    var cam = WAP.scene.S.camera;
    /* 控制点坐标是模型局部坐标，须经 modelRoot 变换后再投影到屏幕 */
    H.root.updateWorldMatrix(true, false);
    var mw = H.root.matrixWorld;
    var p = new T.Vector3(spec.pos[0], spec.pos[1], spec.pos[2]).applyMatrix4(mw);
    var q = p.clone().add(
      new T.Vector3(spec.dir[0], spec.dir[1], spec.dir[2]).transformDirection(mw)
    );
    var a = p.project(cam), b = q.project(cam);
    var dx = (b.x - a.x) / 2 * r.width;
    var dy = -(b.y - a.y) / 2 * r.height;
    var len = Math.hypot(dx, dy);
    return { vx: dx / (len || 1), vy: dy / (len || 1), ppm: Math.max(7, len) };
  }

  function setHover(spec) {
    var changed = H.hoverSpec !== spec;
    H.hoverSpec = spec;
    if (!changed) return;
    H.root.children.forEach(function (o) {
      if (!o.userData.spec || !o.geometry || o.geometry.type !== 'SphereGeometry') return;
      var s = o.userData.spec === spec ? 1.16 : 1;
      o.scale.setScalar(s);
    });
  }

  /* ---------- 数值换算 ---------- */
  function predict(axis, n) {
    var c = core.clone(WAP.state.cfg);
    if (axis === 'len') c = core.setLen(c, n);
    else if (axis === 'wid') c = core.setWid(c, n);
    else c = core.setHei(c, n);
    return { c: c, g: core.geom(c, WAP.state.overrides) };
  }

  function stepOf(axis) {
    var c = WAP.state.cfg;
    return axis === 'hei' ? c.pitch : (axis === 'len' ? c.bayW : c.dp);
  }

  function hudText(axis, n, g) {
    var def = AX[axis];
    var d = axis === 'hei' ? g.top : (axis === 'len' ? g.len : g.tot);
    return {
      main: def.name + ' ' + n + ' ' + def.unit + ' · ' + d.toFixed(1) + ' m',
      sub: '总货位 ' + g.slots.toLocaleString('zh-CN') + ' 位'
    };
  }

  function showHud(axis, n, g) {
    var t = hudText(axis, n, g), def = AX[axis];
    H.hudAxis.textContent = def.arrow;
    H.hudAxis.style.background = '#' + new T.Color(def.c).getHexString();
    H.hudMain.textContent = t.main;
    H.hudSub.textContent = t.sub;
    H.hud.classList.add('show');
  }

  function hideHud() { H.hud.classList.remove('show'); }

  function applyDim(axis, n) {
    var p = predict(axis, n);
    var err = core.validate(p.c);
    if (err) return false;
    WAP.state.cfg = p.c;
    WAP.app.commit(true);
    return true;
  }

  function schedule(n) {
    H.pending = n;
    if (H.raf) return;
    H.raf = global.requestAnimationFrame(function () {
      H.raf = 0;
      if (!H.drag) return;
      applyDim(H.drag.axis, H.pending);
    });
  }

  /* ---------- 交互 ---------- */
  function down(e) {
    if (e.button !== 0 || !H.root || !H.root.visible) return false;
    var hit = hitTest(e);
    if (!hit) return false;
    var spec = hit.object.userData.spec;
    e.preventDefault();
    var sa = screenAxis(spec);
    try { H.canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    H.canvas.style.cursor = 'grabbing';
    setHover(null);
    H.drag = {
      id: e.pointerId, axis: spec.axis, def: spec.def,
      sx: e.clientX, sy: e.clientY, vx: sa.vx, vy: sa.vy, ppm: sa.ppm,
      n0: spec.n, last: spec.n, step: stepOf(spec.axis),
      min: spec.def.min, max: spec.def.max, moved: false
    };
    showHud(spec.axis, spec.n, WAP.state.geom);
    D.getElementById('viewBadgeTxt').textContent = '正在拖拽' + spec.def.name + '控制点';
    return true;   // 通知场景：本次按下由控制点接管，不启动相机拖拽
  }

  /* 视口内的 hover：命中则改变光标并放大把手 */
  function hover(e) {
    if (H.drag) return true;
    if (!H.root || !H.root.visible) return false;
    var hit = hitTest(e);
    var spec = hit ? hit.object.userData.spec : null;
    setHover(spec);
    if (!spec) return false;
    H.canvas.style.cursor = spec.def.cursor;
    return true;
  }

  function move(e) {
    var d = H.drag;
    if (!d || (e.pointerId != null && d.id !== e.pointerId)) return;
    /* 鼠标位移在该轴屏幕方向上的投影 → 世界距离 → 离散的列 / 排 / 层数 */
    var px = (e.clientX - d.sx) * d.vx + (e.clientY - d.sy) * d.vy;
    var n = core.clampInt(d.n0 + Math.round(px / d.ppm / d.step), d.min, d.max);
    if (n === d.last) return;
    d.last = n;
    d.moved = true;
    var pr = predict(d.axis, n);
    showHud(d.axis, n, pr.g);
    schedule(n);
  }

  function up(e) {
    var d = H.drag;
    if (!d || (e && e.pointerId != null && d.id !== e.pointerId)) return;
    H.drag = null;
    if (H.raf) { global.cancelAnimationFrame(H.raf); H.raf = 0; }
    try { H.canvas.releasePointerCapture(d.id); } catch (err) { /* ignore */ }
    H.canvas.style.cursor = 'grab';
    hideHud();
    setHover(null);
    if (d.moved) {
      applyDim(d.axis, d.last);
      var g = WAP.state.geom, def = d.def;
      var dim = d.axis === 'hei' ? g.top : (d.axis === 'len' ? g.len : g.tot);
      WAP.ui.toast(def.name + '已调整：' + d.last + ' ' + def.unit + ' · ' + dim.toFixed(1) + ' m');
    }
    sync();
    D.getElementById('viewBadgeTxt').textContent =
      WAP.state.selection.rack ? '晶格框块已显示 · 拖拽控制点可改尺寸' : '透视视图';
  }

  function beforeRender() {
    if (!H.root || !H.root.visible || !H.rings.length) return;
    var q = camLocalQuat();
    for (var i = 0; i < H.rings.length; i++) H.rings[i].quaternion.copy(q);
  }

  function init() {
    H.canvas = D.getElementById('c');
    H.hud = D.getElementById('dragHud');
    H.hudAxis = D.getElementById('dhAxis');
    H.hudMain = D.getElementById('dhMain');
    H.hudSub = D.getElementById('dhSub');
    H.rc = new T.Raycaster();
    H.v2 = new T.Vector2();

    var S = WAP.scene.S;
    H.root = S.handleRoot;
    S.onHandleDown = down;
    S.onHandleMove = hover;
    S.onBeforeRender = beforeRender;

    /* 拖出视口也能继续接收指针事件 */
    global.addEventListener('pointermove', move);
    global.addEventListener('pointerup', up);
    global.addEventListener('pointercancel', up);
    global.addEventListener('blur', function () { if (H.drag) up(null); });
    global.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && H.drag) { H.drag.moved = false; up(null); }
    });
  }

  WAP.handles = {
    init: init, sync: sync, setVisible: setVisible,
    get dragging() { return !!H.drag; }
  };
})(window);
