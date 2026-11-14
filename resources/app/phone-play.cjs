/**
 * 她玩手机 · 触发判定（纯函数，2026-11-12）
 *
 * 为什么不用 `phone-life.PLAY_RX` 那条裸正则：
 *   真机（11-10 ~ 11-12）里「突然自己玩」的一半是误触 ——
 *     · 「我差点以为你真不**偷玩手机**了」→ 开了
 *     · 「怎么样，好**玩吧**」→ 开了
 *     · 「我现在有点好奇你**玩手机的触发机制**了」→ 开了
 *   反过来他真说的「**去吧**」却什么都不开（她上一句刚说「我这就出去转转」）。
 *
 * 这一层只做一件事：**判断他这句话是不是"让她去玩手机"**。
 * 不碰 adb、不碰模型、不碰 `phone-life`（自检 0.1 秒跑完）。
 *
 * 设计照抄 `phone-intent.cjs` 的成功经验：
 *   · 短句（≤24 字）才可能是这种话；
 *   · 问句 / 否定 / 叙述 / 元讨论 / 过去 一律不认；
 *   · 「去吧」这种许可式，只有**她上一句说过要去**才认。
 */

'use strict';

/** 太长的句子不可能是"一句让她去玩"（多半是在聊天）。 */
const MAX_LEN = 24;

/**
 * 这不是命令的信号（真机语料）：
 *   「玩手机的触发机制」「不偷玩手机」「好玩吧」「你玩手机还是不太会」…
 */
const META = [
  /好玩|不好玩|偷玩|爱玩|玩手机(?:的|是|会不会)/,
  /玩[^，。]{0,4}(?:机制|意思|区别|原因)|触发/,
  /我自己|我这边|我这儿|我手上|我手机|我差点|以为/,
  /刚才|刚刚|上次|昨天|前天|以前|之前|已经|前几天/,
  /怎么|为什么|为啥|是不是|会不会|有没有|要不要|该不该|玩没玩|玩过没/,
  /说什么|讲|教|应该|好奇/,
  /不太会|不会|不懂|不熟|不顺手|困难|卡住|有问题|坏了|没反应/,
];

/** 否定/叫停（真正的 stop 由 `phone-life.STOP_PLAY_RX` 处理，这里只做"别认成 play"）。 */
const NEG = /^(?:先)?别|不要|不用|甭|算了|停一下|放下手机/;

/** 「陪我玩一会儿」是叫她陪他，不是让她自己去玩手机。 */
const TOGETHER = /陪我|和你|跟你|一起|我们|咱|陪我玩/;

/**
 * 明确的祈使句。四个形状（真机话术）：
 *   去玩吧 / 去玩会儿 / 去玩一会儿手机
 *   你随便玩吧 / 你自己玩去 / 随便玩玩
 *   玩手机吧 / 拿手机玩去 / 玩会儿手机
 *   玩一会儿吧
 */
const COMMAND = [
  /^(?:你|现在|先|就)?(?:给我|自己|随便)?去(?:玩|耍)(?:一会?儿|会儿|一下|玩|去)?(?:手机)?(?:吧|呗)?$/,
  /^(?:你|现在|先|就)?(?:给我)?(?:自己|随便)(?:去)?(?:玩|耍)(?:一会?儿|会儿|一下|玩|去)?(?:手机)?(?:吧|呗)?$/,
  /^(?:你|现在)?(?:拿|用|玩)(?:起|上)?手机(?:玩)?(?:去吧|去|吧|呗)$/,
  /^(?:你|现在|先|就)?(?:自由|随便|自己|去)?玩(?:一会?儿|会儿|一下)?手机(?:吧|呗)?(?:[，,].*)?$/,
  /^(?:你)?玩(?:一会?儿|会儿|一下)(?:手机)?(?:吧|呗)?$/,
];

