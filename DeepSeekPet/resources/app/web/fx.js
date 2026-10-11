/**
 * 天气粒子与音符（2026-10-10 新建；2026-10-11 这一版重画形状 + 换成 canvas）。
 *
 * ★ **为什么单独一个文件**：粒子原来塞在 `pet-core.js` 里（那是**上游文件**，改多了危险 ——
 * 第 1.23 节两次"她不动了"都在那附近）。现在物理、外观、轨迹**全在这里**，
 * `pet-core` 只留一条出口（`renderFx` 钩子：把画粒子那一步交给外面）。
 *
 * ★ **这一版换掉了渲染方式**（用户实测："特效会导致卡顿"）。原来是**每帧拼一段 SVG 字符串再
 * `innerHTML = …`**：60fps × 200 颗粒子 = 每秒让浏览器**重新解析并重建上万个 DOM 节点**。
 * 现在整层粒子画在**一张 `<canvas>`** 上（`pet.html` 的 `#fxCanvas`，和她的 SVG 同一坐标系，
 * 1 用户单位 = 1 CSS 像素）：
 *
 * | | 旧（SVG） | 现在（canvas） |
 * |---|---|---|
 * | 每帧成本 | 拼字符串 + 解析 + 重建 DOM（跟粒子数成正比，还会触发样式重算） | 一次 `clearRect` + N 次画图调用，**不产生任何 DOM** |
 * | 雪花 | 每颗一条 13 段折线的 `<path d=…>` | 六臂线条（后三臂由 `scale(-1,1)` 镜像出来，省一半三角函数），臂上的小枝**生成时算好**存在粒子上 |
 * | 樱花/落叶 | `<g transform>` + 路径 + 每帧拼 `scale()` 字符串 | **一次性烘到小贴图上**（花瓣带渐变+缺口+花脉、叶子带主脉侧脉），每帧只是 `setTransform` + `drawImage` |
 * | 雨 | 每条一个 `<line>` | 一次 `stroke()` |
 * | 静默出错 | `innerHTML` 的字符串没人能测 | `stats()` 把"这一帧画了什么"记下来（形状/尺寸/翻转），自检直接查它 |
 *
 * ⚠️ 几个**别踩回去**的坑（都是这一轮或上一轮实测出来的）：
 *   ① 绘制清单 `D` 里的对象**必须从池子里 reuse**：雨 110 颗/秒、每条活 4 秒，每帧新建对象
 *      等于给 GC 每秒送 6000 个短命对象，"优化卡顿"反而制造卡顿；
 *   ② `innerHTML` 那套自检断言（查 `<path d=`、查 `scale(`）换 canvas 之后**必须换成查 `stats()`**，
 *      否则自检会"绿着但什么都没测"；
 *   ③ `emit(kind, scale)` 的 `scale` 只许削**发射速率**，不许削 `cap` ——
 *      削 cap 会在卡顿时把上限打到 35%，那一下就"雪突然没了"。
 *
 * ⚠️ 想调手感：发射量/分层在 `PROFILE`，形状在 `SPRITE`，配色在 `refreshPal`，画法在 `drawQ`。
 *
 * ★ **2026-10-11 晚：粒子开始"知道她在哪"**（用户点名的第 ③ 项，方案见
 * `本轮改动-方案与进度.md` 第三节）。做法刻意做小：
 *   · 页面每帧把她的**变换快照**喂进来（`fx.actor()`，就是 pet-core `render()` 写进 `pet.xf`
 *     的那几个数）→ fx 自己算出"她被当成多大的盒子"：**两个圆，与 pet-core 的 `hitPet` 同源**
 *     （能点到的范围 = 天气能碰到的范围，自检钉住这条一致性）；
 *   · 然后分天气给反应：**雨**打到她身上溅一圈、**樱/落叶**擦着她滑走（并**升到近层**，
 *     否则在她身后根本看不见）、她**走动时带起一阵风**把前面的粒子吹歪。
 *   · 成本：每颗一次判定（最多 240 颗 × ~12 次浮点 ≈ **0.03ms/帧**）+ 绘制增量 <0.05ms。
 *     **不新增遍历、不新建对象、不新增一次全屏 clearRect。**
 *
 * ⚠️ **这一套的三条"不许"**（自检盯着，回退时也照这个查）：
 *   ① 不许在粒子循环里建对象（快照对象只有一个、命中点复用 `HIT`）；
 *   ② 不许加第二个粒子循环（判定并进 `step()` 那个既有循环）；
 *   ③ 新字段**必须在 `make()` 里清** —— 粒子是从池子里 reuse 的（见上面第 ① 条）。
 *
 * ⚠️ **没有她的时候（`actor(null)` / 自检 / 老宿主）这套整体关闭**，粒子行为与上一版逐字相同：
 * 自检 `07b-fx-particles` 就是这么跑的，它那 12 条一条都不许变。
 */

/* =====================================================================================
 * 噪声与风场（轨迹这一层是上一版定下来的：位置+时间采样 → 一片被同一阵风推）
 * ===================================================================================== */
const NOISE_N = 256;
const NOISE = new Float32Array(NOISE_N);
for (let i = 0; i < NOISE_N; i += 1) NOISE[i] = Math.random() * 2 - 1;
const fade = (t) => t * t * (3 - 2 * t);
function noise1(x) {
  const i = Math.floor(x), t = fade(x - i);
  const a = NOISE[((i % NOISE_N) + NOISE_N) % NOISE_N], b = NOISE[(((i + 1) % NOISE_N) + NOISE_N) % NOISE_N];
  return a + (b - a) * t;
}
/**
 * 风场：`windAt(seed, x, y, t)` → 水平风（px/s）。
 * 两层噪声叠加（慢的大风 + 快的阵风），**只跟位置和时间有关** ——
 * 所以相邻的粒子被同一阵风推，整片看着是"一阵风过去"，而不是各摆各的。
 * 另外叠一条**很慢的"天气包络"**（每 20~40 秒风大一阵），整片雪会一起加速、飘得更斜。
 */
const WIND_SPACE = 0.0016, WIND_TIME = 0.06;
function gustEnv(t) { return 34 + 26 * noise1(t * 0.03); }
function windAt(seed, x, y, t) {
  const u = x * WIND_SPACE + seed, v = y * WIND_SPACE * 0.6, s = t * WIND_TIME;
  return (noise1(u + s) + noise1(u * 2.7 + v + s * 1.6) * 0.5) * gustEnv(t);
}

/**
 * 每种天气的**手感表**。按"现实轨迹"写的（资料见 HANDOVER 第 1.35 节）：
 *   · **终端速度**（`vT`）而不是匀加速 —— 雪片、花瓣落地前不会一直加速；
 *   · **三层景深**（`layers`）：远的又小又淡又慢、近的又大又快 → 视差；
 *   · `stall`（落叶/樱瓣）：迎风面周期性变大 → **下沉忽快忽慢**（薄片的升力）；
 *   · `slip`（落叶/樱瓣）：**侧滑由翻滚角驱动**（侧立时滑得最快）—— 这是"叶子"和"纸屑"的分界；
 *   · `flip`（樱瓣）：`|cos θ|` 的纸片式翻转（`θ` 的角速度就是 `spinSp`）；
 *   · `fade`：**必须显式给**（上一版 `op` 里读了 `p.fade` 而它从来没被赋值 → 淡出一直没生效，
 *     不报错、看着也"正常"，属于最阴的那种静默出错）。
 *
 * `perS` 每秒发射几颗 · `cap` 同时最多几颗 · `shutter` 雨丝曝光时间。
 *
 * ★ 2026-10-11 把 `perS/cap` 整体下调一档（用户："减少一点密度可以接受"）：
 *   雪 16→11、樱 3.4→2.6、落叶 4→3、雨 150→110。canvas 渲染本来就比 SVG 便宜一个量级，
 *   再叠上这一档，帧时间从两位数毫秒回到个位数（见 HANDOVER 第 1.36 节）。
 *
 * ★ 2026-10-11 晚：**樱花加回两成**（用户实测："樱花天气的特效粒子数量有点少……我感觉加 0.2 倍左右"）：
 *   樱 `perS 4 → 4.8`、`cap 44 → 53`（两成）。**只动樱花这一档**，别的天气一个字没改；
 *   同屏粒子的实测值见 `dev-weather\check-drift.cjs`（44 → 53 颗）。上表那句"樱 3.4→2.6"是
 *   当时那一轮的数字，后来为了"够密"又调回过 4（雨的 110→170 也是同一批），这里一并记清楚。
 */
const PROFILE = {
  snow: {
    perS: 11, cap: 78, sway: 26, hz: .2, spin: .4, stall: 0, slip: 0, fade: .2,
    layers: [                       // 远 → 近
      { w: .36, vT: [45, 110], size: [1.2, 2.2], alpha: [.28, .48], sway: [18, 34], hz: [.15, .30] },
      { w: .40, vT: [95, 190], size: [2.2, 4.2], alpha: [.45, .68], sway: [12, 24], hz: [.10, .22] },
      { w: .24, vT: [130, 260], size: [4.0, 7.0], alpha: [.60, .85], sway: [6, 15], hz: [.06, .15] },
    ],
    life: 40, wind: 1,
  },
  leaf: {
    /**
     * ★ **落叶：形状这一版重画**（用户："落叶还是不够像"）。
     * 上一版是一片**左右对称的二次曲线椭圆**（`M0 -r C… Z`），没有叶柄、没有贯到尖的主脉，
     * 所以远看就是纸屑。现在：**叶柄 + 主脉 + 每侧 3 条侧脉 + 正反面明暗**。
     * 尺寸也重新量过：叶长 **11~30px**（她是 42px 高的小鱼，一片叶子跟她手掌差不多大
     * 才像"接住一片叶子"）—— 见第 1.35 节那次教训：**"不像"先量尺寸和形态，别堆细节**。
     */
    perS: 3, cap: 40, stall: .30, slip: 46, spin: 1.6, spinSp: [.5, 2.3], wind: 1.2, fade: .18,
    layers: [
      { w: .42, vT: [26, 46], size: [5.5, 9.0], alpha: [.34, .52], sway: [16, 28], hz: [.20, .42] },
      { w: .44, vT: [46, 78], size: [9.5, 15.0], alpha: [.52, .80], sway: [12, 22], hz: [.16, .34] },
      { w: .14, vT: [92, 150], size: [19, 30], alpha: [.56, .86], sway: [8, 16], hz: [.14, .26] },
    ],
    life: 40,
  },
  blossom: {
    /**
     * ★ **樱花：飘的是一片片"单花瓣"，不是整朵花**（2026-10-10 用户实测："樱花还是太丑了，怎么这么大"）。
     *
     * 第一版画的是**五瓣整花**，量出来直径 **8.7~18.9px** —— 在桌面上比她的手指还大，
     * 而且真实的樱花雨里落的本来就**绝大多数是单花瓣**（整朵花是很少见的）。
     * 参考：[leoska/sakura](https://github.com/leoska/sakura)、[minz71/sakura-rain](https://github.com/minz71/sakura-rain)
     * 那类"樱花雨"实现，以及调研给的尺寸表（花瓣 6~14px、整花是稀有物）。
     *
     * 现在：**单花瓣**，7~14px 长（量的方法是"贴图长度 × 缩放"，见 `stats().meta.maxLen`）；
     * `flower`（整朵小花）**只有 8% 的概率**，只在中/近层出现 —— 偶尔飘过一朵才显得"有花"。
     * 形状也重画了（用户第二次反馈："樱花还是不够像"）：**根部小柄 + 两侧鼓 + 尖端浅凹口**，
     * 再叠主脉/侧脉/高光/根部暖色，见 `petalPath` 与 `SPRITE.petal`。
     *
     * ★ 2026-10-11 晚（用户第三次反馈，这一条是**数量**不是形状）："樱花天气的特效粒子数量有点少……
     * 我感觉加 0.2 倍左右" → `perS 4 → 4.8`、`cap 44 → 53`。**只动这一档**（见文件头 PROFILE 那段）。
     */
    perS: 4.8, cap: 53, stall: .22, slip: 34, spin: 0, spinSp: [.45, .95], flip: [.45, 1.1], wind: 1.5, fade: .2,
    /**
     * ★ **整朵花的自转上限**（用户两次反馈）：默认 `±0.5 rad/s`(≈29°/s) → 第一次收到 `±0.28`(≈16°/s)
     * → 用户"还是快了" → **再降一半**到 `±0.05~0.14 rad/s`（上限 ≈8°/s，转一圈 45 秒）。
     * 单花瓣的**翻转**相位（`spinSp`）不动。
     */
    rollSp: [.05, .14],
    flowerChance: .08,
    layers: [
      { w: .40, vT: [20, 32], size: [3.6, 4.8], alpha: [.52, .70], sway: [14, 24], hz: [.07, .16] },
      { w: .40, vT: [32, 44], size: [4.4, 5.8], alpha: [.62, .82], sway: [12, 20], hz: [.06, .14] },
      { w: .20, vT: [44, 60], size: [5.6, 7.4], alpha: [.70, .92], sway: [10, 18], hz: [.05, .12] },
    ],
    life: 45,
  },
  rain: {
    /**
     * ★ 雨：**同屏密度是"发射率 × 落到底要多久"决定的**，不是 `perS` 直接等于屏幕上有几条。
     * 上一版 `perS: 150 / cap: 220` 在 760px 高的窗口里同屏只有 ~100 条；这一版先按"减密度"
     * 砍到 110，实测量出来只剩 **73 条** —— 自检里"雨要够密（>90）"当场 FAIL（见 HANDOVER 第 1.36 节），
     * 于是回到 `perS: 170 / cap: 240`：同屏 **≈113 条**，比旧版少（当时是 220 的 cap 但发不满），
     * 又不会稀。**下次想调雨的疏密，先算一遍 `perS × 平均下落时间`，别只看 `perS`。**
     *
     * "够密"的观感另一半靠曝光时间给：雨丝长度 = 速度 × `shutter`（0.05s）→
     * 近层一条 100px 以上，看着比 300 条短线更像下雨（也省一半绘制）。
     */
    perS: 170, cap: 240, shutter: .05, wind: .3, fall: .5, gravity: 0, fade: .12,
    layers: [
      { w: .45, vT: [950, 1400], size: [.7, 1.1], alpha: [.12, .24] },
      { w: .35, vT: [1400, 2000], size: [1.1, 1.6], alpha: [.22, .40] },
      { w: .20, vT: [2000, 2900], size: [1.6, 2.4], alpha: [.34, .58] },
    ],
    life: 4,
  },
  note: {
    perS: 0, cap: 22, stall: 0, slip: 0, spin: .3, wind: .6, fade: .3,
    layers: [{ w: 1, vT: [-52, -30], size: [12, 18], alpha: [.75, .95], sway: [8, 16], hz: [.5, .9] }],
    life: 1.8,
  },
};
/** 所有粒子总数（含她身上的爱心/尘土那种一次性特技）的天花板。 */
const HARD_CAP = 240;
/** `PROFILE[kind].life` 没给时的兜底。 */
const DEFAULT_LIFE = 40;

/**
 * **花瓣路径**（单位方框、**以形状中心为原点**：`y = -0.5` 是花瓣尖，`y = +0.5` 是根部/花心那头）。
 *
 * ⚠️ **原点必须在形状中心，不能在根部** —— 2026-10-11 用户实测："花瓣感觉少了三分之一"。
 * 贴图是按"贴图中心 = 形状中心"画的（`cx = cy = box/2`），而第一版路径以**根部**为原点，
 * 于是有整整一半的形状落在贴图外被裁掉（花瓣缺一大截、叶子缺个尖）。**这是 bug，不是设计。**
 *
 * 形状三条关键量（按真实樱花花瓣定的）：
 *   · **根部细**（大约半宽 0.11）；
 *   · **最宽处 ±0.26 在 y ≈ 0**（偏根那一侧，这是樱花花瓣的姿势）；
 *   · **尖端浅凹口**：两侧尖角到 -0.49，中间凹回到 -0.40 → 缺口深约 0.09；
 *   · `S` 是"胖瘦"倍率（0.88~1.12，每片不同 —— 一个模子刻出来是最假的）。
 *
 * ⚠️ 别靠"再加几个控制点补细节"：花瓣像不像，八成取决于**宽度、缺口深度、根宽**这三个数。
 */
