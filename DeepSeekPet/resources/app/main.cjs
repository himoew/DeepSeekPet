/**
 * DeepSeekPet —— Electron 主进程。
 *
 * 三件事：
 *   1. 起一个只绑 127.0.0.1 的 HTTP + WebSocket 服务，桌宠页面和设置页面都由它提供；
 *   2. `runPetHost`（Coopanion 的桌宠窗口宿主）把桌宠页面放进一个透明、点击穿透、
 *      置顶的窗口里；
 *   3. 设置窗口 —— 托盘「设置…」和桌宠右键菜单里的「打开设置」都走它。
 *
 * 退出走桌宠自己：右键它，或者右键托盘图标。
 */
const path = require('node:path');
const { app, dialog, BrowserWindow, shell } = require('electron');
const log = require('./log.cjs');

// `__dirname` 是 <应用目录>\resources\app，所以这就是用户看到的那个文件夹。
const APP_ROOT = path.join(__dirname, '..', '..');

log.info(`main.cjs 已加载 · Electron ${process.versions.electron} · Node ${process.versions.node} · Chromium ${process.versions.chrome}`);
log.info(`运行时:${process.execPath}`);
log.info(`应用目录:${APP_ROOT}`);
log.info(`命令行:${process.argv.slice(1).join(' ') || '(无)'}`);

// Chromium 的 profile、缓存、GPU 状态都放这里。放应用目录而不是 %APPDATA%，
// 整个文件夹才是自包含的，"删掉 data\ 就等于恢复出厂"也才成立。
// 必须在 app.whenReady() 之前设置。
app.setPath('userData', path.join(APP_ROOT, 'data', 'userdata'));

process.on('uncaughtException', (err) => log.fatal('未捕获异常', err));
process.on('unhandledRejection', (err) => log.fatal('未处理的 Promise 拒绝', err));

// 桌宠窗口关掉不等于退出：托盘图标还能把它叫回来，所以 pet-host.cjs 自己管
// `window-all-closed`，这里不再插手。

/**
 * 已经有一条在跑的时候又被启动，不能看起来像什么都没发生：把现有窗口叫到前面来。
 * （设置窗口不算，它是我们自己开的。）
 */
function revealPet() {
  const windows = BrowserWindow.getAllWindows();
  // ★ 这个字面量必须跟 settings.cjs 里那个窗口标题**一字不差**（自检里有一条盯着它）
  const win = windows.find((w) => w.getTitle() !== 'Blue Fish Deskpet · 设置') ?? windows[0];
  if (!win) {
    log.warn('又有人启动桌宠，但没找到桌宠窗口（试试托盘菜单的「显示桌宠」）');
    return;
  }
  win.showInactive();
  win.setAlwaysOnTop(true, 'screen-saver');
  log.info('又有人启动了桌宠，已经把现有的那条叫出来');
}

if (app.requestSingleInstanceLock()) {
  app.on('second-instance', revealPet);

  app.whenReady().then(async () => {
    const llm = require('./llm.cjs');
    const settings = require('./settings.cjs');
    const tts = require('./tts.cjs');
    const { startServer } = require('./server.cjs');
    const { runPetHost } = require('./pet-host.cjs');

    const { port } = await startServer();
    const origin = `http://127.0.0.1:${port}`;
    log.info(`服务就绪 ${origin}/pet · 设置 ${origin}/settings`);

    settings.setup(`${origin}/settings`);

    // 本地模型第一次被问要读好几 GB 权重（实测 7B 约 11 秒）。启动时先悄悄问一句，
    // 把这段等待挪到你看不见的地方；不 await，所以窗口照常立刻打开。
    if (llm.isOn() && llm.isLocal() && llm.load().prewarm) {
      llm.warm().catch((err) => log.warn(`本地模型预热失败:${err.message}`));
    }

    // 语音模型要读 18MB 权重 + 建 onnxruntime 会话（实测约 8.5 秒），也放在启动时预热，
    // 这样第一句回答就已经是热的。没有语音文件就记一行原因，桌宠照常安静地跑。
    if (tts.available()) tts.warm().catch((err) => log.warn(`语音预热失败:${err.message}`));
    else log.info(`语音关闭：${tts.why()}`);

    // 退出时把语音 worker 收掉，别留下一个线程
    app.on('will-quit', () => tts.close());

    runPetHost({
      url: `${origin}/pet`,
      openSettings: settings.open,
      openLog: () => shell.openPath(log.file),
    });
  }).catch((err) => {
    log.fatal('启动失败', err);
    dialog.showErrorBox('Blue Fish Deskpet 启动失败', String((err && err.stack) || err));
    app.exit(1);
  });
} else {
  log.info('已经有一条大肥鱼在跑了，这次启动退出');
  app.exit(0);
}
