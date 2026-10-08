/**
 * 音色调节：把用户可调的参数**存进对应的 `voice.json`**，并让正在跑的语音立刻换过来。
 *
 * 为什么单独一个文件：这套读写要被三处用到 —— 设置窗口的 IPC、`/api/voice/*` 那两个
 * 给语音编辑页用的 HTTP 接口、以及 `tts.cjs` 启动时读参数。逻辑只能有一份。
 *
 * 可调参数（都是 sherpa 的 VITS 原生旋钮，见 vendor\tts\sherpa-onnx-node\types.js）：
 *
 * | 参数 | 字段 | 默认 | 作用 |
 * |---|---|---|---|
 * | 语速 | `speed` | 1.06 | 快慢。越大越快（≥1 会把语速拉快，太大会含糊） |
 * | 稳定度 | `noiseScale` | 0.667 | **越小越稳、越"平"**；越大越有起伏（太大就忽大忽小） |
 * | 音高起伏 | `noiseScaleW` | 0.8 | 同上，管音高那条线；越大越"飘" |
 * | 音色时长 | `lengthScale` | 1.0 | 音素拉长/压缩，和语速配合决定"黏不黏" |
 * | 停顿 | `silenceScale` | 0.2 | 句子之间的静音长度 |
 * | 说话人 | `sid` | 0 | 只有多说话人模型（如 fanchen-c，187 人）才有意义 |
 *
 * **用户反馈的"忽大忽小、不像人说话"就是 noiseScale / noiseScaleW 偏大的典型症状**：
 * 把这两个调小（稳定度往"稳"那边拉）就平了，代价是"灵动"变少——所以这三个滑杆
 * 就是那个取舍本身，交给用户自己找平衡点。
 */
const fs = require('node:fs');
const path = require('node:path');
const voiceSpec = require('./tts-voice.cjs');

/** 旋钮的名字、默认值、以及给界面看的取值范围。 */
const KNOBS = {
  speed:       { def: 1.06,  min: 0.5,  max: 2.0,  step: 0.02 },
  // 音高：**改音色最有效的一个**。sherpa 的 VITS 没有音高参数（只有时长/噪声/说话人），
  // 所以这个是 `tts.cjs` 里用重采样做的后处理，见 shiftPitch()。
  pitch:       { def: 1.0,   min: 0.6,  max: 1.8,  step: 0.01 },
  // 亮度：粗糙的 formant 代理，帮"少女感"一点忙（不如音高关键）
  brightness:  { def: 1.0,   min: 0.4,  max: 2.0,  step: 0.02 },
  // 响度：合成出的音频先按峰值归一化，再乘这个系数。
  // 各套音色天生响度差很多（fanchen-c 比 chaowen 低 14dB），归一化之后用这个微调。
  volume:      { def: 1.0,   min: 0.2,  max: 3.0,  step: 0.05 },
  // 下面这几个是 sherpa 的**标准**参数（VITS 手册里就这三个 + sid），
  // 实测对"像不像人、像不像少女"影响很小，主要管节奏和稳定度。
  noiseScale:  { def: 0.667, min: 0.0,  max: 1.5,  step: 0.005 },
  noiseScaleW: { def: 0.8,   min: 0.0,  max: 1.5,  step: 0.01 },
  lengthScale: { def: 1.0,   min: 0.5,  max: 2.0,  step: 0.02 },
  silenceScale:{ def: 0.2,   min: 0.0,  max: 1.0,  step: 0.01 },
  sid:         { def: 0,     min: 0,    max: 1000, step: 1, integer: true },
};

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** 把一份（可能残缺、可能越界的）参数修成能用的：缺的补默认，越界的夹回去。 */
function normalize(raw = {}) {
  const out = {};
  for (const [k, spec] of Object.entries(KNOBS)) {
    let v = raw[k];
    v = Number(v);
    if (!Number.isFinite(v)) v = spec.def;
    v = clamp(v, spec.min, spec.max);
    if (spec.integer) v = Math.round(v);
    out[k] = v;
  }
  return out;
}

