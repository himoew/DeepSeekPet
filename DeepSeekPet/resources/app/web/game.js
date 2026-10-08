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
 * 头球概率：**只要球进了她"跳起来够得到"的范围，就 50% 触发**
 * （用户实测后定的：先按 50% 看看手感，太高接不到的球不在范围内、不参与判定）。
 */
const HEAD_CHANCE = 0.50;
const CHARGE_CHANCE = 0.18;   // 蓄力飞踢的概率
const CHARGE_POWER = 1.7;     // 蓄力时的力度系数
/** 球高过地面这么多以内她跳得够到（**跟球那边的头球盒子对齐**，见 ball.js 的 HEAD_REACH）。 */
const REACH_JUMP = HEAD_REACH;
const HEAD_X = 150;           // 横向差这么多以内才去顶
const WALK_EVERY_MS = 320;    // 两次改走路目标的间隔（要跟得上球，但不能每帧喊）
const WALK_EPS = 26;          // 离目标这么近就不喊了
const CHASE_OPP_MAX = 0.16;   // 球离对面门这么近（占窗口宽）就不追了 —— 追不上，回去防守
const CHASE_SELF_MAX = 0.34;  // 自己离球这么远也不追了（回防）
const DEFEND_X = 0.30;        // 回防站位：在自己半场这条线上等（不贴墙，留反应距离）

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
    scoredThisRelease: false, // 这一次松手是否已经算过进球
    calls: 0, tickAt: 0,      // 每帧调用次数自检（见 onStep）
    lastWalkAt: 0,
    lastHeadAt: 0,
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
  }

  /* ---------- 每帧：判进球 + 她的行动 ---------- */

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

    // 1) 进球：球心进了门框（横梁以下、门柱之间），而且是"往里飞"
    const grTop = goalRect(0).yTop;
    if (!s.dragging && s.y >= grTop - 6) {
      for (const side of [0, 1]) {
        const gr = goalRect(side);
        if (s.x < gr.x0 || s.x > gr.x1) continue;
        /**
         * ★ **开球后有一小段时间不再判进球**（`g.noGoal`）。
         * 没有它就会死循环：球停在门里 → 判进球 → 开球（球还在门的横坐标范围内）→ 又判进球……
         * 实测症状就是"球一进网就卡死"。**这条是硬保险，别删。**
         */
        if (now < (g.noGoal || 0)) continue;
        if (g.scoredThisRelease) continue;             // 这一次松手已经算过了
        g.scoredThisRelease = true;
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
      if (!force && now - g.lastWalkAt < WALK_EVERY_MS) return;
      g.lastWalkAt = now;
      control.walkTo(want / b.W, !!run);
    };

    // 高球：站到球下面一点，然后跳起来用头顶（30%）
    if (herZone && !s.resting && high > 40 && high < REACH_JUMP && Math.abs(s.x - pet.x) < HEAD_X) {
      if (now - g.lastHeadAt > 700 && Math.random() < HEAD_CHANCE) {
        g.lastHeadAt = now;
        goTo(s.x + (s.x < pet.x ? 16 : -16), true, true);
        control.jump();
      }
      return;
    }
    if (herZone) { goTo(s.x, false, true); void netX; return; }   // 她半场的球：**跑**过去踢
    /**
     * 球在对面半场。用户实测的问题是："进攻到快进球了就停止了" —— 老写法一到对面就整段回防，
     * 于是**球都快进门了她却掉头往回走**。
     *
     * 现在分三种情况（按球离对面球门有多近）：
     *   · 球还在对面中场、自己也离得不远 → **继续追**（这一脚还可能进）；
     *   · 球已经贴到对面门口 → 追不上了，回防；
     *   · 球深在对面、自己又远 → 回防。
     * 回防也保持一个下限（只在己方 70% 区域内活动），不至于贴到墙上。
     */
    const oppGoalX = g.defence === 0 ? b.maxX : b.minX;            // 对面那个门
    const dOpp = Math.abs(s.x - oppGoalX);
    const dSelf = Math.abs(s.x - pet.x);
    if (dOpp > b.W * CHASE_OPP_MAX && dSelf < b.W * CHASE_SELF_MAX) { goTo(s.x, false, true); return; }
    const backX = g.defence === 0
      ? b.minX + b.W * DEFEND_X
      : b.maxX - b.W * DEFEND_X;
    goTo(backX, false, true);                                      // 回防（不贴墙、留反应距离）
    void netX;
  }

  /** 她踢到球了：偶尔**蓄力飞踢**（力度 ×1.7，并吼一声）。 */
  function onKick() {
    if (g.mode !== 'game') return;
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
    setMode, onStep, onKick, draw, kickoff, goalRect,
    /** 只给自检用的内部状态入口（合成测试跑得比真实时间快，得能重置冷静期）。 */
    debug: g,
    get mode() { return g.mode; },
    get score() { return [...g.score]; },
    get defence() { return g.defence; },
  };
};
