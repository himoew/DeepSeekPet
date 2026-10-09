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
/** 踢出去的速度范围（px/s）。上限从 520 提到 700：用户要"距离再增加 0.3 倍左右"。 */
const KICK_MIN = 300, KICK_MAX = 700;
/**
 * **出脚的仰角（按力度分三档）** —— 用户实测后定的手感：
 *
 *   · 轻扫 → 球到她的**脖子**高（≈75px）：好接、适合贴地推进
 *   · 中扫 → **1.5 倍她的身高**（≈145px）：正好落在她的头球区，会逼她跳起来顶
 *   · 全力 → **略高于她能碰到的上限**（≈200px+）：过顶球，她够不到 —— 靠这个得分
 *
 * 为什么用"垂直初速"而不是"角度"来写：球飞多高只由 `vy` 决定（`h = vy² / 2g`），
 * 写垂直速度可以直接对着"要飞多高"调。下面是按 `GRAVITY = 1500` 算出来的：
 *   75px  → vy ≈ 475      145px → vy ≈ 660      210px → vy ≈ 795
 * ⚠️ **别超过 ~800**：再高球一帧就飞出画面顶。
 * 表里是 `[速度门槛, 垂直初速]`，速度越高用后面那档。
 */
const KICK_LIFT = [[0, 475], [0.55 * 700, 660], [0.85 * 700, 800]];
/** 按出脚速度取垂直初速（分档，不插值 —— 三档手感更好认）。 */
function liftFor(power) {
  let vy = KICK_LIFT[0][1];
  for (const [from, v] of KICK_LIFT) if (power >= from) vy = v;
  return vy;
}
/** 同一帧里最多踢一次：给碰撞一个"冷却"，免得贴着球时每帧都踢（球会抖）。
 *  **别调太大**：她追到球边上时冷却还没好就踢不到 —— 实测会变成"球重置了她不踢过来"。 */
const KICK_COOL_MS = 280;
/** 头球单独的冷却：跳起来顶一次就够，别在空中连着顶。 */
const HEAD_COOL_MS = 320;
/**
 * 她跳起来时，头顶那一片的碰撞范围：**相对脚底**算（她跳多高，头就升多高）。
 *
 * 数值是量出来的：她**身高 ≈96px**；`pet-core` 里起跳速度 720、空中重力 2300，
 * 所以跳一次最高抬升 `720² / (2×2300) ≈ 113px` —— 跳到最高时**头顶约在离地 200px**。
 * 原来盒子只到 150px，于是 150~200 这一段飞过去的球**她完全碰不到**（用户实测："每次
 * 都从头顶飞过去"）。`HEAD_ABOVE_FEET` 也按 96px 身高重新校准过。
 */
const HEAD_ABOVE_FEET = 92;
const HEAD_BOX_H = 60;
/** 她跳起来时**够得到**的高度（px，球离地多高以内她会去顶）——≈ 2 个小肥鱼高。 */
export const HEAD_REACH = 200;
/**
 * 她的碰撞盒（以她脚下中心为原点，单位 px）：front 是朝向那一侧、
 * 大一点；back 是背对那一侧、小一点。**刻意比她的身体略小**（宁可漏判也别误判成"踢到空气"）。
 */
const HIT = { front: 52, back: 40, low: 52 };

/** 上报一句给主进程（写进 `data\pet-host.log`）。页面报错通道见 `web/diag.js`。 */
const report = (msg) => {
  try { globalThis.petHost?.report?.(String(msg).slice(0, 600)); } catch { /* 报告失败就算了 */ }
};

/**
 * 球拍模式（比赛模式）里"打一拍"的力度。
 *
 * 实测调过两轮：
 *   · 第一版要求"必须甩得快"（<110px/s 完全不给力）→ 用户点了没反应；
 *   · 第二版"轻点也给一点力"（0.55 × 300 ≈ 165px/s）→ 能动，但**只是轻微挪一下**，手感太轻。
 * 现在：**轻点也能把球推出去**（下限就是 `SWAT_MIN`），甩得越快越猛、上限 `SWAT_MAX`。
 */
const SWAT_MIN = 300;
const SWAT_MAX = 900;
/** 甩动速度达到这个值就算"满力"。 */
const SWAT_FULL_SPEED = 700;
/** 轻点时的力度系数：1.0 = 直接用 `SWAT_MIN`（300px/s，能滚过大半场）。 */
const SWAT_CLICK_POWER = 1.0;
/** 甩动速度低于这个值就算"没甩"（当轻点处理，方向取"远离她"那一侧）。 */
const SWAT_SLOW = 110;

/* ---------- 球拍：鼠标在球上的"持续接触"（跟点击无关） ---------- */

/**
 * 球拍圆盘的半径（px）。**这是让"扫过去就踢"成立的关键**：
 * 光标本身是一个点，而球只有 13px 半径 —— 用点去戳球，快速移动时每 100ms 的采样
 * （主进程的光标轮询）之间会跳过 80px 以上，**整段从球外面飞过去**。
 * 给它一个圆盘半径之后，接触判定从"点"变成"面"，再配上每帧的**线段扫掠**，就不会漏了。
 */
