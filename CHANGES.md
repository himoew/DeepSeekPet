# 修改声明（AGPL-3.0 §5(a)）

本仓库是 **Coopanion** 的**修改版**，不是原版。按 GNU AGPL-3.0 §5(a) 的要求，这里写清楚
**基于什么、改了哪些文件、什么时候改的**。每一笔改动在 `git log` 里都有记录，完整开发过程见
[`HANDOVER.md`](HANDOVER.md)。

## 基于什么

- 上游：[**Pal-AI-Lab/Coopanion**](https://github.com/Pal-AI-Lab/Coopanion)
- 版本：**0.1.13**（`Coopanion/resources/app/package.json` 里 `license: AGPL-3.0-or-later`，
  作者 Pal-AI-Lab）
- 抽取来源：Coopanion 内置的桌宠包 `cortico-world-desktop-pet`（该包在**并入 Coopanion 之前**
  的独立历史是 MIT；**我们用的是并入之后、随 Coopanion 一起以 AGPL 发布的 0.1.13**）
- 本仓库的 `DeepSeekPet/LICENSE` 与 `DeepSeekPet/THIRD_PARTY_NOTICES.md`
  **都是上游原样带来的文件**（LICENSE 与上游逐字节一致），没有改动

> 换句话说：只搬了**桌宠窗口 + 页面 + 鲸鱼模型**这一小块。Coopanion 的
> World / 事件总线 / terminal / CUA / 遥测 / pnpm 扩展**一个都没有带**。

- 抽取与修改起始日期：**2026-10-05**
- 最近一次修改：**2026-10-05**（见 `git log`）
- 修改者：本仓库作者

## 改了哪些上游文件

**六处**，全部记录在 [`DeepSeekPet/tools/patch-assets.mjs`](DeepSeekPet/tools/patch-assets.mjs)
里（重新抽取资源时会自动重新套上）：

| 上游文件 | 改动 |
|---|---|
| `web/pet-app.js` | 上游那个每秒往日志写一行的指针诊断，改成默认关（`?diag=1` 打开） |
| `web/whale/model.json` | 只保留 `deepseek` 一套配色（其余配色的贴图不再复制） |
| `pet-host.cjs` | ① 托盘菜单：点了 404 的「装扮…」换成「设置…」「打开日志」<br>② 窗口图标 / 托盘图标换成大肥鱼，标题与托盘提示改成 Blue Fish Deskpet |
| `web/whale/figure.js` | 呆毛与脑侧两片鳍（"耳朵"）加情绪驱动的振荡器 + 看得见的闲置幅度 |
| `web/pet.html` | 页面标题改成 Blue Fish Deskpet |

> ⚠️ 另外，`web/pet-app.js` 与 `web/pet-core.js` **还有多处改动尚未纳入上面那个补丁脚本**
> （语音并行播放、命中部位判定、抚摸状态机、按部位拖拽、目光跟随等）。
> 重新抽取资源会覆盖它们 —— 详见 `HANDOVER.md` 第 4 节，脚本本身也会识别并拒绝直接覆盖。

## 我们自己新增的文件（不基于上游）

- 行为与配置：`pet.cjs` · `lines.cjs` · `llm.cjs` · `memory.cjs` · `log.cjs` · `server.cjs` · `main.cjs`
- 语音：`tts.cjs` · `tts-voice.cjs` · `tts-worker.cjs` · `voice-config.cjs`
- 窗口：`settings.cjs` · `settings-preload.cjs` · `voice-preload.cjs` · `preload.cjs`
- 页面：`web/settings.html` · `web/voice.html` · 图标（`web/app-icon.png` 等，见 `tools/make-icons.py`）
- 工程：`test/smoke.cjs`（自检）· `tools/*`（抽取、部署、装配、图标、试音）

## 功能上相对上游桌宠的改动

- **互动**：戳 / 抚摸 / 拖拽 × **7 个部位**（头·肚子·手·鳍·尾巴·裙子·脚）各自反应；
  抚摸有往复判定与连续反馈；拖拽按部位给悬挂角（抓尾巴会趴平）；
  **摸够几下它会举一张选择卡问你**，你选完它照做
- **表现**：呆毛和"耳朵"会跟着情绪动；10 种表情 + 13 种动作
- **它知道**：你在不在忙（系统空闲 / 锁屏 / 睡眠 / 电池）· 眼神跟着鼠标 · 按时段换台词 ·
  记住自己站的位置 · 「黏着你」行为档 · 连戳的音高
- **记忆**：认识多少天 / 来过几天 / 聊过几次 / 各项互动次数 / 最常被摸哪儿 / 你上次说的话
  （设置页可查看、可清空；平时不显示数字）
- **模型与语音**：接本地或云端大模型，每轮附一段「此刻」的处境；**本地语音合成**（sherpa-onnx），
  可换音色、可调语速/音高/响度
- **设置界面**：设置窗口（含「它的记忆」）· 音色编辑窗口 · 托盘菜单

## 许可

- 本项目（含从 Coopanion 搬来的代码）：**AGPL-3.0-or-later**，见 [`LICENSE`](LICENSE)
- ⚠️ **`DeepSeekPet/resources/app/web/whale/` 的贴图不在 AGPL 授权范围内** —— 这是上游
  `THIRD_PARTY_NOTICES.md` 自己写明的，详见
  [`DeepSeekPet/THIRD_PARTY_NOTICES.md`](DeepSeekPet/THIRD_PARTY_NOTICES.md)
- 第三方组件：Electron（MIT）· sherpa-onnx（Apache-2.0）· ws（MIT）· onnxruntime（MIT）等，
  同样见那份 notices
- **非官方、无关联**：本项目与 DeepSeek / OpenAI / Anthropic / Google / 阿里云 / 月之暗面 /
  MiniMax 均无隶属或认可关系；围裙上的标志图形归各自公司所有，只用来标明配色对应哪一家
