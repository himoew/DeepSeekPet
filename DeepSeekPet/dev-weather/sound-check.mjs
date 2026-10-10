
import { TRACKS_INFO as TRACKS, MASTER_GAIN } from './ambience.js';

const $ = (id) => document.getElementById(id);
const say = (m) => { $('prog').textContent = m; };
const err = (m) => { $('err').textContent = String(m); };
addEventListener('error', (e) => err('JS 错误：' + e.message + ' @' + e.lineno));
addEventListener('unhandledrejection', (e) => err('未捕获：' + ((e.reason && e.reason.message) || e.reason)));

const SR = 48000;
const rnd = (a, b) => a + Math.random() * (b - a);

/* =====================================================================================
 * ① 离线渲染：跟 ambience.js 的运行时链**同构**（同样的噪声、滤波器、事件分配）
 * ===================================================================================== */
/** 造四种噪声底子（跟 `makeBuffers()` 同一套算法；只是这里给 OfflineAudioContext 用）。 */
function makeBuffers(c) {
  const len = Math.floor(c.sampleRate * 2);
  const w = new Float32Array(len);
  for (let i = 0; i < len; i += 1) w[i] = Math.random() * 2 - 1;

  const br = new Float32Array(len);
  let last = 0;
  for (let i = 0; i < len; i += 1) { last = (last + 0.02 * w[i]) / 1.02; br[i] = last * 3.5; }

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
  const mk = (arr) => { const b = c.createBuffer(1, arr.length, c.sampleRate); b.getChannelData(0).set(arr); return b; };
  const drift = new Float32Array(Math.floor(c.sampleRate * 30));
  drift.set(br.subarray(0, drift.length));
  return { white: mk(w), brown: mk(br), pink: mk(pk), drift: mk(drift) };
}

/**
 * 造一层（噪声 → 滤波(可两层) → 增益 → 目标）。
 * ★ **`drift` 的补正系数与滤波截止**照抄 `ambience.js`：`dg.gain = depth * 3.2`、
 *   低通 `lpHz`（表里 7~13Hz）。这一段是"风像不像死水"的关键，两边必须一致，
 *   否则这一页量出来的东西不代表桌宠里那一版。
 */
