/**
 * The DeepSeek whale maid as a pet-core figure: a sprite rig drawn with rig/rig.js.
 *
 * She stands the way Coo does, three-quarters on and facing right; pet-core mirrors the whole
 * group when she turns. pet-core runs the body (walking, jumping, dragging, faces); this file turns
 * each frame it hands over into rig parameters, runs springs for hair, skirt, tail, fins and ahoge,
 * paints the face (eyes, mouth, blush) into a live texture, and draws the rig into a canvas that
 * lives in the pet's own SVG group, so the stage's transform (position, squash, tilt, facing) applies.
 *
 * Every layer was cut from one master drawing, so at rest the parts line up pixel for pixel;
 * what each part hides (the dress under the arm, the hair behind the face, the legs under the
 * skirt) was painted in by edits of that same drawing.
 *
 * Rig space = pet-core's logo space: x=128 under the body, soles at y=256.
 * model.json keeps the master drawing's pixel frame for the face sprites; U/V convert.
 */
import { createRig } from '../rig/rig.js';

const f1 = n => Math.round(n * 100) / 100;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, k) => a + (b - a) * k;
const ease = (rate, dt) => 1 - Math.exp(-rate * dt);
const bump = u => Math.sin(Math.PI * clamp(u, 0, 1));
const smooth = (a, b, x) => { const k = clamp((x - a) / (b - a), 0, 1); return k * k * (3 - 2 * k); };
const SVGNS = 'http://www.w3.org/2000/svg';

// the face texture covers this rect of the master drawing, one texel per master pixel
//
// ★ **两套真相的警告**：`FACE` / `HEAD` / `CHEEKS` / `INK` 以及下面 `parts.push` 里两个手写的部件
//   （`faceFx`、`brows_through` 的 z 与 alpha）都是**按 master 像素写在这里的常量**，而
//   `model.json` 里同样描述这张脸的字段（`units.DS` / `units.featDS` / `pivots.head` /
//   `pivots.waist` / `feat.blush` / `feat.skin`）**没有任何代码读它们**。
//   所以**重导美术资源（改 `X0` / `FEET` / `S` / 贴图尺寸）时，这里必须一起改** ——
//   否则嘴唇、腮红、眼睛会静默错位，而不会报任何错。详见 HANDOVER 第 1.24 节。
const FACE = { x: 520, y: 578, w: 390, h: 252 };
// the head's parallax warps act over this rect (rig units); the long hair below it stays put
const HEAD = [30, 12, 215, 168];

/* ---------- springs ---------- */
// `lim` bounds the output: a hard throw may overshoot, the hair must not fold over itself
function spring(k, c, lim = Infinity) {
  return {
    x: 0, v: 0,
    step(target, dt) {
      this.v += ((target - this.x) * k - this.v * c) * dt;
      this.x += this.v * dt;
      if (Math.abs(this.x) > lim) { this.x = Math.sign(this.x) * lim; this.v = 0; }
      return this.x;
    },
  };
}

function loadImage(url) {
  return new Promise((ok, bad) => { const im = new Image(); im.onload = () => ok(im); im.onerror = bad; im.src = url; });
}

/**
 * Loads the model and textures; resolves to a figure object for createPet's `opts.figure`.
 * `opts.scheme` picks a colour scheme (model.schemes; default the original); `opts.model` (model.json
 * already parsed) and `opts.asset(path)` (a texture's URL) are for pages that bundle the files.
 *
 * 上游这里还有一个 `opts.raster`（每帧把 canvas 转成 `<image>`，给"录屏抓不到 WebGL"的页面用）
 * 和一个 `snapshot()`（离屏渲染若干帧出一张图）。两个在本 fork 里**零调用**，而 raster 那条路
 * 每帧一次 `canvas.toDataURL()`（同步 GPU→CPU 回读 + PNG 编码）—— 2026-10-08 清理时删掉了。
 */
