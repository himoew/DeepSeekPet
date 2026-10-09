/**
 * 迷你弹弹乐（游戏模式）—— 球门、比分、她的守门与反踢。
 *
 * **为什么单独一个文件**：本会话已经在她身上（`pet-core.js` / `figure.js`）栽过两次，
 * 所以游戏逻辑一律**不往那两处塞**。这个模块通过钩子驱动：
 *
 *   `ball.js`  →  `onStep()`：每帧把球的位置/速度告诉这里；这里回设"这一脚往哪踢、多大力"
 *   `onKick()` → 她踢到球时决定要不要**蓄力飞踢**
 *   这里       →  让她**走过去 / 跳起来顶球**（`ctl.walkTo` / `ctl.act(['jump'])`）
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
import { HEAD_REACH } from './ball.js';

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
 * 头球概率：**只要球进了她"跳起来够得到"的范围，就 80% 触发**
 * （用户实测后从 50% 提到 80%："头球概率还是小，直接改到 80%"）。
 */
const HEAD_CHANCE = 0.80;
const CHARGE_CHANCE = 0.18;   // 蓄力飞踢的概率
const CHARGE_POWER = 1.7;     // 蓄力时的力度系数
/** 球高过地面这么多以内她跳得够到（**跟球那边的头球盒子对齐**，见 ball.js 的 HEAD_REACH）。 */
const REACH_JUMP = HEAD_REACH;
/** 低于这个高度就算"贴地球"，走"跑过去踢"那条路（不跳）。 */
const REACH_MIN = 40;
/**
 * **提前量**：她从起跳到最高点要约 `720 / 2300 ≈ 0.31s`（见 pet-core 的空中重力），
 * 所以"球还有 ≤0.8 秒到她身上"时就该跳了 —— 这就是用户说的"在她头前面那道判断墙"。
 */
