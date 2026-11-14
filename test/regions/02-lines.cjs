/**
 * 自检区域：台词库
 * 从原 `test\smoke.cjs` 切出来的，**代码一字未改**（只把裸模块名换成 `ctx.*`）。
 * 单跑：`node test\smoke.cjs lines`
 */
module.exports = {
  name: "台词库",
  tags: ['lines', '台词'],
  async run(ctx) {
    /** 区域文件里保持原样的模块名：从 ctx 上解构出来（属性名 'pet:' 之类因此不受影响）。 */
    const { __mark, FILES, fs, path, pathToFileURL, http, pet, lines, llm, store, checkLines, pageAreas, pageStages, pageGrabParts,
      textsOf, textsFilled, base, port, WebSocket, ok } = ctx;
    /* ---------- 2. 台词库 ---------- */
    const problems = [];
    const count = { n: 0 };
    checkLines(lines, 'lines', problems, count);
    ok(`台词库 ${count.n} 条全部合法（文字非空、动作名都认识）`, problems.length === 0);
    if (problems.length) console.log('      ' + problems.join('\n      '));

    ok('四个时段都有问候语', ['morning', 'afternoon', 'evening', 'night'].every((k) => lines.hello[k]?.length));
    ok('戳的三个档位都齐', lines.poke.first.length && lines.poke.again.length && lines.poke.tooMuch.length);
    ok('每个事件都有台词', ['grab', 'pet', 'petAsleep', 'drop', 'throw', 'crash', 'pokeAsleep',
      'drowsy', 'wakeUp', 'idle', 'reply', 'llmFailed', 'hush', 'back'].every((k) => Array.isArray(lines[k]) && lines[k].length));

    // 摸久了/半夜/回来招呼这些新桶
    ok('回来招呼 / 电池 / 半夜被戳醒 都有台词',
      lines.youBack?.length > 0 && lines.battery?.length > 0 && lines.pokeAsleepNight?.length > 0);
    ok('按时段的发呆话和犯困话四个时段都齐',
      ['morning', 'afternoon', 'evening', 'night'].every((k) => lines.idleByTime?.[k]?.length && lines.drowsyByTime?.[k]?.length));
    // 「叫你的名字」这条线：台词里有 {name}、设置页有这个输入框、配置里有默认值
    ok('台词里准备了 {name} 占位符',
      JSON.stringify(lines).includes('{name}'));
    ok('设置页有「你的名字」输入框',
      ctx.fs.readFileSync(path.join(ctx.app, 'web', 'settings.html'), 'utf8').includes('id="user"'));
    ok('配置默认值里有 user', llm.defaults().user === '你');
  },
};
