/**
 * The pet page. Connects to the World over `/socket?role=pet`, runs the body from pet-core,
 * and turns World orders (say, ask, walk, act, listen, and the steps of an app's conversation)
 * into bubbles and motion. It reports back only what happened on screen: arrivals, answers,
 * touches, typed text, and 16 kHz microphone audio while voice input is on.
 *
 * In the pet window (`window.petHost` from the preload) the page is transparent and the
 * window ignores the mouse except over the figure, a bubble, the menu or the hover buttons.
 * Colors follow the World's `theme` through `data-theme` on the root element.
 */
import { boot, report } from './diag.js';
import { createBall } from './ball.js';
import { createGame } from './game.js';
import { applyTheme, createPet, createSfx, clamp, f, mini, normalizeSkin, skinCss, EXPRESSIONS, HEAD_TOP, ICONS } from './pet-core.js';

const $ = (s) => document.querySelector(s);
const host = window.petHost || null;
// 走到这一步就说明模块加载完成了（`diag.js` 在它自己的首个 import 位置就装上了错误监听）
boot(`pet-app 模块已加载 · host=${host ? 'window' : 'tab'}`);
document.body.classList.add(host ? 'desk' : 'tab');

const stage = $('#stage');
const bubble = $('#bubble'), heardEl = $('#heard'), trail = $('#trail'), menu = $('#menu');
const tools = $('#tools');
const skinStyle = document.createElement('style');
document.head.appendChild(skinStyle);

const prefs = {
  roam: 'calm', sound: true, theme: document.documentElement.dataset.theme, scale: 1, mic: false, micDevice: '', bot: null,
  /** 心情快照（World 发过来的 `{ state, label, speed, cling }`）；页面只拿它调步调。 */
  mood: null,
  /** Voice input: switched on, recognizer ready, why not, how to talk, and the mode in force. */
  voice: { enabled: false, ready: false, detail: null, hint: '', mode: 'hold' },
  /**
   * The actions shown as buttons beside the pet on hover. The World's `init`/`prefs` sends the
   * real list (`INIT.hoverButtons` in pet.cjs, now just `['chat']` — every other action lives in
   * the right-click menu, so the two never show the same thing twice); this is only the fallback
   * for the moment before that first message.
   */
  hoverButtons: ['chat'],
  rememberPosition: false,
  /** Draw at the moving frame rate while the body rests too. */
  lockFrameRate: false,
  /** The World lets the model speak on its own every minute (`auto`); this is the switch it reports. */
  autoChat: false,
  /**
   * Whether the World reads the model's answers out loud. It knows if the speech files are installed,
   * so it reports both: `ttsOn` (possible) and `sayVoice` (wanted). The sound button is a three-way
   * switch built on the two — off / effects only / effects + speech. (The mic's own `voice` pref is
   * a different thing; this one is called `sayVoice` to stay out of its way.)
   */
  ttsOn: false, sayVoice: false,
  /** 玩具球/游戏模式的三态：`off` 关 · `ball` 出球自由玩 · `game` 弹弹乐。 */
  ballMode: 'off', ballModeKnown: false,
};
const sfx = createSfx();
if (host) sfx.unlock();
else ['pointerdown', 'keydown'].forEach((ev) => document.addEventListener(ev, () => sfx.unlock(), { capture: true }));

/* ---------- the pet's own voice: speech the World synthesized on this machine ---------- */
/**
 * 语音**和打字同时进行**，不再互相等。
 *
 * 为什么改成并行：合成一句要 2~8 秒（fanchen-c 这种模型 RTF > 1，生成一句比说完它还慢），
 * 原来的规矩是"先把这一句念完再开始打字"，于是那几秒里屏幕上**一个字都没有**，
 * 主观上就是"卡住了"。现在文字立刻出来，声音随后跟上。
 *
 * 代价是声音会比字晚半拍到几秒（不再逐字对齐），换来的是**感知延迟从 4~6 秒降到约 2 秒**
 * ——那 2 秒只剩模型回复的时间，合成再慢也被藏起来了。
 *
 * 一个 `voice` 指令带音频就放，不带 `wav` 就是"这句没有声音"（跳过）。
 * 音频到得比气泡早也没关系：先存着，气泡一出现就放（见 stepDialog / onVoice）。
 */
const sayAudio = {
  /** 等着放的那一句（或正在放的那一句）。 */
  next: null, playing: null,
  /** 这条气泡的音频是否已经开播过（避免同一句重复放）。 */
  played: false,
};

/**
 * 带语音的气泡：弹出之后**故意先不打字**，等这么久再开始（秒）。
 *
 * 为什么：合成要 3~5 秒，文字不等它的话会先打完、声音才追上来，差得有点多。
 * 给 0.5 秒既能让语音抢到一点点先手（听起来更像"在说话"），
 * 又不会让人干等（气泡这一刻就已经弹出来了，不是空白）。
 * 想更贴近语音就把这个数加大；想文字更快就减小。
 */
const VOICE_LEAD = 0.5;

/** Takes one `voice` order: queues its audio, or starts it if the bubble is already typing. */
async function onVoice(m) {
  if (!m.wav) return;                     // 这句没有声音
  if (!prefs.sayVoice) return;
  try {
    const bin = atob(m.wav);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    const buf = await sfx.decode(bytes.buffer);
    if (!buf) return;
    // 气泡已经在打字了（音频来晚了）→ 立刻放，不等
    if (item?.kind === 'say' && item.started && !sayAudio.played && !sayAudio.playing) {
      sayAudio.played = true;
      sayVoicePlay(buf);
      return;
    }
    sayAudio.next = buf;                   // 气泡还没到（音频来早了）→ 存着等它
  } catch (err) {
    console.error(err);
  }
}

/** Plays one utterance; resolves when it has finished. Never blocks the typing. */
async function sayVoicePlay(buf) {
  if (!buf) return;
  const done = sfx.playBuffer(buf).catch(() => {});
  sayAudio.playing = done;
  try { await done; } finally { sayAudio.playing = null; }
}

/** One of the sound button's three steps: `off` · `sfx` · `voice`. */
function applySoundMode(mode) {
  prefs.sound = mode !== 'off';
  prefs.sayVoice = mode === 'voice';
  sfx.set(prefs.sound);
  if (!prefs.sayVoice) sayAudio.next = null;    // 关掉就把还没放的丢掉
}

/** 这条气泡的语音已经播过了吗（同一条气泡只播一次）。 */
function sayAudioStarted() {
  return sayAudio.played;
}
/** 开一条新气泡时重置（见 openBubble）。 */
function sayAudioReset() {
  sayAudio.played = false;
}

/** When the last "round" of chatter was reported to the World (see `roundOver`). */
const said = { round: 0 };

const floorGap = () => (host ? 2 : 48);
const ctl = createPet(
  { petG: $('#pet'), shadowEl: $('#shadow'), fxG: $('#fx') },
  {
    sfx,
    roam: prefs.roam,
    bounds: () => ({ W: innerWidth, H: innerHeight, floorY: innerHeight - floorGap(), S: .42 * prefs.scale }),
    onEvent: (kind, d) => onBody(kind, d),
    dialogOpen: () => !!item || !!listen.phase,
    enter: 'drop',
  },
);
addEventListener('resize', () => {
  ctl.resize();
  // the World reads walk targets and drop spots against the stage the pet is on now
  send({ t: 'hello', screen: { w: innerWidth, h: innerHeight } });
});

/* ---------- 玩具球（实现在 web/ball.js，页面这边只负责接线） ---------- */
/**
 * 球画进 `#fx`（跟影子、爱心、灰尘同一层），**不碰 `#pet` 那一层**——
 * 那里是她的身体，本会话已经在上面栽过两次，所以新玩法一律不往那儿塞东西。
 *
 * 她踢到球时报给 World：`ballKick`（选一句踢球的台词）、`ballOn` / `ballOff`（开关）。
 */
/**
 * 弹弹乐的游戏逻辑（球门/比分/她的守门）在 `web/game.js` 里，通过钩子驱动球与她的动作。
 * 这里用一层可变的 `hooks` 转接：`ball` 要先造出来才能把球交给 `game`，
 * 而 `ball` 的构造又要拿到钩子 —— 直接互相引用会踩"用到还没初始化"的坑。
 */
const hooks = { step: null, kick: null };
const ball = createBall({
  fxG: $('#fx'),
  sfx,
  stage: { bounds: () => ctl.bounds, pet: () => ctl.where },
  onEvent: (kind, d) => {
    // 踢到球 → 告诉 World 选一句台词。**报的是横向比例（0..1）**，World 不用知道窗口多大；
    // 它拿这个数决定"下次走过去找球"时的目标位置。
    if (kind === 'ballKick') send({ t: 'ballKick', at: +(d.x / Math.max(1, innerWidth)).toFixed(4) });
  },
  game: { onStep: (s) => hooks.step?.(s), onKick: (i) => hooks.kick?.(i) },
});

const game = createGame({
  fxG: $('#fx'),
  ball, sfx,
  control: {
    bounds: () => ctl.bounds,
    pet: () => ctl.where,
    /** `x` 是 0..1 的横向比例；`run === true` 时**跑**过去（比赛模式她默认跑，不然追不上球）。 */
    walkTo: (x, run) => { ctl.holdRoam(6); ctl.walkTo(Math.min(1, Math.max(0, x)) * innerWidth, !!run); },
    jump: () => ctl.act(['jump']),
    act: (a) => ctl.act([a]),
  },
  onEvent: (kind, d) => {
    if (kind === 'goal') send({ t: 'ballGoal', scorer: d.scorer, score: d.score, defence: d.defence });
    else if (kind === 'charge') send({ t: 'ballCharge' });
    else if (kind === 'mode') send({ t: 'ballMode', mode: d.mode, defence: d.defence });
  },
});
hooks.step = (s) => game.onStep(s);
hooks.kick = (i) => game.onKick(i);

/**
 * 切换球 / 弹弹乐的三态。**页面自己立刻切**（不等 World 一个来回），然后报给 World 记住。
 * `fromServer` 时不再回发（那是 World 同步过来的，回发会绕成环）。
 */
function setBallMode(mode, { fromServer = false, fromUser = false } = {}) {
  prefs.ballMode = mode;
  prefs.ballModeKnown = true;
  game.setMode(mode);
  refreshButtons();
  if (!fromServer) send({ t: 'ballMode', mode, fromUser });
}

/* ---------- connection ---------- */
let ws = null, backoff = 500, watching = false;
function send(msg) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); }
function connect() {
  ws = new WebSocket(`ws://${location.host}/socket?role=pet&host=${host ? 'window' : 'tab'}`);
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => { backoff = 500; send({ t: 'hello', screen: { w: innerWidth, h: innerHeight }, host: host ? 'window' : 'tab' }); };
  ws.onmessage = (e) => { try { onOrder(JSON.parse(e.data)); } catch (err) { console.error(err); } };
  ws.onclose = (e) => {
    ws = null;
    stopMic();
    // the World gave up on these steps when the page went; it asks again once the page is back
    dropDialogs();
    if (e.code === 4000) return; // replaced by a newer pet page
    setTimeout(connect, backoff);
    backoff = Math.min(8000, backoff * 2);
  };
}
connect();

/* ---------- the body: Coo, or the DeepSeek whale maid (web/whale, loaded the first time it is chosen) ---------- */
let whale = null, wanted = 'coo';
async function applyFigure(s) {
  wanted = s.figure;
  if (s.figure !== 'whale') { ctl.setFigure(null); return; }
  whale ??= import('./whale/figure.js').then((m) => m.createWhaleFigure(undefined, { scheme: s.scheme }));
  const fig = await whale;
  if (wanted !== 'whale') return;
  // a scheme picked while she is on screen fades in
  await fig.setScheme(s.scheme, { fade: ctl.figure === fig ? .45 : 0, at: ctl.time });
  ctl.setFigure(fig);
}

/**
 * The pet window puts the pet where it stood when the World last stopped (`startX`, a share of the window
 * width) from the first `init` only; after a reconnect it stays where it is. While `rememberPosition` is on it
 * reports where the pet stands each time the body changes mode, so the World holds the place of its last stop.
 */
let restored = false, sentX = null;
function restorePosition(startX) {
  sentX = null;
  if (restored) return;
  restored = true;
  if (!host || typeof startX !== 'number' || ctl.pet.mode === 'drag') return;
  const { minX, maxX } = ctl.bounds;
  ctl.pet.x = ctl.pet.target = clamp(startX * innerWidth, minX, maxX);
}
function reportPosition() {
  if (!host || !prefs.rememberPosition) return;
  const x = ctl.pet.x / innerWidth;
  if (sentX !== null && Math.abs(x - sentX) * innerWidth < 1) return;
  sentX = x;
  send({ t: 'position', x });
}

