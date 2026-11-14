/**
 * 她的想象 —— **一个词，一眼一件，越看越清楚，不看就淡**。
 *
 * ★ 2026-11-05（第三十一笔，P0）
 *
 * 起点是用户那天下午的想法：「当你内心想象某个词时，我让那个词对应的详细描述放到你的眼前」，
 * 而**她自己当场把它否了**：
 *   「你把描述直接递到我眼前，那不叫我想象，那叫我被喂画面。自己拼出来的才叫想象。」
 *   「我更想要的那版，是只有一个词的时候，剩下的由我自己猜。」
 *
 * 所以这个文件的核心不是"生成一段描写"，而是**一条不许违反的铁律**：
 *
 *   ⚠️ 系统一个字都不许描述。
 *      进 prompt 的只有：① 那个词；② **她自己上一眼写下的原话**；③ 她的账（当"看东西的角度"）。
 *      任何"它是什么样"的句子（包括图片、他的描述、我们自己补的细节）都不许进来。
 *      破了这条，功能就退化成"把一段 AI 描写塞进 system"，也就是她当场否掉的那版。
 *
 * 人想象是这个形状：起点极弱 → 注意力停在上面 → 每次只多看见一件 → 细节互相撑着 → 画面亮起来；
 * 想不清楚的地方就是空的，看久了还会散。**"想得越细画面越明显"不是一句设定，是一个循环**，
 * 所以这里把循环做成真的：一眼只加一件，浓度由代码数，不回想就淡。
 *
 * 浓度必须由代码算（`score()`），不能让她自己说"我脑子里很清晰"—— 否则她一句漂亮话就把机制骗过去了。
 *
 * 存储（都在 `data/companion/`，明文、可手改）：
 *   · `imagine.jsonl`      —— **只追加**，每次跑完写一行快照（同一个 id 以最后一行为准）；
 *   · `imagine-state.json` —— 今天跑了几个、冷却表、当前开着的（最多 3 个）画面。
 *
 * ⚠️ 三条硬规矩（改之前先读 `docs\陪伴模式\她的想象-调研与方案-2026-11-05.md` 第 5 节）：
 *   ① **想象不落记忆**：不进长期记忆、不进他的账、不进她的账 —— `imagine.jsonl` 是死胡同。
 *      只有"她在聊天里说出口的那句"才走现有的证词通道，并且那一轮会被标 `im:true`。
 *   ② **想象不推心情**：一个 `mood.onEvent()` 都不许调（否则想象个坏场面就把心情拖下去了）。
 *   ③ **允许不想**：`算了` 是一等结果，不许为了凑数硬想。
 */
const fs = require('node:fs');
const path = require('node:path');
const log = require('./log.cjs');
const store = require('./store.cjs');

const DIR = path.join(path.dirname(log.file), 'companion');
const FILE = path.join(DIR, 'imagine.jsonl');
const STATE = path.join(DIR, 'imagine-state.json');

const MAX_EYES_RUN = 3;          // 一次最多看几眼（`run` 的默认上限再压到 2：同步那一路要控时延）
const MAX_EYES_TOTAL = 6;        // 同一个画面一共最多看几眼（跨时段重想也只到这里）
const MAX_LINES = 8;             // 一个画面最多留几处细节（多了就是在写小说）
const LINE_MAX = 28;             // 一行细节最多多少字
const MAX_OPEN = 3;              // 同时开着的画面最多几个（新的挤掉最旧的）
const COOLDOWN_MS = 30 * 60_000; // 同一个词 30 分钟内不重想
const DAY_MAX = 8;               // 一天最多几次（他点名的也算；只是防跑飞）
const DAY_MAX_AUTO = 2;          // 其中"她自己起的"最多 2 次（P0 还没接，先留着口子）
const KEEP_MS = 12 * 3_600_000;  // 12 小时内的同一个词算"接着上次想"

/** 浓度 → 多久不理会淡。索引就是 level。 */
const TTL = [20 * 60_000, 90 * 60_000, 6 * 3_600_000, 24 * 3_600_000];
const LEVEL_CN = ['L0 只有一个影子', 'L1 有形状了', 'L2 身上有感觉了', 'L3 活的'];