function layer(c, buf, lo, dest, baseT) {
  const src = c.createBufferSource();
  src.buffer = buf[lo.n] || buf.white; src.loop = true;
  let node = src;
  const filters = [];
  for (const f of [lo, lo.then].filter(Boolean)) {
    const bq = c.createBiquadFilter();
    bq.type = f.t;
    bq.frequency.value = Math.max(20, Math.min(c.sampleRate / 2 - 100, f.f || 1000));
    bq.Q.value = Math.max(0.0001, Math.min(5, f.q == null ? .7 : f.q));
    node.connect(bq); node = bq;
    filters.push({ bq, f });
  }
  const g = c.createGain();
  g.gain.value = lo.g == null ? .1 : lo.g;
  node.connect(g); g.connect(dest);
  src.start(baseT);
  if (lo.drift || lo.lfo) {
    for (const { bq, f } of filters) {
      if (lo.drift) {
        const [depth, lpHz] = lo.drift;
        const ds = c.createBufferSource();
        ds.buffer = buf.drift; ds.loop = true;
        const dlp = c.createBiquadFilter();
        dlp.type = 'lowpass'; dlp.frequency.value = lpHz; dlp.Q.value = .7;
        const dg = c.createGain();
        dg.gain.value = depth * 3.2;
        ds.connect(dlp); dlp.connect(dg); dg.connect(bq.frequency);
        ds.start(baseT + Math.random() * 20);
      }
      for (const [rate, depth] of (lo.lfo || [])) {
        const o = c.createOscillator(); o.type = 'sine'; o.frequency.value = rate;
        const og = c.createGain(); og.gain.value = depth;
        o.connect(og); og.connect(bq.frequency); o.start(baseT);
      }
      void f;
    }
  }
}
/** 一次"冲击"（跟 `burst()` 同构）：谱、包络、声场都照抄。 */
function burst(c, buf, o, dest, baseT) {
  const t0 = baseT + (o.at || 0);
  const s = c.createBufferSource(); s.buffer = buf[o.n || 'white']; s.loop = true;
  const bq = c.createBiquadFilter(); bq.type = o.t || 'bandpass'; bq.Q.value = Math.min(5, o.q == null ? 1 : o.q);
  bq.frequency.setValueAtTime(o.f == null ? 2000 : o.f, t0);
  if (o.f1 && o.f1 !== o.f) bq.frequency.exponentialRampToValueAtTime(Math.max(40, o.f1), t0 + (o.dur || .05));
  const g = c.createGain();
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(o.vol == null ? .1 : o.vol, t0 + (o.attack || .003));
  g.gain.exponentialRampToValueAtTime(1e-4, t0 + (o.dur || .05));
  const p = c.createStereoPanner(); p.pan.value = Math.max(-1, Math.min(1, o.pan || 0));
  s.connect(bq); bq.connect(g); g.connect(p); p.connect(dest);
  s.start(t0, Math.random() * 1.5); s.stop(t0 + (o.dur || .05) + .05);
}
function chirp(c, o, dest, baseT) {
  const t0 = baseT + (o.at || 0);
  const osc = c.createOscillator(); osc.type = 'sine';
  osc.frequency.setValueAtTime(o.f0 || 2400, t0);
  osc.frequency.exponentialRampToValueAtTime(Math.max(60, o.f1 || 2600), t0 + (o.dur || .09));
  const g = c.createGain();
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(o.vol == null ? .05 : o.vol, t0 + .012);
  g.gain.exponentialRampToValueAtTime(1e-4, t0 + (o.dur || .09));
  const p = c.createStereoPanner(); p.pan.value = Math.max(-1, Math.min(1, o.pan || 0));
  osc.connect(g); g.connect(p); p.connect(dest);
  osc.start(t0); osc.stop(t0 + (o.dur || .09) + .04);
}
/** 到点的一次"点缀"（照抄 `spark()` 的分支；返回放了几个音）。 */
function spark(cfg, c, buf, dest, baseT) {
  let n = 0;
  switch (cfg.spark) {
    case 'drop': {
      const large = Math.random() < .72;
      const pan = Math.random() * 2 - 1;
      if (large) {
        burst(c, buf, { t: 'lowpass', f: 1800, f1: 900, q: .7, dur: .03 + Math.random() * .04, vol: .05 + Math.random() * .05, attack: .002, pan }, dest, baseT);
        if (Math.random() < .35) chirp(c, { f0: 2200 + Math.random() * 1500, f1: (2200 + Math.random() * 1500) * .8, dur: .014, vol: .012, pan }, dest, baseT);
      } else {
        burst(c, buf, { t: 'bandpass', f: 4200 + Math.random() * 3000, q: 2, dur: .02 + Math.random() * .02, vol: .012 + Math.random() * .012, attack: .002, pan }, dest, baseT);
      }
      n += 1; break;
    }
    case 'rustle': {
      for (let i = 0; i < 3; i += 1) {
        burst(c, buf, { t: 'bandpass', f: 1800 + Math.random() * 2200, f1: 900 + Math.random() * 900, q: 1.2, dur: .05 + Math.random() * .06, vol: .02 + Math.random() * .02, at: i * .07, attack: .006, pan: Math.random() * 1.8 - .9 }, dest, baseT);
        n += 1;
      }
      break;
    }
    case 'gust': {
      burst(c, buf, { n: 'brown', t: 'lowpass', f: 380 + Math.random() * 240, f1: 160, q: .6, dur: .9 + Math.random() * 1.1, vol: .02 + Math.random() * .02, attack: .35, pan: Math.random() * 1.2 - .6 }, dest, baseT);
      n += 1; break;
    }
    case 'bird': {
      const base = 2100 + Math.random() * 900;
      const k = 2 + Math.floor(Math.random() * 3);
      const pan = Math.random() * 1.4 - .7;
      for (let i = 0; i < k; i += 1) {
        const f0 = base * (0.94 + Math.random() * 0.12);
        chirp(c, { f0, f1: f0 * (1.02 + Math.random() * .06), dur: .05 + Math.random() * .05, vol: .022 + Math.random() * .02, at: i * (0.10 + Math.random() * 0.09), pan }, dest, baseT);
        n += 1;
      }
      break;
    }
    default: break;
  }
  return n;
}

/**
 * 渲一档。★ **音量包络照抄运行时**（`_apply()`）：master 从 0 用 0.25s 爬到 `MASTER_GAIN`，
 * 档位自己的 `out` 用 **1.2 秒**爬到 `cfg.vol` —— 所以开头那 1~2 秒本来就是淡入的，
 * 量 RMS 的时候**必须掐掉开头**（不然会低估）。这里把前 2.5 秒留给淡入，测量从 2.5s 起。
 */
