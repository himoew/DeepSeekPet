// 设置页面能碰到的全部能力。页面拿不到 ipcRenderer，也碰不到文件系统。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('settings', {
  /** 读回当前配置、预设清单、以及配置/日志文件的真实路径。 */
  load: () => ipcRenderer.invoke('settings:load'),
  /** 只覆盖传进来的字段，其余保持不变。 */
  save: (patch) => ipcRenderer.invoke('settings:save', patch),
  /** 拿表单里**还没保存**的值去试一次，方便边填边测。 */
  probe: (patch) => ipcRenderer.invoke('settings:probe', patch),
  revealConfig: () => ipcRenderer.invoke('settings:revealConfig'),
  openLog: () => ipcRenderer.invoke('settings:openLog'),
  /** 它的记忆（只读）：认识多少天、聊过几次、各项互动次数… */
  memory: () => ipcRenderer.invoke('settings:memory'),
  /** 忘掉一切（重新认识）。 */
  forget: () => ipcRenderer.invoke('settings:forget'),
  close: () => ipcRenderer.invoke('settings:close'),
});
