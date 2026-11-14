/**
 * 自检区域：她刷视频（2026-11-01；傍晚第二版：会搜、会点进去、会回列表）
 *
 * 用户第二次提的要求（16:56）：「不喜欢不知道返回，搜索栏不会搜索，搜索后不知道点进去看」。
 * 所以这里验的不只是"低 token"，还有**三条她原来走不通的路**：
 *   ① 搜索：回首页 → 点顶部搜索框 → 打字 → 回车 → 出结果（确定性步骤，不靠模型摸）；
 *   ② 点进去：从结果卡片点开，**硬校验**确实到了播放页（activity 或"发弹幕/点赞"）；
 *   ③ 换一个：故事流上滑；详情页/搜索页 `key back` 回列表再挑。
 *
 * 单跑：`node test\run-one.cjs 19-phone-video.cjs`
 */
module.exports = {
  name: '她的手机（刷视频）',
  tags: ['companion', 'phone', 'video', '视频'],
  async run(ctx) {
    const { ok } = ctx;
    const V = ctx.mod('phone-video');

    /* ---------- 1. 纯函数 ---------- */

    const d = V.normalize({});
    ok('视频：默认一条看两段、每段 3 帧、3.5 秒一帧（实测 3 帧 = 636 token）',
      d.maxVideos === 2 && d.frames === 3 && d.gapMs === 3500 && d.likeMin === 0.45);
    const clamped = V.normalize({ frames: 99, maxVideos: 9, maxCalls: 99, width: 5000, likeMin: 3 });
    ok('视频：参数越界会夹回去',
      clamped.frames === 4 && clamped.maxVideos === 4 && clamped.maxCalls === 10 && clamped.width === 720 && clamped.likeMin === 1);
    ok('视频：默认只开手机那套 App（哔哩哔哩）', V.APP_NAME === '哔哩哔哩' && V.BILI === 'tv.danmaku.bili');

    ok('视频：她"想刷视频"的几种说法都认',
      ['看会儿视频', '看视频吧', '刷视频', '去B站看看', '看看短视频'].every((t) => V.isVideoGoal(t)));
    /**
     * ★ 2026-11-02 真机：他说「退出去换一个视频看」，旧判据**不认**，于是走了 `phone-agent`
     * —— 那边没有"这是第几个视频"的概念，结果 back → 点 → back → 点，同一个视频来回五次。
     */
    ok('视频：「换一个 / 下一个视频」也算刷视频（别丢给逐步决策那条路）',
      ['退出去换一个视频看', '换一个视频', '下一个视频', '换条视频看看', '这个视频看完了，看下一个']
        .every((t) => V.isVideoGoal(t)));
    ok('视频：不是刷视频的话别误判',
      ['看看手机', '截张图发给他', '打开相册', '看电影海报'].every((t) => !V.isVideoGoal(t)));

    ok('视频：时长两种写法都换算成秒',
      V.durationSec('3:35') === 215 && V.durationSec('1:02:03') === 3723
      && V.cnDuration('1分钟06秒') === 66 && V.cnDuration('2小时06分钟46秒') === 7606);
    ok('视频：播放量 `216.4万` / `912` 换算成数字',
      V.playCount('216.4万') === 2164000 && V.playCount('912') === 912);

    /**
     * ★ 真机原样 desc（2026-11-01 16:5x，B 站首页 dump）。
     * 注意标题里有**全角逗号**，分隔符是**半角逗号** —— 第一版就栽在这里（标题被切一半）。
     */
    const feedNode = {
      desc: '视频,小傻龙：人，我养不起大肥鱼了……,208.7万观看,455弹幕,时长1分钟06秒,UP主小陈的脚凑凑的,16万点赞,',
      bounds: [365, 216, 710, 636],
    };
    const fc = V.parseCard(feedNode);
    ok('视频：首页卡片（desc 里带标题/播放量/时长/UP 主）解析得出来',
      fc && fc.title === '小傻龙：人，我养不起大肥鱼了……' && fc.views === '208.7万'
      && fc.up === '小陈的脚凑凑的' && fc.seconds === 66 && fc.kind === 'feed');
    ok('视频：标题里的全角逗号不会被当成分隔符', fc.title.includes('人，我养不起'));
    const sc = V.parseCard({ text: '偷摸小肥鱼尾巴 末儿克丝Morx 0:44', bounds: [0, 316, 720, 669] });
    ok('视频：搜索结果卡片（标题 作者 时长）也认',
      sc && sc.kind === 'search' && sc.title === '偷摸小肥鱼尾巴' && sc.up === '末儿克丝Morx' && sc.seconds === 44);
    ok('视频：广告卡片不算视频',
      V.parseCard({ desc: '视频,跟着UP主买同款好物,广告,查看详情', bounds: [0, 0, 10, 10] }) === null);
    /**
     * ★ 2026-11-01 22:37 真机：`直播` 卡片点进去是 `LiveRoomActivityV3`，不是视频页。
     * 旧版把它当候选 → 点进去 → 整场"没看成"。现在**连候选都不收**。
     */
    ok('视频：直播卡片不算候选（直播间不是视频页）',
      V.parseCard({ desc: '直播,某某的直播间,1.2万观看,主播x,', bounds: [0, 0, 10, 10] }) === null);
    ok('视频：直播间 Activity 不算"在放视频"',
      !V.inVideo({ app: { activity: 'com.bilibili.bililive.room.ui.roomv3.LiveRoomActivityV3' }, nodes: [{ text: '点我发弹幕' }] }));

    const many = V.cardsOf([
      feedNode,
      { desc: '视频,同一个标题,1万观看,1弹幕,时长1分钟,UP主x,' },
      { text: '偷摸小肥鱼尾巴 末儿克丝Morx 0:44' },
      { text: '推荐' },
    ], { max: 8 });
    ok('视频：一屏卡片去重、并按屏幕顺序', many.length === 3 && many[0].title.includes('小傻龙') && many[1].title === '同一个标题');

    /**
     * ★ 硬校验：**搜索结果页不能被当成播放页**（16:41 那条摘要就是这么错的）。
     */
    ok('视频：故事流/详情页的 Activity 算"在放视频"',
      V.inVideo({ app: { activity: 'com.bilibili.video.story.StoryVideoActivity' } })
      && V.inVideo({ app: { activity: 'com.bilibili.ship.theseus.detail.UnitedBizDetailsActivity' } }));
    ok('视频：控件树里有"发弹幕+点赞"也算在播放页',
      V.inVideo({ app: { activity: 'x' }, nodes: [{ text: '点我发弹幕' }, { desc: '点赞，84539个点赞' }] }));
    ok('视频：搜索页/首页**不算**在放视频',
      !V.inVideo({ app: { activity: 'com.bilibili.search2.main.BiliMainSearchActivity' }, nodes: [{ text: '综合' }, { text: '偷摸小肥鱼尾巴 末儿克丝Morx 0:44' }] })
      && !V.inVideo({ app: { activity: 'tv.danmaku.bili.MainActivityV2' }, nodes: [{ desc: '视频,标题,1万观看,1弹幕,时长1分钟,UP主x,' }] }));

    const j1 = V.parseJudge('{"gist":"一个猫在保险柜里找钥匙","like":0.2,"next":"skip"}');
    ok('视频：她的判断能解析出来', j1.gist.includes('保险柜') && j1.like === 0.2 && j1.next === 'skip');
    ok('视频：带围栏也认', V.parseJudge('```json\n{"gist":"讲偏方","like":0.9,"next":"watch"}\n```').next === 'watch');
    ok('视频：like 越界夹到 1，next 认不出就当"接着看"', V.parseJudge('{"gist":"x","like":9,"next":"嗯"}').like === 1);
    ok('视频：不是 JSON 就返回 null（不抛）', V.parseJudge('我觉得挺好看的') === null);
    ok('视频：挑第几个也认，越界回 -1',
      V.parsePick('{"pick":2}', 5) === 2 && V.parsePick('{"pick":9}', 3) === -1 && V.parsePick('随便', 3) === -1);

    /**
     * ★ 16:45 真机原话：「返回首页，点搜索框，输入小肥鱼，再搜索」——
     * 要认出 `小肥鱼`，不能认成"索框"（第一版就是这么错的）。
     */
    ok('视频：从"点搜索框，输入小肥鱼，再搜索"里认出「小肥鱼」',
      V.searchTerm('返回首页，点搜索框，输入小肥鱼，再搜索') === '小肥鱼');
    ok('视频：`搜小肥鱼` / `在B站搜一下 好看的` 也认',
      V.searchTerm('搜小肥鱼') === '小肥鱼' && V.searchTerm('在B站搜一下 好看的') === '好看的');
    ok('视频：`去B站搜小肥鱼看看` 里那个"看看"是语气，不是搜索词',
      V.searchTerm('去B站搜小肥鱼看看') === '小肥鱼');
    ok('视频：没有明确搜索词就不搜（"随便找个视频看看"）',
      V.searchTerm('随便找个视频看看') === '' && V.searchTerm('打开哔哩哔哩') === '');

    const phrase = V.phraseOf({ title: '主任的宠物', gist: '猫在保险柜找钥匙', watchedMs: 32_000, next: 'skip', like: 0.2, likeMin: 0.45 });
    ok('视频：一条的说明里有内容、有秒数、有她为什么走',
      phrase.includes('主任的宠物') && phrase.includes('保险柜') && phrase.includes('32 秒') && phrase.includes('滑走'));
    ok('视频：整场汇总两句话说完',
      V.summarize([{ title: 'A', gist: '讲甲的', watchedMs: 20_000, next: 'watch' }, { title: 'B', gist: '讲乙的', watchedMs: 10_000, next: 'skip', like: 0.1, likeMin: 0.45 }]).includes('刷了 2 条'));

    /* ---------- 2. 假手机：首页 / 搜索页 / 详情页 / 故事流 ---------- */

    const HOME_CARDS = [
      { desc: '视频,压力一只大肥鱼？,216.4万观看,912弹幕,时长3分钟35秒,UP主冬冰,8.4万点赞,', bounds: [10, 200, 355, 620] },
      { desc: '视频,主任的宠物,1.6万观看,4弹幕,时长15分钟16秒,UP主脱缰凯-无广,', bounds: [365, 200, 710, 620] },
    ];
    const RESULT_CARDS = [
      { text: '偷摸小肥鱼尾巴 末儿克丝Morx 0:44', bounds: [0, 316, 720, 669] },
      { text: '压力一只大肥鱼？ 冬冰 3:35', bounds: [0, 669, 720, 911] },
    ];

    function rig({ screen = 'home', judges = [], pickIndex = 0, shotFails = false, tapGoesNowhere = false, trapFirst = false, rescueOpens = false, cfg = {} } = {}) {
      const st = {
        screen, tapped: [], swipes: 0, keys: [], texts: [], enters: 0, calls: 0, shots: 0, query: '',
        title: '压力一只大肥鱼？', startFails: 0, trapFirst, trapUsed: false, rescueOpens, rescueAsked: false,
      };
      const nodesFor = () => {
        if (st.screen === 'home') {
          return [{ text: `Search Icon ${st.query || '可爱大肥鱼'}`, bounds: [120, 48, 528, 136] }, ...HOME_CARDS];
        }
        if (st.screen === 'search') {
          return [
            { text: `Search Icon ${st.query}`, bounds: [120, 48, 528, 136] },
            { text: '综合', bounds: [0, 148, 112, 228] },
            { text: '番剧', bounds: [112, 148, 220, 228] },
            ...RESULT_CARDS,
          ];
        }
        if (st.screen === 'live') {
          // 直播间：有弹幕框，但没有"点赞/投币/收藏"那一排（真机 LiveRoomActivityV3）
          return [
            { text: '点我发弹幕', bounds: [40, 1190, 300, 1230] },
            { text: '主播 某某', bounds: [24, 60, 200, 100] },
          ];
        }
        // 播放页（详情/故事流共用）
        return [
          { text: '点我发弹幕', bounds: [451, 461, 606, 521] },
          { desc: `视频,${st.title},216.4万观看,912弹幕,时长3分钟35秒,UP主冬冰,`, bounds: [0, 637, 720, 704] },
          { desc: '点赞，84539个点赞', bounds: [24, 794, 158, 910] },
        ];
      };
      const adb = {
        state: async () => ({
          online: true,
          booted: true,
          app: st.screen === 'home' ? { package: V.BILI, activity: 'tv.danmaku.bili.MainActivityV2' }
            : st.screen === 'search' ? { package: V.BILI, activity: 'com.bilibili.search2.main.BiliMainSearchActivity' }
              : st.screen === 'live' ? { package: V.BILI, activity: 'com.bilibili.bililive.room.ui.roomv3.LiveRoomActivityV3' }
                : st.screen === 'story' ? { package: V.BILI, activity: 'com.bilibili.video.story.StoryVideoActivity' }
                  : { package: V.BILI, activity: 'com.bilibili.ship.theseus.detail.UnitedBizDetailsActivity' },
        }),
        observe: async () => ({ ok: true, nodes: nodesFor() }),
        screenshot: async () => {
          st.shots += 1;
          if (shotFails) return { ok: false, error: '截图太小（黑屏）' };
          return { ok: true, png: Buffer.from(`PNG-${st.shots}`), hash: `h${st.shots}` };
        },
        tapXY: async (x, y) => {
          st.tapped.push([x, y]);
          /** 自救那一手：她看图之后点的位置，真的把她带进了视频页。 */
          if (st.rescueAsked) { st.rescueAsked = false; st.screen = 'story'; return { ok: true }; }
          if (st.screen === 'home') {
            // 顶部搜索框 → 进搜索页（空）；卡片 → 故事流
            if (y < 180) { st.screen = 'search'; st.query = ''; return { ok: true }; }
            const hit = HOME_CARDS.find((c) => x >= c.bounds[0] && x <= c.bounds[2] && y + 40 >= c.bounds[1] && y - 40 <= c.bounds[3]);
            if (hit) st.title = hit.desc.split(',')[1];
            if (tapGoesNowhere) return { ok: true };
            /** ★ 第一张卡片演成"直播间"：用来验"点错了会不会自己退回来"。 */
            if (st.trapFirst && !st.trapUsed) { st.trapUsed = true; st.screen = 'live'; return { ok: true }; }
            st.screen = 'story';
            return { ok: true };
          }
          if (st.screen === 'search') {
            if (y < 180) return { ok: true };                // 搜索框
            const hit = RESULT_CARDS.find((c) => y >= c.bounds[1] && y <= c.bounds[3]);
            if (hit) st.title = hit.text.split(' ')[0];
            if (!tapGoesNowhere) st.screen = 'detail';       // 搜索结果 → 详情页（真机如此）
            return { ok: true };
          }
          return { ok: true };
        },
        text: async (q) => { st.texts.push(q); if (st.screen === 'search') st.query = q; return { ok: true }; },
        key: async (k) => {
          st.keys.push(k);
          if (k === 'enter' && st.screen === 'search') st.query = st.query || 'x';
          if (k === 'back') {
            if (st.screen === 'detail') st.screen = 'search';
            else if (st.screen === 'live') st.screen = 'home';   // 直播间退回去是首页
            else if (st.screen === 'search') st.screen = 'home';
          }
          return { ok: true };
        },
        swipeDir: async () => { st.swipes += 1; st.title = st.swipes === 1 ? '大肥鱼买瓜' : '第三条'; return { ok: true }; },
        launch: async () => { st.startFails += 0; return { ok: true }; },
        sh: async (cmd) => {
          if (/am start/.test(cmd)) { st.enters += 1; st.screen = 'home'; return { code: 0, out: 'Starting' }; }
          return { code: 0, out: '' };
        },
      };
      const model = { model: 'stub' };
      let judgeIdx = 0;
      const callModel = async (m, messages) => {
        st.calls += 1;
        const sys = String(messages[0]?.content || '');
        const user = String(messages[1]?.content?.[0]?.text || messages[1]?.content || '');
        const json = (o) => ({ text: JSON.stringify(o), raw: { usage: { prompt_tokens: 100, completion_tokens: 20 } } });
        /** 卡住时的"看图自救"：她看一眼，点个坐标。 */
        if (/卡住了/.test(sys)) {
          if (!st.rescueOpens) return { text: '这个我不太会判断', raw: {} };
          st.rescueAsked = true;
          return { text: 'tapxy 0.5 0.5', raw: {} };
        }
        if (/只做选择/.test(sys) || /这一屏上的视频/.test(user)) return json({ pick: pickIndex, why: '看着顺眼' });
        const j = judges[Math.min(judgeIdx, judges.length - 1)] || { gist: '一段内容', like: 0.8, next: 'watch' };
        judgeIdx += 1;
        return json(j);
      };
      const w = V.createVideoWatcher({
        adb, model, callModel, taste: '爱看热闹、嫌麻烦', cfg: V.normalize(cfg),
        shrink: (buf) => ({ buf, mime: 'image/png' }),
        sleep: async () => {},
      });
      return { w, st, adb };
    }

    {
      /**
       * ★ 2026-11-08 夜（真机 23:15–23:17）：**「打开哔哩哔哩」不是"要看视频"**。
       * 旧规则只要句子里有"哔哩"就塞进视频那条路：那一条开场要先"回到 B 站首页"，
       * 连着三次「没看成（回不到首页）」、0 次调用 —— 他连说三遍"打开哔哩哔哩"一次都没打开。
       */
      ok('分流：「打开哔哩哔哩」不算看视频（走 launch，1 秒开）', !V.isVideoGoal('打开哔哩哔哩'));
      ok('分流：「点开哔哩哔哩」也不算', !V.isVideoGoal('点开哔哩哔哩'));
      ok('分流：「打开哔哩哔哩随便找什么看」仍然算（他明说了看）', V.isVideoGoal('打开哔哩哔哩随便找什么看'));
      ok('分流：「去B站看看」仍然算', V.isVideoGoal('去B站看看'));

      /**
       * ★ 2026-11-08 夜（用户：「她发的消息和视频内容**完全对不上**」）：
       * 视频那场的总结是《小傻龙…》，她回灌成了「修老物件 / 锈住的螺丝」——
       * 查过 `turns.jsonl` 1338 轮，那句话里的东西一次都没出现过，是纯编的。
       * `factTokens/mentionsFact` 就是回灌前那道"她说的和事实对不对得上"的核对。
       */
      {
        const A = ctx.mod('phone-agent');
        const summary = '刷了 1 条视频。《小傻龙：“我养的小鲸鱼变傻了……”》：画面里一只手在戳Q版小傻龙和小鲸鱼的摆件（看到 16 秒，没意思，滑走了）';
        const toks = A.factTokens(summary);
        ok('回灌核对：从事实里抠得出实词（标题优先）', toks.includes('小傻龙') && toks.length >= 3);
        ok('回灌核对：编的那句一个实词都对不上 → 判"对不上"',
          A.mentionsFact('看了个修老物件的，把锈住的螺丝泡开一点点拆，看了会儿还挺解压。', toks) === false);
        ok('回灌核对：说了真的内容就放行',
          A.mentionsFact('看了个小傻龙的，一只手在戳摆件，16 秒就滑走了。', toks) === true);
        ok('回灌核对：没有事实就不瞎判', A.mentionsFact('随便说说', []) === false);
      }

      /**
       * `home()` 的兜底：`am start -n …MainActivityV2` 这条**版本一换就失效**。
       * 真机三次"回不到首页"就是这么来的（activity 起不来 → 连按三次 back → 退出 App）。
       * 现在多一条 Monkey 冷入口，而且"人在 B 站、不在搜索页"就算到首页了。
       */
      const states = [
        { app: { package: 'tv.danmaku.bili', activity: 'com.bilibili.ship.theseus.detail.UnitedBizDetailsActivity' } },
        { app: { package: 'tv.danmaku.bili', activity: 'tv.danmaku.bili.MainActivityV2' } },
      ];
      let i = 0;
      let launched = 0;
      const adb = {
        async sh() { return { code: 1, out: '', err: 'Error: Activity not started' }; },
        async launch() { launched += 1; i = Math.min(i + 1, states.length - 1); return { ok: true, pkg: 'tv.danmaku.bili' }; },
        async key() { i = 0; return { ok: true }; },
        async observe() { return { ok: true, nodes: [], app: states[i].app }; },
        async state() { return { online: true, booted: true, app: states[i].app, screen: { width: 720, height: 1280 } }; },
      };
      const w = V.createVideoWatcher({ adb, model: {}, callModel: async () => ({ text: '{}' }), cfg: V.normalize({}) });
      const r = await w.home();
      ok('home()：am start 失效时用 monkey 冷入口也能落到首页', r.ok === true && launched >= 1);
      ok('home()：这时候不该再连按 back 把 App 退出去', i === states.length - 1);

      /**
       * ★ 2026-11-08 夜（用户：「每次打开了哔哩哔哩，然后等待一会儿**自己退出**了，压根不点视频看」）：
       * 人根本不在 B 站时（前台是浏览器/桌面），**一次 back 都不许按**（按了就是把刚打开的 App 退掉），
       * 而是再冷启动一次；还不在就如实说"打不开哔哩哔哩（现在前台是 X）"。
       */
      {
        let backs = 0;
        let launches = 0;
        const other = {
          async sh() { return { code: 1, out: '', err: 'Error' }; },
          async launch() { launches += 1; return { ok: true, pkg: 'tv.danmaku.bili' }; },
          async key() { backs += 1; return { ok: true }; },
          async observe() { return { ok: true, nodes: [], app: { package: 'mark.via', activity: 'mark.via.Shell' } }; },
          async state() { return { online: true, booted: true, app: { package: 'mark.via', activity: 'mark.via.Shell', name: '浏览器' }, screen: { width: 720, height: 1280 } }; },
        };
        const w2 = V.createVideoWatcher({ adb: other, model: {}, callModel: async () => ({ text: '{}' }), cfg: V.normalize({}) });
        const r2 = await w2.home();
        ok('home()：人不在 B 站时一下 back 都不按（不然就是她在自己退出去）', backs === 0);
        ok('home()：会再冷启动一次', launches >= 2);
        ok('home()：还不成就如实说"打不开哔哩哔哩（前台是浏览器）"',
          r2.ok === false && /打不开「哔哩哔哩」/.test(r2.why) && /浏览器/.test(r2.why));
      }
    }

    /* ---------- 3. 首页挑一条 → 不喜欢就上滑换 ---------- */

    {
      const { w, st } = rig({
        judges: [{ gist: '猫在保险柜里找钥匙，闹剧', like: 0.2, next: 'watch' }],
        cfg: { maxVideos: 1 },
      });
      const r = await w.run({ goal: '看会儿视频', key: 'private:1' });
      ok('视频：开场先回一次首页（不是在哪就在哪瞎点）', st.enters >= 1);
      ok('视频：首页点一张卡片', st.tapped.length === 1 && st.tapped[0][1] > 180);
      ok('视频：看了一条 · 内容记下来了 · 兴趣低 → 她走',
        r.videos.length === 1 && r.videos[0].gist.includes('保险柜') && r.videos[0].next === 'skip');
      ok('视频：兴趣低于门槛就当场收（只判一次）', r.calls === 2 && r.videos[0].frames === 3);
      ok('视频：token 有记账', r.tokens.prompt === 200 && r.tokens.completion === 40);
      ok('视频：回灌是内容 + 秒数，不是"任务/步骤"',
        r.summary.includes('滑走') && !/任务|步骤/.test(r.summary));
    }

    /* ---------- 4. 搜索 → 点结果 → 详情页 → 返回列表再挑 ---------- */

    {
      const { w, st } = rig({
        judges: [
          { gist: '这条是讲小肥鱼被摸尾巴的', like: 0.2, next: 'watch' },
          { gist: '第二段', like: 0.1, next: 'watch' },
        ],
        pickIndex: 1,
        cfg: { maxVideos: 1 },
      });
      const r = await w.run({ goal: '去B站搜小肥鱼，看看有什么' });
      ok('视频：这句话里有搜索词 → 走搜索（不是首页乱挑）', r.mode === 'search' && r.term === '小肥鱼');
      ok('视频：搜索是"点顶部搜索框 → 打字 → 回车"三步', st.texts.includes('小肥鱼') && st.keys.includes('enter') && st.tapped.some(([, y]) => y < 180));
      ok('视频：从搜索结果点进的是详情页，而且被认成"在放视频"',
        r.videos.length === 1 && r.videos[0].gist.includes('摸尾巴'));
    }

    {
      // 搜索进去是详情页：看完不喜欢 → 必须 key back 回列表，而不是上滑
      const { w, st } = rig({
        judges: [
          { gist: '先看看', like: 0.2, next: 'watch' },
          { gist: '换到的那条还行', like: 0.7, next: 'skip' },
        ],
        cfg: { maxVideos: 2 },
      });
      const r = await w.run({ goal: '去B站搜小肥鱼' });
      ok('视频：详情页"换一个"是 key back 回列表，不是上滑', st.keys.includes('back') && st.swipes === 0);
      ok('视频：回到列表后挑的是**没看过的那条**，不是同一条再看一遍',
        r.videos.length === 2 && r.videos[0].title !== r.videos[1].title && st.calls >= 2);
    }

    /* ---------- 4c. 点错了（直播间）：自己退回去换一个（P0-2） ---------- */

    {
      const { w, st } = rig({
        trapFirst: true,
        judges: [{ gist: '这条是猫在草地上', like: 0.2, next: 'watch' }],
        cfg: { maxVideos: 1 },
      });
      const r = await w.run({ goal: '看会儿视频' });
      ok('视频：点进直播间会自己 back 回来（不再整场判失败）', st.keys.includes('back') && r.ok === true);
      ok('视频：退回来后换了另一张卡片，不是把直播间再看一遍',
        r.videos.length === 1 && r.videos[0].title === '主任的宠物');
    }

    /* ---------- 4d. 几张卡片都点不进去：让她看图自救（P1，和 agent 同一条规则） ---------- */

    {
      const { w, st } = rig({
        tapGoesNowhere: true,
        rescueOpens: true,
        judges: [{ gist: '这只猫在草地上打滚', like: 0.2, next: 'watch' }],
        cfg: { maxVideos: 1 },
      });
      const r = await w.run({ goal: '看会儿视频' });
      ok('视频：卡片全点不进去时，先让她看图自救（不是直接说没看成）',
        st.tapped.length > 3 && r.rescues === 1 && r.ok === true);
      ok('视频：她看图点的那一手真的把她带进了视频页', r.videos.length === 1 && r.videos[0].gist.includes('打滚'));
    }

    /* ---------- 5. 她说"没进去"就得说没进去 ---------- */
    {
      const { w } = rig({ screen: 'home', tapGoesNowhere: true });
      const r = await w.run({ goal: '看会儿视频' });
      ok('视频：点了卡片但没进播放页 → 如实说没进去，绝不编内容',
        r.ok === false && /没进视频/.test(r.summary) && r.videos.length === 0);
    }
    {
      const { w } = rig({ screen: 'search', shotFails: true });
      // 直接让她在搜索页上"看"：校验会先拦下来
      const r = await w.run({ goal: '看会儿视频' });
      ok('视频：搜索页上的截图不会被当成视频内容', r.ok === false && r.videos.length === 0);
    }

    /* ---------- 6. 预算 / 诚实 ---------- */

    {
      const { w } = rig({ shotFails: true });
      const r = await w.run({ goal: '看会儿视频' });
      ok('视频：截图全失败 → 说"看不到画面"', r.ok === false && /看不到画面/.test(r.summary));
    }
    {
      const { w, st } = rig({ judges: [{ gist: '', like: 0, next: 'skip' }], cfg: { maxCalls: 2 } });
      w.callModel = async (m, messages) => {
        st.calls += 1;
        const sys = String(messages[0]?.content || '');
        if (/只做选择/.test(sys)) return { text: '{"pick":0}', raw: {} };
        return { text: '这个我不太会判断', raw: { usage: { prompt_tokens: 90, completion_tokens: 8 } } };
      };
      const r = await w.run({ goal: '看会儿视频' });
      ok('视频：模型回的不是 JSON → 收场，不崩、不重复烧', r.ok === true && r.videos[0].next === 'skip' && r.calls === 2);
    }
    {
      const { w } = rig({ screen: 'home' });
      w.adb = { ...w.adb, observe: async () => ({ ok: true, nodes: [{ text: '推荐', bounds: [0, 0, 10, 10] }] }) };
      const r = await w.run({ goal: '看会儿视频' });
      ok('视频：首页找不到能点的视频 → 如实说"没找到"', r.ok === false && /没找到/.test(r.summary));
    }
    {
      const { w } = rig();
      w.adb = { ...w.adb, state: async () => ({ online: false, booted: false, app: {} }) };
      const r = await w.run({ goal: '看会儿视频' });
      ok('视频：手机没连上就不装样子', r.ok === false && /没连上/.test(r.summary));
    }
    ok('视频：看视频关掉就一步都不动', (await (async () => {
      const w = V.createVideoWatcher({
        adb: { state: async () => { throw new Error('不该碰 adb'); } },
        model: null, callModel: async () => { throw new Error('不该调模型'); }, cfg: { enabled: false },
      });
      const r = await w.run({});
      return r.ok === false && /没开/.test(r.summary);
    })()) === true);

    /* ---------- 6b. 视频这条路也会自己关弹窗（2026-11-02 真机） ---------- */

    {
      /**
       * 真机 21:21 那次只看了 1 条就收工：看完按 back 回首页时正好弹「登录注册解锁更多精彩内容」，
       * `candidates()` 在弹窗上找不到卡片 → 整场结束。
       * 这一屏是照着用户的截图搭的（标题 + 手机号 + 验证登录 + 账号密码 + 一个**没有字**的 ×）。
       */
      const modal = [
        { text: '登录注册解锁更多精彩内容', bounds: [180, 380, 700, 430], clickable: false, center: [440, 405] },
        { text: '请输入手机号', bounds: [300, 520, 700, 580], clickable: true, center: [500, 550] },
        { text: '验证登录', bounds: [180, 620, 700, 700], clickable: true, center: [440, 660] },
        { text: '账号密码', bounds: [300, 950, 480, 1000], clickable: true, center: [390, 975] },
        { text: '', desc: '', bounds: [640, 370, 700, 420], clickable: true, center: [670, 395] },
        { text: '', desc: '', bounds: [160, 330, 720, 1010], clickable: true, center: [440, 670] },
      ];
      const st = { popup: true, taps: [], keys: [] };
      const w = V.createVideoWatcher({
        adb: {
          state: async () => ({ online: true, booted: true, screen: { width: 720, height: 1280 }, app: { package: V.BILI, activity: 'tv.danmaku.bili.MainActivityV2' } }),
          observe: async () => ({ ok: true, nodes: st.popup ? modal : [], screen: { width: 720, height: 1280 } }),
          tapXY: async (x, y) => {
            st.taps.push([x, y]);
            if (x === 670 && y === 395) st.popup = false;
            return { ok: true };
          },
          key: async (k) => { st.keys.push(k); return { ok: true }; },
          screenshot: async () => ({ ok: true, png: Buffer.from('x'), hash: 'h' }),
          swipeDir: async () => ({ ok: true }),
          sh: async () => ({ code: 0, out: '' }),
          launch: async () => ({ ok: true }),
        },
        model: { model: 'stub' },
        callModel: async () => ({ text: '{}' }),
        cfg: V.normalize({}),
        shrink: (buf) => ({ buf, mime: 'image/png' }),
        sleep: async () => {},
        emit: () => {},
      });
      const after = await w.dismissPopups();
      ok('视频：登录墙挡着的时候，自己点右上角那个没字的 × 关掉',
        st.taps.length >= 1 && st.taps[0][0] === 670 && st.taps[0][1] === 395);
      ok('视频：关掉之后把干净的那一屏交回去', st.popup === false && after && after.ok !== false);
    }
    {
      /** 反过来：信息流里那张"广告"卡片不能当成弹窗（它的右上角是缩略图）。 */
      const feed = [
        { text: '跟着UP主买同款好物', bounds: [0, 200, 720, 640], clickable: true, center: [360, 420] },
        { text: '', desc: '', bounds: [640, 210, 710, 270], clickable: true, center: [675, 240] },
      ];
      const popupMod = ctx.mod('phone-popup');
      ok('视频：满宽的"广告"卡片不算弹窗（不会去点它的缩略图）',
        popupMod.scan({ nodes: feed, screen: { width: 720, height: 1280 }, app: { package: V.BILI } }) === null);
    }

    /* ---------- 7. 接线 ---------- */

    const companion = ctx.mod('companion');
    ok('视频：配置里带着这段（默认开、两条、门槛 0.45）',
      companion.DEFAULTS.phone.video.enabled === true
      && companion.DEFAULTS.phone.video.maxVideos === 2
      && companion.DEFAULTS.phone.video.likeMin === 0.45);
    const caps = ctx.mod('companion-capabilities');
    const hint = caps.buildCapabilityHints({ phone: { on: true, app: '哔哩哔哩', busy: false } });
    ok('视频：手机开着时，能力提示里告诉她可以写 [手机:看会儿视频]',
      hint.includes('[手机:看会儿视频]') && hint.includes('不好看就滑走'));
    ok('视频：手机没开就一个字都不提看视频',
      !caps.buildCapabilityHints({}).includes('看会儿视频'));
  },
};
