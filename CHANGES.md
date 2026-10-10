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
- 最近一次修改：**2026-10-11**（天气粒子第二版：**整层从"每帧重拼 SVG 字符串"换成一张 canvas**、
  樱花花瓣与落叶按真实形态重画、**新增程序生成的环境音 `web/ambience.js`**（雨/雪/樱/落叶四套底噪 +
  雨滴/鸟叫/远雷点缀）、密度下调一档；顺带修掉四个"静默出错"的 bug —— 配色只认 `rgb()` 不认 hex
  （所有粒子被画成白色）、贴图把形状裁掉三分之一（用户实测报的）、形状参数传成字符串导致路径全 NaN、
  不透明度包络写错导致新粒子当场不可见。见 HANDOVER 第 1.36 节）｜上一次：**2026-10-10 深夜**（天气粒子
  按现实轨迹重写 + 樱花改单花瓣 + 修掉"天气气泡把整条气泡系统卡死"与"窗口铺满整屏后她掉到屏幕最底下"，
  见 HANDOVER 第 1.35 节）｜上一次：**2026-10-10 晚**（见 `git log`；本次是**用户拍板**的一批：**次级动画**——
  发梢/尾巴的 0.1 秒延迟跟随、眨眼睫毛阴影、呼吸起伏加深；**桌面接地光**——用身后采到的平均色
  决定轮廓光颜色与影子染色，并顺带把抓屏节奏从 0.8 秒放宽到 2.5 秒。详见 HANDOVER 第 1.33 节）
- 修改者：本仓库作者

## 改了哪些上游文件

**5 处**，全部记录在 [`DeepSeekPet/tools/patch-assets.mjs`](DeepSeekPet/tools/patch-assets.mjs)
里（重新抽取资源时会自动重新套上）：

| 上游文件 | 改动 |
|---|---|
| `web/pet-app.js` | 上游那个每秒往日志写一行的指针诊断，改成默认关（`?diag=1` 打开）；另有大量功能改动**尚未纳入补丁脚本**（见下面 ⚠️） |
| `web/whale/model.json` | 只保留 `deepseek` 一套配色（其余配色的贴图不再复制） |
| `pet-host.cjs` | ① 托盘菜单：点了 404 的「装扮…」换成「设置…」「打开日志」<br>② 窗口图标 / 托盘图标换成大肥鱼，标题与托盘提示改成 Blue Fish Deskpet<br>③ **窗口显示加 2.5 秒兜底**、隐藏/显示与心跳写 `data\pet-host.log`、页面报错与 `pet:report` 落盘<br>④ 光标轮询 100ms → **33ms**、`DSP_DEBUG=1` 时给页面加 `?debug=1`（弹弹乐的诊断日志）<br>⑤ **`lastInteractiveAt` 的作用域修好**：它声明在 `create()` 里、却被 `runPetHost` 那一层的 `pet:interactive` 处理器读 → 每一次"窗口收/放鼠标"都抛 `ReferenceError`（实测 70 分钟 1102 条 FATAL，而那条"[输入] 主进程：收鼠标=…"的诊断**一次都没写出来**） |
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
- 天气特效：**`web/fx.js`**（粒子物理/形状/渲染，2026-10-11 起整层画在一张 canvas 上）· **`web/ambience.js`**（程序生成的环境音：雨/雪/樱/落叶四套底噪 + 雨滴/鸟叫/远雷点缀，**不用任何音频素材**）
- 球的贴图：**`web/ball.png`**（从用户给的图抠成透明 PNG，生成脚本 **`tools/make-ball-texture.py`**；想换球就换这张图）
- 服装：**dress.cjs** · **dress-preload.cjs** · **web/dress.html**
- 语音：`tts.cjs` · `tts-voice.cjs` · `tts-worker.cjs` · `voice-config.cjs`
- 窗口：`settings.cjs` · `settings-preload.cjs` · `voice-preload.cjs` · `preload.cjs`
- 页面：`web/settings.html` · `web/voice.html` · **`web/diag.js`**（页面全局错误捕获）· 图标（`web/app-icon.png` 等，见 `tools/make-icons.py`）
- 工程：`test/smoke.cjs`（自检）· `tools/*`（抽取、部署、装配、图标、试音、抠球贴图）

