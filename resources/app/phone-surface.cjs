/**
 * 她手机上的「面」（P1，2026-11-06）
 *
 * 解决的问题：`phone-adb.buildTable()` 给的是"这一屏有哪 40 个能点的东西"，
 * 没有角色、没有分区、没有"这是列表项"的概念，也没有跨快照稳定的定位。
 * 于是模型只能靠 `n7` 这种临时编号猜，点空了再说"没反应"。
 *
 * 这一层只做**纯函数**（不碰 adb、不碰模型，自检 0.2 秒）：
 *
 *   roleOf(node)      这个东西是什么（button / input / switch / tab / image / text / scroll）
 *   regionOf(node)    它在屏幕的哪一块（status / appbar / content / tabbar）
 *   locOf(node)       跨快照稳定的定位串（`pkg#role#文字@y`）—— 比 `ref` 靠谱
 *   rows(nodes)       把同一行的几个碎片拼成一条（标题 · 作者 · 3:35）
 *   tree(obs)         给她看的紧凑树（按区域分组）
 *   digest(obs)       给她"读"的一段话（标题 / 列表 / 按钮），字符串
 *   find(nodes, 词)   在这一屏里找词，返回节点（找不到就是 null，不猜）
 *   pick(nodes, 说法)  "第3个" / "带猫的" / "最上面那个"
 *
 * ⚠️ 只写**能从控件树里真的读出来**的东西。读不到就说读不到（`thin`），不要编。
 */

'use strict';

/** 屏幕分区（按高度比例；`screen` 拿不到时一律 content）。 */
const REGION_EDGE = { status: 0.05, appbar: 0.14, tabbar: 0.86 };

/**
 * 角色。判据全部来自 uiautomator 的属性 + 类名后缀，**不猜语义**。
 * 顺序有讲究：先判可输入/开关，再判容器，最后才是"可点即按钮"。
 */
function roleOf(n) {
  const cls = String((n && n.class) || '');
  if (!n) return 'text';
  if (n.editable) return 'input';
  if (/EditText|AutoCompleteTextView/.test(cls)) return 'input';
  if (/Switch|ToggleButton/.test(cls)) return 'switch';
  if (/CheckBox|RadioButton/.test(cls)) return 'checkbox';
  if (/RecyclerView|ListView|GridView|ScrollView|ViewPager|HorizontalScrollView/.test(cls)) return 'scroll';
  if (/Image|Icon|Photo|Thumb/.test(cls) && !n.clickable) return 'image';
  if (/TabLayout|TabWidget/.test(cls)) return 'tab';
  if (n.clickable) return 'button';
  if (n.scrollable) return 'scroll';
  return 'text';
}

/** 这一屏的哪一块。 */
function regionOf(n, screen) {
  const h = Number(screen && screen.height) || 0;
  const b = (n && n.bounds) || [0, 0, 0, 0];
  if (!h) return 'content';
  if (b[3] <= h * REGION_EDGE.status) return 'status';
  if (b[3] <= h * REGION_EDGE.appbar) return 'appbar';
  if (b[1] >= h * REGION_EDGE.tabbar) return 'tabbar';
  return 'content';
}

/** 文字（优先 text，其次 content-desc）。 */
function labelOf(n) {
  return String((n && (n.text || n.desc)) || '').replace(/\s+/g, ' ').trim();
}

/**
 * 跨快照稳定的定位串。
 *
 * 为什么不用 `ref`：`ref` 每次快照重编号（`n0` 上一屏是"返回"，这一屏是"搜索"）。
 * 为什么不用纯 hash：出问题时人看不出来它是谁。
 * 所以做成**可读 + 稳定**：`包名#角色#文字@y带`（y 取 8px 一带，抗抖动）。
 */
