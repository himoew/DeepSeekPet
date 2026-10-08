/**
 * 端到端验收（并行版）：模拟桌宠页面连上去问一句，量**文字气泡多快出现**、
 * 语音随后多久到，并确认音频是真的。
 *
 *   node tools\live-voice-check.cjs <端口>
 *
 * 顺序变了：以前是"voice → say"，现在是"**say → voice**"（气泡先出，语音后台合成）。
 */
const path = require('node:path');
const APP = process.env.DSP_APP || 'D:\\pet\\DeepSeekPet\\resources\\app';
const { WebSocket } = require(path.join(APP, 'node_modules', 'ws'));

const port = process.argv[2];
if (!port) { console.error('用法: node tools\\live-voice-check.cjs <端口>'); process.exit(2); }

const got = [];
const t0 = Date.now();
const mark = () => Date.now() - t0;

const ws = new WebSocket(`ws://127.0.0.1:${port}/socket?role=pet&host=window`);
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  got.push({ t: m.t, m, at: mark() });
  const brief = m.t === 'voice'
    ? `voice{rate=${m.rate} wav=${m.wav ? (m.wav.length / 1024).toFixed(0) + 'KB' : '无'}}`
    : m.t === 'say'
      ? `say{kind=${m.kind} voice=${m.voice} "${(m.beats || []).map((b) => b.text).join(' / ')}"}`
      : m.t;
  console.log(`  +${String(mark()).padStart(6)}ms  ${brief}`);
});

const waitFor = (what, pick, ms) => new Promise((resolve, reject) => {
  const deadline = Date.now() + ms;
  const tick = () => {
    const hit = pick();
    if (hit) return resolve(hit);
    if (Date.now() > deadline) return reject(new Error(`超时等不到 ${what}`));
    setTimeout(tick, 30);
  };
  tick();
});

(async () => {
  await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
  console.log(`已连上 127.0.0.1:${port}`);
  const init = await waitFor('init', () => got.find((g) => g.t === 'init'), 10000);
  console.log(`init: voice=${init.m.voice}`);
  await new Promise((r) => setTimeout(r, 2500));

  got.length = 0;
  const sentAt = Date.now();
  console.log('\n发一句 {t:"text", text:"你好呀"} …');
  ws.send(JSON.stringify({ t: 'text', text: '你好呀' }));

  const say = await waitFor('带 voice 标记的气泡', () => got.find((g) => g.t === 'say' && g.m.voice), 60000);
  const bubbleMs = Date.now() - sentAt;

  let audioMs = null;
  let audio = null;
  try {
    audio = await waitFor('语音', () => got.find((g) => g.t === 'voice' && g.m.wav), 60000);
    audioMs = Date.now() - sentAt;
  } catch (e) { /* 没等到就下面报 FAIL */ }

  console.log('\n================ 验收 ================');
  let bad = 0;
  const check = (name, cond, extra = '') => { console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!cond) bad += 1; };

  check('气泡出现了', !!say, `"${(say.m.beats || []).map((b) => b.text).join(' / ')}"`);
  check('气泡标了"要念"', say.m.voice === true);
  check('语音到了', !!audio);
  if (audio) {
    const buf = Buffer.from(audio.m.wav, 'base64');
    const rate = buf.readUInt32LE(24);
    check('是合法 WAV', buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE',
      `${(buf.length / 1024).toFixed(0)}KB · ${rate}Hz · ${((buf.length - 44) / 2 / rate).toFixed(2)}s`);
  }
  console.log(`\n  ★ 文字气泡出现：+${bubbleMs}ms`);
  console.log(`  ★ 语音到达：    ${audioMs !== null ? '+' + audioMs + 'ms' : '没等到'}`);
  console.log(`  （并行改造前，气泡要等到语音合成完才出，也就是 +${audioMs ?? '?'}ms 才会有字）`);

  ws.close();
  process.exit(bad ? 1 : 0);
})().catch((err) => { console.error(`\n失败: ${err.message}`); try { ws.close(); } catch (e) {} process.exit(1); });
