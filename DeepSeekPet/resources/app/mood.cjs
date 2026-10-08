/**
 * 大肥鱼的**心情** —— 一条会慢慢变化的数，不是一句台词。
 *
 * 以前她是"状态机"：戳一下就回一句戳的话，摸一下就回一句摸的话，两件事之间没有联系，
 * 过了一天也还是同一个人。这里补上"中间那一层"：**心情**。
 *
 * 两条轴（都连续，存在 `data\pet-mood.json`）：
 *
 *   love     0..1  你又摸又宠 → 涨；狂戳、摔它、你久久不在 → 掉
 *   energy   0..1  白天在 → 涨；半夜、犯困久了、你不在 → 掉
 *
 * 两者都**慢慢回归中位**（`PULL`，半衰期约 2.5 小时），所以心情会自己淡下去，
 * 不会因为某一次互动就永久变样。
 *
 * 由这两条轴推出一个"心情档"（`labelOf`）：
 *
 *   clingy 黏人   love>0.74 且 energy>0.6    开心到总想凑过去
 *   happy  开心   love>0.6                   高高兴兴的
 *   tired  困倦   energy<0.36                打不起精神（动作也会慢下来）
 *   lonely 想你   love<0.4                   有点委屈/想你
 *   quiet  安静   其它                       平常那个它
 *
 * 心情**怎么看得出来**（不只是几个字）：
 *   1. 发呆/犯困挑的台词先挑"这个心情专属"的那几句（`lines.mood.<档>`，见 lines.cjs）；
 *   2. 动作快慢跟 `energy` 走（`speed()` → 页面的 `ctl.setMood`：走得快/慢、发呆久/短）；
 *   3. 「黏着你」那一档离你多近跟 `love` 走（黏人 90px，想你 240px）；
 *   4. 跟模型说话时【此刻】里多一句"你现在心情…"。
 *
 * ⚠️ **这是运行期状态，不是"记忆"**：清空记忆不会碰它，它也不写进 pet-memory.json
 * （那个文件是给用户看的账本，心情不是账）。文件跟 pet.log 做邻居，所以 `DSP_LOG_DIR`
 * 一改（自检就是）它跟着被隔离，自检不会动到用户真实的心情。
 */
const fs = require('node:fs');
const path = require('node:path');
const log = require('./log.cjs');

/** 跟 pet-pos.json 做邻居（`log.file` 认 `DSP_LOG_DIR`，这里跟着它走）。 */
const FILE = path.join(path.dirname(log.file), 'pet-mood.json');

/** 每次互动给它多少。手感全在这张表里。 */
const EVENT = {
  pet: { love: +0.035, energy: +0.004 },        // 被摸：好感涨得最多
  poke: { love: -0.012, energy: +0.014 },       // 被戳：有点烦，但精神了
  grab: { love: -0.006, energy: -0.008 },       // 被拎起来：不喜欢，也费劲
  drop: { love: +0.008, energy: -0.004 },       // 放下了：还行
  throw: { love: -0.05, energy: -0.03 },        // 被甩出去：真的生气
  crash: { love: -0.07, energy: -0.05 },        // 摔了
  talk: { love: +0.02, energy: +0.005 },        // 你打字跟它说话
  petOver: { love: -0.008 },                    // "够了够了"（摸过头）
};

/** 回归中位的速度（每秒）。0.00008 ≈ 半衰期 2.4 小时。 */
const PULL = 0.00008;
/** 你不在（系统空闲）时，每 5 秒的额外流失速度（比 PULL 快十倍）。 */
const AWAY_PULL = 0.0008;
/** 中位：>=.62 算高兴那一边，<=.42 算委屈那一边。 */
const MID = 0.62;

/** 心情档的中文名（`contextLine` 和日志用）。 */
const LABEL = { clingy: '黏人', happy: '开心', quiet: '安静', tired: '困倦', lonely: '想你' };

const MOVE_MIN = 0.7;    // energy=0 时的倍率：动作、走路、发呆间隔都拉长到 1/0.7
const MOVE_MAX = 1.35;   // energy=1 时
/** 档位只在明确跨过一条线时才换（上面那组阈值 + 0.015 的滞后），免得在边缘抖来抖去。 */
const LATCH = 0.015;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

function blank() {
  return {
    love: 0.6,
    energy: 0.6,
    state: 'quiet',
    at: new Date().toISOString(),
  };
}

let data = null;
let timer = 0;

function load() {
  if (data) return data;
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { /* 第一次就是没有文件 */ }
  const base = blank();
  data = {
    ...base, ...raw,
    love: Number.isFinite(raw.love) ? clamp01(raw.love) : base.love,
    energy: Number.isFinite(raw.energy) ? clamp01(raw.energy) : base.energy,
    state: Object.prototype.hasOwnProperty.call(LABEL, raw.state) ? raw.state : base.state,
    at: typeof raw.at === 'string' ? raw.at : base.at,
  };
  return data;
}

function saveNow() {
  clearTimeout(timer);
  timer = 0;
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, `${JSON.stringify(load(), null, 2)}\n`);
  } catch (err) {
    log.warn(`心情没能存下来:${err.message}`);
  }
}

