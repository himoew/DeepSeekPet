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

    /**
     * ★ 2026-11-01：**日志超过 512KB 是轮转，不是清空**。
     *
     * 原来 `writeFileSync(file, '')`：正好出事的那一段被自己吃掉，第二天查"她为什么哑了"
     * 只剩空白。（`pet-host.cjs` 早就是 `.1` 轮转，这里跟它对齐。）
     */
    const logMod = ctx.mod('log');
    fs.writeFileSync(logMod.file, 'x'.repeat(logMod.maxBytes + 10), 'utf8');
    logMod.info('轮转测试');
    const rotated = `${logMod.file}.1`;
    ok('日志：超过上限轮转成 .1（旧的留着，不是清空）',
      fs.existsSync(rotated) && fs.statSync(rotated).size > logMod.maxBytes
      && fs.statSync(logMod.file).size < 4096
      && fs.readFileSync(logMod.file, 'utf8').includes('轮转测试'));
    fs.rmSync(rotated, { force: true });

    /**
     * ★ 2026-11-01：**IPC 的第二个参数可能是 `null`**。
     * 原来每个 handler 都写成 `(_e, { id } = {})` —— 默认值只兜 `undefined`，
     * 渲染进程传 `null` 会当场 `TypeError`，这一次 IPC 变成 rejected promise。
     * 现在统一先过 `asObj(payload)`。这条是静态守卫：settings.cjs 里不许再出现那种写法。
     */
    const settingsSrc = fs.readFileSync(path.join(ctx.app, 'settings.cjs'), 'utf8');
    const badDestructure = settingsSrc.match(/ipcMain\.handle\([^)]*,\s*(?:async\s*)?\(_e,\s*\{/g) || [];
    ok(`设置页的 IPC 不会因为渲染进程传 null 而抛 TypeError（还有 ${badDestructure.length} 处直接解构）`,
      badDestructure.length === 0 && /function asObj\(payload\)/.test(settingsSrc));
  },
};
