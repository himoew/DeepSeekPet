/**
 * 自检区域：记忆
 * 从原 `test\smoke.cjs` 切出来的，**代码一字未改**（只把裸模块名换成 `ctx.*`）。
 * 单跑：`node test\smoke.cjs memory`
 */
module.exports = {
  name: "记忆",
  tags: ['memory', '记忆'],
  async run(ctx) {
    /** 区域文件里保持原样的模块名：从 ctx 上解构出来（属性名 'pet:' 之类因此不受影响）。 */
    const { __mark, FILES, fs, path, pathToFileURL, http, pet, lines, llm, store, checkLines, pageAreas, pageStages, pageGrabParts,
      textsOf, textsFilled, base, port, WebSocket, ok } = ctx;
    /* ---------- 2b. 它的记忆（纯 Node 就能测） ---------- */
    const memory = ctx.mod('memory');
    const m0 = memory.touchSeen();
    ok('记忆：第一次见面就记下日期', /^\d{4}-\d{2}-\d{2}$/.test(m0.first) && m0.days >= 1);
    ok('记忆文件落在 DSP_LOG_DIR 里（不碰用户真实记忆）', memory.FILE.startsWith(ctx.CONFIG_DIR));
    ok('记忆：今天能说"记忆话"的额度是有限的', memory.canSayMemory() === true && memory.SAY_PER_DAY >= 1);
    memory.addTouch('pet', 'head');
    memory.addTouch('poke', 'head');
    memory.addTalk('今天有点累');
    memory.addPick(true);
    const m1 = memory.snapshot();
    ok('记忆：各项互动分开记数', m1.touch.pet === 1 && m1.touch.poke === 1 && m1.touch.grab === 0);
    ok('记忆：说过的话被记下来了', m1.talks === 1 && m1.words === '今天有点累');
    ok('记忆：选择卡的选择也记', m1.quiet === 1);
    for (let i = 0; i < 5; i += 1) memory.addTouch('pet', 'head');
    ok('记忆：摸够 5 次才敢说"你最喜欢摸头"', memory.snapshot().areaTop === 'head');
    memory.markSaid(); memory.markSaid();
    ok('记忆：说满额度当天就不再说了', memory.canSayMemory() === false);
    const mF = memory.forget();
    ok('记忆：清空之后从今天重新认识', mF.days === 1 && mF.talks === 0 && mF.touch.pet === 0);
    ok('记忆：认识第几天的台词都在', ['memoryMilestone', 'memoryAway', 'memoryWords', 'memoryArea', 'memoryHour']
      .every((k) => Array.isArray(lines[k]) && lines[k].length));
  },
};