## 2026-10-11 天气粒子第二版：canvas 渲染 + 花瓣/落叶重画 + 环境音（用户三条反馈）

用户："① 樱花和落叶还是不够像，非常难看（只是外形而不是轨迹，轨迹 ok 了）② 天气没有音效，
建议网上找段环境白噪声或相关生成的代码加上去 ③ 特效会导致卡顿，想办法优化一下，减少一点
密度可以接受"。中途实测又报："花瓣感觉少了三分之一，树叶少了五分之一 —— 是故意这样设计的吗？"

| 改了什么 | 文件 |
|---|---|
| **粒子层从 SVG 换成一张 canvas**（原来每帧拼字符串 + `innerHTML`，60fps × 200 颗 = 每秒重建上万个 DOM 节点）；绘制清单池化、单帧 `dt` 夹到 1/30、卡顿自动减量 40% | `web/fx.js` · `web/pet.html`（新增 `#fxCanvas`）· `web/pet.css` · `web/pet-app.js` |
| **樱花花瓣与落叶按真实形态重画**：花瓣＝细根+两侧鼓+尖端浅凹口+主脉/侧脉/高光；落叶＝宽叶身+窄叶柄+贯到尖的主脉+每侧 3 条侧脉+正反面明暗 | `web/fx.js` |
| **新增环境音**（程序生成，无音频素材）：跟她的音效共用一个开关，切天气立刻换底噪，雨滴/落叶/鸟叫/远雷按 `follow()` 排期 | 新增 `web/ambience.js` · `web/pet-app.js` |
| **修掉四个静默 bug**：`toHex()` 只认 `rgb()` 不认 hex（粒子全白）、贴图裁掉三分之一形状（用户实测报的）、变体名被当成形状参数（路径全 NaN、只剩描边）、不透明度包络写错（新粒子当场不可见） | `web/fx.js` |
| 自检 350 → **369 项**（粒子结构/行为/形状 12 条 + 环境音 4 条；假 canvas 升级成"真的会留下像素"，不然那些形状断言是"绿着但什么都没测"） | `test/smoke.cjs` |

## 2026-10-10 晚 次级动画 + 桌面接地光（用户拍板的 ①+② 一批）

用户："次级动画（不需要新贴图，纯参数）：头发/尾巴延迟跟随、眨眼加睫毛阴影、呼吸起伏。
桌面接地光：用 sampleBackdrop 采她身后的颜色 → 给她描一圈轮廓光/给影子染色。"
详见 HANDOVER.md 第 1.33 节。同一批还清掉了美术线留下的过程文件。

