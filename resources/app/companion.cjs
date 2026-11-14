/**
 * 陪伴模式的主控 —— 把「角色卡 / 记忆 / 拟人化 / 唤醒 / OneBot / 事件尾巴」
 * 拼成一个可开关的东西，并把事件抛给桌宠页面。
 *
 * 这是**路线 B 的内核内置版**：不另起一个 Node 进程、不装外部 kit，
 * 桌宠自己就是那个"更会聊天的她"。好处有三个：
 *   1. 桌宠里打字和 QQ 里聊天用的是**同一个大脑、同一本人物账**；
 *   2. 不会出现"外部 kit 和桌宠各回一句"的双回；
 *   3. 模型配置直接复用桌宠的 `config/settings.json`，用户不用再填一把 Key。
 *
 * 外部 `ai-companion-kit` 仍然可以接：把 `adapter` 改成 `kit-jsonl`，
 * 桌宠就只读它写出来的 `events.jsonl`（只显示，不参与回复）。
 *
 * 配置在 `config/companion.json`，角色卡在 `config/companion-role.md`，
 * 记忆在 `data/companion/`。三个都可以单独删。
 */
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const llm = require('./llm.cjs');
const log = require('./log.cjs');
const store = require('./store.cjs');
const clock = require('./clock.cjs');
const role = require('./companion-role.cjs');
const { CompanionMemory } = require('./companion-memory.cjs');
const { CompanionBrain, resolveModel, whyNotReady, callModel, recentCalls } = require('./companion-brain.cjs');
const { Humanizer, split } = require('./companion-humanize.cjs');
const { OneBotClient } = require('./companion-onebot.cjs');
const { KitEventTail } = require('./companion-kit-events.cjs');
const { shouldWake, joinBatch } = require('./companion-wake.cjs');
const media = require('./companion-media.cjs');
const stickers = require('./companion-stickers.cjs');
const qqGateway = require('./companion-gateway.cjs');
const { LongMemory } = require('./long-memory.cjs');
const { createMemoryScribe, clean: cleanMemoryText } = require('./memory-scribe.cjs');
const presence = require('./companion-presence.cjs');
const { Mind, sameThought } = require('./companion-mind.cjs');
const selfNotes = require('./companion-self.cjs');
/**
 * ★ 2026-11-04：**她自己的账**（锚 / 账 / 传）。
 * 和 `selfNotes`（行为反射）是两层：那层是"我怎么反应"，这层是"我是谁"。
 */
const selfKernel = require('./companion-self-kernel.cjs');
const mood = require('./mood.cjs');
const imagine = require('./companion-imagine.cjs');
const phoneAgentMod = require('./phone-agent.cjs');
const phoneLifeMod = require('./phone-life.cjs');
const phoneVideoMod = require('./phone-video.cjs');
/**
 * ★ 2026-11-07：**同一个她的只读人格源**。
 * 手机上的计划 / 判断 / 说话都从这一份快照派生（见 `companion-persona.cjs` 顶部）。
 * 它没有写入口 —— 不会碰 role/self/mind/diary/people/memory。
 */
const personaMod = require('./companion-persona.cjs');
const phoneSurface = require('./phone-surface.cjs');
/** ★ 2026-11-07：主人一句"往下滑"这种明确指令，不必等她写 `[手机:…]`。 */
const phoneIntent = require('./phone-intent.cjs');
/**
 * ★ 2026-11-12：**他这句话是不是"让她去玩手机"**（短句 + 上下文）。
 * 旧版是 `phone-life.PLAY_RX` 一条裸正则：会被「好玩吧 / 不偷玩手机 / 玩手机的触发机制」
 * 误触，又认不出他真说的「去吧」。判定收在 `phone-play.cjs` 里（纯函数，好测）。
 */
const phonePlay = require('./phone-play.cjs');
/**
 * ★ 2026-11-12（P0）：**手机前门**。
 *
 * `ownerCommands()` 是"查表"（认得出才排）；这一层是"门"——判得出"他这句是让她用手机"
 * 就把**原句**交给她，不再要求特定句式（「打开菜谱看看」「去B站搜红烧肉」以前都 miss）。
 * 纯函数（不碰手机、不碰模型），`phone.gate.enabled=false` 一个开关就能回退。
 */
const phoneGate = require('./phone-gate.cjs');
/**
 * ★ 2026-11-11：**她自己的日记本**（手机上那个极简 App）。
 * 文件在 `/sdcard/Android/data/com.bluefish.diary/files/diary/`，一篇一个 md；
 * 主进程用 `adb shell cat` 直读，不占步数、不烧 token。
 */
const herDiaryMod = require('./her-diary.cjs');
const voiceMod = require('./companion-voice.cjs');
const asrMod = require('./companion-asr.cjs');

const CONFIG_FILE = path.join(llm.CONFIG_DIR, 'companion.json');
const ROLE_FILE = path.join(llm.CONFIG_DIR, 'companion-role.md');
const DATA_DIR = path.join(path.dirname(log.file), 'companion');
/** ★ 2026-11-12（P0）：手机前门的 near-miss 账（一周看一次，别天天加规则）。 */
const GATE_AUDIT_FILE = path.join(DATA_DIR, 'phone', 'gate.jsonl');
/** ★ 2026-10-26：表情包目录（文件名=关键词）；`qq/` 是小号收藏表情的缓存。 */
const STICKER_DIR = path.join(DATA_DIR, 'stickers');
const QQ_STICKER_DIR = path.join(STICKER_DIR, 'qq');
/** ★ 2026-11-01：语音的节奏状态（上次发语音是什么时候、离它隔了几条文字）。 */
const VOICE_FILE = path.join(DATA_DIR, 'voice.json');
const MAX_RECENT_EVENTS = 60;

/** 默认配置。**所有字段都有默认值**，所以老配置文件缺字段也能跑。 */
const DEFAULTS = {
  enabled: false,
  /**
   * ★ 2026-10-22 用户："连接上 QQ 后让它一直保持连接，只是桌宠模式时不进行通讯。"
   * `enabled` = 是否保持 OneBot 连接；`respond` = 是否处理/回复 QQ 消息。
   * 桌宠大脑挡（三挡按钮第 1 挡）= enabled 保持 true、respond false：
   * WS 一直连着（省掉重连），但收到的 QQ 消息直接丢掉，不写记忆、不发气泡。
   */
  respond: true,
  adapter: 'builtin',              // builtin：桌宠自己连 OneBot；kit-jsonl：只读外部 kit 的事件
  onebot: {
    wsUrl: 'ws://127.0.0.1:3001',
    httpUrl: 'http://127.0.0.1:3000',
    accessToken: '',
  },
  names: ['大肥鱼', '肥鱼'],
  keywords: [],
  ownerIds: [],
  wake: {
    probability: 0.05,
    groupAtOnly: true,             // 群里只认 @/名字/戳/关键词；false 才启用提问和概率
    privateWindowMs: 1500,         // 私聊合并窗口：等她把话说完
    groupWindowMs: 6000,           // 群聊合并窗口
  },
  humanize: {
    enabled: true,
    burstMax: 6,
    msPerChar: 85,
    minMs: 1200,
    maxMs: 6000,
    gapRange: [700, 2600],
    longGapChance: 0.25,
    longGapRange: [3000, 9000],
  },
  /**
   * ★ 2026-10-27：QQ 模型现在是一套**独立**的 API，和桌宠的 `settings.json` 分开。
   * `mode` 故意不写进 DEFAULTS：老配置没有 `mode` 时要让 `resolveModel()` 先认出
   * "有没有手填过字段"，再决定 same/custom；如果在这里给默认值 'same'，深合并会
   * 把老配置里的自定义字段静默吞掉。
   *   · mode='same'   —— 跟桌宠同一套（不读下面这些字段）；
   *   · mode='custom' —— 下面这些字段就是 QQ 自己的接口，缺什么就是没填。
   */
  model: {
    baseUrl: '', apiKey: '', model: '', maxTokens: 0, timeoutMs: 0, keepAlive: '',
  },
  /**
   * ★ 2026-10-27：长期记忆（参考 D:\DSH+Character 的 BM25 + 摘要压缩）。
   * 全部有默认值；`enabled:false` 就退回"人物账 + 最近 20 轮"的老行为。
   */
  memory: {
    enabled: true,
    extractEveryTurns: 6,          // 每几轮后台整理一次（不阻塞回复）
    maxEntries: 160,               // 活跃记忆条数上限，超过就压缩最旧一批
    maxTokens: 12000,              // 正文 token 粗估上限
    retrievalTopK: 6,              // QQ 检索条数
    retrievalTokenBudget: 1200,    // QQ 检索预算
    halfLifeDays: 60,              // 时间衰减半衰期；0 = 不衰减
    compressBatch: 16,             // 每次压缩合并的最旧条数
    deskpetTopK: 3,                // 桌宠 0 挡更小的预算，别把本地 3B 塞爆
    deskpetTokenBudget: 400,
  },
  /**
   * ★ 2026-10-27：**自主说话**（用户："想说就说，不想说不说，隔几分钟甚至半小时再想开口"）。
   *
   * 以前桌宠是"每 60 秒看一眼该不该说"，那是**一个定时器**；现在拆成三层：
   *   ① 心里有没有事 → `companion-mind.cjs` 的念头池；
   *   ② 此刻想不想说 → `companion-presence.cjs`（动机分 × 沉默越久越想说的系数）；
   *   ③ 现在合不合适 → 同一文件的闸门（刚聊完 / 上次没回 / 深夜 / 上限）。
   *
   * 这里只放默认值；`data/companion/presence.json` 存"上次开口 / 连续没被回"这类运行期状态。
   */
  presence: {
    ...presence.DEFAULTS,
    // 自检默认关（别的区域在数消息条数，别让"她自己冒一句"把断言搅乱）；
    // `16-presence.cjs` 自己显式打开。
    enabled: process.env.DSP_PRESENCE_OFF ? false : presence.DEFAULTS.enabled,
    mindEveryMin: 30,
  },
  chats: [],                       // 空 = 全部；填 `group:456` / `private:123` 只理这些
  mirror: 'wake',                  // wake：只把会让她开口的消息显示到手机；all：全部显示
  bubbleReplies: true,             // QQ 的回复要不要在桌宠气泡里冒一句
  /**
   * ★ **QQ 回复要不要在桌宠里念出来**（2026-10-22 用户："让陪伴模式暂时别接本地语音，
   * 这个配置带不动"）。`true` = 和普通回答一样走本地 TTS；`false` = 只冒气泡、不合成语音。
   * 只影响 QQ 陪伴模式的回复，不碰桌宠自己的短句和「声音」总开关。
   */
  bubbleVoice: true,
  maxReplyChars: 600,
  kitRoot: 'D:\\ai-companion-kit',
  kitEventsPath: '',               // 空 = <kitRoot>\packages\companion\data\events.jsonl
  replayLast: 0,                   // 外部 kit 模式：启动时回放最后几条（0 = 从末尾开始）
  /**
   * ★ **QQ 网关管家**（2026-10-26 用户："每次连接 QQ 都要让 AI 跑出来再扫码，太麻烦"）。
   * 这一段让桌宠自己拉起/看住 NapCat，并在设置页/小手机里显示二维码。
   * 详细说明和字段见 `companion-gateway.cjs`；这里只放默认值，老配置缺这段也能跑。
   */
  gateway: { ...qqGateway.DEFAULTS },
  /**
   * ★ 2026-10-30：**她的手机**（真安卓，MuMu + adb）。
   *
   * 全部默认关（`enabled:false`）：没开的时候她根本不知道有这东西（能力提示按 `when` 注入）。
   * 开了之后：`[手机:…]` → `phone-agent` 在后台操作 → 做完回灌给她 → 她用自己的话 + 截图发到 QQ。
   * 默认**跟 QQ 同一套模型**（`model.mode:'same'`），要单独换再切 custom。
   *
   * ★ 2026-11-01：里面多了一段 `video`（她"刷视频"）：
   *   `[手机:看会儿视频]` 不走 `phone-agent` 的逐步决策，走 `phone-video` 的
   *   "读字 → 抽 3 帧 → 她判一次 → 想走就上滑"。预算/门槛都在那里，默认开。
   */
  phone: {
    ...phoneAgentMod.DEFAULTS,
    video: { ...phoneVideoMod.DEFAULTS },
    /**
     * ★ 2026-11-11：她自己的日记本。
     * `guard` 是"连着删 2 篇要提醒他"那件事：`windowMin` 内算一串、`alertAt` 篇时提醒一次。
     * `trash` = 软删除（删掉的文件进 `.trash/`，他想看能捞回来；关掉就真删）。
     */
    diary: { guard: { windowMin: 30, alertAt: 2 }, trash: true },
    /**
     * ★ 2026-11-12（P0）：**前门**（"这句话是不是让她用手机"）与**打开 App 的兜底**。
     * `gate.enabled=false` = 完全退回 11-12 之前的行为（只跑 `ownerCommands`）。
     */
    gate: { ...phoneGate.DEFAULTS },
  },
  /**
   * ★ 2026-11-01：**她的声音（QQ 语音）**。
   *
   * 合成**直连火山「豆包语音合成 1.0」**（2026-11-01 上午从 7860 预览台搬出来，
   * 那个窗口一关语音就全哑了）。这里存：
   *   · 用不用（`enabled`，默认开）；
   *   · 火山 API Key（`tts.apiKey`）；
   *   · 四个旋钮（语速 / 音量 / 音色=音调 / 情感）；
   *   · 什么时候递话筒（`stage`，没有上限、也没有间隔）。
   * 音色方案（佩奇猪 40 + 撒娇学妹 20 + 魅力女友 40）写死在
   * `companion-voice.cjs` 的 DEFAULTS.tts 里 —— 用户 2026-11-01 调好、听过样音的。
   */
  voice: JSON.parse(JSON.stringify(voiceMod.DEFAULTS)),
};

/** 深合并：对象逐层合，数组和标量直接替换。 */
function merge(base, patch) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  if (!patch || typeof patch !== 'object') return out;
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v)
      && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = merge(base[k], v);
    } else {
      out[k] = Array.isArray(v) ? v.slice() : v;
    }
  }
  return out;
}

function readConfig() {
  const raw = store.readJson(CONFIG_FILE);
  return merge(DEFAULTS, raw && typeof raw === 'object' ? raw : {});
}

/** 第一次运行时把默认角色卡落盘，之后用户改文件就行。 */
function ensureRoleFile() {
  try {
    if (!fs.existsSync(ROLE_FILE)) {
      fs.mkdirSync(path.dirname(ROLE_FILE), { recursive: true });
      fs.writeFileSync(ROLE_FILE, `${role.DEFAULT_ROLE.trim()}\n`, 'utf8');
      log.info(`陪伴角色卡已生成：${ROLE_FILE}`);
    }
  } catch (err) {
    log.warn(`陪伴角色卡写不出来（用内置默认）：${err.message}`);
  }
}

function loadRole() {
  try {
    return fs.readFileSync(ROLE_FILE, 'utf8').replace(/^\uFEFF/, '').trim() || role.DEFAULT_ROLE;
  } catch {
    return role.DEFAULT_ROLE;
  }
}

function saveRole(text) {
  const body = String(text || '').trim() || role.DEFAULT_ROLE.trim();
  fs.mkdirSync(path.dirname(ROLE_FILE), { recursive: true });
  fs.writeFileSync(ROLE_FILE, `${body}\n`, 'utf8');
  return body;
}

/* ---------- 单例状态 ---------- */

let cfg = readConfig();
const bus = new EventEmitter();
bus.setMaxListeners(30);
let recentEvents = [];
let running = false;
let connected = false;
let selfId = '';
let lastError = '';
let waitingKit = false;
let client = null;
let tail = null;
let memo = null;
const batchTimers = new Map();
const batchItems = new Map();
const busy = new Map();

/**
 * ★ 2026-11-01：引用是不是"在跟她说话"，是**放后台查**的（`OneBotClient.#checkQuote`）。
 *
 * 查回来之前 `shouldWake()` 只知道"群里没人叫她" —— 于是"你引用她那句话回她"这种消息
 * 以前会被**直接丢掉**（`isQuoteMe` 恒 false 的直接后果）。所以这里把"还没决定醒不醒"的
 * 那条先挂起 `QUOTE_WAIT_MS`：查回来是"引的她"就照常走；否 / 超时就算没醒。
 * 一个布尔值不许把收消息的路拖住，所以有上限、也不 await。
 */
const quotePending = new Map();
const QUOTE_WAIT_MS = 1200;

/**
 * 引用查清之后的回填（`OneBotClient` 的 `onQuoteCheck`）。两件事：
 *   ① 已经进了合并窗口的那条：`{...msg}` 是副本，改副本；
 *   ② 还在 `quotePending` 里等"醒不醒"的那条：现在可以决定了。
 * @returns {boolean} 有没有改到东西（自检直接用它）
 */
function applyQuoteCheck(m) {
  const id = String(m?.messageId || '');
  if (!id) return false;
  const key = String(m?.key || '');
  let touched = false;
  for (const it of batchItems.get(key) || []) {
    if (String(it.messageId || '') === id && m.isQuoteMe) { it.isQuoteMe = true; touched = true; }
  }
  const p = quotePending.get(id);
  if (p) {
    quotePending.delete(id);
    clearTimeout(p.timer);
    if (m.isQuoteMe) {
      touched = true;
      handleInbound(m);                 // 重新判一次：现在它算"在跟她说话"
    } else {
      log.info(`陪伴：引用的不是她（${p.reason || '没叫她'}），当没醒`);
    }
  }
  return touched;
}

/** 自主说话的运行期状态：状态机 + 念头池 + 定时器（`start()` 建，`stop()` 只停表）。 */
const PRESENCE_FILE = path.join(DATA_DIR, 'presence.json');
const MIND_FILE = path.join(DATA_DIR, 'mind.json');
/** 心跳：20 秒看一次"现在想不想说"。纯本地计算，不花 token。 */
const PRESENCE_HEARTBEAT_MS = 20_000;
let presenceRt = null;

const memory = () => (memo || (memo = new CompanionMemory({ dir: DATA_DIR })));

/**
 * ★ 2026-10-27：长期记忆 + 后台整理员（懒加载：没配记忆就不建目录、不读盘）。
 * 整理员默认用 QQ 那套模型（`resolveModel(cfg.model)`）；QQ 没配好时它自己会跳过。
 */
let longMemo = null;
let scribe = null;
function longMemory() {
  if (!longMemo) {
    longMemo = new LongMemory({ dir: DATA_DIR, memory: memory(), log });
    longMemo.init();
  }
  return longMemo;
}
function memoryScribe() {
  if (!scribe) {
    scribe = createMemoryScribe({
      longMemory: longMemory(),
      memory: memory(),
      callModel,
      getModel: () => resolveModel(cfg.model),
      getConfig: () => cfg.memory,
      log,
    });
  }
  return scribe;
}

/**
 * ★ **QQ 网关管家**（2026-10-26）：桌宠自己看住 NapCat。
 *
 * 以前这一步归外部脚本（`launcher-local.bat -q 小号`），所以"连 QQ"必须先找人跑命令；
 * 现在 `companion` 一开就由它拉起，掉线按退避重启，二维码由设置页/小手机直接显示。
 *
 * 生命周期按用户 2026-10-26 的选择：**桌宠退出不关 QQ** —— `stop()` 只 `suspend()`，
 * 要真下线得在设置页点「停止网关」。
 */
const gw = qqGateway.create({
  getConfig: () => ({ ...(cfg.gateway || {}), enabled: !!cfg.enabled, adapter: cfg.adapter }),
  onChange: () => emitState(),
});

/** 本地主人用哪个"人"的账：配了主人 QQ 号就用它，这样 QQ 和桌宠共用一本。 */
function ownerPersonId() {
  return String((cfg.ownerIds || [])[0] || 'owner');
}
function ownerName() {
  const u = llm.load().user;
  return u && u !== '你' ? u : '你';
}

/** 表情包状态：本地几张、她自己收藏几张、QQ 收藏几张、mface，以及关键词列表。 */
function stickerState() {
  const cat = stickers.catalog(STICKER_DIR, QQ_STICKER_DIR);
  return {
    dir: STICKER_DIR,
    local: cat.filter((x) => x.source === 'local').length,
    collected: cat.filter((x) => x.source === 'collected').length,
    qq: cat.filter((x) => x.source === 'qq').length,
    mface: cat.filter((x) => x.source === 'mface').length,
    tags: [...new Set(cat.map((x) => x.tag))].slice(0, 40),
  };
}

let stickerRefreshing = null;
let stickerRefreshedAt = 0;
/**
 * 拉一次小号 QQ 的收藏表情。连上 OneBot 时自动做一次，设置页也能手动点。
 * 10 分钟内不重复拉（除非 force），避免每次保存配置都打一遍接口。
 */
async function refreshStickers({ force = false } = {}) {
  if (!client) return { ok: false, why: 'OneBot 还没连上', ...stickerState() };
  if (!force && Date.now() - stickerRefreshedAt < 10 * 60_000) {
    return { ok: true, skipped: true, ...stickerState() };
  }
  if (stickerRefreshing) return stickerRefreshing;
  stickerRefreshing = (async () => {
    try {
      const list = await stickers.refreshQq({ client, qqDir: QQ_STICKER_DIR });
      stickerRefreshedAt = Date.now();
      log.info(`表情：QQ 收藏同步 ${list.length} 张`);
      emitState();
      return { ok: true, count: list.length, ...stickerState() };
    } catch (err) {
      log.warn(`表情：同步 QQ 收藏失败（${err.message}）`);
      return { ok: false, why: err.message, ...stickerState() };
    } finally {
      stickerRefreshing = null;
    }
  })();
  return stickerRefreshing;
}

/** 事件统一从这里出去：内存里留最近 60 条，页面重连时能补上。 */
function emitEvent(ev) {
  const full = { ...ev, at: Number(ev.at) || Date.now() };
  recentEvents.push(full);
  if (recentEvents.length > MAX_RECENT_EVENTS) recentEvents = recentEvents.slice(-MAX_RECENT_EVENTS);
  bus.emit('event', full);
}

/**
 * ★ 2026-11-01：**便宜版状态**，给"每句话都要问一句"的调用方用。
 *
 * `publicState()` 会 `memory().snapshot()`（把 1200 行流水读一遍数行数）和
 * `longMemory().stats()`（readdir + stat 160 个记忆文件）—— 实测 **35.9 ms/次**。
 * 而 `pet.cjs` 每收到一条 outbound 事件要问它两次（冒不冒泡、要不要念），
 * 每条 QQ 回复就在主进程同步阻塞 ~72 ms，而且随记忆条数线性变长。
 * 设置页要的那一堆统计留在 `publicState()` 里不动，这里只给"开关 + 连接态"。
 */
function prefsState() {
  const model = resolveModel(cfg.model);
  const why = whyNotReady(model);
  return {
    enabled: !!cfg.enabled,
    respond: cfg.respond !== false,
    running,
    connected,
    adapter: cfg.adapter,
    bubbleReplies: cfg.bubbleReplies !== false,
    bubbleVoice: cfg.bubbleVoice !== false,
    presence: { enabled: presenceCfg().enabled !== false },
    phone: { on: !!phoneCfg().enabled },
    model: { ready: !why, why },
  };
}

function publicState() {
  const model = resolveModel(cfg.model);
  const why = whyNotReady(model);
  let counts = { people: 0, turns: 0 };
  try {
    const s = memory().snapshot();
    counts = { people: s.people.length, turns: s.turns };
  } catch { /* 记忆读不出来不影响开关 */ }
  let long = { count: 0, tokens: 0, people: 0, pending: 0, lastExtractedAt: 0 };
  try {
    const stats = longMemory().stats();
    const memState = longMemory().getState();
    long = {
      ...stats,
      pending: (memState.pendingCompress || []).length,
      lastExtractedAt: Number(memState.lastExtractedAt) || 0,
    };
  } catch { /* 长期记忆读不出来不影响开关 */ }
  return {
    enabled: !!cfg.enabled,
    respond: cfg.respond !== false,
    adapter: cfg.adapter,
    running,
    connected,
    waitingKit,
    selfId,
    lastError,
    model: {
      mode: model.mode,
      source: model.source,
      preset: model.preset,
      model: model.model,
      baseUrl: model.baseUrl,
      maxTokens: model.maxTokens,
      timeoutMs: model.timeoutMs,
      ready: !why,
      why,
    },
    ownerPersonId: ownerPersonId(),
    bubbleReplies: cfg.bubbleReplies !== false,
    bubbleVoice: cfg.bubbleVoice !== false,
    rolePath: ROLE_FILE,
    configPath: CONFIG_FILE,
    memoryPath: DATA_DIR,
    kitEventsPath: kitFile(),
    counts,
    /** ★ 2026-10-27：长期记忆的规模 / 上次整理时间 / 待压缩标记。 */
    memory: long,
    recent: recentEvents.length,
    /** ★ 2026-10-26：这个版本能看图（当前模型 deepseek-chat 已验过收 image_url）。 */
    imageInput: true,
    mediaPath: path.join(DATA_DIR, 'media'),
    /** ★ 2026-10-26：表情包目录（本地 + 小号 QQ 收藏）。 */
    stickers: stickerState(),
    /** ★ 2026-10-27：自主说话 —— 她想不想开口、心里攒着几件事。 */
    presence: presenceState(),
    /** ★ 2026-10-30：她的手机（真安卓）。`on` 决定能力提示里有没有【手机】这一条。 */
    phone: phoneState(),
    /** ★ 2026-11-01：她的声音（QQ 语音）。`today` 只是统计，不是上限。 */
    voice: (() => {
      const v = voiceCfg();
      const st = voiceState();
      return {
        enabled: v.enabled,
        keyed: !!v.tts.apiKey,
        resourceId: v.tts.resourceId,
        today: st.countToday || 0,
        lastAt: st.lastVoiceAt || 0,
        textsSince: st.textsSince || 0,
      };
    })(),
    gateway: gw.publicState(),
    /**
     * ★ 2026-11-01：**最近 10 次模型调用**（设置页显示）。
     * 放 `publicState()` 里是因为它只有设置页看；热路径用 `prefs()`，
     * 那个函数不碰这个数组（见「别踩的坑」第 6 条）。
     */
    calls: recentCalls(),
  };
}

function emitState() {
  bus.emit('state', publicState());
}

/* ---------- 她的声音（QQ 语音，2026-11-01） ---------- */

/** 当前生效的语音配置（补齐默认值、夹好范围）。 */
function voiceCfg() {
  return voiceMod.normalize(cfg.voice || {});
}

