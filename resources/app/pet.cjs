/**
 * 大肥鱼的脑子：穿什么、说什么、什么时候动、要不要问大模型。
 *
 * 台词全在 lines.cjs；接模型的配置和调用在 llm.cjs；这里只管"什么时候说哪一句"。
 *
 * **应答链**：所有气泡都从 `reply()` 排队，一条一条放出去，同一时刻页面里只有一个气泡。
 * 三条规矩决定了「连点/拖拽之后一直弹」和「说的话跟操作对不上」不会发生：
 *
 *   1. 合并：同一类操作（连戳、连续抓放）在 `BATCH_MS` 内的若干次只合成**一个**气泡，
 *      档位（第一次/又戳/够啦）照样按次数升，所以连点的反馈反而更准；
 *   2. 限速：两个气泡之间至少隔 `SAY_GAP_MS`，队列再长也是慢慢说，不会连珠炮；
 *   3. 过期：气泡排队超过 `ttl` 就不说了，免得几秒前那次点击的回话现在才冒出来。
 *      模型回复等得久（本地 3B 热机约 1 秒、冷启动十几秒），所以它的 ttl 最长；
 *      等超时的回复即使回来了也丢掉，不会答非所问。
 *
 * 页面用一套 JSON 协议跟这里通信：
 *
 *   发过去 ——
 *   { t:'init',  skin, roam, sound, theme, scale, user, doubleClickChat, hoverButtons, autoChat, bot }
 *   { t:'prefs', … }                                   同样的字段,之后单独改某一个
 *                                                      (前向页面上开「自动说话」也是这条)
 *   { t:'say',   id, beats:[ { text, actions:[…] } ] } 一个气泡;每个 beat 先做动作再打字
 *   { t:'ask',   id, question, options:[…], own }      一张选择卡（它主动问你）;**任何一条 say 都会把它收掉**
 *   { t:'act',   actions:[…] }                         只做动作
 *   { t:'walk',  id, to }                              to = 0..1 的窗口宽度,或 'cursor'
 *   { t:'thinking', on }                               思考表情(等模型回复时用)
 *
 *   收回来 ——
 *   { t:'hello', screen, host }
 *   { t:'touch', kind, at, stage, … }  kind = grab | pet | poke | drop | throw | crash
 *                            `at` = 落在哪个部位（head|body|hand|fin|tail|low|foot，见 AREAS）；
 *                            `stage` = 同一个手势的不同阶段：pet → start|good|over · grab → long（拎久了）
 *                            poke 带 `woke`(刚从睡里被戳醒) · pet 带 `asleep`(还在睡)
 *   { t:'answer', askId, index } / { …, dismissed:true } 你选了那张卡的哪一项（或跳过）
 *   { t:'text',  text }      你在气泡里打了字
 *   { t:'control', action }  右键菜单点的:settings | pause | resume | quit
 *   { t:'prefs' | 'position' | 'arrived' | 'interrupted' }
 */
const path = require('node:path');
const log = require('./log.cjs');
const store = require('./store.cjs');
const lines = require('./lines.cjs');
const clock = require('./clock.cjs');
const llm = require('./llm.cjs');
const tts = require('./tts.cjs');
const memory = require('./memory.cjs');
const mood = require('./mood.cjs');
const dress = require('./dress.cjs');
// QQ 陪伴模式（内置内核）。她开不开是运行期的事，这里只把模块拿进来。
const companion = require('./companion.cjs');
// 她的耳朵：麦克风 PCM → 分句 → 方舟转写（2026-11-02，见 companion-asr.cjs）
const asrMod = require('./companion-asr.cjs');

/* ---------- 记住它站的位置 ---------- */
/**
 * 页面一直在报它站在哪儿（`{t:'position', x}`，x 是窗口宽度的比例），以前 World 这边
 * "暂时没事可做"就扔了。现在存一个小文件，启动时从 `INIT.startX` 发回去。
 *
 * **故意不用 `llm.save`**：那个每写一次就往日志打一行"设置已保存"，位置这种东西会把它刷爆
 * （交接文档第 8 节记过同类问题：闲话把真错误埋了）。这里最多 20 秒写一次。
 * 文件放在 `data\` 下跟 pet.log 做邻居，所以 `DSP_LOG_DIR` 一改（自检）就一起被隔离了。
 */
const POS_FILE = path.join(path.dirname(log.file), 'pet-pos.json');
const POS_SAVE_MS = 20_000;
let posSavedAt = 0;
function loadPetX() {
  const d = store.readJson(POS_FILE);
  const x = d && d.x;
  return typeof x === 'number' && x >= 0 && x <= 1 ? x : null;
}
function savePetX(x) {
  if (typeof x !== 'number' || !(x >= 0 && x <= 1)) return;
  const now = Date.now();
  if (now < posSavedAt) return;
  posSavedAt = now + POS_SAVE_MS;
  const err = store.writeJson(POS_FILE, { x: +x.toFixed(4), at: new Date().toISOString() });
  if (err) log.warn(`位置没存下来:${err.message}`);
}

/** 部位的中文名（台词和模型上下文都用它，对应 pet-app.js 的 REGION_AT / 这里的 AREAS）。 */
const AREA_CN = {
  ahoge: '呆毛', hair: '头发', eyes: '眼睛', cheek: '脸蛋', chin: '下巴',
  neck: '脖子', chest: '胸口', belly: '肚子', waist: '腰', skirt: '裙子',
  hand: '手', fin: '鳍', tail: '尾巴', thigh: '大腿', foot: '脚',
};

/** 「刚发生在它身上的事」——一句话，喂给模型当上下文（它自己可不知道刚才被谁摸了头）。 */
function eventPhrase(m) {
  const what = AREA_CN[areaOf(m)] || '';
  switch (m.kind) {
    case 'poke': return `你刚被戳了${what || '一下'}`;
    case 'pet': return m.asleep ? '你刚在梦里被摸了摸' : `你刚被摸了${what || '一下'}`;
    case 'grab': return m.stage === 'long' ? '你已经被拎着好一会儿了' : '你刚被拎起来';
    case 'drop': return '你刚被放下';
    case 'throw': return '你刚被甩出去';
    case 'crash': return '你刚摔了一下';
    default: return '';
  }
}

/**
 * 给模型的一小段"此刻"：现在几点、认识你多久、刚发生了什么、它自己什么状态。
 *
 * **为什么需要**：原来每次只发人设 + 你这句话，模型对"她自己的处境"一无所知，
 * 所以答得像一个通用客服。补上这一段，本地 3B 也会明显"是她"。
 * 保持很短（几十个字）——本地模型读提示词也要花时间。
 *
 * ⚠️ 它在**模块级**：`ask()` / `autoSpeak()` 也是模块级的，放进 `attach` 里它们看不见
 * （自检就抓到过这个 `contextLine is not defined`）。
 */
function contextLine(state) {
  const s = memory.snapshot();
  /**
   * ★ 2026-11-01：这里原来有一句时间，**它是写坏的**：只拼"时段 + 分钟"、漏了小时，
   * 08:43 会变成「现在是清早43分」，等于一句废话。
   * 现在时间统一由 `clock.nowLine()` 给（`CompanionBrain.reply()` 拼在本轮消息最前面，
   * 0 挡那条 `llm.chat` 在下面的 `context` 里自己加），这里不再重复、也不再自己拼。
   */
  const bits = [];
  if (s.days > 1) bits.push(`你们认识第${s.days}天`);
  if (state.moodState) bits.push(`你现在心情${mood.LABEL[state.moodState] || '平静'}`);
  if (state.ballMode === 'game') bits.push('你正在和用户玩弹弹乐（足球）');
  else if (state.ballMode === 'ball') bits.push('旁边有个球可以玩');
  if (state.sleeping) bits.push('你刚睡醒或正犯困');
  if (state.lastEvent) bits.push(state.lastEvent);
  if (s.areaTop && s.areaTopCount >= 5) bits.push(`你最常被摸${AREA_CN[s.areaTop] || '这儿'}`);
  if (s.words && s.talks >= 2) bits.push(`用户上次对你说过「${s.words}」`);
  return `${bits.join('，')}。`;
}

/**
 * 读一下你刚打的那句话的情绪（`readTone`），记在 `state.tone` 上。
 * 读不出来就把上一次的清掉——**不然"上一句的累"会一直影响后面的回答**。
 * 顺手记一行日志：想知道"为什么它这次答得特别软/特别嗨"，看这一行就够。
 */
function noteTone(state, text) {
  const tone = readTone(text);
  state.tone = tone;
  state.toneHint = tone ? (TONE_HINT[tone] || '') : '';
  if (tone) log.info(`听出情绪:${tone}（本地关键词，不花 token）`);
  return tone;
}
/** 小时 → 时段。比 `partOfDay()` 的四段细一点，专门给"你常在的时段"和模型上下文用。 */
const HOUR_CN = (h) => (h < 5 ? '凌晨' : h < 9 ? '清早' : h < 12 ? '上午' : h < 14 ? '中午' : h < 18 ? '下午' : h < 23 ? '晚上' : '深夜');

/**
 * 台词里的占位符（**唯一**的替换点，在应答链里）：
 *
 *   `{name}` 你的名字（设置页「你的名字」）· `{days}` 认识第几天
 *   `{area}` 最常被碰的部位 · `{words}` 你上次打的那句话 · `{hour}` 你常在的时段
 *
 * 取不到值的占位符**原样留着**——一眼就能看出是台词写错了，而不是悄悄变成空字符串。
 */
function fill(line, vars) {
  if (!line || typeof line.text !== 'string') return line;
  return { ...line, text: line.text.replace(/\{(\w+)\}/g, (m, k) => (vars && vars[k] != null && vars[k] !== '' ? String(vars[k]) : m)) };
}

/** 你不在（或在别处忙）时的判定：系统的空闲时长，跟"你多久没碰它"不是一回事。 */
const AWAY_SEC = 240;        // 系统 4 分钟没有任何输入 = 你不在
const AWAY_POLL_MS = 5000;   // 每 5 秒看一次（很便宜）

/* ---------- 心情（那一条连续的数，见 mood.cjs） ---------- */

/** 心情心跳的间隔。它只做"慢慢回归中位 / 按时间改精神"，30 秒一次足够。 */
const MOOD_TICK_MS = 30_000;
/** 发呆 / 犯困优先挑当前心情专属的那几句：这几桶可能是空的，空了就退回原来那套。 */
const MOOD_PICK_TRIES = 4;

/**
 * 从一组台词里挑一条**当前心情专属**的（`lines.mood.<档>`，见 lines.cjs 的注释）。
 *
 * 为什么不是"先查有没有再挑"：台词桶是抽签不重复的（`next()`），
 * 直接 `next(lines.mood?.[state]) || next(fallback)` 就够——没有这个档、或者桶是空的，
 * 自然退回原来那句，一行判断都不用加。**心情只影响它自己找话说的那一路**
 * （发呆、犯困），戳/摸/拖拽这些对刚才那一下的回话一直照旧。
 */
function moodPick(state, fallback) {
  const list = lines.mood?.[state.moodState];
  return (list && list.length ? next(list) : null) || next(fallback);
}

/** 心情只改"步调"，不动任何判定：动作、走路、发呆间隔都按这个倍率缩放。 */
const moodSpeed = (state) => (typeof state.moodSpeed === 'number' ? state.moodSpeed : 1);

/* ---------- 本地情绪识别（不花 token 的那一层"懂你"） ---------- */

/**
 * 你打的字先在这儿过一遍。命中就返回一个情绪名（对应 `lines.emotion` 的桶）。
 *
 * **为什么值得做**：本地 3B 看不出"今天累死了"和"今天真开心"的区别，云端模型也常常只顾着
 * 接话；而这一层**零依赖、零延迟、不花 token**，只要几个关键词就能让它答得像"听懂了"。
 *
 * **顺序是有意的**（数组从前往后试）：先认负面和"累"，再认客气话，最后才是开心。
 * 因为"累死了但今天还挺好"这种句子，先认出累才对——「累」放在「开心」后面就会被
 * 那个"好"字抢走。改顺序就改这张表的顺序。
 */
const TONE = [
  ['tired', /累|困死|好困|熬夜|加班|忙死|撑不住|顶不住|疲惫|没力气|不想动|睡了|该睡了/],
  ['sad', /难过|不开心|委屈|想哭|哭了|伤心|失落|emo|郁闷|烦死|沮丧|孤独|没人/],
  ['angry', /生气|气死|讨厌|烦人|可恶|过分|混蛋|火大|气炸|烦透|受不了/],
  ['thanks', /谢谢|多谢|感谢|辛苦了|麻烦你了|谢啦/],
  ['praise', /可爱|好看|喜欢你|爱你|真棒|厉害|好萌|好可爱|太可爱|棒极了/],
  ['worried', /你还好吗|你没事吧|怎么了|不舒服|生病|感冒|发烧|注意身体/],
  ['happy', /哈哈|开心|高兴|太好了|太棒|耶|爽|舒服|好耶|快乐|嘻嘻|笑死|不错哦|中奖|成了/],
];

/** 读一句人话里的情绪；读不出来就返回空串（**读不出是常态，不是错误**）。 */
function readTone(text) {
  const s = String(text || '');
  if (!s) return '';
  for (const [name, re] of TONE) if (re.test(s)) return name;
  return '';
}

/** 情绪 → 给模型的一句提示（塞进 system 的【此刻】后面）。读不出来就没这句。 */
const TONE_HINT = {
  tired: '用户听起来很累，说点安慰的，别提要求。',
  sad: '用户情绪低落，先陪着，别讲道理、别逗他。',
  angry: '用户在生气，顺着他说，别劝架。',
  thanks: '用户在谢你，别客气过头。',
  praise: '用户在夸你，可以有点小得意。',
  worried: '用户在关心你，回答得让人放心。',
  happy: '用户心情很好，跟着一起高兴。',
};

/* ---------- 不说话的小动作（"活着的质感"） ---------- */

/**
 * 发呆之间那些**不出声的微动作**：歪头、换重心、瞟一眼鼠标。
 * 页面侧由 pet-core 的 `microStep()` 画（见 pet-app.js 的 `case 'micro'`）。
 *
 * 为什么单独一条定时器、不塞进 `fidget()`：`fidget` 在有选择卡、暂停、你不在的时候会
 * 整段返回，而"她其实是活的"这件事**恰恰应该在这些时候也看得到**（只是不出声）。
 */
const MICRO = ['tilt', 'step', 'look'];
const MICRO_MIN_MS = 22_000;
const MICRO_MAX_MS = 52_000;

/**
 * 它穿什么。`figure: 'whale'` 是 DeepSeek 大肥鱼；`scheme` 对应 web\whale\model.json 里的配色，
 * 这里只带了 `deepseek`（原版），贴图在 web\whale\tex 和 web\whale\feat。
 *
 * **换装那一层在 `dress.cjs`**（用户要的是"以后加全新服装"，不是上游那 8 套配色）：
 * 它记着挑了哪一套，`skinOverride()` 只在**页面认得的 scheme** 上返回覆盖值，
 * 其余一律 `null` → 就用下面这个默认的。所以服装模块出任何问题都不会影响她出现。
 */
const SKIN = dress.skinOverride() || { figure: 'whale', scheme: 'deepseek' };

/**
 * 页面一连上就发过去。**这就是让大肥鱼出现的那一条**：在收到带 `skin` 的
 * `init`（或 `prefs`）之前，页面画的是一直内置的 Coo。
 */
