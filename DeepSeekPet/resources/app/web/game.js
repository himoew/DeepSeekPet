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
 *   - 高球她**30%** 概率**跳起来用头顶**回去（太高的够不到）；
 *   - 你随时可以把球直接丢进她的门、或者把她拎到另一边 —— 那是**整蛊玩法**，规则不拦着。
 */
const GOAL_W = 0.10;          // 球门宽度（占窗口宽度的比例）
const GOAL_H = 150;           // 球门高度（px）
const ZONE = 0.5;             // 中线：她的半场 / 你的半场
const HEAD_CHANCE = 0.30;     // 高球跳起来顶回去的概率（用户指定）
const CHARGE_CHANCE = 0.18;   // 蓄力飞踢的概率
const CHARGE_POWER = 1.7;     // 蓄力时的力度系数
const REACH_JUMP = 260;       // 球高过地面这么多以内她跳得够到；再高就够不到
const HEAD_X = 150;           // 横向差这么多以内才去顶
const WALK_EVERY_MS = 700;    // 两次改走路目标的间隔（别每帧喊一次）

/** 球往哪个门踢：她守 0（左）就踢右边（1.0），反之踢左边（0.0）。 */
const targetFor = (defence) => (defence === 0 ? 1 : 0);

export const createGame = ({ fxG, control, ball, sfx, onEvent } = {}) => {
  const g = {
    mode: 'off',              // off | ball | game
    defence: 1,               // 她守哪边：0 = 左，1 = 右
    score: [0, 0],            // [0] = 你进的球，[1] = 她进的球
    flash: 0,                 // 进球后网闪一下的计时
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

  /** 开球：球放到 `side` 那一边的门前，静止。 */
  function kickoff(side) {
    const b = control.bounds();
    const gr = goalRect(side);
    const near = side === 0 ? gr.x1 + b.W * 0.09 : gr.x0 - b.W * 0.09;
    ball.placeAt(Math.min(0.94, Math.max(0.06, near / b.W)), 'floor', { since: 0 });
  }

  /* ---------- 每帧：判进球 + 她的行动 ---------- */

  function onStep(s) {
    if (g.mode !== 'game') return;
    const b = control.bounds();
    const pet = control.pet();
    const now = performance.now();
    if (g.flash > 0) g.flash -= s.dt;

    // 1) 进球：球心进了门框（横梁以下、门柱之间）
    if (!s.dragging && s.y >= goalRect(0).yTop - 6) {
      for (const side of [0, 1]) {
        const gr = goalRect(side);
        if (s.x < gr.x0 || s.x > gr.x1) continue;
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
    if (!herZone) return;                              // 球在对面半场：她守着自己的门

    const gr = goalRect(g.defence);
    const netX = (gr.x0 + gr.x1) / 2;
    const high = b.floorY - s.y;                       // 球离地多高
    // 高球：站到球下面一点，然后跳起来用头顶（30%）
    if (!s.resting && high > 40 && high < REACH_JUMP && Math.abs(s.x - pet.x) < HEAD_X) {
      if (now - g.lastHeadAt > 900 && Math.random() < HEAD_CHANCE) {
        g.lastHeadAt = now;
        control.walkTo((s.x + (s.x < pet.x ? 16 : -16)) / b.W);
        control.jump();
      }
      return;
    }
    // 地滚球：走过去踢（她碰到就踢，方向已由 setAim 指好）
    const stand = s.resting ? s.x : s.x;               // 停着的球就去踢；飞着的地滚球迎上去
    const want = Math.min(b.maxX - 30, Math.max(b.minX + 30, stand));
    if (Math.abs(want - pet.x) > 30 && now - g.lastWalkAt > WALK_EVERY_MS) {
      g.lastWalkAt = now;
      control.walkTo(want / b.W);
    }
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
    get mode() { return g.mode; },
    get score() { return [...g.score]; },
    get defence() { return g.defence; },
  };
};
