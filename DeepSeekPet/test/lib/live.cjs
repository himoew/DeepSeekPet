/**
 * 「真连一遍」那 7 个区域**共用的一条连接 + 全套 helper**（2026-10-11 从 `regions\05-live.cjs` 抽出来）。
 *
 * **为什么需要它**：第 5 / 4c / 4d / 5b / 5b-2 / 5b-3 / 5c 这七节原来串在一个 `run()` 里，
 * 共用同一条 WebSocket 与同一批局部变量（`ws` / `fromPet` / `init` / `waitFor` / `nextReply` /
 * `drain` / `touchSay` …）。把它们切成"一个区域一个文件"之后，那些名字必须有个落脚处 ——
 * 就是这里；而且**照样挂成全局**（跟骨架把 `fs` / `path` / `ok` 挂全局是同一个套路），
 * 于是各区域文件里的正文**一个字都不用改**。
 *
 * **两种跑法都对**：
 *   · 全量跑（`node test\smoke.cjs`）：第一个用到它的区域负责连上，后面的区域**复用同一条**连接、
 *     同一个 `fromPet` —— 与拆分前完全一致（顺序也没变）；
 *   · 单跑一个 live 区域（`node test\run-one.cjs 05e-areas.cjs`）：`ensure()` 发现还没连过，
 *     就自己连、自己等 init，所以那条路也能单独跑。
 *
 * **注意 `ws` / `fromPet` 是可以被赋值的**（第 4d 节会 `ws.close()` 之后**换一条新连接**、
 * `fromPet = []`），所以全局上装的是 getter/setter 对，写进去的是这里的 `state`。
 */
const state = { ws: null, fromPet: [], init: null, opened: false };
/** 骨架的 ctx（`install()` 时存进来：连接与 helper 要用它的 WebSocket / port / lines / textsOf）。 */
let C = null;

/* ---------- 连接：原来在 `05-live.cjs` 第 15~18 行与第 131~133 行 ---------- */

/**
 * 连上（只连一次）：建 ws → 收消息进 `state.fromPet` → 等 `open` → 抓下 init。
 * `at` 记下收到的时刻，用来断言"两个气泡之间隔了多久"。
 */
async function ensure(ctx) {
  if (ctx) C = ctx;
  if (state.opened) return state;
  state.opened = true;
  state.fromPet = [];
  state.ws = new (C.WebSocket)(`ws://127.0.0.1:${C.port}/socket?role=pet&host=window`);
  state.ws.on('message', (raw) => state.fromPet.push(Object.assign(JSON.parse(raw.toString()), { at: Date.now() })));
  await new Promise((resolve, reject) => { state.ws.on('open', resolve); state.ws.on('error', reject); });
  state.init = await waitFor('init', () => state.fromPet.find((m) => m.t === 'init'));
  return state;
}

/** 收干净：全量跑与单跑都由骨架在 finally 里调。 */
function close() {
  try { state.ws?.close(); } catch { /* 没连上就没什么可关的 */ }
}

/* ---------- helper：以下到 `touchSay` 为止，全部照抄 `05-live.cjs` 第 19~129 行 ---------- */

/**
 * 等一条消息。失败时报出**收到了什么**，而且说得尽量细：
 * 气泡要带上它的 `kind` / `tag` / 文本 / 相对第一条消息的毫秒数 ——
 * "等不到"这种红最难查的就是"到底是谁先冒出来把它挡了"，
 * 而 `tag` 正好能一眼看出是不是计时器自己开的口（见下面 isSelfTalk）。
 */
