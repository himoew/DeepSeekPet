/**
 * 天气粒子与音符（2026-10-10 新建）。
 *
 * ★ **为什么单独一个文件**：粒子原来塞在 `pet-core.js` 里（那是**上游文件**，改多了危险 ——
 * 第 1.23 节两次"她不动了"都在那附近）。现在物理、外观、轨迹**全在这里**，
 * `pet-core` 只留一条出口（`renderFx` 钩子：把画粒子那一步交给外面）。
 *
 * ★ **这一版是"重写轨迹"**（用户实测："现在的特效有点像五毛的，特别劣质，不符合真实的雪花飘落……
 * 这些特效需要模拟现实轨迹"）。跟第一版的差别：
 *
 * | | 第一版（被否掉） | 现在 |
 * |---|---|---|
 * | 横摆 | **每颗一个正弦**（`sin(age*hz*2π)`）→ 所有粒子各摆各的，像机器在抖 | **风场**：位置+时间采样的噪声（值噪声两层叠加），同一片区域的粒子被**同一阵风**推着走，还会忽强忽弱 |
 * | 雪的形状 | 一个白圆点 | 程序生成的**六角星**（每颗臂长/粗细/大小都不同） |
 * | 景深 | 无 | 每颗有 `depth`：远的**小、淡、摆得少、落得慢**（视差），近的大而快 |
 * | 落叶 | 匀速下落 + 自转 | **翻滚**：自转速度随下落速度变（时快时慢）、横向被风推、`swayPhase` 让它面朝变来变去 |
 * | 雨 | 一条短线 | 细长条纹（**速度越快线越长**）+ 景深 + **落地溅落**（两个小圆环扩散） |
 * | 数量 | 雪 11/秒、雨 26/秒（**多而小 → 又糊又费**） | 雪 5/秒、雨 16/秒（**少而讲究**，封顶总数也降下来） |
 *
 * ⚠️ 想调手感：全部集中在下面 `PROFILE` 那张表；想改形状去 `draw()`。
 */

/** 值噪声（一段随机数 + 平滑插值）—— 风场用它，成本是每帧每颗粒子 2 次采样。 */
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
 * 风场：`windAt(x, y, t)` → 水平风（px/s）。
 * 两层噪声叠加（慢的大风 + 快的阵风），**只跟位置和时间有关** ——
 * 所以相邻的粒子被同一阵风推，整片看着是"一阵风过去"，而不是各摆各的。
 * 另外叠一条**很慢的"天气包络"**（每 20~40 秒风大一阵），整片雪会一起加速、飘得更斜。
 */
const WIND_SPACE = 0.0016, WIND_TIME = 0.06;
function gustEnv(t) { return 34 + 26 * noise1(t * 0.03); }
function windAt(rnd, x, y, t) {
  const u = x * WIND_SPACE + rnd, v = y * WIND_SPACE * 0.6, s = t * WIND_TIME;
  return (noise1(u + s) + noise1(u * 2.7 + v + s * 1.6) * 0.5) * gustEnv(t);
}

/**
 * 每种天气的**手感表**。这一版按"现实轨迹"重写过（资料见 HANDOVER 第 1.35 节）：
 *   · **终端速度**（`vT`）而不是匀加速 —— 雪片、花瓣落地前不会一直加速；
 *   · **三层景深**（`layers`）：远的又小又淡又慢、近的又大又快 → 视差；
 *   · `stall`（落叶/樱瓣）：迎风面周期性变大 → **下沉忽快忽慢**（薄片的升力）；
 *   · `slip`（落叶/樱瓣）：**侧滑由翻滚角驱动**（侧立时滑得最快）—— 这是"叶子"和"纸屑"的分界；
 *   · `flip`（樱瓣）：`scaleX = |cos θ|` 的纸片式翻转。
 *
 * `perS` 每秒发射几颗（按 Little 定律 N/T 反推）· `cap` 同时最多几颗 · `shutter` 雨丝曝光时间。
 */
