/**
 * Electron main process for the pet window.
 *
 * Run as `electron electron-main.cjs --pet-url=http://127.0.0.1:<port>/pet`, or call
 * `runPetHost({ url, parentPid })` from an app's own main process. With `--parent-pid=<pid>`
 * the window closes once that process exits. The window covers the work area of one display
 * (the primary one at start), is transparent and always on top, and ignores the mouse until the
 * page reports the pointer is over the figure, a bubble or the menu. When the pet is carried onto
 * another display, the window moves to that display mid-drag; when its display is unplugged, it
 * moves to the primary one. A tray icon shows, hides and closes it; an embedding app that has its
 * own tray passes `tray: false`.
 *
 * On macOS the window shows on every Space and over full-screen apps, the process keeps out of
 * the Dock, and the microphone is asked for before the page opens it (the app's Info.plist
 * carries the reason macOS shows). The keyboard is not taken for a question's number keys there:
 * macOS gives no way to hand it back to the app that had it.
 */
const { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage, screen, session, shell, systemPreferences } = require('electron');
const { join } = require('node:path');
const { appendFileSync, statSync, renameSync, writeFileSync } = require('node:fs');

/**
 * 诊断日志：**主进程的 console.log 在 GUI 起来之后是被丢掉的**（实测：加的探针一行都没进
 * pet.log），所以"桌宠窗口没出现"这类问题必须写文件才查得动。放在 `data\pet-host.log`，
 * 故意跟 pet.log 分开——它是窗口层的，不该混进她的行为日志里。
 * 想要安静就删掉这个文件（它会自己再建）。
 *
 * **它必须有上限**：那个每 2 秒一次的心跳曾经无条件写一行 ≈ 每天 4.3 万行、约 5 MB，
 * 而这个文件当时没有任何轮转。现在超过 `LOG_MAX` 就改名成 `.1`（旧的 `.1` 被覆盖），
 * 所以 `data\` 下最多两份、合计约 2×`LOG_MAX`。写不进去也绝不让桌宠起不来。
 */
const LOG_MAX = 2 * 1024 * 1024;
/** 日志路径与当前大小都懒着算：`app.getPath` 在 app ready 之前不一定可用。 */
let logFile = '';
let logSize = -1;
function diag(msg) {
  try {
    if (!logFile) logFile = join(app.getPath('userData'), '..', 'pet-host.log');
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    if (logSize < 0) { try { logSize = statSync(logFile).size; } catch { logSize = 0; } }
    if (logSize > LOG_MAX) {
      try { renameSync(logFile, `${logFile}.1`); } catch { try { writeFileSync(logFile, ''); } catch { /* 都不行就继续追加 */ } }
      logSize = 0;
    }
    appendFileSync(logFile, line);
    logSize += Buffer.byteLength(line);
  } catch { /* 诊断本身绝不能让桌宠起不来 */ }
}

/** Milliseconds between the cursor reports the page gets. */
const CURSOR_EVERY_MS = 100;
/** Most pixels one backdrop sample returns. */
const BACKDROP_SAMPLES = 1500;

/**
 * GDI calls for copying a small patch of the screen, or null off Windows or when koffi does not
 * load. A patch through BitBlt costs about a millisecond; a desktopCapturer frame of the whole
 * screen stalls the cursor.
 */
const gdi = (() => {
  if (process.platform !== 'win32') return null;
  try {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll'), gdi32 = koffi.load('gdi32.dll');
    return {
      GetDC: user32.func('void * __stdcall GetDC(void *hwnd)'),
      ReleaseDC: user32.func('int __stdcall ReleaseDC(void *hwnd, void *hdc)'),
      CreateCompatibleDC: gdi32.func('void * __stdcall CreateCompatibleDC(void *hdc)'),
      CreateCompatibleBitmap: gdi32.func('void * __stdcall CreateCompatibleBitmap(void *hdc, int w, int h)'),
      SelectObject: gdi32.func('void * __stdcall SelectObject(void *hdc, void *obj)'),
      StretchBlt: gdi32.func('int __stdcall StretchBlt(void *dst, int dx, int dy, int dw, int dh, void *src, int sx, int sy, int sw, int sh, uint32_t rop)'),
      GetDIBits: gdi32.func('int __stdcall GetDIBits(void *hdc, void *hbm, uint32_t start, uint32_t lines, void *bits, void *bmi, uint32_t usage)'),
      DeleteObject: gdi32.func('int __stdcall DeleteObject(void *obj)'),
      DeleteDC: gdi32.func('int __stdcall DeleteDC(void *hdc)'),
    };
  } catch {
    return null;
  }
})();