async function renderTrack(name, secs) {
  const cfg = TRACKS[name];
  const c = new OfflineAudioContext(2, Math.round(SR * secs), SR);
  const buf = makeBuffers(c);
  const master = c.createGain();
  master.gain.setValueAtTime(0, 0);
  master.gain.linearRampToValueAtTime(MASTER_GAIN, 0.25);
  master.connect(c.destination);
  const out = c.createGain();
  out.gain.setValueAtTime(0, 0);
  out.gain.linearRampToValueAtTime(cfg.vol, 1.2);
  out.connect(master);

  const baseT = 0.35;                       // 让所有 source 在第 0.35 秒才开始（跟"建立时已解锁"等价）
  for (const lo of (cfg.bed || [])) layer(c, buf, lo, out, baseT);
  if (cfg.rumble) layer(c, buf, cfg.rumble, out, baseT);
  // 稀疏事件：从 0.5 秒开始按 `every` 的期望间隔排（随机抽）
  let at = baseT + .2, events = 0;
  while (at < secs) {
    events += spark(cfg, c, buf, out, at);
    at += rnd(cfg.every[0], cfg.every[1]);
  }
  let thunders = 0;
  if (cfg.thunder) {
    let ta = rnd(cfg.thunder[0], cfg.thunder[1]);
    while (ta < secs) {
      burst(c, buf, { n: 'brown', t: 'lowpass', f: 240, f1: 70, q: .4, dur: 2.6, vol: .055, attack: .5, pan: Math.random() * 1.6 - .8 }, out, ta);
      chirp(c, { f0: 58, f1: 34, dur: 2.2, vol: .03, pan: Math.random() * 1.2 - .6 }, out, ta);
      thunders += 1;
      ta += rnd(cfg.thunder[0], cfg.thunder[1]);
    }
  }
  const rendered = await c.startRendering();
  return { cfg, L: rendered.getChannelData(0), R: rendered.getChannelData(1), events, thunders, buf };
}

/**
 * ★ **量"滤波器截止被摆动器推了多远"**（2026-10-11 加，这一页最有价值的一条）。
 *
 * 病根在 `ambience.js` 的 `layer()`：游走源接 `bq.frequency`，增益是 `depth * 3.2`，
 * 而**表里的 depth 是几百 Hz**（雪那层 260、雨 1200）。这个系数是拍脑袋定的（注释里写着
 * "噪声低通后幅度小很多，把摆幅补回来"）—— **补多少从来没人量过**。
 * 推得太远 = 截止在 0 和两倍之间来回扫 → 声音又闷又亮地"喘"；推得太近 = 听着就是"死水"。
 * 所以这里直接把那条游走链**单独渲一遍**（同一条 buffer、同一个低通、同一个增益），
 * 报告它的标准差与极值 —— 数字一出来，"摆动过头 / 摆动不足"就不用猜了。
 */
async function driftSwing(name) {
  const cfg = TRACKS[name];
  const layers = [...(cfg.bed || []), ...(cfg.rumble ? [cfg.rumble] : [])].filter((l) => l.drift);
  const out = [];
  for (const lo of layers) {
    const secs = 20;
    const c = new OfflineAudioContext(1, Math.round(SR * secs), SR);
    const buf = makeBuffers(c);
    const [depth, lpHz] = lo.drift;
    const ds = c.createBufferSource();
    ds.buffer = buf.drift; ds.loop = true;
    const dlp = c.createBiquadFilter();
    dlp.type = 'lowpass'; dlp.frequency.value = lpHz; dlp.Q.value = .7;
    const dg = c.createGain();
    dg.gain.value = depth * 3.2;              // ★ 跟运行时一字不差
    const sink = c.createGain(); sink.gain.value = 1;
    ds.connect(dlp); dlp.connect(dg); dg.connect(sink); sink.connect(c.destination);
    ds.start(0);
    const res = await c.startRendering();
    const d = res.getChannelData(0);
    let sum = 0, mn = Infinity, mx = -Infinity;
    for (let i = 0; i < d.length; i += 1) { sum += d[i] * d[i]; if (d[i] < mn) mn = d[i]; if (d[i] > mx) mx = d[i]; }
    const f = lo.f || 1000;
    out.push({
      base: f, depth, lpHz,
      swingHz: Math.sqrt(sum / d.length),     // 推动量的 1σ（Hz）
      minHz: mn, maxHz: mx,                   // 实际触到的最低/最高截止
      pct: 100 * Math.sqrt(sum / d.length) / f,
      wouldClip: (f + mx > SR / 2 - 100) || (f + mn < 20),
    });
  }
  return out;
}