const PROFILE = {
  snow: {
    perS: 16, cap: 110, sway: 26, hz: .2, spin: .4, stall: 0, slip: 0,
    layers: [                       // 远 → 近
      { w: .36, vT: [45, 110], size: [1.2, 2.2], alpha: [.28, .48], sway: [18, 34], hz: [.15, .30] },
      { w: .40, vT: [95, 190], size: [2.2, 4.2], alpha: [.45, .68], sway: [12, 24], hz: [.10, .22] },
      { w: .24, vT: [130, 260], size: [4.0, 7.0], alpha: [.60, .85], sway: [6, 15], hz: [.06, .15] },
    ],
    life: 40, wind: 1,
  },
  leaf: {
    perS: 4, cap: 46, stall: .30, slip: 46, spin: 1.6, spinSp: [.5, 2.3], wind: 1.2,
    layers: [
      { w: .42, vT: [26, 46], size: [5.0, 8.5], alpha: [.22, .45], sway: [16, 28], hz: [.20, .42] },
      { w: .44, vT: [46, 78], size: [9.0, 14.5], alpha: [.46, .78], sway: [12, 22], hz: [.16, .34] },
      { w: .14, vT: [92, 150], size: [18, 30], alpha: [.50, .82], sway: [8, 16], hz: [.14, .26] },
    ],
    life: 40,
  },
  blossom: {
    perS: 2.2, cap: 45, stall: .18, slip: 30, flip: [.6, 1.6], spin: 0, wind: 1.5,
    layers: [
      { w: .40, vT: [18, 30], size: [3.0, 4.2], alpha: [.45, .62], sway: [14, 24], hz: [.07, .16] },
      { w: .40, vT: [30, 42], size: [4.2, 6.4], alpha: [.55, .75], sway: [12, 20], hz: [.06, .14] },
      { w: .20, vT: [42, 58], size: [6.4, 9.5], alpha: [.62, .85], sway: [10, 18], hz: [.05, .12] },
    ],
    life: 45,
  },
  rain: {
    perS: 150, cap: 220, shutter: .05, wind: .3, fall: .5, gravity: 0,
    layers: [
      { w: .45, vT: [950, 1400], size: [.7, 1.1], alpha: [.10, .22] },
      { w: .35, vT: [1400, 2000], size: [1.1, 1.6], alpha: [.20, .38] },
      { w: .20, vT: [2000, 2900], size: [1.6, 2.4], alpha: [.32, .55] },
    ],
    life: 4,
  },
  note: {
    perS: 0, cap: 26, stall: 0, slip: 0, spin: .3, wind: .6,
    layers: [{ w: 1, vT: [-52, -30], size: [12, 18], alpha: [.75, .95], sway: [8, 16], hz: [.5, .9] }],
    life: 1.8,
  },
};
/** 所有粒子总数（含她身上的爱心/尘土那种一次性特技）的天花板。 */
const HARD_CAP = 260;
const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (r) => r[0] + Math.random() * (r[1] - r[0]);

/**
 * 造一套粒子系统。
 *   `ctl`       —— pet-core 的控制句柄（要 `bounds` 与 `mouth()`）
 *   `fxCore`    —— 画进哪个 SVG 容器（**必须是自己的子节点**，见 pet-core 里那段警告）
 *   `onFx`      —— 想给她加反应时的回调（这一版没用，留着）
 *   `report`    —— 出错/诊断上报
 */