/**
 * 节奏状态只放这几样：上次发语音、离它隔了几条文字、今天几条。
 * 一天几十字节，改了就写；读失败就当新的，不影响回话。
 */
let voiceStateCache = null;
function voiceState(at = Date.now()) {
  if (!voiceStateCache) {
    const saved = store.readJson(VOICE_FILE);
    voiceStateCache = voiceMod.rollDay(saved || voiceMod.newState(at), at);
  }
  return voiceMod.rollDay(voiceStateCache, at);
}
function saveVoiceState(next) {
  voiceStateCache = next;
  try { store.writeJson(VOICE_FILE, next); } catch (err) { log.warn(`语音：节奏状态没存下来（${err.message}）`); }
}

/**
 * 这一条要不要递话筒。`mode` 只决定"用不用声音"，说什么仍由她写。
 * 没有每日上限、也没有间隔（2026-11-01 用户："她想说就说"）；没填 Key 就等于没嗓子。
 */
function planVoice({ text, isGroup, unsolicited = false, at = Date.now() }) {
  const v = voiceCfg();
  const ready = v.enabled && !!v.tts.apiKey;
  if (!ready) return { mode: 'none', why: v.enabled ? 'no-key' : 'disabled', enabled: false };
  const plan = voiceMod.decide({ voice: v, text, isGroup, unsolicited, now: at, state: voiceState(at) });
  if (plan.mode !== 'none') {
    log.info(`语音：这一条递话筒（${plan.why}${plan.p ? ` · p=${plan.p.toFixed(2)}` : ''}）`);
  }
  return { ...plan, enabled: true, maxChars: v.tts.maxChars };
}

/**
 * 把"哪条说"真的合成出来。失败的、太长太短的都退回文字 ——
 * 宁可发一条正常的文字，也不发一条念一半的语音，更不假装发过。
 */
async function prepareVoiceSegments(segments) {
  if (!segments.some((s) => s.kind === 'voice')) return segments;
  const v = voiceCfg();
  // 双保险：功能关着、或者没配 Key，就绝不合成（正常路径根本不会走到这里）
  if (!v.enabled || !v.tts.apiKey) {
    return segments.map((s) => (s.kind === 'voice' ? { kind: 'text', text: s.text } : s));
  }
  return Promise.all(segments.map(async (s) => {
    if (s.kind !== 'voice') return s;
    const n = [...(s.speak || '')].length;
    if (n < 4) {
      log.info(`语音：这句太短（${n} 字），改成打字`);
      return { kind: 'text', text: s.text };
    }
    if (n > v.tts.maxChars) {
      log.info(`语音：这句 ${n} 字太长（上限 ${v.tts.maxChars}），改成打字`);
      return { kind: 'text', text: s.text };
    }
    const r = await voiceMod.synthesize(v, s.text);
    if (!r.ok) {
      log.warn(`语音：没合成（${r.error}），这句改成打字`);
      return { kind: 'text', text: s.text };
    }
    log.info(`语音：合成好「${s.text.slice(0, 24)}」（${r.ms}ms · ${Math.round((r.bytes || 0) / 1024)}KB）`);
    return { ...s, audio: r.audio, ms: r.ms, bytes: r.bytes };
  }));
}

/** 「音色」窗口里的"试听"：只合成，不发 QQ。可以带表单里还没保存的旋钮。 */
function voiceWith(patch = {}) {
  const base = cfg.voice && typeof cfg.voice === 'object' ? cfg.voice : {};
  return voiceMod.normalize(merge(base, patch || {}));
}
async function voicePreview(patch = {}) {
  const v = voiceWith(patch);
  const text = String(patch.text || '今天有点想你。').slice(0, 80);
  const r = await voiceMod.synthesize(v, text);
  return r.ok ? { ok: true, audio: r.audio, mime: r.mime, ms: r.ms, bytes: r.bytes, text: r.text } : r;
}

/* ---------- 她的耳朵：把 QQ 语音条转成文字（2026-11-02） ---------- */

/** 当前生效的语音识别配置（每次现读，改 `config\voice-asr.json` 不用重启）。 */
function asrCfg() {
  return asrMod.settings();
}

/**
 * 把一条 record 段变成"能喂给方舟的 base64 + 格式"。
 *
 * 优先走网关的 `get_record`（2026-11-02 实测：它认 record 段里的 `file` 令牌，
 * 用 NapCat 自己手里的凭据把语音取到本机，`out_format:'mp3'` 还顺手把 silk/amr 转成 mp3 ——
 * 和 `get_image` 避开"下载地址过期"是同一个道理）。
 * 只有网关拿不到时才退回 `url`（可能 400，记一行日志，不假装听见了）。
 *
 * @returns {Promise<{audio:string, format:string, bytes:number}|null>}
 */
