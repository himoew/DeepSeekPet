/**
 * 她的「网」（P2，2026-11-06）
 *
 * 为什么要有这一层：手机上那个浏览器（MuMu 里的 Via / Edge）**拿不到 DOM** ——
 * Via 是 WebView 套壳、调试开关是关的；Edge 是 arm64 包，在 x86_64 模拟器上一启动就崩。
 * 所以"搜图 → 挑一张 → 存进收藏夹"这件事，靠**手机屏幕上的像素**是做不成的。
 *
 * 这一层在 PC 侧用 `fetch` 把同一页拿回来（`cn.bing.com` 实测 794ms / 260KB），
 * 于是：标题、原图 URL、下载 —— 全是确定的，**0 张截图**。
 * 她要做的事没变：**看这一页、挑一张**；代码只负责"精确地取回来"和"如实地报"。
 *
 * 三个能力（都能单独跑，见 `tools\_probe-web.cjs`）：
 *   searchImages(词)    → [{i,title,murl,thumb}]（Bing 图片结果）
 *   saveImage(url, dir) → 存到本地（她的收藏夹 `stickers/collected/`）
 *   readPage(url)       → 标题 + 正文（给"这页讲了什么"用，P3 再接）
 *
 * ⚠️ 拿不到就**如实失败**（`ok:false` + `error`），不编"有一堆图"。
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/**
 * 用移动端 UA：同一页在手机上长什么样，我们拿到的就是什么样。
 *
 * ★ 2026-11-08：**UA 的 patch 号不是可有可无的**。
 * 原来写的是 `Chrome/120.0 Mobile`（少了 `.0.0`），必应会给一份**降级的结果页**：
 * 实测搜「小肥鱼表情包」返回的是「小（汉语汉字）_百度百科」「动作游戏 - 免费在线玩」，
 * 而换成标准手机 UA（`Chrome/120.0.0.0 Mobile`）同一时刻拿到的是正确的 8 条。
 * 这件事很隐蔽：HTTP 200、条目数也对，只有"结果内容不对"，靠日志看不出来。
 */
const UA = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';
/** 一张图最多 12MB（防一个误报的超大文件把收藏夹撑爆）。 */
const MAX_BYTES = 12 * 1024 * 1024;

function decodeEntities(s) {
  return String(s || '')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

/**
 * 从 Bing 图片结果页里抠出候选。
 *
 * 真机实测（2026-11-06，`cn.bing.com/images/search?q=小肥鱼`）：
 * 结果是 `<a class="iusc" m="{&quot;murl&quot;:&quot;http...&quot;,&quot;t&quot;:&quot;标题&quot;}">`，
 * `m` 是 HTML 转义过的 JSON —— 原图地址和标题都在里面，不用看图。
 * 兜底：如果结构又改了，就只抠 `murl`（宁可没标题，也别没图）。
 */
function parseBingImages(html, n = 8) {
  const src = String(html || '');
  const out = [];
  const re = /class="iusc"[^>]*?\sm="([^"]+)"/g;
  let m;
  while ((m = re.exec(src)) && out.length < n) {
    let meta = null;
    try { meta = JSON.parse(decodeEntities(m[1])); } catch { continue; }
    if (!meta || !meta.murl) continue;
    if (out.some((x) => x.murl === meta.murl)) continue;
    out.push({
      title: String(meta.t || '').replace(/\s+/g, ' ').trim().slice(0, 60),
      murl: String(meta.murl),
      thumb: String(meta.turl || ''),
    });
  }
  if (out.length) return out.map((x, i) => ({ i: i + 1, ...x }));

  const seen = new Set();
  const re2 = /murl&quot;:&quot;(https?:\/\/[^&]+)&quot;/g;
  while ((m = re2.exec(src)) && out.length < n) {
    const u = decodeEntities(m[1]);
    if (seen.has(u)) continue;
    seen.add(u);
    out.push({ i: out.length + 1, title: '', murl: u, thumb: '' });
  }
  return out;
}

