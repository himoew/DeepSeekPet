/**
 * 自检区域：球拍模式
 * 从原 `test\smoke.cjs` 切出来的，**代码一字未改**（只把裸模块名换成 `ctx.*`）。
 * 单跑：`node test\smoke.cjs game`
 */
module.exports = {
  name: "球拍模式",
  tags: ['ball', '球拍', 'game'],
  async run(ctx) {
    const { __mark, FILES, fs, path, pathToFileURL, http, pet, lines, llm, store, checkLines, pageAreas, pageStages, pageGrabParts,
      textsOf, textsFilled, base, port, WebSocket, ok } = ctx;
    /** DOM 桩：这一段用它把 ball.js / game.js 在 Node 里跑起来（原文件里由 2g 那块设好）。 */
    const hadDoc = 'document' in globalThis;
    const hadHost = 'petHost' in globalThis;
    const nsCalls = [];
    const fakeEl = () => ({
      attrs: {},
      children: { length: 1 },
      appendChild() {},
      setAttribute(k, v) { this.attrs[k] = v; },
      getAttribute(k) { return this.attrs[k]; },
      querySelector() { return null; },
      getBoundingClientRect: () => ({ width: 0, height: 0 }),
      set innerHTML(v) { this._html = v; },
      get innerHTML() { return this._html; },
      parentNode: { appendChild() {} },
    });
    if (typeof document === 'undefined') globalThis.document = { createElementNS: (ns) => { nsCalls.push(ns); return fakeEl(); } };
    if (typeof petHost === 'undefined') globalThis.petHost = { report: () => {} };
  /* ---------- 2g-4. 球拍模式：比赛模式里球不能抓、只能打 ---------- */
  /**
   * 用户的想法：**"在比赛模式里球不能抓，只能被鼠标打回去"**。
   * 这一条正好治了赖皮 —— 不能把球拎到门口再放下，只能隔着场地抽进网。
   *
   * 这一段自己准备 DOM 桩（上面那个 `finally` 已经把 2g 的桩收掉了）。
   */
  try {
    if (typeof document === 'undefined') globalThis.document = { createElementNS: () => fakeEl() };
    if (typeof petHost === 'undefined') globalThis.petHost = { report: () => {} };
    try {
      const { createBall } = await import(`${pathToFileURL(path.join(ctx.app, 'web', 'ball.js')).href}?smoke=${Date.now()}`);
      const { createGame } = await import(`${pathToFileURL(path.join(ctx.app, 'web', 'game.js')).href}?smoke=${Date.now()}`);
      const B = { W: 1280, H: 760, floorY: 758, minX: 0, maxX: 1280, S: 0.42 };
      const pet = { x: 900, faceVis: 1, feetY: B.floorY };
      const ball = createBall({
        fxG: fakeEl(), sfx: {},
        stage: { bounds: () => B, pet: () => pet },
        onEvent: () => {},
        game: { onStep: null, onKick: () => {} },
      });
      const game = createGame({
        fxG: fakeEl(), ball, sfx: {},
        control: { bounds: () => B, pet: () => pet, walkTo() {}, jump() {}, act() {} },
        onEvent: () => {},
      });
      ball.setOn(true, { fromLeft: false });
      game.setMode('game');                    // 先切模式（球拍模式在这里被打开）
      /**
       * ⚠️ 摆球的位置很讲究：`placeAt(0.5, 'floor')` 的高度是**低于门框**的，
       * 而"球在门框高度以下且落在门柱之间"就是进球 —— 我摆球的那一下会被算成进球、球被自动开走
       * （自检就是这么反复"偶发失败"的，真原因跟随机无关）。所以这里用**门框以上的高度**摆球。
       */
      ball.placeAt(0.5, B.floorY - 300, { since: 0 });
      const cx = ball.x, cy = ball.y;
      ok('球拍模式：比赛模式里抓不住球（hitTest 失效）', ball.grabable === false && ball.hitTest(cx, cy) === false);
      ok('球拍模式：抓不住，但仍然"够得着"（不然打不着）', ball.near(cx, cy) === true);
      ball.placeAt(0.5, B.floorY - 300, { since: 0 });
      const beforeX = ball.x;
      /**
       * **轻点也要能打**（用户实测：他只是"点"了一下球、鼠标速度 2px/s，
       * 我最初判"推不动" → 完全没反应）。所以现在的判据是"轻点给一个**小**力度"，
       * 而不是"给 0"。真正防赖皮靠的是 `hitTest` 永远不通过（球拖不走），不是靠"推不动"。
       */
      const tap = ball.swat({ x: 40, y: 0 }, 2);
      ok('球拍模式：轻轻点一下也能把球推出去（实测两轮定下来的手感）',
        tap >= 300 && ball.state.vx !== 0);
      // 而且球**不能被拖着走**：拖动接口在球拍模式下不生效（grabable=false 时 drag 也只当没抓住）
      ball.placeAt(0.5, B.floorY - 300, { since: 0 });
      ok('球拍模式：球不会被"抓住拖着走"（防赖皮的真正保障）',
        ball.grabable === false && ball.hitTest(ball.x, ball.y) === false && Math.abs(ball.x - beforeX) < 1);
      ball.placeAt(0.5, B.floorY - 300, { since: 0 });
      const fast = ball.swat({ x: 1, y: -0.2 }, 1200);     // 用力抽：球飞出去
      ok('球拍模式：甩得快球就被打出去（而且比轻点更猛）',
        fast > 300 && fast > tap && ball.state.vx > 0 && ball.state.resting === false);

      /**
       * ★ **核心机制：鼠标扫过球就踢（不需要点击）**。
       *
       * 这是用户实测后定的新模型（原话："鼠标接触球就跟小人踢出去一样的状态"）。
       * 判据：把光标从球的一侧"扫"到另一侧，**一帧之内**球就该被踢出去、方向跟着扫动方向。
       * 这里用两次 `setCursor` 造出"上一帧 → 这一帧"的扫掠线段，再走一帧物理。
       */
      ball.placeAt(0.5, 'floor', { since: 0 });
      const kx = ball.x, ky = ball.y;
      // 左 → 右扫过球（用真实时间戳，让球自己算扫掠速度）
      const t0 = performance.now();
      ball.setCursor(kx - 60, ky, t0);
      ball.setCursor(kx + 60, ky, t0 + 16);
      for (let i = 0; i < 3; i += 1) ball.step(1 / 60);
      ok('球拍模式：★鼠标扫过球就把它踢出去（不需要点击）',
        ball.state.vx > 50 && ball.state.resting === false);
      ok('球拍模式：★踢出去的方向跟着鼠标扫动的方向（往右扫 → 往右飞）', ball.state.vx > 0);
      game.setMode('ball');
      ok('球拍模式：回到自由玩球时又能抓了', ball.grabable === true);
      game.setMode('off');
    } catch (err) {
      ok(`球拍模式：抓/打的行为（不抛错）—— 实际抛了 ${err && err.message}`, false);
    }
  } finally {
    if (hadDoc) delete globalThis.document; else delete globalThis.document;
    if (hadHost) delete globalThis.petHost; else delete globalThis.petHost;
  }
  },
};
