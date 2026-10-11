/**
 * 自检区域：配置损坏守卫
 * 从原 `test\smoke.cjs` 切出来的，**代码一字未改**（只把裸模块名换成 `ctx.*`）。
 * 单跑：`node test\smoke.cjs settings`
 */
module.exports = {
  name: "配置损坏守卫",
  tags: ['settings', '配置'],
  async run(ctx) {
    /** 区域文件里保持原样的模块名：从 ctx 上解构出来（属性名 'pet:' 之类因此不受影响）。 */
    const { __mark, FILES, fs, path, pathToFileURL, http, pet, lines, llm, store, checkLines, pageAreas, pageStages, pageGrabParts,
      textsOf, textsFilled, base, port, WebSocket, ok } = ctx;
    /* ---------- 3b. 配置损坏不能把用户的东西静默顶掉（2026-10-08 的守卫） ---------- */
    // 这条守的是一个真事故：读配置失败 → 退回默认值 → 紧接着一次保存就把用户的 Key/人设
    // 覆盖掉（HANDOVER 第 8 节 18）。现在的规矩是：坏文件先留一份，再写新的；而且写入是原子的。
    {
      const keep = llm.load();
      fs.writeFileSync(llm.CONFIG_FILE, '{"apiKey":"SECRET","person');     // 写一半崩掉的样子
      ok('配置坏了会退回默认值（不抛）', llm.load().apiKey === '');
      llm.save({ model: 'after-broken' });
      const bads = fs.readdirSync(ctx.CONFIG_DIR).filter((f) => f.startsWith('settings.json.bad-')).sort();
      ok('坏掉的配置会先留一份（settings.json.bad-*）', bads.length >= 1);
      ok('留档里用户的数据还在', bads.length > 0 && fs.readFileSync(path.join(ctx.CONFIG_DIR, bads.at(-1)), 'utf8').includes('SECRET'));
      ok('坏文件之后还能正常保存', llm.load().model === 'after-broken');
      ok('原子写没有留下 .tmp', !fs.existsSync(`${llm.CONFIG_FILE}.tmp`));
      llm.save(keep);
      ok('store.readJson 读不到就给 null', store.readJson(path.join(ctx.CONFIG_DIR, 'nope.json')) === null);
      ok('store.writeJson 失败返回 Error（不抛）', store.writeJson(path.join(llm.CONFIG_FILE, 'x.json'), { a: 1 }) instanceof Error);
    }
  },
};