const PADDLE_R = 40;
/**
 * 两次"玩家用球拍踢到球"之间的最小间隔。
 * 从 200ms 提到 **500ms**（用户实测："收回来再踢容易误触成反向踢球"）——
 * 收鼠标那一下的回拉会形成一条反向的扫掠线段，间隙太小就会立刻被当成一脚。
 */
const PADDLE_COOL_MS = 500;
/** 扫掠线段至少要这么长才算"一脚"：收鼠标的小幅回拉（几十像素）不该触发。 */
const PADDLE_MIN_SWEEP = 26;
/** 光标速度低于这个值不算"主动扫"（只是鼠标的轻微抖动）。 */
const PADDLE_MIN_SPEED = 120;
/**
 * 光标速度到这个值就算满力。
 * 从 1400 提到 **2400**：用户实测"只要判定几乎就是最大力度（跳得很高）"——
 * 1400 太容易打满，中等速度的扫动也会顶到最高那一档。
 */
const PADDLE_FULL_SPEED = 2400;
/** 单帧位移的封顶（px）：防止"光标第一次进入窗口"那一下的过期位移算出爆表速度。 */
const PADDLE_MAX_STEP = 70;
/** 力度曲线指数：>1 让"中速"明显弱于"全速"（不然中间档手感糊在一起）。 */
const PADDLE_POWER_CURVE = 1.35;
/** 没在扫（只是贴着球）时的默认方向分量：朝"远离她"那一侧 + 一点点上抬。 */
const PADDLE_IDLE_LIFT = 0.25;