/* =====================================================================================
 * ② 测量：RMS / 峰值 / 频段能量 / 事件密度 / 声场
 * ===================================================================================== */
/** 就地 radix-2 FFT（长度必须是 2 的幂）。`re`/`im` 会被改写。 */
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { const tr = re[i]; re[i] = re[j]; re[j] = tr; const ti = im[i]; im[i] = im[j]; im[j] = ti; }
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
/** 频段（Hz）：照着"听感病根"分的 —— 轰鸣 / 厚度 / 主体 / 刺耳 / 齿音 / 空气。 */
const BANDS = [
  ['<150Hz 轰鸣', 20, 150],
  ['150~500 厚度', 150, 500],
  ['500~2k 主体', 500, 2000],
  ['2k~6k 刺耳', 2000, 6000],
  ['6k~10k 齿音', 6000, 10000],
  ['>10k 空气', 10000, 20000],
];
/**
 * 量一段样本。**测量区从 `skip` 秒开始**（跳过淡入）。
 *
 * ⚠️ `attackRate` 是"每秒有多少次瞬时冲击"：做法是把**单声道包络**（|L|+|R| 的 1ms 平滑）
 * 拿去和一个慢速平均（0.3 秒）比，超过 `max(慢均值 × 3, 0.02)` 就算一次攻击 ——
 * 雨滴/落叶/鸟叫都是这种形状，而连续底噪不是。它用来回答"雨滴密不密、会不会糊"。
 */
function measure(L, R, skip) {
  const from = Math.floor(skip * SR);
  const n = L.length - from;
  let sum = 0, peak = 0, sumL = 0, sumR = 0;
  const env = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const l = L[from + i], r = R[from + i];
    const m = (l + r) * .5;
    sum += m * m;
    sumL += l * l; sumR += r * r;
    const a = Math.abs(l) + Math.abs(r);
    if (a > peak) peak = a;
    env[i] = a;
  }
  const rms = Math.sqrt(sum / n);
  // 包络的慢速平均（一阶低通 ≈0.3 秒）
  const k = 1 - Math.exp(-1 / (SR * 0.3));
  let slow = 0, attacks = 0, above = false;
  for (let i = 0; i < n; i += 1) {
    slow += (env[i] - slow) * k;
    const thr = Math.max(slow * 3, 0.02);
    if (!above && env[i] > thr) { attacks += 1; above = true; }
    else if (above && env[i] < thr * .6) above = false;
  }
  // 频谱：单声道，2048 点 Hann，50% 重叠
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
  const all = totals.reduce((a, b) => a + b, 0) || 1;
  const centroid = (() => {
    let num = 0;
    for (let b = 1; b <= half; b += 1) num += spec[b] * b * binHz;
    return num / (all * (frames ? 1 : 1));
  })();
  const db = (x) => 20 * Math.log10(Math.max(1e-9, x));
  return {
    secs: n / SR,
    rmsDb: db(rms), peakDb: db(peak),
    balDb: db(Math.sqrt(sumL / n)) - db(Math.sqrt(sumR / n)),   // 左右差（正 = 左更响）
    bandPct: BANDS.map(([name], i) => [name, 100 * totals[i] / all]),
    centroidHz: centroid,
    attacksPerS: attacks / (n / SR),
  };
}

/* =====================================================================================
 * ③ wav 编码 + 页面
 * ===================================================================================== */
function wavBlob(L, R) {
  const n = L.length, bytes = 44 + n * 4;
  const ab = new ArrayBuffer(bytes), v = new DataView(ab);
  const w = (o, s) => { for (let i = 0; i < s.length; i += 1) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, bytes - 8, true); w(8, 'WAVE');
  w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 2, true);
  v.setUint32(24, SR, true); v.setUint32(28, SR * 4, true); v.setUint16(32, 4, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, n * 4, true);
  let o = 44;
  for (let i = 0; i < n; i += 1) {
    for (const ch of [L[i], R[i]]) {
      let s = Math.max(-1, Math.min(1, ch));
      v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true); o += 2;
    }
  }
  return new Blob([ab], { type: 'audio/wav' });
}
const LABELS = { snow: '雪（风 + 气息）', blossom: '樱花（轻风 + 鸟叫）', leaf: '落叶（沙沙）', rain: '雨（粉噪 + 雨滴 + 远雷）' };
let rendered = null;

