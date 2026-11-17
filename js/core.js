/* WAP-Eavan · core.js
   四向穿梭车立体库的数据模型。
   吸收参考平台模组 G 的参数体系（CFG_DEF / gGeom / gThru / cfgError）后重新实现，
   保持参数语义与几何算法一致，代码为全新编写。 */
(function (global) {
  'use strict';
  var WAP = global.WAP = global.WAP || {};

  /* 主巷道宽与横向通道宽（m），与参考平台一致 */
  var AW = 1.6, CAW = 1.6;
  var STORE_KEY = 'wap-eavan.config.v1';
  var CARGO_OV_KEY = 'wap-eavan.cargo-overrides.v1';
  var CLASS_OV_KEY = 'wap-eavan.cargo-class-overrides.v1';
  var SHUTTLE_COLOR_KEY = 'wap-eavan.shuttle-colors.v1';
  var SH_TINTS = ['blue', 'red', 'green', 'orange', 'purple', 'silver', 'graphite', 'yellow'];

  /* 货位货物种类：全局默认 + 单货位可覆盖。
     mix 为智能混放（按货位稳定散列分配到下列实体种类）。 */
  var CARGO_KINDS = [
    { k: 'mix', n: '智能混放', d: '多种货物混合陈列', sw: '#8b7cf6' },
    { k: 'carton', n: '纸箱货物', d: '印刷瓦楞箱 / 缠膜箱', sw: '#b9823f' },
    { k: 'metal', n: '金属箱货物', d: '镀锌钢制周转箱', sw: '#8f9db0' },
    { k: 'sack', n: '散货包货物', d: '麻布包多层堆叠', sw: '#c3a166' },
    { k: 'foam', n: '泡沫箱货物', d: 'EPS 冷链保温箱', sw: '#dbe7f2' },
    { k: 'crate', n: '塑料料箱', d: '蓝色模压料箱', sw: '#2b5fc4' }
  ];
  var CARGO_KEYS = CARGO_KINDS.map(function (o) { return o.k; });
  var CARGO_REAL = CARGO_KEYS.filter(function (k) { return k !== 'mix'; });
  var CARGO_NAME = {};
  CARGO_KINDS.forEach(function (o) { CARGO_NAME[o.k] = o.n; });

  /* 货物「大类」：按「是否带货 + 是否带子托盘 + 是否带母托盘」组合区分，
     与货物外观种类（纸箱/金属/麻布…）正交。共 7 类：
     goods 仅货物 / goodsSub 货物+子托 / goodsCombo 货物+子托+母托 /
     sub 子托 / mother 母托 / subMother 子托+母托 / empty 空（不显示）。
     旧存档 key 别名：single→goods、combo→goodsCombo。 */
  var CARGO_CLASSES = [
    { k: 'goods',      n: '货物',             d: '单件货物 · 不带托盘',            sw: '#7b8ba3', goods: 1, sub: 0, mother: 0 },
    { k: 'goodsSub',   n: '货物+子托盘',       d: '货物 + 棕色子托盘',              sw: '#a9824a', goods: 1, sub: 1, mother: 0 },
    { k: 'goodsCombo', n: '货物+子托盘+母托盘', d: '货物 + 子托盘 + 银色母托盘',      sw: '#b0803f', goods: 1, sub: 1, mother: 1 },
    { k: 'sub',        n: '子托盘',           d: '无货物 · 仅棕色子托盘',          sw: '#a9763c', goods: 0, sub: 1, mother: 0 },
    { k: 'mother',     n: '母托盘',           d: '无货物 · 仅银色母托盘',          sw: '#c8d2dc', goods: 0, sub: 0, mother: 1 },
    { k: 'subMother',  n: '子托盘+母托盘',     d: '无货物 · 子托盘叠在母托盘上',      sw: '#b9a98c', goods: 0, sub: 1, mother: 1 },
    { k: 'empty',      n: '空',               d: '空货位 · 不显示任何货物或托盘',   sw: '#e3e8ef', goods: 0, sub: 0, mother: 0 }
  ];
  var CARGO_CLASS_ALIAS = { single: 'goods', combo: 'goodsCombo' };
  var CARGO_CLASS_KEYS = CARGO_CLASSES.map(function (o) { return o.k; });
  var CARGO_CLASS_DEF = {};
  CARGO_CLASSES.forEach(function (o) { CARGO_CLASS_DEF[o.k] = o; });
  var CARGO_CLASS_NAME = {};
  CARGO_CLASSES.forEach(function (o) { CARGO_CLASS_NAME[o.k] = o.n; });

  /* 模组 G 完整参数定义 */
  var DEFAULT = {
    name: '四向库 A 区',
    cargoType: 'mix',        // 货位货物种类（见 CARGO_KINDS）
    cargoClass: 'goods',     // 货物大类（见 CARGO_CLASSES）：7 种货物/托盘组合
    shuttleColor: 'blue',    // 四向车默认车身色（结构贴图不变，只换主色）
    aisles: 2,               // 主巷道（主轨道）数 1-4
    bayGroups: [6, 6],       // BAY 分段；段与段之间留横向通道
    levels: 6,               // 层数 2-12
    depths: [1, 4, 1],       // 各储区深度（板），长度须为 aisles+1
    mid: 'split',            // 中间储区存取：split 两侧各半 / full 整排单侧
    y0: 1.0,                 // 一楼梁面高 m
    pitch: 1.25,             // 层距 m
    bayW: 1.4,               // BAY 宽 m（= 货位横向轴距，由 cellPitchX 派生）
    gap: 50,                 // 托盘间距 mm（dp = 1.0 + gap/1000）
    cellAuto: true,          // 货位轴距：true＝依据货架模型自适应；false＝人工设定
    cellPitchX: 1.40,        // 货位横向（X）轴距 m
    cellPitchZ: 1.05,        // 货位纵向（Z）轴距 m
    liftRate: 45,            // 单台提升机存取速率 板/H
    need: 0,                 // 目标吞吐量 板/H，0＝不设
    loadMM: 770,             // 货高（含栈板）mm
    kg: 800,                 // 单板载重 kg
    fill: 52,                // 初始在库率 %（按存放优先级整齐排布，避免塞满、挡住行车路线）
    cargoCount: -1,          // 货物总数：-1=沿用 fill 百分比；≥0=按件数分布
    cargoRandom: false,      // 随机分布开关（固定 seed，重建稳定）
    cargoReserve: 1,         // 随机分布时每条子通道至少预留空格数（保证四向车可通行）
    cargoSeed: 20261117,     // 随机分布固定种子
    cargoMainClear: true,    // 主通道相邻格必空（硬性行车通道）
    split: 3,                // 下层纸箱层数（视觉区分）
    liftN: 4,                // 提升机台数：均匀分布于前端子通道口，非每条子通道一台
    liftCols: null,          // 设备面板维护的提升机布局：{id,i}[], i=BAY 列；null=均匀分配
    liftCfg: {},             // 每台提升机：{lv:层数, boost:加高, matched:已匹配层间输送线}
    perLevel: 1,             // 每层四向车台数（固定层作业，至少 1 台）
    upr: 'blue',             // 立柱颜色
    netSide: 'none',         // 安全网：none / side / back / both（默认关闭，保证首屏模型清晰）
    netH: 'full',            // 网高：full / 3m
    vE: 256,                 // 空载速度 cm/s
    vL: 160,                 // 负载速度 cm/s
    physicsMode: true,       // 物理规则仿真：默认开启真实物理（质量插值/换向/顶升/避让/超载）
    simPreset: 'real',       // 参数档：默认 real 真实 FWS-H150 厂家参数（demo 为快节奏演示对比档）
    lowR: [1, 3],            // 下层（固定层）范围
    lowN: 3,                 // 下层穿梭车台数
    highR: [4, 6],           // 上层（跨层）范围，null＝不设
    highN: 2,                // 上层穿梭车台数
    chg: true,               // 充电展示区
    shW: 95,                 // 四向车宽 cm
    shL: 110                 // 四向车长 cm
  };

  var clone = function (o) { return JSON.parse(JSON.stringify(o)); };
  var clamp = function (v, a, b) { return Math.max(a, Math.min(b, v)); };
  var clampInt = function (v, a, b) { return clamp(Math.round(Number(v) || a), a, b); };

  /* 把 n 分配到 k 个段，尽量保持原比例，每段 [lo,hi] */
  function distribute(n, arr, lo, hi) {
    var k = arr.length;
    n = clampInt(n, lo * k, hi * k);
    var sum = arr.reduce(function (a, b) { return a + b; }, 0) || k;
    var out = arr.map(function (v) { return Math.max(lo, Math.round(n * v / sum)); });
    var guard = 0;
    while (out.reduce(function (a, b) { return a + b; }, 0) !== n && guard++ < 200) {
      var cur = out.reduce(function (a, b) { return a + b; }, 0);
      var idx = -1, best = -1e9;
      for (var i = 0; i < k; i++) {
        var room = cur < n ? (hi - out[i]) : (out[i] - lo);
        if (room > 0 && room > best) { best = room; idx = i; }
      }
      if (idx < 0) break;
      out[idx] += cur < n ? 1 : -1;
    }
    return out.map(function (v) { return clamp(v, lo, hi); });
  }

  /* 宽度（排数）拉伸：两端储区是「提升机口 + 层间输送线」接驳区，
     恒为 1 个货位网格，主通道紧贴其后；排数变化全部优先落在中间储区。
     只有中间储区到顶后才把富余量分给两端（此时输送线仍只占 1 格）。
     只有 2 个储区（无中间段）时退化为原按比例分配。 */
  function distributeWidth(n, arr, lo, hi) {
    var k = arr.length;
    n = clampInt(n, lo * k, hi * k);
    if (k < 3) return distribute(n, arr, lo, hi);
    var out = arr.slice();
    out[0] = lo; out[k - 1] = lo;
    var midIdx = [], i;
    for (i = 1; i < k - 1; i++) midIdx.push(i);
    var midArr = midIdx.map(function (q) { return arr[q]; });
    var rest = n - lo * 2;
    var midN = clampInt(rest, lo * midIdx.length, hi * midIdx.length);
    var midOut = distribute(midN, midArr, lo, hi);
    midIdx.forEach(function (q, j) { out[q] = midOut[j]; });
    var sum = function () { return out.reduce(function (a, b) { return a + b; }, 0); };
    var left = n - sum(), guard = 0;
    while (left > 0 && guard++ < 400) {
      var idx = -1, best = -1e9;
      for (i = 0; i < k; i++) {
        var room = hi - out[i];
        if (room > 0 && room > best) { best = room; idx = i; }
      }
      if (idx < 0) break;
      out[idx] += 1; left -= 1;
    }
    while (left < 0 && guard++ < 800) {
      var idx2 = -1, best2 = -1e9;
      for (i = 0; i < k; i++) {
        var room2 = out[i] - lo;
        if (room2 > 0 && room2 > best2) { best2 = room2; idx2 = i; }
      }
      if (idx2 < 0) break;
      out[idx2] -= 1; left += 1;
    }
    return out.map(function (v) { return clampInt(v, lo, hi); });
  }

  function fixDepths(c) {
    var need = c.aisles + 1;
    var d = (c.depths || []).slice();
    if (!d.length) d = [1, 4, 1];
    while (d.length < need) d.splice(Math.max(1, Math.floor(d.length / 2)), 0, 4);
    while (d.length > need) d.splice(Math.max(1, Math.floor(d.length / 2)), 1);
    return d.map(function (v) { return clampInt(v, 1, 12); });
  }

  /* 货位轴距（相邻货位中心距）：依据货架模型自适应合理尺寸。
     默认 12 列 / 6 排时正好 1.40 × 1.05 m；列、排数增多时略微收紧，
     减少时略微放宽，但主体货架仍随格数增长，不靠整体缩放。 */
  function autoCellPitch(c) {
    var bays = clampInt(c.bays || 12, 2, 40);
    var rows = (c.depths || []).reduce(function (a, b) { return a + b; }, 0) || 6;
    return {
      x: +clamp(1.40 + (12 - bays) * 0.012, 1.20, 1.80).toFixed(2),
      z: +clamp(1.05 + (6 - rows) * 0.008, 1.00, 1.30).toFixed(2)
    };
  }
  /* 人工设定 / 恢复自适应；始终返回归一化后的新配置 */
  function setCellPitch(c, x, z) {
    var q = clone(c || DEFAULT);
    if (x == null && z == null) {
      q.cellAuto = true;
      return normalize(q);
    }
    q.cellAuto = false;
    q.cellPitchX = clamp(Number(x) || q.cellPitchX || 1.4, 1.2, 2);
    q.cellPitchZ = clamp(Number(z) || q.cellPitchZ || 1.05, 1.0, 1.3);
    return normalize(q);
  }

  /* 参数归一化：兼容旧配置 / 越界值，保证几何计算永远可运行 */
  function normalize(input) {
    var c = Object.assign(clone(DEFAULT), input || {});
    if (!Array.isArray(c.bayGroups) || !c.bayGroups.length) {
      c.bayGroups = [clampInt(c.bays || 12, 2, 40)];
    }
    c.bayGroups = c.bayGroups.slice(0, 5).map(function (v) { return clampInt(v, 1, 30); });
    if (c.bayGroups.reduce(function (a, b) { return a + b; }, 0) < 2) c.bayGroups = [2];
    c.aisles = clampInt(c.aisles, 1, 4);
    c.levels = clampInt(c.levels, 2, 12);
    c.depths = fixDepths(c);
    c.bays = c.bayGroups.reduce(function (a, b) { return a + b; }, 0);
    /* 旧存档没有 cellAuto：曾经手工改过 bayW / gap 就沿用并切成手动 */
    if (input && input.cellAuto === undefined) {
      var oldX = clamp(Number(input.bayW) || 1.4, 1.2, 2);
      var oldZ = 1.0 + clamp(Number(input.gap) || 0, 0, 300) / 1000;
      var ap = autoCellPitch(c);
      c.cellAuto = Math.abs(oldX - ap.x) < 0.006 && Math.abs(oldZ - ap.z) < 0.006;
      c.cellPitchX = +oldX.toFixed(2);
      c.cellPitchZ = +oldZ.toFixed(2);
    }
    c.cellAuto = c.cellAuto !== false;
    var cp = c.cellAuto ? autoCellPitch(c) : {
      x: clamp(Number(c.cellPitchX) || 1.4, 1.2, 2),
      z: clamp(Number(c.cellPitchZ) || 1.05, 1.0, 1.3)
    };
    c.cellPitchX = +cp.x.toFixed(2);
    c.cellPitchZ = +cp.z.toFixed(2);
    c.bayW = c.cellPitchX;
    c.gap = Math.round((c.cellPitchZ - 1) * 1000);
    c.dp = 1.0 + clamp(c.gap, 0, 300) / 1000;
    c.y0 = clamp(Number(c.y0) || 1, 0.1, 2);
    c.pitch = clamp(Number(c.pitch) || 1.25, 0.8, 3);
    c.fill = clamp(Number(c.fill) || 0, 0, 100);
    /* 货物总数控制：-1 沿用 fill%；随机分布预留通道 */
    /* 注意 clampInt 用 `Number(v)||a`，会把合法的 0 变下界 -1，故此处直接夹取 */
    c.cargoCount = c.cargoCount == null ? -1
      : Math.max(-1, Math.min(100000, Math.round(Number(c.cargoCount) || 0)));
    c.cargoRandom = !!c.cargoRandom;
    c.cargoReserve = clampInt(c.cargoReserve == null ? 1 : c.cargoReserve, 0, 3);
    c.cargoSeed = clampInt(c.cargoSeed == null ? 20261117 : c.cargoSeed, 1, 999999999);
    c.cargoMainClear = c.cargoMainClear !== false;
    /* 新版拓扑：提升机按子通道口均匀分配；四向车按层固定配置 */
    c.liftN = clampInt(c.liftN == null ? 4 : c.liftN, 1, 8);
    c.perLevel = clampInt(c.perLevel == null ? 1 : c.perLevel, 1, 3);
    /* 提升机布局由「设备面板」维护：liftCols 为 {id,i} 数组，i = 对接的 BAY 列。
       为 null 时按 liftN 均匀分配（既有默认行为，保证仿真回归一致）。
       liftCfg 按稳定 id 记录每台提升机的层数 / 加高 / 是否已匹配层间输送线。 */
    /* 提升机布局：i 越界时【夹取到合法列】而不是整表作废。
       旧逻辑一旦某台 i>=bays（缩短货架）就把 liftCols 全清成 null，
       提升机按 liftN 均匀重排 → 塔位瞬跳、外部输送线随之错位/不对齐。
       夹取后保留稳定 id 与列顺序；重复列顺延到最近空列；不足时从空列补足。 */
    if (Array.isArray(c.liftCols) && c.liftCols.length && c.liftCols.length <= 8 &&
        c.liftCols.length === c.liftN &&
        c.liftCols.every(function (o) { return o && /^LF-\d+$/.test(o.id) && typeof o.i === 'number' && Math.round(o.i) === o.i; })) {
      var usedCols = {}, fixedCols = [];
      c.liftCols.forEach(function (o) {
        var i = clampInt(o.i, 0, Math.max(0, c.bays - 1));
        while (usedCols[i] && i < c.bays - 1) i++;
        while (usedCols[i] && i > 0) i--;
        usedCols[i] = 1; fixedCols.push({ id: o.id, i: i });
      });
      if (fixedCols.length === c.liftN) c.liftCols = fixedCols;
      else c.liftCols = null;
    } else {
      c.liftCols = null;
    }
    if (!c.liftCfg || typeof c.liftCfg !== 'object' || Array.isArray(c.liftCfg)) c.liftCfg = {};
    delete c.lifts;                       // 旧版「每巷道两端/一端」参数已废弃
    if (CARGO_KEYS.indexOf(c.cargoType) < 0) c.cargoType = 'mix';
    if (CARGO_CLASS_ALIAS[c.cargoClass]) c.cargoClass = CARGO_CLASS_ALIAS[c.cargoClass];  // 旧存档别名
    if (CARGO_CLASS_KEYS.indexOf(c.cargoClass) < 0) c.cargoClass = 'goods';
    if (SH_TINTS.indexOf(c.shuttleColor) < 0) c.shuttleColor = 'blue';
    c.split = clampInt(c.split, 0, c.levels);
    c.loadMM = clamp(Number(c.loadMM) || 770, 300, 2500);
    c.kg = clamp(Number(c.kg) || 800, 1, 3000);
    c.liftRate = clamp(Number(c.liftRate) || 45, 5, 300);
    c.need = clamp(Number(c.need) || 0, 0, 5000);
    c.vE = clamp(Number(c.vE) || 256, 20, 500);
    c.vL = clamp(Number(c.vL) || 160, 20, 500);
    c.lowN = clampInt(c.lowN, 0, 12);
    c.highN = clampInt(c.highN, 0, 12);
    c.shW = clamp(Math.round((Number(c.shW) || 95) / 5) * 5, 70, 150);
    c.shL = clamp(Math.round((Number(c.shL) || 110) / 5) * 5, 70, 150);
    if (!Array.isArray(c.lowR) || c.lowR.length !== 2) c.lowR = [1, c.levels];
    c.lowR = [clampInt(c.lowR[0], 1, c.levels), clampInt(c.lowR[1], 1, c.levels)];
    if (c.lowR[1] < c.lowR[0]) c.lowR[1] = c.lowR[0];
    if (c.highR != null && (!Array.isArray(c.highR) || c.highR.length !== 2)) c.highR = null;
    if (c.highR) {
      c.highR = [clampInt(c.highR[0], 1, c.levels), clampInt(c.highR[1], 1, c.levels)];
      if (c.highR[1] < c.highR[0]) c.highR[1] = c.highR[0];
      if (c.highR[0] <= c.lowR[1]) { c.highR = null; c.highN = 0; }
    }
    if (!c.highR) c.highN = 0;
    return c;
  }

  /* 校验：返回错误文字，'' 表示通过 */
  function validate(c) {
    if (c.bays < 2 || c.bays > 40) return 'BAY 总数请控制在 2–40 之间';
    if (c.depths.length !== c.aisles + 1) return '各储区深度需为「巷道数 + 1」段';
    if (c.depths.some(function (d) { return d < 1 || d > 12; })) return '单储区深度请填 1–12 板';
    if (c.shW > c.bayW * 100 - 10) return '四向车宽超过 BAY 宽，请缩小车宽或加大 BAY 宽';
    var tot = c.depths.reduce(function (a, b) { return a + b; }, 0) * c.dp + c.aisles * AW;
    if (tot > 58) return '总深度 ' + tot.toFixed(1) + ' m 超过 58 m 厂房上限';
    return '';
  }

  /* 确定性伪随机：保证重建时在库货物位置稳定 */
  function hash(n) {
    var x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
    return x - Math.floor(x);
  }

  function cellId(l, i, b, k) { return l + '|' + i + '|' + b + '|' + k; }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  /* 存放优先级（0 = 最先存，1 = 最后存）。这是四向库真实的存货规则：
     · 子通道两端都有主通道 → 先存中间的 2、3 号位，两端 1、4 号位最后才用
       （因为两端紧邻主通道，留空便于四向车通行与接驳）。
     · 子通道只有一端有主通道 → 从最里面（远离主通道）开始，依次向靠近主通道的货位存放。
     返回归一化到 [0,1] 的值，便于直接与在库率阈值比较。 */
  function storageRank(c, b, k) {
    var D = (c.depths && c.depths[b]) || 1, last = Math.max(1, D - 1);
    var frontMain = b > 0;              // -Z 侧（k 小的一端）有主通道
    var backMain = b < c.aisles;        // +Z 侧（k 大的一端）有主通道
    if (frontMain && backMain) {
      return Math.abs(k - (D - 1) / 2) / Math.max(0.5, (D - 1) / 2);
    }
    if (backMain) return k / last;                  // 主通道在 +Z，最里面是 k=0
    if (frontMain) return (D - 1 - k) / last;      // 主通道在 -Z，最里面是 k=D-1
    return k / last;
  }
  /* 是否紧邻主通道的货位（硬性预留为空，作为四向车进出子通道的接驳位） */
  function mainAdjacent(c, b, k) {
    var D = (c.depths && c.depths[b]) || 1;
    return (b > 0 && k === 0) || (b < c.aisles && k === D - 1);
  }

  /* 核心几何 —— 按实际四向库拓扑重建：
     · X 方向：每一列 BAY 即一条「子通道」（沿 Z 深入，货位在子通道两侧上方），
       货架连续排布，中间不挖空；本期不制作维修通道（原竖向贯通空道）。
     · Z 方向：储区按「一行子通道货位 → 一条主通道」交替；主通道沿 X 贯穿全部列。
     · 提升机：位于前端 Z 端子通道口，均匀分配（非每条子通道一台）。
       其对接的子通道首行货位改为「层间输送线」位，每层放两条平行黑色长条，不放货。
     · 货物只落在真实货位上，绝不落在主通道 / 子通道 / 层间输送线位。 */
  function geom(c, overrides) {
    overrides = overrides || {};
    var bays = c.bays, gw = c.bayW, dp = c.dp;
    var len = bays * gw;                          // 无横向通道，货架中间不挖空
    var tot = c.depths.reduce(function (a, b) { return a + b; }, 0) * dp + c.aisles * AW;
    var x0 = -len / 2, x1 = len / 2, z0 = -tot / 2, z1 = tot / 2;

    var bayX = [], x = x0;
    for (var i = 0; i < bays; i++) { bayX.push(x + gw / 2); x += gw; }
    var cross = [];                              // 维修通道本期不建模
    var gEdges = [[x0, x1]];

    var blocks = [], tracks = [], stations = [], z = z0;
    c.depths.forEach(function (d, b) {
      var a = z, bz = z + d * dp;
      blocks.push([a, bz]);
      for (var k = 0; k <= d; k += 2) stations.push(+(a + k * dp).toFixed(3));
      if (d % 2) stations.push(+bz.toFixed(3));
      z = bz;
      if (b < c.aisles) { tracks.push(z + AW / 2); z += AW; }
    });

    var want = c.loadMM / 1000 - 0.15;
    var loadH = Math.max(0.2, Math.min(want, c.pitch - 0.3 - 0.15 - 0.12));
    var top = c.y0 + (c.levels - 1) * c.pitch + Math.max(0.9, loadH + 0.5);

    var chgLevels = c.chg ? [c.lowN > 0 ? c.lowR[0] - 1 : null, c.highR && c.highN > 0 ? c.highR[0] - 1 : null]
      .filter(function (v) { return v != null && v >= 0 && v < c.levels; }) : [];
    chgLevels = chgLevels.filter(function (v, i, a) { return a.indexOf(v) === i; });

    /* 提升机：设备面板可指定 BAY 列（liftCols）；未指定时按 liftN 均匀分配。
       全部对接前端（z0 侧）子通道口，绝不对接主通道。 */
    var nLift = c.liftCols ? c.liftCols.length : Math.min(clampInt(c.liftN, 1, 8), bays);
    var liftCols = [];
    if (c.liftCols) {
      c.liftCols.forEach(function (o) { liftCols.push(o.i); });
    } else {
      for (var j = 0; j < nLift; j++) {
        var bi = Math.floor((j + 0.5) * bays / nLift);
        if (liftCols.indexOf(bi) < 0) liftCols.push(bi);
      }
    }
    var chgBay = 0;
    while (chgBay < bays - 1 && liftCols.indexOf(chgBay) >= 0) chgBay++;

    /* 提升机可摆在货架前端（-Z）或「对面」后端（+Z）。
       层间输送线走廊从提升机口延伸到紧邻最近主通道的那一端：
       · front → 第一储区 blocks[0]，最近主通道 tracks[0]
       · back  → 最后储区 blocks[last]，最近主通道 tracks[last-1]
       货物静止位 convZ 永远在靠主通道的一端，四向车从主通道沿 Z 进入接驳。 */
    var lastB = c.aisles;    // blocks / depths 的最后一段索引
    var convFrom = blocks[0][0], convTo = blocks[0][1];
    var mainZ = tracks.length ? tracks[0] : convTo;
    var liftSites = liftCols.map(function (bi, si) {
      var id = c.liftCols ? c.liftCols[si].id : 'LF-' + pad2(si + 1);
      var cf = c.liftCfg[id] || {};
      var side = cf.side === 'back' ? 'back' : 'front';
      var bIdx = side === 'back' ? lastB : 0;
      var blk = blocks[bIdx];
      var from = blk[0], to = blk[1];
      var main = side === 'back'
        ? (tracks.length ? tracks[tracks.length - 1] : from)
        : (tracks.length ? tracks[0] : to);
      /* 层间输送线恒为【紧邻主通道的 1 个货位网格】：
         前端储区取最后一排，后端储区取第一排；拉伸宽度时它不再被拉长，
         新增 / 减少的货位都落在其它排（优先中间储区）。 */
      var convK = side === 'back' ? 0 : Math.max(0, c.depths[bIdx] - 1);
      var convLo = side === 'back' ? from : to - dp;
      var convHi = convLo + dp;
      var lv = clampInt(cf.lv == null ? c.levels : cf.lv, 1, c.levels);
      var boost = clamp(Number(cf.boost) || 0, 0, 6);
      return {
        idx: si, i: bi, x: bayX[bi],
        z: side === 'back' ? z1 + 1.15 : z0 - 1.15,   // 塔中心（货架外侧）
        side: side, bIdx: bIdx, convK: convK,
        convZ: convLo + 0.5 * dp,
        convFrom: convLo, convTo: convHi, mainZ: main,
        id: id, name: '提升机 ' + id, col: 'B' + (bi + 1),
        lv: lv, boost: boost, matched: cf.matched !== false
      };
    });
    /* 层间输送线货位：每台提升机只占【1 个货位网格】（紧邻主通道那一排），
       每层同一个格子。宽度拉伸时这条接驳线尺寸恒定，主通道始终贴着它；
       其余排都是正常货位，会随拉伸增减货物。 */
    var convCell = {}, corridor = {};
    liftSites.forEach(function (s, si) {
      if (!s.matched) return;
      for (var l = 0; l < c.levels; l++) {
        convCell[cellId(l, s.i, s.bIdx, s.convK)] = si;
        /* 提升机接驳的整条子通道都保持畅通（不放货），
           但只有紧邻主通道的那一格才是「层间输送线」模型 */
        for (var k = 0; k < c.depths[s.bIdx]; k++) {
          corridor[cellId(l, s.i, s.bIdx, k)] = 1;
        }
      }
    });
    /* 全局对接区间同步为单格，供面板 / 快照展示 */
    if (liftSites.length) {
      convFrom = liftSites[0].convFrom;
      convTo = liftSites[0].convTo;
    }

    var cells = [], seed = 0;
    for (var l = 0; l < c.levels; l++) {
      var y = c.y0 + l * c.pitch;
      bayX.forEach(function (cx, ii) {
        blocks.forEach(function (bk, b) {
          for (var k = 0; k < c.depths[b]; k++) {
            var id = cellId(l, ii, b, k);
            var conv = Object.prototype.hasOwnProperty.call(convCell, id) ? convCell[id] : -1;
            var isChg = conv < 0 && b === 0 && ii === chgBay && chgLevels.indexOf(l) >= 0;
            /* 货物按存放优先级成片集中，绝不零散撒在通道口：
               同一子通道内 rank 小的（内侧 / 中间）先占用，靠近主通道的一律留空。 */
            var rank = storageRank(c, b, k);
            var jitter = (hash(l * 31.7 + ii * 7.3 + b * 13.1) - 0.5) * 0.045;
            var clear = Object.prototype.hasOwnProperty.call(corridor, id);
            /* occ 在循环后统一分配（两阶段）：便于按「货物总数」或随机分布
               精确选位、并硬性预留主通道 / 每子通道通行位，避免堵死路线。 */
            cells.push({
              id: id, l: l, i: ii, b: b, k: k, wall: false, conv: conv, rank: rank,
              jitter: jitter, clear: clear,
              x: cx, y: y, z: bk[0] + (k + 0.5) * dp,
              chg: isChg, occ: false
            });
            seed++;
          }
        });
      });
    }

    /* ---- 货物分布两阶段分配 ----
       候选 = 非提升机输送线位 / 非充电位 / 非提升机通道列；
       默认按 rank 整齐排布（旧行为）；随机分布用固定 seed 打乱，且
       ①主通道相邻格必空 ②每条子通道(层×列×储区)至少留 cargoReserve 个空格，
       保证四向车始终有可通行的接驳位与行车路线。 */
    var eligible = cells.filter(function (o) {
      if (o.chg || o.conv >= 0 || o.clear) return false;
      if (c.cargoMainClear && mainAdjacent(c, o.b, o.k)) return false;
      return true;
    });
    var capacity = eligible.length;                 // 真实可放货位数（UI 上限）
    function randKey(o) {
      return hash(c.cargoSeed + o.l * 131 + o.i * 17 + o.b * 7.3 + o.k * 1.7 + 0.31);
    }
    if (c.cargoRandom) {
      /* 每条子通道至少留 N 空：按随机序保留前 (len-N) 个作为可放候选，
         其余强制留空；这样任意子通道都不会被完全堵死。 */
      var bySub = {}, kept = [];
      eligible.forEach(function (o) {
        var key = o.l + '|' + o.i + '|' + o.b;
        (bySub[key] || (bySub[key] = [])).push(o);
      });
      Object.keys(bySub).forEach(function (key) {
        var arr = bySub[key].slice().sort(function (x, y) { return randKey(x) - randKey(y); });
        kept = kept.concat(arr.slice(0, Math.max(0, arr.length - c.cargoReserve)));
      });
      eligible = kept;
    }
    eligible.sort(function (x, y) {
      var kx = c.cargoRandom ? randKey(x) : (x.rank + x.jitter);
      var ky = c.cargoRandom ? randKey(y) : (y.rank + y.jitter);
      return kx - ky || (x.id < y.id ? -1 : (x.id > y.id ? 1 : 0));
    });
    var target = c.cargoCount >= 0 ? c.cargoCount : Math.round(capacity * c.fill / 100);
    target = clampInt(target, 0, eligible.length);
    for (var qi = 0; qi < target; qi++) eligible[qi].occ = true;
    /* 单货位覆盖优先（用户手工指定），但输送线/通道位仍禁止放货 */
    cells.forEach(function (o) {
      if (Object.prototype.hasOwnProperty.call(overrides, o.id) &&
          o.conv < 0 && !o.chg && !o.clear) o.occ = !!overrides[o.id];
    });

    var slotCount = cells.filter(function (o) { return !o.chg && o.conv < 0; }).length;
    var used = cells.filter(function (o) { return !o.chg && o.conv < 0 && o.occ; }).length;
    var shuttles = c.levels * c.perLevel;      // 每层至少 1 台，固定层作业

    return {
      len: len, tot: tot, top: top, x0: x0, x1: x1, z0: z0, z1: z1,
      bayX: bayX, cross: cross, gEdges: gEdges, blocks: blocks, tracks: tracks,
      stations: stations, cells: cells, loadH: loadH, chgLevels: chgLevels,
      chgBay: chgBay, liftCols: liftCols, liftSites: liftSites, convCell: convCell,
      convFrom: convFrom, convTo: convTo, convMain: mainZ,
      lifts: liftSites.length, slots: slotCount, capacity: capacity,
      used: used, shuttles: shuttles,
      lw: gw, dw: dp, ch: c.pitch
    };
  }

  /* 吞吐量估算：参考平台 gThru 公式（含加减速与链条转接 8 s） */
  function throughput(c, g) {
    g = g || geom(c);
    var seg = function (d, v) { return d >= v * 2 ? d / v + 2 : 2 * Math.sqrt(2 * d / v); };
    var vE = c.vE / 100, vL = c.vL / 100;
    var dx = g.len / (2 * Math.max(1, g.lifts));
    var dz = c.depths.reduce(function (a, b) { return a + b; }, 0) / c.depths.length * c.dp / 2 + 0.6;
    var cyc = seg(dx, vL) + seg(dz, vL) + seg(dz, vE) + seg(dx, vE) + 8;
    var perSh = 3600 / cyc;
    var nSh = g.shuttles || 1;
    var lift = g.lifts * c.liftRate;
    var shut = nSh * perSh;
    var sys = Math.min(lift, shut);
    return {
      cyc: cyc, perSh: perSh, nSh: nSh, lift: lift, shut: shut, sys: sys,
      bott: lift < shut ? '提升机' : '穿梭车',
      needL: c.need ? Math.ceil(c.need / c.liftRate) : 0,
      needS: c.need ? Math.ceil(c.need / perSh) : 0
    };
  }

  function stats(c, g) {
    g = g || geom(c);
    var t = throughput(c, g);
    return {
      slots: g.slots, used: g.used, rate: g.slots ? g.used / g.slots * 100 : 0,
      lifts: g.lifts, shuttles: g.shuttles, dim: [g.len, g.tot, g.top],
      thru: t, lenBays: c.bays, widRows: c.depths.reduce(function (a, b) { return a + b; }, 0)
    };
  }

  /* 快速建构：三个维度 */
  function setLen(c, n) { c.bayGroups = distribute(n, c.bayGroups, 1, 30); c.bays = c.bayGroups.reduce(function (a, b) { return a + b; }, 0); return normalize(c); }
  function setWid(c, n) { c.depths = distributeWidth(n, c.depths, 1, 12); return normalize(c); }
  function setHei(c, n) {
    c.levels = clampInt(n, 2, 12);
    c.split = Math.min(c.split, c.levels);
    c.lowR = [Math.min(c.lowR[0], c.levels), Math.min(c.lowR[1], c.levels)];
    if (c.highR) {
      if (c.lowR[1] >= c.levels) { c.highR = null; c.highN = 0; }
      else { c.highR = [c.lowR[1] + 1, c.levels]; }
    }
    return normalize(c);
  }
  function addAisle(c) {
    if (c.aisles >= 4) return normalize(c);
    c.aisles += 1;
    c.depths = fixDepths(c);
    return normalize(c);
  }
  /* 货架结构手套：水平移动一条主通道（沿 Z），仅改储区分段，不增删通道。
     depths = [左储区, 中储区, 右储区]，主通道夹在相邻储区之间。
     aisleIndex=0 表示 depths[0] 与 depths[1] 之间那条主通道；
     dir=-1 把通道向 -Z（左）移一格 → 左储区 -1、中储区 +1（原通道位变子通道）；
     dir=+1 反之。单储区最小 1 格，越界则拒绝。 */
  function moveAisle(c, aisleIndex, dir) {
    var ai = clampInt(aisleIndex, 0, (c.aisles || 1) - 1);
    var d = fixDepths(c);
    var left = ai, right = ai + 1;
    if (right >= d.length) return false;
    /* 通道向 +Z（右）移一格：原通道位变左储区 → 左 +1；右侧被占一格 → 右 -1。
       向 -Z（左）移：左 -1、右 +1。总量守恒，单储区不得小于 1。 */
    var dl = dir > 0 ? 1 : -1;
    if (d[left] + dl < 1 || d[right] - dl < 1) return false;
    d[left] += dl; d[right] -= dl;
    c.depths = d;
    normalize(c);
    return true;
  }
  /* 删除一条主通道：aisles-1，并把它左右两侧储区合并为一区（深度相加、上限 12）。
     最少保留 1 条主通道。 */
  function removeAisle(c, aisleIndex) {
    if ((c.aisles || 1) <= 1) return false;
    var ai = clampInt(aisleIndex, 0, c.aisles - 1);
    var d = fixDepths(c);
    var merged = Math.min(12, d[ai] + d[ai + 1]);
    d.splice(ai, 2, merged);
    c.depths = d; c.aisles -= 1;
    normalize(c);
    return true;
  }

  /* 配置持久化 */
  function load() {
    try {
      var raw = global.localStorage && global.localStorage.getItem(STORE_KEY);
      if (raw) return normalize(JSON.parse(raw));
    } catch (e) { /* ignore */ }
    return clone(DEFAULT);
  }
  function save(c) {
    try { global.localStorage && global.localStorage.setItem(STORE_KEY, JSON.stringify(c)); } catch (e) { /* ignore */ }
  }

  /* 单货位货物种类覆盖的持久化：只保留合法种类值 */
  function loadCargoOverrides() {
    try {
      var raw = global.localStorage && global.localStorage.getItem(CARGO_OV_KEY);
      var o = raw ? JSON.parse(raw) : {};
      var out = {};
      if (o && typeof o === 'object') {
        Object.keys(o).forEach(function (id) {
          if (CARGO_REAL.indexOf(o[id]) >= 0) out[id] = o[id];
        });
      }
      return out;
    } catch (e) { return {}; }
  }
  function saveCargoOverrides(map) {
    try { global.localStorage && global.localStorage.setItem(CARGO_OV_KEY, JSON.stringify(map || {})); } catch (e) { /* ignore */ }
  }
  /* 货物大类覆盖：id -> class（'auto' 表示跟随全局） */
  function loadCargoClassOverrides() {
    try {
      var raw = global.localStorage && global.localStorage.getItem(CLASS_OV_KEY);
      var o = raw ? JSON.parse(raw) : {};
      var out = {};
      if (o && typeof o === 'object') {
        Object.keys(o).forEach(function (id) {
          var v = CARGO_CLASS_ALIAS[o[id]] || o[id];   // 旧存档别名归一
          if (CARGO_CLASS_KEYS.indexOf(v) >= 0 || v === 'auto') out[id] = v;
        });
      }
      return out;
    } catch (e) { return {}; }
  }
  function saveCargoClassOverrides(map) {
    try { global.localStorage && global.localStorage.setItem(CLASS_OV_KEY, JSON.stringify(map || {})); } catch (e) { /* ignore */ }
  }
  /* 四向车换色：{ shuttleId|'all': colorKey } */
  function loadShuttleColors() {
    try {
      var raw = global.localStorage && global.localStorage.getItem(SHUTTLE_COLOR_KEY);
      var o = raw ? JSON.parse(raw) : {}, out = {};
      if (o && typeof o === 'object') Object.keys(o).forEach(function (id) {
        if (SH_TINTS.indexOf(o[id]) >= 0) out[id] = o[id];
      });
      return out;
    } catch (e) { return {}; }
  }
  function saveShuttleColors(map) {
    try { global.localStorage && global.localStorage.setItem(SHUTTLE_COLOR_KEY, JSON.stringify(map || {})); } catch (e) { /* ignore */ }
  }

  WAP.core = {
    AW: AW, CAW: CAW, DEFAULT: DEFAULT, STORE_KEY: STORE_KEY,
    CARGO_OV_KEY: CARGO_OV_KEY, CLASS_OV_KEY: CLASS_OV_KEY,
    CARGO_KINDS: CARGO_KINDS, CARGO_KEYS: CARGO_KEYS, CARGO_REAL: CARGO_REAL, CARGO_NAME: CARGO_NAME,
    CARGO_CLASSES: CARGO_CLASSES, CARGO_CLASS_KEYS: CARGO_CLASS_KEYS,
    CARGO_CLASS_NAME: CARGO_CLASS_NAME, CARGO_CLASS_DEF: CARGO_CLASS_DEF,
    CARGO_CLASS_ALIAS: CARGO_CLASS_ALIAS,
    SH_TINTS: SH_TINTS, SHUTTLE_COLOR_KEY: SHUTTLE_COLOR_KEY,
    clone: clone, clamp: clamp, clampInt: clampInt, distribute: distribute,
    distributeWidth: distributeWidth,
    normalize: normalize, validate: validate, geom: geom, throughput: throughput,
    stats: stats, cellId: cellId, hash: hash, storageRank: storageRank,
    autoCellPitch: autoCellPitch, setCellPitch: setCellPitch,
    setLen: setLen, setWid: setWid, setHei: setHei, addAisle: addAisle,
    moveAisle: moveAisle, removeAisle: removeAisle,
    load: load, save: save,
    loadCargoOverrides: loadCargoOverrides, saveCargoOverrides: saveCargoOverrides,
    loadCargoClassOverrides: loadCargoClassOverrides, saveCargoClassOverrides: saveCargoClassOverrides,
    loadShuttleColors: loadShuttleColors, saveShuttleColors: saveShuttleColors
  };

  /* 全局运行状态（单一数据源） */
  WAP.state = {
    cfg: clone(DEFAULT),
    geom: null,
    overrides: {},            // 货位占用状态覆盖
    cargoOverrides: {},       // 单货位货物种类覆盖：id -> kind（'auto' 表示跟随全局）
    cargoClassOverrides: {},  // 单货位货物大类覆盖：id -> class（'auto' 跟随全局）
    shuttleColors: {},        // 四向车换色：车 id / 'all' -> 颜色 key
    cargoCounts: {},          // 各类货物占用货位数（由 rack 重建时统计）
    cargoCustom: 0,           // 单独指定种类的货位数
    view: { crystal: true, frame: true, cargo: true, mode: 'rotate' },
    selection: { rack: false, cell: null, phase: 0, crystalHidden: false, part: null },
    focused: false
  };
})(window);
