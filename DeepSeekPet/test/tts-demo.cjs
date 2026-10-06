/**
 * 用常驻插件渲染几句"桌宠会说的话"，存成 WAV 给人试听。
 * 顺便确认：同一个引擎连续合成多句时，除了第一次加载，后面都很快。
 *
 *   node test\tts-demo.cjs <sherpa-onnx-node 目录> <模型目录> <输出目录>
 */
const path = require('node:path');
const fs = require('node:fs');

const [modDir, modelDir, outDir] = process.argv.slice(2);
const winPkg = path.join(modDir, '..', 'sherpa-onnx-win-x64');
process.env.PATH = `${winPkg};${process.env.PATH}`;
const sherpa = require(path.join(modDir, 'non-streaming-tts.js'));

/** GeneratedAudio → 16bit PCM WAV。 */
function toWav(audio) {
  const { samples, sampleRate } = audio;
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i += 1) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    data.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  const head = Buffer.alloc(44);
  head.write('RIFF', 0); head.writeUInt32LE(36 + data.length, 4); head.write('WAVE', 8);
  head.write('fmt ', 12); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22);
  head.writeUInt32LE(sampleRate, 24); head.writeUInt32LE(sampleRate * 2, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34);
  head.write('data', 36); head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

const p = (f) => path.join(modelDir, f);
const tts = new sherpa.OfflineTts({
  model: {
    vits: {
      model: p('zh_CN-chaowen-medium.onnx'),
      tokens: p('tokens.txt'),
      lexicon: p('lexicon.txt'),
      dictDir: modelDir,
      ruleFsts: [p('date.fst'), p('number.fst'), p('phone.fst')].join(','),
    },
    numThreads: 4,
    provider: 'cpu',
  },
});

fs.mkdirSync(outDir, { recursive: true });
const lines = [
  ['01-问候', '晚上好呀。今天也一起吧。'],
  ['02-被戳', '诶——别戳那里，痒。'],
  ['03-傲娇', '哼，我才没有一直看着你呢。'],
  ['04-自动说话', '忙碌了一天，终于可以休息一会儿了。'],
  ['05-长句', '有点想吃东西了，你要不要也去吃点？我在这儿等你回来。'],
];

for (const [name, text] of lines) {
  const at = Date.now();
  const audio = tts.generate({ text, sid: 0, speed: 1 });
  const ms = Date.now() - at;
  const file = path.join(outDir, `${name}.wav`);
  fs.writeFileSync(file, toWav(audio));
  const dur = Math.round((audio.samples.length / audio.sampleRate) * 1000);
  console.log(`${name.padEnd(12)} 合成 ${String(ms).padStart(4)}ms · 音频 ${String(dur).padStart(4)}ms · RTF ${(ms / dur).toFixed(2)} · ${path.basename(file)}`);
}
