/**
 * 自主说话 —— **她想不想开口**的那一层。
 *
 * 以前是"每隔一阵看一眼能不能说"（桌宠那边一分钟一次），到点了模型就得硬找一句话，
 * 说出来的是"在干嘛呢"这种模板。用户的原话是"想说就说，不想说不说，隔几分钟甚至
 * 半小时再想开口都可以"。所以这里把**三件事**拆开（另外两件在别处）：
 *
 *   ① 她心里有没有事 —— `companion-mind.cjs` 的念头池；
 *   ② 此刻想不想说   —— **本文件**：念头的动机分 × 沉默越久越想说的系数；
 *   ③ 现在合不合适   —— 本文件的闸门：刚聊完、上次没回、深夜、每小时上限。
 *
 * 关键的一条：**沉默越久，同一个念头的分越高**。于是"隔几分钟"和"隔半小时"不是抽签，
 * 而是"她真的没什么想说的" —— 长间隔是结果，不是设定。
 *
 * 这个文件是**纯状态机**：
 *   · 不读盘、不写盘（持久化由 `companion.cjs` 调 `serialize()` / `hydrate()`）；
 *   · 不看真实时钟（每次都把 `at` 传进来），所以自检可以用假时钟推一整天；
 *   · 不调模型、不发 QQ。`decide()` 只说"能不能说、说哪条"，说什么是别人的事。
 */

/**
 * 频率三档 → 动机门槛。门槛越高，她越少开口（这是设置页那个"少/中/多"）。
 *
 * 为什么是这几个数（自检里也按这个算）：一条"有点想说"（动机 3）的念头，
 * 中档 3.8 需要静默约 12 分钟才够（3 × 1.02^12 ≈ 3.8）；动机 2 要半小时，
 * 动机 1 基本等不到（60 分钟就过期了）。所以**长间隔 = 她真的没什么想说的**。
 */
const FREQUENCY = { low: 4.4, normal: 3.8, high: 3.1 };

const MIN = 60_000;
const HOUR = 60 * MIN;

/** 每档默认值：老配置没有 `presence` 段也能跑。 */
const DEFAULTS = {
  enabled: true,
  frequency: 'normal',
  /** 她醒着的时段（本地小时，可以跨零点）。这个点之外只有"留言"能出去。 */
  activeHours: [8.5, 23.5],
  /** 深夜允许留言：一晚最多一条，而且得是真憋不住（动机 ≥ 4.5）。 */
  nightMessage: true,
  /** 两次开口之间至少隔这么久（含回复）。 */
  minGapSec: 120,
  /** 对方刚说完话，先安静这么久，让对话自然收尾。 */
  afterUserMin: 3,
  /** 连续几条主动都没被回，就退避到对方先开口。 */
  maxUnanswered: 2,
  /** 每沉默一分钟，动机乘这个数（1.02 → 一小时 ×3.3，但最多乘到 `maxSilenceBoost`）。 */
  silenceBoostPerMin: 1.02,
  /**
   * 沉默加成封顶。为什么要有：没有封顶的话，"随口一提"（动机 1）的念头在沉默两小时后
   * 也会被乘到门槛以上 —— 那就退化成"为了说话而说话"了。2.2 的意思是：
   * 动机 1 永远不说，动机 2 要沉默半小时以上，动机 3 十几分钟就够。
   */
  maxSilenceBoost: 2.2,
  /** 每小时 / 每天最多主动几次（防跑飞）。 */
  maxPerHour: 2,
  maxPerDay: 18,
};

/** 日志/设置页里的人话。 */
const WHY = {
  off: '没开',
  'no-target': '还不知道该跟谁说',
  'after-user': '对方刚说完话',
  'min-gap': '刚说过',
  ignored: '上次主动他没回，先不说了',
  night: '这个点她在安静',
  'hour-budget': '这一小时说得够多了',
  'day-budget': '今天说得够多了',
  'no-thought': '心里没什么事',
  low: '有念头，但还没到想说的时候',
};

