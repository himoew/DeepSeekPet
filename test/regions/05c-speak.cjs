/**
 * 自检区域：真连一遍·念出来（语音）
 *
 * 由原 `regions\05-live.cjs` 的**第 4d 节**整段切出来（按行号搬，正文一字未改）。
 * 共用连接与 helper（`ws` / `fromPet` / `init` / `waitFor` / `nextReply` / `drain` /
 * `touchSay` …）由 `lib\live.cjs` 提供 —— 单跑这一个区域时它会自己连、自己等 init。
 * 单跑：`node test\run-one.cjs 05c-speak.cjs`
 */
module.exports = {
  name: "真连一遍·念出来（语音）",
  tags: ["live","联调","语音"],
  async run(ctx) {
    await ctx.live.ensure();   // 共用连接（第一个用到它的区域负责连上，并抓下 init）
    /** 语音模块：原来由第 5 节声明、四节共用；切开之后自己拿一份（`mod` 有缓存）。 */
    const tts = ctx.mod('tts');
    /**
     * ★ **单跑这一节要自己补两份前置**（全量跑时由前面几节铺好；**断言本身一个字没改**）：
     *   ① **模型要接上假端点** —— 本节后半段（fail-me / slow-model / 蹭睡着的它）在等
     *      `tag=answer`，全量跑时是第 5 节那句 `llm.save({ enabled: true, baseUrl: stub.url, … })` 铺的；
     *   ② **假端点的 `slow-model`「慢一次」要先被用掉** —— 全量跑时是 04b「模型冷热分离」用掉的，
     *      本节那条「模型回答直接出去，不再等一个间隔（<3000ms）」量的正是这件事。
     *      不补的话，单跑会把那 4.1 秒真等到，报 `4116ms > 3000` 的**假红**（不是产品的问题；
     *      交接文档第 1.37 节记的就是这条边界）。
     */
    const stub = await ctx.ensureStub();
    llm.save({ enabled: true, baseUrl: stub.url, apiKey: 'test-key', model: 'test-model', maxTokens: 64 });
    await fetch(`${stub.url}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'slow-model', messages: [{ role: 'user', content: '预热：把「慢一次」用掉' }] }),
    }).catch(() => { /* 假端点没起来也不该把这一节带崩，后面断言自然会报 */ });
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

  },
};
