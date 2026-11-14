/**
 * 自检区域：自主说话（2026-10-27 新增）
 *
 * 用户要的是"想说就说，不想说不说，隔几分钟甚至半小时再想开口都可以"。
 * 这件事**不能**用一个定时器解决，所以拆成三层，这里分别验：
 *
 *   A. 纯逻辑（假时钟，不联网）：
 *      · 沉默越久越想说话（同一个念头，5 分钟不够、15 分钟够）；
 *      · 闸门：刚聊完 / 刚说过 / 连续没回 / 凌晨 / 每小时上限；
 *      · 凌晨"留言"：一晚只放一条，而且得是真憋不住；
 *      · 重启后记得"上次开口"和"欠了几句没回"。
 *   B. 念头池：收/去重/过期/说过的不能再挑/超上限扔最旧的；
 *   C. 想事情：模型输出的解析（数字|内容、没写数字、只有"无"）；
 *   D. 真发一条（假 OneBot + 假模型）：心跳 → 挑念头 → 调模型 → 发出去 → 手机面板标记"她先开的口"。
 *
 * 单跑：`node test\run-one.cjs 16-presence.cjs`
 */
module.exports = {
  name: '自主说话（陪伴模式）',
  tags: ['companion', 'presence', '自主', 'mind'],
  async run(ctx) {
    const { ok, fs, path } = ctx;
    const P = ctx.mod('companion-presence');
    const { Mind } = ctx.mod('companion-mind');
    const { parseThoughts } = ctx.mod('companion-brain');

    /* ---------- A. 纯逻辑：假时钟 ---------- */

    const T0 = new Date(2026, 9, 28, 14, 0, 0).getTime(); // 2026-10-28 14:00（本地）
    let now = T0;
    /** 造一个状态机；`rng` 固定 0.5 → 抖动正好 1.0，分数可以手算。 */
    const mk = (over = {}) => P.createPresence({
      cfg: { ...over },
      now: () => now,
      rng: () => 0.5,
    });
    const thought3 = { text: '明天面试', motivation: 3 };

    ok('自主：醒着时段（含跨零点）',
      P.inActiveHours(9, [8.5, 23.5]) && !P.inActiveHours(2, [8.5, 23.5])
      && P.inActiveHours(23, [22, 7]) && P.inActiveHours(3, [22, 7]) && !P.inActiveHours(12, [22, 7]));
    ok('自主：时段分档', P.partOfDay(14) === '下午' && P.partOfDay(2) === '深夜');
    ok('自主：三档门槛是递增的（少 > 正常 > 多）',
      P.FREQUENCY.low > P.FREQUENCY.normal && P.FREQUENCY.normal > P.FREQUENCY.high);

    const p = mk({ activeHours: [0, 24] });
    p.noteUser({ key: 'private:1', at: T0 });
    ok('自主：刚说完时，念头分数就等于动机', p.score(thought3, { key: 'private:1', at: T0 }) === 3);
    ok('自主：沉默 5 分钟还不太想说', p.score(thought3, { key: 'private:1', at: T0 + 5 * 60_000 }) < 3.8);
    ok('自主：沉默 15 分钟就够想说了', p.score(thought3, { key: 'private:1', at: T0 + 15 * 60_000 }) >= 3.8);
    ok('自主：刚聊完 3 分钟内不插话', p.decide({ thoughts: [thought3], at: T0 + 60_000 }).why === 'after-user');
    ok('自主：心里没事就不说', p.decide({ thoughts: [], at: T0 + 30 * 60_000 }).why === 'no-thought');
    ok('自主：随口一句（动机 1）还不到时候',
      p.decide({ thoughts: [{ text: '随口', motivation: 1 }], at: T0 + 5 * 60_000 }).why === 'low');
    ok('自主：动机 1 的念头就算沉默一整天也不会说（沉默加成有上限）',
      p.decide({ thoughts: [{ text: '随口', motivation: 1 }], at: T0 + 24 * 3600_000 }).ok === false);
    const yes = p.decide({ thoughts: [thought3], at: T0 + 20 * 60_000 });
    ok('自主：分数够了就开口', yes.ok === true && yes.thought.text === '明天面试');
    ok('自主：只在私聊里主动（群聊不开口）', p.decide({ thoughts: [thought3], at: T0 + 20 * 60_000, key: 'group:9' }).why === 'no-target');

    // 连续两条没回 → 退避到对方先开口
    const b = mk({ activeHours: [0, 24] });
    b.noteUser({ key: 'private:1', at: T0 });
    b.noteSpoken({ key: 'private:1', at: T0 + 20 * 60_000 });
    ok('自主：刚主动完不会马上又说', b.decide({ thoughts: [thought3], at: T0 + 21 * 60_000 }).why === 'min-gap');
    b.noteSpoken({ key: 'private:1', at: T0 + 60 * 60_000 });
    ok('自主：连续两条没被回就退避',
      b.decide({ thoughts: [{ text: '还想说', motivation: 5 }], at: T0 + 100 * 60_000 }).why === 'ignored');
    b.noteUser({ key: 'private:1', at: T0 + 101 * 60_000 });
    ok('自主：对方一开口，退避立刻解除', b.snapshot(T0 + 101 * 60_000).unanswered === 0);

    // 凌晨：默认闭嘴，只有真憋不住才留一句（一晚一条）
    const night = new Date(2026, 9, 28, 2, 0, 0).getTime();
    const n = mk({ activeHours: [8.5, 23.5] });
    n.noteUser({ key: 'private:1', at: night - 10 * 60_000 });
    ok('自主：凌晨不随便说话',
      n.decide({ thoughts: [{ text: '睡不着', motivation: 4 }], at: night }).why === 'night');
    ok('自主：凌晨真憋不住可以留一句',
      n.decide({ thoughts: [{ text: '明天面试我有点担心', motivation: 5 }], at: night + 30 * 60_000 }).ok === true);
    n.noteSpoken({ key: 'private:1', at: night + 30 * 60_000 });
    ok('自主：一晚只留一句',
      n.decide({ thoughts: [{ text: '你睡了吗', motivation: 5 }], at: night + 90 * 60_000 }).why === 'night');

    // 每小时上限（把"连续没回"调高，免得先撞到 ignored）
    const bud = mk({ activeHours: [0, 24], maxPerHour: 2, maxUnanswered: 10 });
    bud.noteUser({ key: 'private:1', at: T0 });
    bud.noteSpoken({ key: 'private:1', at: T0 + 10 * 60_000 });
    bud.noteSpoken({ key: 'private:1', at: T0 + 20 * 60_000 });
    ok('自主：一小时说够了就安静',
      bud.decide({ thoughts: [{ text: '还有话说', motivation: 5 }], at: T0 + 30 * 60_000 }).why === 'hour-budget');

    // 重启：状态要能存下来（否则一开机她就会立刻开口）
    const snapBefore = b.snapshot(T0 + 101 * 60_000);
    const b2 = mk({ activeHours: [0, 24] });
    b2.hydrate(JSON.parse(JSON.stringify(b.serialize())));
    const snapAfter = b2.snapshot(T0 + 101 * 60_000);
    ok('自主：重启后记得上次开口和没被回的账',
      snapAfter.lastSpokeAt === snapBefore.lastSpokeAt && snapAfter.unanswered === snapBefore.unanswered
      && snapAfter.targetKey === 'private:1');

    /* ---------- B. 念头池 ---------- */

    const mindFile = path.join(ctx.CONFIG_DIR, 'mind-test.json');
    const mind = new Mind({ file: mindFile, max: 8, now: () => now });
    const added = mind.add([
      { text: '明天面试', motivation: 4 },
      { text: '今天风大', motivation: 2 },
      { text: '明天面试。', motivation: 3 },
    ], { key: 'private:1', personId: '1' });
    ok('念头池：重复的念头只收一条', added.length === 2);
    ok('念头池：只挑这个会话的', mind.pending({ key: 'private:1', at: now }).length === 2
      && mind.pending({ key: 'private:2', at: now }).length === 0);
    now += 61 * 60_000;
    ok('念头池：随口一句会过期（动机 2 只存一小时）', mind.pending({ key: 'private:1', at: now }).length === 1);
    const top = mind.pending({ key: 'private:1', at: now })[0];
    mind.markSpoken(top.id, now);
    ok('念头池：说过的不会再挑', mind.pending({ key: 'private:1', at: now }).length === 0
      && mind.recentSpoken({ key: 'private:1' }).length === 1);

    const cap = new Mind({ file: path.join(ctx.CONFIG_DIR, 'mind-cap.json'), max: 8, now: () => now });
    for (let i = 0; i < 10; i += 1) cap.add([{ text: `第${i}件事别忘了`, motivation: 3 }]);
    ok('念头池：超过上限就扔最旧的', cap.stats({ at: now }).total === 8);

    /* ---------- C. 想事情：解析模型输出 ---------- */

    const pt = parseThoughts('4|明天面试\n2|今天风挺大\n无', 2);
    ok('想事情：认「数字|内容」，最多两条',
      pt.length === 2 && pt[0].motivation === 4 && pt[0].text === '明天面试');
    ok('想事情：只有"无"就真的什么都不想', parseThoughts('无', 2).length === 0);
    ok('想事情：没写数字按 3 分', parseThoughts('今天有点累', 2)[0].motivation === 3);

    /* ---------- D. 真发一条（假 OneBot + 假模型） ---------- */

    const companion = ctx.mod('companion');
    const { WebSocketServer } = require(path.join(ctx.app, 'node_modules', 'ws'));
    const got = [];
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise((resolve) => wss.once('listening', resolve));
    wss.on('connection', (sock) => {
      sock.on('message', (raw) => {
        let ev = null;
        try { ev = JSON.parse(String(raw)); } catch { /* 不是 JSON 就算了 */ }
        if (!ev) return;
        got.push(ev);
        sock.send(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 1 }, echo: ev.echo }));
      });
    });
    const port = wss.address().port;
    const stub = await ctx.ensureStub();
    const wait = async (fn, ms = 5000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        if (fn()) return true;
        await new Promise((r) => setTimeout(r, 50));
      }
      return false;
    };

    try {
      companion.save({
        enabled: true,
        respond: true,
        adapter: 'builtin',
        onebot: { wsUrl: `ws://127.0.0.1:${port}`, httpUrl: '' },
        model: { mode: 'custom', baseUrl: stub.url, apiKey: 'k', model: 'test-model', maxTokens: 96, timeoutMs: 5000 },
        humanize: { enabled: false },
        names: ['大肥鱼'],
        ownerIds: ['12345'],
        chats: [],
        // 测试里把闸门全部放开：只看"该不该说"这一层
        presence: { enabled: true, activeHours: [0, 24], minGapSec: 0, afterUserMin: 0, mindEveryMin: 600 },
      });
      ok('自主：OneBot 连上（假网关）', await wait(() => companion.publicState().connected));
      ok('自主：状态里有 presence 段（桌宠据此让位）',
        companion.publicState().presence && companion.publicState().presence.enabled === true);

      // 前面的区域可能已经跑过她（同一个进程），先把状态清干净再验这一条
      companion.presence.machine().reset();
      companion.presence.machine().setTarget('private:12345');
      companion.presence.mind().forget();

      companion.presence.mind().add([{ text: '明天他面试', motivation: 5 }], { key: 'private:12345', personId: '12345' });
      const first = await companion.presence.tick(Date.now() + 60_000);
      ok('自主：心跳真的发出去了一条', first.ok === true && got.some((e) => e.action === 'send_private_msg'));
      ok('自主：手机面板上标了"她先开的口"',
        companion.recent(20).some((e) => e.type === 'outbound' && e.spontaneous === true));

      /**
       * ★ 2026-11-02：**开口这一步必须把念头钉住**。
       *
       * 真机：念头是"翻东西卡那一下"（0 分钟前刚冒出来），她说出口的却是
       * "下午想起个事，昨天你那个挑菜的店"——换话题 + 日期错。同一份数据复现 8 次，
       * 8 次全部换话题。原因是这一步只说"你心里这件事：X"，模型就去讲最近最热闹的那件。
       * 现在处境里加了两句：念头是什么时候冒出来的 + "只说这一件"。
       */
      const speakReq = [...stub.seen].reverse()
        .find((r) => JSON.stringify(r.body?.messages || []).includes('现在没人说话'));
      const speakSys = String(speakReq?.body?.messages?.[0]?.content || '');
      const speakUser = String(speakReq?.body?.messages?.at(-1)?.content || '');
      ok('自主：开口那一步拿到了"只说这一件"的约束',
        speakSys.includes('只说这一件') && speakSys.includes('明天他面试'));
      ok('自主：还告诉她这个念头是刚刚冒出来的',
        /（刚刚 \d{2}:\d{2} 冒出来的）/.test(speakSys));
      ok('自主：本轮消息里仍然只有【现在】和"该你说了"',
        /^【现在】/.test(speakUser) && speakUser.includes('现在没人说话'));

      const second = await companion.presence.tick(Date.now() + 120_000);
      ok('自主：紧接着不会再说第二句（念头已经用掉）', second.ok === false);

      // 想事情这条路也真的走一遍：模型给一句（假模型不分行），要能落进念头池。
      // 注意：心跳自己也会"想事情"，所以这里看池子，不看这一次返回值（可能刚好撞上重复）。
      await companion.presence.think();
      ok('自主：想事情会调模型并把念头存进池子',
        companion.presence.mind().pending({ key: 'private:12345' }).length >= 1);
    } finally {
      companion.save({ enabled: false });
      wss.close();
    }

    /* ---------- E. 设置页 ---------- */

    const html = fs.readFileSync(path.join(ctx.app, 'web', 'settings.html'), 'utf8');
    ok('设置页：有「她会自己找你说话」开关和频率三档',
      html.includes('id="cAutoSpeak"') && html.includes('id="cAutoFreq"')
      && html.includes('value="low"') && html.includes('value="normal"') && html.includes('value="high"'));
    ok('设置页：保存时会写 presence，回填时读 presence',
      /presence:\s*\{[\s\S]{0,120}frequency/.test(html) && html.includes("$('cAutoSpeak').checked"));
  },
};
