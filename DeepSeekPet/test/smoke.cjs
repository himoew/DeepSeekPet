/**
 * 自检总入口（2026-10-11 模块化之后的样子）。
 *
 *   node test\smoke.cjs                 # 全部区域（与原来自检项数一致）
 *   node test\smoke.cjs --list          # 列出所有区域（名称 / 标签 / 文件）
 *   node test\smoke.cjs 天气             # 只跑名字或标签里带"天气"的区域（几秒）
 *   node test\smoke.cjs ball game        # 球相关的都跑
 *
 * **为什么拆**：原来这是一个 2700 行的顺序脚本，372 项全跑要 **166 秒**，而实测慢的原因
 * 不是"检查多"，是**6 个区域各自在等真实的墙钟时间**（气泡间隔、静默期、模型往返）。
 * 所以"改一处只跑那一区"才是真正的提速手段 —— 天气粒子 / 玩具球物理 / 头球计分 / 图标 /
 * 设置 / 次级动画这些区本来就是 0.1 秒级。
 *
 * 结构：
 *   · `test\lib\harness.cjs` —— 骨架：临时目录、`ok()`、假模型端点、共用小工具，
 *     并把区域代码里的裸名字（`fs` / `pet` / `ok` / `base` …）**一次性挂成全局**。
 *   · `test\regions\*.cjs`   —— 一个区域一个文件，**可以单独跑**：
 *     `node test\run-one.cjs 02c-mood.cjs`。
 *   · 本文件                  —— 按顺序把区域跑一遍，支持按关键词挑。
 *
 * ⚠️ **少数区域故意没切出来**（2g-3 弹弹乐的 `try {` 与 2g-2 的 `finally` 跨了区域边界），
 * 它们仍然留在 `test\smoke.full.cjs`（拆分前的原文，作为对照留档）。
 */
const path = require('node:path');
const harness = require('./lib/harness.cjs');

const REGION_DIR = path.join(__dirname, 'regions');
const regions = harness.listRegions(REGION_DIR);

const argv = process.argv.slice(2);
if (argv.includes('--list') || argv.includes('-l')) {
  console.log(`区域清单（${regions.length} 个）—— 跑法：node test\\smoke.cjs <关键词>；单个区域：node test\\run-one.cjs <文件>`);
  for (const r of regions) {
    console.log(`  ${(r.tags || []).join(',').padEnd(20)} ${String(r.name).padEnd(26)} ${r.file}`);
  }
  process.exit(0);
}

const words = argv.filter((a) => !a.startsWith('-'));
const pick = harness.selector(words);
if (pick && !regions.some(pick)) {
  console.error(`没有匹配的区域：${words.join(' ')}（用 --list 看清单）`);
  process.exit(2);
}

const t0 = Date.now();
harness.run(regions, { pick, note: pick ? `只跑了 ${regions.filter(pick).length}/${regions.length} 个区域` : '' })
  .then((r) => {
    console.log(`（${((Date.now() - t0) / 1000).toFixed(1)}s）`);
    process.exit(0);
  })
  .catch((err) => {
    console.error(`\n${err && (err.message || err)}`);
    if (process.env.DSP_SMOKE_TRACE) console.error((err && err.stack) || '(no stack)');
    process.exit(1);
  });
