/**
 * 自检区域：她自己的手机生活（2026-10-31 新增，P0「自己会玩」）
 *
 * 验的是**判断**，不是模拟器也不是模型：
 *   · 需求条会涨、到门槛才起事（0 调用）
 *   · 想干什么 → **先请示他**；他不点头绝不动手（2026-10-31 用户拍板的规矩）
 *   · 他点头 → 就去办**那一件**（第三轮改动：不再列 2~4 件），带自己的小预算和 `src:'session'`
 *   · 会话里的子任务**静默记账**，一次会话只回灌一条
 *   · 收尾写日记、推进"手上那件事"
 *   · **取消每天三次上限**（第三轮改动）；但冷却还在；手动让她做的事不占额度
 *
 * 单跑：`node test\run-one.cjs 18-phone-life.cjs`
 */
module.exports = {
  name: '她的手机（自己会玩）',
  tags: ['companion', 'phone', 'life', '自主'],
  async run(ctx) {
    const { ok, fs, path } = ctx;
    const os = require('node:os');
    const lifeMod = ctx.mod('phone-life');

    /* ---------- 1. 常量与工具 ---------- */

    ok('生活：三个主题都是这台机器真能做的', Object.keys(lifeMod.THEMES).sort().join(',') === 'album,browse,collect');
    ok('生活：日跨天键是本地时区（不是 UTC）', lifeMod.dayKey(new Date(2026, 9, 31, 0, 30).getTime()) === '2026-10-31');
    /**
     * ★ 2026-11-01：**心事轮换也按本地日**。
     * 原来用 `Math.floor(at / 86_400_000)`（UTC 天），和 `dayKey()` 差 8 小时 ——
     * 本地早上八点（UTC 零点）心事突然换一条，用户会觉得"她半夜换了心思"。
     */
    ok('生活：心事轮换按本地日（本地 0:30 和 8:30 是同一天，跨过本地零点才换）',
      lifeMod.localDayIndex(new Date(2026, 9, 31, 0, 30).getTime())
        === lifeMod.localDayIndex(new Date(2026, 9, 31, 8, 30).getTime())
      && lifeMod.localDayIndex(new Date(2026, 9, 31, 23, 30).getTime())
        !== lifeMod.localDayIndex(new Date(2026, 10, 1, 0, 30).getTime()));
    ok('生活：端点（点头）先判否定', lifeMod.NO_RX.test('不行') && !lifeMod.NO_RX.test('行'));
    ok('生活：点头认"行/去吧/可以"', lifeMod.YES_RX.test('行，去吧') && lifeMod.YES_RX.test('可以') && lifeMod.YES_RX.test('ok'));
    /**
     * ★ 2026-11-01 修：**整句锚定** —— 以前只要开头像就当成点头，实测这五句全被误判。
     * 误判后果很重：扣 35 点需求、`approvedToday+1`、她真去动最多 25 分钟手机。
     */
    ok('生活：像"好困啊/行不行"这种**不算**点头（以前会被误判成批准）',
      ['好困啊', '好累', '好看吗', '行不行', '嗯我知道了'].every((t) => !lifeMod.NO_RX.test(t) && !lifeMod.YES_RX.test(t)));
    ok('生活：真正的应允照旧认（含"嗯，你去吧"这种两段式）',
      ['好吧', '去吧', '没问题', '嗯，你去吧', '行！！'].every((t) => lifeMod.YES_RX.test(t)));
    ok('生活：JSON 能从围栏和废话里抠出来', (() => {
      const j = lifeMod.pickJson('好的，我给你排了：\n```json\n{"theme":"album","items":["a"]}\n```\n就这样');
      return j && j.theme === 'album' && j.items[0] === 'a';
    })());
    ok('生活：抠不出来就返回 null（不抛）', lifeMod.pickJson('我想去玩') === null);
    /**
     * ★ 2026-11-02：单件预算从 5 步 / 45 秒放宽到 **8 步 / 120 秒** ——
     * 用户拍板"一次管 15 分钟"，而配合滚动层 1 步能看 3 屏，8 步够她翻完一整个列表。
     * 上限仍然卡死（不是无限），治"9 步原地打转"。
     */
    ok('生活：单件小目标有硬上限（8 步 / 3 分钟内）',
      lifeMod.SESSION.item.maxSteps === 8 && lifeMod.SESSION.item.maxMs <= 120_000);

    /* ---------- 2. 造一个能演的"她 + 一部假手机" ---------- */

    /**
     * @param {object} o
     * @param {string} [o.planReply]  模型排计划时回什么（不传 = 模型坏了，走兜底牌）
     * @param {boolean} [o.busy]      手机忙不忙
     */
    function rig({ planReply = '', cfg = {}, busy = false, launchFails = 0, plan = null, quiet = true } = {}) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsp-life-'));
      const seen = [];
      const state = { busy, enqueued: [], said: [], followed: [], self: [], snaps: 0, launchTries: 0 };
      const agent = {
        state: () => ({ busy: state.busy, queued: 0 }),
        enqueue: (o) => { state.enqueued.push(o); return { id: `t${state.enqueued.length}`, accepted: true }; },
        adb: {
          openUrl: async (u) => { state.opened = u; return { ok: true }; },
          launch: async (app) => {
            state.launchTries += 1;
            state.launched = app;
            // ★ 2026-11-01：可以演"打不开"（前 N 次失败）
            return state.launchTries <= launchFails ? { ok: false, error: '模拟器没开' } : { ok: true, pkg: 'com.android.gallery3d' };
          },
        },
      };
      const conf = {
        enabled: true,
        // ★ 2026-10-31 第三轮：`maxPerDay: 0` = 不限（用户要求取消三次上限）
        autonomy: { mode: 'ask', enabled: true, everyMin: 90, maxPerDay: 0, from: 0, to: 24 },
        ...cfg,
      };
      const life = lifeMod.createPhoneLife({
        dir,
        getCfg: () => conf,
        agentOf: () => agent,
        targetKey: () => 'private:1',
        isQuiet: () => (typeof quiet === 'function' ? !!quiet() : quiet !== false),
        say: async (o) => { state.said.push(o); },
        followUp: async (r) => { state.followed.push(r); },
        readNotes: async () => '\uFEFF小肥鱼的便签\n- 今天要记得把相册收拾一下',
        model: () => ({ model: 'stub' }),
        callModel: planReply ? async () => ({ text: planReply }) : async () => { throw new Error('模型挂了'); },
        /** ★ 2026-11-12：开放目的地那条路（真机上 `plan` = `CompanionBrain.planPhone`）。 */
        ...(plan ? { plan } : {}),
        /**
         * ★ 2026-11-12：`makePlan` 只在**有人格快照**时才走开放计划
         * （取不到快照就只抽兜底牌 —— 那是"不换人"的规矩）。自检给一份最小快照。
         */
        ...(plan ? {
          persona: () => ({
            personaId: 'test-persona',
            roleText: '',
            core: { anchors: [], taste: [], stance: [], doing: [], want: [], change: [] },
            mood: {},
            phone: {},
          }),
        } : {}),
        noteSelf: (t) => state.self.push(t),
        emit: (e) => seen.push(e),
        log: { info: () => {}, warn: () => {} },
      });
      return { life, dir, state, seen, conf };
    }

    const T0 = new Date(2026, 9, 31, 14, 0).getTime();   // 10-31 14:00
    const hours = (n) => n * 3600_000;
    /**
     * 假时钟往前走。
     * 注意"两件之间歇 8~25 秒"是 `PhoneAgent` 用**真** `Date.now()` 记的，
     * 所以假时间得越过真时间，不然机器跑得慢的时候会被 `at < nextAt` 挡住（自检会偶发失败）。
     */
    const step = (at, ms = 30_000) => Math.max(at + ms, Date.now() + ms);

    /* ---------- 3. 需求条 ---------- */

    {
      const { life } = rig();
      const s = life.state(T0);
      ok('需求：三条都是 0~100', ['boredom', 'share', 'curiosity'].every((k) => s.needs[k] >= 0 && s.needs[k] <= 100));
      ok('需求：她手上本来就有件事（不是空的）', !!s.focus && !!s.focus.text && s.focus.got === 0);

      // 精确验一下"涨"：把无聊压到 10，过 20 分钟应该正好涨 6（0.3/分钟）
      await life.tick(T0);
      const st0 = life._st();
      st0.needs.boredom = 10;
      st0.needsAt = T0;
      await life.tick(T0 + 20 * 60_000);
      ok('需求：20 分钟涨 6（0.3/分钟）', Math.abs(life.state(T0 + 20 * 60_000).needs.boredom - 16) < 1.1);
      ok('需求：涨不过 100', life.state(T0).needs.boredom <= 100);
    }

    /* ---------- 4. 请示：模型坏了也要能问出一句人话 ---------- */

    {
      const { life, state } = rig();          // 模型挂了 → 走兜底牌
      const r = await life.tick(T0);
      ok('请示：需求到门槛就起来问', r.ok === true && !!r.asked);
      ok('请示：真的发出去了一条（走 QQ）', state.said.length === 1 && /行|玩|相册|逛/.test(state.said[0].text));
      ok('请示：说的是人话、不是 JSON', !state.said[0].text.includes('{') && state.said[0].text.length <= 120);
      /**
       * ★ 2026-11-02（用户点名）：请示那句话**不许像任务单**。
       * 旧版会补一个"（想翻相册：挑一张最像小肥鱼的照片，截图发给他看）"，
       * 用户原话：「这种完全不像她说的话」。现在一个字都不补。
       */
      ok('请示：不许补"（想翻相册：…）"那种任务单尾巴',
        !/（想/.test(state.said[0].text) && !/：/.test(state.said[0].text) && !/为您|帮助你/.test(state.said[0].text));
      const s = life.state(T0);
      ok('请示：状态里挂着一个"等他点头"', s.proposal && s.proposal.status === 'pending');
      ok('请示：这时候手机上一步都没动', state.enqueued.length === 0);
    }

    {
      // 模型给出 JSON：用它自己的话和它自己排的事
      const { life, state } = rig({
        planReply: '```json\n{"theme":"collect","ask":"我去挑张图好吗？","items":["在结果页挑一张像我的截下来","再翻一屏挑一张"]}\n```',
      });
      await life.tick(T0);
      /**
       * ★ 2026-11-02：**"要办的事"和"说出口的话"分开了**。
       * 旧版为了让"他点头的东西不含糊"，把事硬塞进那句问话（`（想翻相册：…）`）——
       * 用户说"完全不像她说的话"。现在：问话就是她那句，事留在 `proposal.goal` 里。
       */
      ok('请示：她问的是自己那句话（不夹任务原文）', state.said[0].text === '我去挑张图好吗？');
      ok('请示：要办的那件事照样记着（点头之后按它办）',
        life.state(T0).proposal.goal.includes('挑一张像我的'));
      ok('请示：主题跟着她想的那件走', life.state(T0).proposal.theme === 'collect');
    }
    {
      // ★ 真机撞出来的：模型说"挑图"，写的事却在相册里 —— 现在**主题跟着那件事走**，
      //   她会先开相册（而不是错开必应图片），这一类矛盾从根上没了
      const { life } = rig({
        planReply: '{"theme":"collect","ask":"挑张图？","goal":"打开相册，挑一张最像他的图"}',
      });
      await life.tick(T0);
      const p = life.state(T0).proposal;
      ok('排计划：说到相册就用相册（主题跟着那件事走）', p.theme === 'album' && /相册/.test(p.goal));
      ok('排计划：一次只提一件事（不是一串）', Array.isArray(p.items) && p.items.length === 1);
    }
    {
      // 一次做不完的一批活不认（模型看到她"多挑几张"的心事，会写成"挑 6 张，凑够 6/6"）
      const { life } = rig({ planReply: '{"theme":"collect","ask":"挑图？","goal":"从相册里挑6张像小肥鱼的图，凑够6/6"}' });
      await life.tick(T0);
      ok('排计划：一次做不完的"好几张"不认', !/6\s*张/.test(life.state(T0).proposal.goal));
    }
    {
      // 模型吐的是空话：不许提出一件"什么也不做"的事
      const { life } = rig({ planReply: '{"theme":"album","ask":"翻翻相册？","goal":"随便看看有什么好玩的"}' });
      await life.tick(T0);
      const g = life.state(T0).proposal.goal;
      ok('排计划：太空泛的事不认，换兜底牌', /挑一张照片|截一张/.test(g));
    }
    {
      // ★ 真机撞出来的最危险一条：模型写「把相册里重复的照片删掉一张」，她真会去点删除
      const { life } = rig({ planReply: '{"theme":"album","ask":"翻翻相册？","goal":"把相册里模糊或重复的照片删掉一张"}' });
      await life.tick(T0);
      const g = life.state(T0).proposal.goal;
      ok('排计划：会闯祸的事（删除/卸载/支付）一律不办', !/删|卸载|支付|下单/.test(g) && g.length > 4);
    }
    {
      // 另一条真机输出：「把挑好的图数一数，报个数给他」—— 手机上数不了，她只能编
      const { life } = rig({ planReply: '{"theme":"collect","ask":"挑几张图？","goal":"把挑好的图数一数，报个数给他"}' });
      await life.tick(T0);
      ok('排计划：手机上做不到的（数/存/整理）一律不办', !/数一数|数一下|存进|整理/.test(life.state(T0).proposal.goal));
    }
    {
      // 老格式（还吐 items 数组）也要能接住：只取第一条
      const { life } = rig({ planReply: '{"theme":"collect","ask":"挑张图？","items":["挑一张像我的，截一张发给他","再挑一张"]}' });
      await life.tick(T0);
      const p = life.state(T0).proposal;
      ok('排计划：模型还按老格式吐 items 时只取第一条', /挑一张像我的/.test(p.goal) && p.items.length === 1);
    }

    /* ---------- 4b. "问一句"和"要办的那件事"分开（★ 2026-11-02） ---------- */

    {
      const { life, state } = rig({ planReply: '{"theme":"album","ask":"翻翻相册，行吗？","goal":"挑一张照片，说清这张里是什么"}' });
      await life.tick(T0);
      ok('请示：问话就是她那句话，不夹 goal 原文', state.said[0].text === '翻翻相册，行吗？');
      ok('请示：要办的事仍记在 proposal 里', /挑一张照片/.test(life.state(T0).proposal.goal));
      const yes = life.answer({ text: '行', isOwner: true, at: T0 + 1000 });
      ok('请示：点头之后办的还是那件事（话和事没有走散）', yes && yes.goal && /挑一张照片/.test(yes.goal));
    }
    {
      const { life, state } = rig({ planReply: '{"theme":"album","ask":"想挑一张相册里的照片看看","goal":"挑一张照片，说清这张里是什么"}' });
      await life.tick(T0);
      ok('请示：她自己说清了就一个字都不补', state.said[0].text === '想挑一张相册里的照片看看');
    }

    /* ---------- 5. 他不点头，绝不动手 ---------- */

    {
      const { life, state } = rig();
      await life.tick(T0);
      ok('点头：不回答就不动', life.answer({ key: 'private:1', text: '今天累死了', isOwner: true, at: T0 + 1000 }) === null);
      ok('点头：问句不算回答（他在问别的）', life.answer({ key: 'private:1', text: '行吗？', isOwner: true, at: T0 + 2000 }) === null);
      ok('点头：别人说的不算', life.answer({ key: 'private:9', text: '行', isOwner: true, at: T0 + 3000 }) === null);
      ok('点头：群里说的不算（这不是私聊）', life.answer({ key: 'group:1', text: '行', isOwner: true, at: T0 + 4000 }) === null);
      const no = life.answer({ key: 'private:1', text: '不行，等会儿', isOwner: true, at: T0 + 5000 });
      ok('点头：他说不行就是不行', no && no.verdict === 'no');
      ok('点头：被拒之后也不再自己开跑', life.startApproved({ key: 'private:1', at: T0 + 6000 }).ok === false);
      ok('点头：被拒一次就把那条需求压下去（不缠人）', life.state(T0 + 7000).proposal.status === 'declined');
      ok('点头：自始至终一步都没动', state.enqueued.length === 0);
    }
    {
      // 半小时没回音 → 作废，不再问同一个
      const { life } = rig();
      await life.tick(T0);
      const late = life.answer({ key: 'private:1', text: '行', isOwner: true, at: T0 + hours(1) });
      ok('点头：过了半小时才回，不作数（重来一遍）', late === null && life.state(T0 + hours(1)).proposal.status === 'expired');
    }

    /* ---------- 6. 他点头 → 就去办那一件 ---------- */

    {
      const { life, state, seen, dir } = rig({
        planReply: '{"theme":"album","ask":"翻翻相册行吗？","goal":"挑一张照片，说清这张里是什么"}',
      });
      await life.tick(T0);
      const yes = life.answer({ key: 'private:1', text: '行', isOwner: true, at: T0 + 1000 });
      ok('开跑：他一点头就算答应了', yes && yes.verdict === 'ok');
      const started = life.startApproved({ key: 'private:1', at: T0 + 2000 });
      ok('开跑：会话开起来了', started.ok === true);
      ok('开跑：办的就是他批准的那一件', started.items[0] === '挑一张照片，说清这张里是什么');

      let at = T0 + 2000;
      await life.tick(at);
      ok('开跑：那件事排上了队', state.enqueued.length === 1 && /挑一张照片/.test(state.enqueued[0].goal));
      ok('开跑：标成会话里的子任务（回灌才不会刷屏）', state.enqueued[0].src === 'session');
      ok('开跑：带自己的小预算（8 步 / 120 秒，配合滚动层够翻完一个列表）', state.enqueued[0].budget.maxSteps === 8 && state.enqueued[0].budget.maxMs === 120_000);

      /**
       * ★ 2026-11-01 修：**同一件只许排一次**。
       * 结果事件要是没回来（任务炸了、`fail` 漏了 `session`），`item.ok` 一直是 null，
       * 而 `busy` 已经 false —— 下一轮 tick 就会把同一件事再排一遍
       * （实测 5 轮 tick 排了 5 次，`maxCalls` 也因此永远不触发）。
       */
      {
        state.busy = false;                    // 假装"手机上不忙，但结果没回来"
        await life.tick(at + 1000);
        await life.tick(at + 2000);
        ok('去重：结果没回来的那一步不会被重新排一遍（以前每 60 秒排一次）',
          state.enqueued.length === 1);
        state.busy = true;
      }

      const sid = life.state(at).session.id;
      life.onTask({ id: state.enqueued[0].id, session: sid, ok: true, summary: '这张是个蓝发小女仆，站在灰底上', steps: 2, calls: 2, ms: 9000, shot: { file: '/tmp/x.png' } });
      at = step(at);
      await life.tick(at);

      ok('收尾：办完就收，不会自己再排第二件', state.enqueued.length === 1);
      ok('收尾：只回灌一条', state.followed.length === 1);
      ok('收尾：回灌带了一张图', !!state.followed[0].shot && !!state.followed[0].shot.file);
      ok('收尾：回灌说的是她干了什么', /蓝发小女仆/.test(state.followed[0].summary));
      ok('收尾：会话结束了', life.state(at).session === null);
      ok('收尾：写了一条自我观察', state.self.length === 1 && /喜欢|挺/.test(state.self[0]));
      ok('收尾：发了会话事件给页面', seen.some((e) => e.kind === 'session-start') && seen.some((e) => e.kind === 'session-end'));

      const diary = fs.readFileSync(path.join(dir, 'diary.jsonl'), 'utf8').trim().split('\n');
      ok('收尾：日记一行、是一段 JSON', diary.length === 1 && JSON.parse(diary[0]).theme === 'album');
      ok('收尾：日记里记着这一件成没成', /成了/.test(diary[0]) && JSON.parse(diary[0]).ok === 1);
    }

    /**
     * 6b ★ 2026-11-01：**页面没打开就不算"开过"**。
     *
     * 原来 `item.opened = true` 写在 `launch/openUrl` 之前：相册根本没打开也算开过，
     * 于是她在**桌面**上执行"挑一张照片"，5 步预算全打空、这场会话白费。
     * 现在：失败 → 这一轮先不开跑、下一轮再试；两次都打不开才不再挡路。
     */
    {
      const { life, state } = rig({
        planReply: '{"theme":"album","ask":"翻翻相册行吗？","goal":"挑一张照片，说清这张里是什么"}',
        launchFails: 1,
      });
      await life.tick(T0);
      life.answer({ key: 'private:1', text: '行', isOwner: true, at: T0 + 1000 });
      life.startApproved({ key: 'private:1', at: T0 + 2000 });
      let at = T0 + 2000;
      await life.tick(at);
      ok('preOpen：相册没打开就把这件事先放下（以前"开不开都算开过"）',
        state.enqueued.length === 0 && state.launchTries === 1);
      // 注意：这里必须按**假时钟**往前推（`startedAt` 是 T0），用 `step()`（真时间）会让
      // `at - startedAt` 直接越过 25 分钟预算，会话当场 'time-up' 收尾。
      at += 30_000;
      await life.tick(at);
      ok('preOpen：下一轮会再试一次，成功了才开跑',
        state.launchTries === 2 && state.enqueued.length === 1);
    }
    {
      // 两次都打不开：别再无限等（不然这一整场会话就卡在一件开不起来的 App 上）
      const { life, state } = rig({
        planReply: '{"theme":"album","ask":"翻翻相册行吗？","goal":"挑一张照片，说清这张里是什么"}',
        launchFails: 5,
      });
      await life.tick(T0);
      life.answer({ key: 'private:1', text: '行', isOwner: true, at: T0 + 1000 });
      life.startApproved({ key: 'private:1', at: T0 + 2000 });
      let at = T0 + 2000;
      await life.tick(at);
      at += 30_000;
      await life.tick(at);
      at += 30_000;
      await life.tick(at);
      ok('preOpen：两次都开不起来就不再挡路（照常开跑，别把整场会话耗在开 App 上）',
        state.launchTries === 2 && state.enqueued.length === 1);
    }

    /* ---------- 7. 没办成就收尾（不硬耗、不编） ---------- */

    {
      const { life, state, dir } = rig({
        planReply: '{"theme":"browse","ask":"去网上逛逛？","goal":"这一屏是几行标题，挑两条你觉得有意思的，念给他听"}',
      });
      await life.tick(T0);
      life.answer({ key: 'private:1', text: '去吧', isOwner: true, at: T0 + 1000 });
      life.startApproved({ key: 'private:1', at: T0 + 2000 });
      let at = T0 + 2000;
      await life.tick(at);
      const sid0 = life.state(at).session.id;
      const cur = state.enqueued[state.enqueued.length - 1];
      life.onTask({ id: cur.id, session: sid0, ok: false, summary: '没做到：页面一直转圈', steps: 1, calls: 1, ms: 5000 });
      at = step(at);
      await life.tick(at);
      ok('退出：那一件没办成就收尾', life.state(at).session === null);
      ok('退出：如实说没成、不编', state.followed.length === 1 && state.followed[0].ok === false);
      ok('退出：没成也写日记（好知道她试过）', fs.readFileSync(path.join(dir, 'diary.jsonl'), 'utf8').includes('没成'));
    }

    /* ---------- 8. 他说话了 → 她先放下手机 ---------- */

    {
      const { life, state } = rig({ planReply: '{"theme":"album","ask":"翻翻相册？","items":["挑一张","再挑一张"]}' });
      await life.tick(T0);
      life.answer({ key: 'private:1', text: '行', isOwner: true, at: T0 + 1000 });
      life.startApproved({ key: 'private:1', at: T0 + 2000 });
      const at = T0 + 2000;
      await life.tick(at);
      life.noteUser({ at: at + 1000 });
      ok('让位：他说话她就挂起', life.state(at + 1000).session.paused === true);
    }

    /* ---------- 9. 取消每天次数上限（2026-10-31 第三轮，用户要求） ---------- */

    {
      const { life } = rig({ planReply: '{"theme":"album","ask":"翻翻相册？","goal":"挑一张照片，说清这张里是什么"}' });
      // 从早上 9 点开始（她 9 点前不"无聊"），每 2 小时一次：
      // 批一次无聊值掉 35，2 小时涨 36，正好回得来；一整天也不会跨过午夜
      let at = T0 - 5 * hours(1);
      let asked = 0;
      for (let i = 0; i < 6; i++) {
        await life.tick(at);
        const p = life.state(at).proposal;
        if (p && p.status === 'pending') {
          asked += 1;
          life.answer({ key: 'private:1', text: '行', isOwner: true, at: at + 1000 });
          life.startApproved({ key: 'private:1', at: at + 2000 });
          await life.wrap('测完收尾', at + 3000);
        }
        at += hours(2);
        life._st().lastProposalAt = 0;      // 绕开冷却，只验上限
      }
      ok('上限：一天问六次也不会被拦（三次上限已取消）', asked >= 6);
      ok('上限：批准的次数照实记着（只是不再拦）', life.state(at).approvedToday >= 6);
    }
    {
      // 冷却仍然有效：一小时里只问一次
      const { life, state } = rig({ planReply: '{"theme":"album","ask":"翻翻相册？","goal":"挑一张照片，说清这张里是什么"}' });
      await life.tick(T0);
      life.answer({ key: 'private:1', text: '行', isOwner: true, at: T0 + 1000 });
      life.startApproved({ key: 'private:1', at: T0 + 2000 });
      await life.wrap('测完收尾', T0 + 3000);
      // 85 分钟：无聊已经涨回来了（50 + 25.5 = 75.5 ≥ 70），但还没到 90 分钟的冷却
      const r = await life.tick(T0 + 85 * 60_000);
      ok('上限：取消的是"次数"，不是冷却（90 分钟内不再问）', r.ok === false && r.why === 'too-soon' && state.said.length === 1);
    }

    /* ---------- 10. 不该起事的时候一件都不起 ---------- */

    {
      const a = rig({ cfg: { enabled: false } });
      const r1 = await a.life.tick(T0);
      ok('闸门：手机没开就不动', r1.ok === false && a.state.said.length === 0);

      const b = rig({ cfg: { autonomy: { enabled: false, from: 0, to: 24 } } });
      const r2 = await b.life.tick(T0);
      ok('闸门：自主关掉就不动', r2.ok === false && r2.why === 'autonomy-off');

      const c = rig({ cfg: { autonomy: { enabled: true, from: 0, to: 0 } } });
      const r3 = await c.life.tick(T0);
      ok('闸门：不在时段就不动', r3.ok === false && r3.why === 'hour');
    }
    {
      // 他正在跟她说话 → 不起事（她不能一边聊一边偷偷玩）
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsp-life-talk-'));
      const said = [];
      const life = lifeMod.createPhoneLife({
        dir,
        getCfg: () => ({ enabled: true, autonomy: { mode: 'ask', enabled: true, everyMin: 90, maxPerDay: 3, from: 0, to: 24 } }),
        agentOf: () => ({ state: () => ({ busy: false }), enqueue: () => ({ accepted: true }), adb: {} }),
        targetKey: () => 'private:1',
        isQuiet: () => false,                 // 他刚说完话
        say: async (o) => said.push(o),
        followUp: async () => {},
        readNotes: async () => '',
        model: () => ({}),
        callModel: async () => ({ text: '{}' }),
        log: { info: () => {}, warn: () => {} },
      });
      const r = await life.tick(T0);
      ok('闸门：他正在说话就不请示（不打扰）', r.ok === false && r.why === 'talking' && said.length === 0);
    }
    {
      // 手机上还有事在做 → 不请示
      const r = rig({ busy: true });
      const res = await r.life.tick(T0);
      ok('闸门：手机忙着就不请示', res.ok === false && res.why === 'busy');
    }

    /* ---------- 11. 便签进 prompt（她想干什么的最像人的来源） ---------- */

    /**
     * ★ 2026-11-01 修：**他点头之后重启，那次会话要接得上**。
     * 原来 `session` 只在内存里：他点了头、程序这时候重启 → 会话消失，
     * 而需求条已经扣了 35、`approvedToday` 也 +1、`seen` 也记了 —— 代价白付。
     */
    {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsp-life-resume-'));
      const mk = (enqueued) => lifeMod.createPhoneLife({
        dir,
        getCfg: () => ({ enabled: true, autonomy: { mode: 'ask', enabled: true, everyMin: 90, maxPerDay: 3, from: 0, to: 24 } }),
        agentOf: () => ({
          state: () => ({ busy: false, queued: 0 }),
          enqueue: (o) => { enqueued.push(o); return { id: `t${enqueued.length}`, accepted: true }; },
          adb: { launch: async () => ({ ok: true }), openUrl: async () => ({ ok: true }) },
        }),
        targetKey: () => 'private:1',
        isQuiet: () => true,
        say: async () => {},
        followUp: async () => {},
        readNotes: async () => '',
        model: () => ({}),
        callModel: async () => ({ text: '{"theme":"album","ask":"翻翻相册？","goal":"挑一张说清是什么"}' }),
        log: { info: () => {}, warn: () => {} },
      });
      const before = [];
      const first = mk(before);
      await first.tick(T0);                                   // 起一个提案
      const yes = first.answer({ text: '行', isOwner: true, at: T0 + 1000 });
      ok('续跑：他点头之后立刻开跑（旧行为不变）',
        yes && yes.verdict === 'ok' && first.startApproved({ at: T0 + 1000 }).ok === true);

      /** "重启"：新建一个实例，读的是同一个目录里的 life.json。 */
      const after = [];
      const second = mk(after);
      await second.tick(T0 + 2000);
      ok('续跑：重启后把他批准过的那次会话接回来（需求已经扣过，不该白扣）',
        after.length === 1 && after[0].src === 'session');
    }

    {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsp-life-note-'));
      const prompts = [];
      const life = lifeMod.createPhoneLife({
        dir,
        getCfg: () => ({ enabled: true, autonomy: { mode: 'ask', enabled: true, everyMin: 90, maxPerDay: 3, from: 0, to: 24 } }),
        agentOf: () => ({ state: () => ({ busy: false }), enqueue: () => ({ accepted: true }), adb: { openUrl: async () => ({ ok: true }) } }),
        targetKey: () => 'private:1',
        isQuiet: () => true,
        say: async () => {},
        followUp: async () => {},
        readNotes: async () => '\uFEFF小肥鱼的便签\n- 今天要记得把相册收拾一下',
        model: () => ({ model: 'stub' }),
        callModel: async (m, messages) => { prompts.push(JSON.stringify(messages)); return { text: '{"theme":"album","ask":"翻翻相册？","items":["挑一张"]}' }; },
        log: { info: () => {}, warn: () => {} },
      });
      await life.tick(T0);
      ok('便签：排计划时她看得到自己便签上的字', prompts.length === 1 && prompts[0].includes('把相册收拾一下'));
      ok('便签：BOM 被清掉了', !prompts[0].includes('\\ufeff'));
    }

    /* ---------- 12. 自由模式：不用请示，一次管 15 分钟（★ 2026-11-02 用户拍板） ---------- */

    {
      /**
       * 用户原话：「一次管用 15 分钟，无任何限制，除非我中途说先别玩了」。
       * 旧路径（`mode:'ask'`）在这里全都要过，所以上面那一整块原样保留着当回归。
       */
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsp-life-mode-'));
      ok('自由：默认就是 free（不用请示）',
        lifeMod.createPhoneLife({ dir: tmp, log: { info: () => {}, warn: () => {} } }).state(T0).mode === 'free');
      /**
       * 「去玩手机吧，看看顺不顺」这种**没给目标**的话，也得认成"你自己去玩"。
       * 用户实测：她只会回"我去看看"，手机上什么都不会发生。
       */
      ok('自由：「去玩手机吧」认得出（不用她写 [手机:…]）',
        lifeMod.looksLikePlay('去玩手机吧，看看顺不顺') && lifeMod.looksLikePlay('你自己去玩会儿')
        && lifeMod.looksLikePlay('随便玩玩') && lifeMod.looksLikePlay('玩会儿手机'));
      ok('自由：「先别玩了」是停，不是玩（先判否定）',
        lifeMod.looksLikeStop('先别玩了') && lifeMod.looksLikeStop('不玩了') && lifeMod.looksLikeStop('放下手机')
        && !lifeMod.looksLikePlay('先别玩了'));
      ok('自由：别的话不会被认成"去玩"',
        ['今天好累啊', '在干嘛', '陪我聊会儿', '看看这个视频', '陪我玩一会儿', '我们一起玩会儿']
          .every((t) => !lifeMod.looksLikePlay(t)));
      /**
       * ★ 2026-11-08（真机 11-07 23:39:59 / 23:36:30 那两轮）：
       * 「我来给你操作吧」「算了我下次再优化」以前一个都不算停 ——
       * 他明确要接手，她还在让手机点下去。这两句现在必须算停。
       */
      ok('自由：「我来给你操作吧」= 停（他要亲自来）',
        lifeMod.looksLikeStop('不是你这家伙压根不听啊，我来给你操作吧')
        && lifeMod.looksLikeStop('我来给你操作吧') && lifeMod.looksLikeStop('我自己来吧')
        && lifeMod.looksLikeStop('你别动了，我来'));
      ok('自由：「算了我下次再优化」= 今晚不弄了',
        lifeMod.looksLikeStop('算了我下次再给你优化') && lifeMod.looksLikeStop('算了吧'));
      ok('自由：「你随便玩吧你刚刚都没有点下去」= 去玩（以前不认）',
        lifeMod.looksLikePlay('你随便玩吧你刚刚都没有点下去') && lifeMod.looksLikePlay('你随便玩吧'));
      ok('自由：他喊停的长句也认（上限 30 → 60 字）',
        lifeMod.looksLikeStop('别看了返回返回要返回到首页我教你看更好看的'));
      /**
       * ★ 2026-11-08 夜（真机 23:07:33）：「你现在还在搜滑动验证，**先不要搜了**，然后去搜深圳的天气」
       * —— 这句以前不算"停"，于是那条验证码任务又烧了 119 秒。现在"先不要搜了"就是停。
       * ⚠️ 但「你不要搜图片」是**纠正**、不是停（他那天连说两遍），不能一起吞进去。
       */
      ok('自由：「先不要搜了」= 停（他明确让停手）',
        lifeMod.looksLikeStop('先不要搜了') && lifeMod.looksLikeStop('别搜了')
        && lifeMod.looksLikeStop('不搜了') && lifeMod.looksLikeStop('先停下'));
      ok('自由：「你不要搜图片」是纠正、不是停', !lifeMod.looksLikeStop('你不要搜图片'));
    }
    {
      const { life, state, seen } = rig({ cfg: { autonomy: { mode: 'free', enabled: true, from: 0, to: 24 } } });
      const r = life.beginPlayNow({ at: T0, key: 'private:1' });
      ok('自由：一句话就开跑（不用模型、不用点头）', r.ok === true && !!life._session());
      ok('自由：一场最多 15 分钟', r.minutes === 15 && life._session().maxMs === 15 * 60_000);
      ok('自由：一场排 1~3 件（不再"点头一次只换 40 秒"）',
        life._session().items.length >= 1 && life._session().items.length <= 3);
      ok('自由：开跑不发"请示"（`said` 一条都没有）', state.said.length === 0);
      ok('自由：发的是 session-start（页面/日志看得到）', seen.some((e) => e.kind === 'session-start'));

      /** 他喊停 → 立刻收尾（连手上那一件也由 companion 去停）。 */
      const s1 = life.stop('他说先别玩');
      ok('自由：「先别玩了」立刻收工', s1.ok === true && life._session() === null && seen.some((e) => e.kind === 'session-stop'));
      ok('自由：停了之后再停一次就什么都不做', life.stop('他说先别玩').ok === false);
    }
    {
      const { life, state } = rig({ cfg: { autonomy: { mode: 'free', enabled: true, from: 0, to: 24 } } });
      const r = await life.tick(T0);
      ok('自由：心跳发现该玩了就直接开跑（不是发一条请示）',
        r.ok === true && !!life._session() && state.said.length === 0);
      /** 开跑和"排第一件"是两个 tick：先开一场会话，下一次心跳才把第一件交给手机。 */
      await life.tick(T0 + 1000);
      ok('自由：会话里的小目标交给手机去做（src=session）',
        state.enqueued.length >= 1 && state.enqueued[0].src === 'session');
      /** 自由模式下 `propose()` 直接不干活（老路径留着，但默认不走）。 */
      const p = await life.propose(T0 + hours(1));
      ok('自由：不会再问"要不要我……"（propose 直接返回 free-mode）', p.ok === false && p.why === 'free-mode');
    }
    {
      const { life, state } = rig({ cfg: { autonomy: { mode: 'free', enabled: true, from: 0, to: 24 } } });
      life.beginPlayNow({ at: T0, key: 'private:1' });
      const t1 = life.onFound({ why: '看到「猫」了', at: T0 });
      const t2 = life.onFound({ why: '看到「鱼」了', at: T0 + 4 * 60_000 });
      const t3 = life.onFound({ why: '看到「狗」了', at: T0 + 8 * 60_000 });
      ok('自由：看到点好玩的会跟他说一声', t1 === true && state.followed.length >= 1);
      ok('自由：一场最多分享 2 次（第三次不再发）', t2 === true && t3 === false && life._session().shares === 2);
      ok('自由：分享走的是"她自己说"那条路（不是模板文案）',
        String(state.followed[0].summary || '').includes('猫') && state.followed[0].by === 'her');
    }
    {
      /** 间隔：刚说完一句，1 分钟后不再说（3 分钟以内）。 */
      const { life } = rig({ cfg: { autonomy: { mode: 'free', enabled: true, from: 0, to: 24 } } });
      life.beginPlayNow({ at: T0, key: 'private:1' });
      const a1 = life.onFound({ why: '看到「猫」了', at: T0 });
      const a2 = life.onFound({ why: '看到「狗」了', at: T0 + 60_000 });
      const a3 = life.onFound({ why: '看到「鱼」了', at: T0 + 4 * 60_000 });
      ok('自由：两次分享至少隔 3 分钟（刚说完不连发）', a1 === true && a2 === false && a3 === true);
    }

    /* ---------- 13. 开放目的地（★ 2026-11-12：不预设菜单） ---------- */

    {
      const calls = [];
      const plan = async (o) => {
        calls.push(o);
        return {
          app: '哔哩哔哩',
          goal: '搜「红烧肉 上色」看两条，回来讲给他听',
          query: '红烧肉 上色',
          why: '想看上色到底是不是炒糖',
          stopCriteria: '看到做法那一段',
          shareCriteria: '看到有人吵糖色',
          ask: '我去B站翻两眼啊',
        };
      };
      const { life } = rig({ plan, cfg: { autonomy: { mode: 'free', enabled: true, from: 0, to: 24 } } });
      const r = await life.tick(T0);
      ok('开放：她自己挑了一个 App（不是预设的三选一）', r.ok === true && r.app === '哔哩哔哩');
      ok('开放：会话记着目的地和搜索词', life._session().app === '哔哩哔哩' && life._session().query === '红烧肉 上色');
      ok('开放：粗分类跟着 App 走（B站 = video）', life._session().theme === 'video');
      ok('开放：计划层拿到的是"手机上真有的 App"菜单，不是固定主题',
        calls.length === 1 && /相册/.test(calls[0].menu) && /哔哩哔哩/.test(calls[0].menu) && !/album/.test(calls[0].menu));
      const st = life.state(T0);
      ok('开放：今天记了第 1 趟（去了哪等这一趟收工再记账）',
        st.today.trips === 1 && st.session && st.session.app === '哔哩哔哩');
    }
    {
      /** 她说"这趟不想去"：真的不去（不是又编一件事）。 */
      const { life } = rig({
        plan: async () => ({ skip: true, why: '这会儿不想动' }),
        cfg: { autonomy: { mode: 'free', enabled: true, from: 0, to: 24 } },
      });
      const r = await life.tick(T0);
      ok('开放：她说不想去就不开（不是每次心跳都得有结果）', r.ok === false && r.why === 'skip');
      ok('开放：没开就不算一趟、不扣需求、不写日记', !life._session() && life.state(T0).today.trips === 0);
    }
    {
      /** 重启接回旧会话：太久了直接丢，不许"第一跳 time-up"。 */
      const { life, seen } = rig({
        plan: async () => ({ skip: true, why: '不想动' }),
        cfg: { autonomy: { mode: 'free', enabled: true, from: 0, to: 24 } },
      });
      life.state(T0);
      life._st().pendingSession = {
        id: 'old', startedAt: T0 - 20 * 3600_000, maxMs: 18 * 60_000,
        theme: 'album', items: [{ goal: '挑一张', kind: 'album', ok: null }], idx: 0,
      };
      const r = await life.tick(T0);
      ok('续跑：20 小时前没结束的会话直接丢（不再第一跳就 time-up）',
        seen.some((e) => e.kind === 'session-drop'));
      ok('续跑：丢掉之后照常判断这一轮（这次是她自己说不想去）', r.why === 'skip' && !life._session());
    }
    {
      /** 每天 90 分钟额度：用完了自主闸就关（他叫去玩仍然能开）。 */
      const { life } = rig({ plan: async () => ({ skip: true, why: '不想动' }), cfg: { autonomy: { mode: 'free', enabled: true, from: 0, to: 24, dailyMin: 90 } } });
      life.state(T0);
      life._st().dayStats = { date: lifeMod.dayKey(T0), trips: 3, minutes: 95, autoMin: 95, apps: {}, fails: 0 };
      const r = await life.tick(T0);
      ok('额度：今天自主已玩 95 分钟（>90）→ 不再自己开', r.ok === false && r.why === 'quota');
      const forced = life.beginPlayNow({ at: T0 + 60_000, key: 'private:1' });
      ok('额度：他说"去玩吧"仍然能开（额度只拦她自己）', forced.ok === true);
    }
    {
      /** 时段按时分算：23:45 已经过了 23:30。 */
      const { life } = rig({ plan: async () => ({ skip: true, why: '不想动' }), cfg: { autonomy: { mode: 'free', enabled: true, from: 9, to: 23.5 } } });
      const late = new Date(2026, 9, 31, 23, 45).getTime();
      const r = await life.tick(late);
      ok('时段：23:45 不开（按时分比，不是整点）', r.ok === false && r.why === 'hour');
      const early = new Date(2026, 9, 31, 8, 59).getTime();
      ok('时段：8:59 也不开', (await life.tick(early)).why === 'hour');
    }
    {
      /** 22:40 只读：计划层收到 nightLite。 */
      const calls = [];
      const { life } = rig({
        plan: async (o) => { calls.push(o); return { skip: true, why: '懒' }; },
        cfg: { autonomy: { mode: 'free', enabled: true, from: 0, to: 24, nightLiteFrom: 22.5 } },
      });
      await life.tick(new Date(2026, 9, 31, 22, 40).getTime());
      ok('深夜：22:40 之后计划层收到"只读"信号', calls.length === 1 && calls[0].nightLite === true);
    }
    {
      /** 收尾：一段都没跑起来时，回灌不许说"试了半天"。 */
      const { life, state } = rig({
        plan: async () => ({ app: '相册', goal: '翻一翻最近的' }),
        cfg: { autonomy: { mode: 'free', enabled: true, from: 0, to: 24 } },
      });
      await life.tick(T0);
      await life.wrap('time-up', T0 + 60_000);
      ok('收尾：0 段收尾说的是"待了一会儿"，不是"试了试"',
        state.followed.length === 1 && state.followed[0].verb === '在手机上待了一会儿');
      ok('收尾：0 段时的摘要也是"没来得及动手"', /没来得及/.test(state.followed[0].summary));
    }
    /* ---------- 14. 他说"接着玩"：把她从挂起里放出来（★ 2026-11-12 真机 21:22） ---------- */

    {
      const { life } = rig({
        plan: async () => ({ app: '相册', goal: '翻翻今天拍的那张照片' }),
        cfg: { autonomy: { mode: 'free', enabled: true, from: 0, to: 24 } },
      });
      await life.tick(T0);
      ok('接着玩：先自己开了一场', !!life._session());
      life.noteUser({ at: T0 + 30_000 });
      ok('接着玩：他说话 → 挂起（老规矩没变）', life._session().paused === true);
      /**
       * 真机 21:22:45 他说「手机应该顺些了，去耍吧」——
       * 旧版 `beginPlayNow()` 只回「你正玩着呢」，没把她放出来；
       * 他一直在聊，90 秒安静永远凑不齐 → 18 分钟 time-up，一步没走。
       */
      const r = life.beginPlayNow({ at: T0 + 60_000, key: 'private:1' });
      ok('接着玩：已经有会话时他说"去耍吧"不是拒绝，是把她放出来',
        r.ok === true && r.resumed === true && life._session().paused === false);
      const again = life.beginPlayNow({ at: T0 + 90_000, key: 'private:1' });
      ok('接着玩：本来就在玩、也没挂起 → 照旧回"正玩着呢"', again.ok === false && again.why === 'playing');
    }
    {
      /** 他一直在聊（`isQuiet` 永远 false）：挂满 6 分钟先收工，别耗到 18 分钟超时。 */
      let quietNow = true;
      const { life, seen } = rig({
        plan: async () => ({ app: '相册', goal: '翻一翻最近的' }),
        quiet: () => quietNow,
        cfg: { autonomy: { mode: 'free', enabled: true, from: 0, to: 24 } },
      });
      await life.tick(T0);
      ok('接着玩：先开起来（这时他还安静）', !!life._session());
      quietNow = false;
      life.noteUser({ at: T0 + 60_000 });
      await life.tick(T0 + 8 * 60_000);
      ok('接着玩：他一直在聊、挂满 6 分钟 → 这一场先收（不耗到超时）',
        !life._session() && seen.some((e) => e.kind === 'session-end' && e.why === 'paused-too-long'));
    }
  },
};
