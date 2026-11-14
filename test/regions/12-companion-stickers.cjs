/**
 * 自检区域：陪伴模式「发表情包」（2026-10-26 新增）。
 *
 * 两条来源都要验：
 *   A. 小号 QQ 收藏表情 —— `fetch_custom_face_detail` 的 `url/desc` 能下载并进目录；
 *   B. 本地文件夹 —— 文件名就是关键词。
 * 再加一条**端到端**：模型回 `晚安 [表情:晚安]` → 先发文字、再把 `晚安.png` 发出去。
 *
 * 单跑：`node test\run-one.cjs 12-companion-stickers.cjs`
 */
module.exports = {
  name: '陪伴模式：表情包',
  tags: ['companion', 'sticker', '表情包', 'image'],
  async run(ctx) {
    const { ok, fs, path, http } = ctx;
    const stickers = ctx.mod('companion-stickers');
    const onebot = ctx.mod('companion-onebot');
    const brainMod = ctx.mod('companion-brain');
    const { CompanionMemory } = ctx.mod('companion-memory');

    const PNG = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    const waitFor = async (fn, ms = 8000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        const v = fn();
        if (v) return v;
        await new Promise((r) => setTimeout(r, 40));
      }
      return null;
    };

    /* ---------- A. 解析 / 挑选 ---------- */

    const mf = onebot.segsToMfaces([{
      type: 'mface',
      data: { emoji_package_id: 123, emoji_id: 'abc', key: 'k', summary: '晚安' },
    }]);
    ok('解析：QQ 商城表情（mface）留下三件套', mf.length === 1 && mf[0].emojiPackageId === 123
      && mf[0].emojiId === 'abc' && mf[0].key === 'k');
    ok('解析：mface 在正文里是 [表情]（不会被当成空消息丢掉）',
      onebot.segsToText([{ type: 'mface', data: { emoji_id: 'a', key: 'k' } }]) === '[表情]');

    const ex = stickers.extract('好呀 [表情:晚安] 明天见');
    ok('解析：把 [表情:关键词] 从文字里摘掉', !ex.text.includes('[表情') && ex.text.includes('好呀') && ex.text.includes('明天见'));
    ok('解析：关键词被单独收走', ex.queries.length === 1 && ex.queries[0] === '晚安');
    const ex2 = stickers.extract('晚安\n[表情：晚安]\n[表情:开心]');
    ok('解析：多个表情行都认得（全角冒号也行）', ex2.queries.length === 2 && ex2.text === '晚安');

    const list = [
      { file: 'a', tag: '晚安' }, { file: 'b', tag: '晚安抱抱' }, { file: 'c', tag: '开心' },
    ];
    ok('挑选：精确命中优先', stickers.pick(list, '晚安').file === 'a' || stickers.pick(list, '晚安').file === 'b');
    ok('挑选：关键词对不上就随机给一张（不哑火）', !!stickers.pick([{ file: 'x', tag: '开心' }], '不存在'));
    const plan = stickers.plan('晚安 [表情:开心]', list);
    ok('计划：文字留下、图挑出来', plan.text === '晚安' && plan.picks.length === 1 && plan.picks[0].file === 'c');
    const pc = stickers.parseCollect('好可爱 [收藏:新表情] 收下了');
    ok('收藏：把 [收藏:关键词] 摘出来', !pc.text.includes('[收藏') && pc.tags.length === 1 && pc.tags[0] === '新表情');

    /* ---------- B. 本地目录 ---------- */

    const localDir = path.join(ctx.CONFIG_DIR, 'local-stickers');
    fs.mkdirSync(localDir, { recursive: true });
    fs.writeFileSync(path.join(localDir, '晚安.png'), PNG);
    fs.writeFileSync(path.join(localDir, '开心.jpg'), PNG);
    fs.writeFileSync(path.join(localDir, 'README.txt'), 'x');
    const local = stickers.catalog(localDir, '');
    ok('本地：只收图片、文件名就是关键词', local.length === 2
      && local.some((x) => x.tag === '晚安') && local.some((x) => x.tag === '开心'));
    ok('本地：发图用的 base64:// 协议', stickers.toBase64Protocol(path.join(localDir, '晚安.png')).startsWith('base64://'));

    const collectedImg = stickers.collectImage(localDir, path.join(localDir, '晚安.png'), '收下的晚安');
    ok('收藏：图片进 collected/，文件名带关键词', collectedImg.kind === 'image'
      && collectedImg.file.includes('collected') && collectedImg.tag === '收下的晚安' && fs.existsSync(collectedImg.file));
    ok('收藏：图片出现在总目录里', stickers.catalog(localDir, '')
      .some((x) => x.source === 'collected' && x.tag === '收下的晚安'));
    const face = { emojiPackageId: 1, emojiId: 'e1', key: 'k1', summary: '晚安' };
    const cm1 = stickers.collectMface(localDir, face, 'QQ晚安');
    const cm2 = stickers.collectMface(localDir, face, '晚安');
    ok('收藏：mface 存进 mface-index.json', cm1.kind === 'mface'
      && fs.existsSync(path.join(localDir, 'mface-index.json')));
    ok('收藏：同一个 mface 只存一份，tag 可以改名', cm2.tag === '晚安'
      && stickers.catalog(localDir, '').filter((x) => x.source === 'mface').length === 1);

    /* ---------- C. 小号 QQ 收藏 ---------- */

    const imageServer = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'image/png' });
      // 两张图必须是**不同的字节**，否则按内容哈希会被去重成一张
      res.end(req.url === '/two.png' ? Buffer.concat([PNG, Buffer.from([1, 2, 3])]) : PNG);
    });
    const imagePort = await new Promise((r) => imageServer.listen(0, '127.0.0.1', () => r(imageServer.address().port)));
    const fakeClient = {
      calls: [],
      async call(action) {
        this.calls.push(action);
        if (action !== 'fetch_custom_face_detail') return { ok: false, error: 'unexpected' };
        return {
          ok: true,
          data: [
            { url: `http://127.0.0.1:${imagePort}/one.png`, desc: '晚安', resId: 'r1' },
            { url: `http://127.0.0.1:${imagePort}/two.png`, desc: '开心', resId: 'r2' },
          ],
        };
      },
    };
    const qqDir = path.join(ctx.CONFIG_DIR, 'qq-fav');
    const qq = await stickers.refreshQq({ client: fakeClient, qqDir, allowPrivate: true });
    ok('QQ 收藏：拉 detail 并下载进 qq/ 目录', qq.length === 2 && fakeClient.calls[0] === 'fetch_custom_face_detail'
      && qq.every((x) => fs.existsSync(x.file)));
    ok('QQ 收藏：desc 变成关键词', qq.some((x) => x.tag === '晚安') && qq.some((x) => x.tag === '开心'));
    ok('QQ 收藏：写了一份 qq-index.json', fs.existsSync(path.join(qqDir, 'qq-index.json')));
    ok('QQ 收藏：能进总目录', stickers.catalog(localDir, qqDir).filter((x) => x.source === 'qq').length === 2);
    imageServer.close();

    /* ---------- D. 大脑知道有哪些表情 ---------- */

    const mem = new CompanionMemory({ dir: path.join(ctx.CONFIG_DIR, 'mem-sticker') });
    const seen = [];
    const modelSrv = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        seen.push(JSON.parse(raw || '{}'));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: '晚安 [表情:晚安]' } }] }));
      });
    });
    const modelPort = await new Promise((r) => modelSrv.listen(0, '127.0.0.1', () => r(modelSrv.address().port)));
    const brain = new brainMod.CompanionBrain({
      memory: mem,
      roleText: '测试角色',
      model: { baseUrl: `http://127.0.0.1:${modelPort}`, model: 'test-model', apiKey: '', maxTokens: 64, timeoutMs: 5000 },
    });
    const r = await brain.reply({ userId: '1', userName: 'A', text: '晚安', where: 'private:1', stickerTags: ['晚安', '开心'] });
    const sys = seen[0].messages[0].content;
    ok('大脑：system 里带上表情关键词和写法', sys.includes('表情包') && sys.includes('晚安') && sys.includes('[表情:关键词]'));
    ok('大脑：模型写的 [表情:晚安] 会原样留在文字里（由 World 摘）', r.text.includes('[表情:晚安]'));
    modelSrv.close();

    /* ---------- E. 端到端：文字 + 表情一起发出去 ---------- */

    const records = [];
    const api = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        records.push({ url: req.url, body: JSON.parse(raw || '{}') });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: records.length } }));
      });
    });
    const apiPort = await new Promise((r) => api.listen(0, '127.0.0.1', () => r(api.address().port)));
    const { WebSocketServer } = require(path.join(ctx.app, 'node_modules', 'ws'));
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise((r) => wss.once('listening', r));
    const wsPort = wss.address().port;

    // 假模型：默认带 [收藏:新表情]；后面测"只嘴上说存了"时会临时换掉
    let modelReply = '晚安 [收藏:新表情] [表情:晚安]';
    const model2 = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: modelReply } }] }));
      });
    });
    const model2Port = await new Promise((r) => model2.listen(0, '127.0.0.1', () => r(model2.address().port)));

    const picSrv = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(PNG);
    });
    const picPort = await new Promise((r) => picSrv.listen(0, '127.0.0.1', () => r(picSrv.address().port)));

    const companion = ctx.mod('companion');
    const dataDir = companion.DATA_DIR;
    const stickerDir = path.join(dataDir, 'stickers');
    fs.mkdirSync(stickerDir, { recursive: true });
    fs.writeFileSync(path.join(stickerDir, '晚安.png'), PNG);

    const connP = new Promise((r) => wss.once('connection', r));
    companion.save({
      enabled: true,
      adapter: 'builtin',
      onebot: { wsUrl: `ws://127.0.0.1:${wsPort}`, httpUrl: `http://127.0.0.1:${apiPort}`, accessToken: '' },
      model: { baseUrl: `http://127.0.0.1:${model2Port}`, model: 'test-model', apiKey: 'k', maxTokens: 64 },
      humanize: { enabled: false },
      wake: { privateWindowMs: 60 },
      ownerIds: ['10001'],
    });
    const sock = await connP;
    sock.send(JSON.stringify({ post_type: 'meta_event', meta_event_type: 'lifecycle', self_id: 999 }));
    sock.send(JSON.stringify({
      post_type: 'message', message_type: 'private', self_id: 999, user_id: 10001,
      time: Math.floor(Date.now() / 1000), sender: { nickname: 'A' },
      message: [
        { type: 'text', data: { text: '晚安' } },
        { type: 'image', data: { url: `http://127.0.0.1:${picPort}/x.png`, file: 'x.image' } },
      ],
    }));
    const sends = await waitFor(() => {
      const s = records.filter((x) => x.url === '/send_private_msg');
      return s.length >= 2 ? s : null;
    });
    ok('端到端：先发文字（表情行已从文字里去掉）', !!sends
      && sends[0].body.message[0].data.text === '晚安');
    ok('端到端：接着发本地「晚安.png」', !!sends
      && sends[1].body.message[0].type === 'image'
      && sends[1].body.message[0].data.file.startsWith('base64://'));
    const collectedDir = path.join(stickerDir, 'collected');
    const collectedFiles = fs.existsSync(collectedDir) ? fs.readdirSync(collectedDir) : [];
    ok('端到端：她写 [收藏:新表情] 就把来图存进 collected/', collectedFiles.some((f) => f.startsWith('新表情-')));

    // 用户直接命令收藏：发图 + “存表情 睡前”
    sock.send(JSON.stringify({
      post_type: 'message', message_type: 'private', self_id: 999, user_id: 10001,
      time: Math.floor(Date.now() / 1000), sender: { nickname: 'A' },
      message: [
        { type: 'text', data: { text: '存表情 睡前' } },
        { type: 'image', data: { url: `http://127.0.0.1:${picPort}/y.png`, file: 'y.image' } },
      ],
    }));
    const cmdCollected = await waitFor(() => {
      const files = fs.existsSync(collectedDir) ? fs.readdirSync(collectedDir) : [];
      return files.some((f) => f.startsWith('睡前-')) ? files : null;
    });
    ok('端到端：用户说「存表情 睡前」也会存下来', !!cmdCollected);

    /**
     * ★ 2026-11-01 修（纯函数守卫）：**"收到" 不是收藏命令**。
     * 老正则把动词的补语当关键词（`收到→"到"`），于是：
     * 手边有图 → 上一张被悄悄存成「到」；手边没图 → 她回"你发的是哪张图"。
     */
    const cc = companion.collectCommand;
    ok('命令解析：「收到 / 存了 / 收好了」不再被当成收藏命令',
      cc('收到') === null && cc('收到了') === null && cc('存了') === null && cc('收好了') === null);
    ok('命令解析：真命令照旧认（含「存一下 晚安」这种以前认不出的）',
      cc('存表情 晚安') === '晚安' && cc('收藏 晚安') === '晚安' && cc('存一下 晚安') === '晚安'
      && cc('收藏这个') === '' && cc('收下') === '');

    /**
     * ★ 2026-10-28：真实翻车场景 —— 先发一张图，下一句才说"你存一下吧"。
     * 以前"存"这句手里没有图（只认当前这一批），她就嘴上说"存了"，什么都没存。
     * 现在按会话记住 10 分钟内的最后一张图，而且她没写 `[收藏:]` 时替她补上。
     */
    modelReply = '这兔子还挺会来事儿。';
    sock.send(JSON.stringify({
      post_type: 'message', message_type: 'private', self_id: 999, user_id: 10001,
      time: Math.floor(Date.now() / 1000), sender: { nickname: 'A' },
      message: [{ type: 'image', data: { url: `http://127.0.0.1:${picPort}/z.png`, file: 'z.image' } }],
    }));
    await waitFor(() => records.filter((x) => x.url === '/send_private_msg')
      .some((x) => String(x.body.message[0]?.data?.text || '').includes('兔子')));
    modelReply = '存了，就是不知道下次啥时候能想起来用。';
    sock.send(JSON.stringify({
      post_type: 'message', message_type: 'private', self_id: 999, user_id: 10001,
      time: Math.floor(Date.now() / 1000), sender: { nickname: 'A' },
      message: [{ type: 'text', data: { text: '这么可爱的表情，你存一下吧' } }],
    }));
    const ghostCollected = await waitFor(() => {
      const files = fs.existsSync(collectedDir) ? fs.readdirSync(collectedDir) : [];
      return files.some((f) => f.startsWith('表情-')) ? files : null;
    });
    ok('端到端：她只说"存了"没写标记，也会把上一张替她存下来', !!ghostCollected);

    const faceClient = new onebot.OneBotClient({
      wsUrl: 'ws://127.0.0.1:1', httpUrl: `http://127.0.0.1:${apiPort}`, accessToken: '',
      onMessage: () => {}, onStatus: () => {},
    });
    const faceRes = await faceClient.sendMface('private:123', {
      emojiPackageId: 7, emojiId: 'e7', key: 'k7', summary: '晚安',
    });
    const faceRec = records.filter((x) => x.url === '/send_private_msg').at(-1);
    ok('发图：mface 三件套发得出去', faceRes.ok
      && faceRec.body.message[0].type === 'mface'
      && faceRec.body.message[0].data.emoji_package_id === 7
      && faceRec.body.message[0].data.emoji_id === 'e7');

    companion.save({ enabled: false });
    try { sock.close(); } catch { /* 已关 */ }
    wss.close();
    api.close();
    model2.close();
    picSrv.close();
  },
};