| 改了什么 | 落在哪 |
|---|---|
| ★ **延迟跟随**：`pet-core.js` 每帧把身体位置压进 0.4 秒的环形历史（`pet.posHist`），经 `frame.bx/by/posHist` 交给自定义身体；`figure.js` 取 **0.1 秒前**那点算速度，加进发梢/刘海/尾巴/呆毛的弹簧目标（`LAG_S`/`LAG_HAIR`/`LAG_TAIL`/`LAG_Y`）。竖直分量也算（跳起/被放下时发梢会拖） | web/pet-core.js（posHist + frame）、web/whale/figure.js（lagged / 弹簧目标） |
| ★ **眨眼睫毛阴影**：闭眼时用 `source-atop` 把一道渐变裁在脸那块画布内部叠上去（0 新贴图）；必须 `save()`/`restore()` 严丝合缝包住 | web/whale/figure.js（paintOpenEye） |
| ★ **呼吸起伏**：躯干加深到 ±1.0%/±1.9%，头/发梢用慢弹簧 `neckY` 晚一拍跟上（胸腔先起、脖子随后）；深浅/节奏照旧跟心情走 | web/whale/figure.js（st.body / sp.neckY / st.neck） |
| ★ **桌面接地光**：`probeBackdrop` 同时算身后的平均色 → 轮廓光颜色改成**和桌面反着来**（浅桌面给暗轮廓、深桌面给亮轮廓，明度差 0.32），她脚下那块影子改用桌面色相染色（保持很淡：0.15~0.26）。`--shadow` 那套（气泡/菜单投影）没动 | web/pet-app.js（probeBackdrop / stepBackdrop）、web/pet.html 的 `#haloFlood` |
| **抓屏节奏**：轮廓光开着时 0.8 秒一次，平时 2.5 秒一次（收掉 HANDOVER 10.1① 那条开销项） | web/pet-app.js（`BACKDROP_EVERY_CALM`） |
| **修掉一个真 bug**：OKLab 正向变换里 m/s 的系数被抄成了逆矩阵的 → 灰正常、彩色悄悄偏色（(40,90,200) 的 g 从 90 掉到 69）。已改正，并加"往返不掉色"的行为验证钉住 | web/pet-app.js（oklab） |
| 自检 **+24 条**（①②各 12 条：延迟跟随时序与竖直分量、无历史兜底、`save/restore` 包住、眨眼不被脏检查跳过、OKLab 往返、轮廓光反着来、抓屏节奏） | test/smoke.cjs（319 → **343**） |
| ★ **身体部位判定重做：7 类 → 15 类**（用户实测报"戳嘴巴识别到呆毛"）：新增 `REGION_BOXES` 矩形表（呆毛/眼睛/手/大腿/脚），锚点表按 `model.json` 的**真实部件框**重量。部位：呆毛/头发/眼睛/脸蛋/下巴/脖子/胸口/肚子/腰/裙子/手/鳍/尾巴/大腿/脚 | web/pet-app.js（REGION_BOXES + REGION_AT + GRAB_STYLE 15 项）· pet.cjs（AREAS/AREA_CN 15 项 + `areaLines` 近亲兜底）· lines.cjs（pokeArea/petArea/grabArea/holdArea/dropArea 各 15 桶 + `petAreaFallback`/`pettingFallback`/`grabFallback`） |
| ★ **修掉自检自己的一串坑**：`checkLines` 撞上循环引用会栈溢出（加了 `seen` 防环 + 只对对象下钻）；`pageAreas()` 用"从 A 切到 B"抠源码，中间插进来一个函数就把函数名当部位名；`pageGrabParts()` 按行首匹配，漏掉"一行写多个部位"的那些 | test/smoke.cjs |
| **工作区清理**：art 的 215 个美术过程稿（58.6MB）、`whale/schemes/` 255 个（6.3MB，`model.json` 只注册 deepseek，程序永远读不到）、2 个 `__pycache__`、3 个 0 字节 png、6 张过期对照面板。**保留**：即梦原图/参考图、`art/parts-spec/`、`tools/check-outfit.py` 那批换装工具、`whale/preview.png` | 工作区（不进安装包） |
## 2026-10-10 凌晨 修：右键菜单按钮全失效 + 菜单头换成小肥鱼

用户实测："右键小肥鱼时出现的菜单按钮全部失效"+"左上角大肥鱼旁边的上游图标换成我们的小肥鱼"。
详见 HANDOVER.md 第 1.32 节。

| 改了什么 | 落在哪 |
|---|---|
| ★ **菜单按钮点不动的根因**：窗口拿鼠标的判定（wantsMouse）原来只量 #tools，而**菜单一开 #tools 就被隐藏**，菜单又开在光标**上方** → 往菜单上移的那一下必然判成"不在按钮上" → 页面把鼠标还给桌面 → **点击穿透**。新增 overUI(p)：菜单+悬停按钮都按矩形算，其余能点的东西问 document.elementFromPoint() | web/pet-app.js（overUI / wantsMouse / 诊断日志） |
| ★ **菜单头像是上游 Coo**：pet.cjs 的 INIT.bot **没有 vatar 字段** → ot.avatar ? <img> : mini() 永远走 else（mini 画的是内置上游形象）。现在默认用小肥鱼（/api/avatar = web\avatar.png），加载失败才退回 SVG；名字兜底也改成「小肥鱼」 | web/pet-app.js（enderMenuHead） |
| 自检 **+3 条**（其中一条是**行为验证**：把 overUI 抠出来喂假矩形量） | 	est/smoke.cjs（313 → **316**；同一天晚些时候又加到 **331**，见最上面那条） |
## 2026-10-10 凌晨 提升小肥鱼胜率（她追球带提前量 + 头球率 65%）

