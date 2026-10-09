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
- 最近一次修改：**2026-10-09**（见 `git log`；本次把玩具球做成了**"弹弹乐"对战模式**：
  球门 / 比分 / 鼠标球拍 / 她的四档走位与头球）
- 修改者：本仓库作者

## 改了哪些上游文件

**5 处**，全部记录在 [`DeepSeekPet/tools/patch-assets.mjs`](DeepSeekPet/tools/patch-assets.mjs)
里（重新抽取资源时会自动重新套上）：

| 上游文件 | 改动 |
|---|---|
| `web/pet-app.js` | 上游那个每秒往日志写一行的指针诊断，改成默认关（`?diag=1` 打开）；另有大量功能改动**尚未纳入补丁脚本**（见下面 ⚠️） |
| `web/whale/model.json` | 只保留 `deepseek` 一套配色（其余配色的贴图不再复制） |
| `pet-host.cjs` | ① 托盘菜单：点了 404 的「装扮…」换成「设置…」「打开日志」<br>② 窗口图标 / 托盘图标换成大肥鱼，标题与托盘提示改成 Blue Fish Deskpet<br>③ **窗口显示加 2.5 秒兜底**、隐藏/显示与心跳写 `data\pet-host.log`、页面报错与 `pet:report` 落盘<br>④ 光标轮询 100ms → **33ms**、`DSP_DEBUG=1` 时给页面加 `?debug=1`（弹弹乐的诊断日志） |
| `web/whale/figure.js` | ① 呆毛与脑侧两片鳍（"耳朵"）加情绪驱动的振荡器 + 看得见的闲置幅度<br>② 呼吸深浅/节奏跟心情走（`frame.accMood`），微动作姿态（`microTilt` / `microStep`）<br>③ `draw()` 最外层 try/catch：绘制抛错时把堆栈报给主进程（否则"她整个人消失"且毫无线索） |
| `web/pet.html` | 页面标题改成 Blue Fish Deskpet；末尾加一段 `?diag=1` 才跑的页面自检自报 |

> ⚠️ 另外，`web/pet-app.js` 与 `web/pet-core.js` **还有多处改动尚未纳入上面那个补丁脚本**
> （语音并行播放、命中部位判定、抚摸状态机、按部位拖拽、目光跟随、心情步调与微动作、
> **弹弹乐的球拍判定的唯一入口 `wantsMouse()`（收不收鼠标）**、
> **跑步不重置起步斜坡（同方向只改目标）** 等）。
> 重新抽取资源会覆盖它们 —— 详见 `HANDOVER.md` 第 4 节，脚本本身也会识别并拒绝直接覆盖
> （`tools\extract-pet.ps1` 的 `$guarded` 现在盯四个文件：`pet-app.js` / `pet-core.js` /
> `whale\figure.js` / `pet-host.cjs`）。

## 我们自己新增的文件（不基于上游）

- 行为与配置：`pet.cjs` · `lines.cjs` · `llm.cjs` · `memory.cjs` · **`mood.cjs`** · `log.cjs` · `server.cjs` · `main.cjs` · **`store.cjs`**（小 JSON 的原子读写）
- 玩具：**`web/ball.js`**（球的物理、鼠标球拍、头球、绘制）· **`web/game.js`**（弹弹乐：球门、比分、她的比赛 AI）
- 球的贴图：**`web/ball.png`**（从用户给的图抠成透明 PNG，生成脚本 **`tools/make-ball-texture.py`**；想换球就换这张图）
- 服装：**dress.cjs** · **dress-preload.cjs** · **web/dress.html**
- 语音：`tts.cjs` · `tts-voice.cjs` · `tts-worker.cjs` · `voice-config.cjs`
- 窗口：`settings.cjs` · `settings-preload.cjs` · `voice-preload.cjs` · `preload.cjs`
- 页面：`web/settings.html` · `web/voice.html` · **`web/diag.js`**（页面全局错误捕获）· 图标（`web/app-icon.png` 等，见 `tools/make-icons.py`）
- 工程：`test/smoke.cjs`（自检）· `tools/*`（抽取、部署、装配、图标、试音、抠球贴图）