export function createFx({ ctl, fxCore, report } = {}) {
  /** 每一颗：位置、速度、时间、外观。`bx/by` 是"没有摆动时"的位置，风推的是它。 */
  const P = [];
  /** 雨滴落地溅落：`{x, y, age}`，画两个扩散的小圆环。 */
  const splash = [];
  let last = null, noteTick = 0, seed = Math.random() * 100;
  /** 发射余数（**只被 `frame()` 用**；`step()` 不许碰它 —— 见 `frame` 里那段注释）。 */
  let cut = 0;

  const view = () => {
    const b = ctl?.bounds || { W: 1280, H: 760 };
    return { W: Math.max(1, b.W | 0), H: Math.max(1, b.H | 0) };
  };

  /* ---------- 生成 ---------- */
  function make(kind, over = {}) {
    const p = PROFILE[kind] || PROFILE.snow;
    const { W, H } = view();
    // 三层景深：先按权重抽一层，再取这一层的参数（远的又小又淡又慢 —— 视差就是这么来的）
    let roll = Math.random(), li = 0, acc2 = 0;
    for (let i = 0; i < p.layers.length; i += 1) { acc2 += p.layers[i].w; if (roll <= acc2) { li = i; break; } }
    const L = p.layers[li];
    const vT = pick(L.vT);
    const it = {
      kind, layer: li, layerN: p.layers.length,
      x: over.x ?? rnd(-30, W + 30),
      y: over.y ?? -14,
      vx: 0, vy: vT * 0.35,          // 入画时还没到终端速度（下落会"先快后稳"）
      vT,                            // ★ 终端速度：用指数趋近，而不是一直加速
      wind: p.wind ?? 1,
      // 摆动：频率与幅度**每颗独立**（共用正弦是"五毛感"的第一来源）
      sway: pick(L.sway || [0, 0]),
      hz: pick(L.hz || [0, 0]),
      phase: Math.random() * Math.PI * 2,
      spin: (p.spin || 0) * rnd(.6, 1.5) * (Math.random() < .5 ? -1 : 1),
      spinSp: p.spinSp ? pick(p.spinSp) * (Math.random() < .5 ? -1 : 1) : 0,
      roll: Math.random() * Math.PI * 2,
      rollSp: rnd(-.5, .5),
      slip: (p.slip || 0) * rnd(.6, 1.4),
      stall: p.stall || 0,
      flip: p.flip ? pick(p.flip) : 0,
      rot: Math.random() * 360,
      size: pick(L.size),
      alpha: pick(L.alpha),
      life: p.life || 40,
      age: 0,
      born: last ?? 0,
      ...over,
    };
    it.bx = it.x; it.by = it.y;
    if (kind === 'snow') {                             // 六角星：每颗的臂长/粗细都不同
      it.arms = 3 + Math.floor(Math.random() * 2);
      it.armR = rnd(0.62, 0.98);
      it.lw = rnd(0.75, 1.35);
    }
    if (kind === 'leaf') { it.leafHue = Math.random(); it.leafLen = rnd(0.85, 1.25); }
    if (kind === 'note') { it.glyph = Math.random() < .5 ? '♪' : '♫'; it.spin = rnd(-16, 16); }
    return it;
  }
  function spawn(kind, over) {
    if (P.length >= HARD_CAP) return null;
    const p = make(kind, over);
    P.push(p);
    return p;
  }
  /**
   * 页面要的"每帧发射"接口：**这种天气同时最多 `cap` 颗**（到顶就不发了，等它们落地）。
   * ⚠️ 必须是**函数声明**（不是 `const emit = …`）：`frame()` 会调它，而 `frame` 在下面，
   * 写成 const 的话调用时会落进暂时性死区 → `ReferenceError` → **粒子一颗都不生成**
   * （而且异常被帧循环的 try/catch 吃掉，看起来只是"特效没出来"）。实测踩过。
   */
  function emit(kind) {
    const p = PROFILE[kind];
    if (!p) return;
    const same = P.reduce((n, it) => n + (it.kind === kind ? 1 : 0), 0);
    if (same >= p.cap) return;
    spawn(kind);
  }
  /** 她说话时从嘴边冒音符。 */
  function note(x, y) {
    if (++noteTick % 4) return;
    spawn('note', { x: x + rnd(-10, 10), y, vx: rnd(-14, 14), vy: -rnd(30, 52) });
  }

  /* ---------- 每帧：物理 ---------- */
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
       */
      const spinA = p.spin ? p.rot * Math.PI / 180 : p.roll;
      const stall = p.stall ? 1 - p.stall * Math.abs(Math.cos(spinA)) ** 1.5 : 1;
      p.vy += (p.vT * stall - p.vy) * k;
      // 风场：同一个位置+时刻的粒子被同一阵风推
      const gust = p.wind ? windAt(seed, p.bx, p.by, t) * p.wind : 0;
      p.vx += (gust - p.vx * 0.9) * dt * 1.6;
      /**
       * ★ **侧滑由翻滚角驱动**（叶子/花瓣）：侧立时切风、滑得最快；正面朝风时几乎停住。
       * 资料里这句是"叶子 vs 纸屑"的分水岭 —— 所以**不能再给 x 加独立正弦**（那读起来像 bug）。
       */
      const slip = p.slip ? Math.sin(spinA) * p.slip : 0;
      p.bx += (p.vx + slip) * dt;
      p.by += p.vy * dt;
      // 摆动：围绕出生点算，每颗自己的频率与相位
      const ph = p.age * p.hz * 2 * Math.PI + p.phase;
      p.x = p.bx + Math.sin(ph) * p.sway + Math.sin(ph * .37 + p.phase) * p.sway * .35;
      p.y = p.by;
      if (p.kind === 'leaf') {
        p.spin += p.spinSp * dt;                       // 翻滚加速（端对端）
        p.roll += p.rollSp * dt;                       // 面内自转（独立轴）
        p.rot = p.spin * 57.3;
      } else if (p.kind === 'blossom') {
        p.roll += p.rollSp * dt;                       // 花瓣：靠 `flip` 做纸片翻转，`roll` 只是小幅摆动
      } else if (p.spin) {
        p.rot += p.spin * dt * 57.3;
      }
      // 雨：落到"窗口底"就记一次溅落（"落地"是最容易看出真假的一处）
      if (p.kind === 'rain' && p.by >= H - 4) {
        // 只有近/中层才溅落（远层溅落看不出来，白花量）
        if (p.layer >= 1) splash.push({ x: p.bx, y: H - 2, age: 0, life: rnd(.16, .4), size: p.size });
        P.splice(i, 1);
        continue;
      }
      if (p.by > H + 40 || p.x < -120 || p.x > W + 120 || p.age > p.life) P.splice(i, 1);
    }
    for (let i = splash.length - 1; i >= 0; i -= 1) {
      splash[i].age += dt;
      if (splash[i].age > splash[i].life) splash.splice(i, 1);
    }
    // 溅落太多也没意义（同屏 30 个上限）
    while (splash.length > 30) splash.shift();
  }
  /** 现在这些粒子铺在 x 上的 [最小, 最大, 中位]（诊断用：用户报过"只有左半边有粒子"）。 */
  function xsOf() {
    if (!P.length) return null;
    const xs = P.map((p) => p.x).sort((a, b) => a - b);
    return [Math.round(xs[0]), Math.round(xs[xs.length - 1]), Math.round(xs[xs.length >> 1])];
  }

  /* ---------- 每帧：画（拼一段 SVG 字符串；内容不变就不写 DOM） ---------- */
  let lastSvg = '';
  function draw() {
    const { H } = view();
    const out = [];
    for (const p of P) {
      const a01 = p.age / p.life;
      const op = p.alpha * (a01 > 1 - p.fade ? Math.max(0, (1 - a01) / p.fade) : 1) * (a01 < .06 ? a01 / .06 : 1);
      const X = p.x.toFixed(1), Y = p.y.toFixed(1);
      if (p.kind === 'snow') {
        // 六角星：`arms` 条臂 + 每条臂上两对小枝（程序生成，**每颗都不同**）
        let d = '';
        for (let k = 0; k < p.arms; k += 1) {
          const ang = (k * Math.PI / p.arms) + p.rot * Math.PI / 180;
          const dx = Math.cos(ang), dy = Math.sin(ang), r = p.size * p.armR;
          d += `M0 0L${(dx * r).toFixed(2)} ${(dy * r).toFixed(2)}`;
          const bx = dx * r * .55, by = dy * r * .55, bd = r * .3;
          d += `M${bx.toFixed(2)} ${by.toFixed(2)}l${(-dy * bd).toFixed(2)} ${(dx * bd).toFixed(2)}`;
          d += `M${bx.toFixed(2)} ${by.toFixed(2)}l${(dy * bd).toFixed(2)} ${(-dx * bd).toFixed(2)}`;
        }
        out.push(`<path d="${d}" fill="none" stroke="var(--snow)" stroke-width="${(p.lw * (0.6 + .5 * (p.layer / Math.max(1, p.layerN - 1)))).toFixed(2)}" stroke-linecap="round" opacity="${op.toFixed(2)}" transform="translate(${X} ${Y})"/>`);
      } else if (p.kind === 'blossom') {
        /**
         * 花瓣：**纸片式翻转** —— `scaleX = |cos θ|`（θ 由 `age × flip` 驱动），
         * 侧立的那一瞬间在屏幕上"变窄"，这就是"花瓣"和"粉色圆点"的分界
         * （研究里那条：绕斜轴翻转 ≈ 2D 里的 scaleX + 小幅面内旋转）。
         * 留 6% 底宽，别真的归零闪一下。
         */
        const th = p.age * p.flip * 2 * Math.PI;
        const c = Math.cos(th);
        const sx = Math.max(.06, Math.abs(c));
        const r = p.size;
        // 远层不画五瓣（6~8px 时已经糊成一团），退化成一个小椭圆
        const far = p.layer === 0;
        let petals = '';
        if (!far) {
          for (let k = 0; k < 5; k += 1) {
            const ang = k * (2 * Math.PI / 5);
            petals += `<ellipse cx="0" cy="${(-r * .62).toFixed(2)}" rx="${(r * .42).toFixed(2)}" ry="${(r * .62).toFixed(2)}" transform="rotate(${(ang * 180 / Math.PI).toFixed(1)})"/>`;
          }
        }
        const inner = far ? `<ellipse cx="0" cy="0" rx="${r.toFixed(2)}" ry="${(r * .7).toFixed(2)}"/>` : petals;
        // 背面（c<0）暗一档：最便宜的立体感
        const back = c < 0 ? .78 : 1;
        out.push(`<g fill="var(--blossom)" opacity="${(op * back).toFixed(2)}" transform="translate(${X} ${Y}) rotate(${(p.roll * 57.3).toFixed(1)}) scale(${sx.toFixed(2)} 1)">${inner}</g>`);
      } else if (p.kind === 'leaf') {
        /**
         * 叶子：**翻滚 = 水平缩放**（`|cos(spin)|`），侧立时在屏幕上几乎看不见 ——
         * 研究的原话是"这一瞬间是'叶子'与'五彩纸屑'的分水岭"。
         * 侧滑已经在物理里由 `sin(spin)` 驱动，所以这里的 `spin` 就是同一个角。
         */
        const side = Math.abs(Math.cos(p.spin));
        const r = p.size * p.leafLen;
        const fill = p.leafHue < .34 ? 'var(--leaf-a)' : p.leafHue < .7 ? 'var(--leaf-b)' : 'var(--leaf-c)';
        out.push(`<g opacity="${op.toFixed(2)}" transform="translate(${X} ${Y}) rotate(${(p.roll * 57.3).toFixed(1)}) scale(${Math.max(.08, side).toFixed(2)} 1)">`
          + `<path d="M0 ${(-r).toFixed(2)}C${(r * .75).toFixed(2)} ${(-r * .45).toFixed(2)} ${(r * .6).toFixed(2)} ${(r * .5).toFixed(2)} 0 ${r.toFixed(2)}C${(-r * .6).toFixed(2)} ${(r * .5).toFixed(2)} ${(-r * .75).toFixed(2)} ${(-r * .45).toFixed(2)} 0 ${(-r).toFixed(2)}Z" fill="${fill}"/>`
          + `<path d="M0 ${(-r * .8).toFixed(2)}L0 ${(r * .8).toFixed(2)}" stroke="var(--leaf-ink)" stroke-width="${(r * .07).toFixed(2)}" opacity=".55"/></g>`);
      } else if (p.kind === 'rain') {
        /**
         * 雨丝：**条纹长度 = 速度 × 曝光时间**（`shutter`）—— 真实雨滴的"细长"就是这么来的，
         * 而不是随手定一个 12px。方向沿**速度矢量**（所以有风时是斜的），尾迹往上画一段。
         */
        const len = Math.min(64, Math.hypot(p.vx, p.vy) * (p.shutter || PROFILE.rain.shutter));
        const ang = Math.atan2(p.vy, p.vx) || (Math.PI / 2);
        out.push(`<line x1="${X}" y1="${Y}" x2="${(p.x - Math.cos(ang) * len).toFixed(1)}" y2="${(p.y - Math.sin(ang) * len).toFixed(1)}" stroke="var(--rain)" stroke-width="${p.size.toFixed(2)}" stroke-linecap="round" opacity="${op.toFixed(2)}"/>`);
      } else if (p.kind === 'note') {
        out.push(`<text class="p-note" text-anchor="middle" font-size="${p.size.toFixed(1)}" opacity="${op.toFixed(2)}" transform="translate(${X} ${Y}) rotate(${p.rot.toFixed(1)})">${p.glyph}</text>`);
      }
    }
    for (const s of splash) {
      // 溅落：一个扩散的扁椭圆环 + **二次淡出**（`(1-k)²` 比线性更像水）
      const k = s.age / s.life, r0 = s.size * 1.2, rMax = s.size * 7 + 8;
      const r = r0 + (rMax - r0) * k;
      out.push(`<ellipse cx="${s.x.toFixed(1)}" cy="${(H - 2).toFixed(1)}" rx="${(r * 1.7).toFixed(1)}" ry="${(r * .28).toFixed(1)}" fill="none" stroke="var(--rain)" stroke-width="${(1.4 - 1.1 * k).toFixed(2)}" opacity="${(0.75 * (1 - k) * (1 - k)).toFixed(2)}"/>`);
    }
    const svg = out.join('');
    if (svg !== lastSvg) { fxCore.innerHTML = svg; lastSvg = svg; }
  }

  /** 每帧推进（页面在帧循环里调一次）。`weather` 是当前天气的名字（`off` 就不发射）。 */
  function frame(dt, t, weather) {
    if (!Number.isFinite(dt) || dt <= 0) return;
    last = t;
    /**
     * ★ **局部计数器，不用共享的 `acc`**（2026-10-10 实测踩过）：
     * 原来 `acc` 既当"这一帧该发几颗"的余数、又被 `step()` 开头那句 `if (acc > .5) acc = .5` 削，
     * 于是**每次都只加到 0.5 就没了、永远到不了 1** → 粒子一颗都不发（而且不报错）。
     * 现在这个 `cut` 是本函数局部的，谁也别碰。
     */
    const p = weather && weather !== 'off' ? PROFILE[weather] : null;
    if (p) {
      cut += p.perS * dt;
      let guard = 0;
      while (cut >= 1 && guard < 6) { cut -= 1; guard += 1; emit(weather); }
    } else cut = 0;
    step(dt, t);
    draw();
  }

  return {
    frame, step, draw, emit, note, spawn,
    get count() { return P.length; },
    xs: xsOf,
    clear() { P.length = 0; splash.length = 0; lastSvg = ''; fxCore.innerHTML = ''; },
    /**
     * 调试/自检用：把一段时间的模拟跑出来看轨迹（**返回数据、不碰 DOM**）。
     * 它把窗口尺寸临时钉成参数值，所以可以在 Node 里离线量"雪到底铺不铺满整个宽度"。
     */
    sim(kind, secs, W = 1280, H = 760) {
      const dt = 1 / 60, t0 = last ?? 0, p = PROFILE[kind];
      // 用一个**局部**计数器，不碰共享的 `acc`（那玩意儿被帧循环和这里同时用，很容易互相踩）
      let cut = 0, emits = 0;
      for (let f = 0; f < Math.max(1, secs * 60) && p; f += 1) {
        cut += p.perS * dt;
        while (cut >= 1) { cut -= 1; emits += 1; emit(kind); }
        step(dt, t0 + f * dt);
      }
      return {
        n: P.length, emits, xs: xsOf(),
        parts: P.map((q) => ({ kind: q.kind, x: +q.x.toFixed(1), y: +q.y.toFixed(1), vx: +q.vx.toFixed(1), vy: +q.vy.toFixed(1), depth: +q.depth.toFixed(2) })),
      };
    },
    /** 窗口尺寸（只读，自检想核对"全屏"时用）。 */
    get bounds() { return view(); },
  };
}
