/**
 * 自检区域：她自己的日记本（P0，2026-11-11）
 *
 * 用户这一轮定的四条，这一区逐条钉死：
 *   ① **不能强迫她写** —— 她回"不写"就收工；提示词里没有"今天还没写"这种催促；
 *   ② **不限字数** —— 700 字切成 300/300/100，逐段敲、逐段核对；
 *   ③ **她想翻就能翻** —— 目录由 App 列，主进程也能读原文；
 *   ④ **删一篇要有痕迹，连着删 2 篇要提醒他** —— `judgeDeletes()` 的窗口/去重。
 *
 * 单跑：`node test\run-one.cjs 31-diary.cjs`
 */
module.exports = {
  name: '她的日记本（写 / 翻 / 删 / 连删提醒）',
  tags: ['companion', 'phone', '手机', 'diary', '日记'],
  async run(ctx) {
    const { ok } = ctx;
    const diary = ctx.mod('her-diary');
    const intent = ctx.mod('phone-intent');
    const apps = ctx.mod('phone-apps');

    /* ---------- 1. 认句子：他让她写，认得出；其余不认 ---------- */

    const yes = ['写日记', '写日记吧', '去写日记吧', '写一篇日记', '写篇日记呗', '记日记', '你现在去写日记', '帮我写日记'];
    for (const say of yes) {
      const r = intent.ownerCommand(say);
      ok(`指令：认得出「${say}」`, !!r && r.kind === 'diary' && r.goal === '写日记');
    }
    const no = ['你写的日记呢', '别写日记', '你想写日记吗', '看看你写的日记', '写封信'];
    for (const say of no) {
      ok(`指令：不认「${say}」`, intent.ownerCommand(say) === null);
    }
    ok('目标词：写日记 → isDiaryGoal', diary.isDiaryGoal('写日记'));
    ok('目标词：翻日记 → isLookGoal', diary.isLookGoal('翻翻我的日记'));
    ok('目标词：搜日记模板不是写日记', !diary.isDiaryGoal('搜日记模板'));

    /* ---------- 2. 不限字数：切段 + 清正文 ---------- */

    const parts = diary.segments('字'.repeat(700));
    ok('切段：700 字 → 300/300/100', JSON.stringify(parts.map((x) => x.length)) === '[300,300,100]');
    ok('切段：短句原样一段', diary.segments('今天不想说话').length === 1);
    ok('切段：空正文也有一段的形状', diary.segments('').length === 1);

    const cleaned = diary.cleanBody('（心里想）\n# 今天\n[手机:保存]\n那只猫趴着。\n\n第二行');
    ok('清正文：去掉标签/标题/旁白/空行', cleaned === '今天\n那只猫趴着。\n第二行');

    /* ---------- 3. 不强迫：她说"不写"就真的不写 ---------- */

    ok('不强迫：回"不写"算不写', diary.saysNo('不写'));
    ok('不强迫：回"算了"算不写', diary.saysNo('算了'));
    ok('不强迫：回空也算不写', diary.saysNo('   '));
    ok('不强迫：写了一句就不算"不写"', !diary.saysNo('那只猫趴着'));

    /* ---------- 4. 写完之后核对（治"她说写好了其实没写"） ---------- */

    const body = '那只猫趴在窗台上，半天没动。我看了它很久，它连耳朵都没抬。';
    ok('核对：首页第一条含正文开头 → 通过', diary.verifyWritten(['11-11 21:03  那只猫趴在窗台上，半天没动。我看了它很久……'], body));
    ok('核对：对不上 → 不通过', !diary.verifyWritten(['11-11 21:03  今天天气不错'], body));

    /* ---------- 5. 连删提醒：窗口 / 去重 / 单篇不打扰 ---------- */

    const T = Date.parse('2026-11-11T21:00:00+08:00');
    const mk = (min) => ({ at: T + min * 60_000, file: `f${min}.md`, gist: `第 ${min} 篇`, len: 12 });
    const judge = (entries, opt) => diary.judgeDeletes(entries, { at: T, windowMin: 30, alertAt: 2, ...opt });

    ok('连删：只删 1 篇 → 不提醒', judge([mk(0)]).alert === false);
    const two = judge([mk(0), mk(5)], { at: T + 6 * 60_000, sinceAt: T + 1 });
    ok('连删：窗口内第 2 篇 → 提醒', two.alert === true);
    ok('连删：提醒里带两篇的日期和开头', two.items.length === 2 && /第 0 篇/.test(diary.deleteHint(two)));
    ok('连删：同一串已经提醒过 → 不再提醒', judge([mk(0), mk(5)], { at: T + 6 * 60_000, sinceAt: T + 1, lastAlertAt: T + 5 * 60_000 }).alert === false);
    ok('连删：第 3 篇并入同一串，也不再提醒', judge([mk(0), mk(5), mk(9)], { at: T + 10 * 60_000, sinceAt: T + 6 * 60_000, lastAlertAt: T + 6 * 60_000 }).alert === false);
    ok('连删：隔了 40 分钟只删了 1 篇 → 不提醒（重新数）', judge([mk(0), mk(40)], { at: T + 41 * 60_000, sinceAt: T + 39 * 60_000 }).alert === false);
    ok('连删：没有删除记录 → 不提醒', judge([]).alert === false);

    const bad = diary.parseLog('{"at":1794402896099,"file":"a.md","gist":"猫","len":1}\n{半行\n');
    ok('流水：坏行不算一次删除', bad.length === 1 && bad[0].gist === '猫');

    /* ---------- 6. App 知识：她知道本子存在，但没被催 ---------- */

    const app = apps.lookup('com.bluefish.diary');
    ok('App 知识：认得出她的日记本', !!app && app.name === '她的日记本');
    ok('App 知识：能写 / 能翻 / 能删', ['写一篇', '翻以前的', '删掉一篇'].every((x) => (app.can || []).includes(x)));
    ok('App 知识：tips 里没有"该写了"这种催促', !/该写|还没写|坚持|打卡/.test((app.tips || []).join('')));
    ok('App 知识：tips 说清"不写也没人问"', /不写也没人问/.test((app.tips || []).join('')));

    /* ---------- 7. 把正文敲进手机：真机的动作序列，用假手机演 ---------- */

    const N = (text, extra = {}) => ({
      ref: 'n0', text, desc: '', class: extra.class || 'TextView', clickable: true, editable: !!extra.editable,
      scrollable: false, checkable: false, checked: false, enabled: true,
      bounds: extra.bounds || [0, 0, 40, 40], center: extra.center || [20, 20], pkg: 'com.bluefish.diary',
    });
    const W = N('写', { center: [100, 100] });
    const SAVE = N('保存', { center: [900, 100] });
    const BOX = N('想写什么就写什么，写多长都行', { class: 'EditText', editable: true, center: [360, 600] });
    const ROW = (t) => N(t, { center: [360, 900] });

    const mkFake = ({ forget = false } = {}) => {
      const st = { screen: 'main', draft: '', row: '', taps: 0, typed: 0 };
      return {
        st,
        async sh() { return { code: 0, out: '', err: '' }; },
        async launch() { st.screen = 'main'; return { ok: true }; },
        async observe() {
          if (st.screen === 'write') {
            const box = { ...BOX, text: st.draft || '想写什么就写什么，写多长都行' };
            return { ok: true, nodes: [box, SAVE] };
          }
          return { ok: true, nodes: [W, st.row ? ROW(st.row) : N('还什么都没写')] };
        },
        async tapXY(x, y) {
          st.taps += 1;
          if (x === 100 && y === 100) st.screen = 'write';
          else if (x === 900 && y === 100) {
            st.screen = 'main';
            if (!forget) st.row = `11-11 21:03  ${st.draft}`;
          }
          return { ok: true };
        },
        async text(v) { st.draft += v; st.typed += 1; return { ok: true }; },
      };
    };

    const fake = mkFake();
    const long = '那只猫趴在窗台上，半天没动。'.repeat(30); // 450 字 → 两段
    const w1 = await diary.push(fake, long);
    ok('敲进手机：两步都输入了（450 字切两段）', fake.st.typed === 2);
    ok('敲进手机：字一个不少', fake.st.draft.length === diary.cleanBody(long).length);
    ok('敲进手机：写完回读核对通过', w1.ok && w1.verified === true);
    ok('敲进手机：点了「写」和「保存」各一次', fake.st.taps === 3);

    const fake2 = mkFake({ forget: true });
    const w2 = await diary.push(fake2, '短的一句');
    ok('敲进手机：存了但首页对不上 → verified=false（不许说写好了）', w2.ok === true && w2.verified === false);
    ok('敲进手机：空正文直接不动手', (await diary.push(mkFake(), '   ')).ok === false);

    /* ---------- 8. 接线与红线（静态） ---------- */

    const srcDiary = ctx.fs.readFileSync(ctx.path.join(ctx.app, 'her-diary.cjs'), 'utf8');
    const srcComp = ctx.fs.readFileSync(ctx.path.join(ctx.app, 'companion.cjs'), 'utf8');
    ok('接线：companion 认 isDiaryGoal 并走 startDiaryWrite', /isDiaryGoal/.test(srcComp) && /startDiaryWrite/.test(srcComp));
    ok('接线：每一步都顺手看一眼删除（sweepDiary）', /sweepDiary\(\{ key: ev\.key/.test(srcComp));
    ok('红线：代码里没有"今天还没写"这种提醒', !/今天还没写/.test(srcDiary) && !/今天还没写/.test(srcComp));
    ok('红线：日记的"不写"就真的收工（没有重试/劝）', /saysNo\(body\)/.test(srcComp));
    ok('红线：删除不记账、不写成习惯', !/selfKernel\.addDoing[\s\S]{0,200}删/.test(srcComp));
  },
};
