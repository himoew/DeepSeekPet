/**
 * 她的手机 · 操作员（P0，2026-10-31 重做）
 *
 * 这一层负责"下一步点哪"，**不说话**。说的话永远由 `companion-brain` 那边说。
 *
 * 为什么要单独一层（和 `companion-brain` 分开）：
 *   · 她的人格 prompt 有 4k token，讲的是"嘴比心硬、会困"；每步都发一遍，8 步就是 32k，而且她会开始"演"；
 *   · 操作员要冷、要短、要**不记得刚才聊了什么**，只认"目标 + 这一屏"；
 *   · 但人格不能丢 —— 所以只把**三样东西**带进来：目标是她说的那句话、几行她的口味、以及
 *     "随便看看时挑你喜欢的那个"。她只在"选什么"上出场，不在"怎么点"上出场。
 *
 * 一次任务的生命周期：
 *   enqueue() → [快捷技能命中就直接做完] → observe → 决策 → 执行 → 验证 → … → done/fail
 *   每一步都发事件（start/step/shot/done/fail），上层拿去做"回灌"和镜像。
 *
 * ★ 2026-10-31 的六处改动（都是 10-30 那台机器上实测出来的坑，见 docs 里的对照方案）：
 *   ① 决策模型可以看图了（`deepseek-flash` 原生支持，一屏 ≈560 token，比想象中便宜）；
 *   ② `tap` 不再为解析 ref 重新 dump 一次（省 2.3 秒/步）；
 *   ③ 感知按需升级：树太空 / 上一步没动静 / 目标本身要"看" / 刚换 App，才截一张；
 *   ④ 屏级记忆**按目标条件化**（`pkg|hash|意图`）+ 双计数 + 会失效 + 相机黑名单；
 *   ⑤ `done` 要过断言（不许一步没做就说弄完了），卡住会自己 back/home 再试；
 *   ⑥ prompt 拆成"稳定的 system + 变化的 user"，让 prompt 缓存能命中。
 *
 * 不依赖 electron、不自己开 adb：`adb` 由外面注入（自检可以塞假的）。
 */
const fs = require('node:fs');
const path = require('node:path');
const log = require('./log.cjs');
/** ★ 2026-11-01：卡住时"看图自救"的规则只写一份（视频那条路也用 `phone-rescue`）。 */
const { rescueStep } = require('./phone-rescue.cjs');
/** ★ 2026-11-02：弹窗 / 广告的识别与关闭规则（纯函数，0 token）。 */
const popup = require('./phone-popup.cjs');
/** ★ 2026-11-02：滚动层（小步滑 + 每步判"值不值得停"，纯函数）。 */
const scroll = require('./phone-scroll.cjs');
/** ★ 2026-11-06（P1）：一屏 → 可读可寻址的结构（角色/分区/loc/读页）。纯函数。 */
const surface = require('./phone-surface.cjs');
/** ★ 2026-11-06（P3）：这台机器上真有的 App 的知识（这一屏能做什么 / 硬常识）。 */
const apps = require('./phone-apps.cjs');
/**
 * ★ 2026-11-12（P0）：**打开某个 App 的兜底**（缓存 → 别名 → 看屏上的字点 → 截图问坐标 → 验前台包名）。
 *
 * 用户的原话：「每个 App 都需要单独调程序？不能找不到截张图看看点哪里，然后继续吗？」
 * 这一层就是那个"找不到就看屏幕"。纯逻辑 + 依赖注入（`adb` / `surface` / `askLocate` / `store`），
 * 所以自检里用假 adb 就能把四条路各跑一遍。
 */
const openMod = require('./phone-open.cjs');
/**
 * ★ 2026-11-07：**同一个她的只读快照**。
 * 操作员只拿 `handView`（紧凑、没有人格）；"想玩什么/停不停/说什么"不在这里。
 */
const personaMod = require('./companion-persona.cjs');

const DEFAULTS = {
  enabled: false,             // 手机接管开没开
  home: '',                   // 空 = phone-adb 的默认（MuMu 默认安装目录）
  serial: '',                 // 空 = 127.0.0.1:16384
  vmindex: 0,
  /**
   * 单任务预算。见设计 §4.5 —— 超了就停，不无限试。
   * ★ 2026-10-31：`maxCalls` 原来 8、`maxSteps` 12，可**每一步都要问一次模型**，
   * 于是 8 步就撞墙、12 步的上限永远用不到。10-31 上午那 18 个任务里 6 个死在
   * "想不出下一步了"（其实是"模型调用次数用完了"）。现在两边对齐，撞墙时也不再硬判失败，
   * 而是走 `wrapSummary()` 如实说"最后停在哪"。
   */
  /**
   * ★ 2026-11-07（用户拍板「放开 tok 限制，只要不是特别离谱」）：
   * 以前 12 步 / 100 秒 / 12 次模型，真机上"时间到了"全是**同一步看两遍屏**造成的。
   * 现在观测复用 + 每步只问一次，20 步 / 180 秒才够她真的把一件事做完
   * （比如"打开浏览器→搜→读结果→点进去→翻两屏→截图"）。
   */
  maxSteps: 20,
  maxMs: 180_000,
  maxCalls: 20,  /**
   * 连续几步没进展就退一步。
   * ★ 2026-11-01（P0-4）：**3 → 2**。一个任务只给 5 步，等 3 步才退，
   * 退路（back×2 → 重开 App）根本来不及走完就得收工。
   */
  maxStall: 2,
  /**
   * ★ 2026-11-08：**排队超过这么久就作废**（默认 90 秒）。
   *
   * 真机 23:34:47 他说「点网页」，排队排到 23:40:03 才跑；23:35:06 他已经在喊
   * 「你怎么又开始划了」—— 他骂的那一下，其实是 1 分钟前那条旧指令。
   * 手机任务本身最长 180 秒，一条指令等两件就得 6 分钟，那时候屏幕早不是那一屏了。
   * 过期就不做，**如实回一句**（`drain()` 里），别闷头执行一条已经没有意义的指令。
   */
  maxQueuedMs: 90_000,
  /**
   * ★ 2026-11-01（深夜，用户拍板）：**卡住时先让她自己看图判断**（第一优先级）。
   *
   * 用户原话：「把她自己判断接下来点哪里、还是退出，作为第一优先级……一次任务次数限制 10 次，
   * 先按这个实际试用，如果效果好不限制也无所谓（比起几十张图的 tok 消耗，
   * 我更在意她能不能灵活的自己玩手机）」。
   *
   * 做法：卡住（连续 `maxStall` 次没进展）先截一张图 + 这一屏的动作表，问一次
   * "该点哪 / 还是该退"，拿到一个动作就执行；**不行才走固定退路**（back×2 → 重开 App）。
   * 一次任务最多 `max` 次（10）；`width` 是发出去前缩到多宽（实测图 token 与宽度无关）。
   */
  rescue: { enabled: true, max: 15, width: 360 },
  /**
   * ★ 2026-11-02（用户：「经常被莫名其妙的广告或者弹窗卡住」）：**弹窗/广告层**。
   *
   * 每步在问模型**之前**先看一眼这一屏（0 token，只用已经 dump 好的树），
   * 认出"跳过 / 不允许 / 以后再说 / 关闭"这类字就自己点掉 —— 详见 `phone-popup.cjs`。
   *
   * · `max`：一个任务最多处理几次（跨段累计）。到顶就不管了，交给模型/退路；
   * · `maxSame`：同一类（插屏/权限/登录墙…）出现几次算"广告墙"，之后不再硬刚；
   * · `settleMs`：点掉之后等界面缓一下再验。
   */
  popup: { enabled: true, max: 6, maxSame: 3, settleMs: 450 },
  /**
   * 她自己会不会用（自主模式）。用户 2026-10-30 拍板"可以自己用"，所以默认开。
   *
   * ★ 2026-10-31 语义变了（用户第二轮拍板）：**开始前先向他请示，他点头才开跑**。
   *   · `everyMin`：两次**请示**之间至少隔多久（不是两次会话）——这是唯一防"缠人"的闸；
   *   · `maxPerDay`：**0 = 不限**（2026-10-31 第三轮用户明确要"取消三次上限"）；
   *     配成 >0 才有兜底作用，且只算**他批准的**（聊天里让她做的不计）；
   *   · `from/to`：只在这个时段里请示。
   * 具体判断在 `phone-life.cjs`。
   */
  autonomy: {
    enabled: true,
    /**
     * ★ 2026-11-02（用户拍板）：「**一次管用 15 分钟，无任何限制，除非我中途说先别玩了**」。
     *
     *   · `mode: 'free'`（默认）—— **不再请示**。她自己开跑，他喊停才停；
     *   · `mode: 'ask'`          —— 10-31 那套（先问、他点头才跑）。**随时能退回去**。
     *   · `sessionMin`：一次会话最多玩多久（分钟）；
     *   · `gapMin`：两次之间至少隔多久（防"刚放下又拿起来"）；
     *   · `quietMin`：他安静几分钟她才自己开跑（不打断他说话）。
     *
     * `everyMin` / `maxPerDay` 只有 `ask` 模式还看（老配置留着，别丢）。
     */
    mode: 'free',
    /** ★ 2026-11-12：一趟 18 分钟（她可以在这一趟里做 1–3 段）。 */
    sessionMin: 18,
    /** ★ 2026-11-12：冷却按结果分档；`gapMin` 留作老的兜底（没配新键时用它）。 */
    gapMin: 20,
    gapBase: 12,
    gapAfterGoodMin: 8,
    gapAfterFailMin: 30,
    gapAfterStopMin: 45,
    quietMin: 3,
    everyMin: 90,
    maxPerDay: 0,
    /** ★ 2026-11-12：时段放宽到 9:00–23:30，之后到 24:00 只读。 */
    from: 9,
    to: 23.5,
    nightLiteFrom: 22.5,
    /** ★ 2026-11-12：每天 90 分钟额度（只算她自己挑的趟），120 是连"他叫的"一起的硬顶。 */
    dailyMin: 90,
    dailyHardMin: 120,
    /** ★ 2026-11-12：保底 —— 21:00 后今天还没玩够 2 趟，就忽略需求条开一趟。 */
    minTripsPerDay: 2,
    minTripCheckFrom: 21,
  },
  /** 分享闸门（防刷屏）。 */
  share: { maxPerHour: 6, maxPerDay: 20 },
  /** 她玩手机时的口味。人格只从这里进操作员，别把整张角色卡塞进去。 */
  taste: '爱看热闹、爱听人说话；对猫、小动物和吃的东西会多看一眼；嫌麻烦，不爱一步步折腾。',
  /** 弹真窗口时的尺寸（含 MuMu 自己的边框）。 */
  window: { width: 430, height: 900, margin: 24 },
  /** 手机模型：默认跟 QQ 同一套（mode=same）；想单独换就 mode=custom。 */
  model: { mode: 'same' },
  /**
   * ★ 2026-10-31：操作员能不能看图。
   * 默认开，但**第一次被模型拒了（400 / 不支持图）就自动关掉**，不会一直撞墙。
   * `detail`：'low' 便宜（服务端先缩到 512×512）、'high' 保留原图（720×1280 ≈ 560 token）。
   *
   * ★ 2026-11-07（用户：「连续不断识屏之类的方法都可以接受」）：
   * `always: true` = **每一屏都给她看**，不再"控件树有字就不发图"。
   * 实测 `deepseek-flash` 一张 360×640 的图 228 prompt token、一次 0.8~1.2 秒，
   * 而它能看见控件树里根本没有的东西（照片、图标、卡片、按钮的排布）。
   * 这是她"不会看图挑图/不知道自己点哪"最直接的解。
   */
  vision: { enabled: true, detail: 'low', always: true, maxSide: 640 },
  /** 滚动层的节奏（真机 4 秒不够、5 秒才稳；这里给 600ms 起步沉降，滑不动还会再试一次）。 */
  scroll: {
    settleMs: 600,
    /**
     * ★ 2026-11-07（用户：「连续不断识屏之类的方法都可以接受」）：
     * 往下翻的时候**每一屏都看一眼图**，由她自己判断要不要停 —— 不再只靠 `INTEREST` 词表。
     * `lookMax` 是一条手势最多问几次（问太多次会慢），默认 4。
     */
    lookEach: true,
    lookMax: 4,
  },
  /**
   * ★ 2026-11-12（P0）：**"打开某个 App"怎么开**（见 `phone-open.cjs`）。
   *
   * 抽屉手势 / 截图问坐标的额度 / 学习开关都在这里；`learn.enabled:false` 只关"记下来"，
   * 不会关掉"打开"这条路（打开是保底能力）。
   */
  open: { ...openMod.DEFAULTS },
};

/**
 * ★ 2026-11-06（P1）：`read` / `find` / `waitfor` 是**"不动手"的动作** ——
 * 它们只把这一屏读给她，所以不花步数、也不算"没进展"（见循环里的 `noStall`）。
 */
const VERBS = ['tap', 'tapn', 'tapxy', 'longpress', 'doubletap', 'drag', 'swipe', 'scroll', 'scrollto', 'taptext', 'text', 'key', 'launch', 'restart', 'openurl', 'open', 'wait', 'shot', 'done', 'ask', 'read', 'find', 'waitfor', 'images', 'save'];
const TAG_RX = /\[手机\s*[:：]\s*([^\]\n]{1,80})\]/g;
/**
 * ★ 2026-11-01：队列上限。
 * ★ 2026-11-08：原来写着"他那一句不受这个上限约束"，现在**改了**——
 * 那条规矩导致他连说 5 句就排 5 件，最后执行的是 8 分钟前的话（真机 23:34–23:40 那一轮）。
 * 现在他的事仍然**排在会话任务前面**，但条数也受这个上限约束（超了先丢她自己的、再丢他更旧的）。
 */
const QUEUE_MAX = 2;

/**
 * ★ 2026-11-08：**"现在立刻"的指令** —— 回桌面 / 返回 / 停。
 *
 * 这三件事在他嘴里从来都是"现在"，所以不等前面那件跑完（`enqueue()` 里直接标停手上那件）。
 * 其余（搜、翻、看、读）都可以等，等太久才作废（`DEFAULTS.maxQueuedMs`）。
 */
const URGENT_KINDS = new Set(['home', 'back', 'stop']);

/** 这句话是"一件什么事"（能 0 token 认出来的按确定动作算，认不出的算空）。 */
function kindOfGoal(goal) {
  try {
    const q = quickSkill(goal);
    return (q && q.kind) || '';
  } catch { return ''; }
}

/**
 * ★ 2026-10-31：目标里哪些词说明"这一屏得看一眼"。
 * 这些词一出现，光有控件树是不够的（图标没有文字、照片在 GL 面上、视频看不了）。
 */
const VISION_GOAL = /(看|瞧|瞄|图|照片|相册|相机|拍|视频|动画|颜色|长什么|什么样|界面|弹窗|广告|图标)/;
/**
 * ★ 2026-10-31：**内容全在画面里**的 App —— 控件树只有壳（标题栏/切换按钮），
 * 照片网格、视频画面、网页正文都是自绘的。这类 App 每一步都得带图，否则等于闭眼。
 */
const VISION_APPS = /gallery3d|camera2|mark\.via|bilibili|aweme|youtube/i;
/** 探索型目标：不写进记忆，也不读别人的记忆（它不是可复现的"招式"）。 */
const EXPLORE_GOAL = /(随便|随便点|逛逛|瞎|乱点|玩玩|看看有什么|试试看)/;
/**
 * ★ 2026-10-31：截图类目标。这类目标**截到图就算做完了**，不该继续折腾；
 * 反过来，说"发给他了"却没真截到，必须被打回（10-31 上午她就是这么"发出去"了一张不存在的图）。
 *
 * ★ 2026-10-31（自己会玩·真机实测）：`截下来` / `截一下` / `截个` 原来**都不认**。
 * 会话里的目标写的是"挑一张像我的，**截下来**"，于是既没有"截到才算成"的断言，
 * prompt 里也没有任何一句告诉她该收尾了 —— 真机跑了 53 秒、翻了五屏、一次快门都没按。
 */
const SHOT_GOAL = /(截(个|一)?(张|下)?(来|图)?|截屏|截一下|拍(一)?张(照|照片))/;
/**
 * ★ 2026-10-31：她嘴里的"主页"其实就是桌面（Lawnchair）。
 * 旧断言把「主页」当 App 名词、又规定"桌面不参与"，于是**真的回到桌面也判失败**——
 * 10-31 上午「返回主页看看」「先返回再回主页」两条就是这么被冤枉的。
 */
const HOME_NOUNS = ['主页', '桌面', '主界面', '首页', '主屏', '主屏幕'];
/** 目标里带这些字，就说明"要动手"，不允许 0 步报完成。 */
const WANTS_ACTION = /(点|按|滑|划|打开|开|进|搜|翻|发|截|拍|切|关|删|输|打|返回|退|回)/;
/**
 * ★ 2026-11-12（P0）：**"打开 X 看看"不是"打开 X"**。
 *
 * 真机上 `episodes` 里「打开日记本看看」是 `ok:true / steps:[] / 570ms` ——
 * `quickSkill` 把"看看"当语气尾巴削掉了，于是开完就收工，**一眼都没看**。
 * 所以 `doQuick` 打开成功之后，只要目标里还有这类尾巴，就把屏幕交回主循环（她会自己 `read` 一屏）。
 */
const OPEN_AND_LOOK = /(里面|里头|有什么|有啥|看看|看一下|瞧瞧|读|搜|挑|找|第一条|读一读|翻翻)/;
/**
 * ★ 2026-11-06 **21:40 撤掉了三个词表**（`TASTE_WORD` / `IMAGE_WORD` / `LOOK_GOAL`）。
 *
 * 它们原本用来猜"这句话是不是想看图片"：命中就把搜索改写成 `/images/search`。
 * 用户实测后否了：「我是想她学会浏览，**不是一进来就默认图片页面**」——
 * 21:25 / 21:27 两条都是 0 步 9 秒"完成"，她一次结果页都没看过。
 *
 * 现在：搜索**一律网页**；"看图"是她自己在浏览里写的一个动作（`images 词`），
 * 挑中了再 `save 3`。**猜关键词不如给她动词**——这是这一笔真正的教训。
 */
/**
 * ★ 意图词表：她这台手机上真正存在的东西。
 * 用它把"看看相册里有什么"和"相册里有什么东西"归成同一个意图，同时让"随便点"跟它们互不相干。
 */
const INTENT_NOUNS = [
  '相册', '图库', '照片', '相机', '拍照', '设置', '浏览器', '网页', '视频', '音乐',
  '文件', '桌面', '主页', '通知', '应用', '存储', '壁纸', '音量',
];
/** 她这台手机上能叫得出名字的东西（用来把"打开图库看看照片"切成「图库」+「看看照片」）。 */
const KNOWN_APPS = [
  '相册', '图库', '照片', '相机', '设置', '浏览器', '文件', '桌面', '视频', '音乐',
  '时钟', '计算器', '应用商店', '游戏中心', '微信', 'QQ', '抖音', '哔哩哔哩', '网易云音乐',
];

/** `[手机:看看相册]` → 摘掉标记，返回剩下的正文 + 目标列表。 */
function parseTag(text) {
  const src = String(text || '');
  const goals = [];
  let m;
  TAG_RX.lastIndex = 0;
  while ((m = TAG_RX.exec(src))) {
    const g = m[1].trim();
    if (g) goals.push(g);
  }
  const cleaned = src
    .split('\n')
    .filter((line) => !/^\s*\[手机\s*[:：][^\]]*\]\s*$/.test(line))
    .join('\n')
    .replace(TAG_RX, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text: cleaned, goals };
}

/**
 * 从模型那一行里认出动作。小模型经常带前缀/标点/```，所以：
 * 逐行找**第一个以动词开头的行**，认不出来就返回 null（上层当作"没想出办法"）。
 *
 * ★ 2026-11-02：多了一段可选的「预期」：`tap n3 | 预期: 视频页`。
 * 这是**零成本的反思** —— 模型自己说"我以为会发生什么"，代码拿这一屏去核对，
 * 不用再多问一次模型（比"每步发图让 VLM 自评"便宜 100%，而且 VLM 自评并不准：
 * `verifyDone()` 那段注释里写过，agent 自报成功率约 39% 是错的）。
 * `line` 里**不含**预期（写进 hints 的只有动作本身）。
 */
function parseAction(text) {
  // 只去掉围栏符号，别把围栏里的那一行也删了（模型经常整段包在 ``` 里）
  const body = String(text || '').replace(/```[a-zA-Z]*\s*\n?/g, '').replace(/```/g, '').trim();
  for (const raw of body.split(/\n+/)) {
    const line = raw.trim()
      .replace(/^[-*·•]\s*/, '')
      /** 模型写计划时爱编号（"1. tap n3" / "步骤2: read"），编号不是动作。 */
      .replace(/^\d+\s*[.、)]\s*/, '')
      .replace(/^步骤\s*\d+\s*[:：]\s*/, '');
    if (!line) continue;
    /** 先切出"预期"那一段（全角竖线也认）。 */
    const parts = line.split(/[|｜]/);
    const head = parts[0];
    const tail = parts.slice(1).join(' ');
    const m = /^([a-zA-Z]+)\s*[:：]?\s*(.*)$/.exec(head.trim());
    if (!m) continue;
    const verb = m[1].toLowerCase();
    if (!VERBS.includes(verb)) continue;
    const arg = m[2].trim();
    const expect = ((/(?:预期|expect)\s*[:：]\s*([^|｜]{1,30})/.exec(tail) || [])[1] || '').trim();
    return { verb, arg, expect, line: `${verb}${arg ? ' ' + arg : ''}` };
  }
  return null;
}

/**
 * ★ 2026-11-07：**一次问出"接下来最多 3 步"，然后按顺序做。**
 *
 * 真机（20:37 那条「搜一只猫的图片」）：搜索 1 秒就完成了，可接下来 20 步、114 秒里
 * 她点了十几个不同的 n（图片页顶栏/缩略图/结果标题），一个目标都没靠近 ——
 * 每一步都只拿到"这一屏"，没有"我打算先干嘛再干嘛"。
 * 现在让模型在一次调用里写一个小计划，代码按顺序执行；中途某一步没动就直接作废重想。
 */
function parsePlan(text) {
  const out = [];
  for (const raw of String(text || '').replace(/```[a-zA-Z]*\s*\n?/g, '').replace(/```/g, '').split(/\n+/)) {
    const a = parseAction(raw);
    if (!a) continue;
    out.push(a.line);
    if (out.length >= 3) break;
  }
  return out;
}

/**
 * 把"先…再…""…然后…"拆成几个小目标。
 *
 * ★ 2026-10-31：`先返回再回主页` 原来整句进主循环 —— 8 次模型、28 秒，最后还判失败
 * （桌面上哪来的"主页"）。拆开之后两段都是快捷技能，0 token、1 秒做完。
 * 保守：只拆 2~3 段，且每段自己必须也是快捷技能，否则整句原样交给主循环
 * （`点进去再返回主页试试` 不许被拆成假成功）。
 */
function splitSeq(g) {
  const s = String(g || '');
  if (!/(再|然后|接着|之后)/.test(s)) return null;
  const body = s.replace(/^先/, '');
  const parts = body.split(/(?:然后|接着|之后|再)/).map((x) => x.trim()).filter(Boolean);
  if (parts.length < 2 || parts.length > 3) return null;
  return parts;
}

/**
 * 一句话就能做完的事直接做，不花 token、不等模型。
 *
 * ★ 2026-10-31 收紧：**只有整句就是那一条指令时才命中**。
 * 旧版是子串匹配，`点进去再返回主页试试` 被 `/回主页/` 吃掉，变成"按一下 HOME → 0 步报成功"——
 * 这是最伤的一种：她没做，却说做完了。目标解析也不许把动词尾巴吃进 App 名
 * （旧版把 `打开相册看看` 解析成 App「相册看看」，32 ms 就失败）。
 *
 * ★ 2026-10-31 上午补的两处（用户实测撞出来的）：
 *   · `截张图发给他` 认不出来 → 进了主循环 → 0 步报完成被断言打回 → 图没发出去；
 *   · `先返回再回主页` 认不出来 → 8 次模型白跑、还判失败。
 */
