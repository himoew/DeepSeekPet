/**
 * 她的小手表（2026-10-27）。
 *
 * 时间来源：**本机系统时钟**（`new Date()`），不联网、不问服务器。
 * 为什么不用网络时间：桌宠是本地小工具，断网也要能报时；系统时钟已经跟 Windows
 * 的时区/夏令时设置一致，没必要为一句"几点了"多一次请求。
 *
 * 三种"知道现在"：
 *   1. ★ 2026-11-01：**每一轮都直接告诉她现在是什么时候**（`nowLine()`，由
 *      `companion-brain.reply()` 拼在本轮消息最前面）—— 这是主路；
 *   2. 用户问「几点了 / 今天几号 / 星期几」→ 调用方把 `requestContext()` 拼进 system，
 *      她就能直接答；
 *   3. 她想把钟点打出来 → 在回复里写 `[时间]`（或 `[看时间]`），World 用 `fillTags()` 换成
 *      真实时间。这样不用多打一次模型，也不会让她编时间。
 *
 * ★ 为什么第 1 条是主路（2026-11-01 的根因）：
 * 在这之前，"看时间"被设计成**她自己主动查表**（提示词原话是"想知道现在几点时写 [时间]"），
 * 而 QQ 那条路的 system 里**根本没有时间**。于是她只能顺着对话气氛猜 —— 实测：
 * 11-01 早上 08:35 她说"大半夜的又翻这个"、10-31 08:58 她说"睡了吗…都这么晚了"。
 * **表一直在，只是没人告诉她现在几点。**
 */

const WEEK_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const pad = (n) => String(n).padStart(2, '0');