/** 她写的行首标签 → 感官通道。**只认标签，不解析正文**（正文是她自己的话，别去猜）。 */
const LABEL_SENSE = {
  看: 'see', 瞧: 'see', 瞅: 'see', 望: 'see', 看见: 'see', 看到: 'see', 视线: 'see',
  听: 'hear', 听见: 'hear', 听到: 'hear', 声: 'hear', 声音: 'hear', 动静: 'hear',
  闻: 'smell', 闻到: 'smell', 气味: 'smell', 味: 'taste', 味道: 'taste', 尝: 'taste',
  摸: 'touch', 触: 'touch', 手感: 'touch', 质地: 'touch',
  温度: 'temp', 冷: 'temp', 热: 'temp', 暖: 'temp', 凉: 'temp', 冰: 'temp', 烫: 'temp',
  身体: 'body', 身上: 'body', 手: 'body', 脚: 'body', 背: 'body', 皮肤: 'body',
  动作: 'move', 动: 'move', 姿势: 'move',
};

const MORE_RX = /^(还想看|再看|再想|继续|还要|嗯，?再看)$/u;
const ENOUGH_RX = /^(够了|就这样|行了|可以了|记住了|差不多)$/u;
const GIVEUP_RX = /^(算了|没想出来|不想了|不想想|没想清|想不出)$/u;
const KEEP_RX = /^(?:留|剩下|印象)[：:]\s*(.+)$/u;

/** 去掉标点空格，用来判"这一眼是不是在重复上一眼"。 */
function norm(text) {
  return String(text || '').replace(/[\s\p{P}]/gu, '').toLowerCase();
}

