/**
 * 自检区域：她听得懂"往下滑"（2026-11-07）
 *
 * 用户实测（11-07 20:08）：「你现在往下滑」→ 她嘴上说"下滑了"，手机**一动没动**；
 * 纠正之后她写了 `[手机:往下翻]`，桌宠那条聊天路径**根本没执行**，标记还被念了出来。
 *
 * 这一区盯四件事：
 *   ① 主人的明确手机指令认得出、抱怨/问句/否定/转述认不出；
 *   ② "往下翻/读这一页"是**零模型**的确定动作；搜索只取前半句关键词；
 *   ③ 每屏都看图（`vision.always`）、计划化执行、读到了就算完成；
 *   ④ 静态守卫：桌宠路径真的调了 `handlePhoneTag(..., 'deskpet')`，结果也回得到桌宠。
 *
 * 单跑：`node test\run-one.cjs 29-phone-intent.cjs`
 */
module.exports = {
  name: '她的手机（听得懂指令 / 每屏看图 / 计划）',
  tags: ['companion', 'phone', '手机', 'intent', '指令'],
  async run(ctx) {
    const { ok, fs, path, app } = ctx;
    const intent = ctx.mod('phone-intent');
    const agentMod = ctx.mod('phone-agent');

    /* ---------- 1. 主人的明确指令：认得出 ---------- */

    const yes = [
      ['你现在往下滑，你现在在网页里面。', '往下翻一屏'],
      ['往下翻', '往下翻一屏'],
      ['再往下翻翻', '往下翻一屏'],
      ['你帮我往下滑一下', '往下翻一屏'],
      ['你能不能帮我把这页往下翻', '往下翻一屏'],
      ['往上翻一屏', '往上翻一屏'],
      ['返回', '返回'],
      ['退出去', '返回'],
      ['回桌面', '回桌面'],
      ['截个图给我', '截张图发给他'],
      ['截图', '截张图发给他'],
      ['读一下这一页', '读这一页'],
      ['这一页讲了什么', '读这一页'],
      ['打开相册', '打开相册'],
      ['去浏览器', '打开浏览器'],
      ['看会儿视频', '看会儿视频'],
    ];
    for (const [say, goal] of yes) {
      const r = intent.ownerCommand(say);
      ok(`指令：认得出「${say}」`, !!r && r.goal === goal);
    }
    const searchCmd = intent.ownerCommand('搜一只猫的图片');
    ok('指令：搜索带关键词', !!searchCmd && searchCmd.kind === 'search' && /一只猫/.test(searchCmd.goal));

    /* ---------- 2. 不认：抱怨 / 问句 / 否定 / 转述 / 过去 ---------- */

    const no = [
      '你还没有下滑成功呢',
      '刚刚说错了是你还没有下滑成功呢',
      '我还是先给你优化一下吧，感觉还是有点问题啊，你这个玩手机，特别是我自己下滑都有点困难。',
      '你刚才往下滑了吗',
      '是不是没滑成功',
      '先别往下滑',
      '不要翻',
      '你说往下翻',
      '我让你下滑',
      '搜什么',
      '这手机怎么这么卡',
      '你玩手机还是不太会',
      '我看你滑了半天也没动',
    ];
    for (const say of no) ok(`指令：不误认「${say.slice(0, 18)}…」`, intent.ownerCommand(say) === null);

    /* ---------- 3. 一句话就是一下手势：零模型 ---------- */

    const down = agentMod.quickSkill('往下翻一屏');
    ok('快捷：往下翻一屏 = 一个滚动动作，不问模型', !!down && down.kind === 'scroll' && down.dir === 'down' && down.screens === 1);
    const up = agentMod.quickSkill('往上翻一屏');
    ok('快捷：往上翻一屏 = 一个滚动动作，不问模型', !!up && up.kind === 'scroll' && up.dir === 'up');
    ok('快捷：往下翻翻（口语）也认', agentMod.quickSkill('往下翻翻')?.kind === 'scroll');
    ok('快捷：读这一页 = 零模型读屏', agentMod.quickSkill('读这一页')?.kind === 'read');
    ok('快捷：这一页讲了什么也走读屏', agentMod.quickSkill('这一页讲了什么')?.kind === 'read');

    /* ---------- 4. 搜索：只取前半句，别把"挑一条点开看看"搜进去 ---------- */

    const s1 = agentMod.quickSkill('搜一下今天的新闻，挑一条点开看看讲了什么');
    ok('搜索：关键词只取「今天的新闻」', !!s1 && s1.kind === 'search' && s1.keyword === '今天的新闻');
    ok('搜索：不会把整句当关键词', !!s1 && !/挑一条|点开/.test(s1.keyword));
    const s2 = agentMod.quickSkill('搜一只猫的图片');
    ok('搜索：剥掉"一只/图片" → 猫', !!s2 && s2.keyword === '猫');
    const s3 = agentMod.quickSkill('搜索蓝色大女仆 卡通图');
    ok('搜索：保留中间的空格（英文/多词查询不粘连）', !!s3 && s3.keyword === '蓝色大女仆 卡通图');
    ok('拆段：搜 X + 挑一条…… 不拆成两件事（否则整件事跑两遍）',
      Array.isArray(agentMod.splitGoal('搜一下今天的新闻，挑一条点开看看讲了什么'))
      && agentMod.splitGoal('搜一下今天的新闻，挑一条点开看看讲了什么').length === 0);
    ok('拆段：打开浏览器，搜点东西 仍然拆（各用各的快捷技能）',
      agentMod.splitGoal('打开浏览器，搜点东西').length === 2);
    /**
     * ★ 2026-11-08：**"打开哔哩哔哩搜猫"不许拆**。
     * 拆成「打开哔哩哔哩」+「搜猫」之后，第二段走的是 `quickSearch`（一条 intent 去**必应**）——
     * 他说"在B站里搜猫"，她跑去搜了整个网页。这几个 App 自带搜索框，整句留给主循环按 App 套路做。
     */
    ok('拆段：在 B 站里搜猫 不拆（否则第二段会跑去搜网页）',
      agentMod.splitGoal('打开哔哩哔哩搜猫').length === 0);
    ok('拆段：打开浏览器搜猫（太短）也不硬拆', agentMod.splitGoal('打开浏览器搜猫').length === 0);
    ok('搜索词：中英混排的空格要保留（不许粘连）',
      agentMod.quickSkill('搜索蓝色大女仆 卡通图')?.keyword === '蓝色大女仆 卡通图');
    ok('搜索词：带逗号的复合句不许把整句当关键词',
      agentMod.quickSkill('打开浏览器，搜点东西') === null);

    /* ---------- 5. 计划：一次想 2~3 步，按顺序做 ---------- */

    const plan = agentMod.parsePlan([
      '先读一下这一页',
      '1. read',
      '2. tapn 2',
      '3. done 看完了',
      '（解释性的话不算动作）',
    ].join('\n'));
    ok('计划：认得出多行动作（带编号也认）', plan.length === 3 && plan[0] === 'read' && plan[1] === 'tapn 2' && plan[2] === 'done 看完了');
    ok('计划：解释行不会变成动作', !plan.some((x) => /解释/.test(x)));
    ok('计划：最多 3 步（不无限铺）', agentMod.parsePlan('tap n0\ntap n1\ntap n2\ntap n3\ntap n4').length === 3);

    /* ---------- 6. 每屏都看图（用户放开 token 后的选择） ---------- */

    const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'dsp-intent-'));
    const adb = {
      async state() { return { online: true, booted: true, screen: { width: 720, height: 1280 }, app: { package: 'mark.via', name: '浏览器' } }; },
      async screenshot() { const png = Buffer.from('89504e470d0a1a0a', 'hex'); return { ok: true, png, bytes: png.length, hash: 's1' }; },
    };
    const agent = new agentMod.PhoneAgent({
      adb, model: { model: 'stub', baseUrl: 'http://127.0.0.1:1', maxTokens: 80, timeoutMs: 5000 },
      dir, rescue: { enabled: false },
    });
    ok('默认：每屏都看图（vision.always）', agentMod.DEFAULTS.vision.always === true && agent.vision.always === true);
    ok('默认：预算放宽到 20 步 / 20 次模型', agentMod.DEFAULTS.maxSteps === 20 && agentMod.DEFAULTS.maxCalls === 20);
    ok('默认：自救上限 15 次', agentMod.DEFAULTS.rescue.max === 15);

    const plain = { app: { package: 'mark.via' }, hash: 'h-plain', count: 10, nodes: [] };
    ok('看图：普通一屏也发图（low）', agent.wantVision({ goal: '看看' }, plain) === 'low');
    agent.markVision(plain);
    ok('看图：同一屏不重复发', agent.wantVision({ goal: '看看' }, plain) === false);
    const thin = { app: { package: 'com.android.gallery3d' }, hash: 'h-thin', count: 2, thin: true, nodes: [] };
    ok('看图：树太空时用高清', agent.wantVision({ goal: '看看' }, thin) === 'high');

    /* ---------- 7. 读到了就是完成（不再要求屏上恰好有"新闻"两个字） ---------- */

    const obs = { app: { name: '浏览器', package: 'mark.via' }, table: 'n0 今天傍晚至夜间北京山区有大到暴雪', nodes: [] };
    const t1 = { goal: '搜一下今天的新闻，挑一条点开看看讲了什么', steps: [{}, {}], readDigest: '记者王景曦报道：傍晚至夜间山区有大到暴雪。', searchWord: '今天的新闻' };
    ok('完成判据：读到了正文就算完成（标题里没有"新闻"也行）', agent.verifyDone(t1, obs, '读完了，讲北京下雪').ok === true);
    const t2 = { goal: '搜一下今天的新闻，挑一条点开看看讲了什么', steps: [{}, {}], searchWord: '今天的新闻' };
    ok('完成判据：没读到正文、屏上也没有目标词 → 不算完成', agent.verifyDone(t2, obs, '弄完了').ok === false);
    const t3 = { goal: '搜一只猫的图片', steps: [{}], searchWord: '猫' };
    ok('完成判据：纯"搜一下"搜出来就算完成', agent.verifyDone(t3, obs, '搜到了').ok === true);

    /* ---------- 8. 静态守卫：桌宠那条路真的接上了 ---------- */

    const compSrc = fs.readFileSync(path.join(app, 'companion.cjs'), 'utf8');
    ok('接线：桌宠聊天路径执行 [手机:…]（handlePhoneTag(..., \'deskpet\')）',
      compSrc.includes("handlePhoneTag(replyText, 'deskpet')"));
    ok('接线：主人说"往下滑"时兜底替她排上',
      compSrc.includes('phoneIntent.ownerCommand') && compSrc.includes('!herGoals.length && phoneCmd'));
    /**
     * ★ 2026-11-08（R1/R2/R7）：桌宠那条路必须和 QQ 用**同一个** `phoneIntentHints()`。
     * 以前这四件事（点头开跑 / 明确指令 / 问屏 / 停与去玩）只在 `replyBatch()` 里，
     * 所以语音里他说「先别玩了」「我来操作」，她照样让手机点下去。
     */
    ok('接线：两条路共用一个 phoneIntentHints()（桌宠也调）',
      /async function phoneIntentHints\(/.test(compSrc)
      && (compSrc.match(/await phoneIntentHints\(/g) || []).length >= 2);
    ok('接线：他的"确定动作"压过她写的标记（R2）',
      compSrc.includes('phoneIntent.DETERMINISTIC') && compSrc.includes('hisWins'));
    ok('接线：桌宠说话也算"他说话了"（noteHeard / phone-life.noteUser）',
      /function noteHeard\(/.test(compSrc) && /noteHeard\(/.test(compSrc.split('async function chat(')[1] || ''));
    ok('接线：桌宠也调 noteUser（她先把手机放下）',
      /async function chat\(/.test(compSrc) && /ensureLife\(\)\.noteUser\(\{ at: Date\.now\(\) \}\)/.test(compSrc));
    ok('接线：桌宠里"排不下"也会回一句（phoneRefused 不再只认 QQ）',
      compSrc.includes("const isDesk = target === 'deskpet'"));
    ok('接线：桌宠也能收到手机回灌（key=deskpet 分支）',
      compSrc.includes("const isDesk = key === 'deskpet'") && compSrc.includes("reason: 'phone'"));
    ok('回灌：摘掉 [手机:…]、不重复排队（真机回灌里又带了一次标记）',
      compSrc.includes('phoneAgentMod.parseTag') && compSrc.includes('不要再写 `[手机:…]`'));
    const petSrc = fs.readFileSync(path.join(app, 'pet.cjs'), 'utf8');
    ok('接线：桌宠把手机回灌念出来（deskVoiceOn）', petSrc.includes("ev.key === 'deskpet'") && petSrc.includes('deskVoiceOn()'));
    ok('提示：system 里写死了"只有真的做了才算做到"',
      /只有你真的做了.*才算做到/.test(agent.systemPrompt()));
    ok('提示：明确"滑不动 = 到底/到顶，别连着滑"', /滑不动 = 真的到底\/到顶/.test(agent.systemPrompt()));

    /* ---------- 9. 他 11-07 那一轮的原话（2026-11-08 补） ---------- */

    /**
     * 用户 23:32–23:40 对着桌宠说的 13 句，一句一句钉死。
     * 当时跑出来是 **1/13**；现在 8 条认得出动作，剩下 5 条分别归 `looksLikeStop`（2 条）/
     * `looksLikePlay`（1 条）/ 提案回答（1 条，`free` 模式下用不到）/ 真的没动作（1 条）。
     * ⚠️ 这张表就是"听得懂"的验收，改词表时它会红。
     */
    const real = [
      ['你搜网页吧你不要搜图片……你点网页', 'tap', 'taptext 网页'],
      ['好现在点一下网页', 'tap', 'taptext 网页'],
      ['你怎么又开始划了，你先返回首页吧', 'home', '回桌面'],
      ['不是你先返回首页吧', 'home', '回桌面'],
      ['别看了返回返回要返回到首页我教你看更好看的', 'home', '回桌面'],
      ['这一页有很多的小飞鱼你可以下滑慢慢看', 'scroll', '往下翻一屏'],
      ['好了这一页全是小肥鱼你可以下滑', 'scroll', '往下翻一屏'],
      ['看到了没有这一页全是小肥鱼你可以下滑', 'scroll', '往下翻一屏'],
    ];
    for (const [say, kind, goal] of real) {
      const c = intent.ownerCommand(say);
      ok(`原话：认得出「${say.slice(0, 16)}…」→ ${goal}`, !!c && c.kind === kind && c.goal === goal);
    }
    for (const say of ['可以啊随便你', '别着急它还在加载呢']) {
      ok(`原话：「${say}」不是一句手机指令`, intent.ownerCommand(say) === null);
    }

    /* ---------- 10. 「点网页」是切页签，「点第一条」是打开网址（★ 2026-11-08） ---------- */

    /**
     * 用户 21:27–21:28 的三句话（真机那张必应结果页）：
     *   「你点网页」→ 切搜索类型（`taptext 网页`）；
     *   「这个网址你怎么没有点进去啊」「就是你搜出来的第一个网站你点进去就好了呀」→ **打开第 1 条**。
     * 以前这两件事都落到 `tapn 1`，而结果页上第 1 个带字的节点正是那排页签的「网页」，
     * 所以他连说三次，她三次都在点页签，一个网站都没打开。
     */
    const openCases = [
      ['点进去第一条', 'open 1'],
      ['打开第一条', 'open 1'],
      ['点第2条', 'open 2'],
      ['点第三条结果', 'open 3'],
      ['点那个网址', 'open 1'],
      ['点开那条', 'open 1'],
      ['打开那个网站', 'open 1'],
      ['就是你搜出来的第一个网站你点进去就好了呀', 'open 1'],
    ];
    for (const [say, goal] of openCases) {
      const c = intent.ownerCommand(say);
      ok(`原话：「${say.slice(0, 16)}」→ ${goal}`, !!c && c.kind === 'open' && c.goal === goal);
    }
    ok('原话：「你点网页」仍然是切页签（taptext），不是 open',
      intent.ownerCommand('你点网页')?.kind === 'tap');
    for (const say of ['你刚才点的是第一个网站吗', '这个网址你怎么没有点进去啊？', '我自己点第一条', '怎么点进去']) {
      ok(`不误认：「${say.slice(0, 16)}」`, intent.ownerCommand(say) === null);
    }

    /* ---------- 11. 别把抱怨/转述/否定当指令（放宽之后最容易踩的） ---------- */
    for (const say of [
      '你说往下翻', '我让你下滑', '我让你往下翻你怎么反着来', '说你点网页',
      '先别往下滑', '不要翻', '别翻了', '算了别翻了',
      '你刚才往下滑了吗', '是不是没滑成功', '你还没有下滑成功呢',
      '我自己下滑都有点困难', '我看你滑了半天也没动',
      '你给我描述一下你现在看到的是什么', '你觉得这一页怎么样', '你看到了吗',
      '这手机怎么这么卡', '你玩手机还是不太会', '这页有点卡',
    ]) {
      ok(`扫动作：不误认「${say.slice(0, 16)}」`, intent.ownerCommand(say) === null);
    }
    ok('扫动作：小句里扫出来的标了 via=scan（便于日志区分）',
      intent.ownerCommand('这一页有很多的小飞鱼你可以下滑慢慢看')?.via === 'scan');
    ok('扫动作：整句规则命中的不带 via',
      intent.ownerCommand('往下翻')?.via === undefined);

    /* ---------- 11. 确定动作表（R2 的判据） ---------- */

    /**
     * ★ 2026-11-08（R-A）：**这张表从 7 类收窄到 4 类**。
     *
     * 原来还收着 `read / tap / open / shot`，其中 `open` 是致命的：它同时是"打开某个 App"。
     * 他说「打开浏览器，搜小肥鱼表情包，然后…」→ 代码从第一小句认出「打开浏览器」
     * → 判定"他的算" → 她那句更完整的 `[手机:打开浏览器搜小肥鱼表情包]` 被摘掉（22:01:25）。
     */
    ok('R2：只有回桌面/返回/翻/停 算"确定动作"（他说了就是说了）',
      ['home', 'back', 'scroll', 'stop'].every((k) => intent.DETERMINISTIC.has(k))
      && ['read', 'tap', 'open', 'launch', 'shot', 'search', 'video'].every((k) => !intent.DETERMINISTIC.has(k)));
    ok('R2：搜索/看视频**不**算（她写的往往更具体，按她的办）',
      !intent.DETERMINISTIC.has('search') && !intent.DETERMINISTIC.has('video'));

    /* ---------- 12. R-A0：他今晚五种"去浏览器搜X"，全都要认得出 ---------- */

    /**
     * 用户 22:01 的原话，实测五种**全 miss**（只有光秃秃一个"搜"才认）：
     * 第一句就白说 → 她手里没有可执行的事 → 只能拿输入框、猫咪、图片页去填。
     */
    for (const say of [
      '点浏览器搜索小肥鱼表情包',
      '去浏览器搜小肥鱼表情包',
      '在浏览器里搜小肥鱼表情包',
      '浏览器搜小肥鱼表情包',
      '用浏览器搜小肥鱼表情包',
    ]) {
      const c = intent.ownerCommand(say);
      ok(`R-A0：认得出「${say}」`, !!c && c.kind === 'search' && c.keyword === '小肥鱼表情包');
    }
    /** 反过来：宾語是"框/栏/个/什么"时不是搜索。 */
    for (const say of ['点搜索框', '点地址栏', '搜什么', '搜一下']) {
      ok(`R-A0 守卫：「${say}」不算一次搜索`, intent.ownerCommand(say) === null);
    }

    /* ---------- 13. R-A：他的复合句不许被截成第一个小句 ---------- */

    /**
     * 22:01:25 真机：他的整句被拆成"只打开浏览器"，她自己那句更完整的意图被丢。
     * 现在每一小句能认出的动作都收下来，用「，」连成一件事交给 `splitGoal()` 依次做。
     */
    const multi = intent.ownerCommand('打开浏览器，搜小肥鱼表情包，然后找自己喜欢的网址点进去挑');
    ok('R-A：复合句收下 2 段（打开浏览器 + 搜索小肥鱼表情包）',
      !!multi && Array.isArray(multi.steps) && multi.steps.length === 2
      && multi.steps[0] === '打开浏览器' && multi.steps[1] === '搜索小肥鱼表情包');
    ok('R-A：复合句不再只剩"打开浏览器"', !!multi && multi.goal !== '打开浏览器');
    ok('R-A：App 打开叫 launch（和 phone-agent 的 quickSkill 同名）',
      intent.ownerCommand('打开浏览器')?.kind === 'launch'
      && agentMod.quickSkill('打开浏览器')?.kind === 'launch');
    ok('R-A：她那句已经包含他这件事 → 让她赢（coversHim）',
      intent.coversHim('打开浏览器搜小肥鱼表情包', { goal: '打开浏览器' }) === true);
    ok('R-A：她写的跟他的不是一件事 → 仍然听他的',
      intent.coversHim('搜小肥鱼', { goal: '返回' }) === false);
    /**
     * ★ 2026-11-08 夜（真机 23:16）：「那你现在返回首页，返回桌面，然后…」
     * 两个小句都是"回桌面" → 以前收成「回桌面，回桌面」，白排一步、日志也难看。
     */
    ok('R-A：同一件事说两遍只收一次（不排「回桌面，回桌面」）',
      intent.ownerCommand('那你现在返回首页，返回桌面，然后…')?.goal === '回桌面');

    /* ---------- 14. R-C2：「点图片左边的网页」不是「点图片」 ---------- */

    const side = intent.ownerCommand('点图片左边的网页，去哪里找网址');
    ok('R-C2：认成点"网页"（不是点"图片"）', !!side && side.goal === 'taptext 网页');
    ok('R-C2：快捷技能同一句也认成 taptext 网页',
      agentMod.quickSkill('点图片左边的网页')?.kind === 'taptext'
      && agentMod.quickSkill('点图片左边的网页')?.needle === '网页');
    ok('R-C2：真的"点图片"仍然点图片', intent.ownerCommand('点图片')?.goal === 'taptext 图片');

    /* ---------- 15. R-B：「点搜索框」= 缺一个词，不是一步操作 ---------- */

    for (const say of ['点搜索框', '点地址栏', '点输入框', '搜索框']) {
      ok(`R-B：「${say}」→ needKeyword（要她说清搜什么）`, agentMod.quickSkill(say)?.kind === 'needKeyword');
    }
    ok('R-B：给了词就是搜索，不是 needKeyword', agentMod.quickSkill('搜小肥鱼')?.kind === 'search');
    ok('R-B：搜索词里的"表情包"不许被剥掉（旧版剥成"小肥鱼"）',
      agentMod.quickSkill('搜小肥鱼表情包')?.keyword === '小肥鱼表情包');
    ok('R-B：「图片」仍然算图片类型词，要剥掉', agentMod.quickSkill('搜一只猫的图片')?.keyword === '猫');

    /* ---------- 16. R-E：一句话里两件事，都要收（★ 2026-11-12 真机 21:32） ---------- */

    const two = intent.ownerCommands('你回桌面，看看日记本，里面有我给你写的一条');
    ok('R-E：「回桌面，看看日记本」收成两件（以前只看得到"回桌面"）',
      two.length === 2 && two[0].goal === '回桌面' && /日记本/.test(two[1].goal));
    ok('R-E：「看看相册」也认（打开相册，看看里面有什么）',
      intent.ownerCommand('看看相册')?.goal === '打开相册，看看里面有什么');
    ok('R-E：一整句"打开设置"不变味（还是打开设置）',
      intent.ownerCommand('打开设置')?.goal === '打开设置');
    /**
     * ★ 2026-11-12 21:51 真机：整句一条规则都不匹配（"现在试试去手机桌面看我给你写的日记"），
     * 但她要做的"看日记"必须被认出来 —— 否则她写个 [手机:回桌面] 就嘴上说"我看了"。
     */
    const tail = intent.ownerCommands('现在试试去手机桌面看我给你写的日记，这次应该没问题了');
    ok('R-E：整句认不出时，"去桌面看日记"也要收一件', tail.length === 1 && /日记/.test(tail[0].goal));
    ok('R-E："回桌面然后打开相册" = 两件（回桌面 + 打开相册）',
      intent.ownerCommands('回桌面然后打开相册').length === 2);
    ok('R-E：一句话最多认 3 件（再长就不像指挥了）',
      intent.ownerCommands('回桌面，看看相册，看看日记本，看看设置').length <= 3);

    /* ---------- 17. P0-0：21:55 那个 `LOOK_TAIL` 的回归（★ 2026-11-12） ---------- */

    /**
     * 21:55 加 `LOOK_TAIL`（"整句认不出时再收一件"）时**没走任何守卫**。
     * 用当前模块跑 17 句，**16 句**会被排成"打开 X"—— 这不是理论风险：
     * 他会插队打断她自己那一场、跑 20 步，然后回他一句他没让做的事。
     * 这张表就是那条补丁的回归；改词表时它会红（`32b-phone-gate` 还有一份 24 句的反例）。
     */
    const lookFalse = [
      '别打开相册', '先别打开日记本', '刚才你打开相册了吗', '你刚才打开相册了吗',
      '你说打开日记本', '你说过打开相册', '我让你打开相册', '我教你打开设置',
      '为什么打开相册这么慢', '打开相册怎么这么慢', '我不太会打开设置', '你觉得打开相册怎么样',
      '打开相册是什么意思', '我上次打开相册是昨天', '如果打开相册会怎样', '你明天打开相册看看',
    ];
    for (const say of lookFalse) {
      ok(`P0-0：不误排「${say}」`, intent.ownerCommands(say).length === 0);
    }
    ok('P0-0：16 句假阳性全部归零（21:55 补丁的回归）',
      lookFalse.every((s) => intent.ownerCommands(s).length === 0));
    /** 两条真机日志原话（方案 §1.2(b)）：陈述 / 过去的「刚」。 */
    ok('P0-0：陈述不算指令（"学你的，你写日记也这样"）',
      intent.ownerCommands('学你的，你写日记也这样').length === 0);
    ok('P0-0：过去的「刚」不算指令（"你刚返回卡了"）',
      intent.ownerCommands('你刚返回卡了').length === 0);
    ok('P0-0：这句话拆开看 —— 前半句不排、后半句"重新看看桌面"可以排',
      intent.ownerCommands('你刚返回卡了').length === 0
      && intent.ownerCommands('重新看看桌面就能看到了').length === 0);
    ok('P0-0：`guardReason` 说得出原因（日志/审计用）',
      intent.guardReason('别打开相册') === 'blocked'
      && intent.guardReason('如果打开相册会怎样') === 'hypothetical'
      && intent.guardReason('你明天打开相册看看') === 'future'
      && intent.guardReason('你刚返回卡了') !== '');
    ok('P0-0：防回归 —— 21:51 那句仍然认得出',
      intent.ownerCommands('现在试试去手机桌面看我给你写的日记，这次应该没问题了').length === 1);
    ok('P0-0：`clauses()` 导出了（gate 逐句判要用）',
      intent.clauses('回桌面，看看日记本').length === 2);
    ok('P0-0：宾语尾巴只对 gate 开口子（"打开菜谱看看有什么"不是问句）',
      intent.guardReason('打开菜谱看看有什么', { allowGoalTail: true }) === ''
      && intent.guardReason('打开相册是什么意思', { allowGoalTail: true }) !== '');
  },
};
