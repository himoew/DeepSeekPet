/**
 * 自检区域：QQ 里发来的语音条（2026-11-02 新增）
 *
 * 这一区**不连真 QQ、不连真方舟**，但把整条线接起来跑一遍：
 *   假 OneBot 网关 push 一条 `record` 段的消息 → `handleInbound` 挂起 → `get_record`（假网关回 mp3）
 *   → 方舟音频理解（假 HTTP 端点回 JSON）→ 转写并进 `msg.text` → 合并窗口 → 模型（harness 的假模型）
 *   → 她真的回一条 QQ 文字。
 *
 * 验的是"接线"而不是"模型听得多准"（那用真接口：`tools\_probe-qq-ear.cjs`）：
 *   · record 段有没有被留下、`get_record` 有没有带 `out_format:'mp3'`；
 *   · 转写出来的原话 + 语气有没有进处境（她会因此接"你声音怎么这样"）；
 *   · 纯文字消息**不许**白调一次语音识别。
 *
 * 单跑：`node test\run-one.cjs 22-voice-qq.cjs`
 */
module.exports = {
  name: 'QQ 语音条（她的耳朵 · 接线）',
  tags: ['companion', 'voice', 'asr', 'qq'],
  async run(ctx) {
    const { ok } = ctx;
    const A = ctx.mod('companion-asr');
    const companion = ctx.mod('companion');
    const path = require('node:path');
    const { WebSocketServer } = require(path.join(ctx.app, 'node_modules', 'ws'));

    const waitFor = async (what, fn, ms = 9000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        if (fn()) return;
        await new Promise((r) => setTimeout(r, 40));
      }
      throw new Error(`等不到：${what}`);
    };

    const stub = await ctx.ensureStub();

    /* ---------- 假方舟：音频理解端点 ---------- */
    const asrBodies = [];
    const asrSrv = ctx.http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        let body = null;
        try { body = JSON.parse(raw); } catch { /* 留 null */ }
        asrBodies.push({ url: req.url, headers: req.headers, body });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          model: 'asr-test',
          choices: [{
            message: {
              content: JSON.stringify({
                text: '今天有点累，想早点睡',
                emotion: '疲惫',
                tone: '压着声音',
                rate: '偏慢',
                volume: '正常',
                background: '无',
                summary: '想早点睡',
                uncertain: [],
              }),
            },
          }],
          usage: { prompt_tokens: 100, completion_tokens: 30 },
        }));
      });
    });
    await new Promise((r) => asrSrv.listen(0, '127.0.0.1', r));
    const asrUrl = `http://127.0.0.1:${asrSrv.address().port}/api/v3/chat/completions`;

    /* ---------- 假 OneBot 网关 ---------- */
    const SHE = '10000';
    const calls = [];
    const socks = new Set();
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise((r) => wss.on('listening', r));
    // 一段"像 mp3"的假音频：只要 `sniffAudioFormat` 认成 mp3、base64 能解出来就够
    const fakeAudio = Buffer.from('ID3\u0003\u0000\u0000\u0000\u0000\u0000\u0000FAKEMP3', 'latin1');
    wss.on('connection', (sock) => {
      socks.add(sock);
      sock.on('close', () => socks.delete(sock));
      sock.on('message', (raw) => {
        let req = null;
        try { req = JSON.parse(String(raw)); } catch { return; }
        const rec = { action: req.action, params: req.params || {}, at: Date.now() };
        calls.push(rec);
        const reply = (data) => {
          try { sock.send(JSON.stringify({ status: 'ok', retcode: 0, data, echo: req.echo })); } catch { /* 断了 */ }
        };
        if (req.action === 'get_record') {
          reply({ file: 'C:\\fake\\record.mp3', url: 'C:\\fake\\record.mp3', base64: fakeAudio.toString('base64') });
          return;
        }
        reply({ message_id: 'sent-1' });
      });
    });
    const gwUrl = `ws://127.0.0.1:${wss.address().port}`;
    const push = (ev) => { for (const s of socks) { try { s.send(JSON.stringify(ev)); } catch { /* 断了 */ } } };

    A.save({
      enabled: true,
      ark: { endpoint: asrUrl, apiKey: 'test-ark', model: 'asr-test', thinking: false },
      reply: { voice: 'free' },        // 她自己决定回文字还是语音；这一区把 TTS 关了，所以只会回文字
      qq: { maxRecords: 2, maxBytes: 12 * 1024 * 1024 },
    });

    companion.save({
      enabled: true,
      adapter: 'builtin',
      onebot: { wsUrl: gwUrl, httpUrl: '' },
      model: { baseUrl: stub.url, model: 'test-model', apiKey: 'test-key' },
      humanize: { enabled: false },
      // 她的声音关掉：这一区只验"听得懂"，不验"说得出"（TTS 有自己那一区）
      voice: { enabled: false },
      names: ['大肥鱼'],
      ownerIds: ['7'],
      // 合并窗口压到 120ms，别为"等人说完"白等 1.5 秒
      wake: { privateWindowMs: 120, groupWindowMs: 120 },
    });

    await waitFor('陪伴模式连上假网关', () => companion.prefs().connected, 6000);

    /* ---------- ① 一条语音 ---------- */
    push({
      post_type: 'message', time: Math.floor(Date.now() / 1000), self_id: Number(SHE),
      message_type: 'private', user_id: '7', message_id: 'v-1',
      sender: { nickname: '他' },
      message: [{ type: 'record', data: { file: 'record-token-1', url: '', file_size: 5000 } }],
    });

    await waitFor('她回了那条语音', () => calls.some((c) => c.action === 'send_private_msg'), 12000);

    const getRec = calls.find((c) => c.action === 'get_record');
    ok('QQ 语音条：先向网关要音频，而且明确要 mp3（silk/amr 由网关转）',
      !!getRec && getRec.params.out_format === 'mp3' && getRec.params.file === 'record-token-1');
    ok('QQ 语音条：转写请求打到了方舟（input_audio + 提示词）',
      asrBodies.length === 1
      && asrBodies[0].body.messages[0].content[0].type === 'input_audio'
      && asrBodies[0].body.messages[0].content[0].input_audio.format === 'mp3'
      && asrBodies[0].body.messages[0].content[1].type === 'text'
      && asrBodies[0].body.thinking?.type === 'disabled'
      && asrBodies[0].body.model === 'asr-test');
    ok('QQ 语音条：用的是配置里的方舟 Key（Bearer）',
      /^Bearer test-ark$/.test(String(asrBodies[0]?.headers?.authorization || '')));

    const asked = stub.seen.at(-1);
    const userMsg = String(asked?.body?.messages?.at(-1)?.content || '');
    /** 处境（situation）是拼进 **system** 的，不是 user 那条（见 `companion-brain.reply` 第 249 行）。 */
    const sysMsg = String(asked?.body?.messages?.[0]?.content || '');
    ok('QQ 语音条：转写出来的原话进了给模型的那条消息', userMsg.includes('今天有点累'));
    ok('QQ 语音条：语气/情绪也进了处境（她会接"你声音怎么这样"）',
      sysMsg.includes('疲惫') && sysMsg.includes('压着声音'));
    ok('QQ 语音条：处境里写明"他是用语音说的"', /用语音/.test(sysMsg));
    ok('QQ 语音条：默认不替她决定回文字还是语音（处境里写了"也可以打字"）',
      /也可以打字/.test(sysMsg));
    const sent = calls.find((c) => c.action === 'send_private_msg');
    ok('QQ 语音条：她真的回了一条 QQ 消息', !!sent && Array.isArray(sent.params.message)
      && sent.params.message.length > 0);

    /* ---------- ② 纯文字不许调语音识别 ---------- */
    const before = asrBodies.length;
    const beforeCalls = calls.length;
    push({
      post_type: 'message', time: Math.floor(Date.now() / 1000), self_id: Number(SHE),
      message_type: 'private', user_id: '7', message_id: 'v-2',
      sender: { nickname: '他' },
      message: [{ type: 'text', data: { text: '在吗' } }],
    });
    await waitFor('她回了纯文字那条', () => calls.slice(beforeCalls).some((c) => c.action === 'send_private_msg'), 12000);
    ok('QQ 语音条：纯文字消息不会白调一次语音识别', asrBodies.length === before);
    ok('QQ 语音条：纯文字那条也不会去 get_record',
      !calls.slice(beforeCalls).some((c) => c.action === 'get_record'));

    // 收尾：断开，别让后面的区域连着一个假网关
    companion.save({ enabled: false });
    for (const s of socks) { try { s.close(); } catch { /* 已关 */ } }
    await new Promise((r) => wss.close(r));
    await new Promise((r) => asrSrv.close(r));
  },
};
