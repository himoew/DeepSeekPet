/**
 * 自检区域：她自己的账（锚 / 账 / 传）—— `companion-self-kernel.cjs`
 *
 * 2026-11-04 起，她的自我从"3 条最近被X时，会Y"变成**以她为主语的账**：
 * 证词（她说过的话 + 当时什么滋味）攒着 → 攒够/她想写 → **写一笔**（ADD/REVISE/RETIRE）→
 * 注入时排在他那本账**前面**。
 *
 * 这一区只验纯逻辑（不连模型、不开窗口）：能单跑
 *   `node test\run-one.cjs 23-self-kernel.cjs`
 *
 * ⚠️ 这几条是**产品规则**，不是实现细节，改之前先读
 * `docs\陪伴模式\她的自我内核-诊断与方案-2026-11-04.md`：
 *   · 证词不许直接进账（否则一句口头禅当天变成性格）
 *   · 被夸出来的行为不算她的偏好（防谄媚）
 *   · 允许这一趟什么都不写（她的原话："不用天天都得出点什么"）
 *   · 账里不许有无人称形容词（"她很温柔"）
 */
module.exports = {
  name: '她的账（自我内核）',
  tags: ['self', 'self-kernel', '她的账', '记忆'],
  async run(ctx) {
    const { ok } = ctx;
    const k = ctx.mod('companion-self-kernel');
    const scribeMod = ctx.mod('memory-scribe');

    /* ---------- 1. 空的账什么也不说 ---------- */
    k.forget();
    ok('她的账：还没有任何条目时，注入的那段是空串（别硬编）', k.render() === '');
    ok('她的账：一开始也没有证词', k.readEvidence().length === 0);

    /* ---------- 2. 落一条账 ---------- */
    const a = k.add({ kind: 'taste', claim: '比起被夸可爱，我更记得他说话时停顿的地方', source: 'intrinsic', at: 1793700000000 });
    ok('她的账：落一条 taste', a.ok && a.entry.kind === 'taste' && !a.merged);
    const text1 = k.render({ now: 1793700000000 });
    ok('她的账：注入里有【我自己的口味】和那句话',
      text1.includes('【我自己的口味】') && text1.includes('停顿的地方'));
    ok('她的账：注入时带一句"这是倾向不是规定"（不然就成了台本）',
      text1.includes('不是规定') && text1.includes('[自己:改'));

    /* ---------- 3. 近似重复是"证据 +1"，不是再来一条 ---------- */
    const b = k.add({
      kind: 'taste',
      claim: '比起被夸可爱，我更记得他说话时停顿的地方，尤其是停完之后那半句',
      source: 'intrinsic',
      at: 1793700000001,
    });
    ok('她的账：同一句换个措辞不新增，而是证据 +1', b.ok && b.merged === true);
    const tasteList = k.entries().filter((e) => e.kind === 'taste');
    ok('她的账：账上还是一条（别长成六个变体，people.json 吃过这个亏）', tasteList.length === 1);
    ok('她的账：那条的 count 变成 2', tasteList[0].count === 2);
    ok('她的账：合并时留更具体的那一句', /停完之后那半句/.test(tasteList[0].claim));

    /* ---------- 4. 锚 / 干过的事 / 变过的 ---------- */
    k.add({ kind: 'anchor', claim: '这名字是我认的', source: 'her', at: 1793700000002 });
    k.add({ kind: 'doing', claim: '翻了一下午歌单，没听几首', source: 'behavior', at: 1793703600000 });
    k.add({ kind: 'change', claim: '以前嫌他啰嗦，现在觉得有人叮嘱也不坏', source: 'her', at: 1793703600000 });
    const text2 = k.render({ now: 1793703600000 + 86400000 });
    ok('她的账：锚排在口味前面（她认下的事先说话）',
      text2.indexOf('【我认下的】') < text2.indexOf('【我自己的口味】'));
    ok('她的账："我干过的事"带日期（不然过几天就成了"前段时间"）',
      /【我干过的事】[\s\S]*?(今天|昨天|\d{2}-\d{2})/.test(text2));
    ok('她的账："我变过的地方"单独一栏', text2.includes('【我变过的地方】'));

    /* ---------- 5. 预算：超了只丢低优先级，不截半句 ---------- */
    for (let i = 0; i < 30; i += 1) {
      k.add({ kind: 'stance', claim: `第 ${i} 条看法：${'啰'.repeat(20)}`, source: 'her', at: 1793700000000 + i });
    }
    const tight = k.render({ now: 1793700000000, maxChars: 300 });
    ok('她的账：注入有字数上限（400 token 以内，不抢他账的预算）', tight.length <= 300);
    ok('她的账：压预算时锚不丢', tight.includes('【我认下的】'));

    /* ---------- 6. 退休：不删原文，"她变过了"也是信息 ---------- */
    const id = k.entries().find((e) => e.kind === 'doing').id;
    ok('她的账：退休一条', k.retire(id, '那天其实不算数').ok);
    ok('她的账：退休后不再注入', !k.render({ now: 1793700000000, maxChars: 4000 }).includes('翻了一下午歌单'));
    ok('她的账：但条目还在（status=retired），能翻回去', k.entries().some((e) => e.id === id && e.status === 'retired'));

    /* ---------- 7. 证词：只收"她自己在说我自己"的那几句 ---------- */
    const picked = k.pickSelfSentences('嗯，你去琢磨。我挺喜欢吃甜的，你别管我。 你想吃啥');
    ok('她的账：挑得出"我挺喜欢吃甜的"', picked.some((s) => s.includes('喜欢吃甜')));
    ok('她的账：不把"你想吃啥"当成她的自我', !picked.some((s) => s.includes('你想吃啥')));
    ok('她的账：叙述句"我想了一下这事"不算表态', k.pickSelfSentences('我想了一下这事，觉得还行。').length <= 1);

    /* ---------- 8. 证词带"当时的滋味" ---------- */
    const n = k.capture({ at: 1793705000000, where: 'private:10000001', said: '我好像真有点饿了', flavor: '深夜·困倦', src: 'turn' });
    ok('她的账：收下一条证词', n === 1);
    const ev = k.readEvidence();
    ok('她的账：证词记住了"当时什么滋味"（她的原话要求）', ev.some((e) => e.flavor === '深夜·困倦'));

    /* ---------- 9. `[自己:…]` 暗号 ---------- */
    const tagged = k.parseTags('好。\n[自己:记一下 我不喜欢被安排]\n就这样。');
    ok('她的账：认出 [自己:…] 并从正文里摘掉', tagged.cmds.length === 1 && !tagged.text.includes('[自己'));
    ok('她的账：摘掉之后句子还在', tagged.text.includes('就这样'));
    const before = k.readEvidence().length;
    k.applyTags(tagged.cmds, { at: 1793706000000, where: 'deskpet', flavor: '晚上' });
    ok('她的账："记一下 X" 进证词（不是直接进账）',
      k.readEvidence().length === before + 1 && !k.entries().some((e) => /被安排/.test(e.claim)));
    ok('她的账：她想写就能写（[自己:写一笔] 只排队，不在聊天里当场改自己）',
      (() => { k.applyTags(['写一笔'], { at: 1793706000000 }); return k.readState().pendingWrite > 0; })());

    /* ---------- 10. 什么时候写：攒够 / 她想写 / 太久没写 ---------- */
    ok('她的账：她想写的时候 whyWrite 说是她的意思', k.whyWrite() === 'her');
    k.markJudged({ at: 1793707000000, result: 'test' });
    ok('她的账：写完一笔之后游标清零', k.readState().evidenceSince === 0 && k.readState().pendingWrite === 0);
    ok('她的账：刚写完不该马上再写', k.whyWrite() === '');
    for (let i = 0; i < k.MIN_EVIDENCE; i += 1) k.capture({ at: 1793707000000 + i, said: `我有点想法${i}`, src: 'turn' });
    ok(`她的账：攒够 ${k.MIN_EVIDENCE} 条证词就该写一笔（不是按钟点，用户晚上关机）`, k.whyWrite() === 'enough');

    /* ---------- 11. 给档案管理员的那份 prompt ---------- */
    const built = k.buildJudgeMessages({ since: 0, maxOps: 3 });
    const system = built.messages[0].content;
    ok('她的账：写一笔的提示词带着她自己的两条要求',
      system.includes('被主人夸奖') && system.includes('允许什么都不写'));
    ok('她的账：提示词禁止无人称形容词', system.includes('无人称形容词'));
    ok('她的账：提示词要求带上当时的滋味', system.includes('滋味'));
    ok('她的账：证词带编号（能指回去）', built.messages[1].content.includes('e1'));
    ok('她的账：现行账也给它看（不然它会把已有的再写一遍）', built.messages[1].content.includes('她现在的账'));

    /* ---------- 12. 解析他的回包（模型经常带围栏） ---------- */
    ok('她的账：能解析裸 JSON',
      (k.parseOps('{"ops":[{"op":"ADD","kind":"taste","claim":"x"}]}') || {}).ops?.length === 1);
    ok('她的账：能解析 ```json 围栏',
      (k.parseOps('```json\n{"ops":[],"passed":"今天没想写"}\n```') || {}).passed === '今天没想写');
    ok('她的账：乱码返回 null（不炸）', k.parseOps('我觉得她挺好的') === null);
    ok('她的账：允许这一趟什么都不写', (k.parseOps('{"ops":[],"passed":"没什么"}') || {}).ops?.length === 0);

    /* ---------- 13. 落账：只认四种操作 ---------- */
    const beforeCount = k.active().length;
    const stat = k.applyOps([
      { op: 'ADD', kind: 'want', claim: '想自己在阳台站一会儿', source: 'intrinsic', evidence: ['e1'] },
      { op: 'ADD', kind: 'taste', claim: '', evidence: ['e2'] },
      { op: 'DELETE_ALL', claim: '把账全删了' },
    ], { at: 1793708000000 });
    ok('她的账：ADD 落一条', stat.added === 1 && k.active().length === beforeCount + 1);
    ok('她的账：空 claim 不算一条', stat.skipped >= 1);
    ok('她的账：不认识的操作原样丢掉（别让模型写坏文件）',
      !k.entries().some((e) => /把账全删了/.test(e.claim)));
    const wantId = k.entries().find((e) => e.kind === 'want').id;
    const st2 = k.applyOps([{ op: 'REVISE', id: wantId, claim: '想在阳台站一会儿，顺便抽口气' }], { at: 1793708100000 });
    ok('她的账：REVISE 改一条', st2.revised === 1
      && k.entries().find((e) => e.id === wantId).claim.includes('顺便抽口气'));
    const st3 = k.applyOps([{ op: 'RETIRE', id: wantId, why: '不想了' }], { at: 1793708200000 });
    ok('她的账：RETIRE 不算了', st3.retired === 1);
    ok('她的账：一次最多 3 个操作（模型说要删十条也只落三条）',
      k.applyOps(Array.from({ length: 8 }, (_, i) => ({ op: 'ADD', kind: 'stance', claim: `批量 ${i}` })), { at: 1793708300000 }).added <= 3);
    const st4 = k.applyOps([{ op: 'CONFLICT', id: wantId, claim: '我其实想去阳台', why: '和旧说法矛盾' }], { at: 1793708400000 });
    ok('她的账：矛盾不覆盖，记成 CONFLICT 留给以后', st4.conflicts === 1);

    /* ---------- 14. 给人看的那份 ---------- */
    ok('她的账：kernel.md 会生成（给人看的那份，不参与注入）', ctx.fs.existsSync(k.KERNEL));
    const view = k.view();
    ok('她的账：窗口要的一屏有 state / ledger / evidence / chronicle',
      view && view.state && Array.isArray(view.ledger) && Array.isArray(view.evidence) && Array.isArray(view.chronicle));
    ok('她的账：窗口里能看到"攒了几条、写了几笔"',
      typeof view.state.judgeCount === 'number' && typeof view.state.evidenceSince === 'number');
    ok('她的账：证词在窗口里带地点（QQ / 桌宠）',
      view.evidence.some((e) => e.where === 'QQ' || e.where === '桌宠'));

    /* ---------- 15. 传（一周一篇） ---------- */
    k.appendChronicle('这一周翻了半张歌单，剩下的时间在发呆。他问我怎么了，我说没什么。', 1793709000000);
    const ch = k.readChronicle();
    ok('她的账：传按日期分节读回来', ch.length === 1 && /^\d{4}-\d{2}-\d{2}$/.test(ch[0].date));
    ok('她的账：传的正文在', ch[0].text.includes('翻了半张歌单'));
    ok('她的账：账上新增够多才值得写传', typeof k.wantChronicle() === 'boolean');

    /* ---------- 16. 用户 2026-11-04 当场抓到的那个错：他账里的"对方"指的是她 ---------- */
    /**
     * ⚠️ 这一条是**回归守卫**，别再改回去。
     *
     * 我一度以为 `people.json` 里「会主动逗对方（如摸头、戳肚子）」的主语是她，
     * 还写了一段"把她挪到自己账上"的迁移 —— **反了**。
     * 他账里的「对方」指的就是**她**：「会主动逗对方」= 他逗她；「叫她小笨鱼」也是他（实测对话里 3 次都在他那边）。
     * 那段代码已经删了，这里留一条断言：**他账里的这类 traits 必须原样保住**。
     */
    const himTraits = [
      '会主动逗对方（如摸头、戳肚子、举高高）',
      '喜欢用昵称/比喻称呼对方（如"小笨鱼"）',
    ];
    ok('她的账：他账里的"逗对方/叫她小笨鱼"是他的行为，不是她的（11-04 反过一次）',
      himTraits.every((t) => /对方/.test(t)) && k.coreOf(himTraits[0]) === '会主动逗对方');
    ok('她的账：她账上不会凭空长出"逗对方"（没有证据就没有条目）',
      k.active().every((e) => !/逗对方/.test(e.claim)));

    /* ---------- 16b. 合并：同类的近义条目收成一条 ---------- */
    k.forget();
    k.add({ kind: 'taste', claim: '喜欢出题/列计划让对方动手做事', source: 'behavior', force: true, at: 1793711000000 });
    k.add({ kind: 'taste', claim: '喜欢出题/列步骤让对方动手做事', source: 'behavior', force: true, at: 1793711000001 });
    k.add({ kind: 'taste', claim: '喜欢出题/列步骤的方式让对方动手做事', source: 'behavior', force: true, at: 1793711000002 });
    k.add({ kind: 'taste', claim: '喜欢半夜翻歌单', source: 'intrinsic', at: 1793711000003 });
    const merged = k.consolidate({ at: 1793711000004 });
    ok('她的账：三个"喜欢出题…"变体收成一条', merged.merged === 2);
    ok('她的账：合并只退休、不删除（原文还能翻到）',
      k.entries().filter((e) => e.status === 'retired').length === 2);
    ok('她的账：不相干的那条没被连坐', k.active().some((e) => /翻歌单/.test(e.claim)));
    ok('她的账：合并后次数相加（不是丢掉证据）',
      k.active().find((e) => /出题/.test(e.claim)).count >= 3);

    /* ---------- 17. 陪伴记忆清空时一起清 ---------- */
    k.forget();
    ok('她的账：清空之后目录没了、注入也回到空串',
      !ctx.fs.existsSync(k.DIR) && k.render() === '' && k.readEvidence().length === 0);

    /* ---------- 18. 归属判定的新口子：me / 主语的拦截 ---------- */
    const parsed = scribeMod.parseAttribution(JSON.stringify({
      him: { traits: ['会主动逗对方（如摸头）', '在深圳', '爱怼人'], facts: [] },
      her: ['被夸先顶一句'],
      me: [
        { kind: 'taste', claim: '我不爱听人催', quote: '别催我', source: 'intrinsic', flavor: '来气' },
        { kind: 'xxx', claim: '随便说一句也行', quote: '', source: 'yyy' },
      ],
      none: [],
    }));
    ok('她的账：归属能解析出 me 那一栏', parsed && parsed.me.length === 2);
    ok('她的账：me 的分类不合法就归到 taste（别写坏）', parsed.me[1].kind === 'taste');
    ok('她的账：source 不合法就归到 intrinsic', parsed.me[1].source === 'intrinsic');
    ok('她的账：他账里的"逗对方"原样保住（他的行为，不是她的 —— 11-04 反过一次）',
      parsed.him.traits.some((t) => /逗对方/.test(t)));
    ok('她的账：他真正的信息还留在他账上', parsed.him.traits.includes('在深圳'));
    ok('她的账：她自己的话不写进他的账', parsed.me.every((x) => !parsed.him.traits.includes(x.claim)));
  },
};
