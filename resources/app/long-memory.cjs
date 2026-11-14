/**
 * 长期记忆（2026-10-27）—— 陪伴模式和桌宠共用的一本"长期账"。
 *
 * 为什么单独一个模块：现在 `people.json` 的 topics 是逐句「用户话 → 回复」，
 * 20 条就满；聊得越久，旧事越容易被挤掉。这里把"值得长期记住的事"存成一条条 md：
 *
 *   data/companion/memory/m-<时间>-<随机>.md
 *   data/companion/memory/archive/...        # 压缩后的原文，只增不查
 *
 * 每轮只把"跟当前这句话相关"的几条（BM25 检索 + token 预算）拼进 prompt；
 * 超过容量时在空闲期把最旧一批压成一条摘要，原文归档、来源链保留。
 *
 * 设计参考 `D:\DSH+Character`（dsh-liketavern，MIT）的记忆实现；代码按桌宠的体量重写。
 *
 * **隐私**：文件是明文。设置页可以一键清空；不会写 base64 / 图片本体。
 */
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const store = require('./store.cjs');
const { Bm25Index, selectBodies, estimateTokens } = require('./bm25.cjs');
const { dedupePerson } = require('./companion-memory.cjs');
const clock = require('./clock.cjs');

const MEMORY_DIR = 'memory';
const ARCHIVE_PREFIX = 'archive/';
const ID_RE = /^[A-Za-z0-9_-]+$/;
const DEFAULT_STATE = {
  /** 0 = 还没迁移过；`init()` 会把旧 topics 转成条目后写成 1。 */
  schemaVersion: 0,
  /**
   * ★ 2026-11-01：整理到哪了。**按人各记一个**。
   *
   * 原来只有一个全局 `lastExtractedAt`，而 `extractNow()` 又按 `personId` 过滤 —— 于是
   * "A 整理一次"会把游标推到 A 的时间，**B 在那之前说的话永远轮不到整理**
   * （实测：B 的 6 轮里 5 轮被跳过）。这就是 11-01 修过的"落后就漏"的同一类问题，
   * 只是换成了"按人"这一维。
   * 老的配置里只有 `lastExtractedAt`：读的时候把它当**每个人的初始值**（见 `cursorFor`），
   * 所以升级不会重抽旧账，也不会漏。
   */
  lastExtractedAtByPerson: {},
  /**
   * ★ 2026-11-01：**没单独记过的人从哪儿开始整理**。
   *
   * 第一版我让它直接退回"此刻的全局最大值"，那是错的：全局那个是**所有人的最大值**，
   * 一被 A 推高，B 就跟着被跳过 —— 等于把原来的 bug 换个方式又写了一遍。
   * 现在单独存一份"开始按人记账时，全局到哪儿了"：新来的人从这里开始，
   * A 后面再往前走不会影响 B。
   */
  cursorBase: 0,
  /** 兼容/日志用：所有人数里最大的那个（= "全部整理到什么时候"）。 */
  lastExtractedAt: 0,
  turnsSinceExtract: {},
  pendingCompress: [],
  retryAfter: 0,
  lastError: '',
};

function nowIso() {
  return new Date().toISOString();
}

function isMemoryId(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= 120 && ID_RE.test(id);
}

function serialize(entry) {
  const scalar = (value) => String(value == null ? '' : value).replace(/[\r\n]+/g, ' ').trim();
  return [
    '---',
    `created: ${scalar(entry.created)}`,
    `updated: ${scalar(entry.updated)}`,
    `kind: ${scalar(entry.kind || 'fact')}`,
    `person: ${scalar(entry.person || 'owner')}`,
    `scope: ${scalar(entry.scope || 'person')}`,
    `source: ${scalar(entry.source || '')}`,
    `source_range: ${scalar(entry.sourceRange || '')}`,
    `source_turns: ${scalar(entry.sourceTurns || '')}`,
    `last_confirmed: ${scalar(entry.lastConfirmedAt || entry.updated || entry.created)}`,
    `evidence: ${Math.max(1, Number(entry.evidence) || 1)}`,
    `tags: ${JSON.stringify(entry.tags || [])}`,
    `keys: ${JSON.stringify(entry.keys || [])}`,
    `importance: ${Number(entry.importance) || 3}`,
    '---',
    '',
    String(entry.body || '').trim(),
  ].join('\n') + '\n';
}

