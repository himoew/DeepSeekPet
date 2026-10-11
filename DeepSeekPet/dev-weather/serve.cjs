/**
 * 天气验收页的本地小服务（临时工具，不进桌宠安装包）。
 *
 * 为什么需要它：`index.html` 用 `<script type="module">` 里 `import './fx.js'`，
 * 某些浏览器（或某些安全策略下）**不允许 file:// 下做模块导入**。起了这个服务就一定能跑。
 *
 * 用法（在这个目录的上一级，也就是 DeepSeekPet 目录里）：
 *     node dev-weather\serve.cjs
 * 然后打开它打印的地址。**它只读文件，不写任何东西。**
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const here = __dirname;                       // …\DeepSeekPet\dev-weather
const web = path.join(here, '..', 'resources', 'app', 'web');   // 产品里的 web 目录（读 fx.js）
const PORT = Number(process.env.PORT) || 8899;
const TYPES = { '.js': 'text/javascript; charset=utf-8', '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.json': 'application/json; charset=utf-8', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.flac': 'audio/flac', '.mp3': 'audio/mpeg' };

/**
 * 路由（只有三条，别再加花样）：
 *   ① `/resources/app/web/<文件>` —— 页面 `<base href>` 解析出来的**产品模块真实路径**（fx.js 走这条）；
 *   ② `<文件>`                    —— 本目录（index.html / serve.cjs…）；
 *   ③ **`/pet` → 产品里的 `pet.html`**（2026-10-11 晚加）—— `v-pet.html` 要把**真正的桌宠页面**
 *      装进 iframe 才验得准（DOM 顺序 / CSS 层级 / 尺寸链都在产品页里）。真桌宠那边这条路由
 *      由 `resources\app\server.cjs` 提供（`'/pet': 'pet.html'`），这里补一条一样的，
 *      **免得为了验收再起一个服务**（用户明确不要第二个服务器）。
 *   ④ 只看 pathname，**忽略 query**（`?v=1` 这种缓存穿透参数不能让它 404 —— 这里踩过一次：
 *      页面一直在等模块，最后表现为"整页脚本一声不响地没执行"）。
 */
const ROUTES = {
  pet: 'resources/app/web/pet.html',        // 跟 app\server.cjs 的 '/pet' 对齐
};
/**
 * ★ **唯一一条写入**（2026-10-11 深夜加）：`POST /save?name=xx.wav` → 写到本目录的 `wav\`。
 * 给 `sound.html` 的「存成 wav」用：这样海选那 10 段可以落成文件，用别的播放器听/发给别人。
 * 只允许 `.wav`、只写 `wav\` 这一层，不接受路径分隔符 —— 免得这条路变成任意写。
 */
const WAV_DIR = path.join(here, 'wav');
function saveWav(req, res) {
  const name = (new URL(req.url, 'http://x').searchParams.get('name') || '').replace(/[^A-Za-z0-9._-]/g, '');
  if (!/^[A-Za-z0-9._-]+\.wav$/.test(name)) { res.writeHead(400).end('bad name'); return; }
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    fs.mkdirSync(WAV_DIR, { recursive: true });
    fs.writeFileSync(path.join(WAV_DIR, name), Buffer.concat(chunks));
    console.log('  存了 ' + name + '（' + Buffer.concat(chunks).length + ' 字节）');
    res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
  });
}
const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url.startsWith('/save')) { saveWav(req, res); return; }
  let raw = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '') || 'index.html';
  /**
   * ⚠️ 产品页里的引用是**绝对路径** `/web/pet.css`、`/web/pet-app.js`（真桌宠那边由
   * `app\server.cjs` 提供 `/web/*`）。验收页在 iframe 里装真 `pet.html`，这两条必须也能解析，
   * 否则页面拿到了、样式和脚本全 404 —— 表现是"装进去了但什么都没有"。
   */
  if (raw.startsWith('web/')) raw = 'resources/app/' + raw;
  const rel = ROUTES[raw] || raw;
  const fromWeb = rel.startsWith('resources/app/web/');
  const file = fromWeb ? path.join(web, rel.slice('resources/app/web/'.length)) : path.join(here, rel);
  if (!file.startsWith(here) && !file.startsWith(web)) { res.writeHead(403).end('no'); return; }
  fs.readFile(file, (e, buf) => {
    if (e) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('404 ' + rel); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(buf);
  });
});
server.listen(PORT, '127.0.0.1', () => {
  console.log(`天气验收页：http://127.0.0.1:${PORT}/`);
  console.log(`  · 音效验收：http://127.0.0.1:${PORT}/sound.html`);
  console.log(`  · 桌宠页面自检：http://127.0.0.1:${PORT}/v-pet.html`);
  console.log(`  · 天气↔她的互动：http://127.0.0.1:${PORT}/v-actor.html`);
  console.log(`  · 读的是产品里的：${path.join(web, 'fx.js')}`);
  console.log('  · Ctrl+C 退出；它不改任何文件。');
});
