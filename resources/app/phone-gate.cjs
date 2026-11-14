/**
 * 她手机前的**前门**（P0，2026-11-12）
 *
 * 用户的原话：「我说一句'回到桌面打开日记本'必须要设定好吗？」
 * 答：不需要 —— 只要**判得出"这一句是不是让她用手机"**，就把**原句**交给她自己去做。
 *
 * 以前这件事押在 `phone-intent` 的 14 条整句规则 + 11 条扫动作上：
 * 认得出才排，认不出就当她没说过（于是"打开菜谱""去B站搜红烧肉"全 miss，
 * 她只能嘴上说"我这就去"）。这一层补的是**门**，不是**表**：
 *
 *   · 正向只认三种**形状**（明确祈使 + 手机线索 / 打开一个词 / 手机线索 + 动作）；
 *   · 反向靠 `phone-intent.guardReason()`（问句/否定/过去/转述/陈述/假设/未来，规则只写一份）；
 *   · **纯函数**：不碰手机、不碰模型、不读写磁盘，自检 0.1 秒。
 *
 * 取舍（写在方案 §4.1 里，别改）：**宁可漏，不可错。**
 * 漏了 = 她还是"不会"（现状）；错了 = 她乱动、插队打断自己那一场、烧 20 步。
 * 所以 P0 **不接小模型**：模型判"这句话是不是任务"本身要一次调用，还可能把闲聊判成任务。
 */

'use strict';

const intent = require('./phone-intent.cjs');

const DEFAULTS = {
  /** 关掉就完全退回 11-12 之前的行为（只跑 `ownerCommands`）—— 一个开关就能回滚。 */
  enabled: true,
  /** P0 不用模型判"这是不是任务"（见文件头）。留着这个键是为了 P2 能开。 */
  model: false,
  maxLen: 60,
  /** 把"差点就是任务"的句子记一行，一周看一次，别天天加规则。 */
  audit: true,
};

/** 配置归一（老配置里没有 `gate` 这一段也能跑）。 */
function cfg(raw) {
  const c = (raw && typeof raw === 'object') ? raw : {};
  return {
    enabled: c.enabled !== undefined ? !!c.enabled : DEFAULTS.enabled,
    model: !!c.model,
    maxLen: Math.max(20, Math.min(200, Number(c.maxLen) || DEFAULTS.maxLen)),
    audit: c.audit !== undefined ? !!c.audit : DEFAULTS.audit,
  };
}

/** 手机线索（"这句话跟手机有关"）。 */
const PHONE_CUE = /(手机|桌面|屏幕|这一页|这一屏|图标|app|应用|相册|图库|浏览器|日记|设置|文件|壁纸|相机|b站|视频|亮度|音量)/i;
/** 动作词。 */
const ACT = /(打开|点开|点|看|翻|搜|查|找|截|拍|写|调|换|关|开|进|退|返回|滑|读)/;

/**
 * P1：**明确祈使开头 + 手机线索 + 动作**。
 * ⚠️ 三个条件缺一不可 —— 少一个就会把「你去睡吧」当成任务。
 */
const P1_HEAD = /^(?:现在|马上|这就|先|帮我|给我|麻烦你?|请你?|你)?(?:去|到|回|打开|点开|看看|翻翻|搜|查|找|截|拍|把)/;
/**
 * P2：「打开/点开/进 + 一个词」。
 *
 * ⚠️ **不要**把 `去|到|看看|翻翻|搜|查|找` 放进这里：否则「你去睡吧」「看看你」
 * 全会被当成任务。那些走 P3（必须同时有手机线索）。
 * 尾巴只允许 `看看 / 看一下 / 瞧瞧 / 里面有(什么)` 这类**宾语尾巴**，
 * 这样「打开菜谱看看有什么」和「打开菜谱看看」是同一件事。
 */
const P2_RX = /^(?:帮我|给我|麻烦你?|请你?|现在|先)?(?:打开|点开|进)\s*([^\s，。！？]{1,10}?)(?:看看|看一下|瞧瞧|瞅瞅|吧|呗|一下)?(?:里面|里头)?(?:有什么|有啥|是什么|有些什么)?$/;
/** P2 的"词"不许是这些（「打开吧」「点开一下」不是让你开一个 App）。 */
const P2_STOP = /^(?:吧|呗|一下|看看|瞧瞧|它|这个|那个|里|里面|什么|啥|开|点|了|的)$/;

/** "那是陪他 / 跟他一起"，不是她用手机。 */
const TOGETHER = /(陪我|和你|跟你|一起|我们|咱)/;
/** 元讨论（在聊"这东西怎么运作"，不是让她做）。 */
const TOPIC = /(机制|原理|触发|功能|怎么用|是什么意思)/;
/** 抽象/器物宾语（"把灯打开"）。 */
const NOT_PHONE = /(话匣子|心结|局面|思路|天窗|电脑|笔记本|电视|台灯|灯|空调|窗帘|窗|门锁|门)/;
/** 那是"把手机递给我"，不是"用手机做点什么"。 */
const HANDOVER = /(?:给我|拿来|递给我|借我)(?:你的)?(?:手机|手机壳|充电器)|(?:手机|手机壳|充电器)(?:给我|拿来|递给我|借我)/;
/** "让我看看你的手机/屏幕" = 截图/描述，不是任务。 */
const LOOK_PHONE = /(?:给我|让我|帮忙)?(?:看|瞧|瞄)(?:看|一眼|一下)?(?:你的|你)的?(?:手机|屏幕)/;