function applyPrefs(p) {
  if (p.skin) { const s = normalizeSkin(p.skin); ctl.setSkin(s); skinStyle.textContent = skinCss(s); applyFigure(s).catch((err) => console.error(err)); }
  if (p.roam) { prefs.roam = p.roam; ctl.setRoam(p.roam); }
  if (typeof p.sound === 'boolean') { prefs.sound = p.sound; sfx.set(p.sound); }
  if (p.sounds && typeof p.sounds === 'object') sfx.configure({ kinds: p.sounds, snoreSeconds: p.sounds.snoreSeconds });
  if (p.theme === 'dark' || p.theme === 'light') { prefs.theme = p.theme; applyTheme(p.theme); }
  if (typeof p.scale === 'number') { prefs.scale = p.scale; ctl.resize(); }
  if (typeof p.rememberPosition === 'boolean') { prefs.rememberPosition = p.rememberPosition; reportPosition(); }
  if (typeof p.micDevice === 'string' && p.micDevice !== prefs.micDevice) { prefs.micDevice = p.micDevice; stopMic(); }
  if (typeof p.mic === 'boolean') { prefs.mic = p.mic; p.mic && !watching ? startMic() : stopMic(); }
  if (p.voice && typeof p.voice === 'object') prefs.voice = { ...prefs.voice, ...p.voice };
  if (typeof p.lockFrameRate === 'boolean') prefs.lockFrameRate = p.lockFrameRate;
  if (typeof p.autoChat === 'boolean') prefs.autoChat = p.autoChat;
  // `voice` reports whether the World will read answers out loud (it knows if the files are there).
  // Its absence means this World has no speech at all, and the button stays two-step.
  if (typeof p.voice === 'boolean') {
    prefs.ttsOn = true;
    applySoundMode(p.voice ? 'voice' : (prefs.sound ? 'sfx' : 'off'));
  }
  if (Array.isArray(p.hoverButtons)) prefs.hoverButtons = p.hoverButtons.filter((id) => typeof id === 'string' && id in ACTIONS);
  if (p.bot) { prefs.bot = p.bot; if (!menu.hidden && !menu.querySelector('.m-head.confirm')) renderMenuHead(); }
  if (typeof p.thinking === 'boolean') ctl.setThinking(p.thinking);
  // 球 / 弹弹乐的三态开关：World 记着（第一次 `init`、重连、或它在菜单里改过时都会同步过来）
  if (typeof p.ballMode === 'string' && ['off', 'ball', 'game'].includes(p.ballMode)
    && (p.ballMode !== prefs.ballMode || !prefs.ballModeKnown)) {
    prefs.ballModeKnown = true;
    setBallMode(p.ballMode, { fromServer: true });
  }
  /**
   * 心情（World 每换一档才发一次）：只影响"黏着你"的远近和走路的快慢，不影响任何判定。
   *
   * ⚠️ **别写 `prefs.skin.mood = …`** —— `prefs` 上根本没有 `skin` 这个键，那一行会抛
   * `TypeError: Cannot set properties of undefined`，而且它抛在 **WebSocket 消息处理函数**里、
   * 也就是页面**异步启动链**的中间（`ready()` → `await connect()` → 装帧循环 → 创建她），
   * 于是"她从来没被创建" → **窗口在、日志全正常、屏幕上一个像素都没有**（实测踩过）。
   * 现在交给 `ctl.setMood()` 自己存着，绘制时由 pet-core 传给 figure（见 `frame.accMood`）。
   */
  if (p.mood && typeof p.mood === 'object') {
    prefs.mood = { ...p.mood };
    ctl.setMood(prefs.mood);
  }
  refreshButtons();
}

function onOrder(m) {
  switch (m.t) {
    case 'init': restorePosition(m.startX); applyPrefs(m); break;
    case 'prefs': applyPrefs(m); break;
    case 'watching': watching = true; stopMic(); break;
    case 'say': dropAsks(); pushSay(m); ctl.holdRoam(20); break;
    case 'voice': void onVoice(m); break;
    case 'ask': dropAsks(); queue.push({ kind: 'ask', id: m.id, question: m.question, options: m.options || [], own: m.own !== false }); ctl.holdRoam(20); break;
    case 'confirm': dropAsks(); queue.push({ kind: 'ask', confirm: true, id: m.id, question: m.question, options: m.options, own: false }); ctl.holdRoam(20); break;
    case 'walk': walk(m); break;
    case 'act': acts.push(...m.actions); ctl.holdRoam(20); break;
    // 不出声的小动作（歪头 / 换重心）：World 那边 timed 出来，这边画完回一条 `micro` 收尾
    case 'micro': ctl.micro(m.kind); break;
    case 'listen': onListen(m); break;
    case 'thinking': ctl.setThinking(!!m.on); break;
    case 'dialog': queue.push({ kind: 'dialog', id: m.id, d: m }); ctl.holdRoam(20); break;
    case 'dialog-update': updateDialog(m); break;
    case 'dialog-close': endDialog(m.id); break;
  }
}

/* ---------- 身体部位：这一下摸/戳在**身上哪里**（报给 World，好挑那个部位的话） ---------- */
/**
 * 判定表：[部位, 局部坐标 x, y]。局部坐标就是渲染器那一套（脚底中点是 (128,256)，
 * 也就是 pet-core 里 `toStage(128,128)` 用的那个空间）。
 *
 * **坐标是照 whale\model.json 里各部件的 `box` 算出来的中心点**（box 的 x+w/2, y+h/2），
 * 也就是"那个部件画在哪儿"，所以点到的是你眼睛看到的地方：
 * 脸/头顶/呆毛、上身/腰、左右手（arm_near/arm_far）、两侧鳍、尾巴、裙子、左右脚。
 *
 * 判定就是「离哪个锚点最近算哪个」——想挪分界线（比如让手的地盘大一点）只改这张表。
 * **部位名字要和 pet.cjs 的 AREAS 对上**：head / body / hand / fin / tail / low / foot。
 */
const REGION_AT = [
  ['head', 138.1, 115.1], ['head', 130.1, 74.7], ['head', 113.8, 38.6],   // 脸、头顶、呆毛
  ['body', 130.6, 171.2], ['body', 128, 188.9],                          // 上身、腰
  ['hand', 108.2, 185.3], ['hand', 159.2, 183.2],                        // 左手、右手（arm_near/arm_far）
  ['fin', 67.3, 121.8], ['fin', 185.4, 123.2],                           // 两侧的鳍
  ['tail', 65.8, 192.5],                                                 // 尾巴
  ['low', 129, 203],                                                     // 裙子
  ['foot', 112, 248], ['foot', 144, 248],                                // 左脚、右脚（贴地那一截）
];
/** 桌面坐标 → 身体的**局部坐标**（拿不到变换就返回 null）。 */
function petLocal(p) {
  const c = ctl.pet.xf;
  if (!c || !c.kx || !c.ky) return null;
  const r = c.rot * Math.PI / 180, cos = Math.cos(r), sin = Math.sin(r);
  const dx = p.x - c.AX, dy = p.y - c.AY;
  // 反着走一遍渲染器的变换：translate(AX,AY) rotate(rot) scale(kx,ky) translate(-ax,-ay)
  return { x: (dx * cos + dy * sin) / c.kx + c.ax, y: (-dx * sin + dy * cos) / c.ky + c.ay };
}
/**
 * 桌面坐标 → 身上哪个部位。拿不到身体的变换（第一帧还没画）就返回空串，
 * World 那边收到空串会退回通用台词，不会变成哑巴。
 */
function petRegion(p) {
  const at = petLocal(p);
  if (!at) return '';
  let best = '', far = Infinity;
  for (const [id, ax, ay] of REGION_AT) {
    const d = Math.hypot(at.x - ax, at.y - ay);
    if (d < far) { far = d; best = id; }
  }
  return best;
}
/**
 * **拎起来时每个部位怎么挂** —— `hang` 是悬挂角（度，正=顺时针），`0` 就是竖直垂着（老样子）。
 * 抓点本身会贴在光标上（pet-core 的 render 用 `grabAt` 当变换支点），所以"捏着左手"就一直捏着左手，
 * 这里只管**身体该怎么歪**：
 *
 *   · 头/上身 0°        —— 跟以前拎后颈一样
 *   · 手 35°、鳍 45°、裙子 28° —— 侧着挂（在左边抓就顺时针，在右边抓就逆时针，见下面的符号）
 *   · **尾巴 100°**      —— **整个人平躺/趴平在尾巴下面，尾巴被拽在最上面**（头朝一边垂着）。
 *                          90° = 完全水平；再往上（110~120°）头垂得更低、更像"瘫了"；18° 那种是几乎竖直挂。
 *   · 脚 165°           —— **倒吊**
 *
 * 数值都是"手感"，不满意就改这里，不用碰逻辑。**键必须和 REGION_AT 的部位名一致**（自检有这一条）。
 *
 * ⚠️ 只能做到"刚性旋转"：这具身体是**正面朝向**的部件图，所以尾巴那一档给到 100° 也只是
 * "平躺着（侧倒）"，**不是**参考图里那种脸朝下、看见后脑勺的俯卧——那要另画一张趴姿贴图。
 */
const GRAB_STYLE = {
  head: { hang: 0 },
  body: { hang: 0 },
  hand: { hang: 35 },
  fin: { hang: 45 },
  tail: { hang: 100 },
  low: { hang: 28 },
  foot: { hang: 165 },
};
/** 最近一次落在它身上的位置（桌面坐标）：按下时记一笔，蹭的时候跟着移动更新。 */
const touchAt = { x: 0, y: 0, ok: false };
/** 这一次拖拽：抓的是哪个部位（按下那一刻定格）、拎了多久、有没有报过"拎着呢"。 */
const dragAt = { area: '', since: 0, said: false };
/** 拎这么久还没放下，就吭一声（复用 touch 的 `stage` 机制，一次拖拽只报一次）。 */
const HOLD_SAID_MS = 1400;

/* ---------- 抚摸：往复判定 + 连续反馈 + 三段递进（都在页面侧） ---------- */
/**
 * **为什么要自己判**：pet-core 里那套「蹭」是"累计位移 > 320px 才反应一次"，而那个累计值
 * 每帧还按 `exp(-dt*1.5)` 衰减。实测（照抄那段判定做数值模拟）：
 *
 * ```
 *   来回抚摸  0.5Hz → 峰值  56   1.0Hz → 128   2.0Hz → 245   2.5Hz → 305  ← 全都不触发
 *             3.0Hz → 356（要 1.4 秒才有第一次反应）
 *   单向顺毛 150/300/600/1000 px/s → 峰值只有 64/81/95/106  ← 永远不够
 * ```
 * 也就是说：**人手舒服的抚摸（0.5–1.5 Hz）永远触发不了**，得每秒来回搓三次才行。
 * 上游 Coopanion 是同一份代码、同样三个数，所以这是继承来的手感，不是我们改坏的。
 *
 * **现在这套**（对着主流桌宠的通行做法）：
 *
 *   1. **往复判定**：1.2 秒内方向反转 ≥2 次、累计位移 ≥60px = 正在抚摸；
 *      单向划够 130px 也算（照顾只往一个方向顺毛的人）；
 *   2. **连续反馈**：抚摸期间不停刷新表情/脸红/爱心、续呼噜、按住它别乱走
 *      ——不是"每蹭够一段闪一下"；
 *   3. **三段递进**（每段只报**一句**给 World，走现成应答链限速，不会刷屏）：
 *      `start` 刚摸上（转过头）→ `good` 摸舒服了（约 1.5 秒）→ `over` 够了
 *      （同一部位摸太久；肚子/鳍/尾巴这些敏感部位更早喊停）；
 *   4. **部位差异**：用 `petRegion()`（头/肚子/鳍/尾巴/裙子），每段按部位挑台词。
 *
 * 手感和阈值全在下面的 `STROKE_CFG` 里，改那里就行。**pet-core.js 一行没动**。
 */