function parse(file, text) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  if (lines[0] !== '---') throw new Error(`记忆缺少 frontmatter: ${file}`);
  let end = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i] === '---') { end = i; break; }
  }
  if (end < 0) throw new Error(`记忆 frontmatter 未闭合: ${file}`);
  const fields = new Map();
  for (const line of lines.slice(1, end)) {
    if (!line.trim()) continue;
    const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!m) throw new Error(`记忆字段无法解析: ${file}: ${line}`);
    fields.set(m[1], m[2]);
  }
  const created = fields.get('created') || '';
  if (!created || Number.isNaN(Date.parse(created))) throw new Error(`记忆 created 非法: ${file}`);
  const updated = fields.get('updated') || created;
  const parseArray = (raw) => {
    if (!raw) return [];
    /**
     * ★ 2026-11-01：**坏一行不该让整条记忆消失**。
     * 原来 `JSON.parse` 没有保护：某条记忆的 `tags:` / `keys:` 被手改坏了，
     * `list()` 里那条会被 warn 跳过、`get()`/`read()` 直接静默返回 null —— 记忆"凭空少了"。
     */
    try {
      const value = JSON.parse(raw);
      return Array.isArray(value) ? value.filter((x) => typeof x === 'string') : [];
    } catch {
      return [];
    }
  };
  const id = file.split('/').pop().replace(/\.md$/i, '');
  return {
    id,
    file,
    created,
    updated,
    kind: fields.get('kind') || 'fact',
    person: fields.get('person') || 'owner',
    scope: fields.get('scope') === 'global' ? 'global' : 'person',
    source: fields.get('source') || '',
    sourceRange: fields.get('source_range') || '',
    sourceTurns: fields.get('source_turns') || '',
    lastConfirmedAt: fields.get('last_confirmed') || updated,
    evidence: Math.max(1, Number(fields.get('evidence')) || 1),
    tags: parseArray(fields.get('tags')),
    keys: parseArray(fields.get('keys')),
    importance: Math.min(5, Math.max(1, Number(fields.get('importance')) || 3)),
    body: lines.slice(end + 1).join('\n').replace(/^\n+/, '').replace(/\n+$/, ''),
    archived: file.startsWith(ARCHIVE_PREFIX),
  };
}

class LongMemory {
  /**
   * @param {object} opts
   * @param {string} opts.dir      `data/companion`
   * @param {object} opts.memory   CompanionMemory（人物账 + turns）
   * @param {object} [opts.log]
   */
  constructor({ dir, memory, log }) {
    this.dir = dir;
    this.memory = memory;
    this.log = log || { info: () => {}, warn: () => {} };
    this.memoryDir = path.join(dir, MEMORY_DIR);
    this.archiveDir = path.join(this.memoryDir, ARCHIVE_PREFIX.replace(/\/$/, ''));
    this.stateFile = path.join(dir, 'memory-state.json');
    this.cache = null;
    this.indexCache = null;
    this.state = this.#loadState();
  }

  init() {
    fs.mkdirSync(this.memoryDir, { recursive: true });
    fs.mkdirSync(this.archiveDir, { recursive: true });
    try {
      this.migrate();
    } catch (err) {
      this.log.warn(`长期记忆迁移失败（下次再试）：${err.message}`);
    }
    return this;
  }

  /* ---------- 状态 ---------- */

