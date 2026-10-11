/**
 * ============================================================================
 * 把**任何一段现成的音频/视频**切成一个"无缝循环 + 电平对齐"的环境音（临时工具，不进安装包）
 * ============================================================================
 *
 * ★ 为什么换成这条路（2026-10-11 深夜，用户拍板）：
 *   "为什么我们非要用代码生成，而不是从视频里扣一段循环音频下来？"
 *   —— 对。合成那套的坑（慢游走 / 包络 / NaN / 越到后面越大）在这里**一个都不存在**。
 *
 * ★ 这一版把 ffmpeg 只用两件事：**解码/重采样** 与 **编码 ogg**。
 *   拼接、交叉淡化、电平全部在 JS 里**逐样点算** ——
 *   因为 ffmpeg 的 `acrossfade` 在"淡化长度 = 输入长度"时直接吐 0 帧，
 *   `volume=` 表达式又拿不到 `t`（报 NaN，实测把尾巴整个静掉），
 *   而 `amix` 出来的接缝我量到 **±25000 的单样点跳变**（-8dB 的塌陷）。
 *   与其跟滤镜图较劲，不如把这段算术拿回自己手里：一律可测量。
 *
 * 用法：
 *     node dev-weather\make-loop.mjs dev-weather\samples\loops.spec.json
 *
 * 每条 item：
 *   ① 选窗口：`start: "auto"` → 在整段录音里找**最平稳**的 `len` 秒（逐秒 RMS 方差最小）；
 *   ② 无缝化（**关键**）：取 `[start, start+len+fade]`，把 `[len, len+fade]` 这段（尾巴）
 *      与 `[0, fade]`（开头）做**等功率交叉淡化**，拼成 `[交叉段(len=fade)][主体(len-fade)]`。
 *      于是"文件最后一个样点的下一个样点 = 文件第一个样点"—— 接缝在**数学上**就是连续的；
 *   ③ 电平：RMS 归到 `targetDb`（默认 -26dBFS），峰值硬顶 ≤ -1.5dBFS；
 *   ④ 输出 48k 立体声 ogg，并回量接缝跳变写进 `index.json`（试听页读它）。
 *
 * ★ `src` 可以是**数组**（多段拼起来再循环）；压缩包（zip/7z）会自动解；**视频文件也能直接喂**。
 * ⚠️ 沙箱不允许子进程管道 stdio，所以 ffmpeg 的 stderr 一律重定向到文件/`ignore`。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fft } from './meter.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const FF = process.env.FFMPEG || 'D:\\xunlei\\ffmpeg-release-essentials\\ffmpeg-7.1.1-essentials_build\\bin\\ffmpeg.exe';
const SEVENZIP = process.env.SEVENZIP || 'C:\\Program Files\\AMD\\CIM\\Bin64\\7z.exe';
const WORK = path.join(process.env.TEMP || '.', 'pet-loop-work');
fs.mkdirSync(WORK, { recursive: true });
const R = (p) => (path.isAbsolute(p) ? p : path.join(ROOT, p));
const SR = 48000;

/** 跑外部命令：stderr 写文件（不走管道）。 */
function run(bin, args, logName) {
  const logFile = path.join(WORK, logName + '.log');
  const fd = fs.openSync(logFile, 'w');
  return new Promise((resolve) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'ignore', fd] });
    p.on('close', (code) => { fs.closeSync(fd); resolve({ code, log: fs.readFileSync(logFile, 'utf8') }); });
    p.on('error', () => { try { fs.closeSync(fd); } catch (e) { /* ignore */ } resolve({ code: -1, log: '' }); });
  });
}

async function duration(file) {
  const { log } = await run(FF, ['-hide_banner', '-i', file, '-f', 'null', '-'], 'dur');
  const m = log.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  return m ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) : 0;
}

/** 8k 单声道逐秒 RMS（用来找"最平稳的窗口"）。 */
async function perSecondRms(file, tag) {
  const raw = path.join(WORK, 'scan-' + tag + '.pcm');
  if (fs.existsSync(raw)) fs.rmSync(raw);
  await run(FF, ['-y', '-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', '8000', '-f', 's16le', raw], 'scan');
  if (!fs.existsSync(raw)) return [];
  const buf = fs.readFileSync(raw);
  const n = Math.floor(buf.length / 2);
  const per = 8000;
  const out = [];
  for (let s = 0; s + per <= n; s += per) {
    let sum = 0;
    for (let i = 0; i < per; i += 1) { const v = buf.readInt16LE((s + i) * 2) / 32768; sum += v * v; }
    out.push(Math.sqrt(sum / per));
  }
  return out;
}

