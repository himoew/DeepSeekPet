/**
 * QQ 网关管家（2026-10-26）—— 让桌宠自己管 NapCat，而不再靠"让 AI 跑一条 bat"。
 *
 * 为什么要有这一层：
 *   · 以前桌宠只连 `ws://127.0.0.1:3001`，NapCat 归外部脚本管；脚本没跑、QQ 掉了，
 *     桌宠只会安静地重试，用户只能再来找人跑命令；
 *   · NapCat 掉线没有 watchdog，这是交接文档里挂着的 P0 缺口；
 *   · 扫码登录藏在 NapCat 的控制台/WebUI 里，用户不知道该点哪儿。
 *
 * 这个模块只做四件事：
 *   1. **拉起/停止**：等价于 `launcher-local.bat -q 小号`，但用 `spawn` 直接起
 *      `NapCatWinBootMain.exe`（没有黑窗口、不 `pause`），并记下日志；
 *   2. **看状态**：探 3001（OneBot）和 6099（WebUI），读 WebUI 的 QQ 登录态；
 *   3. **登录**：调 NapCat 本地 WebUI 的 `/api/QQLogin/*`（快速登录、刷新二维码）；
 *      二维码 PNG 是 NapCat 自己写到 `cache/qrcode.png` 的，这里只负责读成 data URL；
 *   4. **看住它**：进程掉了按退避重启（30s→1m→2m→5m），不无限快速重启。
 *
 * 生命周期（2026-10-26 用户定了）：**桌宠退出不关 QQ**。`stop()` 只停 watchdog，
 * 进程继续挂着；要真的下线，得点设置页的「停止网关」。
 *
 * 安全：
 *   · 只读/只连 `127.0.0.1`；NapCat 的 WebUI token 从本机 `config/webui.json` 读，
 *     不写进日志、不发给页面（页面只拿 `{ok, state}`）。
 *   · 拉起 QQ 时把 `ELECTRON_RUN_AS_NODE` 清掉 —— 从 DSH/Node 终端继承来的这个变量
 *     会让 Electron 程序退化成纯 Node，QQ 会静默不启动（README 里踩过）。
 */
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const log = require('./log.cjs');

/** 默认配置。跟 `companion.json` 的 `gateway` 段合并，老配置缺字段也能跑。 */
const DEFAULTS = {
  autoStart: true,          // 陪伴模式一开/桌宠一启动，就把网卡拉起来
  dir: '',                  // 空 = 自动找（D:\pet\NapCat、应用目录旁边的 NapCat）
  uin: '',                  // 留空 = 用 NapCat 记住的账号 / 等扫码
  autoQuickLogin: true,     // QQ 号留空、本机只记住一个账号时，自动快速登录（不扫码）
  keepAlive: true,          // 桌宠退出不关 QQ（用户 2026-10-26 选的）
  pollMs: 2500,             // 等登录时的轮询间隔
  restartDelayMs: 30000,    // 第一次重启等待（之后翻倍，封顶 5 分钟）
  maxRestarts: 5,           // 30 分钟内最多自己重启几次
};

/** 找 NapCat 的候选目录（先看配置，再看环境变量，最后看两个常见位置）。 */
function candidateDirs() {
  return [
    process.env.NAPCAT_DIR,
    'D:\\pet\\NapCat',
    // app 在 <应用目录>\resources\app；<应用目录> 的上一级通常放着 NapCat
    path.join(__dirname, '..', '..', '..', 'NapCat'),
  ].filter(Boolean);
}

/** NapCat 便携版必须有的几个文件；少一个就不算装好。 */
const NEED_FILES = [
  'NapCatWinBootMain.exe',
  'QQ.exe',
  'NapCatWinBootHook.dll',
  'napcat.mjs',
  'qqnt.json',
  'loadNapCat.js',
];

/** 检查目录是不是一个能用的 NapCat；返回 `{ok, dir, missing}`。 */
function checkDir(dir) {
  const d = String(dir || '').trim();
  if (!d) return { ok: false, dir: '', missing: NEED_FILES.slice() };
  const missing = NEED_FILES.filter((f) => !fs.existsSync(path.join(d, f)));
  return { ok: missing.length === 0, dir: d, missing };
}

/** 找到第一个能用的目录；都没有就返回 `{ok:false, tried}`。 */
function findDir(preferred = '') {
  const tried = [];
  for (const d of [preferred, ...candidateDirs()]) {
    if (!d) continue;
    const r = checkDir(d);
    if (r.ok) return { ...r, tried };
    tried.push({ dir: d, missing: r.missing });
  }
  return { ok: false, dir: '', tried };
}

