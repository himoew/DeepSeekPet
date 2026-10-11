/**
 * 自检区域：弹弹乐（进球不卡死 + 四档决策）
 *
 * 代码从原 `test\smoke.cjs` 的 2g-3 那一段**整段照抄**，一字未改。
 * 这一段的 `try {` 在原文里与 2g-2 的 `finally` 交叠，所以这里保留它自己的 try/catch。
 *
 * 单跑：`node test\run-one.cjs 02g3-game.cjs`
 */
module.exports = {
  name: '弹弹乐（进球与决策）',
  tags: ['ball', '弹弹乐', 'game'],
  async run(ctx) {
    /* 裸名字（fs / path / app / pet / lines / ok / base / port …）由骨架挂成全局了。 */
    /** DOM 桩：把 ball.js / game.js 在 Node 里真跑起来（照原文件那一份）。 */
    const nsCalls = [];
    const fakeEl = () => ({
      attrs: {}, children: { length: 1 }, appendChild() {},
      setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k]; },
      querySelector() { return null; }, getBoundingClientRect: () => ({ width: 0, height: 0 }),
      set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html; },
      parentNode: { appendChild() {} },
    });
    if (typeof document === 'undefined') globalThis.document = { createElementNS: (ns) => { nsCalls.push(ns); return fakeEl(); } };
    if (typeof petHost === 'undefined') globalThis.petHost = { report: () => {} };
    try {
      const { createGame } = await import(`${pathToFileURL(path.join(app, 'web', 'game.js')).href}?smoke=${Date.now()}`);
      const B = { W: 1280, H: 760, floorY: 758, minX: 0, maxX: 1280, S: 0.42 };
      const ballStub = {
        on: false, x: 640, y: 745, releasedAt: 0, lastRelease: 0,
        // 速度必须是 0：新版的"来球预判"会看 `vx/vy`，球桩缺这两个字段的话会被当成来球、
        // 于是她一直在跳（自检就是这么抓到行为变化的）
        vx: 0, vy: 0, resting: true,
        setOn() { this.on = true; },
        setAim() {},
        placeAt(fx) { this.x = B.minX + fx * B.W; this.y = B.floorY - 13; },
      };
      const events = [];
      /** 记下她收到的走路指令（用来验证"跑"与"回防"）。 */
      const walkLog = [];
      const game = createGame({
        fxG: fakeEl(), ball: ballStub, sfx: {},
        control: {
          bounds: () => B, pet: () => ({ x: 900, faceVis: 1 }),
          walkTo: (x, run) => walkLog.push({ x: x * B.W, run: !!run }),
          jump() {}, act() {},
        },
        onEvent: (k, d) => events.push({ k, d }),
      });
      game.setMode('game');
      /** 一帧（`y` 可以临时覆盖，用来把球塞进门里）。 */
      const frame = (y) => game.onStep({
        dt: 1 / 60, x: ballStub.x, y: y === undefined ? ballStub.y : y,
        vx: 0, vy: 0, resting: true, dragging: false, floorY: B.floorY, R: 13,
      });
      // 先让开球后的"冷静期"（350ms）过去：这一段的球还站在门前，不该算进球
      for (let i = 0; i < 30; i += 1) frame();
      const before = events.filter((e) => e.k === 'goal').length;
      ok('弹弹乐：开球后的冷静期内不会误判进球', before === 0);

      const gr = game.goalRect(game.defence);           // 她守哪边是随机的：塞她那个门
      ballStub.x = (gr.x0 + gr.x1) / 2;
      const inGoal = gr.yTop + 10;                      // 门框以内的高度
      for (let i = 0; i < 180; i += 1) {
        /**
         * 合成测试跑得比真实时间快得多：每帧把"开球冷静期"和"计分冷却"重置，
         * 才是**真的在测"球停在门里会不会被反复判进球"**（否则它只是被冷静期挡着）。
         * ⚠️ 注意别再重置 `scoredThisRelease` —— 那个字段已经不用了，
         * 而它**正是"第一次进球之后再也不计分"那个 bug 的载体**（见下面第二条断言）。
         */
        game.debug.noGoal = 0;
        game.debug.scoreCool = 0;
        frame(inGoal);
      }
      const goals = events.filter((e) => e.k === 'goal').length;
      ok('弹弹乐：把球塞进门里只算一个球（不会每帧都判进球 → 卡死）', goals === 1);
      /**
       * ★ **第二个球也必须算**（用户实测："依旧没有复位功能"）。
       * 上一版用一个"本次松手只算一次"的标志防连算，可比赛模式是**扫球、不松手**，
       * 于是那个标志**第一次进球后就永远是 true**，后面的球一个都不算 —— 球自然也不复位。
       * 这条断言专门盯这个：把球挪出去、再塞进来一次，比分必须再涨一分。
       */
      {
        /**
         * 三段写清楚，别让"球刚被自动开走"的那一帧混进来：
         *   ① 先把球挪到**远离两个门**的中场（这一帧不该算分）
         *   ② 再塞进她守的那个门 → 第二个球（`goals2 === 2`）
         */
        const scoredSide = events.filter((e) => e.k === 'goal').slice(-1)[0].d.side;
        /**
         * ⚠️ 现在进球有 **1 秒庆祝**（`CELEBRATE_MS`，球冻在网里），合成测试跑得比真实时间快
         * → 不先把庆祝走完，后面每一步都会被"庆祝中"挡掉。拨到过去再走一帧 = 庆祝结束、开球。
         */
        game.debug.celebrateUntil = performance.now() - 1;
        frame(B.floorY - 13);
        const grAway = game.goalRect(1 - scoredSide);
        ballStub.x = B.W * 0.5;                       // 中场：离两个门都很远
        game.debug.noGoal = 0; game.debug.scoreCool = 0;
        frame(B.floorY - 13);
        const goalsMid = events.filter((e) => e.k === 'goal').length;
        ballStub.x = (grAway.x0 + grAway.x1) / 2;     // 塞进**另一个**门
        game.debug.noGoal = 0; game.debug.scoreCool = 0;
        frame(B.floorY - 13);
        const after2 = events.filter((e) => e.k === 'goal').length;
        if (!(goalsMid === 1 && after2 === 2)) {
          console.log(`      [GOALFAIL] goalsMid=${goalsMid} after2=${after2} ballX=${Math.round(ballStub.x)} scoredSide=${scoredSide} score=${JSON.stringify(game.score)}`);
        }
        ok('弹弹乐：★第一个球之后，第二个球照样算（比分不会卡在第一次）',
          goalsMid === 1 && after2 === 2);
      }      /**
       * 进球之后球要挪到门框外面 —— 但**现在是"庆祝 1 秒后才开球"**：
       * 合成测试跑得比真实时间快，所以得把庆祝截止时刻拨到过去，再走一帧，开球才会发生。
       */
      game.debug.celebrateUntil = performance.now() - 1;
      frame(B.floorY - 13);
      const gr2 = game.goalRect(game.defence);
      ok('弹弹乐：★庆祝走完才开球，球被放到门框外面（否则下一帧又判一次）',
        ballStub.x < gr2.x0 || ballStub.x > gr2.x1);
      ok('弹弹乐：进球会通知 World（带比分）',
        events.some((e) => e.k === 'goal' && Array.isArray(e.d.score) && e.d.score.some((n) => n > 0)));
      // 球门要"守得住"：高度不超过她身高的一倍半、宽度小于窗口的十分之一
      ok('弹弹乐：球门尺寸按"她守得住"定（高 ≤144px、宽 <10% 窗口）',
        game.goalRect(0).yBottom - game.goalRect(0).yTop <= 144 && (gr2.x1 - gr2.x0) < B.W * 0.10);
      /**
       * 跑动 + 回防：**用一个全新实例、只开球模式、不判进球**来测，彻底躲开前面那些状态
       * （进球会把球自动开走、把比分改掉，之前就是被这个害得"偶发失败"）。
       *   · 球在对面但还追得上 → 她追
       *   · 球深在对面门口（追不上）→ 她跑回自己半场
       */
      /**
       * 走位决策用**纯函数 `game.plan()`** 来测（不再模拟整局）。
       *
       * 为什么换写法：原来这段是"摆一颗球 → 跑一帧 onStep → 看她的走路指令"，
       * 结果被三样东西轮流搅坏 —— 进球判定把球自动开走、开球冷静期吞掉整帧、320ms 节流吞掉指令。
       * 我为此调了十几轮，每轮"失败细节"都不一样（这才是真正的浪费时间）。
       * `plan()` 没有副作用，测起来是确定的。
       */
      for (const def of [0, 1]) {
        const side = def === 0 ? '左' : '右';
        const herHalfX = def === 0 ? B.W * 0.25 : B.W * 0.75;   // 她半场里的一个点
        const oppHalfX = def === 0 ? B.W * 0.75 : B.W * 0.25;   // 对面半场里的一个点
        const midBall = def === 0 ? B.W * 0.55 : B.W * 0.45;    // 对面半场、但**她够得着**（离她 < 34% 窗口）
        const deepBall = def === 0 ? B.W * 0.94 : B.W * 0.06;   // 贴着对面那个门（追不上）

        const inHer = game.plan(herHalfX, 900, def);
        ok(`弹弹乐：球在她半场时她冲过去抢（她守${side}）`, inHer.why === 'intercept' && inHer.x === herHalfX);
        const chase = game.plan(midBall, 900, def);
        ok(`弹弹乐：球在对面但够得着时她继续追（她守${side}）`, chase.why === 'chase' && chase.x === midBall);
        const back = game.plan(deepBall, 900, def);
        const myGoalX = def === 0 ? 0 : B.W;
        ok(`弹弹乐：球贴到对面门口（追不上）时她回自己半场（她守${side}）`,
          back.why === 'defend' && back.run === true && Math.abs(back.x - myGoalX) < B.W * 0.5);
        /**
         * **"在比赛"的三条新保证**（用户要的"抢球/得分/回防均衡"）：
         *   · 球在对面中场、她够不着 → **压到中线附近**（不是缩在门前）
         *   · 她**永远在跑**（没有"站着看"这一档）
         *   · 落后时站得**更靠前**（紧迫度把回防线往前推）
         */
        /**
         * "压上"这一档要**她在自己的回防位置**时才成立（在 x=900 那个位置，"够不着但球在中场"
         * 的区间跟"追球"重叠，测不出区别）。所以这里把她放在门前：
         * 守左 → 她 ≈0.1W；球在对面半场又不贴对面门 → 0.58W，这样 `dSelf` 足够大、`dOpp` 也足够大。
         */
        const guardX = def === 0 ? B.W * 0.10 : B.W * 0.90;
        const pressBall = def === 0 ? B.W * 0.58 : B.W * 0.42;
        const press = game.plan(pressBall, guardX, def);
        const pressWant = def === 0 ? B.W * 0.42 : B.W * 0.58;
        ok(`弹弹乐：够不着时她压到中线附近等（不是缩回门前，她守${side}）`,
          press.why === 'press' && Math.abs(press.x - pressWant) < 40);
        const calm = game.plan(deepBall, 900, def, 0);
        const urgent = game.plan(deepBall, 900, def, 1);
        ok(`弹弹乐：落后时她压得更靠前（紧迫度生效，她守${side}）`,
          Math.abs(urgent.x - myGoalX) > Math.abs(calm.x - myGoalX) + 20);
        ok(`弹弹乐：四档决策她永远在跑（没有站着看这一档，她守${side}）`,
          [inHer, chase, back, press].every((p) => p.run === true));
      }    } catch (err) {
      // 2g-3 自己的兜底：它抛错也算一条失败（别把整份自检带崩）
      ok(`弹弹乐：进球与三态切换（不抛错）—— 实际抛了 ${err && err.message}`, false);
      console.log(`      弹弹乐那段抛错的堆栈：${((err && err.stack) || '').split('\n').slice(0, 4).join(' | ')}`);
    }
  }
};