/**
 * ★ 2026-11-01：**INIT 只读一次设置**。
 * 原来这个对象里 `llm.load()` 写了 6 次 —— 模块加载时就是 6 次同步读 `settings.json`。
 * 合成一次，下面的字段都从 `initCfg` 取。
 */
const initCfg = llm.load();
const INIT = {
  t: 'init',
  skin: SKIN,
  roam: 'calm',            // off 不乱动 · calm 多待着 · free 常走动 · cling 黏着你（跟着光标）
  // 让它开口念大模型的回答。`voice` 这一版只有两档意思：true=念，false=不念；
  // 页面把它和 `sound` 合成一个三档按钮（关 / 音效 / 音效+语音）。
  // 默认：**语音文件齐了就开**（用户的要求：接上模型时语音默认开着）。
  voice: tts.available() && initCfg.voice !== false,
  theme: 'dark',
  scale: 1,                // 想让它大一点就调这里：1.3、1.5……
  /**
   * ★ 2026-11-01：**声音总闸跟着配置走**（原来写死 true）。
   * 页面那边每次启动都拿这条 `init` 去 `sfx.set()`，于是"关掉声音"重启又响
   * （`sfx` 自己存进 localStorage 的 off 每次都被这一条覆盖）。
   */
  sound: initCfg.sound !== false,
  // 它叫你什么。设置页「你的名字」写进 config\settings.json 的 `user`，这里读出来。
  user: initCfg.user || '你',
  // 它现在什么心情（love / energy 两条轴推出来的档）：页面拿它调步调与"黏着你"的距离。
  // 心跳每 30 秒会重发一次（见 attach 里的 moodTick）。
  mood: mood.snapshot(),
  // 记住它上次站的位置（页面报、World 存，见上面 PET 那段）
  rememberPosition: true,
  startX: loadPetX(),
  // 双击打开打字框：**关掉了**。连点两下本来就是在戳它（连击升级那套），双击抢了同一个手势；
  // 想打字用悬停那个「对话」按钮（只留了一个按钮，就在它旁边）。
  doubleClickChat: false,
  /**
   * ★ 2026-11-01 修：这里原来**写死 false**，而 `attach()` 里给页面建的 `state.autoChat`
   * 读的是配置（`llm.load().autoChat === true`）。于是"配置里开着"的时候她真的在说，
   * 菜单按钮却显示"关"；你点一下"开"，World 认为没变、不保存；再点一下才真关。
   * 现在两边同源。
   */
  autoChat: initCfg.autoChat === true,
  // 玩具球 / 弹弹乐的三态（悬停那个球按钮循环切换；存在 config\settings.json 的 `ballMode`）
  ballMode: ['off', 'ball', 'game'].includes(initCfg.ballMode) ? initCfg.ballMode : 'off',
  /**
   * ★ **天气**（2026-10-10）：`off` / `snow` / `blossom` / `leaf` / `rain`。
   * **页面自己切、自己判**（粒子、她的反应、天气话全在 pet-app.js 里，见那段注释）——
   * World 这边只做两件事：把它记进 `config\settings.json`、重连时同步回去。
   * 所以天气**不进台词链、不进 LLM 上下文**，改这里也不会牵连主逻辑。
   */
  weather: ['off', 'snow', 'blossom', 'leaf', 'rain'].includes(initCfg.weather) ? initCfg.weather : 'off',
  /**
   * ★ **天气的环境音**（2026-10-11 用户："给天气音效一个单独开关，加在右键小肥鱼后的栏位里，
   * 不显示在浮窗"）。默认开；`false` 只关环境音（她的音效/语音照旧）。
   * 跟 `weather` 一样：页面自己判自己响，World 只负责记进 `config\settings.json` 并在重连时同步。
   */
  weatherSound: initCfg.weatherSound !== false,
  /**
   * ★ **QQ 陪伴模式**（2026-10-22）。开着时：
   *   · 桌宠里打字不再走原来的 `llm.chat`，改走 `companion.chat`（角色卡 + 按人记忆 + 拟人化分条）；
   *   · 页面右上角出现一块只读的手机面板，显示 QQ 那边的收发；
   *   · 她自己连 OneBot（SnowLuma/NapCat），或者只读外部 kit 的 `events.jsonl`。
   * 这里给的是**只读状态**（不包含 QQ 号/token），页面只拿它决定显示什么。
   */
  companion: companion.publicState(),
  /**
   * 悬停时它旁边出现的按钮 —— **2026-10-22 起是四个，摆成 2×2**：
   * 对话 / 玩球 / 天气 / 陪伴模式（小手机）。
   *
   * ★ 这四个是"常用快捷入口"，**右键菜单里不再重复出现**（pet-app.js 的 openMenu 按
   * `prefs.hoverButtons` 跳过）。其余动作照旧只在右键菜单里。
   *
   * id 必须是 pet-app.js 里 ACTIONS 的键 (chat, companion, memory, game, weather, voice,
   * roam, theme, sound, weatherSound, dress, hide)；voice 和 dress 依赖这一版没带的模块，
   * 写了也不会显示。最多 MAX_HOVER（pet-app.js，6）个；超过 3 个时自动排两列。
   *
   * ★ 2026-11-04：`auto`（自动说话）已经**不是** ACTIONS 的键了 —— 那个开关搬进了
   * 设置页「桌宠模型」卡（`config/settings.json` 的 `autoChat`）。别把它加回来。
   */
  hoverButtons: ['chat', 'game', 'weather', 'companion'],
  /**
   * 右键它时弹出的那个菜单头。`controls: true` 是必须的，不给页面直接不画菜单。
   * 点哪一项会回一条 {t:'control', action}，在下面 attach 的 switch 里处理。
   */
  bot: {
    controls: true,
    name: '大肥鱼',
    paused: false,
    quitLabel: '退出桌宠',
    quitPrompt: '要让我退下吗?',
    buttons: { pause: true, settings: true, voice: true, quit: true, dress: true },
  },
};

/** 不说话时它自己动一动的动作池。 */
const FIDGET = ['look', 'nod', 'hop', 'sit', 'happy', 'shy', 'sleepy', 'thinking', 'spin'];

/** 多久没人理就开始犯困、再多久直接睡过去。 */
const DROWSY_AFTER_MS = 4 * 60_000;
const SLEEP_AFTER_MS = 6 * 60_000;
/** 离开超过这么久再碰它，会先说一句「你回来啦」再出反应。 */
const RETURN_AFTER_MS = 8 * 60_000;
/** 两次戳的间隔小于这个值才算连击。 */
const POKE_COMBO_MS = 2500;
/** 它自己动一动的间隔。 */
const IDLE_MIN_MS = 35_000;
const IDLE_MAX_MS = 90_000;
/**
 * 喂给模型的历史轮数上限（一轮 = 一问一答）。
 * ★ 2026-11-01：**和 `llm.cjs` 用同一个常量**（那里原来是 `slice(-6)` = 3 轮，
 * 这里按 8 条裁剪 → 最老那一轮被静默丢掉）。改一处就够，两边不会再漂。
 */
const HISTORY_TURNS = llm.HISTORY_TURNS;

/* ---------- 应答链（气泡什么时候说、说几句、什么时候不说） ---------- */

/** 同一类操作在这个窗口内的若干次只出一个气泡（连点/连续抓放合成一句）。 */
const BATCH_MS = 220;
/**
 * 两个气泡之间至少隔这么久，免得一口气连珠炮。
 *
 * ★ 2026-11-01：改成**每次现读**（而不是模块加载时算一次），两个原因：
 *   · 自检可以按区压短（`DSP_SAY_GAP_MS`）—— `05a/05b/05e/05f` 那几区每次等气泡
 *     都要白等 1.2 秒，加起来 16 秒；
 *   · `05d` 那条"气泡间隔 1.1~3.2 秒"的断言**必须验默认值**，所以它会在断言前
 *     临时摘掉这个变量（见 `05d-touch.cjs`）。写死读一次的话，那种"先压短再验默认值"
 *     的写法就没法做了。
 */
const sayGapMs = () => {
  const n = Number(process.env.DSP_SAY_GAP_MS);
  return Number.isFinite(n) && n >= 0 ? n : 1200;
};
/** 页面打字的节奏（字/秒）：只用来算"这一条要说多久、下一条排多后"。 */
const typeCps = () => {
  const n = Number(process.env.DSP_TYPE_CPS);
  return Number.isFinite(n) && n > 0 ? n : 20;
};
/**
 * 一句话的寿命：排队超过 `ttl` 就不说，免得几秒前那一下的回话现在才冒出来。
 * 只有**对刚才那一下操作的回话**会过期；问候、发呆、模型回答跟时刻无关，慢慢等没关系。
 */
const TTL_MS = {
  react: 2500,      // 戳/抓/放/摔：过两秒半就没意义了，那是上一次点击的回话
  line: 0,          // 问候、发呆、模型回答：什么时候说出来都对
};
/** 排队的气泡数上限：再多就把最旧的丢掉。 */
const QUEUE_MAX = 3;
/**
 * 你连着打字时，上一句还在想，这一句先记着（`state.pending`）。
 * 但记太久的就没必要再问了——答案出来时你自己都换话题了，何况它还会顶掉新问题该有的回答。
 * 超过这个时间就丢掉，只保留最近这一句。
 */
const PENDING_TTL_MS = 8000;

/* ---------- 部位：同一个手势落在身上不同的地方，说不一样的话 ---------- */

/**
 * 页面报上来的 `at` 是**身体部位**：由 pet-app.js 就着 whale\model.json 的部件框量出来的
 * （那张表在 pet-app.js 的 `REGION_BOXES` + `REGION_AT`）。这里只认名字并对上台词。
 *
 * ★ 2026-10-10 从 **7 类细化到 15 类**（用户："眼睛、脸蛋和头分开，脚掌和大腿分开，
 * 手和肩膀分开，裙子和胸口分开，呆毛和头发分开"）：原来只有 head/body/fin/tail/low/hand/foot，
 * 现在多出 ahoge（呆毛）、eyes（眼睛）、cheek（脸蛋）、chin（下巴/嘴）、neck+chest（脖子/胸口）、
 * belly（肚子）、waist（腰）、thigh（大腿）。
 *
 * **不认识的（或老页面没报）就退回原来那几桶通用台词**，所以判定出错最多是"说了通用的话"，
 * 不会变成哑巴。想挪分界线去改 pet-app.js 那两张表，这里不用动。
 */
const AREAS = new Set([
  'ahoge', 'hair', 'eyes', 'cheek', 'chin',
  'neck', 'chest', 'belly', 'waist', 'skirt',
  'hand', 'fin', 'tail', 'thigh', 'foot',
]);
/**
 * **"摸头"那一族**（细化之后 `head` 被拆成了这五个；见 `AREAS`）。
 * 只有一处用它：摸这几处算**两下**好感（它最喜欢被摸头），见 `attach` 里那段。
 */
const HEAD_FAMILY = new Set(['ahoge', 'hair', 'eyes', 'cheek', 'chin']);
/** 这一下落在哪个部位，没有就返回空串。 */
const areaOf = (m) => (typeof m.at === 'string' && AREAS.has(m.at) ? m.at : '');

/**
 * ★ **细化之后的"近亲兜底"**（2026-10-10 部位从 7 类扩到 15 类时加的）。
 *
 * 为什么要它：15 个部位里有几个"小部位"（呆毛/眼睛/脸蛋/下巴/脖子/胸口/腰/大腿）**没打算各写一桶台词**，
 * 但**也不能因此就不认它** —— 不认的话戳呆毛会掉回通用台词，比原来 7 类时还差。
 * 所以查表顺序是：**本部位的桶 → `fallback[本部位]` 那一族的桶 → 该段的 all / 通用**。
 *
 * 想给某个小部位写专属台词：直接在 `lines.pokeArea` / `petArea` / `petting` 里加一项即可，
 * 本部位优先，兜底表自动让位。**兜底表都在 lines.cjs 里**（`petAreaFallback` / `pettingFallback`）。
 *
 * ⚠️ `fallback` **必须由调用方显式传**（不是从 lines 里偷偷取一张全局的）：
 * 每一张表该往哪一族退是不一样的（戳呆毛 ≠ 蹭呆毛），取错了会静默说出"隔壁部位"的话。
 */
function areaLines(table, fallback, area) {
  if (!area || !table) return null;
  if (table[area]) return table[area];
  const near = fallback?.[area];
  return (near && table[near]) || null;
}

/* ---------- 它会问你（页面里那套选择卡，以前没人用过） ---------- */

/**
 * 摸够这么多"下"它就想问你一句（问出去就清零）。**摸头算两下**——那是它最喜欢的。
 *
 * ★ 2026-11-01：改成**每次现读**，跟 `sayGapMs()` 同一个理由。
 * 自检里 `05e` 那一段会连着蹭十几次（它验的是"哪个部位说哪一桶话"），
 * 攒着攒着就把这张卡提前问出来了 —— 而卡一举着，`case 'touch'` 会在
 * `if (state.card) break` 那里**一条话都不说**，于是 `05e` 后面几条断言全等不到气泡、
 * `05f` 再摸四下也问不出新卡（`askQuestion()` 看到 `state.card` 直接 return）。
 * 所以 `harness.cjs` 把这个阈值调到"摸不出来"，只有 `05f` 自己按默认值 3 跑。
 */
const askAfterPets = () => {
  const n = Number(process.env.DSP_ASK_AFTER_PETS);
  return Number.isFinite(n) && n > 0 ? n : 3;
};
/** 两次提问至少隔这么久，免得刚问完又凑上来问。 */
const ASK_COOLDOWN_MS = 3 * 60_000;
/** 卡片最多举这么久：没人选就把它收掉，换一句"算了，当我没问"。 */
/** 卡片最多举这么久：没人选就把它收掉，换一句"算了，当我没问"。
 *  **举着的时候它不出声**（见 case 'touch' 的注释），所以这个值也是"它闭嘴多久"——
 *  别调太大，20 秒够看清两个选项了。 */
const ASK_TTL_MS = 20_000;

/* ---------- 自动说话（接了模型之后，它每隔一阵自己找个话头） ---------- */

/**
 * 自动说话的两个间隔。默认都是一分钟；`config\settings.json` 里的同名字段可以改，
 * `DSP_AUTO_CHAT_MS` / `DSP_AUTO_CHAT_QUIET_MS` 环境变量优先（自检用）。
 *
 * 为什么配置里也留一份：这台机器上桌宠是用 **WMI** 起的（见交接文档第 7 节第 4 条），
 * 而 **WMI 起的进程不继承调用者的环境变量**——实测 `%DSP_AUTO_CHAT_MS%` 到子进程就空了。
 * 所以"想临时压短间隔看看效果"这种事，走配置才靠得住。
 */
const envMs = (name) => (Number(process.env[name]) > 0 ? Number(process.env[name]) : 0);
const cfgMs = (key) => {
  const v = Number(llm.load()[key]);
  return v > 0 ? v : 0;
};
const AUTO_CHAT_MS = envMs('DSP_AUTO_CHAT_MS') || cfgMs('autoChatMs') || 60_000;
const AUTO_CHAT_QUIET_MS = envMs('DSP_AUTO_CHAT_QUIET_MS') || cfgMs('autoChatQuietMs') || 60_000;
/** 让回答每次都换一个花样（不然小模型会一直重复同一句）。 */
const AUTO_CHAT_TEMPERATURE = 1.12;
/** 记住最近几句自己说过的话，太像就重说一次（3B 实测：不动它就一直聊吃的）。 */
const AUTO_CHAT_MEMORY = 4;
/** 相似到什么程度算"又说了一遍"（按字去重后的重合比例）。 */
const AUTO_CHAT_SAME = 0.5;
/** 最多重说几次；超过就干脆不说，免得你等半天。 */
const AUTO_CHAT_RETRY = 2;
/**
 * 自动说话时喂给模型的那句。它**不进对话历史**，所以不会把上下文搅乱；
 * 里面明确要求"不要提到用户/系统"：本地 3B 有时会露怯，说出"系统提示我……"这种话。
 */
