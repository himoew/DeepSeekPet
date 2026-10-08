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
/**
 * 落地时**大于这个速度才弹**，否则直接趴下。
 *
 * ⚠️ **这两个数字（还有 `REST_VY`）是本会话一个真 bug 的修法，别随手改回去**：
 * 原来门槛是 40、而弹起速度是 `40 × 0.55 = 22`，22 px/s 的上升**不到一帧就被重力拉回地面**，
 * 于是每帧都判成"撞地" → 弹地音效限流后仍变成**每秒 8 次的连续闷响**
 * （用户实测："静止的时候一直有弹地面类似的异响"）。所以现在：
 * **能弹的门槛（110）远高于一次性静止门槛（45）**，中间那一段直接判定静止。
 */
const BOUNCE_MIN_VY = 110;
/** 慢到这个速度以内就算静止（不再受重力、也不出声）。 */
const REST_VY = 45;
const REST_VX = 14;
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

/** 上报一句给主进程（写进 `data\pet-host.log`）。页面报错通道见 `web/diag.js`。 */
const report = (msg) => {
  try { globalThis.petHost?.report?.(String(msg).slice(0, 600)); } catch { /* 报告失败就算了 */ }
};

export const createBall = ({ fxG, sfx, stage, onEvent } = {}) => {
  const st = {
    on: false,
    x: 0, y: 0, vx: 0, vy: 0,
    spin: 0, spinV: 0,
    resting: true,
    hover: false,          // 鼠标是不是停在球上
    dragging: false,       // 正被拖着（帧率要靠它：不然"抓球"只有 30fps，看着很卡）
    lastKick: 0,
    since: 0,              // 上一次被踢到现在（秒）：用来决定"要不要过去找它玩"
  };

  let box = null;          // { W, H, floorY }，每帧问 stage 要
  let root = null, shadow = null, ballEl = null;
  /** 球弹地的音效限流：`ballBounce` 一秒最多响 8 次（防"嗡嗡"的异响）。 */
  let lastBounceAt = 0;
  /** 被挤出 `#fx` 后只自动补挂一次（见 `draw()`）。 */
  let remountTried = false;
  const bounce = (k) => {
    const now = performance.now();
    if (now - lastBounceAt < 110) return;
    lastBounceAt = now;
    sfx?.ballBounce?.(k);
  };

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
    /**
     * 首次挂载报一句给主进程（写进 `data\pet-host.log`）。
     * **为什么**：球曾经因为"和她的粒子抢同一层、被整层重写"而完全看不见，
     * 而日志里一点线索都没有（页面没抛错、World 那边一切正常）。
     * 有这一行，下次至少能立刻分清"根本没挂上去"还是"挂上去又被抹了"。
     */
    report(`[玩具球] 已挂到 #fx · 父节点=${fxG.id || fxG.tagName} · 同层子节点=${fxG.children.length}`);
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
    const floorY = b.floorY - R;                       // 球心贴地时的高度
    st.since += dt;

    /**
     * **静止 = 完全不动**：不受重力、不出声、位置锁在地面上。
     * 只有被踢 / 被拨 / 被点（`drag`）才会重新 awake。
     * 这一条是"静止还在弹"的根治 —— 光调门槛不够，静止状态必须真的跳过物理。
     */
    if (st.resting) {
      st.y = floorY;
      st.x += st.vx * dt;
      if (st.x < b.minX + R) { st.x = b.minX + R; st.vx = 0; }
      if (st.x > b.maxX - R) { st.x = b.maxX - R; st.vx = 0; }
      st.spinV = st.vx / R;
      st.spin += st.spinV * dt;
      kickIfTouching();                                // 停着的球照样能被她撞走
      return;
    }

    // 重力 + 空气阻力
    st.vy += GRAVITY * dt;
    const drag = Math.max(0, 1 - AIR_DRAG * dt);
    st.vx *= drag; st.vy *= drag;
    // 万一出现非有限值（某个 bounds 坏了、或者被甩得离谱），当场复位：
    // **别让 NaN 进物理** —— 它会永久留在球的状态里，还可能让音效每帧响一次。
    if (!Number.isFinite(st.x) || !Number.isFinite(st.y) || !Number.isFinite(st.vx) || !Number.isFinite(st.vy)) {
      place({ fromLeft: Math.random() < .5 });
      return;
    }

    st.x += st.vx * dt;
    st.y += st.vy * dt;
    st.spin += st.spinV * dt;
    st.spinV *= Math.max(0, 1 - 2.2 * dt);            // 滚动慢慢停

    if (st.y >= floorY) {
      st.y = floorY;
      if (st.vy > BOUNCE_MIN_VY) {
        // 真·落下：弹一次（音效由 `bounce()` 限流）
        st.vy = -st.vy * BOUNCE;
        st.vx *= GROUND_FRICTION;
        st.spinV = st.vx / R;                          // 落地后开始滚
        bounce(Math.min(1, Math.abs(st.vy) / 400));
        st.resting = false;
      } else if (Math.abs(st.vy) <= REST_VY && Math.abs(st.vx) <= REST_VX) {
        // 够慢了：**一次性趴下**，之后由上面的 `st.resting` 分支接管（不再弹、不再响）
        st.vy = 0; st.vx = 0;
        st.spinV = 0;
        st.resting = true;
        st.since = 0;                                  // 从"停稳"开始重新计时（她要玩球靠它）
      } else {
        // 中间那一段（45~110）：既不弹也不停，就贴着地面耗掉这点速度
        st.vy = 0;
        st.vx *= GROUND_FRICTION;
        st.spinV = st.vx / R;
        st.resting = false;
      }
    } else {
      st.resting = false;
    }

    // 撞墙回弹（同样限流：贴着墙抖动时不让它连成"嗡嗡"）
    const left = b.minX + R, right = b.maxX - R;
    if (st.x < left) { st.x = left; if (st.vx < 0) { st.vx = -st.vx * 0.7; bounce(.35); } }
    if (st.x > right) { st.x = right; if (st.vx > 0) { st.vx = -st.vx * 0.7; bounce(.35); } }

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
    st.resting = false;                    // 一拖就"醒过来"（静止分支会跳过物理）
    st.dragging = true;
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

  /**
   * 画出来。**外面包一层 try/catch**：这个函数在帧循环里被调，抛一次就会连累整帧
   * （帧循环自己有兜底，但那样球就永远不画了，而且没人知道为什么）。出一次错就上报一次。
   */
  let drawFailed = false;
  function draw() {
    if (!st.on || !root) return;
    try {
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
      // 球被整层重写抹掉时（比如别人写了 `#fx.innerHTML`）自己挂回去：只试一次，避免死循环
      if (!remountTried && root.parentNode !== fxG) {
        remountTried = true;
        fxG.appendChild(root);
        report('[玩具球] 被从 #fx 里挤掉了，已重新挂上（检查有没有人重写 #fx.innerHTML）');
      }
    } catch (err) {
      if (!drawFailed) {
        drawFailed = true;
        report(`[玩具球] 绘制抛错：${err && (err.stack || err.message)}`);
      }
    }
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
    /**
     * 球"正在动"（给页面决定帧率用）。
     * **为什么需要它**：页面静止时按 30fps 跑，而"球在滚/在飞/正被拖着"都不算她的
     * `ctl.moving`，于是**抓球的时候只有 30fps**——手很跟手、画面却是半速的，用户实感就是"卡"。
     */
    get busy() { return st.on && (st.dragging || !st.resting); },
    /** 拖着球的状态由页面设置（它知道指针按下/松开）。 */
    setDragging(on) { st.dragging = !!on; },
    /** 给调试/日志用。 */
    get state() { return { on: st.on, x: Math.round(st.x), y: Math.round(st.y), vx: Math.round(st.vx), vy: Math.round(st.vy), resting: st.resting, dragging: st.dragging }; },
  };
};
