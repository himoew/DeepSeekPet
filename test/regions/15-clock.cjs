/**
 * 自检区域：她的小手表（2026-10-27 新增；2026-11-01 大修）
 *
 * 用户要的是"她想看/我让她看的时候能看到现在时间"。
 * 时间来源是本机系统时钟（`new Date()`），不联网。
 *
 * ★ 2026-11-01 用户报：「虽然给了她看时间功能，但她还是区分不了白天和晚上，是上午还是下午，
 * 会弄混」。查下来根因不是"表不准"，而是**QQ 那条路的 system 里从来没有时间**，
 * 而"看时间"被设计成她自己写 `[时间]` 才去查（她几乎从不查）。
 * 所以这一版改成：**每一轮都把 `【现在】2026-11-01 08:43 周日` 拼在本轮消息最前面**，
 * 只给事实、不给"早上/深夜"这类说法（用户拍板：「让她自己决定说法，不添加额外设定」）。
 *
 * 验：
 *   · 格式 / 时段 / 识别"在问时间"；
 *   · ★ `nowLine()` 只给日期、星期、钟点 —— **不许带时段词**；
 *   · ★ QQ / 主动开口 / 带图 三条路的本轮消息里都带【现在】；system 里**不**带会变的时间
 *     （不然每轮前缀都变，DeepSeek 的上下文缓存全失效）；
 *   · 用户问时间 → system 里真的带上了当前时间；
 *   · 她自己写 `[时间]` → 回复里换成真实时间，不再留标记；
 *   · `llm.chat`（桌宠 0 挡）和 `CompanionBrain`（QQ）两条路都接上；
 *   · ★ 静态守卫：`pet.cjs` 里那个"现在是清早43分"的坏格式不许回来。
 *
 * 单跑：`node test\run-one.cjs 15-clock.cjs`
 */
