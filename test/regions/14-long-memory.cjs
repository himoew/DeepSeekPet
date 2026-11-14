/**
 * 自检区域：长期记忆（2026-10-27 新增）
 *
 * 验的是「人和事能跨天、跨场合被找回来」这件事本身：
 *   · 分词 / BM25 / 时间衰减 / token 预算；
 *   · md 存储、按人隔离、归档、乐观压缩；
 *   · 旧 topics 迁移；
 *   · 后台整理员写人物账 + 记忆（假模型，不花真 token）；
 *   · 接进陪伴大脑 / 桌宠 0 挡的 system。
 *
 * 单跑：`node test\run-one.cjs 14-long-memory.cjs`
 */
module.exports = {
  name: '长期记忆（BM25 / 压缩）',
  tags: ['companion', 'memory', '记忆', 'long-memory'],
  async run(ctx) {
    const { ok, fs, path, http, llm } = ctx;
    const bm25 = ctx.mod('bm25');
    const { CompanionMemory } = ctx.mod('companion-memory');
    const { LongMemory } = ctx.mod('long-memory');
    const scribe = ctx.mod('memory-scribe');

    const quietLog = { info() {}, warn() {} };
    const mkMemory = (name) => new CompanionMemory({ dir: path.join(ctx.CONFIG_DIR, name) });
    const mkLong = (name, memory) => new LongMemory({
      dir: path.join(ctx.CONFIG_DIR, name),
      memory,
      log: quietLog,
    }).init();
    /** 只要一个干净的 LongMemory（游标/健壮性那几条用）。 */
    const mkLongMemory = (name) => mkLong(name, mkMemory(`${name}-turns`));

    /* ---------- A. 分词 / BM25 / 预算 ---------- */

    ok('分词：中文按 bigram 切', JSON.stringify(bm25.tokenize('我喜欢你')) === JSON.stringify(['我喜', '喜欢', '欢你']));
    ok('分词：英文整词转小写', bm25.tokenize('Hello world').join(',') === 'hello,world');
    ok('预算：CJK 每字 1，其余字符 ÷4', bm25.estimateTokens('你好abc') === 3);

    const index = new bm25.Bm25Index();
    const now = Date.now();
    index.add({ id: 'new', text: '小主在杭州换工作，压力有点大', keys: ['杭州', '换工作'], ts: now });
    index.add({ id: 'food', text: '今天吃了火锅', ts: now });
    index.add({ id: 'old', text: '旧事：换工作前在北京', ts: now - 100 * 86400000 });
    const hits = index.search('换工作', { topK: 3, halfLifeMs: 30 * 86400000 });
    ok('BM25：相关文档排在最前', hits[0]?.id === 'new');
    ok('BM25：时间衰减让旧文档靠后',
      hits.findIndex((x) => x.id === 'new') < hits.findIndex((x) => x.id === 'old'));
    ok('BM25：不相干的文档不出现', !hits.some((x) => x.id === 'food'));

    const selected = bm25.selectBodies([{ body: '一' }, { body: '一' }, { body: '二二二' }], 5, 3);
    ok('预算：重复正文只算一次', selected.length === 2 && selected[0] === '一');
    const clipped = bm25.selectBodies([{ body: '长'.repeat(20) }], 5, 1);
    ok('预算：一条都放不下时截断最高相关的那条', clipped.length === 1 && clipped[0].includes('已截断'));

    /* ---------- B. 存储 / 检索 / 隔离 ---------- */

    const mem1 = mkMemory('lm-store-companion');
    const lm1 = mkLong('lm-store-companion', mem1);
    mem1.remember('u1', { name: '小明', fact: '在杭州' });
    const e1 = lm1.write({ body: '小主在杭州，最近在换工作', person: 'u1', keys: ['杭州', '换工作'], importance: 4 });
    const e2 = lm1.write({ body: '小主喜欢喝乌龙茶', person: 'u1', keys: ['乌龙茶'] });
    const e3 = lm1.write({ body: '这是别人的秘密', person: 'u2' });
    ok('存储：一条记忆一个 md，能读回来', lm1.get(e1.id)?.body.includes('换工作'));
    ok('检索：按当前这句话能找到旧事', lm1.search('我换工作压力大', { personId: 'u1' })[0]?.entry.id === e1.id);
    ok('隔离：u2 的私事不会被 u1 检索到',
      !lm1.search('秘密', { personId: 'u1' }).some((x) => x.entry.id === e3.id));
    const eg = lm1.write({ body: '共同约定：周末一起看电影', person: 'global', scope: 'global', keys: ['约定', '电影'] });
    ok('隔离：global 的事所有人都能看到',
      lm1.search('周末约定', { personId: 'u2' }).some((x) => x.entry.id === eg.id));

    const recall1 = lm1.recall({
      personId: 'u1', personName: '小明', query: '我换工作压力大',
      topK: 3, tokenBudget: 200, recentTurns: 5,
    });
    ok('Recall：人物账 + 长期记忆都在', recall1.text.includes('一本账') && recall1.text.includes('长期记忆')
      && recall1.text.includes('换工作'));

    /* ---------- ★ 2026-11-02：回忆里要写清"哪天的" ---------- */

    /**
     * 用户报：「为什么她的念头（主动开口）会把日期说错」。
     * 真机：条目正文里写死的"今天/昨天/明天"几天后被检索出来，读起来还是"今天"。
     * 现在：`- 10-31：…` 前缀 + 相对词按 `created` 那天还原。
     */
    const frozenAt = new Date(2026, 9, 31, 12, 0, 0).toISOString(); // 本地 10-31 12:00
    lm1.write({
      body: '他今天中午才点薯条，上午先等着',
      person: 'u1', keys: ['薯条', '中午点'], created: frozenAt,
    });
    const recall2 = lm1.recall({
      personId: 'u1', personName: '小明', query: '薯条中午点了没',
      topK: 3, tokenBudget: 300, recentTurns: 0,
    });
    ok('长期记忆：每条前面带日期（10-31：…）', /^- \d{2}-\d{2}：/m.test(recall2.memoryText));
    ok('长期记忆：写死的"今天"按写入那天还原（旧账也治好）',
      recall2.memoryText.includes('10 月 31 日') && !recall2.memoryText.includes('今天中午'));

    const memMedia = mkMemory('lm-turn-media');
    memMedia.logTurn({
      where: 'private:u1', who: 'A', text: '你为什么在这里看一盘菜',
      reply: '我这刚翻到的', personId: 'u1', media: ['图'],
    });
    const recentMedia = memMedia.renderRecent(5, { where: 'private:u1' });
    ok('对话流水：她发出去的图留了痕（写了"发了图"）', recentMedia.includes('（发了图）'));
    ok('对话流水：每行带日期，不只是 HH:MM',
      /(今天|昨天|\d{2}-\d{2}) \d{2}:\d{2}/.test(recentMedia));
    memMedia.logTurn({ where: 'private:u1', who: 'A', text: '嗯', reply: '嗯', personId: 'u1' });
    ok('对话流水：没发图的那轮不会凭空写"发了图"',
      (memMedia.renderRecent(5, { where: 'private:u1' }).match(/（发了图）/g) || []).length === 1);

    // ★ 2026-10-30：人物账只挡“完全同一句”不够，近义/长句包含也要合并。
    mem1.applyProfile('u1', { traits: ['尊重对方自主性，不把对方当桌宠'] });
    mem1.applyProfile('u1', { traits: ['尊重对方自主性'] });
    const mergedTraits = mem1.allPeople().u1.traits.filter((x) => x.includes('尊重对方自主性'));
    ok('人物账：近义 trait 合并且保留更具体的一句',
      mergedTraits.length === 1 && mergedTraits[0].includes('不把对方当桌宠'));

    mem1.applyProfile('u1', { traits: ['上班一天会累'], facts: ['上班一天会累'] });
    const dedupedProfile = lm1.profileText('u1');
    ok('人物账：同一句不会同时出现在「你了解他」和「他告诉过你」',
      (dedupedProfile.match(/上班一天会累/g) || []).length === 1);

    const compactDir = path.join(ctx.CONFIG_DIR, 'cm-compact');
    fs.mkdirSync(compactDir, { recursive: true });
    fs.writeFileSync(path.join(compactDir, 'people.json'), JSON.stringify({
      u1: {
        name: 'A', traits: ['尊重对方自主性', '尊重对方自主性，不把对方当桌宠'],
        facts: [], topics: [], pending: [], interactions: 1,
      },
    }), 'utf8');
    const compactMem = new CompanionMemory({ dir: compactDir });
    const compacted = compactMem.compactAll();
    ok('人物账：compactAll 能清理历史遗留的近义重复',
      compacted === 1 && compactMem.allPeople().u1.traits.length === 1
      && compactMem.allPeople().u1.traits[0].includes('不把对方当桌宠'));

    const createdBefore = lm1.get(e2.id)?.created;
    lm1.update(e2.id, { body: '小主喜欢喝乌龙茶和咖啡' });
    ok('更新：正文改了，created 不变', lm1.get(e2.id)?.body.includes('咖啡')
      && lm1.get(e2.id)?.created === createdBefore);
    ok('删除：删掉就查不到', lm1.delete(e2.id) && lm1.get(e2.id) === null);

    /* ---------- C. 压缩：先写摘要，再归档原文 ---------- */

    const mem2 = mkMemory('lm-merge-companion');
    const lm2 = mkLong('lm-merge-companion', mem2);
    for (let i = 0; i < 3; i += 1) lm2.write({ body: `旧事 ${i}`, person: 'u1', kind: 'event', importance: 2 });
    const batch = lm2.oldest(3);
    const merged = lm2.mergeBatch(batch, '合并后的旧事：小主以前提过三件事。', 'compress');
    ok('压缩：3 条原文归档，活跃库只剩 1 条摘要',
      merged && merged.archived === 3 && lm2.stats().count === 1
      && lm2.list()[0].kind === 'summary');
    ok('压缩：原文还在 archive/ 里（可追溯）',
      fs.existsSync(path.join(lm2.archiveDir, `${batch[0].id}.md`)));
    ok('压缩：来源链记下压缩了哪几条', lm2.list()[0].sourceRange.startsWith('compress:'));

    /* ---------- C2. 确认 / 证据 / 清洗（2026-10-30） ---------- */

    const memC = mkMemory('lm-confirm-companion');
    const lmC = mkLong('lm-confirm-companion', memC);
    const oldIso = new Date(Date.now() - 120 * 86400000).toISOString();
    const ca = lmC.write({ body: '小主喜欢喝乌龙茶', person: 'u1', created: oldIso, updated: oldIso });
    lmC.write({ body: '小主喜欢喝乌龙茶', person: 'u1', created: oldIso, updated: oldIso });
    const freshC = lmC.get(ca.id);
    ok('确认：新条目 evidence=1，last_confirmed 默认等于 created',
      freshC.evidence === 1 && Date.parse(freshC.lastConfirmedAt) === Date.parse(freshC.created));
    const confirmedC = lmC.confirm(ca.id);
    ok('确认：再次被提到时 evidence+1、last_confirmed 前移，正文/created 不变',
      confirmedC.evidence === 2 && Date.parse(confirmedC.lastConfirmedAt) > Date.parse(ca.created)
      && confirmedC.body === '小主喜欢喝乌龙茶' && confirmedC.created === oldIso);
    ok('确认：排序用 last_confirmed（刚被确认的旧条目压过同文未确认的那条）',
      lmC.search('乌龙茶', { personId: 'u1', halfLifeDays: 30 })[0]?.entry.id === ca.id);
    ok('确认：重写后的 md 里真的带上了证据字段',
      fs.readFileSync(path.join(lmC.memoryDir, `${ca.id}.md`), 'utf8').includes('evidence: 2'));

    const rawRow = lmC.write({ body: '✏️：再试试 → 行，再试一次。', person: 'u1', source: 'migrated' });
    lmC.write({ body: '值得留的近况：他下周要搬家。', person: 'u1', kind: 'event' });
    const pruned = lmC.prune((entry) => entry.source === 'migrated' || entry.body.includes('→'));
    ok('清洗：流水账移进 archive/legacy，不删、不参与检索',
      pruned.moved === 1 && !lmC.list().some((entry) => entry.body.includes('→'))
      && fs.existsSync(path.join(lmC.archiveDir, 'legacy', `${rawRow.id}.md`))
      && lmC.read(rawRow.id)?.body.includes('再试试'));


    /* ---------- D. 旧 topics 迁移 ---------- */

    const mem3 = mkMemory('lm-migrate-companion');
    mem3.remember('u1', { name: '小明', topic: '旧话题一：在杭州' });
    mem3.remember('u1', { topic: '旧话题二：换工作' });
    const lm3 = mkLong('lm-migrate-companion', mem3);
    ok('迁移：旧 topics 变成长期记忆条目', lm3.list().length === 2);
    ok('迁移：topics 清空，避免新旧两套重复注入', mem3.allPeople().u1.topics.length === 0);
    ok('迁移：条目带 migrated 标签', lm3.list().every((entry) => entry.tags.includes('migrated')));
    lm3.forget();
    ok('清空：长期记忆和状态都清掉', lm3.stats().count === 0);

    /* ---------- E. 整理员：写人物账 + 记忆 ---------- */

    const mem4 = mkMemory('lm-scribe-companion');
    mem4.logTurn({ where: 'private:u1', who: '小明', text: '我在杭州，最近在换工作', reply: '辛苦啦', personId: 'u1' });
    mem4.logTurn({ where: 'private:u1', who: '小明', text: '新工作想离家近一点', reply: '那挺好', personId: 'u1' });
    const lm4 = mkLong('lm-scribe-companion', mem4);
    lm4.patchState({ lastExtractedAt: 0 });
    const prompts = [];
    const selfNotes = [];
    const selfStore = {
      KEEP_DAYS: 14,
      add: (items) => { selfNotes.push(...items); return items.length; },
      forget: () => { selfNotes.length = 0; },
    };
    const sc4 = scribe.createMemoryScribe({
      longMemory: lm4,
      memory: mem4,
      self: selfStore,
      callModel: async (model, messages) => {
        prompts.push(messages);
        if (String(messages[0]?.content || '').includes('归属判定员')) {
          return {
            text: JSON.stringify({
              him: { traits: ['常熬夜'], facts: ['在杭州'] },
              her: ['最近被夸时会先顶一句'],
              none: [],
            }),
          };
        }
        return {
          text: JSON.stringify({
            profile: { traits: ['常熬夜', '爱怼人'], facts: ['在杭州'] },
            memories: [{
              body: '小主最近在换工作，压力大，想找离家近的。',
              kind: 'event', scope: 'person', keys: ['换工作', '压力'], tags: ['工作'], importance: 4,
            }],
          }),
        };
      },
      getModel: () => ({ baseUrl: 'http://127.0.0.1:1', apiKey: 'x', model: 'fake' }),
      getConfig: () => ({ enabled: true, extractEveryTurns: 2, maxEntries: 160, maxTokens: 12000, compressBatch: 16 }),
      log: quietLog,
    });
    const extracted = await sc4.extractNow({ personId: 'u1', personName: '小明', where: 'private:u1' });
    ok('整理员：把这一段整理成 1 条长期记忆', extracted && extracted.written === 1
      && lm4.list().some((entry) => entry.body.includes('换工作')));
    ok('整理员：归属判定后只把他的 traits/facts 写进人物账',
      mem4.allPeople().u1.traits.includes('常熬夜')
      && !mem4.allPeople().u1.traits.includes('爱怼人')
      && mem4.allPeople().u1.facts.includes('在杭州'));
    ok('整理员：她的候选进“最近观察”，不写人物账',
      selfNotes.includes('最近被夸时会先顶一句'));
    ok('整理员：prompt 里真的带着这两轮对话',
      prompts[0]?.[1]?.content.includes('新工作想离家近'));
    ok('整理员：归属判定的 prompt 带着候选和对话',
      prompts[1]?.[1]?.content.includes('爱怼人')
      && prompts[1]?.[1]?.content.includes('新工作想离家近'));

    // ★ 2026-10-29：她的性子被整理员写成了“他”的 traits，再喂回去。
    // 现在只允许 profile 写“对方”的稳定信息；已有的账也要标清归属。
    ok('整理员：SYSTEM 只让他记“对方”的稳定信息，不写她的脾气/说话方式',
      scribe.SYSTEM.includes('profile 只写"对方（他）"')
      && scribe.SYSTEM.includes('profile 不写"她"')
      && scribe.SYSTEM.includes('这是她的自我描述')
      && scribe.SYSTEM.includes('不写评价性标签'));

    // 这里手动补一条，只为验证“已有的账”会标成“他（对方）的”。
    mem4.applyProfile('u1', { traits: ['手动加的 trait'] });
    const msgs2 = scribe.buildExtractionMessages({
      turns: mem4.recentTurns(10, { where: 'private:u1' }),
      person: mem4.allPeople().u1,
      personId: 'u1',
    });
    ok('整理员：已有的账标成“他（对方）的 traits/facts”',
      msgs2[1].content.includes('他（对方）的 traits：')
      && msgs2[1].content.includes('他（对方）的 facts：'));

    const capped = scribe.normalizeExtraction({
      profile: { traits: ['a', 'b', 'c', 'd'], facts: ['1', '2', '3', '4', '5', '6'] },
      memories: [],
    });
    ok('整理员：一次最多 3 条 traits / 5 条 facts',
      capped.traits.length === 3 && capped.facts.length === 5);

    /* ---------- ★ 2026-11-01：逐字流水 1200 轮 + 落后时先补最早的 ---------- */

    const memOrder = mkMemory('turn-order');
    ok('流水：默认留 1200 轮（400 只够装一天多）', memOrder.maxTurns === 1200);
    for (let i = 0; i < 130; i += 1) {
      memOrder.logTurn({ where: 'private:u1', text: `第${i}句`, reply: '嗯', personId: 'u1' });
    }
    const oldest = memOrder.turnsAfter(0, 60, { personId: 'u1' });
    ok('流水：落后 130 轮时，整理员拿到的是**最早**的 60 轮（原来取最新，中间那段永远漏掉）',
      oldest.length === 60 && oldest[0].text === '第0句' && oldest.at(-1).text === '第59句');

    const behind = scribe.buildExtractionMessages({ turns: oldest.slice(0, 2), person: null, personId: 'u1', backlog: 130 });
    const notBehind = scribe.buildExtractionMessages({ turns: oldest.slice(0, 2), person: null, personId: 'u1', backlog: 6 });
    ok(`整理员：落后超过 ${scribe.BACKLOG_WARN} 轮时 prompt 里提醒一句（没落后就不多嘴）`,
      behind[1].content.includes('积压') && behind[1].content.includes('130')
      && !notBehind[1].content.includes('积压'));

    /**
     * ★ 2026-11-01 修：**整理游标要按人各记一个**。
     *
     * 原来只有全局 `lastExtractedAt`，可 `extractNow()` 又按 `personId` 过滤 ——
     * 于是 A 整理一次就把游标推到 A 的时间，**B 在那之前说的话永远轮不到整理**
     * （实测：B 的 6 轮里 5 轮被跳过，`turnsSinceExtract` 还在涨）。
     */
    const lmCursor = mkLongMemory('cursor');
    ok('游标：没单独记过时退回全局值（老配置不用迁移）', (() => {
      lmCursor.patchState({ lastExtractedAt: 1000 });
      return lmCursor.cursorFor('anyone') === 1000;
    })());
    lmCursor.advanceCursor('A', 5000);
    ok('游标：记过 A 之后，A 用 5000、别人还用基准值（不被 A 拖走），互不影响',
      lmCursor.cursorFor('A') === 5000 && lmCursor.cursorFor('B') === 1000
      && lmCursor.getState().lastExtractedAt === 5000);
    lmCursor.advanceCursor('B', 3000);
    ok('游标：B 前进到 3000，A 不倒退，全局取最大',
      lmCursor.cursorFor('B') === 3000 && lmCursor.cursorFor('A') === 5000
      && lmCursor.getState().lastExtractedAt === 5000);

    /**
     * ★ 2026-11-01 修：**一条记忆的 tags/keys 写坏了，别让整条记忆"消失"**。
     * 原来 `JSON.parse` 裸着，list() 里 warn 跳过、get()/read() 静默返回 null。
     */
    const lmBad = mkLongMemory('bad-frontmatter');
    const badEntry = lmBad.write({ body: '他喜欢乌龙茶', kind: 'fact', person: 'u1', tags: ['t'] });
    const badFile = path.join(lmBad.memoryDir, `${badEntry.id}.md`);
    fs.writeFileSync(badFile, fs.readFileSync(badFile, 'utf8').replace('tags: ["t"]', 'tags: [坏掉'), 'utf8');
    const badList = lmBad.list();
    ok('健壮：tags 写坏了的记忆仍然读得出来（不再整条被跳过）',
      badList.length === 1 && badList[0].body.includes('乌龙茶') && badList[0].tags.length === 0);
    ok('健壮：get() 也读得到（以前这里静默返回 null）',
      !!lmBad.get(badEntry.id) && lmBad.get(badEntry.id).body.includes('乌龙茶'));

    const at = scribe.parseAttribution('```json\n' + JSON.stringify({
      him: { traits: ['常熬夜'], facts: ['在杭州'] },
      her: ['爱怼人', '最近被夸时会先顶一句'],
      none: ['不确定'],
    }) + '\n```');
    ok('归属判定：解析 him/her；已知自我标签会被挡掉',
      at && at.him.traits[0] === '常熬夜' && at.her.length === 1
      && at.her[0].includes('最近') && !at.her.join('').includes('爱怼人'));
    /**
     * ★ 2026-11-01：**"她怎么用某个功能"不是她的性情**。
     * 真机那条"最近被要求语音时，会先说明自己不太顺手"就是从这里写进 `self.jsonl` 的，
     * 然后每轮注入 → 她越来越像在反复确认接口。归属判定这一道也要挡。
     */
    const atVoice = scribe.parseAttribution(JSON.stringify({
      him: {},
      her: ['最近被要求语音时，会先说明自己不太顺手', '最近被夸时会先顶一句'],
      none: [],
    }));
    ok('归属判定：跟"语音/功能通不通"有关的观察被挡掉（只留相处方式）',
      atVoice && atVoice.her.length === 1 && atVoice.her[0].includes('顶一句'));
    ok('归属判定：有“依据归属”规则，防止把她的自述判成他',
      scribe.ATTRIBUTE_SYSTEM.includes('依据归属')
      // ★ 2026-11-04：她自己的自述不再只有 her 一个去处 —— 现在分成 her（反应）与 me（她自己的账），
      // 所以这句从"是 her，不是 him"改成"进 me…不进 him"，**规则本身没变**（还是按谁说划分）。
      && scribe.ATTRIBUTE_SYSTEM.includes('不进 him'));
    const at2 = scribe.parseAttribution(JSON.stringify({
      him: { traits: ['会做桌宠并内置陪伴模式', '常熬夜'], facts: ['之前做过一个桌宠', '在杭州'] },
      her: [],
      none: [],
    }));
    ok('归属判定：项目/桌宠类候选不写进他的账',
      at2 && at2.him.traits.length === 1 && at2.him.traits[0] === '常熬夜'
      && at2.him.facts.length === 1 && at2.him.facts[0] === '在杭州');

    const self = ctx.mod('companion-self');
    self.forget();
    self.add(['最近被夸时会先顶一句']);
    ok('自我观察：渲染成“最近你自己”，并提醒她这只是观察、会变',
      self.render().includes('【最近你自己】') && self.render().includes('你会变'));
    self.forget();

    /**
     * ★ 2026-11-01：**不写"她怎么用语音/功能"这类观察**（用户实测的口头禅来自这里）。
     * 三道都验：写入口不收、旧账不再注入、普通的相处方式照旧能写。
     */
    const wrote = self.add(['最近被要求语音时，会先说明自己不太顺手']);
    ok('自我观察：跟“语音/功能通不通”有关的观察不写（那是机器状态，不是性情）',
      wrote === 0 && self.all().length === 0 && !self.render().includes('语音'));
    ok('自我观察：普通的相处方式照旧能写', self.add(['最近被夸时会先顶一句']) === 1);
    fs.appendFileSync(self.FILE, `${JSON.stringify({
      at: Date.now(), lastAt: Date.now(), count: 1, source: 'legacy',
      text: '最近被要求语音时，会先说明自己不太顺手',
    })}\n`, 'utf8');
    ok('自我观察：修复前写进去的旧账不再进【最近你自己】', !self.render().includes('不太顺手'));
    self.forget();

    /* ---------- E2. 倾向层：证据 / 衰减 / 合并（2026-10-30） ---------- */

    const selfNow = Date.now();
    self.add(['最近被夸时会先顶一句'], { at: selfNow - 30 * 86400000 });
    self.add(['最近被夸时会先顶一句'], { at: selfNow - 2 * 86400000 });
    self.add(['最近会提醒对方早点歇'], { at: selfNow - 2 * 86400000 });
    self.add(['最近总在深夜发呆'], { at: selfNow - 30 * 86400000 });
    const selfAll = self.all();
    ok('倾向：同一件事再次出现 = 证据 +1，而不是多写一条',
      selfAll.length === 3 && selfAll.find((x) => x.text.includes('顶一句'))?.count === 2);
    const rankedSelf = self.recent({ now: selfNow, limit: 3 });
    ok('倾向：重复出现的排在单次前面，单次 30 天前的已淡出',
      rankedSelf[0]?.text.includes('顶一句')
      && !rankedSelf.some((x) => x.text.includes('深夜发呆')));
    self.add(['最近被夸时会先顶一句再收下'], { at: selfNow });
    const mergedSelf = self.all().find((x) => x.text.includes('顶一句'));
    ok('倾向：措辞更具体的同一条会合并并保留更具体的那句',
      mergedSelf?.count === 3 && mergedSelf.text.includes('再收下'));
    self.forget();

    const p = scribe.parseExtraction('```json\n' + JSON.stringify({
      profile: { traits: ['x'] },
      memories: [{ body: 'sk-abcdefghijklmnopqrstuvwx', keys: ['k'] }],
    }) + '\n```');
    ok('解析：容忍 ```json 围栏', p && p.traits[0] === 'x');
    ok('清洗：密钥形状被打码', p && p.memories[0].body.includes('已隐藏') && !p.memories[0].body.includes('sk-'));
    ok('模型就绪：在线端点没 Key 不算就绪', !scribe.modelReady({ baseUrl: 'https://api.example.com', model: 'x', apiKey: '' })
      && scribe.modelReady({ baseUrl: 'http://127.0.0.1:11434/v1', model: 'x', apiKey: '' }));

    const mem5 = mkMemory('lm-scribe-fail-companion');
    mem5.logTurn({ where: 'private:u1', who: 'A', text: '一句', reply: '一句', personId: 'u1' });
    mem5.logTurn({ where: 'private:u1', who: 'A', text: '两句', reply: '两句', personId: 'u1' });
    const lm5 = mkLong('lm-scribe-fail-companion', mem5);
    lm5.patchState({ lastExtractedAt: 0 });
    const sc5 = scribe.createMemoryScribe({
      longMemory: lm5,
      memory: mem5,
      callModel: async () => { throw new Error('boom'); },
      getModel: () => ({ baseUrl: 'http://127.0.0.1:1', apiKey: 'x', model: 'fake' }),
      getConfig: () => ({ enabled: true }),
      log: quietLog,
    });
    ok('失败：整理模型挂了不写脏数据，只记 lastError',
      (await sc5.extractNow({ personId: 'u1', personName: 'A' })) === null
      && lm5.getState().lastError.includes('boom') && lm5.stats().count === 0);

    // ★ 2026-10-29：归属判定失败时，宁可这一轮不写，也不能把她的东西写进他的账。
    const mem5b = mkMemory('lm-attribute-fail');
    mem5b.logTurn({ where: 'private:u1', who: 'A', text: '我在杭州', reply: '嗯', personId: 'u1' });
    mem5b.logTurn({ where: 'private:u1', who: 'A', text: '第二句', reply: '嗯', personId: 'u1' });
    const lm5b = mkLong('lm-attribute-fail', mem5b);
    lm5b.patchState({ lastExtractedAt: 0 });
    let calls5b = 0;
    const sc5b = scribe.createMemoryScribe({
      longMemory: lm5b,
      memory: mem5b,
      callModel: async () => {
        calls5b += 1;
        if (calls5b === 1) {
          return { text: JSON.stringify({ profile: { traits: ['爱怼人'], facts: ['在杭州'] }, memories: [] }) };
        }
        throw new Error('judge down');
      },
      getModel: () => ({ baseUrl: 'http://127.0.0.1:1', apiKey: 'x', model: 'fake' }),
      getConfig: () => ({ enabled: true }),
      log: quietLog,
    });
    const failed5b = await sc5b.extractNow({ personId: 'u1', personName: 'A' });
    const p5b = mem5b.allPeople().u1 || {};
    ok('归属判定失败：这一轮人物账一条不写，留 lastError',
      failed5b === null && lm5b.getState().lastError.includes('归属判定失败')
      && !(p5b.traits || []).includes('爱怼人') && !(p5b.facts || []).includes('在杭州'));

    /* ---------- F. 压缩触发 ---------- */

    const mem6 = mkMemory('lm-compress-companion');
    const lm6 = mkLong('lm-compress-companion', mem6);
    for (let i = 0; i < 5; i += 1) lm6.write({ body: `要压缩的记忆 ${i}`, person: 'u1', kind: 'event', importance: 2 });
    const sc6 = scribe.createMemoryScribe({
      longMemory: lm6,
      memory: mem6,
      callModel: async () => ({ text: '合并摘要：五件旧事。' }),
      getModel: () => ({ baseUrl: 'http://127.0.0.1:1', apiKey: 'x', model: 'fake' }),
      getConfig: () => ({ enabled: true, maxEntries: 2, maxTokens: 12000, compressBatch: 3 }),
      log: quietLog,
    });
    const compressed = await sc6.maybeCompress({ force: true });
    ok('压缩：超过容量时把最旧 3 条合并成一条', compressed && compressed.archived === 3
      && lm6.list().some((entry) => entry.kind === 'summary'));

    // ★ 2026-10-30：摘要不再参与压缩，避免“摘要的摘要”级联。
    const mem7 = mkMemory('lm-summary-skip-companion');
    const lm7 = mkLong('lm-summary-skip-companion', mem7);
    const s1 = lm7.write({ body: '旧摘要一', person: 'u1', kind: 'summary', importance: 2, created: oldIso, updated: oldIso });
    const s2 = lm7.write({ body: '旧摘要二', person: 'u1', kind: 'summary', importance: 2, created: oldIso, updated: oldIso });
    for (let i = 0; i < 4; i += 1) lm7.write({ body: `可压缩的原始事件 ${i}`, person: 'u1', kind: 'event', importance: 2 });
    const sc7 = scribe.createMemoryScribe({
      longMemory: lm7,
      memory: mem7,
      callModel: async () => ({ text: '合并摘要：四件原始事件。' }),
      getModel: () => ({ baseUrl: 'http://127.0.0.1:1', apiKey: 'x', model: 'fake' }),
      getConfig: () => ({ enabled: true, maxEntries: 1, maxTokens: 12000, compressBatch: 2 }),
      log: quietLog,
    });
    const compressed7 = await sc7.maybeCompress({ force: true });
    ok('压缩：摘要本身不参与再压缩（只压原始条目）',
      compressed7 && compressed7.archived === 2
      && lm7.get(s1.id) && lm7.get(s2.id)
      && !lm7.list().some((entry) => entry.kind === 'summary' && String(entry.sourceRange).includes(s1.id)));

    /* ---------- G. 接进陪伴大脑 / 桌宠 0 挡 ---------- */

    const startStub = (label) => new Promise((resolve) => {
      const seen = [];
      const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => {
          let body = null;
          try { body = JSON.parse(raw); } catch { /* 留 null */ }
          seen.push(body);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ choices: [{ message: { content: `${label}-回复` } }] }));
        });
      });
      server.listen(0, '127.0.0.1', () => resolve({
        server, seen, url: `http://127.0.0.1:${server.address().port}`,
      }));
    });
    const A = await startStub('A');
    const B = await startStub('B');
    try {
      llm.save({
        enabled: true, preset: 'custom', baseUrl: A.url, apiKey: 'key-a',
        model: 'desk-a', maxTokens: 64, timeoutMs: 5000,
        persona: '你是桌宠测试人设。',
      });
      const companion = ctx.mod('companion');
      const eventFile = path.join(ctx.CONFIG_DIR, 'lm-events.jsonl');
      fs.writeFileSync(eventFile, '', 'utf8');
      companion.save({
        enabled: true,
        adapter: 'kit-jsonl',
        kitEventsPath: eventFile,
        ownerIds: ['owner'],
        memory: { enabled: true },
        model: {
          mode: 'custom', baseUrl: B.url, apiKey: 'key-b', model: 'qq-b',
          maxTokens: 192, timeoutMs: 5000, keepAlive: '',
        },
        humanize: { enabled: false },
      });
      const owner = companion.publicState().ownerPersonId;
      companion.longMemory().write({
        body: '小主在杭州，最近在换工作，压力有点大。',
        person: owner, keys: ['换工作', '杭州'], importance: 4,
      });

      ok('手动「记住」：能识别并清洗正文',
        companion.parseRemember('记住：我喜欢乌龙茶') === '我喜欢乌龙茶');
      const beforeManual = companion.longMemory().stats().count;
      const manual1 = companion.rememberFromText({ text: '记住：我喜欢乌龙茶', personId: owner, where: 'deskpet' });
      const manual2 = companion.rememberFromText({ text: '记住：我喜欢乌龙茶', personId: owner, where: 'deskpet' });
      ok('手动「记住」：立刻写进长期记忆',
        manual1 && companion.longMemory().get(manual1.id)?.body === '我喜欢乌龙茶');
      ok('手动「记住」：重复说同一句不会堆两条',
        manual2 && companion.longMemory().stats().count === beforeManual + 1);

      const desk = companion.recallForDeskpet({ text: '我换工作压力好大', history: [] });
      ok('桌宠 0 挡：recallForDeskpet 能拿到长期记忆',
        desk.includes('长期记忆') && desk.includes('换工作'));

      const chat = await companion.chat({ text: '我换工作压力好大', record: false });
      const sys = B.seen.at(-1)?.messages?.[0]?.content || '';
      ok('陪伴大脑：system 里带上了检索到的长期记忆',
        chat.text.includes('B-回复') && sys.includes('长期记忆') && sys.includes('换工作'));

      // llm.chat 的 memoryText 参数：0 挡那条路把这段拼进 system
      await llm.chat([], '我换工作压力好大', 0, '测试', '', '', '【长期记忆】\n- 小主在杭州换工作');
      ok('桌宠 0 挡：llm.chat 的 system 里带上了 memoryText',
        A.seen.at(-1)?.messages?.[0]?.content?.includes('小主在杭州换工作'));

      companion.save({ enabled: false });

      /* ---------- H. 设置页「长期记忆」面板（2026-11-01） ---------- */

      /**
       * `long-memory.cjs` 早就有 `list/get/delete/stats/search`、`memory-scribe` 也有
       * `extractNow()` / `maybeCompress({force:true})` —— 但设置页一个入口都没有，
       * 用户只能翻 `data\companion\memory\*.md`。
       * 这里验"页面/预加载/主进程三层都接上了"，数据本身在 A~G 已经验过。
       */
      const html = fs.readFileSync(path.join(ctx.app, 'web', 'settings.html'), 'utf8');
      const preload = fs.readFileSync(path.join(ctx.app, 'settings-preload.cjs'), 'utf8');
      const settingsSrc = fs.readFileSync(path.join(ctx.app, 'settings.cjs'), 'utf8');
      ok('面板：设置页有「长期记忆」这张卡（搜索 + 列表 + 删除 + 整理/压缩）',
        html.includes('id="longMemoryCard"') && html.includes('长期记忆')
        && ['lmSearch', 'lmList', 'lmFind', 'lmExtract', 'lmCompress'].every((id) => html.includes(`id="${id}"`)));
      ok('面板：三个 IPC 都在主进程里接了（列表 / 删除 / 整理压缩）',
        ['companion:memoryList', 'companion:memoryDelete', 'companion:memoryCompact']
          .every((ch) => settingsSrc.includes(`'${ch}'`)));
      ok('面板：preload 暴露了三个方法（页面拿不到 ipcRenderer）',
        ['companionMemoryList', 'companionMemoryDelete', 'companionMemoryCompact']
          .every((m) => preload.includes(m)));
      ok('面板：删除走的是现成的 long-memory.delete（没在这里新写记忆逻辑）',
        /companion:memoryDelete[\s\S]{0,400}longMemory\(\)\.delete/.test(settingsSrc));
      // 面板列出来的字段就是列表要显示的那几样（时/类/人/正文）
      const row = companion.longMemory().list()[0];
      ok('面板：一条记忆该有 when/kind/person/body（列表就显示这四样）',
        !!row && ['id', 'kind', 'person', 'body'].every((k) => row[k] !== undefined));
    } finally {
      A.server.close();
      B.server.close();
    }
  },
};