function steadiestStart(perSec, windowSec) {
  const w = Math.max(1, Math.floor(windowSec));
  if (perSec.length <= w) return 0;
  let best = 0, bestVar = Infinity;
  for (let i = 0; i + w <= perSec.length; i += 1) {
    let m = 0;
    for (let k = 0; k < w; k += 1) m += perSec[i + k];
    m /= w;
    if (m <= 0) continue;
    let v = 0;
    for (let k = 0; k < w; k += 1) { const d = perSec[i + k] / m - 1; v += d * d; }
    v /= w;
    if (v < bestVar) { bestVar = v; best = i; }
  }
  return best;
}

/** 解码成 48k 立体声 f32le，读进 Float32Array（交错）。 */
async function decode(src, start, secs, tag) {
  const raw = path.join(WORK, 'dec-' + tag + '.pcm');
  if (fs.existsSync(raw)) fs.rmSync(raw);
  const { code, log } = await run(FF, [
    '-y', '-v', 'error', '-ss', String(start), '-t', String(secs), '-i', src,
    '-vn', '-ac', '2', '-ar', String(SR), '-f', 'f32le', raw,
  ], 'dec-' + tag);
  if (code !== 0 || !fs.existsSync(raw)) return { data: null, log };
  const b = fs.readFileSync(raw);
  const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  return { data: new Float32Array(ab), frames: Math.floor(b.length / 8), log };
}

const rmsOf = (d, from = 0, to = d.length) => {
  let s = 0;
  for (let i = from; i < to; i += 1) s += d[i] * d[i];
  return Math.sqrt(s / Math.max(1, to - from));
};
const peakOf = (d) => { let p = 0; for (let i = 0; i < d.length; i += 1) { const a = Math.abs(d[i]); if (a > p) p = a; } return p; };

/** 接缝指标：环绕处的样点差 vs 内部样点差的 99.9 分位（<1 = 比内部还平滑）。 */
function seamMetric(d) {
  const diffs = new Float32Array(d.length - 1);
  for (let i = 1; i < d.length; i += 1) diffs[i - 1] = Math.abs(d[i] - d[i - 1]);
  const sorted = Float32Array.from(diffs).sort();
  const p999 = sorted[Math.floor(sorted.length * 0.999)];
  const wrap = Math.abs(d[0] - d[d.length - 1]);
  return { wrapJump: +wrap.toFixed(6), interiorP999: +p999.toFixed(6), ratio: +(wrap / Math.max(1e-9, p999)).toFixed(3) };
}

/**
 * ★★ **素材体检**：把整段录音解成 16k 单声道，算两样东西 ——
 *   ① 逐秒 RMS（找"最平稳的窗口"）；
 *   ② **每个窗口的"音调峰"**（频谱里最尖的那个峰比它周围中位数高多少 dB）——
 *      这是"**全是铃声**"的量化判据（用户 2026-10-11 对落叶那档的原话）。
 *      实测：他挑中的 rain-1/snow-2 都在 +5.8dB 以内，而"响铃"的落叶是 **+28 ~ +32dB**
 *      （那是风在树/房间里吹出的**哨音**，不是树叶沙沙）。
 */
