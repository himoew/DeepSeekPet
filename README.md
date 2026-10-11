# Blue Fish Deskpet · 大肥鱼桌宠

一只住在 Windows 桌面上的 DeepSeek 小鲸鱼女仆。会自己走动、会被戳、能被拎起来甩、会冒气泡说话，
**所有反应都在本地**（语音也是本地合成），只有可选的大模型会走本机 Ollama 或你自己填的云端接口。

[中文说明](DeepSeekPet/README.md) · [修改声明](CHANGES.md) · [开发日志](HANDOVER.md) · [第三方声明](DeepSeekPet/THIRD_PARTY_NOTICES.md)

> **仓库**：<https://github.com/himoew/DeepSeekPet> ·
> **直接下载（免安装绿色包）**：<https://github.com/himoew/DeepSeekPet/releases/latest>

![大肥鱼](DeepSeekPet/preview.png)

> 界面、台词、文档都是中文。台词语料 378 条、自检 428 项，**离线可用**。

## 它有什么

| | |
|---|---|
| **三个手势 × 七个部位** | 戳 / 抚摸 / 拖拽，作用在头 · 肚子 · 手 · 鳍 · 尾巴 · 裙子 · 脚上，各说各的话。抓哪儿就从哪儿拎：抓手斜挂、抓脚倒吊、**抓尾巴整个人趴平**；拎久了它会吭一声 |
| **摸的时候一直有反应** | 脸红、眯眼、冒爱心、呼噜声一路续着；刚摸上 → 摸舒服了 → 够了啦，三段递进 |
| **它会举一张选择卡问你** | 摸够几下（摸头算两下）它会问一句，你选完它照做；选「我在忙」它自己安静几分钟 |
| **它知道** | 你在不在忙（系统空闲 / 锁屏 / 睡眠 / 电池）· 眼神跟着鼠标转 · 按时段换台词 · 记得自己站的位置 · 有一档「黏着你」会走到光标旁边 |
| **它记得你** | 认识多少天 · 来过几天 · 聊过几次 · 各项互动次数 · 最常被摸哪儿 · 你上次说的那句话。平时**不显示任何数字**，设置页里可以看，也能一键忘掉 |
| **会说话** | 接大模型（本机 Ollama 或云端），每轮都会附一段「此刻」——几点、认识你多久、刚被摸过头——所以小模型也能说出"你又摸我头"这种话。**本地语音合成**（sherpa-onnx），可换音色、调语速音高 |
| **陪它玩** | 悬停时旁边两个按钮：「对话」和「球」。点球是**自由玩球**（能拨、能抓、能甩，她碰到就踢）；再点一下进**弹弹乐**比赛（见下面一节） |

## ⚽ 弹弹乐（比赛模式）· v0.2 的主角

左右各一个球门，**开局随机决定她守哪边**、你守另一边。**鼠标就是你的球拍**——不用点击，
**扫过球就踢**：扫得越快，球飞得越高越远；也可以直接把球**丢**进她的门、或者**把她拎到另一边**换边
（整蛊玩法，规则不拦着）。比分牌挂在球场顶部（`你 3 : 5 大肥鱼`）。

**开球权按足球规则**：谁进球，谁就把下一次碰球的机会让出去 —— 她进球后要**退回自己半场**、
这段时间她碰不到球（球归你开，你碰到才解禁，最长等 15 秒）；你进球则球在她门前复位、
**你的球拍这段时间碰不到它**（球会画成半透明），让她来开。

**进球有 1 秒庆祝**：球冻在网里缩着淡出 · 门白闪并抖两下 · 门上方弹「你进球！/她进球！」 ·
窗口四边内圈发光 · 进球音（你进是三音上行，她进是两音下行）· 她转个圈（你进就跺脚）——
**庆祝走完才开球**。

**难度是「她真的会读球」，不是掷骰子**：
- 她的判断用的是 **0.16 秒之前**的球位（满力球这 0.16 秒能跑 126px）→ 近身快球她判晚、跳空，**你就能打过去**；
- 高球她**每一球只掷一次骰子**：轻松球 95% 跳起来用头顶回去，边缘球 65%（以前每帧掷，实际概率≈100%，所以你打不过去）；
- 她会往"球一会儿会到的位置"**提前 0.25 秒**跑（追当前位置永远差一截）；落后时**押得更靠前**；
- 偶尔来一脚**蓄力飞踢**（×1.7 力度，26% 概率）。