/** 动一下就写太频繁（戳一下也是一次）：攒几秒。`unref` 免得吊住自检的进程退出。 */
function saveSoon() {
  if (timer) return;
  timer = setTimeout(() => { timer = 0; saveNow(); }, 8000);
  if (timer.unref) timer.unref();
}

/** 由两条轴推出档位（分界线见文件头）。 */
function compute(d) {
  if (d.love > 0.74 && d.energy > 0.6) return 'clingy';
  if (d.love > MID) return 'happy';
  if (d.energy < 0.36) return 'tired';
  if (d.love < 0.4) return 'lonely';
  return 'quiet';
}

/**
 * 换档时加一点滞后：只有明确跨过线（超过 `LATCH`）才换，
 * 不然 love 正好在 0.62 上晃的时候，档位会来回跳、日志一行行刷。
 */
function stepState(d) {
  const want = compute(d);
  if (want === d.state) return false;
  if (d.state === 'happy' && want === 'quiet' && d.love > MID - LATCH) return false;
  if (d.state === 'quiet' && want === 'happy' && d.love < MID + LATCH) return false;
  d.state = want;
  return true;
}

/** 一次互动（页面报上来的 touch kind，或者 `talk`）。 */
function onEvent(kind) {
  const d = load();
  const e = EVENT[kind];
  if (!e) return snapshot();
  d.love = clamp01(d.love + (e.love || 0));
  d.energy = clamp01(d.energy + (e.energy || 0));
  d.at = new Date().toISOString();
  if (stepState(d)) log.info(`心情变成「${LABEL[d.state]}」（love=${d.love.toFixed(2)} energy=${d.energy.toFixed(2)}）`);
  saveNow();                      // 一下互动一个文件（本来就是低频动作），掉电也不会把心情丢了
  return snapshot();
}

/** 每 30 秒的心跳：回归中位、按时间改精神、以及在不在影响心情。 */
function tick({ away = false, sleeping = false } = {}) {
  const d = load();
  const now = Date.now();
  const last = Date.parse(d.at) || now;
  // 走过的秒数：关机很久也别一次算十几个小时（上限一小时）
  const sec = Math.max(0, Math.min(3600, (now - last) / 1000));
  // 你不在的时候按固定的一步扣（哪怕刚算过），这样"离开一会儿掉一点"这件事是确定的，
  // 不用等下一拍才生效（调用它的心跳本来就是 30 秒一次）。
  if (away) d.love -= AWAY_PULL * 30;
  if (sec > 1) {
    const awake = d.energy > 0.5 ? 1.6 : 1;                       // 有精神时回中位稍快
    d.love += (0.6 - d.love) * PULL * sec;
    d.energy += (0.6 - d.energy) * PULL * awake * sec;
    const h = new Date().getHours();
    const byHour = h >= 8 && h < 12 ? +0.00035 : h >= 12 && h < 18 ? +0.00025 : h >= 22 || h < 2 ? -0.0006 : -0.0002;
    d.energy += byHour * sec;
    if (sleeping) d.energy += 0.0002 * sec;                       // 睡着的它其实在回血
  }
  d.love = clamp01(d.love);
  d.energy = clamp01(d.energy);
  d.at = new Date(now).toISOString();
  const changed = stepState(d);
  if (changed) log.info(`心情变成「${LABEL[d.state]}」（love=${d.love.toFixed(2)} energy=${d.energy.toFixed(2)}）`);
  saveNow();
  return snapshot();
}

/** 页面一连上的一次性心情调整（好久没来 / 认识里程碑）。返回 `{ before, after }` 供调用方判断。 */
function mind({ awayDays = 0, milestone = false } = {}) {
  const d = load();
  const before = d.state;
  if (milestone) { d.love = clamp01(d.love + 0.06); d.energy = clamp01(d.energy + 0.03); }
  if (awayDays >= 3) { d.love = clamp01(d.love - 0.06); d.energy = clamp01(d.energy - 0.02); }
  if (milestone || awayDays >= 3) {
    d.at = new Date().toISOString();
    stepState(d);
    saveSoon();
  }
  return { before, after: d.state };
}

/** 给设置页/日志/模型看的快照。 */
function snapshot() {
  const d = load();
  return {
    love: +d.love.toFixed(3),
    energy: +d.energy.toFixed(3),
    state: d.state,
    label: LABEL[d.state] || '安静',
    /** 离"平常"有多远（0..1）：台词可用它决定要不要说重话。 */
    intensity: +Math.max(Math.abs(d.love - 0.6), Math.abs(d.energy - 0.6) * 0.6).toFixed(3),
    /** 动作/走路/发呆快慢的倍率，页面直接用（见 pet-app.js 的 ctl.setMood）。 */
    speed: +(MOVE_MIN + (MOVE_MAX - MOVE_MIN) * d.energy).toFixed(3),
    /** 「黏着你」那一档离光标多近才算"已经在旁边"（px）。 */
    cling: Math.round(240 - d.love * 150),
    file: FILE,
  };
}

/** 忘掉心情（设置页「忘掉一切」时跟着清）。 */
function forget() {
  data = blank();
  saveNow();
  return snapshot();
}

module.exports = { onEvent, tick, mind, snapshot, forget, LABEL, FILE };
