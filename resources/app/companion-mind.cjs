/**
 * 她心里的事 —— **念头池**。
 *
 * 自主说话最容易翻车的地方不是"什么时候说"，而是"说什么"：如果每次到点都让模型
 * 现场找一句话，它只能给出"在干嘛呢"这种模板。人不是这样 —— 人是**平时就在想事**，
 * 心里攒着几件没说出口的，某一刻正好想说，才开口。
 *
 * 所以这个文件只管一件事：**把"她脑子里冒出来的念头"存下来**。
 *   · 念头带一个 1~5 的动机分（她自己给的）；
 *   · 念头会过期（动机越低越短命：随口一句半小时就不想说了）；
 *   · 挑的时候按"没过期 + 这个会话 + 还没说"过滤，打分交给 `companion-presence.cjs`。
 *
 * 存储：`data/companion/mind.json`，一个很小的数组（最多 `max` 条）。
 * 全是一个人的内心话，设置页「清空陪伴记忆」会连它一起清掉。
 */
const fs = require('node:fs');
const path = require('node:path');
const store = require('./store.cjs');

const MAX = 40;
/** 动机 → 命多久：1 分（随口）半小时就忘；4 分以上能存六个小时。 */
function ttlFor(motivation) {
  const m = Number(motivation) || 1;
  if (m >= 4) return 360 * 60_000;
  if (m >= 3) return 180 * 60_000;
  return 60 * 60_000;
}

/** 去掉标点空格，用来判断"这条是不是已经想过了"。 */
function norm(text) {
  return String(text || '').replace(/[\s\p{P}]/gu, '').toLowerCase();
}

/** 太像就算重复：完全一样，或者一条包住另一条（且够长）。 */
function sameThought(a, b) {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  if (x === y) return true;
  if (x.length >= 6 && y.length >= 6 && (x.includes(y) || y.includes(x))) return true;
  return false;
}

class Mind {
  /**
   * @param {object} opts
   * @param {string} opts.file      存储文件
   * @param {number} [opts.max=40]  最多存几条
   * @param {Function} [opts.now]   取当前时间（自检注入假时钟）
   * @param {object} [opts.log]
   */
  constructor({ file, max = MAX, now = Date.now, log = null } = {}) {
    this.file = file;
    this.max = Math.max(4, Number(max) || MAX);
    this.now = now;
    this.log = log;
    this.thoughts = null;
    this.seq = 0;
  }