## 2026-10-08 晚 ~ 10-09 弹弹乐（把玩具球做成能对打的比赛）

玩法新增，另修了六个"看起来是手感、实际是几何/时序/状态错"的真 bug（详见 `HANDOVER.md` 第 1.27 节）：

| 做了什么 | 落在哪 |
|---|---|
| **三态开关**：球按钮 = 关 → 出球（自由玩球）→ **比赛**（球门 + 比分），存在配置里 | `web/pet-app.js`（`ACTIONS.game`）· `pet.cjs`（`case 'ballMode'`）· `llm.cjs`（`ballMode`） |
| **比赛**：左右球门（6% 宽 × 96px 高）· 开局随机决定她守哪边 · 进球对面得分 · 从失球那侧开球 · 她主动踢向对面的门（力度随机、18% 蓄力 ×1.7）· 球到她跳起来够得到的高度 **80%** 跳顶 | 新增 **`web/game.js`** |
| **鼠标球拍**：比赛里球**不能抓、只能打**；**扫过球就踢（不用点击）**；力度/高度跟**扫动速度**走；鼠标上有淡蓝虚线圈显示接触范围（半径 30px） | `web/ball.js`（`setCursor` / `sweepContact` / `paddleIfTouching`）· `web/pet-app.js`（每帧喂光标） |
| **球门判定**：改成"**球（圆）与门框（矩形）相交**" —— 原来判"球心低于门框顶"，门改小之后**再也触发不了**（球心还没降那么低就先被地面弹走） | `web/game.js` |
| **她的比赛 AI**：四档走位 `intercept/chase/press/defend`（**全是跑，没有站着看**）+ 落后更靠前（`urgency`）+ 默认跑 | `web/game.js` 的 `plan()`（**纯函数**，自检直接测它） |
| **跑步不重置起步斜坡**：同方向改目标时只改 `pet.target`（原来每次 `setMode('run')` 都把加速按回起点 → 速度锁在 45~80，实感"只会走"） | `web/pet-core.js` |
| **收不收鼠标的唯一定判**：`wantsMouse()`（她 / 球拍范围 / **悬停按钮上** / 按着不放）—— 原来有三处各写一套，导致**光标在箭头和手指之间闪、按钮点不开** | `web/pet-app.js` |
| **头球**：按她的跳跃抛物线推导判定盒（脚底上方 60~150 = 离地 124~220）；触发下限用盒子最低点（60px）而不是 40px，否则她会**为贴地球做无用跳跃**；预判用"到最高点那一刻球在哪"而不是"球还有多久到" | `web/ball.js` · `web/game.js` |
| **踢球高度**：三档（460/620/700 的垂直初速，实测慢推 0.25 个她 / 中扫 0.43 / 猛扫 1.75）；抬升系数 0.25~1.0 跟扫速走；空中球按离地高度递减上限；方向加纵向阻尼（鼠标上下抖不再打成高射炮） | `web/ball.js` |
| **球的贴图**：从用户给的图抠成透明 PNG，球的外观改成贴图（想换球只换 `web/ball.png`） | 新增 **`web/ball.png`** · **`tools/make-ball-texture.py`** |
| **诊断**：`DSP_DEBUG=1` → `?debug=1` → 低频 `[弹弹乐·trace/跳跃/几何]`、`[输入]`、`[性能]`（帧耗时分段）落盘 | `pet-host.cjs` · `web/game.js` · `web/pet-app.js` |

## 2026-10-08 稳健性修复（纯修复，不改玩法）

这一轮只修"会静默出错"的地方，玩法（台词、手感、界面）一条都没动：

