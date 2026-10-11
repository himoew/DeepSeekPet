/**
 * 天气的环境音 · **真实录音循环版**（2026-10-11 深夜换代）
 *
 * ★ **这一版不再合成任何声音**：每一档就是一段**真实录音切出来的无缝循环**
 *   （`dev-weather/make-loop.mjs` 生成；接缝在数学上连续：文件最后一个样点的下一个样点
 *   就是文件第一个样点，实测跳变只有内部自然抖动的 5%~40%）。
 *
 *   | 档 | 素材 | 授权 |
 *   |---|---|---|
 *   | 雨 | OpenGameArt「Rain (loopable)」等 | CC0 |
 *   | 雪 | OpenGameArt「Winter Wind」等 | CC0 / CC-BY |
 *   | 落叶 | OpenGameArt「Leaves」等 | CC-BY / CC0 |
 *   | 樱花 | OpenGameArt「Forest Ambience」等 | CC0 |
 *   出处与授权逐条记在 `audio/index.json`（`apply-choice.mjs` 生成）。
 *
 * ★ 为什么换掉合成引擎（用户拍板）：合成那套的"越到后面越大"，真根因是
 *   **慢随机游走缓冲只填了 2 秒、剩下 28 秒是静音**（还挂着 loop），再叠一只 0.02Hz 高通
 *   （τ≈8 秒）→ 20 秒里电平**单调**爬 +11.4dB；而且运行时那个 `driftRms` 算成了 **NaN**，
 *   Chromium 里 `AudioParam.value = NaN` 直接抛 TypeError —— 桌宠里那套环境音**根本起不来**。
 *   换成"播一段真录音"之后，这一整类坑**全部不存在**：没有包络、没有游走、没有游走归一化。
 *
 * ★ 接口跟老的合成版**一模一样**（`unlock / setEnabled / switchTo / follow / state`），
 *   所以 `pet-app.js` 除了"换成 import 这个文件"，别的都不用改。
 *
 * ⚠️ 电平：循环文件已经**按 RMS 归一到 -26dBFS**（跟老版标定的最终电平同一个数），
 *   所以这里**再乘 MASTER_GAIN 就重复了** —— 见下面的常量说明。
 */

/** 整档的总音量（1 = 循环文件的原始电平，也就是 -26dBFS RMS；用户嫌大就往下调这个数）。 */
const MASTER_GAIN = 1;
/** 切天气时的淡化时长（秒）：0.8 秒交叉淡化，够顺，又不会两档叠太久。 */
const FADE_IN = .8, FADE_OUT = .6;
/** 清单：`{ items: [{ kind, file, gainDb, label, license }] }`（`apply-choice.mjs` 生成）。 */
const MANIFEST = 'audio/index.json';