**输赢她会往心里去**：进球/失球轻轻推动心情（幅度刻意小，一局十几个球），领先得意、落后更急。
| **细节** | 呆毛和"耳朵"（脑侧两片鳍）会跟着情绪动 · **发梢和尾巴晚 0.1 秒跟上**（甩一下、顿一下再跟）· 眨眼有睫毛阴影 · 呼吸起伏（困了就浅而慢）· 10 种表情 · 13 种动作 · 连戳时音效一级级升 · 悬停只留「对话」和「球」两个按钮 |
| **长在桌面上** | 每 0.8~2.5 秒采一次**她身后的屏幕颜色**：身后颜色和她身体接近时描一圈轮廓光，**轮廓光和桌面反着来**（浅桌面给她暗轮廓、深桌面给亮轮廓），脚下的影子也跟着桌面色相染色 |

## 安装（Windows 10 / 11）

需要 **PowerShell 5.1+**（系统自带）和网络（合计约 **450 MB**：Electron 110 MB + 语音 40 MB + 其余）。

```powershell
git clone https://github.com/himoew/DeepSeekPet.git D:\BlueFishDeskpet
cd D:\BlueFishDeskpet\DeepSeekPet

.\首次安装.bat                                                     # 一键：装配运行时 + 语音 + 验收

# 或者自己一步一步来：
powershell -ExecutionPolicy Bypass -File tools\setup-runtime.ps1   # 官方 Electron 44.4.4（校验 SHA-256）
powershell -ExecutionPolicy Bypass -File tools\check-runtime.ps1   # 验收，期望 all checks passed
powershell -ExecutionPolicy Bypass -File tools\setup-tts.ps1       # 本地语音，可以跳过（跳过就是哑的）
```

然后双击 **`启动大肥鱼.bat`**。

