/**
 * 临时探针（**不提交**）：验证"沿轮廓盖雪"这一版的**几何**——
 * 三顶雪各画在哪儿、有没有一枚画进她的身体里、两顶之间还有没有横穿脑袋的东西。
 *
 * 跑法：node _cap-probe.cjs
 * 它不替代自检（自检在 test\regions\07d-fx-actor.cjs），只是把这一版的形状先量出来看看。
 */
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const app = path.join(__dirname, 'DeepSeekPet', 'resources', 'app');
const SURF_JSON = JSON.parse(fs.readFileSync(path.join(app, 'web', 'whale', 'surface.json'), 'utf8'));

const el = () => ({
  attrs: {}, children: [], style: {}, _html: '', _text: '',
  setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k]; },
  removeAttribute(k) { delete this.attrs[k]; },
  appendChild(c) { this.children.push(c); return c; },
  removeChild(c) { this.children = this.children.filter((x) => x !== c); return c; },
  querySelector() { return null; }, querySelectorAll() { return []; },
  addEventListener() {}, removeEventListener() {},
  getBoundingClientRect: () => ({ x: 0, y: 0, width: 1280, height: 760, left: 0, top: 0, right: 1280, bottom: 760 }),
  classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
  set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html; },
  set textContent(v) { this._text = v; }, get textContent() { return this._text; },
  closest: () => null,
});
const stubCtx = () => ({
  globalAlpha: 1, lineWidth: 1, strokeStyle: '#888', fillStyle: '#888', font: '', textAlign: '', textBaseline: '',
  lineCap: '', lineJoin: '', globalCompositeOperation: 'source-over',
  save() {}, restore() {}, beginPath() {}, closePath() {}, moveTo() {}, lineTo() {}, bezierCurveTo() {},
  quadraticCurveTo() {}, arc() {}, ellipse() {}, rect() {}, clip() {}, stroke() {}, fill() {}, fillRect() {},
  strokeRect() {}, fillText() {}, clearRect() {}, setTransform() {}, resetTransform() {}, translate() {},
  rotate() {}, scale() {}, drawImage() {}, strokeText() {},
  createLinearGradient: () => ({ addColorStop() {} }),
  createRadialGradient: () => ({ addColorStop() {} }),
  createPattern: () => null, measureText: () => ({ width: 0 }),
  getImageData: () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 }),
});
const fakeCanvas = () => {
  const c = { width: 1, height: 1, style: {}, _ctx: null };
  c.getContext = (k) => (k === '2d' ? (c._ctx = c._ctx || stubCtx()) : null);
  c.getBoundingClientRect = () => ({ x: 0, y: 0, width: 1, height: 1 });
  return c;
};

globalThis.window = globalThis;
globalThis.document = {
  createElementNS: () => el(),
  createElement: (t) => (t === 'canvas' ? fakeCanvas() : el()),
  querySelector: () => null, querySelectorAll: () => [], documentElement: {},
};
globalThis.localStorage = { getItem: () => null, setItem() {} };
globalThis.Path2D = globalThis.Path2D || class { constructor(d) { this.d = d; } };

