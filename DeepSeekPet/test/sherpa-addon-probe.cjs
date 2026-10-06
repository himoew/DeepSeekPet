/**
 * 实测：sherpa-onnx 的原生 Node 插件能不能在这个 Node/Electron 里加载，并做常驻 TTS。
 * 这是"引擎只加载一次"的关键——比每次 spawn 命令行省掉约 8 秒的模型加载。
 *
 *   node test\sherpa-addon-probe.cjs <sherpa-onnx-node 目录> <模型目录> [重复次数]
 */
const path = require('node:path');
const fs = require('node:fs');

const [modDir, modelDir, times = '2'] = process.argv.slice(2);
if (!modDir || !modelDir) {
  console.error('用法: node test\\sherpa-addon-probe.cjs <sherpa-onnx-node 目录> <模型目录> [次数]');
  process.exit(2);
}

const t0 = Date.now();
// 原生插件和两个 onnxruntime dll 都在 sherpa-onnx-win-x64 里，node 加载 .node 时会去找同目录的 dll，
// 所以先把那个目录放进搜索路径（process.env.PATH 对已加载的进程同样有效）。
const winPkg = path.join(modDir, '..', 'sherpa-onnx-win-x64');
process.env.PATH = `${winPkg};${process.env.PATH}`;
console.log('原生包目录:', winPkg, fs.existsSync(winPkg));

let sherpa;
try {
  sherpa = require(path.join(modDir, 'non-streaming-tts.js'));
  console.log(`插件加载成功（${Date.now() - t0}ms）`);
} catch (err) {
  console.error('插件加载失败:', err.message);
  process.exit(1);
}

const p = (f) => path.join(modelDir, f);
const config = {
  model: {
    vits: {
      model: p('zh_CN-chaowen-medium.onnx'),
      tokens: p('tokens.txt'),
      lexicon: p('lexicon.txt'),
      // 中文 piper 模型自带的文本规则（日期/数字/电话），不给我会读得奇怪
      dictDir: modelDir,
      ruleFsts: [p('date.fst'), p('number.fst'), p('phone.fst')].join(','),
    },
    numThreads: 4,
    debug: false,
    provider: 'cpu',
  },
};

console.log('配置:', JSON.stringify(config.model.vits, null, 2));

let tts;
try {
  const loadAt = Date.now();
  tts = new sherpa.OfflineTts(config);
  console.log(`模型加载完成（${Date.now() - loadAt}ms，累计 ${Date.now() - t0}ms）· 采样率 ${tts.sampleRate}`);
} catch (err) {
  console.error('模型加载失败:', err.message);
  process.exit(1);
}

const texts = ['你好呀。', '晚上好呀。我是大肥鱼，今天也一起吧。'];
for (let i = 0; i < Number(times); i += 1) {
  const text = texts[i % texts.length];
  const at = Date.now();
  try {
    const audio = tts.generate({ text, sid: 0, speed: 1 });
    const ms = Date.now() - at;
    const dur = Math.round((audio.samples.length / audio.sampleRate) * 1000);
    console.log(`第 ${i + 1} 次「${text}」→ 合成 ${ms}ms · 音频 ${dur}ms · RTF ${(ms / dur).toFixed(2)} · 采样率 ${audio.sampleRate}`);
  } catch (err) {
    console.error(`第 ${i + 1} 次合成失败:`, err.message);
  }
}
console.log(`常驻方案：模型只加载一次，之后每次只要上面那个"合成"时间。`);
process.exit(0);
