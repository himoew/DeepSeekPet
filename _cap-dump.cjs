/**
 * 临时（**不提交**）：把 fx.js 真算出来的**积雪绘制清单**导成 JSON，给 `_cap-png.py` 出对照图用。
 * 每一枚笔触都换回 rig 坐标（`actorLocal`），所以图上的形状 = 她坐标系里的真实形状。
 *
 * 跑法：node _cap-dump.cjs > _cap-dump.json
 */
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const app = path.join(__dirname, 'DeepSeekPet', 'resources', 'app');
const SURF = JSON.parse(fs.readFileSync(path.join(app, 'web', 'whale', 'surface.json'), 'utf8'));
const MODEL = JSON.parse(fs.readFileSync(path.join(app, 'web', 'whale', 'model.json'), 'utf8'));

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
  const core = await import(`${pathToFileURL(path.join(app, 'web', 'pet-core.js')).href}?d=${Date.now()}`);
  const fxMod = await import(`${pathToFileURL(path.join(app, 'web', 'fx.js')).href}?d=${Date.now()}`);
  const B = { W: 1280, H: 760, floorY: 758, S: .42 };
  const sfx = new Proxy({}, { get: () => () => {} });
  const ctl = core.createPet({ petG: el(), shadowEl: el(), fxG: el() }, { sfx, bounds: () => B, startX: 640 });
  try { ctl.render(); } catch (e) { /* 纯 Node */ }
  ctl.pet.xf = { AX: 640, AY: B.floorY, ax: 128, ay: 256, kx: B.S, ky: B.S, rot: 0 };
  const xf = ctl.pet.xf;
  const snap = (o) => ({ AX: xf.AX, AY: xf.AY, ax: xf.ax, ay: xf.ay, kx: xf.kx, ky: xf.ky, rot: xf.rot, S: B.S, moving: false, ...o });
  const fx = fxMod.createFx({ ctl: { bounds: { W: B.W, H: B.H } }, canvas: fakeCanvas(), canvasNear: fakeCanvas() });

  fx.clear(true); fx.actor(null); fx.actor(snap()); fx.surface(SURF);
  /* 三顶各打满（走真判定：真发射、真下落、真命中） */
  const caps = fx.caps();
  for (const a of caps) {
    for (let k = 0; k < 3; k += 1) {
      const s = fx.actorStage(a.x, -20);
      fx.spawn('snow', { x: s.x, y: s.y, vy: 120, vT: 120, sway: 0, hz: 0, hzA: 0, phase: 0, wind: 0, slip: 0, stall: 0, spin: 0, spinSp: 0, rollSp: 0, layer: 1, layerN: 3, life: 40 });
      for (let i = 0; i < 40; i += 1) fx.frame(1 / 60, 9000 + k * 10 + i / 60, 'off');
    }
  }
  fx.actor(snap());
  fx.frame(1 / 60, 9999, 'off');
  const st = fx.stats();
  /* 诊断：每一枚雪形状回到本地坐标后，**低于轮廓多少**（正数 = 画进她身体里了） */
  let worstBelow = -1e9, worstAt = '';
  for (const q of st.list) {
    if (q.kind !== 'snow') continue;
    const l = fx.actorLocal(q.x, q.y);
    const t = fx.surfaceTop(l.x);
    if (!Number.isFinite(t)) continue;
    const below = l.y - t;
    if (below > worstBelow) { worstBelow = below; worstAt = `${q.shape} 本地(${l.x.toFixed(1)},${l.y.toFixed(1)}) top=${t.toFixed(1)}`; }
  }
  process.stderr.write(`# 最靠下的一枚：低于轮廓 ${worstBelow.toFixed(2)} 单位 @ ${worstAt}\n`);
  const out = [];
  for (const q of st.list) {
    if (q.kind !== 'snow') continue;
    if (q.shape === 'cap') {
      const l = fx.actorLocal(q.x, q.y);
      out.push({ shape: 'cap', lx: l.x, ly: l.y, len: q.len, sx: q.sx, op: q.op });
    } else if (q.shape === 'band') {
      const a = fx.actorLocal(q.x, q.y), b = fx.actorLocal(q.x2, q.y2);
      out.push({ shape: 'band', x1: a.x, y1: a.y, x2: b.x, y2: b.y, w: q.w || .9, op: q.op, col: q.col });
    }
  }
  process.stdout.write(JSON.stringify({
    surface: { x0: SURF.x0, x1: SURF.x1, step: SURF.step, top: SURF.top, bot: SURF.bot, anchors: SURF.anchors },
    caps: fx.caps().map((a) => [a.x, a.y, a.amt, a.d]),
    model: { name: MODEL.name || null },
    new: out,
  }));
})();
