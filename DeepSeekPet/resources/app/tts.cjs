/**
 * 本地语音：把文字交给 sherpa-onnx 合成成 WAV，给气泡配声音。
 *
 * 三件事和一个前提：
 *  · **不阻塞主线程**：真正的加载与合成在 tts-worker.cjs 那个 worker 里；
 *  · **只加载一次**：模型 8–9 秒，启动时后台预热（`warm()`），第一条真正要说的话就已经是热的；
 *  · **带缓存**：桌宠的话重复度很高（内置台词、自动说话的口头禅），同一句话第二次就是 0ms；
 *  · **前提**：`vendor\tts\` 里要有预编译插件和音色，由 `tools\setup-tts.ps1` 装配。
 *    没有就自动闭嘴（`available()` 为假），桌宠照常跑。
 *
 * 声音是**大肥鱼自己念**：语速、音色都来自 `vendor\tts\voices\chaowen-int8`
 * （zh_CN-chaowen 超文，CC0 数据集，int8 约 18MB）。
 */
const fs = require('node:fs');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const log = require('./log.cjs');
const voices = require('./tts-voice.cjs');

/** 语音文件都在这儿（setup-tts.ps1 放的）。 */
const VENDOR = path.join(__dirname, 'vendor', 'tts');
const MODULE_DIR = path.join(VENDOR, 'sherpa-onnx-node');
/** 音色都在这儿，一个子目录一套；换音色 = 换 `voices\.active` 里那个名字。 */
const VOICES_ROOT = path.join(VENDOR, 'voices');
/** 缓存多少句（一句 2 秒的音频约 176KB，64 句不到 12MB）。 */
const CACHE_MAX = 64;

/**
 * 这次要用哪套音色。启动时定一次：`voices\.active` 指定，或者第一个完整可用的。
 * 音色由 `voice.json` 描述（多说话人的 `sid`、要不要 lexicon/dict、语速和几个
 * 合成旋钮都在里面），见 tts-voice.cjs / voice-config.cjs 顶部。
 *
 * `VOICE` 会在 `reload()` 里换掉——用户在语音编辑页改完音色/参数后不重启就能生效。
 */
const firstPick = voices.pick(VOICES_ROOT);
let VOICE = firstPick.spec;
let noVoiceWhy = firstPick.why;
/** 这一套音色偏好的语速（`voice.json` 里可以改；没有就 1.06——稍快一点更像小动物）。 */
let SPEED = VOICE ? VOICE.speed : 1.06;
/** 用户旋钮的音量（voice.json 的 `volume`）。合成完按它缩放，1 = 标准。 */
let SPEED_VOLUME = VOICE && VOICE.knobs ? VOICE.knobs.volume : 1;
/** 音高（`pitch`）。>1 升调（更"萌"），<1 降调。靠后处理重采样实现，见 shiftPitch()。 */
let SPEED_PITCH = VOICE && VOICE.knobs ? VOICE.knobs.pitch : 1;
/** 亮度（`brightness`）。>1 更亮更脆，<1 更闷更柔。 */
let SPEED_BRIGHTNESS = VOICE && VOICE.knobs ? VOICE.knobs.brightness : 1;

let worker = null, seq = 0, broken = null;
const pending = new Map();
const cache = new Map();

/** 当前音色的名字（给日志用）。 */
function voiceName() {
  return VOICE ? VOICE.name : '(没有可用音色)';
}
/** 当前音色的说话人编号（多说话人模型才不是 0）。 */
function voiceSid() {
  return VOICE ? VOICE.sid : 0;
}

/** 语音能不能用：引擎在不在 + 挑中的音色齐不齐。缺就拿"缺什么"当理由，日志里说清楚。 */
function missing() {
  const gaps = VOICE ? VOICE.gaps.slice() : [noVoiceWhy];
  if (!fs.existsSync(path.join(MODULE_DIR, 'package.json'))) gaps.push('sherpa-onnx-node');
  if (!fs.existsSync(path.join(VENDOR, 'sherpa-onnx-win-x64', 'sherpa-onnx.node'))) gaps.push('sherpa-onnx-win-x64');
  return gaps;
}
/** 语音可用吗（不看模型有没有加载完，只看文件在不在）。 */
function available() {
  return !broken && missing().length === 0;
}
/** 不能用的原因（可用时是空字符串）。 */
function why() {
  if (broken) return broken;
  const gaps = missing();
  return gaps.length ? `缺文件（${gaps.join('、')}）—— 跑一次 tools\\setup-tts.ps1 或检查 voice.json` : '';
}