function quickSkill(goal) {
  const raw = String(goal || '').trim();
  if (!raw) return null;
  const g = raw.replace(/[\s，。,.!?！？、~～…]+/g, '');

  // 0) 复合目标：先拆。拆不动就往下走单句规则。
  const seq = splitSeq(g);
  if (seq) {
    const parts = seq.map((p) => quickSkill(p));
    if (parts.every(Boolean) && !parts.some((p) => p.kind === 'seq')) return { kind: 'seq', parts };
  }

  // 1) 截图 / 让我看看你屏幕（整句）。带"发给他/发给我/发过去"这类尾巴也算。
  if (/^(给我)?(截(个|一)?(张)?图|截屏|截一张|拍(一)?张(照|照片)?)(发(给)?(他|我|你)|发(过去|过来)|发到qq|传(给)?(他|我)|给我)?(看看|看|呗)?$/.test(g)) return { kind: 'shot' };
  if (/^(让我)?(看看|看(一眼|一下))?(你|你的)?(现在)?(的)?(手机|屏幕|在干嘛|在干什么)(呢|啊|呗)?$/.test(g)) return { kind: 'shot' };
  // 2) 回桌面（整句）
  if (/^(回|返回|回到|退到|退出去)?(桌面|主屏|主屏幕|主页|主界面|首页)(去|吧|呗)?$/.test(g)) return { kind: 'home' };
  // 3) 返回键（整句）：只在复合目标被拆开之后才用得上
  if (/^(按|点|按一下|点一下)?(返回键|返回|后退|退一步|退回去|回退)(键)?$/.test(g)) return { kind: 'back' };
  /**
   * ★ 2026-11-07：**"往下翻"不再交给模型猜**。
   *
   * 用户实测：他说「你现在往下滑」，她嘴上说"下滑了"，手机一动没动；
   * 她写 `[手机:往下翻]` 之后又要走"看一眼 → 问模型 → 滑 → 再验"四步。
   * 这句话本来就是**一个确定的手势**，不该花一次模型调用，更不该猜方向。
   */
  const sc = /^(?:继续|再|先)?(?:把这页|把这一页|把屏幕|这页)?(?:往|向)?(下|上)(?:翻|滑|滚|划)(?:一屏|一下|一点|翻翻|翻|滑滑|滑|看看|看|呗|吧)?$/.exec(g);
  if (sc) return { kind: 'scroll', dir: sc[1] === '下' ? 'down' : 'up', screens: 1 };
  /** 「读一下这一页 / 这一页讲了什么」也是确定动作：把这一屏整理成一段话，0 次模型。 */
  if (/^(?:读一下|读读|念念|念一下|看看这一页|看看这页|读这一页|读这页|这一页讲了什么|这页讲了什么|这一屏是什么)(?:这一页|这页|这一屏)?$/.test(g)) {
    return { kind: 'read' };
  }
  /**
   * ★ 2026-11-08（R-B）：**「点搜索框 / 点地址栏」不是一件事，是缺一个词**。
   *
   * 真机 22:02–22:04：她写 `[手机:点搜索框]`，`phone-agent` 没有这个快捷动作 →
   * 进主循环一步步猜：`tap n0 / tap n1 / text 小猫 / key enter`，
   * **20 步 / 12 次模型 / 119 秒 / 失败**，还把"小猫"（她自己的口味词）打进了搜索框。
   *
   * 现在直接告诉她"这一屏要搜什么得说清一个词"——让她下一步变成"缺一个词"，
   * 而不是拿输入框较劲 20 步。返回 `null` 会让它继续进主循环，所以必须返回一个**不做事**的动作。
   */
  const needKw = /^(?:先)?(?:点|点击|轻点|按|打开|点开|进|去)?(?:一下)?(?:那个|这个)?(?:上面的?)?(?:搜索框|搜索栏|地址栏|输入框|搜索键|搜索按钮|放大镜)$/.exec(g);
  if (needKw) return { kind: 'needKeyword', what: needKw[0] };
  /**
   * ★ 2026-11-08（R-C2）：**「点图片左边的网页」= 点那个"网页"**（方位词后面才是真宾语）。
   * 结果页顶上那排是「网页 | 图片 | 视频」，他要的是点回"网页"那一栏。
   */
  const sideTap = /^(?:点|点击|轻点|按)(?:一下)?(?:那个|这个)?(?:图片|视频|网页|搜索结果)(?:的)?(?:左边|右边|旁边)(?:的|那个)?(网页|图片|视频|搜索结果|网址|网站|链接)$/.exec(g);
  if (sideTap) return { kind: 'taptext', needle: sideTap[1] };
  /**
   * ★ 2026-11-08：**「taptext 网页」也是确定动作**（0 次模型）。
   *
   * 他说「你点网页」的时候，这件事本来就是"点屏上带『网页』这两个字的那个东西"——
   * 以前要走主循环：dump → 问模型 → 猜 n7 → 点 → 再验，四五秒还可能点空。
   */
  const tt = /^(?:taptext|点字)\s*[:：]?\s*(.{1,12})$/.exec(g);
  if (tt) return { kind: 'taptext', needle: tt[1].trim() };
  /** 「点网页」这种她自己在 `[手机:…]` 里写的短句，同样不必问模型。 */
  const tapw = /^(?:点|点击|轻点|按)(?:一下)?(?:那个|这个)?(网页|图片|视频|搜索结果|下一页|上一页)$/.exec(g);
  if (tapw) return { kind: 'taptext', needle: tapw[1] };
  /**
   * ★ 2026-11-08：**「打开第 1 条」也是确定的**（结果页上那一条 = 一个网址）。
   * 他说「点进去第一条」时，这件事不该花一次模型调用再去猜点哪儿。
   */
  const op = /^(?:open|打开第|点第|点进去第)(\d+|[一二两三四五六七八九十])[条个]?$/.exec(g);
  if (op) {
    const CN = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
    const n = /^\d+$/.test(op[1]) ? Number(op[1]) : (CN[op[1]] || 1);
    return { kind: 'open', n };
  }
  /**
   * ★ 2026-10-31（第二轮）：**"随便搜点东西"这种没给词的搜索，她自己挑词去搜**。
   *
   * 用户实测：「打开浏览器并随便搜点东西」→ 她只打开浏览器就收工 / 或者在地址栏上瞎戳。
   * 现在走**系统 intent 直接开搜索页**（`am start VIEW`），不点地址栏：
   * 浏览器工具栏是自绘的、滚动还会藏，小模型只会在顶上瞎戳，打出来的字常常没进地址栏。
   * 给了词的（"在浏览器里搜困了怎么办"）直接把词拿出来，同样一条 intent 到结果页。
   */
  if (/^(随便|去|再)?(搜|搜索|找)(一|点|个|些|一下)?(东西|什么|点东西|点好玩的)?(看看|看|吧|呗)?$/.test(g)) return { kind: 'search' };
  /**
   * ★ 2026-11-08（P0-0）：**"去/点/在/用/打开 + 浏览器 + 搜 X"**。
   *
   * 旧正则只允许 `继续|再|去|在` 起头，`点浏览器搜索X` / `用浏览器搜X` 全落空。
   * 现在和 `phone-intent` 的那条规则对齐（两边认得出的是同一批说法）。
   */
  const sk = /^(?:继续|再|去|到|在|用|拿|点|打开|点开|进)?(?:浏览器|网上|手机|网页)?(?:里|上|中)?(?:搜索|搜|查找|查)(?:一下|一搜)?(.{2,30})$/.exec(g);
  if (sk) {
    /**
     * ★ 2026-11-07：**"搜一下今天的新闻，挑一条点开看看"只搜前半句。**
     *
     * `splitGoal` 会按逗号把它拆成两段；但拆开之后第一段"搜一下今天的新闻"和第二段
     * "挑一条点开看看"本来是同一件事的两步 —— 真机上拆开的结果是**整件事跑了两遍**
     * （第一段自己就把"点开+读"做完了，第二段又读了一遍）。
     * 这里在动词前截断，让搜索只拿真正的关键词；后半句留在 `task.goal` 里由计划继续做。
     */
    /**
     * ★ 2026-11-08：**前缀要允许中间夹标点**（`打开浏览器，搜点东西`）。
     *
     * `sk` 匹配的是 `g`（已去标点、也去了空格），而关键词必须从 `raw` 里剥 ——
     * 不然"蓝色大女仆 卡通图"中间那个空格会被吃掉（真机这种中英混排查询会粘连）。
     * 所以这里从 `raw` 剥，但**前缀各段之间允许标点**（逗号常夹在"打开浏览器"和"搜"之间）。
     */
    const kwSource = String(raw || '')
      .replace(/^(?:继续|再|去|到|在|用|拿|点|打开|点开|进)?[\s，,]*?(?:浏览器|网上|手机|网页)?[\s，,]*?(?:里|上|中)?[\s，,]*?(?:搜索|搜|查找|查)(?:一下|一搜)?/, '')
      .trim();
    const rawKw = (kwSource || sk[1])
      .replace(/[。！!？?]+$/, '')
      .replace(/^(一下|一搜)/, '')
      .replace(/(看看|看|吧|呗|一下)$/, '')
      .replace(/^(?:一张|几张|一只|一个|一些|一点|点)/, '')
      /**
       * ★ 2026-11-08：**"表情包"不许剥**。
       *
       * 这里原来把词尾的 `图片|照片|图片集|表情包` 一起削掉 —— 于是"搜小肥鱼表情包"
       * 变成搜"小肥鱼"（真机 22:05 那趟就是这么搜的）。可"表情包"本身就是他要找的东西，
       * 不是"图的类型"；只有 `的图片 / 照片` 那种才是修饰。（"搜一只猫的图片"仍要变成"猫"。）
       */
      .replace(/(?:的)?(?:图片集|图片|照片)$/, '')
      .split(/(?:挑一|挑个|挑|点开|点一|打开第|看看|看一|读一|读读|翻一|选一|选个)/)[0]
      .replace(/^[\s，,。；;：:]+|[\s，,。；;：:]+$/g, '')
      .trim();
    const kw = rawKw;
    // "搜索框/搜索栏/搜索键"不是要搜的东西
    if (kw && !/^(点|个|些|东西|什么|框|栏|键|按钮|引擎|条)/.test(kw)) {
      /** ★ 2026-11-06 21:40：搜索一律走网页；"看图"是她自己的动作（`images` 动词），不是默认。 */
      return { kind: 'search', keyword: kw };
    }
  }
  /**
   * ★ 2026-11-08（用户：「她还不会重启软件（关了再打开）」）：**重启 = 真的关掉再开**。
   *
   * 真机 23:07:56 他说「重启一下浏览器吧，好像有点卡了」→ 她写 `[手机:重启浏览器]`，
   * `quickSkill` 认不出 → 进主循环 → `key home → launch 浏览器`（×2）——
   * 而 `launch` 只是把 App **恢复**到原来那一页，验证码还在，于是跑 125 秒、20 步还是那一屏。
   * 现在这是一步确定动作：`am force-stop` → 冷启动 → 验真的回到首页。
   *
   * ⚠️ 故意**不含"刷新"**：刷新是"重载这一页"，不是"关掉 App 重开"，别把两件事混一起。
   */
  const rs = /^(?:重启|重开|重新打开|关了再打开|关掉再开|关一下再开|重新启动)(?:一下|下)?(?:那个|这个)?(.{1,10})?$/.exec(g);
  if (rs) {
    const app = String(rs[1] || '').replace(/(看看|一下吧|一下|吧|呗|看看)$/g, '').trim();
    /** 整台手机/模拟器不归我管（那是 MuMu 本体），别假装能重开它。 */
    if (/^(手机|模拟器|系统|安卓|MuMu|mumu)$/i.test(app)) return { kind: 'restartPhone', app };
    return { kind: 'restart', app: app || '浏览器' };
  }
  /** ★ 2026-11-08：反过来说也要认 —— 「把浏览器关了再打开」「浏览器关掉再开」。 */
  const rs2 = /^(?:把|给|帮|帮我|麻烦)?(.{1,10}?)(?:关掉?了?再(?:打开|开|启动)|关了再打开)$/.exec(g);
  if (rs2) {
    const app = String(rs2[1] || '').replace(/^(那个|这个)/, '').trim();
    if (app) return { kind: 'restart', app };
  }
  // 4) 打开某个 App（整句）：动词之后**全是** App 名，尾巴上的"看看/一下/吧"削掉
  const m = /^(打开|打开一下|开一下|开|进|进去)(.{1,14})$/.exec(g);
  if (m) {
    let rest = m[2];
    // ★ 2026-10-31：先认已知 App 名，"图库看看照片"要被切成「图库」+「看看照片」，
    // 而不是把整串当成 App 名（真机实测这么失败过：打不开「图库看看照片」）。
    const hit = KNOWN_APPS.find((k) => rest.startsWith(k));
    let app;
    let tail = '';
    if (hit) {
      app = hit;
      tail = rest.slice(hit.length);
    } else {
      app = rest.replace(/(看看|看一下|瞧一眼|一眼|一下|试试|吧|呢|啊|呗|里面|里去|去)$/g, '').trim();
    }
    tail = tail.replace(/^(看看|看一下|瞧一眼|一眼|去|一下|吧|呢|啊|呗)/, '').trim();
    if (!app || /^(看看|翻翻|逛逛|随便|点|一下)/.test(app)) return null;
    // 目标里还有别的东西（"看看照片"）→ 交给主循环，别 0 步就报"做完了"
    if (tail) return null;
    return { kind: 'launch', app };
  }
  return null;
}

/**
 * ★ 2026-10-31（第二轮）：**一句话里有几件事，拆成几段**。
 *
 * 用户实测（10:47）：「打开浏览器并随便搜点东西」→ 她只打开浏览器就收工。
 * 三种常见说法都要认：
 *   · 连接词：`A 并/然后/接着/，B`、`先 A 再 B`；
 *   · `打开<App>` 后面还挂着一件事：`打开浏览器搜点东西` → 「打开浏览器」+「搜点东西」；
 *   · 回桌面后面还挂着一件事：`返回主页搜索小肥鱼` → 「返回主页」+「搜索小肥鱼」。
 * 拆不动的原样返回 `[]`（交给单目标老路，别硬拆）。
 */
function splitGoal(goal) {
  const g = String(goal || '').trim();
  if (!g) return [];

  // 1) 连接词
  const body = /^先/.test(g) ? g.slice(1) : g;
  const cut = body
    .split(/(?:然后|接着|之后|并且|并|，|,|；|;|再)/)
    .map((x) => x.trim())
    .filter((x) => x.length >= 2);
  /**
   * ★ 2026-11-07：**"搜 X，挑一条点开看看"是一件事，不是两件。**
   *
   * 拆开之后第一段会自己把"点开+读"也做完，第二段再读一遍 —— 真机上整件事跑了两遍。
   * 只有"第一段是搜索、第二段是它的后续动作"这种才不拆；其它（"打开浏览器，搜点东西"）
   * 仍然拆，拆了才能各用各的快捷技能。
   */
  if (cut.length === 2 && /^(?:搜|搜索|查|找)/.test(cut[0]) && /^(?:挑|点|看|读|翻|选|进|打开)/.test(cut[1])) return [];
  if (cut.length >= 2 && cut.length <= 3) return cut;

  // 2) `打开<App>…`：App 名后面还有事（"打开浏览器搜点东西"）
  /**
   * ★ 2026-11-08：**"打开哔哩哔哩搜猫"不是"打开浏览器搜猫"**。
   *
   * 拆成「打开哔哩哔哩」+「搜猫」之后，第二段走的是 `quickSearch`（一条 intent 去**必应**）
   * —— 他说"在B站里搜猫"，她跑去搜了整个网页。这几个 App **自己带搜索框**，
   * 后面那个"搜"是**在 App 里搜**，拆开就把上下文丢了，所以整句留给主循环按 App 套路做。
   */
  const SEARCH_IN_APP = new Set(['哔哩哔哩', 'b站', 'B站', '抖音', '网易云音乐', '应用商店', '游戏中心']);
  for (const app of KNOWN_APPS) {
    for (const v of ['打开', '点开', '开']) {
      const head = `${v}${app}`;
      if (!g.startsWith(head)) continue;
      const tail = g.slice(head.length).replace(/^(并|然后|接着|之后|再|，|,)/, '').trim();
      if (tail.length >= 3 && SEARCH_IN_APP.has(app) && /^(搜|搜索|查找|查|找)/.test(tail)) return [];
      if (tail.length >= 3 && !/^(看看|看一下|瞧瞧|一眼)$/.test(tail)) return [head, tail];
    }
  }

  // 3) `返回主页/回桌面…`：前面那截是回桌面，后面还挂着一件事
  const hm = /^((?:先)?(?:返回|回到|回|退到|退)(?:到)?(?:主页|桌面|主屏|主屏幕|主界面|首页))(.{3,})$/.exec(g);
  if (hm) {
    const tail = hm[2].replace(/^(并|然后|接着|之后|再|，|,)/, '').trim();
    if (tail.length >= 2) return [hm[1], tail];
  }

  return [];
}

/** 目标里出现了哪些"她手机上的东西"。用来做记忆的意图键，也用来做完成断言。 */
function goalNouns(goal) {
  const g = String(goal || '');
  return INTENT_NOUNS.filter((n) => g.includes(n));
}

/**
 * ★ 2026-10-31：同义词。
 * 她说"图库"，屏幕上报的是「相册」（`APP_NAMES` 里 gallery3d 就叫相册）——
 * 真机实测因为这一条，把她**真的**打开了一张照片判成了"没弄成"。宁可宽一点，也不能冤她。
 */
const NOUN_ALIAS = {
  图库: /相册|图库|照片|gallery/i,
  相册: /相册|图库|照片|gallery/i,
  照片: /相册|图库|照片|gallery/i,
  相机: /相机|camera/i,
  拍照: /相机|camera/i,
  浏览器: /浏览器|via|browser|网页/i,
  网页: /浏览器|via|browser|网页/i,
  视频: /视频|电影|影片|movie|video/i,
  音乐: /音乐|歌曲|music/i,
  设置: /设置|setting/i,
  文件: /文件|document|folder/i,
};

/**
 * 这一屏上有没有"目标里的那个东西"（带同义词）。
 * ★ 桌面不参与：桌面上那个「图库」图标只是**入口**，不代表她进了图库。
 *   真机踩过：她停在桌面说"相册看完了"，靠图标名居然算通过了。
 */
function screenHasGoal(blob, nouns, { onHome = false } = {}) {
  const text = String(blob || '');
  if (onHome) return false;
  return nouns.some((n) => (NOUN_ALIAS[n] || new RegExp(n)).test(text));
}

/**
 * ★ 2026-11-08（真机 23:05–23:11）：**人机验证（滑块）墙**。
 *
 * 他让她搜天气，可浏览器停在一个"拖动滑块完成验证"的页上：
 * 她先 `drag 0.1 0.55 0.9 0.55` 再 `drag 0.15 0.62 …` —— 位置全靠猜，
 * 两次都"没滑到底"，然后 20 步全耗在这一屏（两次任务共 227 秒、24 次模型）。
 * 用户看得很清楚：「被前面的滑动验证注意力吸引」。
 *
 * 判定只认**屏上真有的字**，而且要求字很少（整页就是验证）或明确带"滑块/拼图"，
 * 免得把一篇讲"验证码"的新闻当成验证页。
 */
const CAPTCHA_STRONG = /(滑动验证|拖动.{0,6}滑块|请按住滑块|完成拼图|拼图验证|安全验证|人机验证|请完成.{0,8}验证|通过验证|verify you are human|unusual traffic|are you a robot)/i;
const CAPTCHA_WEAK = /(验证码|验证)/;

function captchaOf(obs) {
  const nodes = (obs && obs.nodes) || [];
  const text = `${nodes.map((n) => `${n.text || ''} ${n.desc || ''}`).join(' ')} ${(obs && obs.table) || ''}`.replace(/\s+/g, ' ');
  if (!text) return '';
  const strong = CAPTCHA_STRONG.exec(text);
  if (strong) return strong[0];
  /**
   * 弱判据（只有"验证码/验证"这两个字）要更严：**整屏字很少**，而且有一个**短标签**就是它。
   * 不然一篇讲"验证码泄露"的新闻（第一段就带这两个字）会被当成验证页，整件事被误判成"过不去"。
   */
  const len = text.replace(/\s+/g, '').length;
  if (len > 160) return '';
  const short = nodes.some((n) => {
    const t = `${n.text || ''}${n.desc || ''}`.replace(/\s+/g, '');
    return t.length > 0 && t.length <= 12 && CAPTCHA_WEAK.test(t);
  });
  return short ? '验证码' : '';
}

/**
 * 在验证页上**自己找那条滑轨**并拖到底（最多一次）。
 *
 * 判据是形状：下半屏里**最宽的一条可点/可拖的横条**（滑块验证的轨道就是这样），
 * 从它的左边缘往里一点拖到右边缘差一点点，慢慢拖（600ms）——太快会被判成机器人。
 * 找不到轨道就退化成"整屏横向拖一次"。
 *
 * @returns {Promise<string>} 做了什么都如实说（`''` = 什么都没做）
 */
async function slideCaptcha(adb, obs, screen) {
  const scr = screen || (obs && obs.screen) || { width: 720, height: 1280 };
  const W = Number(scr.width) || 720;
  const H = Number(scr.height) || 1280;
  const cands = ((obs && obs.nodes) || [])
    .filter((n) => n && n.bounds && (n.clickable || /seekbar|progress/i.test(String(n.class || ''))))
    .map((n) => ({
      n,
      x1: n.bounds[0], y1: n.bounds[1], x2: n.bounds[2], y2: n.bounds[3],
      w: n.bounds[2] - n.bounds[0], h: n.bounds[3] - n.bounds[1],
    }))
    .filter((c) => c.w >= W * 0.45 && c.h <= H * 0.22 && c.h >= 4 && c.y1 > H * 0.3);
  let x1;
  let x2;
  let cy;
  if (cands.length) {
    cands.sort((a, b) => (b.w - a.w) || (b.h - a.h));
    const t = cands[0];
    x1 = Math.round(t.x1 + Math.min(28, t.w * 0.08));
    x2 = Math.round(t.x2 - Math.min(10, t.w * 0.03));
    cy = Math.round((t.y1 + t.y2) / 2);
  } else {
    x1 = Math.round(W * 0.12);
    x2 = Math.round(W * 0.9);
    cy = Math.round(H * 0.55);
  }
  const r = (typeof adb.swipe === 'function')
    ? await adb.swipe(x1, cy, x2, cy, 700)
    : (typeof adb.swipeDir === 'function' ? await adb.swipeDir('right') : { ok: false });
  if (!r || r.ok === false) return '';
  return `把滑块从 (${x1},${cy}) 拖到 (${x2},${cy})`;
}

/** 换一个引擎再搜（同一个词，避免死磕一个被拦的站）。 */
function otherEngineUrl(kw) {
  return `https://www.baidu.com/s?wd=${encodeURIComponent(String(kw || ''))}`;
}

/**
 * ★ 2026-11-08 夜（用户：「她发的消息和视频内容完全对不上」）：
 * **回灌那句话到底说没说这件事** —— 只做一件最朴素的事：把事实里的实词抠出来，看她那句里有没有。
 *
 * 真机 23:36：视频那场的总结是《小傻龙…》「画面里一只手在戳Q版小傻龙和小鲸鱼的摆件」，
 * 她回灌却成了「看了个**修老物件的，把锈住的螺丝泡开一点点拆**」——
 * 两句话里没有一个实词对得上（查过 `turns.jsonl` 全库：那是纯编的）。
 * 编出来的细节一旦进流水就是她的记忆（这条项目里已经踩过一次），所以这里做一道**硬核对**。
 */
const FACT_STOP = /^(视频|一条|两条|刷了|看了|看着|画面|内容|一段|这个|那个|什么|时候|感觉|有点|不太|没太|然后|就是|一下|东西|标题|弹幕|讨论|看到|秒|分钟|条视频|里一|只手)$/;
/** 以这些字开头的片段多半是虚词/介词，不能当"实词"。 */
const FACT_WEAK_HEAD = /^[的了和在被把就也都还又很太更最里一个这那有个些]/;

function factTokens(text, max = 16) {
  const s = String(text || '');
  const out = [];
  const push = (t) => {
    const w = String(t || '').replace(/[“”"'‘’「」『』《》（）()、，,。.：:；;…!?！？\s]/g, '').trim();
    if (w.length < 2 || w.length > 10) return;
    if (FACT_STOP.test(w) || FACT_WEAK_HEAD.test(w)) return;
    if (out.includes(w)) return;
    out.push(w);
  };
  /** 书名号里的标题最重要（`《小傻龙：…》`）—— 只取冒号前面那一截。 */
  for (const m of s.matchAll(/《([^》]{2,60})》/g)) push(String(m[1]).split(/[：:，,。.…]/)[0].slice(0, 10));
  /** 中文按"连续汉字串"切：短串整串留，长串取头尾（通常是主语/宾语）。 */
  for (const run of s.match(/[\u4e00-\u9fa5]{2,}/g) || []) {
    if (run.length <= 6) push(run);
    else { push(run.slice(0, 4)); push(run.slice(-4)); }
    if (out.length >= max) break;
  }
  /** 英文/数字词（标题里常见）。 */
  for (const w of s.match(/[A-Za-z0-9]{3,}/g) || []) push(w);
  return out.slice(0, max);
}

function mentionsFact(text, tokens) {
  const t = String(text || '');
  if (!t || !tokens || !tokens.length) return false;
  return tokens.some((w) => w.length >= 2 && t.includes(w));
}

/** 目标的意图键：探索型单独一类；有名词就按名词（最多两个）；否则取去掉虚词后的前 6 个字。 */
function intentOf(goal) {
  const g = String(goal || '').trim();
  if (!g) return 'general';
  if (EXPLORE_GOAL.test(g)) return 'explore';
  const nouns = goalNouns(g);
  if (nouns.length) return nouns.slice(0, 2).join('+');
  const cleaned = g
    .replace(/(帮我|给我|然后|再|一下|试试|看看|去|吧|呢|啊|呗|里|的|个)/g, '')
    .trim()
    .slice(0, 6);
  return cleaned || 'general';
}

/** 屏级记忆的键：**包名 + 屏指纹 + 意图**。少一样都会让"上次点这个"跑到别的目标上去。 */
function hintKey(pkg, hash, intent) {
  return `${pkg || '?'}|${hash || '?'}|${intent || 'general'}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * ★ 2026-11-01：**这些"等界面缓过来"的毫秒数改成可注入**（自检用）。
 *
 * 为什么：`quickSearch` 的 `sleep(1500) × 4` 与 `recover` 的 `sleep(500) × 2` 是真机上的
 * 合理节奏（等浏览器/系统动画），但自检里的假 adb 是**同步返回**的，
 * 于是 `17-phone` 光这两处就等了 **21+3.5 秒**，占全量 14%。
 * 断言验的是"屏上有没有那个词/画面变没变"，跟等多久无关 —— 所以把数值提出来，
 * 生产默认值一个都不改，自检走 `DSP_PHONE_SEARCH_POLL_MS` / `DSP_PHONE_SETTLE_MS`。
 */
const envMsOr = (name, def) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? n : def;
};

/**
 * ★ 2026-10-31：桌面桌面的包名。
 * 注意是 **Lawnchair**（`app.lawnchair`）—— 它不含 "launcher" 那串字母，
 * 旧代码 `/launcher/` 认不出来，于是"回到桌面了吗"永远判失败、而"停在桌面说做完了"永远判通过。
 *
 * ★ 2026-11-12：**和 `SYSTEM_PKG` 一起搬到 `phone-open.cjs` 了**（`openApp` 验前台包名也要用同一套），
 * 这里只是引用，别复制两份 —— 两张判据一旦分叉，"打开了没"和"有进展没"就会各说各话。
 */
const { LAUNCHER_PKG, SYSTEM_PKG } = openMod;

/**
 * ★ 2026-11-02：**系统弹窗不是"换了一个 App"**。
 *
 * `judge()` 里有一条"包名变了 = 有进展"，本意是"她真的进了另一个 App"。
 * 但权限框、安装器、通知栏的 `mCurrentFocus` **也是别的包名** ——
 * 于是一个弹窗弹出来，卡住计数被清零、`strongProgress` 也被置真（记忆还会把"点出弹窗"记成好招）。
 * 真机上这就是"被广告卡住却一直不算卡住"的一条来源。
 *
 * ★ 2026-11-12：和 `LAUNCHER_PKG` 一起搬到 `phone-open.cjs`，这里只引用。
 */

/**
 * ★ 2026-11-02（D 批）：**哪些"预期"是能核对的**。
 *
 * 模型写 `预期: 视频页` / `预期: 搜索结果` —— 这种能在这一屏的字里找到；
 * 写 `预期: 换下一条` 就核对不了（"换下一条"这四个字不会出现在任何界面上）。
 * 核对不了的一律返回 `null`：不夸奖、也不冤枉她。
 */
const EXPECT_CHECKABLE = /(页|界面|列表|首页|结果|相册|图库|设置|视频|搜索|详情|评论|主页|桌面|弹窗|广告|框|面板)/;

/**
 * ★ 2026-11-01（用户原话）：「是不是需要操控的时候每次给她反馈一下
 * （这次目标是想找个好看的视频，我刚刚点进了哔哩哔哩，现在我该在主页下滑或者
 * 挑一个感兴趣的看，下一步是…）」。
 *
 * 她原来的 prompt 只有"这一屏有什么"，没有"**我在哪、刚才那下有没有用、下一步能怎么走**"。
 * 真机表现就是：搜索页上不知道点结果、视频页不知道 back、首页一直往下滑。
 *
 * 这个函数把"这一屏是 App 的哪一层"翻译成一句人话 + 这个页面通常能怎么走。
 * **只是选项，不是命令** —— 说"可以 key back"，不说"现在必须 back"。
 */
function whereAmI(obs) {
  const pkg = String(obs?.app?.package || '');
  const act = String(obs?.app?.activity || '');
  if (!pkg) return { at: '', hint: '' };
  if (/launcher|Lawnchair/i.test(pkg)) {
    return { at: '桌面', hint: '想用哪个就 launch 它的名字（哔哩哔哩 / 相册 / 浏览器 / 设置）' };
  }
  if (pkg === 'tv.danmaku.bili' || pkg === 'tv.danmaku.bilik') {
    if (/BiliMainSearchActivity|[Ss]earch/i.test(act)) {
      return {
        at: '哔哩哔哩·搜索结果页',
        hint: '点一条带时长的结果卡片就进去了（卡片像「标题 作者 3:35」）；不想看了就 key back 回首页，别在搜索页上反复点',
      };
    }
    if (/UnitedBizDetails|StoryVideo|PlayerActivity/i.test(act)) {
      return {
        at: '哔哩哔哩·视频页',
        hint: '已经在看视频了。想换一个：竖屏流里 swipe up；从搜索结果进来的就 key back 回结果列表；想回首页 key back / launch 哔哩哔哩',
      };
    }
    if (/MainActivity/i.test(act)) {
      return {
        at: '哔哩哔哩·首页',
        hint: '最上面那条是搜索框（点它 → text 关键词 → key enter）；下面的卡片点封面就能看；没有想看的就 scroll down 3（翻两屏，看到你感兴趣的会自己停）',
      };
    }
    return { at: '哔哩哔哩', hint: '找不到入口时 key back 回上一页，或 launch 哔哩哔哩 回首页' };
  }
  /**
   * ★ 2026-11-02（D 批）：**相册 / 浏览器 / 通用列表**也说一句"这一屏怎么走"。
   *
   * 11-01 只补了桌面和 B 站三层；相册和浏览器（她最常去的两个地方）一直是"没有提示"，
   * 每一步都靠模型自己猜。这里全是 0 token 的常识。
   */
  if (/browser|mark\.via|chrome|quark|baidu|firefox/i.test(pkg)) {
    /**
     * ★ 2026-11-07：**浏览器要分三层说**（首页 / 搜索结果页 / 文章正文页）。
     *
     * 真机 20:47：她其实已经点开了一篇"北京暴雪"的新闻、正文都在屏上，
     * 但 `whereAmI()` 只会说"浏览器"，于是她下一轮又去点地址栏、重新搜一遍，
     * 20 步里有一半是在同一页上打转。
     * 判据只用控件树里真有的字，不猜。
     */
    const text = (obs?.nodes || []).map((n) => `${n.text || ''} ${n.desc || ''}`).join(' ');
    const textLen = text.replace(/\s+/g, '').length;
    const article = textLen >= 500 && /(记者|编辑|报道|讯（|讯\s|来源[:：]|责任编辑|发布时间|原标题)/.test(text);
    /**
     * ★ 2026-11-08：**"认得出 ≥1 条带网址的结果"就够判结果页了**。
     * 原来要求"屏上字 ≥300 个"——真机那张必应页只露出一条结果，字数刚好不够，
     * 于是她只被告知"浏览器"，没人告诉她这一屏是列表。
     */
    const found = surface.results(obs);
    const results = found.length >= 1
      || (/(搜索结果|相关搜索|网页|图片|视频|学术|词典|航班|搜索工具)/.test(text) && textLen >= 300);
    /**
     * ★ 2026-11-08：**人机验证页要单独认出来**（真机 23:05–23:11 两次任务共 227 秒全耗在滑块上）。
     * 认出来之后 she 就不会把它当成"结果页"或"文章页"去点。
     */
    const cap = captchaOf(obs);
    if (cap) {
      return {
        at: `浏览器·人机验证页（${cap}）`,
        hint: '这一屏**不是搜索结果**，是人机验证：拖滑块。别一次一次 drag（位置靠猜几乎过不去）—— '
          + '`restart 浏览器` 冷启动、或者 `openurl https://www.baidu.com/s?wd=关键词` 换个引擎；'
          + '还不行就 `done 被验证码拦住了`，别把步数烧在这',
      };
    }
    if (article) {
      return {
        at: '浏览器·文章正文页',
        hint: '这一屏是一篇文章的正文。想知道它讲了什么就 `read`（不要再去点地址栏、也不要重新搜）；'
          + '读完就 `done 一句话` 收工；想回结果列表就 `key back`',
      };
    }
    if (results) {
      /**
       * ★ 2026-11-08（用户当天原话）：「**我怀疑她不知道这个页面意味着什么，是不是应该告诉她
       * 正在浏览网页，每一条对应一个网址，网址的内容就是看到的网页**」。
       *
       * 真机 21:27：她把结果摘要里的"2781 张"当成了"那一页里的张数"，
       * 又连着三次"点进去了"其实都在点顶上那排页签 —— 因为她不知道这一屏是什么。
       * 这里把三件事写死：① 这不是一个网站，是列表；② 每一条 = 一个网址；
       * ③ 摘要不是那个网站的内容；④ 那排「网页/图片/视频」只切搜索类型，不打开网站。
       */
      return {
        at: '浏览器·搜索结果页',
        hint: `这一屏**不是一个网站**，是搜索结果的列表：每一条 = 一个网址（域名那一行就是网址），`
          + `标题是那个网页的名字，标题下面几行是搜索站给的摘要（**不是**那个网站里的内容）。`
          + `${found.length ? `这一屏能看到 ${found.length} 条。` : '想先看清有哪几条就 `read`。'}`
          + '要打开哪一条就 `open 1`（第 1 条）/ `open 2`…，打开之后看到的才是那个网址真正的样子；'
          + '顶部那排「网页/图片/视频」只是切换搜索类型（`taptext 网页` 切回网页），**它不打开任何网站**；'
          + '他说要看图才 `images 词`',
      };
    }
    return {
      at: '浏览器',
      hint: '最上面那条是地址/搜索栏（`tap 地址栏`（按文字也能点）→ `text 关键词` → `key enter`）；正文要往下看就 `scroll down 3`；'
        + '弹「打开 App / 下载」的横幅就用 taptext 取消 或 taptext 继续在浏览器；想回上一页 key back',
    };
  }
  if (/gallery3d/i.test(pkg)) {
    return {
      at: '相册',
      hint: '点文件夹卡片进去看照片（卡片可能是自绘的，用 tapxy）；照片页 swipe left 换下一张；key back 回上一层',
    };
  }
  if (/launcher|lawnchair/i.test(pkg)) {
    return { at: '桌面', hint: '想用哪个就 launch 它的名字（哔哩哔哩 / 相册 / 浏览器 / 设置）' };
  }
  return { at: obs?.app?.name || '手机', hint: '' };
}

