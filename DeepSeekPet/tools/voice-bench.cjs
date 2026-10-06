/**
 * 给一套音色打分：可用性、冷启动加载、逐句合成耗时、缓存命中，并写几个样音。
 *
 *   node tools\voice-bench.cjs [音色目录名]
 *
 * 不带参数就测 `voices\.active` 指定的那套。这是**纯 Node**，用来快速比较音色；
 * 真要确认在桌宠里能出声还得跑 tools\check-voice-electron.cjs（第 1.8 节第 ② 条）。
 */
const fs = require('node:fs');
const path = require('node:path');

const APP = path.join(__dirname, '..', 'resources', 'app');
const VENDOR = path.join(APP, 'vendor', 'tts');
const VOICES_ROOT = path.join(VENDOR, 'voices');
const voices = require(path.join(APP, 'tts-voice.cjs'));

const want = process.argv[2];
let spec = null;
if (want) {
  const hit = voices.list(VOICES_ROOT).find((v) => v.folder === want);
  if (!hit) { console.error(`没有这个音色：${want}`); process.exit(2); }
  spec = voices.read(hit.dir, hit.folder);
  if (spec.gaps.length) { console.error(`音色「${want}」缺文件：${spec.gaps.join('、')}`); process.exit(1); }
} else {
  const picked = voices.pick(VOICES_ROOT);
  spec = picked.spec;
  if (!spec) { console.error(`没有可用音色：${picked.why}`); process.exit(1); }
}

const winPkg = path.join(VENDOR, 'sherpa-onnx-win-x64');
process.env.PATH = `${winPkg};${process.env.PATH}`;
const { Worker } = require('node:worker_threads');

const w = new Worker(path.join(APP, 'tts-worker.cjs'), {
  workerData: { moduleDir: path.join(VENDOR, 'sherpa-onnx-node'), voice: { kind: spec.kind, sid: spec.sid, files: spec.files }, numThreads: Number(process.env.DSP_TTS_THREADS || 4) },
});

const jobs = new Map();
let n = 0;
const ask = (job) => new Promise((r) => { jobs.set(job.id, r); w.postMessage(job); });
w.on('message', (m) => { const r = jobs.get(m.id); if (r) { jobs.delete(m.id); r(m); } });

const wavOf = (samples, rate) => {
  const d = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i += 1) d.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + d.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(d.length, 40);
  return Buffer.concat([h, d]);
};

const SENTENCES = [
  '你好呀，我是大肥鱼。',
  '唔……你回来啦，我等你好久了。',
  '今天也要一起玩哦，不许偷偷溜走。',
  '你好呀，我是大肥鱼。',                       // 重复：考缓存
  '早点睡吧，我在这儿守着你，明天见。',
];

(async () => {
  console.log(`音色：${spec.name}${spec.note ? ` · ${spec.note}` : ''}  (${path.basename(spec.files.dir)})`);
  console.log(`sid=${spec.sid}  kind=${spec.kind}  speed=${spec.speed}\n`);

  const t0 = Date.now();
  const warm = await ask({ id: `w${++n}`, kind: 'warm' });
  console.log(warm && warm.ok ? `模型加载 ${Date.now() - t0}ms` : `加载失败: ${warm && warm.error}`);

  const outDir = path.join(__dirname, '..', 'voice-samples', `bench-${path.basename(spec.files.dir)}`);
  fs.mkdirSync(outDir, { recursive: true });

  let total = 0, count = 0;
  for (const text of SENTENCES) {
    const t = Date.now();
    const r = await ask({ id: `s${++n}`, text, speed: spec.speed });
    const ms = Date.now() - t;
    if (!r || !r.ok) { console.log(`  「${text}」失败: ${r && r.error}`); continue; }
    const secs = r.samples.length / r.sampleRate;
    const rtf = (ms / 1000 / secs);
    total += ms; count += 1;
    console.log(`  ${r.sampleRate}Hz ${secs.toFixed(2)}s音频  合成 ${String(ms).padStart(5)}ms  RTF ${rtf.toFixed(2)}  「${text}」`);
    fs.writeFileSync(path.join(outDir, `${String(count).padStart(2, '0')}.wav`), wavOf(r.samples, r.sampleRate));
  }
  console.log(`\n平均合成 ${Math.round(total / Math.max(1, count))}ms/句 · 样音写到 ${outDir}`);
  await w.terminate();
  process.exit(0);
})().catch(async (e) => { console.error(`失败: ${e.message}`); try { await w.terminate(); } catch (x) {} process.exit(1); });
