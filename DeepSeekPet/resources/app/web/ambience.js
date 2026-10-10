/**
 * 天气的环境音（2026-10-11 新建，同日两次重写）。
 *
 * ★ **为什么是"生成的"而不是下载一段 wav**：这个项目一个音频素材都没有（`createSfx` 是纯
 *   Web Audio 合成）；生成的噪声是连续流、没有循环接缝；而且每种天气要能**按参数切**。
 *
 * =====================================================================================
 * ★★ 用户实测史（三条反馈，逐条对应这里的一次重写）
 *
 * 1) 第一版："雨像油锅滋滋滋、风声像死水、整体像恐怖片" —— 病根是白噪声 + 高通 1kHz
 *    正好抬高 1~4kHz 的刺耳段，风只由一个 0.05Hz 正弦晃，低频轰鸣压得太重。
 * 2) 第二版（换成"粉噪声 + 8k 低通 + 8~13Hz 随机游走"）：**"全部糊成一团、听不出主次"**。
 *    病根有三条，全在这一版里修掉：
 *
 *    · **床是一个"宽带噪声过低通"** —— 它天生没有形状，就是一片咝；
 *    · **主角（雨滴）比床还小** —— 实测雨滴峰值 0.05~0.1，淹没在床里（检测器只数得出
 *      0.1~0.3 次/秒，而设计是 ~10 次/秒）；
 *    · **一个天气里同时有三样东西在动**（雨滴 + 随机游走扫截止 + 白噪咝声）= 三个主角。
 *
 * 3) 这一版的目标（用户原话）：**"雨声在雨天就应该是最突出的声音，哪怕其他声音一点不加，
 *    它也应该要能听清楚；其次才是其他鸟叫虫鸣的环境声"** —— 也就是**主次**。
 *
 * =====================================================================================
 * ★★ 这一版的结构：**三级 + 一个主角**
 *
 * 每一档固定三层，**主角永远最突出**（实测"前景显著性"≥6dB，见 `dev-weather\sound.html`）：
 *
 *   | 层 | 字段 | 角色 | 频段 | 相对电平 |
 *   |---|---|---|---|---|
 *   | **主角** | `fg` 事件（`spark`）+ `mid` 层的包络 | 这一档的"身份证" | 各档独立、互不重叠 | 峰值比床高 15dB 以上 |
 *   | 中层 | `mid` | 托住主角的厚度（**窄带**，不是宽带低通） | 比床窄、比主角宽 | 比床低 3~6dB |
 *   | 背景 | `bed` | "有空间"的感觉 | 极低 | 基准 |
 *
 * **四条一起做才不糊**（缺一条都会回到"一片咝"）：
 *
 * ① **主角必须是"事件"**，不是噪声。雨 = 雨滴的**节奏与密度**（每秒 9~15 颗，每颗独立的
 *    左右声场与音色变化），叶 = 一片叶子"擦——过"的动作（0.3~0.6 秒的宽频抓挠），
 *    鸟叫 = 真正的**滑音**（带通的扫频噪声，带上升-下降的乐句）。
 * ② **同一个天气里只许有一个主角**：所以 `flow`（慢包络）**只加在主角那一层上**，
 *    不会让床和主角一起"呼吸"。
 * ③ **频谱不许撞车**（"挤成一堆"的另一半原因）：雨滴/溅落留 1.2k 以下，鸟叫 2~5k，
 *    风声 300~900，叶子沙沙 1~4k —— 四档之间只有鸟叫和叶子沙沙挨着，而它们不同天气出现。
 * ④ **床要窄**：用 `bandpass`（Q .5~.7），不再用"宽带 + 低通"。这是"咝"和"有点厚度的底"的区别。
 *
 * ★ 另外两条（电平与"不停在变"）沿用上一版的正确做法：
 *   · **电平**：`mixGainDb` 记实测床电平，`EU()` 把它归一到 `TARGET_RMS_DB`（见下面那张表）；
 *   · **不停在变**：30 秒棕噪声随机游走（`drift`）驱动**增益包络**与滤波器截止，
 *     再叠几个不可通约的慢正弦 —— 永远不重复。
 *
 * ⚠️ 调参入口全在 `TRACKS` 一张表里。改完**一定要**跑 `dev-weather\sound.html` 看数字
 *    （它能量出"前景显著性"：把所有事件静音再渲一遍，两次 RMS 差多少 dB）。
 * ⚠️ 滤波器 **Q 一律 ≤ 5**（高 Q + 稀疏事件 = 哨音/尖叫）。
 * ⚠️ **一段 wav 素材都没有**：这里全部是 Web Audio 合成，音量/音色只由这张表决定。
 *
 * **调研出处**（均为公开资料）：
 *   · [Audiokinetic: Generating Rain With Pure Synthesis](https://www.audiokinetic.com/en/community/blog/generating-rain-with-pure-synthesis/)
 *     （四层结构：高频沸腾/中频沸腾/左右声道粉噪声/独立雨滴）
 *   · [Medwin, Nystuen 等《The Anatomy of Underwater Rain Noise》](http://staff.washington.edu/jan4/nystuen/j_pubs/mnjso92.html)
 *     （雨滴按直径分级：小滴 15kHz 微气泡、中滴只有冲击声、大滴 2~10kHz 主导）
 *   · [COMS3430 Lab 3](http://www.marksantolucito.com/COMS3430/fall2021/Lab3)
 *     （棕噪声公式；"被低通到 14Hz 的棕噪声驱动滤波器截止"）
 *   · [Tero Parviainen: JavaScript Systems Music](https://teropa.info/blog/2016/07/28/javascript-systems-music.html)
 *     （Eno 的"不可通约"循环）
 *   · [W3C WCAG G56](https://www.w3.org/WAI/WCAG20/Techniques/general/G56)（背景至少比前景低 20dB）
 */

