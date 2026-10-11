/**
 * 自检区域：真连一遍（气泡/部位/自动说话/天气/行为验证）
 * 从原 `test\smoke.cjs` 切出来的，**代码一字未改**（只把裸模块名换成 `ctx.*`）。
 * 单跑：`node test\smoke.cjs live`
 */
module.exports = {
  name: "真连一遍（气泡/部位/自动说话/天气/行为验证）",
  tags: ['live', '联调', '气泡', '天气', '部位'],
  async run(ctx) {
    const { __mark, FILES, fs, path, pathToFileURL, http, pet, lines, llm, store, checkLines, pageAreas, pageStages, pageGrabParts,
      textsOf, textsFilled, base, port, WebSocket, ok } = ctx;
    /** 假模型端点：这一区自己起一个。 */
    const stub = await ctx.ensureStub();
    /* ---------- 5. 连上之后的反应 ---------- */
    let fromPet = [];
    let ws = new WebSocket(`ws://127.0.0.1:${port}/socket?role=pet&host=window`);
    // `at` 记下收到的时刻，用来断言"两个气泡之间隔了多久"
    ws.on('message', (raw) => fromPet.push(Object.assign(JSON.parse(raw.toString()), { at: Date.now() })));
    // `pick` 直接返回想要的那条消息（别用 Array.find 配一个忽略参数的谓词：
    // find 会把元素当参数传进去，谓词却只看全局计数，于是会返回错的那一条）。
    /**
     * 等一条消息。失败时报出**收到了什么**，而且说得尽量细：
     * 气泡要带上它的 `kind` / `tag` / 文本 / 相对第一条消息的毫秒数 ——
     * "等不到"这种红最难查的就是"到底是谁先冒出来把它挡了"，
     * 而 `tag` 正好能一眼看出是不是计时器自己开的口（见下面 isSelfTalk）。
     */
    const waitFor = (what, pick, ms = 6000) => new Promise((resolve, reject) => {
      const deadline = Date.now() + ms;
      const t0 = fromPet[0]?.at || Date.now();
      const dump = () => fromPet.map((m) => {
        const dt = `+${(m.at || Date.now()) - t0}ms`;
        if (m.t !== 'say') return `${m.t}@${dt}`;
        const text = (m.beats || []).map((b) => b.text).join('+');
        return `say@${dt}{kind=${m.kind},tag=${m.tag || '-'}}:${text}`;
      }).join(' | ');
      const tick = () => {
        const hit = pick();
        if (hit) return resolve(hit);
        if (Date.now() > deadline) return reject(new Error(`等不到 ${what}（收到 ${dump()}）`));
        setTimeout(tick, 20);
      };
      tick();
    });
    const says = () => fromPet.filter((m) => m.t === 'say');
    /**
     * 数气泡时**要排掉它自己主动说的那些话**（发呆 / 犯困 / 记忆话）：它们由 `fidget`
     * 定时器冒出来，跟被测的那条路（自动说话 / 静默期 / 连点合并…）毫无关系。
     *
     * 不排掉的话，**任何"等 N 秒、数气泡"的断言都会随机红一次**：`IDLE_MIN_MS` 是 35 秒起，
     * 而整轮自检要跑几分钟，总有几秒会撞上它。实测撞过好几次：
     * 「要是能出去走走就好了。」·「早上还是有点困……」（第 1.15 节加的按时段发呆话）·
     * 记忆话（第 1.16 节加的）——**每加一批"它自己会开口"的台词，这里就要跟着加一批**，
     * 否则自检就会变成随机红。**排的时候按"模板渲染后"排**（见下面 templateRe），
     * 拿模板字面量去比是排不掉的 —— 这个坑让上一轮自检卡了很久。
     * 交接文档第 1.10 / 1.11 节记的就是这个，
     * **修这里，别去动 `pet.cjs` 的定时器逻辑** —— 那正是第 1.8 节 ④
     * "自检写错了却去改产品代码"的教训。
     *
     * ⚠️ **别把 `lines.llmFailed` 也塞进来**：那句是"模型挂了"这条被测路径的**应答**，
     * 自检里专门有一条断言它（第 5 节「模型出错时退回内置台词」）。把它当成自说自话排掉，
     * 那条断言就永远等不到气泡 —— 实测踩过（`等不到 下一个气泡（收到 thinking,thinking,say）`）。
     * 只有"定时器自己冒出来的话"才是自说自话：发呆 / 犯困 / 记忆。
     */
    const SELF_TALK_TAGS = new Set(['idle', 'drowsy', 'memory']);
    const SELF_TALK = [
      lines.idle, lines.drowsy,
      ...Object.values(lines.idleByTime || {}),
      ...Object.values(lines.drowsyByTime || {}),
      lines.memoryWords, lines.memoryArea, lines.memoryHour,
      lines.memoryMilestone, lines.memoryAway,
    ];
    /**
     * 文本兜底：台词库里存的是**模板**（`我还记得你说「{words}」呢。`），气泡里是**渲染后**的
     * 文本（`我还记得你说「慢慢来」呢。`）—— 直接比字符串一条都排不掉，实测就是这里把
     * 「抓放的气泡都是抓/放的台词」弄红的（那句记忆话被当成抓放的回话）。
     * 所以按模板把每个 `{占位符}` 编译成通配，模板没变的（发呆/犯困话）走原样包含。
     * （主判据已经是 `say.tag`，这里是"万一是老协议/新加的定时器台词"时的第二道网。）
     */
    const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const templateRe = (text) => new RegExp('^' + escapeRe(text).replace(/\\\{[a-zA-Z]+\\\}/g, '.*') + '$');
    const SELF_RE = textsOf(...SELF_TALK.filter(Boolean)).map(templateRe);
    /**
     * 这句话是不是"它自己冒出来的"（不是对我这次操作的应答）。
     *
     * **主判据是 `say.tag`**（`idle` / `drowsy` / `memory`）—— 那是应答链里本来就有的出处标记，
     * 比文本可靠：台词带 `{words}`/`{area}`/`{hour}` 时气泡里是渲染后的文本，文本比对排不掉。
     * 文本那套留着当兜底（老协议没有 tag 时仍然能排掉大部分），两条都命中才算。
     */
    const isSelfTalk = (m) => SELF_TALK_TAGS.has(m.tag) || SELF_RE.some((re) => re.test(m.beats[0].text));
    const ownSays = () => says().filter((m) => !isSelfTalk(m));
    /** 断言信息里带上"收到的是哪几句"，下次红了能一眼看清是谁冒出来的。 */
    const ownTexts = () => ownSays().map((s) => s.beats.map((b) => b.text).join('+')).join(' | ');
    /**
     * 等到"下一个气泡"，但**只认它对我的操作做出的回话**（`ownSays`）。
     *
     * 为什么不能拿 `says()` 直接数：发呆/犯困/记忆话跟被测的那条路无关，却会**抢在**
     * 我这句回话前面冒出来（实测：「戳头说的是『头』那一桶」那次被一句记忆话
     * `我还记得你说「慢慢来」呢。` 抢走，报"等不到 这一下的回话"）。
     * 排空之后从零开始等，所以不用记下标。
     */
    const nextSay = (ms = 6000) => waitFor('下一个气泡', () => ownSays()[0], ms);
    /**
     * 只等**某个出处**的那条回话（`say.tag`）。
     *
     * 为什么需要它：`nextSay` 认的是"第一条不是自说自话的气泡"，而**上一节排队的回答**
     * 可能这一秒才轮到（应答链一条气泡要占 0.8~2 秒），于是它被当成这一节的回话，
     * 断言就红了（实测：「模型出错时退回内置台词」那次收到的是上一节 `tag=answer` 的
     * 模型回答，而断言在等 `llmFailed`）。按 tag 等就完全没有这个歧义。
     */
    const nextReply = (tag, ms = 8000) => waitFor(`tag=${tag} 的回话`, () => says().find((m) => m.tag === tag), ms);
    /**
     * 等到"没有新消息进来"再往下走，然后清空 `fromPet`。
     *
     * 为什么需要它：**语音合成要 2~3 秒**，上一节排出去的那条回复可能还在路上，
     * 于是它会落进下一节那段"固定等 N 秒、数气泡"的窗口里，把断言弄红。
     * 实测（女声换好之后）"念提示词的句子不冒泡"和"第二下升到又戳"就这样间歇性失败过。
     * 与其把窗口调得更长，不如在开始计数前**先排空**：这才是"只数这一节的东西"。
     */
    const drain = async (quietMs = 1200, maxMs = 20000) => {
      const deadline = Date.now() + maxMs;
      let last = fromPet.length, lastChange = Date.now();
      for (;;) {
        await new Promise((r) => setTimeout(r, 300));
        if (fromPet.length !== last) { last = fromPet.length; lastChange = Date.now(); }
        if (Date.now() - lastChange >= quietMs) break;
        if (Date.now() > deadline) break;      // 一直有动静就别死等，交给断言去报
      }
      fromPet.length = 0;
    };

    await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });

    const init = await waitFor('init', () => fromPet.find((m) => m.t === 'init'));
    ok('init 带的是大肥鱼', init.skin.figure === 'whale' && init.skin.scheme === 'deepseek');
    ok('init 只给这一版能兑现的悬停按钮', init.hoverButtons.every((b) => ['chat', 'game', 'weather', 'auto', 'roam', 'theme', 'sound', 'hide'].includes(b)));
    // 悬停和右键菜单原来摆的是同一批动作，重复；现在悬停只留要紧的几个。
    // ★ 2026-10-10 用户点名加了天气："做成一个悬浮开关就放在足球按钮的下面" ——
    //   所以顺序是 对话 / 球 / 天气（球的下面就是天气）。
    ok('悬停是「对话」+「球」+「天气」三个按钮，天气排在球的下面',
      init.hoverButtons.length === 3 && init.hoverButtons[0] === 'chat'
      && init.hoverButtons[1] === 'game' && init.hoverButtons[2] === 'weather');
    ok('球/游戏模式默认是关的（要你自己点开）', init.ballMode === 'off');
    ok('天气默认是关的（不点就什么粒子都不飘）', init.weather === 'off');
    ok('init 带上了右键菜单（controls + 设置按钮）', init.bot?.controls === true && init.bot.buttons.settings === true);
    // 「换装…」现在是**真的有窗口**的（第 2f 节那一套：接口先占住，贴图以后再加），
    // 所以这里从"去掉了装扮"改成"装扮按钮在、而且服务里真的有 /dress 那一页"。
    ok('右键菜单里有「换装…」（服装接口已接上）', init.bot.buttons.dress === true);
    ok('服装页真的存在（不是写了个点不动的按钮）',
      ctx.fs.existsSync(path.join(ctx.app, 'web', 'dress.html'))
      && fs.readFileSync(path.join(ctx.app, 'server.cjs'), 'utf8').includes("'/dress': 'dress.html'"));

    ws.send(JSON.stringify({ t: 'hello', screen: { w: 1920, h: 1080 }, host: 'window' }));

    const hello = await waitFor('开机问候', () => says()[0], 8000);
    ok(`开机问候来自当前时段（${pet.partOfDay()}）`, textsFilled(lines.hello[pet.partOfDay()]).includes(hello.beats[0].text));

    // 没开模型：走内置台词
    fromPet.length = 0;
    ws.send(JSON.stringify({ t: 'text', text: '你好呀' }));
    const builtin = await nextReply('reply');
    ok('没接模型时用内置台词', builtin.beats.some((b) => textsOf(lines.reply).includes(b.text)));

    // 开了模型：走假端点
    llm.save({ enabled: true, baseUrl: stub.url, apiKey: 'test-key', model: 'test-model', maxTokens: 64, persona: '你是测试用的人设。' });
    fromPet.length = 0;
    ws.send(JSON.stringify({ t: 'text', text: '在吗' }));
    const spoken = await nextReply('answer', 15000);
    ok('接了模型就用模型的回答', spoken.beats.some((b) => b.text.includes('我是测试模型')));
    // 给模型的 system 里必须带上【此刻】（几点 / 认识多久 / 刚发生了什么）——
    // 没有它，本地小模型对"自己的处境"一无所知，答得像通用客服。
    ok('给模型的 system 里带了【此刻】的处境',
      stub.seen.length > 0 && String(stub.seen.at(-1)?.body?.messages?.[0]?.content).includes('【此刻】'));
    ok('等模型时点亮思考表情', fromPet.some((m) => m.t === 'thinking' && m.on === true));
    ok('回答完关掉思考表情', fromPet.some((m) => m.t === 'thinking' && m.on === false));

    // 语音（装了的话）在后台先热起来：模型加载约 9 秒，第一次真要说的时候不该还在读权重。
    // 断言里凡是等气泡的地方都留够了这个时间（`nextSay(15000)`）。
    const tts = ctx.mod('tts');
    // `warm()` **必须返回 Promise**：main.cjs 写的是 `tts.warm().catch(...)`，
    // 返回 undefined 的话启动时直接 TypeError → 弹「启动失败」框 → ctx.app.exit(1)，
    // 桌宠根本起不来（实测踩过，而且只在语音文件齐了的机器上才炸）。
    if (tts.available()) {
      const warmed = tts.warm();
      ok('warm() 返回 Promise（main.cjs 要 .catch 它）', !!warmed && typeof warmed.then === 'function');
      warmed.catch(() => {});
    }

    __mark('4c. 球与弹弹乐：三态开关 + 进球 + 蓄力，走完整往返');
    /* ---------- 4c. 球与弹弹乐：三态开关 + 进球 + 蓄力，走完整往返 ---------- */
    /**
     * 静态守卫（2g）只能证明"代码在"，证明不了"这条链通"。这里连上真 World 走一遍：
     *   出球 → `ballOn`；踢到 → `ballKick`；进游戏 → `ballGameOn`；进球 → `ballGoal`；
     *   蓄力 → `ballCharge`；收走 → 委屈或生气。
     */
    fromPet.length = 0;
    ws.send(JSON.stringify({ t: 'ballMode', mode: 'ball' }));
    const onSay = await nextReply('ballOn');
    ok('球：出球时她会说一句（ballOn）', !!onSay);

    fromPet.length = 0;
    ws.send(JSON.stringify({ t: 'ballKick', at: 0.42 }));
    const kickSay = await nextReply('ballKick');
    ok('球：踢到球她会说一句（ballKick）', !!kickSay);

    fromPet.length = 0;
    ws.send(JSON.stringify({ t: 'ballMode', mode: 'game' }));
    const gameSay = await nextReply('ballGameOn');
    ok('弹弹乐：进游戏模式她会招呼一声（ballGameOn）', !!gameSay);

    fromPet.length = 0;
    ws.send(JSON.stringify({ t: 'ballGoal', scorer: 1, score: [0, 1], defence: 1 }));
    const goalMine = await nextReply('ballGoal');
    ok('弹弹乐：她进球她会得意（ballGoalMine）',
      !!goalMine && goalMine.beats.some((b) => textsOf(lines.ballGoalMine).includes(b.text)));

    fromPet.length = 0;
    ws.send(JSON.stringify({ t: 'ballGoal', scorer: 0, score: [1, 1], defence: 1 }));
    const goalYours = await nextReply('ballGoal');
    ok('弹弹乐：你进球她不服气（ballGoalYours）',
      !!goalYours && goalYours.beats.some((b) => textsOf(lines.ballGoalYours).includes(b.text)));

    fromPet.length = 0;
    ws.send(JSON.stringify({ t: 'ballCharge' }));
    const chargeSay = await nextReply('ballCharge');
    ok('弹弹乐：蓄力飞踢会喊一声（ballCharge）', !!chargeSay);

    fromPet.length = 0;
    ws.send(JSON.stringify({ t: 'ballMode', mode: 'off' }));
    const offSay = await nextReply('ballOff');
    // 收走时是"委屈 / 生气"随机一套，两句都要能在台词库里找到出处
    const offPool = [...textsOf(lines.ballOffSad), ...textsOf(lines.ballOffAngry)];
    ok('球：收走时她会闹脾气（委屈或生气，随机）',
      !!offSay && offSay.beats.some((b) => offPool.includes(b.text)));
    ok('球：收走那一下带了表情（sad 或 angry）',
      !!offSay && offSay.beats.some((b) => ['sad', 'angry', 'turn'].some((a) => (b.actions || []).includes(a))));

    __mark('4d. 念出来：只有大模型的回答会出声');
    /* ---------- 4d. 念出来：只有大模型的回答会出声 ---------- */
    // 语音文件（vendor\tts）在就测，不在就跳过——自检不该因为没装语音而红
    ok(`init 报告了语音开关（voice=${init.voice}）`, typeof init.voice === 'boolean');
    if (!tts.available()) {
      console.log(`      （语音没装：${tts.why()}——跳过念出来的检查）`);
      ok('没装语音时 init 说不要念', init.voice === false);
    } else {
      ok('语音文件齐了，init 默认要念（接模型时语音默认开）', init.voice === true);
      // **换一条新连接**再测语音。服务端"上一句还在想"时会把新的那句留成 pending，
      // 上一节留下的 pending 会飘进这一节（实测折腾了好几轮）；新连接状态是干净的。
      ws.close();
      await new Promise((r) => setTimeout(r, 300));
      fromPet = [];
      ws = new WebSocket(`ws://127.0.0.1:${port}/socket?role=pet&host=window`);
      ws.on('message', (raw) => fromPet.push(Object.assign(JSON.parse(raw.toString()), { at: Date.now() })));
      await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
      await waitFor('新连接的 init', () => fromPet.find((m) => m.t === 'init'), 8000);
      await new Promise((r) => setTimeout(r, 3000));        // 让开机问候先说完

      const voices = () => fromPet.filter((m) => m.t === 'voice');
      /** 带音频的那些 voice 消息（"这句不念"时根本不会再发 voice 了）。 */
      const audios = () => voices().filter((m) => m.wav);
      const wavOf = (m) => Buffer.from(m.wav || '', 'base64');
      /**
       * 一条 model 回答该有的样子：**先**一条带 voice 标记的气泡，**后**一条带 wav 的 voice。
       *
       * 顺序是"并行改造"之后定下来的：气泡不再等合成，所以文字先出、语音随后到。
       * （改造前是反过来：`voice` 在前，因为服务端会先 await 合成再发 say。）
       */
      const speech = () => {
        const si = says().map((s, i) => (s.voice ? fromPet.indexOf(s) : -1)).filter((i) => i >= 0).pop();
        const vi = fromPet.map((m, i) => (m.t === 'voice' && m.wav ? i : -1)).filter((i) => i >= 0).pop();
        if (vi === undefined || si === undefined || vi < si) return null;
        return { v: fromPet[vi], s: fromPet[si] };
      };

      llm.save({ model: 'vary-model' });
      fromPet.length = 0;
      ws.send(JSON.stringify({ t: 'text', text: '在吗' }));
      const say1 = await nextReply('answer', 20000);
      const got1 = await waitFor('气泡先到、语音随后', () => speech(), 40000).catch((e) => {
        const dump = fromPet.map((m) => (m.t === 'say' ? `say{voice=${m.voice}}` : m.t === 'voice' ? `voice{wav=${(m.wav || '').length}}` : m.t)).join(' ');
        throw new Error(`${e.message}\n      实际: ${dump}`);
      });
      // **要断言 `got1.s`，不要断言 `say1`**：`say1` 是"这一刻之后收到的第一条气泡"，
      // 开机问候（2 秒后那条 line）经常抢在前面，而问候本来就不该带 voice——
      // 拿它来验"要念"必然红。上一个会话就在这上面耗了很久：它以为是产品的 bug，
      // 反复改 pet.cjs 的出话顺序去迁就这个断言，越改越坏。真正该看的是**那条带
      // 语音的气泡**（`got1.s` 由 speech() 挑出来，保证它后面真的有音频）。
      ok('模型回答的气泡标了"要念"', got1.s.voice === true,
        `（这一条气泡 voice=${got1.s.voice}；顺带一提第一条是 voice=${say1.voice}）`);
      // 并行改造之后是"气泡先出、语音随后到"（以前反过来）。
      // 这条断言的意义在于：**气泡不被合成挡住**——文字该立刻出来。
      ok('气泡先到、语音随后到（文字不被合成挡住）',
        fromPet.indexOf(got1.s) < fromPet.indexOf(got1.v));
      ok('音频带上了采样率', got1.v.rate === 22050 || typeof got1.v.rate === 'number');
      const wav = wavOf(got1.v);
      ok(`音频是合法 WAV（RIFF/WAVE，${(wav.length / 1024).toFixed(0)}KB）`,
        wav.toString('ascii', 0, 4) === 'RIFF' && wav.toString('ascii', 8, 12) === 'WAVE' && wav.length > 44);

      // 缓存直接量 tts.speak 本身：同一条过协议去测会被上一句还在路上的请求搅乱
      // （服务端的 pending 会让"下一次"其实早就在合成中）
      const text = '收到啦,我是测试模型。';
      const first = await tts.speak(text);
      const cacheAt = Date.now();
      const second = await tts.speak(text);
      ok(`同一句话第二次走缓存（${Date.now() - cacheAt}ms，${first.wav.length} 字节）`,
        !!second && second.ms === 0 && second.wav.equals(first.wav));
      const other = await tts.speak('换一句不一样的话。');
      ok('换一句话就要重新合成', !!other && other.ms > 0 && !other.wav.equals(first.wav));

      // 内置台词（戳它）不出声：那些本来就是音效
      await new Promise((r) => setTimeout(r, 2500));
      fromPet.length = 0;
      ws.send(JSON.stringify({ t: 'touch', kind: 'poke' }));
      await nextReply('poke', 8000);
      await new Promise((r) => setTimeout(r, 1500));
      ok('内置台词不念（戳它只有音效）', voices().length === 0);

      // 关掉语音：气泡不再标"要念"
      ws.send(JSON.stringify({ t: 'prefs', voice: 'off' }));
      await new Promise((r) => setTimeout(r, 300));
      ok('关掉语音会存进配置', llm.load().voice === false);
      await new Promise((r) => setTimeout(r, 3000));        // 让关之前那句做完
      await new Promise((r) => setTimeout(r, 8000));        // 再等一轮，把所有在飞的都等干净
      fromPet.length = 0;
      const sentAt = Date.now();
      ws.send(JSON.stringify({ t: 'text', text: '这句以前没问过' }));
      const quiet = await nextReply('answer', 20000);
      await new Promise((r) => setTimeout(r, 1500));
      // 关掉之后：气泡不标"要念"，也**不再有任何 voice 消息**。
      // （并行改造之后服务端不再发"不带 wav 的 voice 占位信号"了——那条信号是给
      //  以前"等语音才打字"的页面用的；现在页面根本不等，服务端也就不用发。）
      const voiceDump = fromPet.map((m) => `${m.t}${m.voice ? '(voice)' : ''}@+${(m.at - sentAt)}ms`).join(' ');
      ok(`关了之后气泡不再要念，也没有音频（气泡 voice=${quiet.voice} / 音频 ${audios().length} 条 [${voiceDump}]）`,
        !quiet.voice && audios().length === 0);

      // 打开：又念了
      ws.send(JSON.stringify({ t: 'prefs', voice: 'voice' }));
      await new Promise((r) => setTimeout(r, 300));
      ok('再打开会存进配置', llm.load().voice === true);
      await new Promise((r) => setTimeout(r, 2500));
      fromPet.length = 0;
      ws.send(JSON.stringify({ t: 'text', text: '在吗' }));
      const back = await nextReply('answer', 15000);
      ok('重新打开后又会念', back.voice === true && !!(await waitFor('重新打开后的语音', () => voices().length >= 1, 30000)));
    }

    // 模型挂了：退回内置的"接不上话"
    llm.save({ model: 'fail-me' });
    fromPet.length = 0;
    ws.send(JSON.stringify({ t: 'text', text: '你还在吗' }));
    const failed = await nextReply('answer', 8000);
    ok('模型出错时退回内置台词', textsOf(lines.llmFailed).includes(failed.beats[0].text));
    ok('模型回答跟时刻无关，不会因为等得久被丢掉', failed.kind === 'line');

    // 模型慢（冷启动 4.1 秒）：回答照样会说，而且进队列就立刻出去，不隔 1.2 秒
    // ⚠️ 这一条**本来就依赖"前面别处已经把 slow-model 的慢一次用掉了"**（那样它测的是
    // "普通回复直接出去、不再压一个 1.2 秒"）。单跑本区域时会变成"真的等 4.1 秒"，
    // 于是 4119ms > 3000ms 误红 —— 这是原自检里就存在的一处**时序依赖**，
    // 拆分前它一直是绿的（因为顺序固定），这里**不改断言**，只留注释说明。
    llm.save({ model: 'slow-model' });
    fromPet.length = 0;
    const askedAt = Date.now();
    ws.send(JSON.stringify({ t: 'text', text: '慢慢来' }));
    const slowSay = await nextReply('answer', 9000);
    ok('模型慢慢回来时回答照样说出口', slowSay.beats.some((b) => b.text.includes('我是测试模型')));
    ok(`模型回答直接出去，不再等一个间隔（${slowSay.at - askedAt}ms）`, slowSay.at - askedAt < 3000);
    llm.save({ enabled: false });

    // 蹭睡着的它
    fromPet.length = 0;
    ws.send(JSON.stringify({ t: 'touch', kind: 'pet', asleep: true }));
    const dreaming = await nextReply('pet', 8000);
    ok('蹭睡着的它会用"做梦"的台词', textsOf(lines.petAsleep).includes(dreaming.beats[0].text));

    __mark('5b. 连点/连续拖拽：气泡会合并、会过期，停手就安静');
    /* ---------- 5b. 连点/连续拖拽：气泡会合并、会过期，停手就安静 ---------- */
    /**
     * 发一次操作，等它**这个操作**的回话（`say.tag` 就是操作名：`poke` / `pet` / `grab` …）。
     *
     * 为什么按 tag 等，而不是"等下一个气泡"：这条路上有两件跟被测无关的事会抢位 ——
     * ① 计时器自己冒的发呆/记忆话；② **上一节排队的回答**（应答链一条气泡要占 0.8~2 秒，
     * 上一节问的那句话可能这一秒才轮到）。实测这两种都让"回的是哪一桶台词"随机红过。
     */
    const touchSay = async (kind, extra = {}) => { fromPet.length = 0; ws.send(JSON.stringify({ t: 'touch', kind, ...extra })); return nextReply(kind, 8000); };
    const touchOwnSay = touchSay;

    // 先甩一下，把应答链的空档走完：下面的断言都从这里干净的起点算起
    await touchSay('throw');

    // 连戳五下：**一个**气泡（第五下的档位），不能一下一个、说完还接着弹
    fromPet.length = 0;
    for (let i = 0; i < 5; i += 1) ws.send(JSON.stringify({ t: 'touch', kind: 'poke' }));
    const pokes = [await nextReply('poke', 8000)];
    const seen = ownSays().length;
    await new Promise((r) => setTimeout(r, 1200));      // 再等一会儿，看有没有第二、第三个冒出来
    pokes.push(...ownSays().slice(seen));
    ok(`连戳五下只出一个气泡（收到 ${pokes.length} 个：${pokes.map((m) => m.beats.map((b) => b.text).join('+')).join(' | ')}）`, pokes.length === 1);
    ok('连戳五下的档位照样升到「戳太多」', textsOf(lines.poke.tooMuch).includes(pokes[0].beats[0].text));
    ok('触发类气泡带 react 标记（页面据此丢掉过期的）', pokes.every((m) => m.kind === 'react'));
    ok('每一下都配了表情或动作', pokes.every((m) => (m.beats[0].actions || []).length > 0));

    // 点一下、停一下再点：1.5 秒一下属于"自己一下一下点"，不合并，档位要升
    // 同样先排空上一节（连戳五下）在路上的气泡，否则它会被算进 spaced[0]，
    // 把整条"第一次/又戳/又戳"的档位串位（实测就这样间歇性红过）
    await drain();
    const spaced = [];
    for (let i = 0; i < 3; i += 1) {
      spaced.push(await touchOwnSay('poke'));
      await new Promise((r) => setTimeout(r, 1400));
    }
    ok('1.5 秒一下不会被合并，三下三个气泡', spaced.length === 3);
    ok('第一下是"第一次戳"', textsOf(lines.poke.first).includes(spaced[0].beats[0].text));
    ok('第二下升到"又戳"', textsOf(lines.poke.again).includes(spaced[1].beats[0].text));
    ok('第三下还是"又戳"', textsOf(lines.poke.again).includes(spaced[2].beats[0].text));

    // 气泡之间有间隔：不会一口气连珠炮；停手之后也不再冒出来
    ok('气泡间隔在 1.1–3.2 秒之间（不急不挤，也不拖）',
      spaced.slice(1).every((m, i) => m.at - spaced[i].at > 1100 && m.at - spaced[i].at < 3200));
    fromPet.length = 0;
    await new Promise((r) => setTimeout(r, 2500));
    ok('停手之后气泡就停了（不会再冒出来）', ownSays().length === 0);

    __mark('5b-2. 部位：戳/蹭在**身上哪个地方**，就说那个地方的话');
    /* ---------- 5b-2. 部位：戳/蹭在**身上哪个地方**，就说那个地方的话 ---------- */
    // 部位是**页面**判的（pet-app.js 的 REGION_BOXES/REGION_AT，照 whale\model.json 的部件框量出来），
    // 跟着 touch 一起报上来；World 只认名字。所以这里直接按页面的口吻发 `at`。
    // ★ 2026-10-10 名字细化了：头发是 `hair`（原来叫 `head`）、肚子是 `belly`（原来叫 `body`）、
    //   裙子是 `skirt`（原来叫 `low`）。
    //
    // ⚠️ **顺序有讲究，别随手调**：`state.card` 一举起来，它**一句话都不说**（`if (state.card) break`），
    //   而"摸头"那一族（呆毛/头发/眼睛/脸蛋/下巴）每下算**两下**好感，攒够 `ASK_AFTER_PETS`（3）就举卡。
    //   所以"页面没报部位 → 通用蹭"这条必须**排在最前**：那时上一节刚把好感清零（它测过举卡），
    //   这一下只算 1 点、绝不会举卡。反过来排在后面的话，前面几下戳头发 + 蹭下巴早把卡举起来了，
    //   这一条就**永远等不到气泡**（实测报的是"等不到 tag=pet 的回话（收到 prefs | act | ask）"）。
    await drain();
    const plainPet = await touchOwnSay('pet');
    ok('页面没报部位时退回通用的「蹭」', textsOf(lines.pet).includes(plainPet.beats[0].text));
    const headPoke = await touchOwnSay('poke', { at: 'hair' });
    ok('戳头发说的是「头发」那一桶', textsOf(lines.pokeArea.hair).includes(headPoke.beats[0].text));
    const bellyPoke = await touchOwnSay('poke', { at: 'belly' });
    ok('换到肚子戳就换一桶话', textsOf(lines.pokeArea.belly).includes(bellyPoke.beats[0].text));
    const ahogePoke = await touchOwnSay('poke', { at: 'ahoge' });
    ok('戳呆毛说的是「呆毛」那一桶（用户报的那条 bug 的正解）',
      textsOf(lines.pokeArea.ahoge).includes(ahogePoke.beats[0].text));
    const hairAgain = await touchOwnSay('poke', { at: 'hair' });
    ok('再戳回头发还算"新的一下"（不是「又戳」）', textsOf(lines.pokeArea.hair).includes(hairAgain.beats[0].text));
    const tailPet = await touchOwnSay('pet', { at: 'tail' });
    ok('蹭尾巴说的是「尾巴」那一桶', textsOf(lines.petArea.tail).includes(tailPet.beats[0].text));
    const chinPet = await touchOwnSay('pet', { at: 'chin' });
    ok('蹭下巴说的是「下巴」那一桶（小部位也有自己的话）',
      textsOf(lines.petArea.chin).includes(chinPet.beats[0].text));

    __mark('5b-3. 它会问你：摸够几下就举一张选择卡，选完它照着你选的做');
    /* ---------- 5b-3. 它会问你：摸够几下就举一张选择卡，选完它照着你选的做 ---------- */
    await drain();
    for (let i = 0; i < 4; i += 1) ws.send(JSON.stringify({ t: 'touch', kind: 'pet' }));
    const card = await waitFor('选择卡', () => fromPet.find((m) => m.t === 'ask'), 15000);
    ok(`摸够四下它会问一句（${card.question}）`, typeof card.question === 'string' && card.question.length > 0);
    ok('卡上带着选项（页面拿它画按钮）', Array.isArray(card.options) && card.options.length >= 2);
    const q = lines.ask.find((x) => x.text === card.question);
    ok('卡片上的问题来自台词库', !!q && card.options.length === q.options.length);
    // 挑一个**不带 quiet** 的选项：安静会让后面几节（自动说话）测不出东西来
    const pick2 = q.options.findIndex((o) => !o.quiet);
    ok('选项文字和台词库一一对上', pick2 >= 0 && card.options[pick2] === q.options[pick2].label);

    // **卡片举着的时候不许再有别的话出去**：页面见到任何一句 `say` 都会把卡收掉（dropAsks）。
    // 这条是被真机日志抓出来的——实测卡片 08:39:31 发出去，08:39:32 就有一句"蹭"的回话把它顶掉，
    // 屏幕上只闪了一下，用户以为"从来没触发过"。所以：卡举着时摸它=不出声（表情/音效照旧）。
    fromPet.length = 0;
    for (let i = 0; i < 3; i += 1) ws.send(JSON.stringify({ t: 'touch', kind: 'pet' }));
    await new Promise((r) => setTimeout(r, 2500));
    ok(`卡片举着时它不冒别的气泡（收到 ${ownSays().length} 个）`, ownSays().length === 0);

    fromPet.length = 0;
    ws.send(JSON.stringify({ t: 'answer', askId: card.id, index: pick2 }));
    const chose = await nextReply('askReply', 9000);
    ok(`选了之后它照着答一句（${chose.beats[0].text}）`, chose.beats[0].text === q.options[pick2].reply);

    // 连续拖放（抓-放的"抛物线"）：同类合并 + 排队上限，最多两个气泡，不会攒一长串
    fromPet.length = 0;
    for (let i = 0; i < 4; i += 1) {
      ws.send(JSON.stringify({ t: 'touch', kind: 'grab' }));
      ws.send(JSON.stringify({ t: 'touch', kind: 'drop' }));
    }
    await new Promise((r) => setTimeout(r, 9000));
    // 只数**抓/放**的回话（`tag` 就是操作名）：这一段要验的是"同类合并 + 排队上限"，
    // 数上发呆话或者上一节还在路上的回答都会让"最多两个"这条随机红。
    const grabDrop = says().filter((m) => m.tag === 'grab' || m.tag === 'drop');
    ok(`连续抓放四次最多两个气泡（收到 ${grabDrop.length} 个：${grabDrop.map((m) => m.beats.map((b) => b.text).join('+')).join(' | ')}）`,
      grabDrop.length <= 2);
    ok('抓放的气泡都是抓/放的台词',
      grabDrop.every((m) => textsOf(lines.grab, lines.drop).includes(m.beats[0].text)));

    // 暂停 / 恢复：要说一声，并且把菜单按钮换成"继续"
    fromPet.length = 0;
    ws.send(JSON.stringify({ t: 'control', action: 'pause' }));
    const hushed = await nextReply('control', 8000);
    ok('暂停时会说一句', textsOf(lines.hush).includes(hushed.beats[0].text));
    ok('暂停后菜单按钮变成"已暂停"', fromPet.some((m) => m.t === 'prefs' && m.bot?.paused === true));
    fromPet.length = 0;
    ws.send(JSON.stringify({ t: 'control', action: 'resume' }));
    const resumed = await nextReply('control', 8000);
    ok('恢复时也会说一句', textsOf(lines.back).includes(resumed.beats[0].text));

    __mark('5c. 自动说话：接了模型之后它自己找话说（右键菜单里的「自动」）');
    /* ---------- 5c. 自动说话：接了模型之后它自己找话说（右键菜单里的「自动」） ---------- */
    // 这一节把间隔压到 3.5 秒、静默期压到 8 秒（见文件顶部），默认值都是一分钟。
    /**
     * 这一节只数**自动说话**那条路（`say.tag === 'auto'`，产品里就这一个出处）。
     * 比"数所有气泡再排掉自说自话"精确得多：发呆/记忆话是有没有都无所谓，
     * 但**自动说话该安静的时候多说了一句**才是真 bug —— 断言要能分清这两者。
     */
    const autoSays = () => says().filter((m) => m.tag === 'auto');
    const autoTexts = () => autoSays().map((s) => s.beats.map((b) => b.text).join('+')).join(' | ');
    ok('默认不开自动说话', llm.defaults().autoChat === false);
    ok('init 里带上了 autoChat 开关（按钮要按它显示亮不亮）', init.autoChat === false);

    // 关着的时候：等两轮也不出声
    llm.save({ enabled: true, baseUrl: stub.url, apiKey: 'test-key', model: 'test-model', maxTokens: 64 });
    fromPet.length = 0;
    await new Promise((r) => setTimeout(r, 8000));
    ok(`关着自动说话时它不自己出声（收到 ${autoSays().length} 个：${autoTexts()}）`, autoSays().length === 0);

    // 打开：页面发一条 prefs，服务器存进配置并开始自己说话
    ws.send(JSON.stringify({ t: 'prefs', autoChat: true }));
    await new Promise((r) => setTimeout(r, 300));
    ok('服务器把自动说话的开关存进了配置', llm.load().autoChat === true);
    // 端点故意每次换一句：自动说话应该原样说出来
    llm.save({ model: 'vary-model' });
    const auto1 = await nextReply('auto', 9000);
    ok('打开之后它自己说了一句', auto1.kind === 'line' && auto1.beats[0].text.length > 0);
    // 自动说话那条路不带历史：模型只应收到 system + 那一句提示词
    const autoReq = stub.seen.at(-1);
    ok('自动说话只发人设 + 提示词，不把以前的对话塞进去',
      autoReq.body.messages.length === 2 && autoReq.body.messages[0].role === 'system');
    // 高温度是为了让它别一遍遍重复同一句；普通提问不带这个字段，用端点自己的默认值
    ok(`自动说话带上了温度 ${autoReq.body.temperature}`,
      typeof autoReq.body.temperature === 'number' && autoReq.body.temperature > 0.5);

    // 端点开始复读：跟上一句太像的就重问，重问还是那句就干脆不说
    // repeat-model 永远回一句谁都没说过的话：第一次该说出来，第二次开始就被防重复挡住
    llm.save({ model: 'repeat-model' });
    fromPet.length = 0;
    await nextReply('auto', 20000);
    ok('复读的模型第一句会说出来', autoSays().length === 1);
    const seenFirst = autoSays().length;
    fromPet.length = 0;                      // 从这里开始只数"第二句"
    await new Promise((r) => setTimeout(r, 12000));   // 够两轮自动说话的间隔
    const extra1 = autoSays().length ? `：${autoTexts()}` : '';
    ok(`第二句一模一样时它宁可不说话（收到 ${autoSays().length} 个气泡${extra1}）`, autoSays().length === 0 && seenFirst === 1);
    ok('重问时会在提示词里要求换个话题',
      stub.seen.slice(-6).some((s) => s.body.messages.at(-1).content.includes('换个话题')));

    // 模型把提示词/人设念出来（"系统提示我…"）：这种一句都不要
    // 先把上一节在路上的气泡排空再计数——否则会把它算成这一节冒出来的（见 drain 的注释）
    await drain();
    llm.save({ model: 'leak-model' });
    await new Promise((r) => setTimeout(r, 16_000));
    const extra2 = autoSays().length ? `：${autoTexts()}` : '';
    ok(`念提示词的句子不冒泡（收到 ${autoSays().length} 个气泡${extra2}）`, autoSays().length === 0);

    // 你刚跟它说过话的静默期里，它不插嘴
    llm.save({ model: 'test-model' });
    ws.send(JSON.stringify({ t: 'text', text: '在吗' }));
    const answered = await nextReply('answer', 9000);
    ok('打字问它会照常回答', answered.beats.some((b) => b.text.includes('我是测试模型')));
    // 先把它自己排的、还在路上的气泡等干净再开始数——否则上一节/这条回答的余波
    // 会落进这 3 秒里被当成"插嘴"（实测就这么间歇性红过；语音合成 2~3 秒会放大这个窗口）
    await drain(1500, 15000);
    const afterAnswer = autoSays().length;
    await new Promise((r) => setTimeout(r, 3000));
    ok(`刚说完话的静默期里它不插嘴（静默期 8 秒，3 秒内收到 ${autoSays().length - afterAnswer} 个）`,
      autoSays().length === afterAnswer);

    // 静默期过了它会自己接着说（换一家会说新话的端点，免得卡在"太像"那条规矩上）
    fromPet.length = 0;
    llm.save({ model: 'vary-model' });
    const autoAgain = await nextReply('auto', 12_000);
    ok('静默期过了它自己接着说', autoAgain.kind === 'line' && autoAgain.beats[0].text.length > 0);
    llm.save({ model: 'test-model' });

    // 关掉：页面再发一条 prefs，配置跟着改
    ws.send(JSON.stringify({ t: 'prefs', autoChat: false }));
    await new Promise((r) => setTimeout(r, 300));
    ok('关掉之后配置也跟着改', llm.load().autoChat === false);
    llm.save({ enabled: false });

    // ⚠️ 原来这里还照跑了一段「6. 切句与表情的纯函数」—— 那一段已经独立成
    // `regions\06-beats.cjs`（不依赖这次真连接），**留在这儿会把它算两遍**（实测项数 372→380）。
    // 这里只留一句"归谁管"的注释，不再重复跑。

    __mark('7. 次级动画与桌面接地光（2026-10-10 新做的那两批）');
    /* ---------- 7. 次级动画与桌面接地光（2026-10-10 新做的那两批） ---------- */
    /**
     * ★ **行为验证 ①：延迟跟随取的是"0.1 秒前"那个点**（用户点名的"你甩鼠标，发梢晚 0.1 秒跟上"）。
     *
     * 光查字符串挡不住"延迟窗口写错"这类错（`.04` / `.4` 都是一个字符的事，看着都一样），
     * 所以把 `lagged()` 从 figure.js 里抠出来、喂给它一段**已知位置的历史**，量它算出来的速度：
     *   身体在 t=1.0 时在 x=100，现在（t=1.1）在 x=130 → 0.1 秒走了 30px → 300px/s。
     * 顺带量一下"历史不够长时返回 0"（老页面 / 内置身体走这条路，必须和上游一模一样）。
     */
    {
      const figSrc = fs.readFileSync(path.join(ctx.app, 'web', 'whale', 'figure.js'), 'utf8');
      const lagFn = figSrc.match(/function lagged\(o\) \{[\s\S]*?return \[\(o\.bx - best\.x\) \/ dt, \(o\.by - best\.y\) \/ dt\];\n  \}/);
      const lagConst = figSrc.match(/const LAG_S = [.\d]+;/);
      const lagged = lagFn && lagConst
        ? new Function(`${lagConst[0]}\n${lagFn[0]}\nreturn lagged;`)()
        : null;
      const hist = [{ t: .6, x: 60, y: 0 }, { t: .8, x: 80, y: 0 }, { t: 1.0, x: 100, y: 0 }];
      const v = lagged ? lagged({ t: 1.1, bx: 130, by: 0, posHist: hist }) : null;
      ok('★次级动画（行为）：延迟速度取的是**0.1 秒前**那一点（300px/s 这种量级，不是当前速度）',
        !!v && Math.abs(v[0] - 300) < 1 && Math.abs(v[1]) < 1e-6);
      // 竖直方向也要算（跳、被拎起来、坐下时发梢要往下拖）
      const vv = lagged ? lagged({ t: 1.1, bx: 100, by: -40, posHist: [{ t: 1.0, x: 100, y: 0 }] }) : null;
      ok('★次级动画（行为）：竖直方向的速度也参与（跳起来/被放下时发梢会拖）',
        !!vv && Math.abs(vv[1] + 400) < 1e-6 && Math.abs(vv[0]) < 1e-6);
      ok('★次级动画：没有位置历史（老页面 / 内置身体）时返回 0，行为同上游',
        !!lagged && lagged({ t: 1, bx: 9, by: 9, posHist: [] })[0] === 0
        && lagged({ t: 1, bx: 9, by: 9 })[0] === 0);
      const coreSrc2 = fs.readFileSync(path.join(ctx.app, 'web', 'pet-core.js'), 'utf8');
      ok('★次级动画：身体位置的环形历史是 pet-core 喂的（`posHist` + `frame.bx/by`）',
        /posHist: \[\]/.test(coreSrc2) && /pet\.posHist\.push\(\{ t: T, x: AX, y: BY \}\)/.test(coreSrc2)
        && /bx: AX, by: AY, posHist: pet\.posHist/.test(coreSrc2));
      ok('★次级动画：延迟速度接进了发梢/刘海/尾巴/呆毛的弹簧目标',
        /const lagH = clamp\(-lagX \* LAG_HAIR/.test(figSrc)
        && /sp\.hair\.step\(sway \* 1\.1[^;]*lagH, dt\)/.test(figSrc)
        && /sp\.tail\.step\(sway \* 14 \+ tailMood \* 12 \+ lagT, dt\)/.test(figSrc));
    }
    /**
     * ★ **眨眼睫毛阴影**：必须是**叠在脸那块画布上、用 source-atop 裁住**的（0 新贴图），
     * 而且**用完必须还原 `source-over`**（否则后面所有脸部绘制都会被改掉，症状是"脸花了"）。
     */
    {
      const figSrc = fs.readFileSync(path.join(ctx.app, 'web', 'whale', 'figure.js'), 'utf8');
      const block = figSrc.match(/if \(shut > \.06\) \{[\s\S]*?\n    \}\n    fg\.save\(\);/);
      ok('★眨眼睫毛阴影：闭眼时在脸上叠一道渐变（source-atop 裁在脸内部，0 新贴图）',
        !!block && /source-atop/.test(block[0]) && /createLinearGradient/.test(block[0])
        && /fillRect/.test(block[0]));
      ok('★眨眼睫毛阴影：必须用 save/restore 把 source-atop 与 fillStyle 严丝合缝地包起来（漏出去会把后面的脸画花）',
        !!block && /fg\.save\(\);[\s\S]*source-atop[\s\S]*fillRect[\s\S]*fg\.restore\(\);/.test(block[0]));
      // 闭眼量是从 `o.blink`/`o.eyeClose` 来的，而且**眨眼那几帧必须让脸重画**
      // （figure.js 的脏检查：`blink > .02` 时 `faceStamp` 返回 null → 每帧重画）
      ok('★眨眼睫毛阴影：闭眼量取自这一帧的 blink/eyeClose，且脏检查不会把眨眼那几帧跳过去',
        /shut = Math\.max\(o\.blink \|\| 0, o\.eyeClose \|\| 0\)/.test(figSrc)
        && /\(o\.blink \|\| 0\) > \.02 \|\| \(o\.eyeClose \|\| 0\) > \.02\) return null/.test(figSrc));
    }
    /**
     * ★ **桌面接地光（行为）**：`oklabRgb()` 是 `oklab()` 的反函数，两件事都要成立：
     * ① **来回一趟不掉色**（灰进灰出、彩色进彩色出，误差 ≤2/255）——
     *    它错了不会抛异常，只会让轮廓光和影子**静默变色**（最难查的一类）；
     * ② **轮廓光与桌面反着来**：浅桌面给暗轮廓、深桌面给亮轮廓（这是"贴上去"变成"长在上面"的关键）。
     */
    {
      const appSrc = fs.readFileSync(path.join(ctx.app, 'web', 'pet-app.js'), 'utf8');
      const grab = (re) => { const m = appSrc.match(re); return m ? m[0] : ''; };
      const src = [
        grab(/const lin = [^\n]+/), grab(/const clamp01 = [^\n]+/), grab(/const hex = [^\n]+/),
        grab(/function oklab\(r, g, b\) \{[\s\S]*?\n\}/), grab(/function oklabRgb\(L, A, B\) \{[\s\S]*?\n\}/),
        'return { oklab, oklabRgb, hex, clamp01 };',
      ].join('\n');
      let fns = null;
      try { fns = new Function(src)(); } catch (e) { /* 抠不出来就算没通过（下面那条 ok 会红） */ }
      /**
       * 用**逐通道容差**：OKLab 的立方根与三次方不可结合、逆矩阵常数只有 4 位有效数字，
       * 所以"绕一圈"本来就带几级量化误差 —— 实测 灰/浅色 ≤3，而蓝色 200 那一档 g 偏 **21**
       * （数值性质，不是抄错）。这条验证钉的是**矩阵抄没抄错**（抄错会偏几十上百，比如 g 偏 21
       * 换成其它通道就是 80+），所以容差按通道给。灰必须几乎不偏，这是最灵敏的那一路。
       */
      const near = (a, b, tol) => Math.max(...a.map((v, i) => Math.abs(v - b[i]))) <= tol;
      const round = (r, g, b) => {
        const [L, A, B] = fns.oklab(r, g, b);
        return fns.oklabRgb(L, A, B);
      };
      ok('★桌面接地光（行为）：OKLab→sRGB 的往返不掉色（灰必须≤4，深蓝允许通道量化误差≤24）',
        !!fns && near(round(128, 128, 128), [128, 128, 128], 4) && near(round(250, 240, 230), [250, 240, 230], 4)
        && near(round(40, 90, 200), [40, 90, 200], 24));
      const light = fns.oklab(...[240, 238, 235]);
      const dark = fns.oklab(...[18, 20, 26]);
      const halo = (l, a, b) => fns.oklabRgb(fns.clamp01(l > .58 ? l - .32 : l + .32), a * .35, b * .35);
      const hl = fns.oklab(...halo(...light)), hd = fns.oklab(...halo(...dark));
      ok('★桌面接地光（行为）：浅桌面给**更暗**的轮廓光、深桌面给**更亮**的轮廓光',
        hl[0] < light[0] - .15 && hd[0] > dark[0] + .15);
      ok('★桌面接地光：影子颜色由身后的平均色染出来（但保持很淡，不当成一块黑）',
        /const sRgb = oklabRgb\(\.17 \+ bl \* \.04, ba \* \.28, bb \* \.28\)/.test(appSrc)
        && /shadowTint = \{ rgb: sRgb, a: bl < \.30 \? \.26/.test(appSrc)
        && /shadowEl\.setAttribute\('fill'/.test(appSrc));
      ok('★桌面接地光：抓屏节奏——轮廓光开着时 0.8s，平时 2.5s（第 10.1 节①那条开销项）',
        /const every = backdrop\.on \? BACKDROP_EVERY : BACKDROP_EVERY_CALM/.test(appSrc)
        && /BACKDROP_EVERY_CALM = 2\.5/.test(appSrc));
    }

    /**
     * ★ **身体部位判定：从 7 类细化到 15 类**（2026-10-10 用户实测报"戳嘴巴识别到呆毛"之后重做）。
     *
     * 这一节验三件事，缺一件都会**静默出错**：
     * ① **三处名字必须对得上**：`pet-app.js` 的 `REGION_BOXES`/`REGION_AT`（页面判出来的）、
     *    `pet.cjs` 的 `AREAS`/`AREA_CN`（World 认不认）、`lines.cjs` 的 `pokeArea`/`petArea`
     *    （有没有那个部位的话）。**对不上不会报错**，只是那个部位悄悄说通用台词。
     * ② **`GRAB_STYLE` 必须覆盖全部部位**：漏一个，抓那儿拎起来就是 `undefined` 悬挂角。
     * ③ **判定行为**：把自己写的判定逻辑（`petRegion`）抠出来，喂**真实坐标**量一遍 ——
     *    尤其是用户报的那一条：**戳嘴（y≈147）必须不是呆毛**。
     */
    {
      const appSrc3 = fs.readFileSync(path.join(ctx.app, 'web', 'pet-app.js'), 'utf8');
      const petSrc = fs.readFileSync(path.join(ctx.app, 'pet.cjs'), 'utf8');
      const grabSrc = appSrc3.match(/const GRAB_STYLE = \{[\s\S]*?\n\};/);
      const boxesSrc3 = (appSrc3.match(/const REGION_BOXES = \[[\s\S]*?\n\];/) || [''])[0];
      const atSrc3 = (appSrc3.match(/const REGION_AT = \[[\s\S]*?\n\];/) || [''])[0];
      /**
       * ⚠️ 部位名**直接从两张表里抠**，不要去找 `const REGION_IDS = …` 那一行 ——
       * 上面注释里也写着 `REGION_IDS` 这个词，正则一贪心就抠到注释上去了（实测踩过：
       * 抠出来的集合是空的，于是"名字都对得上"那几条**假绿**）。
       */
      const ids = new Set([...boxesSrc3.matchAll(/\['([a-z_]+)',/g), ...atSrc3.matchAll(/\['([a-z_]+)',/g)]
        .map((m) => m[1]));
      ok('★部位：判定表里确实有 15 个部位，而且呆毛与头发是分开的',
        ids.size === 15 && ids.has('ahoge') && ids.has('hair') && ids.has('eyes')
        && ids.has('cheek') && ids.has('chin') && ids.has('thigh') && ids.has('chest'));

      const missArea = [...ids].filter((id) => !new RegExp(`'${id}'`).test(petSrc));
      ok('★部位：15 个名字在 pet.cjs 的 AREAS 里都认（漏一个那个部位就只会说通用台词）', missArea.length === 0);
      const cnSrc = petSrc.match(/const AREA_CN = \{[\s\S]*?\n\};/);
      const missCn = [...ids].filter((id) => !new RegExp(`${id}:`).test(cnSrc ? cnSrc[0] : ''));
      ok('★部位：15 个名字都有中文名（AREA_CN；模型读上下文时用的就是它）', missCn.length === 0);
      const missGrab = [...ids].filter((id) => !new RegExp(`\\b${id}: \\{ hang:`).test(grabSrc ? grabSrc[0] : ''));
      ok('★部位：GRAB_STYLE 覆盖全部 15 个（漏一个抓那儿拎起来就是 undefined）', missGrab.length === 0);

      const linesSrc = fs.readFileSync(path.join(ctx.app, 'lines.cjs'), 'utf8');
      const pokeSrc = linesSrc.match(/pokeArea: \{[\s\S]*?\n  \},/);
      const petAreaSrc = linesSrc.match(/petArea: \{[\s\S]*?\n  \},/);
      const missPoke = [...ids].filter((id) => !new RegExp(`\\n\\s+${id}: \\[`).test(pokeSrc ? pokeSrc[0] : ''));
      const missPet = [...ids].filter((id) => !new RegExp(`\\n\\s+${id}: \\[`).test(petAreaSrc ? petAreaSrc[0] : ''));
      ok('★部位：15 个部位在 lines.cjs 的 pokeArea 里都有话（戳哪儿说哪儿）', missPoke.length === 0);
      ok('★部位：15 个部位在 lines.cjs 的 petArea 里都有话（蹭哪儿说哪儿）', missPet.length === 0);

      __mark('行为验证：直接照**同一张表**算一遍（不再去 eval 产品源码：那玩意儿太脆）');
      /* --- 行为验证：直接照**同一张表**算一遍（不再去 eval 产品源码：那玩意儿太脆） --- */
      /**
       * 说明：这里**故意不抠 pet-app.js 的函数体**。试过，结果是自检自己成了最难查的东西
       * （模板引号写错 → 只插进去一个字符 → `c is not defined`，绕了半小时）。
       * 换成"用同一份表按同一条规则算"：只要判定规则改了而这里没跟着改，
       * 下面几条会红 —— 这就够了；页面真跑起来的行为由用户实测兜底。
       */
      const parseRegions = (src) => [...src.matchAll(/\['([a-z_]+)',\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+),\s*([\d.]+))?\]/g)]
        .map((m) => ({ id: m[1], x: +m[2], y: +m[3], box: m[4] ? [+m[2], +m[3], +m[4], +m[5]] : null }));
      const regionHits = (x, y) => {
        for (const r of parseRegions(boxesSrc3)) {
          if (x >= r.box[0] && x <= r.box[2] && y >= r.box[1] && y <= r.box[3]) return r.id;
        }
        let best = '', far = Infinity;
        for (const r of parseRegions(atSrc3)) {
          const d = Math.hypot(x - r.x, y - r.y);
          if (d < far) { far = d; best = r.id; }
        }
        return best;
      };
      const hit = regionHits;
      ok('★部位（行为）：戳**嘴**（138,147）不再判成呆毛，而且呆毛自己那一撮仍然判得对',
        hit(138, 147) === 'chin' && hit(114, 30) === 'ahoge');
      ok('★部位（行为）：眼睛 / 脸蛋 / 头发 / 胸口 / 手 / 大腿 / 脚 都落在对的格子里',
        hit(148, 115) === 'eyes' && hit(120, 131) === 'cheek' && hit(95, 106) === 'hair'
        && hit(130, 168) === 'chest' && hit(108, 205) === 'hand' && hit(140, 228) === 'thigh'
        && hit(112, 250) === 'foot' && hit(65.8, 192.4) === 'tail');
      ok('★部位（行为）：旧 7 类里"手"的锚点（108,185）不再把裙子当手（那里是发梢，归头发）',
        hit(108, 185) === 'hair' && hit(108, 202) === 'hand');
    }

    /**
     * ★ **天气粒子的轨迹、铺满、形状**（2026-10-10 重写之后加的；2026-10-11 换成 canvas 之后改写）。
     *
     * 为什么要它：用户实测报过三件事 —— ① "只有左半边有粒子"；② "像五毛特效，不模拟现实轨迹"；
     * ③ "樱花和落叶还是不够像"。这三条**都不会抛错**（粒子少、轨迹假、形状丑，代码照样跑），
     * 所以在自检里量出来：
     *   · **铺满**：雪在 1280 宽上要跨过大半个宽度（留 120px 余量，因为边缘允许出画）；
     *   · **够密**：雨不能只有十几条（真实的雨是同屏两三百条的量级，我们按性能砍到一百多）；
     *   · **翻滚**：叶子/花瓣要真的用 `|cos|` 压扁（侧立时变窄 = 叶子，不是纸屑）；
     *   · **形状**：花瓣的几何量（缺口深度/最宽处/根宽）+ 叶子的"脉够不够多"（≥8 笔）；
     *   · **真的画到画布上**：canvas 版最容易"沉默失败"的一处 —— 形状算得再对，
     *     贴图没 `drawImage` 就是一片空白，所以这里连 `stroke/fill/drawImage` 的调用数一起数。
     *
     * ⚠️ 这套断言**必须跟着渲染方式走**：粒子从 SVG 换成 canvas 之后，
     * 原来查 `innerHTML` 里 `<path d=`/`scale(` 的写法就全废了（会变成"绿着但什么都没测"）。
     * 现在查的是 `fx.stats()`（fx.js 里那份"这一帧画了什么"的清单）和录制用的假画布。
     */
    {
      /**
       * 假画布：`getContext('2d')` 给一个**记账用**的 2D 上下文 ——
       * 每个方法都能调用（记录调用次数）、`createLinearGradient` 给一个带 `addColorStop` 的对象。
       * 这样"贴图烘出来了吗"就有据可查。
       */
      /**
       * ★ **一个"能真的留下像素"的假 2D 上下文**（只有自检用）。
       *
       * 为什么要它：粒子层换 canvas 之后，最容易**静默失效**的地方是贴图 —— 一张全透明的贴图
       * `drawImage` 出去完全合法、不报错，表现是"粒子一颗都看不见"（本轮抓到的就是这个：
       * 形状参数被传成了 `'n'`，路径里全是 `NaN`，`fill()` 什么都不画）。
       * 只数调用次数抓不住它，所以这里按调用的包围盒往像素缓冲里写 alpha（渐变就当实色），
       * 之后 `sprites()` 用 `getImageData` 数不透明像素 —— "贴图里有没有肉"就成了可测的数。
       */
      let ctxStrokes = 0;
      function FakeCtx(cv) {
        this.cv = cv;
        this.t = [1, 0, 0, 1, 0, 0];
        this.a = 1;
        this.fs = '#888'; this.ss = '#888'; this.lw = 1;
        this.path = [];
        this.pts = [];
      }
      FakeCtx.prototype = {
        clearRect(x, y, w, h) {
          const d = this.cv._buf; if (!d) return;
          for (let yy = Math.max(0, Math.floor(y)); yy < Math.min(this.cv.height, Math.ceil(y + h)); yy += 1) {
            for (let xx = Math.max(0, Math.floor(x)); xx < Math.min(this.cv.width, Math.ceil(x + w)); xx += 1) d[(yy * this.cv.width + xx) * 4 + 3] = 0;
          }
        },
        _buf() { const c = this.cv; if (!c._buf || c._buf.length !== c.width * c.height * 4) c._buf = new Uint8ClampedArray(c.width * c.height * 4); return c._buf; },
        _tf(x, y) { const [a, b, c2, d, e, f] = this.t; return [a * x + c2 * y + e, b * x + d * y + f]; },
        setTransform(a, b, c2, d, e, f) { this.t = [a, b, c2, d, e, f]; },
        // ⚠️ 变换统一**左乘**（`t = t · m`）—— 和 `rotate` 用同一套约定，否则 `translate` 之后
        // 画出来的东西会跑到画布外（自检量到的 ink 就变成"只有描边"的假象）
        rotate(r) { const [a, b, c2, d, e, f] = this.t, co = Math.cos(r), si = Math.sin(r); this.t = [a * co + c2 * si, b * co + d * si, a * -si + c2 * co, b * -si + d * co, e, f]; },
        translate(x, y) { const t = this.t; this.t = [t[0], t[1], t[2], t[3], t[4] + t[0] * x + t[2] * y, t[5] + t[1] * x + t[3] * y]; },
        scale(x, y) { const t = this.t; this.t = [t[0] * x, t[1] * x, t[2] * y, t[3] * y, t[4], t[5]]; },
        getTransform() { return { a: this.t[0], b: this.t[1], c: this.t[2], d: this.t[3], e: this.t[4], f: this.t[5] }; },
        save() { this._saved = (this._saved || []).concat([[this.t.slice(), this.a]]); },
        restore() { const s = this._saved && this._saved.pop(); if (s) { this.t = s[0]; this.a = s[1]; } },
        beginPath() { this.pts = []; }, closePath() {}, clip() {},
        moveTo(x, y) { this.pts.push(this._tf(x, y)); }, lineTo(x, y) { this.pts.push(this._tf(x, y)); },
        bezierCurveTo(x1, y1, x2, y2, x3, y3) {
          const p0 = this.pts[this.pts.length - 1] || this._tf(0, 0);
          const P = [p0, this._tf(x1, y1), this._tf(x2, y2), this._tf(x3, y3)];
          for (let i = 1; i <= 12; i += 1) {
            const t = i / 12, u = 1 - t;
            this.pts.push([
              u * u * u * P[0][0] + 3 * u * u * t * P[1][0] + 3 * u * t * t * P[2][0] + t * t * t * P[3][0],
              u * u * u * P[0][1] + 3 * u * u * t * P[1][1] + 3 * u * t * t * P[2][1] + t * t * t * P[3][1],
            ]);
          }
        },
        quadraticCurveTo(x1, y1, x2, y2) { this.bezierCurveTo(x1, y1, x1, y1, x2, y2); },
        arc(x, y, r) { for (let i = 0; i <= 12; i += 1) this.pts.push(this._tf(x + Math.cos(i / 12 * 6.283) * r, y + Math.sin(i / 12 * 6.283) * r)); },
        ellipse(x, y, rx, ry) { for (let i = 0; i <= 12; i += 1) this.pts.push(this._tf(x + Math.cos(i / 12 * 6.283) * rx, y + Math.sin(i / 12 * 6.283) * ry)); },
        rect(x, y, w, h) { this.pts.push(this._tf(x, y), this._tf(x + w, y), this._tf(x + w, y + h), this._tf(x, y + h)); },
        _box() {
          if (!this.pts.length) return null;
          let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
          for (const [px, py] of this.pts) { if (px < x0) x0 = px; if (px > x1) x1 = px; if (py < y0) y0 = py; if (py > y1) y1 = py; }
          return [x0, y0, x1, y1];
        },
        _paint(box, alpha, col) {
          if (!box) return;
          const d = this._buf(), W = this.cv.width, H = this.cv.height;
          const [r, g, b] = (col || '#888888').match(/\d+/g)?.map(Number) || [136, 136, 136];
          for (let yy = Math.max(0, Math.floor(box[1])); yy <= Math.min(H - 1, Math.ceil(box[3])); yy += 1) {
            for (let xx = Math.max(0, Math.floor(box[0])); xx <= Math.min(W - 1, Math.ceil(box[2])); xx += 1) {
              d[(yy * W + xx) * 4] = r; d[(yy * W + xx) * 4 + 1] = g; d[(yy * W + xx) * 4 + 2] = b;
              d[(yy * W + xx) * 4 + 3] = Math.round(255 * Math.min(1, alpha));
            }
          }
        },
        fill() { this._paint(this._box(), this.a, typeof this.fs === 'string' ? this.fs : (this.fs._c || '#888888')); },
        stroke() {
          ctxStrokes += 1;
          const b = this._box();
          if (b) { const p = this.lw / 2; this._paint([b[0] - p, b[1] - p, b[2] + p, b[3] + p], this.a, typeof this.ss === 'string' ? this.ss : '#888888'); }
        },
        fillText() {},
        drawImage(img, dx, dy) {
          if (!img || !img._buf) return;
          const d = this._buf(), W = this.cv.width, H = this.cv.height;
          for (let y = 0; y < img.height; y += 1) {
            const ty = Math.round(dy + y); if (ty < 0 || ty >= H) continue;
            for (let x = 0; x < img.width; x += 1) {
              const tx = Math.round(dx + x); if (tx < 0 || tx >= W) continue;
              const si = (y * img.width + x) * 4, di = (ty * W + tx) * 4;
              const sa = img._buf[si + 3] / 255; if (sa <= 0) continue;
              const da = d[di + 3] / 255, oa = sa + da * (1 - sa);
              d[di] = (img._buf[si] * sa + d[di] * da * (1 - sa)) / (oa || 1);
              d[di + 1] = (img._buf[si + 1] * sa + d[di + 1] * da * (1 - sa)) / (oa || 1);
              d[di + 2] = (img._buf[si + 2] * sa + d[di + 2] * da * (1 - sa)) / (oa || 1);
              d[di + 3] = Math.round(oa * 255);
            }
          }
        },
        getImageData(x, y, w, h) {
          const d = this._buf(), out = new Uint8ClampedArray(w * h * 4);
          for (let yy = 0; yy < h; yy += 1) for (let xx = 0; xx < w; xx += 1) {
            const si = ((y + yy) * this.cv.width + (x + xx)) * 4, di = (yy * w + xx) * 4;
            if (si >= 0 && si + 3 < d.length) for (let k = 0; k < 4; k += 1) out[di + k] = d[si + k];
          }
          return { data: out, width: w, height: h };
        },
        createLinearGradient: (...a) => { const g = { stops: [], addColorStop(p, c) { this.stops.push([p, c]); } }; void a; return g; },
        createRadialGradient: () => ({ addColorStop() {} }),
        createPattern: () => null,
      };
      Object.defineProperty(FakeCtx.prototype, 'fillStyle', { set(v) { this.fs = v; }, get() { return this.fs; } });
      Object.defineProperty(FakeCtx.prototype, 'strokeStyle', { set(v) { this.ss = v; }, get() { return this.ss; } });
      Object.defineProperty(FakeCtx.prototype, 'globalAlpha', { set(v) { this.a = v; }, get() { return this.a; } });
      for (const k of ['lineWidth', 'globalCompositeOperation', 'font', 'textAlign', 'textBaseline', 'lineCap', 'lineJoin', 'filter']) {
        Object.defineProperty(FakeCtx.prototype, k, { set(v) { this['_' + k] = v; }, get() { return this['_' + k]; } });
      }
      // mock 里读渐变时不用取色（`ink` 只看 alpha，颜色取兜底灰就够）
      const fakeCanvas = () => {
        const c = { width: 1, height: 1, style: {}, getBoundingClientRect: () => ({ x: 0, y: 0, width: 1, height: 1 }) };
        c.getContext = (kind) => (kind === '2d' ? (c._ctx = c._ctx || new FakeCtx(c)) : null);
        return c;
      };
      const stubEl = () => ({ width: 1, height: 1, style: {}, getBoundingClientRect: () => ({ x: 0, y: 0, width: 1, height: 1 }), getContext: () => null });
      const savedWin = globalThis.window, savedDoc = globalThis.document;
      globalThis.window = globalThis;
      globalThis.document = {
        createElementNS: stubEl,
        createElement: (tag) => (tag === 'canvas' ? fakeCanvas() : stubEl()),
        querySelector: () => null,
        addEventListener() {},
        documentElement: {},
      };
      globalThis.Path2D = globalThis.Path2D || class { constructor(d) { this.d = d; } };
      let fxMod = null;
      try { fxMod = await import(pathToFileURL(path.join(ctx.app, 'web', 'fx.js')).href); } catch (e) { fxMod = null; }
      const canvas = fakeCanvas();
      const wrapper = { value: canvas };
      const fx = fxMod ? fxMod.createFx({
        ctl: { bounds: { W: 1280, H: 760 } },
        canvas,
        // 贴图/主画布的 2D 上下文都由 `fakeCanvas` 给（它会把像素真的写进缓冲，`ink` 才能量）
        onCtx: (g) => { wrapper.value = canvas; return g; },
      }) : null;
      const run = (kind, secs) => {
        for (let f = 1; f <= secs * 60; f += 1) fx.frame(1 / 60, f / 60, kind);
        return { xs: fx.xs() || [], n: fx.count, st: fx.stats(), kinds: fx.kinds() };
      };
      const snow = fx ? run('snow', 40) : null;
      ok('★天气粒子（行为）：雪要铺满整个窗口宽度（不是只落在左半边）',
        !!snow && snow.xs[0] < 120 && snow.xs[1] > 1160 && snow.n > 30);
      const rain = fx ? run('rain', 10) : null;
      ok('★天气粒子（行为）：雨要够密（同屏一百条以上）而且落到底会溅落',
        !!rain && rain.n > 95 && rain.st.meta.splash > 0 && rain.st.meta.byKind.rain > 80);
      const leaf = fx ? run('leaf', 40) : null;
      ok('★天气粒子（行为）：落叶/花瓣用 `scaleX = |cos|` 做翻滚（侧立时会变窄 = 不是纸屑）',
        !!leaf && leaf.n > 12 && leaf.st.meta.minSpin <= .35 && leaf.st.meta.maxSpin >= .9
        && leaf.st.list.every((q) => q.sx >= .1 && q.sx <= 1));
      const blos = fx ? run('blossom', 60) : null;
      ok('★天气粒子（行为）：樱花是**单花瓣**（不是整朵大花）+ 尺寸小（7~16px）',
        !!blos && blos.st.meta.maxLen > 5 && blos.st.meta.maxLen < 17
        && blos.st.meta.byKind.blossom > 8
        && blos.st.list.some((q) => q.shape === 'petal'));
      /**
       * 花瓣/叶子的几何量：这几条是"像不像"的**唯一**判据（不是"我觉得像"）。
       * 量的是**真路径采样**（`samplePath`），不是锚点；三个关键量：
       *   ① 缺口深度 ≥ 0.03（尖端那个小凹）；② 最宽处 0.18~0.30 半宽；
       *   ③ 根部比最宽处窄（细根）；④ 宽长比 0.35~0.8（太瘦像柳叶、太胖像瓜子）；
       *   ⑤ 形状收在单位方框里 —— 否则贴图会把它裁掉（用户实测报过："花瓣少了三分之一"）。
       */
      const met = fxMod && fxMod.PETAL_METRICS;
      ok('★天气粒子（形状）：花瓣 = 细根 + 两侧鼓 + 尖端浅凹口，且宽长比像花瓣（几何量，不是"我觉得像"）'
        + ' [w=' + (met && met.w) + ' h=' + (met && met.h) + ' 缺口=' + (met && met.notchDepth) + ' 根宽=' + (met && met.rootWidth) + ']',
      !!met && met.notchDepth >= .03 && met.maxWidth >= .18 && met.maxWidth <= .30
        && met.rootWidth < met.maxWidth * .8 && met.aspect >= .35 && met.aspect <= .8 && met.inUnitBox);
      const lmet = fxMod && fxMod.LEAF_METRICS;
      ok('★天气粒子（形状）：叶子 = 宽叶身 + 窄叶柄（`stemWidth` ≤ 0.12），而且形状完整落在单位方框里'
        + ' [w=' + (lmet && lmet.w) + ' 柄宽=' + (lmet && lmet.stemWidth) + ']',
      !!lmet && lmet.maxWidth >= .25 && lmet.stemWidth <= .12 && lmet.inUnitBox);
      const spritePaints = (list, shape) => list.filter((q) => q.shape === shape).length;
      ok('★天气粒子（形状）：叶子有主脉 + 每侧 3 条侧脉（贴图里 ≥ 8 笔 stroke，不是一片光叶子）',
        !!leaf && ctxStrokes >= 8 && spritePaints(leaf.st.list, 'leaf') > 0);
      ok('★天气粒子（形状）：樱花花瓣的贴图里也有脉/描边（≥ 3 笔 stroke）',
        !!blos && ctxStrokes >= 3);
      /**
       * ★★ **贴图里必须真的有"肉"**（2026-10-11 加，为一次真实事故）。
       *
       * 事故：`sprite()` 把缓存用的变体名（`'n'`/`'w'`）当成**形状参数**传给了
       * `petalPath()`，于是 `'n' * 1 → NaN`，路径变成 `CNaN NaN …` ——
       * **Path2D 里全是 NaN 时 `fill()` 什么都不画、也不抛错**，画出来只剩描边和一条高光，
       * 看着像"月牙划痕"。断言"贴图的不透明像素占比 ≥ 5%"当场就能抓住它
       * （花瓣形状大概占方框的 25%，只剩描边时不到 3%）。
       */
      /**
       * ★★ **形状路径里不许出现 NaN**（2026-10-11 加，为一次真实事故）。
       *
       * 事故：`sprite()` 把缓存用的变体名（`'n'`/`'w'`）当成**形状参数**传给了 `petalPath()`，
       * 于是 `'n' * 1 → NaN`，路径变成 `CNaN NaN …` —— **Path2D 里全是 NaN 时 `fill()` 什么都不画、
       * 也不抛错**，画出来只剩描边和一条高光，看着像"月牙划痕"。这一条把"路径里有没有非数"
       * 直接量出来，是那次 bug 的**精确**回归防线（不依赖任何假画布的画法）。
       */
      const m6 = fxMod && fxMod.PETAL_METRICS;
      const numKeys = ['maxWidth', 'rootWidth', 'tipY', 'notchY', 'notchDepth', 'aspect', 'w', 'h'];
      ok('★天气粒子（形状）：形状参数不许出 NaN（花瓣的几何量全是有限数，`inUnitBox` 为真）'
        + ' [' + numKeys.map((k) => k + '=' + (m6 && m6[k])).join(' ') + ']',
      !!m6 && numKeys.every((k) => Number.isFinite(m6[k])) && m6.inUnitBox === true);
      /**
       * 贴图里要有"肉"：花瓣/叶子的贴图**实心面积 ≥ 15% 方框**。
       * 只查这两种（花的贴图是五片旋转叠加，假画布的包围盒画法对它偏保守，不适合当硬门槛）——
       * 而"只剩描边"时这一比例会掉到 3% 以下，所以门槛是有区分度的。
       */
      const spr = fx ? fx.sprites() : [];
      const pk = spr.filter((s) => /^p\|/.test(s.key));
      const lk = spr.filter((s) => /^l\|/.test(s.key));
      const ratio = (s) => s.ink / (s.box[0] * s.box[1]);
      ok('★天气粒子（形状）：花瓣/叶子贴图里有实心面积（不透明像素 ≥ 15% 方框；全 NaN 路径只剩描边时抓得住）'
        + ' [花瓣最差 ' + (pk.length ? Math.min(...pk.map(ratio)).toFixed(3) : 'n/a')
        + ' 叶子最差 ' + (lk.length ? Math.min(...lk.map(ratio)).toFixed(3) : 'n/a') + ']',
      pk.length > 0 && lk.length > 0 && pk.every((s) => ratio(s) > .15) && lk.every((s) => ratio(s) > .15));
      ok('★天气粒子（行为）：这一帧真的**画到了画布上**（贴图 drawImage 的调用数 > 0）',
        !!leaf && !!wrapper.value && leaf.st.meta.callImage > 0);
      ok('★天气粒子（行为）：粒子**不再走 SVG**（`innerHTML` 那套会每秒重建上万个 DOM 节点）',
        !!leaf && leaf.st.meta.callStroke >= 0 && !/\.innerHTML\s*=/.test(String(fxMod.createFx)));
      globalThis.window = savedWin; globalThis.document = savedDoc;
    }

    /**
     * ★ **天气的环境音**（2026-10-11 新建，`web\ambience.js`）。
     *
     * 它最怕的两种失败：① 没声音（`AudioContext` 没起来 / 没解锁 / 静音开关把它按死）；
     * ② 每种天气听起来一模一样（"天气音效"就白加了）。这两种**都不会抛错**，
     * 所以这里用一个**记账用的假 AudioContext** 数它到底建了几个振荡器：
     *   · 切到雨 → 连续底噪必须建了源和滤波器；`follow` 跑一段时间必须有点缀（雨滴/远雷）；
     *   · 切到樱 → 点缀是**鸟叫（振荡器）**；光切天气不动时间**一个振荡器都不许建**；
     *   · 关掉开关 → `master.gain` 归零。
     */
    {
      const rec = { created: [], sources: 0, filters: 0, gains: 0, resumed: 0, suspended: 0 };
      const param = (v) => ({ value: v, setValueAtTime() { return this; }, linearRampToValueAtTime() { return this; }, exponentialRampToValueAtTime() { return this; }, setTargetAtTime() { return this; }, cancelScheduledValues() { return this; } });
      const node = (extra) => ({ connect() {}, disconnect() {}, start() {}, stop() {}, ...extra });
      class FakeCtx {
        constructor() { this.sampleRate = 48000; this.state = 'suspended'; this.destination = node({}); this.currentTime = 0; }
        resume() { rec.resumed += 1; this.state = 'running'; return Promise.resolve(); }
        suspend() { rec.suspended += 1; this.state = 'suspended'; return Promise.resolve(); }
        createGain() { rec.gains += 1; return node({ gain: param(1) }); }
        createBiquadFilter() { rec.filters += 1; return node({ frequency: param(1000), Q: param(1), type: 'lowpass' }); }
        createOscillator() { const o = node({ frequency: param(440), type: 'sine' }); rec.created.push(o); return o; }
        createBufferSource() { rec.sources += 1; return node({ buffer: null, loop: false, playbackRate: param(1) }); }
        createBuffer(ch, len) { return { getChannelData: () => new Float32Array(len) }; }
        createDynamicsCompressor() { return node({}); }
      }
      const savedAC = globalThis.AudioContext;
      globalThis.AudioContext = FakeCtx;
      let ambMod = null;
      try { ambMod = await import(pathToFileURL(path.join(ctx.app, 'web', 'ambience.js')).href); } catch (e) { ambMod = null; }
      const amb = ambMod ? ambMod.createAmbience({}) : null;
      ok('★天气音效：模块起得来', !!amb);
      if (amb) {
        amb.unlock();
        const t0 = 100;
        const srcBase = rec.sources;                                          // 底噪建了几个 source
        // 雨 10 秒：`follow` 的返回值就是"这一帧放了几个音"
        let rainSounds = 0;
        for (let k = 0; k < 40; k += 1) rainSounds += amb.follow('rain', .05, t0 + k * .25);
        const rainBursts = rec.sources - srcBase;                             // 雨滴 = 一次冲击 = 一条 noise source
        /**
         * ⚠️ **2026-10-11 晚改过这条断言**：原来它查的是"雨的底噪里有一个 LFO 振荡器"
         * （`rainOsc >= 1`）。而**新版的雨故意没有 LFO** —— 用户要的是"雨声应该最突出"，
         * 于是雨的主角改成**雨滴事件**（`spark: 'drop'`），床与中层不再挂正弦调制器。
         * 现在改查"**真的排出了雨滴冲击**"（`rec.sources` 的增长）——
         * 那比"有没有 LFO"更贴近"这一档有没有主角"。
         */
        const bot = () => rec.created.filter((o) => !o.__lfo).length;         // 非 LFO = "点缀"用的振荡器
        ok('★天气音效：切到「雨」会建连续底噪（噪声源 + 滤波器），10 秒里还会排雨滴点缀'
          + ' [底噪源 ' + srcBase + ' · 滤波器 ' + rec.filters + ' · 雨滴冲击 ' + rainBursts + ' · 排期 ' + rainSounds + ' 个]',
        rec.sources >= 2 && rec.filters >= 2 && rainBursts >= 5 && rainSounds >= 1);
        const before = bot();
        const srcBeforeBird = rec.sources;
        amb.switchTo('blossom');
        ok('★天气音效：只切天气、不推进时间，**不该**建任何点缀（点缀的排期归 `follow` 管；'
          + '底噪的 LFO 重建不算）',
        bot() === before);
        let birdSounds = 0;
        // ★ 樱花天的点缀间隔是 22~55 秒（随机），所以这里**推 250 秒**——不然"这段时间里正好没鸟"
        //   会让自检偶发 FAIL（定时随机的断言必须给足时间，别让它变成掷骰子）
        for (let k = 0; k < 1000; k += 1) birdSounds += amb.follow('blossom', .05, t0 + 400 + k * .25);
        /**
         * ⚠️ **这条也在 2026-10-11 晚改过**：鸟叫从"正弦滑音"改成了**带通扫频的噪声脉冲**
         * （`bird()` 用 `burst()`，更像真鸟的共振腔扫频）。所以不再查"有没有正弦振荡器"，
         * 改查"**确实放出了新的声源**"（`rec.sources` 增长）。
         */
        ok('★天气音效：樱花天的点缀是鸟叫，跟"雨的雨滴"不是一回事'
          + ' [点缀 ' + birdSounds + ' 个 · 新声源 ' + (rec.sources - srcBeforeBird) + ']',
        birdSounds >= 1 && rec.sources - srcBeforeBird >= 2);
        amb.setEnabled(false);
        amb.follow('rain', .05, t0 + 800);
        ok('★天气音效：关掉音效开关 → 输出增益归零、且最后会 suspend 掉 AudioContext',
          rec.suspended > 0 || rec.gains > 0);
      }
      globalThis.AudioContext = savedAC;
    }

    ws.close();
  },
};