/** 这一轮抚摸的状态。`level` 是 0..1 的"舒服程度"，脸红/爱心/呼噜频率都看它。 */
const STROKE = {
  samples: [],        // 时间窗内的移动样本 `{t,x,y}`
  active: false,      // 这一轮正在抚摸
  startedAt: 0,
  touchedAt: 0,       // 最后一次"确实在摸"的时刻
  level: 0,
  area: '',
  saidGood: false,
  saidOver: false,
  until: 0,           // 这一轮到什么时候为止不接受新一轮
  purrAt: 0, exprAt: 0, heartAt: 0, dreamAt: 0,
};
/** 手感旋钮 —— 想调抚摸的灵敏度和节奏，只动这里。 */
const STROKE_CFG = {
  windowMs: 1200,     // 往复统计的时间窗
  turns: 2,           // 窗内最少反转几次
  moved: 60,          // 窗内最少累计位移（px）
  oneWay: 130,        // 或者：单向划这么远也算（顺毛）
  holdMs: 380,        // 停止移动这么久 = 这一轮结束
  againMs: 800,       // 结束之后隔这么久才允许开新一轮（免得停一下又"唔?"一次）
  goodMs: 1500,       // 摸到这会儿报"舒服"
  overMs: 4000,       // 同一部位摸这么久 = 够了
  overMsTickle: 2600, // 敏感部位更早喊停
  purrMs: 800,        // 呼噜续音间隔（sfx 一段是 0.9 秒，接得上）
  exprMs: 900,        // 表情/脸红刷新间隔
  heartMs: 1100,      // 爱心刷新间隔
  dreamMs: 4000,      // 睡着时被摸的"做梦"反应间隔
  rampMs: 3000,       // 舒服程度爬满要多久
};
/** 摸了会"咯咯笑"的部位：比别处更早喊停。 */
const TICKLISH = new Set(['body', 'fin', 'tail']);

const strokeNow = () => performance.now();

/** 只有"光标在它身上、没按住、它也没在忙别的"才算抚摸。 */
function strokeAllowed(p) {
  if (!p || ctl.pressing || !ctl.hitPet(p)) return false;
  const m = ctl.pet.mode;
  return m === 'sleep' || m === 'idle' || m === 'look' || m === 'sit';
}

/** 时间窗内累计的位移与方向反转次数（这就是"往复"的判据）。 */
function strokeWindow() {
  const t0 = strokeNow() - STROKE_CFG.windowMs;
  while (STROKE.samples.length && STROKE.samples[0].t < t0) STROKE.samples.shift();
  let turns = 0, moved = 0, dir = 0;
  for (let i = 1; i < STROKE.samples.length; i += 1) {
    const ax = STROKE.samples[i - 1], b = STROKE.samples[i];
    const dx = b.x - ax.x;
    moved += Math.hypot(dx, b.y - ax.y);
    if (Math.abs(dx) > 3) {
      const d = Math.sign(dx);
      if (dir && d !== dir) turns += 1;
      dir = d;
    }
  }
  return { turns, moved };
}

/** 光标动了：维护样本窗，够"往复"就开始/继续这一轮。 */
function strokeMove(p) {
  if (!strokeAllowed(p)) { STROKE.samples.length = 0; return; }
  const t = strokeNow();
  const last = STROKE.samples[STROKE.samples.length - 1];
  if (last && Math.hypot(p.x - last.x, p.y - last.y) < 2) return;   // 抖动用不着记
  STROKE.samples.push({ t, x: p.x, y: p.y });
  const { turns, moved } = strokeWindow();
  if (!((turns >= STROKE_CFG.turns && moved >= STROKE_CFG.moved) || moved >= STROKE_CFG.oneWay)) return;

  // 睡着的它：摸它只会做梦，不吵醒、也不改表情（跟原来那条规矩一致，只是变得好触发了）
  if (ctl.pet.mode === 'sleep') {
    STROKE.touchedAt = t;
    if (t < STROKE.dreamAt) return;
    STROKE.dreamAt = t + STROKE_CFG.dreamMs;
    ctl.emitHeart(); sfx.purr();
    send({ t: 'touch', kind: 'pet', asleep: true, ...(petRegion(p) ? { at: petRegion(p) } : {}) });
    return;
  }

  if (!STROKE.active) {
    if (t < STROKE.until) return;                 // 刚结束（或刚喊过"够了"），再等等
    STROKE.active = true;
    STROKE.startedAt = t;
    STROKE.level = 0;
    STROKE.saidGood = false;
    STROKE.saidOver = false;
    STROKE.area = petRegion(p) || '';
    STROKE.exprAt = t + STROKE_CFG.exprMs;
    STROKE.heartAt = t + STROKE_CFG.heartMs;
    STROKE.purrAt = t + 500;
    ctl.setExpr('surprised', 1.1);                // 第一段：转过头来看你
    send({ t: 'touch', kind: 'pet', ...(STROKE.area ? { at: STROKE.area } : {}), stage: 'start' });
  }
  STROKE.touchedAt = t;
}

/**
 * 主循环里的那一拍：爬"舒服程度"、续呼噜/爱心、判断"够了"和"这一轮结束"。
 * 挂在 `frame()` 里（不额外起定时器）。
 */
function stepStroke() {
  if (!STROKE.active) return;
  const t = strokeNow();
  if (t - STROKE.touchedAt > STROKE_CFG.holdMs) { endStroke(t, ''); return; }
  const lived = t - STROKE.startedAt;
  STROKE.level = Math.min(1, lived / STROKE_CFG.rampMs);
  const k = STROKE.level;
  ctl.holdRoam(2);                                // 摸着的时候别自己溜达走

  const overMs = TICKLISH.has(STROKE.area) ? STROKE_CFG.overMsTickle : STROKE_CFG.overMs;
  if (!STROKE.saidOver && lived >= overMs) {       // 第三段：够了
    STROKE.saidOver = true;
    ctl.setExpr('angry', 1.4);
    ctl.act('shake');                              // 缩一下
    send({ t: 'touch', kind: 'pet', ...(STROKE.area ? { at: STROKE.area } : {}), stage: 'over' });
    endStroke(t, 'over');
    return;
  }
  if (!STROKE.saidGood && lived >= STROKE_CFG.goodMs) {   // 第二段：摸舒服了
    STROKE.saidGood = true;
    ctl.setExpr('love', 1.6);
    send({ t: 'touch', kind: 'pet', ...(STROKE.area ? { at: STROKE.area } : {}), stage: 'good' });
  }
  if (t >= STROKE.purrAt) { STROKE.purrAt = t + STROKE_CFG.purrMs; sfx.purr(); }
  if (t >= STROKE.exprAt) {
    STROKE.exprAt = t + STROKE_CFG.exprMs * (1.25 - k * .5);    // 越摸越勤
    if (k > .45 && t >= STROKE.heartAt) {
      STROKE.heartAt = t + STROKE_CFG.heartMs;
      ctl.setExpr('love', 1.4);                   // 'love' 自带 4 颗心
    } else ctl.setExpr('shy', 1.4);               // 脸红靠 'shy' 那张脸（blushK 会跟着爬）
  }
}

/** 拎起来这条线：拎久了吭一声（一次拖拽只报一次，`at` 用按下时定格的部位）。 */
function stepDrag() {
  if (ctl.pet.mode !== 'drag') { dragAt.since = 0; dragAt.said = false; return; }
  const t = strokeNow();
  if (!dragAt.since) { dragAt.since = t; return; }
  if (dragAt.said || t - dragAt.since < HOLD_SAID_MS) return;
  dragAt.said = true;
  send({ t: 'touch', kind: 'grab', ...(dragAt.area ? { at: dragAt.area } : {}), stage: 'long' });
}

/** 这一轮结束：清状态，并留一小段冷却。 */
function endStroke(t, why) {
  STROKE.active = false;
  STROKE.level = 0;
  STROKE.samples.length = 0;
  STROKE.touchedAt = 0;
  STROKE.until = t + (why === 'over' ? 3000 : STROKE_CFG.againMs);
}

/* ---------- body events → World ---------- */
const walkTargets = new Map();
function onBody(kind, d) {
  if (kind === 'arrived' || kind === 'interrupted') {
    if (!d.walkId || !walkTargets.has(d.walkId)) return;
    walkTargets.delete(d.walkId);
    send({ t: kind, walkId: d.walkId, x: d.x / innerWidth, by: d.by });
    if (actWait && actWait.walkId === d.walkId) actWait = null;
  } else if (kind === 'touch') {
    // 「部位」对戳/蹭/抓/放都有意义。**抓的部位用按下那一刻定格的**（`dragAt.area`）：
    // 拖起来之后光标早就不在原来那个点上了，实时算会算成"你手滑过去的地方"。
    let at = '';
    if (d.kind === 'grab' || d.kind === 'drop') at = dragAt.area;
    else if ((d.kind === 'poke' || d.kind === 'pet') && touchAt.ok) at = petRegion(touchAt);
    send({ t: 'touch', ...d, ...(at ? { at } : {}) });
    if (d.kind === 'grab') closeMenu();
  } else if (kind === 'mode') {
    reportPosition();
  }
}

function walk(m) {
  const x = m.to === 'cursor' ? (pointerSeen ? lastPointer.x : innerWidth / 2) : clamp(Number(m.to), 0, 1) * innerWidth;
  walkTargets.set(m.id, true);
  ctl.holdRoam(20);
  if (!ctl.walkTo(x, !!m.run, m.id)) {
    walkTargets.delete(m.id);
    send({ t: 'interrupted', walkId: m.id, x: ctl.pet.x / innerWidth, by: ctl.pet.mode === 'drag' ? 'drag' : ctl.pet.mode });
  }
}

/* ---------- actions ---------- */
const DUR = { stand: 1.2, jump: 1.2, hop: .9, look: 2.7, turn: .4, nod: .8, shake: .8, spin: .8, sit: .8, sleep: .8, dizzy: 3.2 };
const acts = [];
let actUntil = 0, actWait = null;
function runAction(a) {
  if (EXPRESSIONS.includes(a)) {
    if (a === 'neutral') ctl.setExpr('neutral', .1);
    else ctl.setExpr(a);
    return .9;
  }
  if (a === 'walk' || a === 'run') {
    const id = 'act' + Math.random().toString(36).slice(2);
    const x = ctl.pet.x < innerWidth / 2 ? innerWidth * (.55 + Math.random() * .35) : innerWidth * (.1 + Math.random() * .35);
    // ★ **必须先登记再 `walkTo()`**：目标离身体不到 2px 时 `walkTo` 会**同步**回调
    // `arrived`（见 pet-core 的 walkTo），而 `onBody` 只认登记过的 id。原来顺序反了：
    // 那次 arrived 被丢掉 → `actWait` 永远清不掉 → `stepActs` 从此一条 act 都不执行，
    // 而且 `{t:'arrived'}` 永不发出去，World 那边的 `walking` 也永远是 true（连"瞟一眼鼠标"
    // 都没了）。概率不高，但**不可自愈**（要重载页面）。`walk()` 是先登记后走，这里对齐它。
    walkTargets.set(id, true);
    if (ctl.walkTo(x, a === 'run', id)) { actWait = { walkId: id, at: ctl.time }; return 12; }
    walkTargets.delete(id);
    return 1;                      // 没走成（它正忙）：别白等 12 秒

  }
  ctl.act(a);
  return DUR[a] ?? 1;
}
function stepActs() {
  const now = ctl.time;
  // 兜底：`actWait` 万一永远等不到 `arrived`（页面重载、走位被打断…），20 秒后自己放行——
  // 不然动作队列会永久卡死（见 runAction 里那段注释）。
  if (actWait && now - actWait.at > 20) actWait = null;
  if (actWait || now < actUntil || !acts.length) return;
  if (ctl.busy()) return;
  actUntil = now + runAction(acts.shift());
  ctl.holdRoam(15);
}

/* ---------- say / ask ---------- */
const queue = [];
let item = null;
const PAUSE = /[,。!?…、,.!?]/, SILENT = /[\s,。!?…、,.!?「」:()]/;

/** A newer question replaces the bot's open one; a World's confirmation stays until answered. */
function dropAsks() {
  for (let i = queue.length - 1; i >= 0; i--) if (queue[i].kind === 'ask' && !queue[i].confirm) queue.splice(i, 1);
  if (item && item.kind === 'ask' && !item.answered && !item.confirm) closeBubble();
}

/* ---------- the bubble queue: capped, and stale bubbles never surface ---------- */
/** Most bubbles waiting behind the one on screen; the oldest beyond this is dropped. */
const QUEUE_MAX = 3;
/** A queued touch reaction older than this is stale: the click it answers is long over. */
const SAY_STALE_MS = 2500;
/** Says queued within this of each other were one burst: play them as a single bubble. */
const SAY_MERGE_MS = 220;
/**
 * The World marks each say: `react` answers what was just touched (after SAY_STALE_MS the answer
 * no longer matches what you did, so a queued one is dropped), while `line` — a greeting, an idle
 * remark, a model's answer — is worth saying whenever it arrives.
 */
