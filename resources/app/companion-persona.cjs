/**
 * 同一个她的**只读人格源**（2026-11-07，第三十一笔）
 *
 * ## 为什么要有这个文件
 *
 * 用户的原话（11-07 22:20）：
 *   「不管换操作员还是记忆分层，我只希望玩手机的是她，这样她有机会向我分享。」
 *
 * 真机上现在有**三套上下文**：
 *   · 聊天 —— `roleText + selfKernel + 人物账 + 长期记忆 + recent`（完整她）；
 *   · 手机计划 —— 硬编码「你叫小肥鱼，是个普通人」+ `config.phone.taste`（第二个人格）；
 *   · 手机操作员 —— 硬编码「你叫小肥鱼，只管动手机」+ 同一份 `taste`（第三套）。
 * 所以"手机里的她"和"跟他聊天的她"根本不是一个人：手机上想玩什么、什么时候停、
 * 看到什么值得说，全都不经过她自己的账。
 *
 * 这个文件只做一件事：**从她自己的账里取一份只读快照，切成方向一致的四个视图**。
 * 它**没有任何写入口** —— 不碰 `role` / `self` / `mind` / `diary` / `people` / `memory`，
 * 也不碰 `turns.jsonl`。手机那边的"手"只能拿到 `handView`（紧凑、没有人格），
 * 决定"想玩什么 / 停不停 / 说什么"的永远是 `planView` / `judgeView` / `voiceView`。
 *
 * ## 三种 hash 各管一件事
 *
 * - `personaId = hash(roleText + 锚)`        —— 跨会话稳定，"还是不是她"看它；
 * - `coreHash  = hash(锚 + 口味 + 看法)`    —— 只算**稳定身份**，不许算 doing/want/change/mood，
 *                                              否则她每玩一次、变一次心情就"换一个人"；
 * - `contextHash = hash(doing + want + change + mood + focus + session + lastScreen)`
 *                                             —— 只确认"这次看到的是不是同一份上下文"，不参与身份判定。
 *
 * 四视图（plan / hand / judge / voice）都从**同一份 `Object.freeze` 快照**派生。
 * 调用方每一轮聊天 / 每一场手机会话**只取一次**，之后一路传下去。
 * `assertSame()` 在每次模型调用前重算一遍；对不上就拒绝这次手机决策（上层退回"不动"），
 * 宁可什么都不做，也不让另一个人格顶上去。
 */

'use strict';

const crypto = require('node:crypto');

/** 快照结构变了就 +1：老快照会被当成"不是同一代"，不会混着用。 */
const VERSION = 1;
/** 视图名（只在日志和断言里用）。 */
const VIEWS = ['plan', 'hand', 'judge', 'voice'];

