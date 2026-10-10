// 从 dev-weather\sound.html 里抽出 <script type="module"> 的内容做语法检查（临时工具）。
const fs = require('node:fs');
const path = require('node:path');
const p = path.join(__dirname, 'sound.html');
const s = fs.readFileSync(p, 'utf8');
const open = '<script type="module">';
const i = s.indexOf(open);
if (i < 0) { console.error('没找到 module script'); process.exit(2); }
const start = i + open.length;
const end = s.indexOf('</script>', start);
const js = s.slice(start, end);
const out = path.join(__dirname, 'sound-check.mjs');
fs.writeFileSync(out, js, 'utf8');
console.log(JSON.stringify({ jsLines: js.split('\n').length, wrote: out }));
