/**
 * 「她」窗口（web\self.html）能碰到的全部能力。页面拿不到 ipcRenderer，也碰不到文件系统。
 *
 * 这一页只干一件事：**看/管她自己的账**（锚、账、证词、传）。所有读写都由主进程
 * `companion.selfView() / selfJudge() / selfKernel()` 完成，这里只做一层薄薄的转发 ——
 * 页面不需要知道 `self\ledger.jsonl` 长什么样，也绝不能直接写它。
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('her', {
  /** 一次拉齐：状态条、证词、账、传、目录。字段全都可能缺，页面自己兜底。 */
  load: () => ipcRenderer.invoke('self:load'),
  /**
   * 立即写一笔：真的跑一次模型（可能要几秒，也可能失败）。
   * 页面点了之后要把按钮禁用并显示「写…」，回来再按 `ok` / `added` / `changed` 说话。
   */
  judge: () => ipcRenderer.invoke('self:judge'),
  /** 手动加一条账：`kind` 是 taste/stance/doing/want/change，`claim` 是一句话。 */
  add: (kind, claim) => ipcRenderer.invoke('self:add', { kind, claim }),
  /** 删掉一条（锚也走这里）：`id` 是她账里的 id。 */
  retire: (id) => ipcRenderer.invoke('self:retire', { id }),
  /** 在资源管理器里指出她的账文件夹（ledger.jsonl 就在里面）。 */
  openDir: () => ipcRenderer.invoke('self:openDir'),
  /**
   * ★ 2026-11-05：「她想的」那张卡。
   *   · `imagine(seed)` 让她现在想一个（**真跑模型，1~2 眼约 3 秒**）；
   *   · `imagineDrop(id)` 删掉一张。
   * ⚠️ 想象不是记忆：它不写账、不进长期记忆 —— 页面上别写成"记下来"。
   */
  imagine: (seed) => ipcRenderer.invoke('self:imagine', { seed }),
  imagineDrop: (id) => ipcRenderer.invoke('self:imagineDrop', { id }),
  close: () => ipcRenderer.invoke('self:close'),
});
