/**
 * 她刷视频（2026-11-01；2026-11-01 傍晚第二版：会搜、会点进去、会回列表）
 *
 * 用户第一版的要求：「点开视频后能够以较低的 token 消耗看完主要内容，或者中途她不想看
 * 退出去换一个视频，尽量能按她自己的意愿来。」
 *
 * 用户第二版（16:56，读完这半小时的聊天之后）：「看视频还不熟，不喜欢不知道返回，
 * 搜索栏不会搜索，搜索后不知道点进去看……是不是需要操控的时候每次给她反馈一下
 * （这次目标是想找个好看的视频，我刚刚点进了哔哩哔哩，现在我该在主页下滑或者挑一个
 * 感兴趣的看），你看下如何让她更聪明点。」
 *
 * 傍晚真机日志暴露的三个真问题（`data\companion\phone\episodes.jsonl` + `pet.log`）：
 *   ① 16:41 那条"看了《大肥鱼美图》"，摘要写的是"B站搜索 '大肥鱼美图' 的结果页" ——
 *      **它把搜索结果页当成首页**，把联想词当成了视频标题，点进去的还是搜索页；
 *   ② 16:45 / 16:51 两次"点搜索框→输入→搜索"，8 步 104 秒没摸出来，
 *      其中一次 `操作员连不上模型：陪伴模型返回的不是 JSON` 直接把任务炸掉；
 *   ③ 从**搜索结果**点进去的视频是 `UnitedBizDetailsActivity`（详情页），不是竖屏故事流，
 *      "上滑换一个"在那里不起作用，而她又不会 `back` 回列表。
 *
 * 所以这一版做三件事：
 *   A. **确定性搜索**：`am start` 回首页 → 点搜索框（坐标/节点都认）→ `text` 关键词 →
 *      `key enter` → 等结果。不再让模型摸着找搜索框。
 *   B. **硬校验"真的在放视频"**：activity 命中 Story/Details，或这一屏有"发弹幕/点赞"这类
 *      播放页才有的东西；否则算没进去 —— **绝不把搜索页的截图当成视频内容**。
 *   C. **哪里进来就从哪里换**：竖屏故事流 `swipe up`；详情页 `key back` 回搜索结果/首页再挑。
 *
 * 成本（真接口实测，`tools\_probe-video-tokens.cjs`）：
 *   · 一帧 720/360/270 宽的 prompt **都是 234 token**（`detail:low` 归一，跟像素无关）；
 *   · 一次塞 3 帧 = **636**（212/帧）→ 每段固定 3 帧；
 *   · `deepseek-flash` 默认会先"想"，小 max_tokens 时内容为空 → 必须
 *     `thinking:{type:'disabled'}`（关掉后 275+43 token / 3.2 秒出 JSON）。
 *   一条短视频 ≈ 1.3k token；"搜一个词再看"多一次挑片调用（约 300 token）。
 *
 * 界面事实（B 站 9.17 / Android 12 / 720×1280，真机 dump 出来的，别自己发明）：
 *   · 首页卡片是 `ViewGroup`，`content-desc` 直接把标题/播放量/时长/UP 主拼好了：
 *     `视频,<标题>,208.7万观看,455弹幕,时长1分钟06秒,UP主小陈的脚凑凑的,`
 *     → 挑片和"她现在屏幕上有什么"**都是 0 token**；
 *   · 搜索框是顶部那个 `Search Icon <上次搜的词>`，bounds `120,48 - 528,136`；
 *   · 搜索结果卡片是 `<标题> <作者> <m:ss>`；
 *   · 首页点卡片 → `StoryVideoActivity`（竖屏，上滑下一个）；
 *     搜索结果点卡片 → `UnitedBizDetailsActivity`（详情页，`back` 回结果列表）；
 *   · 搜索结果页**按 back 回不到首页**（实测连按两下还在搜索页），回首页用
 *     `am start -n tv.danmaku.bili/.MainActivityV2`，实测 2.5 秒落到首页。
 */
const log = require('./log.cjs');
const { pickJson } = require('./phone-life.cjs');
/**
 * ★ 2026-11-07：**刷视频的那只手也是"她"的**。
 * 这里原来硬编码「你叫小肥鱼」+ `config.phone.taste` —— 又一套人格。
 * 现在和 `phone-agent` 一样：只拿 `handView` / `judgeView`（同一份只读快照）。
 */
const personaMod = require('./companion-persona.cjs');
/** ★ 2026-11-01（深夜）：卡住时"看图自救"的规则和 `phone-agent` 共用一份。 */
const { rescueStep } = require('./phone-rescue.cjs');
/** ★ 2026-11-02：视频这条路上也要关弹窗（和 `phone-agent` 同一份规则）。 */
const popup = require('./phone-popup.cjs');

/** 视频 App：这台机器目前只装了这一个（`pm list packages -3` 实测）。 */
const BILI = 'tv.danmaku.bili';
const APP_NAME = '哔哩哔哩';
const HOME_ACTIVITY = `${BILI}/.MainActivityV2`;

/** 播放页（竖屏故事流 / 详情页）。 */
const STORY_ACT = /StoryVideo/i;
const DETAIL_ACT = /UnitedBizDetails|VideoPlayer|PlayerActivity/i;
/** 搜索页（B 站的搜索是一个独立 Activity，结果也在这里）。 */
const SEARCH_ACT = /BiliMainSearchActivity|Search/i;
/** 首页。 */
const FEED_ACT = /MainActivityV2|MainActivity/i;

/** 搜索框的兜底坐标（720×1280 实测中心；节点找到时以节点为准）。 */
const SEARCH_BOX = { x: 324, y: 92 };

const DEFAULTS = {
  enabled: true,
  /** 一次会话最多看几条。 */
  maxVideos: 2,
  /** 整个会话最多几次模型调用（挑 1 + 每条 ≤2 + 搜关键词 0~1）。 */
  maxCalls: 5,
  /** 整个会话的时间上限。 */
  maxMs: 4 * 60_000,
  /** 单条视频最多看这么久。 */
  perVideoMs: 70_000,
  /** 每段几帧（实测 3 帧 636 token）。 */
  frames: 3,
  /** 单条最多抽几帧（= 两段）。 */
  maxFramesPerVideo: 6,
  /** 两帧之间隔多久。 */
  gapMs: 3_500,
  /** 截图缩到多宽再发（不影响 token，只省带宽/时间）。 */
  width: 360,
  /** 兴趣分低于这个数就滑走。 */
  likeMin: 0.45,
  /** 挑视频时最多给她几个标题。 */
  maxChoices: 8,
  /** 搜索后等结果多久（毫秒）。 */
  searchWaitMs: 3_500,
};

