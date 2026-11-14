/**
 * 长期记忆的"整理员"（2026-10-27）。
 *
 * 它不参与聊天，只在后台做两件事：
 *   1. 每 N 轮把最近的对话读一遍，提取「人物账 traits/facts」和「值得长期记住的事」；
 *   2. 记忆超过容量时，把最旧一批压成一条 ≤200 字摘要（原文归档）。
 *
 * 用哪套模型由调用方给（默认跟 QQ 模型相同）。失败一律**不阻塞聊天**：
 * 原始 `turns.jsonl` 还在，下一轮再试。
 */
const KIND = new Set(['fact', 'event', 'promise', 'preference', 'relationship']);
const MAX_BODY = 200;
const selfNotes = require('./companion-self.cjs');
/**
 * ★ 2026-11-04：**她自己的账**（锚 / 账 / 传）。
 * 这个文件只做两件事：把候选证词交过去（`me`）、以及在攒够时跑一次"写一笔"（`judgeSelf`）。
 * 账怎么存、怎么注入不在这里 —— 见 `companion-self-kernel.cjs`。
 */
const selfKernel = require('./companion-self-kernel.cjs');
/**
 * ★ 2026-11-07：**手机进度行不是对话**（见 `companion-memory.isPhoneTurn`）。
 * 整理员只读"真说过的话"；游标仍按**原始** turns 推进，所以过滤不会让谁被跳过。
 */
const { isPhoneTurn, mediaNote } = require('./companion-memory.cjs');

const SYSTEM = `你是"长期记忆整理员"，只做整理，不扮演角色。
读下面这段真实对话，提取值得长期记住的内容。
只输出一个 JSON 对象，不要 Markdown、不要解释：
{
  "profile": { "traits": ["..."], "facts": ["..."] },
  "memories": [
    { "body": "...", "kind": "fact|event|promise|preference|relationship",
      "scope": "person|global", "tags": ["..."], "keys": ["..."], "importance": 3 }
  ]
}
规则：
- 只记对话里真实出现的事，不要编造、不要脑补。
- **profile 只写"对方（他）"的稳定信息**：名字、城市、工作/作息、口味/喜好、重要关系、
  长期在做的事（不是今天/这周的项目进度、临时任务）。
- **profile 不写"她"**：她自己的说话风格、脾气、边界、对表情包/工具的态度，一律不写进 traits/facts；
  她的设定由角色卡负责。只出现在"你："里的内容，不能当成他的 traits。
  ★ 2026-11-04：**她自己的事不再丢掉** —— 交给下一道的 me（她自己的账：
  喜欢什么/看法/干过什么/想做什么/变过什么），别塞进他的 profile，也别当成"最近观察"压成一句话。
- 例：她说"我本来就这样""我爱怼人""我说话短"——这是她的自我描述，不是他的 traits；
  也不要写成他的长期记忆。
- traits（候选）一次最多 3 条，facts 一次最多 5 条；宁少勿多。不写评价性标签
  （如"爱怼人""说话简短""脾气差"），只写可观察的偏好/习惯。
  对某个功能的反应、当天心情、一次性评价（如"对新增功能感到高兴""这次很开心"）也不算 traits。
  她怎么发语音、程序通没通、谁那边调没调好这类事更不算 —— 那是机器当时的状态，不是她的性情。
- traits/facts 都先作为候选，交给"归属判定"：只有描述"他"的才写进他的账；
  描述"她"的会变成时间有限的"最近观察"，她自己的偏好/干过的事则进她自己的账（me）。
- 写之前先看"已有的账"：意思相同、只是措辞不同的不要重复写；旧信息被新信息更新时，写新的。
- 不记系统实现、功能开关、工程细节、项目进度、临时任务（除非对方明确说"记住"）；
  profile 只记他这个人。
- 发生过的事、承诺、近况、情绪节点放 memories。
- **正文里一律写绝对日期**（如"11 月 1 日""10 月 31 日"），**不许写"今天/昨天/明天/昨晚"**。
  这些条目几天后还会被翻出来用，相对日期到时候全是错的（实测：10-31 写的"他今天下午才醒"，
  11-02 读起来还是"今天"；11-01 写的"明天见面"到 11-03 就没人知道是哪天）。
- 每条 body ≤200 字；keys 2~5 个，方便以后检索；tags 可选。
- 图片只写 [图片]，不要写 base64；不要写密钥。
- 寒暄、表情、重复的话不用记；不确定的不要写。
- scope=global 只用于对方明确确认的、和所有人都相关的约定；
  不要把她自己的说话风格/脾气写 global；对方的私事一律 scope=person。
- memories 可以记"她今天说了什么"，但不要写成"他喜欢被怼/他喜欢短句"。
- **单句不能成 traits**：只有他明确自述（如"我 12 点睡"），或同一件事在不同时间被说过至少两次，
  才写 profile；只出现过一次的评价、猜测、当天的情绪，写 memories（kind=event）或者不写。
- **一次性的日常不进 memories**：洗澡、吃饭、发表情、试功能、寒暄、调试过程都不记；
  只记值得跨周再想起的：近况、承诺、变化、重要经历、长期偏好。
- 宁少勿多：一次最多 3 条 memories。`;

