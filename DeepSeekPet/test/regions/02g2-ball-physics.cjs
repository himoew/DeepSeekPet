/**
 * 自检区域：玩具球物理
 * 从原 `test\smoke.cjs` 切出来的，**代码一字未改**（只把裸模块名换成 `ctx.*`）。
 * 单跑：`node test\smoke.cjs ball`
 */
module.exports = {
  name: "玩具球物理",
  tags: ['ball', '玩具球', '物理'],
  async run(ctx) {
    const { __mark, FILES, fs, path, pathToFileURL, http, pet, lines, llm, store, checkLines, pageAreas, pageStages, pageGrabParts,
      textsOf, textsFilled, base, port, WebSocket, ok } = ctx;
    /** 这一段原来接着 2g 那一块跑（appSrc / nsCalls / DOM 桩是那边备好的）：单跑要自己备一份。 */
    const appSrc = fs.readFileSync(path.join(app, 'web', 'pet-app.js'), 'utf8');
    const ballSrc = fs.readFileSync(path.join(app, 'web', 'ball.js'), 'utf8');
    {
      // `nsCalls` 名字跟下面这一段自己的同名变量撞，所以包一层块作用域：这里只负责"被调过就记录"
      const nsCalls = [];
      if (typeof document === 'undefined') globalThis.document = { createElementNS: (ns) => { nsCalls.push(ns); return undefined; } };
      if (typeof petHost === 'undefined') globalThis.petHost = { report: () => {} };
    }
    /* ---------- 2g-2. 玩具球：把它真跑起来（动态检查 + 物理推演） ---------- */
    /**
     * 静态检查证明不了"画出来了"，也证明不了"拖着不乱弹"。所以这里用最小 DOM 桩
     * **把 `web/ball.js` 真的 import 起来跑**：
     *   ① 构造时只用 `createElementNS`（**`innerHTML` 在 SVG 元素上按 HTML 解析，
     *      `<circle>` 会落进 HTML 命名空间 → 元素在 DOM 里但一个像素都不画**，这个坑实测踩过）；
     *   ② 落地后 6 秒内必须**停稳**（不是每帧都在弹）；
     *   ③ 拖着的一秒里不许有速度残留（"抓住拖动一直乱弹直到飞走"就是这么来的）。
     */
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
    const hadDoc = Object.prototype.hasOwnProperty.call(globalThis, 'document');
    const hadHost = Object.prototype.hasOwnProperty.call(globalThis, 'petHost');
    globalThis.document = { createElementNS: (ns, tag) => { nsCalls.push(ns); return fakeEl(); } };
    globalThis.petHost = { report: () => {} };
    try {
      const { createBall } = await import(`${pathToFileURL(path.join(ctx.app, 'web', 'ball.js')).href}?smoke=${Date.now()}`);
      const fakeG = fakeEl();
      /**
       * 给球一个**游戏钩子**（就是 `web/game.js` 那种用法）：它每帧会调 `s.setAim(...)`。
       * 这一条是为一个真实报错加的：`setAim` 一度只在"返回对象"里写了、内部没有这个函数，
       * 于是钩子一调就 `ReferenceError: setAim is not defined`（帧循环被它打断）。
       * 自检当时没传钩子，所以**没抓到** —— 现在传了。
       */
      const aimCalls = [];
      const ball = createBall({
        fxG: fakeG, sfx: {},
        stage: { bounds: () => ({ W: 1280, H: 760, floorY: 758, minX: 0, maxX: 1280 }), pet: () => ({ x: 100, faceVis: 1 }) },
        game: { onStep: (s) => { s.setAim({ x: 1, power: 1.5 }); aimCalls.push(1); }, onKick: () => {} },
      });
      // 挂载是**惰性**的：第一次开球才建元素（所以先 setOn 再断言）
      ball.setOn(true, { fromLeft: false });
      ok('玩具球：SVG 元素用 createElementNS 造（用 innerHTML 会画不出来）',
        nsCalls.length >= 4 && nsCalls.every((n) => n === 'http://www.w3.org/2000/svg'));
      for (let i = 0; i < 360; i += 1) ball.step(1 / 60);
      ok('玩具球：落地后 6 秒内停稳（不再每帧弹一下）', ball.resting === true && ball.state.vx === 0 && ball.state.vy === 0);
      // 拖着走一秒：位置跟手、速度必须是 0（物理这一帧被跳过）
      ball.setDragging(true);
      let dx = ball.x;
      for (let i = 0; i < 60; i += 1) { dx += 8 * Math.sin(i / 6); ball.drag(dx, 300 + i); ball.step(1 / 60); }
      const mid = ball.state;
      ok('玩具球：拖着的时候物理停手（位置跟手、没有速度残留）',
        mid.dragging === true && mid.vx === 0 && mid.vy === 0);
      ball.setDragging(false);
      for (let i = 0; i < 30; i += 1) ball.step(1 / 60);
      ok('玩具球：松手后它自己往下掉（回落到地面方向）', ball.state.y > 300);
      ok('玩具球：游戏钩子每帧能回调 setAim（曾经它不是函数、钩子一调就炸）',
        aimCalls.length >= 30);
      /**
       * **跳起来用头顶**（用户要的："她的脑袋应该也有碰撞体积，后面她可以跳起来接回来"）。
       * 这里让她腾空（`feetY` 高于地面），把球放到头顶那一片里，看球会不会被**往外顶**。
       *
       * ⚠️ 高度要对上 `ball.js` 的 `headBox()`：箱子挂在**脚底往上 60~150**。
       * 她腾空 40px → 箱子覆盖离地 100~190，所以球放 150。
       * （老版本箱子挂在脚底上下 −30~+60，测试里放的是"离地 70"—— 箱子挪到头之后那个高度就是脚边了。）
       */
      {
        const B2 = { W: 1280, H: 760, floorY: 758, minX: 0, maxX: 1280, S: 0.42 };
        const air = { x: 640, faceVis: -1, feetY: B2.floorY - 40 };   // 腾空 40px、朝左
        let headEvents = 0;
        const b2 = createBall({
          fxG: fakeEl(), sfx: {},
          stage: { bounds: () => B2, pet: () => air },
          onEvent: (k) => { if (k === 'ballHead') headEvents += 1; },
          game: { onStep: (s) => s.setAim({ x: 1, power: 1 }), onKick: () => {} },
        });
        b2.setOn(true, { fromLeft: false });
        b2.placeAt(640 / B2.W, B2.floorY - 150, { since: 0 });   // 塞进头顶那片（箱子在脚底上方 60~150）
        for (let i = 0; i < 3; i += 1) b2.step(1 / 60);
        /**
         * 判据要写对：头球是**朝踢腿的反方向**顶出去的（她朝左 → 球被顶向右）。
         * 而普通踢腿是"从她的中心往外推"，她朝左时球在右侧 → 球会被推**向右**（同向）。
         * 所以"球向左"只能来自头球。**别断言 vx>0** —— 球飞出去撞墙反弹后 vx 会变负（我踩过）。
         * （第一帧 `aim` 还没被游戏钩子设上，头球走的是"按她朝向"的兜底方向 → 朝左。）
         */
        ok('玩具球：她腾空时脑袋有碰撞体积（球被朝踢腿的反方向顶出去）',
          headEvents > 0 && b2.state.x < 640);
        // 落地之后头就不该再顶球（站在地上时头不算碰撞体）—— 球就放在箱子那个高度上
        air.feetY = B2.floorY;
        const before = headEvents;
        b2.placeAt(640 / B2.W, B2.floorY - 150, { since: 0 });
        for (let i = 0; i < 3; i += 1) b2.step(1 / 60);
        ok('玩具球：她落地后脑袋就不再顶球（只在她腾空时算）', headEvents === before);
      }
    ok('玩具球：球的外观是贴图 web/ball.png，而且那张图真的在',
      ctx.fs.existsSync(path.join(ctx.app, 'web', 'ball.png'))
      && /ball\.png/.test(ballSrc)
      && fs.statSync(path.join(ctx.app, 'web', 'ball.png')).size > 4000);
    /**
     * **指针捕获之后，事件只到被捕获的元素**（不再冒泡到 `document`）。
     * 拖动原本只挂在 `document` 上，于是"球只在按下/松手附近跟一下、中间全丢"，
     * 松手的速度时有时无（用户实测："丢不出去，时好时坏"）。
     * 所以 `stage` 那一层必须**自己**有 pointermove 与 pointerup。
     */
    ok('玩具球：stage 自己监听 pointermove（指针捕获后事件不冒泡到 document）',
      /stage\.addEventListener\('pointermove'/.test(appSrc));
    ok('玩具球：stage 自己监听 pointerup（在被捕获的那一层松手）',
      /stage\.addEventListener\('pointerup'/.test(appSrc));
    ok('玩具球：丢出去的速度按"最近 100ms 的位移"算（停一下再松手也能丢）',
      /velocityNow/.test(ballSrc) && /100/.test(ballSrc.match(/const samples[\s\S]{0,600}/)?.[0] || ''));
} finally {
  /**
   * ★ 2026-10-11 复核补回：**原文这里是 `finally`**，拆分区的时候被换成了
   * `catch (err) { throw err; }` —— 于是这一节装的**假 DOM 会泄漏到后面的区域**
   * （02g2 装、要等 02g4 末尾才被删）。清理必须留在这里，别删。
   * （原文写的是 `if (hadDoc) delete …; else delete …;` —— 两个分支一模一样，
   *  等于无条件删；这里按它真正的行为写清楚。）
   */
  delete globalThis.document;
  delete globalThis.petHost;
}
  },
};