function locOf(n) {
  const pkg = String((n && n.pkg) || '').replace(/^.*\./, '');
  const role = roleOf(n);
  const text = labelOf(n).slice(0, 20).replace(/[|#@]/g, ' ');
  const b = (n && n.bounds) || [0, 0, 0, 0];
  const band = Math.round(((b[1] + b[3]) / 2) / 8);
  return `${pkg}#${role}#${text}@${band}`;
}

/** 给节点补上 role / region / loc（不改原对象）。 */
function enrich(nodes, screen) {
  const out = [];
  const dup = new Map();
  for (const n of nodes || []) {
    const role = roleOf(n);
    const base = `${role}|${labelOf(n).slice(0, 20)}|${(n.bounds || [0, 0, 0, 0]).join(',')}`;
    const k = (dup.get(base) || 0) + 1;
    dup.set(base, k);
    out.push({
      ref: n.ref,
      role,
      region: regionOf(n, screen),
      loc: `${locOf(n)}#${k}`,
      text: labelOf(n),
      /**
       * ★ 2026-11-12：**`desc` 要留着**。
       *
       * 旧版 `text = labelOf(n)`（= `text || desc`）之后 desc 就丢了 ——
       * "有字也有 content-desc"的节点（Launcher 图标、卡片、播放按钮）只能按 `text` 查，
       * 按 `content-desc` 描述的那个词永远命中不了。`find()` 分档时两个字段都要能查。
       */
      desc: String((n && n.desc) || '').replace(/\s+/g, ' ').trim(),
      clickable: !!n.clickable,
      editable: !!n.editable,
      checked: !!n.checked,
      checkable: !!n.checkable,
      bounds: n.bounds,
      center: n.center,
    });
  }
  return out;
}

/**
 * 把同一行的碎片拼成一条。
 *
 * B 站卡片在控件树里是"标题 / 作者 / 3:35"三个独立节点，模型按 ref 点很容易点偏；
 * 拼成一行之后，她看到的就是一条完整的信息。
 * 只拼**都不太可点**的纯文字（可点的保持独立，免得把两个按钮并成一个）。
 */
function rows(nodes) {
  const list = (nodes || []).filter((n) => n && n.bounds && labelOf(n));
  const taken = new Set();
  const out = [];
  for (let i = 0; i < list.length; i++) {
    if (taken.has(i)) continue;
    const a = list[i];
    const [ax1, ay1, ax2, ay2] = a.bounds;
    const band = [a];
    for (let j = i + 1; j < list.length; j++) {
      if (taken.has(j)) continue;
      const b = list[j];
      if (a.clickable || b.clickable) continue;
      const [bx1, by1, bx2, by2] = b.bounds;
      const overlap = Math.max(0, Math.min(ay2, by2) - Math.max(ay1, by1));
      const h = Math.min(ay2 - ay1, by2 - by1) || 1;
      if (overlap / h < 0.6) continue;
      band.push(b);
      taken.add(j);
    }
    band.sort((p, q) => (p.bounds[0] - q.bounds[0]));
    out.push({ refs: band.map((n) => n.ref), text: band.map(labelOf).join(' · '), y: ay1 });
  }
  return out;
}

/* ------------------------------------------------------------ 搜索结果 */

/**
 * ★ 2026-11-08：**「搜索结果页」上的一条到底是什么**。
 *
 * 真机（21:27–21:28，`docs/…` 截图那张必应结果页）：
 *   · 他说「你点网页」→ `taptext 网页` 点的是**顶部那排页签**（网页/图片/视频/学术…），
 *     搜索类型是切了，可**一个网站都没打开**；
 *   · 他说「就是你搜出来的第一个网站你点进去就好了呀」→ 她执行的是 `tapn 1`，
 *     而 `pick()` 数的是"内容区里带字的节点"—— 那排页签的「网页」正好是第 1 个。
 *     于是三次"点进去了"其实都在点页签，屏幕几乎没变。
 *
 * 所以单独认一层：**一条结果 = 一个网址**（域名那一行是锚），
 * 标题在它上面，摘要在它下面；点标题才真的打开那个网页。
 * 纯函数，不碰 adb / 模型。
 */

/** 像网址的那一行（Bing 手机版是 `https://aigengtu.com › DeepSeek娘`，也见过只有 `aigengtu.com`）。 */
const URL_RX = /(?:https?:\/\/|www\.)|(?:^|\s)[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.(?:com|cn|net|org|io|cc|me|co|top|xyz|info|tv|app|site|link)(?:[/?#\s]|$)/i;
/** 那一排"切换搜索类型"的字（它们**不打开任何网站**）。 */
const NAV_WORD = /^(网页|图片|视频|学术|词典|航班|搜索工具|资讯|贴吧|知道|文库|地图|全部|问答|购物|音乐|新闻|更多)$/;

/** 同一水平带上的一组节点（相隔不超过 `tol` 像素算一行）。 */
function bands(nodes, tol = 26) {
  const list = (nodes || []).filter((n) => n && n.text && n.bounds);
  list.sort((a, b) => (a.bounds[1] - b.bounds[1]) || (a.bounds[0] - b.bounds[0]));
  const out = [];
  for (const n of list) {
    const y = (n.bounds[1] + n.bounds[3]) / 2;
    const last = out[out.length - 1];
    if (last && Math.abs(y - last.y) <= tol) {
      last.nodes.push(n);
      last.y = (last.y * (last.nodes.length - 1) + y) / last.nodes.length;
    } else {
      out.push({ y, nodes: [n] });
    }
  }
  return out;
}

/**
 * 这一屏上的"导航横排"（网页 / 图片 / 视频 …）。
 * 判据是形状，不是词表：**同一行里 ≥3 个、每个都很短、大多能点、还都在上半屏**。
 * 所以 B 站首页那排「推荐/热门/追番」也会被认成导航，同样不该被当成"第 1 条内容"。
 */
function navRefs(nodes, screen) {
  const h = Number(screen && screen.height) || 0;
  const out = new Set();
  for (const b of bands(nodes, 26)) {
    const short = b.nodes.filter((n) => labelOf(n).length <= 5);
    if (b.nodes.length < 3 || short.length < 3) continue;
    const clicky = short.filter((n) => n.clickable).length;
    if (clicky < Math.ceil(short.length / 2)) continue;
    if (h && b.y > h * 0.5) continue;           // 下半屏的是底栏，不算导航
    const words = short.filter((n) => NAV_WORD.test(labelOf(n))).length;
    if (!words && b.nodes.length < 4) continue; // 词不像、条数又不多，别硬认
    for (const n of b.nodes) out.add(n.ref);
  }
  return out;
}

/**
 * 这一屏有几条"结果"，每条是哪个网址、点哪里。
 *
 * @returns {Array<{index:number, url:string, rawUrl:string, title:string, ref:string, center:number[]}>}
 *   认不出就返回 `[]`（上层退回 `pick()` / 交给模型，不猜）。
 */
function results(obs) {
  const nodes = enrich(obs && obs.nodes, obs && obs.screen);
  const content = nodes.filter((n) => n.region === 'content' && n.text);
  if (content.length < 2) return [];
  const nav = navRefs(content, obs && obs.screen);
  const body = content.filter((n) => !nav.has(n.ref));
  const anchors = body.filter((n) => URL_RX.test(n.text));
  if (!anchors.length) return [];
  /** 同一个条目的"域名一行"和"https://… › 标题"两行常常挨着 —— 60px 内并成一条。 */
  const merged = [];
  for (const a of anchors.sort((p, q) => (p.bounds[1] - q.bounds[1]))) {
    const prev = merged[merged.length - 1];
    if (prev && Math.abs(a.bounds[1] - prev.bounds[1]) < 60) { prev.more = prev.more || []; prev.more.push(a); continue; }
    merged.push(a);
  }
  const out = [];
  merged.forEach((u, i) => {
    const uy = (u.bounds[1] + u.bounds[3]) / 2;
    const nextY = merged[i + 1] ? (merged[i + 1].bounds[1] + merged[i + 1].bounds[3]) / 2 : uy + 420;
    const prevY = i > 0 ? (merged[i - 1].bounds[1] + merged[i - 1].bounds[3]) / 2 : uy - 200;
    /**
     * 标题：这条结果的 y 范围里"离网址最近、又不像摘要"的那行。
     * 必应手机版的样子是 `aigengtu.com` → `https://aigengtu.com › 标题` → **大标题** → 摘要，
     * 所以只按"最长"会挑到摘要（真机就是这样把"2781 张"当成了那页的内容）。
     * 这里按距离排，并把"像摘要的"（以。…结尾、句子很长）往后压。
     */
    const around = body.filter((n) => {
      const y = (n.bounds[1] + n.bounds[3]) / 2;
      return !URL_RX.test(n.text) && y > prevY + 8 && y < nextY - 8;
    }).map((n) => {
      const d = Math.abs((n.bounds[1] + n.bounds[3]) / 2 - uy);
      const snippetish = /[。…]$/.test(n.text) || /^.{28,}$/.test(n.text);
      return { n, score: d + (snippetish ? 120 : 0) };
    }).sort((p, q) => p.score - q.score);
    const title = around.length ? around[0].n : null;
    const tap = [title, u, ...(u.more || [])].find((n) => n && n.clickable) || u;
    const url = String(u.text)
      .replace(/^https?:\/\//i, '')
      .split(/[\s›>]+/)[0]
      .replace(/[),.;]+$/, '');
    out.push({
      index: i + 1,
      url,
      rawUrl: String(u.text),
      title: title ? title.text.slice(0, 40) : '',
      ref: tap.ref,
      center: tap.center,
      y: uy,
    });
  });
  return out;
}

/** 区域顺序（给人读的时候按"从上看下来"排）。 */
const REGION_ORDER = ['status', 'appbar', 'content', 'tabbar'];
const REGION_NAME = { status: '状态栏', appbar: '顶栏', content: '内容', tabbar: '底栏' };

/**
 * 给她看的紧凑树：按区域分组。
 *
 *   [顶栏] n0 返回  n1 搜索
 *   [内容] n2 视频 · UP主 · 3:35
 *   [底栏] n8 首页  n9 动态
 */
function tree(obs, { max = 40 } = {}) {
  const nodes = enrich(obs && obs.nodes, obs && obs.screen).slice(0, max);
  const groups = new Map();
  for (const n of nodes) {
    if (!groups.has(n.region)) groups.set(n.region, []);
    groups.get(n.region).push(n);
  }
  const lines = [];
  for (const region of REGION_ORDER) {
    const list = groups.get(region);
    if (!list || !list.length) continue;
    /**
     * 内容区先拼行：把同一行的碎片并成一条，再把行里第一个节点当代表。
     * （顶栏/底栏不拼 —— 那里的每个字都是独立的按钮。）
     */
    const parts = [];
    if (region === 'content') {
      const used = new Set();
      for (const row of rows(list)) {
        const first = list.find((n) => n.ref === row.refs[0]);
        if (!first) continue;
        row.refs.forEach((r) => used.add(r));
        const sameRef = row.refs.length === 1;
        parts.push(sameRef ? `${first.ref} ${first.text}` : `${first.ref} ${row.text}`);
      }
      for (const n of list) if (!used.has(n.ref)) parts.push(n.text ? `${n.ref} ${n.text}` : `${n.ref} [${n.role || '无字'}]`);
    } else {
      for (const n of list) if (n.text) parts.push(`${n.ref} ${n.text}`);
    }
    if (parts.length) lines.push(`[${REGION_NAME[region]}] ${parts.join('  ')}`);
  }
  if (obs && obs.more) lines.push(`+${obs.more} 项没列出来`);
  return lines.join('\n');
}

/** 这一段能不能"读"（有字的内容 ≥ 2 条）。 */
function readable(obs) {
  const nodes = (obs && obs.nodes) || [];
  const texts = nodes.filter((n) => labelOf(n) && labelOf(n).length >= 2 && !n.editable);
  return { ok: texts.length >= 2, count: texts.length, thin: !!(obs && obs.thin) };
}

/**
 * 给她"读"这一屏：一段话，不是一棵树。
 *
 * 目的：让她先说"这一页讲了什么"，而不是每步都靠一张图。
 * 读不到就如实写"这屏没字"，**不编**（0 token 的假描述比没有更糟）。
 *
 * ★ 2026-11-08：**搜索结果页单独说清**。真机 21:27 她把结果页摘要里的
 * "2781 张"当成了"那一页里的张数"——因为她看到的是一串没有结构的字。
 * 现在只要认出 ≥2 条带网址的结果，就先给她一句"每一条 = 一个网址，
 * 点开哪条才是那个网站；摘要不是那网站的内容"，再按条列"第 N 条《标题》— 网址"。
 */
function digest(obs, { max = 900 } = {}) {
  const nodes = enrich(obs && obs.nodes, obs && obs.screen);
  const app = String((obs && obs.app && obs.app.name) || '');
  const r = readable(obs);
  if (!r.ok) {
    return `${app ? `${app}：` : ''}这一屏**读不出字**（${r.thin ? '控件树几乎是空的，可能是自绘页面或还没加载' : '只有一两个节点'}）；要看的话只能截图。`;
  }
  const found = results(obs);
  if (found.length >= 1) {
    const items = found.slice(0, 10).map((x) => `第${x.index}条 ${x.title ? `《${x.title}》` : '（没读到标题）'} — 网址 ${x.url}`);
    const body = [
      '（这一屏是**搜索结果页**，不是一个网站：下面每一条 = 一个网址，打开哪条才是那个网站；'
        + '每条下面那几行是搜索站给的摘要，**不是**那个网站里的内容）',
      ...items,
    ].join('\n');
    return body.length > max ? `${body.slice(0, max)}…（后面还有，没全列）` : body;
  }
  const lines = [];
  const top = nodes.filter((n) => n.region === 'appbar' && n.text);
  if (top.length) lines.push(`顶栏：${top.map((n) => n.text).join(' / ')}`);
  const content = nodes.filter((n) => n.region === 'content' && n.text);
  const seen = new Set();
  for (const row of rows(content)) {
    if (!row.text || seen.has(row.text)) continue;
    seen.add(row.text);
    lines.push(`· ${row.text}`);
    if (lines.length >= 12) break;
  }
  const btns = nodes.filter((n) => n.region === 'tabbar' && n.text);
  if (btns.length) lines.push(`底栏：${btns.map((n) => n.text).join(' / ')}`);
  const body = lines.join('\n');
  return body.length > max ? `${body.slice(0, max)}…（后面还有，没全列）` : body;
}

/**
 * 在这一屏里找词：返回**最匹配**的那个节点（找不到就是 null，不猜）。
 *
 * ★ 2026-11-12：**改成五档 + 完全相等优先**。
 *
 * 旧版是"`text` 里包含就算命中"，于是：
 *   · 搜「菜谱」会先命中「菜谱大全」（点错 App）—— 没有"完全相等"这一档；
 *   · 有 `text` 的节点 `desc` 被丢掉（按 content-desc 写的那个词永远查不到）；
 *   · 排序只看 region/clickable，不看"文字匹配得多准"。
 *
 * 现在：`text ===` → `desc ===` → `text` 前缀 → `desc` 前缀 → 包含；
 * 同一档里再优先"内容区 / 可点"。
 */
function find(obs, word) {
  const needle = String(word || '').trim();
  if (!needle) return null;
  const nodes = enrich(obs && obs.nodes, obs && obs.screen);
  const tierOf = (n) => {
    const t = String(n.text || '');
    const d = String(n.desc || '');
    if (t === needle) return 0;
    if (d === needle) return 1;
    if (t && t.startsWith(needle)) return 2;
    if (d && d.startsWith(needle)) return 3;
    if (t && t.includes(needle)) return 4;
    if (d && d.includes(needle)) return 5;
    return -1;
  };
  let best = null;
  let bestScore = Infinity;
  for (const n of nodes) {
    const tier = tierOf(n);
    if (tier < 0) continue;
    /** 档位是主序（×10），区域/可点只是同档内的次序（0~3）。 */
    const score = tier * 10 + (n.region === 'content' ? 0 : 2) + (n.clickable ? 0 : 1);
    if (score < bestScore) { bestScore = score; best = n; }
  }
  return best;
}

/**
 * 按说法挑一个：
 *   `第3个` / `第三个` / `带猫的` / `最上面那个` / `最后一个`
 * 挑不到返回 null（上层如实说"没有这个"）。
 */
function pick(obs, how) {
  const nodes = enrich(obs && obs.nodes, obs && obs.screen);
  /**
   * "第几个"数的是**内容区**里的条目 —— 她说"第二个"时，心里数的不是顶栏的返回键。
   * 内容区没字才退回全屏。
   */
  const content = nodes.filter((n) => n.text && n.region === 'content');
  const cands = content.length ? content : nodes.filter((n) => n.text);
  /**
   * ★ 2026-11-07：**"第 N 个"按屏幕从上往下数**（原来按 XML 顺序，顶栏的工具条
   * 常常排在第一条结果前面，`tapn 1` 就点到了"切换到国际版"）。
   */
  cands.sort((a, b) => ((a.bounds?.[1] || 0) - (b.bounds?.[1] || 0)) || ((a.bounds?.[0] || 0) - (b.bounds?.[0] || 0)));
  const s = String(how || '').trim();
  if (!cands.length) return null;
  const CN = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  const num = (() => {
    const m = /第\s*([0-9]+|[一二两三四五六七八九十])/.exec(s);
    if (!m) return 0;
    return /^[0-9]+$/.test(m[1]) ? Number(m[1]) : (CN[m[1]] || 0);
  })();
  if (num) return cands[num - 1] || null;
  if (/最上面|最上边|第一个/.test(s)) return cands[0] || null;
  if (/最后|最下面|最下边/.test(s)) return cands[cands.length - 1] || null;
  const m = /(?:带|有|包含|叫)\s*[「"']?(.{1,12}?)[」"']?(?:的|那个|这条|这条)?$/.exec(s);
  if (m && m[1]) return find(obs, m[1]);
  return find(obs, s);
}

module.exports = {
  roleOf, regionOf, labelOf, locOf, enrich, rows, tree, digest, readable, find, pick,
  results, navRefs, bands, URL_RX, NAV_WORD, REGION_ORDER,
};
