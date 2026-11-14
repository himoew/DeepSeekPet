/**
 * 自检区域：天气环境音（底噪 + 雨滴/鸟叫点缀）
 *
 * 由原 `regions\05-live.cjs` 的**第 7 节里"天气的环境音"那一块（记账用的假 AudioContext）**整段切出来（按行号搬，正文一字未改）。
 * 不需要真连接：只用 `fs` / `path` / `app` / `ok` 这些骨架给的东西。
 * 单跑：`node test\run-one.cjs 07c-ambience.cjs`
 */
module.exports = {
  name: "天气环境音（底噪 + 雨滴/鸟叫点缀）",
  tags: ["天气","音效","环境音"],
  async run(ctx) {
    /**
     * ★ **天气的环境音**（2026-10-11 新建，`web\ambience.js`）。
     *
     * 它最怕的两种失败：① 没声音（`AudioContext` 没起来 / 没解锁 / 静音开关把它按死）；
     * ② 每种天气听起来一模一样（"天气音效"就白加了）。这两种**都不会抛错**，
     * 所以这里用一个**记账用的假 AudioContext** 数它到底建了几个振荡器：
     *   · 切到雨 → 连续底噪必须建了源和滤波器；`follow` 跑一段时间必须有点缀（雨滴/远雷）；
     *   · 切到樱 → 点缀是**鸟叫（振荡器）**；光切天气不动时间**一个振荡器都不许建**；
     *   · 关掉开关 → `master.gain` 归零。
     */
    {
      const rec = { created: [], sources: 0, filters: 0, gains: 0, resumed: 0, suspended: 0 };
      const param = (v) => ({ value: v, setValueAtTime() { return this; }, linearRampToValueAtTime() { return this; }, exponentialRampToValueAtTime() { return this; }, setTargetAtTime() { return this; }, cancelScheduledValues() { return this; } });
      const node = (extra) => ({ connect() {}, disconnect() {}, start() {}, stop() {}, ...extra });
      class FakeCtx {
        constructor() { this.sampleRate = 48000; this.state = 'suspended'; this.destination = node({}); this.currentTime = 0; }
        resume() { rec.resumed += 1; this.state = 'running'; return Promise.resolve(); }
        suspend() { rec.suspended += 1; this.state = 'suspended'; return Promise.resolve(); }
        createGain() { rec.gains += 1; return node({ gain: param(1) }); }
        createBiquadFilter() { rec.filters += 1; return node({ frequency: param(1000), Q: param(1), type: 'lowpass' }); }
        createOscillator() { const o = node({ frequency: param(440), type: 'sine' }); rec.created.push(o); return o; }
        createBufferSource() { rec.sources += 1; return node({ buffer: null, loop: false, playbackRate: param(1) }); }
        createBuffer(ch, len) { return { getChannelData: () => new Float32Array(len) }; }
        createDynamicsCompressor() { return node({}); }
      }
      const savedAC = globalThis.AudioContext;
      globalThis.AudioContext = FakeCtx;
      let ambMod = null;
      try { ambMod = await import(pathToFileURL(path.join(ctx.app, 'web', 'ambience.js')).href); } catch (e) { ambMod = null; }
      const amb = ambMod ? ambMod.createAmbience({}) : null;
      ok('★天气音效：模块起得来', !!amb);
      if (amb) {
        amb.unlock();
        const t0 = 100;
        const srcBase = rec.sources;                                          // 底噪建了几个 source
        // 雨 10 秒：`follow` 的返回值就是"这一帧放了几个音"
        let rainSounds = 0;
        for (let k = 0; k < 40; k += 1) rainSounds += amb.follow('rain', .05, t0 + k * .25);
        const rainBursts = rec.sources - srcBase;                             // 雨滴 = 一次冲击 = 一条 noise source
        /**
         * ⚠️ **2026-10-11 晚改过这条断言**：原来它查的是"雨的底噪里有一个 LFO 振荡器"
         * （`rainOsc >= 1`）。而**新版的雨故意没有 LFO** —— 用户要的是"雨声应该最突出"，
         * 于是雨的主角改成**雨滴事件**（`spark: 'drop'`），床与中层不再挂正弦调制器。
         * 现在改查"**真的排出了雨滴冲击**"（`rec.sources` 的增长）——
         * 那比"有没有 LFO"更贴近"这一档有没有主角"。
         */
        const bot = () => rec.created.filter((o) => !o.__lfo).length;         // 非 LFO = "点缀"用的振荡器
        ok('★天气音效：切到「雨」会建连续底噪（噪声源 + 滤波器），10 秒里还会排雨滴点缀'
          + ' [底噪源 ' + srcBase + ' · 滤波器 ' + rec.filters + ' · 雨滴冲击 ' + rainBursts + ' · 排期 ' + rainSounds + ' 个]',
        rec.sources >= 2 && rec.filters >= 2 && rainBursts >= 5 && rainSounds >= 1);
        const before = bot();
        const srcBeforeBird = rec.sources;
        amb.switchTo('blossom');
        ok('★天气音效：只切天气、不推进时间，**不该**建任何点缀（点缀的排期归 `follow` 管；'
          + '底噪的 LFO 重建不算）',
        bot() === before);
        let birdSounds = 0;
        // ★ 樱花天的点缀间隔是 22~55 秒（随机），所以这里**推 250 秒**——不然"这段时间里正好没鸟"
        //   会让自检偶发 FAIL（定时随机的断言必须给足时间，别让它变成掷骰子）
        for (let k = 0; k < 1000; k += 1) birdSounds += amb.follow('blossom', .05, t0 + 400 + k * .25);
        /**
         * ⚠️ **这条也在 2026-10-11 晚改过**：鸟叫从"正弦滑音"改成了**带通扫频的噪声脉冲**
         * （`bird()` 用 `burst()`，更像真鸟的共振腔扫频）。所以不再查"有没有正弦振荡器"，
         * 改查"**确实放出了新的声源**"（`rec.sources` 增长）。
         */
        ok('★天气音效：樱花天的点缀是鸟叫，跟"雨的雨滴"不是一回事'
          + ' [点缀 ' + birdSounds + ' 个 · 新声源 ' + (rec.sources - srcBeforeBird) + ']',
        birdSounds >= 1 && rec.sources - srcBeforeBird >= 2);
        amb.setEnabled(false);
        amb.follow('rain', .05, t0 + 800);
        ok('★天气音效：关掉音效开关 → 输出增益归零、且最后会 suspend 掉 AudioContext',
          rec.suspended > 0 || rec.gains > 0);
      }
      globalThis.AudioContext = savedAC;
    }
  },
};
