/**
 * 自检区域：模型冷热分离
 * 从原 `test\smoke.cjs` 切出来的，**代码一字未改**（只把裸模块名换成 `ctx.*`）。
 * 单跑：`node test\smoke.cjs llm`
 */
module.exports = {
  name: "模型冷热分离",
  tags: ['llm', '模型'],
  async run(ctx) {
    const { __mark, FILES, fs, path, pathToFileURL, http, pet, lines, llm, store, checkLines, pageAreas, pageStages, pageGrabParts,
      textsOf, textsFilled, base, port, WebSocket, ok } = ctx;
    /** 假模型端点：这一区自己起一个。 */
    const stub = await ctx.ensureStub();
    /* ---------- 4b. 本地模型的两个优化：常驻与冷/热分开报 ---------- */
    ok('认出本地端点（127.0.0.1）', llm.isLocal({ preset: 'custom', baseUrl: 'http://127.0.0.1:8080/v1' }));
    ok('认出本地端点（localhost）', llm.isLocal({ preset: 'custom', baseUrl: 'http://localhost:11434/v1' }));
    ok('认出 ollama 预设（哪怕在别的机器上）', llm.isLocal({ preset: 'ollama', baseUrl: 'http://10.0.0.9:11434/v1' }));
    ok('云端不算本地', !llm.isLocal({ preset: 'deepseek', baseUrl: 'https://api.deepseek.com' }));

    llm.save({ enabled: true, preset: 'ollama', baseUrl: stub.url, model: 'test-model', keepAlive: '8h' });
    stub.seen.length = 0;
    await llm.chat([], '在吗');
    ok('本地端点会带上 keep_alive', stub.seen.at(-1).body.keep_alive === '8h');

    llm.save({ keepAlive: '' });
    stub.seen.length = 0;
    await llm.chat([], '在吗');
    ok('keepAlive 留空就不发这个字段', stub.seen.at(-1).body.keep_alive === undefined);

    llm.save({ keepAlive: '8h' });
    const warmed = await llm.warm();
    ok(`预热会真的先问一句（${warmed}ms）`, typeof warmed === 'number' && warmed >= 0);

    const slow = await llm.probe({ ...llm.load(), model: 'slow-model' });
    ok('第一次慢的话会再测一次，并分开报冷/热',
      slow.ok === true && /第一次.*第二次/s.test(slow.message));

    llm.save({ enabled: false });
  },
};
