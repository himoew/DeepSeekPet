/**
 * 长期记忆的检索底座（2026-10-27）。
 *
 * 设计参考了 `D:\DSH+Character`（dsh-liketavern，MIT）的 BM25 + 中文 bigram 做法，
 * 但按桌宠的体量重写成了一个小模块：
 *   · 中文按 **CJK bigram** 切：「我喜欢你」→ 我喜/喜欢/欢你（单字不成词）；
 *   · 英文/数字整词、转小写；
 *   · `keys` 的 token 再计一遍 = 关键词权重 ×2；
 *   · `ts` 参与时间衰减（×0.5^(elapsed/halfLife)）；
 *   · 检索候选先超取，再按 token 预算装正文（不是把整本账倒进 prompt）。
 *
 * 纯函数 + 内存索引，零依赖；桌宠只存几百条记忆，够用。
 */

/* ---------- 分词 ---------- */

function isCjkCode(code) {
  return (code >= 0x3400 && code <= 0x4dbf) || (code >= 0x4e00 && code <= 0x9fff);
}

/** 需要 bigram 的文字：CJK + 假名 + 谚文。 */
function isBigramScript(code) {
  return isCjkCode(code)
    || (code >= 0x3040 && code <= 0x30ff)
    || (code >= 0x31f0 && code <= 0x31ff)
    || (code >= 0xac00 && code <= 0xd7a3);
}

const BIGRAM_CLASS = '\\u3400-\\u4dbf\\u4e00-\\u9fff\\u3040-\\u30ff\\u31f0-\\u31ff\\uac00-\\ud7a3';
const WORD_CHAR = `(?:(?![${BIGRAM_CLASS}])[\\p{L}\\p{N}])`;
const SEGMENT_RE = new RegExp(`[${BIGRAM_CLASS}]+|${WORD_CHAR}+(?:[_-]${WORD_CHAR}+)*`, 'gu');

/** 检索分词。中文段滑窗 bigram；英文/数字整词保留。 */
function tokenize(text) {
  const tokens = [];
  const source = String(text || '');
  for (const match of source.matchAll(SEGMENT_RE)) {
    const seg = match[0];
    if (isBigramScript(seg.charCodeAt(0))) {
      for (let i = 0; i + 2 <= seg.length; i += 1) tokens.push(seg.slice(i, i + 2));
    } else {
      tokens.push(seg.toLowerCase());
    }
  }
  return tokens;
}

/** token 粗估：CJK 每字 1，其余字符 ÷4 向上取整。只用于预算，不追求跟模型 tokenizer 对齐。 */
function estimateTokens(text) {
  let cjk = 0;
  let other = 0;
  const source = String(text || '');
  for (let i = 0; i < source.length; i += 1) {
    if (isCjkCode(source.charCodeAt(i))) cjk += 1;
    else other += 1;
  }
  return cjk + Math.ceil(other / 4);
}

/** 按估算预算截断；超限时末尾加省略标记。 */
function clipToTokenBudget(text, budget) {
  const limit = Math.max(0, Math.floor(Number(budget) || 0));
  const source = String(text || '');
  const tokens = estimateTokens(source);
  if (tokens <= limit) return { text: source, truncated: false, tokens };
  if (limit === 0) return { text: '', truncated: true, tokens: 0 };
  const suffix = '…（已截断）';
  if (estimateTokens(suffix) > limit) {
    const fallback = estimateTokens('…') <= limit ? '…' : '';
    return { text: fallback, truncated: true, tokens: estimateTokens(fallback) };
  }
  let lo = 0;
  let hi = source.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const candidate = mid > 0 ? `${source.slice(0, mid)}\n${suffix}` : suffix;
    if (estimateTokens(candidate) <= limit) lo = mid;
    else hi = mid - 1;
  }
  const out = lo > 0 ? `${source.slice(0, lo)}\n${suffix}` : suffix;
  return { text: out, truncated: true, tokens: estimateTokens(out) };
}

/* ---------- BM25 ---------- */

class Bm25Index {
  constructor(options = {}) {
    this.k1 = options.k1 ?? 1.5;
    this.b = options.b ?? 0.75;
    this.docs = new Map();
    this.postings = new Map();
    this.totalLength = 0;
  }

  get size() {
    return this.docs.size;
  }