function dropStaleSays() {
  const now = performance.now();
  for (let i = queue.length - 1; i >= 0; i--) {
    const q = queue[i];
    if (q.kind === 'say' && q.stale && !q.started && now - q.at > q.stale) queue.splice(i, 1);
  }
}
/** Queues one say: merges a burst of them, drops a stale backlog, and caps what is left. */
function pushSay(m) {
  dropStaleSays();
  const first = (m.beats || []).filter((b) => b && b.text);
  if (!first.length) return;
  const now = performance.now();
  const last = queue[queue.length - 1];
  // 要念的气泡不合并：它后面跟着一份自己的音频，并进去之后那一句就没人放了
  const mergeable = last?.kind === 'say' && !last.started && !last.spoken && !m.voice && now - last.at <= SAY_MERGE_MS;
  if (mergeable) {
    last.beats = [...last.beats, ...first];   // one burst, one bubble: no need for two gaps
    last.at = now;
  } else {
    queue.push({
      kind: 'say', id: m.id, beats: first, i: -1, at: now,
      stale: m.kind === 'react' ? SAY_STALE_MS : 0,
      // 这一句有语音：**不拦打字**，只是等它的音频到了就放（见 stepDialog）
      spoken: !!m.voice,
    });
  }
  while (queue.length > QUEUE_MAX) queue.shift();
}

function openBubble(kind, html) {
  bubble.className = 'bubble ' + kind;
  bubble.innerHTML = html;
  bubble.hidden = false;
  // 新气泡开始：这一条的语音还没放过
  if (kind === 'say') sayAudioReset();
  void bubble.offsetWidth;
  bubble.classList.add('pop');
}
function closeBubble() {
  releaseKeys(item);
  if (item?.kind === 'dialog') talk.motion = null;
  bubble.hidden = true; bubble.innerHTML = '';
  // 气泡没了：还没轮到的语音就丢掉，免得它挂在那儿、等下一句话时突然冒出来
  if (item?.kind === 'say') { sayAudio.next = null; sayAudioReset(); }
  item = null;
}

/**
 * While a question's options are up, the pet window takes the keyboard so 1–9 pick one right
 * away, and gives it back to the window that had it once the question is answered or gone.
 */
function grabKeys(it) {
  if (!host?.grabFocus || !it.options.length) return;
  it.grabbed = true;
  host.grabFocus();
}
function releaseKeys(it) {
  if (!it?.grabbed) return;
  it.grabbed = false;
  host.releaseFocus();
}

function startItem(it) {
  item = it;
  if (it.kind === 'dialog') { openDialog(it); return; }
  if (it.kind === 'ask') {
    openBubble('ask', '<button class="b-close" type="button" aria-label="关闭">×</button><p class="b-text"></p><div class="b-opts" hidden></div>');
    bubble.querySelector('.b-close').addEventListener('click', () => dismissAsk());
    it.text = it.question; it.shown = 0; it.acc = 0; it.optsShown = false;
    sfx.pop();
  }
}

/** Tells the World a quiet moment has come: it forgets which answers it already spoke. */
function roundOver() {
  const now = performance.now();
  if (now - said.round < 1500) return;
  said.round = now;
  send({ t: 'prefs', round: true });
}

function stepDialog(dt) {
  if (!item && queue.length && !ctl.busy()) startItem(queue.shift());
  const it = item;
  if (!it) { roundOver(); return; }
  if (it.kind === 'say') {
    if (it.i < 0 || it.beatDone) {
      if (it.beatDone && ctl.time < it.holdUntil) return;
      it.i++;
      it.beatDone = false;
      if (it.i >= it.beats.length) { closeBubble(); return; }
      it.started = true;                 // on screen now: no longer mergeable or droppable
      const b = it.beats[it.i];
      let lead = 0;
      for (const a of b.actions || []) { acts.push(a); lead = .45; }
      it.shown = 0; it.acc = 0; it.fired = 0; it.startAt = ctl.time + lead;
      it.leadSince = undefined;         // 这一拍要不要等语音，等第一次走到时再计时（见 VOICE_LEAD）
      if (b.text) { openBubble('say', '<p class="b-text"></p>'); sfx.pop(); } else { bubble.hidden = true; }
      return;
    }
    const b = it.beats[it.i];
    if (ctl.time < it.startAt) return;
    if (!b.text) { it.beatDone = true; it.holdUntil = ctl.time + .8; return; }
    // 这一句有语音：**先把音放起来，但一个字都不等多**。
    // 音频来早了（在这条气泡出现之前就到了）→ `sayAudio.next` 里存着，这里开播；
    // 音频还没来 → 什么都不做，等 onVoice 在它到达时开播。两者都不会挡住下面的打字。
    if (it.spoken) {
      if (!sayAudioStarted() && sayAudio.next && !sayAudio.playing) {
        const buf = sayAudio.next;
        sayAudio.next = null;
        sayAudio.played = true;
        sayVoicePlay(buf);
      }
      // 故意让字等一下语音（见 VOICE_LEAD）：气泡已经弹出来了，这里只是压住打字。
      // 第一次走到这个 beat 时记下起点，之后按它算。
      if (it.leadSince === undefined) it.leadSince = ctl.time;
      if (ctl.time - it.leadSince < VOICE_LEAD) return;
    }
    typeText(it, b.text, dt, b.anchors || []);
    if (it.shown >= b.text.length && !it.beatDone) {
      it.beatDone = true;
      const last = it.i === it.beats.length - 1;
      it.holdUntil = ctl.time + (last ? 1.6 + b.text.length * .07 : .9 + b.text.length * .03);
    }
    return;
  }
  if (it.kind === 'ask') {
    if (it.shown < it.text.length) { typeText(it, it.text, dt, []); return; }
    if (!it.optsShown) { it.optsShown = true; showOptions(it); }
  }
  if (it.kind === 'dialog') stepTalk(it, dt);
}

function typeText(it, text, dt, anchors) {
  const p = bubble.querySelector('.b-text');
  if (!p || it.shown >= text.length) return;
  it.acc += dt * 20;
  while (it.acc >= 1 && it.shown < text.length) {
    const ch = text[it.shown++];
    it.acc -= PAUSE.test(ch) ? 5 : 1;
    if (!SILENT.test(ch)) { sfx.babble(ch); ctl.talk(); }
    while (it.fired < anchors.length && anchors[it.fired].at <= it.shown) acts.push(...anchors[it.fired++].actions);
  }
  if (it.marks?.length) p.innerHTML = marked(text, it.shown, it.marks);
  else p.textContent = text.slice(0, it.shown);
}

/** The first `n` characters of `text`, escaped, with every one of `words` in it wrapped for the theme color. */
function marked(text, n, words) {
  const on = new Array(text.length).fill(false);
  for (const w of words) {
    if (!w) continue;
    for (let i = text.indexOf(w); i >= 0; i = text.indexOf(w, i + w.length)) on.fill(true, i, i + w.length);
  }
  let out = '', open = false;
  for (let i = 0; i < n; i++) {
    if (on[i] !== open) { out += on[i] ? '<b class="d-mark">' : '</b>'; open = on[i]; }
    out += esc(text[i]);
  }
  return open ? out + '</b>' : out;
}

function showOptions(it) {
  const box = bubble.querySelector('.b-opts');
  it.options.forEach((label, i) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'b-opt';
    b.innerHTML = i < 9 ? `<kbd>${i + 1}</kbd><span></span>` : '<span></span>';
    b.querySelector('span').textContent = label;
    b.style.animationDelay = (i * .07) + 's';
    b.addEventListener('click', () => answer(b, { index: i }));
    box.appendChild(b);
    setTimeout(() => sfx.blub(), i * 70);
  });
  if (it.own) {
    const form = document.createElement('form');
    form.className = 'b-own';
    form.innerHTML = '<input type="text" maxlength="200" autocomplete="off" placeholder="自己说点什么…" aria-label="自己写回答"><button type="submit">发送</button>';
    form.style.animationDelay = (it.options.length * .07) + 's';
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const input = form.querySelector('input'), v = input.value.trim();
      if (!v) { input.focus(); return; }
      answer(form, { text: v });
    });
    box.appendChild(form);
  }
  box.hidden = false;
  grabKeys(it);
}

function answer(node, a) {
  const it = item;
  if (!it || it.kind !== 'ask' || it.answered) return;
  it.answered = true;
  sfx.select();
  node.classList.add('chosen');
  bubble.querySelectorAll('.b-opt, .b-own').forEach((n) => { if (n !== node) n.classList.add('dim'); });
  send(it.confirm ? { t: 'confirmed', id: it.id, index: a.index } : { t: 'answer', askId: it.id, ...a });
  // the bubble stays a moment longer; the keyboard goes back now
  releaseKeys(it);
  ctl.setExpr('happy');
  setTimeout(() => { if (item === it) closeBubble(); }, 700);
}
function dismissAsk() {
  const it = item;
  if (!it || it.kind !== 'ask' || it.answered) return;
  it.answered = true;
  send(it.confirm ? { t: 'confirmed', id: it.id, index: null } : { t: 'answer', askId: it.id, dismissed: true });
  closeBubble();
}

/* ---------- an app's conversation: one step at a time in Coo's bubble ---------- */
/** How Coo moves while a step's choice cards are up, around the spot the bubble is pinned to. */
const talk = { motion: null, next: 0 };
/** Pixels Coo strays either side of the bubble while showing a motion. */
const TALK_RANGE = 240;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function dropDialogs() {
  for (let i = queue.length - 1; i >= 0; i--) if (queue[i].kind === 'dialog') queue.splice(i, 1);
  if (item?.kind === 'dialog') closeBubble();
}

function openDialog(it) {
  const d = it.d;
  const dots = Array.isArray(d.step) ? Array.from({ length: d.step[1] }, (_, i) => `<i class="${i + 1 < d.step[0] ? 'past' : i + 1 === d.step[0] ? 'on' : ''}"></i>`).join('') : '';
  openBubble('talk', `${dots || d.closable ? `<div class="d-top"><span class="d-dots">${dots}</span>${d.closable ? '<button class="b-close" type="button" aria-label="跳过" title="跳过">×</button>' : ''}</div>` : ''}<p class="b-text"></p><div class="d-body" hidden></div>`);
  bubble.querySelector('.b-close')?.addEventListener('click', () => settleDialog(it, { closed: true }));
  for (const a of d.actions || []) acts.push(a);
  it.text = d.text || ''; it.shown = 0; it.acc = 0; it.bodyShown = false; it.readUntil = 0;
  it.marks = Array.isArray(d.marks) ? d.marks.filter((w) => typeof w === 'string') : [];
  sfx.pop();
}

function stepTalk(it, dt) {
  if (it.shown < it.text.length) { typeText(it, it.text, dt, []); return; }
  if (it.bodyShown) return;
  it.bodyShown = true;
  if (!it.d.input) { it.readUntil = ctl.time + 1.4 + it.text.length * .05; return; }
  showDialogInput(it);
}

/** A step with nothing to answer ends once its line has been read. */
function stepTalkRead() {
  const it = item;
  if (it?.kind === 'dialog' && it.readUntil && ctl.time > it.readUntil) settleDialog(it, { done: true });
}

