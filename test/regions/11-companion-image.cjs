/**
 * 自检区域：陪伴模式「看图」（2026-10-26 新增）。
 *
 * 目标：证明图片从 OneBot 段 → 下载/缓存 → 多模态 `content` → 模型 → 记忆 这条链是通的，
 * 而且**不把 base64 写进记忆**、**不让内网地址混进来**（生产默认拒绝；自检用假图床才放开）。
 *
 * 不碰真 QQ、不碰真模型：图床和 OneBot 都是本地假服务。
 * 单跑：`node test\run-one.cjs 11-companion-image.cjs`
 */
module.exports = {
  name: '陪伴模式：看图',
  tags: ['companion', 'image', '图片', 'vision'],
  async run(ctx) {
    const { ok, fs, path, http } = ctx;
    const onebot = ctx.mod('companion-onebot');
    const media = ctx.mod('companion-media');
    const brainMod = ctx.mod('companion-brain');
    const caps = ctx.mod('companion-capabilities');
    const { CompanionMemory } = ctx.mod('companion-memory');

    const PNG = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    const waitFor = async (fn, ms = 5000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        const v = fn();
        if (v) return v;
        await new Promise((r) => setTimeout(r, 30));
      }
      return null;
    };

    /* ---------- A. 消息段解析 ---------- */

    const segs = onebot.segsToImages([
      { type: 'text', data: { text: '看这个' } },
      { type: 'image', data: { url: 'https://gchat.qpic.cn/a.png', file: 'abc.image', summary: '图' } },
      { type: 'face', data: { id: '1' } },
    ]);
    ok('解析：数组消息里的图片段被单独留下来', segs.length === 1 && segs[0].url.includes('gchat.qpic.cn'));
    const cq = onebot.cqToImages('你好[CQ:image,file=b.jpg,url=https://x/b.jpg]');
    ok('解析：字符串 CQ 码里的图片也能拿到', cq.length === 1 && cq[0].url === 'https://x/b.jpg');
    ok('解析：没有图的纯文本返回空数组', onebot.segsToImages([{ type: 'text', data: { text: 'x' } }]).length === 0);

    /**
     * ★ 2026-11-01 修：`time` 单位。协议是**秒**，但有的网关给毫秒；原来一律 ×1000，
     * 收到毫秒就变成"5 万年以后"，`presence` 的"对方刚说完话 < 3 分钟"闸门永久成立
     * —— 她再也不会主动开口，且一条错都不报。
     */
    const T0 = 1_793_498_908;
    const fixedNow = T0 * 1000 + 5_000;
    ok('时间：秒级时间戳按秒算', onebot.normalizeTime(T0, fixedNow) === T0 * 1000);
    ok('时间：毫秒时间戳照用（不再被乘成 5 万年以后）', onebot.normalizeTime(T0 * 1000, fixedNow) === T0 * 1000);
    ok('时间：落在未来的时间戳按"现在"算（时钟不齐不会把闸门焊死）',
      onebot.normalizeTime(T0 + 3600, fixedNow) === fixedNow);
    ok('时间：缺字段就用现在', onebot.normalizeTime(undefined, fixedNow) === fixedNow);

    /* ---------- B. 类型/安全 ---------- */

    ok('类型：认 PNG / JPEG / GIF / WebP / BMP', media.sniffMime(PNG) === 'image/png'
      && media.sniffMime(Buffer.from([0xff, 0xd8, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0])) === 'image/jpeg'
      && media.sniffMime(Buffer.from('GIF89a----------')) === 'image/gif'
      && media.sniffMime(Buffer.from('RIFF0000WEBP----')) === 'image/webp'
      && media.sniffMime(Buffer.from('BM----------')) === 'image/bmp');
    ok('类型：不是图就返回空（不靠 content-type 撒谎）', media.sniffMime(Buffer.from('hello world!!')) === '');
    ok('安全：内网/本机地址判定', media.isPrivateHost('127.0.0.1') && media.isPrivateHost('localhost')
      && media.isPrivateHost('10.1.2.3') && media.isPrivateHost('192.168.1.2')
      && media.isPrivateHost('::1') && !media.isPrivateHost('gchat.qpic.cn') && !media.isPrivateHost('8.8.8.8'));

    /* ---------- C. 假图床：下载、去重、上限、SSRF ---------- */

    let lastReqUrl = '';
    const imageServer = http.createServer((req, res) => {
      lastReqUrl = req.url;
      if (req.url.startsWith('/ok.png')) { res.writeHead(200, { 'content-type': 'image/png' }); res.end(PNG); return; }
      if (req.url === '/big.png') {
        res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(7 * 1024 * 1024) });
        res.end(Buffer.concat([PNG, Buffer.alloc(7 * 1024 * 1024)]));
        return;
      }
      if (req.url === '/text') { res.writeHead(200, { 'content-type': 'image/png' }); res.end('not an image'); return; }
      res.writeHead(404); res.end('x');
    });
    const imagePort = await new Promise((r) => imageServer.listen(0, '127.0.0.1', () => r(imageServer.address().port)));
    const imageUrl = `http://127.0.0.1:${imagePort}/ok.png`;
    const mediaDir = path.join(ctx.CONFIG_DIR, 'media');

    const got = await media.resolveImages(mediaDir, [{ url: imageUrl }]);
    ok('下载：拿到一张图并落盘', got.length === 1 && got[0].dataUrl.startsWith('data:image/png;base64,')
      && fs.existsSync(got[0].file));
    const again = await media.resolveImages(mediaDir, [{ url: imageUrl }]);
    ok('缓存：同一张图哈希不变（只存一份）', again.length === 1 && again[0].hash === got[0].hash
      && fs.readdirSync(mediaDir).filter((f) => f.endsWith('.png')).length === 1);

    let blocked = '';
    try { await media.fetchImage(imageUrl, { allowPrivate: false }); } catch (err) { blocked = err.message; }
    ok('安全：生产默认拒绝 127.0.0.1 的图（防 SSRF）', blocked.includes('内网'));

    const tooBig = await media.resolveImages(path.join(ctx.CONFIG_DIR, 'media-big'), [{ url: `http://127.0.0.1:${imagePort}/big.png` }]);
    ok('上限：超过 6MB 的图被跳过', tooBig.length === 0);
    const notImage = await media.resolveImages(path.join(ctx.CONFIG_DIR, 'media-bad'), [{ url: `http://127.0.0.1:${imagePort}/text` }]);
    ok('类型：假 content-type 的非图被跳过', notImage.length === 0);

    const localPng = path.join(ctx.CONFIG_DIR, 'local.png');
    fs.writeFileSync(localPng, PNG);
    const local = await media.resolveImages(path.join(ctx.CONFIG_DIR, 'media-local'), [{ file: localPng }]);
    ok('本地：NapCat 缓存里的绝对路径也能读', local.length === 1 && local[0].dataUrl.startsWith('data:image/png'));

    /**
     * ★ 2026-11-01 修：**地址被 CDN 拒了要试本地文件**（真机 09:29 那张就是 URL 400）。
     * 原来 `url` 一失败就整张丢掉，明明 `file` 指的绝对路径就在盘上。
     */
    const fallback = await media.resolveImages(path.join(ctx.CONFIG_DIR, 'media-fb'), [
      { url: `http://127.0.0.1:${imagePort}/haha-404.png`, file: localPng },
    ]);
    ok('兜底：URL 取图失败时改用本地 file（不再整张丢掉）',
      fallback.length === 1 && fallback[0].dataUrl.startsWith('data:image/png') && fallback.dropped === 0);

    /**
     * ★ 2026-11-01 修（真机根因）：**先问网关，再试地址**。
     *
     * 实测 QQ 给的下载地址会过期：`HTTP 400 {"retcode":-5503007,"retmsg":"download url has expired"}`
     * （换 UA / 加 Referer / 不带 UA 四种都一样）。而 OneBot 的 `get_image` 每次都拿得到。
     * 所以这里钉两件事：① 网关给了就直接用、**根本不去碰那个会过期的地址**；② 网关没有才走地址。
     */
    let gatewayCalls = 0;
    let urlTouched = 0;
    const viaGateway = async () => {
      gatewayCalls += 1;
      return { buf: PNG, mime: 'image/png' };
    };
    const countingFetch = async (u, init) => { urlTouched += 1; return fetch(u, init); };
    const viaGw = await media.resolveImages(path.join(ctx.CONFIG_DIR, 'media-gw'), [
      { url: `http://127.0.0.1:${imagePort}/haha-404.png`, file: '相对名.jpg' },
    ], { viaGateway, fetchImpl: countingFetch });
    ok('网关优先：网关给得出图时就不去碰那个会过期的地址（也不联网）',
      viaGw.length === 1 && gatewayCalls === 1 && urlTouched === 0 && viaGw.dropped === 0);
    /** 网关不实现 / 拿不到时，退回原始地址（老网关仍然能用）。 */
    const noGw = await media.resolveImages(path.join(ctx.CONFIG_DIR, 'media-gw2'), [{ url: imageUrl }], {
      viaGateway: async () => null,
      fetchImpl: countingFetch,
    });
    ok('网关拿不到时退回原始地址（没有 get_image 的网关照旧能用）',
      noGw.length === 1 && urlTouched === 1);

    /**
     * ★ 2026-11-01 修：**`&amp;` 要还原**。
     * NapCat 有的版本是从 QQ 的 XML 里取 `url` 的，`&` 会留成 `&amp;`：
     * `new URL()` 照样解析（参数名变成 `amp;appid`）→ CDN 参数全错 → 正好 400。
     */
    ok('地址：`&amp;` 会还原成 `&`（NapCat 转义过的图片地址能下）',
      media.cleanUrl('https://x/download?appid=1&amp;fileid=2&amp;rkey=3')
        === 'https://x/download?appid=1&fileid=2&rkey=3');
    const ampGot = await media.resolveImages(path.join(ctx.CONFIG_DIR, 'media-amp'), [
      { url: `http://127.0.0.1:${imagePort}/ok.png?appid=1&amp;fileid=2&amp;rkey=3` },
    ]);
    ok('地址：带 `&amp;` 的地址**真的**能下（服务端收到的是 & 而不是 &amp;）',
      ampGot.length === 1 && lastReqUrl === '/ok.png?appid=1&fileid=2&rkey=3');
    ok('地址：日志只记主机+参数名，不把 rkey 这类凭据写进 pet.log', (() => {
      const shape = media.describeUrl(new URL('https://multimedia.nt.qq.com.cn/download?appid=1407&rkey=SECRET123456'));
      return shape.includes('multimedia.nt.qq.com.cn') && shape.includes('appid') && !shape.includes('SECRET123456');
    })());
    ok('统计：没拿到的张数记在返回值上（调用方靠它决定"要不要说没看见"）',
      notImage.dropped === 1 && got.dropped === 0);

    const evictDir = path.join(ctx.CONFIG_DIR, 'media-evict');
    fs.mkdirSync(evictDir, { recursive: true });
    for (let i = 0; i < 5; i += 1) {
      const p = path.join(evictDir, `f${i}.png`);
      fs.writeFileSync(p, PNG);
      const t = (Date.now() - (10 - i) * 1000) / 1000;
      fs.utimesSync(p, t, t);
    }
    media.evictCache(evictDir, { maxFiles: 2, maxBytes: 1024 * 1024 });
    ok('缓存：超出张数会淘汰最旧的', fs.readdirSync(evictDir).length === 2);

    imageServer.close();

    /* ---------- D. 大脑：多模态 content / 记忆不落 base64 ---------- */

    ok('多模态：纯文字仍然是字符串（老端点行为不变）',
      brainMod.buildUserContent('在吗', []) === '在吗');
    const parts = brainMod.buildUserContent('看', [{ dataUrl: 'data:image/png;base64,AAAA' }]);
    ok('多模态：有图就拼成 text + image_url 数组',
      Array.isArray(parts) && parts[0].type === 'text'
      && parts.some((p) => p.type === 'image_url' && p.image_url.url.startsWith('data:image/png')));

    const stub = await ctx.ensureStub();
    const memDir = path.join(ctx.CONFIG_DIR, 'mem-image');
    const memory = new CompanionMemory({ dir: memDir });
    const model = { baseUrl: stub.url, model: 'test-model', apiKey: 'k', maxTokens: 64, timeoutMs: 5000 };
    const brain = new brainMod.CompanionBrain({ memory, roleText: '测试角色', model });
    const r = await brain.reply({
      userId: '10001', userName: 'A', text: '看看这个', where: 'private:10001',
      images: [{ dataUrl: `data:image/png;base64,${PNG.toString('base64')}` }],
    });
    ok('大脑：这一轮真的把图发给了模型', (() => {
      const body = stub.seen.at(-1).body;
      const last = body.messages.at(-1);
      return Array.isArray(last.content)
        && last.content.some((p) => p.type === 'image_url' && p.image_url.url.startsWith('data:image/png'));
    })());
    ok('大脑：文字也在同一条 user 消息里（前面带一行【现在】）', (() => {
      const last = stub.seen.at(-1).body.messages.at(-1);
      return Array.isArray(last.content) && last.content.some((p) => p.type === 'text'
        && /^【现在】\d{4}-\d{2}-\d{2} \d{2}:\d{2} 周[一二三四五六日]\n/.test(p.text)
        && p.text.endsWith('\n看看这个'));
    })());
    ok('大脑：正常回了话', typeof r.text === 'string' && r.text.length > 0);
    const turns = fs.readFileSync(path.join(memDir, 'turns.jsonl'), 'utf8');
    ok('记忆：不把 base64 写进 turns.jsonl', !turns.includes('base64') && !turns.includes('iVBOR'));
    ok('记忆：正文仍记着这句', turns.includes('看看这个'));

    /**
     * ★ 2026-11-01 修（回归守卫）：**她自己开口（`unsolicited`）时也必须把图带上**。
     *
     * 手机回灌 `phoneFollowUp` 走的就是 `unsolicited: true` + 一张她自己的截图。
     * 原来那句是 `unsolicited ? 纯文字 : buildUserContent(...)`，图**根本没进请求**，
     * 而提示词写着"这张图确实会一起发过去"、能力提示写着"你能直接看到内容" —— 她只能编。
     * 这条断言就是钉住"图挂在哪条消息上跟谁先开口无关"。
     */
    await brain.reply({
      userId: '10001', userName: 'A', text: '（手机那边弄完了。）', where: 'private:10001',
      unsolicited: true,
      images: [{ dataUrl: `data:image/png;base64,${PNG.toString('base64')}` }],
    });
    ok('大脑：她自己开口时图照样进请求（unsolicited 不再吞掉图）', (() => {
      const last = stub.seen.at(-1).body.messages.at(-1);
      return Array.isArray(last.content)
        && last.content.some((p) => p.type === 'image_url');
    })());

    /**
     * ★ 2026-11-02：**她发出去的图要在流水里留痕**。
     *
     * 真机 20:44：她把手机截图发出去三秒后，他说"为什么在这里看一盘菜"，
     * 她回"**你这表情包**是打算把我捞出来还是接着加水"——把自己发的图算成了他的。
     * 根因：`turns.jsonl` 那一轮只有文字，图在不在、是谁发的，一个字都没有。
     */
    await brain.reply({
      userId: '10001', userName: 'A', text: '（手机那边弄完了。）', where: 'private:10001',
      unsolicited: true, media: ['图'],
    });
    const turns2 = fs.readFileSync(path.join(memDir, 'turns.jsonl'), 'utf8');
    ok('记忆：她自己发出去的图在 turns.jsonl 里留了痕（media:["图"]）',
      turns2.includes('"media":["图"]'));
    const recent2 = memory.renderRecent(3, { where: 'private:10001' });
    ok('记忆：回看时写成"你：…（发了图）"，下一轮她就知道那是自己发的',
      recent2.includes('（发了图）'));
    // 再聊一句：这一轮的**历史**里就该带着刚才那条"她发了图"
    await brain.reply({
      userId: '10001', userName: 'A', text: '那张图你看到了吗', where: 'private:10001',
    });
    ok('记忆：历史 messages 里也带着这个痕迹（她看得到"我发过图"）',
      (() => {
        const msgs = stub.seen.at(-1).body.messages;
        return msgs.some((m) => m.role === 'assistant' && String(m.content).includes('（发了图）'));
      })());
    const srcPhone = fs.readFileSync(path.join(ctx.app, 'companion.cjs'), 'utf8');
    ok('手机回灌：`phoneFollowUp` 真的把截图标成"她发的"（桌宠分支不塞图）',
      /media:\s*shot\s*&&\s*!isDesk\s*\?\s*\['图'\]\s*:\s*\[\]/.test(srcPhone));
    ok('自主开口：处境里钉住"只说这一件"，并带上念头的出生时间',
      srcPhone.includes('这一句就只说这一件') && srcPhone.includes('冒出来的，到现在'));

    /**
     * ★ 2026-11-01 修（诚实性）：**图没拿到就别装作看见了**。
     * 真机 09:29 / 09:31 两张图都是 HTTP 400 被跳过，她回"画面里看着像是一道菜"。
     */
    const hintsOf = (ctxObj) => caps.buildCapabilityHints(ctxObj);
    ok('提示：一张图都没拿到时，注入"你没看见，别猜"',
      hintsOf({ images: [], imagesDropped: 1 }).includes('没有传到你这边')
      && hintsOf({ images: [], imagesDropped: 1 }).includes('别描述'));
    ok('提示：图拿到了就照旧说"你能直接看到内容"，两条互斥',
      hintsOf({ images: [{ dataUrl: 'data:image/png;base64,AAAA' }], imagesDropped: 0 }).includes('你能直接看到内容')
      && !hintsOf({ images: [{ dataUrl: 'data:image/png;base64,AAAA' }], imagesDropped: 0 }).includes('没有传到你这边'));
    ok('提示：没图也没丢图（纯文字）时两条都不出现',
      !hintsOf({ images: [], imagesDropped: 0 }).includes('【图片】'));
    await brain.reply({
      userId: '10001', userName: 'A', text: '看看这个[图片]', where: 'private:10001',
      images: [], imagesDropped: 1,
    });
    ok('大脑：这一轮没图时，system 里给的是"没收到"而不是"你能看到"', (() => {
      const sys = String(stub.seen.at(-1).body.messages[0].content);
      return sys.includes('没有传到你这边') && !sys.includes('你能直接看到内容');
    })());

    /* ---------- E. 模型不认图时的降级 ---------- */

    const strictSeen = [];
    const strict = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        const body = JSON.parse(raw || '{}');
        strictSeen.push(body);
        const last = body.messages?.at(-1);
        const hasImage = Array.isArray(last?.content) && last.content.some((p) => p.type === 'image_url');
        if (hasImage) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'image input not supported' } }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: '好吧，我看不了图' } }] }));
      });
    });
    const strictPort = await new Promise((r) => strict.listen(0, '127.0.0.1', () => r(strict.address().port)));
    const brain2 = new brainMod.CompanionBrain({
      memory: new CompanionMemory({ dir: path.join(ctx.CONFIG_DIR, 'mem-fallback') }),
      roleText: '测试角色',
      model: { baseUrl: `http://127.0.0.1:${strictPort}`, model: 'text-only', apiKey: '', maxTokens: 64, timeoutMs: 5000 },
    });
    const r2 = await brain2.reply({ userId: '1', userName: 'A', text: '看图', images: [{ dataUrl: 'data:image/png;base64,AAAA' }] });
    ok('降级：模型 400 不认图时会退成纯文字再试一次', strictSeen.length === 2
      && !Array.isArray(strictSeen[1].messages.at(-1).content)
      && r2.text.includes('看不了图'));
    strict.close();

    /* ---------- F. OneBot 收图 / 发图 ---------- */

    const { WebSocketServer } = require(path.join(ctx.app, 'node_modules', 'ws'));
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise((r) => wss.once('listening', r));
    const wsPort = wss.address().port;
    const inbound = [];
    const client = new onebot.OneBotClient({
      wsUrl: `ws://127.0.0.1:${wsPort}`, httpUrl: '', accessToken: '',
      onMessage: (m) => inbound.push(m), onStatus: () => {},
    });
    const connP = new Promise((r) => wss.once('connection', r));
    client.start();
    const sock = await connP;
    sock.send(JSON.stringify({
      post_type: 'message', message_type: 'private', self_id: 999, user_id: 10001,
      time: Math.floor(Date.now() / 1000), sender: { nickname: 'A' },
      message: [
        { type: 'text', data: { text: '看这个' } },
        { type: 'image', data: { url: 'https://gchat.qpic.cn/a.png', file: 'a.image' } },
      ],
    }));
    const msg = await waitFor(() => (inbound.length ? inbound[0] : null));
    ok('收图：OneBot 事件里的图片进了 msg.images', !!msg && msg.images.length === 1
      && msg.images[0].url.includes('gchat.qpic.cn'));
    ok('收图：正文仍然是 [图片] 占位（模型看的是 images）', !!msg
      && msg.text.includes('[图片]') && msg.text.includes('看这个'));
    client.stop();
    wss.close();

    const sent = [];
    const api = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        sent.push({ url: req.url, body: JSON.parse(raw || '{}') });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 1 } }));
      });
    });
    const apiPort = await new Promise((r) => api.listen(0, '127.0.0.1', () => r(api.address().port)));
    const client2 = new onebot.OneBotClient({
      wsUrl: 'ws://127.0.0.1:1', httpUrl: `http://127.0.0.1:${apiPort}`, accessToken: '',
      onMessage: () => {}, onStatus: () => {},
    });
    const sr = await client2.sendImage('private:123', 'base64://AAAA', { summary: '表情' });
    ok('发图：走 send_private_msg + image 段（base64）', sr.ok
      && sent[0].url === '/send_private_msg'
      && sent[0].body.message[0].type === 'image'
      && sent[0].body.message[0].data.file === 'base64://AAAA'
      && sent[0].body.message[0].data.summary === '表情');
    api.close();

    /* ---------- F. 一键清图片缓存（2026-11-01） ---------- */

    /**
     * `data/companion/media` 只增不减（`evictCache` 只管 64MB / 300 张），隐私上用户想"一键清"。
     * 设置页原来只有「清空陪伴记忆」，它清的是人物账和长期记忆，**不清 media**。
     */
    const companion = ctx.mod('companion');
    {
      const dir = path.join(companion.DATA_DIR, 'media');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'a.png'), PNG);
      fs.writeFileSync(path.join(dir, 'b.png'), PNG);
      const before = companion.memorySnapshot();
      const r = companion.forgetMedia();
      ok('清缓存：两张图都清了，目录还在（下次写图自己会用）',
        r.ok && r.removed === 2 && r.bytes === PNG.length * 2 && fs.existsSync(dir) && fs.readdirSync(dir).length === 0);
      ok('清缓存：记忆一点没动（"只删图片缓存，不删记忆"）',
        companion.memorySnapshot().turns === before.turns
        && companion.memorySnapshot().people.length === before.people.length);
      const again = companion.forgetMedia();
      ok('清缓存：空目录再清一次不抛', again.ok && again.removed === 0);

      // 设置页那三个入口都在（照着 13 的写法验页面结构）
      const html = fs.readFileSync(path.join(ctx.app, 'web', 'settings.html'), 'utf8');
      const preload = fs.readFileSync(path.join(ctx.app, 'settings-preload.cjs'), 'utf8');
      const settingsSrc = fs.readFileSync(path.join(ctx.app, 'settings.cjs'), 'utf8');
      ok('清缓存：设置页有「清空图片缓存」按钮，位置在「清空陪伴记忆」旁边',
        html.includes('id="cClearMedia"') && html.includes('清空图片缓存')
        && html.indexOf('id="cClear"') < html.indexOf('id="cClearMedia"'));
      ok('清缓存：preload 暴露了、主进程接了 IPC',
        preload.includes('companionClearMedia') && settingsSrc.includes("'companion:clearMedia'"));
    }
  },
};
