/**
 * 音色配置：`vendor\tts\voices\<名字>\voice.json` 描述一套音色，`tts.cjs` / `tts-worker.cjs`
 * 只认这一份描述，因此**换音色 = 换一个目录**，不用改代码。
 *
 * 为什么要有这一层：`chaowen` 那套是**男声**（用户反馈"像青年男"），而 sherpa 的音色家族
 * 五花八门（单说话人 / 多说话人、要不要 lexicon、要不要 dict、采样率 8k/16k/22k），
 * 写死在 tts.cjs 里换一次就要动一次代码。现在这些都进 `voice.json`。
 *
 * voice.json 的字段（只有 `name` 必填，其余按模型给，缺了会自动猜）：
 *   {
 *     "name":        "显示名",
 *     "kind":        "vits" | "matcha" | "kokoro" | "kitten"  (默认 vits)
 *     "model":       "xxx.onnx"          模型文件名（目录里只有一个 .onnx 时可以省）
 *     "tokens":      "tokens.txt"
 *     "lexicon":     "lexicon.txt"       (可选；没有就不传)
 *     "dictDir":     "."                (可选；需要词典的模型才传，默认就是音色目录)
 *     "dataDir":     "espeak-ng-data"   (可选；piper 系需要)
 *     "ruleFsts":    ["date.fst","number.fst","phone.fst"]  (可选；存在才加)
 *     "sid":         0                  多说话人模型的说话人编号
 *     "speed":       1.06               这一套音色偏好的语速
 *     "note":        "女声，偏高偏软"     给自己看的备注
 *   }
 */
const fs = require('node:fs');
const path = require('node:path');

/** 模型规格里除了 `name` 以外可以透传给 sherpa 的字段。 */
const PASSTHROUGH = ['kind', 'model', 'tokens', 'lexicon', 'dictDir', 'dataDir', 'ruleFsts', 'sid', 'speed', 'note', 'name'];

/**
 * sherpa 只认这几个模型种类（`OfflineTtsModelConfig` 的字段名，见 types.js）。
 * 写错的话原生层只会抛一句 **"Please provide exactly one tts model."**，
 * 完全看不出是 voice.json 写错了——所以在这里先挡一道，报清楚是哪个值不认。
 */
const KINDS = ['vits', 'matcha', 'kokoro', 'kitten', 'zipvoice', 'pocket'];

/** 目录里只有一个 .onnx 时就用它（大多数 sherpa 音色包都是这样）。 */
function soleOnnx(dir) {
  const ons = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.onnx'));
  return ons.length === 1 ? ons[0] : null;
}

const exists = (dir, f) => !!f && fs.existsSync(path.join(dir, f));

/**
 * 读一个音色目录，返回**已经补全路径**的规格；缺关键文件就返回 null（并说明原因）。
 * 返回：`{ name, kind, sid, speed, note, files: {...}, gaps: [...] }`
 */
