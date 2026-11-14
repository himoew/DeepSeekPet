/**
 * 她手机上的「打开某个 App」（P0，2026-11-12）
 *
 * 用户的原话：「我搞不懂为什么这么不智能，每个 App 都需要单独调程序？
 * 不能找不到截张图看看点哪里，然后继续吗？」
 *
 * 这一层就是那个"找不到就看屏幕"的兜底。**别名表从"门槛"降级成"缓存"**：
 *
 *   ① 缓存（`apps.json`：上次验过的包名）  → 0 模型、1~2 秒
 *   ② 别名 / 包名（`phone-adb.launch`）      → 0 模型
 *   ③ 当前屏 / 回桌面 / 开抽屉，看屏上的字点 → 0 模型（真机上桌面与抽屉的字都在控件树里）
 *   ④ 截图问一次 VLM "它在哪"               → 1 次调用（只有树里没字才发）
 *   ⑤ 四路都不成 → 如实说没找到，不再烧 20 步
 *
 * 判据只有一个：**前台包名真的变了**（`adb.launch` 的 `ok` 只代表 monkey 退出码 0，不算数）。
 *
 * ⚠️ 这一层不写任何"某个 App 的剧本"：App 只是**数据**（名字 / 包名 / 屏幕上的字），不是程序。
 * 学习结果落在 `data/companion/phone/apps.json`，键是"他/她说的那个名字"。
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

/** 桌面/启动器（"包名变了"不能算它）。 */
const LAUNCHER_PKG = /launcher|lawnchair/i;
/** 系统壳（弹权限框 / 安装器 / 输入法也会让"前台包名"变）。 */
const SYSTEM_PKG = /^(com\.android\.systemui|com\.android\.permissioncontroller|com\.android\.packageinstaller|com\.google\.android\.packageinstaller|android)$/i;

const DEFAULTS = {
  /** 开抽屉的手势（真机参数；MuMu 底部有导航栏，起点别贴 0.85）。 */
  drawer: { fromY: 0.72, toY: 0.18, ms: 280, settleMs: 700, tries: 2 },
  drawerPages: 4,
  /** 截图问坐标（一次任务最多几次、超时、发出去前缩到多宽）。 */
  locate: { maxPerTask: 2, timeoutMs: 8000, width: 360 },
  /** 学习（`apps.json`）。 */
  learn: { enabled: true, max: 80 },
  /** 验前台包名的轮询。 */
  verify: { timeoutMs: 2500, intervalMs: 250 },
  /** 手势/回桌面之后的沉降。 */
  settleMs: 500,
  /** 同一件事里同一个名字最多试几次（防"点错了再点"刷屏）。 */
  maxTriesPerLabel: 2,
};

/**
 * ★ 找图标用的**同义词**（是数据，不是程序）。
 *
 * 为什么需要：真机 Launcher 上写的是"图库 / Via / 哔哩哔哩 / 她的日记本"
 * （11-11 21:37 的 `_tmp/home2.xml`，`app.lawnchair`），而他会说"相册 / 浏览器 / B站"。
 * `surface.find('相册')` 在这台机器的桌面上**一个都找不到**。
 *
 * 命中之后会把**屏幕上真实的那个字**记进 `apps.json`（`screenLabel`），第二次就不用再猜。
 */
const SCREEN_ALIASES = {
  相册: ['图库', '相册', '照片', '相簿'],
  图库: ['图库', '相册', '照片'],
  浏览器: ['Via', 'via', '浏览器', '网页', 'Chrome'],
  哔哩哔哩: ['哔哩哔哩', 'B站', 'b站', '小破站', '哔哩'],
  B站: ['哔哩哔哩', 'B站', '小破站', '哔哩'],
  日记本: ['她的日记本', '日记本', '日记', '本子'],
  文件: ['文件', '文件', '文件管理器', '文档'],
  应用商店: ['应用商店', '商店', '应用市场'],
  设置: ['设置', '设定'],
  相机: ['相机', '照相机'],
  壁纸: ['壁纸', '壁纸与主题'],
};