/** 读 NapCat 的 `config/webui.json`（token 就在这儿；不写日志）。 */
function readWebuiConfig(dir) {
  const file = path.join(String(dir || ''), 'config', 'webui.json');
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch (err) {
    return { ok: false, error: `读不到 ${file}：${err.message}`, file };
  }
  const port = Number(raw.port) || 6099;
  return {
    ok: true,
    file,
    // `host` 可能是 "::" / "0.0.0.0"（NapCat 默认监听所有网卡），我们永远只连本机
    host: '127.0.0.1',
    port,
    token: String(raw.token || ''),
  };
}

/** NapCat WebUI 的登录口令算法：`sha256(token + ".napcat")` 的十六进制。 */
function hashToken(token) {
  return crypto.createHash('sha256').update(String(token || '') + '.napcat').digest('hex');
}

/** 一个最小 HTTP JSON 客户端：只连 127.0.0.1，超时就断。 */
function httpJson({ port, path: p, method = 'POST', body, headers = {}, timeoutMs = 2500 }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: p,
      method,
      headers: {
        ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
        ...headers,
      },
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json;
        try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** 端口探活：只回答"这个口现在有没有在听"。 */
function probePort(port, timeoutMs = 450) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    let done = false;
    const end = (v) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => end(true));
    sock.once('timeout', () => end(false));
    sock.once('error', () => end(false));
  });
}

/** 把 NapCat 的 `cache/qrcode.png` 读成 `<img src>` 能用的 data URL。 */
function readQr(dir) {
  const file = path.join(String(dir || ''), 'cache', 'qrcode.png');
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size < 100 || st.size > 2 * 1024 * 1024) return null;
    return {
      dataUrl: `data:image/png;base64,${fs.readFileSync(file).toString('base64')}`,
      at: st.mtimeMs,
    };
  } catch {
    return null;
  }
}

/** 拉起 NapCat 的命令（和 `launcher-local.bat` 等价，没有黑窗口）。 */
function buildLaunch({ dir, uin }) {
  const d = String(dir);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  return {
    exe: path.join(d, 'NapCatWinBootMain.exe'),
    args: [
      path.join(d, 'QQ.exe'),
      path.join(d, 'NapCatWinBootHook.dll'),
      ...(String(uin || '').trim() ? ['-q', String(uin).trim()] : []),
    ],
    cwd: d,
    env: {
      ...env,
      NAPCAT_PATCH_PACKAGE: path.join(d, 'qqnt.json'),
      NAPCAT_LOAD_PATH: path.join(d, 'loadNapCat.js'),
      NAPCAT_INJECT_PATH: path.join(d, 'NapCatWinBootHook.dll'),
      NAPCAT_LAUNCHER_PATH: path.join(d, 'NapCatWinBootMain.exe'),
      NAPCAT_MAIN_PATH: path.join(d, 'napcat.mjs'),
    },
  };
}

/**
 * **隐藏控制台**的包一层（2026-10-26 用户实测："测试的时候我这里弹了个窗口，全是乱码"）。
 *
 * 为什么会弹：`NapCatWinBootMain.exe` 是控制台程序，QQ/NapCat 需要往控制台写日志；
 * 我们用 `windowsHide` 起它 = 它**根本没有控制台**，于是 QQ 自己 `AllocConsole` 开了一个
 * **可见**的窗口，而且代码页是 936，UTF-8 日志全成乱码。
 *
 * 现在的做法：用 `powershell -WindowStyle Hidden` 起一个**存在但隐藏**的控制台，
 * 先 `chcp 65001`，再把启动器挂在这个控制台上 —— QQ 继承它，就不会再自己开窗口，
 * 万一用户手动把它调出来，中文也是对的。
 *
 * 注意**不能**加 `detached: true`：那等于 DETACHED_PROCESS（没有控制台），QQ 又会自己开一个。
 * 父进程退出不会连带杀子进程，所以"桌宠退出 QQ 继续挂着"仍然成立。
 */
function buildWrapper(cmd) {
  const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
  const script = `chcp 65001 > $null; & ${q(cmd.exe)} ${cmd.args.map(q).join(' ')}`;
  return {
    exe: 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script],
    cwd: cmd.cwd,
    env: cmd.env,
  };
}

