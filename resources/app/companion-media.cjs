/**
 * 陪伴模式的图片管道（2026-10-26）。
 *
 * 只做三件事：
 *   1. 把 OneBot 消息里的图片（`url` / 本地 `file`）**下载/读进来**；
 *   2. 按内容哈希存到 `data/companion/media/`，同图只存一份，超出容量按最旧淘汰；
 *   3. 给大脑一个 `<img>` / 多模态请求能直接用的 `data:image/...;base64,...`。
 *
 * 为什么不用本机视觉模型：2026-10-26 用真实 Key 验过，现在的 `deepseek-chat`
 * （实际是 `deepseek-flash`）**直接收 `image_url` 就能看图**，桌面这台机器不需要跑 VLM。
 *
 * 安全（这张网的入口是 QQ 消息，不能当可信输入）：
 *   · 只下载 `http(s)`，拒绝 localhost / 内网 / 链路本地地址（防 SSRF）；
 *   · 单张 6MB、一次最多 3 张、总计 15MB；
 *   · 用文件头判断真实类型，不认 `content-type` 说啥就是啥；
 *   · 缓存目录 64MB / 300 张封顶，超了删最旧的。
 */
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const log = require('./log.cjs');

const MAX_IMAGES = 3;
const MAX_BYTES = 6 * 1024 * 1024;
const MAX_TOTAL_BYTES = 15 * 1024 * 1024;
const TIMEOUT_MS = 15000;
const CACHE_BYTES = 64 * 1024 * 1024;
const CACHE_FILES = 300;

const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/bmp': 'bmp' };

/** 文件头 → mime。只认这四种（QQ 里几乎只会出现这些）。 */
function sniffMime(buf) {
  if (!buf || buf.length < 12) return '';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.slice(0, 6).toString('latin1') === 'GIF87a' || buf.slice(0, 6).toString('latin1') === 'GIF89a') return 'image/gif';
  if (buf.length >= 12 && buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (buf.slice(0, 2).toString('latin1') === 'BM') return 'image/bmp';
  return '';
}

/**
 * 这个主机是不是"本机/内网"。域名不解析（QQ 的图都在公网 CDN 上），
 * 只挡字面量 IP 和 localhost —— 足够挡掉 `http://127.0.0.1:6099/...` 这类 SSRF。
 */
function isPrivateHost(host) {
  const h = String(host || '').replace(/^\[|\]$/g, '').toLowerCase();
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true;
  const family = net.isIP(h);
  if (family === 4) {
    const p = h.split('.').map(Number);
    if (p[0] === 0 || p[0] === 10 || p[0] === 127) return true;
    if (p[0] === 169 && p[1] === 254) return true;
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    if (p[0] === 192 && p[1] === 168) return true;
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true;
    return false;
  }
  if (family === 6) {
    if (h === '::1' || h === '::') return true;
    if (/^f[cd]/.test(h) || /^fe[89ab]/.test(h)) return true;
    return false;
  }
  return false; // 普通域名：公网 CDN，放行
}

/**
 * ★ 2026-11-01：**把 OneBot 给的图片地址洗一遍再下**。
 *
 * 真机踩到过的：`data\pet.log` 里连着两条
 * `陪伴：这张图跳过（下载图片失败 HTTP 400）`（2026-11-01 09:29 / 09:31），
 * 而同一台机器上 01:09 之前一直在正常收图 —— 说明不是"图太大/不是图片"，
 * 是**那个地址本身被 CDN 拒了**。NapCat 有的版本是从 QQ 的 XML 里取 `url` 的，
 * 里面的 `&` 会保持成 `&amp;`：`new URL()` 照样能解析（参数名变成 `amp;appid`），
 * 于是请求发出去、参数全错、回来正好是 **400**。所以这里统一还原一次。
 */