function start() {
  if (worker || !available()) return worker;
  try {
    worker = new Worker(path.join(__dirname, 'tts-worker.cjs'), {
      workerData: {
        moduleDir: MODULE_DIR,
        voice: {
          kind: VOICE.kind,
          sid: VOICE.sid,
          files: VOICE.files,
          // 用户在语音编辑页调的那几个旋钮；worker 会塞进 vits 配置和 generate()
          knobs: VOICE.knobs || {},
        },
        numThreads: 4,
      },
    });
    log.info(`语音音色：${voiceName()}${VOICE.sid ? `（说话人 ${VOICE.sid}）` : ''}${VOICE.note ? ` · ${VOICE.note}` : ''}`);
  } catch (err) {
    broken = `worker 起不来:${err.message}`;
    log.warn(`语音不可用：${broken}`);
    worker = null;
    return null;
  }
  worker.on('message', (m) => {
    const job = pending.get(m.id);
    if (!job) return;
    pending.delete(m.id);
    if (!m.ok) {
      // 合成失败只记一次日志，之后这个进程里不再尝试语音，别每句话都刷一条。
      // 带上 worker 里的堆栈：这个模块的失败几乎都发生在原生插件内部，没有堆栈的话
      // 日志里只剩一句"External buffers are not allowed"这种看起来毫不相干的报错。
      if (!broken) {
        broken = m.error || '合成失败';
        log.warn(`语音合成失败（之后不再出声）：${broken}${m.stack ? `\n     ${m.stack.split('\n').join('\n     ')}` : ''}`);
      }
      job.resolve(null);
      return;
    }
    job.resolve(m);
  });
  worker.on('error', (err) => {
    broken = `worker 出错:${err.message}`;
    log.warn(`语音不可用：${broken}`);
    for (const job of pending.values()) job.resolve(null);
    pending.clear();
    worker = null;
  });
  // 注意：**不要 unref**。unref 之后只要主线程手上没活，Node 就直接退出了，
  // 排队中的合成会跟着丢掉（实测：预热请求发出后进程立刻结束，一句话都没合成）。
  // 应用真要退出时走 `close()`。
  return worker;
}

/**
 * 启动时后台把模型读进来：那 8–9 秒藏在你打字之前。
 *
 * 必须是 `async`（也就是一定返回 Promise）：`main.cjs` 里写的是
 * `tts.warm().catch(...)`，而它原来是**没有返回值的**——于是启动时直接
 * `TypeError: Cannot read properties of undefined (reading 'catch')`，
 * 被 main.cjs 的 catch 当成"启动失败"弹框并 `app.exit(1)`。
 * 桌宠连窗口都出不来，而且只在"语音文件齐了"的机器上才炸（没装语音时
 * `available()` 为假，走的是 else 那条日志）。**实测踩过。**
 */
async function warm() {
  const w = start();
  if (!w) return null;
  const id = `w${++seq}`;
  const t0 = Date.now();
  return new Promise((resolve) => {
    pending.set(id, {
      resolve: (m) => {
        if (m) log.info(`语音已就绪（模型加载 ${Date.now() - t0}ms）`);
        resolve(m || null);
      },
    });
    w.postMessage({ id, kind: 'warm' });
  });
}

/**
 * 16bit 单声道 WAV，带**响度归一化**。
 *
 * 为什么要归一化：各套音色的天生响度差得极远 —— 实测同一句话的 RMS
 * `chaowen -18.2dBFS` / `theresa -19.7dBFS`，而 **`fanchen-c` 只有 -32.7dBFS（低 14dB）**。
 * 不补的话换一套音色就等于音量掉一半，用户会以为是"坏了"（而且小声的时候，
 * 那些轻微的忽大忽小反而更容易被听出来）。
 *
 * `volume` 是用户旋钮（voice.json 的 `volume`，1 = 标准）。归一化按**峰值**对齐到
 * `TARGET_PEAK`，再乘 `volume`；最后用 tanh 软限幅，避免冲过头时硬削出破音。
 */
const TARGET_PEAK = 0.89;      // 归一化目标峰值（留一点余量，别贴 1.0）
const GAIN_MAX = 12;           // 最多放大 12 倍（fanchen-c 天生就低 14dB，归一化后一般用不到）
const GAIN_MIN = 0.25;         // 最多压到 1/4，免得原本很响的被压没

