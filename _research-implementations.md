# 现有开源实现调研：坠落粒子 + 程序化环境音

只列真实存在、已读源码的项目。所有数字都来自仓库源码本身。

---

## A. 坠落粒子（樱花 / 落叶 / 雪 / 雨）

### A1. minz71/sakura-rain

- 仓库：https://github.com/minz71/sakura-rain
- 源码：https://raw.githubusercontent.com/minz71/sakura-rain/main/sakura-rain.js （9,943 B）
- **canvas 还是 DOM**：Canvas 2D。`<canvas id="canvas_sakura">`，`position:fixed; left/top:0; pointer-events:none; z-index` 可配。
- **形状**：**图片 sprite**，不是路径。仓库自带 `sakura.png`（3,358 B），也支持 `imageSrc` 覆盖；拿不到 `document.currentScript.src` 时回退 `https://cdn.jsdelivr.net/gh/minz71/sakura-rain/sakura.png`。
- **物理**：
  - 常量：`vx = Math.random()*xSpeed`、`vy = Math.random()*ySpeed`、`vr = Math.random()*rSpeed`。
  - 位置/角度积分：`x += vx*delta; y += vy*delta; rotation += vr*delta`。
  - `delta = Math.min((now-lastTime)/BASE_FRAME_MS, MAX_DELTA)`，`BASE_FRAME_MS = 1000/60`，`MAX_DELTA = 3`。
  - **没有重力**、**没有终端速度**、**没有噪声场**：速度是常量，靠 delta 归一化保证高刷屏不快。
  - **没有 scaleX/cosθ 3D 翻转**，只有 2D 旋转。
- **旋转实现**（省一次 save/restore，直接写矩阵）：
  `cos = Math.cos(rot)*dpr; sin = Math.sin(rot)*dpr; ctx.setTransform(cos, sin, -sin, cos, x*dpr, y*dpr); ctx.drawImage(sprite,0,0,size,size)`
- **数量与尺寸**：`sakura` 默认 **30**（移动端 UA 命中则 **15**）；`MAX_PETAL_SIZE = 30` px；`size = 30 * rand * (rand*0.4+0.6)`。
- **性能**：`DPR_CAP = 2`；**sprite 预渲染**——`buildSprite()` 把原图先画进一张 `MAX_PETAL_SIZE*dpr` 的离屏 canvas，每帧只 `drawImage` 缩放，不重路径；`imageCache` 用 `Map` 缓存 Promise；`prefers-reduced-motion` 监听（含 Safari 13 的 `addListener` 兼容）；`startToken` 递增 + `suspend()` 处理快速 stop/start 竞态；`renderer` 字段预留 3D，当前只实现 2D。
- 其它：`startSakura(count, direction, zIndex)` 向下兼容；`direction` 四档 `TopRight/TopLeft/BottomRight/BottomLeft`，决定从哪条边重生。

### A2. qtqz/natural-falling-effect（四季飘落）

- 仓库：https://github.com/qtqz/natural-falling-effect
- 核心源码：https://raw.githubusercontent.com/qtqz/natural-falling-effect/main/src/core/naturalfalling.js （36,879 B，单文件）
- Vue 封装：`src/vue-natural-falling/vue-natural-falling.vue`（15,162 B）；演示 `src/App.vue`
- **canvas 还是 DOM**：Canvas 2D。`document.createElement('canvas')` 后 `appendChild(document.body)`，`position:fixed; pointer-events:none`。
- **形状**：
  - 花瓣 petal / 叶子 leaf：**图片 sprite**（`data:image/png;base64` 内联，叶子注释指向 `BlackCatCj/Defoliation-animation`）。
  - 雪花 snow：`ctx.beginPath(); ctx.arc(x, y, size, 0, 2π); ctx.fill()`，`fillStyle = '#FFF'`。
  - 雨 rain：**渐变线段**，`createLinearGradient(px, py, x, y)`，色标 `[0] = rgba(0,0,0,0)`、`[0.5] = rgba(223,223,223,0.6)`，`moveTo(px,py) → lineTo(x,y)`，`lineWidth = 2`。
