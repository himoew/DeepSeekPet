/**
 * 她自己的手机生活（2026-10-31，P0「自己会玩」）
 *
 * 用户的原话：「她能够完成一连串的操作了，但是好像还是没有玩手机这个意识，
 * 只有我给她发明确的指令她才会动手。」
 *
 * 结论：她不是不会玩，是**没有理由、没有连续性、没有具体下一步**。
 * 这个文件只补这三样，一个字都不碰"手"（`phone-agent.cjs` 已经够用了）：
 *
 *   需求条（0 调用）→ 想干点什么（1 次调用，出 2~4 件具体的小事）
 *   → **先请示他，他点头才开跑**（2026-10-31 用户拍板）
 *   → 一件一件做（每件 3~5 步）→ 收尾：一条回灌 + 一天一条日记 + 一条自我观察
 *
 * 为什么是"tick 驱动"而不是"做完一件就排下一件"：
 * `PhoneAgent.finish()` 里是 `emit(...)` 之后**马上** `drain()`，在 emit 的回调里再 `enqueue`
 * 会和新任务抢 `this.task`（重入）。改成 60 秒看一次的轮询状态机：只看 `agent.state().busy`，
 * 简单、可测、进程崩了重启也能接着跑（状态全在 `life.json` 里）。
 *
 * 三个刻意的取舍：
 *   1. **提案即日计划**。文档里"日计划 + 会话说目标"是两次调用；这里合成一次 ——
 *      他批准的那几件事就是她今天的计划，不用再问一遍模型。
 *   2. **打开页面的那一步交给代码**（`pre.url`，0 调用、必成）。她只负责"看和挑"，
 *      这也是 10-31 实测里最容易掉链子的一步（打字、点搜索框）。
 *   3. **永远有一副兜底牌**（`THEMES[t].goals`）。模型抽风、JSON 解析失败、调用超时，
 *      都不至于让一次会话在第 0 步就死（11:41 那条自主任务就是这么 0 步死的）。
 *
 * 数据都在 `data/companion/phone/`：`life.json`（状态）+ `diary.jsonl`（日记）。
 */

const fs = require('node:fs');
const path = require('node:path');
const log = require('./log.cjs');
const phoneApps = require('./phone-apps.cjs');

const LIFE_FILE = 'life.json';
const DIARY_FILE = 'diary.jsonl';
const DIARY_KEEP_DAYS = 30;

/**
 * ★ 2026-11-01：`preOpen()` 里"等页面/App 起来"的沉降时间改成可注入。
 *
 * 真机要 2.5 秒（相册/浏览器冷启动确实得等）；自检里的假 adb 是同步返回的，
 * 于是 `18-phone-life` 光这一处就等 3 次 × 2.5 秒 = 7.5 秒，占那一区 98%。
 * 断言验的是"她有没有按顺序做那几件事"，跟等多久无关。
 */
const PREOPEN_MS = (() => {
  const n = Number(process.env.DSP_PHONE_PREOPEN_MS);
  return Number.isFinite(n) && n >= 0 ? n : 2500;
})();

/** ★ 2026-11-01：`preOpen()` 打不开同一个页面最多试几次（试完就不挡路了，见那个函数）。 */
const PREOPEN_TRIES = 2;

/**
 * 一次会话的预算（先到先停）。
 *
 * ★ 2026-11-02（第三批，用户拍板）：「**一次管用 15 分钟，无任何限制**，
 * 除非我中途说先别玩了」。所以：
 *   · 一次会话**不再只办一件小事**（那样批准一次只换来 40 秒），最多 3 件，
 *     时间上限由 `autonomy.sessionMin`（默认 15 分钟）决定；
 *   · 单件小目标的预算从 5 步 / 45 秒放宽到 8 步 / 120 秒 —— 配合滚动层（1 步能看 3 屏）。
 */
const SESSION = {
  maxMs: 25 * 60_000,
  maxCalls: 18,
  maxSteps: 40,
  maxShots: 3,
  maxItems: 3,
  /** 单件小目标的预算：8 步 / 120 秒（治"9 步原地打转"，但别掐太死）。 */
  item: { maxSteps: 8, maxCalls: 6, maxMs: 120_000 },
  /** 两件之间歇一下（像人，不像流水线）。 */
  gapMs: [8_000, 25_000],
  /** 单个子任务等这么久还没有结果，就当它失败了（agent 炸了/掉线）。 */
  itemTimeoutMs: 180_000,
  /** 提案等他点头最多等这么久，过时作废（不重复问）。**自由模式不用它**。 */
  proposalTtlMs: 30 * 60_000,
  /** 一次会话里最多主动分享几次（"她觉得特别有意思的"才发）。 */
  maxShares: 2,
  /** 两次主动分享之间至少隔这么久。 */
  shareGapMs: 3 * 60_000,
};

/**
 * 需求条：全部 0~100，代码里写死涨消，**不花模型**。
 *
 * 为什么不用"预测误差式好奇心"：那种在噪声环境里会退化成盯着一个画面看（Burda 2018）。
 * 人对"玩手机"的驱动其实很土 —— 无聊、想分享、有点好奇。
 */
const NEEDS = {
  /** 无聊：醒着就涨。 */
  boredom: { seed: 32, perMin: 0.3, threshold: 70, decay: 35, decline: 12 },
  /** 想分享：他安静得越久涨得越快。 */
  share: { seed: 26, perMin: 0.05, perSilentHour: 4, threshold: 65, decay: 30, decline: 10 },
  /** 好奇：一天一点，做过同类就掉一大截。 */
  curiosity: { seed: 44, perMin: 0.02, threshold: 60, decay: 25, decline: 8 },
};

/**
 * 活动库。**只放这台机器上真能做到的**（2026-10-31 实测的包列表）：
 * `mark.via` 浏览器、`com.android.gallery3d` 相册、`app.lawnchair` 桌面。
 * 没有应用商店、没有 QQ、没有播放器、没有文件管理器 —— 所以这里没有"逛商店/听歌/看视频"。
 *
 * `pre`：开跑前由代码先把这个页面/App 打开（0 调用、必成），她只负责"看和挑"。
 * 真机实测（13:5x）：靠她自己开网页/进相册，五步里有一半花在"找入口"上，很容易撞预算。
 *
 * 每条 goal 的措辞有讲究（也是真机撞出来的）：
 *   · **要截图的**必须出现"截一张" → `SHOT_GOAL` 才认，prompt 才会告诉她"该收尾了"；
 *   · **只是读/说的**别写"往下翻 / 打开 / 点进去"这类动作词 → 否则 `done` 会被
 *     "我还没动手，不能说弄完了"打回（真机：她读到了两条标题，却因为 0 步被判没做）。
 */
const THEMES = {
  album: {
    label: '翻相册',
    need: 'boredom',
    asks: ['我去翻翻相册好不好？', '想翻翻相册，行不行？', '我去看看相册里都有些什么'],
    pre: { launch: '相册' },
    goals: [
      '挑一张照片，说清这张里是什么',
      '挑一张最好看的，截一张发给他',
      '看看最近的两张，说说像不像我',
    ],
  },
  collect: {
    label: '挑图',
    need: 'share',
    asks: ['我想去挑几张图，行不行？', '去搜点表情包，挑一张好看的', '我去网上挑张图，一会儿给你看'],
    pre: { url: 'https://www.bing.com/images/search?q=%E5%B0%8F%E8%82%A5%E9%B1%BC' },
    goals: [
      '这一屏是一堆图片，挑一张像我的，截一张发给他',
      '这一屏是一堆图片，挑一张最顺眼的，截一张',
      '这一屏是一堆图片，挑一张最可爱的，截一张发给他',
    ],
  },
  browse: {
    label: '随便逛',
    need: 'curiosity',
    asks: ['我去网上逛逛', '我想出去转一圈，看看有什么好玩的', '去网上看看，行不行？'],
    pre: { url: 'https://www.bing.com/search?q=%E4%BB%8A%E5%A4%A9%E7%9A%84%E5%86%B7%E7%9F%A5%E8%AF%86' },
    goals: [
      // ★ 别写"搜索结果"：里面有"搜"，会撞上 `WANTS_ACTION`，`done` 就被当成"还没动手"打回（真机撞过）
      '这一屏是几行标题，挑两条你觉得有意思的，念给他听',
      '这一屏是几行标题，挑一条点进去，看看讲了什么',
      '这一屏是几行标题，挑一条有意思的，截一张发给他',
    ],
  },
};

/**
 * ★ 2026-11-12：**兜底牌**（模型抽风 / 离线 / 自检）。
 *
 * 不再是"三个主题 + 固定目标"，而是**四个方向**：她想去哪儿、大概干什么。
 * 真机上"玩什么"由 `CompanionBrain.planPhone` 用她自己的账决定，这里只保证
 * 「一句话都排不出来时也不是 0 步死」。
 */
const SEEDS = [
  { app: '相册', goal: '翻一翻最近的，看到什么就说什么', ask: '我去翻翻相册啊' },
  { app: '浏览器', goal: '搜一个你最近听到的词，读一条', ask: '我去网上搜个东西' },
  { app: '哔哩哔哩', goal: '看一会儿，挑一个看完能说一句的', ask: '我去看会儿视频' },
  { app: '她的日记本', goal: '翻一篇以前的看看，不想写就不写', ask: '我去翻翻本子' },
];

/** App 名 → 粗分类（统计 / 她手上那件事 / 老的 theme 兼容）。 */
function kindOfApp(app) {
  const k = String(app || '');
  if (/相册|图库|照片|相机/.test(k)) return 'album';
  if (/浏览器|网页/.test(k)) return 'browse';
  if (/哔哩哔哩|B站|视频/.test(k)) return 'video';
  if (/日记|本子/.test(k)) return 'diary';
  return 'open';
}

/** 这条需求现在偏向去哪个 App（只是**提示**，不是限制）。 */
function appHintFor(need) {
  if (need === 'share') return '浏览器';
  if (need === 'curiosity') return '哔哩哔哩';
  return '相册';
}

/** 她手上"没做完的那件事"。有进度，才叫连续性。 */
const FOCUS_POOL = [  /**
   * ★ 2026-10-31（第三轮，真机）：**措辞里不要放数字**。
   *
   * 原来写的是"挑 6 张像我的图"，模型看到就把它当成**这一次要办的事**，
   * 排出「从相册里挑 6 张像小肥鱼的图，凑够 6/6」「翻相册挑 6 张，数清楚挑了几张」——
   * 一整批的活，一件也验不了。现在只写"挑几张"，进度由代码按次累加。
   */
  { kind: 'collect', text: '多挑几张像我的图', goal: 6 },
  { kind: 'album', text: '把相册翻一遍', goal: 3 },
  { kind: 'browse', text: '多逛几个网页', goal: 5 },
];

/** 他点头。**必须先判否定**（"不行"里有"行"）。 */
const NO_RX = /^(?:不|别|甭|算了|免了|等等|等一下|等会儿|先别|没空|不用|不要|先不|下次|改天|回头)/;
/**
 * ★ 2026-11-01 修：**整句锚定，别把"好困啊 / 好累 / 行不行"判成点头**。
 *
 * 原来只有开头锚定 `^(?:行|好|嗯|…)`，实测这五句全被当成批准：
 * `好困啊` / `好累` / `好看吗` / `行不行` / `嗯我知道了`。一旦误判，就扣 35 点需求、
 * `approvedToday+1`、她真的开跑最多 25 分钟；`replyBatch` 还会把"他答应了"写进处境，
 * 她顺着说一句"那我去了"。
 *
 * 现在的形状：**若干个应允短语（可以用标点连着说，比如"行，去吧"）** + 语气词/标点收尾。
 * 于是 `好困啊`（"好"后面跟着"困"）当场不匹配，而 `没问题`、`行，去吧`、`嗯，你去吧` 照旧算点头。
 */