/* =====================================================================================
 * 音色表
 * ===================================================================================== */
/**
 * **每层的字段**（`bed` / `mid` / `fgMid` 都用同一套）：
 *   `n` 噪声色（white / pink / brown）· `t` 滤波器类型 · `f` 中心/截止 · `q` 品质因数
 *   `g` 线性增益（**表里的 g 是"混音比例"**，绝对电平由 `mixGainDb` + `EU()` 定）
 *   `flow` 慢包络深度（0~1：1 ≈ 让这一层的音量随 30 秒游走在 ±40% 上下呼吸）
 *   `swing` 截止被游走推多远（占 `f` 的百分比，缺省 12）
 *   `drift` [游走源低通 Hz] · `envHz` [包络的低通 Hz，越小越慢]
 *   `lfo` [[速率Hz, 深度Hz], …]（几个不可通约的慢正弦，做小幅呼吸）
 */
const TRACKS = {
  /**
   * 雨 —— **主角是"雨滴"**。用户原话："雨声在雨天就应该是最突出的声音"。
   *
   * 所以这一档刻意把床**压到很窄**（带通 1.2k Q.5），只留一点"雨幕"的底；
   * 厚度由 700Hz 的窄带中层给；**绝大部分存在感来自每秒 9~15 颗雨滴**：
   * 每颗 = 低频冲击（水滴打上去的"蓬"）+ 一点小滴的 2.5~5k 碎裂声，
   * 独立的左右声场、独立的音量 —— 是**节奏**让人听出"这是雨"。
   */
  rain: {
    mixGainDb: 17.7, seed: 44,
    bed: [{ n: 'pink', t: 'bandpass', f: 1200, q: .5, g: .10, flow: .5, envHz: [.25], swing: 10, drift: [6] }],
    mid: [{ n: 'pink', t: 'bandpass', f: 700, q: .5, g: .07, flow: .7, envHz: [.2], swing: 12, drift: [7] }],
    spark: 'drop',
    every: [.065, .11],                 // ≈ 9~15 颗/秒（是**节奏**，不是密度堆积）
    thunder: [24, 60],                  // 远雷：拉长间隔、压低音量
  },
  /**
   * 雪 —— **主角是"风"**（雪本身没有声音）。用户对风的要求是"别像死水"。
   *
   * 所以风吹得**明显**：中层是一条 520Hz 的窄带噪声，它的**音量包络由 30 秒游走驱动
   * （`flow: 1`）** —— 一阵一阵地紧、松，周期不重复；截止也跟着晃（`swing 24%`）。
   * 另外偶尔来一声低频的"阵风"（`spark: 'gust'`），把风的方向感带出来。
   */
  snow: {
    mixGainDb: 17.7, seed: 11,
    bed: [{ n: 'brown', t: 'bandpass', f: 220, q: .6, g: .16, flow: .6, envHz: [.18], swing: 12, drift: [8] }],
    mid: [{ n: 'brown', t: 'bandpass', f: 520, q: .5, g: .14, flow: 1, envHz: [.16], swing: 24, drift: [9], lfo: [[.023, 18], [.037, 11]] }],
    spark: 'gust',
    every: [4.5, 11],
  },
  /**
   * 落叶 —— **主角是"一片叶子擦过"**。真实落叶没有连续声源，所以主角只能是**动作**：
   * 0.35~0.6 秒的宽频抓挠（1~5k），**在声场里来回移动**（擦过的方向感），
   * 每 1.2~3 秒一次。床与中层压到很低，只留"空气"。
   */
  leaf: {
    mixGainDb: 17.7, seed: 33,
    bed: [{ n: 'pink', t: 'bandpass', f: 500, q: .6, g: .05, flow: .7, envHz: [.2], swing: 12, drift: [10] }],
    mid: [{ n: 'pink', t: 'bandpass', f: 2600, q: .5, g: .035, flow: .8, envHz: [.25], swing: 14, drift: [12] }],
    spark: 'leaf',
    every: [1.2, 3.0],
  },
  /**
   * 樱花 —— **主角是"很轻的风"**（花瓣沙沙）**加"偶尔的鸟叫"**。这是唯一允许有两个前景的档，
   * 但两者**时间上几乎不重叠**：风是底子（`flow 1` 慢慢呼吸），鸟叫是**稀客**（22~55 秒一次）。
   * 鸟叫做成真正的**滑音**（带通扫频的"啾-溜"），比纯正弦自然得多 ——
   * 而且它落在 2~5k，**避开**雨滴/风声的频段（"挤成一堆"的另一半原因）。
   */
  blossom: {
    mixGainDb: 25.1, seed: 22,
    bed: [{ n: 'pink', t: 'bandpass', f: 420, q: .6, g: .07, flow: .6, envHz: [.2], swing: 12, drift: [9] }],
    mid: [{ n: 'pink', t: 'bandpass', f: 1100, q: .5, g: .05, flow: 1, envHz: [.17], swing: 20, drift: [10], lfo: [[.037, 22]] }],
    spark: 'bird',
    every: [22, 55],
    bird: { f0: [2300, 3400], sweep: [.55, .85] },   // 鸟叫的音高范围与下滑比例（见 `bird()`）
  },
};