/** 归一化：剥掉"打开/看看/应用/客户端"这类**词形**（不是 App 表，所以新增 App 不用改）。 */
const PREFIX_RX = /^(?:帮我|给我|麻烦你?|请你?|现在|马上|这就|立刻|先|去|到|回|打开|点开|进入|进|看看|瞧瞧|翻翻|找到|查找|开一下|开)\s*/;
const SUFFIX_RX = /(?:里面有什么东西|里面有什么|里头有什么|里有什么|有什么东西|有些什么|有什么|有啥|里头|里面|里去|一下吧|一下|看看|看一下|瞧瞧|瞅瞅|翻翻|吧|呗|应用|软件|app|客户端|管理器|助手)$/i;
/** 描述型目标不是 App 名（"那个蓝色的图标"交给截图/模型，不要拿去抽屉里找字）。 */
const DESCRIPTIVE = /(那个|这个|蓝色|红色|绿色|图标|按钮|左边|右边|上面那个|下面那个|最大|最小|第一个|第二个|第三个)/;

/** 包名（`tv.danmaku.bili` 这种原样保留）。 */
const PKG_RX = /^[a-z][\w.]*\.[\w.]+$/i;

/**
 * 把"打开菜谱看看 → 菜谱"、"文件管理器 → 文件"、"B站客户端 → B站"。
 * 认不出（空 / 太长 / 全是描述）就返回空串。
 */
function normalizeLabel(name) {
  const raw = String(name || '').replace(/[。！!？?，,、~～]+$/g, '').replace(/\s+/g, ' ').trim();
  if (!raw) return '';
  if (PKG_RX.test(raw) && raw.includes('.')) return raw;
  let s = raw;
  for (let i = 0; i < 4; i++) {
    const next = s.replace(PREFIX_RX, '').replace(SUFFIX_RX, '').trim();
    if (next === s) break;
    s = next;
  }
  s = s.replace(/^[「"'《]+|[」"'》]+$/g, '').replace(/[\s，,。.!！?？、]+$/g, '').trim();
  if (!s || s.length > 12) return '';
  if (DESCRIPTIVE.test(s)) return '';
  return s;
}

/** 同义词候选（含"她的日记本 → 日记本"这种去掉所有格的）。 */
function aliasCands(label) {
  const key = String(label || '').trim();
  if (!key) return [];
  const core = key.replace(/^(?:她的|我的|你的|这个|那个)/, '');
  const out = [];
  const push = (x) => { if (x && !out.includes(x)) out.push(x); };
  push(key);
  if (core !== key) push(core);
  for (const k of [key, core]) for (const a of (SCREEN_ALIASES[k] || [])) push(a);
  return out;
}

/** 屏幕上找字（同义词逐个试，修好后的 `surface.find` 是 exact > desc > 包含）。 */
function findLabel(obs, label, surface) {
  for (const c of aliasCands(label)) {
    const hit = surface.find(obs, c);
    if (hit) return { hit, usedLabel: c };
  }
  return null;
}

/* ------------------------------------------------------------ 小工具 */

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, Number(ms) || 0)));

