/**
 * 语音编辑页能碰到的全部能力。页面拿不到 ipcRenderer，也碰不到文件系统。
 * 只暴露"读音色清单 / 存参数 / 换当前音色 / 让引擎换过来"四件事
 * （试听不走这里——它是一条 HTTP 接口 `/api/voice/preview`，页面直接 `<audio>` 放）。
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('voice', {
  /** 有哪些音色、当前是哪套、每套的参数和取值范围。 */
  load: () => ipcRenderer.invoke('voice:load'),
  /** 给某一套音色保存参数（写进它的 voice.json）。 */
  save: (folder, knobs) => ipcRenderer.invoke('voice:save', { folder, knobs }),
  /** 保存 + 切成当前音色 + 重建引擎（真正让新参数生效）。约 2~4 秒。 */
  apply: (folder, knobs) => ipcRenderer.invoke('voice:apply', { folder, knobs }),
  /** 切换当前用哪套音色（改 voices\.active）。 */
  activate: (folder) => ipcRenderer.invoke('voice:activate', { folder }),
  /** 让正在跑的语音引擎重新读设置并换过来（会重新加载模型，约 2~4 秒）。 */
  reload: () => ipcRenderer.invoke('voice:reload'),
  revealVoices: () => ipcRenderer.invoke('voice:reveal'),
  openLog: () => ipcRenderer.invoke('settings:openLog'),
  close: () => ipcRenderer.invoke('voice:close'),
});