async function analyze(file, tag) {
  const raw = path.join(WORK, 'an-' + tag + '.pcm');
  if (fs.existsSync(raw)) fs.rmSync(raw);
  await run(FF, ['-y', '-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', '16000', '-f', 's16le', raw], 'an-' + tag);
  if (!fs.existsSync(raw)) return null;
  const b = fs.readFileSync(raw);
  const n = Math.floor(b.length / 2);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i += 1) x[i] = b.readInt16LE(i * 2) / 32768;
  const per = [];
  for (let s = 0; s + 16000 <= n; s += 16000) {
    let sum = 0;
    for (let i = 0; i < 16000; i += 1) sum += x[s + i] * x[s + i];
    per.push(Math.sqrt(sum / 16000));
  }
  const N = 2048;
  const win = new Float32Array(N);
  for (let i = 0; i < N; i += 1) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
  /** 某个窗口里"最尖的音调峰"比周围中位数高多少 dB（越大越像哨音/铃声）。 */
  const toneAt = (sec, lenSec) => {
    const from = Math.max(0, Math.floor(sec * 16000));
    const to = Math.min(n, Math.floor((sec + lenSec) * 16000));
    const spec = new Float64Array(N / 2 + 1);
    let frames = 0;
    for (let off = from; off + N <= to; off += N) {
      const re = new Float32Array(N), im = new Float32Array(N);
      for (let i = 0; i < N; i += 1) re[i] = x[off + i] * win[i];
      fft(re, im);
      for (let k = 0; k <= N / 2; k += 1) spec[k] += re[k] * re[k] + im[k] * im[k];
      frames += 1;
    }
    if (!frames) return 0;
    for (let k = 0; k <= N / 2; k += 1) spec[k] /= frames;
    const bin = 16000 / N;                     // 7.8Hz
    const kLo = Math.max(20, Math.round(150 / bin));      // 150Hz 以下不算（那是"厚度"，不是哨音）
    const kHi = Math.round(7000 / bin);
    let worst = 0;
    for (let k = kLo + 13; k <= kHi - 13 && k <= N / 2 - 13; k += 1) {
      const around = [];
      for (let j = k - 12; j <= k + 12; j += 1) if (j !== k) around.push(spec[j]);
      around.sort((a, c) => a - c);
      const med = around[around.length >> 1] + 1e-20;
      const p = 10 * Math.log10((spec[k] + 1e-20) / med);
      if (p > worst) worst = p;
    }
    return worst;
  };
  return { per, toneAt, seconds: n / 16000 };
}

/** 在体检结果里挑窗口：**先要"干净"（音调峰不超标），再要"平稳"**。 */
function pickWindow(an, windowSec, maxToneDb) {
  const w = Math.max(1, Math.floor(windowSec));
  const cands = [];
  for (let i = 0; i + w <= an.per.length; i += 1) {
    let m = 0;
    for (let k = 0; k < w; k += 1) m += an.per[i + k];
    m /= w;
    if (m <= 0) continue;
    let v = 0;
    for (let k = 0; k < w; k += 1) { const d = an.per[i + k] / m - 1; v += d * d; }
    cands.push({ i, v: v / w });
  }
  if (!cands.length) return { start: 0, tone: an.toneAt(0, Math.min(windowSec, 8)), steady: 0, clean: false };
  cands.sort((a, b) => a.v - b.v);
  const limit = maxToneDb == null ? 8 : maxToneDb;
  /** ⚠️ 只在"最平稳的 24 个"里挑干净的那个：不然为了躲哨音会把窗口挑到电平乱跳的地方。 */
  const scored = cands.slice(0, 24).map((c) => ({ ...c, tone: an.toneAt(c.i, Math.min(windowSec, 8)) }));
  const clean = scored.filter((c) => c.tone <= limit);
  const pool = clean.length ? clean : scored;
  pool.sort((a, b) => (clean.length ? a.v - b.v : a.tone - b.tone));
  return { start: pool[0].i, tone: pool[0].tone, steady: pool[0].v, clean: clean.length > 0 };
}

/** 压缩包 → 音频文件列表。 */
async function unpack(file, dir, single) {
  fs.mkdirSync(dir, { recursive: true });
  if (/\.7z$/i.test(file)) await run(SEVENZIP, ['x', '-y', '-o' + dir, file], 'un7z');
  else await run('tar.exe', ['-xf', file, '-C', dir], 'unzip');
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  return walk(dir)
    .filter((f) => /\.(ogg|mp3|wav|flac|m4a|opus)$/i.test(f))
    .filter((f) => !single || new RegExp(single, 'i').test(path.basename(f)));
}

const specFile = process.argv[2];
if (!specFile) { console.log('用法：node dev-weather\\make-loop.mjs <spec.json>'); process.exit(1); }
const spec = JSON.parse(fs.readFileSync(R(specFile), 'utf8'));
const outDir = R(spec.out || 'dev-weather/samples/loops');
fs.mkdirSync(outDir, { recursive: true });
const TARGET = spec.targetDb == null ? -26 : spec.targetDb;
const FADE = spec.fade == null ? 2.5 : spec.fade;
/**
 * ★ **只重做一部分**（`"merge": true` + `"replaceKinds": ["leaf"]`）：
 * 用户已经听过并挑中的那几档（rain-1/snow-2/blossom-1）**不能被重算** ——
 * 重新切一遍窗口，文件就和他听过的那一版不一样了。所以默认模式是"整份重写"，
 * 补素材时才用 merge：保留旧条目，只替换指定档。
 */
