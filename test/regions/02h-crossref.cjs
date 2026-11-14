/**
 * 自检区域：跨函数引用守卫
 *
 * **这条是为一次真实翻车加的**：`microK` 在 `step()` 里声明，却被 `render()` 用了 ——
 * 而 `render()` 是在**帧循环**里被调的，所以它每一帧抛 `ReferenceError`，
 * **整条帧循环当场死掉**：她停在最后一帧、不再动、也不再接鼠标。
 *
 * 所以这里做一条**静态作用域检查**：把 pet-core 里 `render()` 的函数体切出来，
 * 断言它不引用那些"只在别的函数里声明"的名字。
 *
 * 代码从原 `test\smoke.cjs` 的 2h 那一段**整段照抄**，一字未改。
 * 单跑：`node test\run-one.cjs 02h-crossref.cjs`
 */
module.exports = {
  name: '跨函数引用守卫',
  tags: ['guard', '守卫', 'pet-core'],
  async run(ctx) {
    /* 裸名字（fs / path / app / pet / lines / ok / base / port …）由骨架挂成全局了。 */
    const coreSrc = fs.readFileSync(path.join(app, 'web', 'pet-core.js'), 'utf8');

    /** 从 `function name(` 起，按大括号配对切出函数体。 */
    const bodyOf = (src, name) => {
      const at = src.indexOf(`function ${name}(`);
      if (at < 0) return null;
      const open = src.indexOf('{', at);
      let depth = 0;
      for (let i = open; i < src.length; i += 1) {
        if (src[i] === '{') depth += 1;
        else if (src[i] === '}') { depth -= 1; if (!depth) return src.slice(open, i + 1); }
      }
      return null;
    };
    const renderBody = bodyOf(coreSrc, 'render');
    const stepBody = bodyOf(coreSrc, 'step');
    ok('pet-core：render() 切得出来（切不出来说明函数被人重命名了，这条守卫会失效）', !!renderBody && renderBody.length > 500);
    ok('pet-core：step() 切得出来', !!stepBody && stepBody.length > 500);
    /** 剥掉注释再查：注释里写 `microK`（比如解释这个坑）不算引用。 */
    const codeOnly = (s) => String(s || '').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
    const renderCode = codeOnly(renderBody);
    // `microK` 是 step 的局部变量，render 里用了就是 ReferenceError（每帧一次、帧循环死）
    ok('pet-core：render() 不引用 step() 的局部变量 microK（曾经因此整条帧循环死掉）',
      !!renderCode && !/(?<![A-Za-z_$.])microK(?![A-Za-z_$])/.test(renderCode));
    // render 里用到的每个 micro/mood 名字，都必须是 createPet 作用域里的变量
    // （`microTilt:` 这种**对象键名**不算引用，排除掉）
    const names = [...new Set(renderCode.match(/(?<![A-Za-z_$.])(micro[A-Za-z]*|mood)(?![A-Za-z_$])/g) || [])]
      .filter((n) => {
        const at = renderCode.indexOf(n);
        return renderCode[at + n.length] !== ':';
      });
    const declaredAtTop = ['microState', 'mood'];
    ok(`pet-core：render() 引用的变量都在作用域内（${names.join('/') || '无'}）`,
      names.every((n) => declaredAtTop.includes(n) || renderCode.includes(`const ${n}`) || renderCode.includes(`let ${n}`)));
    // 前端入口必须挂上全局错误捕获（这次就是靠它才看见 microK 的）
    ok('页面入口导入了诊断模块（全局错误捕获）',
      /from '\.\/diag\.js'/.test(fs.readFileSync(path.join(app, 'web', 'pet-app.js'), 'utf8')));
    ok('诊断模块真的装了 error / unhandledrejection 监听',
      /addEventListener\('error'/.test(fs.readFileSync(path.join(app, 'web', 'diag.js'), 'utf8'))
      && /addEventListener\('unhandledrejection'/.test(fs.readFileSync(path.join(app, 'web', 'diag.js'), 'utf8')));
    /**
     * ★★ **`ctl.act()` 不许传数组**（2026-10-11 晚加，为一次**静默失效**）。
     *
     * `pet-core` 的 `act(a)` 是 `switch (a) { case 'jump': … }` —— **字符串比较**；
     * 传数组进去直接落 `default: return false`：**不抛错、不报错、动作就是不做**。
     * 这个坑踩过两次：第一次是 `ball.jump`（`pet-app` 335 行附近留了警告注释），
     * 第二次是**天气反应**里的 `ctl.act([r.act])` —— 直到第 ③b 项才发现：
     * "下雪了她抖一下 / 下雨了点个头"这半句**从来没生效**（表情/音效/气泡都在，所以看不出来）。
     *
     * 查之前先剥注释（`game.js` 的头部注释里就写着 `ctl.act(['jump'])` 这种例子，
     * 那是说明文字、不该让守卫变红 —— 这跟上面 `microK` 那条是同一个道理）。
     */
    const noComment = (f) => codeOnly(fs.readFileSync(path.join(app, 'web', f), 'utf8'));
    const callers = ['pet-app.js', 'ball.js', 'game.js'];
    const passedArray = callers.filter((f) => /\.act\(\s*\[/.test(noComment(f)));
    ok(`页面侧没有把数组传给 ctl.act()（数组会静默落 default、动作什么都不做）`
      + `${passedArray.length ? '：' + passedArray.join(' / ') : ''}`, passedArray.length === 0);

    /**
     * ★ 2026-11-01：**帧循环里不许再直接读 `getBoundingClientRect`**（P1 的性能项）。
     *
     * 那层每帧刚写完 SVG（`ctl.render()`），布局是脏的 → 这时读 rect 会**强制同步布局**，
     * 一帧至少两次（`overUI` 三个面板 + `overTools`）。60fps 下是实打实的 CPU。
     * 现在矩形走 `uiRects()` 的缓存（只在窗口大小/面板开合/菜单移动时重算），
     * 帧循环那次判定也只有"光标动了 / 她或球在动 / 界面变了"才算。
     *
     * 断言方式：把 `overUI` / `overTools` / `syncInteractiveOnFrame` 三个函数体切出来，
     * 里面**不许出现** `getBoundingClientRect`（只能在 `uiRects` 里出现一次）。
     */
    const appJs = noComment('pet-app.js');
    const appBodyOf = (name) => {
      const i = appJs.indexOf(`function ${name}(`);
      if (i < 0) return '';
      const j = appJs.indexOf('\n}', i);
      return j > i ? appJs.slice(i, j) : appJs.slice(i, i + 4000);
    };
    const hotBodies = ['overUI', 'overTools', 'syncInteractiveOnFrame'].map((n) => [n, appBodyOf(n)]);
    ok('帧循环热路径不在函数体里读 getBoundingClientRect（走 uiRects 缓存）',
      hotBodies.every(([, b]) => b.length > 40)
      && hotBodies.every(([, b]) => !/getBoundingClientRect/.test(b))
      && /function uiRects\(/.test(appJs) && /getBoundingClientRect/.test(appBodyOf('uiRects')));
    ok('帧循环那次"要不要拿鼠标"的判定可以跳过（光标没动 + 她/球静止 + 界面没变就不重算）',
      /function syncInteractiveOnFrame\(/.test(appJs)
      && /lastSync\.ui === ui/.test(appJs)
      && /if \(!ctl\.pressing\) syncInteractiveOnFrame\(\)/.test(appJs));

    /**
     * ★ 2026-11-01 的三条静态守卫（都是"读起来对、其实坏了"的那类）：
     *   · 弹弹乐 tooltip 的比分顺序和记分牌相反（读出来是"她 : 你"）；
     *   · 换主题/换肤之后雪、花瓣、雨的颜色不跟着变（`refreshPal` 有缓存）；
     *   · 声音总闸不持久化（`INIT.sound` 恒 true，关掉重启又响）。
     */
    ok('弹弹乐 tooltip：比分顺序和记分牌一致（先你后她）',
      /弹弹乐 你\$\{game\.score\[0\]\} : 她\$\{game\.score\[1\]\}/.test(appJs)
      && !/弹弹乐:\$\{game\.score\[1\]\}/.test(appJs));
    ok('换主题/换肤会让天气粒子的配色重读（`repaintPalette` 真的被调）',
      /function repaintFxPalette\(\)/.test(appJs)
      && /repaintFxPalette\(\);/.test(appBodyOf('applyPrefs'))
      && /repaintPalette\(\) \{ refreshPal\(true\); \}/.test(noComment('fx.js')));
    const petSrc = codeOnly(fs.readFileSync(path.join(app, 'pet.cjs'), 'utf8'));
    ok('声音总闸：INIT 读配置、页面报上来就存盘（关掉之后重启不会再响）',
      /sound: initCfg\.sound !== false/.test(petSrc)
      && /llm\.save\(\{ sound: state\.sound \}\)/.test(petSrc));
    ok('调试动作入口只在 DSP_DEBUG 下开（不再每个连接 1 秒一次 readFileSync）',
      /DSP_DEBUG \? 3000 : 0/.test(petSrc) && !/devTimer = setInterval\(\(\) => \{/.test(petSrc));
  },
};