function wavOf(samples, sampleRate, volume = 1) {
  let peak = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const a = samples[i] < 0 ? -samples[i] : samples[i];
    if (a > peak) peak = a;
  }
  // 全是静音就别算了，直接给一段静音
  let gain = peak > 1e-6 ? TARGET_PEAK / peak : 1;
  gain = Math.max(GAIN_MIN, Math.min(GAIN_MAX, gain)) * (Number.isFinite(volume) ? volume : 1);

  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i += 1) {
    // tanh 软限幅：小信号近似线性（听不出染色），只在大信号时压住
    const v = Math.tanh(samples[i] * gain);
    data.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  const head = Buffer.alloc(44);
  head.write('RIFF', 0); head.writeUInt32LE(36 + data.length, 4); head.write('WAVE', 8);
  head.write('fmt ', 12); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22);
  head.writeUInt32LE(sampleRate, 24); head.writeUInt32LE(sampleRate * 2, 28);
  head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34);
  head.write('data', 36); head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

/* ---------- 音高 / 亮度：手册里没有，只能后处理 ---------- */

/**
 * 改音高（pitch）而**不改时长**。**这是唯一能真的把声音变"像少女"的旋钮。**
 *
 * 为什么必须自己做：sherpa-onnx 的 VITS 只有 `lengthScale`（时长）、`noiseScale` /
 * `noiseScaleW`（噪声）、`sid`（说话人）——**没有任何音高/音色参数**
 * （见官方 vits 文档与 Go API 的 `OfflineTtsVitsModelConfig`）。那几套都是单说话人模型，
 * 音色写在权重里，所以只拖噪声滑杆听不出"换人"。
 *
 * ## 为什么不能只用"重采样 + speed 补偿"（我第一版就是这么写的，错了）
 *
 * 重采样把 `N` 个样本变成 `N/p` 个、播放采样率不变 → 音高 ×p、时长 ÷p。
 * 直觉上"让 VITS 先按 p 倍慢下来"就能把时长补回去，但那样是**双重计入**：
 *
 *     raw(p) = base / (speed_ratio)          ← VITS 慢下来，raw 变长 p 倍
 *     输出   = raw(p) / p = (base·p) / p …
 *
 * 实测（fanchen-c，speed=1.05）：pitch 1.0→3.71s、1.2→2.84s、1.4→2.15s、0.85→4.65s，
 * 输出时长精确等于 `3.71 / p`——**时长被算了两次，pitch 顺带变成了变速器**。
 *
 * 正确做法是**两件独立的事**：
 *   1. **变速不变调**（time-stretch，WSOLA）把时长预先拉长 p 倍；
 *   2. **重采样**（÷p）把音高升 p 倍，同时把第 1 步拉长的时长正好抵消回去。
 * 合起来就是"只变音高、不变时长"。VITS 那边**不需要**任何 speed 补偿。
 *
 * WSOLA（波形相似叠加）够用且便宜：帧长 40ms、跳距 20ms、在目标位置附近 ±10ms 里
 * 找最相似的帧再交叠相加，所以不会有相位跳变造成的"嗡嗡"声。
 */
const WSOLA_FRAME = 0.040;     // 帧长（秒）
const WSOLA_HOP = 0.020;       // 合成跳距（秒）
const WSOLA_SEARCH = 0.010;    // 在目标位置附近搜多宽（秒）

/**
 * 真正的入口：把 `input` 变调 `pitch` 倍，**时长不变**。
 * @param {Float32Array} input 原始样本
 * @param {number} pitch 1 = 不变；>1 升调
 * @param {number} sampleRate 采样率（用来把秒换算成帧）
 */
function shiftPitchKeepLength(input, pitch, sampleRate) {
  if (!Number.isFinite(pitch) || Math.abs(pitch - 1) < 1e-3) return input;
  const n = input.length;
  if (n < 256) return input;

  const frame = Math.max(128, Math.round(WSOLA_FRAME * sampleRate));
  const hop = Math.max(64, Math.round(WSOLA_HOP * sampleRate));
  const search = Math.max(8, Math.round(WSOLA_SEARCH * sampleRate));

  // 1) 先把时长拉长 pitch 倍（变速不变调）：每个合成帧从输入里"绕过"一点
  const stretched = wsolaStretch(input, pitch, frame, hop, search);

  // 2) 再降采样 pitch 倍：音高 ×pitch，时长回到原样
  const outLen = Math.max(1, Math.round(stretched.length / pitch));
  const out = new Float32Array(outLen);
  // 升调会折返高频，先压一下
  const src = pitch > 1 ? lowpass3(stretched) : stretched;
  const last = src.length - 1;
  for (let i = 0; i < outLen; i += 1) {
    const pos = i * pitch;
    const i0 = Math.floor(pos);
    if (i0 >= last) { out[i] = src[last] || 0; continue; }
    const frac = pos - i0;
    out[i] = src[i0] * (1 - frac) + src[i0 + 1] * frac;
  }
  return out;
}