/**
 * Moving the keyboard between windows while the pet asks something. Windows keeps a background
 * process from bringing its window forward (`win.focus()` alone does nothing), unless its thread
 * shares input with the foreground one for the call. Null off Windows or when koffi does not load.
 */
const foreground = (() => {
  if (process.platform !== 'win32') return null;
  try {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll'), kernel32 = koffi.load('kernel32.dll');
    const GetForegroundWindow = user32.func('intptr_t __stdcall GetForegroundWindow()');
    const SetForegroundWindow = user32.func('int __stdcall SetForegroundWindow(intptr_t hwnd)');
    const BringWindowToTop = user32.func('int __stdcall BringWindowToTop(intptr_t hwnd)');
    const GetWindowThreadProcessId = user32.func('uint32_t __stdcall GetWindowThreadProcessId(intptr_t hwnd, void *pid)');
    const AttachThreadInput = user32.func('int __stdcall AttachThreadInput(uint32_t from, uint32_t to, int attach)');
    const GetCurrentThreadId = kernel32.func('uint32_t __stdcall GetCurrentThreadId()');
    return {
      /** The window with the keyboard now, 0n for none. */
      current: () => BigInt(GetForegroundWindow()),
      /** Gives `hwnd` the keyboard; true when Windows let it. */
      give(hwnd) {
        const cur = GetForegroundWindow();
        const them = cur ? GetWindowThreadProcessId(cur, null) : 0, me = GetCurrentThreadId();
        const attached = them && them !== me && AttachThreadInput(me, them, 1);
        try {
          BringWindowToTop(hwnd);
          return !!SetForegroundWindow(hwnd);
        } finally {
          if (attached) AttachThreadInput(me, them, 0);
        }
      },
    };
  } catch {
    return null;
  }
})();

/** A window's HWND as a BigInt. */
function hwndOf(win) {
  const b = win.getNativeWindowHandle();
  return b.length === 8 ? b.readBigInt64LE(0) : BigInt(b.readInt32LE(0));
}

/** `w`×`h` screen pixels from (x, y) in physical pixels, shrunk to `ow`×`oh`, as top-down BGRA. */
function grabScreen(x, y, w, h, ow, oh) {
  const screenDc = gdi.GetDC(null), memDc = gdi.CreateCompatibleDC(screenDc), bmp = gdi.CreateCompatibleBitmap(screenDc, ow, oh);
  try {
    const old = gdi.SelectObject(memDc, bmp);
    const SRCCOPY = 0x00CC0020;
    const ok = gdi.StretchBlt(memDc, 0, 0, ow, oh, screenDc, x, y, w, h, SRCCOPY);
    gdi.SelectObject(memDc, old);
    if (!ok) return null;
    // BITMAPINFOHEADER: 32-bit, uncompressed, negative height for top-down rows
    const bmi = Buffer.alloc(44);
    bmi.writeUInt32LE(40, 0); bmi.writeInt32LE(ow, 4); bmi.writeInt32LE(-oh, 8); bmi.writeUInt16LE(1, 12); bmi.writeUInt16LE(32, 14);
    const bits = Buffer.alloc(ow * oh * 4);
    return gdi.GetDIBits(memDc, bmp, 0, oh, bits, bmi, 0) === oh ? bits : null;
  } finally {
    gdi.DeleteObject(bmp); gdi.DeleteDC(memDc); gdi.ReleaseDC(null, screenDc);
  }
}

/**
 * Screen pixels under `rect`, leaving out those inside any of `skip`; both in page coordinates
 * (DIP, relative to `win`). The pet window may show in the copy, so the page skips its own figure
 * and bubbles. Returns a flat [r, g, b, r, g, b, …] of at most BACKDROP_SAMPLES pixels, [] when
 * this copy failed, or null where the screen cannot be read cheaply at all.
 */
