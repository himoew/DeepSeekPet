/**
 * 陪伴模式的表情包（2026-10-26）。
 *
 * 两个来源，最后合成一张**目录**给模型挑：
 *   1. **本地文件夹** `data/companion/stickers/`：用户把图丢进去，文件名就是关键词
 *      （`晚安.png`、`委屈.gif`）。最稳，不依赖 QQ。
 *   2. **小号 QQ 的收藏表情**：`fetch_custom_face_detail` 拿到 `url / desc / resId`，
 *      下载到 `stickers/qq/` 并写一份 `qq-index.json`。这就是"QQ 里的表情"。
 *
 * 挑图方式：模型在回复里单独写一行 `[表情:晚安]`；`plan()` 把这行删掉、返回要发的图。
 * 关键词先精确匹配 → 再包含匹配 → 都没有就随机一张（不会因为关键词没对上就哑火）。
 *
 * 不做的事：
 *   · 不用 QQ 的"搜索表情 + 截图"——NapCat 小号无头（没有 QQ 主窗口），也没有搜索 API；
 *   · 不把表情图写进记忆 / 上下文；模型只看到关键词列表。
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const media = require('./companion-media.cjs');
const log = require('./log.cjs');

const IMAGE_RE = /\.(png|jpe?g|gif|webp|bmp)$/i;
const QQ_INDEX = 'qq-index.json';
const MFACE_INDEX = 'mface-index.json';
const COLLECTED_DIR = 'collected';
const MAX_CATALOG = 300;

/** 文件名（去掉扩展名）就是关键词。 */
function tagOf(file) {
  return path.basename(String(file || ''), path.extname(String(file || ''))).trim();
}

/** 建目录 + 放一份说明；第一次运行时用户知道该把图丢哪儿。 */
function ensureDirs(localDir) {
  fs.mkdirSync(localDir, { recursive: true });
  fs.mkdirSync(path.join(localDir, COLLECTED_DIR), { recursive: true });
  const readme = path.join(localDir, 'README.txt');
  if (!fs.existsSync(readme)) {
    fs.writeFileSync(readme, [
      '把表情包图片放到这个文件夹里（png / jpg / gif / webp 都行）。',
      '文件名就是关键词：晚安.png、委屈.gif、开心.jpg ……',
      '她在 QQ 上想发的时候会自己挑一张；关键词对不上就随机发一张。',
      '子文件夹 collected/ 是她自己收藏的（你发的图、她收到的表情），不用手改。',
      '子文件夹 qq/ 是小号 QQ 的收藏表情，会由桌宠自动同步，不用手改。',
      '',
    ].join('\n'), 'utf8');
  }
}

function listImagesIn(dir, source, stripHash = false) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names
    .filter((f) => IMAGE_RE.test(f) && !f.startsWith('.'))
    .map((f) => {
      let tag = tagOf(f);
      // collected/ 的文件名是 `<关键词>-<hash6>.<ext>`；把哈希尾巴摘掉才是关键词
      if (stripHash) tag = tag.replace(/-[0-9a-f]{6}$/i, '') || tagOf(f);
      return { kind: 'image', file: path.join(dir, f), tag, source };
    });
}

function listLocal(dir) {
  return listImagesIn(dir, 'local');
}

/** 她自己收藏的图（`stickers/collected/`）：入站图片里挑出来存下的。 */
function listCollected(dir) {
  return listImagesIn(path.join(dir, COLLECTED_DIR), 'collected', true);
}

function readQqIndex(qqDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(qqDir, QQ_INDEX), 'utf8').replace(/^\uFEFF/, ''));
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((x) => x && x.file && fs.existsSync(x.file))
      .map((x) => ({ kind: 'image', file: x.file, tag: String(x.tag || tagOf(x.file)), source: 'qq', desc: x.desc || '' }));
  } catch {
    return [];
  }
}

/** 她收藏的 QQ 商城表情（mface）：只有三件套，没有图片文件。 */
function readMfaceIndex(dir) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, MFACE_INDEX), 'utf8').replace(/^\uFEFF/, ''));
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((x) => x && x.face && x.face.emojiId && x.face.key)
      .map((x) => ({ kind: 'mface', tag: String(x.tag || '表情'), face: x.face, source: 'mface', desc: x.desc || '' }));
  } catch {
    return [];
  }
}

