/**
 * 从外面"点一下第 3 挡"（自检用，2026-10-30）。
 *
 * 桌宠页面点那个小手机按钮时，实际只发一条消息给主进程：
 *   {t:'control', action:'companionMode', level:2}
 * 所以用一个临时的 WebSocket 客户端就能把**整条真链**跑一遍
 * （页面 → `pet.cjs` 的 `companionMode` → `companion.setMode(2)` → `phone.show()`），
 * 不用真的去点鼠标。
 *
 *   node tools\phone-tier.cjs 2            # 切到第 3 挡（把手机给她）
 *   node tools\phone-tier.cjs 1            # 退回第 2 挡（手机收起来）
 *   node tools\phone-tier.cjs 2 --watch 90 # 顺带把阶段事件盯 90 秒
 *
 * 端口从 `data\pet.log` 最近那行「服务就绪 http://127.0.0.1:<port>/pet」里读。
 */
const fs = require('node:fs');
const path = require('node:path');
const WebSocket = require(path.join(__dirname, '..', 'resources', 'app', 'node_modules', 'ws'));

const argv = process.argv.slice(2);
const level = Number(argv.find((a) => /^[0-2]$/.test(a)) ?? 2);
const watchIdx = argv.indexOf('--watch');
const watchSec = watchIdx >= 0 ? Number(argv[watchIdx + 1]) || 60 : 25;

function serverPort() {
  const file = path.join(__dirname, '..', 'data', 'pet.log');
  const text = fs.readFileSync(file, 'utf8');
  const hits = [...text.matchAll(/服务就绪 http:\/\/127\.0\.0\.1:(\d+)\//g)];
  if (!hits.length) throw new Error('pet.log 里没有「服务就绪」，桌宠起了吗？');
  return Number(hits[hits.length - 1][1]);
}

const port = serverPort();
const ws = new WebSocket(`ws://127.0.0.1:${port}/socket?role=pet`);
const t0 = Date.now();
const el = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

ws.on('open', () => {
  console.log(`${el()} 连上 ${port}，发 level=${level}`);
  ws.send(JSON.stringify({ t: 'control', action: 'companionMode', level }));
});

ws.on('message', (raw) => {
  let m;
  try { m = JSON.parse(raw.toString()); } catch { return; }
  if (m.t === 'phone') {
    const ev = m.ev || {};
    const bits = [ev.kind, ev.stage, ev.elapsed ? `${Math.round(ev.elapsed / 1000)}s` : '', ev.why, ev.app].filter(Boolean);
    console.log(`${el()}  [phone] ${bits.join(' ')}`);
    return;
  }
  if (m.t === 'prefs' && m.companion) {
    const c = m.companion;
    console.log(`${el()}  [prefs] level=${level} enabled=${c.enabled} respond=${c.respond} phone=${JSON.stringify(c.phone && { on: c.phone.on, up: c.phone.up, stage: c.phone.stage, app: c.phone.app })}`);
    return;
  }
  if (m.t === 'say') {
    const beats = Array.isArray(m.beats) ? m.beats.map((b) => b && b.text).filter(Boolean) : [];
    console.log(`${el()}  [say] ${(beats.join(' / ') || m.text || '').slice(0, 120)}`);
    return;
  }
});

ws.on('error', (err) => console.error('ws 出错：', err.message));

setTimeout(() => {
  ws.close();
  console.log(`${el()} 断开`);
  process.exit(0);
}, watchSec * 1000).unref?.();