function centerOf(n) {
  if (!n) return null;
  if (Array.isArray(n.center) && n.center.length >= 2) return [Number(n.center[0]), Number(n.center[1])];
  const b = n.bounds;
  if (!Array.isArray(b) || b.length < 4) return null;
  return [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
}

function areaOf(n) {
  const b = (n && n.bounds) || null;
  if (!Array.isArray(b) || b.length < 4) return Infinity;
  return Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
}

/** 点文字节点时，如果它本身不可点，找"包含它中心点的最小可点节点"再点。 */
function clickableAncestor(obs, hit) {
  if (!hit) return null;
  if (hit.clickable) return hit;
  const c = centerOf(hit);
  if (!c) return null;
  const cands = ((obs && obs.nodes) || []).filter((n) => n && n.clickable && Array.isArray(n.bounds)
    && c[0] >= n.bounds[0] && c[0] <= n.bounds[2] && c[1] >= n.bounds[1] && c[1] <= n.bounds[3]);
  if (!cands.length) return null;
  cands.sort((a, b) => areaOf(a) - areaOf(b));
  return cands[0];
}

function nodeText(n) {
  return String((n && (n.text || n.desc)) || '').trim();
}

/**
 * 学习的前提是"点对了"，不是"点开了东西"。
 *
 * 未知包时 `waitApp(null)` 只证明"有东西开了"——可能是桌面上的新闻小部件打开了浏览器。
 * 所以写缓存再加两道：① 屏上那个字跟点的一模一样（或前缀）；② 它是个**图标大小**的块。
 */
function learnable(hit, usedLabel, screen) {
  const t = nodeText(hit);
  if (!t || !usedLabel) return false;
  if (!(t === usedLabel || t.startsWith(usedLabel))) return false;
  const w = Number(screen && screen.width) || 720;
  const h = Number(screen && screen.height) || 1280;
  const b = (hit && hit.bounds) || null;
  if (!Array.isArray(b) || b.length < 4) return true;
  const bw = b[2] - b[0];
  const bh = b[3] - b[1];
  const okW = bw >= w * 0.08 && bw <= w * 0.45;
  const okH = bh >= h * 0.03 && bh <= h * 0.3;
  return okW && okH;
}

/** 抽屉开没开（不猜：搜索框 / 文字节点明显变多 / 屏变了且还在 launcher）。 */
function drawerOpen(prev, next) {
  if (!next || next.ok === false) return false;
  if (prev && next.hash && prev.hash && next.hash === prev.hash) return false;
  const nodes = next.nodes || [];
  if (nodes.some((n) => n && (n.editable || /EditText/.test(String(n.class || ''))))) return true;
  const many = nodes.filter((n) => nodeText(n)).length;
  const was = ((prev && prev.nodes) || []).filter((n) => nodeText(n)).length;
  return many >= was + 6;
}

/* ------------------------------------------------------------ apps.json */

/**
 * 学习到的入口（`data/companion/phone/apps.json`）。
 *
 * 规则（方案 §4.5）：**只有验过前台包名才写**；`entry` 记学来的入口
 * （alias/home/drawer/vlm），`screenLabel` 记屏幕上真实的字，`xy` 是归一化坐标；
 * 设备指纹不对**整份忽略**（不删，换回来还能用）；`miss >= 2` 删条目；上限 80。
 */
function createStore(file, { max = 80, log = null } = {}) {
  const empty = () => ({ version: 1, device: null, items: {} });
  const say = (m) => { try { log && log.warn(`手机：apps.json ${m}`); } catch { /* 日志不该影响开 App */ } };
  let data = empty();
  let deviceOK = false;

  function backupBroken() {
    try {
      const bad = `${file}.bad-${Date.now()}`;
      fs.renameSync(file, bad);
      say(`坏了，备份成 ${path.basename(bad)}，从空开始`);
    } catch { /* 备份不了就继续 */ }
  }

  (function load() {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!raw || typeof raw !== 'object' || !raw.items || typeof raw.items !== 'object') {
        data = empty();
        deviceOK = true;
        return;
      }
      data = { version: 1, device: raw.device || null, items: raw.items };
      /** 还没有设备指纹（第一次）→ 认它；有指纹就得对上（见 `sync`）。 */
      deviceOK = !data.device;
    } catch (err) {
      if (err && err.code !== 'ENOENT') backupBroken();
      data = empty();
      deviceOK = true;
    }
  })();

  function save() {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data, null, 1), 'utf8');
      fs.renameSync(tmp, file);
    } catch (err) { say(`没写进去（${err.message}）`); }
  }

  /** 设备指纹（serial + 画幅）。对不上 → 整份忽略（一个字都不删）。 */
  function sync(dev = {}) {
    const serial = String(dev.serial || '');
    const w = Number(dev.width) || 0;
    const h = Number(dev.height) || 0;
    if (!serial && !w) { deviceOK = deviceOK || true; return { ok: deviceOK, known: false }; }
    const cur = { serial, w, h };
    if (!data.device) {
      data.device = { ...cur, at: Date.now() };
      deviceOK = true;
      save();
      return { ok: true, known: false };
    }
    const ok = String(data.device.serial || '') === serial
      && Number(data.device.w || 0) === w
      && Number(data.device.h || 0) === h;
    deviceOK = ok;
    if (!ok) say(`设备对不上（记的是 ${data.device.serial} ${data.device.w}x${data.device.h}）—— 这一趟不参考学到的入口`);
    return { ok, known: true };
  }

  function get(label) {
    if (!deviceOK) return null;
    const rec = data.items[String(label || '')];
    return rec && typeof rec === 'object' ? rec : null;
  }

  function put(label, patch = {}) {
    const key = String(label || '').trim();
    if (!key) return null;
    if (!deviceOK) return null;
    if (!(patch.pkg || (data.items[key] && data.items[key].pkg))) return null;
    const prev = data.items[key] || { label: key, ok: 0, miss: 0 };
    const next = { ...prev, ...patch, label: key, at: Date.now() };
    next.ok = Number(prev.ok || 0) + (patch.ok ? Number(patch.ok) : 1);
    next.miss = 0;
    delete next.okDelta;
    data.items[key] = next;
    const keys = Object.keys(data.items);
    if (keys.length > max) {
      keys.sort((a, b) => {
        const x = data.items[a];
        const y = data.items[b];
        return (Number(y && y.miss) || 0) - (Number(x && x.miss) || 0)
          || (Number(x && x.at) || 0) - (Number(y && y.at) || 0);
      });
      for (const k of keys.slice(0, keys.length - max)) delete data.items[k];
    }
    save();
    return next;
  }

  /** 缓存/坐标失效：连续 2 次 miss 就删条目，退回"找"。 */
  function miss(label) {
    const key = String(label || '').trim();
    const rec = key && deviceOK ? data.items[key] : null;
    if (!rec) return null;
    rec.miss = Number(rec.miss || 0) + 1;
    rec.at = Date.now();
    if (rec.miss >= 2) {
      delete data.items[key];
      say(`「${key}」连着两次没开成，忘掉它，下次重新找`);
    } else {
      save();
    }
    return rec;
  }

  function list() {
    if (!deviceOK) return [];
    return Object.values(data.items);
  }

  return { file, sync, get, put, miss, list, _data: () => data };
}

