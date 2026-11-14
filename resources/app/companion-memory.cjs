/**
 * 陪伴模式的记忆账本 —— 按「人」存，不按会话存。
 *
 * 为什么单独一个文件：桌宠原来的 `memory.cjs` 记的是「你和她的关系」
 * （认识多少天、摸过几次、上次说了什么），那是**一只宠物**的日记；
 * 陪伴模式要记的是「这个人说过什么、是什么样的人」，是**一本人物账**。
 * 两件事混在一起，清记忆、隐私、迁移都会互相牵连，所以分开。
 *
 * 账本长这样（`data/companion/people.json`）：
 *
 *   {
 *     "123456": {
 *       name: "群友A",
 *       traits: ["常熬夜"], facts: ["在杭州"], topics: ["聊过换工作"],
 *       pending: [], interactions: 3, firstSeenAt, lastSeenAt
 *     }
 *   }
 *
 * 另有 `turns.jsonl`：跨场合的真实一来一回，按时间排成一条线。
 * QQ 群、QQ 私聊、桌宠里打字，写的是同一本账 —— 她换个地方也认得人。
 *
 * **注意隐私**：这两个文件是明文。设置页可以一键清空；`config/companion.json`
 * 里也有开关。不要把 `data/companion/` 发人。
 */
const fs = require('node:fs');
const path = require('node:path');
const store = require('./store.cjs');
const clock = require('./clock.cjs');

/**
 * ★ 2026-11-02：**她发出去的东西也要留个痕**。
 *
 * 真机（11-02 20:44）：她刚把手机上的截图发给他，三秒后他说"为什么在这里看一盘菜"，
 * 她回"炖就炖，**你这表情包**是打算把我捞出来还是接着加水"——把自己发的图算成了他的。
 * 根因不是她记性差：`turns.jsonl` 里那一轮只有文字，**图在不在、是谁发的，一个字都没有**；
 * 下一轮拼历史时她只能猜。
 *
 * 所以从这个版本起，`logTurn()` 可以带 `media`（如 `['图']` / `['表情:晚安']`），
 * 回看时写成"（发了图）"。
 */
function mediaNote(media) {
  const list = Array.isArray(media) ? media.map(String).filter(Boolean) : [];
  return list.map((m) => (m === '图' ? '（发了图）' : `（发了${m}）`)).join('');
}

/**
 * ★ 2026-11-07：**这一轮是不是"手机进度"**（不是她跟他说的话）。
 *
 * 新行有 `kind:'phone'`；旧行（153 条空 text）没有标记，只能按**保守规则**认：
 * **只有 `text` 为空**（她没有在回谁）**且 reply 以那几句进度开头**才算。
 * 这样宁可漏认一条，也不会把她真说过的话（比如"屏幕上就是一堆网页条目"）藏掉。
 */
const PHONE_LEAD = /^(?:搜到|搜出来|搜出了|回首页|回桌面|回到桌面|往下翻|往上翻|翻了一屏|翻完了|停在|打开了|截了一张|截了张|挑了一张|卡在|滑到底|翻到底|上翻到)/;
function isPhoneTurn(turn) {
  if (!turn || typeof turn !== 'object') return false;
  if (String(turn.kind || '') === 'phone') return true;
  if (String(turn.text || '').trim()) return false;
  return PHONE_LEAD.test(String(turn.reply || '').trim());
}

/** 去标点/空白后的 key：挡"完全同一句"的重复。 */
function normalizeText(text) {
  return String(text || '').replace(/[\s\p{P}]/gu, '').toLowerCase();
}

function bigrams(text) {
  const s = normalizeText(text);
  const set = new Set();
  if (s.length < 2) { if (s) set.add(s); return set; }
  for (let i = 0; i + 2 <= s.length; i += 1) set.add(s.slice(i, i + 2));
  return set;
}

/**
 * 两条 traits/facts 有多像：0..1。
 * ★ 2026-10-30：以前只挡完全相同的字符串，于是"尊重对方自主性"和
 * "尊重对方自主性，不把对方当桌宠"会同时躺在账上（真机出现过）。
 * 现在长句包含短句也算同一条，合并时保留更具体的那句。
 */
