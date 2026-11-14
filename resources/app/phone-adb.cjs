/**
 * 她的手机 · adb 通道（P0，2026-10-30）
 *
 * 这是「桌宠 → 一部真的安卓手机」的手，不含任何模型调用：
 *   · 只用 Node 标准库 + MuMu 自带的 adb.exe，不装 Python / scrcpy / appium；
 *   · 观测 = 截图 + 控件树压成「动作表」（给模型的是一行一个可点项，不是 20KB XML）；
 *   · 动作优先按 ref（语义），坐标只做兜底；
 *   · 每个动作都能验（ui_hash 变了没有），失败会说实话，不假装成功。
 *
 * 设计取自 `default-workspace/android-takeover`（另一个 AI 的调研 + 实测），
 * 但把 Python 换成了 Node —— 桌宠本身就是 Node/Electron，少一个运行时依赖。
 *
 * 用法（`tools/phone.cjs` 是它的命令行）：
 *   const { PhoneAdb } = require('./phone-adb.cjs');
 *   const phone = new PhoneAdb();
 *   const obs = await phone.observe({ shot: true });
 *   await phone.tap(obs.nodes[0].ref, { verify: true });
 *
 * 自检：`node tools/phone.cjs probe`（要模拟器开着）。
 */
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
/**
 * ★ 2026-11-12：**别名表的唯一数据源**（`phone-apps` 不依赖 adb，所以不会循环 require）。
 * 这里只借它的 `packagesFor()` / `SCREEN_ALIASES`；`APP_NAMES` 仍然是本文件的"兼容视图"。
 */
const phoneApps = require('./phone-apps.cjs');

/**
 * MuMu 的位置**不写死**。
 *
 * ★ 2026-10-30 实测：用户重装了"绿色版" MuMu（5.22.0.3094，`D:\mumulvse\MuMuPlayer`），
 * 目录结构和旧版完全不同 —— 旧版是 `shell\adb.exe` / `shell\MuMuManager.exe` /
 * `shell\MuMuPlayer.exe`；新版本是
 *
 *   nx_main\adb.exe              ← adb
 *   nx_main\MuMuManager.exe      ← 命令行管理器（info / control / sh / adb）
 *   nx_main\MuMuNxMain.exe       ← 多开管理器 GUI（用户双击就是它）
 *   nx_device\12.0\shell\MuMuNxDevice.exe   ← 真正那台"手机"的窗口进程
 *
 * 老代码写死 `shell\` → `D:\Program Files\Netease\...`，重装后 adb.exe 根本不存在，
 * 于是 `connect()` 立刻失败（10 ms 返回），第 3 挡点了什么都不会发生。
 * 所以这里改成：环境变量 → 调用方给的 home → 候选表 → 扫盘，都找不到才算失败；
 * 找到之后 `companion.cjs` 会把路径写回 `config\companion.json` 的 `phone.home`。
 */
const DEFAULTS = {
  home: '',
  adb: '',                       // 空 = 自动（nx_main\adb.exe 优先）
  manager: '',                   // 空 = 自动（nx_main\MuMuManager.exe）
  player: '',                    // 空 = 自动（nx_main\MuMuNxMain.exe / shell\MuMuPlayer.exe）
  vmindex: 0,
  serial: '',                    // 空 = 问 MuMuManager 要 adb_port
  /**
   * ★ 2026-11-07：40 → 60。用户放开 token 之后，网页/结果页多给 20 条
   * （她原来只能看见前 40 个可点/大块节点，后面的条目根本不在表里，
   * 于是"这一屏没有那个"其实只是"没列出来"）。
   */
  maxNodes: 60,
  /**
   * ★ 2026-10-31（自己会玩·层 0）：`uiautomator dump` 的硬超时 20s → 9s。
   * 遇到持续重绘/加载页时它会一直等 idle，20 秒白等一次，一个 12 步的任务能白等掉 4 分钟。
   * 现在超时更短，且**连挂 2 次就 `adb reconnect`**（见 `uiXml()`）。
   */
  dumpTimeoutMs: 9000,
  shotTimeoutMs: 20000,
  /**
   * ★ 2026-10-31（层 0）：截图小于这个字节数就当"没截到"。
   *
   * `FLAG_SECURE` 的界面（支付、部分视频）`screencap` 会返回一张**纯黑图**，exit code 还是 0；
   * 旧代码只验 PNG 魔数，于是黑图被当成"画面没变"——一路空转，还把它当截图发给他。
   * 720×1280 的真截图一般 80~250 KB，10 KB 以下是空白/黑屏。
   */
  minShotBytes: 10 * 1024,
};

/** 每个盘符下要试的相对目录（新版在前，老版在后；大小写不敏感地再比一次）。 */
const HOME_HINTS = [
  'mumulvse\\MuMuPlayer',
  'Program Files\\Netease\\MuMu Player 12',
  'Program Files (x86)\\Netease\\MuMu Player 12',
  'Program Files\\Netease\\MuMuPlayer',
  'Program Files\\Netease\\MuMuPlayer-12.0',
  'Program Files (x86)\\Netease\\MuMuPlayer',
  'Netease\\MuMuPlayer',
  'MuMuPlayer',
  'MuMu\\MuMuPlayer',
  'mumu\\MuMuPlayer',
  'Program Files\\Netease\\MuMuPlayer\\shell',
];

/** `<dir>` 看起来是个 MuMu 安装根（新旧两种 layout 都认）。 */
function isMuMuHome(dir) {
  if (!dir) return false;
  try {
    if (!fs.existsSync(dir)) return false;
    return [
      'nx_main\\MuMuManager.exe',
      'nx_main\\MuMuNxMain.exe',
      'shell\\MuMuManager.exe',
      'shell\\MuMuPlayer.exe',
      'nx_device',
      'configs\\install_config.json',
    ].some((rel) => fs.existsSync(path.join(dir, rel)));
  } catch {
    return false;
  }
}

/** 读 `configs\install_config.json`（新版本才有；给出版本号和 nx_device 目录）。 */
function readInstallInfo(home) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(home, 'configs', 'install_config.json'), 'utf8'));
    const p = raw.player || {};
    return {
      version: raw.product?.version || p.version || '',
      series: String(p.nx_device_dir || 'nx_device\\12.0').split(/[\\/]/).pop() || '12.0',
      playerDir: p.install_dir || '',
      product: raw.product?.product || '',
      engine: raw.product?.engine || '',
    };
  } catch {
    return null;
  }
}

/**
 * 扫盘找安装根。只扫两层，且二分之一的目录名要像 MuMu/Netease/Program Files 才往下看 ——
 * 这个函数每个进程只跑一次（结果缓存），但不能在桌宠启动路径上耗时超过几十毫秒。
 */
function scanForHome() {
  const drives = [];
  for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
    try {
      if (fs.existsSync(`${letter}:\\`)) drives.push(`${letter}:\\`);
    } catch { /* 没这个盘 */ }
  }
  const shallow = /(mumu|netease|emulator|android|模拟器|程序|program files|games?|games)/i;
  for (const root of drives) {
    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
    } catch { continue; }
    for (const d of entries) {
      const one = path.join(root, d.name);
      if (isMuMuHome(one)) return one;
      if (!shallow.test(d.name)) continue;
      let subs = [];
      try {
        subs = fs.readdirSync(one, { withFileTypes: true }).filter((x) => x.isDirectory());
      } catch { /* 没权限 */ }
      for (const s of subs) {
        const two = path.join(one, s.name);
        if (isMuMuHome(two)) return two;
      }
    }
  }
  return '';
}

/** 走一遍所有线索，找到安装根就记住（模块级缓存，一次进程只扫一次盘）。 */
const discovered = { home: '', at: 0, tried: [] };
function discoverHome({ home = '', rescan = false } = {}) {
  const explicit = String(home || process.env.DSP_MUMU_HOME || '').trim();
  if (explicit && isMuMuHome(explicit)) return explicit;
  if (discovered.home && !rescan) return discovered.home;
  const tried = [];
  for (const rel of HOME_HINTS) {
    for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
      const p = `${letter}:\\${rel}`;
      tried.push(p);
      if (isMuMuHome(p)) {
        discovered.home = p;
        discovered.at = Date.now();
        discovered.tried = tried;
        return p;
      }
    }
  }
  const hit = scanForHome();
  tried.push('（扫盘）');
  discovered.tried = tried;
  if (hit) {
    discovered.home = hit;
    discovered.at = Date.now();
    return hit;
  }
  return explicit || '';
}

/** 第一个存在的候选（也接受绝对路径）。 */
function firstExisting(base, list) {
  for (const rel of list) {
    if (!rel) continue;
    const p = path.isAbsolute(rel) ? rel : path.join(base, rel);
    try {
      if (fs.existsSync(p)) return p;
    } catch { /* 路径里有怪字符 */ }
  }
  return '';
}

/** 进程还在不在（Windows 上 `process.kill(pid, 0)` 会抛 ESRCH；EPERM 说明活着只是没权限）。 */
function pidAlive(pid) {
  const n = Number(pid) || 0;
  if (n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (err) {
    return err && err.code === 'EPERM';
  }
}

/** 端口通不通（**不经过 adb**，冷启动时 adb 还没法连，这个先能用）。 */
function tcpOpen(host, port, timeout = 400) {
  return new Promise((resolve) => {
    const net = require('node:net');
    const sock = new net.Socket();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch { /* 已经关了 */ }
      resolve(ok);
    };
    sock.setTimeout(timeout);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    try { sock.connect(Number(port), host || '127.0.0.1'); } catch { finish(false); }
  });
}

/** 按键表：和 android-takeover 一致，只留手机常用的。 */
const KEYS = {
  back: 4, home: 3, recents: 187, menu: 82, enter: 66, delete: 67, space: 62,
  tab: 61, escape: 111, power: 26, wakeup: 224, sleep: 223,
  volume_up: 25, volume_down: 24, mute: 164, camera: 27,
};