/** 重启退避：30s → 1m → 2m → 4m → 5m。 */
function backoffMs(attempt, base = DEFAULTS.restartDelayMs) {
  const table = [0, 1, 2, 4, 8, 10];
  const n = Math.max(0, Math.min(table.length - 1, Number(attempt) || 0));
  return Math.min(5 * 60_000, Math.max(5_000, base * (table[n] || 1)));
}

/**
 * WebUI 客户端：登录拿 credential，之后带着它调 `/api/QQLogin/*`。
 *
 * NapCat 的鉴权（解包 `napcat.mjs` 看来的）：
 *   POST /api/auth/login  {hash: sha256(token + ".napcat")}  →  data.Credential
 *   Authorization: Bearer <base64(JSON(credential))>，一小时有效。
 * 登录接口有频率限制（`webui.json` 的 loginRate，默认 10），所以 credential 缓存起来。
 */
/**
 * 这个响应说明"凭据没用了"。
 *
 * ★ 2026-10-31（用户实测：手机上登录过一次之后，面板一直停在「错误: Unauthorized」，
 * 二维码也不出来，点「重新登录」也没用）：
 *
 * NapCat 的 `QQLogin/*` 在凭据失效时**HTTP 还是 200**，只是在 body 里回 `{code:-1, message:"Unauthorized"}`。
 * 旧代码只在 HTTP 401/403 时才知道要重新登录，于是这一条永远走不到重登分支 ——
 * 手里那份死凭据会一直用到 50 分钟的缓存过期为止，中间所有调用（包括刷新二维码、快速登录）全废。
 * 现在把 body 级的 Unauthorized / Forbidden / token 失效也算进去。
 */
function isAuthFailure(r) {
  if (!r) return false;
  if (r.status === 401 || r.status === 403) return true;
  const code = r.json && r.json.code;
  if (code === undefined || code === 0) return false;
  return /unauthor|forbidden|denied|token|凭据|过期|invalid/i.test(String(r.json.message || ''));
}

class WebuiClient {
  constructor({ port, token, request = httpJson }) {
    this.port = port;
    this.token = token;
    this.request = request;
    this.credential = '';
    this.credAt = 0;
    this.loggingIn = null;
  }

  async #login() {
    if (!this.token) throw new Error('NapCat WebUI 没设 token');
    const r = await this.request({
      port: this.port,
      path: '/api/auth/login',
      method: 'POST',
      body: { hash: hashToken(this.token) },
    });
    const data = r && r.json && r.json.data;
    if (!r || r.status !== 200 || !data || !data.Credential) {
      const hint = r && r.status === 429 ? '（试太频繁了，NapCat 限了 1 分钟 10 次，等一会儿再点）' : '';
      throw new Error(`NapCat WebUI 登录失败（${r ? r.status : '无响应'}${r?.json?.message ? ` ${r.json.message}` : ''}）${hint}`);
    }
    this.credential = String(data.Credential);
    this.credAt = Date.now();
    return this.credential;
  }

  async ensure() {
    if (this.credential && Date.now() - this.credAt < 50 * 60_000) return this.credential;
    if (!this.loggingIn) {
      this.loggingIn = this.#login().finally(() => { this.loggingIn = null; });
    }
    return this.loggingIn;
  }

  /** 丢掉手里的凭据（NapCat 重启过、换了 token、用户点了"重新登录"都该调它）。 */
  reset() {
    this.credential = '';
    this.credAt = 0;
  }

  /** 一次 `/api/QQLogin/<route>`，不带重试。 */
  async #post(route, body, cred) {
    return this.request({
      port: this.port,
      path: `/api/QQLogin/${route}`,
      method: 'POST',
      body,
      headers: { authorization: `Bearer ${cred}` },
    });
  }

  /** 调一个 `/api/QQLogin/<route>`；`code !== 0` 当失败。 */
  async call(route, body = {}) {
    let r;
    try {
      r = await this.#post(route, body, await this.ensure());
    } catch (err) {
      throw new Error(`连不上 NapCat WebUI：${err.message}`);
    }
    if (isAuthFailure(r)) {
      // 凭据过期 / NapCat 重启过：丢掉重登一次再试
      this.reset();
      try {
        r = await this.#post(route, body, await this.ensure());
      } catch (err) {
        throw new Error(`连不上 NapCat WebUI：${err.message}`);
      }
    }
    const json = (r && r.json) || {};
    if (json.code !== undefined && json.code !== 0) {
      throw new Error(String(json.message || `NapCat 返回 code=${json.code}`));
    }
    if (r.status && r.status >= 400) throw new Error(`NapCat HTTP ${r.status}`);
    return json.data;
  }
}

