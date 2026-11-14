/**
 * 设置窗口：托盘「设置…」和桌宠右键菜单里的「打开设置」都走这里。
 *
 * 页面由自己的回环服务提供（`/settings`），通过 settings-preload.cjs 暴露的
 * window.settings 读写配置；页面本身不碰文件系统。
 */
const path = require('node:path');
const { BrowserWindow, ipcMain, shell } = require('electron');
const log = require('./log.cjs');
const llm = require('./llm.cjs');
const tts = require('./tts.cjs');
const memory = require('./memory.cjs');
const mood = require('./mood.cjs');
const dress = require('./dress.cjs');
const voiceConfig = require('./voice-config.cjs');
const companion = require('./companion.cjs');

let win = null;
let voiceWin = null;
let dressWin = null;
/** ★ 2026-11-04：她自己的账（`/self`）—— 单独一个窗口。 */
let selfWin = null;
let url = '';
let voiceUrl = '';
let dressUrl = '';
let selfUrl = '';
let wired = false;

/**
 * ★ 2026-11-01：**IPC 的第二个参数可能是 `null`**。
 *
 * 原来每个 handler 都写成 `(_e, { id } = {})` —— 默认值只兜 `undefined`，
 * 渲染进程传 `null` 时会当场 `TypeError: Cannot destructure property ... of 'null'`，
 * 于是这一次 IPC 变成 rejected promise（页面上看起来"点了没反应，控制台一行红"）。
 * 一律先过这里。
 */
function asObj(payload) {
  return payload && typeof payload === 'object' ? payload : {};
}