async function recordBytes(rec, cfg) {
  const max = (cfg && cfg.qq ? cfg.qq : asrMod.DEFAULTS.qq).maxBytes;

  if (client && connected && rec && rec.file) {
    const r = await client.call('get_record', { file: rec.file, out_format: 'mp3' }, 60_000);
    if (r && r.ok) {
      const d = r.data && typeof r.data === 'object' ? r.data : {};
      let buf = null;
      if (d.base64) buf = Buffer.from(String(d.base64).replace(/^base64:\/\//, ''), 'base64');
      else if (d.file && path.isAbsolute(String(d.file))) {
        try { buf = fs.readFileSync(String(d.file)); } catch (err) { log.warn(`语音：读不到网关转好的文件（${err.message}）`); }
      }
      if (buf && buf.length) {
        if (buf.length > max) throw new Error(`语音太大（${(buf.length / 1048576).toFixed(1)}MB）`);
        return { audio: buf.toString('base64'), format: asrMod.sniffAudioFormat(buf) || 'mp3', bytes: buf.length };
      }
      if (d.url && !rec.url) rec = { ...rec, url: String(d.url) };
      log.info('语音：get_record 没给字节，退回用地址下载');
    } else if (r && r.error) {
      log.warn(`语音：get_record 没拿到（${r.error}）`);
    }
  }

  if (!rec || !rec.url) return null;
  let u;
  try { u = new URL(media.cleanUrl(rec.url)); } catch { throw new Error('语音地址不是合法 URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`不支持的语音协议 ${u.protocol}`);
  if (process.env.DSP_MEDIA_ALLOW_PRIVATE !== '1' && media.isPrivateHost(u.hostname)) throw new Error('拒绝内网语音地址');
  const res = await fetch(u, {
    redirect: 'follow',
    signal: AbortSignal.timeout(45_000),
    headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) BlueFishDeskpet' },
  });
  if (!res.ok) throw new Error(`下载语音失败 HTTP ${res.status}`);
  const len = Number(res.headers.get('content-length') || 0);
  if (len > max) throw new Error(`语音太大（${(len / 1048576).toFixed(1)}MB）`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new Error('下载到的语音是空的');
  if (buf.length > max) throw new Error(`语音太大（${(buf.length / 1048576).toFixed(1)}MB）`);
  return { audio: buf.toString('base64'), format: asrMod.sniffAudioFormat(buf) || 'mp3', bytes: buf.length };
}

/**
 * 这一条消息里的语音全部转写，把结果**并进 `msg.text`**（原来是 `[语音]` 占位符）。
 *
 * 失败也要留下痕迹：`msg.voiceMeta.failed > 0` 会进处境，让她说"没听清"，
 * 而不是照着占位符编内容（图片那条踩过同样的坑：下载失败她回"看着像一道菜"）。
 */
async function transcribeInbound(m) {
  const cfg = asrCfg();
  const recs = (Array.isArray(m.records) ? m.records : []).slice(0, cfg.qq.maxRecords);
  const got = [];
  let failed = 0;
  for (const rec of recs) {
    let audio = null;
    try {
      audio = await recordBytes(rec, cfg);
    } catch (err) {
      log.warn(`语音：没拿到音频（${err.message}）`);
    }
    if (!audio) { failed += 1; continue; }
    const t = await asrMod.transcribe(cfg, {
      audio: audio.audio,
      format: audio.format,
      context: '这是 QQ 里发来的语音条，经过压缩，可能有背景噪声',
    });
    if (t.ok && String(t.text || '').trim()) {
      log.info(`语音：听懂了「${String(t.text).slice(0, 60)}」${t.tone ? `（${t.tone}）` : ''} · ${audio.bytes} 字节 · ${t.ms}ms`);
      got.push(t);
    } else {
      failed += 1;
      log.warn(`语音：没转写出来（${t.error || '内容是空的'}）`);
    }
  }
  const left = String(m.text || '').replace(/\[语音\]/g, '').trim();
  const spoken = got.map((t) => String(t.text || '').trim()).filter(Boolean);
  m.text = [left, ...spoken].filter(Boolean).join(' ').trim();
  if (!m.text) m.text = failed ? '[语音]（没听清）' : '[语音]';
  m.voiceMeta = { lines: got, failed };
  return m;
}

/**
 * 把这一批里的"语音语气"写成一句处境。
 * 只挑第一段（一轮里连着几条语音的情况很少），别把处境写成论文。
 */
function voiceSituation(items) {
  const withVoice = (items || []).filter((it) => it && it.voiceMeta && (it.voiceMeta.lines || []).length);
  if (!withVoice.length) return '';
  const meta = withVoice[withVoice.length - 1].voiceMeta;
  const first = meta.lines[0];
  const bits = [];
  if (first.emotion && !['平静', '其他'].includes(first.emotion)) bits.push(first.emotion);
  if (first.tone) bits.push(first.tone);
  if (first.rate && first.rate !== '正常') bits.push(`语速${first.rate}`);
  if (first.volume && first.volume !== '正常') bits.push(`音量${first.volume}`);
  if (first.background && first.background !== '无') bits.push(`背景有${first.background}`);
  let out = `\n（他这一条是**用语音**说的，下面是他说的原话（转写可能有同音错字）`
    + `${bits.length ? `。听起来：${bits.join('、')}` : ''}）`;
  if (first.summary) out += `\n（他大概想说的是：${first.summary}）`;
  /**
   * ★ 2026-11-02（用户补充）：**回文字还是回语音，由她自己决定**（默认 `free`）。
   * 只有显式选了 `always`（"语音对讲"）才告诉她这一条必须用声音。
   */
  const replyMode = asrMod.settings().reply.voice;
  if (replyMode === 'always') out += '\n（这一条用语音回，一两句就行。）';
  else if (replyMode === 'free') out += '\n（你可以用语音回，也可以打字 —— 按你自己的意思来。）';
  if (meta.failed) out += `\n（还有 ${meta.failed} 段语音没听清 —— 别装作听见了，可以问他再说一遍。）`;
  return out;
}

function kitFile() {
  if (cfg.kitEventsPath) return path.resolve(cfg.kitEventsPath);
  return path.join(String(cfg.kitRoot || DEFAULTS.kitRoot), 'packages', 'companion', 'data', 'events.jsonl');
}

/* ---------- 启动 / 停止 ---------- */

function start() {
  if (running) return publicState();
  if (!cfg.enabled) return publicState();
  running = true;
  lastError = '';
  waitingKit = false;
  ensureRoleFile();
  stickers.ensureDirs(STICKER_DIR);
  if (cfg.adapter === 'kit-jsonl') startKit();
  else startOneBot();
  // ★ 2026-10-26：内置模式下顺手把 NapCat 拉起来（别再让用户/AI 去跑 bat）。
  // 不 await：网关起得慢（QQ 冷启动十几秒），不能拖住桌宠窗口；状态由 `gateway` 推送。
  if (cfg.adapter !== 'kit-jsonl' && cfg.gateway?.autoStart !== false) {
    gw.start().catch((err) => log.warn(`QQ 网关启动失败：${err.message}`));
  }
  startPresence();
  startPhoneRoam();
  log.info(`陪伴模式：开（${cfg.adapter === 'kit-jsonl' ? '只读外部 kit' : '内置 QQ 内核'}）`);
  emitState();
  return publicState();
}

function stop() {
  const was = running;
  running = false;
  connected = false;
  waitingKit = false;
  stopPresence();
  stopPhoneRoam();
  try { phoneRt?.stop(); } catch { /* 没在跑 */ }
  for (const t of batchTimers.values()) clearTimeout(t);
  batchTimers.clear();
  batchItems.clear();
  try { client?.stop(); } catch { /* 已经断了 */ }
  try { tail?.stop(); } catch { /* 已经关了 */ }
  client = null;
  tail = null;
  /**
   * ★ 2026-10-26：只停 watchdog，**不杀 QQ**。
   * 用户要的是"桌宠退出 QQ 继续挂着"：登录态更稳，下次开桌宠直接连。
   * 真下线 = 设置页「停止网关」（`gw.stop()`）。
   */
  try { gw.suspend(); } catch (err) { log.warn(`QQ 网关挂起失败：${err.message}`); }
  if (was) log.info('陪伴模式：关');
  emitState();
  return publicState();
}

function startOneBot() {
  const ob = cfg.onebot || {};
  if (!ob.wsUrl) {
    lastError = '没填 OneBot WebSocket 地址';
    return;
  }
  client = new OneBotClient({
    wsUrl: ob.wsUrl,
    httpUrl: ob.httpUrl,
    accessToken: ob.accessToken,
    onMessage: (m) => handleInbound(m),
    /** ★ 2026-11-01：引用查到"引的是她"之后，回填还在合并窗口里的那条。 */
    onQuoteCheck: (m) => applyQuoteCheck(m),
    onStatus: (st) => {
      if (typeof st.connected === 'boolean') connected = st.connected;
      if (st.selfId) selfId = st.selfId;
      if (st.error) lastError = st.error;
      if (st.connected) lastError = '';
      emitState();
      // 刚连上：顺手把小号 QQ 的收藏表情同步一次（10 分钟内不重复）
      if (st.connected) refreshStickers().catch(() => {});
    },
  });
  client.start();
}

function startKit() {
  const file = kitFile();
  tail = new KitEventTail({
    file,
    replayLast: cfg.replayLast,
    onEvent: (ev) => {
      if (ev.type === 'outbound' && (!ev.parts || !ev.parts.length)) ev.parts = split(ev.text, cfg.humanize.burstMax);
      emitEvent(ev);
    },
    onStatus: (st) => {
      waitingKit = !!st.waiting;
      connected = !st.waiting;
      emitState();
    },
  });
  tail.start();
  log.info(`陪伴模式：只读 ${file}`);
}

/* ---------- 她的手机（真安卓） ---------- */

/**
 * ★ 2026-10-30：手机这一条线只做三件事，全部集中在这里，别散到 `replyBatch` 里：
 *   1. 建一次 `PhoneAgent`（adb 懒加载，没开手机就不会 spawn 任何东西）；
 *   2. 把她写的 `[手机:…]` 变成后台任务；
 *   3. 任务结束后**回灌**给她（带截图），让她用自己的话讲。
 *
 * 为什么要回灌：不回灌的话，程序替她发了图，她只是个定时发图脚本；
 * 回灌之后，"玩手机的人"和"QQ 上聊天的人"是同一个 —— 这也是用户要的核心。
 */
let phoneRt = null;
const phoneShares = [];
/**
 * ★ 2026-11-02：她最近看过/点开过的视频标题（跨场次，最多 60 条）。
 * 每场视频都会新建一个 watcher，所以"看过什么"必须放在这一层，不然"换一个"会点回同一条。
 */
const videoRecent = new Set();

function phoneCfg() {
  return cfg.phone || phoneAgentMod.DEFAULTS;
}

/** 手机用哪套模型：默认跟 QQ 完全一样（mode=same），custom 时只覆盖填了的字段。 */
function phoneModel() {
  const qq = resolveModel(cfg.model);
  const pc = phoneCfg().model || {};
  if (!pc.mode || pc.mode === 'same') return { ...qq, source: 'qq' };
  const pick = (k, d) => (pc[k] !== undefined && pc[k] !== null && String(pc[k]).trim() !== '' ? pc[k] : d);
  return {
    ...qq,
    mode: 'custom',
    source: 'custom',
    baseUrl: String(pick('baseUrl', qq.baseUrl)).trim(),
    apiKey: pick('apiKey', qq.apiKey),
    model: String(pick('model', qq.model)).trim(),
    maxTokens: Math.max(64, Number(pc.maxTokens) || qq.maxTokens),
    timeoutMs: Math.max(5000, Number(pc.timeoutMs) || qq.timeoutMs),
    keepAlive: pc.keepAlive !== undefined ? String(pc.keepAlive) : qq.keepAlive,
    preset: pc.preset || qq.preset,
  };
}

/**
 * ★ 2026-10-30：手机的"世界状态"由这里单独记 —— 不能只看 `phone.enabled`。
 *
 * 用户点第 3 挡的当下 `enabled` 就变 true 了，但真机要 30~60 秒才亮；
 * 如果这时就告诉模型"你手边有手机"，她会答应"我这就去看"，然后什么也做不了。
 * 所以 `up` 只在这一刻为真：adb 连上、Android 启动完、窗口露出来之后。
 */
let phoneUp = false;
let phoneStage = '';       // '' | checking | launching | booting | showing | ready | fail
let phoneWhy = '';
let phoneBootAt = 0;
let phoneApp = '';
/**
 * ★ 2026-11-08（R-D）：**手机是哪一刻真的亮起来的**。
 *
 * 真机 22:00:57 手机就接上了，22:01:27 她还在说"手还是在空着" ——
 * 那几句是 21:48（手机真没开）写进 `turns.jsonl` 的，20 轮窗口里还在。
 * 光"现在有手机"这条事实**不足以**让她改口，还要告诉她"刚才那句已经过期了"。
 * 只有一个时间戳，别的什么都不记（这是事实，不是台词）。
 */
let phoneReadyAt = 0;

/** 给页面/气泡/日志的阶段事件。`ready`/`fail` 会顺带更新 `phoneUp`。 */
function phoneStageEmit(stage, extra = {}) {
  phoneStage = stage;
  if (stage === 'ready') {
    /** 只在"从没亮/刚灭过"时刷新，避免每轮重连都把"刚亮的"重新计时。 */
    if (!phoneUp) phoneReadyAt = Date.now();
    phoneUp = true;
    phoneWhy = '';
  }
  if (stage === 'fail') { phoneUp = false; phoneWhy = String(extra.why || ''); }
  const ev = {
    kind: 'stage', stage, at: Date.now(),
    elapsed: phoneBootAt ? Date.now() - phoneBootAt : 0,
    ...extra,
  };
  bus.emit('phone', ev);
  /**
   * ★ `phoneUp` 变了要**推一次 prefs**：页面靠 `st.phone.up` 决定"收起开机卡片、
   * 让位给真窗口"，只在 phone 事件里画一次的话，页面会一直停在"正在把手机拿出来…"。
   */
  if (stage === 'ready' || stage === 'fail') { try { emitState(); } catch { /* 没启动 */ } }
  return ev;
}

/**
 * ★ 2026-11-07：**取一份只读人格快照**（每轮聊天 / 每场手机会话只取一次，之后一路传下去）。
 *
 * 只读：`loadRole()` / `selfKernel.active()` / `mood.snapshot()` / `lifeRt.state()` / 当前屏。
 * 不写任何文件；`config.phone.taste` 只在她的账里一条口味都没有时兜底。
 */
function personaSnapshot() {
  const life = (() => { try { return lifeRt ? lifeRt.state() : null; } catch { return null; } })();
  return personaMod.snapshot({
    roleText: (() => { try { return loadRole(); } catch { return ''; } })(),
    entries: (() => { try { return selfKernel.active(); } catch { return []; } })(),
    mood: (() => { try { return mood.snapshot(); } catch { return null; } })(),
    phone: life,
    tasteFallback: String((phoneCfg() || {}).taste || ''),
    lastScreen: (phoneRt && phoneRt.lastScreen) || '',
  });
}

/**
 * ★ 2026-11-07：**换手不换人** —— 把同一份快照塞给手机那只"手"。
 * 断言不过（`setPersona` 返回 false）就**不接**：这一件不做，也不换一个人格顶上。
 */
function applyPersonaToPhone(snap = null) {
  const ag = phoneRt;
  if (!ag || typeof ag.setPersona !== 'function') return false;
  try { return ag.setPersona(snap || personaSnapshot()); } catch (err) {
    log.warn(`手机：人格快照没交出去（${err.message}）`);
    return false;
  }
}

/**
 * ★ 2026-11-07：**现场读一屏**（只在他明确问"你现在看到什么"时调，不自动、不每轮）。
 *
 * 21:57 那次她说"加速器、下载、官网"—— 那不是这一屏，是 21:33 的旧页。
 * 根因是这一轮**没有人真的去看手机**。这里补上"看一眼"；读不到就如实说没看清。
 */
async function lookNow() {
  const ag = phoneRt;
  if (!ag) return '';
  try {
    const obs = typeof ag.perceiveQuiet === 'function' ? await ag.perceiveQuiet() : await ag.perceive(null);
    if (!obs || obs.ok === false) return '';
    const digest = phoneSurface.digest(obs, { max: 260 });
    if (typeof ag.setLastScreen === 'function') ag.setLastScreen(digest);
    return String(digest || '').replace(/\s+/g, ' ').slice(0, 260);
  } catch (err) {
    log.warn(`手机：读屏没读到（${err.message}）`);
    return '';
  }
}

/**
 * ★ 2026-11-08：**他这一句话，对手机意味着什么** —— QQ 和桌宠两条路共用这一段。
 *
 * 为什么要有它：11-07 23:30–23:41 那一轮真机，桌宠（语音）这条路**一个判断都没有** ——
 * `looksLikeStop` / `looksLikePlay` / 点头就开跑 / "你现在看到什么"，全在 QQ 的 `replyBatch` 里。
 * 所以他说「先别玩了」「我来操作」「算了我下次再优化」，她照样让手机点下去；
 * 他问"你现在看到什么"，她张口就是 20 轮流水里的旧页。
 *
 * 这里只做**判断 + 副作用**（停、开跑、读一屏），返回的是要拼进处境的几句话，
 * 说什么仍由她自己写（11-06 21:08 用户红线：别规定她说哪句话）。
 *
 * @returns {Promise<{answer:string, stop:boolean, stopHint:string, playHint:string, aboutScreen:string, cmd:object|null}>}
 */
async function phoneIntentHints({ text = '', key = '', isOwner = false, isGroup = false, phoneUp = false, at = Date.now() } = {}) {
  const said = String(text || '').trim();
  const out = {
    answer: '', stop: false, stopHint: '', playHint: '', aboutScreen: '', cmd: null,
    wantPhone: false, noPhone: '',
  };
  if (!said) return out;

  /**
   * ① 他是不是在回她刚才那句"能不能去玩会儿"（点头就开跑 / 不许就先放着）。
   *    这条不看 isOwner —— `answer()` 自己会判（提案是不是 pending、是不是他）。
   */
  try {
    const ans = ensureLife().answer({ key, text: said, isOwner, at });
    if (ans && ans.verdict === 'ok') {
      const want = ans.goal || (ans.items || []).map((x) => x.goal).slice(0, 1).join('');
      out.answer = `\n（你刚才问他能不能去办这件事（${want}），他刚回了「${said}」——他答应了。`
        + '回一句就动手，别啰嗦、别再问一遍。）';
      setTimeout(() => {
        try { ensureLife().startApproved({ key, at: Date.now() }); } catch (err) { log.warn(`手机：会话没开起来（${err.message}）`); }
      }, 0);
    } else if (ans && ans.verdict === 'no') {
      out.answer = `\n（你刚才问他能不能去办这件事，他说「${said}」——没让。别动手，说一句"那下次"就行。）`;
    }
  } catch (err) { log.warn(`手机：点头判断出错（${err.message}）`); }

  /**
   * ② 他这句本身就是一条明确的手机指令（短、现在时、祈使句）。
   *
   * ★ 2026-11-08：**手机不在她手上时也要认出来** —— 认出来是为了让她知道"他要的是手机"，
   * 而不是把那句话当成闲聊略过去（真机 21:48 她就是这么开始编的）。
   *
   * ★ 2026-11-12：**一句话里两件事都要排上**。
   * 真机 21:32「你回桌面，看看日记本，里面有我给你写的一条」——
   * 旧版只认第一句（回桌面），"看看日记本"被丢了，她只能嘴上说「日记本我这就翻翻」。
   * `phoneIntent.ownerCommands()` 本来就按标点切小句，这里把**每一条**都收下。
   */
  const wants = (isOwner && !isGroup) ? phoneIntent.ownerCommands(said) : [];
  out.wants = wants;
  out.cmdText = wants.map((w) => w.goal).join('，');
  out.wantPhone = wants.length > 0;
  out.cmd = (phoneUp && wants[0]) ? wants[0] : null;
  if (wants.length && !phoneUp) out.noPhone = noPhoneHint(out.cmdText, phoneState());

  /**
   * ③ 「先别玩了 / 我来操作 / 算了我下次再优化」→ **立刻停，连手上那一件也停**；
   *    「去玩吧 / 随便玩吧」→ 立刻开一场。
   *    只对主人 + 私聊生效（群里不认，也不在群里说她玩手机）。
   */
  if (isOwner && !isGroup) {
    if (phoneLifeMod.looksLikeStop(said)) {
      out.stop = true;
      let stopped = null;
      try { stopped = ensureLife().stop('他说先别玩'); } catch (err) { log.warn(`手机：停不下来（${err.message}）`); }
      /** 连手上那一件也停，并且清掉队列里还没跑的（`PhoneAgent.stop()` 会清）。 */
      try { phoneRt?.stop(); } catch { /* 本来就没在跑 */ }
      out.stopHint = stopped && stopped.ok
        ? '\n（他让你先别玩了，你把手机放下了。说一句就行，别解释、别问"要不要继续"。）'
        : `\n（他说"${said}"，不过你本来就没在玩手机。别装成刚玩过。）`;
    } else if (phonePlay.playIntent(said, { lastHerLine }).kind === 'play') {
      let play = null;
      try { play = ensureLife().beginPlayNow({ at: Date.now(), key, theme: '' }); } catch (err) { log.warn(`手机：没开起来（${err.message}）`); }
      if (play && play.ok) {
        out.playHint = play.resumed
          ? '\n（他让你接着玩。你本来就在玩，刚才因为他说话把手机放下了 —— 现在已经又拿起来了，回一句就接着做，别说"我去看看"。）'
          : `\n（他让你自己去玩一会儿。你已经把手机拿起来了${play.first ? `，打算去${play.label}，第一件是「${play.first}」` : '，先看看这一会儿想玩什么'}。`
            + '回一句就动手 —— 说你自己想说的，别问、别报菜名、别说"我去看看"。）';
      } else if (play && play.why === 'playing') {
        out.playHint = `\n（他已经让你玩过了，你正玩着呢（${play.label}）。回一句就行，别重新开始。）`;
      }
    }
  }

  /**
   * ★ 2026-11-12（P0）：**前门** —— `ownerCommands()` 认不出的那一句，交给 `phone-gate` 再判一次。
   *
   * 为什么要"再判一次"：`ownerCommands` 是一张表（14 条整句规则 + 11 条扫动作），
   * 认不出就当他没说过 —— 真机「打开菜谱看看」「去B站搜红烧肉」都是这么白说的。
   * 这一层只判"要不要"，判出来就把**原句**交给她（`kind:'raw'`），不要求句式。
   *
   * 三条硬约束（方案 §4.2）：
   *   · **逐小句判**，不是整句（「回桌面，点开那个蓝色的图标」第二句不能丢）；
   *   · 一条消息**最多补 1 件** raw（队列只有 2 格）；
   *   · 已被 `ownerCommands` 消化的原句按 `raw` **精确比对**（不用 `coversHim` 猜）。
   */
  let raw = null;
  if (isOwner && !isGroup && !out.stop) {
    const gateCfg = phoneCfg().gate;
    if (phoneGate.cfg(gateCfg).enabled) {
      const consumed = new Set(wants.map((w) => String(w.raw || '')));
      for (const clause of phoneIntent.clauses(said)) {
        if (consumed.has(clause)) continue;
        const g = phoneGate.gate(clause, { isOwner, isGroup, phoneUp, cfg: gateCfg });
        if (g.kind === 'task') {
          raw = {
            kind: 'raw', goal: g.goal, raw: clause, via: 'gate', shape: g.why, confidence: g.confidence,
          };
          log.info(`手机门：task（${g.why}/${g.confidence}）「${g.goal}」（原话：${said.slice(0, 40)}）`);
          break;
        }
        if (g.near) noteGateMiss(clause, g);
      }
    }
  }
  if (raw && wants.length < 3) {
    wants.push(raw);
    out.raw = raw;
    out.cmdText = wants.map((w) => w.goal).join('，');
    out.wantPhone = true;
    /** raw 补在后面时，`cmd` 仍然是**第一件**（他自己那件事优先）；没有别的才用 raw。 */
    if (!out.cmd && phoneUp) out.cmd = wants[0] || raw;
    if (!phoneUp) out.noPhone = noPhoneHint(out.cmdText, phoneState());
  }

  /**
   * ④ 「你现在看到什么」→ **现场读一屏**（用户红线：不自动读、不每轮读）。
   *   21:57 真机：她答"加速器、下载、官网"，全来自 21:33 的旧页 —— 因为这一轮没人看过手机。
   */
  if (phoneUp && isOwner && !isGroup && phoneIntent.asksAboutScreen(said)) {
    const seen = await lookNow();
    out.aboutScreen = seen
      ? `\n（他问你现在看到什么。你刚低头看了一眼手机，屏幕上：${seen}。只照这一屏说；这一屏上没有的，别往里添。）`
      : '\n（他问你现在看到什么。你低头看了一眼，没看清。照实说没看清，别编。）';
  }

  return out;
}

/**
 * ★ 2026-11-12（P0）：**"差点就是一条任务"的句子记一行**（`phone.gate.audit`）。
 *
 * 只在"句中有手机线索 + 动作词、但被守卫拦下"时写。攒一周看一次，再决定要不要补词 ——
 * 用户规矩是"别天天加规则"，所以这里只记账、不改行为。
 */
function noteGateMiss(text, res) {
  try {
    if (!phoneGate.cfg(phoneCfg().gate).audit) return;
    fs.mkdirSync(path.dirname(GATE_AUDIT_FILE), { recursive: true });
    fs.appendFileSync(GATE_AUDIT_FILE, `${phoneGate.auditLine(text, res)}\n`, 'utf8');
  } catch (err) { /* 记不下来不影响这一轮 */ }
}

/** 给页面/气泡/状态栏/自检用的只读状态（不碰 adb）。 */
function phoneState() {
  const rt = phoneRt ? phoneRt.state() : { busy: false, goal: '', step: 0, app: '', queued: 0 };
  const m = phoneModel();
  const p = phoneCfg();
  const stage = phoneStage;
  return {
    on: !!p.enabled,
    /** 手机真的亮了（adb 通 + 启动完 + 窗口露出来）。详见上面那段注释。 */
    up: !!phoneUp,
    booting: ['checking', 'launching', 'booting', 'showing'].includes(stage),
    stage,
    why: phoneWhy,
    /**
     * ★ 2026-11-08（R-D）：手机**亮起来的那一刻**（0 = 没亮过/正在灭）。
     * `capabilities` 用它说一句"手机是刚亮的，之前那句不作数了"。
     */
    readyAt: phoneUp ? phoneReadyAt : 0,
    elapsed: phoneBootAt && !phoneUp ? Date.now() - phoneBootAt : 0,
    busy: !!rt.busy,
    goal: rt.goal || '',
    step: rt.step || 0,
    app: rt.app || phoneApp,
    queued: rt.queued || 0,
    /**
     * ★ 2026-11-07：**她手机现在停在哪一屏**（文字摘要，来自 `PhoneAgent.noteScreen`）。
     * 回灌 / 他问"你现在看到什么" / 下一场计划都用它 —— 这是"当前屏"的唯一来源，
     * 不再从聊天流水里捡 20 分钟前的旧页。
     */
    screen: (phoneRt && phoneRt.lastScreen) || rt.screen || '',
    screenAt: (phoneRt && phoneRt.lastScreenAt) || rt.screenAt || 0,
    /** 这一场/这一件是谁的人格（同一份快照）。 */
    personaId: (phoneRt && phoneRt.persona && phoneRt.persona.personaId) || rt.personaId || '',
    model: m.model || '',
    ready: !whyNotReady(m),
    /**
     * ★ 2026-10-31：她自己的日子（`phone-life` 的只读快照）。
     * 能力提示用它说一句"你手上还有件没做完的事"，页面用它显示"她在玩什么"。
     * 读的是内存 + 一个小 JSON，不碰 adb。
     */
    life: (() => {
      try { return lifeRt ? lifeRt.state() : null; } catch { return null; }
    })(),
  };
}

function ensurePhone() {
  if (!phoneCfg().enabled) return null;
  if (phoneRt) return phoneRt;
  try {
    const { PhoneAdb } = require('./phone-adb.cjs');
    const p = phoneCfg();
    const adb = new PhoneAdb({
      home: p.home || undefined,
      serial: p.serial || undefined,
      vmindex: p.vmindex || 0,
    });
    phoneRt = new phoneAgentMod.PhoneAgent({
      adb,
      model: phoneModel(),
      dir: path.join(DATA_DIR, 'phone'),
      taste: p.taste,
      budget: p,
      /** ★ 2026-10-31：操作员能不能看图（默认开，模型拒一次就自动关）。 */
      vision: p.vision,
      /**
       * ★ 2026-11-07：**没有截图时"停/再翻"由她的脑子判断**（聊天模型 + 同一份快照）。
       * 看图那条仍由手来看（它必须看截图），但口径一样是她的 `judgeView`。
       */
      personaJudge: async ({ persona: snap, goal, screen, stopCriteria }) => {
        if (!snap) return null;
        const model = resolveModel(cfg.model);
        if (whyNotReady(model)) return null;
        const brain = new CompanionBrain({
          memory: memory(), roleText: loadRole(), model, longMemory: null,
        });
        return brain.judgePhone({ persona: snap, goal, screen, stopCriteria });
      },
      /** ★ 2026-11-01：卡住时"看图找出口"（第一优先级，每任务默认 10 次）。 */
      rescue: p.rescue,
      /** ★ 2026-11-07：滚动时每屏看图判断"停/再翻"（`scroll.lookEach`）。 */
      scroll: p.scroll,
      /** ★ 2026-11-12：打开 App 的兜底（抽屉手势 / 截图问坐标的额度 / 学习开关）。 */
      open: p.open,
      emit: onPhoneEvent,
    });
    /**
     * ★ 2026-10-30：没找到 adb 的时候把"到底在哪"记下来 —— 上一轮的故障就是
     * `D:\Program Files\Netease\...` 写死、用户重装到 `D:\mumulvse\...` 之后一声不响地失败。
     */
    const paths = adb.paths();
    if (!adb.adbExe) {
      log.warn(`手机：找到 ${paths.home || '（没找到 MuMu 目录）'}，但里面没有 adb.exe（manager=${paths.manager || '无'}）`);
    } else {
      log.info(`手机：接上 ${adb.adbExe}（MuMu ${paths.version || '版本未知'}，manager ${paths.manager || '无'}）`);
    }
    /** 把这次认出来的路径写回配置：下次启动不用再扫盘，也不会再"找不到"。 */
    if (paths.home && paths.home !== p.home && adb.adbExe) {
      try {
        cfg = { ...cfg, phone: { ...(cfg.phone || {}), home: paths.home } };
        store.writeJson(CONFIG_FILE, cfg);
        log.info(`手机：记住安装位置 ${paths.home}`);
      } catch (err) { log.warn(`手机：路径没写进配置（${err.message}）`); }
    }
  } catch (err) {
    log.warn(`手机：起不来（${err.message}）`);
    return null;
  }
  return phoneRt;
}

/** 手机那边发生的事：转给页面看，做完/失败就回灌给她。 */
function onPhoneEvent(ev) {
  bus.emit('phone', ev);
  /**
   * ★ 2026-11-11：**她每走一步，顺手看一眼"她是不是刚把日记删了"。**
   *
   * 删除一定发生在某一步之后（她自己点的），所以这里几秒内就能发现，不用轮询、不用多一次 adb。
   * 连着删到第 2 篇会提醒他一次（`sweepDiary` 里判窗口 + 去重）。
   */
  if (ev && ev.kind === 'step') {
    sweepDiary({ key: ev.key || '' }).catch(() => { /* 数不出来不挡她干活 */ });
  }
  /**
   * ★ 2026-11-07：**开局先把"她"交给手**（同一份只读快照），并记下这一场是谁在玩。
   * 身份断言不过就不接 —— 宁可这一场什么都不做。
   */
  if (ev && ev.kind === 'session-start') {
    /**
     * ★ 2026-11-07：**开场这份快照必须就是她排计划的那一份**。
     * 不是"取一份新的、恰好像"，而是 `personaId` 要对上（对不上就不接这一场）。
     */
    const snap = personaSnapshot();
    if (ev.personaId && snap.personaId !== ev.personaId) {
      log.warn(`手机：这一场的人格和计划时不是同一份（${ev.personaId}→${snap.personaId}），不接`);
      try { phoneRt?.stop(); } catch { /* 没在跑 */ }
      return;
    }
    const ok = applyPersonaToPhone(snap);
    if (!ok) log.warn('手机：这一场的人格快照没交给手（身份对不上就不动）');
    log.info(`手机：这一场是她（persona=${snap.personaId}，view=hand-only）`);
  }
  /**
   * ★ 2026-11-07：**手拿不准（`ask`）要有人接**。
   * 旧版只发事件，没人回答；现在交回她的嘴去问，问完停在那儿等他。
   */
  if (ev && ev.kind === 'ask') {
    phoneAskFollowUp(ev).catch((err) => log.warn(`手机：她那句问话没发出去（${err.message}）`));
    return;
  }
  /**
   * ★ 2026-11-02（第三批）：**她玩的时候看到"特别有意思的"，主动跟他说**。
   * 触发点是滚动层停下时的那句 `why`（"看到「猫」了"），一场最多 2 次（见 `phone-life.onFound`）。
   * 必须放在 `src === 'session'` 那条静默记账**前面**，否则会被当成子任务结果吞掉。
   */
  if (ev && ev.kind === 'found') {
    try { ensureLife().onFound(ev); } catch (err) { log.warn(`手机：分享判断出错（${err.message}）`); }
    return;
  }
  /**
   * ★ 2026-10-31（层 0）：**会话里的子任务不再逐个回灌 QQ**。
   *
   * 旧版是"每个任务结束都发一条"：一次会话 4~5 件小事 = 4~5 条 QQ 消息，纯刷屏。
   * 现在会话里的子任务只记账（`life.onTask`），**收尾由 `phone-life` 发一条**。
   * 她和他在聊天里让她做的事（`src:'chat'`）仍然做完就回灌，那个是对的。
   */
  if (ev && ev.src === 'session') {
    try { ensureLife().onTask(ev); } catch (err) { log.warn(`手机：会话记账出错（${err.message}）`); }
    return;
  }
  if (ev.kind === 'done' || ev.kind === 'fail') {
    phoneFollowUp(ev).catch((err) => log.warn(`手机：回灌失败（${err.message}）`));
  }
}

/** 分享闸门：一小时最多 6 张、一天最多 20 张（防刷屏）。 */
function canShareNow() {
  const limit = phoneCfg().share || {};
  const hour = 3600_000;
  const day = 24 * hour;
  const now = Date.now();
  while (phoneShares.length && now - phoneShares[0] > day) phoneShares.shift();
  const lastHour = phoneShares.filter((t) => now - t < hour).length;
  return lastHour < (Number(limit.maxPerHour) || 6) && phoneShares.length < (Number(limit.maxPerDay) || 20);
}

/**
 * 截图变成"能发给 QQ、也能让她看图"的一份：
 * 缩到 720 宽（720×1280 的手机屏保得住字；模型那边 `detail:low` 本来就会再缩到 512），
 * 存 `data/companion/phone/share/`。
 */
function prepareShot(file) {
  try {
    const buf = fs.readFileSync(file);
    const small = media.shrinkImage(buf, media.sniffMime(buf) || 'image/png', { maxSide: 720, force: true });
    const saved = media.saveImage(path.join(DATA_DIR, 'phone', 'share'), small.buf, small.mime);
    return {
      file: saved.file,
      hash: saved.hash,
      bytes: small.buf.length,
      dataUrl: `data:${small.mime};base64,${small.buf.toString('base64')}`,
    };
  } catch (err) {
    log.warn(`手机：截图处理失败（${err.message}）`);
    return null;
  }
}

/**
 * 回灌：任务结束 → 再问一次她（带截图）→ 她用自己的话发出去。
 * **不解构人格**：这一段走的就是 `CompanionBrain`，和 QQ 聊天同一条路。
 *
 * ★ 2026-11-07：再补三样东西，都是真机 21:56 那次串台的根因：
 *   ① **当前屏**（`res.screen` / `phoneState().screen`）跟着处境一起给她，不再只给 `summary`；
 *   ② 这一轮标 `kind:'phone'`（读的时候会被跳过，不再混进聊天记忆）；
 *   ③ 用的是**这一场同一份**只读人格快照，身份对不上就这一句不说（不换人）。
 */
async function phoneFollowUp(res) {
  const key = String(res.key || '');
  if (!key || res.stopped) return;
  /**
   * ★ 2026-11-07：**桌宠这条路的回灌**。
   *
   * 以前这里第一句就是 `if (!client || !connected) return;` —— 手机任务是桌宠里排的
   * （`key: 'deskpet'`），OneBot 没连上时结果永远回不来；她只能停在"我去弄一下"。
   * 现在桌宠单独走一条：把结果交回同一个 `CompanionBrain`，再由 `pet.cjs` 冒出来。
   */
  const isDesk = key === 'deskpet';
  if (!isDesk && (!client || !connected)) return;
  if (!isDesk && key.startsWith('group:')) return;            // 群里不分享手机
  const id = isDesk ? 'deskpet' : (key.split(':')[1] || '');
  const owners = (cfg.ownerIds || []).map(String);
  if (!isDesk && owners.length && !owners.includes(String(id))) return;

  const shot = res.shot && res.shot.file && canShareNow() ? prepareShot(res.shot.file) : null;
  if (shot && !isDesk) phoneShares.push(Date.now());

  let person = {};
  try { person = isDesk ? {} : (memory().person(id) || {}); } catch { /* 没账也能说 */ }
  const name = isDesk ? ownerName() : (person.name || id);

  /**
   * ★ 2026-11-07：**同一份只读快照 + 她手机"现在"那一屏**。
   * 旧版只给 `res.summary`，不给当前屏 —— 21:56 她只能从 20 轮聊天流水里捡回 21:33 的旧页
   * （"小飞鱼加速器"就是这么来的）。
   */
  const snap = personaSnapshot();
  const ps = phoneState();
  const screen = String(res.screen || ps.screen || '').replace(/\s+/g, ' ').slice(0, 300);
  const phoneLine = personaMod.voiceView(snap, {
    screen,
    extra: res.why ? `这一场她自己想做的是：${res.why}` : '',
  });

  const situation = [
    `你刚用自己的手机${res.verb || '忙了一会儿'}：${res.summary || '没什么结果'}。`,
    phoneLine,
    shot && !isDesk ? '下面这张就是你手机上的画面，这张图**确实**会跟这句话一起发到他那边。' : '',
    /**
     * ★ 2026-11-06（P0）：**成功时也不许补细节**。
     *
     * 20:21 实测：回灌只给了她一句"在「浏览器」搜了「看起来顺眼的图」"，
     * 她下一句就变成"图倒是一堆，顺眼的没几张"；四分钟后又变成"刚才那堆破图看完，眼睛都花了"。
     * 编出来的细节一旦进 `turns.jsonl`，下一轮就是她的记忆 —— 这是最贵的一种错。
     * 所以成功路径也要写死"你只看到了这些"。
     */
    '**你只看到了这些。** 没看见的细节（几张、什么颜色、在哪个网站、好不好看）一律别说；不确定就说"没看清"，还没挑就说"还没挑"。',
    '这件事已经做完了，**不要再写 `[手机:…]`**（那会重复排一件）。',
    isDesk ? '现在回到桌宠这边，把这件事跟他说一句。一两句就够，别复述"任务""步骤"这种词。'
      : '现在回到 QQ，把这件事跟他说一句。一两句就够，别复述"任务""步骤"这种词。',
    /**
     * ★ 2026-10-31：**没成就别替她圆**。
     * 上午实测：任务是"我还没动手，不能说弄完了"（截图根本没截成），
     * 她回灌的那句却是"截完了，也发出去了。你看看能不能收到。" —— 用户白等。
     * 所以失败时把"不许说什么"写死，而不是只写一句"照实说"。
     */
    res.ok ? '' : '这件其实**没做成**。照实说你卡在哪、现在停在哪；绝对不许说"弄好了/做完了/发出了/发过去了"这类没发生的事。',
    shot || isDesk ? '' : (res.ok ? '' : '截图也没发出去，别让他去收图。'),
  ].filter(Boolean).join('\n');

  const model = resolveModel(cfg.model);
  if (whyNotReady(model)) return;
  const brain = new CompanionBrain({
    memory: memory(),
    roleText: loadRole(),
    model,
    longMemory: cfg.memory?.enabled === false ? null : longMemory(),
  });
  /** ★ 2026-11-07：快照对不上就**这一句不说**（宁可她安静一下，也不让另一个人格顶上去）。 */
  const same = personaMod.checkSame(snap, 'voice');
  if (!same.ok) { log.warn(`手机：${same.why} —— 这条回灌先不说`); return; }
  const r = await brain.reply({
    userId: id,
    userName: name,
    text: isDesk ? '（手机那边弄完了。）' : '（手机那边弄完了。）',
    situation,
    platform: isDesk ? '桌宠' : 'QQ',
    where: key,
    unsolicited: true,
    images: shot && !isDesk ? [shot] : [],
    /**
     * ★ 2026-11-02：**这张图是她自己发的**，得在流水里留一笔。
     *
     * 原来这一轮只存了文字，图既不入 `turns.jsonl` 也没有"谁发的"——
     * 下一轮他说"为什么在这里看一盘菜"时，她只能猜，猜成了"你这表情包"（真机 20:44）。
     */
    media: shot && !isDesk ? ['图'] : [],
    /** ★ 2026-11-07：当前屏只给这一轮看（不写进 turns）；这一轮来源是 phone。 */
    evidence: screen,
    persona: snap,
    phone: ps,
    kind: 'phone',
  });
  /**
   * ★ 2026-11-08 夜（用户：「**她发的消息和视频内容完全对不上**」）：
   * **她说完要跟事实核一遍**，对不上就让她重说一次（只给她事实，不规定句子）。
   *
   * 真机 23:36：视频那场的总结是《小傻龙…》「一只手在戳Q版小傻龙和小鲸鱼的摆件」，
   * 她回灌成了「看了个**修老物件的，把锈住的螺丝泡开一点点拆**」——
   * 查过 `turns.jsonl` 全库 1338 轮，这句话里的东西**一次都没出现过**，是纯编的。
   * 编出来的细节一进流水就是她的记忆（20:21 那次"顺眼的没几张"就是这么变贵的），
   * 所以这里加一道硬核对：她的回话里得至少有**一个实词**来自这次的结果。
   * 只在她"说了内容"时才核（很短的一句、或明说"没看清"，本来就诚实，不折腾）。
   */
  let herText = String(r.text || '');
  const wantFact = /视频/.test(String(res.verb || '')) || /刷了\s*\d+\s*条视频/.test(String(res.summary || ''));
  if (wantFact && herText.length >= 12 && !/没看清|没太看清|没细看|没注意|记不清|不知道|没看懂/.test(herText)) {
    const toks = phoneAgentMod.factTokens(res.summary);
    if (toks.length && !phoneAgentMod.mentionsFact(herText, toks)) {
      log.warn(`手机：她说的和这次的事对不上（事实：${String(res.summary).slice(0, 60)}｜她：${herText.slice(0, 60)}），让她重说一次`);
      try {
        const r2 = await brain.reply({
          userId: id,
          userName: name,
          text: '（手机那边弄完了。）',
          situation: `${situation}\n（**你刚才那句把这件事说成了别的事。** 这件事只有这些：${String(res.summary).slice(0, 400)}`
            + '。要么照着说这一件，要么直接说"没太看清"；不许换成别的视频、别的内容。）',
          platform: isDesk ? '桌宠' : 'QQ',
          where: key,
          unsolicited: true,
          evidence: screen,
          persona: snap,
          phone: ps,
          kind: 'phone',
        });
        if (r2 && r2.text) herText = String(r2.text);
      } catch (err) { log.warn(`手机：重说一次也没成（${err.message}）`); }
      if (!phoneAgentMod.mentionsFact(herText, toks)) {
        /** 还是不认 → **只报标题**（事实），别再让她编第二遍。 */
        const title = (String(res.summary || '').match(/《([^》]{2,60})》/) || [])[1] || '';
        herText = title ? `《${title.split(/[：:]/)[0]}》看了一小段，具体没太看清。` : '看了一小段，具体没太看清。';
        log.warn('手机：第二次还是对不上，改成只报标题（不编内容）');
      }
    }
  }
  /**
   * ★ 2026-11-07：回灌这句话里**不许再出现 `[手机:…]`**。
   * 真机：手机做完后她回"翻完了……[手机:往下翻]"，标记被冒进桌宠气泡、还念了出来。
   * 这里只摘标记、**不再入队**（这件事已经做完了）。
   */
  const cleanText = String(phoneAgentMod.parseTag(herText).text || herText || '').trim()
    || String(res.summary || '').slice(0, 120)
    || '嗯，弄完了。';
  await deliverHerText({
    key, isDesk, id, name, text: cleanText, image: shot ? shot.file : '', reason: 'phone',
  });
}

/**
 * ★ 2026-11-07：**手在手机上拿不准，得她自己去问**（`ask` 动作接回大脑）。
 *
 * 旧版 `ask` 只发一个事件，没人接：手停在那儿，他那边什么都不知道。
 * 现在由她用**自己的声音**问一句（同一份快照、同一个模型），然后等他。
 */
async function phoneAskFollowUp(res) {
  const key = String(res.key || '');
  if (!key) return;
  const isDesk = key === 'deskpet';
  if (!isDesk && (!client || !connected)) return;
  if (!isDesk && key.startsWith('group:')) return;
  const id = isDesk ? 'deskpet' : (key.split(':')[1] || '');
  const owners = (cfg.ownerIds || []).map(String);
  if (!isDesk && owners.length && !owners.includes(String(id))) return;
  let person = {};
  try { person = isDesk ? {} : (memory().person(id) || {}); } catch { /* 没账也能说 */ }
  const name = isDesk ? ownerName() : (person.name || id);

  /** 手都问到脸上了，说明这一步确实推不动：先把它停掉，等她问完再说。 */
  try { phoneRt?.stop(); } catch { /* 本来就没在跑 */ }

  const model = resolveModel(cfg.model);
  if (whyNotReady(model)) return;
  const snap = personaSnapshot();
  const same = personaMod.checkSame(snap, 'voice');
  if (!same.ok) { log.warn(`手机：${same.why} —— 这句问话先不说`); return; }
  const ps = phoneState();
  const screen = String(res.screen || ps.screen || '').replace(/\s+/g, ' ').slice(0, 300);
  const situation = [
    `你正在手机上${res.goal ? `做「${res.goal}」` : '玩'}，有一件事拿不准：${res.summary || '不知道下一步该不该动'}`,
    personaMod.voiceView(snap, { screen }),
    '用你自己的话问他一句，就一两句，别写成申请、别复述步骤；他没回你就先停在那儿。',
  ].filter(Boolean).join('\n');
  const brain = new CompanionBrain({
    memory: memory(),
    roleText: loadRole(),
    model,
    longMemory: cfg.memory?.enabled === false ? null : longMemory(),
  });
  const r = await brain.reply({
    userId: id,
    userName: name,
    text: '（手机那边停下来，想问你一句。）',
    situation,
    platform: isDesk ? '桌宠' : 'QQ',
    where: key,
    unsolicited: true,
    evidence: screen,
    persona: snap,
    phone: ps,
    /**
     * ★ 2026-11-07：**这句是她问他的话，不是"手机进度"**。
     * 标成 `phone` 会被 20 轮读过滤掉 —— 他回"行"的时候，她看不见自己问过什么。
     */
    kind: 'chat',
  });
  const text = String(phoneAgentMod.parseTag(String(r.text || '')).text || r.text || '').trim()
    || '手机上有点拿不准，等一下。';
  await deliverHerText({ key, isDesk, id, name, text, image: '', reason: 'phone-ask' });
}

/**
 * 把她说的一句话送到该去的地方（桌宠气泡 / QQ）。
 * ★ 2026-11-07：从 `phoneFollowUp` 抽出来，"做完了"和"拿不准想问你"两条都要用。
 */
async function deliverHerText({ key, isDesk, id, name, text, image = '', reason = 'phone' }) {
  if (isDesk) {
    emitEvent({
      type: 'outbound',
      key: 'deskpet',
      isGroup: false,
      userId: 'deskpet',
      name,
      text,
      parts: split(text, cfg.humanize.burstMax),
      voice: 0,
      sticker: '',
      collected: '',
      image: 0,
      direct: true,
      reason,
    });
    log.info(`陪伴：手机回灌 → 桌宠：${text.slice(0, 40)}`);
    return;
  }
  await deliverToChat({
    key,
    isGroup: false,
    userId: id,
    name,
    replyText: text,
    image,
    direct: true,
    reason,
  });
}

/**
 * ★ 2026-11-01：**手机上排不下这件事，要让她自己说一声**。
 *
 * 以前 `accepted:false` 只写一行日志：她刚在 QQ 上说"我去看看"，然后几分钟里什么都没发生，
 * 用户以为她在装样子。现在把"没排上"作为处境回灌给她，由她用自己的话说"等一下"。
 * 只对私聊 + 主人（同 `phoneFollowUp` 的规矩），群里不刷屏。
 *
 * ★ 2026-11-08：**桌宠那条路也要说**（原来第一句就是 `if (!client || !connected) return;`，
 * 于是语音里排不下的时候，他那边一片安静，还以为她做了）。
 */
async function phoneRefused({ key, refused }) {
  const target = String(key || '');
  if (!target || !(refused || []).length) return;
  const isDesk = target === 'deskpet';
  if (!isDesk && (!client || !connected)) return;
  if (target.startsWith('group:')) return;
  const id = isDesk ? 'deskpet' : (target.split(':')[1] || '');
  const owners = (cfg.ownerIds || []).map(String);
  if (!isDesk && owners.length && !owners.includes(String(id))) return;
  const model = resolveModel(cfg.model);
  if (whyNotReady(model)) return;
  let person = {};
  try { person = isDesk ? {} : (memory().person(id) || {}); } catch { /* 没账也能说 */ }
  const name = isDesk ? ownerName() : (person.name || id || ownerName());
  const brain = new CompanionBrain({
    memory: memory(),
    roleText: loadRole(),
    model,
    longMemory: cfg.memory?.enabled === false ? null : longMemory(),
  });
  const r = await brain.reply({
    userId: id,
    userName: name,
    text: '（手机那边排不下。）',
    situation: phoneRefusedHint(refused),
    platform: isDesk ? '桌宠' : 'QQ',
    where: target,
    unsolicited: true,
  });
  if (isDesk) {
    const why = ((refused || []).find((x) => x && x.why) || {}).why || '';
    const fallback = noPhoneReason(why) ? '手机不在我手上，弄不了。' : '手机上还排着别的，等一下。';
    await deliverHerText({ key: 'deskpet', isDesk: true, id, name, text: String(r.text || '').trim() || fallback, reason: 'phone' });
    return;
  }
  await enqueueSend(target, () => deliverToChat({
    key: target,
    isGroup: false,
    userId: id,
    name,
    replyText: r.text,
    direct: true,
    reason: 'phone',
  }));
}

/**
 * 纯函数：把"没排上"写成给模型的处境（自检直接断言它，不用起手机）。
 *
 * ★ 2026-11-08：**"手机不在手上"和"排队排不下"是两件事**，不能说成同一句。
 * 真机 21:48–21:51：手机根本没开（`enabled:false`），他说「去浏览器点开」，她照样回"已经在点了"
 * —— 因为**没有人告诉她**她的手没接上。用户：「如果手机不在她手上，就让她告诉我
 * （只需要提醒她没手机操作，怎么回复我随她想法）」。
 */
function phoneRefusedHint(refused) {
  const list = (refused || []).map((x) => x && x.goal).filter(Boolean);
  if (!list.length) return '';
  const why = ((refused || []).find((x) => x && x.why) || {}).why || '排不下';
  if (noPhoneReason(why)) {
    return [
      `你想用自己的手机去做：${list.join('、')}。`,
      `可你现在**手上没有手机**（${why}），这件事一步都没做。`,
      '现在回他一句：把你手上没有手机这件事说清楚就行。一两句，**怎么说随你**，别装成已经做完了。',
    ].join('\n');
  }
  return [
    `你想用自己的手机去做：${list.join('、')}。`,
    `但手机上还排着别的，这件事**没排上**（${why}）。`,
    '现在回他一句：说清等一会儿再弄，别装成已经做完了。一两句就够。',
  ].join('\n');
}

/** 这个"没做成"的理由是"没有手机"，还是"手机忙/排不下"。 */
function noPhoneReason(why) {
  return /没开|没亮|不在|没有手机|没手机|没接上|开机没成|递给你/i.test(String(why || ''));
}

/**
 * ★ 2026-11-08：**他要她用手机，可她手上没有手机** —— 这一句要当场告诉她。
 *
 * 用户（21:54）：「当我要求她用手机的时候，如果手机不在她手上，就让她告诉我
 * （只需要提醒她没手机操作，怎么回复我随她想法）」。
 *
 * 措辞故意只说事实（哪种"没有"：没开 / 还在开机 / 开机失败），
 * **不规定她怎么回** —— 那是她的事（11-06 用户红线）。
 */
function noPhoneHint(goal, state = {}) {
  if (!goal) return '';
  const stage = String(state.stage || '');
  const why = stage === 'fail'
    ? '手机开机没成'
    : (state.booting || ['checking', 'launching', 'booting', 'showing'].includes(stage)
      ? '手机还在开机，屏还没亮'
      : '他没把手机递给你，你手上现在没有手机');
  return `（他刚让你在手机上做「${goal}」，可${why} —— 这一轮你没法真的动手。`
    + '回他一句，把"手机不在你手上"这件事说清楚就行；**怎么说随你**，别装成已经做了、也别编手机上的东西。）';
}

/** 她写的 `[手机:…]` → 入队（立刻返回，不等）。 */
/* ---------- 她自己的日记本（2026-11-11） ---------- */

/**
 * 用户这一轮定的四条，全压在这几个函数上：
 *   ① 不能强迫她写 —— 只有"他让她写"才走这里；她不想写就 `saysNo()` 收工，不劝；
 *   ② 不限字数 —— `herDiaryMod.push()` 自己分段敲；
 *   ③ 她想翻就能翻 —— App 首页就是目录（她 `read` 就能看见）；主进程这边 `recentEntries()` 也能读；
 *   ④ 删一篇要有痕迹、**连着删两篇要告诉他** —— `sweepDiary()`。
 *
 * ⚠️ 绝不把"她今天没动笔"这种句子写进任何提示词：那是催促。这里出现的永远只有事实。
 */
const DIARY_GUARD_FILE = path.join(DATA_DIR, 'phone', 'diary-guard.json');

function diaryCfg() {
  try { return herDiaryMod.normalize((phoneCfg() && phoneCfg().diary) || {}); } catch { return herDiaryMod.normalize({}); }
}

function readDiaryGuard() {
  try { return JSON.parse(fs.readFileSync(DIARY_GUARD_FILE, 'utf8')) || {}; } catch { return {}; }
}

function saveDiaryGuard(v) {
  try {
    fs.mkdirSync(path.dirname(DIARY_GUARD_FILE), { recursive: true });
    fs.writeFileSync(DIARY_GUARD_FILE, JSON.stringify(v, null, 1), 'utf8');
  } catch (err) { log.warn(`日记：守卫状态没写进去（${err.message}）`); }
}

/** 让她用自己的话说一句（事实钉在 situation 里）；模型起不来就返回空串。 */
async function herOwnWords({ key, text, situation }) {
  const model = resolveModel(cfg.model);
  if (whyNotReady(model)) return '';
  const target = String(key || '');
  const isDesk = target === 'deskpet';
  const id = isDesk ? 'deskpet' : (target.split(':')[1] || '');
  let person = {};
  try { person = isDesk ? {} : (memory().person(id) || {}); } catch { /* 没账也能说 */ }
  const name = isDesk ? ownerName() : (person.name || id || ownerName());
  try {
    const brain = new CompanionBrain({
      memory: memory(),
      roleText: loadRole(),
      model,
      longMemory: cfg.memory?.enabled === false ? null : longMemory(),
    });
    const r = await brain.reply({
      userId: id,
      userName: name,
      text,
      situation,
      platform: isDesk ? '桌宠' : 'QQ',
      where: target,
      unsolicited: true,
    });
    return String((r && r.text) || '').trim();
  } catch (err) {
    log.warn(`日记：她没说出来（${err.message}）`);
    return '';
  }
}

/** 把一句话发给他（只在私聊 + 主人；群里不刷屏）。 */
async function sendHerWords({ key, text, reason = 'diary' }) {
  const target = String(key || '');
  if (!target || !text) return false;
  const isDesk = target === 'deskpet';
  if (!isDesk && (!client || !connected)) return false;
  if (target.startsWith('group:')) return false;
  const id = isDesk ? 'deskpet' : (target.split(':')[1] || '');
  const owners = (cfg.ownerIds || []).map(String);
  if (!isDesk && owners.length && !owners.includes(String(id))) return false;
  let person = {};
  try { person = isDesk ? {} : (memory().person(id) || {}); } catch { /* 没账也能说 */ }
  const name = isDesk ? ownerName() : (person.name || id || ownerName());
  if (isDesk) {
    await deliverHerText({ key: 'deskpet', isDesk: true, id, name, text, reason });
    return true;
  }
  await enqueueSend(target, () => deliverToChat({
    key: target, isGroup: false, userId: id, name, replyText: text, direct: true, reason,
  }));
  return true;
}

/**
 * 数一眼"她是不是连着删了"（她每走一步都会调一次，几秒内发现）。
 * 一串删到第 `alertAt` 篇 → **提醒他一次**（带日期和开头一句；软删的东西还在 `.trash/`）。
 */
let diarySweeping = false;
/** ★ 2026-11-11：**节流**。她一步只值 ~1 秒，别每步都多一次 `cat`（1.5 秒内扫过就跳过）。 */
let diarySweptAt = 0;
async function sweepDiary({ key = '', at = Date.now(), force = false } = {}) {
  if (!force && at - diarySweptAt < 1500) return { ok: true, skipped: '刚看过' };
  if (diarySweeping) return { ok: false, why: 'busy' };
  diarySweptAt = at;
  let agent = null;
  try { agent = ensurePhone(); } catch { agent = null; }
  if (!agent || !agent.adb) return { ok: false, why: '手机没开' };
  diarySweeping = true;
  try {
    const conf = diaryCfg();
    const rows = await herDiaryMod.deleteLog(agent.adb);
    if (!rows.length) return { ok: true, alert: false, why: '还没有删除记录' };
    const st = readDiaryGuard();
    const r = herDiaryMod.judgeDeletes(rows, {
      at,
      windowMin: conf.guard.windowMin,
      alertAt: conf.guard.alertAt,
      sinceAt: Number(st.sinceAt) || 0,
      lastAlertAt: Number(st.lastAlertAt) || 0,
    });
    saveDiaryGuard({
      sinceAt: Math.max(Number(st.sinceAt) || 0, rows[rows.length - 1].at),
      lastAlertAt: r.alert ? at : (Number(st.lastAlertAt) || 0),
    });
    if (!r.alert) return { ok: true, alert: false, why: r.reason };

    log.info(`日记：她连着删了 ${r.items.length} 篇，得告诉他`);
    const target = key || targetChatKey();
    const said = await herOwnWords({
      key: target,
      text: '（我刚把日记删了。）',
      situation: herDiaryMod.deleteHint(r),
    });
    /** 她没说出去也得让他知道（跟"网关连不上就替她说一句明白话"同一个规矩）。 */
    const fallback = `我把日记删了 ${r.items.length} 篇：${r.items.map((x) => herDiaryMod.fmtAt(x.at)).join('、')}。`;
    await sendHerWords({ key: target, text: said || fallback, reason: 'diary-alert' });
    return { ok: true, alert: true, items: r.items };
  } catch (err) {
    log.warn(`日记：数删除记录没数成（${err.message}）`);
    return { ok: false, why: err.message };
  } finally {
    diarySweeping = false;
  }
}

/** 她要"翻翻自己的日记"时，把最近几篇原文递给她（不是摘要）。 */
async function recentEntries(n = 3) {
  let agent = null;
  try { agent = ensurePhone(); } catch { agent = null; }
  if (!agent || !agent.adb) return [];
  const rows = await herDiaryMod.list(agent.adb).catch(() => []);
  const out = [];
  for (const r of rows.slice(0, Math.max(1, n))) {
    const body = await herDiaryMod.readEntry(agent.adb, r.name).catch(() => '');
    const clean = String(body || '').split('\n').filter((x) => x && !x.startsWith('# ')).join('\n').trim();
    if (clean) out.push(`· ${r.head || ''}\n${clean}`);
  }
  return out;
}

let diaryWriting = false;

/**
 * 她开始写一篇（**后台跑，不等**：她先说一句"我去写"，手机上再慢慢敲）。
 * @returns {{accepted:boolean, why?:string}}
 */
function startDiaryWrite(goal, key) {
  if (diaryWriting) return { accepted: false, why: '正在写' };
  let agent = null;
  try { agent = ensurePhone(); } catch { agent = null; }
  if (!agent || !agent.adb) return { accepted: false, why: phoneCfg().enabled ? '手机还没亮' : '手机没开着' };
  diaryWriting = true;
  writeDiaryNow({ goal, key: key || targetChatKey(), agent })
    .catch((err) => log.warn(`日记：没写成（${err.message}）`))
    .finally(() => { diaryWriting = false; });
  return { accepted: true };
}

/**
 * 真写一篇：先让她写正文（她自己想，代码不替她起草）→ 分段敲进手机 → 回读核对 → 记账 → 告诉他。
 */
async function writeDiaryNow({ goal, key, agent }) {
  const at = Date.now();
  const st = await herDiaryMod.statusOf(agent.adb, at).catch(() => ({ rows: [], todayCount: 0 }));
  const situation = herDiaryMod.composeSituation({
    today: herDiaryMod.todayLine(at),
    recent: (st.rows || []).slice(0, 2).map((r) => r.gist).filter(Boolean),
  });
  const raw = await herOwnWords({ key, text: '（去本子上写一篇。）', situation });
  const body = herDiaryMod.cleanBody(raw);

  /** ② 不强迫：她说"不写"，那就是不写。不重试、不换一句劝。 */
  if (herDiaryMod.saysNo(body)) {
    log.info('日记：她说今天不想写（那就真的不写）');
    await sendHerWords({ key, text: '今天先不写了。', reason: 'diary' });
    return { ok: true, wrote: false };
  }

  const w = await herDiaryMod.push(agent.adb, body, { log: (m) => log.info(m) });
  if (!w.ok || !w.verified) {
    log.warn(`日记：没写进去（${w.why || '?'}）`);
    await sendHerWords({ key, text: '本子没写成，我等会儿再试。', reason: 'diary' });
    return { ok: false, why: w.why, steps: w.steps };
  }

  /** 一天一篇记一笔就够（不然她的账会被日记淹掉）。 */
  try {
    if (!Number(st.todayCount)) {
      selfKernel.addDoing({
        at,
        what: `写日记：${String(body.split('\n')[0] || '').slice(0, 24)}`,
        where: 'diary',
        flavor: '',
      });
    }
  } catch (err) { log.warn(`日记：没记进她的账（${err.message}）`); }

  log.info(`日记：写好了（${body.length} 字 / ${w.steps} 步 / 回读对上了）`);
  const said = await herOwnWords({
    key,
    text: '（日记写好了。）',
    situation: `你刚在手机上写完了今天这一篇（${body.length} 字），开头是「${String(body).slice(0, 30)}」。`
      + '就一句，别复述全文，也别报字数。',
  });
  await sendHerWords({ key, text: said || '写完了。', reason: 'diary' });
  return { ok: true, wrote: true, chars: body.length, steps: w.steps };
}

function handlePhoneTag(text, key, { kind = '' } = {}) {
  const parsed = phoneAgentMod.parseTag(text);
  if (!parsed.goals.length) return parsed;
  const agent = ensurePhone();
  if (!agent) {
    log.info('手机：她写了 [手机:…] 但手机没开');
    /**
     * ★ 2026-11-08：**这件事不能只留一行日志**。
     *
     * 真机 21:48–21:51：手机根本没开，她自己写了 `[手机:…]`，代码只记一行日志 ——
     * 于是她以为手在动，接着说"已经在点了""一屏都是圆鼓鼓的胖鱼"。
     * 用户（21:54）：「当我要求她用手机的时候，如果手机不在她手上，就让她告诉我
     * （只需要提醒她没手机操作，怎么回复我随她想法）」。
     */
    const why = phoneCfg().enabled ? '手机还没亮' : '手机没开着';
    phoneRefused({ key, refused: parsed.goals.map((g) => ({ goal: g, why })) })
      .catch((err) => log.warn(`手机：没手机也没能回灌（${err.message}）`));
    return parsed;
  }
  /**
   * ★ 2026-11-07：**换手不换人**。
   * 在聊天里让她动手之前，先把当前这一份只读快照交给"手"。
   * 断言不过就**不排**（她已经答应了他，但宁可回一句"等一下"，也不让另一个人格去点）。
   */
  const snap = personaSnapshot();
  const handOK = typeof agent.setPersona === 'function' ? agent.setPersona(snap) : true;
  if (!handOK) {
    log.warn('手机：人格快照对不上，这一条 [手机:…] 不排');
    return parsed;
  }
  if (typeof agent.setBrief === 'function') agent.setBrief({ src: 'chat', personaId: snap.personaId });
  /**
   * ★ 2026-10-31：**一行里写了两件事就都收**（旧版只收 `goals[0]`，第二件直接丢掉）。
   * 队列最多排两件，多写的如实回"没接"。
   * 注意一句话里的"先…再…"不用她写两个标记 —— `phone-agent` 会自己拆段依次做。
   */
  const took = [];
  const refused = [];
  for (const g of parsed.goals.slice(0, 2)) {
    /**
     * ★ 2026-11-11：**写日记走自己的路**（跟看视频一样，不进 `phone-agent` 的逐步循环）。
     *
     * 这件事"想"是她的、"敲"是代码的：先给她一次调用让她写正文（不限字数），
     * 再由 `her-diary.push()` 开本子 → 点「写」→ 分段敲 → 「保存」→ 回读核对。
     * 走 agent 的话，一步一句、每步一张图，一篇 200 字得烧十几次调用。
     */
    if (herDiaryMod.isDiaryGoal(g)) {
      const r = startDiaryWrite(g, key);
      if (!r.accepted) refused.push({ goal: g, why: r.why });
      took.push(`${g} → ${r.accepted ? '去写了' : `没接（${r.why}）`}`);
      continue;
    }
    /**
     * ★ 2026-11-01：**"看视频"走另一条路。**
     *
     * `phone-agent` 是"一步一次模型调用、每步一张图"；看一分钟视频 = 十几次调用、
     * 每次只看一帧，既贵又看不出"这段在讲什么"。所以视频单独交给 `phone-video`：
     * 读标题（0 调用）→ 抽 3 帧判一次 → 她想走就上滑。
     * 它要独占 adb（别的任务正在跑时不能插进来，否则两边抢点击）。
     */
    if (phoneVideoMod.isVideoGoal(g)) {
      const r = startVideoSession(g, key);
      if (!r.accepted) refused.push({ goal: g, why: r.why });
      took.push(`${g} → ${r.accepted ? '去看视频了' : `没接（${r.why}）`}`);
      continue;
    }
    /** 她正在看视频时别插队：两边一起动 adb 会互相点歪。 */
    if (videoRun) {
      /**
       * ★ 2026-11-08 夜（真机 23:16:31）：**「回桌面」不许被"正在看视频"挡回去**。
       *
       * 他喊「那你现在返回首页，返回桌面」，她回「没接（正在看视频）」——
       * 他要的是"现在就回桌面"，而视频那边还在慢慢看。现在：这类"位置/停止"的确定动作
       * **先把视频收掉**（`videoWatch.stop()`，它在下一个检查点收尾），然后照做。
       * 只有"再看点什么"这种可以等的事，才继续拒（两只手抢 adb 会互相点歪）。
       */
      const qk = (() => {
        try { return phoneAgentMod.quickSkill(g) || {}; } catch { return {}; }
      })();
      if (!['home', 'back', 'stop'].includes(qk.kind)) {
        refused.push({ goal: g, why: '正在看视频' });
        took.push(`${g} → 没接（正在看视频）`);
        continue;
      }
      try { videoWatch?.stop?.(); } catch { /* 没停成也照做 */ }
      log.info(`手机：「${g}」是"现在就要"的动作，先把视频那场收掉`);
    }
    const r = agent.enqueue({
      goal: g, by: 'her', key, share: true,
      /** ★ 2026-11-12：raw（他的原话）走单独的预算（15 步 / 150 秒），见 `enqueue()`。 */
      ...(kind ? { kind } : {}),
      brief: { src: 'chat', personaId: snap.personaId },
    });
    if (!r.accepted) refused.push({ goal: g, why: r.why });
    took.push(`${g} → ${r.accepted ? (r.queued ? '排队' : '接了') : `没接（${r.why}）`}`);
  }
  log.info(`手机：她要用手机「${took.join('」「')}」`);
  /**
   * ★ 2026-11-01：没排上就**回灌给她一句**（以前这行信息只进日志，QQ 上什么都没发生）。
   * 放后台、不 await：这一轮的文字（"我去看看"）照常发出去。
   */
  if (refused.length) {
    phoneRefused({ key, refused }).catch((err) => log.warn(`手机：没排上也回灌失败（${err.message}）`));
  }
  return parsed;
}

/* ---------- 她刷视频（2026-11-01） ---------- */

/**
 * 看视频的配置（缺省补齐，老配置里没有 `video` 这一段也能跑）。
 * 参数含义都在 `phone-video.cjs` 的 `DEFAULTS` 里；这里只负责"从 cfg 里取"。
 */
function videoCfg() {
  return phoneVideoMod.normalize((phoneCfg() && phoneCfg().video) || {});
}

/**
 * 同时只跑一场：它**独占 adb**。
 * `phone-agent` 的每一步都是"看一眼 → 点一下"，视频那边每隔几秒也在截图；
 * 两边同时来会互相点歪（对方刚截图，这边已经换了屏）。
 */
let videoRun = null;
/** ★ 2026-11-08 夜：视频那场的句柄 —— 他喊"回桌面"时要能把它收掉（`stop()`）。 */
let videoWatch = null;

/**
 * 开一场"刷视频"（立刻返回，不 await —— 她说完"我去看会儿"就该收工）。
 *
 * 为什么不让它走 `phone-agent`：那是逐步决策，一步一次模型调用、每步只看一帧；
 * 看一分钟视频要十几次调用，还看不出"这段在讲什么"。`phone-video` 是
 * "读标题（0 调用）→ 抽 3 帧判一次 → 她想走就上滑"，一条短视频 ≈ 1.3k token。
 *
 * @returns {{accepted:boolean, why?:string}}
 */
function startVideoSession(goal, key) {
  const c = videoCfg();
  if (!c.enabled) return { accepted: false, why: '看视频没开' };
  if (videoRun) return { accepted: false, why: '还在看上一个' };
  const agent = ensurePhone();
  if (!agent) return { accepted: false, why: '手机没开' };
  if (agent.state().busy) return { accepted: false, why: '手机上正忙着别的' };
  const model = phoneModel();
  const why = whyNotReady(model);
  if (why) return { accepted: false, why: `手机那套模型没配好（${why}）` };

  /**
   * ★ 2026-11-07：**刷视频也是她**。先把同一份快照交给手，再开这场；
   * 快照对不上就不开（不换人）。
   */
  const videoPersona = personaSnapshot();
  if (!applyPersonaToPhone(videoPersona)) return { accepted: false, why: '人格快照对不上' };
  const w = phoneVideoMod.createVideoWatcher({
    adb: agent.adb,
    model,
    callModel,
    taste: phoneCfg().taste,
    persona: videoPersona,
    /** ★ 2026-11-01：视频这条路也用同一份"看图自救"配置（`phone.rescue`）。 */
    cfg: { ...c, rescue: (phoneCfg() && phoneCfg().rescue) || undefined },
    /**
     * ★ 2026-11-02：**跨场次记住"看过哪些"**（他说"换一个视频看"时别再点回同一条）。
     * 放这里而不是 `phone-video` 的模块级变量：那样自检之间会互相污染。
     */
    recent: videoRecent,
    emit: onPhoneEvent,
  });

  /** ★ 2026-11-08 夜：留个句柄 —— 他喊"回桌面/返回"时要把这场收掉（见 `handlePhoneTag`）。 */
  videoWatch = w;
  videoRun = (async () => {
    log.info(`手机视频：开始「${goal}」（最多 ${c.maxVideos} 条 · 每条 ≤${c.maxFramesPerVideo} 帧 · 门槛 ${c.likeMin}）`);    const r = await w.run({ goal, key });
    log.info(`手机视频：${r.ok ? '看了' : '没看成'} —— ${r.summary}`
      + `（${r.calls} 次调用 · ${r.tokens.prompt}+${r.tokens.completion} token · ${Math.round(r.ms / 1000)}s）`);
    try {
      await phoneFollowUp({
        key, ok: r.ok, verb: '刷了会儿视频', summary: r.summary, at: Date.now(),
        screen: (() => { try { return agent.state().screen || ''; } catch { return ''; } })(),
      });
    } catch (err) {
      log.warn(`手机视频：回灌失败（${err.message}）`);
    }
    return r;
  })()
    .catch((err) => { log.warn(`手机视频：跑炸了（${err.message}）`); })
    .finally(() => { videoRun = null; videoWatch = null; });

  return { accepted: true };
}

/** 真窗口：把 MuMu 露出来、摆成竖屏手机的样子（用户选的 UX，不要小面板）。 */function placePhoneWindow(bounds) {
  let area = { x: 0, y: 0, width: 1920, height: 1080 };
  let petBox = bounds;
  try {
    const { screen, BrowserWindow } = require('electron');
    const d = screen.getPrimaryDisplay();
    if (d && d.workArea) area = d.workArea;
    if (!petBox) {
      const wins = BrowserWindow.getAllWindows().filter((w) => w && w.isVisible && w.isVisible());
      const w0 = wins.find((w) => /pet\.html|pet-app/i.test(w.webContents?.getURL?.() || '')) || wins[0];
      if (w0) petBox = w0.getBounds();
    }
  } catch { /* 不是 Electron（自检）：用默认 */ }
  const w = phoneCfg().window || {};
  const width = Math.max(260, Number(w.width) || 430);
  const height = Math.min(Math.max(420, Number(w.height) || 900), area.height - 40);
  const margin = Number(w.margin) || 24;
  let x = area.x + area.width - width - margin;
  let y = area.y + Math.max(0, Math.round((area.height - height) / 2));
  if (petBox && Number.isFinite(petBox.x) && Number.isFinite(petBox.width)) {
    const leftX = Math.round(petBox.x - width - 12);
    const rightX = Math.round(petBox.x + petBox.width + 12);
    const sameY = Math.max(area.y + 8, Math.round(petBox.y + petBox.height - height));
    if (leftX >= area.x + 8) { x = leftX; y = sameY; }
    else if (rightX + width <= area.x + area.width - 8) { x = rightX; y = sameY; }
  }
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
}

let phoneStarting = null;

/** Electron 的显示缩放（`layout_window` 收 DIP、回物理像素，见 phone-adb 的 fitWindow）。 */
function displayDpr() {
  try {
    const { screen } = require('electron');
    const d = screen.getPrimaryDisplay();
    return Number(d?.scaleFactor) || 1;
  } catch {
    return 1;
  }
}

/**
 * ★ 2026-10-30 重做：把手机**真的**弄出来，并且每一步都说清楚。
 *
 * 上一版在这里踩了三个坑，用户点了第 3 挡之后屏幕上什么都没有、日志也只有一行：
 *   ① 安装路径写死（重装到 `D:\mumulvse\...` 后 adb.exe 不存在 → `connect` 10 ms 就失败）；
 *   ② 信了 MuMu 的 `is_process_started`（崩溃后它一直回 true + 死 pid → 不启动，干等 3 分钟）；
 *   ③ `layout_window` 收的是逻辑像素、回的是物理像素，拿 854 跟 430 比 → 永远判"没搬动"。
 * 现在：能连就直接露窗口；不能连就真去启动（多路兜底）；每 2.5 秒报一次"还在开机，几秒了"；
 * 摆好之后按 dpr 核对大小；成功/失败都发事件，页面和气泡都看得见。
 */
async function showPhoneWindow(bounds = null) {
  const agent = ensurePhone();
  if (!agent) return { ok: false, why: phoneCfg().enabled ? '手机模块起不来（看 pet.log）' : '手机没开' };

  // 同一个时刻只允许一条"启动"链（连点两下按钮别拉两个模拟器）
  if (phoneStarting) return phoneStarting;

  phoneStarting = (async () => {
    const box = placePhoneWindow(bounds);
    phoneBootAt = Date.now();
    phoneStageEmit('checking');

    // ---- 一、已经在跑？起得来就直接露窗口，不折腾 ----
    let st = null;
    try { st = await agent.adb.state(); } catch { /* 连不上就是没开 */ }
    let started = false;
    let launchVia = '';
    if (!(st && st.online && st.booted)) {
      const run = await agent.adb.isRunning();
      if (!run.running) {
        phoneStageEmit('launching', { why: run.stale ? 'MuMu 上次崩过，状态是陈旧的' : '' });
        log.info('手机：模拟器没开，正在拉起来（第一次要几十秒）');
        const lp = await agent.adb.launchPlayer({
          onTick: (t) => { if (t && t.via && t.via !== launchVia) { launchVia = t.via; log.info(`手机：交给 ${t.via}`); } },
        });
        if (!lp.ok) {
          const why = lp.msg || '模拟器起不来';
          log.warn(`手机：${why}`);
          phoneStageEmit('fail', { why });
          return { ok: false, why: `模拟器起不来：${why}`, tried: lp.tried || [] };
        }
        started = !lp.already;
        launchVia = lp.via || launchVia;
        bus.emit('phone', { kind: 'boot', at: Date.now(), via: launchVia });
      } else {
        phoneStageEmit('booting', { why: '模拟器在跑，等 Android 起来' });
      }

      // ---- 二、等 Android 真的起来（每 2.5 秒报一次，别让用户干等） ----
      let lastTick = 0;
      const boot = await agent.adb.waitBoot({
        timeoutMs: 180000,
        onTick: (t) => {
          // 最多 5 秒一条，别把页面刷爆
          if (Date.now() - lastTick < 5000) return;
          lastTick = Date.now();
          phoneStageEmit('booting', { elapsed: Date.now() - phoneBootAt, msg: t.msg || '' });
        },
      });
      if (!boot.ok) {
        const why = `Android 没在 3 分钟内起来（${boot.error || '超时'}）`;
        log.warn(`手机：${why}`);
        phoneStageEmit('fail', { why });
        return { ok: false, why, started, via: launchVia };
      }
      log.info(`手机：Android 起来了（${Math.round(boot.ms / 1000)}s，${launchVia || '本来就在跑'}）`);
    } else {
      log.info(`手机：本来就在跑（${st.app?.name || '?'}），直接露窗口`);
    }

    // ---- 三、露窗口 + 摆成竖屏手机的样子 ----
    phoneStageEmit('showing');
    const shown = await agent.adb.showWindow();
    if (!shown.ok) {
      const why = shown.msg || '窗口没露出来';
      log.warn(`手机：${why}`);
      phoneStageEmit('fail', { why });
      return { ok: false, why, started, via: launchVia };
    }
    const fit = await agent.adb.fitWindow(box, { dpr: displayDpr() });
    /**
     * ★ 2026-10-30：摆好之后还要**提到最前面**。`show_window` 不会把窗口拎到全屏窗口之上，
     * 而桌宠自己是置顶的 —— 不抢焦点地提一下，用户才真的"看见手机出来了"。
     */
    const front = await agent.adb.raiseWindow();
    if (!front.ok) log.warn(`手机：窗口没能提到最前（${front.msg || '未知'}），可能被别的窗口挡着`);
    try {
      const now = await agent.adb.state();
      phoneApp = now.app?.name || phoneApp;
    } catch { /* 名字拿不到不影响 */ }

    const bootMs = Date.now() - phoneBootAt;
    phoneStageEmit('ready', {
      box: fit.box || box,
      moved: !!fit.ok,
      bootMs,
      app: phoneApp,
      via: launchVia || (started ? 'launcher' : 'already'),
    });
    /**
     * ★ "她知道"的第二层：能力提示只管**这一轮**；她心里也要留一件事，
     * 这样过一会儿她可能自己提"我手机还亮着呢"。念头池按文本去重，不会刷屏。
     */
    try {
      presenceRt?.mind?.add?.(
        [{ text: '手机在我手边亮着，还没怎么玩', motivation: 3 }],
        { key: targetChatKey(), source: 'phone' },
      );
    } catch { /* 念头池没启动就算了 */ }
    log.info(`手机：窗口就位 ${fit.box ? `${fit.box.width}x${fit.box.height}@${fit.box.x},${fit.box.y}` : '（读不到矩形）'}`
      + `（${fit.ok ? '尺寸对上了' : 'MuMu 没完全接受尺寸，但窗口能用'}；总共 ${Math.round(bootMs / 1000)}s）`);

    return {
      ok: true, box: fit.box || box, moved: !!fit.ok, started, bootMs,
      now: fit.raw || null, via: launchVia || 'already', why: '',
    };
  })().catch((err) => {
    log.warn(`手机：弹窗失败（${err.message}）`);
    phoneStageEmit('fail', { why: err.message });
    return { ok: false, why: err.message };
  }).finally(() => { phoneStarting = null; });

  return phoneStarting;
}

async function hidePhoneWindow() {
  const agent = ensurePhone();
  if (!agent) return { ok: false, why: '手机没开' };
  return agent.adb.hideWindow();
}

/**
 * ★ 2026-10-31：**旧的 `roam.json` 不再写**了。
 *
 * 那套是"5 分钟一跳、从四句写死的话里随机挑一句、做完就忘"，
 * 配额也只有 `{count, day, lastAt}` 三个字段。现在这些全在 `data/companion/phone/life.json`
 * （需求条 / 提案 / 批准数 / 手上的事 / 日记索引），由 `phone-life.cjs` 管。
 * 老文件留在盘上不动，纯粹当历史；`tools/phone-tier.cjs` 之类的老脚本要读也不至于炸。
 */

function targetChatKey() {
  try {
    const k = presenceRt?.machine?.targetKey();
    if (k) return k;
  } catch { /* 自主说话没启动 */ }
  /**
   * ★ 2026-10-31（层 0）：**拿不到"他最近的私聊"不该等于她永远不能自己玩**。
   *
   * 旧版这里直接返回空 → `phoneRoamTick` 回 `no-target` → 一次都不玩。
   * 可"她不打扰他"恰恰是最可能出现 targetKey 为空的时候（刚重启、他还没说话）。
   * 现在退两步：先问配置里的 `chats`，再问 `ownerIds`（私聊键就是 `private:<uin>`）。
   */
  const first = (cfg.chats || []).filter(Boolean)[0];
  if (first && String(first).startsWith('private:')) return String(first);
  const owner = (cfg.ownerIds || []).filter(Boolean)[0];
  if (owner) return `private:${owner}`;
  return '';
}

/**
 * ★ 2026-11-08：**他最近一次说话是什么时候**（QQ 和桌宠/语音都算）。
 *
 * 以前只有 QQ 那条路会 `noteUser()`（`presence` + `phone-life`），桌宠里说话**没人记**：
 * 于是"他说话就把手机放下"（`phone-life.noteUser`）和"他安静了才自己玩"（`quietFor`）
 * 在语音这条路上都是**瞎的** —— 他能对着桌宠说半天，她还在旁边自己刷手机。
 */
let lastHeardAt = 0;
function noteHeard(at = Date.now()) {
  const t = Number(at) || Date.now();
  if (t > lastHeardAt) lastHeardAt = t;
}

/**
 * ★ 2026-11-12：**她上一句说了什么**。
 *
 * 「去吧」这种许可式，只有她刚刚说过「我去转转 / 我这就出去」才算数 ——
 * 今天 20:01 他回「去吧」时，她上一句正是「我这就出去转转」，但旧代码一个字都不看上下文，
 * 于是什么都没发生。这里只留最近一句（QQ 和桌宠都写），不存历史。
 */
let lastHerLine = '';
function noteHerLine(text) {
  const t = String(text || '').replace(/\[[^\]]{0,40}\]/g, '').trim();
  if (t) lastHerLine = t.slice(0, 200);
}

/** 他是不是安静了这么久（自主玩手机要在他不说话的时候）。 */
function quietFor(ms, at = Date.now()) {
  let t = 0;
  try { t = Number(presenceRt?.machine?.lastUserAt?.() || 0); } catch { /* 没启动 */ }
  /** ★ 桌宠/语音说的也算（否则他在桌宠里一直说，自主那边以为他一天没说话）。 */
  if (lastHeardAt > t) t = lastHeardAt;
  if (!t) return true;
  return at - t >= ms;
}

/**
 * ★ 2026-10-31：**她自己的手机生活**（`phone-life.cjs`）。
 *
 * 旧版这里是 5 分钟一跳、从写死的四句话里随机挑一句、做完就忘。
 * 现在这套换成了：需求条 → 想干点什么 → **先请示他** → 他点头才开跑 → 一次会话几件小事
 * → 收尾一条回灌 + 一条日记。接线的活全在这里，判断的活全在 `phone-life.cjs` 里（好测）。
 */
let lifeRt = null;
function ensureLife() {
  if (lifeRt) return lifeRt;
  lifeRt = phoneLifeMod.createPhoneLife({
    dir: path.join(DATA_DIR, 'phone'),
    getCfg: phoneCfg,
    /**
     * ★ 2026-10-31：**懒取，而且要自己把它建起来**。
     * 旧版 `phoneRoamTick()` 里第一句就是 `ensurePhone()`；改写成 `phone-life` 之后如果只返回 `phoneRt`，
     * 开机就停在第 3 挡（配置里 `phone.enabled: true`）的情况下 `phoneRt` 还是 null，
     * `tick()` 会一直回 `no-phone` —— **她一次都不会自己玩**，而且日志里一声不响。
     */
    agentOf: () => ensurePhone(),
    targetKey: () => targetChatKey(),
    isQuiet: (ms) => quietFor(ms),
    say: async ({ key, text, reason }) => {
      const id = String(key).split(':')[1] || '';
      const name = (() => { try { return memory().person(id)?.name || id; } catch { return id; } })();
      /** ★ 2026-11-01：排进同一条发送链（别和回复抢"正在输入"）。 */
      await enqueueSend(key, () => deliverToChat({
        key, isGroup: false, userId: id, name, replyText: text, direct: true, reason: reason || 'phone-life',
      }));
    },
    followUp: (res) => phoneFollowUp(res),
    /** 她手机便签上的字（0 调用，`adb shell cat` 就行）。 */
    readNotes: async () => {
      const agent = phoneRt;
      if (!agent) return '';
      try {
        const r = await agent.adb.sh("cat /sdcard/Documents/便签.txt", { timeout: 8000 });
        return r.code === 0 ? String(r.out || '') : '';
      } catch { return ''; }
    },
    model: () => phoneModel(),
    callModel: (m, messages, opts) => {
      const { callModel } = require('./companion-brain.cjs');
      return callModel(m, messages, opts);
    },
    /**
     * ★ 2026-11-07：**她自己想玩什么**（`CompanionBrain.planPhone`）。
     * 不用 `phone-life.planPrompt` 那段硬编码「你叫小肥鱼，是个普通人」——
     * 那是第二个人格。这里给的是同一份只读快照 + 聊天模型（deepseek-chat）。
     */
    plan: async ({ at, hint = '', theme = '', diary, notes, focus, persona: snap, menu, nightLite = false }) => {
      const model = resolveModel(cfg.model);
      if (whyNotReady(model)) return null;
      const brain = new CompanionBrain({
        memory: memory(), roleText: loadRole(), model, longMemory: null,
      });
      return brain.planPhone({ at, hint: hint || theme, persona: snap, menu, diary, notes, focus, nightLite });
    },
    /** ★ 2026-11-07：**每一场取一次**只读快照（整场沿用，中途不变）。 */
    persona: () => personaSnapshot(),
    /**
     * ★ 2026-11-07：**提案也走她的嘴**。
     * 旧版 `say` 直接把计划模型写的 `plan.ask` 发出去 —— 提案和聊天是两张嘴。
     * 现在交给 `CompanionBrain` 用她的语气说；说成了返回 true（`say` 就不再兜底发一遍）。
     */
    speak: async ({ key, text, plan, reason }) => {
      const id = String(key).split(':')[1] || '';
      const name = (() => { try { return memory().person(id)?.name || id; } catch { return id; } })();
      const model = resolveModel(cfg.model);
      if (whyNotReady(model)) return false;
      const snap = personaSnapshot();
      const same = personaMod.checkSame(snap, 'voice');
      if (!same.ok) { log.warn(`手机：${same.why} —— 提案先不开口`); return false; }
      const brain = new CompanionBrain({
        memory: memory(), roleText: loadRole(), model,
        longMemory: cfg.memory?.enabled === false ? null : longMemory(),
      });
      const situation = [
        `你打算去手机上${plan.goal}（你心里想的是：${plan.why || '随便看看'}）。`,
        personaMod.voiceView(snap, { extra: plan.stopCriteria ? `你觉得这样就算了：${plan.stopCriteria}` : '' }),
        `用你自己的话问他一句能不能去，就一句（你刚才想的是"${text}"）。别写成申请、别复述任务全名。`,
      ].filter(Boolean).join('\n');
      const r = await brain.reply({
        userId: id,
        userName: name,
        text: '（你想开口问他一句。）',
        situation,
        platform: 'QQ',
        where: key,
        unsolicited: true,
        persona: snap,
        /** ★ 2026-11-07：提案是她问他的话（不是手机进度），读回看时不能被过滤掉。 */
        kind: 'chat',
      });
      const said = String(phoneAgentMod.parseTag(String(r.text || '')).text || r.text || '').trim();
      if (!said) return false;
      await enqueueSend(key, () => deliverToChat({
        key, isGroup: false, userId: id, name, replyText: said, direct: true, reason: reason || 'phone-propose',
      }));
      return true;
    },
    noteSelf: (text, opts) => { try { selfNotes.add([text], opts || {}); } catch { /* 写不进去不影响 */ } },
    emit: (ev) => bus.emit('phone', ev),
    log,
  });
  return lifeRt;
}

/**
 * 自主用手机的心跳：**1 分钟看一次**（`phone-life` 内部自己判冷却/配额/时段）。
 * 旧版 5 分钟一跳，一次会话里的"两件之间歇一下"就没法准时。
 */
let roamTimer = null;
function startPhoneRoam() {
  if (roamTimer) return;
  const p = phoneCfg();
  if (!p.enabled || !p.autonomy?.enabled) return;
  ensureLife();
  roamTimer = setInterval(() => {
    if (!cfg.enabled || cfg.respond === false) return;
    try {
      const r = phoneLifeTick();
      if (r && r.ok && r.doing) { /* 会话在跑，安静 */ }
    } catch (err) { log.warn(`手机：自主用手机出错（${err.message}）`); }
  }, 60_000);
  roamTimer.unref?.();
}
function stopPhoneRoam() {
  if (roamTimer) {
    clearInterval(roamTimer);
    roamTimer = null;
  }
}

/** 手动推一次（自检/调试用；正式跑由 60 秒的心跳调）。 */
function phoneLifeTick(at = Date.now()) {
  return ensureLife().tick(at);
}



function chatAllowed(key) {
  const list = (cfg.chats || []).filter(Boolean);
  return !list.length || list.includes(key);
}

function handleInbound(msg) {
  if (!running || cfg.adapter !== 'builtin') return;
  // 桌宠大脑挡：连接保持，但不通讯（不记、不回、不冒手机面板）
  if (cfg.respond === false) return;
  if (!chatAllowed(msg.key)) return;
  /**
   * ★ 2026-11-02：**先把语音听懂，再决定醒不醒 / 怎么回**。
   *
   * `doubao-seed-2-1-lite` 不是流式模型，一条语音要 2~5 秒才转写完，所以这里
   * **挂起这一条**（不丢），转写完再拿同一条消息重新走一遍 `handleInbound`。
   * `asrDone` 是防重入的标记（转写完的第二趟不会再进这个分支）。
   *
   * 没配 Key / 功能关着时如实降级成 `[语音]`：她只会看到"他发了条语音"，
   * 总比装作听懂了强。
   */
  if (Array.isArray(msg.records) && msg.records.length && !msg.asrDone) {
    msg.asrDone = true;
    const acfg = asrCfg();
    if (asrMod.ready(acfg)) {
      log.info(`语音：收到 ${msg.records.length} 段语音，正在转写…（${msg.isGroup ? '群' : '私聊'}）`);
      transcribeInbound(msg)
        .catch((err) => log.warn(`语音：转写这条出错（${err.message}）`))
        .then(() => {
          try { handleInbound(msg); } catch (err) { log.warn(`语音：转写后的处理出错（${err.message}）`); }
        });
      return;
    }
    log.info(acfg.enabled
      ? '语音：收到语音，但语音识别没配 Key（config\\voice-asr.json → ark.apiKey），当 [语音] 处理'
      : '语音：收到语音，但语音识别关着（config\\voice-asr.json → enabled），当 [语音] 处理');
  }
  /**
   * ★ 2026-10-26：**纯图片也要理**。以前这里把"没文字、不是戳"的消息直接丢掉，
   * 所以别人发一张图她完全不知道；现在只要带了图就继续走唤醒/回复。
   */
  const imageCount = Array.isArray(msg.images) ? msg.images.length : 0;
  const mfaceCount = Array.isArray(msg.mfaces) ? msg.mfaces.length : 0;
  if (!msg.text && !msg.isPoke && !imageCount && !mfaceCount) return;

  const verdict = shouldWake(msg, cfg);
  const isOwner = (cfg.ownerIds || []).map(String).includes(String(msg.userId));
  const direct = !msg.isGroup || msg.isAtMe || msg.isPoke || isOwner;
  /**
   * ★ 2026-10-31：**他说话了 → 她先把手机放下**（会话挂起，等他再安静 90 秒才接着做）。
   * 这一条比"会话很连贯"重要：他主动找她的时候，她不能还惦记着刷手机。
   */
  if (!msg.isGroup && isOwner) {
    try { ensureLife().noteUser({ at: msg.time || Date.now() }); } catch { /* 没起过就算了 */ }
  }
  /** ★ 2026-11-08：QQ 这边说的也要进"他最近说话"那一份（`quietFor()` 两条路共用）。 */
  noteHeard(msg.time || Date.now());
  // 自主说话：他说话了 → 沉默清零、"欠的那句"一笔勾销（私聊才跟）
  try {
    presenceRt?.machine.noteUser({ key: msg.key, at: msg.time || Date.now(), preferred: isOwner });
    if (presenceRt) savePresenceSoon();
  } catch { /* 状态坏了不该影响回复 */ }
  const shown = cfg.mirror === 'all' || verdict.wake;
  if (shown) {
    emitEvent({
      type: 'inbound',
      at: msg.time,
      key: msg.key,
      isGroup: msg.isGroup,
      userId: msg.userId,
      name: msg.name,
      text: msg.text || (msg.isPoke ? '[戳一戳]' : (imageCount ? '[图片]' : (mfaceCount ? '[表情]' : ''))),
      images: imageCount,
      mfaces: mfaceCount,
      atMe: !!msg.isAtMe,
      poke: !!msg.isPoke,
      reason: verdict.reason,
      direct,
    });
  }
  if (!verdict.wake) {
    /**
     * ★ 2026-11-01：**"引用她那句话"的消息不能当场丢**。
     * `isQuoteMe` 要再查一次 `get_msg`（放后台，见 `applyQuoteCheck`），
     * 查回来之前 `shouldWake()` 只知道"群里没人叫她" —— 于是这种消息以前被直接丢掉。
     * 现在挂起一小会儿（有上限），查回来真是"引的她"就照常进合并窗口。
     */
    const qid = String(msg.messageId || '');
    if (msg.replyTo && !msg.isQuoteMe && qid && !quotePending.has(qid)) {
      const timer = setTimeout(() => {
        quotePending.delete(qid);
        log.info(`陪伴：引用没查清（${verdict.reason || '?'}），当没醒`);
      }, QUOTE_WAIT_MS);
      timer.unref?.();
      quotePending.set(qid, { msg, reason: verdict.reason, timer });
      log.info('陪伴：这条是引用，先查一下是不是在跟她说话');
      return;
    }
    if (!msg.isGroup) log.info(`陪伴：没醒（${verdict.reason || '?'}）`);
    return;
  }

  // 合并窗口：等人把话说完再回，别一句一句追着答
  const win = Math.max(50, Number(msg.isGroup ? cfg.wake.groupWindowMs : cfg.wake.privateWindowMs) || 1500);
  const items = batchItems.get(msg.key) || [];
  items.push({ ...msg, reason: verdict.reason });
  batchItems.set(msg.key, items);
  clearTimeout(batchTimers.get(msg.key));
  const timer = setTimeout(() => flushBatch(msg.key), win);
  timer.unref?.();
  batchTimers.set(msg.key, timer);
}

/**
 * ★ 2026-11-01：**同一个会话的"发出去"排成一条链**。
 *
 * 以前只有 `flushBatch`（回复那条路）会占 `busy`，而她**自己开口**（`speakSpontaneously`）
 * 和手机回灌（`phone-life` 的 `say`）都直接调 `deliverToChat` —— 于是
 * "你正在等的那句回复"和"她主动说的那句"会**同时发**、交替踩"正在输入"，
 * 而你看到的顺序取决于谁先发完（发送要 10~25 秒的拟人节奏，窗口很大）。
 * 现在三条路共用这一条链：先排着，一个说完再说下一个。
 *
 * 返回的 Promise **会把错误抛给调用方**（自主说话要靠它回滚配额），
 * 但存进 `busy` 的是"不会 reject 的版本"，否则一次失败会让整条链永久卡住。
 */
function enqueueSend(key, fn) {
  const k = String(key || '');
  const prev = busy.get(k) || Promise.resolve();
  const run = prev.then(() => fn());
  const guard = run.then(() => {}, () => {});
  busy.set(k, guard);
  guard.then(() => { if (busy.get(k) === guard) busy.delete(k); });
  return run;
}

/**
 * ★ 2026-11-01：**她想的时候，QQ 上也要有"正在输入"**。
 *
 * 以前只有 `deliverToChat` 在**发**每条文字之前才点亮 typing —— 而模型那 3~10 秒
 * QQ 上一点动静都没有（手机面板有 `thinking`，他那边是空的），看着像"人不在"。
 * 现在 `flushBatch` 在**调模型之前**点亮一次，一直亮到这一批发完；
 * 返回的 `stop()` 在 `finally` 里关（抛错也会关），可以重复调用。
 */
function beginTyping(key) {
  let on = true;
  const isGroup = String(key).startsWith('group:');
  const off = () => {
    if (!on) return;
    on = false;
    try { emitEvent({ type: 'typing', key, isGroup, on: false }); } catch { /* 没启动 */ }
    try { client?.setTyping(key, false).catch(() => {}); } catch { /* 同上 */ }
  };
  if (client && connected) {
    try { emitEvent({ type: 'typing', key, isGroup, on: true }); } catch { /* 没启动 */ }
    try { client.setTyping(key, true).catch(() => {}); } catch { /* 网关不支持 */ }
  }
  return off;
}

/**
 * ★ 2026-11-03：**模型抖一下，不让这句话就这么没了**。
 *
 * 用户报的现象：麦克风里说话她不接、QQ 上发消息也不回 —— 查日志是 DeepSeek 连续回
 * `HTTP 503 Service is too busy`。现在 `companion-brain.callModel` 会自己重试 4 次
 * （约 6.5 秒）；这之外，QQ 这条**还会再自动补两次**（15 秒、45 秒后），
 * 因为这批话他其实还在等，而桌宠气泡没法这么补（补出来时间已经对不上了）。
 *
 * 只有"明确是暂时性失败"（429/5xx/网络）才补；401/403/404 补多少次都一样，直接说清楚。
 */
/**
 * 自动补发的节奏。**只给自检改**（`test/regions/09-companion.cjs` 会把它压到几十毫秒，
 * 否则验一次"自动补发"要真坐等 15 秒）；正式运行别动它。
 */
const retryPolicy = { batchWaits: [15_000, 45_000], noticeGapMs: 5 * 60_000 };
/** key → { count, timer, items }：正在等一次自动补发的批次。 */
const batchRetry = new Map();
const failNoticeAt = new Map();

function flushBatch(key, tries = 0) {
  clearTimeout(batchTimers.get(key));
  batchTimers.delete(key);
  let items = batchItems.get(key) || [];
  batchItems.delete(key);
  /**
   * 上一批因为模型抖了还没发出去：**把它一起带上**（不能丢、也不能让它单独补一句
   * 跟新话对不上的回复）。见 `batchRetry` 的注释。
   */
  const waited = batchRetry.get(key);
  if (waited) {
    clearTimeout(waited.timer);
    batchRetry.delete(key);
    items = [...waited.items, ...items];
    tries = Math.max(tries, waited.count);   // 补发次数要跨批累计，别每批都从 0 开始
  }
  if (!items.length) return;

  const last = items[items.length - 1];
  /** 走共用的那条链（和"她自己开口""手机回灌"排在一起，见 `enqueueSend`）。 */
  enqueueSend(key, async () => {
    const stopTyping = beginTyping(key);
    try {
      const out = await replyBatch(items);
      batchRetry.delete(key);          // 这次真发出去了：把等补发的记录清掉
      return out;
    } finally {
      stopTyping();
    }
  }).catch((err) => {
    lastError = err?.message || String(err);
    const retryable = err?.retryable === true;
    const done = Number(tries) || 0;
    if (retryable && done < retryPolicy.batchWaits.length) {
      const count = done + 1;
      const wait = retryPolicy.batchWaits[done];
      const waitText = wait >= 1000 ? `${Math.round(wait / 1000)} 秒` : `${Math.round(wait)} 毫秒`;
      log.warn(`陪伴回复失败（${key}）：${lastError}；${waitText}后自动补这一句（第 ${count}/${retryPolicy.batchWaits.length} 次）`);
      emitEvent({ type: 'outbound-retry', key, isGroup: last?.isGroup, attempt: count, waitMs: wait, reason: lastError });
      const timer = setTimeout(() => {
        const rec = batchRetry.get(key);
        if (!rec || rec.count !== count) return;      // 已经被新的一批顶掉了
        batchRetry.delete(key);
        batchItems.set(key, [...rec.items, ...(batchItems.get(key) || [])]);
        flushBatch(key, count);
      }, wait);
      timer.unref?.();
      batchRetry.set(key, { count, timer, items });
    } else {
      batchRetry.delete(key);
      log.warn(`陪伴回复失败（${key}）：${lastError}`);
      emitEvent({ type: 'outbound-failed', key, isGroup: last?.isGroup, reason: lastError });
      notifyModelDown(key, last);
    }
    emitState();
  });
}

/**
 * 模型真的一直连不上时，**替她说一句人话**（不走模型）。
 *
 * 以前这里只有一行 WARN：他在 QQ 那头什么都看不到，会以为"她不理我了 / 程序坏了"。
 * 现在最多 5 分钟说一次，明说"我这边连不上"，重启后照样只写日志。
 */
function notifyModelDown(key, last) {
  const at = failNoticeAt.get(key) || 0;
  if (Date.now() - at < retryPolicy.noticeGapMs) return;
  failNoticeAt.set(key, Date.now());
  const id = String(key).split(':')[1] || '';
  enqueueSend(key, () => deliverToChat({
    key,
    isGroup: !!last?.isGroup,
    userId: String(last?.userId || id),
    name: last?.name || id,
    replyText: '我这边暂时连不上，等我一会儿。',
    direct: true,
    reason: 'model-down',
    catalog: [],
    voicePlan: { mode: 'none' },
  })).catch((err) => log.warn(`陪伴：想告诉他"我这边连不上"，也没发出去（${err.message}）`));
}

/**
 * 「存表情 晚安」/「收藏这个 晚安」/「把这个收起来」→ 关键词；不是命令返回 null。
 * 只在整句匹配时生效，日常聊天里出现「收藏」两个字不会误触发。
 *
 * ★ 2026-11-01 修：**"收到" 曾经被当成收藏命令**（关键词变成「到」）。
 *
 * 原来那个正则的尾巴 `([^\s，。！？]{0,16})` 会把**动词的补语**当成关键词，实测：
 *   `收到→"到"`、`收到了→"到了"`、`存了→"了"`、`收下→"下"`、`收起来→"起来"`。
 * 后果两种，都很难看：
 *   · 10 分钟内有图 → 把**上一张图**悄悄存成「到」；
 *   · 手边没图 → 在处境里告诉模型"他想让你收藏但没图，问他是哪一张"，
 *     于是她对着你一句"收到"回"你发的是哪张图？"。
 *
 * 现在：关键词要么带明确宾语（表情/图片/图/这个/这张，此时关键词可以为空 = 表情），
 * 要么**至少两个字且不是动词补语**（见 `COLLECT_VERB_TAIL`）。顺带把
 * 「存一下 晚安」这种带"一下"的说法也认了（以前识别不到）。
 */
const COLLECT_VERB_TAIL = new Set(['到', '到了', '了', '下', '下来', '起来', '起', '藏', '藏着', '好', '好了', '完了', '完', '过', '吧', '啊', '呀', '哦', '呢', '的']);

function collectCommand(text) {
  const s = String(text || '').trim();
  const m = s.match(/^(?:存下|存|收藏|收下|收起来|收起|收)\s*(?:一下|这个|这张|下这个|个)?\s*(?:表情包?|图片?|图)?\s*[:：]?\s*([^\s，。！？]{0,16})$/);
  if (!m) return null;
  const tag = String(m[1] || '').trim();
  if (tag && (COLLECT_VERB_TAIL.has(tag) || [...tag].length < 2)) return null;
  return tag;
}

/**
 * ★ 2026-10-28：**最近一次收到的图/表情**。
 *
 * 用户经常"先发一张图，下一句才说'你存一下'"。如果只认当前这一批，
 * 那句"存一下"手里是空的 —— 实测（2026-10-28 19:28）她就嘴上说"存了"，什么都没存。
 * 所以按会话记住 10 分钟内的最后一批图/表情，"存一下"能接上。
 */
const LAST_MEDIA_MS = 10 * 60_000;
const lastMedia = new Map();
function rememberMedia(key, pics, mfaces, at = Date.now()) {
  if (pics.length || mfaces.length) {
    lastMedia.set(key, { pics, mfaces, at });
    return { pics, mfaces };
  }
  const old = lastMedia.get(key);
  if (old && at - old.at < LAST_MEDIA_MS) return old;
  return { pics: [], mfaces: [] };
}

/**
 * ★ 2026-11-01：**让她从网关拿图，而不是拿着 QQ 的下载地址去下**。
 *
 * 真机根因（实测，不是猜）：QQ 在 OneBot 的 `image` 段里给的 `url` 是
 * `https://gchat.qpic.cn/download?appid=…&rkey=…`，而那个地址**会过期** ——
 * 拿它去下，不管换什么 UA / 加不加 Referer，回的都是
 * ```
 * HTTP 400 {"retcode":-5503007,"retmsg":"download url has expired"}
 * ```
 * （四条路都试过。10:08 那两张图就是这么丢的。）
 *
 * 而 `get_image` 只要传那个 `file` 名就行：NapCat 用自己手里的有效凭据把图取到本机，
 * 回一个**绝对路径**（实测 1.3MB 真 JPEG）。同一条消息用两条腿走，这条永远不撞过期。
 *
 * @returns {Promise<{buf:Buffer, mime:string}|null>} 拿不到返回 null（交给后面的兜底）
 */
async function imageViaGateway(img) {
  if (!client || !connected || !img) return null;
  const file = String(img.file || '');
  if (!file) return null;
  const r = await client.call('get_image', { file }, 20_000);
  if (!r || !r.ok) throw new Error(r?.error || 'get_image 失败');
  const data = r.data && typeof r.data === 'object' ? r.data : {};
  /** NapCat 4.18.41 实测回的是本地绝对路径；也兼容网关只给 base64 / 只给新地址的情况。 */
  if (data.file && path.isAbsolute(String(data.file))) {
    return media.readLocalImage(String(data.file));
  }
  if (data.base64) {
    const buf = Buffer.from(String(data.base64).replace(/^base64:\/\//, ''), 'base64');
    const mime = media.sniffMime(buf);
    if (!mime) throw new Error('网关给的字节不是图');
    return { buf, mime };
  }
  if (data.url) {
    return media.fetchImage(String(data.url));
  }
  return null;
}

async function replyBatch(items) {
  const last = items[items.length - 1];
  const key = last.key;
  const text = joinBatch(items);
  /**
   * ★ 2026-10-26：把这一批里的图都收进来（最多 3 张）。
   * 单张下载失败只记日志，不影响文字回复；图片本体按内容哈希缓存，重发同一张不重复下载。
   */
  const rawImages = items
    .flatMap((it) => (Array.isArray(it.images) ? it.images : []))
    .slice(0, media.MAX_IMAGES);
  let pics = [];
  if (rawImages.length) {
    /** 先走网关（`get_image`，本机、不过期），再退回原始地址 —— 见 `imageViaGateway` 的注释。 */
    pics = await media.resolveImages(path.join(DATA_DIR, 'media'), rawImages, { viaGateway: imageViaGateway });
    if (pics.length) log.info(`陪伴：收到 ${pics.length} 张图（${pics.map((p) => p.hash).join(',')}）`);
    /**
     * ★ 2026-11-01：**有几张没拿到**要告诉她。
     * 不告诉的话，她看到正文里的 `[图片]` 占位符就会顺着对话编图里的内容
     * （真机：`下载图片失败 HTTP 400` 之后她回"画面里看着像是一道菜"）。
     * 能力注册表据此注入 `vision-failed` 那条提示（见 `companion-capabilities.cjs`）。
     */
    if (pics.length < rawImages.length) {
      log.warn(`陪伴：这一轮有 ${rawImages.length - pics.length}/${rawImages.length} 张图没拿到，这一轮不装作看见了`);
    }
  }
  /** 同一批里的 QQ 商城表情（mface）：她可以收藏，也可以原样发回去。 */
  const mfaces = items
    .flatMap((it) => (Array.isArray(it.mfaces) ? it.mfaces : []))
    .slice(0, 3);

  /**
   * 当前这一批没有图，但上一句刚发过：把"存一下"要存的那张接上。
   * 收藏/发表情都用这一份（`mediaNow`），不再各看各的。
   */
  const mediaNow = rememberMedia(key, pics, mfaces);

  /**
   * ★ 2026-10-28：称呼用**人物账里的名字**（「小主」），不是 QQ 昵称（「✏️」）。
   * 昵称会变、还可能是个图标；名字是他自己认下的。人物账里没有才退回昵称。
   */
  const personName = (() => {
    try { return memory().person(last.userId).name || last.name; } catch { return last.name; }
  })();

  let situation = last.isGroup
    ? '你在一个 QQ 群里。下面是群里刚连着说的几句话，最后一条是最新的。'
    : `你在跟 ${personName || '对方'} 私聊。`;

  /**
   * ★ 2026-11-02：**这一批里有语音**。
   *
   * 两件事都从这里分出去：
   *   ① 处境里补一句"他是用语音说的 + 听起来什么语气"（转写拿到的 emotion/tone）；
   *   ② 回复也改用语音（见下面的 `vPlan`）—— 这就是用户要的"语音对话"：
   *      QQ 的**语音通话** NapCat/OneBot 接不了（协议里没有 call 事件），
   *      所以做成一来一回的语音消息对讲，她"听得见 + 说得出"。
   */
  const voiceIn = items.filter((it) => it && it.voiceMeta && (it.voiceMeta.lines || []).length);
  const vHint = voiceSituation(items);
  if (vHint) situation += vHint;

  /**
   * ★ 2026-11-08：**这一段抽成了 `phoneIntentHints()`，桌宠那条路也用同一份**。
   *
   * 原来这里有四块（点头开跑 / 他的手机指令 / 问屏 / 停与去玩），只有 QQ 有；
   * 桌宠（打字 + 语音）一个都没有 —— 所以他说「先别玩了」「我来操作」她照样让手机点下去。
   * 判断逻辑一个字没改，只是搬到共用函数里（改一处两条路一起生效）。
   */
  const isOwnerNow = (cfg.ownerIds || []).map(String).includes(String(last.userId));
  const ph = await phoneIntentHints({
    text: String(last.text || ''),
    key,
    isOwner: isOwnerNow,
    isGroup: !!last.isGroup,
    phoneUp,
    at: Date.now(),
  });
  if (ph.answer) situation += ph.answer;
  if (ph.stopHint) situation += ph.stopHint;
  if (ph.playHint) situation += ph.playHint;
  if (ph.aboutScreen) situation += ph.aboutScreen;
  /** ★ 2026-11-08：他要她用手机、可她手上没有 → 当场告诉她（怎么回随她）。 */
  if (ph.noPhone) situation += `\n${ph.noPhone}`;
  const phoneCmd = ph.cmd;
  if (ph.raw) {
    /**
     * ★ 2026-11-12（P0）：**raw 已经排上了，不再让她写标记**（写半句反而会盖掉整句）。
     */
    situation += `\n（他这句话已经替你排上了（原句：「${ph.raw.goal}」）。回一句就行，`
      + '没做完就别说已经做完了；做完会再告诉你。）';
  } else if (phoneCmd) {
    const all = ph.cmdText || phoneCmd.goal;
    situation += `\n（他这句是让你在手机上做「${all}」。手机就在你手上：想动手就单独写一行 [手机:${all}]，`
      + '写了就会真的去做；没做就别说已经做完了。）';
  }

  // 「记住：……」：先落一条长期记忆，再把这件事作为处境告诉模型。
  const remembered = rememberFromText({
    text: last.text,
    personId: last.userId,
    userName: last.name,
    where: key,
  });
  if (remembered) situation += `\n（对方刚让你记住：${remembered.body}。可以自然地说一句你记下了。）`;

  /**
   * 用户直接命令收藏（“存表情 晚安”）：先存下来，再把这件事作为处境告诉模型。
   * 这样回复是模型自己说的，不是硬编码一句“已收藏”。
   */
  // 正文里会带 `[图片]` / `[表情]` 占位符；判断"存表情 xxx"之前先摘掉
  const cmdTag = collectCommand(String(last.text || '').replace(/\[(?:图片|表情|戳一戳)\]/g, ''));
  let collected = null;
  if (cmdTag !== null) {
    try {
      const tag = cmdTag || '表情';
      collected = mediaNow.pics.length
        ? stickers.collectImage(STICKER_DIR, mediaNow.pics[0].file, tag)
        : (mediaNow.mfaces.length ? stickers.collectMface(STICKER_DIR, mediaNow.mfaces[0], tag) : null);
    } catch (err) {
      log.warn(`表情：用户让收藏，但没存成（${err.message}）`);
    }
    situation += collected
      ? `\n（对方刚把这张收藏成了「${collected.tag}」，可以自然地说一句你收好了。）`
      : '\n（对方想让你收藏，但这条消息里没有图或表情；可以问他发的是哪一张。）';
  }

  const model = resolveModel(cfg.model);
  const brain = new CompanionBrain({
    memory: memory(),
    roleText: loadRole(),
    model,
    longMemory: cfg.memory?.enabled === false ? null : longMemory(),
  });
  const cat = stickers.catalog(STICKER_DIR, QQ_STICKER_DIR);
  const stickerTags = [...new Set(cat.map((x) => x.tag))].slice(0, 40);
  /**
   * ★ 2026-11-01：这一条要不要用声音。**只决定"用不用"**，说什么仍由她写。
   * 他要听 → voice；夜里/情绪由头 → mixed；其余 none（照常打字）。
   *
   * ★ 2026-11-02：**他用语音说的 → 她也用语音回**（`voice.asr.reply.voice`，
   * 默认 `auto`）。这样 QQ 上就是一问一答的语音对讲；`never` 退回原来的概率，
   * `always` 是每条都念（除非 TTS 没配好 —— 那种情况这里会照旧退回打字）。
   */
  let vPlan = planVoice({ text, isGroup: last.isGroup, at: Date.now() });
  const asrReply = asrCfg().reply.voice;
  /**
   * ★ 2026-11-02（用户补充）：**回文字还是回语音，全凭她自己意愿**。
   *
   * 所以默认 `free` 时这里**什么都不做** —— 她还是按 `decide()` 的递话筒
   * 和自己写的 `[语音]` 来；只有显式选了 `always`（"语音对讲"）才强制语音。
   */
  const wantVoiceBack = asrReply === 'always';
  if (wantVoiceBack && (!last.isGroup || voiceCfg().allowGroups)) {
    const vc = voiceCfg();
    if (vc.enabled && vc.tts.apiKey) {
      vPlan = { mode: 'voice', why: 'always', enabled: true, maxChars: vc.tts.maxChars };
      log.info('语音：reply.voice=always，这一条也用语音回');
    }
  }
  const r = await brain.reply({
    userId: last.userId,
    userName: personName,
    text,
    images: pics,
    /** 这一轮有几张图没拿到（让她的提示词里多一条"你没看见，别编"）。 */
    imagesDropped: rawImages.length - pics.length,
    stickerTags,
    canCollect: mediaNow.pics.length > 0 || mediaNow.mfaces.length > 0,
    situation,
    platform: 'QQ',
    where: key,
    phone: phoneState(),
    voice: vPlan,
  });
  // 后台整理长期记忆；不 await，也不影响这条回复发出去。
  try {
    memoryScribe().afterTurn({ personId: last.userId, personName: last.name, where: key });
  } catch (err) {
    log.warn(`长期记忆：整理调度失败（${err.message}）`);
  }

  /**
   * ★ 2026-10-26：模型自己决定收藏 —— 回复里写 `[收藏:晚安]`。
   *
   * ★ 2026-10-28：她经常只在嘴上说"存了"，却不写这行（实测 19:28）。
   * 所以补一条兜底：这句确实是在让她存（"存一下/收藏"）而且手里有图/表情，
   * 就把**最近那张**替她存下来，关键词取她/用户的，取不到就叫「表情」。
   * 这样"存了"才是真的存了，而不是一句空话。
   */
  const col = stickers.parseCollect(r.text);
  let replyText = col.text;
  /**
   * ★ 2026-10-30：她要用手机 —— 摘掉 `[手机:…]`，丢给 `phone-agent` 在后台做，
   * **这一轮不等**：剩下的文字照常发出去（"我去看看"），做完再回灌。
   *
   * ★ 2026-11-07：**她没写标记、但主人的话本来就是一 条明确手机指令时，替她排上。**
   * 她可能觉得"我嘴上应一声就行"，可用户要的是手机真的动（11-07 20:08 就是这么卡住的）。
   *
   * ★ 2026-11-08（R2）：**他的"确定动作"赢过她的标记**。
   * 真机 23:35:19：他说「不是你先返回首页吧」，她同时写了 `[手机:搜小肥鱼]`，
   * 以前"她有标记就先执行她的"，于是手机去搜小肥鱼 —— 他的指令被她的标记盖掉了。
   * 现在这类（回桌面/返回/翻/读/点/截图）**只排他的**，她那行只摘掉、不排（并记一行日志）。
   */
  let phoneGoals = [];
  if (replyText.includes('[手机')) {
    /**
     * ★ 2026-11-08（R-A）：**她那句比代码认出来的更完整时，让她赢**。
     *
     * 他 22:01 说了「打开浏览器，搜小肥鱼表情包，然后找自己喜欢的网址点进去挑」，
     * 旧的 `ownerCommand` 只从第一小句认出「打开浏览器」，而 `open` 又在 `DETERMINISTIC` 里 →
     * 她那句 `[手机:打开浏览器搜小肥鱼表情包]` 被摘掉、不入队；她手里只剩"打开浏览器"，
     * 剩下的全靠猜（点搜索框 → 打"小猫" → 存图）。
     * 两道闸：① `DETERMINISTIC` 收窄（App 打开不再算"确定动作"）；
     *        ② `coversHim()` —— 她写的目标里已经含有他那件事，就别拿他的半句去压她的整句。
     */
    const hers = phoneAgentMod.parseTag(replyText).goals || [];
    /**
     * ★ 2026-11-12（P0）：**raw 是"他的原话"，优先级高于她概括的那半句。**
     *
     * 她写 `[手机:回桌面]` 只是这句话的一种理解，不能反过来把整句盖掉
     * （真机 21:51：「现在试试去手机桌面看我给你写的日记」→ 她只写了"回桌面"，"看日记"就丢了）。
     * 所以 raw 存在时直接赢，**不走 `coversHim` 的 token 猜法**（那会把"看看"这种尾巴判丢）。
     */
    const rawWins = !!(phoneCmd && phoneCmd.kind === 'raw');
    let hisWins = rawWins || !!(phoneCmd && phoneIntent.DETERMINISTIC.has(phoneCmd.kind));
    if (hisWins && !rawWins && hers.length && hers.some((g) => phoneIntent.coversHim(g, phoneCmd))) {
      hisWins = false;
      log.info(`手机：他这句是「${phoneCmd.goal}」，但她的「${hers.join('、')}」已经包含这件事，按她的办`);
    }
    if (hisWins) {
      const parsed = phoneAgentMod.parseTag(replyText);
      replyText = parsed.text;
      if (hers.length) log.info(`手机：他这句是「${phoneCmd.goal}」，她写的「${hers.join('、')}」这一轮不排（他的算）`);
      if (!replyText) replyText = '我去弄一下。';
    } else {
      const before = replyText;
      const parsed = handlePhoneTag(replyText, key);
      replyText = parsed.text;
      phoneGoals = parsed.goals || [];
      if (!replyText && before !== replyText) replyText = '我去看看。';
    }
  }
  if (!phoneGoals.length && phoneCmd) {
    try {
      const parsed = handlePhoneTag(`[手机:${phoneCmd.goal}]`, key, { kind: phoneCmd.kind === 'raw' ? 'raw' : '' });
      phoneGoals = parsed.goals || [];
      log.info(`手机：他没写标记，替他排上「${phoneCmd.goal}」（原话：${String(last.text || '').slice(0, 30)}）`);
    } catch (err) { log.warn(`手机：兜底入队失败（${err.message}）`); }
  }
  /**
   * ★ 2026-11-12：**一句话里剩下的那几件也要排上**。
   * 真机 21:32「你回桌面，看看日记本」：她写了 `[手机:回桌面]`，后半句就丢了。
   * 这里把 `ownerCommands()` / `phone-gate` 认出来的、她还没覆盖的，补排到队列后面。
   *
   * ★ 2026-11-12（P0）：**raw 单独排**（它要单独的预算：15 步 / 150 秒），别和"确定动作"混在一件里。
   */
  if (phoneCmd && Array.isArray(ph.wants) && ph.wants.length) {
    const rest = ph.wants.filter((c) => !phoneGoals.some((g) => phoneIntent.coversHim(g, c)));
    const restRaw = rest.filter((c) => c.kind === 'raw');
    const restPlain = rest.filter((c) => c.kind !== 'raw');
    if (restPlain.length) {
      try {
        const parsed = handlePhoneTag(`[手机:${restPlain.map((c) => c.goal).join('，')}]`, key);
        phoneGoals = phoneGoals.concat(parsed.goals || []);
        log.info(`手机：他这句里还有「${restPlain.map((c) => c.goal).join('，')}」，一起排上`);
      } catch (err) { log.warn(`手机：剩下的那几件没排上（${err.message}）`); }
    }
    if (restRaw.length) {
      try {
        const parsed = handlePhoneTag(`[手机:${restRaw.map((c) => c.goal).join('，')}]`, key, { kind: 'raw' });
        phoneGoals = phoneGoals.concat(parsed.goals || []);
        log.info(`手机：他这句的原话也排上了「${restRaw.map((c) => c.goal).join('，')}」`);
      } catch (err) { log.warn(`手机：原话那件没排上（${err.message}）`); }
    }
  }
  let collectedByHer = null;
  let tag = col.tags[0] || '';
  if (!tag) {
    const asked = /存|收藏|收下|收起来|留着/.test(String(last.text || ''));
    if (asked && (mediaNow.pics.length || mediaNow.mfaces.length)) {
      tag = '表情';
      log.info('表情：她说要存但没写 [收藏:]，替她存最近那张（表情）');
    }
  }
  if (tag) {
    try {
      collectedByHer = mediaNow.pics.length
        ? stickers.collectImage(STICKER_DIR, mediaNow.pics[0].file, tag)
        : (mediaNow.mfaces.length ? stickers.collectMface(STICKER_DIR, mediaNow.mfaces[0], tag) : null);
      if (collectedByHer) log.info(`表情：她自己收藏了「${collectedByHer.tag}」（${collectedByHer.kind}）`);
    } catch (err) {
      log.warn(`表情：她想收藏但没存成（${err.message}）`);
    }
  }
  if (!replyText && !collectedByHer) replyText = '嗯嗯。';

  /**
   * ★ 2026-10-26：模型可以单独写一行 `[表情:晚安]`。这里把那行删掉、换成一张图；
   * 关键词对不上就随机挑一张（`stickers.plan` 负责），不会因为没匹配就哑火。
   * 刚收藏的那张已经进了目录，所以同一条回复里也可能把它发出去。
   *
   * ★ 2026-10-27：发送这一段抽成了 `deliverToChat()` —— 主动开口走同一条路，
   * 手机面板/分条/表情包才不会两套逻辑。
   */
  const cat2 = (collected || collectedByHer) ? stickers.catalog(STICKER_DIR, QQ_STICKER_DIR) : cat;
  const isOwner = (cfg.ownerIds || []).map(String).includes(String(last.userId));
  await deliverToChat({
    key,
    isGroup: last.isGroup,
    userId: last.userId,
    name: last.name,
    replyText,
    direct: !last.isGroup || !!last.isAtMe || !!last.isPoke || isOwner,
    reason: last.reason || '',
    catalog: cat2,
    collected: (collectedByHer || collected)?.tag || '',
    voicePlan: vPlan,
  });
  // 刚回过话：自主说话的"沉默"从这一刻重新算
  try { presenceRt?.machine.noteReply({ key, at: Date.now() }); savePresenceSoon(); } catch { /* 没启动就算了 */ }
}

/* ---------- 桌宠里打字：走同一个大脑 ---------- */

/**
 * 桌宠气泡里的"你"和 QQ 里的主人共用一本账（配了 ownerIds 时）。
 * 失败会抛错，`pet.cjs` 会退回内置台词，不会因为她没网就变哑巴。
 */
async function chat({ text, personId, userName, situation = '', unsolicited = false, record = true } = {}) {
  if (!cfg.enabled) throw new Error('陪伴模式没开');
  const model = resolveModel(cfg.model);
  const why = whyNotReady(model);
  if (why) throw new Error(why);
  const id = String(personId || ownerPersonId());
  const name = userName || ownerName();
  const brain = new CompanionBrain({
    memory: memory(),
    roleText: loadRole(),
    model,
    longMemory: cfg.memory?.enabled === false ? null : longMemory(),
  });
  const writeMemory = record !== false && !unsolicited;
  /**
   * ★ 2026-11-08：**他在桌宠/语音这边说话，也要让"她的手"知道**。
   *
   * 以前 `noteUser()` 只在 QQ 入站那一段调（`handleOneBot` 里），桌宠这条路一句都没有：
   *   · `phone-life.noteUser()` 不触发 → 她正玩着，他对着桌宠说话，手机**不会先停下**；
   *   · `quietFor()` 里那个"他安静了多久"也不更新 → 自主那一趟以为他一直没说话。
   * 两行都放在这里，是因为**打字和语音最后都走 `chat()`**（`pet.cjs` 的 `ask()`）。
   */
  if (!unsolicited) {
    noteHeard(Date.now());
    try { ensureLife().noteUser({ at: Date.now() }); } catch { /* 没起过就算了 */ }
  }
  // 「记住：……」：先落一条长期记忆，再让模型自然接一句"记下了"。
  const remembered = writeMemory
    ? rememberFromText({ text, personId: id, userName: name, where: 'deskpet' })
    : null;
  /**
   * ★ 2026-11-08：**桌宠这条路也要"他一句一判"**（真机 11-07 23:30–23:41 那一整轮）。
   *
   * 以前 `chat()` 里只有"明确指令"一件事，别的全没有：
   *   · 他说「先别玩了 / 我来给你操作吧 / 算了我下次再优化」→ 她照样让手机点下去（R1）；
   *   · 他问「你现在看到什么」→ 她张口就是 20 轮流水里的旧页（R6 的近亲）；
   *   · 他说「你随便玩吧」→ 只在嘴上应一句，手机上什么都没开。
   * 现在和 QQ 走同一个 `phoneIntentHints()`（见上面那段）。
   */
  const ph = unsolicited
    ? { answer: '', stop: false, stopHint: '', playHint: '', aboutScreen: '', cmd: null }
    : await phoneIntentHints({
      text: String(text || ''),
      key: 'deskpet',
      isOwner: true,
      isGroup: false,
      phoneUp,
      at: Date.now(),
    });
  const phoneCmd = ph.cmd;
  const phoneCmdText = ph.cmdText || (phoneCmd && phoneCmd.goal) || '';
  /**
   * ★ 2026-11-12（P0）：**raw 是代码直接排的，不能让她再写一遍。**
   *
   * 旧措辞是"想动手就写一行 [手机:…]"。raw 已经排上了，她再写一遍只会写半句
   * （真机 21:51 她写的就是 `[手机:回桌面]`），反而把整句盖掉。
   */
  const phoneHint = ph.raw
    ? `（他这句话已经替你排上了（原句：「${ph.raw.goal}」）。回一句就行，`
      + '没做完就别说已经做完了；做完会再告诉你。）'
    : phoneCmd
      ? `（他这句是让你在手机上做「${phoneCmdText}」。手机就在你手上：想动手就单独写一行 [手机:${phoneCmdText}]，`
        + '写了就会真的去做；没做就别说已经做完了。）'
      : '';
  const effectiveSituation = [
    unsolicited ? `${situation}（现在没人跟你说话，你可以自己随口说一句；不要提问。）` : situation,
    remembered ? `（对方刚让你记住：${remembered.body}。可以自然地说一句你记下了。）` : '',
    ph.answer,
    ph.stopHint,
    ph.playHint,
    ph.aboutScreen,
    ph.noPhone,
    phoneHint,
  ].filter(Boolean).join('\n');
  const r = await brain.reply({
    userId: id,
    userName: name,
    text: String(text || ''),
    situation: effectiveSituation,
    platform: '桌宠',
    where: 'deskpet',
    phone: phoneState(),
    // 自动说话 / 设置页试一句都不是"跟谁的一轮对话"，别写进人物账污染记忆
    record: writeMemory,
  });
  if (writeMemory) {
    try {
      memoryScribe().afterTurn({ personId: id, personName: name, where: 'deskpet' });
    } catch (err) {
      log.warn(`长期记忆：整理调度失败（${err.message}）`);
    }
  }
  /**
   * ★ 2026-11-07：**桌宠这条路也要真的执行 `[手机:…]`**，而且不能把她写的标记念出来。
   *
   * 这里以前是直接 `r.parts = split(r.text)`：`[手机:往下翻]` 既没执行、又被语音念了出来。
   * 现在先摘标记 → 真入队；她这一轮没写标记、但主人的话本身就是一条明确指令时，兜底替她排上。
   *
   * ★ 2026-11-08（R2）：**他的"确定动作"赢过她的标记**（和 QQ 那份同一条规矩）。
   * 真机 23:35:19：「不是你先返回首页吧」+ 她写的「搜小肥鱼」→ 手机去搜了小肥鱼。
   */
  let replyText = String(r.text || '');
  let herGoals = [];
  if (/\[手机\s*[:：]/.test(replyText)) {
    /** ★ 2026-11-08（R-A）：和 QQ 那条同一条规矩 —— 她写的已经包含他那件事时，让她赢。 */
    const hers = phoneAgentMod.parseTag(replyText).goals || [];
    /** ★ 2026-11-12（P0）：raw（他的原话）直接赢，理由见 QQ 那段。 */
    const rawWins = !!(phoneCmd && phoneCmd.kind === 'raw');
    let hisWins = rawWins || !!(phoneCmd && phoneIntent.DETERMINISTIC.has(phoneCmd.kind));
    if (hisWins && !rawWins && hers.length && hers.some((g) => phoneIntent.coversHim(g, phoneCmd))) {
      hisWins = false;
      log.info(`手机：他这句是「${phoneCmd.goal}」，但她的「${hers.join('、')}」已经包含这件事，按她的办`);
    }
    if (hisWins) {
      const parsed = phoneAgentMod.parseTag(replyText);
      replyText = parsed.text;
      if (hers.length) log.info(`手机：他这句是「${phoneCmd.goal}」，她写的「${hers.join('、')}」这一轮不排（他的算）`);
    } else {
      const parsed = handlePhoneTag(replyText, 'deskpet');
      replyText = parsed.text;
      herGoals = parsed.goals || [];
    }
  }
  if (!herGoals.length && phoneCmd) {
    try {
      handlePhoneTag(`[手机:${phoneCmd.goal}]`, 'deskpet', { kind: phoneCmd.kind === 'raw' ? 'raw' : '' });
    } catch (err) { log.warn(`手机：兜底入队失败（${err.message}）`); }
  }
  /** ★ 2026-11-12：一句话里剩下的那几件也补排上（桌宠这条路；raw 单独排，见 QQ 那段）。 */
  if (phoneCmd && Array.isArray(ph.wants) && ph.wants.length) {
    const rest = ph.wants.filter((c) => !herGoals.some((g) => phoneIntent.coversHim(g, c)));
    const restRaw = rest.filter((c) => c.kind === 'raw');
    const restPlain = rest.filter((c) => c.kind !== 'raw');
    if (restPlain.length) {
      try {
        handlePhoneTag(`[手机:${restPlain.map((c) => c.goal).join('，')}]`, 'deskpet');
        log.info(`手机：他这句里还有「${restPlain.map((c) => c.goal).join('，')}」，一起排上`);
      } catch (err) { log.warn(`手机：剩下的那几件没排上（${err.message}）`); }
    }
    if (restRaw.length) {
      try {
        handlePhoneTag(`[手机:${restRaw.map((c) => c.goal).join('，')}]`, 'deskpet', { kind: 'raw' });
        log.info(`手机：他这句的原话也排上了「${restRaw.map((c) => c.goal).join('，')}」`);
      } catch (err) { log.warn(`手机：原话那件没排上（${err.message}）`); }
    }
  }
  r.text = replyText.trim() || (phoneCmd ? '我去弄一下。' : '嗯。');
  r.parts = split(r.text, cfg.humanize.burstMax);
  /** ★ 2026-11-12：桌宠这条路的"她上一句"（「去吧」这种许可式要靠它）。 */
  noteHerLine(r.text);
  return r;
}

/**
 * ★ 2026-10-27：桌宠 0 挡（`pet.cjs` 的 `llm.chat` 那条路）用的长期记忆。
 *
 * 0 挡不走 `companion.chat`，但它也应该记得你；这里只返回一段可以塞进 system 的文字
 * （人物账 + 检索到的长期记忆），不负责写记忆。写记忆仍由 `memoryScribe().afterTurn` 做。
 */
function recallForDeskpet({ text = '', history = [], userName } = {}) {
  if (cfg.memory?.enabled === false) return '';
  try {
    const query = [
      String(text || ''),
      ...history.filter((row) => row && row.role === 'user').slice(-2).map((row) => String(row.content || '')),
    ].filter(Boolean).join('\n');
    const result = longMemory().recall({
      personId: ownerPersonId(),
      personName: userName || ownerName(),
      query,
      platform: 'deskpet',
      where: 'deskpet',
      excludeWhere: 'deskpet',
      topK: Number(cfg.memory?.deskpetTopK) || 3,
      tokenBudget: Number(cfg.memory?.deskpetTokenBudget) || 400,
      halfLifeDays: Number(cfg.memory?.halfLifeDays) || 60,
      recentTurns: 12,
    });
    return result.text;
  } catch (err) {
    log.warn(`长期记忆：桌宠侧召回失败（${err.message}）`);
    return '';
  }
}

/**
 * ★ 2026-10-27：用户说「记住：……」时立刻写一条长期记忆（不等后台 6 轮）。
 * 返回 null 表示这句不是"记住"命令；返回条目表示已经写进去了（或已经很相似）。
 */
function parseRemember(text) {
  const match = String(text || '').trim().match(/^记住(?:[:：,，\s]+)?([\s\S]+)$/);
  if (!match) return '';
  return cleanMemoryText(match[1], 200);
}

function rememberFromText({ text, personId, userName, where = '' } = {}) {
  const body = parseRemember(String(text || '').replace(/\[(?:图片|表情|戳一戳)\]/g, ''));
  if (!body) return null;
  try {
    const person = String(personId || ownerPersonId());
    const similar = longMemory().search(body, { topK: 1, halfLifeDays: 0, personId: person });
    if (similar[0] && similar[0].score >= 4) return similar[0].entry;
    const source = String(where || '').startsWith('group') || String(where || '').startsWith('private') ? 'qq' : 'deskpet';
    const entry = longMemory().write({
      body,
      kind: 'fact',
      person,
      scope: 'person',
      source,
      tags: ['manual'],
      keys: [],
      importance: 4,
    });
    log.info(`长期记忆：手动记住一条（${person}，${userName || '?'}）：${body.slice(0, 30)}`);
    return entry;
  } catch (err) {
    log.warn(`长期记忆：手动记住失败（${err.message}）`);
    return null;
  }
}

/**
 * ★ 2026-10-27：设置页「测试 QQ 模型」用。
 *
 * 和 `companion.chat()` 的区别：只打一次 `/chat/completions`，**不写记忆、不发 OneBot**，
 * 而且可以拿表单里还没保存的值去试（`patch` 会覆盖在 `cfg.model` 上）。
 * 这样用户改完 QQ 接口可以先点「测试」，不用先保存、更不用断 QQ。
 */
async function probeModel(patch = {}) {
  const merged = merge(cfg.model || {}, patch || {});
  const model = resolveModel(merged);
  const why = whyNotReady(model);
  if (why) return { ok: false, message: why, model: model.model, mode: model.mode };
  try {
    const r = await callModel(model, [
      { role: 'system', content: loadRole().slice(0, 1200) },
      { role: 'user', content: '在吗' },
    ], { maxTokens: Math.min(96, model.maxTokens) });
    return {
      ok: true,
      ms: r.ms,
      model: model.model,
      mode: model.mode,
      message: `${r.ms}ms · 它说「${r.text.slice(0, 40)}」`,
    };
  } catch (err) {
    return { ok: false, message: err.message, model: model.model, mode: model.mode };
  }
}

/* ---------- 自主说话：她什么时候想开口 ---------- */

/**
 * ★ 2026-10-27（用户："想说就说，不想说不说，隔几分钟甚至半小时再想开口"）。
 *
 * 链路（每一环都能单独看/单独测）：
 *
 *   `thinkOnce()`  每 N 分钟（或事件后）让她**一个人想事情** → 念头进池子（带 1-5 动机分）
 *        ↓
 *   `presenceTick()`  20 秒一次：挑池子里没用过的念头，按"沉默越久越想说话"打分
 *        ↓
 *   `decide()`（纯逻辑，`companion-presence.cjs`）  分数够 + 闸门都过 → 允许开口
 *        ↓
 *   `speakSpontaneously()`  这一次才真的调模型把"那件事"说成一句话 → `deliverToChat()` 发出去
 *
 * 和"回复"最大的区别：**没有触发也会发生**，而且允许"什么都不想"和"想了但不说"。
 * 那样长间隔（十几分钟、半小时）才是自然结果，而不是随机数。
 */
function presenceCfg() {
  return cfg.presence || presence.DEFAULTS;
}

/** 状态里只有"上次开口 / 连续没被回"这几样，很小，改了就存（防抖 2 秒）。 */
function savePresenceNow() {
  const rt = presenceRt;
  if (!rt) return;
  if (rt.saveTimer) { clearTimeout(rt.saveTimer); rt.saveTimer = 0; }
  try {
    store.writeJson(PRESENCE_FILE, rt.machine.serialize());
  } catch (err) {
    log.warn(`自主说话：状态存不下来（${err.message}）`);
  }
}

function savePresenceSoon() {
  const rt = presenceRt;
  if (!rt || rt.saveTimer) return;
  rt.saveTimer = setTimeout(() => { if (presenceRt) savePresenceNow(); }, 2000);
  rt.saveTimer.unref?.();
}

function startPresence() {
  if (presenceRt) return;
  const c = presenceCfg();
  if (c.enabled === false) return;
  const machine = presence.createPresence({
    cfg: () => cfg.presence || presence.DEFAULTS,
    now: () => Date.now(),
    rng: Math.random,
  });
  const mind = new Mind({
    file: MIND_FILE,
    max: 40,
    now: () => Date.now(),
    log,
  });
  const saved = store.readJson(PRESENCE_FILE);
  machine.hydrate(saved);
  const ownerId = String((cfg.ownerIds || [])[0] || '');
  if (ownerId) {
    if (!machine.targetKey()) machine.setTarget(`private:${ownerId}`);
    // 第一次跑（没有上次记录）：把"上次开口"设成现在。不然一开机她可能马上就冒一句。
    if (!saved || !Array.isArray(saved.keys) || !saved.keys.length) {
      machine.noteReply({ key: `private:${ownerId}`, at: Date.now() });
    }
  }
  presenceRt = {
    machine,
    mind,
    timer: 0,
    thinking: false,
    saveTimer: 0,
    /** 第一次"想事情"晚 90 秒，让启动/重连先稳下来。 */
    mindDueAt: Date.now() + 90_000,
    lastWhy: '',
    lastLogAt: 0,
  };
  presenceRt.timer = setInterval(() => {
    presenceTick().catch((err) => log.warn(`自主说话：心跳出错（${err.message}）`));
  }, PRESENCE_HEARTBEAT_MS);
  presenceRt.timer.unref?.();
  log.info(`自主说话：开（${presence.FREQUENCY[c.frequency] ? c.frequency : 'normal'} · 醒着 ${c.activeHours?.[0]}~${c.activeHours?.[1]} 点 · 夜里${c.nightMessage !== false ? '可留言' : '不说话'}）`);
}

function stopPresence() {
  if (!presenceRt) return;
  clearInterval(presenceRt.timer);
  savePresenceNow();
  presenceRt = null;
}

/** 设置页/自检看的只读状态。 */
function presenceState() {
  const c = presenceCfg();
  if (!presenceRt) {
    return {
      enabled: c.enabled !== false,
      running: false,
      frequency: c.frequency,
      threshold: presence.FREQUENCY[c.frequency] || presence.FREQUENCY.normal,
      targetKey: '',
      thoughts: 0,
      spokenThoughts: 0,
      unanswered: 0,
      lastSpokeAt: 0,
      lastWhy: '',
      whyText: '',
      latest: [],
    };
  }
  const snap = presenceRt.machine.snapshot();
  const stat = presenceRt.mind.stats({ key: snap.targetKey });
  return {
    ...snap,
    running: true,
    thinking: !!presenceRt.thinking,
    thoughts: stat.pending,
    spokenThoughts: stat.spoken,
    latest: stat.latest,
    mindEveryMin: Number(c.mindEveryMin) || 30,
  };
}

/**
 * 让她"一个人想事情"：产出 0-2 条念头，写进念头池。
 *
 * `max: 2` 是每次想两条 —— 比一次想一堆更像人（人一次也就冒一两个念头）。
 * 想不出来是**合法结果**：模型回"无"就什么都不存。
 */
async function thinkOnce({ at = Date.now(), key = '' } = {}) {
  const rt = presenceRt;
  if (!rt) return [];
  const target = String(key || rt.machine.targetKey() || '');
  if (!target) return [];
  const model = resolveModel(cfg.model);
  if (whyNotReady(model)) return [];
  const id = target.split(':')[1] || '';
  let person = {};
  try { person = memory().person(id) || {}; } catch { /* 账本坏了也别拦着想事情 */ }
  const name = person.name || (id === String((cfg.ownerIds || [])[0] || '') ? ownerName() : id);
  let recentText = '';
  let memoryText = '';
  try { recentText = memory().renderRecent(6, { where: target, personId: id, excludePhone: true }); } catch { /* 没聊过 */ }
  if (cfg.memory?.enabled !== false) {
    try {
      const rows = memory().recentTurns(4, { where: target, excludePhone: true });
      const query = rows.map((r) => `${r.text || ''} ${r.reply || ''}`).join('\n').slice(0, 800) || '心事';
      const recall = longMemory().recall({
        personId: id,
        personName: name,
        query,
        platform: 'qq',
        where: target,
        excludeWhere: target,
        topK: 3,
        tokenBudget: 400,
        recentTurns: 0,
      });
      memoryText = recall?.memoryText || '';
    } catch { /* 检索不到就凭最近的对话想 */ }
  }
  const brain = new CompanionBrain({ memory: memory(), roleText: loadRole(), model, longMemory: null });
  const thoughts = await brain.think({
    // 想事情**不喂长期记忆之外的额外上下文**：她只需要"最近聊过什么 + 现在几点"
    situation: `你在跟 ${name} 私聊（QQ 上）。`,
    recentText,
    memoryText,
    max: 2,
    at: new Date(at),
  });
  const added = rt.mind.add(thoughts, { key: target, personId: id, source: 'mind' });
  if (added.length) {
    log.info(`自主：想了 ${added.length} 条（${added.map((t) => `${t.motivation}分「${t.text}」`).join('，')}）`);
  } else if (thoughts.length) {
    log.info('自主：想出来的都跟以前重复了，没存');
  }
  return added;
}

/**
 * ★ 2026-11-05：**「她想的」窗口里手动让她想一个**（也可以「再想一眼」接着上一张）。
 *
 * 和聊天里那条路的区别只有两点：
 *   · `force` —— 窗口是人明确要的，**不吃 30 分钟冷却**（但一天上限照样管着）；
 *   · `where:'window'` —— 台账能看出来这一张是"他要她想"的，不是聊天里顺口想的。
 *
 * ⚠️ 这条会**真的跑模型**（1~2 眼 ≈ 3 秒），所以窗口那边要先把按钮禁用。
 */
async function imagineNow({ seed = '', maxEyes = 2, force = true } = {}) {
  const model = resolveModel(cfg.model);
  const why = whyNotReady(model);
  if (why) return { ok: false, why };
  let lens = [];
  try {
    lens = selfKernel.active()
      .filter((e) => e.kind === 'taste' || e.kind === 'stance')
      .slice(0, 3)
      .map((e) => e.claim);
  } catch { /* 账读不出来就不带角度，不能因此让她想不了 */ }
  // `callModel` 是 `(model, messages, opts)`；`imagine.run` 要的是 `(messages, opts)`，包一层。
  const out = await imagine.run({
    seed,
    callModel: (messages, opts) => callModel(model, messages, opts),
    roleText: loadRole(),
    lens,
    where: 'window',
    maxEyes: Math.min(3, Math.max(1, Number(maxEyes) || 2)),
    tier: 'ask',
    force,
  });
  if (out?.ok) {
    log.info(`想象（窗口）：${out.rec.seed} → L${out.rec.level}（${out.rec.lines.length} 件 · ${out.eyes} 眼）`);
  } else if (out?.why) {
    log.info(`想象（窗口）：这次没想（${out.why}）`);
  }
  return out;
}

/**
 * 把一句话发到某个会话：手机面板事件 + 拟人分条 + 表情包 + 语音。
 * **回复（`replyBatch`）和主动开口（`speakSpontaneously`）共用这一段**，
 * 免得两条路各写一遍、过几天就不一样了。
 *
 * ★ 2026-11-01：一段回复里可以**又说又打**。她自己在行首写 `[语音]` 就按她写的；
 * 系统递了话筒（`voicePlan.mode`）但没写标记时，`buildSegments()` 会兜底把第一句当语音。
 */
async function deliverToChat({
  key, isGroup, userId, name, replyText, direct = false, reason = '', catalog = null,
  spontaneous = false, collected = '', image = '', voicePlan = null,
}) {
  /** ★ 2026-11-12：记下她最近一句（QQ 这张嘴也写进同一份）。 */
  noteHerLine(replyText);
  const cat = catalog || stickers.catalog(STICKER_DIR, QQ_STICKER_DIR);
  const planned = stickers.plan(replyText, cat, { max: 1 });
  const text = planned.text;
  const parts = text ? split(text, cfg.humanize.burstMax) : [];

  const vc = voiceCfg();
  const built = voiceMod.buildSegments(parts, voicePlan?.mode || 'none', {
    maxVoice: 2,
    maxChars: vc.tts.maxChars,
    allowVoice: vc.enabled,
  });
  const segments = await prepareVoiceSegments(built.segments);
  const voiceCount = segments.reduce((n, s) => n + (s.kind === 'voice' ? 1 : 0), 0);

  emitEvent({
    type: 'outbound',
    key,
    isGroup,
    userId,
    name,
    text: built.text || (planned.picks.length ? `[表情:${planned.picks[0].tag}]` : ''),
    parts: segments.map((s) => s.text),
    voice: voiceCount,
    sticker: planned.picks.map((x) => x.tag).join(','),
    collected,
    image: image ? 1 : 0,
    direct,
    reason,
    ...(spontaneous ? { spontaneous: true } : {}),
  });

  const human = new Humanizer(cfg.humanize);
  let typingOn = false;
  const io = {
    setTyping: async (on) => {
      if (on !== typingOn) {
        typingOn = on;
        emitEvent({ type: 'typing', key, isGroup, on });
      }
      if (client) await client.setTyping(key, on);
    },
    send: async (part) => {
      if (!client) throw new Error('OneBot 没连上');
      const r2 = await client.send(key, part);
      if (!r2.ok) throw new Error(r2.error || '发送失败');
      log.info(`陪伴：发出 → ${key}：${part.slice(0, 40)}`);
    },
  };

  /**
   * 按她的顺序发：连续的文字攒成一段走拟人节奏，碰到语音就先 flush 再发语音。
   * 语音合成失败 / QQ 没收下 → 这一句退回文字（诚实），不影响后面的。
   */
  let run = [];
  const flush = async () => {
    if (!run.length) return;
    const batch = run;
    run = [];
    await human.say(batch, io);
  };
  let sentVoices = 0;
  for (const seg of segments) {
    if (seg.kind === 'text') { run.push(seg.text); continue; }
    await flush();
    try {
      if (!client) throw new Error('OneBot 没连上');
      const r2 = await client.sendRecord(key, seg.audio);
      if (!r2.ok) throw new Error(r2.error || '发送失败');
      sentVoices += 1;
      log.info(`陪伴：语音 → ${key}（${seg.ms || 0}ms · ${Math.round((seg.bytes || 0) / 1024)}KB）`);
    } catch (err) {
      log.warn(`陪伴：语音没发出去（${err.message}），这句改成文字`);
      run.push(seg.text);
    }
  }
  await flush();

  /**
   * 节奏状态：发了语音就重置"隔了几条文字"，否则 +1。
   * 没有每日上限 —— 只用来保证不会连着两条语音。
   */
  try {
    const now = Date.now();
    saveVoiceState(sentVoices
      ? voiceMod.noteVoice(voiceState(now), now)
      : voiceMod.noteText(voiceState(now), now));
  } catch (err) {
    log.warn(`语音：节奏状态没更新（${err.message}）`);
  }

  /**
   * ★ 2026-10-30：手机截图跟着那句话一起发。
   * 走 `client.sendImage` 的 `base64://`（NapCat 的 `enableLocalFile2Url:false` 也认），
   * 和表情包是同一条通路，不另开一套。
   */
  if (image) {
    try {
      if (!client) throw new Error('OneBot 没连上');
      const r2 = await client.sendImage(key, stickers.toBase64Protocol(image));
      if (!r2.ok) throw new Error(r2.error || '发送失败');
      log.info(`陪伴：图 → ${key}（${path.basename(image)}）`);
    } catch (err) {
      log.warn(`陪伴：图没发出去（${err.message}）`);
      emitEvent({ type: 'outbound-failed', key, isGroup, reason: err.message });
    }
  }
  for (const st of planned.picks) {
    try {
      if (!client) throw new Error('OneBot 没连上');
      const r2 = st.kind === 'mface'
        ? await client.sendMface(key, st.face, { summary: st.tag })
        : await client.sendImage(key, stickers.toBase64Protocol(st.file), { summary: st.tag });
      if (!r2.ok) throw new Error(r2.error || '发送失败');
      log.info(`陪伴：表情 → ${key}：${st.tag}（${st.kind}）`);
    } catch (err) {
      log.warn(`陪伴：表情没发出去（${err.message}）`);
      emitEvent({ type: 'outbound-failed', key, isGroup, reason: err.message });
    }
  }
  emitEvent({ type: 'typing', key, isGroup, on: false });
  return { text: built.text, parts: segments.map((s) => s.text), picks: planned.picks, voice: sentVoices };
}

/**
 * 真的把"心里那件事"说出口。
 *
 * 为什么和 `thinkOnce()` 分开：念头是"明天他面试"，发出去的话得是"明天面试，别熬太晚"。
 * 想的时候不知道什么时候会发，发的时候才知道"现在是晚上十一点"。
 * 这一次模型仍然有否决权：只回一句"算了"就不发（池子里那条也会被丢掉）。
 */
async function speakSpontaneously({ key, thought, score = 0 }) {
  const rt = presenceRt;
  if (!rt) throw new Error('自主说话没启动');
  if (!client || !connected) throw new Error('OneBot 没连上');
  const model = resolveModel(cfg.model);
  const why = whyNotReady(model);
  if (why) throw new Error(why);
  const target = String(key || rt.machine.targetKey());
  const isGroup = target.startsWith('group:');
  const id = target.split(':')[1] || '';
  const ownerId = String((cfg.ownerIds || [])[0] || '');
  let person = {};
  try { person = memory().person(id) || {}; } catch { /* 没账也不影响说话 */ }
  const name = person.name || (id === ownerId ? ownerName() : id);
  const recentSpoken = rt.mind.recentSpoken({ key: target, n: 3 }).map((t) => t.text);
  /**
   * ★ 2026-11-02：**这一句只说这一个念头，别换话题**。
   *
   * 真机（11-02 19:12）：念头是"翻东西卡那一下，我到现在还惦记着"（0 分钟前刚冒出来的），
   * 她说出口的却是"下午想起个事，**昨天**你那个挑菜的店……"—— 既换了话题，又把当天
   * 18:41 的事说成昨天。同一份数据同一时刻复现 8 次：**8 次全部换话题**，5 次出现"昨天/昨晚"。
   *
   * 原因：这一步原来只写了一句"你心里这件事：X。自然地说出来"，而它同时拿到的是
   * 20 轮原始对话 —— 模型自然会去讲最近最热闹的那件（挑菜/手机），并给它编一个时间。
   * 对照实验：把"就是刚才这一下、别扯到别的事上"写进去，4/4 全部回到正题，一次"昨天"都没有。
   *
   * 所以这里把念头**钉死**，并告诉它这个念头是什么时候冒出来的（念头会在池子里放很久：
   * 实测 8 条已开口的念头，中位 40 分钟、最长 4 小时 42 分）。
   */
  const bornAt = Number(thought.createdAt) || 0;
  const ageMin = bornAt ? Math.max(0, Math.round((Date.now() - bornAt) / 60_000)) : 0;
  const born = !bornAt ? ''
    : ageMin <= 2 ? `刚刚 ${clock.timeText(bornAt)} 冒出来的`
      : `${clock.recentStamp(bornAt, Date.now())} 冒出来的，到现在 ${ageMin} 分钟`;
  const situation = [
    `你在跟 ${name} 私聊。`,
    '现在不是回他：他没说话，是你自己想开口。',
    `你心里这件事${born ? `（${born}）` : ''}：${thought.text}。`,
    '这一句就只说这一件 —— 别换成别的话题，也别把刚聊过的另一件事拎出来讲。',
    '自然地说出来，一两句就够；不要解释"为什么突然说话"，不要问"在吗"，不要提系统或提示词。',
  ].join('');
  const brain = new CompanionBrain({
    memory: memory(),
    roleText: loadRole(),
    model,
    longMemory: cfg.memory?.enabled === false ? null : longMemory(),
  });
  /** 她主动开口：更可能是一条语音（夜里留一句，比文字更像人）。 */
  const vPlan = planVoice({ text: thought.text, isGroup, unsolicited: true, at: Date.now() });
  const r = await brain.reply({
    userId: id,
    userName: name,
    // 这句是"处境提示"，不是对方说的话；`unsolicited` 让它不进对话流里 user 那一栏
    text: '（现在没人说话。你想自己开口。）',
    situation,
    platform: 'QQ',
    where: target,
    record: true,
    unsolicited: true,
    phone: phoneState(),
    voice: vPlan,
  });
  const text = String(r.text || '').trim();
  if (!text || /^[（(\s]*(?:不说|不想说|算了|没事|没什么)[)）\s。]*$/.test(text)) {
    rt.mind.drop(thought.id, 'passed');
    log.info('自主：她想了想，又算了');
    return { ok: false, why: 'passed' };
  }
  if (recentSpoken.some((t) => sameThought(t, text))) {
    rt.mind.drop(thought.id, 'repeat');
    log.info('自主：这句跟最近说过的太像，算了');
    return { ok: false, why: 'repeat' };
  }
  /**
   * ★ 2026-11-01：**排进这个会话的发送链**，别和你正在等的那句回复同时发
   * （两条同时发会交替踩"正在输入"，而且谁先到取决于谁先发完）。
   */
  const out = await enqueueSend(target, () => deliverToChat({
    key: target,
    isGroup,
    userId: id,
    name,
    replyText: text,
    direct: id === ownerId,
    reason: 'spontaneous',
    spontaneous: true,
    voicePlan: vPlan,
  }));
  rt.mind.markSpoken(thought.id, Date.now());
  return { ok: true, text: out.text, parts: out.parts, score };
}

/**
 * 心跳：20 秒看一次"现在想不想说"。
 *
 * 纯本地计算（动机分 + 沉默时长 + 闸门）**不花 token**；只有真的要说了，
 * 才调一次模型把话说出来。`at` 可以传，自检拿假时钟推一整天。
 */
async function presenceTick(at = Date.now()) {
  const rt = presenceRt;
  if (!rt) return { ok: false, why: 'off' };
  const c = presenceCfg();
  if (!running || !cfg.enabled || cfg.respond === false) return { ok: false, why: 'off' };
  if (!connected || !client) return { ok: false, why: 'disconnected' };
  if (busy.size) return { ok: false, why: 'busy' };
  if (whyNotReady(resolveModel(cfg.model))) return { ok: false, why: 'no-model' };
  const key = rt.machine.targetKey();
  if (!key || !chatAllowed(key)) return { ok: false, why: 'no-target' };

  // 到点就"想事情"（异步，不挡这一次判定：池子里可能已经有能说的）
  if (at >= rt.mindDueAt && !rt.thinking) {
    rt.thinking = true;
    rt.mindDueAt = at + Math.max(1, Number(c.mindEveryMin) || 30) * 60_000;
    thinkOnce({ at, key })
      .catch((err) => log.warn(`自主：想事情失败（${err.message}）`))
      .finally(() => { if (presenceRt) presenceRt.thinking = false; });
  }

  const thoughts = rt.mind.pending({ key, at });
  const verdict = rt.machine.remember(rt.machine.decide({ thoughts, at, key }));
  if (!verdict.ok) {
    // "低分/没念头"是常态，不刷日志；其余原因只在变化或每隔一刻钟记一行
    const quiet = verdict.why === 'low' || verdict.why === 'no-thought';
    if (!quiet && (verdict.why !== rt.lastWhy || at - rt.lastLogAt > 15 * 60_000)) {
      rt.lastWhy = verdict.why;
      rt.lastLogAt = at;
      log.info(`自主：这次不说（${presence.WHY[verdict.why] || verdict.why}）`);
    }
    return verdict;
  }

  const thought = verdict.thought;
  const silentMin = Math.round(rt.machine.silenceMin(key, at));
  const ticket = rt.machine.noteSpoken({ key, at, text: thought.text });
  savePresenceSoon();
  try {
    const r = await speakSpontaneously({ key, thought, score: verdict.score });
    if (!r.ok) {
      rt.machine.rollbackSpoken({ key, prev: ticket });
      savePresenceSoon();
      return r;
    }
    rt.lastWhy = '';
    log.info(`自主：说了（动机 ${thought.motivation}/5 · 想说程度 ${verdict.score} · 静默 ${silentMin} 分钟）：${r.text}`);
    return r;
  } catch (err) {
    rt.machine.rollbackSpoken({ key, prev: ticket });
    savePresenceSoon();
    log.warn(`自主：没发出去（${err.message}）`);
    return { ok: false, why: 'send-failed', error: err.message };
  }
}

/* ---------- 配置 / 记忆 ---------- */

/**
 * 只比"会动到连接"的字段：模型、角色卡、唤醒策略这类改动不需要断一次 OneBot。
 * ★ 2026-10-27：设置页保存 QQ 模型时如果无脑 `stop()/start()`，会白断 WebSocket、
 * 还可能漏掉断线那一秒里的 QQ 消息。这里让保存自己判断要不要重连。
 */
function connectionKey(c) {
  return JSON.stringify({
    enabled: !!c.enabled,
    adapter: c.adapter,
    onebot: c.onebot || {},
    gateway: {
      autoStart: c.gateway?.autoStart,
      dir: c.gateway?.dir,
      uin: c.gateway?.uin,
    },
  });
}

function save(patch, { restart = true } = {}) {
  const prev = cfg;
  const next = merge(cfg, patch || {});
  const err = store.writeJson(CONFIG_FILE, next);
  if (err) throw new Error(`陪伴配置保存失败：${err.message}`);
  cfg = next;
  ensureRoleFile();
  // 自主说话的开关变了不用断 OneBot，但心跳要跟着起停（频率是运行时读的，不用重启）
  if (running && !presenceRt && cfg.presence?.enabled !== false) startPresence();
  if (presenceRt && cfg.presence?.enabled === false) stopPresence();
  // 手机开了/关了、自主用手机开了/关了：心跳跟着换，也不用重连 QQ
  if (running) {
    stopPhoneRoam();
    startPhoneRoam();
  }
  const reconnect = connectionKey(prev) !== connectionKey(next);
  if (restart && reconnect) {
    if (cfg.enabled) { stop(); start(); }
    else stop();
  }
  emitState();
  return publicState();
}

function enable(on) {
  const next = !!on;
  if (next === !!cfg.enabled && running === next) return publicState();
  cfg = { ...cfg, enabled: next, ...(next ? { respond: true } : {}) };
  const err = store.writeJson(CONFIG_FILE, cfg);
  if (err) throw new Error(`陪伴模式开关保存失败：${err.message}`);
  if (cfg.enabled) start();
  else stop();
  emitState();
  return publicState();
}

/**
 * ★ 三挡按钮的 World 侧入口（2026-10-22）：
 *   0 = 桌宠大脑：保持已有连接（如果已经连上），只是 respond=false，不通讯；
 *   1/2 = QQ 拟人聊天：enabled=true + respond=true，必要时建连。
 * 注意 0 挡**不调用 stop()** —— 用户要的是"连上之后一直保持连接"。
 */
function setMode(level) {
  const n = Number(level) === 0 ? 0 : Number(level) === 2 ? 2 : 1;
  const wantOn = n >= 1;
  /**
   * ★ 2026-10-30：**第 3 挡（2）= 她多了部手机**。
   * 用户选的就是"点手机按钮 → 真的给她一台可以操控的安卓"，所以：
   *   · 进 2 挡 → `phone.enabled = true`（能力提示立刻出现【手机】），并把 MuMu 窗口露出来；
   *   · 退回 0/1 挡 → `phone.enabled = false`，正在跑的手机任务停下（她会"把手机放下"）。
   * 手机本身不会因为切挡而关机 —— 只是她不再用它。
   */
  const phoneOn = n === 2;
  cfg = {
    ...cfg,
    enabled: wantOn ? true : cfg.enabled,
    respond: wantOn,
    phone: { ...(cfg.phone || {}), enabled: phoneOn },
  };
  const err = store.writeJson(CONFIG_FILE, cfg);
  if (err) throw new Error(`陪伴模式挡位保存失败：${err.message}`);
  if (!wantOn) {
    // 刚切回桌宠大脑：把还没发出去的合并窗口清掉，别过两秒又回一句
    for (const t of batchTimers.values()) clearTimeout(t);
    batchTimers.clear();
    batchItems.clear();
  }
  // 手机开关跟着挡位走：开了才建 agent；关了就把在跑的任务停掉
  if (phoneOn) {
    phoneBootAt = Date.now();
    phoneStageEmit('checking');
    ensurePhone();
    startPhoneRoam();
    log.info('陪伴模式：手机已交给它（第 3 挡）');
  } else {
    try { phoneRt?.stop(); } catch { /* 没在跑 */ }
    stopPhoneRoam();
    /** 退回 0/1 挡：她"把手机放下"了，能力提示和 `up` 都要跟着消失。 */
    phoneUp = false;
    phoneStage = '';
    phoneWhy = '';
    phoneBootAt = 0;
  }
  // 桌宠大脑挡也保持连接：只要 enabled 是 true，运行停了就把它拉起来
  if ((wantOn || cfg.enabled) && !running) start();
  emitState();
  return publicState();
}

function reload() {
  cfg = readConfig();
  ensureRoleFile();
  // 配置可能在设置页/手改文件里变了：开关和运行状态对不上就补一下
  if (cfg.enabled && !running) start();
  else if (!cfg.enabled && running) stop();
  emitState();
  return cfg;
}

function recent(n = 20) {
  return recentEvents.slice(-Math.max(0, n));
}

function memorySnapshot() {
  return memory().snapshot();
}

function forget() {
  const s = memory().forget();
  // ★ 2026-10-27：长期记忆也一起清；不给"清空了人物账、旧记忆还在"的半套状态。
  try { longMemory().forget(); } catch (err) { log.warn(`长期记忆清空失败：${err.message}`); }
  // ★ 2026-10-29：她自己的“最近观察”也归记忆；清空后不该还留着旧的自画像。
  try { selfNotes.forget(); } catch (err) { log.warn(`自我观察清空失败：${err.message}`); }
  // ★ 2026-11-04：**她的账**（锚 / 账 / 传 / 证词）整个目录一起清 —— 那是"她是谁"，
  // 留着旧账再清掉对话，她会变成"记得自己、不记得发生过什么"，比清干净更怪。
  try { selfKernel.forget(); } catch (err) { log.warn(`她的账清空失败：${err.message}`); }
  // ★ 2026-11-05：她"脑子里想过的"也一起清（`imagine.jsonl` 本来就不进记忆，但它也是她的旧事）
  try { imagine.forget(); } catch (err) { log.warn(`想象清空失败：${err.message}`); }
  // ★ 2026-10-27：念头池和"上次开口"也归"记忆"：清空之后她不该还惦记着刚才那件事
  try { presenceRt?.mind.forget(); } catch { /* 没启动就算了 */ }
  try {
    presenceRt?.machine.reset();
    const id = String((cfg.ownerIds || [])[0] || '');
    if (presenceRt && id) presenceRt.machine.setTarget(`private:${id}`);
    savePresenceNow();
  } catch { /* 同上 */ }
  emitState();
  return s;
}

/**
 * ★ 2026-11-01：**只清图片缓存，不碰记忆**。
 *
 * `data/companion/media` 只增不减（`evictCache` 只管 64MB / 300 张），隐私上用户想"一键清"。
 * 设置页原来只有「清空陪伴记忆」，它清的是人物账和长期记忆，**不清 media**。
 * 这里只删这个目录再建回来：表情包（`stickers/`）、记忆（`memory/`、`people.json`）都不动。
 * @returns {{ok:boolean, removed:number, bytes:number, path:string}}
 */
function forgetMedia() {
  const dir = path.join(DATA_DIR, 'media');
  let removed = 0;
  let bytes = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      try {
        const st = fs.statSync(path.join(dir, f));
        if (st.isFile()) { removed += 1; bytes += st.size; }
      } catch { /* 读不到的就不算 */ }
    }
  } catch { /* 目录还不存在 */ }
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    log.warn(`图片缓存：删不掉（${err.message}）`);
    return { ok: false, removed: 0, bytes: 0, path: dir, why: err.message };
  }
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* 下次写图时自己会建 */ }
  log.info(`图片缓存：清掉了 ${removed} 张 / ${Math.round(bytes / 1024)}KB（情绪和记忆一件没动）`);
  return { ok: true, removed, bytes, path: dir };
}

/* ---------- 对外 ---------- */

const companion = {
  // 常量 / 路径
  CONFIG_FILE, ROLE_FILE, DATA_DIR, DEFAULTS,

  // 查询
  isOn: () => !!cfg.enabled,
  /** 连接着、而且当前在 QQ 拟人聊天挡（会处理/回复 QQ 消息）。 */
  isActive: () => !!cfg.enabled && cfg.respond !== false,
  isReady: () => !!cfg.enabled && !whyNotReady(resolveModel(cfg.model)),
  /**
   * ★ 2026-11-01：`prefsState()` 是**便宜版**（开关 + 连接态，不读盘），
   * 给"每句话都要问一句"的调用方（`pet.cjs` 每收到一条 outbound 要问两次）。
   * `publicState()` 是设置页要的全量，含 `memory.snapshot()` / `longMemory.stats()`，
   * 实测 35.9 ms/次，别在热路径上调它。
   */
  prefs: prefsState,
  publicState,
  recent,
  memorySnapshot,

  // 开关与配置
  init: () => {
    ensureRoleFile();
    stickers.ensureDirs(STICKER_DIR);
    /**
     * ★ 2026-10-30：手机**不跨重启**。
     * 上一轮退出时如果还停在第 3 挡，配置里 `phone.enabled` 会是 true；但新进程里
     * 窗口早没了、`phoneUp` 也是 false，于是会出现"能力提示说有手机 / 页面上却没有手机"，
     * 而且点回第 2 挡也看不出变化。所以启动时一律先放下，用户再点第 3 挡才去拉模拟器。
     */
    if (cfg.phone?.enabled) {
      cfg = { ...cfg, phone: { ...cfg.phone, enabled: false } };
      try { store.writeJson(CONFIG_FILE, cfg); } catch { /* 写不进去也不影响这次 */ }
      log.info('手机：这次启动先空着（要用就点第 3 挡）');
    }
    if (cfg.enabled) start();
    return publicState();
  },
  enable,
  setMode,
  save,
  reload,
  start,
  stop,

  // 角色卡
  loadRole,
  saveRole: (text) => { const r = saveRole(text); emitState(); return r; },

  // 聊天 / 记忆
  chat,
  recallForDeskpet,
  rememberFromText,
  parseRemember,
  /** ★ 2026-11-01：给自检用的纯函数（"收到"不能再被当成收藏命令）。 */
  collectCommand,
  /** ★ 2026-11-01：给自检用 —— 引用查清之后的回填（合并窗口里那条 + 挂起的"醒不醒"）。 */
  applyQuoteCheck,
  probeModel,
  forget,
  /** ★ 2026-11-01：只清图片缓存（`data/companion/media`），记忆与表情包都不动。 */
  forgetMedia,
  /** 设置页/自检用：长期记忆存储与后台整理员（不要拿它们做业务写入口）。 */
  longMemory: () => longMemory(),
  memoryScribe: () => memoryScribe(),

  /**
   * ★ 2026-11-04：**她自己的账**（锚 / 账 / 传）。
   *
   * - `selfKernel()` —— 存储本身（读写 / 注入用的 `render()` / 手加 / 退休）；
   * - `selfView()`  —— 「她」窗口要的一屏（账 + 证词 + 传 + 状态）；
   * - `selfJudge()` —— **写一笔**（跑一次模型，改动她的账）。窗口的「立即写一笔」走这里。
   */
  selfKernel: () => selfKernel,
  /**
   * ★ 2026-11-05：`selfView()` 里多一栏 `imagine` —— 「她想的」那张卡和账在**同一个窗口**里
   * （用户：「关于 p2 她想的面板可以做到右键左上角的账本里去，方便查看与后续升级」）。
   * 两边的数据本来就不互通（想象不落账），这里只是把两屏拼成一次 IPC。
   */
  selfView: () => ({ ...selfKernel.view(), imagine: imagine.view() }),
  selfJudge: (opts) => memoryScribe().judgeSelf({ force: true, why: 'manual', ...(opts || {}) }),

  /**
   * ★ 2026-11-05：**她的想象**（`companion-imagine.cjs`）。
   *
   * - `imagine()`     —— 存储与规则本身（`wants/pickSeed/run/brief`）；
   * - `imagineView()` —— 「她想的」那一屏（现在只有一个 `view()`，面板等 P2）。
   *
   * ⚠️ 它**不是**记忆：`imagine.jsonl` 不参与检索、不写账、不推心情。
   */
  imagine: () => imagine,
  imagineView: () => imagine.view(),
  imagineNow: (opts) => imagineNow(opts || {}),

  /**
   * ★ 她的手机（2026-10-30）：真安卓，MuMu + adb。
   * `show()` 把模拟器窗口露出来摆成竖屏（用户选的 UX：不要小面板）；
   * `state()` 只读；`run()` 是自检/设置页手动触发一件事的入口。
   */
  phone: {
    state: phoneState,
    show: (bounds) => showPhoneWindow(bounds),
    hide: () => hidePhoneWindow(),
    /** ★ 2026-10-30：`tools\phone.cjs doctor` / 设置页自检：这台机器到底认不认得出手机。 */
    probe: async () => {
      const a = ensurePhone();
      if (!a) return { ok: false, why: '手机没开（第 3 挡才开）' };
      return a.adb.doctor();
    },
    /** 认出/没认出的路径（不碰 adb）。 */
    paths: () => (ensurePhone() ? phoneRt.adb.paths() : null),
    run: (goal, opts = {}) => {
      const agent = ensurePhone();
      if (!agent) return { id: '', accepted: false, why: '手机没开' };
      return agent.enqueue({ goal, ...opts });
    },
    stop: () => { try { phoneRt?.stop(); } catch { /* 没在跑 */ } return phoneState(); },
    /** 手动推一次"她该不该想玩手机"（自检/调试；正式跑由 60 秒心跳）。 */
    roam: (at) => phoneLifeTick(at || Date.now()),
    /**
     * ★ 2026-10-31：她自己的手机生活（需求条 / 提案 / 会话 / 日记）。
     * `state()` 只读；`approve()` 是"他点头了"的脚本入口；`paths` 给自检看文件在哪。
     */
    life: {
      state: (at) => ensureLife().state(at || Date.now()),
      approve: (opts) => ensureLife().startApproved(opts || {}),
      wrap: (why) => (lifeRt ? lifeRt.wrap(why || '手动收尾') : null),
      paths: () => (lifeRt ? lifeRt.paths : {
        life: path.join(DATA_DIR, 'phone', 'life.json'),
        diary: path.join(DATA_DIR, 'phone', 'diary.jsonl'),
      }),
    },
    model: () => phoneModel(),
    /** ★ 2026-11-01：给自检用 —— "没排上"那段处境怎么写（纯函数，不用起手机）。 */
    refusedHint: (refused) => phoneRefusedHint(refused),
    parseTag: phoneAgentMod.parseTag,
    /** 桌宠页面订阅"她在手机上干了什么"（转给页面显示）。 */
    on: (cb) => {
      bus.on('phone', cb);
      return () => bus.off('phone', cb);
    },
  },

  /**
   * ★ QQ 网关（2026-10-26）：设置页/桌宠页用这几个动作管 NapCat。
   * 只暴露动作和只读状态；token、进程句柄都留在 `companion-gateway.cjs` 里。
   */
  gateway: {
    state: () => gw.publicState(),
    start: () => gw.start(),
    stop: () => gw.stop(),
    restart: () => gw.restart(),
    refreshQr: () => gw.refreshQr(),
    quickLogin: (uin) => gw.quickLogin(uin),
  },

  /**
   * ★ 表情包（2026-10-26）：本地目录 + 小号 QQ 收藏。
   * 设置页读 `state()`、手动 `refresh()`；`dir` 用来「打开文件夹」。
   */
  stickers: {
    state: stickerState,
    refresh: refreshStickers,
    dir: STICKER_DIR,
    qqDir: QQ_STICKER_DIR,
  },

  /**
   * ★ 2026-11-01：她的声音（QQ 语音）。
   * `state()` 只读；`probe()` 只看本地有没有配 Key；`preview()` 合成一段给「音色」窗口试听。
   * （原先还有个 `test()` 发一条到 QQ —— 用户 2026-11-01 说试听不用发 QQ，已去掉。）
   */
  voice: {
    state: () => publicState().voice,
    /** 「音色」窗口要的那几样：开关、四个旋钮、接口地址、混音方案（**不含 Key 明文**）。 */
    settings: () => {
      const v = voiceCfg();
      return {
        enabled: v.enabled,
        keyed: !!v.tts.apiKey,
        today: voiceState().countToday || 0,
        resourceId: v.tts.resourceId,
        mix: v.tts.mix.map((m) => ({ ...m })),
        tts: {
          speechRate: v.tts.speechRate,
          loudnessRate: v.tts.loudnessRate,
          pitch: v.tts.pitch,
          emotion: v.tts.emotion,
          emotionScale: v.tts.emotionScale,
          endpoint: v.tts.endpoint,
        },
      };
    },
    probe: () => voiceMod.probe(cfg.voice || {}),
    preview: (patch) => voicePreview(patch || {}),
    paths: { state: VOICE_FILE },
  },

  /**
   * ★ 2026-11-02：她的耳朵（语音识别，方舟 doubao-seed-2-1-lite）。
   * 配置在**单独的** `config\voice-asr.json`（见 `companion-asr.cjs` 文件头第 3 条）：
   * 这里只做只读读取 + 手动保存/试转写，给设置页和自检用。
   */
  asr: {
    settings: () => {
      const c = asrCfg();
      return {
        enabled: c.enabled,
        keyed: !!c.ark.apiKey,
        model: c.ark.model,
        endpoint: c.ark.endpoint,
        thinking: c.ark.thinking,
        reply: c.reply.voice,
        mic: { ...c.mic },
        path: asrMod.CONFIG_FILE,
      };
    },
    save: (patch) => asrMod.save(patch || {}),
    transcribe: (base64, opts = {}) => asrMod.transcribe(asrCfg(), { audio: base64, ...opts }),
    describe: (r) => asrMod.describe(r),
    /** ★ 给自检用：这一批语音怎么写进处境（"回文字还是语音由她自己决定"那条就在里面）。 */
    situationFor: (items) => voiceSituation(items),
  },

  /**
   * ★ 2026-10-27：自主说话。设置页读 `state()`；自检/调试用手动 `tick(at)` 推一次
   * （`at` 可以给假时间），`think()` 让她现在就"想一下"，`mind()` 拿念头池。
   */
  presence: {
    state: () => presenceState(),
    tick: (at) => presenceTick(at),
    think: (opts) => thinkOnce(opts || {}),
    mind: () => (presenceRt ? presenceRt.mind : null),
    machine: () => (presenceRt ? presenceRt.machine : null),
    paths: { state: PRESENCE_FILE, mind: MIND_FILE },
  },

  /**
   * ★ 2026-11-03：自动补发的节奏（`batchWaits` / `noticeGapMs`）。
   * **只给自检改**：`09-companion` 会把等待压到几十毫秒，正式运行别动。
   */
  retryPolicy,

  // 事件
  on: (ev, fn) => bus.on(ev, fn),
  off: (ev, fn) => bus.off(ev, fn),
};

module.exports = companion;