用户："比分差距还是有点大……现在是 50 多的头球率吗，改成 65 左右吧，或者你看下如何修改能稍微提升小肥鱼的胜率"。
**实测基线**：头球 314/573 = **54.8%**（"轻松球"档 573 次里只命中 8 次 = 几乎没生效）、比分 **你27 : 她8**。
**主因**：她 250px/s vs 球 300~700px/s，而且追球追的是"球现在在哪" → 永远差一截。详见 HANDOVER.md 第 1.31 节。

| 旋钮 | 旧 → 新 |
|---|---|
| HEAD_HARD（头球率） | 0.55 → **0.65** |
| 轻松球判据（必顶档） | dist<110 / spd<380 → **dist<150 / spd<520** |
| CHASE_LEAD_S（**新**，追球提前量） | 0 → **0.25s**（goTo(leadX) / plan(leadX)） |
| HER_REACTION_MS | 180 → **160** |
| DEFEND_X（回防线） | 0.30 → **0.22** |
| RACE_BOOST（**新**，仅在比赛模式跑速 +12%） | 1 → **1.12**（pet-core 的 aceBoost + setRaceBoost，切模式自动回 1，缩放 vMax 不滑步） |
| CHARGE_CHANCE（蓄力飞踢） | 0.18 → **0.26** |
| 自检 **+3 条**（头球率 65% / 追球带提前量 / 跑速加成离开比赛回 1） | 	est/smoke.cjs（310 → **313**） |
## 2026-10-10 凌晨 得分：比分牌 / 进球庆祝 / 进球音 / 输赢意识第一小步

用户："玩法已经好了大部分，就是得分我们还没弄（显示分数和进球效果、短暂欢呼）…… 按你倾向这一套直接干"。
详见 HANDOVER.md 第 1.30 节。**查出来的实情**：进球音效**根本不存在**（sfx.goal() 一直空转）、
进球只有"网描边变白一下"且球同一帧就被挪走、比分只藏在悬停按钮的 tooltip 里。

| 改了什么 | 落在哪 |
|---|---|
| **比分牌**：球场顶部居中 你 3 : 5 小肥鱼（青蓝/暖色、半透明、只在比赛模式），进球弹一下 | web/game.js（uildScore + draw）· web/pet.css（.toy-score*） |
| **进球庆祝 1 秒**（CELEBRATE_MS）：球**冻在网里缩着淡出** → 门白闪+抖两下 → 门上方弹「你进球！/她进球！」→ 窗口内圈发光 → **然后才开球** | web/game.js（庆祝段 + pendingKickoff）· web/ball.js（setFrozen/setCelebrate + draw）· web/pet.css（	oy-goal-shake / .toy-goal-text / #goalGlow）· web/pet.html（#goalGlow）· web/pet-app.js（goalGlow） |
| **进球音效**（之前不存在）：sfx.goal() 三音上行+气声 / sfx.concede() 两音下行 | web/pet-core.js（sfx 新增两个方法）· web/game.js（按进球方选） |
| **她的即时动作**：她进 = 转个圈 spin；你进 = 跺一下 shake | web/game.js（进球那段） |
| **输赢意识第一小步**：进球/失球推动心情（goal +0.025 / concede -0.015，幅度刻意小） | mood.cjs（EVENT 两项）· pet.cjs（case 'ballGoal'） |
| 自检 **+6 条**（比分牌 / 庆祝段 / 进球音效存在 / 进球推动心情 / 球冻在网里 / 庆祝走完才开球）；旧用例为"庆祝 1 秒"改了四处 | 	est/smoke.cjs（304 → **310**） |
## 2026-10-10 凌晨 弹弹乐第二轮：图标闪 / 拉停 / 门口刷分