export const createBall = ({ fxG, sfx, stage, onEvent, game } = {}) => {
  const st = {
    on: false,
    x: 0, y: 0, vx: 0, vy: 0,
    spin: 0, spinV: 0,
    resting: true,
    hover: false,          // 鼠标是不是停在球上
    dragging: false,       // 正被拖着（帧率要靠它：不然"抓球"只有 30fps，看着很卡）
    /**
     * 冷却时间戳从 `-Infinity` 起：**别用 0**。
     * `performance.now()` 在页面刚加载时很小（也可能被测试替身设成很小的值），
     * 用 0 的话 `now - 0 >= 280` 一开始**不成立** —— 表现为"页面起来后头几百毫秒踢不动球"。
     */
    lastKick: -Infinity,
    lastHead: -Infinity,
    /** 上一次"玩家用球拍踢到球"的时刻（球拍模式的冷却）。 */
    lastPaddle: -Infinity,
    since: 0,              // 上一次被踢到现在（秒）：用来决定"要不要过去找它玩"
    releasedAt: 0,         // 上一次从手里松开（游戏用它给"拖进门"限一次）
  };

  /**
   * 游戏模式下的"瞄准 + 蓄力"（由 `web/game.js` 设置）。
   *
   *   `aimX`  踢出去时朝哪个方向（0..1 的横向比例）；null = 老行为（按球在她哪一侧往外推）
   *   `power` 这一脚的力度系数（1 = 普通，1.6 上下 ≈ 蓄力飞踢）
   *
   * **保持通用**：没设这两项时（空闲玩球）行为跟以前一模一样 —— 用户要的"对球的那套互动通用"。
   */
  const aim = { x: null, power: 1 };
  /**
   * 设"这一脚往哪踢、多大力"。**必须是函数**：游戏钩子 `onStep` 也要回调它
   * （曾经只在返回对象里写了 `setAim`，钩子里一调就是 `ReferenceError` —— 实测被帧循环的报错通道抓到）。
   */
  function setAim(a) {
    aim.x = a && Number.isFinite(a.x) ? Math.min(1, Math.max(0, a.x)) : null;
    aim.power = a && Number.isFinite(a.power) ? Math.min(2.2, Math.max(0.5, a.power)) : 1;
  }

  let box = null;          // { W, H, floorY }，每帧问 stage 要
  let root = null, shadow = null, ballEl = null, paddleEl = null;
  /** 球弹地的音效限流：`ballBounce` 一秒最多响 8 次（防"嗡嗡"的异响）。 */
  let lastBounceAt = 0;
  /** 重入保护（见 `step`）。 */
  let stepping = false;
  /** 被挤出 `#fx` 后只自动补挂一次（见 `draw()`）。 */
  let remountTried = false;
  const bounce = (k) => {
    const now = performance.now();
    if (now - lastBounceAt < 110) return;
    lastBounceAt = now;
    sfx?.ballBounce?.(k);
  };

  /* ---------- 开关 ---------- */

  /**
   * 造一个 SVG 元素。**必须用 `createElementNS`，不能用 `innerHTML`**：
   * 给 SVG 元素赋 `innerHTML` 时，字符串是按 **HTML** 规则解析的（`<circle>` 会落进 HTML 命名空间），
   * 结果就是"元素确实在 DOM 里、但一个像素都不画" —— 而且不报错、`getBoundingClientRect` 还是 0。
   * 实测踩过：球开了、日志说挂上了、肉眼什么都看不见。
   */
  const mk = (tag, attrs) => {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
    return el;
  };

  /**
   * 球的外观：**直接用一张贴图**（`web/ball.png`，由用户给的图抠出来的，
   * 见 `tools/make-ball-texture.py`）。
   *
   * 为什么不再自己拼：第一版用"圆 + 缝线 + 高光"手画，13px 半径下糊成一团、
   * 还被说像鸡蛋。贴图一次到位，想换球只要换那张 PNG。
   * **注意用 `<image>` 而不是给 SVG 元素赋 `innerHTML`**（那条路会落进 HTML 命名空间、画不出来）。
   */
  function buildBall() {
    ballEl.appendChild(mk('image', {
      class: 'toy-ball-pic',
      href: '/web/ball.png',
      x: -R, y: -R, width: R * 2, height: R * 2,
      preserveAspectRatio: 'xMidYMid meet',
    }));
  }

  function mount() {
    if (root || !fxG) return;
    /**
     * **先把贴图预热**：第一次显示球时如果要现场解码 PNG，会看到"卡一下"。
     * 页面一加载就开始拉这张图（它很小，几百 ms 就完事）。
     */
    try {
      const img = new Image();
      img.onload = () => report(`[玩具球] 贴图就绪 ${img.naturalWidth}x${img.naturalHeight}`);
      img.onerror = () => report('[玩具球] 贴图加载失败！球会看不见（检查 /web/ball.png）');
      img.src = '/web/ball.png';
    } catch { /* 没有 Image（离线自检的桩环境）就算了 */ }
    root = mk('g', { class: 'toy-ball', 'aria-hidden': 'true' });
    shadow = mk('ellipse', { class: 'toy-ball-shadow' });
    /**
     * **球拍光环**：画在鼠标位置上的一个虚线圈，半径就是真正的接触半径。
     * 用户实测的问题："范围看不见，收回时容易踢进自己家球门" ——
     * 看不见的判定区会让人误判"我已经离开球了"。把它画出来，手感立刻可预期。
     * 放在最前面（画的顺序：光环 → 影子 → 球），这样球永远压在光环上面。
     */
    paddleEl = mk('circle', { class: 'toy-paddle', r: PADDLE_R, cx: 0, cy: 0 });
    paddleEl.setAttribute('opacity', '0');
    root.appendChild(paddleEl);
    ballEl = mk('g', { class: 'toy-ball-body-wrap' });
    buildBall();
    root.appendChild(shadow);
    root.appendChild(ballEl);
    fxG.appendChild(root);
    /**
     * 首次挂载报一句给主进程（写进 `data\pet-host.log`）。
     * **为什么**：球曾经因为"和她的粒子抢同一层、被整层重写"而完全看不见，
     * 而日志里一点线索都没有（页面没抛错、World 那边一切正常）。
     * 现在连**画出来没有**一起报：直角坐标宽高、子节点数、以及实际用的填充色。
     */
    const box = root.getBoundingClientRect ? root.getBoundingClientRect() : { width: -1, height: -1 };
    // 读**贴图那个 `<image>`** 的参数（不是渐变定义节点 —— 读错会白排查一轮）
    const pic = ballEl.querySelector ? ballEl.querySelector('image') : null;
    const href = pic ? (pic.getAttribute('href') || pic.getAttribute('xlink:href') || '?') : '?';
    report(`[玩具球] 已挂到 #fx · 父节点=${fxG.id || fxG.tagName} · 子节点=${fxG.children.length}`
      + ` · 球的盒子=${Math.round(box.width)}x${Math.round(box.height)} · 贴图=${href}`
      + ` · 尺寸=${pic ? pic.getAttribute('width') + 'x' + pic.getAttribute('height') : '?'}`);
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

  /**
   * **球拍模式**（比赛模式）：球不能抓，只能"打"。
   *
   * 用户的想法（原话）："在比赛模式里球不能抓，只能被鼠标打回去"。
   * 这一条正好治了"赖皮"的根：你的优势本来来自"能把球拎到任何位置再放手"，
   * 不能抓之后就必须**隔着半个场地把它抽进网**，她的守门与头球才有意义。
   *
   * `grabable === false` 时：`hitTest` 返回 false（页面不会开始拖动），
   * 改为调用 `swat(dir)` —— 按鼠标甩动的速度给球一个冲量。
   */
  const grab = { ok: true };
  /** 鼠标位置采样（给"球拍"用）：页面每帧喂一次。 */
  const cur = { x: 0, y: 0, at: 0, ok: false, lastX: 0, lastY: 0, lastAt: 0 };

  /**
   * 页面每帧把光标位置喂进来（**不管有没有按下**）。
   * 这是"持续接触"模型的地基：只有在没有点击时也知道鼠标在哪，才能做到"扫过去就踢"。
   */
  function setCursor(x, y, at) {
    const t = Number.isFinite(at) ? at : performance.now();
    if (cur.ok) { cur.lastX = cur.x; cur.lastY = cur.y; cur.lastAt = cur.at; }
    cur.x = Number(x) || 0; cur.y = Number(y) || 0; cur.at = t; cur.ok = true;
  }
  /** 光标离开窗口。 */
  function clearCursor() { cur.ok = false; }

  /**
   * 线段与球的相交检测（**扫掠**，不是点）。
   *
   * 为什么必须扫掠：光标两次采样之间可能移动几十上百像素（主进程轮询是 100ms，
   * 页面喂的是每帧一次），如果只测"当前这一点在不在球里"，快速移动就会**整段跳过去**。
   * 把"上一次位置 → 这一次位置"当作一条线段，和球（圆）求最近距离，就不会漏。
   *
   * @returns {{t:number, px:number, py:number, nx:number, ny:number}|null}
   *   `t` 是接触发生在这一段的哪个比例处，`(nx,ny)` 是"球心 → 接触点"的单位法向。
   */
  function sweepContact(ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = 0;
    if (len2 > 1e-6) {
      t = ((st.x - ax) * dx + (st.y - ay) * dy) / len2;
      t = Math.max(0, Math.min(1, t));
    }
    const px = ax + dx * t, py = ay + dy * t;
    const ddx = st.x - px, ddy = st.y - py;
    const dist2 = ddx * ddx + ddy * ddy;
    const reach = R + PADDLE_R;
    if (dist2 > reach * reach) return null;
    const d = Math.sqrt(dist2) || 1e-6;
    return { t, px, py, nx: ddx / d, ny: ddy / d };
  }

  /**
   * **玩家踢一脚**（球拍模式的接触生效时调用）。
   *
   * 用户要的："鼠标接触球就跟小人踢出去一样的状态" —— 所以这里**刻意复用她的踢球规则**：
   * 力度落在同一个区间（`KICK_MIN ~ KICK_MAX`）、同样往上抬一点、同样的音效、
   * 同样给 `game.onKick`（游戏那边会决定要不要"蓄力"）。
   * 区别只有方向：她按"背对球心 → 朝对面的门"，玩家按"**鼠标这一段扫过去的方向**"。
   */
  function playerKick(dirX, dirY, speed) {
    const b = stage.bounds();
    /** 力度：用曲线压一下，中速不会直接顶到满力（见 `PADDLE_POWER_CURVE`）。 */
    const k = Math.min(1, Math.max(0, speed) / PADDLE_FULL_SPEED) ** PADDLE_POWER_CURVE;
    const power = KICK_MIN + (KICK_MAX - KICK_MIN) * k;
    const n = Math.hypot(dirX, dirY) || 1;
    let ux = dirX / n;
    /**
     * **在自家半场时，绝不朝自家球门踢**（用户实测："收回来再踢容易误触成反向踢球"、
     * "容易踢进自己家球门"）。判定用"球在哪半边"而不是"球离门多近" —— 后者在门前那块会失效。
     * 只要球在自家半场，横向分量强制朝对面；纵向照旧由仰角表决定。
     */
    if (aim.x !== null && aim.x !== undefined) {
      const ownGoalX = b.minX + (1 - aim.x) * (b.maxX - b.minX);   // 对面门 → 自家门
      const inOwnHalf = Math.abs(st.x - ownGoalX) < (b.maxX - b.minX) * 0.5;
      const wantSign = Math.sign(b.minX + aim.x * (b.maxX - b.minX) - st.x) || 1;
      if (inOwnHalf && Math.sign(ux) !== wantSign) ux = wantSign * Math.abs(ux);
    }
    st.vx = ux * power;
    /**
     * **高度按力度分档**（见 `KICK_LIFT`）：轻扫到她的脖子、中扫到 1.5 倍她、全力过顶。
     * 老写法是 `dirY * power * .5 - 120`（永远只有 120~200 的抬升）→ 用户实测"球踢得太低了"。
     */
    const lift = liftFor(power);
    st.vy = Math.min(-140, -lift + Math.min(0, (dirY / n) * power * .25));
    st.spinV = (st.vx / R) * 1.6;
    st.resting = false;
    st.dragging = false;
    st.since = 0;
    st.lastKick = performance.now();
    st.lastPaddle = performance.now();
    sfx?.kick?.();
    onEvent?.('ballKick', {
      x: Math.round(st.x),
      power: Math.round(power),
      at: +(st.x / Math.max(1, b.W)).toFixed(4),
      dir: Math.round((dirX / n) * 100) / 100,
      by: 'player',
    });
    game?.onKick?.({ x: st.x, power, by: 'player' });
    return power;
  }

  /**
   * 每帧检查"鼠标有没有碰到球"（球拍模式的**唯一入口**：不需要点击）。
   *
   * 流程：光标上一帧位置 → 这一帧位置 作线段 → 与球求接触 →
   *   · 在扫（速度 ≥ `PADDLE_MIN_SPEED`）→ 沿扫动方向踢，力度随速度；
   *   · 只是贴着球（没在扫）→ 朝"远离她"那一侧轻推一下。
   * 有 200ms 冷却，所以贴着球一路推不会变成"带球"（防赖皮仍在）。
   */
  function paddleIfTouching() {
    if (!st.on || grab.ok || !cur.ok) return;
    if (performance.now() - (st.lastPaddle || -Infinity) < PADDLE_COOL_MS) return;
    const rawAx = cur.lastAt ? cur.lastX : cur.x;
    const rawAy = cur.lastAt ? cur.lastY : cur.y;
    const rawDx = cur.x - rawAx, rawDy = cur.y - rawAy;
    const rawLen = Math.hypot(rawDx, rawDy);
    /**
     * **单帧位移封顶**：光标"第一次进入窗口"时，上一点可能是很久以前的旧位置，
     * 那一帧的位移会横跨很大一段 → 算出来的速度爆表 → **每次接触都是满力**（用户实测）。
     * 封顶之后，线段方向不变、速度按封顶值算，既不会漏接触也不会打出满力。
     */
    const k = rawLen > PADDLE_MAX_STEP ? PADDLE_MAX_STEP / rawLen : 1;
    const ax = cur.x - rawDx * k, ay = cur.y - rawDy * k;
    const swept = rawLen * k;
    /**
     * 太短的扫掠不算一脚（只有"贴着球时鼠标的微小抖动"那么长）：
     * 用户实测的问题之一就是"收鼠标回来"时被当成反向踢。
     * 注意这里**不再直接 return** —— 短位移仍然可能是一次"贴着球的轻推"（见下面那条分支）。
     */
    const hit = sweepContact(ax, ay, cur.x, cur.y);
    if (!hit) return;
    const dt = Math.max(8, (cur.at - (cur.lastAt || cur.at)) || 16);
    const vx = (cur.x - ax) / (dt / 1000);
    const vy = (cur.y - ay) / (dt / 1000);
    const speed = Math.hypot(vx, vy);
    /**
     * **扫动的判定**：位移够长（`PADDLE_MIN_SWEEP`）而且速度够快 → 按扫动方向踢。
     *
     * 老写法只要求速度、不要求位移，于是"轻轻扫过球"会掉进下面那条"朝远离她的方向推"，
     * 而那个方向**跟你扫的方向无关**（球在她左边时"远离她"是往右）——
     * 用户实测："轻轻扫过球是往反方向踢"。现在方向一律以**你的扫动方向**为准，
     * 只有**真的几乎没动**（位移 < 8px）才走"轻推"那条兜底。
     */
    if (swept >= PADDLE_MIN_SWEEP && speed >= PADDLE_MIN_SPEED) { playerKick(vx, vy, speed); return; }
    if (swept >= 8) { playerKick(rawDx, rawDy, Math.max(PADDLE_MIN_SPEED, speed)); return; }
    // 真的几乎没动（贴着球停住）：朝"远离她"那一侧轻推一下
    const p = stage.pet();
    const bb = stage.bounds();
    playerKick(st.x >= (p?.x ?? bb.W / 2) ? 1 : -1, -PADDLE_IDLE_LIFT, PADDLE_MIN_SPEED);
  }

  /**
   * 打一拍：按方向与力度给球一个冲量。
   *
   * ⚠️ **轻点也要能打**（用户实测：他只是"点"了一下球，速度 2px/s，我原来判"推不动" → 完全没反应）。
   * 现在的规则是：
   *   · **甩了**（> `SWAT_SLOW`）→ 方向=甩动方向、力度随甩速（300~900）；
   *   · **没甩/只点一下** → 方向 = **远离她的方向**（朝空场那边推）、力度 = 轻（`SWAT_CLICK_POWER`）。
   *
   * 注意这**不等于**"能用鼠标把球带进门"：`grabable` 仍然是 false，
   * `hitTest` 永远不通过，所以球**不会被拖着走** —— 只是被推出去。
   */
  function swat(dir, speed) {
    if (!st.on || grab.ok) return 0;
    const b = stage.bounds();
    const sp = Math.max(0, Math.min(1600, Number(speed) || 0));
    let dx = Number(dir?.x) || 0;
    let dy = Number(dir?.y) || 0;
    let power;
    if (sp >= SWAT_SLOW && Math.hypot(dx, dy) > 0.5) {
      power = SWAT_MIN + (SWAT_MAX - SWAT_MIN) * Math.min(1, sp / SWAT_FULL_SPEED);
    } else {
      // 只是点了一下：朝"远离她"的方向轻推（球心在她哪一侧，就往那一侧推）
      const p = stage.pet();
      dx = st.x >= (p?.x ?? b.W / 2) ? 1 : -1;
      dy = -0.25;
      power = SWAT_MIN * SWAT_CLICK_POWER;
    }
    const len = Math.hypot(dx, dy) || 1;
    st.vx = (dx / len) * power;
    st.vy = (dy / len) * power - 40;                   // 稍微往上抬一点，像"挑"了一下
    st.spinV = (st.vx / R) * 1.5;
    st.resting = false;
    st.dragging = false;
    st.since = 0;
    st.lastKick = performance.now();                   // 别紧接着又被算成"她踢到了"
    onEvent?.('ballSwat', { x: Math.round(st.x), power: Math.round(power), speed: Math.round(sp) });
    return power;
  }

  function step(dtRaw) {
    if (!st.on) return;
    /**
     * **重入保护**：这个函数在帧循环里被调。如果哪天有人（或某个钩子）在它没跑完时又调一次，
     * 就会叠加物理、还可能把"进球/踢球"这类事件成倍放大 —— 症状是画面卡住但语音还在响
     * （语音在 worker 里，主线程卡住它照样出声）。这里直接挡掉重入。
     */
    if (stepping) return;
    stepping = true;
    try {
      stepInner(dtRaw);
    } finally {
      stepping = false;
    }
  }

  function stepInner(dtRaw) {
    const dt = Math.min(Math.max(dtRaw, 0), 0.05);   // 切回窗口时别一次算一大步
    const b = (box = stage.bounds());
    const floorY = b.floorY - R;                       // 球心贴地时的高度
    st.since += dt;

    /**
     * **被拖着的时候物理完全停手**（位置由指针说了算）。
     *
     * 这是"抓住拖动会一直乱弹直到飞走"的修法：原来 `drag()` 设坐标、`step()` 同一帧又施加重力
     * 并把它挪走，两个东西抢同一个球；加上"撞到她就被踢"，就成了乱弹。
     * 实测推演（离线跑真物理）：拖动中 `vy` 被每帧叠加到 **-335**，松手时这些速度全留着 → 乱飞。
     * 现在拖住的时候不出物理、也不判碰撞；松手后由 `drag()` 留下的、**按位移算出来的**速度接手。
     */
    if (st.dragging) { st.vx = 0; st.vy = 0; st.resting = false; return; }

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
      paddleIfTouching();                              // ...也能被鼠标扫走（球拍模式）
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

    // 撞到她就踢（或被她**跳起来用头顶**）
    kickIfTouching();
    // 鼠标碰到球就踢（球拍模式：**不需要点击**，见 paddleIfTouching）
    paddleIfTouching();

    /**
     * **游戏模式的钩子**（`web/game.js`）。球本身不知道有"球门/比分"这回事：
     * 它只把"这一帧发生了什么"告诉钩子，钩子（游戏）负责瞄准、判进球、记分。
     * 没给钩子时（空闲玩球）一切照旧 —— 用户要的"对球的那套互动通用"。
     */
    if (game) {
      game.onStep?.({
        dt,
        x: st.x, y: st.y, vx: st.vx, vy: st.vy,
        resting: st.resting, dragging: st.dragging,
        floorY: b.floorY, R,
        setAim,
      });
    }
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

  /**
   * 她的**脑袋**的碰撞盒 —— 只在**她腾空时**才算。
   *
   * 用户要的："她的脑袋应该也有碰撞体积，后面她可以跳起来接回来。"
   * 所以跳起来的这段时间里，头顶那一片是能碰到球的：球从上方经过就**被顶回去**
   * （顶回去的方向照旧走 `aim`，游戏里就是朝对面的门）。
   * **"腾空"用她的脚离地判断**（`p.feetY` 比地面高一截），不去读她的内部状态机；
   * 脑袋的位置也是**相对脚底**算的（她跳多高，头就跟着升多高）。
   */
  function headBox() {
    const b = stage.bounds();
    const p = stage.pet();
    const feet = Number.isFinite(p.feetY) ? p.feetY : b.floorY;
    if (b.floorY - feet < 6) return null;               // 站在地上：头不算碰撞体
    const top = feet - HEAD_ABOVE_FEET;
    return { x0: p.x - 34, x1: p.x + 34, y0: top, y1: top + HEAD_BOX_H };
  }

  /**
   * 碰到她：**脑袋优先**（跳起来顶），否则算踢一脚。
   *
   * 两种情况：
   *   - **瞄准模式**（游戏里 `aim.x` 有值）：朝那个方向踢（她的球门在对面），力度还乘 `aim.power`
   *     —— 蓄力飞踢就是 `power` 给到 1.6 上下；
   *   - **自由玩球**（没设瞄准）：老行为，按球在她哪一侧往外推。
   * 两种都会先"往上抬一点"，看着才像被踢飞。
   */
  function kickIfTouching() {
    const now = performance.now();
    // 1) 头球
    const head = headBox();
    if (head && now - st.lastHead >= HEAD_COOL_MS
      && st.x + R >= head.x0 && st.x - R <= head.x1
      && st.y + R >= head.y0 && st.y - R <= head.y1) {
      st.lastHead = now;
      const b = stage.bounds();
      const dir = aim.x !== null && aim.x !== undefined
        ? Math.sign(b.minX + aim.x * (b.maxX - b.minX) - st.x) || (st.x < b.W / 2 ? 1 : -1)
        : (stage.pet().faceVis >= 0 ? 1 : -1);
      const power = (KICK_MIN + Math.random() * (KICK_MAX - KICK_MIN)) * 1.05;
      st.vx = dir * power;
      st.vy = -Math.min(300, power * .42);              // 顶出去带一点上抛，看着像"顶"
      st.spinV = (st.vx / R) * 1.6;
      st.resting = false;
      st.since = 0;
      sfx?.kick?.(1);
      onEvent?.('ballHead', { x: Math.round(st.x), at: +(st.x / Math.max(1, b.W)).toFixed(4) });
      game?.onKick?.({ x: st.x, power, head: true });
      return;
    }

    if (now - st.lastKick < KICK_COOL_MS) return;
    const hb = hitBox();
    if (st.x + R < hb.x0 || st.x - R > hb.x1) return;
    if (st.y + R < hb.y0 || st.y - R > hb.y1) return;

    const b = stage.bounds();
    const base = KICK_MIN + Math.random() * (KICK_MAX - KICK_MIN);
    const power = base * (aim.power || 1);
    let dirX, dirY;
    if (aim.x !== null && aim.x !== undefined) {
      /**
       * 瞄准：横向朝目标、纵向给一个**比较平的**仰角（原来 -0.45 是高抛，球慢还容易飘过门框）。
       *
       * ⚠️ **不能把球踢向自己的门**：如果球已经跑到她**自己门前**（离门线只剩窗口的 ~18%），
       * 还照直瞄准对面的门，球会先穿过她自己的网区 —— 用户实测就是"把小人拖过来，她往自己网里踢"。
       * 这时候改成**先把球踢出去（朝对面、而且方向强制向外）**，别在自家门口纠缠。
       */
      const targetX = b.minX + aim.x * (b.maxX - b.minX);
      const ownGoalX = b.maxX - targetX + b.minX;                // 目标门的对面 = 她自己的门
      const nearOwnGoal = Math.abs(st.x - ownGoalX) < b.W * 0.18;
      let dx = targetX - st.x;
      if (nearOwnGoal) dx = (targetX > st.x ? 1 : -1) * Math.max(Math.abs(dx), b.W * 0.4);
      if (Math.abs(dx) < 8) dx = (dx < 0 ? -8 : 8);
      const dy = -0.30;
      const n = Math.hypot(dx, 1) || 1;                   // 横向先化成"每 1 单位纵向"的比例
      dirX = dx / n; dirY = dy;
      const m = Math.hypot(dirX, dirY) || 1;
      dirX /= m; dirY /= m;
      // 最后一层保险：无论如何别朝**球门一侧**踢（踢出去必须是"往外"的）
      if (Math.sign(dirX) !== 0 && Math.sign(dirX) === Math.sign(ownGoalX - st.x)
        && Math.abs(st.x - ownGoalX) < b.W * 0.18) {
        dirX = -dirX;
      }
    } else {
      let dx = st.x - hb.cx;
      const dy = st.y - hb.cy;
      if (Math.abs(dx) < 6) dx = stage.pet().faceVis >= 0 ? 8 : -8;
      const n = Math.hypot(dx, dy) || 1;
      dirX = dx / n; dirY = dy / n;
    }
    st.vx = dirX * power;
    /**
     * 高度跟玩家那套**统一**（`KICK_LIFT` 按力度分档）：
     * 以前她踢的球只有 120~200 的抬升，用户实测"球踢得太低了"。
     * 现在她的球也到她脖子/1.5 倍她/过顶三档，两边手感一致。
     */
    st.vy = Math.min(-140, -liftFor(power) + Math.min(0, dirY * power * .25));
    st.spinV = (st.vx / R) * 1.6;
    st.lastKick = now;
    st.since = 0;
    st.resting = false;
    sfx?.kick?.();
    onEvent?.('ballKick', {
      x: Math.round(st.x),
      power: Math.round(power),
      at: +(st.x / Math.max(1, b.W)).toFixed(4),
      dir: Math.round(dirX * 100) / 100,               // 这一脚的横向方向（-1 左 / +1 右）
    });
    game?.onKick?.({ x: st.x, power });
  }

  /* ---------- 鼠标：可以拿鼠标推球、也可以抓着甩 ---------- */

  function hitTest(x, y) {
    if (!st.on) return false;
    if (!grab.ok) return false;                          // 球拍模式：不能抓（见 `swat`）
    return Math.hypot(x - st.x, y - st.y) <= R + 10;
  }

  /** 球拍模式的"碰到球了吗"（抓不了，但还能打）。 */
  function near(x, y) {
    if (!st.on) return false;
    return Math.hypot(x - st.x, y - st.y) <= R + 14;
  }

  let lastDragAt = 0;
  /**
   * 最近几次指针采样（时间 + 位置）。
   *
   * **为什么不用"上一帧的位移"**：用户松手前常常会**停一下再松开**，那时最后一帧的位移是 0，
   * 算出来就是"丢不出去"（实测反馈："松手的瞬间有关系，有时能丢出去"）。
   * 所以速度取**最近一个短窗口（~100ms）的整体位移**：停手再松 → 速度自然衰减到很小（轻轻放下），
   * 边动边松 → 用这一段真实的甩动速度丢出去。
   */
  const samples = [];
  const pushSample = (x, y, now) => {
    samples.push({ x, y, t: now });
    while (samples.length > 3 && now - samples[0].t > 100) samples.shift();
  };
  /** 最近 100ms 的平均速度（px/s）。不足两个采样、或时间太短就给 0。 */
  const velocityNow = (now) => {
    if (samples.length < 2) return { vx: 0, vy: 0 };
    const a = samples[0], b = samples[samples.length - 1];
    const dt = (b.t - a.t) / 1000;
    if (dt < 0.015) return { vx: 0, vy: 0 };
    return { vx: (b.x - a.x) / dt, vy: (b.y - a.y) / dt };
  };

  /** 拖着球走：位置完全跟着指针，**物理这一帧由 `step()` 跳过**（`st.dragging`）。 */
  function drag(x, y) {
    if (!st.on) return;
    st.resting = false;                    // 一拖就"醒过来"（静止分支会跳过物理）
    st.dragging = true;
    const now = performance.now();
    const ny = Math.min(y, stage.bounds().floorY - R);
    pushSample(x, ny, now);
    const v = velocityNow(now);
    // 甩得太狠就夹一下：不然松手那一下球会瞬间飞出屏幕
    const sp = Math.hypot(v.vx, v.vy);
    const k = sp > 900 ? 900 / sp : 1;
    st.vx = v.vx * k; st.vy = v.vy * k;
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
      /**
       * **球拍光环**：画在鼠标位置上（半径 = 真实接触半径）。
       * 只在"球拍模式"（比赛模式，球不能抓）时显示；自由玩球是"抓住甩"，不需要它。
       * 进入球的范围时更亮一点，扫中那一下闪一下 —— 这样"我的手离球多远"一眼可见。
       */
      if (paddleEl) {
        const show = !grab.ok && cur.ok;
        if (show) {
          const near = Math.hypot(cur.x - st.x, cur.y - st.y) <= R + PADDLE_R;
          const hot = performance.now() - (st.lastPaddle || -Infinity) < 120;
          paddleEl.setAttribute('cx', cur.x.toFixed(1));
          paddleEl.setAttribute('cy', cur.y.toFixed(1));
          paddleEl.setAttribute('opacity', hot ? '.95' : near ? '.7' : '.3');
          paddleEl.setAttribute('class', `toy-paddle${hot ? ' toy-paddle-hot' : near ? ' toy-paddle-near' : ''}`);
        } else {
          paddleEl.setAttribute('opacity', '0');
        }
      }
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
    setOn, step, draw, drag, hitTest, wantsPlay, mount, swat, near,
    /**
     * 球拍模式：页面每帧把光标位置喂进来（**不需要点击**）。
     * 传 `at`（performance.now()）让球自己算扫掠速度；不传就用当前时间。
     */
    setCursor, clearCursor,
    /** 给自检/调试看：球拍是否处于"持续接触"模式（= 球不能抓的那些时候）。 */
    get paddleMode() { return !grab.ok; },
    /**
     * 能不能抓（比赛模式里不能 —— 只能打）。
     * `web/game.js` 切模式时会调它；空闲玩球时是 `true`，抓/甩的手感照旧。
     */
    setGrabable(on) { grab.ok = !!on; },
    get grabable() { return grab.ok; },
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
    /** 上一次从手里松开是什么时候（游戏用来给"拖球进门"限一次，见 setDragging）。 */
    get releasedAt() { return st.releasedAt || 0; },
    /**
     * 上一次"从你手里出来"是什么时候（丢出来 `placeAt`、或者拖着松手都算）。
     * 游戏用它判断"这只是**你丢过去的球**吗" —— 只有你丢的球才让她跳起来接，
     * 否则她自己踢飞又反弹回来的球会被她当作"来球"再顶一次。
     */
    get lastRelease() { return st.lastRelease || 0; },
    setAim,
    /**
     * 游戏模式用：把球**直接放到某个位置**（开球、进球后重新开球）。
     * 会顺手清掉速度、让她那一脚的冷却重新计时。
     */
    placeAt(fx, fy, opts = {}) {
      const b = stage.bounds();
      st.x = b.minX + Math.min(1, Math.max(0, fx)) * (b.maxX - b.minX);
      const floorAt = b.floorY - R;
      st.y = fy === 'floor' ? floorAt : Math.min(floorAt, Math.max(0, Number(fy) || 0));
      st.vx = Number(opts.vx) || 0;
      st.vy = Number(opts.vy) || 0;
      st.spinV = 0;
      /**
       * ⚠️ **放到半空的球绝不能是"静止"**：静止分支会把球**直接按到地面上**（`st.y = floorY`），
       * 于是"往上扔一颗高球"根本不存在 —— 球一放手就贴地。
       * （用户实测"每次都从头顶飞过去"的另一半原因就在这里：球压根没在空中待过。）
       * 所以按**位置**定 resting，不按速度：只要离地就让它落。
       */
      const inAir = st.y < floorAt - 0.5;
      if (inAir && st.vy === 0) st.vy = 1;              // 给一点初速，让物理接手
      st.resting = !inAir && st.vx === 0 && st.vy === 0;
      st.dragging = false;
      st.lastKick = -Infinity;                          // 放到新位置后允许立刻被踢
      st.lastRelease = performance.now();               // 从手里放出来的：可以算"你丢的球"
      st.since = opts.since === undefined ? 0 : opts.since;
      return { x: st.x, y: st.y };
    },
    /** 拖着球的状态由页面设置（它知道指针按下/松开）。 */
    setDragging(on) {
      const now = !!on;
      // 松手那一刻记一笔：游戏里"拖球进门"要等这一轮结束才再算进球，
      // 不然你把它慢慢推过门线，每帧都算一次（分数疯涨）
      if (st.dragging && !now) {
        st.releasedAt = performance.now();
        st.lastRelease = st.releasedAt;
      }
      st.dragging = now;
    },
    /** 给调试/日志用。 */
    get state() { return { on: st.on, x: Math.round(st.x), y: Math.round(st.y), vx: Math.round(st.vx), vy: Math.round(st.vy), resting: st.resting, dragging: st.dragging }; },
  };
};