/** 系统包 → 她嘴里会说的名字（不认识的退回包名最后一段）。 */
const APP_NAMES = {  'com.android.settings': '设置',
  'com.android.browser': '浏览器',
  'com.android.camera2': '相机',
  'com.android.gallery3d': '相册',
  /**
   * ★ 2026-11-11：她自己的日记本（`launch 她的日记本` / `launch 日记本` 都能开）。
   * `packagesFor()` 是按"名字相等或包含"找的，所以 `日记` / `日记本` 也会命中这一条。
   */
  'com.bluefish.diary': '她的日记本',
  'com.android.documentsui': '文件',
  'com.android.shell': '系统界面',
  'com.android.packageinstaller': '安装器',
  'com.android.permissioncontroller': '权限',
  'com.sohu.inputmethod.sogou.chuizi': '输入法',
  'com.mumu.launcher': '桌面',
  'com.android.systemui': '系统界面',
  /** ★ 2026-10-30：MuMu 5.22 的桌面换成了 Lawnchair（不是 com.mumu.launcher）。 */
  'app.lawnchair': '桌面',
  'mark.via': '浏览器',
  'mark.via.gp': '浏览器',
  'com.android.vending': '应用商店',
  /**
   * ★ 2026-11-12：**这台机器真正的商店**（桌面上的「应用商店」图标就是它）。
   * 旧表里只有 `com.android.vending`，所以 `launch 应用商店` 只会去拉那个空壳 Google 商店。
   */
  'com.lenovo.leos.appstore': '应用商店',
  /** ★ 2026-11-12：`APP_LIST` 里有壁纸、旧表里没有这个包 → `launch 壁纸` 直接"不认识"。 */
  'com.android.wallpaper': '壁纸',
  'com.netease.mumu.store': '游戏中心',
  'com.tencent.mm': '微信',
  'com.tencent.mobileqq': 'QQ',
  'com.taobao.taobao': '淘宝',
  'com.eg.android.AlipayGphone': '支付宝',
  'com.ss.android.ugc.aweme': '抖音',
  'tv.danmaku.bili': '哔哩哔哩',
  'com.netease.cloudmusic': '网易云音乐',
  'com.android.deskclock': '时钟',
  'com.android.calculator2': '计算器',
};

/**
 * 名字 / 包名 → 要试的包列表（`launch` / `forceStop` 共用）。
 *
 * 同一个中文名可能对应好几个包（`浏览器` 既有 `com.android.browser` 又有 `mark.via`），
 * 所以返回**列表**，调用方逐个试。
 *
 * ★ 2026-11-12（P0）：**别名只有一份数据源**（`phone-apps.cjs` 的 `APP_LIST`）。
 *
 * 以前这里查自己的 `APP_NAMES`，而 `APP_LIST` 里有的「壁纸」、他真会说的「B站」
 * 这张表里都没有 → `packagesFor('B站')` 返回空 → `launch` 直接"不认识「B站」"，
 * 一次屏幕都不看就失败（真机"打开B站"就是这么 1 秒死的）。
 * 现在先查 `phone-apps.packagesFor()`，`APP_NAMES` 只当兼容视图（老名字仍然认）。
 */
function packagesFor(spec) {
  const key = String(spec || '').trim();
  if (!key) return [];
  if (/^[a-z][\w.]*\.[\w.]+$/i.test(key)) return [key];
  const out = [];
  const push = (p) => { if (p && !out.includes(p)) out.push(p); };
  try {
    for (const p of (phoneApps ? phoneApps.packagesFor(key) : [])) push(p);
  } catch { /* 数据表坏了也别把 launch 拖死 */ }
  const byName = Object.entries(APP_NAMES)
    .filter(([, name]) => name === key || name.includes(key))
    .map(([pkg]) => pkg);
  for (const p of byName) push(p);
  if (out.length) return out;
  /** 她/模型有时直接说包名里的那截（"Via"）：按包名子串兜一次。 */
  const k = key.toLowerCase();
  const bySuffix = Object.keys(APP_NAMES).filter((pkg) => pkg.toLowerCase().includes(k));
  for (const p of bySuffix) push(p);
  return out;
}

/** 会自己抖的控件：状态栏时钟、进度条、秒表。放进 hash 会让"变了吗"永远为真。 */
const VOLATILE_CLASS = new Set(['ProgressBar', 'Clock', 'Chronometer', 'AnalogClock', 'SeekBar']);
const VOLATILE_TEXT = /^\d{1,2}:\d{2}(:\d{2})?$/;
const BOUNDS_RX = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/;

/* ---------------------------------------------------------------- 基础 */

/**
 * `DSP_PHONE_STDIO=file`：用临时文件当 stdout/stderr，不走管道。
 *
 * 只在被沙箱关掉"子进程管道"的调试环境里用（DSH 的 workspace-write 就是），
 * Electron 里跑不需要 —— 生产路径仍是普通 spawn。
 */
function runViaFile(exe, args, { timeout = 30000, binary = false } = {}) {
  const started = Date.now();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsp-phone-'));
  const outFile = path.join(dir, 'out');
  const fd = fs.openSync(outFile, 'w+');
  let r;
  try {
    r = spawnSync(exe, args, { stdio: ['ignore', fd, fd], windowsHide: true, timeout });
  } finally {
    fs.closeSync(fd);
  }
  let raw = Buffer.alloc(0);
  try { raw = fs.readFileSync(outFile); } catch { /* 没写出来 */ }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 删不掉就留着 */ }
  const err = r.error ? `启动失败: ${r.error.message}` : (r.status === null ? '（超时/被杀）' : '');
  return {
    code: r.error ? -1 : (r.status == null ? -2 : r.status),
    out: binary ? raw : raw.toString('utf8'),
    err,
    ms: Date.now() - started,
  };
}

function run(exe, args, { timeout = 30000, binary = false, cwd } = {}) {
  if (process.env.DSP_PHONE_STDIO === 'file') {
    return Promise.resolve(runViaFile(exe, args, { timeout, binary }));
  }
  return new Promise((resolve) => {
    const started = Date.now();
    let child;
    try {
      child = spawn(exe, args, { windowsHide: true, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ code: -1, out: binary ? Buffer.alloc(0) : '', err: `启动失败: ${err.message}`, ms: 0 });
      return;
    }
    const outChunks = [];
    const errChunks = [];
    let done = false;
    const finish = (code, extra) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const out = binary ? Buffer.concat(outChunks) : Buffer.concat(outChunks).toString('utf8');
      resolve({ code, out, err: Buffer.concat(errChunks).toString('utf8') + (extra || ''), ms: Date.now() - started });
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* 已经没了 */ }
      finish(-2, `\n（超时 ${timeout}ms）`);
    }, timeout);
    timer.unref?.();
    child.stdout.on('data', (d) => outChunks.push(d));
    child.stderr.on('data', (d) => errChunks.push(d));
    child.on('error', (e) => finish(-1, `\n（${e.message}）`));
    child.on('close', (code) => finish(code == null ? -1 : code));
  });
}

/** uiautomator 的转义：`&quot;` `&amp;` `&lt;` `&gt;` `&#10;`。 */
function decodeEntities(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function parseAttrs(text) {
  const out = {};
  const re = /([\w:.-]+)\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(text))) out[m[1]] = decodeEntities(m[2]);
  return out;
}

/**
 * 从 `<node .../>` 的扁平标签流里还原父子关系。
 *
 * 为什么不用 XML 库：Android 的 dump 只有一种标签，而 Node 标准库没有 XML 解析器；
 * 手写一个"引号内不认 >"的扫描器就够了（文本里出现 `>` 不会把标签切坏）。
 */
function parseTree(xml) {
  const nodes = [];
  const stack = [];
  const re = /<(\/?)node\b/gi;
  let m;
  while ((m = re.exec(xml))) {
    const closing = m[1] === '/';
    let i = re.lastIndex;
    if (closing) {
      if (stack.length) stack.pop();
      continue;
    }
    // 扫到 '>'，但跳过引号里的
    let quote = '';
    let end = -1;
    for (; i < xml.length; i++) {
      const ch = xml[i];
      if (quote) { if (ch === quote) quote = ''; continue; }
      if (ch === '"' || ch === "'") { quote = ch; continue; }
      if (ch === '>') { end = i; break; }
    }
    if (end < 0) break;
    const selfClose = xml[end - 1] === '/';
    const attrs = parseAttrs(xml.slice(m.index + 5, selfClose ? end - 1 : end));
    const node = { attrs, parent: stack.length ? stack[stack.length - 1] : -1, children: [] };
    const idx = nodes.push(node) - 1;
    if (node.parent >= 0) nodes[node.parent].children.push(idx);
    if (!selfClose) stack.push(idx);
    re.lastIndex = end + 1;
  }
  return nodes;
}

function boundsOf(attrs) {
  const m = BOUNDS_RX.exec(String(attrs.bounds || ''));
  return m ? m.slice(1, 5).map(Number) : null;
}

/**
 * ★ 2026-10-31：**这一屏真实的画幅**。
 *
 * `wm size` 报的是物理分辨率（720×1280），横屏时它**不变**，可实际能点的范围已经成了
 * 1280×720。照 720 算坐标的后果：`tapxy` 点空、`swipe up` 的起点 y=998 直接落在屏幕外
 * （10-31 上午她掉进游戏中心变横屏之后，后面连着 6 个任务全是"连续几步都没反应"）。
 *
 * 控件树根节点永远是整屏，读它的 bounds 最准、也不用多跑一次 adb。
 * @returns {{width:number,height:number}|null}
 */
function frameOf(xml) {
  const m = /<node[^>]*bounds="\[0,0\]\[(\d+),(\d+)\]"/.exec(String(xml || ''));
  if (!m) return null;
  const width = Number(m[1]);
  const height = Number(m[2]);
  if (!(width > 0 && height > 0)) return null;
  return { width, height };
}

function hashText(parts) {
  return crypto.createHash('sha1').update(parts.join('\n')).digest('hex');
}