  #read() {
    if (this.thoughts) return this.thoughts;
    const raw = store.readJson(this.file);
    const list = raw && Array.isArray(raw.thoughts) ? raw.thoughts : [];
    this.thoughts = list
      .filter((t) => t && typeof t.text === 'string' && t.text.trim())
      .map((t) => ({
        id: String(t.id || ''),
        key: String(t.key || ''),
        personId: String(t.personId || ''),
        text: String(t.text).slice(0, 80),
        motivation: Math.min(5, Math.max(1, Number(t.motivation) || 3)),
        createdAt: Number(t.createdAt) || 0,
        expiresAt: Number(t.expiresAt) || 0,
        status: ['pending', 'spoken', 'dropped'].includes(t.status) ? t.status : 'pending',
        source: String(t.source || 'mind'),
        spokeAt: Number(t.spokeAt) || 0,
      }));
    return this.thoughts;
  }

  #write() {
    const err = store.writeJson(this.file, { schemaVersion: 1, thoughts: this.thoughts || [] });
    if (err && this.log) this.log.warn?.(`念头池写不进去：${err.message}`);
  }

  /** 过期的不删，只标出来（设置页可以看"她想过什么"）；但超过上限就真删。 */
  #sweep(at) {
    const list = this.#read();
    // 超过 12 小时的"pending"直接标成过期掉，别一直占着
    for (const t of list) {
      if (t.status === 'pending' && t.expiresAt && at > t.expiresAt + 6 * 3_600_000) t.status = 'dropped';
    }
    while (list.length > this.max) {
      // 先扔最旧的、不是"还想说"的那条；都还在就扔最旧的
      const i = list.findIndex((t) => t.status !== 'pending');
      list.splice(i >= 0 ? i : 0, 1);
    }
  }

  /**
   * 收一批念头（模型想出来的）。
   *
   * @param {Array<{text:string, motivation:number}>} items
   * @param {{key?:string, personId?:string, source?:string}} where
   * @returns {Array} 真正收下的那几条
   */
  add(items, { key = '', personId = '', source = 'mind' } = {}) {
    const at = this.now();
    const list = this.#read();
    const added = [];
    for (const item of Array.isArray(items) ? items : []) {
      const text = String(item?.text || '').replace(/\s+/g, ' ').trim().slice(0, 60);
      if (!text) continue;
      const motivation = Math.min(5, Math.max(1, Math.round(Number(item?.motivation) || 3)));
      // 已经想过的（还没说的、或者刚说过的）就别再收一遍；同一批里的重复也要挡住
      const dup = added.some((t) => sameThought(t.text, text))
        || list.some((t) => (t.status === 'pending' || (t.status === 'spoken' && at - t.spokeAt < 12 * 3_600_000))
          && sameThought(t.text, text));
      if (dup) continue;
      added.push({
        id: `${at.toString(36)}-${(this.seq += 1).toString(36)}`,
        key: String(key || ''),
        personId: String(personId || ''),
        text,
        motivation,
        createdAt: at,
        expiresAt: at + ttlFor(motivation),
        status: 'pending',
        source,
        spokeAt: 0,
      });
    }
    if (!added.length) return [];
    list.push(...added);
    this.#sweep(at);
    this.#write();
    return added;
  }

  /** 这个会话里现在还能用的念头（没过期、没说、没说不要）。 */
  pending({ key = '', at = this.now(), max = 6 } = {}) {
    this.#sweep(at);
    return this.#read()
      .filter((t) => t.status === 'pending'
        && (!t.expiresAt || at <= t.expiresAt)
        && (!key || t.key === key))
      .sort((a, b) => b.motivation - a.motivation || b.createdAt - a.createdAt)
      .slice(0, Math.max(1, max));
  }

  /** 说出口了。 */
  markSpoken(id, at = this.now()) {
    const t = this.#read().find((x) => x.id === id);
    if (!t) return null;
    t.status = 'spoken';
    t.spokeAt = at;
    this.#write();
    return t;
  }

  /** 没发出去 / 她想想又算了。 */
  drop(id, why = '') {
    const t = this.#read().find((x) => x.id === id);
    if (!t) return null;
    t.status = 'dropped';
    t.dropWhy = String(why || '');
    this.#write();
    return t;
  }

  /** 最近说出口的几句（防重复、也给"她上一条说了什么"用）。 */
  recentSpoken({ key = '', n = 4 } = {}) {
    return this.#read()
      .filter((t) => t.status === 'spoken' && (!key || t.key === key))
      .sort((a, b) => b.spokeAt - a.spokeAt)
      .slice(0, Math.max(1, n));
  }

  stats({ key = '', at = this.now() } = {}) {
    const list = this.#read();
    const near = (t) => !key || t.key === key;
    return {
      total: list.length,
      pending: list.filter((t) => near(t) && t.status === 'pending' && (!t.expiresAt || at <= t.expiresAt)).length,
      spoken: list.filter((t) => near(t) && t.status === 'spoken').length,
      dropped: list.filter((t) => near(t) && t.status === 'dropped').length,
      latest: list.filter((t) => near(t) && t.status === 'pending')
        .sort((a, b) => b.createdAt - a.createdAt).slice(0, 3)
        .map((t) => ({ text: t.text, motivation: t.motivation, at: t.createdAt })),
    };
  }

  forget() {
    this.thoughts = [];
    try { fs.unlinkSync(this.file); } catch { /* 本来就没有 */ }
    return true;
  }
}

module.exports = { Mind, ttlFor, sameThought, norm, mindFile: (dir) => path.join(dir, 'mind.json') };
