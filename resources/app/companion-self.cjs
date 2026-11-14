/**
 * 她自己的“倾向”—— 不是人物账，也不是永久 traits。
 *
 * 为什么单独放：
 *   - `people.json` 是**他的**账（他的名字/作息/喜好），她的性子不该写进去；
 *   - 她的性子也不能写成“爱怼人/说话简短”这种固定标签，那会把一个人钉死；
 *   - 这里只存**行为观察**（“最近被夸时会先顶一句”），它只影响这一轮的自我认知，
 *     不进角色卡，也不进人物账。
 *
 * ★ 2026-10-30：从“纯文本 + 14 天硬截止”升级成**带证据的倾向层**：
 *   - 同一条观察再次出现 = 证据 +1、最近出现时间刷新 → 活得久一点；
 *   - 只出现一次的观察会自然淡出（约 14 天），不会被一次对话定死；
 *   - 注入按 `次数 × 0.5^(距今天数/14)` 排序，最多 3 条。
 *   这样她**会慢慢长出自己的习惯**，但每一条都还有“可能只是最近”的余地。
 *
 * 每条：`{ at(首次), lastAt(最近), text, source, count }`
 * 文件：`<data>/companion/self.jsonl`，一行一个 JSON；明文，和 turns 一样。
 */
const fs = require('node:fs');
const path = require('node:path');
const log = require('./log.cjs');

const FILE = path.join(path.dirname(log.file), 'companion', 'self.jsonl');
const MAX = 60;          // 文件里最多留多少条
const KEEP_DAYS = 14;    // 半衰期（天）：单次约 14 天后淡出，两次约 28 天
const INJECT = 3;        // 每轮最多带几条
const MAX_CHARS = 60;
const MIN_SCORE = 0.5;   // 低于这个分数不再注入
const MAX_AGE_DAYS = 120;

function clean(text, max = MAX_CHARS) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** 去标点/空白后的 key，用来挡完全重复。 */
function keyOf(text) {
  return clean(text).replace(/[\s\p{P}]/gu, '').toLowerCase();
}

/**
 * ★ 2026-11-01：**"她怎么用某个功能"不是她的性子，既不写也不注入。**
 *
 * 用户实测：她每次发语音前都先来一句"不确定能不能调 / 得你那边先调好"，像在给机器打预防针。
 * 查 `self.jsonl`，13:32 正好被写下一条"最近被要求语音时，会先说明自己不太顺手"——
 * 它每轮都进【最近你自己】，等于把她自己的这句口头禅**钉成习惯**（自我强化）。
 *
 * 这类观察说的是"当时那台机器通没通"，不是她跟人相处的方式；记下来只会让她越来越像
 * 一个反复确认接口的助手。所以带这些词的一律不进（`add` 不写、`recent` 不注入）。
 */
const CHANNEL = /语音|嗓子|发声|出声|变声|调音|tts|功能|程序|设置|接口|联网|模型/iu;

/** 这条观察值不值得留：说的是"她这个人"，而不是"她怎么用功能"。 */
function usable(text) {
  return !CHANNEL.test(String(text || ''));
}

function bigrams(text) {
  const s = keyOf(text);
  const set = new Set();
  if (s.length < 2) { if (s) set.add(s); return set; }
  for (let i = 0; i + 2 <= s.length; i += 1) set.add(s.slice(i, i + 2));
  return set;
}

/**
 * 两条观察有多像：0..1。
 * 完全同 key = 1；否则 bigram Jaccard；“短句被长句完整包含”也算像（中文换个说法常这样）。
 */
function similarity(a, b) {
  const ka = keyOf(a);
  const kb = keyOf(b);
  if (!ka || !kb) return 0;
  if (ka === kb) return 1;
  const A = bigrams(a);
  const B = bigrams(b);
  let inter = 0;
  for (const x of A) if (B.has(x)) inter += 1;
  const union = A.size + B.size - inter;
  const jaccard = union ? inter / union : 0;
  const [shorter, longer] = ka.length <= kb.length ? [ka, kb] : [kb, ka];
  const contains = shorter.length >= 8 && longer.includes(shorter);
  return Math.max(jaccard, contains ? 0.72 : 0);
}