function wire() {
  if (wired) return;
  wired = true;

  ipcMain.handle('settings:load', () => ({
    cfg: llm.load(),
    presets: llm.PRESETS,
    configFile: llm.CONFIG_FILE,
    logFile: log.file,
  }));
  ipcMain.handle('settings:save', (_e, patch) => ({ cfg: llm.save(patch || {}) }));
  ipcMain.handle('settings:probe', (_e, patch) => llm.probe(patch || {}));
  /**
   * ★ 2026-10-27：本机 Ollama 探测。只读 `/api/tags`，不下载、不改配置；
   * 设置页拿它把「桌宠模型」一键填成本地（仍然要用户点保存）。
   */
  ipcMain.handle('settings:detectLocal', async () => {
    try {
      const res = await fetch('http://127.0.0.1:11434/api/tags', {
        signal: AbortSignal.timeout(2500),
      });
      if (!res.ok) return { ok: false, why: `Ollama 回了 HTTP ${res.status}` };
      const data = await res.json().catch(() => null);
      const models = (Array.isArray(data?.models) ? data.models : [])
        .map((m) => String(m?.name || '').trim())
        .filter(Boolean);
      if (!models.length) return { ok: false, why: 'Ollama 在跑，但一个模型都没拉' };
      return {
        ok: true,
        models,
        model: llm.pickLocalModel(models),
        baseUrl: 'http://127.0.0.1:11434/v1',
      };
    } catch (err) {
      const why = err?.name === 'TimeoutError'
        ? '等 2.5 秒没回音'
        : (err?.cause?.code === 'ECONNREFUSED' ? '127.0.0.1:11434 没开' : err.message);
      return { ok: false, why };
    }
  });
  ipcMain.handle('settings:revealConfig', () => shell.showItemInFolder(llm.CONFIG_FILE));
  ipcMain.handle('settings:openLog', () => shell.openPath(log.file));
  ipcMain.handle('settings:close', () => { if (win && !win.isDestroyed()) win.close(); });

  /* ---------- 它的记忆（只读 + 清空） ---------- */

  ipcMain.handle('settings:memory', () => memory.snapshot());
  ipcMain.handle('settings:forget', () => { mood.forget(); dress.forget(); return memory.forget(); });
  /** 它现在的心情（只读）：看得到"为什么它今天话少了"这种事的来由。 */
  ipcMain.handle('settings:mood', () => mood.snapshot());

  /* ---------- 服装（桌宠右键「换装…」） ---------- */

  ipcMain.handle('dress:load', () => dress.list());
  /**
   * 换上一套。**说明白"为什么现在只这一套"**：清单里 `ready:false` 的那几格
   * 是留给以后的新衣服的，点了会得到一句人话，而不是没反应。
   */
  ipcMain.handle('dress:wear', (_e, payload) => dress.wear(asObj(payload).id));
  ipcMain.handle('dress:reveal', () => shell.showItemInFolder(dress.FILE));
  ipcMain.handle('dress:close', () => { if (dressWin && !dressWin.isDestroyed()) dressWin.close(); });

  /* ---------- 音色编辑（桌宠右键「音色…」） ---------- */

  ipcMain.handle('voice:load', () => {
    const data = voiceConfig.list(tts.VENDOR);
    return { ...data, available: tts.available(), why: tts.why(), playing: tts.voiceName() };
  });
  ipcMain.handle('voice:save', (_e, payload) => {
    const { folder, knobs } = asObj(payload);
    const r = voiceConfig.save(tts.VENDOR, folder, knobs || {});
    if (r.ok) log.info(`音色参数已保存：${folder}`);
    return r;
  });
  ipcMain.handle('voice:activate', async (_e, payload) => {
    const { folder } = asObj(payload);
    const r = voiceConfig.activate(tts.VENDOR, folder);
    if (!r.ok) return r;
    log.info(`切换音色：${folder}`);
    // 存完立刻换过来，用户不用重启桌宠
    return { ...r, reload: await tts.reload() };
  });
  /**
   * 「保存并生效」：存参数 →（需要的话）切音色 → 重建语音引擎。
   *
   * 为什么必须整条走完：noiseScale / noiseScaleW / lengthScale 是**模型级**参数，
   * 只能在建 OfflineTts 时给，改了一定要重建（约 2~4 秒）。这一条是页面上唯一的
   * "真的改掉声音"的动作，试听紧随其后，两边不会不一致。
   */
  ipcMain.handle('voice:apply', async (_e, payload) => {
    const { folder, knobs } = asObj(payload);
    const saved = voiceConfig.save(tts.VENDOR, folder, knobs || {});
    if (!saved.ok) return saved;
    const cur = voiceConfig.list(tts.VENDOR).current;
    if (cur !== folder) {
      const act = voiceConfig.activate(tts.VENDOR, folder);
      if (!act.ok) return act;
    }
    const reload = await tts.reload();
    return { ok: reload.ok !== false, folder, knobs: saved.knobs, name: reload.name, error: reload.error };
  });
  ipcMain.handle('voice:reload', () => tts.reload());
  ipcMain.handle('voice:reveal', () => shell.showItemInFolder(path.join(tts.VOICES_ROOT, '.active')));
  ipcMain.handle('voice:close', () => { if (voiceWin && !voiceWin.isDestroyed()) voiceWin.close(); });

  /* ---------- 她自己的账（桌宠右键「她的账」，2026-11-04） ---------- */

  /**
   * ★ 2026-11-04：`self.html` 这一页只做"看/管"，**所有读写都在 `companion` 那边**：
   * `selfView()` 供快照、`selfJudge()` 让她现在写一笔（会跑一次模型）、`selfKernel()`
   * 提供手动加/删和账目录。这里刻意不写任何账逻辑 —— 去重、攒够没攒够、什么时候写，
   * 都是主进程的事，窗口只管把结果画出来。
   */
  ipcMain.handle('self:load', () => ({ ok: true, ...companion.selfView() }));
  /**
   * 「立即写一笔」：唯一会烧一次模型的动作，失败**不要把异常抛给页面** ——
   * 抛了渲染进程只会看到 "Error invoking remote method"，用户看不出到底哪一步没成。
   */
  ipcMain.handle('self:judge', async () => {
    try {
      const r = await companion.selfJudge();
      return { ok: true, ...r };
    } catch (err) {
      log.warn(`她的账：立即写一笔失败（${err.message}）`);
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle('self:add', (_e, payload) => {
    const { kind = 'taste', claim = '' } = asObj(payload);
    const r = companion.selfKernel().addManual({ kind, claim });
    if (r.ok) log.info(`她的账：手动加了一条 ${kind}`);
    return r;
  });
  ipcMain.handle('self:retire', (_e, payload) => companion.selfKernel().retire(asObj(payload).id, 'window'));
  /**
   * ★ 2026-11-05：**「她想的」那张卡**（用户要求并进账本窗口，方便查看与后续升级）。
   *
   * - `self:imagine`     让她现在想一个（`force`：窗口是人明确要的，不吃 30 分钟冷却）；
   * - `self:imagineDrop` 删掉一张（`dropped`，不是"淡了"）。
   *
   * ⚠️ 想一个是**真跑模型**（1~2 眼 ≈ 3 秒），失败也不把异常抛给页面 —— 抛了渲染进程
   * 只会看到 "Error invoking remote method"，人看不出哪一步没成。
   */
  ipcMain.handle('self:imagine', async (_e, payload) => {
    const seed = String(asObj(payload).seed || '').trim();
    try {
      const r = await companion.imagineNow({ seed, maxEyes: 2, force: true });
      return { ok: r?.ok !== false, ...r };
    } catch (err) {
      log.warn(`想象（窗口）：跑不起来（${err.message}）`);
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle('self:imagineDrop', (_e, payload) => companion.imagine().drop(asObj(payload).id, 'window'));
  ipcMain.handle('self:openDir', () => shell.showItemInFolder(companion.selfKernel().DIR));
  ipcMain.handle('self:close', () => { if (selfWin && !selfWin.isDestroyed()) selfWin.close(); });

  /* ---------- QQ 陪伴模式（2026-10-22） ---------- */

  /**
   * 这一页只改 `config/companion.json` 和 `config/companion-role.md`，
   * 不碰 `config/settings.json`（模型配置还在上面那张卡里）。
   */
  ipcMain.handle('companion:load', () => ({
    cfg: companion.reload(),
    role: companion.loadRole(),
    rolePath: companion.ROLE_FILE,
    configPath: companion.CONFIG_FILE,
    memoryPath: companion.DATA_DIR,
    memory: companion.memorySnapshot(),
    state: companion.publicState(),
  }));
  ipcMain.handle('companion:save', (_e, payload) => {
    const { cfg, role, restart = true } = asObj(payload);
    // restart:false 只用于「只改了 QQ 模型」：`companion.save` 自己也会比对连接字段，
    // 但显式传 false 更保险，不会再白断一次 OneBot。
    const st = companion.save(cfg || {}, { restart: restart !== false });
    if (typeof role === 'string') companion.saveRole(role);
    log.info(`陪伴模式设置已保存（enabled=${st.enabled} adapter=${st.adapter} model=${st.model.model} mode=${st.model.mode}）`);
    return { state: st, rolePath: companion.ROLE_FILE };
  });
  /** 测试 QQ 模型：可以用表单里还没保存的值，不写记忆。 */
  ipcMain.handle('companion:probe', (_e, patch) => companion.probeModel(patch || {}));
  ipcMain.handle('companion:enable', (_e, on) => companion.enable(!!on));
  ipcMain.handle('companion:clear', () => companion.forget());

  /* ---------- 长期记忆面板（2026-11-01） ---------- */

  /**
   * ★ 2026-11-01：`long-memory.cjs` 早就有 `list/get/delete/stats/search`，
   * `memory-scribe` 也有 `extractNow()` / `maybeCompress({force:true})` ——
   * 但设置页一个入口都没有，用户只能翻 `data\companion\memory\*.md`。
   *
   * ⚠️ 这一块**全部走现成函数**，不要在这里新写记忆逻辑（去重/衰减/归档都在 long-memory 里）。
   */
  const memoryRow = (entry) => ({
    id: entry.id,
    when: String(entry.lastConfirmedAt || entry.updated || entry.created || '').slice(0, 16).replace('T', ' '),
    kind: entry.kind,
    person: entry.person,
    scope: entry.scope,
    importance: entry.importance,
    evidence: entry.evidence,
    body: String(entry.body || '').slice(0, 200),
    tags: entry.tags || [],
  });
  ipcMain.handle('companion:memoryList', (_e, payload) => {
    const { q = '', limit = 60 } = asObj(payload);
    const lm = companion.longMemory();
    const n = Math.min(200, Math.max(1, Number(limit) || 60));
    const all = lm.list();
    const text = String(q || '').trim();
    // 有搜索词就按 BM25 排（跟"她想起什么"用的是同一套检索），没有就按时间倒序
    const hit = text
      ? lm.search(text, { topK: n }).map((h) => h.entry)
      : all.slice().reverse().slice(0, n);
    return { total: all.length, q: text, rows: hit.map(memoryRow) };
  });
  ipcMain.handle('companion:memoryDelete', (_e, payload) => {
    const id = asObj(payload).id;
    if (!id) return { ok: false, error: '没给 id' };
    const ok = companion.longMemory().delete(String(id));
    log.info(`长期记忆：设置页删了一条（${String(id).slice(0, 24)}）→ ${ok ? '删掉了' : '没找到'}`);
    return { ok, count: companion.longMemory().stats().count };
  });
  /**
   * 「立即整理」（把还没整理的对话抽成记忆）/「立即压缩」（把旧条目并成摘要）。
   * 整理员本身会烧一次模型，所以这里只回结果，不抛异常给页面。
   */
  ipcMain.handle('companion:memoryCompact', async (_e, payload) => {
    const { what = 'extract' } = asObj(payload);
    const scribe = companion.memoryScribe();
    try {
      if (what === 'compress') {
        const r = await scribe.maybeCompress({ force: true });
        const count = companion.longMemory().stats().count;
        log.info(`长期记忆：设置页点了「立即压缩」→ ${r?.summary ? '并成一条摘要' : '没有可压的'}`);
        return { ok: true, kind: 'compress', changed: !!r?.summary, count };
      }
      const st = companion.publicState();
      const r = await scribe.extractNow({
        personId: st.ownerPersonId || 'owner',
        personName: '',
        where: 'settings',
      });
      const count = companion.longMemory().stats().count;
      log.info(`长期记忆：设置页点了「立即整理」→ ${count} 条`);
      return {
        ok: true,
        kind: 'extract',
        changed: Number(r?.written) || 0,
        turns: Number(r?.turns) || 0,
        count,
      };
    } catch (err) {
      log.warn(`长期记忆：设置页的整理/压缩失败（${err.message}）`);
      return { ok: false, error: err.message };
    }
  });
  /** ★ 2026-11-01：只清图片缓存（不删记忆），放在「清空陪伴记忆」旁边。 */
  ipcMain.handle('companion:clearMedia', () => companion.forgetMedia());
  /** 试一句：真的走一遍角色卡 + 记忆 + 模型，失败就把原因显示在这一页。 */
  ipcMain.handle('companion:test', async () => {
    const st = companion.publicState();
    if (!st.model.ready) return { ok: false, message: st.model.why || '模型没配好' };
    if (!st.enabled) return { ok: false, message: '先把「开启陪伴模式」勾上（或先保存）再试' };
    try {
      const r = await companion.chat({ text: '在吗', situation: '这是设置页里的测试，不算正式聊天。', record: false });
      return { ok: true, message: r.text };
    } catch (err) {
      return { ok: false, message: err.message };
    }
  });
  ipcMain.handle('companion:openRole', () => shell.showItemInFolder(companion.ROLE_FILE));
  ipcMain.handle('companion:openMemory', () => shell.showItemInFolder(path.join(companion.DATA_DIR, 'people.json')));

  /* ---------- QQ 网关（2026-10-26）：拉起/停止 NapCat、二维码、快速登录 ---------- */

  /** 只读状态：设置页每 1.5 秒来一次；不含 token/进程句柄。 */
  ipcMain.handle('companion:gatewayState', () => companion.gateway.state());
  ipcMain.handle('companion:gateway', async (_e, payload) => {
    const { action, uin } = asObj(payload);
    const g = companion.gateway;
    switch (action) {
      case 'start': log.info('QQ 网关：设置页点了「启动」'); return g.start();
      case 'stop': log.info('QQ 网关：设置页点了「停止」'); return g.stop();
      case 'restart': log.info('QQ 网关：设置页点了「重新登录」'); return g.restart();
      case 'refresh': return g.refreshQr();
      case 'quick': log.info(`QQ 网关：快速登录 ${String(uin || '').slice(0, 12)}`); return g.quickLogin(uin);
      default: return g.state();
    }
  });

  /* ---------- 她的声音（QQ 语音，2026-11-01） ----------
   * ★ 2026-11-01 上午：这一块 UI 从「设置页 → QQ 陪伴卡」搬到了「音色」窗口（voice.html），
   * 合成也改成直连火山 1.0（不再经过 7860 调音台），所以"打开调音台""发一条到 QQ"都去掉了。
   */

  ipcMain.handle('companion:voiceState', () => companion.voice.state());
  /** 「音色」窗口打开时拉一次：开关、四个旋钮、地址、混音方案、有没有配 Key。 */
  ipcMain.handle('companion:voiceLoad', () => companion.voice.settings());
  /** 存开关和四个旋钮（没填 Key 时只存别的，不动已存的 Key）。 */
  ipcMain.handle('companion:voiceSave', (_e, patch = {}) => {
    const voice = companion.voice.settings();
    const next = {
      enabled: patch.enabled !== undefined ? !!patch.enabled : voice.enabled,
      tts: { ...(patch.tts || {}) },
    };
    // Key 只在这两种情况下动：明确给了新的，或者明确要清空。留空 = 不改。
    if (typeof patch.apiKey === 'string') next.tts.apiKey = patch.apiKey.trim();
    const st = companion.save({ voice: next }, { restart: false });
    log.info(`她的声音：已保存（enabled=${next.enabled} keyed=${!!(next.tts.apiKey ?? voice.keyed)}）`);
    return { ok: true, voice: st.voice };
  });
  /** 只读本地：有没有配 Key；不联网、不花钱。 */
  ipcMain.handle('companion:voiceProbe', () => companion.voice.probe());
  /**
   * 手改了 `config\companion.json`（比如换音色配比 mix）之后，让正在跑的那条重新读一遍，
   * 不用重启桌宠 —— 「音色」窗口里有个「重新读取配置」按钮走这里。
   */
  ipcMain.handle('companion:voiceReload', () => {
    companion.reload();
    log.info('她的声音：重新读了 companion.json');
    return companion.voice.settings();
  });
  /** 试听：在「音色」窗口里直接播，不发 QQ。可以带还没保存的旋钮。 */
  ipcMain.handle('companion:voicePreview', (_e, patch) => companion.voice.preview(patch || {}));

  /* ---------- ★ 2026-11-02：桌宠里她回话要不要念出来 ----------
   * 用户："把对话的语音加上，让她用语音回复" + "可以在音色里加开关，让我自己选择"。
   * 存在 `settings.json` 的 `deskVoice`（默认开），**和 QQ 的 `bubbleVoice` 彻底分开**：
   * 那一格是为了"QQ 里别两套声音同时响"，以前把桌宠这边的嘴也一起封了。
   */
  ipcMain.handle('voice:deskVoiceLoad', () => ({
    on: llm.load().deskVoice !== false,
    kit: llm.load().deskVoiceKit === 'local' ? 'local' : 'cloud',
    keyed: companion.voice.settings().keyed,
  }));
  ipcMain.handle('voice:deskVoiceSave', (_e, payload) => {
    const p = asObj(payload);
    const on = p.on !== false;
    const kit = p.kit === 'local' ? 'local' : 'cloud';
    llm.save({ deskVoice: on, deskVoiceKit: kit });
    log.info(`桌宠回话语音：${on ? `开（${kit === 'cloud' ? '火山 1.0' : '本机音色'}）` : '关（只显示文字）'}`);
    return { ok: true, on, kit };
  });

  /* ---------- 她的耳朵（语音识别，2026-11-02） ----------
   * ★ 配置在单独的 `config\voice-asr.json`（`companion-asr.cjs` 管），不和 companion.json 混。
   * 「测一下耳朵」用她自己的嗓子合成一句**已知的话**再让耳朵听回来：
   * 不需要麦克风、不需要发 QQ，就能验"Key 对不对 / 模型通不通 / 转写像不像"。
   */
  ipcMain.handle('companion:asrLoad', () => companion.asr.settings());
  ipcMain.handle('companion:asrSave', (_e, patch = {}) => {
    const p = asObj(patch);
    const next = { ...p };
    if (p.reply && typeof p.reply === 'object') next.reply = { voice: p.reply.voice };
    if (p.ark && typeof p.ark === 'object') {
      next.ark = { ...p.ark };
      if (typeof next.ark.apiKey === 'string') next.ark.apiKey = next.ark.apiKey.trim();
    }
    const cfg = companion.asr.save(next);
    log.info(`语音识别：已保存（enabled=${cfg.enabled} keyed=${!!cfg.ark.apiKey} model=${cfg.ark.model} reply=${cfg.reply.voice}）`);
    return { ok: true, asr: companion.asr.settings() };
  });
  ipcMain.handle('companion:asrTest', async () => {
    const ASR_PROBE_TEXT = '你好呀，我是大肥鱼，今天也一起玩吧。';
    const v = companion.voice.settings();
    if (!v.keyed) return { ok: false, error: '还没配「她的声音」的 Key —— 这个自测用她的嗓子当测试音频' };
    const tts = await companion.voice.preview({ text: ASR_PROBE_TEXT });
    if (!tts.ok) return { ok: false, error: `合成测试音频失败：${tts.error || '未知原因'}` };
    const r = await companion.asr.transcribe(tts.audio, {
      format: 'mp3',
      context: '这是本机合成的测试音频（一段女声中文）',
    });
    log.info(`语音识别：自测${r.ok ? `听到「${String(r.text || '').slice(0, 40)}」` : `失败（${r.error}）`} · ${r.ms || 0}ms`);
    return { ...r, expected: ASR_PROBE_TEXT };
  });

  /* ---------- 表情包（2026-10-26） ---------- */

  ipcMain.handle('companion:stickers', () => companion.stickers.state());
  ipcMain.handle('companion:openStickers', () => shell.showItemInFolder(companion.stickers.dir));
  ipcMain.handle('companion:refreshStickers', async () => {
    log.info('表情：设置页点了「同步 QQ 收藏」');
    return companion.stickers.refresh({ force: true });
  });
}

/** Must be called once, after the local server is up and its port is known. */
function setup(settingsUrl) {
  url = settingsUrl;
  // 语音编辑页 / 服装页 / 她自己的账，由同一个服务提供，只是路径不同
  voiceUrl = settingsUrl.replace(/\/settings$/, '/voice');
  dressUrl = settingsUrl.replace(/\/settings$/, '/dress');
  selfUrl = settingsUrl.replace(/\/settings$/, '/self');
  wire();
}

/** 打开一个应用内的小窗口（设置 / 音色共用）。 */
function openWindow(opts) {
  const w = new BrowserWindow({
    width: opts.width, height: opts.height,
    minWidth: opts.minWidth || 520, minHeight: opts.minHeight || 480,
    title: opts.title,
    icon: path.join(__dirname, 'web', 'app-icon.png'),
    autoHideMenuBar: true,
    backgroundColor: '#11151d',
    webPreferences: {
      preload: path.join(__dirname, opts.preload),
      contextIsolation: true,
      sandbox: true,
    },
  });
  w.loadURL(opts.url);
  return w;
}

function open() {
  if (win && !win.isDestroyed()) { win.show(); win.focus(); return; }
  if (!url) { log.warn('设置窗口还没准备好（服务未启动？）'); return; }
  // 2026-10-22：接口预设 / QQ 陪伴模式改成左右两栏，窗口跟着加宽；高度按 1280×800 屏留出任务栏。
  win = openWindow({ width: 980, height: 740, minWidth: 640, minHeight: 520, title: 'Blue Fish Deskpet · 设置', preload: 'settings-preload.cjs', url });
  win.on('closed', () => { win = null; });
  log.info('打开设置窗口');
}

/**
 * 打开音色编辑窗口（桌宠右键菜单的「音色…」）。
 * 单独一个窗口而不是塞进设置页：调音色要一边拖滑杆一边试听，来回切页签很难受。
 */
function openVoice() {
  if (voiceWin && !voiceWin.isDestroyed()) { voiceWin.show(); voiceWin.focus(); return; }
  if (!voiceUrl) { log.warn('音色窗口还没准备好（服务未启动？）'); return; }
  voiceWin = openWindow({ width: 620, height: 820, title: 'Blue Fish Deskpet · 音色', preload: 'voice-preload.cjs', url: voiceUrl });
  voiceWin.on('closed', () => { voiceWin = null; });
  log.info('打开音色编辑窗口');
}

/**
 * 打开服装窗口（桌宠右键菜单的「换装…」）。
 *
 * 现在只有"原版"能穿（用户明确说了：不要上游那 8 套配色，要等以后做全新服装），
 * 所以这个窗口的作用是**把位置占住**：清单、当前那套、"以后加衣服要往哪放"都写清楚，
 * 免得以后加贴图时又得从零搭一遍 UI。
 */
function openDress() {
  if (dressWin && !dressWin.isDestroyed()) { dressWin.show(); dressWin.focus(); return; }
  if (!dressUrl) { log.warn('服装窗口还没准备好（服务未启动？）'); return; }
  dressWin = openWindow({ width: 620, height: 700, title: 'Blue Fish Deskpet · 服装', preload: 'dress-preload.cjs', url: dressUrl });
  dressWin.on('closed', () => { dressWin = null; });
  log.info('打开服装窗口');
}

/**
 * 打开「她」窗口（桌宠右键菜单的「她的账」）。
 *
 * ★ 2026-11-04：和她说话、聊记忆的那一页分开放在这里，不塞进设置页 ——
 * 这是**她自己的东西**，不是"配置"。用户想翻的是"她认下的事、她喜欢的、她干过的"，
 * 顺手能删、能让她现在就写一笔；和设置页那种改完要保存的表单不是一回事。
 */
function openSelf() {
  if (selfWin && !selfWin.isDestroyed()) { selfWin.show(); selfWin.focus(); return; }
  if (!selfUrl) { log.warn('「她」的窗口还没准备好（服务未启动？）'); return; }
  // ★ 2026-11-04：**高度跟 1280×800 这块屏对齐**。原来写的 860 会超出屏幕下沿
  // （「音色」的 820 已经贴着边了）；这里取 740 —— 里面是四张可滚动的卡，不影响看全。
  selfWin = openWindow({ width: 720, height: 740, title: 'Blue Fish Deskpet · 她', preload: 'self-preload.cjs', url: selfUrl });
  selfWin.on('closed', () => { selfWin = null; });
  log.info('打开「她」窗口');
}

module.exports = { setup, open, openVoice, openDress, openSelf };