/**
 * ★ 2026-11-01：控件树读到的"真实画幅"**只信 60 秒**（见 `state()`）。
 * 转过屏之后 `uiXml()` 连续失败时，旧缓存（横屏）会把后面的点击全点空。
 */
const FRAME_TTL_MS = 60_000;

/* ---------------------------------------------------------------- 主体 */

class PhoneAdb {
  /**
   * @param {object} [opts]
   * @param {string} [opts.home]      MuMu 安装目录
   * @param {string} [opts.serial]    adb 串号（多开时是 16384 + n*32）
   * @param {number} [opts.vmindex]   MuMu 实例号（中文输入要用）
   * @param {number} [opts.maxNodes]  动作表最多几项
   */
  constructor(opts = {}) {
    const home = discoverHome({ home: opts.home });
    this.home = home;
    this.info = home ? readInstallInfo(home) : null;
    const series = this.info?.series || '12.0';
    /**
     * 三个 exe 各自找最像的那一个（新版本 nx_* 优先，老版本 shell\ 兜底）。
     * 全空也不在这里抛错 —— 自检要能把它"看不懂"的样子打印出来。
     */
    this.adbExe = firstExisting(home, [
      process.env.DSP_MUMU_ADB || '',
      opts.adbExe || '',
      'nx_main\\adb.exe',
      `nx_device\\${series}\\shell\\adb.exe`,
      'shell\\adb.exe',
      'adb.exe',
      'adb\\adb.exe',
    ]);
    this.managerExe = firstExisting(home, [
      process.env.DSP_MUMU_MANAGER || '',
      opts.managerExe || '',
      'nx_main\\MuMuManager.exe',
      `nx_device\\${series}\\shell\\MuMuManager.exe`,
      'shell\\MuMuManager.exe',
    ]);
    this.playerExe = firstExisting(home, [
      process.env.DSP_MUMU_PLAYER || '',
      opts.playerExe || '',
      'nx_main\\MuMuNxMain.exe',
      'shell\\MuMuPlayer.exe',
      'MuMuNxMain.exe',
      'MuMuPlayer.exe',
    ]);
    this.deviceExe = firstExisting(home, [
      `nx_device\\${series}\\shell\\MuMuNxDevice.exe`,
      `nx_device\\${series}\\shell\\MuMuDevice.exe`,
      'shell\\MuMuPlayer.exe',
      'shell\\MuMuNxDevice.exe',
    ]);
    this.serial = String(opts.serial || process.env.DSP_MUMU_SERIAL || DEFAULTS.serial || '');
    this._serialAsked = false;
    this.vmindex = Number(opts.vmindex ?? DEFAULTS.vmindex) || 0;
    this.maxNodes = Math.max(5, Number(opts.maxNodes) || DEFAULTS.maxNodes);
    this.dumpTimeoutMs = Number(opts.dumpTimeoutMs) || DEFAULTS.dumpTimeoutMs;
    this.shotTimeoutMs = Number(opts.shotTimeoutMs) || DEFAULTS.shotTimeoutMs;
    this.minShotBytes = Number(opts.minShotBytes) || DEFAULTS.minShotBytes;
    /** ★ 层 0：`uiautomator dump` 连着挂了几次（够 2 次就 reconnect）。 */
    this.dumpFails = 0;
    /** ★ 层 0：`svc power stayon` 是不是被我们打开的（收尾时要还原成 false）。 */
    this.stayOn = false;
    this.lastDumpMs = 0;
  }

  /** 自检/日志用：这台机器上到底找到了什么（**不碰 adb，不花时间**）。 */
  paths() {
    return {
      home: this.home,
      found: !!this.home,
      version: this.info?.version || '',
      series: this.info?.series || '',
      adb: this.adbExe,
      manager: this.managerExe,
      player: this.playerExe,
      device: this.deviceExe,
      serial: this.serial,
      vmindex: this.vmindex,
      missing: [
        ['adb', this.adbExe],
        ['manager', this.managerExe],
        ['player', this.playerExe],
      ].filter(([, p]) => !p).map(([k]) => k),
      scanned: discovered.tried.length,
    };
  }

  /**
   * 问 MuMuManager 要 adb 端口，把 serial 定下来（只在第一次需要 adb 时问一次）。
   * 新版本 `info` 里直接给 `adb_host_ip` / `adb_port`，比"16384 + n*32"那种规律稳。
   */
  async ensureTarget() {
    /**
     * ★ 2026-11-01 修：**别把 serial 钉死在一个猜出来的端口上**。
     *
     * 原来 `_serialAsked` 一置真就再也不问，而 `playerInfo()` 拿不到端口时直接
     * `127.0.0.1:16384` —— 多开实例（`adb_port` 不是 16384）或 `MuMuManager info`
     * 输出前面带了非 JSON 的提示行时，之后**所有** adb 命令都带错的 `-s`，
     * 症状是"设备在线但看不到屏幕"，日志里看不出原因。`reconnect()` 也救不回来
     * （它只清 `_serialAsked`，而 `this.serial` 非空就先短路了）。
     * 现在区分"**问出来的**"和"猜出来的"：猜出来的下次还要再问。
     */
    if (this.serial && this._serialSure) return this.serial;
    if (this._serialAsked && this.serial && !this._serialSure) {
      /** 上次是猜的：允许再问一次，但别在一秒里问上百遍。 */
      if (Date.now() - (this._serialAskedAt || 0) < 5000) return this.serial;
    }
    this._serialAsked = true;
    this._serialAskedAt = Date.now();
    const info = await this.playerInfo();
    const host = String(info?.adb_host_ip || '').trim() || '127.0.0.1';
    const port = Number(info?.adb_port) || 0;
    this.serial = port ? `${host}:${port}` : '127.0.0.1:16384';
    this._serialSure = !!port;
    return this.serial;
  }

  /**
   * 模拟器到底在不在跑。
   *
   * ★ 2026-10-30 实测：MuMu 崩过一次之后，`info` 会一直回 `is_process_started: true` + 一个
   * **早就死掉的 pid**（这台机器上是 984）。旧代码信了这个字段，于是"已经在跑"→ 不启动 →
   * 干等 adb 三分钟 → 报"模拟器没启动完"。所以这里必须自己验：端口通 OR pid 活着。
   */
  async isRunning() {
    const info = await this.playerInfo();
    if (!info) return { running: false, why: 'manager 问不到（路径不对？）', info: null };
    const pid = Number(info.pid) || 0;
    const port = Number(info.adb_port) || 0;
    const alive = pidAlive(pid);
    const portUp = port ? await tcpOpen('127.0.0.1', port, 300) : false;
    const android = !!info.is_android_started;
    return {
      running: alive || portUp,
      alive,
      portUp,
      android,
      /** 字段说在跑、其实进程没了 —— 这种情况要**照样去启动**。 */
      stale: !!info.is_process_started && !alive,
      port,
      pid,
      info,
    };
  }

  /** 等 adb 端口监听（冷启动几秒就开，比等 boot_completed 早得多）。 */
  async waitPort({ timeoutMs = 30000, intervalMs = 800 } = {}) {
    const t0 = Date.now();
    const port = Number(String(this.serial).split(':')[1]) || 16384;
    while (Date.now() - t0 < timeoutMs) {
      if (await tcpOpen('127.0.0.1', port, 300)) return { ok: true, ms: Date.now() - t0 };
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    return { ok: false, ms: Date.now() - t0 };
  }

  /* ---- 底层 ---- */

  async adb(args, { timeout = 30000, binary = false } = {}) {
    /**
     * ★ 必须先定 serial 再跑：MuMu 5.22 一次会注册两个设备（`127.0.0.1:16384` 和
     * `emulator-5554`），不带 `-s` 的 adb 会直接回 "more than one device/emulator"。
     */
    await this.ensureTarget();
    if (!this.adbExe) {
      return Promise.resolve({
        code: -3,
        out: binary ? Buffer.alloc(0) : '',
        err: `没找到 adb.exe（MuMu 装在哪？home=${this.home || '空'}；跑 tools\\phone.cjs doctor 看细节）`,
        ms: 0,
      });
    }
    const list = [];
    if (this.serial) list.push('-s', this.serial);
    return run(this.adbExe, list.concat(args.map(String)), { timeout, binary });
  }

  sh(command, opts) {
    return this.adb(['shell', command], opts);
  }

  /** 连一下（幂等）。返回 { ok, msg, ms }。 */
  async connect() {
    await this.ensureTarget();
    const r = await this.adb(['connect', this.serial], { timeout: 10000 });
    const blob = `${r.out}${r.err}`.toLowerCase();
    const ok = r.code === 0 && (blob.includes('connected') || blob.includes('already'));
    return { ok, msg: `${r.out}${r.err}`.trim(), ms: r.ms };
  }

  /** 轻量状态：不 dump，不截图。约 0.3 s。 */
  async state() {
    await this.ensureTarget();
    const [dev, boot, size, dens, focus] = await Promise.all([
      this.adb(['devices'], { timeout: 8000 }),
      this.sh('getprop sys.boot_completed', { timeout: 8000 }),
      this.sh('wm size', { timeout: 8000 }),
      this.sh('wm density', { timeout: 8000 }),
      /** ★ 2026-11-08 夜：**只认 display 0**（`dumpsys window` 会把别的 display 里残留的窗口也列出来）。 */
      this.sh("dumpsys window displays | grep -E 'Display: mDisplayId|mCurrentFocus'", { timeout: 8000 }),
    ]);
    const online = /device\b/.test(String(dev.out)) && !/offline/.test(String(dev.out));
    const booted = String(boot.out).trim() === '1';
    const sm = /(\d+)x(\d+)/.exec(String(size.out));
    const dm = /(\d+)/.exec(String(dens.out));
    const fm = this.parseFocus ? this.parseFocus(focus.out) : null;
    /**
     * ★ 横屏时 `wm size` 还是竖屏尺寸，用上一帧控件树读到的真实画幅盖掉它。
     * 每一轮 `observe()` 都会刷新这个缓存，所以转过屏之后下一步就对上了。
     *
     * ★ 2026-11-01：**这个缓存会馊**。上一帧是横屏（1280×720），你转回竖屏之后
     * 如果 `uiXml()` 一直失败（`observe()` 以前只在成功时才更新），`state()` 会**一直**
     * 报横屏 → `tapxy` / `swipeDir` 按横屏坐标点 → 全点空。
     * 所以缓存带时间戳：超过 `FRAME_TTL_MS` 就不信它，退回 `wm size`。
     */
    const base = { width: sm ? Number(sm[1]) : null, height: sm ? Number(sm[2]) : null, density: dm ? Number(dm[1]) : null };
    const fresh = this.frame && this.frame.width && this.frame.height
      && Date.now() - (Number(this.frame.at) || 0) <= FRAME_TTL_MS;
    const screen = fresh
      ? { ...base, width: this.frame.width, height: this.frame.height }
      : base;
    return {
      online,
      booted,
      serial: this.serial,
      screen,
      app: {
        package: fm ? fm.pkg : '',
        activity: fm ? fm.act : '',
        name: this.appName(fm ? fm.pkg : ''),
      },
      /** ★ 2026-11-01：上一次控件树花了多久（`lastDumpMs` 原来只写不读）。 */
      dumpMs: Number(this.lastDumpMs) || 0,
    };
  }

  /**
   * ★ 2026-11-08 夜（真机 23:15 / 23:29 三次「回不到首页」的真正原因）：
   * **前台 App 认成了别的窗口。**
   *
   * 实测这台模拟器：B 站明明在最前面，
   *   `dumpsys window | grep mCurrentFocus`（旧代码就是这么问的）会输出**两行**：
   *     `mark.via/mark.via.Shell`（残留/另一个 display 的窗口）
   *     `tv.danmaku.bili/tv.danmaku.bili.MainActivityV2`（真正在前台的那个）
   * 而旧代码取**第一个** `包/Activity` → 永远报成"浏览器"。
   * 后果：`home()` 里"我在 B 站首页吗"永远判否 → 连按三次 back 把 B 站**退出去** → 判"回不到首页"；
   * `whereAmI()` 也一直按"浏览器"给她提示。
   *
   * 现在只认 `dumpsys window displays` 里 **`mDisplayId=0`** 那一块（那是用户真看的那块屏）；
   * 没有 display 0 的块就退到"最后一条"（不是第一条 —— 第一条最容易是残留）。
   */
  parseFocus(out) {
    const lines = String(out || '').split('\n');
    let display = '';
    let primary = null;
    let last = null;
    for (const line of lines) {
      const d = /mDisplayId=(\d+)/.exec(line);
      if (d) { display = d[1]; continue; }
      const m = /mCurrentFocus=Window\{[^}\n]*?\s([\w.]+)\/([\w.$]+)\}/.exec(line);
      if (!m) continue;
      const hit = { pkg: m[1], act: m[2] };
      if (!primary && display === '0') primary = hit;
      last = hit;
    }
    return primary || last;
  }

