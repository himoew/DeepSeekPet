/**
 * The loopback server the pet page lives on.
 *
 * It does two things: hand out the files under `web\`, and keep a WebSocket at
 * `/socket?role=pet` that the page talks its JSON protocol over. It binds to
 * 127.0.0.1 on a port the OS picks, so nothing is exposed and no port is fixed.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { WebSocketServer } = require('ws');
const log = require('./log.cjs');
const pet = require('./pet.cjs');

const WEB_DIR = path.join(__dirname, 'web');

/** Extensions the page asks for, and the type each one is served as. */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function fail(res, status, why) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(why);
}

function serveFile(res, file) {
  fs.readFile(file, (err, body) => {
    if (err) return fail(res, 404, 'not found');
    res.writeHead(200, {
      'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'content-length': body.length,
      // the pet reloads its own window while developing; never cache the page
      'cache-control': 'no-cache',
    });
    res.end(body);
  });
}

/** 页面直接用的几个入口，映射到 web\ 下的文件。 */
const ROUTES = {
  '/': 'pet.html',
  '/pet': 'pet.html',
  '/settings': 'settings.html',
  // 语音编辑页（桌宠右键「音色…」打开）
  '/voice': 'voice.html',
  // 服装页（桌宠右键「换装…」打开）：现在先把接口占住，贴图以后再加
  '/dress': 'dress.html',
  // 桌宠右键菜单里的人像（web\avatar.png，从大肥鱼缩略图搬来）
  '/api/avatar': 'avatar.png',
};

/** 请求体读成一个字符串（只用于本地那几个小 JSON 接口）。 */
function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve) => {
    let n = 0;
    const chunks = [];
    req.on('data', (c) => {
      n += c.length;
      if (n > limit) { req.destroy(); resolve(''); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(''));
  });
}

/**
 * 试听：合成一句，直接把 WAV 回给页面（`<audio src=...>` 就能放）。
 *
 * **用的是"当前已经生效"的音色与参数**，不是请求里带的新值——因为
 * noiseScale / noiseScaleW / lengthScale 是**模型级**参数，只能在建 OfflineTts 时给，
 * 改它们必须重建引擎（`tts.reload()`，约 2~4 秒）。所以页面的流程是
 * **先保存并生效（`voice:apply`），再来这里试听**，两边绝不会不一致。
 * 这里只多带一个 `fresh` 绕过缓存，保证你听到的就是当前设置的真实结果。
 */
async function handlePreview(req, res) {
  const tts = require('./tts.cjs');
  let body = {};
  try { body = JSON.parse((await readBody(req)) || '{}'); } catch (e) { body = {}; }

  const text = String(body.text || '你好呀，我是大肥鱼。').slice(0, 120);
  if (!tts.available()) return fail(res, 503, `语音不可用：${tts.why()}`);

  try {
    const r = await tts.speak(text, { fresh: true });
    if (!r) return fail(res, 500, '合成失败（看 pet.log）');
    res.writeHead(200, {
      'content-type': 'audio/wav',
      'content-length': r.wav.length,
      'cache-control': 'no-store',
    });
    res.end(r.wav);
  } catch (err) {
    log.warn(`试听失败:${err.message}`);
    fail(res, 500, err.message);
  }
}

async function handle(req, res) {
  const { pathname } = new URL(req.url, 'http://127.0.0.1');
  const route = decodeURIComponent(pathname);

  if (route === '/health') return fail(res, 200, 'ok');
  // 试听是唯一会真的干活（合成）的接口，且只绑在 127.0.0.1 上
  if (route === '/api/voice/preview' && req.method === 'POST') return handlePreview(req, res);

  // 其余页面要的东西都在 /web/ 下面。
  const rel = ROUTES[route] ?? (route.startsWith('/web/') ? route.slice('/web/'.length) : null);
  if (!rel) return fail(res, 404, 'not found');

  const file = path.resolve(WEB_DIR, rel);
  // `web\` 是唯一允许被读的目录，URL 怎么写都不行
  if (!file.startsWith(WEB_DIR + path.sep)) return fail(res, 403, 'forbidden');
  serveFile(res, file);
}

function startServer() {
  const server = http.createServer((req, res) => {
    // `handle` 是 async（试听那条路要 await 合成）：**必须在这里把 Promise 接住**。
    // 原来只有一个同步 try/catch，`await` 之后的抛错会变成 unhandledRejection ——
    // main.cjs 会因此记一行 `FATAL 未处理的 Promise 拒绝`（看着像启动崩了），
    // 而请求那头一直没有响应、干挂着。
    handle(req, res).catch((err) => {
      log.warn(`请求出错 ${req.url}:${err.message}`);
      try { fail(res, 400, 'bad request'); } catch { /* already answered */ }
    });
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname !== '/socket') return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => {
      const role = url.searchParams.get('role') || 'pet';
      if (role === 'pet') pet.attach(ws);
      else ws.close(4003, 'unsupported role');
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    // port 0: the OS hands out a free port, so two pets (or any other app) never collide
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

module.exports = { startServer };
