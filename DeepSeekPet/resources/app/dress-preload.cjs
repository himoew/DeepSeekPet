// 服装页面能碰到的全部能力。页面拿不到 ipcRenderer，也碰不到文件系统。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dress', {
  /** 现在有哪几套、现在穿的是哪一套、文件在哪。 */
  load: () => ipcRenderer.invoke('dress:load'),
  /** 换上一套（`{ id }`）。还没贴图的那几套会回一句人话，而不是没反应。 */
  wear: (id) => ipcRenderer.invoke('dress:wear', { id }),
  /** 打开 `data\dress.json` 所在的文件夹（方便你知道"换装记在哪儿"）。 */
  reveal: () => ipcRenderer.invoke('dress:reveal'),
  close: () => ipcRenderer.invoke('dress:close'),
});
