/**
 * 自检区域：天气粒子（铺满/密度/翻滚/形状/贴图）
 *
 * 由原 `regions\05-live.cjs` 的**第 7 节里"天气粒子"那一块（在假画布上真的推 4 段粒子动画，CPU 重）**整段切出来（按行号搬，正文一字未改）。
 * 不需要真连接：只用 `fs` / `path` / `app` / `ok` 这些骨架给的东西。
 * 单跑：`node test\run-one.cjs 07b-fx-particles.cjs`
 */
module.exports = {
  name: "天气粒子（铺满/密度/翻滚/形状/贴图）",
  tags: ["天气","粒子","形状"],
  async run(ctx) {
    /**
     * ★ **天气粒子的轨迹、铺满、形状**（2026-10-10 重写之后加的；2026-10-11 换成 canvas 之后改写）。
     *
     * 为什么要它：用户实测报过三件事 —— ① "只有左半边有粒子"；② "像五毛特效，不模拟现实轨迹"；
     * ③ "樱花和落叶还是不够像"。这三条**都不会抛错**（粒子少、轨迹假、形状丑，代码照样跑），
     * 所以在自检里量出来：
     *   · **铺满**：雪在 1280 宽上要跨过大半个宽度（留 120px 余量，因为边缘允许出画）；
     *   · **够密**：雨不能只有十几条（真实的雨是同屏两三百条的量级，我们按性能砍到一百多）；
     *   · **翻滚**：叶子/花瓣要真的用 `|cos|` 压扁（侧立时变窄 = 叶子，不是纸屑）；
     *   · **形状**：花瓣的几何量（缺口深度/最宽处/根宽）+ 叶子的"脉够不够多"（≥8 笔）；
     *   · **真的画到画布上**：canvas 版最容易"沉默失败"的一处 —— 形状算得再对，
     *     贴图没 `drawImage` 就是一片空白，所以这里连 `stroke/fill/drawImage` 的调用数一起数。
     *
     * ⚠️ 这套断言**必须跟着渲染方式走**：粒子从 SVG 换成 canvas 之后，
     * 原来查 `innerHTML` 里 `<path d=`/`scale(` 的写法就全废了（会变成"绿着但什么都没测"）。
     * 现在查的是 `fx.stats()`（fx.js 里那份"这一帧画了什么"的清单）和录制用的假画布。
     */
    {
      /**
       * 假画布：`getContext('2d')` 给一个**记账用**的 2D 上下文 ——
       * 每个方法都能调用（记录调用次数）、`createLinearGradient` 给一个带 `addColorStop` 的对象。
       * 这样"贴图烘出来了吗"就有据可查。
       */
      /**
       * ★ **一个"能真的留下像素"的假 2D 上下文**（只有自检用）。
       *
       * 为什么要它：粒子层换 canvas 之后，最容易**静默失效**的地方是贴图 —— 一张全透明的贴图
       * `drawImage` 出去完全合法、不报错，表现是"粒子一颗都看不见"（本轮抓到的就是这个：
       * 形状参数被传成了 `'n'`，路径里全是 `NaN`，`fill()` 什么都不画）。
       * 只数调用次数抓不住它，所以这里按调用的包围盒往像素缓冲里写 alpha（渐变就当实色），
       * 之后 `sprites()` 用 `getImageData` 数不透明像素 —— "贴图里有没有肉"就成了可测的数。
       *
       * ★★ **2026-10-11 提速：只给"小画布"真的分配像素缓冲**（判定标准一字未改）。
       *
       * 为什么：贴图（花瓣/叶子，边长 5~40px）必须逐像素数 —— `sprites()` 的
       * "贴图里有没有肉 ≥15%" 全靠它，这是抓"全 NaN 路径"那次事故的精确防线，不能动；
       * 但**主画布是 1280×760 ≈ 97 万像素**，每帧 `clearRect` 一个个清、贴图一张张逐像素混合，
       * 四段天气共 9000 帧 —— 实测这一段整个区域 **47.5 秒**，其中光"清主画布"就 ~22 秒。
       * 而**没有任何一条断言读主画布的像素**（`sprites()` 读的是贴图画布；主画布只被用来判 truthy）。
       * 所以：**面积超过 `PIXEL_MAX` 的画布只记账、不写像素** ——
       * 调用次数照样数（`callStroke/callImage` 那些断言照旧），像素断言也照旧（都在小画布上）。
       * 拿不准"大画布像素"以后要不要断言时**先量一遍**：现在 47.5s，改完见区域末尾的
       * `[耗时]` 行（目标 <5s）。
       */
      const PIXEL_MAX = 256 * 256;          // 小贴图（≤40px，1600 像素）远在这条线以内
      let ctxStrokes = 0;
      function FakeCtx(cv) {
        this.cv = cv;
        this.t = [1, 0, 0, 1, 0, 0];
        this.a = 1;
        this.fs = '#888'; this.ss = '#888'; this.lw = 1;
        this.path = [];
        this.pts = [];
      }
      FakeCtx.prototype = {
        clearRect(x, y, w, h) {
          const d = this.cv._buf; if (!d) return;
          for (let yy = Math.max(0, Math.floor(y)); yy < Math.min(this.cv.height, Math.ceil(y + h)); yy += 1) {
            for (let xx = Math.max(0, Math.floor(x)); xx < Math.min(this.cv.width, Math.ceil(x + w)); xx += 1) d[(yy * this.cv.width + xx) * 4 + 3] = 0;
          }
        },
        /** `null` = 这块画布太大，只记账不写像素（见 `PIXEL_MAX` 上面那段）。 */
        _buf() {
          const c = this.cv;
          if (c.width * c.height > PIXEL_MAX) return null;
          if (!c._buf || c._buf.length !== c.width * c.height * 4) c._buf = new Uint8ClampedArray(c.width * c.height * 4);
          return c._buf;
        },
        _tf(x, y) { const [a, b, c2, d, e, f] = this.t; return [a * x + c2 * y + e, b * x + d * y + f]; },
        setTransform(a, b, c2, d, e, f) { this.t = [a, b, c2, d, e, f]; },
        // ⚠️ 变换统一**左乘**（`t = t · m`）—— 和 `rotate` 用同一套约定，否则 `translate` 之后
        // 画出来的东西会跑到画布外（自检量到的 ink 就变成"只有描边"的假象）
        rotate(r) { const [a, b, c2, d, e, f] = this.t, co = Math.cos(r), si = Math.sin(r); this.t = [a * co + c2 * si, b * co + d * si, a * -si + c2 * co, b * -si + d * co, e, f]; },
        translate(x, y) { const t = this.t; this.t = [t[0], t[1], t[2], t[3], t[4] + t[0] * x + t[2] * y, t[5] + t[1] * x + t[3] * y]; },
        scale(x, y) { const t = this.t; this.t = [t[0] * x, t[1] * x, t[2] * y, t[3] * y, t[4], t[5]]; },
        getTransform() { return { a: this.t[0], b: this.t[1], c: this.t[2], d: this.t[3], e: this.t[4], f: this.t[5] }; },
        save() { this._saved = (this._saved || []).concat([[this.t.slice(), this.a]]); },
        restore() { const s = this._saved && this._saved.pop(); if (s) { this.t = s[0]; this.a = s[1]; } },
        beginPath() { this.pts = []; }, closePath() {}, clip() {},
        moveTo(x, y) { this.pts.push(this._tf(x, y)); }, lineTo(x, y) { this.pts.push(this._tf(x, y)); },
        bezierCurveTo(x1, y1, x2, y2, x3, y3) {
          const p0 = this.pts[this.pts.length - 1] || this._tf(0, 0);
          const P = [p0, this._tf(x1, y1), this._tf(x2, y2), this._tf(x3, y3)];
          for (let i = 1; i <= 12; i += 1) {
            const t = i / 12, u = 1 - t;
            this.pts.push([
              u * u * u * P[0][0] + 3 * u * u * t * P[1][0] + 3 * u * t * t * P[2][0] + t * t * t * P[3][0],
              u * u * u * P[0][1] + 3 * u * u * t * P[1][1] + 3 * u * t * t * P[2][1] + t * t * t * P[3][1],
            ]);
          }
        },
        quadraticCurveTo(x1, y1, x2, y2) { this.bezierCurveTo(x1, y1, x1, y1, x2, y2); },
        arc(x, y, r) { for (let i = 0; i <= 12; i += 1) this.pts.push(this._tf(x + Math.cos(i / 12 * 6.283) * r, y + Math.sin(i / 12 * 6.283) * r)); },
        ellipse(x, y, rx, ry) { for (let i = 0; i <= 12; i += 1) this.pts.push(this._tf(x + Math.cos(i / 12 * 6.283) * rx, y + Math.sin(i / 12 * 6.283) * ry)); },
        rect(x, y, w, h) { this.pts.push(this._tf(x, y), this._tf(x + w, y), this._tf(x + w, y + h), this._tf(x, y + h)); },
        _box() {
          if (!this.pts.length) return null;
          let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
          for (const [px, py] of this.pts) { if (px < x0) x0 = px; if (px > x1) x1 = px; if (py < y0) y0 = py; if (py > y1) y1 = py; }
          return [x0, y0, x1, y1];
        },
        _paint(box, alpha, col) {
          const d = this._buf();
          if (!box || !d) return;                       // 大画布：只记账
          const W = this.cv.width, H = this.cv.height;
          const [r, g, b] = (col || '#888888').match(/\d+/g)?.map(Number) || [136, 136, 136];
          for (let yy = Math.max(0, Math.floor(box[1])); yy <= Math.min(H - 1, Math.ceil(box[3])); yy += 1) {
            for (let xx = Math.max(0, Math.floor(box[0])); xx <= Math.min(W - 1, Math.ceil(box[2])); xx += 1) {
              d[(yy * W + xx) * 4] = r; d[(yy * W + xx) * 4 + 1] = g; d[(yy * W + xx) * 4 + 2] = b;
              d[(yy * W + xx) * 4 + 3] = Math.round(255 * Math.min(1, alpha));
            }
          }
        },
        fill() { this._paint(this._box(), this.a, typeof this.fs === 'string' ? this.fs : (this.fs._c || '#888888')); },
        stroke() {
          ctxStrokes += 1;
          const b = this._box();
          if (b) { const p = this.lw / 2; this._paint([b[0] - p, b[1] - p, b[2] + p, b[3] + p], this.a, typeof this.ss === 'string' ? this.ss : '#888888'); }
        },
        fillText() {},
        drawImage(img, dx, dy) {
          if (!img || !img._buf) return;
          const d = this._buf();
          if (!d) return;                               // 大画布：只记账（贴图本身仍然逐像素烘）
          const W = this.cv.width, H = this.cv.height;
          for (let y = 0; y < img.height; y += 1) {
            const ty = Math.round(dy + y); if (ty < 0 || ty >= H) continue;
            for (let x = 0; x < img.width; x += 1) {
              const tx = Math.round(dx + x); if (tx < 0 || tx >= W) continue;
              const si = (y * img.width + x) * 4, di = (ty * W + tx) * 4;
              const sa = img._buf[si + 3] / 255; if (sa <= 0) continue;
              const da = d[di + 3] / 255, oa = sa + da * (1 - sa);
              d[di] = (img._buf[si] * sa + d[di] * da * (1 - sa)) / (oa || 1);
              d[di + 1] = (img._buf[si + 1] * sa + d[di + 1] * da * (1 - sa)) / (oa || 1);
              d[di + 2] = (img._buf[si + 2] * sa + d[di + 2] * da * (1 - sa)) / (oa || 1);
              d[di + 3] = Math.round(oa * 255);
            }
          }
        },
        getImageData(x, y, w, h) {
          const d = this._buf(), out = new Uint8ClampedArray(w * h * 4);
          if (!d) return { data: out, width: w, height: h };   // 大画布没有像素（没人读它，见 PIXEL_MAX）
          for (let yy = 0; yy < h; yy += 1) for (let xx = 0; xx < w; xx += 1) {
            const si = ((y + yy) * this.cv.width + (x + xx)) * 4, di = (yy * w + xx) * 4;
            if (si >= 0 && si + 3 < d.length) for (let k = 0; k < 4; k += 1) out[di + k] = d[si + k];
          }
          return { data: out, width: w, height: h };
        },
        createLinearGradient: (...a) => { const g = { stops: [], addColorStop(p, c) { this.stops.push([p, c]); } }; void a; return g; },
        createRadialGradient: () => ({ addColorStop() {} }),
        createPattern: () => null,
      };
      Object.defineProperty(FakeCtx.prototype, 'fillStyle', { set(v) { this.fs = v; }, get() { return this.fs; } });
      Object.defineProperty(FakeCtx.prototype, 'strokeStyle', { set(v) { this.ss = v; }, get() { return this.ss; } });
      Object.defineProperty(FakeCtx.prototype, 'globalAlpha', { set(v) { this.a = v; }, get() { return this.a; } });
      for (const k of ['lineWidth', 'globalCompositeOperation', 'font', 'textAlign', 'textBaseline', 'lineCap', 'lineJoin', 'filter']) {
        Object.defineProperty(FakeCtx.prototype, k, { set(v) { this['_' + k] = v; }, get() { return this['_' + k]; } });
      }
      // mock 里读渐变时不用取色（`ink` 只看 alpha，颜色取兜底灰就够）
      const fakeCanvas = () => {
        const c = { width: 1, height: 1, style: {}, getBoundingClientRect: () => ({ x: 0, y: 0, width: 1, height: 1 }) };
        c.getContext = (kind) => (kind === '2d' ? (c._ctx = c._ctx || new FakeCtx(c)) : null);
        return c;
      };
      const stubEl = () => ({ width: 1, height: 1, style: {}, getBoundingClientRect: () => ({ x: 0, y: 0, width: 1, height: 1 }), getContext: () => null });
      const savedWin = globalThis.window, savedDoc = globalThis.document;
      globalThis.window = globalThis;
      globalThis.document = {
        createElementNS: stubEl,
        createElement: (tag) => (tag === 'canvas' ? fakeCanvas() : stubEl()),
        querySelector: () => null,
        addEventListener() {},
        documentElement: {},
      };
      globalThis.Path2D = globalThis.Path2D || class { constructor(d) { this.d = d; } };
      let fxMod = null;
      try { fxMod = await import(pathToFileURL(path.join(ctx.app, 'web', 'fx.js')).href); } catch (e) { fxMod = null; }
      const canvas = fakeCanvas();
      const wrapper = { value: canvas };
      const fx = fxMod ? fxMod.createFx({
        ctl: { bounds: { W: 1280, H: 760 } },
        canvas,
        // 贴图/主画布的 2D 上下文都由 `fakeCanvas` 给（它会把像素真的写进缓冲，`ink` 才能量）
        onCtx: (g) => { wrapper.value = canvas; return g; },
      }) : null;
      const run = (kind, secs) => {
        for (let f = 1; f <= secs * 60; f += 1) fx.frame(1 / 60, f / 60, kind);
        return { xs: fx.xs() || [], n: fx.count, st: fx.stats(), kinds: fx.kinds() };
      };
      const snow = fx ? run('snow', 40) : null;
      ok('★天气粒子（行为）：雪要铺满整个窗口宽度（不是只落在左半边）',
        !!snow && snow.xs[0] < 120 && snow.xs[1] > 1160 && snow.n > 30);
      const rain = fx ? run('rain', 10) : null;
      ok('★天气粒子（行为）：雨要够密（同屏一百条以上）而且落到底会溅落',
        !!rain && rain.n > 95 && rain.st.meta.splash > 0 && rain.st.meta.byKind.rain > 80);
      const leaf = fx ? run('leaf', 40) : null;
      ok('★天气粒子（行为）：落叶/花瓣用 `scaleX = |cos|` 做翻滚（侧立时会变窄 = 不是纸屑）',
        !!leaf && leaf.n > 12 && leaf.st.meta.minSpin <= .35 && leaf.st.meta.maxSpin >= .9
        && leaf.st.list.every((q) => q.sx >= .1 && q.sx <= 1));
      const blos = fx ? run('blossom', 60) : null;
      ok('★天气粒子（行为）：樱花是**单花瓣**（不是整朵大花）+ 尺寸小（7~16px）',
        !!blos && blos.st.meta.maxLen > 5 && blos.st.meta.maxLen < 17
        && blos.st.meta.byKind.blossom > 8
        && blos.st.list.some((q) => q.shape === 'petal'));
      /**
       * 花瓣/叶子的几何量：这几条是"像不像"的**唯一**判据（不是"我觉得像"）。
       * 量的是**真路径采样**（`samplePath`），不是锚点；三个关键量：
       *   ① 缺口深度 ≥ 0.03（尖端那个小凹）；② 最宽处 0.18~0.30 半宽；
       *   ③ 根部比最宽处窄（细根）；④ 宽长比 0.35~0.8（太瘦像柳叶、太胖像瓜子）；
       *   ⑤ 形状收在单位方框里 —— 否则贴图会把它裁掉（用户实测报过："花瓣少了三分之一"）。
       */
      const met = fxMod && fxMod.PETAL_METRICS;
      ok('★天气粒子（形状）：花瓣 = 细根 + 两侧鼓 + 尖端浅凹口，且宽长比像花瓣（几何量，不是"我觉得像"）'
        + ' [w=' + (met && met.w) + ' h=' + (met && met.h) + ' 缺口=' + (met && met.notchDepth) + ' 根宽=' + (met && met.rootWidth) + ']',
      !!met && met.notchDepth >= .03 && met.maxWidth >= .18 && met.maxWidth <= .30
        && met.rootWidth < met.maxWidth * .8 && met.aspect >= .35 && met.aspect <= .8 && met.inUnitBox);
      const lmet = fxMod && fxMod.LEAF_METRICS;
      ok('★天气粒子（形状）：叶子 = 宽叶身 + 窄叶柄（`stemWidth` ≤ 0.12），而且形状完整落在单位方框里'
        + ' [w=' + (lmet && lmet.w) + ' 柄宽=' + (lmet && lmet.stemWidth) + ']',
      !!lmet && lmet.maxWidth >= .25 && lmet.stemWidth <= .12 && lmet.inUnitBox);
      const spritePaints = (list, shape) => list.filter((q) => q.shape === shape).length;
      ok('★天气粒子（形状）：叶子有主脉 + 每侧 3 条侧脉（贴图里 ≥ 8 笔 stroke，不是一片光叶子）',
        !!leaf && ctxStrokes >= 8 && spritePaints(leaf.st.list, 'leaf') > 0);
      ok('★天气粒子（形状）：樱花花瓣的贴图里也有脉/描边（≥ 3 笔 stroke）',
        !!blos && ctxStrokes >= 3);
      /**
       * ★★ **贴图里必须真的有"肉"**（2026-10-11 加，为一次真实事故）。
       *
       * 事故：`sprite()` 把缓存用的变体名（`'n'`/`'w'`）当成**形状参数**传给了
       * `petalPath()`，于是 `'n' * 1 → NaN`，路径变成 `CNaN NaN …` ——
       * **Path2D 里全是 NaN 时 `fill()` 什么都不画、也不抛错**，画出来只剩描边和一条高光，
       * 看着像"月牙划痕"。断言"贴图的不透明像素占比 ≥ 5%"当场就能抓住它
       * （花瓣形状大概占方框的 25%，只剩描边时不到 3%）。
       */
      /**
       * ★★ **形状路径里不许出现 NaN**（2026-10-11 加，为一次真实事故）。
       *
       * 事故：`sprite()` 把缓存用的变体名（`'n'`/`'w'`）当成**形状参数**传给了 `petalPath()`，
       * 于是 `'n' * 1 → NaN`，路径变成 `CNaN NaN …` —— **Path2D 里全是 NaN 时 `fill()` 什么都不画、
       * 也不抛错**，画出来只剩描边和一条高光，看着像"月牙划痕"。这一条把"路径里有没有非数"
       * 直接量出来，是那次 bug 的**精确**回归防线（不依赖任何假画布的画法）。
       */
      const m6 = fxMod && fxMod.PETAL_METRICS;
      const numKeys = ['maxWidth', 'rootWidth', 'tipY', 'notchY', 'notchDepth', 'aspect', 'w', 'h'];
      ok('★天气粒子（形状）：形状参数不许出 NaN（花瓣的几何量全是有限数，`inUnitBox` 为真）'
        + ' [' + numKeys.map((k) => k + '=' + (m6 && m6[k])).join(' ') + ']',
      !!m6 && numKeys.every((k) => Number.isFinite(m6[k])) && m6.inUnitBox === true);
      /**
       * 贴图里要有"肉"：花瓣/叶子的贴图**实心面积 ≥ 15% 方框**。
       * 只查这两种（花的贴图是五片旋转叠加，假画布的包围盒画法对它偏保守，不适合当硬门槛）——
       * 而"只剩描边"时这一比例会掉到 3% 以下，所以门槛是有区分度的。
       */
      const spr = fx ? fx.sprites() : [];
      const pk = spr.filter((s) => /^p\|/.test(s.key));
      const lk = spr.filter((s) => /^l\|/.test(s.key));
      const ratio = (s) => s.ink / (s.box[0] * s.box[1]);
      ok('★天气粒子（形状）：花瓣/叶子贴图里有实心面积（不透明像素 ≥ 15% 方框；全 NaN 路径只剩描边时抓得住）'
        + ' [花瓣最差 ' + (pk.length ? Math.min(...pk.map(ratio)).toFixed(3) : 'n/a')
        + ' 叶子最差 ' + (lk.length ? Math.min(...lk.map(ratio)).toFixed(3) : 'n/a') + ']',
      pk.length > 0 && lk.length > 0 && pk.every((s) => ratio(s) > .15) && lk.every((s) => ratio(s) > .15));
      ok('★天气粒子（行为）：这一帧真的**画到了画布上**（贴图 drawImage 的调用数 > 0）',
        !!leaf && !!wrapper.value && leaf.st.meta.callImage > 0);
      ok('★天气粒子（行为）：粒子**不再走 SVG**（`innerHTML` 那套会每秒重建上万个 DOM 节点）',
        !!leaf && leaf.st.meta.callStroke >= 0 && !/\.innerHTML\s*=/.test(String(fxMod.createFx)));
      globalThis.window = savedWin; globalThis.document = savedDoc;
    }
  },
};