/**
 * ★★ **整档电平的标定：`mixGainDb` + `EU()`**（2026-10-11 加；称号与**符号**都在当天晚上返工过）。
 *
 * 病根是**两处增益叠乘**：每层的 `g`（0.03~0.16）本来就是**混音比例**，
 * 而 `MASTER_GAIN = 0.15` 又当"绝对音量"再乘了一次。离线量出来四档只有
 * **-42 ~ -55 dBFS RMS** —— 低 20~30dB（几乎听不见），**而且彼此差 12dB**（切到落叶像被关了）。
 *
 * ⚠️⚠️ **`mixGainDb` 的定义（这里返工过两次，两次都是符号）**：它是**"要施加的增益"**
 * （dB，正数），不是"原始电平"。
 *   · 第一次把它当成"原始电平"填了**负数** → `EU()` 算出 0.0005 倍，四档一起掉到 **-117dBFS**（等于静音）；
 *   · 第二次忘掉 `masterDb` 本身是**负的**，写成 `+ 16.48` → 又大了 16dB，雨削顶到 **+16dBFS**。
 * 正确关系（`masterDb = 20·log10(0.15) = -16.48`）：

 *     raw = 用**增益 = 1** 渲一遍量出来的 RMS（负数，比如雨 -51.3）
 *     mixGainDb = TARGET_RMS_DB − raw − masterDb
 *               = -26 − (-51.3) − (-16.48) = **8.5**（雨；为峰值余量退到 **6.5**）
 *     EU(mixGainDb) = 10^(mixGainDb/20)   ← 线性倍数，乘在整档输出上
 *
 * 当晚实测（`__rawMedian` 渲 5 遍取中位数 —— **不能只渲一遍**：慢随机游走包络会让
 * 同一套参数两次差 10dB，我因此白改了两轮）：
 *
 *     | 档 | raw 中位数 | mixGainDb | 备注 |
 *     |---|---|---|---|
 *     | 雨 | -51.3 | 8.5 → **6.5** | 波峰因数 27dB，退 2dB 防爆表 |
 *     | 雪 | -43.9 | 1.1 | min/max 跨度 12dB（风的呼吸，正常） |
 *     | 落叶 | -58.6 | 15.7 | 稀疏事件，RMS 天生低 |
 *     | 樱花 | -55.6 | 12.8 | 同上 |
 *
 *   ⚠️ **判据只信实测**：改完跑 `dev-weather\sound.html` 的 `__renderAll()`，
 *      看**混合 RMS 是不是落在 -26 附近、峰值是不是 > -3dB**。别信推导 —— 这条式子上我已经错过两次。
 *
 *   ⚠️ **改了任何 `g`/`f`/`t`/`vol`/`every` 都要重新标一次** —— 跑
 *      `dev-weather\sound.html` 的 `__rawMedian(name)`，把 `mixGainDb` 抄回下面四行。
 *   ⚠️ **目标为什么是 -26 而不是文件头原来写的 -16**：合成噪声 + 冲击事件的波峰因数有 20dB 上下，
 *      抬到 -16 时雨的峰值量到 **+3.2dBFS（爆表）**。`-26` 时四档峰值 ≈ -4~-7dB，
 *      既听得见又不削顶。想更响要上**限幅器**，不是拧增益。
 */
const TARGET_RMS_DB = -26;
/** dB（要施加的增益）→ 线性倍数。 */
const EU = (mixGainDb) => (mixGainDb == null ? 1 : 10 ** (mixGainDb / 20));

/**
 * **总输出的上限增益**（用户实测"默认声音有点大，至少降一半" → 0.15 ≈ -16.5dB）。
 * 它是**用户音量的天花板**：真正响不响还由「声音」总闸 × 右键菜单「天气声」两层决定。
 * ⚠️ 它**不参与**"这一档该多响"的计算（那是 `EU()` 的事）——
 *    上一版把它当成绝对音量，才出现"两处增益叠乘"。
 */
const MASTER_GAIN = 0.15;
/** 指数斜坡不能到 0（规范禁止），统一用这个"听不见但为正"的 ε。 */
const EPS = 1e-4;