/**
 * 第二道：归属判定。
 *
 * 2026-10-29 实测：整理员会把“她的性子”写成“他的 traits”（“爱怼人”“说话简短”
 * “对对方提出的需求会认真回应并主动优化”）。只在整理提示词里写“别写她”挡不住，
 * 所以候选 traits/facts 再过一道：判成“他”的才进人物账；判成“她”的改写成
 * **最近的行为观察**，进 `companion-self`（14 天后不再注入，不是固定标签）。
 */
const ATTRIBUTE_SYSTEM = `你是"归属判定员"，只做归属，不扮演角色。
下面是整理员从一段"他/她"的聊天里抽出的候选 traits/facts。
判断每条是在描述"对方（他）"、还是"她"、还是都不确定。
只输出一个 JSON 对象，不要 Markdown、不要解释：
{
  "him": { "traits": ["..."], "facts": ["..."] },
  "her": ["（她怎么反应的一句话，不是评价标签）"],
  "me": [ { "kind": "taste|stance|doing|want|change", "claim": "……", "quote": "她那句原话", "source": "intrinsic|exposure|accommodation", "flavor": "当时什么滋味" } ],
  "none": ["..."]
}
规则：
- him：描述"他"的稳定信息：名字、城市、工作/作息、口味/喜好、重要关系、长期在做的事；
  不把项目进度、临时任务、今天在填什么坑当成他的 traits/facts。
- **him 里不许放"她在对他做的事"**：像"她总凑过来看""她爱顶嘴"这类，
  是 her（反应）或 me（她自己的偏好/习惯），不是 his。
  ⚠️ **但要分清方向**：他账里的「对方」指的是**她** ——「会主动逗对方（如摸头）」是**他**逗她，
  「喜欢用昵称称呼对方（如小笨鱼）」也是**他**在叫她。这种必须留在 his。
  判据永远是"这句话是谁说的 / 主语是谁"，**不是"句子里有没有『对方』"**
  （2026-11-04 就在这里搞反过一次，把他的话搬成了她的喜好）。
- her：描述"她"的**反应方式**，一条不超过 40 字，最多 2 条。
  ★ 2026-11-04：**不要再套"最近被X时，会Y"这个句式**。原来提示词里给的就是那个例子，
  结果 60 条观察里 48 条全是那个形状，她自己读到"我"永远只有一个动作。
  现在写成自然的说法（"被夸先顶一句，但听得进真话"）。
  ★ 不写她怎么用某个功能（怎么发语音、程序通不通、谁那边调没调好）—— 那不是性情，是机器当时的状态。那类候选直接放 none。
- **me：她自己的事，"和他无关"也要收**。五类：
    taste  她喜欢/讨厌什么（要有具体对象：哪首歌、什么活儿、哪种语气）
    stance 她自己的看法/立场（可以和他不一样）
    doing  她做过的事（哪天干了什么，哪怕只是发呆、翻歌、看窗外）
    want   她想做但还没做的事
    change 她变过的地方（以前怎么想，现在怎么想）
  每条都要带 quote（她原话里那半句，不要改写），最多 3 条。
  source：自己撞见的=intrinsic / 他带的=exposure / 迁就他的=accommodation
  flavor：当时那股滋味（困、来气、舍不得、嘴硬心软…），≤8 字
  ★ 宁可少：这一栏是**证词**，不是结论，只写她原话里真有的东西。
- **依据归属**：只有"小主/对方"说的话能作为 him 的依据；"你"（她）说的话只能作为 her/me 的依据。
  例：她说"真碰上想做的，我会自己去的" → 进 me（kind=want），不进 him。
- 不确定的放 none；宁可放 none，不要猜。
- 不要把"她"的候选放进 him；也不要把"他"的候选放进 her。
- 只输出 JSON。`;

