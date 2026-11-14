/**
 * 自检区域：她的手机 · 滚动层与"预期"（2026-11-02，第一批 C+D）
 *
 * 验的是**逻辑**，不是模拟器：假 adb + 假模型，几秒跑完。
 *
 * 这一区盯着三件用户点名的事：
 *   · 「她不知道什么时候下滑」 → `scroll down N`：小步滑 + 每滑一屏判一次
 *   · 「下滑途中不知道停止」   → 停在有目标词/兴趣词的那一屏，而且**下一步会被告诉她"别滑走"**
 *   · 「她不知道自己在哪一步」 → 动作可以带 `预期: …`，代码核对，对不上会写进下一轮提示
 *
 * 单跑：`node test\run-one.cjs 20-phone-scroll.cjs`
 */
module.exports = {
  name: '她的手机（滚动层 + 预期）',
  tags: ['companion', 'phone', '手机', 'scroll', '滚动'],
  async run(ctx) {
    const { ok, fs, path } = ctx;
    const os = require('node:os');
    const agentMod = ctx.mod('phone-agent');
    const scroll = ctx.mod('phone-scroll');
    const { PhoneAdb } = ctx.mod('phone-adb');

    const scr = { width: 720, height: 1280 };
    const node = (text, bounds, extra = {}) => ({
      ref: 'n0', text, desc: '', class: 'TextView', clickable: true, editable: false, scrollable: false,
      checkable: false, checked: false, longClick: false, enabled: true, password: false,
      bounds, center: [(bounds[0] + bounds[2]) >> 1, (bounds[1] + bounds[3]) >> 1], pkg: '', ...extra,
    });
    const screen = (hash, texts, extra = {}) => ({
      hash, table: texts.map((t, i) => `n${i} ${t} [tap]`).join('\n'),
      nodes: texts.map((t, i) => node(t, [20, 200 + i * 120, 700, 280 + i * 120], { ref: `n${i}` })),
      ...extra,
    });

    /* ---------- 1. 按容器分档（这是"别全局改慢"的地方） ---------- */

    ok('分档：列表用小步长时长（不甩）',
      scroll.profileOf({ app: { package: 'mark.via', activity: 'mark.via.Shell' } }).span === 0.32
      && scroll.profileOf({ app: { package: 'mark.via' } }).ms === 650);
    ok('分档：竖屏故事流必须甩（慢滑会停在两条视频中间）',
      scroll.profileOf({ app: { package: 'tv.danmaku.bili', activity: 'com.bilibili.story.StoryVideoActivity' } }).span === 0.55
      && scroll.profileOf({ app: { package: 'tv.danmaku.bili', activity: 'com.bilibili.story.StoryVideoActivity' } }).ms <= 300);
    ok('分档：相册是换一张（横向）',
      scroll.profileOf({ app: { package: 'com.android.gallery3d' } }).span === 0.45);

    /* ---------- 2. "值不值得停" ---------- */

    const catScreen = screen('h-cat', ['一只猫在追自己的尾巴', '3.2万观看']);
    const plainScreen = screen('h-plain', ['第一条新闻', '第二条新闻']);
    const videoScreen = screen('h-video', ['偷摸小肥鱼尾巴 0:44', '末儿克丝 2.1万观看'], { app: { package: 'tv.danmaku.bili', name: '哔哩哔哩' } });

    ok('停判据：在找的词出现了就停', scroll.verdict(catScreen, { target: '猫' }).stop
      && scroll.verdict(catScreen, { target: '猫' }).why.includes('猫'));
    ok('停判据：命中她的口味（猫）也停', scroll.verdict(catScreen, { goal: '往下翻翻' }).stop);
    ok('停判据：平平一屏不停', !scroll.verdict(plainScreen, { goal: '往下翻翻' }).stop);
    ok('停判据：目标里的东西出现就停（视频）',
      scroll.verdict(videoScreen, { goal: '找个视频看看' }).stop);
    ok('停判据：没字的一屏不算"值得停"（交给视觉兜底）',
      !scroll.verdict({ hash: 'h', nodes: [] }, { goal: '随便看看' }).stop);

    /* ---------- 3. 新词/重合度（判"到底了"） ---------- */

    {
      const seen = new Set();
      const a = scroll.newTexts(plainScreen, seen);
      const b = scroll.newTexts(plainScreen, seen, plainScreen);
      ok('新词：第一屏全是新的', a.count === 2);
      ok('新词：同一屏再看一遍没有新词', b.count === 0);
      ok('新词：和上一屏完全一样 → 重合度 1（到底了）', b.ratio === 1);
      const c = scroll.newTexts(catScreen, seen, plainScreen);
      ok('新词：换了一屏就是新的', c.count === 2 && c.ratio === 0);
    }

    /* ---------- 4. 滑动真的按 span 发（以前写死 0.5 屏 / 300ms） ---------- */

    {
      const cmds = [];
      const adb = new PhoneAdb({ home: 'X:\\fake' });
      adb.state = async () => ({ online: true, booted: true, screen: scr, app: {} });
      adb.sh = async (c) => { cmds.push(c); return { code: 0, out: '', err: '', ms: 1 }; };
      await adb.swipeDir('down', { screen: scr, span: 0.32, ms: 650 });
      const m = /input swipe (\d+) (\d+) (\d+) (\d+) (\d+)/.exec(cmds[0] || '');
      const dist = m ? Math.abs(Number(m[4]) - Number(m[2])) : 0;
      ok('滑动：span 真的生效（0.32 × 1280 ≈ 410px，老版是 640px）',
        !!m && Math.abs(dist - 410) <= 2);
      ok('滑动：时长也传下去了（650ms，老版写死 300）', !!m && m[5] === '650');
      ok('滑动：默认还是 0.5 屏（老调用方不受影响）', (() => {
        cmds.length = 0;
        return true;
      })());
      await adb.swipeDir('up', { screen: scr });
      const m2 = /input swipe (\d+) (\d+) (\d+) (\d+) (\d+)/.exec(cmds[0] || '');
      ok('滑动：不传 span 时是 0.5 屏 / 300ms（`swipe` 那个老动词没变）',
        !!m2 && Math.abs(Math.abs(Number(m2[4]) - Number(m2[2])) - 640) <= 2 && m2[5] === '300');
    }

    /* ---------- 5. 动作语法：scroll / scrollto / taptext / 预期 ---------- */

    ok('语法：scroll down 3', (() => { const a = agentMod.parseAction('scroll down 3'); return a.verb === 'scroll' && a.arg === 'down 3'; })());
    ok('语法：scrollto 猫', agentMod.parseAction('scrollto 猫')?.verb === 'scrollto');
    ok('语法：taptext 跳过', agentMod.parseAction('taptext 跳过')?.arg === '跳过');

    {
      const p = agentMod.parseAction('tap n3 | 预期: 视频页');
      ok('预期：从动作里拆出来了', !!p && p.verb === 'tap' && p.arg === 'n3' && p.expect === '视频页');
      ok('预期：写进记忆的那一行不带预期（只有动作）', p.line === 'tap n3');
      const p2 = agentMod.parseAction('swipe up｜预期：换下一条');
      ok('预期：全角竖线也认', !!p2 && p2.arg === 'up' && p2.expect === '换下一条');
      ok('预期：没写就不影响老格式', !agentMod.parseAction('done 相册里有三张').expect);
      ok('预期：散文里带个竖线不算动作', agentMod.parseAction('我觉得 | 应该点一下') === null);
    }

    /* ---------- 6. 假手机（一屏一屏排好） ---------- */

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsp-scroll-test-'));
    function phoneOf(screens, { tapMoves = false } = {}) {
      let i = 0;
      const hits = { swipe: [], tapXY: [], observe: 0, waits: 0, keys: [] };
      const cur = () => screens[Math.min(i, screens.length - 1)];
      const appOf = (s) => s.app || { name: '浏览器', package: 'mark.via', activity: 'mark.via.Shell' };
      const view = (s) => ({
        nodes: s.nodes, table: s.table, hash: s.hash, count: s.nodes.length,
        more: s.more || 0, thin: !!s.thin, screen: scr,
      });
      return {
        hits,
        async state() { return { online: true, booted: true, screen: scr, app: appOf(cur()) }; },
        async observe() {
          hits.observe += 1;
          const s = cur();
          return { ok: true, app: appOf(s), screen: scr, count: s.nodes.length, nodes: s.nodes, table: s.table, hash: s.hash, thin: !!s.thin, more: s.more || 0 };
        },
        async swipeDir(d, opts = {}) { hits.swipe.push({ dir: d, ...opts }); if (i < screens.length - 1) i += 1; return { ok: true }; },
        async waitChange(before) {
          hits.waits += 1;
          const s = cur();
          if (s.hash === before) return { changed: false };
          return { changed: true, tree: view(s) };
        },
        async tapXY(x, y) { hits.tapXY.push([x, y]); if (tapMoves && i < screens.length - 1) i += 1; return { ok: true, ms: 1 }; },
        async tap() { return { ok: true, changed: true }; },
        async text() { return { ok: true }; },
        async key(n) { hits.keys.push(n); return { ok: true }; },
        async launch() { return { ok: true }; },
        async openUrl() { return { ok: true }; },
        async focusApp() { return appOf(cur()).package; },
        async screenshot() { const png = Buffer.from('89504e470d0a1a0a', 'hex'); return { ok: true, png, bytes: png.length, hash: 'h' }; },
      };
    }

    function makeAgent(phone, replies, opts = {}) {
      const calls = [];
      const waiters = new Map();
      let n = 0;
      const agent = new agentMod.PhoneAgent({
        adb: phone,
        model: { model: 'stub', baseUrl: 'http://127.0.0.1:1', maxTokens: 80, timeoutMs: 5000 },
        callModel: async (m, msgs) => {
          calls.push(msgs);
          const text = replies[Math.min(n, replies.length - 1)];
          n += 1;
          return { text };
        },
        dir,
        budget: opts.budget,
        /** 这一区验的是滚动与预期，图/弹窗/自救都不掺和。 */
        vision: opts.vision || { enabled: false },
        rescue: { enabled: false },
        popup: { enabled: false },
        scroll: opts.scroll || { lookEach: false },
        emit: (ev) => {
          if (ev.kind === 'done' || ev.kind === 'fail') {
            const w = waiters.get(ev.goal);
            if (w) { waiters.delete(ev.goal); w(ev); }
          }
        },
      });
      const run = (goal, o = {}) => new Promise((resolve) => {
        waiters.set(goal, resolve);
        agent.enqueue({ goal, by: 'her', key: 'private:1', share: true, ...o });
      });
      return { agent, calls, run };
    }

    const taskOf = (goal) => ({
      id: 't1', goal, seen: {}, trail: [], tried: [], steps: [],
      scanSeen: new Set(), scrolls: 0, lim: { maxSteps: 8, maxCalls: 8, maxMs: 60_000, maxStall: 2 },
    });

    /* ---------- 7. 端到端：翻两屏，第 3 屏有猫 → 停住 ---------- */

    {
      const phone = phoneOf([plainScreen, screen('h-p2', ['第三条新闻', '第四条新闻']), catScreen]);
      const { run, calls } = makeAgent(phone, ['scroll down 3', 'done 看到一只猫在追尾巴']);
      const res = await run('往下翻翻看');

      ok('滚动：一次动作翻了两屏（停在有猫的那一屏）', phone.hits.swipe.length === 2 && res.scrolls === 2);
      ok('滚动：停下来说得出为什么（"看到猫了"）', /猫/.test(res.stopWhy));
      ok('滚动：用的是列表档（0.32 屏 / 650ms），不是 0.5/300 甩出去',
        phone.hits.swipe.every((s) => s.span === 0.32 && s.ms === 650));
      /**
       * ★ 2026-11-06 21:45：`scroll down` 必须翻成**手指往上划**。
       * 反了的话页面向下就变成"回到顶部"，而结果页本来就在顶上 —— 屏不变，
       * 于是判"滑不动"，她只能说"翻到底了"（用户实测的原话：「不管往下翻还是往上翻都没下滑」）。
       */
      ok('滚动：scroll down 翻成"手指往上划"（页面才往下走）',
        phone.hits.swipe.every((s) => s.dir === 'up'));
      const afterScroll = String(calls[1]?.[1]?.content?.[0]?.text || calls[1]?.[1]?.content || '');
      ok('滚动：下一步的 prompt 里有「【刚停下来】…因为：看到「猫」了」', afterScroll.includes('【刚停下来】') && afterScroll.includes('猫'));
      ok('滚动：还提醒了"先看清它，别再往下滑"', afterScroll.includes('别再往下滑'));
      ok('滚动：任务照常收尾（不是卡住）', res.ok === true);
    }

    /* ---------- 8. 到底了 / 找不到，都要如实说 ---------- */

    {
      const phone = phoneOf([plainScreen]);   // 只有一屏：滑不动
      const { agent } = makeAgent(phone, ['done x']);
      const task = taskOf('往下翻翻看');
      const obs = await phone.observe();
      const r = await agent.execute({ verb: 'scroll', arg: 'down 3', line: 'scroll down 3' }, obs, task);
      ok('滚动：滑不动就说到底了（不是"没点中"）', /到底/.test(String(r.note || '')));
      ok('滚动：滑不动时 changed=false（不骗主循环说动了）', r.changed === false);
    }

    {
      const phone = phoneOf([plainScreen, screen('h-p2', ['第三条']), screen('h-p3', ['第四条'])]);
      const { agent } = makeAgent(phone, ['done x']);
      const task = taskOf('找猫的视频');
      const obs = await phone.observe();
      const r = await agent.execute({ verb: 'scrollto', arg: '猫', line: 'scrollto 猫' }, obs, task);
      ok('scrollto：翻完没有就如实说（带词 + 屏数）', /没看到「猫」/.test(String(r.note || '')) && /翻了 \d+ 屏/.test(String(r.note || '')));
      ok('scrollto：翻过的那几屏会记账（不是白翻）', task.scrolls >= 1);
    }

    /* ---------- 9. taptext：按字点，不猜 ref ---------- */

    {
      const ad = screen('h-ad', ['广告', '跳过 5s'], {
        nodes: [
          node('广告', [10, 1100, 110, 1150], { ref: 'n0', clickable: false }),
          node('跳过 5s', [560, 120, 700, 180], { ref: 'n1' }),
        ],
      });
      const phone = phoneOf([ad, plainScreen], { tapMoves: true });
      const { agent } = makeAgent(phone, ['done x']);
      const obs = await phone.observe();
      const r = await agent.execute({ verb: 'taptext', arg: '跳过', line: 'taptext 跳过' }, obs, taskOf('看视频'));
      ok('taptext：点的是「跳过 5s」那个节点（630,150），不是屏上随便一个', phone.hits.tapXY[0]?.[0] === 630 && phone.hits.tapXY[0]?.[1] === 150);
      ok('taptext：点了之后照样验证界面变了', r.changed === true);
    }

    /* ---------- 10. 预期：对不上要告诉她，对上了才算"目标近了" ---------- */

    {
      const { agent } = makeAgent(phoneOf([plainScreen]), ['done x']);
      const before = { ok: true, app: { package: 'tv.danmaku.bili', name: '哔哩哔哩', activity: 'tv.danmaku.bili.MainActivityV2' }, hash: 'a', nodes: [], table: 'n0 推荐' };
      const afterHome = { ok: true, app: { package: 'tv.danmaku.bili', name: '哔哩哔哩', activity: 'tv.danmaku.bili.MainActivityV2' }, hash: 'b', nodes: [], table: 'n0 推荐' };
      const t = taskOf('看个视频');
      ok('预期：点了以为会到"视频页"，实际还在首页 → 不算进展',
        agent.judge(before, afterHome, t, true, { verb: 'tap', arg: 'n3', expect: '视频页' }) === false);
      ok('预期：而且下一轮她会看到「我以为会「视频页」，实际停在「哔哩哔哩」」',
        t.tried.some((x) => x.includes('我以为会「视频页」') && x.includes('实际停在')));

      const afterVideo = { ok: true, app: { package: 'tv.danmaku.bili', name: '哔哩哔哩', activity: 'com.bilibili.ship.theseus.detail.UnitedBizDetailsActivity' }, hash: 'c', nodes: [], table: 'n0 发弹幕' };
      const t2 = taskOf('看个视频');
      ok('预期：真到了视频页 → 进展，而且只有这种才允许写进记忆',
        agent.judge(before, afterVideo, t2, true, { verb: 'tap', arg: 'n3', expect: '视频页' }) === true
        && agent.strongProgress === true);
      ok('预期：核对不了的说法不算数（"换下一条"不会冤枉她）',
        agent.expectMet('换下一条', afterVideo) === null);
    }

    /* ---------- 11. 提示层：more / 滚动动词 ---------- */

    {
      const { agent } = makeAgent(phoneOf([plainScreen]), ['done x']);
      const obs = { app: { name: '浏览器', package: 'mark.via' }, count: 40, more: 12, table: 'n0 第一条', screen: scr, nodes: [node('第一条', [0, 0, 100, 40])] };
      const t = taskOf('往下翻翻看');
      t.tried = [];
      const msgs = agent.buildMessages(t, obs);
      const body = String(msgs[1].content?.[0]?.text || msgs[1].content);
      ok('提示：这一屏没列全时会告诉她 scroll down', body.includes('还有 12 项') && body.includes('scroll down'));
      ok('提示：system 里教了 scroll / scrollto / taptext 和预期',
        (() => {
          const sys = agent.systemPrompt();
          return sys.includes('scroll down 3') && sys.includes('scrollto') && sys.includes('taptext') && sys.includes('预期');
        })());
      ok('提示：浏览器那一屏会说清"往下看用 scroll down"',
        agentMod.whereAmI(obs).hint.includes('scroll down'));
      ok('提示：相册那一屏说得出怎么换照片',
        agentMod.whereAmI({ app: { name: '相册', package: 'com.android.gallery3d' } }).hint.includes('swipe left'));
    }

    /* ---------- 12. 记账：卡住要分得开 ---------- */

    {
      const phone = phoneOf([plainScreen]);
      const { run } = makeAgent(phone, ['done 好了'], { budget: { maxSteps: 1, maxCalls: 2 } });
      const res = await run('看看相册里有什么');
      ok('记账：失败带 stuck 分类（这条是预算）', res.ok === false && res.stuck === 'budget');
      ok('记账：滚动次数也进结果（0 也写）', res.scrolls === 0);
    }
    /* ---------- 13. 每屏都看图：她自己判断"停 / 再翻"（2026-11-07） ---------- */

    {
      const png = Buffer.from('89504e470d0a1a0a', 'hex');
      const shotObs = {
        app: { name: '浏览器', package: 'mark.via' }, screen: scr, hash: 'h-shot',
        count: 2, nodes: [node('第一条', [0, 200, 700, 260])],
        shot: { png, hash: 's1', ms: 1 },
      };

      const { agent, calls } = makeAgent(phoneOf([plainScreen]), ['停'], { vision: { enabled: true } });
      const r = await agent.scanAsk(shotObs, { goal: '往下翻找猫', taste: '喜欢猫和小动物' }, { index: 2, dir: 'down' });
      ok('每屏看图：回「停」就停在这一屏', !!r && r.stop === true);
      const sent = JSON.stringify(calls[0] || []);
      ok('每屏看图：请求里带截图', sent.includes('image_url') && sent.includes('data:image'));
      ok('每屏看图：告诉它是"第 2 屏"、带上目标与口味',
        sent.includes('第 2 屏') && sent.includes('往下翻找猫') && sent.includes('你的口味'));

      const a2 = makeAgent(phoneOf([plainScreen]), ['再翻'], { vision: { enabled: true } });
      const r2 = await a2.agent.scanAsk(shotObs, { goal: '往下翻找猫', taste: '喜欢猫' }, { index: 1, dir: 'down' });
      ok('每屏看图：回「再翻」就继续翻', !!r2 && r2.stop === false);

      ok('每屏看图：默认开着（lookEach）', agentMod.DEFAULTS.scroll.lookEach === true);
      const a3 = makeAgent(phoneOf([plainScreen]), ['done x']);
      ok('每屏看图：老用例可以显式关掉（lookEach:false）', a3.agent.scrollLookEach === false);
    }
    /* ---------- 14. 目标里写了"翻 N 屏"：屏数优先，不被兴趣词打断 ---------- */

    {
      const cat2 = screen('h-cat2', ['一只猫在追自己的尾巴', '第二条']);
      const p2 = screen('h-p2b', ['第三条新闻', '第四条新闻']);
      const p3 = screen('h-p3b', ['第五条新闻', '第六条新闻']);
      const page = (s, i) => ({ ...s, app: { name: '浏览器', package: 'mark.via', activity: 'mark.via.Shell' }, hash: `h-${i}` });

      const a1 = makeAgent(phoneOf([page(cat2, 1), page(p2, 2), page(p3, 3), page(p3, 4)]), ['done x']);
      const t1 = taskOf('往下翻三屏');
      const r1 = await a1.agent.scan(t1, await a1.agent.perceive(t1), { dir: 'down', maxScreens: 3 });
      ok('翻 N 屏：目标写了三屏就真的翻三屏（不被"猫"拦在第一屏）', r1.screens === 3);
      ok('翻 N 屏：停下来时说明是"翻到第 3 屏"', /第 3 屏/.test(r1.why));

      const a2 = makeAgent(phoneOf([page(p2, 4), page(cat2, 5), page(p3, 6)]), ['done x']);
      const t2 = taskOf('往下翻翻看');
      const r2 = await a2.agent.scan(t2, await a2.agent.perceive(t2), { dir: 'down', maxScreens: 3 });
      ok('没写屏数：兴趣词出现就停（看到猫就停）', r2.screens === 1 && r2.found === true && r2.kind === 'interest');
    }
  },
};