| 修了什么 | 落在哪 |
|---|---|
| **帧循环抛一次错就永久静止**（她停在那儿、不再动也不接鼠标，而日志一切正常） | `web/pet-app.js`：整帧 `try/catch`，**无论如何都把下一帧排上**，失败按第一次 + 每 60 秒节流上报 |
| **动作队列可能永久卡死**：`walkTo()` 会同步回调 `arrived`，而登记顺序反了 | `web/pet-app.js`：先登记再走（对齐 `walk()`），另加"20 秒没等到就自己放行"的兜底 |
| **绘制/挂载失败被静默吞掉**；挂载失败时每帧重建 canvas 与 GL 上下文 | `web/whale/figure.js`：失败计数 + 节流上报、挂载失败退避 2 秒、fade 与画脸加 `try/finally`、非有限 `t` 防护 |
| **抚摸有两套判定并行**（呼噜响两遍、一次抚摸报两条 touch） | `web/pet-core.js`：删掉上游那套"累计位移 > 320px"的判定，只留页面的 STROKE 引擎 |
| **`data\pet-host.log` 无限增长**（2 秒一次心跳 ≈ 4.3 万行/天，且没有轮转） | `pet-host.cjs`：超 2 MB 轮转为 `.1`；心跳只在窗口状态**真的变了**时写，另每 5 分钟一次 |
| **配置读坏 → 退回默认值 → 下一次保存把用户的 Key/人设顶掉** | `llm.cjs` + 新增 `store.cjs`：坏文件先留档 `settings.json.bad-<时间>`、**原子写**、写失败抛错 |
| **状态文件裸覆写**，掉电/崩溃留下半截 JSON（心情 / 记忆 / 服装 / 音色 / 位置） | 新增 `store.cjs`（先写 `.tmp` 再 `rename`），上列模块全部改走它 |
| 服务端 async 请求处理没接住 → 一行 `FATAL 未处理的 Promise 拒绝` | `server.cjs`：`.catch` 接住并如实回答 |
| 死代码 / 死开关（会让人误以为它们在工作） | 删 `figure.js` 的 `opts.raster` / `snapshot()` / `painted`、`rig.js` 的 `setView` / `opts.hidden`、`pet-core.js` 的 `MOTIONS` / `ROLES` / `GALLERY` / `wear()` / `ITEM_COLORS`、`pet-app.js` 只写不读的 `prefs.user` / `prefs.doubleClickChat` |

> 只删"零引用的导出与死开关"；上游那些**从不触发但活着**的功能路径（语音输入、屏幕取色…）
> 一律保留 —— 理由见 `HANDOVER.md` 第 4 节（动它们等于自己维护一个 fork）。

## 2026-10-08 补充性修复（渲染热路径 · 可用性 · 两套真相）

行为不变，只把每帧都在白做/做不到的地方做对：

| 改了什么 | 落在哪 |
|---|---|
| 画序只排一次（z 序是常量，原来每帧 `map+sort`）· 无 tint 的部件共用一次 `uTint` · 顶点变换复用输出数组（不再每顶点造一个 `[x,y]`）· 同一帧的 `cos/sin` 只算一次 | `web/rig/rig.js` |
| **脸贴图脏检查**：站着/发呆/没说话时不再每帧重画 390×252 的 canvas 并重建整条 mipmap 链（说话、眨眼、闭眼、拖拽、晕眩、睡着仍照旧每帧重画） | `web/whale/figure.js` |
| `#fx` 不再每帧写空 `innerHTML`（同项目另一处早就做了缓存） | `web/pet-core.js` |
| **服装页能用键盘**：卡片改成 `<button>` + `aria-current` / `aria-disabled` / `:focus-visible`；设置页·音色页·服装页的结果提示加 `role="status" aria-live="polite"`；三页补 viewport meta | `web/dress.html` · `web/settings.html` · `web/voice.html` |
| `maxTokens` 真的夹在 16–8192（原来手输 `-5` / `1e9` 会原样写进配置） | `web/settings.html` |
| `?diag=1` 的探针不再每秒新建 WebGL 上下文（它会自己耗光每页约 16 个的配额，读出假的 `GLNONE`） | `web/pet.html` |
| 标注"两套真相"：`figure.js` 里的 `FACE`/`HEAD`/`CHEEKS`/`INK` 与 `model.json` 里**没人读**的 `units.DS`/`featDS`/`pivots.head`/`feat.blush`/`feat.skin` 必须一起改 | `web/whale/figure.js` |

