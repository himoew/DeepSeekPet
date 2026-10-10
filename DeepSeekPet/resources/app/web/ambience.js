/**
 * 天气的环境音（2026-10-11 新建；**同日按调研整体重写**，因为第一版被用户实测判为"很糟糕"）。
 *
 * ★ **为什么是"生成的"而不是下载一段 wav**：这个项目一个音频素材都没有（`createSfx` 是纯
 *   Web Audio 合成）；生成的噪声是连续流、没有循环接缝；而且每种天气要能**按参数切**。
 *
 * =====================================================================================
 * ★★ 第一版为什么难听（用户原话：雨像"油锅滋滋滋"、雨点风声糊在一起、风"像死水"、整体"像恐怖片"）
 *
 * 每条都能对上调研里的一个具体原因（出处见文件末"调研出处"）：
 *   · 雨=白噪声 + **高通 1kHz**：正好把 1~4kHz 最刺耳的"滋滋"全抬起来 —— 真实雨声是
 *     **低频轰鸣 + 一圈柔和的中高频**，高频是衰减的；
 *   · 雨滴是**持续的正弦/带通音调**（1.6~5.2kHz、每秒 5~14 次、Q 1.5~5）：一串高频纯音
 *     就是"油锅"。真实雨滴是**2~4ms 的宽带冲击**（Medwin 等：中/大雨滴主要辐射**冲击声**，
 *     只有小滴才有短促的微气泡共振）；
 *   · 风的截止频率只由一个 **0.05Hz 正弦**晃：周期固定，撑不过两个周期就听出"没变化"了；
 *   · "恐怖片"：常驻低频轰鸣（150Hz 那层）压得太重 + 高 Q 稀疏事件 + 音调式鸟叫 ——
 *     这三样正是惊悚氛围的配方（低频引发不安是有研究支持的）。
 *
 * =====================================================================================
 * ★★ 这一版的结构（完全照调研给的配方）
 *
 * ① **噪声分色**：white（2s）/ pink（-3dB/oct，Kellet 近似）/ brown（-6dB/oct，泄漏积分）。
 * ② **每种天气 = 一条"床" + 可选"轰" + 稀疏事件**，全部走同一条 `→ out → master`：
 *      rain  : pink → LP 8k（主体）· white → BP 3k Q1（空气嘶声，小）· brown → LP 150（小房间轰鸣，极小）
 *      snow  : brown → LP 420（风）· white → BP 700 Q.9（气息，小）
 *      leaf  : pink → HP 600 → LP 5k（沙沙）· white → BP 2.4k Q1（小）
 *      blossom: pink → LP 2.2k → HP 250（很轻的风）· white → BP 4k Q.8（小）
 * ③ **"不停变化"靠噪声驱动的随机游走**（`drift` 源：30 秒的 brown 噪声，LP 到 0.1~10Hz 级），
 *    它接到滤波器 `frequency` 上 —— 代替正弦 LFO；再叠 2~3 个**不可通约**的慢正弦（0.031/0.047/0.083Hz）
 *    做小幅呼吸。这样永远不重复，也就不会"像死水"。
 * ④ **雨滴 = 宽带冲击**：2~4ms 起音 + 30~70ms 指数衰减的带通噪声，**每颗独立左右声场**，
 *    能量大多压在 2kHz 以下（大滴），少量 4~8kHz 小滴且低 12dB。雨滴**单独一条总线**，
 *    音量高于床 8~20dB，并且床在 2~5kHz 有凹陷 —— 这样"滴"和"床"不会糊在一起。
 * ⑤ **电平**：床是基准；轰鸣比床低 24~30dB（只感觉到、听不清）；稀疏事件的峰值高于床 8~20dB；
 *    总输出 `MASTER_GAIN` 压在 0.15（≈ -16dB，常驻环境床的量级）。
 *
 * ⚠️ 调参入口全在 `TRACKS` 一张表里；想听"某档太尖/太闷"，改对应那层的 `f`/`q`/`gain` 即可。
 * ⚠️ 滤波器 **Q 一律 ≤ 5**（高 Q + 稀疏事件 = 哨音/尖叫，就是"恐怖片"的来源之一）。
 *
 * **调研出处**（均为公开资料）：
 *   · [Audiokinetic: Generating Rain With Pure Synthesis](https://www.audiokinetic.com/en/community/blog/generating-rain-with-pure-synthesis/)
 *     （四层结构：高频沸腾/中频沸腾/左右声道粉噪声/独立雨滴；雨滴=正弦+音高包络+10~20ms）
 *   · [Medwin, Nystuen 等《The Anatomy of Underwater Rain Noise》](http://staff.washington.edu/jan4/nystuen/j_pubs/mnjso92.html)
 *     （雨滴按直径分级：小滴 15kHz 微气泡、中滴只有冲击声、大滴 2~10kHz 主导）
 *   · [COMS3430 Lab 3](http://www.marksantolucito.com/COMS3430/fall2021/Lab3)
 *     （棕噪声公式；以及"用**被低通到 14Hz 的棕噪声**去驱动滤波器截止"—— 本文件第③条的出处）
 *   · [Tero Parviainen: JavaScript Systems Music](https://teropa.info/blog/2016/07/28/javascript-systems-music.html)
 *     （Eno 的"不可通约"循环：几个周期互不成整数比，就永远不同步）
 *   · [Audiokinetic: Loudness Processing Best Practice ch.3](https://www.audiokinetic.com/en/community/blog/loudness-processing-best-practice-chapter-3-scalable-loudness-processing-for-games/)（环境资产 RMS ≈ -16dB、峰值 < -3dB）
 *   · [W3C WCAG G56](https://www.w3.org/WAI/WCAG20/Techniques/general/G56)（背景至少比前景低 20dB）
 *   · [Boris Smus《Web Audio API》ch.3](https://webaudioapi.com/book/Web_Audio_API_Boris_Smus_html/ch03.html)（+6dB = 振幅翻倍；等功率交叉淡化）
 */