function normalize(raw = {}) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const out = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS)) {
    if (r[k] === undefined || r[k] === null || r[k] === '') continue;
    if (typeof DEFAULTS[k] === 'number') {
      const n = Number(r[k]);
      if (Number.isFinite(n) && n >= 0) out[k] = n;
    } else if (typeof DEFAULTS[k] === 'boolean') {
      out[k] = !!r[k];
    } else {
      out[k] = r[k];
    }
  }
  out.frames = Math.max(1, Math.min(4, Math.round(out.frames)));
  out.maxFramesPerVideo = Math.max(out.frames, Math.round(out.maxFramesPerVideo));
  out.maxVideos = Math.max(1, Math.min(4, Math.round(out.maxVideos)));
  out.maxCalls = Math.max(2, Math.min(10, Math.round(out.maxCalls)));
  out.maxChoices = Math.max(3, Math.min(10, Math.round(out.maxChoices)));
  out.likeMin = Math.max(0, Math.min(1, Number(out.likeMin) || 0));
  out.width = Math.max(180, Math.min(720, Math.round(out.width)));
  return out;
}

/** 她这句话是不是"想刷视频"（给 `companion.handlePhoneTag` 分流用）。 */
function isVideoGoal(text) {
  const s = String(text || '');
  /**
   * ★ 2026-11-08 夜（真机 23:15–23:17）：**「打开哔哩哔哩」被当成"要看视频"**。
   *
   * 旧规则里有一条 `(?:去|在|上|开)?\s*(?:b站|哔哩)` —— 只要句子里出现"哔哩"就算看视频。
   * 于是他连着说三遍「打开哔哩哔哩」，三次都被塞进 `phone-video`：
   * 那一场要先"回到 B 站首页"（`am start MainActivityV2` 失败 → 连按三次 back → 退出了 App），
   * 19~26 秒后报「没看成（回不到首页）」，**0 次调用**，一次也没真打开。
   * 现在「哔哩/B站」只有在**前后 8 个字里带看/刷/瞧/逛逛**时才算"要看视频"；
   * 单纯"打开哔哩哔哩"走 `phone-agent` 的 `launch`（0 步 1 秒）。
   */
  const watchNear = (m) => {
    const before = s.slice(Math.max(0, m.index - 8), m.index);
    const after = s.slice(m.index + m[0].length, m.index + m[0].length + 8);
    return /看|刷|瞧|逛逛|翻翻/.test(before) || /看|刷|瞧|逛逛|翻翻/.test(after);
  };
  const bili = /(b站|哔哩哔哩|哔哩)/i.exec(s);
  if (bili && watchNear(bili)) return true;
  return /看.{0,6}视频|刷.{0,6}视频|视频.{0,4}(?:看看|看会|看一)|(?:看|刷).{0,3}短视频/i.test(s)
    /**
     * ★ 2026-11-02（真机）：**「退出去换一个视频看」没被认出来**，于是它走了 `phone-agent`
     * —— 那边没有"这是第几个视频"的概念，结果 back → 点 → back → 点，同一个视频来回了五次。
     * 下面这几种说法都是"换一个视频"，一律交给 `phone-video`（它知道怎么换）。
     */
    || /视频.{0,6}看|换.{0,4}(?:个|条|一个).{0,3}视频|下(?:一)?(?:个|条).{0,3}视频|视频.{0,3}(?:换|下一个|下一条)/.test(s);
}

/* ------------------------------------------------------------ 纯函数（自检直接断言） */

/** 时长 `3:35` / `1:02:03` → 秒；认不出回 0。 */
function durationSec(text) {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(text || '').trim());
  if (!m) return 0;
  return m[3] ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : Number(m[1]) * 60 + Number(m[2]);
}

/** `1分钟06秒` / `2小时06分钟46秒` / `34分钟03秒` → 秒。 */
function cnDuration(text) {
  const s = String(text || '');
  const h = /(\d+)\s*小时/.exec(s);
  const m = /(\d+)\s*分钟/.exec(s);
  const sec = /(\d+)\s*秒/.exec(s);
  if (!h && !m && !sec) return 0;
  return (h ? Number(h[1]) * 3600 : 0) + (m ? Number(m[1]) * 60 : 0) + (sec ? Number(sec[1]) : 0);
}

/** 播放量 `216.4万` / `1.5万` / `912` → 数字。 */
function playCount(text) {
  const s = String(text || '').replace(/\s+/g, '');
  const m = /^([\d.]+)(万|亿)?$/.exec(s);
  if (!m) return 0;
  const n = Number(m[1]) || 0;
  return Math.round(n * (m[2] === '亿' ? 1e8 : m[2] === '万' ? 1e4 : 1));
}

/**
 * 一屏节点 → 能点的视频卡片。
 *
 * 两种真机形状都认（`phone-video` 的两条入口各一种）：
 *   ① 首页：`desc = "视频,逃离清华13-24合集共120+分钟,6.9万观看,372弹幕,时长2小时06分钟46秒,UP主霉冥_,"`
 *   ② 搜索：`text = "偷摸小肥鱼尾巴 末儿克丝Morx 0:44"`
 * 广告卡片（`广告/查看详情/推广`）直接丢掉，不然她会"看"一条广告。
 */
