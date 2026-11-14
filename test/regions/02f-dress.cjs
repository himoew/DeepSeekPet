/**
 * 自检区域：服装
 * 从原 `test\smoke.cjs` 切出来的，**代码一字未改**（只把裸模块名换成 `ctx.*`）。
 * 单跑：`node test\smoke.cjs dress`
 */
module.exports = {
  name: "服装",
  tags: ['dress', '服装'],
  async run(ctx) {
    /** 区域文件里保持原样的模块名：从 ctx 上解构出来（属性名 'pet:' 之类因此不受影响）。 */
    const { __mark, FILES, fs, path, pathToFileURL, http, pet, lines, llm, store, checkLines, pageAreas, pageStages, pageGrabParts,
      textsOf, textsFilled, base, port, WebSocket, ok } = ctx;
    /* ---------- 2f. 服装接口（贴图以后再加，接口先占住） ---------- */
    const dress = ctx.mod('dress');
    const d0 = dress.list();
    ok('服装：记录文件落在 DSP_LOG_DIR 里（不碰用户真实选择）', dress.FILE.startsWith(ctx.CONFIG_DIR));
    ok('服装：默认穿原版', d0.current === 'original');
    ok('服装：★第二套〔真衣服〕已撤下（2026-10-10 用户："把第二套服装去掉吧，太多bug了"）—— 穿戴会被拒绝、她照旧穿原版',
      (() => { const r = dress.wear('outfit-01'); return r.ok === false && dress.list().current === 'original'; })());
    ok('服装：没贴图的那几套点了会给一句人话（不是没反应）',
      dress.wear('outfit-02').ok === false && /贴图/.test(dress.wear('outfit-02').error));
    ok('服装：不存在的套装会被拒绝', dress.wear('nope').ok === false);
    /**
     * ★ **换装页的缩略图**（用户："中间小鲸鱼换成对应服装图片"）：能穿的每一套都要有 `preview`，
     * 而且那个 URL 指向的文件必须真的在磁盘上（少一张就是卡片里一个破图）。
     */
    const noPreview = dress.list().outfits.filter((o) => o.ready && !o.preview);
    const brokenPreview = dress.list().outfits.filter((o) => o.preview && !fs.existsSync(path.join(ctx.app, o.preview.replace(/^\//, ''))));
    ok(`服装：能穿的每一套都有换装页缩略图、且文件都在（${dress.list().outfits.filter((o) => o.ready).map((o) => o.label).join('、')}）`,
      noPreview.length === 0 && brokenPreview.length === 0);
    ok('服装：原版能穿（换装记录落盘）', dress.wear('original').ok === true && dress.list().current === 'original');
    ok('服装：没换装时不给页面发 skin 覆盖（她照旧出现）', dress.skinOverride() === null);
    ok('服装：清单里有预留格，看得见"以后要加什么"',
      dress.OUTFITS.some((o) => !o.ready) && dress.OUTFITS.some((o) => o.ready));
    // 切到未 ready 的套装要被弹回原版（手工改坏文件也不会让她穿成空白）。
    // 必须**清掉 require 缓存**再读一次 —— 不清的话拿到的是同一个模块实例、读的是内存里的值。
    const dressFile = require.resolve(path.join(ctx.app, 'dress.cjs'));
    fs.writeFileSync(dress.FILE, JSON.stringify({ current: 'outfit-02' }));
    delete require.cache[dressFile];
    const hard = require(dressFile);
    ok('服装：文件被手改成没贴图的那套，也会退回原版',
      hard.list().current === 'original' && hard.skinOverride() === null);
    hard.forget();
    delete require.cache[dressFile];
    require(dressFile);                               // 让后面的用例拿到干净的那份
  },
};