function num(v, fallback, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** 整理一份配置：缺字段、填错了都在这里兜住。 */
function normalizeCfg(raw = {}) {
  const c = { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) };
  const hours = Array.isArray(c.activeHours) && c.activeHours.length === 2
    ? c.activeHours.map(Number)
    : DEFAULTS.activeHours;
  return {
    enabled: c.enabled !== false,
    frequency: FREQUENCY[c.frequency] ? c.frequency : 'normal',
    activeHours: hours.every(Number.isFinite) ? hours : DEFAULTS.activeHours,
    nightMessage: c.nightMessage !== false,
    minGapSec: num(c.minGapSec, DEFAULTS.minGapSec, 0, 3600),
    afterUserMin: num(c.afterUserMin, DEFAULTS.afterUserMin, 0, 180),
    maxUnanswered: num(c.maxUnanswered, DEFAULTS.maxUnanswered, 1, 10),
    silenceBoostPerMin: num(c.silenceBoostPerMin, DEFAULTS.silenceBoostPerMin, 1, 1.2),
    maxSilenceBoost: num(c.maxSilenceBoost, DEFAULTS.maxSilenceBoost, 1, 10),
    maxPerHour: num(c.maxPerHour, DEFAULTS.maxPerHour, 0, 60),
    maxPerDay: num(c.maxPerDay, DEFAULTS.maxPerDay, 0, 500),
    mindEveryMin: num(c.mindEveryMin, 30, 1, 24 * 60),
    mindMax: num(c.mindMax, 6, 1, 20),
  };
}

/** 现在算不算"她醒着"；支持 [22, 7] 这种跨零点。 */
function inActiveHours(hour, [from, to] = DEFAULTS.activeHours) {
  if (!Number.isFinite(hour)) return true;
  if (!Number.isFinite(from) || !Number.isFinite(to) || from === to) return true;
  return from < to ? (hour >= from && hour < to) : (hour >= from || hour < to);
}

/** 一天里的哪一段（给"刚睡醒/该睡了"这种语感用）。 */
function partOfDay(hour) {
  if (hour < 5) return '深夜';
  if (hour < 8.5) return '清早';
  if (hour < 11) return '上午';
  if (hour < 13.5) return '中午';
  if (hour < 17.5) return '下午';
  if (hour < 22) return '晚上';
  return '深夜';
}

/**
 * 沉默越久越想说话，但夜里/刚被晾着的时候会打个折。
 *
 * ★ 2026-11-01：`awake` 是她自己定的醒着时段。以前不管醒没醒，凌晨 0~5 点都乘 0.5；
 * 默认时段（8.5~23.5）下这没问题，但"醒着 0~24 点"（自检/夜猫子配置）就会在
 * 凌晨把分数压到 2.5，自检在半夜跑就红。醒着的时候不再打折，晚上该有的加成照旧。
 */
function contextMult(hour, unanswered, awake = false) {
  const raw = hour < 5 ? 0.5 : hour < 8.5 ? 0.85 : hour < 17.5 ? 1 : hour < 22 ? 1.1 : 0.9;
  const byTime = awake ? Math.max(1, raw) : raw;
  const byUnanswered = unanswered >= 1 ? 0.55 : 1;
  return byTime * byUnanswered;
}

/**
 * 她此刻想不想说话的"大脑"。
 *
 * @param {object} opts
 * @param {object|Function} [opts.cfg]  配置，或返回配置的函数（设置页保存后立刻生效）
 * @param {Function} [opts.now]         取当前时间（自检注入假时钟）
 * @param {Function} [opts.rng]         0..1 随机数（自检注入固定值）
 */
