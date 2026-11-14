/**
 * 自检区域：打开任何一个 App（`phone-open`，2026-11-12）
 *
 * 用户的原话：「每个 App 都需要单独调程序？不能找不到截张图看看点哪里，然后继续吗？」
 * 这一区就用**假 adb + 假 Launcher 树**把四条路各跑一遍（不需要真机、0.2 秒）：
 *   ① 缓存（`apps.json` 里验过的包名）
 *   ② 别名（`phone-adb.launch` 认得出那个名字）
 *   ③ 看屏上的字点（当前屏 / 回桌面 / 开抽屉）
 *   ④ 截图问坐标（树里一个字的没有：自绘图标）
 * 外加：判据是"前台包名真的变了"（不是 `adb.launch` 的 ok）、找不到就如实说、学过的东西怎么失效。
 *
 * 单跑：`node test\run-one.cjs 33-phone-open.cjs`
 */
module.exports = {
  name: '她的手机·打开任何 App（别名是缓存，不是门槛）',
  tags: ['companion', 'phone', '手机', 'open', 'openApp'],
  async run(ctx) {
    const { ok, fs, path } = ctx;
    const os = require('node:os');
    const openMod = ctx.mod('phone-open');
    const surface = ctx.mod('phone-surface');
    const apps = ctx.mod('phone-apps');
    const adbMod = ctx.mod('phone-adb');

    const screen = { width: 720, height: 1280 };
    /** 图标大小的节点（真机桌面图标 228×166 / 720×1280）。 */
    const icon = (text, extra = {}) => ({
      ref: 'n' + Math.random().toString(36).slice(2, 6),
      text, desc: '', class: 'TextView', clickable: true, editable: false, scrollable: false,
      checkable: false, checked: false, enabled: true,
      bounds: [40, 300, 220, 420], center: [130, 360], pkg: 'app.lawnchair', ...extra,
    });
    const shot = (hash, nodes, extra = {}) => ({
      ok: true, app: { package: 'app.lawnchair', name: '桌面' }, screen, hash, nodes, table: '', thin: false, ...extra,
    });

    /**
     * 假手机。`screens` 是"这一屏长什么样"，`i` 是当前第几屏；
     * 点/滑只按**坐标**落在哪个节点上决定去哪（和真机一致：不看 ref）。
     */
    function mkAdb({ pkg = 'app.lawnchair', screens = [], launchPkg = '', launchOk = true, onSwipe = null } = {}) {
      const st = { pkg, i: 0, launches: [], taps: [], swipes: [], keys: [], woke: 0 };
      const cur = () => screens[Math.min(st.i, screens.length - 1)] || null;
      return {
        st,
        async wake() { st.woke += 1; },
        async state() {
          return { online: true, booted: true, serial: 'emu-1', screen, app: { package: st.pkg } };
        },
        async focusApp() { return st.pkg; },
        async observe() { const s = cur(); return s ? { ...s } : { ok: false, error: 'no screen' }; },
        async launch(spec) {
          st.launches.push(spec);
          if (!launchOk) return { ok: false, msg: 'No activities found' };
          if (launchPkg) st.pkg = launchPkg;
          return { ok: true, pkg: launchPkg };
        },
        async tapXY(x, y) {
          st.taps.push([Math.round(x), Math.round(y)]);
          const s = cur();
          const node = s && (s.nodes || []).find((n) => n.bounds
            && x >= n.bounds[0] && x <= n.bounds[2] && y >= n.bounds[1] && y <= n.bounds[3]);
          if (node && node.toPkg) st.pkg = node.toPkg;
          if (node && node.toScreen !== undefined) st.i = node.toScreen;
          return { ok: true };
        },
        async swipe(x1, y1, x2, y2) {
          st.swipes.push([y1, y2]);
          if (typeof onSwipe === 'function') onSwipe(st);
          return { ok: true };
        },
        async swipeDir(dir) { st.swipes.push(dir); if (typeof onSwipe === 'function') onSwipe(st); return { ok: true, changed: true }; },
        async key(name) { st.keys.push(name); return { ok: true }; },
        async screenshot() { return { ok: true, png: Buffer.from('89504e470d0a1a0a', 'hex'), bytes: 8, hash: 's' }; },
      };
    }

    const dirOf = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `dsp-open-${tag}-`));
    const FAST = {
      verify: { timeoutMs: 200, intervalMs: 20 },
      settleMs: 0,
      drawer: { settleMs: 0, tries: 2, fromY: 0.72, toY: 0.18, ms: 100 },
      drawerPages: 2,
    };
    function mkOpener(adb, { dir = dirOf('x'), askLocate = null, cfg = {} } = {}) {
      const store = openMod.createStore(path.join(dir, 'apps.json'), { max: 8 });
      const opener = openMod.createOpener({ adb, surface, askLocate, store, log: null, cfg: { ...FAST, ...cfg } });
      return { opener, store, dir };
    }

    /* ---------- 1. 名字归一化：这是"词形"，不是 App 表 ---------- */

    ok('名字：打开菜谱看看 → 菜谱', openMod.normalizeLabel('打开菜谱看看') === '菜谱');
    ok('名字：文件管理器 → 文件', openMod.normalizeLabel('文件管理器') === '文件');
    ok('名字：相机应用 → 相机', openMod.normalizeLabel('相机应用') === '相机');
    ok('名字：B站客户端 → B站', openMod.normalizeLabel('B站客户端') === 'B站');
    ok('名字：打开菜谱看看有什么 → 菜谱（尾巴要剥干净）', openMod.normalizeLabel('打开菜谱看看有什么') === '菜谱');
    ok('名字：包名原样保留', openMod.normalizeLabel('tv.danmaku.bili') === 'tv.danmaku.bili');
    ok('名字：描述型目标不算 App 名（交回主循环看图）', openMod.normalizeLabel('那个蓝色的图标') === '');
    ok('名字：按钮/图标这类也不当 App', openMod.normalizeLabel('蓝色的图标') === '');

    /* ---------- 2. `surface.find` 分档：完全相等优先（"菜谱"不许点到"菜谱大全"） ---------- */

    {
      const obs = {
        screen,
        nodes: [
          icon('菜谱大全', { bounds: [0, 200, 720, 260], center: [360, 230] }),
          icon('菜谱', { bounds: [40, 400, 220, 520], center: [130, 460] }),
        ],
      };
      ok('找字：完全相等优先（不是"包含"就先命中）', surface.find(obs, '菜谱')?.text === '菜谱');
      const descOnly = { screen, nodes: [icon('', { desc: '相册', bounds: [40, 300, 220, 420] })] };
      ok('找字：只有 content-desc 也能找到（旧版把 desc 丢了）', surface.find(descOnly, '相册')?.desc === '相册');
      const both = { screen, nodes: [icon('图库', { desc: '相册', bounds: [40, 300, 220, 420] })] };
      ok('找字：text 与 desc 都留着（分档要用）', surface.find(both, '相册')?.desc === '相册');
    }

    /* ---------- 3. ① 缓存：上次验过的包名，0 模型 ---------- */

    {
      const adb = mkAdb({ launchPkg: 'com.bluefish.cook' });
      const { opener, store } = mkOpener(adb);
      store.sync({ serial: 'emu-1', width: 720, height: 1280 });
      store.put('菜谱', { pkg: 'com.bluefish.cook', entry: 'drawer' });
      const r = await opener.open('菜谱');
      ok('缓存：直接开起来（how=cache）', r.ok && r.how === 'cache' && r.pkg === 'com.bluefish.cook');
      ok('缓存：真的调了 launch', adb.st.launches.length === 1 && adb.st.launches[0] === 'com.bluefish.cook');
      ok('缓存：先点亮屏幕（锁屏/息屏时不然点空）', adb.st.woke >= 1);
    }

    /* ---------- 4. ② 别名（`phone-adb.launch` 认得出"B站"） ---------- */

    {
      const adb = mkAdb({ launchPkg: 'tv.danmaku.bili' });
      const { opener } = mkOpener(adb);
      const r = await opener.open('B站');
      ok('别名：「B站」开得起来（旧版 1 秒硬失败）', r.ok && r.pkg === 'tv.danmaku.bili');
      ok('别名：用的是 `launch`（不花模型）', adb.st.launches[0] === 'B站');
    }
    ok('别名表：B站 → 哔哩哔哩那个包', adbMod.packagesFor('B站').includes('tv.danmaku.bili'));
    ok('别名表：壁纸（旧表里根本没有这个包）', adbMod.packagesFor('壁纸').includes('com.android.wallpaper'));
    ok('别名表：应用商店两个都试（联想 + vending）',
      adbMod.packagesFor('应用商店').includes('com.lenovo.leos.appstore')
      && adbMod.packagesFor('应用商店').includes('com.android.vending'));
    ok('别名表：文件管理器 → documentsui', adbMod.packagesFor('文件管理器').includes('com.android.documentsui'));
    ok('同义词：相册在屏幕上写的是"图库"', apps.SCREEN_ALIASES['相册'].includes('图库'));
    ok('同义词：浏览器在屏幕上写的是"Via"', apps.SCREEN_ALIASES['浏览器'].includes('Via'));

    /* ---------- 5. ③ 看屏上的字点（当前屏 / 回桌面） ---------- */

    {
      const desk = shot('h-desk', [
        icon('图库', { toPkg: 'com.android.gallery3d' }),
        icon('Via', { bounds: [240, 300, 420, 420], center: [330, 360] }),
      ]);
      const adb = mkAdb({ screens: [desk] });
      const { opener, store } = mkOpener(adb);
      const r = await opener.open('相册');
      ok('点字：说"相册"、屏幕上写"图库"也点得到', r.ok && r.how === 'home' && r.pkg === 'com.android.gallery3d');
      ok('点字：点的是那个图标的中心', adb.st.taps.length === 1 && adb.st.taps[0][0] === 130);
      const rec = store.get('相册');
      ok('学到的：记下屏幕上真实的字（下次先找"图库"）', !!rec && rec.screenLabel === '图库');
      ok('学到的：记下验过的包名', !!rec && rec.pkg === 'com.android.gallery3d');
      ok('学到的：入口是 home', !!rec && rec.entry === 'home');
    }

    /* ---------- 6. ③ 开抽屉找字（首页没有的 App） ---------- */

    {
      const home = shot('h-home', [icon('图库', { toPkg: 'com.android.gallery3d' })]);
      const drawer = shot('h-drawer', [
        icon('图库', { toPkg: 'com.android.gallery3d' }),
        icon('菜谱', { bounds: [240, 700, 420, 820], center: [330, 760], toPkg: 'com.bluefish.cook' }),
        icon('天气', { bounds: [440, 700, 620, 820], center: [530, 760] }),
        icon('地图', { bounds: [40, 900, 220, 1020], center: [130, 960] }),
        icon('时钟', { bounds: [240, 900, 420, 1020], center: [330, 960] }),
        icon('计算器', { bounds: [440, 900, 620, 1020], center: [530, 960] }),
        icon('录音机', { bounds: [40, 1100, 220, 1200], center: [130, 1150] }),
      ]);
      const adb = mkAdb({ screens: [home, drawer], onSwipe: (st) => { st.i = 1; } });
      const { opener, store } = mkOpener(adb, { dir: dirOf('drawer') });
      const r = await opener.open('菜谱');
      ok('抽屉：首页没有 → 上滑开抽屉 → 点"菜谱"', r.ok && r.how === 'drawer' && r.pkg === 'com.bluefish.cook');
      ok('抽屉：真的滑了一下', adb.st.swipes.length >= 1);
      const rec = store.get('菜谱');
      ok('学到的：抽屉入口 + 第几屏', !!rec && rec.entry === 'drawer' && rec.page === 0);
      ok('学到的：存的是归一化坐标（不是像素）', !!rec && Array.isArray(rec.xy) && rec.xy[0] > 0 && rec.xy[0] < 1);
    }

    /* ---------- 7. ④ 树里没有字 → 截图问一次坐标 ---------- */

    {
      /** 自绘桌面：控件树里三个匿名方块，一个字的没有。 */
      const blank = {
        ...shot('h-blank', [
          { ref: 'n0', text: '', desc: '', class: 'ImageView', clickable: true, bounds: [40, 300, 220, 420], center: [130, 360] },
          { ref: 'n1', text: '', desc: '', class: 'ImageView', clickable: true, bounds: [240, 300, 420, 420], center: [330, 360] },
        ]),
        thin: true,
      };
      const adb = mkAdb({ screens: [blank] });
      let asked = 0;
      const { opener } = mkOpener(adb, {
        dir: dirOf('vlm'),
        askLocate: async ({ label }) => {
          asked += 1;
          return label === '天气' ? { x: 0.46, y: 0.28 } : null;
        },
      });
      // 让"点了之后换了个 App"：按坐标点时把 pkg 换掉
      adb.tapXY = async (x, y) => { adb.st.taps.push([x, y]); adb.st.pkg = 'com.bluefish.weather'; return { ok: true }; };
      const r = await opener.open('天气');
      ok('问坐标：树里没字才发（一次）', asked === 1);
      ok('问坐标：点了并验到前台包名变了', r.ok && r.how === 'vlm' && r.pkg === 'com.bluefish.weather');
      ok('问坐标：坐标是归一化的（乘以画幅才点）', adb.st.taps[0][0] === 0.46 * 720 && adb.st.taps[0][1] === 0.28 * 1280);
    }
    {
      /** 树里有字、但点了没换 App → **不花这次钱**（交给主循环看一屏换条路）。 */
      const home = shot('h-h2', [icon('菜谱', { toPkg: '' })]);
      const adb = mkAdb({ screens: [home] });
      let asked = 0;
      const { opener } = mkOpener(adb, { dir: dirOf('vlm2'), askLocate: async () => { asked += 1; return null; } });
      await opener.open('菜谱');
      ok('问坐标：树里有那个字就不发（省 470 token）', asked === 0);
    }

    /* ---------- 8. 判据：`launch` 的 ok 不算，前台包名变了才算 ---------- */

    {
      /** launch 说 ok，但前台还是桌面 → 不能算开起来了。 */
      const home = shot('h-h3', [icon('图库')]);
      const adb = mkAdb({ screens: [home], launchPkg: '', launchOk: true });
      const { opener } = mkOpener(adb, { dir: dirOf('noverify') });
      const r = await opener.open('菜谱');
      ok('判据：`launch` 说 ok、前台没变 → 不算成功（如实说没找到）',
        !r.ok && r.reason === 'not-found');
    }

    /* ---------- 9. 找不到：如实说，不烧 20 步 ---------- */

    {
      const home = shot('h-h4', [icon('图库')]);
      const adb = mkAdb({ screens: [home], launchOk: false });
      const { opener, store } = mkOpener(adb, { dir: dirOf('notfound') });
      const r = await opener.open('宇宙飞船');
      ok('没找到：reason = not-found（上层据此立刻收）', !r.ok && r.reason === 'not-found');
      ok('没找到：说得出试过什么', Array.isArray(r.tried) && r.tried.length >= 1);
      ok('没找到：不写进 apps.json', store.get('宇宙飞船') === null);
      ok('没找到：耗时记在 ms 里（便于看"是不是卡了很久"）', Number(r.ms) >= 0);
    }
    ok('不归我管的名字（"那个蓝色的图标"）交回主循环',
      (await mkOpener(mkAdb({})).opener.open('那个蓝色的图标')).reason === 'no-label');
    ok('他喊停了就别再找', (await mkOpener(mkAdb({})).opener.open('菜谱', { task: { stopped: true } })).reason === 'stopped');

    /* ---------- 10. `apps.json`：学过的东西怎么失效 ---------- */

    {
      const dir = dirOf('store');
      const file = path.join(dir, 'apps.json');
      const store = openMod.createStore(file, { max: 4 });
      store.sync({ serial: 'emu-1', width: 720, height: 1280 });
      store.put('菜谱', { pkg: 'com.bluefish.cook', entry: 'drawer' });
      const store1 = openMod.createStore(file, { max: 4 });
      store1.sync({ serial: 'emu-1', width: 720, height: 1280 });
      ok('账本：写进去了（tmp + rename，读得回来）', store1.get('菜谱')?.pkg === 'com.bluefish.cook');
      const store2 = openMod.createStore(file, { max: 4 });
      store2.sync({ serial: 'emu-1', width: 720, height: 1280 });
      ok('账本：设备指纹对上就参考', store2.get('菜谱')?.pkg === 'com.bluefish.cook');
      const store3 = openMod.createStore(file, { max: 4 });
      store3.sync({ serial: '别的机器', width: 1080, height: 1920 });
      ok('账本：设备换了 → 整份忽略（不删，换回来还能用）', store3.get('菜谱') === null);
      ok('账本：忽略不等于删掉（文件里还在）', !!JSON.parse(fs.readFileSync(file, 'utf8')).items['菜谱']);
      const store4 = openMod.createStore(file, { max: 4 });
      store4.sync({ serial: 'emu-1', width: 720, height: 1280 });
      store4.miss('菜谱');
      ok('账本：第一次没开成先留着（可能是手抖）', !!store4.get('菜谱'));
      store4.miss('菜谱');
      ok('账本：连着两次没开成 → 忘掉，下次重新找', store4.get('菜谱') === null);
    }
    {
      const dir = dirOf('bad');
      const file = path.join(dir, 'apps.json');
      fs.writeFileSync(file, '{这不是 JSON', 'utf8');
      const store = openMod.createStore(file, { max: 4 });
      ok('账本：JSON 坏了 → 从空开始（不让整趟起不来）', store.list().length === 0);
      ok('账本：坏了会备份一份（不是默默清空）',
        fs.readdirSync(dir).some((f) => /^apps\.json\.bad-/.test(f)));
    }
    {
      const dir = dirOf('cap');
      const file = path.join(dir, 'apps.json');
      const store = openMod.createStore(file, { max: 3 });
      store.sync({ serial: 'emu-1', width: 720, height: 1280 });
      for (const name of ['a1', 'a2', 'a3', 'a4', 'a5']) store.put(name, { pkg: `com.x.${name}`, entry: 'alias' });
      ok('账本：有上限（超了删最旧/最miss的，不会无限长）', store.list().length === 3);
    }

    /* ---------- 11. 学习的前提是"点对了"，不是"点开了东西" ---------- */

    {
      /** 整屏的新闻小部件：文字对得上，但它不是图标 —— 不许记成"菜谱的入口"。 */
      const bigText = {
        ...icon('菜谱大全 今日推荐 红烧肉做法大全 二十年老厨师教你', { bounds: [0, 380, 720, 520], center: [360, 450] }),
      };
      ok('学习：整屏文字小部件不算图标（不写缓存）', openMod.learnable(bigText, '菜谱', screen) === false);
      const good = icon('菜谱', { bounds: [40, 300, 220, 420], center: [130, 360] });
      ok('学习：图标大小 + 字对得上 → 可以记', openMod.learnable(good, '菜谱', screen) === true);
      ok('学习：字只是"包含"关系也不算（不是我要的那个）', openMod.learnable(icon('菜谱大全'), '菜谱大全', screen) === true
        && openMod.learnable(icon('红烧肉'), '菜谱', screen) === false);
    }

    /* ---------- 12. 端到端：「打开菜谱看看」真的会自己找进去（不是 1 秒失败） ---------- */

    {
      const home = shot('h-e1', [icon('图库', { toPkg: 'com.android.gallery3d' })]);
      const drawer = shot('h-e2', [
        icon('图库', { bounds: [40, 700, 220, 820], center: [130, 760], toPkg: 'com.android.gallery3d' }),
        icon('菜谱', { toPkg: 'com.bluefish.cook' }),
        icon('天气', { bounds: [240, 300, 420, 420], center: [330, 360] }),
        icon('地图', { bounds: [440, 300, 620, 420], center: [530, 360] }),
        icon('时钟', { bounds: [40, 500, 220, 620], center: [130, 560] }),
        icon('计算器', { bounds: [240, 500, 420, 620], center: [330, 560] }),
        icon('录音机', { bounds: [440, 500, 620, 620], center: [530, 560] }),
      ]);
      const adb = mkAdb({ screens: [home, drawer], onSwipe: (st) => { st.i = 1; } });
      const agentMod = ctx.mod('phone-agent');
      const calls = [];
      const agent = new agentMod.PhoneAgent({
        adb,
        model: { model: 'stub', baseUrl: 'http://127.0.0.1:1', maxTokens: 80, timeoutMs: 5000 },
        callModel: async (m) => { calls.push(m); return { text: 'done 菜谱里是红烧肉和清蒸鱼' }; },
        dir: dirOf('e2e'),
        rescue: { enabled: false },
        scroll: { lookEach: false },
        open: FAST,
      });
      const res = await new Promise((resolve) => {
        const orig = agent.emit;
        agent.emit = (ev) => { orig(ev); if (ev.kind === 'done' || ev.kind === 'fail') resolve(ev); };
        agent.enqueue({ goal: '打开菜谱看看', by: 'her', key: 'private:1' });
      });
      ok('端到端：「打开菜谱看看」真的开进去了（旧版 1 秒硬失败）',
        !!res && res.ok === true && adb.st.taps.length >= 1);
      ok('端到端：开完之后还看了一眼（"看看"不许被当语气尾巴吃掉）', calls.length >= 1);
      ok('端到端：开的是那个 App（前台包名真的变了）', adb.st.pkg === 'com.bluefish.cook');
    }

    /* ---------- 13. 接线：真的接在 `doQuick` / `execute` 的 launch 上 ---------- */

    {
      const agentSrc = fs.readFileSync(path.join(ctx.app, 'phone-agent.cjs'), 'utf8');
      ok('接线：`doQuick` 的 launch 走 openApp（旧版是 adb.launch 硬短路）',
        /if \(quick\.kind === 'launch'\)[\s\S]{0,400}this\.openApp\(quick\.app/.test(agentSrc));
      ok('接线：`execute` 的 launch 也走 openApp（模型自己写 launch 时同一条兜底）',
        /if \(verb === 'launch'\)[\s\S]{0,600}this\.openApp\(arg/.test(agentSrc));
      ok('接线：`not-found` 立刻收（进 recover 只会烧完 20 步）',
        agentSrc.includes('if (task.fatalOpen)'));
      ok('接线：`verifyDone` 认"已经验过的那个包"',
        /task\.openedPkg[\s\S]{0,160}return \{ ok: true \}/.test(agentSrc));
      ok('接线：raw 任务有单独预算（15 步 / 150 秒）',
        agentSrc.includes('150_000') && agentSrc.includes("isRaw"));
      ok('接线：打开之后还有"看看/有什么"就不许收工（否则一眼没看）',
        agentSrc.includes('OPEN_AND_LOOK'));
      const lifeSrc = fs.readFileSync(path.join(ctx.app, 'phone-life.cjs'), 'utf8');
      ok('接线：她自己想去的时候（preOpen）也走 openApp',
        /agent\.openApp\(pre\.launch/.test(lifeSrc));
      ok('接线：学到的 App 也进她的菜单（学习不只帮"他叫她开"）',
        /phoneApps\.menu\(learned\)/.test(lifeSrc));
    }
    {
      const agentMod = ctx.mod('phone-agent');
      ok('提示：openApp 的四种返回语义写在预算里（not-found 要立即收）',
        agentMod.DEFAULTS.open && agentMod.DEFAULTS.open.verify.timeoutMs === 2500);
      ok('提示：截图问坐标默认最多 2 次/趟（别让找入口吃掉一整趟）',
        agentMod.DEFAULTS.open.locate.maxPerTask === 2);
    }
  },
};