- **默认配置**（`FallingConfig.DEFAULT`）：
  ```js
  imgNumSetting: [40, 40, 80, 60]   // petal, leaf, snow, rain 各自数量
  imgSize:       [40, 40, 2.5]      // petal 40px, leaf 40px, snow 半径 2.5
  gravity:       0.163
  rain_speed:    50
  rain_deviation: 4
  rain_angle:    260                // 度；源码用 *0.017 转弧度
  rain_hasBounce: true
  fadeIn: true, fadeOut: false, fadeOut_time: 20, zIndex: 100, wind_x: 0
  ```
- **物理（分粒子类）**：
  - `Petal`：`vy = 1.3 + rand*gravity*5`，`vx = wind_x ? wind_x/40 : 3*(rand-0.5)`，`va = rand*0.03`，`angle += va`；越界回绕 `x>width → x=0`。
  - `Leaf`：同形，`vy = 1.6 + rand*gravity*5`，`halfNum = ⌊count/2⌋`，前半用 `leaf1` 后半用 `leaf2`。
  - `Snow`：`vy = 0.8 + rand*gravity*5`，`vx = 2.5*(rand-0.5)`，`opacity = rand*0.5+0.5`（>0.8 则置 1），`size = rand*size + 2.3`。
  - `Rain`：**这里才有重力累积** —— `vy += config.gravity`（每帧），初速 `speed = 20*(rand-0.5) + rain_speed`，`vx = speed*cos(angleRad) + (rand-0.5)*rain_deviation`，`vy = -speed*sin(angleRad)`。
  - `Bounce`（水花）：落地时生成 `Math.round(2 + rand*3.5)` 个即 2–5 个；`radius = 0.5 + rand*0.8`；`dist = rand*Math.max(rain_speed/12, 3)`；初速方向 `angle = π + rand*π`（只朝下方半圆）；`vy += gravity`。
  - **没有噪声场**、**没有 cosθ 3D 翻转**（花瓣只 `ctx.rotate(angle)`）。
- **性能**：**定帧节流**——`fps = 60`，`this.t = parseInt(1000/fps)`，只有 `timestamp - lastTimestamp >= t` 才更新+重绘；`elements = elements.filter(...)` 顺手回收；移动端（`config.width < 880`）走 `optimizeMobile()`：`count /= 2.2`、`gravity /= 2`、`rain_speed /= 1.5`、`rain_deviation /= 1.5`、`size` 相应缩小。
- 季节自动判定 `getSeason()`：按月份+日期返回 `petal | rain | leaf | snow`；`fadeOut` 到点后 `isTimeOver`，再过 17s `destroy()`。

### A3. tomsin9/vue-seasons-falling

- 仓库：https://github.com/tomsin9/vue-seasons-falling
- 源码：https://raw.githubusercontent.com/tomsin9/vue-seasons-falling/main/src/components/SeasonsFalling.vue （17,888 B，Vue 3 SFC）
- **canvas 还是 DOM**：Canvas 2D，模板里就一个 `<canvas ref="canvasRef">`，`.is-fullscreen` 可切 `position:fixed; inset:0`。
- **形状**：**四种都是纯 Canvas 路径**（唯一会切图片的是传入 `image` prop 时改走 `drawImage`）：
  - 春·樱花：2 段 `bezierCurveTo` 的花瓣
    ```js
    const pr = r*1.1, wr = r*0.9;
    ctx.moveTo(0, -pr);
    ctx.bezierCurveTo(-wr, -pr*0.3, -wr*0.8, pr*0.8, 0, pr);
    ctx.bezierCurveTo( wr*0.8, pr*0.8,  wr, -pr*0.3, 0, -pr);
    ctx.fill();   // fillStyle rgba(255,192,203,α)
    ```
  - 秋·枫叶：`L = r*1.35`，**8 段 `quadraticCurveTo`**（`L*0.12,0.6 → 0.4,0.7 → 0.3,0.25 → 0.65,0.05 → 0.45,-0.2 → 0.5,-0.7 → 0.2,-0.5 → 0,-0.55 ...` 镜像画另一半）+ `closePath`
  - 夏·雨：`lineWidth = max(0.8, 0.5 + r*0.5)`，`moveTo(x,y) → lineTo(x + wind*2*(dropLen/20), y + dropLen)`，`dropLen = velY*(1 + r*0.6)`，描边
  - 冬·雪：`ctx.arc(x, y, r, 0, 2π)` + `shadowBlur = 2`、`shadowColor = 'rgba(0,0,0,0.15)'`