async function fetchText(url, { timeoutMs = 9000, fetchImpl } = {}) {
  const f = fetchImpl || globalThis.fetch;
  if (typeof f !== 'function') return { ok: false, error: '这个环境没有 fetch' };
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
  try {
    const r = await f(url, {
      headers: { 'user-agent': UA, 'accept-language': 'zh-CN,zh;q=0.9' },
      signal: ctl ? ctl.signal : undefined,
    });
    if (!r || !r.ok) return { ok: false, error: `HTTP ${r ? r.status : '?'}` };
    const text = await r.text();
    return { ok: true, text, url: (r.url || url) };
  } catch (err) {
    return { ok: false, error: (err && err.name === 'AbortError') ? '超时' : String((err && err.message) || err) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 搜图：拿回候选（标题 + 原图地址）。拿不到就是 `ok:false`，不装。 */
async function searchImages(q, { n = 8, timeoutMs = 9000, fetchImpl } = {}) {
  const word = String(q || '').trim();
  if (!word) return { ok: false, items: [], error: '没给词' };
  const url = `https://cn.bing.com/images/search?q=${encodeURIComponent(word)}`;
  const r = await fetchText(url, { timeoutMs, fetchImpl });
  if (!r.ok) return { ok: false, items: [], error: r.error, url };
  const items = parseBingImages(r.text, n);
  if (!items.length) return { ok: false, items: [], error: '页面里没找到图（可能改版或被拦）', url };
  return { ok: true, items, url };
}

/**
 * ★ 2026-11-08：**网页搜索结果**（标题 + 真实网址 + 摘要）—— 她在手机上"看到"的那一页。
 *
 * 为什么要在 PC 侧再解析一遍：手机上那个浏览器拿不到 DOM，无障碍树里的结果是
 * **截断的标题碎片 + 一行域名**，靠它既说"不出有几条、都是哪些网站"（他问过
 * 「去哪里找网址」），也点不准（`open N` 只能猜坐标）。
 * 而必应结果页是**服务端渲染**的（实测：不执行 JS，`li.b_algo` 就在响应正文里），
 * 于是在 PC 上按移动 UA 抓同一页，就能拿到**确定的网址**：
 *   · 她"读这一页"时说的是真标题和真域名；
 *   · `open N` 可以直接 `openurl 那条网址`，不用点屏幕坐标（实测 4 次抓取都没有 ck/a 跳转）。
 *
 * ⚠️ 抓不到就返回 `ok:false`（外层照常用屏幕上的那一屏，不假装知道）。
 */
const ENT = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ',
  middot: '·', hellip: '…', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', mdash: '—', ndash: '–',
};
function deent(s) {
  return String(s || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => {
      try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ''; }
    })
    .replace(/&#(\d+);/g, (_, d) => {
      try { return String.fromCodePoint(Number(d)); } catch { return ''; }
    })
    .replace(/&([a-z]+);/gi, (m, k) => (Object.prototype.hasOwnProperty.call(ENT, k.toLowerCase()) ? ENT[k.toLowerCase()] : m));
}

/**
 * 去标签、压实空白。
 *
 * ★ 2026-11-08：**`<strong>` 不能变成空格**。必应会在标题正中插高亮标签
 * （`DeepSeek娘<strong>表情包</strong> · 2781张`），按"标签→空格"处理会读成
 * `DeepSeek娘 表情包`，跟手机上那一行就不再是同一串字（`sameResult()` 要拿它核对）。
 * 只把换行类标签当空格，其余直接去掉。
 */
function htmlText(s) {
  return deent(
    String(s || '')
      .replace(/<\s*br\s*\/?>/gi, ' ')
      .replace(/<[^>]*>/g, ''),
  ).replace(/\s+/g, ' ').trim();
}

/**
 * 必应有时把结果链接包成 `https://cn.bing.com/ck/a?...&u=a1<base64url>`（跳转壳）。
 * 解不出就原样返回 —— 宁可打不开，也不要打开一个 bing.com 的中间页。
 */
