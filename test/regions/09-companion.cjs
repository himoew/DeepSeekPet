/**
 * 自检区域：QQ 陪伴模式（2026-10-22 新增）
 *
 * 两项：
 *   A. 纯逻辑：拟人化分条、唤醒判定、角色卡、人物记忆；
 *   B. 真连一遍：桌宠里打字 → 走陪伴大脑（假模型）→ 气泡；再切到 `kit-jsonl`，
 *      往 events.jsonl 写一条出站，页面应收到手机面板事件 + 一个 `tag=companion` 的气泡。
 *
 * 不碰真 QQ、不碰真模型：模型用骨架的假端点，事件文件写在临时目录。
 * 单跑：`node test\run-one.cjs 09-companion.cjs`
 */
module.exports = {
  name: '陪伴模式（QQ）',
  tags: ['companion', '陪伴', 'qq'],
  async run(ctx) {
    const { ok, fs, path } = ctx;
    const companion = ctx.mod('companion');
    const llm = ctx.mod('llm');
    const { Humanizer, split } = ctx.mod('companion-humanize');
    const humanizeMod = ctx.mod('companion-humanize');
    const wake = ctx.mod('companion-wake');
    const role = ctx.mod('companion-role');
    const caps = ctx.mod('companion-capabilities');
    const selfNotes = ctx.mod('companion-self');

    /* ---------- A. 纯逻辑 ---------- */

    // ★ 2026-10-29：分条只认她的换行；程序不再按句号切、不再合并短句。
    const parts = split('第一句说得长一点。\n第二句也说得长一点！\n第三句还是长一点？');
    ok('分条：换行就是一条，不按句末标点再切', parts.length === 3 && parts[0].startsWith('第一句'));

    const noBreak = split('第一句。第二句。第三句。第四句。第五句。', 6);
    ok('分条：没有换行就不替她切（一整条）', noBreak.length === 1);

    const shortLines = split('嗯。\n我在。\n你呢？');
    ok('分条：短句不自动合并', shortLines.length === 3 && shortLines[0] === '嗯。');

    const long = split('啊'.repeat(100), 6);
    ok('分条：一整段没有标点也不会丢字', long.join('').length === 100 && long.length === 1);

    const many = split(Array.from({ length: 8 }, (_, i) => `第${i + 1}条`).join('\n'), 6);
    ok('分条：超过上限时只并最后几条、不丢字',
      many.length === 6 && many.join('\n').includes('第8条') && many[5].includes('第6条'));

    const h = new Humanizer({ enabled: false });
    const sent = [];
    const r = await h.say('你好。再见。', { send: async (m) => sent.push(m), sleep: async () => {} });
    ok('拟人化：关掉节奏时一条条发，不睡', r.sent === sent.length && sent.length >= 1);

    /**
     * ★ 2026-11-01：**"深夜打字慢 1.6 倍"现在可以钉住了**（`typingMs` 能传 hour）。
     * 原来它直接读真实时钟，半夜跑自检会整体变慢，"深夜变慢"这条行为也没法测。
     */
    const dayMs = humanizeMod.typingMs('你好呀', { hour: 12, jitter: 0 });
    const nightMs = humanizeMod.typingMs('你好呀', { hour: 3, jitter: 0 });
    ok('拟人化：深夜（02:00–07:00）打字时长 ×1.6，白天不乘',
      nightMs === Math.round(dayMs * 1.6) && dayMs === Math.round(Math.max(1200, 1200 + 3 * 85)));

    ok('唤醒：主人说话必醒', wake.shouldWake({ isGroup: true, userId: '9', text: '嗯' }, { ownerIds: ['9'] }).wake);
    ok('唤醒：私聊每条都理', wake.shouldWake({ isGroup: false, userId: '2', text: '嗯' }, {}).wake);
    ok('唤醒：群里普通消息不醒', !wake.shouldWake({ isGroup: true, userId: '2', text: '今天天气不错' }, { names: ['大肥鱼'] }).wake);
    ok('唤醒：群里 @ 会醒', wake.shouldWake({ isGroup: true, userId: '2', text: '在吗', isAtMe: true }, {}).wake);
    ok('唤醒：叫她名字会醒', wake.shouldWake({ isGroup: true, userId: '2', text: '大肥鱼在不在' }, { names: ['大肥鱼'] }).reason === 'name:大肥鱼');

    /**
     * ★ 2026-11-01：**群聊策略现在能在设置页调**（以前只能手改 `config\companion.json`）。
     * 逻辑本身不动（`companion-wake` 那几条不变），这里验的是"页面上的 0 真的是 0"。
     */
    ok('唤醒：概率 0% 时群里一条都不醒（设置页那个 0 不是摆设）',
      !wake.shouldWake({ isGroup: true, userId: '2', text: '今天天气不错' },
        { wake: { probability: 0, groupAtOnly: false } }).wake);
    ok('唤醒：只认 @（groupAtOnly，默认）时概率不再生效',
      !wake.shouldWake({ isGroup: true, userId: '2', text: '今天天气不错' },
        { wake: { probability: 1, groupAtOnly: true } }).wake
      && wake.shouldWake({ isGroup: true, userId: '2', text: '在吗', isAtMe: true },
        { wake: { probability: 0, groupAtOnly: true } }).wake);
    ok('唤醒：去掉"只认 @"之后，像提问的群消息会让她醒',
      wake.shouldWake({ isGroup: true, userId: '2', text: '这东西怎么做啊' },
        { wake: { groupAtOnly: false } }).reason === 'question');
    {
      const html = fs.readFileSync(path.join(ctx.app, 'web', 'settings.html'), 'utf8');
      ok('设置页：群聊策略真的接上了（概率 0~20% + 群里只认 @ → cForm.wake）',
        html.includes('id="cWakeProb"') && html.includes('id="cGroupAtOnly"')
        && html.includes("$('cWakeProb').value") && html.includes("$('cGroupAtOnly').checked")
        && /wake:\s*\{[\s\S]{0,240}probability:/.test(html)
        && /probability:[\s\S]{0,260}groupAtOnly:/.test(html));
    }

    const sys = role.build({ situation: '你在 QQ 群里。', memory: '【关于 A 的一本账】\n常熬夜', recent: 'A：在吗' });
    ok('角色卡：带通用拟人人设（不绑桌宠）、处境、记忆、最近对话',
      ['在 QQ 上跟他聊天', 'QQ 群', '常熬夜', 'A：在吗'].every((s) => sys.includes(s))
      && !sys.includes('小鲸鱼女仆') && !sys.includes('尾巴'));
    ok('角色卡：超长时会截断而不是原样塞进去', role.build({ roleText: '啊'.repeat(20000), maxChars: 1000 }).length < 1500);
    /**
     * ★ 2026-11-08 夜（用户：「**她发的消息和视频内容完全对不上**」）：
     *
     * 真机 23:36 那一轮：回灌的处境里明明写着"你刚刷了会儿视频：《小傻龙…》…你只看到了这些"，
     * 她却说"看了个修老物件的，把锈住的螺丝泡开一点点拆"。
     * 根因之一是 `role.build` 的截断：head 只留 `role + self`、tail 取最后 35%，
     * 夹在中间的 **【此刻】**（就是那段事实）整块被"（…中间的记忆太长…）"替掉了。
     */
    {
      const cut = role.build({
        roleText: '记'.repeat(9000),
        self: `自我：${'我'.repeat(500)}`,
        situation: '你刚用自己的手机刷了会儿视频：《小傻龙》一只手在戳摆件。你只看到了这些。',
        platform: '桌宠',
        longTerm: `【长期记忆】${'忆'.repeat(6000)}`,
        recent: `最近对话：${'话'.repeat(3000)}`,
        maxChars: 4000,
      });
      ok('角色卡：超长截断时【此刻】不许被砍掉（不然她就没事实、只能编）',
        cut.includes('【此刻】') && cut.includes('小傻龙'));
      ok('角色卡：超长截断时【场合】也留着', cut.includes('【场合】'));
      ok('角色卡：截断后仍然比上限短', cut.length <= 4200);
    }
    /**
     * ★ 2026-11-01：**处境不叫「现在」**。
     * 真正的时间（`【现在】2026-11-01 09:02 周日`）在**本轮消息**里（见 `companion-brain`），
     * system 里再写一个「现在」会让"对方刚问你时间"这种处境也被框成"现在是…"。
     */
    const sysNow = role.build({ situation: '你在 QQ 群里。对方刚问你时间。' });
    ok('角色卡：处境那一段叫「此刻」，不跟本轮消息里的「现在」撞名',
      sysNow.includes('【此刻】你在 QQ 群里') && !sysNow.includes('【现在】'));
    ok('角色卡：说话长度交还给她（不再写死一两句，改用换行分条）',
      !role.DEFAULT_ROLE.includes('一两句') && role.DEFAULT_ROLE.includes('换行，一行一条'));
    /**
     * ★ 2026-11-01：角色卡**不再提供"不确定能不能…"这个句式**。
     *
     * 原来那一句是"不确定能不能做，试一下再说，别一口咬定做不到"——本意是防她张口就说
     * 做不到，结果"不确定能不能"被她捡成了口头禅（实测发语音前先说一句"不确定能不能调"）。
     * 意思保留（能做就做，做不成再说），只把那个说法拿掉。
     */
    ok('角色卡：不再教她"不确定能不能…"的说法',
      !role.DEFAULT_ROLE.includes('不确定能不能') && role.DEFAULT_ROLE.includes('能做就直接做'));

    const capsWith = caps.buildCapabilityHints({ stickerTags: ['晚安', '开心'], canCollect: true });
    ok('能力提示：有表情时给出关键词、发图和收藏写法',
      capsWith.includes('【表情包】') && capsWith.includes('晚安')
      && capsWith.includes('[表情:关键词]') && capsWith.includes('[收藏:关键词]'));
    ok('能力提示：有图时才加【图片】',
      caps.buildCapabilityHints({ images: [{ dataUrl: 'x' }] }).includes('【图片】')
      && !caps.buildCapabilityHints({}).includes('【图片】'));
    const capsOnly = caps.buildCapabilityHints({});
    ok('能力提示：没有图/表情时只剩看表',
      capsOnly.includes('【时间】') && !capsOnly.includes('【图片】') && !capsOnly.includes('【表情包】'));

    /**
     * ★ 2026-10-28：名字只认第一次。QQ 昵称（「✏️」）每轮都会传进来，
     * 不能把用户自己认下的名字（「小主」）顶掉；但"名字还是个 id"时要允许写进来。
     */
    const { CompanionMemory } = ctx.mod('companion-memory');
    const named = new CompanionMemory({ dir: path.join(ctx.CONFIG_DIR, 'name-test') });
    named.person('u9', { name: '小主' });
    named.remember('u9', { name: '✏️' });
    ok('人物账：QQ 昵称顶不掉已经认下的名字', named.person('u9').name === '小主');
    named.person('u10');            // 新账：名字先落在 id 上
    named.remember('u10', { name: '小主' });
    ok('人物账：名字还是 id 时允许写入', named.person('u10').name === '小主');

    /* ---------- B. 桌宠里打字 / 手机面板 ---------- */

    await ctx.live.ensure();
    const stub = await ctx.ensureStub();
    const eventFile = path.join(ctx.CONFIG_DIR, 'events.jsonl');
    fs.writeFileSync(eventFile, '', 'utf8');

    // 先把陪伴模式打开：桌宠里打一句话，应该走陪伴大脑而不是 llm.chat
    companion.save({
      enabled: true,
      adapter: 'builtin',
      onebot: { wsUrl: 'ws://127.0.0.1:1', httpUrl: '' },
      model: { baseUrl: stub.url, model: 'test-model', apiKey: 'test-key' },
      humanize: { enabled: false },
      names: ['大肥鱼'],
      ownerIds: ['owner'],
    });
    ok('陪伴模式：打开后状态是开', companion.isOn() && companion.publicState().model.ready);

    fromPet.length = 0;
    selfNotes.forget();
    selfNotes.add(['最近被夸时会先顶一句']);
    ws.send(JSON.stringify({ t: 'text', text: '今天好累' }));
    let answer = await nextReply('answer', 9000);
    // 假模型跟自检共用一个进程，偶尔会撞上一次 ECONNRESET（实测全量跑偶发）；
    // 这跟被测逻辑无关，重发一次就好 —— 真机上是"再问一句"，不掩盖产品问题。
    if (!answer.beats[0].text.includes('我是测试模型')) {
      fromPet.length = 0;
      ws.send(JSON.stringify({ t: 'text', text: '今天好累' }));
      answer = await nextReply('answer', 9000);
    }
    ok('陪伴模式：桌宠里打字走的是陪伴大脑', answer.beats[0].text.includes('我是测试模型'));
    const lastReq = stub.seen.at(-1);
    ok('陪伴模式：system 里带了通用拟人人设（不是桌宠）',
      lastReq.body.messages[0].content.includes('在 QQ 上跟他聊天')
      && !lastReq.body.messages[0].content.includes('小鲸鱼女仆'));
    // ★ 2026-11-01：本轮消息最前面多了一行【现在】（日期/星期/钟点），这句本身仍在。
    const userMsg = String(lastReq.body.messages.at(-1).content);
    ok('陪伴模式：这一句是作为 user 发过去的（前面带一行【现在】）',
      /^【现在】\d{4}-\d{2}-\d{2} \d{2}:\d{2} 周[一二三四五六日]\n/.test(userMsg)
      && userMsg.endsWith('\n今天好累'));
    ok('陪伴模式：system 里带上了“最近你自己”的观察',
      lastReq.body.messages[0].content.includes('【最近你自己】')
      && lastReq.body.messages[0].content.includes('最近被夸时会先顶一句'));
    selfNotes.forget();
    // ★ 2026-10-27：topics 不再逐句写（旧 topics 会迁进长期记忆）；这里改验"对话流 + 互动次数"。
    ok('陪伴模式：这一轮写进了对话流和人物账', companion.memorySnapshot().turns >= 1
      && companion.memorySnapshot().people.some((p) => p.id === 'owner' && p.interactions > 0));

    /**
     * ★ 2026-11-08（R1）：**桌宠这条路也要认"停"和"去玩"**。
     *
     * 真机 11-07 23:36:30：「不是你这家伙压根不听啊，我来给你操作吧」——
     * QQ 那条路会 `looksLikeStop()` → `phoneRt.stop()`；桌宠那条路**一个判断都没有**，
     * 于是他明确说要接手，她还在让手机点下去。现在两条路走同一个 `phoneIntentHints()`。
     */
    fromPet.length = 0;
    ws.send(JSON.stringify({ t: 'text', text: '不是你这家伙压根不听啊，我来给你操作吧' }));
    const stopAns = await nextReply('answer', 9000);
    ok('桌宠：「我来操作」照样回一句（不报错、不哑火）', !!stopAns && stopAns.beats.length > 0);
    const stopSys = String(stub.seen.at(-1)?.body?.messages?.[0]?.content || '');
    ok('桌宠：「我来操作」被当成"停"，处境里说清了（这条以前只在 QQ 有）',
      /把手机放下了|本来就没在玩手机/.test(stopSys));

    /**
     * ★ 2026-11-08（用户 21:54）：**他要她用手机，可她手上没有手机** → 要告诉她。
     *
     * 真机 21:48–21:51：手机根本没开（`enabled:false`），他说「去浏览器点开」，
     * 她回"已经在点了""一屏都是圆鼓鼓的胖鱼" —— 因为处境的手机提示整块是空的
     * （`capabilities.phone` 在 `on:false` 时整块不注入），没人告诉她手没接上。
     * 用户：「只需要提醒她没手机操作，怎么回复我随她想法」。
     */
    fromPet.length = 0;
    ws.send(JSON.stringify({ t: 'text', text: '你点第一条，进那个网站看看' }));
    const npAns = await nextReply('answer', 9000);
    ok('桌宠：手机没开时他让她动手，照样回一句（不哑火）', !!npAns && npAns.beats.length > 0);
    const npSys = String(stub.seen.at(-1)?.body?.messages?.[0]?.content || '');
    ok('桌宠：手机不在手上时，处境里写明了"你手上现在没有手机"',
      /你手上现在没有手机|没有手机可以操作/.test(npSys));
    ok('桌宠：并明说"怎么说随你"（不规定她怎么回）', /怎么说随你/.test(npSys));
    ok('桌宠：还提醒她别装成已经做了、别编手机上的东西',
      /别装成已经做了/.test(npSys) && /也别编/.test(npSys));

    /**
     * ★ 2026-11-02：**历史里的每一轮都要带"哪天几点"**。
     *
     * 用户报「念头（主动开口）把日期说错」。真机 19:12 她说"昨天你那个挑菜的店"，
     * 而那事就在当天 18:41 —— 她那 20 轮历史里一条日期都没有，只能猜。
     * 现在每条前面加「（今天 18:41）」「（昨天 23:44）」。
     */
    fromPet.length = 0;
    ws.send(JSON.stringify({ t: 'text', text: '还没睡呢' }));
    await nextReply('answer', 9000);
    const req2 = stub.seen.at(-1);
    const hist2 = req2.body.messages.slice(0, -1).map((m) => String(m.content));
    ok('陪伴模式：历史里的每一轮都带日期（今天 HH:MM）',
      hist2.some((s) => /^（今天 \d{2}:\d{2}）/.test(s)));
    ok('陪伴模式：本轮那条不带日期前缀（时间只在【现在】那一行）',
      /^【现在】/.test(String(req2.body.messages.at(-1).content)));

    // 切成只读外部 kit：写一条出站，页面应收到手机事件 + 气泡
    companion.save({
      enabled: true,
      adapter: 'kit-jsonl',
      kitEventsPath: eventFile,
      replayLast: 0,
      humanize: { enabled: false },
    });
    fromPet.length = 0;
    fs.appendFileSync(eventFile, `${JSON.stringify({
      type: 'outbound', at: Date.now(), key: 'group:456', isGroup: true,
      userId: '123', name: '群友A', text: '在的，怎么啦', parts: ['在的，', '怎么啦'],
    })}\n`, 'utf8');

    const phoneEvent = await waitFor('手机面板事件', () => fromPet.find((m) => m.t === 'companion'), 9000);
    ok('陪伴模式：events.jsonl 的出站进了手机面板',
      phoneEvent.event.type === 'outbound' && phoneEvent.event.parts.length === 2);
    const phoneSay = await nextReply('companion', 9000);
    ok('陪伴模式：QQ 回复在桌宠气泡里冒第一句', phoneSay.beats[0].text === '在的，');

    // 关掉，别影响后面的区域/用户的真实配置（临时目录反正也会被删）
    companion.save({ enabled: false });
    ok('陪伴模式：关掉后状态是关', !companion.isOn());

    /* ---------- C. QQ 那条线（假 OneBot）：引用回复 / 正在输入 ---------- */

    /**
     * ★ 2026-11-01：这两条以前**在自检里根本碰不到** —— 前面的区域验的是网关进程、看图、
     * 手机接线，假 OneBot 一个都没有。这里起一个最小网关：收到 `{action, params, echo}`
     * 就回 `{status:'ok', retcode:0, data, echo}`，并把每次调用连**时刻**一起记下来。
     */
    const { WebSocketServer } = require(path.join(ctx.app, 'node_modules', 'ws'));
    const SHE = '10000';
    async function fakeGateway() {
      const calls = [];
      const socks = new Set();
      const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
      await new Promise((res) => wss.on('listening', res));
      wss.on('connection', (sock) => {
        socks.add(sock);
        sock.on('close', () => socks.delete(sock));
        sock.on('message', (raw) => {
          let req = null;
          try { req = JSON.parse(String(raw)); } catch { return; }
          const rec = { action: req.action, params: req.params || {}, at: Date.now() };
          calls.push(rec);
          const reply = (data) => {
            try { sock.send(JSON.stringify({ status: 'ok', retcode: 0, data, echo: req.echo })); } catch { /* 断了 */ }
          };
          if (req.action === 'get_msg') {
            // `q-me-*` 当"他引用的那句是她说的"，其余当"引用的是别人"
            const qid = String(rec.params.message_id || '');
            reply({ message_id: qid, sender: { user_id: qid.startsWith('q-me') ? SHE : '20000' } });
            return;
          }
          reply({});
        });
      });
      return {
        calls,
        url: `ws://127.0.0.1:${wss.address().port}`,
        push: (ev) => { for (const s of socks) { try { s.send(JSON.stringify(ev)); } catch { /* 断了 */ } } },
        close: () => new Promise((res) => {
          for (const s of socks) { try { s.close(); } catch { /* 已关 */ } }
          wss.close(() => res());
        }),
      };
    }
    /** 一条收到的 QQ 消息（私聊/群只是参数不同）。 */
    const qqMsg = (extra = {}) => ({
      post_type: 'message', time: Math.floor(Date.now() / 1000), self_id: Number(SHE),
      message_id: 'm1', message: [{ type: 'text', data: { text: '在吗' } }],
      sender: { nickname: '他' }, ...extra,
    });

    // C1. 运输层：引的是她 → isQuoteMe；引的是别人 → 还是 false
    const qgw = await fakeGateway();
    const { OneBotClient } = ctx.mod('companion-onebot');
    const qGot = [];
    const qChecked = [];
    const qc = new OneBotClient({ wsUrl: qgw.url, onMessage: (m) => qGot.push(m), onQuoteCheck: (m) => qChecked.push(m) });
    qc.start();
    await waitFor('假 OneBot 连上', () => qc.connected, 4000);
    qgw.push(qqMsg({
      message_type: 'group', group_id: 456, user_id: '7', message_id: 'm-q1',
      message: [{ type: 'reply', data: { id: 'q-me-1' } }, { type: 'text', data: { text: '这句是你说的' } }],
    }));
    await waitFor('引用查清了（是她）', () => qChecked.length >= 1, 4000);
    ok('引用：引用了她的话 → isQuoteMe 变 true',
      qGot[0]?.isQuoteMe === true && qGot[0]?.key === 'group:456' && qGot[0]?.replyTo === 'q-me-1');
    qgw.push(qqMsg({
      message_type: 'group', group_id: 456, user_id: '8', message_id: 'm-q2',
      message: [{ type: 'reply', data: { id: 'q-other-2' } }, { type: 'text', data: { text: '别人那句' } }],
    }));
    await waitFor('引用也查过了（不是她）', () => qChecked.length >= 2, 4000);
    ok('引用：引用的是别人 → 还是 false', qGot[1]?.isQuoteMe === false && qGot[1]?.replyTo === 'q-other-2');
    qc.stop();
    await qgw.close();

    // C2. 接线：群里"引用她那句话"以前会被直接丢掉（isQuoteMe 是后台查的）
    const gw = await fakeGateway();
    let typingAt = 0;
    /** `bus` 是 EventEmitter：`on()` 不回取消函数，挂一个监听就够了（区域结束就一起丢）。 */
    companion.on('event', (ev) => {
      if (ev.type === 'typing' && ev.on && !typingAt) typingAt = Date.now();
    });
    companion.save({
      enabled: true,
      adapter: 'builtin',
      onebot: { wsUrl: gw.url, httpUrl: '' },
      model: { baseUrl: stub.url, model: 'test-model', apiKey: 'test-key' },
      humanize: { enabled: false },
      names: ['大肥鱼'],
      ownerIds: ['owner'],
      // 合并窗口压到 120ms：这一区不该为了"等人说完"白等 1.5 秒
      wake: { privateWindowMs: 120, groupWindowMs: 120 },
    });
    await waitFor('陪伴模式连上假网关', () => gw.calls.length >= 0 && companion.prefs().connected, 5000);
    const tAsk = Date.now();
    gw.push(qqMsg({ message_type: 'private', user_id: '7', message_id: 'm-p1' }));
    await waitFor('她回了那句私聊', () => gw.calls.some((c) => c.action === 'send_private_msg'), 9000);
    ok('QQ：私聊那句真的发出去了（假网关收到 send_private_msg）',
      gw.calls.some((c) => c.action === 'send_private_msg'));
    /**
     * 顺序断言用**进程内的时刻**（`typing` 事件是同步发的，早于那次 fetch）；
     * 拿网关收到 `set_input_status` 的时刻去比会飘 —— 两个本机服务谁先到差一两毫秒。
     */
    const modelAt = stub.seen.filter((s) => s.at >= tAsk && JSON.stringify(s.body || {}).includes('在吗')).at(-1)?.at || 0;
    ok('正在输入：调模型之前就先点亮了（那 3~10 秒 QQ 上不再一点动静都没有）',
      typingAt > 0 && modelAt > 0 && typingAt <= modelAt);
    await waitFor('发完关掉正在输入', () => gw.calls.some((c) => c.action === 'set_input_status' && c.params.event_type === 0), 5000);
    ok('正在输入：这一批发完之后关掉了（失败路径也在 finally 里关）',
      gw.calls.some((c) => c.action === 'set_input_status' && c.params.event_type === 0));

    // 群里一条"引用她那句话"的消息：wake 判定当场只知道"没人叫她"，靠后台查回来
    gw.push(qqMsg({
      message_type: 'group', group_id: 456, user_id: '8', message_id: 'm-g1',
      sender: { nickname: '群友B' },
      message: [{ type: 'reply', data: { id: 'q-me-g' } }, { type: 'text', data: { text: '你刚才那句挺好笑' } }],
    }));
    await waitFor('群里"引用她"也会回', () => gw.calls.some((c) => c.action === 'send_group_msg'), 9000);
    ok('引用：群里引用她那句话 → 会叫醒她（以前这条消息被直接丢掉，一声不响）',
      gw.calls.some((c) => c.action === 'send_group_msg'));

    /* ---------- C3. ★ 2026-11-03：模型吃 503 时，QQ 那条会自动补发 ---------- */

    /**
     * 真事（2026-11-03 18:27–18:28）：DeepSeek 连回 503，QQ 那边只在日志里留一行 WARN，
     * 人那头什么都没收到。现在 `callModel` 自己退避重试 4 次；QQ 这条**还会把这一批再排一次**
     * （默认 15 秒 / 45 秒）。这里把两段等待都压到几十毫秒，验
     * "第一轮 4 次全 503 → 自动补发 → 第二次接上"。
     */
    const gw2 = await fakeGateway();
    const keepWaits = llm.RETRY_WAITS.slice();
    const keepBatchWaits = companion.retryPolicy.batchWaits.slice();
    const keepNoticeGap = companion.retryPolicy.noticeGapMs;
    llm.RETRY_WAITS.splice(0, llm.RETRY_WAITS.length, 2, 2, 2);
    companion.retryPolicy.batchWaits = [40, 40];
    const flakyBefore = stub.seen.length;
    try {
      companion.save({
        enabled: true,
        adapter: 'builtin',
        onebot: { wsUrl: gw2.url, httpUrl: '' },
        model: { baseUrl: stub.url, model: 'flaky-model', apiKey: 'test-key' },
        humanize: { enabled: false },
        names: ['大肥鱼'],
        ownerIds: ['owner'],
        wake: { privateWindowMs: 60, groupWindowMs: 60 },
      });
      await waitFor('陪伴模式连上第二个假网关', () => companion.prefs().connected, 5000);
      gw2.push(qqMsg({ message_type: 'private', user_id: '7', message_id: 'm-f1' }));
      await waitFor('补发之后那句真的发出去了', () => gw2.calls.some((c) => c.action === 'send_private_msg'), 9000);
      const hits = stub.seen.slice(flakyBefore).filter((s) => s.body?.model === 'flaky-model').length;
      ok('503 补发：第一轮 4 次全挂之后，QQ 自动补发一次就接上了（他不用再发一遍）',
        gw2.calls.some((c) => c.action === 'send_private_msg') && hits === 6);
    } finally {
      companion.retryPolicy.batchWaits = keepBatchWaits;
      companion.retryPolicy.noticeGapMs = keepNoticeGap;
      llm.RETRY_WAITS.splice(0, llm.RETRY_WAITS.length, ...keepWaits);
      companion.save({ enabled: false });
      await gw2.close();
    }

    companion.save({ enabled: false });
    await gw.close();
  },
};
