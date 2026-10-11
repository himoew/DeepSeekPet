/**
 * ============================================================================
 * 把"你选定的一组循环"装进桌宠（一条命令，临时工具）
 * ============================================================================
 *
 * 用法（`雨=rain-2 雪=snow-1 落叶=leaf-3 樱花=blossom-2`，只写你选的档也行）：
 *     node dev-weather\apply-choice.mjs 雨=rain-2 落叶=leaf-1 樱花=blossom-2 雪=snow-1
 *
 * 它干三件事（**只写 `resources/app/web/audio/`，不动别的**）：
 *   ① 从 `dev-weather/samples/loops/<id>.ogg` 拷成 `resources/app/web/audio/<kind>.ogg`；
 *   ② 写 `resources/app/web/audio/index.json`（`{ items: [{kind,file,gainDb,label,license}] }`），
 *      这就是 `ambience-loops.js` 读的清单；
 *   ③ 打印还差哪一步才能出声（那两个开关**故意不自动改**，要你点头）。
 *
 * ⚠️ 换档之后**必须**重启桌宠（音频只在启动时读一次清单）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const LOOP_DIR = path.join(HERE, 'samples', 'loops');
const OUT_DIR = path.join(ROOT, 'resources', 'app', 'web', 'audio');
const ALIAS = { 雨: 'rain', 雪: 'snow', 落叶: 'leaf', 樱花: 'blossom', rain: 'rain', snow: 'snow', leaf: 'leaf', blossom: 'blossom' };

const index = JSON.parse(fs.readFileSync(path.join(LOOP_DIR, 'index.json'), 'utf8'));
const byId = new Map(index.items.map((i) => [i.id, i]));

const argv = process.argv.slice(2);
if (!argv.length) {
  console.log('用法：node dev-weather\\apply-choice.mjs 雨=rain-2 雪=snow-1 落叶=leaf-1 樱花=blossom-2');
  console.log('\n可选：');
  for (const kind of ['rain', 'snow', 'leaf', 'blossom']) {
    const list = index.items.filter((i) => i.kind === kind);
    console.log('  ' + kind.padEnd(8) + list.map((i) => i.id + '（' + i.label + '）').join('  |  '));
  }
  process.exit(1);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const items = [];
for (const arg of argv) {
  const [k, id] = arg.split('=');
  const kind = ALIAS[k];
  if (!kind || !id) { console.log('看不懂这条：' + arg); continue; }
  const it = byId.get(id);
  if (!it) { console.log('没有这个循环：' + id); continue; }
  const from = path.join(LOOP_DIR, it.file);
  const to = path.join(OUT_DIR, kind + '.ogg');
  fs.copyFileSync(from, to);
  items.push({ kind, file: kind + '.ogg', gainDb: 0, label: it.label, license: it.license, sourceId: it.id, secs: it.secs, rms: it.rms, peak: it.peak, seam: it.seam });
  console.log(`  ${kind.padEnd(8)} ← ${it.id}  ${(fs.statSync(to).size / 1024).toFixed(0)}KB  「${it.label}」`);
}
if (!items.length) { console.log('一条都没装上。'); process.exit(1); }
fs.writeFileSync(path.join(OUT_DIR, 'index.json'), JSON.stringify({ note: '真实录音循环（OpenGameArt，出处与授权见每条）', items }, null, 2));
console.log(`\n已写 ${path.relative(ROOT, path.join(OUT_DIR, 'index.json'))}（${items.length} 档）`);
console.log('\n还差两步才出声（故意留给你点头）：');
console.log('  ① pet-app.js：import 从 ambience.js 换成 ambience-loops.js，并把 WEATHER_AUDIO_ON 改成 true');
console.log('  ② node tools/deploy.ps1（部署到 D:\\pet\\DeepSeekPet），然后重启桌宠');
