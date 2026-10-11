/**
 * 跑**一个**自检区域（由 `test\regions.cjs` 派发；也可以自己直接调：`node test\run-one.cjs 02c-mood.cjs`）。
 * 每个区域单独一个进程 —— 互不污染（临时配置目录、全局桩、模块状态都各是各的）。
 */
const path = require('node:path');
const harness = require('./lib/harness.cjs');

const name = process.argv[2];
if (!name) {
  console.error('用法：node test\\run-one.cjs <区域文件名>');
  process.exit(2);
}
const region = require(path.join(__dirname, 'regions', name));

harness.run([region])
  .then((r) => {
    console.log(`${region.name}：${r.passed} 项`);
    process.exit(0);
  })
  .catch((err) => {
    console.error(`\n[${region.name}] ${err && (err.message || err)}`);
    if (process.env.DSP_SMOKE_TRACE) console.error((err && err.stack) || '(no stack)');
    process.exit(1);
  });