function norm(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

function hash(parts) {
  return crypto.createHash('sha256').update(parts.join('\u0001')).digest('hex').slice(0, 16);
}

/** 深冻结：快照传出去以后谁也别想改它（视图都从它派生）。 */
function deepFreeze(obj) {
  if (!obj || typeof obj !== 'object' || Object.isFrozen(obj)) return obj;
  for (const key of Object.keys(obj)) deepFreeze(obj[key]);
  return Object.freeze(obj);
}

/** 某类账按"说过几次 / 最近说过"排；hash 用的时候会再按字面排序，不吃次数。 */
function claimsOf(list, kind, max) {
  return list
    .filter((e) => e && e.kind === kind && e.claim && e.status !== 'retired')
    .sort((a, b) => (Number(b.count) || 0) - (Number(a.count) || 0) || (Number(b.lastAt) || 0) - (Number(a.lastAt) || 0))
    .slice(0, Math.max(0, Number(max) || 0))
    .map((e) => norm(e.claim));
}

/**
 * 取一份只读人格快照。
 *
 * @param {object} o
 * @param {string} [o.roleText]        `config/companion-role.md`（角色卡）**原文**
 * @param {Array}  [o.entries]         `selfKernel.active()` 的条目（只读）
 * @param {object} [o.mood]            `mood.snapshot()`
 * @param {object} [o.phone]           `phone-life.state()`（focus / session / recent）
 * @param {string} [o.tasteFallback]   `config.phone.taste` —— **只在她的账里一条口味都没有时兜底**
 * @param {string} [o.lastScreen]      `PhoneAgent.lastScreen`（她手机现在停在哪一屏）
 * @param {number} [o.at]
 * @returns {object} 冻结的快照（personaId / coreHash / contextHash 都在里面）
 */
function snapshot({ roleText = '', entries = [], mood = null, phone = null, tasteFallback = '', lastScreen = '', at = Date.now() } = {}) {
  const list = Array.isArray(entries) ? entries.filter((e) => e && e.claim) : [];
  const anchors = claimsOf(list, 'anchor', 12);
  const tasteSelf = claimsOf(list, 'taste', 6);
  const stance = claimsOf(list, 'stance', 4);
  const doing = claimsOf(list, 'doing', 5);
  const want = claimsOf(list, 'want', 3);
  const change = claimsOf(list, 'change', 2);
  /**
   * ★ `config.phone.taste` **不是第二个人格源**：她的账里只要有口味，就一个字都不用 config。
   * 只有她的账一条都没有（新装、还没写过一笔）时，才拿它兜底，并在日志里标 `fallback`。
   */
  const fallback = norm(tasteFallback);
  const taste = tasteSelf.length ? tasteSelf : (fallback ? [fallback] : []);
  const tasteSrc = tasteSelf.length ? 'self' : (fallback ? 'config-fallback' : 'none');

  const role = norm(roleText);
  /** 身份只认"角色卡 + 她认下的事"；顺序按字面排，次数/时间不参与，免得每次玩完就漂。 */
  const identityParts = [role, ...[...anchors].sort()];
  const personaId = hash([String(VERSION), 'persona', ...identityParts]);
  const coreHash = hash([
    String(VERSION), 'core',
    ...[...anchors].sort(), ...[...taste].sort(), ...[...stance].sort(),
  ]);
  const contextHash = hash([
    String(VERSION), 'context',
    ...[...doing].sort(), ...[...want].sort(), ...[...change].sort(),
    String(mood?.state || ''), norm(phone?.focus?.text || phone?.focusText || ''),
    String(phone?.session?.id || ''), String(lastScreen || phone?.lastScreen || ''),
  ]);

  const moodOut = mood && typeof mood === 'object'
    ? {
      state: String(mood.state || ''),
      label: String(mood.label || ''),
      love: Number(mood.love) || 0,
      energy: Number(mood.energy) || 0,
      intensity: Number(mood.intensity) || 0,
    }
    : { state: '', label: '', love: 0, energy: 0, intensity: 0 };

  const recent = Array.isArray(phone?.recent) ? phone.recent.slice(-5) : [];
  const phoneOut = {
    mode: String(phone?.mode || ''),
    focusText: norm(phone?.focus?.text || ''),
    focus: phone?.focus && typeof phone.focus === 'object'
      ? { text: norm(phone.focus.text || ''), kind: String(phone.focus.kind || ''), got: Number(phone.focus.got) || 0, goal: Number(phone.focus.goal) || 0, done: !!phone.focus.done }
      : null,
    session: phone?.session && typeof phone.session === 'object'
      ? { id: String(phone.session.id || ''), theme: String(phone.session.theme || ''), idx: Number(phone.session.idx) || 0, of: Number(phone.session.of) || 0, pauses: !!phone.session.paused }
      : null,
    diary: recent.map((d) => ({
      theme: String(d?.theme || ''),
      did: Array.isArray(d?.did) ? d.did.map((x) => String(x)).slice(0, 4) : [],
      ok: Number(d?.ok) || 0,
      fail: Number(d?.fail) || 0,
      note: norm(d?.note || ''),
      at: Number(d?.at) || 0,
    })),
    lastScreen: norm(lastScreen || phone?.lastScreen || ''),
  };

  const snap = {
    version: VERSION,
    at: Number(at) || Date.now(),
    personaId,
    coreHash,
    contextHash,
    roleText: role,
    core: { anchors, taste, stance, doing, want, change, tasteSrc },
    mood: moodOut,
    phone: phoneOut,
    /** 断言用：从快照自己重算身份，跟这两个对不上就是漂了。 */
    identity: { personaId, coreHash, version: VERSION },
  };
  return deepFreeze(snap);
}

/** 从快照**重算**身份（不信它里面那个字段）。 */
function identityOf(snap) {
  if (!snap || typeof snap !== 'object') return { personaId: '', coreHash: '' };
  const core = snap.core || { anchors: [], taste: [], stance: [] };
  const anchors = [...(core.anchors || [])];
  const taste = [...(core.taste || [])];
  const stance = [...(core.stance || [])];
  return {
    personaId: hash([String(snap.version), 'persona', norm(snap.roleText), ...[...anchors].sort()]),
    coreHash: hash([String(snap.version), 'core', ...[...anchors].sort(), ...[...taste].sort(), ...[...stance].sort()]),
  };
}

/**
 * 四视图共用的身份断言：**同一份快照，四个方向必须是同一个人**。
 *
 * 不抛异常 —— 返回 `{ok, why}`。上层拿到 `ok:false` 就**拒绝这次手机决策**
 * （plan 退回兜底牌、judge 退回"再翻"、hand 不动），绝不换一个人顶上。
 *
 * @param {object} snap
 * @param {string} [view]
 * @returns {{ok:boolean, why:string, personaId:string, coreHash:string}}
 */
function checkSame(snap, view = '') {
  if (!snap || typeof snap !== 'object' || !snap.identity) {
    return { ok: false, why: `${view || '?'} 没有只读人格快照`, personaId: '', coreHash: '' };
  }
  if (Number(snap.version) !== VERSION) {
    return { ok: false, why: `${view || '?'} 快照版本不对（${snap.version}）`, personaId: '', coreHash: '' };
  }
  const now = identityOf(snap);
  const ok = now.personaId === snap.identity.personaId && now.coreHash === snap.identity.coreHash;
  return {
    ok,
    why: ok ? '' : `${view || '?'} 的人格漂了（persona ${snap.identity.personaId}→${now.personaId} / core ${snap.identity.coreHash}→${now.coreHash}）`,
    personaId: now.personaId,
    coreHash: now.coreHash,
  };
}

function assertSame(snap, view = '') {
  const r = checkSame(snap, view);
  if (!r.ok) throw new Error(`同一个她：${r.why}`);
  return r;
}

/* ------------------------------------------------------------ 四个视图 */

/** 一行字：她在手机上"现在"。voice / plan 都用得着。 */
function phoneLine(snap) {
  const p = snap?.phone || {};
  const bits = [];
  if (p.session?.id) {
    const themes = { album: '翻相册', collect: '挑图', browse: '随便逛' };
    bits.push(`你正玩着（${themes[p.session.theme] || p.session.theme || '玩手机'}，第 ${(p.session.idx || 0) + 1}/${p.session.of || '?'} 件）`);
  } else if (p.focusText) {
    bits.push(`你手上还惦记着：${p.focusText}`);
  }
  if (p.lastScreen) bits.push(`手机刚停在：${p.lastScreen}`);
  return bits.join('；');
}

/**
 * **planView**：交给 `CompanionBrain.planPhone`。
 * 读：完整角色卡 + 她自己的账（锚/口味/看法/干过/想做/变过）+ 心情 + 焦点/日记/便签。
 * 不读：聊天流水、手机进度行、旧页、动作表。
 */
function planView(snap, { at = Date.now(), hint = '', menu = '', diary = [], notes = '', focus = null, nightLite = false } = {}) {
  const core = snap.core;
  const mood = snap.mood;
  const when = new Date(Number(at) || Date.now()).toLocaleString('zh-CN', { hour12: false });
  const account = [
    core.anchors.length ? `【我认下的】\n${core.anchors.map((x) => `- ${x}`).join('\n')}` : '',
    core.taste.length ? `【我自己的口味】\n${core.taste.map((x) => `- ${x}`).join('\n')}` : '',
    core.stance.length ? `【我自己的看法】\n${core.stance.map((x) => `- ${x}`).join('\n')}` : '',
    core.doing.length ? `【我干过的事】\n${core.doing.map((x) => `- ${x}`).join('\n')}` : '',
    core.want.length ? `【我还没做的事】\n${core.want.map((x) => `- ${x}`).join('\n')}` : '',
    core.change.length ? `【我变过的地方】\n${core.change.map((x) => `- ${x}`).join('\n')}` : '',
  ].filter(Boolean).join('\n');

  const focusLine = (focus && !focus.done && focus.text)
    ? `你心里惦记着一件事：${focus.text}（已经做了 ${Number(focus.got) || 0} 次）——但这趟只办里面一小件。`
    : (snap.phone.focusText && !snap.phone.focus?.done
      ? `你心里惦记着一件事：${snap.phone.focusText}`
      : '你手上暂时没有非做不可的事');
  const did = (Array.isArray(diary) ? diary : []).slice(-3);
  const diaryLine = did.length
    ? `最近去过的：${did.map((d) => `${d.app || d.theme || '玩手机'}（成 ${Number(d.ok) || 0} / 败 ${Number(d.fail) || 0}）`).join('、')}`
    : '最近还没自己玩过';
  const notesLine = notes ? `你手机便签上写着：${notes}` : '';

  const system = [
    snap.roleText,
    account,
    `【现在】${when}。心情：${mood.label || '安静'}（${mood.state || '平常'}）。`,
    '【你在做什么】你想用自己的手机待一会儿。**去哪儿、干什么、看什么，都是你自己定**，不是别人派的活。',
    '按你自己的性子来：想起一个词就搜搜看，惦记一件事就翻翻，想写两句就写，没意思就换。不用讨好谁，也不用把"任务"做完。',
    menu ? `手机上装着这些（只是告诉你有什么，去哪由你挑，也可以去表里没有的 App）：\n${menu}` : '',
    nightLite ? '（这会儿晚了：只看看、别折腾，不搜长东西、不看视频。）' : '',
    '你自己的日记可以写、可以删（连着删两篇以上要跟他说一声）；别的先看清楚这一屏是什么，再决定。',
    '会闯祸的事你自己心里有数：装东西、付钱、登录账号、把话发出去、删别人的东西——看清了再动手，拿不准就先不做。',
    '输出**一行 JSON**，别的字都不要。格式：',
    '{"app":"想去哪个 App（中文名）","goal":"这一趟具体想干什么（你自己的一句话）","query":"要搜的词（没有就空着）","url":"知道的网址（没有就空着）","why":"你为什么想去（第一人称，一句）","stopCriteria":"什么样就算够了 / 该走了","shareCriteria":"看到什么样的东西你会想跟他说","ask":"随口跟他说的一句，20字以内"}',
    '**不想去就不去**：这时候只输出 `{"skip":true,"why":"为什么这会儿不想去"}`，别硬编一件事。',
    '`ask` 是**你随口问他一句**，不是申请：像"我去B站翻两眼啊""想搜个东西，行吗"。不要复述 goal 的全文，不要说"我来帮你/为您"，不要写"是否""需要我"。',
    '`goal` 只写**一趟里的那件事**，10 步之内能办完、办完能看出来办没办成；不要"随便看看有什么好玩的"这种没有落点的话。',
    '`stopCriteria` 和 `shareCriteria` 要写成你自己的判断（"翻三条都没讲到上色就走""看到跟我像的图就想给他看"），不要写"完成后停止"。',
    '不许写手机上做不到的事（存档、统计、比较、算数）。',
  ].filter(Boolean).join('\n\n');

  const user = [
    focusLine,
    diaryLine,
    notesLine,
    hint ? `（这次心里偏向：${hint}）` : '',
    '只输出那一行 JSON。',
  ].filter(Boolean).join('\n');

  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

/**
 * **handView**：交给 `PhoneAgent` 的**紧凑 brief**。
 * 读：1~2 条锚 + 3 条口味 + 1 条看法 + 心情标签 + 这一件的目标/为什么/什么时候停/想分享什么。
 * 不读：完整角色卡、self 全量、聊天历史、旧页、`config.phone.taste`。
 *
 * ⚠️ 它是**手**，不是她。给它人格只给到"挑哪个"这一层，不给"怎么说话"。
 */
function handView(snap, { brief = null } = {}) {
  const core = snap?.core || {};
  const anchors = (core.anchors || []).slice(0, 2);
  const taste = (core.taste || []).slice(0, 3);
  const stance = (core.stance || []).slice(0, 1);
  const b = brief && typeof brief === 'object' ? brief : {};
  const lines = ['【她是谁（只用来挑，不用来说）】'];
  if (anchors.length) lines.push(`她认下的：${anchors.join('；')}`);
  if (taste.length) lines.push(`她的口味：${taste.join('；')}`);
  if (stance.length) lines.push(`她的看法：${stance[0]}`);
  if (snap?.mood?.label) lines.push(`她这会儿：${snap.mood.label}`);
  if (b.goal) lines.push(`【这一件】${b.goal}`);
  if (b.why) lines.push(`【她为什么想做】${b.why}`);
  if (b.stopCriteria) lines.push(`【她觉得够了】${b.stopCriteria}`);
  if (b.shareCriteria) lines.push(`【她会想跟他说】${b.shareCriteria}`);
  if (b.src === 'session') {
    lines.push('（这是她自己想玩的：按她的性子挑，不一定要做完。）');
    /**
     * ★ 2026-11-12：**点不点由她判断**，但得让她知道后果 —— 不是替她拦，是让她看得见。
     * 旧版这里一个字都没有，靠 `phone-safe` 那种词表拦；词表会把她自己日记的「删除」也拦掉。
     */
    lines.push('手机上有几件事做了收不回来：装东西、付钱、登录账号、把话发出去、删别人的东西——看清楚这一屏是什么再点。');
    lines.push('你自己的日记可以写、可以删（连着删两篇以上要跟他说一声）；别的拿不准就先不做。');
  }
  return lines.join('\n');
}

/**
 * **judgeView**：滚动时"这一屏值不值得停"。
 * 读：3 条口味 + 1 条看法 + 她自己的 stopCriteria + 这一屏的内容。
 * 不读：通用"猫 / 小动物 / 吃的"词表（那是另一个人的判断）。
 */
function judgeView(snap, { goal = '', screen = '', stopCriteria = '', verdict = true } = {}) {
  const core = snap?.core || {};
  const taste = (core.taste || []).slice(0, 3);
  const stance = (core.stance || []).slice(0, 1);
  return [
    `她自己的口味：${taste.length ? taste.join('；') : '（还没写过）'}`,
    stance.length ? `她的看法：${stance[0]}` : '',
    goal ? `她这一趟想做的：${goal}` : '',
    stopCriteria ? `她自己说过，看到这些就够了：${stopCriteria}` : '',
    screen ? `这一屏：${String(screen).replace(/\s+/g, ' ').slice(0, 300)}` : '',
    /**
     * ★ 2026-11-07：`verdict:false` 时只给"她的口径"，不追加"停/再翻"那句 ——
     * 刷视频那条路的输出是 JSON（`{"gist","like","next"}`），别被这句带偏。
     */
    verdict ? '判断：这一屏有没有**她自己会想停下来看**的东西（她的口味 / 她想做的事 / 她自己说的"够了"）？' : '',
    verdict ? '普通列表、广告、导航栏、看不清楚的图，一律回「再翻」。' : '',
    verdict ? '只回一个词：停 / 再翻' : '',
  ].filter(Boolean).join('\n');
}

/**
 * **voiceView**：回灌 / 提案 / 问屏时，给她一句"手机现在什么样"。
 * 读：完整人格（由 brain 的 role/self/memory 那边给）+ 手机现状。
 * 不读：动作语法、operator 工具提示。
 */
function voiceView(snap, { screen = '', extra = '' } = {}) {
  const p = snap?.phone || {};
  const bits = [];
  const line = phoneLine(snap);
  if (line) bits.push(line);
  if (screen) bits.push(`屏幕上：${String(screen).replace(/\s+/g, ' ').slice(0, 260)}`);
  if (extra) bits.push(String(extra).trim());
  return bits.length ? `【你手机那边】${bits.join('；')}` : '';
}

/** 只读的摘要（日志 / 自检 / 页面用；不含原文）。 */
function digest(snap) {
  if (!snap) return { personaId: '', coreHash: '', contextHash: '', tasteSrc: 'none' };
  return {
    personaId: snap.personaId,
    coreHash: snap.coreHash,
    contextHash: snap.contextHash,
    tasteSrc: snap.core?.tasteSrc || 'none',
    anchors: (snap.core?.anchors || []).length,
    taste: (snap.core?.taste || []).length,
    stance: (snap.core?.stance || []).length,
    mood: snap.mood?.label || '',
    session: snap.phone?.session?.theme || '',
  };
}

/** 从模型那一坨里抠出第一个 JSON 对象（和 `phone-life.pickJson` 同一套，避免两处走样）。 */
function pickJson(text) {
  const src = String(text || '').replace(/```[a-zA-Z]*\s*/g, '').replace(/```/g, '');
  const start = src.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) {
        try { return JSON.parse(src.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

module.exports = {
  VERSION,
  VIEWS,
  snapshot,
  identityOf,
  checkSame,
  assertSame,
  phoneLine,
  planView,
  handView,
  judgeView,
  voiceView,
  digest,
  pickJson,
};