- **3D 翻转（cosθ）——本项目独有且做得最明确**：
  ```js
  ctx.rotate(flip.rotation * Math.PI/180);
  ctx.scale(Math.abs(Math.cos(flake.flip)) * 0.3 + 0.7, 1);   // 横向压扁模拟自转
  ```
  春 `flipSpeed = rand(-0.12, 0.12)`，秋 `rand(-0.1, 0.1)`；只有 spring/autumn 更新 `flip` 与 `rotation`，夏/冬不翻转。
- **侧滑与自转的耦合（春）**：
  `x += Math.sin(step)*0.55*chaos + Math.cos(flip)*0.35 + windX`（`chaos = rand(0.9,1.1)`）——两个相位不同的正弦项叠加，比单正弦更像乱飘。
  其它季节：`x += Math.sin(step)*(swingAmplitude*0.5) + windX`，`step += stepSize`（`stepSize` 春 0.015–0.025，秋 0.02–0.06，冬/夏 0.01–0.04）。
- **数量**：**按面积缩放并夹紧** `finalAmount = max(80, min(600, ⌊amount * √(W*H/(1920*1080))⌋))`，默认 `amount = 100`。`size` 默认 5 px（各季覆盖：春 4 / 夏 1 / 秋 6 / 冬 2）。
- **各季预设**：
  ```js
  spring: { color:'#ffb7c5', swing:2,   speed:0.8, size:4 }
  summer: { color:'#7dd3fc', swing:0,   speed:1.2, size:1 }
  autumn: { color:'#ff8c00', swing:1.5, speed:1.2, size:6 }
  winter: { color:'#e2e8f0', swing:1,   speed:1.5, size:2 }
  ```
- **物理要点**：雨 `velY = speed*6`、`velX = wind*2`（恒定，无重力累积）；秋 `velY = baseSpeed*rand(0.8,1.2)`；冬 `velY = rand(speed, speed*1.5) * (r/baseSize)^1.5`（**大雪花落得更快，近似终端速度**）。初生 `y = -r*4`，`isInitial` 时全屏随机撒。
- **性能**：`rgbaCache` 缓存颜色字符串解析；**resize 时按比例缩放已有粒子坐标**而不是重建；秋用 `opacity = random()<0.5 ? 0 : rand(0.5,opacity)` **直接丢弃一半粒子**（省一半 draw）；`beforeUnmount` 里 `cancelAnimationFrame` + 移除 resize/mousemove/touchmove。
- **鼠标交互**（`mouseInteraction`）：100 px 半径内推开，`force = (100-dist)/100`，位移 `(dx/dist)*force*10`。

### A4. MengTo/Skills — `falling-leaves` SKILL.md（规范/清单，非运行库）

- 原文：https://raw.githubusercontent.com/MengTo/Skills/main/agent-skills/web-design/falling-leaves/SKILL.md
- 它给出的是「怎么做出像叶子」的**硬性规则 + 参数量级表**（无仓库代码）：
  - **翻转是核心**：2D 用 `ctx.scale(Math.cos(l.spin), 1)`，`cos` 过零即"侧面消失"；3D **必须用 instanced quad，绝不能用 point sprite**（point sprite 永远面向相机，无法侧过来）。
  - **侧滑必须由翻转角驱动**：`x += Math.sin(l.spin)*l.slip*dt`（`cos(spin)≈0` 时最快）；明确禁止用独立 sine 驱动 x（"读起来像 bug"）。
  - **正反面两张 sprite**：`const img = Math.cos(l.spin) < 0 ? sprite.back : sprite.face;`，背面更暗更淡。
  - **三层景深表**（直接用）：
    | layer | scale | fall | opacity |
    | --- | --- | --- | --- |
    | far | 0.3–0.5 | 慢 | 0.22–0.40 |
    | mid | 0.5–0.85 | 中 | 0.46–0.78 |
    | near | 1.05–1.9 | 快 | 0.50–0.82 |
  - **密度按面积、不按数量**：`k = clamp(Math.sqrt(W*H/(1440*900)), .5, 1.3)`；回收半径减半 → 视野内密度 ×4；数量翻倍只换来 ×2 绘制成本。
  - **停止无效渲染**：`document.hidden` + `IntersectionObserver` 暂停；恢复时重置 `lastTime`；`dt` 夹到 ~1/30 s；DPR 上限 2；用 `ResizeObserver` 而不是一次性测量。
  - **`prefers-reduced-motion`**：画一帧静止的、构图好的画面，**不要直接隐藏**。

