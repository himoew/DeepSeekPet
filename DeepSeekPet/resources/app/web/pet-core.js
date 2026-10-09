/**
 * The pet's body: geometry, faces, accessories, skin, synthesized sound, and the motion
 * simulation with pointer handling. Pages build on it: the desktop window (pet.html), the
 * dressing page (dress.html) and anything else that wants the same figure.
 *
 * Coordinates: the figure is drawn in logo units, facing right, ground at y=256. A stage places
 * it with translate(AX AY) rotate(rot) scale(kx ky) translate(-ax -ay); `toStage` maps a logo
 * point back to stage pixels for hit tests, particles and bubble placement.
 */

export const f = n => Math.round(n * 10) / 10;
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, k) => a + (b - a) * k;
const rnd = (a, b) => a + Math.random() * (b - a);
const ease = (rate, dt) => 1 - Math.exp(-rate * dt);
const smooth = k => k * k * (3 - 2 * k);

/* ---------- figure geometry ---------- */
const HIPS = [[104, 212], [150, 212]];
const EYES = [[113, 117], [163, 117]];
const BODY_W = 36, LEG_W = 30;
// a foot's round cap touches the ground
const FOOT_Y = 256 - LEG_W / 2;
/**
 * 没传抓点时的默认：**后颈/头顶**（就是以前写死的那个 (128,36)），`hang = 0` = 竖直垂着。
 * 页面按下时会算好真正的抓点（见 pet-app.js 的 GRAB_STYLE 与 `ctl.pointerDown(p, {grab})`）。
 */
const SCRUFF_GRAB = { x: 128, y: 36, hang: 0 };
export const STAND = HIPS.map(h => [h[0], h[1], h[0], FOOT_Y]);
const DROP = 'M0 -9C4 -3 6 0 6 3.5A6 6 0 0 1 -6 3.5C-6 0 -4 -3 0 -9Z';
const pol = (a, r) => [128 + r * Math.cos(a * Math.PI / 180), 128 - r * Math.sin(a * Math.PI / 180)];
const pt = p => `${f(p[0])} ${f(p[1])}`;

function cPath(gt, gb) {
  return `M${pt(pol(gt, 84))}A84 84 0 1 0 ${pt(pol(-gb, 84))}`;
}
function ellipse(cx, cy, rx, ry) {
  if (ry < 1.6) return `M${f(cx - rx)} ${f(cy)}L${f(cx + rx)} ${f(cy)}`;
  return `M${f(cx - rx)} ${f(cy)}A${f(rx)} ${f(ry)} 0 1 0 ${f(cx + rx)} ${f(cy)}A${f(rx)} ${f(ry)} 0 1 0 ${f(cx - rx)} ${f(cy)}Z`;
}
export function heartD(cx, cy, s) {
  const p = (x, y) => `${f(cx + x * s)} ${f(cy + y * s)}`;
  return `M${p(0, 14)}C${p(-7, 8)} ${p(-19, 1)} ${p(-19, -6)}C${p(-19, -15)} ${p(-8, -18)} ${p(0, -9)}C${p(8, -18)} ${p(19, -15)} ${p(19, -6)}C${p(19, 1)} ${p(7, 8)} ${p(0, 14)}Z`;
}
function eyePath(e, cx, cy) {
  cx += e.dx || 0; cy += e.dy || 0;
  switch (e.shape) {
    case 'ring': return ellipse(cx, cy, e.rx, e.ry);
    case 'lid': return e.ry < 1.6 ? `M${f(cx - 16)} ${f(cy)}L${f(cx + 16)} ${f(cy)}` : `M${f(cx - 16)} ${f(cy)}A16 ${f(e.ry)} 0 0 0 ${f(cx + 16)} ${f(cy)}Z`;
    case 'up': return `M${f(cx - 15)} ${f(cy + 6)}Q${f(cx)} ${f(cy - 17)} ${f(cx + 15)} ${f(cy + 6)}`;
    case 'down': return `M${f(cx - 15)} ${f(cy - 3)}Q${f(cx)} ${f(cy + 15)} ${f(cx + 15)} ${f(cy - 3)}`;
    case 'gt': return `M${f(cx - 10)} ${f(cy - 13)}L${f(cx + 11)} ${f(cy)}L${f(cx - 10)} ${f(cy + 13)}`;
    case 'lt': return `M${f(cx + 10)} ${f(cy - 13)}L${f(cx - 11)} ${f(cy)}L${f(cx + 10)} ${f(cy + 13)}`;
    case 'heart': return heartD(cx, cy, e.s);
    case 'spiral': {
      let d = '';
      const max = Math.PI * 4.4;
      for (let i = 0; i <= 44; i++) {
        const a = max * i / 44, r = 2 + 15 * i / 44;
        d += (i ? 'L' : 'M') + f(cx + r * Math.cos(a + e.rot)) + ' ' + f(cy + r * Math.sin(a + e.rot));
      }
      return d;
    }
  }
  return '';
}

/* ---------- accessories ----------
   Solid shapes first; lines only where a piece is a line (band, stalk, frame), never thinner than 10.
   Every part is painted through a color channel: c-<slot>-main / c-<slot>-acc. */
export const PALETTES = [
  { id: 'mint',      label: '薄荷绿', l: ['#1B1626', '#00A870'], d: ['#FFFFFF', '#2FD59B'] },
  { id: 'mono',      label: '单色',   l: ['#1B1626', '#1B1626'], d: ['#FFFFFF', '#FFFFFF'] },
  { id: 'navigator', label: '领航员', l: ['#14213A', '#1F6FE0'], d: ['#FFFFFF', '#5EA3FF'] },
  { id: 'claude',    label: '克劳德', l: ['#2A1C16', '#C9623F'], d: ['#FFFFFF', '#E58B69'] },
  { id: 'fox',       label: '红狐狸', l: ['#26140F', '#DD3526'], d: ['#FFFFFF', '#FF6655'] },
  { id: 'purple',    label: '虚式茈', l: ['#1D1430', '#8B3DF0'], d: ['#FFFFFF', '#B98AFF'] },
  { id: 'lemon',     label: '柠檬黄', l: ['#252010', '#D9B300'], d: ['#FFFFFF', '#FFE14F'] },
];
export const HEADS = [['none', '无'], ['cat', '猫耳'], ['bear', '熊耳'], ['bunny', '兔耳'], ['antenna', '天线'], ['halo', '光环'], ['tophat', '礼帽'], ['party', '派对帽'], ['sailor', '水手帽']];
export const SIDES = [['none', '无'], ['headphones', '耳机'], ['feather', '耳羽'], ['earring', '耳环'], ['clip', '发夹'], ['bow', '蝴蝶结']];
export const GLASSES = [['none', '无'], ['round', '圆框'], ['square', '方框'], ['monocle', '单片镜']];
export const NECKS = [['none', '无'], ['bowtie', '领结'], ['bell', '铃铛'], ['scarf', '围巾']];
export const HEAD_TOP = { none: 12, cat: -14, bear: -4, bunny: -34, antenna: -34, halo: -8, tophat: -28, party: -34, sailor: -20 };

/* color mapping: channel -> source. 'body' / 'eye' follow the palette; the rest are fixed accessory colors with a dark twin */
export const ACC_COLORS = [
  { id: 'mint',      label: '薄荷绿', l: '#00A870', d: '#2FD59B' },
  { id: 'leaf',      label: '叶绿',   l: '#3C9A2C', d: '#80D46B' },
  { id: 'lemon',     label: '柠檬黄', l: '#D9B300', d: '#FFE14F' },
  { id: 'fox',       label: '红狐狸', l: '#DD3526', d: '#FF6655' },
  { id: 'claude',    label: '克劳德', l: '#C9623F', d: '#E58B69' },
  { id: 'rose',      label: '樱粉',   l: '#DB3F76', d: '#FF85AE' },
  { id: 'purple',    label: '虚式茈', l: '#8B3DF0', d: '#B98AFF' },
  { id: 'navigator', label: '领航员', l: '#1F6FE0', d: '#5EA3FF' },
  { id: 'holo',      label: '全息蓝', l: '#1AA3D9', d: '#6FD3FF' },
];
export const LINKED = [{ id: 'body', label: '跟随身体' }, { id: 'eye', label: '跟随眼睛' }];
export const SLOTS = ['head', 'side', 'glasses', 'neck'];
export const SLOT_LISTS = { head: HEADS, side: SIDES, glasses: GLASSES, neck: NECKS };
export const CHANNEL_DEFAULT = { head: { main: 'body', acc: 'eye' }, side: { main: 'eye', acc: 'eye' }, glasses: { main: 'body', acc: 'eye' }, neck: { main: 'eye', acc: 'eye' } };
// side and neck pieces lie on top of the body outline: mapping them to the body color would make them vanish
export const NO_BODY = { head: false, side: true, glasses: false, neck: true };
// character pieces carry their original colors; picking one fills its channels, which stay editable afterwards
/*
 * 上游这里还有 `ITEM_COLORS` / `ROLES`（装扮页用：每件饰品占哪几个颜色通道）。
 * 本 fork **没有装扮页**（改成 `dress.cjs` + 服装清单那套），`wear()` 也因此没有任何调用点，
 * 所以 2026-10-08 的清理里把这三个死导出连同 `wear()` 一起删了 —— 留着会让读代码的人
 * 以为装扮由这里驱动。
 *
 * ⚠️ **只删了"零引用的导出"**；上游那些"从不触发但活着"的功能路径（语音输入、屏幕取色…）
 * 一律保留，理由见 HANDOVER 第 4 节（动它们等于自己维护一个 fork）。
 */

const mount = (a, r = 96) => `translate(${pt(pol(a, r))}) rotate(${f(90 - a)})`;
const stroke = (cls, w) => `class="${cls}" fill="none" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"`;
// solid shape with rounded corners: filled and stroked in the same channel color
const blob = (slot, ch, w) => `class="f-${slot}-${ch} c-${slot}-${ch}" stroke-width="${w}" stroke-linejoin="round" stroke-linecap="round"`;