const AUTO_CHAT_PROMPT = [
  '（现在没人跟你说话，你可以自己随口说一句。）',
  '用「大肥鱼」的口气，想说什么就说什么，一句话，不超过 20 个字。',
  '不要提问、不要提到"用户/系统/提示词"、不要自称 AI。',
].join('');
/** 上一句说过的话太像时，换一句再问。 */
const AUTO_CHAT_AGAIN = '换个话题，别跟上一次说的一样。';
/** 小模型偶尔会把提示词/人设念出来（"系统提示我……"），这种一律不要。 */
const AUTO_CHAT_LEAK = /用户|系统|提示词|提示语|assistant|AI\b/;

/** 去重字符集合：两个句子重合得越多，越像"又说了一遍"。 */
function letterSet(text) {
  return new Set(String(text).replace(/[\s\p{P}]/gu, ''));
}
/** 一句新话跟最近说过的几句有没有太像（重合比例超过 `AUTO_CHAT_SAME`）。 */
function tooSimilar(text, recent) {
  const a = letterSet(text);
  if (!a.size) return true;
  if (AUTO_CHAT_LEAK.test(text)) return true;      // 把提示词/人设念出来了
  for (const prev of recent) {
    const b = letterSet(prev);
    if (!b.size) continue;
    let same = 0;
    for (const ch of a) if (b.has(ch)) same += 1;
    if (same / Math.max(a.size, b.size) >= AUTO_CHAT_SAME) return true;
  }
  return false;
}

let seq = 0;

/* ---------- 抽签不重复 ---------- */

/** 每个台词数组一个签筒，记在数组自己身上。 */
const bags = new Map();

/**
 * 从 `list` 里挑一条，同一个数组一轮之内不重复：洗好牌一条条抽，抽完才重洗。
 * 重洗后还会避开上一轮的收尾，免得同一句连着出现两次。
 */
function next(list) {
  if (!Array.isArray(list) || !list.length) return null;
  let draw = bags.get(list);
  if (!draw) {
    let pool = [];
    let last = null;
    draw = () => {
      if (!pool.length) {
        pool = list.slice();
        for (let i = pool.length - 1; i > 0; i -= 1) {
          const j = Math.floor(Math.random() * (i + 1));
          [pool[i], pool[j]] = [pool[j], pool[i]];
        }
        if (pool.length > 1 && pool[pool.length - 1] === last) {
          [pool[pool.length - 1], pool[0]] = [pool[0], pool[pool.length - 1]];
        }
      }
      last = pool.pop();
      return last;
    };
    bags.set(list, draw);
  }
  return draw();
}

/** 现在算一天里的哪一段，决定问候语。 */
function partOfDay(d = new Date()) {
  const h = d.getHours();
  if (h < 5) return 'night';
  if (h < 11) return 'morning';
  if (h < 17) return 'afternoon';
  if (h < 22) return 'evening';
  return 'night';
}

/* ---------- 说话 ---------- */

function send(ws, msg) {
  if (ws.readyState !== 1) return;   // 1 = OPEN
  try {
    ws.send(JSON.stringify(msg));
  } catch (err) {
    log.warn(`发送失败:${err.message}`);
  }
}

/**
 * 一个气泡，由若干 beat 组成：每个 beat 先做 `actions`，再把 `text` 打出来。
 *
 * 这是**唯一**往页面上发声的出口：`say()` 只管把话说出去，什么时候轮到它由下面的应答链决定。
 * `kind` 让页面知道这句话有多"即时"（`react` 对刚才那一下的回话 / `line` 跟时刻无关的话）；
 * `voice: true` 表示这句的语音**已经在路上或刚发过**，页面要等它念完再打字。
 * 日志里 beat 之间换行写，好一眼看出哪几条并成了一个气泡。
 *
 * `tag` 是这句话的**出处**（应答链里那个 tag：`idle` / `drowsy` / `memory` / `answer` …），
 * 页面不用它，纯粹是给"谁冒出来的"留个身份：自检要排除**计时器自己开口**的那几句
 * （`idle` / `drowsy` / `memory`）时，比文本可靠得多 —— 台词里带 `{words}` 这类占位符的，
 * 到了气泡里已经是渲染后的文本，文本比对一条都排不掉（实测踩过，见 test\smoke.cjs）。
 */
function say(ws, beats, kind, voice, tag) {
  const list = (beats || []).filter(Boolean);
  if (!list.length) return;
  log.info(`说:${list.map((b) => b.text).join('\n     ')}`);
  send(ws, { t: 'say', id: `o${++seq}`, kind, beats: list, ...(tag ? { tag } : {}), ...(voice ? { voice: true } : {}) });
}

/* ---------- 应答链：什么时候说、说几句、什么时候不说 ---------- */

/**
 * 一条连接只有一条链：`now` 是当前这个气泡什么时候说完，`pend` 是排着的队。
 *
 * 一条排队的话：`tag` 是它是什么（poke / grab / answer…，合并同类项和写日志用），
 * `beats` 是已经挑好的台词，`pick` 是等到真要说了才挑的那一种（连点要按总次数挑）。
 *
 * `speaker` 非空时，标了 `voice: true` 的气泡在放出去的同时**并行**去合成语音
 * （只有大模型的回答会标；内置台词不念）。
 *
 * `opts.cardUp` 是"现在有没有一张选择卡举着"——见 nextStep 里那道保险。
 */
function createReactor(ws, speaker, opts = {}) {
  const r = { pend: [], now: 0, timer: 0, closed: false, cardUp: opts.cardUp, vars: opts.vars };

  const mk = (tag, beats, pick) => ({ tag, beats, pick, at: Date.now() });

  function clearTimer() {
    if (r.timer) { clearTimeout(r.timer); r.timer = 0; }
  }
  /** 排队。`soon` = 先攒一攒（同一窗口里的同类操作合成一句）。 */
  function push(it, soon) {
    if (r.closed || !it) return;
    it.notBefore = soon ? Date.now() + BATCH_MS : 0;
    r.pend.push(it);
    // 队满时**先扔旧的回话**，别把眼前这一次的操作顶掉：`react` 过两秒就没意义了，
    // 而问候/模型回答（`line`）什么时候说都对，让它们把位置让给刚发生的事。
    while (r.pend.length > QUEUE_MAX) {
      const i = r.pend.findIndex((q) => q.kind === 'react');
      const gone = r.pend.splice(i < 0 ? 0 : i, 1)[0];
      log.info(`排队的「${label(gone)}」太多，丢掉最旧的一条`);
    }
    next();
  }
  /**
   * 连点/连续抓放：同一个合并窗口里的**同类**操作攒成一个气泡，排在队尾（新状态优先），
   * 台词等真要说了才挑。`count` 记攒了几下——连点的档位按总次数算，所以合并之后
   * 第五下照样会说「够啦够啦」。不同类型（比如一边戳一边甩）不合并，各自保留。
   */
  function batchTouch(it) {
    if (r.closed) return;
    const last = r.pend[r.pend.length - 1];
    const joinable = last && isBatch(last) && last.tag === it.tag && Date.now() - last.at <= BATCH_MS;
    if (joinable) {
      last.touch = it.touch;
      last.count += 1;
      last.at = Date.now();          // 合并窗口从最后一次操作算起
      return;
    }
    it.count = 1;
    push(it, true);
  }
  /**
   * 到点就出去一条。说完了（页面上限约 2 秒）再轮到下一条。
   *
   * 排队等着的时候页面是完全安静的——**没有"过一会儿又冒一句"的来源**，这就是
   * 「连点完停手还一直弹气泡」被治住的地方。
   */
  function next() {
    return nextStep().catch((err) => log.warn(`应答链出错:${err.message}`));
  }
  async function nextStep() {
    clearTimer();
    if (r.closed) return;
    while (r.pend.length) {
      const it = r.pend[0];
      // 攒同类操作的批次：窗口没过完就再等一会儿，之后再按总次数挑台词
      const batchLeft = isBatch(it) && !it.picked ? it.at + BATCH_MS - Date.now() : 0;
      if (batchLeft > 0) { r.timer = setTimeout(next, batchLeft + 10); return; }
      // 攒到这会儿才挑：连点的档位要按攒起来的次数算，所以第五下才轮到「够啦够啦」
      if (isBatch(it) && !it.picked) { it.beats = it.pick(it.count); it.picked = true; }
      const wait = Math.max(r.now - Date.now(), it.notBefore - Date.now());
      if (wait > 0) { r.timer = setTimeout(next, wait + 10); return; }
      r.pend.shift();
      const beats = it.beats;
      // 选择卡不是气泡：它没有 beat，发出去的是 `ask`（页面把它画成一张带选项的卡）。
      // 顺序很重要——**任何一条 `say` 都会把卡收掉**（页面遇到 say 就 dropAsks），
      // 而卡片已经排到队尾了，所以举卡之前不会再有话插进来。
      if (it.ask) {
        if (it.ask.actions?.length) send(ws, { t: 'act', actions: it.ask.actions });
        log.info(`问:${it.ask.text}`);
        send(ws, { t: 'ask', id: it.ask.id, question: it.ask.text, options: it.ask.options, own: false });
        r.now = Date.now() + sayGapMs();
        if (r.pend.length) r.timer = setTimeout(next, r.now - Date.now() + 10);
        return;
      }
      // 只有"对刚才那一下操作的回话"会过期；问候/发呆/模型回答跟时刻无关，慢慢等没关系
      const ttl = it.kind === 'react' ? TTL_MS.react : 0;
      if (ttl && Date.now() - it.at > ttl) {
        log.info(`「${label(it)}」等太久（${Date.now() - it.at}ms），不说了`);
        continue;
      }
      // 保险：**卡片举起来之后排进来的话，一句 `say` 都不能出去**（页面见到 say 就把卡收掉）。
      // 正常路径到不了这里——`case 'touch'`、`fidget()`、`autoChatReady()` 都挡过了。
      // 注意比的是**时间戳**：卡片之前就排好的那条（比如触发它的那次"蹭"的回话）本来就该先说，
      // 不能把它也算成"漏闸"丢掉——实测就因为没比时间戳，白白吞掉了一句回话。
      // 真到了这里就说明有新的话头漏了闸：把这句丢掉并留一行日志，不然现象是"卡片闪一下没了"，
      // 极难查（实测丢过一次，用户以为"从来没触发过"）。
      const cardAt = r.cardUp?.() || 0;
      if (cardAt && it.at > cardAt) {
        log.warn(`有选择卡举着，「${label(it)}」先不说（说了会把卡收掉）`);
        continue;
      }
      if (!beats || !beats.length) continue;
      // 台词里的占位符换成真值（**语音也念替换后的**，所以这里是唯一一处替换点）
      const vars = r.vars?.();
      const out = beats.map((b) => fill(b, vars));
      // **气泡先出去，语音在后台合成**（不再等它）。
      //
      // 以前是"先 await 语音、再 say"，于是气泡要等合成完才出现 —— fanchen-c 这种
      // RTF>1 的模型一句要 2~8 秒，那几秒里屏幕上什么都没有，主观上就是卡住。
      // 现在 text 立刻发，voice 到了再发一条；页面那边（pet-app.js 的 sayAudio）
      // 已经改成"文字和语音并行"，音频来早了存着、来晚了立刻播，都不会挡打字。
      //
      // 标记仍然**如实**：只有真要念、而且引擎开着，气泡才标 `voice:true`。
      const spoken = it.voice && speaker && speaker.on
        ? out.map((b) => String(b.text || '').trim()).filter(Boolean).join(' ')
        : '';
      if (spoken) {
        // 故意不 await：合成在后台跑，好了自己会把 `voice` 发出去
        speaker.say(spoken).catch((err) => log.warn(`语音合成出错（这句不念）:${err.message}`));
      }
      say(ws, out, it.kind, !!spoken, it.tag);
      // 页面 20 字/秒打出来，每个气泡再停一会儿；说得越长，下一条排得越后
      const chars = out.reduce((n, b) => n + String(b.text || '').length, 0);
      r.now = Date.now() + sayGapMs() + (chars / typeCps()) * 1000;
      if (r.pend.length) r.timer = setTimeout(next, r.now - Date.now() + 10);
      return;
    }
  }
  return {
    /**
     * 排一句已经挑好的话。`kind` = `react`（对刚才那一下操作的回话，会过期）
     * 或 `line`（问候/发呆/模型回答，跟时刻无关，不会过期）。
     * `opts.voice` = 这句话要不要念出来（只有大模型的回答会传）。
     */
    reply: (kind, tag, beats, opts) => push(Object.assign(mk(tag, beats), { kind, voice: !!opts?.voice }), false),
    /** 连点/连续抓放合并那一套：台词等窗口过了才按总次数挑，所以一定会过期（也不念）。 */
    touch: (tag, touch, pick) => batchTouch(Object.assign(mk(tag, null), { kind: 'react', pick, touch })),
    /**
     * 举一张选择卡（它主动问你）。跟 `reply` 一样排队、一样等前面的话说完，
     * 只是发出去的是 `ask` 而不是 `say`——页面收到就画一张带选项的卡（点一下或按数字键）。
     * 标成 `line`（不是 `react`）：卡被回答了才算完，别因为等久了两秒半就被当成过期的回话丢掉。
     */
    ask: (card) => push(Object.assign(mk('ask', null), { kind: 'line', ask: card }), false),
    close: () => {
      r.closed = true;
      clearTimer();
    },
  };
}
/** 只有触发类反应会攒在一起（同一窗口里的同类操作合成一句）。 */
const isBatch = (it) => !!it.pick;
/** 日志里怎么称呼一条排队的话：还没挑台词的那批先叫它的操作名。 */
const label = (it) => (it.beats?.length ? it.beats.map((b) => b.text).join(' / ') : it.tag);

/* ---------- 说话的声音（本机合成，只有大模型的回答会念） ---------- */

/**
 * 让大肥鱼**念**大模型的回答。
 *
 * 只有两种气泡会出声：`answer`（你打字问它的回答）和 `auto`（它自己找的话）。
 * 内置台词（戳、拖、睡觉…）不出声——那些本来就是音效，而且条数多、真念起来很吵。
 *
 * **说完再打字**：页面收到气泡时只有文字，语音后到（一条 `voice`）；它先把这一句念完，
 * 再开始打这条气泡的字。所以「说话」和「打字」是对上的，也不需要一个一个去配对 id。
 * 合成失败或没装语音时页面会收到一条**没有音频**的 `voice`，于是立刻打字（不会卡住）。
 */