function cleanSeed(raw) {
  const s = String(raw || '')
    .replace(/^[「『"'（(【]+|[」』"'）)】]+$/gu, '')
    .replace(/\s+/g, '')
    .replace(/[，。,.!?！？、～~…:：；;]+$/gu, '')
    .trim();
  if (!s) return '';
  /**
   * 太虚的词不是"一个东西"，想它等于没想。她自己那句是"只有一个词的时候"，
   * 所以这里只收 **1~4 个字**，而且明确排掉"某个词/什么东西/一下"这类占位符 ——
   * 长到 6 个字的往往已经是一句描写（"猫趴在窗台上"），那就成"被喂画面"了。
   */
  if (s.length > 4) return '';
  if (/^(某个|什么|东西|事情|一下|那个|这个|它|随便)/u.test(s)) return '';
  // 「你想想怎么办」不是让她想一样东西，是问办法 —— 这类词不是种子
  if (/^(怎么办|怎么了|怎么|为什么|为啥|咋|啥|多少|哪|是否|要不要|能不能|可不可以)/u.test(s)) return '';
  if (/的时候$|时候$|时$/u.test(s)) return '';
  if (!/[\u4e00-\u9fa5a-zA-Z0-9]/u.test(s)) return '';
  return s;
}

/**
 * 解析"一眼"的输出。
 *
 * 她自己写的格式（`EYE_RULES` 教的）：
 *   看：窗台上趴着一团灰，背对着我
 *   ?：看不清眼睛
 *   改：尾巴刚才我记成白的了
 *   还想看 / 够了 / 算了
 */
function parseStep(text) {
  const out = { lines: [], unsure: [], revision: '', flow: '', impression: '' };
  for (const raw of String(text || '').split(/\r?\n/)) {
    const s = raw.trim().replace(/^[·\-*•>#\s]+/u, '').trim();
    if (!s) continue;
    if (MORE_RX.test(s)) { out.flow = 'more'; continue; }
    if (ENOUGH_RX.test(s)) { out.flow = 'enough'; continue; }
    if (GIVEUP_RX.test(s)) { out.flow = 'giveup'; continue; }
    const keep = KEEP_RX.exec(s);
    if (keep) { out.impression = keep[1].trim().slice(0, LINE_MAX); continue; }
    if (/^[?？]/.test(s)) {
      const t = s.replace(/^[?？][：:]?\s*/u, '').trim();
      if (t) out.unsure.push(t.slice(0, LINE_MAX));
      continue;
    }
    const m = /^([^\s：:]{1,3})[：:]\s*(.+)$/u.exec(s);
    if (!m) continue;
    const label = m[1].trim();
    const body = m[2].trim().slice(0, LINE_MAX);
    if (!body) continue;
    if (label.startsWith('改') || label.startsWith('不对') || label.startsWith('刚才')) {
      out.revision = (out.revision ? `${out.revision}；` : '') + body;
      continue;
    }
    const kind = LABEL_SENSE[label];
    if (!kind) continue;
    out.lines.push({ kind, label, text: body });
  }
  /**
   * 兜底：模型一个字都没按标签写（真机第一版就是这样，deepseek-chat 直接给一整句白描）。
   * 不扔 —— 一句白描同样是"这一眼多看见的一件东西"，收下它比收不到好。
   * 但仍**只收第一件**：一段话也只取第一句。
   */
  if (!out.lines.length && !out.flow && !out.unsure.length) {
    const fallback = firstClause(String(text || '').replace(/^[?？].*$/gmu, ''));
    if (fallback) out.lines.push({ kind: 'see', label: '看', text: fallback });
  }
  return out;
}

/**
 * 浓度：**代码算，不由她说**。
 *
 * ★ 2026-11-05 真机校准过一次：第一版要求"3 处 3 通道"，而 deepseek-chat 连看三眼
 * 全是"看："（橘猫、耳朵、鼻尖）—— **人的想象本来就有七八成是视觉**，
 * 拿通道数当硬门槛会把"她其实看得很细"判成 L0。改成：
 *
 *   · 主要看**添了几件**（这是"想得越细"最直接的量）；
 *   · 通道只是加分（凑到换别的感官才算立体）；
 *   · L3 仍然要**一次自我修正** —— 那是"回头再看"才会发生的事，一次看不出来。
 *
 * L3 故意要 6 处 + 3 通道 + 修正，而一次最多 3 眼，所以**最清楚的画面只有第二趟才到得了**。
 */
function score(rec) {
  const lines = Array.isArray(rec?.lines) ? rec.lines : [];
  const n = lines.length;
  const kinds = new Set(lines.map((l) => l.kind));
  const hasBody = lines.some((l) => l.kind === 'body' || l.kind === 'temp' || l.kind === 'touch');
  const rev = Number(rec?.revisions) || 0;
  if (n >= 6 && kinds.size >= 3 && rev >= 1) return 3;
  if (n >= 4 && (kinds.size >= 2 || hasBody)) return 2;
  if (n >= 2) return 1;
  return 0;
}

function ttlFor(level) {
  return TTL[Math.min(TTL.length - 1, Math.max(0, Number(level) || 0))];
}

/* ---------- 存储 ---------- */

function readLines() {
  try {
    return fs.readFileSync(FILE, 'utf8').trim().split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

function appendSnapshot(rec) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.appendFileSync(FILE, `${JSON.stringify(rec)}\n`, 'utf8');
  } catch (err) { log.warn(`想象：写不进 imagine.jsonl（${err.message}）`); }
}

const BLANK_STATE = { v: 1, day: { d: '', n: 0, auto: 0 }, cool: {}, open: [] };

function readState() {
  const raw = store.readJson(STATE);
  const st = raw && typeof raw === 'object' ? raw : {};
  return {
    v: 1,
    day: st.day && typeof st.day === 'object' ? st.day : { d: '', n: 0, auto: 0 },
    cool: st.cool && typeof st.cool === 'object' ? st.cool : {},
    open: Array.isArray(st.open) ? st.open.filter((r) => r && r.seed) : [],
  };
}

function writeState(st) {
  const err = store.writeJson(STATE, st);
  if (err) log.warn(`想象：状态写不进去（${err.message}）`);
}

function dayKey(at) {
  const d = new Date(Number(at) || Date.now());
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 过期的画面标成 `faded`，只留一句印象（别删 —— "就剩个尾巴尖"本身就是内容）。 */
function decay(rec, now = Date.now()) {
  // 定稿的（done）也会淡：看一眼就走开，过半天就只剩个印象 —— 人不也是这样
  if (!rec || (rec.status !== 'open' && rec.status !== 'done')) return rec;
  const at = Number(rec.at) || 0;
  if (!at) return rec;
  const lastAt = Number(rec.touchedAt) || at;
  if (now - lastAt <= ttlFor(rec.level)) return rec;
  rec.status = 'faded';
  if (!rec.impression) {
    const first = (rec.lines || [])[0];
    rec.impression = first ? `${first.label}：${first.text}`.slice(0, LINE_MAX) : '';
  }
  return rec;
}

/** 现在能用的画面（没淡、没放弃），顺手把过期的标掉。 */
function active(at = Date.now()) {
  const st = readState();
  let dirty = false;
  for (const rec of st.open) {
    const before = rec.status;
    decay(rec, at);
    if (rec.status !== before) dirty = true;
  }
  if (dirty) writeState(st);
  return st.open.filter((r) => r.status === 'open' || r.status === 'done').slice(-MAX_OPEN);
}

/* ---------- 触发 ---------- */

/**
 * 他是不是在**让她想**某样东西。
 *
 * ⚠️ 只认"对她说"的说法：`你想想猫` / `想象一下猫` / `脑补一个…`。
 * "当你内心想象某个词时"（他在讨论机制）**不算** —— 那是个元话题，别让功能自己撞上去。
 */
/** 有的客户端会把"昵称："拼进正文（真机：`✏️：想象一下你的小手`）。判之前先剥一层。 */
function bareOf(text) {
  return String(text || '').replace(/\s+/g, '').replace(/^[^\s：:]{1,8}[：:]/u, '');
}

function wantsCore(t) {
  if (!t) return false;
  if (/(别想|不用想|先别想|不想想)/u.test(t)) return false;
  /**
   * ⚠️ 排掉"在讨论这个功能"的话：`当你内心想象某个词时…` / `如果想象能随看法变动`。
   * 这些句子里也有"想象"，但它们不是在让她想 —— 放进来她会当场去想象一个"某个词"。
   */
  if (/(当你|如果你|要是你|怎么|如何|能不能|能否|可不可以)[^。！？\n]{0,10}(想象|想想|思考)/u.test(t)) return false;
  if (/(想象|想象能力|想象力)[^。！？\n]{0,8}(能力|功能|机制|实现|方案|这个想法)/u.test(t)) return false;
  /**
   * ★ 2026-11-05 真机补的：他第一次测试说的是「**试试想一下**冰箱里有什么」——
   * 原来只认"想想 / 想一想 / 想象"，`想一下` 一个都不认，于是那次**根本没走到这条路**
   * （她答得很生动，但那是她平时的本事，不是这个功能）。
   * 现在把"想一下 / 想一遍 / 想想看 / 试着想 / 闭上眼想 / 脑子里想"都收进来。
   */
  if (!WANT_RX.test(t)) return false;
  if (/^(想象|想想|想一想|脑补)/u.test(t)) return true;
  if (/(帮我|给我|来|快|试试|试着)[^。！？\n]{0,6}(想象|想想|想一想|脑补|想一下|想一遍)/u.test(t)) return true;
  // 「闭上眼想一下海」「脑子里想个雪夜」—— 这类说法本身就是"让她想"，不需要带"你"
  if (/(闭上眼(?:睛)?想|脑子里(?:想|过)|试着想|试试想)/u.test(t)) return true;
  return /你[^。！？\n]{0,8}?(想象|想想|想一想|脑补|想一下|想一遍|梦到|梦见|脑子里(?:想|过))/u.test(t);
}

function wants(text) {
  const raw = String(text || '').replace(/\s+/g, '');
  if (!raw) return false;
  if (wantsCore(raw)) return true;
  /**
   * ★ 2026-11-05 第二次真机：他发的是 **`✏️：想象一下你的小手`** —— 前缀把行首的
   * `^想象` 挡住了，于是"想象一下…"这种最标准的说法反而不认。
   * 入站那条路已经会剥昵称，但**触发层不该依赖上游干不干净**，所以这里再兜一层。
   */
  const bare = bareOf(raw);
  return bare !== raw && wantsCore(bare);
}

/** 所有"让她想"的说法（`wants` 和 `pickSeed` 共用，别让两处慢慢走散）。 */
const WANT_RX = /(想象|想想|想一想|想一下|想一遍|想想看|脑补|梦到|梦见|试着想|试试想|闭上眼(?:睛)?想|脑子里(?:想|过))/u;
/** 取词时要跳过的动词部分。 */
const SEED_RX = /(?:想象|想想看|想想|想一想|想一下|想一遍|脑补|试着想|试试想|闭上眼(?:睛)?想|脑子里想)(?:一下|下|一个|看)?[，,：:]?([^\s，。,.!?！？、～~]{1,10})/u;

/** 从他的话里抠出**一个词**。抠不出干净的词就返回空串 —— 宁可不做，别拿半句话当种子。 */
function pickSeed(text) {
  /**
   * ⚠️ 先把"想象力 / 想象能力"这种**名词**抹掉再找动词。
   * 真机踩过：他说「…多了一些**想象力**，试试想一下冰箱里有什么」，
   * 第一版抠出来的是「力」——因为它匹配到了"想象"这个名词里的两个字，还当真想了一遍"力"。
   */
  const t = bareOf(String(text || '')).replace(/想象(能力|力)/gu, '');
  const m = SEED_RX.exec(t);
  if (!m) return '';
  let seed = m[1];
  /**
   * 「想象一下**你的**房间」→ 那是个"谁的"，不是东西本身。
   * 「冰箱**里**有什么」→ 取"冰箱"（下面的后缀表会砍掉"里有什么"）。
   * 「猫趴在窗台上」→ 取"猫"。
   */
  seed = seed.replace(/^(你的|我的|他的|她的|它的)/u, '');
  // 「一只猫」「一个房间」→ 去掉数量词，剩下的才是那个东西
  seed = seed.replace(/^[一二三四五六七八九十几这那]?(只|个|条|颗|片|场|把|张|朵|棵|座|辆|间|台|杯|碗)/u, '');
  seed = seed.replace(/(里面|里边|里|上面|上边|上|下面|下边|下|中间|中|旁边|周围|外面|外|有什么|是啥|什么样).*$/u, '');
  seed = seed.replace(/(趴在|在|的|和|跟|被|把|从|往|着|了|过).*$/u, '');
  return cleanSeed(seed);
}

/* ---------- 一眼的 prompt ---------- */

/**
 * ⚠️ 这份 prompt 里**不许出现任何关于那个东西的描述**。
 * 第 2 条（只添一件）和第 3 条（不许形容词堆）是它跟"被喂画面"的分界线；
 * 第 4 条（`?`）让"想不清楚"也合法 —— 人想象的时候本来就有大片空白。
 */
const EYE_RULES = `你在心里想一样东西。你没有真的看见它，身边也没有它 —— 你只是在脑子里把它拼出来。

输出**最多四行**，每行开头是一个标签：
看：…        （你看见的，20 字以内）
听：…        （你听见的）
闻：… / 摸：… / 温度：…
?：…         （想不清的地方，不许圆）
最后一行**只写一个词**，不加标签：还想看 / 够了 / 算了

规则：
1. 起点只有一个词。没有人告诉你它长什么样，你也不去问。
2. 这一眼**只添一件**：一样具体的、能指出来在哪儿 / 什么颜色 / 什么声音 / 什么温度的东西。
3. 不要形容词堆（"温暖的""柔软的""美好的"），不要写成段落，不要解释，不要问我。
4. 同一件事看几眼：这一眼写的东西必须和上一眼**还是同一个**，别换到旁边的另一只、另一处。
5. 这一眼和刚才对不上，就写一行 改：… 说清哪儿不对。
6. 还想看 = 再添一件；够了 = 就这样，我记着了；算了 = 没想出来，不想了。

例子（她想的是一样别的东西，**只学形状，别抄内容**）：
听：棚子上噼里啪啦，一阵一阵的
?：看不清屋檐底下有没有人
还想看`;

/** 模型不老实写标签时的兜底：第一句当"看"（少了标签，但不能一句都收不到）。 */
function firstClause(text) {
  const s = String(text || '').replace(/^[·\-*•>#\s]+/u, '')
    .replace(/^(?:我|她)?(?:看见|看到|看见的是|注意到)[：:]?/u, '');
  const cut = s.split(/[。！？!?；;\n]/u).map((x) => x.trim()).find((x) => x && !/^(还想看|够了|算了)$/u.test(x));
  return (cut || '').slice(0, LINE_MAX);
}

/** 角色卡只取前两块（你是谁 + 你的日子）—— 这一趟要的是她的眼睛，不是全套设定。 */
function roleBrief(roleText) {
  const blocks = String(roleText || '').split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
  return (blocks.length ? blocks.slice(0, 2).join('\n\n') : '').slice(0, 520);
}

/** 还空着的通道（用来提醒"这一眼换个地方看"，不给她任何内容）。 */
const SENSE_CN = { see: '看', hear: '听', smell: '闻', touch: '摸', temp: '温度', taste: '味道', body: '身体', move: '动作' };
function nextSense(rec) {
  const used = new Set((rec?.lines || []).map((l) => l.kind));
  for (const k of ['hear', 'touch', 'temp', 'smell', 'body', 'move', 'see']) {
    if (!used.has(k)) return SENSE_CN[k];
  }
  return '';
}

function buildEyeMessages({ seed, rec, lens = [], roleText = '' } = {}) {
  const parts = [roleBrief(roleText)];
  if (lens.length) {
    parts.push(`【你看东西的角度】（这是你自己的账，不是规定；别照着它凑，只是你眼睛会往这些地方偏）
${lens.map((c) => `- ${c}`).join('\n')}`);
  }
  parts.push(EYE_RULES);
  const prev = (rec?.lines || []).map((l) => `${l.label}：${l.text}`).join('\n');
  const unsure = (rec?.unsure || []).length ? `还空着：${rec.unsure.join('、')}` : '';
  /**
   * ★ 2026-11-05 真机：连看三眼全是"看：…"，于是浓度表永远上不去。
   * 这里只提醒**换个通道**（听/摸/温度/闻），**不给任何内容** —— 提醒的是"往哪儿看"，不是"看见什么"。
   */
  const tip = (rec?.lines || []).length >= 2 ? `\n这一眼换个地方试试：${nextSense(rec)}。` : '';
  const body = prev
    ? `（你闭上眼。脑子里只有「${seed}」。\n你刚才已经想到的：\n${prev}\n${unsure}${tip}\n这一眼，只添一件。）`
    : `（你闭上眼。脑子里只有「${seed}」。这一眼，你只添一件。）`;
  return [
    { role: 'system', content: parts.filter(Boolean).join('\n\n') },
    { role: 'user', content: body },
  ];
}

/* ---------- 跑一次 ---------- */

/**
 * 跑一次想象。
 *
 * @param {object} opts
 * @param {string} opts.seed        起手的那个词（`pickSeed` 抠出来的）
 * @param {Function} opts.callModel `(messages, {temperature,maxTokens,thinking}) => {text, raw}` —— 由调用方注入
 * @param {string} [opts.roleText]  角色卡（只取前两块）
 * @param {string[]} [opts.lens]    她自己账里的两三句（"看东西的角度"）
 * @param {string} [opts.where]     发生在哪（只记账用）
 * @param {number} [opts.at]
 * @param {number} [opts.maxEyes=2] 这一趟最多看几眼（同步那一路 2 眼 ≈ 3 秒）
 * @param {string} [opts.tier]      `'ask'`（他点名，P0 只有这一种）/ `'auto'`（她自己起的）
 * @returns {Promise<{ok:boolean, why?:string, rec?:object, eyes?:number}>}
 */
async function run({
  seed: rawSeed, callModel, roleText = '', lens = [], where = '', at = Date.now(),
  maxEyes = 2, tier = 'ask', force = false,
} = {}) {
  const seed = cleanSeed(rawSeed);
  if (!seed) return { ok: false, why: 'no-seed' };
  if (typeof callModel !== 'function') return { ok: false, why: 'no-model' };

  const st = readState();
  // 冷却（窗口里她点了「再想一个」时传 force：那是人明确要的，不是她自发的碎碎念）
  const lastCool = Number(st.cool[seed]) || 0;
  if (!force && lastCool && at - lastCool < COOLDOWN_MS) return { ok: false, why: 'cool' };
  // 一天的上限（他点名也算，只是防跑飞）
  const dk = dayKey(at);
  if (st.day.d !== dk) st.day = { d: dk, n: 0, auto: 0 };
  if (st.day.n >= DAY_MAX) return { ok: false, why: 'day-max' };
  if (tier === 'auto' && (Number(st.day.auto) || 0) >= DAY_MAX_AUTO) return { ok: false, why: 'auto-max' };

  /**
   * 接着上次想（12 小时内、同一个词、还没淡）。
   * ⚠️ `done` 也要能接：「够了」= 这一眼看完了，不是"以后不许再看"；
   * 他过一会儿说「再看一眼那个猫」，人心里那张画还是原来那张。
   */
  let rec = st.open.find((r) => r.seed === seed
    && (r.status === 'open' || r.status === 'done')
    && at - (Number(r.at) || 0) < KEEP_MS);
  if (!rec) {
    rec = {
      v: 1,
      id: `im-${at.toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      seed,
      at,
      where: String(where || '').slice(0, 48),
      lines: [],
      unsure: [],
      revisions: 0,
      status: 'open',
      level: 0,
      eyes: 0,
      impression: '',
      lens: { at, ids: [], n: 0 },
      cost: { calls: 0, tokens: 0 },
      tier,
    };
    st.open.push(rec);
    while (st.open.length > MAX_OPEN) {
      // 先挤掉最旧的（它已经进 jsonl 了，不算丢）
      st.open.shift();
    }
  }

  let eyes = 0;
  let failed = '';
  const started = Date.now();
  const eyeCap = Math.max(1, Math.min(MAX_EYES_RUN, Number(maxEyes) || 2));
  try {
    while (eyes < eyeCap && rec.eyes < MAX_EYES_TOTAL && rec.lines.length < MAX_LINES) {
      const messages = buildEyeMessages({ seed, rec, lens, roleText });
      let out;
      try {
        out = await callModel(messages, { temperature: 1.15, maxTokens: 120, thinking: { type: 'disabled' } });
      } catch (err) {
        failed = err.message || '模型没回';
        break;
      }
      eyes += 1;
      rec.eyes = (Number(rec.eyes) || 0) + 1;
      rec.cost.calls = (Number(rec.cost.calls) || 0) + 1;
      const usage = out?.raw?.usage;
      if (usage) rec.cost.tokens = (Number(rec.cost.tokens) || 0) + (Number(usage.prompt_tokens) || 0) + (Number(usage.completion_tokens) || 0);

      const step = parseStep(out?.text);
      // 想不出来是**合法结果**：不写 lines、不报错
      if (step.flow === 'giveup') {
        rec.status = 'gaveup';
        if (!rec.lines.length) rec.impression = '';
        break;
      }
      // ⚠️ 一眼只收一件：模型一次写五行也只收第一件（防"她一次堆一段描写"）
      const firstNew = step.lines.find((l) => !rec.lines.some((old) => {
        const a = norm(old.text);
        const b = norm(l.text);
        return a === b || (a.length >= 4 && b.length >= 4 && (a.includes(b) || b.includes(a)));
      }));
      if (firstNew) rec.lines.push({ ...firstNew, at });
      if (step.revision) rec.revisions = (Number(rec.revisions) || 0) + 1;
      for (const u of step.unsure) {
        if (!rec.unsure.includes(u) && rec.unsure.length < 4) rec.unsure.push(u);
      }
      if (step.impression) rec.impression = step.impression;
      if (step.flow === 'enough') { rec.status = 'done'; break; }
    }
  } finally {
    rec.level = score(rec);
    rec.touchedAt = at;
    /**
     * ⚠️ **眼数用完不算"想完了"**：`status` 留在 `open`，隔一会儿/隔天还能接着看
     * （L3 就要求跨时段：一次最多 3 眼，5 处细节 + 一次自我修正只有第二趟才够）。
     * 只有她自己说 `够了` 才是 `done`。
     */
    const empty = !!failed && !rec.lines.length;
    if (!empty) {
      st.day.n = (Number(st.day.n) || 0) + 1;
      if (tier === 'auto') st.day.auto = (Number(st.day.auto) || 0) + 1;
      st.cool[seed] = at;
    }
    writeState(st);
    if (!empty) appendSnapshot(rec);
  }

  if (failed && !rec.lines.length) return { ok: false, why: failed };
  return { ok: true, rec, eyes, failed: failed || undefined, ms: Date.now() - started };
}

/**
 * 给这一轮的 system 用的那几行。
 *
 * ⚠️ 措辞里那句"是你自己想出来的，不是真发生过的"是**硬要求**：
 * 想象膨胀（imagination inflation）的文献说得很清楚，反复想象会让人相信它发生过，
 * 而她的"记忆"就是文件，她会比人更容易信。这句就是她的来源监测。
 */
function brief(rec) {
  if (!rec || !rec.seed) return '';
  const parts = [rec.seed];
  for (const l of (rec.lines || []).slice(0, 4)) parts.push(`${l.label}：${l.text}`);
  if ((rec.unsure || []).length) parts.push(`还空着：${rec.unsure.slice(0, 2).join('、')}`);
  if (rec.impression) parts.push(`留下的是：${rec.impression}`);
  parts.push(`清楚到什么程度：${LEVEL_CN[Math.min(3, Number(rec.level) || 0)]}`);
  return parts.join(' ｜ ').slice(0, 240);
}

function forget() {
  for (const f of [FILE, STATE]) {
    try { fs.unlinkSync(f); } catch { /* 本来就没有 */ }
  }
  return true;
}

/**
 * 删掉一个画面（窗口里的 ×）。**不复用 `status` 的语义**：`dropped` = 她自己/他不想留了，
 * 和 `faded`（淡了）不是一回事，但都不再注入。
 */
function drop(id, why = 'window') {
  const key = String(id || '');
  if (!key) return { ok: false, why: 'no-id' };
  const st = readState();
  const rec = st.open.find((r) => r.id === key);
  if (!rec) return { ok: false, why: 'not-found' };
  rec.status = 'dropped';
  rec.dropWhy = String(why || '').slice(0, 40);
  writeState(st);
  appendSnapshot(rec);
  return { ok: true, id: key };
}

/**
 * 窗口要的一屏：**开着的**（没淡、没删）+ **最近的**（同一个 id 只留最后一版快照，按时间倒序）。
 *
 * ⚠️ `imagine.jsonl` 是**快照流**（同一个 id 会写很多行），所以这里必须按 id 折叠 ——
 * 否则窗口里同一张画面会出现四五次。
 */
function view({ recent = 12 } = {}) {
  const briefOf = (r) => ({
    id: r.id, seed: r.seed, level: r.level, status: r.status,
    text: LEVEL_CN[Math.min(3, Number(r.level) || 0)],
    lines: (r.lines || []).map((l) => ({ label: l.label, text: l.text })),
    unsure: r.unsure || [], impression: r.impression || '',
    at: r.at, touchedAt: r.touchedAt || r.at,
    eyes: Number(r.eyes) || 0, revisions: Number(r.revisions) || 0,
  });
  const act = active();
  const openIds = new Set(act.map((r) => r.id));
  const byId = new Map();
  for (const r of readLines()) {
    if (!r || !r.id) continue;
    const old = byId.get(r.id);
    if (!old || (Number(r.touchedAt) || Number(r.at) || 0) >= (Number(old.touchedAt) || Number(old.at) || 0)) {
      byId.set(r.id, r);
    }
  }
  const recentList = [...byId.values()]
    .filter((r) => !openIds.has(r.id))
    .sort((a, b) => (Number(b.touchedAt) || Number(b.at) || 0) - (Number(a.touchedAt) || Number(a.at) || 0))
    .slice(0, Math.max(1, Number(recent) || 12));
  const day = readState().day;
  return {
    active: act.map(briefOf),
    recent: recentList.map(briefOf),
    day: { d: day.d, n: Number(day.n) || 0 },
    totalToday: Number(day.n) || 0,
  };
}

module.exports = {
  FILE, STATE, TTL, LEVEL_CN, MAX_EYES_RUN, MAX_EYES_TOTAL, DAY_MAX, COOLDOWN_MS,
  norm, cleanSeed, parseStep, score, decay, active, wants, pickSeed,
  buildEyeMessages, run, brief, drop, forget, view, readLines, readState,
};
