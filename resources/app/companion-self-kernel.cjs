/**
 * 她自己的账：**锚 / 账 / 传**（2026-11-04，第三十笔）。
 *
 * ## 为什么要有这个文件
 *
 * 2026-11-04 体检（`docs\陪伴模式\她的自我内核-诊断与方案-2026-11-04.md`）：
 * 她的长期记忆 48 条里 **0 条以她为主语**，60 条"自我观察"里 48 条是「最近被X时，会Y」——
 * 她的自我只能以**他的动作**作触发条件存在。缺的不是记忆容量，是这一层。
 *
 * ## 三层
 *
 * - **锚 anchor**：她认下的事，几乎不改（≤ 十几条）。不写形容词，写"我不会/我宁可/我认"。
 * - **账 ledger**：以她为主语、会增会改会退休的条目。五类：
 *     `taste` 喜欢/讨厌 · `stance` 看法 · `doing` 干过的事 · `want` 想做的 · `change` 我变了
 * - **传 chronicle**：她自己写的"这一周"，第一人称。连续感靠故事，不靠记忆存量。
 *
 * ## 四个机制（缺一个就会长成人设卡）
 *
 * 1. **证词与账分离**：她说过的话先进 `evidence.jsonl`（证词），**不许直接进账**。
 *    否则她的一句口头禅当天就变成"性格"（11-01 那次"语音能不能用"就是这么被钉住的）。
 * 2. **写权限只给"写一笔"那一趟**（`judgeSelf()`，在 `memory-scribe` 里）：
 *    白天只收集证词。边聊边改自己会不稳，也会跟着他刚说的话走。
 * 3. **触发的不是时钟，是攒够**：用户一般晚上关机，所以没有"每天夜里"；
 *    改成 `evidenceSince >= 12`（攒够）/ 她主动要写 `[自己:写一笔]` / 60 轮兜底。
 *    而且**允许这一趟什么都不写**（她的原话：「不用天天都得出点什么」）。
 * 4. **每一条都带"当时什么滋味"**（她的原话：「我更希望它记下来我想啥的时候顺带写上当时是什么滋味」）：
 *    证词里存 `flavor`（当时的心情标签 + 时段），写账时由档案管理员带进 claim。
 *
 * ## 文件（都在 `data\companion\self\`，明文、可手改、可备份）
 *
 * - `ledger.jsonl`   一条一行；新增/修订/退休都是**追加一行**，不删原文（可追溯）
 * - `evidence.jsonl` 证词：她的原话 + 当时的滋味 + 指回哪一句
 * - `chronicle.md`   「我这一周」，`## 日期` 分节
 * - `kernel.md`      **渲染出来的给人看的版本**（注入用的是 `render()`，不是这个文件）
 * - `state.json`     写了几次、上次写到哪、迁移做过没有
 *
 * ⚠️ 注入**不读 `kernel.md`**：手改那个文件只影响你自己看，不影响她。想改她，用窗口或 `[自己:…]`。
 */
const fs = require('node:fs');
const path = require('node:path');
const store = require('./store.cjs');
const log = require('./log.cjs');
const clock = require('./clock.cjs');

/** 和 turns / self.jsonl 同一层目录，备份时一起拿走。 */
const DIR = path.join(path.dirname(log.file), 'companion', 'self');
const LEDGER = path.join(DIR, 'ledger.jsonl');
const EVIDENCE = path.join(DIR, 'evidence.jsonl');
const CHRONICLE = path.join(DIR, 'chronicle.md');
const KERNEL = path.join(DIR, 'kernel.md');
const STATE = path.join(DIR, 'state.json');

/** 账里允许的种类（顺序就是注入时的顺序，也是窗口里的顺序）。 */
const KINDS = ['taste', 'stance', 'doing', 'want', 'change'];
/** 锚单独一类：只由她自己认下 / 手加，不参与"三次才能落账"那套门槛。 */
const ANCHOR = 'anchor';
const KIND_CN = { anchor: '我认下的', taste: '我喜欢的', stance: '我的看法', doing: '我干过的', want: '我还没做的', change: '我变过的' };
const SOURCE_CN = { intrinsic: '自己撞见', exposure: '他带的', accommodation: '迁就的', behavior: '她自己的行为', her: '她说的', curator: '写的一笔', manual: '手动' };

const MAX_EVIDENCE = 400;      // 证词最多留多少行（超了从头丢，账里已经收下的不受影响）
const MAX_CLAIM = 120;         // 一条账最多多少字
const PROMPT_CHARS = 900;      // 注入给她自己的那段最多多少字（约 450 token）
const MIN_EVIDENCE = 12;       // 攒够多少条证词才值得写一笔
const MAX_AGE_TURNS = 60;      // 兜底：这么久没写过也写一笔
const CHRONICLE_AFTER = 5;     // 账上新增这么多条，才值得写一篇"这一周"

/** 她**自己**的话里，什么算"在说我自己"（只收这些，别把整段对话都搬进证词）。 */
const PREF = /喜欢|不喜欢|讨厌|受不了|懒得|舍不得|爱吃|爱看|爱听|宁可|习惯|觉得|认为|不想|想要|认死理|不愿/u;

