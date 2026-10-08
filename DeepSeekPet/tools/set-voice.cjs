/**
 * 换音色：把 `vendor\tts\voices\.active` 指向某一套音色。
 *
 *   node tools\set-voice.cjs              # 列出有哪些音色、当前是哪套
 *   node tools\set-voice.cjs theresa      # 换成 theresa
 *
 * 换完**要重启桌宠**（音色是在 `tts.cjs` 加载时定下来的，重启才生效）。
 * 如果改的是可运行副本（D:\pet\...），别用工作区这份脚本去改——
 * 改完 workspace 再 deploy 会被覆盖回工作区的选择，直接改目标那份的 .active 即可。
 */
const fs = require('node:fs');
const path = require('node:path');

const APP = path.join(__dirname, '..', 'resources', 'app');
const ROOT = path.join(APP, 'vendor', 'tts', 'voices');
const activeFile = path.join(ROOT, '.active');
const voices = require(path.join(APP, 'tts-voice.cjs'));

const all = voices.list(ROOT);
if (!all.length) {
  console.error(`没有音色目录：${ROOT}`);
  console.error('（语音包要放到 vendor\\tts\\voices\\<名字>\\，见 HANDOVER 第 1.7 节）');
  process.exit(1);
}

const current = fs.existsSync(activeFile) ? fs.readFileSync(activeFile, 'utf8').trim() : '';
const want = process.argv[2];

if (!want) {
  console.log(`音色目录：${ROOT}\n`);
  for (const v of all) {
    const spec = voices.read(v.dir, v.folder);
    const ok = spec.gaps.length ? `缺 ${spec.gaps.join('、')}` : '可用';
    const mark = v.folder === current ? ' ← 当前' : '';
    const note = spec.note ? `  ${spec.note}` : '';
    console.log(`  ${v.folder.padEnd(16)} [${ok}] sid=${spec.sid} speed=${spec.speed}${note}${mark}`);
  }
  console.log(`\n用法：node tools\\set-voice.cjs <名字>   （换完要重启桌宠）`);
  process.exit(0);
}

const hit = all.find((v) => v.folder === want);
if (!hit) { console.error(`没有这个音色：${want}`); process.exit(1); }
const spec = voices.read(hit.dir, hit.folder);
if (spec.gaps.length) {
  console.error(`音色「${want}」还不能用，缺：${spec.gaps.join('、')}`);
  process.exit(1);
}

fs.writeFileSync(activeFile, want, 'utf8');
console.log(`已把 .active 改成「${want}」（${spec.name}${spec.note ? ' · ' + spec.note : ''}）`);
console.log('重启桌宠后生效。');