function createSpeaker(ws, { onVoice = null } = {}) {
  /** 每连接一个：这一句念过没有。 */
  const s = { on: false, sent: new Set() };

  /**
   * 排一句话去合成；好了就发 `voice`。
   *
   * 从"先语音后气泡"改成**并行**之后，这个函数不再有人 await 它的返回值了
   * （调用方 fire-and-forget，见 nextStep）。所以自己要把两种失败吃掉：
   * 连接已经关了就别再 send；合成失败就安静地算了——文字那边早就出去了。
   */
  s.say = async (text) => {
    const clean = String(text || '').trim();
    if (!s.on || !clean) return false;
    if (s.sent.has(clean)) return false;                    // 这一句这次已经念过了
    s.sent.add(clean);
    const chars = [...clean].length;

    /**
     * ★ 2026-11-02：**用哪个嗓子念**（「音色」窗口那个选择）。
     *
     * 实测本机 sherpa 一句要 **5~6 秒**（`念:…（合成 5279ms）`），而火山 1.0 只要 1~2 秒，
     * 而且就是 QQ 里那个声音。默认走火山；没配 Key / 合成失败 → **自动退回本机音色**，
     * 不会因为她没网就哑了。
     */
    const kit = llm.load().deskVoiceKit === 'local' ? 'local' : 'cloud';
    let audio = '';
    let durationMs = 0;
    let how = '';
    if (kit === 'cloud') {
      try {
        const r = await companion.voice.preview({ text: clean });
        if (r && r.ok && r.audio) {
          audio = r.audio;
          // mp3 没法从字节数算时长：按中文语速估（约 4 字/秒），宁长勿短（麦克风要多捂一会儿）
          durationMs = Math.max(900, Math.round(chars * 250));
          how = `火山 ${r.ms || 0}ms`;
        }
      } catch (err) {
        log.warn(`语音（火山）没合成，改用本机音色：${err.message}`);
      }
    }
    if (!audio) {
      let r = null;
      try { r = await tts.speak(clean); } catch (err) { log.warn(`语音合成出错（这句不念）:${err.message}`); }
      if (!r) { s.sent.delete(clean); return false; }
      audio = r.wav.toString('base64');
      durationMs = Math.round((r.wav.length / 44100) * 1000);   // 22050Hz / 16bit / 单声道
      how = r.ms ? `本机 ${r.ms}ms` : '本机（缓存）';
    }

    try {
      // 页面用 `decodeAudioData` 解，wav / mp3 都认（`mime` 只是留个说明）
      send(ws, { t: 'voice', rate: kit === 'cloud' ? 24000 : 22050, wav: audio, mime: kit === 'cloud' ? 'audio/mpeg' : 'audio/wav' });
      /**
       * ★ 2026-11-02：**她出声的时候先把自己的耳朵捂上**。
       *
       * 麦克风和扬声器在同一台机器上，她的声音会被录回去 → 转写 → 她又回一句，
       * 几轮就变成自己跟自己聊天。`echoCancellation` 只能减弱、不保证消干净，
       * 所以按这卷音频的时长把她那一段硬屏蔽掉（`MicAsr.muteFor`）。
       */
      try { onVoice?.(durationMs); } catch { /* 捂耳朵失败也不能影响念 */ }
    } catch (err) {
      return false;                                          // 连接没了，别往下走
    }
    log.info(`念:${clean}（${how} · 约 ${(durationMs / 1000).toFixed(1)}s）`);
    return true;
  };
  /** 时间到，清掉这一轮的记录，下次同一个回答还会念。 */
  s.flush = () => { s.sent.clear(); };
  return s;
}

/* ---------- 接大模型的那条路 ---------- */

/** 从回复里猜一个表情。够用就好——这不是情感分析。 */
function moodOf(text) {
  if (/[?？]|吗[?？]?$|呢[?？]?$/.test(text)) return 'thinking';
  if (/[!！]|太好|厉害|真棒|哈哈/.test(text)) return 'happy';
  if (/抱歉|对不起|不能|不行|不知道|没法/.test(text)) return 'shy';
  if (/累|困|睡|歇/.test(text)) return 'sleepy';
  return 'nod';
}

/**
 * 把模型的一段回复切成最多 3 个气泡，第一个气泡按语气配个表情。
 * 一句一个气泡读起来像在说话；一整段堆在一个气泡里像在念稿。
 *
 * 只有第一段带表情：页面对一个气泡里的多个 beat 是**连着**放完的，不给中间留间隔。
 */
function beatsFor(answer) {
  const clean = String(answer).replace(/\s+/g, ' ').trim().slice(0, 300);
  if (!clean) return null;
  const parts = clean.split(/(?<=[。！？!?…；;])/).map((s) => s.trim()).filter(Boolean);
  let chunks = parts.length ? parts : [clean];
  if (chunks.length > 3) chunks = [chunks[0], chunks[1], chunks.slice(2).join('')];
  return chunks.map((text, i) => (i === 0 ? { text, actions: [moodOf(text)] } : { text }));
}

/**
 * 陪伴模式已经替我们把回复分好条了（`companion-humanize.cjs` 的 `split`）。
 * 这里只给第一条配一个表情，其余照原样当 beat —— 页面会一条条打出来，
 * 比把整段塞进一个气泡更像在说话。
 *
 * 注意**条数上限 3**：桌宠页面一个气泡里最多放三个 beat，多了会挤。
 */
function beatsForParts(parts) {
  const list = (parts || []).map((s) => String(s || '').trim()).filter(Boolean);
  if (!list.length) return null;
  // 最多三个 beat：多出来的并进第三个，不丢内容
  const chunks = list.length <= 3 ? list : [list[0], list[1], list.slice(2).join(' ')];
  return chunks.map((text, i) => (i === 0 ? { text, actions: [moodOf(text)] } : { text }));
}

/**
 * 没接模型时（或者模型没调通时）的回话：回显一遍再挑一句内置台词。
 * 只为让"打字 → 它说话"这条路看得见。
 *
 * **听出情绪时先说情绪那句**（`lines.emotion`，`state.tone` 由 `noteTone` 填好）：
 * 这样"没接模型"也不会对一句"今天累死了"回一句无关的客套话。
 */
function replyText(state, text) {
  log.info(`收到一句话(内置台词):${text}`);
  return [
    { text: `「${text.slice(0, 40)}」`, actions: [] },
    ...toneBeats(state),
    next(lines.reply),
  ].filter(Boolean);
}

/** 刚才那句话听出来的情绪，对应的一两条台词（没有就返回空数组）。 */
function toneBeats(state) {
  const list = state && state.tone ? lines.emotion?.[state.tone] : null;
  return list && list.length ? [next(list)] : [];
}

/**
 * 问大模型。一问一答，不并发：上一句还在想的时候，新的那句只留最后一条，回完再接。
 * 任何失败都退回内置台词，桌宠不会因为网络问题变成哑巴。
 *
 * 等太久的模型回复由应答链丢掉（`line` 不会过期，所以不会误伤；真正过期的是触发类回话）：
 * 万一模型那边冷启动特别慢，页面只是安静地等，不会冒出几秒前那次点击的回话。
 */
/**
 * 自动说话：跟模型要一句，**太像就再要一次**（3B 实测会一直聊同一个话题），
 * 实在没新话就这一次不说，也不重复。
 *
 * 走 `ask()` 那条路（共享"同一时刻只问一句"和冷却），只是不记进对话历史、
 * 失败也不回"我接不上话了"——它不是用户问的。
 */
/**
 * 自动说话：跟模型要一句，**太像就再要一次**（3B 实测会一直聊同一个话题），
 * 实在没新话就这一次不说，也不重复。
 *
 * 走 `ask()` 那条路（共享"同一时刻只问一句"和冷却），只是不记进对话历史、
 * 失败也不回"我接不上话了"——它不是用户问的。
 *
 * ★ 2026-11-01：**这里必须接 `.catch`**。`ask()` 里的 try 只包住模型调用那一段，
 * `send()` / `llm.load()` 这类在它外面；一旦抛出去就成了 unhandledRejection，
 * 被 `main.cjs` 记成 `FATAL`（日志误导成"进程要挂了"，而且那句回复静默丢掉）。
 */
async function autoSpeak(ws, state, reactor) {
  try {
    await ask(ws, state, reactor, AUTO_CHAT_PROMPT, {
    unsolicited: true,
    temperature: AUTO_CHAT_TEMPERATURE,
    log: '自动说话',
    /** 这一句要不要说：把提示词念出来、或者跟最近说过的几句太像，就否掉让它换一句。 */
    keep: (text) => {
      // 被否掉的句子**也要记住**（`tried`），不然下一轮同一个复读模型又会把它端上来：
      // 上一轮"重说两次都被否 → 这次不说"，下一次 tick 又是同一句，`said` 里没有它，
      // 于是照样说出来——用户看到的就是"说好的防重复呢"。实测（自检里的 repeat-model）
      // 就是这么冒出第二个气泡的。
      if (tooSimilar(text, state.said) || tooSimilar(text, state.tried)) {
        log.info('自动说话：这一句不要（念了提示词，或者跟上一次太像）');
        state.tried.push(text);
        state.tried = state.tried.slice(-AUTO_CHAT_MEMORY);
        return false;
      }
      state.said.push(text);
      state.said = state.said.slice(-AUTO_CHAT_MEMORY);
      state.tried = [];              // 说出一句新的了，之前那些"没说的"就不用再挡了
      return true;
    },
  });
  } catch (err) {
    log.warn(`自动说话失败（${err.message}）`);
  }
}

/**
 * ★ 2026-11-02：**桌宠里她回话要不要念出来**。
 *
 * 配置在 `settings.json` 的 `deskVoice`（「音色」窗口最上面那个开关，默认开）。
 * 抽成函数是为了自检能直接验"默认开 / 只有明确关才关"，不用真去开语音引擎。
 * 真正的总闸仍是右键菜单「声音」（页面那边的 `sayVoice`）+ 本机语音文件在不在。
 */
function deskVoiceOn(cfg = llm.load()) {
  return cfg.deskVoice !== false;
}

/**
 * 问大模型。一问一答，不并发：上一句还在想的时候，新的那句只留最后一条，回完再接。
 * 任何失败都退回内置台词，桌宠不会因为网络问题变成哑巴。
 *
 * `unsolicited: true` 是"自动说话"那条路：不记进对话历史（不搅乱上下文）、上一句还没回来
 * 就直接跳过、失败也安静地算了；`keep` 可以否掉一句（太像上一句就重问）。
 *
 * 等太久的模型回复由应答链丢掉（`line` 不会过期，所以不会误伤；真正过期的是触发类回话）：
 * 万一模型那边冷启动特别慢，页面只是安静地等，不会冒出几秒前那次点击的回话。
 */
async function ask(ws, state, reactor, text, opts = {}) {
  const { unsolicited = false, temperature = 0, keep, log: label = '问模型', voiceHint = '' } = opts;
  const attempts = unsolicited ? AUTO_CHAT_RETRY + 1 : 1;
  /**
   * ★ 陪伴模式：开着就走 `companion.chat`（同一张角色卡、同一本人物账、同一套拟人化分条），
   * 关着才走原来的 `llm.chat`。两条路**不会同时**问模型，所以不会出现"两个声音"。
   */
  const comp = companion.isActive();
  if (!comp && !llm.isOn()) {
    if (unsolicited) return;                 // 自动说话只走模型，没接模型就算了（内置台词够多了）
    reactor.reply('line', 'reply', replyText(state, text));
    return;
  }
  if (state.asking) {
    if (unsolicited) return;                 // 上一句还没回来，这一次自动说话就跳过
    state.pending = text;                    // 只留最新的那一句，攒着的一起扔掉
    state.pendingAt = Date.now();
    log.info('上一句还在想，这句先记下（更早的那句就不问了）');
    return;
  }

  state.asking = true;
  const cfg = llm.load();
  try {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      send(ws, { t: 'thinking', on: true });
      log.info(`${label}:${attempt ? AUTO_CHAT_AGAIN : text}`);
      let answerText = '';
      let answerParts = null;
      try {
        if (comp) {
          // 情绪提示并进"此刻"：陪伴模式不额外冒一条本地情绪台词，让角色卡自己接住
          // 时间/日期请求由 CompanionBrain 统一拼（它也会处理 QQ 那条路），这里不重复。
          // ★ 2026-11-02：`voiceHint` 是"他这句话是语音说的 + 听起来什么语气"，只跟这一轮。
          const situation = [contextLine(state), unsolicited ? '' : state.toneHint || '', voiceHint]
            .filter(Boolean).join('，');
          const r = await companion.chat({
            text: attempt ? AUTO_CHAT_AGAIN : text,
            userName: cfg.user && cfg.user !== '你' ? cfg.user : '你',
            situation,
            unsolicited,
          });
          answerText = r.text;
          answerParts = r.parts;
        } else {
          // ★ 2026-10-27：0 挡也能回忆——人物账 + 按这句话检索到的长期记忆，拼进 system。
          // 关掉 `companion.memory.enabled` 就返回空串，行为跟以前一样。
          // 用户说「记住：……」时也在这里落一条（1/2 挡由 companion.chat 负责）。
          if (!unsolicited) {
            companion.rememberFromText({
              text,
              userName: cfg.user && cfg.user !== '你' ? cfg.user : '你',
              where: 'deskpet',
            });
          }
          const memoryText = companion.recallForDeskpet({
            text: unsolicited ? contextLine(state) : text,
            history: state.history,
            userName: cfg.user && cfg.user !== '你' ? cfg.user : '你',
          });
          // ★ 2026-11-01：0 挡不经过 CompanionBrain，时间在这儿自己补
          // （陪伴模式那条路由 `brain.reply()` 统一拼，见 clock.nowLine 的注释）。
          // 这里不用 `nowLine()` 的【现在】前缀 —— `llm.chat` 会把它并进 `【此刻】`，
          // 变成"【此刻】【现在】…"两层括号。
          const context = [
            `现在是 ${clock.fullText()}`,
            contextLine(state),
            clock.requestContext(unsolicited ? contextLine(state) : text),
          ].filter(Boolean).join('，');
          answerText = await llm.chat(unsolicited ? [] : state.history, attempt ? AUTO_CHAT_AGAIN : text, temperature,
            unsolicited ? '（自动说话）' : '', context,
            [unsolicited ? '' : state.toneHint || '', voiceHint].filter(Boolean).join('，'), memoryText);
        }
      } catch (err) {
        send(ws, { t: 'thinking', on: false });
        // 具体原因进日志（托盘「打开日志」或设置页的「测试连接」能看到细节）
        log.warn(`${comp ? '陪伴模式' : '模型'}调用失败（${cfg.model} @ ${cfg.baseUrl}）:${err.message}`);
        if (!unsolicited) {
          // 陪伴模式失败时也给一句人话，别让她突然哑掉
          reactor.reply('line', 'answer', [next(lines.llmFailed)]);
        }
        return;
      }
      send(ws, { t: 'thinking', on: false });
      if (unsolicited) {
        if (keep && !keep(answerText)) continue;    // 太像上一句：带着"换个话题"再问一次
      } else {
        state.history.push({ role: 'user', content: text }, { role: 'assistant', content: answerText });
        state.history = state.history.slice(-HISTORY_TURNS * 2);
      }
      let beats = comp ? beatsForParts(answerParts) : beatsFor(answerText);
      // 原模型那条路保留"先接情绪"的本地台词；陪伴模式已经把情绪写进角色卡，不再叠一层。
      if (!comp && !unsolicited && state.tone) beats = [...toneBeats(state), ...(beats || [])];
      /**
       * ★ 2026-11-02：**桌宠里她回话要不要念出来，由「音色」窗口那一格 `deskVoice` 决定**。
       *
       * 以前这里写的是 `comp ? companion.prefs().bubbleVoice !== false : true`：
       * `bubbleVoice` 是 **QQ 那边**的开关（用户为了"别两套声音同时响"早就关了），
       * 于是桌宠这边也一起哑了 —— 实测语音对话里 `{t:'say', voice:false}`，她只打字。
       * 现在两者分开：QQ 气泡归 QQ，桌宠归桌宠（默认开）。
       */
      const speak = deskVoiceOn();
      if (beats && beats.length) reactor.reply('line', unsolicited ? 'auto' : 'answer', beats, { voice: speak });
      return;
    }
    // 换了几句还是那点内容：这一次就不说，免得你看到的还是同一句
    log.info('自动说话：实在没新话，这次就不说了');
  } finally {
    state.asking = false;
    const queued = state.pending;
    const queuedAt = state.pendingAt;
    state.pending = null;
    state.pendingAt = 0;
    if (!queued) return;
    // 攒太久的就不问了：答案出来时你已经换话题，硬答反而像答非所问
    if (Date.now() - queuedAt > PENDING_TTL_MS) {
      log.info(`「${queued}」等太久（${Date.now() - queuedAt}ms），不问了`);
      return;
    }
    if (!reactor.closed) ask(ws, state, reactor, queued).catch((err) => log.warn(`补问那句失败（${err.message}）`));
  }
}

