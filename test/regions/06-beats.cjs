/**
 * 自检区域：切句与表情
 * 从原 `test\smoke.cjs` 切出来的，**代码一字未改**（只把裸模块名换成 `ctx.*`）。
 * 单跑：`node test\smoke.cjs beats`
 */
module.exports = {
  name: "切句与表情",
  tags: ['beats', '切句'],
  async run(ctx) {
    /** 区域文件里保持原样的模块名：从 ctx 上解构出来（属性名 'pet:' 之类因此不受影响）。 */
    const { __mark, FILES, fs, path, pathToFileURL, http, pet, lines, llm, store, checkLines, pageAreas, pageStages, pageGrabParts,
      textsOf, textsFilled, base, port, WebSocket, ok } = ctx;
    /* ---------- 6. 切句与表情的纯函数 ---------- */
    ok('长回复被切成最多 3 个气泡', pet.beatsFor('一。二。三。四。五。').length === 3);
    ok('切句时最多留三段（多的并进第三段）',
      pet.beatsFor('一。二。三。四。五。').map((b) => b.text).join('') === '一。二。三。四。五。');
    ok('单句就一个气泡', pet.beatsFor('只有一句话。').length === 1);
    ok('第一句带表情、后面不带', (() => {
      const b = pet.beatsFor('一。二。');
      return (b[0].actions || []).length === 1 && b[1].actions === undefined;
    })());
    ok('空回复不产生气泡', pet.beatsFor('   ') === null);
    ok('问句配思考表情', pet.moodOf('这样吗?') === 'thinking');
    ok('感叹配开心', pet.moodOf('太好了!') === 'happy');
    ok('道歉配害羞', pet.moodOf('抱歉,我不行。') === 'shy');
  },
};
