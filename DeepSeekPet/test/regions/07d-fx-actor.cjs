/**
 * 自检区域：天气 ↔ 她的互动（第 ③ 项 ③a：雨溅落 / 樱叶擦身 / 走动带风 / 判定盒子）
 *
 * **为什么这么测**：这一项的实质是**几何**（"她身上"到底是画布上的哪一块）+ **三条分支**
 * （雨打到就死并溅一圈、樱/落叶被推歪且升到近层、她在走时给前方粒子加一条风）。
 * 查字符串一条也证明不了，所以两头都用**真的**：`web\pet-core.js` 在 Node 里真建起来
 * （拿它自己的 `toStage` / `hitPet` 当基准），`web\fx.js` 真跑（真发射、真推物理、真算命中）。
 *
 * 钉住的几条：
 *   ① **盒子就是她**：fx 的命中判定与 pet-core 的两个判定圆（`hitPet` 同源）逐点一致；
 *      "本地 → 舞台"与 `ctl.toStage` 逐点一致（含**朝左（kx 为负）**与**带倾角**两种姿态）；
 *   ② **雨**：打在她身上 → 那一颗死掉 + 在**入射点**（她轮廓上，不是肚子中间）溅一圈；
 *   ③ **樱/落叶**：擦一下**不死**、被推歪、下落变慢、并**升到近层**（否则在她身后看不见）；
 *   ④ **走动带风**：她在走 → 前方粒子被带一下；**身后**的不受影响；
 *   ⑤ **没有她时一次命中都没有**（回归：这一套整体关闭，`07b` 那 12 条一字不变）；
 *      音符（从她嘴边冒出来的）**不算命中她**；
 *   ⑥ **性能**：满屏粒子下"物理"每帧多出来的时间（实测数字直接打进 ok 的名字里）。
 *
 * 不需要真连接、不需要像素（假画布只记账不写像素，见 `07b` 的 `PIXEL_MAX`），跑起来 1 秒级。
 * 单跑：`node test\run-one.cjs 07d-fx-actor.cjs`
 */
module.exports = {
  name: '天气与她的互动（盒子/雨溅落/擦身/走动带风/性能）',
  tags: ['天气', '粒子', '互动', '她'],
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
        fx.clear(); fx.actor(null); fx.actor(snapOf());
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
        fx.clear(); fx.actor(null);
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
        fx.clear(); fx.actor(null); fx.actor(snapOf());
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
          fx.clear();
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
          fx.clear(); fx.actor(null); setXf({});
          let petX = 640;
          const place = () => { setXf({ AX: petX }); fx.actor(snapOf({ moving: walking })); };
          place();
          const c1 = fx.actorBox().c1;
          spawnSnow(c1.x + offset, c1.y);
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
        fx.clear();
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

      /* ---------- ⑨ 性能：满屏粒子下"物理"每帧多花多少 ---------- */
      {
        const bench = (withHer) => {
          fx.clear(); fx.actor(null); setXf({});
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
    } finally {
      if (had.win) globalThis.window = saved.win; else delete globalThis.window;
      if (had.doc) globalThis.document = saved.doc; else delete globalThis.document;
      if (had.ls) globalThis.localStorage = saved.ls; else delete globalThis.localStorage;
      if (had.p2) globalThis.Path2D = saved.p2; else delete globalThis.Path2D;
    }
  },
};
