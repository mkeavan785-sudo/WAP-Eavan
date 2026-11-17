/* WAP-Eavan · ambient.js
   气氛组动画（纯视觉、只读，不写任何状态机字段）：
   - 四向车充电演示：7 个视觉充电桩 + 电量进度环，跟随 a.charging / a.st；
   - 路线冲突避让警示：读到让行/避让状态时车身浮现橙色脉冲环；
   - 库内氛围：充电桩待机呼吸灯、低电量提示。
   硬约束：绝不改 sim.js 状态机、绝不移动真实货物 / 车辆坐标（只读 a.p），
   只在自己的 root 下新建并驱动视觉替身 mesh。
   所有动画由 scene.S.onTick 包装驱动，且默认开启（与物理开关无关）。
*/
(function (global) {
  'use strict';
  var WAP = global.WAP = global.WAP || {};
  var T = global.THREE;
  var A = {
    root: null, ready: false, t: 0,
    chargerGroup: null, chargers: [],       // 7 个视觉桩
    badges: {},                              // carId -> { ring, bar, wrap }
    masses: {}, massSeq: 0,                  // 质量标签 sprite（货物/托盘）
    lastGeomSig: ''
  };

  var CHARGE_SEC = 3.2;    // 演示：约 3s 充满（现实 ≤3h 的压缩演示）
  var DRAIN_SEC = 26;      // 演示：约 26s 从满到低（现实续航 6~8h）
  var LOW = 0.22;          // 低电量阈值

  function cfg() { return WAP.state.cfg; }
  function geom() { return WAP.core.geom(cfg(), WAP.state.overrides || {}); }
  function now() { return (global.performance && performance.now ? performance.now() : Date.now()) / 1000; }

  /* ---------- 视觉充电桩（1 处 7 个，纯演示 mesh） ---------- */
  function buildChargers() {
    if (A.chargerGroup) { A.root.remove(A.chargerGroup); disposeTree(A.chargerGroup); }
    A.chargerGroup = new T.Group();
    A.chargerGroup.userData.kind = 'ambient-chargers';
    A.chargers = [];
    var g = geom(), c = cfg();
    if (!g.bayX || !g.bayX.length || !g.blocks || !g.blocks.length) { A.root.add(A.chargerGroup); return; }
    var cx = g.bayX[g.chgBay != null ? g.chgBay : 0];
    var z0 = g.blocks[0][0] - 0.16;
    var lv = (g.chgLevels && g.chgLevels[0]) || 0;
    var yy = c.y0 + lv * c.pitch;
    var postMat = new T.MeshBasicMaterial({ color: 0x36425a });
    var faceMat = new T.MeshBasicMaterial({ color: 0x1d2738 });
    for (var i = 0; i < 7; i++) {
      var pile = new T.Group();
      var body = new T.Mesh(new T.BoxGeometry(0.30, 0.46, 0.16), postMat);
      body.position.y = 0.23; pile.add(body);
      var face = new T.Mesh(new T.BoxGeometry(0.22, 0.16, 0.02), faceMat);
      face.position.set(0, 0.34, 0.09); pile.add(face);
      var led = new T.Mesh(new T.BoxGeometry(0.16, 0.035, 0.012),
        new T.MeshBasicMaterial({ color: 0x2ee66b, toneMapped: false }));
      led.position.set(0, 0.34, 0.11); pile.add(led);
      /* 7 个桩沿同一处横向排布（现实：1 处 7 桩，各配小电柜） */
      pile.position.set(cx + (i - 3) * 0.42, yy, z0);
      pile.userData.i = i;
      A.chargerGroup.add(pile);
      A.chargers.push({ group: pile, led: led.material });
    }
    A.root.add(A.chargerGroup);
  }

  function chargerSig() {
    var g = geom();
    return [g.chgBay, (g.chgLevels || []).join(','), (g.bayX || []).length, cfg().y0, cfg().pitch].join('|');
  }

  /* ---------- 每台车的视觉徽标：电量条 + 充电环 + 避让警示环 ---------- */
  function badgeFor(a) {
    var b = A.badges[a.id];
    if (b) return b;
    var wrap = new T.Group();
    wrap.userData.kind = 'ambient-badge';
    /* 电量条（车身上方水平条，绿→黄→红） */
    var track = new T.Mesh(new T.BoxGeometry(0.62, 0.035, 0.012),
      new T.MeshBasicMaterial({ color: 0x223048, toneMapped: false }));
    wrap.add(track);
    var bar = new T.Mesh(new T.BoxGeometry(0.60, 0.05, 0.016),
      new T.MeshBasicMaterial({ color: 0x2ee66b, toneMapped: false }));
    bar.position.z = 0.004; wrap.add(bar);
    /* 充电环：绕车身的青色光圈 */
    var ring = new T.Mesh(new T.RingGeometry(0.40, 0.50, 28),
      new T.MeshBasicMaterial({ color: 0x37e0ff, transparent: true, opacity: 0, side: T.DoubleSide, toneMapped: false }));
    ring.rotation.x = -Math.PI / 2; ring.position.y = -0.14; wrap.add(ring);
    /* 避让警示环：橙色脉冲 */
    var warn = new T.Mesh(new T.RingGeometry(0.52, 0.62, 28),
      new T.MeshBasicMaterial({ color: 0xff9a1f, transparent: true, opacity: 0, side: T.DoubleSide, toneMapped: false }));
    warn.rotation.x = -Math.PI / 2; warn.position.y = -0.16; wrap.add(warn);
    /* 物理状态牌：跟随车显示「载重 / 速度 / 状态」，让物理规则肉眼可见 */
    var cv = global.document.createElement('canvas');
    cv.width = 320; cv.height = 84;
    var tex = new T.CanvasTexture(cv);
    var spr = new T.Sprite(new T.SpriteMaterial({ map: tex, transparent: true, depthTest: false, toneMapped: false }));
    spr.scale.set(1.55, 0.41, 1);
    spr.position.y = 0.30;
    spr.renderOrder = 30;
    wrap.add(spr);
    A.root.add(wrap);
    b = A.badges[a.id] = { wrap: wrap, bar: bar, ring: ring.material, warn: warn.material,
      batt: 0.55, plate: spr, plateTex: tex, plateCv: cv,
      lastPlate: '', px: a.p ? a.p.x : 0, pz: a.p ? a.p.z : 0 };
    return b;
  }

  /* 物理状态牌绘制：速度由位移实测（不读状态机），载重由 physics.massOf 只读推算 */
  function paintPlate(b, a, dt) {
    if (!b.plate) return;
    var p = a.p || a.obj.position;
    var v = dt > 0 ? Math.hypot(p.x - b.px, p.z - b.pz) / dt : 0;
    b.px = p.x; b.pz = p.z;
    b.vShow = b.vShow == null ? v : b.vShow * 0.82 + v * 0.18;   // 平滑
    var kg = 0;
    try { kg = (WAP.physics && WAP.physics.massOf) ? WAP.physics.massOf(a) || 0 : 0; } catch (e) {}
    var ph = cfg().physicsMode;
    var st = a.st || '';
    var tag = /让位|让行|避让/.test(st) ? '避让减速'
      : a.charging ? '充电中'
      : /放货|落货/.test(st) ? '放货驻留'
      : /换向|换轮/.test(st) ? '换向驻留'
      : b.vShow > 0.55 ? '满载运行' : b.vShow > 0.12 ? '加速/减速' : '待机';
    var col = tag === '避让减速' ? '#ff9a1f' : a.charging ? '#37e0ff'
      : tag === '放货驻留' || tag === '换向驻留' ? '#f0b429'
      : b.vShow > 0.12 ? '#2ee66b' : '#93a4bb';
    var txt = ph + '|' + Math.round(kg) + '|' + b.vShow.toFixed(1) + '|' + tag + '|' + col;
    if (txt === b.lastPlate) return;                // 内容未变不重绘
    b.lastPlate = txt;
    var c = b.plateCv, x = c.getContext('2d');
    x.clearRect(0, 0, c.width, c.height);
    x.fillStyle = 'rgba(16,24,40,.86)';
    x.beginPath();
    if (x.roundRect) x.roundRect(2, 2, c.width - 4, c.height - 4, 14); else x.rect(2, 2, c.width - 4, c.height - 4);
    x.fill();
    x.strokeStyle = col; x.lineWidth = 2; x.stroke();
    x.font = 'bold 27px "Microsoft YaHei",sans-serif';
    x.fillStyle = col;
    x.fillText((ph ? '⚗ ' : '○ ') + Math.round(kg) + 'kg · ' + b.vShow.toFixed(1) + ' m/s', 16, 34);
    x.font = '22px "Microsoft YaHei",sans-serif';
    x.fillStyle = '#e8eef8';
    x.fillText(tag, 16, 66);
    b.plateTex.needsUpdate = true;
  }

  function setBar(b, frac) {
    var w = Math.max(0.002, 0.60 * Math.min(1, Math.max(0, frac)));
    b.bar.scale.x = w / 0.60;
    b.bar.position.x = -(0.60 - w) / 2;
    var col = frac < LOW ? 0xff3b30 : (frac < 0.5 ? 0xffc22e : 0x2ee66b);
    b.bar.material.color.setHex(col);
  }

  function disposeTree(obj) {
    obj.traverse(function (o) {
      if (o.geometry && o.geometry.dispose) o.geometry.dispose();
      if (o.material) {
        var ms = Array.isArray(o.material) ? o.material : [o.material];
        ms.forEach(function (m) { if (m && m.dispose) m.dispose(); });
      }
    });
  }

  /* ---------- 货物 / 托盘质量牌：每个刚体头顶显示自身质量 ----------
     只读 unit.userData.massKg（由 carrier / pallets / sim stamp），绝不写质量本身。 */
  function massLabelFor(unit) {
    var id = unit.userData && unit.userData.muid;
    if (id && A.masses[id]) return A.masses[id];
    var kg = (WAP.physics && WAP.physics.unitMass) ? WAP.physics.unitMass(unit) : 0;
    if (!kg) return null;
    var isPallet = !!(unit.userData && unit.userData.palletClass);
    var cv = global.document.createElement('canvas');
    cv.width = 168; cv.height = 52;
    var ctx = cv.getContext('2d');
    ctx.fillStyle = isPallet ? 'rgba(60,48,20,.88)' : 'rgba(16,32,48,.88)';
    if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(2, 2, cv.width - 4, cv.height - 4, 10); ctx.fill(); }
    else ctx.fillRect(2, 2, cv.width - 4, cv.height - 4);
    ctx.strokeStyle = isPallet ? '#c99a4a' : '#48b0e0'; ctx.lineWidth = 2; ctx.stroke();
    ctx.font = 'bold 24px Consolas,monospace';
    ctx.fillStyle = isPallet ? '#f5c76a' : '#7fe0ff';
    ctx.textAlign = 'center';
    ctx.fillText((isPallet ? '托 ' : '货 ') + Math.round(kg) + ' kg', cv.width / 2, 34);
    var tex = new T.CanvasTexture(cv);
    var spr = new T.Sprite(new T.SpriteMaterial({ map: tex, transparent: true, depthTest: false, toneMapped: false }));
    spr.scale.set(1.05, 0.32, 1);
    spr.userData.kind = 'mass-label';
    spr.renderOrder = 31;
    A.root.add(spr);
    id = id || ('mu' + (++A.massSeq));
    unit.userData.muid = id;
    var rec = { sprite: spr, tex: tex, kg: kg, pallet: isPallet };
    A.masses[id] = rec;
    return rec;
  }
  function updateMassLabels() {
    var live = {}, n = 0;
    function scan(root) {
      if (!root || n >= 60) return;
      root.traverse(function (o) {
        if (n >= 60) return;
        if (o.userData && o.userData.massKg != null) {
          var rec = massLabelFor(o);
          if (rec) {
            live[o.userData.muid] = 1;
            var p = o.getWorldPosition(new T.Vector3());
            A.root.worldToLocal(p);
            rec.sprite.position.set(p.x, p.y + 0.55, p.z);
            rec.sprite.visible = true;
            n++;
          }
        }
      });
    }
    var c = carrier();
    if (c && c.root) { scan(c.root); (c.rest || []).forEach(function (q) { if (q.unit) scan(q.unit); }); }
    var pl = WAP.pallets;
    if (pl && pl.units) pl.units.forEach(function (q) { if (q.unit) scan(q.unit); });
    /* 清理已消失单元的质量牌 */
    Object.keys(A.masses).forEach(function (id) {
      if (id.indexOf('rack|') === 0) return;   // 库内标签由 updateRackMassLabels 管理
      if (!live[id]) {
        var rec = A.masses[id];
        if (rec.sprite.parent) rec.sprite.parent.remove(rec.sprite);
        if (rec.tex.dispose) rec.tex.dispose();
        delete A.masses[id];
      }
    });
    return n;
  }
  /* 库内在库货物质量牌：货位是 InstancedMesh，没有独立 Group，
     这里按 occ 货位坐标直接生成轻量质量牌（抽样，避免上百个标签糊屏）。 */
  function updateRackMassLabels() {
    var cur = WAP.rack && WAP.rack.current;
    if (!cur || !cur.cells) return 0;
    var kgEach = (WAP.physics && WAP.physics.classKg) ? WAP.physics.classKg(cfg().cargoClass) : 0;
    if (!kgEach) return 0;
    var shown = 0, MAX = 36;
    var selL = null;
    try { selL = (WAP.state.selection && WAP.state.selection.cell) ? null : null; } catch (e) {}
    for (var i = 0; i < cur.cells.length && shown < MAX; i++) {
      var c = cur.cells[i];
      if (!c.occ || c.conv >= 0 || c.chg) continue;
      var key = 'rack|' + c.id, rec = A.masses[key];
      if (!rec) rec = createMassSprite(key, kgEach, false);
      rec.sprite.position.set(c.x, c.y + 0.45, c.z);
      rec.sprite.visible = true;
      A.masses[key] = rec;
      shown++;
    }
    /* 清理不再占用的货位标签 */
    Object.keys(A.masses).forEach(function (k) {
      if (k.indexOf('rack|') !== 0) return;
      var id = k.slice(5), cell = cur.cellById && cur.cellById[id];
      if (!cell || !cell.occ) {
        var rec = A.masses[k];
        if (rec.sprite.parent) rec.sprite.parent.remove(rec.sprite);
        if (rec.tex.dispose) rec.tex.dispose();
        delete A.masses[k];
      }
    });
    return shown;
  }
  /* 创建一个质量牌 sprite（key 稳定、文字固定） */
  function createMassSprite(key, kg, pallet) {
    var cv = global.document.createElement('canvas');
    cv.width = 168; cv.height = 52;
    var ctx = cv.getContext('2d');
    ctx.fillStyle = pallet ? 'rgba(60,48,20,.88)' : 'rgba(16,32,48,.88)';
    if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(2, 2, cv.width - 4, cv.height - 4, 10); ctx.fill(); }
    else ctx.fillRect(2, 2, cv.width - 4, cv.height - 4);
    ctx.strokeStyle = pallet ? '#c99a4a' : '#48b0e0'; ctx.lineWidth = 2; ctx.stroke();
    ctx.font = 'bold 24px Consolas,monospace';
    ctx.fillStyle = pallet ? '#f5c76a' : '#7fe0ff'; ctx.textAlign = 'center';
    ctx.fillText((pallet ? '托 ' : '货 ') + Math.round(kg) + ' kg', cv.width / 2, 34);
    var tex = new T.CanvasTexture(cv);
    var spr = new T.Sprite(new T.SpriteMaterial({ map: tex, transparent: true, depthTest: false, toneMapped: false }));
    spr.scale.set(1.05, 0.32, 1);
    spr.userData.kind = 'mass-label'; spr.renderOrder = 31;
    A.root.add(spr);
    return { sprite: spr, tex: tex, kg: kg, pallet: pallet };
  }
  function carrier() { return WAP.carrier; }

  /* ---------- 屏幕固定物理 HUD：实时速度/载重/状态汇总（看得见的物理） ---------- */
  function updateHUD(devices, dt, massCount) {
    var hud = global.document.getElementById('physHud');
    if (!hud) return;
    var ph = !!cfg().physicsMode;
    hud.hidden = !ph;                       // 关物理即隐藏
    if (!ph) return;
    var presetEl = global.document.getElementById('phPreset');
    if (presetEl) presetEl.textContent = cfg().simPreset === 'real' ? '真实 FWS-H150' : '演示快节奏';
    var rowsEl = global.document.getElementById('phRows');
    if (!rowsEl) return;
    /* 节流到 ~5Hz，避免每帧重建 DOM */
    A.hudT = (A.hudT || 0) + dt;
    if (A.hudT < 0.2) return;
    A.hudT = 0;
    var html = '', dodging = 0, charging = 0, maxV = 0;
    devices.slice(0, 8).forEach(function (a) {
      if (!a || !a.obj) return;
      var b = A.badges[a.id];
      var v = b && b.vShow != null ? b.vShow : 0;
      var kg = 0;
      try { kg = (WAP.physics && WAP.physics.massOf) ? WAP.physics.massOf(a) || 0 : 0; } catch (e) {}
      var st = a.st || '';
      var tag = /让位|让行|避让/.test(st) ? '避让' : a.charging ? '充电'
        : /放货|落货/.test(st) ? '放货' : /换向|换轮/.test(st) ? '换向'
        : v > 0.55 ? '运行' : v > 0.12 ? '加减速' : '待机';
      if (tag === '避让') dodging++;
      if (a.charging) charging++;
      if (v > maxV) maxV = v;
      var color = tag === '避让' ? '#ff9a1f' : a.charging ? '#37e0ff'
        : tag === '放货' || tag === '换向' ? '#f0b429' : v > 0.12 ? '#2ee66b' : '#93a4bb';
      var bar = Math.min(100, Math.round(v / 3 * 100));
      html += '<div class="ph-row"><span class="ph-id">' + (a.code || a.id) + '</span>' +
        '<span class="ph-tag" style="color:' + color + '">' + tag + '</span>' +
        '<span class="ph-v">' + v.toFixed(2) + ' m/s</span>' +
        '<span class="ph-kg">' + Math.round(kg) + 'kg</span>' +
        '<i class="ph-bar"><i style="width:' + bar + '%;background:' + color + '"></i></i></div>';
    });
    rowsEl.innerHTML = html || '<div class="ph-empty">无车辆</div>';
    /* 静态在库货物总质量：按货物大类（含托盘） × 在库货位数 */
    var mEl = global.document.getElementById('phMass');
    if (mEl) {
      var kgEach = (WAP.physics && WAP.physics.classKg) ? WAP.physics.classKg(cfg().cargoClass) : 0;
      var used = (WAP.state.geom && WAP.state.geom.used) || 0;
      var tons = kgEach * used / 1000;
      mEl.textContent = '在库 ' + used + ' 位 × ' + Math.round(kgEach) + 'kg ＝ ' + tons.toFixed(1) + ' t（含托盘）';
    }
    var foot = global.document.getElementById('phFoot');
    if (foot) foot.textContent = '峰值 ' + maxV.toFixed(2) + ' m/s · 质量牌 ' + (massCount || 0) +
      ' 件 · 避让 ' + dodging + ' · 充电 ' + charging;
  }

  /* ---------- 每帧：只读状态 → 驱动视觉 ---------- */
  function tick(dt) {
    if (!A.ready) return;
    A.t += dt;
    var sig = chargerSig();
    if (sig !== A.lastGeomSig) { A.lastGeomSig = sig; buildChargers(); }

    var devices = (WAP.sim && WAP.sim.devices) || [];
    var chargingCount = 0, idx = 0;

    /* 清库/重建后移除已不存在车辆的徽标，避免悬空残留 */
    var liveIds = {};
    devices.forEach(function (a) { if (a && a.id) liveIds[a.id] = 1; });
    Object.keys(A.badges).forEach(function (id) {
      if (!liveIds[id]) {
        var b = A.badges[id];
        if (b.wrap && b.wrap.parent) b.wrap.parent.remove(b.wrap);
        if (b.plateTex && b.plateTex.dispose) b.plateTex.dispose();
        delete A.badges[id];
      }
    });

    devices.forEach(function (a) {
      if (!a || !a.obj) return;
      var b = badgeFor(a);
      var charging = !!a.charging;
      if (charging) chargingCount++;
      /* 电量：充电上升、运行下降；仿真播放与否按现实节奏演示 */
      b.batt = charging
        ? Math.min(1, b.batt + dt / CHARGE_SEC)
        : Math.max(0.06, b.batt - dt / DRAIN_SEC * (WAP.sim && WAP.sim.playing ? 1 : 0.25));
      setBar(b, b.batt);

      /* 徽标跟随车（只读 a.p，不改坐标） */
      var p = a.p || a.obj.position;
      b.wrap.position.set(p.x, (a.L != null ? levelY(a.L) : p.y) + 0.62, p.z);

      /* 物理状态牌：仿真播放或物理开启时显示（真实速度/载重/状态） */
      var playing = !!(WAP.sim && WAP.sim.playing);
      if (b.plate) b.plate.visible = playing || cfg().physicsMode;
      if (b.plate && b.plate.visible) paintPlate(b, a, dt);

      /* 充电环：呼吸 */
      b.ring.opacity = charging ? 0.30 + 0.28 * (0.5 + 0.5 * Math.sin(A.t * 4.5)) : 0;

      /* 避让警示：读状态机字段，绝不写 */
      var dodging = /让位|让行|避让/.test(a.st || '') ||
                    (a._dodgeAt && now() - a._dodgeAt < 3) ||
                    (a.q && a.q.some(function (t) { return /让位|让行/.test(t.st || ''); }));
      b.warn.opacity = dodging ? 0.25 + 0.35 * Math.abs(Math.sin(A.t * 6)) : 0;

      /* 充电桩 LED：前 N 个随充电车辆数点亮 / 呼吸 */
      if (A.chargers[idx]) {
        var led = A.chargers[idx].led;
        led.color.setHex(charging ? 0xffb020 : (b.batt < LOW ? 0xff3b30 : 0x2ee66b));
        led.opacity = 1;
        idx++;
      }
    });

    /* 未对应车辆的桩：待机呼吸绿 */
    for (var i = idx; i < A.chargers.length; i++) {
      var m = A.chargers[i].led;
      m.color.setHex(0x2ee66b);
    }
    /* 充电区整体氛围：7 桩 LED 缓慢交替亮度（呼吸） */
    var breathe = 0.55 + 0.45 * (0.5 + 0.5 * Math.sin(A.t * 1.6));
    A.chargers.forEach(function (ch, k) {
      if (k >= idx) ch.led.color.multiplyScalar(0.5 + 0.5 * breathe);
    });

    /* 货物 / 托盘质量牌（在途 + 库内抽样）+ 屏幕 HUD */
    var massCount = 0;
    if (cfg().physicsMode) {
      massCount = updateMassLabels() + updateRackMassLabels();
    }
    updateHUD(devices, dt, massCount);
  }

  function levelY(L) {
    if (WAP.sim && WAP.sim.levelY) return WAP.sim.levelY(L);
    var c = cfg();
    return (c.y0 || 0) + L * (c.pitch || 1.2) - 0.19;  // 与 sim.js levelY 同公式
  }

  function init() {
    if (A.ready) return;
    var S = WAP.scene && WAP.scene.S;
    if (!S || !S.modelRoot) return;
    A.root = new T.Group();
    A.root.userData.kind = 'ambient';
    S.modelRoot.add(A.root);
    buildChargers();
    A.lastGeomSig = chargerSig();
    var prev = S.onTick;
    S.onTick = function (dt) { if (prev) prev(dt); tick(dt); };
    A.ready = true;
  }

  WAP.ambient = { init: init };
})(window);