  #loadState() {
    const raw = store.readJson(this.stateFile);
    return { ...DEFAULT_STATE, ...(raw && typeof raw === 'object' ? raw : {}) };
  }

  getState() {
    return {
      ...DEFAULT_STATE,
      ...this.state,
      lastExtractedAtByPerson: { ...(this.state.lastExtractedAtByPerson || {}) },
      turnsSinceExtract: { ...(this.state.turnsSinceExtract || {}) },
      pendingCompress: Array.isArray(this.state.pendingCompress) ? this.state.pendingCompress.slice() : [],
    };
  }

  /**
   * ★ 2026-11-01：**某个人的**整理游标。
   *
   * 没单独记过就用 `cursorBase`（= 开始按人记账时全局到哪儿了），**不是**当前的全局最大值 ——
   * 后者会被别人推高，等于又漏一遍。老配置没有 `cursorBase`/`lastExtractedAtByPerson`：
   * 前者 0、后者空，于是退回 `lastExtractedAt`，升级不重抽旧账。
   */
  cursorFor(personId) {
    const key = String(personId || '');
    const by = this.state.lastExtractedAtByPerson || {};
    const own = Number(by[key]);
    if (Number.isFinite(own) && own > 0) return own;
    /**
     * ⚠️ **已经按人记过账之后，没记过的人从 `cursorBase` 开始，绝不退回全局最大值。**
     * 这一点踩过两次：全局那个是"所有人里最大的"，A 一前进，B 就被跟着跳过 ——
     * 写成 `cursorBase || lastExtractedAt` 时，`cursorBase === 0`（从零开始这种合法情况）
     * 会掉进后面的分支，bug 又回来了。所以判据是"**有没有按人记过账**"，不是"base 大不大"。
     */
    if (Object.keys(by).length) return Number(this.state.cursorBase) || 0;
    /** 还没开始按人记账（老配置）：全局那个就是所有人的共同起点。 */
    return Number(this.state.lastExtractedAt) || 0;
  }

  /** 记一个人的进度：他自己那格 + 全局那个（取最大，给日志/面板看"全部到哪了"）。 */
  advanceCursor(personId, at) {
    const key = String(personId || '');
    const stamp = Number(at) || 0;
    const by = { ...(this.state.lastExtractedAtByPerson || {}) };
    if (stamp > (Number(by[key]) || 0)) by[key] = stamp;
    /** 第一次按人记账时，把"现在的全局值"冻成基准（见 DEFAULT_STATE.cursorBase 的注释）。 */
    const base = Number(this.state.cursorBase) || Number(this.state.lastExtractedAt) || 0;
    return this.patchState({
      lastExtractedAtByPerson: by,
      cursorBase: base,
      lastExtractedAt: Math.max(Number(this.state.lastExtractedAt) || 0, stamp),
    });
  }

  patchState(patch) {
    this.state = { ...this.state, ...(patch || {}) };
    const err = store.writeJson(this.stateFile, this.state);
    if (err) this.log.warn(`长期记忆状态写不进去：${err.message}`);
    return this.getState();
  }

  /* ---------- 条目 ---------- */

  #files() {
    try {
      return fs.readdirSync(this.memoryDir)
        .filter((name) => name.endsWith('.md'))
        .map((name) => {
          const full = path.join(this.memoryDir, name);
          const stat = fs.statSync(full);
          return { name, full, mtimeMs: stat.mtimeMs, size: stat.size };
        });
    } catch {
      return [];
    }
  }

  /** 活跃条目（不含 archive），按 created 升序。文件没变就复用缓存。 */
  list() {
    const files = this.#files();
    const fingerprint = files.map((f) => `${f.name}:${f.mtimeMs}:${f.size}`).join('\n');
    if (this.cache && this.cache.fingerprint === fingerprint) return this.cache.entries;
    const entries = [];
    for (const f of files) {
      try {
        entries.push(parse(f.name, fs.readFileSync(f.full, 'utf8')));
      } catch (err) {
        this.log.warn(`跳过坏记忆 ${f.name}：${err.message}`);
      }
    }
    entries.sort((a, b) => (a.created < b.created ? -1 : a.created > b.created ? 1 : a.id < b.id ? -1 : 1));
    this.cache = { fingerprint, entries };
    this.indexCache = null;
    return entries;
  }

  get(id) {
    if (!isMemoryId(id)) return null;
    try {
      return parse(`${id}.md`, fs.readFileSync(path.join(this.memoryDir, `${id}.md`), 'utf8'));
    } catch {
      return null;
    }
  }

  write(input) {
    fs.mkdirSync(this.memoryDir, { recursive: true });
    const created = input.created || nowIso();
    const entry = {
      id: `m-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`,
      created,
      updated: input.updated || created,
      kind: input.kind || 'fact',
      person: String(input.person || 'owner').slice(0, 64),
      scope: input.scope === 'global' ? 'global' : 'person',
      source: String(input.source || '').slice(0, 32),
      sourceRange: String(input.sourceRange || '').slice(0, 800),
      sourceTurns: String(input.sourceTurns || '').slice(0, 800),
      lastConfirmedAt: input.lastConfirmedAt || created,
      evidence: Math.max(1, Number(input.evidence) || 1),
      tags: (Array.isArray(input.tags) ? input.tags : []).map((x) => String(x).slice(0, 40)).slice(0, 12),
      keys: (Array.isArray(input.keys) ? input.keys : []).map((x) => String(x).slice(0, 40)).slice(0, 12),
      importance: Math.min(5, Math.max(1, Number(input.importance) || 3)),
      body: String(input.body || '').trim().slice(0, 600),
    };
    fs.writeFileSync(path.join(this.memoryDir, `${entry.id}.md`), serialize(entry), 'utf8');
    this.cache = null;
    this.indexCache = null;
    return { ...entry, file: `${entry.id}.md`, archived: false };
  }

  update(id, patch = {}) {
    const existing = this.get(id);
    if (!existing) return null;
    const next = {
      ...existing,
      ...patch,
      id: existing.id,
      created: existing.created,
      updated: nowIso(),
      tags: patch.tags !== undefined ? patch.tags : existing.tags,
      keys: patch.keys !== undefined ? patch.keys : existing.keys,
      body: patch.body !== undefined ? String(patch.body).trim().slice(0, 600) : existing.body,
      lastConfirmedAt: patch.lastConfirmedAt || existing.lastConfirmedAt,
      evidence: Math.max(1, Number(patch.evidence || existing.evidence) || 1),
    };
    fs.writeFileSync(path.join(this.memoryDir, `${id}.md`), serialize(next), 'utf8');
    this.cache = null;
    this.indexCache = null;
    return next;
  }

  delete(id) {
    if (!isMemoryId(id)) return false;
    try {
      fs.unlinkSync(path.join(this.memoryDir, `${id}.md`));
      this.cache = null;
      this.indexCache = null;
      return true;
    } catch {
      return false;
    }
  }

  /**
   * ★ 2026-10-30：再次被提到 ≠ 重复，而是"确认"。
   * 旧逻辑在整理时遇到相似条目直接 `continue`，等于把"这件事今天又被验证了一次"丢掉了；
   * 结果时间衰减只能按 `updated`（内容最后一次改）算，很久没改的旧事实会被越排越后。
   * 现在：证据 +1、`last_confirmed` 打点，排序用它而不是 `updated`。
   */
  confirm(id, { at = nowIso() } = {}) {
    const existing = this.get(id);
    if (!existing) return null;
    const next = {
      ...existing,
      evidence: Math.max(1, Number(existing.evidence) || 1) + 1,
      lastConfirmedAt: at,
    };
    fs.writeFileSync(path.join(this.memoryDir, `${id}.md`), serialize(next), 'utf8');
    this.cache = null;
    this.indexCache = null;
    return next;
  }

  /** 连 archive（含 legacy 子目录）一起读；面板/巡账/测试用，检索仍只查活跃库。 */
  read(id) {
    if (!isMemoryId(id)) return null;
    for (const dir of [this.memoryDir, this.archiveDir, path.join(this.archiveDir, 'legacy')]) {
      try {
        return parse(`${id}.md`, fs.readFileSync(path.join(dir, `${id}.md`), 'utf8'));
      } catch { /* 换下一个目录 */ }
    }
    return null;
  }

  /**
   * 把符合条件的条目移进 `archive/<subdir>/`（不删）。
   * 用途：清洗早期迁移进来的逐句流水账、工程细节；返回移动了哪些，便于写日志/回退。
   */
  prune(match, { subdir = 'legacy' } = {}) {
    const target = path.join(this.archiveDir, subdir || 'legacy');
    fs.mkdirSync(target, { recursive: true });
    const moved = [];
    for (const entry of this.list()) {
      if (typeof match === 'function' && !match(entry)) continue;
      try {
        fs.renameSync(path.join(this.memoryDir, `${entry.id}.md`), path.join(target, `${entry.id}.md`));
        moved.push(entry);
      } catch { /* 文件可能已被移动；跳过 */ }
    }
    if (moved.length) {
      this.cache = null;
      this.indexCache = null;
    }
    return { moved: moved.length, entries: moved, ids: moved.map((entry) => entry.id), dir: target };
  }

  /** 移进 archive/；返回移动条数。 */
  archive(ids) {
    fs.mkdirSync(this.archiveDir, { recursive: true });
    let moved = 0;
    for (const id of ids) {
      if (!isMemoryId(id)) continue;
      const from = path.join(this.memoryDir, `${id}.md`);
      const to = path.join(this.archiveDir, `${id}.md`);
      try {
        fs.renameSync(from, to);
        moved += 1;
      } catch {
        // 文件可能已经被删/移动；跳过
      }
    }
    if (moved) {
      this.cache = null;
      this.indexCache = null;
    }
    return moved;
  }

  /** 压缩：先归档原文，再写摘要；来源在等模型期间被改过就放弃。 */
  mergeBatch(batch, body, kind = 'compress') {
    for (const source of batch) {
      const current = this.get(source.id);
      if (!current || serialize(current) !== serialize(source)) return 0;
    }
    if (!batch.length) return 0;
    /**
     * ★ 2026-11-01：**先归档、再写摘要**（原来反着）。
     * 原来先写摘要、后归档：归档那一步万一失败（文件被占用/已被移走），
     * 就留下一条**和原文内容重复**的摘要。反过来之后最坏情况是"原文进了 archive、
     * 摘要没写成"—— 内容还在盘上（`archive/` 里也有 `source_range` 指回去），不会丢。
     */
    const moved = this.archive(batch.map((x) => x.id));
    if (!moved) return 0;
    let summary;
    try {
      summary = this.write({
        body,
        kind: 'summary',
        person: batch[0].person,
        scope: batch.every((x) => x.scope === 'global') ? 'global' : 'person',
        source: 'summary',
        sourceRange: `${kind}:${batch.map((x) => x.id).join(',')}`.slice(0, 800),
        sourceTurns: [...new Set(batch.flatMap((x) => String(x.sourceTurns || '').split(',').map((s) => s.trim()).filter(Boolean)))].join(',').slice(0, 800),
        lastConfirmedAt: batch.map((x) => x.lastConfirmedAt || x.updated || x.created).sort().at(-1),
        evidence: batch.reduce((sum, x) => sum + (Number(x.evidence) || 1), 0),
        tags: [...new Set([kind === 'compress' ? 'compressed' : 'merged', ...batch.flatMap((x) => x.tags || [])])],
        keys: [...new Set(batch.flatMap((x) => x.keys || []))],
        importance: Math.max(...batch.map((x) => Number(x.importance) || 3)),
      });
    } catch (err) {
      this.log.warn(`长期记忆：压缩摘要写不进去（原文已归档，不会丢）：${err.message}`);
      return { summary: null, archived: moved };
    }
    return { summary, archived: moved };
  }

  stats() {
    const entries = this.list();
    const byKind = {};
    for (const entry of entries) byKind[entry.kind] = (byKind[entry.kind] || 0) + 1;
    return {
      count: entries.length,
      tokens: entries.reduce((sum, entry) => sum + estimateTokens(entry.body), 0),
      people: new Set(entries.map((entry) => entry.person)).size,
      byKind,
    };
  }

  oldest(n = 16, { importanceBelow = 5 } = {}) {
    return this.list()
      .filter((entry) => Number(entry.importance) < importanceBelow)
      .slice(0, Math.max(0, n));
  }

  /* ---------- 检索 ---------- */

  #index() {
    const entries = this.list();
    const fingerprint = this.cache?.fingerprint || '';
    if (this.indexCache && this.indexCache.fingerprint === fingerprint) return this.indexCache.index;
    const index = new Bm25Index();
    for (const entry of entries) {
      index.add({
        id: entry.id,
        text: entry.body,
        keys: entry.keys,
        ts: Date.parse(entry.lastConfirmedAt) || Date.parse(entry.updated) || Date.parse(entry.created) || 0,
        data: entry,
      });
    }
    this.indexCache = { fingerprint, index };
    return index;
  }

  /**
   * 检索：BM25 + 时间衰减。`personId` 只用于 `recall` 的过滤；
   * 单独查全部时传 `personId:null`。
   */
  search(query, { topK = 6, halfLifeDays = 60, personId = null } = {}) {
    const limit = Math.max(0, Math.floor(Number(topK) || 0));
    if (!limit) return [];
    const filter = personId == null
      ? null
      : (entry) => entry.scope === 'global' || String(entry.person) === String(personId);
    const halfLifeMs = Number(halfLifeDays) > 0 ? Number(halfLifeDays) * 86400000 : 0;
    return this.#index().search(String(query || ''), {
      topK: Math.min(200, Math.max(limit * 4, 20)),
      halfLifeMs,
      filter,
    }).map((hit) => ({ entry: hit.data, score: hit.score }));
  }

  /** 人物账（稳定事实）：每轮都带，短、不衰减。 */
  profileText(personId, { maxChars = 600 } = {}) {
    const raw = this.memory.allPeople()[String(personId)];
    if (!raw) return '';
    const person = dedupePerson({ ...raw, traits: [...(raw.traits || [])], facts: [...(raw.facts || [])] });
    const lines = [];
    if (person.name) lines.push(`你认识他：${person.name}`);
    if (person.traits?.length) lines.push(`你了解他：${person.traits.slice(-12).join('；')}`);
    if (person.facts?.length) lines.push(`他告诉过你：${person.facts.slice(-12).join('；')}`);
    if (person.interactions) lines.push(`你们互动过 ${person.interactions} 次`);
    if (!lines.length) return '';
    const text = `【关于 ${person.name || personId} 的一本账】\n${lines.join('\n')}`;
    return text.length > maxChars ? text.slice(0, maxChars) : text;
  }

  /**
   * 一轮 Recall：人物账 + 相关长期记忆。
   * `where` 只用于把当前会话从"最近跨场合"里排除；`excludeWhere` 直接透传。
   */
  recall({
    personId, personName = '', query = '', platform = '',
    where = '', excludeWhere = '', topK = 6, tokenBudget = 1200,
    halfLifeDays = 60, recentTurns = 12,
  } = {}) {
    const profileText = this.profileText(personId);
    const q = [query, personName].filter(Boolean).join('\n');
    let memoryText = '';
    let entries = [];
    if (q.trim()) {
      const hits = this.search(q, { topK, halfLifeDays, personId });
      const bodies = selectBodies(hits.map((hit) => ({ body: hit.entry.body })), tokenBudget, topK);
      entries = hits.map((hit) => hit.entry).filter((entry) => bodies.includes(entry.body));
      /**
       * ★ 2026-11-02：**每条记忆前面写上是哪天的，正文里写死的"今天/昨天"也按那天还原。**
       *
       * 真机根因（11-02 19:12 她说"昨天你那个挑菜的店"，而那事就在当天 18:41）：
       * 原来这里只给 `- ${body}`，日期被整个剥掉；而条目的正文是**写的那天**的口吻：
       *   「他**今天**下午两点多才醒」（10-31 写的）
       *   「所以**明天**见面得等到晚上」（11-01 写的）
       * 几天后被检索出来，读起来永远像"今天/明天"。
       *
       * 现在：`- 11-01：他说 11 月 1 日中午才点薯条，上午先等着。`
       * · 日期取条目自己的 `created`（写这句话的那天），不用改用户的数据文件；
       * · 相对词在**读的时候**还原，所以**旧账也一起治好**（不用一次性洗库）。
       */
      const byBody = new Map(entries.map((entry) => [entry.body, entry]));
      memoryText = bodies.map((body) => {
        const entry = byBody.get(body);
        const at = entry ? (Date.parse(entry.created) || 0) : 0;
        if (!at) return `- ${body}`;
        return `- ${clock.dayText(at)}：${clock.resolveRelative(body, at)}`;
      }).join('\n');
    }
    const exclude = excludeWhere || where || '';
    const recentText = this.memory.renderRecent(recentTurns, { excludeWhere: exclude, personId, excludePhone: true });
    const text = [
      profileText,
      memoryText ? `【长期记忆】\n${memoryText}` : '',
    ].filter(Boolean).join('\n\n');
    return { profileText, memoryText, recentText, entries, text };
  }

  /* ---------- 迁移 / 清空 ---------- */

  /**
   * 把 `people.json.topics`（逐句流水账）转成长期记忆条目，然后清空 topics。
   * 只做一次；已有同人同正文的条目不重复写。
   */
  migrate() {
    if (Number(this.state.schemaVersion) >= 1) return { migrated: 0 };

    const people = this.memory.allPeople();
    const existing = new Set(this.list().map((entry) => `${entry.person}\u0000${entry.body}`));
    let migrated = 0;
    for (const [id, person] of Object.entries(people)) {
      const topics = Array.isArray(person.topics) ? person.topics : [];
      for (const topic of topics) {
        const body = String(topic || '').replace(/\s+/g, ' ').trim().slice(0, 400);
        if (!body) continue;
        if (existing.has(`${id}\u0000${body}`)) continue;
        this.write({
          body,
          kind: 'event',
          person: id,
          scope: 'person',
          source: 'migrated',
          tags: ['migrated'],
          keys: [],
          importance: 2,
        });
        existing.add(`${id}\u0000${body}`);
        migrated += 1;
      }
      if (topics.length) this.memory.setTopics(id, []);
    }
    this.patchState({
      schemaVersion: 1,
      // 旧 turns 不一次性重抽；从今天起往后整理。
      lastExtractedAt: Date.now(),
    });
    if (migrated) this.log.info(`长期记忆：迁移了 ${migrated} 条旧 topics`);
    return { migrated };
  }

  forget() {
    try {
      for (const name of fs.readdirSync(this.memoryDir)) {
        if (!name.endsWith('.md')) continue;
        try { fs.unlinkSync(path.join(this.memoryDir, name)); } catch { /* 跳过 */ }
      }
      for (const name of fs.readdirSync(this.archiveDir)) {
        if (!name.endsWith('.md')) continue;
        try { fs.unlinkSync(path.join(this.archiveDir, name)); } catch { /* 跳过 */ }
      }
      // legacy/ 里的清洗旧档也一起清（否则「忘掉」之后还会留一份）
      const legacyDir = path.join(this.archiveDir, 'legacy');
      for (const name of fs.readdirSync(legacyDir)) {
        if (!name.endsWith('.md')) continue;
        try { fs.unlinkSync(path.join(legacyDir, name)); } catch { /* 跳过 */ }
      }
    } catch { /* 目录还不存在 */ }
    this.cache = null;
    this.indexCache = null;
    this.state = { ...DEFAULT_STATE, schemaVersion: 1, lastExtractedAt: Date.now() };
    store.writeJson(this.stateFile, this.state);
    return this.stats();
  }
}

module.exports = { LongMemory, MEMORY_DIR, ARCHIVE_PREFIX, isMemoryId, parse, serialize };