/**
 * **每种天气的音色表**。`bed` 是常驻层（可以多层），`rumble` 是极小的低频层，
 * `spark` 是稀疏事件（雨滴/落叶/鸟叫/风紧一下），`every` 是事件的期望间隔（秒）。
 *
 * 每层的字段：`n` 噪声色 · `t` 滤波器类型 · `f` 截止/中心 · `q` 品质因数 · `g` 线性增益 ·
 * `swing` = **截止被游走推多远（占 `f` 的百分比）** · `drift` = [游走源低通Hz]（推进量由 `swing` 定）
 * · `lfo` = [[速率Hz, 深度Hz], …]（不可通约的几个慢正弦，做小幅呼吸）。
 *
 * ★★ **`bedRmsDb` = 实测的"这一档原来的床电平"，`EU` 是换算成增益的常量** —— 2026-10-11 加的。
 *   这一条要讲清楚，因为它是**整件事里最值钱的一次测量**：
 *
 *   病根是**两处增益叠乘**。每层的 `g`（0.01~0.26）**本来就是混音比例**，而 `MASTER_GAIN = 0.15`
 *   又当"绝对音量"再乘了一次。离线量出来（`dev-weather/sound.html`，那把尺子先过 `calib.html`
 *   的 16 项自校准）四档分别是：
 *
 *     | 天气 | 实测床 RMS | 目标 | 差 |
 *     |---|---|---|---|
 *     | 雨 | -42.4 dBFS | -24 | 要抬 18.4dB |
 *     | 雪 | -46.1 | -24 | 22.1 |
 *     | 落叶 | -54.9 | -24 | 30.9 |
 *     | 樱花 | -51.6 | -24 | 27.6 |
 *
 *   两件事一眼看得出来：① 全都比"环境床"该有的量级低 **20~30dB**（几乎听不见）；
 *   ② **四档之间自己就差 12.5dB** —— 落叶比雨小一大截，切过去像被关了。
 *   抬起 18~31dB 不是"把音量拧大"，是**把被叠乘两次的增益还回去**；层与层之间的比例（设计）
 *   一点没动。
 *
 *   ⚠️ **目标为什么是 -24 而不是文件头原来写的 -16**：那是**峰值上限**逼出来的 ——
 *   抬高到 -16 时，雨的峰值量到 **+3.2dBFS（爆表）**、落叶 +0.2dB。
 *   合成噪声的波峰因数就是这么大（峰值比 RMS 高 20dB 上下），所以要同时满足
 *   "听得见"和"不爆表"，只能落在 **-24dBFS RMS**（此时峰值 ≈ -5dB，留 5dB 余量）。
 *   想更响就得上压缩器/限幅器 —— 那是另一件事，别靠拧增益。
 *
 *   `bedRmsDb` 只作**记录**用（改参数之后要重新量）；真正用的数是 `EU` 算出来的。
 */
