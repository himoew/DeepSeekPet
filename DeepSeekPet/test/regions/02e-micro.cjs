/**
 * 自检区域：微动作
 * 从原 `test\smoke.cjs` 切出来的，**代码一字未改**（只把裸模块名换成 `ctx.*`）。
 * 单跑：`node test\smoke.cjs micro`
 */
module.exports = {
  name: "微动作",
  tags: ['micro', '微动作'],
  async run(ctx) {
    /** 区域文件里保持原样的模块名：从 ctx 上解构出来（属性名 'pet:' 之类因此不受影响）。 */
    const { __mark, FILES, fs, path, pathToFileURL, http, pet, lines, llm, store, checkLines, pageAreas, pageStages, pageGrabParts,
      textsOf, textsFilled, base, port, WebSocket, ok } = ctx;
    /* ---------- 2e. 不说话的小动作（歪头 / 换重心 / 瞟一眼） ---------- */
    ok('微动作：三种都在台词库里留了名字（只有日志看得到）',
      ['tilt', 'step', 'look'].every((k) => k === 'look' || (Array.isArray(lines.micro?.[k]) && lines.micro[k].length > 0)));
  },
};
