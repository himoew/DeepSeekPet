/**
 * 自检区域：她的手机·「面」（P1，2026-11-06）
 *
 * 这一层是**纯函数**：一屏控件树 → 角色 / 分区 / 稳定定位 / 行聚合 / 读页。
 * 不碰 adb、不碰模型，所以几百毫秒跑完。
 *
 * 单跑：`node test\run-one.cjs 26-phone-surface.cjs`
 */
module.exports = {
  name: '她的手机·面（role/region/loc/read）',
  tags: ['companion', 'phone', '手机', 'surface'],
  async run(ctx) {
    const { ok } = ctx;
    const s = ctx.mod('phone-surface');
    const agentMod = ctx.mod('phone-agent');

    const N = (text, extra = {}) => ({
      ref: 'n0', text, desc: '', class: 'TextView', clickable: false, editable: false,
      scrollable: false, checkable: false, checked: false, enabled: true,
      bounds: [0, 0, 200, 100], center: [100, 50], pkg: 'com.x', ...extra,
    });
    const screen = { width: 720, height: 1280 };

    /* ---------- 角色：她看到的"这是个什么东西" ---------- */

    ok('角色：输入框', s.roleOf(N('', { class: 'EditText', editable: true })) === 'input');
    ok('角色：开关', s.roleOf(N('蓝牙', { class: 'Switch' })) === 'switch');
    ok('角色：可点的字 → 按钮', s.roleOf(N('搜索', { clickable: true })) === 'button');
    ok('角色：不能点的图 → 图片', s.roleOf(N('', { class: 'ImageView' })) === 'image');
    ok('角色：列表容器', s.roleOf(N('', { class: 'RecyclerView', scrollable: true })) === 'scroll');
    ok('角色：纯文字', s.roleOf(N('你好')) === 'text');

    /* ---------- 分区：不用猜坐标，她知道自己在顶栏还是底栏 ---------- */

    ok('分区：顶上一条 → 顶栏', s.regionOf(N('标题', { bounds: [0, 40, 720, 140] }), screen) === 'appbar');
    ok('分区：最上面 → 状态栏', s.regionOf(N('8:00', { bounds: [0, 0, 720, 50] }), screen) === 'status');
    ok('分区：中间 → 内容', s.regionOf(N('正文', { bounds: [0, 400, 720, 500] }), screen) === 'content');
    ok('分区：底部 → 底栏', s.regionOf(N('我的', { bounds: [0, 1200, 720, 1280] }), screen) === 'tabbar');
    ok('分区：没有画幅时一律内容区', s.regionOf(N('x', { bounds: [0, 0, 720, 10] }), null) === 'content');

    /* ---------- loc：跨快照稳定的定位（ref 会重编号，loc 不会） ---------- */

    const a = N('相册', { pkg: 'com.android.gallery3d', bounds: [0, 300, 240, 400] });
    ok('loc：同一个节点两次一样', s.locOf(a) === s.locOf({ ...a }));
    ok('loc：换一行字就不一样', s.locOf(a) !== s.locOf({ ...a, text: '设置' }));
    ok('loc：同屏两个一样的节点会自动编号', (() => {
      const e = s.enrich([a, { ...a, ref: 'n1' }], screen);
      return e[0].loc !== e[1].loc && /#1$/.test(e[0].loc) && /#2$/.test(e[1].loc);
    })());

    /* ---------- 行聚合：B 站卡片那种"三个碎片"要并成一条 ---------- */

    const rowNodes = [
      N('标题一', { ref: 'n1', bounds: [20, 300, 400, 340] }),
      N('UP主', { ref: 'n2', bounds: [420, 300, 520, 340] }),
      N('3:35', { ref: 'n3', bounds: [600, 300, 700, 340] }),
    ];
    const rr = s.rows(rowNodes);
    ok('行：同一行的碎片拼成一条', rr.length === 1 && rr[0].text === '标题一 · UP主 · 3:35');
    ok('行：可点的节点不并进去', s.rows([rowNodes[0], { ...rowNodes[1], clickable: true }]).length === 2);

    /* ---------- 树 / 读 ---------- */

    const obs = {
      app: { name: '哔哩哔哩' }, screen, more: 0, thin: false,
      nodes: [
        N('返回', { ref: 'n0', clickable: true, bounds: [0, 40, 80, 130] }),
        ...rowNodes,
      ],
    };
    const tree = s.tree(obs);
    ok('树：按区域分组', /\[顶栏\]/.test(tree) && /\[内容\]/.test(tree));
    ok('树：内容区是拼好的行', /n1 标题一 · UP主 · 3:35/.test(tree));

    const d = s.digest(obs);
    ok('读：能读出内容（标题 + 行）', d.includes('标题一') && d.includes('顶栏'));
    const thin = s.digest({ app: { name: '相册' }, thin: true, nodes: [] });
    ok('读：读不出来就如实说，不编', /读不出字/.test(thin));
    ok('读：太长会截断', s.digest({ screen, nodes: Array.from({ length: 40 }, (_, i) => N(`第${i}条内容`, { ref: `n${i}`, bounds: [0, 200 + i * 20, 700, 210 + i * 20] })) }).length <= 900);

    /* ---------- find / pick ---------- */

    ok('找：找得到', s.find(obs, 'UP主')?.ref === 'n2');
    ok('找：找不到就是 null（不猜）', s.find(obs, '猫') === null);
    ok('挑：第2个（数的是内容区里的条目）', s.pick(obs, '第2个')?.text === 'UP主');
    ok('挑：最上面那个', s.pick(obs, '最上面那个')?.ref === 'n1');
    ok('挑：挑不到不瞎给', s.pick({ nodes: [] }, '第3个') === null);

    /* ---------- 搜索结果页：一条 = 一个网址（★ 2026-11-08） ---------- */

    /**
     * 造的是**真机那张必应结果页**（21:27–21:28 的截图）的形状：
     * 顶上那排 `网页/图片/视频/学术/词典/航班` → 域名行 → 网址行 → 大标题 → 摘要 → 图片块。
     * 那一轮他说「你点网页」「就是你搜出来的第一个网站你点进去」，
     * 结果点了三次都在点那排页签 —— 因为"第 1 条"数是内容区里带字的节点，第一个正是「网页」。
     */
    let ri = 0;
    const D = (text, bounds, extra = {}) => ({
      ...N(text, extra), ref: `r${ri++}`, bounds, clickable: !!extra.clickable,
      center: [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2],
    });
    const bing = {
      app: { package: 'mark.via', name: '浏览器' }, screen, more: 0, thin: false,
      nodes: [
        D('返回', [0, 20, 60, 90], { clickable: true }),
        D('小肥鱼表情包 - 搜索', [100, 20, 600, 90]),
        D('网页', [40, 330, 120, 390], { clickable: true }),
        D('图片', [150, 330, 230, 390], { clickable: true }),
        D('视频', [260, 330, 340, 390], { clickable: true }),
        D('学术', [370, 330, 450, 390], { clickable: true }),
        D('词典', [480, 330, 560, 390], { clickable: true }),
        D('航班', [590, 330, 670, 390], { clickable: true }),
        D('aigengtu.com', [155, 425, 350, 470]),
        D('https://aigengtu.com › DeepSeek娘', [155, 472, 620, 505]),
        D('DeepSeek娘表情包·2781张蓝色大肥鱼梗图·持续更新 | 梗鲸', [155, 515, 690, 600], { clickable: true }),
        D('DeepSeek娘是谁？DeepSeek娘（DeepSeek娘化/拟人形象，也叫鲸鱼娘）是网友为她创作的萌拟人化身', [155, 610, 690, 700]),
        D('小肥鱼 表情包 的图片', [100, 830, 520, 880]),
      ],
    };
    const nav = s.navRefs(s.enrich(bing.nodes, screen), screen);
    ok('结果页：认得出顶上那排「网页/图片/视频」是**导航**（不是第 1 条内容）',
      ['网页', '图片', '视频', '学术'].every((w) => [...nav].some((r) => bing.nodes.find((n) => n.ref === r)?.text === w)));
    const rs = s.results(bing);
    ok('结果页：认得出有 1 条结果', rs.length === 1);
    ok('结果页：那一条的网址是域名，不是整行', rs[0]?.url === 'aigengtu.com');
    ok('结果页：标题读到的是大标题，**不是摘要**（真机把摘要里的"2781 张"当成了那页的内容）',
      /^DeepSeek娘表情包/.test(rs[0]?.title || ''));
    ok('结果页：点的是**标题**那个节点（标题才是链接）',
      bing.nodes.find((n) => n.ref === rs[0]?.ref)?.text.startsWith('DeepSeek娘表情包'));
    ok('结果页：`pick 第1个` 会数到页签（这就是"点三次都没打不开网站"的根因，留作记录）',
      s.pick(bing, '第1个')?.text === '网页');

    const bd = s.digest(bing);
    ok('结果页：读这一页时说清"每一条 = 一个网址，摘要不是那网站的内容"',
      /每一条 = 一个网址/.test(bd) && /摘要/.test(bd) && /不是/.test(bd));
    ok('结果页：读出来按条列，带标题和网址',
      /第1条 《DeepSeek娘表情包/.test(bd) && /网址 aigengtu\.com/.test(bd));
    ok('结果页：普通页面（没有网址）不受影响', !/每一条 = 一个网址/.test(s.digest(obs)));

    /* ---------- 接线：read 不花步数、读到的内容进下一步 prompt ---------- */

    const calls = [];
    const phone = {
      async state() { return { online: true, booted: true, screen, app: { package: 'tv.danmaku.bili', name: '哔哩哔哩' } }; },
      async observe() {
        return {
          ok: true, app: { name: '哔哩哔哩', package: 'tv.danmaku.bili' }, screen,
          nodes: obs.nodes, table: 'n0 返回', hash: 'h1', count: 4, more: 0, thin: false,
        };
      },
      async tap() { return { ok: true, changed: true }; },
      async tapXY() { return { ok: true }; },
      async swipeDir() { return { ok: true, changed: true }; },
      async text() { return { ok: true }; },
      async key() { return { ok: true }; },
      async openUrl() { return { ok: true }; },
      async launch() { return { ok: true }; },
      async waitChange() { return { changed: false }; },
      async focusApp() { return 'tv.danmaku.bili'; },
      async screenshot() { return { ok: false }; },
    };
    const replies = ['read', 'done 这一页是三条视频'];
    const agent = new agentMod.PhoneAgent({
      adb: phone,
      model: { model: 'stub', baseUrl: 'http://127.0.0.1:1', maxTokens: 80, timeoutMs: 5000 },
      callModel: async (m, messages) => {
        calls.push(messages);
        return { text: replies[Math.min(calls.length - 1, replies.length - 1)] };
      },
      dir: require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'dsp-surface-')),
      rescue: { enabled: false },
    });
    const res = await new Promise((resolve) => {
      const orig = agent.emit;
      agent.emit = (ev) => { orig(ev); if (ev.kind === 'done' || ev.kind === 'fail') resolve(ev); };
      agent.enqueue({ goal: '说说这一页的内容', by: 'her', key: 'private:1' });
    });
    ok('接线：read 之后真的接着干、能收尾', !!res && res.ok === true);
    ok('接线：读到的内容进了下一步的 prompt', JSON.stringify(calls[1] || []).includes('你刚读到的'));
    ok('接线：read 不算"没进展"（不会触发退路）', !/卡住|退一步|没反应/.test(String(res.summary || '')));

    /* ---------- 找字分档：完全相等 > desc > 前缀 > 包含（★ 2026-11-12） ---------- */

    /**
     * 旧版 `find()` 是"text 里包含就算命中"，于是：
     *   · 搜「菜谱」会先命中「菜谱大全」（点错 App）；
     *   · 有 text 的节点 **desc 被丢掉**（按 content-desc 写的那个词永远查不到）。
     * 现在五档 + 同档内优先内容区/可点。
     */
    const F = (text, extra = {}) => ({ ...N(text, extra), text, desc: extra.desc || '' });
    const exactScreen = {
      screen,
      nodes: [
        F('菜谱大全', { ref: 'n1', bounds: [0, 200, 720, 260] }),
        F('菜谱', { ref: 'n2', bounds: [40, 620, 220, 740], clickable: true }),
      ],
    };
    ok('找字：完全相等优先（不会被"菜谱大全"抢先）', s.find(exactScreen, '菜谱')?.ref === 'n2');
    const descScreen = { screen, nodes: [F('', { ref: 'n9', desc: '相册', bounds: [40, 300, 220, 420], clickable: true })] };
    ok('找字：只有 content-desc 也能找到', s.find(descScreen, '相册')?.ref === 'n9');
    const prefixScreen = { screen, nodes: [F('我的相册收藏夹', { ref: 'n7' }), F('相册备份', { ref: 'n8' })] };
    ok('找字：前缀优先于包含', s.find(prefixScreen, '相册')?.ref === 'n8');
    const bothScreen = { screen, nodes: [F('图库', { ref: 'n5', desc: '相册', bounds: [40, 300, 220, 420] })] };
    ok('找字：enrich 保留 desc（两个字段都能查）', s.enrich(bothScreen.nodes, screen)[0].desc === '相册');
    ok('找字：找不到仍然是 null（不猜）', s.find({ screen, nodes: [F('菜谱大全')] }, '天气') === null);
  },
};