function sampleBackdrop(win, { rect, skip = [] }) {
  if (!gdi) return null;
  if (!rect || !(rect.width > 0) || !(rect.height > 0)) return [];
  const b = win.getBounds();
  // physical pixels at the scale of the display the window is on
  const { x, y, width, height } = screen.dipToScreenRect(win, { x: b.x + rect.x, y: b.y + rect.y, width: rect.width, height: rect.height });
  const w = Math.max(1, width), h = Math.max(1, height);
  const step = Math.max(1, Math.sqrt(w * h / BACKDROP_SAMPLES));
  const ow = Math.max(1, Math.round(w / step)), oh = Math.max(1, Math.round(h / step));
  const bits = grabScreen(x, y, w, h, ow, oh);
  if (!bits) return [];
  const out = [];
  for (let j = 0; j < oh; j++) for (let i = 0; i < ow; i++) {
    const px = rect.x + (i + .5) * rect.width / ow, py = rect.y + (j + .5) * rect.height / oh;
    if (skip.some((r) => px >= r.x && px < r.x + r.width && py >= r.y && py < r.y + r.height)) continue;
    const k = (j * ow + i) * 4;
    // BGRA
    out.push(bits[k + 2], bits[k + 1], bits[k]);
  }
  return out;
}

/**
 * 32×32 tray icon drawn in code: the C outline and two ring eyes, white on the brand green; on
 * macOS a black template image the menu bar tints to its own color.
 *
 * **现在只当后备**：托盘优先用 `web\tray-icon.png`（大肥鱼的头像，见 tools\patch-assets.mjs 第 5 处）。
 * 那个文件不在（比如重抽后还没部署图标）时才退回这一版手绘的 —— 所以别把它当死代码删掉。
 */
function trayIcon() {
  const ours = nativeImage.createFromPath(join(__dirname, 'web', 'tray-icon.png'));
  if (!ours.isEmpty()) return ours;
  const mac = process.platform === 'darwin';
  const n = 32, buf = Buffer.alloc(n * n * 4);
  const ring = (px, py, cx, cy, r, w) => Math.abs(Math.hypot(px - cx, py - cy) - r) <= w / 2;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const i = (y * n + x) * 4, px = x + .5, py = y + .5;
    const inside = Math.hypot(px - 16, py - 16) <= 15.5;
    const a = Math.atan2(16 - py, px - 16) * 180 / Math.PI;
    const c = ring(px, py, 16, 16, 10.5, 3.6) && Math.abs(a) > 48;
    const eye = ring(px, py, 14.1, 14.6, 2.2, 1.5) || ring(px, py, 20.4, 14.6, 2.2, 1.5);
    const white = c || eye;
    // BGRA
    if (mac) { buf[i] = buf[i + 1] = buf[i + 2] = 0; buf[i + 3] = white ? 255 : 0; continue; }
    buf[i] = white ? 255 : 0x70; buf[i + 1] = white ? 255 : 0xA8; buf[i + 2] = white ? 255 : 0x00; buf[i + 3] = inside ? 255 : 0;
  }
  const img = nativeImage.createFromBitmap(buf, { width: n, height: n, scaleFactor: mac ? 2 : 1 });
  if (mac) img.setTemplateImage(true);
  return img;
}