const waitFor = (what, pick, ms = 6000) => new Promise((resolve, reject) => {
  const deadline = Date.now() + ms;
  const t0 = state.fromPet[0]?.at || Date.now();
  const dump = () => state.fromPet.map((m) => {
    const dt = `+${(m.at || Date.now()) - t0}ms`;
    if (m.t !== 'say') return `${m.t}@${dt}`;
    const text = (m.beats || []).map((b) => b.text).join('+');
    return `say@${dt}{kind=${m.kind},tag=${m.tag || '-'}}:${text}`;
  }).join(' | ');
  const tick = () => {
    const hit = pick();
    if (hit) return resolve(hit);
    if (Date.now() > deadline) return reject(new Error(`等不到 ${what}（收到 ${dump()}）`));
    setTimeout(tick, 20);
  };
  tick();
});
const says = () => state.fromPet.filter((m) => m.t === 'say');
/**
 * 数气泡时**要排掉它自己主动说的那些话**（发呆 / 犯困 / 记忆话）：它们由 `fidget`
 * 定时器冒出来，跟被测的那条路（自动说话 / 静默期 / 连点合并…）毫无关系。
 *
 * 不排掉的话，**任何"等 N 秒、数气泡"的断言都会随机红一次**：`IDLE_MIN_MS` 是 35 秒起，
 * 而整轮自检要跑几分钟，总有几秒会撞上它。实测撞过好几次：
 * 「要是能出去走走就好了。」·「早上还是有点困……」（第 1.15 节加的按时段发呆话）·
 * 记忆话（第 1.16 节加的）——**每加一批"它自己会开口"的台词，这里就要跟着加一批**，
 * 否则自检就会变成随机红。**排的时候按"模板渲染后"排**（见下面 templateRe），
 * 拿模板字面量去比是排不掉的 —— 这个坑让上一轮自检卡了很久。
 * 交接文档第 1.10 / 1.11 节记的就是这个，
 * **修这里，别去动 `pet.cjs` 的定时器逻辑** —— 那正是第 1.8 节 ④
 * "自检写错了却去改产品代码"的教训。
 *
 * ⚠️ **别把 `lines.llmFailed` 也塞进来**：那句是"模型挂了"这条被测路径的**应答**，
 * 自检里专门有一条断言它（第 5 节「模型出错时退回内置台词」）。把它当成自说自话排掉，
 * 那条断言就永远等不到气泡 —— 实测踩过（`等不到 下一个气泡（收到 thinking,thinking,say）`）。
 * 只有"定时器自己冒出来的话"才是自说自话：发呆 / 犯困 / 记忆。
 */
const SELF_TALK_TAGS = new Set(['idle', 'drowsy', 'memory']);
const SELF_TALK = () => [
  C.lines.idle, C.lines.drowsy,
  ...Object.values(C.lines.idleByTime || {}),
  ...Object.values(C.lines.drowsyByTime || {}),
  C.lines.memoryWords, C.lines.memoryArea, C.lines.memoryHour,
  C.lines.memoryMilestone, C.lines.memoryAway,
];
/**
 * 文本兜底：台词库里存的是**模板**（`我还记得你说「{words}」呢。`），气泡里是**渲染后**的
 * 文本（`我还记得你说「慢慢来」呢。`）—— 直接比字符串一条都排不掉，实测就是这里把
 * 「抓放的气泡都是抓/放的台词」弄红的（那句记忆话被当成抓放的回话）。
 * 所以按模板把每个 `{占位符}` 编译成通配，模板没变的（发呆/犯困话）走原样包含。
 * （主判据已经是 `say.tag`，这里是"万一是老协议/新加的定时器台词"时的第二道网。）
 */
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const templateRe = (text) => new RegExp('^' + escapeRe(text).replace(/\\\{[a-zA-Z]+\\\}/g, '.*') + '$');
let SELF_RE = null;                       // 惰性算一次（要用到 lines，得等 install 之后）
const selfRe = () => (SELF_RE || (SELF_RE = C.textsOf(...SELF_TALK().filter(Boolean)).map(templateRe)));
/**
 * 这句话是不是"它自己冒出来的"（不是对我这次操作的应答）。
 *
 * **主判据是 `say.tag`**（`idle` / `drowsy` / `memory`）—— 那是应答链里本来就有的出处标记，
 * 比文本可靠：台词带 `{words}`/`{area}`/`{hour}` 时气泡里是渲染后的文本，文本比对排不掉。
 * 文本那套留着当兜底（老协议没有 tag 时仍然能排掉大部分），两条都命中才算。
 */
const isSelfTalk = (m) => SELF_TALK_TAGS.has(m.tag) || selfRe().some((re) => re.test(m.beats[0].text));
const ownSays = () => says().filter((m) => !isSelfTalk(m));
/** 断言信息里带上"收到的是哪几句"，下次红了能一眼看清是谁冒出来的。 */
const ownTexts = () => ownSays().map((s) => s.beats.map((b) => b.text).join('+')).join(' | ');
/**
 * 等到"下一个气泡"，但**只认它对我的操作做出的回话**（`ownSays`）。
 *
 * 为什么不能拿 `says()` 直接数：发呆/犯困/记忆话跟被测的那条路无关，却会**抢在**
 * 我这句回话前面冒出来（实测：「戳头说的是『头』那一桶」那次被一句记忆话
 * `我还记得你说「慢慢来」呢。` 抢走，报"等不到 这一下的回话"）。
 * 排空之后从零开始等，所以不用记下标。
 */