const YES_WORD = '(?:行|好|好吧|好啊|好呀|好的|嗯|嗯嗯|可以|去吧|去玩|去呗|去吧去吧|去|玩吧|玩去|同意|批准|准了|没问题|随你|你去|那就去|那你去|ok|okay)';
const YES_RX = new RegExp(`^${YES_WORD}(?:[\\s，,、。!！~～]*${YES_WORD})*[\\s，,。!！~～吧啊呀的啦]*$`, 'i');

/**
 * ★ 2026-11-02（第三批，用户实测）：**「去玩吧」这种没给目标的话，也得让她动手**。
 *
 * 用户原话：「如果我不给她明确目标，她是不会开始玩手机，比如我说去玩手机吧，看看顺不顺，
 * 她就不会动手，反而只会说'我去看看'这种固定词汇」。
 *
 * 这两条只判"他这句话是不是那个意思"，具体的"去干什么"由 `beginPlayNow()` 挑 ——
 * 不花模型、不猜。
 */
/**
 * ★ 2026-11-08：`随便玩` 这种"没给目标、但明显是让她自己去玩"的说法也要认。
 *
 * 真机 23:33:37：「**你随便玩吧**你刚刚都没有点下去」—— `PLAY_RX` 里只有"随便玩玩"，
 * 于是这句既不是 stop 也不是 play，她只在嘴上应了一声，手机上什么都没开。
 */
const PLAY_RX = /(玩.{0,4}手机|手机.{0,4}玩玩?|自己玩|去玩吧|去玩会儿|随便玩|玩玩看|玩一会儿|玩吧)/;
/**
 * 「先别玩了」「放下手机」—— 用户拍板的**唯一**停止条件。
 *
 * ★ 2026-11-08 补三类他真说过、以前一个都不认的：
 *   · 「**我来给你操作吧**」「**我自己来**」「**你别动**」—— 他要亲自来，这就是停；
 *   · 「**算了我下次再给你优化**」—— 今晚不弄了（`算了` + 下次/明天/改天）；
 *   · 「**别弄了**」「**你别管了**」。
 * 只对主人 + 私聊生效（`companion.cjs` 那两处都有守卫），所以词可以稍微松一点。
 */
const STOP_PLAY_RX = /(先)?别玩|不玩了|放下手机|停一下|停下来|别看了|不看了|别弄了|别翻了|我来(?:给你|帮你|自己)?(?:操作|弄|弄吧|试试|吧)|我自己来|你别动|你别管|别管了|算了[^，。]{0,6}(?:下次|明天|改天|算了)|算了吧|(?:先|暂时)?(?:别|不要?)搜了|不搜了|先停|暂停/;

/**
 * ★ 2026-11-08：`30 → 60`。他喊停的时候话都很长
 * （「别看了返回返回要返回到首页我教你看更好看的」21 字、「不是你这家伙压根不听啊，我来给你操作吧」20 字），
 * 30 字的上限会把一半的"停"挡在外面。
 */
const STOP_MAX_LEN = 60;

/**
 * ★ 2026-11-12：判定搬到 `phone-play.cjs` 了（短句 + META + 上下文许可）。
 * 这里保留同名函数只为**老调用方/老自检**还能用；生产路径（`companion.cjs`）
 * 直接用 `phone-play.playIntent()`。
 * ⚠️ 别再往 `PLAY_RX` 上加词 —— 那条裸正则正是「好玩吧 / 不偷玩手机」误触的来源。
 */
function looksLikePlay(text, ctx) {
  const play = require('./phone-play.cjs');
  return play.looksLikePlay(text, ctx);
}

function looksLikeStop(text) {
  const t = String(text || '').trim();
  return !!t && t.length <= STOP_MAX_LEN && STOP_PLAY_RX.test(t);
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);

/** `2026-10-31`（**本地时区**，跨天用这个，不用 UTC）。 */
function dayKey(at = Date.now()) {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * 本地日历天的序号（从 1970-01-01 起按**本地**算）。
 * ★ 2026-11-01：`pickFocus()` 原来用 `Math.floor(at / 86_400_000)` —— 那是 UTC 天，
 * 和 `dayKey()` 差 8 小时，于是本地早上八点心事会突然换一条。
 */
function localDayIndex(at = Date.now()) {
  const d = new Date(at);
  return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000);
}

/** 今天过了几分钟（从 0 点算）。 */
function minutesOfDay(at) {
  const d = new Date(at);
  return d.getHours() * 60 + d.getMinutes();
}

/**
 * 从模型那一坨里抠出第一个 JSON 对象。
 * 小模型很爱加围栏、加"好的，我给你排了："这种前缀，所以按大括号配对找，别用贪婪正则。
 */
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

const clean = (s, max = 40) => String(s || '').replace(/[\r\n]+/g, ' ').trim().slice(0, max);

/**
 * @param {object} o
 * @param {string}   o.dir        数据目录（`data/companion/phone`）
 * @param {Function} o.getCfg     () => phone 配置
 * @param {Function} o.agentOf    () => PhoneAgent | null（懒取，别在启动时碰 adb）
 * @param {Function} o.targetKey  () => 该跟谁说话（私聊 key）
 * @param {Function} o.isQuiet    (ms) => boolean，他是不是安静了这么久
 * @param {Function} o.say        async ({key, text, reason}) => void，原话发出去（不过大脑）
 * @param {Function} o.followUp   async (res) => void，走大脑回灌一条（带图）
 * @param {Function} [o.readNotes] async () => string，她手机便签上的字
 * @param {Function} o.model      () => 操作员/陪伴用的模型
 * @param {Function} o.callModel  (model, messages, opts) => {text}
 * @param {Function} [o.noteSelf] (text, {at, source}) => void，写一条自我观察
 * @param {Function} [o.plan]     ★ 2026-11-07 async ({at, theme, diary, notes, focus, persona, menu}) => plan|null
 *                                由 `CompanionBrain.planPhone` 提供（同一个她）。不给就走老的 `model/callModel`
 * @param {Function} [o.persona]  ★ 2026-11-07 () => 只读人格快照（`companion-persona.snapshot()`）
 * @param {Function} [o.speak]    ★ 2026-11-07 async ({key, text, plan, reason}) => void，提案走她的嘴（不过手）
 * @param {Function} [o.emit]     (ev) => void，给页面/日志看的事件
 * @param {Function} [o.log]      log 兼容对象
 */