function similarity(a, b) {
  const ka = normalizeText(a);
  const kb = normalizeText(b);
  if (!ka || !kb) return 0;
  if (ka === kb) return 1;
  const A = bigrams(a);
  const B = bigrams(b);
  let inter = 0;
  for (const x of A) if (B.has(x)) inter += 1;
  const union = A.size + B.size - inter;
  const jaccard = union ? inter / union : 0;
  const [shorter, longer] = ka.length <= kb.length ? [ka, kb] : [kb, ka];
  const contains = shorter.length >= 6 && longer.includes(shorter);
  return Math.max(jaccard, contains ? 0.75 : 0);
}

/**
 * 往 traits/facts 里放一条：已有近义条目就合并（保留更具体的那句），不堆第二条。
 * 合并后移到数组末尾 = "最近又被提到"，注入时取尾部 12 条自然变成 LRU。
 */
function putUnique(arr, value, max = 160) {
  const text = String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
  if (!text) return false;
  for (let i = 0; i < arr.length; i += 1) {
    if (similarity(arr[i], text) >= 0.7) {
      const keep = text.length >= String(arr[i]).length ? text : arr[i];
      arr.splice(i, 1);
      arr.push(keep);
      return true;
    }
  }
  arr.push(text);
  return true;
}

/**
 * 同一条话不要同时躺在 traits 和 facts 里。
 * ★ 2026-10-30 真机：整理员把"自称小主""上班一天会累""平时大约 12 点睡觉"同时写进了两边，
 * 于是 system 里「你了解他」和「他告诉过你」各念一遍。具体信息优先留在 facts。
 */
function dedupePerson(person) {
  const p = person || {};
  const facts = [];
  for (const value of p.facts || []) putUnique(facts, value);
  const traits = [];
  for (const value of p.traits || []) {
    if (facts.some((fact) => similarity(fact, value) >= 0.7)) continue;
    putUnique(traits, value);
  }
  p.facts = facts;
  p.traits = traits;
  return p;
}

class CompanionMemory {
  /**
   * @param {object} opts
   * @param {string} opts.dir       数据目录（一般是 `<应用目录>\data\companion`）
   * @param {number} [opts.maxTopics=20]
   * @param {number} [opts.maxTurns=1200]
   *
   * ★ 2026-11-01：**400 → 1200 轮**（用户："直接改成1200轮吧，大三倍也能够包含最近好几天了"）。
   * 为什么是轮数不是天数：这层是"逐字流水"，只喂 20 条给模型、12 条给跨场合，所以它的大小
   * 只影响两件事 —— ① 你回头能不能查到那天的原话；② 整理员落后时还有没有原料可补。
   * 实测 10-31 那天 376 轮，400 只够装一天多；1200 约等于三天多的密集聊天。
   * 代价：文件从 ~0.1 MB 到 ~0.3 MB，`#readTurns()` 全量解析仍是十毫秒量级。
   */
  constructor({ dir, maxTopics = 20, maxTurns = 1200 } = {}) {
    this.dir = dir;
    this.peopleFile = path.join(dir, 'people.json');
    this.turnsFile = path.join(dir, 'turns.jsonl');
    this.maxTopics = maxTopics;
    this.maxTurns = maxTurns;
    this.appends = 0;
    fs.mkdirSync(dir, { recursive: true });
  }

  /* ---------- 人物账 ---------- */

