/**
 * 自检总入口（2026-10-11 模块化之后的样子；同日把 `05-live` 那一个巨块又切了 7 刀）。
 *
 *   node test\smoke.cjs                 # 全部区域（与原来自检项数一致）
 *   node test\smoke.cjs --list          # 列出所有区域（名称 / 标签 / 文件）
 *   node test\smoke.cjs 天气             # 只跑名字或标签里带"天气"的区域
 *   node test\smoke.cjs ball game        # 球相关的都跑
 *
 * **为什么拆**：原来这是一个 2655 行的顺序脚本，372 项全跑要 **166 秒**。钱花在两处：
 *   · **等真实墙钟时间**（气泡间隔、静默期、模型往返）—— 集中在"真连一遍"那几节；
 *   · **CPU**（在假画布上真的推 4 段各几十秒的天气粒子动画）—— 单独一节。
 *     ⚠️ **2026-10-11 晚：这一节从 47.5 秒降到 4 秒**（`07b-fx-particles`）。做法是假画布
 *     **按面积分档**：主画布（1280×760 ≈ 97 万像素）只记账、不再逐像素清/混合，
 *     小贴图画布（5~40px）**照样逐像素** —— 所以 `ink ≥ 15%` 那两条值钱断言一字未改。
 *     当时实测：2400 帧光"清主画布"就 5.8 秒，而**没有任何断言读主画布的像素**。
 * 所以"改一处只跑那一区"才是真正的提速手段。实测：纯逻辑区 **0.2~0.5 秒**，
 * `07a-anim`（次级动画/接地光/部位判定）**0.3 秒**，`07b-fx-particles`（粒子）**~4 秒**，
 * `07d-fx-actor`（天气↔她的互动）**~1 秒**。全量 **407 项 / ~123 秒**。
 *
 * 结构：
 *   · `test\lib\harness.cjs` —— 骨架：临时目录、`ok()`、假模型端点、共用小工具、区域超时兜底，
 *     并把区域代码里的裸名字（`fs` / `pet` / `ok` / `base` …）**一次性挂成全局**。
 *   · `test\lib\live.cjs`    —— 「真连一遍」那 7 个区域**共用的一条 WebSocket + 全套 helper**
 *     （`ws` / `fromPet` / `init` / `waitFor` / `nextReply` / `drain` / `touchSay` …）。
 *   · `test\regions\*.cjs`   —— 一个区域一个文件，**可以单独跑**：
 *     `node test\run-one.cjs 02c-mood.cjs`。
 *   · 本文件                  —— 按顺序把区域跑一遍，支持按关键词挑。
 *
 * 顺序有讲究：`05*` 那 7 个区域是**同一条连接上的连续对话**，必须按文件名顺序跑
 * （全量跑时共用一条连接；单跑某一个时它自己连）。`06-beats` 与 `07*` 不依赖连接。
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
