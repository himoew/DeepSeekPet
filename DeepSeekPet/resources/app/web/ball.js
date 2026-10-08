/**
 * 玩具球 —— 一个她能踢、能追、也会自己滚的球。
 *
 * **为什么单独一个文件**：本会话在她身上（`pet-core.js` / `figure.js`）连着栽过两次
 * —— 帧循环里一处笔误就让她整个人不动或不见。所以这个新玩法**不往那两处塞逻辑**：
 * 物理、绘制、碰撞、音效全在这里，`pet-app.js` 的帧循环里只加两行调用
 * （`ball.step(dt)` / `ball.draw()`），出了问题最多是球不对。
 *
 * 它做四件事：
 *
 *   1. **物理**：重力、地面弹跳、地面摩擦、撞墙回弹（数字都是"手感"，见下面常量）；
 *   2. **碰撞**：球碰到她身上（正面一个椭圆盒子，她转身时盒子跟着镜像）就**被踢出去**，
 *      方向和力度按"球在她哪一侧"算 —— 所以球滚到她左边和右边，踢出去的方向是反的；
 *   3. **绘制**：球画进 `#fx`（跟影子、爱心、灰尘同一层），`#pet` 那层是她的身体，
 *      两者互不干扰；
 *   4. **通知**：踢到球 / 球飞出去都通过 `onEvent` 报给页面，页面再转给 World 选台词。
 *
 * 关闭时球直接消失（`setOn(false)`），**不留痕迹**：她的"闹脾气"由 World 那边出表情和台词。
 */

/** 重力（px/s²）。视口 800px 高时，球从她腰那么高掉下来约 0.5 秒落地。 */
const GRAVITY = 1500;
/** 撞地保留多少速度：0.55 大约弹两三下就停。 */
const BOUNCE = 0.55;
/** 每次落地后水平速度乘这个（地面摩擦）。 */
const GROUND_FRICTION = 0.86;
/** 空气阻力（每秒衰减比例）。 */
const AIR_DRAG = 0.06;
/** 球半径（舞台像素）。 */
const R = 13;
/** 踢出去的速度范围（px/s）。 */
const KICK_MIN = 300, KICK_MAX = 520;
/** 同一帧里最多踢一次：给碰撞一个"冷却"，免得贴着球时每帧都踢（球会抖）。 */
const KICK_COOL_MS = 420;
/**
 * 她的碰撞盒（以她脚下中心为原点，单位 px）：front 是朝向那一侧、
 * 大一点；back 是背对那一侧、小一点。**刻意比她的身体略小**（宁可漏判也别误判成"踢到空气"）。
 */
const HIT = { front: 52, back: 40, low: 52 };