export async function createWhaleFigure(base = new URL('./', import.meta.url), opts = {}) {
  const model = opts.model || await (await fetch(new URL('model.json', base))).json();
  const asset = opts.asset || (p => new URL(p, base));
  const { S, X0, FEET } = model.units;
  const U = x => 128 + (x - X0) * S, V = y => 256 - (FEET - y) * S;
  const PV = model.pivots, feat = model.feat;
  const EYES = ['eyeL', 'eyeR'];  // near (left) eye, far (right) eye
  const featNames = [...Object.keys(feat.sprites), ...EYES.flatMap(k => ['lash', 'ball', 'iris', ...(feat.eyes[k].rim ? ['rim'] : [])].map(n => `${k}_${n}`))];
  // a scheme is a set of textures over the same geometry; the original's are at tex/ and feat/
  const SCHEMES = (model.schemes || [{ id: 'deepseek' }]).filter(sc => sc.ready !== false);
  const schemeInfo = id => SCHEMES.find(sc => sc.id === id) || SCHEMES[0];
  // the scheme's accent colours the listening arcs, thought bubbles and sleep z's
  const accent = () => schemeInfo(scheme).accent || '#4d6bfe';
  const loaded = {}, ready = {};
  function loadScheme(id) {
    if (loaded[id]) return loaded[id];
    const dir = id === SCHEMES[0].id ? '' : `schemes/${id}/`;
    const set = { tex: {}, img: {} };
    loaded[id] = Promise.all([
      ...model.parts.map(async p => { set.tex[p.tex] = await loadImage(asset(`${dir}tex/${p.tex}.png`)); }),
      ...featNames.map(async n => { set.img[n] = await loadImage(asset(`${dir}feat/${n}.png`)); }),
    ]).then(() => (ready[id] = set));
    return loaded[id];
  }
  let scheme = schemeInfo(opts.scheme).id;
  let { tex, img } = await loadScheme(scheme);
  const box = Object.fromEntries(model.parts.map(p => [p.id, p.box]));
  const rectOf = id => { const [x, y, w, h] = box[id]; return [x, y, x + w, y + h]; };

  /* deformers: each acts in rest space; parents act after children */
  const deformers = {
    body: { kind: 'rot', pivot: PV.body },
    skirt: { kind: 'warp', parent: 'body', rect: rectOf('skirt') },
    skirtSit: { kind: 'warp', parent: 'body', rect: rectOf('skirt_sit') },
    armNear: { kind: 'rot', parent: 'body', pivot: PV.armNear },
    armFar: { kind: 'rot', parent: 'body', pivot: PV.armFar },
    legBack: { kind: 'rot', parent: 'body', pivot: PV.legBack },
    legFront: { kind: 'rot', parent: 'body', pivot: PV.legFront },
    tail: { kind: 'rot', parent: 'body', pivot: PV.tail },
    tailBend: { kind: 'warp', parent: 'tail', rect: rectOf('tail') },
    neck: { kind: 'rot', parent: 'body', pivot: PV.neck },
    headBack: { kind: 'warp', parent: 'neck', rect: HEAD },
    headMid: { kind: 'warp', parent: 'neck', rect: HEAD },
    headFeat: { kind: 'warp', parent: 'neck', rect: HEAD },
    headFront: { kind: 'warp', parent: 'neck', rect: HEAD },
    hairSway: { kind: 'warp', parent: 'headBack', rect: rectOf('hair_back') },
    bangsSway: { kind: 'warp', parent: 'headFront', rect: rectOf('bangs') },
    finNear: { kind: 'rot', parent: 'headMid', pivot: PV.finNear },
    finFar: { kind: 'rot', parent: 'headBack', pivot: PV.finFar },
    ahoge: { kind: 'rot', parent: 'headFront', pivot: PV.ahoge },
  };
  const parts = model.parts.map(p => ({ ...p }));
  // the face features ride a little ahead of the face for the turn
  parts.push({ id: 'faceFx', tex: 'faceFx', box: [U(FACE.x), V(FACE.y), FACE.w * S, FACE.h * S], z: 9, parent: 'headFeat', grid: [4, 4] });
  // the brows lie on the skin under the fringe, and show through the hair: the same texture is drawn
  // again over the fringe, faint. Each brow lifts and tilts by the face (the warp below splits them).
  const brows = parts.find(p => p.id === 'brows');
  if (brows) {
    deformers.brows = { kind: 'warp', parent: 'headFeat', rect: rectOf('brows') };
    brows.parent = 'brows';
    parts.push({ ...brows, id: 'brows_through', z: 13.2, alpha: .4 });
  }
  // the lid creases follow each eye's upper lid down when the eye narrows, and go when it closes
  const creases = parts.find(p => p.id === 'eye_creases');
  if (creases) {
    deformers.creases = { kind: 'warp', parent: 'headFeat', rect: rectOf('eye_creases') };
    creases.parent = 'creases';
  }

  /* ---------- face painting (master pixels) ---------- */
  const faceCv = document.createElement('canvas');
  faceCv.width = FACE.w; faceCv.height = FACE.h;
  // while a scheme fades in, the face is painted a second time with the incoming scheme's sprites
  const faceCv2 = document.createElement('canvas');
  faceCv2.width = FACE.w; faceCv2.height = FACE.h;
  const fg1 = faceCv.getContext('2d'), fg2 = faceCv2.getContext('2d');
  let fg = fg1;
  const eyeCv = document.createElement('canvas');
  const INK = '#5a2330';
  const poly2 = (c, x) => c[0] * x * x + c[1] * x + c[2];

  // how far the lid travels to close: from the lid line down past the lower rim
  const EYE = Object.fromEntries(EYES.map(k => {
    const e = feat.eyes[k], [x0, , x1] = e.ball;
    let h = 0;
    for (let x = x0 + 4; x < x1 - 4; x += 2) h = Math.max(h, poly2(e.rimFit, x) - poly2(e.lidFit, x));
    const cx = (e.iris[0] + e.iris[2]) / 2;
    return [k, { ...e, travel: h + 2, cx, cy: poly2(e.lidFit, cx) }];
  }));

  /** The neutral eye with its lid at `open` (0 shut, 1 rest), iris moved by ix/iy, lid tilted by tilt (rad). */
  function paintOpenEye(k, open, ix, iy, tilt) {
    const e = EYE[k], [bx0, by0, bx1, by1] = e.ball, w = bx1 - bx0, h = by1 - by0;
    if (eyeCv.width !== w + 40 || eyeCv.height !== h + 40) { eyeCv.width = w + 40; eyeCv.height = h + 40; }
    const g = eyeCv.getContext('2d');
    g.setTransform(1, 0, 0, 1, 20 - bx0, 20 - by0);
    g.clearRect(bx0 - 20, by0 - 20, w + 40, h + 40);
    g.globalCompositeOperation = 'source-over';
    g.drawImage(img[`${k}_ball`], bx0, by0);
    g.globalCompositeOperation = 'source-atop';
    g.drawImage(img[`${k}_iris`], e.iris[0] + ix, e.iris[1] + iy);
    // the eye's outline over the iris, so a shifted iris tucks under it
    if (e.rim) { g.globalCompositeOperation = 'source-over'; g.drawImage(img[`${k}_rim`], e.rim[0], e.rim[1]); }
    // the lid hides everything above it
    const d = (1 - clamp(open, 0, 1)) * e.travel, tn = Math.tan(tilt);
    g.globalCompositeOperation = 'destination-out';
    g.beginPath();
    g.moveTo(bx0 - 20, by0 - 20);
    for (let x = bx0 - 20; x <= bx1 + 20; x += 3) g.lineTo(x, poly2(e.lidFit, clamp(x, bx0, bx1)) + d + tn * (x - e.cx) - 1);
    g.lineTo(bx1 + 20, by0 - 20);
    g.closePath(); g.fill();
    g.globalCompositeOperation = 'source-over';
    fg.drawImage(eyeCv, bx0 - 20 - FACE.x, by0 - 20 - FACE.y);
    // the lashes ride down with the lid and flatten as they close
    const L = e.lash, sy = .55 + .45 * clamp(open, 0, 1);
    /**
     * ★ **眨眼时的睫毛阴影**（用户点名的第二条，**0 新贴图**）。
     *
     * 画在**脸那块画布**上、用 `source-atop` 把矩形裁在"脸上已经画到的像素"里，
     * 所以它**只会在脸内部生效**（不会溢出到窗口或头发上），而且正好落在睫毛这一条上：
     * 闭眼的过程中睫毛下面逐渐变暗、松开又淡回去。
     *
     * `shut` 是这一帧的闭眼量（0 睁、1 全闭）、`d` 是眼睑比静止位置低了多少，阴影跟着 `d` 走。
     * 这一笔必须在 `paintFaceBody` 收尾时还原成 `source-over`，否则**后面所有脸部的绘制都会被改掉**。
     */
    if (shut > .06) {
      const band = e.cy + d, bh = 13;
      const grad = fg.createLinearGradient(0, band - bh * .7, 0, band + bh);
      grad.addColorStop(0, 'rgba(0,0,0,0)');
      grad.addColorStop(.5, `rgba(58,26,40,${(0.34 * shut).toFixed(3)})`);
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      fg.save();
      fg.globalCompositeOperation = 'source-atop';
      fg.fillStyle = grad;
      fg.fillRect(e.cx - 34, band - bh, 68, bh * 2);
      fg.restore();
    }
    fg.save();
    fg.translate(e.cx - FACE.x, e.cy + d - FACE.y);
    fg.rotate(tilt);
    fg.scale(1, sy);
    fg.drawImage(img[`${k}_lash`], L[0] - e.cx, L[1] - e.cy);
    fg.restore();
  }

  /** 睫毛阴影用：这一帧的闭眼量（`paintFaceBody` 里算好，`paintOpenEye` 用）。 */
  let shut = 0;

  // Each mouth sprite sits where its expression edit drew it, and three of those edits drew the mouth
  // higher than the master's: these move them down (master pixels) so the middle of each visible mouth
  // is on the master's mouth line, y 769, as the neutral, love, dizzy and surprised mouths already are.
  const MOUTH_DY = { happy_mouth: 9, drag_mouth: 16, sleep_mouth: 4 };

  /** A whole drawn sprite (an expression's eye or mouth) at its place, optionally scaled/rotated about its centre. */
  function sprite(name, o = {}) {
    const b = feat.sprites[name];
    if (!b) return;
    const cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2;
    fg.save();
    fg.globalAlpha = o.alpha ?? 1;
    fg.translate(cx - FACE.x, cy + (MOUTH_DY[name] || 0) - FACE.y);
    if (o.rot) fg.rotate(o.rot);
    fg.scale(o.sx ?? o.s ?? 1, o.sy ?? o.s ?? 1);
    fg.drawImage(img[name], b[0] - cx, b[1] - cy);
    fg.restore();
  }

  const CHEEKS = [[618, 770, 40, 20], [852, 762, 22, 15]];
  function paintBlush(a) {
    if (a < .02) return;
    for (const [x, y, rx, ry] of CHEEKS) {
      fg.save();
      fg.translate(x - FACE.x, y - FACE.y); fg.scale(1, ry / rx);
      const gr = fg.createRadialGradient(0, 0, 0, 0, 0, rx);
      gr.addColorStop(0, `rgba(255,120,140,${f1(.55 * a)})`); gr.addColorStop(1, 'rgba(255,120,140,0)');
      fg.fillStyle = gr; fg.beginPath(); fg.arc(0, 0, rx, 0, Math.PI * 2); fg.fill();
      fg.restore();
    }
  }

  /** Small drawn mouths for the moods the sprites don't cover (form < 0 frowns). */
  function lineMouth(form, w = 1) {
    const cx = 766 - FACE.x, cy = 772 - FACE.y;
    fg.save(); fg.strokeStyle = INK; fg.lineWidth = 3; fg.lineCap = 'round';
    fg.beginPath(); fg.moveTo(cx - 9 * w, cy - form * 3); fg.quadraticCurveTo(cx, cy + form * 5, cx + 9 * w, cy - form * 3); fg.stroke();
    fg.restore();
  }

  const MOUTH = {
    neutral: 'neutral_mouth', happy: 'happy_mouth', wink: ['happy_mouth', .8], love: 'love_mouth', shy: ['drag_mouth', .7],
    surprised: 'surprised_mouth', sleepy: 'sleep_mouth', sleep: 'sleep_mouth', dizzy: 'dizzy_mouth', dragged: 'drag_mouth',
    content: 'neutral_mouth', waking: ['surprised_mouth', .6], squeeze: 'sleep_mouth', listening: 'neutral_mouth',
    thinking: 'sleep_mouth', run: ['happy_mouth', .7], angry: -1, sad: -1.2,
  };

  /**
   * 画这张脸。**整段包在 `save`/`restore` 里**：中途抛错（贴图少了、字段是 undefined…）
   * 不会把 `globalAlpha` 和 save 栈永久留在那个 2D 上下文里 —— 那个泄漏的表现是
   * "整张脸越来越淡"（比如 `brows_through` 留下的 alpha .4），而且不报任何错。
   */
  function paintFace(fc, face, o, t) {
    fg.save();
    try { paintFaceBody(fc, face, o, t); } finally { fg.restore(); }
  }

  /**
   * 这一帧的脸"指纹"，用来跳过没必要的重画与重传（见 `drawNow` 里那段注释）。
   *
   * 返回 `null` = **这张脸每帧都在变，别缓存**。判据必须覆盖 `paintFaceBody` 读到的每一样东西：
   * 脸名、眉毛、腮红、瞳孔位置、眼睛的每个形状与偏移、嘴的开合；还有 **`t`** ——
   * 说话时嘴的开合、拖拽脸的"眼睛缩放"都随时间走，所以这几种情况一律不缓存。
   */
  function faceStamp(fc, face, o) {
    if ((o.talk || 0) > .02 || (o.blink || 0) > .02 || (o.eyeClose || 0) > .02) return null;
    if (face === 'dragged' || face === 'dizzy' || face === 'sleepy' || face === 'waking') return null;
    if (fc.eyes.some((e) => e.shape === 'gt' || e.shape === 'lt')) return null;
    const eyes = fc.eyes.map((e) => `${e.shape}${e.rx || 0},${e.ry || 0},${e.dx || 0},${e.dy || 0},${e.rot || 0},${e.s || 0}`).join(';');
    return `${face}|${fc.brows || ''}|${fc.blush || 0}|`
      + `${(o.look[0] || 0).toFixed(3)},${(o.look[1] || 0).toFixed(3)}|`
      + `${(fc.gap[0] || 0).toFixed(2)},${(fc.gap[1] || 0).toFixed(2)}|${eyes}`;
  }

  function paintFaceBody(fc, face, o, t) {
    fg.setTransform(1, 0, 0, 1, 0, 0);
    fg.clearRect(0, 0, FACE.w, FACE.h);
    paintBlush(fc.blush || 0);
    shut = Math.max(o.blink || 0, o.eyeClose || 0);
    const lx = clamp(o.look[0], -6, 6), ly = clamp(o.look[1], -5, 5);
    const tilt = fc.brows === 'angry' ? .2 : fc.brows === 'sad' ? -.16 : 0;
    fc.eyes.forEach((e, i) => {
      const k = EYES[i], side = k === 'eyeL' ? 1 : -1;  // the near eye's inner corner is to its right
      const squash = { sy: 1 - .85 * (o.eyeClose || 0) };
      if (face === 'surprised' && e.shape === 'ring') { sprite(`surprised_${k}`, squash); return; }
      switch (e.shape) {
        case 'ring': case 'lid': {
          const open = (e.shape === 'ring' ? clamp(e.ry / e.rx, 0, 1) * (tilt ? .8 : 1) : clamp(e.ry / 16, 0, 1)) * (1 - shut);
          // the iris fills most of the eye: it only shifts a little, less in the foreshortened far eye,
          // so the white never shows past the eye's outline
          const gx = k === 'eyeL' ? 1 : .35;
          const ix = clamp((lx + (e.dx || 0)) * gx, -6 * gx, 6 * gx), iy = clamp(ly * .7 + (e.dy || 0) * .7, -3.5, 3.5);
          paintOpenEye(k, open, ix, iy + (e.shape === 'lid' ? 3 : 0), tilt * side);
          break;
        }
        case 'up': sprite(`happy_${k}`, squash); break;
        case 'down': sprite(`sleep_${k}`, squash); break;
        case 'gt': case 'lt': sprite(`drag_${k}`, { s: 1 + .03 * Math.sin(t * 22 + i) }); break;
        case 'heart': sprite(`love_${k}`, { s: .94 + .06 * (e.s ?? 1) / .8 }); break;
        case 'spiral': sprite(`dizzy_${k}`, { rot: (e.rot || 0) * .6 }); break;
      }
    });
    // mouth: talking opens the happy mouth about its middle, which stays on the mouth line; otherwise the face's own
    const talk = o.talk || 0;
    const gapOpen = clamp((Math.max(fc.gap[0], fc.gap[1]) - 50) / 14, 0, 1);
    const m = MOUTH[face] ?? 'neutral_mouth';
    const open = Math.max(talk * (.45 + .45 * Math.abs(Math.sin(t * 17))), face === 'sleepy' || face === 'waking' ? gapOpen : 0);
    if (open > .12) sprite(face === 'surprised' ? 'surprised_mouth' : 'happy_mouth', { sy: .35 + .65 * open, sx: .85 + .15 * open });
    else if (typeof m === 'number') lineMouth(m);
    else if (Array.isArray(m)) sprite(m[0], { s: m[1] });
    else sprite(m);
  }

  /* ---------- mounting inside the pet's SVG group ---------- */
  const VIEW = model.view;
  let fo = null, canvas = null, fxG = null, rig = null, mountedIn = null, pxScale = 0, frameN = 0;
  /** 上一次挂载失败的 `t`：`drawNow` 用它退避 2 秒，免得每帧重建 canvas/GL 上下文（见 mount）。 */
  let mountFailT = null;
  function mount(petG) {
    petG.textContent = '';
    // the previous rig's GL context outlives its canvas until GC: release it or repeated
    // figure switches pile up live contexts (Chromium caps them per page)
    rig?.dispose();
    rig = null;
    const box = (el) => { el.setAttribute('x', VIEW[0]); el.setAttribute('y', VIEW[1]); el.setAttribute('width', VIEW[2] - VIEW[0]); el.setAttribute('height', VIEW[3] - VIEW[1]); return el; };
    canvas = document.createElementNS('http://www.w3.org/1999/xhtml', 'canvas');
    fo = box(document.createElementNS(SVGNS, 'foreignObject'));
    canvas.style.cssText = 'width:100%;height:100%;display:block';
    fo.appendChild(canvas);
    fxG = document.createElementNS(SVGNS, 'g');
    petG.append(fo, fxG);
    // 换了新的 fxG：`fx` 那个"上一帧写过的特效串"缓存必须作废，不然不随时间变化的特效
    // （比如感叹号）在重挂之后不会重画，会一直到状态变化为止都不见。
    fx = '';
    // 同理：新挂的 rig 还没有 `faceFx` 贴图，所以下一帧**必须**重画并重传一次脸
    lastFaceSig = undefined;
    // ★ **挂载本身可能抛**（`createRig` 里 `webgl2 unavailable`、上下文耗尽…）。
    // 关键不是"接住它"，而是**别让下一帧又重来一遍**：`mountedIn` 在下面才赋值，
    // 一抛就还是 null，于是每一帧都 `petG.textContent = ''` + 新建 canvas + 再抛，
    // 30fps 无限循环（还会把每页十几个 GL 上下文的配额耗光）。
    // 这里只记下时刻，交给 `drawNow` 退避、由 `draw()` 的兜底记一笔日志。
    try {
      rig = createRig(canvas, { deformers, parts, view: VIEW });
      for (const n in tex) rig.upload(n, tex[n]);
      if (fade) for (const n in fade.set.tex) rig.upload(n + '@mix', fade.set.tex[n]);
    } catch (err) {
      mountFailT = lastT ?? 0;
      rig = null;
      throw err;
    }
    mountedIn = petG; pxScale = 0;
  }
  // a fade in progress: the rig crossfades every part from `tex` to fade.set's textures over fade.dur seconds
  let fade = null;
  function endFade() {
    if (!fade) return;
    tex = fade.set.tex; img = fade.set.img; fade = null;
    if (rig) for (const n in tex) rig.upload(n, tex[n]);
  }
  /**
   * Switches the colour scheme: at once if its textures are loaded (see preload), else once they are.
   * `o.fade` (seconds) crossfades instead of cutting over; the clock is the frames' `t`, starting at `o.at`
   * (the pet's time now) or else at the next frame drawn.
   */
  function setScheme(id, o = {}) {
    const next = schemeInfo(id).id;
    const apply = set => {
      endFade();
      if (scheme === next && tex === set.tex) return;
      scheme = next;
      if (o.fade > 0 && rig) {
        fade = { set, dur: o.fade, t0: o.at ?? null };
        for (const n in set.tex) rig.upload(n + '@mix', set.tex[n]);
        return;
      }
      tex = set.tex; img = set.img;
      if (rig) for (const n in tex) rig.upload(n, tex[n]);
    };
    if (ready[next]) { apply(ready[next]); return Promise.resolve(); }
    return loadScheme(next).then(apply);
  }
  function fitCanvas() {
    if (!mountedIn) return;                     // 挂载失败过：这一步跳过，别在 null 上取 CTM
    const m = mountedIn.getScreenCTM();
    if (!m) return;
    // the vertical axis: turning round squeezes the horizontal one through zero, which would shrink the canvas to a few texels
    const k = Math.hypot(m.c, m.d) * (window.devicePixelRatio || 1) * 1.25;
    if (Math.abs(k - pxScale) / (pxScale || 1) < .08) return;
    pxScale = k;
    canvas.width = Math.max(16, Math.round((VIEW[2] - VIEW[0]) * Math.min(k, 6)));
    canvas.height = Math.max(16, Math.round((VIEW[3] - VIEW[1]) * Math.min(k, 6)));
  }

  /* ---------- per-frame state ---------- */
  const sp = {
    hair: spring(55, 7, 1.8), hairY: spring(50, 8, 1.2), bangs: spring(110, 10, 1.6),
    skirt: spring(100, 9, 1.6), skirtY: spring(90, 10, 1.1), tail: spring(40, 5, 32), fins: spring(90, 9, 30),
    ahoge: spring(140, 6, 38), head: spring(70, 10, 16), armN: spring(60, 9, 95), armF: spring(60, 9, 95),
    // 呼吸时头/发梢**慢一拍**跟上去（它只在呼吸的竖直分量上动，见下面的 `neckL`）
    neckY: spring(26, 8, 3.4),
  };
  let lastT = null, prevTilt = 0, prevLow = 0, headTilt = 0, fx = '';
  /**
   * ★ **次级动画：0.1 秒前的身体速度**（用户点名的那条"你甩鼠标，发梢晚 0.1 秒跟上"）。
   *
   * 机制：`pet-core` 每帧把"身体此刻在画布上的位置"连同**最近 0.4 秒的位置历史**喂进
   * `o.bx` / `o.by` / `o.posHist`（见 pet-core.js 里 `frame.bx` 那段注释）。这里取
   * **0.1 秒前**那个点，`(现在 - 0.1 秒前) / 0.1` 就是"因为运动而产生的、发梢该落后多少"。
   *
   * 为什么要"延迟"而不是直接用当前速度：直接用当前速度的话，头发和身体**同时**响应，
   * 看着还是黏在一起（现有的弹簧本来就有惯性，所以光调弹簧阻尼看不出"晚一步"的效果）；
   * 而按 0.1 秒前的速度驱动，头发就是**跟着身体刚刚做过的事**走 —— 这才是"甩一下、顿一下、再跟上"。
   *
   * 单位：px/s。`LAG_S` 是延迟窗口（想更"飘"就调大，0.16 左右很明显；想更紧就调小）。
   */
  const LAG_S = .1;
  /** 延迟速度 → 形变幅度的系数（hair/tail 各有一套，都是手感数字，改这里即可）。 */
  const LAG_HAIR = .05, LAG_TAIL = .045, LAG_Y = .05;
  let lagX = 0, lagY = 0;
  /**
   * 取 `o.posHist` 里 LAG_S 秒前的那个点；没有历史（老页面 / 内置身体）就返回 0，行为同上游。
   *
   * ⚠️ 门槛是 **`length < 1`**，不是 `< 2`：只有**一个**历史点的情形是真实存在的
   * （她刚落地/刚被放下、上一帧还没入队），这时候那一点就是"0.1 秒前"的最好近似，
   * 正好是"竖直方向刚发生过大位移"最该出效果的一帧。写成 `< 2` 会把这一帧吃掉，
   * 症状是"跳起来的那一下发梢不拖、落地之后才开始拖"。
   */
  function lagged(o) {
    const h = o.posHist;
    if (!Array.isArray(h) || h.length < 1 || !Number.isFinite(o.t)) return [0, 0];
    const want = o.t - LAG_S;
    let best = h[0];
    for (let i = h.length - 1; i >= 0; i--) { if (h[i].t <= want) { best = h[i]; break; } }
    const dt = Math.max(1e-3, o.t - best.t);
    return [(o.bx - best.x) / dt, (o.by - best.y) / dt];
  }
  /** 上一帧那张脸的指纹（见 `faceStamp`）。`undefined` = 必须重画一次。 */
  let lastFaceSig;
  /** 绘制抛错的次数与上一次上报的时刻（见 `draw` 外面那层 try/catch）。 */
  let drawFails = 0, drawFailAt = -1e9;
  // pet-core tips Coo's whole round body to listen, nod, doze or wobble; she keeps her feet on the floor and
  // moves her head instead. Only flight, dragging and the jump's crouch and landing tip the whole group,
  // running keeps half its lean. The shares ease between modes so the group never snaps.
  const GROUP = { air: [1, 1], drag: [1, 1], crouch: [1, 1], land: [1, 1], walk: [1, .5], run: [1, .5] };
  let wTilt = 0, wLean = 0;
  const groupTilt = (mode, tilt, lean) => tilt * wTilt + lean * wLean;
  let finMood = 0, tailMood = 0, wagAmp = 0, sitK = 0;
  const st = { z: {}, alpha: {} };

  // fins and tail by face: fins up (+) or drooping (-), tail wag size
  const MOOD = {
    happy: [.8, 1], love: [.9, 1], wink: [.5, .7], surprised: [1, .2], angry: [.9, .15], sad: [-1, 0], shy: [-.5, .3],
    sleepy: [-.7, 0], sleep: [-.9, 0], dizzy: [-.3, 0], dragged: [.6, .6], content: [-.2, .25], listening: [.6, .2],
    thinking: [.1, .15], run: [.2, .4], waking: [-.4, 0], squeeze: [-.3, 0], neutral: [0, .25],
  };
  // brows by face, in master pixels: [lift of the whole brow, lift of its inner end (by the nose)];
  // a negative inner lift is the frown
  const BROW = {
    surprised: [6, 0], angry: [-1, -5], sad: [1, 5], shy: [1, 2.5], happy: [2, 0], love: [2, 0], wink: [1, 0],
    sleepy: [-1.5, 0], sleep: [-1.5, 0], dizzy: [1, 3], dragged: [2, 3.5], thinking: [0, 2], waking: [2, 1],
    listening: [1, 0], content: [-1, 0], squeeze: [-1, -2], run: [1, 0],
  };
  const BROW_SPLIT = U(765);  // the near brow is left of this, the far brow right of it
  let browLift = 0, browInner = 0;
  // how far an eye's upper lid sits below its rest line (master pixels), and whether it is an open eye at all
  // (the same openness paintFace gives the eye, over the lid's full travel; the crease keeps a little above the lid)
  const lidDrop = (e, k, tilt) => {
    const open = e.shape === 'ring' ? clamp((e.ry ?? 16) / (e.rx ?? 16), 0, 1) * (tilt ? .8 : 1) : e.shape === 'lid' ? clamp(e.ry / 16, 0, 1) : 1;
    return EYE[k].travel * (1 - open) * .75;
  };
  const lidOpen = e => e.shape === 'ring' || e.shape === 'lid' ? 1 : 0;
  const creaseDrop = [0, 0];
  let creaseA = 1;

  function draw(petG, fc, o) {
    /**
     * **绘制失败必须留下痕迹**：`ctl.setFigure()` 是先把 `#pet` 清空、再让新身体画进去的，
     * 所以这里抛一次错，她就**整个人消失**（窗口在、日志正常、屏幕上一个像素都没有，
     * 完全看不出是这个函数的问题）。所以最外层包一道，出错就把消息+堆栈报给主进程，
     * 写进 `data\pet-host.log`（页面里的 `console` 在 GUI 里是丢掉的）。
     * 只报第一次，随后继续尝试画（下一帧说不定就好了）。
     */
    try {
      return drawNow(petG, fc, o);
    } catch (err) {
      drawFails += 1;
      // 第一次立刻报，之后**每 60 秒再报一次**：偶发一次不吵，但"一直在失败"一定能看到。
      // （原来只报第一次，第一次偶发错误之后真正的持续错误就永远不上报了——而那种情况下
      // 屏幕上正是"她整个人不见了"。）
      const now = typeof o?.t === 'number' ? o.t : performance.now() / 1000;
      if (drawFails === 1 || now - drawFailAt > 60) {
        drawFailAt = now;
        try { globalThis.petHost?.report?.(`[figure.draw 抛错 第${drawFails}次] ${err && (err.stack || err.message)}`); } catch { /* 报告失败就算了 */ }
      }
    }
  }

  function drawNow(petG, fc, o) {
    // `t` 先算，而且**必须保证是有限的**：NaN 会顺着 `dt` 污染所有弹簧
    // （`Math.abs(NaN) > lim` 恒为假，弹簧永远回不来），表现是"大半个身体悄悄不画了"
    // 却**不抛任何错** —— 上面那层兜底和 diag.js 都看不到它。
    const t = Number.isFinite(o.t) ? o.t : (lastT ?? 0);
    const dt = lastT == null ? 1 / 60 : clamp(t - lastT, 0, .05);
    lastT = t;
    // 挂载失败过就退避 2 秒再试一次（见 mount 里那段注释）。
    if (mountedIn !== petG || !petG.contains(fo)) {
      if (mountFailT != null && t - mountFailT < 2) return;
      mount(petG);
    }
    if (frameN++ % 20 === 0) fitCanvas();
    const mode = o.mode || 'idle', face = o.face || 'neutral';
    const walking = mode === 'walk' || mode === 'run', held = mode === 'drag', airborne = mode === 'air';

    /* body: pet-core's `low` is how far the hips sink (sitting, the walk's bob), in these units */
    sitK = lerp(sitK, clamp(o.sit ?? 0, 0, 1), ease(12, dt));
    const low = o.low || 0;
    const lowV = (low - prevLow) / Math.max(dt, 1e-3); prevLow = low;
    const breatheBase = Math.sin(t * (mode === 'sleep' ? 1.7 : 2.4));

    /* head: tilt toward what it looks at, nod with sleep, wobble with dizzy */
    let tiltT = o.look[0] * .7 + Math.sin(t * .9) * 1.2 - o.look[1] * .4;
    if (mode === 'sleep') tiltT += 6;
    if (face === 'shy') tiltT += 7;
    if (face === 'thinking') tiltT -= 8;
    if (face === 'dizzy') tiltT += 3 * Math.sin(t * 4.5);
    if (held) tiltT += o.swing * .25;
    headTilt = sp.head.step(tiltT, dt);
    // what pet-core meant for the whole body and the group did not take goes to the neck (forward +)
    const [gT, gL] = GROUP[mode] || [0, 0];
    const bend = (o.tilt ?? 0) * (1 - wTilt) + (o.lean ?? 0) * Math.sign(o.facing || 1) * (1 - wLean);
    wTilt = lerp(wTilt, gT, ease(10, dt)); wLean = lerp(wLean, gL, ease(10, dt));
    const tiltVel = (headTilt - prevTilt) / Math.max(dt, 1e-3); prevTilt = headTilt;
    const angleX = clamp(o.look[0] / 5, -1, 1) * .9;
    const angleY = clamp(-o.look[1] / 4, -1, 1) * .7 + (mode === 'sleep' ? -.8 : 0) + (face === 'sad' ? -.35 : 0);

    /* springs */
    const sway = clamp(o.swing / 26, -1.6, 1.6);
    const up = airborne || held ? 1 : 0;
    /**
     * ★ 次级动画的输入：**0.1 秒前**的身体速度（竖直也算，所以跳起/被拎起/坐下都有跟随）。
     * 拖拽（`held`）时不叠加：那时候位置变化太猛，会把头发甩到抽（现有的 `swing` 已经在管它）。
     */
    [lagX, lagY] = held ? [0, 0] : lagged(o);
    const lagH = clamp(-lagX * LAG_HAIR, -2.2, 2.2);      // 往右走 → 发梢往左飘（形变单位）
    const lagT = clamp(-lagX * LAG_TAIL, -14, 14);        // 尾巴同一方向，但单位是度
    const lagV = clamp(-lagY * LAG_Y, -1.1, 1.1);         // 上升/下落 → 头发/发梢上下拖
    const hair = sp.hair.step(sway * 1.1 - tiltVel * .004 + (walking ? -.25 : 0) + lagH, dt);
    const hairY = sp.hairY.step(up * -1 + lowV * .006 + lagV, dt);
    const bangs = sp.bangs.step(sway * .7 - tiltVel * .004 + lagH * .8, dt);
    const skirt = sp.skirt.step(sway * .8 + (walking ? -.2 : 0), dt);
    const flare = sp.skirtY.step(up * .8 + sitK * .6 + clamp(-lowV * .01, -.3, .6), dt);
    const [fm, wg] = MOOD[face] || MOOD.neutral;
    finMood = lerp(finMood, fm, ease(6, dt));
    wagAmp = lerp(wagAmp, wg, ease(3, dt));
    tailMood = lerp(tailMood, mode === 'sleep' || face === 'sad' ? -1 : 0, ease(3, dt));
    // 呆毛与鳍的"活着"：见 tools\patch-assets.mjs 第 4 处（幅度都是手感，改数字即可）
    const finTwitch = Math.pow(Math.max(0, Math.sin(t * .6 + 1)), 16) * 7;   // 每约 10 秒抖一下"耳朵"
    const fins = sp.fins.step(finMood * 14 + sway * 10 + finMood * 3.5 * Math.sin(t * (3 + 4 * Math.abs(finMood))) + (face === 'angry' ? 6 * Math.sin(t * 40) : 0), dt)
      + finTwitch;
    const ahoge = sp.ahoge.step(-tiltVel * .12 + sway * 18 + (face === 'surprised' ? -16 : 0) + (mode === 'sleep' ? 22 : 0) - hairY * 12 + lagH * 6, dt)
      + wagAmp * 8 * Math.sin(t * (2.6 + 3 * wagAmp))    // 情绪摆：开心/被爱时晃得最欢（跟尾巴共用 wagAmp）
      + Math.sin(t * 1.5) * 5;                           // 闲置呼吸（原来 ±2°，等于没动）
    const tail = sp.tail.step(sway * 14 + tailMood * 12 + lagT, dt) + wagAmp * 13 * Math.sin(t * (4 + 5 * wagAmp)) + Math.sin(t * 1.3) * 3;

    /* legs: pet-core hands hip→foot segments sized for Coo; keep their angle (forward = foot to the right) */
    const legA = o.legs.map(l => -Math.atan2(l[2] - l[0], Math.max(4, l[3] - l[1])) * 180 / Math.PI);
    const lift = o.legs.map(l => clamp(29 - Math.hypot(l[2] - l[0], l[3] - l[1]), -8, 20));
    // sitting swaps the lower body for its own drawing (skirt spread on the floor, legs forward) in a
    // couple of frames halfway down, under a little squash; a long crossfade would show both skirts at once
    const sitIn = smooth(.44, .54, sitK), plop = Math.sin(Math.PI * smooth(.3, .8, sitK));

    /* arms: swing against the legs when walking, out in the air, flailing when held */
    let aN = 4, aF = -2;
    if (walking) { aN = -legA[0] * 1.3 + 4; aF = -legA[1] * 1.3 - 2; }
    if (airborne) { aN = 40; aF = -30; }
    if (held) { aN = 70 + 16 * Math.sin(t * 13); aF = -45 - 12 * Math.sin(t * 13 + 1.3); }
    if (sitK > .5 && !walking) { aN = lerp(aN, -4, sitK); aF = lerp(aF, -6, sitK); }
    if (face === 'happy' || face === 'love') { aN += 12 + 5 * Math.sin(t * 8); aF -= 8 + 4 * Math.sin(t * 8); }
    if (face === 'angry') { aN = 20 + 3 * Math.sin(t * 30); aF = -18 - 3 * Math.sin(t * 30); }
    const armN = sp.armN.step(aN, dt), armF = sp.armF.step(aF, dt);

    /* deformer states */
    // 呼吸：深度和节奏跟着心情（困了就浅而慢、有精神就深而快）。**没有心情这一层时，
    // 两个系数都是 1**，也就是上游原来那句 `1 + .006 * breath`，一字不差。
    // 心情由 pet-core 的 `setMood` 存着、经 `frame.accMood` 传进来。
    // （早先想过挂在 `o.acc` 也就是 skin 上 —— 那是个错误的方向：skin 是"她穿什么"，
    //   而且页面那侧为了挂它写出了会 throw 的一行，见 pet-app.js 里那段 ⚠️ 注释。）
    const bEnergy = o.accMood && Number.isFinite(o.accMood.energy) ? o.accMood.energy : null;
    const bDepth = bEnergy === null ? 1 : bEnergy < .36 ? .7 : bEnergy > .74 ? 1.5 : 1;
    const bRate = bEnergy === null ? 1 : bEnergy < .36 ? .82 : bEnergy > .74 ? 1.12 : 1;
    const breathe = breatheBase * bRate;
    /**
     * ★ **呼吸起伏**（用户点名的第三条）。
     *
     * 原来呼吸只驱动 `st.body` 的 `sx/sy`，也就是**整个身体一起**吸气 —— 幅度 ±0.6%/±1.2%，
     * 而"起伏"真正看得出来靠的是**躯干**：所以这里的 `sx` 加深到 ±1.0%、`sy` 到 ±1.9%。
     * 另外头/发梢**慢一拍**才跟上去（`sp.neckY` 那个慢弹簧），于是每口气是"胸腔先起、脖子随后"，
     * 而不是整个人被缩放了一下。
     *
     * 速度和深浅照旧跟心情走（`bRate`/`bDepth`，见 `frame.accMood`）：
     * 困了就浅而慢、有精神就深而快。**没有心情这一层时两个系数都是 1**，回到上游行为。
     */
    const neckL = sp.neckY.step(breathe * bDepth * .55, dt);
    // 不说话的小动作：换重心（身上那半边的位移+微转）——呆毛和鳍会**自动**跟着惯性甩
    // （它们本来就是被 `tiltVel` 驱动的），所以这里只动身体和头。
    const stepK = (o.microStep || 0) * (Math.sin(t * 5.2) * .5 + .5);
    st.body = {
      a: -sway * 1.2 + (held ? o.swing * .15 : 0) + stepK * 4.2,
      ty: low - 9.6 * sitK - stepK * 1.7,
      sx: 1 + .010 * breathe * bDepth + .04 * plop,
      sy: 1 - .019 * breathe * bDepth - .06 * plop,
    };

    st.skirt = {
      fn: (u, v) => {
        const k = v * v;
        // on the way down the hem spreads a little before the sitting skirt takes over
        return [skirt * 4 * k + flare * (u - .45) * 9 * v + sitK * (u - .45) * 10 * v, -flare * k * 3 - sitK * k * 8];
      },
    };
    // the sitting skirt breathes a little at its hem, and its front edge swings with the body
    st.skirtSit = { fn: (u, v) => [skirt * 1.5 * v * v, -Math.max(0, breathe) * .4 * v] };
    st.alpha.skirt = st.alpha.waist_bow_front = 1 - sitIn;
    st.alpha.leg_back = st.alpha.leg_front = 1 - smooth(.42, .52, sitK);
    st.alpha.skirt_sit = st.alpha.waist_bow_sit_front = sitIn;
    st.armNear = { a: armN };
    st.armFar = { a: armF };
    st.legBack = { a: lerp(legA[0], -55, sitK), ty: -lift[0] * .9 * (1 - sitK) };
    st.legFront = { a: lerp(legA[1], -60, sitK), ty: -lift[1] * .9 * (1 - sitK) };
    st.tail = { a: tail - 10 * sitK };
    st.tailBend = { fn: u => [0, -tail * .5 * u * u] };
    st.neck = { a: headTilt + clamp(bend * .8, -10, 12) + (o.microTilt || 0), ty: (mode === 'sleep' ? 2.5 : 0) + breathe * .35 + neckL };
    const parallax = (k, ky) => (u, v) => [angleX * k * bump(u) * (.4 + .6 * bump(v)), angleY * ky * bump(v) * (.4 + .6 * bump(u))];
    st.headFront = { fn: parallax(4.2, 2.8) };
    // the eyes and mouth move with the face: the eyes' outline is shared between the two layers
    st.headFeat = { fn: parallax(2, 1.4) };
    if (brows) {
      const [lift, inner] = BROW[face] || [0, 0];
      browLift = lerp(browLift, lift - 1.5 * (o.blink || 0), ease(14, dt));
      browInner = lerp(browInner, inner, ease(10, dt));
      const [bx0, , bx1] = deformers.brows.rect;
      st.brows = {
        fn: (u, v, x) => {
          // 0 at a brow's outer end, 1 at its inner end
          const k = x < BROW_SPLIT ? clamp((x - bx0) / (BROW_SPLIT - bx0), 0, 1) : clamp((bx1 - x) / (bx1 - BROW_SPLIT), 0, 1);
          return [0, -(browLift + browInner * k * k) * S];
        },
      };
    }
    if (creases) {
      fc.eyes.forEach((e, i) => { creaseDrop[i] = lerp(creaseDrop[i], lidDrop(e, EYES[i], fc.brows), ease(12, dt)); });
      creaseA = lerp(creaseA, (lidOpen(fc.eyes[0]) + lidOpen(fc.eyes[1])) / 2, ease(12, dt));
      st.alpha.eye_creases = creaseA;
      st.creases = { fn: (u, v, x) => [0, (x < BROW_SPLIT ? creaseDrop[0] : creaseDrop[1]) * S] };
    }
    st.headMid = { fn: parallax(2, 1.4) };
    st.headBack = { fn: parallax(-1.4, -1) };
    // the long hair hangs from the head but its lower half keeps to the body when the head tilts
    const nk = PV.neck, na = headTilt * Math.PI / 180;
    st.hairSway = {
      fn: (u, v, x, y) => {
        const w = smooth(.3, .8, v), a = -na * w, c = Math.cos(a), s = Math.sin(a);
        const dx = x - nk[0], dy = y - nk[1];
        const wv = Math.pow(v, 1.6);
        return [nk[0] + dx * c - dy * s - x + hair * 8 * wv + Math.sin(t * 1.6 + v * 3) * wv,
          nk[1] + dx * s + dy * c - y + hairY * 12 * wv * wv - Math.abs(hair) * 1.5 * wv];
      },
    };
    st.bangsSway = { fn: (u, v) => [bangs * 3.2 * v * v + Math.sin(t * 1.9 + u * 2) * .5 * v * v, hairY * 3 * v * v] };
    st.ahoge = { a: ahoge * .5 };
    st.finNear = { a: fins + Math.sin(t * 1.7) * 4.5 };
    st.finFar = { a: -fins * .8 - Math.sin(t * 1.9 + 1.1) * 4 };   // 两片不同频，看着才不像一个整体

    // **脸只在真的变了的时候重画 + 重传**：390×252 的 RGBA 每帧 `texImage2D` 并重建整条
    // mipmap 链，是这个文件里最贵的单个 GL 操作，而大多数时候（站着、发呆、没说话）
    // 它一个像素都没变。会随时间自己变的那几种脸由 `faceStamp` 返回 null → 照旧每帧重画。
    const faceSig = faceStamp(fc, face, o);
    if (faceSig === null || faceSig !== lastFaceSig) {
      lastFaceSig = faceSig;
      paintFace(fc, face, o, t);
      rig.upload('faceFx', faceCv);
    }
    st.mix = 0;
    if (fade) {
      if (fade.t0 == null) fade.t0 = t;
      st.mix = smooth(0, 1, (t - fade.t0) / fade.dur);
      const own = img, ownFg = fg;
      // ★ 必须 try/finally：这里手工把全局 `img`/`fg` 换到"新配色 + 第二块画布"，
      // 中途抛错时原来的写法会**永久停在**那个组合上 —— 之后每帧都用错素材画脸，
      // 而且 `fade` 再也结束不了（静默、没有报错，只是脸不对）。
      try {
        img = fade.set.img; fg = fg2;
        paintFace(fc, face, o, t);
      } finally {
        img = own; fg = ownFg;
      }
      // 交叉淡化只有 0.45 秒：这段时间两张脸都照旧每帧重传，不值得为它做脏检查
      rig.upload('faceFx@mix', faceCv2);
      lastFaceSig = undefined;         // 淡化结束后第一帧要把新配色的脸重画一次
    }
    rig.render(st);
    if (fade && st.mix >= 1) endFade();
    drawFx(fc, t);
  }

  /* ---------- effects over the figure (SVG, like the built-in figure's) ---------- */
  const at = (x, y) => rig.point('neck', st, x, y);
  function drawFx(fc, t) {
    let s = '';
    const ac = accent();
    const top = at(124, 34), side = at(204, 52);
    if (fc.orbit) {
      for (let i = 0; i < 3; i++) {
        const a = t * 3.2 + i * 2.094, sn = Math.sin(a);
        s += `<path fill="#ffd23f" stroke="#3a2f7a" stroke-width="1.6" stroke-linejoin="round" opacity="${sn < 0 ? .55 : 1}" transform="translate(${f1(top[0] + 56 * Math.cos(a))} ${f1(top[1] - 4 + 10 * sn)}) scale(${sn < 0 ? .7 : 1})" d="M0 -7L2 -2L7 -2L3 1L4.5 6.5L0 3.3L-4.5 6.5L-3 1L-7 -2L-2 -2Z"/>`;
      }
    }
    if (fc.listen) {
      for (let i = 0; i < 3; i++) {
        const p = (t * .9 + i / 3) % 1, r = 36 - 24 * p, c = at(214, 116);
        s += `<path fill="none" stroke="${ac}" stroke-width="5" stroke-linecap="round" opacity="${f1(Math.sin(Math.PI * p))}" d="M${f1(c[0] + r * Math.cos(-.55))} ${f1(c[1] + r * Math.sin(-.55))}A${f1(r)} ${f1(r)} 0 0 1 ${f1(c[0] + r * Math.cos(.55))} ${f1(c[1] + r * Math.sin(.55))}"/>`;
      }
    }
    if (fc.think) {
      for (let i = 0; i < 3; i++) {
        const k = (t * .8 + i / 3) % 1;
        s += `<circle fill="#e8f0ff" stroke="${ac}" stroke-width="3" cx="${f1(side[0] + 10 * i)}" cy="${f1(side[1] - 20 * i - 6 * k)}" r="${4 + 3 * i}" opacity="${f1(.4 + .6 * Math.sin(Math.PI * k))}"/>`;
      }
    }
    if (fc.sweat) {
      const c = at(196, 88 + 3 * Math.sin(t * 7));
      s += `<path fill="#8fd0ff" stroke="#2f5fae" stroke-width="1.4" transform="translate(${f1(c[0])} ${f1(c[1])}) scale(1.4)" d="M0 -9C4 -3 6 0 6 3.5A6 6 0 0 1 -6 3.5C-6 0 -4 -3 0 -9Z"/>`;
    }
    if (fc.anger) {
      const c = at(190, 62), k = 1 + .12 * Math.sin(t * 10);
      s += `<g transform="translate(${f1(c[0])} ${f1(c[1])}) scale(${f1(k)})" fill="none" stroke="#e5484d" stroke-width="5" stroke-linecap="round"><path d="M-11 -3Q-3 -3 -3 -11M3 -11Q3 -3 11 -3M11 3Q3 3 3 11M-3 11Q-3 3 -11 3"/></g>`;
    }
    if (fc.bang) {
      const c = at(206, 36);
      s += `<g transform="translate(${f1(c[0])} ${f1(c[1])})"><path fill="none" stroke="#252049" stroke-width="8" stroke-linecap="round" d="M0 -16V3"/><circle fill="#252049" cx="0" cy="14" r="4.5"/></g>`;
    }
    if (fx !== s) { fxG.innerHTML = s; fx = s; }
  }

  return {
    draw,
    groupTilt,
    setScheme,
    /** Forgets the motion state (springs, clocks), for callers that replay a timeline from its start. */
    /**
     * Releases the WebGL context and drops the mounted DOM (what `setFigure` switching away from
     * this figure calls). The figure object stays usable: the next `draw` re-mounts from scratch.
     */
    dispose() {
      rig?.dispose();
      rig = null; canvas = null; fo = null; fxG = null; mountedIn = null;
    },
    reset() {
      endFade();
      for (const k in sp) { sp[k].x = 0; sp[k].v = 0; }
      // 重新起一具身体 = 重新给"绘制失败"一次上报机会（不然第一次偶发错误之后就一直静默）
      drawFails = 0; drawFailAt = -1e9; mountFailT = null;
      lastT = null; prevTilt = 0; prevLow = 0; headTilt = 0; wTilt = 0; wLean = 0; finMood = 0; tailMood = 0; wagAmp = 0; sitK = 0;
    },
    /** Loads every scheme's textures, so later switches are immediate. */
    preload: () => Promise.all(SCHEMES.map(sc => loadScheme(sc.id))),
    get scheme() { return scheme; },
    get colors() { return { z: accent() }; },
    schemes: SCHEMES,
    // points pet-core uses: eye tracking, tears, sleep z's, hearts [x from, x to, y], bubble
    anchors: {
      gaze: [U(745), V(690)], tear: [U(640), V(752)], z: [196, 44],
      hearts: [96, 176, 62], bubble: [128, 18],
    },
    model,
  };
}