  appName(pkg) {
    const p = String(pkg || '');
    if (!p) return '';
    if (APP_NAMES[p]) return APP_NAMES[p];
    const last = p.split('.').pop() || p;
    return last;
  }

  /* ---- 观测 ---- */

  /**
   * 控件树 XML：`/dev/tty` 直读，省掉落盘 + pull 一次往返。
   *
   * ★ 2026-10-31（层 0）三处加固：
   *   1. 先试 `dump --compressed`：`--compressed` 不绕过 idle 检查（那是个讹传），但它吐的 XML 更小、
   *      `/dev/tty` 这一趟更快；Android 12 支持，不支持时自动退到不带参数的老写法；
   *   2. 单次硬超时（默认 9s）：持续重绘/加载页会一直等 idle，旧版一次白等 20 秒；
   *   3. **连着挂 2 次就 `adb reconnect`**：跑够 40 分钟 adb 偶发掉线，旧版只会一路"看不到屏幕"。
   */
  async uiXml() {
    let total = 0;
    /**
     * ★ 2026-11-01：**给整次 dump 一个总预算**。
     *
     * 原来每条路各带 `dumpTimeoutMs`（9 秒）：tty 两条 + 文件兜底两条（写 + 读）
     * 最坏叠成 **27~36 秒**，而"一件小事 45 秒"的预算只在**步与步之间**检查
     * （`runOnce` 的循环头），所以一步就能把它吃光，会话时间记账完全失真 ——
     * 日志里只会看到他以为"这件事怎么做了这么久"。
     * 现在总预算 = 2 × 单次超时：超过就直接放弃兜底，让上层按"这一屏没看到"处理。
     */
    const deadline = Date.now() + Math.max(3000, this.dumpTimeoutMs * 2);
    const over = () => Date.now() > deadline;
    for (const args of [['dump', '--compressed', '/dev/tty'], ['dump', '/dev/tty']]) {
      if (over()) break;
      const r = await this.adb(['exec-out', 'uiautomator', ...args], { timeout: this.dumpTimeoutMs });
      total += r.ms;
      const xml = String(r.out || '');
      if (r.code === 0 && xml.includes('<hierarchy')) {
        this.dumpFails = 0;
        return { xml: this.#trimXml(xml), ms: total };
      }
      // 不带 --compressed 都不行，再往下的文件兜底也不会更好 —— 但旧机可能只认写文件，接着试
      if (r.code === -2) break;       // 超时：再试一次只是再白等 9 秒
    }
    // 兜底：写文件再读（老版本 / /dev/tty 不给时）
    if (!over()) {
      for (const target of ['/sdcard/_dsh_ui.xml', '/data/local/tmp/_dsh_ui.xml']) {
        if (over()) break;
        const w = await this.sh(`uiautomator dump ${target}`, { timeout: this.dumpTimeoutMs });
        total += w.ms;
        if (w.code !== 0) continue;
        if (over()) break;
        const c = await this.adb(['exec-out', 'cat', target], { timeout: this.dumpTimeoutMs });
        total += c.ms;
        if (String(c.out).includes('<hierarchy')) {
          this.dumpFails = 0;
          return { xml: this.#trimXml(String(c.out)), ms: total };
        }
      }
    }
    /**
     * 连着挂：第 2 次起就重连一次（不 await，别让这一屏再多等 10 秒；
     * 下一次 `state()` 会走 `ensureTarget` 看到新连上的设备）。
     */
    this.dumpFails += 1;
    if (this.dumpFails >= 2) {
      this.dumpFails = 0;
      this.reconnect().catch(() => {});
    }
    return { xml: '', ms: total, error: '控件树拿不到（界面持续重绘，或 Flutter/游戏/WebView 自绘）' };
  }

  /** 从 adb 输出里切出 `<hierarchy>…</hierarchy>`（`--compressed` 会带别的噪声）。 */
  #trimXml(raw) {
    const xml = String(raw || '');
    const start = xml.indexOf('<hierarchy');
    const end = xml.indexOf('</hierarchy>');
    if (start < 0 || end <= start) return '';
    return xml.slice(start, end + '</hierarchy>'.length);
  }

  /**
   * ★ 2026-10-31（层 0）：adb 掉线自救。
   * 先 `reconnect offline`（清掉 offline 态），再 `connect` + `wait-for-device`。
   */
  async reconnect() {
    try {
      await this.adb(['reconnect', 'offline'], { timeout: 10000 });
      await this.adb(['connect', this.serial], { timeout: 10000 });
      await this.adb(['wait-for-device'], { timeout: 20000 });
      this._serialAsked = false;
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  /**
   * ★ 2026-10-31（层 0）：会话期间别让屏幕睡。
   *
   * 实测这台机器 `screen_off_timeout=60000`、`mStayOn=false` —— 会话中间停顿超过 60 秒屏幕就睡，
   * 后面每一步都在对着黑屏点。`svc power stayon true` 实测有效（`mStayOn=true`，而且会主动亮屏）；
   * 它只影响"插着电时不睡"，模拟器一直算插电，所以正好。
   * **用完必须 `stayOn(false)` 还原**，别改了他的机器。
   */
  async stayOn(on = true) {
    const want = !!on;
    const r = await this.sh(`svc power stayon ${want ? 'true' : 'false'}`, { timeout: 8000 });
    if (r.code === 0) this.stayOn = want;
    return { ok: r.code === 0, stayOn: this.stayOn };
  }

  /**
   * 把 a11y 树压成「动作表」。四道筛子，每道都不丢"能点什么"：
   *   1. 只留有语义或可交互的（文字/描述/可点/可编辑/可滚/可勾）
   *   2. 丢掉零面积与完全在屏幕外的
   *   3. 同 bounds 去重（Android 套娃 FrameLayout 极常见）
   *   4. 被「有文字的可点祖先」几乎完全包住的子节点丢掉（文字已经上移）
   * 最后按 可点 > 面积 > 靠屏心 排序，截断到 maxNodes。
   */
  buildTable(xml, { screen } = {}) {
    const all = parseTree(xml);
    if (!all.length) return { nodes: [], thin: true };

    const screenOf = screen || {};
    const sw = Number(screenOf.width) || 0;
    const sh = Number(screenOf.height) || 0;
    const classOf = (n) => String(n.attrs.class || '').split('.').pop();

    const raw = [];
    for (let i = 0; i < all.length; i++) {
      const n = all[i];
      const a = n.attrs;
      const text = String(a.text || '').trim();
      const desc = String(a['content-desc'] || '').trim();
      const cls = String(a.class || '');
      const clickable = a.clickable === 'true';
      const longClick = a['long-clickable'] === 'true';
      const editable = /EditText$|AutoCompleteTextView$/.test(cls) || a['class'] === 'android.widget.EditText';
      const scrollable = a.scrollable === 'true';
      const checkable = a.checkable === 'true';
      if (!(text || desc || clickable || editable || scrollable || checkable)) continue;
      const b = boundsOf(a);
      if (!b) continue;
      const [x1, y1, x2, y2] = b;
      if (x2 - x1 <= 1 || y2 - y1 <= 1) continue;
      if (sw && sh && (x2 <= 0 || y2 <= 0 || x1 >= sw || y1 >= sh)) continue;
      raw.push({
        i, text, desc, cls,
        simple: cls.split('.').pop(),
        clickable, longClick, editable, scrollable,
        checkable, checked: a.checked === 'true',
        selected: a.selected === 'true',
        enabled: a.enabled !== 'false',
        password: a.password === 'true',
        bounds: b,
        area: (x2 - x1) * (y2 - y1),
        pkg: String(a.package || ''),
      });
    }

    // 可点容器吸掉子节点的文字：不做这步，模型看到的是一排匿名 LinearLayout
    for (const n of raw) {
      if (!n.clickable || n.text || n.desc) continue;
      const kids = [];
      const walk = (idx) => {
        for (const c of all[idx].children) {
          const t = String(all[c].attrs.text || '').trim() || String(all[c].attrs['content-desc'] || '').trim();
          if (t && !kids.includes(t)) kids.push(t);
          if (kids.length >= 3) return;
          walk(c);
        }
      };
      walk(n.i);
      if (kids.length) n.text = kids.join(' ').slice(0, 60);
    }

    // 同 bounds 去重
    const best = new Map();
    for (const n of raw) {
      const key = n.bounds.join(',');
      const score = (n.text.length + n.desc.length) * 2 + (n.clickable ? 1000 : 0);
      const prev = best.get(key);
      if (!prev || score > prev.score) best.set(key, { score, n });
    }
    const uniq = [...best.values()].map((x) => x.n);

    // 被"有文字的可点祖先"包住的非可点节点 → 丢
    const clickers = uniq.filter((n) => n.clickable && (n.text || n.desc));
    const kept = uniq.filter((n) => {
      if (n.clickable) return true;
      const [x1, y1, x2, y2] = n.bounds;
      for (const c of clickers) {
        const [cx1, cy1, cx2, cy2] = c.bounds;
        const iw = Math.max(0, Math.min(x2, cx2) - Math.max(x1, cx1));
        const ih = Math.max(0, Math.min(y2, cy2) - Math.max(y1, cy1));
        if ((iw * ih) / n.area >= 0.95) return false;
      }
      return true;
    });

    const cx = (sw || 360) / 2;
    const cy = (sh || 640) / 2;
    kept.sort((a, b) => {
      const ra = a.clickable || a.editable ? 0 : 1;
      const rb = b.clickable || b.editable ? 0 : 1;
      if (ra !== rb) return ra - rb;
      if (a.area !== b.area) return b.area - a.area;
      const da = Math.abs((a.bounds[0] + a.bounds[2]) / 2 - cx) + Math.abs((a.bounds[1] + a.bounds[3]) / 2 - cy);
      const db = Math.abs((b.bounds[0] + b.bounds[2]) / 2 - cx) + Math.abs((b.bounds[1] + b.bounds[3]) / 2 - cy);
      return da - db;
    });

    const more = Math.max(0, kept.length - this.maxNodes);
    const pick = kept.slice(0, this.maxNodes);
    const nodes = pick.map((n, idx) => ({
      ref: `n${idx}`,
      text: n.text,
      desc: n.desc,
      class: n.simple,
      clickable: n.clickable,
      editable: n.editable,
      scrollable: n.scrollable,
      checkable: n.checkable,
      checked: n.checked,
      longClick: n.longClick,
      enabled: n.enabled,
      password: n.password,
      bounds: n.bounds,
      center: [(n.bounds[0] + n.bounds[2]) >> 1, (n.bounds[1] + n.bounds[3]) >> 1],
      pkg: n.pkg,
    }));
    // ★ 2026-10-31：阈值从 <3 放宽到 <4。图库那种"整页卡片"的界面只有 3~4 个带文字的节点，
    // 原来的 >=3 就不算"看不清"，于是她拿到一张空壳表还以为自己看全了。
    return { nodes, more, thin: nodes.length < 4 };
  }

  /** 稳定指纹：剔掉会自己变的节点，否则"界面变了吗"永远为真。 */
  hash(nodes) {
    const parts = [];
    for (const n of nodes) {
      if (VOLATILE_CLASS.has(n.class)) continue;
      if (n.text && VOLATILE_TEXT.test(n.text)) continue;
      if (n.pkg === 'com.android.systemui') continue;
      parts.push(`${n.class}|${n.text}|${n.desc}|${n.bounds.join(',')}|${n.clickable ? 1 : 0}|${n.checked ? 1 : 0}`);
    }
    return hashText(parts);
  }

  /**
   * 给模型看的紧凑动作表（一行一个，全程 ASCII 标记，别用 emoji 占 token）：
   *
   *   n0 网络和互联网 [tap]
   *   n3 搜索框 [edit]
   *   n5 推荐 [tab]
   *
   * 约定：默认就能点；`[edit]` 可输入；`[scroll]` 可滑动；`[text]` 只是文字；
   * `[long]` 可长按；`[check]`/`[checked]` 是勾选框。
   */
  renderTable(nodes, more = 0) {
    const lines = nodes.map((n) => {
      const label = (n.text || n.desc || n.class || '').replace(/\s+/g, ' ').trim().slice(0, 40);
      const flags = [];
      if (n.editable) flags.push('edit');
      else if (!n.clickable) flags.push(n.scrollable ? 'scroll' : 'text');
      if (n.longClick) flags.push('long');
      if (n.checkable) flags.push(n.checked ? 'checked' : 'check');
      if (n.enabled === false) flags.push('off');
      return `${n.ref} ${label}${flags.length ? ` [${flags.join(',')}]` : ''}`;
    });
    if (more) lines.push(`+${more} 项没列出来（这屏太大，只列可点/面积靠前的 ${nodes.length} 项）`);
    return lines.join('\n');
  }

  /**
   * 看一眼：app + 屏幕 + 动作表（+ 可选截图）。
   * @returns {Promise<object>} 给模型/给自检都用这一份
   */
  async observe({ shot = false, max = 0 } = {}) {
    if (max) this.maxNodes = Math.max(5, Number(max));
    /**
     * ★ 2026-11-01：**`t0` 要挪到 `state()` 之前**。
     * 原来它写在 `await this.state()` 之后，于是 `ms.state` 恒为 0 —— "这一趟慢在哪"
     * 永远看不出是 adb 状态查询还是控件树（真机上 `state()` 要 0.3 秒左右，不算小）。
     */
    const t0 = Date.now();
    const st = await this.state();
    const tState = Date.now();
    if (!st.online || !st.booted) {
      return { ok: false, ...st, ms: { state: tState - t0, dump: 0, total: tState - t0 }, error: st.online ? 'Android 还没启动完' : `连不上 adb（${this.serial}）` };
    }
    const ui = await this.uiXml();
    const tDump = Date.now();
    // ★ 真实画幅（横屏 1280×720 和 `wm size` 的 720×1280 不一样，见 `frameOf`）
    // ★ 2026-11-01：读不到就**清掉**旧缓存（带时间戳，见 `state()` 里那段）；
    //   否则横屏那一帧会一直骗后面所有点击。
    const frame = frameOf(ui.xml);
    this.frame = frame ? { ...frame, at: Date.now() } : null;
    const view = frame || st.screen;
    const built = ui.xml ? this.buildTable(ui.xml, { screen: view }) : { nodes: [], thin: true };
    const table = this.renderTable(built.nodes, built.more);
    const hash = this.hash(built.nodes);
    const out = {
      ok: true,
      app: st.app,
      screen: view,
      nodes: built.nodes,
      count: built.nodes.length,
      more: built.more || 0,
      thin: !!built.thin,
      hash,
      table,
      chars: table.length,
      ms: { state: tState - t0, dump: tDump - tState, total: tDump - t0 },
    };
    this.lastDumpMs = out.ms.dump;
    if (shot) {
      const s = await this.screenshot();
      out.shot = s.ok ? { bytes: s.bytes, ms: s.ms, png: s.png } : { error: s.error };
      out.ms.total = Date.now() - t0;
    }
    if (built.thin) {
      out.hint = '控件树几乎为空（游戏/Flutter/WebView 自绘）：跟她说清"这屏看不清按钮"，需要看截图。';
    }
    return out;
  }

  /** 截图；`save` 给目录时顺手落盘，返回 PNG Buffer。 */
  async screenshot({ save = '', name = '' } = {}) {
    let buf = Buffer.alloc(0);
    let ms = 0;
    let r = await this.adb(['exec-out', 'screencap', '-p'], { timeout: this.shotTimeoutMs, binary: true });
    ms += r.ms;
    buf = Buffer.isBuffer(r.out) ? r.out : Buffer.alloc(0);
    if (!this.#isPng(buf)) {
      /**
       * ★ 2026-10-31（层 0）：`exec-out` 这条路在掉线/半死状态下会**静默返回空**（exit 0）。
       * 兜底：先截到机内文件再 `cat`，慢一点但能拿到。
       */
      const tmp = '/sdcard/_dsh_shot.png';
      const w = await this.sh(`screencap -p ${tmp}`, { timeout: this.shotTimeoutMs });
      ms += w.ms;
      if (w.code === 0) {
        const c = await this.adb(['exec-out', 'cat', tmp], { timeout: this.shotTimeoutMs, binary: true });
        ms += c.ms;
        if (Buffer.isBuffer(c.out) && this.#isPng(c.out)) buf = c.out;
      }
    }
    if (!this.#isPng(buf)) {
      return { ok: false, error: `截图失败（${buf.length} 字节，不是 PNG）`, ms, bytes: buf.length };
    }
    /**
     * ★ 2026-10-31（层 0）：**小图 = 没截到**。
     * `FLAG_SECURE` 的界面会返回一张纯黑图、`screencap` 还是 exit 0；
     * 旧代码只看魔数，于是黑图被当成"画面没变"一路空转，还被她当截图发给他。
     */
    if (buf.length < this.minShotBytes) {
      return {
        ok: false,
        tooSmall: true,
        error: `截图太小（${Math.round(buf.length / 1024)} KB < ${Math.round(this.minShotBytes / 1024)} KB，多半是黑屏/空白页）`,
        ms,
        bytes: buf.length,
      };
    }
    const digest = crypto.createHash('sha1').update(buf).digest('hex');
    const out = { ok: true, png: buf, bytes: buf.length, hash: digest, ms };
    if (save) {
      try {
        fs.mkdirSync(save, { recursive: true });
        const file = path.join(save, name || `${Date.now()}-${digest.slice(0, 8)}.png`);
        fs.writeFileSync(file, buf);
        out.file = file;
      } catch (err) {
        out.saveError = err.message;
      }
    }
    return out;
  }

  /** PNG 魔数（8 字节）。 */
  #isPng(buf) {
    return Buffer.isBuffer(buf) && buf.length >= 8
      && buf[0] === 0x89 && buf.slice(1, 4).toString('latin1') === 'PNG';
  }

  /* ---- 动作 ---- */

  async tapXY(x, y) {
    const r = await this.sh(`input tap ${Math.round(x)} ${Math.round(y)}`, { timeout: 10000 });
    return { ok: r.code === 0, ms: r.ms, msg: `${r.out}${r.err}`.trim() };
  }

  async swipe(x1, y1, x2, y2, ms = 300) {
    const r = await this.sh(`input swipe ${Math.round(x1)} ${Math.round(y1)} ${Math.round(x2)} ${Math.round(y2)} ${Math.round(ms)}`, { timeout: 12000 });
    return { ok: r.code === 0, ms: r.ms, msg: `${r.out}${r.err}`.trim() };
  }

  /**
   * `up` = 内容往上走（手指从下往上划）。
   *
   * ★ 2026-11-02：多了 `span`（划**多少屏**，0.12~0.96）。
   *
   * 旧版写死 `0.78h → 0.28h` + **300 ms**：640 px / 0.3 s ≈ 2100 px/s，
   * 远超 Android 的 fling 阈值 —— **每一滑都是甩**，列表页一次跳过两三条，
   * 划过去的东西模型一件都没看见过（用户：「下滑途中不知道停止」）。
   *
   * `adb shell input swipe` 没有"抑制惯性"的参数，能拧的只有**距离**和**时长**：
   * 拉长时长 = 抬起时速度低 = 不甩。所以列表用小跨度 + 长时长，
   * 竖屏故事流（pager）反过来 —— **必须甩**，不然停在两条视频中间。
   */
  async swipeDir(dir, { screen, ms = 300, span = 0.5 } = {}) {
    const scr = screen || (await this.state()).screen;
    const w = scr.width || 720;
    const h = scr.height || 1280;
    const sp = Math.max(0.12, Math.min(0.96, Number(span) || 0.5));
    const cx = Math.round(w / 2);
    const cy = Math.round(h / 2);
    const dx = Math.round(w * sp / 2);
    const dy = Math.round(h * sp / 2);
    switch (dir) {
      case 'up': return this.swipe(cx, cy + dy, cx, cy - dy, ms);
      case 'down': return this.swipe(cx, cy - dy, cx, cy + dy, ms);
      case 'left': return this.swipe(cx + dx, cy, cx - dx, cy, ms);
      case 'right': return this.swipe(cx - dx, cy, cx + dx, cy, ms);
      default: return { ok: false, msg: `未知方向 ${dir}（up/down/left/right）` };
    }
  }

  async key(name) {
    const code = KEYS[name] ?? (/^\d+$/.test(name) ? Number(name) : null);
    if (code == null) return { ok: false, msg: `未知按键 ${name}（可用：${Object.keys(KEYS).join('/')}）` };
    const r = await this.sh(`input keyevent ${code}`, { timeout: 10000 });
    return { ok: r.code === 0, ms: r.ms, msg: `${r.out}${r.err}`.trim() };
  }

  /**
   * ★ 2026-10-31（第二轮）：**直接用 intent 开一个网址**（搜索页就走这条）。
   *
   * 为什么不用"点地址栏 + 打字"：浏览器（Via）工具栏是自绘的、滚动时还会藏起来，
   * 小模型只会在顶上瞎戳，打出来的字常常没进地址栏（真机撞到过：屏幕上还是上一页，
   * 她却说"搜到了"）。`am start -a VIEW -d` 一次 3~4 秒就到搜索结果页，可验证。
   */
  async openUrl(url) {
    const u = String(url || '').trim();
    if (!/^https?:\/\//i.test(u)) return { ok: false, ms: 0, msg: '只开 http/https' };
    const safe = u.replace(/'/g, '%27');
    const r = await this.sh(`am start -a android.intent.action.VIEW -d '${safe}'`, { timeout: 20000 });
    const blob = `${r.out}${r.err}`.trim();
    const ok = r.code === 0 && !/Error:|Exception/i.test(blob);
    return { ok, ms: r.ms, msg: blob.slice(0, 300) };
  }

  /**
   * 打字。中文走 MuMuManager 原生 `input_text`（不用装 ADBKeyboard，不用切输入法）；
   * 英文走 `adb input text`（空格转 `%s`，单引号转义）。
   */
  async text(value) {
    const s = String(value ?? '');
    if (!s) return { ok: false, msg: '空字符串' };
    if (/[^\x00-\x7f]/.test(s)) {
      /**
       * MuMuManager 成功时**什么都不打印**（它把 adb 的输出透传到 stderr），
       * 失败才返回非 0。所以判据是退出码，不是 stdout 里的 errcode
       * （2026-10-30 实测：`input_text 晚上好` 退出码 0，光标处真的出现了中文）。
       */
      const r = await run(this.managerExe, ['adb', '--vmindex', String(this.vmindex), '-c', 'input_text', s], { timeout: 30000 });
      const blob = `${r.out}${r.err}`.trim();
      if (r.code === 0) return { ok: true, ms: r.ms, msg: blob || '（MuMuManager 已输入）' };
      return { ok: false, ms: r.ms, msg: `MuMuManager 输入失败（code=${r.code}）：${blob.slice(0, 200) || '无输出'}` };
    }
    /**
     * ★ 2026-11-01：**单引号里不用转义反斜杠**。
     * 原来多转了一道 `\\`：让她在手机上打 `C:\temp` 会出来 `C:\\temp`
     * （shell 里单引号内除了 `'` 本身，什么字符都是字面量）。
     */
    const safe = s.replace(/'/g, "'\\''").replace(/ /g, '%s');
    const r = await this.sh(`input text '${safe}'`, { timeout: 15000 });
    return { ok: r.code === 0, ms: r.ms, msg: `${r.out}${r.err}`.trim() };
  }

  /**
   * 打开 App：包名直开，或按中文名（设置/浏览器/相机/相册）反查。
   *
   * ★ 2026-10-31：**同一个中文名可能对应好几个包**（`浏览器` 既有 `com.android.browser`
   * 又有 `mark.via`）。旧版 `find()` 只拿第一个，于是这台机器（只装了 Via）永远
   * 「打不开「浏览器」」—— 10:47「打开浏览器并随便搜点东西」就是这么 1 秒就失败的。
   * 现在按名字把所有候选都试一遍，哪个真能拉起来用哪个。
   */
  async launch(spec) {
    const key = String(spec || '').trim();
    if (!key) return { ok: false, msg: '没给 App' };
    const candidates = packagesFor(key);
    if (!candidates.length) return { ok: false, msg: `不认识「${key}」，用包名或 设置/浏览器/相机/相册` };
    let last = { ok: false, ms: 0, pkg: '', msg: '没有可试的包' };
    for (const pkg of candidates) {
      const r = await this.sh(`monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`, { timeout: 20000 });
      const blob = `${r.out}${r.err}`;
      const ok = r.code === 0 && !/No activities found/i.test(blob) && !/monkey aborted/i.test(blob);
      last = { ok, ms: r.ms + (last.ms || 0), pkg, msg: blob.trim().slice(0, 300) };
      if (ok) return last;
    }
    return last;
  }

  /**
   * ★ 2026-11-08（用户：「她还不会重启软件（关了再打开）」）：**真的把 App 关掉**。
   *
   * 以前只有 `launch`（`monkey` 拉起来）—— 如果那个 App 已经卡在一个页面上，
   * `monkey` 只会把它**恢复到原来的那一页**（验证码还在、广告还在），于是"重启"变成
   * "回到同一屏"，她只能接着瞎点（真机 23:10:58 的「重启浏览器」跑了 125 秒、20 步、还是那一屏）。
   * 现在有 `am force-stop`：进程杀掉、下次 `launch` 是真的**冷启动**。
   */
  async forceStop(spec) {
    const key = String(spec || '').trim();
    if (!key) return { ok: false, msg: '没给 App' };
    const candidates = packagesFor(key);
    if (!candidates.length) return { ok: false, msg: `不认识「${key}」` };
    let last = { ok: false, ms: 0, pkg: '', msg: '没有可试的包' };
    for (const pkg of candidates) {
      const r = await this.sh(`am force-stop ${pkg}`, { timeout: 10000 });
      const blob = `${r.out}${r.err}`.trim();
      last = { ok: r.code === 0, ms: r.ms, pkg, msg: blob.slice(0, 200) };
      if (last.ok) return last;
    }
    return last;
  }

  /* ---- 真窗口（用户选的 UX：不要小面板，直接弹 MuMu） ---- */

  async #control(sub) {
    if (!this.managerExe) return { ok: false, ms: 0, raw: null, msg: `没找到 MuMuManager.exe（home=${this.home || '空'}）` };
    const r = await run(this.managerExe, ['control', '--vmindex', String(this.vmindex), ...sub], { timeout: 15000 });
    const blob = `${r.out}${r.err}`.trim();
    let json = null;
    try { json = JSON.parse(blob); } catch { /* 不是 JSON（help/报错） */ }
    /**
     * 两种成功形状：`show_window` 回 `{"errcode":0}`，`layout_window` 回的是**当前窗口矩形**
     * （没有 errcode）。所以"没有 errcode"也算成功，别把成功的无操作当成失败。
     */
    const ok = r.code === 0 && (!json || json.errcode === undefined || json.errcode === 0);
    return { ok, ms: r.ms, raw: json || blob, msg: ok ? '' : (json?.errmsg || blob.slice(0, 200)) };
  }

  /** 把模拟器窗口露出来 / 藏起来。 */
  showWindow() { return this.#control(['show_window']); }
  hideWindow() { return this.#control(['hide_window']); }

  /**
   * 把手机窗口提到最前，**不抢焦点**。
   *
   * ★ 2026-10-30 实测：`show_window` 只是 ShowWindow(SW_SHOW)，窗口会停在**已有窗口后面**。
   * 桌宠自己是置顶的、DSH 是全屏的，于是"手机确实在跑、窗口也在，但屏幕上就是看不见"——
   * 这正是用户说的"点了第三挡没有手机出来"的最后一块。
   * 做法是 Win32 的老办法：先 SetWindowPos(HWND_TOPMOST) 再 HWND_NOTOPMOST，
   * 窗口就停在非置顶窗口的最上层，而且 `SWP_NOACTIVATE` 不会把焦点抢走。
   * 需要一点 Win32 调用，所以走同目录的 `win-front.ps1`（ASCII，不依赖任何第三方模块）。
   */
  async raiseWindow() {
    const script = path.join(__dirname, 'win-front.ps1');
    if (!fs.existsSync(script)) return { ok: false, msg: '没有 win-front.ps1' };
    const [info, box] = await Promise.all([this.playerInfo(), this.windowBox()]);
    const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-ProcessName', 'MuMuNxDevice'];
    const pid = Number(info?.pid) || 0;
    if (pid > 0) args.push('-ProcessId', String(pid));
    if (box && Number(box.width) > 0) {
      args.push('-Width', String(Math.round(box.width)), '-Height', String(Math.round(box.height)));
    }
    const r = await run('powershell.exe', args, { timeout: 20000 });
    const blob = `${r.out}${r.err}`.trim();
    const lastLine = blob.split(/\r?\n/).filter(Boolean).pop() || '';
    let json = null;
    try { json = JSON.parse(lastLine); } catch { /* 不是 JSON：报错信息 */ }
    return { ok: !!(json && json.ok), hwnd: Number(json?.hwnd) || 0, msg: json ? '' : blob.slice(0, 240), ms: r.ms };
  }

  /**
   * 摆窗口（用户要的"真手机"观感：竖屏、无多余、放在桌宠旁边）。
   * @param {{x:number,y:number,width:number,height:number}} box
   */
  layoutWindow({ x, y, width, height }) {
    const args = ['layout_window'];
    if (Number.isFinite(x)) args.push('--pos_x', String(Math.round(x)));
    if (Number.isFinite(y)) args.push('--pos_y', String(Math.round(y)));
    if (Number.isFinite(width)) args.push('--size_w', String(Math.round(width)));
    if (Number.isFinite(height)) args.push('--size_h', String(Math.round(height)));
    return this.#control(args);
  }

  /** 当前窗口位置/大小（MuMuManager 直接回 JSON）。 */
  async windowBox() {
    if (!this.managerExe) return null;
    const r = await run(this.managerExe, ['control', '--vmindex', String(this.vmindex), 'layout_window'], { timeout: 15000 });
    try { return JSON.parse(`${r.out}${r.err}`.trim()); } catch { return null; }
  }

  /**
   * 摆窗口，并**读回来核对**。
   *
   * ★ 2026-10-30 实测（MuMu 5.22，200% 缩放）：`layout_window` 收的是**逻辑像素（DIP）**，
   * 回的是**物理像素**。传 `430x900@100,100` → 回来 `854x1630@203,200`（差不多 ×2），
   * 而且高度会被夹到 ~815 逻辑像素（屏幕高度）。
   * 旧代码拿 854 去和 430 比 → 永远判"没搬动"，日志里那句"MuMu 不接受摆位"其实是误判。
   * 所以这里带 dpr（Electron 的 scaleFactor）换算后核对；宽度差太多就按实测比例再修一次。
   */
  async fitWindow(box, { dpr = 1 } = {}) {
    const scale = Number(dpr) > 0 ? Number(dpr) : 1;
    const want = {
      x: Math.round(box.x), y: Math.round(box.y),
      width: Math.round(box.width), height: Math.round(box.height),
    };
    const logicalOf = (b) => (b && Number.isFinite(b.width) ? {
      x: Math.round(Number(b.x) / scale),
      y: Math.round(Number(b.y) / scale),
      width: Math.round(Number(b.width) / scale),
      height: Math.round(Number(b.height) / scale),
    } : null);
    let req = { ...want };
    let raw = null;
    for (let i = 0; i < 2; i++) {
      await this.layoutWindow(req);
      raw = await this.windowBox();
      if (!raw || !Number.isFinite(raw.width) || raw.width <= 0) break;
      const lw = raw.width / scale;
      const off = Math.abs(lw - req.width) / Math.max(1, req.width);
      if (off <= 0.06 || i === 1) break;
      // 不同 MuMu 版本对 size_w 的解释不一样：按这次实测的比例反推一次
      req = {
        ...req,
        width: Math.max(240, Math.round(req.width * (req.width / lw))),
        height: Math.max(400, Math.round((req.height * req.height) / Math.max(1, raw.height / scale))),
      };
    }
    const box2 = logicalOf(raw);
    const ok = !!box2
      && Math.abs(box2.width - want.width) <= Math.max(12, want.width * 0.08)
      && Math.abs(box2.height - want.height) <= Math.max(24, want.height * 0.12);
    return { ok, want, box: box2, raw, dpr: scale };
  }

  /** MuMu 自己的状态：`is_process_started` / `is_android_started` / `pid`。 */
  async playerInfo() {
    if (!this.managerExe) return null;
    const r = await run(this.managerExe, ['info', '--vmindex', String(this.vmindex)], { timeout: 15000 });
    try { return JSON.parse(`${r.out}${r.err}`.trim()); } catch { return null; }
  }

  /**
   * 启动模拟器。三条路依次试，**判据统一是"adb 端口通了"**，不是 MuMu 自己的状态字段。
   *
   * ★ 2026-10-30 实测（MuMu 5.22 绿色版）：
   *   · `MuMuManager control launch` **是有效的** —— 它会拉起 MuMuNxDevice.exe（旧版才是空操作）；
   *   · 但如果上一次崩溃留下了 `is_process_started: true` + 死 pid，管理器就以为在跑、什么都不做，
   *     所以调用前必须先 `isRunning()` 把陈旧状态掀掉；
   *   · 兜底 GUI 也换了名字：新版是 `nx_main\MuMuNxMain.exe`，旧版是 `shell\MuMuPlayer.exe`；
   *   · 最后的最后还有 `MuMuNxDevice.exe`（就是"手机"那个窗口进程）。
   */
  async launchPlayer({ waitMs = 30000, onTick = null } = {}) {
    const before = await this.isRunning();
    if (before.running) return { ok: true, already: true, via: 'already', state: before };
    const tried = [];

    const tick = (msg) => { try { onTick && onTick(msg); } catch { /* 回调出错不影响启动 */ } };

    // ① 命令行管理器
    if (this.managerExe) {
      const r = await this.#control(['launch']);
      tried.push({ via: 'MuMuManager control launch', ok: r.ok, msg: r.msg || '' });
      tick({ stage: 'launching', via: 'manager' });
      if (await this.waitPort({ timeoutMs: waitMs })) return { ok: true, via: 'MuMuManager control launch', tried };
    }

    /**
     * ② 多开管理器 GUI / 老版 MuMuPlayer.exe（和用户双击图标同一条路）
     *
     * ★ 2026-11-01 修：原来这里是 `['MuMuNxMain.exe', playerExe]` 和
     * `['MuMuPlayer.exe', playerExe]` —— **同一个 exe 列了两遍**（`playerExe` 早就解析成
     * 唯一路径了）。第一轮 `waitPort` 超时（默认 30 秒）后会用同一个 exe 再 spawn 一次，
     * 表现为"多开管理器弹两个窗口"，日志里的名字也是错的（明明起的是 MuMuNxMain 却写
     * MuMuPlayer.exe）。现在一个 exe 只起一次，并且给了 `error` 监听（缺 DLL / 被安全软件
     * 拦时不会变成未捕获异常）。
     */
    for (const [label, exe] of [['玩家', this.playerExe], ['设备', this.deviceExe]]) {
      if (!exe || !fs.existsSync(exe)) continue;
      try {
        const child = spawn(exe, [], { detached: true, stdio: 'ignore', windowsHide: false });
        child.on('error', (err) => tried.push({ via: label, ok: false, msg: err.message }));
        child.unref();
        tried.push({ via: label, ok: true });
        tick({ stage: 'launching', via: label });
      } catch (err) {
        tried.push({ via: label, ok: false, msg: err.message });
        continue;
      }
      if (await this.waitPort({ timeoutMs: waitMs })) return { ok: true, via: label, tried };
    }

    const why = !this.home
      ? '没找到 MuMu 的安装目录（设置里填 phone.home，或设环境变量 DSP_MUMU_HOME）'
      : !this.managerExe && !this.playerExe
        ? `找到了 ${this.home}，但里面没有 MuMuManager.exe / MuMuNxMain.exe`
        : `${Math.round(waitMs / 1000)} 秒内 adb 端口没起来`;
    return { ok: false, msg: why, tried, paths: this.paths() };
  }

  /** 等"模拟器真的在跑"（端口或进程），判据和 `isRunning()` 一致。 */
  async waitProcess({ timeoutMs = 40000, intervalMs = 1000 } = {}) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const st = await this.isRunning();
      if (st.running) return { ok: true, ms: Date.now() - t0, info: st.info };
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    return { ok: false, ms: Date.now() - t0 };
  }

  /**
   * 等客机起来（adb 端口 + `sys.boot_completed`）。
   * 冷启动实测 30~60 s，所以默认给 150 s；期间每 2.5 s 问一次，不做魔法 sleep。
   */
  async waitBoot({ timeoutMs = 150000, intervalMs = 2500, onTick = null } = {}) {
    const t0 = Date.now();
    let last = '';
    let n = 0;
    while (Date.now() - t0 < timeoutMs) {
      const conn = await this.connect();
      const b = await this.sh('getprop sys.boot_completed', { timeout: 8000 });
      last = `${b.out || ''}${b.err || ''}`.trim() || conn.msg;
      if (String(b.out).trim() === '1') return { ok: true, ms: Date.now() - t0 };
      try { onTick && onTick({ n: ++n, ms: Date.now() - t0, msg: last }); } catch { /* 回调出错不影响启动 */ }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    return { ok: false, ms: Date.now() - t0, error: last || '超时' };
  }

  /**
   * 亮屏 + 解锁（上滑）。锁屏时 launch/tap 都会打空，所以动作前先叫一下。
   */
  async wake() {
    const st = await this.state();
    const lm = await this.sh("dumpsys window | grep -E 'mDreamingLockscreen|mShowingLockscreen'", { timeout: 8000 });
    const locked = /mDreamingLockscreen=true|mShowingLockscreen=true/.test(String(lm.out));
    if (locked) {
      await this.key('wakeup');
      await this.swipeDir('up', { screen: st.screen, ms: 200 });
      await this.sh('input keyevent 82', { timeout: 8000 });
    }
    return { locked, ms: 0 };
  }

  /** 当前前台包名（一次 adb，约 50 ms）：比 dump 便宜 40 倍。 */
  async focusApp() {
    /** ★ 2026-11-08 夜：和 `state()` 用同一套解析（只认 display 0），别再取第一条。 */
    const r = await this.sh("dumpsys window displays | grep -E 'Display: mDisplayId|mCurrentFocus'", { timeout: 8000 });
    const f = this.parseFocus(r.out);
    return f ? f.pkg : '';
  }

  /**
   * 等界面变（不做魔法 sleep）。
   *
   * ★ 2026-10-31：先花 50 ms 问一句"前台包换了吗"。换 App 是最常见的一种"确实点动了"，
   * 而旧版为了确认这件事要 dump 一次（2.3 s）。没换包才回落到 dump 比 hash。
   */
  async waitChange(before, { timeout = 2.5, interval = 0.25, screen, app = '' } = {}) {
    if (!before) return { changed: null, ms: 0 };
    const t0 = Date.now();
    let askedApp = false;
    /**
     * ★ 2026-11-02：**把轮询里已经 dump 到的那棵树带回去**（`tree`）。
     *
     * 旧版这里只回 `{changed}`，于是 `phone-agent` 拿到"变了"之后**又 observe 一次**：
     * 一次动作 = 2~3 次 dump（waitChange 一次 + 主循环再一次），实测 **11.4 秒/步**
     * （`episodes.jsonl` 72 条平均）。而 `maxMs = 100 秒` ÷ 11.4 ≈ 8 步，
     * `maxSteps 12` 从来没被用到过 —— "时间到了"不是想不出来，是**屏看了两遍**。
     *
     * 现在：变了就把树（连同 hash / 动作表 / 画幅）一起交出去，调用方拼上 `state()`
     * 的 app 就能直接用，省掉一整次 uiXml（约 2.3 秒）。
     * ⚠️ 换 App（`via: 'app'`）时**不带树**：那一刻的树不一定属于新 App，必须完整看一遍。
     */
    /**
     * ★ 2026-11-01 修：**调用方没给 `screen` 就自己问一次**。
     * `before` 是 `observe()` 带着 `screen` 算出来的 hash；这里不筛屏外节点就会
     * 拿两套不同的口径比 —— 只要树里有屏外控件（滚动列表天天有）hash 必然不等，
     * 于是 51 ms 就返回 `changed:true`，等于**根本没在等界面动**。
     */
    let view = screen;
    if (!view) {
      try { view = (await this.state()).screen; } catch { /* 问不到就退回不筛 */ }
    }
    while (Date.now() - t0 < timeout * 1000) {
      await new Promise((r) => setTimeout(r, interval * 1000));
      if (app && !askedApp) {
        askedApp = true;
        try {
          const now = await this.focusApp();
          if (now && now !== app) return { changed: true, via: 'app', ms: Date.now() - t0 };
        } catch { /* 问不到就当没换 */ }
      }
      const ui = await this.uiXml();
      if (!ui.xml) continue;
      const built = this.buildTable(ui.xml, { screen: view });
      const hash = this.hash(built.nodes);
      if (hash !== before) {
        return {
          changed: true,
          ms: Date.now() - t0,
          tree: {
            nodes: built.nodes,
            more: built.more || 0,
            thin: !!built.thin,
            count: built.nodes.length,
            hash,
            table: this.renderTable(built.nodes, built.more || 0),
            screen: view,
          },
        };
      }
    }
    return { changed: false, ms: Date.now() - t0 };
  }

  /**
   * 按语义点：找 ref → 点 → 可选验证。
   *
   * ★ 2026-10-31：**调用方给了观察时的坐标（`at`）就不再重新 dump**。
   * 旧版每次点击前都 dump 一遍去解析 ref（2.3 s），可那个 ref 是上一毫秒刚观察出来的，
   * 屏幕根本没机会变。只有调用方给不出坐标时才回落到"重新 dump 再找"。
   * ref 只在**那一次观测**里有效，这条规则没变。
   */
  async tap(ref, { verify = true, screen, at = null, hash = '', app = '' } = {}) {
    const target = String(ref || '').trim();
    if (!/^n\d+$/.test(target)) return { ok: false, msg: `ref 要写成 n0 / n1，收到「${target}」` };
    let xy = Array.isArray(at) && at.length === 2 ? at : null;
    let before = verify ? (xy ? hash : '') : '';
    let label = '';
    if (!xy) {
      const ui = await this.uiXml();
      if (!ui.xml) return { ok: false, msg: '拿不到控件树，没法按 ref 点；改用坐标' };
      const scr0 = screen || (await this.state()).screen;
      const built = this.buildTable(ui.xml, { screen: scr0 });
      const node = built.nodes.find((n) => n.ref === target);
      if (!node) return { ok: false, msg: `这一屏没有 ${target}（界面可能已变，重新看一遍）` };
      xy = node.center;
      before = verify ? this.hash(built.nodes) : '';
      label = (node.text || node.desc || node.class).slice(0, 40);
    }
    const scr = screen || (await this.state()).screen;
    const act = await this.tapXY(xy[0], xy[1]);
    const out = { ok: act.ok, ref: target, label, xy, ms: act.ms, fast: !!hash };
    if (verify) {
      const w = await this.waitChange(before, { screen: scr, app });
      out.changed = w.changed;
      out.via = w.via || 'hash';
      out.verifiedMs = w.ms;
      /** ★ 2026-11-02：变了的时候顺手把树交出去（调用方就不用再 dump 一次）。 */
      if (w.tree) out.tree = w.tree;
      if (w.changed === false) {
        out.ok = false;
        out.hint = '点了但界面没变：没点中 / 被挡住 / 这个控件本来就不改界面';
      }
    }
    return out;
  }
  /**
   * 自检：这台机器上到底能不能用（不启动模拟器、不改任何东西）。
   * `node tools\phone.cjs doctor` 就是它。
   */
  async doctor() {
    await this.ensureTarget();
    const p = this.paths();
    const out = {
      paths: p, adbVersion: '', devices: '', info: null, running: null,
      online: false, booted: false, screen: null, app: null, notes: [],
    };
    if (!p.found) out.notes.push('没找到 MuMu 安装目录：在 config\\companion.json 填 phone.home，或设环境变量 DSP_MUMU_HOME');
    if (!this.adbExe) out.notes.push('没找到 adb.exe');
    if (!this.managerExe) out.notes.push('没找到 MuMuManager.exe（拉起模拟器、摆窗口都要它）');
    if (!this.playerExe) out.notes.push('没找到 MuMuNxMain.exe / MuMuPlayer.exe（GUI 兜底启动用）');

    if (this.adbExe) {
      const v = await run(this.adbExe, ['version'], { timeout: 8000 });
      out.adbVersion = String(v.out || v.err || '').split('\n')[0].trim();
    }
    if (this.managerExe) {
      const i = await run(this.managerExe, ['info', '--vmindex', String(this.vmindex)], { timeout: 15000 });
      try { out.info = JSON.parse(`${i.out}${i.err}`.trim()); } catch { out.info = null; }
    }
    const st = await this.isRunning();
    out.running = { running: st.running, alive: st.alive, portUp: st.portUp, stale: st.stale, port: st.port, pid: st.pid };
    if (st.stale) {
      out.notes.push(`MuMu 状态字段说"在跑"，但 pid ${st.pid} 已经没了 —— 崩溃后的陈旧状态，代码会照样去启动`);
    }
    const dev = await this.adb(['devices'], { timeout: 8000 });
    out.devices = String(dev.out || '').trim();
    if (dev.code === -3) out.notes.push(String(dev.err));
    const s = await this.state();
    out.online = !!s.online;
    out.booted = !!s.booted;
    out.screen = s.screen;
    out.app = s.app;
    if (!s.online) out.notes.push('连不上设备（模拟器没开，或 adb 端口不对）');
    else if (!s.booted) out.notes.push('设备在线，但 Android 还没启动完');
    return out;
  }
}

module.exports = { PhoneAdb, DEFAULTS, KEYS, APP_NAMES, packagesFor, parseTree, parseAttrs, decodeEntities, discoverHome, isMuMuHome, readInstallInfo, frameOf };