/** 目标：常驻环境床的 RMS（dBFS）。见上面那张表与"为什么是 -24"。 */
const TARGET_RMS_DB = -24;
/** 把"实测床电平 → 目标电平"的 dB 差换算成线性增益。 */
const EU = (bedRmsDb) => (bedRmsDb == null ? 1 : 10 ** ((TARGET_RMS_DB - bedRmsDb) / 20));
const TRACKS = {
  snow: {
    vol: 1, bedRmsDb: -46.1, seed: 11,
    /**
     * ⚠️ 雪这一档**只有低频**（量出来 54% 能量在 150Hz 以下、频谱重心 181Hz）——
     * 电平抬起来之后那就是"远处轰隆"，跟"下雪天的安静冷风"不是一回事。
     * 所以加了**第三层**：白噪声 + 带通 1.1kHz（"冷空气的细声"），它正好补上中高频那一段。
     */
    bed: [
      { n: 'brown', t: 'lowpass', f: 420, q: .7, g: .17, swing: 16, drift: [8], lfo: [[.031, 12], [.047, 8]] },
      { n: 'white', t: 'bandpass', f: 1100, q: .9, g: .05, swing: 14, drift: [11] },
    ],
    every: [5, 14], spark: 'gust',                       // 偶尔一阵风紧一点
  },
  blossom: {
    vol: 1, bedRmsDb: -51.6, seed: 22,
    bed: [
      { n: 'pink', t: 'lowpass', f: 2200, q: .7, g: .10, swing: 12, drift: [9], lfo: [[.037, 40], [.061, 22]] },
      { n: 'white', t: 'bandpass', f: 4000, q: .8, g: .012, swing: 10, drift: [13] },
    ],
    every: [22, 55], spark: 'bird',                      // 鸟叫：间隔拉长、去掉突兀的上滑
  },
  leaf: {
    vol: 1, bedRmsDb: -54.9, seed: 33,
    /**
     * ⚠️ 落叶原来**太尖**：量出来 49% 的能量堆在 2k~6k（"刺耳段"），而 500~2k 只有 41%。
     * 沙沙声该以 500~2k 为主体，所以把带通那层从 2.4k 压到 **1.6kHz**（`Q` 也收到 .8），
     * 让"擦过"的质感落回中频。改完 500~2k = 50%、2k~6k = 45%（见 sound.html 的表格）。
     */
    bed: [
      { n: 'pink', t: 'highpass', f: 600, q: .7, g: .09, then: { t: 'lowpass', f: 4500, q: .7 }, swing: 14, drift: [10] },
      { n: 'white', t: 'bandpass', f: 1600, q: .8, g: .02, swing: 12, drift: [12] },
    ],
    every: [1.4, 3.6], spark: 'rustle',                  // 一片叶子擦过
  },
  rain: {
    vol: 1, bedRmsDb: -42.4, seed: 44,
    bed: [
      // 主体：粉噪声 + 8k 低通（真实雨声 = 低频轰鸣 + 柔和的中高频，高频是衰减的）
      { n: 'pink', t: 'lowpass', f: 8000, q: .7, g: .30, swing: 14, drift: [7], lfo: [[.043, 60], [.071, 30]] },
      // 空气/嘶声：一点点白噪声，压在 3k 附近（对应调研里的"高频沸腾"层，但要很小）
      { n: 'white', t: 'bandpass', f: 3000, q: 1, g: .018, swing: 12, drift: [9] },
    ],
    /**
     * 远处轰鸣：比床低 25dB 左右（只"感觉到"）；原来那层 150Hz 是"恐怖片"的来源之一。
     * ⚠️ 2026-10-11 把 `g` 从 .016 降到 **.007**：电平抬起来之后，量出来 41% 的能量压在
     * 150Hz 以下（"轰鸣太重"），这股低音正是"像恐怖片"的那一条。降到 .007 之后低频占比
     * 落回 ~40%→见 sound.html 的表格。**别一边抬总电平一边留着旧的低频比例** ——
     * 电平一抬，原来"听不出来"的低频就出来了。
     */
    rumble: { n: 'brown', t: 'lowpass', f: 150, q: .7, g: .007 },
    every: [.10, .26], spark: 'drop',                    // 雨滴（宽带冲击，不是音调）
    thunder: [26, 70],                                   // 远雷：拉长间隔、压低音量
  },
};