/** 一个频段占比的小横条（0~100%）。 */
function bar(pct, cls) {
  const w = Math.max(1, Math.min(120, pct * 2.4));
  return `<span class="bar ${cls || ''}" style="width:${w}px"></span> ${pct.toFixed(1)}%`;
}
function paintTable() {
  const rows = ['rain', 'snow', 'leaf', 'blossom'];
  let html = '<table><tr><th>天气</th><th>RMS (dBFS)</th><th>峰值 (dB)</th><th>攻击次数/秒</th>'
    + BANDS.map(([n]) => `<th>${n}</th>`).join('') + '<th>频谱重心</th><th>左右差 (dB)</th></tr>';
  for (const name of rows) {
    const m = rendered[name].m;
    const rmsCls = m.rmsDb > -12 ? 'warn' : m.rmsDb < -26 ? 'warn' : 'good';
    html += `<tr><td>${LABELS[name]}</td>`
      + `<td class="${rmsCls}">${m.rmsDb.toFixed(1)}</td>`
      + `<td>${m.peakDb.toFixed(1)}</td>`
      + `<td>${m.attacksPerS.toFixed(1)}</td>`
      + m.bandPct.map(([, p]) => `<td>${bar(p, p > 40 ? 'hi' : p < 3 ? 'low' : '')}</td>`).join('')
      + `<td>${Math.round(m.centroidHz)} Hz</td>`
      + `<td>${m.balDb.toFixed(2)}</td></tr>`;
  }
  html += '</table>';
  html += `<p class="note">参考：设计目标 ≈ <b>-16dBFS RMS</b>（环境床量级）；峰值别贴 0dB；
    雨的"2k~6k 刺耳"段应该小（第一版"油锅"就是它太重）；"&lt;150Hz 轰鸣"也应该小（"恐怖片"的来源）。
    攻击次数/秒对雨 = 雨滴密度（表里 every [0.10, 0.26] → 期望 ≈ 10 次/秒）。</p>`;
  $('tableBox').innerHTML = html;
}
function paintCards() {
  let html = '';
  for (const name of ['rain', 'snow', 'leaf', 'blossom']) {
    const r = rendered[name];
    const url = URL.createObjectURL(r.blob);
    html += `<div class="card"><h3>${LABELS[name]}</h3>
      <div class="row"><audio controls src="${url}" data-k="${name}"></audio>
      <a href="${url}" download="ambience-${name}.wav">下载 wav</a>
      <span style="color:#7f8ea3">事件 ${r.events} 个${r.thunders ? ` · 远雷 ${r.thunders} 次` : ''}</span></div></div>`;
  }
  $('cards').innerHTML = html;
}
$('playAll').addEventListener('click', () => {
  const list = [...document.querySelectorAll('#cards audio')];
  let i = 0;
  const next = () => { if (i >= list.length) return; const a = list[i++]; a.play().then(() => { a.onended = next; }).catch(() => { say('播放被拦（先点一下页面）'); }); };
  next();
});
$('go').addEventListener('click', async () => {
  $('go').disabled = true;
  const secs = Number($('secs').value);
  rendered = {};
  try {
    for (const name of ['rain', 'snow', 'leaf', 'blossom']) {
      say(`正在渲染「${name}」…`);
      await new Promise((r) => setTimeout(r, 30));           // 让页面把进度画出来
      const r = await renderTrack(name, secs);
      r.m = measure(r.L, r.R, 2.5);                          // ★ 跳过 2.5 秒淡入再量
      r.blob = wavBlob(r.L, r.R);
      rendered[name] = r;
      say(`「${name}」好了（${(r.blob.size / 1048576).toFixed(1)}MB）`);
    }
    paintTable();
    paintCards();
    say('全部渲染完成 · 下面可以试听/下载');
  } catch (e) {
    err('渲染失败：' + ((e && e.stack) || e));
  } finally {
    $('go').disabled = false;
  }
});
say('就绪 · 点「开始渲染」');

/**
 * ★ **给自动化验收留的入口**（2026-10-11）：`await __renderAll()` 直接渲染 + 测量并返回一份
 * JSON（不建音频元素、不出声），这样"数字对不对"可以在不开声音的情况下查。
 * ⚠️ 它跟按钮走的是**同一条路**（`renderTrack` + `measure` + `driftSwing`），不是另一套实现。
 */
globalThis.__renderAll = async (secs = 8) => {
  const out = {};
  for (const name of ['rain', 'snow', 'leaf', 'blossom']) {
    const r = await renderTrack(name, secs);
    out[name] = { ...measure(r.L, r.R, 2.5), events: r.events, thunders: r.thunders, swing: await driftSwing(name) };
  }
  return out;
};
