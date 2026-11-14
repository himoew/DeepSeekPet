/**
 * 自检区域：页面资源
 * 从原 `test\smoke.cjs` 切出来的，**代码一字未改**（只把裸模块名换成 `ctx.*`）。
 * 单跑：`node test\smoke.cjs pages`
 */
module.exports = {
  name: "页面资源",
  tags: ['pages', '页面', '资源'],
  async run(ctx) {
    /** 区域文件里保持原样的模块名：从 ctx 上解构出来（属性名 'pet:' 之类因此不受影响）。 */
    const { __mark, FILES, fs, path, pathToFileURL, http, pet, lines, llm, store, checkLines, pageAreas, pageStages, pageGrabParts,
      textsOf, textsFilled, base, port, WebSocket, ok } = ctx;
    /* ---------- 1. 页面要的东西都在 ---------- */
    for (const [route, type] of FILES) {
      const res = await fetch(base + route);
      const body = await res.arrayBuffer();
      ok(`${route} -> ${res.status} ${res.headers.get('content-type')}`, res.status === 200 && body.byteLength > 0);
      ok(`${route} 类型正确`, (res.headers.get('content-type') || '').includes(type));
    }

    const model = await (await fetch(`${base}/web/whale/model.json`)).json();
    ok('配色的第一套必须是 deepseek（基础服装，贴图在 web/whale/tex 根目录）',
      model.schemes.length >= 1 && model.schemes[0].id === 'deepseek');
    /**
     * ★ **服装管线的守门断言**（2026-10-10 加）：`model.json` 里每个"非基础"的 scheme
     * 都必须在 `web/whale/schemes/<id>/tex/` 下有**完整的部件贴图** ——
     * `figure.js` 的 `loadScheme` 是把 `model.parts` 整批 load 的，少一张整页就崩（她直接不出现）。
     * 生图抠图那条流水线（`tools\fit-outfit.py`）每出一套都要过这一关。
     */
    const badSchemes = [];
    const featNames = [...Object.keys(model.feat.sprites),
      ...['eyeL', 'eyeR'].flatMap((k) => ['lash', 'ball', 'iris', ...(model.feat.eyes[k].rim ? ['rim'] : [])].map((n) => `${k}_${n}`))];
    for (const sc of model.schemes.slice(1)) {
      const dir = path.join(ctx.app, 'web/whale/schemes', sc.id);
      const missTex = model.parts.map((p) => p.tex).filter((t) => !fs.existsSync(path.join(dir, 'tex', `${t}.png`)));
      /**
       * ★ **`feat/` 也要整套**（2026-10-10 踩到的真 bug）：`figure.js` 的 `loadScheme` 是
       * `tex/` 和 `feat/` **一起** `Promise.all` load 的 —— 少了 feat 整批 reject，
       * 而页面只 `console.error`，现象是"换装点了没反应、她还穿原版"。
       */
      const missFeat = featNames.filter((n) => !fs.existsSync(path.join(dir, 'feat', `${n}.png`)));
      if (missTex.length || missFeat.length) badSchemes.push(`${sc.id}(缺 tex ${missTex.length} / feat ${missFeat.length})`);
    }
    ok(`服装：非基础配色都带完整贴图（tex + feat 整套）—— ${model.schemes.slice(1).map((s) => s.id).join('、') || '无'}`,
      badSchemes.length === 0 || (console.log('      [SCHEMEFAIL] ' + badSchemes.join(' ')), false));
    const eyes = ['eyeL', 'eyeR'].flatMap((k) => ['lash', 'ball', 'iris', ...(model.feat.eyes[k].rim ? ['rim'] : [])].map((n) => `${k}_${n}`));
    const wanted = [
      ...model.parts.map((p) => `/web/whale/tex/${p.tex}.png`),
      ...[...Object.keys(model.feat.sprites), ...eyes].map((n) => `/web/whale/feat/${n}.png`),
    ];
    const missing = [];
    for (const route of wanted) if ((await fetch(base + route)).status !== 200) missing.push(route);
    ok(`鲸鱼 ${wanted.length} 张贴图一张不缺`, missing.length === 0);
    if (missing.length) console.log(`      缺:${missing.join(', ')}`);

    for (const route of ['/web/%2e%2e/package.json', '/web/../../package.json', '/main.cjs', '/llm.cjs']) {
      const res = await fetch(base + route);
      ok(`挡住 ${route} -> ${res.status}`, res.status === 403 || res.status === 404);
    }
  },
};