function parseCard(node) {
  const raw = String(node?.desc || node?.text || '').replace(/\s+/g, ' ').trim();
  if (!raw) return null;
  if (/广告|查看详情|推广|同款好物/.test(raw)) return null;

  /**
   * ⚠️ 首页那条 desc 的**分隔符是半角逗号**，而标题里经常带全角逗号
   * （`视频,小傻龙："人"，我养不起大肥鱼了……,208.7万观看,...`）。
   * 所以只能按半角 `,` 切，不能写 `[^,，]+` —— 那会把标题切掉一半。
   */
  const parts = raw.split(',');
  /**
   * ⚠️ 2026-11-01 真机：**`直播` 不在这个白名单里**。
   * 直播卡片点进去是 `LiveRoomActivityV3`（不是视频页），22:37 那次就是点了它、
   * 然后整场"没看成"。宁可少一个候选，也不要"点进去再判错"。
   */
  if (parts.length >= 3 && /^(?:视频|竖版视频|互动视频|番剧|影视)$/.test(parts[0].trim())) {
    const title = String(parts[1] || '').trim();
    const views = (/^([\d.]+[万亿]?)/.exec(String(parts[2] || '').trim()) || [])[1] || '';
    if (title.length >= 2) {
      const up = (/UP主([^,]+)/.exec(raw) || [])[1] || '';
      const durText = (/时长([^,]+)/.exec(raw) || [])[1] || '';
      return {
        kind: 'feed',
        title,
        views,
        up: up.trim(),
        duration: durText.trim(),
        seconds: cnDuration(durText),
        ref: node.ref || '',
        bounds: node.bounds,
        center: node.center || centerOf(node.bounds),
        raw,
      };
    }
  }

  const m = /^(.+?)\s+(\S+)\s+(\d{1,2}:\d{2})$/.exec(raw);
  if (m) {
    return {
      kind: 'search',
      title: m[1].trim(),
      views: '',
      up: m[2],
      duration: m[3],
      seconds: durationSec(m[3]),
      ref: node.ref || '',
      bounds: node.bounds,
      center: node.center || centerOf(node.bounds),
      raw,
    };
  }
  return null;
}

function centerOf(bounds) {
  const b = Array.isArray(bounds) ? bounds : [];
  if (b.length < 4) return [0, 0];
  return [Math.round((b[0] + b[2]) / 2), Math.round((b[1] + b[3]) / 2)];
}

/** 一屏节点 → 去重后的卡片列表（保持屏幕顺序）。 */
function cardsOf(nodes, { max = 8, kind = '' } = {}) {
  const out = [];
  for (const n of Array.isArray(nodes) ? nodes : []) {
    const c = parseCard(n);
    if (!c) continue;
    if (kind && c.kind !== kind) continue;
    if (out.some((x) => x.title === c.title)) continue;
    out.push(c);
    if (out.length >= max) break;
  }
  return out;
}

/** 这一屏是不是播放页（**硬校验**：宁可说没进，也不把搜索结果当视频）。 */
function inVideo(obs) {
  const act = String(obs?.app?.activity || '');
  /** 直播间明确不是"看视频"（`LiveRoomActivityV3` 之流）—— 22:37 就栽在这。 */
  if (/LiveRoom|bililive/i.test(act)) return false;
  if (STORY_ACT.test(act) || DETAIL_ACT.test(act)) return true;
  const blob = (obs?.nodes || []).map((n) => `${n.text || ''} ${n.desc || ''}`).join(' ');
  // 播放页才有的东西：发弹幕条 + 点赞/投币/收藏 这一排
  return /点我发弹幕|发弹幕/.test(blob) && /点赞|投币|收藏/.test(blob);
}

