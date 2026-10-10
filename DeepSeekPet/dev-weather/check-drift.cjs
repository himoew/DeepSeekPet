/**
 * 临时量化工具（不进产品）：把 fx.js 的粒子跑 40 秒，看横向到底有没有"单边堆积"。
 * 判据：把窗口宽度分 8 格，看 40 秒后粒子的分布 —— 均匀的话每格差不多，
 * 堆成"龙卷风"的话会有一半格子是 0。
 *
 *   node dev-weather\check-drift.cjs [fx.js 的路径]
 */
const path = require('node:path');
const fs = require('node:fs');
const url = require('node:url');

const file = process.argv[2] || path.join(__dirname, '..', 'resources', 'app', 'web', 'fx.js');
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
    let t = 0;
    for (let f = 0; f < 40 * 60; f += 1) { t += 1 / 60; fx.frame(1 / 60, t, kind, 1); }
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
  const bad = rows.filter((r) => r.emptyBins >= 2);
  console.log(bad.length ? `\n⚠️ ${bad.map((r) => r.kind).join(' / ')} 有明显单边空档（>=2 格没粒子）` : '\n分布均匀（每格都有粒子）');
  void fs;
})();