用户实测报的第二批（原话见 HANDOVER.md 第 1.29.4~1.29.6 节）：

| 改了什么 | 落在哪 |
|---|---|
| ★ **"重启时先闪一下上游的图标"**（优先级最高）：页面默认画的是内置的**上游形象 coo**，小肥鱼要等 World 偏好到了才动态 import + 加载 33 张贴图 → 于是窗口一显示画的就是 coo，之后才 0.45s 淡入小肥鱼。现在：**启动先挂 whale + 形象就绪前不开帧循环**，并新增 pet:painted 让主进程**等到小肥鱼画出来才显示窗口**（eady-to-show 只记日志，兜底 4s） | web/pet-app.js（startFigure / igureReady / markPainted）· preload.cjs（painted）· pet-host.cjs（显示时机） |
| **"拽起她放下来立马又跑"** → 新增 game.hold(ms)：抓起 1.5s、放下 2.5s 内**不追球不起跳** | web/game.js（holdUntil + hold()）· web/pet-app.js（抓取/松手时调） |
| **"比赛模式那个悬浮按钮开关不好关"**：离开比赛模式时 ctl.act('stand')，当场停下（原来她要把最后那条走位指令跑完） | web/pet-app.js（setBallMode） |
| **"她开的第一球我刷分超级高"**：开球权从"她碰到就还给你"（实测 20ms 就还了）改成**按位置解禁** —— 球离开她守的门 0.30 个窗口宽（≈384px）才恢复你的球拍；上限 1.5s → 5s | web/game.js（KICKOFF_CLEAR / KICKOFF_HOLD_MS） |
| 自检 **+1 条**（球离开她的防区才解禁；把"她碰到就解禁"那条改成反断言） | 	est/smoke.cjs（303 → **304**） |
## 2026-10-09 深夜 弹弹乐：复位规则 + 头球难度（用户拍板 a / c / 0.18）

用户看完上一批的分析后拍板："先按你推荐的 a c 0.18 来部署"。详见 `HANDOVER.md` 第 1.29 节：

| 改了什么 | 落在哪 |
|---|---|
| ★★ **"复位后她不踢"的真因**：球**静止**时 `ball.js` 的静止分支提前 `return`，而 `game.onStep` 钩子写在函数末尾 → **球一停，游戏一帧都收不到** → 她的走位指令全在钩子里 → 站着不动。A/B 实测 **0/60 帧 vs 60/60 帧**；也是"开球死循环"和"上一轮诊断永远等不到数据"的同一个根因 | `web/ball.js`：钩子抽成 `hookGame(dt, bounds)`，**两个分支都调** |
| **复位规则 (a)**：球回到"**失球那侧门前**"开出来；**谁进球谁让出开球权**（足球的开球规则）——她进球→她退回自己半场且 `setHerTouch(false)` 碰不到球；你进球→**你的球拍 1500ms 内碰不到这颗球**（`setPaddleTouch(false)`，球画成半透明），防"守在她门口刷分"（真机实测曾 **你30:她14**）；对方碰到球或超时即解除 | `web/game.js`（`KICKOFF_OUT` / `RETREAT_MS` / `KICKOFF_HOLD_MS`）· `web/ball.js`（新增 `setHerTouch` / `setPaddleTouch` + 半透明） |
| **头球难度 (c)**：骰子从"每帧一次"改成"**每球一次**"（原来球在可达范围待 20~35 帧，每帧 60% → 整球 ≈100%，用户实测"感觉有 100%"）；轻松球 `HEAD_EASY = 0.95` / 边缘球 `HEAD_HARD = 0.55`；**反应延迟 `HER_REACTION_MS = 180`**（她读的是 180ms 前的球位）；**顶完落地 0.35s 内不能二跳** | `web/game.js`（`ballHist`/`ballDelayed` + 每球一次的 `headRoll`） |
| 自检 **+6 条**（球停着游戏也收得到 · 复位点回到门前 · 她进球后碰球权关掉/你碰球就还回来 · **开球权给你/还给你** · 判定"不顶"时她照常追球不罚站）；自检里**不再 stub 全局 `Math.random`**（会把 `defence` 的随机冻住 → 自检死循环），改用 `game.debug.headForce` | `test/smoke.cjs`（298 → **303**） |

