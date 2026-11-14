/**
 * 唤醒判定 —— 什么消息值得她开口，什么消息只当没看见。
 *
 * QQ 群不是私聊：每条都回会刷屏，一条都不回又像死人。
 * 所以拆成几个独立条件，命中任意一个才醒：
 *
 *   owner        主人在说话（私聊/群聊都算）
 *   atMe         被 @ 或被引用
 *   poke         被戳一戳
 *   name         正文里叫了她的名字/昵称
 *   keyword      命中约定好的关键词
 *   question     像在提问（群聊里可选，默认不靠这个）
 *   probability  普通消息按概率随机醒（让她偶尔插一句，但别刷屏）
 *
 * 私聊默认每条都理；群聊默认只认 @/名字/戳/关键词，概率 5%。
 */

/** 中文里"像在提问"的粗略特征。 */
const QUESTION_HINTS = /[?？]|怎么|为什么|为啥|如何|是不是|能不能|可不可以|有没有|谁|哪儿|哪里|何时|多少/;

/**
 * @param {object} msg  `{key,isGroup,userId,name,text,isAtMe,isQuoteMe,isPoke}`
 * @param {object} cfg  陪伴配置
 * @returns {{wake:boolean, reason:string}}
 */
function shouldWake(msg, cfg = {}) {
  const text = String(msg.text || '');
  const uid = String(msg.userId || '');
  const owners = (cfg.ownerIds || []).map(String);
  const w = cfg.wake || {};

  if (owners.includes(uid)) return { wake: true, reason: 'owner' };
  if (!msg.isGroup) return { wake: true, reason: 'private' };

  if (msg.isAtMe || msg.isQuoteMe) return { wake: true, reason: 'atMention' };
  if (msg.isPoke) return { wake: true, reason: 'poke' };

  const hitName = (cfg.names || []).find((n) => n && text.includes(n));
  if (hitName) return { wake: true, reason: `name:${hitName}` };

  const hitKeyword = (cfg.keywords || []).find((k) => k && text.includes(k));
  if (hitKeyword) return { wake: true, reason: `keyword:${hitKeyword}` };

  // `groupAtOnly` 是旧名字（兼容 kit 的配置）；true = 群里不靠提问/概率醒
  const atOnly = w.groupAtOnly !== false;
  if (!atOnly && QUESTION_HINTS.test(text) && [...text].length >= 4) {
    return { wake: true, reason: 'question' };
  }
  const p = Number(w.probability) || 0;
  if (!atOnly && p > 0 && Math.random() < p) return { wake: true, reason: 'probability' };

  return { wake: false, reason: '' };
}

/** 把攒起来的几条拼成给模型的一段（带上说话的人）。 */
function joinBatch(items) {
  return (items || []).map((m) => {
    const who = m.name || m.userId || '某人';
    return `${who}：${String(m.text || '').trim()}`;
  }).join('\n');
}

module.exports = { shouldWake, joinBatch, QUESTION_HINTS };