### A5. （补充）hallencj/weather-maker — DOM/CSS 路线的现成参考

- 仓库：https://github.com/hallencj/weather-maker ｜ 源码：`src/core.ts`（12,961 B）
- 雨/雪是 **纯 CSS**（`.wm{position:absolute;inset:0;pointer-events:none;z-index:5}` + `--wm-speed` / `--wm-rain-opacity` / `--wm-slant` 变量），不是 canvas：`RAIN.light = { speed: '3s', opacity: … }`、`medium = { speed:'4s', opacity:0.9, slant:4 }`、`heavy = { speed:'2.6s', opacity:1, slant:6 }`（单位是 CSS 动画时长与 `deg`）。
- 只对 Electron 场景有用：想省掉 canvas 主循环时，CSS 动画 + `pointer-events:none` 覆盖层是零 JS 成本的方案。

---

## B. 纯 Web Audio 程序化环境音（无音频文件）

### B1. dev.to / HexShift 教程（原始 Web Audio 节点图）

- 地址：https://dev.to/hexshift/how-to-generate-procedural-audio-textures-in-the-browser-no-samples-needed-332l
- 它就是"白噪声 + 滤波器 + LFO"三件套：
  1. `audioCtx.createBuffer(1, sampleRate*2, sampleRate)`，`data[i] = Math.random()*2 - 1` → 2 秒白噪声缓冲；
  2. `createBufferSource()` + `loop = true`，`gain.gain.value = 0.3`；
  3. `createBiquadFilter()` `type='lowpass'`、`frequency.value = 1000`；
  4. `createOscillator()`（LFO）`lfo.frequency.value = 0.2`，经 `lfoGain.gain.value = 500` 接到 `filter.frequency`。
- 节点图：`BufferSource → BiquadFilter → Gain → destination`，`Oscillator → Gain(500) → filter.frequency`。
- 文章自己给的局限（值得引用给用户）：噪声不合适当写实音效；`AudioContext` 时序跨设备会有偏差；没有预设，要自己调滤波器。

### B2. kaythomas0/noisedash — 真实产品里的参数值（**推荐作为参数来源**）

- 仓库：https://github.com/kaythomas0/noisedash ｜ 引擎：`src/components/noise.js`（35,091 B，用 Tone.js）
- **它是 web 端"环境噪声台"，且是浏览器内合成**（`Tone.Noise`），不是播放采样做噪声层。默认值与节点图（`updateAudioChain()`）：
  ```js
  noiseColor: 'pink'          // noiseColorItems: ['pink','white','brown']
  volume: -10                 // dB
  filterType: 'lowpass'       // 可选 lowpass/highpass/bandpass/lowshelf/highshelf/notch/allpass/peaking
  filterCutoff: 1000          // Hz
  isLFOFilterCutoffEnabled: false
  lfoFilterCutoffFrequency: 0.5          // Hz
  lfoFilterCutoffRange: [100, 5000]      // LFO 输出映射到 filter.frequency 的上下限 Hz
  isTremoloEnabled: false
  tremoloFrequency: 0.5       // Hz
  tremoloDepth: 0.5           // 0..1
  isReverbEnabled: false      // per-sample: reverbDecay / reverbPreDelay / reverbWet
  ```
  链路（每个分支都实测过）：`Noise → Filter → Tremolo → destination`；LFO：`new Tone.LFO({ frequency: 0.5, min: 100, max: 5000 }).connect(filter.frequency).start()`。
- **循环无缝的处理方式（可直接照搬）**：给每个采样/缓冲设 `player.loop = true`、`player.fadeIn = s.fadeIn`，并用**显式循环点**而不是整段循环：
  `setLoopPoints(s.loopStart, s.loopEnd)`，未启用时才 `setLoopPoints(0, buffer.duration)`。另有 `playbackMode: 'sporadic'` 模式——`loop=false` + `setInterval` 在 `sporadicMin..sporadicMax` 秒之间随机播放一次，这正好是"偶尔的鸟叫"该用的模式。
- 定时/停止：`Tone.Transport.loopEnd = duration`，`noise.sync().start(0).stop(this.duration)`。

### B3. MDN `webaudio-examples` — 手写 Web Audio（不依赖 Tone.js）的官方参考