const indexPath = path.join(outDir, 'index.json');
let index = [];
if (spec.merge && fs.existsSync(indexPath)) {
  try { index = JSON.parse(fs.readFileSync(indexPath, 'utf8')).items || []; } catch (e) { index = []; }
}
if (spec.replaceKinds) index = index.filter((i) => !spec.replaceKinds.includes(i.kind));
const put = (rec) => {
  const k = index.findIndex((i) => i.id === rec.id);
  if (k >= 0) index[k] = rec; else index.push(rec);
};
const toDb = (x) => 20 * Math.log10(Math.max(1e-9, x));
const fromDb = (x) => 10 ** (x / 20);

for (const it of spec.items) {
  console.log(`\n[${it.id}] ${it.label || ''}`);
  const len = it.len == null ? 20 : it.len;
  const frames = Math.round(len * SR);
  const fadeSec = it.fade == null ? FADE : it.fade;      // 每档可以有自己的淡化时长（短素材配短淡化）
  const fadeN = Math.round(fadeSec * SR);

  // ---- 素材（可为数组；压缩包自动解）----
  let sources = Array.isArray(it.src) ? it.src.slice() : [it.src];
  const un = [];
  for (const s of sources) {
    const abs = R(s);
    if (/\.(zip|7z)$/i.test(abs)) {
      const files = await unpack(abs, path.join(WORK, 'unz-' + it.id + '-' + un.length), it.single);
      if (!files.length) { console.log('  压缩包里没有可用音频'); continue; }
      files.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size);
      un.push(files[0]);
      console.log('  取：' + path.basename(files[0]));
    } else if (fs.existsSync(abs)) un.push(abs);
    else console.log('  ⚠️ 缺文件：' + s);
  }
  if (!un.length) { console.log('  跳过（没有可用素材）'); continue; }
  sources = un;

  // ---- ① 凑出 len+fade 秒的"窗口素材"（多段就是依次拼）----
  const need = frames + fadeN;                        // 需要的总帧数
  const win = new Float32Array(need * 2);
  let filled = 0;
  if (sources.length === 1) {
    const src = sources[0];
    let start = it.start;
    if (start == null || start === 'auto') {
      const an = await analyze(src, it.id);
      if (!an) { console.log('  素材解不出来'); continue; }
      const pick = pickWindow(an, len + fadeSec, it.maxToneDb);
      start = pick.start;
      console.log(`  自动选窗口：第 ${start} 秒起（共 ${an.seconds.toFixed(0)} 秒素材）`
        + ` · 音调峰 ${pick.tone.toFixed(1)}dB ${pick.clean ? '✓ 干净' : '⚠️ 偏哨音（这段素材里找不到更干净的窗口）'}`);
    }
    const dur = await duration(src);
    if (dur && start + len + fadeSec > dur) start = Math.max(0, dur - len - fadeSec - 0.05);
    /** ⚠️ 多解 0.5 秒：`-ss` 精确寻址 + 容器时长不准会让解出来的比要的短一点点，
     *  卡死在"必须正好 len+fade"上会让整条被跳过（rain-2 就这么丢过一次）。 */
    const { data, frames: got, log } = await decode(src, start, len + fadeSec + 0.5, it.id);
    if (!data || !got) { console.log('  解码失败：' + log.split('\n').slice(-2).join(' ')); continue; }
    const take = Math.min(got, need);
    win.set(data.subarray(0, take * 2));
    filled = take;
    if (filled < need) console.log(`  ⚠️ 素材只有 ${(filled / SR).toFixed(2)} 秒（容器的时长报得不准），尾部补静音`);
  } else {
    /**
     * 多段拼接：每段取 `part` 秒（缺省 = 总长平均分），**不够就循环再用一轮**。
     * ⚠️ 干树叶那 20 段每段只有 1.8~2.5 秒，按"每段必须给够"写就会在最后几段凑不满（丢过一次）。
     */
    const partFrames = Math.max(1, Math.floor(need / sources.length));
    let k = 0;
    while (filled < need && k < sources.length * 4) {
      const src = sources[k % sources.length];
      const st = k < sources.length ? ((it.starts && it.starts[k]) || 0) : 0.4;
      const want = Math.min(partFrames, need - filled);
      const { data, frames: got } = await decode(src, st, want / SR + 0.05, it.id + '-' + (k % sources.length));
      if (data) {
        const take = Math.min(got, need - filled);
        win.set(data.subarray(0, take * 2), filled * 2);
        filled += take;
      }
      k += 1;
    }
    console.log(`  拼接 ${sources.length} 段（用了 ${k} 次）→ ${(filled / SR).toFixed(2)} 秒`);
  }
  if (filled < need) { console.log(`  ⚠️ 素材只有 ${(filled / SR).toFixed(2)} 秒，不足 ${len + fadeSec} 秒 → 尾部补静音`); }

  // ---- ② 等功率交叉淡化：尾巴(cos) 淡入开头(sin)，然后接主体 ----
  const out = new Float32Array(frames * 2);
  for (let i = 0; i < fadeN; i += 1) {
    const u = (i + 0.5) / fadeN;
    const gIn = Math.sin((Math.PI / 2) * u);          // 开头：0 → 1
    const gOut = Math.cos((Math.PI / 2) * u);         // 尾巴：1 → 0
    const head = 2 * i, tail = 2 * (frames + i);
    for (let c = 0; c < 2; c += 1) out[head + c] = win[head + c] * gIn + win[tail + c] * gOut;
  }
  for (let i = fadeN; i < frames; i += 1) {
    out[2 * i] = win[2 * i]; out[2 * i + 1] = win[2 * i + 1];
  }

  // ---- ③ 电平 ----
  const rms = rmsOf(out), peak = peakOf(out);
  let gainDb = TARGET - toDb(rms);
  const peakDb = toDb(peak);
  if (peakDb + gainDb > -1.5) gainDb = -1.5 - peakDb;
  const g = fromDb(gainDb);
  for (let i = 0; i < out.length; i += 1) out[i] *= g;
  const seam = seamMetric(out);

  // ---- ④ 写原始 PCM → 编 ogg ----
  const raw = path.join(WORK, it.id + '-out.f32');
  fs.writeFileSync(raw, Buffer.from(out.buffer, 0, out.byteLength));
  const ogg = path.join(outDir, it.id + '.ogg');
  const enc = await run(FF, [
    '-y', '-v', 'error', '-f', 'f32le', '-ar', String(SR), '-ac', '2', '-i', raw,
    '-c:a', 'libvorbis', '-q:a', '5', ogg,
  ], 'enc-' + it.id);
  if (enc.code !== 0) { console.log('  编码失败：' + enc.log.split('\n').slice(-2).join(' ')); continue; }

  const size = fs.statSync(ogg).size;
  console.log(`  → ${path.basename(ogg)}  ${(size / 1024).toFixed(0)}KB · ${len}秒 · 电平 ${gainDb.toFixed(1)}dB`
    + ` → RMS ${toDb(rms * g).toFixed(1)} / 峰值 ${toDb(peak * g).toFixed(1)}`
    + ` · 接缝 跳变 ${seam.wrapJump.toExponential(1)}（内部 99.9% = ${seam.interiorP999.toExponential(1)}，比 ${seam.ratio}）`);
  put({
    id: it.id, label: it.label || it.id, kind: it.kind || it.id.split('-')[0],
    file: it.id + '.ogg', secs: len, license: it.license || '', note: it.note || '',
    source: Array.isArray(it.src) ? it.src.length + ' 段拼接' : path.basename(it.src),
    rms: +toDb(rms * g).toFixed(1), peak: +toDb(peak * g).toFixed(1), gainedDb: +gainDb.toFixed(1),
    seam: seam.ratio, bytes: size,
  });
}
fs.writeFileSync(indexPath, JSON.stringify({ targetDb: TARGET, fade: FADE, items: index }, null, 2));
console.log(`\n共生成 ${index.length} 个循环 → ${path.relative(ROOT, outDir)}`);
console.log('试听页：http://127.0.0.1:8899/loops.html');
