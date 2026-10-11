/**
 * 自检区域：天气 ↔ 她的互动（③a：雨溅落 / 樱叶擦身 / 走动带风 / 判定盒子；
 * ③b：雪落在她身上**积住** / 她一动或抖一下就掉 / 切天气**缓缓淡出**；
 * 打磨：**用她自己的真实轮廓**做判定（`whale/surface.json`）、雪只积在**三个美术锚点**上 / 性能）
 *
 * **为什么这么测**：这一项的实质是**几何**（"她身上"到底是画布上的哪一块）+ **几条分支**
 * （雨打到就死并溅一圈、樱/落叶被推歪且升到近层、雪积住并跟着她动、她在走时给前方粒子加一条风）。
 * 查字符串一条也证明不了，所以两头都用**真的**：`web\pet-core.js` 在 Node 里真建起来
 * （拿它自己的 `toStage` / `hitPet` 当基准），`web\fx.js` 真跑（真发射、真推物理、真算命中）。
 *
 * 钉住的几条：
 *   ① **盒子就是她**：fx 的命中判定与 pet-core 的两个判定圆（`hitPet` 同源）逐点一致；
 *      "本地 → 舞台"与 `ctl.toStage` 逐点一致（含**朝左（kx 为负）**与**带倾角**两种姿态）；
 *   ② **雨**：打在她身上 → 那一颗死掉 + 在**入射点**（她轮廓上，不是肚子中间）溅一圈；
 *   ③ **樱/落叶**：擦一下**不死**、被推歪、下落变慢、并**升到近层**（否则在她身后看不见）；
 *   ④ **走动带风**：她在走 → 前方粒子被带一下；**身后**的不受影响；
 *   ⑤ **雪（③b）**：落在她身上**积住**（存本地坐标 → 她动雪跟着动）、**有上限**、
 *      她一走动/一抖就**掉成一粒粒雪落下去**；**切天气时缓缓淡出**（不是留着、也不是瞬间没）；
 *   ⑥ **没有她时**：一次命中都没有、也不会"积在空气里"（这一套整体关闭，`07b` 那 12 条一字不变）；
 *      音符（从她嘴边冒出来的）**不算命中她**；
 *   ⑦ **性能**：满屏粒子下"物理"每帧多出来的时间（实测数字直接打进 ok 的名字里）。
 *
 * 不需要真连接、不需要像素（假画布只记账不写像素，见 `07b` 的 `PIXEL_MAX`），跑起来 1 秒级。
 * 单跑：`node test\run-one.cjs 07d-fx-actor.cjs`
 */
