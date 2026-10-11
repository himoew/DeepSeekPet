/**
 * 迷你弹弹乐（游戏模式）—— 球门、比分、她的守门与反踢。
 *
 * **为什么单独一个文件**：本会话已经在她身上（`pet-core.js` / `figure.js`）栽过两次，
 * 所以游戏逻辑一律**不往那两处塞**。这个模块通过钩子驱动：
 *
 *   `ball.js`  →  `onStep()`：每帧把球的位置/速度告诉这里；这里回设"这一脚往哪踢、多大力"
 *   `onKick()` → 她踢到球时决定要不要**蓄力飞踢**
 *   这里       →  让她**走过去 / 跳起来顶球**（`ctl.walkTo` / `ctl.act('jump')` —— `act` 收**字符串**，
 *                  传数组会静默落 `switch` 的 `default`、动作什么都不做，见 `pet-app.js` 那两处注释）
 *
 * ## 规则（简单到一眼看懂）
 *
 *   - 左右各一个球门，**开局随机**决定她守哪边，你守另一边（把她拎到另一边也算换边）；
 *   - 球进谁的网，**对面得一分**；球从"失球那一边"的门前重新开出来
 *     （用户要的："我方进球，球会默认在对方脚底下出现"）；
 *   - 她在自己半场时会主动把球踢向对面的门；**踢的力度随机**，偶尔**蓄力飞踢**（×1.7）；
 *   - 高球她**50%** 概率**跳起来用头顶**回去（只要进了她跳起来够得到的范围；太高的够不到）；
 *   - 你随时可以把球直接丢进她的门、或者把她拎到另一边 —— 那是**整蛊玩法**，规则不拦着。
 */
import { HEAD_REACH, GRAVITY, HEAD_BOX, BALL_R, JUMP_RISE, BODY_TOP } from './ball.js';

/**
 * 球门尺寸 —— **两个数都按"她能不能守住"来定**（用户实测反馈："球门太大了，随便一扔就进"）：
 *   · 高度 ≈ 她的身高（≈ 96px）：她站在门前能挡住大部分，但高球还是能过去；
 *   · 宽度只有窗口的 6%：比她的身宽（约 90px）窄一点，所以她站对位置就守得住。
 * 想让游戏更难/更容易，就动这两个数（还有 `HEAD_CHANCE` 和 `aim` 的力度）。
 */
const GOAL_W = 0.06;          // 球门宽度（占窗口宽度的比例，约 77px @1280）
const GOAL_H = 96;            // 球门高度（px，≈ 她的身高）
const ZONE = 0.5;             // 中线：她的半场 / 你的半场
/**
 * **开球点**：球从**失球那一侧的门前**开出来（门框再往外 `KICKOFF_OUT` 个窗口宽 ≈ 128px）。
 *
 * ⚠️ 下面这段是历史：它一度是个死循环，根因有两条，都已修（别再自己绕回去）。
 *
 * ⚠️ 这是本会话从**真机日志**里抓到的死循环：原来把球放在失球的门口
 * （门前 10% 窗口 ≈ 128px），而她的瞄准方向**永远是她要进攻的那个门** ——
 * 球在她刚踢进的那个门前复位，她一碰就又踢进去：
 *
 * ```
 * 15:05:29.243 进球：她进的 · 你5:她20
 * 15:05:29.658 踢球：位置 78% · 方向 右（1）   ← 复位点就在这个门前
 * 15:05:30.057 进球：她进的 · 你5:她21        ← 0.4 秒后又进一个
 * ```
 *
 * 一分钟里她刷到 23 分（用户看到的就是"比分疯涨、球总在她那边复位"）。
 * 现在治好了，规则回到用户要的：**球从失球那侧门前开出来**，但**进球方要先退回自己半场**
 * （`RETREAT_MAX_MS`，退回期间她不能碰球）—— 死循环就是这么断的。
 */
const KICKOFF_OUT = 0.10;
/**
 * **她要退回自己半场的那几秒**（她进球之后）。
 *
 * 用户定的规则："那方进球复位到哪边……进球方退回自己半场"。没有它，球复位在她刚踢进的那个门前、
 * 而她当时就站在那儿 —— 一碰又进（真机日志：一分钟 23 个球）。
 * 退回期间 **她不能碰球**（`ball.setHerTouch(false)`），球归你开。
 * 松开条件：**你碰到球**（你开球了）· 或者过了这么久（免得你不动就卡在那儿）。
 */
/**
 * **她进球之后"退回自己半场"的保险上限**（`RETREAT_MAX_MS = 15s`）。
 *
 * ⚠️ 用户实测抓到的**第二个死循环**：她进球后我只让她"退回半场 3 秒"，3 秒一到
 * 球还在她射程里（复位点就在"她进攻的那个门"前面）→ 她回去一脚又进：
 *
 * ```
 * 15:54:04 进球：她进的 · 你0 : 她37
 * 15:54:10 进球：她进的 · 你0 : 她38     ← 你只是在看文档没动鼠标，她一个人刷到 41
 * ```
 *
 * 现在按**足球规则**：**她进球 = 你开球** —— 球在你碰到之前她一直不许碰（`retreatHold`），
 * 不是"等 3 秒就放她回去"。`RETREAT_MAX_MS` 只是保险（你真的一直不动，也不能永远僵着）。
 */
const RETREAT_MAX_MS = 15000;
/**
 * **开球权**：谁进球，谁就把"下一个碰球的机会"让出去（跟足球一样：失球方开球）。
 *
 *   · **她进球** → 她退回自己半场、**她碰不到球**（`setHerTouch(false)`）→ 球归你开；
 *   · **你进球** → 球在她门前复位，**你的球拍这段时间碰不到它**（`setPaddleTouch(false)`，球画成半透明）
 *     → 让她来开。没有这条，你可以守在她门口把复位球一扫再进
 *     （真机实测比分一度 **你30:她14**，一半是这么刷出来的）。
 *
 * 松开条件：**对方碰到球**（她踢到/顶到 → 还给你；你碰到 → 她结束退回）· 或者等超时（免得对方不来就卡住）。
 */
const KICKOFF_HOLD_MS = 5000;
/** **开球权按位置解禁**：球要离开她守的那个门这么远（占窗口宽），你的球拍才恢复。0.30 ≈ 384px @1280。 */
const KICKOFF_CLEAR = 0.30;
/**
 * ★ **进球庆祝时长（ms）** —— 用户定的：**1 秒**。
 *
 * 这 1 秒里：球**冻在网里、缩着淡出**，比分弹一下，门白闪并抖两下，弹一个「你进球！/她进球！」，
 * 窗口四边内圈发光，进球音响起，她转个圈（你进就跺脚），**然后才开球**。
 *
 * 为什么必要：原来进球是"同一帧就把球挪走"，只留一个"网描边变白"——
 * 用户的原话就是"得分我们还没弄"。
 */
const CELEBRATE_MS = 1000;
/**
 * ★ **她的反应延迟**：她做"要不要起跳"的决定时，用的是这么久**之前**的球位。
 *
 * 这是"难度"的主要来源（用户："固定一个头球概率也是个问题……既要有游戏体验，又不能难度太低"）。
 * 0.18 秒 = 60fps 下 11 帧：满力球 700px/s 会在这段时间里跑 **126px** ——
 * 近身快球她来不及判、来不及起跳（这就是玩家"靠技术打过去"的第一条路）。
 *
 * 历史：180 → **160**（用户实测"比分差距还是有点大"，让她读得稍新一点）；
 * 想再难/再容易就动这个数（越小越强）。
 */
const HER_REACTION_MS = 160;
/** **顶完落地之后这么久不能再起跳**（不然她像弹簧：两次起跳之间只隔 0.11 秒）。 */
const HEAD_RECOVER_MS = 350;
/**
 * ★ **她追球时的提前量（秒）** —— 用户实测她输得太多（`你27 : 她8`）时加的。
 *
 * **为什么需要**：她跑 250px/s，球 300~700px/s，而追球逻辑原来追的是**球现在在哪**（`goTo(s.x)`）
 * → 永远差一截（你从半场抽射时她一定到不了）。给 0.25 秒提前量之后，
 * 她会往"球一会儿会到的位置"跑，地面球拦截明显变多。
 * 这不是作弊：球一停（`vx = 0`）提前量就是 0，反弹/变向时她也会跟着改口 ——
 * 想让她再强/再弱就调这个数（0 = 退回"追当前位置"）。
 */