function cleanUrl(raw) {
  return String(raw || '').trim().replace(/&amp;|&#38;|&#x26;/gi, '&');
}

/**
 * 打日志用的"地址形状"：**主机 + 路径 + 参数名**，不带参数值。
 *
 * 为什么不直接打 URL：`multimedia.nt.qq.com.cn/download?...&rkey=...` 里的 `rkey`
 * 是一次性的下载凭据，写进 `pet.log` 就等于把凭据留在盘上。参数**名**足够定位问题
 * （`amp;appid` 这种一眼就能看出是转义没还原），值一个都不留。
 */
function describeUrl(u) {
  try {
    const names = [...u.searchParams.keys()];
    return `${u.host}${u.pathname}${names.length ? `?${names.join(',')}` : ''}`;
  } catch {
    return '(地址看不懂)';
  }
}

/**
 * 下载一张图；超过 `maxBytes` 就边下边丢，不把内存吃满。
 */
async function fetchImage(url, {
  maxBytes = MAX_BYTES,
  timeoutMs = TIMEOUT_MS,
  fetchImpl = fetch,
  // 自检要在 127.0.0.1 上起假图床；生产默认不允许（`DSP_MEDIA_ALLOW_PRIVATE=1` 只给测试用）
  allowPrivate = process.env.DSP_MEDIA_ALLOW_PRIVATE === '1',
} = {}) {
  let u;
  const rawUrl = String(url || '').trim();
  const fixedUrl = cleanUrl(rawUrl);
  // 转义没还原是"能解析但参数全错"的那种 400，光看地址形状看不出来（cleanUrl 已经洗过了），
  // 所以单独留一行：下次再撞 400 时，日志里有没有这句就直接把原因分开了。
  if (fixedUrl !== rawUrl) log.warn('陪伴：图片地址里带 &amp;（NapCat 转义没还原），已还原再请求');
  try { u = new URL(fixedUrl); } catch { throw new Error('图片地址不是合法 URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`不支持的图片协议 ${u.protocol}`);
  if (!allowPrivate && isPrivateHost(u.hostname)) throw new Error('拒绝内网图片地址');

  const res = await fetchImpl(u, {
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) BlueFishDeskpet' },
  });
  if (!res.ok) throw new Error(`下载图片失败 HTTP ${res.status}（${describeUrl(u)}）`);
  const len = Number(res.headers.get('content-length') || 0);
  if (len > maxBytes) throw new Error(`图片太大（${(len / 1048576).toFixed(1)}MB）`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > maxBytes) throw new Error(`图片太大（${(buf.length / 1048576).toFixed(1)}MB）`);
  const mime = sniffMime(buf);
  if (!mime) throw new Error('不是能识别的图片（PNG/JPEG/GIF/WebP/BMP）');
  return { buf, mime };
}

/** 读 NapCat 的本地缓存图（只在 `file` 是绝对路径时用）。 */
function readLocalImage(file, { maxBytes = MAX_BYTES } = {}) {
  const p = String(file || '');
  if (!p || !path.isAbsolute(p)) throw new Error('本地图片不是绝对路径');
  const st = fs.statSync(p);
  if (!st.isFile()) throw new Error('本地图片不是文件');
  if (st.size > maxBytes) throw new Error(`图片太大（${(st.size / 1048576).toFixed(1)}MB）`);
  const buf = fs.readFileSync(p);
  const mime = sniffMime(buf);
  if (!mime) throw new Error('不是能识别的图片');
  return { buf, mime };
}

/** 按内容哈希落盘；同一个 hash 只写一次。 */
function saveImage(dir, buf, mime) {
  const hash = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16);
  const ext = EXT[mime] || 'img';
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${hash}.${ext}`);
  if (!fs.existsSync(file)) fs.writeFileSync(file, buf);
  return { file, hash, mime, bytes: buf.length };
}

/**
 * 大图先缩到最长边 1400、转 JPEG（只在 Electron 主进程里做；纯 Node 自检直接原样返回）。
 * 为什么：手机原图动辄 4000px/4MB，base64 之后请求体更大，模型也会自己缩一遍 ——
 * 不如我们本地先缩，省带宽也省图片 token。**GIF 会被压成首帧**，这是有意的。
 *
 * ★ 2026-10-30：加了 `maxSide` / `force`。手机截图 720 宽、只有 100~700KB，
 * 按老规则"不够大就原样"会一路发 720 宽的 PNG（图 token 贵一倍）；分享前用
 * `{ maxSide: 480, force: true }` 强制缩一次。
 */
function shrinkImage(buf, mime, { maxSide = 1400, force = false } = {}) {
  try {
    const { nativeImage } = require('electron');
    const img = nativeImage.createFromBuffer(buf);
    if (!img || img.isEmpty()) return { buf, mime };
    const { width, height } = img.getSize();
    if (!force && Math.max(width, height) <= maxSide && buf.length <= 2 * 1024 * 1024) return { buf, mime };
    const scale = Math.min(1, maxSide / Math.max(width, height));
    const small = img.resize({
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale)),
      quality: 'good',
    });
    const jpg = small.toJPEG(82);
    return jpg && jpg.length ? { buf: jpg, mime: 'image/jpeg' } : { buf, mime };
  } catch {
    return { buf, mime }; // 不是 Electron / 解不开：原图照发
  }
}

/** 缓存封顶：最旧的先删。 */
function evictCache(dir, { maxBytes = CACHE_BYTES, maxFiles = CACHE_FILES } = {}) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return; }
  const items = [];
  for (const name of names) {
    try {
      const p = path.join(dir, name);
      const st = fs.statSync(p);
      if (st.isFile()) items.push({ p, size: st.size, at: st.mtimeMs });
    } catch { /* 正在被删/读：跳过 */ }
  }
  items.sort((a, b) => a.at - b.at);
  let total = items.reduce((n, x) => n + x.size, 0);
  let count = items.length;
  for (const x of items) {
    if (total <= maxBytes && count <= maxFiles) break;
    try { fs.unlinkSync(x.p); total -= x.size; count -= 1; } catch { /* 删不掉就留着 */ }
  }
}

/**
 * 一次把消息里的图都处理掉。**单张失败不拖累这一轮**：跳过的图记一行日志，
 * 文字照常回。返回的每一项都带 `dataUrl`，大脑直接塞进 `image_url`。
 *
 * ★ 2026-11-01：**取图顺序改了：先问网关，再试地址**。
 *
 * 真机根因（2026-11-01 10:08 复现，**不是猜的**）：QQ 给的下载地址是
 * `https://gchat.qpic.cn/download?appid=…&fileid=…&rkey=…&spec=0`，而我们拿着它去下，
 * 返回的是
 * ```
 * HTTP 400 {"retcode":-5503007,"retmsg":"download url has expired","retryflag":0}
 * ```
 * ——**地址过期**，换 UA / 加 Referer / 不带 UA 全都一样（四种头都试过，见 CHANGES 那一笔）。
 * 而 OneBot 的 `get_image`（参数只要那个 `file` 名）每次都拿得到：NapCat 会用自己的
 * 有效凭据把图取到本机，回一个**绝对路径**（实测 1.3MB 真图，`FF D8 FF E0`）。
 * 所以现在的顺序是 **① 网关（本地、不联网、不会过期）→ ② 地址 → ③ 本地 file**，
 * 三个都记在 `tries` 里，全失败时一行日志说清三条路各自为什么不行。
 *
 * 另外：返回的数组上挂 `dropped`（有几张没拿到）—— 调用方拿它去告诉她
 * "图没收到，别描述"，否则她会照着 `[图片]` 占位符编内容。
 */
async function resolveImages(dir, images, opts = {}) {
  const {
    maxImages = MAX_IMAGES, maxBytes = MAX_BYTES, maxTotalBytes = MAX_TOTAL_BYTES,
    timeoutMs = TIMEOUT_MS, fetchImpl = fetch, allowPrivate, viaGateway = null,
  } = opts;
  const list = (Array.isArray(images) ? images : []).slice(0, maxImages);
  const out = [];
  let total = 0;
  for (const img of list) {
    const tries = [];
    try {
      let got = null;
      /** ① 网关：本机 NapCat 有图（或有凭据），不联网、不会撞"地址过期"。 */
      if (viaGateway) {
        try {
          got = await viaGateway(img);
          if (!got) tries.push('网关：这条拿不到');
        } catch (err) {
          tries.push(`网关：${err.message}`);
        }
      }
      /** ② 原始地址（有些网关不实现 `get_image`，地址也可能恰好还新鲜）。 */
      if (!got && img && img.url) {
        try {
          got = await fetchImage(img.url, { maxBytes, timeoutMs, fetchImpl, ...(allowPrivate === undefined ? {} : { allowPrivate }) });
        } catch (err) {
          tries.push(`地址：${err.message}`);
        }
      }
      /** ③ 本地 file（只有绝对路径才读得到；相对名要靠网关那条）。 */
      if (!got && img && img.file) {
        try {
          got = readLocalImage(img.file, { maxBytes });
        } catch (err) {
          tries.push(`本地：${err.message}`);
        }
      }
      if (!got) throw new Error(tries.join('；') || '这张图没有地址也没有本地文件');
      const small = shrinkImage(got.buf, got.mime);
      if (total + small.buf.length > maxTotalBytes) throw new Error('这一轮的图片总量超了');
      const saved = saveImage(dir, small.buf, small.mime);
      total += small.buf.length;
      out.push({ ...saved, dataUrl: `data:${small.mime};base64,${small.buf.toString('base64')}` });
    } catch (err) {
      log.warn(`陪伴：这张图跳过（${err.message}）`);
    }
  }
  if (out.length) evictCache(dir);
  /** 有几张**没拿到**（调用方要靠它决定"要不要告诉她没看见"）。 */
  out.dropped = list.length - out.length;
  return out;
}

module.exports = {
  MAX_IMAGES, MAX_BYTES, MAX_TOTAL_BYTES, CACHE_BYTES, CACHE_FILES,
  sniffMime, isPrivateHost, cleanUrl, describeUrl, fetchImage, readLocalImage, saveImage,
  evictCache, resolveImages, shrinkImage,
};
