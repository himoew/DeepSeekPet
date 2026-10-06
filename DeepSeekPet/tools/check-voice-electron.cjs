/**
 * 在 **Electron 自己的 V8** 下真正合成一句话 —— 这是 `smoke.cjs` 抓不到的那个坑的哨兵。
 *
 *   cmd /c "set ELECTRON_RUN_AS_NODE=1 && ""D:\pet\DeepSeekPet\Coopanion.exe"" tools\check-voice-electron.cjs"
 *
 * 两个坑它都管：
 *  ① **Electron 的 V8 比纯 Node 新**：sherpa 默认的零拷贝外部分配在 Electron 44（V8 15.2）
 *     下被拒，报 `External buffers are not allowed`；纯 Node 24（V8 13.6）不报。
 *     于是 `node test\smoke.cjs` 永远绿，真实桌宠一句都念不出来。
 *  ② **音色配置**：它走的是 `tts.cjs` 那条**真路**（同一个 `tts-voice` 解析、同一个 worker
 *     协议），所以 voice.json 写错、缺文件、`.active` 指向不存在，这里都会先炸，
 *     而不是等到桌宠里才发现。
 *
 * 退出码：0 = 这条路径能出声；1 = 出不了声（就是这个文件要拦住的那种回归）。
 */
const fs = require('node:fs');
const path = require('node:path');

const APP = path.join(__dirname, '..', 'resources', 'app');
const VENDOR = path.join(APP, 'vendor', 'tts');
const isElectron = !!process.versions.electron;

console.log(`V8 ${process.versions.v8} · Node ${process.versions.node}${isElectron ? ` · Electron ${process.versions.electron}` : ' （纯 Node）'}`);

if (!fs.existsSync(path.join(VENDOR, 'sherpa-onnx-node', 'package.json'))) {
  console.log('语音没装（vendor\\tts 不在），跳过');
  process.exit(0);
}

// 走 tts.cjs 自己那条路：可用性、挑中的音色、预热、合成，全都用生产代码。
const tts = require(path.join(APP, 'tts.cjs'));

console.log(`可用: ${tts.available()}${tts.available() ? '' : ' —— ' + tts.why()}`);
if (!tts.available()) { console.error(`FAIL ${tts.why()}`); process.exit(1); }

const spec = tts.voice();
console.log(`音色: ${tts.voiceName()}${spec && spec.note ? ` · ${spec.note}` : ''}  sid=${tts.voiceSid()}  speed=${tts.SPEED}`);

/** 音频是不是真的有人声：整段的能量不能是 0（空数组/静音都过不了）。 */
const energy = (samples) => {
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) sum += Math.abs(samples[i]);
  return sum / (samples.length || 1);
};

(async () => {
  const TEXT = '你好呀，我是大肥鱼。';

  const t0 = Date.now();
  await tts.warm();
  const warmMs = Date.now() - t0;

  const t1 = Date.now();
  const r = await tts.speak(TEXT);
  const ms = Date.now() - t1;

  if (!r || !r.wav || r.wav.length < 1000) {
    console.error(`FAIL 合成失败/没音频: ${JSON.stringify(r && { ms: r.ms, len: r.wav && r.wav.length })}`);
    console.error(tts.why() || '（tts.cjs 没给出原因）');
    tts.close();
    process.exit(1);
  }

  // 从 WAV 里量点东西出来：44 字节头 + 16bit 单声道
  const wav = r.wav;
  const isRiff = wav.toString('ascii', 0, 4) === 'RIFF' && wav.toString('ascii', 8, 12) === 'WAVE';
  const rate = wav.readUInt32LE(24);
  const frames = (wav.length - 44) / 2;
  const secs = frames / rate;
  let peak = 0, sum = 0;
  for (let i = 44; i + 1 < wav.length; i += 2) {
    const v = Math.abs(wav.readInt16LE(i)) / 32768;
    sum += v;
    if (v > peak) peak = v;
  }
  const avg = sum / (frames || 1);

  const checks = [
    ['音频是合法 WAV（RIFF/WAVE）', isRiff, `${(wav.length / 1024).toFixed(0)}KB`],
    ['采样率正常', rate >= 8000 && rate <= 48000, `${rate}Hz`],
    ['音频长度合理', secs > 0.3 && secs < 30, `${secs.toFixed(2)}s`],
    ['不是一串静音', avg > 1e-4 && peak > 0.05, `均值 ${avg.toFixed(5)} / 峰值 ${peak.toFixed(3)}`],
  ];
  let bad = 0;
  for (const [name, cond, extra] of checks) {
    console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${name}  ${extra}`);
    if (!cond) bad += 1;
  }
  console.log(`  模型加载 ${warmMs}ms · 「${TEXT}」合成 ${ms}ms（${r.ms}ms 内部）`);

  tts.close();
  if (!isElectron) {
    console.log('\n注意：这次跑在纯 Node 下，**没有**验到 Electron 的 V8。要验真那条路：');
    console.log('  cmd /c "set ELECTRON_RUN_AS_NODE=1 && ""D:\\pet\\DeepSeekPet\\Coopanion.exe"" ""%CD%\\tools\\check-voice-electron.cjs"""');
  }
  process.exit(bad ? 1 : 0);
})().catch((err) => {
  console.error(`FAIL ${err.message}`);
  try { tts.close(); } catch (e) { /* ignore */ }
  process.exit(1);
});