/* ---------- 一次连接 ---------- */

/**
 * 这一下触摸该配哪句台词。`m` 是页面报上来的 touch 事件，`m.at` 是落点部位（见 AREAS）。
 *
 * **部位怎么和连击配合**（这条是刻意的，不是随手写的）：
 *   · 在**同一个部位**连着戳 → 照旧升档（第一次 / 又戳 / 够啦够啦）；
 *   · **换一个部位**戳 → 算"新的一下"，出那个部位自己的话（摸头 vs 戳肚子 vs 拽尾巴）。
 * 于是"部位感知"一眼就能试出来：戳头、再戳肚子，它会换着地方答话。
 * 五下以上不分部位，一律「够啦够啦」——那是"你别再戳了"的兜底。
 */
function reactionFor(state, m) {
  const area = areaOf(m);
  switch (m.kind) {
    case 'grab': {
      // `stage:'long'` = "拎了一会儿还没放下"（页面在 frame 里报的），按抓到的部位吭一声
      if (m.stage === 'long') return next(areaLines(lines.holdArea, lines.grabFallback, area) || lines.holdArea?.all || lines.grab);
      // 抓哪儿就从哪儿拎起来：抓脚是倒吊、抓手是斜拉……台词按抓到的部位分
      return next(areaLines(lines.grabArea, lines.grabFallback, area) || lines.grab);
    }
    case 'pet': {
      // 触点报上来的 asleep 是权威的：睡着时蹭它，它不会醒，只会做梦
      if (m.asleep) return next(lines.petAsleep);
      // **抚摸的三段**（页面侧判的"往复"手势，见 pet-app.js 的 STROKE 那段）：
      //   start 刚摸上 · good 摸舒服了 · over 够了
      // 每段先按部位挑、再按 `pettingFallback` 落到同族，最后退回该段的 `all`、再退回通用的「蹭」。
      const stage = m.stage && lines.petting?.[m.stage];
      if (stage) return next(areaLines(stage, lines.pettingFallback, area) || stage.all || lines.pet);
      // 老页面、或者上游 pet-core 自己发的那种（没有 stage）：还是按部位的通用"蹭"
      return next(areaLines(lines.petArea, lines.petAreaFallback, area) || lines.pet);
    }
    case 'drop':
      // 放下也说抓到的那个部位的话（页面在 drop 上带了 `at`）
      return next(areaLines(lines.dropArea, lines.grabFallback, area) || lines.drop);
    case 'throw':
      return next(lines.throw);
    case 'crash':
      return next(lines.crash);
    case 'poke': {
      // 刚从睡里被戳醒：半夜那几句更迷糊（`pokeAsleepNight`）
      if (m.woke) return next(partOfDay() === 'night' ? lines.pokeAsleepNight : lines.pokeAsleep);
      const now = Date.now();
      const same = !!area && area === state.pokeSpot;  // 还在戳同一个地方才算"连戳"
      state.pokes = now - state.lastPokeAt < POKE_COMBO_MS ? state.pokes + 1 : 1;
      state.lastPokeAt = now;
      state.pokeSpot = area;
      if (state.pokes >= 5) return next(lines.poke.tooMuch);
      // 只有"**同一个部位**在 2.5 秒内又被戳"才算连戳升档。
      // 隔久了是新的一下——**即使还是同一个地方**，也该说这个地方的话，而不是笼统的「第一次戳」。
      // （实测出来的：用户戳头、隔三秒再戳头，原来会得到「唔……戳我干嘛。」这种通用话，很出戏。）
      if (state.pokes >= 2 && same) return next(lines.poke.again);
      if (area && lines.pokeArea[area]) return next(lines.pokeArea[area]);
      return state.pokes >= 2 ? next(lines.poke.again) : next(lines.poke.first);
    }
    default:
      return null;
  }
}