module.exports = {
  name: '她的小手表（时间）',
  tags: ['companion', 'clock', '时间', 'settings'],
  async run(ctx) {
    const { ok, fs, path, http } = ctx;
    const clock = ctx.mod('clock');
    const { CompanionMemory } = ctx.mod('companion-memory');
    const { CompanionBrain } = ctx.mod('companion-brain');
    const llm = ctx.mod('llm');

    /** 时段词：这些**不该**出现在喂给模型的事实行里（说法由她自己定）。 */
    const BANDS = /凌晨|清早|早上|上午|中午|下午|傍晚|晚上|深夜/;
    /** 本轮消息第一行的样子。 */
    const NOW_LINE = /^【现在】\d{4}-\d{2}-\d{2} \d{2}:\d{2} 周[一二三四五六日]$/;

    const at = new Date(2026, 9, 27, 20, 34, 0); // 本地时间 2026-10-27 20:34
    ok('时间：HH:MM', clock.timeText(at) === '20:34');
    ok('时间：带日期和星期', clock.fullText(at).startsWith('2026-10-27 20:34 周'));
    ok('时段：20 点是晚上，3 点是凌晨',
      clock.partOfDay(new Date(2026, 9, 27, 20, 0)) === '晚上'
      && clock.partOfDay(new Date(2026, 9, 27, 3, 0)) === '凌晨');

    /* ---------- ★ 2026-11-01：每轮那一行"现在" ---------- */
    ok('现在行：日期 + 星期 + 钟点', NOW_LINE.test(clock.nowLine(at)));
    ok('现在行：不带时段词（说法由她自己定）', !BANDS.test(clock.nowLine(at)));
    ok('现在行：凌晨三点也是同一种格式（钟点补零，不是"3:5"）',
      clock.nowLine(new Date(2026, 10, 1, 3, 5)) === '【现在】2026-11-01 03:05 周日');

    ok('识别：问几点 / 星期几',
      clock.detectRequest('现在几点了') && clock.detectRequest('今天星期几'));
    ok('识别：普通感叹不算问时间', !clock.detectRequest('时间过得真快'));
    ok('上下文：问时间时带真实时间，没问就不带',
      clock.requestContext('现在几点了', at).includes('2026-10-27 20:34')
      && clock.requestContext('今天吃什么', at) === '');
    ok('上下文：问时间也不替她定"晚上"', !BANDS.test(clock.requestContext('现在几点了', at)));

    ok('看表：把 [时间] 换成真实时间', clock.fillTags('现在都[时间]了', at) === '现在都20:34了');
    ok('看表： [看时间] 也认', clock.fillTags('我看看……[看时间]', at) === '我看看……20:34');
    ok('看表：标记检测', clock.hasTag('[时间]') && !clock.hasTag('没有'));
    ok('提示词：告诉她随时知道现在几点 + 想报点就写 [时间]',
      clock.promptLine().includes('[时间]')
      && clock.promptLine().includes('随时知道')
      && !clock.promptLine().includes('想知道现在几点时'));

    /* ---------- 两条模型链路 ---------- */

    const makeStub = (content) => new Promise((resolve) => {
      const seen = [];
      const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => {
          let body = null;
          try { body = JSON.parse(raw); } catch { /* 留 null */ }
          seen.push(body);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ choices: [{ message: { content } }] }));
        });
      });
      server.listen(0, '127.0.0.1', () => resolve({
        server, seen, url: `http://127.0.0.1:${server.address().port}`,
      }));
    });
    /** 这一轮真正"说给他听"的那条消息（最后一条 user）。 */
    const lastUser = (body) => body.messages[body.messages.length - 1].content;
    /** 纯文字消息（可能是多模态数组，取第一段 text）。 */
    const textOf = (content) => (Array.isArray(content) ? String(content[0]?.text || '') : String(content || ''));

    const brainStub = await makeStub('[时间]');
    try {
      const mem = new CompanionMemory({ dir: path.join(ctx.CONFIG_DIR, 'clock-brain') });
      const brain = new CompanionBrain({
        memory: mem,
        roleText: '测试角色',
        model: { baseUrl: brainStub.url, model: 'clock-model', apiKey: 'k', maxTokens: 64, timeoutMs: 5000 },
      });
      const reply = await brain.reply({
        userId: 'u1', userName: 'A', text: '现在几点了',
        platform: 'QQ', where: 'private:u1', record: false,
      });
      ok('QQ：她写 [时间] 会被换成真实时间',
        /^\d{2}:\d{2}$/.test(reply.text) && !reply.text.includes('[时间]'));
      const sys = brainStub.seen[0]?.messages?.[0]?.content || '';
      ok('QQ：用户问时间时 system 里带上了"现在是 …"',
        sys.includes('对方刚问你时间/日期') && sys.includes('2026-'));
      ok('QQ：system 里告诉她可以写 [时间]', sys.includes('[时间]'));

      // ★ 2026-11-01：她平时（没人问她几点）也得知道现在是什么时候
      const first = textOf(lastUser(brainStub.seen[0]));
      ok('QQ：本轮消息第一行就是【现在】（日期+星期+钟点）',
        NOW_LINE.test(first.split('\n')[0]));
      ok('QQ：这条【现在】之后紧跟他说的话', first.split('\n')[1] === '现在几点了');
      ok('QQ：不带时段词（不替她定"晚上"）', !BANDS.test(first));
      ok('QQ：会变的时间不进 system（否则每轮前缀都变、缓存全失效）',
        !String(sys).includes('【现在】2026'));

      // 主动开口：没有"对方说的话"，只有一句处境提示 —— 也得知道现在几点
      await brain.reply({
        userId: 'u1', userName: 'A', text: '（现在没人说话。你想自己开口。）',
        platform: 'QQ', where: 'private:u1', record: false, unsolicited: true,
      });
      ok('主动开口：本轮消息第一行也是【现在】',
        NOW_LINE.test(textOf(lastUser(brainStub.seen[1])).split('\n')[0]));

      // 带图：content 变成多模态数组，第一段 text 里同样要带
      await brain.reply({
        userId: 'u1', userName: 'A', text: '看看这个',
        images: [{ dataUrl: 'data:image/png;base64,iVBORw0KGgo=' }],
        platform: 'QQ', where: 'private:u1', record: false,
      });
      const withImg = lastUser(brainStub.seen[2]);
      ok('带图：多模态消息的第一段文字也带【现在】',
        Array.isArray(withImg)
        && NOW_LINE.test(textOf(withImg).split('\n')[0])
        && withImg.some((x) => x.type === 'image_url'));

      // 想事情（自主说话的原料）：也给时间，但同样不替她定说法
      await brain.think({ situation: '你在跟 A 私聊（QQ 上）。', max: 1 });
      const thinkSys = String(brainStub.seen[3]?.messages?.[0]?.content || '');
      ok('想事情：system 里有【现在】', /【现在】\d{4}-\d{2}-\d{2} \d{2}:\d{2} 周/.test(thinkSys));
      ok('想事情：也不带时段词', !BANDS.test(thinkSys));
    } finally {
      brainStub.server.close();
    }

    /* ---------- ★ 2026-11-02：回看一句话时，它发生在哪天 ---------- */

    /**
     * 用户报：「为什么她的念头（主动开口）会把日期说错」。
     * 真机：11-02 19:12 她说"下午想起个事，**昨天**你那个挑菜的店"——那事在当天 18:41。
     * 根因见 `clock.recentStamp` 上面那段注释：只有"现在"是完整的，回看的东西全没日期。
     * 这里先验三个纯函数（时间都写死，不看墙钟）。
     */
    const D2 = new Date(2026, 10, 2, 19, 12, 0).getTime(); // 2026-11-02 19:12 本地
    const day = (h, m, d, mo) => new Date(2026, mo, d, h, m, 0).getTime();
    ok('回看：同一天说「今天 18:41」', clock.recentStamp(day(18, 41, 2, 10), D2) === '今天 18:41');
    ok('回看：前一天说「昨天 23:44」（不会再冒充今天）',
      clock.recentStamp(day(23, 44, 1, 10), D2) === '昨天 23:44');
    ok('回看：更早说「10-30 23:44」', clock.recentStamp(day(23, 44, 30, 9), D2) === '10-30 23:44');
    ok('回看：跨年带上年份',
      clock.recentStamp(new Date(2025, 11, 31, 23, 44).getTime(), D2) === '2025-12-31 23:44');
    ok('回看：日期的短写法（长期记忆条目前面那个）',
      clock.dayText(day(9, 0, 1, 10), D2) === '11-01'
      && clock.dayText(new Date(2025, 0, 5).getTime(), D2) === '2025-01-05');

    // 写死的相对日期按"写下来的那天"还原（旧账就靠这个治）
    ok('旧账：10-31 写的"今天下午两点多才醒"读成 10 月 31 日',
      clock.resolveRelative('他今天下午两点多才醒', day(12, 0, 31, 9)) === '他10 月 31 日下午两点多才醒');
    ok('旧账：11-01 写的"明天见面"读成 11 月 2 日',
      clock.resolveRelative('所以明天见面得等到晚上', day(23, 55, 1, 10)) === '所以11 月 2 日见面得等到晚上');
    ok('旧账：今晚/昨晚连"晚上"一起带上',
      clock.resolveRelative('今晚不睡，昨晚也是', day(21, 0, 2, 10)) === '11 月 2 日晚上不睡，11 月 1 日晚上也是');
    ok('旧账：没有相对日期的句子一个字都不动',
      clock.resolveRelative('他说中午才点薯条', day(12, 0, 2, 10)) === '他说中午才点薯条');
    ok('旧账：连着读两次结果一样（正则没被 lastIndex 弄坏）',
      clock.resolveRelative('今天很累', D2) === clock.resolveRelative('今天很累', D2));

    /* ---------- 静态守卫：桌宠那句坏格式不许回来 ---------- */
    const petSrc = fs.readFileSync(path.join(ctx.app, 'pet.cjs'), 'utf8');
    ok('桌宠 0 挡：context 里补上了完整时间（现在是 年-月-日 时:分 周X）',
      petSrc.includes('现在是 ${clock.fullText()}'));
    ok('桌宠：不再拼"现在是清早43分"那种只有分钟的半句',
      !petSrc.includes('现在是${HOUR_CN'));

    const llmStub = await makeStub('现在都[时间]了');
    try {
      llm.save({
        enabled: true, preset: 'custom', baseUrl: llmStub.url, apiKey: 'k',
        model: 'clock-model', maxTokens: 64, timeoutMs: 5000,
        persona: '测试人设',
      });
      const reply = await llm.chat([], '几点了', 0, '测试');
      ok('桌宠 0 挡：llm.chat 也会替换 [时间]',
        /\d{2}:\d{2}/.test(reply) && !reply.includes('[时间]'));
      const sys = llmStub.seen[0]?.messages?.[0]?.content || '';
      ok('桌宠 0 挡：system 里带上了手表提示', sys.includes('[时间]'));
    } finally {
      llmStub.server.close();
    }
  },
};