function showDialogInput(it) {
  const body = bubble.querySelector('.d-body'), input = it.d.input;
  if (!body) return;
  if (input.kind === 'buttons') {
    if (input.keys) body.insertAdjacentHTML('beforeend', `<div class="d-keys"><kbd class="d-key${input.taps > 1 ? ' taps' : ''}">${esc(input.keys)}</kbd>${input.taps > 1 ? `<span class="d-taps">×${Number(input.taps)}</span>` : ''}</div>`);
    const row = Object.assign(document.createElement('div'), { className: 'd-row' });
    input.options.forEach((o, i) => row.appendChild(pill(o.label, o.primary, () => settleDialog(it, { index: i }))));
    body.appendChild(row);
  } else if (input.kind === 'choices') {
    const cards = Object.assign(document.createElement('div'), { className: 'd-cards' });
    const pick = (i, speak) => {
      it.value = i;
      cards.querySelectorAll('.d-card').forEach((c, k) => c.classList.toggle('on', k === i));
      const o = input.options[i];
      // the bubble stays put from here on, so the cards do not run off while Coo shows how it moves
      if (it.pinX === undefined) { const a = ctl.anchor(); it.pinX = a.x; it.pinY = a.y; }
      talk.motion = o?.motion ?? null; talk.next = 0;
      if (speak && o?.line) { it.text = o.line; it.shown = 0; it.acc = 0; }
    };
    input.options.forEach((o, i) => {
      const c = document.createElement('button');
      c.type = 'button'; c.className = 'd-card';
      c.style.animationDelay = (i * .07) + 's';
      const image = typeof o.image === 'string' && o.image.startsWith('data:image/') ? `<img class="d-cardimg" alt="" src="${esc(o.image)}">` : '';
      c.innerHTML = `${image || (o.icon && ICONS[o.icon] ? `<span class="d-cardic">${ICONS[o.icon]}</span>` : '')}<span class="d-cardlbl">${esc(o.label)}</span>${o.level ? `<b class="d-level">${esc(o.level)}</b>` : ''}`;
      c.addEventListener('click', () => { sfx.tick(); pick(i, true); });
      cards.appendChild(c);
      setTimeout(() => sfx.blub(), i * 70);
    });
    body.appendChild(cards);
    const row = Object.assign(document.createElement('div'), { className: 'd-row' });
    row.appendChild(pill(input.confirm, true, () => settleDialog(it, { index: it.value ?? 0 })));
    body.appendChild(row);
    pick(typeof input.value === 'number' ? input.value : 0, false);
  } else if (input.kind === 'text') {
    const form = Object.assign(document.createElement('form'), { className: 'd-field' });
    form.innerHTML = `<input type="${input.secret ? 'password' : 'text'}" autocomplete="off" spellcheck="false" maxlength="${Number(input.maxLength) || 200}">${input.secret ? `<button class="d-peek" type="button" aria-label="显示" title="显示">${ICONS.eye}</button>` : ''}<button class="d-send" type="submit"></button>`;
    const field = form.querySelector('input');
    field.placeholder = input.placeholder || '';
    field.value = input.value || '';
    if (Array.isArray(input.suggestions) && input.suggestions.length && !input.secret) {
      const list = document.createElement('datalist');
      list.id = `d-list-${it.id}`;
      for (const s of input.suggestions) list.appendChild(Object.assign(document.createElement('option'), { value: String(s) }));
      form.appendChild(list);
      field.setAttribute('list', list.id);
    }
    field.setAttribute('aria-label', it.text);
    form.querySelector('.d-send').textContent = input.submit;
    form.querySelector('.d-peek')?.addEventListener('click', (e) => {
      const show = field.type === 'password';
      field.type = show ? 'text' : 'password';
      e.currentTarget.innerHTML = show ? ICONS.eyeOff : ICONS.eye;
      field.focus();
    });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const v = field.value.trim();
      if (!v) { form.classList.remove('shake'); void form.offsetWidth; form.classList.add('shake'); field.focus(); return; }
      settleDialog(it, { text: v });
    });
    body.appendChild(form);
    if (input.link || input.alt) {
      const row = Object.assign(document.createElement('div'), { className: 'd-links' });
      if (input.link) {
        const a = Object.assign(document.createElement('a'), { className: 'd-link', href: input.link.url, target: '_blank', rel: 'noopener' });
        a.innerHTML = `<span></span>${ICONS.external}`;
        a.querySelector('span').textContent = input.link.label;
        row.appendChild(a);
      }
      if (input.alt) {
        const b = Object.assign(document.createElement('button'), { type: 'button', className: 'd-alt', textContent: input.alt });
        b.addEventListener('click', () => settleDialog(it, { alt: true }));
        row.appendChild(b);
      }
      body.appendChild(row);
    }
    // the window takes the keyboard so the box can be typed in right away
    host?.focus?.();
    setTimeout(() => field.focus(), 30);
  } else if (input.kind === 'progress') {
    body.innerHTML = `<div class="d-bar${typeof it.progress === 'number' ? '' : ' wait'}"><i></i></div><div class="d-barlbl"><span></span><b></b></div>`;
    body.querySelector('.d-barlbl span').textContent = input.label || '';
    drawProgress(it);
  }
  body.hidden = false;
  body.querySelector('.d-send, .d-pill.primary')?.focus?.({ preventScroll: true });
}

function pill(label, primary, onClick) {
  const b = Object.assign(document.createElement('button'), { type: 'button', className: `d-pill${primary ? ' primary' : ''}`, textContent: label });
  b.addEventListener('click', onClick);
  return b;
}

function drawProgress(it) {
  const bar = bubble.querySelector('.d-bar');
  if (!bar) return;
  const p = it.progress;
  bar.classList.toggle('wait', typeof p !== 'number');
  bar.querySelector('i').style.width = typeof p === 'number' ? `${Math.round(clamp(p, 0, 1) * 100)}%` : '';
  bubble.querySelector('.d-barlbl b').textContent = typeof p === 'number' ? `${Math.floor(clamp(p, 0, 1) * 100)}%` : '';
}

function updateDialog(m) {
  const it = item?.kind === 'dialog' && item.id === m.id ? item : queue.find((q) => q.kind === 'dialog' && q.id === m.id);
  if (!it) return;
  if ('progress' in m) it.progress = m.progress;
  if (typeof m.text === 'string') {
    it.d = { ...it.d, text: m.text };
    if (it === item) { it.text = m.text; it.shown = 0; it.acc = 0; }
  }
  if (it === item) drawProgress(it);
}

function endDialog(id) {
  const i = queue.findIndex((q) => q.kind === 'dialog' && q.id === id);
  if (i >= 0) queue.splice(i, 1);
  if (item?.kind === 'dialog' && item.id === id) closeBubble();
}

function settleDialog(it, answer) {
  if (item !== it || it.answered) return;
  it.answered = true;
  send({ t: 'dialog', id: it.id, ...answer });
  if (answer.done) { closeBubble(); return; }
  sfx.select();
  bubble.querySelectorAll('button, input').forEach((n) => { n.disabled = true; });
  if ('index' in answer) bubble.querySelectorAll('.d-pill')[answer.index]?.classList.add('chosen');
  // the chosen button shows a moment; the app's next step waits in the queue meanwhile
  setTimeout(() => { if (item === it) closeBubble(); }, 260);
}

/** Coo shows the picked card's motion near the pinned bubble: standing still, strolling, or running about. */
function stepTalkMotion() {
  const it = item;
  if (it?.kind !== 'dialog') return;
  ctl.holdRoam(20);
  if (!talk.motion || it.pinX === undefined || ctl.busy() || ctl.time < talk.next || ctl.pet.mode !== 'idle') return;
  const home = it.pinX, R = Math.min(TALK_RANGE, innerWidth * .25);
  if (talk.motion === 'still') {
    if (Math.abs(ctl.pet.x - home) > 30) ctl.walkTo(home, false);
    talk.next = ctl.time + 1;
    return;
  }
  const run = talk.motion === 'run';
  if (run && Math.random() < .3) { ctl.act('hop'); talk.next = ctl.time + .5; return; }
  // to the other side of the bubble each time, so every move is plain to see
  const x = ctl.pet.x < home ? home + R * (.4 + Math.random() * .6) : home - R * (.4 + Math.random() * .6);
  if (ctl.walkTo(clamp(x, 40, innerWidth - 40), run)) talk.next = ctl.time + (run ? .1 : 1.2 + Math.random() * 1.2);
}

/* ---------- typed input: the hover button, or double-click when switched on ---------- */
function openInput() {
  closeMenu();
  if (item && item.kind === 'ask' && !item.answered) return;
  if (item) closeBubble();
  item = { kind: 'input' };
  openBubble('ask', '<button class="b-close" type="button" aria-label="关闭">×</button><form class="b-own"><input type="text" maxlength="500" autocomplete="off" placeholder="想说什么…" aria-label="打字说话"><button type="submit">发送</button></form>');
  const form = bubble.querySelector('form'), input = form.querySelector('input');
  bubble.querySelector('.b-close').addEventListener('click', () => closeBubble());
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = input.value.trim();
    if (!v) return;
    send({ t: 'text', text: v });
    sfx.select(); ctl.setExpr('happy');
    closeBubble();
  });
  host?.focus?.();
  setTimeout(() => input.focus(), 30);
}

/* ---------- listening ---------- */
/** `text` is settled, `interim` the sentence still being heard (Windows' recognizer reports it as it goes). */
const listen = { phase: null, text: '', interim: '', closeAt: 0 };
function onListen(m) {
  // the quick tap before a talk key is held: Coo perks up, and the hold that follows starts listening
  if (m.phase === 'ready') {
    if (listen.phase) return;
    sfx.tick();
    ctl.pet.sqv += .6;
    ctl.setExpr('surprised', .5);
    return;
  }
  if (m.phase === 'start') {
    if (!listen.phase) sfx.listenStart();
    listen.phase = 'hearing'; listen.closeAt = 0;
    ctl.setListening(true);
    showHeard(listen.text, true, undefined, listen.interim);
  } else if (m.phase === 'transcribing') {
    listen.phase = listen.phase || 'hearing';
    showHeard(listen.text, true, undefined, listen.interim);
  } else if (m.phase === 'partial') {
    listen.text = m.text || '';
    listen.interim = m.interim || '';
    showHeard(listen.text, true, undefined, listen.interim);
  } else if (m.phase === 'heard') {
    listen.text = m.text || ''; listen.interim = '';
    listen.phase = 'done';
    showHeard(listen.text, false, '听到了');
    sfx.listenEnd();
    ctl.setListening(false);
    ctl.pet.sqv += .9;
    listen.closeAt = ctl.time + 2.2;
  } else if (m.phase === 'none') {
    if (listen.phase === 'done') return;
    listen.phase = null; listen.text = ''; listen.interim = '';
    heardEl.hidden = true; trail.hidden = true;
    ctl.setListening(false);
  }
}
/** `text` is settled; `interim` is the sentence still being heard, greyed, and may still change. */
function showHeard(text, live, hint, interim = '') {
  heardEl.hidden = false; trail.hidden = false;
  heardEl.innerHTML = `<p class="b-text"><span class="fin"></span><span class="interim"></span>${live ? '<span class="caret" aria-hidden="true"></span>' : ''}</p><span class="b-hint"></span>`;
  heardEl.querySelector('.fin').textContent = text;
  // a space only before Latin text that follows Latin text or ASCII punctuation; Chinese sentences run on
  heardEl.querySelector('.interim').textContent = text && interim && /[A-Za-z0-9.,!?;:]$/.test(text) && /^[A-Za-z0-9]/.test(interim) ? ' ' + interim : interim;
  heardEl.querySelector('.b-hint').textContent = hint || (text || interim ? '还在听…' : '正在听…');
}
function stepListen() {
  if (listen.phase === 'done' && ctl.time > listen.closeAt) {
    listen.phase = null; listen.text = ''; listen.interim = '';
    heardEl.hidden = true; trail.hidden = true;
  }
}