(async () => {
  const core = await import(`${pathToFileURL(path.join(app, 'web', 'pet-core.js')).href}?p=${Date.now()}`);
  const fxMod = await import(`${pathToFileURL(path.join(app, 'web', 'fx.js')).href}?p=${Date.now()}`);
  const B = { W: 1280, H: 760, floorY: 758, S: .42 };
  const sfx = new Proxy({}, { get: () => () => {} });
  const ctl = core.createPet({ petG: el(), shadowEl: el(), fxG: el() }, { sfx, bounds: () => B, startX: 640 });
  try { ctl.render(); } catch (e) { /* 纯 Node 下画身体会失败，按同一套公式手算 xf */ }
  ctl.pet.xf = { AX: 640, AY: B.floorY, ax: 128, ay: 256, kx: B.S, ky: B.S, rot: 0 };
  const xf = ctl.pet.xf;
  const snap = (o) => ({ AX: xf.AX, AY: xf.AY, ax: xf.ax, ay: xf.ay, kx: xf.kx, ky: xf.ky, rot: xf.rot, S: B.S, moving: false, ...o });
  const fx = fxMod.createFx({ ctl: { bounds: { W: B.W, H: B.H } }, canvas: fakeCanvas(), canvasNear: fakeCanvas() });

  fx.clear(true); fx.actor(null); fx.actor(snap()); fx.surface(SURF_JSON);
  const caps0 = fx.caps();
  console.log('surface: columns=%d x0=%d step=%d anchorLen=%s anchors=%s',
    SURF_JSON.top.length, SURF_JSON.x0, SURF_JSON.step, SURF_JSON.anchorLen,
    caps0.map((a) => `${a.x},${a.y}`).join(' / '));
  console.log('每顶雪的厚度基准 d = %s（rig 单位；期望 3.2）', caps0.map((a) => a.d).join(' / '));

  /** 往某个锚点的本地 x 上落一颗雪（走真判定），返回命中数。 */
  const land = (lx, t0, fresh) => {
    if (fresh) fx.clear(true);
    const s = fx.actorStage(lx, -20);
    fx.spawn('snow', {
      x: s.x, y: s.y, vy: 120, vT: 120, sway: 0, hz: 0, hzA: 0, phase: 0, wind: 0, slip: 0,
      stall: 0, spin: 0, spinSp: 0, rollSp: 0, layer: 1, layerN: 3, life: 40, hit: 0,
    });
    let t = t0;
    for (let i = 0; i < 60; i += 1) { t += 1 / 60; fx.frame(1 / 60, t, 'off'); }
    return t;
  };

  /* 三顶各打满（3 片） */
  let t = 3000;
  for (const a of caps0) {
    for (let k = 0; k < 3; k += 1) t = land(a.x, t, k === 0 && a === caps0[0]);
  }
  fx.actor(snap());
  fx.frame(1 / 60, t + 1 / 60, 'off');
  const st = fx.stats();
  console.log('caps amt =', fx.caps().map((a) => `${a.x}:${a.amt.toFixed(2)}`).join('  '), '| cling =', fx.clinging);

  const items = st.list.filter((q) => q.kind === 'snow' && (q.shape === 'cap' || q.shape === 'band'));
  console.log('雪的形状（近层）: cap %d 枚 / band %d 条', items.filter((q) => q.shape === 'cap').length, items.filter((q) => q.shape === 'band').length);
  console.log('每帧绘制总量: %d 个形状（其中贴图 %d 次 drawImage）', st.list.length, st.meta.callImage);

  /** 每一枚回到本地坐标，看她（身体）里有没有被画进雪 */
  let inside = 0, minAbove = 1e9, worst = '';
  const span = { cap: [1e9, -1e9], band: [1e9, -1e9] };
  for (const q of items) {
    const l = fx.actorLocal(q.x, q.y);
    const top = fx.surfaceTop(l.x);
    if (q.shape === 'cap') {
      span.cap[0] = Math.min(span.cap[0], l.x); span.cap[1] = Math.max(span.cap[1], l.x);
      const above = top - l.y;                 // >0 = 在轮廓之上（雪）；<0 = 画进她身体里了
      if (above < minAbove) { minAbove = above; worst = `本地(${l.x.toFixed(0)},${l.y.toFixed(0)}) top=${top}`; }
      if (Number.isFinite(top) && above < -.5) inside += 1;
    } else {
      const l2 = fx.actorLocal(q.len ? q.x : q.x, q.y);
      void l2;
      span.band[0] = Math.min(span.band[0], l.x); span.band[1] = Math.max(span.band[1], l.x);
    }
  }
  console.log('cap 铺开的本地 x 范围: %s → %s（她头顶那一段是 x≈50~195）',
    span.cap[0].toFixed(0), span.cap[1].toFixed(0));
  if (span.band[1] > -1e8) console.log('band（上缘描边）的本地 x 范围: %s → %s', span.band[0].toFixed(0), span.band[1].toFixed(0));
  console.log('画进身体里的 cap 枚数: %d（判据：中心低于轮廓 0.5 单位以上）', inside);
  console.log('最靠下的那一枚: 高于轮廓 %s 单位 @ %s', minAbove.toFixed(2), worst);

  /** 每顶雪单独看：铺多宽、多少枚 */
  for (const a of fx.caps()) {
    const own = [];
    for (const q of items) {
      if (q.shape !== 'cap') continue;
      const l = fx.actorLocal(q.x, q.y);
      if (Math.abs(l.x - a.x) <= 40) own.push(l);
    }
    if (!own.length) { console.log('  锚点 %d: 一枚都没有（★闸门把它关掉了）', a.x); continue; }
    const xs = own.map((o) => o.x), ys = own.map((o) => o.y);
    const tops = own.map((o) => fx.surfaceTop(o.x) - o.y);
    console.log('  锚点 %d（amt %s）: %d 枚 · 本地 x %s~%s · 高于轮廓 %s~%s',
      a.x, a.amt.toFixed(2), own.length, Math.min(...xs).toFixed(0), Math.max(...xs).toFixed(0),
      Math.min(...tops).toFixed(2), Math.max(...tops).toFixed(2));
  }
})();
