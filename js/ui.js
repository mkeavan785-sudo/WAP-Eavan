/* WAP-Eavan · ui.js
   界面绑定：快速建构、参数面板、视图开关、模式图标、货位信息、统计与配置存取。 */
(function (global) {
  'use strict';
  var WAP = global.WAP = global.WAP || {};
  var D = global.document;
  var $ = function (id) { return D.getElementById(id); };
  var core = WAP.core;

  var FIELDS = {
    fStructure: [
      { k: 'name', l: '项目名称', t: 'text', wide: true },
      { k: 'aisles', l: '主巷道数', t: 'num', min: 1, max: 4, step: 1, u: '条' },
      { k: 'levels', l: '层数', t: 'num', min: 2, max: 12, step: 1, u: '层' },
      { k: 'bayGroups', l: 'BAY 分区（仅标注，不挖空）', t: 'text', wide: true },
      { k: 'depths', l: '各储区深度（板）', t: 'text', wide: true },
      { k: 'mid', l: '中间储区存取', t: 'sel', wide: true, o: [['split', '两侧巷道各取一半'], ['full', '整排单侧存取']] },
      { k: 'y0', l: '一楼梁面高', t: 'num', step: 0.05, u: 'm' },
      { k: 'pitch', l: '层距', t: 'num', step: 0.05, u: 'm' },
      { k: 'bayW', l: 'BAY 宽（横向轴距）', t: 'num', step: 0.05, u: 'm' },
      { k: 'gap', l: '托盘间距（纵向轴距）', t: 'num', step: 5, u: 'mm' },
      { k: '_hint1', l: '', t: 'hint', text: '每一列 BAY 即一条子通道（沿 Z 深入）；储区之间为沿 X 贯穿的主通道。货架连续排布、中间不挖空；垂直于主通道的贯通空道为维修通道，本期不制作。BAY 宽 / 托盘间距等同货位面板的横、纵轴距，在此改动会切成手动模式；点货位面板「按货架模型自适应」可恢复。' }
    ],
    fDevice: [
      { k: 'liftN', l: '提升机台数', t: 'num', min: 1, max: 8, step: 1, u: '台' },
      { k: 'perLevel', l: '每层四向车数', t: 'num', min: 1, max: 3, step: 1, u: '台' },
      { k: 'liftRate', l: '提升机速率', t: 'num', min: 5, max: 300, step: 5, u: '板/H' },
      { k: 'need', l: '目标吞吐量', t: 'num', min: 0, max: 5000, step: 10, u: '板/H' },
      { k: 'vE', l: '空载速度', t: 'num', min: 20, max: 500, step: 5, u: 'cm/s' },
      { k: 'vL', l: '负载速度', t: 'num', min: 20, max: 500, step: 5, u: 'cm/s' },
      { k: 'shW', l: '四向车宽', t: 'num', min: 70, max: 150, step: 5, u: 'cm' },
      { k: 'shL', l: '四向车长', t: 'num', min: 70, max: 150, step: 5, u: 'cm' },
      { k: '_hint2', l: '', t: 'hint', text: '提升机均匀对接前端子通道口，不是每条子通道一台；四向车按层固定配置，每层至少 1 台，不跨层、不搭乘提升机。' }
    ],
    fVisual: [
      { k: 'cargoType', l: '默认货位种类', t: 'sel', wide: true, o: WAP.core.CARGO_KINDS.map(function (o) { return [o.k, o.n + ' · ' + o.d]; }) },
      { k: 'loadMM', l: '货高（含栈板）', t: 'num', min: 300, max: 2500, step: 10, u: 'mm' },
      { k: 'kg', l: '单板载重', t: 'num', min: 1, max: 3000, step: 10, u: 'kg' },
      { k: 'fill', l: '初始在库率', t: 'num', min: 0, max: 100, step: 5, u: '%' },
      { k: 'split', l: '下层纸箱层数', t: 'num', min: 0, max: 12, step: 1, u: '层' },
      { k: 'upr', l: '立柱颜色', t: 'sel', o: [['blue', '蓝色烤漆'], ['gray', '灰色镀锌'], ['orange', '橘色烤漆'], ['green', '绿色烤漆'], ['yellow', '黄色烤漆'], ['red', '红色烤漆'], ['white', '白色烤漆'], ['black', '黑色烤漆']] },
      { k: 'netSide', l: '黄色安全网', t: 'sel', o: [['none', '无'], ['side', '侧面安装'], ['back', '背面安装'], ['both', '侧面＋背面']] },
      { k: 'netH', l: '安全网高度', t: 'sel', o: [['full', '全高'], ['3m', '3 m 高']] },
      { k: 'chg', l: '充电展示区', t: 'sel', o: [[true, '启用'], [false, '不启用']] }
    ]
  };

  function toText(k, v) {
    if (Array.isArray(v)) {
      if (k === 'lowR' || k === 'highR') return v ? (v[0] === v[1] ? String(v[0]) : v[0] + '-' + v[1]) : '';
      return v.join('/');
    }
    if (typeof v === 'boolean') return String(v);
    return String(v == null ? '' : v);
  }

  function parseVal(k, raw, old) {
    if (k === 'bayGroups' || k === 'depths') {
      var a = String(raw).split(/[\/,，、\s]+/).filter(Boolean).map(Number).filter(function (v) { return v >= 1 && isFinite(v); });
      return a.length ? a.map(Math.round) : old;
    }
    if (k === 'lowR' || k === 'highR') {
      var t = String(raw).trim();
      if (!t) return null;
      var m = t.match(/^(\d+)\s*[-~～至到]\s*(\d+)$/);
      return m ? [+m[1], +m[2]] : [+t, +t];
    }
    if (k === 'chg') return raw === 'true';
    if (typeof old === 'number') { var n = Number(raw); return isFinite(n) ? n : old; }
    return raw;
  }

  function buildFields() {
    Object.keys(FIELDS).forEach(function (boxId) {
      var box = $(boxId);
      if (!box) return;
      FIELDS[boxId].forEach(function (f) {
        if (f.t === 'hint') {
          var p = D.createElement('p');
          p.className = 'field-hint'; p.textContent = f.text;
          box.appendChild(p); return;
        }
        var wrap = D.createElement('div');
        wrap.className = 'field' + (f.wide ? ' wide' : '');
        var lab = D.createElement('label'); lab.textContent = f.l; lab.setAttribute('for', 'f_' + f.k);
        wrap.appendChild(lab);
        var inp;
        if (f.t === 'sel') {
          inp = D.createElement('select');
          f.o.forEach(function (o) {
            var op = D.createElement('option'); op.value = String(o[0]); op.textContent = o[1]; inp.appendChild(op);
          });
        } else {
          inp = D.createElement('input');
          inp.type = f.t === 'num' ? 'number' : 'text';
          if (f.min != null) inp.min = f.min;
          if (f.max != null) inp.max = f.max;
          if (f.step != null) inp.step = f.step;
          if (f.u) {
            var unit = D.createElement('span');
            unit.className = 'unit'; unit.setAttribute('data-u', f.u);
            unit.appendChild(inp); wrap.appendChild(unit);
          }
        }
        inp.id = 'f_' + f.k; inp.dataset.k = f.k;
        if (!f.u || f.t === 'sel') wrap.appendChild(inp);
        inp.addEventListener('change', function () {
          var c = core.clone(WAP.state.cfg);
          c[f.k] = parseVal(f.k, inp.value, c[f.k]);
          /* BAY 宽 / 托盘间距就是货位面板的横、纵轴距：
             在结构面板改动即视为「人工设定」，切成手动模式，避免被自适应覆盖 */
          if (f.k === 'bayW' || f.k === 'gap') {
            var g0 = WAP.state.geom;
            c.cellAuto = false;
            c.cellPitchX = f.k === 'bayW'
              ? core.clamp(Number(c.bayW) || 1.4, 1.2, 2)
              : (g0 ? +g0.lw.toFixed(2) : 1.4);
            c.cellPitchZ = f.k === 'gap'
              ? 1.0 + core.clamp(Number(c.gap) || 0, 0, 300) / 1000
              : (g0 ? +g0.dw.toFixed(2) : 1.05);
          }
          var nc = core.normalize(c);
          var err = core.validate(nc);
          if (err) { toast(err); refresh(); return; }
          WAP.state.cfg = nc;
          WAP.app.commit();
        });
        box.appendChild(wrap);
      });
    });
  }

  function syncFields() {
    var c = WAP.state.cfg;
    D.querySelectorAll('.field [data-k]').forEach(function (inp) {
      if (D.activeElement === inp) return;
      inp.value = toText(inp.dataset.k, c[inp.dataset.k]);
    });
  }

  var toastTimer = null;
  function toast(msg) {
    var el = $('toast');
    el.textContent = msg; el.classList.add('show');
    global.clearTimeout(toastTimer);
    toastTimer = global.setTimeout(function () { el.classList.remove('show'); }, 2100);
  }

  /* ---------- 快速建构 ---------- */
  var Q = [
    { key: 'len', rng: 'rngLen', val: 'valLen', dim: 'dimLen', sub: 'subLen', lo: 2, hi: 40 },
    { key: 'wid', rng: 'rngWid', val: 'valWid', dim: 'dimWid', sub: 'subWid', lo: 3, hi: 24 },
    { key: 'hei', rng: 'rngHei', val: 'valHei', dim: 'dimHei', sub: 'subHei', lo: 2, hi: 12 }
  ];
  function quickValues() {
    var c = WAP.state.cfg, g = WAP.state.geom;
    return {
      len: { n: c.bays, dim: g.len.toFixed(1) + ' m', sub: '子通道 ' + c.bays + ' 条 · 分区 ' + c.bayGroups.join(' / ') },
      wid: { n: c.depths.reduce(function (a, b) { return a + b; }, 0), dim: g.tot.toFixed(1) + ' m', sub: '储区 ' + c.depths.join(' / ') },
      hei: { n: c.levels, dim: g.top.toFixed(1) + ' m', sub: '层距 ' + c.pitch.toFixed(2) + ' m' }
    };
  }

  var quickTimer = null;
  function applyQuick(key, n) {
    var c = core.clone(WAP.state.cfg);
    if (key === 'len') c = core.setLen(c, n);
    else if (key === 'wid') c = core.setWid(c, n);
    else c = core.setHei(c, n);
    var err = core.validate(c);
    if (err) { toast(err); refresh(); return; }
    WAP.state.cfg = c;
    var q = Q.filter(function (x) { return x.key === key; })[0];
    if (q) $(q.val).textContent = n;
    global.clearTimeout(quickTimer);
    quickTimer = global.setTimeout(function () { WAP.app.commit(); }, 70);
  }

  function bindQuick() {
    Q.forEach(function (q) {
      var rng = $(q.rng);
      rng.min = q.lo; rng.max = q.hi;
      rng.addEventListener('input', function () { applyQuick(q.key, +rng.value); });
      rng.addEventListener('change', function () { applyQuick(q.key, +rng.value); });
    });
    D.querySelectorAll('.step[data-act]').forEach(function (b) {
      b.addEventListener('click', function () {
        var p = b.dataset.act.split(':');
        var q = Q.filter(function (x) { return x.key === p[0]; })[0];
        var cur = quickValues()[q.key].n;
        applyQuick(q.key, core.clamp(cur + (+p[1]), q.lo, q.hi));
      });
    });

    var menu = $('addMenu'), btn = $('btnAdd');
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      var open = menu.hidden;
      menu.hidden = !open;
      btn.setAttribute('aria-expanded', String(open));
      if (open) refreshAddMenu();
    });
    D.addEventListener('click', function (e) {
      if (!menu.hidden && !menu.contains(e.target) && e.target !== btn) {
        menu.hidden = true; btn.setAttribute('aria-expanded', 'false');
      }
    });
    menu.querySelectorAll('[data-add]').forEach(function (b) {
      b.addEventListener('click', function () {
        var c = core.clone(WAP.state.cfg);
        var total = c.depths.reduce(function (a, b2) { return a + b2; }, 0);
        switch (b.dataset.add) {
          case 'col': c = core.setLen(c, c.bays + 1); break;
          case 'row': c = core.setWid(c, total + 1); break;
          case 'level': c = core.setHei(c, c.levels + 1); break;
          case 'aisle': c = core.addAisle(c); break;
          case 'bulk': c = core.setLen(c, c.bays + 5); break;
        }
        var err = core.validate(c);
        if (err) { toast(err); return; }
        WAP.state.cfg = c;
        menu.hidden = true; btn.setAttribute('aria-expanded', 'false');
        WAP.app.commit();
        toast('已添加货位，模型实时更新');
      });
    });
  }

  function refreshAddMenu() {
    var c = WAP.state.cfg;
    var perCol = c.levels * c.depths.reduce(function (a, b) { return a + b; }, 0);
    var perRow = c.levels * c.bays;
    var perLev = c.bays * c.depths.reduce(function (a, b) { return a + b; }, 0);
    $('addColN').textContent = perCol;
    $('addRowN').textContent = perRow;
    $('addLevN').textContent = perLev;
  }

  /* ---------- 视图 / 模式 ---------- */
  function bindView() {
    var toggles = [
      { id: 'btnCrystal', key: 'crystal' },
      { id: 'btnFrame', key: 'frame' },
      { id: 'btnCargo', key: 'cargo' }
    ];
    var viewNames = { crystal: '晶格视图', frame: '货架结构', cargo: '在库货物' };
    toggles.forEach(function (t) {
      $(t.id).addEventListener('click', function () {
        var v = WAP.state.view;
        v[t.key] = !v[t.key];
        $(t.id).classList.toggle('is-on', v[t.key]);
        $(t.id).setAttribute('aria-pressed', String(v[t.key]));
        if (t.key === 'crystal' && v.crystal && WAP.state.selection.phase === 2) {
          /* 个体选择态下重新开启晶格 → 回到整体模型控制面板 */
          WAP.state.selection.phase = 1;
          WAP.state.selection.crystalHidden = false;
          WAP.ctx.open('rack', null);
        }
        WAP.rack.applyView();
        toast((v[t.key] ? '已开启' : '已关闭') + '：' + (viewNames[t.key] || t.key));
      });
    });
    $('btnFit').addEventListener('click', function () {
      var g = WAP.state.geom;
      WAP.scene.fit([g.len, g.top, g.tot]);
      toast('已适应当前库体');
    });
    $('btnFull').addEventListener('click', function () {
      var el = D.querySelector('.app');
      if (D.fullscreenElement) D.exitFullscreen();
      else if (el.requestFullscreen) el.requestFullscreen();
      global.setTimeout(function () { WAP.scene.resize(); }, 120);
    });
  }

  function setModeUI(m) {
    var object = m === 'object';
    var move = m === 'move';
    $('btnMove').classList.toggle('is-on', move);
    $('btnRotate').classList.toggle('is-on', !move && !object);
    $('btnObject').classList.toggle('is-on', object);
    $('btnMove').setAttribute('aria-pressed', String(move));
    $('btnRotate').setAttribute('aria-pressed', String(!move && !object));
    $('btnObject').setAttribute('aria-pressed', String(object));
    $('modeHint').textContent = object ? '模型变换' : (move ? '平移视角' : '旋转视角');
    $('sbMode').textContent = object ? '模型变换模式' : (move ? '移动模式' : '旋转模式');
    $('viewBadgeTxt').textContent = object ? '模型变换 · 拖拽 Gizmo 或视口' : (move ? '移动模式 · 拖拽平移' : '旋转模式 · 拖拽旋转');
  }

  function cameraMode(m) {
    WAP.transform.setActive(false);
    WAP.scene.setMode(m);
  }

  function bindMode() {
    $('btnMove').addEventListener('click', function () { cameraMode('move'); });
    $('btnRotate').addEventListener('click', function () { cameraMode('rotate'); });
    WAP.scene.S.onMode = setModeUI;
  }

  /* ---------- 货位货物种类 ---------- */
  function kindInfo(k) {
    return WAP.core.CARGO_KINDS.filter(function (o) { return o.k === k; })[0] || WAP.core.CARGO_KINDS[0];
  }

  function setCargoKind(k) {
    if (WAP.core.CARGO_KEYS.indexOf(k) < 0) return;
    WAP.state.cfg.cargoType = k;
    WAP.app.commit(true);
    toast('已切换为「' + WAP.core.CARGO_NAME[k] + '」贴图');
  }
  /* 货物大类：无托盘单货物 / 子母托盘 / 光子托盘 / 光母托盘（与货物外观种类正交） */
  function setCargoClass(k) {
    if (WAP.core.CARGO_CLASS_KEYS.indexOf(k) < 0) return false;
    WAP.rack.setCargoClass(k);
    WAP.app.commit(true);
    syncCargo();
    toast('货物大类 → ' + WAP.core.CARGO_CLASS_NAME[k]);
    return true;
  }
  function buildCargoClasses() {
    var grid = $('cargoClassGrid');
    if (!grid) return;
    grid.innerHTML = WAP.core.CARGO_CLASSES.map(function (o) {
      return '<button type="button" class="cargo-cls" data-cls="' + o.k + '" ' +
        'title="' + esc(o.d) + '" aria-pressed="false">' +
        '<i style="background:' + o.sw + '"></i><b>' + esc(o.n) + '</b></button>';
    }).join('');
    grid.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('[data-cls]') : null;
      if (b) setCargoClass(b.dataset.cls);
    });
    var sel = $('selClass');
    if (sel) {
      sel.innerHTML = '<option value="auto">跟随全局大类</option>' +
        WAP.core.CARGO_CLASSES.map(function (o) {
          return '<option value="' + o.k + '">' + esc(o.n) + '</option>';
        }).join('');
      sel.addEventListener('change', function () {
        var id = WAP.state.selection.cell;
        if (!id) return;
        WAP.rack.setCellClass(id, sel.value);
        WAP.app.commit(true);
        showCell(id);
        toast(sel.value === 'auto' ? '已恢复跟随全局大类'
          : '本货位大类 → ' + WAP.core.CARGO_CLASS_NAME[sel.value]);
      });
    }
  }
  function syncCargoClasses() {
    var cur = WAP.state.cfg.cargoClass || 'single';
    $('cargoClassGrid') && $('cargoClassGrid').querySelectorAll('[data-cls]').forEach(function (b) {
      var on = b.dataset.cls === cur;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-pressed', String(on));
    });
    var pill = $('cargoClassPill');
    if (pill) pill.textContent = WAP.core.CARGO_CLASS_NAME[cur];
  }
  /* 四向车换色面板：点击 3D 中的车后给本台换色，或应用到全部 */
  function shuttleTargetId() {
    return WAP.state.selection.shuttleId || null;
  }
  function buildShuttleColors() {
    var host = $('shSwatches');
    if (!host) return;
    var names = { blue: '经典蓝', red: '中国红', green: '松石绿', orange: '活力橙',
      purple: '丁香紫', silver: '星辰银', graphite: '石墨灰', yellow: '工程黄' };
    var hexes = { blue: '#2467d2', red: '#cf4438', green: '#159b76', orange: '#e08a24',
      purple: '#7b52d4', silver: '#8493a6', graphite: '#414c60', yellow: '#dcae22' };
    host.innerHTML = WAP.core.SH_TINTS.map(function (k) {
      return '<button type="button" class="sh-sw" data-color="' + k + '" ' +
        'title="' + names[k] + '" style="--sw:' + hexes[k] + '"><i></i><span>' + names[k] + '</span></button>';
    }).join('');
    host.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('[data-color]') : null;
      if (!b) return;
      var id = shuttleTargetId();
      WAP.rack.setShuttleColor(id || 'all', b.dataset.color);
      syncShuttleColors();
      toast((id ? '本台车' : '全部四向车') + ' → ' + names[b.dataset.color] + '（贴图结构不变）');
    });
    $('shApplyAll').addEventListener('click', function () {
      var cur = (WAP.state.shuttleColors || {}).all ||
        (WAP.state.shuttleColors || {})[shuttleTargetId()] || 'purple';
      WAP.rack.setShuttleColor('all', cur);
      syncShuttleColors(); toast('已应用到全部四向车');
    });
    $('shReset').addEventListener('click', function () {
      WAP.rack.setShuttleColor('all', 'blue');
      var m = WAP.state.shuttleColors || {};
      Object.keys(m).forEach(function (k) { delete m[k]; });
      WAP.core.saveShuttleColors(m);
      syncShuttleColors(); toast('已恢复经典蓝');
    });
    syncShuttleColors();
  }
  function syncShuttleColors() {
    var id = shuttleTargetId(), cur = (WAP.state.shuttleColors || {})[id || 'all'] ||
      (WAP.state.shuttleColors || {}).all || WAP.state.cfg.shuttleColor || 'blue';
    var pill = $('shuttlePill');
    if (pill) pill.textContent = id ? ('本台车 ' + id) : '全部车辆';
    var info = $('shInfo');
    if (info) info.textContent = id
      ? ('已选中 ' + id + ' · 点色板只给这台车换色，或「应用到全部车辆」。')
      : '再次点击 3D 中的四向车，可单独给它换色；也可一键应用到全部车辆。';
    $('shSwatches') && $('shSwatches').querySelectorAll('[data-color]').forEach(function (b) {
      b.classList.toggle('is-on', b.dataset.color === cur);
    });
  }
  function showShuttlePanel(id) {
    WAP.state.selection.shuttleId = id || null;
    syncShuttleColors();
  }

  function buildCargo() {
    var grid = $('cargoGrid');
    WAP.core.CARGO_KINDS.forEach(function (o) {
      var b = D.createElement('button');
      b.type = 'button'; b.className = 'cargo-opt'; b.dataset.kind = o.k;
      b.setAttribute('aria-pressed', 'false');
      b.title = o.n + ' · ' + o.d;
      var img = D.createElement('img');
      img.alt = ''; img.src = WAP.materials.preview(o.k);
      var th = D.createElement('span'); th.className = 'cargo-thumb'; th.appendChild(img);
      var nm = D.createElement('b'); nm.textContent = o.n;
      var ds = D.createElement('small'); ds.textContent = o.d;
      var ck = D.createElement('span'); ck.className = 'cargo-check'; ck.textContent = '✓';
      b.appendChild(th); b.appendChild(nm); b.appendChild(ds); b.appendChild(ck);
      b.addEventListener('click', function () { setCargoKind(o.k); });
      grid.appendChild(b);
    });

    var sel = $('selKind');
    [{ k: 'auto', n: '跟随全局种类' }].concat(WAP.core.CARGO_REAL.map(function (k) {
      return { k: k, n: WAP.core.CARGO_NAME[k] };
    })).forEach(function (o) {
      var op = D.createElement('option'); op.value = o.k; op.textContent = o.n;
      sel.appendChild(op);
    });
    sel.addEventListener('change', function () {
      var id = WAP.state.selection.cell;
      if (!id) return;
      if (sel.value === 'auto') delete WAP.state.cargoOverrides[id];
      else WAP.state.cargoOverrides[id] = sel.value;
      core.saveCargoOverrides(WAP.state.cargoOverrides);
      WAP.app.commit(true);
      showCell(id);
      toast(sel.value === 'auto' ? '已恢复跟随全局货位种类' : '本货位已设为「' + WAP.core.CARGO_NAME[sel.value] + '」');
    });

    $('btnCargoClear').addEventListener('click', function () {
      var n = Object.keys(WAP.state.cargoOverrides).length;
      if (!n) { toast('当前没有单独指定的货位'); return; }
      WAP.state.cargoOverrides = {};
      core.saveCargoOverrides(WAP.state.cargoOverrides);
      WAP.app.commit(true);
      toast('已清除 ' + n + ' 个货位的单独设置');
    });
    syncCargo();
  }

  function syncCargo() {
    var c = WAP.state.cfg.cargoType;
    var counts = WAP.state.cargoCounts || {};
    $('cargoGrid').querySelectorAll('.cargo-opt').forEach(function (b) {
      var on = b.dataset.kind === c;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-pressed', String(on));
    });
    $('cargoPill').textContent = c === 'mix' ? '智能混放' : WAP.core.CARGO_NAME[c];
    var total = 0;
    WAP.core.CARGO_REAL.forEach(function (k) { total += counts[k] || 0; });
    var dist = $('cargoDist');
    if (!total) {
      dist.innerHTML = '';
      $('cargoSummary').textContent = '当前没有在库货物，可调高「初始在库率」';
      return;
    }
    dist.innerHTML = WAP.core.CARGO_REAL.map(function (k) {
      var n = counts[k] || 0;
      if (!n) return '';
      return '<i style="width:' + (n / total * 100).toFixed(2) + '%;background:' + kindInfo(k).sw +
        '" title="' + kindInfo(k).n + ' ' + n + ' 位"></i>';
    }).join('');
    var parts = WAP.core.CARGO_REAL.filter(function (k) { return counts[k]; })
      .map(function (k) { return kindInfo(k).n.replace('货物', '') + ' ' + counts[k]; });
    var txt = (c === 'mix' ? '混放' : '全部') + ' ' + total + ' 位在库 · ' + parts.join(' / ');
    if (WAP.state.cargoCustom) txt += ' · ' + WAP.state.cargoCustom + ' 位单独指定';
    $('cargoSummary').textContent = txt;
  }

  /* ---------- 侧栏停靠：库体概览 ↔ 控制面板 ---------- */
  var dockState = { cell: false, dev: false };
  var DOCK_IDS = ['ctxPanel', 'devPanel', 'selCard'];
  function setupDock() {
    var host = $('sideDock');
    if (!host) return;
    DOCK_IDS.forEach(function (id) {
      var el = $(id);
      if (el && el.parentNode !== host) host.appendChild(el);
    });
    syncDock();
  }
  /* 选中任何物体后：隐藏库体概览，同位置显示对应控制面板；
     没有选中时恢复库体概览。优先级：整体浮层 > 设备控制面板 > 货位信息。 */
  function syncDock() {
    var host = $('sideDock');
    if (!host) return;
    var want = {
      ctxPanel: !!ctxState.open,
      devPanel: !!dockState.dev,
      selCard: !!dockState.cell
    };
    var any = want.ctxPanel || want.devPanel || want.selCard;
    $('cardOverview').hidden = any;
    host.hidden = !any;
    DOCK_IDS.forEach(function (id) {
      var el = $(id);
      if (el) el.hidden = !want[id];
    });
    /* 选中设备时：控制面板下方常驻显示「设备面板」目录（列表已移到库体概览折叠区）。
       设备面板被上下文浮层占用时不干预；「全部展开」时保持可见。 */
    var eq = $('cardEquip');
    if (eq && eq.parentNode !== $('ctxBody')) {
      eq.hidden = ctxState.all ? false : !dockState.dev;
    }
  }
  function showDeviceDock(on) { dockState.dev = !!on; syncDock(); }

  /* ---------- 货位信息 ---------- */
  function showCell(id) {
    var c = WAP.state.cfg, g = WAP.state.geom;
    var cell = g.cells.filter(function (o) { return o.id === id; })[0];
    var card = $('selCard');
    if (!cell) { dockState.cell = false; syncDock(); return; }
    dockState.cell = true;
    syncDock();
    var conv = cell.conv >= 0;
    var lift = conv ? g.liftSites[cell.conv] : null;
    $('selTitle').textContent = conv ? '层间输送线接驳位' : (cell.chg ? '充电区' : '货位信息');
    var rows = [
      ['层', 'L' + (cell.l + 1) + ' / ' + c.levels],
      ['子通道', 'B' + (cell.i + 1) + (conv ? ' · 提升机口' : '')],
      ['储区', 'Z' + (cell.b + 1)],
      ['深度序', 'D' + (cell.k + 1)],
      ['坐标', cell.x.toFixed(1) + ', ' + cell.z.toFixed(1)],
      ['对接设备', conv && lift ? lift.name : (cell.chg ? '充电桩' : '—')],
      ['货物', conv ? '层间输送线（不放货）' : (cell.chg ? '充电位' : (cell.occ ? WAP.core.CARGO_NAME[WAP.rack.cargoKindOf(cell)] : '—'))],
      ['状态', conv ? '货物静置 · 待四向车接驳' : (cell.chg ? '充电位' : (cell.occ ? '已占用' : '空闲'))]
    ];
    $('selBody').innerHTML = rows.map(function (r) {
      return '<div class="kv"><span>' + r[0] + '</span><b>' + r[1] + '</b></div>';
    }).join('');
    $('selToggle').style.display = (cell.chg || conv) ? 'none' : '';
    $('selKindWrap').style.display = (cell.chg || conv) ? 'none' : '';
    $('selClassWrap').style.display = (cell.chg || conv) ? 'none' : '';
    $('selKind').value = WAP.state.cargoOverrides[cell.id] || 'auto';
    $('selClass').value = WAP.state.cargoClassOverrides[cell.id] || 'auto';
    syncCellPitch();
    $('sbSel').textContent = conv ? (lift ? lift.name + ' · 层间输送线接驳位' : '层间输送线接驳位')
      : ('货位 L' + (cell.l + 1) + ' · B' + (cell.i + 1) + ' · Z' + (cell.b + 1) + ' · ' + (cell.occ ? '占用' : '空闲'));
  }
  function hideCell() {
    dockState.cell = false;
    syncDock();
    $('sbSel').textContent = WAP.state.selection.rack ? '已选中四向库（晶格已显示）' : '未选中对象';
  }

  /* 货位轴距：显示值取当前模型实际格距（自适应），改动后写回配置并即时重排 */
  function syncCellPitch() {
    var g = WAP.state.geom, c = WAP.state.cfg;
    var x = $('selPitchX'), z = $('selPitchZ'), m = $('selPitchMode');
    if (!g || !x || !z) return;
    if (D.activeElement !== x) x.value = (g.lw || 1.4).toFixed(2);
    if (D.activeElement !== z) z.value = (g.dw || 1.05).toFixed(2);
    if (m) {
      var manual = c.cellAuto === false;
      m.textContent = manual ? '手动' : '自适应';
      m.classList.toggle('is-manual', manual);
    }
  }
  function applyCellPitch(useAuto) {
    var x = $('selPitchX'), z = $('selPitchZ');
    if (!x || !z) return;
    var c = useAuto
      ? WAP.core.setCellPitch(WAP.state.cfg, null, null)
      : WAP.core.setCellPitch(WAP.state.cfg, +x.value, +z.value);
    var err = WAP.core.validate(c);
    if (err) { toast(err); syncCellPitch(); return; }
    WAP.state.cfg = c;
    WAP.app.commit(true);
    syncCellPitch();
    toast(useAuto
      ? '货位轴距已恢复自适应 · ' + c.cellPitchX.toFixed(2) + ' × ' + c.cellPitchZ.toFixed(2) + ' m'
      : '货位轴距 → 横向 ' + c.cellPitchX.toFixed(2) + ' m · 纵向 ' + c.cellPitchZ.toFixed(2) + ' m（手动）');
  }
  function bindCell() {
    $('selClose').addEventListener('click', function () {
      WAP.state.selection.cell = null;
      WAP.rack.applyView(); hideCell();
    });
    ['selPitchX', 'selPitchZ'].forEach(function (id) {
      var el = $(id);
      if (el) el.addEventListener('change', function () { applyCellPitch(false); });
    });
    if ($('selPitchAuto')) {
      $('selPitchAuto').addEventListener('click', function () { applyCellPitch(true); });
    }
    $('selToggle').addEventListener('click', function () {
      var id = WAP.state.selection.cell;
      if (!id) return;
      var cell = WAP.state.geom.cells.filter(function (o) { return o.id === id; })[0];
      if (!cell || cell.chg || cell.conv >= 0) return;   // 输送线 / 充电位不可存货
      WAP.rack.setOverride(id, !cell.occ);
      WAP.app.commit(true);
      showCell(id);
      toast(cell.occ ? '货位已置为空闲' : '货位已置为占用');
    });
  }

  /* ---------- 配置存取 ---------- */
  function bindConfig() {
    /* 项目配置面板依需求已移除；配置仍自动持久化，此处仅在面板存在时绑定 */
    if (!$('btnExport')) return;
    $('btnExport').addEventListener('click', function () {
      var txt = JSON.stringify(WAP.state.cfg, null, 2);
      $('cfgText').value = txt;
      try {
        if (navigator.clipboard) navigator.clipboard.writeText(txt);
      } catch (e) { /* ignore */ }
      toast('配置已导出到文本框（并尝试复制到剪贴板）');
    });
    $('btnImport').addEventListener('click', function () {
      try {
        var o = JSON.parse($('cfgText').value);
        var c = core.normalize(o);
        var err = core.validate(c);
        if (err) { toast(err); return; }
        WAP.state.cfg = c;
        WAP.state.overrides = {};
        WAP.state.cargoOverrides = {};
        core.saveCargoOverrides(WAP.state.cargoOverrides);
        WAP.app.commit();
        toast('配置导入成功');
      } catch (e) { toast('配置解析失败：请检查 JSON 格式'); }
    });
    $('btnReset').addEventListener('click', function () {
      WAP.state.cfg = core.clone(core.DEFAULT);
      WAP.state.overrides = {};
      WAP.state.cargoOverrides = {};
      core.saveCargoOverrides(WAP.state.cargoOverrides);
      WAP.app.commit();
      toast('已恢复默认配置');
    });
  }

  /* ---------- 运行仿真 ---------- */
  function bindSim() {
    var toggle = function () { WAP.sim.toggle(); };
    $('simPlay').addEventListener('click', toggle);
    /* 顶栏「运行仿真」改为打开运行仿真控制面板（不再直接播放） */
    $('btnSim').addEventListener('click', function () {
      WAP.ctx.nav('sim');
      $('navControl').open = false;     // 打开面板即可，下拉不遮挡右侧
      toast('已打开「运行仿真」控制面板');
    });
    /* 「单步」按钮已按用户要求删除；stepOnce 仍保留供键盘 o 调用 */
    $('simStop').addEventListener('click', function () { WAP.sim.stop(); toast('仿真已复位'); });
    $('simDevices').addEventListener('click', function (e) {
      var d = e.target.closest('.sim-dev');
      if (d && d.dataset.dev) WAP.sim.focus(d.dataset.dev);
    });
    $('simSpeed').querySelectorAll('[data-sp]').forEach(function (b) {
      b.addEventListener('click', function () { WAP.sim.setSpeed(+b.dataset.sp); });
    });
    $('simMode').querySelectorAll('[data-mode]').forEach(function (b) {
      b.addEventListener('click', function () { WAP.sim.setMode(b.dataset.mode); });
    });
    /* 返程循环：默认关闭，货物到终点静止；开启后原路返回。
       运行仿真面板与输送线路线设计面板共用同一个开关状态。 */
    $('simLoop').addEventListener('click', function () {
      var on = WAP.flow ? WAP.flow.toggleLoop() : false;
      syncLoopUI();
      toast(on ? '已开启返程循环 · 货物到终点后原路返回' : '已关闭返程循环 · 货物到终点后静止');
    });
  }
  /* 两处循环按钮 + 提示同步刷新 */
  function syncLoopUI() {
    var on = !!(WAP.flow && WAP.flow.loop);
    var a = $('simLoop');
    if (a) {
      a.textContent = on ? '⇄ 返程循环：开' : '⇄ 返程循环：关';
      a.classList.toggle('is-on', on);
      a.setAttribute('aria-pressed', String(on));
    }
    var tip = $('simLoopTip');
    if (tip) tip.textContent = on
      ? '已开启：货物到达输送线终点后沿原路线返回'
      : '默认货物到终点后静止；开启后原路返回';
    if (WAP.routes && WAP.routes.syncLoopUI) WAP.routes.syncLoopUI();
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (m) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m];
    });
  }

  /* 任务日志依需求已从界面移除，保留空实现以兼容内部调用 */
  function simLog(logs) {
    var el = $('simLogs');
    if (!el) return;
    el.innerHTML = logs.slice(0, 14).map(function (o) {
      return '<div class="sim-log k-' + o.kind + '"><time>' + o.t + '</time><span>' + esc(o.text) + '</span></div>';
    }).join('');
  }

  function simUpdate(s) {
    var on = !!s.playing;
    $('simPlay').textContent = on ? '⏸ 暂停' : '▶ 播放';
    $('simPlay').classList.toggle('is-on', on);
    $('simPlay').setAttribute('aria-pressed', String(on));
    /* 顶栏按钮现在只负责「打开运行仿真控制面板」，运行中仅高亮 */
    $('btnSim').classList.toggle('is-on', on);
    $('btnSim').setAttribute('aria-pressed', String(on));
    $('simPill').textContent = on ? '运行中' : '已暂停';
    $('simPill').classList.toggle('is-run', on);

    $('simSpeed').querySelectorAll('[data-sp]').forEach(function (b) {
      b.classList.toggle('is-on', +b.dataset.sp === s.speed);
    });
    $('simMode').querySelectorAll('[data-mode]').forEach(function (b) {
      b.classList.toggle('is-on', b.dataset.mode === s.mode);
    });

    $('simClock').textContent = s.clock;
    /* 守恒作业口径：不再显示凭空出/入库数，改显示「送达线终点 / 层间调拨」 */
    var fs = WAP.flow && WAP.flow.snapshot ? WAP.flow.snapshot() : null;
    if (fs) {
      $('simIn').textContent = fs.delivered;
      $('simOut').textContent = fs.relocated;
      var lab = $('simStatsLabel');
      var ts = WAP.terminals && WAP.terminals.snapshot ? WAP.terminals.snapshot() : null;
      if (lab) lab.textContent = fs.open
        ? ('收发器模式 · 总量不守恒（发货 +' + (ts ? ts.emitted : 0) +
           ' / 收货 −' + (ts ? ts.received : 0) + '）' + (ts && ts.blocked ? ' · 终点已满暂停吐货' : ''))
        : '守恒作业 · 货物总量 ' + fs.total + ' 件恒定';
      var i1 = $('simInLabel'), i2 = $('simOutLabel');
      if (i1) i1.textContent = fs.open ? '发货器吐出' : '送达线终点';
      if (i2) i2.textContent = fs.open ? '收货器收走' : '层间调拨';
      if (fs.open && ts) {
        $('simIn').textContent = ts.emitted;
        $('simOut').textContent = ts.received;
        $('simRate').textContent = ts.alive;
      } else $('simRate').textContent = fs.lineEndCargo + '/' + fs.lineCap;
      var r3 = $('simRateLabel');
      if (r3) r3.textContent = fs.open ? '场景在途/停留' : '线终点存量';
    } else {
      $('simIn').textContent = s.inb;
      $('simOut').textContent = s.outb;
      $('simRate').textContent = s.rate.toFixed(0) + '%';
    }
    $('simThru').textContent = s.thru;
    $('simSub').textContent = '平均周期 ' + (s.avg ? s.avg.toFixed(1) + ' s' : '—') +
      ' · 作业中 ' + s.active + ' 台 · 在库 ' + s.used + '/' + s.slots + ' · 点设备可聚焦';
    $('simDevCount').textContent = s.devices.length + ' 台四向车 / ' + s.lifts.length + ' 台提升机';

    /* 设备状态栏：完整显示设备名称 + 编号 + 所属层 / 子通道口 + 作业状态，不省略 */
    var html = s.devices.map(function (d) {
      var idle = d.task === '—';
      var sub = d.st + (idle ? '' : ' → ' + d.task) + (d.carry ? ' · 载货中' : '');
      return '<div class="sim-dev' + (idle ? ' is-idle' : '') + '" data-dev="' + esc(d.id) +
        '" title="点击聚焦 ' + esc(d.name) + '"><i></i><div class="dv-body">' +
        '<div class="dv-main"><b>' + esc(d.name) + '</b><em>' + esc(d.level) + '</em></div>' +
        '<span>' + esc(sub) + '</span></div></div>';
    }).join('');
    html += s.lifts.map(function (l) {
      var sub = l.st + ' · ' + l.level + ' · ' + l.y.toFixed(1) + ' m' +
        (l.queue ? ' · 待处理请求 ' + l.queue : '');
      return '<div class="sim-dev is-lift' + (l.st === '待机' ? ' is-idle' : '') +
        '" data-dev="' + esc(l.id) + '" title="点击聚焦 ' + esc(l.name) + '"><i></i><div class="dv-body">' +
        '<div class="dv-main"><b>' + esc(l.name) + '</b><em>' + esc(l.col) + '</em></div>' +
        '<span>' + esc(sub) + '</span></div></div>';
    }).join('');
    $('simDevices').innerHTML = html;

    var strip = $('simStrip');
    strip.hidden = !on;
    $('viewportTip').classList.toggle('hide', on);
    if (on) {
      var cur = s.devices.filter(function (d) { return d.task !== '—'; })[0];
      $('ssTask').textContent = cur ? (cur.name + '（' + cur.level + '）· ' + cur.st + ' → ' + cur.task) : '设备待机 · 等待新任务';
      $('ssClock').textContent = s.clock;
      $('ssRate').textContent = '在库率 ' + s.rate.toFixed(1) + '% · ' + s.thru + ' 板/H';
    }
  }

  /* ---------- 上下文浮动控制面板 ----------
     右侧不再堆一长串面板：第一次点模型弹出「整体建构 + 运行仿真」，
     再点具体个体弹出对应控制卡。控制卡直接复用右侧栏的 DOM 节点，
     所以功能与右侧栏完全等价（包含全部控制选项）。 */
  var PANEL_MAP = {
    rack:      { ids: ['cardQuick'], title: '整体模型 · 晶格控制', sub: '快速建构长宽高', foot: '再次点击模型可选中具体个体 · 点击空白处关闭' },
    sim:       { ids: ['cardSim'], title: '运行仿真', sub: '守恒作业 · 设备状态 · 返程循环', foot: '顶栏「运行仿真」或导航「控制 → 运行仿真」均可打开' },
    cargo:     { ids: ['cardCargo'], title: '货位货物', sub: '切换六种货物贴图 · 单货位设置', foot: '点击其它货物 / 货架 / 设备可切换面板' },
    cell:      { ids: ['cardCargo'], title: '货位货物', sub: '切换六种货物贴图 · 单货位设置', foot: '点击其它货物 / 货架 / 设备可切换面板' },
    structure: { ids: ['cardStructure'], title: '结构参数', sub: '库体结构全项设置', foot: '点击空白处关闭' },
    frame:     { ids: ['cardStructure'], title: '货架结构', sub: '立柱 / 横梁 / 轨道全项参数', foot: '点击空白处关闭' },
    device:    { ids: ['cardDevice'], title: '设备与效率', sub: '四向车 / 提升机 / 效率全项', foot: '点击空白处关闭' },
    shuttle:   { ids: ['cardShuttle', 'cardDevice'], title: '四向穿梭车', sub: '换颜色 · 结构贴图不变', foot: '点击色板换色 · 点击空白处关闭' },
    lift:      { ids: ['cardDevice'], title: '提升机', sub: '设备与效率全项设置', foot: '点击空白处关闭' },
    conveyor:  { ids: ['cardDevice'], title: '层间输送设备', sub: '设备与效率全项设置', foot: '点击空白处关闭' },
    visual:    { ids: ['cardVisual'], title: '货物与外观', sub: '货物尺寸 / 立柱 / 安全网', foot: '点击空白处关闭' },
    equip:     { ids: ['cardEquip'], title: '设备面板', sub: '全部输送设备 · 摆放与编辑', foot: '点设备目录即可摆放 · 点击已摆放设备进入控制面板' },
    routes:    { ids: ['cardRoutes'], title: '输送线路线设计', sub: '起点 → 中间路径(可选) → 终点 · 无直达设备则掉落', foot: '采点时点击设备 / 货物 / 空白网格 · 人物与叉车设备后续设计' }
  };
  var PANEL_ORDER = ['cardSim', 'cardQuick', 'cardCargo', 'cardStructure', 'cardDevice',
    'cardVisual', 'cardShuttle', 'cardEquip', 'cardRoutes'];
  var PANEL_TAB = {
    cardQuick: '快速建构 · 晶格', cardSim: '运行仿真', cardCargo: '货位货物',
    cardStructure: '结构参数', cardDevice: '设备与效率', cardVisual: '货物与外观',
    cardShuttle: '四向车换色', cardEquip: '设备面板', cardRoutes: '路线设计'
  };
  var ctxState = { open: false, type: null, all: false };

  function panelEls() {
    return PANEL_ORDER.map(function (id) { return $(id); }).filter(Boolean);
  }
  function restorePanels() {
    var body = $('ctxBody'), home = $('panelScroll');
    Array.prototype.slice.call(body.children).forEach(function (el) {
      el.hidden = true;
      home.appendChild(el);
    });
    /* 按固定顺序归位，保持侧栏展开时顺序稳定 */
    PANEL_ORDER.forEach(function (id) {
      var el = $(id);
      if (el && el.parentNode === home) home.appendChild(el);
    });
  }
  function syncNav(type) {
    $('sideNav').querySelectorAll('[data-panel]').forEach(function (b) {
      var on = ctxState.all ? b.dataset.panel === 'all' : (!!type && b.dataset.panel === type);
      b.classList.toggle('is-on', on);
    });
  }
  function placeCtx(screen) {
    /* 面板已停靠到侧栏「库体概览」位置，不再做视口内的绝对定位 */
    if ($('sideDock') && $('sideDock').contains($('ctxPanel'))) return;
    var vp = $('viewport'), panel = $('ctxPanel');
    var vw = vp.clientWidth, vh = vp.clientHeight;
    var w = panel.offsetWidth || 318, h = panel.offsetHeight || 420;
    var maxL = Math.max(12, vw - w - 12);
    var left, top;
    if (!screen) {
      /* 侧栏导航触发：贴视口右边缘、避开顶栏，尽量不压住模型中心 */
      left = maxL - 2;
      top = 58;
    } else {
      /* 点击模型触发：向点击点外侧展开，保证不盖住被选中的那个位置 */
      var x = screen.x, y = screen.y;
      left = x < vw * 0.5 ? x - w - 30 : x + 30;
      if (left + w > vw - 12) left = x - w - 30;
      if (left < 12) left = x + 30;
      left = core.clamp(left, 12, maxL);
      top = core.clamp(y - 46, 12, Math.max(12, vh - h - 12));
    }
    top = core.clamp(top, 12, Math.max(12, vh - h - 12));
    panel.style.left = left + 'px';
    panel.style.top = top + 'px';
  }
  function closeCtx(keepNav) {
    restorePanels();
    $('ctxTabs').hidden = true;
    $('ctxPanel').hidden = true;
    ctxState.open = false; ctxState.type = null;
    if (!keepNav) { ctxState.all = false; syncNav(null); }
    if (ctxState.all) $('cardOverview').hidden = false;
    syncDock();
  }
  function openCtx(type, screen) {
    var cfgp = PANEL_MAP[type] || PANEL_MAP.rack;
    closeCtx(true);
    ctxState.all = false;
    panelEls().forEach(function (el) { el.hidden = true; });
    var body = $('ctxBody'), tabs = $('ctxTabs');
    var multi = cfgp.ids.length > 1;
    if (multi) {
      /* 整体模型面板把「快速建构」与「运行仿真」融进同一个浮层，用页签切换 */
      tabs.innerHTML = cfgp.ids.map(function (id, i) {
        return '<button type="button" data-card="' + id + '"' + (i === 0 ? ' class="is-on"' : '') +
          '>' + (PANEL_TAB[id] || id) + '</button>';
      }).join('');
      tabs.hidden = false;
      tabs.onclick = function (e) {
        var b = e.target && e.target.closest ? e.target.closest('[data-card]') : null;
        if (!b) return;
        var pickId = b.getAttribute('data-card');
        Array.prototype.slice.call(tabs.querySelectorAll('[data-card]')).forEach(function (x) {
          if (x.getAttribute('data-card') === pickId) x.classList.add('is-on');
          else x.classList.remove('is-on');
        });
        cfgp.ids.forEach(function (id) { var el = $(id); if (el) el.hidden = id !== pickId; });
        placeCtx(screen);
      };
    } else {
      tabs.hidden = true; tabs.innerHTML = ''; tabs.onclick = null;
    }
    cfgp.ids.forEach(function (id, i) {
      var el = $(id);
      if (!el) return;
      el.hidden = multi && i !== 0;
      el.querySelectorAll('details').forEach(function (d) { d.open = true; });
      body.appendChild(el);
    });
    $('ctxTitle').textContent = cfgp.title;
    $('ctxSub').textContent = cfgp.sub;
    $('ctxFoot').textContent = cfgp.foot;
    $('ctxPanel').hidden = false;
    placeCtx(screen);
    ctxState.open = true; ctxState.type = type;
    syncNav(type);
    syncDock();
  }
  function navCtx(name) {
    if (name === 'all') {
      var wasAll = ctxState.all;
      closeCtx();
      ctxState.all = !wasAll;
      panelEls().forEach(function (el) {
        el.hidden = !ctxState.all;
        if (ctxState.all) el.querySelectorAll('details').forEach(function (d) { d.open = true; });
      });
      syncNav(ctxState.all ? 'all' : null);
      $('cardOverview').hidden = false;
      syncDock();
      return;
    }
    ctxState.all = false;
    openCtx(name, null);
  }
  function bindCtx() {
    $('ctxClose').addEventListener('click', function () { closeCtx(); });
    $('sideNav').addEventListener('click', function (e) {
      var b = e.target.closest('[data-panel]');
      if (b) {
        navCtx(b.dataset.panel);
        $('navControl').open = false;    // 选中具体选项后收起折叠
      }
    });
  }

  WAP.ctx = {
    open: openCtx, close: closeCtx, nav: navCtx,
    get isOpen() { return ctxState.open; },
    get type() { return ctxState.type; },
    get all() { return ctxState.all; }
  };

  /* ---------- 刷新 ---------- */
  function refresh() {
    var c = WAP.state.cfg, g = WAP.state.geom;
    if (!g) return;
    var qv = quickValues();
    Q.forEach(function (q) {
      var v = qv[q.key];
      $(q.val).textContent = v.n;
      $(q.dim).textContent = v.dim;
      $(q.sub).textContent = v.sub;
      var r = $(q.rng);
      if (+r.value !== v.n && D.activeElement !== r) r.value = v.n;
    });
    syncCargoClasses();
    var s = core.stats(c, g);
    $('stSlots').textContent = s.slots.toLocaleString('zh-CN');
    $('stUsed').textContent = s.used.toLocaleString('zh-CN');
    $('stRate').textContent = s.rate.toFixed(1);
    $('stLifts').textContent = s.lifts;
    $('rateBar').style.width = s.rate.toFixed(1) + '%';
    $('stDim').textContent = g.len.toFixed(1) + ' × ' + g.tot.toFixed(1) + ' × ' + g.top.toFixed(1) + ' m';
    $('stThru').textContent = Math.round(s.thru.sys) + ' 板/H（瓶颈：' + s.thru.bott + '）';
    $('stBott').textContent = s.thru.bott + ' · 周期 ' + s.thru.cyc.toFixed(1) + ' s';
    $('stShuttle').textContent = s.shuttles + ' 台（每层 ' + c.perLevel + ' 台 · 固定层）';
    /* 客户最关心的货位 / 层高 / 承载信息 */
    var setOv = function (id, text) { var el = $(id); if (el) el.textContent = text; };
    setOv('ovCell', (g.lw || c.bayW).toFixed(2) + ' × ' + (g.dw || c.dp).toFixed(2) + ' m' +
      (c.cellAuto === false ? '（手动）' : ''));
    setOv('ovLoadH', (g.loadH || 0).toFixed(2) + ' m 净空');
    setOv('ovPitch', c.pitch.toFixed(2) + ' m / 层');
    setOv('ovLevels', c.levels + ' 层');
    setOv('ovY0', c.y0.toFixed(2) + ' m');
    setOv('ovPallet', c.loadMM + ' mm · ' + c.kg + ' kg');
    setOv('ovAisles', c.aisles + ' 条主通道 / ' +
      ((g.blocks || []).length || (c.depths || []).length) + ' 个储区');
    var matched = ((g.liftSites || []).filter(function (o) { return o.matched !== false; })).length;
    setOv('ovConv', matched + ' 组 · 末端对接主通道');
    syncCellPitch();
    syncFields();
    refreshAddMenu();
    syncCargo();
  }

  function init() {
    setupDock();
    buildFields();
    buildCargo();
    buildCargoClasses();
    buildShuttleColors();
    bindQuick();
    bindView();
    bindMode();
    bindCell();
    bindConfig();
    bindCtx();
    bindSim();
    WAP.scene.S.onFrame = function (fps) {
      $('sbFps').textContent = fps + ' FPS';
      $('sbCam').textContent = WAP.scene.camText();
    };
    setModeUI('rotate');
  }

  WAP.ui = {
    init: init, refresh: refresh, toast: toast, showCell: showCell, hideCell: hideCell,
    showDeviceDock: showDeviceDock, syncDock: syncDock,
    setModeUI: setModeUI, cameraMode: cameraMode, setCargoKind: setCargoKind, syncCargo: syncCargo,
    setCargoClass: setCargoClass, syncCargoClasses: syncCargoClasses,
    showShuttlePanel: showShuttlePanel, syncShuttleColors: syncShuttleColors,
    simUpdate: simUpdate, simLog: simLog, syncLoopUI: syncLoopUI
  };
})(window);