/** 把 turns 渲染成给整理员看的对话。 */
function formatTurns(turns) {
  const place = (where) => {
    const text = String(where || '');
    if (text.startsWith('group')) return 'QQ群';
    if (text === 'deskpet') return '桌宠';
    if (text.startsWith('private')) return 'QQ私聊';
    return '聊天';
  };
  const time = (ms) => {
    const d = new Date(Number(ms) || Date.now());
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  return turns.map((turn) => {
    const who = turn.who || '对方';
    /**
     * ★ 2026-11-07：**空 text 的那一行是她说的，不是"对方"**。
     * 旧版一律写成 `小主（桌宠）：`（后面空着）+ `你：…`，整理员会把她的随口话
     * 当成"他没说话"；更糟的是把她的行为记成他的 traits。这里按归属写：
     *   · 有 text → 他说的那一句；
     *   · 只有 reply → 她说的（手机进度行已经在 `extractNow` 里滤掉了）。
     */
    if (!String(turn.text || '').trim()) {
      return `[${time(turn.t)}] 她（${place(turn.where)}）：${turn.reply || ''}${mediaNote(turn.media)}`;
    }
    const lines = [`[${time(turn.t)}] ${who}（${place(turn.where)}）：${turn.text || ''}`];
    if (turn.reply) lines.push(`你：${turn.reply}${mediaNote(turn.media)}`);
    return lines.join('\n');
  }).join('\n\n');
}

function profileLines(person) {
  if (!person) return '（还没有）';
  const lines = [];
  if (person.name) lines.push(`名字：${person.name}`);
  if (person.traits?.length) lines.push(`他（对方）的 traits：${person.traits.slice(-12).join('；')}`);
  if (person.facts?.length) lines.push(`他（对方）的 facts：${person.facts.slice(-12).join('；')}`);
  return lines.length ? lines.join('\n') : '（还没有）';
}

/**
 * ★ 2026-11-01：落后多少轮要提醒整理员。
 * 用户原话：「就如果落后100轮时提醒整理模型」。
 *
 * 为什么要提醒而不是"一次多读点"：整理一次最多读 60 轮（token 有数），落后 100+ 轮时
 * 它就是在"补旧账"，而旧账里最容易丢的是人名/约定/情绪转折 —— 提示词里点一句，
 * 比把它塞成 300 轮更便宜也更准。`turnsAfter` 已经改成取**最早**的 60 轮，
 * 所以提醒之后是**按顺序**补，不会跳中间。
 */
const BACKLOG_WARN = 100;

function buildExtractionMessages({ turns, person, personId, backlog = 0 }) {
  const user = [
    `对方 id：${personId}`,
    backlog > BACKLOG_WARN
      ? `（提醒：你有 ${backlog} 轮对话还没整理，积压了。这一批只给你**最早**的一段（${turns.length} 轮）——先把人名、约定、答应过的事、情绪转折记下来；后面几批会接着给。）`
      : '',
    `已有的账（下面是他/对方的信息，不是她的）：\n${profileLines(person)}`,
    `对话：\n${formatTurns(turns)}`,
  ].filter(Boolean).join('\n\n');
  return [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: user },
  ];
}

function buildSummaryMessages(bodies) {
  return [
    {
      role: 'system',
      content: '你是记忆压缩员。把多条记忆合并成一条简洁、不丢失关键事实的中文记忆，只输出合并后的正文（200 字以内），不要解释、不要 Markdown。',
    },
    {
      role: 'user',
      content: bodies.map((body, i) => `【记忆 ${i + 1}】\n${body}`).join('\n\n'),
    },
  ];
}

/** 从模型回复里抠 JSON（容忍 ```json 围栏和前后废话）。 */
function parseExtraction(text) {
  let raw = String(text || '').trim();
  raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1));
    return normalizeExtraction(parsed);
  } catch {
    return null;
  }
}

/** 清洗：不写密钥/图片 base64；长度夹紧。 */
function clean(text, max = MAX_BODY) {
  return String(text || '')
    .replace(/data:[^,\s]+;base64,[A-Za-z0-9+/=]+/g, '[图片]')
    .replace(/sk-[A-Za-z0-9_-]{16,}/g, '[已隐藏]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function stringList(value, max = 8) {
  return (Array.isArray(value) ? value : [])
    .map((x) => clean(x, 120))
    .filter(Boolean)
    .slice(0, max);
}

function normalizeExtraction(value) {
  if (!value || typeof value !== 'object') return null;
  const profile = value.profile && typeof value.profile === 'object' ? value.profile : {};
  const memories = (Array.isArray(value.memories) ? value.memories : [])
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const body = clean(item.body, MAX_BODY);
      if (!body) return null;
      return {
        body,
        kind: KIND.has(item.kind) ? item.kind : 'fact',
        scope: item.scope === 'global' ? 'global' : 'person',
        tags: stringList(item.tags, 6),
        keys: stringList(item.keys, 6),
        importance: Math.min(5, Math.max(1, Number(item.importance) || 3)),
      };
    })
    .filter(Boolean)
    .slice(0, 3);
  return {
    traits: stringList(profile.traits, 3),
    facts: stringList(profile.facts, 5),
    memories,
  };
}

/**
 * ★ 2026-11-04：归属判定员多给一栏 `me` —— **她自己的事**（证词，还不算账）。
 *
 * 为什么要单独一栏而不是并进 `her`：`her` 走的是 `self.jsonl`（行为反射，14 天，注入 1 条），
 * 只装得下一句"被夸先顶一句"；而"她喜欢哪首歌""她哪天发过呆"需要的是一条能带日期、
 * 带来源、能被修订的记录 —— 那是 `companion-self-kernel` 的账。
 *
 * @returns {Array<{kind:string, claim:string, quote:string, source:string, flavor:string}>}
 */