const CHASE_LEAD_S = 0.25;
/**
 * **头球概率（每一球只掷一次，不是每帧）**：
 *   · `HEAD_EASY`：轻松球（离得近、球不快、高度顺手）≈ 必中；
 *   · `HEAD_HARD`：边缘球（要追、要抢、快球）—— 掷一次，不中她就这一球不跳了，**你就能打过去**。
 *
 * ⚠️ 为什么不能像以前那样每帧掷：球在她可达范围里会待 20~35 帧，
 * 每帧 60% 的话"整球概率" = 1 − 0.4²⁰ ≈ **100%** —— 用户实测"感觉有 100%"就是这么来的。
 *
 * 历史：0.55 → **0.65**（用户实测"现在 50 多？改成 65 左右"；真机量到的是 **54.8%**）。
 */
const HEAD_EASY = 0.95;
const HEAD_HARD = 0.65;
const CHARGE_CHANCE = 0.26;   // 蓄力飞踢的概率（0.18 → 0.26：用户要"稍微提升她的胜率"，蓄力那脚 ×1.7 走得更远）
const CHARGE_POWER = 1.7;     // 蓄力时的力度系数
/** 球高过地面这么多以内她跳得够到（**跟球那边的头球盒子对齐**，见 ball.js 的 HEAD_REACH）。 */
const REACH_JUMP = HEAD_REACH;
/**
 * **球至少要到这个高度（离地），她跳起来才够得到。**
 *
 * 头箱挂在**脚底往上 `HEAD_BOX.above`(60) ~ 150**（见 `ball.js` 的 `headBox`），
 * 球有半径 `BALL_R`(13)，所以球心到 `60 − 13 = 47` 就能碰到箱子下沿。
 * 比它低的球一律走"跑过去踢"（跳起来只会从球上方掠过）——**别再用"贴地球也跳一下"那条兜底**。
 */
const HEAD_MIN_HIGH = HEAD_BOX.above - BALL_R;   // = 47
/**
 * **起跳时序（照 `pet-core` 抄，别凭感觉写）**
 *
 *   · `act('jump')` 先把她切进 `crouch`，**蹲满 `JUMP_CROUCH`** 才真正离地；
 *   · 离地时 `vy = -JUMP_V`，空中重力 `JUMP_G` → 到最高点 `JUMP_V/JUMP_G ≈ 0.313s`；
 *   · 一次跳跃的滞空时间 `JUMP_AIR = 2v/g ≈ 0.63s`（离地到落地）。
 *
 * 所以 `control.jump()` 之后 **0.16 + 0.313 ≈ 0.47s** 她的头顶才到最高点。
 * ⚠️ 老版本只算了后半段（写 0.31s），等于她**每次早起跳 0.16 秒** —— 球到的时候她已经过了顶点在下落。
 */
const JUMP_CROUCH = 0.16;
const JUMP_V = 720;
const JUMP_G = 2300;
const JUMP_AIR = (2 * JUMP_V) / JUMP_G;
/** 头箱的半宽（跟 `ball.js` 的 `headBox` 对齐：`p.x ± 34`）。 */
const HEAD_HALF_W = 34;

const HEAD_X = 150;           // 横向差这么多以内才去顶
const WALK_EVERY_MS = 260;    // 两次改走路目标的间隔（要跟得上球，但不能每帧喊）
const WALK_EPS = 26;          // 离目标这么近就不喊了
const CHASE_OPP_MAX = 0.16;   // 球离对面门这么近（占窗口宽）就不追了 —— 追不上，回去防守
const CHASE_SELF_MAX = 0.34;  // 自己离球这么远也不追了（回防）
const DEFEND_X = 0.22;       // 回防站位：守在自己门前这条线上等（0.30 → 0.22：离门更近，更救得到球）
/**
 * 详细诊断开关：`DSP_DEBUG=1` 启动时，页面 URL 会带 `?debug=1`（见 pet-host.cjs）。
 * 平时关着 —— 一场球下来这些行会把日志淹掉。
 */
const DEBUG = (() => {
  try { return new URLSearchParams(location.search).has('debug'); } catch { return false; }
})();

/** 球往哪个门踢：她守 0（左）就踢右边（1.0），反之踢左边（0.0）。 */
const targetFor = (defence) => (defence === 0 ? 1 : 0);