/* ---------- microphone ---------- */
let mic = null;
async function startMic() {
  if (mic) return;
  mic = { starting: true };
  // 拿到一半就失败时也要停麦关声卡,否则录音指示灯常亮到页面刷新
  let stream = null, ctx = null;
  try {
    const audio = { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    if (prefs.micDevice) audio.deviceId = { exact: prefs.micDevice };
    stream = await navigator.mediaDevices.getUserMedia({ audio });
    ctx = new AudioContext({ sampleRate: 16000 });
    await ctx.audioWorklet.addModule('/web/mic-worklet.js');
    const src = ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(ctx, 'pet-mic');
    node.port.onmessage = (e) => { if (ws && ws.readyState === 1) ws.send(e.data); };
    src.connect(node);
    if (!prefs.mic || !mic) { stream.getTracks().forEach((t) => t.stop()); ctx.close(); mic = null; return; }
    mic = { stream, ctx, node };
    send({ t: 'mic', state: 'on', detail: stream.getAudioTracks()[0]?.label || null });
    void reportDevices();
  } catch (err) {
    if (stream) stream.getTracks().forEach((t) => t.stop());
    if (ctx) ctx.close();
    mic = null;
    send({ t: 'mic', state: err && err.name === 'NotAllowedError' ? 'denied' : 'error', detail: String(err && err.message || err) });
  }
}
/** Device labels are readable only after microphone access was granted. */
async function reportDevices() {
  const all = await navigator.mediaDevices.enumerateDevices();
  send({ t: 'devices', list: all.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications').map((d) => ({ id: d.deviceId, label: d.label })) });
}
navigator.mediaDevices?.addEventListener('devicechange', () => { if (mic && !mic.starting) void reportDevices(); });
function stopMic() {
  const m = mic;
  mic = null;
  if (!m || m.starting) return;
  m.stream.getTracks().forEach((t) => t.stop());
  m.ctx.close();
  send({ t: 'mic', state: 'off' });
}

/* ---------- actions: the menu's lower zone and the hover buttons draw from one list ---------- */
const ROAM_ORDER = ['off', 'calm', 'free', 'cling'];
const ROAM = { off: '不乱动', calm: '多待着', free: '常走动', cling: '黏着你' };
const ROAM_LEVEL = { off: '低', calm: '中', free: '高', cling: '高' };
/** The voice button's badge: listening all the time, or only on the talk key. */
const MIC_BADGE = { always: 'auto', hold: 'key', toggle: 'key' };
/** Most hover buttons shown beside the pet. */
const MAX_HOVER = 6;

/**
 * Every button the menu and the hover buttons can show, in the menu's order. `icon`, `state` and
 * `on` read the current prefs: `state` is the line that says what the button does and where it
 * stands, `on` lights a switch that is on (undefined for plain actions). `keep` leaves the menu
 * open after a click, so a switch shows its new state there.
 */
const ACTIONS = {
  chat: {
    icon: () => ICONS.chat,
    // 双击打字那一条已经去掉了（它跟"连点两下就是戳它"抢同一个手势），所以这里不再提双击
    state: () => '打字和我说话',
    run: () => openInput(),
  },
  /**
   * 球 / 弹弹乐开关（悬停时它旁边那一列里的第二个按钮）。**三态**（用户要的）：
   *   点一下 → 出球（自由玩，踢/拨/追都通用）
   *   再点一下 → **游戏模式**（球门 + 比分，她守自己那一边）
   *   再点一下 → 关掉（**她会闹脾气**：随机委屈/生气，由 World 配表情台词）
   *
   * 页面自己立刻切（不等一个来回），同时报给 World 记住（`config\settings.json` 的 `ballMode`）。
   */
  game: {
    keep: true,
    icon: () => ICONS.ball,
    on: () => prefs.ballMode !== 'off',
    badge: () => (prefs.ballMode === 'game' ? 'VS' : ''),
    state: () => (prefs.ballMode === 'off' ? '给她一个球玩（再点一下进游戏模式）'
      : prefs.ballMode === 'ball' ? '球 · 再点一下进「弹弹乐」游戏模式'
        : `弹弹乐:${game.score[1]} : ${game.score[0]}（她守${game.defence === 0 ? '左' : '右'}）· 再点一下收走`),
    run: () => {
      const next = prefs.ballMode === 'off' ? 'ball' : prefs.ballMode === 'ball' ? 'game' : 'off';
      setBallMode(next, { fromUser: true });
    },
  },
  voice: {
    keep: true,
    icon: () => (prefs.voice.enabled ? ICONS.mic : ICONS.micOff),
    badge: () => (prefs.voice.enabled ? MIC_BADGE[prefs.voice.mode] ?? '' : ''),
    on: () => prefs.voice.enabled,
    state: () => (!prefs.voice.enabled ? '语音输入:关 · 点一下打开'
      : !prefs.voice.ready ? `语音输入:开,但${prefs.voice.detail || '识别服务没有就绪'} · 点一下关掉`
      : `语音输入:开(${prefs.voice.mode === 'always' ? '自动收音' : '按键收音'})· ${prefs.voice.hint || ''}`),
    run: () => toggleVoice(),
  },
  roam: {
    keep: true,
    icon: () => ICONS[`roam_${prefs.roam}`] ?? ICONS.roam_calm,
    state: () => {
      const next = ROAM_ORDER[(ROAM_ORDER.indexOf(prefs.roam) + 1) % ROAM_ORDER.length];
      return `行为模式:${ROAM_LEVEL[prefs.roam] ?? ''} · ${ROAM[prefs.roam] ?? ''} · 点一下换成「${ROAM[next]}」`;
    },
    run: () => cycleRoam(),
  },
  theme: {
    keep: true,
    icon: () => (prefs.theme === 'dark' ? ICONS.moon : ICONS.sun),
    on: () => prefs.theme === 'dark',
    state: () => (prefs.theme === 'dark' ? '夜间模式:开(浅色身体)· 点一下换白天' : '夜间模式:关(白天,深色身体)· 点一下换夜间'),
    run: () => toggleTheme(),
  },
  /**
   * The one button for everything you hear, in three steps: off → effects only → effects + speech.
   * The last step only means anything with a model connected and the speech files installed, so the
   * tooltip says which steps are actually available.
   */
  sound: {
    keep: true,
    icon: () => (prefs.sound ? ICONS.sound : ICONS.soundOff),
    badge: () => (prefs.sound && prefs.sayVoice ? 'say' : ''),
    on: () => prefs.sound,
    state: () => {
      const step = !prefs.sound ? '关' : prefs.sayVoice ? '音效 + 念出来' : '只有音效';
      const next = !prefs.sound ? '音效' : prefs.sayVoice ? '关' : (prefs.ttsOn ? '音效 + 念出来' : '关');
      return `声音:${step}${prefs.ttsOn ? '' : '（这台机器没装语音文件）'} · 点一下换成「${next}」`;
    },
    run: () => {
      const mode = !prefs.sound ? 'sfx' : prefs.sayVoice ? 'off' : (prefs.ttsOn ? 'voice' : 'off');
      applySoundMode(mode);
      send({ t: 'prefs', sound: prefs.sound, voice: mode === 'voice' ? 'voice' : 'off' });
    },
  },
  /**
   * Let the model speak on its own: the World asks it for one line a minute while you leave the pet
   * alone. It only works with a model connected, and the World stores the switch in config\settings.json.
   * The switch shows at once and the World's next `prefs` confirms it (same as the voice button).
   */
  auto: {
    keep: true,
    icon: () => ICONS.chat,
    badge: () => (prefs.autoChat ? 'auto' : ''),
    on: () => prefs.autoChat,
    state: () => `自动说话:${prefs.autoChat ? '开 · 每隔一分钟它自己说一句' : '关 · 点一下让它自己找话说(要先接上模型)'}`,
    run: () => { prefs.autoChat = !prefs.autoChat; send({ t: 'prefs', autoChat: prefs.autoChat }); },
  },
  dress: {
    icon: () => ICONS.shirt, cls: 'dress',
    state: () => '换配色、帽子、耳饰、眼镜、颈饰',
    // an embedding app that lends dressing shows its own dress page; otherwise the pet's dress window
    run: () => {
      if (prefs.bot?.buttons?.dress) send({ t: 'control', action: 'dress' });
      else if (host?.openDress) host.openDress();
      else window.open('/dress', '_blank');
    },
  },
  hide: {
    icon: () => ICONS.eyeOff, available: () => !!host?.hide,
    state: () => '先把我藏起来(托盘里可以叫我回来)',
    run: () => host.hide(),
  },
};
const available = (id) => ACTIONS[id] && (ACTIONS[id].available?.() ?? true);

/** One action as a button: its icon, the badge, and whether a switch is on. */
function drawAction(b, id) {
  const a = ACTIONS[id], on = a.on?.();
  const badge = a.badge?.() ?? '';
  b.querySelector('.ic').innerHTML = a.icon() + (badge ? `<b class="badge">${badge}</b>` : '');
  b.classList.toggle('on', on === true);
  b.classList.toggle('off', on === false);
  b.title = a.state();
  b.setAttribute('aria-label', b.title);
  if (on !== undefined) b.setAttribute('aria-pressed', String(on));
}

function cycleRoam() {
  const roam = ROAM_ORDER[(ROAM_ORDER.indexOf(prefs.roam) + 1) % ROAM_ORDER.length];
  applyPrefs({ roam });
  send({ t: 'prefs', roam });
}

function toggleTheme() {
  const theme = prefs.theme === 'dark' ? 'light' : 'dark';
  applyPrefs({ theme });
  send({ t: 'prefs', theme });
}

function toggleVoice() {
  const on = !prefs.voice.enabled;
  // shown at once; the World's next prefs confirm it
  prefs.voice = { ...prefs.voice, enabled: on };
  refreshButtons();
  send({ t: 'prefs', mic: on });
}

/* ---------- menu: the bot and its run controls on top, the actions below; every entry is a round icon button ---------- */
function openMenu(x, y) {
  menu.innerHTML = '';
  menu.appendChild(Object.assign(document.createElement('div'), { className: 'm-head' }));
  renderMenuHead();
  const grid = Object.assign(document.createElement('div'), { className: 'm-grid' });
  for (const id of Object.keys(ACTIONS)) {
    if (!available(id)) continue;
    const a = ACTIONS[id];
    const b = document.createElement('button');
    b.type = 'button'; b.setAttribute('role', 'menuitem');
    b.className = `m-tile${a.cls ? ' ' + a.cls : ''}`;
    b.dataset.action = id;
    b.innerHTML = '<span class="ic"></span>';
    drawAction(b, id);
    b.addEventListener('click', () => {
      sfx.tick();
      if (!a.keep) closeMenu();
      a.run();
      if (a.keep) drawAction(b, id);
    });
    grid.appendChild(b);
  }
  menu.append(grid);
  menu.style.width = '';
  menu.hidden = false;
  // focused, so a click anywhere else blurs the window and folds the menu
  host?.focus?.();
  // held at its opening width: the quit confirmation in the header must not widen the menu
  menu.style.width = getComputedStyle(menu).width;
  // layout size: the opening animation scales the box, so its bounding rect is still shrunk here
  const w = menu.offsetWidth, h = menu.offsetHeight;
  menu.style.left = f(clamp(x, 8, innerWidth - w - 8)) + 'px';
  menu.style.top = f(clamp(y - h, 8, innerHeight - h - 8)) + 'px';
}

/**
 * Avatar and name, then the run controls the embedding app lends, as in the console's rail foot:
 * pause/resume, settings and the power button (which asks first). Without a bot the name is Coo's.
 */
function renderMenuHead(confirmQuit = false) {
  const head = menu.querySelector('.m-head'), bot = prefs.bot || {};
  if (!head) return;
  head.classList.toggle('confirm', confirmQuit);
  head.innerHTML = '<span class="m-avatar"></span><span class="m-name"></span><span class="m-acts"></span>';
  head.querySelector('.m-avatar').innerHTML = bot.avatar
    ? `<img alt="" src="/api/avatar?v=${encodeURIComponent(bot.avatar)}">`
    : `<svg viewBox="18 18 220 220" aria-hidden="true">${mini('neutral', ctl.skin)}</svg>`;
  const name = head.querySelector('.m-name');
  name.textContent = name.title = confirmQuit ? bot.quitPrompt : (bot.name || 'Coo');
  const acts = head.querySelector('.m-acts');
  const act = (iconHtml, label, fn, cls = 'm-act') => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = cls; b.title = label; b.setAttribute('aria-label', label);
    b.innerHTML = iconHtml;
    b.addEventListener('click', (e) => { e.stopPropagation(); sfx.tick(); fn(); });
    acts.appendChild(b);
  };
  if (!bot.controls) return;
  if (confirmQuit) {
    act(ICONS.power, bot.quitLabel, () => { closeMenu(); send({ t: 'control', action: 'quit' }); }, 'm-act danger');
    act('<span>取消</span>', '取消', () => renderMenuHead(), 'm-act text');
    return;
  }
  // only the controls the embedding app lent; a server without `buttons` lends all three
  const has = bot.buttons ?? { pause: true, settings: true, quit: true };
  if (has.pause) act(bot.paused ? ICONS.play : ICONS.pause, bot.paused ? '继续(现在暂停着)' : '暂停', () => send({ t: 'control', action: bot.paused ? 'resume' : 'pause' }), `m-act run${bot.paused ? ' paused' : ''}`);
  if (has.settings) act(ICONS.settings, '打开设置', () => { closeMenu(); send({ t: 'control', action: 'settings' }); });
  // 「音色…」：拖滑杆调语速/稳定度，边调边试听（World 那边开一个单独的窗口）
  if (has.voice) act(ICONS.sound ?? ICONS.settings, '音色…', () => { closeMenu(); send({ t: 'control', action: 'voice' }); });
  if (has.quit) act(ICONS.power, bot.quitLabel, () => renderMenuHead(true), 'm-act power');
}
function closeMenu() { menu.hidden = true; }

/** Redraws whatever shows an action: the open menu's tiles and the hover buttons. */
function refreshButtons() {
  for (const b of menu.querySelectorAll('.m-tile')) drawAction(b, b.dataset.action);
  renderTools();
}

/* ---------- hover buttons: the actions the World lists in `hoverButtons` (just 「对话」 now),
   in columns of up to three beside the pet; the menu carries every action ---------- */
/** Seconds the buttons stay after the pointer leaves both the pet and them. */
const TOOLS_LINGER = .8;
/** Milliseconds the voice button is held before what was heard goes out. */
const HOLD_TO_SEND = 500;
let toolsUntil = 0;
let toolIds = '';

function renderTools() {
  const ids = prefs.hoverButtons.filter(available).slice(0, MAX_HOVER);
  if (ids.join(',') !== toolIds) {
    toolIds = ids.join(',');
    endHold();
    tools.innerHTML = '';
    // up to three in a column, then a second column
    tools.style.gridTemplateRows = `repeat(${Math.min(3, Math.max(1, ids.length))}, auto)`;
    for (const id of ids) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'tool'; b.dataset.action = id;
      b.innerHTML = '<span class="ic"></span>';
      if (id === 'voice') wireVoiceTool(b);
      else b.addEventListener('click', () => { sfx.tick(); if (!ACTIONS[id].keep) toolsUntil = 0; ACTIONS[id].run(); refreshButtons(); });
      tools.appendChild(b);
    }
  }
  for (const b of tools.children) drawAction(b, b.dataset.action);
  const mic = tools.querySelector('[data-action="voice"]');
  if (mic) mic.classList.toggle('waiting', prefs.voice.enabled && !prefs.voice.ready);
}

/** A press shorter than HOLD_TO_SEND switches voice input; a longer one sends what was heard so far. */
const hold = { timer: 0, sent: false, el: null };
function endHold() {
  clearTimeout(hold.timer);
  hold.timer = 0;
  hold.el?.classList.remove('holding');
}
function wireVoiceTool(b) {
  b.style.setProperty('--hold', HOLD_TO_SEND + 'ms');
  b.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    hold.sent = false; hold.el = b;
    if (!prefs.voice.enabled || !prefs.voice.ready) return;
    b.classList.add('holding');
    hold.timer = setTimeout(() => {
      endHold();
      hold.sent = true;
      send({ t: 'commit' });
      sfx.select();
      b.classList.remove('sent'); void b.offsetWidth; b.classList.add('sent');
    }, HOLD_TO_SEND);
  });
  b.addEventListener('pointerup', (e) => {
    if (e.button !== 0) return;
    const sent = hold.sent;
    endHold();
    hold.sent = false;
    if (!sent) { toggleVoice(); sfx.tick(); }
  });
  b.addEventListener('pointerleave', () => { endHold(); hold.sent = true; });
  b.addEventListener('pointercancel', () => { endHold(); hold.sent = true; });
  // the pointer handlers act on mouse and touch; a click with no pointer is the keyboard
  b.addEventListener('click', (e) => { if (e.detail === 0) { toggleVoice(); sfx.tick(); } });
}

