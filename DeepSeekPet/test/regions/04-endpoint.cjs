/**
 * 自检区域：假端点跑模型
 * 从原 `test\smoke.cjs` 切出来的，**代码一字未改**（只把裸模块名换成 `ctx.*`）。
 * 单跑：`node test\smoke.cjs llm`
 */
module.exports = {
  name: "假端点跑模型",
  tags: ['llm', '模型'],
  async run(ctx) {
    const { __mark, FILES, fs, path, pathToFileURL, http, pet, lines, llm, store, checkLines, pageAreas, pageStages, pageGrabParts,
      textsOf, textsFilled, base, port, WebSocket, ok } = ctx;
    /** 假模型端点：这一区自己起一个（单跑时没有别人替你起）。 */
    const stub = await ctx.ensureStub();
    /* ---------- 4. 拿假端点跑一遍模型调用 ---------- */
    llm.save({ enabled: true, baseUrl: stub.url, apiKey: 'test-key', model: 'test-model', maxTokens: 64, persona: '你是测试用的人设。' });
    ok('填好之后 isOn 为真', llm.isOn());

    const probed = await llm.probe(llm.load());
    ok(`测试连接通了（${probed.ms}ms）`, probed.ok === true);
    ok('测试连接会带上人设（不然看到的是模型的原始语气）',
      stub.seen.at(-1).body.messages?.[0]?.role === 'system'
      && stub.seen.at(-1).body.messages[0].content.includes('测试用的人设'));

    const answer = await llm.chat([], '在吗');
    ok('chat 拿到回复', answer === '收到啦,我是测试模型。');
    const req = stub.seen.at(-1);
    ok('请求带上了 Authorization', req.headers.authorization === 'Bearer test-key');
    ok('请求带上了模型名', req.body.model === 'test-model');
    ok('请求把人设放在 system', req.body.messages[0].role === 'system' && req.body.messages[0].content.includes('测试用的人设'));
    ok('请求带上了 max_tokens', req.body.max_tokens === 64);
    ok('请求路径是 /chat/completions', req.url === '/chat/completions');
    ok('普通提问不带 temperature（用端点自己的默认值）', req.body.temperature === undefined);

    const bad = await llm.probe({ ...llm.load(), model: 'fail-me' });
    ok('Key 不对时说得是人话', bad.ok === false && bad.message.includes('API Key'));
  },
};
