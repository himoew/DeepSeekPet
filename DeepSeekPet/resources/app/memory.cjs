/**
 * 它的记忆 —— 一个很瘦的 json。
 *
 * 用户要的是「陪伴多少天 / 对话多少次 / 各项互动的次数」这种**能看见**的东西，
 * 所以只记这几样，多的一概不记，免得文件越长越臃肿：
 *
 *   first / lastDay / visits   第一次见面、最近一次、来过几天
 *   talks                      你打字跟它说话几次
 *   touch{poke,pet,grab,drop}  各项互动各多少次
 *   area{head,…}               被碰得最多的是哪儿（只说第一名）
 *   pick{quiet}                选择卡里你选过几次「我在忙」
 *   words / wordsAt            你上次打的那句话（截短，只在它想说的时候用）
 *   hours[24]                  你常在的时段（每次见面给当前小时 +1）
 *   saidDay / saidCount        "记忆话"今天说几次了（每天有上限，免得变话痨）
 *
 * 文件放在 `data\` 下跟 pet.log 做邻居 —— 于是 `DSP_LOG_DIR` 一改（自检就是）它跟着被隔离，
 * 不会污染用户真实的记忆。
 *
 * **写入是攒着的**（`SAVE_MS`）：戳一下摸一下很频繁，不能每次都落盘；
 * 但"见面"这种一天一次的事会立刻写（`touchSeen`），免得刚认识就断电。
 */
const fs = require('node:fs');
const path = require('node:path');
const log = require('./log.cjs');

const FILE = path.join(path.dirname(log.file), 'pet-memory.json');
const SAVE_MS = 5000;
/** 每次见面最多说几句"记忆话"（再多就成话痨了，跟应答链那套"少而准"的设计是一致的）。 */
const SAY_PER_DAY = 2;

const localDay = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function blank() {
  return {
    first: localDay(), lastDay: '', seen: '', visits: 0,
    talks: 0,
    touch: { poke: 0, pet: 0, grab: 0, drop: 0 },
    area: {},
    pick: { quiet: 0 },
    words: '', wordsAt: '',
    hours: new Array(24).fill(0),
    saidDay: '', saidCount: 0,
  };
}

let data = null;
let timer = 0;

function load() {
  if (data) return data;
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { /* 没有就是第一次 */ }
  const base = blank();
  data = {
    ...base, ...raw,
    touch: { ...base.touch, ...(raw.touch || {}) },
    pick: { ...base.pick, ...(raw.pick || {}) },
    area: { ...(raw.area || {}) },
    hours: Array.isArray(raw.hours) && raw.hours.length === 24 ? raw.hours.slice() : base.hours,
  };
  if (typeof data.first !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(data.first)) data.first = base.first;
  return data;
}

/** 立刻落盘（见面、清空这类"一天一次"的场合用）。 */
function saveNow() {
  clearTimeout(timer);
  timer = 0;
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, `${JSON.stringify(load(), null, 2)}\n`);
  } catch (err) {
    log.warn(`记忆没能存下来:${err.message}`);
  }
}

/** 攒一会儿再写（戳/摸这种高频计数用）。 */
function saveSoon() {
  if (timer) return;
  timer = setTimeout(() => { timer = 0; saveNow(); }, SAVE_MS);
  if (timer.unref) timer.unref();          // 别为了等这次写入把进程吊着（自检要能退出）
}

/** 页面连上 = 一次"见面"。返回快照，调用方拿它决定开机要不要说句"认识第几天"。 */
function touchSeen() {
  const d = load();
  const day = localDay();
  const firstEver = d.visits === 0;
  const away = awayDays(d);              // **先算**：用上一次的 seen，而不是刚更新完的 0
  if (d.lastDay !== day) { d.visits += 1; d.lastDay = day; }
  d.hours[new Date().getHours()] += 1;
  d.seen = new Date().toISOString();
  if (d.saidDay !== day) { d.saidDay = day; d.saidCount = 0; }
  saveNow();
  if (firstEver) log.info(`第一次见面：记住 ${d.first}`);
  return { ...snapshot(), awayDays: away };
}

/** 一次互动（戳/摸/拎/放）。`kind` 和 `area` 都来自页面报上来的 touch。 */
function addTouch(kind, area) {
  const d = load();
  if (d.touch[kind] === undefined) return;
  d.touch[kind] += 1;
  if (area) d.area[area] = (d.area[area] || 0) + 1;
  saveSoon();
}

/** 你打字跟它说话。顺手记下这句（截 20 字），它以后可能拿出来提一句。 */
function addTalk(text) {
  const d = load();
  const t = String(text || '').trim().slice(0, 20);
  d.talks += 1;
  if (t) { d.words = t; d.wordsAt = new Date().toISOString(); }
  saveSoon();
}

/** 选择卡里的选择（目前只记"我在忙"，那是它安静下来的原因）。 */
function addPick(quiet) {
  if (!quiet) return;
  const d = load();
  d.pick.quiet += 1;
  saveSoon();
}

/** 认识第几天（第一次见面那天算第 1 天）。 */
function daysKnown(d = load()) {
  const t = Date.parse(`${d.first}T00:00:00`) || Date.now();
  return Math.max(1, Math.floor((Date.now() - t) / 86400000) + 1);
}

/** 上次见面到现在隔了几天（从没记过就返回 0）。 */
function awayDays(d = load()) {
  if (!d.seen) return 0;
  const ms = Date.now() - (Date.parse(d.seen) || Date.now());
  return Math.max(0, Math.floor(ms / 86400000));
}

/** 被碰得最多的那个部位（没有任何计数就返回 ''）。 */
function topArea(d = load()) {
  let best = '', n = 0;
  for (const [k, v] of Object.entries(d.area)) if (v > n) { best = k; n = v; }
  return n >= 5 ? best : '';            // 少于 5 次就别自称"你最喜欢摸…"
}

/** 你常在的那个小时（见面次数最多的那个）。 */
function topHour(d = load()) {
  let best = new Date().getHours(), n = 0;
  d.hours.forEach((v, h) => { if (v > n) { n = v; best = h; } });
  return best;
}

/** 今天还能不能说"记忆话"。 */
function canSayMemory(d = load()) {
  return d.saidDay === localDay() && d.saidCount < SAY_PER_DAY;
}
function markSaid() {
  const d = load();
  if (d.saidDay !== localDay()) { d.saidDay = localDay(); d.saidCount = 0; }
  d.saidCount += 1;
  saveSoon();
}

/** 给设置页看的（也是"记忆话"和模型上下文的取值来源）。都不含密钥之类的东西。 */
function snapshot() {
  const d = load();
  return {
    days: daysKnown(d),
    first: d.first,
    visits: d.visits,
    awayDays: awayDays(d),
    talks: d.talks,
    touch: { ...d.touch },
    areaTop: topArea(d),
    areaTopCount: topArea(d) ? d.area[topArea(d)] : 0,
    quiet: d.pick.quiet,
    words: d.words,
    hourTop: topHour(d),
    saidToday: d.saidDay === localDay() ? d.saidCount : 0,
    file: FILE,
  };
}

/** 忘掉一切（设置页那个按钮）。清空之后"今天"就算重新认识的第一天。 */
function forget() {
  data = blank();
  data.lastDay = localDay();
  data.visits = 1;                                  // 你现在就在这儿
  data.hours[new Date().getHours()] = 1;
  saveNow();
  log.info('记忆已清空（从今天重新认识）');
  return snapshot();
}

module.exports = { touchSeen, addTouch, addTalk, addPick, canSayMemory, markSaid, snapshot, forget, FILE, SAY_PER_DAY };
