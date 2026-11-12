/* WAP-Eavan · scene.js
   Three.js 场景、灯光、相机轨道控制与拾取。
   modelRoot 为「模型变换组」，可整体平移 + 水平旋转；其下挂 rackRoot（库体）
   与 handleRoot（晶格尺寸控制点），两者随模型一起变换，保持像素级对齐。
   decoRoot（地面 / 网格 / 接地阴影）与 gizmoRoot（世界轴变换手柄）独立于模型。 */
(function (global) {
  'use strict';
  var WAP = global.WAP = global.WAP || {};
  var T = global.THREE;

  var S = {
    renderer: null, scene: null, camera: null, canvas: null, container: null,
    modelRoot: null, rackRoot: null, decoRoot: null, handleRoot: null, gizmoRoot: null,
    simRoot: null,                 // 运行仿真设备（随模型一起变换，独立于库体重建）
    groundShadow: null, shadowGroup: null, keyLight: null, pickables: [],
    raycaster: null, v2: null,
    ctrl: { target: null, radius: 48, theta: 0.78, phi: 1.02, minR: 4, maxR: 260 },
    drag: null, mode: 'rotate', prevMode: 'rotate',
    onPick: null, onFrame: null, onMode: null, onTick: null, lastT: 0,
    onHandleDown: null, onHandleMove: null, onBeforeRender: null,
    onEquipDown: null, onEquipMove: null,
    onRouteDown: null, onRouteMove: null,
    onTransformDown: null, onTransformMove: null, onTransformFrame: null,
    frames: 0, fps: 0, fpsAt: 0, _raf: 0
  };

  function init(canvas, container) {
    S.canvas = canvas;
    S.container = container;

    var renderer = new T.WebGLRenderer({ canvas: canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(global.devicePixelRatio || 1, 2));
    renderer.setClearColor(0x000000, 0);
    renderer.outputEncoding = T.sRGBEncoding;
    renderer.toneMapping = T.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.86;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = T.PCFSoftShadowMap;
    S.renderer = renderer;

    WAP.materials.init(renderer);

    var scene = new T.Scene();
    scene.fog = new T.Fog(0xdfe8f4, 120, 320);
    if (WAP.materials.envMap) scene.environment = WAP.materials.envMap;
    S.scene = scene;

    var camera = new T.PerspectiveCamera(42, 1, 0.1, 1000);
    S.camera = camera;

    var hemi = new T.HemisphereLight(0xffffff, 0xaebbd0, 0.60);
    scene.add(hemi);
    var key = new T.DirectionalLight(0xfff7ea, 1.12);
    key.position.set(38, 66, 34);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.near = 1;
    key.shadow.camera.far = 220;
    key.shadow.camera.left = -38;
    key.shadow.camera.right = 38;
    key.shadow.camera.top = 38;
    key.shadow.camera.bottom = -38;
    key.shadow.bias = -0.0007;
    key.shadow.normalBias = 0.025;
    key.shadow.radius = 2.5;
    scene.add(key);
    scene.add(key.target);   // 让阴影相机跟随模型平移
    S.keyLight = key;
    var fill = new T.DirectionalLight(0xdbe8ff, 0.30);
    fill.position.set(-40, 26, -32);
    scene.add(fill);
    var rim = new T.DirectionalLight(0xfff1dd, 0.18);
    rim.position.set(8, 14, -48);
    scene.add(rim);

    /* ---------------- 地面与网格（不随模型移动） ---------------- */
    var deco = new T.Group();
    scene.add(deco);
    S.decoRoot = deco;
    var ground = new T.Mesh(
      new T.PlaneGeometry(320, 320),
      new T.MeshStandardMaterial({
        map: WAP.materials.groundTexture(), color: 0xffffff,
        roughness: 0.94, metalness: 0.02, transparent: true, opacity: 0.97
      })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.035;
    ground.receiveShadow = true;
    deco.add(ground);

    var grid = new T.GridHelper(240, 120, 0xc4d0e2, 0xdce5f1);
    grid.position.y = 0.002;
    grid.material.transparent = true;
    grid.material.opacity = 0.46;
    deco.add(grid);
    var grid2 = new T.GridHelper(240, 24, 0xaebbd2, 0xc7d3e6);
    grid2.position.y = 0.004;
    grid2.material.transparent = true;
    grid2.material.opacity = 0.36;
    deco.add(grid2);

    /* 柔和接地阴影：跟随模型的水平位置与朝向，但始终贴在地面 */
    var shadowGroup = new T.Group();
    deco.add(shadowGroup);
    S.shadowGroup = shadowGroup;
    var shadow = new T.Mesh(
      new T.PlaneGeometry(1, 1),
      new T.MeshBasicMaterial({
        map: WAP.materials.shadowTexture(), transparent: true,
        opacity: 0.72, depthWrite: false, toneMapped: false
      })
    );
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.012;
    shadow.renderOrder = 1;
    shadowGroup.add(shadow);
    S.groundShadow = shadow;

    /* ---------------- 模型变换组 ---------------- */
    var root = new T.Group();
    scene.add(root);
    S.modelRoot = root;

    var rackRoot = new T.Group();
    root.add(rackRoot);
    S.rackRoot = rackRoot;

    var handleRoot = new T.Group();
    root.add(handleRoot);
    S.handleRoot = handleRoot;

    /* 运行仿真设备：四向车、搬运托盘、作业货位框；随模型整体变换 */
    var simRoot = new T.Group();
    root.add(simRoot);
    S.simRoot = simRoot;

    /* 世界轴对齐的变换手柄：不随模型旋转 */
    var gizmoRoot = new T.Group();
    scene.add(gizmoRoot);
    S.gizmoRoot = gizmoRoot;
    gizmoRoot.visible = false;

    S.raycaster = new T.Raycaster();
    S.v2 = new T.Vector2();
    S.ctrl.target = new T.Vector3(0, 3.2, 0);

    bindEvents();
    resize();
    applyCamera();
    loop(0);
    return S;
  }

  function applyCamera() {
    var c = S.ctrl;
    c.phi = Math.max(0.10, Math.min(1.53, c.phi));
    c.radius = Math.max(c.minR, Math.min(c.maxR, c.radius));
    var sp = Math.sin(c.phi);
    S.camera.position.set(
      c.target.x + c.radius * sp * Math.sin(c.theta),
      c.target.y + c.radius * Math.cos(c.phi),
      c.target.z + c.radius * sp * Math.cos(c.theta)
    );
    S.camera.lookAt(c.target);
  }

  function pan(dx, dy) {
    var fwd = new T.Vector3();
    S.camera.getWorldDirection(fwd);
    var right = new T.Vector3().crossVectors(fwd, S.camera.up).normalize();
    var up = new T.Vector3().crossVectors(right, fwd).normalize();
    var k = S.ctrl.radius * 0.00155;
    S.ctrl.target.addScaledVector(right, -dx * k);
    S.ctrl.target.addScaledVector(up, dy * k);
    S.ctrl.target.y = Math.max(0.2, S.ctrl.target.y);
    applyCamera();
  }

  function bindEvents() {
    var el = S.canvas;
    el.addEventListener('contextmenu', function (e) { e.preventDefault(); });

    el.addEventListener('pointerdown', function (e) {
      if (e.button > 2) return;
      /* Alt + 左键：贯穿所有场景（普通 / 编辑 / 采点 / 模型变换）只旋转视角，
         跳过全部业务钩子，不触发任何选中、拖拽或点位操作。 */
      if (e.button === 0 && e.altKey) {
        S.drag = {
          id: e.pointerId, x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY,
          button: 0, moved: 0, panning: false, altRotate: true
        };
        try { el.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        el.style.cursor = 'grabbing';
        return;
      }
      /* 输送线路线设计：采点状态优先于一切（不改动其它模式的既有交互） */
      if (e.button === 0 && S.onRouteDown && S.onRouteDown(e)) return;
      /* 模型变换模式：左键一律由 transform 接管（Gizmo 或自由拖拽） */
      if (e.button === 0 && S.mode === 'object' && S.onTransformDown && S.onTransformDown(e)) return;
      /* 输送设备系统：选中 / 编辑拖拽优先于相机操作 */
      if (e.button === 0 && S.onEquipDown && S.onEquipDown(e)) return;
      /* 晶格尺寸控制点优先 */
      if (S.onHandleDown && S.onHandleDown(e)) return;
      S.drag = {
        id: e.pointerId, x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY,
        button: e.button, moved: 0,
        panning: e.button === 2 || e.button === 1 || e.shiftKey
      };
      try { el.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      el.style.cursor = (S.drag.panning || S.mode === 'move') ? 'grabbing' : 'grab';
    });

    el.addEventListener('pointermove', function (e) {
      if (!S.drag && S.onRouteMove && S.onRouteMove(e)) return;
      if (!S.drag && S.onEquipMove && S.onEquipMove(e)) return;
      if (!S.drag && S.onTransformMove && S.onTransformMove(e)) return;
      if (!S.drag && S.onHandleMove && S.onHandleMove(e)) return;
      var d = S.drag;
      if (!d || d.id !== e.pointerId) {
        el.style.cursor = 'grab';
        return;
      }
      var dx = e.clientX - d.x, dy = e.clientY - d.y;
      d.x = e.clientX; d.y = e.clientY;
      d.moved += Math.abs(dx) + Math.abs(dy);
      if (d.altRotate) {
        S.ctrl.theta -= dx * 0.0058;
        S.ctrl.phi -= dy * 0.0058;
        applyCamera();
      } else if (d.panning || (d.button === 0 && S.mode === 'move')) {
        pan(dx, dy);
      } else if (d.button === 0 && S.mode === 'rotate') {
        S.ctrl.theta -= dx * 0.0058;
        S.ctrl.phi -= dy * 0.0058;
        applyCamera();
      } else if (d.button === 0 && S.mode === 'object') {
        /* 变换模式的自由拖拽由 transform 的全局指针事件处理 */
      } else if (d.button === 1) {
        S.ctrl.radius *= Math.exp(dy * 0.006);
        applyCamera();
      }
    });

    var end = function (e) {
      var d = S.drag;
      if (!d || d.id !== e.pointerId) return;
      S.drag = null;
      el.style.cursor = 'grab';
      try { el.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      if (d.button === 0 && d.moved < 5 && !d.altRotate && S.mode !== 'object' && S.onPick) {
        var r = el.getBoundingClientRect();
        S.v2.set((e.clientX - r.left) / r.width * 2 - 1, -(e.clientY - r.top) / r.height * 2 + 1);
        S.onPick(S.v2.clone(), e);
      }
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);

    el.addEventListener('wheel', function (e) {
      e.preventDefault();
      S.ctrl.radius *= Math.exp(e.deltaY * 0.00095);
      applyCamera();
    }, { passive: false });

    global.addEventListener('resize', resize);
    if (global.ResizeObserver) {
      new global.ResizeObserver(resize).observe(S.container);
    }
  }

  function resize() {
    if (!S.container) return;
    var w = Math.max(1, S.container.clientWidth), h = Math.max(1, S.container.clientHeight);
    S.renderer.setSize(w, h, false);
    S.camera.aspect = w / h;
    S.camera.updateProjectionMatrix();
  }

  function loop(t) {
    S._raf = global.requestAnimationFrame(loop);
    if (!S.lastT) S.lastT = t;
    var dt = Math.max(0, Math.min(0.05, (t - S.lastT) / 1000));
    S.lastT = t;
    if (S.onTick) S.onTick(dt);
    if (S.onBeforeRender) S.onBeforeRender();
    if (S.onTransformFrame) S.onTransformFrame();
    S.renderer.render(S.scene, S.camera);
    S.frames++;
    if (!S.fpsAt) S.fpsAt = t;
    if (t - S.fpsAt >= 600) {
      S.fps = Math.round(S.frames * 1000 / (t - S.fpsAt));
      S.frames = 0; S.fpsAt = t;
      if (S.onFrame) S.onFrame(S.fps);
    }
  }

  function setMode(m) {
    S.mode = (m === 'move' || m === 'object') ? m : 'rotate';
    if (S.mode !== 'object') S.prevMode = S.mode;
    S.canvas.style.cursor = 'grab';
    if (S.onMode) S.onMode(S.mode);
  }

  function fit(size, keepAngle) {
    if (!keepAngle) { S.ctrl.theta = 0.78; S.ctrl.phi = 1.02; }
    var sx = size[0], sy = size[1], sz = size[2];
    var fov = S.camera.fov * Math.PI / 180;
    var need = Math.max(sx, sz) / 2 / Math.tan(fov / 2);
    S.ctrl.radius = Math.max(10, need * 1.14 + sy * 0.30);
    var p = S.modelRoot.position;
    S.ctrl.target.set(p.x, sy * 0.42 + p.y, p.z);
    applyCamera();
  }

  function reset() { fit([28, 9, 12], false); }

  function pick(ndc, objects) {
    S.raycaster.setFromCamera(ndc, S.camera);
    var hits = S.raycaster.intersectObjects(objects || S.pickables, false);
    return hits.length ? hits[0] : null;
  }

  /* 个体拾取：递归命中真实几何（货物 / 货架结构 / 四向车 / 提升机 / 输送设备），
     只有完全没有真实几何可点时才回退到不可见的「货位代理」。 */
  function pickPart(ndc) {
    S.raycaster.setFromCamera(ndc, S.camera);
    var targets = [];
    var cur = WAP.rack && WAP.rack.current;
    if (cur) targets.push(cur.root);
    if (S.simRoot) targets.push(S.simRoot);
    var hits = S.raycaster.intersectObjects(targets, true);
    var fallback = null;
    for (var i = 0; i < hits.length; i++) {
      var h = hits[i], o = h.object;
      if (!o || o.isLine || o.isLineSegments || o.isPoints || o.isSprite) continue;
      var node = o, kind = null;
      while (node && !kind) { kind = node.userData && node.userData.kind; node = node.parent; }
      if (!kind) continue;
      var p = o, vis = true;
      while (p) { if (p.visible === false) { vis = false; break; } p = p.parent; }
      if (!vis) continue;
      var cell = (kind === 'cell' && cur && cur.cells) ? cur.cells[h.instanceId] : null;
      if (kind === 'cell' && cell && (cell.conv >= 0 || cell.chg)) continue;
      var info = { hit: h, kind: kind, point: h.point, cellId: cell ? cell.id : null };
      if (kind === 'cell') { if (!fallback) fallback = info; continue; }
      return info;
    }
    return fallback;
  }

  /* 世界坐标 → 视口像素坐标，用于把上下文面板放到选中模型附近 */
  function project(v3) {
    var v = v3.clone().project(S.camera);
    return {
      x: (v.x * 0.5 + 0.5) * S.container.clientWidth,
      y: (-v.y * 0.5 + 0.5) * S.container.clientHeight
    };
  }

  function camText() {
    var c = S.ctrl;
    return 'θ ' + (c.theta * 180 / Math.PI % 360).toFixed(0) + '° · R ' + c.radius.toFixed(1) + ' m';
  }

  /* 应用模型变换：平移 + 绕自身中心水平旋转 */
  function applyTransform(t) {
    S.modelRoot.position.set(t.x, t.y, t.z);
    S.modelRoot.rotation.y = t.yaw * Math.PI / 180;
    S.modelRoot.updateMatrixWorld(true);
    S.shadowGroup.position.set(t.x, 0, t.z);
    S.shadowGroup.rotation.y = S.modelRoot.rotation.y;
    if (S.keyLight) {
      S.keyLight.position.set(t.x + 38, 66 + t.y, t.z + 34);
      S.keyLight.target.position.set(t.x, t.y, t.z);
      S.keyLight.target.updateMatrixWorld();
    }
  }

  function setShadowSize(w, d) {
    S.groundShadow.scale.set(w + 7, d + 7, 1);
  }

  function disposeNode(o) {
    o.traverse(function (n) {
      if (n.geometry) n.geometry.dispose();
      if (n.material) {
        var ms = Array.isArray(n.material) ? n.material : [n.material];
        ms.forEach(function (m) {
          if (m.userData && m.userData.shared) return;   // 共享材质库，不能释放
          if (m.map) m.map.dispose();
          m.dispose();
        });
      }
    });
  }

  WAP.scene = {
    S: S, init: init, resize: resize, setMode: setMode, fit: fit, reset: reset,
    pick: pick, pickPart: pickPart, project: project, camText: camText, applyCamera: applyCamera,
    applyTransform: applyTransform, setShadowSize: setShadowSize,
    clearModel: function () {
      var r = S.rackRoot;
      while (r.children.length) {
        var o = r.children[0];
        r.remove(o);
        disposeNode(o);
      }
      S.pickables = [];
    }
  };
})(window);