/** 当前这一屏是不是"视频 App 的某一层"（给上面那几条 App 常识用）。 */
function isBili(obs) {
  return /^tv\.danmaku\.bili/.test(String(obs?.app?.package || ''));
}

class PhoneAgent {
  /**
   * @param {object} o
   * @param {object} o.adb                PhoneAdb 实例（或同形状的假货）
   * @param {object} o.model              `resolveModel()` 的结果
   * @param {Function} [o.callModel]      (model, messages, opts) => {text}
   * @param {string} o.dir                数据目录（hints/episodes/shots）
   * @param {string} [o.taste]           旧配置的口味；**只在没有 persona 快照时兜底**
   * @param {object} [o.persona]         `companion-persona.snapshot()` 的只读快照（同上）
   * @param {object} [o.budget]
   * @param {object} [o.vision]           `{enabled, detail}`
   * @param {Function} [o.emit]
   */
  constructor({ adb, model, callModel = null, dir, taste = DEFAULTS.taste, persona = null, personaJudge = null, budget = {}, vision = {}, rescue = null, popup: popupCfg = null, scroll: scrollCfg = null, open: openCfg = null, web, emit = () => {} }) {
    this.adb = adb;
    this.model = model;
    this.callModel = callModel || defaultCallModel;
    this.dir = dir;
    /**
     * ★ 2026-11-06（P2）：**她的"网"**（PC 侧 fetch：搜图 / 存图 / 读页）。
     * 手机上的浏览器拿不到 DOM，所以"挑一张存起来"只能走这一层；
     * 传 `web: null` 可以在自检里彻底关掉网络。
     */
    this.web = web === undefined ? require('./her-web.cjs') : web;
    this.taste = String(taste || DEFAULTS.taste);
    /**
     * ★ 2026-11-07：**这一场的只读人格快照**（每一场会话开始时由 `companion.cjs` 塞进来，
     * 见 `setPersona()`）。构造时传进来的也要过一遍断言 —— 对不上就不接。
     */
    this.persona = null;
    if (persona) this.setPersona(persona);
    /**
     * ★ 2026-11-07：**文字版"停/再翻"**（`CompanionBrain.judgePhone`，聊天模型）。
     * 看图那条仍由手来看（它必须看截图），但**判断口径**是同一份快照；
     * 没有截图 / 模型不收图时，这里顶上 —— 不再退回通用"猫/小动物/吃的"。
     * ⚠️ 不能叫 `this.judge`：这个类本来就有一个 `judge()` 方法（判"有没有进展"）。
     */
    this.personaJudge = typeof personaJudge === 'function' ? personaJudge : null;
    /** 这一件"她为什么想做 / 什么时候算够 / 想分享什么"（`phone-life` 排任务时带进来）。 */
    this.brief = null;
    /**
     * 她手机**现在停在哪一屏**（一段文字摘要，不带图）。
     * 回灌 / 他问"你现在看到什么" / 下一场计划都用它 —— 这是"当前屏"的唯一来源，
     * 不再从聊天流水里捡旧页。
     */
    this.lastScreen = '';
    this.lastScreenAt = 0;
    this.budget = {
      maxSteps: Number(budget.maxSteps) || DEFAULTS.maxSteps,
      maxMs: Number(budget.maxMs) || DEFAULTS.maxMs,
      maxCalls: Number(budget.maxCalls) || DEFAULTS.maxCalls,
      maxStall: Number(budget.maxStall) || DEFAULTS.maxStall,
      /** ★ 2026-11-08：排队的这一件等了多久还算"还值得做"（见 `drain()`）。 */
      maxQueuedMs: Number(budget.maxQueuedMs) || DEFAULTS.maxQueuedMs,
    };
    this.vision = {
      enabled: vision.enabled !== undefined ? !!vision.enabled : !!DEFAULTS.vision.enabled,
      detail: vision.detail === 'high' ? 'high' : 'low',
      /** ★ 2026-11-07：每一屏都看图（见 DEFAULTS.vision 的注释）。 */
      always: vision.always !== undefined ? !!vision.always : !!DEFAULTS.vision.always,
      /** 发给模型前缩到多宽（图 token 与宽度无关，但上传体积差别很大）。 */
      maxSide: Math.max(240, Math.min(1280, Number(vision.maxSide) || DEFAULTS.vision.maxSide)),
    };
    /** ★ 2026-11-07：第一次滚动前的沉降（网页刚打开时 4 秒不够，见 `scan()`）。 */
    this.scrollSettleMs = envMsOr('DSP_PHONE_SCROLL_SETTLE_MS', Number(DEFAULTS.scroll.settleMs) || 600);
    /** ★ 2026-11-07：往下翻时每屏都让她看图判断"停/再翻"（用户放开 token 后的选择）。 */
    const scCfg = (scrollCfg && typeof scrollCfg === 'object') ? scrollCfg : {};
    this.scrollLookEach = scCfg.lookEach !== undefined ? !!scCfg.lookEach : !!DEFAULTS.scroll.lookEach;
    this.scrollLookMax = Math.max(0, Math.min(8, Number(scCfg.lookMax) || DEFAULTS.scroll.lookMax));
    /** ★ 2026-11-01：卡住时"看图找出口"（第一优先级）。`max` = 一个任务最多几次。 */
    this.rescueCfg = { ...DEFAULTS.rescue, ...(rescue && typeof rescue === 'object' ? rescue : {}) };
    this.rescueCfg.max = Math.max(0, Math.min(50, Number(this.rescueCfg.max) || 0));
    this.rescueCfg.enabled = this.rescueCfg.enabled !== false && this.rescueCfg.max > 0;
    /** ★ 2026-11-02：弹窗/广告层（0 token）。见 `phone-popup.cjs` 与 `DEFAULTS.popup`。 */
    this.popupCfg = { ...DEFAULTS.popup, ...(popupCfg && typeof popupCfg === 'object' ? popupCfg : {}) };
    this.popupCfg.enabled = this.popupCfg.enabled !== false;
    this.popupCfg.max = Math.max(0, Math.min(30, Number(this.popupCfg.max) || 0));
    this.popupCfg.maxSame = Math.max(1, Math.min(10, Number(this.popupCfg.maxSame) || 3));
    /** 模型拒过图吗？拒过一次就整个进程不再发图（不反复撞 400）。 */
    this.visionOK = null;
    /** 这一屏的图发过了就记下来（同一屏不重复发，省 1.2 秒/步）。 */
    this.visionSeen = new Set();
    this.emit = emit;
    /** 等搜索页加载的轮询间隔、以及 back/home 之后的沉降时间（见文件顶部 `envMsOr`）。 */
    this.searchPollMs = envMsOr('DSP_PHONE_SEARCH_POLL_MS', 1500);
    this.settleMs = envMsOr('DSP_PHONE_SETTLE_MS', 500);
    this.shotsDir = path.join(dir, 'shots');
    this.hintsFile = path.join(dir, 'hints.json');
    this.episodesFile = path.join(dir, 'episodes.jsonl');
    this.hints = loadHints(this.hintsFile);
    /**
     * ★ 2026-11-12（P0）：**学到的入口**（`apps.json`）+ 打开 App 的那套兜底。
     *
     * 分工（方案 §4.6，别混）：
     *   · `hints.json`（上面那个）= "**这一屏** + 意图 → 一个动作"；
     *   · `apps.json`（这里）= "**一个 App 名** → 入口 / 包名 / 坐标"。
     * 前者解决"这一屏该点哪"，后者解决"这个 App 从哪儿进"。
     */
    this.openCfg = { ...DEFAULTS.open, ...(openCfg && typeof openCfg === 'object' ? openCfg : {}) };
    this.appStore = openMod.createStore(path.join(dir, 'apps.json'), {
      max: Math.max(0, Math.min(400, Number(this.openCfg.learn && this.openCfg.learn.max) || 80)),
      log,
    });
    this.opener = openMod.createOpener({
      adb: this.adb,
      surface,
      askLocate: (args) => this.askLocate(args),
      store: this.appStore,
      log,
      cfg: this.openCfg,
    });
    this.task = null;
    this.queue = [];
    this.last = { app: '', pkg: '', at: 0 };
    this.seq = 0;
    try { fs.mkdirSync(this.shotsDir, { recursive: true }); } catch { /* 目录建不出来就算了 */ }
  }

  /**
   * ★ 2026-11-07：**换手不换人**。
   *
   * 每一场手机会话 / 他在聊天里让她做一件事之前，`companion.cjs` 取一次只读快照塞进来。
   * 断言不过就**不接**（返回 false，上层这次不乱动），而不是拿旧快照硬演。
   */
  setPersona(snap, { expect = '' } = {}) {
    if (!snap) { this.persona = null; return false; }
    const same = personaMod.checkSame(snap, 'hand');
    if (!same.ok) {
      log.warn(`手机：${same.why} —— 这一场不接（宁可不动，也不换一个人）`);
      return false;
    }
    /**
     * ★ 2026-11-07：**不只是"快照自洽"，还要"跟开场那份是同一个"**。
     * 否则中途改了角色卡 / 她的锚，手会被悄悄换掉，日志里还写着"同一场"。
     */
    if (expect && snap.personaId !== expect) {
      log.warn(`手机：人格跟开场那份对不上（${expect}→${snap.personaId}）—— 这一场不接`);
      return false;
    }
    this.persona = snap;
    return true;
  }

  /** 这一件的小 brief（goal/why/stopCriteria/shareCriteria/src）。 */
  setBrief(brief) {
    this.brief = brief && typeof brief === 'object' ? brief : null;
  }

  /* ------------------------------------------------------------ 打开 App（★ 2026-11-12） */

  /**
   * 打开一个 App —— **别名只是加速，不是前提**。
   *
   * 四种返回语义（`doQuick` / `execute` 都按这个决定"收"还是"交还主循环"）：
   *   · `{ok:true, how:'cache'|'alias'|'home'|'drawer'|'vlm'}` → 真开了；
   *   · `{ok:false, reason:'not-found'}` → **如实说没找到**，不再烧 20 步；
   *   · `{ok:false, reason:'no-label'|'stopped'}` → 不归我管，交还主循环；
   *   · `{ok:false, reason:'adb'|'timeout'}` → 手抖了/没看到屏，也交还主循环（屏幕可能已经变了）。
   *
   * @param {string} name 他/她说的名字（"相册" / "B站" / "打开菜谱看看" / 包名）
   * @param {{task?:object, obs?:object}} [opts]
   */
  async openApp(name, { task = null, obs = null } = {}) {
    if (!this.opener) return { ok: false, reason: 'no-label', label: String(name || ''), tried: [], ms: 0 };
    try {
      return await this.opener.open(name, { task: task || this.task || null, obs });
    } catch (err) {
      log.warn(`手机：openApp 出错（${err.message}）`);
      return { ok: false, reason: 'adb', label: String(name || ''), tried: [err.message], ms: 0 };
    }
  }

  /** 学到的 App（给 `phone-life` 的菜单：她自己想去的时候也要看得见）。 */
  learnedApps() {
    try { return this.appStore ? this.appStore.list() : []; } catch { return []; }
  }

  /**
   * ★ 2026-11-12（P1）：**找不到就截张图问"它在哪"**（只回坐标或 none）。
   *
   * 实测成本 ≈ 470 token / 1~1.5 秒；只有"控件树里没有那个字"才会走到这里
   * （真机上 App 图标的名字本来就在 Launcher 的控件树里）。
   *
   * ⚠️ 三个坑（都是踩过的）：
   *   ① 缩到 360 宽再发（图 token 与宽度无关，上传体积差很多）；
   *   ② `deepseek-flash` 默认会"想"，小 `max_tokens` 时内容为空 → 必须 `thinking:{type:'disabled'}`；
   *   ③ 只认 `xy x y` 或 `none`，**不用 `parseAction`**（那是动作语法，会把坐标当成动词）。
   */
  async askLocate({ shot, label, screen } = {}) {
    if (!shot || !shot.png) return null;
    if (this.visionOK === false) return null;
    const cfg = (this.openCfg && this.openCfg.locate) || {};
    const width = Math.max(200, Math.min(720, Number(cfg.width) || 360));
    let png = shot.png;
    let mime = 'image/png';
    try {
      const mediaMod = require('./companion-media.cjs');
      const small = mediaMod.shrinkImage(shot.png, 'image/png', { maxSide: width, force: true });
      if (small && small.buf) { png = small.buf; mime = small.mime || 'image/png'; }
    } catch { /* 缩不了就发原图（多花一点带宽，不影响对错） */ }
    const scr = screen || {};
    const sys = '你在看一张安卓手机截图，帮人找屏幕上某个图标/文字在哪。'
      + '只回一行：`xy 0.31 0.42`（左上角是 0 0，取中心，两位小数）或者 `none`。不要解释。';
    const user = `这一屏是安卓手机截图（${Number(scr.width) || 720}×${Number(scr.height) || 1280}）。要找的是「${label}」。\n`
      + '如果你真的看见它（文字或图标），只回一行 `xy x y`；如果没有看见，只回 `none`。\n'
      + '不要猜；不要把状态栏、导航栏里的东西当成它。';
    const messages = [
      { role: 'system', content: sys },
      {
        role: 'user',
        content: [
          { type: 'text', text: user },
          { type: 'image_url', image_url: { url: `data:${mime};base64,${Buffer.from(png).toString('base64')}`, detail: 'low' } },
        ],
      },
    ];
    let out;
    try {
      out = await this.callModel(this.model, messages, {
        temperature: 0,
        maxTokens: 24,
        thinking: { type: 'disabled' },
        timeoutMs: Math.max(2000, Number(cfg.timeoutMs) || 8000),
      });
    } catch (err) {
      log.warn(`手机：问坐标没问成（${err.message}）`);
      return null;
    }
    const text = String((out && out.text) || '').trim();
    if (/^none\b/i.test(text) || /没看见|看不到|没有看见/.test(text)) return null;
    const m = /xy\s*[:：]?\s*([\d.]+)[\s,，]+([\d.]+)/i.exec(text);
    if (!m) return null;
    const x = Number(m[1]);
    const y = Number(m[2]);
    /** 坐标校验（防"点空气"）：范围外直接丢，**不要夹到边界**（那会点到状态栏/导航栏）。 */
    if (!(x >= 0.04 && x <= 0.96 && y >= 0.06 && y <= 0.93)) {
      log.warn(`手机：问回来的坐标不在安全区（${x}, ${y}），不点`);
      return null;
    }
    return { x, y };
  }