/**
 * 网关本体。
 *
 * `getConfig()` 每次都从 `companion.json` 现读，改配置不用重建对象；
 * `onChange()` 在状态真的变了时调一次（由 `companion.cjs` 转成页面事件）。
 */
function create({ getConfig, onChange = () => {}, deps = {} } = {}) {
  const now = deps.now || (() => Date.now());
  const probe = deps.probePort || probePort;
  const spawnFn = deps.spawn || spawn;
  const execFn = deps.execFile || execFile;
  const request = deps.httpJson || httpJson;
  const allowLaunch = deps.allowLaunch === true;
  const dataDir = path.dirname(log.file);
  const logFile = path.join(dataDir, 'napcat.log');

  const cfg = () => ({ ...DEFAULTS, ...(getConfig() || {}) });
  const state = {
    enabled: false,
    dir: '',
    dirOk: false,
    running: false,
    phase: 'off',
    loginPhase: '',
    isLogin: false,
    online: false,
    /** ★ 2026-11-03：上一轮是不是"登录着但掉线"（只在日志里用来记一次转折，别重复刷）。 */
    wasOffline: false,
    onebot: false,
    selfId: '',
    nick: '',
    avatar: '',
    qr: null,
    quickList: [],
    lastError: '',
    startedAt: 0,
    restarts: 0,
    logFile,
  };

  let timer = null;
  let ticking = false;
  let client = null;
  let clientKey = '';
  let spawnedAt = 0;
  let downSince = 0;
  let wasAlive = false;
  let attempts = 0;
  let lastAttemptAt = 0;
  let quickAt = 0;
  let autoQuickTried = false;
  /** ★ 2026-10-31：上次让 NapCat 重画二维码的时间（码约两分钟有效，别刷太勤）。 */
  let qrRefreshAt = 0;
  let lastSig = '';

  function emit(force = false) {
    const sig = JSON.stringify({
      enabled: state.enabled, dirOk: state.dirOk, running: state.running, phase: state.phase,
      loginPhase: state.loginPhase, isLogin: state.isLogin, online: state.online,
      onebot: state.onebot, selfId: state.selfId, nick: state.nick,
      qrAt: state.qr?.at || 0, quick: state.quickList.length,
      lastError: state.lastError, restarts: state.restarts,
    });
    if (!force && sig === lastSig) return;
    lastSig = sig;
    try { onChange(publicState()); } catch (err) { log.warn(`网关状态回调出错：${err.message}`); }
  }

  function publicState() {
    return {
      ...state,
      // 需要用户扫码/处理：页面据此决定"要不要显示二维码 / 角标要不要变 !"
      needsLogin: !state.isLogin && ['waiting_qrcode', 'qrcode_scanned', 'login_error'].includes(state.phase),
      qrAvailable: !!(state.qr && state.qr.dataUrl),
    };
  }

  function resolveDir() {
    const c = cfg();
    const found = findDir(c.dir);
    state.dir = found.dir || String(c.dir || '').trim();
    state.dirOk = !!found.ok;
    if (!found.ok) {
      const tried = found.tried.map((t) => `${t.dir}（缺 ${t.missing.join('/')}）`).join('；');
      state.lastError = `没找到可用的 NapCat 目录${tried ? `：${tried}` : ''}`;
    }
    return found.ok ? found.dir : '';
  }

  function webuiFor(dir) {
    const c = cfg();
    const conf = readWebuiConfig(dir);
    if (!conf.ok) {
      state.lastError = conf.error;
      return null;
    }
    const key = `${dir}|${conf.port}|${conf.token}`;
    if (!client || clientKey !== key) {
      client = new WebuiClient({ port: conf.port, token: conf.token, request });
      clientKey = key;
    }
    return { client, port: conf.port };
  }

  /**
   * ★ 2026-10-31：**把手里那份凭据扔掉**。
   * NapCat 每重启一次，旧凭据就作废（token 不变，但服务端的密钥变了）。
   * 旧代码只按 `dir|port|token` 复用客户端，token 不变就一直用那份死凭据，
   * 于是"点重新登录 → NapCat 重启了 → 仍然是 Unauthorized → 二维码还是不出来"（用户实测原话）。
   */
  function dropClient() {
    try { client?.reset?.(); } catch { /* 没客户端 */ }
    client = null;
    clientKey = '';
  }

  function setError(msg) {
    if (msg !== state.lastError) {
      // 空串 = "刚才那个错误没了"：以前会记成一行 `WARN QQ 网关：`（后面什么都没有），
      // 看着像掉线又看不出原因。现在用一句人话说清楚，级别也降下来。
      if (msg) log.warn(`QQ 网关：${msg}`);
      else if (state.lastError) log.info('QQ 网关：刚才那个错误没了');
    }
    state.lastError = msg || '';
  }

  function schedule(ms = cfg().pollMs) {
    clearTimeout(timer);
    timer = setTimeout(() => { tick().catch(() => {}); }, Math.max(400, Number(ms) || 2500));
    timer.unref?.();
  }

  async function launch() {
    const dir = resolveDir();
    if (!dir) { state.phase = 'error'; emit(); return false; }
    /**
     * ★ 2026-10-31：拉起/接管之前先把手里的凭据扔掉。
     * 上一轮进程留下的那份在这一轮里是**死的**（服务端密钥换了），
     * 不扔的话第一次 `CheckLoginStatus` 就是 Unauthorized，二维码也跟着出不来。
     */
    dropClient();
    qrRefreshAt = 0;

    const [onebot, webui] = await Promise.all([probe(3001), probe((readWebuiConfig(dir).port) || 6099)]);
    if (onebot || webui) {
      // 已经有人把它跑起来了（用户自己开的、或者上一次留下来的）：直接接管
      state.running = true;
      state.phase = onebot ? 'ready' : 'starting';
      state.startedAt = state.startedAt || now();
      log.info('QQ 网关：已经在跑，直接接管');
      emit(true);
      return true;
    }

    const raw = buildLaunch({ dir, uin: cfg().uin });
    const cmd = buildWrapper(raw);
    try {
      // 控制台输出写到 data\napcat.log：二维码/报错都在里面，出问题有得看。
      // ⚠️ 这个文件里可能有二维码 URL，不要发给别人；只在本机排查用。
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      // 这个文件只有排查时看；超过 2MB 就先清掉，免得跑几个月变成大文件
      try { if (fs.statSync(logFile).size > 2 * 1024 * 1024) fs.writeFileSync(logFile, ''); } catch { /* 还没有这个文件 */ }
      const fd = fs.openSync(logFile, 'a');
      const child = spawnFn(cmd.exe, cmd.args, {
        cwd: cmd.cwd,
        env: cmd.env,
        // ⚠️ 不能 detached + windowsHide：那样 QQ 没有控制台可继承，会自己开一个**可见**窗口
        windowsHide: false,
        stdio: ['ignore', fd, fd],
      });
      child.on('error', (err) => { setError(`拉起 NapCat 失败：${err.message}`); emit(true); });
      child.on('exit', (code) => { log.info(`NapCat 启动器退出（code=${code}）`); });
      child.unref();
      fs.closeSync(fd);
    } catch (err) {
      setError(`拉起 NapCat 失败：${err.message}`);
      state.phase = 'error';
      emit(true);
      return false;
    }

    spawnedAt = now();
    wasAlive = false;
    downSince = 0;
    attempts += 1;
    lastAttemptAt = now();
    state.running = true;
    state.phase = 'starting';
    state.startedAt = now();
    state.lastError = '';
    log.info(`QQ 网关：已拉起 NapCat（${path.basename(raw.exe)}${cfg().uin ? ` -q ${cfg().uin}` : ''}）`);
    emit(true);
    return true;
  }

  /**
   * ★ 2026-10-31（用户要求）：**哪怕 WebUI 那边出问题，二维码也必须亮出来**。
   *
   * 之前 `CheckLoginStatus` 一抛错（Unauthorized）就直接 return，`state.qr` 永远是空的 ——
   * 用户看到的就是"等 NapCat 生成二维码…"一直等下去，点「重新登录」也没用。
   *
   * 事实是：二维码是 **NapCat 自己写到 `cache/qrcode.png` 的**，读它**不需要** WebUI 凭据。
   * 所以这里分三步，任何一步成功就够：
   *   ① 直接读盘上的 qrcode.png；
   *   ② 太旧（NapCat 的码约两分钟有效）就叫 NapCat 重画一张，再读；
   *   ③ 都没有就退回 `qrcodeurl`（页面能显示成链接）。
   */
  async function surfaceQr(dir, w, { force = false, qrcodeurl = '' } = {}) {
    const t = now();
    let qr = readQr(dir);
    const stale = qr && t - Number(qr.at || 0) > 100_000;
    const canRefresh = now() - qrRefreshAt > 45_000;
    if ((force || !qr || stale) && canRefresh && w && w.client) {
      qrRefreshAt = now();
      try {
        await w.client.call('RefreshQRcode');
      } catch { /* 刷新失败也要把手里这张给出去 */ }
      const fresh = readQr(dir);
      if (fresh && (!qr || fresh.at > qr.at)) qr = fresh;
    }
    if (qr) {
      state.qr = qr;
      return qr;
    }
    if (qrcodeurl) state.qr = { dataUrl: '', at: 0, url: String(qrcodeurl) };
    return null;
  }

  async function readLogin(dir) {
    const w = webuiFor(dir);
    if (!w) { state.phase = 'error'; return; }
    let st;
    try {
      st = await w.client.call('CheckLoginStatus');
    } catch (err) {
      setError(err.message);
      state.phase = state.onebot ? 'ready' : (state.isLogin ? 'login' : 'login_error');
      /**
       * ★ 关键：**这条路以前是不出二维码的**（直接 return），也就是用户遇到的
       * "登录失败之后二维码也没了"。凭据坏了不影响读盘上的二维码，所以照样亮出来。
       */
      await surfaceQr(dir, w, { force: true });
      return;
    }
    if (!st || typeof st !== 'object') return;
    /**
     * ★ 2026-11-03：**NapCat 报的是 `isLogin` + `isOffline`，没有 `online`**。
     *
     * 这是解包 napcat.mjs 的 `CheckLoginStatus` 看来的：
     * ```
     * isLogin:  登录着 且 selfInfo.online === true
     * isOffline: 登录着 且 selfInfo.online === false   ← 掉线时是这个
     * ```
     * 旧代码读的是 `st.online`（永远是 undefined）—— 于是**登录着也一直显示"不在线"**，
     * 而掉线那 1 分钟（NapCat 自己会重连）又被当成"没登录"，QQ 号和昵称被清空、
     * 面板短暂变成要扫码的样子。现在两个字段都认，掉线只是"等它重连"。
     */
    const offline = st.isOffline === true
      || (st.isOffline === undefined && st.isLogin === true && st.online === false);
    const loggedIn = !!st.isLogin || offline;
    state.isLogin = loggedIn;
    state.online = !!st.isLogin && !offline;
    state.loginPhase = String(st.loginPhase || '');
    setError(st.loginError || '');

    if (offline && !state.wasOffline) {
      log.warn(`QQ 网关：账号掉线了（${state.loginPhase || 'reconnecting'}），NapCat 会自己重连 —— 先等它，别急着重启`);
    } else if (!offline && state.wasOffline) {
      log.info('QQ 网关：账号回到在线了');
    }
    state.wasOffline = offline;

    if (loggedIn) {
      // 掉线时**别把 QQ 号/昵称清掉**：他没换号，只是连接断了，一会儿就回来。
      state.phase = state.online ? 'ready' : 'starting';
      state.qr = null;
      // 昵称/头像：拿不到也不影响，失败就当空
      if (state.online) {
        try {
          const info = await w.client.call('GetQQLoginInfo');
          if (info && typeof info === 'object') {
            state.selfId = String(info.uin || state.selfId || '');
            state.nick = String(info.nick || '');
            state.avatar = String(info.avatarUrl || '');
          }
        } catch { /* 登录成功但 info 拿不到：忽略 */ }
      }
      return;
    }

    state.selfId = '';
    state.nick = '';
    state.avatar = '';
    if (st.loginPhase === 'qrcode_scanned') state.phase = 'qrcode_scanned';
    else if (st.loginPhase === 'waiting_qrcode') state.phase = 'waiting_qrcode';
    else if (st.loginPhase === 'reconnecting') state.phase = 'starting';
    else if (st.loginError) state.phase = 'login_error';
    else state.phase = 'waiting_qrcode';

    if (state.phase === 'waiting_qrcode' || state.phase === 'qrcode_scanned' || state.phase === 'login_error') {
      // 过期的码换成新的（她扫的时候不能是一张两分钟前就作废的）
      await surfaceQr(dir, w, { qrcodeurl: st.qrcodeurl });
    } else {
      state.qr = null;
    }

    // 本机记住的账号（可以一键快速登录，不用扫码）
    if (now() - quickAt > 15_000) {
      quickAt = now();
      try {
        const list = await w.client.call('GetQuickLoginListNew');
        if (Array.isArray(list)) {
          state.quickList = list
            .map((x) => ({ uin: String(x?.uin || ''), nick: String(x?.nickName || x?.nick || '') }))
            .filter((x) => x.uin)
            .slice(0, 8);
        }
      } catch { /* 拿不到就算了 */ }
    }
  }

  async function tick() {
    if (!state.enabled || ticking) return;
    ticking = true;
    try {
      const c = cfg();
      const dir = state.dirOk ? state.dir : (state.dir = resolveDir());
      if (!dir || !state.dirOk) {
        state.phase = 'error';
        state.running = false;
        return;
      }
      const webuiPort = (() => {
        const conf = readWebuiConfig(dir);
        return conf.ok ? conf.port : 6099;
      })();
      const [onebot, webui] = await Promise.all([probe(3001), probe(webuiPort)]);
      state.onebot = onebot;

      if (onebot || webui) {
        wasAlive = true;
        downSince = 0;
        state.running = true;
      }

      if (webui) {
        await readLogin(dir);
        /**
         * ★ 2026-10-26：QQ 号留空、本机只记住一个账号 → 自己快速登录，连「一键登录」都不用点。
         * 只试一次：失败就停在二维码（用户换号/重登时不会反复顶号）。
         */
        if (!c.uin && c.autoQuickLogin !== false && !autoQuickTried
          && !state.isLogin && state.phase === 'waiting_qrcode' && state.quickList.length === 1) {
          autoQuickTried = true;
          log.info(`QQ 网关：本机只记住一个账号，自动快速登录 ${state.quickList[0].uin}`);
          await quickLogin(state.quickList[0].uin).catch(() => {});
        }
        if (state.isLogin) {
          /**
           * ★ 2026-11-03：登录着但**掉线**时阶段是 `starting`（等 NapCat 重连），
           * 不是"已就绪"。OneBot 口通着不代表账号在线。
           */
          state.phase = state.online ? (onebot ? 'ready' : 'login') : 'starting';
        }
      } else if (onebot) {
        // 只开了 OneBot、WebUI 没开：当作已就绪（可能用户用的是别的网关）
        state.phase = 'ready';
        state.running = true;
        state.isLogin = true;
        state.online = true;
        state.qr = null;
      } else {
        // 两个口都没了
        state.qr = null;
        if (spawnedAt && now() - spawnedAt < 90_000) {
          state.phase = 'starting';
          state.running = true;
        } else if (wasAlive) {
          if (!downSince) downSince = now();
          state.phase = 'starting';
          state.running = false;
          if (now() - downSince > 8000) maybeRestart(c);
        } else if (spawnedAt) {
          state.running = false;
          state.phase = 'login_error';
          setError(state.lastError || `网关 90 秒还没起来，看 ${logFile}`);
        } else {
          state.phase = c.autoStart ? 'starting' : 'off';
          state.running = false;
        }
      }
      emit();
      schedule(state.phase === 'ready' ? 10_000 : c.pollMs);
    } finally {
      ticking = false;
    }
  }

  /** 掉线重启：按退避，且有次数上限；用户手动停过就不再拉。 */
  function maybeRestart(c) {
    if (!c.autoStart || !state.enabled) return;
    if (now() - downSince < 8000) return;
    if (attempts >= Number(c.maxRestarts || 5) && now() - lastAttemptAt < 30 * 60_000) {
      state.phase = 'login_error';
      setError('网关反复掉线，先不自动重启了；看 data\\napcat.log');
      return;
    }
    const wait = backoffMs(attempts, Number(c.restartDelayMs) || DEFAULTS.restartDelayMs);
    if (now() - lastAttemptAt < wait) {
      state.phase = 'starting';
      return;
    }
    state.restarts += 1;
    log.warn(`QQ 网关：掉线了，第 ${state.restarts} 次重启`);
    spawnedAt = 0;
    wasAlive = false;
    downSince = 0;
    launch().catch(() => {});
  }

  /* ---------- 对外动作 ---------- */

  async function start() {
    /**
     * 自检/开发时绝不允许真的拉起 QQ（会弹登录窗、改本机登录态）。
     * `test/lib/harness.cjs` 在加载任何应用模块之前就把这个变量设成 1。
     */
    if (process.env.DSP_NO_GATEWAY === '1' && !allowLaunch) {
      state.enabled = false;
      return publicState();
    }
    state.enabled = true;
    state.lastError = '';
    const c = cfg();
    if (c.keepAlive === false) state.keepAlive = false;
    const dir = resolveDir();
    if (!dir) { state.phase = 'error'; emit(true); return publicState(); }
    await launch();
    schedule(600);
    return publicState();
  }

  /** 只停 watchdog，不关 QQ（用户 2026-10-26 定的"桌宠退出不关网关"）。 */
  function suspend() {
    state.enabled = false;
    clearTimeout(timer);
    timer = null;
    state.phase = state.running ? state.phase : 'off';
    emit(true);
    return publicState();
  }

  async function refreshQr() {
    const dir = state.dir || resolveDir();
    if (!dir) return publicState();
    const w = webuiFor(dir);
    if (!w) return publicState();
    try {
      await w.client.call('RefreshQRcode');
      setError('');
    } catch (err) {
      setError(`刷新二维码失败：${err.message}`);
    }
    const qr = readQr(dir);
    if (qr) state.qr = qr;
    emit(true);
    return publicState();
  }

  /** 用 NapCat 记住的账号快速登录（不扫码）。 */
  async function quickLogin(uin) {
    const dir = state.dir || resolveDir();
    if (!dir) return publicState();
    const w = webuiFor(dir);
    if (!w) return publicState();
    try {
      await w.client.call('SetQuickLogin', { uin: String(uin || '') });
      setError('');
      state.phase = 'starting';
    } catch (err) {
      setError(`快速登录失败：${err.message}`);
    }
    emit(true);
    schedule(800);
    return publicState();
  }

  /** 真的把（这个目录里的）QQ 进程杀掉。只按可执行文件路径匹配，不动用户自己的 QQ。 */
  async function killProcess(dir) {
    const d = String(dir || state.dir || '');
    if (!d) return;
    const qq = path.join(d, 'QQ.exe').replace(/'/g, "''");
    const boot = path.join(d, 'NapCatWinBootMain.exe').replace(/'/g, "''");
    const ps = [
      `$qq='${qq}'; $boot='${boot}';`,
      `Get-CimInstance Win32_Process -Filter "Name='QQ.exe' or Name='NapCatWinBootMain.exe'"`,
      `| Where-Object { $_.ExecutablePath -ieq $qq -or $_.ExecutablePath -ieq $boot }`,
      `| ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }`,
    ].join(' ');
    await new Promise((resolve) => {
      execFn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 15_000 },
        () => resolve());
    });
  }

  async function stop() {
    state.enabled = false;
    clearTimeout(timer);
    timer = null;
    autoQuickTried = false;
    const dir = state.dir || resolveDir();
    await killProcess(dir);
    dropClient();                 // ★ 2026-10-31：关掉的这轮凭据也作废了
    qrRefreshAt = 0;
    spawnedAt = 0;
    wasAlive = false;
    downSince = 0;
    state.running = false;
    state.phase = 'off';
    state.qr = null;
    state.isLogin = false;
    state.online = false;
    state.wasOffline = false;
    state.quickList = [];
    setError('');
    log.info('QQ 网关：已停止（QQ 进程已关）');
    emit(true);
    return publicState();
  }

  async function restart() {
    const dir = state.dir || resolveDir();
    await killProcess(dir);
    dropClient();                 // ★ 2026-10-31：QQ 重启 = 新的服务端密钥，旧凭据必须扔掉
    qrRefreshAt = 0;
    spawnedAt = 0;
    wasAlive = false;
    downSince = 0;
    attempts = 0;
    state.restarts = 0;
    await new Promise((r) => setTimeout(r, 1200));
    return start();
  }

  /** 配置变了（目录/账号/开关）时调用：清掉旧客户端与退避。 */
  function configure() {
    dropClient();
    attempts = 0;
    autoQuickTried = false;
    state.restarts = 0;
    if (state.enabled) { state.dirOk = false; start().catch(() => {}); }
  }

  return {
    start, stop, restart, suspend, configure,
    refreshQr, quickLogin,
    publicState,
    /** 桌宠/设置页轮询用：不开 watchdog，只读一次状态。 */
    async peek() {
      if (!state.enabled) return publicState();
      await tick();
      return publicState();
    },
    get running() { return state.running; },
  };
}

module.exports = {
  DEFAULTS,
  create,
  checkDir,
  findDir,
  readWebuiConfig,
  hashToken,
  httpJson,
  probePort,
  readQr,
  buildLaunch,
  buildWrapper,
  backoffMs,
  isAuthFailure,
  WebuiClient,
};
