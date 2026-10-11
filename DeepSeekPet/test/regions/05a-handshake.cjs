/**
 * 自检区域：真连一遍·基础往返（init/问候/模型/踢球）
 *
 * 由原 `regions\05-live.cjs` 的**第 5 节**整段切出来（按行号搬，正文一字未改）。
 * 共用连接与 helper（`ws` / `fromPet` / `init` / `waitFor` / `nextReply` / `drain` /
 * `touchSay` …）由 `lib\live.cjs` 提供 —— 单跑这一个区域时它会自己连、自己等 init。
 * 单跑：`node test\run-one.cjs 05a-handshake.cjs`
 */
module.exports = {
  name: "真连一遍·基础往返（init/问候/模型/踢球）",
  tags: ["live","联调","气泡"],
  async run(ctx) {
    await ctx.live.ensure();   // 共用连接（第一个用到它的区域负责连上，并抓下 init）
    /** 假模型端点（这一节与后面几节共用同一个） */
    const stub = await ctx.ensureStub();
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

  },
};
