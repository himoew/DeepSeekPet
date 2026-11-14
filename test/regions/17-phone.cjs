/**
 * 自检区域：她的手机（2026-10-30 新增，2026-10-31 按 P0 重写）
 *
 * 验的是**逻辑**，不是模拟器：真的 adb 只在 `tools/phone.cjs probe` 里跑，
 * 这里塞一个假的 adb + 假的模型，所以区域能在几秒内跑完、不依赖 MuMu 开着。
 *
 * 2026-10-31 这轮改的是"她聪不聪明"，所以断言重点也换了：
 *   · 记忆**按目标条件化**（成过两次才重放；换目标不许重放；旧格式一律丢）
 *   · 复合目标不许被快捷技能吃掉、0 步报成功
 *   · `done` 要过断言（一步没做不许说完工、看不到目标里的东西不许说完工）
 *   · 卡住会自己 back / home，而不是干耗预算
 *   · 树太空时要发图；模型拒图要自动降级
 *   · prompt 拆成"稳定 system + 变化 user"（缓存能命中）
 *
 * 单跑：`node test\run-one.cjs 17-phone.cjs`
 */
module.exports = {
  name: '她的手机（adb 操作员）',
  tags: ['companion', 'phone', '手机', 'adb'],
  async run(ctx) {
    const { ok, fs, path } = ctx;
    const os = require('node:os');
    const agentMod = ctx.mod('phone-agent');
    const caps = ctx.mod('companion-capabilities');
    const { PhoneAdb, frameOf } = ctx.mod('phone-adb');
    const companion = ctx.mod('companion');

    /* ---------- 1. 标记解析 ---------- */

    const p1 = agentMod.parseTag('我去看看。\n[手机:看看相册]\n等我一下');
    ok('手机：摘掉 [手机:…]，其余正文保留', p1.text === '我去看看。\n等我一下');
    ok('手机：目标取到「看看相册」', p1.goals.length === 1 && p1.goals[0] === '看看相册');
    ok('手机：多个标记都收', agentMod.parseTag('[手机:看天气][手机:截张图]').goals.length === 2);
    ok('手机：没有标记时正文一字不动', agentMod.parseTag('今天风挺大').text === '今天风挺大');
    ok('手机：全角冒号也认', agentMod.parseTag('[手机：看看天气]').goals[0] === '看看天气');

    /* ---------- 2. 快捷技能（0 token）★ 2026-10-31 收紧 ---------- */

    ok('技能：截图类', agentMod.quickSkill('截张图给我看看')?.kind === 'shot');
    ok('技能：看看你手机', agentMod.quickSkill('让我看看你手机')?.kind === 'shot');
    // ★ 2026-10-31 上午：带"发给他"的截图请求原来不认，整句进了主循环 → 0 步被打回 → 图没发出去
    ok('技能：截图带"发给他"的尾巴', agentMod.quickSkill('截张图发给他')?.kind === 'shot');
    ok('技能：截图带"发给我看看"', agentMod.quickSkill('截张图发给我看看')?.kind === 'shot');
    // ★ 2026-10-31 上午：`先返回再回主页` 8 次模型白跑、还判失败 —— 拆成 back + home 两段 0 token 做完
    const seq = agentMod.quickSkill('先返回再回主页');
    ok('技能：先…再…拆成两步', seq?.kind === 'seq' && seq.parts.map((p) => p.kind).join(',') === 'back,home');

    /* ---------- 2b. 一句话里几件事：拆段（★ 2026-10-31 第二轮） ---------- */

    ok('拆段：A并B 拆成两件', JSON.stringify(agentMod.splitGoal('打开浏览器并随便搜点东西')) === JSON.stringify(['打开浏览器', '随便搜点东西']));
    ok('拆段：打开<App>后面挂着事也拆', JSON.stringify(agentMod.splitGoal('打开浏览器搜点东西')) === JSON.stringify(['打开浏览器', '搜点东西']));
    ok('拆段：返回主页后面挂着事也拆',
      JSON.stringify(agentMod.splitGoal('返回主页搜索小肥鱼相关的东西')) === JSON.stringify(['返回主页', '搜索小肥鱼相关的东西']));
    ok('拆段：一句话一件事，不许拆', agentMod.splitGoal('在浏览器里搜困了怎么办').length === 0);
    ok('拆段：往下滑看结果，不许拆', agentMod.splitGoal('往下滑动浏览器页面看看其他结果').length === 0);
    ok('拆段：点搜索，看看结果 —— 逗号也算两件', agentMod.splitGoal('点搜索，看看结果').length === 2);
    ok('技能：随便搜点东西走固定套路', agentMod.quickSkill('随便搜点东西')?.kind === 'search');
    ok('技能：给了词就把词拿出来', agentMod.quickSkill('搜索大肥鱼')?.keyword === '大肥鱼');
    ok('技能：在浏览器里搜X 也认', agentMod.quickSkill('在浏览器里搜困了怎么办')?.keyword === '困了怎么办');
    ok('技能：打开相册走 launch', agentMod.quickSkill('打开相册')?.kind === 'launch'
      && agentMod.quickSkill('打开相册').app === '相册');
    ok('技能：回桌面', agentMod.quickSkill('回桌面')?.kind === 'home');
    ok('技能：随便看看不抢（交给模型）', agentMod.quickSkill('随便逛逛，看看有什么') === null);
    // ★ 这三条是 10-30 那次"假成功"的直接教训
    ok('技能：复合目标不许被吃掉（点进去再返回主页）', agentMod.quickSkill('点进去再返回主页试试') === null);
    ok('技能：随便点不短路', agentMod.quickSkill('随便点一下看看顺不顺') === null);
    ok('技能：App 名不带尾巴（打开相册看看 → 相册）', agentMod.quickSkill('打开相册看看')?.app === '相册');
    ok('技能：App 名先认已知词（打开图库看看照片 → 不短路）', agentMod.quickSkill('打开图库看看照片') === null);

    /* ---------- 3. 动作语法 ---------- */

    ok('动作：tap n3', agentMod.parseAction('tap n3')?.verb === 'tap');
    ok('动作：带围栏', agentMod.parseAction('```\ntap n2\n```')?.arg === 'n2');
    ok('动作：done 带一句话', agentMod.parseAction('done 相册里有三张').arg === '相册里有三张');
    ok('动作：散文不算动作', agentMod.parseAction('我先点开相册看看') === null);
    ok('动作：不认识的动作不算', agentMod.parseAction('click n1') === null);

    /* ---------- 3b. 意图键（记忆的目标条件化靠它） ---------- */

    ok('意图：同一件事的不同说法归成一个', agentMod.intentOf('看看相册里有什么') === agentMod.intentOf('相册里有什么东西'));
    ok('意图：探索型单独一类', agentMod.intentOf('随便点一下看看顺不顺') === 'explore');
    ok('意图：不同目标不同键', agentMod.intentOf('打开设置看看') !== agentMod.intentOf('看看相册'));
    ok('记忆键：包名 + 屏 + 意图', agentMod.hintKey('a.b', 'h1', '相册') === 'a.b|h1|相册');

    /* ---------- 4. 动作表 + hash ---------- */

    const screen = { width: 720, height: 1280, density: 320 };
    const xml = (clock) => `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" text="" class="android.widget.FrameLayout" package="com.android.settings" bounds="[0,0][720,1280]">
    <node index="0" text="网络和互联网" class="android.widget.LinearLayout" clickable="true" bounds="[0,48][720,204]">
      <node index="0" text="WLAN" class="android.widget.TextView" clickable="false" bounds="[40,80][300,140]" />
    </node>
    <node index="1" text="搜索" class="android.widget.EditText" clickable="true" bounds="[0,204][720,300]" />
    <node index="2" text="${clock}" class="android.widget.TextView" package="com.android.systemui" bounds="[600,0][700,48]" />
    <node index="3" text="00:${clock}" class="android.widget.ProgressBar" bounds="[0,1200][720,1260]" />
  </node>
</hierarchy>`;

    const t = new PhoneAdb({ home: 'X:\\fake' });
    const tableA = t.buildTable(xml('9:41'), { screen });
    const tableB = t.buildTable(xml('9:42'), { screen });
    ok('动作表：只留可点的（父容器吸掉子节点文字）', tableA.nodes.length >= 2 && tableA.nodes.every((n) => n.text || n.desc));
    ok('动作表：父容器带上了子节点文字', tableA.nodes.some((n) => /网络和互联网/.test(n.text)));
    ok('动作表：紧凑（一项一行）', t.renderTable(tableA.nodes).split('\n').length === tableA.nodes.length);
    ok('ui_hash：时钟变了 hash 不变', t.hash(tableA.nodes) === t.hash(tableB.nodes));
    ok('ui_hash：真的变了 hash 会变',
      t.hash(t.buildTable(xml('9:41').replace('网络和互联网', '蓝牙'), { screen }).nodes) !== t.hash(tableA.nodes));
    // ★ 2026-10-31：横屏时 `wm size` 还是 720×1280，得信控件树根节点的画幅
    ok('画幅：横屏以控件树为准（1280×720）',
      JSON.stringify(frameOf('<hierarchy rotation="1"><node index="0" text="" bounds="[0,0][1280,720]"/></hierarchy>')) === '{"width":1280,"height":720}');
    ok('画幅：读不到就不瞎猜', frameOf('') === null);

    /**
     * ★ 2026-11-01：**横屏那一帧会馊**。
     * 上一帧是横屏（1280×720），转回竖屏之后 `uiXml()` 一直失败的话，`state()` 以前会
     * 一直报横屏 → `tapxy` / `swipeDir` 按横屏坐标点 → 全点空。
     * 现在缓存带时间戳，超过 60 秒就退回 `wm size`。
     */
    {
      const t2 = new PhoneAdb({ home: 'X:\\fake' });
      t2.serial = 'emulator-5554';
      t2.ensureTarget = async () => t2.serial;
      t2.adb = async (args) => {
        const s = args.join(' ');
        const out = s === 'devices' ? 'List of devices attached\nemulator-5554\tdevice\n'
          : s.includes('sys.boot_completed') ? '1'
            : s.includes('wm size') ? 'Physical size: 720x1280'
              : s.includes('wm density') ? 'Physical density: 320'
                : '';
        return { code: 0, out, err: '', ms: 1 };
      };
      t2.frame = { width: 1280, height: 720, at: Date.now() };
      const fresh = await t2.state();
      ok('画幅：刚看过的那一帧照用（横屏 1280×720 盖掉 wm size）',
        fresh.screen.width === 1280 && fresh.screen.height === 720);
      t2.frame = { width: 1280, height: 720, at: Date.now() - 61_000 };
      const stale = await t2.state();
      ok('画幅：超过 60 秒就不信它，回落到 wm size（转回竖屏后不再点空）',
        stale.screen.width === 720 && stale.screen.height === 1280);
      t2.frame = null;
      const none = await t2.state();
      ok('画幅：没有缓存时也不报空（就是 wm size）', none.screen.width === 720 && none.screen.height === 1280);
    }

    /**
     * ★ 2026-11-01：**观测耗时要真的量出来**。
     * `observe()` 原来把 `t0` 写在 `await this.state()` **之后**，于是 `ms.state` 恒 0 ——
     * "这一趟慢在 adb 状态查询还是控件树"永远看不出来。`lastDumpMs` 也是只写不读。
     */
    {
      const t3 = new PhoneAdb({ home: 'X:\\fake' });
      t3.serial = 'emulator-5554';
      t3.ensureTarget = async () => t3.serial;
      t3.adb = async (args) => {
        await new Promise((r) => setTimeout(r, 12));       // 假装 adb 有延迟（不写死等秒）
        const s = args.join(' ');
        const out = s === 'devices' ? 'List of devices attached\nemulator-5554\tdevice\n'
          : s.includes('sys.boot_completed') ? '1'
            : s.includes('wm size') ? 'Physical size: 720x1280'
              : s.includes('wm density') ? 'Physical density: 320'
                : '';
        return { code: 0, out, err: '', ms: 12 };
      };
      t3.uiXml = async () => ({ ok: true, xml: '<hierarchy><node index="0" text="" bounds="[0,0][720,1280]"/></hierarchy>' });
      const obs = await t3.observe();
      ok('观测：ms.state 真的量到了（以前恒 0：慢在状态查询还是控件树看不出来）',
        obs.ok && obs.ms.state >= 6 && obs.ms.total === obs.ms.state + obs.ms.dump);
      ok('观测：上一次控件树的耗时能读回来（`lastDumpMs` 原来只写不读）',
        (await t3.state()).dumpMs === obs.ms.dump);
    }

    /**
     * ★ 2026-11-01：`+N 项在这个屏之外` 其实是**被 maxNodes 截断**的（常常就在本屏），
     * 提示词会骗模型"去滚动"。文案改成实话。
     */
    {
      const t4 = new PhoneAdb({ home: 'X:\\fake' });
      const line = t4.renderTable([{
        ref: 'n0', text: '相册', desc: '', class: 'TextView', clickable: true, bounds: [0, 0, 720, 300], center: [360, 150],
      }], 3);
      ok('动作表：截断提示说的是实话（"没列出来"，不说"在屏外/要滚动"）',
        line.includes('没列出来') && line.includes('3') && !line.includes('屏之外') && !line.includes('滚动'));
    }

    /* ---------- 5. 主循环（假 adb + 假模型） ---------- */

    /**
     * 一张固定屏的假手机：tap 成功就换下一张屏。
     * 每一屏可以带自己的 `pkg`（2026-10-31 加：不然"换 App"和"相机陷阱"都没法演）。
     */
    function fakePhone(screens, { tapChanges = true } = {}) {
      let i = 0;
      const hits = { taps: 0, launches: 0, keys: [] };
      const cur = () => screens[Math.min(i, screens.length - 1)];
      const appOf = (s) => ({ package: s.pkg || 'com.android.settings', name: s.app || '设置' });
      return {
        hits,
        async state() {
          const s = cur();
          return { online: true, booted: true, screen, app: appOf(s) };
        },
        async observe() {
          const s = cur();
          return {
            ok: true, app: appOf(s), screen: s.screen || screen, count: s.nodes.length, nodes: s.nodes,
            table: s.table, hash: s.hash, thin: !!s.thin,
          };
        },
        async tap(ref, { at } = {}) {
          hits.taps += 1;
          hits.lastTap = { ref, at };
          if (tapChanges && i < screens.length - 1) i += 1;
          return { ok: true, changed: tapChanges, label: '相册' };
        },
        async tapXY(x, y) {
          hits.taps += 1;
          hits.xy = [x, y];
          if (tapChanges && i < screens.length - 1) i += 1;
          return { ok: true, ms: 1 };
        },
        async swipeDir(dir, opts = {}) {
          hits.swipes = (hits.swipes || 0) + 1;
          hits.swipeScreen = opts.screen || null;
          if (tapChanges && i < screens.length - 1) i += 1;   // 滑动真的会换屏（滚动模拟）
          return { ok: true, changed: true };
        },
        async text() { return { ok: true }; },
        async key(name) {
          hits.keys.push(name);
          if (tapChanges && name === 'enter' && i < screens.length - 1) i += 1;  // 回车真的会跳结果页
          return { ok: true };
        },
        async openUrl(url) {
          hits.url = url;
          if (tapChanges && i < screens.length - 1) i += 1;   // 开网址真的会换页
          return { ok: true };
        },
        async launch() { hits.launches += 1; return { ok: true, pkg: 'com.android.gallery3d' }; },
        /** ★ 2026-11-08：重启软件要用它（`am force-stop`）。 */
        async forceStop() { hits.stops = (hits.stops || 0) + 1; return { ok: true, pkg: 'mark.via' }; },
        /** ★ 2026-11-08：验证码滑块要按坐标拖（`slideCaptcha`）。 */
        async swipe(x1, y1, x2, y2) {
          hits.swipes = (hits.swipes || 0) + 1;
          hits.slide = [x1, y1, x2, y2];
          return { ok: true, ms: 1 };
        },
        async waitChange() { return { changed: tapChanges }; },
        async focusApp() { return appOf(cur()).package; },
        async screenshot({ save } = {}) {
          const png = Buffer.from('89504e470d0a1a0a', 'hex');
          if (!save) return { ok: true, png, bytes: png.length, hash: 'fakehash' };
          fs.mkdirSync(save, { recursive: true });
          const file = path.join(save, 'fake.png');
          fs.writeFileSync(file, png);
          return { ok: true, png, file, bytes: png.length, hash: 'fakehash' };
        },
      };
    }

    const node = (text, extra = {}) => ({
      ref: 'n0', text, desc: '', class: 'TextView', clickable: true, editable: false,
      scrollable: false, checkable: false, checked: false, longClick: false, enabled: true,
      password: false, bounds: [0, 0, 720, 300], center: [360, 150], pkg: '', ...extra,
    });

    const shot1 = {
      app: '相册', pkg: 'com.android.gallery3d', hash: 'h-photo', table: 'n0 相册 [scroll]',
      nodes: [node('相册', { scrollable: true })],
    };
    const shot2 = {
      app: '相册', pkg: 'com.android.gallery3d', hash: 'h-photo2', table: 'n0 图片 [tap]',
      nodes: [node('图片')],
    };

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsp-phone-test-'));

    /** 建一个用假 adb + 假模型的操作员，`run()` 会等到这个任务结束。 */
    function mkAgent(phone, { replies = [], budget = {}, onEvent = null, dir: d = dir, vision = {}, rescue = null, popup = null } = {}) {
      const calls = [];
      const waiters = new Map();
      let n = 0;
      let list = replies;
      const agent = new agentMod.PhoneAgent({
        adb: phone,
        model: { model: 'stub', baseUrl: 'http://127.0.0.1:1', maxTokens: 80, timeoutMs: 5000 },
        callModel: async (m, messages) => {
          calls.push(messages);
          const reply = list[Math.min(n, list.length - 1)];
          n += 1;
          return { text: reply };
        },
        dir: d,
        budget,
        vision,
        /** 默认关掉：老用例验的是固定退路，开了自救会多吃一次模型回复。自救自己有专测。 */
        rescue: rescue || { enabled: false },
        /** ★ 2026-11-06：自检里**不许碰网**（图片搜索/下载在 `27-her-web` 里单独测）。 */
        web: null,
        /** ★ 2026-11-02：弹窗层（默认开；专测里可以改 maxSame 等）。 */
        popup: popup || undefined,
        /** ★ 2026-11-07：老用例不验"每屏都看图问停/再翻"，这里关掉（专测在 `20/29`）。 */
        scroll: { lookEach: false },
        emit: (ev) => {
          if (onEvent) onEvent(ev);
          if (ev.kind === 'done' || ev.kind === 'fail') {
            const w = waiters.get(`${ev.goal}`);
            if (w) { waiters.delete(`${ev.goal}`); w(ev); }
          }
        },
      });
      const run = (goal, opts = {}) => new Promise((resolve) => {
        if (opts.replies) { list = opts.replies; n = 0; }
        waiters.set(goal, resolve);
        agent.enqueue({ goal, by: 'her', key: 'private:1', share: true, ...opts });
      });
      return { agent, calls, run };
    }

    // 5.1 截图：快捷技能，0 次模型
    {
      const phone = fakePhone([shot1]);
      const { run, calls } = mkAgent(phone);
      const res = await run('截张图给我看看');
      ok('主循环：截图不用模型', res.ok && calls.length === 0);
      ok('主循环：截图带回了图', !!res.shot && res.shot.hash === 'fakehash');
      ok('主循环：截图的说法是人话', /停在「相册」/.test(res.summary));
    }

    // 5.2 打开 App：快捷技能，走 launch
    {
      const phone = fakePhone([shot1]);
      const { run } = mkAgent(phone);
      const res = await run('打开相册');
      ok('主循环：打开 App 走 launch', res.ok && phone.hits.launches === 1);
    }

    // 5.3 需要想的事：模型点一下 → 换屏 → 模型收工
    {
      const phone = fakePhone([shot1, shot2]);
      const { run, calls } = mkAgent(phone, { replies: ['tap n0', 'done 相册里有三张'] });
      const res = await run('看看相册里有什么');
      ok('主循环：两步做完', res.ok && res.steps === 1 && calls.length === 2);
      ok('主循环：收工那句话来自 done', res.summary === '相册里有三张');
      ok('主循环：点击直接用观察到的坐标（不重新 dump）', Array.isArray(phone.hits.lastTap?.at) && phone.hits.lastTap.at[0] === 360);
    }

    // 5.4 屏级记忆：★ 2026-10-31 新语义 —— 成过两次才重放，且**只对同一意图**
    {
      const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dsp-phone-hint-'));
      const events = [];
      const a = mkAgent(fakePhone([shot1, shot2]), { dir: d, onEvent: (e) => events.push(e) });
      a.agent.adb = fakePhone([shot1, shot2]);
      await a.run('看看相册里有什么', { replies: ['tap n0', 'done 相册里有三张'] });
      a.agent.adb = fakePhone([shot1, shot2]);
      await a.run('看看相册里有什么', { replies: ['tap n0', 'done 相册里有三张'] });
      ok('记忆：成功两次之后才记成"可重放"', Object.values(a.agent.hints).some((h) => h.succ >= 2 && !h.avoid));

      a.agent.adb = fakePhone([shot1, shot2]);
      const mark = events.length;
      const res = await a.run('看看相册里有什么', { replies: ['tap n0', 'done 看完了'] });
      const steps = events.slice(mark).filter((e) => e.kind === 'step');
      ok('记忆：同一目标第三步开始命中（不问模型）', steps.length > 0 && steps[0].from === 'hint');
      ok('记忆：命中后任务仍然做完', res.ok);

      a.agent.adb = fakePhone([shot1, shot2]);
      const mark2 = events.length;
      await a.run('设置里有什么', { replies: ['tap n0', 'done 设置里有网络'] });
      const steps2 = events.slice(mark2).filter((e) => e.kind === 'step');
      ok('记忆：换目标绝不复用（10-30 那条毒链就是这么来的）', steps2.length > 0 && steps2[0].from === 'model');
    }

    // 5.5 连续没反应 → 先 back、再 home，最后说实话
    {
      const events = [];
      const phone = fakePhone([shot1], { tapChanges: false });
      const { run } = mkAgent(phone, { replies: ['tap n0'], onEvent: (e) => events.push(e) });
      const res = await run('看看相册里有什么');
      ok('失败：点不动就停，并说实话', res.ok === false && /没反应/.test(res.summary));
      ok('失败：不是干耗，会自己退一步', phone.hits.keys.includes('back'));
      ok('失败：退一步不行就回桌面', phone.hits.keys.includes('home'));
      ok('失败：退路上有事件记录（页面上看得见）', events.some((e) => e.from === 'recover'));
    }

    /**
     * ★ 2026-11-01（P0-3 / P0-4 / P0-5 / P0-7）：
     * 用户："她在自己玩手机时总是卡住，只有我说让她返回试试她才会返回"。
     * 这四条守卫的就是"她会不会自己退、退到哪、什么时候退、记不记得住"。
     */
    {
      const events = [];
      const phone = fakePhone([shot1], { tapChanges: false });
      const { run, agent } = mkAgent(phone, { replies: ['tap n0'], onEvent: (e) => events.push(e) });
      const res = await run('看看相册里有什么');
      const backs = phone.hits.keys.filter((k) => k === 'back').length;
      const recover = events.filter((e) => e.from === 'recover').map((e) => String(e.action));
      ok('退路：卡住先退**两步**（不是一步就回桌面）', backs >= 2);
      ok('退路：退两步还不行就**重开当前 App**（不是直接 key home）',
        phone.hits.launches >= 1 && recover.some((a) => /^launch /.test(a)));
      ok('退路：重开也不行才回桌面，最后如实说没成',
        recover.findIndex((a) => /^launch /.test(a)) < recover.findIndex((a) => /key home/.test(a))
        && res.ok === false && /没反应/.test(res.summary));
      ok('退路：卡住阈值是 2 次没进展（原来 3 次，5 步的任务来不及走完退路）',
        agentMod.DEFAULTS.maxStall === 2);
      ok('退路：提示里写死了"卡住就 key back（最多两次）"',
        agent.systemPrompt().includes('key back（最多两次）'));
    }
    {
      /**
       * P0-5：**"屏变了"不算进展**。
       * 一滑一换页的界面（B 站/浏览器）里，旧版每一步都算前进 → 永远不触发退路。
       */
      const pages = Array.from({ length: 8 }, (_, k) => ({
        app: '相册', pkg: 'com.android.gallery3d', hash: `h-slide-${k}`, table: `n0 第${k + 1}屏`, nodes: [node(`第${k + 1}屏`)],
      }));
      const phone = fakePhone(pages);
      const { run } = mkAgent(phone, { replies: ['swipe up'], budget: { maxSteps: 9, maxCalls: 9 } });
      const res = await run('点右上角的设置');       // 目标词不在这一屏：滑多少屏都不算近
      ok('判进展：目标没近时，滑一屏不算前进 → 两次就触发退路',
        phone.hits.keys.includes('back') && res.ok === false);
    }
    {
      /** P0-7：**纯滑动不写进动作记忆**（否则下次回到这一屏会优先重放假招）。 */
      const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'dsp-phone-hint-'));
      const pages = Array.from({ length: 8 }, (_, k) => ({
        app: '相册', pkg: 'com.android.gallery3d', hash: `h-hint-${k}`, table: `n0 第${k + 1}屏`, nodes: [node(`第${k + 1}屏`)],
      }));
      const { run, agent } = mkAgent(fakePhone(pages), { replies: ['swipe up'], dir: d2, budget: { maxSteps: 4, maxCalls: 4 } });
      await run('点右上角的设置');
      ok('记忆：目标没近的动作不写进 hints（假招不再被重放）', Object.keys(agent.hints).length === 0);
    }

    /**
     * ★ 2026-11-01（深夜，用户拍板的第一优先级）：
     * 卡住时**先让她自己看图判断**（点哪 / 还是退），固定退路只當兜底。
     */
    {
      const mkScreen = (tag) => ({ app: '设置', pkg: 'com.android.settings', hash: `h-${tag}`, table: 'n0 设置 [tap]', nodes: [node('设置')] });
      let screen = mkScreen('a');
      const hits = { keys: [], taps: 0, launches: 0 };
      const phone = {
        hits,
        async state() { return { online: true, booted: true, screen, app: { package: screen.pkg, name: screen.app } }; },
        async observe() {
          return { ok: true, app: { package: screen.pkg, name: screen.app }, screen, count: screen.nodes.length, nodes: screen.nodes, table: screen.table, hash: screen.hash };
        },
        async tap() { hits.taps += 1; return { ok: true, changed: false }; },
        async tapXY() { hits.taps += 1; return { ok: true, ms: 1 }; },
        async swipeDir() { return { ok: true, changed: false }; },
        async text() { return { ok: true }; },
        async key(name) { hits.keys.push(name); if (name === 'back') screen = mkScreen('b'); return { ok: true }; },
        async launch() { hits.launches += 1; return { ok: true }; },
        async waitChange() { return { changed: false }; },
        async screenshot() { return { ok: true, png: Buffer.from('89504e470d0a1a0a', 'hex'), hash: 'shot' }; },
      };
      const events = [];
      const { agent, run } = mkAgent(phone, {
        replies: ['tap n0'], budget: { maxSteps: 4, maxCalls: 20 }, rescue: { max: 10 }, onEvent: (e) => events.push(e),
      });
      let rescueCalls = 0;
      agent.callModel = async (m, messages) => {
        const sys = String(messages[0]?.content || '');
        if (/卡住了/.test(sys)) { rescueCalls += 1; return { text: 'key back', raw: {} }; }
        return { text: 'tap n0', raw: {} };
      };
      const res = await run('把设置里的开关拨一下');
      ok('自救：卡住时先让她看图判断（事件 from=rescue，动作是 back）',
        rescueCalls >= 1 && events.some((e) => e.from === 'rescue' && /back/.test(String(e.action))));
      ok('自救：她的判断真的执行了（back 落地、屏换了）', hits.keys.includes('back'));
      ok('自救：救回来之后任务继续往下走，不是立刻判失败', Number(res.steps) >= 3 || res.ok === true);
    }
    {
      // 限次：默认 10 次/任务；这里配 2 次，验证"到顶就不再问、走固定退路"
      const phone = fakePhone([shot1], { tapChanges: false });
      const events = [];
      const { agent, run } = mkAgent(phone, {
        onEvent: (e) => events.push(e), rescue: { max: 2 }, budget: { maxSteps: 30, maxCalls: 40 },
      });
      let asked = 0;
      agent.callModel = async () => { asked += 1; return { text: 'tap n0' }; };
      await run('看看相册里有什么');
      const rescueSteps = events.filter((e) => e.from === 'rescue').length;
      ok('自救：有次数上限（配 2 次就只问 2 次，到顶改走固定退路）', rescueSteps === 2 && asked >= 2);
      ok('自救：默认上限是 15 次/任务、默认开',
        agentMod.DEFAULTS.rescue.enabled === true && agentMod.DEFAULTS.rescue.max === 15);
    }

    // 5.6 预算：步数/模型次数用尽 → 不再硬判"想不出下一步了"，而是如实说停在哪
    {
      const phone = fakePhone([shot1, shot2]);
      const { run } = mkAgent(phone, { replies: ['tap n0'], budget: { maxSteps: 2, maxCalls: 9 } });
      const res = await run('看看相册里有什么');
      ok('预算：步数用尽就收工', res.ok === false && /最后停在/.test(res.summary));
    }
    {
      // 探索型本来就没有成功判据：走够了就算逛过（旧版一律判失败，回灌时她只能编）
      const phone = fakePhone([shot1, shot2]);
      const { run } = mkAgent(phone, { replies: ['tap n0'], budget: { maxSteps: 2, maxCalls: 9 } });
      const res = await run('随便看看');
      ok('预算：探索型走够了算成（不冤枉她）', res.ok === true && /最后停在/.test(res.summary));
    }
    {
      // 模型次数用完（旧版 summary 是"想不出下一步了"，她根本不知道自己做到哪）
      const phone = fakePhone([shot1, shot2]);
      const { run } = mkAgent(phone, { replies: ['tap n0'], budget: { maxCalls: 2 } });
      const res = await run('看看相册里有什么');
      ok('预算：问不动了也说得清停在哪', res.ok === false && /最后停在/.test(res.summary));
    }
    {
      // 探索型也不是"什么都算成"：卡死/原地打转仍然是失败
      // （真机撞到过：summary 写着"连着几步都没反应"，ok 却是 true —— 回灌就变成她吹牛）
      const phone = fakePhone([shot1], { tapChanges: false });
      const { run } = mkAgent(phone, { replies: ['tap n0'] });
      const res = await run('随便看看');
      ok('探索：卡死仍然算没成', res.ok === false && /没反应/.test(res.summary));
    }
    {
      // 同一个动作连着第三遍 → 止损（10-31 实测：一口气 swipe up 八次，屏在滚、目标没动）
      const pages = Array.from({ length: 6 }, (_, k) => ({
        app: '相册',
        pkg: 'com.android.gallery3d',
        hash: `h-scroll-${k}`,
        table: `n0 第${k + 1}屏`,
        nodes: [node(`第${k + 1}屏`)],
      }));
      const phone = fakePhone(pages);
      const { run, calls } = mkAgent(phone, { replies: ['tap n0'] });
      const res = await run('看看相册里有什么');
      ok('重复：同一个动作第三遍就停', res.ok === false && /3 遍/.test(res.summary));
      ok('重复：没有把预算耗光', calls.length === 3);
    }
    {
      // 但滑动不一样：滚一屏本来就得连着划好几下，放宽到第 6 遍（10:49「往下滑看其他结果」被误伤过）
      const pages = Array.from({ length: 8 }, (_, k) => ({
        app: '相册',
        pkg: 'com.android.gallery3d',
        hash: `h-swipe-${k}`,
        table: `n0 第${k + 1}屏`,
        nodes: [node(`第${k + 1}屏`)],
      }));
      const phone = fakePhone(pages);
      const { run, calls } = mkAgent(phone, { replies: ['swipe up'] });
      const res = await run('看看相册里有什么');
      ok('滑动：允许连着划到第 6 遍才止损', res.ok === false && calls.length === 6 && /6 遍/.test(res.summary));
    }

    // 5.7 done 要过断言
    {
      const phone = fakePhone([shot1]);
      // 用干净的记忆目录：不然会命中前面几节写下的"这一屏该点哪"（那是另一件事）
      const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dsp-phone-assert-'));
      const { run } = mkAgent(phone, { replies: ['done 相册里有三张'], dir: d });
      const res = await run('看看相册里有什么');
      ok('断言：一步没做不许说完工', res.ok === false && /还没动手/.test(res.summary));
    }
    {
      // 做了事、但这一屏根本不是目标里的东西 → 也不许说完工
      const home = { app: '桌面', pkg: 'app.lawnchair', hash: 'h-home', table: 'n0 图库', nodes: [node('图库')] };
      const phone = fakePhone([home]);
      const { run } = mkAgent(phone, { replies: ['tap n0', 'done 相册看完了'] });
      const res = await run('看看相册里有什么');
      ok('断言：这一屏看不到「相册」就判没成', res.ok === false && /看不到「相册」/.test(res.summary));
    }
    {
      // ★ 纯"看"的目标：没有可核对的东西，看一眼就该算完（旧版 0 步一律打回，
      //   于是"看看现在在哪个页面"永远失败，她只能瞎猜）
      const phone = fakePhone([shot1]);
      const { run } = mkAgent(phone, { replies: ['done 停在浏览器首页'] });
      const res = await run('看看现在在哪个页面');
      ok('断言：没有可核对的东西时，看一眼就算完', res.ok === true && res.steps === 0);
    }
    {
      // 但"要看也得动手"的目标，0 步仍然不许说完工（防回到 10-30 那种假成功）
      const phone = fakePhone([shot1]);
      const { run } = mkAgent(phone, { replies: ['done 随便点过了'] });
      const res = await run('随便点一下看看顺不顺');
      ok('断言：带动作词的 0 步仍然打回', res.ok === false && /还没动手/.test(res.summary));
    }
    {
      // ★ 桌面的名字就是"主页"（旧版把真的回到桌面判成失败，10-31 上午冤枉了两回）
      const home = { app: '桌面', pkg: 'app.lawnchair', hash: 'h-home', table: 'n0 图库', nodes: [node('图库')] };
      const phone = fakePhone([home]);
      const { run } = mkAgent(phone, { replies: ['key back', 'done 回主页了'] });
      const res = await run('返回主页看看');
      ok('断言：停在桌面 = 「主页」到了（不再冤枉她）', res.ok === true);
    }
    {
      // ★ 截图类：没真截到就不许说"发出去了"（10-31 上午就是这么丢的那张图）
      const phone = fakePhone([shot1]);
      const { run } = mkAgent(phone, { replies: ['done 截好了发出去了'] });
      const res = await run('把浏览器这页截张图发给他');
      ok('断言：没截到图不许说完事', res.ok === false && /还没截到/.test(res.summary));
    }
    {
      // ★ 主循环里真截到图 → 立刻收工，图带在结果里（上层才会发到 QQ）
      const phone = fakePhone([shot1]);
      const { run, calls } = mkAgent(phone, { replies: ['shot'] });
      const res = await run('把这一屏截图发给他');
      ok('截图：循环里截到就收工', res.ok === true && !!res.shot && res.shot.hash === 'fakehash');
      ok('截图：只问一次模型（截完不再乱点）', calls.length === 1 && res.steps === 1);
    }
    {
      // ★ 先…再…：两段都是快捷技能 → 0 次模型
      const home = { app: '桌面', pkg: 'app.lawnchair', hash: 'h-home', table: 'n0 图库', nodes: [node('图库')] };
      const phone = fakePhone([home]);
      const { run, calls } = mkAgent(phone);
      const res = await run('先返回再回主页');
      ok('复合目标：先返回再回主页，0 次模型做完', res.ok === true && calls.length === 0);
      ok('复合目标：真的按了返回和 HOME', phone.hits.keys.includes('back') && phone.hits.keys.includes('home'));
    }

    // 5.8 相机是陷阱：进去要拉黑，下一屏还要在 prompt 里提醒
    {
      const home = { app: '桌面', pkg: 'app.lawnchair', hash: 'h-home', table: 'n0 图库', nodes: [node('图库')] };
      const cam = { app: '相机', pkg: 'com.android.camera2', hash: 'h-cam', table: 'n0 快门', nodes: [node('快门')] };
      const a = mkAgent(fakePhone([home, cam]), { replies: ['tap n0', 'done 相机里没东西'] });
      const res = await a.run('相机里有什么');
      ok('陷阱：进相机这一屏要被拉黑', Object.values(a.agent.hints).some((h) => h.avoid === 'tap n0'));
      ok('陷阱：下一屏要在 prompt 里提醒别按快门', JSON.stringify(a.calls[a.calls.length - 1]).includes('快门'));
      ok('陷阱：任务照常收尾（不卡死）', !!res);
    }

    // 5.9 感知按需升级：树太空 → 高清图；目标要看 → 低清图（省钱）
    {
      // 树太空（非媒体 App）→ 高清图；媒体 App 走低清（见下一条）
      const thin = { app: '设置', pkg: 'com.android.settings', hash: 'h-thin', table: 'n0 相册', nodes: [node('相册')], thin: true };
      const a = mkAgent(fakePhone([thin]), { replies: ['tap n0', 'done 相册里有三张'] });
      await a.run('看看相册里有什么');
      const first = a.calls[0];
      ok('视觉：树太空时要发图', Array.isArray(first?.[1]?.content) && first[1].content.some((c) => c.type === 'image_url'));
      ok('视觉：树太空时用高清（得看清画面）', first[1].content.some((c) => c.type === 'image_url' && c.image_url.detail === 'high'));
      ok('prompt：system 稳定、目标在 user 里（缓存才命中）',
        !String(first[0].content).includes('目标：') && JSON.stringify(first[1]).includes('目标：'));
    }
    {
      // 树够用（5 项）但目标本身要"看" → 只发低清图
      const rich = {
        app: '设置', pkg: 'com.android.settings', hash: 'h-set', table: 'n0 显示\nn1 声音\nn2 存储\nn3 应用\nn4 网络',
        nodes: [node('显示'), node('声音', { ref: 'n1' }), node('存储', { ref: 'n2' }), node('应用', { ref: 'n3' }), node('网络', { ref: 'n4' })],
      };
      const a = mkAgent(fakePhone([rich]), { replies: ['tap n0', 'done 设置里看过界面了'] });
      await a.run('看看这个界面');
      const first = a.calls[0];
      ok('视觉：目标要"看"时用低清（85~150 token 量级）', first[1].content.some((c) => c.type === 'image_url' && c.image_url.detail === 'low'));
    }
    {
      // 模型不认图：第一次抛 400，第二次纯文本要能继续
      const thin = { app: '相册', pkg: 'com.android.gallery3d', hash: 'h-thin', table: 'n0 相册', nodes: [node('相册')], thin: true };
      const phone = fakePhone([thin]);
      const seen = [];
      const agent = new agentMod.PhoneAgent({
        adb: phone,
        model: { model: 'stub', maxTokens: 80, timeoutMs: 5000 },
        callModel: async (m, messages) => {
          seen.push(messages);
          if (Array.isArray(messages[1].content)) throw new Error('陪伴模型返回 HTTP 400：image not supported');
          return { text: 'tap n0' };
        },
        dir: fs.mkdtempSync(path.join(os.tmpdir(), 'dsp-phone-vis-')),
        vision: { enabled: true },
      });
      const res = await new Promise((resolve) => {
        const orig = agent.emit;
        agent.emit = (ev) => { orig(ev); if (ev.kind === 'done' || ev.kind === 'fail') resolve(ev); };
        agent.enqueue({ goal: '看看相册里有什么', by: 'her', key: 'private:1' });
      });
      ok('视觉：模型拒图后自动关掉视觉', agent.visionOK === false);
      ok('视觉：关掉之后纯文本继续跑（没有整轮挂掉）', !!res && seen.length >= 2);
    }

    // 5.9b 图库那种 GL 自绘界面：树上没有的东西，要能按图上的位置点
    {
      const gal = {
        app: '相册', pkg: 'com.android.gallery3d', hash: 'h-gal', table: 'n0 相册\nn1 切换到相机',
        nodes: [node('相册'), node('切换到相机', { ref: 'n1' })],
      };
      const phone = fakePhone([gal, shot2]);
      const { run, calls } = mkAgent(phone, { replies: ['tapxy 0.4 0.55', 'done 相册里有十四张'] });
      const res = await run('看看相册里有什么');
      ok('tapxy：按归一化坐标点（0.4,0.55 → 288,704）', JSON.stringify(phone.hits.xy) === '[288,704]');
      ok('tapxy：点完照样要验证、任务能收尾', !!res && calls.length === 2);

      const p2 = fakePhone([gal]);
      const a2 = mkAgent(p2, { replies: ['tapxy 9 0.5', 'tap n0', 'done 相册里有东西'] });
      await a2.run('看看相册里有什么');
      ok('tapxy：越界坐标不许点（不换成点击）', p2.hits.xy === undefined);
    }

    // 5.9d 点输入框不会让界面变：别当成"没反应"，也别多等 2 秒验证
    {
      const input = {
        app: '浏览器', pkg: 'mark.via', hash: 'h-input', table: 'n0 搜索框',
        nodes: [node('搜索框', { editable: true })],
      };
      const phone = fakePhone([input], { tapChanges: false });
      const { run } = mkAgent(phone, { replies: ['tap n0', 'text 大肥鱼', 'done 输进去了'] });
      const res = await run('在搜索框里打字');
      ok('输入框：点了不算"没反应"，打字能走完', res.ok === true && phone.hits.taps === 1);
    }
    {
      // ★ "输入"是动作，不是"要找的东西"（以前 `在搜索框输入…` 会被判"这一屏看不到「输入」"）
      const phone = fakePhone([shot1, shot2]);
      const { run } = mkAgent(phone, { replies: ['tap n0', 'text 小肥鱼爱洗澡', 'done 输进去了'] });
      const res = await run('在搜索框输入小肥鱼爱洗澡');
      ok('断言：动作词不算"要看的东西"（输入）', res.ok === true);
    }

    // 5.9e 一句话两件事：拆段 → 依次做完 → 一起回话（10:47「打开浏览器并随便搜点东西」）
    {
      const desk = { app: '桌面', pkg: 'app.lawnchair', hash: 'h-desk', table: 'n0 浏览器', nodes: [node('浏览器')] };
      const browser = { app: '浏览器', pkg: 'mark.via', hash: 'h-via', table: 'n0 地址栏', nodes: [node('地址栏')] };
      const results = { app: '浏览器', pkg: 'mark.via', hash: 'h-res', table: 'n0 搜索结果', nodes: [node('搜索结果')] };
      const phone = fakePhone([desk, browser, results]);
      const a = mkAgent(phone, { replies: ['done 搜索结果看过了'] });
      const res = await a.run('打开浏览器并随便搜点东西');
      ok('多步：拆成两段依次做', res.ok === true && res.plan?.length === 2);
      ok('多步：第一段真的打开了浏览器', phone.hits.launches >= 1);
      /**
       * ★ 2026-11-06 21:40：搜索**不再一句话收工**（用户：「我是想她学会浏览」）。
       * 现在搜完会回到循环里，由她自己看一眼再决定，所以这里必然有一次模型调用。
       */
      ok('多步：第二段搜了网页（不是图片页）', /\/search\?q=/.test(phone.hits.url || '') && !/images\/search/.test(phone.hits.url || ''));
      ok('多步：搜完回到循环里，她会看一眼', a.calls.length >= 1);
      ok('多步：报表/回灌用的是用户原话', res.goal === '打开浏览器并随便搜点东西');
    }
    {
      // 给了词的搜索：一条 intent 直接到结果页，屏上得真看见那个词才算搜到；
      // 然后回到循环，她看一眼再收工（2026-11-06 21:40 起）
      const browser = { app: '浏览器', pkg: 'mark.via', hash: 'h-via', table: 'n0 地址栏', nodes: [node('地址栏')] };
      const resPage = { app: '浏览器', pkg: 'mark.via', hash: 'h-res1', table: 'n0 大肥鱼 - 搜索', nodes: [node('大肥鱼 - 搜索')] };
      const phone = fakePhone([browser, resPage]);
      const { run, calls } = mkAgent(phone, { replies: ['read', 'done 大肥鱼的结果页出来了'] });
      const res = await run('搜索大肥鱼');
      ok('搜索：给了词就直接到结果页', res.ok === true);
      ok('搜索：网址里带上了那个词', /%E5%A4%A7%E8%82%A5%E9%B1%BC/.test(phone.hits.url || ''));
      ok('搜索：页面上真有那个词才继续', calls.length >= 1);
      ok('搜索：说清搜的是哪个词', /大肥鱼/.test(res.summary));
    }
    {
      /**
       * ★ 2026-11-06 21:40（用户实测）：「我是想她学会浏览，**不是一进来就默认图片页面**」。
       *
       * 上一版按关键词判断"要不要看图"，结果她每次一进来就停在图片页，
       * 结果页 / 网页 / 点进去看一次都没走过。现在搜索**一律网页**，
       * 看图是她自己在浏览里写的 `images 词`。
       */
      ok('搜索：不再按关键词猜要不要看图', agentMod.quickSkill('搜看起来顺眼的图')?.images === undefined);
      ok('搜索：表情包也先走网页（看图要她自己说）', agentMod.quickSkill('搜小肥鱼表情包')?.images === undefined);
    }
    {
      const browser = { app: '浏览器', pkg: 'mark.via', hash: 'h-via', table: 'n0 地址栏', nodes: [node('地址栏')] };
      const grid = { app: '浏览器', pkg: 'mark.via', hash: 'h-grid', table: 'n0 看起来顺眼的图', nodes: [node('看起来顺眼的图')] };
      const phone = fakePhone([browser, grid]);
      const { run, calls } = mkAgent(phone, { replies: ['done 搜完了'] });
      const res = await run('搜看起来顺眼的图');
      ok('搜索：默认走的是网页搜索', /\/search\?q=/.test(phone.hits.url || '') && !/images\/search/.test(phone.hits.url || ''));
      ok('搜索：搜完不是立刻完工，她会进循环看一眼', res.ok === true && calls.length >= 1);
    }
    {
      // ★ 2026-11-06（P0）：屏没变就不算搜到 —— 旧判据"屏上有这个词"白屏也能过
      const browser = { app: '浏览器', pkg: 'mark.via', hash: 'h-via', table: 'n0 大肥鱼 - 搜索', nodes: [node('大肥鱼 - 搜索')] };
      const phone = fakePhone([browser], { tapChanges: false });
      const { run } = mkAgent(phone);
      const res = await run('搜索大肥鱼');
      ok('搜索：页面没变（白屏/没加载）不算搜到', res.ok === false && /没搜出来/.test(res.summary));
    }
    {
      // 屏上没出现那个词 = 没搜出来，不许说搜到了
      const browser = { app: '浏览器', pkg: 'mark.via', hash: 'h-via', table: 'n0 地址栏', nodes: [node('地址栏')] };
      const phone = fakePhone([browser], { tapChanges: false });
      const { run } = mkAgent(phone);
      const res = await run('搜索不存在的词');
      ok('搜索：屏上没有那个词就判失败', res.ok === false && /没搜出来/.test(res.summary));
    }
    {
      // "随便搜点东西"是固定套路：画面没动就是没搜成
      const browser = { app: '浏览器', pkg: 'mark.via', hash: 'h-via', table: 'n0 地址栏', nodes: [node('地址栏')] };
      const phone = fakePhone([browser], { tapChanges: false });
      const { run } = mkAgent(phone);
      const res = await run('随便搜点东西');
      ok('搜索：画面没动就说没搜成', res.ok === false && /没动|没搜出去/.test(res.summary));
    }
    {
      // 前一段没成就别硬做后一段（"先返回再回主页"这种反例留给 seq；这里测"打开一个打不开的 App"）
      const desk = { app: '桌面', pkg: 'app.lawnchair', hash: 'h-desk', table: 'n0 浏览器', nodes: [node('浏览器')] };
      const phone = fakePhone([desk]);
      phone.launch = async () => ({ ok: false, pkg: '', msg: 'no activity' });
      const { run } = mkAgent(phone, { replies: ['done 不该走到这'] });
      const res = await run('打开浏览器并随便搜点东西');
      ok('多步：第一段没成，如实说、不硬撑', res.ok === false && /打不开/.test(res.summary));
    }

    // 5.9c 横屏：真的画幅是 1280×720，滑动/坐标都得按它算
    {
      const landScreen = { width: 1280, height: 720, density: 320 };
      const land = { app: '游戏中心', pkg: 'com.mumu.game', hash: 'h-land', table: 'n0 传奇专区', nodes: [node('传奇专区')], screen: landScreen };
      const land2 = { app: '游戏中心', pkg: 'com.mumu.game', hash: 'h-land2', table: 'n0 网易专区', nodes: [node('网易专区')], screen: landScreen };
      const phone = fakePhone([land, land2]);
      const a = mkAgent(phone, { replies: ['swipe up', 'done 看过了'] });
      const res = await a.run('看看游戏中心里有什么');
      ok('横屏：滑动按这一屏的画幅算（1280 宽）', phone.hits.swipeScreen?.width === 1280);
      ok('横屏：prompt 里说清了现在是横屏', JSON.stringify(a.calls[0]).includes('横屏'));
      ok('横屏：任务照常收尾', !!res);
    }

    // 5.10 旧记忆（没有目标、没有计数）一律丢掉
    {
      const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dsp-phone-mig-')), 'hints.json');
      fs.writeFileSync(f, JSON.stringify({
        version: 1,
        items: {
          bbca02900f9b7b7fd8a7249063d3d1413ab08647: { action: 'tap n3', ok: 1, at: 1 },
          'app.lawnchair|h-home|相册': { act: 'tap n3', succ: 2, fail: 0, at: 2 },
        },
      }), 'utf8');
      const loaded = agentMod.loadHints(f);
      ok('迁移：旧格式（只有屏指纹）不读进来', !Object.keys(loaded).some((k) => k.split('|').length < 3));
      ok('迁移：新格式（带意图和计数）保留', Object.keys(loaded).length === 1);
    }

    /* ---------- 5.11 层 0（2026-10-31）：done 弹回 ---------- */

    /** 每个用例一个新目录：别让上一块记下的屏级记忆替它把这一步做了（否则 0 调用就"做完"了）。 */
    const freshDir = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `dsp-phone-${tag}-`));

    {
      // 一句话里有动作词、却一步没做就说"完了" → 打回，**不许直接判死**
      const phone = fakePhone([shot1]);
      const events = [];
      const a = mkAgent(phone, { dir: freshDir('bounce1'), replies: ['done 我好了', 'tap n0', 'done 相册里有三张'], onEvent: (e) => events.push(e) });
      const res = await a.run('看看相册里有什么');
      ok('弹回：先说完了会被打回一次', events.filter((e) => e.kind === 'bounce').length === 1);
      ok('弹回：打回之后接着做、最后能成', res.ok === true && res.steps === 1);
    }
    {
      // 连打回 3 次才认输 —— 11:41 那条自主任务 0 步就死，就是没有这个缓冲
      const a = mkAgent(fakePhone([shot1]), { dir: freshDir('bounce2'), replies: ['done 一', 'done 二', 'done 三'], budget: { maxSteps: 8, maxCalls: 8 } });
      const res = await a.run('看看相册里有什么');
      ok('弹回：连着说三次完了才判失败', res.ok === false && /我还没动手/.test(res.summary));
      ok('弹回：理由写进了下一轮 prompt（她看得见）', JSON.stringify(a.calls[1] || []).includes('被打回'));
      ok('弹回：不会被"同一动作连着做 3 遍"误杀', !/同一个动作/.test(res.summary));
    }

    /* ---------- 5.12 层 0：per-task 预算真的生效 ---------- */

    {
      const a = mkAgent(fakePhone([shot1, shot2]), { dir: freshDir('budget1'), replies: ['tap n0', 'tap n0', 'tap n0'], budget: { maxSteps: 12, maxCalls: 12 } });
      const res = await a.run('看看相册里有什么', { budget: { maxSteps: 1 } });
      ok('预算：任务自己的 maxSteps 生效（不是全局 12）', res.steps === 1 && /1 步用完了/.test(res.summary));
    }
    {
      const a = mkAgent(fakePhone([shot1, shot2]), { dir: freshDir('budget2'), replies: ['tap n0', 'tap n0', 'tap n0'], budget: { maxSteps: 12, maxCalls: 12 } });
      const res = await a.run('看看相册里有什么', { budget: { maxCalls: 1 } });
      ok('预算：任务自己的 maxCalls 生效', /问不动了/.test(res.summary));
    }

    /* ---------- 5.13 层 0：episodes 记下"这件事是谁起的" ---------- */

    {
      const d = freshDir('src');
      const a = mkAgent(fakePhone([shot1]), { dir: d });
      await a.run('看看相册里有什么', { src: 'session', session: 's1', replies: ['tap n0', 'done 看完了'] });
      const line = JSON.parse(fs.readFileSync(path.join(d, 'episodes.jsonl'), 'utf8').trim().split('\n').pop());
      ok('记账：episodes 带上了 src 和会话 id', line.src === 'session' && line.session === 's1');
      a.agent.adb = fakePhone([shot1]);
      await a.run('看看相册里有什么', { replies: ['tap n0', 'done 看完了'] });
      const last = JSON.parse(fs.readFileSync(path.join(d, 'episodes.jsonl'), 'utf8').trim().split('\n').pop());
      ok('记账：没说 src 的按 chat 算（自主/手动才分得开）', last.src === 'chat');
    }

    /* ---------- 5.14 层 0：截图类目标的说法（真机上"截下来"原来不认） ---------- */

    {
      // 真机教训：会话里写的是"挑一张，截下来"，SHOT_GOAL 不认 → 没截到也算成、还一路往下翻
      const a = mkAgent(fakePhone([shot1]), { dir: freshDir('shotword'), replies: ['done 挑好了'] });
      const res = await a.run('挑一张像我的，截下来');
      ok('断言：「截下来」也算截图类目标（没截到不许说完）', res.ok === false && /没截到图/.test(res.summary));
    }
    {
      // 反过来：目标里带"截一张"，模型翻了三屏还没按快门 → prompt 里要点它一下
      const a = mkAgent(fakePhone([shot1, shot2]), { dir: freshDir('shotpush'), replies: ['swipe up', 'swipe up', 'swipe up'], budget: { maxSteps: 4, maxCalls: 4 } });
      await a.run('挑一张最好看的，截一张发给他', { src: 'session' });
      const said = JSON.stringify(a.calls[a.calls.length - 1] || []);
      ok('prompt：截图类目标会说清"收尾动作是 shot"', said.includes('shot') && /收工|收尾动作/.test(said));
    }

    /* ---------- 5.15 层 0：会话里的小目标不许被拆段 ---------- */

    {
      const events = [];
      const a = mkAgent(fakePhone([shot1]), { dir: freshDir('nosplit'), replies: ['done 就是这张'], onEvent: (e) => events.push(e) });
      await a.run('打开相册，往下翻，挑一张说清这张里是什么', { src: 'session' });
      const start = events.find((e) => e.kind === 'start');
      ok('拆段：会话里的小目标不拆（"往下翻"单独拿出来没法验）', Array.isArray(start.plan) && start.plan.length === 0);
      const chat = [];
      const b = mkAgent(fakePhone([shot1]), { dir: freshDir('split2'), replies: ['done 好了'], onEvent: (e) => chat.push(e) });
      await b.run('打开浏览器，随便搜点东西');
      ok('拆段：他嘴里的一句话照旧拆', (chat.find((e) => e.kind === 'start') || {}).plan.length >= 1);
    }

    /* ---------- 5.16 层 0：要看的东西本来就在屏上，0 步也算看过了 ---------- */

    {
      // 相册已经被代码先开好（`phone-life.preOpen`），她看一眼就能说清
      const a = mkAgent(fakePhone([shot1]), { dir: freshDir('see'), replies: ['done 这张是一个蓝发蓝眼的小女仆，穿蓝白围裙'] });
      const res = await a.run('挑一张照片，说清这张里是什么', { src: 'session' });
      ok('断言：东西已在屏上 + 她说清了 → 0 步也认', res.ok === true && res.steps === 0);
    }
    {
      // 但"done 好了"这种糊弄不行
      const a = mkAgent(fakePhone([shot1]), { dir: freshDir('see2'), replies: ['done 好了', 'done 好了', 'done 好了'], budget: { maxSteps: 4, maxCalls: 4 } });
      const res = await a.run('挑一张照片，说清这张里是什么', { src: 'session' });
      ok('断言：说清了才放行，"done 好了"照样打回', res.ok === false);
    }
    {
      // 屏上没有那个东西 → 0 步仍然打回（老规矩没被放松）
      const desk = { app: '桌面', pkg: 'app.lawnchair', hash: 'h-desk2', table: 'n0 相册', nodes: [node('相册')] };
      const a = mkAgent(fakePhone([desk]), { dir: freshDir('see3'), replies: ['done 相册里有三张照片', 'done 真的有三张', 'done 三张'], budget: { maxSteps: 4, maxCalls: 4 } });
      const res = await a.run('挑一张照片，说清这张里是什么', { src: 'session' });
      ok('断言：桌面不算"已经有"（老规矩还在）', res.ok === false);
    }

    /**
     * 5.10 ★ 2026-11-01：**他那一句排在会话任务前面，而且不会被队列上限拒掉**。
     * 以前 `queue.length >= 2` 一律拒 —— 包括他刚在聊天里让她去看的那件，
     * 于是她答应了"我去看看"，然后几分钟里什么都不发生。
     *
     * ★ 2026-11-08 改了一半：他那一句**仍然排在最前面**，但队列**不再超过 `QUEUE_MAX`**。
     * 原来"他那句完全不受上限约束"，结果他连说五句就排五件，最后执行的是八分钟前的话
     * （真机 11-07 23:34–23:40：一条 192 秒的任务压住了后面三分钟里所有的话）。
     * 现在超了先丢**她自己的**会话任务（丢最旧那件），他的旧指令也不会无限堆。
     */
    {
      const { agent } = mkAgent(fakePhone([shot1]));
      agent.task = { goal: '正做着的', id: 'busy1' };
      agent.queue = [
        { id: 's1', goal: '会话一', src: 'session' },
        { id: 's2', goal: '会话二', src: 'session' },
      ];
      const mine = agent.enqueue({ goal: '帮我看看相册', src: 'chat', key: 'private:1' });
      ok('队列：两件会话任务排着时，他那一句仍然接得进来（以前静默拒掉）',
        mine.accepted === true && agent.queue[0].goal === '帮我看看相册');
      ok('队列：他那一句在最前面，队列仍不超过 2 件（超了先丢她会话里最旧的）',
        agent.queue.map((q) => q.goal).join(',') === '帮我看看相册,会话二');
      const more = agent.enqueue({ goal: '会话三', src: 'session' });
      ok('队列：会话任务满了还是拒（只是不许拒他）', more.accepted === false && !!more.why);
      agent.task = null;
      agent.queue = [];
    }

    /**
     * 5.10b ★ 2026-11-08（真机 23:34–23:40 那一轮）：
     *   · 同一件事排两遍 → **换成新的**；
     *   · 「回桌面 / 返回」→ **插队**（手上那件做完这一步就收）；
     *   · 排太久的（> `maxQueuedMs`）→ **作废**并如实回一句。
     */
    {
      const { agent } = mkAgent(fakePhone([shot1]));
      agent.task = { goal: '搜小肥鱼', id: 'busy2', stopped: false };
      const a1 = agent.enqueue({ goal: '点网页', src: 'chat', key: 'private:1' });
      const a2 = agent.enqueue({ goal: '点网页', src: 'chat', key: 'private:1' });
      ok('队列：同一件事排两遍 → 只留一条（他 23:34:47 / 23:35:03 说了两遍「点网页」）',
        a1.accepted && a2.accepted && agent.queue.filter((q) => q.goal === '点网页').length === 1);
      ok('队列：重复的那条会报"换掉了"', /点网页/.test(String(a2.replaced || '')));

      const h = agent.enqueue({ goal: '回桌面', src: 'chat', key: 'private:1' });
      ok('队列：「回桌面」要插队 → 手上那件被标停', h.accepted === true && agent.task.stopped === true);
      ok('队列：插队的那条排在最前面', agent.queue[0].goal === '回桌面');
      ok('队列：排队条目带 kind 与 queuedAt（过期判断要用）',
        !!agent.queue[0].kind && Number(agent.queue[0].queuedAt) > 0);

      // 过期：把 queuedAt 拨回 3 分钟前，drain 应该直接作废
      const evs = [];
      agent.emit = (e) => evs.push(e);
      agent.task = null;
      agent.queue = [{ id: 'old1', goal: '往下翻一屏', src: 'chat', key: 'private:1', kind: 'scroll', queuedAt: Date.now() - 180_000 }];
      agent.budget.maxQueuedMs = 90_000;
      let ran = 0;
      agent.run = async () => { ran += 1; return {}; };
      agent.drain();
      ok('队列：排了 3 分钟的指令直接作废（屏幕早变了），不去执行', ran === 0);
      ok('队列：作废了也要如实回一句（fail 事件带 summary）', evs.some((e) => e.kind === 'fail' && /秒前说的/.test(String(e.summary))));
    }

    {
      // 桌面上的"往下翻"没有意义 —— 要如实说在桌面，别说成"到底了/手势坏了"
      const { agent } = mkAgent(fakePhone([shot1]));
      agent.perceive = async () => ({ ok: true, app: { package: 'com.mumu.launcher', name: '桌面' }, hash: 'h0', nodes: [] });
      const r = await agent.doQuick({ kind: 'scroll', dir: 'down', screens: 1 }, { id: 't', steps: [], goal: '往下翻一屏' });
      ok('快捷：在桌面上"往下翻"→ 如实说没得翻（不说"到底了"）', !!r && r.ok === false && /桌面/.test(r.summary));
    }

    {
      // 「点网页」= 0 次模型的确定动作；屏上没有这个字就交给主循环
      const withTab = {
        ok: true, app: { package: 'mark.via', name: '浏览器' }, hash: 'h1',
        nodes: [{ ref: 'n1', text: '网页', clickable: true, center: [100, 80], bounds: [0, 60, 200, 100] }],
      };
      const noTab = { ok: true, app: { package: 'mark.via', name: '浏览器' }, hash: 'h2', nodes: [] };
      const tap = agentMod.quickSkill('点网页');
      ok('快捷：「点网页」= taptext 网页（不问模型）', !!tap && tap.kind === 'taptext' && tap.needle === '网页');
      const { agent: ag1 } = mkAgent(fakePhone([shot1]));
      ag1.perceive = async () => withTab;
      ag1.execute = async () => ({ changed: true, tree: null, note: '点了「网页」' });
      const r1 = await ag1.doQuick(agentMod.quickSkill('点网页'), { id: 'x1', steps: [], goal: '点网页' });
      ok('快捷：屏上有「网页」就真的点下去，并说清点到了什么',
        !!r1 && r1.ok === true && /点了/.test(r1.summary));
      const { agent: ag2 } = mkAgent(fakePhone([shot1]));
      ag2.perceive = async () => noTab;
      const r2 = await ag2.doQuick(agentMod.quickSkill('点网页'), { id: 'x2', steps: [], goal: '点网页' });
      ok('快捷：屏上没有「网页」→ 交给主循环（返回 null，不瞎点）', r2 === null);
    }

    /**
     * 5.10d ★ 2026-11-08（真机 21:27–21:28，用户：「她不会点网页」）：
     * **「第 1 条」在结果页上是那排页签**，所以"点进去第一条"以前永远打不开网站。
     * 现在 `open N` 按"网址那一行"认条目，点的是那条的**标题**。
     */
    {
      let ri = 0;
      const B = (text, bounds, clickable = false) => ({
        ref: `b${ri++}`, text, desc: '', bounds, clickable, center: [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2],
      });
      const bingObs = {
        ok: true, app: { package: 'mark.via', name: '浏览器' }, screen, hash: 'hb', thin: false, count: 12,
        nodes: [
          B('网页', [40, 330, 120, 390], true),
          B('图片', [150, 330, 230, 390], true),
          B('视频', [260, 330, 340, 390], true),
          B('aigengtu.com', [155, 425, 350, 470]),
          B('https://aigengtu.com › DeepSeek娘', [155, 472, 620, 505]),
          B('DeepSeek娘表情包·2781张蓝色大肥鱼梗图 | 梗鲸', [155, 515, 690, 600], true),
          B('DeepSeek娘是谁？她是网友为她创作的萌拟人化身，一头爱吃白……', [155, 610, 690, 700]),
        ],
      };
      const { agent } = mkAgent(fakePhone([shot1]));
      agent.perceive = async () => bingObs;
      const task = { id: 'tb', steps: [], goal: '打开第一条', tried: [] };
      const out = await agent.execute({ verb: 'open', arg: '1', line: 'open 1' }, bingObs, task);
      ok('open：点的是第 1 条的**标题**（不是那排页签）',
        agent.adb.hits.xy && agent.adb.hits.xy[0] === bingObs.nodes[5].center[0]);
      ok('open：说清楚打开的是哪个网址', /aigengtu\.com/.test(String(out.note || '')));
      ok('open：记住打开过哪个网址（回灌要说得出"我打开了哪个网站"）', task.openedUrl === 'aigengtu.com');

      const out2 = await agent.execute({ verb: 'open', arg: '9', line: 'open 9' }, bingObs, task);
      ok('open：没有第 9 条就如实说，不瞎点', out2.changed === false && /只有 1 条/.test(String(out2.note || '')));

      const tapTab = await agent.execute({ verb: 'taptext', arg: '网页', line: 'taptext 网页' }, bingObs, task);
      ok('taptext：点搜索类型页签时必须说清"没打开任何网站"（以前她会说成"点进去了"）',
        /没有打开任何网站/.test(String(tapTab.note || '')));
    }

    {
      // 搜索结果页的处境提示：把"这一屏是什么"说死（用户点名要的）
      const w = agentMod.whereAmI({
        app: { package: 'mark.via', name: '浏览器' },
        nodes: [
          { ref: 'a', text: '网页', bounds: [40, 330, 120, 390], clickable: true, center: [80, 360] },
          { ref: 'b', text: '图片', bounds: [150, 330, 230, 390], clickable: true, center: [190, 360] },
          { ref: 'c', text: '视频', bounds: [260, 330, 340, 390], clickable: true, center: [300, 360] },
          { ref: 'd', text: 'aigengtu.com', bounds: [155, 425, 350, 470], center: [250, 447] },
          { ref: 'e', text: 'https://aigengtu.com › DeepSeek娘', bounds: [155, 472, 620, 505], center: [380, 488] },
          { ref: 'f', text: 'DeepSeek娘表情包·2781张蓝色大肥鱼梗图 | 梗鲸', bounds: [155, 515, 690, 600], clickable: true, center: [420, 557] },
          { ref: 'g', text: '这一页的摘要文字，凑够长度让结果页判据成立……', bounds: [155, 610, 690, 700], center: [420, 655] },
        ],
        screen,
      });
      ok('处境：认得出"浏览器·搜索结果页"', /搜索结果页/.test(w.at));
      ok('处境：告诉她"这一屏不是一个网站，每一条 = 一个网址"',
        /不是一个网站/.test(w.hint) && /每一条 = 一个网址/.test(w.hint));
      ok('处境：告诉她"摘要不是那个网站的内容"', /不是\**那个网站里的内容/.test(w.hint) || /不是\*\*那个网站/.test(w.hint));
      ok('处境：教她"打开第几条用 open 1"', /open 1/.test(w.hint));
      ok('处境：说明那排「网页/图片/视频」只切搜索类型、不打开网站',
        /切换搜索类型/.test(w.hint) && /不打开任何网站/.test(w.hint));
    }

    /* ---------- 5.11 几个小坑（2026-11-01） ---------- */

    {
      // 屏级记忆：拉黑也要 trim（原来只有成功记一条时才 trim，hints.json 只增不减）
      const { agent } = mkAgent(fakePhone([shot1]));
      for (let i = 0; i < 401; i += 1) agent.hints[`k${i}`] = { act: 'tap n1', succ: 0, fail: 0, at: i };
      agent.blacklist('com.x', 'h1', 'intent', 'tap n9');
      ok('屏级记忆：拉黑也会 trim（不然 hints.json 无限长）', Object.keys(agent.hints).length <= 400);
      ok('屏级记忆：刚拉黑的那条还在（trim 删的是最旧的）',
        Object.values(agent.hints).some((h) => h.avoid === 'tap n9'));
    }
    {
      // 自己挑搜索词：同一秒里连排几件不该总挑同一个（原来种子只到秒）
      const { agent } = mkAgent(fakePhone([shot1]));
      const base = 1_700_000_000_000;
      const words = new Set();
      for (let i = 0; i < 6; i += 1) words.add(agent.pickKeyword({ startedAt: base + i * 37 }));
      ok('搜索词：同一秒里连排几件也不会总挑同一个词（种子带上毫秒 + 序号）', words.size >= 2);
    }
    {
      // 打字：单引号里反斜杠只写一次（以前 shell 里多转义一遍，打路径会多出反斜杠）
      const t5 = new PhoneAdb({ home: 'X:\\fake' });
      const cmds = [];
      t5.adb = async (args) => { cmds.push(args.join(' ')); return { code: 0, out: '', err: '', ms: 1 }; };
      await t5.text('C:\\temp a');
      ok('打字：反斜杠只写一次（打路径不会再变成 C:\\\\temp；空格照旧转 %s）',
        cmds[0] === "shell input text 'C:\\temp%sa'");
      await t5.text("it's");
      ok('打字：单引号照旧转义（shell 不会把它当成引号结束）', cmds[1].includes("'\\''"));
    }

    /* ---------- 7. 每一步的"处境反馈"（2026-11-01 用户原话） ---------- */

    {
      /**
       * 用户：「是不是需要操控的时候每次给她反馈一下（这次目标是想找个好看的视频，
       * 我刚刚点进了哔哩哔哩，现在我该在主页下滑或者挑一个感兴趣的看，下一步是…）」。
       */
      const at = agentMod.whereAmI;
      ok('处境：桌面时说得出"用 launch 打开某个 App"',
        at({ app: { package: 'app.lawnchair', activity: 'app.lawnchair.LawnchairLauncher' } }).at === '桌面');
      ok('处境：哔哩哔哩首页 → 告诉她搜索框在顶上、卡片点封面、没想看的就往下翻',
        (() => { const w = at({ app: { package: 'tv.danmaku.bili', activity: 'tv.danmaku.bili.MainActivityV2' } });
          return w.at.includes('首页') && w.hint.includes('搜索框') && w.hint.includes('scroll down'); })());
      ok('处境：搜索页 → 告诉她"点带时长的结果卡片"，别在页面上反复点',
        (() => { const w = at({ app: { package: 'tv.danmaku.bili', activity: 'com.bilibili.search2.main.BiliMainSearchActivity' } });
          return w.at.includes('搜索') && w.hint.includes('时长') && w.hint.includes('key back'); })());
      ok('处境：视频页 → 告诉她"不想看就 back / 竖屏上滑换下一个"',
        (() => { const w = at({ app: { package: 'tv.danmaku.bili', activity: 'com.bilibili.ship.theseus.detail.UnitedBizDetailsActivity' } });
          return w.at.includes('视频') && w.hint.includes('back') && w.hint.includes('swipe up'); })());

      const { agent } = mkAgent(fakePhone([shot1]));
      const obsB = {
        app: { name: '哔哩哔哩', package: 'tv.danmaku.bili', activity: 'com.bilibili.search2.main.BiliMainSearchActivity' },
        count: 2, table: 'n0 综合 [tap]\nn1 偷摸小肥鱼尾巴 末儿克丝Morx 0:44 [tap]', screen: { width: 720, height: 1280 },
      };
      const task = { goal: '点上面搜索框，输入小肥鱼，点搜索', trail: [], tried: ['tap n6→没变（可能没点中）'], plan: [], steps: [] };
      const msgs = agent.buildMessages(task, obsB);
      const body = String(msgs[1].content[0]?.text || msgs[1].content);
      ok('处境：每一步的 prompt 里都写了"你在哪 / 下一步可以"',
        body.includes('【你在哪】哔哩哔哩·搜索结果页') && body.includes('【下一步可以】'));
      ok('处境：上一步"没点中"会明确告诉她（别原样再点一遍）',
        body.includes('【上一步】') && body.includes('没变（可能没点中）'));
      ok('处境：哔哩哔哩的 App 常识（搜索框/结果卡片/返回）每一屏都带着',
        body.includes('哔哩哔哩：顶部搜索框') && body.includes('key back'));
    }

    /* ---------- 9. 弹窗/广告层 + 观测复用（2026-11-02） ---------- */

    {
      const popupMod = ctx.mod('phone-popup');
      const scr = { width: 720, height: 1280 };
      const N = (ref, text, bounds, extra = {}) => ({
        ref, text, desc: '', class: 'TextView', clickable: true, editable: false, scrollable: false,
        checkable: false, checked: false, longClick: false, enabled: true, password: false,
        bounds, center: [(bounds[0] + bounds[2]) >> 1, (bounds[1] + bounds[3]) >> 1], pkg: '', ...extra,
      });

      const permObs = {
        ok: true, screen: scr, app: { name: '哔哩哔哩', package: 'tv.danmaku.bili' },
        nodes: [
          N('n0', '要允许哔哩哔哩访问你的照片和视频吗？', [60, 600, 660, 700], { clickable: false }),
          N('n1', '允许', [420, 900, 700, 960]),
          N('n2', '不允许', [20, 900, 320, 960]),
        ],
      };
      const p1 = popupMod.scan(permObs);
      ok('弹窗：权限框认出来了', !!p1 && p1.id === 'perm');
      ok('弹窗：点的是「不允许」，不是「允许」', !!p1 && p1.text === '不允许');
      ok('弹窗：正向词永远进不了关闭候选（允许 / 立即安装 / 登录）',
        popupMod.closers({ nodes: [N('n0', '允许', [0, 0, 100, 40])] }).length === 0
        && popupMod.closers({ nodes: [N('n0', '立即安装', [0, 0, 200, 40])] }).length === 0
        && popupMod.closers({ nodes: [N('n0', '登录', [0, 0, 200, 40])] }).length === 0);
      /** 白名单里的词也可能带正向字（"同意并关闭"）—— 这种宁可不点。 */
      ok('弹窗：带「同意」的关闭词一律不点',
        popupMod.scan({
          ok: true, screen: scr,
          nodes: [N('n0', '版本更新', [40, 400, 400, 460]), N('n1', '同意并关闭', [400, 900, 700, 960])],
        }) === null);
      /** 只有关闭词、没有信号词 = 正常页面（比如表单上的取消），不动。 */
      ok('弹窗：只有「取消」没有弹窗信号 → 不当弹窗',
        popupMod.scan({ ok: true, screen: scr, nodes: [N('n0', '取消', [20, 900, 320, 960])] }) === null);
      /** 只有信号词、没有关闭词 = App 自己的登录入口，不动。 */
      ok('弹窗：只有「登录」没有关闭词 → 不动（B 站首页右上角那个）',
        popupMod.scan({ ok: true, screen: scr, nodes: [N('n0', '登录', [600, 60, 700, 120])] }) === null);

      const adObs = {
        ok: true, screen: scr, app: { name: '哔哩哔哩', package: 'tv.danmaku.bili' },
        nodes: [
          N('n0', '广告', [40, 1100, 150, 1140], { clickable: false }),
          N('n1', '跳过 5s', [560, 120, 700, 180]),
        ],
      };
      const a1 = popupMod.scan(adObs);
      ok('弹窗：插屏广告认出来了（跳过 5s）', !!a1 && a1.id === 'ad' && a1.text === '跳过 5s');

      const bannerObs = {
        ok: true, screen: scr, app: { name: '浏览器', package: 'mark.via' },
        nodes: [
          N('n0', '打开App', [80, 900, 400, 960]),
          N('n1', '继续在浏览器', [80, 1000, 400, 1060]),
          N('n2', '立即打开', [420, 900, 700, 960]),
        ],
      };
      const b1 = popupMod.scan(bannerObs);
      ok('弹窗：浏览器「打开 App」横幅 → 点「继续在浏览器」', !!b1 && b1.id === 'openapp' && b1.text === '继续在浏览器');

      const loginObs = {
        ok: true, screen: scr, app: { name: '哔哩哔哩', package: 'tv.danmaku.bili' },
        nodes: [N('n0', '登录后继续', [200, 700, 520, 780]), N('n1', '以后再说', [200, 900, 520, 960])],
      };
      const l1 = popupMod.scan(loginObs);
      ok('弹窗：登录墙认出来了，而且标了 wall（反复出现就不硬刚）', !!l1 && l1.id === 'login' && l1.wall === true);

      /**
       * ★ 真机上的坑：视频页整块播放器占满屏 + 右上角「关闭弹幕」+ 一个「登录」按钮。
       * 三条判据（遮罩 / 关闭词 / 登录）任何一条松一点，她就会去点「关闭弹幕」。
       */
      ok('弹窗：视频页的「关闭弹幕」不算关闭键，右上角「登录」也不算墙',
        popupMod.scan({
          ok: true, screen: scr, app: { name: '哔哩哔哩', package: 'tv.danmaku.bili' },
          nodes: [
            N('n0', '视频画面', [0, 0, 720, 1180]),
            N('n1', '关闭弹幕', [560, 40, 700, 90]),
            N('n2', '登录', [600, 100, 700, 150]),
          ],
        }) === null);
      ok('弹窗：真的全屏广告（右上角只有「跳过」）还是认得出',
        (() => {
          const h = popupMod.scan({
            ok: true, screen: scr, app: { name: '哔哩哔哩', package: 'tv.danmaku.bili' },
            nodes: [N('n0', '开屏', [0, 0, 720, 1180]), N('n1', '跳过 3', [560, 60, 700, 120])],
          });
          return !!h && h.id === 'mask' && /跳过/.test(h.text);
        })());

      /**
       * ★ 2026-11-02 真机（用户截图）：B 站「登录注册解锁更多精彩内容」弹窗，
       * 关闭键是一个**没有字**的 × —— 旧词表一个都不认（写的是"注册登录"，弹窗写的是"登录注册"），
       * 于是整层不动手，她卡在那儿等人说话。
       */
      {
        const modal = {
          ok: true, screen: scr, app: { name: '哔哩哔哩', package: 'tv.danmaku.bili' },
          nodes: [
            N('n0', '登录注册解锁更多精彩内容', [180, 380, 700, 430], { clickable: false }),
            N('n1', '请输入手机号', [300, 520, 700, 580]),
            N('n2', '验证登录', [180, 620, 700, 700]),
            N('n3', '账号密码', [300, 950, 480, 1000]),
            N('n4', '', [640, 370, 700, 420]),
            N('n5', '', [160, 330, 720, 1010]),
          ],
        };
        const m = popupMod.scan(modal);
        ok('弹窗：B 站登录墙认得出（"登录注册…解锁"这种说法）', !!m && m.id === 'login');
        ok('弹窗：没有字的 × 也能点（否则她只能等人）', !!m && m.text === '×' && m.node.center[0] === 670);
        /** 反向：信息流里的"广告"卡片不能当成弹窗（满宽 → 不算对话框）。 */
        ok('弹窗：满宽的广告卡片不会被当成对话框',
          popupMod.scan({
            ok: true, screen: scr, app: { name: '哔哩哔哩', package: 'tv.danmaku.bili' },
            nodes: [N('n0', '跟着UP主买同款好物', [0, 200, 720, 640]), N('n1', '', [640, 210, 710, 270])],
          }) === null);
      }

      /** ---- 端到端：一进来就是广告 → 0 次模型调用关掉 → 继续做事 ---- */
      function miniPhone(screens) {
        let i = 0;
        const hits = { observe: 0, tapXY: 0, waits: 0, keys: [], swipes: 0 };
        const cur = () => screens[Math.min(i, screens.length - 1)];
        const appOf = (s) => s.app || { name: '哔哩哔哩', package: 'tv.danmaku.bili', activity: 'tv.danmaku.bili.MainActivityV2' };
        const view = (s) => ({ nodes: s.nodes, table: s.table, hash: s.hash, count: s.nodes.length, more: 0, thin: false, screen: scr });
        return {
          hits,
          async state() { return { online: true, booted: true, screen: scr, app: appOf(cur()) }; },
          async observe() {
            hits.observe += 1;
            const s = cur();
            return { ok: true, app: appOf(s), screen: scr, count: s.nodes.length, nodes: s.nodes, table: s.table, hash: s.hash, thin: false };
          },
          async tapXY() { hits.tapXY += 1; return { ok: true, ms: 1 }; },
          async tap() { hits.tapXY += 1; return { ok: true, changed: true, label: 'ok' }; },
          async swipeDir() { hits.swipes += 1; return { ok: true }; },
          async text() { return { ok: true }; },
          async key(name) { hits.keys.push(name); return { ok: true }; },
          async openUrl() { return { ok: true }; },
          async launch() { return { ok: true, pkg: 'tv.danmaku.bili' }; },
          async focusApp() { return appOf(cur()).package; },
          /** 界面是被"上一步动作"改掉的，所以这里推进一屏（和真机一样：等它变）。 */
          async waitChange() { hits.waits += 1; if (i < screens.length - 1) i += 1; return { changed: true, ms: 1, tree: view(cur()) }; },
          async screenshot() { const png = Buffer.from('89504e470d0a1a0a', 'hex'); return { ok: true, png, bytes: png.length, hash: 'h' }; },
        };
      }

      const content = {
        hash: 'h-content', table: 'n0 推荐 [tap]\nn1 热门 [tap]',
        nodes: [N('n0', '推荐', [40, 200, 340, 280]), N('n1', '热门', [380, 200, 680, 280])],
      };
      {
        const phone = miniPhone([adObs, content]);
        const events = [];
        const { run, calls } = mkAgent(phone, { replies: ['done 看到了'], onEvent: (e) => events.push(e) });
        const res = await run('看看这一屏');
        ok('弹窗：一进来是广告，0 次模型调用就关掉（模型只用在真正的事上）', res.ok && calls.length === 1);
        ok('弹窗：关掉之后继续做事，不是"卡住"', phone.hits.tapXY === 1 && phone.hits.swipes === 0);
        ok('弹窗：这一趟记账记到了（episodes 里的 popups）', res.popups === 1);
        ok('弹窗：发了一条 popup 事件（页面/日志看得到）', events.some((e) => e.kind === 'popup' && e.popup === 'ad'));
      }

      /** ---- 广告墙：同一类反复出现，就别硬刚 ---- */
      {
        const phone = miniPhone([adObs]);
        const { agent } = mkAgent(phone, { popup: { enabled: true, max: 6, maxSame: 1 } });
        const task = { id: 'tw', goal: '看视频', popupHits: {}, steps: [], tried: [], trail: [] };
        const obs = await phone.observe();
        await agent.popups(task, obs);
        await agent.popups(task, obs);
        ok('弹窗：同一类反复出现 → 记成广告墙，不再硬刚',
          !!task.wall && task.popupDead && task.popupDead.has('ad'));
        ok('弹窗：关不掉时会先按 back 试一次（不是直接放弃）', phone.hits.keys.includes('back'));
      }

      /** ---- 观测复用：一次滑动只 dump 一次屏（2026-11-02 的省时间） ---- */
      {
        const before = { hash: 'h-a', table: 'n0 第一条 [tap]', nodes: [N('n0', '第一条', [40, 200, 680, 320])] };
        const after = { hash: 'h-b', table: 'n0 第二条 [tap]', nodes: [N('n0', '第二条', [40, 200, 680, 320])] };
        const phone = miniPhone([before, after]);
        const { run, calls } = mkAgent(phone, { replies: ['swipe up', 'done 滑到头了'] });
        const res = await run('这一屏都有啥');
        ok('省时间：一次滑动只 dump 一次屏（原来是两次，2.3 秒/步）', phone.hits.observe === 1);
        ok('省时间：滑动那一步真的走了，模型两次调用', res.steps === 1 && calls.length === 2 && phone.hits.swipes === 1);
        ok('省时间：换了屏之后 hash 跟着换（不是拿旧屏冒充新屏）', res.ok === true);
      }

      /** ---- 系统弹窗不算"换 App = 有进展" ---- */
      {
        const { agent } = mkAgent(fakePhone([shot1]));
        const task = { goal: '打开相册看看照片', seen: {}, trail: [], tried: [], steps: [] };
        const A = { ok: true, app: { package: 'tv.danmaku.bili', name: '哔哩哔哩' }, hash: 'a', nodes: [], table: '' };
        const B = { ok: true, app: { package: 'com.android.permissioncontroller', name: '权限控制器' }, hash: 'b', nodes: [], table: '' };
        ok('判进展：系统权限框弹出来不算"她进了别的 App"', agent.judge(A, B, task, true) === false);
      }

      /**
       * ---- ★ 2026-11-02 真机：在两页之间来回跳（back → 点 → back → 点）----
       * 现场「退出去换一个视频看」：同一个视频点进去又退出来五次。
       * B 站的表格里到处是"视频"，`goalNouns` 每一步都判"近了"，于是永远不算卡住。
       */
      {
        const { agent } = mkAgent(fakePhone([shot1]));
        const task = { goal: '退出去换一个视频看', seen: {}, trail: [], tried: [], steps: [], placeSeq: [] };
        const feed = { ok: true, app: { package: 'tv.danmaku.bili', name: '哔哩哔哩', activity: 'tv.danmaku.bili.MainActivityV2' }, hash: 'f', nodes: [], table: 'n0 视频,偷摸小肥鱼尾巴,208万观看' };
        const detail = { ok: true, app: { package: 'tv.danmaku.bili', name: '哔哩哔哩', activity: 'com.bilibili.ship.theseus.detail.UnitedBizDetailsActivity' }, hash: 'd', nodes: [], table: 'n0 相关视频' };
        const pairs = [[feed, detail], [detail, feed], [feed, detail], [detail, feed], [feed, detail]];
        const firstFive = pairs.map(([p, c]) => agent.judge(p, c, task, true, { verb: 'tap' }));
        const sixth = agent.judge(detail, feed, task, true, { verb: 'key' });
        ok('判进展：前几步照常算前进（B 站表格里有"视频"两个字）', firstFive.every(Boolean) === true);
        ok('判进展：A→B→A→B 跳了三轮就不再算进展（不然永远不触发退路）',
          sixth === false && task.tried.some((x) => /来回跳/.test(x)));
      }
    }

    /* ---------- 8. 能力提示 ---------- */

    const withPhone = caps.buildCapabilityHints({ phone: { on: true, app: '相册', busy: false } });
    ok('能力：手机开着才有【手机】', withPhone.includes('【手机】') && withPhone.includes('[手机:'));
    ok('能力：提示里带上了当前 App', withPhone.includes('相册'));
    const without = caps.buildCapabilityHints({});
    ok('能力：没开就完全不提手机', !without.includes('【手机】'));
    {
      // ★ 2026-10-31：她手上有件事 + 正玩着 + 正等他点头 —— 三种都只加一句，不啰嗦
      const h1 = caps.buildCapabilityHints({ phone: { on: true, life: { focus: { text: '攒 6 张像我的图', got: 2, goal: 6 } } } });
      ok('能力：说得出"手上还有件没做完的事"', h1.includes('攒 6 张像我的图') && h1.includes('2/6'));
      const h2 = caps.buildCapabilityHints({ phone: { on: true, life: { session: { theme: 'album', idx: 1, of: 3 } } } });
      ok('能力：玩着的时候她知道自己在第几件', h2.includes('正玩着') && h2.includes('2/3'));
      const h3 = caps.buildCapabilityHints({ phone: { on: true, life: { proposal: { status: 'pending' } } } });
      ok('能力：等着他点头时不许重复问', h3.includes('别重复问'));
    }
    {
      // 她做完了手上的事，就别再提
      const h = caps.buildCapabilityHints({ phone: { on: true, life: { focus: { text: '攒 6 张像我的图', got: 6, goal: 6, done: true } } } });
      ok('能力：做完了就不再挂着那件事', !h.includes('攒 6 张像我的图'));
    }

    /* ---------- 7. 接线（companion 默认关、状态可读） ---------- */

    ok('接线：默认不接管手机', companion.DEFAULTS.phone.enabled === false);
    ok('接线：默认跟 QQ 同一套模型', companion.DEFAULTS.phone.model.mode === 'same');
    ok('接线：手机状态可读且默认关', companion.phone.state().on === false);
    ok('接线：手机模型默认等于 QQ 模型', companion.phone.model().model === companion.publicState().model.model);
    ok('接线：视觉默认开、默认低清', agentMod.DEFAULTS.vision.enabled === true && agentMod.DEFAULTS.vision.detail === 'low');

    /**
     * ★ 2026-11-01：手机上排不下的时候要**回灌给她一句**（以前这条信息只进日志）：
     * 她在 QQ 上答应了"我去看看"，结果什么都没发生，用户以为她在装样子。
     */
    const hint = companion.phone.refusedHint([{ goal: '打开相册', why: '手机上还有两件事没做完' }]);
    ok('没排上：把原因写成她会说的话（带上目标 + 为什么 + 别装成做完了）',
      hint.includes('打开相册') && hint.includes('两件事没做完') && hint.includes('没排上')
      && hint.includes('别装成已经做完了'));
    ok('没排上：没有目标时不编一句话', companion.phone.refusedHint([]) === '');

    /* ---------- 9. ★ 2026-11-08：能"按文字点"、搜完给下一步、手机刚亮的实话 ---------- */

    {
      /**
       * 提示里教了三次「先 `tap` 那个输入框」「`tap` 它就能打字」，
       * 可 `execute('tap')` 以前**只认 nN**：照着提示写 `tap 地址栏` 只会得到
       * 「这一屏没有 地址栏」，然后开始乱试（真机 22:02 那 20 步就是这么来的）。
       */
      const browser = {
        app: '浏览器', pkg: 'mark.via', hash: 'h-via', table: 'n0 地址栏',
        nodes: [node('地址栏', { editable: true })],
      };
      const phone = fakePhone([browser]);
      const { agent } = mkAgent(phone);
      const obs = { ok: true, app: { package: 'mark.via', name: '浏览器' }, screen, hash: 'h-via', count: 1, nodes: browser.nodes };
      const hit = await agent.execute({ verb: 'tap', arg: '地址栏', line: 'tap 地址栏' }, obs, { steps: [], tried: [] });
      ok('按文字点：`tap 地址栏` 真的点到了那个输入框（不是"这一屏没有"）',
        phone.hits.taps === 1 && phone.hits.lastTap?.ref === 'n0' && hit.changed === null && /text/.test(hit.note));
    }
    {
      const { agent } = mkAgent(fakePhone([shot1]));
      const obs = { ok: true, app: { package: 'mark.via', name: '浏览器' }, hash: 'x', count: 1, nodes: [node('地址栏')] };
      const miss = await agent.execute({ verb: 'tap', arg: '优惠券', line: 'tap 优惠券' }, obs, { steps: [], tried: [] });
      ok('按文字点：屏上没有那个字就如实说，并提示改用 taptext',
        miss.changed === false && /taptext/.test(miss.note));
    }
    {
      /**
       * R-B：`点搜索框` 是一个 UI 手势，不是一件事 —— 以前落进主循环 20 步瞎点。
       * 现在 0 步回一句"要搜什么得说清一个词"。
       */
      const { run } = mkAgent(fakePhone([shot1]), { replies: ['done 好了'] });
      const res = await run('点搜索框');
      ok('R-B：「点搜索框」0 步打回，要他说清搜什么',
        res.ok === false && /说清一个词/.test(res.summary) && res.steps === 0);
    }
    {
      /**
       * R-C1：搜完的下一步写死"点开一条"。真机 22:05 搜完直接去 `images` → `save ×4`。
       * 这里只看**下一步 prompt 里有没有那句话**（不替她执行）。
       */
      const resPage = { app: '浏览器', pkg: 'mark.via', hash: 'h-res', table: 'n0 小肥鱼表情包 - 搜索', nodes: [node('小肥鱼表情包 - 搜索')] };
      const phone = fakePhone([shot1, resPage], { tapChanges: true });
      const calls = [];
      const agent = new agentMod.PhoneAgent({
        adb: phone,
        model: { model: 'stub', baseUrl: 'http://127.0.0.1:1', maxTokens: 80, timeoutMs: 5000 },
        callModel: async (m, messages) => { calls.push(messages); return { text: 'done 搜到了' }; },
        dir: fs.mkdtempSync(path.join(os.tmpdir(), 'dsp-phone-hint-')),
        rescue: { enabled: false },
        web: { async searchResults() { return { ok: true, items: [{ i: 1, title: '小肥鱼表情包合集', url: 'https://a.com/1', site: 'a.com' }] }; } },
      });
      await new Promise((resolve) => {
        const orig = agent.emit;
        agent.emit = (ev) => { orig(ev); if (ev.kind === 'done' || ev.kind === 'fail') resolve(ev); };
        agent.enqueue({ goal: '搜小肥鱼表情包', by: 'her', key: 'private:1' });
      });
      const userMsg = String(calls[0]?.[1]?.content?.[0]?.text || calls[0]?.[1]?.content || '');
      ok('R-C1：下一步 prompt 里写死了"open 1"', /【下一步】[\s\S]*open 1/.test(userMsg));
      ok('R-C1：结果页的真实网址也端给她了（"去哪里找网址"答得出来）',
        /【这一页上的条目】/.test(userMsg) && /https:\/\/a\.com\/1/.test(userMsg));
    }
    {
      /** R-D：手机刚亮 <= 10 分钟时，能力提示里补一句"之前那句不作数了"。 */
      const fresh = caps.buildCapabilityHints({ phone: { on: true, up: true, app: '桌面', readyAt: Date.now() - 60_000 } });
      ok('R-D：手机刚亮时她会知道"之前那句不作数了"', /刚亮的/.test(fresh) && /不作数/.test(fresh));
      const old = caps.buildCapabilityHints({ phone: { on: true, up: true, app: '桌面', readyAt: Date.now() - 30 * 60_000 } });
      ok('R-D：亮了很久就不再提这句', !/刚亮的/.test(old));
      const down = caps.buildCapabilityHints({ phone: { on: true, up: false } });
      ok('R-D：没亮的时候仍在说"手上没手机"', /没开/.test(down));
    }

    /**
     * ★ 2026-11-08 夜（用户：「每次打开了哔哩哔哩，然后等待一会儿**自己退出**了，压根不点视频看」）：
     *
     * 根因是**前台 App 认错**：`dumpsys window | grep mCurrentFocus` 会先列出别的 display 里
     * 残留的窗口（`mark.via`），旧代码取第一条 → 明明在最前面的 B 站被当成"浏览器"。
     * 于是 `home()` 判"不在首页"→ 连按三次 back → 把 B 站退出去 / 什么也没发生。
     * 现在只认 `mDisplayId=0` 那一块（没有就取最后一条）。
     */
    {
      const t = new PhoneAdb({ home: 'X:\\fake' });
      const multi = [
        '  mCurrentFocus=Window{67c264a u0 mark.via/mark.via.Shell}',
        '  mFocusedApp=ActivityRecord{5c02f39 u0 mark.via/.Shell t136}',
        '  Display: mDisplayId=0 rootTasks=7',
        '  mCurrentFocus=Window{f66b545 u0 tv.danmaku.bili/tv.danmaku.bili.MainActivityV2}',
      ].join('\n');
      ok('前台 App：多个 display 时只认 display 0（不是第一条残留窗口）',
        t.parseFocus(multi)?.pkg === 'tv.danmaku.bili');
      ok('前台 App：认得出 activity（首页判断要用）',
        t.parseFocus(multi)?.act === 'tv.danmaku.bili.MainActivityV2');
      ok('前台 App：没有 display 标记时取最后一条（残留窗口不会骗人）',
        t.parseFocus([
          'mCurrentFocus=Window{a u0 mark.via/mark.via.Shell}',
          'mCurrentFocus=Window{b u0 app.lawnchair/app.lawnchair.LawnchairLauncher}',
        ].join('\n'))?.pkg === 'app.lawnchair');
      ok('前台 App：完全没有就不编', t.parseFocus('') === null);
    }

    /* ---------- 10. ★ 2026-11-08 夜：命令打架 / 验证墙 / 重启软件 ---------- */

    {
      /**
       * 用户（23:10）：「命令还是在打架，我连续几次要求她搜索一下天气……
       * 她还是被前面的滑动验证注意力吸引」。
       *
       * 真机：23:06:49 手上在跑「试试滑动验证」，他 23:06:52 / 23:07:33 / 23:08:33 连说三次
       * 「搜深圳明天的天气」，三次都只是**排队**，那件又跑 119 秒；排队的天气 90 秒后过期作废。
       * 现在：他新说的那件事**压过**手上那件（做完这一步就收），新那件放队头。
       */
      const phone = fakePhone([shot1]);
      const { agent } = mkAgent(phone);
      agent.task = { id: 't-old', goal: '试试滑动验证', startedAt: Date.now(), stopped: false, steps: [] };
      const r = agent.enqueue({ goal: '搜深圳明天的天气', by: 'her', key: 'private:1', src: 'chat' });
      ok('打架：他的新指令真的打断了手上那件', agent.task.stopped === true && agent.task.preemptedBy === '搜深圳明天的天气');
      ok('打架：新那件排在队头（不用等旧的跑完）', r.accepted === true && agent.queue[0]?.goal === '搜深圳明天的天气');
      const same = fakePhone([shot1]);
      const a2 = mkAgent(same).agent;
      a2.task = { id: 't1', goal: '搜索小肥鱼', startedAt: Date.now(), stopped: false, steps: [] };
      a2.enqueue({ goal: '搜索小肥鱼', by: 'her', key: 'private:1', src: 'chat' });
      ok('打架：同一件事不会把自己打断', a2.task.stopped !== true);
    }
    {
      /** 被打断的那件**不许回灌成"没成"**（他眼里那件事他根本没让做）。 */
      const { agent } = mkAgent(fakePhone([shot1]));
      const events = [];
      const orig = agent.emit;
      agent.emit = (ev) => { events.push(ev); };
      const task = {
        id: 't9', goal: '试试滑动验证', root: '试试滑动验证', src: 'chat', key: 'private:1',
        steps: [{}, {}], allSteps: [], startsAt: Date.now(), startedAt: Date.now() - 3000,
        preemptedBy: '搜深圳明天的天气', calls: 0, trail: [], tried: [],
      };
      agent.finish(task, { ok: false, stopped: true, summary: '停了' });
      ok('打架：被打断的那件不发回灌（避免她说一句"没成"）', !events.some((e) => e.kind === 'fail' || e.kind === 'done'));
    }
    {
      /**
       * 「重启软件」：真机 23:07:56 他说「重启一下浏览器吧」→ 她写 `[手机:重启浏览器]`，
       * `quickSkill` 认不出 → 主循环 `key home → launch 浏览器`（launch 只是恢复原页），
       * 跑 125 秒 / 20 步还是那一屏。现在是一步确定动作：force-stop → 冷启动。
       */
      ok('重启：一句话就认，「重启浏览器」0 次模型',
        agentMod.quickSkill('重启浏览器')?.kind === 'restart' && agentMod.quickSkill('重启浏览器')?.app === '浏览器');
      ok('重启：口语也认（把浏览器关了再打开）',
        agentMod.quickSkill('把浏览器关了再打开')?.kind === 'restart');
      const phone = fakePhone([shot1, shot2]);
      const { run, calls } = mkAgent(phone, { replies: ['done 好了'] });
      const res = await run('重启浏览器');
      ok('重启：真的先关掉（force-stop）再打开', phone.hits.stops === 1 && phone.hits.launches >= 1);
      ok('重启：0 次模型就做完了', res.ok === true && calls.length === 0 && /关掉重开/.test(res.summary));
    }
    {
      /**
       * **验证墙**：一整屏只有一个滑块时，不许交给模型一次一次 drag（真机 20 步 / 149 秒）。
       * 这里给一张验证页：她要"搜天气"，`quickSearch` 一看见验证墙就得停下来如实说。
       */
      const browser = { app: '浏览器', pkg: 'mark.via', hash: 'h-via', table: 'n0 地址栏', nodes: [node('地址栏')] };
      const wall = {
        app: '浏览器', pkg: 'mark.via', hash: 'h-wall', table: 'n0 请拖动滑块完成拼图',
        nodes: [node('请拖动滑块完成拼图', { bounds: [20, 700, 700, 760], center: [360, 730] })],
      };
      const phone = fakePhone([browser, wall]);
      const { agent, run, calls } = mkAgent(phone, { replies: ['drag 0.1 0.5 0.9 0.5', 'done 好了'] });
      const res = await run('搜深圳明天的天气');
      ok('验证墙：不再硬磨 20 步，直接如实说被拦住', res.ok === false && /(滑块|验证)/.test(res.summary));
      ok('验证墙：换过引擎（百度）再试一次', /baidu\.com\/s\?wd=/.test(phone.hits.url || ''));
      ok('验证墙：没白跑模型', calls.length === 0);
      ok('验证墙：识别用的是屏上的字', agentMod.captchaOf({ nodes: [{ text: '请拖动滑块完成拼图' }] }) === '拖动滑块');
      ok('验证墙：讲"验证码"的新闻不算验证页',
        agentMod.captchaOf({ nodes: [{ text: '这篇报道讲的是手机验证码泄露的案子，警方提醒不要随便告诉别人验证码，也不要相信所谓客服' }] }) === '');
      const html = String(agent.systemPrompt());
      ok('提示：教了"卡住/被验证拦住就 restart 浏览器"', /restart 浏览器/.test(html) && /force-stop/.test(html));
      ok('提示：把验证页当成 App 卡住来处理（别反复 drag）', /别一次一次 drag/.test(html));
    }
  },
};
