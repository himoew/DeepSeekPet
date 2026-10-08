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
const voiceConfig = require('./voice-config.cjs');

let win = null;
let voiceWin = null;
let url = '';
let voiceUrl = '';
let wired = false;

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
  ipcMain.handle('settings:revealConfig', () => shell.showItemInFolder(llm.CONFIG_FILE));
  ipcMain.handle('settings:openLog', () => shell.openPath(log.file));
  ipcMain.handle('settings:close', () => { if (win && !win.isDestroyed()) win.close(); });

  /* ---------- 它的记忆（只读 + 清空） ---------- */

  ipcMain.handle('settings:memory', () => memory.snapshot());
  ipcMain.handle('settings:forget', () => memory.forget());

  /* ---------- 音色编辑（桌宠右键「音色…」） ---------- */

  ipcMain.handle('voice:load', () => {
    const data = voiceConfig.list(tts.VENDOR);
    return { ...data, available: tts.available(), why: tts.why(), playing: tts.voiceName() };
  });
  ipcMain.handle('voice:save', (_e, { folder, knobs } = {}) => {
    const r = voiceConfig.save(tts.VENDOR, folder, knobs || {});
    if (r.ok) log.info(`音色参数已保存：${folder}`);
    return r;
  });
  ipcMain.handle('voice:activate', async (_e, { folder } = {}) => {
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
  ipcMain.handle('voice:apply', async (_e, { folder, knobs } = {}) => {
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
}

/** Must be called once, after the local server is up and its port is known. */
function setup(settingsUrl) {
  url = settingsUrl;
  // 语音编辑页由同一个服务提供，只是路径不同
  voiceUrl = settingsUrl.replace(/\/settings$/, '/voice');
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
  win = openWindow({ width: 640, height: 780, title: 'Blue Fish Deskpet · 设置', preload: 'settings-preload.cjs', url });
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

module.exports = { setup, open, openVoice };
