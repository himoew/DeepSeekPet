/**
 * 自检区域：设置与模型客户端
 * 从原 `test\smoke.cjs` 切出来的，**代码一字未改**（只把裸模块名换成 `ctx.*`）。
 * 单跑：`node test\smoke.cjs settings`
 */
module.exports = {
  name: "设置与模型客户端",
  tags: ['settings', '设置'],
  async run(ctx) {
    /** 区域文件里保持原样的模块名：从 ctx 上解构出来（属性名 'pet:' 之类因此不受影响）。 */
    const { __mark, FILES, fs, path, pathToFileURL, http, pet, lines, llm, store, checkLines, pageAreas, pageStages, pageGrabParts,
      textsOf, textsFilled, base, port, WebSocket, ok } = ctx;
    /* ---------- 3. 设置与模型客户端（不发真请求） ---------- */
    ok('默认没开模型', llm.defaults().enabled === false);
    ok('预设里有 DeepSeek 和 Ollama', llm.PRESETS.some((p) => p.id === 'deepseek') && llm.PRESETS.some((p) => p.id === 'ollama'));
    ok('endpoint 会补 /chat/completions', llm.endpoint('https://api.deepseek.com') === 'https://api.deepseek.com/chat/completions');
    ok('endpoint 不会重复补', llm.endpoint('http://x/v1/chat/completions') === 'http://x/v1/chat/completions');
    ok('endpoint 容忍尾部斜杠', llm.endpoint('http://x/v1/') === 'http://x/v1/chat/completions');
    ok('没填地址会报错', (() => { try { llm.endpoint(''); return false; } catch { return true; } })());

    llm.save({ model: 'round-trip' });
    ok('配置能存能读', llm.load().model === 'round-trip');
    ok('存局部字段不会丢别的', llm.load().persona.length > 20 && llm.load().baseUrl.length > 0);
    ok('配置写在临时目录里', llm.CONFIG_FILE.startsWith(ctx.CONFIG_DIR));
  },
};