export const createBall = ({ fxG, sfx, stage, onEvent } = {}) => {
  const st = {
    on: false,
    x: 0, y: 0, vx: 0, vy: 0,
    spin: 0, spinV: 0,
    resting: true,
    hover: false,          // 鼠标是不是停在球上
    lastKick: 0,
    since: 0,              // 上一次被踢到现在（秒）：用来决定"要不要过去找它玩"
  };

  let box = null;          // { W, H, floorY }，每帧问 stage 要
  let root = null, shadow = null, ballEl = null;

  /* ---------- 开关 ---------- */

  function mount() {
    if (root || !fxG) return;
    root = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    root.setAttribute('class', 'toy-ball');
    root.setAttribute('aria-hidden', 'true');
    shadow = document.createElementNS('http://www.w3.org/2000/svg', 'ellipse');
    shadow.setAttribute('class', 'toy-ball-shadow');
    ballEl = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    ballEl.innerHTML = `
      <circle class="toy-ball-body" r="${R}"/>
      <path class="toy-ball-seam" d="M${-R} 0a${R} ${R} 0 0 0 ${2 * R} 0M0 ${-R}a${R} ${R} 0 0 0 0 ${2 * R}"/>
      <circle class="toy-ball-dot" cx="${R * .42}" cy="${-R * .42}" r="2.2"/>`;
    root.appendChild(shadow);
    root.appendChild(ballEl);
    fxG.appendChild(root);
  }

  function place({ fromLeft } = {}) {
    const b = stage.bounds();
    st.x = fromLeft ? b.minX + 40 : b.maxX - 40;
    st.y = b.floorY - R * 6;                 // 从半空掉进来，落地会弹两下
    st.vx = (fromLeft ? 1 : -1) * (60 + Math.random() * 90);
    st.vy = 0;
    st.spin = 0; st.spinV = 0;
    st.resting = false;
    st.since = 0;
  }

  /**
   * 开 / 关。开着的时候球从屏幕一侧掉进来（她一般会盯着它看）。
   * 关掉时**立刻从画面上消失**，并回一条 `off` 给页面（页面再告诉 World，让它出表情和台词）。
   */
  function setOn(on, opts = {}) {
    const want = !!on;
    if (want === st.on) return st.on;
    st.on = want;
    mount();
    if (root) root.setAttribute('display', want ? '' : 'none');
    if (want) { place(opts); onEvent?.('ballOn', { x: Math.round(st.x) }); }
    else onEvent?.('ballOff', { x: Math.round(st.x) });
    return st.on;
  }

  /* ---------- 物理 + 碰撞 ---------- */

  function step(dtRaw) {
    if (!st.on) return;
    const dt = Math.min(Math.max(dtRaw, 0), 0.05);   // 切回窗口时别一次算一大步
    const b = (box = stage.bounds());
    st.since += dt;

    // 重力 + 空气阻力
    st.vy += GRAVITY * dt;
    const drag = Math.max(0, 1 - AIR_DRAG * dt);
    st.vx *= drag; st.vy *= drag;

    st.x += st.vx * dt;
    st.y += st.vy * dt;
    st.spin += st.spinV * dt;
    st.spinV *= Math.max(0, 1 - 2.2 * dt);            // 滚动慢慢停

    const floorY = b.floorY - R;                       // 球心贴地时的高度
    if (st.y >= floorY) {
      st.y = floorY;
      if (st.vy > 40) {
        st.vy = -st.vy * BOUNCE;
        st.vx *= GROUND_FRICTION;
        st.spinV = st.vx / R;                          // 落地后开始滚
        sfx?.ballBounce?.(Math.min(1, Math.abs(st.vy) / 400));
      } else {
        st.vy = 0;
        if (Math.abs(st.vx) < 6) st.vx = 0;             // 停下来，不然会永远微动
        st.spinV = st.vx / R;
      }
      st.resting = st.vy === 0;
    } else {
      st.resting = false;
    }

    // 撞墙回弹
    const left = b.minX + R, right = b.maxX - R;
    if (st.x < left) { st.x = left; if (st.vx < 0) { st.vx = -st.vx * 0.7; sfx?.ballBounce?.(.35); } }
    if (st.x > right) { st.x = right; if (st.vx > 0) { st.vx = -st.vx * 0.7; sfx?.ballBounce?.(.35); } }

    // 掉出画面（比如她把球踢飞了）：过一会儿从边上再滚一个进来
    if (st.y > b.floorY + 400) place({ fromLeft: Math.random() < .5 });

    // 撞到她就踢
    kickIfTouching();
  }

  /** 她的碰撞盒（正面 / 背面宽度不同，跟着朝向镜像）。 */
  function hitBox() {
    const b = stage.bounds();
    const p = stage.pet();
    const facing = p.faceVis >= 0 ? 1 : -1;
    const halfW = (facing > 0 ? HIT.front : HIT.back);
    return {
      x0: p.x - (facing > 0 ? HIT.back : HIT.front),
      x1: p.x + halfW,
      y0: b.floorY - HIT.low,
      y1: b.floorY,
      cx: p.x, cy: b.floorY - HIT.low * .5,
    };
  }

  function kickIfTouching() {
    const now = performance.now();
    if (now - st.lastKick < KICK_COOL_MS) return;
    const hb = hitBox();
    if (st.x + R < hb.x0 || st.x - R > hb.x1) return;
    if (st.y + R < hb.y0 || st.y - R > hb.y1) return;

    // 方向：从她的中心指向球；球正好在中心时按朝向给一个默认方向
    let dx = st.x - hb.cx;
    const dy = (st.y - hb.cy) ;
    if (Math.abs(dx) < 6) dx = stage.pet().faceVis >= 0 ? 8 : -8;
    const len = Math.hypot(dx, dy) || 1;
    const power = KICK_MIN + Math.random() * (KICK_MAX - KICK_MIN);
    st.vx = (dx / len) * power;
    st.vy = Math.min(-140, (dy / len) * power * .5 - 120);   // 总是往上抬一点，看着像被踢飞
    st.spinV = (st.vx / R) * 1.6;
    st.lastKick = now;
    st.since = 0;
    st.resting = false;
    sfx?.kick?.();
    onEvent?.('ballKick', { x: Math.round(st.x), power: Math.round(power) });
  }

  /* ---------- 鼠标：可以拿鼠标推球、也可以抓着甩 ---------- */

  function hitTest(x, y) {
    if (!st.on) return false;
    return Math.hypot(x - st.x, y - st.y) <= R + 10;
  }

  let lastDragAt = 0;

  /** 拖着球走：跟手，速度从手的位移算出来（松手就飞出去）。dt 由这里自己算（调用处拿不到帧的 dt）。 */
  function drag(x, y) {
    if (!st.on) return;
    const now = performance.now();
    const dt = Math.min(.05, Math.max(1 / 240, (now - lastDragAt) / 1000));
    lastDragAt = now;
    const ny = Math.min(y, stage.bounds().floorY - R);
    st.vx = (x - st.x) / dt;
    st.vy = (ny - st.y) / dt;
    // 甩得太狠就夹一下：不然松手那一下球会瞬间飞出屏幕
    const sp = Math.hypot(st.vx, st.vy);
    if (sp > 1400) { st.vx *= 1400 / sp; st.vy *= 1400 / sp; }
    st.x = x; st.y = ny;
    st.spinV = st.vx / R;
    st.since = 0;
  }

  /* ---------- 绘制 ---------- */

  function draw() {
    if (!st.on || !root) return;
    const b = (box = stage.bounds());
    const floorY = b.floorY;
    // 影子：球越高越小越淡
    const h = Math.max(0, floorY - R - st.y);
    const k = Math.max(.35, 1 - h / 320);
    shadow.setAttribute('cx', st.x.toFixed(1));
    shadow.setAttribute('cy', floorY.toFixed(1));
    shadow.setAttribute('rx', (R * 1.1 * k).toFixed(1));
    shadow.setAttribute('ry', (R * .42 * k).toFixed(1));
    shadow.setAttribute('opacity', (.34 * k).toFixed(2));
    ballEl.setAttribute('transform', `translate(${st.x.toFixed(1)} ${st.y.toFixed(1)}) rotate(${(st.spin * 57.2958).toFixed(1)})`);
  }

  /* ---------- 她要过去玩 ---------- */

  /** 现在值不值得过去找球玩：球已经停稳、而且有一会儿没碰它了。 */
  function wantsPlay() {
    if (!st.on) return false;
    if (!st.resting && Math.abs(st.vx) > 60) return false;
    return st.since > 6;
  }

  return {
    setOn, step, draw, drag, hitTest, wantsPlay, mount,
    get on() { return st.on; },
    get x() { return st.x; },
    get y() { return st.y; },
    get resting() { return st.resting; },
    /** 给调试/日志用。 */
    get state() { return { on: st.on, x: Math.round(st.x), y: Math.round(st.y), vx: Math.round(st.vx), vy: Math.round(st.vy), resting: st.resting }; },
  };
};
