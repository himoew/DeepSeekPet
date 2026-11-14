/**
 * 自检区域：**手机里的她，必须是同一个她**（2026-11-07）
 *
 * 用户两个硬要求：
 *   ① 她现在的性格完全保留（role/self/mind/diary/people.facts/memory 一行不写不删）；
 *   ② 玩手机的人必须和跟他聊天的人是同一个"她"（不是另一个操作员人格）。
 *
 * 这一区盯六件事：
 *   ① 一份只读快照、四个视图，`personaId/coreHash` 处处相等，且**不随心情/进度漂**；
 *   ② 口味以她自己的账为准，`config.phone.taste` 只在她账上空着时兜底；
 *   ③ 手机进度行读时过滤（正常 20 轮不缩水），旧行按保守规则认；
 *   ④ `#trim` 裁之前先写 `turns.archive.jsonl`（不静默删旧对话）；
 *   ⑤ 空 text 的那一行归"她"，不再写成"对方"；
 *   ⑥ 静态守卫：计划/手/判断都不再自称"小肥鱼，普通人"，也没有写记忆的入口。
 *
 * 单跑：`node test\run-one.cjs 30-companion-persona.cjs`
 */
module.exports = {
  name: '同一个她（只读人格源 / 手机里是她）',
  tags: ['companion', 'phone', 'persona', '人格', '记忆'],
  async run(ctx) {
    const { ok, fs, path, app } = ctx;
    const p = ctx.mod('companion-persona');
    const { CompanionBrain } = ctx.mod('companion-brain');
    const { CompanionMemory, isPhoneTurn } = ctx.mod('companion-memory');
    const { formatTurns } = ctx.mod('memory-scribe');

    /* ---------- 1. 一份只读快照，三个 hash 各管一件事 ---------- */

    const base = [
      { id: 'a1', kind: 'anchor', claim: '我不会讨好谁', count: 1, lastAt: 1 },
      { id: 't1', kind: 'taste', claim: '只认蓝色女仆，不喜欢猫', count: 2, lastAt: 2 },
      { id: 's1', kind: 'stance', claim: '不同意也不抬杠', count: 1, lastAt: 3 },
    ];
    const s1 = p.snapshot({
      roleText: '你是小肥鱼。', entries: base,
      mood: { state: 'quiet', label: '安静' }, phone: { focus: { text: '翻相册' } },
    });
    const s2 = p.snapshot({
      roleText: '你是小肥鱼。',
      entries: base.concat([{ id: 'd1', kind: 'doing', claim: '今天翻了相册', count: 1, lastAt: 9 }]),
      mood: { state: 'happy', label: '高兴' },
      phone: { focus: { text: '挑图' }, session: { id: 'sX', theme: 'collect' } },
    });
    ok('同一个她：心情变了、玩到别处了，personaId 不变', s1.personaId === s2.personaId);
    ok('同一个她：coreHash 不算 doing / want / change / mood（玩一次不换人）', s1.coreHash === s2.coreHash);
    ok('上下文：contextHash 会变（它只说明"这次看到的是哪份上下文"）', s1.contextHash !== s2.contextHash);
    ok('身份：personaId 和 coreHash 都不是空的', !!s1.personaId && !!s1.coreHash && s1.personaId !== s1.coreHash);

    ok('四视图：plan / hand / judge / voice 用的是同一个人',
      ['plan', 'hand', 'judge', 'voice'].every((v) => p.checkSame(s1, v).ok && p.identityOf(s1).personaId === s1.personaId));
    const tampered = { ...s1, identity: { ...s1.identity, coreHash: 'deadbeefdeadbeef' } };
    ok('四视图：快照被篡改 / 换了人 → 断言不过（宁可不动）', p.checkSame(tampered, 'hand').ok === false);

    ok('只读：快照是冻结的（传出去谁也改不了）', Object.isFrozen(s1) && Object.isFrozen(s1.core) && Object.isFrozen(s1.core.anchors));
    ok('只读：冻结后的字段改不动', (() => { try { s1.personaId = 'x'; } catch { /* 严格模式下抛错也算 */ } return s1.personaId !== 'x'; })());

    /* ---------- 2. 口味：她自己的账压过 config.phone.taste ---------- */

    const withCat = p.snapshot({
      roleText: 'R',
      entries: [{ id: 't1', kind: 'taste', claim: '只认蓝色女仆，不喜欢猫', count: 2, lastAt: 1 }],
      tasteFallback: '爱猫，看到猫会多看一眼',
    });
    ok('口味：有她自己的账，就不用 config', withCat.core.taste[0] === '只认蓝色女仆，不喜欢猫' && withCat.core.tasteSrc === 'self');
    ok('口味：plan 里跟的是她（不是 config）',
      p.planView(withCat, { at: 0 })[0].content.includes('蓝色女仆') && !p.planView(withCat, { at: 0 })[0].content.includes('爱猫'));
    ok('口味：hand 里跟的也是她',
      p.handView(withCat, { brief: { goal: '挑一张图' } }).includes('蓝色女仆') && !p.handView(withCat).includes('爱猫'));
    /**
     * ★ 2026-11-12：**放开范围的前提** —— 她自己玩时要知道"哪些点了收不回来"
     * （提示给她判断，不是用词表替她拦；词表会把她自己日记的「删除」也拦掉）。
     */
    {
      const hand = p.handView(withCat, { brief: { goal: '去日记本删掉那篇', src: 'session' } });
      ok('手：她自己玩时知道哪些事收不回来（不靠词表拦）', hand.includes('收不回来') && hand.includes('装东西、付钱'));
      ok('手：她自己的日记允许删（连删两篇要跟他说）',
        hand.includes('自己的日记可以写、可以删') && hand.includes('连着删两篇'));
    }
    ok('口味：judge 里跟的也是她', p.judgeView(withCat, { goal: '挑图' }).includes('蓝色女仆'));
    const empty = p.snapshot({ roleText: 'R', entries: [], tasteFallback: '爱猫' });
    ok('口味：她的账空着才用 config 兜底（并标 fallback）',
      empty.core.tasteSrc === 'config-fallback' && empty.core.taste[0] === '爱猫');

    /* ---------- 3. 计划 / 判断：没有快照就不替她决定 ---------- */

    const brain = new CompanionBrain({
      memory: null,
      roleText: '你是小肥鱼。',
      model: { model: 'stub', baseUrl: 'http://127.0.0.1:1', maxTokens: 16, timeoutMs: 50 },
    });
    let threwPlan = false;
    try { await brain.planPhone({ persona: null }); } catch { threwPlan = true; }
    ok('计划：没有只读快照 → 抛错（上层抽兜底牌，不硬演）', threwPlan);
    let threwJudge = false;
    try { await brain.judgePhone({ persona: null }); } catch { threwJudge = true; }
    ok('判断：没有只读快照 → 抛错', threwJudge);
    let threwTamper = false;
    try { await brain.planPhone({ persona: tampered }); } catch { threwTamper = true; }
    ok('计划：身份对不上 → 抛错（不换人）', threwTamper);
    const planSys = p.planView(s1, { at: 0 })[0].content;
    /**
     * ★ 2026-11-12：契约从"theme + goal"改成**开放目的地**：
     * `app`（想去哪个 App）/ `goal` / 可选的 `query`、`url`，以及原来那四个。
     * 还多一个 `skip` —— 她可以说"这趟不去"。
     */
    ok('计划：契约里八个字段都在（app/goal/query/url/why/stopCriteria/shareCriteria/ask）',
      ['"app"', '"goal"', '"query"', '"url"', '"why"', '"stopCriteria"', '"shareCriteria"', '"ask"']
        .every((k) => planSys.includes(k)));
    ok('计划：允许她说"不想去"（skip 契约 + 别硬编一件事）',
      planSys.includes('"skip"') && /不想去就不去/.test(planSys));
    ok('计划：不再写死"只能玩相册、浏览器"（范围放开）',
      !/只能玩手机上真有的东西/.test(planSys) && !/没有商店、没有游戏、没有音乐播放器/.test(planSys));
    ok('计划：删自己的日记是允许的（不再一刀切"删任何东西"）',
      /自己的日记可以写、可以删/.test(planSys) && !/绝对不许写/.test(planSys));
    ok('计划：不再硬编码"你叫小肥鱼，是个普通人"', !planSys.includes('你叫小肥鱼，是个普通人') && !planSys.includes('是个普通人'));

    /* ---------- 4. 手机那只手：没有人格、有她的口味 ---------- */

    const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'dsp-persona-'));
    const adb = {
      async state() { return { online: true, booted: true, screen: { width: 720, height: 1280 }, app: { package: 'mark.via', name: '浏览器' } }; },
      async screenshot() { const png = Buffer.from('89504e470d0a1a0a', 'hex'); return { ok: true, png, bytes: png.length, hash: 's1' }; },
    };
    const agentMod = ctx.mod('phone-agent');
    const agent = new agentMod.PhoneAgent({
      adb, model: { model: 'stub', baseUrl: 'http://127.0.0.1:1', maxTokens: 16, timeoutMs: 50 },
      dir, rescue: { enabled: false }, persona: s1,
    });
    const hand = agent.systemPrompt();
    ok('手：不再自称"你叫小肥鱼，只管动手机"', !hand.includes('你叫小肥鱼'));
    ok('手：开头明说"你是手，不是她本人"', hand.includes('你是她手机上的手，不是她本人'));
    ok('手：拿的是同一份快照里的口味', hand.includes('蓝色女仆'));
    ok('手：不是完整角色卡（没有"【你是谁"那一整段）', !hand.includes('【你是谁】'));
    ok('手：身份对不上就拒绝接这一场', agent.setPersona(tampered) === false && agent.persona === s1);
    ok('手：跟"开场那一份"不是同一个也拒绝（不是只自证）',
      agent.setPersona(s1, { expect: 'someone-else' }) === false && agent.persona === s1);

    /* ---------- 4b. 「去玩吧」：先开一场，下一次心跳由她自己排 ---------- */

    const lifeMod = ctx.mod('phone-life');
    const lifeDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'dsp-play-'));
    const fakeAgent = { state: () => ({ busy: false, screen: '' }), adb: {}, enqueue: () => ({ id: 't1', accepted: true }), setPersona: () => true, setBrief: () => {} };
    let plannedWhy = '';
    const life = lifeMod.createPhoneLife({
      dir: lifeDir,
      getCfg: () => ({ enabled: true, autonomy: { enabled: true, mode: 'free', from: 0, to: 24 } }),
      agentOf: () => fakeAgent,
      targetKey: () => 'private:1',
      isQuiet: () => true,
      persona: () => s1,
      plan: async ({ persona: snap }) => {
        plannedWhy = snap.personaId;
        return {
          theme: 'album', goal: '挑一张像我的图', why: '想看看像不像我',
          stopCriteria: '两屏没顺眼的就走', shareCriteria: '看到蓝发就想给他看',
          ask: '翻翻相册行吗', personaId: snap.personaId,
        };
      },
      log: { info: () => {}, warn: () => {} },
    });
    const play = life.beginPlayNow({ at: 1_700_000_000_000, key: 'private:1' });
    ok('去玩吧：先开一场（不卡回话），这一场等她自己排', play.ok === true
      && life._session().planPending === true && life._session().items.length === 0);
    await life.tick(1_700_000_000_000 + 1000);
    const s = life._session();
    ok('去玩吧：下一次心跳用的是她的 plan（why/stopCriteria/shareCriteria 都在）',
      !!s && !s.planPending && s.why === '想看看像不像我'
      && /两屏/.test(s.stopCriteria) && /蓝发/.test(s.shareCriteria) && s.items.length >= 1);
    ok('去玩吧：计划确实来自同一份快照', plannedWhy === s1.personaId && s.personaId === s1.personaId);

    /* ---------- 4c. 没有截图时，"停/再翻"用她自己的文字判断 ---------- */

    let judged = 0;
    const textJudge = new agentMod.PhoneAgent({
      adb, model: { model: 'stub', baseUrl: 'http://127.0.0.1:1', maxTokens: 16, timeoutMs: 50 },
      dir: fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'dsp-judge-')),
      rescue: { enabled: false }, persona: s1, vision: { enabled: false },
      personaJudge: async ({ persona: snap }) => { judged += 1; return { stop: snap.personaId === s1.personaId, why: '她的判断' }; },
    });
    const verdict = await textJudge.scanAsk({ app: { name: '浏览器' }, nodes: [] }, { goal: '挑图' });
    ok('判断：看不到图时也用她的口径（聊天 + 同一份快照），不退回通用分类', !!verdict && verdict.stop === true && judged === 1);

    /* ---------- 8. 问屏：只认"你现在看到什么" ---------- */
    ok('手：brief 里有"她为什么想做 / 什么时候算够"', (() => {
      const t = agent.systemPrompt(false, { brief: { goal: '挑一张图', why: '想看看像不像我', stopCriteria: '翻三屏没顺眼的就走' } });
      return t.includes('想看看像不像我') && t.includes('翻三屏没顺眼的就走');
    })());

    /* ---------- 5. 手机进度行：读时过滤，正常 20 轮不缩水 ---------- */

    const memDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'dsp-turns-'));
    const mem = new CompanionMemory({ dir: memDir });
    for (let i = 0; i < 20; i += 1) {
      mem.logTurn({ where: 'private:1', who: '✏️', text: `第${i}句真话`, reply: `第${i}句回答`, personId: '1' });
      mem.logTurn({ where: 'private:1', who: '✏️', text: '', reply: '往下翻了一屏，停在「浏览器」', personId: '1', kind: 'phone' });
    }
    const kept = mem.recentTurns(20, { where: 'private:1', excludePhone: true });
    ok('过滤：40 行里 20 行手机进度 → 仍然取到 20 轮真对话（不缩水）', kept.length === 20 && kept.every((r) => r.text));
    ok('过滤：文件本身一行没少（40 行都还在）', fs.readFileSync(mem.turnsFile, 'utf8').trim().split('\n').length === 40);
    ok('过滤：手机行还在文件里，只是不进视图', mem.recentTurns(40, { where: 'private:1' }).some((r) => r.kind === 'phone'));

    ok('旧行：21:33「搜出来了…小飞鱼加速器」算手机进度（读时跳过）',
      isPhoneTurn({ text: '', reply: '搜出来了。第一条小飞鱼加速器还是挂着，我跳过它往下看。' }) === true);
    ok('旧行：21:56「往下翻了一屏…加速器」算手机进度',
      isPhoneTurn({ text: '', reply: '往下翻了一屏，跳到结果页了，还是一堆小飞鱼加速器，头疼。' }) === true);
    ok('旧行：他问「看到什么」之后她真答的那句不算（别把她说过的话藏掉）',
      isPhoneTurn({ text: '你给我描述一下你现在看到的是什么', reply: '屏幕上就是一堆网页条目，清一色小肥鱼开头。' }) === false);
    ok('旧行：普通聊天不会被当成手机进度', isPhoneTurn({ text: '在吗', reply: '在。' }) === false);
    ok('新行：kind=phone 一定算', isPhoneTurn({ text: '', reply: '随便一句', kind: 'phone' }) === true);

    /* ---------- 6. 裁剪：先归档，再裁 ---------- */

    const trimDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'dsp-trim-'));
    const trimMem = new CompanionMemory({ dir: trimDir, maxTurns: 5 });
    for (let i = 0; i < 40; i += 1) {
      trimMem.logTurn({ where: 'private:1', who: '✏️', text: `第${i}句`, reply: `第${i}答`, personId: '1' });
    }
    const turnsNow = fs.readFileSync(trimMem.turnsFile, 'utf8').trim().split('\n');
    const archiveFile = path.join(trimDir, 'turns.archive.jsonl');
    const archived = fs.existsSync(archiveFile) ? fs.readFileSync(archiveFile, 'utf8').trim().split('\n') : [];
    ok('裁剪：裁到 maxTurns（5 行）', turnsNow.length === 5);
    ok('裁剪：被裁的 35 行先写进了 turns.archive.jsonl', archived.length === 35);
    ok('裁剪：归档没丢内容（第 0 句在归档里）', archived.some((l) => l.includes('第0句')));
    ok('裁剪：最新的还在 turns.jsonl 里', turnsNow[turnsNow.length - 1].includes('第39句'));

    /* ---------- 7. 归属：空 text 的那行是她 ---------- */

    const txt = formatTurns([
      { t: Date.now(), where: 'deskpet', who: '✏️', text: '', reply: '我有点困' },
      { t: Date.now(), where: 'private:1', who: '✏️', text: '在吗', reply: '在。' },
    ]);
    ok('归属：空 text 的行写成「她（桌宠）：…」，不是「对方：」', txt.includes('她（桌宠）：我有点困') && !txt.includes('对方（桌宠）：'));

    /* ---------- 8. 问屏：只认"你现在看到什么" ---------- */
    const intent = ctx.mod('phone-intent');
    for (const say of ['你现在看到什么', '屏幕上有什么', '这一页是什么', '你给我描述一下你现在看到的是什么', '描述一下你现在看到的', '这一屏是什么']) {
      ok(`问屏：认得出「${say}」`, intent.asksAboutScreen(say) === true);
    }
    for (const say of ['你刚才看到什么', '你觉得这一页怎么样', '你确定看到的是小飞鱼加速器？', '你往下滑了吗', '你还记得屏幕上是什么吗']) {
      ok(`问屏：不误认「${say.slice(0, 14)}…」`, intent.asksAboutScreen(say) === false);
    }

    /* ---------- 9. 静态守卫：只读 / 接线 ---------- */

    const personaSrc = fs.readFileSync(path.join(app, 'companion-persona.cjs'), 'utf8');
    ok('只读：人格源没有 fs / 没有任何写记忆模块的 require',
      !/require\(['"](?:node:)?fs['"]\)/.test(personaSrc)
      && !/require\(['"]\.\/(?:companion-memory|companion-self-kernel|companion-self|long-memory|memory-scribe)/.test(personaSrc));
    const lifeSrc = fs.readFileSync(path.join(app, 'phone-life.cjs'), 'utf8');
    /** 只看代码，不看注释（注释里会引用那句旧 prompt 做说明）。 */
    const codeOf = (src) => String(src).split('\n').filter((l) => !/^\s*(?:\*|\/\/|\/\*)/.test(l)).join('\n');
    ok('静态：手机计划不再硬编码「你叫小肥鱼，是个普通人」', !codeOf(lifeSrc).includes('你叫小肥鱼，是个普通人'));
    ok('静态：计划交给她的脑子（planPhone）', lifeSrc.includes('plan({') || lifeSrc.includes('await plan('));
    ok('静态：会话记着 personaId / why / stopCriteria / shareCriteria',
      lifeSrc.includes('personaId:') && lifeSrc.includes('stopCriteria:') && lifeSrc.includes('shareCriteria:'));
    ok('静态：wrap 的自我观察文案原样保留（P0 不动她的记忆）',
      lifeSrc.includes('我好像挺喜欢${t?.label || \'玩手机\'}，玩了一会儿才放下') && lifeSrc.includes('想玩手机，可这回什么也没弄成'));
    const agentSrc = fs.readFileSync(path.join(app, 'phone-agent.cjs'), 'utf8');
    ok('静态：手不再自称「你叫小肥鱼」', !codeOf(agentSrc).includes('你叫小肥鱼。你现在在用自己的手机'));
    ok('静态：手拿 handView（不是完整角色卡）', agentSrc.includes('personaMod.handView'));
    ok('静态：停/再翻用她自己的口味（judgeView）', agentSrc.includes('personaMod.judgeView'));
    ok('静态：手记着当前屏（回灌不靠聊天流水）', agentSrc.includes('this.lastScreen') && agentSrc.includes('noteScreen('));
    const videoSrc = fs.readFileSync(path.join(app, 'phone-video.cjs'), 'utf8');
    ok('静态：刷视频那只手也不再自称"你叫小肥鱼"', !codeOf(videoSrc).includes('你叫小肥鱼'));
    ok('静态：刷视频也用同一份快照（handView/judgeView）',
      videoSrc.includes('personaMod.handView') && videoSrc.includes('personaMod.judgeView'));
    ok('静态：开视频前先把快照交给手（对不上就不开）',
      fs.readFileSync(path.join(app, 'companion.cjs'), 'utf8').includes('persona: videoPersona'));
    const compSrc = fs.readFileSync(path.join(app, 'companion.cjs'), 'utf8');
    ok('静态：回灌带当前屏 + kind:phone', compSrc.includes('evidence: screen') && compSrc.includes("kind: 'phone'"));
    ok('静态：只有明确问"看到什么"才现场读一屏', compSrc.includes('asksAboutScreen') && compSrc.includes('lookNow()'));
    ok('静态：提案走她的嘴（speak → CompanionBrain）', compSrc.includes('speak: async') && lifeSrc.includes('await speak('));
    const brainSrc = fs.readFileSync(path.join(app, 'companion-brain.cjs'), 'utf8');
    ok('静态：聊天回看跳过手机进度行（excludePhone）', brainSrc.includes('excludePhone: true'));
    ok('静态：这一轮记得来源 kind（写进 turns 的只有元数据）', brainSrc.includes('kind,') && brainSrc.includes('logTurn({'));
  },
};
