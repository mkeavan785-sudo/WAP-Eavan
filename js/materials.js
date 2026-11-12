/* WAP-Eavan · materials.js
   程序化贴图与 PBR 材质库。
   所有贴图均由 Canvas 实时绘制，无外部图片依赖，file:// 双击即可离线运行。
   参考效果图的质感要点：瓦楞纸箱印刷（THIS SIDE UP / 条码 / 标签 / 胶带）、
   白色缠膜箱与棕色胶带、蓝色塑料料箱加强筋、冲孔立柱、烤漆横梁、
   金属轨道、混凝土地面、柔和接地阴影、黄色安全护网。 */
(function (global) {
  'use strict';
  var WAP = global.WAP = global.WAP || {};
  var T = global.THREE;
  var D = global.document;

  var cache = {};        // 贴图缓存：key -> CanvasTexture
  var matCache = {};     // 材质缓存：key -> Material / Material[]
  var aniso = 4;
  var envMap = null;

  /* 稳定伪随机：贴图每次生成结果一致 */
  function rnd(seed) {
    var x = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
    return x - Math.floor(x);
  }

  function mkTex(key, w, h, draw, opt) {
    if (cache[key]) return cache[key];
    var c = D.createElement('canvas');
    c.width = w; c.height = h;
    var x = c.getContext('2d');
    draw(x, w, h);
    var t = new T.CanvasTexture(c);
    t.encoding = T.sRGBEncoding;
    t.anisotropy = aniso;
    t.wrapS = t.wrapT = (opt && opt.repeat) ? T.RepeatWrapping : T.ClampToEdgeWrapping;
    if (opt && opt.repeat) t.repeat.set(opt.repeat[0], opt.repeat[1]);
    t.needsUpdate = true;
    cache[key] = t;
    return t;
  }

  function sheet(x, w, h, top, mid, bottom) {
    var g = x.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, top); g.addColorStop(0.52, mid); g.addColorStop(1, bottom);
    x.fillStyle = g; x.fillRect(0, 0, w, h);
  }

  function fibers(x, w, h, n, alpha, tint) {
    x.save();
    x.globalAlpha = alpha;
    x.strokeStyle = tint;
    x.lineWidth = 1;
    for (var i = 0; i < n; i++) {
      var px = rnd(i * 3.1 + 1) * w, py = rnd(i * 7.7 + 2) * h;
      var len = 3 + rnd(i * 5.3 + 3) * 16;
      x.beginPath(); x.moveTo(px, py); x.lineTo(px + len, py + (rnd(i + 9) - 0.5) * 2); x.stroke();
    }
    x.restore();
  }

  function vignette(x, w, h, strength) {
    var g = x.createRadialGradient(w / 2, h / 2, w * 0.18, w / 2, h / 2, w * 0.78);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(38,24,8,' + strength + ')');
    x.fillStyle = g; x.fillRect(0, 0, w, h);
  }

  function tape(x, w, h, horizontal) {
    x.save();
    x.globalAlpha = 0.55;
    var g = horizontal
      ? x.createLinearGradient(0, h * 0.44, 0, h * 0.56)
      : x.createLinearGradient(w * 0.44, 0, w * 0.56, 0);
    g.addColorStop(0, '#f4e0b4'); g.addColorStop(0.5, '#fff3d4'); g.addColorStop(1, '#e6cd97');
    x.fillStyle = g;
    if (horizontal) x.fillRect(0, h * 0.44, w, h * 0.12);
    else x.fillRect(w * 0.44, 0, w * 0.12, h);
    x.globalAlpha = 0.22; x.strokeStyle = '#8a6a36'; x.lineWidth = 1;
    if (horizontal) { x.beginPath(); x.moveTo(0, h * 0.44); x.lineTo(w, h * 0.44); x.moveTo(0, h * 0.56); x.lineTo(w, h * 0.56); x.stroke(); }
    else { x.beginPath(); x.moveTo(w * 0.44, 0); x.lineTo(w * 0.44, h); x.moveTo(w * 0.56, 0); x.lineTo(w * 0.56, h); x.stroke(); }
    x.restore();
  }

  function barcode(x, bx, by, bw, bh) {
    x.fillStyle = '#f8f8f4'; x.fillRect(bx - 3, by - 3, bw + 6, bh + 8);
    x.strokeStyle = '#c9c9c2'; x.lineWidth = 1; x.strokeRect(bx - 3, by - 3, bw + 6, bh + 8);
    x.fillStyle = '#22252b';
    var px = bx;
    for (var i = 0; px < bx + bw; i++) {
      var wid = 1 + Math.floor(rnd(i * 2.7 + 11) * 3);
      if (i % 2 === 0) x.fillRect(px, by, wid, bh);
      px += wid + 1 + Math.floor(rnd(i * 4.1 + 5) * 2);
    }
    x.font = '600 8px monospace'; x.fillStyle = '#3b3f47';
    x.fillText('4 902830 118426', bx, by + bh + 6);
  }

  function shipLabel(x, w, h, lx, ly, lw, lh) {
    x.fillStyle = '#fbfaf5'; x.fillRect(lx, ly, lw, lh);
    x.strokeStyle = '#d6d3c8'; x.lineWidth = 1; x.strokeRect(lx + 0.5, ly + 0.5, lw - 1, lh - 1);
    x.fillStyle = '#9a9487';
    for (var i = 0; i < 3; i++) x.fillRect(lx + 7, ly + 8 + i * 8, lw * (0.55 + rnd(i + 31) * 0.3), 2.5);
    barcode(x, lx + 7, ly + lh - 24, lw - 16, 11);
  }

  /* ---------------- 瓦楞纸箱 ---------------- */
  function kraftBase(x, w, h) {
    sheet(x, w, h, '#c99a5e', '#ad7b43', '#8e6033');
    x.save(); x.globalAlpha = 0.10; x.strokeStyle = '#7a542c'; x.lineWidth = 1;
    for (var i = 0; i < h; i += 5) {
      x.beginPath(); x.moveTo(0, i + 0.5); x.lineTo(w, i + 0.5); x.stroke();
    }
    x.restore();
    fibers(x, w, h, 260, 0.12, '#5e3d1e');
    vignette(x, w, h, 0.24);
  }

  function kraftPrint(x, w, h, heavy) {
    kraftBase(x, w, h);
    tape(x, w, h, false);
    x.save();
    x.fillStyle = '#5b3a1c';
    x.font = '700 ' + Math.round(h * 0.085) + 'px Arial, sans-serif';
    x.textAlign = 'center';
    x.fillText('THIS SIDE UP', w * 0.5, h * 0.30);
    x.font = '700 ' + Math.round(h * 0.13) + 'px Arial, sans-serif';
    x.fillText('↑ ↑', w * 0.5, h * 0.44);
    x.font = '600 ' + Math.round(h * 0.058) + 'px Arial, sans-serif';
    x.fillStyle = '#6b4724';
    x.fillText('FRAGILE  ·  HANDLE WITH CARE', w * 0.5, h * 0.53);
    x.restore();
    if (heavy) shipLabel(x, w, h, w * 0.60, h * 0.62, w * 0.32, h * 0.29);
    else { x.save(); x.globalAlpha = 0.75; shipLabel(x, w, h, w * 0.08, h * 0.60, w * 0.30, h * 0.26); x.restore(); }
    x.save(); x.globalAlpha = 0.78; x.strokeStyle = '#5a3818'; x.lineWidth = 3;
    x.strokeRect(2, 2, w - 4, h - 4); x.restore();
  }

  function kraftSide(x, w, h) {
    kraftBase(x, w, h);
    x.save();
    x.translate(w * 0.5, h * 0.5); x.rotate(-Math.PI / 2);
    x.fillStyle = '#5b3a1c'; x.textAlign = 'center';
    x.font = '700 ' + Math.round(w * 0.10) + 'px Arial, sans-serif';
    x.fillText('THIS SIDE UP   ↑↑', 0, 0);
    x.font = '600 ' + Math.round(w * 0.065) + 'px Arial, sans-serif';
    x.fillText('FRAGILE · KEEP DRY', 0, w * 0.11);
    x.restore();
    tape(x, w, h, true);
  }

  function kraftTop(x, w, h) {
    kraftBase(x, w, h);
    tape(x, w, h, true);
    x.save(); x.globalAlpha = 0.24; x.strokeStyle = '#6d4823'; x.lineWidth = 1.5;
    x.beginPath(); x.moveTo(w * 0.5, 0); x.lineTo(w * 0.5, h); x.stroke(); x.restore();
  }

  function kraftPlain(x, w, h) { kraftBase(x, w, h); }

  /* ---------------- 白色缠膜箱 ---------------- */
  function wrapBase(x, w, h) {
    sheet(x, w, h, '#f4f2ea', '#e9e6dc', '#d8d4c9');
    x.save(); x.globalAlpha = 0.13;
    x.strokeStyle = '#b9b6ad'; x.lineWidth = 1;
    for (var i = 0; i < 34; i++) {
      var px = rnd(i * 6.7) * w, py = rnd(i * 3.3 + 40) * h;
      x.beginPath(); x.moveTo(px, py);
      x.bezierCurveTo(px + 20, py - 14, px + 38, py + 16, px + 70, py + 4);
      x.stroke();
    }
    x.restore();
    vignette(x, w, h, 0.09);
  }

  function wrapTape(x, w, h) {
    x.save(); x.globalAlpha = 0.92;
    var g = x.createLinearGradient(0, 0, w, 0);
    g.addColorStop(0, '#8a5c2a'); g.addColorStop(0.5, '#ad7c3d'); g.addColorStop(1, '#815526');
    x.fillStyle = g;
    x.fillRect(w * 0.22, 0, w * 0.085, h);
    x.fillRect(w * 0.70, 0, w * 0.085, h);
    x.fillRect(0, h * 0.46, w, h * 0.085);
    x.globalAlpha = 0.22; x.strokeStyle = '#5d3d19'; x.lineWidth = 1;
    x.strokeRect(w * 0.22, 0, w * 0.085, h);
    x.strokeRect(w * 0.70, 0, w * 0.085, h);
    x.strokeRect(0, h * 0.46, w, h * 0.085);
    x.restore();
  }

  function wrapFace(x, w, h, front) {
    wrapBase(x, w, h);
    wrapTape(x, w, h);
    if (front) {
      x.fillStyle = '#f7f7f2'; x.fillRect(w * 0.37, h * 0.16, w * 0.26, h * 0.18);
      x.strokeStyle = '#d6d3cb'; x.lineWidth = 1;
      x.strokeRect(w * 0.37 + 0.5, h * 0.16 + 0.5, w * 0.26 - 1, h * 0.18 - 1);
      x.fillStyle = '#b3b0a8';
      for (var i = 0; i < 3; i++) x.fillRect(w * 0.40, h * 0.21 + i * h * 0.042, w * (0.12 + rnd(i + 7) * 0.08), 2);
    }
    x.save(); x.globalAlpha = 0.4; x.strokeStyle = '#b4b0a6'; x.lineWidth = 2;
    x.strokeRect(2, 2, w - 4, h - 4); x.restore();
  }

  function wrapTop(x, w, h) { wrapBase(x, w, h); wrapTape(x, w, h); }

  /* ---------------- 蓝色塑料料箱 ---------------- */
  function crateBase(x, w, h) {
    sheet(x, w, h, '#2a5cba', '#1a4799', '#113071');
    /* 竖向成型筋：低对比、较稀疏，避免细密格纹 */
    for (var i = 0; i < 7; i++) {
      var px = i * w / 7;
      var g = x.createLinearGradient(px, 0, px + w / 7, 0);
      g.addColorStop(0, 'rgba(9,32,92,.30)');
      g.addColorStop(0.48, 'rgba(120,165,240,.11)');
      g.addColorStop(1, 'rgba(9,32,92,.20)');
      x.fillStyle = g; x.fillRect(px, 0, w / 7, h);
    }
    /* 上下口沿与中缝 */
    x.fillStyle = 'rgba(150,190,255,.20)'; x.fillRect(0, 0, w, h * 0.075);
    x.fillStyle = 'rgba(8,28,84,.36)'; x.fillRect(0, h * 0.925, w, h * 0.075);
    x.fillStyle = 'rgba(8,28,84,.13)'; x.fillRect(0, h * 0.50, w, h * 0.016);
    vignette(x, w, h, 0.18);
  }

  function crateFace(x, w, h, label) {
    crateBase(x, w, h);
    if (label) {
      x.fillStyle = 'rgba(243,248,255,.94)';
      x.fillRect(w * 0.26, h * 0.35, w * 0.48, h * 0.30);
      x.strokeStyle = '#9fb8e0'; x.lineWidth = 1;
      x.strokeRect(w * 0.26 + 0.5, h * 0.35 + 0.5, w * 0.48 - 1, h * 0.30 - 1);
      x.fillStyle = '#7f96bd';
      for (var i = 0; i < 3; i++) x.fillRect(w * 0.31, h * 0.41 + i * h * 0.07, w * (0.20 + rnd(i + 13) * 0.15), 3);
      barcode(x, w * 0.31, h * 0.56, w * 0.38, 8);
    }
    /* 提手凹槽 */
    x.fillStyle = 'rgba(8,28,84,.45)';
    x.fillRect(w * 0.08, h * 0.45, w * 0.10, h * 0.10);
    x.fillRect(w * 0.82, h * 0.45, w * 0.10, h * 0.10);
  }

  function crateTop(x, w, h) {
    sheet(x, w, h, '#2354ad', '#194391', '#123073');
    x.strokeStyle = 'rgba(10,34,96,.55)'; x.lineWidth = 5;
    x.strokeRect(6, 6, w - 12, h - 12);
    x.strokeStyle = 'rgba(140,180,245,.35)'; x.lineWidth = 2;
    x.strokeRect(11, 11, w - 22, h - 22);
    x.beginPath(); x.moveTo(w * 0.5, 12); x.lineTo(w * 0.5, h - 12); x.stroke();
  }

  /* ---------------- 镀锌钢制金属周转箱 ---------------- */
  function metalBase(x, w, h) {
    var g = x.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#d8e0ea'); g.addColorStop(0.14, '#a9b6c6');
    g.addColorStop(0.46, '#c6cfdb'); g.addColorStop(0.82, '#98a5b7'); g.addColorStop(1, '#78869b');
    x.fillStyle = g; x.fillRect(0, 0, w, h);
    /* 镀锌锌花：不规则浅色斑块 */
    x.save(); x.globalAlpha = 0.13;
    for (var i = 0; i < 90; i++) {
      var px = rnd(i * 3.3 + 17) * w, py = rnd(i * 5.9 + 29) * h;
      var rr = 3 + rnd(i * 7.1 + 3) * 13;
      x.fillStyle = rnd(i * 2.3) > 0.5 ? '#ffffff' : '#61708a';
      x.beginPath(); x.ellipse(px, py, rr, rr * 0.55, rnd(i + 8) * 3, 0, Math.PI * 2); x.fill();
    }
    x.restore();
    /* 冲压横向凸筋 */
    [0.16, 0.38, 0.62, 0.84].forEach(function (p) {
      var yy = h * p, gg = x.createLinearGradient(0, yy - 7, 0, yy + 7);
      gg.addColorStop(0, 'rgba(255,255,255,0)');
      gg.addColorStop(0.28, 'rgba(255,255,255,.62)');
      gg.addColorStop(0.58, 'rgba(46,60,82,.26)');
      gg.addColorStop(1, 'rgba(255,255,255,0)');
      x.fillStyle = gg; x.fillRect(0, yy - 7, w, 14);
    });
    /* 细密拉丝 */
    x.save(); x.globalAlpha = 0.09; x.strokeStyle = '#4a576d'; x.lineWidth = 1;
    for (var j = 0; j < h; j += 3) { x.beginPath(); x.moveTo(0, j + 0.5); x.lineTo(w, j + 0.5); x.stroke(); }
    x.restore();
    var vg = x.createRadialGradient(w / 2, h / 2, w * 0.18, w / 2, h / 2, w * 0.76);
    vg.addColorStop(0, 'rgba(20,32,52,0)'); vg.addColorStop(1, 'rgba(20,32,52,.26)');
    x.fillStyle = vg; x.fillRect(0, 0, w, h);
  }

  function rivet(x, cx, cy, r) {
    x.save();
    var g = x.createRadialGradient(cx - r * 0.3, cy - r * 0.3, 0, cx, cy, r);
    g.addColorStop(0, '#f5f8fc'); g.addColorStop(0.55, '#9aa8ba'); g.addColorStop(1, '#4b586c');
    x.fillStyle = g; x.beginPath(); x.arc(cx, cy, r, 0, Math.PI * 2); x.fill();
    x.strokeStyle = 'rgba(28,40,60,.7)'; x.lineWidth = 1;
    x.beginPath(); x.arc(cx, cy, r + 1, 0, Math.PI * 2); x.stroke();
    x.restore();
  }

  function metalFace(x, w, h, front) {
    metalBase(x, w, h);
    /* 四边角钢包边 */
    var eg = x.createLinearGradient(0, 0, w * 0.055, 0);
    eg.addColorStop(0, 'rgba(52,66,88,.62)'); eg.addColorStop(0.5, 'rgba(236,243,252,.72)'); eg.addColorStop(1, 'rgba(70,84,105,.20)');
    x.fillStyle = eg; x.fillRect(0, 0, w * 0.055, h); x.fillRect(w * 0.945, 0, w * 0.055, h);
    var tg = x.createLinearGradient(0, 0, 0, h * 0.07);
    tg.addColorStop(0, 'rgba(52,66,88,.55)'); tg.addColorStop(0.45, 'rgba(240,246,253,.68)'); tg.addColorStop(1, 'rgba(70,84,105,.18)');
    x.fillStyle = tg; x.fillRect(0, 0, w, h * 0.07); x.fillRect(0, h * 0.93, w, h * 0.07);
    /* 铆钉阵列 */
    [0.085, 0.5, 0.915].forEach(function (py) {
      [0.05, 0.95].forEach(function (px) { rivet(x, w * px, h * py, 3.1); });
    });
    [0.18, 0.5, 0.82].forEach(function (px) {
      [0.045, 0.955].forEach(function (py) { rivet(x, w * px, h * py, 3.1); });
    });
    if (front) {
      /* 凹陷折叠把手 */
      x.save();
      x.fillStyle = 'rgba(34,46,66,.55)';
      x.beginPath(); x.ellipse(w * 0.5, h * 0.30, w * 0.13, h * 0.055, 0, 0, Math.PI * 2); x.fill();
      x.strokeStyle = 'rgba(246,250,255,.85)'; x.lineWidth = 2;
      x.beginPath(); x.ellipse(w * 0.5, h * 0.285, w * 0.13, h * 0.055, 0, Math.PI * 1.05, Math.PI * 1.95); x.stroke();
      x.restore();
      /* 铭牌 */
      x.fillStyle = '#f3f6fa'; x.fillRect(w * 0.27, h * 0.46, w * 0.46, h * 0.30);
      x.strokeStyle = '#8d9bad'; x.lineWidth = 1.5; x.strokeRect(w * 0.27 + 0.5, h * 0.46 + 0.5, w * 0.46 - 1, h * 0.30 - 1);
      x.fillStyle = '#2c3c55'; x.textAlign = 'center';
      x.font = '700 ' + Math.round(h * 0.075) + 'px "Microsoft YaHei",Arial,sans-serif';
      x.fillText('金属周转箱', w * 0.5, h * 0.585);
      x.font = '600 ' + Math.round(h * 0.052) + 'px Arial,sans-serif';
      x.fillText('STEEL CONTAINER  ·  MAX 800 kg', w * 0.5, h * 0.67);
      x.fillStyle = '#7d8da2';
      x.fillRect(w * 0.32, h * 0.70, w * 0.36, 2);
      /* 警示三角 */
      x.fillStyle = '#e9b21c'; x.beginPath();
      x.moveTo(w * 0.11, h * 0.86); x.lineTo(w * 0.17, h * 0.75); x.lineTo(w * 0.23, h * 0.86); x.closePath(); x.fill();
      x.fillStyle = '#3a3020'; x.font = '700 ' + Math.round(h * 0.06) + 'px Arial'; x.fillText('!', w * 0.17, h * 0.85);
    } else {
      /* 侧面 X 形加强筋 */
      x.save(); x.globalAlpha = 0.30; x.strokeStyle = '#eef4fb'; x.lineWidth = 5;
      x.beginPath(); x.moveTo(w * 0.10, h * 0.12); x.lineTo(w * 0.90, h * 0.88);
      x.moveTo(w * 0.90, h * 0.12); x.lineTo(w * 0.10, h * 0.88); x.stroke(); x.restore();
    }
  }

  function metalTop(x, w, h) {
    metalBase(x, w, h);
    x.strokeStyle = 'rgba(42,56,76,.72)'; x.lineWidth = 6; x.strokeRect(10, 10, w - 20, h - 20);
    x.strokeStyle = 'rgba(255,255,255,.62)'; x.lineWidth = 2; x.strokeRect(15, 15, w - 30, h - 30);
    x.fillStyle = 'rgba(40,54,74,.32)'; x.fillRect(w * 0.5 - 3, 16, 6, h - 32);
    [0.22, 0.78].forEach(function (p) {
      [0.22, 0.78].forEach(function (q) {
        x.fillStyle = '#5b6b82'; x.fillRect(w * p - 9, h * q - 5, 18, 10);
        rivet(x, w * p, h * q, 3.4);
      });
    });
    x.fillStyle = 'rgba(36,50,70,.68)'; x.textAlign = 'center';
    x.font = '700 ' + Math.round(h * 0.09) + 'px Arial'; x.fillText('EAVAN · STEEL', w * 0.5, h * 0.55);
  }

  /* ---------------- EPS 冷链泡沫箱 ---------------- */
  function foamBase(x, w, h) {
    sheet(x, w, h, '#ffffff', '#f1f5f9', '#dce5ed');
    /* EPS 发泡珠粒 */
    for (var i = 0; i < 950; i++) {
      var px = rnd(i * 1.93 + 5) * w, py = rnd(i * 4.71 + 91) * h;
      var rr = 1.2 + rnd(i * 3.17 + 2) * 2.4;
      x.fillStyle = rnd(i * 7.7) > 0.47 ? 'rgba(255,255,255,.92)' : 'rgba(146,166,189,.20)';
      x.beginPath(); x.arc(px, py, rr, 0, Math.PI * 2); x.fill();
    }
    x.save(); x.globalAlpha = 0.12; x.strokeStyle = '#b8c6d6'; x.lineWidth = 1;
    for (var j = 0; j < h; j += 6) { x.beginPath(); x.moveTo(0, j + 0.5); x.lineTo(w, j + 0.5); x.stroke(); }
    x.restore();
    var vg = x.createRadialGradient(w / 2, h / 2, w * 0.22, w / 2, h / 2, w * 0.78);
    vg.addColorStop(0, 'rgba(120,140,170,0)'); vg.addColorStop(1, 'rgba(96,118,150,.20)');
    x.fillStyle = vg; x.fillRect(0, 0, w, h);
  }

  function foamTape(x, w, h) {
    x.save(); x.globalAlpha = 0.84;
    var g = x.createLinearGradient(w * 0.44, 0, w * 0.56, 0);
    g.addColorStop(0, '#2b6fc4'); g.addColorStop(0.45, '#5b9ae0'); g.addColorStop(1, '#2a66b4');
    x.fillStyle = g; x.fillRect(w * 0.44, 0, w * 0.12, h);
    x.globalAlpha = 0.30; x.strokeStyle = '#123e78'; x.lineWidth = 1;
    x.strokeRect(w * 0.44, 0, w * 0.12, h); x.restore();
  }

  function foamFace(x, w, h, front) {
    foamBase(x, w, h);
    /* 箱盖接缝 */
    var cy = h * 0.27;
    x.fillStyle = 'rgba(120,142,170,.38)'; x.fillRect(0, cy - 2, w, 4);
    x.fillStyle = 'rgba(255,255,255,.85)'; x.fillRect(0, cy + 2, w, 3);
    foamTape(x, w, h);
    if (front) {
      /* 冷链标签 */
      x.fillStyle = 'rgba(255,255,255,.96)'; x.fillRect(w * 0.10, h * 0.40, w * 0.32, h * 0.31);
      x.strokeStyle = '#4d8ed4'; x.lineWidth = 2; x.strokeRect(w * 0.10 + 1, h * 0.40 + 1, w * 0.32 - 2, h * 0.31 - 2);
      x.fillStyle = '#1c5fa8'; x.textAlign = 'center';
      x.font = '700 ' + Math.round(h * 0.072) + 'px Arial'; x.fillText('KEEP COLD', w * 0.26, h * 0.52);
      x.font = '700 ' + Math.round(h * 0.062) + 'px "Microsoft YaHei",Arial'; x.fillText('生鲜冷链', w * 0.26, h * 0.62);
      x.font = '600 ' + Math.round(h * 0.045) + 'px Arial'; x.fillText('0–4 ℃', w * 0.26, h * 0.685);
      /* 向上标志 */
      x.save(); x.strokeStyle = '#2b6fc4'; x.fillStyle = '#2b6fc4'; x.lineWidth = 3;
      x.beginPath(); x.moveTo(w * 0.75, h * 0.44); x.lineTo(w * 0.82, h * 0.55); x.lineTo(w * 0.68, h * 0.55); x.closePath(); x.fill();
      x.fillRect(w * 0.735, h * 0.57, w * 0.03, h * 0.14);
      x.font = '600 ' + Math.round(h * 0.045) + 'px Arial'; x.textAlign = 'center';
      x.fillText('THIS SIDE UP', w * 0.75, h * 0.78); x.restore();
    } else {
      x.fillStyle = 'rgba(90,120,155,.42)'; x.textAlign = 'center';
      x.font = '700 ' + Math.round(h * 0.07) + 'px Arial'; x.fillText('EPS  ·  EAVAN', w * 0.5, h * 0.56);
    }
    x.save(); x.globalAlpha = 0.30; x.strokeStyle = '#a9bacb'; x.lineWidth = 2;
    x.strokeRect(2, 2, w - 4, h - 4); x.restore();
  }

  function foamTop(x, w, h) {
    foamBase(x, w, h);
    x.strokeStyle = 'rgba(118,140,168,.55)'; x.lineWidth = 5; x.strokeRect(9, 9, w - 18, h - 18);
    x.strokeStyle = 'rgba(255,255,255,.9)'; x.lineWidth = 2; x.strokeRect(15, 15, w - 30, h - 30);
    foamTape(x, w, h);
    x.save(); x.globalAlpha = 0.80;
    x.fillStyle = '#2b6fc4'; x.fillRect(0, h * 0.46, w, h * 0.08); x.restore();
    x.fillStyle = 'rgba(70,100,140,.55)'; x.textAlign = 'center';
    x.font = '700 ' + Math.round(h * 0.085) + 'px Arial'; x.fillText('EPS-06', w * 0.22, h * 0.30);
  }

  /* ---------------- 麻布散货包（编织袋） ---------------- */
  function sackBase(x, w, h) {
    sheet(x, w, h, '#ddc18c', '#c2a16a', '#8e7043');
    /* 经纬编织：横 4px / 纵 4px 交错 */
    x.save(); x.lineWidth = 1;
    for (var i = 0; i < h; i += 4) {
      x.globalAlpha = (i / 4) % 2 ? 0.24 : 0.16;
      x.strokeStyle = (i / 4) % 2 ? '#f4e0b8' : '#6b4c26';
      x.beginPath(); x.moveTo(0, i + 0.5); x.lineTo(w, i + 0.5); x.stroke();
    }
    for (var j = 0; j < w; j += 4) {
      x.globalAlpha = (j / 4) % 2 ? 0.20 : 0.13;
      x.strokeStyle = (j / 4) % 2 ? '#f0d9ac' : '#6b4c26';
      x.beginPath(); x.moveTo(j + 0.5, 0); x.lineTo(j + 0.5, h); x.stroke();
    }
    x.restore();
    /* 麻纤维毛糙感 */
    fibers(x, w, h, 340, 0.16, '#5d431f');
    fibers(x, w, h, 160, 0.12, '#f7e6c2');
  }

  function sackBulge(x, w, h) {
    var g = x.createRadialGradient(w * 0.5, h * 0.46, w * 0.06, w * 0.5, h * 0.5, w * 0.72);
    g.addColorStop(0, 'rgba(255,240,204,.30)');
    g.addColorStop(0.55, 'rgba(120,84,38,0)');
    g.addColorStop(1, 'rgba(72,48,20,.46)');
    x.fillStyle = g; x.fillRect(0, 0, w, h);
  }

  function sackStitch(x, w, h) {
    x.save(); x.strokeStyle = 'rgba(70,46,20,.72)'; x.lineWidth = 2; x.setLineDash([6, 5]);
    x.beginPath(); x.moveTo(w * 0.05, h * 0.93); x.lineTo(w * 0.95, h * 0.93); x.stroke();
    x.setLineDash([]); x.restore();
    x.fillStyle = 'rgba(72,48,22,.24)'; x.fillRect(0, h * 0.95, w, h * 0.05);
  }

  function sackTie(x, w, h) {
    /* 扎口褶皱：由中心向两侧发散 */
    x.save(); x.globalAlpha = 0.42; x.strokeStyle = '#5f401c'; x.lineWidth = 2;
    for (var i = -4; i <= 4; i++) {
      x.beginPath(); x.moveTo(w * 0.5, h * 0.02);
      x.quadraticCurveTo(w * (0.5 + i * 0.055), h * 0.075, w * (0.5 + i * 0.105), h * 0.145);
      x.stroke();
    }
    x.restore();
    /* 麻绳十字捆扎 */
    x.save(); x.strokeStyle = '#8a6a34'; x.lineWidth = 5;
    x.beginPath(); x.moveTo(w * 0.30, h * 0.075); x.lineTo(w * 0.70, h * 0.075); x.stroke();
    x.strokeStyle = 'rgba(255,236,190,.55)'; x.lineWidth = 1.5;
    x.beginPath(); x.moveTo(w * 0.30, h * 0.066); x.lineTo(w * 0.70, h * 0.066); x.stroke();
    x.fillStyle = '#7a5a2b'; x.beginPath(); x.arc(w * 0.5, h * 0.075, 6, 0, Math.PI * 2); x.fill();
    x.fillStyle = '#c6a264'; x.beginPath(); x.arc(w * 0.5 - 1, h * 0.075 - 1, 3, 0, Math.PI * 2); x.fill();
    x.restore();
  }

  function sackFace(x, w, h, front) {
    sackBase(x, w, h);
    sackBulge(x, w, h);
    /* 两侧收边褶皱 */
    x.save(); x.globalAlpha = 0.28; x.strokeStyle = '#4e3418'; x.lineWidth = 3;
    [0.06, 0.94].forEach(function (p) {
      x.beginPath(); x.moveTo(w * p, 0);
      x.bezierCurveTo(w * (p + (p < 0.5 ? 0.05 : -0.05)), h * 0.35, w * (p + (p < 0.5 ? -0.02 : 0.02)), h * 0.7, w * p, h);
      x.stroke();
    });
    x.restore();
    sackStitch(x, w, h);
    sackTie(x, w, h);
    if (front) {
      /* 印字：浅色印墨区 + 品名 / 净重 / 批次 */
      x.save(); x.textAlign = 'center';
      x.fillStyle = 'rgba(250,238,208,.32)'; x.fillRect(w * 0.16, h * 0.35, w * 0.68, h * 0.44);
      x.fillStyle = '#4b3216';
      x.font = '700 ' + Math.round(h * 0.155) + 'px Arial,sans-serif';
      x.fillText('50 kg', w * 0.5, h * 0.55);
      x.font = '700 ' + Math.round(h * 0.078) + 'px "Microsoft YaHei",Arial,sans-serif';
      x.fillText('散货 · 农产品', w * 0.5, h * 0.645);
      x.font = '600 ' + Math.round(h * 0.052) + 'px Arial,sans-serif';
      x.fillText('KEEP DRY  ·  LOT 2026', w * 0.5, h * 0.73);
      x.restore();
      /* 圆形质检章 */
      x.save(); x.globalAlpha = 0.55; x.strokeStyle = '#5a3c1b'; x.lineWidth = 2;
      x.beginPath(); x.arc(w * 0.82, h * 0.28, w * 0.075, 0, Math.PI * 2); x.stroke();
      x.fillStyle = '#5a3c1b'; x.textAlign = 'center';
      x.font = '700 ' + Math.round(h * 0.05) + 'px Arial'; x.fillText('QC', w * 0.82, h * 0.295); x.restore();
    }
  }

  function sackSide(x, w, h) {
    sackBase(x, w, h);
    sackBulge(x, w, h);
    x.save(); x.globalAlpha = 0.30; x.strokeStyle = '#4e3418'; x.lineWidth = 3;
    for (var i = 1; i <= 3; i++) {
      var px = w * i / 4;
      x.beginPath(); x.moveTo(px, 0);
      x.bezierCurveTo(px - 10, h * 0.35, px + 10, h * 0.68, px, h); x.stroke();
    }
    x.restore();
    sackStitch(x, w, h);
    sackTie(x, w, h);
  }

  function sackTop(x, w, h) {
    sackBase(x, w, h);
    var g = x.createRadialGradient(w * 0.5, h * 0.5, 2, w * 0.5, h * 0.5, w * 0.55);
    g.addColorStop(0, 'rgba(255,240,206,.34)'); g.addColorStop(1, 'rgba(70,46,20,.34)');
    x.fillStyle = g; x.fillRect(0, 0, w, h);
    x.save(); x.globalAlpha = 0.36; x.strokeStyle = '#4e3418'; x.lineWidth = 3;
    [[0, 0, 0.3, 0.3], [1, 0, 0.7, 0.3], [0, 1, 0.3, 0.7], [1, 1, 0.7, 0.7]].forEach(function (p) {
      x.beginPath(); x.moveTo(w * p[0], h * p[1]); x.lineTo(w * p[2], h * p[3]); x.stroke();
    });
    x.restore();
    sackTie(x, w, h);
  }

  /* ---------------- 钢材 / 设备 ---------------- */
  function steel(x, w, h, perforated) {
    var g = x.createLinearGradient(0, 0, w, 0);
    g.addColorStop(0, '#8f98a8'); g.addColorStop(0.16, '#f6f8fc');
    g.addColorStop(0.42, '#d6dce6'); g.addColorStop(0.78, '#b6bfcd');
    g.addColorStop(1, '#788395');
    x.fillStyle = g; x.fillRect(0, 0, w, h);
    if (perforated) {
      for (var row = 0; row < 16; row++) {
        var py = (row + 0.5) * h / 16;
        for (var col = 0; col < 2; col++) {
          var px = w * (col ? 0.66 : 0.34);
          x.fillStyle = 'rgba(26,36,56,.72)';
          x.beginPath(); x.roundRect ? x.roundRect(px - 4, py - 3, 8, 6, 2) : x.rect(px - 4, py - 3, 8, 6); x.fill();
          x.fillStyle = 'rgba(255,255,255,.42)';
          x.fillRect(px - 4, py + 2, 8, 1);
        }
      }
    } else {
      x.save(); x.globalAlpha = 0.12; x.strokeStyle = '#5b6678'; x.lineWidth = 1;
      for (var i = 0; i < h; i += 3) { x.beginPath(); x.moveTo(0, i + 0.5); x.lineTo(w, i + 0.5); x.stroke(); }
      x.restore();
    }
  }

  function beamTex(x, w, h) {
    var g = x.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#8e939c'); g.addColorStop(0.10, '#e9edf4');
    g.addColorStop(0.34, '#f2f4f8'); g.addColorStop(0.70, '#c6cbd4');
    g.addColorStop(0.92, '#8d939e'); g.addColorStop(1, '#6d747f');
    x.fillStyle = g; x.fillRect(0, 0, w, h);
    x.save(); x.globalAlpha = 0.10; x.strokeStyle = '#4b5361'; x.lineWidth = 1;
    for (var i = 0; i < w; i += 7) { x.beginPath(); x.moveTo(i + 0.5, 0); x.lineTo(i + 0.5, h); x.stroke(); }
    x.restore();
  }

  function railTex(x, w, h) {
    var g = x.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#f4f7fb'); g.addColorStop(0.22, '#c9d2de');
    g.addColorStop(0.55, '#aeb9c8'); g.addColorStop(0.85, '#8e9aab'); g.addColorStop(1, '#707c8e');
    x.fillStyle = g; x.fillRect(0, 0, w, h);
    x.save(); x.globalAlpha = 0.14; x.strokeStyle = '#ffffff'; x.lineWidth = 1;
    for (var i = 0; i < h; i += 2) { x.beginPath(); x.moveTo(0, i + 0.5); x.lineTo(w, i + 0.5); x.stroke(); }
    x.restore();
  }

  function palletTex(x, w, h) {
    sheet(x, w, h, '#5b6678', '#414c5e', '#2f3949');
    x.save();
    for (var i = 0; i < 7; i++) {
      var py = i * h / 7;
      x.fillStyle = 'rgba(255,255,255,.09)'; x.fillRect(0, py + 1, w, h / 7 - 3);
      x.fillStyle = 'rgba(10,18,32,.55)'; x.fillRect(0, py + h / 7 - 3, w, 2);
    }
    x.fillStyle = 'rgba(12,20,34,.62)';
    [0.14, 0.5, 0.86].forEach(function (p) { x.fillRect(w * p - 5, h * 0.28, 10, h * 0.44); });
    x.restore();
  }
  /* 子托盘（上）：棕色木质，比母托盘略小 */
  function palletSubTex(x, w, h) {
    sheet(x, w, h, '#a97b46', '#8c6134', '#674526');
    x.save();
    for (var i = 0; i < 6; i++) {
      var py = i * h / 6;
      x.fillStyle = 'rgba(255,224,178,.14)'; x.fillRect(0, py + 1, w, h / 6 - 3);
      x.fillStyle = 'rgba(56,34,16,.55)'; x.fillRect(0, py + h / 6 - 3, w, 2);
      /* 木纹 */
      x.globalAlpha = 0.14; x.strokeStyle = '#3b2412'; x.lineWidth = 1;
      for (var k = 0; k < 9; k++) {
        var yy = py + 2 + rnd(i * 13 + k * 2.7) * (h / 6 - 5);
        x.beginPath(); x.moveTo(0, yy); x.lineTo(w, yy + (rnd(k + i * 3) - 0.5) * 2); x.stroke();
      }
      x.globalAlpha = 1;
    }
    x.fillStyle = 'rgba(48,28,12,.68)';
    [0.16, 0.5, 0.84].forEach(function (p) { x.fillRect(w * p - 6, h * 0.26, 12, h * 0.48); });
    x.restore();
  }
  /* 母托盘（下）：银色金属，带拉丝高光与叉车孔 */
  function palletMotherTex(x, w, h) {
    sheet(x, w, h, '#e2e8ee', '#aeb9c6', '#7c8a9c');
    x.save();
    for (var i = 0; i < 40; i++) {
      x.globalAlpha = 0.05 + rnd(i * 3.3) * 0.07;
      x.fillStyle = i % 2 ? '#ffffff' : '#4b586b';
      x.fillRect(0, i * h / 40, w, 1);
    }
    x.globalAlpha = 1;
    for (var j = 0; j < 5; j++) {
      var py = j * h / 5;
      x.fillStyle = 'rgba(255,255,255,.30)'; x.fillRect(0, py + 1, w, 2);
      x.fillStyle = 'rgba(52,66,84,.45)'; x.fillRect(0, py + h / 5 - 3, w, 2);
    }
    x.fillStyle = 'rgba(42,54,70,.80)';
    [0.14, 0.5, 0.86].forEach(function (p) { x.fillRect(w * p - 8, h * 0.30, 16, h * 0.40); });
    x.strokeStyle = 'rgba(255,255,255,.55)'; x.lineWidth = 2; x.strokeRect(3, 3, w - 6, h - 6);
    x.restore();
  }

  function groundTex(x, w, h) {
    x.fillStyle = '#eef2f8'; x.fillRect(0, 0, w, h);
    x.save(); x.globalAlpha = 0.055;
    for (var i = 0; i < 2600; i++) {
      var px = rnd(i * 2.17) * w, py = rnd(i * 5.31 + 71) * h;
      x.fillStyle = rnd(i * 9.3) > 0.5 ? '#6c7b92' : '#ffffff';
      x.fillRect(px, py, 1 + rnd(i * 3.7) * 2, 1 + rnd(i * 4.9) * 2);
    }
    x.restore();
    x.strokeStyle = 'rgba(150,164,184,.16)'; x.lineWidth = 1;
    x.strokeRect(0.5, 0.5, w - 1, h - 1);
  }

  function shadowTex(x, w, h) {
    var g = x.createRadialGradient(w / 2, h / 2, w * 0.06, w / 2, h / 2, w * 0.5);
    g.addColorStop(0, 'rgba(28,40,66,.44)');
    g.addColorStop(0.42, 'rgba(32,45,72,.30)');
    g.addColorStop(0.74, 'rgba(38,52,80,.10)');
    g.addColorStop(1, 'rgba(40,55,84,0)');
    x.fillStyle = g; x.fillRect(0, 0, w, h);
  }

  function netTex(x, w, h) {
    x.clearRect(0, 0, w, h);
    x.strokeStyle = 'rgba(190,164,52,.92)'; x.lineWidth = 2.2;
    for (var i = -w; i < w * 2; i += 16) {
      x.beginPath(); x.moveTo(i, 0); x.lineTo(i + h, h); x.stroke();
      x.beginPath(); x.moveTo(i, 0); x.lineTo(i - h, h); x.stroke();
    }
    x.strokeStyle = 'rgba(120,104,30,.34)'; x.lineWidth = 1;
    x.strokeRect(0.5, 0.5, w - 1, h - 1);
  }

  /* ---------------- 四向穿梭车（参考 World Rack 款式重新绘制） ----------------
     车身为蓝色烤漆：品牌字 / 型号字 / 散热栅格 / 青色状态灯带 / 黄黑警示端头；
     前后端面带传感器窗与急停按钮；顶盖有检修盖缝与状态窗；台板为不锈钢防滑花纹板。 */
  function hazard(x, px, py, w, h, dark, light) {
    x.save();
    x.beginPath(); x.rect(px, py, w, h); x.clip();
    x.fillStyle = light || '#f2c018'; x.fillRect(px, py, w, h);
    x.fillStyle = dark || '#20262f';
    for (var i = -h; i < w + h; i += 14) {
      x.beginPath();
      x.moveTo(px + i, py + h); x.lineTo(px + i + 8, py + h);
      x.lineTo(px + i + 8 + h, py); x.lineTo(px + i + h, py);
      x.closePath(); x.fill();
    }
    x.restore();
  }

  /* 四向车换色：结构贴图（警示条 / 品牌字 / 散热栅格 / 铭牌 / 状态灯带）全部保留，
     只把车身主色渐变替换成目标色。默认 blue 完全等于原贴图。 */
  var SH_TINT = {
    blue:     '#2467d2',
    red:      '#cf4438',
    green:    '#159b76',
    orange:   '#e08a24',
    purple:   '#7b52d4',
    silver:   '#8493a6',
    graphite: '#414c60',
    yellow:   '#dcae22'
  };
  function shade(hex, amt) {
    var c = parseInt(hex.slice(1), 16), r = (c >> 16) & 255, g = (c >> 8) & 255, b = c & 255;
    var t = amt > 0 ? 255 : 0, p = Math.abs(amt);
    r = Math.round(r + (t - r) * p); g = Math.round(g + (t - g) * p); b = Math.round(b + (t - b) * p);
    return '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
  }
  function rgba(hex, a) {
    var c = parseInt(hex.slice(1), 16);
    return 'rgba(' + ((c >> 16) & 255) + ',' + ((c >> 8) & 255) + ',' + (c & 255) + ',' + a + ')';
  }
  function shPal(key) {
    var base = SH_TINT[key] || SH_TINT.blue;
    return {
      hi: shade(base, 0.34), mid: base, low: shade(base, -0.20), bot: shade(base, -0.44),
      fiber: shade(base, 0.66),
      topLine: rgba(shade(base, 0.62), 0.85), botLine: rgba(shade(base, -0.60), 0.75),
      capLine: rgba(shade(base, -0.55), 0.9), capHi: rgba(shade(base, 0.58), 0.5)
    };
  }
  function shSideTex(x, w, h, p) {
    p = p || shPal('blue');
    var g = x.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, p.hi); g.addColorStop(0.42, p.mid);
    g.addColorStop(0.78, p.low); g.addColorStop(1, p.bot);
    x.fillStyle = g; x.fillRect(0, 0, w, h);
    /* 金属颗粒与上沿高光 */
    fibers(x, w, h, 300, 0.055, p.fiber);
    x.fillStyle = p.topLine; x.fillRect(0, 0, w, 3);
    x.fillStyle = p.botLine; x.fillRect(0, h - 5, w, 5);
    /* 端面警示条 */
    hazard(x, 0, 0, 30, h); hazard(x, w - 30, 0, 30, h);
    /* 品牌与型号 */
    x.fillStyle = '#ffffff'; x.font = '900 34px "Arial Black",Arial,sans-serif';
    x.fillText('EAVAN', 56, 51);
    x.fillStyle = '#bfe0ff'; x.font = 'bold 15px Arial,sans-serif';
    x.fillText('4-WAY SHUTTLE  ·  四向穿梭车', 58, 72);
    /* 散热栅格 */
    for (var i = 0; i < 8; i++) {
      x.fillStyle = 'rgba(9,36,96,.72)'; x.fillRect(340 + i * 15, 25, 8, 40);
      x.fillStyle = 'rgba(150,196,255,.28)'; x.fillRect(340 + i * 15, 25, 2, 40);
    }
    /* 青色状态灯带 */
    x.fillStyle = '#54f0e0'; x.fillRect(56, 80, 268, 4);
    x.fillStyle = 'rgba(84,240,224,.28)'; x.fillRect(56, 78, 268, 9);
    /* 铭牌 */
    x.fillStyle = '#e9eef5'; x.fillRect(360, 70, 118, 18);
    x.fillStyle = '#1b3358'; x.font = 'bold 11px Arial,sans-serif';
    x.fillText('WR-4W / 800 kg', 366, 83);
  }

  function shFrontTex(x, w, h, p) {
    p = p || shPal('blue');
    var g = x.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, p.hi); g.addColorStop(1, p.bot);
    x.fillStyle = g; x.fillRect(0, 0, w, h);
    fibers(x, w, h, 150, 0.05, p.fiber);
    x.fillStyle = p.topLine; x.fillRect(0, 0, w, 3);
    x.fillStyle = p.botLine; x.fillRect(0, h - 5, w, 5);
    hazard(x, 0, 0, 24, h); hazard(x, w - 24, 0, 24, h);
    /* 激光避障传感器窗 */
    x.fillStyle = '#0d1420'; x.fillRect(96, 20, 66, 32);
    x.fillStyle = '#163052'; x.fillRect(99, 23, 60, 26);
    x.fillStyle = '#e23b2e'; x.fillRect(122, 31, 13, 12);
    /* 急停按钮与品牌 */
    x.fillStyle = '#ffffff'; x.font = '900 19px "Arial Black",Arial,sans-serif';
    x.fillText('E', 40, 47);
    x.fillStyle = '#cf0f22'; x.beginPath(); x.arc(78, 38, 9, 0, 7); x.fill();
    x.fillStyle = '#ffd7dc'; x.font = 'bold 8px Arial'; x.fillText('STOP', 69, 41);
    /* 青色灯带 */
    x.fillStyle = '#54f0e0'; x.fillRect(38, 62, 180, 4);
    x.fillStyle = 'rgba(84,240,224,.25)'; x.fillRect(38, 60, 180, 9);
  }

  function shTopTex(x, w, h, p) {
    p = p || shPal('blue');
    x.fillStyle = p.mid; x.fillRect(0, 0, w, h);
    fibers(x, w, h, 200, 0.05, p.fiber);
    /* 检修盖 */
    x.strokeStyle = p.capLine; x.lineWidth = 3;
    x.strokeRect(w * 0.22, h * 0.14, w * 0.56, h * 0.52);
    x.strokeStyle = p.capHi; x.lineWidth = 1;
    x.strokeRect(w * 0.22 + 4, h * 0.14 + 4, w * 0.56 - 8, h * 0.52 - 8);
    /* 状态窗 ×2 */
    [0.24, 0.36].forEach(function (p) {
      x.fillStyle = '#e8edf2'; x.fillRect(w * 0.54, h * p, w * 0.12, h * 0.055);
      x.fillStyle = '#2a3442'; x.fillRect(w * 0.57, h * (p + 0.012), w * 0.06, h * 0.028);
    });
    /* 四角螺钉 */
    [[0.28, 0.19], [0.72, 0.19], [0.28, 0.61], [0.72, 0.61]].forEach(function (p) {
      x.fillStyle = '#8fa6c4'; x.beginPath(); x.arc(w * p[0], h * p[1], 3, 0, 7); x.fill();
    });
    /* 铭牌条码 */
    x.fillStyle = '#e9eef5'; x.fillRect(w * 0.28, h * 0.76, w * 0.44, h * 0.13);
    x.fillStyle = '#14223c';
    for (var i = 0; i < 12; i++) if (i % 3 !== 1) x.fillRect(w * (0.30 + i * 0.033), h * 0.785, w * 0.012, h * 0.075);
    x.fillStyle = 'rgba(10,32,84,.85)'; x.fillRect(w * 0.34, h * 0.93, w * 0.32, 4);
  }

  /* BoxGeometry 的 -X / -Z 面 UV 会让文字左右镜像，单独出一张水平翻转贴图 */
  function shSideFlipTex(x, w, h, p) {
    x.save(); x.translate(w, 0); x.scale(-1, 1);
    shSideTex(x, w, h, p);
    x.restore();
  }
  function shFrontFlipTex(x, w, h, p) {
    x.save(); x.translate(w, 0); x.scale(-1, 1);
    shFrontTex(x, w, h, p);
    x.restore();
  }

  function shDeckTex(x, w, h) {
    var g = x.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, '#c9d0d6'); g.addColorStop(0.5, '#e9edf0'); g.addColorStop(1, '#aeb7c1');
    x.fillStyle = g; x.fillRect(0, 0, w, h);
    for (var yy = 0; yy < 4; yy++) {
      for (var xx = 0; xx < 4; xx++) {
        var cx = xx * 16 + 8, cy = yy * 16 + 8, a = (xx + yy) % 2 ? 0.78 : -0.78;
        x.save(); x.translate(cx, cy); x.rotate(a);
        x.fillStyle = '#8d969e'; x.beginPath(); x.ellipse(0.8, 0.8, 6, 1.8, 0, 0, 7); x.fill();
        x.fillStyle = '#f7f9fa'; x.beginPath(); x.ellipse(0, 0, 6, 1.8, 0, 0, 7); x.fill();
        x.restore();
      }
    }
  }

  /* ---------------- 材质封装 ---------------- */
  function faceMat(key, texKey, w, h, draw, opts) {
    if (matCache[key]) return matCache[key];
    var t = mkTex(texKey, w, h, draw);
    var m = new T.MeshStandardMaterial(Object.assign({
      map: t, color: 0xffffff, roughness: 0.86, metalness: 0.02,
      envMap: envMap, envMapIntensity: 0.30
    }, opts || {}));
    m.userData.shared = true;
    matCache[key] = m;
    return m;
  }

  function solid(key, color, opts) {
    if (matCache[key]) return matCache[key];
    var m = new T.MeshStandardMaterial(Object.assign({
      color: color, roughness: 0.66, metalness: 0.12,
      envMap: envMap, envMapIntensity: 0.5
    }, opts || {}));
    m.userData.shared = true;
    matCache[key] = m;
    return m;
  }

  function tinted(key, texKey, w, h, draw, color, opts) {
    if (matCache[key]) return matCache[key];
    var t = mkTex(texKey, w, h, draw);
    var m = new T.MeshStandardMaterial(Object.assign({
      map: t, color: color, roughness: 0.50, metalness: 0.46,
      envMap: envMap, envMapIntensity: 0.58
    }, opts || {}));
    m.userData.shared = true;
    matCache[key] = m;
    return m;
  }

  /* 逐面材质：BoxGeometry 组顺序 [+X, -X, +Y, -Y, +Z, -Z] */
  function six(side, top, bottom, front, back) {
    return [side, side, top, bottom, front, back];
  }

  var API = {
    init: function (renderer) {
      aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy ? renderer.capabilities.getMaxAnisotropy() : 4);
      Object.keys(cache).forEach(function (k) { cache[k].anisotropy = aniso; });
      /* 生成柔和的室内环境反射：天花灯带 + 地面渐变，让钢材具备真实高光 */
      try {
        var c = D.createElement('canvas'); c.width = 512; c.height = 256;
        var x = c.getContext('2d');
        var g = x.createLinearGradient(0, 0, 0, 256);
        g.addColorStop(0, '#f8fbff'); g.addColorStop(0.30, '#dfe9f7');
        g.addColorStop(0.55, '#aebdd2'); g.addColorStop(1, '#6f7f96');
        x.fillStyle = g; x.fillRect(0, 0, 512, 256);
        [70, 220, 380].forEach(function (cx) {
          var lg = x.createRadialGradient(cx, 34, 4, cx, 34, 90);
          lg.addColorStop(0, 'rgba(255,255,255,.98)');
          lg.addColorStop(0.35, 'rgba(255,255,255,.55)');
          lg.addColorStop(1, 'rgba(255,255,255,0)');
          x.fillStyle = lg; x.fillRect(cx - 90, 0, 180, 130);
          x.fillStyle = 'rgba(255,255,255,.85)'; x.fillRect(cx - 46, 26, 92, 9);
        });
        var eq = new T.CanvasTexture(c);
        eq.mapping = T.EquirectangularReflectionMapping;
        eq.encoding = T.sRGBEncoding;
        var pm = new T.PMREMGenerator(renderer);
        pm.compileEquirectangularShader();
        envMap = pm.fromEquirectangular(eq).texture;
        eq.dispose(); pm.dispose();
        Object.keys(matCache).forEach(function (k) {
          var arr = Array.isArray(matCache[k]) ? matCache[k] : [matCache[k]];
          arr.forEach(function (m) { if (m.isMeshStandardMaterial) { m.envMap = envMap; m.needsUpdate = true; } });
        });
      } catch (e) { envMap = null; }
    },

    get envMap() { return envMap; },

    /* 纸箱 A：印刷瓦楞箱 */
    cartonFaces: function () {
      if (matCache.cartonFaces) return matCache.cartonFaces;
      var f = six(
        faceMat('c_side', 't_c_side', 256, 256, kraftSide),
        faceMat('c_top', 't_c_top', 256, 256, kraftTop),
        faceMat('c_bottom', 't_c_plain', 128, 128, kraftPlain),
        faceMat('c_front', 't_c_front', 256, 256, function (x, w, h) { kraftPrint(x, w, h, true); }),
        faceMat('c_back', 't_c_back', 256, 256, function (x, w, h) { kraftPrint(x, w, h, false); })
      );
      matCache.cartonFaces = f;
      return f;
    },

    /* 纸箱 B：白色缠膜 + 棕色胶带 */
    wrapFaces: function () {
      if (matCache.wrapFaces) return matCache.wrapFaces;
      var f = six(
        faceMat('w_side', 't_w_side', 256, 256, function (x, w, h) { wrapFace(x, w, h, false); }),
        faceMat('w_top', 't_w_top', 256, 256, wrapTop),
        faceMat('w_bottom', 't_w_bottom', 128, 128, wrapBase),
        faceMat('w_front', 't_w_front', 256, 256, function (x, w, h) { wrapFace(x, w, h, true); }),
        faceMat('w_back', 't_w_back', 256, 256, function (x, w, h) { wrapFace(x, w, h, false); })
      );
      matCache.wrapFaces = f;
      return f;
    },

    /* 蓝色塑料料箱 */
    crateFaces: function () {
      if (matCache.crateFaces) return matCache.crateFaces;
      var f = six(
        faceMat('k_side', 't_k_side', 256, 256, function (x, w, h) { crateFace(x, w, h, false); }, { roughness: 0.58, metalness: 0.06, envMapIntensity: 0.6 }),
        faceMat('k_top', 't_k_top', 256, 256, crateTop, { roughness: 0.58, metalness: 0.06 }),
        faceMat('k_bottom', 't_k_plain', 128, 128, function (x, w, h) { crateBase(x, w, h); }),
        faceMat('k_front', 't_k_front', 256, 256, function (x, w, h) { crateFace(x, w, h, true); }, { roughness: 0.58, metalness: 0.06, envMapIntensity: 0.6 }),
        faceMat('k_back', 't_k_back', 256, 256, function (x, w, h) { crateFace(x, w, h, false); }, { roughness: 0.58, metalness: 0.06 })
      );
      matCache.crateFaces = f;
      return f;
    },

    crateLid: function () { return faceMat('k_lid', 't_k_lid', 256, 256, crateTop, { roughness: 0.55, metalness: 0.08 }); },
    pallet: function () { return faceMat('p_all', 't_pallet', 256, 256, palletTex, { roughness: 0.78, metalness: 0.05 }); },

    /* 镀锌钢制金属周转箱：金属度高、环境反射强 */
    metalFaces: function () {
      if (matCache.metalFaces) return matCache.metalFaces;
      var o = { roughness: 0.36, metalness: 0.62, envMapIntensity: 0.95 };
      var f = six(
        faceMat('m_side', 't_m_side', 256, 256, function (x, w, h) { metalFace(x, w, h, false); }, o),
        faceMat('m_top', 't_m_top', 256, 256, metalTop, o),
        faceMat('m_bottom', 't_m_plain', 128, 128, metalBase, o),
        faceMat('m_front', 't_m_front', 256, 256, function (x, w, h) { metalFace(x, w, h, true); }, o),
        faceMat('m_back', 't_m_back', 256, 256, function (x, w, h) { metalFace(x, w, h, false); }, o)
      );
      matCache.metalFaces = f;
      return f;
    },

    /* 麻布散货包：粗糙织物、零金属 */
    sackFaces: function () {
      if (matCache.sackFaces) return matCache.sackFaces;
      var o = { roughness: 0.96, metalness: 0.0, envMapIntensity: 0.12 };
      var f = six(
        faceMat('s_side', 't_s_side', 256, 256, sackSide, o),
        faceMat('s_top', 't_s_top', 256, 256, sackTop, o),
        faceMat('s_bottom', 't_s_bottom', 128, 128, sackBase, o),
        faceMat('s_front', 't_s_front', 256, 256, function (x, w, h) { sackFace(x, w, h, true); }, o),
        faceMat('s_back', 't_s_back', 256, 256, function (x, w, h) { sackFace(x, w, h, false); }, o)
      );
      matCache.sackFaces = f;
      return f;
    },

    /* EPS 冷链保温泡沫箱 */
    foamFaces: function () {
      if (matCache.foamFaces) return matCache.foamFaces;
      var o = { roughness: 0.92, metalness: 0.0, envMapIntensity: 0.18 };
      var f = six(
        faceMat('f_side', 't_f_side', 256, 256, function (x, w, h) { foamFace(x, w, h, false); }, o),
        faceMat('f_top', 't_f_top', 256, 256, foamTop, o),
        faceMat('f_bottom', 't_f_bottom', 128, 128, foamBase, o),
        faceMat('f_front', 't_f_front', 256, 256, function (x, w, h) { foamFace(x, w, h, true); }, o),
        faceMat('f_back', 't_f_back', 256, 256, function (x, w, h) { foamFace(x, w, h, false); }, o)
      );
      matCache.foamFaces = f;
      return f;
    },

    /* 统一入口：kind -> 六面材质数组 */
    cargoFaces: function (kind) {
      if (kind === 'metal') return API.metalFaces();
      if (kind === 'sack') return API.sackFaces();
      if (kind === 'foam') return API.foamFaces();
      if (kind === 'crate') return API.crateFaces();
      return API.cartonFaces();
    },

    /* 选择器缩略图：直接取真实贴图绘制，所见即所得 */
    preview: function (kind) {
      var c = D.createElement('canvas'); c.width = 180; c.height = 112;
      var x = c.getContext('2d');
      x.fillStyle = '#eef2f8'; x.fillRect(0, 0, 180, 112);
      function face(k) {
        var m = API.cargoFaces(k)[4];
        return m && m.map && m.map.image ? m.map.image : null;
      }
      function swatch(img, dx, dy, dw, dh) {
        if (!img) return;
        x.drawImage(img, dx, dy, dw, dh);
        var g = x.createLinearGradient(0, dy, 0, dy + dh);
        g.addColorStop(0, 'rgba(255,255,255,.22)'); g.addColorStop(0.35, 'rgba(255,255,255,0)');
        g.addColorStop(1, 'rgba(22,34,58,.20)');
        x.fillStyle = g; x.fillRect(dx, dy, dw, dh);
      }
      if (kind === 'mix') {
        [['metal', 0, 0], ['sack', 1, 0], ['carton', 0, 1], ['foam', 1, 1]].forEach(function (p) {
          swatch(face(p[0]), p[1] * 90 + 2, p[2] * 56 + 2, 86, 52);
        });
        x.strokeStyle = 'rgba(255,255,255,.9)'; x.lineWidth = 2;
        x.beginPath(); x.moveTo(90, 0); x.lineTo(90, 112); x.moveTo(0, 56); x.lineTo(180, 56); x.stroke();
      } else {
        swatch(face(kind), 0, 0, 180, 112);
      }
      return c.toDataURL('image/png');
    },

    upright: function (hex) {
      var key = 'upr_' + hex;
      return tinted(key, 't_steel', 64, 256, function (x, w, h) { steel(x, w, h, true); }, hex,
        { roughness: 0.42, metalness: 0.58, envMapIntensity: 0.72 });
    },
    beam: function () {
      return tinted('beam', 't_beam', 256, 64, beamTex, 0xef7716,
        { roughness: 0.48, metalness: 0.24, envMapIntensity: 0.42 });
    },
    rail: function () {
      return tinted('rail', 't_rail', 256, 64, railTex, 0xc4cedc,
        { roughness: 0.38, metalness: 0.60, envMapIntensity: 0.70 });
    },
    railMain: function () {
      return tinted('railMain', 't_rail', 256, 64, railTex, 0x9aa9be,
        { roughness: 0.40, metalness: 0.58, envMapIntensity: 0.70 });
    },
    lift: function () {
      return tinted('lift', 't_beam', 256, 64, beamTex, 0xe8af12,
        { roughness: 0.44, metalness: 0.34, envMapIntensity: 0.55 });
    },
    liftTop: function () { return solid('liftTop', 0x2b3446, { roughness: 0.5, metalness: 0.35 }); },
    conv: function () { return tinted('conv', 't_rail', 256, 64, railTex, 0xb6c2d2, { roughness: 0.5, metalness: 0.5 }); },
    /* 层间输送线：朝向提升机的两条平行黑色长方体（哑光橡胶/烤漆），配不锈钢滚筒与黄色端挡 */
    convBar: function () { return solid('conv_bar', 0x0d121a, { roughness: 0.88, metalness: 0.06, envMapIntensity: 0.16 }); },
    convRoller: function () { return solid('conv_roller', 0x7b889a, { roughness: 0.30, metalness: 0.78, envMapIntensity: 1.0 }); },
    convEnd: function () { return solid('conv_end', 0xe0ab16, { roughness: 0.48, metalness: 0.34 }); },
    foot: function () { return solid('foot', 0x3c465a, { roughness: 0.7, metalness: 0.25 }); },
    /* 四向穿梭车：六面各自贴图 + 结构件材质。
       colorKey 为空 / 'blue' 时用原始蓝色贴图；其它颜色只替换车身主色渐变，
       警示条 / 品牌字 / 散热栅格 / 铭牌 / 状态灯带等结构全部保留。 */
    shuttleFaces: function (colorKey) {
      var key = colorKey || 'blue';
      var ck = 'shuttleFaces_' + key;
      if (matCache[ck]) return matCache[ck];
      if (key === 'blue' && matCache.shuttleFaces) return matCache.shuttleFaces;
      var suf = key === 'blue' ? '' : '_' + key;
      var pal = shPal(key);
      var o = { roughness: 0.34, metalness: 0.52, envMapIntensity: 0.95 };
      var side = faceMat('sh_side' + suf, 't_sh_side' + suf, 512, 96,
        function (x, w, h) { shSideTex(x, w, h, pal); }, o);
      var top = faceMat('sh_top' + suf, 't_sh_top' + suf, 128, 256,
        function (x, w, h) { shTopTex(x, w, h, pal); },
        { roughness: 0.38, metalness: 0.48, envMapIntensity: 0.9 });
      var bottom = solid('sh_bottom' + suf, 0x20293a, { roughness: 0.72, metalness: 0.35 });
      var sideF = faceMat('sh_side_f' + suf, 't_sh_side_f' + suf, 512, 96,
        function (x, w, h) { shSideFlipTex(x, w, h, pal); }, o);
      var front = faceMat('sh_front' + suf, 't_sh_front' + suf, 256, 96,
        function (x, w, h) { shFrontTex(x, w, h, pal); }, o);
      var frontF = faceMat('sh_front_f' + suf, 't_sh_front_f' + suf, 256, 96,
        function (x, w, h) { shFrontFlipTex(x, w, h, pal); }, o);
      /* BoxGeometry 面序 [+X, -X, +Y, -Y, +Z, -Z] */
      matCache[ck] = [side, sideF, top, bottom, front, frontF];
      return matCache[ck];
    },
    shuttleTints: function () { return Object.keys(SH_TINT); },
    palletSub: function () { return faceMat('p_sub', 't_p_sub', 256, 256, palletSubTex, { roughness: 0.82, metalness: 0.04 }); },
    palletMother: function () { return faceMat('p_mother', 't_p_mother', 256, 256, palletMotherTex, { roughness: 0.30, metalness: 0.74, envMapIntensity: 0.9 }); },
    shuttleDeckBody: function (colorKey) {
      var key = colorKey || 'blue';
      var base = SH_TINT[key] || SH_TINT.blue;
      var hex = parseInt(shade(base, -0.16).slice(1), 16);
      return solid('sh_deck_body_' + key, hex, { roughness: 0.38, metalness: 0.52, envMapIntensity: 0.9 });
    },
    shuttleDeck: function () {
      if (matCache.sh_deck) return matCache.sh_deck;
      var t = mkTex('t_sh_deck', 64, 64, shDeckTex, { repeat: [2, 4] });
      var m = new T.MeshStandardMaterial({
        map: t, color: 0xffffff, roughness: 0.42, metalness: 0.72,
        envMap: envMap, envMapIntensity: 1.05
      });
      m.userData.shared = true;
      matCache.sh_deck = m;
      return m;
    },
    shuttleDark: function () { return solid('sh_dark', 0x171e2b, { roughness: 0.74, metalness: 0.18 }); },
    shuttleSteel: function () { return solid('sh_steel', 0x8f9cad, { roughness: 0.36, metalness: 0.76 }); },
    shuttleBumper: function () { return solid('sh_bump', 0xe8b21c, { roughness: 0.58, metalness: 0.22 }); },
    shuttleWheel: function () { return solid('sh_wheel', 0x252b34, { roughness: 0.86, metalness: 0.08 }); },
    /* 状态灯为每台车独立材质（可单独变色：运行绿 / 充电红 / 等待黄），故不缓存 */
    shuttleLamp: function () {
      return new T.MeshBasicMaterial({ color: 0x2ee66b, toneMapped: false });
    },
    shuttle: function () { return API.shuttleFaces()[0]; },
    shuttleTop: function () { return API.shuttleFaces()[2]; },
    platform: function () { return tinted('platform', 't_rail', 256, 64, railTex, 0x9aa8ba, { roughness: 0.52, metalness: 0.45 }); },
    charger: function () { return solid('charger', 0x36425a, { roughness: 0.6, metalness: 0.25 }); },
    led: function () { return new T.MeshBasicMaterial({ color: 0x7cf0b4, toneMapped: false }); },

    groundTexture: function () { return mkTex('t_ground', 256, 256, groundTex, { repeat: [40, 40] }); },
    shadowTexture: function () { return mkTex('t_shadow', 256, 256, shadowTex); },
    netTexture: function () { return mkTex('t_net', 64, 64, netTex, { repeat: [1, 1] }); },

    /* 通用非共享材质（用于线框、半透明面等） */
    basic: function (color, opts) {
      return new T.MeshBasicMaterial(Object.assign({ color: color }, opts || {}));
    }
  };

  WAP.materials = API;
})(window);