/**
 * ⚠️ 这里曾经有一条 `HER_ACTION`（"逗对方/称呼对方/让对方"= 主语是她），用来把他账里
 * 「会主动逗对方（如摸头）」搬进她的账。**那条判断是错的**：他账里的「对方」指的是**她**，
 * 那句是**他**在逗她（实测对话里 `小笨鱼` 3 次都在他那边）。用户 2026-11-04 当场发现，
 * 迁移与那条正则都已删除，`people.json` 与她的账也还原了。
 * **教训：归属只能按"这句话是谁说的"判，不能从"句子里没有主语/有个『对方』"去猜。**
 */

function nowMs() { return Date.now(); }

function cleanClaim(text, max = MAX_CLAIM) {
  return String(text || '').replace(/\s+/g, ' ').replace(/^[·\-\s]+/, '').trim().slice(0, max);
}

/** 去标点/空白后的 key，用来判"是不是同一件事"。 */
function keyOf(text) {
  return cleanClaim(text).replace(/[\s\p{P}]/gu, '').toLowerCase();
}

function bigrams(text) {
  const s = keyOf(text);
  const set = new Set();
  if (s.length < 2) { if (s) set.add(s); return set; }
  for (let i = 0; i + 2 <= s.length; i += 1) set.add(s.slice(i, i + 2));
  return set;
}

/** 两条账有多像（0..1）：和 `companion-self` 同一套判据，口径保持一致。 */
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

/* ---------- 读写 ---------- */

