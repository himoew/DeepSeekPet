/**
 * 自检区域：桌宠 / QQ 两套模型（2026-10-27 新增）
 *
 * 用户要的是"api 分两种，一个桌宠一个 qq"：0 挡只打桌宠那套，1/2 挡只打 QQ 那套，
 * 而且 QQ 选「单独配一套」时不再偷偷从桌宠借地址/Key。
 *
 * 这里用两个假端点 A/B：
 *   · A = 桌宠（`settings.json`）
 *   · B = QQ（`companion.json` 的 `model`）
 * 断言 0 挡打 A、1 挡打 B；再验 same/custom 的迁移、QQ 模型探测不写记忆、设置页有这两张卡。
 *
 * 单跑：`node test\run-one.cjs 13-model-split.cjs`
 */
module.exports = {
  name: '模型分工（桌宠 / QQ）',
  tags: ['companion', 'model', '模型', 'settings', 'model-split'],
  async run(ctx) {
    const { ok, fs, path, http, llm } = ctx;
    const companion = ctx.mod('companion');
    const brain = ctx.mod('companion-brain');
    const { resolveModel, whyNotReady, hasModelFields } = brain;

    const startStub = (label) => new Promise((resolve) => {
      const seen = [];
      const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => {
          let body = null;
          try { body = JSON.parse(raw); } catch { /* 留 null */ }
          seen.push(body);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ choices: [{ message: { content: `${label}-回复` } }] }));
        });
      });
      server.listen(0, '127.0.0.1', () => resolve({
        server, seen, url: `http://127.0.0.1:${server.address().port}`,
      }));
    });

    const A = await startStub('A');
    const B = await startStub('B');
    try {
      /* ---------- A. 纯解析：same / custom / 老配置 ---------- */

      llm.save({
        enabled: true, preset: 'custom', baseUrl: A.url, apiKey: 'key-a',
        model: 'desk-a', maxTokens: 64, timeoutMs: 30000, keepAlive: '',
      });

      const same = resolveModel({ mode: 'same' });
      ok('same：地址/Key/模型都跟桌宠', same.mode === 'same' && same.baseUrl === A.url
        && same.apiKey === 'key-a' && same.model === 'desk-a');
      ok('same：QQ 的 token 下限仍是 192（不会被桌面的 64 截断）', same.maxTokens === 192);

      const custom = resolveModel({
        mode: 'custom', baseUrl: B.url, apiKey: '', model: 'qq-b', maxTokens: 0, timeoutMs: 0,
      });
      ok('custom：QQ 用自己那一套，不再借桌宠地址/Key/模型',
        custom.mode === 'custom' && custom.baseUrl === B.url && custom.model === 'qq-b'
        && custom.apiKey === '');
      ok('custom：没填 maxTokens/timeout 时有 QQ 自己的默认值（512 / 45s）',
        custom.maxTokens === 512 && custom.timeoutMs === 45000);
      // 上面的 B 是 127.0.0.1，按设计本地端点可以不要 Key；这里换一个在线地址才考得到"缺 Key"。
      const remote = resolveModel({ mode: 'custom', baseUrl: 'https://api.example.com', model: 'qq-b', apiKey: '' });
      ok('custom：在线端点缺 Key 时说得清楚（不会静默借用桌宠的 Key）',
        whyNotReady(remote) === '没填 API Key');

      const legacy = resolveModel({ baseUrl: B.url });
      ok('老配置：没有 mode 但填过字段 → 按 custom，且保留老的空字段回退',
        legacy.mode === 'custom' && legacy.legacy === true
        && legacy.baseUrl === B.url && legacy.model === 'desk-a' && legacy.apiKey === 'key-a');

      ok('老配置识别：全空就是 same，填过任意一个字段就是 custom',
        !hasModelFields({}) && hasModelFields({ model: 'x' }) && !hasModelFields({ maxTokens: 0 }));

      /* ---------- B. 保存 / 迁移：mode 落盘，切回 same 不吞 custom 字段 ---------- */

      companion.save({
        enabled: false,
        model: {
          mode: 'custom', baseUrl: B.url, apiKey: 'key-b', model: 'qq-b',
          maxTokens: 320, timeoutMs: 12000, keepAlive: '',
        },
      });
      const saved = companion.reload();
      ok('保存：companion.model.mode 落盘', saved.model.mode === 'custom');
      ok('保存：publicState 报实际生效的 QQ 模型',
        companion.publicState().model.mode === 'custom'
        && companion.publicState().model.model === 'qq-b'
        && companion.publicState().model.baseUrl === B.url);

      companion.save({ model: { mode: 'same' } });
      const afterSame = companion.reload();
      ok('切回 same：QQ 实际用桌宠模型', companion.publicState().model.mode === 'same'
        && companion.publicState().model.model === 'desk-a');
      ok('切回 same：以前填的 custom 字段还在（下次切回不用重填）',
        afterSame.model.baseUrl === B.url && afterSame.model.model === 'qq-b'
        && afterSame.model.apiKey === 'key-b');
      ok('切回 same：publicState 的 token 下限仍是 192',
        companion.publicState().model.maxTokens === 192);

      /* ---------- C. 测试 QQ 模型：能测未保存的值，不写记忆 ---------- */

      const turnsBefore = companion.memorySnapshot().turns;
      const probeSame = await companion.probeModel({ mode: 'same' });
      ok('测试 QQ 模型：跟桌宠相同时打的是 A', probeSame.ok && A.seen.at(-1)?.model === 'desk-a');
      const probeCustom = await companion.probeModel({
        mode: 'custom', baseUrl: B.url, apiKey: 'key-b', model: 'qq-b', maxTokens: 192, timeoutMs: 5000,
      });
      ok('测试 QQ 模型：单独配置时打的是 B（用的是表单里还没保存的值）',
        probeCustom.ok && B.seen.at(-1)?.model === 'qq-b');
      const badKey = await companion.probeModel({
        mode: 'custom', baseUrl: 'https://api.example.com', apiKey: '', model: 'qq-b', maxTokens: 192,
      });
      ok('测试 QQ 模型：在线端点缺 Key 时直接说缺什么，不发请求',
        !badKey.ok && /Key/.test(badKey.message) && B.seen.at(-1)?.model === 'qq-b');
      ok('测试 QQ 模型：不写人物账 / 对话流', companion.memorySnapshot().turns === turnsBefore);

      /* ---------- C2. 模型遥测：最近 10 次调用（2026-11-01） ---------- */

      /**
       * 以前 `callModel` 只回 `{text, ms}`，而 `ms` 只在探测里用得上 ——
       * 用户想知道"刚才那句为什么慢 / 花了多少 token"只能翻日志。
       * 现在有一个环形缓冲（10 条），`publicState().calls` 给设置页列表格。
       */
      const brainMod = ctx.mod('companion-brain');
      const probeModel = brainMod.resolveModel({
        mode: 'custom', baseUrl: A.url, apiKey: 'key-a', model: 'desk-a', maxTokens: 64, timeoutMs: 5000,
      });
      brainMod.clearCalls();
      ok('遥测：清空之后是空的', companion.publicState().calls.length === 0);
      await brainMod.callModel(probeModel, [{ role: 'user', content: '记一下这句' }]);
      await brainMod.callModel(probeModel, [{ role: 'user', content: '再记一下这句' }]);
      const calls = companion.publicState().calls;
      ok('遥测：打完两次就记两条', calls.length === 2);
      ok('遥测：字段齐（时刻 / 模型 / 耗时 / token / 截断）',
        calls.every((c) => Number(c.at) > 0 && !!c.model && Number(c.ms) >= 0
          && 'promptTokens' in c && 'completionTokens' in c && typeof c.truncated === 'boolean'));
      ok('遥测：记的是这次真的打了的模型', calls.every((c) => c.model === 'desk-a'));
      for (let i = 0; i < brainMod.TELEMETRY_MAX + 3; i += 1) {
        await brainMod.callModel(probeModel, [{ role: 'user', content: `第 ${i} 句` }]);
      }
      ok(`遥测：只留最近 ${brainMod.TELEMETRY_MAX} 条（环形缓冲，不涨）`,
        companion.publicState().calls.length === brainMod.TELEMETRY_MAX);
      brainMod.clearCalls();

      /* ---------- C3. ★ 2026-11-03：503 自动重试（"两条路一起瞎"那次） ---------- */

      /**
       * 真事：2026-11-03 18:27–18:28 DeepSeek 连回四次
       * `HTTP 503 Service is too busy`，桌宠麦克风和 QQ 同时哑了（一次都不重试）。
       * 现在暂时性状态码会按 0.7s → 1.8s → 4s 退避重试；401/403/404 立刻失败。
       * 自检里把等待压到 5ms，别真坐等 6.5 秒。
       */
      let ladderHits = 0;
      const ladder = [];
      const ladderServer = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => {
          ladder.push(raw);
          ladderHits += 1;
          if (ladderHits <= 3) {
            res.writeHead(503, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'Service is too busy. We advise users to temporarily switch LLM.' } }));
            return;
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ choices: [{ message: { content: '重试之后接上了' } }] }));
        });
      });
      const ladderPort = await new Promise((r) => ladderServer.listen(0, '127.0.0.1', () => r(ladderServer.address().port)));

      let deniedHits = 0;
      const deniedServer = http.createServer((req, res) => {
        req.on('data', () => {});
        req.on('end', () => {
          deniedHits += 1;
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'invalid api key' } }));
        });
      });
      const deniedPort = await new Promise((r) => deniedServer.listen(0, '127.0.0.1', () => r(deniedServer.address().port)));

      const keepWaits = llm.RETRY_WAITS.slice();
      llm.RETRY_WAITS.splice(0, llm.RETRY_WAITS.length, 5, 5, 5);
      try {
        const flaky = brainMod.resolveModel({
          mode: 'custom', baseUrl: `http://127.0.0.1:${ladderPort}`, apiKey: 'k', model: 'flaky',
          maxTokens: 32, timeoutMs: 5000,
        });
        const out = await brainMod.callModel(flaky, [{ role: 'user', content: '在吗' }]);
        ok('503 自动重试：连吃三次 503 后第四次成功（这句话不会丢）',
          out.text === '重试之后接上了' && ladderHits === 4);
        ok('503 自动重试：四次发的都是同一份请求体（不是空转）',
          ladder.length === 4 && ladder.every((b) => JSON.parse(b).messages[0].content === '在吗'));

        const bad = brainMod.resolveModel({
          mode: 'custom', baseUrl: `http://127.0.0.1:${deniedPort}`, apiKey: 'bad', model: 'bad',
          maxTokens: 32, timeoutMs: 5000,
        });
        let deniedErr = null;
        try { await brainMod.callModel(bad, [{ role: 'user', content: '在吗' }]); } catch (e) { deniedErr = e; }
        ok('401 不重试：Key 不对时立刻失败，而且标了 retryable=false',
          !!deniedErr && /401/.test(deniedErr.message) && deniedHits === 1 && deniedErr.retryable === false);
      } finally {
        llm.RETRY_WAITS.splice(0, llm.RETRY_WAITS.length, ...keepWaits);
        ladderServer.close();
        deniedServer.close();
      }

      /* ---------- D. 真连一遍：0 挡打 A，1 挡打 B ---------- */

      await ctx.live.ensure();
      await drain();

      const eventFile = path.join(ctx.CONFIG_DIR, 'model-split-events.jsonl');
      fs.writeFileSync(eventFile, '', 'utf8');
      llm.save({
        enabled: true, preset: 'custom', baseUrl: A.url, apiKey: 'key-a',
        model: 'desk-a', maxTokens: 64, timeoutMs: 5000,
        persona: '你是桌宠测试人设。',
      });
      companion.save({
        enabled: true,
        adapter: 'kit-jsonl',
        kitEventsPath: eventFile,
        model: {
          mode: 'custom', baseUrl: B.url, apiKey: 'key-b', model: 'qq-b',
          maxTokens: 192, timeoutMs: 5000, keepAlive: '',
        },
        humanize: { enabled: false },
        ownerIds: ['owner'],
      });

      companion.setMode(0);
      ok('0 挡：陪伴模式不在通讯挡（桌宠大脑）', companion.isActive() === false);
      const aBefore = A.seen.length;
      const bBefore = B.seen.length;
      fromPet.length = 0;
      ws.send(JSON.stringify({ t: 'text', text: '桌宠那一套在吗' }));
      const answerA = await nextReply('answer', 9000);
      ok('0 挡：气泡来自桌宠模型 A', answerA.beats[0].text.includes('A-回复'));
      ok('0 挡：请求只打 A，没打 B',
        A.seen.length === aBefore + 1 && B.seen.length === bBefore
        && A.seen.at(-1)?.model === 'desk-a');

      companion.setMode(1);
      ok('1 挡：切到 QQ 拟人聊天', companion.isActive() === true);
      const aBeforeQq = A.seen.length;
      const bBeforeQq = B.seen.length;
      fromPet.length = 0;
      ws.send(JSON.stringify({ t: 'text', text: 'QQ 那一套在吗' }));
      const answerB = await nextReply('answer', 9000);
      ok('1 挡：气泡来自 QQ 模型 B', answerB.beats[0].text.includes('B-回复'));
      ok('1 挡：请求只打 B，没打 A',
        B.seen.length === bBeforeQq + 1 && A.seen.length === aBeforeQq
        && B.seen.at(-1)?.model === 'qq-b');

      companion.save({ enabled: false });

      /* ---------- E. 设置页：两张卡都在，字段不混 ---------- */

      const html = fs.readFileSync(path.join(ctx.app, 'web', 'settings.html'), 'utf8');
      ok('设置页：有独立的「桌宠模型」和「QQ 模型」两张卡',
        html.includes('id="llmCard"') && html.includes('id="qqModelCard"')
        && html.includes('桌宠模型') && html.includes('QQ 模型'));
      ok('设置页：QQ 有 same/custom 两个模式',
        html.includes('id="qqSame"') && html.includes('id="qqCustom"')
        && html.includes('跟桌宠用同一个') && html.includes('单独配一套'));
      ok('设置页：QQ 有自己的一套接口字段和测试/保存按钮',
        ['qBaseUrl', 'qApiKey', 'qModel', 'qMaxTokens', 'qTest', 'qSave']
          .every((id) => html.includes(`id="${id}"`)));
      ok('设置页：汇总条写清「0 挡桌宠 / 1/2 挡 QQ」',
        html.includes('id="modelSummary"') && html.includes('0 挡用桌宠'));
      ok('本机模型挑选：优先 qwen2.5',
        llm.pickLocalModel(['llama3:8b', 'qwen2.5:3b-instruct', 'qwen2.5:7b']) === 'qwen2.5:3b-instruct');
    } finally {
      A.server.close();
      B.server.close();
    }
  },
};