function headBack(id, sw) {
  switch (id) {
    case 'cat':
      return [126, 82].map(a => `<path ${blob('head', 'main', 10)} transform="${mount(a)}" d="M-17 8L0 -28L17 8Z"/>`).join('');
    case 'bear':
      return [128, 80].map(a => `<circle class="f-head-main" transform="${mount(a)}" cx="0" cy="-8" r="18"/>`).join('');
    case 'bunny':
      return [[116, -10, .7], [92, 6, 1]].map(([a, off, k]) =>
        `<g transform="${mount(a)} rotate(${f(off + sw * k)})"><ellipse class="f-head-main" cx="0" cy="-28" rx="14" ry="30"/></g>`).join('');
    case 'antenna':
      return `<g transform="${mount(98)} rotate(${f(sw)})"><path ${stroke('c-head-main', 14)} d="M0 0Q5 -20 0 -38"/><circle class="f-head-acc" cx="0" cy="-50" r="12"/></g>`;
  }
  return '';
}
function headFront(id, sw, t) {
  switch (id) {
    case 'sailor':
      return `<g transform="${mount(106)} rotate(${f(sw * .2)})"><path class="f-head-main" d="M-34 3L-38 -30Q0 -40 38 -30L34 3Q0 -3 -34 3Z"/><path class="f-head-acc" d="M-37.1 -23Q0 -31 37.1 -23L36.1 -15Q0 -23 -36.1 -15ZM-35.6 -11Q0 -19 35.6 -11L34.8 -4Q0 -12 -34.8 -4Z"/></g>`;
    case 'halo':
      return `<g transform="${mount(98)}"><ellipse ${stroke('c-head-acc', 12)} cx="0" cy="${f(-28 + 3 * Math.sin(t * 2.2))}" rx="36" ry="9"/></g>`;
    case 'tophat':
      return `<g transform="${mount(104)} rotate(${f(sw * .2)})"><rect class="f-head-main" x="-40" y="-7" width="80" height="12" rx="6"/><rect class="f-head-main" x="-22" y="-48" width="44" height="46" rx="7"/><rect class="f-head-acc" x="-22" y="-20" width="44" height="10"/></g>`;
    case 'party':
      return `<g transform="${mount(110)} rotate(${f(sw * .3)})"><path ${blob('head', 'main', 8)} d="M-24 2L0 -46L24 2Z"/><circle class="f-head-acc" cx="0" cy="-55" r="11"/></g>`;
  }
  return '';
}
// Side pieces sit where an ear would be on this profile: the back of the head, around 130–172°.
function sideBack(id, sw) {
  if (id !== 'feather') return '';
  const blade = (L, w) => `M0 0C${-w} ${f(-L * .3)} ${f(-w * .8)} ${f(-L * .8)} ${f(-L * .14)} ${-L}C${f(w * .6)} ${f(-L * .75)} ${w} ${f(-L * .3)} 0 0Z`;
  return `<g transform="${mount(166, 92)} rotate(${f(sw * .6)})">` +
    `<path class="f-side-acc" transform="rotate(58)" d="${blade(66, 18)}"/>` +
    `<path class="f-side-main" transform="rotate(26)" d="${blade(56, 16)}"/>` +
    `<path class="f-side-main" d="${blade(42, 14)}"/></g>`;
}
function sideFront(id, sw) {
  switch (id) {
    case 'headphones':
      return `<path ${stroke('c-side-main', 16)} d="M${pt(pol(150, 113))}A113 113 0 0 1 ${pt(pol(76, 113))}"/>` +
        `<rect class="f-side-acc" transform="${mount(166, 98)}" x="-24" y="-17" width="48" height="34" rx="17"/>`;
    case 'earring':
      return `<g transform="translate(${pt(pol(172, 99))}) rotate(${f(sw * .8)})"><circle class="f-side-main" cx="0" cy="13" r="10"/></g>`;
    case 'clip':
      return `<rect class="f-side-main" transform="${mount(140, 86)}" x="-17" y="-6.5" width="34" height="13" rx="6.5"/>`;
    case 'bow':
      return `<g class="f-side-main" transform="${mount(132, 100)} rotate(${f(sw * .3)})"><path d="M-4 0L-24 -14Q-28 0 -24 14ZM4 0L24 -14Q28 0 24 14Z"/><circle r="7"/></g>`;
  }
  return '';
}
function glassesD(id, gx, gy) {
  // frames sit one ring-width outside the eyes so the two never touch
  const L = [113 + gx, 117 + gy], R = [163 + gx, 117 + gy], M = stroke('c-glasses-main', 10);
  switch (id) {
    case 'round':
      return `<circle ${M} cx="${f(L[0])}" cy="${f(L[1])}" r="31"/><circle ${M} cx="${f(R[0])}" cy="${f(R[1])}" r="31"/><path ${M} d="M${f(L[0] - 31)} ${f(L[1] - 6)}L62 106"/>`;
    case 'square':
      return `<rect ${M} x="${f(L[0] - 26)}" y="${f(L[1] - 22)}" width="52" height="44" rx="15"/><rect ${M} x="${f(R[0] - 26)}" y="${f(R[1] - 22)}" width="52" height="44" rx="15"/><path ${M} d="M${f(L[0] - 26)} ${f(L[1] - 6)}L62 106"/>`;
    case 'monocle':
      return `<circle ${M} cx="${f(R[0])}" cy="${f(R[1])}" r="31"/>`;
  }
  return '';
}
function neckD(id, sw) {
  switch (id) {
    case 'bowtie':
      return `<g ${blob('neck', 'main', 6)} transform="translate(176 206) rotate(-32)"><path d="M-4 0L-22 -13V13ZM4 0L22 -13V13Z"/><circle r="7"/></g>`;
    case 'bell': {
      const a = pol(-150, 84), b = pol(-60, 84);
      return `<path ${stroke('c-neck-main', 12)} d="M${pt(a)}A84 84 0 0 0 ${pt(b)}"/><g transform="translate(${pt(b)}) rotate(${f(sw * .6)})"><circle class="f-neck-acc" cx="0" cy="14" r="13"/></g>`;
    }
    case 'scarf': {
      const a = pol(-150, 84), b = pol(-72, 84), S2 = stroke('c-neck-main', 18);
      return `<path ${S2} d="M${pt(a)}A84 84 0 0 0 ${pt(b)}"/><g transform="rotate(${f(sw * .8)} ${pt(a)})"><path ${S2} d="M${pt(a)}q-12 22 -6 40"/></g>`;
    }
  }
  return '';
}

/* ---------- faces ---------- */
const ring = o => ({ shape: 'ring', rx: 16, ry: 16, ...o });
const yawn = t => { const p = (t % 4.2) / 1.6; return p < 1 ? Math.sin(Math.PI * p) ** 2 : 0; };

export const FACES = {
  neutral:   { label: '平静', kao: '(0 0',  f: () => ({ gap: [50, 50], eyes: [ring(), ring()] }) },
  happy:     { label: '开心', kao: '(^ ^',  f: () => ({ gap: [58, 58], eyes: [{ shape: 'up' }, { shape: 'up' }], blush: .45 }) },
  wink:      { label: '眨眼', kao: '(0 ^',  f: () => ({ gap: [56, 52], eyes: [ring(), { shape: 'up' }] }) },
  love:      { label: '喜欢', kao: '(♡ ♡',  f: t => { const s = .8 + .08 * Math.sin(t * 9); return { gap: [56, 56], eyes: [{ shape: 'heart', s, sw: 8 }, { shape: 'heart', s, sw: 8 }], blush: .7, emit: 'heart' }; } },
  shy:       { label: '害羞', kao: '(o o *', f: () => ({ gap: [40, 40], eyes: [ring({ rx: 13, ry: 12, dx: -3, dy: 5 }), ring({ rx: 13, ry: 12, dx: -3, dy: 5 })], blush: 1, lookLock: true }) },
  surprised: { label: '惊讶', kao: '(O O',  f: () => ({ gap: [62, 62], eyes: [ring({ rx: 20, ry: 21 }), ring({ rx: 20, ry: 21 })], bang: true }) },
  angry:     { label: '生气', kao: '(ò ó',  f: () => ({ gap: [36, 36], eyes: [ring({ ry: 11, dy: 4 }), ring({ ry: 11, dy: 4 })], brows: 'angry', anger: true, shake: true }) },
  sad:       { label: '难过', kao: '(ó ò',  f: () => ({ gap: [34, 40], eyes: [ring({ ry: 14, dy: 4 }), ring({ ry: 14, dy: 4 })], brows: 'sad', emit: 'tear' }) },
  sleepy:    { label: '犯困', kao: '(- -',  f: t => { const y = yawn(t); return { gap: [50 + 14 * y, 50 + 14 * y], eyes: [{ shape: 'lid', ry: 9 - 7 * y }, { shape: 'lid', ry: 9 - 7 * y }] }; } },
  sleep:     { label: '睡着', kao: '(u u',  f: t => { const b = 40 + 6 * Math.sin(t * 1.7); return { gap: [b, b], eyes: [{ shape: 'down' }, { shape: 'down' }], emit: 'z' }; } },
  dizzy:     { label: '晕乎', kao: '(@ @',  f: t => ({ gap: [54 + 5 * Math.sin(t * 5), 48], eyes: [{ shape: 'spiral', rot: t * 7 }, { shape: 'spiral', rot: t * 7 + 1.4 }], orbit: true }) },
  dragged:   { label: '被拎起', kao: '(> <', f: t => { const g = 55 + 3 * Math.sin(t * 22); return { gap: [g, g], eyes: [{ shape: 'gt' }, { shape: 'lt' }], sweat: true }; } },
  content:   { label: '惬意', f: (t, p) => { const r = 11 - 9 * (p ? p.drowse : 0); return { gap: [46, 46], eyes: [{ shape: 'lid', ry: r }, { shape: 'lid', ry: r }] }; } },
  waking:    { label: '醒来', f: (t, p) => {
    const mt = p ? p.modeT : 1;
    const k = clamp(mt / .5, 0, 1), y = mt > .5 ? Math.sin(clamp((mt - .5) / .9, 0, 1) * Math.PI) : 0;
    const r = Math.max(0, 10 * k * (1 - .7 * y));
    return { gap: [50 + 12 * y, 50 + 12 * y], eyes: [{ shape: 'lid', ry: r }, { shape: 'lid', ry: r }] };
  } },
  squeeze:   { label: '回神', f: () => ({ gap: [44, 44], eyes: [{ shape: 'lid', ry: 0 }, { shape: 'lid', ry: 0 }] }) },
  listening: { label: '倾听', f: () => ({ gap: [44, 44], eyes: [ring({ rx: 17, ry: 18, dy: -1 }), ring({ rx: 17, ry: 18, dy: -1 })], listen: true }) },
  thinking:  { label: '思考', f: t => ({ gap: [46, 46], eyes: [ring({ rx: 14, ry: 15, dx: 3, dy: -4 }), ring({ rx: 14, ry: 15, dx: 3, dy: -4 })], think: true }) },
  run:       { label: '冲刺', f: t => { const g = 55 + 4 * Math.sin(t * 16); return { gap: [g, g], eyes: [ring(), ring()], sweat: true }; } },
};

/** One frame of the figure as SVG markup, in logo units. */
export function figure(fc, o) {
  const t = o.t, lx = o.look[0], ly = o.look[1], acc = o.acc, sw = o.swing || 0;
  let s = `<g class="ink" fill="none" stroke-width="${LEG_W}" stroke-linecap="round">`;
  for (const l of o.legs) s += `<path d="M${f(l[0])} ${f(l[1])}L${f(l[2])} ${f(l[3])}"/>`;
  s += `</g><g transform="translate(0 ${f(o.low)})">`;
  s += sideBack(acc.side, sw);
  s += headBack(acc.head, sw);
  s += `<path class="ink" fill="none" stroke-width="${BODY_W}" stroke-linecap="round" d="${cPath(fc.gap[0], fc.gap[1])}"/>`;
  s += neckD(acc.neck, sw);
  if (fc.blush > .02) {
    s += `<g class="blush" opacity="${f(fc.blush * .8)}"><ellipse cx="${f(99 + lx)}" cy="146" rx="11" ry="5.5"/><ellipse cx="${f(167 + lx)}" cy="146" rx="11" ry="5.5"/></g>`;
  }
  const close = o.eyeClose || 0;
  fc.eyes.forEach((e, i) => {
    const ee = { ...e };
    if ((ee.shape === 'ring' || ee.shape === 'lid') && o.blink) ee.ry *= (1 - o.blink);
    const cx = EYES[i][0] + lx, cy = EYES[i][1] + ly;
    const tr = close > .01 ? ` transform="translate(0 ${f(cy)}) scale(1 ${f(Math.max(.08, 1 - close) * 100) / 100}) translate(0 ${f(-cy)})"` : '';
    s += `<path class="eye" fill="none" stroke-width="${e.sw || 12}" stroke-linecap="round" stroke-linejoin="round"${tr} d="${eyePath(ee, cx, cy)}"/>`;
  });
  s += glassesD(acc.glasses, lx * .4, ly * .3);
  if (fc.brows) {
    const bx = lx * .5, by = ly * .4;
    const d = fc.brows === 'angry'
      ? `M${f(98 + bx)} ${f(88 + by)}L${f(124 + bx)} ${f(97 + by)}M${f(152 + bx)} ${f(97 + by)}L${f(178 + bx)} ${f(88 + by)}`
      : `M${f(98 + bx)} ${f(96 + by)}L${f(123 + bx)} ${f(88 + by)}M${f(153 + bx)} ${f(88 + by)}L${f(178 + bx)} ${f(96 + by)}`;
    s += `<path class="ink" fill="none" stroke-width="9" stroke-linecap="round" d="${d}"/>`;
  }
  s += sideFront(acc.side, sw);
  s += headFront(acc.head, sw, t);
  if (fc.orbit) {
    const top = HEAD_TOP[acc.head] ?? 12;
    for (let i = 0; i < 3; i++) {
      const a = t * 3.2 + i * 2.094, sn = Math.sin(a);
      s += `<circle class="eye" fill="none" stroke-width="4" cx="${f(128 + 62 * Math.cos(a))}" cy="${f(top + 12 * sn)}" r="${sn < 0 ? 5 : 7}" opacity="${sn < 0 ? .55 : 1}"/>`;
    }
  }
  if (fc.listen) {
    // sound waves drifting in toward the face
    for (let i = 0; i < 3; i++) {
      const p = (t * .9 + i / 3) % 1, r = 46 - 30 * p, a0 = -.55, a1 = .55;
      s += `<path class="eye" fill="none" stroke-width="7" stroke-linecap="round" opacity="${f(Math.sin(Math.PI * p))}" d="M${f(196 + r * Math.cos(a0))} ${f(104 + r * Math.sin(a0))}A${f(r)} ${f(r)} 0 0 1 ${f(196 + r * Math.cos(a1))} ${f(104 + r * Math.sin(a1))}"/>`;
    }
  }
  if (fc.think) {
    // three rings rising from the head, the eye's own shape
    for (let i = 0; i < 3; i++) {
      const k = ((t * .8 + i / 3) % 1);
      s += `<circle class="eye" fill="none" stroke-width="5" cx="${f(214 + 10 * i)}" cy="${f(46 - 22 * i - 6 * k)}" r="${4 + 3 * i}" opacity="${f(.4 + .6 * Math.sin(Math.PI * k))}"/>`;
    }
  }
  if (fc.sweat) s += `<path class="tearf" transform="translate(56 ${f(64 + 3 * Math.sin(t * 7))}) scale(1.3)" d="${DROP}"/>`;
  if (fc.anger) {
    const k = 1 + .12 * Math.sin(t * 10);
    s += `<g class="angry" transform="translate(210 44) scale(${f(k * 10) / 10})" fill="none" stroke-width="7" stroke-linecap="round"><path d="M-13 -4Q-4 -4 -4 -13M4 -13Q4 -4 13 -4M13 4Q4 4 4 13M-4 13Q-4 4 -13 4"/></g>`;
  }
  if (fc.bang) s += `<g transform="translate(222 30)"><path class="ink" fill="none" stroke-width="11" stroke-linecap="round" d="M0 -18V4"/><circle class="inkf" cx="0" cy="18" r="5.5"/></g>`;
  if (o.zmark) s += '<path class="eye" fill="none" stroke-width="6" stroke-linecap="round" stroke-linejoin="round" d="M204 22H220L204 42H220M226 4H236L226 16H236"/>';
  return s + '</g>';
}