/**
 * WSOLA：把 input 在**保持音高**的前提下拉长 `factor` 倍。
 * 每个合成帧都以"上一个已放帧的尾巴"为模板，在目标位置 ±search 里找最像的那一帧，
 * 再乘 Hann 窗交叠相加 —— 相似对齐让交叠处不打架，所以不会出现周期性的咔哒/嗡鸣。
 */
function wsolaStretch(input, factor, frame, hop, search) {
  const n = input.length;
  const outLen = Math.max(frame, Math.round(n * factor) + frame);
  const out = new Float32Array(outLen + frame);
  const win = hann(frame);
  const norm = new Float32Array(outLen + frame);        // 窗的累加，最后做归一化
  const analysisHop = hop / factor;                     // 输入侧跳距
  let inPos = 0;
  let outPos = 0;

  // 第一帧直接放
  const first = input.subarray(0, Math.min(frame, n));
  for (let i = 0; i < first.length; i += 1) {
    out[i] += first[i] * win[i];
    norm[i] += win[i];
  }
  outPos = hop;
  inPos = analysisHop;

  while (outPos + frame < outLen && inPos < n - 1) {
    const want = Math.round(inPos);
    // 以上一帧尾巴为模板，在 want 附近找最相似的起点
    let bestOff = 0;
    let bestScore = -Infinity;
    for (let off = -search; off <= search; off += 4) {
      const st = want + off;
      if (st < 0 || st + frame > n) continue;
      let score = 0;
      // 只比"刚交叠的那一小段"，够判断相似度了，也便宜
      for (let i = 0; i < Math.min(hop, frame); i += 4) {
        const a = out[outPos + i];
        score += a * input[st + i];
      }
      if (score > bestScore) { bestScore = score; bestOff = off; }
    }
    const st = Math.max(0, Math.min(n - frame, want + bestOff));
    for (let i = 0; i < frame && st + i < n; i += 1) {
      out[outPos + i] += input[st + i] * win[i];
      norm[outPos + i] += win[i];
    }
    outPos += hop;
    inPos += analysisHop;
  }

  // 归一化（除窗的累加），避免交叠处忽大忽小
  const res = new Float32Array(Math.min(outPos + frame, outLen));
  for (let i = 0; i < res.length; i += 1) {
    res[i] = norm[i] > 1e-4 ? out[i] / norm[i] : out[i];
  }
  return res;
}

/** Hann 窗。 */
function hann(n) {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i += 1) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1 || 1));
  return w;
}

/** 3 点滑动平均，只有一阶，但足够把折返的镜像高频压下去。 */
function lowpass3(src) {
  const n = src.length;
  const out = new Float32Array(n);
  out[0] = src[0];
  for (let i = 1; i < n - 1; i += 1) out[i] = (src[i - 1] + src[i] + src[i + 1]) / 3;
  out[n - 1] = src[n - 1];
  return out;
}

/**
 * 亮度（formant 的粗略代理）：简单的一阶高通/低通混合。
 *
 * `brightness > 1` 加高频（更"亮"/更脆），`< 1` 削高频（更"闷"/更柔）。
 * 真正的 formant 缩放（变速同时保持共振峰）需要相位声码器，这里不做——
 * 亮度对"少女感"的帮助远不如音高，够用就行。
 */
function shapeTone(input, brightness) {
  if (!Number.isFinite(brightness) || Math.abs(brightness - 1) < 1e-3) return input;
  const n = input.length;
  const out = new Float32Array(n);
  if (n === 0) return out;
  // 一阶低通：y[i] = y[i-1] + a*(x[i]-y[i-1])，a 越大越"跟得上"（高频越多）
  const a = Math.max(0.02, Math.min(0.98, 0.35 * brightness));
  let y = input[0];
  for (let i = 0; i < n; i += 1) {
    y += a * (input[i] - y);
    out[i] = y;
  }
  return out;
}