module.exports = {
  name: '天气与她的互动（真实轮廓/雨溅落/雪帽/擦身/走动带风/性能）',
  tags: ['天气', '粒子', '互动', '她', '雪'],
  async run(ctx) {
    const { app, ok } = ctx;
    const path = require('node:path');

    /* ---------- DOM 桩（与 `08-air-catch` 同一套：够 pet-core 画身体就行） ---------- */
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
    /**
     * 假画布：**只记账、不写像素**（这一区一条像素断言都没有，所以不需要 `07b` 那套像素缓冲）。
     * 给两张（远层 + 近层）是必须的：`hasNear` 为假的话，"擦过她的升到近层"这条根本验不了
     * （fx 会退化成"只有一张画布"，所有粒子都在她身后）。
     */
    const stubCtx = () => ({
      globalAlpha: 1, lineWidth: 1, strokeStyle: '#888', fillStyle: '#888', font: '', textAlign: '', textBaseline: '',
      lineCap: '', lineJoin: '', globalCompositeOperation: 'source-over',
      save() {}, restore() {}, beginPath() {}, closePath() {}, moveTo() {}, lineTo() {}, bezierCurveTo() {},
      quadraticCurveTo() {}, arc() {}, ellipse() {}, rect() {}, clip() {}, stroke() {}, fill() {}, fillRect() {},
      strokeRect() {}, fillText() {}, clearRect() {}, setTransform() {}, resetTransform() {}, translate() {},
      rotate() {}, scale() {}, drawImage() {}, strokeText() {},
      createLinearGradient: () => ({ addColorStop() {} }),
      createRadialGradient: () => ({ addColorStop() {} }),
      createPattern: () => null,
      measureText: () => ({ width: 0 }),
      getImageData: () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 }),
    });
    const fakeCanvas = () => {
      const c = { width: 1, height: 1, style: {}, _ctx: null };
      c.getContext = (kind) => (kind === '2d' ? (c._ctx = c._ctx || stubCtx()) : null);
      c.getBoundingClientRect = () => ({ x: 0, y: 0, width: 1, height: 1 });
      return c;
    };

    const had = { win: 'window' in globalThis, doc: 'document' in globalThis, ls: 'localStorage' in globalThis, p2: 'Path2D' in globalThis };
    const saved = { win: globalThis.window, doc: globalThis.document, ls: globalThis.localStorage, p2: globalThis.Path2D };
    globalThis.window = globalThis;
    globalThis.document = {
      createElementNS: () => el(),
      createElement: (tag) => (tag === 'canvas' ? fakeCanvas() : el()),
      querySelector: () => null, querySelectorAll: () => [], documentElement: {},
    };
    globalThis.localStorage = { getItem: () => null, setItem() {} };
    /** 贴图（花瓣/叶子）会 `new Path2D(d)` —— Node 里没有，给个能装路径字符串的壳。 */
    globalThis.Path2D = globalThis.Path2D || class { constructor(d) { this.d = d; } };

    try {
      const core = await ctx.importFresh(path.join('web', 'pet-core.js'));
      const fxMod = await ctx.importFresh(path.join('web', 'fx.js'));
      ok('天气互动：`pet-core.js` 与 `fx.js` 都能在纯 Node 里载入（下面那些断言才有意义）',
        !!core.createPet && !!fxMod.createFx);

      const B = { W: 1280, H: 760, floorY: 758, S: .42 };
      const sfx = new Proxy({}, { get: () => () => {} });
      const ctl = core.createPet({ petG: el(), shadowEl: el(), fxG: el() }, { sfx, bounds: () => B, startX: 640 });
      /** `render()` 在纯 Node 下可能跑不通（身体绘制要真 DOM）；跑不通就按同一套公式手算 `xf`。 */
      let renderOk = true;
      try { ctl.render(); } catch (e) { renderOk = false; }
      const setXf = (o) => {
        ctl.pet.xf = { AX: 640, AY: B.floorY, ax: 128, ay: 256, kx: B.S, ky: B.S, rot: 0, ...o };
      };
      if (!ctl.pet.xf) setXf({});
      console.log(`      （pet-core render 可用=${renderOk}${renderOk ? '' : '，用与 render 相同的公式手算 xf'}）`);

      /** 造一套粒子系统（要几张画布就给几张：近层是验"升到近层"的前提）。 */
      const mkFx = () => fxMod.createFx({ ctl: { bounds: { W: B.W, H: B.H } }, canvas: fakeCanvas(), canvasNear: fakeCanvas() });
      const fx = mkFx();
      /** 页面每帧喂给 fx 的那份快照（字段与 `pet.xf` 一一对应，见 fx.js 的 `actor()`）。 */
      const snapOf = (o) => {
        const xf = ctl.pet.xf;
        return { AX: xf.AX, AY: xf.AY, ax: xf.ax, ay: xf.ay, kx: xf.kx, ky: xf.ky, rot: xf.rot, S: B.S, moving: false, ...o };
      };

      /* ---------- ① 本地 ↔ 舞台：与 pet-core 的 toStage 逐点对账 ---------- */
      {
        const probes = [[128, 128], [128, 232], [60, 100], [200, 60], [128, 36], [230, 236], [90, 200]];
        const configs = [
          ['站着（朝右）', {}],
          ['朝左（kx 为负）', { kx: -B.S }],
          ['带倾角 17°', { rot: 17 }],
          ['被拎着（抓点在后颈 + 压扁 + 转 -23°）', { ax: 128, ay: 36, kx: -B.S * 1.15, ky: B.S * .92, rot: -23, AX: 700, AY: 400 }],
        ];
        let worst = -1, where = '';
        for (const [label, cfg] of configs) {
          setXf(cfg);
          fx.actor(snapOf());
          for (const [lx, ly] of probes) {
            const a = fx.actorStage(lx, ly), b = ctl.toStage(lx, ly);
            const d = Math.hypot(a.x - b.x, a.y - b.y);
            if (d > worst) { worst = d; where = `${label} 本地(${lx},${ly})`; }
          }
        }
        ok(`★天气互动：fx 的"本地→舞台"与 pet-core 的 \`toStage\` 逐点一致`
          + `（4 种姿态 × ${probes.length} 个点，最差 ${worst.toFixed(5)}px @ ${where}）`, worst < .01);

        setXf({ rot: 17, kx: -B.S });
        fx.actor(snapOf());
        let worstB = 0;
        for (const [lx, ly] of probes) {
          const s = ctl.toStage(lx, ly), l = fx.actorLocal(s.x, s.y);
          worstB = Math.max(worstB, Math.hypot(l.x - lx, l.y - ly));
        }
        ok(`★天气互动：舞台→本地还能反着走回去（本地→舞台→本地，最差 ${worstB.toFixed(5)}px）`
          + ' —— ③b 的"雪贴在她身上"就靠这一对换算', worstB < .01);
      }

      /* ---------- ② 判定盒子 = pet-core 的 hitPet ---------- */
      {
        setXf({});                     // 站着（没有压缩拉伸 → 半径与 hitPet 完全相同）
        fx.actor(snapOf());
        const box = fx.actorBox();
        const c1 = ctl.toStage(128, 128), c2 = ctl.toStage(128, 232);
        const r1 = 108 * B.S, r2 = 62 * B.S;
        const probes = [[128, 128], [128, 232], [128, 64], [180, 128], [128, 10], [128, 300], [0, 128], [40, 120], [210, 140], [150, 236]];
        let bad = 0, firstBad = '';
        for (const [lx, ly] of probes) {
          const s = ctl.toStage(lx, ly);
          const want = Math.hypot(s.x - c1.x, s.y - c1.y) < r1 || Math.hypot(s.x - c2.x, s.y - c2.y) < r2;
          const got = fx.actorHit(s.x, s.y);
          if (want !== got) { bad += 1; if (!firstBad) firstBad = `本地(${lx},${ly}) 期望 ${want} 实际 ${got}`; }
        }
        ok(`★天气互动：命中判定与 pet-core 的 \`hitPet\` 是**同一个盒子**`
          + `（${probes.length} 个探针，${bad} 个不一致${firstBad ? '：' + firstBad : ''}）`,
        box.on && bad === 0);
        ok(`★天气互动：盒子尺寸对得上她的体型（身体 r=${box.c1.r.toFixed(1)}px = 108×${B.S}，下身 r=${box.c2.r.toFixed(1)}px = 62×${B.S}；`
          + `圆心跟她站的位置一起动：${box.c1.x.toFixed(0)},${box.c1.y.toFixed(0)}）`,
        Math.abs(box.c1.r - r1) < .01 && Math.abs(box.c2.r - r2) < .01
          && Math.abs(box.c1.x - c1.x) < .01 && Math.abs(box.c1.y - c1.y) < .01);
      }

      /** 一滴滴在她头顶正上方、竖直落下（摆动/风全关 → 完全确定）。 */
      const dropRain = (f) => {
        const c1 = f.actorBox().c1;
        return f.spawn('rain', {
          x: c1.x, y: c1.y - c1.r - 80, vy: 2000, vT: 2000,
          sway: 0, hz: 0, hzA: 0, phase: 0, wind: 0, slip: 0, layer: 1, layerN: 3,
        });
      };
      const push = (f, n, t0) => {
        let t = t0, hits = 0;
        for (let i = 0; i < n; i += 1) { t += 1 / 60; f.frame(1 / 60, t, 'off'); hits = Math.max(hits, f.stats().meta.hits); }
        return hits;
      };

      /* ---------- ③ 雨：打到她 → 死 + 在**入射点**溅一圈 ---------- */
      {
        setXf({});
        fx.clear(true); fx.actor(null); fx.actor(snapOf());
        const c1 = fx.actorBox().c1;
        dropRain(fx);
        const hits = push(fx, 6, 50);
        const st = fx.stats();
        const sp = st.list.find((q) => q.shape === 'splash');
        ok(`★天气互动：雨打在她身上 = 那一颗**死掉**（剩 ${fx.count} 颗）+ 在她身上溅一圈`
          + `（命中 ${hits} 次、身上溅落 ${st.meta.onBody} 个）`,
        hits === 1 && fx.count === 0 && st.meta.onBody === 1);
        ok(`★天气互动：溅落点在**她的轮廓上**（头顶 y=${sp ? sp.y : 'n/a'}，轮廓 y=${(c1.y - c1.r).toFixed(1)}）`
          + ' —— 不这么做的话雨会溅在她肚子中间（她一帧能走 33px）',
        !!sp && Math.abs(sp.y - (c1.y - c1.r)) < 1.5 && Math.abs(sp.x - c1.x) < .5);
      }

      /* ---------- ④ 回归：没有她 → 一次命中都没有，雨照旧溅在地上 ---------- */
      {
        setXf({});
        fx.clear(true); fx.actor(null);
        dropRain(fx);
        const hits = push(fx, 8, 50);
        const st = fx.stats();
        ok(`★天气互动：**没有她时一次命中都没有**（命中 ${hits}、身上溅落 ${st.meta.onBody}、`
          + `地上溅落 ${st.meta.splash}）—— 这一套整体关闭，07b 那 12 条才会一字不变`,
        hits === 0 && st.meta.onBody === 0 && st.meta.splash >= 1);
      }

      /* ---------- ⑤ 音符不算"碰到她"（它就是从她嘴边生出来的） ---------- */
      {
        setXf({});
        fx.clear(true); fx.actor(null); fx.actor(snapOf());
        const c1 = fx.actorBox().c1;
        fx.spawn('note', { x: c1.x, y: c1.y, vy: -40 });
        const hits = push(fx, 5, 60);
        ok(`★天气互动：从她嘴边冒出来的音符**不算"碰到她"**（命中 ${hits}，粒子还在 ${fx.count} 颗）`
          + ' —— 不然她说每句话都在打自己', hits === 0 && fx.count === 1);
      }

      /* ---------- ⑥ 樱/落叶：擦一下不死、被推歪、变慢、升到近层 ---------- */
      {
        /** 一片完全确定的花瓣：从她右肩上方落下来（把摆动/风/翻滚都关掉）。 */
        const spawnPetal = (f) => f.spawn('blossom', {
          x: 660, y: 630, vy: 0, vT: 40,
          sway: 0, hz: 0, hzA: 0, phase: 0, wind: 0, slip: 0, stall: 0,
          spin: 0, spinSp: 0, rollSp: 0, flip: 0, drift: 1, layer: 0, layerN: 3, life: 40,
          /**
           * ⚠️ **必须显式给 `flower: false`**：整朵花的判定是在 `over` **之前**按抽到的层算的
           * （`make()` 里 `flower = li >= 1 && random < 8%`），不改就是"这一跑画的是花、下一跑是花瓣"，
           * 断言会随机找不到 `shape === 'petal'` 那一项。
           */
          flower: false,
        });
        const runPetal = (withHer) => {
          fx.clear(true);
          fx.actor(null);                 // 清掉"上一帧她在哪"（否则第一帧速度会飙）
          setXf({});
          if (withHer) fx.actor(snapOf());
          spawnPetal(fx);
          /** 200 帧（3.3 秒）：她大概在第 90 帧左右擦到花瓣，剩下的时间才看得出"变慢"。 */
          push(fx, 200, 80);
          const q = fx.stats().list.find((k) => k.shape === 'petal');
          return { x: q ? q.x : NaN, y: q ? q.y : NaN, alive: fx.count === 1, near: fx.layerCounts().near };
        };
        const before = runPetal(false), after = runPetal(true);
        ok(`★天气互动：花瓣擦过她**不会消失**（擦过前 ${before.alive ? '在' : '不在'} / 擦过后 ${after.alive ? '在' : '不在'}）`
          + ' —— 雨是"打到就没了"，花瓣/叶子是"擦一下接着飘"', before.alive && after.alive);
        ok(`★天气互动：擦过她的花瓣**升到近层**（远层 ${before.near} → 近层 ${after.near}）`
          + ' —— 留在远层的话那一下擦身被她自己的身体挡住了，什么都看不见',
        before.near === 0 && after.near === 1);
        ok(`★天气互动：擦过之后她被**推开**了（x：${before.x.toFixed(1)} → ${after.x.toFixed(1)}）`,
          after.x > before.x + 3);
        ok(`★天气互动：擦过之后**下落变慢**（y：${before.y.toFixed(1)} → ${after.y.toFixed(1)}，慢 ${(before.y - after.y).toFixed(1)}px）`,
          before.y - after.y > 5);
      }

      /* ---------- ⑦ 她走动带起的一阵风（前方受影响、身后不受影响） ---------- */
      {
        const spawnSnow = (x, y) => fx.spawn('snow', {
          x, y, vy: 60, vT: 60, sway: 0, hz: 0, hzA: 0, phase: 0, slip: 0, stall: 0,
          spin: 0, spinSp: 0, rollSp: 0, wind: 1, drift: 1, layer: 2, layerN: 3, life: 40,
        });
        /**
         * 同一套粒子系统、同一条时间轴、同一个风场种子（`fx` 的 seed 是实例级的、没换过）
         * —— 所以两次跑**只差"她在不在走"**这一件事，比较才站得住。
         */
        const runWalk = (walking, offset) => {
          fx.clear(true); fx.actor(null); setXf({});
          let petX = 640;
          const place = () => { setXf({ AX: petX }); fx.actor(snapOf({ moving: walking })); };
          place();
          const c1 = fx.actorBox().c1;
          /**
           * ⚠️ 放**她身体中心上方 100px**，不是旁边：③b 之后雪也会判定命中，
           * 放在旁边的话她一走（250px/s）就会撞上它、那颗粒子当场消失（断言会拿到 NaN）。
           * 上方 100px 既在"她走动带风"的范围内（`herWind` 看 dx，±200 的 dy 都算），
           * 又永远进不了她身体那个圆（最近也有 100px > r=45）。
           */
          spawnSnow(c1.x + offset, c1.y - 100);
          let t = 120;
          for (let i = 0; i < 60; i += 1) {
            if (walking) { petX += 250 / 60; place(); }        // 她 250px/s 往右走
            t += 1 / 60;
            fx.frame(1 / 60, t, 'off');
          }
          const q = fx.stats().list.find((k) => k.shape === 'snow');
          return q ? q.x : NaN;
        };
        const frontStill = runWalk(false, 60), frontWalk = runWalk(true, 60);
        const backStill = runWalk(false, -60), backWalk = runWalk(true, -60);
        ok(`★天气互动：她往前走时，**前方**的雪被带了一下（x：${frontStill.toFixed(1)} → ${frontWalk.toFixed(1)}，`
          + `多飘 ${(frontWalk - frontStill).toFixed(1)}px）`, frontWalk > frontStill + 1.5);
        ok(`★天气互动：**身后**的雪不受影响（x：${backStill.toFixed(1)} → ${backWalk.toFixed(1)}，`
          + `差 ${Math.abs(backWalk - backStill).toFixed(1)}px）—— 只吹前方，不然像吸尘器`,
        Math.abs(backWalk - backStill) < 1.5);
      }

      /* ---------- ⑧ 诊断盒子（`?diag=1&fxbox=1`）默认关、开了就画在圆心上 ---------- */
      {
        setXf({}); fx.actor(null); fx.actor(snapOf());
        fx.clear(true);
        let t = 200;
        fx.frame(1 / 60, t, 'off');
        ok('★天气互动：盒子描边**默认关着**（正式运行里它进不了绘制清单）', fx.stats().meta.box === 0);
        fx.debugBox(true);
        t += 1 / 60; fx.frame(1 / 60, t, 'off');
        const st = fx.stats();
        const boxes = st.list.filter((q) => q.shape === 'box');
        const box = fx.actorBox();
        ok(`★天气互动：\`fxbox\` 打开时画的是**两个判定圆**（${boxes.length} 个，`
          + `身体 ${boxes[0] ? boxes[0].x + ',' + boxes[0].y : 'n/a'} / 下身 ${boxes[1] ? boxes[1].x + ',' + boxes[1].y : 'n/a'}）`
          + ' —— "盒子有没有对上她"不该靠猜',
        boxes.length === 2 && st.meta.box === 2
          && Math.abs(boxes[0].x - box.c1.x) < .1 && Math.abs(boxes[0].y - box.c1.y) < .1
          && Math.abs(boxes[1].x - box.c2.x) < .1 && Math.abs(boxes[1].y - box.c2.y) < .1);
        fx.debugBox(false);
      }

      /* ---------- ⑨ 她的**真实轮廓**（`whale/surface.json`）：雨和雪落在她画出来的形状上 ---------- */
      const SURF_JSON = JSON.parse(fs.readFileSync(path.join(app, 'web', 'whale', 'surface.json'), 'utf8'));
      const dropSnow = (f, x, y) => f.spawn('snow', {
        x, y, vy: 120, vT: 120, sway: 0, hz: 0, hzA: 0, phase: 0, wind: 0, slip: 0, stall: 0,
        spin: 0, spinSp: 0, rollSp: 0, layer: 1, layerN: 3, life: 40,
      });
      /**
       * 在**本地 x 那一列**的上方放一颗粒子，推若干帧；返回命中次数与落点的本地坐标。
       * 用 `actorStage` 换算，所以她在什么姿态下都对。
       */
      const landAt = (f, kind, lx, t0, frames = 45, fresh = true) => {
        if (fresh) f.clear(true);
        const s = f.actorStage(lx, -20);
        const v = kind === 'rain' ? 900 : 120;
        f.spawn(kind, {
          x: s.x, y: s.y, vy: v, vT: v, sway: 0, hz: 0, hzA: 0, phase: 0, wind: 0, slip: 0,
          stall: 0, spin: 0, spinSp: 0, rollSp: 0, layer: 1, layerN: 3, life: 40,
        });
        let hits = 0, t = t0, at = null;
        for (let i = 0; i < frames; i += 1) {
          t += 1 / 60;
          f.frame(1 / 60, t, 'off');
          const m = f.stats().meta.hits;
          /**
           * ⚠️ 只在"这一帧真的新命中了"那一帧读溅落，而且**取本地 x 离这一列最近的那一个**：
           * 身上的溅落会活 0.16~0.34 秒、几列下来叠在一起，随手 `find` 会拿到**上一列**留下的
           * （第一版就这么错：逐列核对时最差 112 单位，其实每一列本身都是准的）。
           * 另外只认 `body` 那种 —— 地上那种也是 `shape === 'splash'`。
           */
          if (m > hits) {
            hits = m;
            let best = null, bd = 1e9;
            for (const q of f.stats().list) {
              if (q.shape !== 'splash' || !q.body) continue;
              const l = f.actorLocal(q.x, q.y);
              const d = Math.abs(l.x - lx);
              if (d < bd) { bd = d; best = l; }
            }
            if (best) at = best;
            break;
          }
        }
        return { hits, at };
      };
      {
        setXf({});
        fx.clear(true); fx.actor(null); fx.actor(snapOf());
        ok(`★真实轮廓：\`surface.json\` 读得进来、结构对得上（${SURF_JSON.top.length} 列 / 步长 ${SURF_JSON.step}，`
          + `有内容的列 ${SURF_JSON.coverage.columns}/${SURF_JSON.coverage.total}，锚点 ${JSON.stringify(SURF_JSON.anchors)}）`,
        SURF_JSON.top.length === (SURF_JSON.x1 - SURF_JSON.x0) / SURF_JSON.step + 1
          && SURF_JSON.coverage.columns > SURF_JSON.coverage.total * .5
          && SURF_JSON.anchors.length === 3
          && SURF_JSON.bot.length === SURF_JSON.top.length);
        const crown = SURF_JSON.top[Math.round((128 - SURF_JSON.x0) / SURF_JSON.step)];
        ok(`★真实轮廓：头顶那一列（本地 x=128）的顶面在 y=${crown} —— 她是个头顶带呆毛的小鱼`
          + '（这个数是**从 25 张图层拼出来的**，不是写死的）', crown > 12 && crown < 40);

        fx.surface(SURF_JSON);
        ok('★真实轮廓：`fx.surface()` 接上之后就换了判定（`hasSurface` 为真）', fx.hasSurface === true);

        /** 挑几列做"落点"核对：有内容的列必须**落在她的顶面上**，没内容的列**一次都不许命中**。 */
        const cols = [];
        for (let lx = SURF_JSON.x0; lx <= SURF_JSON.x1 && cols.length < 12; lx += 6) {
          if (Number.isFinite(fx.surfaceTop(lx))) cols.push(lx);
        }
        let worst = 0, bad = '';
        let t0 = 2600;
        for (const lx of cols) {
          const r = landAt(fx, 'rain', lx, t0);
          t0 += 1;
          const want = fx.surfaceTop(lx);
          const d = r.at ? Math.abs(r.at.y - want) : 999;
          if (!r.hits || d > worst) { worst = r.hits ? d : 999; bad = `本地 x=${lx}${r.hits ? '' : '（没命中）'}`; }
        }
        ok(`★真实轮廓：**雨点落在她画出来的那条线上**（${cols.length} 列逐列核对，最差 ${worst === 999 ? '未命中' : worst.toFixed(2)} 单位`
          + `${worst === 999 ? ' @ ' + bad : ''}；1 单位 ≈ 0.42px）`,
        worst < 2);

        /** ★ 这一条是用户实测那个问题的**回归**：以前 73.5% 的落点在空气里。 */
        const airCols = [];
        for (let lx = SURF_JSON.x0; lx <= SURF_JSON.x1 && airCols.length < 10; lx += 4) {
          if (!Number.isFinite(fx.surfaceTop(lx))) airCols.push(lx);
        }
        let airHits = 0;
        for (const lx of airCols) { if (landAt(fx, 'rain', lx, 2700).hits) airHits += 1; }
        ok(`★真实轮廓：**她身外的那些列一次都不命中**（${airCols.length} 列全是空气，命中 ${airHits} 次）`
          + ' —— 这就是"白点看着脏"的根因（原来圆里有 23% 是空气、73.5% 的雪落在身外）',
        airCols.length > 0 && airHits === 0);
      }

      /* ---------- ⑩ 雪帽：三个锚点，只有"雪量"在长（不再是到处冒点） ---------- */
      {
        setXf({});
        fx.clear(true); fx.actor(null); fx.actor(snapOf());
        fx.surface(SURF_JSON);
        const A0 = fx.caps();
        ok(`★雪帽：位置是 surface.json 给的**三个美术锚点**（${A0.map((a) => `${a.x},${a.y}`).join(' / ')}）`
          + ' —— 头顶 + 左右两侧，不是"哪儿命中哪儿冒一个点"',
        A0.length === 3 && A0.every((a) => Number.isFinite(a.x) && Number.isFinite(a.y)));
        const crownX = A0[0].x;
        landAt(fx, 'snow', crownX, 2800, 60);
        const one = fx.caps()[0].amt;
        landAt(fx, 'snow', crownX, 2820, 60, false);     // ⚠️ 后两次 `fresh=false`：别把雪量清掉
        landAt(fx, 'snow', crownX, 2840, 60, false);
        const full = fx.caps()[0].amt;
        ok(`★雪帽：雪落在最近的那个锚点上、**三片打满**（一片后 ${one.toFixed(2)} → 三片后 ${full.toFixed(2)}），`
          + `meta.cling 从现在起是"有几个锚点有雪"（${fx.clinging}）`,
        Math.abs(one - 1 / 3) < .02 && full > .95 && fx.clinging === 1);
        const capItem = fx.stats().list.find((q) => q.shape === 'cap');
        const want = fx.actorStage(A0[0].x, A0[0].y);
        ok(`★雪帽：画出来的那张**软边贴图**就贴在她头顶那个锚点上（画在 ${capItem ? `${capItem.x.toFixed(0)},${capItem.y.toFixed(0)}` : 'n/a'}，`
          + `锚点在 ${want.x.toFixed(0)},${want.y.toFixed(0)}）—— 中心还往轮廓里收了 0.28 半径，只露上缘`,
        !!capItem && Math.abs(capItem.x - want.x) < 4 && Math.abs(capItem.y - want.y) < 6
          && fx.stats().meta.images > 0);

        /* 她**慢慢挪** 120px（不走、不甩）：雪帽要跟着她走 */
        const cx0 = capItem ? capItem.x : NaN;
        let petX = 640, t = 2900;
        for (let i = 0; i < 60; i += 1) {
          petX += 2;                                   // 2px/帧 = 120px/s（低于"抖掉"的 250）
          setXf({ AX: petX });
          fx.actor(snapOf());
          t += 1 / 60;
          fx.frame(1 / 60, t, 'off');
        }
        const cx1 = (fx.stats().list.find((q) => q.shape === 'cap') || {}).x;
        ok(`★雪帽：她动的时候雪帽**跟着她动**（她 +120px，雪帽 ${cx0.toFixed(1)} → ${cx1.toFixed(1)}）`
          + ' —— 这是"贴在她身上"和"悬在半空"的唯一区别',
        Math.abs((cx1 - cx0) - 120) < 6 && fx.clinging === 1);

        /* 寿命：用户选的是 15~25 秒（`CAP_LIFE = 20`），不再落雪之后慢慢化掉 */
        const amt0 = fx.caps()[0].amt;
        push(fx, 300, 3000);                            // 5 秒
        const amt5 = fx.caps()[0].amt;
        push(fx, 960, 3100);                            // 再 16 秒
        const amt21 = fx.caps()[0].amt;
        ok(`★雪帽：**寿命 15~25 秒**（满雪量 ${amt0.toFixed(2)} → 5 秒后 ${amt5.toFixed(2)} → 21 秒后 ${amt21.toFixed(2)}）`
          + ' —— 调研结论是"宁少而大、久而不闪"（6~10 秒会频繁消失，看着像闪）',
        Math.abs(amt5 - (amt0 - 5 / 20)) < .05 && amt21 === 0);

        /* 她一走动/抖一下 → 雪帽掉光，而且**变回一颗粒子落下去** */
        fx.clear(true); fx.actor(snapOf());
        landAt(fx, 'snow', crownX, 4200, 60);
        landAt(fx, 'snow', crownX, 4220, 60, false);
        landAt(fx, 'snow', crownX, 4240, 60, false);
        const before = fx.clinging;   // 1 = 有一个锚点上有雪
        /**
         * ⚠️ 这里必须用**软清** `clear()`：`clear(true)` 是"连雪帽一起硬清"，
         * 那这一条就变成"雪帽已经被清掉了、当然抖不出粒子"（第一版就是这么错的）。
         */
        fx.clear();
        fx.actor(snapOf({ moving: true }));
        push(fx, 3, 4300);
        ok(`★雪帽：她一**走动**，雪帽就抖掉、而且变回正在下落的雪粒子（抖之前 ${before} 个锚点 → 现在 ${fx.clinging} 个、`
          + `天上 ${fx.count} 颗）`, before === 1 && fx.clinging === 0 && fx.count >= 2);
      }

      /* ---------- ⑪ 快速移动/被拎着甩：**不粘**，只冒一下白雾（调研给的那条兜底） ---------- */
      {
        setXf({});
        fx.clear(true); fx.actor(null);
        fx.surface(SURF_JSON);
        fx.actor(snapOf({ moving: true }));              // 她在走
        const crownX = fx.caps()[0].x;
        landAt(fx, 'snow', crownX, 5000, 60);
        landAt(fx, 'snow', crownX, 5020, 60);
        ok(`★雪帽：她**快速移动时不粘**，只冒一下白雾（白雾 ${fx.stats().meta.puff} 个、雪帽 ${fx.clinging} 个）`
          + ' —— 那时候贴片最容易暴露"没跟着姿势更新"',
        fx.clinging === 0 && fx.stats().meta.puff >= 1);
        /* 回归：没有 surface（Coo 形象）时**也只冒白雾**，不积 */
        fx.surface(null);
        setXf({}); fx.actor(null); fx.actor(snapOf());
        const c1c = fx.actorBox().c1;
        landAt(fx, 'snow', 128, 5100, 60);
        ok(`★雪帽：没有真实轮廓时（Coo / 老宿主）**退回圆的判定 + 只冒白雾**（雪帽 ${fx.clinging} 个、`
          + `白雾 ${fx.stats().meta.puff}，hasSurface=${fx.hasSurface}）`,
        fx.hasSurface === false && fx.clinging === 0 && fx.stats().meta.puff >= 1);
        void c1c;
      }

      /* ---------- ⑫ 切天气：她身上的雪**缓缓淡出**（用户点名的那条）+ clear 的软硬两种 ---------- */
      {
        setXf({});
        fx.clear(true); fx.actor(null); fx.actor(snapOf());
        fx.surface(SURF_JSON);
        const crownX = fx.caps()[0].x;
        for (let i = 0; i < 3; i += 1) landAt(fx, 'snow', crownX, 6000 + i * 20, 60, i === 0);
        const n0 = fx.caps()[0].amt;
        fx.fadeClings(2);                                // ★ 页面在 setWeather() 里就是这么调的
        push(fx, 1, 6100);
        const n1 = fx.caps()[0].amt;                     // 第一帧：还在（不是瞬间没）
        push(fx, 114, 6200);
        const n2 = fx.caps()[0].amt;                     // +1.9 秒：快没了
        push(fx, 30, 6400);
        const n3 = fx.caps()[0].amt;                     // +2.4 秒：没了
        ok(`★雪帽：切天气时**缓缓淡出**（满雪量 ${n0.toFixed(2)} → 1 帧后 ${n1.toFixed(2)} → 1.9 秒后 ${n2.toFixed(2)}`
          + ` → 2.4 秒后 ${n3.toFixed(2)}）—— 用户要的"不能留着、也不能瞬间没"`,
        n0 > .95 && n1 > .95 && n2 > 0 && n3 === 0);

        for (let i = 0; i < 3; i += 1) landAt(fx, 'snow', crownX, 6600 + i * 20, 60, i === 0);
        const soft = (fx.clear(), fx.capLoad);
        fx.clear(true);
        const hard = fx.capLoad;
        ok(`★雪帽：\`clear()\`（切天气走的那条路）**不硬清雪**，\`clear(true)\` 才是硬清`
          + `（软清后还剩 ${soft.toFixed(2)}、硬清后 ${hard.toFixed(2)}）`,
        soft > .9 && hard === 0);
      }

      /* ---------- ⑬ 诊断轮廓：开了 `fxbox` 画的就是**她自己那条线** ---------- */
      {
        setXf({}); fx.actor(null); fx.actor(snapOf());
        fx.surface(SURF_JSON);
        fx.clear(true);
        fx.debugBox(true);
        let t = 7000;
        t += 1 / 60; fx.frame(1 / 60, t, 'off');
        const st = fx.stats();
        const out = st.list.filter((q) => q.shape === 'outline');
        ok(`★真实轮廓：\`fxbox\` 打开时画的是**她的轮廓线**（上沿 + 下沿两笔 = ${out.length} 个），`
          + `不是两个判定圆 —— "盒子有没有对上她"从这一笔就能看出来`,
        out.length === 2 && st.meta.box === 2);
        fx.debugBox(false);
        fx.surface(null);
      }

      /* ---------- ⑭ 性能：满屏粒子下"物理"每帧多花多少 ---------- */
      {
        const bench = (withHer) => {
          fx.clear(true); fx.actor(null); setXf({});
          if (withHer) fx.actor(snapOf());
          let t = 300;
          for (let i = 0; i < 120; i += 1) { t += 1 / 60; fx.frame(1 / 60, t, 'rain', 3); }   // 先灌到天花板
          let ms = 0;
          const N = 300;
          for (let i = 0; i < N; i += 1) { t += 1 / 60; fx.frame(1 / 60, t, 'rain', 3); ms += fx.spendPhys(); }
          return { avg: ms / N, n: fx.count };
        };
        const without = bench(false), withHer = bench(true);
        const add = withHer.avg - without.avg;
        ok(`★天气互动：满屏粒子（${withHer.n} 颗）下"物理"只多花 **${add.toFixed(3)}ms/帧**`
          + `（无她 ${without.avg.toFixed(3)} → 有她 ${withHer.avg.toFixed(3)}；门槛 0.5ms）`
          + ' —— 每颗就多两次圆的"在不在里面"',
        add < .5 && withHer.avg < 1.2);
      }

      /* ---------- ⑮ 性能（真实轮廓那条判定）：同一天气、有表 vs 没表 ---------- */
      {
        const bench2 = (withSurf) => {
          fx.clear(true); fx.actor(null); setXf({});
          if (withSurf) fx.surface(SURF_JSON); else fx.surface(null);
          fx.actor(snapOf());
          let t = 900;
          for (let i = 0; i < 120; i += 1) { t += 1 / 60; fx.frame(1 / 60, t, 'snow', 3); }
          let ms = 0;
          const N = 300;
          for (let i = 0; i < N; i += 1) { t += 1 / 60; fx.frame(1 / 60, t, 'snow', 3); ms += fx.spendPhys(); }
          return { avg: ms / N, n: fx.count };
        };
        const circ = bench2(false), surf = bench2(true);
        ok(`★真实轮廓：换成"她自己的轮廓"判定之后，物理每帧是 ${surf.avg.toFixed(3)}ms`
          + `（两个圆那条是 ${circ.avg.toFixed(3)}ms，差 ${(surf.avg - circ.avg).toFixed(3)}ms）`
          + ' —— 每颗多两次逆变换 + 两次查表，跟两个圆一个量级',
        surf.avg < 1.2);
        fx.surface(null);
      }
    } finally {
      if (had.win) globalThis.window = saved.win; else delete globalThis.window;
      if (had.doc) globalThis.document = saved.doc; else delete globalThis.document;
      if (had.ls) globalThis.localStorage = saved.ls; else delete globalThis.localStorage;
      if (had.p2) globalThis.Path2D = saved.p2; else delete globalThis.Path2D;
    }
  },
};