## 2026-10-09 晚 弹弹乐：头球 / 计分 / 开球死循环（都是用户实测报上来的）

这一轮全部是**真 bug**（用户："桌宠一直无法头球"、"往右慢扫球往左滚"、"有时不够流畅"、"计分按我进她的门我得分"），
每条都有**量出来的证据**（离线探针 + 真机日志），详见 `HANDOVER.md` 第 1.28 节：

| 修了什么 | 落在哪 |
|---|---|
| ★ **她一次都没跳过**（所以**头球永远不可能发生**）：`ctl.act(['jump'])` 传的是数组，而 `act()` 是 `switch(字符串)` → 落 `default` | `web/pet-app.js`：`ctl.act('jump')`（并让返回值有意义） |
| ★ **她"罚站"**：`canHead` 成立就 `return` 掉走位，而跳跃是空操作 → 球一来她站着不动（探针实测 60 帧里 57 帧收不到走路指令） | `web/game.js`：`if (canHead && (jumped \|\| sheAir)) return;` |
| ★ **头箱挂错了位置**：注释写"脚底往上 60~150"，实现是**脚底上下 −30~+60**（她的肚子/大腿） | `web/ball.js`：`top = feet - (HEAD_ABOVE_FEET + HEAD_BOX_H)` |
| ★ **起跳提前量只有一半**：先蹲 0.16s 才算进去，真实顶点在 0.47s（老写法 0.31s → 每次早起跳 0.16 秒） | `web/game.js`：改成**相遇扫描**（整跳里逐刻比对箱子与球的重叠），不再用"顶点快照" |
| ★ **计分只在"她守右边"时是对的**：`scorer = 1 - side` → 守左边那一半球局整局反了（球进她守的门算她得分） | `web/game.js`：`scorer = side === g.defence ? 0 : 1`（用户定的规则：我进她的门我得分） |
| ★ **球拍的"自家门"护栏算反了**：`ownGoalX` 取的是你要打的门 → 你正对球门一挥就被掉头（真机/探针都能复现"往右扫球往左滚"） | `web/ball.js`：own/target 换边，并且只在**自家门口 0.18W 内**才生效（原来整个半场） |
| ★ **慢扫必反向**：短位移掉进"朝鼠标所在那一侧轻推"的兜底，方向跟你的移动无关 | `web/ball.js`：改成看**最近 120ms 的整体位移**（顺带修掉 30Hz 光标采样造成的速度翻倍） |
| ★ **球一沾地就"陷进泥里"**：地面摩擦写在每帧都会走到的分支里（= 每秒乘 60 次），实测 400px/s 只滚 46px | `web/ball.js`：`ROLL_DRAG` 按 `dt` 折算（实测能滚 400px） |
| ★ **开球死循环**：球原来在"失球的门口"复位（离门 128px），而她瞄准的就是那个门 → 一碰又进，**一分钟刷到 23 分**（真机日志抓到） | `web/game.js`：`KICKOFF_NEAR`（0.45W/0.55W，离两个门都 >500px） |
| **头球概率 80% → 60%**（用户实测头球能触发之后定的） | `web/game.js`：`HEAD_CHANCE` |
| **比赛模式恒 60fps**（她站着 + 球静止时原来掉到 30fps，球拍光环与扫掠判定跟着半速） | `web/pet-app.js`：帧率判定加 `game.mode === 'game'` |
| **"复位后她不踢"的自检不再被 DEBUG 挡着**：只在"开球 >1.2s 还没碰到球"时写 4 笔状态（她的位置/模式/目标/脚底高度、球的位置/高度/是否停着、走位分支、上次走路指令多久前） | `web/game.js` |
| 自检 **+14 条**（她真的会跳 / 端到端顶到球 / 两个 defence 的计分 / 球能滚 / 慢扫方向 / 自家门护栏 / 球停着游戏也收得到） | `test/smoke.cjs`（283 → **298**） |

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
