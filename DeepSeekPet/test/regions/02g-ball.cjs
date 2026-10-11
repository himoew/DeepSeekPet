/**
 * 自检区域：玩具球（静态）
 * 从原 `test\smoke.cjs` 切出来的，**代码一字未改**（只把裸模块名换成 `ctx.*`）。
 * 单跑：`node test\smoke.cjs ball`
 */
module.exports = {
  name: "玩具球（静态）",
  tags: ['ball', '玩具球', 'weather', '天气'],
  async run(ctx) {
    /** 区域文件里保持原样的模块名：从 ctx 上解构出来（属性名 'pet:' 之类因此不受影响）。 */
    const { __mark, FILES, fs, path, pathToFileURL, http, pet, lines, llm, store, checkLines, pageAreas, pageStages, pageGrabParts,
      textsOf, textsFilled, base, port, WebSocket, ok } = ctx;
    /* ---------- 2g. 玩具球（静态部分：台词桶 + 页面接线） ---------- */
    /**
     * 球最怕的不是"不好玩"，而是**把她弄坏**（本会话已经在她的绘制/帧循环上栽过两次）。
     * 所以这里除了台词，还盯两件结构性的事：
     *   ① 球的物理/绘制在**自己的文件**里（`web/ball.js`），不往 `pet-core` / `figure.js` 塞；
     *   ② 开关是 World 记着的（配置里 `ball`），并且**关掉时一定有话可说**（用户要的"闹脾气"）。
     */
    for (const k of ['ballOn', 'ballKick', 'ballOffSad', 'ballOffAngry']) {
      ok(`玩具球：${k} 这一桶在台词库里`, Array.isArray(lines[k]) && lines[k].length > 0);
    }
    ok('玩具球：收走时"委屈"和"生气"两套都有（随机挑，用户要的）',
      lines.ballOffSad.length > 0 && lines.ballOffAngry.length > 0);
    ok('玩具球：表情写在台词里（委屈用 sad、生气用 angry）',
      lines.ballOffSad.some((l) => (l.actions || []).includes('sad'))
      && lines.ballOffAngry.some((l) => (l.actions || []).includes('angry')));
    ok('玩具球：物理与绘制在自己的文件里（没往 pet-core / figure.js 里塞）',
      ctx.fs.existsSync(path.join(ctx.app, 'web', 'ball.js'))
      && !fs.readFileSync(path.join(ctx.app, 'web', 'pet-core.js'), 'utf8').includes('toy-ball')
      && !fs.readFileSync(path.join(ctx.app, 'web', 'whale', 'figure.js'), 'utf8').includes('toy-ball'));
    const appSrc = fs.readFileSync(path.join(ctx.app, 'web', 'pet-app.js'), 'utf8');
    ok('玩具球：页面把它接进帧循环（step + draw 各一处）',
      /ball\.step\(dt\)/.test(appSrc) && /ball\.draw\(\)/.test(appSrc));
    ok('玩具球：页面会把"踢到了"报给 World',
      /t: 'ballKick'/.test(appSrc) && /case 'ballKick'/.test(fs.readFileSync(path.join(ctx.app, 'pet.cjs'), 'utf8')));
    ok('球/游戏模式：三态开关存进配置（重启后还在）',
      ctx.fs.readFileSync(path.join(ctx.app, 'llm.cjs'), 'utf8').includes("ballMode: 'off'")
      && fs.readFileSync(path.join(ctx.app, 'pet.cjs'), 'utf8').includes('llm.save({ ballMode: want })'));
    /**
     * **特效那一层不许被整层重写**（这条是为一次真实翻车加的）。
     *
     * `pet-core` 的粒子原来写 `fxG.innerHTML = …` —— 那是**把 `#fx` 里所有子节点换掉**。
     * 玩具球也挂在 `#fx` 下，于是"球刚画上就被抹掉"：球开了却看不见，
     * 而页面不抛错、World 那边一切正常（对话、表情、闹脾气全都有）。
     * 现在粒子写自己的子层 `#fxCore`，`#fx` 留给别的绘制者。
     */
    const htmlSrc = fs.readFileSync(path.join(ctx.app, 'web', 'pet.html'), 'utf8');
    const coreSrc = fs.readFileSync(path.join(ctx.app, 'web', 'pet-core.js'), 'utf8');
    ok('特效层分成两层：#fx 里装 #fxCore（她的粒子）', /id="fx"[\s\S]{0,120}id="fxCore"/.test(htmlSrc));
    /**
     * ★ **天气粒子单独一张画布**（2026-10-11 换的，用户实测"特效会导致卡顿"）。
     *
     * 为什么必须由自检盯着：这张 canvas 要是没进 HTML、或者 CSS 忘了 `pointer-events:none`，
     * 结果是"粒子全都不见了"或者"整张桌面的点击都被挡住"——**两种都不抛错**。
     * 连带盯住"粒子没退回 SVG"：`#fxCore` 那一层只剩她自己的爱心/眼泪/z/尘土。
     */
    const cssSrc = fs.readFileSync(path.join(ctx.app, 'web', 'pet.css'), 'utf8');
    const fxSrc = fs.readFileSync(path.join(ctx.app, 'web', 'fx.js'), 'utf8');
    const appSrcFx = fs.readFileSync(path.join(ctx.app, 'web', 'pet-app.js'), 'utf8');
    ok('★天气粒子（结构）：`pet.html` 里有粒子画布 `#fxCanvas`，而且 CSS 里 `pointer-events:none`',
      /<canvas[^>]*id="fxCanvas"/.test(htmlSrc) && /#fxCanvas\{[^}]*pointer-events:none/.test(cssSrc));
    ok('★天气粒子（结构）：粒子层不再走 SVG —— `fx.js` 不写 `innerHTML`，页面也不再给它 `#fxCore`',
      !/\.innerHTML\s*=/.test(fxSrc) && /canvas:\s*\$\('#fxCanvas'\)/.test(appSrcFx));
    /**
     * ★ **环境音的接线**（2026-10-11 新增）：`web\ambience.js` 要真的被页面用起来。
     * 三条缺一不可：① 创建；② 用户手势解锁；③ 跟音效开关一起开关（关掉时它自己 suspend）。
     * 漏掉任意一条都**不报错**，只会"天气永远没声音"。
     */
    ok('★天气音效（结构）：页面创建了环境音 + 跟着用户手势解锁 + 跟音效开关一起开关',
      /createAmbience\(/.test(appSrcFx) && /ambience\.unlock\(\)/.test(appSrcFx)
      && /ambience\.setEnabled\(ambienceOn\(\)\)/.test(appSrcFx));
    ok('★天气音效（结构）：切天气时把环境音一起切过去（`setWeather` 里调 `ambience.switchTo`）',
      /ambience\.switchTo\(/.test(appSrcFx));
    /**
     * ★ **天气音效的"单独开关"**（2026-10-11 用户："给天气音效一个单独开关，加在右键小肥鱼后的
     * 栏位里，不显示在浮窗"）。四条：
     *   ① 页面有 `weatherSound` 这个偏好，且**只出现在右键菜单**（`hoverButtons` 里不写它）；
     *   ② 真正出声 = **总闸 `sound` × 它自己**（`ambienceOn()`）—— 单独开关不能绕过总闸；
     *   ③ 切它要报给 World（`{t:'prefs', weatherSound}`），World 那边存进 settings.json；
     *   ④ World 的 `INIT` 要把它读出来（不然重启后回到默认，用户会以为开关没记住）。
     */
    const petSrc = fs.readFileSync(path.join(ctx.app, 'pet.cjs'), 'utf8');
    const llmSrc = fs.readFileSync(path.join(ctx.app, 'llm.cjs'), 'utf8');
    ok('★天气音效（结构）：页面有独立的 `weatherSound` 开关，而且是「总闸 × 它自己」两层'
      + '（单独开它不该绕过"声音：关"）',
    /weatherSound: true/.test(appSrcFx) && /function ambienceOn\(\)\s*\{[^}]*prefs\.sound && prefs\.weatherSound/.test(appSrcFx)
      && /ambience\.setEnabled\(ambienceOn\(\)\)/.test(appSrcFx));
    ok('★天气音效（结构）：这个开关只在右键菜单里（`hoverButtons` 不含它、`ACTIONS` 里有它）',
      !/hoverButtons:\s*\[[^\]]*weatherSound/.test(petSrc) && /^\s{2}weatherSound: \{/m.test(appSrcFx));
    ok('★天气音效（结构）：切开关会报给 World，World 存进 settings.json（重启后还在）',
      /send\(\{ t: 'prefs', weatherSound: prefs\.weatherSound \}\)/.test(appSrcFx)
      && /llm\.save\(\{ weatherSound: state\.weatherSound \}\)/.test(petSrc)
      && /weatherSound: llm\.load\(\)\.weatherSound !== false/.test(petSrc)
      && /weatherSound: true,/.test(llmSrc));
    /**
     * **模块求值顺序**：`pet-app.js` 里有些代码在**模块加载时就会执行**（不只是被调用时），
     * 比如 `syncGameFlag()`、`for (const b of BUTTONS)` 之类。如果它引用的 `const` 声明在后面，
     * 就是 `Cannot access 'X' before initialization` → **整个页面脚本挂掉**（她完全不出来）。
     *
     * 这条守卫为一次真实翻车加的：我把 `flags` 声明写在文件后面，而 `syncGameFlag()` 在前面，
     * 部署后页面日志里当场就是这个错。静态检查一下这个顺序，别等部署了才发现。
     */
    {
      const appSrc2 = fs.readFileSync(path.join(ctx.app, 'web', 'pet-app.js'), 'utf8');
      const declAt = appSrc2.indexOf('const flags = ');
      const callAt = appSrc2.indexOf('syncGameFlag();');
      ok('pet-app：模块加载期就用到的状态，声明必须在调用之前（TDZ 会让整页挂掉）',
        declAt > 0 && callAt > 0 && declAt < callAt);
    }
    ok('pet-core 的粒子只写 #fxCore，不整层重写 #fx（否则会把球抹掉）',
      !/fxG\.innerHTML\s*=/.test(coreSrc) && /fxCore\.innerHTML\s*=/.test(coreSrc));
    ok('玩具球挂在 #fx 下（跟粒子同一层但不同子节点）',
      /fxG\.appendChild/.test(fs.readFileSync(path.join(ctx.app, 'web', 'ball.js'), 'utf8')));
    /**
     * **静止之后不许再弹**（这条是为用户实测到的"静止时一直有弹地面异响"加的）。
     *
     * 老写法：`if (st.vy > 40) 反弹`，而弹起速度是 `40 × 0.55 = 22` —— 22px/s 不到一帧就被
     * 重力拉回地面，于是**每帧都判成一次撞地**，音效限流之后仍变成每秒 8 次的连续闷响。
     * 修法有三件，缺一不可：① 能弹的门槛（110）远高于静止门槛（45）；
     * ② 够慢就**一次性趴下**并进 `resting`；③ `resting` 状态**直接跳过物理**（不受重力、不出声）。
     */
    const ballSrc = fs.readFileSync(path.join(ctx.app, 'web', 'ball.js'), 'utf8');
    const num = (name) => Number((ballSrc.match(new RegExp(`const ${name} = ([\\d.]+)`)) || [])[1]);
    ok('玩具球：能弹的门槛远高于静止门槛（否则会每帧弹一次）',
      num('BOUNCE_MIN_VY') > num('REST_VY') * 1.5 && num('REST_VY') > 0);
    /**
     * 静止 = 跳过物理（不受重力、不出声）。
     * 但**仍然要判两件接触**：她撞上来、鼠标扫过来 —— 否则球停住之后就"死"了，
     * 球拍模式里就变成"球停在那一动不动，扫它也没反应"。
     * ③ **还要把这一帧报给游戏**（`hookGame`）：少了它，球一停游戏就一帧都收不到
     *    → 她收不到走路指令 → 用户实测的"复位后她不踢"（见 2g-5 第 ⑦ 条）。
     */
    const restingBody = (() => {
      const at = ballSrc.indexOf('if (st.resting) {');
      if (at < 0) return '';
      const open = ballSrc.indexOf('{', at);
      let d = 0;
      for (let i = open; i < ballSrc.length; i += 1) {
        if (ballSrc[i] === '{') d += 1;
        else if (ballSrc[i] === '}') { d -= 1; if (!d) return ballSrc.slice(open, i + 1); }
      }
      return '';
    })();
    ok('玩具球：静止状态跳过物理，但仍然判"她撞上"和"鼠标扫到"，并且照常把这一帧报给游戏（钩子）',
      /kickIfTouching\(\)/.test(restingBody) && /paddleIfTouching\(\)/.test(restingBody)
      && /hookGame\(/.test(restingBody) && /return;/.test(restingBody));
    ok('玩具球：够慢就一次性趴下（vy 归零 + resting）',
      /else if \(Math\.abs\(st\.vy\) <= REST_VY/.test(ballSrc) && /st\.resting = true;/.test(ballSrc));
    // 帧率：球在动 / 正被拖着时必须按 60fps（原来只有 30fps，抓着像卡住）
    ok('玩具球：在动或被拖着时按 60fps（"抓球很卡"的修法）',
      /ball\.busy/.test(appSrc) && /get busy\(\)/.test(ballSrc) && /setBallDrag|ball\.setDragging\(/.test(appSrc));
  },
};