/** 音色的 `voice.json` 路径。 */
const fileOf = (voicesRoot, folder) => path.join(voicesRoot, folder, 'voice.json');
/** 引擎与音色都在这个根下（`tts.cjs` 也这么算）。 */
const rootOf = (vendorDir) => path.join(vendorDir, 'voices');

/** 读一份 voice.json（坏了就当空的，不要因为一个音色文件坏掉整个应用）。 */
function readRaw(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^[\uFEFF\s]+/, ''));
  } catch (e) {
    return {};
  }
}

/**
 * 这套音色有多少个说话人（决定界面上"说话人"滑杆拉到哪）。
 *
 * 依据，按可靠性排序：
 *  1. 音色目录里的 `speakers.txt`（sherpa 给多说话人模型配的，一行一个编号）——最准；
 *  2. `voice.json` 里自己写的 `speakers`；
 *  3. 退回 0（= 只有一个说话人，界面就不显示那一项）。
 *
 * **实测教训**：不能靠"模型名里有 vits-zh"就当成多说话人——`theresa` 名字看不出，
 * 其实是 804 人的模型（换 sid 连性别都会变：sid=0 是 339Hz，sid=666 是 136Hz 的男声），
 * 而原来那句正则把所有 `vits-zh*` 都当多说话人，反而让单人的 `chaowen` 也可能被误判。
 */
function speakerCount(dir, raw) {
  const spk = path.join(dir, 'speakers.txt');
  if (fs.existsSync(spk)) {
    try {
      const n = fs.readFileSync(spk, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean).length;
      if (n > 0) return n;
    } catch (e) { /* 读不动就走下面 */ }
  }
  const n = Number(raw.speakers);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * 列出所有音色 + 当前参数 + 当前用的是哪套。给编辑页用。
 */
function list(vendorDir) {
  const root = rootOf(vendorDir);
  const picked = voiceSpec.pick(root);
  const currentFolder = picked.spec ? path.basename(picked.spec.files.dir) : null;

  const voices = voiceSpec.list(root).map((v) => {
    const spec = voiceSpec.read(v.dir, v.folder);
    const raw = readRaw(fileOf(root, v.folder));
    const knobs = normalize(raw);
    const speakers = speakerCount(v.dir, raw);
    return {
      folder: v.folder,
      name: spec.name,
      note: spec.note || '',
      // 超过 1 个说话人才显示"说话人"滑杆
      speakers,
      multiSpeaker: speakers > 1,
      usable: spec.gaps.length === 0,
      gaps: spec.gaps,
      knobs,
      defaults: normalize({}),
      // 试听要用：拿它 + knobs 就能直接合成，不用再去解析一遍音色目录
      spec,
    };
  });

  return { current: currentFolder, voices, reasons: picked.why, ranges: KNOBS };
}

/**
 * 给某个音色保存参数。只写 KNOBS 里那几个字段，模型路径那些**原样保留**。
 * 返回 `{ ok, folder, knobs }`。
 */
function save(vendorDir, folder, patch) {
  const root = rootOf(vendorDir);
  const dir = path.join(root, folder);
  if (!fs.existsSync(dir)) return { ok: false, error: `没有这个音色：${folder}` };

  const file = fileOf(root, folder);
  const raw = readRaw(file);
  const knobs = normalize({ ...normalize(raw), ...patch });
  const next = { ...raw, ...knobs };
  // 用户自己调过，就别再让旧的 `speed` 之类的默认值打架：knobs 就是权威
  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return { ok: true, folder, knobs };
}

/** 切换当前音色：改 `voices\.active`。 */
function activate(vendorDir, folder) {
  const root = rootOf(vendorDir);
  if (!voiceSpec.list(root).some((v) => v.folder === folder)) {
    return { ok: false, error: `没有这个音色：${folder}` };
  }
  fs.writeFileSync(path.join(root, '.active'), folder, 'utf8');
  return { ok: true, folder };
}

module.exports = { KNOBS, normalize, list, save, activate, rootOf };