/** 本地 + 她自己收藏的 + QQ 收藏 + mface，合成一张目录（最多 300 张，够模型挑）。 */
function catalog(localDir, qqDir = '') {
  const all = [
    ...listLocal(localDir),
    ...listCollected(localDir),
    ...(qqDir ? readQqIndex(qqDir) : []),
    ...readMfaceIndex(localDir),
  ];
  return all.slice(0, MAX_CATALOG);
}

/** 文件名里不能带路径分隔符 / 控制字符；中文和表情符号都保留。 */
function safeTag(tag) {
  const s = String(tag || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 24);
  return s || '表情';
}

/**
 * 把一张入站图收进 `stickers/collected/`。
 * 文件名 = 关键词 + 哈希前 6 位，重名不会覆盖。
 */
function collectImage(dir, srcFile, tag = '') {
  const buf = fs.readFileSync(srcFile);
  const mime = media.sniffMime(buf);
  if (!mime) throw new Error('不是能识别的图片');
  const safe = safeTag(tag);
  const hash = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 6);
  const ext = (mime.split('/')[1] || 'png').replace('jpeg', 'jpg');
  const outDir = path.join(dir, COLLECTED_DIR);
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `${safe}-${hash}.${ext}`);
  if (!fs.existsSync(file)) fs.writeFileSync(file, buf);
  media.evictCache(outDir, { maxBytes: 48 * 1024 * 1024, maxFiles: 200 });
  return { kind: 'image', file, tag: safe, source: 'collected' };
}

/** 把一条入站 mface 收进 `mface-index.json`（同一个表情只存一份，tag 可更新）。 */
function collectMface(dir, face, tag = '') {
  if (!face || !face.emojiId || !face.key) throw new Error('mface 缺 emoji_id/key');
  const safe = safeTag(tag || face.summary || '表情');
  const file = path.join(dir, MFACE_INDEX);
  let list = [];
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    if (Array.isArray(raw)) list = raw;
  } catch { /* 第一次收藏 */ }
  const id = `${face.emojiPackageId || 0}|${face.emojiId}|${face.key}`;
  const hit = list.find((x) => x && x.id === id);
  if (hit) {
    hit.tag = safe;
    hit.at = Date.now();
  } else {
    list.push({ id, tag: safe, face, at: Date.now() });
  }
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(list, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
  return { kind: 'mface', tag: safe, face, source: 'mface' };
}

/** 从回复里摘出 `[表情:关键词]`；返回清干净的文字和关键词列表。 */
function extract(text) {
  const queries = [];
  const cleaned = String(text || '')
    .replace(/\[表情[:：]\s*([^\]\n]{1,24})\]/g, (_m, q) => {
      const s = String(q || '').trim();
      if (s) queries.push(s);
      return '';
    })
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text: cleaned, queries };
}

let lastPick = '';
const identityOf = (x) => (x && (x.file || `${x.face?.emojiPackageId || 0}|${x.face?.emojiId || ''}`)) || '';
/** 精确 → 包含 → 随机；连续两次尽量不挑同一张。 */
function pick(list, query = '') {
  const all = Array.isArray(list) ? list : [];
  if (!all.length) return null;
  const q = String(query || '').toLowerCase().trim();
  let hits = q ? all.filter((x) => String(x.tag).toLowerCase() === q) : [];
  if (!hits.length && q) hits = all.filter((x) => String(x.tag).toLowerCase().includes(q) || q.includes(String(x.tag).toLowerCase()));
  if (!hits.length) hits = all;
  const pool = hits.length > 1 && lastPick ? hits.filter((x) => identityOf(x) !== lastPick) : hits;
  const chosen = pool[Math.floor(Math.random() * pool.length)] || hits[0];
  lastPick = identityOf(chosen);
  return chosen;
}

/** 一条回复 → { text, picks }：文字留下，表情行删掉，关键词换成图。 */
function plan(text, list, { max = 1 } = {}) {
  const { text: cleaned, queries } = extract(text);
  const picks = [];
  const seen = new Set();
  for (const q of queries) {
    if (picks.length >= max) break;
    const item = pick(list, q);
    if (item && !seen.has(identityOf(item))) { seen.add(identityOf(item)); picks.push(item); }
  }
  return { text: cleaned, picks, queries };
}