export const createGame = ({ fxG, control, ball, sfx, onEvent } = {}) => {
  const g = {
    mode: 'off',              // off | ball | game
    defence: 1,               // 她守哪边：0 = 左，1 = 右
    score: [0, 0],            // [0] = 你进的球，[1] = 她进的球
    flash: 0,                 // 进球后网闪一下的计时
    noGoal: 0,                // 这个时刻之前不再判进球（开球后的冷静期，防死循环）
    lastRelease: 0,           // 球上一次"从手里松开"的时刻（用来给拖球进门限一次）
    scoredThisRelease: false, // 兼容旧字段（已不再作为"只算一次"的依据，见 onStep 里的说明）
    scoreCool: 0,             // 这个时刻之前不再计分（防同一脚连算；不是"整局只算一次"）
    /** 紧迫度（0~1）：落后越高。影响她回防的站位（落后时押得更靠前）。 */
    urgency: 0,
    /** 上一次下达的走位目标（用来判断"目标变化够大就立刻改"，见 goTo）。 */
    lastWant: 0,
    /**
     * 开球相关的记号（诊断"球复位了她不去踢"，见 `kickoff`）：
     * `kickoffStart` 开球那一刻 · `kickoffKicked` 她已经碰到了 · `kickoffLogAt` 诊断节流 ·
     * `kickoffLogDone` 报够 4 笔了 · `kickoffSide` 球从哪半边开出来的。
     */
    kickoffStart: 0, kickoffKicked: false, kickoffLogAt: 0, kickoffLogDone: false, kickoffSide: 0,
    kickoffTicks: 0,
    /**
     * **退回自己半场**：`retreatHold` 为真 = 她进球了、球权在你（她碰不到球），
     * `retreatAt` 是起始时刻（只用 `RETREAT_MAX_MS` 兜底）。见 `RETREAT_MAX_MS` 的说明。
     */
    retreatHold: false, retreatAt: 0,
    /** 开球权的截止时刻（`KICKOFF_HOLD_MS`，你进球之后设上：这段时间你的球拍碰不到球）。 */
    kickoffHoldUntil: 0,
    /**
     * **进球庆祝**（`CELEBRATE_MS`）：这 1 秒里球冻在网里、不判进球、谁都不碰球，
     * 把"进了"这件事演完再开球。`pendingKickoff` 是庆祝结束后要开球的那一侧。
     */
    celebrateUntil: 0, pendingKickoff: -1, celebrateSide: -1, celebrateScorer: -1,
    /** 比分弹一下的剩余时间（`draw` 里换算成缩放）。 */
    scorePop: 0,
    /**
     * **她被拎起来 / 刚放下时的"别追球"窗口**（`hold()`）。
     * 用户实测："哪怕拽起她放下来，立马又跑了" —— 被拎过之后她该愣两秒，
     * 而不是一落地就冲回比赛（不然根本没法把她从比赛里"拿出来"）。
     */
    holdUntil: 0,
    /** 每球一次的头球判定：`headRoll` 这一球掷过了吗 · `headRollOk` 中没中 · `headGoneAt` 球什么时候离开她的可达范围。 */
    headRoll: 0, headRollOk: false, headGoneAt: 0,
    /** 落地时刻 + 上一帧是否腾空（用来算"顶完落地 0.35 秒内不能再跳"）。 */
    headLandAt: 0, wasAir: false,
    /**
     * 自检用：强制"这一球她顶不顶"（`undefined` = 正常掷骰子，`true/false` = 强制）。
     * 别在自检里 stub 全局 `Math.random` —— 那会把 `defence` 的随机一起冻住。
     */
    headForce: undefined,
    calls: 0, tickAt: 0,      // 每帧调用次数自检（见 onStep）
    /**
     * 冷却时间戳初值 `0` = "**从来没做过**"（`goTo` 里显式判 `!(x > 0)`）。
     * 这样既不依赖 `performance.now()` 的时间轴起点，也不会把开局第一帧的指令丢掉
     * —— 之前拿 `0` 当"刚刚做过"的初值、又靠 `-Infinity` 打补丁，是自检偶发失败的真凶。
     */
    lastWalkAt: 0,
    lastHeadAt: 0,
    lastJumpLog: 0,
  };

  const NS = 'http://www.w3.org/2000/svg';
  let layer = null;
  const parts = [];           // 每个门：{ net, rect, grid, dot, builtFor }

  /* ---------- 她的"读球"缓冲：反应延迟用 ---------- */

  /**
   * 最近的球状态（每帧一条）。`HER_REACTION_MS` 之前的球位从这里取。
   *
   * 为什么要它：她的判断原来是拿**这一帧**的球位去外推，等于零反应时间 ——
   * 满力球贴着她飞她也来得及起跳（用户实测"感觉有 100%"）。
   * 给 0.18 秒延迟之后，近身快球她读到的是"126px 之前的球"，会判晚、会跳空 → 玩家能打过去。
   */
  const ballHist = [];
  function pushBallHist(now, s) {
    ballHist.push({ t: now, x: s.x, y: s.y, vx: s.vx || 0, vy: s.vy || 0, resting: !!s.resting });
    // 只留 ~1 秒，够反应延迟用；开局样本不足时就用最老的那一条
    while (ballHist.length > 90 || (ballHist.length > 2 && now - ballHist[0].t > 1000)) ballHist.shift();
  }
  /** 取"现在 − `HER_REACTION_MS`"那一刻的球状态（不够老就用最老的）。 */
  function ballDelayed(now) {
    if (!ballHist.length) return null;
    const want = now - HER_REACTION_MS;
    for (let i = ballHist.length - 1; i >= 0; i -= 1) if (ballHist[i].t <= want) return ballHist[i];
    return ballHist[0];
  }

  /** 造 SVG 元素：**必须 createElementNS**（给 SVG 元素赋 innerHTML 会落进 HTML 命名空间、画不出来）。 */
  const mk = (tag, attrs) => {
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
    return el;
  };

  function mount() {
    if (layer || !fxG) return;
    layer = mk('g', { class: 'toy-goals', 'aria-hidden': 'true' });
    for (const side of [0, 1]) {
      const net = mk('g', { class: 'toy-goal' });
      const rect = mk('rect', { class: 'toy-goal-frame', x: 0, y: 0, width: 100, height: GOAL_H });
      const grid = mk('path', { class: 'toy-goal-grid', d: gridPath(100, GOAL_H) });
      const dot = mk('circle', { class: 'toy-goal-mark', r: 6, cx: 0, cy: -16 });
      net.appendChild(rect);
      net.appendChild(grid);
      net.appendChild(dot);
      layer.appendChild(net);
      parts[side] = { net, rect, grid, dot, builtFor: 100 };
    }
    buildScore();
    buildGoalText();
    layer.setAttribute('display', 'none');
    fxG.appendChild(layer);
  }

  /* ---------- 比分牌 + 进球那一刻的大字 ---------- */

  /**
   * ★ **比分牌**（用户要的"显示分数"）：画在球场**顶部居中**，只在比赛模式显示
   * （它挂在 `layer` 里，`layer` 的 `display` 由 `setMode` 控制）。
   *
   * 形如 `你 3 : 5 小肥鱼`：左边是你的分（青蓝，跟球拍光环同色），右边是她的分（暖色）。
   * 进球时整个牌 `scale` 弹一下（`scorePop`），数字由 `draw()` 每帧写。
   */
  let score = null, scoreBg = null, scoreYou = null, scoreMid = null, scoreHer = null;
  function buildScore() {
    score = mk('g', { class: 'toy-score' });
    scoreBg = mk('rect', { class: 'toy-score-bg', x: -104, y: -17, width: 208, height: 34, rx: 17 });
    scoreYou = mk('text', { class: 'toy-score-you', x: -18, y: 0, 'text-anchor': 'end' });
    scoreMid = mk('text', { class: 'toy-score-mid', x: 0, y: 0, 'text-anchor': 'middle' });
    scoreHer = mk('text', { class: 'toy-score-her', x: 18, y: 0, 'text-anchor': 'start' });
    scoreMid.textContent = ':';
    for (const el of [scoreBg, scoreYou, scoreMid, scoreHer]) score.appendChild(el);
    layer.appendChild(score);
  }

  /** 进球那一刻在**被进的那个门上方**弹一句大字（`你进球！` / `她进球！`），1 秒里放大后淡出。 */
  let goalText = null;
  function buildGoalText() {
    goalText = mk('text', { class: 'toy-goal-text', x: 0, y: 0, 'text-anchor': 'middle' });
    goalText.setAttribute('opacity', '0');
    layer.appendChild(goalText);
  }

  /** 网线：斜网格，让它一眼看出是"网"。 */
  function gridPath(w, h) {
    const step = 18;
    let d = '';
    for (let x = step; x < w; x += step) d += `M${x} 0V${h}`;
    for (let y = step; y < h; y += step) d += `M0 ${y}H${w}`;
    return d;
  }

  /** 球门范围（舞台像素）。 */
  function goalRect(side) {
    const b = control.bounds();
    const w = Math.max(48, GOAL_W * b.W);
    const x0 = side === 0 ? b.minX : b.maxX - w;
    return { x0, x1: x0 + w, w, yTop: b.floorY - GOAL_H, yBottom: b.floorY };
  }

  /* ---------- 开关（三态） ---------- */

  /**
   * `off` → `ball`（出球自由玩）→ `game`（弹弹乐）。页面按按钮时自己循环，这里只接收。
   * World 恢复配置时直接给 `mode`（可能是任意一态）。
   */
  function setMode(mode) {
    const want = ['off', 'ball', 'game'].includes(mode) ? mode : 'off';
    if (want === g.mode) return g.mode;
    g.mode = want;
    mount();
    // **球拍模式**：比赛模式里球不能抓，只能打回去（用户的想法，正好治"拎到门口放下"）
    try { ball.setGrabable?.(want !== 'game'); } catch { /* 旧接口没有这个方法就算了 */ }
    // 报一句给主进程（`data\pet-host.log`）：切没切过去、比分多少、她守哪边，一眼可见
    try { globalThis.petHost?.report?.(`[弹弹乐] 模式=${want} 她守=${want === 'game' ? (g.defence === 0 ? '左' : '右') : '-'} 比分 你${g.score[0]}:她${g.score[1]}`); } catch { /* 报告失败就算了 */ }
    if (want === 'off') {
      ball.setOn(false);
      ball.setAim({ x: null, power: 1 });              // 回到自由玩球的行为
      if (layer) layer.setAttribute('display', 'none');
      onEvent?.('mode', { mode: want, defence: g.defence, score: [...g.score] });
      return g.mode;
    }
    if (!ball.on) ball.setOn(true, { fromLeft: Math.random() < .5 });
    if (want === 'ball') {
      if (layer) layer.setAttribute('display', 'none');
      ball.setAim({ x: null, power: 1 });              // 自由玩球：不受瞄准约束
    } else {
      g.defence = Math.random() < .5 ? 0 : 1;          // **开局随机**决定她守哪边
      g.score = [0, 0];
      if (layer) layer.setAttribute('display', '');
      // 新的一局：把"退回半场 / 每球一次的头球判定 / 落地恢复"全部复位
      g.retreatHold = false; g.retreatAt = 0; g.headRoll = 0; g.headGoneAt = 0; g.headLandAt = 0; g.wasAir = false;
      g.kickoffHoldUntil = 0; g.holdUntil = 0;
      // 比分牌 / 进球庆祝（`flash` / `scorePop` / `celebrateUntil`）也一起复位
      g.flash = 0; g.scorePop = 0; g.celebrateUntil = 0; g.pendingKickoff = -1;
      for (const p of parts) if (p) p.flash = false;
      /**
       * 球也要解冻：**庆祝到一半切模式**（比如直接从 game 切到 off）时，
       * 球会一直冻在网里（`celebrateUntil` 被清了、但 `frozen` 还开着）→ 再切回比赛球就永远不动。
       */
      ball.setFrozen?.(false);
      ball.setCelebrate?.(0);
      ball.setHerTouch?.(true);
      ball.setPaddleTouch?.(true);
      control.walkTo(g.defence === 0 ? 0.28 : 0.72);   // 先走到自己那半场
      kickoff(1 - g.defence);                          // 球从"你这边"先开出来
    }
    onEvent?.('mode', { mode: want, defence: g.defence, score: [...g.score] });
    return g.mode;
  }

  /**
   * 开球：球放到**失球那一侧的门前**（门框再往外 `KICKOFF_OUT` ≈ 128px，**门框之外**！），
   * 静止，并给一段"不判进球"的冷静期。
   *
   * 这里一定要落在门框外面：落在门里的话，下一帧又会判进球 → 死循环（实测卡死）。
   * "她进球后一碰又进"那个死循环不在这里解决，而在 `retreatHold`（她要先退回自己半场、球权在你）。
   */
  function kickoff(side) {
    const b = control.bounds();
    const gr = goalRect(side);
    const near = side === 0 ? gr.x1 + b.W * KICKOFF_OUT : gr.x0 - b.W * KICKOFF_OUT;
    ball.placeAt(Math.min(0.94, Math.max(0.06, near / b.W)), 'floor', { since: 0 });
    g.noGoal = performance.now() + 500;
    /**
     * 开球相关的三个记号 —— **别再拿一个字段当三种用途**（原来 `kickoffAt` 既当"开球时刻"、
     * 又被诊断块改成"上次写日志的时刻"，于是"开球后多久"永远算不准）：
     *   `kickoffStart` 开球时刻 · `kickoffLogAt` 诊断节流 · `kickoffKicked` 她已经碰到了
     */
    g.kickoffStart = performance.now();
    g.kickoffLogAt = g.kickoffStart;
    g.kickoffLogDone = false;
    g.kickoffKicked = false;
    g.kickoffTicks = 0;
    g.kickoffSide = side;
    g.lastWant = 0;                                    // 目标失效 → 下一帧一定重新下达
  }

  /* ---------- 每帧：判进球 + 她的行动 ---------- */

  /**
   * **她该往哪走**（纯函数，只依赖"球在哪、她在哪、她守哪边"，再加一个"紧迫度"）。
   *
   * 用户实测反馈："抢球逻辑与得分、回防要取得均衡，让人觉得是在比赛" ——
   * 老写法只有"追 / 回防"两种，而且边界很硬：球一过中线就整段回防，看着像不上心。
   * 现在分四档（**都是"立刻跑"，不站着看**）：
   *
   *   · `intercept`：球在她半场 → 冲过去抢（这是最优先的）
   *   · `chase`    ：球在对面但**还够得着**（离对面门还远、她自己也不远）→ 继续追，这一脚可能就进
   *   · `press`    ：球在对面、她够不着 → **压到中线附近**（不是缩在门前），球一过来就能先抢到
   *   · `defend`   ：球**已经贴到对面门口**（她追不上了）→ 退回自己门前
   *
   * `urgency`（0~1，来自比分：落后越高）会把"回防的站位"往**前**推一点 ——
   * 落后时她会押得更靠前，看着更像在拼。
   *
   * @returns {{x:number, run:boolean, why:'intercept'|'chase'|'press'|'defend'}}
   */
  function plan(x, petX, defence, urgency = 0) {
    const b = control.bounds();
    const u = Math.min(1, Math.max(0, urgency));
    const herZone = defence === 0 ? x < b.minX + ZONE * b.W : x > b.maxX - ZONE * b.W;
    if (herZone) return { x, run: true, why: 'intercept' };      // 球在她半场：抢
    const oppGoalX = defence === 0 ? b.maxX : b.minX;
    const dOpp = Math.abs(x - oppGoalX);
    const dSelf = Math.abs(x - petX);
    // 还够得着：继续追（这一脚有机会进）
    if (dOpp > b.W * CHASE_OPP_MAX && dSelf < b.W * CHASE_SELF_MAX) return { x, run: true, why: 'chase' };
    // 贴到对面门口：追不上 → 回自己半场（紧迫度高时站位往前压）
    if (dOpp <= b.W * CHASE_OPP_MAX) {
      const line = DEFEND_X + u * 0.14;                          // 0.30 → 0.44（落后时更靠前）
      const backX = defence === 0 ? b.minX + b.W * line : b.maxX - b.W * line;
      return { x: backX, run: true, why: 'defend' };
    }
    // 够不着但球还在中场：压到中线附近等（**不是缩在门前**），球一进她的半场就能先抢到
    const pressX = defence === 0 ? b.minX + b.W * 0.42 : b.maxX - b.W * 0.42;
    return { x: pressX, run: true, why: 'press' };
  }

  function onStep(s) {
    if (g.mode !== 'game') return;
    const b = control.bounds();
    const pet = control.pet();
    const now = performance.now();
    if (g.flash > 0) g.flash -= s.dt;
    if (g.scorePop > 0) g.scorePop -= s.dt;
    pushBallHist(now, s);                 // 她的"反应延迟"要靠这段历史（见 ballDelayed）

    /**
     * ★★ **进球庆祝**（`CELEBRATE_MS`）—— 必须在**进球判定之前**：
     * 球这会儿正**冻在网里**，判定又是"圆和门框相交"，不先拦掉的话过了 `scoreCool` 就会**再算一次分**。
     * 这 1 秒里：推进球的"缩着淡出"、不跑任何比赛逻辑（她也不追球）、不判进球。
     * 到点了才 `kickoff()` 开球，并按球权规则把两边的碰球打开（见进球那段）。
     */
    if (g.celebrateUntil) {
      if (now < g.celebrateUntil) {
        ball.setCelebrate?.(1 - (g.celebrateUntil - now) / CELEBRATE_MS);
        return;
      }
      g.celebrateUntil = 0;
      ball.setCelebrate?.(0);
      ball.setFrozen?.(false);
      ball.setHerTouch?.(!g.retreatHold);
      ball.setPaddleTouch?.(!g.kickoffHoldUntil);
      const side = g.pendingKickoff;
      g.pendingKickoff = -1;
      kickoff(side);                                   // 从失球那一边重新开出来
      return;
    }

    /**
     * **每帧调用次数自检**：正常是 1 帧 1 次（30~60 次/秒）。
     * 如果这里每秒几百上千次，说明帧循环被"递归/重入"了 ——
     * 症状是**人物不动、但语音还在响**（语音在 worker 里，主线程卡住它照样出声）。
     * 这一条能在卡死前把线索写进日志。
     */
    g.calls = (g.calls || 0) + 1;
    if (now - (g.tickAt || 0) > 1000) {
      g.tickAt = now;
      if (g.calls > 200) {
        try { globalThis.petHost?.report?.(`[弹弹乐] onStep 每秒 ${g.calls} 次（正常 30~60）——帧循环疑似重入/递归`); } catch { /* ignore */ }
      }
      g.calls = 0;
    }
    // 每次"从手里松开"只给一次进球机会：不然把球慢慢推过门线会每帧算一次分（分数疯涨）
    const releasedAt = ball.releasedAt || 0;
    if (releasedAt !== g.lastRelease) { g.lastRelease = releasedAt; g.scoredThisRelease = false; }

    /** **开球权等超时**：她没来踢（或者球滚到别处去了），不能一直锁着你的球拍。 */
    if (g.kickoffHoldUntil) {
      /**
       * **按位置解禁**（用户实测："她开的第一球我刷分的概率超级高"）。
       *
       * 复位点就在她门口、也正是你的射门点；而"她碰到球就把球拍还给你"那条等于
       * **20ms 就还给你了**（她本来就站在门口）→ 你一扫又进。所以改成：
       * **球离开她那个防区**（`KICKOFF_CLEAR` 个窗口宽 ≈ 384px）才还给你；或者等超时
       * （她要是被压在别处没来踢，不能一直锁着你的球拍）。
       */
      const grHold = goalRect(g.defence);                       // 她守的那个门（球就复位在这门口）
      const cleared = Math.min(Math.abs(s.x - grHold.x0), Math.abs(s.x - grHold.x1)) > b.W * KICKOFF_CLEAR;
      if (cleared || now > g.kickoffHoldUntil) {
        g.kickoffHoldUntil = 0;
        ball.setPaddleTouch?.(true);
        try { globalThis.petHost?.report?.(`[弹弹乐] 开球权${cleared ? '（球已经离开她的防区）' : '（等超时，她没来开）'} → 还给你`); } catch { /* ignore */ }
      }
    }

    /**
     * ★ **她刚才被拎起来 / 刚放下：这两秒别追球**（`hold()`，见 `pet-app.js` 的抓取/松手）。
     * 放在走位逻辑之前：这一段时间**不发走位指令、也不起跳**，她就站在原地。
     */
    if (g.holdUntil && now < g.holdUntil) return;

    // 紧迫度：落后越多越拼（影响她回防的站位，见 plan()）
    g.urgency = Math.max(0, Math.min(1, (g.score[1 - g.defence] - g.score[g.defence]) / 3));
    /**
     * 1) 进球判定 = **球（圆）与门框（矩形）相交**。
     *
     * ⚠️ 原来判的是"**球心**低于门框顶"（`s.y >= grTop - 6`），那是我把门高改成 96px 之后留下的 bug：
     * 球心要降到离地 96px 以内才算进 —— 而从上方飞来的球，**球心还没降那么低，就先被地面反弹弹走了**，
     * 于是判定永远不触发。用户实测："进球不触发归位了，球不会复位。"
     * 改成"圆与矩形相交"之后，只要**球碰到门框范围**就算进（左门柱、右门柱、横梁以下）。
     */
    if (!s.dragging) {
      const r = s.R || 13;
      for (const side of [0, 1]) {
        const gr = goalRect(side);
        const overlapX = s.x + r >= gr.x0 && s.x - r <= gr.x1;
        const overlapY = s.y + r >= gr.yTop;
        if (!overlapX || !overlapY) continue;
        /**
         * ★ **开球后有一小段时间不再判进球**（`g.noGoal`）。
         * 没有它就会死循环：球停在门里 → 判进球 → 开球（球还在门的横坐标范围内）→ 又判进球……
         * 实测症状就是"球一进网就卡死"。**这条是硬保险，别删。**
         */
        if (now < (g.noGoal || 0)) continue;
        /**
         * 同一脚只算一次：用**时间**兜住（不是用"松手"标志）。
         *
         * ⚠️ 上一版是 `scoredThisRelease`，只在球的 `releasedAt`（**松手**）变化时清掉 ——
         * 可比赛模式是"扫球"，**根本不松手**，于是第一次进球之后那个标志永远是 true，
         * **后面的球一个都不算**（用户实测："依旧没有复位功能"）。这就是真因。
         * 现在改成：进一个球之后 0.7 秒内不再计分（足够球被开走、也不会漏掉真实的连击）。
         */
        if (now < (g.scoreCool || 0)) continue;
        g.scoreCool = now + 700;
        /**
         * ★ **球进谁的门，对面得一分** —— `side` 是"球进的那个门"，`g.defence` 是**她守的门**。
         * 所以：进她的门 → **你**得分（`scorer = 0`）。
         *
         * ⚠️ 原来是 `1 - side`：那条只在"她守右边（`defence === 1`）"时才等于正确答案，
         * 而守哪边是**开局掷硬币**的 —— 于是**一半的球局整局计分是反的**：
         * 球进她守的门算**她**得分，同时她按 `targetFor(0)=1` 把球踢向"你得分"的那个门
         * （探针实测：`defence=0`、球进她守的左门 → `scorer=1` → 你0:她1）。
         * 用户定的规则："我进她的球门，我得分。" 这条现在两个方向都对。
         */
        const scorer = side === g.defence ? 0 : 1;
        g.score[scorer] += 1;
        /**
         * ★ **进球庆祝**（`CELEBRATE_MS`，用户定的 1 秒）—— 这一段是"得分"的主体：
         *   ① 球**冻在网里**（`setFrozen`），并且这 1 秒里**缩着淡出**（`setCelebrate`，draw 里推进）；
         *   ② 比分组弹一下（`scorePop`）；门白闪并抖两下（`flash`，CSS 里）；
         *   ③ 弹一个「你进球！/她进球！」（`draw` 里按 `celebrateSide/Scorer` 画）；
         *   ④ 窗口四边内圈发光（页面收到 `goal` 事件时点一次，见 `pet-app.js` 的 `goalGlow`）；
         *   ⑤ 音：**你进 = `sfx.goal()`（上行欢呼）· 她进 = `sfx.concede()`（下行的"被进了"）**；
         *   ⑥ 她的即时动作：**她进 = 转个圈（spin）· 你进 = 跺一下（shake）**；
         *   ⑦ 开球推迟到这 1 秒之后（`pendingKickoff`）—— 原来"同一帧就把球挪走"，什么都看不见。
         */
        g.flash = CELEBRATE_MS / 1000;
        g.scorePop = 0.45;
        g.celebrateUntil = now + CELEBRATE_MS;
        g.pendingKickoff = side;
        g.celebrateSide = side;
        g.celebrateScorer = scorer;
        if (scorer === 0) sfx?.goal?.(); else sfx?.concede?.();
        try { control.act?.(scorer === 1 ? 'spin' : 'shake'); } catch { /* 她正忙就算了 */ }
        // 庆祝期间**谁都不能碰球**（球冻着，两边的碰球都先关掉；庆祝结束后按下面那套球权再打开）
        ball.setFrozen?.(true);
        ball.setCelebrate?.(0);
        ball.setHerTouch?.(false);
        ball.setPaddleTouch?.(false);
        /**
         * ★ **进球方退回自己半场**（用户定的规则）—— 这套球权**在庆祝结束、开球那一刻生效**。
         *
         * 球是放在**失球那一侧门前**的，所以：
         *   · **她进的**（`scorer === 1`）→ 球在你这边门前，但**她当时就站在那儿**
         *     （她是近距离踢进去的）→ 不治的话她一碰又进（真机：一分钟 23 个球）。
         *     所以：她必须退回自己半场，而且**退回期间不能碰球** → 球归你开。
         *   · **你进的**（`scorer === 0`）→ 球在她门前，**要的就是她主动来踢出去**
         *     （用户："复位到小肥鱼那边她能够主动踢过来"）→ 不设退回，把碰球权还给她。
         */
        if (scorer === 1) {
          g.retreatHold = true;                    // 她退回自己半场，**直到你碰到球**（见 RETREAT_MAX_MS）
          g.retreatAt = now;
          g.kickoffHoldUntil = 0;
          try { globalThis.petHost?.report?.('[弹弹乐] 她进球 → 庆祝 1 秒后她退回自己半场、球权在你'); } catch { /* ignore */ }
        } else {
          g.retreatHold = false;
          g.kickoffHoldUntil = now + CELEBRATE_MS + KICKOFF_HOLD_MS;
          try { globalThis.petHost?.report?.(`[弹弹乐] 你进球 → 庆祝 1 秒后开球权给她（球离开她防区前你的球拍碰不到它）`); } catch { /* ignore */ }
        }
        onEvent?.('goal', { side, scorer, score: [...g.score], defence: g.defence });
        return;                                        // ★ 不在这里开球了：庆祝走完才开（见 onStep 顶部）
      }
    }

    // 2) 瞄准：球在场上时，她一脚就往对面的门踢（力度随机在 ball 里，蓄力在 onKick 里）
    ball.setAim({ x: targetFor(g.defence), power: 1 });
    const herZone = g.defence === 0 ? s.x < b.minX + ZONE * b.W : s.x > b.maxX - ZONE * b.W;
    /**
     * ★ **她要跑去的不是"球现在在哪"，而是"球一会儿会在哪"**（`CHASE_LEAD_S` 的说明见文件顶部）。
     * 球停着时 `vx = 0` → 提前量自动为 0；只在球真的在飞的时候才提前。
     * 走位档位也用这个位置判断（球已经飞进她半场时她会直接算"抢"，而不是"压上"）。
     */
    const leadX = Math.min(b.maxX - 24, Math.max(b.minX + 24, s.x + (s.vx || 0) * CHASE_LEAD_S));
    const herZoneLead = g.defence === 0 ? leadX < b.minX + ZONE * b.W : leadX > b.maxX - ZONE * b.W;
    const gr = goalRect(g.defence);
    const netX = (gr.x0 + gr.x1) / 2;
    const high = b.floorY - s.y;                       // 球离地多高
    /**
     * **追球要积极**（用户实测："人物不会踢过来了""追到一半就停下，有点保守"）。
     *
     * 老写法的毛病：球不在她半场就 `return`（站在那儿看着）；球一变位置就每 700ms 喊一次新目标，
     * 她一走一停，看着很犹豫。现在：
     *   · 球在**她半场**：直接去球那儿（地滚球去踢、高球就跳顶）；
     *   · 球在**对面半场**：她也**往中线靠**（准备接），而不是杵在门里；
     *   · 目标每 `WALK_EVERY_MS` 才更新一次，而且离目标 26px 以内就不喊 —— 走起来才果断。
     */
    const goTo = (x, force, run) => {
      const want = Math.min(b.maxX - 24, Math.max(b.minX + 24, x));
      if (!force && Math.abs(want - pet.x) < WALK_EPS) return;
      /**
       * ⚠️ **别只写 `now - g.lastWalkAt < WALK_EVERY_MS`**：那样"从来没走过"就得靠
       * `0` 或 `-Infinity` 编码，两种都有坑 ——
       *   · 用 `0` 当"刚刚走过"：`performance.now()` 在页面刚起来（或自检跑得飞快）时很小，
       *     于是 `now - 0 < 320` 成立 → **指令被静默丢掉**（自检偶发失败、真机刚开局她可能不动）；
       *   · 用 `-Infinity` 打补丁：能跑，但意图藏起来了。
       * 所以这里**显式判断"从来没走过"**（`0` 就是没走过），再谈间隔。
       */
      const never = !(g.lastWalkAt > 0);
      /**
       * **目标变化够大就直接改**（不等节流）。
       * 开球之后球会跳到很远的地方，而 260ms 的节流会把新目标吞掉 ——
       * 用户实测的现象就是"**球复位了她不知道去踢**"（她还照旧走向旧目标点）。
       */
      const far = !(g.lastWant > 0) || Math.abs(want - g.lastWant) > b.W * 0.08;
      if (!force && !never && !far && now - g.lastWalkAt < WALK_EVERY_MS) return;
      g.lastWalkAt = now;
      g.lastWant = want;
      control.walkTo(want / b.W, !!run);
    };

    /**
     * ★ **退回自己半场**（她进球之后，见 `RETREAT_MAX_MS`）。
     *
     * 这一段要在"追球 / 起跳"之前：退回期间她**不追球、也不起跳**，
     * 只有一件事 —— 跑回自己那半场（球归你开）。碰到球就把退回解除（见 `onKick`）。
     */
    if (g.retreatHold) {
      if (now - (g.retreatAt || 0) > RETREAT_MAX_MS) {
        g.retreatHold = false;
        ball.setHerTouch?.(true);
        try { globalThis.petHost?.report?.('[弹弹乐] 她退了 15 秒你都没碰球 → 放她回去自己踢'); } catch { /* ignore */ }
      } else {
        const backX = g.defence === 0 ? b.minX + b.W * DEFEND_X : b.maxX - b.W * DEFEND_X;
        goTo(backX, false, true);
        return;
      }
    }

    /**
     * **跳起来接球（预判起跳）** —— 这是用户实测后定下来的做法。
     *
     * 用户的原话："很少触发头球，有一次触发了球已经过去很久了……除非在她的头前面加判定区域，
     * 比如一道判断墙，球飞过 50% 触发跳跃。" —— 诊断完全正确，问题就是**时序**：
     * 球 400px/s，150px 的反应区只有 0.37 秒，而跳起来要 ≈0.47 秒才到最高点，
     * **等球进了那个范围再跳，头到位置时球早飞过去了**。
     *
     * 所以起跳是**算出来的**，不是"球近了就跳"：
     *   · 老版本用"球还有多久到她"（`tHit`）→ 快球算出 0.05s 被排除（"快球来了她不跳"）；
     *   · 中间版本用"球在她顶点时的高度"→ 快照式判断，头箱在她头顶时永远差一截（见下）；
     *   · 现在是**相遇扫描**（`willHead`），把整跳里每一次可能相遇的时刻都算一遍。
     *
     * 另外**只接"你丢/踢过来的球"**：她自己踢出去又反弹回来的球不算来球，
     * 否则她等于凭空多出一次顶球机会（`ball.lastRelease` 就是干这个的）。
     */
    /**
     * **她该不该现在起跳：把"这一跳里每一次可能相遇的时刻"都算一遍。**
     *
     * ⚠️ 为什么不是"算球在最高点那一刻在哪"：那是**快照**式的判断，只在"球正好在她顶点的高度"
     * 时成立。头箱挂在**她头顶**（脚底往上 60~150），顶点时箱子扫到离地 **173~263**，
     * 而球能到的最高点只有 **163**（满力 vy=700、球重力 1500）—— 于是"顶点快照"永远差一截：
     * 她跳起来、箱子从球上方 60px 处掠过去（探针实测：4 种来球全部命中 0 次）。
     *
     * 现在改成**相遇扫描**：在她这一跳（先蹲 0.16s，然后 0.63s 滞空）的整段时间里，
     * 按她的抛物线算每一刻 `rise`（脚底离地多高）→ 那一刻箱子覆盖离地 `rise+60 ~ rise+150`；
     * 同时按球的抛物线算那一刻球在哪、多高 —— **只要存在某一刻两者重叠，现在就该跳。**
     * 这样"球从下面飞过来、她的头在上升途中迎上去"这种情况也能算进来（那才是真正好看的顶球）。
     *
     * 横向也一起算（她这时也在往球那边跑，所以留了点余量）。
     *
     * @returns {boolean} 现在起跳的话，这一跳里有没有一刻能顶到球
     */
    /**
     * ⚠️ **她读的是"0.18 秒之前"的球**（`HER_REACTION_MS`）：下面这一整段判断都用延迟样本 `sDec`，
     * 而不是这一帧的 `s`。球速越快、越近身，她读到的东西就越过时 —— 这就是玩家的活路。
     * （路线/走位仍然用实时位置：她"眼睛"慢，但"腿"不受影响。）
     */
    const sDec = ballDelayed(now) || s;
    const highDec = b.floorY - sDec.y;
    const willHead = (() => {
      if (sDec.resting) return false;
      const herX = pet.x;
      const vx = sDec.vx || 0, vy = sDec.vy || 0;
      for (let k = 0; k <= 12; k += 1) {
        const t = JUMP_CROUCH + (JUMP_AIR * k) / 12;         // 从"离地那一刻"扫到"落地"
        const air = t - JUMP_CROUCH;
        // 她的脚底离地多高（抛物线，落地即 0）
        const rise = Math.max(0, JUMP_V * air - 0.5 * JUMP_G * air * air);
        // 球在那一刻离地多高、在哪（球的抛物线：重力是 ball.js 的 GRAVITY）
        const ballHigh = b.floorY - (sDec.y + vy * t + 0.5 * GRAVITY * t * t);
        const ballX = sDec.x + vx * t;
        /**
         * ⚠️ **球的下沿还在她身体盒以下时不跳**：那一刻她的脚会先碰到球（`kickIfTouching` 里
         * 头球之后就是身体盒），跳了也是白跳 —— 探针实测过一幕：球从她右边 60px、离地 49px 飞过，
         * 她起跳（蹲着那 0.16s 头箱还没生效），**脚先把球踢走了**，球直接往右飞回去。
         * 这种球该走"跑过去踢"。
         */
        if (ballHigh - BALL_R <= BODY_TOP) continue;
        // 纵向：箱子 [rise+60, rise+150] 与球（半径 BALL_R）的重叠（留 3px 余量）
        if (ballHigh + BALL_R < rise + HEAD_BOX.above - 3) continue;
        if (ballHigh - BALL_R > rise + HEAD_BOX.above + HEAD_BOX.h + 3) continue;
        // 横向：箱子半宽 + 球半径 + 一点余量（她这一刻通常还在往球那边跑）
        if (Math.abs(ballX - herX) < HEAD_HALF_W + BALL_R + 16) return true;
      }
      return false;
    })();
    /**
     * 球就在她头顶那一片（来不及预判了）：也跳一下碰运气。
     *
     * ⚠️ **下限必须是"头箱的最低点 − 球半径"**（`HEAD_MIN_HIGH` = 47），不能用"贴地球"那条线：
     * 40px 高的球是地滚球，而头箱在脚底往上 60~150 —— 她跳起来、头从球上方很远掠过、永远顶不到，
     * 看起来就是"球都飞走了她才跳"。贴地球走"跑过去踢"，不跳。
     */
    const above = !sDec.resting && highDec > HEAD_MIN_HIGH && highDec < REACH_JUMP && Math.abs(sDec.x - pet.x) < HEAD_X;
    const canHead = willHead || above;
    /**
     * **诊断：高球来了但没跳的原因**（`DSP_DEBUG=1` 时才记，1 秒最多一条）。
     * 用户实测"跑步时她不会触发头球" —— 这一行能分清是
     *   ① 条件没满足（球超出可达范围）、② 概率没中、还是 ③ 跳了但被跑动打断。
     */
    const mvNow = control.move ? control.move() : null;
    if (DEBUG && !s.resting && high > HEAD_MIN_HIGH && Math.abs(s.x - pet.x) < HEAD_X + 80
      && now - (g.headLogAt || 0) > 1000) {
      g.headLogAt = now;
      try {
        /**
         * **几何核对**：把"她的头箱"和"球箱"的**实际区间**摆在一起（都换算成"离地高度"）。
         * 数字必须跟 `ball.js` 的 `headBox()` 一致：箱子挂在**脚底往上 `above ~ above+h`**。
         */
        const feet = Number.isFinite(mvNow?.feetY) ? mvNow.feetY : b.floorY;
        const head = { y0: feet - (HEAD_BOX.above + HEAD_BOX.h), y1: feet - HEAD_BOX.above };
        const ball = { y0: s.y - BALL_R, y1: s.y + BALL_R };
        const overlap = Math.min(head.y1, ball.y1) - Math.max(head.y0, ball.y0);
        globalThis.petHost?.report?.(`[弹弹乐·几何] 球离地=${Math.round(high)} 她脚底离地=${Math.round(b.floorY - feet)}`
          + ` · 头箱 ${Math.round(b.floorY - head.y1)}~${Math.round(b.floorY - head.y0)}(离地)`
          + ` · 球箱 ${Math.round(b.floorY - ball.y1)}~${Math.round(b.floorY - ball.y0)}(离地)`
          + ` → 纵向重叠=${Math.round(overlap)}px ${overlap > 0 ? '能碰到' : '错开!'}`
          + ` · 横向差=${Math.round(Math.abs(s.x - pet.x))} · 她=${mvNow ? mvNow.mode : '?'}`);
      } catch { /* ignore */ }
    }
    /**
     * ★ **每球只掷一次骰子**（不是每帧），而且"轻松球"接近必中、"边缘球"才掷。
     *
     * ⚠️ 为什么必须改成每球一次：球在她可达范围里会待 **20~35 帧**，
     * 每帧掷 60% 的话"整球概率" = 1 − 0.4²⁰ ≈ **100%** —— 用户实测"感觉有 100%"就是这个原因。
     * 现在：`headRoll` 记住"这一球已经判过了"，球**连续 0.25 秒**离开可达范围才允许给下一球重判。
     */
    if (!canHead) {
      if (!g.headGoneAt) g.headGoneAt = now;
      else if (now - g.headGoneAt > 250) { g.headRoll = 0; g.headRollOk = false; }
    } else {
      g.headGoneAt = 0;
      if (!g.headRoll) {
        g.headRoll = 1;
        /**
         * 这一球有多难：**她现在离球多远 · 球多快 · 球多高**。
         * 都顺手 → 轻松球（`HEAD_EASY`）· 要追要抢或者是个快球 → 边缘球（`HEAD_HARD`）。
         */
        const spd = Math.hypot(sDec.vx || 0, sDec.vy || 0);
        const dist = Math.abs(sDec.x - pet.x);
        /**
         * "轻松球"＝**她本来就在球边上、球不快、高度顺手** → 几乎必顶。
         * 阈值放宽过一轮（110/380/190 → **150/520/190**）：真机量到 573 次判定里只有 **8 次**是轻松球 ——
         * 也就是说这一档几乎没生效，等于全场都在掷同一个 55%。放宽之后正对她的球才真的是"必顶"。
         */
        const easy = dist < 150 && spd < 520 && highDec < 190;
        /**
         * 骰子：`g.headForce` 是**只给自检用的**开关（`game.debug.headForce = true / false`）——
         * 端到端那条用例要能分别验"判定成功 → 顶到"和"判定失败 → 她照常追球不跳"。
         * 别在自检里 stub 全局 `Math.random`（那会把 `defence` 的随机也冻住，自检会死循环）。
         */
        g.headRollOk = typeof g.headForce === 'boolean'
          ? g.headForce
          : Math.random() < (easy ? HEAD_EASY : HEAD_HARD);
        // 每球一行（低频、只在她真有机会碰到球的时候写）：下一轮调难度全靠它
        try {
          globalThis.petHost?.report?.(`[弹弹乐·头球判定] ${easy ? '轻松球' : '边缘球'} → ${g.headRollOk ? '顶' : '不顶'}`
            + ` · 球离她 ${Math.round(dist)}px · 球速 ${Math.round(spd)} · 球离地 ${Math.round(highDec)}px`
            + `（她读的是 ${HER_REACTION_MS}ms 前的球）· 实时球离地 ${Math.round(high)}px`);
        } catch { /* ignore */ }
      }
    }

    /** 落地恢复：她腾空 → 落地的瞬间记一笔，之后 `HEAD_RECOVER_MS` 内不再起跳（不然她像弹簧）。 */
    const feetNow = Number.isFinite(mvNow?.feetY) ? mvNow.feetY : b.floorY;
    const airborne = b.floorY - feetNow > 6;
    if (g.wasAir && !airborne) g.headLandAt = now;
    g.wasAir = airborne;
    const recovered = !(g.headLandAt > 0) || now - g.headLandAt > HEAD_RECOVER_MS;

    /**
     * 起跳。**只有真的跳起来了（或她本来就在空中/蹲着），这一帧才停下走位。**
     *
     * ⚠️ 这里修的是"她站着不动"那个 bug：原来只要 `canHead` 成立就 `return`，
     * 而 `control.jump()` 因为 `pet-app.js` 传了数组**从来没生效过** ——
     * 于是球一进她的可达范围，她就每帧"准备跳"、每帧都不走位：实测 60 帧里 **57 帧收不到走路指令**。
     * 用户看到的就是"球飞过来她呆呆站着不动，然后球过去了"。
     *
     * 现在起跳要同时满足：① 这一球判到"顶"（`headRollOk`）② 不在落地恢复期 ③ 距离上次起跳 > 900ms。
     * **判到"不顶"的时候她照常追球** —— 玩家就能把这一球打过去。
     */
    let jumped = false;
    if (canHead && g.headRollOk && recovered && (!(g.lastHeadAt > 0) || now - g.lastHeadAt > 900)) {
        g.lastHeadAt = now;
        goTo(s.x + (s.x < pet.x ? 6 : -6), true, true);
        jumped = control.jump() !== false;    // false = 她当时跳不了（被拎着 / 在空中 / 还在蹲）
        /**
         * ★ **起跳瞬间就把"这次跳跃的头球几何"整条算出来**。
         *
         * 为什么必须现在算：她这一跳只有 ≈0.63 秒，脚底在**起跳那一刻**还是离地 0
         * （诊断日志限流 1 秒，永远抓到她落地之后 —— 之前测了好几轮都是"她脚底离地=0"，
         *  现在知道那不是限流的问题，是 `act(['jump'])` 让她**根本没离地**）。
         *
         * ⚠️ 单位别混：`boxBottom/boxTop` 都是**离地高度**。老版本拿 y 坐标和高度互相减，
         * 打出来是"头箱扫过离地 585~60"这种数 —— 上一轮就是拿它去挪判定盒的（见 HANDOVER 1.28）。
         */
        if (DEBUG && now - (g.jumpGeoLoggedAt || 0) > 800) {
          g.jumpGeoLoggedAt = now;
          try {
            const boxBottom = HEAD_BOX.above;                          // 刚离地时箱子下沿（离地）
            const boxTop = JUMP_RISE + HEAD_BOX.above + HEAD_BOX.h;    // 最高点时箱子上沿（离地）
            globalThis.petHost?.report?.(`[弹弹乐·跳跃] 起跳${jumped ? '成功' : '被拒（她在空中/被拎着）'}`
              + ` · 起跳时球离地=${Math.round(high)} · 这次跳跃头箱扫过离地 ${Math.round(boxBottom)}~${Math.round(boxTop)}`
              + `（球心到 ${Math.round(boxBottom - BALL_R)} 就能碰）`
              + ` · 球速=${Math.round(Math.abs(s.vx || 0))} · 球离她 ${Math.round(Math.abs(s.x - pet.x))}px`);
          } catch { /* ignore */ }
        }
        /**
         * 报一句给主进程（限流 1.2 秒一条）：**"头球有没有触发"的唯一实锤**。
         * 页面里没法打断点，日志里能直接看到"球多高、多快、她当时在跑还是在走"。
         */
        if (!(g.lastJumpLog > 0) || now - g.lastJumpLog > 1200) {
          g.lastJumpLog = now;
          try {
            globalThis.petHost?.report?.(`[弹弹乐] 起跳接球：球高 ${Math.round(high)}px · 离她 ${Math.round(Math.abs(s.x - pet.x))}px · 速度 ${Math.round(Math.abs(s.vx))} · 她=${mvNow ? mvNow.mode : '?'} · ${willHead ? '预测到点' : '头顶范围'}`);
          } catch { /* 报告失败就算了 */ }
        }
    }
    /**
     * 够得到的来球、而且她**真的在跳 / 已经在空中**：这一帧不再管走位。
     * （判到"不顶"、或者跳不了的时候**照常追球** —— 别再让她白站一帧，也别把玩家的活路堵死。）
     */
    const sheAir = !!mvNow && (mvNow.mode === 'air' || mvNow.mode === 'crouch');
    if (canHead && (jumped || sheAir)) return;
    /**
     * **开球后的自检**（**不再只在 `DSP_DEBUG=1` 时跑** —— 用户实测的"球复位了她不去踢"
     * 就是靠这一段抓的，而它原来被 DEBUG 挡着，所以一直"没等到复现数据"）。
     *
     * 只在她**一直没碰到球**时才写日志（正常开球一两百毫秒就踢到了，平时一声不响）；
     * 连报几笔（每 0.8 秒一笔、最多 4 笔），这样能看出她**有没有在往球那边移动** ——
     * 只报一笔分不清"她没动"和"她动得慢"。
     */
    if (!g.kickoffKicked && !g.kickoffLogDone && now - (g.kickoffLogAt || 0) > 1200) {
      g.kickoffLogAt = now;
      g.kickoffTicks = (g.kickoffTicks || 0) + 1;
      if (g.kickoffTicks >= 4) g.kickoffLogDone = true;    // 报够 4 笔就闭嘴，别淹日志
      try {
        const why = plan(s.x, pet.x, g.defence, g.urgency || 0).why;
        const hz = g.defence === 0 ? s.x < b.minX + ZONE * b.W : s.x > b.maxX - ZONE * b.W;
        const mv = mvNow || {};
        globalThis.petHost?.report?.(`[弹弹乐·开球没踢] 第 ${g.kickoffTicks} 笔：球在 ${Math.round(s.x)}（离她 ${Math.round(Math.abs(s.x - pet.x))}px、离地 ${Math.round(high)}px、${s.resting ? '停着' : '在动'}）`
          + ` · 她在 ${Math.round(pet.x)}（${mv.mode || '?'}${mv.speed !== undefined ? ' 速度' + Math.round(mv.speed) : ''}${mv.target !== undefined ? ' 目标' + Math.round(mv.target) : ''}、脚底离地 ${mv.feetY !== undefined ? Math.round(b.floorY - mv.feetY) : '?'}）`
          + ` · 球拍模式=${ball.paddleMode} · herZone=${hz} 分支=${why} 上次走路目标=${g.lastWant ? Math.round(g.lastWant) : 0}（${g.lastWalkAt ? Math.round(now - g.lastWalkAt) + 'ms 前' : '从没走过'}）`);
      } catch { /* ignore */ }
    }
    /**
     * **开球后的"第一脚"每帧都催**（`force = true`）。
     *
     * 平时走路指令有两条静默规则：260ms 节流、以及"离目标 26px 以内就不喊"。
     * 开球那一下要跳过这两条 —— 否则她可能站在球边上、却一帧指令都收不到
     * （她不去踢的复现数据就卡在这种地方）。
     */
    const firstTouch = !g.kickoffKicked && now - (g.kickoffStart || 0) < 2500;
    if (herZoneLead) { goTo(leadX, firstTouch, true); void netX; return; }   // 她半场的球：**跑**过去抢（带提前量）
    /**
     * 球在对面半场：**走 `plan()` 的四档决策**（追 / 压上 / 回防），
     * 不再在这里重写一遍 —— 两处逻辑重复过一次，改一处忘一处就是 bug。
     * `urgency` 由比分算：落后越多越靠前压。
     */
    const p = plan(leadX, pet.x, g.defence, g.urgency || 0);
    /**
     * 低频 trace（1.2 秒一条）：**排查"她为什么不追球"时把 `DSP_DEBUG=1` 打开**。
     * 平时不刷（日志会淹），只在需要诊断时开。
     */
    if (DEBUG && now - (g.traceAt || 0) > 1200) {
      g.traceAt = now;
      try {
        // 连她的**移动模式与速度**一起记：排查"球在天上她就只会走"时这是关键
        const mv = control.move ? control.move() : null;
        globalThis.petHost?.report?.(`[弹弹乐·trace] herZone=${herZone} 分支=${p.why} 目标=${Math.round(p.x)} 她在=${Math.round(pet.x)} 球=${Math.round(s.x)} 球离地=${Math.round(high)} 她在跑=${mv ? mv.mode : '?'} 速度=${mv ? Math.round(mv.speed) : '?'}`);
      } catch { /* ignore */ }
    }
    goTo(p.x, firstTouch, true);
    void netX;
  }

  /** 她踢到球了：偶尔**蓄力飞踢**（力度 ×1.7，并吼一声）。 */
  function onKick(info) {
    if (g.mode !== 'game') return;
    // 玩家踢的那一脚不算"她踢到了"（否则开球自检会误判成她踢到了）
    if (info && info.by === 'player') {
      /**
       * **你碰到球 = 你开球了 → 解除她的"退回半场"**（见 `RETREAT_MAX_MS`）。
       * 不解除的话，球在你脚下而她还站在自己半场，你就得一个人踢（游戏就死了）。
       */
      if (g.retreatHold) {
        g.retreatHold = false;
        ball.setHerTouch?.(true);
        try { globalThis.petHost?.report?.('[弹弹乐] 你碰到球了（开球）→ 她结束退回，回来抢'); } catch { /* ignore */ }
      }
      return;
    }
    /**
     * **开球 → 她第一次碰到球花了多久**（只在"慢得不像话"时才写日志）。
     *
     * 用户实测："她自己场地复位时有时会不踢" —— 这一行是唯一能量到那件事的实锤
     * （正常开球一两百毫秒就碰到，>900ms 就一定有问题），而下面那段 `[弹弹乐·开球没踢]`
     * 会把那一刻她的位置/模式/目标/脚底高度全打出来，一次就能定性。
     */
    if (g.kickoffStart) {
      const dt = performance.now() - g.kickoffStart;
      if (dt > 900) {
        try {
          globalThis.petHost?.report?.(`[弹弹乐] 开球后 ${Math.round(dt)}ms 她才踢到（这一脚多半是"跑去追"而不是"就地在门口"）`);
        } catch { /* ignore */ }
      }
      g.kickoffStart = 0;
    }
    /**
     * ⚠️ **她碰到球**不再解除开球权（那正是"刷分"的来源：她一碰就还给你，而你正站在门口）。
     * 现在按**位置**解禁：球离开她的防区才还给你（见 `onStep` 里的 `KICKOFF_CLEAR`）。
     */
    g.kickoffKicked = true;
    if (Math.random() < CHARGE_CHANCE) {
      ball.setAim({ x: targetFor(g.defence), power: CHARGE_POWER });
      sfx?.whoosh?.();
      onEvent?.('charge', { defence: g.defence });
    }
  }

  /* ---------- 画 ---------- */

  function draw() {
    if (g.mode !== 'game' || !layer) return;
    const b = control.bounds();
    const flashOn = g.flash > 0;
    for (const side of [0, 1]) {
      const p = parts[side];
      if (!p) continue;
      const gr = goalRect(side);
      p.net.setAttribute('transform', `translate(${gr.x0} ${gr.yTop})`);
      p.rect.setAttribute('width', String(Math.round(gr.w)));
      if (p.builtFor !== Math.round(gr.w)) {           // 网格只在宽度变了时重建（省事又省 CPU）
        p.builtFor = Math.round(gr.w);
        p.grid.setAttribute('d', gridPath(gr.w, GOAL_H));
      }
      // 她守的那一侧：门顶上亮一个小圆点
      p.dot.setAttribute('cx', String(side === 0 ? 10 : Math.round(gr.w) - 10));
      p.dot.setAttribute('opacity', side === g.defence ? '1' : '0');
      /**
       * 网闪：**class 只在"该不该闪"变化时写一次**。
       * 每帧都 `setAttribute('class', …)` 的话，CSS 里那条抖动动画每帧都会重头开始
       * （看着就是"不抖、只在原地僵住"）。
       */
      if (p.flash !== flashOn) {
        p.flash = flashOn;
        p.net.setAttribute('class', `toy-goal${flashOn ? ' toy-goal-flash' : ''}`);
      }
      p.net.setAttribute('opacity', flashOn ? '1' : '.82');
    }
    /** 比分牌：顶部居中；进球后 `scorePop` 那 0.45 秒里放大 1.35 → 1（弹一下）。 */
    if (score) {
      const pop = 1 + 0.35 * Math.max(0, Math.min(1, (g.scorePop || 0) / 0.45));
      score.setAttribute('transform', `translate(${b.minX + b.W / 2} ${30}) scale(${pop.toFixed(3)})`);
      scoreYou.textContent = `你 ${g.score[0]}`;
      scoreHer.textContent = `小肥鱼 ${g.score[1]}`;
    }
    /** 进球大字：在**被进的那个门**上方弹出（放大 → 停留 → 淡出），只在庆祝那 1 秒里可见。 */
    if (goalText) {
      if (g.celebrateUntil) {
        const k = Math.max(0, Math.min(1, 1 - (g.celebrateUntil - performance.now()) / CELEBRATE_MS));
        const gr = goalRect(g.celebrateSide === 1 ? 1 : 0);
        const sc = 0.55 + 0.75 * Math.min(1, k * 3);           // 前 1/3 弹出来
        const fade = k < 0.6 ? 1 : Math.max(0, 1 - (k - 0.6) / 0.4);
        goalText.setAttribute('class', `toy-goal-text ${g.celebrateScorer === 0 ? 'mine' : 'hers'}`);
        goalText.setAttribute('transform', `translate(${Math.round((gr.x0 + gr.x1) / 2)} ${Math.round(gr.yTop - 28)}) scale(${sc.toFixed(3)})`);
        goalText.textContent = g.celebrateScorer === 0 ? '你进球！' : '她进球！';
        goalText.setAttribute('opacity', fade.toFixed(2));
      } else if (goalText.getAttribute('opacity') !== '0') {
        goalText.setAttribute('opacity', '0');
      }
    }
  }

  return {
    setMode, onStep, onKick, draw, kickoff, goalRect, plan,
    /**
     * **她被拎起来 / 刚放下之后"别追球"的窗口**（`pet-app.js` 在抓起、放下时调）。
     * 用户实测："哪怕拽起她放下来，立马又跑了" —— 拎过之后愣两秒才合理。
     */
    hold(ms) {
      const t = performance.now() + Math.max(0, Number(ms) || 0);
      g.holdUntil = Math.max(g.holdUntil || 0, t);
      return g.holdUntil;
    },
    /** 只给自检用的内部状态入口（合成测试跑得比真实时间快，得能重置冷静期）。 */
    debug: g,
    get mode() { return g.mode; },
    get score() { return [...g.score]; },
    get defence() { return g.defence; },
  };
};