## 功能上相对上游桌宠的改动

- **互动**：戳 / 抚摸 / 拖拽 × **7 个部位**（头·肚子·手·鳍·尾巴·裙子·脚）各自反应；
  抚摸有往复判定与连续反馈；拖拽按部位给悬挂角（抓尾巴会趴平）；
  **摸够几下它会举一张选择卡问你**，你选完它照做
- **表现**：呆毛和"耳朵"会跟着情绪动；10 种表情 + 13 种动作
- **它知道**：你在不在忙（系统空闲 / 锁屏 / 睡眠 / 电池）· 眼神跟着鼠标 · 按时段换台词 ·
  记住自己站的位置 · 「黏着你」行为档 · 连戳的音高
- **记忆**：认识多少天 / 来过几天 / 聊过几次 / 各项互动次数 / 最常被摸哪儿 / 你上次说的话
  （设置页可查看、可清空；平时不显示数字）
- **心情**（`mood.cjs`，本仓库新增）：喜欢 / 精神两条连续轴 + 五档（黏人·开心·安静·困倦·想你），
  影响发呆台词、动作快慢、「黏着你」离你多远、以及给模型的【此刻】；设置页可看数值
- **不说话的小动作**：歪头 / 换重心 / 瞟一眼鼠标（纯姿态、不出声），呼吸深浅与节奏跟心情走
- **本地情绪识别**：打字先过本地关键词表（累/难过/生气/谢谢/夸它/关心/开心），
  先接住情绪再放大模型的回答，并给模型一句情绪提示（**不花 token**）
- **玩具球 → 弹弹乐**：悬停球按钮是三态开关（关 / 自由玩球 / **比赛**）。比赛里左右各一个球门、
  开局随机决定她守哪边、进球算分、球从失球那侧重新开出来；**鼠标在比赛里不能抓球、只能扫过去打**
  （扫得越快飞得越高越远）；她有四档走位（抢 / 追 / 压上 / 回防），球到她跳起来够得到的高度会**跳起来顶回去**；
  实现在独立文件 `web/ball.js` + `web/game.js`（**不碰她的身体与帧循环**）
- **服装**：dress.cjs + 服装页。**只有"原版"能穿**，预留格看得见；
  上游那 8 套配色**故意没带**（作者要的是"更多服装"而不是换色，贴图以后再补）
- **模型与语音**：接本地或云端大模型，每轮附一段「此刻」的处境；**本地语音合成**（sherpa-onnx），
  可换音色、可调语速/音高/响度
- **设置界面**：设置窗口（含「它的记忆」与「现在的心情」）· 音色编辑窗口 · 服装窗口 · 托盘菜单
- **可诊断性**（本仓库新增）：页面里的 JS 异常与绘制失败会带堆栈写进 `data\pet-host.log`；
  窗口的显示/隐藏/位置/置顶有日志与心跳 —— "她不对但日志看着正常"时靠它定位

## 许可

- 本项目（含从 Coopanion 搬来的代码）：**AGPL-3.0-or-later**，见 [`LICENSE`](LICENSE)
- ⚠️ **`DeepSeekPet/resources/app/web/whale/` 的贴图不在 AGPL 授权范围内** —— 这是上游
  `THIRD_PARTY_NOTICES.md` 自己写明的，详见
  [`DeepSeekPet/THIRD_PARTY_NOTICES.md`](DeepSeekPet/THIRD_PARTY_NOTICES.md)
- 第三方组件：Electron（MIT）· sherpa-onnx（Apache-2.0）· ws（MIT）· onnxruntime（MIT）等，
  同样见那份 notices
- **非官方、无关联**：本项目与 DeepSeek / OpenAI / Anthropic / Google / 阿里云 / 月之暗面 /
  MiniMax 均无隶属或认可关系；围裙上的标志图形归各自公司所有，只用来标明配色对应哪一家