/** A static figure for previews and tiles. */
export function mini(face, acc, t = 0, extra = {}) {
  return figure(FACES[face].f(t), { look: [0, 0], legs: STAND, low: 0, t, blink: 0, acc, ...extra });
}

/* ---------- skin ---------- */
/** Bodies the pet can wear: Coo (drawn here) or the DeepSeek whale maid (web/whale, with its colour schemes). */
export const FIGURES = [['coo', 'Coo'], ['whale', 'DeepSeek 大肥鱼']];
export function defaultSkin() {
  return { figure: 'coo', scheme: 'deepseek', palette: 'mint', head: 'none', side: 'none', glasses: 'none', neck: 'none', colors: JSON.parse(JSON.stringify(CHANNEL_DEFAULT)) };
}
const validColor = (slot, v) => (v === 'eye' || (v === 'body' && !NO_BODY[slot]) || ACC_COLORS.some(c => c.id === v));
/** Keeps what is valid in `raw`, defaults the rest. */
export function normalizeSkin(raw) {
  const skin = defaultSkin();
  if (!raw || typeof raw !== 'object') return skin;
  if (FIGURES.some(([id]) => id === raw.figure)) skin.figure = raw.figure;
  // the whale's schemes are listed in its model; the pet page falls back to the original for an unknown id
  if (typeof raw.scheme === 'string' && /^[a-z0-9-]{1,32}$/.test(raw.scheme)) skin.scheme = raw.scheme;
  if (PALETTES.some(p => p.id === raw.palette)) skin.palette = raw.palette;
  for (const slot of SLOTS) if (SLOT_LISTS[slot].some(h => h[0] === raw[slot])) skin[slot] = raw[slot];
  for (const slot of SLOTS) for (const ch of ['main', 'acc']) {
    const v = raw.colors?.[slot]?.[ch];
    if (validColor(slot, v)) skin.colors[slot][ch] = v;
  }
  return skin;
}
function channelValue(skin, slot, ch, dark) {
  const v = skin.colors[slot][ch];
  if (v === 'body') return 'var(--skin-ink)';
  if (v === 'eye') return 'var(--skin-eye)';
  const c = ACC_COLORS.find(x => x.id === v);
  return dark ? c.d : c.l;
}
/** CSS custom properties for one theme side. */
export function skinVars(skin, dark) {
  const p = PALETTES.find(x => x.id === skin.palette) || PALETTES[0];
  let s = `--skin-ink:${p[dark ? 'd' : 'l'][0]};--skin-eye:${p[dark ? 'd' : 'l'][1]};`;
  for (const slot of SLOTS) for (const ch of ['main', 'acc']) s += `--c-${slot}-${ch}:${channelValue(skin, slot, ch, dark)};`;
  return s;
}
/** A stylesheet applying `skin` under `selector`, following the page's light/dark choice. */
export function skinCss(skin, selector = 'html:root') {
  return `${selector}{${skinVars(skin, false)}}` +
    `@media (prefers-color-scheme: dark){${selector}:not([data-theme="light"]){${skinVars(skin, true)}}}` +
    `${selector}[data-theme="dark"]{${skinVars(skin, true)}}`;
}

/* ---------- the pages' round buttons: icons (24 units, currentColor) and the theme switch ---------- */
const icon = d => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
export const ICONS = {
  chat: icon('<path d="M6 4.5h12a3 3 0 0 1 3 3v7a3 3 0 0 1-3 3h-6l-4.5 3.5v-3.5H6a3 3 0 0 1-3-3v-7a3 3 0 0 1 3-3z"/>'),
  moon: icon('<path d="M20 14.6A8.2 8.2 0 1 1 9.4 4a6.6 6.6 0 0 0 10.6 10.6z"/>'),
  sun: icon('<circle cx="12" cy="12" r="4"/><path d="M12 2.8v1.6M12 19.6v1.6M2.8 12h1.6M19.6 12h1.6M5.5 5.5l1.1 1.1M17.4 17.4l1.1 1.1M5.5 18.5l1.1-1.1M17.4 6.6l1.1-1.1"/>'),
  play: icon('<path d="M8 5.5v13l10.5-6.5z"/>'),
  pause: icon('<path d="M9 5.5v13M15 5.5v13"/>'),
  // eight flat teeth around a hub
  settings: icon(`<path d="${Array.from({ length: 32 }, (_, i) => {
    const a = (i - .5) * Math.PI / 16, r = i % 4 < 2 ? 9.6 : 7.2;
    return `${i ? 'L' : 'M'}${f(12 + r * Math.cos(a))} ${f(12 + r * Math.sin(a))}`;
  }).join('')}Z"/><circle cx="12" cy="12" r="3"/>`),
  power: icon('<path d="M12 3.5v8M7.2 6.3a8 8 0 1 0 9.6 0"/>'),
  mic: icon('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5v3"/>'),
  // the same microphone struck through
  micOff: icon('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5v3M4 4l16 16"/>'),
  sound: icon('<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/>'),
  soundOff: icon('<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M16 9.5l5 5M21 9.5l-5 5"/>'),
  // a T-shirt: the dressing page
  shirt: icon('<path d="M8.5 3.5 4 6l-1.5 4.5L6 12v8.5h12V12l3.5-1.5L20 6l-4.5-2.5a3.5 3.5 0 0 1-7 0z"/>'),
  eye: icon('<path d="M3 12s3.2-6 9-6 9 6 9 6-3.2 6-9 6-9-6-9-6z"/><circle cx="12" cy="12" r="3"/>'),
  // a page that opens in the browser
  external: icon('<path d="M14 4h6v6M20 4l-8.5 8.5M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/>'),
  // a ball with a seam: the toy toggle
  ball: icon('<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5v17M6 6.2c3.2 2.2 3.2 9.4 0 11.6M18 6.2c-3.2 2.2-3.2 9.4 0 11.6"/>'),
  eyeOff: icon('<path d="M3 12s3.2-6 9-6c1.6 0 3 .4 4.2 1M21 12s-3.2 6-9 6c-1.6 0-3-.4-4.2-1"/><path d="M9.9 14.1a3 3 0 0 1 4.2-4.2M4 4l16 16"/>'),
  // how much the pet walks on its own, as a gauge: low, middle, high
  roam_off: icon('<path d="M4 16a8 8 0 0 1 16 0"/><path d="M12 16 7 13.2"/><circle cx="12" cy="16" r="1.2" fill="currentColor"/>'),
  roam_calm: icon('<path d="M4 16a8 8 0 0 1 16 0"/><path d="M12 16V10"/><circle cx="12" cy="16" r="1.2" fill="currentColor"/>'),
  roam_free: icon('<path d="M4 16a8 8 0 0 1 16 0"/><path d="M12 16l5-2.8"/><circle cx="12" cy="16" r="1.2" fill="currentColor"/><path d="M19.5 6.5l1.5-1.5M21 10h1.5"/>'),
  roam_cling: icon('<path d="M4 16a8 8 0 0 1 16 0"/><path d="M12 16V9"/><circle cx="12" cy="16" r="1.2" fill="currentColor"/><path d="M12 2.6l.9 1.7 1.9.3-1.4 1.4.3 1.9L12 7l-1.7.9.3-1.9-1.4-1.4 1.9-.3Z"/>'),
};
/** Sets `theme` ('dark' | 'light') on the page; `button`, when given, shows the mode a click switches to. */
export function applyTheme(theme, button) {
  document.documentElement.dataset.theme = theme;
  if (!button) return;
  const toLight = theme === 'dark';
  button.innerHTML = toLight ? ICONS.sun : ICONS.moon;
  button.title = toLight ? '切到白天模式' : '切到夜间模式';
  button.setAttribute('aria-label', button.title);
}