/**
 * 许可式：「去吧 / 去呗 / 行，去吧 / 那就去」。
 * **只有她上一句说要去**才算数（今天 20:01 那句「去吧」就靠这一条）。
 */
const PERMIT = /^(?:行|好|好吧|可以|嗯|那就?|那)?[，,、\s]*(?:去|去呗|去吧|去吧去吧|去玩吧?|去吧去吧|你就去|那你去)[\s。!！~～]*$/;
const SHE_SAID_GO = /(?:我|咱)(?:这|就|等会|待会)?(?:要|想|去|出去|去玩|去翻|去逛|去搜|去写|去挑|去瞅|去瞧)|我出去(?:转转|逛逛|翻翻|看看|溜达)|我去(?:转转|逛逛|翻翻|看看)|我这就(?:去|出去)/;

function clean(text) {
  return String(text || '').trim().replace(/^[，。！？!?、~～…：:\s]+/, '').replace(/[，。！？!?、~～…：:\s]+$/, '');
}

/**
 * 是不是一句"让她去玩"的祈使句。
 *
 * 真机上她听到的话并不都干干净净：
 *   · 「去玩手机吧，**看看顺不顺**」（11-02 那句）—— 后半句是补充；
 *   · 「你随便玩吧**你刚刚都没有点下去**」（11-08 23:33）—— 连标点都没有。
 * 所以除了整句，还要看**第一个标点之前**那半句；再放一个很窄的后缀（≤12 字、
 * 不含疑问词），只为了接住这两类真话术。副作用由 `META` 挡（"好玩吧"那种）。
 */
function commandHit(t) {
  if (COMMAND.some((rx) => rx.test(t))) return true;
  const head = t.split(/[，,。；;]/)[0].trim();
  if (head && head !== t && COMMAND.some((rx) => rx.test(head))) return true;
  const m = /^(.{2,18}?(?:吧|呗))(.{0,12})$/.exec(t);
  if (!m) return false;
  if (!COMMAND.some((rx) => rx.test(m[1]))) return false;
  const tail = m[2];
  return !/[？?]/.test(tail) && !/(吗|么|什么|是不是|怎么|为什么|呢)/.test(tail);
}

/**
 * @param {string} text 他这一句
 * @param {{lastHerLine?:string}} ctx 她上一句（用来认「去吧」这种许可）
 * @returns {{kind:'play'|'none', why:string, confidence:number}}
 */
function playIntent(text, { lastHerLine = '' } = {}) {
  const raw = String(text || '').trim();
  const t = clean(raw);
  const none = (why) => ({ kind: 'none', why, confidence: 0 });
  if (!t) return none('empty');
  if (t.length > MAX_LEN) return none('too-long');
  if (/[？?]\s*$/.test(raw) || /(?:吗|么|呢|嘛)\s*$/.test(t)) return none('question');
  if (NEG.test(t)) return none('negated');
  if (TOGETHER.test(t)) return none('together');
  /**
   * ★ 2026-11-12：**先看形状，再看"像不像聊天"**。
   * 「你随便玩吧**你刚刚都没有点下去**」是 11-08 的真句 —— 里面的"刚刚"
   * 会被 META 当成回忆挡掉；但它明明是一句"去玩"。
   */
  if (commandHit(t)) return { kind: 'play', why: 'command', confidence: 0.9 };
  if (META.some((rx) => rx.test(t))) return none('meta');

  if (PERMIT.test(t)) {
    const her = String(lastHerLine || '');
    if (her && SHE_SAID_GO.test(her)) return { kind: 'play', why: 'permission', confidence: 0.8 };
    return none('permission-without-context');
  }

  return none('not-a-command');
}

/** 兼容老调用方（`phone-life.looksLikePlay` 仍然是这个签名）。 */
function looksLikePlay(text, ctx) {
  return playIntent(text, ctx).kind === 'play';
}

module.exports = { playIntent, looksLikePlay, MAX_LEN, COMMAND, PERMIT, SHE_SAID_GO, META };
