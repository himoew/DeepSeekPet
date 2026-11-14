/**
 * 自检区域：**她的想象** —— `companion-imagine.cjs`（2026-11-05，第三十一笔 P0）
 *
 * 这一区验的是**产品规矩**，不是实现细节。改之前先读
 * `docs\陪伴模式\她的想象-调研与方案-2026-11-05.md`：
 *
 *   ① **系统一个字都不许描述**（她原话：「你把描述直接递到我眼前，那不叫我想象，
 *      那叫我被喂画面。自己拼出来的才叫想象。」）
 *   ② **一眼只添一件**（模型一次写五行也只收第一件，否则就是一段描写）
 *   ③ **浓度由代码算**（她自己说"很清楚"不算数）
 *   ④ **L3 要跨趟 + 一次自我修正**（最清楚的画面只有回头再看时才到得了）
 *   ⑤ **想象不落记忆**（不进账 / 不进长期记忆 / 不推心情 —— 文件级隔离）
 *   ⑥ 回看时，"我想的"那一轮要带来源（想象膨胀：反复想会当成经历过的）
 *
 * 全是纯逻辑 + 假模型，不连网：`node test\run-one.cjs 24-imagine.cjs`
 */
module.exports = {
  name: '她的想象（一个词 → 一眼一件）',
  tags: ['imagine', '想象', '记忆', '她'],
  async run(ctx) {
    const { ok } = ctx;
    const im = ctx.mod('companion-imagine');
    const caps = ctx.mod('companion-capabilities');
    im.forget();

    /**
     * ★ 2026-11-06：**基准时间改成"现在"**。
     *
     * 原来写死 `1793900000000`（11-05 深夜）。`view()` 用的是 `Date.now()`，
     * 所以隔一天再跑，"刚想过的那张"已经超过 L1 的 90 分钟 → `active.length` 变 0，
     * 自检自己红了（功能没坏）。会衰减的东西不能用写死的绝对时间当基准。
     */
    const T0 = Date.now();
    /** 假模型：按顺序回 `answers`，并记下每次收到的 messages（最后一句会一直重复）。 */
    const seq = (answers) => {
      let i = 0;
      const calls = [];
      const fn = async (messages, opts) => {
        calls.push({ messages, opts });
        const text = answers[Math.min(i, answers.length - 1)];
        i += 1;
        return { text, raw: { usage: { prompt_tokens: 10, completion_tokens: 10 } } };
      };
      fn.calls = calls;
      return fn;
    };

    /* ---------- 1. 起手只有一个词（这是整件事的地基） ---------- */
    const m1 = im.buildEyeMessages({ seed: '猫', rec: { lines: [], unsure: [] } });
    ok('想象：这一眼的 prompt 里**只有那个词**，系统一个字都没描述',
      /脑子里只有「猫」/.test(m1[1].content) && !m1[0].content.includes('猫'));
    ok('想象：user 那边短到只有一句话（喂进去的是词，不是画面）', m1[1].content.length < 60);
    ok('想象：教的是"只添一件"和"不许形容词堆"',
      m1[0].content.includes('只添一件') && m1[0].content.includes('形容词'));

    const m2 = im.buildEyeMessages({
      seed: '猫',
      rec: { lines: [{ label: '看', text: '窗台上趴着一团灰' }], unsure: ['看不清眼睛'] },
    });
    ok('想象：第二眼带回去的是**她自己写的那句原话**（不是我们复述）',
      m2[1].content.includes('看：窗台上趴着一团灰') && m2[1].content.includes('还空着：看不清眼睛'));

    /* ---------- 2. 解析：细节 / 空白 / 修正 / 还要不要看 ---------- */
    const p = im.parseStep('看：窗台上趴着一团灰，背对着我\n?：看不清眼睛\n改：尾巴刚才记成白的了\n还想看');
    ok('想象：一眼的输出拆成"细节 / 空白 / 修正 / 还要不要看"',
      p.lines.length === 1 && p.unsure.length === 1 && !!p.revision && p.flow === 'more');
    ok('想象：模型不按标签写时兜底收第一句（真机第一版就整句白描）',
      im.parseStep('窗台外沿有一截灰白色的水泥，上面印着半个湿爪印').lines.length === 1);
    ok('想象：兜底也只取第一句（一段话不会被整段收进来）',
      im.parseStep('窗台上趴着一团灰。耳朵是白的，尾巴尖一抽。').lines[0].text
      === '窗台上趴着一团灰');
    ok('想象：算了 = 没想出来（合法结果）', im.parseStep('算了').flow === 'giveup');
    ok('想象：够了 + 留一句印象',
      im.parseStep('够了\n留：就剩个尾巴尖').flow === 'enough'
      && /尾巴尖/.test(im.parseStep('够了\n留：就剩个尾巴尖').impression));

    /* ---------- 3. 浓度是数出来的 ---------- */
    ok('想象：浓度 L0 = 只有一个影子', im.score({ lines: [{ kind: 'see' }] }) === 0);
    ok('想象：2 处 = L1（主要看添了几件，这是"越看越细"最直接的量）',
      im.score({ lines: [{ kind: 'see' }, { kind: 'see' }] }) === 1);
    ok('想象：4 处、而且换过通道 = L2',
      im.score({ lines: [{ kind: 'see' }, { kind: 'see' }, { kind: 'hear' }, { kind: 'hear' }] }) === 2);
    const six = [
      { kind: 'see' }, { kind: 'see' }, { kind: 'hear' },
      { kind: 'hear' }, { kind: 'temp' }, { kind: 'body' },
    ];
    ok('想象：L3 要 6 处 + 3 通道 + **一次自我修正**（少一样就到不了）',
      im.score({ lines: six, revisions: 0 }) === 2 && im.score({ lines: six, revisions: 1 }) === 3);
    ok('想象：她自己说"非常清晰"不算数（浓度只看她真正添了几件）',
      im.score({ lines: [{ kind: 'see' }], level: 3, clear: '非常清晰' }) === 0);

    /* ---------- 4. 跑一趟：想 → 还想看 → 够了 ---------- */
    im.forget();
    const f1 = seq(['看：窗台上趴着一团灰\n还想看', '摸：毛是糙的，它刚从外面回来\n够了']);
    const r1 = await im.run({ seed: '猫', callModel: f1, at: T0 });
    ok('想象：跑一趟，第二眼看到"够了"就停', r1.ok && r1.eyes === 2 && r1.rec.status === 'done');
    ok('想象：两处细节、两个通道 = L1', r1.rec.lines.length === 2 && r1.rec.level === 1);
    ok('想象：只在第二眼才带"你刚才已经想到的"', !f1.calls[0].messages[1].content.includes('刚才已经想到')
      && f1.calls[1].messages[1].content.includes('你刚才已经想到的'));
    ok('想象：调用时关掉思考（不然每眼先想 20 秒）',
      f1.calls[0].opts.thinking && f1.calls[0].opts.thinking.type === 'disabled');

    /* ---------- 5. 一眼只收一件 ---------- */
    im.forget();
    const f2 = seq(['看：a\n听：b\n摸：c\n够了']);
    const r2 = await im.run({ seed: '灯', callModel: f2, at: T0 });
    ok('想象：模型一次回五行也只收第一件（否则就是一段描写，不是想象）',
      r2.rec.lines.length === 1 && r2.rec.lines[0].label === '看');

    /* ---------- 6. 想不出来是合法结果 ---------- */
    im.forget();
    const r3 = await im.run({ seed: '雪', callModel: seq(['算了']), at: T0 });
    ok('想象：想不出来就说算了（不报错、不留空条）',
      r3.ok && r3.rec.status === 'gaveup' && r3.rec.lines.length === 0);

    /* ---------- 7. 模型挂了别编 ---------- */
    im.forget();
    const r4 = await im.run({
      seed: '海',
      callModel: async () => { throw new Error('陪伴模型返回 HTTP 503'); },
      at: T0,
    });
    ok('想象：模型挂了就如实失败，不编一个画面出来', r4.ok === false && /503/.test(r4.why));
    ok('想象：失败这趟不写进 imagine.jsonl（下次还能重来）', im.readLines().length === 0);

    /* ---------- 8. 冷却 ---------- */
    im.forget();
    await im.run({ seed: '门', callModel: seq(['看：门缝里透进来一条黄光\n还想看']), at: T0 });
    const r6 = await im.run({ seed: '门', callModel: seq(['看：还有一个字']), at: T0 + 2 * 60_000 });
    ok('想象：同一个词 30 分钟内不重想（她就这点注意力）', r6.ok === false && r6.why === 'cool');

    /* ---------- 9. 接着看：L3 要跨两趟 ---------- */
    im.forget();
    const fA = seq(['看：窗台上趴着一团灰\n还想看', '听：外面在下雨\n还想看', '温度：窗玻璃是凉的\n还想看']);
    const A = await im.run({ seed: '猫', callModel: fA, at: T0, maxEyes: 3 });
    const fB = seq(['摸：毛是糙的\n还想看', '改：尾巴刚才我记成白的了\n听：雨点砸在空调外机上\n还想看', '身体：我靠在柜子边上\n够了']);
    const B = await im.run({ seed: '猫', callModel: fB, at: T0 + 35 * 60_000, maxEyes: 3 });
    ok('想象：隔一阵接着看（同一个画面，不是从头来）',
      B.ok && A.ok && B.rec.id === A.rec.id && B.rec.lines.length === 6);
    ok('想象：一次看不完也留在 open（不然第二趟就接不上）', A.rec.status === 'open');
    ok('想象：她要是连看两眼都是"看"，下一眼提醒换个通道（只提醒通道，不给内容）',
      /换个地方试试：听|换个地方试试：摸/.test(fA.calls[2].messages[1].content));
    ok('想象：L3 到了 —— 6 处、3 个通道、还有一次"刚才记错了"',
      B.rec.level === 3 && B.rec.revisions >= 1);

    /* ---------- 10. 淡掉：只看不回想 ---------- */
    const faded = im.decay({ ...B.rec }, T0 + 35 * 60_000 + 25 * 3_600_000);
    ok('想象：不理它 25 小时就淡了（L3 也留不住）', faded.status === 'faded');
    ok('想象：淡了只留一句印象（"就剩个尾巴尖"本身就是内容）', !!faded.impression);

    /* ---------- 11. 一天最多几次 ---------- */
    im.forget();
    let last = null;
    for (let i = 0; i < im.DAY_MAX + 1; i += 1) {
      last = await im.run({ seed: `物${i}`, callModel: seq(['看：一个东西\n够了']), at: T0 });
    }
    ok(`想象：一天最多 ${im.DAY_MAX} 次（防跑飞）`, last.ok === false && last.why === 'day-max');

    /* ---------- 12. 触发与取词 ---------- */
    ok('想象：只在"对她说"的时候才想',
      im.wants('你想象一下猫') && im.wants('帮我脑补一个雪夜') && !im.wants('当你内心想象某个词时，我把描述放到你眼前'));
    ok('想象：讨论这个功能本身不算（别让功能自己撞上去）', im.wants('我在想想象能力怎么实现') === false);
    ok('想象：别想了 = 不想', im.wants('别想了，睡吧') === false);
    ok('想象：一句话里只抠一个词',
      im.pickSeed('你想象一下猫趴在窗台上打呼噜') === '猫' && im.pickSeed('帮我脑补一个雪夜') === '雪夜');
    /**
     * ★ 真机第一次测试用的说法就是这两个，当时一个都没认（于是那次根本没走到这条路）。
     * 这两个断言是**从真实对话里抄回来的**，别再让它退化。
     */
    ok('想象：「试试想一下冰箱里有什么」认（他第一次测试的原话）',
      im.wants('如果一切正常的话，你现在的脑子里应该多了一些想象力，试试想一下冰箱里有什么')
      && im.pickSeed('如果一切正常的话，你现在的脑子里应该多了一些想象力，试试想一下冰箱里有什么') === '冰箱');
    ok('想象：「想象一下你的房间」取到"房间"（不是"你"）',
      im.pickSeed('想象一下你的房间') === '房间' && im.pickSeed('想象一下一只猫趴在窗台上') === '猫');
    ok('想象：「想想看」「闭上眼想」「脑子里想」也认',
      im.wants('你想想看猫') && im.wants('闭上眼想一下海') && im.wants('脑子里想个雪夜'));
    /**
     * ★ 第二次真机：他发的是 `✏️：想象一下你的小手`（QQ 昵称前缀把行首的 ^想象 挡住了）。
     * 入站已经会剥，但**触发层不该依赖上游干净**。
     */
    ok('想象：带"昵称："前缀也认（`✏️：想象一下你的小手`）',
      im.wants('✏️：想象一下你的小手') && im.pickSeed('✏️：想象一下你的小手') === '小手');
    ok('想象：抠不出一个干净词就不做（宁可不做，别拿半句话当种子）',
      im.pickSeed('你想象某个词') === '' && im.cleanSeed('猫趴在窗台上') === '');
    ok('想象：「你想想怎么办」不是让她想一样东西（那是问办法）',
      im.pickSeed('你想想怎么办啊') === '' && im.pickSeed('你想想他今天为什么没回我') === '');

    /* ---------- 13. 端给她的那段 ---------- */
    const withIm = caps.buildCapabilityHints({ imagine: { seed: '猫', text: im.brief(B.rec) } });
    ok('想象：想过之后她 system 里多一段"这是你想的，不是真发生的"',
      withIm.includes('是你自己想出来的') && withIm.includes('不是真发生过的'));
    ok('想象：没想的那一轮 system 里没有"想象"两个字（别让她每句都想）',
      !caps.buildCapabilityHints({}).includes('想象'));
    ok('想象：不写"你能看见"这种话（她没眼睛，那是把想象说成知觉）',
      !/你能看见|你看见了/u.test(withIm));
    ok('想象：端给她的是结构不是描写（有浓度、不超过 240 字）',
      /清楚到什么程度/.test(im.brief(B.rec)) && im.brief(B.rec).length <= 240);

    /* ---------- 13. 窗口（「她想的」并进账本，2026-11-05 P2） ---------- */
    im.forget();
    const w1 = seq(['看：窗台上趴着一团灰\n还想看', '听：外面在下雨\n够了']);
    await im.run({ seed: '猫', callModel: w1, at: T0 });
    const v1 = im.view();
    ok('想象：窗口里"开着的"只列一张（快照流按 id 折叠，不然一条画面会出现四五次）',
      v1.active.length === 1 && v1.active[0].seed === '猫' && v1.active[0].lines.length === 2);
    ok('想象：窗口给的浓度是人话（L2 立体了），页面不用自己翻译',
      /^L\d /.test(v1.active[0].text));
    const w2 = seq(['摸：毛是糙的\n够了']);
    const rw = await im.run({ seed: '猫', callModel: w2, at: T0 + 5 * 60_000, force: true });
    ok('想象：窗口里"再想一眼"还在同一张上（force 绕冷却，但不新开一张）',
      rw.ok && im.view().active.length === 1 && im.view().active[0].lines.length === 3);
    const droppedId = im.view().active[0].id;
    ok('想象：窗口能删一张', im.drop(droppedId).ok === true && im.view().active.length === 0);
    ok('想象：删掉的那张退到"最近的"里，标 dropped（和"淡了"区别开）',
      im.view().recent.some((r) => r.id === droppedId && r.status === 'dropped'));

    const compSrc = fs.readFileSync(path.join(app, 'companion.cjs'), 'utf8');
    ok('想象：账本窗口一次拿到账 + 想的一屏（selfView 里拼 imagine）',
      compSrc.includes('selfView: () => ({ ...selfKernel.view(), imagine: imagine.view() })'));
    ok('想象：「让她想一个」走主进程（force 绕冷却、where=window）',
      compSrc.includes('imagineNow') && compSrc.includes("where: 'window'"));
    const setSrc = fs.readFileSync(path.join(app, 'settings.cjs'), 'utf8');
    ok('想象：窗口的两个 IPC 在（想一个 / 删一张）',
      setSrc.includes("'self:imagine'") && setSrc.includes("'self:imagineDrop'"));
    const pre = fs.readFileSync(path.join(app, 'self-preload.cjs'), 'utf8');
    ok('想象：preload 只暴露这两个动作，页面碰不到文件',
      pre.includes('imagine: (seed)') && pre.includes('imagineDrop: (id)'));
    const page = fs.readFileSync(path.join(app, 'web', 'self.html'), 'utf8');
    ok('想象：那张卡就在账本窗口里（\"她想的\"）', page.includes('她想的'));
    const card = page.slice(page.indexOf('id="imagine"'), page.indexOf('id="imagine"') + 900);
    ok('想象：卡片里别写成"记下来"（想象不是记忆）', card.length > 50 && !card.includes('记下来'));

    /* ---------- 14. 隔离：想象不落记忆、不推心情（文件级） ---------- */
    const src = fs.readFileSync(path.join(app, 'companion-imagine.cjs'), 'utf8');
    ok('想象：这个模块根本不 require 记忆/账/心情（隔离是文件级的，不只靠自觉）',
      !/require\('\.\/(mood|long-memory|companion-self-kernel|companion-memory|companion-self)\.cjs'\)/u.test(src));

    const M = ctx.mod('companion-memory');
    const mem = new M.CompanionMemory({ dir: path.join(ctx.CONFIG_DIR, 'imagine-test') });
    mem.logTurn({ where: 'private:1', who: '他', text: '你想象一下猫', reply: '我闭眼过了一下。', personId: '1', im: true });
    mem.logTurn({ where: 'private:1', who: '他', text: '你好', reply: '嗯。', personId: '1' });
    const rows = mem.recentTurns(2, { where: 'private:1' });
    ok('想象：说出口的那一轮在对话流里带 im 标记（真事和想的不能混）',
      rows[0].im === true && rows[1].im === undefined);

    const brainSrc = fs.readFileSync(path.join(app, 'companion-brain.cjs'), 'utf8');
    ok('想象：回看历史时，"我想的"那一轮带来源前缀',
      brainSrc.includes('（这是我脑子里想的，不是真事）'));
    ok('想象：主链只在私聊里想（群里突然开始想象会很怪）',
      brainSrc.includes("!String(key).startsWith('group:')"));

    /* ---------- 15. 清空 ---------- */
    im.forget();
    ok('想象：清空记忆时她也把"想过的"一起清',
      im.readLines().length === 0 && im.readState().open.length === 0);
  },
};