  #readAll() {
    const j = store.readJson(this.peopleFile);
    return j && typeof j === 'object' && !Array.isArray(j) ? j : {};
  }

  #writeAll(all) {
    const err = store.writeJson(this.peopleFile, all);
    if (err) throw new Error(`陪伴记忆写不进去：${err.message}`);
  }

  /** 取一个人的账；没有就建一本。 */
  person(id, { name } = {}) {
    const all = this.#readAll();
    const key = String(id);
    if (!all[key]) {
      all[key] = this.#blank(name || key);
      this.#writeAll(all);
    }
    const p = all[key];
    for (const k of ['traits', 'facts', 'topics', 'pending']) if (!Array.isArray(p[k])) p[k] = [];
    // ★ 2026-10-28：名字只认第一次。QQ 昵称（比如「✏️」）每轮都会传进来，
    // 不能让它把用户自己认下的名字（「小主」）顶掉；但"名字还是个 id"的时候要允许写进来。
    if (name && (!p.name || p.name === key)) { p.name = String(name).slice(0, 40); this.#writeAll(all); }
    return p;
  }

  #blank(name) {
    return {
      name: name || '', traits: [], facts: [], topics: [], pending: [],
      interactions: 0, firstSeenAt: Date.now(), lastSeenAt: Date.now(),
    };
  }

  /**
   * 往某人的账上写一条。`trait` / `fact` / `topic` / `pending` 都是可选的；
   * 同一条不会重复堆，提过的会被挪到最新。
   */
  remember(id, { trait, fact, topic, pending, name } = {}) {
    const all = this.#readAll();
    const key = String(id);
    if (!all[key]) all[key] = this.#blank(name || key);
    const p = all[key];
    for (const k of ['traits', 'facts', 'topics', 'pending']) if (!Array.isArray(p[k])) p[k] = [];
    // ★ 2026-10-28：同上，名字只认第一次，别被 QQ 昵称覆盖；id 当名字时可以覆盖。
    if (name && (!p.name || p.name === key)) p.name = String(name).slice(0, 40);

    const putExact = (arr, v) => {
      const s = String(v || '').replace(/\s+/g, ' ').trim().slice(0, 160);
      if (!s) return;
      const i = arr.indexOf(s);
      if (i >= 0) arr.splice(i, 1);
      arr.push(s);
    };
    if (trait) putUnique(p.traits, trait);
    if (fact) putUnique(p.facts, fact);
    if (topic) putExact(p.topics, topic);
    if (pending) putExact(p.pending, pending);

    while (p.topics.length > this.maxTopics) p.topics.shift();
    while (p.traits.length > 40) p.traits.shift();
    while (p.facts.length > 60) p.facts.shift();
    while (p.pending.length > 12) p.pending.shift();

    dedupePerson(p);
    p.lastSeenAt = Date.now();
    p.interactions = (Number(p.interactions) || 0) + 1;
    this.#writeAll(all);
    return p;
  }

  /**
   * ★ 2026-10-27：长期记忆的"人物账"只更新 traits/facts，**不涨互动次数**。
   * `remember()` 每调一次 interactions +1，摘要一次补三条会把次数算成三次，所以单独开这个口。
   */
  applyProfile(id, { name, traits = [], facts = [] } = {}) {
    const all = this.#readAll();
    const key = String(id);
    if (!all[key]) all[key] = this.#blank(name || key);
    const p = all[key];
    for (const k of ['traits', 'facts', 'topics', 'pending']) if (!Array.isArray(p[k])) p[k] = [];
    // ★ 2026-10-28：名字只认第一次（id 当名字时例外）。
    if (name && (!p.name || p.name === key)) p.name = String(name).slice(0, 40);
    for (const value of traits) putUnique(p.traits, value);
    for (const value of facts) putUnique(p.facts, value);
    dedupePerson(p);
    while (p.traits.length > 40) p.traits.shift();
    while (p.facts.length > 60) p.facts.shift();
    p.lastSeenAt = Date.now();
    this.#writeAll(all);
    return p;
  }

  /** 迁移用：把某人的 topics 清空（旧流水账已经转成长期记忆条目）。 */
  setTopics(id, topics = []) {
    const all = this.#readAll();
    const key = String(id);
    if (!all[key]) return null;
    all[key].topics = Array.isArray(topics) ? topics.slice(0, this.maxTopics) : [];
    this.#writeAll(all);
    return all[key];
  }

  /**
   * 把某些 traits 从他账里**挪走**（不硬删，进 `supersededTraits`，最多留 60 条，随时能翻）。
   *
   * ⚠️ **2026-11-04 的教训**：这个方法本来是为了"把他账里其实属于她的事挪走"写的，
   * 而那个判断**是错的** —— 他账里的「对方」指的就是**她**：
   * 「会主动逗对方（如摸头、戳肚子、举高高）」是**他**在逗她，有六个变体只是**重复**，不是归属错。
   * 那次误迁移把他的话搬成了她的喜好（用户当场发现），数据和代码都已经还原。
   *
   * 所以：这个原语本身没错（手改账、清洗明确写错的行都能用），
   * **但它绝不该被用来"纠正归属"** —— 归属只能按"这句话是谁说的"判。
   *
   * @param {string} id
   * @param {(trait:string)=>boolean} match
   * @returns {string[]} 被挪走的 traits
   */
  dropTraits(id, match) {
    const all = this.#readAll();
    const key = String(id);
    if (!all[key] || typeof match !== 'function') return [];
    const p = all[key];
    if (!Array.isArray(p.traits)) return [];
    const kept = [];
    const gone = [];
    for (const t of p.traits) (match(String(t)) ? gone : kept).push(t);
    if (!gone.length) return [];
    p.traits = kept;
    if (!Array.isArray(p.supersededTraits)) p.supersededTraits = [];
    p.supersededTraits.push(...gone);
    while (p.supersededTraits.length > 60) p.supersededTraits.shift();
    this.#writeAll(all);
    return gone;
  }

  /** 迁移用：只读一份完整人物账（不含 turns）。 */
  allPeople() {
    return this.#readAll();
  }

  /** 只涨互动次数，不写内容（一句「嗯」也值得记一笔）。 */
  touch(id, { name } = {}) {
    const all = this.#readAll();
    const key = String(id);
    if (!all[key]) return this.remember(key, { name });
    all[key].lastSeenAt = Date.now();
    all[key].interactions = (Number(all[key].interactions) || 0) + 1;
    if (name && (!all[key].name || all[key].name === key)) all[key].name = String(name).slice(0, 40);
    this.#writeAll(all);
    return all[key];
  }

  /* ---------- 共享对话流 ---------- */

  /**
   * 记一轮对话。`where` 说明发生在哪：`group:456` / `private:123` / `deskpet`。
   * 写失败不影响聊天 —— 记忆坏了也不该让她当场哑掉。
   */
  logTurn({ where, who, text, reply, personId, media = [], im = false, kind = 'chat' }) {
    const rec = {
      t: Date.now(),
      where: String(where || '').slice(0, 48),
      who: String(who || '').slice(0, 30),
      // ★ 2026-10-27：长期记忆按人隔离需要 uid；老记录没有这个字段（迁移时也不重抽旧 turns）。
      uid: String(personId || '').slice(0, 64),
      text: String(text || '').replace(/\s+/g, ' ').trim().slice(0, 400),
      reply: String(reply || '').replace(/\s+/g, ' ').trim().slice(0, 400),
    };
    /**
     * ★ 2026-11-07：**手机回灌/进度行**留一个来源标记（只有非聊天才写，老行一个字节都不改）。
     * 读的时候靠它（和老行的保守正则）跳过这些行，别让"翻了一屏"混进聊天记忆。
     */
    const k = String(kind || 'chat');
    if (k && k !== 'chat') rec.kind = k.slice(0, 16);
    // ★ 2026-11-05：这一轮她的回答里用了她自己的想象 —— **回看时要在前面标出来**。
    // 只落一个布尔，不改她当时说的话；想象本身不进任何记忆（见 `companion-imagine.cjs` 顶部）。
    if (im) rec.im = true;
    // ★ 2026-11-02：她自己发出去的图/表情（老记录没有这个字段，回看时当作"没发"）
    const med = (Array.isArray(media) ? media : []).map((m) => String(m).slice(0, 24)).filter(Boolean).slice(0, 3);
    if (med.length) rec.media = med;
    if (!rec.text && !rec.reply) return;
    try {
      fs.appendFileSync(this.turnsFile, `${JSON.stringify(rec)}\n`, 'utf8');
      this.appends += 1;
      // 每 40 轮裁一次，而不是每写一行都把整个文件读一遍
      if (this.appends % 40 === 0) this.#trim();
    } catch { /* 写不进去就算了，聊天继续 */ }
  }

  /**
   * ★ 2026-11-07：**裁之前先归档**（用户红线：不静默删旧对话）。
   *
   * 旧版到 1200 条就把最早的一行 `writeFileSync` 掉，没有副本 ——
   * 那些行里可能有她第一次说"我喜欢…"，也可能是唯一一次提起某个约定。
   * 现在被裁的行先追加进 `turns.archive.jsonl`；**归档写不进去就不裁**（下次再试），
   * `maxTurns` 本身不动（不降、不升）。
   */
  #trim() {
    try {
      const lines = fs.readFileSync(this.turnsFile, 'utf8').trim().split('\n').filter(Boolean);
      if (lines.length <= this.maxTurns) return;
      const drop = lines.slice(0, lines.length - this.maxTurns);
      const keep = lines.slice(-this.maxTurns);
      try {
        fs.appendFileSync(path.join(this.dir, 'turns.archive.jsonl'), `${drop.join('\n')}\n`, 'utf8');
      } catch (err) {
        // 归档失败 → 这一轮不裁（宁可文件大一点，也不丢她说过的原话）
        return;
      }
      fs.writeFileSync(this.turnsFile, `${keep.join('\n')}\n`, 'utf8');
    } catch { /* 裁不动就留着，下一次再试 */ }
  }

  /** 读整条对话流（坏行跳过）。长期记忆的抽取/压缩也用它。 */
  #readTurns() {
    try {
      return fs.readFileSync(this.turnsFile, 'utf8').trim().split('\n')
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  recentTurns(n = 20, { excludeWhere, sinceMs, where, personId, excludePhone = false } = {}) {
    let rows = this.#readTurns();
    if (sinceMs) rows = rows.filter((r) => Date.now() - r.t < sinceMs);
    // `where` = 只看某一个会话（当前私聊/群/桌宠）；`excludeWhere` = 跨场合时排除当前会话
    if (where) rows = rows.filter((r) => String(r.where || '') === String(where));
    if (excludeWhere) rows = rows.filter((r) => String(r.where || '') !== String(excludeWhere));
    // ★ 2026-10-27：跨场合上下文也按人隔离，别把 A 的私聊带到 B 的窗口里。
    if (personId !== undefined) rows = rows.filter((r) => String(r.uid || '') === String(personId));
    /**
     * ★ 2026-11-07：**先滤手机进度行，再取最近 N 轮**。
     * 顺序反了（先切 20 再滤）正常聊天会缩水 —— 那正是"historyLimit:2"那种修法，
     * 用户明确否了。文件最多 1200 行，全量读一遍是十毫秒量级，不值得为省它冒"少一轮"的险。
     */
    if (excludePhone) rows = rows.filter((r) => !isPhoneTurn(r));
    return rows.slice(-n);
  }

  /**
   * 时间戳晚于 `sinceMs` 的对话（按时间升序，最多 `limit` 条）。
   * 传 `personId` 时只看这个人的（没有 uid 的老记录不混进新抽取）。
   *
   * ★ 2026-11-01 修漏：原来是 `.slice(-limit)`（取**最新**的 N 条）。整理员一旦落后超过
   * `limit`（60）轮，中间那段就**永远轮不到**整理，而 `lastExtractedAt` 又被推到最新 ——
   * 那段只剩逐字流水，然后被 `maxTurns` 裁掉。现在取**最早**的 N 条：落后只会慢，不会漏。
   */
  turnsAfter(sinceMs = 0, limit = 60, { personId } = {}) {
    return this.#readTurns()
      .filter((r) => Number(r.t) > Number(sinceMs || 0))
      .filter((r) => personId === undefined || String(r.uid || '') === String(personId))
      .slice(0, Math.max(1, limit));
  }

  /** 对话流总条数（设置页/状态用）。 */
  turnsCount() {
    return this.#readTurns().length;
  }

  /* ---------- 给提示词用 ---------- */

  /** 把某人的账渲染成一段可注入的文字；没有账就返回空串。 */
  renderPerson(id) {
    const raw = this.#readAll()[String(id)];
    if (!raw) return '';
    const p = dedupePerson({ ...raw, traits: [...(raw.traits || [])], facts: [...(raw.facts || [])] });
    const L = [];
    if (p.traits?.length) L.push(`你了解他：${p.traits.slice(-12).join('；')}`);
    if (p.facts?.length) L.push(`他告诉过你：${p.facts.slice(-12).join('；')}`);
    if (p.topics?.length) L.push(`你们聊过：${p.topics.slice(-8).join('；')}`);
    if (p.pending?.length) L.push(`你心里还记着没说出口的事：${p.pending.slice(-4).join('；')}`);
    if (p.interactions) L.push(`你们互动过 ${p.interactions} 次`);
    if (!L.length) return '';
    return `【关于 ${p.name || id}（${id}）的一本账】\n${L.join('\n')}\n`;
  }

  /**
   * 最近的真实对话（跨场合合在一起），给模型当上下文。
   *
   * ★ 2026-11-02：**每行都得说清哪一天**。
   * 原来只印 `HH:MM`，于是**昨天的 23:44** 紧挨着"现在 19:12"排在同一段里，
   * 看起来就像今天还发生过 23:44 —— 她"昨天/今天"分不清，这一段是帮凶之一。
   * 现在今天写「今天 20:44」、昨天写「昨天 23:44」、更早写「11-01 23:44」。
   * `opts.now` 只给自检用（假时钟）。
   */
  renderRecent(n = 20, opts = {}) {
    const rows = this.recentTurns(n, opts);
    if (!rows.length) return '';
    const now = Number(opts.now) || Date.now();
    const lines = rows.map((r) => {
      const when = clock.recentStamp(r.t, now);
      const place = String(r.where || '').startsWith('group') ? '群里'
        : String(r.where || '') === 'deskpet' ? '桌宠' : '私聊';
      const parts = [];
      if (r.text) parts.push(`${r.who}（${place}）：${r.text}`);
      if (r.reply) parts.push(`你：${r.reply}${mediaNote(r.media)}`);
      return `  ${when}  ${parts.join('\n        ')}`;
    });
    return `【最近的真实对话（跨场合合在一起，每行开头是那天几点）】\n${lines.join('\n')}\n（这些是真说过的，别装作不知道，也别生硬复述）\n`;
  }

  /* ---------- 设置页 / 隐私 ---------- */

  /** 只读快照：给人看的，不含完整聊天记录。 */
  snapshot() {
    const all = this.#readAll();
    const people = Object.entries(all).map(([id, p]) => ({
      id,
      name: p.name || id,
      traits: (p.traits || []).length,
      facts: (p.facts || []).length,
      topics: (p.topics || []).length,
      interactions: Number(p.interactions) || 0,
      lastSeenAt: p.lastSeenAt || 0,
    })).sort((a, b) => b.lastSeenAt - a.lastSeenAt);
    let turns = 0;
    try { turns = fs.readFileSync(this.turnsFile, 'utf8').trim().split('\n').filter(Boolean).length; } catch { /* 还没聊过 */ }
    return { people, turns, dir: this.dir, peopleFile: this.peopleFile, turnsFile: this.turnsFile };
  }

  /** 忘掉所有人、所有对话；目录留着（下一次聊天会重新建）。 */
  forget() {
    for (const f of [this.peopleFile, this.turnsFile]) {
      try { fs.unlinkSync(f); } catch { /* 本来就没有 */ }
    }
    this.appends = 0;
    return this.snapshot();
  }

  /**
   * 一次性整理人物账：每个人的 traits/facts 重新过一遍 putUnique，合并近义重复。
   * 返回合并掉的条数。升级后/巡账时跑一次；不涨互动次数。
   * `apply:false` 只算不写（工具 dry-run 用）。
   */
  compactAll({ apply = true } = {}) {
    const all = this.#readAll();
    let merged = 0;
    for (const p of Object.values(all)) {
      const before = (p.traits || []).length + (p.facts || []).length;
      dedupePerson(p);
      merged += before - ((p.traits || []).length + (p.facts || []).length);
    }
    if (merged && apply) this.#writeAll(all);
    return merged;
  }
}

module.exports = { CompanionMemory, putUnique, dedupePerson, similarity, normalizeText, mediaNote, isPhoneTurn };