function createPresence({ cfg: readCfg = {}, now = Date.now, rng = Math.random } = {}) {
  const getCfg = typeof readCfg === 'function' ? readCfg : () => readCfg;
  const conf = () => normalizeCfg(getCfg());
  /** 每个会话一本小账：上次对方说话、上次她开口、连续几条没被回。 */
  const keys = new Map();
  /** 最近 24 小时她主动开口的时间点（算每小时/每天上限、留言配额）。 */
  let spokenAt = [];
  /** 最近一条判定结果（设置页/日志用："她为什么现在不说话"）。 */
  let lastWhy = '';
  let lastScore = 0;
  let targetKey = '';

  function ensure(key) {
    const k = String(key || '');
    if (!keys.has(k)) keys.set(k, { lastUserAt: 0, lastSpokeAt: 0, unanswered: 0, lastSpokeText: '' });
    return keys.get(k);
  }

  function trim(at) {
    spokenAt = spokenAt.filter((t) => at - t < 24 * HOUR);
  }

  function countSince(at, span) {
    trim(at);
    return spokenAt.filter((t) => at - t < span).length;
  }

  function hourOf(ms) {
    const d = new Date(ms);
    return d.getHours() + d.getMinutes() / 60;
  }

  /**
   * 对方说话了：清掉"没被回"的账，重新开始算沉默。
   *
   * 第一版只认私聊（群里主动说话太容易社死，用户也确认"群目前没添加"）。
   * 以后要开群聊，从这里放开 + 在 `decide` 里单独给一套更严的闸门。
   */
  function noteUser({ key, at = now(), preferred = false } = {}) {
    if (!key) return;
    const k = String(key);
    if (!k.startsWith('private:')) return;
    const st = ensure(k);
    st.lastUserAt = at;
    st.unanswered = 0;
    // 主人优先当"想说话的对象"；没主人就认最近一个私聊
    if (!targetKey || preferred) targetKey = k;
  }

  /** 她正常回了一句：算"刚说过话"，沉默从头开始。 */
  function noteReply({ key, at = now() } = {}) {
    if (!key) return;
    const k = String(key);
    if (!k.startsWith('private:')) return;
    ensure(k).lastSpokeAt = at;
    if (!targetKey) targetKey = k;
  }

  /**
   * 她主动开口了：记一笔、欠一次"回复"、进配额。
   * 返回一份"说之前的样子"，发送失败时用 `rollbackSpoken()` 原样退回去
   * （不然会被算成"她晾了人家"，还会白占一次配额）。
   */
  function noteSpoken({ key, at = now(), text = '' } = {}) {
    const st = ensure(String(key || targetKey || ''));
    const prev = { lastSpokeAt: st.lastSpokeAt, unanswered: st.unanswered, lastSpokeText: st.lastSpokeText };
    st.lastSpokeAt = at;
    st.unanswered += 1;
    st.lastSpokeText = String(text || '').slice(0, 120);
    trim(at);
    spokenAt.push(at);
    return prev;
  }

  /** 没发出去：把刚才那笔撤掉。 */
  function rollbackSpoken({ key, prev = null } = {}) {
    const st = ensure(String(key || targetKey || ''));
    if (prev && typeof prev === 'object') {
      st.lastSpokeAt = Number(prev.lastSpokeAt) || 0;
      st.unanswered = Math.max(0, Number(prev.unanswered) || 0);
      st.lastSpokeText = String(prev.lastSpokeText || '');
    } else {
      st.unanswered = Math.max(0, st.unanswered - 1);
    }
    if (spokenAt.length) spokenAt.pop();
  }

  /** 距离上一次"双方任何一方说话"过了多少分钟。 */
  function silenceMin(key, at = now()) {
    const st = ensure(String(key || targetKey || ''));
    const base = Math.max(st.lastSpokeAt || 0, st.lastUserAt || 0);
    return base ? Math.max(0, (at - base) / MIN) : 0;
  }

  /** 一条念头此刻的"想说程度"：动机 × 沉默加成 × 情境，带一点点抖动。 */
  function score(thought, { key, at = now() } = {}) {
    const c = conf();
    const st = ensure(String(key || targetKey || ''));
    const boost = Math.min(c.maxSilenceBoost, Math.pow(c.silenceBoostPerMin, silenceMin(key, at)));
    const jitter = 0.92 + rng() * 0.16;
    const hour = hourOf(at);
    const awake = inActiveHours(hour, c.activeHours);
    const value = Number(thought?.motivation || 0) * boost * contextMult(hour, st.unanswered, awake) * jitter;
    return Math.round(Math.min(5.5, value) * 100) / 100;
  }

  /** 这一档频率的门槛。 */
  function threshold() {
    return FREQUENCY[conf().frequency] || FREQUENCY.normal;
  }

  /**
   * 现在能不能开口。
   *
   * @returns {{ok:boolean, why?:string, thought?:object, score?:number, best?:object}}
   *   `ok:false` 时 `why` 一定有值（`WHY` 里有对应的中文）；`best` 是"最高分那条"，
   *   方便日志/设置页显示"她想到了，但还不够想说"。
   */
  function decide({ thoughts = [], at = now(), key = targetKey } = {}) {
    const c = conf();
    if (!c.enabled) return { ok: false, why: 'off' };
    if (!key || !String(key).startsWith('private:')) return { ok: false, why: 'no-target' };
    const st = ensure(String(key));

    if (st.lastUserAt && at - st.lastUserAt < c.afterUserMin * MIN) return { ok: false, why: 'after-user' };
    if (st.lastSpokeAt && at - st.lastSpokeAt < c.minGapSec * 1000) return { ok: false, why: 'min-gap' };
    if (st.unanswered >= c.maxUnanswered) return { ok: false, why: 'ignored' };
    if (countSince(at, HOUR) >= c.maxPerHour) return { ok: false, why: 'hour-budget' };
    if (countSince(at, 24 * HOUR) >= c.maxPerDay) return { ok: false, why: 'day-budget' };

    const list = (Array.isArray(thoughts) ? thoughts : []).filter((t) => t && String(t.text || '').trim());
    if (!list.length) return { ok: false, why: 'no-thought' };

    let best = null;
    for (const t of list) {
      const value = score(t, { key, at });
      if (!best || value > best.score) best = { thought: t, score: value };
    }
    const line = threshold();

    // 深夜：只有"留言"能出去（一晚一条，动机得够高）
    const hour = hourOf(at);
    if (!inActiveHours(hour, c.activeHours)) {
      const nightUsed = spokenAt.filter((t) => !inActiveHours(hourOf(t), c.activeHours)).length;
      const allowed = c.nightMessage && best.score >= line + 1.3 && nightUsed < 1;
      if (!allowed) return { ok: false, why: 'night', best };
    }

    if (best.score < line) return { ok: false, why: 'low', best };
    return { ok: true, why: '', thought: best.thought, score: best.score, best };
  }

  /** 记一次判定（只留最近一条，给设置页/日志看"她为什么不说"）。 */
  function remember(verdict) {
    lastWhy = verdict?.ok ? '' : (verdict?.why || '');
    lastScore = Number(verdict?.best?.score || verdict?.score || 0);
    return verdict;
  }

  function snapshot(at = now()) {
    const c = conf();
    const st = ensure(targetKey || '');
    return {
      enabled: c.enabled,
      frequency: c.frequency,
      threshold: threshold(),
      targetKey,
      lastUserAt: st.lastUserAt,
      lastSpokeAt: st.lastSpokeAt,
      unanswered: st.unanswered,
      silenceMin: Math.round(silenceMin(targetKey, at)),
      spokenLastHour: countSince(at, HOUR),
      spokenToday: countSince(at, 24 * HOUR),
      lastWhy,
      lastScore,
      whyText: WHY[lastWhy] || '',
    };
  }

  /** 持久化：只留"重启后不该忘"的那几样（不然一开机她立刻就想说话）。 */
  function serialize() {
    return {
      schemaVersion: 1,
      targetKey,
      keys: [...keys.entries()].map(([k, v]) => [k, v]),
      spokenAt: spokenAt.slice(-50),
    };
  }

  function hydrate(obj) {
    if (!obj || typeof obj !== 'object') return;
    targetKey = String(obj.targetKey || '');
    keys.clear();
    for (const row of Array.isArray(obj.keys) ? obj.keys : []) {
      if (!Array.isArray(row) || row.length !== 2) continue;
      const [k, v] = row;
      if (!k || !v || typeof v !== 'object') continue;
      keys.set(String(k), {
        lastUserAt: Number(v.lastUserAt) || 0,
        lastSpokeAt: Number(v.lastSpokeAt) || 0,
        unanswered: Math.max(0, Number(v.unanswered) || 0),
        lastSpokeText: String(v.lastSpokeText || '').slice(0, 120),
      });
    }
    spokenAt = (Array.isArray(obj.spokenAt) ? obj.spokenAt : [])
      .map(Number).filter((t) => Number.isFinite(t) && now() - t < 24 * HOUR);
  }

  return {
    DEFAULTS,
    noteUser,
    noteReply,
    noteSpoken,
    rollbackSpoken,
    silenceMin,
    score,
    threshold,
    decide,
    remember,
    snapshot,
    serialize,
    hydrate,
    targetKey: () => targetKey,
    setTarget: (key) => { targetKey = String(key || ''); },
    /**
     * ★ 2026-10-31：他**上一句话**是什么时候（毫秒时间戳，没有就是 0）。
     * `silenceMin()` 算的是"双方任何一方"说话后的静默，会把她自己刚说的话也算进去；
     * "她要不要自己玩手机"要看的是**他只顾着忙、根本不说话**，所以单独要这一个。
     */
    lastUserAt: (key) => {
      const st = ensure(String(key || targetKey || ''));
      return Number(st.lastUserAt) || 0;
    },
    reset: () => {
      keys.clear();
      spokenAt = [];
      lastWhy = '';
      lastScore = 0;
      targetKey = '';
    },
  };
}

module.exports = {
  FREQUENCY, DEFAULTS, WHY, inActiveHours, partOfDay, contextMult, normalizeCfg, createPresence,
};