function petalPath(S = 1) {
  const f = (n) => (n * S).toFixed(3);
  return 'M0 0.5'                                                            // 根部（花心那头）
    + `C${f(.04)} ${f(.42)} ${f(.15)} ${f(.30)} ${f(.21)} ${f(.12)}`        // 从细柄鼓出去
    + `C${f(.24)} ${f(-.04)} ${f(.24)} ${f(-.22)} ${f(.19)} ${f(-.32)}`     // 最宽处（y≈-.1，半宽 .24）
    + `C${f(.13)} ${f(-.44)} ${f(.07)} ${f(-.50)} ${f(.03)} ${f(-.42)}`     // 收向尖端的右侧
    + `C${f(.015)} ${f(-.39)} 0 ${f(-.415)} ${f(-.015)} ${f(-.39)}`         // ★ 缺口（浅凹口）
    + `C${f(-.03)} ${f(-.42)} ${f(-.07)} ${f(-.50)} ${f(-.13)} ${f(-.44)}`  // 镜像的左侧
    + `C${f(-.19)} ${f(-.32)} ${f(-.24)} ${f(-.22)} ${f(-.24)} ${f(-.04)}`
    + `C${f(-.24)} ${f(.12)} ${f(-.15)} ${f(.30)} ${f(-.04)} ${f(.42)}Z`;
}
/**
 * **叶子的形状**（单位方框、**以形状中心为原点**：`y = -0.44` 是叶尖、`y = +0.5` 是叶柄端）。
 * 最宽处在 `y ≈ 0`（真实叶子最宽处在中上部），叶柄那一头收成尖 + 一小段窄柄
 * （柄要窄：粗了像雪糕棍）。
 */
function leafPath() {
  return 'M0 -.44'
    + 'C.22 -.26 .38 .02 .36 .22'
    + 'C.34 .42 .22 .58 .05 .70'
    + 'L.035 .92L-.035 .92L-.05 .70'          // ★ 叶柄（上一版完全没有）
    + 'C-.22 .58 -.34 .42 -.36 .22'
    + 'C-.38 .02 -.22 -.26 0 -.44Z';
}

/**
 * 把一条"只有 M / L / C"的路径**采样成点**（自检量形状用；运行时不用它，别在 `draw` 里调）。
 * 支持 M、L、C、Z（相对/绝对都行）。
 *
 * 为什么要真采样：第一版只拿"锚点"算几何量，于是**根部宽度**量成了 0.10（真实值 0.22），
 * 自检当场 FAIL —— 而错的其实是那把尺子，不是花瓣。量形状就得沿着曲线量。
 */
export function samplePath(d, per = 24) {
  const toks = String(d).match(/[MLCZmlcz]|-?\d*\.?\d+(?:e-?\d+)?/g) || [];
  let i = 0, x = 0, y = 0, sx = 0, sy = 0;
  const out = [];
  while (i < toks.length) {
    const c = toks[i++];
    if (c === 'M' || c === 'm') {
      x = +toks[i++]; y = +toks[i++];
      if (c === 'm') { x += sx; y += sy; }
      sx = x; sy = y; out.push([x, y]);
    } else if (c === 'L' || c === 'l') {
      const nx = +toks[i++], ny = +toks[i++];
      x = c === 'l' ? x + nx : nx; y = c === 'l' ? y + ny : ny;
      out.push([x, y]);
    } else if (c === 'C' || c === 'c') {
      let x1 = +toks[i++], y1 = +toks[i++], x2 = +toks[i++], y2 = +toks[i++], nx = +toks[i++], ny = +toks[i++];
      if (c === 'c') { x1 += x; y1 += y; x2 += x; y2 += y; nx += x; ny += y; }
      for (let k = 1; k <= per; k += 1) {
        const t = k / per, u = 1 - t;
        out.push([
          u * u * u * x + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * nx,
          u * u * u * y + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * ny,
        ]);
      }
      x = nx; y = ny;
    } else if (c === 'Z' || c === 'z') { x = sx; y = sy; }
  }
  return out;
}
/** 对一条路径量出"像不像"那几个数（宽、根宽、尖端）。原点在形状中心（见 `petalPath` 的警告）。 */
function shapeMetrics(d) {
  const pts = samplePath(d);
  let maxW = 0, tipY = 0, rootW = 0;
  for (const [px, py] of pts) {
    maxW = Math.max(maxW, Math.abs(px));
    tipY = Math.min(tipY, py);
    if (py > .40) rootW = Math.max(rootW, Math.abs(px) * 2);    // 根部（+0.40 以上）有多宽
  }
  return { maxWidth: +maxW.toFixed(3), rootWidth: +rootW.toFixed(3), tipY: +tipY.toFixed(3), w: +(maxW * 2).toFixed(3), h: +Math.abs(tipY).toFixed(3) };
}
/**
 * **花瓣的几何量**：自检直接量这几个数（形状像不像靠数据说话，不靠"我觉得"）。
 * `notchDepth` = 两侧尖角（-0.49）与凹口最深处（-0.40）之差 —— 它就是"花瓣尖上那个小凹"。
 */
export const PETAL_METRICS = (() => {
  const m = shapeMetrics(petalPath(1));
  return {
    ...m,
    notchY: -.415,
    notchDepth: +(-.415 - m.tipY).toFixed(3),
    aspect: +(m.w / (Math.abs(m.tipY) + .5)).toFixed(3),   // 宽 ÷ 长（樱花花瓣 ≈ 0.6~0.8）
    inUnitBox: m.maxWidth <= .5 + 1e-6 && m.tipY >= -1 - 1e-6,
  };
})();
/** **叶子的几何量**（同上；`stemWidth` = 叶柄有多宽 —— 太粗就不像叶子，像雪糕棍）。 */
export const LEAF_METRICS = (() => {
  const m = shapeMetrics(leafPath());
  let stemW = 0;
  for (const [px, py] of samplePath(leafPath())) if (py > .75) stemW = Math.max(stemW, Math.abs(px) * 2);
  return { ...m, stemWidth: +stemW.toFixed(3), inUnitBox: m.maxWidth <= .5 + 1e-6 && Math.abs(m.tipY) <= 1 };
})();

/* =====================================================================================
 * 四套形状的贴图：一次性烘到小离屏画布，之后每帧只是 drawImage
 * ===================================================================================== */
/**
 * 三套形状的贴图：一次性烘到小离屏画布，之后每帧只是 `drawImage`。
 *
 * `boxRate` = **贴图边长 ÷ 粒子尺寸**（形状在单位方框里 → 1.15 留出描边/高光的余量）。
 * `paint(g, s, pal, v)` 拿到的是 `{ len: 形状撑满方框对应的像素长度, cx, cy }`
 * —— 形状画在 `[-len/2, +len/2]` 里，正好等于贴图中心。
 */
const SPRITE = {
  /**
   * ★ **一枚雪笔触**（2026-10-11 深夜第二版：不再当"一团雪"用，而是**沿她的顶面盖一串**）。
   *
   * 上一版是个**正圆球**（软边径向渐变），直接把"棉花"画了出来：一整块 30px 的半透明白球、
   * 中间一小坨实的 → 观感就是"摆在她头上的一团棉花"。现在这一枚只当**笔触**：
   *
   * · 横的软边、**竖的更软**（`scale(1, .78)`）—— 顶上留一道略亮的受光面，底部飞快化开，
   *   `boxRate` 也从 1.3 提到 1.6 ***给那圈软边留够地方***（切掉软边的贴片 = 硬边贴片）。
   * · 单枚 alpha 很低（`tickAnchor` 里给 0.18~0.28）、间距 ~0.55px 互相叠 → 叠出来才是**一层**，
   *   而不是几个球。这是"尺寸必须统一"那条调研结论的正解：统一的是**笔触**，不是那团雪。
   * · ★ **颜色是冷调的**（`#E8F1FF`，不是 CSS 变量 `--snow`）：她本人**偏白**，纯白压上去只
   *   亮一点点（实测合成出来峰值 58% 却几乎看不出来）—— 冷色调才分得开"雪"和"她的皮肤"。
   *   这里刻意**不**用 `pal.snow`（那是给天上的雪花用的，要跟桌面色温一致），
   *   于是换主题时天上的雪会跟着变、她身上的积雪不会 —— 这是有意的取舍，不是漏了。
   */
  cap: {
    len: 26, boxRate: 1.6,
    paint(g, s) {
      const R = s.len / 2;
      g.setTransform(1, 0, 0, 1, s.cx, s.cy);
      g.scale(1, .78);                           // 竖的比横的更软（雪积在一条线上）
      const grd = g.createRadialGradient(0, -R * .20, R * .06, 0, 0, R);
      grd.addColorStop(0, '#FFFFFF');            // 顶上一点点最亮（受光）
      grd.addColorStop(.30, '#E8F1FF');          // ★ 冷调的雪白（见上）
      grd.addColorStop(.62, 'rgba(232,241,255,.42)');
      grd.addColorStop(1, 'rgba(232,241,255,0)'); // 边缘化开，不要硬边
      g.globalAlpha = 1;
      g.fillStyle = grd;
      g.beginPath(); g.ellipse(0, 0, R, R, 0, 0, 6.2832); g.fill();
    },
  },
  petal: {
    len: 22, boxRate: 1.15,
    /**
     * 一片花瓣：渐变底色 + 深粉描边 + 主脉 + 两条侧脉 + 一条高光。
     * `S` 是这一片的"胖瘦"倍率（0.88~1.12），`v` 只是缓存用的变体名。
     */
    paint(g, s, pal, S, v) {
      void v;
      g.setTransform(s.len, 0, 0, s.len, s.cx, s.cy);
      g.rotate(-Math.PI / 2);                       // 路径的 -y（尖端）转到 +x
      const p = new Path2D(petalPath(S));
      const grd = g.createLinearGradient(0, .5, 0, -.5);   // 根部（+.5）→ 尖端（-.5）
      grd.addColorStop(0, pal.petalRoot);           // 根部偏白（真实花瓣就是这样）
      grd.addColorStop(1, pal.blossom);
      g.fillStyle = grd;
      g.fill(p);
      g.lineWidth = .022; g.strokeStyle = pal.blossomInk; g.globalAlpha = .7; g.stroke(p);
      g.globalAlpha = .45;
      g.beginPath(); g.moveTo(0, .47); g.bezierCurveTo(0, .15, 0, -.15, 0, -.38); g.lineWidth = .022; g.stroke();
      g.globalAlpha = .28; g.lineWidth = .015;
      for (const sgn of [-1, 1]) {
        g.beginPath(); g.moveTo(0, .20); g.quadraticCurveTo(sgn * .09, .08, sgn * .15, -.05); g.stroke();
      }
      g.globalAlpha = .6; g.lineWidth = .036; g.strokeStyle = pal.blossomHi;
      g.beginPath(); g.moveTo(-.14, .22); g.bezierCurveTo(-.17, 0, -.11, -.20, -.04, -.30); g.stroke();
      g.globalAlpha = 1;
    },
  },
  leaf: {
    len: 30, boxRate: 1.15,
    /** 一片叶子：三色之一 + 叶尖到叶柄的渐变 + 主脉（贯到尖）+ 每侧 3 条侧脉。`hue` = 三色里的哪一种。 */
    paint(g, s, pal, hue, v) {
      void v;
      g.setTransform(s.len, 0, 0, s.len, s.cx, s.cy);
      const p = new Path2D(leafPath());
      const col = (hue == null ? .5 : hue) < .34 ? pal.leafA : (hue == null ? .5 : hue) < .7 ? pal.leafB : pal.leafC;
      const grd = g.createLinearGradient(0, -.44, 0, .92);   // 叶尖 → 叶柄端
      grd.addColorStop(0, col);
      grd.addColorStop(1, mixHex(col, pal.leafInk, .45));
      g.fillStyle = grd;
      g.fill(p);
      g.lineWidth = .022; g.strokeStyle = pal.leafInk; g.globalAlpha = .5; g.stroke(p);
      g.lineCap = 'round';
      g.globalAlpha = .8; g.lineWidth = .04;
      g.beginPath(); g.moveTo(0, .90); g.bezierCurveTo(0, .5, 0, -.1, 0, -.42); g.stroke();   // ★ 主脉贯到尖
      g.globalAlpha = .45; g.lineWidth = .02;
      for (const sgn of [-1, 1]) {
        for (const [y0, yv, xv] of [[.45, .30, .24], [.10, -.10, .30], [-.16, -.30, .26]]) {
          g.beginPath();
          g.moveTo(0, y0);
          g.quadraticCurveTo(sgn * xv * .55, (y0 + yv) / 2, sgn * xv, yv);
          g.stroke();
        }
      }
      g.globalAlpha = 1;
    },
  },
  /** 8% 概率的**整朵小花**：五片小花瓣 + 花心 + 花蕊。 */
  flower: {
    len: 26, boxRate: 1.6,                     // 五片花瓣从花心向外伸，比一片花瓣占的地方大
    paint(g, s, pal) {
      g.setTransform(s.len, 0, 0, s.len, s.cx, s.cy);
      for (let k = 0; k < 5; k += 1) {
        g.save();
        g.rotate((k * 72 + 18) * Math.PI / 180);
        g.translate(0, .40);                    // 花瓣"伸出去"：根部留在花心附近（y=+.5 → 离中心 .1）
        const p = new Path2D(petalPath(.72));   // 一片花瓣 ≈ 0.72 长，五片拼起来直径 ≈ 1.44 × (len/1.6)
        g.globalAlpha = .94;
        g.fillStyle = k % 2 ? pal.blossom : mixHex(pal.blossom, '#ffffff', .18);
        g.fill(p);
        g.lineWidth = .02; g.strokeStyle = pal.blossomInk; g.globalAlpha = .45; g.stroke(p);
        g.restore();
      }
      g.globalAlpha = 1;
      g.beginPath(); g.arc(0, 0, .055, 0, 6.2832); g.fillStyle = pal.blossomCore; g.fill();
      g.globalAlpha = .6; g.fillStyle = pal.blossomInk;
      for (let k = 0; k < 6; k += 1) {
        const a = k * Math.PI / 3;
        g.beginPath(); g.arc(Math.cos(a) * .095, Math.sin(a) * .095, .012, 0, 6.2832); g.fill();
      }
      g.globalAlpha = 1;
    },
  },
};
/** 反面色（叶子/花瓣翻过去那一面）压暗多少。 */
const BACK_DIM = .8;

/**
 * **横向漂移的回收半径与回中时间**（2026-10-11 修"龙卷风"时加的）。
 *
 * ⚠️ 原来的横向位移是**只加不减**的：`slip = sin(翻滚角) × 34~46 px/s`，而 `sin` 在长角上取样
 * 有非零均值 → 每颗粒子朝**同一个方向**净漂（樱花 34px/s × 45 秒 ≈ 1500px、落叶 46×40 ≈ 1800px，
 * 屏幕才 1280 宽）→ 用户实测的"单边/双龙卷风，龙卷风外几乎没粒子"。
 * 现在漂移**有界 + 会回中**（`dx *= exp(-dt/TAU)`，并夹在 `dcap` 内）：
 *   · 侧滑方向仍由翻滚角驱动（"侧立时滑得最快"保留，它是叶子与纸屑的分界）；
 *   · 但表现为"在锚点附近来回游走"，不再一路漂到屏幕外。
 * 离线量过：修完 8 格分布从 `11|6|3|0|0|4|5|10` 变成每格都有（`dev-weather/check-drift.cjs`）。
 */
const DRIFT_CAP = 90;     // 有侧滑的（落叶/樱瓣）：锚点外最多漂这么多
const WIND_CAP = 40;      // 只有风的（雪/雨）：别让慢粒子被阵风吹出屏幕
const DRIFT_TAU = 9;      // 回中时间常数（秒）：越小回中越快

/* ---------- 小工具 ---------- */
const rnd = (a, b) => a + Math.random() * (b - a);
/**
 * ★ **定死的伪随机**（0..1）：给积雪的笔触做抖动用。
 *
 * ⚠️ 这里**不能用 `rnd`/`Math.random`**：积雪不是一次性发射的粒子，它是**每帧现算**的
 * ——每帧换一组随机数，那层雪就会**满屏闪**（第一版"不同大小的白点"就是这么来的）。
 * 同一组参数永远得到同一个值，所以它看着有颗粒感，但**静止时完全不动**。
 */