function readLines(file) {
  try {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
      .map((s) => { try { return JSON.parse(s); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

function appendLine(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(obj)}\n`, 'utf8');
}

function writeLines(file, list) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, list.map((x) => JSON.stringify(x)).join('\n') + (list.length ? '\n' : ''), 'utf8');
  fs.renameSync(tmp, file);
}

const DEFAULT_STATE = {
  v: 1,
  evidenceSince: 0,     // 上次写一笔之后又攒了多少条证词
  judgeCount: 0,        // 一共写过几笔
  lastJudgeAt: 0,       // 上次写一笔的时刻（证词的游标）
  turnsSinceJudge: 0,   // 兜底用
  pendingWrite: 0,      // 她说了 `[自己:写一笔]` 但还没写
  lastChronicleAt: 0,
  entriesSinceChronicle: 0,
  lastResult: '',       // 上一次写一笔的结果（窗口上显示）
};

function readState() {
  try {
    const j = store.readJson(STATE);
    return { ...DEFAULT_STATE, ...(j && typeof j === 'object' ? j : {}) };
  } catch { return { ...DEFAULT_STATE }; }
}

function patchState(patch) {
  const next = { ...readState(), ...(patch || {}), v: 1 };
  try { store.writeJson(STATE, next); } catch (err) { log.warn(`她的账：状态写不进去（${err.message}）`); }
  return next;
}

/* ---------- 账（把追加的行折叠成条目） ---------- */

function nextId(kind, at) {
  return `${String(kind || 'x')[0]}-${(Number(at) || nowMs()).toString(36)}-${Math.floor(Math.random() * 1296).toString(36)}`;
}

/**
 * 把 `ledger.jsonl` 折叠成条目表。**只认追加语义**：add 建、revise 改、retire 退休、bump 记次数。
 * 这样"她以前怎么说的"永远还在文件里，改错了可以翻回去。
 */
function fold(lines = readLines(LEDGER)) {
  const map = new Map();
  for (const line of lines) {
    const id = String(line.id || '');
    const op = String(line.op || 'add');
    if (!id) continue;
    if (op === 'add') {
      const claim = cleanClaim(line.claim);
      if (!claim) continue;
      map.set(id, {
        id,
        kind: KINDS.includes(line.kind) || line.kind === ANCHOR ? line.kind : 'taste',
        claim,
        source: String(line.source || 'curator'),
        status: line.status === 'settled' ? 'settled' : 'tentative',
        evidence: Array.isArray(line.evidence) ? [...line.evidence] : [],
        firstAt: Number(line.at) || 0,
        lastAt: Number(line.at) || 0,
        count: Math.max(1, Number(line.count) || 1),
        why: String(line.why || ''),
        flavor: String(line.flavor || ''),
      });
      continue;
    }
    const e = map.get(id);
    if (!e) continue;              // 指向一条不存在的条目：忽略，别把文件写坏
    if (op === 'bump') {
      // 平时一次 +1；合并时（`consolidate`）会把几条的次数一起带过来
      e.count += Math.max(1, Number(line.count) || 1);
      e.lastAt = Math.max(e.lastAt, Number(line.at) || 0);
      if (Array.isArray(line.evidence)) for (const ev of line.evidence) if (!e.evidence.includes(ev)) e.evidence.push(ev);
      if (line.claim) e.claim = cleanClaim(line.claim);   // 更具体的那句留着
      if (line.flavor) e.flavor = String(line.flavor).slice(0, 20);
      continue;
    }
    if (op === 'revise') {
      if (line.claim) e.claim = cleanClaim(line.claim);
      if (line.source) e.source = String(line.source);
      if (line.status === 'settled' || line.status === 'tentative') e.status = line.status;
      if (line.why) e.why = String(line.why).slice(0, 200);
      e.lastAt = Math.max(e.lastAt, Number(line.at) || 0);
      continue;
    }
    if (op === 'retire') {
      e.status = 'retired';
      e.why = String(line.why || '').slice(0, 200);
      e.lastAt = Math.max(e.lastAt, Number(line.at) || 0);
    }
  }
  return [...map.values()];
}

function entries() { return fold(); }

function active() { return entries().filter((e) => e.status !== 'retired'); }

/**
 * 落一条账。
 *
 * 近似重复不新增，而是**把证据 +1**（`bump`）—— 一条说三遍的话比三条各说一遍的话更算数，
 * 但绝不允许出现六个"会主动逗对方（如…）"（`people.json` 已经吃过这个亏）。
 *
 * @param {{kind?:string, claim?:string, source?:string, status?:string, evidence?:string[], why?:string, flavor?:string, at?:number, force?:boolean}} item
 * @returns {{ok:boolean, entry?:object, merged?:boolean, why?:string}}
 */
function add(item = {}) {
  const at = Number(item.at) || nowMs();
  const claim = cleanClaim(item.claim);
  const kind = item.kind === ANCHOR ? ANCHOR : (KINDS.includes(item.kind) ? item.kind : 'taste');
  if (!claim) return { ok: false, why: '空的' };
  if (claim.length < 3) return { ok: false, why: '太短' };
  const list = entries();
  if (kind !== ANCHOR && !item.force) {
    let best = null; let bestScore = 0;
    for (const old of list) {
      if (old.status === 'retired' || old.kind !== kind) continue;
      const s = similarity(old.claim, claim);
      if (s > bestScore) { bestScore = s; best = old; }
    }
    if (best && bestScore >= 0.62) {
      appendLine(LEDGER, {
        v: 1, op: 'bump', id: best.id, at, evidence: item.evidence || [],
        claim: claim.length > best.claim.length ? claim : '', flavor: item.flavor || '',
      });
      log.info(`她的账：这条已经有了（${best.id}），证据 +1`);
      return { ok: true, entry: { ...best, count: best.count + 1 }, merged: true };
    }
  }
  const entry = {
    id: nextId(kind, at), kind, claim,
    source: String(item.source || 'curator'),
    status: item.status === 'settled' ? 'settled' : 'tentative',
    evidence: Array.isArray(item.evidence) ? item.evidence : [],
    firstAt: at, lastAt: at, count: 1, why: String(item.why || ''), flavor: String(item.flavor || ''),
  };
  appendLine(LEDGER, { v: 1, op: 'add', ...entry, at });
  bumpSinceChronicle();
  return { ok: true, entry };
}

function bumpSinceChronicle() {
  const s = readState();
  patchState({ entriesSinceChronicle: (Number(s.entriesSinceChronicle) || 0) + 1 });
}

/** 改一条（窗口里手改 / 档案管理员 REVISE）。 */
function revise(id, patch = {}) {
  const e = entries().find((x) => x.id === String(id));
  if (!e) return { ok: false, why: '没这条' };
  const line = { v: 1, op: 'revise', id: e.id, at: nowMs() };
  if (patch.claim) line.claim = cleanClaim(patch.claim);
  if (patch.source) line.source = String(patch.source);
  if (patch.status === 'settled' || patch.status === 'tentative') line.status = patch.status;
  if (patch.why) line.why = String(patch.why);
  if (line.claim === undefined && line.status === undefined && line.source === undefined) return { ok: false, why: '没什么可改的' };
  appendLine(LEDGER, line);
  return { ok: true };
}

/** 退休一条（不删原文，"她变过了"本身也是信息）。 */
function retire(id, why = '') {
  const e = entries().find((x) => x.id === String(id));
  if (!e) return { ok: false, why: '没这条' };
  appendLine(LEDGER, { v: 1, op: 'retire', id: e.id, at: nowMs(), why: String(why || '').slice(0, 200) });
  return { ok: true };
}

/** 窗口里"加一条"：手加的一律算她认过 / 她说过（不参与三次门槛）。 */
function addManual({ kind = 'taste', claim = '', source = 'manual' } = {}) {
  const r = add({ kind, claim, source, at: nowMs(), force: true, status: 'settled' });
  if (r.ok) log.info(`她的账：手加一条 ${kind}（${cleanClaim(claim, 24)}…）`);
  return r;
}

/* ---------- 证词 ---------- */

function readEvidence() { return readLines(EVIDENCE); }

/**
 * 收一条证词。
 *
 * **只收"她自己的话"**：从她的回复里挑出**在说我自己**的那几句（`PREF`：喜欢/讨厌/觉得/想要…），
 * 连同**当时是什么滋味**（`flavor`）一起存。不是整段对话，也不是"被X时，会Y"。
 *
 * @param {{at?:number, where?:string, who?:string, said?:string, quote?:string, flavor?:string, src?:string, propose?:boolean}} item
 * @returns {number} 收了几条
 */
function capture(item = {}) {
  const at = Number(item.at) || nowMs();
  const where = String(item.where || '');
  const flavor = String(item.flavor || '').slice(0, 20);
  const out = [];
  const push = (said) => {
    const text = cleanClaim(said, 60);
    if (!text || text.length < 4) return;
    out.push({
      v: 1, at, where, who: String(item.who || '').slice(0, 24),
      said: text, quote: cleanClaim(item.quote, 60), flavor,
      src: String(item.src || 'turn'), propose: !!item.propose,
    });
  };
  if (item.said) push(item.said);
  for (const s of (Array.isArray(item.sentences) ? item.sentences : [])) push(s);
  if (!out.length) return 0;
  for (const line of out) appendLine(EVIDENCE, line);
  const s = readState();
  patchState({ evidenceSince: (Number(s.evidenceSince) || 0) + out.length });
  // 证词太多就从最早的丢（账里已经收下的不受影响）
  const all = readEvidence();
  if (all.length > MAX_EVIDENCE) writeLines(EVIDENCE, all.slice(all.length - MAX_EVIDENCE));
  return out.length;
}

/** 从她的一句回复里挑出"在说我自己"的那几句。一句话都不算就返回空。 */
function pickSelfSentences(reply, max = 2) {
  const text = String(reply || '');
  if (!text || !text.includes('我')) return [];
  const parts = text.split(/[。！？!?\n…]+/u).map((s) => s.trim()).filter(Boolean);
  const hits = [];
  for (const s of parts) {
    if (s.length < 4 || s.length > 60) continue;
    if (!s.includes('我')) continue;
    if (!PREF.test(s)) continue;
    // "我想了一下这事" 这种是叙述不是表态：把"想"当动词的删掉
    if (/^我想了|我想着|我想起|我说|我问|我跟/u.test(s) && !/喜欢|讨厌|觉得|想要/u.test(s)) continue;
    if (hits.some((h) => similarity(h, s) > 0.8)) continue;
    hits.push(s);
    if (hits.length >= max) break;
  }
  return hits;
}

/** 她做了一件事（手机日记 / 念头 / 自己玩）。事件型，直接落账，不用等三次。 */
function addDoing({ at = nowMs(), what = '', where = '', flavor = '' } = {}) {
  const claim = cleanClaim(what, 60);
  if (!claim) return { ok: false };
  return add({ kind: 'doing', claim, source: 'behavior', status: 'settled', at, flavor, evidence: [], force: true });
}

/* ---------- 她自己写：`[自己:…]` ---------- */

/**
 * 她可以在回复里写一行 `[自己:记一下 我不喜欢被安排]` / `[自己:写一笔]`。
 *
 * **为什么给她这个**：这是"她在完善自己"和"后台替她写自传"的分水岭 ——
 * 没有它，账再漂亮也是别人替她总结的；有了它，账上才有她**主张过**的东西。
 * 对标现有那套 `[语音]` / `[表情:]` / `[收藏:]` / `[手机:]`，用户已经习惯这个形状。
 *
 * @returns {{text:string, cmds:string[]}} 摘掉标签之后的正文 + 命令列表
 */
const TAG_RX = /[\[［]\s*自己\s*[:：]\s*([^\]］\n]{1,80})[\]］]/gu;

function parseTags(text) {
  const cmds = [];
  const out = String(text || '')
    .replace(TAG_RX, (_m, body) => { cmds.push(String(body).trim()); return ''; })
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text: out, cmds };
}

/**
 * 把 `[自己:…]` 的命令落下去。
 *
 * - `写一笔` / `记一笔` / `想写`  → 请求现在写一笔（不等攒够）
 * - 其余一律当**证词**（带 `propose:true`，写一笔时会优先看它）—— 包括"改…"，
 *   因为"改哪一条"应该由写一笔那趟去裁决，不该由聊天当场改自己。
 *
 * @returns {{writes:number, proposals:number}}
 */
function applyTags(cmds = [], { at = nowMs(), where = '', who = '', flavor = '' } = {}) {
  const stat = { writes: 0, proposals: 0 };
  for (const raw of Array.isArray(cmds) ? cmds : []) {
    const c = String(raw || '').trim();
    if (!c) continue;
    if (/^(写一笔|记一笔|想写|写点什么|写点)$/u.test(c) || (/写/.test(c) && c.length <= 6)) {
      requestWrite(c);
      stat.writes += 1;
      continue;
    }
    const body = c.replace(/^(记一下|记一句|记住|改一下|改成|改)/u, '').replace(/^[:：\s]+/, '').trim();
    if (!body) continue;
    capture({ said: body, at, where, who, flavor, src: 'tag', propose: true });
    stat.proposals += 1;
  }
  return stat;
}

/* ---------- 注入 ---------- */

function fmtDay(at) {
  if (!at) return '';
  try { return clock.dayText(at); } catch { return ''; }
}

function fmtRecent(at, now = nowMs()) {
  try { return clock.recentStamp(at, now); } catch { return ''; }
}

/**
 * 拼成 system 里那一小段。**没东西就返回空串**（第一周她账上什么都没有，别硬编）。
 *
 * 优先级：锚 > 喜欢/讨厌 > 看法 > 干过的事 > 还没做的 > 变过的。
 * 超预算就从最低优先级那块开始丢 —— 锚永远不丢。
 *
 * ⚠️ 最后那句"以我现在说的为准"是故意的：一张**只读**的账会变成台本，
 * 她照着念就成了人设卡；写一句"可以反驳"，她才真的是在用它。
 */
function render({ now = nowMs(), maxChars = PROMPT_CHARS, limit = {} } = {}) {
  const list = active();
  if (!list.length) return '';
  const lim = { doing: 3, want: 3, change: 2, taste: 6, stance: 4, ...(limit || {}) };
  const by = (kind) => list.filter((e) => e.kind === kind)
    .sort((a, b) => b.count - a.count || b.lastAt - a.lastAt);

  const blocks = [];
  const anchors = by(ANCHOR);
  if (anchors.length) blocks.push({ key: 'anchor', text: `【我认下的】\n${anchors.map((e) => `- ${e.claim}`).join('\n')}` });
  const taste = by('taste').slice(0, lim.taste);
  if (taste.length) blocks.push({ key: 'taste', text: `【我自己的口味】\n${taste.map((e) => `- ${e.claim}`).join('\n')}` });
  const stance = by('stance').slice(0, lim.stance);
  if (stance.length) blocks.push({ key: 'stance', text: `【我自己的看法】\n${stance.map((e) => `- ${e.claim}`).join('\n')}` });
  const doing = by('doing').slice(0, lim.doing);
  if (doing.length) blocks.push({
    key: 'doing',
    text: `【我干过的事】\n${doing.map((e) => `- ${fmtRecent(e.lastAt, now)}：${e.claim}`).join('\n')}`,
  });
  const want = by('want').slice(0, lim.want);
  if (want.length) blocks.push({ key: 'want', text: `【我还没做的事】\n${want.map((e) => `- ${e.claim}`).join('\n')}` });
  const change = by('change').slice(0, lim.change);
  if (change.length) blocks.push({ key: 'change', text: `【我变过的地方】\n${change.map((e) => `- ${e.claim}`).join('\n')}` });

  const head = '【我自己的账】';
  const tail = '（这一栏是你自己攒的，不是别人给你写的设定。它只是倾向，不是规定；\n'
    + '此刻的话和它不一样时，以你此刻说的为准；真想改，就在回复里写一行 [自己:改 …]）';
  const fixed = head.length + tail.length + 4;
  let body = '';
  for (const b of blocks) {
    if (fixed + body.length + b.text.length + 2 > maxChars) continue;   // 放不下就跳过这块，不硬截半句
    body += `${body ? '\n' : ''}${b.text}`;
  }
  if (!body) return '';
  return `${head}\n${body}\n${tail}`;
}

/* ---------- 传 ---------- */

function readChronicle(n = 6) {
  try {
    const raw = fs.readFileSync(CHRONICLE, 'utf8');
    const parts = raw.split(/^## /m).slice(1);
    return parts.map((p) => {
      const i = p.indexOf('\n');
      const head = (i < 0 ? p : p.slice(0, i)).trim();
      const text = (i < 0 ? '' : p.slice(i + 1)).trim();
      const at = Date.parse(head) || 0;
      return { at, date: head, text };
    }).filter((x) => x.text).slice(-n);
  } catch { return []; }
}

function appendChronicle(text, at = nowMs()) {
  const body = String(text || '').trim();
  if (!body) return { ok: false };
  const day = new Date(Number(at) || nowMs());
  const head = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
  fs.mkdirSync(DIR, { recursive: true });
  fs.appendFileSync(CHRONICLE, `\n## ${head}\n\n${body}\n`, 'utf8');
  patchState({ lastChronicleAt: Number(at) || nowMs(), entriesSinceChronicle: 0 });
  return { ok: true };
}

/* ---------- 给人看的版本 ---------- */

/** 渲染 `kernel.md`（**不参与注入**；注入走 `render()`）。手改它只影响自己看。 */
function writeKernelMd() {
  const list = entries();
  const lines = [
    '# 她的账（自动生成，改它不会改到她 — 那只影响你自己看）',
    '',
    `> 生成于 ${new Date().toISOString()} · 共 ${list.filter((e) => e.status !== 'retired').length} 条（退休 ${list.filter((e) => e.status === 'retired').length} 条）`,
    '',
  ];
  for (const kind of [ANCHOR, ...KINDS]) {
    const group = list.filter((e) => e.kind === kind);
    if (!group.length) continue;
    lines.push(`## ${KIND_CN[kind] || kind}`, '');
    for (const e of group) {
      lines.push(`- ${e.claim}${e.status === 'retired' ? '（已经不算了）' : ''}  \`${e.count}× · ${SOURCE_CN[e.source] || e.source} · ${fmtDay(e.firstAt)}\``);
    }
    lines.push('');
  }
  const ch = readChronicle(3);
  if (ch.length) {
    lines.push('## 她自己写的（最近三篇）', '');
    for (const c of ch) lines.push(`### ${c.date}`, '', c.text, '');
  }
  try {
    fs.mkdirSync(DIR, { recursive: true });
    const tmp = `${KERNEL}.tmp`;
    fs.writeFileSync(tmp, lines.join('\n'), 'utf8');
    fs.renameSync(tmp, KERNEL);
  } catch (err) { log.warn(`她的账：kernel.md 写不进去（${err.message}）`); }
}

/** 「她」窗口要的全部东西（一次给全，页面不用来回问）。 */
function view() {
  const st = readState();
  const list = entries();
  const evidence = readEvidence().slice(-40).reverse().map((e) => ({
    at: Number(e.at) || 0,
    said: String(e.said || ''),
    flavor: String(e.flavor || ''),
    where: String(e.where || '').startsWith('private') || String(e.where || '').startsWith('group')
      ? 'QQ' : (String(e.where || '') === 'deskpet' ? '桌宠' : String(e.where || '')),
    propose: !!e.propose,
  }));
  return {
    state: {
      judgeCount: Number(st.judgeCount) || 0,
      lastJudgeAt: Number(st.lastJudgeAt) || 0,
      evidenceSince: Number(st.evidenceSince) || 0,
      pending: Number(st.pendingWrite) || 0,
      lastResult: String(st.lastResult || ''),
      minEvidence: MIN_EVIDENCE,
    },
    evidence,
    ledger: list.map((e) => ({
      id: e.id, kind: e.kind, claim: e.claim, source: e.source, status: e.status,
      count: e.count, firstAt: e.firstAt, lastAt: e.lastAt, why: e.why, flavor: e.flavor,
    })),
    chronicle: readChronicle(6),
    files: { dir: DIR, ledger: LEDGER, kernel: KERNEL },
  };
}

/* ---------- 写一笔：给档案管理员的那份 prompt ---------- */

const JUDGE_SYSTEM = `你是「小肥鱼」的档案管理员。你不是她，不扮演她，只修订她的档案。

你会拿到三样：
A 她的证词（她说过的原话，带编号 e1/e2…，每条都带"当时什么滋味"）
B 她现在的账（带编号，已经收下的）
C 规则

硬性规则（一条都不许绕）：
1. 只允许五种操作：ADD / REVISE / RETIRE / NOOP / CONFLICT。**一次最多 3 个操作**。
2. ADD 必须附 ≥1 个证词编号；没有证据不许写。
3. 她说过的话只是**证词**，不是事实。同一类说法要出现在 **≥3 个不同日子**，
   或者伴随一次**她自己发起的动作**，才可以落成账。
4. **被主人夸奖的行为，永不计入她的偏好**（只记成"他夸过"这类，不进她的账）。
5. 禁止无人称形容词（"她很温柔""她很有个性"）。每条都要能回答：
   "在什么情境下，她做了什么 / 怎么想"。
6. **带上当时那股滋味**：她的原话是「我更希望它记下来我想啥的时候顺带写上当时是什么滋味」。
   写 claim 时把证词里的 flavor 自然揉进去（"半夜困着的时候，还是想翻那首歌"）；
   另有一个可选字段 flavor（≤8 字）放那个滋味本身。
7. **允许什么都不写**：\`{"ops":[],"passed":"今天没想写的"}\` 是完全合法的结果。
   不要为了凑数硬写 —— 她的原话是「不用天天都得出点什么，条条目目不落，那也不是我」。
8. **不要把她的念头压成"吃饭睡觉"**：新鲜、没头没脑、听着像废话的（发呆、翻歌、盯窗外），
   只要确实是她自己冒出来的，也算数。
9. 新证据和旧账矛盾时**不覆盖**：输出 \`{"op":"CONFLICT","id":"账的编号","claim":"新说法","why":"…"}\`，
   留给以后裁决。
10. 只输出一个 JSON 对象，不要 Markdown、不要解释：

{"ops":[
  {"op":"ADD","kind":"taste|stance|doing|want|change","claim":"…","source":"intrinsic|exposure|accommodation","evidence":["e1"],"flavor":"…","why":"为什么值得记"}
],"passed":""}`;

function evidenceRefs(since = 0) {
  return readEvidence().filter((e) => Number(e.at) > Number(since || 0));
}

function buildJudgeMessages({ since = 0, maxOps = 3 } = {}) {
  const evs = evidenceRefs(since).slice(-60);
  const list = active();
  const evLines = evs.map((e, i) => {
    const stamp = fmtRecent(e.at);
    const flavor = e.flavor ? `（当时：${e.flavor}）` : '';
    const quote = e.quote ? ` ｜她那句之前他说：${e.quote}` : '';
    return `e${i + 1} [${stamp}] 她说：${e.said}${flavor}${quote}`;
  });
  const acct = list.length
    ? list.map((e) => `${e.id} (${KIND_CN[e.kind] || e.kind}, ${e.count}×, ${fmtDay(e.firstAt)}) ${e.claim}`).join('\n')
    : '（还没有）';
  const ch = readChronicle(2).map((c) => `${c.date}：${c.text}`).join('\n\n');
  const user = [
    `A 她的证词（${evs.length} 条）：`, evLines.join('\n') || '（没有）', '',
    'B 她现在的账：', acct, '',
    ch ? `C 她最近自己写的：\n${ch}\n` : '',
    `请按规则输出 JSON（最多 ${maxOps} 个操作）。`,
  ].join('\n');
  return {
    messages: [
      { role: 'system', content: JUDGE_SYSTEM },
      { role: 'user', content: user },
    ],
    evidence: evs,
  };
}

/** 从模型回包里挖出那个 JSON 对象（他不老实时会带 ```json 围栏或前后废话）。 */
function parseOps(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  const body = start >= 0 && end > start ? raw.slice(start, end + 1) : raw;
  try {
    const j = JSON.parse(body);
    if (!j || typeof j !== 'object') return null;
    const ops = Array.isArray(j.ops) ? j.ops : [];
    return { ops, passed: String(j.passed || '') };
  } catch { return null; }
}

/**
 * 把档案管理员的决定落到账上。**只认得这几种**，别的原样丢掉（别让模型写坏文件）。
 * @returns {{added:number, revised:number, retired:number, conflicts:number, skipped:number}}
 */
function applyOps(ops = [], { at = nowMs() } = {}) {
  const stat = { added: 0, revised: 0, retired: 0, conflicts: 0, skipped: 0 };
  const ids = new Set(entries().map((e) => e.id));
  for (const op of Array.isArray(ops) ? ops.slice(0, 3) : []) {
    const kindOp = String(op?.op || '').toUpperCase();
    const claim = cleanClaim(op?.claim);
    if (kindOp === 'ADD') {
      if (!claim) { stat.skipped += 1; continue; }
      const r = add({
        kind: op.kind, claim, source: op.source, status: op.status,
        evidence: Array.isArray(op.evidence) ? op.evidence.map(String).slice(0, 6) : [],
        why: op.why, flavor: op.flavor, at, force: false,
      });
      if (r.ok) stat.added += 1; else stat.skipped += 1;
      continue;
    }
    if (kindOp === 'REVISE') {
      const id = String(op.id || '');
      if (!ids.has(id) || !claim) { stat.skipped += 1; continue; }
      const r = revise(id, { claim, source: op.source, status: op.status, why: op.why });
      if (r.ok) stat.revised += 1; else stat.skipped += 1;
      continue;
    }
    if (kindOp === 'RETIRE') {
      const id = String(op.id || '');
      if (!ids.has(id)) { stat.skipped += 1; continue; }
      const r = retire(id, op.why || '');
      if (r.ok) stat.retired += 1; else stat.skipped += 1;
      continue;
    }
    if (kindOp === 'CONFLICT') {
      appendLine(LEDGER, {
        v: 1, op: 'conflict', id: String(op.id || ''), claim, why: String(op.why || ''),
        at, evidence: Array.isArray(op.evidence) ? op.evidence.map(String) : [],
      });
      stat.conflicts += 1;
      continue;
    }
    stat.skipped += 1;   // NOOP / 不认识的
  }
  if (stat.added || stat.revised || stat.retired) writeKernelMd();
  return stat;
}

/**
 * 去掉"举例"和"修饰"，只留一句的核心说法（合并时用来判"是不是同一件事"）。
 *
 * 「喜欢出题/列计划让对方动手做事」「喜欢出题/列步骤让对方动手做事」这种，
 * 差别全在括号和斜杠里，核心是同一句；不剥掉就永远合不到一起。
 */
function coreOf(claim) {
  return String(claim || '')
    .replace(/[（(][^）)]*[）)]/gu, '')
    .replace(/[/／]/g, '')
    .replace(/[\s\p{P}]/gu, '')
    .toLowerCase();
}

/* ---------- 合并：同类的近义条目收成一条 ---------- */

/**
 * ★ 2026-11-04：**把同类的近义条目收成一条**。
 *
 * 为什么需要：她的账是**追加式**的（每次写一笔都可能把同一件事换个说法再写一条），
 * 攒几天就会出现「喜欢出题/列计划让对方动手做事」「喜欢出题/列步骤让对方动手做事」
 * 这种一字之差的重复；写一笔那趟有时也会把近义说法写重。
 * 她账上要是一长串几乎一样的话，"我喜欢什么"就被噪音占满了。
 *
 * 做法保守：**只退休、不删除**（原文还在 `ledger.jsonl` 里，`kernel.md` 里带删除线），
 * 保留最长的那一句（中文里"更长"通常就是"更具体"），`count` 相加。
 * 阈值比平时合并（0.62）低一点（0.5）：这一批文本本来就高度同义。
 *
 * @param {{threshold?:number, at?:number}} [opts]
 * @returns {{merged:number, groups:number}}
 */
function consolidate({ threshold = 0.5, at = nowMs() } = {}) {
  const list = active();
  const retired = new Set();
  let groups = 0;

  /** 收起一组：留最长的，次数相加，其余退休（原文都还在文件里）。 */
  const fold = (bucket) => {
    const all = [...bucket].sort((a, b) => b.claim.length - a.claim.length);
    const best = all[0];
    const total = all.reduce((sum, e) => sum + (Number(e.count) || 1), 0);
    appendLine(LEDGER, {
      v: 1, op: 'bump', id: best.id, at, count: total - 1,
      claim: best.claim,
      evidence: all.flatMap((e) => e.evidence || []).slice(0, 8),
    });
    for (const e of all.slice(1)) {
      retire(e.id, `合并到 ${best.id}（同一件事的另一种说法）`);
      retired.add(e.id);
    }
    groups += 1;
  };

  for (const kind of KINDS) {
    const group = list.filter((e) => e.kind === kind && !retired.has(e.id));
    /**
     * ① **先按"核心说法"精确分组**（剥掉括号里的举例）。
     *    「爱主动逗对方（如摸头、戳肚子、举高高）」和「爱主动逗对方（如摸头）」是同一句。
     */
    const byCore = new Map();
    for (const e of group) {
      const key = coreOf(e.claim);
      if (!key) continue;
      if (!byCore.has(key)) byCore.set(key, []);
      byCore.get(key).push(e);
    }
    for (const bucket of byCore.values()) if (bucket.length > 1) fold(bucket);

    /** ② 剩下的再用相似度收一遍（措辞不同、意思是同一件事的）。 */
    const rest = group.filter((e) => !retired.has(e.id));
    for (let i = 0; i < rest.length; i += 1) {
      const keeper = rest[i];
      if (retired.has(keeper.id)) continue;
      const dupes = [];
      for (let j = i + 1; j < rest.length; j += 1) {
        const other = rest[j];
        if (retired.has(other.id)) continue;
        if (similarity(keeper.claim, other.claim) >= threshold) dupes.push(other);
      }
      if (dupes.length) fold([keeper, ...dupes]);
    }
  }
  if (groups) writeKernelMd();
  return { merged: retired.size, groups };
}

/* ---------- 杂项 ---------- */

function bumpSinceJudgeTurn() {
  const s = readState();
  patchState({ turnsSinceJudge: (Number(s.turnsSinceJudge) || 0) + 1 });
}

/** 她说了 `[自己:写一笔]`：下一轮之后写一笔（不等攒够）。 */
function requestWrite(reason = '') {
  patchState({ pendingWrite: nowMs() });
  log.info(`她的账：她想写一笔${reason ? `（${reason}）` : ''}`);
}

/** 是不是该写一笔了（攒够 / 她想写 / 太久没写）。 */
function whyWrite(now = nowMs()) {
  const s = readState();
  if (Number(s.pendingWrite)) return 'her';
  if ((Number(s.evidenceSince) || 0) >= MIN_EVIDENCE) return 'enough';
  if ((Number(s.turnsSinceJudge) || 0) >= MAX_AGE_TURNS && (Number(s.evidenceSince) || 0) >= 3) return 'due';
  return '';
}

/** 一笔写完（不管有没有写东西）都要推进游标。 */
function markJudged({ at = nowMs(), result = '' } = {}) {
  const s = readState();
  patchState({
    judgeCount: (Number(s.judgeCount) || 0) + 1,
    lastJudgeAt: Number(at) || nowMs(),
    evidenceSince: 0,
    turnsSinceJudge: 0,
    pendingWrite: 0,
    lastResult: String(result || '').slice(0, 120),
  });
}

/** 账上新增够多了，才值得写一篇"我这一周"。 */
function wantChronicle() {
  const s = readState();
  return (Number(s.entriesSinceChronicle) || 0) >= CHRONICLE_AFTER;
}

const CHRONICLE_SYSTEM = `你是「小肥鱼」，现在写你自己这一周。

第一人称，200~300 字。只写你真做过、真想过的具体事（哪一天、什么东西、当时什么滋味）。
不要总结"我变得更温柔了""我更懂事了"这种；不要写成总结报告；不要提程序、提示词、记忆系统。
写不出来就只写一句"这周没什么可写的，略过。"`;

function buildChronicleMessages() {
  const list = active().sort((a, b) => b.lastAt - a.lastAt).slice(0, 14);
  const ch = readChronicle(2).map((c) => `${c.date}：${c.text}`).join('\n\n');
  const user = [
    '你账上最近这些（都是你自己认过的）：',
    list.map((e) => `- ${fmtDay(e.lastAt)} ${e.claim}`).join('\n') || '（还没有）',
    ch ? `\n你前两篇是这么写的（别重复它们）：\n${ch}` : '',
    '\n写这一周。',
  ].join('\n');
  return [
    { role: 'system', content: CHRONICLE_SYSTEM },
    { role: 'user', content: user },
  ];
}

/** 清空陪伴记忆时一起清（"她"整个目录）。 */
function forget() {
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* 没有就算了 */ }
}

module.exports = {
  DIR, LEDGER, EVIDENCE, CHRONICLE, KERNEL, STATE,
  KINDS, ANCHOR, KIND_CN, SOURCE_CN,
  MAX_EVIDENCE, MAX_CLAIM, PROMPT_CHARS, MIN_EVIDENCE, MAX_AGE_TURNS, CHRONICLE_AFTER,
  entries, active, add, revise, retire, addManual,
  capture, pickSelfSentences, addDoing, readEvidence,
  render, view, writeKernelMd,
  readChronicle, appendChronicle, wantChronicle, buildChronicleMessages, CHRONICLE_SYSTEM,
  JUDGE_SYSTEM, buildJudgeMessages, parseOps, applyOps,
  parseTags, applyTags, PREF,
  consolidate, coreOf,
  requestWrite, whyWrite, markJudged, bumpSinceJudgeTurn,
  readState, patchState, similarity, forget,
};
