/**
 * 语音编辑页能碰到的全部能力。页面拿不到 ipcRenderer，也碰不到文件系统。
 *
 * 两块：
 *   · `voice`    —— 本机音色（fanchen-c 那套 sherpa 模型）的清单 / 参数 / 试听
 *                   （试听不走这里——它是 HTTP 接口 `/api/voice/preview`，页面直接 `<audio>` 放）；
 *   · `qqVoice`  —— ★ 2026-11-01：她在 QQ 里说话的嗓子（火山 1.0，直连）。
 *                   原先在「设置页 → QQ 陪伴卡」里，用户让搬到这个窗口来。
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
  /**
   * ★ 2026-11-02：**桌宠里她回话要不要念出来**（「音色」窗口最上面那张卡）。
   * 存在 `settings.json` 的 `deskVoice`，和 QQ 的 `bubbleVoice` 是两件事。
   */
  deskVoiceLoad: () => ipcRenderer.invoke('voice:deskVoiceLoad'),
  /** `{on, kit}` —— on=要不要念，kit='cloud'（火山 1.0）| 'local'（本机音色）。 */
  deskVoiceSave: (patch) => ipcRenderer.invoke('voice:deskVoiceSave', patch),
});

contextBridge.exposeInMainWorld('qqVoice', {
  /** 开关、四个旋钮、接口地址、混音方案、有没有配 Key（不返回 Key 明文）。 */
  load: () => ipcRenderer.invoke('companion:voiceLoad'),
  /** 存进 config\companion.json 的 voice 段；apiKey 只有明确传了才改。 */
  save: (patch) => ipcRenderer.invoke('companion:voiceSave', patch),
  /** 试听：合成一小段 base64 回来，页面自己播，不发 QQ。 */
  preview: (patch) => ipcRenderer.invoke('companion:voicePreview', patch),
  /** 有没有 Key（只看本地，不联网）。 */
  probe: () => ipcRenderer.invoke('companion:voiceProbe'),
  /** 手改了 companion.json（换音色配比）之后重新读一遍，不用重启桌宠。 */
  reload: () => ipcRenderer.invoke('companion:voiceReload'),
});

/**
 * ★ 2026-11-02：她的耳朵（语音识别，方舟 doubao-seed-2-1-lite）。
 * 配置在**单独的** `config\voice-asr.json`（不和 companion.json 互相覆盖）。
 */
contextBridge.exposeInMainWorld('asr', {
  load: () => ipcRenderer.invoke('companion:asrLoad'),
  save: (patch) => ipcRenderer.invoke('companion:asrSave', patch),
  /** 自测：用她自己的嗓子合成一句已知的话，再让耳朵听回来（不占麦克风、不发 QQ）。 */
  test: () => ipcRenderer.invoke('companion:asrTest'),
});