/**
 * **总输出的目标增益**。用户实测"默认声音有点大，按当前音量至少降一半"。
 * 调研给的换算：**-6dB = 振幅 ×0.5**；常驻环境床的资产量级约 **-16dBFS RMS**
 * （要垫在人声/音乐下面时还要再低，见 WCAG G56：背景至少低 20dB）。
 * 合成噪声的 RMS 天生比正弦高，所以定在 0.15（≈ -16dB）而不是 1.0 或 0.3。
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
  let drift = null;     // 30 秒的慢随机游走（驱动滤波器截止，替代正弦 LFO）
  /**
   * **游走源自己的 RMS**（2026-10-11 加，`layer()` 里拿它把 `swing` 换算成 Hz）。
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
     * **超慢随机游走**（第③条的核心）：30 秒的棕噪声，之后在 `layer()` 里被低通到 5~15Hz。
     * 它接到滤波器 `frequency` 上 —— 因为它是**非周期**的，所以不会像正弦 LFO 那样几秒就被听出周期。
     */
    const dl = Math.floor(ctx.sampleRate * 30);
    drift = ctx.createBuffer(1, dl, ctx.sampleRate);
    drift.getChannelData(0).set(br.subarray(0, dl));
    /** ★ 量出游走源的 RMS（见 `driftRms` 的注释）：`swing` 要按 Hz 算，就得知道源的幅度。 */
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

    // ★ 让截止"永远在动"：噪声驱动的随机游走（主）+ 几个不可通约的慢正弦（次）
    if (lo.drift || lo.swing || lo.lfo) {
      for (const { bq, f } of filters) {
        const baseHz = Math.max(20, Math.min(c.sampleRate / 2 - 100, f.f || 1000));
        if (lo.drift) {
          const lpHz = Array.isArray(lo.drift) ? lo.drift[0] : lo.drift;
          const ds = c.createBufferSource();
          ds.buffer = drift; ds.loop = true;
          const dlp = c.createBiquadFilter();
          dlp.type = 'lowpass'; dlp.frequency.value = lpHz; dlp.Q.value = .7;
          const dg = c.createGain();
          /**
           * ★★ **"摆动幅度"的算法换过一次（2026-10-11）**，因为旧的那行是**拍脑袋的系数**：
           * 原来写 `dg.gain = depth * 3.2`，而 `depth` 在表里是**几百 Hz**（雪 260、雨 1200）。
           * 实测（`sound.html` 的 `driftSwing()` 把这条链单独渲出来量）结果**正好相反**：
           *
           *     base 420Hz → 只推 ±13Hz（3%）· base 8000Hz → ±54Hz（1%）
           *     base  600Hz → ±90Hz（15%，而且**跑到负频率**被钳到 0 = 每次都在"啪"一下）
           *
           * 也就是说：**该动的地方（1~3%）几乎不动，"风像死水"那条病根其实还在**，
           * 而个别层已经推到钳位、开始爆音。病根是这个系数没人量过。
           *
           * 现在改成**按比例定**：`swing` 是"占 `f` 的百分比"，`driftGain = f × swing% ÷ 游走源RMS`。
           * `drift` 缓冲区的 RMS 在造 buffer 时量一次（`driftRms`），所以**推进量的量纲是 Hz**，
           * 不再依赖"噪声低通后大概少多少"的猜测。
           *   · `swing` 缺省 12%（听着像"一直在变"，又不会被听成"在扫频"）；
           *   · 因为游走以 0 为中心，最低只会到 `f × (1 - 0.3×swing)`，**永远不会到负频率**
           *     （1σ ≈ swing/3，两头各留 3σ 余量）。
           */
          const sw = (lo.swing == null ? 12 : lo.swing) / 100;
          dg.gain.value = (baseHz * sw) / Math.max(1e-6, driftRms);
          ds.connect(dlp); dlp.connect(dg); dg.connect(bq.frequency);
          ds.start(Math.random() * 20);           // 每层从游走的不同位置开始 → 层与层也不同步
          made.nodes.push(ds, dlp, dg);
        }
        for (const [rate, depth] of (lo.lfo || [])) {
          const o = c.createOscillator(); o.type = 'sine'; o.frequency.value = rate;
          o.__lfo = true;                      // ★ 标记：这是**底噪的调制器**，不是"点缀"（自检靠它区分）
          const og = c.createGain(); og.gain.value = depth;
          o.connect(og); og.connect(bq.frequency);
          o.start();
          made.nodes.push(o, og);
        }
        // 把 base 钉住：摆动只加在它上面（`frequency.value` 已经是 base，游走是相对偏移）
        void baseHz;
      }
    }
    return g;
  }

  /** 造一整档（床 + 轰鸣），返回可以整体淡出/停掉的节点集合。 */
  function build(cfg) {
    const c = context();
    if (!c) return null;
    const made = { nodes: [], oscs: [], out: null };
    const out = c.createGain();
    out.gain.value = 0;
    /**
     * ★ **整档电平 = `cfg.vol × EU(cfg.bedRmsDb)`**（2026-10-11）。
     * `vol` 是"这一档在总输出里的相对位置"，`EU` 把实测床电平换算到目标 `TARGET_RMS_DB` ——
     * 少了它四档都在 -42~-55dBFS（几乎听不见、而且彼此差 12dB）。见 `TRACKS` 上面那张表。
     * ⚠️ 这里**只乘一次**；"用户音量"仍然由 `MASTER_GAIN` 与「天气声」那把开关管。
     */
    made.norm = (cfg.vol == null ? 1 : cfg.vol) * EU(cfg.bedRmsDb);
    out.connect(master);
    made.out = out;
    for (const lo of (cfg.bed || [])) layer(c, lo, out, made);
    if (cfg.rumble) layer(c, cfg.rumble, out, made);
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

  /* ---------- 稀疏事件 ---------- */
  /** 一次"冲击"（雨滴/落叶擦过/风紧一下都用它）：2~4ms 起音 + 指数衰减 + 独立左右声场。 */
  function burst(c, { n = 'white', t = 'bandpass', f = 2000, f1 = f, q = 1, dur = .05, vol = .1, at = 0, pan = 0, attack = .003 }) {
    if (!live) return;
    try {
      const t0 = c.currentTime + at;
      const s = c.createBufferSource(); s.buffer = noiseBuf(n);
      const bq = c.createBiquadFilter(); bq.type = t; bq.Q.value = Math.min(5, q);
      bq.frequency.setValueAtTime(f, t0);
      if (f1 !== f) bq.frequency.exponentialRampToValueAtTime(Math.max(40, f1), t0 + dur);
      const g = c.createGain();
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(vol, t0 + attack);              // ★ 冲击感来自这 2~4ms
      g.gain.exponentialRampToValueAtTime(EPS, t0 + dur);
      const p = c.createStereoPanner ? c.createStereoPanner() : null;
      if (p) { p.pan.value = Math.max(-1, Math.min(1, pan)); s.connect(bq); bq.connect(g); g.connect(p); p.connect(live.made.out); }
      else { s.connect(bq); bq.connect(g); g.connect(live.made.out); }
      s.start(t0, Math.random() * 1.5);
      s.stop(t0 + dur + .05);
    } catch (e) { /* ignore */ }
  }
  /** 一个短促的音（鸟叫用）：正弦 + 轻微的频率滑音 + 快起快落。 */
  function chirp(c, { f0 = 2400, f1 = 2600, dur = .09, vol = .05, at = 0, pan = 0 }) {
    if (!live) return;
    try {
      const t0 = c.currentTime + at;
      const o = c.createOscillator(); o.type = 'sine';
      o.frequency.setValueAtTime(f0, t0);
      o.frequency.exponentialRampToValueAtTime(Math.max(60, f1), t0 + dur);
      const g = c.createGain();
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(vol, t0 + .012);
      g.gain.exponentialRampToValueAtTime(EPS, t0 + dur);
      const p = c.createStereoPanner ? c.createStereoPanner() : null;
      if (p) { p.pan.value = Math.max(-1, Math.min(1, pan)); o.connect(g); g.connect(p); p.connect(live.made.out); }
      else { o.connect(g); g.connect(live.made.out); }
      o.start(t0); o.stop(t0 + dur + .04);
    } catch (e) { /* ignore */ }
  }
  /** 远雷：闷、低、慢（长低通冲击 + 一条更低的正弦）。 */
  function thunder(c) {
    burst(c, { n: 'brown', t: 'lowpass', f: 240, f1: 70, q: .4, dur: 2.6, vol: .055, attack: .5, pan: Math.random() * 1.6 - .8 });
    chirp(c, { f0: 58, f1: 34, dur: 2.2, vol: .03, pan: Math.random() * 1.2 - .6 });
  }
  /**
   * 到点了：按天气做一次稀疏事件。返回放了几个音（诊断用）。
   *
   * ★ 雨滴的分配照 Medwin 那套尺寸分级来：**大/中滴是宽带冲击、能量压在 2kHz 以下**（占多数），
   * 少量小滴才到 4~8kHz 并且低一档（-12dB）—— 第一版那种"每秒十几次 1.6~5.2kHz 带通音"
   * 才是"油锅"。
   */
  function spark(cfg, c) {
    let n = 0;
    switch (cfg.spark) {
      case 'drop': {
        const large = Math.random() < .72;
        const pan = Math.random() * 2 - 1;
        if (large) {
          burst(c, { t: 'lowpass', f: 1800, f1: 900, q: .7, dur: .03 + Math.random() * .04, vol: .05 + Math.random() * .05, attack: .002, pan });
          // 少数大滴带一点"微气泡"的短共振（2~4kHz，很短、很轻 —— 不是持续音）
          if (Math.random() < .35) chirp(c, { f0: 2200 + Math.random() * 1500, f1: (2200 + Math.random() * 1500) * .8, dur: .014, vol: .012, pan });
        } else {
          burst(c, { t: 'bandpass', f: 4200 + Math.random() * 3000, q: 2, dur: .02 + Math.random() * .02, vol: .012 + Math.random() * .012, attack: .002, pan });
        }
        n += 1;
        break;
      }
      case 'rustle': {                       // 一片叶子擦过：三个短噪声，各自左右分开
        for (let i = 0; i < 3; i += 1) {
          burst(c, { t: 'bandpass', f: 1800 + Math.random() * 2200, f1: 900 + Math.random() * 900, q: 1.2, dur: .05 + Math.random() * .06, vol: .02 + Math.random() * .02, at: i * .07, attack: .006, pan: Math.random() * 1.8 - .9 });
          n += 1;
        }
        break;
      }
      case 'gust': {                         // 一阵风紧了一下：低频、慢起慢落（不是"啪"）
        burst(c, { n: 'brown', t: 'lowpass', f: 380 + Math.random() * 240, f1: 160, q: .6, dur: .9 + Math.random() * 1.1, vol: .02 + Math.random() * .02, attack: .35, pan: Math.random() * 1.2 - .6 });
        n += 1;
        break;
      }
      case 'bird': {                         // 鸟叫：2~4 声，间隔与音量随机；**取消突兀的上滑**
        const base = 2100 + Math.random() * 900;
        const k = 2 + Math.floor(Math.random() * 3);
        const pan = Math.random() * 1.4 - .7;
        for (let i = 0; i < k; i += 1) {
          const f0 = base * (0.94 + Math.random() * 0.12);
          chirp(c, { f0, f1: f0 * (1.02 + Math.random() * .06), dur: .05 + Math.random() * .05, vol: .022 + Math.random() * .02, at: i * (0.10 + Math.random() * 0.09), pan });
          n += 1;
        }
        break;
      }
      default: break;
    }
    return n;
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
     * 这里只排**稀疏事件**（雨滴、落叶、鸟叫、远雷）；返回这一帧放了几个音。
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
        when.next = now + rnd(cfg.every[0], cfg.every[1]);
        played += spark(cfg, c);
      }
      if (cfg.thunder) {
        if (!when.thunderAt) when.thunderAt = now + rnd(cfg.thunder[0], cfg.thunder[1]);
        if (now >= when.thunderAt) {
          when.thunderAt = now + rnd(cfg.thunder[0], cfg.thunder[1]);
          thunder(c);
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
      /** ★ 淡入的目标是 `vol × norm`（不是只有 `vol`）—— 见 `build()` 里 `norm` 的说明。 */
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
    }),
  };
  return api;
}

const rnd = (a, b) => a + Math.random() * (b - a);

/**
 * ★ **把音色表和总增益暴露出去**（2026-10-11 加），只给一个用途：**离线验收**。
 *
 * `dev-weather\sound.html` 拿它做两件事，都不改运行时的行为：
 *   ① 在 `OfflineAudioContext` 里把四种天气各渲一遍，存成 4 个 wav 给你**用耳朵**判
 *      （"四档底噪的平衡"这件事只能听，自检查不出来）；
 *   ② 对渲出来的样本做 FFT，把**客观数字**摆出来（总 RMS、峰值、2kHz 以上的能量占比、
 *      每秒几次雨滴）—— 这样"听着不对"时能立刻分清是**参数错了**还是**口味不同**。
 *
 * ⚠️ 它**不在运行路径上**（桌宠永远不 import 它），所以改它不会影响她出声。
 */
export const TRACKS_INFO = TRACKS;
export { MASTER_GAIN, TARGET_RMS_DB, EU };