  /** 记住"她手机现在停在哪一屏"（只存文字摘要，不存图）。 */
  setLastScreen(text, at = Date.now()) {
    const line = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 300);
    if (!line) return;
    this.lastScreen = line;
    this.lastScreenAt = Number(at) || Date.now();
  }

  /**
   * ★ 2026-11-07：从一次观测里更新"当前屏"。同一屏（同 hash）不重复算 digest。
   * 这是回灌 / 问屏 / 下一场计划的**唯一**当前屏来源 —— 不再从聊天流水里捡。
   */
  noteScreen(obs) {
    if (!obs || obs.ok === false) return;
    const h = String(obs.hash || '');
    if (h && h === this.lastScreenHash) return;
    if (h) this.lastScreenHash = h;
    let text = '';
    try { text = surface.digest(obs, { max: 260 }); } catch { /* digest 坏了不该影响任务 */ }
    if (text) this.setLastScreen(text);
  }

  /** 给能力提示 / 状态栏用的轻量状态（**不碰 adb**，都是缓存）。 */
  state() {
    const t = this.task;
    return {
      on: true,
      busy: !!t,
      goal: t ? t.goal : '',
      step: t ? t.step : 0,
      app: this.last.app || '',
      startedAt: t ? t.startedAt : 0,
      queued: this.queue.length,
      /** ★ 2026-11-07：同一个她 / 现在在哪一屏 / 这件事是谁起的。 */
      personaId: (this.persona && this.persona.personaId) || '',
      screen: this.lastScreen || '',
      screenAt: this.lastScreenAt || 0,
      src: (t && t.src) || '',
    };
  }

  /**
   * 收一件事。**立刻返回**，不 await —— 上层发完那句"我去看看"就该结束。
   *
   * ★ 2026-10-31（层 0）：`maxSteps` 旧版**存了但从来没读过**（`runOnce` 只认 `this.budget`），
   * 所以"小目标只给 5 步"这条设计一直是空话。现在 `budget` 里的三项
   * （`maxSteps` / `maxCalls` / `maxMs`）真的落在任务上，`runOnce` 读 `task.lim`。
   *
   * `src`：这件事是谁起的 —— `chat`（他让她做的）/ `roam`（她自己想要的）/ `session`（会话里的一个小目标）。
   * 旧版 episodes 里全是 `by:'her'`，自主和手动混在一起，"一天几次自主"根本没法量。
   * @returns {{id:string, accepted:boolean, why?:string}}
   */
  enqueue({ goal, by = 'her', key = '', share = false, maxSteps = 0, budget = null, src = 'chat', session = '', brief = null, kind = '' } = {}) {
    const g = String(goal || '').trim();
    if (!g) return { id: '', accepted: false, why: '没说要干什么' };
    /**
     * ★ 2026-11-12（P0）：**raw（他的原话）单独给预算**。
     *
     * 普通任务 20 步 / 180 秒；raw 通常是"一句话里好几件"（"回桌面，点开那个蓝色的图标"），
     * 又最容易跑偏 —— 给它 15 步 / 150 秒，跑偏了也能早点收。
     * ⚠️ 只在 `enqueue` 时按件覆盖，**不改全局 `DEFAULTS`**（那会影响她的自主会话）。
     */
    const isRaw = String(kind || '') === 'raw';
    const lim = {
      ...(isRaw ? { maxSteps: 15, maxCalls: 15, maxMs: 150_000 } : {}),
      ...(budget && typeof budget === 'object' ? budget : {}),
      ...(Number(maxSteps) > 0 ? { maxSteps: Number(maxSteps) } : {}),
    };
    /**
     * ★ 2026-11-07：**这一件的小 brief 跟着任务走**（不是全局）。
     * 队列里可能同时有"她要翻相册"和"他让她返回"，两份 brief 不能串。
     */
    const k = String(kind || '') || kindOfGoal(g);
    const base = {
      goal: g, by, key, share: !!share, budget: lim, src, session, brief: brief || this.brief || null,
      /** ★ 2026-11-08：这一句要干什么（`scroll`/`home`/…），队列替换与过期都按它判。 */
      kind: k,
      /** ★ 2026-11-08：什么时候排进来的 —— `drain()` 用它判"过没过期"。 */
      queuedAt: Date.now(),
    };
    /**
     * ★ 2026-11-01：**他说的事排在会话任务前面，而且队列满了也不许拒他**。
     *
     * 以前 `queue.length >= 2` 一律拒 —— 包括"他刚在聊天里让她去看一眼"那一件。
     * 后果很难看：她已经在 QQ 上答应了"我去看看"，任务却被静默拒掉，几分钟内什么都不发生，
     * 用户以为她在装样子。会话任务是她自己想玩的，可以等、可以少做一件；
     * 他的事不行。所以：`src: 'chat'` 插到会话任务前面。
     *
     * ★ 2026-11-08 改了两处（真机 23:34–23:40 那一轮）：
     *   ① **同一件事不再排两遍**：他说两遍「点网页」，以前队列里就有两条，第二条排到 5 分钟后才跑；
     *   ② **chat 也不许无限长**：以前 chat 完全不受 `QUEUE_MAX` 约束，他连说 5 句就排 5 件，
     *      最后执行的是 8 分钟前的话。现在超了就丢最旧的那条（先丢她自己会話里的、再丢他的旧指令）。
     */
    const pri = src === 'chat' ? 1 : 0;
    let replaced = '';
    const sameAt = this.queue.findIndex((q) => q.goal === g);
    if (sameAt >= 0) {
      replaced = this.queue[sameAt].goal;
      this.queue.splice(sameAt, 1);
      log.info(`手机：同一件事又排了一次，换成新的（${g}）`);
    }
    if (this.task) {
      if (this.queue.length >= QUEUE_MAX && !pri && !replaced) {
        return { id: '', accepted: false, why: '手机上还有两件事没做完' };
      }
      /**
       * ★ 2026-11-08：**回桌面 / 返回 不等前面那件跑完**。
       *
       * 真机：23:34:47 的「点网页」排到 23:40:03 才执行，23:35:06 他喊「你怎么又开始划了」——
       * 他骂的是 1 分钟前的旧指令。这类"确定动作"在他嘴里就是"现在，立刻"，
       * 所以直接把手上那件标停（手里的动作做完就收），下一件就是它。
       */
      /**
       * ★ 2026-11-08（用户：「命令还是在打架」）：**他新说的那件事，压过手上正在跑的那件。**
       *
       * 真机 23:06–23:09：23:06:49 手上在跑「试试滑动验证」，他 23:06:52 / 23:07:33 / 23:08:33
       * 连说三次「搜深圳明天的天气」—— 三次都只是**排队**（`kind:'search'` 不在 `URGENT_KINDS` 里），
       * 那件验证码任务又跑了 119 秒；排队的天气指令 90 秒后**过期作废**（`drain()` 里那条规矩），
       * 于是整晚一次都没搜成。
       *
       * 现在：`src:'chat'`（他说的）且和手上那件**不是同一件事**时，同样是"做完这一步就收"，
       * 新那件**放队头**。她自己的会话任务当然也让位。
       * 例外：手上那件**就是他这一句要的同一件事**（`goal` 相同）→ 不打断自己。
       */
      const urgent = URGENT_KINDS.has(k)
        || (pri === 1 && !!this.task && this.task.goal !== g);
      if (urgent && this.task && !this.task.stopped) {
        this.task.stopped = true;
        this.task.preemptedBy = g;
        this.emit({ kind: 'preempt', id: this.task.id, goal: this.task.goal, why: g, at: Date.now() });
        log.info(`手机：「${g}」要插队，手上那件「${this.task.goal}」做完这一步就收`);
      }
      while (this.queue.length >= QUEUE_MAX) {
        const i = this.queue.findIndex((q) => !q.pri);
        const drop = this.queue.splice(i >= 0 ? i : 0, 1)[0];
        log.warn(`手机：队列满了，丢掉旧的「${drop.goal}」`);
        this.dropStale(drop, `等了太久，先不做了（${drop.goal}）`);
      }
      const id = `t${Date.now().toString(36)}${++this.seq}`;
      const item = { id, ...base, pri };
      /**
       * ★ 2026-11-08：插队的那条（回桌面/返回）**直接放队头**，不再"排在已有的 chat 后面"——
       * 他要的是"现在"，不是"等 23:34:47 那条搜完再回桌面"。
       */
      const at = urgent ? 0 : (pri ? this.queue.findIndex((q) => !q.pri) : -1);
      if (at < 0) this.queue.push(item);
      else this.queue.splice(at, 0, item);
      return { id, accepted: true, queued: true, ...(replaced ? { replaced } : {}) };
    }
    const id = `t${Date.now().toString(36)}${++this.seq}`;
    this.run({ id, ...base, startedAt: Date.now() })
      .catch((err) => {
        log.warn(`手机：任务炸了（${err.message}）`);
        /**
         * ★ 2026-11-01：**这条 fail 必须带 `session`**。
         * 会话里的结果事件靠 `res.session === session.id` 认领（`phone-life.onTask`）；
         * 漏了就被当成"别人的结果"丢掉 → `item.ok` 永远是 null → 下一轮 tick 看到
         * `busy=false` 就把**同一件事再排一遍**（实测 5 轮 tick 排了 5 次，
         * `maxCalls` 也因此永远不触发）。
         */
        this.emit({ kind: 'fail', id, goal: g, summary: `出错了：${err.message}`, key, src, session, at: Date.now() });
        this.task = null;
        this.drain();
      });
    return { id, accepted: true };
  }

  /**
   * ★ 2026-11-08：**没做的事也要说一声**。
   *
   * 以前"排不上"只有一句日志（他自己看不见）：她在 QQ 上说"我去看看"，然后三分钟什么都不发生。
   * 这条 `fail` 会走 `phoneFollowUp()`，由她用自己的话如实回一句（用户红线：不规定她说哪句话）。
   */
  dropStale(item, why) {
    if (!item) return;
    this.emit({
      kind: 'fail',
      id: item.id,
      goal: item.goal,
      key: item.key,
      src: item.src,
      session: item.session || '',
      summary: why,
      dropped: true,
      at: Date.now(),
    });
  }

  /** 停下（当前动作做完就停）。 */
  stop() {
    if (this.task) this.task.stopped = true;
    this.queue = [];
  }

  drain() {
    const next = this.queue.shift();
    if (!next) return;
    /**
     * ★ 2026-11-08：**过期的指令不做**。
     * 23:34:47 的「点网页」到 23:40 才跑，那时候她已经在桌面上、他自己都操作完了 ——
     * 执行它只会让手机突然自己动起来（他看到的"你怎么又开始划了"就是这么来的）。
     */
    const waited = Date.now() - (Number(next.queuedAt) || Date.now());
    const base = Number(this.budget && this.budget.maxQueuedMs) || DEFAULTS.maxQueuedMs;
    /**
     * ★ 2026-11-08：**他说的那件事别用同一个"过期"标准**。
     * 90 秒对"她自己的会话小目标"合适；可他一句"搜天气"排了 2 分钟就被作废，
     * 他那边看到的是"说了三遍一次也没搜"（真机 23:06–23:09）。
     * 现在他的事多给一半时间（135 秒）；插队之后基本等不到这么久。
     */
    const maxWait = next.src === 'chat' ? Math.round(base * 1.5) : base;
    if (waited > maxWait) {
      log.warn(`手机：这条排了 ${Math.round(waited / 1000)} 秒，屏幕早变了，作废（${next.goal}）`);
      this.dropStale(next, `这句话是 ${Math.round(waited / 1000)} 秒前说的，屏幕早变了，我就没做`);
      return this.drain();
    }
    next.startedAt = Date.now();
    this.run(next).catch((err) => {
      log.warn(`手机：任务炸了（${err.message}）`);
      /** ★ 2026-11-01：同 `enqueue` 的 catch —— 会话里的任务必须把 `session` 带回去。 */
      this.emit({ kind: 'fail', id: next.id, goal: next.goal, summary: `出错了：${err.message}`, key: next.key, src: next.src, session: next.session, at: Date.now() });
      this.task = null;
      this.drain();
    });
  }

  /* ------------------------------------------------------------ 主循环 */

  /**
   * ★ 2026-10-31（第二轮）：**一句话里有几件事，就拆成几步依次做**。
   *
   * 用户实测（10:47）：「打开浏览器并随便搜点东西」→ 她只打开了浏览器就收工。
   * 根因不是模型笨：`[手机:…]` 里是**一个目标**，`done` 也只核这一个目标，
   * "打开浏览器"做完了，"搜点东西"根本没人接着做。
   * 现在先 `splitGoal()` 拆段，再一段一段跑：每段有自己的步数/模型预算和 `done` 断言，
   * 最后合成一句话回灌（"打开了浏览器；搜到……"）。
   */
  async run(task) {
    this.task = task;
    task.root = task.goal;
    task.steps = task.steps || [];
    task.allSteps = [];
    task.trail = [];
    /** ★ 2026-11-01：看图自救的次数**按任务算**（跨段不清零，用户定的上限 10 次）。 */
    task.rescues = 0;
    /**
     * ★ 2026-11-02：弹窗账**也按任务算**（跨段不清零）。
     * `popupRounds` 一共处理了几次、`popupHits` 每类几次、`popupDead` 哪几类不再硬刚。
     */
    task.popupRounds = 0;
    task.popupHits = {};
    task.popupDead = new Set();
    /**
     * ★ 2026-11-02（C 批）：滚动账。`scanSeen` 是"这几屏我都看过什么"（用来判"到底了/来回滚"），
     * `scrolls` 是滑了几次，`stopNote` 是"我为什么停在这一屏"（下一步 prompt 要用）。
     */
    task.scanSeen = new Set();
    task.scrolls = 0;
    task.stopNote = '';
    task.expectMiss = 0;
    /** ★ 2026-11-07：先想一个 2~3 步的小计划，再一步步入（见 `parsePlan`）。 */
    task.planSteps = [];
    task.planRounds = 0;
    /**
     * ★ 2026-10-31（真机）：**会话里的小目标不许被拆段**。
     *
     * 拆段是为"他一句话里两件事"（`打开浏览器并随便搜点东西`）准备的；
     * 而会话里的每件事本来就是一件 —— `打开相册，往下翻，挑一张说清这张里是什么`
     * 真机上被拆成三段，第二段变成孤零零的"往下翻"：没有可核对的东西、翻不动就判失败，
     * 整件事 50 秒白跑（`最后停在「桌面」`）。
     */
    task.plan = task.src === 'session' ? [] : splitGoal(task.goal);
    /** ★ 层 0：这一趟的预算（`enqueue` 传进来的一小份覆盖全局默认）。 */
    task.lim = { ...this.budget, ...(task.budget || {}) };
    task.doneBounces = 0;
    this.resetPhase(task);
    this.emit({ kind: 'start', id: task.id, goal: task.root, by: task.by, key: task.key, plan: task.plan, at: Date.now() });

    try {
      /**
       * ★ 2026-11-01：**先让她把屏幕醒着**（`stayOn` / `wake` 原来是死代码，从没被调过）。
       *
       * 真机 `screen_off_timeout=60000`、`mStayOn=false` —— 会话里两件小事之间歇 8~25 秒还好，
       * 但 `noteUser()` 让会话挂起之后要安静 90 秒才续跑，**必然熄一次屏**；
       * 而 `perceive()` 默认不截图，看不出黑屏，续跑后每一 `tap` 都点在黑屏上：
       * `changed=false` → 三次 stall → back/home → 判失败，日志里只有"最后停在桌面"。
       * `stayOn(true)` 用完必须还原（别改了他的机器）。
       */
      try { await this.adb.stayOn(true); } catch { /* 有的设备不支持，不影响跑 */ }
      if (task.plan.length <= 1) {
        task.plan = [];
        task.allSteps = task.steps;
        return this.finish(task, await this.runOnce(task));
      }

      const said = [];
      let ok = true;
      for (let i = 0; i < task.plan.length; i++) {
        task.goal = task.plan[i];
        task.phase = i + 1;
        this.resetPhase(task);
        this.emit({ kind: 'plan', id: task.id, step: task.phase, of: task.plan.length, goal: task.goal, at: Date.now() });
        const r = await this.runOnce(task);
        task.allSteps.push(...task.steps);
        said.push(r.summary);
        if (!r.ok) { ok = false; break; }
      }
      return this.finish(task, {
        ok,
        summary: said.join('；'),
        verb: ok ? `一口气做了 ${said.length} 件事` : '',
      });
    } catch (err) {
      return this.finish(task, { ok: false, summary: `出错了：${err.message}` });
    } finally {
      /** 还原"常亮"（跟她把手机放下一个意思）。失败无所谓，别盖住真正的结果。 */
      try { await this.adb.stayOn(false); } catch { /* 同上 */ }
    }
  }

  /** 每一段开始时清一次账：步数/调用/屏计数各自独立（`trail` 留着，治"我怎么又在这"）。 */
  resetPhase(task) {
    task.steps = [];
    task.tried = [];
    task.calls = 0;
    task.step = 0;
    task.intent = intentOf(task.goal);
    task.seen = {};
    task.rep = 0;
    task.repSig = '';
    /** ★ 层 0：`done` 被打回了几次（每段独立，最多 2 次）。 */
    task.doneBounces = 0;
    /** ★ 2026-11-07：每段重新想计划，别把上一段的动作带到下一段。 */
    task.planSteps = [];
    task.planRounds = 0;
    /**
     * ★ 2026-11-08：**"刚给的下一步提示"和"这一趟存了哪几张"是按段算的**。
     * 不清的话，"刚搜完，下一步 open 1"会一直重复出现在后面每一段里。
     * ⚠️ `resultItems` / `openedUrl` **故意不清**：
     *    多段目标（"打开浏览器，搜X，点开第一条"）里，第二段要靠第一段取回来的网址；
     *    而它们在用之前都会跟**这一屏**核对（`sameResult()`），过期了也不会开错网站。
     */
    task.hintNext = '';
    task.savedImages = new Set();
    /**
     * ★ 2026-11-01（P0-3）：退路阶梯的计数**按段重置**。
     * 每段都值得再给一次"退两步 + 重开 App"（`key home` 只留作最后那手）。
     */
    task.backTries = 0;
    task.wentLaunch = false;
    task.wentHome = false;
  }

  /** 跑**一段**目标。返回 `{ok, summary, ...}`；收尾（发事件、记 episodes、排下一件）由 `run()` 统一做。 */
  async runOnce(task) {
    const quick = quickSkill(task.goal);
    if (quick) {
      const r = await this.doQuick(quick, task);
      if (r) return r;
    }

    let obs = await this.perceive(task);
    if (!obs.ok) return { ok: false, summary: `手机连不上：${obs.error || '不知道原因'}` };
    this.noteApp(task, obs);

    let stall = 0;
    const lim = task.lim || this.budget;
    /**
     * ★ 2026-11-02：`for` → `while`，**唯一的目的是让"关弹窗"不占步数**。
     *
     * 关掉一个插屏本来就是"把挡路的东西挪开"，不该花掉 1/12 的步数预算。
     * 其余语义（步数、时间、卡住计数、同动作重复）一个字没变。
     */
    let step = 0;
    while (step < lim.maxSteps) {
      if (task.stopped) return { ok: false, stopped: true, summary: '停了' };
      /**
       * ★ 2026-11-12：**"这个 App 根本不在手机上"要立刻收。**
       *
       * `openApp` 四路都找过（缓存/别名/看屏点字/截图问坐标）还是 `not-found` 时，
       * 进 `recover()` 的 `back ×2 → 重开 → 回桌面` 一点意义都没有 —— 只会把 20 步烧完，
       * 最后回她一句"时间到了"。这里如实说"没找到"，一步都不多走。
       */
      if (task.fatalOpen) {
        return this.wrapSummary(task, obs, `打不开「${task.fatalOpen.label}」：手机上没找到它`, { exploreOk: false, stuck: 'open' });
      }
      if (Date.now() - task.startedAt > lim.maxMs) {
        return this.wrapSummary(task, obs, '时间到了', { stuck: 'budget' });
      }

      // 0) 弹窗 / 广告：先清路（0 token、不占步数；到上限就不管了，交给模型）
      const pop = await this.popups(task, obs);
      if (pop && pop.obs) {
        obs = pop.obs;
        this.noteApp(task, obs);
        continue;
      }

      /**
       * ★ 2026-11-08（真机 23:05–23:11，用户原话「被前面的滑动验证注意力吸引」）：
       * **验证墙不能交给模型硬磨**。
       *
       * 一整屏就一个滑块的时候，模型只会一次一次 `drag`（它连轨道在哪都不知道），
       * 20 步 / 149 秒就这么烧掉了，而他还在外面连喊三次"搜天气"。
       * 现在：第一次 → 按形状找轨道拖到底（`slideCaptcha`）；第二次 → `restart` 冷启动浏览器；
       * 还不行就**认输并说清楚**（不许再有第三次），把步数留给别的事。
       */
      const cap = captchaOf(obs);
      if (cap) {
        task.captchaRounds = (Number(task.captchaRounds) || 0) + 1;
        if (task.captchaRounds === 1) {
          await sleep(300);
          const did = await slideCaptcha(this.adb, obs, obs.screen);
          task.tried.push(`（这一屏是「${cap}」，${did || '没找到滑块'}）`);
          const o = await this.perceiveQuiet();
          if (o && o.ok && !captchaOf(o)) {
            obs = o;
            this.noteApp(task, obs);
            continue;
          }
        }
        if (task.captchaRounds === 2) {
          const app = obs.app?.name || '浏览器';
          log.info(`手机：验证墙过不去，重启「${app}」`);
          const r = await this.execute({ verb: 'restart', arg: app, line: `restart ${app}` }, obs, task);
          if (r && r.obs) {
            obs = r.obs;
            this.noteApp(task, obs);
            if (!captchaOf(obs)) continue;
          }
        }
        return this.wrapSummary(task, obs, `这一屏是人机验证（${cap}），拖不过去`, { stuck: 'wall' });
      }

      step += 1;
      task.step = step;

      // 同屏打转（回来第 3 次）—— 别等它把预算耗完
      const seen = (task.seen[obs.hash] || 0) + 1;
      task.seen[obs.hash] = seen;

      // 1) 屏级记忆：这个目标 + 这一屏 以前点成过什么（0 token）
      const key = hintKey(obs.app?.package, obs.hash, task.intent);
      const memo = this.hints[key];
      let action = this.replayable(memo, obs) ? parseAction(memo.act) : null;
      const fromHint = !!action;
      let fromPlan = false;

      /**
       * ★ 2026-11-07：**先执行上一条计划里剩下的步骤**（不花模型调用）。
       * 计划绑定的是"一次想清楚"的连续动作；某一步没动就整段作废（见下面 `changed === false`）。
       */
      if (!action && Array.isArray(task.planSteps) && task.planSteps.length) {
        const line = task.planSteps.shift();
        action = parseAction(line);
        if (action) fromPlan = true;
      }

      // 2) 没记忆才问模型
      if (!action) {
        if (task.calls >= lim.maxCalls) {
          return this.wrapSummary(task, obs, '问不动了', { stuck: 'model' });
        }
        let out;
        try {
          /**
           * ★ 2026-11-02（C）：`【刚停下来】` 只说**一次** —— 说完就清掉，
           * 不然她每步都以为"我刚停下来"，反而不敢动。
           */
          const planMode = (Number(task.planRounds) || 0) < 5;
          const msgs = this.buildMessages(task, obs, { plan: planMode });
          task.stopNote = '';
          out = await this.callModel(this.model, msgs, {
            temperature: 0.3, maxTokens: planMode ? 300 : 220, thinking: { type: 'disabled' },
          });
        } catch (err) {
          // 模型不认图：关掉视觉，退回纯文本再问一次（不让整轮因为一张图挂掉）
          if (obs.shot && /image|vision|multimodal|400|unsupported|不支持|content/i.test(err.message)) {
            this.visionOK = false;
            log.warn(`手机：这个模型看不了图（${err.message.slice(0, 60)}…），后面只用动作表`);
            obs = { ...obs, shot: null };
            continue;
          }
          /**
           * ★ 2026-11-01：**一次抖动不该把整件事作废**。
           * 真机（16:45）撞到过 `操作员连不上模型：陪伴模型返回的不是 JSON` ——
           * 她其实已经打开了搜索框、字也打进去了，整条任务却直接判失败。
           * 现在同一屏再问一次；第二次还不行才认输。
           */
          if (!task.modelRetried) {
            task.modelRetried = true;
            log.warn(`手机：模型这一下没答上来（${err.message.slice(0, 80)}），同一屏再问一次`);
            await sleep(600);
            obs = await this.perceive(task);
            continue;
          }
          return { ok: false, summary: `操作员连不上模型：${err.message}` };
        }
        task.calls++;
        const plan = parsePlan(out && out.text);
        if (plan.length > 1) {
          task.planRounds = (Number(task.planRounds) || 0) + 1;
          action = parseAction(plan[0]);
          task.planSteps = plan.slice(1);
          fromPlan = true;
          log.info(`手机：想好下一步（${plan.join(' → ')}）`);
        } else {
          action = parseAction(out && out.text);
        }
        if (!action) {
          task.tried.push('（没看懂自己写的）');
          obs = await this.perceive(task);
          continue;
        }
      }

      // 2.5) 同一个动作连着第 N 遍、而且屏幕**一直在动**：别再耗预算
      //      （10-31 实测：一口气 swipe up 八次、tapxy 同一个坐标点三次 —— 屏在变，目标一点没往前）
      //      只在 `stall === 0` 时才这么停：点不动的情况交给下面的 back/home 退路。
      //      swipe 放得宽一点：滚一屏本来就得连着划好几下。
      const sig = action.line.toLowerCase().replace(/\s+/g, ' ');
      task.rep = task.repSig === sig ? (task.rep || 0) + 1 : 1;
      task.repSig = sig;
      const repLimit = action.verb === 'swipe' ? 6 : 3;
      if (task.rep >= repLimit && stall === 0) {
        return this.wrapSummary(task, obs, `同一个动作连着做了 ${repLimit} 遍`, { exploreOk: false, stuck: 'loop' });
      }

      // 3) 做 + 验
      this.emit({ kind: 'step', id: task.id, step, action: action.line, app: obs.app?.name || '', from: fromHint ? 'hint' : (fromPlan ? 'plan' : 'model'), vision: obs.vision || '', at: Date.now() });
      const t1 = Date.now();
      const r = await this.execute(action, obs, task);
      if (r.finish) return r.finish;
      /**
       * ★ 层 0：`done` 被打回。屏幕没变，不用重新观测（省 2.3 秒），
       * 理由已经在 `task.tried` 里，下一轮 prompt 她看得到。
       */
      if (r.bounced) continue;
      /**
       * ★ 2026-11-07：**翻到想看的了，后面的计划先作废。**
       * 真机：计划写的是「scroll down 3 → scroll down 3 → done」，第一下就停在有"狗"的一屏，
       * 可它按计划又滑了两次，最后被"同一个动作连着做 3 遍"判死 —— 明明已经找到了。
       */
      if (r.found && Array.isArray(task.planSteps) && task.planSteps.length) {
        task.planSteps = [];
        task.tried.push('（已经翻到想看的了，后面的滚动计划先不做）');
      }
      // ★ 截图类目标：截到就收工，图会跟着她下一句话发过去（别截完再去乱点）
      if (r.doneShot) {
        task.steps.push({ step, action: action.line, changed: null, ms: Date.now() - t1 });
        return { ok: true, summary: `截了一张，手机停在「${obs.app?.name || '桌面'}」`, verb: '截了张图' };
      }
      task.steps.push({ step, action: action.line, changed: r.changed, ms: Date.now() - t1 });
      /** ★ 2026-11-07：把"这一下真实发生了什么"留到下一步 prompt（`【刚才那一下】`）。 */
      if (r.effect) task.lastEffect = r.effect;
      else if (r.changed === false) task.lastEffect = `${action.line}：屏幕纹丝没动（没点中 / 滑不动 / 被挡住了），别原样再来一遍`;

      task.tried.push(`${action.line}→${r.note || (r.changed === false ? '没变（可能没点中）' : (r.changed ? '画面变了' : '做了'))}`);
      if (task.tried.length > 6) task.tried = task.tried.slice(-6);
      /**
       * ★ 2026-11-07：计划里这一步**没让屏幕动** → 整段计划作废，下一步重新想。
       * 不然它会按一条已经错了的计划继续往下点（真机 20 步里有 18 步就是这么来的）。
       * `read` / `find` / `waitfor` 本来就不动屏，不算失败。
       */
      if (r.changed === false && !r.noStall && Array.isArray(task.planSteps) && task.planSteps.length) {
        task.planSteps = [];
        task.tried.push('（这一步没让屏幕动，后面的计划不作数了，重新想）');
      }

      /**
       * ★ 2026-11-02：**屏没变就不要再 dump 一次**（同一棵树，看两遍 = 白等 2.3 秒）；
       * 变了就用 `waitChange()` 顺手带回来的那棵树（见 `perceiveFrom`）；
       * 只有"换 App / 没带树"才完整 observe 一次。
       */
      const reuseTree = {
        nodes: obs.nodes, more: obs.more, count: obs.count, thin: obs.thin,
        hash: obs.hash, table: obs.table, screen: obs.screen,
      };
      const next = r.changed === false
        ? await this.perceiveFrom(reuseTree, obs, task)
        : (r.obs ? r.obs : (r.tree ? await this.perceiveFrom(r.tree, obs, task) : await this.perceive(task)));
      /**
       * ★ 2026-11-07：滚动/点击返回的 `r.obs` 可能没有图 —— 在这里统一补一张，
       * 保证"每一步都看得见这一屏"不是只对第一步成立。
       */
      const aftermath = await this.withVision(next, task);
      const moved = this.judge(obs, aftermath, task, r.changed, action);

      // 记忆的读写都挂在这一个判断上：**只有"目标真的近了"才值得记**。
      if (fromHint) {
        if (moved) memo.succ = Math.min(9, (memo.succ || 0) + 1);
        else this.forget(key, '重放了但没进展');
        this.saveHintsSoon();
      } else if (moved && this.strongProgress && r.changed !== false) {
        /**
         * ★ 2026-11-01（P0-7）：**只记"目标近了"的动作**。
         * 以前"屏变了"就能记一条，B 站上一滑一换页，于是记下一堆假招；
         * 下次回到同一屏会**优先重放**它（`replayable`），把她钉在错动作上。
         */
        this.remember(key, action.line, task, obs);
      }
      if (this.isTrapped(aftermath)) this.blacklist(obs.app?.package, obs.hash, task.intent, action.line);

      stall = (moved || r.noStall) ? 0 : stall + 1;

      // 4) 卡住：**先让她自己看图判断**（第一优先级），不行才走固定退路
      if (stall >= lim.maxStall) {
        const saved = await this.rescue(task, obs);
        if (saved && saved.ok) {
          obs = saved.obs;
          this.noteApp(task, obs);
          task.backTries = 0;
          task.wentLaunch = false;
          task.wentHome = false;
          stall = 0;
          continue;
        }
        const rec = await this.recover(task, obs, stall);
        if (rec === 'giveup') return this.wrapSummary(task, obs, '连着几步都没反应，退回/重开都不行', { exploreOk: false, stuck: task.wall ? 'wall' : 'stuck' });
        if (rec) {
          obs = await this.perceive(task);
          this.noteApp(task, obs);
          stall = 1;
          continue;
        }
      }

      obs = aftermath;
      this.noteApp(task, obs);
    }
    return this.wrapSummary(task, obs, `${lim.maxSteps} 步用完了`, { stuck: 'budget' });
  }

  /* ------------------------------------------------------------ 感知 */

  /**
   * ★ 2026-10-31：**看一眼，但按需要才付费**。
   *
   * 默认只拿动作表（2.3 s、~330 token）。只有这四种情况才多截一张图（+1.1 s）：
   *   · 控件树几乎空的（相机 / Flutter / 游戏 / 自绘）——这时候表里只有几个匿名控件；
   *   · 上一步点了没动静（可能被弹窗挡住）；
   *   · 目标本身要"看"（图、照片、视频、界面长什么样）；
   *   · 刚换了一个 App（先认一下这是哪儿）。
   */
  async perceive(task) {
    let obs;
    try {
      obs = await this.adb.observe({ shot: false });
    } catch (err) {
      return { ok: false, error: err.message };
    }
    if (!obs || !obs.ok) return obs || { ok: false, error: '看不到屏幕' };
    this.lastChanged = obs.hash !== this.lastHash;
    return this.withVision(obs, task);
  }

  /**
   * ★ 2026-11-07：**给这一屏补一张图**（`vision.always` 的落点）。
   *
   * 以前截图只发生在 `perceive()` 里；而滚动/弹窗/动作返回的是"顺手捡来的树"，
   * 那条路不会截图 —— 于是"每一屏都看图"实际上只在第一步成立。
   * 现在统一从这里补，调用方不用记。
   */
  async withVision(obs, task) {
    if (!obs || obs.ok === false) return obs;
    // ★ 2026-11-07：先把"当前屏"记下来（不管这一屏要不要发图）。
    this.noteScreen(obs);
    const want = this.wantVision(task, obs);
    if (!want || !this.vision.enabled || this.visionOK === false) return obs;
    try {
      const s = await this.adb.screenshot({});
      if (s && s.ok) {
        const out = { ...obs, shot: { png: s.png, bytes: s.bytes, hash: s.hash, ms: s.ms }, vision: want };
        this.markVision(out);
        return out;
      }
    } catch { /* 截图失败就当没看见，别把任务搅黄 */ }
    return obs;
  }

  /**
   * ★ 2026-11-02：**把 `waitChange()` 顺手 dump 到的那棵树，当成下一步的观测**。
   *
   * 只补一样东西：`app`（哪一屏、哪个 Activity）。`state()` 里那 5 个 adb 查询是并行发的，
   * 约 0.3~0.5 秒；而省掉的是一次完整的 `uiXml()`（约 2.3 秒）。
   * 换 App 的那一次（`via: 'app'`）不走这里 —— 那一刻的树不属于新 App。
   *
   * @param {object} tree   `waitChange()` 回的那棵树
   * @param {object} prev   上一屏的观测（问不到 `state()` 时兜底用它的 app/screen）
   * @param {object} [task] 给了就按 `wantVision()` 的规矩补一张截图（**和完整 observe 一模一样**，
   *                        只是省掉了那次 uiXml）
   */
  async perceiveFrom(tree, prev, task = null) {
    let st = null;
    try { st = await this.adb.state(); } catch { /* 问不到就用上一屏的 */ }
    const nodes = Array.isArray(tree?.nodes) ? tree.nodes : [];
    const table = String(tree?.table || '');
    let out = {
      ok: true,
      app: (st && st.app) || (prev && prev.app) || {},
      screen: tree?.screen || (st && st.screen) || (prev && prev.screen),
      nodes,
      count: Number.isFinite(tree?.count) ? tree.count : nodes.length,
      more: Number(tree?.more) || 0,
      thin: !!tree?.thin,
      hash: tree?.hash,
      table,
      chars: table.length,
      /** 这一份是"顺手捡来的"，不是完整 observe —— 排查时有用。 */
      reused: true,
      ms: { state: 0, dump: 0, total: 0 },
    };
    this.lastChanged = out.hash !== this.lastHash;
    /**
     * ⚠️ 图不能省：`VISION_APPS`（B 站/相册）**每一步都要看画面**，省掉这次 dump 只是为了
     * 不再重复 dump，不是为了少发图。所以这里走和 `perceive()` 同一套 `withVision()`。
     */
    if (task) return this.withVision(out, task);
    return out;
  }

  /**
   * ★ 2026-11-02：**弹窗 / 广告**。每步在问模型之前跑一次。
   *
   * 认字的活全在 `phone-popup.cjs`（纯函数、0 token、0 延迟）；
   * 这里只负责：点 → 等 → 再看一眼 → 没关掉就退一步 → 还不行就不管它了。
   *
   * 记账在任务上（跨段累计）：
   *   · `task.popupRounds` 一共处理了几次（到 `max` 就不管了）；
   *   · `task.popupHits[id]` 同一类出现几次（到 `maxSame` 判定"广告墙"，这一类不再硬刚）。
   *
   * @returns {Promise<{obs:object, id:string, action:string}|null>} 处理了才返回（调用方 `continue`，**不占步数**）
   */
  async popups(task, obs) {
    const c = this.popupCfg;
    if (!c.enabled || !c.max || !obs || obs.ok === false) return null;
    if ((Number(task.popupRounds) || 0) >= c.max) return null;

    const hit = popup.scan(obs, { screen: obs.screen });
    if (!hit) return null;
    if (task.popupDead && task.popupDead.has(hit.id)) return null;

    task.popupHits = task.popupHits || {};
    task.popupHits[hit.id] = (Number(task.popupHits[hit.id]) || 0) + 1;
    if (task.popupHits[hit.id] > c.maxSame) {
      task.popupDead = task.popupDead || new Set();
      task.popupDead.add(hit.id);
      task.wall = hit.id;
      this.emit({ kind: 'wall', id: task.id, popup: hit.id, label: hit.label, at: Date.now() });
      log.warn(`手机：这一屏一直弹「${hit.label}」（第 ${task.popupHits[hit.id]} 次），不再硬刚`);
      return null;
    }

    const before = obs.hash;
    const scr = obs.screen;
    const pkg = obs.app?.package || '';
    const center = hit.node.center || [(hit.node.bounds || [0, 0, 0, 0])[0], (hit.node.bounds || [0, 0, 0, 0])[1]];
    let next = null;
    try {
      await this.adb.tapXY(center[0], center[1]);
      if (c.settleMs > 0) await sleep(c.settleMs);
      const w = await this.adb.waitChange(before, { timeout: 1.2, screen: scr, app: pkg });
      next = w && w.tree ? await this.perceiveFrom(w.tree, obs, task) : await this.perceive(task);
      if (!popup.scan(next, { screen: next?.screen || scr })) {
        return this.notePopupDone(task, hit, `点掉「${hit.text}」`, next);
      }
      /** 点不掉：退一步（很多插屏是按 back 关的），再验一次。 */
      await this.adb.key('back');
      if (c.settleMs > 0) await sleep(c.settleMs);
      const w2 = await this.adb.waitChange(next.hash || before, { timeout: 1.2, screen: scr, app: pkg });
      next = w2 && w2.tree ? await this.perceiveFrom(w2.tree, next, task) : await this.perceive(task);
      if (!popup.scan(next, { screen: next?.screen || scr })) {
        return this.notePopupDone(task, hit, `按 back 关掉「${hit.label}」`, next);
      }
    } catch (err) {
      log.warn(`手机：弹窗没关成（${err.message.slice(0, 60)}）`);
    }
    task.popupRounds = (Number(task.popupRounds) || 0) + 1;
    log.warn(`手机：关不掉「${hit.label}」（${hit.text}），交给模型`);
    return null;
  }

  /** 关掉一个弹窗：记账 + 发事件，返回新的观测给主循环。 */
  notePopupDone(task, hit, action, obs) {
    task.popupRounds = (Number(task.popupRounds) || 0) + 1;
    this.emit({
      kind: 'popup', id: task.id, popup: hit.id, label: hit.label, action, at: Date.now(),
    });
    log.info(`手机：自己关掉一个${hit.label}（${action}）`);
    return { obs, id: hit.id, action };
  }

  /** 这一屏要不要图？返回 'low' / 'high' / false。 */
  wantVision(task, obs) {
    if (!this.vision.enabled || this.visionOK === false) return false;
    /**
     * ★ 2026-11-07：`always` 模式下**每一屏都发一张**（同一屏不重复发）。
     * 用户的判断很直接：「只要不是特别离谱」；而实测一屏 228 token、1 秒左右，
     * 比她"看不见图只好猜"便宜得多。
     */
    if (this.vision.always) {
      const key = `${obs.app?.package || ''}|${obs.hash || ''}`;
      if (this.visionSeen.has(key)) return false;
      /** 树太空（相册网格 / 游戏 / 自绘）时用高清，让画面里的东西真的看得清。 */
      return (obs.thin || (Number(obs.count) || 0) <= 3) ? 'high' : 'low';
    }
    if (VISION_APPS.test(obs.app?.package || '')) return 'low';          // 内容在图里：每步都看
    if (obs.thin || (Number(obs.count) || 0) <= 3) return 'high';        // 树太空：得看真画面
    if (this.lastChanged === false) return 'low';                        // 上一步没动静：可能被挡住
    const pkg = obs.app?.package || '';
    if (pkg && this.last.pkg && pkg !== this.last.pkg) return 'low';     // 刚换 App：认一下
    // 目标本身要"看"：**同一屏只发一次**。每步都发图既慢（+1.2 s）又没必要。
    if (VISION_GOAL.test(task.goal) && !this.visionSeen.has(`${pkg}|${obs.hash}`)) return 'low';
    return false;
  }

  /** 这一屏的图发过了吗（发过就不再发，省 1.2 秒/步）。 */
  markVision(obs) {
    const k = `${obs.app?.package || ''}|${obs.hash || ''}`;
    this.visionSeen.add(k);
    if (this.visionSeen.size > 60) this.visionSeen.clear();
  }

  /** 记下 App 轨迹（塞进 prompt，治"我怎么又在这"）。 */
  noteApp(task, obs) {
    const name = obs.app?.name || obs.app?.package || '';
    if (!name) return;
    if (task.trail[task.trail.length - 1] !== name) task.trail.push(name);
    if (task.trail.length > 4) task.trail = task.trail.slice(-4);
    this.last = { app: name, pkg: obs.app?.package || '', at: Date.now() };
    this.lastHash = obs.hash;
  }

  /**
   * 做了这一步，算不算"有进展"？
   *
   * ★ 2026-11-01（P0-5）：**"屏变了"不等于"有进展"**。
   *
   * 旧版最后还有一条 `节点数差 >= 2 就算有进展` —— 在 B 站/浏览器这种一滑就换内容的界面上，
   * 它让"连划六屏、目标一点没近"每一步都算前进：于是**永远不触发退路**，一路烧到预算
   * （真机 15:11「下滑一点看看」连划 6 次 84 秒；统计里"同一个动作连着做"×3、"时间到了"×3）。
   *
   * 现在分两档：
   *   · `this.strongProgress` —— **目标真的近了**（换 App / 目标词出现在这一屏）；
   *     只有这一档才值得写进 `hints.json`（防止"假招被记成真招"，P0-7）。
   *   · 返回值 —— 这一步**算不算前进**（决定要不要 +1 卡住计数）。
   *     探索型目标（逛逛/翻翻/滑动/搜索）允许"屏真的换了"算前进；其余一律要求目标词出现。
   */
  judge(before, after, task, changed, action = null) {
    this.strongProgress = false;
    if (!after || !after.ok) return false;
    /**
     * ★ 2026-11-02（D 批）：**动作带了「预期」就核对一下**（0 成本的反思）。
     * `expectMet()` 只对"能核对的说法"给结论（页/界面/列表/相册…），
     * 像「换下一条」这种核对不了的，返回 `null` —— 不夸奖也不冤枉。
     */
    const exp = action && action.expect ? String(action.expect) : '';
    const met = exp ? this.expectMet(exp, after) : null;
    if (changed === false) {
      if (met === false) this.noteExpectMiss(task, exp, after);
      return false;
    }
    /**
     * ★ 2026-10-31 真机实测加的这一条：**回到走过的屏 = 没进展**。
     * 没有它，图库里点 n0 弹相册列表、再点 n4 回来，两边表里都有"相册"两个字，
     * 于是每一步都被判成"有进展"，记忆就会把这条 2 步循环越学越牢（实测就是 n0/n4 打了 4 个来回）。
     */
    if (task.seen && task.seen[after.hash] > 0) return false;
    const pkgA = before.app?.package || '';
    const pkgB = after.app?.package || '';
    /** ★ 2026-11-02：系统弹窗（权限框/安装器/通知栏）弹出来不算"换 App = 有进展"。 */
    if (SYSTEM_PKG.test(pkgA) || SYSTEM_PKG.test(pkgB)) return false;
    /**
     * ★ 2026-11-02（真机 21:25）：**在两页之间来回跳不算进展**。
     *
     * 现场：目标「退出去换一个视频看」，她的动作是 `key back → tap n1 → key back → tap n1 …`
     * 五次，同一个视频点进去又退出来。而 B 站的动作表里**到处都有"视频"两个字**
     * （卡片 desc 就是 `视频,标题,…`），`goalNouns` 于是每一步都判"目标近了" ——
     * 永远不算卡住，一路烧完 12 步。
     *
     * 判据：最近 6 次所在的页面正好是 `A,B,A,B,A,B`（同一个 App 里的两层）。
     * 只提醒一次；之后每判一次都是"没进展"，两次就会触发自救/退路。
     */
    const place = `${pkgB}/${after.app?.activity || ''}`;
    task.placeSeq = (task.placeSeq || []).concat([place]).slice(-6);
    const q = task.placeSeq;
    if (q.length === 6 && q[0] === q[2] && q[2] === q[4] && q[1] === q[3] && q[3] === q[5] && q[0] !== q[1]) {
      if (!task.cycleAt) {
        task.cycleAt = Date.now();
        task.tried.push('（我在两页之间来回跳了好几次，换个走法）');
        if (task.tried.length > 6) task.tried = task.tried.slice(-6);
      }
      return false;
    }
    if (met === true) {                                                 // 她预判对了
      this.strongProgress = true;
      return true;
    }
    if (pkgA && pkgB && pkgA !== pkgB) {                                // 换 App：确实动了
      this.strongProgress = true;
      if (met === false) this.noteExpectMiss(task, exp, after);
      return true;
    }
    const nouns = goalNouns(task.goal);
    const onHome = LAUNCHER_PKG.test(after.app?.package || '');
    const blob = `${after.app?.name || ''} ${after.app?.package || ''} ${after.table || ''}`;
    if (nouns.length && screenHasGoal(blob, nouns, { onHome })) {        // 目标的东西出现了
      this.strongProgress = true;
      return true;
    }
    if (met === false) this.noteExpectMiss(task, exp, after);
    /**
     * ★ 2026-11-02（C 批）：`scroll` / `scrollto` 是"在找"，屏换了就算在往前走
     * （否则连翻两屏就被判卡住、触发退路 —— 那正是 11-01 "连划 6 屏"的另一面）。
     * 但它**永远不算 `strongProgress`**：滑动本身不是目标，不该写进记忆。
     */
    if (action && /^scroll/.test(String(action.verb))) return true;
    /**
     * ★ 2026-11-07：**"点了一下、屏闪了一下"不算前进。**
     *
     * 真机 20:37：搜索完成后她连点了十几个不同的 n，每一次都只是焦点/高亮变了一下，
     * `changed:true` 于是每一步都被判"有进展"，一路点到 20 步预算耗尽。
     * 现在点击类动作要么目标真的近了（上面几档），要么**这一屏的内容大换血**
     * （打开了一条结果/进了一个新页面），否则一律算"没进展"。
     */
    const verb = String(action && action.verb || '');
    if (/^(tap|tapn|taptext|tapxy|longpress|doubletap|key|launch|openurl)$/.test(verb)) {
      const fresh = scroll.newTexts(after, new Set(), before);
      const actA = String(before.app?.activity || '');
      const actB = String(after.app?.activity || '');
      if (actA && actB && actA !== actB) return true;
      const sameTable = String(before.table || '') === String(after.table || '');
      if (!sameTable && (fresh.count >= 2 || (fresh.count >= 1 && fresh.ratio <= 0.35))) return true;
      return false;
    }
    /**
     * 目标词还没出现：只有"探索/翻找"这类**本来就该一屏一屏看**的目标，
     * 才把"屏真的换了"算前进；其余（例如"点搜索框""输入小肥鱼"）不算。
     */
    if (action && /^swipe$/.test(verb)) {
      return task.intent === 'explore' || scroll.isLooking(task.goal);
    }
    if (task.intent === 'explore' || /滑|翻|逛逛|看看|浏览|搜/.test(String(task.goal))) return true;
    return false;
  }

  /**
   * 她说的"预期"对上了吗？
   * @returns {boolean|null} `null` = 这句话核对不了（不夸奖、也不扣分）
   */
  expectMet(exp, after) {
    if (!EXPECT_CHECKABLE.test(String(exp || ''))) return null;
    /**
     * 判据里带上 **`whereAmI()` 翻译出来的那一句**（"哔哩哔哩·视频页"）——
     * 光看包名/Activity 的话，`UnitedBizDetailsActivity` 里根本没有"视频页"三个字，
     * 她明明到了也会被打成"没到"。
     */
    const where = whereAmI(after).at || '';
    const hay = `${where} ${after?.app?.name || ''} ${after?.app?.package || ''} ${after?.app?.activity || ''} ${after?.table || ''}`;
    const tokens = String(exp || '')
      .replace(/[的了吗呢吧啊]/g, '')
      .split(/[\s，,、。;；:：]+/)
      .filter((t) => t.length >= 2);
    if (!tokens.length) return null;
    return tokens.some((t) => hay.includes(t));
  }

  /** 记一笔"她以为会到的没到"（进下一轮 prompt；连着三次会提醒她换入口）。 */
  noteExpectMiss(task, exp, after) {
    if (!task) return;
    task.expectMiss = (Number(task.expectMiss) || 0) + 1;
    const where = after?.app?.name || '别的页面';
    task.tried.push(`（我以为会「${exp}」，实际停在「${where}」）`);
    if (task.expectMiss >= 3) task.tried.push('（连着三次都没到我以为的地方，换个入口，别在同一个地方试）');
    if (task.tried.length > 6) task.tried = task.tried.slice(-6);
  }

  /** 这一屏是不是"陷阱"（进去就出不来、还一直有动静的那种）。 */
  isTrapped(obs) {
    const pkg = String(obs?.app?.package || '');
    return pkg === 'com.android.camera2';
  }

  /**
   * ★ 2026-10-31：预算用完时的收尾 —— **说清"最后停在哪"，而不是一句"想不出下一步了"**。
   *
   * 旧版撞预算就直接判失败、summary 是"想不出下一步了（这一屏我拿不准）"，
   * 于是她自己也不知道自己做到哪了，回灌到 QQ 就只能编（10-31 上午编了三次"弄完了"）。
   *
   * 探索型目标（随便看看/逛逛）本来就没有成功判据：走够了（预算用完）就算成。
   * 但**卡死/原地打转**不算 —— 那种情况 `exploreOk: false` 传进来，照样判失败，
   * 否则就会出现"summary 写着连着几步都没反应、ok 却是 true"的假成功（真机撞到过）。
   */
  wrapSummary(task, obs, why = '', { exploreOk = true, stuck = '' } = {}) {
    const app = obs?.app?.name || '桌面';
    const trail = (task.trail || []).slice(-3).join(' → ');
    const where = trail ? `最后停在「${app}」（走过：${trail}）` : `最后停在「${app}」`;
    /** ★ 2026-11-02：被弹窗/广告挡住是**如实说**的一部分（不然她只会说"没做到"）。 */
    const wall = task.wall ? `，一直被${popup.labelOf(task.wall)}挡着` : '';
    const tail = `${why ? `，${why}` : ''}${wall}`;
    /**
     * ★ 2026-11-02（D 批）：**卡住的原因要分得开**（诊断文档里的 P1-10 一直没做）。
     * 有了这一格，过一周就能回答"她到底是被广告卡、被预算卡、还是在原地打转"。
     */
    task.stuck = stuck || task.stuck || (task.wall ? 'wall' : '');
    if (exploreOk && EXPLORE_GOAL.test(task.goal)) {
      return { ok: true, summary: `随便逛了一阵，${where}${tail}`, verb: '逛了逛手机' };
    }
    return { ok: false, summary: `没做到「${task.goal}」，${where}${tail}` };
  }

  /* ------------------------------------------------------------ 记忆 */

  /** 这条记忆现在能不能拿来用？ */
  replayable(memo, obs) {
    if (!memo || memo.avoid || !memo.act) return false;
    if ((memo.succ || 0) < 2 || (memo.fail || 0) > 0) return false;    // 得成过两次、且没翻过车
    const act = parseAction(memo.act);
    if (!act) return false;
    // 重放前先验一下：ref 还在不在、能不能点（旧 ref 漂移是经典坑）
    if (act.verb === 'tap') {
      const node = (obs.nodes || []).find((n) => n.ref === act.arg);
      if (!node || node.enabled === false) return false;
      /**
       * ★ 2026-11-07：**光有 n3 不够，还得是同一个东西。**
       * `ref` 每次快照都重编号：上一屏 n3 是"搜索"，这一屏 n3 可能是"广告关闭"。
       * 旧版只验"这个编号还在" → 重放一条旧招，点到了完全不同的地方（她"点半天点不准"的来源之一）。
       */
      if (memo.label) {
        const now = `${node.text || ''} ${node.desc || ''}`.replace(/\s+/g, ' ').trim().slice(0, 40);
        if (now !== memo.label) return false;
      }
    }
    return true;
  }

  /** 记一条：`pkg|hash|意图 → 动作`。探索型目标不记（它不是可复现的招式）。 */
  remember(key, line, task, obs = null) {
    if (!key || !line) return;
    if (task && task.intent === 'explore') return;                      // 随便点的结果没有学习价值
    const act = parseAction(line);
    let label = '';
    if (act && act.verb === 'tap' && obs) {
      const node = (obs.nodes || []).find((n) => n.ref === act.arg);
      label = node ? `${node.text || ''} ${node.desc || ''}`.replace(/\s+/g, ' ').trim().slice(0, 40) : '';
    }
    const cur = this.hints[key] || { succ: 0, fail: 0 };
    this.hints[key] = { ...cur, act: line, label, succ: Math.min(9, (cur.succ || 0) + 1), fail: 0, at: Date.now() };
    this.trimHints();
    this.saveHintsSoon();
  }

  /** 这条记忆翻车了：直接删（留着只会一直重放）。 */
  forget(key, why = '') {
    if (!key || !this.hints[key]) return;
    delete this.hints[key];
    if (why) log.info(`手机：忘掉一条记忆（${why}）`);
    this.saveHintsSoon();
  }

  /** 拉黑"这一屏 + 这个动作"：进相机、按快门这类，重放一次就够受的。 */
  blacklist(pkg, hash, intent, line) {
    const key = hintKey(pkg, hash, intent);
    this.hints[key] = { act: '', avoid: line || '1', succ: 0, fail: 0, at: Date.now() };
    /**
     * ★ 2026-11-01：**拉黑也要 trim**。
     * 原来只有成功记一条时才 `trimHints()`，`blacklist()` 只 `saveHintsSoon()` ——
     * 于是 hints 里"别做这个"的条目只增不减（`hints.json` 无限长）。
     */
    this.trimHints();
    this.saveHintsSoon();
    log.info(`手机：记住别在「${pkg || '?'}」这一屏做「${line || '?'}」（进去就出不来）`);
  }

  trimHints() {
    const keys = Object.keys(this.hints);
    if (keys.length <= 400) return;
    keys.sort((a, b) => (this.hints[a].at || 0) - (this.hints[b].at || 0));
    for (const k of keys.slice(0, keys.length - 400)) delete this.hints[k];
  }

  saveHintsSoon() {
    clearTimeout(this.hintTimer);
    this.hintTimer = setTimeout(() => {
      try { fs.writeFileSync(this.hintsFile, JSON.stringify({ version: 2, items: this.hints }, null, 0), 'utf8'); } catch { /* 写不进去不影响用 */ }
    }, 800);
    this.hintTimer.unref?.();
  }

  /* ------------------------------------------------------------ 决策 */

  /**
   * 卡住时的**第一手**：让她自己看图判断（2026-11-01 深夜，用户拍板的第一优先级）。
   *
   * 用户原话：「让她自己判断接下来点哪里，还是退出……一次任务次数限制 10 次，
   * 先按这个实际试用，如果效果好不限制也无所谓（比起几十张图的 tok 消耗，
   * 我更在意她能不能灵活的自己玩手机）」。
   *
   * 和固定退路的区别：
   *   · 固定退路（`recover`）**只会退**：back ×2 → 重开 App → 回桌面；
   *   · 这里能**往前走**：截一张 + 这一屏的动作表，问"点哪 / 还是退"，
   *     拿到一个动作就执行。App 和浏览器网页通用（自绘界面就给 `tapxy` 坐标）。
   *
   * 限次：`rescue.max`（默认 10，按任务算），**不占** `maxCalls`（那是正常决策的预算）。
   * 失败（没图 / 模型没给动作 / 给了但屏没变）返回 `null`，交回固定退路。
   */
  async rescue(task, obs) {
    const c = this.rescueCfg;
    if (!c.enabled) return null;
    if ((Number(task.rescues) || 0) >= c.max) return null;
    if (this.visionOK === false) return null;      // 模型明确看不了图：别再浪费
    if (Date.now() - (task.startedAt || Date.now()) > (task.lim || this.budget).maxMs) return null;

    /**
     * 规则在 `phone-rescue.cjs`（视频那条路也用同一份）。这里只管：
     * 记账（第几次）、发事件、把结果塞回任务（`[自救]` 进 tried，下一步 prompt 看得到）。
     */
    let asked = false;
    const r = await rescueStep({
      adb: this.adb,
      model: this.model,
      callModel: this.callModel,
      goal: task.goal,
      obs,
      tried: task.tried,
      where: whereAmI(obs).at,
      width: Number(c.width) || 360,
      settleMs: this.settleMs,
      onCall: () => { asked = true; },
    });
    /** 连问都没问成（没图/没模型）：不记次数，交给固定退路。 */
    if (!asked) return null;

    task.rescues = (Number(task.rescues) || 0) + 1;
    if (!r) return null;               // 问了但没给出能用的动作：次数照记，防止一直问

    this.emit({ kind: 'step', id: task.id, step: task.step, action: r.action, app: obs.app?.name || '', from: 'rescue', at: Date.now() });
    log.info(`手机：卡住了，让她自己看图判断 → ${r.action}（本任务第 ${task.rescues}/${c.max} 次）`);
    task.steps.push({ step: task.step, action: `[自救] ${r.action}`, changed: !!r.changed, ms: 0 });
    task.tried.push(`[自救] ${r.action}→${r.changed ? '画面变了' : '没变（可能没点中）'}`);
    if (task.tried.length > 6) task.tried = task.tried.slice(-6);
    if (!r.ok || !r.obs) return null;
    this.noteApp(task, r.obs);
    return { ok: true, obs: r.obs, action: r.action };
  }

  /**
   * 卡住时的退路阶梯（★ 2026-11-01 P0-3 重写）：
   *
   *   `key back` ×2（每次退完重新看一眼）→ **重新打开当前 App**（`launch 包名`）→ 认输
   *
   * 旧版是 `back ×1 → key home → 放弃`：**回桌面等于把目标 App 停在哪个页面全丢了**，
   * 所以她卡住后的收场几乎都是"最后停在「桌面」"（真机 11:56 / 15:14 都是）。
   * 现在把"回到当前 App"当恢复目标，桌面只留作最后一手。
   */
  async recover(task, obs, stall) {
    try {
      const backTries = Number(task.backTries) || 0;
      if (backTries < 2) {
        task.backTries = backTries + 1;
        this.emit({ kind: 'step', id: task.id, step: task.step, action: `key back（退一步 ${task.backTries}/2）`, app: obs.app?.name || '', from: 'recover', at: Date.now() });
        await this.adb.key('back');
        if (this.settleMs > 0) await sleep(this.settleMs);
        log.info(`手机：卡住了，先退一步（${task.backTries}/2）`);
        return 'back';
      }
      if (!task.wentLaunch) {
        let pkg = '';
        try { pkg = String((await this.adb.state())?.app?.package || ''); } catch { /* 读不到就用观测里的 */ }
        pkg = pkg || String(obs?.app?.package || '');
        /** 已经在桌面：没有"当前 App"可重开，直接走最后那手 home。 */
        if (pkg && !LAUNCHER_PKG.test(pkg)) {
          task.wentLaunch = true;
          this.emit({ kind: 'step', id: task.id, step: task.step, action: `launch ${pkg}（重开当前 App）`, app: obs.app?.name || '', from: 'recover', at: Date.now() });
          await this.adb.launch(pkg);
          if (this.settleMs > 0) await sleep(this.settleMs);
          log.info(`手机：退两步也不行，重新打开「${pkg}」`);
          return 'launch';
        }
      }
      if (!task.wentHome) {
        task.wentHome = true;
        this.emit({ kind: 'step', id: task.id, step: task.step, action: 'key home（回桌面重来）', app: obs.app?.name || '', from: 'recover', at: Date.now() });
        await this.adb.key('home');
        if (this.settleMs > 0) await sleep(this.settleMs);
        log.info('手机：重开也不行，回桌面重来');
        return 'home';
      }
    } catch (err) {
      log.warn(`手机：退路也走不通（${err.message}）`);
    }
    return stall >= (task.lim || this.budget).maxStall ? 'giveup' : '';
  }

  /**
   * 决策 prompt。★ 2026-10-31 拆成两段：
   *   · system = **稳定**的（她是操作员、口味、动作语法、规矩）→ prompt 缓存能命中，便宜 98%
   *   · user   = **每步都变**的（目标、这一屏、试过什么、图）
   * 旧版把所有东西都拼在 system 里，每一步的 system 都不一样，缓存永远打不中。
   */
  buildMessages(task, obs, { plan = false } = {}) {
    const sys = this.systemPrompt(plan, task);
    const where = whereAmI(obs);
    /**
     * ★ 2026-11-07：**动作表按"从上到下"给她**（`surface.tree`），不再用
     * `buildTable` 那个"可点/面积/靠屏心"排序的表。
     *
     * 旧表里 n0 往往是整个屏幕的大容器，真正的第一条结果是 n17 —— 她照着表点，
     * 点到的经常是容器。新表按区域（顶栏/内容/底栏）分组、同一行的碎片拼成一条，
     * 和截图上的位置是对应的。
     */
    const tree = surface.tree(obs, { max: 60 }) || obs.table || '（这一屏没有可点的东西）';
    const lines = [
      /**
       * ★ 2026-11-07：**同一句话，两种来源要分得清**。
       * 她自己想玩的（`session`）按她的性子来，做不完也没关系；
       * 他让做的（`chat`）是交代的事，得给他一个诚实的交代。
       */
      task.src === 'session'
        ? `目标：${task.goal}（她自己想玩的：按她的性子挑，不一定要做完）`
        : `目标：${task.goal}（他让她做的）`,
      `这一屏：${obs.app?.name || '?'}（${obs.app?.package || '?'}），${obs.count || 0} 项`,
      '【这一屏（按从上到下）】',
      tree,
    ];
    /**
     * ★ 2026-11-07：**上一步的真实效果**。以前只有 `【上一步】你刚做了 swipe up→画面变了`，
     * 但"变了"不等于"动了"（可能是广告弹出来）。现在把"屏幕纹丝没动 / 只动了一点"写清楚。
     */
    if (task.lastEffect) {
      lines.push(`【刚才那一下】${task.lastEffect}`);
      task.lastEffect = '';
    }
    /**
     * ★ 2026-11-01：**每步三句话的处境**（用户要的"操控时给她反馈"）。
     *   【你在哪】  这一屏是 App 的哪一层
     *   【上一步】  她刚做的那个动作到底有没有用（变了/没变），别再原样重来
     *   【下一步可以】这个页面通常怎么走（选项，不是命令）
     */
    if (where.at) lines.push(`【你在哪】${where.at}`);
    /**
     * ★ 2026-11-07：**搜索已经完成时，别让她把结果页当成"还没开始"**。
     *
     * 真机 20:37「搜一只猫的图片」：搜索 1 秒就完成了，接下来 20 步她都在结果页上乱点。
     * 这里把"你要的东西已经在眼前了"写死，并只给四个出口：read / tapn N / images / done。
     */
    if (task.searchWord && (Number(task.steps.length) || 0) <= 8) {
      /**
       * ★ 2026-11-08（R-C1）：**"刚搜完，下一步点开一条"** —— 这句以前不存在，于是她搜完
       * 顺手去做她最熟的两个动作（`images` → `save`），一次 `open` 都没有（真机 22:05）。
       * `quickSearch` 成功时把这一句写进 `task.hintNext`（里面还带着 ARROW 取回来的真实网址）。
       */
      lines.push(`【搜索已经完成】「${task.searchWord}」的结果就在这一屏上。`
        + '你只需要：`open N` 点开第 N 条那个网站 / `read` 看有哪几条 / `images 词`（他要看图时） / `done 一句话` 收工。'
        + '别点顶部那排「网页 / 图片 / 视频」导航，也别在结果页里乱点空白。');
    }
    /**
     * ★ 2026-11-08：**结果列表只在"她还停在结果页"时端出来**。
     * 已经点进某个网站了（`openedUrl` 有值、这一屏又不是结果页），再把那 8 条网址
     * 摆在她面前，她会以为"我还在列表上"，又回去点一条。
     */
    const onResultPage = !task.openedUrl || where.at === '浏览器·搜索结果页';
    if (task.resultItems && task.resultItems.length && onResultPage) {
      lines.push(`【这一页上的条目】（每一条 = 一个网址；点开哪条才是那个网站）\n${this.resultLines(true, task)}`);
    }
    if (task.hintNext) {
      lines.push(`【下一步】${task.hintNext}`);
      task.hintNext = '';
    }
    /**
     * ★ 2026-11-07：**"我已经读到了"就是收工信号。**
     * 真机 20:47：她已经点开文章、`read` 也读到了正文，却继续去点地址栏重新搜。
     * 这里把"读到的内容"再端一次，并明确告诉她：够了就 done。
     */
    const goalText = `${task.goal || ''} ${task.root || ''}`;
    if (task.readDigest && /(讲|读|内容|看看|什么|说清|念)/.test(goalText) && (Number(task.steps.length) || 0) >= 2) {
      lines.push(`【你已经读到了】${String(task.readDigest).slice(0, 400)}`);
      lines.push('如果这就是你要看的东西，**现在写 `done 一句话` 收工**，不要再点地址栏、也不要重新搜。');
    }
    if (task.savedImage) lines.push('（图已经存进收藏夹了；没有别的事就 done 说一声）');
    if (plan) lines.push('【先想一下】最多写 3 行动作（一行一个），按顺序做；拿不准就只写一行。不要解释。');
    /**
     * ★ 2026-11-02（C 批）：**"我停在这一屏是我自己选的"**。
     *
     * 没有这一句，`scroll` 停下来之后她常常立刻又滑走（就是用户说的"停不住"）——
     * 因为 prompt 里只有"这一屏有什么"，没有"你为什么停在这"。
     */
    if (task.stopNote) {
      lines.push(`【刚停下来】我翻了 ${Number(task.scrolls) || 0} 屏停在这里，因为：${task.stopNote}。这一屏是我特意停的 —— 先看清它，别再往下滑。`);
    }
    /**
     * ★ 2026-11-06（P1）：她刚 `read` / `find` / `waitfor` 过什么。
     * **只说一次**（说完就清）—— 和 `stopNote` 同一个道理，不然每一步都以为"刚读到"。
     */
    if (task.lastRead) {
      lines.push(`【你刚读到的】${task.lastRead}`);
      task.lastRead = '';
    }
    if (task.tried.length) {
      const last = task.tried[task.tried.length - 1];
      if (last && !/没看懂自己写的/.test(last)) lines.push(`【上一步】你刚做了 ${last}`);
    }
    if (where.hint) lines.push(`【下一步可以】${where.hint}`);
    /**
     * ★ 2026-11-06（P3）：**"这一屏能做什么"**。
     *
     * 以前她只有一张动作表（"这里有 40 个能点的东西"），没有"我能在这儿干什么"。
     * 菜单按 role/region 推（输入框 / 列表 / 网格 / 底栏 / 开关），不是写死的剧本。
     */
    const menu = apps.menuFor(obs, surface);
    if (menu) lines.push(menu);
    const appTip = apps.tipFor(obs?.app?.package);
    if (appTip) lines.push(`（${appTip}）`);
    // ★ 2026-10-31：横屏（游戏中心/视频）时画幅会翻过来 —— 不告诉她，tapxy 会点空
    if (Number(obs.screen?.width) > Number(obs.screen?.height)) {
      lines.push(`（现在是横屏：能点的范围是 ${obs.screen.width}×${obs.screen.height}，tapxy 的 0~1 相对这一屏）`);
    }
    // ★ 2026-10-31（第二轮）：多段目标时告诉她"这是第几步、整件事是什么"，别把整件事当成这一段的成功
    if (task.plan && task.plan.length > 1) {
      lines.push(`（整件事是「${task.root}」，现在只做第 ${task.phase}/${task.plan.length} 步：${task.goal}；这一段做完就 done）`);
    }
    // ★ 真机实测（10-31）：模型会点一个这一屏根本没有的 ref（比如只有 n0~n3 却写了 n4），
    // 白白烧掉一步。把可选范围写死，比让它自己数强。
    if (Number(obs.count) > 0) lines.push(`（只能从 n0 到 n${Number(obs.count) - 1} 里选；没有的 ref 会点空）`);
    /**
     * ★ 2026-11-02（C 批）：**"这一屏还没列全"要说出来**。
     * `+N 项没列出来` 原来只是动作表末尾的一行字，模型从来不把它当指令 ——
     * 于是"她不知道要往下滑"这件事一直没被修（用户 11-02 的原话）。
     */
    if (Number(obs.more) > 0) {
      lines.push(`（这一屏还有 ${obs.more} 项没列出来 —— 想看全就 scroll down，别急着 done）`);
    }
    if (task.trail.length > 1) lines.push(`这一趟去过：${task.trail.slice(0, -1).join(' → ')}`);
    if (task.tried.length) lines.push(`已经试过：${task.tried.slice(-4).join(' / ')}`);
    if (obs.thin) lines.push('（控件树几乎是空的：画面是自绘的，多半得靠图判断）');
    if (obs.shot) lines.push('（附了一张这一屏的截图，看不清字就看个大概；树上没有的东西就用 tapxy 指位置）');
    // ★ 2026-10-31 真机实测：图库整页 GL 自绘，17 个节点只有 3 个有文字，文件夹卡片根本不在树里。
    // 她会一直点左上角那个"相册"（其实是分类下拉），所以给一条 App 常识。
    if (/gallery3d/.test(obs.app?.package || '')) {
      lines.push('（图库：左上角「相册/时间」是分类菜单，点它只会换分类；照片在下面的文件夹卡片里，用 tapxy 点卡片）');
    }
    if (obs.app?.package === 'com.android.camera2') lines.push('（这是相机：没有摄像头，按快门只会拍出黑图，想离开就 key back）');
    /**
     * ★ 2026-10-31（第二轮）：浏览器的套路。10:48 那次「在浏览器里搜困了怎么办」成功，
     * 走的就是 `tap 搜索框 → text 关键词 → tap 搜索键`；10:47 那次"搜点东西"失败，
     * 是因为她只会点不会打。把这条 App 常识写死，比让她自己摸强。
     */
    if (/browser|mark\.via|chrome|quark|baidu/i.test(obs.app?.package || '')) {
      lines.push('（浏览器：最上面那条是地址/搜索栏，`tap 地址栏`（按文字点也行）→ `text 关键词` → `key enter`；结果页往下看用 `scroll down 3`，用 swipe 会甩出去；卡住或被验证码拦住就用 `restart 浏览器` 冷启动）');
    }
    /**
     * ★ 2026-11-01：**哔哩哔哩的套路**（白天两次真机都栽在"不会搜、不会点结果、不会返回"上）。
     * 和浏览器那条一样，写死比让她每步摸索便宜得多。
     */
    if (isBili(obs)) {
      lines.push('（哔哩哔哩：顶部搜索框 → 点它、text 关键词、key enter；首页卡片点封面进视频；搜索结果的卡片带时长（像 3:35），点它就进去；不想看就 key back；连按 back 回不到首页时用 launch 哔哩哔哩）');
    }
    if (task.backTries) lines.push('（已经退过 back 了，别再重复同样的动作；退两次还不行就换个入口）');
    if ((task.rep || 0) >= 1 && task.repSig) lines.push(`（「${task.repSig}」刚做过，同样的动作别连着做第三遍）`);
    /**
     * ★ 2026-10-31（自己会玩·真机实测）：**截图类目标要把"该收尾了"说出来**。
     *
     * 会话里的目标常是"往下翻，挑一张像我的，截下来"。真机跑出来的样子是：
     * 连划三屏 → 盲点一下 → 再划 → 五步用光，**一次 shot 都没按**。
     * 模型不是不会，是 prompt 里那条 `shot` 的说明离得太远，它每步都在"再翻一屏看看"。
     */
    if (SHOT_GOAL.test(task.goal) && !task.shot) {
      const done = task.steps.filter((s) => /swipe|tap/.test(String(s.action))).length;
      lines.push(done >= 2
        ? '（这一屏已经翻了几下了：**现在**挑一张顺眼的写 `shot` 收工，别再往下翻）'
        : '（这件事的收尾动作是 `shot`：挑好一张就写 `shot`，它会把这一屏截下来发给他）');
    }
    const text = lines.join('\n');
    let shotPng = obs.shot && obs.shot.png;
    let shotMime = 'image/png';
    if (shotPng) {
      /** 发出去前缩到 640 宽：图 token 与宽度无关，但 200KB 的 PNG 上传明显更慢。 */
      try {
        const mediaMod = require('./companion-media.cjs');
        const small = mediaMod.shrinkImage(shotPng, 'image/png', { maxSide: this.vision.maxSide, force: true });
        if (small && small.buf) { shotPng = small.buf; shotMime = small.mime || 'image/png'; }
      } catch { /* 缩不了就发原图 */ }
    }
    const user = obs.shot && this.visionOK !== false && shotPng
      ? {
        role: 'user',
        content: [
          { type: 'text', text },
          {
            type: 'image_url',
            image_url: {
              url: `data:${shotMime};base64,${Buffer.from(shotPng).toString('base64')}`,
              detail: obs.vision === 'high' ? 'high' : this.vision.detail,
            },
          },
        ],
      }
      : { role: 'user', content: `（动手机：${task.goal}）\n${text}` };
    return [{ role: 'system', content: sys }, user];
  }

  /**
   * 稳定的那一半（每步逐字一样，缓存才吃得着）。
   *
   * ★ 2026-11-07：**它不是她，是她的手**。
   * 原来开头写「你叫小肥鱼。你现在在用自己的手机」+「你的口味：…」—— 那是第二个人格：
   * 手机上的计划、判断、说话都跟聊天里的她不是一套。现在这里只保留
   * "你是手，不是本人" + 从**同一份只读快照**切出来的紧凑 brief（1~2 锚 / 3 口味 / 1 看法）。
   * 完整角色卡、聊天历史、旧页一律不进这里（会"演"，工具服从性也会掉）。
   */
  systemPrompt(plan = false, task = null) {
    const brief = (task && task.brief) || this.brief || null;
    const view = this.persona ? personaMod.handView(this.persona, { brief }) : '';
    return [
      '你是她手机上的手，不是她本人。你只管把这一屏点对；想看什么、要不要跟他说，是她的事 —— 你不用替他说话，也不要写跟他说的话。',
      view,
      '',
      '每一步你都会同时看到：一份**按从上到下排好的动作表**（模型能看图时，还会附这一屏的截图）。',
      plan ? '先想一个最多 3 步的小计划：一行一个动作，按顺序做；拿不准就只写一行。不要解释。' : '只输出一行，`动作 参数`：',
      'tap n3 | tapn 3 | tapxy 0.4 0.55 | longpress n3 | doubletap n3 | drag 0.5 0.8 0.5 0.2',
      'swipe up|down|left|right | scroll down 3 | scroll up 2 | scrollto 猫 | taptext 跳过',
      'text 文字 | key back|home|enter | launch 浏览器 | restart 浏览器 | openurl https://… | open 1 | wait | shot | read',
      'find 词 | waitfor 词 | images 词 | save 3 | done 一句话 | ask 一句话',
      '想核对"我是不是到了我以为的地方"，在后面加：`tap n3 | 预期: 视频页`。',
      '规矩：',
      '- 一次只做一件事；上一步"没变"就换法子，别原样重复（同一个动作最多连着做两次）',
      '- **截图和动作表一起看**：表里有字的用 ref 点；表里没有的东西（照片、图标、卡片、封面）按截图上的位置用 tapxy',
      '- ★ **只有你真的做了、屏上真的出现了，才算做到。** 没做就说没做，绝对别编"我滑了""我点开了""我看见了"',
      '- **往下看用 `scroll down 3`**：一次翻 3 屏，每一屏都会帮你看一眼，遇到你感兴趣的会自己停（比 swipe 好：swipe 一次半屏还甩出去，划过去的东西你看不见）',
      '- **往上回看用 `scroll up 2`**；专门找某样东西用 `scrollto 关键词`（翻不到会如实告诉你）',
      '- **滑不动 = 真的到底/到顶了**：别再连着滑。找屏上的「下一页」「更多」「加载更多」用 taptext；没有就 key back 换入口，或者用 openurl 直接去',
      '- **想知道这一页写了什么就 `read`**（不截图、不花步数）；找某个词 `find 词`；等它加载 `waitfor 词`',
      '- **说"第几个"就用 `tapn 3`**（普通列表里）：它数的是这一屏内容区从上往下的第 3 条，不是 n3 那个编号；**只有搜索结果页上开网站要用 `open N`**，因为那屏的 `tapn` 会先数到顶上那排页签',
      '- ★ **要搜东西就直接写 `text 关键词`（配合 `launch 浏览器` 或 `openurl` 搜索页），不要写"点搜索框/点地址栏"** —— 那是缺一个词，不是一步操作，会被打回',
      '- ★ **打完字要按 `key enter`，然后看这一屏变了没有**；屏上没出现你打的字，就是没进输入框（先 `tap` 那个输入框再 `text`）',
      '- ★ **「点图片左边的网页」这种话要按字面读**：他说左边那个，就点左边那个（`taptext 网页`），别点成"图片"',
      '- ★ **网页结果页上"打开第几条"用 `open 1` / `open 2`**：那一屏每一条 = 一个网址，`open N` 点的是第 N 条的标题（= 进那个网站）。`tapn` 在结果页上会数到顶上那排页签，别用它开网站',
      '- 搜完是**网页结果页**：先 `read` 看清楚有哪几条（每一条都带网址），再 `open 1` 打开想看的那条；**别一上来就找图**',
      /**
       * ★ 2026-11-08（R-C1）：**"顺手"不许顶掉正事**。
       * 她搜完最顺手的两个动作就是 `images`/`save`（真机 22:05 连存四张、一次没 open）。
       */
      '- **他没说要图的时候，不要 `images`**：搜完这一屏是结果列表，进网站用 `open N`；`images`/`save` 只在他真要看图时才用',
      '- **顶上那排「网页/图片/视频」只是切换搜索类型**（`taptext 网页` 切回网页那一栏），点了**不会打开任何网站**；要进网站只能用 `open N`。他不让你切、你也确认自己在网页那一栏，就别去点它',
      '- **他说要看图**时才写 `images 词`（会切到图片页并把候选读给你），挑中了写 `save 3` 存进收藏夹；他没要图时这一步会被打回',
      '- **屏上有带某字的按钮就用 `taptext 那个字`**（比如 `taptext 跳过`），不用猜 n7 是哪个、也不用猜坐标',
      '- `scroll` 停下来之后，**先看清这一屏**（它就是你要找的东西）；别再立刻滑走，也别重复滑',
      '- 只有"竖屏一条一条换"的界面（视频一条接一条那种）才用 `swipe up`，那种界面要靠甩才会吸附到下一条',
      '- 找不到就 `scrollto` 或 `scroll`；还是没有就 done 说明；拿不准就 ask',
      '- **点不动 / 进错页面 / 连着两次没进展：先 key back（最多两次）退回去换个入口**，别在原地反复点同一个地方',
      '- 要打字：先 tap 那个输入框，再 text 文字（点输入框界面不会变，是正常的），最后 `key enter`',
      '- ★ **App 卡住了 / 停在一个转不动、关不掉的页上 → `restart 浏览器`（真的是 force-stop 再冷启动）**；`launch` 只会把原来那一页恢复回来',
      '- ★ **看到"拖动滑块 / 人机验证 / 请完成验证"：这不是你要办的事，别一次一次 drag** —— 拖一次没到底就 `restart 浏览器` 重开，或 `openurl` 换百度再搜；还不行就 `done` 说清被验证拦住了，别把步数烧在这儿',
      '- 有些菜单/开关要**长按**或者**双击**：`longpress n3` / `doubletap n3`；拖动用 `drag x1 y1 x2 y2`（0~1）',
      '- 不要点支付、下单、删除、发帖、装包；要动这些先 ask',
      '- 目标是"随便看看/逛逛"时，挑你喜欢的那个，别挑第一个；看两三屏就够，挑到顺眼的就 done',
      '- 目标是"搜点东西/随便搜点什么"却没给词时，自己挑一个具体的词（4~8 个字）去搜；有搜索框就 `tap 搜索框` → `text` 那个词 → `key enter`',
      /**
       * ★ 2026-11-08（R-B 的第三半）：**搜索词只能来自他说的话**。
       *
       * 真机 22:02：目标明明是「搜小肥鱼表情包」，她打进去的是**她自己的口味词**「小猫」
       * （`config/companion.json → phone.taste` 里写着 她对猫和小动物、吃的东西会多看一眼）。
       * 她自己后来都纳闷（22:04:52 那句「小猫？我什么时候搜的小猫」）。
       */
      '- ★ **搜的词只能是他那句里出现过的词**；想不出该搜什么就别搜，`done` 说一句搜什么没听清，别拿你自己喜欢的词（猫 / 小动物 / 吃的）去凑',
      '- 别拿**页面上本来就停着**的搜索结果说"我搜了"：要么你写过 `search 词`/`openurl`，要么你自己 `text` 打了字',
      '- `launch` 可以写 App 名（浏览器/相册/设置），不用猜包名；`openurl` 可以直接打开一个网址',
      '- 想让他看看你屏幕上的东西，就写 `shot`（截当前这一屏，会跟着你下一句话发给他）',
      '- 进到相机那屏别按快门，按 key back 离开',
      '- **done 之前先自检**：目标里的东西真的在这一屏上吗？这趟你真的做了那几步吗？没把握就继续做，别硬收工',
    ].join('\n');
  }

  /* ------------------------------------------------------------ 滚动 */

  /**
   * 一句话说清"这一下滚动到底发生了什么"。
   * 不许只说"翻了"：如果屏幕一动没动，要如实说"没动"（她以前会把这个补成"翻到底了"）。
   */
  scrollSummary(dir, r) {
    const name = dir === 'up' ? '往上' : '往下';
    if (!r || !r.screens) {
      return `想${name}翻，但屏幕一动没动（可能已经到${dir === 'up' ? '顶' : '底'}了，或者这一屏根本不能滚）`;
    }
    const where = whereAmI(r.obs).at || r.obs?.app?.name || '这一屏';
    const why = r.found
      ? (r.kind === 'interest' ? '，这一屏有我想看的' : `，停在有「${String(r.why).replace(/^看到「|」了$/g, '')}」的一屏`)
      : '';
    const trail = (r.trail || []).slice(-3).join(' / ');
    /** ★ 2026-11-07：只翻了一屏时要说"还没到底"，否则回灌时她会自己补成"到底了"（真机 21:20）。 */
    const atEnd = /到底|到顶|滑不动|不能滚/.test(String(r.why || ''));
    const more = atEnd ? '' : '（还没到底，可以继续往下翻）';
    return `${name}翻了 ${r.screens} 屏，停在「${where}」${why}${more}${trail ? `（刚翻过：${trail}）` : ''}`;
  }

  /**
   * ★ 2026-11-02（C 批）：**一边滑一边看**。用户：「她不知道什么时候下滑，
   * 我告诉她下滑后她不知道下滑途中停止，去看自己想看的东西」。
   *
   * 旧行为：`swipe` 一划 0.5 屏（必然甩出去）→ 划完才看一屏 —— 划过去的东西她一件没看见。
   * 现在：小步滑（按容器分档，见 `phone-scroll.profileOf`）→ **每滑一屏判一次**
   * （目标词 / 她的兴趣词 / 自绘屏才用图问一次）→ 值得停就停在这一屏。
   *
   * ★ 2026-11-07 加厚（用户：「让她下滑她也卡在某个地方不动」）：
   *   · 第一次滑之前先等页面沉降（刚 `am start` 打开的网页 4 秒还没加载完，
   *     那一滑 `waitChange` 只会拿到同一棵树 —— 她会以为"到底了"）；
   *   · 滑不动**不等于到底**：换大一点的跨度再试一次，两次都不动才如实说；
   *   · 每一屏记一行摘要（`trail`），下一步 prompt 里能看到"刚翻过哪几屏"；
   *   · 一次手势最多 8 屏（原来 6）。
   *
   * 停止条件（都是硬的，不会无限翻）：
   *   · 命中目标词 / 兴趣词 → `found`
   *   · 两次不同跨度都滑不动 → 到底了 / 这一屏不能滚
   *   · 连着两屏没有新词 / 一屏里 85% 的字和上一屏一样 → 到底了
   *   · 翻满 `maxScreens`（默认 3，最多 8）
   *
   * @returns {Promise<{ok:boolean, found:boolean, why:string, obs:object, screens:number, changed:boolean, trail:string[]}>}
   */
  async scan(task, obs, { dir = 'down', maxScreens = 3, target = '' } = {}) {
    const seen = task.scanSeen || (task.scanSeen = new Set());
    const cap = Math.max(1, Math.min(8, Number(maxScreens) || 3));
    let cur = obs;
    let screens = 0;
    let visionLeft = (this.vision.enabled && this.visionOK !== false)
      ? (this.scrollLookEach ? this.scrollLookMax : 2)
      : 0;
    let why = '';
    let found = false;
    let kind = '';
    /**
     * ★ 2026-11-07：**"翻三屏"就是三屏**。
     * 真机上"往下翻三屏"每翻一屏都看到"狗"（兴趣词），于是每次只走 1 屏就停，
     * 计划里的"再翻"永远做不完，最后被"同一个动作 3 遍"判死。
     * 目标里写了具体屏数时，屏数优先；没写才按兴趣停。
     */
    const CN_NUM = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
    const sm = /(\d+|[一二两三四五六七八九十])\s*屏/.exec(String(task.goal || ''));
    const wantScreens = sm ? (/^\d+$/.test(sm[1]) ? Number(sm[1]) : (CN_NUM[sm[1]] || 0)) : 0;
    const trail = [];
    /** 一行"刚翻过什么"：跳过顶栏/按钮行，宁愿空着也别把"切换到国际版"当成内容。 */
    const UIISH = /^(切换到|打开必应|首选项|刷新|站点信息|网页前进|网页后退|主页|菜单|搜索工具)/;
    const firstLine = (o) => {
      const hit = scroll.textsOf(o).find((t) => t.length >= 8 && !UIISH.test(t));
      if (hit) return hit.slice(0, 60);
      const d = surface.digest(o, { max: 160 }) || '';
      return (d.split('\n').map((x) => x.replace(/^[·\s]+/, '').trim()).find((x) => x && !/^顶栏|^底栏/.test(x)) || '').slice(0, 60);
    };

    for (let i = 0; i < cap; i++) {
      /**
       * 普通 `scroll` **先滑再判**：第一屏本来就在眼前，判它等于什么都没做
       * （而且她正是因为"这一屏没什么"才要滑）。
       * `scrollto` 先判：要找的东西可能已经在屏上。
       */
      if (target || i > 0) {
        const v = scroll.verdict(cur, { goal: task.goal, target });
        /**
         * 具体屏数优先：还没翻够 N 屏时，兴趣词不叫停（否则"翻三屏"永远只走一屏）。
         */
        const defer = v.stop && v.kind === 'interest' && wantScreens && screens < wantScreens;
        if (v.stop && !defer) { why = v.why; found = true; kind = v.kind || ''; break; }
      }
      /**
       * 老的兜底只对"这一屏没字"问一次；★ 2026-11-07 起默认 `scrollLookEach`
       * 改成**每翻一屏都问一次**（在下面 `screens += 1` 之后），所以这里只在关掉时用。
       */
      if (!this.scrollLookEach && visionLeft > 0 && (cur.thin || !scroll.textsOf(cur).length)) {
        visionLeft -= 1;
        const v = await this.scanAsk(cur, task);
        if (v && v.stop) { why = v.why; found = true; break; }
      }
      const p = scroll.profileOf(cur);
      const pkg = cur.app?.package || '';
      /**
       * ★ 2026-11-06 21:45（用户实测：「不管说往下翻还是往上翻，都没有下滑」）：
       *
       * **`scroll down` 和手指方向是反的。**
       * 动词里 `down` 的意思是"往页面下方看"；而 `swipeDir('down')` 是**手指往下划 = 页面回到上面**。
       * 搜索结果页本来就停在顶部，于是 `scroll down` 一直把她往顶上顶 → 屏不变 →
       * `waitChange` 判"滑不动" → 她只能说"翻到底了"（21:42 那条就是这么来的）。
       * 现在把**页面向下**翻成**手指往上**。
       */
      const finger = dir === 'down' ? 'up' : (dir === 'up' ? 'down' : dir);
      let w = null;
      /**
       * 两次尝试：第一次按列表的小跨度；没动就换大跨度再试（页面可能还在加载，
       * 或者这一屏有一个吃掉手势的浮层）。**两次都不动才是真的到底/不能滚。**
       */
      for (let attempt = 0; attempt < 2; attempt++) {
        if (i === 0 && attempt === 0 && this.scrollSettleMs > 0) await sleep(this.scrollSettleMs);
        const span = Math.min(0.9, p.span + attempt * 0.22);
        try {
          await this.adb.swipeDir(finger, { screen: cur.screen, ms: p.ms, span });
        } catch { why = '滑不动'; break; }
        task.scrolls = (Number(task.scrolls) || 0) + 1;
        w = await this.adb.waitChange(cur.hash, { timeout: 1.6, screen: cur.screen, app: pkg });
        if (w && w.changed !== false) break;
        if (attempt === 0) await sleep(350);
      }
      if (!w || w.changed === false) {
        why = dir === 'up' ? '滑不动了（到顶了，或者这一屏不能滚）' : '滑不动了（到底了，或者这一屏不能滚）';
        break;
      }
      const prev = cur;
      cur = w.tree ? await this.perceiveFrom(w.tree, prev, task) : await this.perceive(task);
      screens += 1;
      const line = firstLine(cur);
      if (line) trail.push(line.slice(0, 60));
      /** 目标写了"翻 N 屏"：翻够就停，不再问看图，也不被"没新词"提前打断。 */
      if (wantScreens && screens >= wantScreens) { why = `翻到第 ${screens} 屏（你要的 ${wantScreens} 屏）`; break; }
      const fresh = scroll.newTexts(cur, seen, prev);
      if (screens >= 2 && fresh.ratio > 0.85) { why = '滑不动了（到底了）'; break; }
      if (screens >= 2 && !fresh.count) { why = '连着两屏没有新东西'; break; }
      /**
       * ★ 2026-11-07：**每翻一屏都让她自己看一眼图**（用户："连续不断识屏都可以接受"）。
       *
       * 以前停下与否只由 `INTEREST` 词表决定 —— 图里的猫、好看的照片、视频封面
       * 在控件树里根本没有字，她永远"没看见"。
       * 现在每屏一张图、一次 8 token 的判断：`停` 就停在这里，`再翻` 就继续。
       * 只朝下翻时问；往回翻（`scroll up`）不问，避免一路停。
       */
      if (this.scrollLookEach && dir === 'down' && visionLeft > 0) {
        visionLeft -= 1;
        const v = await this.scanAsk(cur, task, { index: screens, dir });
        if (v && v.stop && !(wantScreens && screens < wantScreens)) {
          why = `第 ${screens} 屏有我想看的`; found = true; kind = 'interest'; break;
        }
      }
    }

    if (!found && !why) why = target ? `翻了 ${screens} 屏也没看到「${target}」` : `翻了 ${screens} 屏`;
    task.scrollTrail = trail;
    return { ok: true, found, why, kind, obs: cur, screens, changed: screens > 0, trail };
  }

  /**
   * 滚动时的"要不要停"判断（8 token 输出：**停 / 再翻**）。
   *
   * ★ 2026-11-07：从"只在没字时兜底"升级成**每屏都问**（`scroll.lookEach`）。
   * 用户明确放开 token：「连续不断识屏之类的方法都可以接受」。
   * 图里的猫、好看的照片、视频封面在控件树里根本没有字，只靠词表她永远看不见。
   *
   * @returns {Promise<{stop:boolean, why:string}|null>} null = 没问成（没图 / 模型不看图）
   */
  async scanAsk(obs, task, { index = 0, dir = 'down' } = {}) {
    if (!this.vision.enabled || this.visionOK === false) return this.judgeByText(obs, task);
    let shot = obs?.shot;
    if (!shot || !shot.png) {
      try {
        const s = await this.adb.screenshot({});
        if (s && s.ok && s.png) shot = s;
      } catch { /* 截不到就只能靠文字 */ }
    }
    if (!shot || !shot.png) return this.judgeByText(obs, task);

    let content = [{
      type: 'text',
      text: [
        this.persona
          /**
           * ★ 2026-11-07：判断口径换成**她自己的**口味 + 她自己说的"什么样就够了"。
           * 旧版是通用分类器「猫 / 小动物 / 吃的」—— 那不是她，是另一个人。
           */
          ? personaMod.judgeView(this.persona, {
            goal: task?.goal || '',
            stopCriteria: (task?.brief && task.brief.stopCriteria) || (this.brief && this.brief.stopCriteria) || '',
            screen: '',
          })
          : [
            `目标：${task?.goal || '随便看看'}`,
            `你的口味：${this.taste}`,
            '判断：这一屏有没有**真正值得停下来看**的东西？',
            '只有画面里真的有你感兴趣的（猫 / 小动物 / 吃的 / 目标里提到的），或者目标里的东西出现了，才回「停」；',
            '普通列表、广告、导航栏、看不清楚的图，一律回「再翻」。',
            '只回一个词：停 / 再翻',
          ].join('\n'),
        `这是你刚${dir === 'down' ? '往下' : '往上'}翻到的第 ${index || 1} 屏（截图）。`,
      ].join('\n'),
    }];
    try {
      const media = require('./companion-media.cjs');
      const small = media.shrinkImage(shot.png, 'image/png', { maxSide: 360, force: true });
      content.push({
        type: 'image_url',
        image_url: { url: `data:${small.mime || 'image/jpeg'};base64,${small.buf.toString('base64')}`, detail: 'low' },
      });
    } catch { /* 缩不了就发原图 */ }

    let out;
    try {
      out = await this.callModel(this.model, [
        { role: 'system', content: '你看手机截图，只回答「停」或「再翻」，不要解释。' },
        { role: 'user', content },
      ], { temperature: 0.2, maxTokens: 16, thinking: { type: 'disabled' } });
    } catch (err) {
      if (/image|vision|multimodal|400|unsupported|不支持/i.test(err.message)) this.visionOK = false;
      return this.judgeByText(obs, task);
    }
    const t = String(out && out.text || '');
    if (/(停|stop)/i.test(t) && !/(再翻|继续|不)/.test(t)) return { stop: true, why: '这一屏有我想看的' };
    return { stop: false, why: '' };
  }

  /**
   * ★ 2026-11-07：**没有截图时，用她自己的文字判断**（`CompanionBrain.judgePhone`，聊天模型）。
   * 返回 null 才说明真的判断不了（没有快照 / 没有 judge 回调 / 模型失败）。
   */
  async judgeByText(obs, task) {
    if (!this.personaJudge || !this.persona) return null;
    const brief = (task && task.brief) || this.brief || null;
    try {
      const r = await this.personaJudge({
        persona: this.persona,
        goal: (task && task.goal) || '',
        screen: surface.digest(obs, { max: 200 }),
        stopCriteria: (brief && brief.stopCriteria) || '',
      });
      if (!r) return null;
      return { stop: !!r.stop, why: r.why || (r.stop ? '这一屏有她自己想看的' : '') };
    } catch (err) {
      log.warn(`手机：文字判断没成（${err.message}）`);
      return null;
    }
  }

  /** 一个动作。返回 `{changed, obs?, finish?}`。 */
  async execute(action, obs, task) {
    const { verb, arg } = action;
    const before = obs.hash;
    if (verb === 'done') {
      const v = this.verifyDone(task, obs, arg);
      if (v.ok) return { finish: { ok: true, summary: arg || '弄完了' } };
      /**
       * ★ 2026-10-31（层 0）：**`done` 被打回不再直接判任务死**。
       *
       * 11:41 那次自主「打开浏览器随便看看，遇到有意思的就截下来」——模型第一句就是 `done`，
       * 被断言打回，任务**0 步死掉**。可它其实只是"还没动手就说了完"，纠正一句就能接着干。
       * 现在：把理由塞回 `task.tried`（下一轮 prompt 里她看得见），**重置 rep**（不然连续 3 次 done
       * 会先被"同一动作做了 3 遍"那条硬规则干掉），弹回最多 2 次，第 3 次才认输。
       */
      task.doneBounces = (task.doneBounces || 0) + 1;
      if (task.doneBounces > 2) return { finish: { ok: false, summary: v.why } };
      task.tried.push(`（我说做完了，被打回：${v.why}）`);
      if (task.tried.length > 6) task.tried = task.tried.slice(-6);
      task.rep = 0;
      task.repSig = '';
      this.emit({ kind: 'bounce', id: task.id, why: v.why, at: Date.now() });
      return { changed: null, bounced: v.why };
    }
    if (verb === 'ask') {
      return { finish: { ok: true, asked: true, summary: arg || '这个要不要做？' } };
    }
    /**
     * ★ 2026-11-06（P1）：**先读，再决定**。
     *
     * 她以前只能"看图猜"，因为没有一个"把这一页读给我"的动作。
     * `read` 不改屏幕、不花步数（`noStall`），只是把这一屏整理成一段话；
     * 读到的内容会以 `【你刚读到的】` 出现在**下一步**的 prompt 里，她再决定点什么。
     */
    if (verb === 'read') {
      /**
       * ★ 2026-11-08（P3 接线）：**点开了一个网站，就读那个网站的真正文**。
       *
       * `her-web.readPage()` 从 11-06 就写好了，可一直**没人调过**（注释里写着"P3 再接"）——
       * 于是"点进去看看讲了什么"只能靠无障碍树：Via 是 WebView 套壳，树里常常只有
       * 标题栏 + 几行碎片，她说不出内容，只能拿屏幕上的字凑。
       * 现在：`open N` 记住了网址（`task.openedUrl`），`read` 就用 PC 侧抓正文；
       * 抓不到（超时/被拦/非网页）再退回"读这一屏"，并如实说明是屏幕上的字。
       */
      const url = task.openedUrl || '';
      let fromWeb = null;
      if (url && this.web && typeof this.web.readPage === 'function') {
        try { fromWeb = await this.web.readPage(url, { maxChars: 1200, timeoutMs: 6000 }); } catch { fromWeb = null; }
      }
      if (fromWeb && fromWeb.ok && String(fromWeb.text || '').length >= 60) {
        task.lastRead = `《${String(fromWeb.title || '').slice(0, 60)}》正文（${url}）：\n${String(fromWeb.text).slice(0, 900)}`;
        task.readDigest = task.lastRead;
        return { changed: false, noStall: true, note: '把这一页的正文读完了' };
      }
      task.lastRead = surface.digest(obs);
      task.readDigest = task.lastRead;
      return {
        changed: false,
        noStall: true,
        note: url ? '这一页的正文没抓到（可能不是网页/被拦），只能读屏幕上的字' : '读完这一屏了',
      };
    }
    /**
     * ★ 2026-11-06 21:40：`images 词` / `save 3` —— **看图、存图是她自己的选择**。
     * 搜索默认给网页；她真想看图才切过去，看完指定要哪张才下载。
     */
    /**
     * ★ 2026-11-08（R-C1）：**`images` 只在他要图时才允许**。
     *
     * 真机 22:05：他让她搜网页、挑个网站点进去，她搜完直接 `images 小肥鱼表情包` → `save ×4`，
     * 一次 `open` 都没做。`images`/`save` 是她最"顺手"的两个动作，顺手就会把正事顶掉。
     * 所以：**他说过图**（目标里有 图/照片/壁纸/表情包/封面/头像）才准切图片页；
     * 她自己想玩的（`session`）不受这条限制。
     */
    if (verb === 'images') return this.imagesSearch(task, arg);
    if (verb === 'save') return this.savePicked(task, arg);
    if (verb === 'find') {
      const word = String(arg || '').trim().slice(0, 20);
      if (!word) return { changed: false, noStall: true, note: 'find 后面要跟要找的词' };
      const hit = surface.find(obs, word);
      const where = hit ? ({ appbar: '顶栏', tabbar: '底栏', status: '状态栏' }[hit.region] || '内容区') : '';
      task.lastRead = hit
        ? `这一屏有「${word}」：${hit.ref} ${hit.text}（在${where}）`
        : `这一屏没有「${word}」`;
      return { changed: false, noStall: true, note: task.lastRead };
    }
    if (verb === 'waitfor') {
      const word = String(arg || '').trim().slice(0, 20);
      if (!word) return { changed: false, noStall: true, note: 'waitfor 后面要跟要等的词' };
      let hit = null;
      let tries = 0;
      for (; tries < 4 && !hit; tries++) {
        hit = surface.find(obs, word);
        if (hit) break;
        await sleep(700);
        try {
          const o = await this.adb.observe({ shot: false });
          if (o && o.ok) obs = o;
        } catch { break; }
      }
      task.lastRead = hit
        ? `等到了「${word}」：${hit.ref} ${hit.text}`
        : `等了约 ${tries * 0.7 + 0.3} 秒也没等到「${word}」`;
      return { changed: false, noStall: true, note: task.lastRead };
    }
    /**
     * ★ 2026-11-02（C 批）：**滚动不是一个动作，是一段过程**。
     *
     * `scroll down 3` = 小步滑 + 每滑一屏判一次（见 `scan()`），花 **1 步**的钱看 3 屏。
     * 停下来时把"为什么停"写进 `task.stopNote`，下一步 prompt 里会出现 `【刚停下来】…`。
     */
    if (verb === 'scroll') {
      const m = /(up|down|left|right)/i.exec(String(arg || ''));
      const dir = m ? m[1].toLowerCase() : 'down';
      const n = Number((String(arg || '').match(/(\d+)/) || [])[1]) || 3;
      const r = await this.scan(task, obs, { dir, maxScreens: n });
      if (r.found) { task.stopNote = r.why; task.lastStop = r.why; }
      /**
       * ★ 2026-11-02（第三批）：**看到"她自己的兴趣"命中时，报一声** ——
       * 上层（`phone-life.onFound`）决定要不要把这张图发给他（一场最多 2 次）。
       * 目标是"找某个词"或"目标里的东西"时**不报**：那是她自己要办的事，不是分享。
       */
      if (r.found && r.kind === 'interest') {
        this.emit({ kind: 'found', id: task.id, why: r.why, app: obs.app?.name || '', src: task.src || 'chat', session: task.session || '', at: Date.now() });
      }
      this.emit({ kind: 'scroll', id: task.id, step: task.step, dir, screens: r.screens, found: r.found, why: r.why, at: Date.now() });
      return { changed: r.screens > 0, obs: r.obs, note: r.why, effect: this.scrollSummary(dir, r), found: r.found, kind: r.kind };
    }
    /**
     * `scrollto 猫` = 一直往下翻到出现这个词（最多 6 屏），翻不到就如实说。
     * 治"漫无目的地滑"和"滑三下就 done"。
     */
    if (verb === 'scrollto') {
      const target = String(arg || '').trim().slice(0, 20);
      if (!target) return { changed: false, note: 'scrollto 后面要跟要找的词' };
      const r = await this.scan(task, obs, { dir: 'down', maxScreens: 6, target });
      const note = r.found ? r.why : `翻了 ${r.screens} 屏也没看到「${target}」`;
      if (r.found) { task.stopNote = r.why; task.lastStop = r.why; }
      this.emit({ kind: 'scroll', id: task.id, step: task.step, dir: 'down', target, screens: r.screens, found: r.found, why: r.why, at: Date.now() });
      return { changed: r.screens > 0, obs: r.obs, note, found: r.found, kind: r.kind };
    }
    /**
     * `taptext 跳过` = 点屏上"带这个字"的那个东西。
     * 模型不用猜 `n7` 是哪个、也不用 `tapxy` 猜坐标 —— "点带'跳过'的"本来就是字面。
     *
     * ★ 2026-11-08：**点搜索类型页签（网页/图片/视频…）不等于打开网站**。
     * 真机 21:27–21:28：他说「你点网页」，点完她回灌"点进去了，就是那条梗鲸的" ——
     * 其实只切了个页签。所以这种情况下 `note` 必须说清楚"还是同一页搜索结果，没打开任何网站"。
     */
    if (verb === 'taptext') {
      const needle = String(arg || '').trim().slice(0, 20);
      if (!needle) return { changed: false, note: 'taptext 后面要跟要点的字' };
      const cands = (obs.nodes || []).filter((n) => `${n.text || ''} ${n.desc || ''}`.includes(needle));
      if (!cands.length) return { changed: false, note: `这一屏没有「${needle}」` };
      const areaOf = (n) => {
        const b = n.bounds || [0, 0, 0, 0];
        return Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
      };
      const pick = cands.find((n) => `${n.text || ''} ${n.desc || ''}`.trim() === needle)
        || cands.filter((n) => n.clickable).sort((a, b) => areaOf(a) - areaOf(b))[0]
        || cands[0];
      if (!pick.center) return { changed: false, note: `找不到「${needle}」在哪儿` };
      await this.adb.tapXY(pick.center[0], pick.center[1]);
      const w = await this.adb.waitChange(before, { timeout: 1.5, screen: obs.screen, app: obs.app?.package || '' });
      const isTab = surface.NAV_WORD.test(needle);
      return {
        changed: w.changed,
        tree: w.tree,
        note: isTab
          ? `点了顶上那排里的「${needle}」（那是切换搜索类型，还是同一页搜索结果，**没有打开任何网站**）`
          : `点了「${needle}」`,
      };
    }
    /**
     * ★ 2026-11-08：**`open 1` = 打开第 1 条搜索结果（那个网址）**。
     *
     * 用户实测：「她不会点网页」「每一条对应一个网址，网址的内容就是看到的网页」。
     * `tapn N` 数的是"内容区里带字的节点"——在结果页上第 1 个是那排页签的「网页」，
     * 所以以前点三次都在点页签。`open N` 改成按"网址那一行"认条目（`surface.results()`），
     * 点的是这一条的标题（标题才是那个链接）。
     */
    if (verb === 'open') {
      const n = Number((String(arg || '').match(/\d+/) || [])[0]) || 1;
      /**
       * ★ 2026-11-08：**知道网址就直接开那个网址**（`openurl`），不再猜坐标。
       *
       * 搜完那一趟 `quickSearch` 已经把结果（标题 + 真实网址）取回 PC 了（`task.resultItems`）。
       * 于是"打开第 1 条"= `am start VIEW 那条网址` —— 这比"点屏幕上第 1 条标题"可靠得多
       * （标题可能是两行、可能被展开的菜单挡住、可能点偏半行）。
       *
       * ⚠️ 但**必须先核对序号**：手机上的排序可能和 PC 抓的不是同一份（Cookie / AB 实验）。
       * 所以拿这一屏认出来的第 N 条标题跟 PC 那份比：**前缀对得上才用网址**，
       * 对不上就老老实实点屏幕（宁可慢，也不要打开错的网站）。
       */
      const known = Array.isArray(task.resultItems) ? task.resultItems[n - 1] : null;
      const list0 = surface.results(obs);
      const onPhone = list0[n - 1] || null;
      if (known && known.url && this.sameResult(onPhone, known, task)) {
        const r = await this.adb.openUrl(known.url);
        if (r.ok) {
          await sleep(900);
          const o = await this.perceive(task);
          if (o && o.ok && o.hash !== before) {
            task.openedUrl = known.url;
            task.openedTitle = known.title;
            task.steps.push({ step: 1, action: `open ${n}`, changed: true, ms: 0 });
            return {
              changed: true,
              obs: o,
              note: `打开了第 ${n} 条：${known.title.slice(0, 30)}（${known.site || known.url}）`,
            };
          }
        }
      }
      if (!list0.length) {
        /** 认不出网址结构（不是结果页 / DOM 没给域名）→ 退回"第 N 个内容节点"，别硬说没有。 */
        const p = surface.pick(obs, `第${n}个`);
        if (!p || !p.center) return { changed: false, note: `这一屏认不出「第${n}条」` };
        await this.adb.tapXY(p.center[0], p.center[1]);
        const w0 = await this.adb.waitChange(before, { timeout: 1.8, screen: obs.screen, app: obs.app?.package || '' });
        return { changed: w0.changed, tree: w0.tree, note: `点了第 ${n} 个「${String(p.text || '').slice(0, 16)}」` };
      }
      const item = list0[n - 1];
      if (!item || !item.center) return { changed: false, note: `这一屏只有 ${list0.length} 条结果，没有第 ${n} 条` };
      await this.adb.tapXY(item.center[0], item.center[1]);
      const w = await this.adb.waitChange(before, { timeout: 2.5, screen: obs.screen, app: obs.app?.package || '' });
      /** 记住打开的是哪个网址（`done` / 回灌要说得出"我打开了哪个网站"）。 */
      if (w.changed) {
        task.openedUrl = item.url;
        task.openedTitle = item.title;
      }
      return {
        changed: w.changed,
        tree: w.tree,
        note: w.changed
          ? `打开了第 ${n} 条结果的网址 ${item.url}${item.title ? `（《${item.title.slice(0, 24)}》）` : ''}`
          : `点了第 ${n} 条（${item.url}），但屏幕没变（可能没打开）`,
      };
    }
    /**
     * ★ 2026-11-07：`tapn 3` = 点**内容区从上往下第 3 个有字的条目**。
     * 她说"点第三个结果"时，`n3` 是这一屏的节点编号、不是"第 3 条"；
     * `tapn` 数的是人眼里的条数（`surface.pick`），这才是"第三个"的意思。
     */
    if (verb === 'tapn') {
      const n = Number((String(arg || '').match(/\d+/) || [])[0]) || 0;
      if (!n) return { changed: false, note: 'tapn 后面要跟第几个（tapn 3）' };
      const pick = surface.pick(obs, `第${n}个`);
      if (!pick || !pick.center) return { changed: false, note: `这一屏没有第 ${n} 个能点的东西` };
      const act = await this.adb.tapXY(pick.center[0], pick.center[1]);
      if (!act.ok) return { changed: false, note: `点第 ${n} 个没点出去` };
      const w = await this.adb.waitChange(before, { timeout: 1.8, screen: obs.screen, app: obs.app?.package || '' });
      return { changed: w.changed, tree: w.tree, note: `点了第 ${n} 个「${String(pick.text || '').slice(0, 20)}」` };
    }
    /** 长按（弹出菜单、拖动、选择文字都靠它）。 */
    if (verb === 'longpress') {
      const ref = String(arg || '').trim();
      const node = (obs.nodes || []).find((n) => n.ref === ref);
      if (!node) return { changed: false, note: `这一屏没有 ${ref}` };
      const [cx, cy] = node.center || [0, 0];
      await this.adb.swipe(cx, cy, cx, cy, 900);
      const w = await this.adb.waitChange(before, { timeout: 1.8, screen: obs.screen, app: obs.app?.package || '' });
      return { changed: w.changed, tree: w.tree, note: `长按了「${(node.text || node.desc || ref).slice(0, 20)}」` };
    }
    /** 双击（有的器只有双击才进得去/放大）。 */
    if (verb === 'doubletap') {
      const ref = String(arg || '').trim();
      const node = (obs.nodes || []).find((n) => n.ref === ref);
      if (!node) return { changed: false, note: `这一屏没有 ${ref}` };
      const [cx, cy] = node.center || [0, 0];
      await this.adb.tapXY(cx, cy);
      await sleep(90);
      await this.adb.tapXY(cx, cy);
      const w = await this.adb.waitChange(before, { timeout: 1.8, screen: obs.screen, app: obs.app?.package || '' });
      return { changed: w.changed, tree: w.tree, note: `双击了「${(node.text || node.desc || ref).slice(0, 20)}」` };
    }
    /** 按住拖动（画中画、滑块、列表重排）；坐标是 0~1 相对这一屏。 */
    if (verb === 'drag') {
      const ns = (String(arg || '').match(/[\d.]+/g) || []).map(Number);
      if (ns.length < 4) return { changed: false, note: 'drag 要写成 drag 0.5 0.8 0.5 0.2' };
      const scr = obs.screen || { width: 720, height: 1280 };
      await this.adb.swipe(
        Math.round(ns[0] * scr.width), Math.round(ns[1] * scr.height),
        Math.round(ns[2] * scr.width), Math.round(ns[3] * scr.height), 700,
      );
      const w = await this.adb.waitChange(before, { timeout: 1.8, screen: scr, app: obs.app?.package || '' });
      return { changed: w.changed, tree: w.tree, note: '拖了一下' };
    }
    /** 直接用 intent 打开一个网址（浏览器地址栏点不准时最可靠）。 */
    if (verb === 'openurl') {
      const url = String(arg || '').trim();
      if (!/^https?:\/\//i.test(url)) return { changed: false, note: 'openurl 后面要跟 http(s):// 开头的网址' };
      const r = await this.adb.openUrl(url);
      if (!r.ok) return { changed: false, note: `网址没打开（${r.msg || '?'}）` };
      await sleep(900);
      const o = await this.perceive(task);
      return { changed: true, obs: o.ok ? o : null, note: '网址打开了' };
    }
    if (verb === 'tap') {
      // ★ 用**观察时**记下的坐标点，不再为解析 ref 重新 dump（省 2.3 s/步）
      const want = String(arg || '').trim();
      let node = (obs.nodes || []).find((n) => n.ref === want);
      /**
       * ★ 2026-11-08：**`tap 搜索框` 这种写法以前一定失败**（提示里教了三次）。
       *
       * 提示里写着「先 `tap` 那个输入框」「浏览器：最上面那条是地址/搜索栏，`tap` 它就能打字」，
       * 可 `execute('tap')` **只认 `nN` 这种 ref** —— 她照着提示写 `tap 地址栏`，
       * 只会得到「这一屏没有 地址栏」，然后开始乱试（真机 22:02 那 20 步就是这么来的）。
       * 现在：不是 ref 就按**屏上的文字**找那个东西（`surface.find`），找到就点它。
       * 找不到才如实说"这一屏没有这个字"。
       */
      if (!node && want && !/^n\d+$/i.test(want)) {
        const hit = surface.find(obs, want);
        if (hit) {
          node = (obs.nodes || []).find((n) => n.ref === hit.ref) || { ...hit };
        }
      }
      if (!node) {
        // 这一屏根本没这个 ref：别为它白 dump 一次（2.3 s），直接记一笔"点空"
        return { changed: false, note: `这一屏没有 ${arg}（要按文字点就用 taptext ${arg}）` };
      }
      /**
       * ★ 2026-10-31：**点输入框，界面本来就不会变**（变的是输入法，不在这一屏的树里）。
       * 旧版照样等 2 秒验证、还记一笔"没反应"，于是"点搜索框 → 打字"这条路
       * 连着两次就判卡住、走 back/home —— 10-31 上午「点搜索框，打几个字上去再找」就是死在这。
       * 所以：输入框只点、不验证，也不当"没变"。
       */
      if (node.editable) {
        const r0 = await this.adb.tap(node.ref || want, {
          verify: false,
          at: node.center,
          screen: obs.screen,
          app: obs.app?.package || '',
        });
        if (!r0.ok) return { changed: false, note: `没点上「${String(node.text || want).slice(0, 16)}」：${r0.msg || '点不动'}` };
        return { changed: null, last: r0.label || '', note: `点开了输入框「${String(node.text || want).slice(0, 16)}」，接下来该 text 打字` };
      }
      const r = await this.adb.tap(node.ref || want, {
        verify: true,
        at: node.center,
        hash: before,
        screen: obs.screen,
        app: obs.app?.package || '',
      });
      return { changed: r.changed === undefined ? null : r.changed, last: r.label || '', tree: r.tree };
    }
    /**
     * ★ 2026-10-31：按**画面上的位置**点（归一化 0~1，左上角是 0 0）。
     * 为什么必须有：图库整页是 GL 自绘的（17 个节点只有 3 个有文字），
     * 文件夹卡片在无障碍树里**根本不存在** —— ref 无从点起，只能看图给坐标。
     */
    if (verb === 'tapxy') {
      const m = /([\d.]+)[\s,，]+([\d.]+)/.exec(String(arg));
      if (!m) return { changed: false, note: 'tapxy 要写成 tapxy 0.4 0.55' };
      const nx = Number(m[1]);
      const ny = Number(m[2]);
      if (!(nx >= 0 && nx <= 1 && ny >= 0 && ny <= 1)) return { changed: false, note: '坐标要落在 0~1' };
      const scr = obs.screen || (await this.adb.state()).screen || { width: 720, height: 1280 };
      const x = Math.round(nx * (scr.width || 720));
      const y = Math.round(ny * (scr.height || 1280));
      const act = await this.adb.tapXY(x, y);
      if (!act.ok) return { changed: false, note: `这一下没点出去（${act.msg || `坐标 ${x},${y}`}）` };
      const w = await this.adb.waitChange(before, { timeout: 2.0, screen: scr, app: obs.app?.package || '' });
      return { changed: w.changed, tree: w.tree };
    }
    if (verb === 'swipe') {
      const dir = /up|down|left|right/i.test(arg) ? arg.toLowerCase() : 'up';
      // ★ 2026-10-31：横屏时要用**这一屏的真实画幅**，否则 up 的起点会落在屏幕外（划不动）
      const r = await this.adb.swipeDir(dir, { screen: obs.screen });
      if (!r.ok) return { changed: false, note: `手划不动（${r.msg || 'adb 没反应'}）` };
      /**
       * ★ 2026-11-01 修：**必须把 `screen` 传下去**。
       * `waitChange` 里用 `buildTable(xml, {screen})` 算 hash，而 `before` 是
       * `observe()` **带着 screen** 算出来的 —— 不传就是拿"筛过屏外节点"的基线
       * 和"没筛"的新 hash 比，只要列表里有屏外控件就必然不等：
       * 实测 51 ms 就返回 `changed:true`，根本没等界面动。后果有两层：
       * `tried` 里写下"滑动生效了"、`remember()` 把没生效的招式记成成功；
       * 而下一步 `judge()` 看到同一屏又判"没进展" → stall → back（她被从列表页退出去）。
       */
      const w = await this.adb.waitChange(before, { timeout: 1.5, screen: obs.screen, app: obs.app?.package || '' });
      return { changed: w.changed, tree: w.tree };
    }
    if (verb === 'key') {
      const r = await this.adb.key(arg);
      if (!r.ok) return { changed: false, note: `这个键按不动（${arg}：${r.msg || 'adb 没反应'}）` };
      if (['back', 'home'].includes(arg)) {
        /** ★ 2026-11-01：同上，`screen` 不传 = "变没变"恒为真。 */
        const w = await this.adb.waitChange(before, { timeout: 1.5, screen: obs.screen, app: obs.app?.package || '' });
        return { changed: w.changed, tree: w.tree };
      }
      return { changed: null, noStall: true, note: `按了 ${arg}` };
    }
    if (verb === 'launch') {
      /**
       * ★ 2026-11-12（P0，第二处接线）：模型自己写 `launch 菜谱` 时同样有兜底。
       * 失败语义和 `doQuick` 一致：`not-found` 就写 `task.fatalOpen`，**下一次循环开头立刻收**
       * （"重开当前 App / 回桌面 / back×2" 对一个"不存在的 App"毫无意义，只会烧完 20 步）。
       */
      const r = await this.openApp(arg, { task, obs });
      if (r.ok) {
        task.openedPkg = r.pkg || '';
        return {
          changed: true,
          last: r.pkg || '',
          note: `打开了「${r.label || arg}」${r.how ? `（${r.how}）` : ''}`,
        };
      }
      if (r.reason === 'not-found') {
        task.fatalOpen = { label: r.label || arg, why: 'not-found' };
        return { changed: false, note: `打不开「${arg}」：手机上没找到它（桌面、抽屉、截图都看过了）` };
      }
      return {
        changed: false,
        note: r.reason === 'stopped' ? '他说停了' : `打不开「${arg}」：${r.reason || '没开成'}（再看看这一屏换条路）`,
      };
    }
    /**
     * ★ 2026-11-08：`restart 浏览器` = **真的关掉再冷启动**（不是"回到原来那一页"）。
     * 卡在验证码页 / 广告页 / 转不动的页时，这是唯一能"重来一次"的动作。
     */
    if (verb === 'restart') {
      const app = String(arg || '').trim() || '浏览器';
      let killed = false;
      if (typeof this.adb.forceStop === 'function') {
        const k = await this.adb.forceStop(app);
        killed = !!(k && k.ok);
        if (!killed) log.warn(`手机：想关掉「${app}」没关成（${(k && k.msg) || '?'}）`);
      }
      await sleep(450);
      const r = await this.adb.launch(app);
      if (!r || !r.ok) return { changed: false, note: `「${app}」关掉了但没打开（${(r && r.msg) || '?'}）` };
      await sleep(900);
      const o = await this.perceive(task);
      const where = o && o.ok ? (o.app?.name || o.app?.package || '') : '';
      return {
        changed: true,
        obs: o && o.ok ? o : null,
        note: `把「${app}」${killed ? '关掉重开' : '重开'}了${where ? `，现在在「${where}」` : ''}`,
      };
    }
    if (verb === 'text') {
      const r = await this.adb.text(arg);
      if (!r.ok) return { changed: false, noStall: true, note: `字没打进去（${r.msg || '输入法没反应'}）` };
      /**
       * ★ 2026-11-08（R-B）：**打完字要核一次**。
       *
       * 真机 22:02–22:04：`text 小猫` → `key enter` 连着做了三遍，谁也不知道字到底进没进
       * （`episodes` 里只有三次 `text`）。这里在 1.5 秒内看屏上有没有这几个字：
       * 有就说"打进去了"，没有就**如实说"没看到这几个字"**（可能是输入框没点中 / 输入法没弹）。
       * ⚠️ 只改 `note`、不改成败：屏上读不到字不一定等于没打进去（自绘输入框），
       *    不能因为核对不上就把一件正在做的事判死。
       */
      const needle = String(arg || '').trim().slice(0, 12);
      let seen = false;
      if (needle) {
        for (let i = 0; i < 2 && !seen; i++) {
          await sleep(450);
          try {
            const o = await this.adb.observe({ shot: false });
            if (!o || !o.ok) continue;
            const blob = `${o.table || ''} ${(o.nodes || []).map((n) => n.text || '').join(' ')}`;
            if (blob.includes(needle)) seen = true;
          } catch { break; }
        }
      }
      return {
        changed: null,
        noStall: true,
        note: !needle
          ? '打了字'
          : (seen
            ? `打进去了「${needle}」，该按 key enter 就到那一页了`
            : `打完了，但屏上没看到「${needle}」—— 可能没进输入框（先 tap 那个输入框再 text，或者用 taptext）`),
      };
    }
    if (verb === 'wait') {
      await sleep(1200);
      return { changed: null, noStall: true };
    }
    if (verb === 'shot') {
      const s = await this.adb.screenshot({ save: this.shotsDir });
      if (s.ok) {
        task.shot = { file: s.file, bytes: s.bytes, hash: s.hash };
        this.emit({ kind: 'shot', id: task.id, file: s.file, at: Date.now() });
        // ★ 10-31：截到了就收工（截图类目标不该截完再去乱点，图会丢在半路）
        return { changed: null, doneShot: true };
      }
      return { changed: false };
    }
    return { changed: false };
  }

  /**
   * ★ 2026-10-31：`done` 要过断言。
   * 旧版模型说"做完了"就算做完 —— 公开审计里 agent 自报有 ~39% 是错的，这里也一样
   * （"点进去再返回主页"0 步就报成功）。现在的规矩：
   *   ⓪ 截图类目标：**没真截到就别说完事**（10-31 上午她说"发出去了"，其实一张也没截）；
   *   ① 目标里没有可核对的东西（"看看现在在哪个页面"）→ 说完就算完，别硬要她动手；
   *   ② 有具体东西（相册/设置/照片…）时，一步没做不许说完工；
   *   ③ 而且这一屏得真能看见它；"主页/桌面"这类词的正确答案就是**桌面本身**（旧版把
   *      `返回主页看看` 判成"桌面里看不到主页"，把她真的回到桌面记成失败）。
   */
  verifyDone(task, obs, arg) {
    if (SHOT_GOAL.test(task.goal) && !task.shot) {
      return { ok: false, why: '我还没截到图，不能说发出去了' };
    }
    /**
     * ★ 2026-11-12：**"打开 App"这件事已经验过了。**
     *
     * `openApp` 只有在**前台包名真的变成目标包**之后才写 `task.openedPkg`（`adb.launch` 的 ok 不算）。
     * 所以只要这会儿还停在那个 App 里，"打开 X"这件事就是做完了，不该再被
     * `WANTS_ACTION` 里那个"打开"打回（打回之后她会回去瞎点，20 步就是这么烧掉的）。
     */
    if (task.openedPkg) {
      const cur = String((obs && obs.app && obs.app.package) || '');
      if (cur && cur === task.openedPkg) return { ok: true };
    }
    /**
     * ★ 2026-11-07：**"看看讲了什么 / 读一下"必须先真的读到**。
     * 否则她会 0 步就 done "看完了"（20:47 那次就是正文还没读就判完成，回头又去点）。
     * 只卡这一类"读内容"的目标；"看看相册里有什么"这种靠看图说清的仍走老规矩。
     */
    if (/(讲了什么|讲了啥|读一下|读一读|读了什么|说说.*内容)/.test(`${task.goal || ''} ${task.root || ''}`)
      && !task.readDigest && (Number(task.steps.length) || 0) >= 1) {
      return { ok: false, why: '我还没真的读到内容，不能说看完了' };
    }
    const saidText = String(arg || '').trim();
    const goalText = `${task.goal || ''} ${task.root || ''}`;
    /**
     * ★ 2026-11-07：**"读到了"和"看到了"本身就是完成**（不再要求屏上出现目标名词）。
     *
     * 真机 20:47：目标「搜一下今天的新闻，挑一条点开看看讲了什么」—— 她真的点开了一篇
     * 北京暴雪的新闻、正文也读到了，可 `verifyDone()` 还在找「新闻」两个字，
     * 于是 `done` 被打回、她又回去重新搜，20 步全耗在这一页上。
     * 这类"看看/讲讲/说清"的目标，判据是**她读到了内容**，不是标题里恰好有那个词。
     */
    if (saidText.length >= 4) {
      if (task.readDigest && /(讲|读|内容|看看|什么|说清|念)/.test(goalText) && (Number(task.steps.length) || 0) >= 2) {
        return { ok: true };
      }
      if (task.savedImage) return { ok: true };
      /** 纯"搜一下 X"：搜索页出来、她也动手看过，就算搜到了（要不要点开是另一件事）。 */
      if (task.searchWord && /^(?:搜|搜索|查|找)/.test(String(task.goal || ''))
        && !/(点开|看看|读|挑|内容|讲)/.test(String(task.goal || ''))) {
        return { ok: true };
      }
    }
    const nouns = goalNouns(task.goal);
    /**
     * ★ 一步没做也允许收工的唯一情况：**纯看一眼**（"看看现在在哪个页面"）。
     * 只要目标里有动作词（点/滑/搜/打/发…）或者有可核对的东西，就仍然不许空手说完工。
     *
     * ★ 2026-10-31（真机）：**"要看的东西本来就已经在这一屏上"也算看了**。
     *
     * 会话里的 App / 网页是**代码先开好的**（`phone-life.preOpen`），所以第一屏就是目标那一屏。
     * 真机上她明明看清了那张照片（"蓝发蓝眼的Q版小女仆…"），却因为"0 步"被打回、白烧 4 次模型
     * （相册那件：5 次模型里 1 次是这句冤枉话）。所以补一条：东西已经在屏上、
     * 而且她**说清了看到什么**（≥8 字，不许"done 好了"糊弄），就认。
     */
    if (!task.steps.length) {
      const onHome0 = LAUNCHER_PKG.test(obs?.app?.package || '');
      const blob0 = `${obs?.app?.name || ''} ${obs?.app?.package || ''} ${obs?.table || ''}`;
      const already = nouns.length && !onHome0 && screenHasGoal(blob0, nouns, { onHome: onHome0 });
      const said = String(arg || '').trim();
      if (already && said.length >= 8) return { ok: true };
      if (nouns.length || WANTS_ACTION.test(task.goal)) return { ok: false, why: '我还没动手，不能说弄完了' };
      return { ok: true };
    }
    if (!nouns.length) return { ok: true };
    const onHome = LAUNCHER_PKG.test(obs?.app?.package || '');
    if (onHome && nouns.some((n) => HOME_NOUNS.includes(n))) return { ok: true };
    const blob = `${obs?.app?.name || ''} ${obs?.app?.package || ''} ${obs?.table || ''}`;
    if (screenHasGoal(blob, nouns, { onHome })) return { ok: true };
    return { ok: false, why: `你说弄完了，可这一屏（${obs?.app?.name || '?'}）里看不到「${nouns[0]}」` };
  }

  /**
   * ★ 2026-10-31（第二轮）：搜东西 —— **用 intent 直接到结果页**，然后验"屏上有没有这个词"。
   * 没词就自己挑一个；给了词就得在屏上真看见它，看不见就是没搜出来（如实失败）。
   */
  async quickSearch(task, quick = {}) {
    const t0 = Date.now();
    const given = String(quick.keyword || '').trim();
    const kw = given || this.pickKeyword(task);
    /**
     * ★ 2026-11-06 21:40（用户实测）：「我是想她学会浏览，**不是一进来就默认图片页面**」。
     *
     * 上一版的启发式（关键词里带"图/顺眼/表情包"就直接开图片页）把"浏览"这条路堵死了：
     * 21:25 / 21:27 两条都是 **0 步 / 9 秒 / 0 次模型**"完成"，她只看得见"八张图"，
     * 然后自己补一句"没一张挑得动" —— 结果页、网页、点进去看，一次都没走过。
     * 现在：搜索**一律** `bing.com/search`；真想看图，她自己写 `images 词`（见 execute）。
     */
    const url = `https://cn.bing.com/search?q=${encodeURIComponent(kw)}`;
    const before = await this.perceiveQuiet();
    const r = await this.adb.openUrl(url);
    if (!r.ok) return { ok: false, summary: `浏览器没打开搜索页（${r.msg || '?'}）` };

    let after = null;
    let seen = false;
    for (let i = 0; i < 4; i++) {
      if (this.searchPollMs > 0) await sleep(this.searchPollMs);
      after = await this.perceiveQuiet();
      if (!after || !after.ok) continue;
      /**
       * ★ 2026-11-08（真机 23:05–23:11）：**被滑块验证拦住时，搜索根本不会出来**。
       *
       * 这一趟她搜"深圳明天天气"，屏上是"拖动滑块完成验证"：她拖了三次没到 →
       * 两次任务共 227 秒、24 次模型、一个天气字也没看到。
       * 所以这里第一眼先认验证墙：**试一次**拖到底（轨道按形状找，不猜坐标），
       * 不行就 `openurl` 换百度（同一个词），还是不行就**如实失败**（别让主循环接着磨）。
       */
      const cap = captchaOf(after);
      if (cap) {
        if (!task.captchaTried) {
          task.captchaTried = 1;
          const did = await slideCaptcha(this.adb, after, after.screen);
          log.info(`手机：搜索页是验证墙（${cap}），${did || '没找到滑块'}，再等一下`);
          await sleep(1200);
          after = await this.perceiveQuiet();
          if (after && after.ok && !captchaOf(after)) continue;
        }
        if (!task.captchaEngine) {
          task.captchaEngine = 1;
          const alt = otherEngineUrl(kw);
          log.info(`手机：验证墙没过去，换百度再搜「${kw}」`);
          await this.adb.openUrl(alt);
          await sleep(1200);
          after = await this.perceiveQuiet();
          if (after && after.ok && !captchaOf(after)) continue;
        }
        return {
          ok: false,
          summary: `浏览器被"${cap}"拦住了，拖滑块过不去（跟搜什么没关系）；换搜索引擎也被拦，这一趟就算了`,
        };
      }
      const blob = `${after.app?.name || ''} ${after.table || ''}`;
      /**
       * ★ 2026-11-06（P0）：**"屏没变"不算搜到**。
       *
       * 旧判据只有"屏上有这个词"，而搜索框 / 页标题本来就带这个词 ——
       * 白屏、没加载、点了没反应，全都能通过（这就是 0 步"完成"的另一半）。
       * 现在多一条硬条件：这一屏必须真的换了（`hash` 变了）。
       */
      const changed = !!(before && before.ok && after.hash !== before.hash);
      if (given) {
        if (changed && blob.includes(kw)) { seen = true; break; }
      } else if (changed) {
        seen = true;
        break;
      }
    }
    const where = after?.app?.name || '浏览器';
    if (!seen) {
      return {
        ok: false,
        summary: given
          ? `开了搜索页，可屏上没看到「${kw}」，估计没搜出来`
          : '开了搜索页，但画面一直没变，估计没搜出去',
      };
    }
    task.searchWord = kw;
    /**
     * ★ 2026-11-08（R-C1）：**搜完把"这一页有哪几条、网址是什么"取回来**（PC 侧 0 张截图）。
     *
     * 手机上那个浏览器拿不到 DOM，无障碍树只有标题碎片 + 一行域名 ——
     * 于是她既说不出"去哪儿找网址"（他 22:06 问的就是这个），也点不准第 N 条。
     * `her-web.searchResults()` 在 PC 上按移动 UA 抓同一页，拿回**确定的标题 + 网址**：
     *   · 下一步 prompt 直接告诉她这几条各是哪个网站；
     *   · `open N` 能直接 `openurl 那条网址`（比自己点坐标可靠得多）。
     * 抓不到就算了（`resultItems` 留空，退回"看这一屏"），不假装知道。
     */
    try {
      if (this.web && typeof this.web.searchResults === 'function') {
        const got = await this.web.searchResults(kw, { n: 8 });
        if (got && got.ok && got.items.length) {
          task.resultItems = got.items;
          log.info(`手机：结果页取回 ${got.items.length} 条（${got.items[0].site || got.items[0].url} …）`);
        }
      }
    } catch (err) {
      log.warn(`手机：结果列表没取回来（${err.message}）`);
    }
    task.steps.push({ step: 0, action: `search ${kw}`, changed: true, ms: Date.now() - t0 });
    task.lastRead = `搜索页已经打开了（这一页）：\n${surface.digest(after)}`;
    if (Array.isArray(task.resultItems) && task.resultItems.length) {
      task.lastRead = `搜索「${kw}」的结果页，这一页上的条目：\n${this.resultLines(true, task)}`;
    }
    /**
     * ★ 2026-11-08（R-C1）：**搜完的下一步写死"点开一条"**。
     *
     * 真机 22:05：搜到了小肥鱼表情包的结果页，接着她选 `images` → `save ×4`，
     * 一次 `open` 都没做（那他让她搜网页这件事就等于没做）。
     * 这一句是**给她下一步看的**（`【下一步】`），不是替她执行。
     */
    task.hintNext = Array.isArray(task.resultItems) && task.resultItems.length
      ? '刚搜完，这一屏是**结果列表**（每一条 = 一个网址）。下一步：`open 1` 进第一条那个网站看看；'
        + '想看第几条就 `open 第几`。**只有他说要看图**才 `images 词`。'
      : '刚搜完，这一屏是**结果列表**（每一条 = 一个网址）。下一步：`open 1` 进第一条看看；'
        + '`read` 可以先把有哪几条念一遍。**别一上来就找图**。';
    /** ★ 2026-11-07：搜索完的"当前屏"记下来（回灌/问屏要的是结果页，不是旧页）。 */
    this.noteScreen(after);
    log.info(`手机：搜索「${kw}」打开了结果页，交给她自己看`);
    return null;
  }

  /** 结果页那几条排成一行人话（`withUrl` 时带上网址）。 */
  resultLines(withUrl = false, task = null) {
    const t = task || this.task || {};
    const list = t.resultItems || [];
    if (!list.length) return '';
    return list.slice(0, 8).map((x) => {
      const site = x.site ? `（${x.site}）` : '';
      return `${x.i}. ${x.title}${site}${withUrl ? `\n   网址 ${x.url}` : ''}`;
    }).join('\n');
  }

  /**
   * ★ 2026-11-06（P2）：**搜到图之后，让她自己挑一张**。
   *
   * 手机上那个浏览器拿不到 DOM（Via 的调试是关的、Edge 是 arm64 包在这台 x86_64 上一启动就崩），
   * 所以"看起来顺眼的图"在她那儿只可能是**像素**；而"挑一张存进收藏夹"需要**原图地址**。
   * 这里的分工是：PC 侧把同一页的候选取回来（标题 + 原图 URL，0 张截图），
   * **由她挑**（一次 16 token 的调用，只回 `save 3` 或 `算了`），挑中了才下载。
   *
   * 返回 `null` = 这一层没参与（拿不到候选），上层保持"页面出来了，还没挑"那句诚实的摘要。
   */
  /**
   * ★ 2026-11-06 21:40：**看图是她自己选的，不是系统的默认动作。**
   *
   * `images 词` → 打开图片页 + 把候选（标题 + 原图地址）读给她；
   * 她看完再决定 `save 3`。这样"看图"和"浏览"是两件事，她可以选。
   */
  async imagesSearch(task, word) {
    /**
     * ★ 2026-11-08（R-C1）：他没要图 → 不许切图片页（"顺手"不能顶掉正事）。
     * 他自己的活（`chat`）才卡这一条；她自己想玩的（`session`/`roam`）随便。
     * ⚠️ 判据是**"要看图"这件事**，不是词里带"图"：
     *    「搜小肥鱼表情包」里的"表情包"是**搜索词**，不是说他要看图 ——
     *    真机 22:05 那一趟的目标就是这个，她照样去切了图片页、存了四张。
     */
    const wantsPic = /(图片|照片|壁纸|封面|头像|相册|看图|找图|存图|截图)/.test(`${task.goal || ''} ${task.root || ''}`);
    if (task.src === 'chat' && !wantsPic) {
      return {
        changed: false,
        noStall: true,
        note: '他没让你找图，这一屏是结果页：`open 1` 进第一条那个网址看看（要图得他说了才算）',
      };
    }
    const kw = String(word || task.searchWord || '').trim();
    if (!kw) return { changed: false, noStall: true, note: 'images 后面要跟一个词（或者先搜一次）' };
    const web = this.web;
    if (!web || typeof web.searchImages !== 'function') {
      return { changed: false, noStall: true, note: '现在拿不到图片候选，只能自己看这一屏' };
    }
    const r = await this.adb.openUrl(`https://cn.bing.com/images/search?q=${encodeURIComponent(kw)}`);
    if (!r.ok) return { changed: false, note: `图片页没打开（${r.msg || '?'}）` };
    await sleep(900);
    let got = null;
    try { got = await web.searchImages(kw, { n: 8 }); } catch (err) { got = { ok: false, error: String(err.message || err) }; }
    if (!got || !got.ok || !got.items.length) {
      return { changed: true, noStall: true, note: `图片页打开了，但没拿到候选（${(got && got.error) || '空'}）` };
    }
    task.imageCandidates = got.items;
    task.searchWord = kw;
    const lines = got.items.map((it) => `${it.i}. ${it.title || '（没标题）'}`).join('\n');
    task.lastRead = `图片页打开了，「${kw}」这些图（要哪张就写 save 序号）：\n${lines}`;
    return { changed: true, noStall: true, note: `开了图片页，候选 ${got.items.length} 张` };
  }

  /**
   * ★ 2026-11-08：**"手机上的第 N 条"和 PC 抓回来的第 N 条，是不是同一条？**
   *
   * 用网址确认（`openurl` 之前必须过这一关，否则可能打开错的网站）：
   *   · 手机上认出了域名 → 和 PC 那条的域名比对（互为子串即可，`www.` / 路径不参与）；
   *   · 手机上只有标题 → 标题前 6 个字相同，或互相包含；
   *   · **手机上一条都没认出来**（无障碍树经常这样）→ 只有在**这一趟刚搜过**
   *     （`task.searchWord`）时才认，因为那就是同一页；否则不认，老老实实点屏幕。
   */
  sameResult(onPhone, known, task = null) {
    if (!known) return false;
    if (!onPhone) return !!(task || this.task || {}).searchWord;
    const norm = (s) => String(s || '').replace(/[\s\u200b·、，,。.…\-—_|（）()【】\[\]"'“”‘’:：]+/g, '').toLowerCase();
    const host = (u) => String(u || '').toLowerCase().replace(/^https?:\/\//, '').split(/[/?#]/)[0].replace(/^www\./, '');
    const a = host(known.site || known.url);
    const b = host(onPhone.url);
    if (a && b && (a === b || a.includes(b) || b.includes(a))) return true;
    const t1 = norm(onPhone.title);
    const t2 = norm(known.title);
    if (t1.length >= 4 && t2.length >= 4) {
      if (t1.slice(0, 6) === t2.slice(0, 6)) return true;
      if (t1.includes(t2.slice(0, 8)) || t2.includes(t1.slice(0, 8))) return true;
    }
    return false;
  }

  /** `save 3`：把第 3 张存进她的收藏夹（真下载，0 张截图）。 */
  async savePicked(task, arg) {
    const m = /\d{1,2}/.exec(String(arg || ''));
    const n = m ? Number(m[0]) : 0;
    const list = task.imageCandidates || [];
    if (!list.length) return { changed: false, noStall: true, note: '还没有图可选：先 images 一个词' };
    if (!n || !list[n - 1]) return { changed: false, noStall: true, note: `没有第 ${n || '?'} 张（只有 ${list.length} 张）` };
    /**
     * ★ 2026-11-08（P2）：**同一趟里重复 `save` 要去重**。
     *
     * 真机 22:05：`save 1 · save 1 · save 5 · save 5` —— 四次点击、摘要却说"存了两张"。
     * 第二次点同一张时如实说"这张已经存过了"，别再下一次。
     */
    const saved = task.savedImages || (task.savedImages = new Set());
    if (saved.has(n)) {
      return {
        changed: false,
        noStall: true,
        note: `第 ${n} 张刚才已经存过了（这一趟存了 ${saved.size} 张）；要别的就 save 另一个序号`,
      };
    }
    const t = list[n - 1];
    const web = this.web;
    const dir = path.join(this.dir, '..', 'stickers', 'collected');
    const s = (web && typeof web.saveImage === 'function')
      ? await web.saveImage(t.murl, { dir, name: (t.title || '图').slice(0, 12) })
      : { ok: false, error: '没有下载能力' };
    if (!s || !s.ok) return { changed: false, noStall: true, note: `第 ${n} 张没存下来（${(s && s.error) || '?'}）` };
    saved.add(n);
    task.savedImage = s.file;
    task.steps.push({ step: Number(task.step) || 0, action: `save ${n}`, changed: true, ms: 0 });
    return {
      changed: false,
      noStall: true,
      note: `存了第 ${n} 张《${t.title || '没标题'}》进收藏夹（这一趟一共存了 ${saved.size} 张）`,
    };
  }

  /** 只要 hash 的观察（不发图、不算进 visionSeen），省时间。 */
  async perceiveQuiet() {
    try {
      return await this.adb.observe({ shot: false });
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  /** 自己挑一个词（她爱看猫、爱听人说话；别每次都挑同一个）。 */
  pickKeyword(task) {
    const pool = ['猫', '小肥鱼', '表情包', '今天天气', '冷笑话'];
    /**
     * ★ 2026-11-01：**同一秒里排两件也不会挑到同一个词**。
     * 原来种子只到秒（`Math.floor(startedAt / 1000) % pool.length`）：一秒内排两件搜东西
     * 必然挑同一个词（实测连着两次搜「猫」）。现在毫秒也拌进去，
     * 再用一个自增序号兜住"同一毫秒"这种极端情况。
     */
    const t = Math.abs(Number(task.startedAt) || Date.now());
    this.pickSeq = (Number(this.pickSeq) || 0) + 1;
    const seed = Math.floor(t / 1000) + Math.floor((t % 1000) / 250) * 3 + this.pickSeq * 7;
    let k = pool[seed % pool.length];
    if (k === this.lastSearch) k = pool[(seed + 1) % pool.length];
    this.lastSearch = k;
    return k;
  }

  /** 一句话能做完的事。返回 `{ok, summary, shot}` 表示做完了；null 表示继续走循环。 */
  async doQuick(quick, task) {
    if (quick.kind === 'seq') {
      // "先返回再回主页"这种：一段一段做，全成才算成（任一段失败就如实说第几步没成）
      const said = [];
      for (const p of quick.parts) {
        const r = await this.doQuick(p, task);
        if (!r) return null;
        said.push(r.summary);
        if (!r.ok) return { ok: false, summary: `第 ${said.length} 步没成：${r.summary}` };
      }
      return { ok: true, summary: said.join('；') };
    }
    if (quick.kind === 'shot') {
      const st = await this.adb.state();
      const s = await this.adb.screenshot({ save: this.shotsDir });
      // ★ 层 0：黑图/小图现在算"没截到"（不再把一张纯黑图当截图发出去）
      if (!s.ok) return { ok: false, summary: s.tooSmall ? '这一屏截出来是黑的/白的，没截到' : '截不出来' };
      task.shot = { file: s.file, bytes: s.bytes, hash: s.hash };
      this.emit({ kind: 'shot', id: task.id, file: s.file, at: Date.now() });
      return {
        ok: true,
        summary: `手机现在停在「${st.app?.name || '桌面'}」，我截了一张（图跟着这句话发过去）`,
        shot: task.shot,
        verb: '截了张图',
      };
    }
    if (quick.kind === 'home') {
      const before = (await this.adb.state()).app?.package || '';
      await this.adb.key('home');
      const after = (await this.adb.state()).app?.package || '';
      // 回桌面也要验：回没回去，别 0 步就报"回桌面了"
      const ok = LAUNCHER_PKG.test(after);
      this.last = { app: ok ? '桌面' : (after || this.last.app), pkg: after || '', at: Date.now() };
      this.setLastScreen(ok ? '桌面（home 键）' : `按了 home，还停在「${after || '?'}」`);
      return { ok, summary: ok ? '回桌面了' : `按了回桌面，但还停在「${after || '?'}」` };
    }
    if (quick.kind === 'back') {
      await this.adb.key('back');
      const st = await this.adb.state();
      const where = st?.app?.name || st?.app?.package || '';
      this.last = { app: where || this.last.app, pkg: st?.app?.package || '', at: Date.now() };
      this.setLastScreen(where ? `退了一步，现在在「${where}」` : '退了一步');
      return { ok: true, summary: where ? `退了一步，现在在「${where}」` : '退了一步' };
    }
    /**
     * ★ 2026-11-07：一步滚动 / 读一页 —— 都是确定动作，0 次模型。
     * 以前"往下翻"会进主循环，先 dump、再问模型，模型有时挑 `swipe`（另一套语义）、
     * 有时挑 `done`；而它本来只是一下手势。
     */
    if (quick.kind === 'scroll') {
      const obs = await this.perceive(task);
      if (!obs || !obs.ok) return { ok: false, summary: `手机连不上：${obs?.error || '看不到屏幕'}` };
      /**
       * ★ 2026-11-08：**在桌面上"往下翻"没得翻** —— 如实说清，别让她以为手势坏了。
       * 真机 23:40:28 / 23:40:39：「想往下翻，但屏幕一动没动（可能已经到底了）」，
       * 而那一屏其实是**桌面**（当时「返回首页」刚执行完，把上下文弄丢了）。
       */
      if (LAUNCHER_PKG.test(obs.app?.package || '')) {
        return {
          ok: false,
          summary: '现在人还在桌面上，这一屏没东西可翻 —— 得先打开点什么（相册/浏览器）才谈得上翻',
        };
      }
      const r = await this.scan(task, obs, { dir: quick.dir || 'down', maxScreens: quick.screens || 1 });
      if (r.found) { task.stopNote = r.why; task.lastStop = r.why; }
      task.steps.push({ step: 1, action: `scroll ${quick.dir || 'down'} 1`, changed: r.screens > 0, ms: 0 });
      return {
        ok: true,
        changed: r.screens > 0,
        summary: this.scrollSummary(quick.dir || 'down', r),
        verb: quick.dir === 'up' ? '往上翻了一屏' : '往下翻了一屏',
      };
    }
    /**
     * ★ 2026-11-08：**点屏上带某字的那个东西**（0 次模型）。
     * 他说「你点网页」，这件事就是字面意思，不该花一次模型调用去猜 `n7` 是哪个。
     * 屏上没有这个字 → 返回 `null`，交给主循环自己找入口（新屏可能还没加载出来）。
     */
    if (quick.kind === 'taptext') {
      const obs = await this.perceive(task);
      if (!obs || !obs.ok) return { ok: false, summary: `手机连不上：${obs?.error || '看不到屏幕'}` };
      const needle = String(quick.needle || '').trim();
      const has = (obs.nodes || []).some((n) => `${n.text || ''} ${n.desc || ''}`.includes(needle));
      if (!has) {
        /**
         * ★ 2026-11-08 夜：**点不到也要留一句，别让她接着瞎逛**。
         * 真机 23:14 她写 `[手机:taptext 视频]`，那一屏是应用商店探索页、根本没有"视频"两个字 ——
         * 这里只 `return null`，主循环里谁都不知道"那个字不在屏上"，于是她又逛了 16 步 / 80 秒。
         */
        task.tried = Array.isArray(task.tried) ? task.tried : [];
        task.tried.push(`taptext ${needle}→这一屏没有「${needle}」，点不到`);
        if (task.tried.length > 6) task.tried = task.tried.slice(-6);
        return null;
      }
      task.steps.push({ step: 1, action: `taptext ${needle}`, changed: true, ms: 0 });
      const r = await this.execute({ verb: 'taptext', arg: needle, line: `taptext ${needle}` }, obs, task);
      if (!r || r.finish) return null;
      const after = r.obs || (await this.perceiveFrom(r.tree, obs, task)) || await this.perceive(task);
      const where = after?.app?.name || after?.app?.package || '';
      const isTab = surface.NAV_WORD.test(needle);
      return {
        ok: !!r.changed,
        changed: !!r.changed,
        summary: isTab
          ? `点了顶上那排里的「${needle}」（那排是切换搜索类型，**还是同一页搜索结果，没有打开任何网站**）`
          : (r.changed
            ? `点了「${needle}」${where ? `，现在在「${where}」` : ''}`
            : `按了「${needle}」，但屏幕没动（可能没中）`),
        verb: isTab ? `切到「${needle}」这一栏` : `点了「${needle}」`,
      };
    }
    /**
     * ★ 2026-11-08：**打开第 N 条搜索结果**（那一条 = 一个网址）。
     * 结果页上"第 1 条"以前是顶上那排页签的「网页」，所以这条以前永远打不开网站。
     */
    if (quick.kind === 'open') {
      const obs = await this.perceive(task);
      if (!obs || !obs.ok) return { ok: false, summary: `手机连不上：${obs?.error || '看不到屏幕'}` };
      const n = Number(quick.n) || 1;
      task.steps.push({ step: 1, action: `open ${n}`, changed: true, ms: 0 });
      const r = await this.execute({ verb: 'open', arg: String(n), line: `open ${n}` }, obs, task);
      if (!r || r.finish) return null;
      const after = r.obs || (await this.perceiveFrom(r.tree, obs, task)) || await this.perceive(task);
      const where = after?.app?.name || after?.app?.package || '';
      return {
        ok: !!r.changed,
        changed: !!r.changed,
        summary: r.note || (r.changed ? `打开了第 ${n} 条` : `第 ${n} 条没打开`),
        verb: r.changed ? `打开了第 ${n} 条` : '没能打开',
      };
    }
    if (quick.kind === 'read') {
      const obs = await this.perceive(task);
      if (!obs || !obs.ok) return { ok: false, summary: `手机连不上：${obs?.error || '看不到屏幕'}` };
      const d = surface.digest(obs);
      task.steps.push({ step: 1, action: 'read', changed: null, ms: 0 });
      return { ok: true, summary: `这一屏读到：${d}`, verb: '读了这一页' };
    }
    if (quick.kind === 'search') return this.quickSearch(task, quick);
    /**
     * ★ 2026-11-08（R-B）：**「点搜索框」= 缺一个词**，不是一步操作。
     *
     * 以前它落到主循环，20 步 / 119 秒全耗在输入框上（`tap n0 → text 小猫 → key enter` ×3）。
     * 现在直接回一句"要搜什么得说清一个词"，让上层知道这件事**缺输入**，而不是"她不会点"。
     * 返回 `ok:false` 但 `asked:true`：这是"需要他说清"，不是失败，也不算她做完了。
     */
    /** ★ 2026-11-08 夜：整台手机（模拟器）她重启不了 —— 如实说，别装。 */
    if (quick.kind === 'restartPhone') {
      return { ok: false, summary: `整台手机（模拟器）我重启不了，只能重开里面的软件（比如"重启浏览器"）` };
    }
    if (quick.kind === 'needKeyword') {
      return {
        ok: false,
        asked: true,
        summary: '这一屏要搜什么得说清一个词（`搜 小肥鱼`），只点输入框是搜不出来的',
      };
    }
    if (quick.kind === 'launch') {
      /**
       * ★ 2026-11-12（P0，最关键的一处接线）：**不再直接 `adb.launch`。**
       *
       * 旧版这里是一道硬短路：`adb.launch(名字)` 失败就 `return {ok:false, summary:'打不开…'}`，
       * 而 `runOnce()` 拿到非 null 就收工 —— **一次模型都没问，一次屏幕都没看**。
       * 真机「打开菜谱看看」「打开B站」都是 1 秒硬失败，就是因为这条。
       * 现在交给 `openApp()`：缓存 → 别名 → 看屏上的字点 → 截图问坐标 → 验前台包名。
       */
      const r = await this.openApp(quick.app, { task });
      if (!r.ok) {
        if (r.reason === 'stopped') return { ok: false, stopped: true, summary: '停了' };
        if (r.reason === 'not-found') {
          /** 四路都找过了：**如实说没找到，不再烧 20 步**（回到 `recover()` 毫无意义）。 */
          task.fatalOpen = { label: r.label || quick.app, why: 'not-found' };
          return { ok: false, summary: `打不开「${quick.app}」：手机上没找到它（桌面、抽屉、截图都看过了）` };
        }
        /** adb 抖了 / 名字认不出（"那个蓝色的图标"）→ 交还主循环，别假装开了。 */
        return null;
      }
      const appLabel = r.label || quick.app;
      task.openedPkg = r.pkg || '';
      task.steps.push({
        step: (Number(task.step) || 0) + 1, action: `launch ${appLabel}`, changed: true, ms: r.ms || 0,
      });
      this.last = { app: appLabel, pkg: r.pkg || this.last.pkg, at: Date.now() };
      this.setLastScreen(`刚打开了「${appLabel}」${r.how ? `（${r.how}）` : ''}`);
      /**
       * ★ 2026-11-12：**"打开菜谱看看"不能开完就收工** —— 那等于一眼没看
       * （真机 `episodes` 里「打开日记本看看」是 `steps:[]` / 570ms）。
       * 有"看/读/搜/挑"这类尾巴就把屏幕交回主循环，她会自己读一屏再说。
       */
      if (OPEN_AND_LOOK.test(String(task.goal || ''))) return null;
      return { ok: true, summary: `打开了「${appLabel}」`, verb: `打开了${appLabel}` };
    }
    /**
     * ★ 2026-11-08（用户：「她还不会重启软件（关了再打开）」）：**一句话就能重启**，0 次模型。
     */
    if (quick.kind === 'restart') {
      const app = quick.app || '浏览器';
      let killed = false;
      if (typeof this.adb.forceStop === 'function') {
        const k = await this.adb.forceStop(app);
        killed = !!(k && k.ok);
      }
      await sleep(450);
      const r = await this.adb.launch(app);
      if (!r || !r.ok) return { ok: false, summary: `「${app}」关掉了，可是没打开（${(r && r.msg) || '?'}）` };
      await sleep(1000);
      const st = await this.adb.state();
      const where = st?.app?.name || '';
      this.last = { app: where || app, pkg: st?.app?.package || '', at: Date.now() };
      this.setLastScreen(`刚把「${app}」${killed ? '关掉重开' : '重开'}了`);
      task.steps.push({ step: 1, action: `restart ${app}`, changed: true, ms: 0 });
      return {
        ok: true,
        summary: `把「${app}」${killed ? '关掉重开了' : '重开了'}${where ? `，现在是「${where}」的首页` : ''}`,
        verb: `重启了${app}`,
      };
    }
    return null;
  }

  /* ------------------------------------------------------------ 收尾 */

  finish(task, out) {
    this.task = null;
    task.endedAt = Date.now();
    task.ms = task.endedAt - (task.startedAt || task.endedAt);
    /** ★ 多段目标时 `task.steps` 只是最后一段的，报表和 episodes 要累计的 `allSteps`。 */
    const steps = task.allSteps && task.allSteps.length ? task.allSteps : (task.steps || []);
    /** 事件/报表里永远是**用户那句话**（`root`），不是拆段后的子目标。 */
    const goal = task.root || task.goal;
    /**
     * ★ 2026-11-07：`done` 只写了一句"看完了"时，把**她真读到的那段**带上。
     * 回灌给她的处境只有 `summary`；没有这段，她只能对用户说"看完了"，说不出内容。
     * 只在 summary 很短时补，避免把一篇长文塞进每一条回灌。
     */
    let summary = out.summary || '';
    if (task.readDigest && String(summary).length < 40
      && /(讲|读|内容|看看|什么|说清|念)/.test(`${task.goal} ${goal}`)) {
      const gist = String(task.readDigest).replace(/\s*\n\s*/g, '；').slice(0, 320);
      summary = `${summary || '读完了'}（读到的原文：${gist}）`;
    }
    const res = {
      id: task.id,
      goal,
      by: task.by,
      key: task.key,
      /** ★ 层 0：`chat` / `roam` / `session` —— 旧版分不开，自主做没做根本量不出来。 */
      src: task.src || 'chat',
      session: task.session || '',
      ok: !!out.ok,
      asked: !!out.asked,
      stopped: !!out.stopped,
      summary: summary || out.summary || '',
      verb: out.verb || '',
      plan: task.plan && task.plan.length ? task.plan : undefined,
      steps: steps.length,
      ms: task.ms,
      calls: task.calls,
      /** ★ 2026-11-01：这一趟"看图自救"用了几次（上限 10）。 */
      rescues: Number(task.rescues) || 0,
      /** ★ 2026-11-02：这一趟自己关掉了几次弹窗/广告。 */
      popups: Number(task.popupRounds) || 0,
      /**
       * ★ 2026-11-02（C/D 批）：滚动与卡住分类。
       * `stuck` 让"她为什么没成"过一周还回答得出来（诊断文档 P1-10）。
       */
      scrolls: Number(task.scrolls) || 0,
      stopWhy: task.lastStop || '',
      stuck: task.stuck || (task.wall ? 'wall' : ''),
      shot: task.shot || null,
      /** ★ 2026-11-07：这一趟结束时手机停在哪一屏 —— 回灌的"当前屏"从这里来。 */
      screen: this.lastScreen || '',
      at: task.endedAt,
    };
    this.record(task, res, steps);
    /** ★ 2026-11-01：收尾时顺手清一次（截图/episodes 以前是只增不删）。 */
    this.pruneFiles();
    /**
     * ★ 2026-11-08：**被打断的那件不要回灌成"没成"。**
     *
     * 他一句新指令把手上的事顶掉时，如果照样发一条 `fail`，她会回一句"那件事没成"——
     * 而他眼里那件事他根本没让做（真机 23:07「先不要搜了，然后去搜深圳的天气」）。
     * 只留日志；回灌留给**新那件**的结果。
     */
    if (res.stopped && task.preemptedBy) {
      log.info(`手机：「${goal}」被「${task.preemptedBy}」顶掉了（做到 ${steps.length} 步）`);
      this.drain();
      return res;
    }
    this.emit({ kind: out.ok ? (out.asked ? 'ask' : 'done') : 'fail', ...res });
    log.info(`手机：${out.ok ? '完成' : '没成'}「${goal}」${res.summary ? `：${res.summary}` : ''}（${steps.length} 步 / ${Math.round(res.ms / 1000)}s / ${task.calls} 次模型${this.persona ? ' · view=hand-only' : ''}）`);
    this.drain();
    return res;
  }

  record(task, res, steps = task.steps || []) {
    try {
      fs.appendFileSync(this.episodesFile, JSON.stringify({
        id: res.id, goal: res.goal, by: res.by, ok: res.ok, summary: res.summary,
        src: res.src, session: res.session || '',
        intent: task.intent, plan: res.plan, steps: steps.map((s) => s.action).slice(0, 30),
        calls: res.calls, ms: res.ms,
        /** ★ 2026-11-02：关掉了几次弹窗（"卡住"里有多少是广告，靠这个数才说得清）。 */
        popups: res.popups, scrolls: res.scrolls, stopWhy: res.stopWhy, stuck: res.stuck,
        shot: res.shot ? res.shot.hash : '', at: res.at,
      }) + '\n', 'utf8');
    } catch { /* 记不下来不该影响任务 */ }
  }

  /**
   * ★ 2026-11-01：**截图和 episodes 以前只增不删**（真机一张 0.7~0.8 MB）。
   * 一天几场会话 + 聊天里让她截图，一个月就是几十上百 MB；`episodes.jsonl` 每行 ~400 B，
   * 量小但没有上限。这里每次收尾顺手清一次：截图留最近 7 天 / 最多 200 张，
   * episodes 留最近 2000 行。清不掉就算了（不该影响任务结果）。
   */
  pruneFiles({ keepDays = 7, maxShots = 200, maxEpisodes = 2000 } = {}) {
    try {
      const now = Date.now();
      const cut = now - keepDays * 24 * 3600_000;
      const files = fs.readdirSync(this.shotsDir)
        .map((name) => {
          const full = path.join(this.shotsDir, name);
          try { const st2 = fs.statSync(full); return { full, at: st2.mtimeMs, size: st2.size }; } catch { return null; }
        })
        .filter(Boolean)
        .sort((a, b) => b.at - a.at);
      files.forEach((f, i) => {
        if (i < maxShots && f.at >= cut) return;
        try { fs.unlinkSync(f.full); } catch { /* 正被读就下次 */ }
      });
    } catch { /* 目录还没建 */ }
    try {
      const raw = fs.readFileSync(this.episodesFile, 'utf8');
      const lines = raw.trim().split('\n').filter(Boolean);
      if (lines.length > maxEpisodes) {
        const tmp = `${this.episodesFile}.tmp`;
        fs.writeFileSync(tmp, `${lines.slice(-maxEpisodes).join('\n')}\n`, 'utf8');
        fs.renameSync(tmp, this.episodesFile);
      }
    } catch { /* 还没有 episodes */ }
  }
}

/**
 * 读记忆。★ 2026-10-31：**旧格式（只有 ui_hash → 动作）一律丢掉**。
 * 那批记录没有目标、没有失败计数，正是"桌面→图库→切相机"那条毒链的来源；
 * 留着不如不要（新格式是 `pkg|hash|意图`，旧键反正也匹配不上新键）。
 */
function loadHints(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const items = raw && raw.items && typeof raw.items === 'object' ? raw.items : {};
    const out = {};
    for (const [k, v] of Object.entries(items)) {
      if (!v || typeof v !== 'object') continue;
      if (k.split('|').length < 3) continue;          // 旧键：没有包名/意图
      if (v.succ === undefined && !v.avoid) continue; // 旧值：没有成功计数
      out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/** 默认的模型调用：复用 `companion-brain` 的 `/chat/completions`（不重复造轮子）。 */
function defaultCallModel(model, messages, opts) {
  const { callModel } = require('./companion-brain.cjs');
  return callModel(model, messages, opts);
}

module.exports = {
  PhoneAgent, DEFAULTS, VERBS, parseTag, parseAction, parsePlan, quickSkill, splitSeq, splitGoal, loadHints,
  intentOf, goalNouns, hintKey, screenHasGoal, whereAmI, isBili,
  /** ★ 2026-11-08：验证墙（滑块）识别与"自己拖一次"——自检直接调这两个。 */
  captchaOf, slideCaptcha, otherEngineUrl,
  /** ★ 2026-11-08 夜：回灌前核对"她说的和事实对不对得上"。 */
  factTokens, mentionsFact,
};