/** `20:34` */
function timeText(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** `2026-10-27 20:34 周二` */
function fullText(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${timeText(d)} ${WEEK_CN[d.getDay()]}`;
}

/** 凌晨 / 清早 / 上午 / 中午 / 下午 / 晚上 / 深夜（跟 pet.cjs 的时段口径一致）。
 *
 * ★ 2026-11-01：**这个分段不再喂给模型**（用户拍板："让她自己决定说法，不添加额外设定，
 * 她会说很晚了、不早了之类的模糊发言"）。现在只留给本地台词/闸门用（开机问候、
 * presence 的醒着时段），以及自检。喂给她的只有事实，见 `nowLine()`。
 */
function partOfDay(date = new Date()) {
  const h = (date instanceof Date ? date : new Date(date)).getHours();
  if (h < 5) return '凌晨';
  if (h < 9) return '清早';
  if (h < 12) return '上午';
  if (h < 14) return '中午';
  if (h < 18) return '下午';
  if (h < 23) return '晚上';
  return '深夜';
}

/**
 * ★ 2026-11-01：**每句话前面那一行"现在"**。只给事实，不给说法。
 *
 * 形如 `【现在】2026-11-01 08:43 周日`：日期、星期、钟点三样，**不写"早上/深夜"**。
 * 用户拍板的原话：「让她自己决定说法，不添加额外设定，她会说很晚了、不早了之类的模糊发言」——
 * 同一个 08:43，说"才八点"还是"都这个点了"是她的自由，代码不该替她定调。
 *
 * 位置由调用方决定（`companion-brain.reply()` 拼在**本轮 user 消息最前面**）：
 *   · 拼在消息里而不是 system 里 → system + 历史的前缀不变，DeepSeek 的上下文缓存还能命中；
 *   · 只标"这一句发生在什么时候"，20 轮前那段半夜的旧对话不会被误当成"现在"。
 */
function nowLine(date = new Date()) {
  return `【现在】${fullText(date)}`;
}

/**
 * 用户这句话是不是在问时间/日期。
 * 只认比较明确的说法，避免"时间过得真快"这种话被当成报时请求。
 */
function detectRequest(text) {
  const s = String(text || '');
  return /(几点了|几点啦|几点|现在时间|现在几点|什么时间|啥时间|报个时|报时|看看时间|看下时间|看一下时间|时间是多少|现在多会儿|今天几号|几号了|今天.*星期几|今天.*周几|星期几|周几|今天.*日期|现在.*日期|what\s*time|what\s*day)/i.test(s);
}

/** 用户问时间/日期时，给 system 的一段话；没问就返回空串。 */
function requestContext(text, date = new Date()) {
  if (!detectRequest(text)) return '';
  return `对方刚问你时间/日期。现在是 ${fullText(date)}。直接答，不要编。`;
}

/** 她回复里可以写的"看表"标记。 */
const TAG_RE = /\[(?:看时间|现在时间|当前时间|时间)\]/g;

/** 把 `[时间]` 换成真实时间；其余文字不动。 */
function fillTags(text, date = new Date()) {
  return String(text || '').replace(TAG_RE, timeText(date));
}

/** 回复里有没有"看表"标记（日志/自检用）。 */
function hasTag(text) {
  TAG_RE.lastIndex = 0;
  return TAG_RE.test(String(text || ''));
}

/* ---------- ★ 2026-11-02：**回看**一句话时，它发生在哪天 ---------- */

/**
 * 用户报的问题（这一节的起点）：
 * 19:12 主动开口，她说「下午想起个事，**昨天**你那个挑菜的店」——
 * 而"挑菜"是**当天 18:41** 的事。查下来不是表不准（`nowLine()` 是对的），
 * 是**只有"现在"是完整的**：
 *   · 20 轮对话（发给模型的 messages 历史）一条日期都没有；
 *   · 长期记忆的正文日期被剥掉；
 *   · 跨场合近况只印 `HH:MM`（昨天的 23:44 看起来像今天）。
 * 于是她只能猜，猜出来的就是"下午/昨天"。
 *
 * 所以这里统一给"回看"提供三样东西：
 *   · `recentStamp(ms, now)` —— `今天 20:44` / `昨天 23:44` / `11-01 23:44`（跨年带年份）；
 *   · `dayText(ms, now)`     —— `11-01`（长期记忆条目前面那个日期）；
 *   · `resolveRelative(txt, base)` —— 把**写死的**"今天/昨天/明天"按写入那天还原成绝对日期。
 */
const DAY_MS = 86_400_000;
const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** `11-01`；不是今年的写成 `2025-11-01`。 */
function dayText(ms, now = new Date()) {
  const d = ms instanceof Date ? ms : new Date(ms);
  const n = now instanceof Date ? now : new Date(now);
  const md = `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return d.getFullYear() === n.getFullYear() ? md : `${d.getFullYear()}-${md}`;
}

/** `今天 20:44` / `昨天 23:44` / `11-01 23:44` —— 给她回看用，别让"23:44"看着像今天。 */
function recentStamp(ms, now = Date.now()) {
  const d = ms instanceof Date ? ms : new Date(ms);
  const n = now instanceof Date ? now : new Date(now);
  const diff = Math.round((startOfDay(n) - startOfDay(d)) / DAY_MS);
  if (diff === 0) return `今天 ${timeText(d)}`;
  if (diff === 1) return `昨天 ${timeText(d)}`;
  return `${dayText(d, n)} ${timeText(d)}`;
}

/**
 * 写死的相对日期 → 那天的绝对日期。
 *
 * 为什么要在**读的时候**还原，而不是只改整理员的提示词：
 * `data\companion\memory\` 里已经躺着"他**今天**下午两点多才醒"（10-31 写的）、
 * "所以**明天**见面得等到晚上"（11-01 写的）。改提示词只挡住以后，旧账照样每轮被检索出来喂给她。
 * 条目自己的 `created` 就是"写这句话的那天"，按它换算最准，也不用改用户的数据文件。
 *
 * 只认这九个词（"每天/半天/明天见"里只有"明天"算），不做通用时间解析。
 */
const RELATIVE_WORDS = [
  ['昨晚', -1, '晚上'],
  ['昨天', -1, ''],
  ['前天', -2, ''],
  ['今晚', 0, '晚上'],
  ['今早', 0, '早上'],
  ['今天', 0, ''],
  ['明天', 1, ''],
  ['明晚', 1, '晚上'],
  ['后天', 2, ''],
];
const RELATIVE_RE = /(昨晚|昨天|前天|今晚|今早|今天|明天|明晚|后天)/g;
/** 不带 g 的那份只用来判断"有没有"，免得 `test()` 推进 `lastIndex` 把下一次替换弄坏。 */
const RELATIVE_HAS = /(昨晚|昨天|前天|今晚|今早|今天|明天|明晚|后天)/;

function resolveRelative(text, base = Date.now()) {
  const s = String(text || '');
  if (!s || !RELATIVE_HAS.test(s)) return s;
  const d0 = base instanceof Date ? base : new Date(base);
  return s.replace(RELATIVE_RE, (word) => {
    const hit = RELATIVE_WORDS.find(([w]) => w === word);
    if (!hit) return word;
    const d = new Date(d0.getFullYear(), d0.getMonth(), d0.getDate() + hit[1]);
    return `${d.getMonth() + 1} 月 ${d.getDate()} 日${hit[2]}`;
  });
}

/**
 * 给 system 的一行说明：她**每句话前面都有【现在】**，`[时间]` 只是"想把钟点打出来"。
 *
 * ★ 2026-11-01 改口：原来写的是「你想知道现在几点时，直接在回复里写 [时间]」——
 * 这句话在暗示"你平时不知道，得去查表"，而实测她几乎从不查。现在事实每一轮都给她，
 * 这行只说明"你想报钟点时怎么把数字打出来"。
 */
function promptLine() {
  return '【时间】你随时知道现在几点（每条消息前面都有一行【现在】，带年月日、星期和钟点）。想把钟点打出来，就在回复里写 [时间]，系统会换成真实时间；不用猜，也别自己编。';
}

module.exports = {
  WEEK_CN, timeText, fullText, partOfDay, nowLine, detectRequest, requestContext,
  fillTags, hasTag, promptLine,
  // ★ 2026-11-02：回看用（"回看一句话时它发生在哪天"）
  dayText, recentStamp, resolveRelative,
};
