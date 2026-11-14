/**
 * 自检区域：她的「网」（P2，2026-11-06）
 *
 * 验的是"搜图 → 挑一张 → 存进收藏夹"这条链，**全部用假 fetch**，不碰真网络。
 * 真接口另有一份：`node tools\_probe-web.cjs 小肥鱼`。
 *
 * 单跑：`node test\run-one.cjs 27-her-web.cjs`
 */
module.exports = {
  name: '她的网（搜图/存图/读页）',
  tags: ['companion', 'phone', '手机', 'web'],
  async run(ctx) {
    const { ok } = ctx;
    const fs = require('node:fs');
    const path = require('node:path');
    const os = require('node:os');
    const web = ctx.mod('her-web');
    const agentMod = ctx.mod('phone-agent');

    /* ---------- 1. 抠候选（真机那种 HTML 形状） ---------- */

    const html = `<!doctype html><html><body>
      <a class="iusc" href="#" m="{&quot;murl&quot;:&quot;http://i.a.com/1.jpg&quot;,&quot;turl&quot;:&quot;http://t.a.com/1.jpg&quot;,&quot;t&quot;:&quot;小肥鱼 的图像结果&quot;}"></a>
      <a class="iusc" href="#" m="{&quot;murl&quot;:&quot;http://i.b.com/2.jpg&quot;,&quot;turl&quot;:&quot;http://t.b.com/2.jpg&quot;,&quot;t&quot;:&quot;蓝发小女仆&quot;}"></a>
      <a class="iusc" href="#" m="{&quot;murl&quot;:&quot;http://i.a.com/1.jpg&quot;,&quot;t&quot;:&quot;重复的&quot;}"></a>
    </body></html>`;
    const items = web.parseBingImages(html, 8);
    ok('抠候选：拿到两张', items.length === 2);
    ok('抠候选：标题和原图地址都在', items[1].title === '蓝发小女仆' && items[1].murl === 'http://i.b.com/2.jpg');
    ok('抠候选：同一张不重复', items.filter((x) => x.murl === 'http://i.a.com/1.jpg').length === 1);
    ok('抠候选：编号从 1 开始', items[0].i === 1 && items[1].i === 2);

    const bare = '<div>murl&quot;:&quot;http://only.com/x.jpg&quot;</div>';
    const fallback = web.parseBingImages(bare, 8);
    ok('抠候选：结构改了就只抠地址（宁可没标题）', fallback.length === 1 && fallback[0].murl === 'http://only.com/x.jpg');
    ok('抠候选：什么都没有就返回空（不编）', web.parseBingImages('<html></html>', 8).length === 0);

    /* ---------- 2. searchImages：拿到 / 拿不到 ---------- */

    const fakeFetch = (body, { status = 200, throwIt = false } = {}) => async () => {
      if (throwIt) throw new Error('连接被重置');
      return { ok: status >= 200 && status < 300, status, text: async () => body, headers: { get: () => '' } };
    };

    const r1 = await web.searchImages('小肥鱼', { fetchImpl: fakeFetch(html) });
    ok('搜图：能拿到候选', r1.ok === true && r1.items.length === 2);
    ok('搜图：走的是图片搜索', /\/images\/search/.test(r1.url || ''));

    const r2 = await web.searchImages('小肥鱼', { fetchImpl: fakeFetch('', { throwIt: true }) });
    ok('搜图：连不上就如实失败', r2.ok === false && !!r2.error && r2.items.length === 0);

    const r3 = await web.searchImages('小肥鱼', { fetchImpl: fakeFetch('<html>空</html>') });
    ok('搜图：页面里没有图就说没有', r3.ok === false && /没找到图/.test(r3.error));

    /* ---------- 3. saveImage：真的落盘 ---------- */

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsp-web-'));
    const binFetch = async () => ({
      ok: true, status: 200,
      headers: { get: (k) => (k === 'content-length' ? '5' : '') },
      arrayBuffer: async () => Buffer.from('hello'),
    });
    const s1 = await web.saveImage('http://i.a.com/1.jpg', { dir, name: '顺眼的鱼', fetchImpl: binFetch });
    ok('存图：文件真的写下来了', s1.ok === true && fs.existsSync(s1.file));
    ok('存图：扩展名跟着地址走', /\.jpg$/.test(s1.file));
    ok('存图：文件名里不许有斜杠/空格', !/[\\/\s]/.test(path.basename(s1.file, '.jpg')));
    const s2 = await web.saveImage('not-a-url', { dir, fetchImpl: binFetch });
    ok('存图：地址不对就不动', s2.ok === false);
    const s3 = await web.saveImage('http://i.a.com/3.jpg', { dir: '', fetchImpl: binFetch });
    ok('存图：没给目录就不写', s3.ok === false);

    /* ---------- 4. readPage（P3 会用，先验住） ---------- */

    const page = '<html><head><title>测试页</title><style>x{}</style></head><body><script>a()</script><h1>标题</h1><p>正文内容</p></body></html>';
    const p1 = await web.readPage('http://x.com/p', { fetchImpl: fakeFetch(page) });
    ok('读页：标题拿到了', p1.ok === true && p1.title === '测试页');
    ok('读页：正文里没有脚本和标签', /正文内容/.test(p1.text) && !/[<>]/.test(p1.text) && !/a\(\)/.test(p1.text));

    /* ---------- 5. 接线：她真的挑了一张 ---------- */

    const screen = { width: 720, height: 1280 };
    const N = (text, extra = {}) => ({
      ref: 'n0', text, desc: '', class: 'TextView', clickable: true, editable: false,
      scrollable: false, checkable: false, checked: false, enabled: true,
      bounds: [0, 100, 720, 200], center: [360, 150], pkg: 'mark.via', ...extra,
    });
    const browser = { app: '浏览器', pkg: 'mark.via', hash: 'h-via', table: 'n0 地址栏', nodes: [N('地址栏')] };
    const grid = { app: '浏览器', pkg: 'mark.via', hash: 'h-grid', table: 'n0 小肥鱼表情包', nodes: [N('小肥鱼表情包')] };

    function fakePhone(screens) {
      let i = 0;
      const hits = {};
      const cur = () => screens[Math.min(i, screens.length - 1)];
      return {
        hits,
        async state() { return { online: true, booted: true, screen, app: { package: cur().pkg, name: cur().app } }; },
        async observe() { return { ok: true, app: { package: cur().pkg, name: cur().app }, screen, nodes: cur().nodes, table: cur().table, hash: cur().hash, count: 1, more: 0, thin: false }; },
        async openUrl(url) { hits.url = url; if (i < screens.length - 1) i += 1; return { ok: true }; },
        async tap() { return { ok: true, changed: true }; },
        async tapXY() { return { ok: true }; },
        async text() { return { ok: true }; },
        async key() { return { ok: true }; },
        async launch() { return { ok: true }; },
        async swipeDir() { return { ok: true, changed: true }; },
        async waitChange() { return { changed: false }; },
        async focusApp() { return cur().pkg; },
        async screenshot() { return { ok: false }; },
      };
    }

    function mkAgent(phone, replies, webImpl) {
      const calls = [];
      const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dsp-web-agent-'));
      const agent = new agentMod.PhoneAgent({
        adb: phone,
        model: { model: 'stub', baseUrl: 'http://127.0.0.1:1', maxTokens: 80, timeoutMs: 5000 },
        callModel: async (m, messages) => {
          calls.push(messages);
          return { text: replies[Math.min(calls.length - 1, replies.length - 1)] };
        },
        dir: d,
        rescue: { enabled: false },
        web: webImpl,
      });
      const run = (goal) => new Promise((resolve) => {
        const orig = agent.emit;
        agent.emit = (ev) => { orig(ev); if (ev.kind === 'done' || ev.kind === 'fail') resolve(ev); };
        agent.enqueue({ goal, by: 'her', key: 'private:1' });
      });
      return { run, calls, dir: d, phone };
    }

    const fakeWeb = {
      async searchImages() {
        return {
          ok: true,
          items: [
            { i: 1, title: '猫猫图', murl: 'http://x/1.jpg' },
            { i: 2, title: '顺眼的鱼', murl: 'http://x/2.jpg' },
          ],
        };
      },
      async saveImage(url, { dir: d, name }) {
        fs.mkdirSync(d, { recursive: true });
        const f = path.join(d, `${name}-x.jpg`);
        fs.writeFileSync(f, 'x');
        return { ok: true, file: f, bytes: 1 };
      },
    };

    /**
     * ★ 2026-11-06 21:40：看图/存图改成**她自己的两个动作**（`images 词` / `save 3`），
     * 不再是"搜图那一趟自动替她挑"。这里验的就是这条新链路。
     */
    const a1 = mkAgent(fakePhone([browser, grid]), ['images 小肥鱼', 'save 2', 'done 挑好了'], fakeWeb);
    const res1 = await a1.run('看小肥鱼的图片');
    ok('接线：她自己转到了图片页', /images\/search/.test(a1.phone.hits.url || ''));
    ok('接线：她说 save 2 就存第 2 张', res1.ok === true && /挑好了/.test(res1.summary));
    ok('接线：真的落进了收藏夹目录', (() => {
      const col = path.join(a1.dir, '..', 'stickers', 'collected');
      return fs.existsSync(col) && fs.readdirSync(col).length > 0;
    })());

    /* 没有候选 / 没给词：不许装 */

    const { run: _r, calls: _c, dir: d2 } = mkAgent(fakePhone([browser]), [], fakeWeb);
    const probe = new agentMod.PhoneAgent({
      adb: fakePhone([browser]),
      model: { model: 'stub', baseUrl: 'http://127.0.0.1:1', maxTokens: 80, timeoutMs: 5000 },
      callModel: async () => ({ text: 'done' }),
      dir: d2,
      rescue: { enabled: false },
      web: fakeWeb,
    });
    const empty = await probe.savePicked({ steps: [] }, '1');
    ok('接线：还没图可选就不装存过', /还没有图可选/.test(empty.note));
    const noWord = await probe.imagesSearch({ steps: [] }, '');
    ok('接线：images 没给词就如实说', /要跟一个词/.test(noWord.note));
    const noWeb = new agentMod.PhoneAgent({
      adb: fakePhone([browser]),
      model: { model: 'stub', baseUrl: 'http://127.0.0.1:1', maxTokens: 80, timeoutMs: 5000 },
      callModel: async () => ({ text: 'done' }),
      dir: d2,
      rescue: { enabled: false },
      web: null,
    });
    const noWebRes = await noWeb.imagesSearch({ steps: [] }, '猫');
    ok('接线：没有"网"这一层就不假装能拿候选', /拿不到图片候选/.test(noWebRes.note));

    /* ---------- 6. 网页结果页：把"每一条 = 一个网址"取回来（★ 2026-11-08） ---------- */

    /**
     * 他问过「点图片左边的网页，去哪里找网址」—— 手机上那个浏览器的无障碍树
     * 只有标题碎片 + 一行域名，说不出"都是哪些网站"。这一层在 PC 侧抓同一页。
     * 两种版式**都要认**（同一天同一台机器实测就拿到了两种）。
     */
    const mobileHtml = `<!doctype html><ol id="b_results">
      <li class="b_algo" data-id iid=SERP.1><link rel="stylesheet" href="/a.css"/>
        <div class="b_tpcn"><a class="tilk" href="https://aigengtu.com/DeepSeek"><div class="tptt">aigengtu.com</div>
          <cite>https://aigengtu.com › DeepSeek娘</cite></a></div>
        <div class="b_algoheader"><a href="https://aigengtu.com/DeepSeek" h="ID=SERP,1.2"><h2>DeepSeek娘<strong>表情包</strong> · 2781张蓝色大肥鱼梗图</h2></a></div>
        <div class="b_caption"><p class="b_lineclamp3">DeepSeek娘是谁？先给没见过的朋友补一句…</p></div></li>
      <li class="b_algo" data-id iid=SERP.2>
        <div class="b_tpcn"><a class="tilk" href="https://zhuanlan.zhihu.com/p/1"><div class="tptt">zhuanlan.zhihu.com</div></a></div>
        <div class="b_algoheader"><a href="https://zhuanlan.zhihu.com/p/1"><h2>蓝色大肥鱼表情包合集（192个）</h2></a></div>
        <div class="b_caption"><p>整理了一份合集…</p></div></li>
    </ol>`;
    const mr = web.parseBingResults(mobileHtml, 8);
    ok('结果页（手机版式）：两条都取到了', mr.length === 2);
    ok('结果页（手机版式）：标题不被 <strong> 咬碎', mr[0].title === 'DeepSeek娘表情包 · 2781张蓝色大肥鱼梗图');
    ok('结果页（手机版式）：网址是真网址，不是跳转壳', mr[0].url === 'https://aigengtu.com/DeepSeek');
    ok('结果页（手机版式）：站点名和摘要都带回来了', mr[0].site === 'aigengtu.com' && /DeepSeek娘是谁/.test(mr[0].snippet));

    const deskHtml = `<ol><li class="b_algo">
        <h2><a href="https://news.cctv.com/2026/x.shtml">中国新闻_央视网</a></h2>
        <div class="b_caption"><p>央视网的新闻</p></div></li></ol>`;
    const dr = web.parseBingResults(deskHtml, 8);
    ok('结果页（桌面版式）：也认（h2 里包着 a）',
      dr.length === 1 && dr[0].url === 'https://news.cctv.com/2026/x.shtml' && dr[0].title === '中国新闻_央视网');

    const ckUrl = `https://cn.bing.com/ck/a?!&&p=abc&u=a1${Buffer.from('https://example.com/中文?x=1', 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}&ntb=1`;
    ok('结果页：ck/a 跳转壳能解回真网址', web.unwrapCk(ckUrl) === 'https://example.com/中文?x=1');

    const navHtml = `<ol><li class="b_algo b_nav"><h2><a href="https://www.bing.com/news">相关新闻</a></h2></li>
      <li class="b_algo"><h2><a href="https://real.com/p">真的结果</a></h2></li></ol>`;
    const nr = web.parseBingResults(navHtml, 8);
    ok('结果页：b_algo b_nav 是栏目头，不算一条结果', nr.length === 1 && nr[0].url === 'https://real.com/p');
    ok('结果页：解析不出来就返回空（不编）', web.parseBingResults('<html></html>', 8).length === 0);

    const rq = await web.searchResults('小肥鱼表情包', { fetchImpl: fakeFetch(mobileHtml) });
    ok('搜网页：走的是网页搜索（不是图片页）', rq.ok === true && /\/search\?q=/.test(rq.url) && !/images/.test(rq.url));
    ok('搜网页：拿到两条结果', rq.ok === true && rq.items.length === 2);

    /* ---------- 7. 她"顺手"的两个动作不许顶掉正事（★ 2026-11-08） ---------- */

    /**
     * 真机 22:05：他让她搜网页、点开一个网站看；她搜完直接 `images` → `save ×4`，
     * 一次 `open` 都没做。所以 `images` 要在"他没说要图"时被打回。
     */
    const chatTask = { src: 'chat', goal: '搜小肥鱼表情包', root: '搜小肥鱼表情包', steps: [] };
    const gate = await probe.imagesSearch(chatTask, '小肥鱼表情包');
    ok('门禁：他没说要图 → images 被打回，指向 open 1', /没让你找图/.test(gate.note) && /open 1/.test(gate.note));

    const picTask = { src: 'chat', goal: '看小肥鱼的图片', root: '看小肥鱼的图片', steps: [] };
    ok('门禁：他说要看图 → 放行', !/没让你找图/.test(String((await probe.imagesSearch(picTask, '小肥鱼')).note)));
    ok('门禁：她自己想玩的场景不受这条限制（src=session）',
      !/没让你找图/.test(String((await probe.imagesSearch({ src: 'session', goal: '随便看看', steps: [] }, '猫')).note)));

    /* 同一趟重复 save 要去重（真机 22:05 是 save 1 ×2 + save 5 ×2，摘要却说存了两张） */
    const dupTask = { steps: [], imageCandidates: [{ title: '甲', murl: 'http://x/1.jpg' }], savedImages: new Set() };
    const s1st = await probe.savePicked(dupTask, '1');
    const s2nd = await probe.savePicked(dupTask, '1');
    ok('去重：第一次真的存', /存了第 1 张/.test(s1st.note));
    ok('去重：第二次说"已经存过了"、不再下一次', /已经存过/.test(s2nd.note));

    /* ---------- 8. open 前要核对序号（宁可点屏幕，也不打开错的网站） ---------- */

    ok('核对：域名对得上 = 同一条',
      probe.sameResult({ url: 'aigengtu.com', title: '' }, { url: 'https://aigengtu.com/x', title: 'DeepSeek娘表情包' }, {}) === true);
    ok('核对：标题前几个字一致 = 同一条',
      probe.sameResult({ url: '', title: 'DeepSeek娘表情包 · 2781张' }, { url: 'https://a.com/1', title: 'DeepSeek娘表情包 · 2781张蓝色大肥鱼' }, {}) === true);
    ok('核对：对不上就**不**用 openurl',
      probe.sameResult({ url: 'other.com', title: '完全不同的标题' }, { url: 'https://aigengtu.com/x', title: 'DeepSeek娘表情包' }, {}) === false);
    ok('核对：这一屏认不出条目时，只有"这一趟刚搜过"才认',
      probe.sameResult(null, { url: 'https://a.com/1', title: 'x' }, {}) === false
      && probe.sameResult(null, { url: 'https://a.com/1', title: 'x' }, { searchWord: '猫' }) === true);
  },
};