  add(doc) {
    this.remove(doc.id);
    const tf = new Map();
    let length = 0;
    const count = (term) => {
      tf.set(term, (tf.get(term) || 0) + 1);
      length += 1;
    };
    for (const term of tokenize(doc.text)) count(term);
    for (const term of tokenize((doc.keys || []).join(' '))) count(term);
    const entry = { id: doc.id, length, tf, ts: doc.ts, data: doc.data };
    this.docs.set(doc.id, entry);
    this.totalLength += length;
    for (const term of tf.keys()) {
      let set = this.postings.get(term);
      if (!set) {
        set = new Set();
        this.postings.set(term, set);
      }
      set.add(entry);
    }
  }

  remove(id) {
    const entry = this.docs.get(id);
    if (!entry) return;
    this.docs.delete(id);
    this.totalLength -= entry.length;
    for (const term of entry.tf.keys()) {
      const set = this.postings.get(term);
      if (!set) continue;
      set.delete(entry);
      if (set.size === 0) this.postings.delete(term);
    }
  }

  clear() {
    this.docs.clear();
    this.postings.clear();
    this.totalLength = 0;
  }

  /**
   * 检索。`filter(entry.data)` 可在打分前限定范围（按人隔离）；
   * `halfLifeMs > 0` 时按 `ts` 做时间衰减。
   */
  search(query, options = {}) {
    const topK = Math.max(0, Math.floor(Number(options.topK) || 0));
    const halfLifeMs = Number(options.halfLifeMs) || 0;
    const now = Number(options.now) || Date.now();
    const filter = typeof options.filter === 'function' ? options.filter : null;
    const docCount = this.docs.size;
    if (docCount === 0 || topK <= 0) return [];
    const terms = [...new Set(tokenize(query))];
    if (!terms.length) return [];

    const avgdl = this.totalLength / docCount || 1;
    const scores = new Map();
    for (const term of terms) {
      const set = this.postings.get(term);
      if (!set) continue;
      const df = set.size;
      const idf = Math.log(1 + (docCount - df + 0.5) / (df + 0.5));
      for (const entry of set) {
        if (filter && !filter(entry.data)) continue;
        const tf = entry.tf.get(term) || 0;
        const norm = 1 - this.b + (this.b * entry.length) / avgdl;
        const score = (idf * tf * (this.k1 + 1)) / (tf + this.k1 * norm);
        scores.set(entry.id, (scores.get(entry.id) || 0) + score);
      }
    }

    const hits = [];
    for (const [id, baseScore] of scores) {
      if (baseScore <= 0) continue;
      const entry = this.docs.get(id);
      if (!entry) continue;
      let score = baseScore;
      if (halfLifeMs > 0 && entry.ts !== undefined) {
        const elapsed = now - entry.ts;
        if (elapsed > 0) score *= Math.pow(0.5, elapsed / halfLifeMs);
      }
      hits.push({ id, score, data: entry.data });
    }
    hits.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return hits.slice(0, topK);
  }
}

/**
 * 在 token 预算内挑选正文：
 *   · 跳过空正文与重复正文（只忽略首尾空白）；
 *   · 超长的单条跳过，继续找后面能完整放下的（避免第一条把预算吃光）；
 *   · 一条都放不下时，截断最高相关的那条，别让记忆层整个空掉。
 */
function selectBodies(hits, tokenBudget, topK = hits.length) {
  const budget = Math.max(0, Math.floor(Number(tokenBudget) || 0));
  const limit = Math.max(0, Math.floor(Number(topK) || 0));
  if (budget === 0 || limit === 0) return [];
  const selected = [];
  const seen = new Set();
  let used = 0;
  let firstOversized = null;
  for (const hit of hits) {
    if (selected.length >= limit) break;
    const body = String(hit?.body ?? hit?.data?.body ?? '').trim();
    if (!body || seen.has(body)) continue;
    const tokens = estimateTokens(body);
    if (used + tokens <= budget) {
      selected.push(body);
      seen.add(body);
      used += tokens;
    } else if (firstOversized === null) {
      firstOversized = body;
    }
  }
  if (selected.length || firstOversized === null) return selected;
  const clipped = clipToTokenBudget(firstOversized, budget);
  return clipped.text.trim() ? [clipped.text] : [];
}

module.exports = {
  tokenize, estimateTokens, clipToTokenBudget, Bm25Index, selectBodies,
};