function unwrapCk(u, base = 'https://cn.bing.com') {
  let url = deent(u);
  if (url.startsWith('/')) url = base + url;
  if (!/\/ck\/a/.test(url)) return url;
  const m = /[?&]u=a1([^&#]+)/.exec(url);
  if (!m) return url;
  let b = decodeURIComponent(m[1]).replace(/-/g, '+').replace(/_/g, '/');
  while (b.length % 4) b += '=';
  try {
    const buf = Buffer.from(b, 'base64');
    return decodeURIComponent(buf.toString('utf8'));
  } catch { return url; }
}

/**
 * 从必应**网页**结果页里抠出前 N 条。
 *
 * ★ 2026-11-08：**两种版式都要认**（实测同一天同一台机器就拿到了两种）。
 *
 *   · 手机版（`cn.bing.com` + 标准手机 UA，实测 `小肥鱼表情包` 8/8 条都对吧）：
 *     `<li class="b_algo"><div class="b_tpcn"><a class="tilk" href="真实URL">…
 *        <div class="tptt">aigengtu.com</div><cite>…</cite></a></div>
 *        <div class="b_algoheader"><a href="真实URL" h="ID=SERP,…"><h2>标题</h2></a></div>
 *        <div class="b_caption"><p>摘要</p></div></li>`
 *   · 桌面版：`<h2><a href="真实URL">标题</a></h2>`
 *
 * ⚠️ 坑（都是实测撞到的）：
 *   ① 取标题必须锁在 `h2` 里 —— 前面还有一个 `a.tilk` 站点图标链接；
 *   ② `h="ID=SERP,…"` 是埋点，不是跳转；真正的地址在 `href`；
 *   ③ `b_algo b_nav` 是"相关栏目"标题，**不是一条结果**；
 *   ④ 块里可能先塞 `<style>/<link>/<!-- -->`，不剥会把 CSS 当正文；
 *   ⑤ **UA 会决定给你哪一版**：`Chrome/120.0 Mobile`（少了 patch 号）拿到的是
 *      降级结果（搜"小肥鱼表情包"返回"小（汉字）/动作游戏"），换成
 *      `Chrome/120.0.0.0 Mobile` 才是正常结果 —— 见上面 `UA`。
 */
function parseBingResults(html, n = 8) {
  const src = String(html || '');
  if (!src) return [];
  const out = [];
  const seen = new Set();
  const chunks = src.split(/<li class="b_algo(?=[\s"'])/).slice(1);
  for (const raw of chunks) {
    /** `b_algo b_nav` 是栏目头，不是结果。 */
    if (/^\s*[^>]{0,60}\bb_nav\b/.test(raw.slice(0, 90))) continue;
    const block = raw
      .split(/<li class="b_(?:ans|algo)(?=[\s"'])/)[0]
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<link[^>]*>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '');
    let href = '';
    let title = '';
    /** ① 手机版：标题在外层 `<a>` 里，`<h2>` 被它包着。 */
    const head = /<div class="b_algoheader">\s*<a\b[^>]*\bhref="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    if (head) {
      href = head[1];
      const h2 = /<h2\b[^>]*>([\s\S]*?)<\/h2>/i.exec(head[2]);
      title = htmlText(h2 ? h2[1] : head[2]);
    }
    /** ② 桌面版：`<h2>` 里包着 `<a>`。 */
    if (!href) {
      const h2 = /<h2\b[^>]*>([\s\S]*?)<\/h2>/i.exec(block);
      if (h2) {
        const a = /<a\b[^>]*\bhref="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(h2[1]);
        if (a) { href = a[1]; title = htmlText(a[2]); } else { title = htmlText(h2[1]); }
      }
    }
    /** ③ 兜底：站点图标链接（`a.tilk`）也指向同一个网址。 */
    if (!href) {
      const tilk = /<a\b[^>]*class="tilk"[^>]*\bhref="([^"]+)"[^>]*>/i.exec(block);
      if (tilk) href = tilk[1];
    }
    if (!href) continue;
    const url = unwrapCk(href);
    if (!/^https?:\/\//i.test(url)) continue;
    if (/^https?:\/\/(?:www\.)?bing\.com\//i.test(url)) continue;
    if (!title) continue;
    const key = url.split('#')[0];
    if (seen.has(key)) continue;
    seen.add(key);
    const sn = /class="b_caption[^"]*"[\s\S]*?<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(block);
    const st = /class="tptt"[^>]*>([\s\S]*?)<\/div>/i.exec(block);
    out.push({
      i: out.length + 1,
      title: title.slice(0, 80),
      url,
      snippet: sn ? htmlText(sn[1]).slice(0, 200) : '',
      site: st ? htmlText(st[1]).slice(0, 40) : '',
    });
    if (out.length >= n) break;
  }
  return out;
}

/** 搜网页：拿回前 N 条结果（标题 + 真实网址）。抓不到就是 `ok:false`。 */
async function searchResults(q, { n = 8, timeoutMs = 9000, fetchImpl } = {}) {
  const word = String(q || '').trim();
  if (!word) return { ok: false, items: [], error: '没给词' };
  const url = `https://cn.bing.com/search?q=${encodeURIComponent(word)}`;
  const r = await fetchText(url, { timeoutMs, fetchImpl });
  if (!r.ok) return { ok: false, items: [], error: r.error, url };
  const items = parseBingResults(r.text, n);
  if (!items.length) return { ok: false, items: [], error: '页面里没找到结果条目（可能改版或被拦）', url };
  return { ok: true, items, url };
}

/** 存图：把挑中的那张落进她的收藏夹。 */async function saveImage(url, { dir, name = '', timeoutMs = 20000, maxBytes = MAX_BYTES, fetchImpl } = {}) {
  const u = String(url || '').trim();
  if (!/^https?:\/\//i.test(u)) return { ok: false, error: '地址不对' };
  if (!dir) return { ok: false, error: '没给存哪儿' };
  const f = fetchImpl || globalThis.fetch;
  if (typeof f !== 'function') return { ok: false, error: '这个环境没有 fetch' };
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
  try {
    const r = await f(u, { headers: { 'user-agent': UA, referer: 'https://cn.bing.com/' }, signal: ctl ? ctl.signal : undefined });
    if (!r || !r.ok) return { ok: false, error: `HTTP ${r ? r.status : '?'}` };
    const len = Number(r.headers && r.headers.get ? r.headers.get('content-length') : 0) || 0;
    if (len > maxBytes) return { ok: false, error: `太大了（${Math.round(len / 1024 / 1024)}MB）` };
    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length) return { ok: false, error: '拿到的是空文件' };
    if (buf.length > maxBytes) return { ok: false, error: '太大了' };
    const ext = /\.png(\?|$)/i.test(u) ? 'png' : /\.gif(\?|$)/i.test(u) ? 'gif' : /\.webp(\?|$)/i.test(u) ? 'webp' : 'jpg';
    const safe = String(name || '图').replace(/[\\/:*?"<>|\s]+/g, '').slice(0, 16) || '图';
    const tag = crypto.createHash('sha1').update(u).digest('hex').slice(0, 6);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${safe}-${tag}.${ext}`);
    fs.writeFileSync(file, buf);
    return { ok: true, file, bytes: buf.length, ext };
  } catch (err) {
    return { ok: false, error: (err && err.name === 'AbortError') ? '超时' : String((err && err.message) || err) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 读一页（P3 会用它给"这一页讲了什么"）。只做最朴素的正经事：去掉脚本/样式，留正文。 */
async function readPage(url, { timeoutMs = 12000, maxChars = 1200, fetchImpl } = {}) {
  const r = await fetchText(url, { timeoutMs, fetchImpl });
  if (!r.ok) return { ok: false, error: r.error };
  const html = r.text;
  const title = (() => {
    const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
    return m ? decodeEntities(m[1]).replace(/\s+/g, ' ').trim().slice(0, 80) : '';
  })();
  const text = decodeEntities(html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim())
    .slice(0, maxChars);
  return { ok: true, title, text, url: r.url };
}

module.exports = {
  parseBingImages, searchImages, saveImage, readPage, decodeEntities, UA,
  parseBingResults, searchResults, unwrapCk, htmlText,
};