export function createAmbience({ report } = {}) {
  let ctx = null, master = null;
  let on = true, mode = 'off', booted = false, unlocked = false, failed = false;
  /** 现在响着的这一档：`{ name, made }`。 */
  let live = null;
  /** `follow()` 的排期：下一次稀疏事件 / 下一次远雷 / 已开始的时刻。 */
  let when = { startedAt: 0, next: 0, thunderAt: 0 };
  let base = null;      // 白噪声（2 秒，循环）
  let pink = null;      // 粉噪声（-3dB/oct）
  let brown = null;     // 棕噪声（-6dB/oct，风声/轰鸣的底子）
  let drift = null;     // 30 秒的慢随机游走（**包络与截止的唯一驱动源**）
  /**
   * **游走源自己的 RMS**（`layer()` 里拿它把 `swing`/`flow` 换算成 Hz 与线性增益）。
   * ⚠️ 少了它就只能像旧代码那样"猜一个 3.2 的系数"，而那正是"摆动过头/几乎不动"的根源。
   */
  let driftRms = 1;

  const enabled = () => on && unlocked && !failed;

  /** 一次性把四种噪声底子算出来（只有一条真白噪声，其余是它的积分/近似）。 */
  function makeBuffers() {
    const len = Math.floor(ctx.sampleRate * 2);
    const w = new Float32Array(len);
    for (let i = 0; i < len; i += 1) w[i] = Math.random() * 2 - 1;
    base = ctx.createBuffer(1, len, ctx.sampleRate);
    base.getChannelData(0).set(w);

    // 棕噪声：泄漏积分（保留一点泄漏，否则会漂到直流）
    const br = new Float32Array(len);
    let last = 0;
    for (let i = 0; i < len; i += 1) { last = (last + 0.02 * w[i]) / 1.02; br[i] = last * 3.5; }
    brown = ctx.createBuffer(1, len, ctx.sampleRate);
    brown.getChannelData(0).set(br);

    // 粉噪声：Paul Kellet 的 7 极点近似（每倍频程 -3dB）
    const pk = new Float32Array(len);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < len; i += 1) {
      const x = w[i];
      b0 = 0.99886 * b0 + x * 0.0555179;
      b1 = 0.99332 * b1 + x * 0.0750759;
      b2 = 0.96900 * b2 + x * 0.1538520;
      b3 = 0.86650 * b3 + x * 0.3104856;
      b4 = 0.55000 * b4 + x * 0.5329522;
      b5 = -0.7616 * b5 - x * 0.0168980;
      pk[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + x * 0.5362) * 0.11;
      b6 = x * 0.115926;
    }
    pink = ctx.createBuffer(1, len, ctx.sampleRate);
    pink.getChannelData(0).set(pk);

    /**
     * **超慢随机游走**：30 秒的棕噪声，之后被低通到 0.15~0.25Hz。
     * 它同时驱动两件事：**滤波器截止**（"风声一阵紧一阵松"）与**音量包络**（`flow`）。
     * 因为它是非周期的，所以不会像正弦 LFO 那样几秒就被听出周期。
     */
    const dl = Math.floor(ctx.sampleRate * 30);
    drift = ctx.createBuffer(1, dl, ctx.sampleRate);
    drift.getChannelData(0).set(br.subarray(0, dl));
    let ds2 = 0;
    for (let i = 0; i < dl; i += 1) ds2 += br[i] * br[i];
    driftRms = Math.max(1e-6, Math.sqrt(ds2 / dl));
  }

  function context() {
    if (failed) return null;
    if (!ctx) {
      const C = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!C) { failed = true; return null; }
      try {
        ctx = new C();
        master = ctx.createGain();
        master.gain.value = 0;
        master.connect(ctx.destination);
        makeBuffers();
      } catch (e) {
        failed = true;
        try { report?.(`环境音起不来（不影响画面）：${e && e.message}`); } catch (err) { /* ignore */ }
        return null;
      }
    }
    if (ctx.state === 'suspended' && enabled()) ctx.resume().catch(() => {});
    return ctx;
  }

  const noiseBuf = (n) => (n === 'brown' ? brown : n === 'pink' ? pink : base);

  /**
   * ⚠️ **游走源要按用途分别低通**：驱**截止**时低通到 7~12Hz（"帧级"的抖动），
   * 驱**音量包络**时必须低通到 0.15~0.25Hz（**几秒一次**的呼吸）——
   * 用同一个低通就会让音量也跟着 10Hz 抖，听起来是"颤音"，不是"风一阵紧一阵松"。
   */
  function walk(c, lpHz, made, startAt) {
    const s = c.createBufferSource();
    s.buffer = drift; s.loop = true;
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = Math.max(.05, Math.min(60, lpHz)); lp.Q.value = .7;
    s.connect(lp); s.start(startAt);
    made.nodes.push(s, lp);
    return lp;
  }

  /* ---------- 造一层（噪声 → 滤波(可两层) → 增益 → 目标） ---------- */
  function layer(c, lo, dest, made) {
    const src = c.createBufferSource();
    src.buffer = noiseBuf(lo.n); src.loop = true;
    let node = src;
    const filters = [];
    const one = [lo, lo.then].filter(Boolean);
    for (const f of one) {
      const bq = c.createBiquadFilter();
      bq.type = f.t;
      bq.frequency.value = Math.max(20, Math.min(c.sampleRate / 2 - 100, f.f || 1000));
      bq.Q.value = Math.max(0.0001, Math.min(5, f.q == null ? .7 : f.q));   // ★ Q 一律 ≤ 5
      node.connect(bq); node = bq;
      filters.push({ bq, f });
    }
    const g = c.createGain();
    g.gain.value = lo.g == null ? .1 : lo.g;                                // 线性增益（表里给的就是线性）
    node.connect(g); g.connect(dest);
    src.start();
    made.nodes.push(src, g, ...filters.map((x) => x.bq));

    /** 截止摆动 + 音量包络（主）+ 几个不可通约的慢正弦（次） */
    for (const { bq, f } of filters) {
      const baseHz = Math.max(20, Math.min(c.sampleRate / 2 - 100, f.f || 1000));
      if (lo.drift) {
        const lpHz = Array.isArray(lo.drift) ? lo.drift[0] : lo.drift;
        const dg = c.createGain();
        const sw = (lo.swing == null ? 12 : lo.swing) / 100;
        dg.gain.value = (baseHz * sw) / driftRms;      // 按"占 f 的百分比"定推进量（Hz 量纲）
        walk(c, lpHz, made, Math.random() * 20).connect(dg);
        dg.connect(bq.frequency);
        made.nodes.push(dg);
      }
      for (const [rate, depth] of (lo.lfo || [])) {
        const o = c.createOscillator(); o.type = 'sine'; o.frequency.value = rate;
        o.__lfo = true;                      // ★ 标记：这是**底噪的调制器**，不是"点缀"（自检靠它区分）
        const og = c.createGain(); og.gain.value = depth;
        o.connect(og); og.connect(bq.frequency);
        o.start();
        made.nodes.push(o, og);
      }
      void baseHz;
    }
    /**
     * ★ **音量包络**（`flow`）：跟截止摆动用的是同一条游走，但低通到 0.15~0.25Hz。
     * 这是"风/雨幕在呼吸"的来源 —— **只给主角那一层加**（见文件头第②条：
     * 一个天气里只许有一个主角，否则又是"三个东西一起动"）。
     *
     * ⚠️⚠️ **系数必须是 0.15，不是 0.4**（2026-10-11 晚上返工过一次）：
     * 游走源自己的 RMS ≈ 0.4，除以 `driftRms` 之后 **`flow: 1` 正好变成 m ≈ 1** ——
     * 那是**增益在 0~2 之间乱跑**：表现是"同一套参数每次量出来的电平差 10dB 以上"
     * （我因此在标定时白改了两轮），听感上是"声音一会儿没了、一会儿很响"。
     * 现在 `flow: 1` → m ≈ 0.37，也就是增益 1±0.37 的慢呼吸（≈ ±2.8dB）—— 听得出在动，但不会跑掉。
     */
    if (lo.flow) {
      const lp = walk(c, (lo.envHz ? lo.envHz[0] : .2), made, Math.random() * 20);
      /**
       * ★★ **必须再加一个 0.02Hz 高通**（2026-10-11 晚上第三次返工才找到的根因）。
       *
       * 游走源是**泄漏积分的棕噪声**，它带**直流偏移**：一段 10 秒窗口里可能整段偏正或偏负，
       * 于是"平均音量"随取样窗口飘 —— 表现是**电平怎么标都标不准**
       * （同一套参数连着渲两次：雨 -48.0 / -40.3、雪 -53.1 / -41.6、落叶 -48.3 / -34.1）。
       * 低通到 0.2Hz 只压高频，**直流照样原封不动传过去**。
       *
       * 现在高通把直流滤掉，包络只留"起伏"：增益以 1 为中心呼吸、**RMS 稳定**，
       * 而"一阵紧一阵松"的听感一点没少 —— 那本来就是**波动**，不是偏移。
       */
      const hp = c.createBiquadFilter();
      hp.type = 'highpass'; hp.frequency.value = .02; hp.Q.value = .7;
      const eg = c.createGain();
      eg.gain.value = (lo.flow * 0.15) / driftRms;
      lp.connect(hp); hp.connect(eg); eg.connect(g.gain);
      made.nodes.push(hp, eg);
    }
    return g;
  }

  /** 造一整档（床 + 中层），返回可以整体淡出/停掉的节点集合。 */
  function build(cfg) {
    const c = context();
    if (!c) return null;
    const made = { nodes: [], oscs: [], out: null };
    const out = c.createGain();
    out.gain.value = 0;
    /**
     * ★ **整档电平 = `EU(cfg.mixGainDb)`**（2026-10-11）：把这一档的**原始混合电平**抬到
     * `TARGET_RMS_DB`（`mixGainDb` 的定义见 `TRACKS` 上面那段）。少了它四档只有
     * -42~-55dBFS（几乎听不见、而且彼此差 12dB）。
     * ⚠️ 这里**只乘一次**；"用户音量"仍然由 `MASTER_GAIN` 与「天气声」那把开关管。
     */
    made.norm = EU(cfg.mixGainDb);
    out.connect(master);
    made.out = out;
    for (const lo of (cfg.bed || [])) layer(c, lo, out, made);
    for (const lo of (cfg.mid || [])) layer(c, lo, out, made);
    return made;
  }

  function teardown() {
    if (!live) return;
    const c = ctx, { made } = live;
    try {
      if (c && made.out) {
        made.out.gain.cancelScheduledValues(c.currentTime);
        made.out.gain.setTargetAtTime(0, c.currentTime, .12);
      }
    } catch (e) { /* ignore */ }
    const kill = () => {
      for (const n of made.nodes) {
        try { n.stop?.(); } catch (e) { /* ignore */ }
        try { n.disconnect?.(); } catch (e) { /* ignore */ }
      }
    };
    if (c) setTimeout(kill, 320); else kill();
    live = null;
  }

  /* =====================================================================================
   * 事件（前景 = 主角）
   * ===================================================================================== */

  /**
   * **一颗雨滴**（`spark: 'drop'`）。
   *
   * 用户对雨的判断标准是"雨声应该最突出"，所以这一版**把雨滴做成主角**：
   *   · 主体 = **低频冲击**（低通 1.2k 的短噪声，4ms 起音、衰减随颗粒大小 40~110ms）——
   *     这是真实雨滴打上去的"蓬"，能量压在中低频（Medwin：中/大雨滴主要辐射**冲击声**）；
   *   · 点缀 = **只有 30% 的雨滴**带一点 2.5~5k 的"碎裂"（小滴的微气泡），
   *     概率低、音量大不过主体 —— 第一版那种"每秒十几次 1.6~5.2k 带通音"才是"油锅"；
   *   · **每颗独立**的左右声场、音量、颗粒大小 —— 有变化才像雨，一成不变才像噪声。
   */
  function drop(c, made, at) {
    const large = Math.random() < .72;
    const pan = Math.random() * 2 - 1;
    const vol = (large ? .38 : .22) * (.7 + Math.random() * .6);
    burst(c, {
      t: 'lowpass', f: 1400 + Math.random() * 900, f1: 320 + Math.random() * 200,
      q: .7, dur: (large ? .055 : .03) + Math.random() * .05, vol, attack: .0015, pan, at,
    }, made);
    if (Math.random() < (large ? .3 : .55)) {
      burst(c, {
        t: 'bandpass', f: 2600 + Math.random() * 2400, q: 2.5,
        dur: .014 + Math.random() * .014, vol: vol * .3, attack: .001, pan, at: at + .002 + Math.random() * .01,
      }, made);
    }
  }

  /**
   * **一阵风**（`spark: 'gust'`）：0.8~1.8 秒的**慢起慢落**，不是"啪"。
   * 它落在 240~520Hz（跟中层同一个频段，像是中层紧了一下），偶尔把声场推过去。
   */
  function gust(c, made, at) {
    burst(c, {
      n: 'brown', t: 'bandpass', f: 240 + Math.random() * 260, q: .7,
      dur: .8 + Math.random() * 1.0, vol: .16 + Math.random() * .12, attack: .35,
      pan: Math.random() * 1.2 - .6, at,
    }, made);
  }

  /**
   * **一片叶子擦过**（`spark: 'leaf'`）：0.35~0.6 秒的**宽频抓挠**，
   * 由 7~10 个极短的带通爆点串起来（擦过时的"沙沙沙"），
   * 而且**在声场里从一边移到另一边** —— 这是"动作"而不是"一段噪声"。
   */
  function leafRustle(c, made, at) {
    const n = 6 + Math.floor(Math.random() * 5);
    const dir = Math.random() < .5 ? -1 : 1;
    const pan0 = -dir * (.3 + Math.random() * .5);
    const span = .3 + Math.random() * .25;
    const vol = .16 + Math.random() * .12;
    for (let i = 0; i < n; i += 1) {
      const k = i / n;
      burst(c, {
        t: 'bandpass', f: 900 + Math.random() * 3200, f1: 700 + Math.random() * 2200, q: 1.1,
        dur: .03 + Math.random() * .05, vol: vol * (.5 + Math.random() * .7),
        attack: .004, pan: pan0 + dir * k * span, at: at + k * (.3 + Math.random() * .05),
      }, made);
    }
  }

  /**
   * **一声鸟叫**（`spark: 'bird'`）：**带通扫频的"啾-溜"**，
   * 比上一版的正弦滑音自然得多（真实鸟叫是共振腔扫频，不是纯音）。
   * 2~4 声一串，间隔与音高随机，落在 2~5k —— **避开**雨滴与风声的频段。
   */
  function bird(c, made, at, range) {
    const [lo, hi] = (range && range.f0) || [2300, 3400];
    const [s0, s1] = (range && range.sweep) || [.55, .85];
    const base = lo + Math.random() * (hi - lo);
    const k = 2 + Math.floor(Math.random() * 3);
    const pan = Math.random() * 1.4 - .7;
    for (let i = 0; i < k; i += 1) {
      const f0 = base * (.94 + Math.random() * .12);
      const up = i === 0;                                  // 第一声上滑（"啾"），后面下滑（"溜"）
      const dur = (up ? .07 : .09) + Math.random() * .06;
      const at2 = at + i * (.13 + Math.random() * .08);
      burst(c, {
        t: 'bandpass', f: f0, f1: f0 * (up ? 1.18 : (s0 + Math.random() * (s1 - s0))), q: 3.5,
        dur, vol: .10 + Math.random() * .06, attack: .012, pan, at: at2,
      }, made);
      // 更轻的第二共振峰：让"啾"有厚度（纯噪声扫频听着像口哨）
      burst(c, {
        t: 'bandpass', f: f0 * 1.5, f1: f0 * 1.5 * (up ? 1.1 : .9), q: 2.5,
        dur, vol: .04, attack: .014, pan, at: at2,
      }, made);
    }
  }

  /** 远雷：闷、低、慢（长低通冲击 + 一条更低的正弦）。 */
  function thunder(c, made, at) {
    burst(c, { n: 'brown', t: 'lowpass', f: 240, f1: 70, q: .4, dur: 2.6, vol: .2, attack: .5, pan: Math.random() * 1.6 - .8, at }, made);
    burst(c, { n: 'brown', t: 'bandpass', f: 58, q: 2, dur: 2.2, vol: .1, attack: .6, pan: Math.random() * 1.2 - .6, at: at + .1 }, made);
  }

  /**
   * ⚠️ **稀疏事件排期**（2026-10-11 改过语义）：`every` 现在是**"两次事件之间"**，
   * 而且 `follow()` 一帧**最多放一次** —— 上一版在 `every` 很小（雨 0.10~0.26）时，
   * 一帧里可能连排好几颗，密度一抖就"糊"；现在严格按时间推进。
   */
  function spark(cfg, c, at) {
    const made = live && live.made;
    if (!made) return 0;
    switch (cfg.spark) {
      case 'drop': { drop(c, made, at); return 1; }
      case 'gust': { gust(c, made, at); return 1; }
      case 'leaf': { leafRustle(c, made, at); return 1; }
      case 'bird': { bird(c, made, at, cfg.bird); return 1; }
      default: return 0;
    }
  }

  /* =====================================================================================
   * 一次"冲击"（所有前景事件的公共出口）
   * ===================================================================================== */
  /**
   * 短噪声脉冲：2~4ms 起音 + 指数衰减 + 独立左右声场。
   * `f1` 给了就做频率滑（雨滴的下滑、鸟叫的扫频、叶子擦过的移动都靠它）。
   */
  function burst(c, o, made) {
    if (!made) return;
    try {
      const t0 = c.currentTime + Math.max(0, o.at || 0);
      const s = c.createBufferSource(); s.buffer = noiseBuf(o.n || 'white'); s.loop = true;
      const bq = c.createBiquadFilter();
      bq.type = o.t || 'bandpass';
      bq.Q.value = Math.min(5, o.q == null ? 1 : o.q);
      bq.frequency.setValueAtTime(Math.max(20, o.f == null ? 2000 : o.f), t0);
      if (o.f1 && o.f1 !== o.f) bq.frequency.exponentialRampToValueAtTime(Math.max(40, o.f1), t0 + (o.dur || .05));
      const g = c.createGain();
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(o.vol == null ? .1 : o.vol, t0 + (o.attack || .003));   // ★ 冲击感来自这几毫秒
      g.gain.exponentialRampToValueAtTime(EPS, t0 + (o.dur || .05));
      const p = c.createStereoPanner ? c.createStereoPanner() : null;
      if (p) { p.pan.value = Math.max(-1, Math.min(1, o.pan || 0)); s.connect(bq); bq.connect(g); g.connect(p); p.connect(made.out); }
      else { s.connect(bq); bq.connect(g); g.connect(made.out); }
      s.start(t0, Math.random() * 1.5);
      s.stop(t0 + (o.dur || .05) + .05);
      made.nodes.push(s, bq, g, ...(p ? [p] : []));
    } catch (e) { /* ignore */ }
  }

  const api = {
    /**
     * 用户手势之后调一次（页面在 `sfx.unlock()` 旁边一起调）。**只解锁，不出声** ——
     * 出不出声由 `follow()`/`switchTo()` 按当前天气决定。
     */
    unlock() {
      unlocked = true;
      const c = context();
      if (c && c.state === 'suspended' && enabled()) c.resume().catch(() => {});
    },
    /** 开/关（页面那边是「声音」总闸 × 右键菜单「天气声」两层的与）。 */
    setEnabled(v) {
      on = !!v;
      if (!ctx || !master) return;
      try {
        const c = ctx;
        master.gain.cancelScheduledValues(c.currentTime);
        master.gain.setTargetAtTime(on ? MASTER_GAIN : 0, c.currentTime, .25);
        if (on && enabled()) ctx.resume().catch(() => {});
        else if (!on) setTimeout(() => { if (!on && ctx && ctx.state === 'running') ctx.suspend().catch(() => {}); }, 600);
      } catch (e) { /* ignore */ }
    },
    /**
     * 每帧调一次（页面在 `stepWeather` 里）。连续底噪归 `switchTo()` 管，
     * 这里只排**前景事件**（雨滴、叶子擦过、鸟叫、风紧一下、远雷）；返回这一帧放了几个音。
     *
     * ⚠️ **一帧最多一个事件**：`every` 最小是 0.065 秒，一帧 16.7ms，正常情况下本来就是
     * "有时候一帧一个、有时候没有"；加这个上限是为了防止**卡顿一下（dt 变大）之后一帧里
     * 补上一串雨滴** —— 那种"突然一坨"正是"糊"的听感来源之一。
     */
    follow(modeName, dt, now) {
      if (!enabled()) return 0;
      const name = TRACKS[modeName] ? modeName : null;
      if (name !== mode) { mode = name || 'off'; api._apply(); }
      if (!live || !name) return 0;
      const cfg = TRACKS[name];
      const c = ctx;
      let played = 0;
      if (!when.startedAt) when.startedAt = now;
      if (!when.next) when.next = now + rnd(cfg.every[0], cfg.every[1]);
      if (now >= when.next) {
        // 到点之后按"错过的整周期"往前推，但**这一帧只放一个**
        while (when.next <= now) when.next += rnd(cfg.every[0], cfg.every[1]);
        played += spark(cfg, c, 0);
      }
      if (cfg.thunder) {
        if (!when.thunderAt) when.thunderAt = now + rnd(cfg.thunder[0], cfg.thunder[1]);
        if (now >= when.thunderAt) {
          when.thunderAt = now + rnd(cfg.thunder[0], cfg.thunder[1]);
          thunder(c, live.made, 0);
          played += 2;
        }
      }
      void dt;
      return played;
    },
    /** 直接把环境音切到某种天气（页面切天气时立刻叫一次）。 */
    switchTo(modeName) {
      mode = TRACKS[modeName] ? modeName : 'off';
      api._apply();
    },
    _apply() {
      const cfg = TRACKS[mode];
      if (!enabled() || !cfg) { teardown(); when.next = 0; when.thunderAt = 0; return; }
      const c = context();
      if (!c) return;
      if (live && live.name === mode) {
        try { live.made.out.gain.setTargetAtTime(live.made.norm, c.currentTime, .5); } catch (e) { /* ignore */ }
        return;
      }
      teardown();
      const made = build(cfg);
      if (!made) return;
      live = { name: mode, made, cfg };
      /** ★ 淡入的目标是 `EU(mixGainDb)`（不是 1）—— 见 `build()` 里 `norm` 的说明。 */
      try { made.out.gain.setTargetAtTime(made.norm, c.currentTime, 1.2); } catch (e) { /* ignore */ }
      when.next = 0; when.thunderAt = 0;
    },
    /**
     * 诊断：`on` 是**用户开关**，`silent` 才是"现在到底出不出声"
     * （`on = true` 但 `silent = true` 说明还没拿到手势，或宿主把它挂起了）。
     */
    state: () => ({
      on, unlocked, mode, live: !!live, ctx: ctx ? ctx.state : 'none', failed,
      silent: !(on && unlocked && !failed && live && !!ctx && ctx.state === 'running'),
      master: MASTER_GAIN,
      /** 这一档的归一化倍数与目标电平（排查"声音太小/太大"时不用猜）。 */
      norm: live ? +live.made.norm.toFixed(2) : null,
      target: TARGET_RMS_DB,
      /** 这一档的主角是什么（给诊断页显示用）。 */
      spark: live ? live.cfg.spark : null,
    }),
  };
  return api;
}

const rnd = (a, b) => a + Math.random() * (b - a);

/**
 * ★ **把音色表和总增益暴露出去**（2026-10-11 加），只给一个用途：**离线验收**。
 *
 * `dev-weather\sound.html` 拿它做三件事，都不改运行时的行为：
 *   ① 在 `OfflineAudioContext` 里把四种天气各渲一遍，存成 wav 给你**用耳朵**判；
 *   ② 对渲出来的样本做 FFT，把**客观数字**摆出来（RMS、峰值、频段占比、频谱重心）；
 *   ③ **前景显著性**：把所有前景事件静音再渲一遍，两次 RMS 差多少 dB ——
 *      这是"一个天气有没有主角"唯一能量化的判据（用户要的就是"雨声应该最突出"）。
 *
 * ⚠️ 它**不在运行路径上**（桌宠永远不 import 它），所以改它不会影响她出声。
 */
export const TRACKS_INFO = TRACKS;
export { MASTER_GAIN, TARGET_RMS_DB, EU };