/**
 * 合成一句话。命中缓存立刻返回，否则排队等 worker。
 * 返回 `{ wav, ms }`，或者 null（语音不可用/失败——调用方当没这回事）。
 *
 * `opts.fresh` = true：**跳过缓存**（试听时要听到当前参数的真实结果，不能被上一次顶掉）。
 *
 * 注意：这里**不能**逐句改 noiseScale 那几个旋钮——它们是模型级的，改了要重建引擎
 * （见 `reload()`）。所以"试听"的语义是"听当前已生效的设置"，改参数必须先 `reload()`。
 * 音高/亮度/音量是**输出后处理**，逐句改没问题。
 */
async function speak(text, opts = {}) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean || !available()) return null;
  const hit = opts.fresh ? null : cache.get(clean);
  if (hit) return { wav: hit, ms: 0 };

  const w = start();
  if (!w) return null;
  const id = `s${++seq}`;
  const started = Date.now();
  const pitch = Number.isFinite(SPEED_PITCH) ? SPEED_PITCH : 1;
  const reply = await new Promise((resolve) => {
    pending.set(id, { resolve });
    // **不要**拿 speed 去补偿音高（我第一版那么写，结果 pitch 顺带变成了变速器）：
    // 音高由 shiftPitchKeepLength() 自己保证"时长不变"，VITS 只管按原语速合成。
    w.postMessage({ id, text: clean.slice(0, 200), speed: SPEED });
  });
  if (!reply) return null;
  // 用户旋钮的响度**乘在归一化之前**（wavOf 会按峰值归一化，乘在后面就没有意义了）。
  // `Float32Array.from` 是必须的：reply.samples 是 transfer 过来的那份，别就地改。
  const vol = Number.isFinite(SPEED_VOLUME) ? SPEED_VOLUME : 1;
  const scaled = vol === 1 ? reply.samples : Float32Array.from(reply.samples, (x) => x * vol);
  const pitched = shiftPitchKeepLength(scaled, pitch, reply.sampleRate);
  const toned = shapeTone(pitched, SPEED_BRIGHTNESS);
  const wav = wavOf(toned, reply.sampleRate);
  if (!opts.fresh) {
    cache.set(clean, wav);
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);   // 先进先出，够用了
  }
  return { wav, ms: Date.now() - started };
}

/**
 * 重新读音色设置并换过来（用户在语音编辑页保存之后调它）。
 *
 * 实现是**把 worker 整个换掉**：模型参数（noiseScale 那些）是在建 OfflineTts 时定的，
 * 改不了就得重建；而重建等于重新加载模型（这一套约 2.5~3.5 秒），
 * 所以放在"用户点了保存"这种明确的时刻做，不进热路径。
 * 缓存也必须清掉——同一句话换音色后听起来完全不同，不能拿旧的顶。
 */
async function reload() {
  close();
  const picked = voices.pick(VOICES_ROOT);
  VOICE = picked.spec;
  noVoiceWhy = picked.why;
  SPEED = VOICE ? VOICE.speed : 1.06;
  SPEED_VOLUME = VOICE && VOICE.knobs ? VOICE.knobs.volume : 1;
  SPEED_PITCH = VOICE && VOICE.knobs ? VOICE.knobs.pitch : 1;
  SPEED_BRIGHTNESS = VOICE && VOICE.knobs ? VOICE.knobs.brightness : 1;
  broken = null;
  log.info(`语音换音色：${voiceName()}${VOICE && VOICE.note ? ` · ${VOICE.note}` : ''}`);
  if (!VOICE) return { ok: false, error: noVoiceWhy };
  // 立刻预热，免得用户说完"保存"之后第一句话还要等模型加载
  warm().catch(() => {});
  return { ok: true, name: voiceName() };
}

/** 应用要退出时收摊。 */
function close() {
  if (worker) { worker.terminate().catch(() => {}); worker = null; }
  // 还在等的活全部放掉：那些 promise 永远不 resolve 的话，说话那条链会一直挂着
  for (const job of pending.values()) job.resolve(null);
  pending.clear();
  cache.clear();
}

module.exports = {
  available, why, warm, speak, close, reload,
  VENDOR, VOICES_ROOT,
  get SPEED() { return SPEED; },
  /** 现在用的是哪套音色（日志和 tools\check-voice-electron.cjs 会打印）。 */
  voiceName, voiceSid,
  voice: () => VOICE,
};