const JUMP_LEAD = 0.8;
const HEAD_X = 150;           // 横向差这么多以内才去顶
const WALK_EVERY_MS = 260;    // 两次改走路目标的间隔（要跟得上球，但不能每帧喊）
const WALK_EPS = 26;          // 离目标这么近就不喊了
const CHASE_OPP_MAX = 0.16;   // 球离对面门这么近（占窗口宽）就不追了 —— 追不上，回去防守
const CHASE_SELF_MAX = 0.34;  // 自己离球这么远也不追了（回防）
const DEFEND_X = 0.30;        // 回防站位：在自己半场这条线上等（不贴墙，留反应距离）
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
    /** 开球之后等这么久还没踢到，就报一句（诊断"球复位了她不去踢"）。 */
    kickoffAt: 0,
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
    layer.setAttribute('display', 'none');
    fxG.appendChild(layer);
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
      control.walkTo(g.defence === 0 ? 0.28 : 0.72);   // 先走到自己那半场
      kickoff(1 - g.defence);                          // 球从"你这边"先开出来
    }
    onEvent?.('mode', { mode: want, defence: g.defence, score: [...g.score] });
    return g.mode;
  }

  /** 开球：球放到 `side` 那一边的门前（**门框之外**！），静止，并给一小段"不判进球"的冷静期。 */
  function kickoff(side) {
    const b = control.bounds();
    const gr = goalRect(side);
    // 一定要落在门框外面：落在门里的话，下一帧又会判进球 → 死循环（实测卡死）
    const near = side === 0 ? gr.x1 + b.W * 0.10 : gr.x0 - b.W * 0.10;
    ball.placeAt(Math.min(0.94, Math.max(0.06, near / b.W)), 'floor', { since: 0 });
    g.noGoal = performance.now() + 350;
    // 记号：这次开球之后她多久才踢到（用来诊断"球复位了她不去踢"）
    g.kickoffAt = performance.now();
    g.kickoffKicked = false;
    g.kickoffTicks = 0;
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
        const scorer = 1 - side;                       // 球进 side 的门 → 对面得分
        g.score[scorer] += 1;
        g.flash = 0.6;
        sfx?.goal?.();
        onEvent?.('goal', { side, scorer, score: [...g.score], defence: g.defence });
        kickoff(side);                                 // 从失球那一边重新开出来
        return;
      }
    }

    // 2) 瞄准：球在场上时，她一脚就往对面的门踢（力度随机在 ball 里，蓄力在 onKick 里）
    ball.setAim({ x: targetFor(g.defence), power: 1 });
    const herZone = g.defence === 0 ? s.x < b.minX + ZONE * b.W : s.x > b.maxX - ZONE * b.W;
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
     * **跳起来接球（预判起跳）** —— 这是用户实测后定下来的做法。
     *
     * 用户的原话："很少触发头球，有一次触发了球已经过去很久了……除非在她的头前面加判定区域，
     * 比如一道判断墙，球飞过 50% 触发跳跃。" —— 诊断完全正确，问题就是**时序**：
     * 球 400px/s，150px 的反应区只有 0.37 秒，而跳起来要 ≈0.3 秒才到最高点，
     * **等球进了那个范围再跳，头到位置时球早飞过去了**。
     *
     * 所以改成**算提前量**：算"球还有多久到她身上"（`tHit`），在她该起跳的时候才跳 ——
     * 起跳后 `JUMP_APEX`（正是她抛物线到最高点的时间 `720/2300 ≈ 0.31s`）后头到最高，
     * 那一刻球刚好到。这样"判断墙"实际上在她**身前 ~0.5 秒**的地方，而不是贴着身子。
     *
     * 另外**只接"你丢/踢过来的球"**：她自己踢出去又反弹回来的球不算来球，
     * 否则她等于凭空多出一次顶球机会（`ball.lastRelease` 就是干这个的）。
     */
    const HEAD_WINDOW = 3000;                  // 你丢/踢的球，3 秒内算"来球"
    const sinceYou = now - (ball.lastRelease || 0);
    const toward = Math.sign(pet.x - s.x) === Math.sign(s.vx || 0) && Math.abs(s.vx) > 40;
    const tHit = toward ? Math.abs(s.x - pet.x) / Math.max(1, Math.abs(s.vx)) : Infinity;
    /** 她该不该现在起跳：球朝她来、还有 0.1~0.8 秒到（球速越快越早跳）。 */
    const shouldJump = s.vx !== 0 && s.vy > 0 && tHit > 0.1 && tHit < JUMP_LEAD
      && high > REACH_MIN && high < REACH_JUMP + 60
      && Math.abs(s.x - pet.x) < Math.abs(s.vx) * JUMP_LEAD + 40;
    /** 球就在她头顶那一片（已经来不及预判了）：也跳一下碰运气。 */
    const above = !s.resting && high > REACH_MIN && high < REACH_JUMP && Math.abs(s.x - pet.x) < HEAD_X;
    const canHead = (sinceYou < HEAD_WINDOW) && (shouldJump || above);
    if (canHead || (herZone && !s.resting && high < REACH_MIN)) {
      // "从来没跳过"也算可以跳（跟 goTo 一个道理：别让时间轴起点决定第一次能不能动）
      if (!(g.lastHeadAt > 0) || now - g.lastHeadAt > 900) {
        if (Math.random() < HEAD_CHANCE) {
        g.lastHeadAt = now;
        goTo(s.x + (s.x < pet.x ? 6 : -6), true, true);
        control.jump();
        /**
         * 报一句给主进程（限流 1.2 秒一条）：**"头球有没有触发"的唯一实锤**。
         * 页面里没法打断点，日志里能直接看到"球多高、多快、还有多久到她"。
         */
        if (!(g.lastJumpLog > 0) || now - g.lastJumpLog > 1200) {
          g.lastJumpLog = now;
          try {
            globalThis.petHost?.report?.(`[弹弹乐] 起跳接球：球高 ${Math.round(high)}px · 离她 ${Math.round(Math.abs(s.x - pet.x))}px · 速度 ${Math.round(Math.abs(s.vx))} · 还有 ${tHit === Infinity ? '—' : tHit.toFixed(2)}s 到 · ${shouldJump ? '预判' : '头顶'}`);
          } catch { /* 报告失败就算了 */ }
        }
        }
      }
      if (canHead) return;                  // 够得到的来球：这一帧就去接，不再管走位
    }
    /**
     * **开球后的自检**：1.5 秒还没踢到就报一句。
     * 用户实测"球复位了她不知道去踢" —— 这一行能分清是
     *   ① 她没往球那边走（走位问题）还是 ② 走到了却没踢到（碰撞/冷却问题）。
     */
    if (DEBUG && g.kickoffAt && !g.kickoffKicked && now - g.kickoffAt > 1500) {
      /**
       * 连报几笔（每 0.8 秒一次，最多 4 笔），这样能看出**她有没有在往球那边移动** ——
       * 只报一笔的话分不清"她没动"和"她动得慢"。
       */
      g.kickoffAt = now;
      g.kickoffTicks = (g.kickoffTicks || 0) + 1;
      if (g.kickoffTicks > 4) { g.kickoffAt = 0; }
      try {
        const why = plan(s.x, pet.x, g.defence, g.urgency || 0).why;
        const hz = g.defence === 0 ? s.x < b.minX + ZONE * b.W : s.x > b.maxX - ZONE * b.W;
        globalThis.petHost?.report?.(`[弹弹乐] 开球后第 ${g.kickoffTicks} 次检查：球在 ${Math.round(s.x)}（离她 ${Math.round(Math.abs(s.x - pet.x))}px）· 她在 ${Math.round(pet.x)} · 球离地 ${Math.round(high)}px · herZone=${hz} 分支=${why} 目标=${g.lastWant ? Math.round(g.lastWant) : 0}`);
      } catch { /* ignore */ }
    }
    if (herZone) { goTo(s.x, false, true); void netX; return; }   // 她半场的球：**跑**过去抢
    /**
     * 球在对面半场：**走 `plan()` 的四档决策**（追 / 压上 / 回防），
     * 不再在这里重写一遍 —— 两处逻辑重复过一次，改一处忘一处就是 bug。
     * `urgency` 由比分算：落后越多越靠前压。
     */
    const p = plan(s.x, pet.x, g.defence, g.urgency || 0);
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
    goTo(p.x, false, true);
    void netX;
  }

  /** 她踢到球了：偶尔**蓄力飞踢**（力度 ×1.7，并吼一声）。 */
  function onKick(info) {
    if (g.mode !== 'game') return;
    // 玩家踢的那一脚不算"她踢到了"（否则开球自检会误判成她踢到了）
    if (info && info.by === 'player') return;
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
      p.net.setAttribute('class', `toy-goal${g.flash > 0 ? ' toy-goal-flash' : ''}`);
      p.net.setAttribute('opacity', g.flash > 0 ? '1' : '.82');
    }
  }

  return {
    setMode, onStep, onKick, draw, kickoff, goalRect, plan,
    /** 只给自检用的内部状态入口（合成测试跑得比真实时间快，得能重置冷静期）。 */
    debug: g,
    get mode() { return g.mode; },
    get score() { return [...g.score]; },
    get defence() { return g.defence; },
  };
};