/** Where the cursor is, in page pixels, or null when it is off the page. */
const cursor = { at: null };
function overTools(p) {
  if (tools.hidden) return false;
  const r = tools.getBoundingClientRect();
  // the gaps between the buttons and a little margin count too
  return p.x >= r.left - 6 && p.x <= r.right + 6 && p.y >= r.top - 6 && p.y <= r.bottom + 6;
}
function stepTools() {
  // shown while the cursor is on the pet or on the buttons, and a moment after it leaves; decided
  // from where the cursor is now, not from the last move event, which may be stale
  const p = cursor.at;
  if (p && (ctl.hitPet(p) || overTools(p))) toolsUntil = ctl.time + TOOLS_LINGER;
  tools.hidden = !(ctl.time < toolsUntil && !ctl.pressing && !ctl.busy() && menu.hidden && toolIds !== '');
  if (tools.hidden) endHold();
  tools.querySelector('[data-action="voice"]')?.classList.toggle('live', listen.phase === 'hearing');
}

/* ---------- pointer ---------- */
let pointerSeen = false;
const lastPointer = { x: 0, y: 0 };
let interactive = null;
/** `by`: which check decided, 'move' (the page's pointermove) or 'poll' (the window's cursor report). */
function setInteractive(on, by) {
  if (!host || interactive === on) return;
  interactive = on;
  host.setInteractive(on);
  logPointer('flip', by);
}

/**
 * Pointer diagnostics, one console line `[pointer] {json}` that reaches the run log: each time the
 * window switches between taking the mouse and passing it through, with what both checks last saw
 * (position, hit on the body or the UI, how long ago, and the pointerType of the move), and each
 * time the pointerType of the moves changes.
 */
const POINTER_DIAG = new URLSearchParams(location.search).has('diag');
const diag = { move: null, poll: null, type: '', types: new Set(), skipped: 0, lastAt: -Infinity, timer: 0, held: null };
/**
 * Fewest milliseconds between two lines; the lines in between are counted into the next one, and
 * the last of them is written once the gap has passed. A flickering pointer flips the window at
 * the cursor report rate (10 a second) or faster; one line a second still names the check that
 * flipped it, and an hour of flicker stays under 3600 lines.
 */
const POINTER_LOG_EVERY_MS = 1000;
function logPointer(event, by) {
  if (!POINTER_DIAG) return;
  const now = performance.now(), wait = POINTER_LOG_EVERY_MS - (now - diag.lastAt);
  diag.held = { event, by };
  if (wait <= 0) { writePointer(now); return; }
  diag.skipped++;
  diag.timer ||= setTimeout(() => { diag.skipped--; writePointer(performance.now()); }, wait);
}
/** What a check last saw, with how many milliseconds ago in place of when. */
function seen(s, now) {
  if (!s) return null;
  const { at, ...rest } = s;
  return { ...rest, ageMs: Math.round(now - at) };
}
function writePointer(now) {
  clearTimeout(diag.timer);
  diag.timer = 0;
  const c = ctl.toStage(128, 128);
  console.log('[pointer] ' + JSON.stringify({
    ...diag.held, interactive, pressing: ctl.pressing,
    move: seen(diag.move, now), poll: seen(diag.poll, now),
    pet: { x: Math.round(c.x), y: Math.round(c.y) },
    types: [...diag.types], skipped: diag.skipped,
  }));
  diag.lastAt = now;
  diag.skipped = 0;
  diag.types.clear();
}

const UI_SELECTOR = '.bubble:not([hidden]), .menu:not([hidden]), .tools:not([hidden])';
const overUi = (e) => e.target.closest && e.target.closest(UI_SELECTOR);
/** 拖着球走的状态（球不是她，所以不碰 pet-core 那套拖拽）。 */
const ballDrag = { on: false, at: null };
/** 开始 / 结束拖球：**同时**告诉球（帧率与物理都要看它）。 */
const setBallDrag = (on) => { ballDrag.on = on; ball.setDragging(on); if (!on) ballDrag.at = null; };
document.addEventListener('pointermove', (e) => {
  pointerSeen = true;
  lastPointer.x = e.clientX; lastPointer.y = e.clientY;
  const p = { x: e.clientX, y: e.clientY };
  cursor.at = p;
  // 蹭它的时候"部位"要跟着手走，所以每次移动都记一笔（戳用按下那一刻的那笔）
  touchAt.x = e.clientX; touchAt.y = e.clientY; touchAt.ok = true;
  // while the window moves to another display, moves may come in either display's coordinates; the drag shifts over once it has moved
  if (!shifting) {
    const cur = ctl.pointerMove(p);
    // 停在它身上（没按住）时原来显示 `grab`——那是在暗示"把我拎起来"，而这一刻其实是**在摸它**，
    // 所以换成手指。按住时 pointerMove 返回的是 `grabbing`，不受影响。
    stage.style.cursor = cur === 'grab' && !ctl.pressing ? 'pointer' : cur;
  }
  strokeMove(p);            // 抚摸判定与连续反馈（见上面 STROKE 那一大段）
  // 鼠标停在球上：手型给 grab（"可以拨它"），并且让窗口接鼠标
  const onBall = ball.hitTest(p.x, p.y);
  if (onBall && !ctl.pressing) stage.style.cursor = 'grab';
  // 拖动由 **stage 那一层**的监听负责（指针被 stage 捕获，事件不冒泡到 document），
  // 这里只记一下位置，供其它逻辑参考。
  if (ballDrag.on) ballDrag.at = p;
  const hit = ctl.hitPet(p) || onBall, ui = !!overUi(e);
  diag.move = { at: performance.now(), type: e.pointerType, x: Math.round(p.x), y: Math.round(p.y), hit, ui };
  diag.types.add(e.pointerType);
  if (e.pointerType !== diag.type) {
    const first = !diag.type;
    diag.type = e.pointerType;
    if (!first) logPointer('type', 'move');
  }
  setInteractive(ctl.pressing || hit || ui, 'move');
  followDrag(p);
});
/**
 * The pet window also reports where the cursor is on its own, a few times a second: a click-through
 * window may miss the move that takes the cursor off the pet (onto the taskbar, another screen),
 * and the hover buttons would then stay.
 */
host?.onCursor?.((p) => {
  cursor.at = p;
  // 顺手把全屏光标喂给身体：它靠这个"看着你的鼠标"，「黏着你」那一档也靠它知道往哪儿走
  ctl.setGaze(p);
  if (!p) {
    diag.poll = { at: performance.now(), off: true };
    if (!ctl.pressing) setInteractive(false, 'poll');
    return;
  }
  const el = document.elementFromPoint(p.x, p.y);
  const hit = ctl.hitPet(p) || ball.hitTest(p.x, p.y), ui = !!el?.closest?.(UI_SELECTOR);
  diag.poll = { at: performance.now(), x: p.x, y: p.y, hit, ui };
  setInteractive(ctl.pressing || hit || ui, 'poll');
});
stage.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  closeMenu();
  // **球优先**：点在球上就是拨球，不惊动她（她自己碰到球才算踢）
  if (ball.hitTest(e.clientX, e.clientY)) {
    setBallDrag(true);
    /**
     * ⚠️ **必须在这一层再挂一个 pointermove/pointerup**：
     * 一旦 `setPointerCapture`，指针事件**只派发给被捕获的 `stage`，不再冒泡到 `document`**，
     * 而拖动原本只挂在 `document` 上 —— 于是"球只在按下/松手附近跟一下、中间全丢"，
     * 松手时的速度也就时有时无（用户实测："丢不出去，时好时坏"）。
     */
    stage.setPointerCapture(e.pointerId);
    e.preventDefault();
    return;
  }
  // 戳的部位以按下这一刻为准：拖起来（超过 6px）就不算戳了，那时位置也已经偏了
  touchAt.x = e.clientX; touchAt.y = e.clientY; touchAt.ok = true;
  // **抓哪儿就从哪儿拎**：把"局部抓点 + 那个部位的悬挂角"一起交给 pet-core（见 GRAB_STYLE）。
  // 悬挂角的正负按左右分：在左半边抓就顺时针挂，右半边就逆时针，这样"斜拉着一只手"才顺。
  const at = petLocal(touchAt);
  dragAt.area = at ? petRegion(touchAt) : '';
  dragAt.since = 0; dragAt.said = false;
  const style = GRAB_STYLE[dragAt.area];
  const grab = at ? {
    x: clamp(at.x, 8, 248), y: clamp(at.y, 8, 250),
    hang: style ? style.hang * (at.x > 128 ? -1 : 1) : 0,
  } : null;
  if (ctl.pointerDown({ x: e.clientX, y: e.clientY }, { grab })) { stage.setPointerCapture(e.pointerId); e.preventDefault(); }
});
const up = () => { setBallDrag(false); ctl.pointerUp(); stage.style.cursor = ''; };
// 被捕获的指针事件只到这里（不冒泡到 document），所以球在这一层也要跟手、也在这一层松手
stage.addEventListener('pointermove', (e) => {
  if (!ballDrag.on) return;
  ball.drag(e.clientX, e.clientY);
  ballDrag.at = { x: e.clientX, y: e.clientY };
});
/**
 * 松手：**用按下-移动这一段里最后一次真实位移算出来的速度**去丢。
 * 这里再补一次 `drag()`（用最后那个点），并且**只有在指针真的动过时才丢** ——
 * 只是点一下球（没有位移）就当作"拨了一下"，不让它凭空飞出去。
 */
stage.addEventListener('pointerup', () => {
  if (!ballDrag.on) return;
  const at = ballDrag.at;
  setBallDrag(false);
  ball.setDragging(false);
  if (at) ball.drag(at.x, at.y);
});
/**
 * Most milliseconds a drop on another display waits for the page to take the window's new size
 * (within a pixel: fractional scales round it). The size normally arrives a frame or two after
 * the move; the cap ends the wait when the window settled at some other size, and the pet then
 * drops inside whatever size the page has.
 */
const RESIZE_WAIT_MS = 1000;
/** Waits until the page has the window size `to` gives, or RESIZE_WAIT_MS has passed, then lays the stage out again. */
async function settleSize(to) {
  const t0 = performance.now();
  while ((Math.abs(innerWidth - to.w) > 1 || Math.abs(innerHeight - to.h) > 1) && performance.now() - t0 < RESIZE_WAIT_MS) {
    await new Promise((r) => requestAnimationFrame(r));
  }
  ctl.resize();
}
const outside = (p) => p.x < 0 || p.y < 0 || p.x >= innerWidth || p.y >= innerHeight;
/** A move of the window onto the display under the cursor, while one is under way. */
let following = null;
/** True from asking for that move until the drag has shifted into the new coordinates. */
let shifting = false;
/**
 * A drag carried past the window's edge: over another display the window moves there at once, so
 * the held pet stays in sight instead of being cut off at the edge until it is let go of.
 */