/* ---------- sound: synthesized with Web Audio, no files ---------- */
/** Which kind each sound belongs to; a kind can be silenced on its own (`sfx.configure`). */
export const SOUND_KINDS = {
  move: ['step', 'skid', 'jump', 'land', 'whoosh', 'chirps', 'shake', 'nod', 'spin'],
  touch: ['grab', 'squeak', 'purr', 'poke'],
  face: ['happy', 'wink', 'love', 'surprised', 'angry', 'sad', 'shy', 'yawn'],
  snore: ['snore'],
  talk: ['babble', 'blub'],
  ui: ['tick', 'pop', 'sparkle', 'select', 'listenStart', 'listenEnd'],
};
export function createSfx({ storageKey = 'cortico-pet.sound.v1', volume = .55 } = {}) {
  let ctx = null, master = null, unlocked = false, on = true, noiseBuf = null, gainValue = volume;
  // kinds turned off, and seconds of snoring per sleep (0 = the whole sleep)
  let muted = new Set(), snoreSeconds = 0;
  try { on = localStorage.getItem(storageKey) !== 'off'; } catch (e) { /* default on */ }
  const R = (a, b) => a + Math.random() * (b - a);
  function ready() {
    if (!on || !unlocked || document.hidden) return null;
    return context();
  }
  /** The AudioContext on its own, whether or not effects are switched on (the voice needs it too). */
  function context() {
    if (!ctx) {
      const C = window.AudioContext || window.webkitAudioContext;
      if (!C) return null;
      ctx = new C();
      master = ctx.createGain(); master.gain.value = gainValue;
      const comp = ctx.createDynamicsCompressor();
      master.connect(comp); comp.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }
  function tone({ type = 'sine', f0 = 440, f1 = f0, dur = .1, vol = .2, at = 0, attack = .005, vib = 0, vibRate = 0, filter = 0 }) {
    const c = ready(); if (!c) return;
    const t0 = c.currentTime + at, o = c.createOscillator(), g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t0);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t0 + dur);
    if (vib) {
      const l = c.createOscillator(), lg = c.createGain();
      l.frequency.value = vibRate; lg.gain.value = vib;
      l.connect(lg); lg.connect(o.frequency); l.start(t0); l.stop(t0 + dur + .05);
    }
    g.gain.setValueAtTime(.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + attack);
    g.gain.exponentialRampToValueAtTime(.0001, t0 + dur);
    let node = o;
    if (filter) { const bq = c.createBiquadFilter(); bq.type = 'lowpass'; bq.frequency.value = filter; o.connect(bq); node = bq; }
    node.connect(g); g.connect(master);
    o.start(t0); o.stop(t0 + dur + .03);
  }
  function noise({ type = 'bandpass', f0 = 1000, f1 = f0, q = 1, dur = .2, vol = .15, at = 0, attack = .01 }) {
    const c = ready(); if (!c) return;
    if (!noiseBuf) {
      noiseBuf = c.createBuffer(1, c.sampleRate, c.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    const t0 = c.currentTime + at, s = c.createBufferSource(), bq = c.createBiquadFilter(), g = c.createGain();
    s.buffer = noiseBuf; bq.type = type; bq.Q.value = q;
    bq.frequency.setValueAtTime(f0, t0);
    bq.frequency.exponentialRampToValueAtTime(f1, t0 + dur);
    g.gain.setValueAtTime(.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + attack);
    g.gain.exponentialRampToValueAtTime(.0001, t0 + dur);
    s.connect(bq); bq.connect(g); g.connect(master);
    s.start(t0, Math.random() * .5); s.stop(t0 + dur + .03);
  }
  const api = {
    unlock() { unlocked = true; ready(); },
    isOn: () => on,
    set(v) { on = v; try { localStorage.setItem(storageKey, v ? 'on' : 'off'); } catch (e) { /* not persisted */ } },
    volume(v) { gainValue = v; if (master) master.gain.value = v; },
    /** `kinds`: kind → on (SOUND_KINDS); `snoreSeconds`: snoring stops this long into a sleep, 0 = never. */
    configure({ kinds, snoreSeconds: s } = {}) {
      if (kinds) muted = new Set(Object.keys(SOUND_KINDS).filter((k) => kinds[k] === false));
      if (typeof s === 'number' && s >= 0) snoreSeconds = s;
    },
    step(run, i) {
      const k = run ? 1.25 : 1;
      tone({ f0: (i ? 520 : 440) * k, f1: (i ? 380 : 330) * k, dur: .06, vol: run ? .07 : .05 });
      if (run) noise({ f0: 2500, q: .8, dur: .05, vol: .03 });
    },
    skid() { noise({ type: 'highpass', f0: 1800, f1: 900, dur: .22, vol: .08 }); },
    jump() { tone({ type: 'triangle', f0: 200, f1: 720, dur: .24, vol: .22, vib: 40, vibRate: 22 }); },
    land(hard) {
      tone({ f0: hard ? 160 : 190, f1: 48, dur: hard ? .28 : .16, vol: hard ? .4 : .25 });
      noise({ type: 'lowpass', f0: hard ? 700 : 500, f1: 120, dur: .12, vol: hard ? .25 : .12 });
      if (hard) tone({ type: 'square', f0: 420, f1: 300, dur: .08, vol: .06, at: .02, filter: 1600 });
    },
    grab() { tone({ type: 'triangle', f0: 680, f1: 1500, dur: .14, vol: .18, vib: 60, vibRate: 30 }); },
    squeak() { tone({ type: 'triangle', f0: R(900, 1200), f1: R(1300, 1700), dur: .09, vol: .08, vib: 40, vibRate: 35 }); },
    whoosh() { noise({ f0: 300, f1: 2400, q: 1.4, dur: .38, vol: .22, attack: .08 }); },
    chirps() { for (let i = 0; i < 3; i++) tone({ f0: 2300 + i * 120, f1: 3200, dur: .06, vol: .06, at: i * .11 }); },
    shake() { for (let i = 0; i < 5; i++) tone({ type: 'square', f0: 180, f1: 160, dur: .05, vol: .05, at: i * .06, filter: 900 }); },
    hmm() { tone({ type: 'triangle', f0: 330, f1: 360, dur: .12, vol: .08 }); tone({ type: 'triangle', f0: 392, f1: 470, dur: .16, vol: .08, at: .14 }); },
    yawn() { tone({ type: 'triangle', f0: 520, f1: 240, dur: 1, vol: .1, vib: 12, vibRate: 5, filter: 1500, attack: .15 }); },
    /** `asleepFor`: seconds since this sleep began. */
    snore(asleepFor = 0) {
      if (snoreSeconds > 0 && asleepFor > snoreSeconds) return;
      noise({ type: 'lowpass', f0: 250, f1: 700, dur: .7, vol: .09, attack: .35 });
    },
    purr() { tone({ type: 'sawtooth', f0: 62, f1: 58, dur: .9, vol: .08, vib: 6, vibRate: 24, filter: 320, attack: .1 }); },
    /** 踢到玩具球：一声闷响 + 一点"皮球"的弹响。`k` 是力度 0~1。 */
    kick(k = 1) {
      const p = Math.max(.3, Math.min(1, k));
      tone({ f0: 150 + 60 * p, f1: 62, dur: .1 + .05 * p, vol: .2 + .12 * p });
      noise({ type: 'lowpass', f0: 900, f1: 200, dur: .07, vol: .1 + .08 * p });
      tone({ type: 'triangle', f0: 520 + 220 * p, f1: 300, dur: .07, vol: .07 * p, at: .02, filter: 2000 });
    },
    /** 球弹地的声音：`k` 是撞击强度 0~1。 */
    ballBounce(k = .5) {
      const p = Math.max(.15, Math.min(1, k));
      tone({ f0: 220 + 120 * p, f1: 90, dur: .07, vol: .05 + .1 * p });
    },
    /**
     * ★ **进球**：三音上行 + 一点噪声当"欢呼"（弹弹乐用；`game.js` 里调的就是它）。
     *
     * ⚠️ 这个方法**以前根本不存在** —— `game.js` 一直在调 `sfx?.goal?.()`，
     * 可选链让它静静地什么都不做，所以进球是**没有声音**的（用户实测"得分还没弄"就包括这条）。
     */
    goal() {
      [0, .1, .2].forEach((at, i) => tone({ type: 'triangle', f0: 660 + i * 160, f1: 880 + i * 180, dur: .16, vol: .17, at }));
      tone({ f0: 1320, f1: 1760, dur: .3, vol: .1, at: .3 });
      noise({ f0: 900, f1: 2800, dur: .55, vol: .09, attack: .05 });   // "哇——"那一片气声
    },
    /** ★ **失球（她被人进了）**：两音下行 + 一声闷的（不服气）。 */
    concede() {
      tone({ type: 'triangle', f0: 420, f1: 330, dur: .18, vol: .15 });
      tone({ type: 'triangle', f0: 330, f1: 220, dur: .3, vol: .13, at: .16, vib: 8, vibRate: 6 });
      tone({ f0: 150, f1: 90, dur: .2, vol: .1, at: .05 });
    },
    /** `n` = 连戳第几下：音高一级级往上走（1 = 普通一下；世界那边的连击最多 5 档）。 */
    poke(n = 1) { const k = Math.min(n, 6) - 1; tone({ f0: 320 + k * 55, f1: 200 + k * 40, dur: .09, vol: .16 }); },
    nod() { tone({ type: 'triangle', f0: 520, f1: 440, dur: .07, vol: .08 }); tone({ type: 'triangle', f0: 520, f1: 440, dur: .07, vol: .08, at: .2 }); },
    spin() { tone({ type: 'triangle', f0: 300, f1: 1200, dur: .3, vol: .12, vib: 30, vibRate: 18 }); },
    happy() { tone({ type: 'triangle', f0: 660, f1: 700, dur: .1, vol: .14 }); tone({ type: 'triangle', f0: 990, f1: 1050, dur: .14, vol: .14, at: .09 }); },
    wink() { tone({ f0: 1760, dur: .5, vol: .1 }); tone({ f0: 2637, dur: .45, vol: .06, at: .04 }); },
    love() { tone({ f0: 480, f1: 820, dur: .1, vol: .14 }); tone({ f0: 600, f1: 1000, dur: .12, vol: .14, at: .13 }); },
    surprised() { tone({ f0: 380, f1: 1500, dur: .2, vol: .16, vib: 15, vibRate: 12 }); },
    angry() { tone({ type: 'sawtooth', f0: 120, f1: 95, dur: .5, vol: .12, vib: 12, vibRate: 14, filter: 700 }); },
    sad() { tone({ type: 'triangle', f0: 440, f1: 392, dur: .3, vol: .13, vib: 8, vibRate: 6 }); tone({ type: 'triangle', f0: 392, f1: 262, dur: .55, vol: .13, at: .3, vib: 10, vibRate: 5 }); },
    shy() { tone({ f0: 1300, f1: 1600, dur: .07, vol: .07 }); tone({ f0: 1450, f1: 1750, dur: .07, vol: .06, at: .1 }); },
    expr(n) {
      const m = { happy: 'happy', wink: 'wink', love: 'love', surprised: 'surprised', angry: 'angry', sad: 'sad', shy: 'shy', sleepy: 'yawn' };
      if (m[n]) api[m[n]]();
    },
    tick() { tone({ f0: 1200, f1: 1000, dur: .03, vol: .05 }); },
    pop() { tone({ f0: 240, f1: 720, dur: .07, vol: .14 }); },
    sparkle() { [1568, 2093, 2637].forEach((fr, i) => tone({ f0: fr, dur: .25, vol: .06, at: i * .06 })); },
    select() { tone({ type: 'triangle', f0: 520, f1: 1040, dur: .1, vol: .12 }); },
    babble(ch) {
      const fr = 330 + (ch.codePointAt(0) % 9) * 28;
      tone({ type: 'square', f0: fr, f1: fr * R(.85, 1.1), dur: .05, vol: .05, filter: 1800 });
    },
    blub() { tone({ f0: R(500, 700), f1: R(900, 1200), dur: .05, vol: .05 }); },
    listenStart() { tone({ f0: 880, dur: .12, vol: .1 }); tone({ f0: 1320, dur: .16, vol: .1, at: .1 }); },
    listenEnd() { tone({ f0: 1320, dur: .1, vol: .09 }); tone({ f0: 990, dur: .16, vol: .09, at: .09 }); },
    /**
     * The pet's own voice, synthesized by the World (see the app's tts.cjs): the page gets WAV bytes
     * and plays them here. `decode` makes an AudioContext even while sounds are switched off — it is
     * the voice that decides whether to play, not this switch — and `playBuffer` is the one that
     * respects it.
     */
    async decode(bytes) {
      const c = context();
      if (!c) return null;
      try { return await c.decodeAudioData(bytes); } catch (e) { return null; }
    },
    async playBuffer(buf) {
      const c = ready();
      if (!c || !buf) return;
      if (c.state === 'suspended') await c.resume().catch(() => {});
      const g = c.createGain();
      g.gain.value = 1;
      g.connect(c.destination);
      const src = c.createBufferSource();
      src.buffer = buf;
      src.connect(g);
      src.start();
      return new Promise((r) => { src.onended = r; });
    },
  };
  for (const [kind, names] of Object.entries(SOUND_KINDS)) {
    for (const name of names) {
      const play = api[name];
      api[name] = (...args) => { if (!muted.has(kind)) play(...args); };
    }
  }
  return api;
}

/* ---------- actions the pet can be asked to do ---------- */
/** Expressions: a face held for a few seconds. */
export const EXPRESSIONS = ['neutral', 'happy', 'wink', 'love', 'shy', 'surprised', 'angry', 'sad', 'sleepy', 'thinking'];
/**
 * 动作（motions）的**唯一出处是 `pet-app.js` 的 `DUR` 表**（名字 → 持续秒数），
 * 服务端那边是 `pet.cjs` 注释里那份名单。上游原来在这里还导出一份 `MOTIONS` 数组，
 * 三处各写一遍、没有任何引用 —— 2026-10-08 清理时删掉，免得以后改动作只改一处。
 */
/** Body modes in which the figure travels across the stage or squashes fast. */
const MOVING_MODES = new Set(['drag', 'air', 'crouch', 'land', 'walk', 'run']);

/* ---------- the live pet: simulation, rendering, pointer ---------- */
/**
 * `els`: { svg, petG, shadowEl, fxG } inside a stage element that receives pointer events.
 * `opts.bounds()` returns { W, H, floorY, S } in stage pixels.
 * `opts.onEvent(kind, detail)` reports what happened to the body: arrived, interrupted, touch, mode.
 * `opts.enter: 'drop'` starts the pet above the top edge, falling to the floor.
 * `opts.figure`, when given, draws the body instead of the built-in one: `figure.draw(petG, face, frame)` keeps
 * its own elements inside `petG` (same logo space, feet at y=256). Its frame adds the face's name, the mode,
 * how long the mode has run, the talk level, drowsiness and how far the body sits.
 * `figure.groupTilt(mode, tilt, lean)`, if present, returns the rotation (degrees) the whole group gets
 * instead of tilt + lean; the frame carries tilt, lean and that rotation (groupRot) so the figure can bend the rest.
 * `figure.colors.z`, if present, colours the sleep z's (otherwise they take the skin's eye colour).
 */
export function createPet(els, opts) {
  const { petG, shadowEl, fxG } = els;
  /**
   * 粒子（爱心、眼泪、z、灰尘）写在 `fxG` 的**子层** `fxCore` 里，`fxG` 本身留给别的绘制者
   * （玩具球就画在 `fxG` 里的另一个子节点）。老调用方只给 `fxG` 时退化成直接用它自己。
   */
  const fxCore = fxG?.querySelector?.(':scope > #fxCore') || fxG;
  /** 上一帧写进 `#fx` 的那串 SVG（`#fx` 这个元素是页面里固定的，不会被换掉）。 */
  let lastFx = '';
  let custom = opts.figure || null;
  const sfx = opts.sfx;
  const onEvent = opts.onEvent || (() => {});
  let W = 0, H = 0, floorY = 0, S = .42, T = 0;
  let roam = opts.roam ?? 'free';
  let skin = opts.skin || defaultSkin();
  let hold = 0; // until T: an order from outside is in progress, free roaming waits
  const pet = {
    x: 260, fy: 0, vx: 0, vy: 0, facing: 1, faceVis: 1, mode: 'idle', modeT: 0, dur: 0, target: 0,
    speed: 0, stride: 0, lift: 0, bob: 0, phase: 0, lastHalf: 0, lean: 0, tilt: 0, tiltV: 0,
    sq: 0, sqv: 0, sitK: 0, stretch: 0, low: 0, gap: [50, 50], look: [0, 0], drowse: 0,
    feet: STAND.map(l => [l[2], l[3]]), blinkT: 1.5, blinkAge: 9, expr: null, exprUntil: 0,
    nextAt: 1.2, emitAt: 0, airKind: 'jump', turned: false, startle: false, lastAct: '',
    turnAcc: 0, dx: 0, dy: 0, jumpV: 700, jumpVx: 0, xf: null, blushK: 0,
    // 抓着哪儿拎起来的：局部抓点 + 悬挂角（页面按下时给，见 pointerDown / render）
    grabAt: null, grabHang: 0,
    eyeSig: '', eyeCur: null, eyePrev: null, eyeDims: [[16, 16, 0, 0], [16, 16, 0, 0]], swapAge: 9,
    glance: [0, 0], glanceAt: 0, swing: 0, swingV: 0, prevA: null, velX: 0, talkK: 0, sfxAt: 0, skid: false, cue: 0,
    pulse: null, walkId: 0, listening: false, thinking: false, placed: false,
  };
  const pointer = { x: -1e4, y: -1e4, inside: false, vx: 0, samples: [] };
  let press = null;
  /** 页面每 100ms 喂一次全屏光标位置（`setGaze`）——它不在这块窗口上时也能知道鼠标在哪儿。 */
  let gaze = null;
  /**
   * 心情（`setMood`）：**只影响步调**，不动任何判定。`cling` 是「黏着你」那一档的"够近了"门槛，
   * `speed` 是走路速度的倍率（开心走得快、困了慢吞吞）。默认值 = 老行为，所以没接心情时一模一样。
   */
  let mood = { cling: 170, speed: 1, energy: null };
  /**
   * 不说话的小动作（`setMicro`）：`tilt` 歪头、`step` 换重心。一个包络（0→1→0）走完就结束，
   * 结束时报一条 `micro` 回去（World 只在日志里用）。**它们只加姿态，不加表情、不出声**，
   * 所以跟"发呆""有卡举着""你在忙"都不冲突 —— 那些情况下照样能看到她是活的。
   */
  let microState = { kind: '', k: 0, t: 0, dur: 0 };
  /**
   * **比赛模式的跑速加成**（默认 1 = 平时一样）。见 `setRaceBoost`；只在弹弹乐里 > 1。
   */
  let raceBoost = 1;
  /** 绘制出错只上报一次（见下面 render 里的 try/catch）。 */
  let drawFailReported = false;

  /** 连戳计数：音高跟着升（世界那套连击是 2.5 秒一个窗口，这里跟它对齐）。 */
  let pokeStreak = 0, pokeAt = 0;
  const P = [];

  // points on the body in logo units: where the eyes look from, where tears, z's and hearts start, the bubble's spot
  const COO_ANCHORS = { gaze: [140, 117], tear: [166, 136], z: [196, 40], hearts: [90, 175, 34], bubble: [146, 0] };
  let A = { ...COO_ANCHORS, ...custom?.anchors };
  const minX = () => 104 * S + 8, maxX = () => W - 104 * S - 8;

  function resize() {
    const b = opts.bounds();
    W = b.W; H = b.H; floorY = b.floorY; S = b.S;
    if (!pet.placed && W > 0) {
      pet.x = opts.startX != null ? opts.startX : W * .7; pet.placed = true;
      if (opts.enter === 'drop') { pet.fy = -8; pet.vy = 0; pet.vx = 0; pet.airKind = 'drop'; setMode('air'); }
    }
    pet.x = clamp(pet.x, minX(), maxX());
    pet.target = clamp(pet.target, minX(), maxX());
    if (pet.mode !== 'air' && pet.mode !== 'drag') pet.fy = floorY;
  }

  function toStage(lx, ly) {
    const c = pet.xf;
    if (!c) return { x: pet.x, y: floorY };
    const x = (lx - c.ax) * c.kx, y = (ly - c.ay) * c.ky, r = c.rot * Math.PI / 180;
    return { x: c.AX + x * Math.cos(r) - y * Math.sin(r), y: c.AY + x * Math.sin(r) + y * Math.cos(r) };
  }
  /**
   * 命中测试：身体一个圆 + 下半身（裙子/腿/脚）一个圆。
   *
   * **为什么要两个**：身体那个圆半径 108（局部单位）、圆心 (128,128)，下沿只到 y≈236，
   * 而腿脚一直画到 y≈257 —— 所以**"点脚"根本按不到**（脚在圆心下方 120，超出去了）。
   * 想"抓着脚把它倒吊起来"就得先能点到脚。
   *
   * 注意这个函数同时决定**窗口什么时候接鼠标**（pet-app 的 `setInteractive`），
   * 所以两个圆都别放大——它决定了桌面上哪一小块不再穿透到后面的窗口。
   */
  function hitPet(p) {
    const c = toStage(128, 128);
    if (Math.hypot(p.x - c.x, p.y - c.y) < 108 * S) return true;
    const low = toStage(128, 232);
    return Math.hypot(p.x - low.x, p.y - low.y) < 62 * S;
  }

  function setMode(m, o = {}) {
    const prev = pet.mode;
    if ((prev === 'walk' || prev === 'run') && m !== 'idle' && pet.walkId) {
      onEvent('interrupted', { walkId: pet.walkId, x: Math.round(pet.x), by: m });
      pet.walkId = 0;
    }
    pet.mode = m; pet.modeT = 0; pet.turned = false; pet.startle = false; pet.skid = false; pet.cue = 0;
    Object.assign(pet, o);
    if (prev !== m) onEvent('mode', { mode: m });
  }
  const busy = () => pet.mode === 'drag' || pet.mode === 'air' || pet.mode === 'crouch';
  function pickTarget(minDist) {
    for (let i = 0; i < 12; i++) {
      const x = rnd(minX(), maxX());
      if (Math.abs(x - pet.x) > minDist) return x;
    }
    return pet.x - minX() > maxX() - pet.x ? minX() : maxX();
  }

  /** Runs a motion. Returns false when the body cannot take it now (in the air, being dragged). */
  function act(a) {
    if (busy()) return false;
    pet.expr = null; pet.lastAct = a;
    const seated = pet.mode === 'sleep' || pet.mode === 'sit';
    switch (a) {
      case 'stand': setMode(seated ? 'wake' : 'idle', seated ? { startle: false } : {}); pet.nextAt = T + 3; break;
      case 'walk': setMode('walk', { target: pickTarget(160) }); break;
      case 'run': setMode('run', { target: pet.x < W / 2 ? maxX() - rnd(0, 30) : minX() + rnd(0, 30) }); break;
      case 'jump': setMode('crouch', { jumpV: 720, jumpVx: pet.facing * 40 }); break;
      case 'hop': setMode('crouch', { jumpV: 480, jumpVx: 0 }); break;
      case 'look': setMode('look'); break;
      case 'turn': if (!seated) setMode('idle'); pet.facing *= -1; sfx.tick(); break;
      case 'nod': pulse('nod', .7); sfx.nod(); break;
      case 'shake': pulse('shake', .7); sfx.shake(); break;
      case 'spin': if (!seated) setMode('idle'); pulse('spin', .6); sfx.spin(); break;
      case 'sit': setMode('sit', { dur: 1e9 }); break;
      case 'sleep': setMode('sleep', { dur: 1e9 }); break;
      case 'dizzy': setMode('dizzy'); break;
      default: return false;
    }
    return true;
  }
  function pulse(kind, dur) { pet.pulse = { kind, t0: T, dur }; }

  function setExpr(n, seconds) {
    if (n === 'sleep') { act('sleep'); return; }
    if (busy()) return;
    if (n === 'dragged') {
      pet.expr = null;
      pet.vy = -1150; pet.vx = rnd(-120, 120); pet.airKind = 'throw'; pet.sqv -= 3;
      sfx.whoosh(); sfx.jump();
      setMode('air'); return;
    }
    if (n === 'dizzy') { pet.expr = null; setMode('dizzy'); return; }
    if (pet.mode === 'look' || pet.mode === 'land') setMode('idle');
    pet.expr = n; pet.exprUntil = T + (seconds ?? (n === 'sleepy' ? 4.4 : 3.2));
    pet.nextAt = Math.max(pet.nextAt, pet.exprUntil + .6);
    pet.sqv += n === 'surprised' ? -2.2 : .8;
    sfx.expr(n);
    if (n === 'love') for (let i = 0; i < 4; i++) emitHeart();
  }

  /** Walks (or runs) to stage x. Resolves the walk through onEvent('arrived' | 'interrupted'). */
  function walkTo(x, run, walkId) {
    if (busy()) return false;
    if (pet.mode === 'sleep' || pet.mode === 'sit') setMode('wake', { startle: true });
    const target = clamp(x, minX(), maxX());
    pet.expr = null;
    if (Math.abs(target - pet.x) < 2) { onEvent('arrived', { walkId, x: Math.round(pet.x) }); return true; }
    /**
     * ⚠️ **同一个方向上换目标时，不要重置移动模式**。
     *
     * 为什么要这一条：`setMode` 会把 `mt`（进入这个模式后的时间）清零，而跑步的起步斜坡是
     * `min(1, mt / .35)` —— 比赛里她每 260ms 就更新一次走位目标，
     * 每次都 `setMode('run')` 就把斜坡**永远按回起点**，速度卡在 45~80（走路级），
     * 实感就是"球在天上时她只会慢悠悠地走"（用户实测报的）。
     * 现在：目标还在同一侧（没跨过她）时，**只改 target、保留加速**。
     */
    const sameWay = (pet.mode === 'run' || pet.mode === 'walk')
      && Math.sign(target - pet.x) === Math.sign(pet.target - pet.x)
      && Math.abs(target - pet.x) > 2;
    if (sameWay) { pet.target = target; return true; }
    setMode(run ? 'run' : 'walk', { target, walkId });
    return true;
  }

  function faceName() {
    const m = pet.mode;
    if (m === 'drag') return 'dragged';
    if (m === 'air' && pet.airKind === 'throw') return pet.vy < 0 ? 'dragged' : 'surprised';
    if (m === 'air' && pet.airKind === 'drop') return 'surprised';
    if (m === 'dizzy') return pet.modeT < 2.4 ? 'dizzy' : 'squeeze';
    if (m === 'wake') return pet.startle ? 'surprised' : 'waking';
    if (pet.listening && m !== 'sleep') return 'listening';
    if (m === 'sleep') return 'sleep';
    if (pet.expr && T < pet.exprUntil) return pet.expr;
    if (pet.thinking) return 'thinking';
    if (m === 'sit') return 'content';
    if (m === 'run') return 'run';
    return 'neutral';
  }

  function decide() {
    const calm = roam === 'calm';
    const opts2 = [['walk', calm ? 10 : 28], ['run', calm ? 0 : 12], ['look', 14], ['jump', calm ? 2 : 8], ['sit', 16], ['expr', 12], ['wait', calm ? 30 : 10]]
      .filter(o => o[1] > 0 && (o[0] !== pet.lastAct || o[0] === 'wait'));
    let r = Math.random() * opts2.reduce((a, o) => a + o[1], 0), pick = 'wait';
    for (const o of opts2) { if ((r -= o[1]) < 0) { pick = o[0]; break; } }
    if (pick === 'look') { setMode('look'); pet.lastAct = 'look'; }
    else if (pick === 'expr') { setExpr(['happy', 'wink', 'love', 'sleepy', 'surprised', 'shy'][Math.floor(Math.random() * 6)]); pet.lastAct = 'expr'; }
    else if (pick === 'sit') { setMode('sit', { dur: rnd(6, 9) }); pet.lastAct = 'sit'; }
    else if (pick !== 'wait') act(pick);
    if (pet.mode === 'idle' && T >= pet.nextAt) pet.nextAt = T + rnd(2, 4);
  }

  /* particles */
  function emit(type, p, o = {}) { P.push({ type, x: p.x, y: p.y, vx: 0, vy: 0, age: 0, life: 1, ...o }); }
  function emitHeart() {
    emit('heart', toStage(rnd(A.hearts[0], A.hearts[1]), A.hearts[2] + pet.low), { vx: rnd(-20, 20), vy: rnd(-70, -45), life: 1.6 });
  }
  function dustAt(lx, n, spread) {
    for (let i = 0; i < n; i++) {
      emit('dust', toStage(lx, 250), { vx: rnd(-spread, spread) - pet.facing * rnd(10, 40), vy: rnd(-30, -8), life: rnd(.4, .65) });
    }
  }

  function step(dt) {
    T += dt; pet.modeT += dt;
    const m = pet.mode, mt = pet.modeT;
    let sqT = 0, strideT = 0, liftT = 0, leanT = 0, sitT = 0, bobT = 0, rate = 0, lookT = [0, 0], tiltT = 0;
    let tk = 160, tc = 12, drowseT = 0;
    const free = roam !== 'off' && T > hold && !opts.dialogOpen?.();

    pet.blinkT -= dt; pet.blinkAge += dt;
    if (pet.blinkT <= 0) { pet.blinkAge = 0; pet.blinkT = Math.random() < .2 ? .28 : rnd(2.2, 5.2); }

    const head = toStage(A.gaze[0], A.gaze[1]);
    // 看向哪儿：**页面喂进来的全屏光标**（每 100ms 一次）够近就盯着看，太远还是随机张望。
    //
    // 原来这里只在 `pointer.inside`（光标正好压在它身上）时才跟鼠标，而这个窗口是**点击穿透**的
    // ——换句话说"它看着我的鼠标"几乎永远看不到。现在光标在 260px 以内它就会看过来，
    // 这是"它注意到我了"最便宜的一半。
    const near = !!gaze && Math.hypot(gaze.x - head.x, gaze.y - head.y) < 260;
    const look = near ? gaze : pointer;
    const pdx = look.x - head.x, pdy = look.y - head.y, pm = Math.hypot(pdx, pdy) || 1;
    const track = () => {
      if (!near && !pointer.inside) {
        if (T > pet.glanceAt) { pet.glance = Math.random() < .45 ? [0, 0] : [rnd(-3, 5), rnd(-3, 3)]; pet.glanceAt = T + rnd(1.2, 3); }
        return pet.glance;
      }
      const k = Math.min(1, pm / 120);
      return [pdx * pet.facing / pm * 5 * k, pdy / pm * 4 * k];
    };

    /* ---------- 不说话的小动作：把包络往前推一格 ---------- */
    if (microState.kind) {
      microState.t += dt;
      const u = microState.t / microState.dur;
      if (u >= 1) {
        const done = microState.kind;
        microState = { kind: '', k: 0, t: 0, dur: 0 };
        onEvent('micro', { kind: done, x: Math.round(pet.x) });
      } else {
        // 0 → 1 → 0 的平滑包络（两头都是 0，所以做完自然回到原来的姿态，不用"复位"）
        microState.k = u < .5 ? u * 2 : (1 - u) * 2;
      }
    }
    const microK = microState.k;

    switch (m) {
      case 'idle': {
        lookT = track();
        // 往下瞟一眼（只用在这一个动作里，而且是在 track 之后，所以看得出"它低头看了下鼠标"）
        if (microState.kind === 'look') lookT = [lookT[0], lookT[1] + 3.4 * microK];
        if (pointer.inside && !press && pdx * pet.facing < -50 && pm < 600) {
          pet.turnAcc += dt;
          if (pet.turnAcc > .9) { pet.facing *= -1; pet.turnAcc = 0; }
        } else pet.turnAcc = 0;
        if (pet.listening) { lookT = [3, -4]; tiltT = -7; leanT = -2; }
        if (free && !pet.listening && T > pet.nextAt && !(pet.expr && T < pet.exprUntil)) {
          // 「黏着你」那一档（roam = 'cling'）：光标跑远了就走过去待着；离得近就照常自己发呆/走动。
          // 用的是页面喂进来的全屏光标（gaze），所以鼠标在别处它也知道。
          // **离多近算"够近了"由心情决定**（`mood.cling`：黏人 90px、想你 240px，见 mood.cjs）。
          if (roam === 'cling' && gaze && Math.abs(gaze.x - pet.x) > mood.cling) {
            pet.nextAt = T + rnd(2.5, 4.5) / mood.speed;
            walkTo(clamp(gaze.x - Math.sign(gaze.x - pet.x) * mood.cling * .4, minX(), maxX()), false, 0);
          } else decide();
        }
        break;
      }
      case 'walk': case 'run': {
        const run = m === 'run', d = pet.target - pet.x, dist = Math.abs(d), dir = Math.sign(d) || pet.facing;
        pet.facing = dir;
        /**
         * 快慢跟心情走，但**只有 ±10%**（`mood.speed`：开心 1.1 倍、困了 0.9 倍，见 mood.cjs）。
         * 幅度收这么小是有原因的：走路是每帧都看得见的量，缩放 `vMax` 时位移先变、步伐节奏
         * 后跟，差得多就像穿溜冰鞋。步伐的节奏是从
         * `pet.speed / vMax` 算出来的，所以缩放 `vMax` 一起变——不会出现"滑步"。
         *
         * ★ 另有 `raceBoost`：**只在弹弹乐比赛里**给她加一点跑速（`setRaceBoost`，页面在切模式时设）。
         * 用户实测"比分差距还是有点大"（`你27 : 她8`）时加的 —— 她 250px/s、球 300~700px/s，
         * 不给她一点速度就永远差一截。**非比赛模式必须是 1**（不然平时溜达会变快）。
         */
        const vMax = (run ? 250 * raceBoost : 78) * mood.speed;
        /**
         * 跑起来的**目标速度**有一个下限（`vMax` 的 65%）。
         *
         * ⚠️ 原来是 `run ? dist * 4 + 20 : …`：距离近时目标速度被压到很低
         * （距离 50px 时只有 220、距离 100px 时 250 才刚好满），
         * 再加上 `.35s` 的起步斜坡 —— 实感就是"**跑之前先慢速溜达几步**"（用户实测报的）。
         * 加了下限之后，只要距离够远就**一步到位用跑的**，最后再减速进站。
         */
        const vT = Math.min(vMax, run ? Math.max(dist * 4 + 20, vMax * .65) : dist * 3 + 14);
        // 动画节奏跟着"跑还是走"定（这几行别删：步伐长短、抬腿高度、身体前倾都靠它们）
        strideT = run ? 17 : 10; liftT = run ? 15 : 8; bobT = run ? 7 : 3; rate = run ? 4.4 : 2.1;
        leanT = run ? (dist < 50 && pet.speed > 120 ? -6 : 11) : 4;
        if (leanT < 0 && !pet.skid) { pet.skid = true; sfx.skid(); }
        /**
         * 起步斜坡：跑的时候**别从 0 开始**（地板 0.6）。
         * 斜坡本来是为了"起步有个加速过程"，但比赛里目标一变就可能重启斜坡，
         * 从 0 开始就会看到她"慢慢地起步"—— 给个地板，起步直接是走路的 1.5 倍以上。
         */
        const ramp = Math.min(1, mt / (run ? .35 : .25));
        const k0 = run ? .6 + .4 * smooth(ramp) : smooth(ramp);
        pet.speed = lerp(pet.speed, vT * k0, ease(run ? 6 : 9, dt));
        pet.x += dir * Math.min(dist, pet.speed * dt);
        const k = clamp(pet.speed / vMax, 0, 1);
        strideT *= .4 + .6 * k; liftT *= .4 + .6 * k;
        pet.phase += Math.PI * 2 * rate * dt * Math.max(.35, k);
        lookT = [run ? 4 : 3, run ? 1 : 0];
        const half = Math.floor(pet.phase / Math.PI);
        if (half !== pet.lastHalf) {
          sfx.step(run, half & 1);
          if (run && pet.speed > 120) dustAt(128, dist < 50 ? 3 : 1, 20);
        }
        pet.lastHalf = half;
        if (dist < 1.5) {
          pet.speed = 0;
          const id = pet.walkId; pet.walkId = 0;
          setMode('idle'); pet.nextAt = T + rnd(1.2, 3.2);
          if (id) onEvent('arrived', { walkId: id, x: Math.round(pet.x) });
        }
        break;
      }
      case 'look': {
        if (!pet.cue) { pet.cue = 1; sfx.hmm(); }
        if (mt < .9) lookT = [4, -4];
        else if (mt < 1.8) { if (!pet.turned) { pet.turned = true; pet.facing *= -1; } lookT = [5, 0]; }
        else if (mt < 2.6) lookT = [1, 4];
        else { setMode('idle'); pet.nextAt = T + rnd(1, 2.5); }
        break;
      }
      case 'sit': {
        sitT = 1;
        lookT = track().map(v => v * (1 - pet.drowse));
        if (pet.listening) { lookT = [3, -4]; tiltT = -7; }
        drowseT = clamp((mt - 1.5) / Math.max(1, Math.min(pet.dur, 60) - 1.5), 0, free ? 1 : .45);
        if (pet.drowse > .5) leanT = 7 * pet.drowse * Math.pow(Math.max(0, Math.sin(T * 1.3)), 6);
        if (free && mt > pet.dur) {
          if (Math.random() < .6) setMode('sleep', { dur: rnd(8, 12) });
          else { setMode('idle'); pet.sqv -= 1.2; pet.nextAt = T + rnd(1.5, 3); }
        }
        break;
      }
      case 'sleep': {
        sitT = 1; drowseT = 1; leanT = 5;
        if (free && mt > pet.dur) setMode('wake');
        break;
      }
      case 'wake': {
        if (pet.startle) {
          sitT = 0; lookT = [3, -2];
          if (mt > .9) { setMode('idle'); pet.nextAt = T + rnd(1.5, 3); }
        } else {
          sitT = mt < 1.1 ? 1 : 0;
          if (mt > .5 && !pet.cue) { pet.cue = 1; sfx.yawn(); }
          sqT = mt > .5 && mt < 1.3 ? -.1 : 0;
          leanT = mt < .5 ? 5 : mt < 1.2 ? -5 : 0;
          lookT = mt > 1.2 ? track() : [0, 0];
          if (mt > 1.8) { setMode('idle'); pet.nextAt = T + rnd(1, 2); }
        }
        break;
      }
      case 'crouch': {
        sqT = .24; sitT = .3;
        if (mt > .16) {
          pet.vy = -pet.jumpV; pet.vx = pet.jumpVx; pet.airKind = 'jump'; pet.sqv -= 2.6;
          sfx.jump();
          setMode('air');
        }
        break;
      }
      case 'air': {
        pet.vy += 2300 * dt;
        pet.vx *= Math.exp(-dt * .4);
        pet.x += pet.vx * dt; pet.fy += pet.vy * dt;
        if (pet.x < minX()) { pet.x = minX(); pet.vx = Math.abs(pet.vx) * .55; pet.sqv += .6; }
        if (pet.x > maxX()) { pet.x = maxX(); pet.vx = -Math.abs(pet.vx) * .55; pet.sqv += .6; }
        if (pet.fy - 250 * S < 0 && pet.vy < 0) { pet.fy = 250 * S; pet.vy = Math.abs(pet.vy) * .3; }
        sqT = -Math.min(.12, Math.abs(pet.vy) / 6000);
        tiltT = clamp(pet.vx * .025, -30, 30);
        tk = 70; tc = 8;
        if (pet.fy >= floorY && pet.vy > 0) land();
        break;
      }
      case 'land': {
        sitT = .35 * (1 - smooth(clamp(mt / .35, 0, 1)));
        lookT = [2, 2];
        if (mt > .4) setMode('idle');
        break;
      }
      case 'dizzy': {
        sitT = mt < 2.6 ? 1 : 0;
        if (mt < 2.4 && T > pet.sfxAt) { sfx.chirps(); pet.sfxAt = T + .9; }
        if (mt >= 2.4 && !pet.cue) { pet.cue = 1; sfx.shake(); }
        if (mt < 2.4) tiltT = 8 * Math.sin(T * 4.5) * Math.min(1, mt * 2);
        else if (mt < 3) { const k = (mt - 2.4) / .6; tiltT = 12 * Math.sin(mt * 34) * (1 - k); }
        else { setMode('idle'); pet.sqv -= 1; pet.nextAt = T + rnd(1.5, 3); }
        break;
      }
      case 'drag': {
        pet.dx = lerp(pet.dx, pointer.x, ease(28, dt));
        // 别让身体被拖到地板下面去：把几个"最外沿"的关键点按**当前倾斜角**转一下，
        // 取最大的 y 偏移 = 锚点下面到底有多深，就留多少余量。
        // （原来写死的是 245*S，那只对"拎后颈、竖直垂着"成立；躺平/倒吊时最低点换成了别的部件，
        //   比如抓尾巴躺平时最靠下的是外侧的鳍，抓脚倒吊时是头。）
        const anchorY = pet.grabAt ? pet.grabAt.y : SCRUFF_GRAB.y;
        const anchorX = pet.grabAt ? pet.grabAt.x : SCRUFF_GRAB.x;
        const rr = pet.tilt * Math.PI / 180;
        const span = [[128, 18], [128, 256], [24, 192], [207, 123], [114, 20]]
          .reduce((deep, [lx, ly]) => Math.max(deep, (lx - anchorX) * Math.sin(rr) + (ly - anchorY) * Math.cos(rr)), 60);
        pet.dy = lerp(pet.dy, Math.min(pointer.y, floorY - (span * S + 4)), ease(28, dt));
        // 悬挂角 = 按部位给的静态角 + 拖动速度带来的摆动（原来只有速度那一半）
        // 悬挂角 = 按部位给的静态角 + 拖动速度带来的摆动。
        //
        // **静态角要乘朝向**（`pet.faceVis`，±1）：这具身体是会左右镜像的（`kx = S * faceVis`），
        // 而 rot 是**屏幕空间**的旋转——镜像之后再转同一个方向，结果正好相反。
        // 实测（用户报的）：**朝左看**时抓尾巴，本来该"整个人挂到锚点下方"，结果被甩到**上面**去了。
        // 速度那一项是"被拖着走时身体往后掉队"，是屏幕空间的物理，**不跟着翻**。
        tiltT = clamp(pointer.vx * .035, -40, 40) + pet.grabHang * pet.faceVis; tk = 90; tc = 5;
        if (Math.abs(pointer.vx) > 500 && T > pet.sfxAt) { sfx.squeak(); pet.sfxAt = T + rnd(.4, .7); }
        break;
      }
    }

    // short gestures layered over whatever the body is doing
    if (pet.pulse) {
      const k = (T - pet.pulse.t0) / pet.pulse.dur;
      if (k >= 1) pet.pulse = null;
      else if (pet.pulse.kind === 'nod') leanT += 9 * Math.abs(Math.sin(k * Math.PI * 2));
      else if (pet.pulse.kind === 'shake') tiltT += 10 * Math.sin(k * Math.PI * 6) * (1 - k);
      else if (pet.pulse.kind === 'spin' && k > .5 && !pet.pulse.flipped) { pet.pulse.flipped = true; pet.facing *= -1; }
      else if (pet.pulse.kind === 'spin' && k < .5 && !pet.pulse.first) { pet.pulse.first = true; pet.facing *= -1; pet.sqv -= 1; }
    }

    const fname = faceName(), fc = FACES[fname].f(T, pet);
    if (fc.lookLock || pet.mode === 'sleep' || pet.mode === 'drag') lookT = [0, 0];

    // eye shape changes hide under a quick blink; same-shape changes (ring size) ease
    const sig = fc.eyes.map(e => e.shape).join();
    if (sig !== pet.eyeSig) {
      if (pet.eyeCur) { pet.eyePrev = pet.eyeCur; pet.swapAge = 0; }
      pet.eyeSig = sig;
      fc.eyes.forEach((e, i) => { pet.eyeDims[i] = [e.rx ?? 16, e.ry ?? 16, e.dx || 0, e.dy || 0]; });
    }
    pet.swapAge += dt;
    pet.eyeCur = fc.eyes.map((e, i) => {
      if (e.shape !== 'ring' && e.shape !== 'lid') return e;
      const d = pet.eyeDims[i], tgt = [e.rx ?? 16, e.ry ?? 16, e.dx || 0, e.dy || 0];
      for (let j = 0; j < 4; j++) d[j] = lerp(d[j], tgt[j], ease(16, dt));
      return { ...e, rx: d[0], ry: d[1], dx: d[2], dy: d[3] };
    });
    pet.blushK = lerp(pet.blushK, fc.blush || 0, ease(6, dt));

    // springs & easing
    pet.sqv += ((sqT - pet.sq) * 280 - pet.sqv * 14) * dt;
    pet.sq = clamp(pet.sq + pet.sqv * dt, -.35, .45);
    pet.tiltV += ((tiltT - pet.tilt) * tk - pet.tiltV * tc) * dt;
    pet.tilt += pet.tiltV * dt;
    pet.lean = lerp(pet.lean, leanT, ease(7, dt));
    pet.sitK = lerp(pet.sitK, sitT, ease(m === 'land' ? 18 : 6, dt));
    pet.drowse = lerp(pet.drowse, drowseT, ease(m === 'sit' || m === 'sleep' ? 1.5 : 6, dt));
    // 拎起来会纵向拉长（原来是固定的 9%）。挂得越"横"（尾巴 100°、脚 165°）拉得越长——
    // 这一拉是**沿身体轴线**的，所以身体躺平/倒吊时看起来就是"被拽长了"。
    pet.stretch = lerp(pet.stretch, m === 'drag' ? 1 + Math.abs(pet.grabHang) / 240 : 0, ease(8, dt));
    pet.stride = lerp(pet.stride, strideT, ease(10, dt));
    pet.lift = lerp(pet.lift, liftT, ease(10, dt));
    pet.bob = lerp(pet.bob, bobT, ease(10, dt));
    pet.look[0] = lerp(pet.look[0], lookT[0], ease(9, dt));
    pet.look[1] = lerp(pet.look[1], lookT[1], ease(9, dt));
    pet.gap[0] = lerp(pet.gap[0], fc.gap[0], ease(8, dt));
    pet.gap[1] = lerp(pet.gap[1], fc.gap[1], ease(8, dt));
    // turning reads as a quick card flip rather than a mirror snap
    pet.faceVis = lerp(pet.faceVis, pet.facing, ease(15, dt));
    if (m !== 'walk' && m !== 'run') pet.phase = lerp(pet.phase, Math.round(pet.phase / Math.PI) * Math.PI, ease(6, dt));
    pointer.vx *= Math.exp(-dt * 6);

    // secondary motion for ears/antenna/scarf: lags behind horizontal movement
    const AX = pet.mode === 'drag' ? pet.dx : pet.x;
    if (pet.prevA != null) pet.velX = lerp(pet.velX, (AX - pet.prevA) / dt, .25);
    pet.prevA = AX;
    const swingT = clamp(-pet.velX * .06 * Math.sign(pet.faceVis || 1), -28, 28);
    pet.swingV += ((swingT - pet.swing) * 110 - pet.swingV * 7) * dt;
    pet.swing = clamp(pet.swing + pet.swingV * dt, -40, 40);

    pet.low = pet.sitK * 29 + pet.bob * Math.abs(Math.sin(pet.phase));
    pet.feet.forEach((ft, i) => {
      const hx = HIPS[i][0], hy = HIPS[i][1] + pet.low;
      let tx, ty;
      if (m === 'drag') { tx = hx + 7 * Math.sin(T * 11 + i * 2.2); ty = hy + 36; }
      else if (m === 'air') { tx = hx + (i ? 9 : -9); ty = hy + 33; }
      else {
        const ph = pet.phase + i * Math.PI;
        const sx = hx + pet.stride * Math.sin(ph), sy = FOOT_Y - pet.lift * Math.max(0, Math.cos(ph));
        tx = lerp(sx, hx + 26, pet.sitK); ty = lerp(sy, FOOT_Y, pet.sitK);
      }
      const r = m === 'drag' || m === 'air' ? 14 : 40;
      ft[0] = lerp(ft[0], tx, ease(r, dt)); ft[1] = lerp(ft[1], ty, ease(r, dt));
    });

    if (fc.emit && T > pet.emitAt) {
      if (fc.emit === 'heart') { emitHeart(); pet.emitAt = T + .45; }
      if (fc.emit === 'z') { emit('z', toStage(A.z[0], A.z[1] + pet.low), { vx: pet.facing * 16, vy: -26, life: 2.4 }); pet.emitAt = T + 1.3; sfx.snore(pet.modeT); }
      if (fc.emit === 'tear') { emit('drop', toStage(A.tear[0] + pet.look[0], A.tear[1] + pet.low), { vx: pet.facing * rnd(10, 30), vy: -20, life: 3 }); pet.emitAt = T + .8; }
    }

    for (let i = P.length - 1; i >= 0; i--) {
      const p = P[i];
      p.age += dt; p.x += p.vx * dt; p.y += p.vy * dt;
      if (p.type === 'drop') { p.vy += 900 * dt; if (p.y > floorY) p.age = p.life; }
      if (p.type === 'dust') p.vx *= Math.exp(-dt * 4);
      if (p.age >= p.life) P.splice(i, 1);
    }
    pet.talkK *= Math.exp(-dt * 12);
    pet._fc = fc; pet._fname = fname;
  }

  function land() {
    const impact = pet.vy, kind = pet.airKind;
    pet.fy = floorY; pet.vy = 0; pet.vx = 0;
    pet.sqv += clamp(impact * .0024, .8, 4.5);
    sfx.land(kind !== 'jump' && impact > 1000);
    dustAt(128, impact > 900 ? 7 : 3, 70);
    if (kind === 'throw' && impact > 1000) { setMode('dizzy'); onEvent('touch', { kind: 'crash' }); return; }
    setMode('land');
    if (kind === 'throw') { pet.expr = 'surprised'; pet.exprUntil = T + .9; pet.nextAt = T + 2; }
    else if (kind === 'drop') { pet.expr = 'happy'; pet.exprUntil = T + 1.6; pet.nextAt = T + 2.6; }
    else pet.nextAt = T + rnd(.8, 2);
  }

  function render() {
    const fc = pet._fc || FACES.neutral.f(0), fname = pet._fname || 'neutral';
    const drag = pet.mode === 'drag';
    const br = Math.sin(T * (pet.mode === 'sleep' ? 1.7 : 2.4));
    const sx = (1 + pet.sq * .7) * (1 - .05 * pet.stretch) * (1 - .009 * br);
    const sy = (1 - pet.sq) * (1 + .09 * pet.stretch) * (1 + .016 * br);
    // 拎起来的支点：**抓点**（抓哪儿就从哪儿拎），没抓着就是原来那套（站立时脚底 (128,256)）
    const grab = drag ? (pet.grabAt || SCRUFF_GRAB) : null;
    const ax = grab ? grab.x : 128, ay = grab ? grab.y : 256;
    let AX = drag ? pet.dx : pet.x, AY = drag ? pet.dy : pet.fy;
    if (fc.shake) AX += Math.sin(T * 60) * 1.4;
    // a custom figure may keep tilt and lean off the whole group and bend its own parts instead
    const kx = S * pet.faceVis * sx, ky = S * sy, lean = pet.lean * pet.faceVis;
    const rot = custom?.groupTilt ? custom.groupTilt(pet.mode, pet.tilt, lean) : pet.tilt + lean;
    pet.xf = { AX, AY, ax, ay, kx, ky, rot };
    petG.setAttribute('transform', `translate(${f(AX)} ${f(AY)}) rotate(${f(rot)}) scale(${kx.toFixed(4)} ${ky.toFixed(4)}) translate(${-ax} ${-ay})`);

    const legs = pet.feet.map((ft, i) => [HIPS[i][0], HIPS[i][1] + pet.low, ft[0], ft[1]]);
    const blink = pet.blinkAge < .16 ? Math.sin(Math.PI * pet.blinkAge / .16) : 0;
    let eyes = pet.eyeCur || fc.eyes, eyeClose = 0;
    if (pet.swapAge < .07 && pet.eyePrev) { eyes = pet.eyePrev; eyeClose = pet.swapAge / .07; }
    else if (pet.swapAge < .16) eyeClose = 1 - (pet.swapAge - .07) / .09;
    const face = { ...fc, eyes, gap: pet.gap.map(g => Math.min(64, g + pet.talkK * 12)), blush: pet.blushK };
    const frame = {
      look: pet.look, legs, low: pet.low, t: T, blink, eyeClose, acc: skin, swing: pet.swing,
      // 心情：`accMood` 给 figure.js 调呼吸的深浅与节奏（`null` = 没有这一层，行为同上游）。
      // **单独一个字段**，不塞进 `skin`：`skin` 是"她穿什么"，心情是"她此刻什么状态"。
      accMood: mood.energy === null ? null : { energy: mood.energy },
      // ⚠️ **必须用 `microState.k`，不能写 `microK`**：后者是 `step()` 里的局部变量，
      // 在 `render()` 里根本不存在 —— 写成 microK 会让 render 每一帧抛 ReferenceError，
      // 而 render 是在帧循环里调的，**一抛就把整条帧循环打死**：她停在最后一帧、
      // 不再动、也不再接鼠标（实测踩过：坐着一动不动、点也没反应）。
      microTilt: microState.kind === 'tilt' ? 8.5 * microState.k : 0,
      microStep: microState.kind === 'step' ? microState.k : 0,
    };
    if (custom) {
      /**
       * 绘制**必须有兜底**：她画不出来时，症状是"窗口在、日志正常、屏幕上什么都没有"，
       * 一点线索都没有（页面的异常也不会自己冒出来）。所以出一次错就通过 `petHost.sampleBackdrop`
       * 那条现成的通道把消息送到主进程（`pet-host.cjs` 会写进 `data\pet-host.log`），
       * 而且**只报一次**，不会刷屏。
       */
      try {
        custom.draw(petG, face, { ...frame, face: fname, mode: pet.mode, modeT: pet.modeT, talk: pet.talkK, drowse: pet.drowse, sit: pet.sitK, facing: pet.faceVis, tilt: pet.tilt, lean, groupRot: rot });
      } catch (err) {
        if (!drawFailReported) {
          drawFailReported = true;
          try { window.petHost?.report?.(`绘制她的身体时出错：${err && (err.stack || err.message)}`); } catch { /* 报告本身失败就算了 */ }
        }
      }
    } else petG.innerHTML = figure(face, frame);

    // 阴影量的是"脚底离地多高"。原来写的是 `pet.dy + 220*S*1.09`（220 = 后颈到脚底），
    // 那只对"拎后颈"成立；现在是抓哪儿算哪儿 —— 直接问变换：脚底此刻在屏幕上的哪儿。
    const footY = drag ? toStage(128, 256).y : pet.fy;
    const k = clamp(1 - (floorY - footY) / 420, .3, 1);
    shadowEl.setAttribute('cx', f(AX)); shadowEl.setAttribute('cy', f(floorY - 2));
    shadowEl.setAttribute('rx', f(72 * S * k * (1 + pet.sq * .5))); shadowEl.setAttribute('ry', f(10 * S * k + 1));
    shadowEl.setAttribute('opacity', f(k));

    let s = '';
    const sc = S / .48;
    // sleep z's take the eye colour, or the custom figure's own colour for them
    const zPaint = custom?.colors?.z ? `stroke="${custom.colors.z}"` : 'class="eye"';
    for (const p of P) {
      const a = p.age / p.life;
      if (p.type === 'z') {
        const op = a < .15 ? a / .15 : 1 - (a - .15) / .85, z = (.7 + .9 * a) * sc;
        s += `<path ${zPaint} fill="none" stroke-width="${f(3 / z)}" stroke-linecap="round" stroke-linejoin="round" opacity="${f(op)}" transform="translate(${f(p.x + Math.sin(p.age * 2.5) * 6)} ${f(p.y)}) scale(${f(z)})" d="M-6 -7H6L-6 7H6"/>`;
      } else if (p.type === 'heart') {
        s += `<path class="p-heart" fill="none" stroke-width="5" stroke-linejoin="round" opacity="${f(1 - a * a)}" transform="translate(${f(p.x + Math.sin(p.age * 4) * 5)} ${f(p.y)}) scale(${f((.45 + .35 * a) * sc)})" d="${heartD(0, 0, 1)}"/>`;
      } else if (p.type === 'dust') {
        s += `<circle class="p-dust" fill="none" stroke-width="2" cx="${f(p.x)}" cy="${f(p.y)}" r="${f((3 + 8 * a) * sc)}" opacity="${f(.7 * (1 - a))}"/>`;
      } else if (p.type === 'drop') {
        s += `<path class="tearf" transform="translate(${f(p.x)} ${f(p.y)}) scale(${f(.9 * sc)})" d="${DROP}"/>`;
      }
    }
    // 没有粒子时 `s` 是空串：**别每帧都写一次 innerHTML**（那是每帧一次 DOM 解析 + 布局失效）。
    // 同一个缓存手法在 `whale/figure.js` 的 drawFx 里已经有了，这里原来漏了。
    //
    // ⚠️ **只写 `fxCore` 那一层，绝不写 `#fx` 本身**：`innerHTML = …` 会把那个元素里的
    // **所有子节点换掉**，而玩具球（`web/ball.js`）画的是 `#fx` 里的另一个子节点 ——
    // 实测症状就是"球开了但看不见"（球刚画上就被这一行抹掉；它是脏检查，所以偶尔才闪一下）。
    // 以后再有"画进 #fx 的新东西"，请同样放进自己的子节点，别让任何人重写 `#fx`。
    if (s !== lastFx) { fxCore.innerHTML = s; lastFx = s; }
    return fname;
  }

  /* pointer: stage-pixel coordinates */
  function velocity() {
    const s = pointer.samples;
    if (s.length < 2) return { x: 0, y: 0 };
    const a = s[0], b = s[s.length - 1], dt = Math.max(.016, (b.t - a.t) / 1000);
    return { x: (b.x - a.x) / dt, y: (b.y - a.y) / dt };
  }
  /**
   * `opts.grab` 是页面算好的"抓哪儿"：`{ x, y, hang }` —— **局部坐标**的抓点，加上拎起来时的
   * 静态悬挂角（度，正=顺时针）。不传就是老行为：后颈 (128,36)、不倾斜。
   * 局部坐标就是 `toStage(128,128)` 那套（脚底中点是 (128,256)），跟 whale\model.json 的 pivots 同空间。
   */
  function pointerDown(p, opts = {}) {
    Object.assign(pointer, p, { inside: true });
    if (!hitPet(p) || pet.mode === 'air') return false;
    press = { x: p.x, y: p.y, t: performance.now(), grab: opts.grab || null };
    pointer.samples = [{ t: performance.now(), x: p.x, y: p.y }];
    return true;
  }
  /** Returns the cursor the stage should show. */
  function pointerMove(p) {
    const now = performance.now();
    Object.assign(pointer, p, { inside: true });
    pointer.samples.push({ t: now, x: p.x, y: p.y });
    while (pointer.samples.length > 2 && now - pointer.samples[0].t > 110) pointer.samples.shift();
    pointer.vx = lerp(pointer.vx, velocity().x, .35);

    if (press && pet.mode !== 'drag' && Math.hypot(p.x - press.x, p.y - press.y) > 6) {
      // **抓哪儿就从哪儿拎**：用页面按下时算好的局部抓点（没传就还是后颈，跟以前一样）。
      // 抓点会一直贴在光标上（见 render 的 ax/ay），所以"捏着左手"就一直捏着左手。
      const g = press.grab || SCRUFF_GRAB;
      const held = toStage(g.x, g.y);
      pet.grabAt = { x: g.x, y: g.y };
      pet.grabHang = g.hang || 0;
      pet.expr = null;
      setMode('drag', { dx: held.x, dy: held.y });
      sfx.grab();
      pet.sqv -= 1.2; pet.tiltV = 0;
      onEvent('touch', { kind: 'grab' });
    }
    if (press) return 'grabbing';
    const over = hitPet(p);
    // **"蹭"的判定不在这里，别再搬回来。**
    // 上游那套（累计位移 `strokeAcc > 320` 才反应一次，而且累计值每帧按 `exp(-dt*1.5)` 衰减）
    // 实测人手舒服的 0.5–1.5Hz 抚摸**永远触发不了**，要每秒来回搓三次才行。
    // 现在整段判定在 `web\pet-app.js` 的 STROKE 引擎里（往复判定 + 连续反馈 + 三段递进 +
    // 睡着时"做梦"那条），这里只保留命中判定（它同时决定窗口什么时候接鼠标）。
    // 两套一起跑过：一次抚摸会发出**两条** touch（一条没有 `stage`）、呼噜响两遍、
    // 表情互相覆盖，World 那边还会多记一次互动（多涨好感、提前把选择卡问出来）。
    return over ? 'grab' : '';
  }
  function pointerUp() {
    if (!press) return;
    if (pet.mode === 'drag') {
      // hand over from the scruff anchor to the feet anchor without a visual jump
      const foot = toStage(128, 256);
      const v = velocity();
      pet.x = clamp(foot.x, minX(), maxX());
      pet.fy = Math.min(floorY, foot.y);
      pet.vx = clamp(v.x, -1800, 1800); pet.vy = clamp(v.y, -1800, 1400);
      pet.airKind = 'throw';
      const speed = Math.hypot(v.x, v.y);
      if (speed > 700) sfx.whoosh();
      setMode('air');
      onEvent('touch', { kind: speed > 700 ? 'throw' : 'drop', x: Math.round(pet.x) });
    } else if (performance.now() - press.t < 400) {
      if (pet.mode === 'sleep' || pet.mode === 'sit') {
        const wasAsleep = pet.mode === 'sleep';
        setMode('wake', { startle: true }); pet.sqv -= 2.2; pet.nextAt = T + 2.4;
        sfx.surprised();
        onEvent('touch', { kind: 'poke', woke: wasAsleep });
      } else if (pet.mode !== 'dizzy') {
        // 连戳的音高一级级往上走（窗口跟世界那套连击对齐：2.5 秒）
        const at = performance.now();
        pokeStreak = at - pokeAt < 2500 ? pokeStreak + 1 : 1;
        pokeAt = at;
        sfx.poke(pokeStreak);
        const r = ['happy', 'wink', 'surprised', 'love', 'angry'][Math.floor(Math.random() * 5)];
        setExpr(r);
        if (Math.random() < .5 && pet.mode === 'idle') setMode('crouch', { jumpV: 480, jumpVx: 0 });
        onEvent('touch', { kind: 'poke' });
      }
    }
    press = null;
  }
  /**
   * Ends a drag with the body dropped from under stage point `p` with no throw: the pointer was let
   * go of on another display and the stage now covers that one. Call after `resize()` has taken the
   * new size.
   */
  function dropAt(p) {
    press = null;
    if (pet.mode !== 'drag') return;
    Object.assign(pointer, p, { vx: 0, samples: [] });
    pet.x = clamp(p.x, minX(), maxX());
    pet.fy = Math.min(floorY, p.y + 220 * S);
    pet.vx = 0; pet.vy = 0;
    pet.airKind = 'drop';
    setMode('air');
    onEvent('touch', { kind: 'drop', x: Math.round(pet.x) });
  }
  /**
   * Keeps a held body under the pointer when the stage moved to another display mid-drag: every
   * point on screen now sits (dx, dy) stage pixels from where it was.
   */
  function shiftDrag(dx, dy) {
    if (pet.mode !== 'drag') return;
    pet.dx += dx; pet.dy += dy; pet.x += dx;
    pointer.x += dx; pointer.y += dy;
    for (const s of pointer.samples) { s.x += dx; s.y += dy; }
    if (press) { press.x += dx; press.y += dy; }
  }
  function pointerLeave() { if (!press) pointer.inside = false; }

  resize();
  return {
    pet, step, render, resize, act, setExpr, walkTo, toStage, hitPet, busy,
    pointerDown, pointerMove, pointerUp, pointerLeave, dropAt, shiftDrag,
    get pressing() { return !!press; },
    /** Pressed, carried, airborne, walking, running, turning round, or in a nod, shake or spin: motion that frames far apart show as jumps. */
    get moving() {
      return !!press || MOVING_MODES.has(pet.mode) || !!pet.pulse || Math.abs(pet.faceVis - pet.facing) > .05;
    },
    get time() { return T; },
    get bounds() { return { W, H, floorY, S, minX: minX(), maxX: maxX() }; },
    /**
     * 她站在哪儿、朝哪边、脚底在什么高度（**只读**）。
     * 玩具球与弹弹乐（`web/ball.js` / `web/game.js`）用它算碰撞：
     * 球砸到她身上就被踢出去；**她跳起来时头顶那一片也能顶球**（`feetY` 用来判断腾空）。
     * 只暴露这三个数，**不暴露可写句柄**，免得外面的模块把她搬走。
     */
    get where() { return { x: pet.x, faceVis: pet.faceVis, feetY: pet.fy }; },
    /**
     * 只读：她当前的移动模式与速度（`mode` 是 `walk` / `run` / …，`speed` 是 px/s）。
     * 弹弹乐用它做诊断："球在天上时她是不是只在走（`walk`）而不是跑（`run`）"。
     */
    /**
     * 只读：她当前的移动模式、速度、目标，**以及脚底的位置**（`feetY`）。
     * 弹弹乐用 `feetY` 做头球的几何诊断："她跳起来了却顶不到球"时，
     * 必须把"她的头箱"和"球箱"摆在一起算，才知道是跳晚了还是盒子错开了。
     */
    get move() { return { mode: pet.mode, speed: pet.speed, target: pet.target, feetY: pet.fy }; },
    setSkin(s) { skin = s; },
    /** Swaps the body's drawing: a custom figure (see `opts.figure`) or null for the built-in Coo. */
    setFigure(fig) {
      if (fig === custom) return;
      // a swapped-out figure may hold a WebGL context; release it now instead of waiting for GC
      custom?.dispose?.();
      custom = fig || null;
      A = { ...COO_ANCHORS, ...custom?.anchors };
      petG.textContent = '';
      render();
    },
    get figure() { return custom; },
    get skin() { return skin; },
    setRoam(r) { roam = r; if (r !== 'off') pet.nextAt = T + 1; },
    get roam() { return roam; },
    /** Outside orders keep free roaming quiet for `seconds`. */
    holdRoam(seconds) { hold = Math.max(hold, T + seconds); },
    /**
     * **比赛模式的跑速加成**（1 = 平时；弹弹乐里给她 1.1~1.15）。
     * 页面在切模式时设（见 `pet-app.js` 的 `setBallMode`）——**离开比赛一定要设回 1**。
     */
    setRaceBoost(k) { raceBoost = Math.max(1, Math.min(1.6, Number(k) || 1)); return raceBoost; },
    get raceBoost() { return raceBoost; },
    talk() { pet.talkK = 1; },
    setListening(on) { pet.listening = on; if (on && (pet.mode === 'walk' || pet.mode === 'run')) setMode('idle'); },
    setThinking(on) { pet.thinking = on; },
    /**
     * 页面每 100ms 喂进来的**全屏**光标位置（`null` = 不知道 / 不在窗口上）。
     * 它靠这个"看着你的鼠标"，也让「黏着你」那一档知道该往哪儿走。
     * 注意别拿它当 `pointerDown/Move` 那套用：那个是"手真的在它身上"。
     */
    setGaze(p) { gaze = p && typeof p.x === 'number' && typeof p.y === 'number' ? { x: p.x, y: p.y } : null; },
    /**
     * 心情（`mood.cjs` 那一层推出来的快照，见 pet.cjs 的 `stepMood`）。
     * 只有两个数有用：`cling` 决定「黏着你」离你多近才算"已经在旁边"，`speed` 决定走路快慢。
     * 传空/坏值就回到默认（等于没有心情这一层，老页面照旧）。
     */
    setMood(m) {
      const cling = m && Number.isFinite(m.cling) ? clamp(m.cling, 60, 320) : 170;
      const speed = m && Number.isFinite(m.speed) ? clamp(m.speed, 0.5, 1.8) : 1;
      mood = { cling, speed, energy: m && Number.isFinite(m.energy) ? m.energy : null };
    },
    /**
     * 不说话的小动作（World 发 `{t:'micro', kind}`，这边 `case 'micro'` 转过来）。
     * 只有 `tilt`（歪头）和 `step`（换重心）两种；做完会回一条 `{t:'micro'}` 给 World。
     * 正在做的时候不重复触发（一来就把它做完，不然会抖）。
     */
    micro(kind) {
      if (microState.kind || (kind !== 'tilt' && kind !== 'step')) return;
      microState = { kind, k: 0, t: 0, dur: kind === 'tilt' ? 1.7 : 1.8 };
    },
    /** Head top in stage pixels, for placing a speech bubble. */
    anchor() { return toStage(A.bubble[0], (custom ? A.bubble[1] : (HEAD_TOP[skin.head] ?? 12) - 8) + pet.low); },
    emitHeart,
  };
}