const nextSay = (ms = 6000) => waitFor('下一个气泡', () => ownSays()[0], ms);
/**
 * 只等**某个出处**的那条回话（`say.tag`）。
 *
 * 为什么需要它：`nextSay` 认的是"第一条不是自说自话的气泡"，而**上一节排队的回答**
 * 可能这一秒才轮到（应答链一条气泡要占 0.8~2 秒），于是它被当成这一节的回话，
 * 断言就红了（实测：「模型出错时退回内置台词」那次收到的是上一节 `tag=answer` 的
 * 模型回答，而断言在等 `llmFailed`）。按 tag 等就完全没有这个歧义。
 */
const nextReply = (tag, ms = 8000) => waitFor(`tag=${tag} 的回话`, () => says().find((m) => m.tag === tag), ms);
/**
 * 等到"没有新消息进来"再往下走，然后清空 `fromPet`。
 *
 * 为什么需要它：**语音合成要 2~3 秒**，上一节排出去的那条回复可能还在路上，
 * 于是它会落进下一节那段"固定等 N 秒、数气泡"的窗口里，把断言弄红。
 * 实测（女声换好之后）"念提示词的句子不冒泡"和"第二下升到又戳"就这样间歇性失败过。
 * 与其把窗口调得更长，不如在开始计数前**先排空**：这才是"只数这一节的东西"。
 */
const drain = async (quietMs = 1200, maxMs = 20000) => {
  const deadline = Date.now() + maxMs;
  let last = state.fromPet.length, lastChange = Date.now();
  for (;;) {
    await new Promise((r) => setTimeout(r, 300));
    if (state.fromPet.length !== last) { last = state.fromPet.length; lastChange = Date.now(); }
    if (Date.now() - lastChange >= quietMs) break;
    if (Date.now() > deadline) break;      // 一直有动静就别死等，交给断言去报
  }
  state.fromPet.length = 0;
};

/* ---------- 操作类 helper：原来写在 `05-live.cjs` 第 376~384 行（5b 那一节的开头） ---------- */

/**
 * 发一次操作，等它**这个操作**的回话（`say.tag` 就是操作名：`poke` / `pet` / `grab` …）。
 *
 * 为什么按 tag 等，而不是"等下一个气泡"：这条路上有两件跟被测无关的事会抢位 ——
 * ① 计时器自己冒的发呆/记忆话；② **上一节排队的回答**（应答链一条气泡要占 0.8~2 秒，
 * 上一节问的那句话可能这一秒才轮到）。实测这两种都让"回的是哪一桶台词"随机红过。
 *
 * ★ **被自说自话插队时重发一次**（2026-10-11 复核补）：还有第三种抢位 ——
 * 一句 `tag=memory` 的记忆话正好插在这一下前面，产品会把**排队的那条回话判过期丢掉**
 * （真机日志：`「别揉我头发——刚梳好的!」等太久（3596ms），不说了`），于是这一下**永远等不到**。
 * 实测复核时第一次全量跑就红在 5b-2 的"再戳回头发"，而未改动的原文存档同机跑是绿的 ——
 * 说明这是**计时竞态**，不是被测逻辑坏了。所以这里重发一次（跟真人测试时"再点一下"一样），
 * 两次都等不到才让它红。**不碰产品代码**（第 1.8 节 ④ 的教训）。
 */
const touchSay = async (kind, extra = {}) => {
  try {
    state.fromPet.length = 0;
    state.ws.send(JSON.stringify({ t: 'touch', kind, ...extra }));
    return await nextReply(kind, 8000);
  } catch (err) {
    console.log(`      （${kind} 的回话被自说自话插队/丢掉了，重发一次）`);
    await drain(800, 8000);
    state.fromPet.length = 0;
    state.ws.send(JSON.stringify({ t: 'touch', kind, ...extra }));
    return nextReply(kind, 8000);
  }
};
/** 同一个东西的另一个名字（5b-2 / 5b-3 里读起来更顺）。 */
const touchOwnSay = touchSay;

/* ---------- 挂成全局（跟骨架挂 fs / path / ok 一个套路，区域正文不用改） ---------- */

const HELPERS = { waitFor, says, isSelfTalk, ownSays, ownTexts, nextSay, nextReply, drain, touchSay, touchOwnSay };

function install(ctx) {
  C = ctx;
  // 可读可写：第 4d 节会 `ws.close()` 后换一条新连接、`fromPet = []`，所以是 getter/setter
  for (const [name, key] of [['ws', 'ws'], ['fromPet', 'fromPet'], ['init', 'init']]) {
    Object.defineProperty(globalThis, name, {
      get: () => state[key],
      set: (v) => { state[key] = v; },
      configurable: true,
    });
  }
  Object.assign(globalThis, HELPERS);
  return API;
}

/** 给骨架用的门面：`ctx.live`。 */
const API = {
  ensure: (ctx) => ensure(ctx),
  close,
  get state() { return state; },
};

module.exports = { install, ensure, close, state };