- 噪声缓冲（`step-sequencer/index.html`，https://raw.githubusercontent.com/mdn/webaudio-examples/main/step-sequencer/index.html ）：
  ```js
  let noiseDuration = 1;
  const bufferSize = audioCtx.sampleRate * noiseDuration;
  const noiseBuffer = new AudioBuffer({ length: bufferSize, sampleRate: audioCtx.sampleRate });
  const data = noiseBuffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;
  const noise = new AudioBufferSourceNode(audioCtx, { buffer: noiseBuffer });
  const bandpass = new BiquadFilterNode(audioCtx, { type: "bandpass", frequency: bandHz });
  noise.connect(bandpass).connect(audioCtx.destination);
  noise.start(time);
  ```
  → 这就是"**每滴雨 = 一个带通噪声 blip**"的最小实现：`noiseDuration = 1s` 的随机缓冲 + `bandpass`（`bandHz` 由 UI 控制）。
- 文档页（讲 LFO 调制与包络）：https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API/Advanced_techniques
- 失真曲线（做"雷声/厚重风"时常用，实测 `amount=50`）：`curve[i] = ((3+k)*x*20*deg) / (Math.PI + k*Math.abs(x))`，`x = (i*2)/n_samples - 1`，`deg = π/180`，`n_samples = 44100`。

### B4. sethbrasile/ez-web-audio — 各频段该配什么 cutoff（**拿数值最快的地方**）

- 示例：https://sethbrasile.github.io/ez-web-audio/examples/ambient-generator.html
- 它把"白噪声过 lowpass"的听感按 cutoff 直接分了档，可直接映射到用户要的四种氛围：
  - **200–600 Hz：低沉轰鸣（远处雷声）**
  - **600–1500 Hz：风 / 海浪**
  - **1500–4000 Hz：空气感嘶声 / 雨**
- 其实际代码用 `createFilterEffect('lowpass', { frequency: 800, q: 1.0 })` 做 texture 层，`changeGainTo(0.15)`；另有 `createWhiteNoise()` 现成封装。

### B5. 鸟鸣（"春天的微风 + 偶尔鸟叫"）

- **Carlo47/BirdConcert**（https://github.com/Carlo47/BirdConcert ）：chirp 公式 `f_next = f_m + f_a * sin(k * stepNbr)`（README 原文），即**正弦调制的频率扫描**。注意：**该仓库是 C++/Arduino（`lib/Chirpmaker/Chirpmaker.cpp`、`platformio.ini`），不是 JS**，只能借公式，不能直接引代码。
- Web 端等价做法：`OscillatorNode(sine/triangle)` + 对 `frequency` 用 `setValueCurveAtTime` 或每帧 `exponentialRampToValueAtTime` 做 200 ms 上扫/下扫，再乘一个快速衰减的 Gain 包络；用 B2 的 `sporadic` 随机间隔触发。

### B6. 用户点名的"small implementation of rain/wind"检索结果

- 点名候选逐个核对结果：
  - `noisefall`：**未找到可用仓库**，搜索无结果。
  - `web-audio-noise-generator`：只找到 npm 包 `noised`（非雨声合成）。
  - `rainyday.js`：那是 canvas 雨滴打在玻璃上的**视觉效果**，与音频无关。
  - **实际最接近"小实现"的两个**：`noisedash`（B2，参数最全）和 MDN 的 `step-sequencer`（B3，代码最短且无依赖）。另外 `hallencj/weather-maker` 有**雷声**的完整合成（见下），但它的雨只有 CSS 视觉、没有雨声。

雷声节点图（weather-maker `src/core.ts`，`thunder()`，可直接抄去当"雨夜"的低频层）：
```js
// 隆隆声：3 秒噪声 + lowpass 380Hz→70Hz 指数下扫 + 快速包络
src.buffer = noiseBuffer(c, 3);
lp.type='lowpass'; lp.frequency.setValueAtTime(380, now);
lp.frequency.exponentialRampToValueAtTime(70, now + 2.4);
g.gain.setValueAtTime(0.0001, now);
g.gain.exponentialRampToValueAtTime(0.8,   now + 0.04);
g.gain.exponentialRampToValueAtTime(0.0001, now + 2.6);
// 体感低频：正弦 52 Hz
osc.type='sine'; osc.frequency.value = 52;
og.gain: 0.0001 →(0.08s) 0.45 →(1.8s) 0.0001
```
它的全局音频骨架也值得照抄：模块级单例 `audioCtx / masterGain`，`masterGain.gain.value = muted ? 0 : volume`，`ctx.state === 'suspended'` 才 `ctx.resume()`，并注册 `pointerdown/keydown/touchstart` 一次性手势恢复（`resumeOnGesture()`）。

