/**
 * ============================================================================
 * 音频测量工具（临时工具，**只在 dev-weather 里用**，桌宠永远不 import 它）
 * ============================================================================
 *
 * ★ **为什么单独一个文件**：`sound.html`（听 + 量）和 `calib.html`（先证明这把尺子准）必须用
 * **同一份实现**，否则"校准通过"跟"量音效"是两把不同的尺子，等于没校准。
 *
 * ★ **这一版修掉的两个真实缺陷**（2026-10-11，都是自校准页抓出来的思路）：
 *   ① **攻击计数（attackRate）原来是错的**：它是"每个采样跟慢均值比，超过 3 倍就算一次"，
 *      然后 `above` 靠"掉到阈值的 0.6 倍以下"复位 —— 而**比较对象自己是慢均值**：
 *      包络一直高于它时 `above` 永远不复位，于是一场雨被数出 **348 次/秒**（物理上不可能）。
 *      现在改成**真·起音检测**：快包络 vs 慢包络，越过 `快>慢×3 且 快>绝对下限` 起音，
 *      掉回 `快<慢×1.6` 才允许下一次 —— 并且用"已知 5 次/秒的脉冲串"校准过。
 *   ② **频谱重心算错了**：原来拿"各段能量和"当分母去除，而分子是所有 bin 的加权和 ——
 *      分母少算了、量纲也不对（结果是"Hz × 段数"）。现在分母用**全部 bin 的能量和**。
 *
 * ⚠️ 别把"测量"和"被测对象"混起来：这个文件里**没有**任何 `ambience.js` 的东西。
 */

/** 全部分析都按这个采样率（跟桌宠的 AudioContext 默认值一致，48k 是 Windows/Electron 的常态）。 */
export const SR = 48000;

/* =====================================================================================
 * FFT（就地 radix-2；长度必须是 2 的幂）
 * ===================================================================================== */
export function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k += 1) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

/**
 * 频段划分 —— 照着**听感病根**分的（不是随便切的）：
 *   · `<150Hz`：轰鸣。"恐怖片"感主要来自这里压得太重。
 *   · `150~500`：厚度。真实雨声的"体积感"在这一段。
 *   · `500~2k`：主体。
 *   · `2k~6k`：**刺耳段**。第一版雨"像油锅"就是这一段被抬高。
 *   · `6k~10k` / `>10k`：齿音/空气。高频衰减不衰减，决定"自然还是塑料"。
 */
export const BANDS = [
  ['<150Hz 轰鸣', 20, 150],
  ['150~500 厚度', 150, 500],
  ['500~2k 主体', 500, 2000],
  ['2k~6k 刺耳', 2000, 6000],
  ['6k~10k 齿音', 6000, 10000],
  ['>10k 空气', 10000, 20000],
];

/** 幅度 → dBFS（下限 -180，免得 log(0)）。 */
export const db = (x) => 20 * Math.log10(Math.max(1e-9, x));

/**
 * 量一段立体声样本。
 *
 * `skip` = 跳过的秒数（**测量必须跳过淡入**：桌宠切天气时 master 用 0.25s、档位用 1.2s 淡入，
 * 从 0 开始量会把整体电平量低）。
 *
 * 返回：总 RMS/峰值（dBFS）、左右能量差（dB，正 = 左更响）、各频段能量占比（%）、
 * 频谱重心（Hz，= 能量的"平均频率"）、以及**起音次数/秒**。
 */
export function measure(L, R, skip = 0) {
  const from = Math.max(0, Math.min(L.length - 1, Math.floor(skip * SR)));
  const n = L.length - from;
  if (n <= 0) throw new Error('样本太短');
  const sumL = { v: 0 }, sumR = { v: 0 };
  let sum = 0, peak = 0, f = 0;
  /** 快包络（5ms 起音 + 5ms 释放）：冲击的形状全靠它。 */
  const envFast = new Float32Array(n);
  const aFast = Math.exp(-1 / (SR * 0.005));
  for (let i = 0; i < n; i += 1) {
    const l = L[from + i], r = R[from + i];
    const m = (l + r) * .5;
    sum += m * m;
    sumL.v += l * l; sumR.v += r * r;
    const a = Math.abs(l) + Math.abs(r);
    if (a > peak) peak = a;
    f = a > f ? a : a + (f - a) * aFast;         // 起音必须"立刻跟上"，所以取 max
    envFast[i] = f;
  }
  const rms = Math.sqrt(sum / n);

  /**
   * **起音检测**：快包络越过 `慢包络 × 3`（且越过绝对下限 0.02）记一次；
   * 掉回 `慢 × 1.6` 以下才允许下一次 —— **复位必须跟"比较对象"脱钩**，这就是原来数出
   * 348 次/秒的原因（`above` 那个布尔量根本复位不了）。
   */
  const ABS = 0.02;
  const aSlow = Math.exp(-1 / (SR * 0.250));     // 250ms 慢包络
  let attacks = 0, armed = true, slow = 0;
  for (let i = 0; i < n; i += 1) {
    const a = envFast[i];
    slow = a + (slow - a) * aSlow;
    const on = a > Math.max(slow * 3, ABS);
    const off = a < slow * 1.6;
    if (armed && on) { attacks += 1; armed = false; }
    else if (!armed && off) armed = true;
  }

  /* ---- 频谱：单声道、2048 点 Hann、50% 重叠 ---- */
  const N = 2048, half = N / 2;
  const win = new Float32Array(N);
  for (let i = 0; i < N; i += 1) win[i] = .5 - .5 * Math.cos(2 * Math.PI * i / N);
  const mono = new Float32Array(n);
  for (let i = 0; i < n; i += 1) mono[i] = (L[from + i] + R[from + i]) * .5;
  const re = new Float32Array(N), im = new Float32Array(N);
  const spec = new Float64Array(half + 1);
  let frames = 0;
  for (let off = 0; off + N <= n; off += half) {
    for (let i = 0; i < N; i += 1) { re[i] = mono[off + i] * win[i]; im[i] = 0; }
    fft(re, im);
    for (let b = 0; b <= half; b += 1) spec[b] += re[b] * re[b] + im[b] * im[b];
    frames += 1;
  }
  if (frames) for (let b = 0; b <= half; b += 1) spec[b] /= frames;
  const binHz = SR / N;
  const totals = BANDS.map(([, lo, hi]) => {
    let e = 0;
    for (let b = Math.max(1, Math.round(lo / binHz)); b <= Math.min(half, Math.round(hi / binHz)); b += 1) e += spec[b];
    return e;
  });
  /**
   * ⚠️ **重心/占比的分母必须是"全部 bin 的能量和"**（不是各段之和 —— 那样会漏掉段与段之间的
   * bin，量出来的重心偏大）。段占比用同一个分母，所以各段加起来会略小于 100%。
   */
  let all = 0, num = 0;
  for (let b = 1; b <= half; b += 1) { all += spec[b]; num += spec[b] * b * binHz; }
  if (!(all > 0)) all = 1;
  return {
    secs: n / SR,
    rmsDb: db(rms),
    peakDb: db(peak),
    balDb: db(Math.sqrt(sumL.v / n)) - db(Math.sqrt(sumR.v / n)),
    bandPct: BANDS.map(([name], i) => [name, 100 * totals[i] / all]),
    bandSumPct: 100 * totals.reduce((a, b) => a + b, 0) / all,
    centroidHz: num / all,
    attacksPerS: attacks / (n / SR),
    attacks,
  };
}