function runPetHost({ url, parentPid = 0, tray: withTray = true, openSettings = null, openLog = null }) {
  if (!url) throw new Error('pet host needs --pet-url');
  const origin = new URL(url).origin;
  let win = null, tray = null, dress = null, heartbeat = null;
  /** Id of the display whose work area the window covers. */
  let displayId = null;

  /** The display the window belongs on: the one it was moved to, or the primary display once that one is gone. */
  const display = () => screen.getAllDisplays().find((d) => d.id === displayId) ?? screen.getPrimaryDisplay();

  const cover = (d) => {
    displayId = d.id;
    const { x, y, width, height } = d.workArea;
    win.setBounds({ x, y, width, height });
    // Windows: a window moved onto a display with another scale factor is resized by the DPI
    // change to its old size times the ratio of the two scales; once it is on the new display, the
    // same bounds set again hold.
    win.setBounds({ x, y, width, height });
  };

  const place = () => { if (win) cover(display()); };

  const create = () => {
    diag(`create() · displays=${JSON.stringify(screen.getAllDisplays().map((x) => ({ id: x.id, wa: x.workArea, scale: x.scaleFactor })))}`);
    const d = display(), wa = d.workArea;
    win = new BrowserWindow({
      x: wa.x, y: wa.y, width: wa.width, height: wa.height,
      transparent: true, frame: false, resizable: false, movable: false, minimizable: false, maximizable: false,
      fullscreenable: false, skipTaskbar: true, hasShadow: false, alwaysOnTop: true, show: false,
      backgroundColor: '#00000000', title: 'Blue Fish Deskpet',
    icon: join(__dirname, 'web', 'app-icon.png'),
      // Windows: Chromium-based apps treat a topmost window without WS_EX_TOOLWINDOW as covering them and stop painting while the pet takes the mouse
      ...(process.platform === 'win32' ? { type: 'toolbar' } : {}),
      webPreferences: {
        preload: join(__dirname, 'preload.cjs'),
        contextIsolation: true, sandbox: true, backgroundThrottling: false,
        autoplayPolicy: 'no-user-gesture-required',
      },
    });
    cover(d);
    // Native candidate windows and Chromium popups must remain above the pet.
    win.setAlwaysOnTop(true, process.platform === 'darwin' ? 'floating' : 'screen-saver');
    // on every Space, and over an app in full screen
    if (process.platform === 'darwin') win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    win.setIgnoreMouseEvents(true, { forward: true });
    win.webContents.setWindowOpenHandler(({ url: target }) => {
      if (target.startsWith(origin)) { openDress(target); return { action: 'deny' }; }
      shell.openExternal(target);
      return { action: 'deny' };
    });
    // 让她出现。**别只靠 `ready-to-show`**：它是"首帧画好了"的通知，而透明窗口偶尔
    // 根本不发这个事件（页面一直没提交帧、GPU 初始化出问题…），于是进程活着、日志正常、
    // 渲染循环也在跑，**窗口却始终是隐藏的**——用户看到的就是"桌面上没有宠物"，
    // 而所有日志都显示一切正常（实测踩过：窗口存在、IsWindowVisible 为 False）。
    // 所以：`ready-to-show` 到了就立刻显示，**再挂一个 2.5 秒的兜底**，到点还没显示就照样显示
    // （透明窗口在页面画好之前是空的，show 一下没有任何副作用）。
    let shown = false;
    const showNow = (why) => {
      if (shown || !win) return;
      shown = true;
      win.showInactive();
      diag(`窗口已显示（${why}）visible=${win.isVisible()}`);
    };
    win.once('ready-to-show', () => showNow('ready-to-show'));
    setTimeout(() => { if (!shown) showNow('兜底：ready-to-show 没来，2.5 秒后自己显示'); }, 2500);
    // the page learns where the cursor is even when the click-through window misses its moves
    let last = '';
    const cursorTimer = setInterval(() => {
      if (!win || !win.isVisible()) return;
      const pt = screen.getCursorScreenPoint(), b = win.getBounds();
      const inside = pt.x >= b.x && pt.x < b.x + b.width && pt.y >= b.y && pt.y < b.y + b.height;
      const at = inside ? { x: pt.x - b.x, y: pt.y - b.y } : null;
      const key = at ? `${at.x},${at.y}` : '';
      if (key === last) return;
      last = key;
      win.webContents.send('pet:cursor', at);
    }, CURSOR_EVERY_MS);
    win.on('closed', () => { clearInterval(cursorTimer); win = null; });
    // page console lines reach the World's log through stdout —— **但 GUI 起来之后 stdout 是被
    // 丢掉的**，所以页面里的 JS 报错原来谁也看不到。这里把 warning/error 写进诊断文件：
    // "她画不出来"这类问题只有这一条线索（自检是纯 Node，验不到浏览器里的异常）。
    win.webContents.on('console-message', (e) => {
      const lvl = e.level ?? 0;
      if (lvl === 2 || lvl === 3) diag(`[page:${lvl === 3 ? 'error' : 'warn'}] ${e.message}  @${e.lineNumber || 0}`);
    });
    win.webContents.on('preload-error', (_e, p, err) => diag(`[preload 出错] ${p}: ${err && err.message}`));
    win.webContents.on('did-fail-load', (_e, code, desc, failedUrl) => console.log(`[page:error] 加载失败 ${code} ${desc} ${failedUrl}`));
    diag(`BrowserWindow 建好了 · bounds=${JSON.stringify(win.getBounds())} · visible=${win.isVisible()}`);
    // `DSP_DIAG=1` 时给页面加 `?diag=1`：页面会把自己的绘制状态持续写进标题，
    // 于是从窗口外面就能看到"她到底画了没有"（见 web\pet.html 末尾那段）。
    win.loadURL(process.env.DSP_DIAG === '1' ? `${url}${url.includes('?') ? '&' : '?'}diag=1` : url);
    win.webContents.on('did-finish-load', () => diag('页面加载完成(did-finish-load)'));
    win.webContents.on('render-process-gone', (_e, d2) => diag(`渲染进程没了：${JSON.stringify(d2)}`));
    // **心跳**：每 2 秒记一次它到底可见不可见、被摆到哪儿、还是不是置顶。
    // 排查"桌面上没有宠物"只有这一条路——`console.log` 在 GUI 里是被丢掉的。
    if (!heartbeat) {
      let lastBeat = '', lastBeatAt = 0;
      heartbeat = setInterval(() => {
        if (!win) return;
        const beat = `visible=${win.isVisible()} bounds=${JSON.stringify(win.getBounds())} top=${win.isAlwaysOnTop()} min=${win.isMinimized()}`;
        // **只在状态真的变了的时候写一行**（外加每 5 分钟留一次"我还活着"）。
        // 原来的写法是无条件每 2 秒一行 ≈ 每天 4.3 万行，把这个文件写成了几百 MB 的垃圾，
        // 而真正要看的信息（什么时候被隐藏了、被谁移位了）反而是变化时那几行。
        const now = Date.now();
        if (beat === lastBeat && now - lastBeatAt < 5 * 60_000) return;
        lastBeat = beat; lastBeatAt = now;
        diag(`心跳 ${beat}`);
      }, 2000);
    }
    win.on('hide', () => diag('★ 窗口被隐藏了（hide 事件）'));
    win.on('show', () => diag('窗口被显示（show 事件）'));
    win.on('move', () => { if (win) diag(`窗口被移动 → ${JSON.stringify(win.getBounds())}`); });
  };

  const openDress = (target = `${origin}/dress`) => {
    if (dress) { dress.show(); dress.focus(); return; }
    dress = new BrowserWindow({ width: 980, height: 720, title: '桌宠装扮', autoHideMenuBar: true, webPreferences: { contextIsolation: true, sandbox: true } });
    dress.on('closed', () => { dress = null; });
    dress.loadURL(target);
  };

  ipcMain.on('pet:interactive', (_e, on) => { if (win) win.setIgnoreMouseEvents(!on, { forward: true }); });
  ipcMain.on('pet:focus', () => {
    if (!win) return;
    // Explicit text input activates this menu-bar process as well as its window.
    if (process.platform === 'darwin') app.focus({ steal: true });
    win.focus();
  });
  /** The window that had the keyboard before a question took it; it gets it back afterwards. */
  let lent = 0n;
  ipcMain.on('pet:grabFocus', () => {
    if (!win || !win.isVisible() || process.platform === 'darwin') return;
    if (foreground) {
      const own = hwndOf(win), cur = foreground.current();
      if (cur !== own && foreground.give(own)) lent = cur;
    }
    win.focus();
  });
  ipcMain.on('pet:releaseFocus', () => {
    const back = lent;
    lent = 0n;
    if (!win) return;
    // someone clicked elsewhere meanwhile: the keyboard is already where they want it
    if (foreground) { if (back && foreground.current() === hwndOf(win)) foreground.give(back); }
    else if (win.isFocused()) win.blur();
  });
  // 隐藏 / 显示都留一行日志：**"桌面上没有宠物"这种问题，只有这两行能告诉你发生过什么**
  // （原来这里是静默的，只能靠 `IsWindowVisible` 反查，很费时间）。
  ipcMain.on('pet:hide', () => { if (win) { diag('窗口被隐藏（页面请求）'); win.hide(); } });
  // 页面把异常 / 启动节点报上来：**写进诊断文件**。主进程的 console 在 GUI 里是丢掉的，
  // 所以"她没画出来"这类问题只能靠这条通道留痕（见 web\diag.js）。
  ipcMain.on('pet:report', (_e, msg) => diag(`[页面] ${String(msg).replace(/\s+/g, ' ').slice(0, 1200)}`));
  ipcMain.on('pet:openDress', () => openDress());
  ipcMain.handle('pet:sampleBackdrop', (_e, query) => {
    try { return win ? sampleBackdrop(win, query || {}) : []; } catch { return []; }
  });
  /**
   * A drag carried or let go of outside the window: when the cursor is over another display, the
   * window moves there and the page gets the cursor's spot in its new coordinates, its new size, and
   * how far a point on screen moved in page coordinates (`dx`, `dy`); null leaves it where it is.
   */
  ipcMain.handle('pet:followCursor', () => {
    if (!win) return null;
    const pt = screen.getCursorScreenPoint(), d = screen.getDisplayNearestPoint(pt);
    const from = display();
    if (d.id === from.id) return null;
    cover(d);
    const wa = d.workArea;
    return { x: pt.x - wa.x, y: pt.y - wa.y, w: wa.width, h: wa.height, dx: from.workArea.x - wa.x, dy: from.workArea.y - wa.y };
  });

  // a pet is not an app to switch to
  if (process.platform === 'darwin') app.dock?.hide();
  app.whenReady().then(async () => {
    // macOS asks once, before the page first opens the microphone
    if (process.platform === 'darwin' && systemPreferences.getMediaAccessStatus('microphone') === 'not-determined') {
      await systemPreferences.askForMediaAccess('microphone').catch(() => false);
    }
    session.defaultSession.setPermissionRequestHandler((wc, permission, done) => {
      done(permission === 'media' && wc.getURL().startsWith(origin));
    });
    session.defaultSession.setPermissionCheckHandler((wc, permission, requestingOrigin) => permission === 'media' && requestingOrigin === origin);
    create();
    screen.on('display-metrics-changed', place);
    screen.on('display-added', place);
    screen.on('display-removed', place);
    if (!withTray) return;
    tray = new Tray(trayIcon());
    tray.setToolTip('Blue Fish Deskpet');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '显示桌宠', click: () => { if (!win) create(); else { win.show(); win.showInactive(); diag('窗口被显示（托盘菜单）'); } } },
      { label: '隐藏桌宠', click: () => { if (win) { win.hide(); diag('窗口被隐藏（托盘菜单）'); } } },
      { label: '设置…', click: () => { if (openSettings) openSettings(); } },
      { label: '打开日志', click: () => { if (openLog) openLog(); } },
      { type: 'separator' },
      { label: '关闭桌宠窗口', click: () => app.quit() },
    ]));
    tray.on('click', () => {
      if (!win) return;
      // `showInactive()` 对"先前被 hide() 过"的窗口未必有效，所以**先 show 再 showInactive**
      if (win.isVisible()) { win.hide(); diag('窗口被隐藏（点托盘图标）'); }
      else { win.show(); win.showInactive(); diag('窗口被显示（点托盘图标）'); }
    });
  });
  app.on('window-all-closed', () => { if (!tray) app.quit(); });
  // with --parent-pid the window closes once that process is gone
  if (parentPid) {
    setInterval(() => {
      try { process.kill(parentPid, 0); } catch { app.quit(); }
    }, 2000).unref();
  }
}

module.exports = { runPetHost };

// Electron's default app loads the script without making it require.main
if (process.argv[1] && require('node:path').resolve(process.argv[1]) === __filename) {
  const arg = process.argv.find((a) => a.startsWith('--pet-url='));
  const parent = process.argv.find((a) => a.startsWith('--parent-pid='));
  runPetHost({ url: arg ? arg.slice('--pet-url='.length) : '', parentPid: parent ? Number(parent.slice('--parent-pid='.length)) : 0 });
}