> `setup-runtime.ps1` 的最后一步会**自动调用 `tools\patch-exe.ps1`**，把 exe 的名字与图标
> 换成 Blue Fish Deskpet（它需要下 1 MB 的 [rcedit](https://github.com/electron/rcedit/releases)；
> 那一步失败不影响运行，有网时再跑一次 `patch-exe.ps1` 即可）。
> **每次重装运行时都要重跑 `patch-exe.ps1`** —— 因为新解包的 exe 会把它盖掉（脚本里已经串好了）。
> 已经手动下好 Electron 的话可以省掉下载：`-Zip <electron-v44.4.4-win32-x64.zip 的路径>`。

- **想让它用大模型说话**：装 [Ollama](https://ollama.com) → `ollama pull qwen2.5:3b-instruct-q4_K_M`
  → 右键它或点托盘图标打开「设置」，把地址填 `http://127.0.0.1:11434/v1`、模型填上面那个名字。
  不接也能用，它会说内置的 378 条台词。
- **想换音色**：`node tools\set-voice.cjs` 看有哪些；`setup-tts.ps1 -Voice fanchen-c` 可以装第二套
  （那套的许可没有明确标注，自己确认）。语音那步需要 Python 或 bzip2 来解 `.tar.bz2`，
  没有的话脚本会告诉你怎么手动解开。
- **想让它开机就在**：把 `启动大肥鱼.bat` 的快捷方式丢进 `shell:startup`（Win+R 输入 `shell:startup`）。
- **想重做图标**：改 `resources\app\web\icon-source.png` → `python tools\make-icons.py` →
  `powershell -File tools\patch-exe.ps1`（`make-icons.py` 会同时生成多尺寸的 `app-icon.ico`）。

## 仓库里有什么

```
├─ LICENSE / CHANGES.md / HANDOVER.md    许可 · 修改声明 · 开发日志（写得很细，欢迎翻）
└─ DeepSeekPet/                          ← 应用本体（就是上面 clone 下来要 cd 进去的地方）
   ├─ 首次安装.bat                       一键：装配运行时 + 语音 + 验收（新机器上先双击它）
   ├─ 启动大肥鱼.bat                     启动器（装好后双击它）
   ├─ BlueFishDeskpet.exe                官方 Electron 44.4.4 改名而来，setup-runtime.ps1 装的
   ├─ resources/app/                     代码与美术：pet.cjs 行为 · lines.cjs 378 条台词 · memory.cjs 记忆
   │                                     · mood.cjs 心情 · dress.cjs 服装 · llm.cjs 模型 · tts*.cjs 语音
   │                                     · web/ 页面与鲸鱼模型（ball.js 玩具球 · game.js 弹弹乐）
   ├─ test/smoke.cjs                     自检 428 项（纯 Node，不需要 Electron）；`--list` 看 31 个区域、可单跑
   └─ tools/                             装配与重建脚本（纯 ASCII 的 PowerShell）
      ├─ setup-runtime.ps1               下官方 Electron → 改名 → 自动调 patch-exe
      ├─ patch-exe.ps1                   把名字与图标盖到 exe 上（rcedit）
      ├─ check-runtime.ps1               验收：运行时/应用/图标/语音/权限，逐条 ok 或 MISS
      ├─ setup-tts.ps1                   装本地语音（sherpa 插件从 npm 下，语音模型从 release 下）
      ├─ make-icons.py                   由 icon-source.png 生成 png/ico 图标
      ├─ make-ball-texture.py            从用户给的图里抠出足球贴图（web\ball.png）
      ├─ extract-pet.ps1 / patch-assets.mjs   从 Coopanion 重抽资源（只有开发才需要）
      └─ deploy.ps1                      源码 → 可运行副本（开发用）
```

自检随时可跑（不需要装运行时）：

```powershell
node DeepSeekPet\test\smoke.cjs            # 428 项：台词库、设置、模型链路（假端点）、记忆、心情、
                                           # 玩具球与弹弹乐、图标、天气粒子与互动、空中接住…
node DeepSeekPet\test\smoke.cjs --list     # 31 个区域；改一处只跑那一区（例：node test\run-one.cjs 02g3-game.cjs）
```

## 许可与出处

- 本项目是 [**Pal-AI-Lab/Coopanion**](https://github.com/Pal-AI-Lab/Coopanion) **0.1.13** 的衍生作品，
  整体遵循 **AGPL-3.0-or-later**（[`LICENSE`](LICENSE)）。**这是修改版，不是原版**，
  改了哪些文件、加了什么功能都写在 [`CHANGES.md`](CHANGES.md) 里。
- ⚠️ **`DeepSeekPet/resources/app/web/whale/` 的贴图不在 AGPL 授权范围内**：上游明确声明
  角色原设是「溟月」(上善无形)、女仆装二创参考 ZipZipPipe、贴图由 ChatGPT 按参考图生成、
  围裙上是各家公司的商标图形。**要单独使用这些图请自行确认权利** ——
  详见 [`DeepSeekPet/THIRD_PARTY_NOTICES.md`](DeepSeekPet/THIRD_PARTY_NOTICES.md)。
- 第三方组件：Electron（MIT）· sherpa-onnx（Apache-2.0）· ws（MIT）· onnxruntime（MIT）·
  语音模型（默认 `chaowen`，CC0 数据集）。
- **非官方、无关联**：与 DeepSeek / OpenAI / Anthropic / Google / 阿里云 / 月之暗面 / MiniMax
  均无隶属或认可关系。

## 已知情况

- **未签名**：首次双击可能弹「Windows 已保护你的电脑」→ 更多信息 → 仍要运行。程序**只监听
  127.0.0.1**（本机回环），不对外开放端口，也不会触发防火墙弹窗。
- **语音模型的许可**：默认的 `chaowen` 数据集是 CC0；`tools\setup-tts.ps1 -Voice fanchen-c`
  可以装第二套音色，但**那套的许可没有明确标注**，要自己确认（再分发尤其要注意）。
- **不要把整个目录放在 AI 代理的工作区里**：工作区里的文件会带上额外权限项，Chromium 沙箱
  会静默崩溃（`0x80000003`）。放到普通目录（例如 `D:\`）就好，详情见
  [应用 README 的最后一节](DeepSeekPet/README.md)。