export function createAmbience({ report } = {}) {
  let ctx = null, master = null;
  let on = true, mode = 'off', unlocked = false, failed = false;
  /** 现在响着的那一档：`{ kind, src, gain }`。 */
  let live = null;
  /** `kind → AudioBuffer`（解码一次就够了；4 段 × 20 秒 = 约 30MB，可以接受）。 */
  const cache = new Map();
  /** `kind → { file, gainDb, label, license }`。 */
  let tracks = null;
  let loading = null;

  const enabled = () => on && unlocked && !failed;

  function context() {
    if (failed) return null;
    if (!ctx) {
      const C = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!C) { failed = true; return null; }
      try {
        ctx = new C();
        master = ctx.createGain();
        master.gain.value = 0;
        master.connect(ctx.destination);
      } catch (e) {
        failed = true;
        try { report?.(`环境音起不来（不影响画面）：${e && e.message}`); } catch (err) { /* ignore */ }
        return null;
      }
    }
    if (ctx.state === 'suspended' && enabled()) ctx.resume().catch(() => {});
    return ctx;
  }

  /** 读清单（只读一次）。 */
  async function manifest() {
    if (tracks) return tracks;
    if (!loading) {
      loading = (async () => {
        const res = await fetch(MANIFEST, { cache: 'no-store' });
        if (!res.ok) throw new Error('清单读不到：' + res.status);
        const j = await res.json();
        tracks = new Map((j.items || []).map((i) => [i.kind, i]));
        return tracks;
      })().catch((e) => {
        failed = true;
        try { report?.(`环境音清单读取失败：${e && e.message}`); } catch (err) { /* ignore */ }
        return null;
      });
    }
    return loading;
  }

  /** 取（必要时解码）一档的缓冲。 */
  async function bufferOf(kind) {
    if (cache.has(kind)) return cache.get(kind);
    const t = await manifest();
    const item = t && t.get(kind);
    if (!item) throw new Error('没有这一档：' + kind);
    const res = await fetch('audio/' + item.file, { cache: 'no-store' });
    if (!res.ok) throw new Error('音频读不到：' + item.file + ' ' + res.status);
    const buf = await ctx.decodeAudioData(await res.arrayBuffer());
    cache.set(kind, { buf, gainDb: item.gainDb || 0, item });
    return cache.get(kind);
  }

  /** 把当前这一档淡出、停掉。 */
  function stopLive(when) {
    if (!live) return;
    const { src, gain } = live;
    const t = when || (ctx ? ctx.currentTime : 0);
    try {
      gain.gain.cancelScheduledValues(t);
      gain.gain.setValueAtTime(gain.gain.value, t);
      gain.gain.linearRampToValueAtTime(0, t + FADE_OUT);
      src.stop(t + FADE_OUT + .05);
    } catch (e) { /* ignore */ }
    live = null;
  }

  /** 真的切到某一档（异步：要解码）。 */
  async function start(kind) {
    const c = context();
    if (!c || !enabled()) return;
    try {
      const rec = await bufferOf(kind);
      if (!enabled() || mode !== kind) return;          // 等解码的功夫天气又变了
      stopLive(c.currentTime);
      const src = c.createBufferSource();
      src.buffer = rec.buf;
      src.loop = true;                                   // ★ 循环就靠它（缓冲循环是**样点精确**的）
      const gain = c.createGain();
      gain.gain.setValueAtTime(0, c.currentTime);
      gain.gain.linearRampToValueAtTime(10 ** ((rec.gainDb || 0) / 20), c.currentTime + FADE_IN);
      src.connect(gain); gain.connect(master);
      src.start(c.currentTime, 0);
      live = { kind, src, gain };
      try { report?.(`环境音：${rec.item && rec.item.label ? rec.item.label : kind}`); } catch (e) { /* ignore */ }
    } catch (e) {
      try { report?.(`环境音切档失败（不影响画面）：${e && e.message}`); } catch (err) { /* ignore */ }
    }
  }

  function apply() {
    if (!enabled() || mode === 'off') { if (ctx) stopLive(); return; }
    if (live && live.kind === mode) return;
    start(mode);
  }

  return {
    /** 用户手势之后调一次（页面在 `sfx.unlock()` 旁边一起调）。只解锁，不出声。 */
    unlock() {
      unlocked = true;
      const c = context();
      if (c && c.state === 'suspended' && enabled()) c.resume().catch(() => {});
      manifest();                                        // 顺便把清单读起来
    },
    /** 开/关（页面那边是「声音」总闸 × 右键菜单「天气声」两层的与）。 */
    setEnabled(v) {
      on = !!v;
      if (!ctx || !master) return;
      try {
        const c = ctx;
        master.gain.cancelScheduledValues(c.currentTime);
        master.gain.setValueAtTime(master.gain.value, c.currentTime);
        master.gain.linearRampToValueAtTime(on ? MASTER_GAIN : 0, c.currentTime + .25);
        if (on && enabled()) { ctx.resume().catch(() => {}); apply(); }
        else if (!on) setTimeout(() => { if (!on && ctx && ctx.state === 'running') ctx.suspend().catch(() => {}); }, 600);
      } catch (e) { /* ignore */ }
    },
    /** 每帧调一次（页面在 `stepWeather` 里）：这一版只负责"天气变了就换档"。 */
    follow(kind, dt, now) {
      const name = TRACK_NAMES.has(kind) ? kind : null;
      if (name !== mode) { mode = name || 'off'; apply(); }
      void dt; void now;
      return 0;
    },
    /** 直接把环境音切到某种天气（页面切天气时立刻叫一次）。 */
    switchTo(kind) {
      mode = TRACK_NAMES.has(kind) ? kind : 'off';
      apply();
    },
    /** 诊断。 */
    state: () => ({
      on, unlocked, mode, live: live ? live.kind : null, ctx: ctx ? ctx.state : 'none', failed,
      silent: !(on && unlocked && !failed && live && !!ctx && ctx.state === 'running'),
      master: MASTER_GAIN, cached: [...cache.keys()], manifest: tracks ? [...tracks.keys()] : null,
    }),
  };
}

/** 有素材的天气（`pet-app.js` 传进来的 `kind`）。 */
const TRACK_NAMES = new Set(['rain', 'snow', 'leaf', 'blossom']);