function readAll() {
  try {
    const raw = fs.readFileSync(FILE, 'utf8');
    return raw.split(/\r?\n/).map((line) => {
      const s = line.trim();
      if (!s) return null;
      try {
        const o = JSON.parse(s);
        const text = clean(o.text);
        if (!text) return null;
        const at = Number(o.at) || 0;
        return {
          at,
          lastAt: Number(o.lastAt) || at,
          text,
          source: String(o.source || ''),
          count: Math.max(1, Number(o.count) || 1),
        };
      } catch { return null; }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

function writeAll(list) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, `${list.map((x) => JSON.stringify(x)).join('\n')}\n`, 'utf8');
  fs.renameSync(tmp, FILE);
}

/** 一条观察现在的“分量”：次数 × 时间衰减。 */
function scoreOf(entry, now = Date.now(), halfLifeDays = KEEP_DAYS) {
  const last = Number(entry.lastAt) || Number(entry.at) || 0;
  const days = Math.max(0, (Number(now) - last) / 86400000);
  if (days > MAX_AGE_DAYS) return 0;
  const half = Math.max(1, Number(halfLifeDays) || KEEP_DAYS);
  return (Number(entry.count) || 1) * Math.pow(0.5, days / half);
}

/**
 * 追加观察。同一件事（措辞不同也算）不重复写，而是把证据 +1。
 * @param {string[]|string} items
 * @param {{at?:number, source?:string}} [opts]
 * @returns {number} 这次被接受了几条（新写 + 合并）
 */
function add(items, { at = Date.now(), source = '' } = {}) {
  const list = readAll();
  const stamp = Number(at) || Date.now();
  let accepted = 0;
  for (const item of Array.isArray(items) ? items : [items]) {
    const text = clean(typeof item === 'string' ? item : item?.text);
    if (!text) continue;
    if (!usable(text)) continue;
    let best = null;
    let bestScore = 0;
    for (const old of list) {
      const score = similarity(old.text, text);
      if (score > bestScore) { bestScore = score; best = old; }
    }
    if (best && bestScore >= 0.62) {
      best.count = Math.max(1, Number(best.count) || 1) + 1;
      best.lastAt = Math.max(Number(best.lastAt) || Number(best.at) || 0, stamp);
      // 更具体的那句留着（“再收下”比“先顶一句”多一层信息）
      if (text.length > best.text.length) best.text = text;
      accepted += 1;
      continue;
    }
    list.push({ at: stamp, lastAt: stamp, text, source: String(source || ''), count: 1 });
    accepted += 1;
  }
  if (!accepted) return 0;
  list.sort((a, b) => (a.lastAt || a.at) - (b.lastAt || b.at));
  while (list.length > MAX) {
    // 丢“分量”最低的那条，而不是最旧的：重复出现的旧观察比一次性的新观察更值得留
    let worst = 0;
    for (let i = 1; i < list.length; i += 1) {
      if (scoreOf(list[i]) < scoreOf(list[worst])) worst = i;
    }
    list.splice(worst, 1);
  }
  writeAll(list);
  return accepted;
}

/**
 * 现在该注入的观察：按分量排序。
 *
 * ★ 2026-11-04：新增 `rotate` —— **按天轮换**。
 *
 * 原来每轮都取分数最高的 3 条，于是同一句「被夸时先顶一句」一天被读到几十遍
 * （`self.jsonl` 第 9/42 行 count 已经 12/14）—— 她自己读到的自我描述永远只有那几句，
 * 说出来就越来越像口头禅。现在：先取前 6 条，按"今天是第几天"挑起点取 1 条
 * （`companion-brain` 传 `limit:1, rotate:true`），**同一句要隔好几天才轮到一次**。
 *
 * @param {{days?:number, limit?:number, now?:number, rotate?:boolean}} [opts]
 */
function recent({ days = KEEP_DAYS, limit = INJECT, now = Date.now(), rotate = false } = {}) {
  const pool = readAll()
    .filter((x) => usable(x.text))
    .map((x) => ({ ...x, score: scoreOf(x, now, days) }))
    .filter((x) => x.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score || (b.lastAt || b.at) - (a.lastAt || a.at));
  const n = Math.max(1, Number(limit) || INJECT);
  if (!rotate) return pool.slice(0, n);
  if (!pool.length) return [];
  const top = pool.slice(0, Math.max(6, n));
  const day = Math.floor(Number(now) / 86_400_000);
  const start = day % top.length;
  return top.slice(start, start + n).concat(top.slice(0, Math.max(0, start + n - top.length))).slice(0, n);
}

/** 给 system 的一小段；没有就返回空串。 */
function render({ days = KEEP_DAYS, limit = INJECT, now = Date.now(), rotate = false } = {}) {
  const items = recent({ days, limit, now, rotate });
  if (!items.length) return '';
  return [
    '【最近你自己】',
    '你最近注意到自己：',
    ...items.map((x) => `- ${x.text}`),
    '这些是最近几次的观察，不是规定；你会变。',
  ].join('\n');
}

/** 清空陪伴记忆时一起清。 */
function forget() {
  try { fs.unlinkSync(FILE); } catch { /* 没有就算了 */ }
}

module.exports = {
  FILE, MAX, KEEP_DAYS, INJECT, MIN_SCORE,
  add, recent, render, forget, scoreOf, similarity, usable, all: readAll,
};