function parseMe(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  for (const item of list.slice(0, 3)) {
    const obj = typeof item === 'string' ? { claim: item } : (item && typeof item === 'object' ? item : null);
    if (!obj) continue;
    const claim = String(obj.claim || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    if (!claim || claim.length < 3) continue;
    const kind = ['taste', 'stance', 'doing', 'want', 'change'].includes(obj.kind) ? obj.kind : 'taste';
    const source = ['intrinsic', 'exposure', 'accommodation'].includes(obj.source) ? obj.source : 'intrinsic';
    out.push({
      kind,
      claim,
      quote: String(obj.quote || '').replace(/\s+/g, ' ').trim().slice(0, 60),
      source,
      flavor: String(obj.flavor || '').trim().slice(0, 12),
    });
  }
  return out;
}

/** 解析归属判定的 JSON；容忍 ```json 围栏。 */
function parseAttribution(text) {
  let raw = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const value = JSON.parse(raw.slice(start, end + 1));
    const himRaw = value.him && typeof value.him === 'object' ? value.him : {};
    const him = Array.isArray(himRaw) ? { traits: himRaw, facts: [] } : himRaw;
    const herRaw = (Array.isArray(value.her) ? value.her : [])
      .map((x) => (typeof x === 'string' ? x : x && x.text))
      .filter(Boolean);
    // 已知的“她的评价标签”直接挡掉，避免判定员也把标签原样放回来。
    const selfLabel = /爱怼人|爱贫嘴|说话简短|脾气差|留声机|任务工具|嘴硬/;
    // 项目/工程类不进他的“人物账”：提示词已经说了，这里再做一道窄网，防止“会做桌宠/余额/项目”这类。
    const project = /桌宠|陪伴模式|内置|API|代码|项目|功能|余额|记忆机制|自检|接口|模型/;
    const her = stringList(herRaw, 2)
      .map((x) => x.replace(/\s+/g, ' ').trim())
      // ★ 2026-11-01：跟"语音/程序/功能"打交道的观察不算性情，`companion-self.usable`
      // 是唯一判据（写入口和这里共用一条规则，免得两处各写一份正则）。
      .filter((x) => x && !selfLabel.test(x) && selfNotes.usable(x))
      .map((x) => (x.startsWith('最近') ? x : `最近${x}`).slice(0, 60));
    // 和整理员的上限对齐：一次最多 3 traits / 5 facts，别让判定员一口气倒一堆。
    /**
     * ⚠️ **2026-11-04 的教训（别再犯）**：这里一度加过一道"带『逗对方』的候选一律不进他账"的过滤，
     * 理由是以为「会主动逗对方（如摸头、戳肚子）」的主语是她 —— **错了**。
     * 他账里的「对方」指的是**她**：「会主动逗对方」= **他**逗她；「叫她小笨鱼」也是他。
     * 实测对话里 `小笨鱼` 出现 3 次在他那句、她只是回嘴。
     * 那道过滤既会把他真正的 traits 丢掉，又会把他的行为搬到她的账上（用户 11-04 当场发现）。
     * **判据只能是"这句话是谁说的"，绝不能从"句子没有主语"去猜。**
     */
    const himTraits = stringList(him.traits, 3)
      .filter((x) => !selfLabel.test(x) && !project.test(x));
    const himFacts = stringList(him.facts, 5)
      .filter((x) => !project.test(x));
    return {
      him: { traits: himTraits, facts: himFacts },
      her,
      me: parseMe(value.me),
      none: stringList(value.none, 8),
    };
  } catch {
    return null;
  }
}

/** 第二道：让模型把候选分到 him / her / none。 */
async function attributeCandidates({ model, parsed, turns, callModel }) {
  const candidates = { traits: parsed.traits, facts: parsed.facts };
  const recent = turns.slice(-20);
  const messages = [
    { role: 'system', content: ATTRIBUTE_SYSTEM },
    { role: 'user', content: `候选：\n${JSON.stringify(candidates)}\n\n对话（最近 ${recent.length} 轮）：\n${formatTurns(recent)}` },
  ];
  const out = await callModel(model, messages, { temperature: 0.1, maxTokens: 512 });
  const got = parseAttribution(out?.text || out || '');
  if (!got) throw new Error('归属判定没给出可解析的 JSON');
  return got;
}

