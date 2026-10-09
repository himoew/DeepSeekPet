// The only surface the pet page gets from the window process.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('petHost', {
  /** true: the window takes the mouse; false: clicks pass through to what is underneath. */
  setInteractive: (on) => ipcRenderer.send('pet:interactive', !!on),
  focus: () => ipcRenderer.send('pet:focus'),
  /** Takes the keyboard from whatever window has it (a question's number keys), and gives it back. */
  grabFocus: () => ipcRenderer.send('pet:grabFocus'),
  releaseFocus: () => ipcRenderer.send('pet:releaseFocus'),
  hide: () => ipcRenderer.send('pet:hide'),
  openDress: () => ipcRenderer.send('pet:openDress'),
  /**
   * 诊断上报（页面异常 / 启动节点 / 绘制失败）。**只写日志，不做别的**：
   * 主进程的 console 在 GUI 里是被丢掉的，"她没画出来"时这是唯一的线索（见 web\diag.js）。
   */
  report: (msg) => ipcRenderer.send('pet:report', String(msg)),
  /**
   * "小肥鱼已经画出来了" —— 主进程收到才显示窗口（见 `pet-host.cjs` 的 `pet:painted`）。
   * 这样启动时**窗口还没画好内容的那一瞬根本不会露出来**（否则会先闪一下内置的上游形象）。
   */
  painted: () => ipcRenderer.send('pet:painted'),
  /** Where the cursor is, in page pixels, or null off the window: called a few times a second. */
  onCursor: (cb) => ipcRenderer.on('pet:cursor', (_e, p) => cb(p)),
  /** Screen pixels behind `rect`, minus `skip` rects (page coordinates), as a flat [r, g, b, …]; null where the screen cannot be read. */
  sampleBackdrop: (rect, skip) => ipcRenderer.invoke('pet:sampleBackdrop', { rect, skip }),
  /** Moves the window to the display under the cursor: { x, y } the cursor and { w, h } the new size in page pixels, or null when it stays. */
  followCursor: () => ipcRenderer.invoke('pet:followCursor'),
});
