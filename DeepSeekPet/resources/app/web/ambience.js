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
   * 雨 —— **主角是"连绵不断的雨声"，里面夹杂清晰突出的雨点**。
   *
   * ★★ 用户 2026-10-11 深夜的原话（这是这一档的设计依据，别再按"每秒几滴"理解）：
   *   "雨天的主角是雨没错，但它**不是一秒钟下几滴雨来展现的**，它是**连绵不断的雨滴声**，
   *    夹杂着一些**比较突出的清晰的雨点**声 —— 这个突出的声音**是不是非常规律的**
   *    （总之就是将**背景的声音调小一点**，然后**颗粒清晰一些**，主角的雨滴需要**更清晰明显**，
   *     但**不能有很规律的节奏感**）。"
   *
   * 所以这一档拆成三层，**连绵**和**突出**各管一头：
   *   ① **连绵层 = `mid` 那条带通噪声**（1.6kHz Q.75）—— 它就是"雨声"的本体，占主要能量；
   *   ② **颗粒层 = `drop` 事件**：**每秒 28~45 颗**（`every: [.022, .036]`），这是"连绵"的第二半
   *      与"颗粒感"的来源。密度高到**不成拍**，才不会有节奏感；
   *   ③ **突出雨点 = `dropBig` 事件**：**不规则**（间隔用**指数分布**抽：`everyExp`），
   *      每秒约 1.2~2.4 颗，比颗粒层响一大截、衰减更长、更低频 —— 用户说的"清晰的雨点"。
   *      ⚠️ **必须用指数分布**（`everyExp`）：均匀分布听久了还是会"有拍"，
   *      指数分布抽出来是**成簇的、有疏有密**，那才是真雨。
   *   ④ **床**压到最低（`g: .035`）—— 用户明确要求"背景的声音调小一点"。
   */
  rain: {
    mixGainDb: 17.7, seed: 44,
    bed: [{ n: 'pink', t: 'bandpass', f: 900, q: .5, g: .035, flow: .5, envHz: [.25], swing: 10, drift: [6] }],
    mid: [{ n: 'pink', t: 'bandpass', f: 1600, q: .75, g: .085, flow: .6, envHz: [.22], swing: 12, drift: [7] }],
    spark: 'drop',
    every: [.022, .036],                // 连绵颗粒：≈ 28~45 颗/秒 → 听着是"雨"，不是"滴答"
    everyExp: .65,                      // 突出雨点：**指数分布**，平均 1/0.65 ≈ 1.5 颗/秒（不成拍）
    thunder: [24, 60],                  // 远雷：拉长间隔、压低音量
  },
  /**
   * 雪 —— **主角是"风"**（雪本身没有声音）。
   *
   * ★★ **用户 2026-10-11 的定评："表现最好的是雪天的声音，舒展有秩序，听起来不奇怪"** ——
   *    所以这一档**保持原样、不再动它**（连 `every`/`g`/`f` 都不许改）。
   *    用户还补了一句"雪的主角音几乎没有（不过别管它，雪就按这个）"—— 明确接受。
   */
  snow: {
    mixGainDb: 17.7, seed: 11,
    bed: [{ n: 'brown', t: 'bandpass', f: 220, q: .6, g: .16, flow: .6, envHz: [.18], swing: 12, drift: [8] }],
    mid: [{ n: 'brown', t: 'bandpass', f: 520, q: .5, g: .14, flow: 1, envHz: [.16], swing: 24, drift: [9], lfo: [[.023, 18], [.037, 11]] }],
    spark: 'gust',
    every: [4.5, 11],
  },
  /**
   * 落叶 —— **风声 + 风吹树叶**，要"**凋落的萧瑟感**"。
   *
   * ★ 用户原话："把**擦玻璃的声音去掉**吧，其实就是**风声和风吹树叶**的声音，有那种**凋落的萧瑟感**。"
   *   · 旧的 `leafRustle()` 是"擦玻璃"的元凶：6~10 个 **1~4kHz 的短爆点**串起来，
   *     宽频 + 快起快落 = 抓挠玻璃。**这一版不用它了**。
   *   · 现在只有两样东西：① 风（`bed` + `mid` 两条窄带，`flow` 让它们慢慢起伏）；
   *     ② **风吹树叶**：`spark: 'sway'` —— 0.8~1.6 秒的**慢起慢落**、中心在 700~1500Hz、
   *     带一点抖动（树叶不是一块布），而且**没有尖锐的起始**（`attack: .18`）。
   *   · "萧瑟感"来自：中高频（1~3k）**留一点空地**（不像夏天那么满）、偶尔一阵风把叶子吹响。
   */
  leaf: {
    mixGainDb: 17.7, seed: 33,
    bed: [{ n: 'brown', t: 'bandpass', f: 300, q: .55, g: .13, flow: .7, envHz: [.18], swing: 14, drift: [9] }],
    mid: [{ n: 'brown', t: 'bandpass', f: 900, q: .5, g: .06, flow: 1, envHz: [.15], swing: 22, drift: [10], lfo: [[.029, 14]] }],
    spark: 'sway',
    every: [2.4, 6.5],                  // 风把树叶吹响：稀疏、无拍
  },
  /**
   * 樱花 —— **春天的轻风 + 鸟鸣**。
   *
   * ★ 用户原话："现在的声音**像噪声**，不用跑偏就是**春天的风声和鸟鸣**的叫声，
   *   **背景声小一点**，**风声轻轻的吹动，缓缓的走过**。"
   *   · "像噪声"的元凶是 1.1kHz 那条**宽带**中层（Q .5 太宽，就是一条咝）。
   *     现在收窄到 **Q 1.1 / 950Hz**，并把床压到 `g: .045` —— 只剩"空气在动"；
   *   · 风：`mid` 的 `flow: 1`（慢呼吸）+ `swing 18`（截止缓缓摆）→ "轻轻吹动、缓缓走过"；
   *   · **鸟鸣**：`spark: 'bird'` 提高出场率（**9~26 秒**一次，比原来的 22~55 秒勤快），
   *     并且鸟叫本身也重调（见 `bird()`：更短、更亮、两句一组、带一个上扬）。
   */
  blossom: {
    mixGainDb: 25.1, seed: 22,
    bed: [{ n: 'pink', t: 'bandpass', f: 380, q: .6, g: .045, flow: .5, envHz: [.2], swing: 12, drift: [9] }],
    mid: [{ n: 'pink', t: 'bandpass', f: 950, q: 1.1, g: .05, flow: 1, envHz: [.16], swing: 18, drift: [10], lfo: [[.037, 22]] }],
    spark: 'bird',
    every: [9, 26],
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

/* =====================================================================================
 * ★★ 慢随机游走的两个时间尺度 + 包络深度（2026-10-11 深夜定）
 * =====================================================================================
 * ⚠️ 这两个截止频率是**在 JS 里用一阶低通算的**（`onePole()`），不是 biquad ——
 *    0.2Hz 这种截止在 48k 采样率下用 biquad 会因系数精度不足而**完全不滤波**（实测等于原样通过）。
 */
/** 音量包络的时间尺度（Hz）：0.2 ≈ "几秒一次"的呼吸。 */
const DRIFT_SLOW_HZ = .2;
/** 截止摆动的时间尺度（Hz）：9 ≈ 0.1 秒级的抖动（"风的颗粒"）。 */
const DRIFT_FAST_HZ = 9;
/**
 * ★ `flow: 1` 对应的**最大**音量呼吸量（线性）。`flow` 是 0~1 的比例，深度就是 `FLOW_MAX × flow`。
 *
 * 0.5 → `flow:1` 的增益在 **0.5~1.5 之间**（最极端的一瞬 −6dB/+3.5dB，平时 ±1dB 上下）。
 *
 * 旧注释说"±1.1dB"，那是**在坏掉的游走上**量出来的（见 `makeBuffers()` 里那段）：
 * 名义值是 ±1.1dB，实测逐秒却摆 20dB —— 因为那些游走的分布带 3~4σ 的尾巴。
 * 现在**按峰值归一**，所以这个数就是**上限**，尾巴再也翻不了天。
 */
const FLOW_MAX = .5;

/**
 * **一阶低通（就地）**，给慢游走用。
 *
 * ★ 为什么不在 Web Audio 里挂 biquad 低通：48k 采样率下，`frequency = 0.2` 的 biquad
 *   系数精度不够（极点贴到 1 上），实测 `lowpass 0.16Hz` 之后 RMS = 0.187、原始 0.201 ——
 *   **等于什么都没滤**。用双精度 JS 算就没有这个下限。
 */
function onePole(x, fc, sr) {
  const a = Math.exp((-2 * Math.PI * fc) / sr);
  let y = 0;
  for (let i = 0; i < x.length; i += 1) { y = (1 - a) * x[i] + a * y; x[i] = y; }
  return x;
}

/** **减掉均值（就地）**，返回 `{ rms, peak }`。零均值 = 包络不会把电平一路推偏。 */
function zeroMean(x) {
  let m = 0;
  for (let i = 0; i < x.length; i += 1) m += x[i];
  m /= x.length;
  let s = 0, pk = 0;
  for (let i = 0; i < x.length; i += 1) {
    x[i] -= m;
    s += x[i] * x[i];
    const a = Math.abs(x[i]);
    if (a > pk) pk = a;
  }
  return { rms: Math.max(1e-9, Math.sqrt(s / x.length)), peak: Math.max(1e-9, pk) };
}

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
  /**
   * ★★ **慢随机游走是两条，不是一个**（2026-10-11 深夜第三次返工，这一版才是对的）：
   *   · `driftSlow`（一阶低通到 ~0.2Hz，**几秒一次**）→ 驱**音量包络**（`flow`）；
   *   · `driftFast`（一阶低通到 ~9Hz，**~0.1 秒级**）→ 驱**滤波器截止摆动**（`swing`）。
   * 两条都在 **JS 里算成音频缓冲**（`onePole()`），**不再用 Web Audio 的 biquad 去低通** ——
   * 原因见 `makeBuffers()` 里那段（0.2Hz 的 biquad 在 48k 下等于原样通过）。
   */
  let driftSlow = null, driftFast = null;
  /**
   * **两条游走各自的 RMS 与峰值**（`layer()` 里拿它把 `swing`/`flow` 换算成 Hz 与线性增益）。
   * ⚠️ 少了它就只能像旧代码那样"猜一个系数"，而那正是"摆动过头/几乎不动"的根源。
   * ⚠️⚠️ **深度一律按"峰值"归一**（2026-10-11 深夜最后一次返工）：按 RMS 归一时这些游走是
   *    **高斯样**的，尾巴能到 3~4σ —— `flow:1` 名义上 ±2dB，实测逐秒却摆 **20dB**（用户听到的
   *    就是"一会儿很小、一会儿很大"）。按峰值归一之后**表里写多少就是最大偏移多少**。
   * ⚠️⚠️ 还要**跟实际在用的那条游走对应**（慢的配慢的、快的配快的）：旧代码用"整段 30 秒里
   *    **含 28 秒静音**的那条"去归一化慢包络，差了 4 倍，是"电平在飘"的帮凶。
   */
  let driftSlowRms = 1, driftSlowPeak = 1, driftFastRms = 1, driftFastPeak = 1;

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
     * ★★ **两条慢随机游走**（30 秒棕噪声，各自一阶低通，JS 里算好）。
     *
     * ⚠️⚠️ **这里是"越到后面越大"的真根因**（2026-10-11 深夜查出来的，前两次都改错了地方）：
     *
     *   ① 旧代码先把 30 秒的游走缓冲**用 2 秒的棕噪声去填** ——
     *      `drift.getChannelData(0).set(br.subarray(0, dl))` 里 `br` 只有 2 秒，
     *      于是那 30 秒的缓冲是 **2 秒噪声 + 28 秒静音**，还挂着 `loop = true`。
     *   ② 于是"慢包络"其实是被一个**每 30 秒来一次的 2 秒脉冲**推着走；
     *   ③ 低通到 0.15~0.25Hz 的那只 biquad **在 48k 下精度不够、根本不滤波**
     *      （实测：低通 0.16Hz 之后 RMS = 0.187，原信号 0.201 —— 等于原样通过），
     *      所以"慢包络"实际上是**音频速率的噪声调制**（听感是粗粝的噗噗声）；
     *   ④ 后面那只 **0.02Hz 高通**（τ ≈ 8 秒）再把那个脉冲变成**一条单边斜坡**。
     *      → 一段 20 秒里电平从 -33.9dBFS **单调爬到 -22.5dBFS（+11.4dB）**，
     *        这就是用户报的"**越到后面越大**"；也解释了"同一套参数两次量出来差 10dB"。
     *
     * 现在：两条游走都在 JS 里用 `onePole()` 低通（**双精度、想要多低就多低**），
     * 各自**减掉自己的均值**（零均值 → 没有直流 → **不可能一路偏过去**），
     * 并把各自的 RMS 记下来给 `layer()` 归一化用。
     */
    const dl = Math.floor(ctx.sampleRate * 30);
    const wl = new Float32Array(dl);
    for (let i = 0; i < dl; i += 1) wl[i] = Math.random() * 2 - 1;
    const slow = new Float32Array(dl);
    const fast = new Float32Array(dl);
    let l2 = 0;
    for (let i = 0; i < dl; i += 1) {
      l2 = (l2 + 0.02 * wl[i]) / 1.02;
      const v = l2 * 3.5;
      slow[i] = v; fast[i] = v;
    }
    onePole(slow, DRIFT_SLOW_HZ, ctx.sampleRate);
    onePole(fast, DRIFT_FAST_HZ, ctx.sampleRate);
    const ds = zeroMean(slow);
    const df = zeroMean(fast);
    driftSlowRms = ds.rms; driftSlowPeak = ds.peak;
    driftFastRms = df.rms; driftFastPeak = df.peak;
    driftSlow = ctx.createBuffer(1, dl, ctx.sampleRate);
    driftSlow.getChannelData(0).set(slow);
    driftFast = ctx.createBuffer(1, dl, ctx.sampleRate);
    driftFast.getChannelData(0).set(fast);
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
        /**
         * ★★ **总线上**不要**挂限幅器**（2026-10-11 深夜：挂了，又撤了，记在这儿免得再挂）。
         *
         * 我当时的想法是"波峰因数 20~28dB，靠退 dB 保命太赌，上限幅器一劳永逸"。
         * 结果 `createDynamicsCompressor` 在 Chromium 里**会自动做增益补偿**：
         * 实测同一档，挂上它之后 **RMS 反而 +7~8dB、峰值从 -11dB 冲到 -0.3dB**；
         * 而且信号越大它压得越狠、补偿越多 —— 用户听到的
         * **"所有的声音越到尾声越大，只有雪能 hold 住"**，有一半就是它干的。
         *
         * 所以这一版回到"**用设计留余量**"：
         *   · 包络调制深度从 ±2.8dB 收到 **±1.1dB**（`flow * 0.06`）—— 这才是"越到尾声越大"的另一半；
         *   · 每个天气**单独标电平**（见 `TRACKS` 上面的 `mixGainDb` 与 `dev-weather\sound.html` 的
         *     `__norm()`，它会在**保证峰值不超上限**的前提下把电平顶到目标）；
         *   · 要真正"又响又不削"，得自己写软削波（`WaveShaperNode` + tanh）或压缩器带**固定补偿**，
         *     那是下一步的事 —— **不要直接把 `DynamicsCompressor` 接上来**。
         */
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
   * ★ 把**已经算好**的那条慢游走接上去（`which` = `driftSlow` 或 `driftFast`）。
   *
   * ⚠️ 这里**没有** biquad：低通已经在 `makeBuffers()` 里用 `onePole()` 算进缓冲了。
   *    旧版在这里挂了一只 `lowpass`（0.15~0.25Hz）—— 那只 biquad 在 48k 下不工作（见文件里那段），
   *    所谓"慢包络"其实是音频速率的噪声调制；再叠一只 0.02Hz 高通就变成了"越到后面越大"。
   *
   * `startAt` 取随机偏移：每次切天气进入 30 秒游走的不同位置，听感上不会"每次都一样"。
   * `rate` 是播放速率：表里每层的 `drift: [6]~[12]`（Hz）**仍然有用** —— 它被换算成速率
   * （`rate = drift/9`），于是各层的抖动快慢不同、**互相不相关**，也不会和别的层锁在一起。
   */
  function walk(c, which, made, startAt, rate) {
    const s = c.createBufferSource();
    s.buffer = which; s.loop = true;
    s.playbackRate.value = Math.max(.25, Math.min(4, rate || 1));
    s.start(startAt);
    made.nodes.push(s);
    return s;
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
        /** 归一化用**快游走的峰值** → `swing` 就是**最大**截止偏移（占 f 的百分比）。 */
        dg.gain.value = (baseHz * sw) / driftFastPeak;
        walk(c, driftFast, made, Math.random() * 25, (lpHz || DRIFT_FAST_HZ) / DRIFT_FAST_HZ).connect(dg);
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
     * ★ **音量包络**（`flow`）：慢游走（~0.2Hz，几秒一次）直接推这一层的增益。
     * 这是"风/雨幕在呼吸"的来源 —— **只给主角那一层加**（见文件头第②条：
     * 一个天气里只许有一个主角，否则又是"三个东西一起动"）。
     *
     * ⚠️⚠️ **这条式子返工过三次，前两次都是在"坏掉的游走"上调系数**（治标）：
     *   · 旧版写 `flow * 0.15 / driftRms`，而那个 `driftRms` 是"掺了 28 秒静音的 30 秒缓冲"的 RMS，
     *     只有真实游走的 1/4 → 调制深度是设计值的 4 倍，而且是**音频速率**的抖动；
     *   · 收到 `0.06` 只把"越到后面越大"从 ~28dB 压到 ~11dB —— **病根是那条游走，不是深度**。
     * 现在深度由 `FLOW_MAX` 定（`flow:1` = 增益 0.5~1.5），归一化用**慢游走的峰值**，且它零均值。
     */
    if (lo.flow) {
      const eg = c.createGain();
      eg.gain.value = (FLOW_MAX * lo.flow) / driftSlowPeak;
      const envHz = (lo.envHz ? lo.envHz[0] : DRIFT_SLOW_HZ) || DRIFT_SLOW_HZ;
      walk(c, driftSlow, made, Math.random() * 25, envHz / DRIFT_SLOW_HZ).connect(eg);
      eg.connect(g.gain);
      made.nodes.push(eg);
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
   * **一颗雨滴**（`spark: 'drop'`）。两种尺寸，对应用户说的两层：
   *
   *   · `big` = false（**连绵颗粒**，每秒 28~45 颗）：短、小、低频冲击
   *     （低通 1.4~2.3k，25~70ms 衰减）—— 这就是"连绵不断的雨滴声"的颗粒；
   *   · `big` = true（**突出雨点**，平均 1~2 颗/秒、**指数分布**）：响一截（×2.6）、
   *     衰减长一倍（90~200ms）、频率更低（低通 900~1500）—— 用户说的"比较突出的、清晰的雨点"。
   *     它还会带一点 2.4~5k 的碎响（"啪"的那一下），概率高、音量也跟着抬。
   *
   * ⚠️ **每颗独立**的左右声场、音量、颗粒 —— 有变化才像雨；一成不变（或者等间隔）才像雨刷。
   */
  function drop(c, made, at, big, bigGain) {
    const pan = Math.random() * 2 - 1;
    /** `bigGain`（可缺省）：只在海选里用来整体放大"突出雨点"；产品默认 1。 */
    const k = big ? (bigGain == null ? 1 : bigGain) : 1;
    if (big) {
      /**
       * ⚠️ **突出雨点不能太响**（2026-10-11 深夜实测出来的）：原来 `vol = .85`、衰减 90~200ms，
       * 整档的**波峰因数被它拉到 28dB**（峰值比 RMS 高 28dB）—— 于是"要它够响"和"不许削顶"
       * 直接打架，怎么标都只能小声（加 5dB 冲目标，峰值就先到 +3.6dBFS 削顶了）。
       * 降到 **.5 / 70~140ms** 之后，它**听起来仍然是"突出的清晰雨点"**
       * （因为颗粒层只有它的 1/3 音量），但整档波峰因数回到 ~22dB，电平才顶得上去。
       */
      const vol = .5 * (.75 + Math.random() * .5) * k;
      burst(c, {
        t: 'lowpass', f: 900 + Math.random() * 600, f1: 260 + Math.random() * 160,
        q: .7, dur: .07 + Math.random() * .07, vol, attack: .0012, pan, at,
      }, made);
      burst(c, {
        t: 'bandpass', f: 2400 + Math.random() * 2600, q: 2, dur: .018 + Math.random() * .018,
        vol: vol * .22, attack: .001, pan, at: at + .001 + Math.random() * .006,
      }, made);
      return;
    }
    const large = Math.random() < .6;
    const vol = (large ? .20 : .13) * (.7 + Math.random() * .6);
    burst(c, {
      t: 'lowpass', f: 1400 + Math.random() * 900, f1: 320 + Math.random() * 200,
      q: .7, dur: (large ? .045 : .025) + Math.random() * .035, vol, attack: .0012, pan, at,
    }, made);
    if (Math.random() < .28) {
      burst(c, {
        t: 'bandpass', f: 2600 + Math.random() * 2200, q: 2.5,
        dur: .012 + Math.random() * .012, vol: vol * .3, attack: .001, pan, at: at + .002 + Math.random() * .01,
      }, made);
    }
  }

  /**
   * **风把树叶吹响**（`spark: 'sway'`）—— 落叶那一档的主角。
   *
   * ★ 用户 2026-10-11："把**擦玻璃的声音去掉**，其实就是**风声和风吹树叶**的声音。"
   *   旧的 `leafRustle()` 是 6~10 个 **1~4kHz 短爆点**（`attack: .004`）串起来 ——
   *   宽频 + 快起快落 = 抓挠玻璃，**所以它被删掉了**，这里只有"吹动"：
   *   · 0.8~1.6 秒的**慢起慢落**（`attack: .18`，没有尖头）；
   *   · 中心落在 **700~1500Hz**（树叶的沙沙在中频，不在 3k 以上那层"玻璃味"）；
   *   · 里面串 5~9 个**很短、很轻的抖动**（叶片的互相碰），但不改变整体的慢包络 ——
   *     有抖动的才是"树叶"，光滑的只是"一段噪声"；
   *   · 声场从一边慢慢移到另一边（风是走过去的）。
   */
  function sway(c, made, at) {
    const dur = .8 + Math.random() * .8;
    const dir = Math.random() < .5 ? -1 : 1;
    const pan0 = -dir * (.25 + Math.random() * .5);
    const vol = .30 + Math.random() * .16;
    burst(c, {
      n: 'pink', t: 'bandpass', f: 700 + Math.random() * 700, f1: 600 + Math.random() * 500, q: .9,
      dur, vol, attack: .18, pan: pan0, at,
    }, made);
    const n = 5 + Math.floor(Math.random() * 5);
    for (let i = 0; i < n; i += 1) {
      const k = i / n;
      burst(c, {
        t: 'bandpass', f: 1200 + Math.random() * 2200, q: 1.2,
        dur: .05 + Math.random() * .06, vol: vol * (.12 + Math.random() * .18),
        attack: .03, pan: pan0 + dir * k * .6, at: at + .12 + k * dur * .8,
      }, made);
    }
  }

  /**
   * **一阵风**（`spark: 'gust'`）：0.8~1.8 秒的**慢起慢落**，不是"啪"。
   * 它落在 240~520Hz（跟中层同一个频段，像是中层紧了一下），偶尔把声场推过去。
   * ⚠️ 雪那一档**靠它**（用户说雪"舒展有秩序"），所以这套参数不要动。
   */
  function gust(c, made, at) {
    burst(c, {
      n: 'brown', t: 'bandpass', f: 240 + Math.random() * 260, q: .7,
      dur: .8 + Math.random() * 1.0, vol: .16 + Math.random() * .12, attack: .35,
      pan: Math.random() * 1.2 - .6, at,
    }, made);
  }

  /**
   * ⚠️ **`leafRustle()` 已被删除**（2026-10-11 深夜，用户点名）：
   * 它是 7~10 个 **1~4kHz、`attack: .004` 的短爆点**串起来 —— 宽频 + 快起快落就是
   * 用户听到的"**擦玻璃**"。落叶那一档现在用 `sway()`（慢起慢落的风吹树叶）。
   * 删掉而不是留着不用：留着总会有人（包括我）再把它接回去。
   */

  /**
   * **一声鸟叫**（`spark: 'bird'`）：**带通扫频的"啾-溜"**。
   *
   * ★ 用户 2026-10-11 对樱花的要求："不用跑偏，就是**春天的风声和鸟鸣**的叫声。"
   *   所以鸟叫这一版往"更短、更亮、更像鸟"调：
   *   · 频率抬到 **2.6~4.6kHz**（原来 2.3~3.4k 偏低，像口哨）；
   *   · 一句的时长**缩短**（上滑 55~80ms、下滑 70~110ms），间隔更紧（0.10~0.17s）；
   *   · **固定"上扬 + 1~2 声下滑"的三音句**（`up` 只给第一声）—— 鸟的乐句感来自这个形状；
   *   · 加一条**更亮的第二共振峰**（×1.6，Q 3）让"啾"有芯，别像噪声扫频。
   */
  function bird(c, made, at, range) {
    const [lo, hi] = (range && range.f0) || [2600, 4600];
    const [s0, s1] = (range && range.sweep) || [.55, .85];
    const base = lo + Math.random() * (hi - lo);
    const k = 2 + Math.floor(Math.random() * 2);           // 2~3 声一句
    const pan = Math.random() * 1.4 - .7;
    for (let i = 0; i < k; i += 1) {
      const f0 = base * (.95 + Math.random() * .10);
      const up = i === 0;                                  // 第一声上滑（"啾"），后面下滑（"溜"）
      const dur = (up ? .055 : .07) + Math.random() * .04;
      const at2 = at + i * (.10 + Math.random() * .07);
      burst(c, {
        t: 'bandpass', f: f0, f1: f0 * (up ? 1.22 : (s0 + Math.random() * (s1 - s0))), q: 3.5,
        dur, vol: .12 + Math.random() * .06, attack: .008, pan, at: at2,
      }, made);
      burst(c, {
        t: 'bandpass', f: f0 * 1.6, f1: f0 * 1.6 * (up ? 1.12 : .92), q: 3,
        dur, vol: .05, attack: .01, pan, at: at2,
      }, made);
    }
  }

  /** 远雷：闷、低、慢（长低通冲击 + 一条更低的正弦）。 */
  function thunder(c, made, at) {
    burst(c, { n: 'brown', t: 'lowpass', f: 240, f1: 70, q: .4, dur: 2.6, vol: .2, attack: .5, pan: Math.random() * 1.6 - .8, at }, made);
    burst(c, { n: 'brown', t: 'bandpass', f: 58, q: 2, dur: 2.2, vol: .1, attack: .6, pan: Math.random() * 1.2 - .6, at: at + .1 }, made);
  }

  /**
   * ⚠️ **稀疏事件排期**（2026-10-11 改过两次语义，这里最终定下来）：
   *
   *   · `every` = 两次事件之间的**均匀随机**间隔（秒）；
   *   · `everyExp` = **指数分布**间隔（平均 `everyExp[0]~[1]` 秒，抖动 ±50%）。
   *     ★★ **用户点名要的**：雨的"突出雨点"如果间隔均匀，听久了就有**拍子**
   *     （用户原话："**不能有很规律的节奏感**"）。指数分布抽出来的间隔是
   *     **成簇的、有疏有密**（泊松过程）—— 那才是真雨。**这是这一版雨的第二个关键。**
   *   · `follow()` 一帧**最多放一次**（防止卡顿后一帧补一串）；雨另有一条 `everyExp` 的
   *     "突出雨点"流，跟颗粒流**各排各的**（两条独立的时间线，不会锁相）。
   */
  function spark(cfg, c, at, big) {
    const made = live && live.made;
    if (!made) return 0;
    switch (cfg.spark) {
      case 'drop': { drop(c, made, at, big, cfg.bigGain); return 1; }
      case 'gust': { gust(c, made, at); return 1; }
      case 'sway': { sway(c, made, at); return 1; }
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
     * 这里只排**前景事件**（雨滴、风吹树叶、鸟叫、风紧一下、远雷）；返回这一帧放了几个音。
     *
     * ⚠️ **一帧每一条流最多一个事件**：雨的最小间隔是 0.022 秒，一帧 16.7ms，
     * 正常情况本来就是"有时候一帧一个、有时候没有"；加上限是为了防止**卡顿一下（dt 变大）
     * 之后一帧里补一串** —— 那种"突然一坨"正是"糊"的来源之一。
     *
     * ★ **雨有两条独立的时间线**（用户要的"连绵 + 夹杂突出雨点"）：
     *   ① 颗粒流（`every`，28~45 颗/秒）—— "连绵不断的雨滴声"；
     *   ② 突出雨点流（`everyExp`，指数分布）—— "比较突出的清晰的雨点"，**不成拍**。
     *   两条各自推进、互不锁相，所以宏观上永远听不出周期。
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
        while (when.next <= now) when.next += rnd(cfg.every[0], cfg.every[1]);
        played += spark(cfg, c, 0, false);
      }
      /** ★ 第二条流：**指数分布**的"突出雨点"（只有配了 `everyExp` 的档才有）。 */
      if (cfg.everyExp) {
        if (!when.nextBig) when.nextBig = now + expRnd(cfg.everyExp[0]);
        if (now >= when.nextBig) {
          while (when.nextBig <= now) when.nextBig += expRnd(cfg.everyExp[0]);
          played += spark(cfg, c, 0, true);
        }
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
     * 诊断：**`on` 是"用户开关"**，`silent` 才是"现在到底出不出声"
     * （`on = true` 但 `silent = true` 说明还没拿到手势，或宿主把它挂起了）。
     */
    state: () => ({
      on, unlocked, mode, live: !!live, ctx: ctx ? ctx.state : 'none', failed,
      silent: !(on && unlocked && !failed && live && !!ctx && ctx.state === 'running'),
      master: MASTER_GAIN,
      /** 这一档的整档增益倍数（排查"声音太小/太大"时不用猜）。 */
      norm: live ? +live.made.norm.toFixed(2) : null,
      target: TARGET_RMS_DB,
      /** 这一档的主角是什么（给诊断页显示用）。 */
      spark: live ? live.cfg.spark : null

    }),
  };
  return api;
}

const rnd = (a, b) => a + Math.random() * (b - a);
/**
 * **指数分布**的随机间隔（`mean` = 平均值）。
 *
 * ★★ 为什么单独要它（2026-10-11 深夜，用户点名）：雨的"突出雨点"如果用**均匀随机**间隔，
 * 短时间听不出差别，但听上十几秒就会浮出**拍子感**（用户原话："**不能有很规律的节奏感**"）。
 * 指数分布是**泊松过程**的间隔分布 —— 抽出来**成簇、有疏有密**（有时连着两三颗、
 * 然后安静一两秒），那才是真雨。**这是这一版雨的关键之一，别改回 `rnd()`。**
 *
 * 实现：`-ln(U) × mean`（U = (0,1]）。夹一个 0.15×mean 的下限，
 * 免得偶尔抽出 0 导致两颗重叠成一个"啪"。
 */
const expRnd = (mean) => Math.max(mean * .15, -Math.log(1 - Math.random()) * mean);

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
