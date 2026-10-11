/**
 * 自检区域：头球与计分
 * 从原 `test\smoke.cjs` 切出来的，**代码一字未改**（只把裸模块名换成 `ctx.*`）。
 * 单跑：`node test\smoke.cjs game`
 */
module.exports = {
  name: "头球与计分",
  tags: ['ball', '头球', 'game', '计分'],
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
    /** pet-app.js 源码：原文件里由 2g 那块读好，单跑要自己读一份。 */
    const appSrc = fs.readFileSync(path.join(ctx.app, 'web', 'pet-app.js'), 'utf8');
  /* ---------- 2g-5. 弹弹乐：头球 / 计分方向 / 地面滚动 / 球拍方向（用户实测报的四件事） ---------- */
  /**
   * 这一批全是"用户实测报上来的现象"，而且**原来一条动态检查都没有**：
   *
   *   · "桌宠一直无法头球" —— `pet-app.js` 给 `ctl.act` 传的是**数组**，
   *     而 `pet-core` 的 `act` 是 `switch (字符串)` → 落 `default: return false`，
   *     她**一次都没跳过** → `pet.fy` 永远在地面 → `ball.js` 的 `headBox()` 恒 null。
   *   · "球进她的门却算她得分" —— `scorer = 1 - side` 只在"她守右边"时对，
   *     而守哪边是开局掷硬币 → 一半的球局计分是反的。
   *   · "球一沾地就停死" —— 地面摩擦写成了"每帧乘 0.86"，等于每秒乘 60 次（实测只滚 46px）。
   *   · "往右慢扫球往左滚" —— 短扫动的兜底方向取的是"手在球的哪一侧"，跟你的移动方向无关。
   */
  try {
    if (typeof document === 'undefined') globalThis.document = { createElementNS: () => fakeEl() };
    if (typeof petHost === 'undefined') globalThis.petHost = { report: () => {} };
    try {
      const B = { W: 1280, H: 760, floorY: 758, minX: 0, maxX: 1280, S: 0.42 };
      const W = B.W;
      // 这一段自己 import（前面那些块的 `const { createBall }` 是各自块里的作用域）
      const { createBall } = await import(`${pathToFileURL(path.join(ctx.app, 'web', 'ball.js')).href}?smoke=${Date.now()}`);
      const { createGame } = await import(`${pathToFileURL(path.join(ctx.app, 'web', 'game.js')).href}?smoke=${Date.now()}`);

      __mark('① 跳跃指令必须是字符串（她真的能被叫起来跳）');
      /* --- ① 跳跃指令必须是字符串（她真的能被叫起来跳） --- */
      ok('弹弹乐：★跳跃指令传的是字符串 `ctl.act(\'jump\')`（传数组会被 act 的 switch 丢掉，她一次都跳不起来）',
        /jump:\s*\(\)\s*=>\s*ctl\.act\('jump'\)/.test(appSrc));
      /**
       * 她"罚站"那条：`return`（不走位）必须**只在真的起跳/已经在空中**时发生。
       * 老写法只要 `canHead` 成立就 return，而那时 jump 是空操作 → 球一来她站着不动。
       */
      const gameSrc2 = fs.readFileSync(path.join(ctx.app, 'web', 'game.js'), 'utf8');
      ok('弹弹乐：★"能不能顶到球"不再直接吞掉走位（只在真跳起来或已在空中时才停下）',
        /if \(canHead && \(jumped \|\| sheAir\)\) return;/.test(gameSrc2));
      ok('弹弹乐：球拍的"自家门"护栏换到了她进攻的那一侧（原来护的是你要打的门，你一挥就被掉头）',
        /const ownGoalX = b\.minX \+ aim\.x \* \(b\.maxX - b\.minX\)/.test(
          fs.readFileSync(path.join(ctx.app, 'web', 'ball.js'), 'utf8')));

      __mark('② 头箱位置：球在"她头上那片"才算法头球，在她脚边不算');
      /* --- ② 头箱位置：球在"她头上那片"才算法头球，在她脚边不算 --- */
      const mkBall = ({ pet, heads }) => createBall({
        fxG: fakeEl(), sfx: {},
        stage: { bounds: () => B, pet: () => pet },
        onEvent: (k, d) => { if (k === 'ballHead') heads.push(d); },
        game: null,
      });
      {
        // 她腾空 40px：头箱覆盖离地 100~190（脚底往上 60~150）
        const air = { x: 640, faceVis: 1, feetY: B.floorY - 40 };
        const headsHi = [];
        const bHi = mkBall({ pet: air, heads: headsHi });
        bHi.setOn(true, { fromLeft: true });
        bHi.placeAt(0.5, B.floorY - 150, { since: 0 });
        for (let i = 0; i < 3; i += 1) bHi.step(1 / 60);
        ok('弹弹乐：★球飞到她头顶那一片（她腾空 40px、球离地 150px）→ 判成头球',
          headsHi.length >= 1 && headsHi[0].high >= 100);

        const headsLo = [];
        const bLo = mkBall({ pet: air, heads: headsLo });
        bLo.setOn(true, { fromLeft: true });
        bLo.placeAt(0.5, B.floorY - 30, { since: 0 });
        for (let i = 0; i < 3; i += 1) bLo.step(1 / 60);
        ok('弹弹乐：★球在她脚边（离地 30px、她腾空 40px）→ 不算头球（那是"踢"，不是"顶"）',
          headsLo.length === 0);
      }

      __mark('③ 头球端到端：真 ball.js + 真 game.js + 一个"会跳的她"（照 pet-core 抄的模型）');
      /* --- ③ 头球端到端：真 ball.js + 真 game.js + 一个"会跳的她"（照 pet-core 抄的模型） --- */
      {
        /** 照 `pet-core.js` 抄：act('jump') → 蹲 0.16s → vy=-720、空中重力 2300 → 落地。 */
        const simPet = (x) => ({
          x, x0: x, maxDx: 0, fy: B.floorY, vy: 0, mode: 'idle', modeT: 0, target: x,
          busy() { return this.mode === 'air' || this.mode === 'crouch' || this.mode === 'drag'; },
          walkTo(x2) { if (this.busy()) return false; this.target = Math.max(24, Math.min(W - 24, x2)); this.mode = 'run'; return true; },
          act(a) {
            if (this.busy()) return false;
            if (a === 'jump') { this.mode = 'crouch'; this.modeT = 0; return true; }
            return false;
          },
          step(dt) {
            this.modeT += dt;
            if (this.mode === 'crouch') { if (this.modeT > 0.16) { this.vy = -720; this.mode = 'air'; this.modeT = 0; } }
            else if (this.mode === 'air') {
              this.vy += 2300 * dt; this.fy += this.vy * dt;
              if (this.fy >= B.floorY && this.vy > 0) { this.fy = B.floorY; this.vy = 0; this.mode = 'idle'; }
            } else if (this.mode === 'run') {
              const d = this.target - this.x, s = Math.sign(d) * Math.min(250, Math.abs(d) * 6 + 20) * dt;
              if (Math.abs(d) <= Math.abs(s)) { this.x = this.target; this.mode = 'idle'; } else this.x += s;
            }
            this.maxDx = Math.max(this.maxDx, Math.abs(this.x - this.x0));
          },
        });
        // 注意：`Math.random` 里还有 defence 的随机，**不能全局 stub**（会把下面那个 do/while 冻死）。
        // 头球骰子走 `gm.debug.headForce`（自检专用开关）。
        const headRun = (def, vx, vy, force) => {
          const pet = simPet(def === 0 ? W * 0.28 : W * 0.72);
          const heads = [];
          const bl = createBall({
            fxG: fakeEl(), sfx: {},
            stage: { bounds: () => B, pet: () => ({ x: pet.x, faceVis: 1, feetY: pet.fy }) },
            onEvent: (k, d) => { if (k === 'ballHead') heads.push(d); },
            game: { onStep: (s) => gm.onStep(s), onKick: (i) => gm.onKick(i) },
          });
          const gm = createGame({
            fxG: fakeEl(), ball: bl, sfx: {},
            control: {
              bounds: () => B, pet: () => ({ x: pet.x, faceVis: 1, feetY: pet.fy }),
              walkTo: (x) => pet.walkTo(x * W), jump: () => pet.act('jump'), act: (a) => pet.act(a),
              move: () => ({ mode: pet.mode, speed: 200, target: pet.target, feetY: pet.fy }),
            },
            onEvent: () => {},
          });
          bl.setOn(true, { fromLeft: true });
          // 有界（别写成 while，自检卡死比断言失败难查得多）
          for (let i = 0; i < 60 && gm.defence !== def; i += 1) { gm.setMode('off'); gm.setMode('game'); }
          gm.debug.headForce = force;
          bl.placeAt(0.62, B.floorY - 13, { vx, vy, since: 0 });
          gm.debug.noGoal = performance.now() + 9e9;      // 这一轮不关心进球
          gm.debug.scoreCool = performance.now() + 9e9;
          for (let f = 0; f < 200; f += 1) { pet.step(1 / 60); bl.step(1 / 60); }
          return { heads, mode: pet.mode, x: pet.x, maxDx: pet.maxDx };
        };
        const r1 = headRun(0, -500, -550, true);      // 判定"顶"
        const r2 = headRun(0, -600, -750, true);
        const rNo = headRun(0, -500, -550, false);    // 判定"不顶"
        ok('弹弹乐：★端到端——高球飞过来，她**真的会跳、而且真的顶到**（球从她头顶那片弹回去）',
          r1.heads.length + r2.heads.length >= 1
          && r1.heads.concat(r2.heads).every((h) => h.high >= 100));
        /**
         * ★ **判定"不顶"的时候她不许罚站**：这一球她顶不到，但她要继续跑
         * （玩家的活路：快球 / 反方向 / 趁她腾空）。
         * 判据用**整段里她离起点最远**跑了多少，而不是"结束时在哪" ——
         * 结束位置取决于她最后停在哪个走位档上（`press` 会停在中线），不稳。
         */
        ok(`弹弹乐：★判定"不顶"时她照常追球、不跳（这一球顶不到 = 你能打过去）—— 头球 ${rNo.heads.length} 次、她最远跑到 ${Math.round(rNo.maxDx)}px`,
          rNo.heads.length === 0 && rNo.maxDx > 40);
      }

      __mark('④ 计分方向：球进她守的门 = 你得分（两个 defence 都要对）');
      /* --- ④ 计分方向：球进她守的门 = 你得分（两个 defence 都要对） --- */
      {
        const touches = [];
        const paddleTouches = [];
        const freezes = [];
        const stub = {
          on: true, x: W * 0.5, y: B.floorY - 13, vx: 0, vy: 0, resting: true, dragging: false,
          releasedAt: 0, lastRelease: 0,
          setOn() {}, setAim() {}, setGrabable() {}, setHerTouch(on) { touches.push(!!on); },
          setPaddleTouch(on) { paddleTouches.push(!!on); },
          setFrozen(on) { freezes.push(!!on); }, setCelebrate() {},
          placeAt(fx) { stub.x = B.minX + fx * W; },
        };
        const ev = [];
        const gm = createGame({
          fxG: fakeEl(), ball: stub, sfx: {},
          control: {
            bounds: () => B, pet: () => ({ x: W * 0.5, faceVis: 1, feetY: B.floorY }),
            walkTo() {}, jump() {}, act() {}, move: () => ({ mode: 'idle', speed: 0, feetY: B.floorY }),
          },
          onEvent: (k, d) => ev.push({ k, d }),
        });
        const frame = (x) => gm.onStep({
          dt: 1 / 60, x, y: B.floorY - 30, vx: 0, vy: 0, resting: false, dragging: false, floorY: B.floorY, R: 13,
        });
        /** 庆祝（1 秒）走完：合成测试跑得比真实时间快，把截止时刻拨到过去再走一帧，开球才会发生。 */
        const endCelebrate = (x) => { gm.debug.celebrateUntil = performance.now() - 1; frame(x); };
        for (const def of [0, 1]) {
          for (let i = 0; i < 60 && gm.defence !== def; i += 1) { gm.setMode('off'); gm.setMode('game'); }
          gm.debug.score[0] = 0; gm.debug.score[1] = 0;
          gm.debug.noGoal = 0; gm.debug.scoreCool = 0;
          const gr = gm.goalRect(def);
          stub.x = (gr.x0 + gr.x1) / 2;
          ev.length = 0;
          frame(stub.x);
          const goal = ev.find((e) => e.k === 'goal');
          ok(`弹弹乐：★球进她守的门（defence=${def}）算**你**得分`,
            !!goal && goal.d.scorer === 0 && goal.d.score[0] === 1 && goal.d.score[1] === 0);
          /**
           * ★ **进球那一刻球被冻在网里**（庆祝 1 秒的第一条）：不再"同一帧就把球挪走"。
           * 用户的原话"得分我们还没弄"里就包括这个 —— 原来进球你根本看不见球进网。
           */
          ok('弹弹乐：★进球那一刻球被冻在网里（庆祝 1 秒里谁都不碰它）',
            freezes[freezes.length - 1] === true && Math.abs(stub.x - (gr.x0 + gr.x1) / 2) < 2);
          endCelebrate(stub.x);                            // 庆祝走完才开球
        }
        // 反过来：球进你自己的门，她得分
        for (let i = 0; i < 60 && gm.defence !== 0; i += 1) { gm.setMode('off'); gm.setMode('game'); }
        gm.debug.score[0] = 0; gm.debug.score[1] = 0;
        gm.debug.noGoal = 0; gm.debug.scoreCool = 0;
        const grMine = gm.goalRect(1);
        stub.x = (grMine.x0 + grMine.x1) / 2;
        ev.length = 0;
        frame(stub.x);
        const own = ev.find((e) => e.k === 'goal');
        ok('弹弹乐：★球进**你自家**的门，算她得分（"进谁的网、对面得一分"）',
          !!own && own.d.scorer === 1 && own.d.score[1] === 1);
        endCelebrate(stub.x);                              // 庆祝走完才开球
        /**
         * ★ **复位点回到"失球那侧门前"**（用户定的规则 + 他后来的确认）。
         * 球要落在门框**外面**（落在门里下一帧又判进球 → 卡死），且离那个门不远（≈128px）。
         * 注意：真正防"她刚进完球又原地一脚"的是 `RETREAT_MS`（进球方退回自己半场），不是复位点。
         */
        const lastGoalSide = own.d.side;
        const grSide = gm.goalRect(lastGoalSide);
        const outside = stub.x < grSide.x0 - 1 || stub.x > grSide.x1 + 1;
        const nearBy = Math.min(Math.abs(stub.x - grSide.x0), Math.abs(stub.x - grSide.x1)) < 200;
        ok(`弹弹乐：★复位点回到"失球那侧门前"（球在 ${Math.round(stub.x)}px、那个门 ${Math.round(grSide.x0)}~${Math.round(grSide.x1)}px）`,
          outside && nearBy);
        /**
         * ★ **进球方退回自己半场**（用户定的规则，`RETREAT_MS`）：
         *   · 她进球 → 关掉她的"碰球"（`setHerTouch(false)`）→ 球归你开，不会被原地再捅一脚；
         *   · 你碰到球（`onKick({by:'player'})`）→ 立刻还给她 → 她回来抢。
         * 没有这条，真机日志里她一分钟能刷 23 个球。
         */
        touches.length = 0;
        for (let i = 0; i < 60 && gm.defence !== 0; i += 1) { gm.setMode('off'); gm.setMode('game'); }
        gm.debug.score[0] = 0; gm.debug.score[1] = 0;
        gm.debug.noGoal = 0; gm.debug.scoreCool = 0;
        const grHer = gm.goalRect(1 - gm.defence);          // 她进攻的那个门
        stub.x = (grHer.x0 + grHer.x1) / 2;
        ev.length = 0;
        frame(stub.x);
        const mine = ev.find((e) => e.k === 'goal');
        ok('弹弹乐：★她进球之后，她的"碰球"当场关掉（要退回自己半场，不能原地再捅一脚）',
          !!mine && mine.d.scorer === 1 && touches[touches.length - 1] === false);
        gm.onKick({ x: stub.x, power: 400, by: 'player' });   // 你开球了
        ok('弹弹乐：★你碰到球之后，立刻把"碰球"还给她（否则球在你脚下、她站自己半场，游戏就死了）',
          touches[touches.length - 1] === true);
        endCelebrate(stub.x);                              // ★ 她那个球的庆祝也要走完，否则下一帧都在庆祝里
        /**
         * ★ **开球权**（`KICKOFF_HOLD_MS`，用户定的方案 a）：**你进球之后，你的球拍 1.5 秒内碰不到这颗球**
         * —— 否则你可以守在她门口把复位球一扫再进（真机实测比分一度 你30:她14，一半是这么刷的）。
         * 她碰到球（或等超时）就还给你。
         */
        paddleTouches.length = 0;
        for (let i = 0; i < 60 && gm.defence !== 0; i += 1) { gm.setMode('off'); gm.setMode('game'); }
        gm.debug.score[0] = 0; gm.debug.score[1] = 0;
        gm.debug.noGoal = 0; gm.debug.scoreCool = 0;
        const grYourGoal = gm.goalRect(gm.defence);        // 你的球门 = 她守的那个
        stub.x = (grYourGoal.x0 + grYourGoal.x1) / 2;
        ev.length = 0;
        frame(stub.x);
        const yours = ev.find((e) => e.k === 'goal');
        ok(`弹弹乐：★你进球之后，你的球拍当场被关掉（开球权给她，防"门口刷分"）—— scorer=${yours ? yours.d.scorer : '没进球'} · 球拍最后=${paddleTouches[paddleTouches.length - 1]} · 球在 ${Math.round(stub.x)}px`,
          !!yours && yours.d.scorer === 0 && paddleTouches[paddleTouches.length - 1] === false);
        /**
         * ★ **她碰到球不再立刻解禁**（用户实测："她开的第一球我刷分的概率超级高"）：
         * 复位点就在她门口、也是你的射门点，而"她一碰就还给你"实测 **20ms 就还了** → 你一扫又进。
         * 现在按**位置**解禁：球离开她的防区（`KICKOFF_CLEAR` 个窗口宽 ≈ 384px）才还给你。
         */
        gm.onKick({ x: stub.x, power: 500 });              // 她来开球了（她碰到球 → 不带 by）
        ok('弹弹乐：★她碰到球**不再**立刻解禁（那正是"门口刷分"的来源）',
          paddleTouches[paddleTouches.length - 1] === false);
        endCelebrate(stub.x);                              // 庆祝走完 → 开球
        stub.x = W * 0.5;                                  // 球被她踢到中场 = 离开她的防区
        frame(stub.x);
        ok('弹弹乐：★球离开她的防区之后，开球权才还给你（实测按位置解禁）',
          paddleTouches[paddleTouches.length - 1] === true);
      }

      __mark('⑧ 得分：比分牌 / 进球庆祝 / 进球音 / 心情（用户："得分我们还没弄"）');
      /* --- ⑧ 得分：比分牌 / 进球庆祝 / 进球音 / 心情（用户："得分我们还没弄"） --- */
      {
        const gsrc = fs.readFileSync(path.join(ctx.app, 'web', 'game.js'), 'utf8');
        const cssSrc = fs.readFileSync(path.join(ctx.app, 'web', 'pet.css'), 'utf8');
        const coreSrc = fs.readFileSync(path.join(ctx.app, 'web', 'pet-core.js'), 'utf8');
        const htmlSrc = fs.readFileSync(path.join(ctx.app, 'web', 'pet.html'), 'utf8');
        ok('弹弹乐：★比分牌画在场上（顶部居中的 `toy-score`，分数每帧写在 draw 里）',
          /toy-score/.test(gsrc) && /scoreYou\.textContent/.test(gsrc) && /\.toy-score-bg\{/.test(cssSrc));
        ok('弹弹乐：★进球有庆祝段（`CELEBRATE_MS`：球冻在网里 + 门上方弹大字 + 门白闪抖动 + 窗口内圈发光）',
          /const CELEBRATE_MS = \d+/.test(gsrc) && /setFrozen\?\.\(true\)/.test(gsrc)
          && /toy-goal-text/.test(gsrc) && /toy-goal-shake/.test(cssSrc)
          && /#goalGlow/.test(cssSrc) && /id="goalGlow"/.test(htmlSrc));
        /**
         * ★ **进球音效以前根本不存在**：`game.js` 一直在调 `sfx?.goal?.()`，
         * 而 pet-core 的 `sfx` 里没有这个方法 —— 可选链让它静静地什么都不做（=进球没声音）。
         */
        ok('弹弹乐：★进球音效真的存在（`goal` 上行 / `concede` 下行，都在 pet-core 的 sfx 里）',
          /^ {4}goal\(\) \{/m.test(coreSrc) && /^ {4}concede\(\) \{/m.test(coreSrc));
        /**
         * ★ **输赢意识的第一小步**：进球/失球轻轻推一下她的心情（数值很小 —— 一局十几个球也不会推到底）。
         * 动态那半条用**方向**断言（`clamp01` 会让"已经满了"时不动）：
         * 进球之后 love 不低于原来；再失球之后不高于进球之后。
         */
        const moodBefore = mood.snapshot().love;
        mood.onEvent('goal');
        const moodGoal = mood.snapshot().love;
        mood.onEvent('concede');
        const moodCon = mood.snapshot().love;
        ok(`弹弹乐：★进球/失球真的会推动心情（love ${moodBefore.toFixed(3)} → 进球 ${moodGoal.toFixed(3)} → 失球 ${moodCon.toFixed(3)}）`,
          moodGoal >= moodBefore && moodCon <= moodGoal
          && /goal: \{ love: \+0?\.0/.test(fs.readFileSync(path.join(ctx.app, 'mood.cjs'), 'utf8')));
      }

      __mark('⑨ 她的实力旋钮（用户："比分差距还是有点大……改成 65 左右，或者想办法提升她的胜率"）');
      /* --- ⑨ 她的实力旋钮（用户："比分差距还是有点大……改成 65 左右，或者想办法提升她的胜率"） --- */
      {
        const gsrc = fs.readFileSync(path.join(ctx.app, 'web', 'game.js'), 'utf8');
        const coreSrc2 = fs.readFileSync(path.join(ctx.app, 'web', 'pet-core.js'), 'utf8');
        ok('弹弹乐：★头球率 65%（`HEAD_HARD`，用户定的；真机量到过 54.8%）',
          /const HEAD_HARD = 0\.65/.test(gsrc));
        /**
         * ★ **她追球带提前量**：原来 `goTo(s.x)` 只追"球现在在哪"，而她 250px/s、球 300~700px/s
         * → 永远差一截（这正是 `你27 : 她8` 的主因）。现在追 `leadX`（球 + 0.25 秒）。
         */
        ok('弹弹乐：★她追球带提前量（`CHASE_LEAD_S`；球停着时提前量自动为 0）',
          /const CHASE_LEAD_S = 0?\.\d+/.test(gsrc)
          && /goTo\(leadX, firstTouch, true\)/.test(gsrc) && /plan\(leadX,/.test(gsrc));
        ok('弹弹乐：★比赛里给她一点跑速加成，**离开比赛自动回 1**（不然桌面上溜达也会变快）',
          /setRaceBoost\(k\) \{/.test(coreSrc2) && /250 \* raceBoost/.test(coreSrc2)
          && /setRaceBoost\(mode === 'game' \? RACE_BOOST : 1\)/.test(appSrc));
      }

      __mark('⑩ 右键菜单：按钮点不动 + 菜单头是上游形象（用户实测报的）');
      /* --- ⑩ 右键菜单：按钮点不动 + 菜单头是上游形象（用户实测报的） --- */
      {
        const appSrc2 = fs.readFileSync(path.join(ctx.app, 'web', 'pet-app.js'), 'utf8');
        /**
         * ★ **"菜单里的按钮全部失效"的根因**：窗口拿鼠标的判定原来只量 `#tools`，
         * 而菜单一开 `#tools` 就被隐藏（`tools.hidden = !(… && menu.hidden …)`）；
         * 菜单又开在光标**上方**，所以往上移进菜单时必然判成"不在按钮上"
         * → 页面把鼠标还给桌面 → 点击穿透，一个都点不动。
         */
        ok('★右键菜单：拿鼠标的判定必须把**菜单**也算进去（原来只量 #tools，而菜单一开 tools 就隐藏）',
          /function overUI\(p\)/.test(appSrc2) && /\[tools, menu\]/.test(appSrc2)
          && /if \(overUI\(p\)\) return true;/.test(appSrc2) && !/if \(overTools\(p\)\) return true;/.test(appSrc2));
        /**
         * ★ **菜单头的头像**：`pet.cjs` 的 `INIT.bot` 里**没有 `avatar` 字段**，
         * 所以旧代码 `bot.avatar ? <img …> : mini(…)` 永远走 else —— 画的是内置的**上游 Coo**。
         * 现在默认就是小肥鱼（`/api/avatar` = `web\avatar.png`），只有图加载失败才退回 SVG。
         */
        ok('★菜单头像是我们的小肥鱼（`/api/avatar`），不再取决于有没有 `bot.avatar`',
          /const av = head\.querySelector\('\.m-avatar'\)/.test(appSrc2)
          && /av\.innerHTML = `<img alt="" src="\/api\/avatar/.test(appSrc2)
          && /avImg\.addEventListener\('error'/.test(appSrc2));
        /**
         * **行为验证**（不只查字符串）：把 `overUI` 抠出来，喂给它假的 `tools` / `menu` 量一下 ——
         * 菜单打开时，光标落在菜单矩形里必须为 true（= 窗口会拿鼠标，按钮才点得动），
         * 落在外面的空地上必须为 false（不然整个桌面都被窗口挡住、点不了别的）。
         */
        const overSrc = appSrc2.match(/function overUI\(p\) \{[\s\S]*?\n\}/);
        const elAt = (rect, hidden) => ({ hidden, getBoundingClientRect: () => rect });
        const over = (menuOpen, x, y) => new Function('tools', 'menu', 'document',
          `${overSrc[0]}; return overUI({ x: ${x}, y: ${y} });`)(
          elAt({ left: 0, top: 0, right: 60, bottom: 40, width: 60 }, true),
          elAt({ left: 100, top: 100, right: 260, bottom: 300, width: 160 }, !menuOpen),
          { elementFromPoint: () => null });
        ok('★右键菜单（行为）：光标在菜单矩形里 → 收鼠标；在空地上 → 放过去（菜单开着也成立）',
          !!overSrc && over(true, 180, 200) === true && over(true, 20, 300) === false && over(false, 180, 200) === false);
      }

      __mark('⑤ 球在地上要能滚（不是一沾地就停死）');
      /* --- ⑤ 球在地上要能滚（不是一沾地就停死） --- */
      {
        const bl = createBall({
          fxG: fakeEl(), sfx: {},
          // 她站在球**后面**（x=60、脸朝右 → 碰撞盒右沿 112 < 球左沿 115），这样这一条量的是纯滚动
          stage: { bounds: () => B, pet: () => ({ x: 60, faceVis: 1 }) },
          game: null,
        });
        bl.setOn(true, { fromLeft: true });
        bl.placeAt(0.1, 'floor', { vx: 400, since: 0 });
        const x0 = bl.x;
        let n = 0;
        while (n < 300 && !bl.resting) { bl.step(1 / 60); n += 1; }
        const rolled = Math.round(bl.x - x0);
        ok(`玩具球：★贴地 400px/s 要能滚起来（实测滚了 ${rolled}px；原来每帧乘一次 0.86，只滚 46px）`,
          rolled > 200);
      }

      __mark('⑥ 球拍方向：往右扫 → 往右飞（慢扫、以及"她守右边"那一半都要对）');
      /* --- ⑥ 球拍方向：往右扫 → 往右飞（慢扫、以及"她守右边"那一半都要对） --- */
      {
        /** 慢扫：光标每帧 10px 往右，第一次接触时手还在球心左侧。 */
        const sweepRightSlow = ({ ballFx, aimX }) => {
          const bl = createBall({
            fxG: fakeEl(), sfx: {},
            stage: { bounds: () => B, pet: () => ({ x: 640, faceVis: 1, feetY: B.floorY }) },
            game: null,
          });
          bl.setOn(true, { fromLeft: true });
          bl.setGrabable(false);
          bl.setAim({ x: aimX, power: 1 });
          bl.placeAt(ballFx, 'floor', { since: 0 });
          const bx = bl.x, by = bl.y;
          let t = 1000;
          const send = (dx) => { t += 1000 / 60; bl.setCursor(bx + dx, by, t); bl.step(1 / 60); };
          for (let dx = -120; dx < -40; dx += 10) send(dx);        // 慢慢靠近（每帧 10px = 600px/s，够慢）
          for (let dx = -40; dx <= -10; dx += 10) send(dx);        // 接触那几帧：手仍在球心左侧
          return bl.state.vx;
        };
        // 她守右（aim.x=0）：这是原来一定会被"自家门护栏"掉头的那一半
        const vx1 = sweepRightSlow({ ballFx: 0.8, aimX: 0 });
        ok(`弹弹乐：★往右慢扫 → 球往右滚（原来"手还在球心左边"就把球往左推；实测 vx=${Math.round(vx1)}）`,
          vx1 > 0);
        const vx2 = sweepRightSlow({ ballFx: 0.5, aimX: 1 });
        ok(`弹弹乐：★往右慢扫（另一半场）也往右滚（实测 vx=${Math.round(vx2)}）`, vx2 > 0);
        /** 护栏仍然要在**自家门口那一小块**起作用：球就在自家门线前，往门里扫要被掰回来。 */
        const vx3 = (() => {
          const bl = createBall({
            fxG: fakeEl(), sfx: {},
            stage: { bounds: () => B, pet: () => ({ x: 640, faceVis: 1, feetY: B.floorY }) },
            game: null,
          });
          bl.setOn(true, { fromLeft: true });
          bl.setGrabable(false);
          bl.setAim({ x: 1, power: 1 });                 // 她进攻右门 → 你家门在右边
          bl.placeAt(0.94, 'floor', { since: 0 });       // 站在自家门线前那一小块（0.18W 之内）
          const bx = bl.x, by = bl.y;
          let t = 2000;
          const send = (dx) => { t += 1000 / 60; bl.setCursor(bx + dx, by, t); bl.step(1 / 60); };
          for (let dx = -120; dx < -70; dx += 10) send(dx);
          for (let dx = -70; dx <= -40; dx += 10) send(dx);   // 往右扫 = 往自家门里扫
          return bl.state.vx;
        })();
        ok(`弹弹乐：自家门口往门里扫仍然会被掰回来（防乌龙；实测 vx=${Math.round(vx3)}）`, vx3 < 0);
      }

      __mark('⑦ ★ 球**停着**的时候，游戏也必须每帧收到帧（否则她收不到走路指令 →"复位后她不踢"）');
      /* --- ⑦ ★ 球**停着**的时候，游戏也必须每帧收到帧（否则她收不到走路指令 →"复位后她不踢"） --- */
      /**
       * 真因：`ball.js` 的静止分支原来直接 `return`，而 `game.onStep` 那个钩子写在函数**末尾**
       * → 球一停，游戏一帧都收不到 → 她收不到任何走路指令。
       * 而**开球就是把球静止放在地上**（`placeAt(..., 'floor')`）——所以"复位后她有时不踢"
       * 只在"她恰好站在球边上"时才踢得到（`kickIfTouching` 在静止分支里照常跑），离得远就永远站着。
       */
      {
        let hooked = 0;
        const bl = createBall({
          fxG: fakeEl(), sfx: {},
          stage: { bounds: () => B, pet: () => ({ x: 400, faceVis: 1, feetY: B.floorY }) },
          game: { onStep: () => { hooked += 1; }, onKick: () => {} },
        });
        bl.setOn(true, { fromLeft: true });
        bl.placeAt(0.6, 'floor', { since: 0 });         // 开球就是这么摆的：静止、离她 368px
        const wasResting = bl.state.resting === true;
        for (let i = 0; i < 30; i += 1) bl.step(1 / 60);
        ok(`弹弹乐：★球**停着**的时候游戏照样每帧收到（30 帧收到 ${hooked} 次，摆好时 resting=${wasResting}）—— 少了这条，开球后她收不到走路指令就不去踢`,
          wasResting && hooked >= 30);
      }
    } catch (err) {
      ok(`弹弹乐：头球/计分/滚动/球拍方向（不抛错）—— 实际抛了 ${err && err.message}`, false);
    }
  } finally {
    if (hadDoc) delete globalThis.document; else delete globalThis.document;
    if (hadHost) delete globalThis.petHost; else delete globalThis.petHost;
  }
  },
};