function createPhoneLife({
  dir,
  getCfg = () => ({}),
  agentOf = () => null,
  targetKey = () => '',
  isQuiet = () => true,
  say = async () => {},
  speak = null,
  followUp = async () => {},
  readNotes = async () => '',
  model = () => null,
  callModel = null,
  plan = null,
  persona = null,
  noteSelf = null,
  emit = () => {},
  log: logx = log,
} = {}) {
  const lifeFile = path.join(dir, LIFE_FILE);
  const diaryFile = path.join(dir, DIARY_FILE);

  /** 内存状态（`life.json` 的镜像 + 运行时）。 */
  let st = null;
  /**
   * 正在跑的那次会话。
   *
   * ★ 2026-11-01：**落盘了**（`st.pendingSession`），不再只是内存。
   * 原来他点了头、程序这时候重启 → 会话消失，而需求条已经扣了 35、`approvedToday` 也 +1、
   * `seen` 也记了 —— 她既不办，也不会马上再问（`everyMin` 冷却），代价白付。
   */
  let session = null;
  /** ★ 2026-11-01：`propose()` 的重入锁（见那里）。 */
  let proposing = false;
  /** ★ 2026-11-02：`startPlay()` 的重入锁（它中间有一次模型调用，60 秒的 tick 会重叠）。 */
  let starting = false;
  let notes = '';
  let notesAt = 0;

  function blank() {
    return {
      day: '',
      needs: {},
      needsAt: 0,
      /** 今天批准过的几张"票"（每张 = 一次会话的几件事）。 */
      plans: [],
      /** 手上那件没做完的事（连续性就靠这个）。 */
      focus: null,
      /** 等他点头的那个提案。 */
      proposal: null,
      /** 只算**他批准过**的会话，手动让她做的事不计。 */
      approvedToday: 0,
      lastProposalAt: 0,
      lastSessionAt: 0,
      /** 24h 内做过哪些主题（防一天刷同一个）。 */
      seen: {},
      /**
       * ★ 2026-11-01：**他已经批准、但还没跑完的那次会话**。
       * 原来它只在内存里 —— 他点了头、程序这时重启，会话就消失了，
       * 而需求条已经扣了 35、`approvedToday` 也 +1、`seen` 也记了：她既不办，
       * 也不会马上再问（`everyMin` 冷却），代价白付。
       */
      pendingSession: null,
    };
  }

  function load() {
    if (st) return st;
    st = blank();
    try {
      const raw = JSON.parse(fs.readFileSync(lifeFile, 'utf8'));
      if (raw && typeof raw === 'object') st = { ...st, ...raw };
    } catch { /* 第一次跑，没有文件 */ }
    /** 手上总得有件事（连续性不能等第一次 tick 才有）。 */
    if (!st.focus) st.focus = pickFocus(Date.now());
    /**
     * ★ 2026-10-31（第三轮）：**老措辞自动换掉**。
     * 上一版写的是"挑 6 张像我的图"，模型看到数字就想一次做完（"挑 6 张凑够 6/6"）。
     * 盘上留着的旧 focus 会在重启后继续误导模型，所以这里就地换成不带数字的说法（进度保留）。
     */
    if (st.focus && /[0-9０-９一二三四五六七八九十]\s*张/.test(String(st.focus.text || ''))) {
      const fresh = FOCUS_POOL.find((x) => x.kind === st.focus.kind);
      if (fresh) st.focus.text = fresh.text;
    }
    return st;
  }

  let saveTimer = null;
  function saveSoon() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 400);
    saveTimer.unref?.();
  }
  function saveNow() {
    clearTimeout(saveTimer);
    saveTimer = null;
    try {
      fs.mkdirSync(dir, { recursive: true });
      /**
       * ★ 2026-11-01：**tmp + rename 原子写**。
       * 原来直接 `writeFileSync`：断电/杀进程正好撞上写盘 → 半截 JSON → `load()` 当成
       * "第一次跑"静默 `blank()`，手上的进度、`approvedToday`、需求条、`seen`、
       * 待批的提案**全没了，而且日志一声不响**。（`store.cjs` 写配置早就是 tmp+rename。）
       */
      const tmp = `${lifeFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(st, null, 1), 'utf8');
      fs.renameSync(tmp, lifeFile);
    } catch (err) { logx.warn(`手机：生活状态没写进去（${err.message}）`); }
  }

  /* ---------------------------------------------------------- 需求条 */

  /**
   * 让需求条随时间涨。`elapsedMin` 是上次 tick 到现在的分钟数（封顶 6 小时，
   * 电脑休眠一晚上回来不该一次涨满）。
   */
  function tickNeeds(at) {
    load();
    // 跨天（或者第一次跑）：按"今天已经过了多久"补一个基线，但**不许一上来就满**
    if (st.day !== dayKey(at)) {
      st.day = dayKey(at);
      st.approvedToday = 0;
      st.plans = [];
      for (const [k, n] of Object.entries(NEEDS)) {
        const fill = Math.min(minutesOfDay(at), 240) * n.perMin;
        st.needs[k] = clamp(n.seed + fill, 0, 85);
      }
      st.needsAt = at;
      if (!st.focus || st.focus.done) st.focus = pickFocus(at);
      logx.info(`手机：新的一天（${st.day}），她手上的事：${st.focus?.text || '还没想好'}`);
    }
    const mins = clamp((at - num(st.needsAt, at)) / 60_000, 0, 360);
    const hour = new Date(at).getHours();
    const awake = hour >= 9 && hour < 24;
    for (const [k, n] of Object.entries(NEEDS)) {
      let add = 0;
      if (awake) add += mins * n.perMin;
      if (k === 'share') {
        // 他越久不说话，越想给他看点东西
        add = !isQuiet(90 * 60_000) ? 0 : (mins / 60) * n.perSilentHour;
      }
      st.needs[k] = clamp(num(st.needs[k], n.seed) + add, 0, 100);
    }
    st.needsAt = at;
    saveSoon();
  }

  function pickFocus(at) {
    /**
     * ★ 2026-11-01：**按本地日轮换**（原来用 `Math.floor(at / 86_400_000)`，那是 UTC 天）。
     * 和 `dayKey()` 不一致的后果：本地早上八点（UTC 零点）心事突然换一条 ——
     * 用户会觉得"她半夜换了心思"。现在两处都用本地日历天。
     */
    const idx = localDayIndex(at) % FOCUS_POOL.length;
    return { ...FOCUS_POOL[idx], got: 0, since: dayKey(at), done: false };
  }

  /** 现在哪条需求最想被满足（最高的那条）。 */
  function topNeed() {    load();
    let best = null;
    for (const [k, n] of Object.entries(NEEDS)) {
      const v = num(st.needs[k], 0);
      if (v < n.threshold) continue;
      if (!best || v - n.threshold > best.over) best = { need: k, value: v, over: v - n.threshold };
    }
    return best;
  }

  /** 按需求挑主题：想分享 → 挑图；无聊 → 翻相册；好奇 → 随便逛。 */
  function themeFor(need) {
    const hit = Object.entries(THEMES).find(([, t]) => t.need === need);
    return hit ? hit[0] : 'album';
  }

  /**
   * ★ 2026-11-07：这一场用的**只读人格快照**（整场只取一次，之后一路传下去）。
   * 取不到就返回 null —— 调用方会退回兜底牌，**不会**换一个人格顶上。
   */
  function getPersona() {
    if (!persona) return null;
    try { return persona(); } catch (err) {
      logx.warn(`手机：人格快照没取到（${err.message}）`);
      return null;
    }
  }

  /** 手机上真能做什么（给她挑主题的菜单；不是人格，也不写进 system 的开头）。 */
  function themeMenu() {
    return Object.entries(THEMES).map(([k, t]) => `- ${k}（${t.label}）：比如「${t.goals[0]}」`).join('\n');
  }

  /**
   * ★ 2026-11-12：她手机上真有的几个地方（给计划层看；不是限制，是字典）。
   *
   * ★ 2026-11-12（P1）：**把学到的 App 也给她看**。
   * 以前菜单只有 `APP_LIST` 那 9 个，于是"她自己去"永远看不见学过的「菜谱」——
   * 学习只帮了"他叫她开"，没帮"她自己想去"。
   */
  function appMenu() {
    let learned = null;
    try {
      const agent = agentOf();
      learned = agent && typeof agent.learnedApps === 'function' ? agent.learnedApps() : null;
    } catch { learned = null; }
    try { return phoneApps.menu(learned); } catch { return ''; }
  }

  /* ---------------------------------------------------------- 提案 */

  /**
   * 兜底牌：模型抽风时也得有个具体的下一步。
   *
   * ★ 2026-11-12：`theme` 现在可能是**一个 App 名**（"相册"/"哔哩哔哩"）。
   * 老的三主题（album/collect/browse）照旧走原表；新路径从 `SEEDS` 里挑一条方向。
   */
  function fallbackPlan(theme, at) {
    const key = String(theme || '');
    if (THEMES[key]) {
      const t = THEMES[key];
      const seed = Math.floor(at / 60_000);
      const goal = (t.goals || [])[seed % Math.max(1, (t.goals || []).length)] || '随便看看手机';
      return { theme: key, ask: t.asks[seed % t.asks.length], goal, by: 'deck' };
    }
    const seedIdx = Math.floor(at / 60_000) % SEEDS.length;
    const seed = SEEDS.find((s) => s.app === key) || SEEDS[seedIdx];
    return { app: seed.app, goal: seed.goal, theme: kindOfApp(seed.app), ask: seed.ask, by: 'deck' };
  }

  function planPrompt(at, recentDiary) {
    const focus = st.focus && !st.focus.done
      ? `你心里惦记着一件事：${st.focus.text}（已经做了 ${st.focus.got || 0} 次）——`
        + '但这次只办里面**一小件**，别想着一次做完它。'
      : '你手上暂时没有非做不可的事';
    const menu = Object.entries(THEMES).map(([k, t]) => `- ${k}（${t.label}）：比如「${t.goals[0]}」`).join('\n');
    const did = recentDiary.length
      ? `最近干过的：${recentDiary.slice(-3).map((d) => `${d.theme}(${d.ok}成${d.fail}败)`).join('、')}`
      : '最近还没自己玩过';
    const notesLine = notes ? `你手机便签上写着：${notes}` : '';
    return [
      {
        role: 'system',
        content: [
          /**
           * ★ 2026-11-07：这一路只在**没有注入 `plan`**（自检 / 离线）时兜底，不再写人格。
           * 真机上她"想玩什么"由 `CompanionBrain.planPhone` 用她自己的账决定（同一个她）。
           */
          '你现在想用自己的手机办一件事，**先问他要不要**。',
          '你只能玩手机上真有的东西：相册、浏览器。没有商店、没有游戏、没有音乐播放器。',
          '输出**一行 JSON**，别的字都不要。格式：',
          '{"theme":"album|collect|browse","goal":"具体要办的那一件事","ask":"跟他说的一句话，20字以内，像人说话"}',
          /**
           * ★ 2026-11-02：`ask` 是三处里最容易被写成"任务单"的（用户点名了）。
           * 约束写死：随口一句、第一人称、不复述任务全名、不用"是否/需要我"这种公文腔。
           */
          '`ask` 是**你随口问他一句**，不是申请：像"我去翻翻相册啊""想挑张图看看，行吗"。',
          '`ask` 里**不要复述 goal 的全文**，不要说"我来帮你/为您"，不要写"是否""需要我"这种腔调。',
          // ★ 2026-10-31（第二轮改动，用户要求）：**一次只办一件事**，不要再列好几件。
          '只写**一件事**（不是三件、不是一串），5 步之内能办完、办完能看出来办没办成。',
          '不要写"看看有什么好玩的"这种没有落点的话；要写"挑一张照片，说清这张里是什么"。',
          '**绝对不许写**：删任何东西、卸载/安装、支付下单、发帖发消息、改设置（真机上这些会闯祸）。',
          '也不许写"把图存进某个地方"这种手机上做不到的事——她只能看、挑、截图。',
        ].join('\n'),
      },
      {
        role: 'user',
        content: [
          `现在是 ${new Date(at).toLocaleString('zh-CN', { hour12: false })}。`,
          focus,
          did,
          notesLine,
          '可选的玩法（挑一个 theme）：',
          menu,
          '只输出那一行 JSON。',
        ].filter(Boolean).join('\n'),
      },
    ];
  }

  /**
   * ★ 2026-10-31（第三轮，真机）：**主题由"她说的那件事"决定，而不是反过来**。
   *
   * 前两版是"模型先挑主题、再写事"，于是真机上反复出现同一类矛盾：
   * 主题 `collect`（代码会先开必应图片），它写的却是「在相册里挑一张最像你的图」。
   * 再怎么黑名单也追不上模型的措辞。
   * 现在反过来：先看她要做的是哪件事，再决定**开哪个页面**——
   * 提到相册就是 `album`，提到浏览器/标题就是 `browse`，剩下算 `collect`。
   */
  function themeOf(goal, fallback) {
    const g = String(goal || '');
    if (/(相册|图库|相机)/.test(g)) return 'album';
    if (/(浏览器|网页|标题|文章|冷知识)/.test(g)) return 'browse';
    if (/(图片|表情)/.test(g)) return 'collect';
    return THEMES[fallback] ? fallback : 'album';
  }

  /**
   * ★ 2026-10-31（真机撞出来的）：**不许办会闯祸的事**。
   *
   * 真实模型写出来的第三条是「把相册里模糊或重复的照片**删掉一张**，删完确认少了一张」——
   * 她真的会去点删除。操作员的 prompt 里虽然有"不要删除"，但那是最后一道闸，
   * 不该让这种目标先被提出来、再让他点头。这里直接拦掉。
   */
  const DESTRUCTIVE = /(删|清空|卸载|安装|支付|下单|购买|充值|转账|发帖|发消息|改设置|关掉|退出登录|注销)/;

  /**
   * ★ 2026-10-31（真机）：**手机上做不到的事也不许提**。
   * 真实模型写过「把挑好的图**数一数**，报个数给他」——手机上数不了，
   * 她只能张口编一个数字给他。这种条目看着无害，其实是在教她说谎。
   */
  const UNSUPPORTED = /(数一数|数一下|数一遍|数数|数完|数出|数清|记下来|记进|记到|记下|存进|存到|保存|整理|归档|归类|统计|比较|算一|算算)/;

  /**
   * ★ 2026-10-31（第三轮）：**一次只办一件**，所以"好几张/好几件"的活直接不认。
   * 模型看到"多挑几张像我的图"这种心事，会写成「挑 6 张，凑够 6/6」——那是一次做不完的。
   */
  const BATCH = /([2-9]|[两二三四五六七八九十])\s*张/;

  /** "这件事有没有落点"。光靠"不许出现什么"是拦不住空话的（`随便看看有什么好玩的`）。 */
  const ANCHOR_ANY = /(照片|相册|图库|图片|图|表情|标题|文章|网页|内容|截|挑|翻|念|点|最近)/;

  /** 一件事过筛子。返回 `{goal, kind}` 或 `null`（不合格就抽兜底牌）。 */
  function sanitizeGoal(text, fallbackTheme) {
    const g = clean(text, 60);
    if (!g || g.length < 4) return null;
    if (g.length > 50) return null;                 // 太长 = 一件事干不完
    if (DESTRUCTIVE.test(g)) return null;           // 会闯祸的活不办
    if (UNSUPPORTED.test(g)) return null;           // 手机上做不到的活不办
    if (BATCH.test(g)) return null;                 // 一次做不完的一批活不办
    if (!ANCHOR_ANY.test(g)) return null;           // 没有落点
    return { goal: g, kind: themeOf(g, fallbackTheme) };
  }

  /**
   * ★ 2026-11-12：**开放目的地**的筛子（和老的 `sanitizeGoal` 分开）。
   *
   * 老那套是给"三个固定主题"用的：必须有照片/标题/翻/挑这种落点，还会把
   * 「删」一刀切掉。现在她可以「去日记本把写歪的那一篇删了」—— 那是她自己的东西。
   * 这里只拦两类：**会闯祸的**（装/付/发出去/删别人的）和**手机上做不到的**（数、统计、比较）。
   */
  const OPEN_DANGER = /(卸载|安装|支付|下单|购买|充值|转账|发帖|发消息|注销|恢复出厂|关掉网络)/;
  function sanitizeOpenGoal(text, app) {
    const g = clean(text, 60);
    if (!g || g.length < 4) return '';
    if (g.length > 60) return '';
    if (OPEN_DANGER.test(g)) return '';
    const own = /(日记|本子|我写的|自己写的)/.test(g) || /日记/.test(String(app || ''));
    if (/(删|清空|格式化)/.test(g) && !own) return '';
    if (/(数一数|数一下|数一遍|统计|比较一下|算一算)/.test(g)) return '';
    return g;
  }

  /**
   * 让她自己想"这会儿想去办什么"。1 次调用；任何一步不对就抽兜底牌。
   *
   * ★ 2026-10-31（第二轮，用户要求）：**从"列 2~4 件连续做完"改成"就一件事"**。
   * 原话是「将连续多条计划改为只要她想去办，然后我点头就可以」——
   * 于是 `items` 这个数组整个不要了，只剩一个 `goal`。
   *
   * ★ 2026-11-07：**换成她自己的大脑**（`plan` = `CompanionBrain.planPhone`）。
   * 旧版这里自己拼一段「你叫小肥鱼，是个普通人」的 prompt —— 手机上想玩什么、
   * 为什么玩、什么时候算够，全都由"第二个人格"决定，跟聊天里的她不是一个人。
   * 现在 `plan` 拿到的是同一份只读人格快照；它排不出来（或者身份对不上）就走兜底牌。
   * 没注入 `plan` 时保留老路径（自检/离线用），一个字不改。
   */
  async function makePlan(at, theme, opts = {}) {
    const snap = getPersona();
    /**
     * ★ 有人格源（`plan` 已注入）但快照取不到 → **只抽兜底牌**。
     * 绝不退回旧那套"通用小肥鱼"prompt 顶上去 —— 那正是"第二个人格"。
     */
    if (plan && !snap) {
      logx.warn('手机：人格快照没取到，这次只抽兜底牌（不换人）');
      return fallbackPlan(theme, at);
    }
    if (plan) {
      try {
        const got = await plan({
          at,
          /** 只是"这次偏向"，不是限制（可能是 App 名，也可能是老的 album/collect/browse）。 */
          hint: String(theme || ''),
          diary: recentDiary(),
          notes: await loadNotes(at),
          focus: st.focus,
          persona: snap,
          menu: appMenu(),
          nightLite: !!(opts && opts.nightLite),
        });
        if (!got) throw new Error('她这次没排出想做的事');
        /** ★ 2026-11-12：她可以说"这趟不想去"（不是每次心跳都得有结果）。 */
        if (got.skip) {
          logx.info(`手机：这一趟她自己不想去（${clean(got.why, 40) || '没来由'}）`);
          return {
            skip: true,
            why: clean(got.why, 40) || '这会儿不想动',
            ask: clean(got.ask, 40),
            personaId: snap.personaId,
            by: 'her',
          };
        }
        const app = clean(got.app, 24);
        const goal = sanitizeOpenGoal(got.goal, app);
        if (!goal) throw new Error(`这件事没法验（空泛/不许做）：${String(got.goal).slice(0, 40)}`);
        return {
          app,
          goal,
          query: clean(got.query, 48),
          url: /^https?:\/\//.test(String(got.url || '')) ? String(got.url).slice(0, 300) : '',
          theme: kindOfApp(app),
          ask: clean(got.ask, 40) || fallbackPlan(app, at).ask,
          why: clean(got.why, 80),
          stopCriteria: clean(got.stopCriteria, 80),
          shareCriteria: clean(got.shareCriteria, 80),
          personaId: snap.personaId,
          by: 'her',
        };
      } catch (err) {
        logx.warn(`手机：她自己没想好去哪儿（${err.message}），用兜底牌`);
        const fb = fallbackPlan(theme, at);
        return { ...fb, personaId: snap.personaId };
      }
    }
    const m = model();
    if (!callModel || !m) return fallbackPlan(theme, at);
    let raw = '';
    try {
      const r = await callModel(m, planPrompt(at, recentDiary()), {
        temperature: 0.9, maxTokens: 160, thinking: { type: 'disabled' },
      });
      raw = String((r && r.text) || '');
      const j = pickJson(raw);
      if (!j) throw new Error('没解析出 JSON');
      // 兼容：模型还按老格式吐 `items` 的话，取第一条
      const rawGoal = j.goal || (Array.isArray(j.items) ? j.items[0] : '');
      const one = sanitizeGoal(typeof rawGoal === 'string' ? rawGoal : rawGoal?.goal, j.theme);
      if (!one) throw new Error(`那件事没法验（空泛/不许做/一次做不完）：${String(rawGoal).slice(0, 40)}`);
      const ask = clean(j.ask, 40) || fallbackPlan(one.kind, at).ask;
      return { theme: one.kind, ask, goal: one.goal, by: 'model' };
    } catch (err) {
      logx.warn(`手机：她自己没想好要办什么（${err.message}），用兜底牌；模型原话：${raw.slice(0, 80) || '(空)'}`);
      return fallbackPlan(theme, at);
    }
  }

  /**
   * 起一个提案：想干点什么 → **先问他**。
   * 这是 2026-10-31 用户拍板的规矩：「开始前需要向我请示，并说明想干嘛，我点头后才启动」。
   * @returns {Promise<{ok:boolean, why?:string}>}
   */
  async function propose(at) {
    /**
     * ★ 2026-11-01 修：**重入守卫要在第一个 await 之前**。
     *
     * 原来只有 `st.proposal.status === 'pending'` 那一句，而它写在 `await loadNotes`
     * 和 `await makePlan`（模型，30~45 秒）**之前**——两个 tick 撞上时两边都看到
     * `status: null`，于是两次模型调用、**两条一模一样的请示发出去**（实测复现）。
     * `tick()` 是 60 秒一次的 `setInterval` 且不 await，一次 propose 最坏 8+45 秒，
     * 重叠是常态不是意外。
     */
    if (proposing) return { ok: false, why: 'asking' };
    proposing = true;
    try {
      return await proposeInner(at);
    } finally {
      proposing = false;
    }
  }

  async function proposeInner(at) {
    load();
    const cfg = getCfg() || {};
    const a = cfg.autonomy || {};
    if (!a.enabled) return { ok: false, why: 'off' };
    /**
     * ★ 2026-11-02（第三批，用户拍板）：**默认不再请示**。
     * 用户原话：「一次管用 15 分钟，无任何限制，除非我中途说先别玩了」。
     * `mode:'ask'` 留着是为了随时能退回老行为。
     */
    if (String(a.mode || 'free') === 'free') return { ok: false, why: 'free-mode' };
    const key = String(targetKey() || '');
    if (!key) return { ok: false, why: 'no-target' };
    const top = topNeed();
    if (!top) return { ok: false, why: 'not-bored' };
    const cooldown = num(a.everyMin, 90) * 60_000;
    if (st.lastProposalAt && at - st.lastProposalAt < cooldown) return { ok: false, why: 'too-soon' };
    /**
     * ★ 2026-10-31（第二轮，用户要求）：**取消每天 3 次的上限**。
     * `maxPerDay` 留作兜底用（配成 >0 才生效；0/不配 = 不限）。
     * 真正防"缠人"的是 `everyMin` 的冷却和需求条本身（被批准一次就掉 35 点）。
     */
    const cap = num(a.maxPerDay, 0);
    if (cap > 0 && num(st.approvedToday, 0) >= cap) return { ok: false, why: 'quota' };
    if (st.proposal && st.proposal.status === 'pending') return { ok: false, why: 'asking' };

    // 今天做过这个主题 → 换一个（防一天刷同一个）
    let theme = themeFor(top.need);
    const seenAt = num(st.seen[theme], 0);
    if (seenAt && at - seenAt < 12 * 3600_000) {
      const other = Object.keys(THEMES).find((k) => k !== theme && !(num(st.seen[k], 0) && at - num(st.seen[k], 0) < 12 * 3600_000));
      if (other) theme = other;
    }

    // 先读一眼她自己的便签（24 小时内只读一次，0 调用）—— 这是"她想干什么"的最像人的来源
    await loadNotes(at);
    const plan = await makePlan(at, theme);
    st.proposal = {
      at,
      key,
      status: 'pending',
      theme: plan.theme,
      ask: plan.ask,
      /** ★ 一次只办这一件。`items` 留着是给老调用方/自检看的（只有一项）。 */
      goal: plan.goal,
      items: [{ goal: plan.goal, kind: plan.theme }],
      by: plan.by,
      need: top.need,
      /** ★ 2026-11-07：她自己说的"为什么 / 什么时候够 / 想分享什么"（整场沿用它）。 */
      why: plan.why || '',
      stopCriteria: plan.stopCriteria || '',
      shareCriteria: plan.shareCriteria || '',
      personaId: plan.personaId || '',
    };
    st.lastProposalAt = at;
    saveSoon();
    /**
     * ★ 2026-11-02（用户实测反馈）：**请示那句话不许像任务单**。
     *
     * 用户原话：「请示我的文字有点傻，比如'要不要我挑张像我的照片发你'，这种完全不像她说的话」。
     * 旧版这句是**计划模型**写的，而且"没带上具体的事"时还会自动补一个
     * `（想翻相册：挑一张最像小肥鱼的照片，截图发给他看）` —— 那是报告，不是人话。
     *
     * 现在：**一个字都不补**，直接用她自己的说法（`makePlan` 的 prompt 也改成了"像随口问一句"）。
     * 默认又走 `mode:'free'` 根本不会问 —— 她直接去玩，回来说一句。
     */
    try {
      /**
       * ★ 2026-11-07：**提案的那句话也要走她的嘴**。
       * 旧版直接 `deliverToChat(plan.ask)` —— 那句话是计划模型写的，绕过了 `CompanionBrain`，
       * 于是"提案"和"聊天"是两张嘴。给了 `speak` 就交给她的脑子说（同一个模型、同一份人格）。
       */
      const said = (speak && plan.personaId) ? await speak({ key, text: clean(plan.ask, 120), plan, reason: 'phone-propose' }) : null;
      if (!said) await say({ key, text: clean(plan.ask, 120), reason: 'phone-propose' });
      logx.info(`手机：她来问能不能去办一件事（${plan.theme}：${plan.goal}，来源 ${plan.by}）`);
    } catch (err) {
      st.proposal.status = 'failed';
      saveNow();   // 状态要立刻落盘，别让"没发出去"停在 pending 上卡住下一次请示
      logx.warn(`手机：请示没发出去（${err.message}）`);
      return { ok: false, why: 'send-failed' };
    }
    emit({ kind: 'propose', at, theme: plan.theme, ask: plan.ask, goal: plan.goal });
    return { ok: true, asked: plan.ask, goal: plan.goal };
  }

  /**
   * 他那句话算不算点头。
   *
   * 只在"有提案待批 + 同一个私聊 + 是他"时才判断，而且**先判否定**（"不行"里有"行"）。
   * 太长或者带问号的句子不当回答（那是他在问别的）。
   * @returns {{verdict:'ok'|'no'|'', theme?:string, items?:string[]}|null}
   */
  function answer({ key = '', text = '', isOwner = false, at = Date.now() } = {}) {
    load();
    const p = st.proposal;
    if (!p || p.status !== 'pending') return null;
    if (p.key && key && p.key !== key) return null;
    if (!isOwner) return null;
    if (at - p.at > SESSION.proposalTtlMs) {
      p.status = 'expired';
      saveNow();
      emit({ kind: 'propose-expired', at });
      return null;
    }
    const t = String(text || '').trim();
    if (!t || t.length > 24 || /[?？]/.test(t)) return null;
    if (NO_RX.test(t)) {
      p.status = 'declined';
      const n = NEEDS[p.need] || NEEDS.boredom;
      st.needs[p.need] = clamp(num(st.needs[p.need], 0) - n.decline, 0, 100);
      saveNow();
      emit({ kind: 'declined', at, text: t });
      logx.info(`手机：他没让（「${t}」），这件事先放着`);
      return { verdict: 'no', theme: p.theme };
    }
    if (YES_RX.test(t)) return { verdict: 'ok', theme: p.theme, goal: p.goal, items: p.items };
    return null;
  }

  /**
   * 开一场会话（**提案批准**和**自由模式**共用这一份）。
   *
   * ★ 2026-11-02：旧版把 `session = {...}` 直接写在 `startApproved()` 里，
   * 于是"自由模式"想复用就只能复制一遍 —— 两份状态机迟早走样。现在收在这里。
   */
  function beginSession({ at, key, theme, items, meta = null, planPending = false }) {
    const a = (getCfg() || {}).autonomy || {};
    const minutes = Math.max(1, Math.min(60, num(a.sessionMin, 15) || 15));
    const maxMs = minutes * 60_000;
    /**
     * ★ 2026-11-12：`items` 现在有两种形状 —— 老的字符串（主题库补出来的）
     * 和新的对象 `{goal, kind, app, query, url}`（开放目的地）。统一成对象。
     */
    const m0 = meta && typeof meta === 'object' ? meta : {};
    const list = (items || [])
      .map((g) => (typeof g === 'string' ? { goal: g } : g))
      .map((o) => ({
        goal: String((o && o.goal) || '').trim(),
        kind: String((o && o.kind) || theme || 'album'),
        app: String((o && o.app) || m0.app || ''),
        query: String((o && o.query) || m0.query || ''),
        url: String((o && o.url) || m0.url || ''),
      }))
      .filter((o) => o.goal)
      .slice(0, SESSION.maxItems);
    /**
     * ★ 2026-11-07：**"去玩吧"这条真机主路径**。
     *
     * 它原来是同步开跑（不许让她等他 3 秒才回话），所以 `items` 直接来自固定菜单、
     * 没有她的 `why/stopCriteria/shareCriteria` —— 手知道她的口味，却不知道"她想干什么/什么算够"。
     * 现在允许**先开一场空计划**（`planPending`），她回完话之后，下一轮 tick 再让她
     * 用自己的脑子排这一场；排不出来才抽兜底菜单。聊天不因此变慢。
     */
    if (!list.length && !planPending) return { ok: false, why: 'nothing-to-do' };
    const m = m0;
    const snap = getPersona();
    st.seen[theme] = at;
    st.lastSessionAt = at;
    /** ★ 2026-11-12：今天第几趟（保底/统计用）。 */
    const stats = dayStats(at);
    stats.trips = num(stats.trips, 0) + 1;
    session = {
      id: `s${at.toString(36)}`,
      startedAt: at,
      key: String(key || ''),
      theme,
      /** ★ 这一趟的目的地（开放目的地才有；老主题为空）。 */
      app: m.app || list[0]?.app || '',
      query: m.query || list[0]?.query || '',
      url: m.url || list[0]?.url || '',
      /** ★ 她自己挑的（`startPlay`）还是他叫的（`beginPlayNow`）—— 额度只算自己挑的。 */
      auto: !!m.auto,
      hint: m.hint || '',
      items: list.map((o) => ({ goal: o.goal, kind: o.kind || theme, app: o.app, query: o.query, url: o.url, ok: null, summary: '', ms: 0 })),
      idx: 0,
      calls: 0,
      steps: 0,
      shots: [],
      fails: 0,
      stop: '',
      paused: false,
      nextAt: 0,
      lastTaskId: '',
      lastTaskAt: 0,
      closing: false,
      /** ★ 这一场还没排事（等 tick 里让她自己排）。 */
      planPending: !!planPending,
      planning: false,
      /**
       * ★ 2026-11-07：**这一场是"她"在玩**。
       * `personaId` 来自计划那一份只读快照；`why/stopCriteria/shareCriteria` 是她自己说的，
       * 后面每一步（手）/ 每一次判断 / 回灌都带着它们 —— 换手不换人。
       */
      personaId: m.personaId || (snap && snap.personaId) || '',
      why: m.why || '',
      stopCriteria: m.stopCriteria || '',
      shareCriteria: m.shareCriteria || '',
      ask: m.ask || '',
      /** ★ 一次会话最多这么久（用户拍板 15 分钟）。 */
      maxMs,
      /** 这一场主动分享了几次（"她觉得特别有意思的"才发）。 */
      shares: 0,
      lastShareAt: 0,
    };
    st.pendingSession = { ...session };
    saveNow();
    emit({ kind: 'session-start', at, theme, goal: list[0]?.goal || '', items: list.map((x) => x.goal), minutes, personaId: session.personaId, view: 'hand-only' });
    const label = session.app || THEMES[theme]?.label || theme;
    logx.info(`手机：开始玩一会儿（${label}，${list.length ? `${list.length} 段` : '等她排这一趟'}，最多 ${minutes} 分钟，persona=${session.personaId || '(无)'}${session.why ? `，她想：${session.why}` : ''}，view=hand-only）${list.length ? `：${list.map((x) => x.goal).join('；')}` : ''}`);
    return { ok: true, session: session.id, theme, app: session.app, items: list.map((x) => x.goal), minutes, personaId: session.personaId };
  }

  /**
   * ★ 2026-11-07：**一场会话里不要三件几乎一样的事**。
   *
   * 真机（11-07 20:10）一场"挑图"排了三件：「挑一张最像我的」「挑一张像我的」
   * 「挑一张最顺眼的」—— 三件都停在同一屏、各跑 20~40 秒，等于同一件事做三遍，
   * 还占掉了她去看别的东西的时间。
   * 用字符二元组的重合度判"像不像同一件事"，超过 0.55 就只留第一件。
   */
  function goalSim(a, b) {
    const chars = (s) => {
      const t = String(s || '').replace(/[，。、！？\s]/g, '');
      const set = new Set();
      for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2));
      return set;
    };
    const A = chars(a);
    const B = chars(b);
    if (!A.size || !B.size) return 0;
    let same = 0;
    for (const x of A) if (B.has(x)) same += 1;
    return same / Math.min(A.size, B.size);
  }

  /** 按主题凑 1~3 件（第一件可以是模型想的那一件，其余从主题库里补；近似的不重复排）。 */
  function buildItems(theme, first = '') {
    const t = THEMES[theme] || THEMES.album;
    const out = [];
    if (first) out.push(String(first).trim());
    for (const g of t.goals || []) {
      if (out.length >= SESSION.maxItems) break;
      if (out.includes(g)) continue;
      if (out.some((x) => goalSim(x, g) >= 0.55)) continue;
      out.push(g);
    }
    return out.filter(Boolean);
  }

  /**
   * ★ 2026-11-12：**一场 = 一趟（一个念头展开的几段）**。
   *
   * 有 `app` 的开放计划：只有一段（她想做的那件事），App/搜索词/网址都挂在 item 上，
   * 由 `preOpen()` 替她先把门打开。
   * 老计划（album/collect/browse）：照旧从主题库里补到 1~3 件（自检/离线还在走这条）。
   */
  function itemsFor(plan) {
    if (plan && plan.app) {
      return [{
        goal: plan.goal,
        kind: plan.theme || kindOfApp(plan.app),
        app: plan.app,
        query: plan.query || '',
        url: plan.url || '',
        ok: null,
        summary: '',
        ms: 0,
      }];
    }
    return buildItems(plan && plan.theme, plan && plan.goal)
      .map((g) => ({ goal: g, kind: (plan && plan.theme) || 'album', ok: null, summary: '', ms: 0 }));
  }

  /**
   * 这一段开跑前要打开什么（0 调用）。
   *   · 给了网址 → 直接开网址；
   *   · 浏览器 + 搜索词 → 直接用 bing 搜（比让手点搜索框稳）；
   *   · 其它 App → 按中文名/包名拉起；
   *   · 老主题 → 照旧用 `THEMES[kind].pre`。
   */
  function preFor(item) {
    if (item.url) return { url: item.url };
    if (item.app) {
      if (/浏览器/.test(item.app) && item.query) {
        return { url: `https://www.bing.com/search?q=${encodeURIComponent(item.query)}` };
      }
      const pkg = (() => { try { return phoneApps.resolve(item.app); } catch { return item.app; } })();
      return { launch: pkg || item.app };
    }
    return THEMES[item.kind]?.pre || null;
  }

  /** 会话真的开起来之后，把需求条扣掉一点（不扣就会一直"想玩"）。 */
  function launch({ at, key, theme, items, meta = null, planPending = false }) {
    const r = beginSession({ at, key: key || String(targetKey() || ''), theme, items, meta, planPending });
    if (!r.ok) return r;
    st.approvedToday = num(st.approvedToday, 0) + 1;
    const need = THEMES[theme]?.need || 'boredom';
    const n = NEEDS[need] || NEEDS.boredom;
    st.needs[need] = clamp(num(st.needs[need], 0) - n.decay, 0, 100);
    saveSoon();
    const label = r.app || THEMES[theme]?.label || theme;
    const first = (items && items[0] && (typeof items[0] === 'string' ? items[0] : items[0].goal)) || '';
    return { ...r, label, first };
  }

  /**
   * ★ 2026-11-02（第三批，用户原话）：「如果我不给她明确目标，她是不会开始玩手机，
   * 比如我说去玩手机吧，看看顺不顺，她就不会动手，反而只会说'我去看看'这种固定词汇」。
   *
   * 原因不是她懒：**`[手机:…]` 是唯一入口**，而"去玩吧"这句话里没有具体目标，
   * 她就没有东西能写进那个标记 —— 于是只在嘴上说一句。这里补上"**想去就去**"这条路：
   * 从他那一句话直接开一场会话（不用模型先想、也不用他再点头）。
   *
   * 同步版本（给聊天那条路用：**不许让她等 3 秒才回话**）。
   */
  /**
   * ★ 2026-11-12：**他让她"接着玩"时，把她从挂起里放出来**。
   *
   * 真机 21:22–21:35：她 21:22:27 自己开了一场（相册），
   * 他一说话 `noteUser()` 就把它挂起；随后他连着说「去耍吧」「去吧」「接着玩」——
   * 这些都被判成 `play`，但 `beginPlayNow()` 只回一句「你正玩着呢」，
   * **没有把她放出来**。他一直在聊，`isQuiet(90s)` 永远不满足，
   * 这一场就挂到 18 分钟 `time-up`，一步没走 —— 她还在嘴上说「去了去了」。
   */
  function resume(reason = '他说接着玩') {
    load();
    if (!session) return { ok: false, why: 'idle' };
    const was = !!session.paused;
    if (was) {
      const pausedFor = Math.round((Date.now() - num(session.pausedAt, Date.now())) / 1000);
      session.paused = false;
      session.pausedAt = 0;
      session.nextAt = 0;
      saveSoon();
      emit({ kind: 'session-resume', at: Date.now(), why: reason });
      logx.info(`手机：${reason}，她接着玩（挂起了 ${pausedFor} 秒）`);
    }
    return { ok: true, was, label: session.app || THEMES[session.theme]?.label || '' };
  }

  function beginPlayNow({ at = Date.now(), key = '', theme = '' } = {}) {
    load();
    /**
     * ★ 2026-11-12：已经在玩时**不是拒绝，而是接着玩**。
     * 他被"你正玩着呢"打发掉之后，那一场其实还挂着（见 `resume()` 的注释）。
     */
    if (session) {
      const label = session.app || THEMES[session.theme]?.label || '';
      if (session.paused) {
        const r = resume('他说接着玩');
        return { ok: true, resumed: true, why: 'resumed', label };
      }
      return { ok: false, why: 'playing', label };
    }
    const top = topNeed();
    const hint = theme || appHintFor(top ? top.need : 'boredom');
    const snap = getPersona();
    /**
     * ★ 2026-11-07：**"去玩吧"不能再绕过她的计划**。
     * 这一段是同步的（不许让她等模型 3 秒才回话），所以：
     *   · 有 `plan`（真机）→ 先开一场"空的"，下一轮 tick 里让她自己排（`planPending`）；
     *   · 没有 `plan`（自检 / 离线）→ 保持老行为，直接抽兜底牌。
     */
    if (typeof plan !== 'function') {
      const fb = fallbackPlan(hint, at);
      return launch({
        at, key, theme: fb.theme, items: itemsFor(fb),
        meta: { personaId: (snap && snap.personaId) || '', app: fb.app, hint },
      });
    }
    return launch({
      at, key, theme: kindOfApp(hint), items: [],
      meta: { personaId: (snap && snap.personaId) || '', hint },
      planPending: true,
    });
  }

  /**
   * 异步版本（给 60 秒一次的心跳用）：先让她自己想去哪儿、干什么，再开跑。
   * 想不出来就抽兜底牌（`makePlan` 内部已经兜住了）；她说不想去就**真的不去**。
   */
  async function startPlay({ at = Date.now(), key = '', theme = '', nightLite = false } = {}) {
    load();
    if (session) return { ok: false, why: 'playing' };
    if (starting) return { ok: false, why: 'starting' };
    starting = true;
    try {
      const top = topNeed();
      const hint = THEMES[theme] ? theme : (theme || appHintFor(top ? top.need : 'boredom'));
      const plan = await makePlan(at, hint, { nightLite });
      if (plan.skip) return { ok: false, why: 'skip' };
      return launch({
        at,
        key,
        theme: plan.theme,
        items: itemsFor(plan),
        meta: {
          auto: true,
          app: plan.app || '',
          query: plan.query || '',
          url: plan.url || '',
          hint,
          personaId: plan.personaId || '',
          why: plan.why || '',
          stopCriteria: plan.stopCriteria || '',
          shareCriteria: plan.shareCriteria || '',
          ask: plan.ask || '',
        },
      });
    } finally {
      starting = false;
    }
  }

  /**
   * ★ 2026-11-02：**"先别玩了"立刻停**（用户拍板的唯一停止条件）。
   *
   * 不只是把会话收尾 —— 手上正在跑的那一件也要停（`companion` 会去调 `agent.stop()`）。
   */
  function stop(reason = '他说先别玩了') {
    load();
    if (!session) return { ok: false, why: 'idle' };
    const theme = session.theme;
    const label = session.app || THEMES[theme]?.label || theme;
    logx.info(`手机：${reason}，收工`);
    emit({ kind: 'session-stop', at: Date.now(), why: reason, theme });
    wrap(reason, Date.now()).catch((err) => logx.warn(`手机：收尾没走完（${err.message}）`));
    return { ok: true, theme, label };
  }

  /**
   * ★ 2026-11-02：**玩的时候看到特别有意思的，主动跟他说一声**。
   *
   * 用户原话：「她觉得特别有意思的，可以用 QQ 文字分享给我，觉得文字不够形容会自己发图片」。
   * 触发点是滚动层停下时的那句 `why`（"看到「猫」了"），**不是每一屏**：
   * 一场最多 2 次、两次之间隔 3 分钟。
   */
  function onFound(ev = {}) {
    if (!session) return false;
    const a = (getCfg() || {}).autonomy || {};
    if (String(a.mode || 'free') !== 'free') return false;
    if (num(session.shares, 0) >= SESSION.maxShares) return false;
    /** `at` 可注入：自检不用真等 3 分钟。 */
    const now = Number(ev.at) || Date.now();
    if (now - num(session.lastShareAt, 0) < SESSION.shareGapMs) return false;
    session.shares = num(session.shares, 0) + 1;
    session.lastShareAt = now;
    const why = String(ev.why || '').trim();
    const summary = why || '在手机上翻到点东西';
    const key = session.key;
    const sid = session.id;
    logx.info(`手机：看到点好玩的（${summary}），跟他说一声`);
    (async () => {
      let shot = null;
      let ag = null;
      try {
        ag = agentOf();
        const s = ag && ag.adb && ag.adb.screenshot ? await ag.adb.screenshot({ save: path.join(dir, 'share') }) : null;
        if (s && s.ok && s.file) shot = { file: s.file };
      } catch { /* 截不到就只用文字 */ }
      await followUp({
        id: sid, key, by: 'her', ok: true,
        verb: '在手机上翻着玩，看到点好玩的',
        summary, shot, steps: 0, calls: 0, ms: 0, at: Date.now(),
        /** ★ 2026-11-07：分享也走她的嘴；这份快照和这一场是同一份。 */
        personaId: session.personaId || '',
        why: session.why || '',
        shareCriteria: session.shareCriteria || '',
        screen: (() => {
          try { return (ag && typeof ag.state === 'function') ? (ag.state().screen || '') : ''; } catch { return ''; }
        })(),
      });
    })().catch((err) => logx.warn(`手机：分享没发出去（${err.message}）`));
    return true;
  }

  /** 他点头了：去办他批准的那**一件**事（老模式，`autonomy.mode === 'ask'`）。 */
  function startApproved({ at = Date.now(), key = '' } = {}) {
    load();
    const p = st.proposal;
    if (!p || p.status !== 'pending') return { ok: false, why: 'no-proposal' };
    p.status = 'approved';
    p.approvedAt = at;
    st.plans = (st.plans || []).concat([{ at, theme: p.theme, goal: p.goal }]).slice(-20);
    /** ★ 只办一件事，所以 `items` 里永远只有一项（`session` 那套状态机没动，省得再分叉）。 */
    const one = p.goal || (p.items && p.items[0] && p.items[0].goal) || '随便看看手机';
    return launch({
      at,
      key: String(key || p.key || ''),
      theme: p.theme,
      items: [one],
      meta: {
        personaId: p.personaId || '',
        why: p.why || '',
        stopCriteria: p.stopCriteria || '',
        shareCriteria: p.shareCriteria || '',
        ask: p.ask || '',
      },
    });
  }

  /** 他说话了 —— 会话让位（还留在那儿，等他再安静下来接着做）。 */
  function noteUser({ at = Date.now() } = {}) {
    if (!session || session.closing) return;
    if (!session.paused) {
      session.paused = true;
      session.pausedAt = at;
      /** 落盘也带上"挂起"，重启后才知道它是在等他安静。 */
      if (st.pendingSession && st.pendingSession.id === session.id) {
        st.pendingSession.paused = true;
        st.pendingSession.pausedAt = at;
      }
      saveSoon();
      emit({ kind: 'session-pause', at });
      logx.info('手机：他说话了，她先把手机放下');
    }
  }

  /* ---------------------------------------------------------- 会话 */

  /**
   * 每件小目标开跑前，把页面/App 先打开（0 次调用、必成）。
   *
   * ★ 2026-11-01：**只有真的打开了才算"开过"**。
   * 原来 `item.opened = true` 写在 `launch/openUrl` **之前**：相册根本没打开也算开过，
   * 于是她在**桌面**上执行"挑一张照片"，5 步预算全打空、这场会话白费。
   * 现在：成功才置位；失败就记一次 `tries`、下一轮 tick 重试（最多 2 次）；
   * 两次都打不开就不再挡路（照常开跑，总比整场会话白费强）。
   *
   * @returns {Promise<boolean>} 这一轮能不能开跑
   */
  async function preOpen(agent, item) {
    const pre = preFor(item);
    if (!pre || item.opened) return true;
    const tries = Number(item.tries) || 0;
    if (tries >= PREOPEN_TRIES) {
      logx.warn(`手机：「${pre.launch || pre.url}」两次都没打开，先不挡了`);
      return true;
    }
    try {
      let r;
      if (pre.launch) {
        /**
         * ★ 2026-11-12（P1）：**这一处别再直接 `adb.launch`**。
         *
         * 她计划里写 `app:'B站'` 时，`resolve('B站')` 以前原样返回 → `adb.launch('B站')` 打不开
         * → 两次之后"不挡了"，**这一段就从桌面上开始**（不是 B 站）。
         * 现在走 `openApp`：别名/桌面点字/抽屉点字/截图问坐标/验前台包名，和聊天那条路同一套。
         */
        r = (typeof agent.openApp === 'function')
          ? await agent.openApp(pre.launch, { task: null })
          : await agent.adb.launch(pre.launch);
      } else {
        r = await agent.adb.openUrl(pre.url);
      }
      if (!r || !r.ok) {
        item.tries = tries + 1;
        logx.warn(`手机：${pre.launch ? `打不开「${pre.launch}」` : `页面没打开（${pre.url}）`}（第 ${item.tries} 次）`);
        return false;
      }
      item.opened = true;
      if (PREOPEN_MS > 0) await new Promise((res) => setTimeout(res, PREOPEN_MS));
      return true;
    } catch (err) {
      item.tries = tries + 1;
      logx.warn(`手机：页面打开出错（${err.message}）（第 ${item.tries} 次）`);
      return false;
    }
  }

  /** 会话里的一步：看看该不该推进。 */
  async function stepSession(at) {
    const agent = agentOf();
    if (!session || !agent) return;
    const s = session;
    /**
     * ★ 2026-11-07：**先让她自己排这一场**（「去玩吧」那条路是空计划开跑的）。
     * 这一步只花一次模型调用，排在 tick 里，不占她回话的时间。
     * 排不出来就抽固定菜单（但 `why/stopCriteria` 仍然是空 —— 这是兜底，不是她的决定）。
     */
    if (s.planPending) {
      if (s.planning) return;
      s.planning = true;
      try {
        let plan = await makePlan(at, s.hint || s.theme);
        /**
         * 她说"这趟不想去"：**自己开的**（`auto`）就真的不去；
         * **他叫的**（`beginPlayNow`）已经回过他"我这就去"，抽一张兜底牌，别让他白等。
         */
        if (plan.skip) {
          if (s.auto) return wrap('skip', at);
          logx.info('手机：这一趟她不想去，不过他叫了，抽一张兜底牌');
          plan = { ...fallbackPlan(s.hint || s.theme, at), personaId: s.personaId };
        }
        s.app = plan.app || s.app || '';
        s.query = plan.query || '';
        s.url = plan.url || '';
        s.theme = plan.theme || s.theme;
        s.why = plan.why || '';
        s.stopCriteria = plan.stopCriteria || '';
        s.shareCriteria = plan.shareCriteria || '';
        s.ask = plan.ask || '';
        if (plan.personaId) s.personaId = plan.personaId;
        s.items = itemsFor(plan);
        s.planPending = false;
        saveSoon();
        emit({ kind: 'session-plan', at, theme: s.theme, app: s.app, goal: plan.goal, why: s.why, items: s.items.map((x) => x.goal) });
        logx.info(`手机：她想好了这一趟（去${s.app || s.theme}：${plan.goal}${s.why ? `；她想：${s.why}` : ''}${s.stopCriteria ? `；够了：${s.stopCriteria}` : ''}）`);
      } catch (err) {
        logx.warn(`手机：这一趟没排出来（${err.message}），用兜底牌`);
        const fb = fallbackPlan(s.hint || s.theme, at);
        s.app = fb.app || '';
        s.theme = fb.theme || s.theme;
        s.items = itemsFor(fb);
        s.planPending = false;
        saveSoon();
      } finally {
        s.planning = false;
      }
      if (!s.items.length) return wrap('nothing-to-do', at);
      s.nextAt = at + 1200;
      return;
    }
    // 预算 / 退出条件
    const budgetWhy = (() => {
      if (s.items.length >= 1 && s.items.every((x) => x.ok !== null)) return 'items-done';
      if (at - s.startedAt > (num(s.maxMs, SESSION.maxMs) || SESSION.maxMs)) return 'time-up';
      if (s.calls >= SESSION.maxCalls) return 'calls-up';
      if (s.steps >= SESSION.maxSteps) return 'steps-up';
      if (s.fails >= 2) return 'two-fails';
      return '';
    })();
    if (budgetWhy) return wrap(budgetWhy, at);

    const busy = agent.state().busy;
    // 他刚说完话：等她回完，再安静一会儿才继续
    if (s.paused) {
      /**
       * ★ 2026-11-12：**别挂到超时**。
       * 真机 21:22–21:35：他一直聊，90 秒安静永远凑不齐，这一场从 21:22 挂到 18 分钟
       * `time-up`，一步没走，她还在嘴上说"去了去了"。挂满 6 分钟就先收工，
       * 把位置让给下一趟（不收的话连"下一趟"都开不了）。
       */
      const pausedFor = at - num(s.pausedAt, at);
      if (!isQuiet(90_000)) {
        if (pausedFor > 6 * 60_000 && !busy) {
          logx.info('手机：他一直在聊，这一场先收（挂了 6 分钟，别耗到超时）');
          return wrap('paused-too-long', at);
        }
        return;
      }
      s.paused = false;
      s.pausedAt = 0;
      emit({ kind: 'session-resume', at });
    }
    if (busy) {
      // 卡住了：子任务等太久还没结果
      if (s.lastTaskAt && at - s.lastTaskAt > SESSION.itemTimeoutMs) {
        const item = s.items[s.idx];
        if (item && item.ok === null) {
          item.ok = false;
          item.summary = '（等太久了，没结果）';
          s.fails += 1;
        }
        s.idx += 1;
        s.lastTaskAt = 0;
        logx.warn('手机：这一步等太久了，跳过');
      }
      return;
    }
    if (at < (s.nextAt || 0)) return;
    if (s.idx >= s.items.length) return wrap('items-done', at);

    const item = s.items[s.idx];
    /**
     * ★ 2026-11-01：**同一件只许排一次**。
     *
     * 结果事件要是没回来（任务炸了、`fail` 事件丢了 `session`、或者 `onTask` 先被别的
     * 事件挡掉），`item.ok` 会一直是 `null`，而 `busy` 已经是 false —— 下一轮 tick
     * 就会把**同一件事再排一遍**。实测 5 轮 tick 排了 5 次，`maxCalls` 也因此永远不触发，
     * 只有 `maxMs` 能停。所以：已经排过、还没结果的这一步，等超时（上面那段）才放过。
     */
    if (s.lastTaskId && s.lastTaskAt && item && item.ok === null) return;
    /** ★ 2026-11-01：页面没打开就先不开跑（否则她在桌面上找照片），下一轮再试。 */
    if (!(await preOpen(agent, item))) return;
    /**
     * ★ 2026-11-07：**换手不换人**。
     * 每一件开跑前把这一场的人格快照交给"手"；断言不过就**收工**，
     * 不拿旧快照或者另一个人格硬演（她可以什么都没玩成，但不能变成别人）。
     */
    const snap = getPersona();
    /**
     * ★ 2026-11-07：**这一场从头到尾必须是同一个人**。
     * 只看"快照自身的 hash 一致"是不够的（那叫自证）；要拿它跟**开场时记下的
     * `session.personaId`** 比。对不上（中间改了角色卡 / 她的锚变了）就收工 ——
     * 不静默换人，哪怕她这一场什么都没玩成。
     */
    if (snap && s.personaId && snap.personaId !== s.personaId) {
      logx.warn(`手机：这一场的人格变了（${s.personaId}→${snap.personaId}），收工（不换人）`);
      return wrap('persona-drift', at);
    }
    if (snap && !s.personaId) s.personaId = snap.personaId;
    if (snap && typeof agent.setPersona === 'function') {
      if (!agent.setPersona(snap, { expect: s.personaId })) {
        logx.warn('手机：这一场的人格快照对不上，先收工（不换人）');
        return wrap('persona-drift', at);
      }
    }
    const brief = {
      goal: item.goal,
      why: s.why || '',
      stopCriteria: s.stopCriteria || '',
      shareCriteria: s.shareCriteria || '',
      src: 'session',
      personaId: s.personaId || (snap && snap.personaId) || '',
    };
    if (typeof agent.setBrief === 'function') agent.setBrief(brief);
    const r = agent.enqueue({
      goal: item.goal,
      by: 'her',
      key: s.key,
      share: true,
      src: 'session',
      session: s.id,
      brief,
      /** 小目标只给 3~5 步：治"9 步原地打转"。 */
      budget: SESSION.item,
    });
    if (!r.accepted) {
      // 手机被占着（他在让她做别的）：等一下再来
      logx.info(`手机：会话这一步没排上（${r.why}），等下一轮`);
      return;
    }
    s.lastTaskId = r.id;
    s.lastTaskAt = at;
    emit({ kind: 'session-step', at, idx: s.idx, of: s.items.length, goal: item.goal });
  }

  /**
   * agent 那边有结果了。会话里的子任务**静默记账**，不逐个回灌 QQ
   * （旧版 `phoneFollowUp` 是每个任务结束都发一条，一次会话能刷 5 条）。
   */
  function onTask(res) {
    if (!session || !res || res.session !== session.id) return;
    const s = session;
    // 迟到的结果别算到下一件头上
    if (s.lastTaskId && res.id && s.lastTaskId !== res.id) return;
    const item = s.items[s.idx];
    if (!item || item.ok !== null) return;
    s.calls += num(res.calls, 0);
    s.steps += num(res.steps, 0);
    if (res.shot && res.shot.file && s.shots.length < SESSION.maxShots) s.shots.push(res.shot.file);
    item.ok = !!res.ok;
    item.summary = clean(res.summary, 60);
    item.ms = num(res.ms, 0);
    if (!res.ok) s.fails += 1;
    else s.fails = 0;
    // 手上那件事：做的是同一类，就往前推一格
    if (res.ok && st.focus && !st.focus.done && st.focus.kind === item.kind) {
      st.focus.got = num(st.focus.got, 0) + 1;
      if (st.focus.got >= st.focus.goal) {
        st.focus.done = true;
        logx.info(`手机：她把手上的事做完了（${st.focus.text}）`);
      }
      saveSoon();
    }
    s.idx += 1;
    s.lastTaskAt = 0;
    const gap = SESSION.gapMs[0] + Math.random() * (SESSION.gapMs[1] - SESSION.gapMs[0]);
    s.nextAt = Date.now() + gap;
  }

  /** 收尾：一条回灌 + 一条日记 + 一条自我观察。 */
  async function wrap(why, at = Date.now()) {
    const s = session;
    if (!s || s.closing) return;
    s.closing = true;
    session = null;
    /** ★ 2026-11-01：会话真的收尾了才把落盘的那份清掉（重启时靠它续跑）。 */
    st.pendingSession = null;
    st.lastSessionAt = at;
    /**
     * ★ 2026-11-12：**今天的账 + 下一次冷却**。
     * 额度只算她自己挑的（`auto`）；他叫去玩的不占额度（尊重他）。
     */
    const stats = dayStats(at);
    const mins = Math.max(0, Math.round((at - num(s.startedAt, at)) / 60_000));
    stats.minutes = num(stats.minutes, 0) + mins;
    if (s.auto) stats.autoMin = num(stats.autoMin, 0) + mins;
    const appKey = s.app || THEMES[s.theme]?.label || s.theme || '玩手机';
    stats.apps[appKey] = num(stats.apps[appKey], 0) + 1;
    st.lastEndWhy = String(why || '');
    saveSoon();

    const done = s.items.filter((x) => x.ok === true);
    const bad = s.items.filter((x) => x.ok === false);
    const said = done.map((x) => x.summary).filter(Boolean);
    /**
     * ★ 2026-11-12：**一段都没跑起来，不许说"试了半天"**。
     * 真机 11-12 19:58：重启接回旧会话 → 第一跳就 `time-up`（0 步 / 0 次模型），
     * 回灌的 verb 还是「在手机上试了试」，她就对他说「试了半天也就那样」——她一步都没走。
     */
    const nothing = !done.length && !bad.length;
    const summary = (said.length ? said.join('；') : (bad[0]?.summary || (nothing ? '这次没来得及动手' : '没做成什么')))
      + (bad.length && said.length ? `（另外 ${bad.length} 件没成）` : '');
    const ok = done.length > 0;
    const shot = s.shots.length ? s.shots[s.shots.length - 1] : null;
    const label = s.app || THEMES[s.theme]?.label || '玩手机';
    /** ★ 2026-11-12：下一趟至少等到这时候（按结果和已用额度算）。 */
    st.nextAutoAt = at + gapAfter(why, at, done.length);

    // 日记（一会话一行，留 30 天）
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(diaryFile, JSON.stringify({
        at,
        theme: s.theme,
        did: s.items.map((x) => `${x.ok === true ? '成了' : (x.ok === false ? '没成' : '没来得及')}：${x.goal}`),
        ok: done.length,
        fail: bad.length,
        minutes: Math.round((at - s.startedAt) / 60_000),
        calls: s.calls,
        note: clean(done[0]?.summary || bad[0]?.summary || '', 60),
        why: why || '',
      }) + '\n', 'utf8');
      diaryCache = { at: 0, list: [] };
      trimDiary(at);
    } catch (err) { logx.warn(`手机：日记没写进去（${err.message}）`); }

    // 自我观察（模板，0 调用；重复的会被 `companion-self` 合并计次）
    if (noteSelf) {
      const t = THEMES[s.theme];
      try {
        if (done.length) noteSelf(`我好像挺喜欢${t?.label || '玩手机'}，玩了一会儿才放下`, { at, source: 'phone' });
        else if (bad.length) noteSelf('想玩手机，可这回什么也没弄成', { at, source: 'phone' });
        else noteSelf('本来想玩会儿手机，这回没来得及动手', { at, source: 'phone' });
      } catch { /* 写不进去不影响收尾 */ }
    }

    /**
     * ★ 2026-11-04：**她干过的事进她自己的账**（`doing`）。
     *
     * 日记 `diary.jsonl` 原来只喂"下一次手机计划"，聊天里她**完全不记得**自己玩过什么 ——
     * 于是"她有自己的一天"在提示词里只是一句话。现在收工就把这一场记成"我干过的事"，
     * 带日期、带她自己的口气（`summary` 是她当时那句描述）。
     * 只在真做成的时候记（没成的不算她"干过"）。
     */
    try {
      if (done.length) {
        require('./companion-self-kernel.cjs').addDoing({
          at, what: `${label}：${summary}`, where: 'phone', flavor: '',
        });
      }
    } catch (err) { logx.warn(`她的账：这一场手机没记进账（${err.message}）`); }

    emit({ kind: 'session-end', at, theme: s.theme, ok: done.length, fail: bad.length, why, summary });

    // 回灌：走 `phoneFollowUp` 那条老路（她自己的话，带一张图）
    try {
      await followUp({
        id: s.id,
        key: s.key,
        by: 'her',
        ok,
        verb: done.length ? `${label}了一会儿` : (nothing ? '在手机上待了一会儿' : '在手机上试了试'),
        summary,
        shot: shot ? { file: shot } : null,
        steps: s.steps,
        calls: s.calls,
        ms: at - s.startedAt,
        at,
        /** ★ 2026-11-07：这一场是她的哪一份人格、她为什么想玩、最后停在哪一屏。 */
        personaId: s.personaId || '',
        why: s.why || '',
        screen: (() => {
          try { const ag = agentOf(); return ag && typeof ag.state === 'function' ? (ag.state().screen || '') : ''; } catch { return ''; }
        })(),
      });
    } catch (err) {
      logx.warn(`手机：会话收尾没回灌出去（${err.message}）`);
    }
    logx.info(`手机：会话结束（${label}，成 ${done.length}/败 ${bad.length}，${Math.round((at - s.startedAt) / 60_000)} 分钟，${s.calls} 次模型，${why}）`);
  }

  function trimDiary(at) {
    try {
      const lines = fs.readFileSync(diaryFile, 'utf8').split('\n').filter(Boolean);
      const keep = lines.filter((l) => {
        try { return at - (JSON.parse(l).at || 0) < DIARY_KEEP_DAYS * 86_400_000; } catch { return false; }
      });
      if (keep.length !== lines.length) fs.writeFileSync(diaryFile, keep.join('\n') + '\n', 'utf8');
    } catch { /* 清不动就算了 */ }
  }

  /** 最近几条日记（`state()` 每轮都会问，30 秒缓存一下，别每次都读盘）。 */
  let diaryCache = { at: 0, list: [] };
  function recentDiary(n = 5) {
    const now = Date.now();
    if (now - diaryCache.at > 30_000 || diaryCache.list.length === 0) {
      try {
        diaryCache = {
          at: now,
          list: fs.readFileSync(diaryFile, 'utf8').split('\n').filter(Boolean)
            .slice(-20).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean),
        };
      } catch { diaryCache = { at: now, list: [] }; }
    }
    return diaryCache.list.slice(-n);
  }

  /* ---------------------------------------------------------- 主循环 */

  /* ---------------------------------------------------------- 额度与节奏 */

  function autoCfg() { return (getCfg() || {}).autonomy || {}; }

  /**
   * 今天的账：趟数 / 分钟 / 自主分钟 / 去了哪些 App。
   * 落盘在 `life.json` 里，重启不丢；跨天用本地日重新开一本。
   */
  function dayStats(at) {
    if (!st.dayStats || st.dayStats.date !== dayKey(at)) {
      st.dayStats = { date: dayKey(at), trips: 0, minutes: 0, autoMin: 0, apps: {}, fails: 0 };
    }
    return st.dayStats;
  }

  function usedAutoMin(at) { return num(dayStats(at).autoMin, 0); }

  function whyText(why) {
    return ({
      hour: '还没到点（9:00–23:30 才自己玩）',
      cool: '刚玩过，正歇着',
      talking: '你在说话，她先不拿手机',
      quota: '今天的额度用完了',
      'not-bored': '这会儿没什么想玩的',
      'no-phone': '手机没开',
      busy: '手机正忙着',
      'no-target': '还没找到要跟谁说',
      asking: '正等你点头',
      skip: '这一趟她自己不想去',
      off: '手机没交给她',
      'autonomy-off': '自己玩关着',
    }[why] || why);
  }

  /** 跳过原因落日志（同一原因 10 分钟最多一行）+ 存进 state 给页面看。 */
  let idleLogged = { why: '', at: 0 };
  function idle(why, at) {
    st.whyIdle = why;
    st.whyIdleAt = at;
    saveSoon();
    if (idleLogged.why === why && at - idleLogged.at < 10 * 60_000) return { ok: false, why };
    idleLogged = { why, at };
    logx.info(`手机：还没动（${whyText(why)}）`);
    return { ok: false, why };
  }

  /**
   * ★ 2026-11-12：**这一趟结束后的冷却**。
   *
   * 旧版是固定 `gapMin: 20`。现在按结果分档：
   *   · 顺利（`items-done` 且成 ≥2 段）→ 8 分钟，趁热接着玩；
   *   · 失败 / 超时 → 30 分钟，别连着撞墙；
   *   · 他说"先别玩" → 45 分钟，别马上又拿起来。
   * 另外**越用额度越慢**（`ratio²` 最多 +50 分钟）：90 分钟不会在下午就被烧光。
   */
  function gapAfter(why, at, okCount = 0) {
    const a = autoCfg();
    const base = (why === 'stop' || why === '他说先别玩') ? num(a.gapAfterStopMin, 45)
      : (why === 'two-fails' || why === 'time-up' || why === 'calls-up' || why === 'steps-up') ? num(a.gapAfterFailMin, 30)
        : (why === 'items-done' && okCount >= 2) ? num(a.gapAfterGoodMin, 8)
          : num(a.gapBase, 12);
    const quota = Math.max(1, num(a.dailyMin, 90));
    const ratio = clamp(usedAutoMin(at) / quota, 0, 1);
    return (base + 50 * ratio * ratio) * 60_000;
  }

  /* ---------------------------------------------------------- 主循环 */

  /**
   * 60 秒看一次（`companion.cjs` 的心跳会调它）。
   *
   * 顺序：涨需求 → 接回/丢弃旧会话 → 有提案就等（超时作废）→ 有会话就推进 →
   * 都没有就按「时段 → 安静 → 额度 → 冷却 → 想不想玩」决定要不要开一趟。
   * **任何一步坏了都只记日志**，不往外抛（心跳里抛错会把定时器打断）。
   */
  async function tick(at = Date.now()) {
    load();
    const cfg = getCfg() || {};
    if (!cfg.enabled) return { ok: false, why: 'off' };
    const a = cfg.autonomy || {};
    if (!a.enabled) return { ok: false, why: 'autonomy-off' };
    /**
     * ★ 2026-11-12：**按时分比，不按整点**。
     * 旧版 `getHours()` 比整数，`to: 23.5` 永远不生效；而且 23:00 整点就关闸，
     * 夜里一点都玩不了。现在 9:00–23:30，23:30–24:00 只读（`nightLite`）。
     */
    const min = minutesOfDay(at);
    if (min < num(a.from, 9) * 60 || min >= num(a.to, 23.5) * 60) return idle('hour', at);

    tickNeeds(at);
    dayStats(at);

    /**
     * ★ 2026-11-01：**重启之后把"他已经批准的那次会话"接回来**。
     *
     * ★ 2026-11-12：**太久了就不要了**。旧版原样接回旧 `startedAt`，第一跳就
     * `time-up`（11-10 676 分钟 / 11-12 1249 分钟，0 步 0 次模型），还让那场占掉
     * 下一次的冷却。现在超过 `maxMs` 直接丢，不写日记、不占冷却。
     */
    if (!session && st && st.pendingSession) {
      const age = at - num(st.pendingSession.startedAt, at);
      const maxMs = num(st.pendingSession.maxMs, SESSION.maxMs) || SESSION.maxMs;
      if (age > maxMs) {
        st.pendingSession = null;
        saveSoon();
        emit({ kind: 'session-drop', at, ageMs: age });
        logx.info(`手机：上次那场没结束（${Math.round(age / 60_000)} 分钟前），太久了，算了`);
      } else {
        session = { ...st.pendingSession };
        st.pendingSession = null;
        saveSoon();
        emit({ kind: 'session-resume', at, restored: true });
        logx.info(`手机：接着上次他答应过的那件事（${session.theme}，已经做到第 ${(session.idx || 0) + 1}/${(session.items || []).length} 件）`);
      }
    }

    // 提案挂着：过时作废（不重复问同一个）
    if (st.proposal && st.proposal.status === 'pending' && at - st.proposal.at > SESSION.proposalTtlMs) {
      st.proposal.status = 'expired';
      saveSoon();
      emit({ kind: 'propose-expired', at });
      logx.info('手机：请示过了半小时没回音，先不玩了');
    }

    if (session) {
      await stepSession(at);
      return { ok: true, doing: 'session' };
    }

    const agent = agentOf();
    if (!agent) return idle('no-phone', at);
    if (agent.state().busy) return idle('busy', at);

    const mode = String(a.mode || 'free');
    if (mode !== 'free') {
      if (!isQuiet(10 * 60_000)) return idle('talking', at);
      if (st.proposal && st.proposal.status === 'pending') return idle('asking', at);
      if (!topNeed()) return idle('not-bored', at);
      return propose(at);
    }

    /**
     * ★ 2026-11-02（第三批）：**自由模式 —— 不用问，自己去玩**。
     *
     * ★ 2026-11-12：多了三样东西，都是为了"该玩的时候真能玩、不该玩的时候别烦他"：
     *   · **每天 90 分钟额度**（自主趟才算；他叫去玩的不算）——玩够了就停；
     *   · **保底 2 趟**（21:00 后还没玩够且额度还有 → 忽略需求条开一趟）；
     *   · 冷却按结果分档（见 `gapAfter`），不再固定 20 分钟。
     */
    if (!isQuiet((num(a.quietMin, 3) || 3) * 60_000)) return idle('talking', at);
    if (usedAutoMin(at) >= num(a.dailyMin, 90)) return idle('quota', at);
    if (st.nextAutoAt && at < num(st.nextAutoAt, 0)) return idle('cool', at);

    const top = topNeed();
    const overdue = !!st.lastSessionAt && at - st.lastSessionAt > 3 * 3600_000;
    const stats = dayStats(at);
    const needFloor = stats.trips < num(a.minTripsPerDay, 2) && min >= num(a.minTripCheckFrom, 21) * 60;
    if (!top && !overdue && !needFloor) return idle('not-bored', at);

    const key = String(targetKey() || '');
    if (!key) return idle('no-target', at);
    const nightLite = min >= num(a.nightLiteFrom, 22.5) * 60;
    const r = await startPlay({ at, key, nightLite });
    if (r && r.ok === false && r.why === 'skip') return idle('skip', at);
    return r;
  }

  /** 只读快照（给 `phoneState()` / 页面 / 自检）。**不碰 adb、不写文件**。 */
  function state(at = Date.now()) {
    load();
    const top = topNeed();
    /** 还没 tick 过的时候也要给得出三条需求（用基线值，不写盘）。 */
    const needs = {};
    for (const [k, n] of Object.entries(NEEDS)) needs[k] = num(st.needs[k], n.seed);
    return {
      day: st.day || dayKey(at),
      needs,
      top: top ? top.need : '',
      focus: st.focus ? { ...st.focus } : null,
      proposal: st.proposal ? {
        status: st.proposal.status,
        theme: st.proposal.theme,
        ask: st.proposal.ask,
        goal: st.proposal.goal || (st.proposal.items && st.proposal.items[0] && st.proposal.items[0].goal) || '',
        at: st.proposal.at,
        items: (st.proposal.items || []).map((x) => x.goal),
      } : null,
      session: session
        ? {
          id: session.id, theme: session.theme, app: session.app || '', idx: session.idx, of: session.items.length,
          paused: !!session.paused, startedAt: session.startedAt,
          minutes: Math.round((num(session.maxMs, SESSION.maxMs) || SESSION.maxMs) / 60_000),
          shares: num(session.shares, 0),
          /** ★ 2026-11-07：这一场是"她"（同一份快照）在玩，以及她自己说的为什么/什么时候够。 */
          personaId: session.personaId || '',
          why: session.why || '',
          stopCriteria: session.stopCriteria || '',
          shareCriteria: session.shareCriteria || '',
        }
        : null,
      /** ★ 2026-11-02：`free` = 不用请示（默认）；`ask` = 老行为。 */
      mode: String(((getCfg() || {}).autonomy || {}).mode || 'free'),
      approvedToday: num(st.approvedToday, 0),
      lastSessionAt: num(st.lastSessionAt, 0),
      /**
       * ★ 2026-11-12：**她现在为什么没在玩**（页面/日志/自检都看这个）。
       * `whyIdle` 是 `tick()` 最后给出的原因码（hour/cool/talking/quota/…），
       * `today` 是今天的账（趟数/分钟/自主分钟/去过哪些 App）。
       */
      whyIdle: st.whyIdle || '',
      whyIdleAt: num(st.whyIdleAt, 0),
      today: { ...dayStats(at) },
      recent: recentDiary(3),
    };
  }

  /** 便签（她自己的字）。每次会话前读一次，24 小时内不重复读。 */
  async function loadNotes(at = Date.now()) {
    if (notes && at - notesAt < 24 * 3600_000) return notes;
    try {
      const raw = await readNotes();
      notes = String(raw || '').replace(/^\uFEFF/, '').replace(/[\r\n]+/g, '；').trim().slice(0, 200);
      notesAt = at;
    } catch { /* 读不到就当没有 */ }
    return notes;
  }

  function reset() {
    st = null;
    session = null;
    proposing = false;
    notes = '';
    notesAt = 0;
    clearTimeout(saveTimer);
    saveTimer = null;
  }

  return {
    tick,
    propose,
    answer,
    startApproved,
    /** ★ 2026-11-02（第三批）：自由模式的三个入口 —— 立刻开玩 / 心跳开玩 / 她说"别玩了" / 看到好玩的分享。 */
    beginPlayNow,
    startPlay,
    resume,
    stop,
    onFound,
    noteUser,
    onTask,
    state,
    loadNotes,
    wrap: (why = '手动收尾', at = Date.now()) => wrap(why, at),
    reset,
    paths: { life: lifeFile, diary: diaryFile },
    /** 自检用：直接读写内存状态（别在正式流程里用）。 */
    _st: () => st,
    _session: () => session,
  };
}

module.exports = {
  createPhoneLife, THEMES, NEEDS, SESSION, FOCUS_POOL, YES_RX, NO_RX, dayKey, localDayIndex, pickJson,
  PLAY_RX, STOP_PLAY_RX, looksLikePlay, looksLikeStop,
};
