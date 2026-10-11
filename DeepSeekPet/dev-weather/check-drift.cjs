/**
 * 临时量化工具（不进产品）：把 fx.js 的粒子跑 40 秒，看横向到底有没有"单边堆积"。
 * 判据：把窗口宽度分 8 格，看 40 秒后粒子的分布 —— 均匀的话每格差不多，
 * 堆成"龙卷风"的话会有一半格子是 0。
 *
 *   node dev-weather\check-drift.cjs [fx.js 的路径] [walk]
 *
 * ★ 加了 `walk` 之后**顺便回归"她走动带起来的风"**（2026-10-11 晚的第 ③ 项 ③a）：
 * 这时候每帧都喂一份"她正以 250px/s 左右走"的快照，于是粒子会吃到那条 `herWind`。
 * 要验的是它**没把 1.35 节那个"单边堆积"搞回来**（那条风进的是同一条 `vx` 积分，
 * 而 `dx` 有界 + 回中 —— 这里是量出来的证据，不是"我觉得有界"）。
 * 不传 `walk` = 老行为（没有她），输出与以前一字不差。
 */
const path = require('node:path');
const fs = require('node:fs');
const url = require('node:url');

const file = process.argv[2] && !process.argv[2].startsWith('-') && process.argv[2] !== 'walk'
  ? process.argv[2]
  : path.join(__dirname, '..', 'resources', 'app', 'web', 'fx.js');
const WALK = process.argv.includes('walk');
const W = 1280, H = 760, BINS = 8;

// fx.js 是 ESM；这里用一个极简的假 DOM（fx 不用 DOM 也能算物理，只要别给它 canvas）
const fakeCanvas = () => ({ width: 1, height: 1, style: {}, getContext: () => null, getBoundingClientRect: () => ({ width: 1, height: 1 }) });
globalThis.window = globalThis;
globalThis.document = { createElement: fakeCanvas, createElementNS: fakeCanvas, querySelector: () => null, addEventListener() {}, documentElement: {} };
globalThis.Path2D = class { constructor(d) { this.d = d; } };

(async () => {
  const mod = await import(url.pathToFileURL(file).href);
  const fx = mod.createFx({ ctl: { bounds: { W, H } } });
  const kinds = ['snow', 'leaf', 'blossom', 'rain'];
  const rows = [];
  for (const kind of kinds) {
    fx.clear();
    fx.actor(null);
    let t = 0;
    /** 她在窗口里来回走（250px/s）—— 每帧喂一份快照，粒子才会吃到"走动带风"那一条。 */
    let ax = W * .45, dir = 1;
    for (let f = 0; f < 40 * 60; f += 1) {
      t += 1 / 60;
      if (WALK) {
        ax += dir * 250 / 60;
        if (ax > W - 80) { ax = W - 80; dir = -1; }
        else if (ax < 80) { ax = 80; dir = 1; }
        fx.actor({ AX: ax, AY: H - 2, ax: 128, ay: 256, kx: .42, ky: .42, rot: 0, S: .42, moving: true });
      }
      fx.frame(1 / 60, t, kind, 1);
    }
    const xs = fx.stats().list.map((d) => d.x);
    const bins = new Array(BINS).fill(0);
    for (const x of xs) { const i = Math.max(0, Math.min(BINS - 1, Math.floor(x / W * BINS))); bins[i] += 1; }
    const empty = bins.filter((n) => n === 0).length;
    rows.push({ kind, n: fx.count, bins, emptyBins: empty, minX: xs.length ? Math.round(Math.min(...xs)) : null, maxX: xs.length ? Math.round(Math.max(...xs)) : null });
  }
  for (const r of rows) {
    console.log(`${r.kind.padEnd(8)} 共 ${String(r.n).padStart(3)} 颗 · 空档 ${r.emptyBins}/${BINS} · x 范围 ${r.minX}~${r.maxX}`);
    console.log('         分布 ' + r.bins.map((n) => String(n).padStart(3)).join(' | '));
  }
  console.log(WALK ? '（这一轮她一直在走 → 粒子吃到了"走动带风"）' : '（这一轮没有她）');
  const bad = rows.filter((r) => r.emptyBins >= 2);
  console.log(bad.length ? `\n⚠️ ${bad.map((r) => r.kind).join(' / ')} 有明显单边空档（>=2 格没粒子）` : '\n分布均匀（每格都有粒子）');
  void fs;
})();
