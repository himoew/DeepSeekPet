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
     */
    perS: 4, cap: 44, stall: .22, slip: 34, spin: 0, spinSp: [.45, .95], flip: [.45, 1.1], wind: 1.5, fade: .2,
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
 *   `ctl`     —— pet-core 的控制句柄（只要 `bounds`：`{ W, H }`）
 *   `canvas`  —— 粒子画布（`#fxCanvas`）。**没有它也能跑**（自检在 Node 里就没有画布）
 *   `report`  —— 出错/诊断上报
 *   `onPaint` —— 每帧画完回调一次（自检用，参数 `{ D, meta }`）
 */
export function createFx({ ctl, canvas, report, onPaint, onCtx } = {}) {
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
  const meta = { fills: 0, strokes: 0, images: 0, maxLen: 0, minSpin: 1, maxSpin: 1, splash: 0, byKind: {} };
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
   * ⚠️ `scale` 是"因为卡顿而减量"用的（页面按帧时间给，见 `stepWeather`）——
   * 它削的是**上限**（= 减密度），但下面 `frame` 里同时也削了发射速率，
   * 而且页面只会给 0.4~1，不会出现"雪突然一颗都没有"。
   */
  function emit(kind, scale = 1) {
    const p = PROFILE[kind];
    if (!p) return;
    const want = Math.max(1, Math.round(p.cap * clamp(scale, .4, 1)));
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
      p.vx += (gust - p.vx * 0.9) * dt * 1.6;
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
    D.push(d);
  }
  function drawNote(p, op, d) {
    if (op < .02) return;
    d.shape = 'note'; d.kind = 'note'; d.op = op;
    d.x = p.x; d.y = p.y; d.col = pal.note;
    d.font = `${(p.size * 1.25).toFixed(1)}px "Segoe UI Symbol","Noto Sans SC",system-ui,sans-serif`;
    d.glyph = p.glyph; d.rot = p.rot; d.sc = 1;
    d.spr = null; d.sx = 1; d.branches = null;
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
      D.push(d);
    }
  }

  /* ---------- 每帧：真的画到 canvas 上 ---------- */
  function drawQ(g) {
    for (const d of D) {
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
  function draw() {
    refreshPal(false);
    const t0 = spender ? spender() : 0;
    build();
    const g = ensureCanvas();
    if (g && !drawBroken) {
      try {
        g.setTransform(1, 0, 0, 1, 0, 0);
        g.globalAlpha = 1;
        g.globalCompositeOperation = 'source-over';
        g.clearRect(0, 0, cw * dpr, ch * dpr);
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        g.lineCap = 'round';
        g.lineJoin = 'round';
        /**
         * ⚠️ **不要开 `globalCompositeOperation = 'lighter'`**（2026-10-11 试过又撤掉了）。
         * 加法混合看着"雪会发光"，但它把**主体的颜色吃掉了**：樱花的粉（#FF9EC4）加在
         * 一屏透明像素上还算正常，可一旦花瓣和雪/雨重叠，粉色会先被自己叠成白色，
         * 贴图上那点深粉描边和叶子会直接变成"一根毛边" —— 用户看到的就是"像划痕"。
         * 现在用浏览器默认的 `source-over`（正常 alpha 叠加），`op` 直接给 `globalAlpha`。
         */
        calls.stroke = 0; calls.fill = 0; calls.image = 0;
        drawQ(g);
        g.globalAlpha = 1;
        g.globalCompositeOperation = 'source-over';
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
    meta.callStroke = calls.stroke; meta.callFill = calls.fill; meta.callImage = calls.image;
    meta.byKind = {};
    for (const d of D) {
      const o = { shape: d.shape, kind: d.kind, op: +(d.op || 0).toFixed(3), x: +d.x.toFixed(1), y: +d.y.toFixed(1) };
      if (d.sc) o.sc = +d.sc.toFixed(3);
      if (d.sx !== undefined) o.sx = +d.sx.toFixed(3);
      o.len = d.shape === 'rain' ? Math.abs(d.y2 - d.y)
        : d.shape === 'snow' ? d.sc
          : d.shape === 'splash' ? d.rx
            : (d.spr ? d.sc * d.spr.len : 0);
      if (o.len > meta.maxLen) meta.maxLen = o.len;
      if (d.sx !== undefined) { if (d.sx < meta.minSpin) meta.minSpin = d.sx; if (d.sx > meta.maxSpin) meta.maxSpin = d.sx; }
      if (d.shape === 'splash') meta.splash += 1;
      meta.byKind[d.kind] = (meta.byKind[d.kind] || 0) + 1;
      if (d.shape === 'rain' || d.shape === 'snow' || d.shape === 'splash') meta.strokes += 1; else meta.fills += 1;
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
    clear() {
      P.length = 0; splash.length = 0; D.length = 0; poolN = 0;
      const g = ensureCanvas();
      if (g) { try { g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, cw * dpr, ch * dpr); } catch (e) { /* ignore */ } }
    },
    /** 换主题之后页面调一次（重读 CSS 变量并重烘贴图）。 */
    repaintPalette() { refreshPal(true); },
    /**
     * ★ **尺寸诊断**：把"fx 眼里的尺寸 / 真正的画布像素 / 画布 CSS 尺寸 / dpr / 有没有 2D 上下文"
     * 一次给全。画布尺寸这条链出问题时会表现成"粒子在算、但一个都看不见"（踩过一次：1×1）。
     */
    size() {
      const v = view();
      const src = ctl && ctl.bounds ? (typeof ctl.bounds === 'function' ? 'ctl.bounds()' : 'ctl.bounds') : '(无)';
      return {
        W: v.W, H: v.H, src,
        canvas: canvas ? [canvas.width, canvas.height] : null,
        css: canvas && canvas.getBoundingClientRect
          ? [Math.round(canvas.getBoundingClientRect().width), Math.round(canvas.getBoundingClientRect().height)] : null,
        dpr, hasCtx: !!ctx, broken: drawBroken,
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