/** 这条"差点就是任务"（句中有手机线索 + 动作词）—— 用来记 near-miss。 */
function looksNear(s) {
  return PHONE_CUE.test(s) && ACT.test(s);
}

/** 收尾：剥称呼/礼貌/语气尾巴，留下"这件事本身"。 */
function bareGoal(s) {
  let g = intent.bare(s);
  g = g.replace(/(?:一下吧|一下|吧|呗|哈|呀|啊|谢谢|好不好)+$/g, '').trim();
  return g || intent.clean(s);
}

/**
 * 他这一句到底是不是"让她用手机"。
 *
 * @param {string} text 他这一句（也可以是一个小句）
 * @param {object} ctx  `{ isOwner, isGroup, phoneUp, cfg }`
 *   · `phoneUp` 只影响调用方的决定（排不排），`gate` 自己**不碰手机**、也不判"排不排"；
 *   · `cfg` 是 `phone.gate` 那一段配置。
 * @returns {{kind:'task'|'none', why:string, goal:string, confidence:number, near:boolean}}
 */
function gate(text, ctx = {}) {
  const c = cfg(ctx.cfg);
  const s = intent.clean(text);
  const none = (why, extra) => ({ kind: 'none', why, goal: '', confidence: 0, near: false, ...extra });

  if (!s) return none('empty');
  if (!c.enabled) return none('disabled');
  if (!ctx.isOwner || ctx.isGroup) return none('not-owner');
  if (s.length > c.maxLen) return none('too-long');

  /**
   * 一句话里有好几个小句时，**逐句判、取第一件能做的**。
   * 调用方（`companion.phoneIntentHints`）本来也逐句调，这里只是让 gate 单独用也对
   * （真机「回桌面，点开那个蓝色的图标」第二句不能丢）。
   */
  const parts = intent.clauses(s);
  if (parts.length > 1) {
    for (const part of parts) {
      const r = gate(part, { ...ctx, cfg: c });
      if (r.kind === 'task') return r;
    }
    return none('no-clause');
  }

  /** ① 反向守卫（问句/否定/过去/转述/陈述/假设/未来）—— 规则只写一份，在 `phone-intent` 里。 */
  const reason = intent.guardReason(s, { allowGoalTail: true });
  if (reason) return none(reason, { near: looksNear(s) });

  /** ② "让我看看你的手机/屏幕" = 截图/描述，不是任务。 */
  if (LOOK_PHONE.test(s)) return none('look-at-her-phone');

  /** ③ 已被 `ownerCommands()` 认出来的，不再补第二件（避免同一句话排两遍）。 */
  if (intent.ownerCommands(s).length) return none('already-commanded');

  /** ④ 正向三种形状（命中即任务）。 */
  let goal = '';
  let confidence = 0;
  let shape = '';
  const p2 = P2_RX.exec(s);
  if (p2 && !P2_STOP.test(String(p2[1] || '').trim())) {
    shape = 'P2';
    confidence = 0.9;
    goal = bareGoal(s);
  } else if (P1_HEAD.test(s) && PHONE_CUE.test(s) && ACT.test(s)) {
    shape = 'P1';
    confidence = 0.9;
    goal = bareGoal(s);
  } else if (PHONE_CUE.test(s) && ACT.test(s)) {
    shape = 'P3';
    confidence = 0.7;
    goal = bareGoal(s);
  }
  if (!goal) return none('no-shape', { near: looksNear(s) });

  /**
   * ⑤ 认成任务之前再挡四类（这四条都是**真的会误动手机**的说法）。
   * 顺序：先挡"陪他 / 元讨论 / 不是手机 / 要手机"，再放行。
   */
  if (TOGETHER.test(goal)) return none('together');
  if (TOPIC.test(goal)) return none('topic');
  if (HANDOVER.test(goal)) return none('handover');
  if (NOT_PHONE.test(goal)) return none('not-phone');

  return { kind: 'task', why: shape, goal, confidence, near: false };
}

/** near-miss 的一行日志（`companion` 写进 `data/companion/phone/gate.jsonl`）。 */
function auditLine(text, res, at = Date.now()) {
  return JSON.stringify({ at, text: String(text || '').slice(0, 80), kind: (res && res.kind) || '', why: (res && res.why) || '' });
}

module.exports = {
  DEFAULTS, cfg, gate, auditLine, bareGoal,
  /** 自检直接看这几张表（别在测试里另抄一份）。 */
  PHONE_CUE, ACT, P1_HEAD, P2_RX, TOGETHER, TOPIC, NOT_PHONE, HANDOVER, LOOK_PHONE,
};