/** 从回复里摘出 `[收藏:关键词]`（她想把刚收到的图/表情留住时写）。 */
function parseCollect(text) {
  const tags = [];
  const cleaned = String(text || '')
    .replace(/\[收藏[:：]\s*([^\]\n]{1,24})\]/g, (_m, q) => {
      const s = String(q || '').trim();
      if (s) tags.push(s);
      return '';
    })
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text: cleaned, tags };
}

/** 发图用的 `base64://`（NapCat 的 enableLocalFile2Url:false 也认这个）。 */
function toBase64Protocol(file) {
  return 'base64://' + fs.readFileSync(file).toString('base64');
}

/** 收藏表情里哪一列最像"关键词"。 */
function tagOfQq(item, i) {
  const t = String(item?.desc || item?.modifyWord || item?.ocrWord || '').trim();
  return (t || `表情${i + 1}`).slice(0, 24);
}

/**
 * 拉小号 QQ 的收藏表情：`fetch_custom_face_detail` → 下载 url（或读本地 emoPath）→ 哈希落盘。
 * 只写 `stickers/qq/` 和 `qq-index.json`；用户本地那张目录不受影响。
 */
async function refreshQq({ client, qqDir, allowPrivate = false } = {}) {
  if (!client) throw new Error('OneBot 还没连上');
  const r = await client.call('fetch_custom_face_detail', { count: 200 }, 20000);
  if (!r || !r.ok) throw new Error(r?.error || 'fetch_custom_face_detail 失败');
  const list = Array.isArray(r.data) ? r.data : (Array.isArray(r.data?.emojiInfoList) ? r.data.emojiInfoList : []);
  fs.mkdirSync(qqDir, { recursive: true });
  const out = [];
  for (let i = 0; i < list.length; i += 1) {
    const item = list[i] || {};
    try {
      let got;
      if (item.url) {
        got = await media.fetchImage(item.url, { allowPrivate });
      } else if (item.emoPath || item.thumbPath) {
        got = media.readLocalImage(item.emoPath || item.thumbPath);
      } else {
        continue;
      }
      const small = media.shrinkImage(got.buf, got.mime);
      const saved = media.saveImage(qqDir, small.buf, small.mime);
      out.push({ kind: 'image', file: saved.file, tag: tagOfQq(item, i), source: 'qq', desc: String(item.desc || ''), resId: String(item.resId || '') });
    } catch (err) {
      log.warn(`表情：QQ 收藏第 ${i + 1} 张跳过（${err.message}）`);
    }
  }
  // 去重（同一张图可能收藏了两次），保留先出现的 tag
  const seen = new Set();
  const uniq = [];
  for (const x of out) {
    if (seen.has(x.file)) continue;
    seen.add(x.file);
    uniq.push(x);
  }
  try {
    fs.writeFileSync(path.join(qqDir, QQ_INDEX), `${JSON.stringify(uniq, null, 2)}\n`, 'utf8');
  } catch (err) {
    log.warn(`表情：qq-index.json 写入失败（${err.message}）`);
  }
  media.evictCache(qqDir, { maxBytes: 32 * 1024 * 1024, maxFiles: 200 });
  return uniq;
}

/** 把本地表情上传到小号收藏（可选，一次会话做一次就够了）。 */
async function uploadToQq({ client, files } = {}) {
  if (!client) throw new Error('OneBot 还没连上');
  const out = [];
  for (const file of (Array.isArray(files) ? files : [])) {
    try {
      const r = await client.call('add_custom_face', { file, is_origin: true }, 20000);
      out.push({ file, ok: !!(r && r.ok), error: r && !r.ok ? r.error : '' });
    } catch (err) {
      out.push({ file, ok: false, error: err.message });
    }
  }
  return out;
}

module.exports = {
  IMAGE_RE, QQ_INDEX, MFACE_INDEX, COLLECTED_DIR,
  tagOf, safeTag, ensureDirs, listLocal, listCollected, readQqIndex, readMfaceIndex,
  catalog, extract, pick, plan, parseCollect,
  toBase64Protocol, refreshQq, uploadToQq, collectImage, collectMface,
};
