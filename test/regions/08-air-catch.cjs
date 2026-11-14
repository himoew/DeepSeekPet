/**
 * 自检区域：空中接住（2026-10-11 用户点名的一项）
 *
 * **为什么用"真跑一遍"而不是查字符串**：这一项的实质是**指针状态机**（`air` → `drag` 的转换、
 * 速度清零、锚点算在哪、空中点一下算不算戳）。查 `pointerDown` 里有没有某个字，证明不了这些；
 * 所以这里把 `web\pet-core.js` 在 Node 里**真的建起来**（最小 DOM 桩 + 与 render 同一套公式的
 * `xf`），喂它一串指针事件，量结果。
 *
 * 用户要的手感原话是"丢掉之后能在半空抓住"，所以这里钉住四条：
 *   ① 空中按下 + 拖 3px → 进 `drag`，**速度当场清零**（接住 = 稳稳托住，不反弹），响轻落地音；
 *   ② 接住那一刻的锚点 = **那个被抓的身体点**此刻的舞台坐标（不跳；不传抓点就还是后颈）；
 *   ③ 空中"按下就松"（没拖）→ 什么都不做（不戳、不进 drag）；
 *   ④ 地面那套一个字没变（6px 门槛、`sfx.grab()`），接住之后松手还能再丢出去。
 *
 * 不需要真连接，跑起来 ~0.3 秒。单跑：`node test\run-one.cjs 08-air-catch.cjs`
 */
const path = require('node:path');