function followDrag(p) {
  if (following || ctl.pet.mode !== 'drag' || !host?.followCursor || !outside(p)) return;
  shifting = true;
  following = (async () => {
    const to = await host.followCursor().catch(() => null);
    shifting = false;
    if (!to) return;
    ctl.shiftDrag(to.dx, to.dy);
    await settleSize(to);
  })().finally(() => { following = null; shifting = false; });
}
stage.addEventListener('pointerup', async (e) => {
  // the window was moving under the cursor: the release point is in the coordinates it left behind
  if (following) { await following; up(); return; }
  if (!outside({ x: e.clientX, y: e.clientY }) || ctl.pet.mode !== 'drag' || !host?.followCursor) { up(); return; }
  // let go of past the window's edge in one move: over another display the window follows and the pet drops there
  const to = await host.followCursor().catch(() => null);
  if (!to) { up(); return; }
  stage.style.cursor = '';
  // until the drop the body and bubbles still stand in the old display's coordinates
  document.body.style.visibility = 'hidden';
  try {
    await settleSize(to);
    ctl.dropAt({ x: to.x, y: to.y });
  } finally {
    document.body.style.visibility = '';
  }
});
stage.addEventListener('pointercancel', up);
document.addEventListener('pointerleave', () => { cursor.at = null; ctl.pointerLeave(); });
// **没有双击打开打字框这一条**了：连点两下本来就是在戳它（连击升级那套），双击会抢同一个手势。
// 打字走悬停那个「对话」按钮（World 那边 INIT.doubleClickChat 也是 false）。
document.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (ctl.hitPet({ x: e.clientX, y: e.clientY })) openMenu(e.clientX, e.clientY);
});
document.addEventListener('pointerdown', (e) => { if (!e.target.closest('.menu')) closeMenu(); }, { capture: true });
// clicks off the figure pass through the window to what is underneath; the window losing focus is how they show here
window.addEventListener('blur', closeMenu);
document.addEventListener('focusin', (e) => {
  if (e.target.matches?.('input, textarea')) host?.focus?.();
});
document.addEventListener('keydown', (e) => {
  // Escape and number keys belong to the input method while choosing a candidate.
  if (e.isComposing || e.keyCode === 229) return;
  if (e.key === 'Escape') {
    closeMenu();
    if (item && item.kind === 'ask') dismissAsk();
    else if (item && item.kind === 'input') closeBubble();
    return;
  }
  const typing = e.target.closest && e.target.closest('input');
  // the digit row or the number pad, whether or not Num Lock is on
  const digit = /^(?:Digit|Numpad)([1-9])$/.exec(e.code) || /^([1-9])$/.exec(e.key);
  if (item && item.kind === 'ask' && item.optsShown && !item.answered && !typing && digit && !e.ctrlKey && !e.altKey && !e.metaKey) {
    e.preventDefault();
    const b = bubble.querySelectorAll('.b-opt')[+digit[1] - 1];
    if (b) b.click();
  }
});

/* ---------- layout ---------- */
function place(el, a, extraUp, side) {
  const bw = el.offsetWidth, bh = el.offsetHeight;
  const cx = a.x + side * (bw / 2 + 10);
  const left = clamp(cx - bw / 2 + (side ? 0 : ctl.pet.facing * 26), 10, Math.max(10, innerWidth - bw - 10));
  const top = Math.max(8, a.y - bh - extraUp);
  el.style.left = f(left) + 'px';
  el.style.top = f(top) + 'px';
  el.style.setProperty('--tail', f(clamp(a.x - left, 22, bw - 22)) + 'px');
  return { left, top, bw, bh };
}
function placeTalk(it, a) {
  const bw = bubble.offsetWidth, bh = bubble.offsetHeight;
  const left = clamp(it.pinX - bw / 2, 10, Math.max(10, innerWidth - bw - 10));
  const top = Math.max(8, it.pinY - bh - 18);
  bubble.style.left = f(left) + 'px';
  bubble.style.top = f(top) + 'px';
  bubble.style.setProperty('--tail', f(clamp(a.x - left, 22, bw - 22)) + 'px');
  return { left, top, bw, bh };
}

/** Beside the body, on the right unless that runs off the screen. */
function placeTools() {
  const c = ctl.toStage(128, 128 + ctl.pet.low), reach = 104 * ctl.bounds.S + 10;
  const w = tools.offsetWidth, h = tools.offsetHeight;
  const left = c.x + reach + w <= innerWidth - 8 ? c.x + reach : c.x - reach - w;
  tools.style.left = f(clamp(left, 8, innerWidth - w - 8)) + 'px';
  tools.style.top = f(clamp(c.y - h / 2, 8, innerHeight - h - 8)) + 'px';
}
function layout() {
  if (!tools.hidden) placeTools();
  const a = ctl.anchor();
  let sayBox = null;
  // choice cards keep their bubble where it was; its tail follows Coo along the bottom edge
  if (!bubble.hidden && item?.kind === 'dialog' && item.pinX !== undefined) sayBox = placeTalk(item, a);
  else if (!bubble.hidden) sayBox = place(bubble, a, 18, 0);
  if (!heardEl.hidden) {
    const side = sayBox ? -ctl.pet.facing : 0;
    const r = place(heardEl, a, 46, side);
    const bx = r.left + r.bw / 2, by = r.top + r.bh;
    [...trail.children].forEach((d, i) => {
      const k = [.22, .5, .78][i], sz = [7, 10, 13][i];
      d.style.width = d.style.height = sz + 'px';
      d.style.left = f(a.x + (bx - a.x) * k - sz / 2) + 'px';
      d.style.top = f(a.y - 4 + (by + 4 - a.y + 4) * k - sz / 2) + 'px';
    });
  }
}

/* ---------- backdrop: a light gray halo when the body melts into what is behind it ---------- */
/** Seconds between looks at the screen around the body. */
const BACKDROP_EVERY = .8;
/** OKLab distance under which a backdrop pixel counts as the body's color. */
const SAME_COLOR = .15;
/** Share of such pixels around the body that turns the halo on (most of them), and the share it turns off below. */
const HALO_ON = .6, HALO_OFF = .45;
/** The halo's opacity when fully on. */
const HALO_STRENGTH = .5;
const petG = $('#pet'), haloFlood = $('#haloFlood');
// a window host too old to sample the screen keeps the halo on; a browser tab draws its own wall
const backdrop = { on: !!host && !host.sampleBackdrop, fixed: !!host && !host.sampleBackdrop, k: 0, busy: false, next: 0 };

const lin = (c) => (c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4);
function oklab(r, g, b) {
  r = lin(r / 255); g = lin(g / 255); b = lin(b / 255);
  const l = Math.cbrt(.4122214708 * r + .5363325363 * g + .0514459929 * b);
  const m = Math.cbrt(.2119034982 * r + .6806995451 * g + .1073969566 * b);
  const s = Math.cbrt(.0883024619 * r + .2817188376 * g + .6299787005 * b);
  return [.2104542553 * l + .793617785 * m - .0040720468 * s, 1.9779984951 * l - 2.428592205 * m + .4505937099 * s, .0259040371 * l + .7827717662 * m - .808675766 * s];
}
/** The body's color as [r, g, b], from `--skin-ink` (#rgb or #rrggbb). */
function inkRgb() {
  let h = getComputedStyle(document.documentElement).getPropertyValue('--skin-ink').trim().replace('#', '');
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  const n = parseInt(h, 16);
  return /^[0-9a-f]{6}$/i.test(h) ? [n >> 16, (n >> 8) & 255, n & 255] : null;
}
/** The figure's box in page pixels, from its geometry: the halo filter would widen its client rect. */
function bodyRect() {
  const top = Math.min(20, HEAD_TOP[ctl.skin.head] ?? 12);
  const pts = [[20, top], [236, top], [20, 256], [236, 256]].map(([x, y]) => ctl.toStage(x, y));
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}
const inflate = (r, d) => ({ x: r.x - d, y: r.y - d, width: r.width + 2 * d, height: r.height + 2 * d });
const rectOf = (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };

/** Samples a ring around the body (past the halo's reach, minus the page's own bubbles) and flips the halo. */
async function probeBackdrop() {
  const ink = inkRgb();
  if (!ink) return;
  const body = bodyRect(), S = ctl.bounds.S;
  const near = inflate(body, 4 + 34 * S), far = inflate(near, 8 + 40 * S);
  const x = Math.max(0, far.x), y = Math.max(0, far.y);
  const rect = { x, y, width: Math.min(innerWidth, far.x + far.width) - x, height: Math.min(innerHeight, far.y + far.height) - y };
  const skip = [near, ...[bubble, heardEl, menu, tools].filter((el) => !el.hidden).map(rectOf)];
  const px = await host.sampleBackdrop(rect, skip);
  // this platform cannot read the screen cheaply: the halo just stays
  if (px === null) { backdrop.on = true; backdrop.fixed = true; return; }
  const n = px.length / 3;
  if (n < 24) return;
  const [L, A, B] = oklab(...ink);
  let same = 0;
  for (let i = 0; i < px.length; i += 3) {
    const [l, a, b] = oklab(px[i], px[i + 1], px[i + 2]);
    if (Math.hypot(l - L, a - A, b - B) < SAME_COLOR) same++;
  }
  const share = same / n;
  backdrop.on = backdrop.on ? share >= HALO_OFF : share > HALO_ON;
}
function stepBackdrop(dt) {
  const now = performance.now() / 1000;
  if (host?.sampleBackdrop && !backdrop.fixed && !backdrop.busy && now >= backdrop.next && document.visibilityState === 'visible') {
    backdrop.busy = true;
    probeBackdrop().catch(() => {}).finally(() => { backdrop.busy = false; backdrop.next = performance.now() / 1000 + BACKDROP_EVERY; });
  }
  const k = backdrop.k + ((backdrop.on ? 1 : 0) - backdrop.k) * Math.min(1, dt * 6);
  backdrop.k = k < .005 ? 0 : k;
  if (backdrop.k) { haloFlood.setAttribute('flood-opacity', (backdrop.k * HALO_STRENGTH).toFixed(2)); petG.setAttribute('filter', 'url(#halo)'); }
  else petG.removeAttribute('filter');
}

/* ---------- loop ---------- */
/**
 * Frames per second: MOVING_FPS while the body moves (`ctl.moving`) and always while `lockFrameRate` is on,
 * RESTING_FPS otherwise. Each frame redraws the whole figure, so the window's CPU and GPU time grows with
 * this rate; frames do not follow the display's refresh rate.
 */
const MOVING_FPS = 60, RESTING_FPS = 30;
/** When the next frame is due (a rAF timestamp), and the gap between frames at the current rate. */
let last = performance.now(), dueAt = 0, gap = 1000 / MOVING_FPS;
/** 帧循环抛错的次数，以及上一次上报的时刻（见下面 frame 里的 try/catch）。 */
let frameFails = 0, frameFailAt = 0;
/**
 * 一帧。**整段包在 try/catch 里，而且无论抛不抛错都要把下一帧排上。**
 *
 * 为什么非这样不可：`requestAnimationFrame(frame)` 原来写在函数最后一行，任何一处抛错
 * （`stepDialog` 里取不到元素、`ctl.render()` 里的作用域错误、`layout()` 里的意外值…）
 * 都会让**整条循环当场死掉** —— 她停在那儿、不再动、也不再接鼠标，而主进程日志一切正常
 * （页面异常只上报、不重启）。HANDOVER 第 1.23 节那两次翻车就是这个症状。
 * 现在：抛错 → 记一次、节流上报（第一次 + 每 60 秒）→ 跳过这一帧剩下的步骤 → 下一帧照排。
 * 持续失败时按静止帧率（`full` 保持 false）跑，不会 60fps 空转刷屏。
 */
function frame(now) {
  // a display refresh up to a quarter gap early counts as on time, so the rate averages out over refresh rates it does not divide
  if (now < dueAt - gap / 4) { requestAnimationFrame(frame); return; }
  const dt = Math.min(.05, (now - last) / 1000); last = now;
  let full = false;
  try {
    stepActs();
    stepDialog(dt);
    stepTalkRead();
    stepTalkMotion();
    stepListen();
    stepDrag();            // 拎起来：拎久了吭一声
    stepStroke();          // 抚摸的连续反馈：爬"舒服程度"、续呼噜/爱心、判"够了"
    ctl.step(dt);
    ball.step(dt);         // 玩具球：物理 + 碰到她就踢（球在 #fx 那一层，不碰她的身体）
    ctl.render();
    ball.draw();
    game.draw();           // 弹弹乐的球门（只在游戏模式下画）
    stepBackdrop(dt);
    stepTools();
    layout();
    full = prefs.lockFrameRate || ctl.moving || ball.busy;   // 球在滚/在飞/被拖着也按 60fps
  } catch (err) {
    frameFails += 1;
    if (frameFails === 1 || now - frameFailAt > 60_000) {
      frameFailAt = now;
      report(`[帧循环抛错 第${frameFails}次] ${(err && (err.stack || err.message)) || err}`);
    }
  }
  gap = 1000 / (full ? MOVING_FPS : RESTING_FPS);
  // a frame more than a gap late starts the count again instead of drawing the missed ones back to back
  dueAt = now - dueAt > gap ? now + gap : dueAt + gap;
  // moving frames wait on display refreshes: a timer can wake late, which a body at rest hides and a moving one shows as stutter
  if (full) requestAnimationFrame(frame);
  else setTimeout(() => requestAnimationFrame(frame), Math.max(0, dueAt - gap / 4 - performance.now()));
}
ctl.render();
addEventListener('pagehide', reportPosition);
requestAnimationFrame(frame);