/** 模型返回的判断，容错（缺字段也用；坏 JSON 返回 null）。 */
function parseJudge(text) {
  const j = pickJson(text);
  if (!j || typeof j !== 'object') return null;
  const gist = String(j.gist || j.summary || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  const like = Math.max(0, Math.min(1, Number(j.like ?? j.score) || 0));
  const next = /^(?:skip|滑|换)/i.test(String(j.next || '')) ? 'skip' : 'watch';
  return { gist, like, next };
}

/** 她挑第几个（模型返回 {"pick":2}）。越界/坏值 → -1。 */
function parsePick(text, count) {
  const j = pickJson(text);
  if (!j) return -1;
  const n = Number(j.pick ?? j.index ?? j.i);
  if (!Number.isFinite(n)) return -1;
  const i = Math.round(n);
  return i >= 0 && i < count ? i : -1;
}

/**
 * 这一句里她想搜什么。
 *
 * 真机原话长这样：`返回首页，点搜索框，输入小肥鱼，再搜索` ——
 * 所以先认 `输入 X`，再认 `搜 X`；`搜索框/搜索栏` 不算词，`找个视频看看` 也不算词。
 * 认不出就返回空串：**不搜**，直接在首页挑（少一次调用、也少一堆失败点）。
 */
function searchTerm(goal) {
  const s = String(goal || '');
  const cands = [];
  const patterns = [
    /输入\s*[：:"'“「]?\s*([^，。,.、；;\s]{2,12})/,
    /搜(?:索)?(?:一下)?\s*[：:"'“「]?\s*([^，。,.、；;\s]{2,12})/,
    /找(?:一?个)?\s*[：:"'“「]?\s*([^，。,.、；;\s]{2,10})/,
  ];
  for (const re of patterns) {
    const m = re.exec(s);
    if (m) cands.push(m[1]);
  }
  for (const raw of cands) {
    const word = String(raw)
      .replace(/[，。,.、；;：:]/g, '')
      .replace(/^(?:一个|个)/, '')
      // "搜小肥鱼看看" 里那个"看看"是语气，不是词
      .replace(/(?:看一下|看看|看吧|吧|呢|吗)$/, '')
      .trim();
    if (!word) continue;
    if (/^(?:索|栏|框|一下|下|个|点|视频|看看|什么|啥)$/.test(word)) continue;
    if (/搜索|输入|返回/.test(word)) continue;
    return word.slice(0, 12);
  }
  return '';
}

/** 一条视频看完后的一句话（给回灌用）。 */
function phraseOf(v) {
  const title = String(v.title || '一个视频').replace(/\s+/g, '');
  const sec = Math.max(1, Math.round((Number(v.watchedMs) || 0) / 1000));
  const gist = String(v.gist || '').trim();
  const why = v.next === 'skip'
    ? (v.like < (v.likeMin ?? 0.45) ? '没意思，滑走了' : '看够了，换了')
    : '看完了';
  return `《${title}》${gist ? `：${gist}` : ''}（看到 ${sec} 秒，${why}）`;
}

/** 整场会话的汇总。 */
function summarize(videos) {
  const list = (Array.isArray(videos) ? videos : []).filter(Boolean);
  if (!list.length) return '没看成视频';
  return `刷了 ${list.length} 条视频。${list.map(phraseOf).join('；')}`.slice(0, 400);
}

/* ------------------------------------------------------------ 主体 */

class VideoWatcher {
  /**
   * @param {object} o
   * @param {object} o.adb          `PhoneAdb`（或同形状假货：state/observe/screenshot/tapXY/swipeDir/key/launch/sh）
   * @param {object} o.model
   * @param {Function} o.callModel  (model, messages, opts) => {text, raw}
   * @param {string} [o.taste]
   * @param {Function} [o.shrink]
   * @param {Function} [o.emit]
   * @param {Function} [o.sleep]
   */
  /**
   * ★ 2026-11-02：**跨场次**记着最近看过哪些视频（由 `companion` 传一个长期存在的 Set 进来）。
   *
   * 他说「换一个视频看」时，每一场都是**新的 watcher**（新的 `seen`）——
   * 不带着旧账就会把刚才那条再点一遍（真机就是这么来回五次的）。
   * ⚠️ 故意**不做成模块级全局**：那样自检之间会互相污染（这一区就跑挂过）。
   */
  constructor({ adb, model, callModel, taste = '', persona = null, cfg = {}, shrink = null, emit = () => {}, sleep = null, now = null, recent = null }) {
    this.recentRef = recent instanceof Set ? recent : null;
    this.adb = adb;
    this.model = model;
    this.callModel = callModel;
    /**
     * ★ 2026-11-07：这一场的只读人格快照（和 `phone-agent` 同一份）。
     * 对不上就不接：`this.persona = null`，退回旧 taste（只在没有快照时兜底）。
     */
    this.persona = (persona && personaMod.checkSame(persona, 'hand').ok) ? persona : null;
    this.taste = String(taste || '');
    this.cfg = normalize(cfg);
    this.shrink = shrink;
    this.emit = emit;
    this.sleep = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = now || (() => Date.now());
    /**
     * ★ 2026-11-01（深夜）：卡住时的"看图自救"和 `phone-agent` 用**同一条规则**
     * （`phone-rescue.cjs`）。配置也共用 `phone.rescue`；这里按"一场会话"计次数。
     */
    this.rescueCfg = { enabled: true, max: 10, width: 360, ...(cfg && cfg.rescue ? cfg.rescue : {}) };
    this.reset();
  }

  /**
   * ★ 2026-11-08 夜（真机 23:16:31）：「那你现在返回首页，返回桌面」——
   * 她回的是"没接（正在看视频）"。他让她回桌面，她**必须**回桌面（手机只有一只手，
   * 视频那边再看下去就变成"他说的不算"）。这里给一个外部停止闸：
   * 置 `stopped` 后，视频在下一个检查点收尾；上层可以立刻把"回桌面/返回"交给 `phone-agent`。
   */
  stop() {
    this.stopped = true;
    return { ok: true };
  }

  reset() {
    this.calls = 0;
    this.promptTokens = 0;
    this.completionTokens = 0;
    this.videos = [];
    this.stopped = false;
    /** 这一场是怎么进来的：`feed`（首页挑）/ `search`（搜了再看）。决定"换一个"怎么换。 */
    this.mode = 'feed';
    /** 搜索词（有就说明走了搜索路径）。 */
    this.term = '';
    /**
     * 这一场已经看过/点开过的标题。
     * ★ 2026-11-02：**跨场次也记着**（`recentRef` 是外面传进来的长期 Set）——
     * 他说「换一个视频看」时这一场是全新的，不带着旧账就会点回刚才那条。
     */
    this.recent = this.recentRef;
    this.seen = new Set(this.recentRef || []);
    /** 这一场试过但没进去的（给自救 prompt 用）。 */
    this.tried = [];
    /** 这一场用了几次自救。 */
    this.rescues = 0;
    /** 这一场的目标（自救 prompt 要用）。 */
    this.goal = '';
  }

  note(text, extra = {}) {
    if (!text) return;
    try { this.emit({ kind: 'video', text, at: this.now(), ...extra }); } catch { /* 面板坏了不影响看 */ }
  }

  async run({ goal = '', key = '', session = '' } = {}) {
    this.reset();
    this.goal = String(goal || '');
    const c = this.cfg;
    const startAt = this.now();
    const out = (ok, why = '') => ({
      ok,
      why,
      videos: this.videos,
      summary: ok ? summarize(this.videos) : `没看成视频（${why}）`,
      calls: this.calls,
      tokens: { prompt: this.promptTokens, completion: this.completionTokens },
      ms: this.now() - startAt,
      mode: this.mode,
      term: this.term,
      /** 这一场用了几次"看图自救"（上限见 `phone.rescue.max`）。 */
      rescues: this.rescues,
      key,
      session,
    });

    if (!c.enabled) return out(false, '看视频没开');

    const entered = await this.enter();
    if (!entered.ok) return out(false, entered.why);

    /**
     * ★ "搜一个词再看"：这句话里有明确的搜索词就走搜索。
     * 没写搜索词就**不搜**（首页直接挑，省一次调用、也少一堆失败点）。
     */
    const term = searchTerm(goal);
    if (term) {
      const s = await this.search(term);
      if (s.ok) { this.mode = 'search'; this.term = term; }
      else log.warn(`手机视频：没搜成（${s.why}），改成在首页挑`);
    }

    for (let i = 0; i < c.maxVideos; i += 1) {
      if (this.now() - startAt > c.maxMs) break;
      if (this.calls >= c.maxCalls) break;

      const started = await this.openOne(goal);
      if (!started.ok) {
        if (!this.videos.length) return out(false, started.why);
        break;
      }

      const v = await this.watchOne(started, startAt);
      if (!v.ok) {
        if (!this.videos.length) return out(false, '截图看不到画面（可能黑屏或掉线）');
        break;
      }
      this.videos.push(v);
      this.note(`看完一条：${phraseOf(v)}`);
      if (this.stopped || v.broken) break;
      if (this.now() - startAt > c.maxMs) break;
      if (i + 1 >= c.maxVideos) break;

      const moved = await this.next();
      if (!moved) break;
    }

    if (!this.videos.length) return out(false, '一条都没看成');
    return out(true);
  }

  /* ---------------------------------------------------------- 进出 App / 页面 */

  async st() {
    try { return await this.adb.state(); } catch { return null; }
  }

  /** 打开 App 并**回到首页**（搜索页 back 退不出去，直接 am start 最稳）。 */
  async enter() {
    const s0 = await this.st();
    if (!s0 || !s0.online) return { ok: false, why: '手机没连上' };
    if (!s0.booted) return { ok: false, why: 'Android 还没启动完' };
    if (s0.app?.package !== BILI) {
      const r = await this.adb.launch(APP_NAME).catch(() => null);
      if (!r || r.ok === false) return { ok: false, why: `打不开「${APP_NAME}」` };
      for (let i = 0; i < 8; i += 1) {
        await this.sleep(1200);
        const s = await this.st();
        if (s?.app?.package === BILI) break;
      }
    }
    const home = await this.home();
    return home.ok ? { ok: true } : { ok: false, why: home.why };
  }

  /** 回首页：`am start MainActivityV2` → `monkey` 冷入口 → **只在人还在 B 站时**才按 back。 */
  async home() {
    const onFeed = (s) => !!(s && s.app?.package === BILI && FEED_ACT.test(s.app?.activity || '') && !SEARCH_ACT.test(s.app?.activity || ''));
    const inBili = (s) => !!(s && s.app?.package === BILI);
    if (typeof this.adb.sh === 'function') {
      const r = await this.adb.sh(`am start -n ${HOME_ACTIVITY}`, { timeout: 15000 }).catch(() => null);
      if (r && r.code === 0) {
        await this.sleep(1800);
        const s = await this.st();
        if (onFeed(s)) return { ok: true };
      }
    }
    /**
     * ★ 2026-11-08 夜：`am start -n …MainActivityV2` 这条**版本一换就可能失效**。
     * 真机 23:15–23:17 连着三次「没看成（回不到首页）」就是这么来的：
     * activity 起不来 → 连按三次 back → 直接退出 App → 判失败。
     * 现在多一条 Monkey 冷入口（不依赖 activity 名），并且**放宽判据**：
     * 只要人还在 B 站、而且不在搜索页，就算到首页了（别为了一个 activity 名把整场作废）。
     */
    const l = await this.adb.launch(APP_NAME).catch(() => null);
    if (l && l.ok !== false) {
      await this.sleep(2200);
      const s = await this.st();
      if (onFeed(s)) return { ok: true };
      if (inBili(s) && !SEARCH_ACT.test(s.app?.activity || '')) return { ok: true };
    }
    /**
     * ★ 2026-11-08 夜（用户：「每次打开了哔哩哔哩，然后等待一会儿**自己退出**了，压根不点视频看」）：
     *
     * 就是这里：确认不了"在首页"就**连按三次 back** —— 而那时候前台已经是**桌面**了，
     * 三下 back 什么也没退（或者把她刚打开的 App 退掉），整场 20 秒白跑。
     * 所以：**只在那个人确实还在 B 站里**时才按 back（那是为了退出搜索页/详情页）；
     * 人根本不在 B 站 → 再冷启动一次，还不在就如实说"打不开哔哩哔哩（前台是 X）"。
     */
    for (let i = 0; i < 3; i += 1) {
      const s0 = await this.st();
      if (!inBili(s0)) break;
      await this.adb.key('back').catch(() => {});
      await this.sleep(900);
      const s = await this.st();
      if (onFeed(s)) return { ok: true };
      if (inBili(s) && !SEARCH_ACT.test(s.app?.activity || '')) return { ok: true };
    }
    const last = await this.st();
    if (!inBili(last)) {
      const again = await this.adb.launch(APP_NAME).catch(() => null);
      if (again && again.ok !== false) {
        await this.sleep(2500);
        const s = await this.st();
        if (inBili(s) && !SEARCH_ACT.test(s.app?.activity || '')) return { ok: true };
      }
      const now = await this.st();
      return {
        ok: false,
        why: `打不开「哔哩哔哩」（现在前台是「${now?.app?.name || now?.app?.package || '别的'}」）`,
      };
    }
    return { ok: false, why: '回不到首页' };
  }

  /** 当前这一屏（一次 dump，0 token）。 */
  async look() {
    try {
      const o = await this.adb.observe({ shot: false });
      const s = await this.st();
      return o && o.ok ? { ...o, app: o.app || s?.app || {} } : { ok: false, nodes: [], app: s?.app || {} };
    } catch {
      const s = await this.st();
      return { ok: false, nodes: [], app: s?.app || {} };
    }
  }

  /**
   * 卡住时的一次"看图自救"（和 `phone-agent` **同一条规则**，见 `phone-rescue.cjs`）。
   *
   * 视频这条路上用在两个地方：① 几张卡片都点不进播放页；② "换一个"滑不动/退不回去。
   * 次数按**这一场会话**算（`phone.rescue.max`，默认 10），不占 `maxCalls`。
   *
   * @returns {Promise<object|null>} 变了之后的观测；没救成返回 null
   */
  async rescueOnce(reason = '') {
    const c = this.rescueCfg;
    if (!c.enabled || this.rescues >= Math.max(0, Number(c.max) || 0)) return null;
    const obs = await this.look();
    let asked = false;
    const r = await rescueStep({
      adb: this.adb,
      model: this.model,
      callModel: this.callModel,
      goal: this.goal || '看会儿视频',
      obs,
      tried: this.tried.slice(-3),
      where: String(obs?.app?.activity || ''),
      width: Number(c.width) || 360,
      onCall: () => { asked = true; },
    });
    if (!asked) return null;
    this.rescues += 1;
    if (!r) return null;
    this.note(`卡住了，我自己判断：${r.action}${reason ? `（${reason}）` : ''}`);
    return r.obs;
  }

  /**
   * 搜索：回首页 → 点顶部搜索框 → 打字 → 回车 → 等结果。
   * 每一步都验（框在哪、字进没进、结果出没出），不靠模型。
   */
  async search(term) {
    const q = String(term || '').trim();
    if (!q) return { ok: false, why: '没有搜索词' };
    const h = await this.home();
    if (!h.ok) return { ok: false, why: '回不到首页' };

    const obs = await this.look();
    const box = this.findSearchBox(obs);
    if (!box) return { ok: false, why: '没找到搜索框' };
    this.note(`去搜「${q}」`);
    await this.adb.tapXY(box.x, box.y).catch(() => null);
    await this.sleep(900);

    const typed = await this.adb.text(q).catch(() => null);
    if (!typed || typed.ok === false) return { ok: false, why: '字没打进去' };
    await this.sleep(700);
    await this.adb.key('enter').catch(() => {});
    await this.sleep(this.cfg.searchWaitMs);

    /** 验：要么在搜索 Activity，要么屏幕上已经有"结果卡片"（标题 + 时长）。 */
    const after = await this.look();
    const act = String(after.app?.activity || '');
    const cards = cardsOf(after.nodes, { max: 4 });
    if (SEARCH_ACT.test(act) || cards.length) return { ok: true, act, cards: cards.length };
    return { ok: false, why: `搜完还是没结果（${act || '未知页面'}）` };
  }

  /** 顶部那条搜索框：优先找 `Search Icon …` 的节点，找不到就用实测坐标。 */
  findSearchBox(obs) {
    for (const n of obs.nodes || []) {
      const t = `${n.text || ''} ${n.desc || ''}`;
      const b = Array.isArray(n.bounds) ? n.bounds : [];
      if (b.length < 4) continue;
      if (b[1] > 180 || b[3] - b[1] < 30) continue;
      if (!/Search Icon|搜索/.test(t)) continue;
      if (/^(?:搜索|返回|清除查询)$/.test(String(n.text || '').trim())) continue;
      return { x: Math.round((b[0] + b[2]) / 2), y: Math.round((b[1] + b[3]) / 2), node: n };
    }
    return { ...SEARCH_BOX, fallback: true };
  }

  /**
   * 开始看第 N 条：不在播放页就先挑一张点进去，然后**硬校验**确实进了播放页。
   */
  /**
   * ★ 2026-11-02（真机 21:24 被卡的那一屏）：**视频这条路上原本没有弹窗层**。
   *
   * B 站 21:21 那次只看了 1 条就收工：看完按 `back` 回首页时正好弹出
   * 「登录注册解锁更多精彩内容」，`candidates()` 在弹窗上找不到卡片 → 整场结束。
   * 现在每次挑视频/换视频之前都先清一次路（规则和 `phone-agent` 是同一份 `phone-popup`）。
   *
   * @param {object} [obs] 已经看过的这一屏（省一次 dump）；没有就自己看一眼
   * @returns {Promise<object>} 处理之后的观测
   */
  async dismissPopups(obs = null) {
    let cur = obs || (await this.look());
    try {
      const hit = popup.scan(cur, { screen: cur.screen });
      if (!hit) return cur;
      const c = hit.node.center || [0, 0];
      await this.adb.tapXY(c[0], c[1]).catch(() => null);
      await this.sleep(900);
      this.note(`自己关掉一个${hit.label}（${hit.text}）`);
      cur = await this.look();
      /** 点一下没关掉就再按一次 back（插屏多半认 back）。 */
      if (popup.scan(cur, { screen: cur.screen })) {
        await this.adb.key('back').catch(() => {});
        await this.sleep(800);
        cur = await this.look();
      }
    } catch { /* 关不掉就算了，别把看视频搅黄 */ }
    return cur;
  }

  /** 首页/搜索结果里往下滑一点，换一批卡片（故事流/播放页**不能**这么做）。 */
  async scrollFeed() {
    const s = await this.st();
    const act = String(s?.app?.activity || '');
    if (STORY_ACT.test(act) || DETAIL_ACT.test(act)) return false;
    await this.adb.swipeDir('up', { span: 0.45, ms: 520 }).catch(() => null);
    await this.sleep(1200);
    return true;
  }

  async openOne() {
    const obs = await this.dismissPopups();
    if (inVideo(obs)) {
      const ctx = this.screenText(obs);
      return { ok: true, title: ctx.title, up: ctx.up, activity: obs.app?.activity || '', resumed: true };
    }

    /**
     * ★ 只在这一屏**挑不出卡片**时才重新搜：刚搜完就再搜一次会把结果页冲掉，
     * 也白白多烧一次输入（第一版真机上就是这么重复搜了两遍）。
     */
    let cards = await this.candidates(obs);
    /**
     * ★ 2026-11-02：**这一屏的卡片都看过了** —— 往下滑一点换一批。
     * 以前 `candidates()` 在全都看过时会退回"全部卡片"，于是又点回同一条（真机来回五次）。
     */
    if (cards.length && cards.every((c) => this.seen.has(c.title)) && (await this.scrollFeed())) {
      cards = await this.candidates();
    }
    if (!cards.length) {
      const act = String(obs.app?.activity || '');
      if (SEARCH_ACT.test(act) && this.term) {
        const again = await this.search(this.term);
        if (!again.ok) return { ok: false, why: again.why };
        cards = await this.candidates();
      }
    }
    if (!cards.length) {
      /** 不在首页（详情页/别人的搜索页）就先回首页再挑。 */
      const h = await this.home();
      if (!h.ok) return { ok: false, why: h.why };
      cards = await this.candidates();
      if (!cards.length) return { ok: false, why: '这一屏没找到能点的视频' };
    }

    /**
     * ★ 2026-11-01（P0-2）：**点错了要自己退回去换一个**。
     *
     * 22:37 真机：点进直播间（`LiveRoomActivityV3`）→ 旧版整场直接返回"没看成"，
     * 只能等用户说"点返回，再试试"。现在：**back 回列表 → 换下一个候选**，最多试 3 个；
     * 如果点了根本没换页（还是首页），就不按 back（从首页按 back 会退出 App）。
     */
    const beforeAct = String(obs.app?.activity || '');
    let list = cards;
    let lastAct = '';
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (!list.length) break;
      const pick = await this.choose(list);
      this.note(`挑中《${pick.title}》${pick.seconds ? `（${pick.duration}）` : ''}`);
      await this.tapCard(pick);
      await this.sleep(2600);

      let after = await this.look();
      if (!inVideo(after)) {
        /** 有的卡片要点封面：拿标题中心再往上试一次。 */
        await this.tapCard(pick, { offsetY: -130 });
        await this.sleep(2400);
        after = await this.look();
      }
      lastAct = String(after.app?.activity || '');
      if (inVideo(after)) {
        this.markSeen(pick.title);
        const ctx = this.screenText(after);
        return {
          ok: true,
          title: ctx.title || pick.title,
          up: ctx.up || pick.up,
          activity: lastAct,
          seconds: pick.seconds,
        };
      }

      /** 不是播放页（直播间/广告/合集）：记住它，退回去，换一个。 */
      this.markSeen(pick.title);
      this.note(`《${pick.title}》不是视频页（${lastAct || '未知'}），退回去换一个`);
      if (lastAct !== beforeAct) {
        await this.adb.key('back').catch(() => {});
        await this.sleep(1200);
      }
      list = (await this.candidates()).filter((c) => !this.seen.has(c.title));
    }
    /**
     * ★ 2026-11-01（深夜）：几张卡片都点不进播放页 —— **先让她看图自救**（第一优先级），
     * 救回来了就接着看；救不回来才如实说没看成。
     */
    this.tried.push(`点了几张都没进视频（${lastAct || '未知'}）`);
    const fixed = await this.rescueOnce('几张都点不进去');
    if (fixed && inVideo(fixed)) {
      const ctx = this.screenText(fixed);
      this.note(`自己找回来了：${ctx.title || '视频页'}`);
      return { ok: true, title: ctx.title, up: ctx.up, activity: fixed.app?.activity || '' };
    }
    return { ok: false, why: `点开了但没进视频（${lastAct || '未知页面'}）` };
  }

  /** 记住"这条看过了"：本场 `seen` + 跨场 `recentRef`（最多留 60 条）。 */
  markSeen(title) {
    const t = String(title || '').trim();
    if (!t) return;
    this.seen.add(t);
    if (this.recentRef) {
      this.recentRef.add(t);
      if (this.recentRef.size > 60) this.recentRef.delete(this.recentRef.values().next().value);
    }
  }

  /**
   * 当前这一屏能挑的卡片（搜索页优先用结果，首页用推荐流；**优先没点开过的**）。
   * @param {object} [obs] 已经看过的这一屏（省一次 dump）
   */
  async candidates(seenObs = null) {
    const obs = seenObs || (await this.look());
    const act = String(obs.app?.activity || '');
    const want = SEARCH_ACT.test(act) ? 'search' : '';
    let cards = cardsOf(obs.nodes, { max: this.cfg.maxChoices, kind: want });
    if (!cards.length) cards = cardsOf(obs.nodes, { max: this.cfg.maxChoices });
    const fresh = cards.filter((c) => !this.seen.has(c.title));
    return fresh.length ? fresh : cards;
  }

  /** 她挑一个（一次小文本调用）。模型不可用/她没挑出来 → 第一个。 */
  async choose(cards) {
    if (cards.length <= 1) return cards[0];
    if (!this.model || this.calls >= this.cfg.maxCalls) return cards[0];
    const lines = cards.map((c, i) => {
      const bits = [`${i}.《${c.title}》`];
      if (c.up) bits.push(c.up);
      if (c.duration) bits.push(c.duration);
      if (c.views) bits.push(`${c.views}播放`);
      return bits.join(' · ');
    }).join('\n');
    const sys = [
      /**
       * ★ 2026-11-07：**她是"她"，不是第二个人格**。
       * 有只读快照就用 `handView`（1~2 锚 / 3 口味 / 1 看法），没有才退回旧 taste。
       */
      '你是她手机上的手，不是她本人；正在她自己手机上刷视频（不用回话，只做选择）。',
      this.persona
        ? personaMod.handView(this.persona, { brief: { goal: '刷会儿视频', src: 'session' } })
        : (this.taste ? `她的口味：${this.taste}` : ''),
      '只输出一个 JSON 对象，不要 Markdown、不要解释：{"pick":0,"why":"半句话"}',
    ].filter(Boolean).join('\n');
    const user = [
      this.mode === 'search' && this.term ? `你刚搜的是「${this.term}」。` : '你现在在首页推荐里。',
      '这一屏上的视频：',
      lines,
      `挑一个你最想点开的（0~${cards.length - 1}）。`,
    ].join('\n');
    try {
      const r = await this.callModel(this.model, [{ role: 'system', content: sys }, { role: 'user', content: user }], {
        temperature: 0.8, maxTokens: 80, thinking: { type: 'disabled' },
      });
      this.track(r);
      const i = parsePick(r?.text, cards.length);
      if (i >= 0) return cards[i];
    } catch (err) {
      log.warn(`手机视频：挑视频失败（${err.message}），点第一个`);
    }
    return cards[0];
  }

  /** 点一张卡片：先点它的中心，点不动再点上面（封面）。 */
  async tapCard(card, { offsetY = 0 } = {}) {
    const [x, y] = card.center || [0, 0];
    const hit = await this.adb.tapXY(Math.round(x), Math.round(Math.max(8, y + offsetY))).catch(() => ({ ok: false }));
    return !!(hit && hit.ok !== false);
  }

  /** 从这一屏读标题/UP/播放量（0 调用）。 */
  screenText(obs) {
    const nodes = obs?.nodes || [];
    const cards = cardsOf(nodes, { max: 1 });
    const all = nodes.map((n) => `${n.text || ''} ${n.desc || ''}`).join(' ');
    const up = (/UP主([^,，]+)/.exec(all) || [])[1] || '';
    const views = (/[\d.]+[万亿]观看/.exec(all) || [])[0] || '';
    return { title: cards[0]?.title || '', up: up.trim(), plays: views, texts: nodes.map((n) => n.text).filter(Boolean) };
  }

  /* ---------------------------------------------------------- 看一段 */

  async sampleFrames(n, deadline = 0) {
    const shots = [];
    const c = this.cfg;
    for (let i = 0; i < n; i += 1) {
      if (i > 0) {
        if (deadline && this.now() >= deadline) break;
        await this.sleep(c.gapMs);
      }
      let s = await this.adb.screenshot({}).catch(() => null);
      if (!s || !s.ok || !s.png) {
        await this.sleep(800);
        s = await this.adb.screenshot({}).catch(() => null);
      }
      if (!s || !s.ok || !s.png) continue;
      shots.push({ hash: s.hash || '', ...this.shrinkShot(s.png) });
    }
    return shots;
  }

  shrinkShot(pngBuf) {
    const c = this.cfg;
    try {
      const media = this.shrink
        ? null
        : require('./companion-media.cjs');
      const r = this.shrink
        ? this.shrink(pngBuf, 'image/png', { maxSide: c.width, force: true })
        : media.shrinkImage(pngBuf, 'image/png', { maxSide: c.width, force: true });
      if (r && r.buf) return { dataUrl: `data:${r.mime || 'image/jpeg'};base64,${r.buf.toString('base64')}`, bytes: r.buf.length };
    } catch { /* 缩不了就发原图 */ }
    return { dataUrl: `data:image/png;base64,${pngBuf.toString('base64')}`, bytes: pngBuf.length };
  }

  async judge(meta, shots, prev = '') {
    if (!shots.length) return { gist: '', like: 0, next: 'skip', why: 'no-shot' };
    const sys = [
      '你是她手机上的手，不是她本人；正自己拿着手机刷视频，没人跟你说话（只判断）。',
      this.persona
        ? personaMod.judgeView(this.persona, { goal: '刷会儿视频', screen: meta.title || '', verdict: false })
        : (this.taste ? `她的口味：${this.taste}` : ''),
      '看这几张截图，判断这段视频在演什么、你还想不想接着看。',
      '只输出一个 JSON 对象，不要 Markdown、不要解释：',
      '{"gist":"两句以内，说清这段在演什么（有字幕就照字幕，别编）","like":0.0,"next":"watch|skip"}',
      'like：你有多想看下去（0~1，按你自己的口味，别讨好）；next=watch 再看一会儿，skip=换一个。',
    ].filter(Boolean).join('\n');
    const lines = [`【这一屏】${meta.title ? `《${meta.title}》` : '（没读到标题）'}${meta.up ? ` · ${meta.up}` : ''}`];
    if (prev) lines.push(`【你上一段看到】${prev}`);
    lines.push('【下面是刚才这几秒的画面】');
    const content = [{ type: 'text', text: lines.join('\n') }];
    for (const s of shots) content.push({ type: 'image_url', image_url: { url: s.dataUrl, detail: 'low' } });

    try {
      const r = await this.callModel(this.model, [{ role: 'system', content: sys }, { role: 'user', content }], {
        temperature: 0.7, maxTokens: 200, thinking: { type: 'disabled' },
      });
      this.track(r);
      const j = parseJudge(r?.text);
      if (j) return j;
      log.warn('手机视频：模型没给出 JSON，换下一个');
      return { gist: '', like: 0, next: 'skip', why: 'bad-json' };
    } catch (err) {
      log.warn(`手机视频：判断失败（${err.message}）`);
      return { gist: '', like: 0, next: 'skip', why: 'model-fail' };
    }
  }

  async watchOne(started, sessionStart) {
    const c = this.cfg;
    const t0 = this.now();
    const obs = await this.look();
    const meta = this.screenText(obs);
    let gist = '';
    let like = 0;
    let next = 'watch';
    let frames = 0;
    let broken = false;
    const title = meta.title || started.title || '';

    for (let round = 0; round < 2; round += 1) {
      if (this.now() - t0 > c.perVideoMs) break;
      if (this.now() - sessionStart > c.maxMs) { this.stopped = true; break; }
      if (this.calls >= c.maxCalls) { this.stopped = true; break; }
      const n = Math.min(c.frames, c.maxFramesPerVideo - frames);
      if (n <= 0) break;
      const shots = await this.sampleFrames(n, t0 + c.perVideoMs);
      frames += shots.length;
      if (!shots.length) break;
      const j = await this.judge({ title, up: meta.up, plays: meta.plays }, shots, gist);
      if (j.gist) gist = j.gist;
      like = j.like;
      next = j.next;
      if (j.why) { broken = true; break; }
      if (next === 'skip') break;
      if (like < c.likeMin) { next = 'skip'; break; }
    }

    if (next !== 'skip' && like < c.likeMin) next = 'skip';
    return {
      ok: frames > 0,
      broken,
      title,
      up: meta.up || '',
      gist,
      like,
      next,
      likeMin: c.likeMin,
      watchedMs: this.now() - t0,
      frames,
      at: this.now(),
    };
  }

  /* ---------------------------------------------------------- 换一个 */

  /**
   * 换一条：
   *   · 竖屏故事流 → `swipe up`（原生下一个），标题变了才算换；
   *   · 详情页/搜索页 → `key back` 回列表（搜索页还留着关键词，下一轮直接挑下一条）；
   *   · 首页 → 什么都不用做，下一轮会重新挑。
   */
  async next() {
    const s = await this.st();
    const act = String(s?.app?.activity || '');
    if (STORY_ACT.test(act)) {
      const before = this.screenText(await this.look()).title;
      await this.adb.swipeDir('up').catch(() => {});
      await this.sleep(2200);
      const after = this.screenText(await this.look()).title;
      if (after && after !== before) return true;
      await this.adb.swipeDir('up').catch(() => {});
      await this.sleep(1800);
      const again = this.screenText(await this.look()).title;
      if (again && again !== before) return true;
      /** 滑不动了：让她看图自救一次（她可能发现"要往左滑/要点下一个"）。 */
      const fixed = await this.rescueOnce('换不了下一个');
      return !!(fixed && String(fixed.app?.package || '') === BILI);
    }
    if (DETAIL_ACT.test(act) || SEARCH_ACT.test(act)) {
      await this.adb.key('back').catch(() => {});
      await this.sleep(1600);
      /** ★ 2026-11-02：退回来的这一屏也可能盖着弹窗（登录墙/插屏），先清一下再看。 */
      await this.dismissPopups();
      const s2 = await this.st();
      if (s2?.app?.package !== BILI) {
        /** back 直接把 App 退没了：自救一次，能回到 B 站就继续。 */
        const fixed = await this.rescueOnce('退不回列表');
        return !!(fixed && String(fixed.app?.package || '') === BILI);
      }
      const a2 = String(s2.app?.activity || '');
      /** 回到首页说明搜索页没回来：还能在首页接着挑。 */
      return FEED_ACT.test(a2) || SEARCH_ACT.test(a2) || DETAIL_ACT.test(a2);
    }
    return true;
  }

  /** 记账：一次调用 + token（`callModel` 返回 `raw.usage`）。 */
  track(r) {
    this.calls += 1;
    const u = r?.raw?.usage || {};
    this.promptTokens += Number(u.prompt_tokens) || 0;
    this.completionTokens += Number(u.completion_tokens) || 0;
  }
}

module.exports = {
  DEFAULTS, BILI, APP_NAME, HOME_ACTIVITY, SEARCH_BOX,
  normalize, isVideoGoal, durationSec, cnDuration, playCount,
  parseCard, cardsOf, inVideo, parseJudge, parsePick, searchTerm,
  phraseOf, summarize, VideoWatcher,
  createVideoWatcher: (o) => new VideoWatcher(o),
};
