/**
 * 拟人化的「怎么发」—— 只关心节奏，不关心内容。
 *
 * 真人发 QQ 不是一次糊一大段：
 *   1. 先"正在输入…"，时长跟字数有关，但不是精确正比；
 *   2. 长话分几条发，条与条之间停一下，偶尔走神停久一点；
 *   3. 深夜和白天的节奏不一样。
 *
 * 桌宠里也复用 `split()`：模型回一段话，按**她自己写的换行**分成几条，
 * 一条条打出来，比一口气堆在一个气泡里更像在说话。
 */

/** 深夜（本地时间）：回复会明显变慢。 */
const NIGHT_FROM = 2;
const NIGHT_TO = 7;
/** 中文手打大约 80~140ms/字；这里取偏快的 85。 */
const DEFAULT_MS_PER_CHAR = 85;

/**
 * 把一段话切成"她自己决定要发的"若干条。
 *
 * ★ 2026-10-29 用户："说多少、说几句、怎么分段，全让她自己判断。"
 * 所以这里**只认换行**：一行 = 一条消息，没有换行就一整条（哪怕很长）。
 * 不再按句号替她切长句，也不再合并"嗯。""我在。"这种短句 —— 那都是在替她分段。
 *
 * `max` 只是防模型抽风的兜底：超过就把最后几条并成一条（保留换行，不丢字）。
 */
function split(text, max = 6) {
  const raw = String(text || '').replace(/\r\n?/g, '\n').trim();
  if (!raw) return [];

  const parts = raw.split(/\n+/).map((s) => s.trim()).filter(Boolean);
  const cap = Math.max(1, Number(max) || 6);
  if (parts.length <= cap) return parts;

  // 超量：前 cap-1 条照发，剩下的并成最后一条（用换行保留她的分段感）
  const cut = cap - 1;
  if (cut <= 0) return [parts.join('\n')];
  return [...parts.slice(0, cut), parts.slice(cut).join('\n')];
}

/**
 * 按字数算"正在输入"要多久。
 *
 * ★ 2026-11-01：**小时数可以传进来**（`opts.hour`），默认读真实时钟。
 * 原来这里直接 `new Date().getHours()` —— 02:00~07:00 会 ×1.6，于是
 * ① 半夜跑自检整体变慢；② "深夜回复变慢"这条行为**没法测**（跑的时候是不是深夜全看运气）。
 * 现在自检传 `{hour: 3, jitter: 0}` 就能钉住它。
 */
function typingMs(text, opts = {}) {
  const n = [...String(text || '')].length;
  const min = opts.minMs ?? 1200;
  const max = opts.maxMs ?? 6000;
  const per = opts.msPerChar ?? DEFAULT_MS_PER_CHAR;
  const jitter = opts.jitter ?? 0.2;
  let ms = Math.min(max, Math.max(min, min + n * per));
  ms *= 1 + (Math.random() * 2 - 1) * jitter;
  const hour = Number.isFinite(Number(opts.hour)) ? Number(opts.hour) : new Date().getHours();
  if (hour >= NIGHT_FROM && hour < NIGHT_TO) ms *= 1.6;
  return Math.round(ms);
}

/** 条与条之间停多久；偶尔来一次长停顿。 */
function gapMs(opts = {}) {
  const [a, b] = opts.gapRange ?? [700, 2600];
  let ms = a + Math.random() * Math.max(0, b - a);
  const chance = opts.longGapChance ?? 0.25;
  if (Math.random() < chance) {
    const [c, d] = opts.longGapRange ?? [3000, 9000];
    ms += c + Math.random() * Math.max(0, d - c);
  }
  return Math.round(ms);
}

/** 默认停顿函数；测试里可以注入一个不睡的。 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class Humanizer {
  constructor(opts = {}) {
    this.enabled = opts.enabled !== false;
    this.burstMax = opts.burstMax ?? 6;
    this.opts = opts;
  }

  split(text) { return split(text, this.burstMax); }
  typingMs(text) { return typingMs(text, this.opts); }
  gapMs() { return gapMs(this.opts); }

  /**
   * 一条条发出去。`send` 失败会向上抛（调用方负责记 outbound-failed）。
   *
   * @param {string|string[]} text
   * @param {object} io
   * @param {(on:boolean)=>Promise<any>} [io.setTyping]
   * @param {(msg:string)=>Promise<any>} io.send
   * @param {(ms:number)=>Promise<void>} [io.sleep]
   * @returns {Promise<{sent:number, parts:string[]}>}
   */
  async say(text, { setTyping, send, sleep: wait = sleep } = {}) {
    const parts = Array.isArray(text) ? text.map((s) => String(s)).filter((s) => s.trim()) : this.split(text);
    if (!parts.length) return { sent: 0, parts: [] };
    if (!this.enabled) {
      for (const p of parts) await send(p);
      return { sent: parts.length, parts };
    }
    let sent = 0;
    for (let i = 0; i < parts.length; i += 1) {
      const p = parts[i];
      if (setTyping) { try { await setTyping(true); } catch { /* 有的网关不支持 */ } }
      await wait(this.typingMs(p));
      if (setTyping) { try { await setTyping(false); } catch { /* 同上 */ } }
      await send(p);
      sent += 1;
      if (i < parts.length - 1) await wait(this.gapMs());
    }
    return { sent, parts };
  }
}

module.exports = { Humanizer, split, typingMs, gapMs, DEFAULT_MS_PER_CHAR };