function isLocalModel(model) {
  return /(^|\/\/)(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(model.baseUrl || '')
    || /:11434(\/|$)/.test(model.baseUrl || '');
}

function modelReady(model) {
  if (!model || !model.baseUrl || !model.model) return false;
  if (!model.apiKey && !isLocalModel(model)) return false;
  return true;
}

/**
 * @param {object} opts
 * @param {import('./long-memory.cjs').LongMemory} opts.longMemory
 * @param {object} opts.memory  CompanionMemory
 * @param {(model:object, messages:object[], opts?:object)=>Promise<{text:string}>} opts.callModel
 * @param {()=>object} opts.getModel  `resolveModel(cfg.model)` 的结果
 * @param {()=>object} opts.getConfig `companion.memory`
 */
function createMemoryScribe({ longMemory, memory, callModel, getModel, getConfig, log, self: selfStore = selfNotes }) {
  const logger = log || { info: () => {}, warn: () => {} };
  const running = new Set();
  const timers = new Map();

  const config = () => ({
    enabled: true,
    extractEveryTurns: 6,
    maxEntries: 160,
    maxTokens: 12000,
    compressBatch: 16,
    // ★ 2026-11-04：她自己的账（见 `companion-self-kernel.cjs`）。`false` 就退回旧行为。
    selfKernel: { enabled: true },
    ...(getConfig() || {}),
  });

  function bumpTurn(personId) {
    const state = longMemory.getState();
    const counts = { ...(state.turnsSinceExtract || {}) };
    counts[personId] = (Number(counts[personId]) || 0) + 1;
    longMemory.patchState({ turnsSinceExtract: counts });
    return counts[personId];
  }

  function resetTurn(personId) {
    const state = longMemory.getState();
    const counts = { ...(state.turnsSinceExtract || {}) };
    counts[personId] = 0;
    longMemory.patchState({ turnsSinceExtract: counts });
  }

  /**
   * ★ 2026-11-04：**写一笔**（她自己的账唯一的写入口）。
   *
   * 为什么不在聊天里写（用户 11-04 20:58 那条她自己的评判："夜里那一趟才动笔写，
   * 白天只收集，免得我跟了一句就现改自己。说得在理"）：
   *   ① 边聊边改自己会不稳（Letta 的 sleep-time 结论）；
   *   ② 元反思在对话里做会触发人格漂移（Assistant Agent Axis 的实测）；
   *   ③ 白天写 = 账跟着**他刚说的话**走，一天就长成"他喜欢什么她就喜欢什么"。
   *
   * 触发不是时钟，是**攒够 / 她想写 / 太久没写**（`selfKernel.whyWrite()`）。
   * 这一趟**允许什么都不写** —— 她的原话：「不用天天都得出点什么，条条目目不落，那也不是我」。
   */
  async function judgeSelf({ force = false, why = '' } = {}) {
    const key = 'self';
    if (running.has(key)) return { ok: false, why: '正在写' };
    if (config().selfKernel?.enabled === false) return { ok: false, why: '关掉了' };
    const model = getModel();
    if (!modelReady(model)) return { ok: false, why: '模型没配好' };
    const state = selfKernel.readState();
    const { messages, evidence } = selfKernel.buildJudgeMessages({ since: state.lastJudgeAt, maxOps: 3 });
    if (!evidence.length && !force) {
      selfKernel.markJudged({ result: '还没攒下什么' });
      return { ok: true, ops: [], kept: 0, why: 'no-evidence' };
    }
    running.add(key);
    logger.info(`她的账：动笔（${why || 'manual'} · 证词 ${evidence.length} 条）`);
    try {
      const out = await callModel(model, messages, { temperature: 0.3, maxTokens: 700 });
      const parsed = selfKernel.parseOps(out?.text || out || '');
      if (!parsed) {
        logger.warn('她的账：写一笔没给出可解析的 JSON（这次先不算，下一轮再试）');
        return { ok: false, why: 'bad-json' };
      }
      const stat = selfKernel.applyOps(parsed.ops, { at: Date.now() });
      const kept = stat.added + stat.revised + stat.retired;
      const note = kept
        ? `加了 ${stat.added} 条、改了 ${stat.revised} 条、不算了 ${stat.retired} 条`
        : (parsed.passed || '这次没想写的');
      selfKernel.markJudged({ result: note });
      logger.info(`她的账：写成一笔（${note}）· 证词 ${evidence.length} 条 · 累计第 ${selfKernel.readState().judgeCount} 笔`);

      // 账上新增够多了，再写一篇"我这一周"（第二趟调用，很省：一次 400 字左右）
      if (selfKernel.wantChronicle()) {
        try {
          const cOut = await callModel(model, selfKernel.buildChronicleMessages(), { temperature: 0.8, maxTokens: 500 });
          const text = String(cOut?.text || '').trim();
          if (text && !/略过|没什么可写/u.test(text.slice(0, 24))) {
            selfKernel.appendChronicle(text);
            logger.info(`她的账：写了一篇「我这一周」（${text.length} 字）`);
          } else {
            selfKernel.patchState({ entriesSinceChronicle: 0 });
            logger.info('她的账：这一周她说略过');
          }
        } catch (err) {
          logger.warn(`她的账：这一周没写成（${err.message}）`);
        }
      }
      return { ok: true, ops: parsed.ops, kept, stat, passed: parsed.passed || '' };
    } finally {
      running.delete(key);
    }
  }

  /** 等一会儿再写（别在回复那一轮抢 CPU；也让这轮的证词先落盘）。 */
  function scheduleSelfJudge(why, delay = 15_000) {
    if (running.has('self') || timers.has('self')) return;
    const timer = setTimeout(() => {
      timers.delete('self');
      judgeSelf({ why }).catch((err) => logger.warn(`她的账：写一笔失败（${err.message}）`));
    }, delay);
    timer.unref?.();
    timers.set('self', timer);
  }

  /** 每轮结束后调用；只计数，不阻塞。 */
  function afterTurn({ personId, personName, where } = {}) {
    const cfg = config();
    if (!cfg.enabled || !personId) return;
    /**
     * ★ 2026-11-04：**她要写一笔吗**（攒够 / 她说了 `[自己:写一笔]` / 太久没写）。
     *
     * 放在最前面：这件事和"整理员按 N 轮跑"是两条独立的时钟 ——
     * 用户一般晚上关机，所以原来设想的"每天夜里写"不成立（用户 11-04 21:04 拍板：
     * "可以积累到一定程度，或者单纯你想写"）。攒够就写，没攒够就不写。
     */
    try {
      const why = selfKernel.whyWrite();
      if (why) scheduleSelfJudge(why);
    } catch (err) { logger.warn(`她的账：判断要不要写时出错（${err.message}）`); }
    const count = bumpTurn(String(personId));
    const state = longMemory.getState();
    if (Date.now() < Number(state.retryAfter || 0)) return;
    if (count < Math.max(2, Number(cfg.extractEveryTurns) || 6)) return;
    if (running.has('extract')) return;
    if (timers.has('extract')) return;
    // 让这一轮先把回复发出去，再在后台整理。
    const timer = setTimeout(() => {
      timers.delete('extract');
      extractNow({ personId, personName, where }).catch((err) => {
        logger.warn(`长期记忆整理失败：${err.message}`);
      });
    }, 120);
    timer.unref?.();
    timers.set('extract', timer);
  }

  /** 立刻整理一次（自检 / 面板"立即整理"用）。 */
  async function extractNow({ personId, personName, where = '' } = {}) {
    const key = 'extract';
    if (running.has(key)) return null;
    const cfg = config();
    if (!cfg.enabled) return null;
    const model = getModel();
    if (!modelReady(model)) {
      longMemory.patchState({ lastError: '整理模型没配好' });
      return null;
    }
    running.add(key);
    try {
      /**
       * ★ 2026-11-01：**用"这个人自己的"游标**，不是全局那个。
       *
       * 原来 `since` 取的是全局 `lastExtractedAt`，可下面又按 `personId` 过滤 ——
       * 于是 A 整理一次会把游标推到 A 的时间，**B 在那之前说的话永远轮不到整理**
       * （实测：B 的 6 轮里 5 轮被跳过，`turnsSinceExtract` 还在涨，日志一声不响）。
       * `cursorFor` 在没单独记过时退回全局值，所以老配置不用迁移。
       */
      const since = longMemory.cursorFor(String(personId));
      /**
       * ★ 2026-11-01：先拿**全部**未整理的（升序），再切这一批。
       * `backlog` 只做两件事：落后时给日志一条 WARN、给整理员的 prompt 一句提醒。
       * 注意 `turnsAfter` 现在返回的是**最早**的 N 条 —— 所以补旧账是按顺序走，不会跳。
       */
      const unread = memory.turnsAfter(since, 100000, { personId: String(personId) });
      const backlog = unread.length;
      /**
       * ★ 2026-11-07：**只把"真说过的话"攒成一批，游标不动**（见下）。
       *
       * 原来先切 `unread.slice(0, 60)` 再过滤 phone 行：一批里真话只剩 0~1 条时，
       * 要么整批不整理、要么把游标推过那条真话 —— 那一条就**永远不会进长期记忆**。
       * 现在顺着原始行往前扫，只把非 phone 行收进这一批（最多 60 轮）：
       *   · 收够 60 条真话 → 交给整理员，游标推到这批最后一条真话（后面的下次再来）；
       *   · 真话不足 2 条 → **不动游标**，等下一句来了再一起整理（手机行下次照样跳过）；
       *   · 整段全是手机进度 → 直接消费掉，别让它们堵住后面的真对话。
       * 一条真对话都不会被跳过，也不会重复写。
       */
      const turns = [];
      let lastT = 0;
      for (const row of unread) {
        if (!isPhoneTurn(row)) turns.push(row);
        lastT = Number(row.t) || lastT;
        if (turns.length >= 60) break;
      }
      if (turns.length < 2) {
        if (!turns.length && lastT) {
          longMemory.advanceCursor(String(personId), lastT);
          longMemory.patchState({
            retryAfter: 0,
            lastError: '',
            turnsSinceExtract: { ...(longMemory.getState().turnsSinceExtract || {}), [String(personId)]: 0 },
          });
        }
        resetTurn(String(personId));
        return null;
      }
      if (backlog > BACKLOG_WARN) {
        logger.warn(`长期记忆：落后 ${backlog} 轮没整理（这一批先读最早 ${turns.length} 轮，会接着补）`);
      }
      const person = memory.allPeople()[String(personId)] || {};
      const messages = buildExtractionMessages({ turns, person, personId: String(personId), backlog });
      const out = await callModel(model, messages, { temperature: 0.2, maxTokens: 512 });
      const parsed = parseExtraction(out?.text || out || '');
      if (!parsed) {
        longMemory.patchState({ lastError: '整理模型没给出可解析的 JSON', retryAfter: Date.now() + 60000 });
        return null;
      }

      // 1) 归属判定：先判每条候选是“他”还是“她”，再写账。
      //    —— 2026-10-29 实测：提示词挡不住整理员把“她的性子”写成“他的 traits”；
      //    判成“他”的才进人物账，判成“她”的进 self.jsonl（14 天后不再注入）。
      let attributed = { him: { traits: [], facts: [] }, her: [], me: [], none: [] };
      if (parsed.traits.length || parsed.facts.length || parsed.memories.length) {
        try {
          attributed = await attributeCandidates({ model, parsed, turns, callModel });
        } catch (err) {
          longMemory.patchState({ lastError: `归属判定失败：${err.message}`, retryAfter: Date.now() + 60000 });
          logger.warn(`长期记忆：归属判定失败，这一轮先不写人物账（${err.message}）`);
          return null;
        }
      }
      const him = attributed.him;
      if (him.traits.length || him.facts.length) {
        memory.applyProfile(String(personId), { name: personName || person.name, traits: him.traits, facts: him.facts });
        logger.info(`长期记忆：人物账 +${him.traits.length} traits / +${him.facts.length} facts`);
      }
      if (attributed.her.length) {
        const n = selfStore.add(attributed.her, { source: where });
        const keep = selfStore.KEEP_DAYS || selfNotes.KEEP_DAYS || 14;
        logger.info(`长期记忆：她的自我观察 +${n} 条（不写人物账，${keep} 天后不再注入）`);
      }
      /**
       * ★ 2026-11-04：她自己的事 → **证词**（不是账）。
       *
       * 写账是"写一笔"那一趟的事（`judgeSelf`），因为它要过三道门槛：
       * 有没有证据、是不是三个不同日子、是不是被夸出来的。整理员顺手写的直接落账，
       * 就等于把她的口头禅当天变成性格（11-01 那次吃过亏）。
       */
      if (attributed.me && attributed.me.length) {
        let n = 0;
        for (const item of attributed.me) {
          n += selfKernel.capture({
            at: Date.now(), where, who: personName || '',
            said: item.quote || item.claim, quote: item.claim,
            flavor: item.flavor, src: 'curator',
          });
        }
        if (n) logger.info(`长期记忆：她自己的事 +${n} 条证词（攒着，等写一笔）`);
      }
      if (attributed.none.length) {
        logger.info(`长期记忆：归属判定剔掉 ${attributed.none.length} 条（既不像他，也不像她）`);
      }

      // 2) 长期记忆：写入前用 BM25 去重；相似度高不是"丢掉"，而是给旧条目记一次"确认"。
      //    —— 2026-10-30：旧逻辑 here 直接 continue，把"今天又被验证了一次"的信号丢了，
      //    导致时间衰减只能按 updated 算，旧而真的事实越排越后。
      let written = 0;
      let confirmed = 0;
      const source = String(where || '').startsWith('group') || String(where || '').startsWith('private') ? 'qq' : 'deskpet';
      const sourceRange = `turns:${turns[0].t}-${turns[turns.length - 1].t}`;
      const sourceTurns = `turns:${turns[0].t}-${turns[turns.length - 1].t}`;
      for (const item of parsed.memories) {
        const similar = longMemory.search(item.body, {
          topK: 1,
          halfLifeDays: 0,
          // global 的事查全部；私事只跟"这个人 + global"比，避免拿 A 的账吞掉 B 的。
          personId: item.scope === 'global' ? null : String(personId),
        });
        if (similar[0] && similar[0].score >= 4) {
          longMemory.confirm(similar[0].entry.id);
          confirmed += 1;
          continue;
        }
        longMemory.write({
          body: item.body,
          kind: item.kind,
          person: item.scope === 'global' ? 'global' : String(personId),
          scope: item.scope,
          source,
          sourceRange,
          sourceTurns,
          tags: item.tags,
          keys: item.keys,
          importance: item.importance,
        });
        written += 1;
      }

      const lastAt = Math.max(...turns.map((turn) => Number(turn.t) || 0));
      /** ★ 2026-11-01：**只推进这个人自己的游标**（其他人在别处说的话不受影响）。 */
      longMemory.advanceCursor(String(personId), lastAt);
      longMemory.patchState({
        retryAfter: 0,
        lastError: '',
        turnsSinceExtract: { ...(longMemory.getState().turnsSinceExtract || {}), [String(personId)]: 0 },
      });
      const stats = longMemory.stats();
      const pending = stats.count > cfg.maxEntries || stats.tokens > cfg.maxTokens;
      if (pending) {
        const state2 = longMemory.getState();
        const list = new Set(state2.pendingCompress || []);
        list.add(String(personId));
        longMemory.patchState({ pendingCompress: [...list] });
      }
      logger.info(`长期记忆：整理 ${turns.length} 轮，写入 ${written} 条、确认 ${confirmed} 条（当前 ${stats.count} 条 / ${stats.tokens} token）`);
      if (pending) await maybeCompress();
      return { written, confirmed, turns: turns.length };
    } catch (err) {
      longMemory.patchState({ lastError: err.message, retryAfter: Date.now() + 60000 });
      logger.warn(`长期记忆整理失败：${err.message}`);
      return null;
    } finally {
      running.delete(key);
    }
  }

  /** 容量超了就压最旧一批。失败保留原文，下次再试。 */
  async function maybeCompress({ force = false } = {}) {
    if (running.has('compress')) return null;
    const cfg = config();
    if (!cfg.enabled) return null;
    const stats = longMemory.stats();
    const over = stats.count > cfg.maxEntries || stats.tokens > cfg.maxTokens;
    if (!force && !over) return null;
    /**
     * ★ 只压缩"同一个人（或同一类 global）"的一批。
     * 如果跨人合并，摘要会把 A 的私事带进 B 的上下文——这是隐私事故，不是优化。
     */
    const groups = new Map();
    for (const entry of longMemory.list()) {
      const key = entry.scope === 'global' ? 'global' : `person:${entry.person}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(entry);
    }
    const batchSize = Math.max(2, Number(cfg.compressBatch) || 16);
    const batch = [...groups.values()]
      .filter((group) => group.length >= 2)
      .sort((a, b) => (Date.parse(a[0].created) || 0) - (Date.parse(b[0].created) || 0))
      // ★ 2026-10-30：摘要本身不再进压缩批次。否则多代摘要会级联，越压越抽象、把细节焊死。
      .map((group) => group
        .filter((entry) => Number(entry.importance) < 5 && entry.kind !== 'summary')
        .slice(0, batchSize))
      .find((group) => group.length >= 2);
    if (!batch) return null;
    const model = getModel();
    if (!modelReady(model)) return null;
    running.add('compress');
    try {
      const out = await callModel(model, buildSummaryMessages(batch.map((entry) => entry.body)), {
        temperature: 0.3,
        maxTokens: 512,
      });
      const body = clean(out?.text || out || '', MAX_BODY);
      if (!body) return null;
      const merged = longMemory.mergeBatch(batch, body, 'compress');
      if (!merged) {
        longMemory.patchState({ lastError: '压缩时来源已被改动，放弃这次合并' });
        return null;
      }
      const state = longMemory.getState();
      /**
       * ★ 2026-11-01：`pendingCompress` 里存的是**人的 id**，而这里原来只按 `batch[0].person`
       * 清 —— 遇到 global 批次（person 是 `'global'`）就永远清不掉，每轮都以为"还有得压"。
       * 现在把"批次主人"和 `'global'` 一起清。
       */
      const clearKeys = new Set([String(batch[0].person), batch[0].scope === 'global' ? 'global' : '']);
      longMemory.patchState({
        pendingCompress: (state.pendingCompress || []).filter((id) => !clearKeys.has(String(id))),
        lastError: '',
      });
      logger.info(`长期记忆：压缩 ${merged.archived} 条 → 1 条摘要`);
      return { archived: merged.archived };
    } catch (err) {
      longMemory.patchState({ lastError: err.message, retryAfter: Date.now() + 60000 });
      logger.warn(`长期记忆压缩失败：${err.message}`);
      return null;
    } finally {
      running.delete('compress');
    }
  }

  return {
    afterTurn, extractNow, maybeCompress,
    /** ★ 2026-11-04：她自己的账 —— "写一笔"。窗口的「立即写一笔」也走这里。 */
    judgeSelf,
    /** 自检/面板用：看看有没有任务在跑。 */
    busy: () => running.size > 0,
    buildExtractionMessages, buildSummaryMessages,
  };
}

module.exports = {
  SYSTEM, ATTRIBUTE_SYSTEM, MAX_BODY, BACKLOG_WARN, createMemoryScribe, buildExtractionMessages, buildSummaryMessages,
  parseExtraction, parseAttribution, parseMe, normalizeExtraction, clean, formatTurns, modelReady,
};