module.exports = {
  name: '空中接住（指针状态机真跑一遍）',
  tags: ['air', '空中接住', '指针', 'pet-core'],
  async run(ctx) {
    const { fs, app, pathToFileURL, ok } = ctx;

    /* ---------- 最小 DOM 桩（pet-core 画身体要一点 DOM；这里只关心指针逻辑） ---------- */
    const el = () => ({
      attrs: {}, children: [], style: {}, _html: '', _text: '',
      setAttribute(k, v) { this.attrs[k] = v; },
      getAttribute(k) { return this.attrs[k]; },
      removeAttribute(k) { delete this.attrs[k]; },
      appendChild(c) { this.children.push(c); return c; },
      removeChild(c) { this.children = this.children.filter((x) => x !== c); return c; },
      querySelector() { return null; },
      querySelectorAll() { return []; },
      addEventListener() {}, removeEventListener() {},
      getBoundingClientRect: () => ({ x: 0, y: 0, width: 1280, height: 760, left: 0, top: 0, right: 1280, bottom: 760 }),
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html; },
      set textContent(v) { this._text = v; }, get textContent() { return this._text; },
      closest: () => null,
    });
    // 用完要还回去：别的区域（05c）也用 globalThis.document/window
    const had = { win: 'window' in globalThis, doc: 'document' in globalThis, ls: 'localStorage' in globalThis };
    const saved = { win: globalThis.window, doc: globalThis.document, ls: globalThis.localStorage };
    globalThis.window = globalThis;
    globalThis.document = { createElementNS: () => el(), createElement: () => el(), querySelector: () => null, querySelectorAll: () => [] };
    globalThis.localStorage = { getItem: () => null, setItem() {} };

    try {
      const mod = await import(`${pathToFileURL(path.join(app, 'web', 'pet-core.js')).href}?smoke=${Date.now()}`);
      const calls = [];
      const sfx = new Proxy({}, { get: (_, k) => (...a) => calls.push(`${String(k)}(${a.map((x) => JSON.stringify(x)).join(',')})`) });
      const events = [];
      const B = { W: 1280, H: 760, floorY: 758, S: .42 };
      const ctl = mod.createPet({ petG: el(), shadowEl: el(), fxG: el() }, {
        sfx, bounds: () => B, startX: 640,
        onEvent: (k, d) => events.push({ k, d }),
      });
      ok('空中接住：pet-core 能在纯 Node 里建起来（下面的断言才有意义）', !!ctl && typeof ctl.pointerDown === 'function');

      /**
       * `render()` 在纯 Node 下不一定跑得通（身体绘制要真 DOM）；跑不通就按 render 的**同一套公式**
       * 手算 `xf`（pet-core L1190-1196：`AX/AY = x/fy`，`ax/ay` = 抓点，`kx/ky` = S×镜像/压缩）。
       * `toStage` / `hitPet` 都靠它，所以两种路子等价。
       */
      let renderOk = true;
      try { ctl.render(); } catch (e) { renderOk = false; }
      const syncXf = () => {
        const p = ctl.pet;
        p.xf = { AX: p.x, AY: p.fy, ax: 128, ay: 256, kx: B.S * p.faceVis, ky: B.S, rot: p.tilt + p.lean };
      };
      if (!ctl.pet.xf) syncXf();
      console.log(`      （render 可用=${renderOk}${renderOk ? '' : '，用与 render 相同的公式手算 xf'}）`);

      /** 把她弄成"正在空中飞"：`setExpr('dragged')` 就是"被丢出去"那条路（vy=-1150、mode='air'）。 */
      const airborne = () => {
        ctl.pointerUp();
        ctl.pet.mode = 'idle';
        ctl.setExpr('dragged');
        for (let i = 0; i < 12; i += 1) { ctl.step(1 / 60); syncXf(); }
        return { mode: ctl.pet.mode, fy: ctl.pet.fy, vy: ctl.pet.vy };
      };

      /* ---------- ① 空中按下 + 拖 3px → 进 drag + 速度清零 + 轻落地音 ---------- */
      {
        const air = airborne();
        ok(`空中接住：起点确实是空中（mode=${air.mode} fy=${air.fy.toFixed(0)} vy=${air.vy.toFixed(0)}）`,
          air.mode === 'air' && air.fy < B.floorY - 50);
        const body = ctl.toStage(128, 128);
        calls.length = 0; events.length = 0;
        const down = ctl.pointerDown({ x: body.x, y: body.y });
        ok('空中接住：★空中按下被接受（原来 `air` 时 pointerDown 直接 return false）', down === true);
        const vy0 = ctl.pet.vy;
        ctl.pointerMove({ x: body.x + 3, y: body.y });
        ok(`空中接住：★拖 3px 就进 drag（空中的门槛收到 2px；mode=${ctl.pet.mode}）`, ctl.pet.mode === 'drag');
        ok(`空中接住：★接住 = 速度当场清零（接住前 vy=${vy0.toFixed(0)} → ${ctl.pet.vy}）`,
          ctl.pet.vx === 0 && ctl.pet.vy === 0);
        ok(`空中接住：响的是"轻落地"那一声，不是地面的 grab（${calls.join(' ') || '没响'}）`,
          calls.some((c) => c.startsWith('land(false)')) && !calls.some((c) => c.startsWith('grab()')));
        ok('空中接住：世界收到一条 grab（她会说抓取台词）',
          events.some((e) => e.k === 'touch' && e.d.kind === 'grab'));
      }

      /* ---------- ② 锚点不跳：dx/dy ≈ 那个被抓的身体点此刻的舞台坐标 ---------- */
      {
        const air = airborne();
        ok('空中接住：② 的起点在空中', air.mode === 'air');
        const grab = { x: 128, y: 128, hang: 0 };              // 页面平时就是这么给的（抓哪儿拎哪儿）
        const want = ctl.toStage(grab.x, grab.y);
        ctl.pointerDown({ x: want.x, y: want.y }, { grab });
        ctl.pointerMove({ x: want.x + 3, y: want.y });
        ctl.step(1 / 60);                                      // 让 drag 的 lerp 只走一帧
        const d = Math.hypot(ctl.pet.dx - want.x, ctl.pet.dy - want.y);
        ok(`空中接住：★接住那一刻锚点就在抓点上（偏移 ${d.toFixed(1)}px，<6px 才算不跳）`, d < 6);
      }
      {
        const air = airborne();
        ok('空中接住：②b 的起点在空中', air.mode === 'air');
        const want = ctl.toStage(128, 36);                     // 不传抓点 → 老规矩：后颈
        ctl.pointerDown({ x: want.x, y: want.y });
        ctl.pointerMove({ x: want.x + 3, y: want.y });
        ctl.step(1 / 60);
        const at = ctl.pet.grabAt || {};
        const d = Math.hypot(ctl.pet.dx - want.x, ctl.pet.dy - want.y);
        ok(`空中接住：不传抓点时仍按老规矩抓后颈 (128,36)（偏移 ${d.toFixed(1)}px，grabAt=${JSON.stringify(at)}）`,
          d < 6 && at.x === 128 && at.y === 36);
      }

      /* ---------- ③ 空中"按下就松"（没拖）→ 什么都不做 ---------- */
      {
        const air = airborne();
        const body = ctl.toStage(128, 128);
        events.length = 0;
        ctl.pointerDown({ x: body.x, y: body.y });
        ctl.pointerUp();
        ok(`空中接住：★空中点一下不进 drag、也不戳（mode=${ctl.pet.mode}，腾空中戳它没有意义）`,
          air.mode === 'air' && ctl.pet.mode === 'air'
          && !events.some((e) => e.k === 'touch' && (e.d.kind === 'poke' || e.d.kind === 'grab')));
      }

      /* ---------- ④ 地面那套没变（门槛 6px、grab 音） ---------- */
      {
        ctl.pointerUp();
        ctl.pet.mode = 'idle'; ctl.pet.fy = B.floorY; syncXf();
        const body = ctl.toStage(128, 128);
        calls.length = 0;
        ctl.pointerDown({ x: body.x, y: body.y });
        ctl.pointerMove({ x: body.x + 3, y: body.y });
        ok(`空中接住：地面上拖 3px 仍然不进 drag（门槛还是 6px，mode=${ctl.pet.mode}）`, ctl.pet.mode !== 'drag');
        ctl.pointerMove({ x: body.x + 10, y: body.y });
        ok('空中接住：地面上拖 10px 进 drag（老行为没变）', ctl.pet.mode === 'drag');
        ok(`空中接住：地面上抓起来响的还是 grab()（${calls.join(' ') || '没响'}）`,
          calls.some((c) => c.startsWith('grab()')) && !calls.some((c) => c.startsWith('land(')));
      }

      /* ---------- ⑤ 接住之后松手：还是"丢出去"那条老路 ---------- */
      {
        const air = airborne();
        ok('空中接住：⑤ 的起点在空中', air.mode === 'air');
        const body = ctl.toStage(128, 128);
        ctl.pointerDown({ x: body.x, y: body.y });
        ctl.pointerMove({ x: body.x + 40, y: body.y });
        for (let i = 0; i < 4; i += 1) ctl.pointerMove({ x: body.x + 60 + i * 30, y: body.y });
        ctl.pointerUp();
        ok(`空中接住：★接住再松手 → 回到 air、还能再丢出去（mode=${ctl.pet.mode} vx=${ctl.pet.vx.toFixed(0)}）`,
          ctl.pet.mode === 'air' && Math.abs(ctl.pet.vx) > 200);
      }
    } finally {
      if (had.win) globalThis.window = saved.win; else delete globalThis.window;
      if (had.doc) globalThis.document = saved.doc; else delete globalThis.document;
      if (had.ls) globalThis.localStorage = saved.ls; else delete globalThis.localStorage;
    }
  },
};
