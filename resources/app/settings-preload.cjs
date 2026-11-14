// 设置页面能碰到的全部能力。页面拿不到 ipcRenderer，也碰不到文件系统。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('settings', {
  /** 读回当前配置、预设清单、以及配置/日志文件的真实路径。 */
  load: () => ipcRenderer.invoke('settings:load'),
  /** 只覆盖传进来的字段，其余保持不变。 */
  save: (patch) => ipcRenderer.invoke('settings:save', patch),
  /** 拿表单里**还没保存**的值去试一次，方便边填边测。 */
  probe: (patch) => ipcRenderer.invoke('settings:probe', patch),
  /** 探测本机 Ollama（`/api/tags`），只读、不改配置。 */
  detectLocal: () => ipcRenderer.invoke('settings:detectLocal'),
  revealConfig: () => ipcRenderer.invoke('settings:revealConfig'),
  openLog: () => ipcRenderer.invoke('settings:openLog'),
  /** 它的记忆（只读）：认识多少天、聊过几次、各项互动次数… */
  memory: () => ipcRenderer.invoke('settings:memory'),
  /** 它现在的心情（只读）：两条轴 + 中文档位（love / energy / label / speed / cling）。 */
  mood: () => ipcRenderer.invoke('settings:mood'),
  /** 忘掉一切（重新认识）。 */
  forget: () => ipcRenderer.invoke('settings:forget'),
  /* ---------- QQ 陪伴模式（2026-10-22） ---------- */
  /** 读陪伴模式配置、角色卡、记忆摘要和运行状态。 */
  companionLoad: () => ipcRenderer.invoke('companion:load'),
  /** 只覆盖传进来的陪伴字段；`role` 单独存角色卡文件。 */
  companionSave: (patch) => ipcRenderer.invoke('companion:save', patch),
  companionEnable: (on) => ipcRenderer.invoke('companion:enable', on),
  companionClear: () => ipcRenderer.invoke('companion:clear'),
  /** 真的走一遍角色卡 + 记忆 + 模型，回一句。 */
  companionTest: () => ipcRenderer.invoke('companion:test'),
  /** 只测 QQ 模型：可以用表单里还没保存的值，不写记忆、不发 QQ。 */
  companionProbe: (patch) => ipcRenderer.invoke('companion:probe', patch),
  companionOpenRole: () => ipcRenderer.invoke('companion:openRole'),
  companionOpenMemory: () => ipcRenderer.invoke('companion:openMemory'),
  /* ---------- 长期记忆面板（2026-11-01） ---------- */
  /** 列/搜长期记忆：`{q, limit}` → `{total, rows:[{id,when,kind,person,body,tags}]}`。 */
  companionMemoryList: (opts) => ipcRenderer.invoke('companion:memoryList', opts),
  /** 删一条：`{id}`。 */
  companionMemoryDelete: (id) => ipcRenderer.invoke('companion:memoryDelete', { id }),
  /** 立即整理（extract）/ 立即压缩（compress）。 */
  companionMemoryCompact: (what) => ipcRenderer.invoke('companion:memoryCompact', { what }),
  /** ★ 2026-11-01：只清图片缓存，不删记忆。 */
  companionClearMedia: () => ipcRenderer.invoke('companion:clearMedia'),
  /* ---------- QQ 网关（2026-10-26） ---------- */
  /** 只读状态：进程活没活、QQ 登录到哪一步、有没有二维码。 */
  gatewayState: () => ipcRenderer.invoke('companion:gatewayState'),
  /** action: start / stop / restart / refresh / quick（quick 要带 uin）。 */
  gateway: (action, uin) => ipcRenderer.invoke('companion:gateway', { action, uin }),
  /* ---------- 她的声音：2026-11-01 上午已整体搬到「音色」窗口（voice-preload.cjs） ---------- */
  /* ---------- 表情包（2026-10-26） ---------- */
  /** 本地几张 / QQ 收藏几张 / 关键词。 */
  stickers: () => ipcRenderer.invoke('companion:stickers'),
  /** 打开 `data/companion/stickers/`，用户把图丢进去。 */
  openStickers: () => ipcRenderer.invoke('companion:openStickers'),
  /** 重新拉一次小号 QQ 的收藏表情。 */
  refreshStickers: () => ipcRenderer.invoke('companion:refreshStickers'),
  close: () => ipcRenderer.invoke('settings:close'),
});