function attach(ws) {
  const cs = companion.publicState();
  log.info(`桌宠页面已连接${cs.enabled ? ` · 陪伴模式（${cs.adapter === 'kit-jsonl' ? '只读外部 kit' : 'QQ 内置'}）` : llm.isOn() ? ` · 接的是 ${llm.load().model}` : ' · 用内置台词（没接模型）'}`);

  // 一条连接的全部状态。`sleeping` 是"我们认为它睡了"，权威标志还是页面上报的 asleep/woke。
  const state = {
    lastUserAt: Date.now(), lastPokeAt: 0, pokes: 0,
    sleeping: false, walking: false, paused: false,
    asking: false, pending: null, pendingAt: 0, history: [], said: [], tried: [],
    autoChat: llm.load().autoChat === true,
    // 部位感知：上一次戳的是哪儿（换个地方就重新按那个部位反应）
    pokeSpot: '',
    // 它会问你：`pets` 是攒起来的"蹭"次数，`card` 是当前举着的那张选择卡，
    // `quietUntil` 是你选了「我在忙」之后它闭嘴的截止时刻（只挡它自己找话，不挡它回你的话）
    pets: 0, card: null, lastAskAt: 0, quietUntil: 0,
    // 它知道你在不在忙：`away` = 系统空闲超过 AWAY_SEC（你在别处忙 / 人不在）
    away: false, battAt: 0,
    // 刚发生在它身上的事（给模型上下文用，比如"你刚被摸了头"）
    lastEvent: '',
    // 心情：`moodState`/`moodSpeed`/`moodCling` 是最新快照，`moodSent` 是"页面上现在显示的那一档"
    moodState: '', moodSpeed: 1, moodCling: 170, moodSent: '',
    // 本地情绪识别：`tone` 是刚听出来的情绪（tired/sad/…），`toneHint` 是给模型的一句提示
    tone: '', toneHint: '',
    // 玩具球 / 弹弹乐：三态开关 + 球最近一次被踢到时的横向位置（0..1）
    ballMode: 'off', ballX: -1,
    // ★ 天气（页面自己切自己判，这里只记着它，见 `INIT.weather` 的注释）
    weather: 'off',
    // ★ 天气环境音的开关（页面自己判自己响，这里只记着它，见 `INIT.weatherSound`）
    weatherSound: true,
  };
  let idle = null, auto = null, moodTimer = null, micro = null;

  /**
   * ★ 2026-11-02：**她的耳朵**（右键菜单左上角那个麦克风）。
   *
   * 数据流（全部在进程内，不经过网络）：
   *   `web/mic-worklet.js` → 16k 单声道 int16 PCM（64ms 一帧，二进制 WS）→ `MicAsr.push()`
   *   → 静音 ≥700ms 判定一句说完 → 方舟转写 → 当成"你打的字"喂给同一个 `ask()`。
   *
   * 为什么在**主进程**切句：`doubao-seed-2-1-lite` 不是流式模型（用户 2026-11-02 的原话），
   * 一次只吃一整段音频；页面只负责采集，判断"说完了没有"放在这里，
   * 自检就能直接喂 PCM 验（不用开麦克风）。
   */
  let micAsr = null;
  const ears = { on: false, busy: 0 };

  const voicePrefs = (patch = {}) => send(ws, {
    t: 'prefs',
    /**
     * ★ `mic` 必须回给页面：`toggleVoice()` 只发 `{t:'prefs', mic}` 给这里，
     * 页面自己的 `prefs.mic` 是靠**这条回执**才变成 true 的（`applyPrefs` 见到 mic 才会
     * `startMic()`）。不回执的话按钮变绿了、麦克风却从来没开过。
     */
    mic: ears.on,
    voice: { enabled: ears.on, ready: true, mode: 'always', hint: '直接说话，说完一句我就听懂了', ...patch },
  });

  /** 一段语音转写出来了 → 当他说了一句话。 */
  async function hearSegment(pcm, info) {
    if (!ears.on) return;
    const cfg = asrMod.settings();
    ears.busy += 1;
    try {
      const wav = asrMod.pcm16ToWav(pcm);
      const t = await asrMod.transcribe(cfg, {
        audio: wav.toString('base64'),
        format: 'wav',
        context: '这是桌宠麦克风当场录到的一句话，可能有环境噪声、回声，也可能没说完就被打断了',
      });
      if (!ears.on) return;
      const text = String(t.text || '').trim();
      if (t.ok && text) {
        log.info(`语音输入：听到「${text.slice(0, 60)}」（${(info.ms / 1000).toFixed(1)}s${t.tone ? ` · ${t.tone}` : ''} · ${t.ms}ms）`);
        send(ws, { t: 'listen', phase: 'heard', text });
        talkToPet(text, { fromVoice: true, voiceHint: asrMod.toneNote(t) });
      } else {
        log.info(`语音输入：这一段没听出内容（${t.error || '空'}）`);
        send(ws, { t: 'listen', phase: 'none' });
      }
    } catch (err) {
      log.warn(`语音输入：转写出错（${err.message}）`);
      send(ws, { t: 'listen', phase: 'none' });
    } finally {
      ears.busy -= 1;
    }
  }

  function openEars() {
    if (ears.on) return true;
    const cfg = asrMod.settings();
    if (!asrMod.ready(cfg)) {
      if (!cfg.enabled) {
        log.warn('语音输入：语音识别关着（config\\voice-asr.json → enabled）');
        voicePrefs({ enabled: false, ready: false, detail: '语音识别关着（config\\voice-asr.json）' });
      } else {
        log.warn('语音输入：没有可用的方舟 Key（config\\voice-asr.json → ark.apiKey）');
        voicePrefs({ enabled: false, ready: false, detail: '还没配方舟 Key（config\\voice-asr.json）' });
      }
      return false;
    }
    ears.on = true;
    micAsr = new asrMod.MicAsr({
      asr: cfg,
      onPhase: (p) => {
        if (p.phase === 'start') send(ws, { t: 'listen', phase: 'start' });
        else if (p.phase === 'segment') send(ws, { t: 'listen', phase: 'transcribing' });
        else if (p.phase === 'none') send(ws, { t: 'listen', phase: 'none' });
      },
      onSegment: (pcm, info) => { hearSegment(pcm, info).catch(() => {}); },
      onError: (err) => log.warn(`语音输入：切句出错（${err.message}）`),
    });
    log.info(`语音输入：开（${cfg.ark.model} · 阈值 ${cfg.mic.threshold} · 静音 ${cfg.mic.silenceMs}ms 断句）`);
    voicePrefs();
    return true;
  }

  function closeEars(why = '') {
    if (!ears.on && !micAsr) return;
    ears.on = false;
    try { micAsr?.cancel(); } catch { /* 已经没了 */ }
    micAsr = null;
    log.info(`语音输入：关${why ? `（${why}）` : ''}`);
    voicePrefs({ enabled: false, ready: true });
  }

  /** 念大模型回答的那条路（内置台词不出声）。 */
  const speaker = createSpeaker(ws, {
    /** `durationMs` 已经是"这句话大概要放多久"（火山按字数估、本机按 WAV 字节算），再多捂 0.7 秒收尾。 */
    onVoice: (durationMs) => micAsr?.muteFor((Number(durationMs) || 0) + 700),
  });
  speaker.on = INIT.voice === true;      // 默认：接了模型 + 语音文件齐了就开

  /**
   * ★ 2026-11-02：**"你跟她说话"只有这一个入口**（打字的、语音转写的都走这里）。
   * 原来这段写在 `case 'text'` 里；语音也复制一份的话，早晚两边不一样。
   */
  function talkToPet(text, { fromVoice = false, voiceHint = '' } = {}) {
    const clean = String(text || '').trim();
    if (!clean) return;
    state.lastUserAt = Date.now();
    state.pokes = 0;
    memory.addTalk(clean);                // 记忆：聊过一次，并记下这句（截短）
    mood.onEvent('talk');                 // 心情：你主动跟它说话，它也高兴
    noteTone(state, clean);               // 本地情绪识别：先听懂你这句是什么情绪
    stepMood();
    state.lastEvent = '';                 // 你在直接跟它说话，就别说"刚被戳了"了
    dropCard(fromVoice ? '你说话了' : '你去打字了');   // 那张卡就别再举着
    if (wake()) reactor.reply('react', 'wakeUp', [next(lines.wakeUp)]);
    // ★ 2026-11-01：接 `.catch`（否则意外抛错变 unhandledRejection → `main.cjs` 记 FATAL）
    ask(ws, state, reactor, clean.slice(0, 500), fromVoice ? { voiceHint } : {})
      .catch((err) => log.warn(`问模型失败（${err.message}）`));
  }
  /** 台词占位符的取值（名字每次都现读，所以设置页改完不用重启就生效）。 */
  const memoryVars = () => {
    const s = memory.snapshot();
    return {
      name: llm.load().user || '你',
      days: s.days,
      area: AREA_CN[s.areaTop] || '这里',
      words: s.words || '',
      hour: HOUR_CN(s.hourTop),
    };
  };
  /** 这条连接的气泡都从它排队出去（见文件顶部的「应答链」）。 */
  const reactor = createReactor(ws, speaker, {
    cardUp: () => (state.card ? state.card.at : 0),
    vars: memoryVars,
  });

  // 换身体。只发这一条，大肥鱼就会出现在桌面上。
  send(ws, INIT);
  state.ballMode = INIT.ballMode;
  state.weather = INIT.weather;
  state.weatherSound = INIT.weatherSound;
  /** ★ 2026-11-01：声音总闸也记着（页面报上来时存盘，见 `case 'prefs'`）。 */
  state.sound = INIT.sound;

  /* ---------- 陪伴模式：QQ 事件 → 手机面板 + 短气泡 ---------- */
  /**
   * 这里只做"显示"，不做"回复"：QQ 的回复由 `companion.cjs` 自己发出去，
   * 桌宠只是把同一批事件镜像到页面上。所以关掉桌宠，QQ 那边照样工作；
   * 关掉陪伴模式，手机面板立刻收起。
   *
   * 气泡只冒**第一句**（`beatsForParts` 会保留分条），全文在手机面板里。
   * 暂停 / 睡着 / 有选择卡 / 你自己说了「我在忙」时，只更新面板、不冒泡。
   */
  const onCompanionEvent = (ev) => {
    send(ws, { t: 'companion', event: ev });
    // 有人找她：转头看一眼手机（不出声）
    if (ev.type === 'inbound' && (ev.atMe || !ev.isGroup || ev.poke)) {
      send(ws, { t: 'act', actions: ['look'] });
    }
    if (ev.type !== 'outbound') return;
    /**
     * ★ 2026-11-07：**桌宠这条路的手机回灌**（`key === 'deskpet'`）。
     * 它不走 QQ 的 `bubbleReplies`（那个开关是给 QQ 镜像用的），也不看 `bubbleVoice`
     * （那是 QQ 里别两套声音同时响）；桌宠自己念不念由「音色」窗口的 `deskVoice` 决定。
     */
    const isDesk = ev.key === 'deskpet';
    if (!isDesk && !companion.prefs().bubbleReplies) return;
    if (state.paused || state.sleeping || state.card) return;
    if (Date.now() < state.quietUntil) return;
    const parts = Array.isArray(ev.parts) && ev.parts.length ? ev.parts : [ev.text];
    const beats = beatsForParts(parts);
    // 本地语音带不动时可以只冒气泡：开关在 config/companion.json 的 bubbleVoice（设置页也有）
    // ★ 2026-11-01：用 `prefs()`（便宜版）。这里一条 outbound 要问两次，
    // 而 `publicState()` 每次要读 1200 行流水 + stat 160 个记忆文件（实测 35.9ms）。
    const cs = companion.prefs();
    // ★ 2026-11-01：这条在 QQ 里已经用云端声音发过了，桌宠气泡就不要再拿本地嗓子念一遍
    // （两套声音不一样，同时响会像两个人）。没发语音时照旧按 bubbleVoice。
    if (beats) {
      reactor.reply('line', 'companion', beats, {
        voice: isDesk ? deskVoiceOn() : (cs.bubbleVoice !== false && !ev.voice),
      });
    }
  };
  const onCompanionState = (st) => send(ws, { t: 'prefs', companion: st });
  companion.on('event', onCompanionEvent);
  companion.on('state', onCompanionState);
  /**
   * ★ 2026-10-30：她在手机上的动作（start / step / shot / done / fail）。
   * 页面暂时只用它更新状态（不画进度条）；以后要做"实时画面"也从这一条走，不另开通道。
   */
  const onPhoneEvent = (ev) => {
    send(ws, { t: 'phone', ev });
    const canSay = !state.paused && !state.sleeping && !state.card && Date.now() >= state.quietUntil;
    /**
     * ★ 2026-10-30：冷启动模拟器要几十秒，这段时间她一句话都没有会像卡死。
     * 开机时冒一句；**亮了她要说一声**（用户要的"她知道"就在这一句里：不是程序贴图，
     * 是她自己知道手机在手上）；没开起来也要照实说，别让人对着黑屏等。
     */
    if (!canSay) return;
    if (ev.kind === 'boot') {
      reactor.reply('line', 'companion', [{ text: '我把手机开一下……', actions: ['nod'] }]);
      return;
    }
    if (ev.kind === 'stage' && ev.stage === 'ready') {
      send(ws, { t: 'act', actions: ['look'] });
      reactor.reply('line', 'companion', [{ text: '手机亮了。', actions: ['nod'] }]);
      return;
    }
    if (ev.kind === 'stage' && ev.stage === 'fail') {
      log.warn(`手机：没开起来（${ev.why || '不知道原因'}）`);
      reactor.reply('line', 'companion', [{ text: '手机没开起来……等下再试试。', actions: ['dizzy'] }]);
    }
  };
  const offPhone = companion.phone.on(onPhoneEvent);
  // 页面连上来时补一次**当前**状态：`INIT` 是进程启动时算的，那时候 OneBot 可能还没连上
  send(ws, { t: 'prefs', companion: companion.publicState() });
  // 重连时补上最近几条，不然手机会是空的
  const companionSnap = companion.recent(20);
  if (companionSnap.length) send(ws, { t: 'companion-log', events: companionSnap });
  ws.on('close', () => {
    companion.off('event', onCompanionEvent);
    companion.off('state', onCompanionState);
    offPhone();
  });

  /**
   * ★ **换装窗口里点一下，立刻换她身上的衣服**（2026-10-10 用户实测："切换后模型服装没有跟着切换"）。
   *
   * 真因：`SKIN` 只在**启动时**读一次，换装窗口点一下只改了 `data\dress.json` → 页面收不到，
   * 不重启永远不变。现在 `dress.wear()` 成功后触发订阅，这里给页面发一条 `{t:'prefs', skin}`；
   * 页面 `applyPrefs` 里本来就有 `if (p.skin) { ctl.setSkin(s); applyFigure(s) }` → 立刻换。
   *
   * 注意订阅**注册在连接处理器里**（`ws` 是这条连接的局部变量）；连接断开时取消，免得重连后累积。
   */
  const onDressChange = () => {
    const skin = dress.skinOverride() || { figure: 'whale', scheme: 'deepseek' };
    send(ws, { t: 'prefs', skin });
    log.info(`换装：已通知页面换成 ${skin.scheme}`);
  };
  dress.onChange(onDressChange);
  ws.on('close', () => dress.offChange(onDressChange));

  /**
   * ★ **调试用的动作入口**（2026-10-10，用户问"有没有预留调试接口"）。
   *
   * 往 `data\dev-act.txt` 里写一个动作名（`sit` / `sleep` / `dizzy` / `stand` / `hop` / `spin` …，
   * 就是 `pet-app.js` 顶部 `DUR` 表里的那套），文件内容一变就把这个动作下发给她 ——
   * 这样"我从外面驱动她摆姿势"（截图/测试）不用来回点界面。
   * ★ 2026-10-10：右键菜单里那四个测试按钮（站好/坐下/睡觉/晕倒）已按用户要求删掉，
   *   **这个文件入口现在是唯一的摆姿势办法**（将来要截图/验姿势，写这个文件就行）。
   */
  const devActFile = path.join(path.dirname(log.file), 'dev-act.txt');
  const fsDev = require('node:fs');          // 这个文件里没引 fs，就地引一下（别为调试口去动别处）
  let devActLast = '';
  /**
   * ★ 2026-11-01：**只在 `DSP_DEBUG` 下开，而且 1 秒 → 3 秒**。
   * 原来每个页面连接一个 `setInterval(1000)` 同步 `readFileSync`（桌宠窗口常开 = 一天 ~86k 次
   * 同步磁盘读，笔记本上硬盘灯一直闪）。这个入口本来就是"我手动摆姿势"用的，
   * 不是产品功能；真要用就 `set DSP_DEBUG=1` 再开桌宠。
   */
  const DEV_ACT_MS = Number(process.env.DSP_DEBUG ? 3000 : 0) || 0;
  const devTimer = DEV_ACT_MS > 0 ? setInterval(() => {
    try {
      const want = (fsDev.readFileSync(devActFile, 'utf8') || '').trim();
      if (want && want !== devActLast) {
        devActLast = want;
        send(ws, { t: 'act', actions: [want] });
        log.info(`调试动作：${want}`);
      }
    } catch { /* 文件不在就算了 —— 这个入口本来就是可有可无的 */ }
  }, DEV_ACT_MS) : null;
  ws.on('close', () => { if (devTimer) clearInterval(devTimer); });

  /** 认识的第 7/30/100/180/365 天（说句子用的），心情那边也要用，所以放在最前面。 */
  const MILESTONE_DAYS = new Set([7, 30, 100, 180, 365, 730]);

  /**
   * 心情变了就说一声（页面据此调步调与"黏着你"的距离）。
   * 只在**档位真的换了**的时候发，免得每 30 秒都往页面上塞一条没用的消息。
   */
  function stepMood() {
    const m = mood.snapshot();
    state.moodState = m.state;
    state.moodSpeed = m.speed;
    state.moodCling = m.cling;
    if (m.state !== state.moodSent) {
      state.moodSent = m.state;
      log.info(`心情「${m.label}」（love=${m.love} energy=${m.energy}）`);
      send(ws, { t: 'prefs', mood: m });
    }
    return m;
  }

  // 这次见面记一笔（来过几天 / 常在的时段 / 第一次见面）
  const mem = memory.touchSeen();
  // 好久没来 / 认识的里程碑：心情跟着动一下（先更新，问候语随后就按新心情挑）
  const felt = mood.mind({ awayDays: mem.awayDays, milestone: MILESTONE_DAYS.has(mem.days) });
  if (felt.before !== felt.after) log.info(`（隔了 ${mem.awayDays} 天没来）`);
  stepMood();
  const greeting = setTimeout(() => reactor.reply('line', 'hello', [next(lines.hello[partOfDay()])]), 2000);

  /**
   * 开机后的第二句：**只在值得说的日子说**——认识的第 7/30/100/180/365 天，
   * 或者隔了 3 天以上才回来。放在问候之后 2.5 秒，不跟它挤在一起。
   */
  const memoryGreeting = setTimeout(() => {
    if (state.paused || state.card) return;
    if (mem.days > 1 && MILESTONE_DAYS.has(mem.days)) {
      reactor.reply('line', 'memDay', [next(lines.memoryMilestone)]);
      memory.markSaid();
    } else if (mem.days > 1 && mem.awayDays >= 3) {
      reactor.reply('line', 'memAway', [next(lines.memoryAway)]);
      memory.markSaid();
    }
  }, 4500);

  /**
   * 「你不在」这条线：系统的空闲时长。
   *
   * 为什么不能只看 `lastUserAt`：你在别处打字、看视频、玩游戏时它一直是老的，
   * 而系统空闲时长是 0 —— 于是它会在你正忙着的时候自己找话说。反过来，你离开之后
   * 系统空闲时长一路涨，就能让它在没人时安静待着；**你回来（空闲归零）它主动招呼一句**，
   * 而不是像以前那样"要你先碰它一下它才说'你回来啦'"。
   */
  function systemIdleSec() {
    try {
      const pm = require('electron').powerMonitor;
      return (pm && pm.getSystemIdleTime && pm.getSystemIdleTime()) || 0;
    } catch { return 0; }               // 纯 Node（自检）里没有 electron：当"你一直在"处理
  }
  const awayPoll = setInterval(() => {
    const away = systemIdleSec() >= AWAY_SEC;
    if (away === state.away) return;
    state.away = away;
    mood.tick({ away });                      // 你不在的时候它想你（love 掉得快一点）
    if (away) {
      log.info(`系统 ${AWAY_SEC} 秒没动静，它安静待着`);
      return;
    }
    log.info('你回来了（系统空闲归零）');
    state.lastUserAt = Date.now();       // 别紧接着又来一句"好久不见"
    if (!state.paused && !state.card) reactor.reply('line', 'youBack', [next(lines.youBack)]);
  }, AWAY_POLL_MS);

  /**
   * 锁屏 / 睡眠 / 电池：主进程现成的 `powerMonitor` 事件。
   * **必须在这里注册、在 close 时摘掉**：`attach` 每重连一次就调一次，不然监听器会越堆越多。
   */
  const pm = (() => {
    try {
      const m = require('electron').powerMonitor;
      return m && typeof m.on === 'function' && typeof m.off === 'function' ? m : null;
    } catch { return null; }
  })();
  const onSleep = () => {
    log.info('锁屏/睡眠：它也跟着睡');
    state.sleeping = true;
    send(ws, { t: 'act', actions: ['sleep'] });
  };
  const onWake = () => {
    log.info('解锁/唤醒：它醒了');
    state.sleeping = false;
    state.lastUserAt = Date.now();
    if (!state.paused && !state.card) reactor.reply('line', 'youBack', [next(lines.youBack)]);
  };
  const onBattery = () => {
    log.info('改成电池供电');
    if (state.paused || state.card || Date.now() < state.battAt) return;
    state.battAt = Date.now() + 3600_000;      // 一小时最多念一次
    reactor.reply('line', 'battery', [next(lines.battery)]);
  };
  if (pm) {
    pm.on('lock-screen', onSleep); pm.on('suspend', onSleep);
    pm.on('unlock-screen', onWake); pm.on('resume', onWake);
    pm.on('on-battery', onBattery);
  }

  const idleDelay = () => (IDLE_MIN_MS + Math.random() * (IDLE_MAX_MS - IDLE_MIN_MS)) / moodSpeed(state);

  /** 现在"该只动不说"吗：你选了「我在忙」（quietUntil），**或者**你根本不在（away）。 */
  const hushed = () => Date.now() < state.quietUntil || state.away;

  /** 发呆台词：一半用"这个时段"专属的，一半用通用的（`lines.idleByTime`）。 */
  const idleLine = () => (Math.random() < .5
    ? moodPick(state, lines.idleByTime?.[partOfDay()] || lines.idle)
    : moodPick(state, lines.idle));

  /**
   * 挑一句"记忆话"：优先"你上次说过的那句"，其次"你最喜欢摸我哪儿"，再其次"你常在的时段"。
   * 取不到就返回 null（把这一轮的份额让给普通发呆）。
   */
  function memoryLine() {
    const s = memory.snapshot();
    if (s.words && s.talks >= 2) return next(lines.memoryWords);
    if (s.areaTop) return next(lines.memoryArea);
    if (s.visits >= 3) return next(lines.memoryHour);
    return null;
  }

  /* ---------- 玩具球：她自己会过去踢 ---------- */

  /** 球现在大概在哪儿（页面每次她踢到球都会报坐标；没报过就用屏幕中间）。 */
  const ballAt = () => (state.ballX >= 0 && state.ballX <= 1 ? state.ballX : 0.5);

  /**
   * 走过去踢球。
   *
   * **页面才是"脚"**：球滚到她身上时由 `web/ball.js` 判碰撞、把球踢出去，并回一条 `{t:'ballKick'}`。
   * 所以这里只负责"走到球那儿去"，真正踢那一下是页面做的 —— 好处是物理只有一份实现，
   * 而且她追球时用的是现成的走路（`{t:'walk', to}` 收的是**窗口宽度的比例**）。
   */
  function playBall() {
    if (state.ballMode !== 'ball') return false;
    state.walking = true;
    // 走到球的**另一边**一点（不站进球里），偏差按左右分
    const raw = ballAt() + (Math.random() < .5 ? .04 : -.04);
    const to = raw < 0.05 ? 0.05 : raw > 0.95 ? 0.95 : raw;
    send(ws, { t: 'walk', id: `w${++seq}`, to });
    log.info(`找球玩（球在 ${to.toFixed(2)}）`);
    return true;
  }

  /** 自己动一动，或者走去找鼠标。 */
  function fidget() {
    const quiet = Date.now() - state.lastUserAt;
    if (state.paused) return;                 // 暂停了就彻底安静
    // 有张卡在等你选：别再插话（**任何一句 `say` 都会把那张卡收掉**，见 nextStep 里那段注释）
    if (state.card) return;
    if (quiet > SLEEP_AFTER_MS) {
      if (!state.sleeping) {
        state.sleeping = true;
        log.info('太久没人理，它睡了');
        send(ws, { t: 'act', actions: ['sleep'] });
      }
      return;                                 // 睡着的时候不出声
    }
    if (quiet > DROWSY_AFTER_MS) {
      // 犯困这条也只在"你还在"的时候说：你人都走了还念叨就怪了
      if (!hushed()) reactor.reply('line', 'drowsy', [moodPick(state, lines.drowsyByTime?.[partOfDay()] || lines.drowsy)]);
      return;
    }
    const roll = Math.random();
    if (hushed()) {
      // 你选了「我在忙」，或者你根本不在（系统空闲）：不说话，但偶尔动一下，不然看着像卡住了
      if (roll < .5) send(ws, { t: 'act', actions: [FIDGET[Math.floor(Math.random() * FIDGET.length)]] });
      return;
    }
    // 偶尔说一句"只有认识你才说得出来"的话（**每天有上限**，见 memory.cjs 的 SAY_PER_DAY）
    if (roll < 0.12 && memory.canSayMemory()) {
      const line = memoryLine();
      if (line) { reactor.reply('line', 'memory', [line]); memory.markSaid(); return; }
    }
    // 有球的时候先想着球：它自己会过去踢一脚（球动了页面会报 `ballKick`）。
    // **只在自由玩球（`ball`）时这样**：游戏模式下她的走位由 `web/game.js` 管（要守门/追球），
    // 这里再插一脚会跟它抢。
    if (state.ballMode === 'ball' && !state.walking && roll < 0.30) { playBall(); return; }
    if (roll < 0.34) reactor.reply('line', 'idle', [idleLine()]);
    else if (roll < 0.5 && !state.walking) {
      // 偶尔溜达到鼠标那儿去
      state.walking = true;
      send(ws, { t: 'walk', id: `w${++seq}`, to: 'cursor' });
    } else send(ws, { t: 'act', actions: [FIDGET[Math.floor(Math.random() * FIDGET.length)]] });
  }

  const scheduleIdle = () => {
    idle = setTimeout(() => {
      fidget();
      scheduleIdle();
    }, idleDelay());
  };
  scheduleIdle();

  /**
   * 心情的心跳：每 30 秒让它往"平常"回一点、按时段改精神、你不在就往下掉。
   * 它跟发呆/自动说话是**独立**的定时器（心情该变就变，跟"这一轮说不说话"无关）。
   */
  moodTimer = setInterval(() => {
    mood.tick({ away: state.away, sleeping: state.sleeping });
    stepMood();
  }, MOOD_TICK_MS);

  /* ---------- 不说话的小动作（歪头 / 换重心 / 瞟一眼鼠标） ---------- */

  /**
   * 挑一个微动作发下去（**不带气泡**，所以不受应答链和"有没有卡举着"的影响）。
   * `pet-core` 的 `microStep()` 会把它画出来；`tilt`/`step` 的台词只在日志里露面。
   */
  function sendMicro() {
    if (state.paused || state.card) return;                 // 暂停 / 有卡举着：别乱动
    const kind = MICRO[Math.floor(Math.random() * MICRO.length)];
    if (kind === 'look') {
      // 瞟一眼光标那儿（会走动，所以只有"发呆且不在走路"的时候才发）
      if (state.sleeping || state.walking) return;
      state.walking = true;
      send(ws, { t: 'walk', id: `w${++seq}`, to: 'cursor' });
      log.info(`小动作:瞟一眼鼠标`);
      return;
    }
    send(ws, { t: 'micro', kind });
    const pool = lines.micro?.[kind];
    log.info(`小动作:${pool && pool.length ? next(pool).text.replace(/[（）]/g, '') : kind}`);
  }

  const scheduleMicro = () => {
    micro = setTimeout(() => {
      sendMicro();
      scheduleMicro();
    }, (MICRO_MIN_MS + Math.random() * (MICRO_MAX_MS - MICRO_MIN_MS)) / moodSpeed(state));
  };
  scheduleMicro();

  /* ---------- 它会问你：用页面里那套选择卡（点一下，或者按数字键 1–9） ---------- */

  /**
   * 举一张卡问一句。这是"它会主动做事"的第二条路（第一条是自动说话，那条要接模型、还花 token；
   * 这条路纯本地、不花 token）：
   *
   *   你摸它摸够 `ASK_AFTER_PETS` 下 → 它问一句 → 你选一个 → **它照着你选的做**。
   *   选到带 `quiet` 的选项（比如「我在忙」），它会安静那几分钟：不找话、不自动说话，
   *   只偶尔动一下（见 fidget），但你跟它说话它照样回——安静的是它自己起的话头。
   *
   * **为什么要排进应答链而不是直接 send**：页面收到任何一条 `say` 都会把举着的卡收掉
   * （pet-app.js 的 `case 'say': dropAsks()`）。直接 send 的话，队里那句"蹭"的回话随后就到了，
   * 卡片会一闪而过。排到队尾就正好在它后面举起来。
   */
  function askQuestion() {
    if (state.card) return false;                             // 已经举着一张了
    if (state.paused || state.sleeping) return false;
    if (Date.now() < state.quietUntil) return false;           // 你说了「我在忙」，说话算话
    if (Date.now() - state.lastAskAt < ASK_COOLDOWN_MS) return false;
    const q = next(lines.ask);
    if (!q) return false;
    // `options` 是页面上那几个按钮的文字；`opts` 是它们完整的样子（选完回哪句、要不要安静）
    const card = {
      id: `q${++seq}`, text: q.text,
      options: (q.options || []).map((o) => o.label), opts: q.options || [],
      actions: q.actions || [], timer: 0, at: Date.now(),
    };
    // 举太久没人选：把卡收掉，换一句"算了"（那条 say 顺手就替页面把卡关了）
    card.timer = setTimeout(() => {
      if (state.card !== card) return;
      state.card = null;
      log.info('问了没人应，收回来');
      reactor.reply('line', 'askNudge', [next(lines.askNudge)]);
    }, ASK_TTL_MS);
    state.card = card;
    state.lastAskAt = Date.now();
    reactor.ask(card);
    return true;
  }

  /** 卡片不用了（被回答/被顶掉/连接关了）：清干净，别让计时器再冒出一句话。 */
  function dropCard(reason) {
    if (!state.card) return null;
    const card = state.card;
    state.card = null;
    clearTimeout(card.timer);
    if (reason) log.info(`选择卡作废（${reason}）`);
    return card;
  }

  /* ---------- 自动说话：接了模型之后每隔一分钟自己找个话头 ---------- */

  /**
   * 现在能不能自己说话：开着、接了模型、没暂停、没睡着、没在想上一句、你刚没跟它说过话。
   * `dry` 只是把第一个不满足的条件说出来给人看（按一次按钮什么都没发生时，日志里能看出原因）。
   */
  function autoChatReady() {
    /**
     * ★ 2026-11-04：**这个开关的真源是 `config/settings.json` 的 `autoChat`**。
     *
     * 原来只读内存里的 `state.autoChat`（启动时读一次、之后只能靠右键那个按钮发 `prefs` 改），
     * 于是"在设置页改了它"要重启才生效。现在那个按钮从菜单搬到了设置页，
     * 那就必须让配置本身生效 —— 这一分钟一次的检查顺手读一遍配置（一次小 JSON，可忽略），
     * 改完最多一分钟就生效，不用重启。`prefs` 那条老路还留着（写回同一个配置）。
     */
    let cfgOn = state.autoChat;
    try { cfgOn = llm.load().autoChat === true; } catch { /* 读不到就按内存里的来 */ }
    if (cfgOn !== state.autoChat) {
      state.autoChat = cfgOn;
      log.info(state.autoChat ? '自动说话：开（配置里改了）' : '自动说话：关（配置里改了）');
    }
    if (!cfgOn) return 'off';
    if (state.paused) return 'paused';
    if (state.sleeping) return 'asleep';
    if (state.asking) return 'asking';
    if (state.card) return 'card';            // 有张选择卡举着，别插话
    if (state.away) return 'away';            // 你不在（系统空闲）：别自己找话说
    if (Date.now() < state.quietUntil) return 'hush';   // 你说了「我在忙」
    /**
     * ★ 2026-10-27：陪伴模式接手了"自主说话"（`companion-presence.cjs`：念头池 + 动机分），
     * 桌宠这一分钟一次的老节奏就停下来 —— 否则同一个她会同时有两条：一条发到 QQ、
     * 一条只冒桌面气泡。只有 QQ 真的连着、而且那边开着自主说话时才让位；
     * QQ 掉线 / 关了自主说话，这里照旧（桌宠自己也能陪你说两句）。
     */
    if (companion.isActive()) {
      const cs = companion.prefs();
      if (cs.presence && cs.presence.enabled !== false && cs.connected) return 'companion';
    }
    if (!llm.isOn() && !companion.isActive()) return 'no-model';
    if (Date.now() - state.lastUserAt <= AUTO_CHAT_QUIET_MS) return 'quiet';
    return '';
  }

  /**
   * 自动说话的驱动：每隔 `AUTO_CHAT_MS` 看一次该不该说（条件不满足就跳过这一次，
   * 不做排队）。它是**一直跑着**的，开关只切 `state.autoChat`，所以关掉再打开不用重排。
   */
  function scheduleAuto() {
    auto = setTimeout(() => {
      // 条件不满足就跳过这一次（日志留一行，方便看出"为什么它不自己说话"）
      const why = autoChatReady();
      if (!why) {
        // **别在进 ask() 之前把 asking 置上**：ask() 自己也看这个标志，置早了它就以为
        // "上一句还在想"，直接返回——实测就是这么把自己的话吞掉的。
        autoSpeak(ws, state, reactor).catch((err) => {
          state.asking = false;
          log.warn(`自动说话出错:${err.message}`);
        });
      } else if (why !== 'off') {
        log.info(`自动说话这次跳过（${why}）`);
      }
      scheduleAuto();
    }, AUTO_CHAT_MS);
  }
  scheduleAuto();

  /** 把它叫醒：站起来。真的从睡里被叫醒才返回 true（调用方据此决定要不要接一句）。 */
  function wake() {
    if (!state.sleeping) return false;
    state.sleeping = false;
    log.info('它醒了');
    send(ws, { t: 'act', actions: ['stand'] });
    return true;
  }

  ws.on('message', (raw, isBinary) => {
    /**
     * ★ 2026-11-02：**二进制帧 = 麦克风 PCM**（`web/mic-worklet.js` 的 int16le）。
     * 文本帧仍然是那套 JSON 协议；`ws` 对文本帧给的是字符串。
     */
    if (isBinary) {
      if (ears.on && micAsr) {
        try { micAsr.push(Buffer.isBuffer(raw) ? raw : Buffer.from(raw)); } catch (err) { log.warn(`语音输入：PCM 处理失败（${err.message}）`); }
      }
      return;
    }
    let m;
    try {
      m = JSON.parse(raw.toString());
    } catch {
      return;
    }
    switch (m.t) {
      case 'hello':
        log.info(`画面 ${m.screen?.w}x${m.screen?.h} · ${m.host === 'window' ? '桌宠窗口' : '标签页'}`);
        break;

      case 'touch': {
        const away = Date.now() - state.lastUserAt;
        state.lastUserAt = Date.now();
        // 记忆 + "刚发生了什么"：**带 stage 的里程碑不算新的一次**（不然摸一下就记三下）
        if (!m.stage || m.stage === 'start') memory.addTouch(m.kind || 'touch', areaOf(m));
        // 心情：一下互动一次（同样是"带 stage 的 milestone 不算新的一次"）
        if (!m.stage || m.stage === 'start') mood.onEvent(m.kind || 'touch');
        // "够了够了"那一段不算互动，但会让它有点烦（摸过头也是会烦的）
        if (m.kind === 'pet' && m.stage === 'over') mood.onEvent('petOver');
        stepMood();
        state.lastEvent = eventPhrase(m) || state.lastEvent;
        if (state.paused) break;              // 暂停时不接话
        // **有张选择卡举着的时候，一个字都不说。**
        // 页面收到任何一条 `say` 都会把举着的卡收掉（pet-app.js 的 `case 'say': dropAsks()`），
        // 而卡正等着你点。实测就是这么丢过一次：卡片 08:39:31 发出去，08:39:32 你蹭了一下，
        // 那句蹭的回话把它顶掉了——**屏幕上只闪了一下，用户以为"从来没触发过"**。
        // 它的反应一点没少：表情、动作、purr/poke 音效都在页面那边自己走（pet-core），
        // 这几秒只是不说话而已。
        if (state.card) break;

        // 同一类操作在 BATCH_MS 内的若干次合成一个气泡：`times` 是攒起来的次数（连点的档位靠它），
        // `touch` 是其中最新的一次——释放的位置、睡着与否都以最新为准。
        const pick = (times) => {
          const beats = [];
          if (m.asleep) {
            // 蹭睡着的它不会吵醒它
          } else if (wake()) {
            if (m.kind === 'grab') beats.push(next(lines.wakeUp));
          } else if (away > RETURN_AFTER_MS && m.kind !== 'grab') {
            beats.push(next(lines.returnFromAway));
          }
          // 攒了几下就挑几下：连点的档位（第一次/又戳/够啦）就是按这里的次数算出来的
          let line = null;
          for (let i = 0; i < times; i += 1) line = reactionFor(state, m);
          beats.push(line);
          return beats.filter(Boolean);
        };
        reactor.touch(m.kind || 'touch', m, pick);
        // 摸够几下它就想问一句（见 askQuestion）。睡着的它不算——那会儿是在做梦。
        // **只有"摸舒服了"那一段攒好感**：抚摸现在是三段的（start/good/over），三段都算的话
        // 一次抚摸就把卡问出来了。没有 stage 的（老页面 / pet-core 自己发的）照旧算一次。
        // **摸头算两下**：那是它最喜欢的，也让它快点开口（两下头 = 摸够了）。
        // ★ 2026-10-10 部位细化之后："头"不再是一个部位，而是**一整族**
        // （呆毛/头发/眼睛/脸蛋/下巴都算"摸头"），所以这里按族判断；
        // 尾巴上的 `'head'` 是**老页面兼容**（它只会报 7 类那套名字）。
        if (m.kind === 'pet' && !m.asleep) {
          const headPet = HEAD_FAMILY.has(m.at) || m.at === 'head';
          const points = (m.stage === undefined || m.stage === 'good') ? (headPet ? 2 : 1) : 0;
          state.pets += points;
          if (points && state.pets >= askAfterPets()) { state.pets = 0; askQuestion(); }
        }
        break;
      }

      case 'answer': {
        // 页面上那张选择卡的回话：点选项 / 按数字键 → {index}；Esc 或点到别处 → {dismissed}
        const card = state.card;
        if (!card || card.id !== m.askId) break;     // 不是这一轮的（早被顶掉或过期了），当没发生
        dropCard('');
        if (m.dismissed || !Number.isInteger(m.index)) {
          reactor.reply('line', 'askDismiss', [next(lines.askDismiss)]);
          break;
        }
        const opt = card.opts[m.index];
        if (!opt) {
          reactor.reply('line', 'askDismiss', [next(lines.askDismiss)]);
          break;
        }
        if (opt.quiet > 0) {
          state.quietUntil = Date.now() + opt.quiet * 60_000;
          log.info(`它安静 ${opt.quiet} 分钟（你选了「${opt.label}」）`);
        }
        memory.addPick(opt.quiet > 0);        // 记忆：你选过几次「我在忙」
        log.info(`你选了「${opt.label}」`);
        reactor.reply('line', 'askReply', [{ text: opt.reply, actions: opt.actions || [] }]);
        break;
      }

      case 'text': {
        const text = typeof m.text === 'string' ? m.text.trim() : '';
        if (!text) break;
        talkToPet(text);
        break;
      }

      /**
       * ★ 2026-11-02：麦克风的开关与状态（页面 `startMic()` / `stopMic()` 报上来的）。
       * `denied` 是浏览器/系统没给权限 —— 此时页面已经把麦关掉了，这里只要把开关同步回去。
       */
      case 'mic': {
        if (m.state === 'on') {
          if (!ears.on && !openEars()) break;
          voicePrefs();
        } else if (m.state === 'off') {
          closeEars();
        } else if (m.state === 'denied' || m.state === 'error') {
          closeEars(`页面拿不到麦克风：${m.detail || m.state}`);
          voicePrefs({ enabled: false, ready: false, detail: `麦克风没开：${m.detail || m.state}` });
        }
        break;
      }

      /** 长按"说完了"：把当前这半句立刻送去转写（不等静音判定）。 */
      case 'commit':
        if (micAsr) micAsr.commit();
        break;

      /** ★ 2026-11-02：她那句念完了 → 立刻把耳朵放开（不用等按字数估的那段）。 */
      case 'voiceEnd':
        if (micAsr) micAsr.unmute();
        break;

      case 'control': {
        switch (m.action) {
          case 'settings':
            require('./settings.cjs').open();
            break;
          case 'voice':
            // 音色编辑：单独一个窗口（拖滑杆 + 反复试听，塞进设置页很难受）
            require('./settings.cjs').openVoice();
            break;
          case 'dress':
            // 服装：也单独一个窗口（将来贴图多了，一页缩略图比对话框清楚）
            require('./settings.cjs').openDress();
            break;
          case 'memory':
            // ★ 2026-11-04：她自己的账（锚/账/证词/传），单独一个窗口 —— 只给她看/管
            require('./settings.cjs').openSelf();
            break;
          case 'companion': {
            /**
             * 旧的二态开关（设置页「启用 QQ 连接」/ 旧版按钮）：开/关 OneBot 连接。
             * 三挡按钮现在走下面的 `companionMode`；这个保留给设置页和兼容旧页面。
             */
            const want = !companion.isOn();
            try {
              const st = companion.enable(want);
              send(ws, { t: 'prefs', companion: st });
              reactor.reply('line', 'companion', [next(want ? lines.companionOn : lines.companionOff)]);
              log.info(`陪伴模式：${want ? '开' : '关'}（开关）`);
            } catch (err) {
              log.warn(`陪伴模式开关失败：${err.message}`);
              reactor.reply('line', 'companion', [{ text: '手机没拿稳…再点一下？', actions: ['dizzy'] }]);
            }
            break;
          }
          case 'companionMode': {
            /**
             * 三挡按钮：0 桌宠大脑 / 1 QQ 拟人聊天 / 2 QQ 拟人聊天 + 手机。
             * 0 挡只把 `respond` 关掉，**不断开 OneBot**（用户要一直保持连接）。
             */
            try {
              const level = Number(m.level) === 0 ? 0 : Number(m.level) === 2 ? 2 : 1;
              const st = companion.setMode(level);
              send(ws, { t: 'prefs', companion: st });
              log.info(`陪伴模式：${level === 0 ? '桌宠大脑（QQ 保持连接）' : level === 1 ? 'QQ 拟人聊天' : 'QQ 拟人聊天 + 手机'}`);
              /**
               * ★ 2026-10-30：第 3 挡 = 她真的多了一部手机。
               * 用户选的 UX 是**不要小面板、直接弹 MuMu 窗口**，摆成竖屏贴在她旁边。
               * 弹窗失败不影响她用（她照样能 adb 操作），只记一行日志。
               */
              if (level === 2) {
                companion.phone.show()
                  .then((r) => {
                    if (!r.ok) return log.warn(`手机：窗口没弹出来（${r.why || '未知'}）`);
                    if (r.moved) log.info(`手机：窗口已就位 ${r.box.width}x${r.box.height}@${r.box.x},${r.box.y}`);
                    else log.info(`手机：窗口露出来了（MuMu 不接受摆位，现在是 ${r.now ? `${r.now.width}x${r.now.height}@${r.now.x},${r.now.y}` : '它自己的大小'}）`);
                  })
                  .catch((err) => log.warn(`手机：弹窗失败（${err.message}）`));
              } else {
                // 退回 0/1 挡：手机收起来（她要真的在用的话，任务会先停下）
                companion.phone.hide().catch(() => {});
              }
            } catch (err) {
              log.warn(`陪伴模式切换失败：${err.message}`);
            }
            break;
          }
          case 'companionRefreshQr': {
            /**
             * ★ 2026-10-26：手机上的「刷新二维码」。
             * 只是让 NapCat 重新出一张码（老的约两分钟过期）；状态会走 `companion.on('state')`
             * 自动推回页面，这里不用手动 send。
             */
            companion.gateway.refreshQr()
              .then((st) => log.info(`陪伴模式：刷新二维码${st?.qrAvailable ? '（已生成）' : '（还没生成）'}`))
              .catch((err) => log.warn(`刷新二维码失败：${err.message}`));
            break;
          }
          case 'pause':
          case 'resume': {
            state.paused = m.action === 'pause';
            log.info(state.paused ? '被暂停：不出声，也不接戳' : '取消暂停');
            // 让菜单上的按钮在"暂停/继续"之间换过来
            send(ws, { t: 'prefs', bot: { ...INIT.bot, paused: state.paused } });
            reactor.reply('react', 'control', [next(state.paused ? lines.hush : lines.back)]);
            break;
          }
          case 'quit':
            log.info('从桌宠菜单退出');
            require('electron').app.quit();
            break;
          default:
            break;
        }
        break;
      }

      case 'arrived':
      case 'interrupted':
        state.walking = false;      // 溜达结束(或被拎起来打断了)
        state.lastUserAt = Date.now();
        break;

      /* ---------- 玩具球 / 弹弹乐 ---------- */

      case 'ballMode': {
        /**
         * 三态开关（页面按球按钮循环）：`off` → `ball` → `game`。
         * 页面已经先切好了显示，这条负责**记住它**（配置）+ 关掉时闹脾气 + 进游戏时招呼一声。
         */
        const want = ['off', 'ball', 'game'].includes(m.mode) ? m.mode : 'off';
        if (want === state.ballMode) break;
        const prev = state.ballMode;
        state.ballMode = want;
        try {
          llm.save({ ballMode: want });
        } catch (err) {
          log.warn(`球/游戏模式的开关没能存进配置（重启后会恢复原样）：${err.message}`);
        }
        log.info(`球/游戏模式：${prev} → ${want}`);
        if (state.paused || state.card) break;
        if (want === 'off') {
          /**
           * **收走球要闹脾气**：随机在"委屈 / 生气"里挑一种，台词和表情一起挑
           * （用户的原话：「球收时她会出现不开心或者哭泣又或是生气的随机表情和对话」）。
           * 用 `line` 而不是 `react`：它不是"对刚才那一下的回话"，不该 2.5 秒就过期。
           */
          reactor.reply('line', 'ballOff', [next(Math.random() < .5 ? lines.ballOffSad : lines.ballOffAngry)]);
        } else if (prev === 'off') {
          reactor.reply('line', 'ballOn', [next(lines.ballOn)]);
        } else if (want === 'game') {
          reactor.reply('line', 'ballGameOn', [next(lines.ballGameOn)]);
        } else {
          reactor.reply('line', 'ballBack', [next(lines.ballBack)]);
        }
        break;
      }

      case 'ballGoal': {
        // 页面判定的进球（球门/比分都在 web/game.js 里）。这个不花 token，但**要说出来**
        const mine = m.scorer === 1;                    // scorer 1 = 她进的
        const [you, her] = Array.isArray(m.score) ? m.score : [0, 0];
        log.info(`进球：${mine ? '她' : '你'}进的 · 比分 你${you} : 她${her}`);
        /**
         * ★ **输赢意识的第一小步**（用户拍板）：进球/失球轻轻推动她的心情（见 `mood.cjs` 的 EVENT）。
         * 幅度刻意很小 —— 一局踢十几个球，太大会把心情直接推到底。
         * 心情又反过影响她走路的快慢（`mood.speed`）与台词档，所以"落后时更急"是顺带有的；
         * 真正"更急"还有 `game.js` 里的 `urgency`（落后压得更靠前）。
         */
        try { mood.onEvent(mine ? 'goal' : 'concede'); } catch { /* 心情出问题不该影响踢球 */ }
        if (state.paused || state.card) break;
        reactor.reply('line', 'ballGoal', [next(mine ? lines.ballGoalMine : lines.ballGoalYours)]);
        break;
      }

      case 'ballCharge':
        // 蓄力飞踢（页面里的概率事件）：喊一声
        if (state.paused || state.card) break;
        reactor.reply('react', 'ballCharge', [next(lines.ballCharge)]);
        break;

      case 'ballHead': {
        /**
         * 头球顶到的那一刻：**球离地多高、她的脚底在哪**。
         * 用它校准"头球打在她哪个部位"（用户："大概在额头，我想象的在气泡那一块"）——
         * 有真实数字才能一次挪准判定盒，不用一轮一轮试。
         */
        log.info(`头球：球离地 ${m.high}px · 她的脚底在离地 ${m.floor - m.feet}px（跃起）· 球在她头顶上方 ${m.high - (m.floor - m.feet) - 96}px`);
        if (state.paused || state.card) break;
        reactor.reply('react', 'ballHead', [next(lines.ballKick)]);
        break;
      }

      case 'ballKick': {
        // 页面判定"她踢到球了"（物理在 web/ball.js），`at` 是球的横向比例（0..1）。
        // 记下来，好让她下次知道往哪走；然后说一句踢球的台词。
        // **`dir` 也记进日志**：排查"她怎么把球踢进自己网里"时，这是唯一能看清方向的线索。
        if (typeof m.at === 'number' && m.at >= 0 && m.at <= 1) state.ballX = m.at;
        if (state.ballMode === 'game') log.info(`踢球：位置 ${(m.at * 100).toFixed(0)}% · 方向 ${m.dir > 0 ? '右' : '左'}（${m.dir}）`);
        if (state.paused || state.card) break;
        reactor.reply('react', 'ballKick', [next(lines.ballKick)]);
        break;
      }

      case 'micro':
        // 页面把那个小动作演完了（`pet-core` 的 `microStep`）。**故意不动 `lastUserAt`**：
        // 它自己动一下不算"你理了它"，不然犯困/睡觉的计时会被这些小动作一直推后。
        break;

      case 'prefs':
        /**
         * ★ 2026-11-02：语音输入的总开关（右键菜单左上角那个麦克风）。
         * 页面先本地切挡、再报上来；这里把耳朵打开/关掉，并回一条 `voice` 让按钮显示真实状态。
         */
        if (typeof m.mic === 'boolean') {
          if (m.mic) openEars();
          else closeEars();
        }
        // 页面上的开关（菜单里的「自动」和「声音」）也存进 config\settings.json，重启后还在。
        if (typeof m.autoChat === 'boolean' && m.autoChat !== state.autoChat) {
          state.autoChat = m.autoChat;
          log.info(state.autoChat ? '自动说话：开（接了模型时每隔一分钟说一句）' : '自动说话：关');
          try {
            llm.save({ autoChat: state.autoChat });
          } catch (err) {
            log.warn(`自动说话的开关没能存进配置（重启后会恢复原样）：${err.message}`);
          }
        }
        // ★ 2026-11-01：**声音总闸要存盘**。
        // 以前只存 `voice` / `weatherSound`，`INIT.sound` 写死 true —— 用户点「关」之后
        // 重启又响（页面拿 init 去 `sfx.set(true)`，把 sfx 自己存进 localStorage 的 off 覆盖掉）。
        if (typeof m.sound === 'boolean' && m.sound !== state.sound) {
          state.sound = m.sound;
          log.info(`声音：${state.sound ? '开' : '关（音效与环境音都静）'}`);
          try {
            llm.save({ sound: state.sound });
          } catch (err) {
            log.warn(`声音开关没能存进配置（重启后会恢复原样）：${err.message}`);
          }
        }
        // 三档声音按钮：`off` 全关 · `sfx` 只有音效 · `voice` 音效 + 念大模型的回答
        if (typeof m.voice === 'string') {
          const on = m.voice === 'voice' && tts.available();
          if (on !== speaker.on) {
            speaker.on = on;
            log.info(on ? '语音：开（大模型的回答会念出来）' : '语音：关');
            try {
              llm.save({ voice: on });
            } catch (err) {
              log.warn(`语音开关没能存进配置（重启后会恢复原样）：${err.message}`);
            }
          }
        }
        // ★ 天气（页面自己切自己判，这里只把它记下来：重启后还在、重连时同步回页面）
        if (typeof m.weather === 'string' && ['off', 'snow', 'blossom', 'leaf', 'rain'].includes(m.weather)
          && m.weather !== state.weather) {
          state.weather = m.weather;
          log.info(`天气：${({ off: '关', snow: '雪', blossom: '樱花', leaf: '落叶', rain: '雨天' })[m.weather]}`);
          try {
            llm.save({ weather: state.weather });
          } catch (err) {
            log.warn(`天气没能存进配置（重启后会恢复原样）：${err.message}`);
          }
        }
        // ★ 天气的环境音开关（页面自己判自己响，这里只把它记下来：重启后还在、重连时同步回页面）
        if (typeof m.weatherSound === 'boolean' && m.weatherSound !== state.weatherSound) {
          state.weatherSound = m.weatherSound;
          log.info(`天气音效：${state.weatherSound ? '开' : '关'}`);
          try {
            llm.save({ weatherSound: state.weatherSound });
          } catch (err) {
            log.warn(`天气音效开关没能存进配置（重启后会恢复原样）：${err.message}`);
          }
        }
        // 一轮对话结束 → 清掉"哪句念过了"的记录，下次同一个回答还会念
        if (m.round) speaker.flush();
        // 只在**真的有设置变了**的时候写日志。`{t:'prefs',round:true}` 是页面每 1.5 秒
        // 就会发的"这一轮说完了"信号（它不是设置），原来把它也打出来，等于桌宠闲着的时候
        // 每分钟往 pet.log 灌约 57 行——512KB 的日志很快被它顶掉，真出问题时语音那几行
        // 早被冲没了。**实测：启动 2 分钟就刷了 24 行这种噪音。**
        const changed = [];
        if (typeof m.autoChat === 'boolean') changed.push(`autoChat=${m.autoChat}`);
        if (typeof m.voice === 'string') changed.push(`voice=${m.voice}`);
        for (const k of Object.keys(m)) {
          if (k !== 't' && k !== 'round' && k !== 'autoChat' && k !== 'voice' && k !== 'weatherSound') changed.push(`${k}=${JSON.stringify(m[k])}`);
        }
        if (changed.length) log.info(`页面改了设置:${changed.join(' ')}`);
        break;

      case 'position':
        // 它站在哪儿（窗口宽度的比例）：存下来，下次启动从 INIT.startX 发回去
        savePetX(m.x);
        break;

      default:
        break;                      // mic / devices:暂时没事可做
    }
  });

  ws.on('error', (err) => log.warn(`连接出错:${err.message}`));
  ws.on('close', () => {
    clearTimeout(idle);
    clearTimeout(greeting);
    clearTimeout(memoryGreeting);
    clearTimeout(auto);
    clearInterval(awayPoll);       // 系统空闲那条轮询
    clearInterval(moodTimer);      // 心情的心跳
    clearTimeout(micro);           // 微动作那条定时器
    if (pm) {                      // 监听器是跟着这条连接注册的，必须摘掉
      pm.off('lock-screen', onSleep); pm.off('suspend', onSleep);
      pm.off('unlock-screen', onWake); pm.off('resume', onWake);
      pm.off('on-battery', onBattery);
    }
    dropCard('连接断了');
    closeEars('页面断了');        // ★ 2026-11-02：别让耳朵在后台一直开着麦克风
    reactor.close();               // 没说完的气泡跟着连接一起作废
    speaker.sent.clear();
    log.info('桌宠页面断开');
  });
}

// `next` / `partOfDay` / `fill` / `moodPick` / `readTone` 是纯函数，导出给 test\smoke.cjs 用。
module.exports = { attach, SKIN, INIT, next, partOfDay, moodOf, beatsFor, createSpeaker, deskVoiceOn, fill, moodPick, readTone, TONE };
