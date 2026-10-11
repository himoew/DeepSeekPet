/**
 * 自检区域：真连一遍·自动说话（她自己找话说）
 *
 * 由原 `regions\05-live.cjs` 的**第 5c 节**整段切出来（按行号搬，正文一字未改）。
 * 共用连接与 helper（`ws` / `fromPet` / `init` / `waitFor` / `nextReply` / `drain` /
 * `touchSay` …）由 `lib\live.cjs` 提供 —— 单跑这一个区域时它会自己连、自己等 init。
 * 单跑：`node test\run-one.cjs 05g-autochat.cjs`
 */
module.exports = {
  name: "真连一遍·自动说话（她自己找话说）",
  tags: ["live","联调","自动说话"],
  async run(ctx) {
    await ctx.live.ensure();   // 共用连接（第一个用到它的区域负责连上，并抓下 init）
    /** 假模型端点：这一节要查它收到了什么（`stub.seen`）。 */
    const stub = await ctx.ensureStub();
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

  },
};