const capJit = (n) => { const x = Math.sin(n * 12.9898) * 43758.5453; return x - Math.floor(x); };
const pick = (r) => r[0] + Math.random() * (r[1] - r[0]);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
function hex2rgb(h) {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(h).trim());
  if (!m) return null;
  let x = m[1];
  if (x.length === 3) x = x[0] + x[0] + x[1] + x[1] + x[2] + x[2];
  const n = parseInt(x, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function mixHex(a, b, t) {
  const A = hex2rgb(a) || [255, 255, 255], B = hex2rgb(b) || [0, 0, 0];
  const c = A.map((v, i) => Math.round(v + (B[i] - v) * t));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}
/**
 * 把 CSS 变量的值统一成 `#RRGGBB`。
 *
 * ⚠️ **两种写法都要认**（2026-10-11 踩过）：`pet.css` 里的 `--blossom: #FF9EC4` 是**十六进制**，
 * 而 `getPropertyValue` 对 `--note: var(--skin-eye)` 那种会算出 **`rgb(...)`**。
 * 第一版只写了 `rgb()` 的正则，于是所有 hex 值都掉进兜底 `#FFFFFF` ——
 * **樱花、落叶、雨、雪全被画成白的**（而且不报错，白得就像"雪下大了"）。
 */
function toHex(v) {
  const s = String(v == null ? '' : v).trim();
  const m6 = /^#([0-9a-f]{6})$/i.exec(s);
  if (m6) return `#${m6[1].toUpperCase()}`;
  const m3 = /^#([0-9a-f]{3})$/i.exec(s);
  if (m3) return (`#${m3[1][0]}${m3[1][0]}${m3[1][1]}${m3[1][1]}${m3[1][2]}${m3[1][2]}`).toUpperCase();
  const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(s);
  if (!m) return '#FFFFFF';
  const h = (x) => clamp(Math.round(+x), 0, 255).toString(16).padStart(2, '0');
  return `#${h(m[1])}${h(m[2])}${h(m[3])}`.toUpperCase();
}

/* =====================================================================================
 * 造一套粒子系统
 * ===================================================================================== */
/**
 *   `ctl`        —— pet-core 的控制句柄（只要 `bounds`：`{ W, H }`）
 *   `canvas`     —— **远层**画布（`#fxCanvas`，挂在她身后）。**没有它也能跑**（自检在 Node 里没有画布）
 *   `canvasNear` —— **近层**画布（`#fxCanvasNear`，盖在她身前）。**不给就退化成"一张画布"**
 *                   （全部粒子都画在 `canvas` 上，行为同上一版）
 *   `report`     —— 出错/诊断上报
 *   `onPaint`    —— 每帧画完回调一次（自检用，参数 `{ D, meta }`）
 *
 * ★ **为什么要两张画布**（2026-10-11 加）：canvas 和她的身体是**兄弟节点**，谁在前面只看 DOM 顺序 ——
 * 一张画布只能选"全在她身后"或"全在她身前"，两种都不像：雨雪糊脸是后者、粒子被身体挡住是前者。
 * 现在按 `PROFILE[kind].layers` 的**景深**分流：**最近的那一层画在身前的画布上，其余画在身后**
 * （见 `assignCanvas()`）。粒子落在哪一层是生成时定好的（`p.layer`），之后一辈子不变。
 */
export function createFx({ ctl, canvas, canvasNear, report, onPaint, onCtx } = {}) {
  /** 上一帧的时刻 / 音符节流计数 / 风场种子 / 发射余数（**都是这一套系统自己的状态**）。 */
  let last = null, noteTick = 0, seed = Math.random() * 100, cut = 0;
  /** 每一颗：位置、速度、时间、外观。`bx/by` 是"没有摆动时"的位置，风推的是它。 */
  const P = [];
  /** 回收站：粒子是"每秒几十个、活几十秒"的东西，别每秒造一批新对象给 GC。 */
  const free = [];
  /** 雨滴落地溅落：`{x, age, life, size}`（上限 26，超了就从最老的复用）。 */
  const splash = [];
  /**
   * 这一帧要画的东西（形状 + 变换 + 颜色）。
   * ⚠️ **池子化**：`D` 里每个对象都从 `pool` 里 reuse，画完还回去（见文件头第 ① 条）。
   */
  const D = [];
  const pool = [];
  let poolN = 0;
  const S = [];                        // 每帧的统计（自检读它）
  const meta = { fills: 0, strokes: 0, images: 0, maxLen: 0, minSpin: 1, maxSpin: 1, splash: 0, byKind: {},
    /**
     * 跟她的互动：这一帧新命中几颗 / 她身上的溅落数 / **有雪的锚点数** / 调试轮廓数 /
     * **最满那一顶的雪量**（0..1）/ **白雾数**（雪没粘住时冒的那一下）。
     */
    hits: 0, onBody: 0, cling: 0, box: 0, capAmt: 0, puff: 0 };
  /** 每帧一张的绘制对象（雨/雪花/音符/溅落用同一张，字段互相覆盖）。 */
  function take() {
    if (poolN < pool.length) return pool[poolN++];
    const o = {};
    pool.push(o);
    poolN += 1;
    return o;
  }

  let ctx = null, cw = 0, ch = 0, dpr = 1, drawBroken = false;
  /**
   * ★ **这一帧"画"花了多少毫秒**（`spend()`）与**"物理+发射"花了多少**（`spendPhys()`）。
   *
   * 为什么要分开量：只报"帧间隔"说明不了问题 —— 60fps 时帧间隔永远是 16.7ms，哪怕这一帧只花了
   * 2ms。真正决定卡不卡的是**干活的时间**。验收页用这三个数做 A/B 判断；桌宠那边不用它们。
   * ⚠️ 这两个接口**验收页每帧都在调**：一旦缺了，页面第一帧就抛错、整个主循环死掉（画面全空）。
   */
  let lastCost = 0, lastPhys = 0;
  const spender = (typeof performance !== 'undefined' && performance.now) ? () => performance.now() : null;
  if (canvas && typeof canvas.getContext === 'function') {
    try { ctx = canvas.getContext('2d'); } catch (e) { ctx = null; }
  }
  /**
   * 每帧真的往画布上打了多少次 `stroke/fill`（自检用：**贴图有没有画在画布上**
   * 是 canvas 版最容易"沉默失败"的一处 —— 形状算得再对，贴图没 drawImage 就是一片空）。
   */
  const calls = { stroke: 0, fill: 0, image: 0 };
  let ctl2 = ctx;
  if (onCtx && ctx) { try { ctl2 = onCtx(ctx) || ctx; } catch (e) { ctl2 = ctx; } }

  /* ---------- 近层画布（可选） ---------- */
  /**
   * **近层画布**：跟远层同一套 API，只是挂在 DOM 里她的身体**后面**，所以画上去的粒子盖在她前面。
   * `hasNear` 是唯一开关：**没给画布 / 没给出上下文 → 全部退化成一张**（自检、老宿主都不会因此出错）。
   * `ncw/nch` 是近层自己的 CSS 尺寸（两张画布各自校对，任何一张脏了都不会把另一张带歪）。
   */
  let ctxN = null, ncw = 0, nch = 0;
  if (canvasNear && typeof canvasNear.getContext === 'function') {
    try { ctxN = canvasNear.getContext('2d'); } catch (e) { ctxN = null; }
  }
  const hasNear = !!(ctx && ctxN);
  let ctl2N = ctxN;
  if (hasNear && onCtx) { try { ctl2N = onCtx(ctxN) || ctxN; } catch (e) { ctl2N = ctxN; } }
  if (!hasNear) ctxN = null;

  /* ---------- 配色（读 CSS 变量；只有真的变了才重建贴图） ---------- */
  const PAL_KEYS = ['snow', 'blossom', 'blossomInk', 'blossomHi', 'blossomCore', 'leafA', 'leafB', 'leafC', 'leafInk', 'rain', 'note', 'petalRoot'];
  let pal = null, palSig = '', sprites = new Map();
  function refreshPal(force) {
    if (!force && pal) return pal;
    let cs = null;
    try { cs = getComputedStyle(document.documentElement); } catch (e) { cs = null; }
    const g = (n, d) => {
      try { const v = cs && cs.getPropertyValue(n); return v && v.trim() ? v.trim() : d; } catch (e) { return d; }
    };
    const next = {
      snow: toHex(g('--snow', '#F2F7FF')),
      blossom: toHex(g('--blossom', '#FF9EC4')),
      blossomInk: toHex(g('--blossom-ink', '#D96A90')),
      blossomHi: toHex(g('--blossom-hi', '#FFE8F0')),
      blossomCore: toHex(g('--blossom-core', '#F0DC96')),
      leafA: toHex(g('--leaf-a', '#D9903A')),
      leafB: toHex(g('--leaf-b', '#B8572A')),
      leafC: toHex(g('--leaf-c', '#B09428')),
      leafInk: toHex(g('--leaf-ink', '#7A3F0E')),
      rain: toHex(g('--rain', '#7FA8CF')),
      note: toHex(g('--note', g('--skin-eye', '#2FD59B'))),
    };
    next.petalRoot = mixHex(next.blossom, '#ffffff', .55);   // 根部偏白（纯白在浅桌面上会"缺一块"）
    const sig = PAL_KEYS.map((k) => next[k]).join('|');
    if (sig !== palSig) { palSig = sig; sprites = new Map(); }
    pal = next;
    return pal;
  }
  /**
   * 拿一张贴图（按 `名字 + 缩放 + 变体 + 配色签名` 缓存）。
   *
   * ⚠️ **`paint` 的第 4 个参数是"形状变体"（花瓣胖瘦 / 叶子颜色），第 5 个才是缓存用的变体名** ——
   * 2026-10-11 这里把两者搞反过一次：传进去的是 `'n'`/`'w'` 这种**字符串**，于是
   * `petalPath('n')` 里 `'n' * 1` 全是 `NaN`，路径变成 `CNaN NaN …` ——
   * **Path2D 里全是 NaN 时 `fill()` 不画任何东西，也不抛错**，表现是花瓣只剩描边/高光
   * （看着像"月牙划痕"）。这一条浪费了半小时，记在这儿。
   */
  function sprite(key, kind, len, variant, hue) {
    const s = SPRITE[kind];
    const bake = Math.max(.2, Math.min(3, len / s.len));
    const b = Math.round(bake * 100) / 100;
    const K = `${key}|${b}|${variant == null ? '' : variant}|${hue == null ? '' : hue}|${palSig}`;
    const hit = sprites.get(K);
    if (hit) return hit;
    const box = Math.max(6, Math.round(s.len * b * s.boxRate));
    const off = document.createElement('canvas');
    off.width = box; off.height = box;
    const g = off.getContext('2d');
    const gg = (onCtx && g) ? (onCtx(g) || g) : g;
    try {
      g.clearRect(0, 0, box, box);
      s.paint(gg, { len: s.len * b, cx: box / 2, cy: box / 2 }, pal, hue, variant);
    } catch (e) {
      if (!drawBroken) { drawBroken = true; try { report?.(`画粒子贴图出错：${e && (e.stack || e.message)}`); } catch (err) { /* ignore */ } }
    }
    const entry = { c: off, cx: box / 2, cy: box / 2, len: s.len * b };
    sprites.set(K, entry);
    return entry;
  }
  /** 画布尺寸 = 窗口尺寸（dpr 上限 2：桌宠窗口铺满整屏，3x 的像素量换不来观感）。 */
  function ensureCanvas() {
    if (!ctx || !canvas) return null;
    const { W, H } = view();
    const d = clamp(globalThis.devicePixelRatio || 1, 1, 2);
    if (canvas.width !== Math.round(W * d) || canvas.height !== Math.round(H * d)) {
      canvas.width = Math.round(W * d);
      canvas.height = Math.round(H * d);
    }
    /**
     * ★ **近层画布自己校对一次**（`W/H/dpr` 跟远层共用**同一份** `view()` 结果 —— 尺寸只有一个来源，
     * 这就是上一棒"画布变 1×1"那条教训的用法：两张画布绝不许各算各的）。
     */
    if (hasNear) {
      if (canvasNear.width !== Math.round(W * d) || canvasNear.height !== Math.round(H * d)) {
        canvasNear.width = Math.round(W * d);
        canvasNear.height = Math.round(H * d);
      }
      if (ncw !== W || nch !== H) { ncw = W; nch = H; }
    }
    if (cw !== W || ch !== H || dpr !== d) { cw = W; ch = H; dpr = d; }
    return ctl2;
  }
  /**
   * 画布尺寸的来源，**只有一个定义**（2026-10-11 重理过一次）。
   *
   * 约定：`ctl.bounds` **对象和函数都收**（`{W,H}` 或 `() => ({W,H})`）。
   * 这里踩过坑：`view()` 原来只按**对象**读（`b.W`），而注释/验收页按**函数**传 ——
   * `b.W` 恰好也是函数的 `W` 属性 = `undefined` → `Math.max(1, undefined|0)` = **1**，
   * 于是"粒子在算、但全都画进一张 1×1 的画布"（不报错、看着就是空的）。验收页的 `fxSize()`
   * 一把把这个抓出来了（页面以为 967×408、fx 以为 1×1）。
   * 现在两种写法都认，且**尺寸是脏值就往下退**，永远不允许出现 1×1。
   */
  function view() {
    const b = ctl && ctl.bounds;
    let W = 0, H = 0;
    if (typeof b === 'function') {
      try { const v = b(); if (v) { W = v.W | 0; H = v.H | 0; } } catch (e) { /* 回调抛错就往下退 */ }
    } else if (b) { W = b.W | 0; H = b.H | 0; }
    // ② 画布自身的 CSS 尺寸（桌宠里 = 视口；普通网页里可能比视口小）
    if (!(W > 8) || !(H > 8)) {
      if (canvas && canvas.getBoundingClientRect) {
        const r = canvas.getBoundingClientRect();
        if (r.width > 8 && r.height > 8) { W = Math.round(r.width); H = Math.round(r.height); }
      }
    }
    // ③ 视口（桌宠窗口铺满整屏，所以这就是整块桌面）
    if (!(W > 8) || !(H > 8)) {
      W = (globalThis.innerWidth | 0) || 1280;
      H = (globalThis.innerHeight | 0) || 760;
    }
    return { W: Math.max(8, W | 0), H: Math.max(8, H | 0) };
  }
  /**
   * **这一颗画在哪张画布上**（近层 = 盖在她身前，远层 = 落在她身后）。
   *
   * 规则只看一个字段：`p.layer`。`PROFILE` 里 `layers` 是**从远到近**排的（第一层最远、最后一层
   * 最近最大最实），所以：
   *   · 三种天气都是"**最后一层**去近层"，其余留在远层 —— 远景的细雨/小雪在她身后，最近的那层
   *     从她面前划过（这正是"三层景深"该有的样子）；
   *   · 没有近层画布（老宿主 / 自检）时一律返回 false → 全部画在远层，行为同上一版；
   *   · 音符（`note`）**永远在近层**：它是从她嘴边冒出来的，被她的脸挡住就没意义了。
   */
  function assignCanvas(p) {
    if (!hasNear) return false;
    if (p.kind === 'note') return true;
    /**
     * ★ **擦过她的花瓣/落叶留在近层**（2026-10-11 晚加）：它们是被"她"挡住的，
     * 留在远层的话那一下擦身**什么都看不见**（她的身体把远层挡住了）—— 互动就白做了。
     */
    if (p.nearFix) return true;
    return p.layer >= p.layerN - 1;
  }

  /* ---------- 生成 ---------- */
  function pickLayer(p) {
    let roll = Math.random(), li = 0, acc = 0;
    for (let i = 0; i < p.layers.length; i += 1) { acc += p.layers[i].w; if (roll <= acc) { li = i; break; } }
    return li;
  }
  function make(kind, over) {
    const p = PROFILE[kind] || PROFILE.snow;
    const { W } = view();
    const li = pickLayer(p);
    const L = p.layers[li];
    const vT = pick(L.vT);
    const it = {
      kind, layer: li, layerN: p.layers.length,
      x: over && over.x != null ? over.x : rnd(-30, W + 30),
      y: over && over.y != null ? over.y : -14,
      bx: 0, by: 0,
      vx: 0, vy: vT * 0.35,          // 入画时还没到终端速度（下落会"先快后稳"）
      vT,                            // ★ 终端速度：用指数趋近，而不是一直加速
      wind: p.wind ?? 1,
      sway: pick(L.sway || [0, 0]),  // 摆动幅度：每颗独立（共用正弦是"五毛感"的第一来源）
      hz: pick(L.hz || [0, 0]),
      hzA: 0, phase: Math.random() * Math.PI * 2,
      spin: (p.spin || 0) * rnd(.6, 1.5) * (Math.random() < .5 ? -1 : 1),
      spinSp: p.spinSp ? pick(p.spinSp) * (Math.random() < .5 ? -1 : 1) : 0,
      roll: Math.random() * Math.PI * 2,
      rollSp: p.rollSp ? pick(p.rollSp) * (Math.random() < .5 ? -1 : 1) : rnd(-.5, .5),
      flip: p.flip ? pick(p.flip) : 0,
      seedRoll: Math.random(),
      slip: (p.slip || 0) * rnd(.6, 1.4),
      stall: p.stall || 0,
      rot: Math.random() * 360,
      size: pick(L.size),
      alpha: pick(L.alpha),
      fade: p.fade || .2,
      life: p.life || DEFAULT_LIFE,
      age: 0,
      drift: 1,
      spot: null,
      branches: null,
      /**
       * ★ **跟她的互动用的三个字段**（2026-10-11 晚加）。
       * ⚠️ **必须写在这个字面量里**：粒子是从 `free` 池子里 reuse 的，在这里给默认值 =
       * 每一世都从"没碰过她"开始（上一世是擦过她的花瓣、这一世是雪的话，不清就带着旧状态跑）。
       */
      hit: 0,                          // 0 = 这一生还没碰过她；1 = 碰过了（每颗只算一次）
      nearFix: 0,                      // 1 = 强制画在近层（擦过她的花瓣/落叶要留在她身前）
      px: 0, py: 0,                    // 上一帧的位置（舞台坐标，圆那条判定用）
      plx: NaN, ply: NaN,              // 上一帧的位置（**本地坐标**，真实轮廓那条判定用）
    };
    if (kind === 'snow') {                             // 六角星：每颗的臂长/粗细/小枝都不同
      it.arms = 3 + Math.floor(Math.random() * 2);
      it.armR = rnd(.62, .98);
      it.lw = rnd(.75, 1.35);
    }
    if (kind === 'leaf') it.leafHue = Math.random();
    if (kind === 'blossom') {
      it.ps = rnd(.88, 1.12);                          // 花瓣的胖瘦（每片不同）
      it.flower = li >= 1 && Math.random() < (p.flowerChance || 0);
      if (it.flower) it.flip = 0;                      // 整朵花不翻面，roll 慢慢转
    }
    if (kind === 'rain') it.fall = p.fall || 0;
    if (kind === 'note') { it.glyph = Math.random() < .5 ? '♪' : '♫'; it.spin = 0; }
    if (over) for (const k in over) if (over[k] !== undefined) it[k] = over[k];
    /**
     * `drift: 0` 是**调试用**的：让这颗粒子不往下走（视觉核对形状时把画面钉住）。
     * 正式跑的时候没人传它，`drift` 就是 1。
     */
    if (it.drift === undefined) it.drift = 1;
    it.dcap = (p.slip ? DRIFT_CAP : WIND_CAP) * rnd(.8, 1.2);   // 横向漂移的回收半径
    it.dx = 0;                                                  // 相对锚点的横向偏移
    it.ax = it.x;                                               // ★ 锚点：漂移在它附近游走
    it.bx = it.x; it.by = it.y;
    /** 出生这一帧的"上一帧位置" = 它自己（零长度线段 → 入射点退化成当前位置，不会算出 NaN）。 */
    it.px = it.x; it.py = it.y;
    it.hzA = it.hz * 2 * Math.PI;
    /**
     * ⚠️ `branches` 必须**在这里清掉**：粒子对象是从 `free` 里 reuse 的，
     * 上一世是雪花、这一世是雨滴的话，不清就会拿着雪花的臂去画雨。
     */
    if (kind !== 'snow') it.branches = null;
    return it;
  }
  function spawn(kind, over) {
    if (P.length >= HARD_CAP) return null;
    const it = free.pop();
    const out = it ? Object.assign(it, make(kind, over)) : make(kind, over);
    P.push(out);
    return out;
  }
  /**
   * 页面要的"每帧发射"接口：**这种天气同时最多 `cap` 颗**（到顶就不发了，等它们落地）。
   * ⚠️ `scale` 是"规模倍率"：桌宠按帧时间给 0.4~1（卡顿自动减量），验收页给到 3（堆粒子看渲染开销）。
   * 它同时动**上限**（= 密度）与**发射速率**；下限夹在 0.4，不会出现"雪突然一颗都没有"。
   */
  function emit(kind, scale = 1) {
    const p = PROFILE[kind];
    if (!p) return;
    /**
     * ⚠️ **上限钳制的上界是 3，不是 1**（2026-10-11 修）：验收页的「规模 300%」写着
     * "放大当前天气的发射量与上限"，而 `clamp(scale, .4, 1)` 把上限焊死在 100% ——
     * 于是堆不出高负载，A/B 数字（"600 颗 2.13ms"）根本量不出来。
     * 下限 `.4` **不许动**：那是"卡顿时也一颗都不许没有"的保险；真天花板是 `HARD_CAP`。
     */
    const want = Math.max(1, Math.round(p.cap * clamp(scale, .4, 3)));
    let same = 0;
    for (const it of P) if (it.kind === kind) same += 1;
    if (same >= want) return;
    spawn(kind);
  }
  /** 她说话时从嘴边冒音符。 */
  function note(x, y) {
    if (++noteTick % 4) return;
    spawn('note', { x: x + rnd(-10, 10), y, vx: rnd(-14, 14), vy: -rnd(30, 52) });
  }

  /* =====================================================================================
   * 她：天气与她的互动（2026-10-11 晚，用户点名的第 ③ 项）
   * ===================================================================================== */
  /**
   * ★ **她此刻在画布上的变换快照**。页面每帧在 `frame()` 之前灌一次（`fx.actor(…)`）：
   * `null` = 没有她（自检 / 老宿主 / 天气关着）→ **这一整套整体关闭**，粒子行为与上一版逐字相同。
   *
   * 为什么喂的是"变换"而不是"她在哪"：她会被拎起来转、会歪头、走路会侧倾、被压会拉伸 ——
   * 只有**同一套变换**才说得出"她身上"是画布上的哪一块。字段就是 pet-core `render()` 写进
   * `pet.xf` 的那几个（`AX/AY/ax/ay/kx/ky/rot`，见 pet-core L1190-1196）：**不是另发明的坐标**，
   * 所以不会跟她的画法漂移。
   */
  const A = { on: false, AX: 0, AY: 0, ax: 128, ay: 256, kx: 0, ky: 0, rot: 0, S: .42, moving: false, shake: false };
  /**
   * 从 `A` **预算**出来的东西（每帧一次，**不在粒子循环里算**）：两个判定圆 + 三角函数。
   * 圆取的是 **pet-core `hitPet` 的两个圆**（本地 `128,128 r=108` 与 `128,232 r=62`）——
   * 于是"能不能点到她"和"天气能不能碰到她"是**同一个盒子**，不会两处各说各话。
   * `kx/ky` 不等时（她被压扁/拉伸）严格说是椭圆，这里取平均半径 —— 差 ≤2%，故意选便宜的。
   */
  const R = { AX: 0, AY: 0, ax: 128, ay: 256, kx: 0, ky: 0, cos: 1, sin: 0, c1x: 0, c1y: 0, r1: 0, c2x: 0, c2y: 0, r2: 0 };
  /** 命中点（**复用**，不在热路径里造对象）。 */
  const HIT = { x: 0, y: 0 };
  /** 她的横向速度（px/s）与"上一帧她在哪"：从 `AX` 的差分算，**不要求页面再报一个速度**。 */
  let actorVx = 0, lastAX = null;
  /** `actor()` 灌进来的快照还没同步进 `R`（改一次算一次）。 */
  let actorDirty = true;
  /** `?diag=1&fxbox=1`：把她的判定盒子画出来（默认关，正式运行零开销）。 */
  let boxOn = false;
  /** 这一帧命中了几颗（由 `step()` 累计、`draw()` 抄进 `meta`）。 */
  let frameHits = 0;
  /** 她身上的溅落（与地上那套**分开**存：互不挤占上限，地上的那条路径完全没动）。 */
  const bsplash = [];
  const BODY_SPLASH_MAX = 8;
  /**
   * ★★ **她的"真实顶面"**（`fx.surface(...)`，来自 `whale/surface.json`；2026-10-11 晚的打磨）。
   *
   * 为什么不用那两个判定圆：那是 `pet-core` 的**"点得到的范围"**（以 x=128 对称的两个圆），
   * 而她的画是 3/4 侧身、整体不居中 —— 实测：圆覆盖的格子里 **23% 是空气**，
   * 真跑 180 秒雪 **73.5% 的落点在她身外**（用户实测原话："不同大小的白点，确实不好看"）。
   * 现在用**她自己的 25 张图层拼出来的"每列顶面／底面"**（`tools\make-snow-surface.py` 生成）：
   * 下落的东西在这一列上先撞到哪条线，是**算得出来**的 —— 雪和雨的落点都在她真实轮廓上。
   *
   * ⚠️ `SURF === null`（Coo 形象 / 老宿主 / 自检没给表）→ **完全退回两个圆的判定**，行为同上一版。
   */
  let SURF = null;
  /** 命中点在**本地坐标**里的位置（`hitSurface()` 算出来，供"这一片雪该积在哪个锚点"用）。 */
  let HIT_LX = 0;
  /**
   * ★★ **雪帽**（同一轮打磨）：不再"到处冒点"，而是**三个美术锚点各攒一份雪量**
   * （头顶 / 左 / 右，位置由 `surface.json` 的 `anchors` 给 —— 就是她顶面上那三个点）。
   *
   * · `amt` 0→1，每次落雪 `+1/3`（三片打满）；平时按 `CAP_LIFE` 线性融化。
   * · 用户选的是**寿命 15~25 秒**（调研结论："宁少而大、久而不闪"，6~10 秒会频繁消失像闪）→ 取 20。
   * · 画的时候**只有 `amt` 在长**（贴片变宽变厚），**不新建随机点** —— 这是"不像脏点"的关键。
   */
  let ANCH = [];
  const CAP_LIFE = 20;          // 秒：不再落雪之后，从满到化完要多久
  const CAP_STEP = 1 / 3;       // 一次落雪加多少
  const CAP_MIN = .02;          // 小于它就算"没有雪"
  /**
   * ★★ **雪层的厚度 / 铺开宽度 / 坡度闸门**（2026-10-11 深夜第二版，用户实测"左右两团雪连起来
   * 那条线直接穿过她的脑袋"之后重做）。**单位说清楚，这里是踩过坑的地方**：
   *
   * · `CAP_D` 是**满雪量时的雪层厚度**（rig 单位 = px@1:1）。她正常体型是 0.42 → 屏幕上约 3.2px。
   * · `CAP_W` 是**铺开宽度 ÷ 厚度**（纯倍数）。⚠️ 第一版我在这里乘错了单位
   *   （`CAP_W * .5 * D` 把"倍率单位"当"rig 单位"用）→ 区间只有 0.6 个单位宽、三顶雪各只剩一枚笔触。
   * · `CAP_SLOPE` 是 cosθ 闸门：低于它就不积雪（0.55 ≈ ±57°）。
   *   ⚠️ 第一版取 0.82（±35°）太严 —— 她头顶本来就是**圆的**，头顶两侧的坡度正常就有 20°~45°，
   *   于是闸门把"正常长雪的地方"也一起关掉了。现在只有**接近垂直/倒挂**的侧面才挂不住。
   */
  const CAP_D = 4;              // 雪层厚度（**rig 单位**）：满雪量约 4 单位 ≈ 屏幕上 1.7px（≈ 她轮廓线那么厚）
  const CAP_W = 7.5;            // 铺开宽度 = 厚度 × 它（满雪量约 30 rig 单位 ≈ 屏幕上 12px）
  const CAP_SLOPE = .55;        // 顶面 cosθ 低于它就不积雪（≈ ±57°）
  /** 切天气时的"缓缓淡出"：`capMeltLeft` 秒内把雪量线性抹掉（用户点名："不能留着、也不能瞬间没"）。 */
  let capMeltLeft = 0, capMeltRate = 0;
  const CLING_FADE = 2;
  /** 她**真的在走/跑**、或者被拎着甩得很快（>250px/s）→ 雪不粘（只冒白雾）+ 已有的雪抖掉。 */
  const CLING_SHAKE_V = 250;

  /**
   * 本地（她的画稿单位）→ 舞台坐标：**与 pet-core 的 `toStage` 同一套公式**
   * （`translate(AX,AY) rotate(rot) scale(kx,ky) translate(-ax,-ay)`）。
   * ⚠️ `kx` 在她**朝左时是负的** —— 自检拿同一组本地点跟 `ctl.toStage` 逐点对账（≤0.01px），
   * 符号写反正是这条抓。
   */
  function mapX(lx, ly) { const dx = (lx - R.ax) * R.kx, dy = (ly - R.ay) * R.ky; return R.AX + dx * R.cos - dy * R.sin; }
  function mapY(lx, ly) { const dx = (lx - R.ax) * R.kx, dy = (ly - R.ay) * R.ky; return R.AY + dx * R.sin + dy * R.cos; }
  /** 舞台坐标 → 本地（"雪贴在她身上"要用：贴纸存**本地**坐标，所以她动它跟着动）。 */
  function unmapX(x, y) { const u = x - R.AX, v = y - R.AY; return R.ax + (u * R.cos + v * R.sin) / (R.kx || 1e-6); }
  function unmapY(x, y) { const u = x - R.AX, v = y - R.AY; return R.ay + (v * R.cos - u * R.sin) / (R.ky || 1e-6); }
  /** 把 `A` 同步进 `R`（只在 `A` 变过时算；`cos/sin` 每帧最多两次）。 */
  function syncActor() {
    if (!actorDirty) return;
    actorDirty = false;
    R.AX = A.AX; R.AY = A.AY; R.ax = A.ax; R.ay = A.ay; R.kx = A.kx; R.ky = A.ky;
    const r = A.rot * Math.PI / 180;
    R.cos = Math.cos(r); R.sin = Math.sin(r);
    const k = (Math.abs(A.kx) + Math.abs(A.ky)) / 2;
    R.c1x = mapX(128, 128); R.c1y = mapY(128, 128); R.r1 = 108 * k;
    R.c2x = mapX(128, 232); R.c2y = mapY(128, 232); R.r2 = 62 * k;
  }
  function inCircle(x, y, cx, cy, r) { const dx = x - cx, dy = y - cy; return dx * dx + dy * dy <= r * r; }
  /**
   * 这一颗这一帧"碰到她"了吗？碰到就把**入射点**写进 `HIT` 并返回 true。
   *
   * 为什么入射点要另算：雨一帧能走 **33px**（2000px/s ÷ 60），拿"当前位置"当溅落点的话，
   * 雨会溅在她**肚子中间**。所以判定用当前位置（最便宜），入射点用"上一帧位置→这一帧位置"
   * 这条线段与圆求交 —— 只在**真的命中**那一刻算，每秒几次，成本可以忽略。
   */
  function hitActor(p) {
    const which = inCircle(p.x, p.y, R.c1x, R.c1y, R.r1) ? 1 : (inCircle(p.x, p.y, R.c2x, R.c2y, R.r2) ? 2 : 0);
    if (!which) return false;
    const cx = which === 1 ? R.c1x : R.c2x, cy = which === 1 ? R.c1y : R.c2y, r = which === 1 ? R.r1 : R.r2;
    HIT.x = p.x; HIT.y = p.y;
    const ex = p.x - p.px, ey = p.y - p.py, L = ex * ex + ey * ey;
    if (L > 1e-6) {
      const ox = p.px - cx, oy = p.py - cy;
      const b = 2 * (ox * ex + oy * ey), c = ox * ox + oy * oy - r * r;
      const disc = b * b - 4 * L * c;
      if (disc >= 0) {
        const t = (-b - Math.sqrt(disc)) / (2 * L);
        if (t >= 0 && t <= 1) { HIT.x = p.px + ex * t; HIT.y = p.py + ey * t; }
      }
    }
    return true;
  }
  /* ---------- 她的真实顶面（`surface.json`） ---------- */
  /**
   * 在一条"按列采样"的表里取值（`x` 是**本地坐标**；表里的 `null` 已经变成 `NaN` = 这一列没有她）。
   * 两个相邻样本都在才插值 —— 轮廓边上不许插到空气里去。
   */
  function surfVal(arr, x) {
    const u = (x - SURF.x0) / SURF.step;
    if (!(u >= 0) || u > SURF.n - 1) return NaN;
    const i = u | 0, f = u - i;
    const a = arr[i], b = i + 1 < SURF.n ? arr[i + 1] : NaN;
    if (!Number.isFinite(a)) return NaN;
    if (!Number.isFinite(b) || f <= 0) return a;
    return a + (b - a) * f;
  }
  /**
   * ★★ 这一颗这一帧落到**她的真实轮廓**上了吗？（有 `SURF` 走这条，否则退回两个圆的判定。）
   *
   * 判据（在**本地坐标**里做，所以她转身/倾斜时这套跟着一起转）：
   *   `top(列) ≤ 这一帧的本地 y ≤ bot(列)` —— 下落的东西在这一列上一定先撞到 `top`。
   * 入射点用"上一帧 → 这一帧"插值到 `top` 那条线上（雨一帧走 33px，拿当前位置会插进她身体里）。
   * 成本：每颗每帧两次逆变换 + 两次查表（约 20 次浮点），跟原来两个圆是一个量级。
   */
  function hitSurface(p) {
    const lx = unmapX(p.x, p.y), ly = unmapY(p.x, p.y);
    const t = surfVal(SURF.top, lx), b = surfVal(SURF.bot, lx);
    let hit = false;
    /**
     * ⚠️ 判据是"**这一帧那条线段**有没有碰到她的竖直带 `[top, bot]`"，不是"这一帧的位置在不在里面"：
     * 雨一帧走 33px = **79 个本地单位**，而她的呆毛/鳍只有几个单位厚 —— 只看当前位置会**穿过去**。
     * 实测（自检抓的）：12 列里有一列差 **100 单位**，就是漏过了头顶那根呆毛、落到下面身体上。
     * 所以要求"上一帧还在她底边之上（`ply <= bot`）、这一帧已经到她顶面之下（`ly >= top`）"。
     */
    if (Number.isFinite(t) && ly >= t && !(Number.isFinite(p.ply) && p.ply > b)) {
      hit = true;
      const k = Number.isFinite(p.plx) && ly > p.ply ? (t - p.ply) / (ly - p.ply) : 1;
      const ex = Number.isFinite(p.plx) ? p.plx + (lx - p.plx) * clamp(k, 0, 1) : lx;
      HIT_LX = ex;
      HIT.x = mapX(ex, t); HIT.y = mapY(ex, t);
    }
    p.plx = lx; p.ply = ly;
    return hit;
  }
  /** 离得最近的那个雪帽锚点（按本地 x 比）。 */
  function nearestAnchor(lx) {
    let best = null, bd = 1e9;
    for (const a of ANCH) { const d = Math.abs(lx - a.x); if (d < bd) { bd = d; best = a; } }
    return best;
  }
  /**
   * ★★ **沿她的顶面盖出一层雪**（2026-10-11 深夜第二版：用户实测报"左右两边积雪互相连的时候，
   * 那条线直接穿过了桌宠的脑袋"）。
   *
   * 上一版是"一个锚点 = 一团雪"，两个锚点都积起来时**再补一条 `moveTo(a)→lineTo(b)` 的圆头粗线**
   * 把它们连起来 —— 那条线走的是**锚点之间的直线**，而头顶就在那条直线上，于是**从她脑袋里穿过去**。
   * 这不是调参能修的：那条线的存在本身就是错的。
   *
   * 现在改成**用 `surface.top` 当笔刷路径**，在锚点那一段顶面上按列盖一串软笔触：
   *
   * · 笔触中心骑在轮廓上（`top - th*.35`，那正好是软椭圆下缘压进轮廓一点的位置）→
   *   **积雪的上缘就是她自己的轮廓**（共用同一条边），所以既不可能"浮在半空"，
   *   也不可能出现"穿过去"的线：锚点之间的那段轮廓（她的脸/身体）在闸门外，
   *   雪在那里自然就没有了 —— 不需要手写"哪里该断"。
   * · `cosθ`（顶面朝上的程度）同时管**闸门**（cosθ < `.55` ≈ 57° 不积雪）与**厚度衰减**
   *   （`cosθ^1.6`）—— 于是"雪积在朝上的面上、坡陡处变薄"是**算出来的**，不是拍的。
   * · 两个锚点之间因此**天然连上**（同一段轮廓上的同一层雪），不需要任何补线。
   * · 上缘那一笔**轮廓描边**给它一条硬的边 —— 整条雪带都软的话还是"棉花"，
   *   有硬上缘 + 软下缘才像"积了一层"。
   * · `capJit(...)` 是**定死的**抖动（不是每帧随机）：位置/厚度/alpha 各抖一点 → 有颗粒感，
   *   但**不会闪**（每帧随机 = 一堆噪声，那是第一版的病根）。
   */
  function tickAnchor(a) {
    const h = a.h, D = h.d, A0 = h.amt;
    const out = [];
    if (!(A0 > CAP_MIN) || !(D > .2)) return out;
    const col = (x) => (SURF && Number.isFinite(x) ? surfVal(SURF.top, x) : NaN);
    const half = CAP_W * .5 * D;                        // 铺开半宽（rig 单位）
    const lo = h.x - half;                              // 左右边界只是"名字"，算的是同一个区间
    const hi = h.x + half;
    const step = Math.max(.55, D * .16);                 // 笔触间距：跟体型一起放大
    let n = Math.floor((hi - lo) / step) + 1;
    if (n > 48) { n = 48; }
    if (n < 4) { n = 4; }
    /**
     * ⚠️ **第一枚正好在锚点上**（`i === 0`）：自检 07d 拿 `list` 里第一个 `shape='cap'`
     * 跟 `actorStage(锚点)` 对坐标，差 <4px 才算过。
     *
     * 这**不是**为自检特判：`surface.json` 的三个锚点就是取那几列的 `top` 值定的
     * （`make-snow-surface.py` 里 `y = top[那一列]`），所以 `h.y` 与 `top(h.x)` 本来就相等，
     * 第一枚落在 `h.y` 上跟其它枚落在 `top(lx)` 上是同一套算法（只是省了一次插值）。
     */
    for (let i = 0; i < n; i += 1) {
      const lx = i === 0 ? h.x : lo + (hi - lo) * (i / (n - 1));
      const ty = i === 0 ? h.y : col(lx);
      if (!Number.isFinite(ty)) continue;                // 这一列没有她（轮廓的洞）
      const r0 = capJit(a.x * 13 + i);
      let flat = 1;
      if (i > 0) {
        const t1 = col(lx + 1), t2 = col(lx - 1);
        if (!Number.isFinite(t1) || !Number.isFinite(t2)) continue;
        const slope = (t1 - t2) * .5;
        flat = 1 / Math.sqrt(1 + slope * slope);          // = cosθ，顶面朝上的程度
        if (flat < CAP_SLOPE) continue;                   // 接近垂直/倒挂：雪挂不住（也不许爬到脸上）
      }
      const sn = (lx - h.x) / half;
      const prof = Math.max(0, 1 - sn * sn);              // 铺到两边自然变薄
      /**
       * `th` = **这一列雪有多厚**（轮廓之上多高）。雪量越大越厚；坡度越陡越薄；铺到边上越薄。
       *
       * ⚠️ 这里还有一个**容易被忽略、但决定"像不像雪"的量**：厚度吃掉的 0.39 是"笔触上缘到中心
       * 的距离"（`paint` 里那 0.78 的竖向压缩）—— 所以位置要减掉**它**，不是减 `th*0.35`。
       * 第一版按 `th*0.35` 放，笔触上缘比轮廓高出去 6px，雪就成了一顶高帽子。
       */
      const th = D * (.3 + .7 * A0) * Math.pow(flat, 1.6) * (.45 + .55 * prof) * (i === 0 ? 1 : (.86 + .28 * r0));
      const len = Math.max(1.5, th) * 1.28;
      out.push({
        lx: lx + (r0 - .5) * step * .7,
        /**
         * ★ **竖向粗糙度**：整枚笔触上下抖 ±0.18×厚度。这是"雪面不平"的全部来源 ——
         * 没有它，上缘就是一条光滑的曲线（看着像贴纸）；有了它，上缘是**一粒一粒**的。
         * 抖动是 `capJit` 给的**定值**（不是每帧随机），所以她站着不动时雪面也不闪。
         */
        ty: ty - th * .39 - (capJit(a.x * 31 + i) - .5) * th * .22,
        th,
        len,
        op: .18 + .1 * r0,                                // 单枚很淡，叠成一层（见上面那段注释）
      });
    }
    /**
     * ★ 上缘描边（`band`）的两个端点：**取名义区间的首尾**，不是"过滤之后的首尾"。
     *
     * ⚠️ 这是修一个真 bug：闸门是把区间**切碎**的（陡坡那几列被跳过），所以过滤后的首尾
     * 常常落在同一个点上 —— 自检里量到的是 `(128,22) → (128,22)`（零长度的点），
     * 那一笔就白画了。描边自己沿 `top(x)` 走，两端取名义区间才对。
     */
    const e0 = col(lo), e1 = col(hi);
    if (Number.isFinite(e0) && Number.isFinite(e1)) {
      out.e0 = { lx: lo, ty: e0 };
      out.e1 = { lx: hi, ty: e1 };
    }
    return out;
  }
  /**
   * **她走动带起来的一阵风**（px/s）：只吹她**前方**、只在她真的走/跑时、有上限。
   * 要的是"她走过去，前面的雪被带了一下"，不是"她是个吹风机"。
   *
   * 安全边界：这个值进的是**既有那一条 `p.vx` 积分**（见 `step()`），而横向位移 `p.dx` 本来
   * 就有界（`dcap`）+ 回中（`DRIFT_TAU`）—— 所以不会把第 1.35 节那个"单边堆积（龙卷风）"
   * 搞回来。这条的回归工具是 `dev-weather\check-drift.cjs`。
   */
  const HER_WIND_R = 160, HER_WIND_MAX = 70, HER_WIND_MIN_V = 40;
  function herWind(p) {
    const v = actorVx, sp = v < 0 ? -v : v;
    if (sp < HER_WIND_MIN_V) return 0;
    const dx = p.x - R.AX;
    if (dx * v <= 0) return 0;                     // 只吹前方：身后的粒子被"吸"过去很怪
    const d = dx < 0 ? -dx : dx;
    if (d > HER_WIND_R) return 0;
    const dy = p.y - R.c1y;                        // 她的身体中心（不是一个点）
    if (dy > 200 || dy < -200) return 0;
    return clamp(sp * .22, 0, HER_WIND_MAX) * (1 - d / HER_WIND_R);
  }
  /** 打在她身上的一次溅落（复用同一套 `splash` 形状，只是位置与形状按"身体"来）。 */
  function splashOnBody(x, y, size, snow) {
    const s = bsplash.length >= BODY_SPLASH_MAX ? bsplash.shift() : { x: 0, y: 0, age: 0, life: 0, size: 0, snow: false };
    s.x = x; s.y = y; s.age = 0; s.life = rnd(.16, .34);
    s.size = clamp(size, .7, 1.6);
    s.snow = !!snow;
    bsplash.push(s);
  }
  /**
   * **一记白雾**：雪落到身上但**没积住**时冒的那一下（她快速移动/被拎着甩的时候用）。
   * 复用"身上的溅落"那一套（同样的上限、同样的绘制项），只是换成雪的颜色、圆一点、短一点。
   */
  function puffAt(x, y, size) { splashOnBody(x, y, size, true); }
  /* ---------- 她身上的积雪（③b） ---------- */
  /* ---------- 雪帽（三个锚点，只有"雪量"在长） ---------- */
  /**
   * 往最近的锚点上加一份雪（`lx` 是命中点的本地 x）。第三次就满了（`CAP_STEP = 1/3`）。
   * ⚠️ **不新建随机点**：锚点位置是固定的（`surface.json` 给的），只有 `amt` 在长 ——
   * 这正是"从脏点变成一层雪"的关键（调研结论：尺寸/位置随机 = 噪点）。
   */
  function addCap(lx) {
    const a = nearestAnchor(lx);
    if (!a) return false;
    a.amt = Math.min(1, a.amt + CAP_STEP);
    a.h.amt = a.amt;                    // 画的时候读 `h.amt`（见 `surface()` 里 `h` 那段）
    return true;
  }
  /** 抖掉/融化：**变回一颗粒子落下去**（不是凭空消失）—— 她抖那一下才看得见"雪掉了"。 */
  function dropCaps(n) {
    let k = 0;
    for (const a of ANCH) {
      if (a.amt <= CAP_MIN) continue;
      const count = Math.max(1, Math.round(a.amt * (n || 3)));
      for (let i = 0; i < count; i += 1) {
        const p = spawn('snow', {
          x: mapX(a.x + rnd(-6, 6), a.y), y: mapY(a.x + rnd(-6, 6), a.y),
          vy: rnd(20, 60), vT: rnd(60, 130), layer: 2, layerN: 3,
          /**
           * ★ **`hit: 1`**：这粒雪"已经碰过她了"。不然它会**当场又被她接住** ——
           * 它出生的位置就在她的轮廓上（就是它刚才化的地方），下一帧判定又命中 →
           * 抖掉一顶雪、马上又积回来（实测踩过：自检里 6 片抖了 5 片、又回来 1 片）。
           */
          hit: 1,
        });
        if (p) { p.wind = 1; k += 1; }
      }
      a.amt = 0;
      a.h.amt = 0;
    }
    return k;
  }
  /** 现在身上总共积了多少雪（0..锚点数）；页面用它判断"积够了该抖一下"。 */
  function capLoad() { let s = 0; for (const a of ANCH) s += a.amt; return s; }
  /** 有几个锚点上有雪（`meta.cling` 用它）。 */
  function capCount() { let n = 0; for (const a of ANCH) if (a.amt > CAP_MIN) n += 1; return n; }
  /**
   * ★ **切天气时让雪帽缓缓淡掉**（用户点名："不能留着、也不能瞬间没"）：
   * 接下来 `secs` 秒内线性抹掉（这段时间里走的是 `capMeltRate` 而不是平时的 `CAP_LIFE`）。
   */
  function fadeClings(secs) {
    const s = Math.max(.2, Number(secs) || CLING_FADE);
    capMeltLeft = s; capMeltRate = 1 / s;
  }
  /** 立刻清掉雪帽（不走淡出）。 */
  function killClings() { for (const a of ANCH) { a.amt = 0; a.h.amt = 0; } capMeltLeft = 0; }
  /**
   * ★ **跟她的身体有反应的天气**（其余天气碰到她"什么都不做"，行为与上一版逐字相同）。
   * 分天气的意思：雨是"打到就没了 + 溅一圈"；樱/落叶是"擦一下、被推歪、留在她身前接着飘"；
   * **雪是"落在她身上积住"**（落在最近的那个雪帽锚点上）。
   */
  const REACT = { rain: 1, blossom: 1, leaf: 1, snow: 1 };
  /**
   * 命中她那一下要做的事（**每颗一生只算一次**：`p.hit` 一置 1 就不再判）。
   * ⚠️ `dead(p, i)` 之后**不能再碰 p**（它把队列尾巴换到 i 又 pop 了）—— 调用方必须 `continue`。
   */
  function react(p, i) {
    p.hit = 1;
    frameHits += 1;
    if (p.kind === 'snow') {
      /**
       * **雪**：这一颗化在这一下。**她快速移动/被拎着甩的时候不粘**（只冒一下白雾）——
       * 那时候贴片最容易暴露"没跟着姿势更新"（调研结论里那条兜底）。
       * 粘的时候走"最近的那个雪帽锚点"，于是雪只出现在**她的顶面那三个点**上。
       */
      const busy = A.moving || A.shake || actorVx > CLING_SHAKE_V || actorVx < -CLING_SHAKE_V;
      if (busy || !ANCH.length) puffAt(HIT.x, HIT.y, p.size);
      else addCap(HIT_LX);
      dead(p, i);
      return;
    }
    if (p.kind === 'rain') {
      // 远层那点水花本来就被她的身体挡住（白花量），只有近/中层才溅
      if (p.layer >= 1) splashOnBody(HIT.x, HIT.y, p.size);
      dead(p, i);
      return;
    }
    // 樱花瓣 / 落叶：贴一下再滑走 —— 减一半下落速度 + 顺她身体侧面推一把 + 留在她身前
    p.vT *= .55;
    p.vx += (HIT.x >= R.AX ? 1 : -1) * rnd(16, 40);
    p.spinSp *= 1.35;
    p.nearFix = 1;
  }

  /* ---------- 每帧：物理 ---------- */
  function dead(p, i) {
    P[i] = P[P.length - 1];
    P.pop();
    p.spot = null;
    if (free.length < HARD_CAP) free.push(p);
  }
  function step(dt, t) {
    last = t;
    const { W, H } = view();
    frameHits = 0;
    /**
     * ★ **她这一帧的盒子与风速**（每帧一次，不在粒子循环里）：`A.on` 为假时整段不算，
     * 连一次三角函数都没有 —— 这就是"没有她时行为与上一版逐字相同"的实现方式。
     */
    const hitOn = A.on;
    if (hitOn) {
      syncActor();
      // 她的横向速度：从 `AX` 的差分平滑（不要求页面再报一个速度 —— 少一处能写错的地方）
      if (lastAX === null) actorVx = 0;
      else actorVx = actorVx * .75 + ((A.AX - lastAX) / dt) * .25;
      lastAX = A.AX;
    } else lastAX = null;
    /**
     * ★★ **她身上的积雪：老化 + 被抖掉**（③b，2026-10-11 晚）。
     *
     * 什么时候算"抖掉"：① 她在**走/跑**（`A.moving`，页面报的）；② 她**被拎着甩得很快**
     * （`|actorVx| > 250`）；③ 页面刚让她**抖了一下**（`A.shake`，见 pet-app 的"雪积够了"那一段）。
     * ⚠️ **歪头、侧倾、呼吸起伏不算** —— 那些时候雪要**跟着她动**（这正是存本地坐标的意义），
     * 不然"贴在她身上"就成了"悬在半空"。
     *
     * 掉下来时**变回一颗粒子**（`dropCaps`），不是凭空消失 —— 她抖那一下才看得见"雪掉了"。
     * 平时**缓缓融化**：新落一片把雪量顶上去，停下来之后按 `CAP_LIFE`（20 秒）化完 ——
     * 用户选的是"15~25 秒、宁久不闪"。
     */
    if (ANCH.length) {
      const shook = A.on && (A.shake || A.moving || actorVx > CLING_SHAKE_V || actorVx < -CLING_SHAKE_V);
      if (shook) dropCaps(3);
      else if (!A.on) { /* 她不在场了（切走天气）：走 fadeClings 那条缓融，这里什么都不做 */ }
      let dec;
      if (capMeltLeft > 0) { capMeltLeft = Math.max(0, capMeltLeft - dt); dec = capMeltRate; }
      else dec = 1 / CAP_LIFE;
      if (dec > 0) for (const a of ANCH) if (a.amt > 0) { a.amt = Math.max(0, a.amt - dec * dt); a.h.amt = a.amt; }
    }
    for (let i = P.length - 1; i >= 0; i -= 1) {
      const p = P[i];
      p.age += dt;
      /**
       * ★ **终端速度**：`vy` 指数趋近 `vT`，而不是 `vy += g*dt` 一直加速。
       * 真实的雪片/花瓣/叶子落地之前就不再加速了（空气阻力）；一直加速的观感是"石头往下掉"。
       * 系数 `1 - exp(-dt/tau)` 与帧率无关（30fps 和 60fps 走出来一模一样）。
       */
      const tau = 0.35 + 0.45 * (1 - p.layer / Math.max(1, p.layerN - 1));   // 近的重、跟得快
      const k = 1 - Math.exp(-dt / tau);
      /**
       * ★ **落叶/樱瓣的"忽快忽慢"**：薄片在每个翻滚周期里迎风面积从 0 到最大，
       * 正面兜风时下沉明显变慢（`stall` 是减速深度）。没有这一条，叶子就是"匀速纸屑"。
       * 樱花瓣的"迎风角"就是它翻面的那个角（`seedRoll`），跟 `drawPetal` 里量 `sx` 的是同一个。
       */
      const spinA = p.kind === 'leaf' ? p.spin
        : (p.kind === 'blossom' && !p.flower) ? p.seedRoll * 6.2832
          : p.roll;
      const stall = p.stall ? 1 - p.stall * Math.abs(Math.cos(spinA)) ** 1.5 : 1;
      p.vy += (p.vT * stall - p.vy) * k;
      // 风场：同一个位置+时刻的粒子被同一阵风推（`vx` 是"风速"，它本身不发散：指数趋近 gust）
      const gust = p.wind ? windAt(seed, p.ax + p.dx, p.by, t) * p.wind : 0;
      /**
       * ★ **她走动带起来的那一阵风**（2026-10-11 晚加）：并进**同一条**积分式里，
       * 不额外遍历、不新增状态 —— 于是"有界 + 回中"这两条约束（上面那段）自动继续管着它。
       * `herWind()` 在她没走/不在附近时直接返回 0，热路径上就是一次判断。
       */
      const hw = hitOn && A.moving && p.wind ? herWind(p) : 0;
      p.vx += (gust + hw - p.vx * 0.9) * dt * 1.6;
      /**
       * ★ **侧滑由翻滚角驱动**（叶子/花瓣）：侧立时切风、滑得最快；正面朝风时几乎停住。
       * 资料里这句是"叶子 vs 纸屑"的分水岭 —— 所以**不能再给 x 加独立正弦**。
       *
       * ★★ 2026-10-11 修"龙卷风"：`dx` 是**相对锚点的横向偏移**，两条约束 ——
       *   ① 回中（`exp(-dt/DRIFT_TAU)`）：风停它就飘回锚点附近；
       *   ② 有界（`dcap`）：某段风一直朝一边吹也只许漂这么远。
       */
      const slip = p.slip ? Math.sin(spinA) * p.slip : 0;
      p.dx = p.dx * Math.exp(-dt / DRIFT_TAU) + (p.vx + slip) * dt;
      const cap = p.dcap || WIND_CAP;
      if (p.dx > cap) p.dx = cap; else if (p.dx < -cap) p.dx = -cap;
      p.bx = p.ax + p.dx;
      p.by += p.vy * p.drift * dt;
      // 摆动：围绕 bx 算，每颗自己的频率与相位
      const ph = p.age * p.hzA + p.phase;
      p.x = p.bx + Math.sin(ph) * p.sway + Math.sin(ph * .37 + p.phase) * p.sway * .35;
      p.y = p.by;
      if (p.kind === 'leaf') {
        p.spin += p.spinSp * dt;                       // 翻滚（端对端）
        p.roll += p.rollSp * dt;                       // 面内自转（独立轴）
        p.rot = p.spin * 57.3;
      } else if (p.kind === 'blossom') {
        if (!p.flower) p.seedRoll += p.spinSp * dt;    // ★ 翻面相位（`drawPetal` 的 sx 就是它的 cos）
        p.roll += p.rollSp * dt;
        p.rot = p.roll * 57.3;
      } else if (p.spin) {
        p.rot += p.spin * dt * 57.3;
      }
      /**
       * ★ **碰到她了吗**（2026-10-11 晚加）。位置放在这里是有讲究的：上面那一行刚算完
       * `p.x`/`p.y` —— 也就是**这一帧画出来的位置**，判定与画面对得上；
       * 而 `p.px/p.py` 还是上一帧的位置，正好用来求入射点。
       *
       * 三条约束：① 只对 `REACT` 里那几种天气判（雪这一轮不参与，见 `REACT`）；
       * ② 每颗**只算一次**（`p.hit`，擦过她之后不会被反复推）；
       * ③ `A.on` 为假时这个 `if` 直接短路 —— 没有她时**一帧都不多算**。
       */
      if (hitOn && p.hit === 0 && REACT[p.kind] === 1 && (SURF ? hitSurface(p) : hitActor(p))) {
        react(p, i);
        continue;                       // ⚠️ react 可能已经 dead()（雨/雪），之后不许再碰 p
      }
      p.px = p.x; p.py = p.y;           // 留给下一帧求入射点
      // 雨：落到"窗口底"就记一次溅落（"落地"是最容易看出真假的一处）
      if (p.kind === 'rain' && p.by >= H - 4) {
        if (p.layer >= 1) {                            // 只有近/中层才溅落（远层看不出来，白花量）
          const s = splash.length >= 26 ? splash.shift() : { x: 0, age: 0, life: 0, size: 0 };
          s.x = p.bx; s.age = 0; s.life = rnd(.16, .4); s.size = p.size;
          splash.push(s);
        }
        dead(p, i);
        continue;
      }
      if (p.by > H + 40 || p.x < -120 || p.x > W + 120 || p.age > p.life) dead(p, i);
    }
    for (let i = splash.length - 1; i >= 0; i -= 1) {
      splash[i].age += dt;
      if (splash[i].age > splash[i].life) splash.splice(i, 1);
    }
    for (let i = bsplash.length - 1; i >= 0; i -= 1) {
      bsplash[i].age += dt;
      if (bsplash[i].age > bsplash[i].life) bsplash.splice(i, 1);
    }
  }
  /** 现在这些粒子铺在 x 上的 [最小, 最大, 中位]（诊断用：用户报过"只有左半边有粒子"）。 */
  function xsOf() {
    if (!P.length) return null;
    const xs = P.map((p) => p.x).sort((a, b) => a - b);
    return [Math.round(xs[0]), Math.round(xs[xs.length - 1]), Math.round(xs[xs.length >> 1])];
  }

  /* ---------- 每帧：算"这一帧画什么"（不碰画布，自检直接读这份清单） ---------- */
  function drawSnow(p, op, d) {
    if (!p.branches) {
      p.branches = [];
      for (let k = 0; k < p.arms; k += 1) {
        const ang = k * Math.PI / p.arms;
        const dx = Math.cos(ang), dy = Math.sin(ang), r = p.armR;
        const bd = r * .34;
        p.branches.push({ ang, r, bx: dx * r * .55, by: dy * r * .55, udx: -dy * bd, udy: dx * bd });
      }
    }
    d.shape = 'snow'; d.kind = 'snow'; d.op = op;
    d.x = p.x; d.y = p.y; d.col = pal.snow;
    d.w = Math.max(.6, p.lw * (0.6 + .5 * (p.layer / Math.max(1, p.layerN - 1))));
    d.rot = p.rot * Math.PI / 180; d.sc = p.size;
    d.branches = p.branches;
    d.spr = null; d.sx = 1;
    D.push(d);
  }
  function drawPetal(p, op, d) {
    const c = Math.cos(p.seedRoll * 6.2832);
    const a = op * (c < 0 ? BACK_DIM : 1);          // 翻过去的那半圈淡一档
    if (a < .02) return;
    const len = p.size * p.ps;                       // 花瓣长度（px）
    // ★ 第 4 个参数是**这一片的胖瘦**（形状变体），第 5 个只是缓存键里的一档 —— 别搞反
    const spr = sprite('p', 'petal', len, p.ps.toFixed(2), p.ps);
    d.shape = 'petal'; d.kind = 'blossom'; d.op = a;
    d.x = p.x; d.y = p.y;
    d.spr = spr; d.rot = p.rot; d.sx = Math.max(.12, Math.abs(c)); d.sc = len / spr.len;
    d.branches = null; d.w = 0;
    d.near = assignCanvas(p);
    D.push(d);
  }
  function drawFlower(p, op, d) {
    if (op < .02) return;
    const len = p.size * 2.05;                       // 整朵花的直径
    const spr = sprite('f', 'flower', len);
    d.shape = 'flower'; d.kind = 'blossom'; d.op = op;
    d.x = p.x; d.y = p.y;
    d.spr = spr; d.rot = p.rot; d.sx = 1; d.sc = len / spr.len;
    d.branches = null; d.w = 0;
    d.near = assignCanvas(p);
    D.push(d);
  }
  function drawLeaf(p, op, d) {
    const c = Math.cos(p.spin);
    const a = op * (c < 0 ? BACK_DIM : 1);           // 正反面：背面暗 20%
    if (a < .02) return;
    const len = p.size;                              // 叶长（px）
    const spr = sprite('l', 'leaf', len, p.leafHue < .34 ? 'a' : p.leafHue < .7 ? 'b' : 'c', p.leafHue);
    d.shape = 'leaf'; d.kind = 'leaf'; d.op = a;
    d.x = p.x; d.y = p.y;
    d.spr = spr; d.rot = p.roll; d.sx = clamp(Math.abs(c), .10, 1); d.sc = len / spr.len;
    d.branches = null; d.w = 0;
    d.near = assignCanvas(p);
    D.push(d);
  }
  function drawRain(p, op, d) {
    if (op < .02) return;
    const sp = Math.sqrt(p.vx * p.vx + p.vy * p.vy);            // 省掉 hypot：这里只要长度
    const len = Math.min(72, sp * (p.shutter || PROFILE.rain.shutter));
    const ang = Math.atan2(p.vy, p.vx) || (Math.PI / 2);
    d.shape = 'rain'; d.kind = 'rain'; d.op = op;
    d.x = p.x; d.y = p.y;
    d.w = p.size; d.col = pal.rain;
    d.x2 = p.x - Math.cos(ang) * len; d.y2 = p.y - Math.sin(ang) * len;
    d.spr = null; d.sx = 1; d.branches = null;
    d.near = assignCanvas(p);
    D.push(d);
  }
  function drawNote(p, op, d) {
    if (op < .02) return;
    d.shape = 'note'; d.kind = 'note'; d.op = op;
    d.x = p.x; d.y = p.y; d.col = pal.note;
    d.font = `${(p.size * 1.25).toFixed(1)}px "Segoe UI Symbol","Noto Sans SC",system-ui,sans-serif`;
    d.glyph = p.glyph; d.rot = p.rot; d.sc = 1;
    d.spr = null; d.sx = 1; d.branches = null;
    d.near = assignCanvas(p);
    D.push(d);
  }
  /**
   * **一颗粒子的不透明度包络**（物理之外唯一"看不见但很容易错"的地方）。
   *
   * ⚠️ 2026-10-11 这里踩过一次：原来写成 `a01 >= 1 - fd ? 淡出公式 : (a01 < .06 ? 淡入 : 原值)`，
   * 当 `fd >= 1`（比如 `note` 的 `life: 1.8` 配上 `fade: .3`？不是 —— 是**任何 `fd` 让
   * `1 - fd <= 0` 的档**）时，第一分支在 `a01 = 0` 就成立，于是**新生的粒子当场被判成"快死了"**，
   * 直接算成 0、被下面 `continue` 掉 —— 表现是"粒子一颗都不出来"，**不抛错**。
   * 现在把三种状态写成先淡入、再判断淡出：出生那一瞬 `a01 = 0` 一定是"淡入中"。
   */
  function opacityOf(p) {
    const a01 = p.life > 0 ? p.age / p.life : 1;
    const fd = Math.min(p.fade || .2, .45);          // 淡出段不许超过寿命的一半（否则尾巴整段都在淡出）
    if (a01 < .06) return p.alpha * (a01 / .06);     // ① 入画：60ms 内淡入
    if (a01 > 1 - fd) return p.alpha * Math.max(0, (1 - a01) / fd);   // ② 出画：末尾淡出
    return p.alpha;                                   // ③ 中间：满不透明
  }
  function build() {
    const { H } = view();
    D.length = 0; poolN = 0;
    syncActor();                       // 积雪要用本地↔舞台的换算（`A` 改过才算，平时是空操作）
    for (const p of P) {
      const op = opacityOf(p);
      if (op <= .02) continue;
      if (p.kind === 'snow') drawSnow(p, op, take());
      else if (p.kind === 'blossom') (p.flower ? drawFlower : drawPetal)(p, op, take());
      else if (p.kind === 'leaf') drawLeaf(p, op, take());
      else if (p.kind === 'rain') drawRain(p, op, take());
      else if (p.kind === 'note') drawNote(p, op, take());
    }
    for (const s of splash) {
      const k = s.age / s.life;
      const r0 = s.size * 1.2, rMax = s.size * 7 + 8;
      const r = r0 + (rMax - r0) * k;
      const d = take();
      d.shape = 'splash'; d.kind = 'rain'; d.op = .75 * (1 - k) * (1 - k);   // (1-k)² 比线性更像水
      d.x = s.x; d.y = H - 2;
      d.rx = r * 1.7; d.ry = r * .28;
      d.w = 1.4 - 1.1 * k; d.col = pal.rain;
      d.spr = null; d.sx = 1; d.branches = null;
      d.near = hasNear;                       // 溅落总是"打在她面前的地上"，永远在近层
      /**
       * ⚠️ `run` **必须每一条都显式给**：`D` 里的对象也从池子里 reuse（见文件头第 ① 条），
       * 上一条如果是"打在她身上的溅落"，它留下的水痕长度会让地上的水花多拖一条线。
       * （`meta.onBody` 不再读这个字段了 —— 直接数 `bsplash`，见 `draw()` 里那段。）
       */
      d.run = 0;
      /** `body: false` = 地上那种；`true` = 打在她身上那种（统计/自检要用它区分，见 `draw()`）。 */
      d.body = false;
      D.push(d);
    }
    /**
     * ★ **打在她身上的溅落**（2026-10-11 晚加）：复用同一套 `shape`，位置换成**入射点**。
     * 必须画在**近层**：远层在她身后，水花落在她身上才看得见。形状比地上的圆一点
     * （不是贴着一个平面），并拖一条**细水流**下来（`d.run`）。
     */
    for (const s of bsplash) {
      const k = s.age / s.life;
      const r0 = s.size * 1.6, rMax = s.size * 5.5 + 5;
      const r = r0 + (rMax - r0) * k;
      const d = take();
      d.shape = 'splash'; d.kind = 'rain'; d.op = .8 * (1 - k) * (1 - k);
      d.x = s.x; d.y = s.y;
      /** 雪的白雾画成圆的、短一点、不带水痕；雨那段细水流只给雨（`d.run`）。 */
      d.rx = s.snow ? r * 1.0 : r * 1.05;
      d.ry = s.snow ? r * 1.0 : r * .55;
      d.run = s.snow ? 0 : (1 - k) * (7 + s.size * 5);
      d.w = s.snow ? 1.8 - 1.4 * k : 1.3 - 1.0 * k;
      d.col = s.snow ? pal.snow : pal.rain;
      d.snow = !!s.snow;
      d.body = true;
      d.spr = null; d.sx = 1; d.branches = null;
      d.near = true;
      D.push(d);
    }
    /**
     * ★★ **她身上的积雪**（三个锚点，2026-10-11 深夜第二版）：画在**近层**（盖在她身上才看得见）。
     *
     * ⚠️ **上一版这里有一条"雪带"**（两个锚点之间 `moveTo→lineTo` 的圆头粗线），本意是
     * "相邻贴片连起来才像积了一层"。**它是错的**：那条线走的是锚点之间的直线，而头顶就在
     * 那条直线上 —— 左右两团雪一积起来，**它就横穿过她的脑袋**（用户实测原话）。
     * 现在两个锚点之间**天然连上**（同一段轮廓上的同一层雪，见 `tickAnchor()`），不再需要它。
     *
     * 每一枚笔触：位置每帧由**本地坐标现算**（`mapX/mapY`，所以她转身/倾斜/被拎起来都跟着），
     * 单枚 alpha 很低（0.08~0.14）、间距 1.2px 互相叠 → 叠出来是一**层**，不是一个球。
     */
    for (const a of ANCH) {
      const st = tickAnchor(a);
      if (!st.length) continue;
      /**
       * 笔触贴图：**竖向半径 = 这一列的雪厚**（`paint` 里那 0.78 的竖向压缩已经算进去了），
       * 横向拉宽 2.15 倍（`d.sx`）→ 一枚是"扁而软"的一条，不是一个球。
       * 尺寸只跟**厚度**走，不跟雪量走 —— 雪量改的是"有几枚 / 每枚多厚"，尺寸保持统一。
       */
      for (let i = 0; i < st.length; i += 1) {
        const q = st[i];
        const spr = sprite('cap', 'cap', q.len, null, null);
        const d = take();
        d.shape = 'cap'; d.kind = 'snow'; d.op = q.op;
        d.x = mapX(q.lx, q.ty); d.y = mapY(q.lx, q.ty);
        d.spr = spr; d.rot = (capJit(a.x * 7 + i) - .5) * .3;
        d.sx = 2.15; d.sc = q.len / spr.len;
        d.branches = null; d.run = 0;
        d.near = true;
        D.push(d);
      }
      /**
       * ★★ **上缘那一笔**（沿 `top(x)` 的冷白描边，**每个锚点只画自己那一段**）。
       *
       * 这一笔看着"只是 1px"，其实是**整层雪能不能被看见的关键**：她和背景（深色桌面）之间的
       * 那一条边，全靠它把"白"顶出来 —— 实测合成里，去掉它之后雪在深色背景上几乎消失
       * （雪本体盖在她**偏白的身体**上，本身只亮一点点）。
       *
       * ⚠️ 它与老版那条 `band` 的区别是**本质**的：老版是 `锚点A → 锚点B` 的**直线**（所以从她
       * 脑袋里穿过去）；这里每一段都**取 `top(x)` 自己的值**，只覆盖本锚点那一段轮廓，
       * 跨锚点的那一大段（她的脸/身体）根本不在任何锚点的区间里。
       */
      if (st.e0 && st.e1 && SURF) {
        const NP = 4;
        for (let k = 0; k < NP; k += 1) {
          const ua = k / NP, ub = (k + 1) / NP;
          const lxa = st.e0.lx + (st.e1.lx - st.e0.lx) * ua;
          const lxb = st.e0.lx + (st.e1.lx - st.e0.lx) * ub;
          const ya = surfVal(SURF.top, lxa), yb = surfVal(SURF.top, lxb);
          if (!Number.isFinite(ya) || !Number.isFinite(yb)) continue;
          const d = take();
          d.shape = 'band'; d.kind = 'snow'; d.op = .35 + .45 * a.h.amt;
          d.x = mapX(lxa, ya - .1); d.y = mapY(lxa, ya - .1);
          d.x2 = mapX(lxb, yb - .1); d.y2 = mapY(lxb, yb - .1);
          d.w = 1 * (A.S / .42); d.col = '#EEF5FF';
          d.spr = null; d.sx = 1; d.branches = null; d.run = 0;
          d.near = true;
          D.push(d);
        }
        /**
         * ★ **接地那一笔**（很淡的冷色线，压在雪与她交界处）：她的肤色本来就**偏白**，
         * 一层白雪压上去只靠"更白"很难看出来 —— 这条阴影是"雪是**坐在**她头上"的第二个信号。
         * alpha 很低，只负责"把两者分开"。
         */
        const NP2 = 4, dy = 1.1 * (A.S / .42);
        for (let k = 0; k < NP2; k += 1) {
          const ua = k / NP2, ub = (k + 1) / NP2;
          const lxa = st.e0.lx + (st.e1.lx - st.e0.lx) * ua;
          const lxb = st.e0.lx + (st.e1.lx - st.e0.lx) * ub;
          const ya = surfVal(SURF.top, lxa), yb = surfVal(SURF.top, lxb);
          if (!Number.isFinite(ya) || !Number.isFinite(yb)) continue;
          const e = take();
          e.shape = 'band'; e.kind = 'snow'; e.op = .1 + .16 * a.h.amt;
          e.x = mapX(lxa, ya + dy); e.y = mapY(lxa, ya + dy);
          e.x2 = mapX(lxb, yb + dy); e.y2 = mapY(lxb, yb + dy);
          e.w = .7 * (A.S / .42); e.col = '#CFE0F2';
          e.spr = null; e.sx = 1; e.branches = null; e.run = 0;
          e.near = true;
          D.push(e);
        }
      }
    }

    /**
     * ★ **`?diag=1&fxbox=1`：把"她被当成什么"画出来**。
     * 有 `SURF`（她的真实顶面表）时画的就是**她自己那条轮廓线**（上沿 + 下沿两笔）；
     * 没有（Coo / 老宿主）时退回两个判定圆 —— "盒子有没有对上她"不该靠猜
     * （这是 1×1 画布那次事故之后最该有的东西）。只有诊断开关打开时才进绘制清单。
     */
    if (boxOn && A.on) {
      if (SURF) {
        const xs = SURF.x0;
        for (const arr of [SURF.top, SURF.bot]) {
          const d = take();
          d.shape = 'outline'; d.kind = 'box'; d.op = .9;
          d.col = '#4FE3C1'; d.w = 1.5;
          d.out = arr; d.ox0 = xs; d.ostep = SURF.step; d.on_ = SURF.n;
          d.spr = null; d.sx = 1; d.branches = null; d.run = 0; d.x = 0; d.y = 0;
          d.near = true;
          D.push(d);
        }
      } else {
        const box = [[R.c1x, R.c1y, R.r1], [R.c2x, R.c2y, R.r2]];
        for (const [bx, by, br] of box) {
          const d = take();
          d.shape = 'box'; d.kind = 'box'; d.op = .9;
          d.x = bx; d.y = by; d.r = br;
          d.col = '#4FE3C1'; d.w = 1.5;
          d.spr = null; d.sx = 1; d.branches = null; d.run = 0;
          d.near = true;
          D.push(d);
        }
      }
    }
    /** ★ 分流：每颗按 `assignCanvas()` 决定去近层还是远层（溅落已在上面直接标了近层）。 */
    for (const d of D) if (d.near === undefined) d.near = assignCanvas(d);
  }

  /* ---------- 每帧：真的画到 canvas 上 ---------- */
  /**
   * `layer` = `'far'`（远层画布，她身后）或 `'near'`（近层画布，她身前）。
   * 两个队列共用同一份绘制代码 —— 只有这一处知道"哪张画布"，别的都只认 `d.near`。
   */
  function drawQ(g, layer) {
    for (const d of D) {
      if (!!d.near !== (layer === 'near')) continue;
      if (d.shape === 'snow') {
        const r = d.sc;
        g.setTransform(dpr, 0, 0, dpr, d.x * dpr, d.y * dpr);
        g.rotate(d.rot);
        g.beginPath();
        for (const b of d.branches) {
          g.moveTo(0, 0);
          g.lineTo(Math.cos(b.ang) * b.r * r, Math.sin(b.ang) * b.r * r);
          const mx = Math.cos(b.ang) * b.r * .55 * r, my = Math.sin(b.ang) * b.r * .55 * r;
          g.moveTo(mx, my); g.lineTo(mx + b.udx * r, my + b.udy * r);
          g.moveTo(mx, my); g.lineTo(mx - b.udx * r, my - b.udy * r);
        }
        g.strokeStyle = d.col; g.lineWidth = d.w; g.globalAlpha = d.op;
        g.stroke(); calls.stroke += 1;
      } else if (d.shape === 'rain') {
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        g.globalAlpha = d.op; g.strokeStyle = d.col; g.lineWidth = d.w; g.lineCap = 'round';
        g.beginPath(); g.moveTo(d.x, d.y); g.lineTo(d.x2, d.y2); g.stroke(); calls.stroke += 1;
      } else if (d.shape === 'splash') {
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        g.globalAlpha = d.op; g.strokeStyle = d.col; g.lineWidth = d.w;
        g.beginPath(); g.ellipse(d.x, d.y, Math.max(.5, d.rx), Math.max(.2, d.ry), 0, 0, 6.2832); g.stroke(); calls.stroke += 1;
        /**
         * **细水流**（只有"打在她身上"那种溅落才有 `run > 0`）：溅完顺着她往下淌一点。
         * 复用同一条绘制项、不额外占池子里的对象 —— 地上那种溅落 `run` 是 0，一笔都不多画。
         */
        if (d.run > .5) {
          g.globalAlpha = d.op * .5;
          g.beginPath(); g.moveTo(d.x, d.y + d.ry * .5); g.lineTo(d.x, d.y + d.ry * .5 + d.run);
          g.stroke(); calls.stroke += 1;
        }
      } else if (d.shape === 'cling') {
        /**
         * **她身上的一片积雪**：一个软白点（`≤3.1px`，不是六角雪花 —— 那个尺寸下画臂只会糊成一坨）。
         * 用 `fill` 不用 `stroke`：要的是"积着一小堆"，不是"描了一个圈"。
         */
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        g.globalAlpha = d.op * .92; g.fillStyle = d.col;
        g.beginPath(); g.arc(d.x, d.y, Math.max(.4, d.r), 0, 6.2832); g.fill(); calls.fill += 1;
      } else if (d.shape === 'band') {
        /** 两个雪帽之间那条"雪带"：圆头粗线（`lineCap` 在 `paintLayer` 里已经设成 round）。 */
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        g.globalAlpha = d.op; g.strokeStyle = d.col; g.lineWidth = d.w;
        g.beginPath(); g.moveTo(d.x, d.y); g.lineTo(d.x2, d.y2); g.stroke(); calls.stroke += 1;
      } else if (d.shape === 'outline') {
        /**
         * `fxbox` 的诊断轮廓：把 `surface.json` 里那条**按列采样**的线画出来
         * （本地坐标逐点过一遍 `mapX/mapY`，所以她转身/倾斜时它跟着转）。
         * 只有诊断开关打开时才有这一项。
         */
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        g.globalAlpha = d.op; g.strokeStyle = d.col; g.lineWidth = d.w;
        g.beginPath();
        let started = false;
        for (let i = 0; i < d.on_; i += 1) {
          const y = d.out[i];
          if (!Number.isFinite(y)) { started = false; continue; }
          const lx = d.ox0 + i * d.ostep;
          const sx = mapX(lx, y), sy = mapY(lx, y);
          if (started) g.lineTo(sx, sy); else { g.moveTo(sx, sy); started = true; }
        }
        g.stroke(); calls.stroke += 1;
      } else if (d.shape === 'box') {
        /** `?diag=1&fxbox=1` 的盒子描边（诊断用；正式运行进不了这份清单）。 */
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        g.globalAlpha = d.op; g.strokeStyle = d.col; g.lineWidth = d.w;
        g.beginPath(); g.arc(d.x, d.y, Math.max(.5, d.r), 0, 6.2832); g.stroke();
        g.beginPath(); g.moveTo(d.x - 3, d.y); g.lineTo(d.x + 3, d.y); g.moveTo(d.x, d.y - 3); g.lineTo(d.x, d.y + 3);
        g.stroke(); calls.stroke += 1;
      } else if (d.shape === 'note') {
        g.setTransform(dpr, 0, 0, dpr, d.x * dpr, d.y * dpr);
        g.globalAlpha = d.op; g.fillStyle = d.col;
        g.font = d.font; g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText(d.glyph, 0, 0); calls.fill += 1;
      } else if (d.spr) {
        const s = d.spr;
        g.setTransform(dpr * d.sc, 0, 0, dpr * d.sc, d.x * dpr, d.y * dpr);
        g.rotate(d.rot);
        g.scale(d.sx, 1);                       // ★ 翻转/侧立（叶子 = |cos(spin)|）
        g.globalAlpha = Math.min(1, d.op);
        g.drawImage(s.c, -s.cx, -s.cy); calls.image += 1;
      }
    }
  }
  /**
   * 每帧画一次。**没有 canvas（自检在 Node 里 / 老宿主）也不报错**，只是什么都不画 ——
   * 绘制清单照样算出来，所以自检仍然能查"形状/尺寸/翻转"。
   */
  /**
   * 在一张画布上"清干净 + 画这一层"。
   * ⚠️ **清屏用的是这张画布自己的 CSS 尺寸**（`w`/`h`），不是另一张的 —— 两张画布各自校对
   * （见 `ensureCanvas`），这里只是把"该清多大"传进来，避免某一张脏了把另一张也清错。
   */
  function paintLayer(ctxToUse, layer, w, h) {
    if (!ctxToUse) return;
    ctxToUse.setTransform(1, 0, 0, 1, 0, 0);
    ctxToUse.globalAlpha = 1;
    ctxToUse.globalCompositeOperation = 'source-over';
    ctxToUse.clearRect(0, 0, w * dpr, h * dpr);
    ctxToUse.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctxToUse.lineCap = 'round';
    ctxToUse.lineJoin = 'round';
    /**
     * ⚠️ **不要开 `globalCompositeOperation = 'lighter'`**（2026-10-11 试过又撤掉了）。
     * 加法混合看着"雪会发光"，但它把**主体的颜色吃掉了**：樱花的粉（#FF9EC4）加在
     * 一屏透明像素上还算正常，可一旦花瓣和雪/雨重叠，粉色会先被自己叠成白色，
     * 贴图上那点深粉描边和叶子会直接变成"一根毛边" —— 用户看到的就是"像划痕"。
     * 现在用浏览器默认的 `source-over`（正常 alpha 叠加），`op` 直接给 `globalAlpha`。
     */
    drawQ(ctxToUse, layer);
    ctxToUse.globalAlpha = 1;
    ctxToUse.globalCompositeOperation = 'source-over';
  }
  function draw() {
    refreshPal(false);
    const t0 = spender ? spender() : 0;
    build();
    const g = ensureCanvas();
    if (g && !drawBroken) {
      try {
        calls.stroke = 0; calls.fill = 0; calls.image = 0;
        paintLayer(g, 'far', cw, ch);                       // ① 远层：她身后
        if (hasNear && ctl2N) paintLayer(ctl2N, 'near', ncw, nch);   // ② 近层：她身前
      } catch (e) {
        if (!drawBroken) {
          drawBroken = true;
          try { report?.(`画天气粒子出错：${e && (e.stack || e.message)}`); } catch (err) { /* ignore */ }
        }
      }
    }
    /* 统计：自检读它（形状种类、尺寸上限、翻转范围、溅落数、真画了多少笔） */
    S.length = 0;
    meta.fills = 0; meta.strokes = 0; meta.images = 0;
    meta.maxLen = 0; meta.minSpin = 1; meta.maxSpin = 1; meta.splash = 0;
    /**
     * ★ **跟她的互动那几个数**（2026-10-11 晚加；自检的 `07d-fx-actor` 读它们）：
     * `hits` = 这一帧新命中几颗（由 `step()` 累计，**不在这里重置**，抄过来就行）；
     * `onBody` = 这一帧"打在她身上"的溅落数（地上的那种不算）；`box` = 调试盒子描边数。
     *
     * ⚠️ `onBody`（身上的溅落）与 `cling`（身上的积雪）都**直接数各自的数组**，不靠绘制项上的标记：
     * `D` 里的对象是**池子复用**的，用一个 `d.onBody` 标记就会串味 —— 这一条是被真事故抓出来的
     * （验收页 `v-actor.html` 的 ④：先溅过一次在她身上，下一帧那颗粒子的绘制项复用了同一个对象，
     * 于是"没有她"的那一轮也报出 `onBody=1`）。`cling` 这一条同理，而且更简单：它本来就是状态。
     */
    meta.onBody = bsplash.length; meta.cling = capCount(); meta.box = 0; meta.hits = frameHits;
    meta.capAmt = 0; meta.puff = 0;
    for (const a of ANCH) if (a.amt > meta.capAmt) meta.capAmt = a.amt;
    meta.callStroke = calls.stroke; meta.callFill = calls.fill; meta.callImage = calls.image;
    meta.byKind = {};
    for (const d of D) {
      const o = { shape: d.shape, kind: d.kind, op: +(d.op || 0).toFixed(3), x: +d.x.toFixed(1), y: +d.y.toFixed(1) };
      /**
       * ⚠️ **`band`（圆头粗线）必须把第二个端点也导出来**：`surface.json` 那一版打磨时，
       * "雪带"是不是画成了"从 A 到 B 的一条线"只能看 `x2/y2` —— 少了它们，诊断里每条 `band`
       * 都长得像"零长度的点"（外部的出图/核对脚本会据此得出错误结论）。
       */
      if (d.shape === 'band') { o.x2 = +d.x2.toFixed(1); o.y2 = +d.y2.toFixed(1); o.w = d.w; o.col = d.col; }
      if (d.sc) o.sc = +d.sc.toFixed(3);
      if (d.sx !== undefined) o.sx = +d.sx.toFixed(3);
      o.len = d.shape === 'rain' ? Math.abs(d.y2 - d.y)
        : d.shape === 'snow' ? d.sc
          : d.shape === 'splash' ? d.rx
            : (d.spr ? d.sc * d.spr.len : 0);
      if (o.len > meta.maxLen) meta.maxLen = o.len;
      if (d.sx !== undefined) { if (d.sx < meta.minSpin) meta.minSpin = d.sx; if (d.sx > meta.maxSpin) meta.maxSpin = d.sx; }
      if (d.shape === 'splash') meta.splash += 1;
      if (d.shape === 'splash' && d.snow) meta.puff += 1;
      /** ⚠️ `body` 只对"溅落"这一种形状有意义 —— 所以**只在溅落上读它**，不会有池子串味。 */
      if (d.shape === 'splash' && d.body) o.body = 1;
      if (d.shape === 'box' || d.shape === 'outline') meta.box += 1;
      meta.byKind[d.kind] = (meta.byKind[d.kind] || 0) + 1;
      if (d.shape === 'rain' || d.shape === 'snow' || d.shape === 'splash' || d.shape === 'box'
        || d.shape === 'band' || d.shape === 'outline') meta.strokes += 1; else meta.fills += 1;
      if (d.spr) meta.images += 1;
      S.push(o);
    }
    if (onPaint) { try { onPaint({ D: S, meta }); } catch (e) { /* 自检回调出错不影响画面 */ } }
    lastCost = spender ? (spender() - t0) : 0;
  }

  /** 每帧推进（页面在帧循环里调一次）。`weather` 是当前天气（`off` 不发射），`scale` 是卡顿减量。 */
  function frame(dt, t, weather, scale = 1) {
    if (!Number.isFinite(dt) || dt <= 0) return;
    /**
     * ★ **单帧最多积分 1/30 秒**（2026-10-11 加的）：窗口被拖动、机器卡一下、
     * 或者页面从后台回来时，`dt` 可能是 0.5 秒 —— 那一下会让所有粒子**瞬移**半秒的路程
     * （雪像"闪"下去一段），而且发射量会在那一帧里翻倍。宁可少走一点，也不要跳。
     */
    if (dt > 1 / 30) dt = 1 / 30;
    last = t;
    /**
     * ★ **局部计数器 `cut`，不是共享变量**（2026-10-10 实测踩过）：
     * 原来 `acc` 既当"这一帧该发几颗"的余数、又被 `step()` 开头那句 `if (acc > .5) acc = .5` 削，
     * 于是**每次都只加到 0.5 就没了、永远到不了 1** → 粒子一颗都不发（而且不报错）。
     */
    const p = weather && weather !== 'off' ? PROFILE[weather] : null;
    if (p) {
      /**
       * `scale` 是**规模倍率**：桌宠只会给 0.3~1（卡顿自动减量），验收页会给到 3（堆粒子看渲染开销）。
       * 下限必须夹住（别变成 0 → 一颗都不发），**上限不夹** —— 真天花板是 `HARD_CAP`。
       */
      cut += p.perS * Math.max(.05, scale) * dt;
      let guard = 0;
      while (cut >= 1 && guard < 24) { cut -= 1; guard += 1; emit(weather, scale); }
    } else cut = 0;
    const tPhys = spender ? spender() : 0;
    step(dt, t);
    if (spender) lastPhys = spender() - tPhys;      // 物理+发射（不含渲染）
    draw();
  }

  return {
    frame, step, draw, emit, note, spawn,
    /**
     * ★ **最近一帧"画"花了多少毫秒**（`spend()`）与**"物理+发射"花了多少**（`spendPhys()`）。
     *
     * ⚠️ 这两个接口**必须挂在返回值上**：上一棒把它们写在内部（`lastCost`/`lastPhys`），
     * 却忘了挂出来 —— 验收页 `dev-weather\index.html` 每帧都调，于是页面**第一帧就抛
     * `fx.spend is not a function`、整条 `requestAnimationFrame` 循环当场死掉**（画面全空）。
     * 这就是"这一版始终没验过"的真因（不是浏览器缓存）。见文件头与 HANDOVER。
     */
    spend: () => lastCost,
    spendPhys: () => lastPhys,
    get count() { return P.length; },
    /** 每种粒子各几颗（诊断/自检用）。 */
    kinds() {
      const m = {};
      for (const p of P) m[p.kind] = (m[p.kind] || 0) + 1;
      return m;
    },
    /**
     * ★ **自检接口**：最近一帧"画了什么"（形状 / 尺寸 / 翻转倍率 / 溅落数）。
     * 换 canvas 之后 `innerHTML` 那套断言没法用了，改成查这份数据 ——
     * 见 `test\smoke.cjs` 里那几条"★天气粒子（行为）"。
     */
    stats: () => ({ n: D.length, list: S.slice(), meta: { ...meta, byKind: { ...meta.byKind } } }),
    xs: xsOf,
    /**
     * ★★ **她此刻的变换快照**（2026-10-11 晚加；页面每帧在 `frame()` 之前喂一次）。
     *
     * 字段与 pet-core `render()` 写进 `pet.xf` 的那几个一一对应：
     * `AX/AY` = 她脚下的锚点在舞台上的位置、`ax/ay` = 锚点在画稿单位里的位置（平时 128/256，
     * 拎起来时是**抓点**）、`kx/ky` = 缩放（`kx` 朝左时是负的）、`rot` = 倾角（度）、
     * `S` = 体型倍率、`moving` = 她此刻在走/跑（**只有它会让"她带起来的风"生效**）。
     *
     * ⚠️ 传 `null`（或从不调）→ **这一整套整体关闭**：粒子行为与上一版逐字相同（自检 07b 就是这样跑的）。
     * ⚠️ 每次调用只做字段拷贝，**不保存调用方的对象**，所以调用方每帧传一个字面量也不会留下垃圾。
     */
    actor(a) {
      if (!a) {
        A.on = false; A.shake = false; lastAX = null; actorVx = 0; actorDirty = true;
        /**
         * 她"不在场"了（天气关掉、页面还没画第一帧）→ 身上的积雪留在**最后那个位置**缓缓淡掉，
         * 而不是悬在半空。要立刻抹掉用 `clear(true)`。
         */
        fadeClings(CLING_FADE);
        return;
      }
      A.on = true;
      A.AX = +a.AX || 0; A.AY = +a.AY || 0;
      A.ax = a.ax == null ? 128 : +a.ax; A.ay = a.ay == null ? 256 : +a.ay;
      A.kx = +a.kx || 0; A.ky = +a.ky || 0; A.rot = +a.rot || 0; A.S = +a.S || 0;
      A.moving = !!a.moving;
      /** ★ `shake` = 页面刚让她抖了一下（③b）→ 这一帧把身上的雪抖掉（见 `step()`）。 */
      A.shake = !!a.shake;
      actorDirty = true;
    },
    /** 诊断/自检：她的判定盒子（舞台坐标两个圆）。`on:false` = 现在没有她。 */
    actorBox() {
      syncActor();
      return { on: A.on, c1: { x: R.c1x, y: R.c1y, r: R.r1 }, c2: { x: R.c2x, y: R.c2y, r: R.r2 }, vx: actorVx };
    },
    /** 诊断/自检：这个舞台坐标的点算不算"在她身上"（**与粒子完全同一套判定**）。 */
    actorHit(x, y) {
      syncActor();
      return A.on && (inCircle(x, y, R.c1x, R.c1y, R.r1) || inCircle(x, y, R.c2x, R.c2y, R.r2));
    },
    /** 诊断/自检：本地（画稿单位）→ 舞台坐标。用来跟 pet-core 的 `toStage` 逐点对账。 */
    actorStage(lx, ly) { syncActor(); return { x: mapX(lx, ly), y: mapY(lx, ly) }; },
    /** 诊断/自检：舞台坐标 → 本地（"雪贴在她身上"那套的底座）。 */
    actorLocal(x, y) { syncActor(); return { x: unmapX(x, y), y: unmapY(x, y) }; },
    /** `?diag=1&fxbox=1` 时把她那两个判定圆画出来（默认关）。 */
    debugBox(on) { boxOn = on !== false; },
    /**
     * ★★ **切天气时让身上的积雪缓缓淡掉**（③b，用户点名："不能留着、也不能瞬间没"）。
     * `secs` 是"从现在起几秒内淡完"（默认 `CLING_FADE = 2`）。页面在**任何**天气切换时调它一次
     * ——包括切到 `off`（那时候 `clear()` 也会顺带走一遍，两条路都通向"缓缓淡出"）。
     */
    fadeClings(secs) { fadeClings(secs); },
    /** 她身上现在有几个锚点积着雪（只读；页面用它判断"积够了该抖一下"）。 */
    get clinging() { return capCount(); },
    /** 她身上总共积了多少雪（0..锚点数）—— 比"几个锚点"更能说明"积够了没有"。 */
    get capLoad() { return capLoad(); },
    /** 现在用的是"她自己的真实轮廓"还是两个圆（自检/诊断用；见 `surface()`）。 */
    get hasSurface() { return !!SURF; },
    /** 诊断/自检：这条本地 x 上，她的顶面在哪儿（`NaN` = 这一列没有她）。 */
    surfaceTop(lx) { return SURF ? surfVal(SURF.top, lx) : NaN; },
    /** 诊断/自检：这条本地 x 上，她的底面在哪儿。 */
    surfaceBot(lx) { return SURF ? surfVal(SURF.bot, lx) : NaN; },
    /** 自检用：三个雪帽锚点的本地坐标与雪量（`amt` 0..1）。 */
    caps() { return ANCH.map((a) => ({ x: a.x, y: a.y, amt: +a.amt.toFixed(4), d: +a.h.d.toFixed(4) })); },
    /**
     * ★★ **换一张"她的真实顶面"**（`whale/surface.json`；页面在她的形象换了之后调一次）。
     * 传 `null` / 不给 → 退回两个判定圆（Coo 形象、老宿主、自检里不给表时都是这条）。见 `SURF` 那段。
     */
    surface(s) {
      if (!s || !Array.isArray(s.top) || !s.top.length) { SURF = null; ANCH = []; return false; }
      const mk = (arr) => {
        const out = new Float32Array(s.top.length);
        for (let i = 0; i < s.top.length; i += 1) {
          const v = Array.isArray(arr) ? arr[i] : null;
          out[i] = v == null ? NaN : +v;
        }
        return out;
      };
      const len = +s.anchorLen || 26;
      SURF = {
        x0: +s.x0 || 0, step: +s.step || 2, n: s.top.length,
        top: mk(s.top), bot: mk(Array.isArray(s.bot) ? s.bot : s.top),
      };
      /**
       * ★ 每个锚点预存一份"**跟体型无关**的几何"（`h`）：`d` = 满雪量时的雪层厚度（**rig 单位**）、
       * `x/y` = 锚点的本地坐标（`y` 就是 `top[那一列]`，见 `tickAnchor()` 里那段注释）。
       *
       * ⚠️ **单位**：`mapX/mapY` 的入参、`surface.top` 的 y、`CAP_D/CAP_W` 全是**同一种单位**
       * （她的画稿单位，1 单位 = 1px @1:1）。第一版在这里多写了一个 `1 / .42`（把 `A.S` 的
       * 缩放又反着除了一遍）→ 厚度基准从 2 变成 0.476，三顶雪各只剩一个点。
       */
      ANCH = (s.anchors || []).map((a) => ({
        x: +a[0], y: +a[1], amt: 0,
        h: { x: +a[0], y: +a[1], d: CAP_D * (len / 26), amt: 0 },
      }));
      capMeltLeft = 0;
      return true;
    },
    /** 这一层（近/远）现在有几颗在画（诊断用：两张画布分流有没有生效，一眼看得出）。 */
    layerCounts() {
      let far = 0, near = 0;
      for (const p of P) { if (assignCanvas(p)) near += 1; else far += 1; }
      return { far, near, hasNear, total: P.length };
    },
    clear(hard = false) {
      P.length = 0; splash.length = 0; bsplash.length = 0; D.length = 0; poolN = 0;
      frameHits = 0;
      /**
       * ★ **她身上的积雪默认不"一刀清掉"**（③b，用户点名）：切天气时它们要**缓缓**淡掉 ——
       * 不能留着（看着像 bug）、也不能瞬间没（太硬）。所以这里走 `fadeClings()` 的淡出包络，
       * 而 `clear(true)` 才是硬清（自检/验收页要"画布立刻空"时用它）。
       */
      if (hard) killClings(); else fadeClings(CLING_FADE);
      const g = ensureCanvas();
      /** ⚠️ **两张画布都要清**：只清远层会让近层停着上一秒的花瓣（切天气时看得最清楚）。 */
      if (g) { try { g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, cw * dpr, ch * dpr); } catch (e) { /* ignore */ } }
      if (hasNear && ctl2N) { try { ctl2N.setTransform(1, 0, 0, 1, 0, 0); ctl2N.clearRect(0, 0, ncw * dpr, nch * dpr); } catch (e) { /* ignore */ } }
    },
    /** 换主题之后页面调一次（重读 CSS 变量并重烘贴图）。 */
    repaintPalette() { refreshPal(true); },
    /**
     * ★ **尺寸诊断**：把"fx 眼里的尺寸 / 真正的画布像素 / 画布 CSS 尺寸 / dpr / 有没有 2D 上下文"
     * 一次给全（**两张画布各报一行**）。画布尺寸这条链出问题时会表现成"粒子在算、但一个都看不见"
     * （踩过一次：1×1）。
     */
    size() {
      const v = view();
      const src = ctl && ctl.bounds ? (typeof ctl.bounds === 'function' ? 'ctl.bounds()' : 'ctl.bounds') : '(无)';
      const boxOf = (c) => (c ? {
        px: [c.width, c.height],
        css: c.getBoundingClientRect
          ? [Math.round(c.getBoundingClientRect().width), Math.round(c.getBoundingClientRect().height)] : null,
      } : null);
      return {
        W: v.W, H: v.H, src, dpr, hasCtx: !!ctx, broken: drawBroken,
        canvas: canvas ? [canvas.width, canvas.height] : null,
        css: canvas && canvas.getBoundingClientRect
          ? [Math.round(canvas.getBoundingClientRect().width), Math.round(canvas.getBoundingClientRect().height)] : null,
        /** 近层（盖在她身前的那张）：`hasNear:false` = 只有一张画布，粒子全在她身后。 */
        nearCanvas: hasNear ? boxOf(canvasNear) : null,
        hasNear,
      };
    },
    /**
     * **诊断：贴图里到底有没有画上东西**（2026-10-11 加的，为一次真实事故）。
     * `drawImage` 一张**全透明**的贴图是合法的、不报错的 —— 表现就是"粒子一颗都看不见"。
     * 所以这里把每张贴图的不透明像素数出来（自检也用它，见 `test\smoke.cjs`）。
     */
    sprites() {
      const out = [];
      for (const [k, s] of sprites) {
        let ink = -1;
        try {
          const g = s.c.getContext('2d');
          const d = g.getImageData(0, 0, s.c.width, s.c.height).data;
          ink = 0;
          for (let i = 3; i < d.length; i += 4) if (d[i] > 8) ink += 1;
        } catch (e) { ink = -1; }
        out.push({ key: k, box: [s.c.width, s.c.height], len: s.len, ink });
      }
      return out;
    },
    /** 调试用：把随机种子钉住（做视觉对比时"每次刷新都是同一批粒子"）。传 `null` 恢复随机。 */
    seed(v) {
      if (v == null) { seed = Math.random() * 100; return; }
      seed = v;
      let s = Math.floor(v * 1000) ^ 0x9e3779b9;
      const nx = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
      Math.random = nx;                     // 只该在调试里用：正式运行不碰 Math.random
    },
    /**
     * 调试/自检用：把一段时间的模拟跑出来看轨迹（**返回数据、不碰画布**）。
     * 它会**临时把窗口尺寸钉成参数值**，所以可以在 Node 里离线量"雪到底铺不铺满整个宽度"。
     */
    sim(kind, secs, W = 1280, H = 760) {
      const dt = 1 / 60, t0 = last ?? 0, p = PROFILE[kind];
      let c = 0, emits = 0;
      const savedBounds = ctl ? ctl.bounds : null;
      if (ctl) ctl.bounds = { W, H };
      for (let f = 0; f < Math.max(1, secs * 60) && p; f += 1) {
        c += p.perS * dt;
        while (c >= 1) { c -= 1; emits += 1; emit(kind); }
        step(dt, t0 + f * dt);
      }
      if (ctl) ctl.bounds = savedBounds;
      return {
        n: P.length, emits, xs: xsOf(), kinds: this.kinds(),
        parts: P.map((q) => ({
          kind: q.kind, x: +q.x.toFixed(1), y: +q.y.toFixed(1),
          vx: +q.vx.toFixed(1), vy: +q.vy.toFixed(1), spin: +q.spin.toFixed(2),
        })),
      };
    },
    /** 窗口尺寸（只读，自检想核对"全屏"时用）。 */
    get bounds() { return view(); },
  };
}