function read(dir, folderName) {
  const gaps = [];
  let raw = {};
  const cfgFile = path.join(dir, 'voice.json');
  if (fs.existsSync(cfgFile)) {
    try {
      raw = JSON.parse(fs.readFileSync(cfgFile, 'utf8').replace(/^[\uFEFF\s]+/, ''));
    } catch (err) {
      return { name: folderName, gaps: [`voice.json 读不了（${err.message}）`] };
    }
  }

  const kind = raw.kind || 'vits';
  if (!KINDS.includes(kind)) {
    gaps.push(`kind="${kind}" 不认（只能是 ${KINDS.join(' / ')}）`);
  }
  const model = raw.model && exists(dir, raw.model) ? raw.model : soleOnnx(dir);
  if (!model) gaps.push('没有 .onnx 模型文件');
  if (!exists(dir, raw.tokens || 'tokens.txt')) gaps.push('tokens.txt');
  // lexicon / dict / dataDir 都是可选的：模型需要才给
  const lexicon = exists(dir, raw.lexicon) ? raw.lexicon : (exists(dir, 'lexicon.txt') ? 'lexicon.txt' : null);
  const dataDir = exists(dir, raw.dataDir) ? raw.dataDir : (exists(dir, 'espeak-ng-data') ? 'espeak-ng-data' : null);
  const dictDir = raw.dictDir ? path.join(dir, raw.dictDir) : dir;
  const ruleFsts = (raw.ruleFsts || ['date.fst', 'number.fst', 'phone.fst'])
    .filter((f) => exists(dir, f))
    .map((f) => path.join(dir, f));

  return {
    name: raw.name || folderName,
    kind,
    sid: Number.isInteger(raw.sid) ? raw.sid : 0,
    speed: typeof raw.speed === 'number' ? raw.speed : 1.06,
    note: raw.note || '',
    /**
     * 用户可调的旋钮（语音编辑页写进 voice.json 的那几个）。缺的在这里补默认值，
     * 免得 worker 收到一堆 undefined。真正的默认值和范围在 voice-config.cjs 里定义。
     */
    knobs: {
      speed: num(raw.speed, 1.06),
      pitch: num(raw.pitch, 1.0),
      brightness: num(raw.brightness, 1.0),
      volume: num(raw.volume, 1.0),
      noiseScale: num(raw.noiseScale, 0.667),
      noiseScaleW: num(raw.noiseScaleW, 0.8),
      lengthScale: num(raw.lengthScale, 1.0),
      silenceScale: num(raw.silenceScale, 0.2),
    },
    gaps,
    files: {
      dir,
      model: model ? path.join(dir, model) : null,
      tokens: exists(dir, raw.tokens || 'tokens.txt') ? path.join(dir, raw.tokens || 'tokens.txt') : null,
      lexicon: lexicon ? path.join(dir, lexicon) : null,
      dictDir,
      dataDir: dataDir ? path.join(dir, dataDir) : null,
      ruleFsts,
    },
  };
}

/** 数字就给，不是数字给默认值（voice.json 是手写/界面写的，不能假定它干净）。 */
function num(v, def) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

/** 列出 `voices\` 下所有音色目录（按目录名排序，顺序稳定）。 */
function list(voicesRoot) {
  if (!fs.existsSync(voicesRoot)) return [];
  return fs.readdirSync(voicesRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => ({ folder: d.name, dir: path.join(voicesRoot, d.name) }))
    .sort((a, b) => a.folder.localeCompare(b.folder));
}

/**
 * 挑出要用的音色：优先 `voices\.active`（里面只写一个目录名），
 * 否则用第一个**完整可用**的音色。返回 `{ spec, why }`——why 说明为什么是这个。
 */
function pick(voicesRoot) {
  const all = list(voicesRoot);
  if (!all.length) return { spec: null, why: `voices 目录里没有音色：${voicesRoot}` };

  const activeFile = path.join(voicesRoot, '.active');
  if (fs.existsSync(activeFile)) {
    const want = fs.readFileSync(activeFile, 'utf8').replace(/^[\uFEFF\s]+/, '').trim();
    const hit = all.find((v) => v.folder === want);
    if (!hit) return { spec: null, why: `voices\\.active 指向的音色不存在：${want}` };
    const spec = read(hit.dir, hit.folder);
    if (spec.gaps.length) return { spec: null, why: `音色「${hit.folder}」缺文件：${spec.gaps.join('、')}` };
    return { spec, why: `voices\\.active 指定` };
  }

  const firstOk = all.map((v) => read(v.dir, v.folder)).find((s) => !s.gaps.length);
  if (firstOk) return { spec: firstOk, why: '第一个完整可用的音色（没有 .active）' };

  const why = all.map((v) => {
    const s = read(v.dir, v.folder);
    return `${v.folder}（缺 ${s.gaps.join('、')}）`;
  }).join('；');
  return { spec: null, why: `没有可用音色：${why}` };
}

module.exports = { list, read, pick, PASSTHROUGH };