/* ------------------------------------------------------------ 打开 */

/**
 * @param {object} deps
 *   · `adb`      phone-adb（只用到 wake/state/observe/launch/tapXY/swipe/swipeDir/key/screenshot/focusApp）
 *   · `surface`  phone-surface（find/enrich）
 *   · `askLocate` `({shot, label, screen}) => {x,y}|null`（生产环境包 VLM；自检传 stub）
 *   · `store`    apps.json 的 get/put/miss/sync/list
 *   · `log`      log.cjs
 *   · `cfg`      `phone.open` 那一段
 */
function createOpener({ adb, surface, askLocate = null, store = null, log = null, cfg = null } = {}) {
  const c = {
    ...DEFAULTS,
    ...(cfg && typeof cfg === 'object' ? cfg : {}),
    drawer: { ...DEFAULTS.drawer, ...((cfg && cfg.drawer) || {}) },
    locate: { ...DEFAULTS.locate, ...((cfg && cfg.locate) || {}) },
    learn: { ...DEFAULTS.learn, ...((cfg && cfg.learn) || {}) },
    verify: { ...DEFAULTS.verify, ...((cfg && cfg.verify) || {}) },
  };
  const say = (m) => { try { log && log.info(`手机：openApp ${m}`); } catch { /* 日志不影响开 App */ } };
  /** 有没有"验证能力"（假 adb 可能只有 launch —— 那种情况没法验前台包名）。 */
  const canVerify = !!(adb && (typeof adb.focusApp === 'function' || typeof adb.state === 'function'));

  async function stateOf() {
    try { return (await adb.state()) || {}; } catch { return {}; }
  }

  async function focusPkg() {
    try {
      if (typeof adb.focusApp === 'function') return String((await adb.focusApp()) || '');
      const st = await stateOf();
      return String((st && st.app && st.app.package) || '');
    } catch { return ''; }
  }

  /** 判据：前台包名真的对上了（`adb.launch` 的 ok 只代表 monkey 退出码 0，不算数）。 */
  async function waitApp(expected, { before = '', timeout = c.verify.timeoutMs } = {}) {
    if (!canVerify) return expected || 'unverified';
    const t0 = Date.now();
    const timeoutMs = Math.max(100, Number(timeout) || c.verify.timeoutMs);
    while (Date.now() - t0 < timeoutMs) {
      const pkg = await focusPkg();
      if (pkg) {
        if (expected && pkg === expected) return pkg;
        if (!expected && pkg !== before && !LAUNCHER_PKG.test(pkg) && !SYSTEM_PKG.test(pkg)) return pkg;
      }
      await sleep(c.verify.intervalMs);
    }
    return '';
  }

  async function observe() {
    try {
      const o = await adb.observe({ shot: false });
      return o && o.ok !== false ? o : null;
    } catch { return null; }
  }

  async function tapXY(x, y) {
    try {
      const r = await adb.tapXY(x, y);
      return r || { ok: false };
    } catch { return { ok: false }; }
  }

  async function key(name) {
    try { await adb.key(name); } catch { /* 按不动就退回"看当前屏" */ }
  }

  /** 点一个节点，然后验前台包名。`pkg` 为空 = 没换 App（不算成功）。 */
  async function tapAndVerify(hit, { before, obs } = {}) {
    const target = clickableAncestor(obs, hit) || hit;
    const ct = centerOf(target);
    if (!ct) return { pkg: '', target };
    const r = await tapXY(ct[0], ct[1]);
    if (!r || r.ok === false) return { pkg: '', target };
    const pkg = await waitApp('', { before, timeout: Math.min(2000, c.verify.timeoutMs) });
    return { pkg, target };
  }

  async function swipeUp() {
    const d = c.drawer;
    const st = await stateOf();
    const screen = (st && st.screen) || {};
    const w = Number(screen.width) || 720;
    const h = Number(screen.height) || 1280;
    const x = Math.round(w / 2);
    try {
      if (typeof adb.swipe === 'function') {
        await adb.swipe(x, Math.round(h * d.fromY), x, Math.round(h * d.toY), Number(d.ms) || 280);
      } else if (typeof adb.swipeDir === 'function') {
        await adb.swipeDir('up', { screen, ms: Number(d.ms) || 280 });
      }
    } catch { /* 划不动就走下一页 */ }
  }

  function onLauncher(obs) {
    return LAUNCHER_PKG.test(String((obs && obs.app && obs.app.package) || ''));
  }

  function success(how, pkg, extra = {}) {
    return { ok: true, how, pkg: String(pkg || ''), ...extra };
  }

  /**
   * 打开一个 App。**别抛**：所有失败都落在 `{ok:false, reason}` 上（`doQuick` 按 `reason` 决定收还是交还主循环）。
   *
   * @param {string} name 他/她说的名字（"相册" / "B站" / "打开菜谱看看" / 包名）
   * @returns {Promise<{ok:boolean, how?:string, pkg?:string, label:string, reason?:string, tried?:string[], ms:number}>}
   */
  async function open(name, { task = null, obs = null } = {}) {
    const t0 = Date.now();
    const raw = String(name || '');
    const label = normalizeLabel(raw);
    if (!label) return { ok: false, reason: 'no-label', label: raw, tried: [], ms: 0 };
    if (task && task.stopped) return { ok: false, reason: 'stopped', label, tried: [], ms: 0 };
    const tried = [];
    const budget = (n) => Number(n) || 0;
    void budget;

    /** 锁屏/息屏先点亮，否则接下来每一下都点空。 */
    if (typeof adb.wake === 'function') { try { await adb.wake(); } catch { /* 亮不了也接着试 */ } }
    const st0 = await stateOf();
    const before = String((st0 && st0.app && st0.app.package) || '');
    const screen = (st0 && st0.screen) || {};
    if (store && typeof store.sync === 'function') {
      try { store.sync({ serial: st0 && st0.serial, width: screen.width, height: screen.height }); } catch { /* 学到的入口不参考 */ }
    }
    const rec = store && typeof store.get === 'function' ? store.get(label) : null;

    /* ① 缓存：上次验过的包名，直接 launch + 验前台 */
    if (rec && rec.pkg) {
      tried.push(`cache:${rec.pkg}`);
      const r = await launchPkg(rec.pkg);
      if (r.ok) {
        const got = await waitApp(rec.pkg, { before });
        if (got) {
          if (store) store.put(label, { hit: 'cache' });
          say(`「${label}」走缓存（${rec.pkg}）`);
          return { ...success('cache', got, { label, screenLabel: rec.screenLabel || '' }), tried, ms: Date.now() - t0 };
        }
      }
    }

    /* ② 别名 / 包名（0 模型） */
    const searchLabel = (rec && rec.screenLabel) || label;
    const r2 = await launchPkg(searchLabel);
    if (r2.ok) {
      const expect = r2.pkg && !LAUNCHER_PKG.test(String(r2.pkg)) ? String(r2.pkg) : '';
      const got = await waitApp(expect, { before });
      if (got) {
        if (store) store.put(label, { pkg: expect || got, entry: 'alias', screenLabel: searchLabel });
        say(`「${label}」用别名开起来了（${expect || got}）`);
        return { ...success('alias', expect || got, { label, screenLabel: searchLabel }), tried, ms: Date.now() - t0 };
      }
      tried.push(`alias:${searchLabel}:nochange`);
    } else {
      tried.push(`alias:${searchLabel}:${r2.msg || 'fail'}`);
    }

    /* ③ 当前屏 → 回桌面 → 开抽屉，看屏上的字点（0 模型） */
    let o = obs && obs.ok !== false ? obs : await observe();
    if (!o) return { ok: false, reason: 'adb', label, tried, ms: Date.now() - t0 };
    if (!onLauncher(o)) {
      await key('home');
      await sleep(c.settleMs);
      o = (await observe()) || o;
    }
    let foundAnywhere = false;
    let found = findLabel(o, searchLabel, surface);
    if (found) {
      foundAnywhere = true;
      const t = await tapAndVerify(found.hit, { before, obs: o });
      if (t.pkg) {
        learn(label, { pkg: t.pkg, entry: 'home', screenLabel: found.usedLabel, hit: found.hit, screen, label });
        say(`「${label}」在桌面上点开了（${found.usedLabel} → ${t.pkg}）`);
        return { ...success('home', t.pkg, { label, screenLabel: found.usedLabel, target: t.target }), tried, ms: Date.now() - t0 };
      }
      tried.push(`screen:${found.usedLabel}:nochange`);
    }

    /** 开抽屉（唯一需要真机调的手势）。 */
    const d = c.drawer;
    const drawerSettle = Number.isFinite(Number(d.settleMs)) ? Math.max(0, Number(d.settleMs)) : 700;
    let opened = false;
    let cur = o;
    for (let i = 0; i < Math.max(1, Number(d.tries) || 1); i++) {
      await swipeUp();
      await sleep(drawerSettle);
      const next = await observe();
      if (!next) break;
      opened = drawerOpen(cur, next);
      cur = next;
      if (opened) break;
    }
    const pages = Math.max(1, Number(c.drawerPages) || 1);
    for (let page = 0; page < pages; page++) {
      const hit = findLabel(cur, searchLabel, surface);
      if (hit) {
        foundAnywhere = true;
        const t = await tapAndVerify(hit.hit, { before, obs: cur });
        if (t.pkg) {
          const xy = centerOf(t.target);
          learn(label, {
            pkg: t.pkg,
            entry: 'drawer',
            page,
            screenLabel: hit.usedLabel,
            hit: hit.hit,
            screen,
            label,
            xy: xy && screen.width && screen.height
              ? [Number((xy[0] / screen.width).toFixed(3)), Number((xy[1] / screen.height).toFixed(3))]
              : null,
          });
          say(`「${label}」在抽屉第 ${page + 1} 屏点开了（${hit.usedLabel} → ${t.pkg}）`);
          return {
            ...success('drawer', t.pkg, { label, page, screenLabel: hit.usedLabel, target: t.target }),
            tried,
            ms: Date.now() - t0,
          };
        }
        tried.push(`drawer:${hit.usedLabel}:p${page}:nochange`);
      }
      /** 翻一屏（翻不动就停，别死循环）。 */
      const prevHash = cur && cur.hash;
      await swipeUp();
      await sleep(Math.min(600, drawerSettle));
      const next = await observe();
      if (!next) break;
      if (prevHash && next.hash && next.hash === prevHash) break;
      cur = next;
    }

    /**
     * ④ 截图问坐标 —— **只有"树里没有字"才发**。
     * 树里有那个字、点了却没换 App（点偏了/被挡住）→ 不花这次钱，交给主循环。
     */
    if (!foundAnywhere && askLocate && c.locate.maxPerTask > 0) {
      const spent = Number(task && task.locateCalls) || 0;
      if (spent < c.locate.maxPerTask) {
        try {
          if (task) task.locateCalls = spent + 1;
          const shot = await adb.screenshot({ save: '' });
          if (shot && shot.ok && shot.png) {
            const v = await askLocate({ shot, label, screen: (cur && cur.screen) || screen });
            if (v && Number.isFinite(v.x) && Number.isFinite(v.y)) {
              const w = Number(((cur && cur.screen) || screen).width) || 720;
              const h = Number(((cur && cur.screen) || screen).height) || 1280;
              await tapXY(v.x * w, v.y * h);
              const got = await waitApp('', { before });
              if (got) {
                if (store) {
                  store.put(label, {
                    pkg: got, entry: 'vlm', xy: [v.x, v.y], screenLabel: searchLabel,
                  });
                }
                say(`「${label}」靠截图问坐标点开了（${got}）`);
                return { ...success('vlm', got, { label, screenLabel: searchLabel }), tried, ms: Date.now() - t0 };
              }
              tried.push('vlm:nochange');
            } else {
              tried.push('vlm:none');
            }
          } else {
            tried.push('vlm:shot-failed');
          }
        } catch (err) {
          tried.push(`vlm:${err.message}`);
        }
      }
    }

    /* ⑤ 没找到 */
    if (store && typeof store.miss === 'function') store.miss(label);
    say(`「${label}」没找到（试过：${tried.join(' / ') || '无'}）`);
    return { ok: false, reason: 'not-found', label, tried, ms: Date.now() - t0 };
  }

  async function launchPkg(spec) {
    try {
      const r = await adb.launch(spec);
      return r || { ok: false, msg: 'adb 没回话' };
    } catch (err) {
      return { ok: false, msg: err.message };
    }
  }

  /** 写缓存前先过 `learnable()`（点对了 ≠ 点开了东西）。 */
  function learn(label, { pkg, entry, page, screenLabel, hit, screen, xy } = {}) {
    if (!store || !c.learn.enabled) return null;
    if (!pkg) return null;
    if (hit && !learnable(hit, screenLabel, screen)) return null;
    return store.put(label, {
      pkg,
      entry,
      ...(Number.isFinite(page) ? { page } : {}),
      ...(screenLabel ? { screenLabel } : {}),
      ...(xy ? { xy } : {}),
    });
  }

  return { open, waitApp, findLabel, normalizeLabel, config: c, canVerify };
}

module.exports = {
  createOpener, createStore, normalizeLabel, aliasCands, findLabel,
  clickableAncestor, learnable, drawerOpen, centerOf,
  SCREEN_ALIASES, LAUNCHER_PKG, SYSTEM_PKG, DEFAULTS,
};