### B7. 循环缝爆音 & 静音/取消静音的标准做法

- **避免循环缝 click**（三条，按可靠性排序）：
  1. **噪声源天然免疫**：`Math.random()*2-1` 的缓冲首尾本来就不连续，但因为是**随机**信号，接缝处的跳变与信号自身的跳变统计上无法区分 → 连续噪声循环几乎听不出缝（B3 的 2 秒 buffer 正因如此够用）。真正会爆音的是**有音高/有包络**的循环。
  2. **显式循环点**而非整段循环：B2 的 `setLoopPoints(loopStart, loopEnd)`，把首尾的静音/渐弱段排除在循环区间外。
  3. **给循环源自身一个 fade**：`player.fadeIn = s.fadeIn`（Tone.js 的 `Player.fadeIn` 会在 buffer 头部做交叉淡化），或用两个 BufferSource 交叉淡入淡出（Web Audio 规范里对此有专门讨论：[WebAudio/web-audio-api#2537](https://github.com/WebAudio/web-audio-api/issues/2537)）。
- **静音/取消静音**：
  - **不要直接把 `gain.value = 0`**（瞬时跳变会 click）。用 ramp：`gain.gain.setValueAtTime(gain.gain.value, now); gain.gain.linearRampToValueAtTime(0, now + 0.05)`；要指数时记得 `exponentialRampToValueAtTime` **不接受 0**，用 `0.0001` 当底（B5 雷声代码里全是这个写法）。
  - **`ctx.suspend()` 不是静音手段**：它是暂停整个时间线（省电），恢复必须重新 `resume()`；`suspend` 时若还有尾音会硬切。**标准组合**：`gain` ramp 淡出 → 等 ramp 结束（~50 ms）→ 再 `ctx.suspend()`；重新播时 `ctx.resume()` → `gain` ramp 淡入。
  - 另外 `AudioContext` 必须由用户手势创建/恢复：`audiocontext-states` 示例 https://github.com/mdn/webaudio-examples/tree/main/audiocontext-states ，以及 weather-maker 的 `resumeOnGesture()`。

---

## 给桌面宠物部件的可执行结论

1. **粒子**：用 **Canvas 2D + 预渲染 sprite**（A1 证明 30 个 sprite 足够好看，A2/A3 分别证明 40/100 量级也稳）。形状要么内联 sprite（樱花/叶子），要么纯路径（A3 给出可直接抄的贝塞尔/二次曲线参数），雨用**渐变线段**、雪用 `arc`。
2. **翻转感**：若想让叶子/花瓣"翻面"，**只有 A3 的 `ctx.scale(|cos(flip)|*0.3+0.7, 1)` 是现成实现**；MengTo 的 SKILL 要求更强（`cos` 过零 + 正反面两张图 + 侧滑与 `sin(spin)` 耦合），可作为升级路线。
3. **数量**：直接采用 A3 的按面积缩放公式（`80..600`，基准 1920×1080）或 MengTo 的 `k = clamp(√(W*H/(1440*900)), .5, 1.3)`。
4. **物理**：这几个真实项目里**没有一家用 Perlin/噪声场**；都是 `vy + rand*gravity`（A2）或恒定 `vy*delta`（A1），横向靠 `sin(step)`（A3）或 `wind_x/40`。想要"更高级"的观感，收益最大的是 A3 的双正弦耦合与 `(r/baseSize)^1.5` 的尺寸-速度关系。
5. **音频**：噪声层用 `BufferSource(白噪声 loop) → BiquadFilter(lowpass) → Gain`，cutoff 按 B4 取档（雨 1500–4000、风 600–1500、闷雷 200–600），LFO 用 0.2 Hz（教程）/0.5 Hz（noisedash）+ 500 Hz 深度或 `range [100,5000]`。雨滴的"blip"用 MDN 的 1 秒带通噪声。鸟叫用正弦频率扫描 + sporadic 随机间隔。静音走 gain ramp，`suspend()` 只用于省电。
