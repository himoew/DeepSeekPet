/**
 * 卡住时的"看图自救"（2026-11-01 深夜）
 *
 * 用户拍板的第一优先级：「让她自己判断接下来点哪里，还是退出……
 * 一次任务次数限制 10 次……比起几十张图的 tok 消耗，我更在意她能不能灵活的自己玩手机」。
 *
 * 为什么单独一个文件：**手机操作员和看视频两条路都要用它**。
 * 复制两遍的话，"问什么、认什么动作、怎么验"迟早会走样 —— 所以规则只写这一份。
 *
 * 它做的事只有一件：
 *   截一张当前屏（缩到 360 宽）→ 连同"这一屏能点的东西 + 目标 + 刚试过什么"问一次模型
 *   → 拿到一行动作 → 执行 → 再看一眼"屏变了吗"。
 *
 * ⚠️ 它**不记录**次数、不发事件、不碰任务状态：那些是调用方的事
 * （`phone-agent` 按任务计 10 次；`phone-video` 按一场会话计）。
 */
const log = require('./log.cjs');

/** 只允许"能往前走/能退"的动作；`done`/`ask`/`shot` 这类不归自救管。 */
const OK_VERBS = new Set(['tap', 'tapxy', 'key', 'launch', 'swipe']);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 把一句话的动作执行掉（**不经过** PhoneAgent.execute，免得带上"输入框特判/截图目标"那些分支）。
 * @returns {Promise<boolean>} 动作发出去了没有
 */
async function applyAction(adb, act, obs, screen) {
  const w = Number(screen?.width) || 720;
  const h = Number(screen?.height) || 1280;
  switch (act.verb) {
    case 'tap': {
      const node = (obs?.nodes || []).find((n) => n.ref === String(act.arg).trim());
      if (!node) return false;
      const c = Array.isArray(node.center) ? node.center : null;
      if (!c) return false;
      await adb.tapXY(c[0], c[1]);
      return true;
    }
    case 'tapxy': {
      const m = String(act.arg || '').trim().split(/\s+/).map(Number);
      if (m.length < 2 || !m.every((n) => Number.isFinite(n))) return false;
      if (m[0] < 0 || m[0] > 1 || m[1] < 0 || m[1] > 1) return false;   // 只认 0~1
      await adb.tapXY(Math.round(m[0] * w), Math.round(m[1] * h));
      return true;
    }
    case 'key':
      await adb.key(String(act.arg || '').trim());
      return true;
    case 'launch':
      await adb.launch(String(act.arg || '').trim());
      return true;
    case 'swipe':
      await adb.swipeDir(String(act.arg || '').trim());
      return true;
    default:
      return false;
  }
}

/**
 * 问一次、做一次。
 *
 * @param {object} o
 * @param {object} o.adb
 * @param {object} o.model
 * @param {Function} o.callModel
 * @param {string} o.goal            这一趟要干什么
 * @param {object} o.obs             当前观测（有 `shot.png` 就复用，没有就现截）
 * @param {string[]} [o.tried]       刚试过什么（最多取 3 条）
 * @param {string} [o.where]         她在哪一页（人话）
 * @param {number} [o.width]         图缩到多宽（实测不影响 token）
 * @param {number} [o.maxTokens]     输出上限（默认 60）
 * @param {number} [o.settleMs]      动作后等多久再验（默认 700）
 * @param {Function} [o.onCall]      每次真的问了模型就回调一次（调用方用它计次数）
 * @returns {Promise<{ok:boolean, action:string, obs:object|null, changed:boolean, why?:string}|null>}
 *   `null` = 这条路走不通（没图 / 模型没给动作 / 给了但执行不了），调用方去走固定退路。
 */
async function rescueStep({
  adb, model, callModel, goal = '', obs = null, tried = [], where = '',
  width = 360, maxTokens = 60, settleMs = 700, onCall = null,
} = {}) {
  if (!adb || !model || typeof callModel !== 'function') return null;

  let shot = obs?.shot?.png ? obs.shot : null;
  if (!shot) {
    try {
      const s = await adb.screenshot({});
      if (s && s.ok && s.png) shot = s;
    } catch { /* 截不到就用不了这条路 */ }
  }
  if (!shot || !shot.png) return null;

  const user = [
    `目标：${goal || '（没写）'}`,
    where ? `【你在哪】${where}` : '',
    (tried || []).length ? `已经试过：${(tried || []).slice(-3).join(' / ')}` : '',
    '这一屏能点的：',
    obs?.table || '（没有可点的东西）',
    '（截图是现在这一屏）',
  ].filter(Boolean).join('\n');
  const sys = [
    /* ★ 2026-11-07：这是"手"的急救 prompt，不是另一个人格（原来写着"你叫小肥鱼"）。 */
    '你是她手机上的手，不是她本人；正在自己手机上办事，现在卡住了。看截图判断：下一步点哪里能往前走；这一屏帮不上忙，就退一步。',
    '只输出一行，不要解释：',
    'tap n3 | tapxy 0.4 0.55 | key back | key home | launch 包名 | swipe up|down|left|right',
    '- 按钮在树里就用 tap；自绘的、树里没有的，用 tapxy 指你在截图里看到的位置（0~1，左上角是 0 0）',
    '- 进错页面就 key back；实在没路就 key home',
  ].join('\n');

  const content = [{ type: 'text', text: user }];
  try {
    const media = require('./companion-media.cjs');
    const small = media.shrinkImage(shot.png, 'image/png', { maxSide: Number(width) || 360, force: true });
    content.push({
      type: 'image_url',
      image_url: { url: `data:${small.mime || 'image/jpeg'};base64,${small.buf.toString('base64')}`, detail: 'low' },
    });
  } catch { /* 缩不了就发原图 */ }

  let out;
  try {
    out = await callModel(model, [{ role: 'system', content: sys }, { role: 'user', content }], {
      temperature: 0.3, maxTokens, thinking: { type: 'disabled' },
    });
  } catch (err) {
    log.warn(`手机：看图自救没问成（${err.message.slice(0, 60)}）`);
    return null;
  }
  if (typeof onCall === 'function') { try { onCall(); } catch { /* 记账失败不影响 */ } }

  // 循环引用：phone-agent 在本文件被它 require，所以 parseAction 只能用的时候再取
  const { parseAction } = require('./phone-agent.cjs');
  const act = parseAction(out && out.text);
  if (!act || !OK_VERBS.has(act.verb)) {
    log.info(`手机：看图自救没给出能用的动作（${String(out?.text || '').slice(0, 40)}）`);
    return null;
  }

  const before = obs?.hash || '';
  let applied = false;
  try { applied = await applyAction(adb, act, obs, obs?.screen); } catch (err) {
    log.warn(`手机：看图自救的动作没执行成（${err.message.slice(0, 60)}）`);
    return null;
  }
  if (!applied) return null;

  await sleep(settleMs);
  let next = null;
  try { next = await adb.observe({ shot: false }); } catch { /* 读不到就当没变 */ }
  const changed = !!(next && next.ok !== false && next.hash && next.hash !== before);
  return { ok: changed, action: act.line, obs: next || null, changed };
}

module.exports = { rescueStep, applyAction, OK_VERBS };
