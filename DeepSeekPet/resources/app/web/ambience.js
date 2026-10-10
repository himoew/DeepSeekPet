/**
 * 天气的环境音（2026-10-11 新建；用户："天气没有音效，建议网上找段环境白噪声或相关生成的代码加上去"）。
 *
 * ★ **为什么是"生成的"而不是下载一段 wav**（三条都是硬理由）：
 *   ① 这个项目**一个音频素材都没有**：`pet-core.js` 的音效全是 Web Audio 现场合成的
 *      （`createSfx` 那段注释写着 "synthesized with Web Audio, no files"）。环境音要是塞一个
 *      几 MB 的 wav 进来，就得改打包、改 AGPL 声明、还要处理"循环接缝"；
 *   ② **循环接缝**：环境白噪声最怕"每 3 秒一个啪嗒"。生成的噪声是**连续流**（见下面的
 *      `rain` / `hiss` / `rumble` 三条常驻源），没有接缝可言；
 *   ③ **要跟天气一一对应**：雪是"风声大、几乎没有别的"，雨是"密雨 + 低频轰轰 + 偶尔远雷"，
 *      落叶是"沙沙 + 偶尔一片擦过"，樱是"很轻的风 + 一串鸟"。素材拼不出来这种"按天气切"，
 *      参数表可以（见 `TRACKS`）。
 *
 * ★ **本底噪声是"录制的安静房间"**（Loop 的 `-42dBFS` 底噪 + `ctx.resume()` 那点电流声），
 *   不是从文件来的。参考的实现思路：白噪声 → 带通/低通滤波 → 慢 LFO 调制增益，
 *   也就是 [noisefall](https://github.com/g-zen/noisefall)、
 *   [web-audio-noise-generator](https://github.com/attiks/web-audio-noise-generator) 这一类
 *   纯 Web Audio 的环境音做法。
 *
 * ★ **接线**（见 `pet-app.js` 的 `stepWeather`）：`follow()` 是**每帧调一次**的，
 *   它负责"到点该响就响"（雨滴、落叶沙沙、鸟叫、远雷那种**非周期**的点缀），
 *   连续的底噪只在 `switchTo()` 时改一次参数 —— **别每帧动音频节点**。
 *
 * ★ **静音**：跟她的音效共用一个开关（`sfx.on()` 的 `prefs.sound`）。关掉时
 *   `master.gain` 归零、`ctx.suspend()`，不是"挂在那里零增益" —— 挂着的音频线程也会耗电。
 *
 * ⚠️ 浏览器/Electron 的自动播放策略：`AudioContext` 一开始是 `suspended`，
 *   所以 `unlock()`（页面给的一个用户手势，或者宿主给的"已解锁"信号）之后才真的出声。
 */
const R = (a, b) => a + Math.random() * (b - a);

/**
 * 每种天气的音色表。`vol` 是这一档的总音量（对 master 的倍数），
 * `low/high` 是底噪的低通/高通截止（Hz），`lfo` 让截止或增益慢慢晃（[速率 Hz, 幅度]），
 * `spark` 是**非周期点缀**（雨滴 / 落叶擦过 / 鸟叫 / 远雷），`every` 是它的期望间隔（秒）。
 */
const TRACKS = {
  snow: {
    vol: .5, seed: 11,
    hiss: { low: 460, high: 0, gain: .10, lfo: [.05, 150, .5] },      // 风：低通噪声慢慢晃
    rumble: { low: 110, gain: .055, lfo: [.03, 30, .6] },
    every: [3.5, 9], spark: 'gust',                                  // 偶尔一阵风紧一点
  },
  blossom: {
    vol: .42, seed: 22,
    hiss: { low: 1500, high: 400, gain: .045, lfo: [.07, 500, .45] }, // 很轻的风 + 花瓣摩擦的细碎声
    rumble: null,
    every: [6, 16], spark: 'bird',                                   // 春天：偶尔一串鸟叫
  },
  leaf: {
    vol: .5, seed: 33,
    hiss: { low: 3000, high: 500, gain: .055, lfo: [.11, 1600, .5] }, // 沙沙：中高频噪声
    rumble: null,
    every: [1.1, 3.4], spark: 'rustle',                              // 一片叶子擦过
  },
  rain: {
    vol: .58, seed: 44,
    hiss: { low: 7000, high: 1000, gain: .12, lfo: [.09, 1800, .35] },  // 密雨：宽带高频
    rumble: { low: 150, gain: .07, lfo: [.05, 40, .5] },                // 雨幕的低频轰轰
    every: [.07, .22], spark: 'drop',                                    // 打在玻璃上的雨滴
    thunder: [14, 40],                                                   // 远雷（很低、很闷）
  },
};

export function createAmbience({ report } = {}) {
  let ctx = null, master = null;
  let on = true, mode = 'off', booted = false, unlocked = false, failed = false;
  /** 现在响着的这一档（`{ node: GainNode, timer, cfg, name }`）。 */
  let live = null;
  /** `follow()` 的节流与计时：`{ next, thunderAt, startedAt }`。 */
  let when = { startedAt: 0, next: 0, thunderAt: 0 };
  let base = null;

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
        // 共用一条噪声源：环境音的三种做法都是"同一条白噪声 + 不同滤波"
        const len = Math.floor(ctx.sampleRate * 2);
        const buf = ctx.createBuffer(1, len, ctx.sampleRate);
        const d = buf.getChannelData(0);
        for (let i = 0; i < len; i += 1) d[i] = Math.random() * 2 - 1;
        base = buf;
      } catch (e) {
        failed = true;
        try { report?.(`环境音起不来（不影响画面）：${e && e.message}`); } catch (err) { /* ignore */ }
        return null;
      }
    }
    if (ctx.state === 'suspended' && enabled()) ctx.resume().catch(() => {});
    return ctx;
  }

  /**
   * 底噪那一层：噪声源 → **增益（被 LFO 慢慢晃）** → 低通 → 高通 → 这一档的增益 → master。
   * `lfo` 之所以要接到**滤波器频率**上（而不是只晃增益），是为了"风声一阵紧一阵松"——
   * 只晃音量听着像音量旋钮被人拧，晃截止频率才像风。
   */
  function build(lo) {
    const c = context();
    if (!c) return null;
    const made = { nodes: [], oscs: [], gains: [] };
    const inGain = c.createGain();
    inGain.gain.value = 1;
    made.nodes.push(inGain);
    let head = inGain;
    if (lo.hiss) {
      const s = c.createBufferSource();
      s.buffer = base; s.loop = true;
      const g = c.createGain(); g.gain.value = lo.hiss.gain;
      const bq = c.createBiquadFilter(); bq.type = 'lowpass'; bq.frequency.value = lo.hiss.low; bq.Q.value = .6;
      s.connect(g); g.connect(bq); bq.connect(inGain);
      const [rate, depth] = lo.hiss.lfo || [];
      if (rate) {
        const l = c.createOscillator(); l.__lfo = true; l.frequency.value = rate;
        const lg = c.createGain(); lg.gain.value = depth || 0;
        l.connect(lg); lg.connect(bq.frequency);
        l.start(); made.oscs.push(l);
      }
      s.start();
      made.nodes.push(s, g, bq);
    }
    if (lo.rumble) {
      const s = c.createBufferSource();
      s.buffer = base; s.loop = true;
      const g = c.createGain(); g.gain.value = lo.rumble.gain;
      const bq = c.createBiquadFilter(); bq.type = 'lowpass'; bq.frequency.value = lo.rumble.low; bq.Q.value = .4;
      s.connect(g); g.connect(bq); bq.connect(inGain);
      const [rate, depth] = lo.rumble.lfo || [];
      if (rate) {
        const l = c.createOscillator(); l.__lfo = true; l.frequency.value = rate;
        const lg = c.createGain(); lg.gain.value = depth || 0;
        l.connect(lg); lg.connect(bq.frequency);
        l.start(); made.oscs.push(l);
      }
      s.start();
      made.nodes.push(s, g, bq);
    }
    // 高通（"雨"要去掉低频糊声；"风"不需要）
    if (lo.hiss && lo.hiss.high) {
      const hp = c.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = lo.hiss.high; hp.Q.value = .5;
      head.disconnect?.();
      head.connect(hp);
      head = hp;
      made.nodes.push(hp);
    }
    const out = c.createGain();
    out.gain.value = 0;
    head.connect(out);
    out.connect(master);
    made.nodes.push(out);
    made.head = head;
    made.out = out;
    return made;
  }

  function teardown() {
    if (!live) return;
    const c = ctx;
    const { made } = live;
    try {
      if (c && made.out) {
        made.out.gain.cancelScheduledValues(c.currentTime);
        made.out.gain.setTargetAtTime(0, c.currentTime, .12);
      }
    } catch (e) { /* ignore */ }
    const kill = () => {
      for (const n of made.oscs) { try { n.stop(); } catch (e) { /* ignore */ } }
      for (const n of made.nodes) { try { n.stop?.(); } catch (e) { /* ignore */ } try { n.disconnect?.(); } catch (e) { /* ignore */ } }
    };
    if (c) setTimeout(kill, 320); else kill();
    live = null;
  }

  /* ---------- 非周期的点缀（雨滴 / 落叶擦过 / 鸟叫 / 远雷） ---------- */
  /** 一次短促的滤波噪声（雨滴、落叶沙沙都用它，只是参数不同）。 */
  function blip({ type = 'bandpass', f0 = 2000, f1 = f0, q = 1, dur = .08, vol = .2, at = 0, attack = .006 }) {
    const c = context();
    if (!c || !live) return;
    try {
      const t0 = c.currentTime + at;
      const s = c.createBufferSource(); s.buffer = base;
      const bq = c.createBiquadFilter(); bq.type = type; bq.Q.value = q;
      bq.frequency.setValueAtTime(f0, t0);
      bq.frequency.exponentialRampToValueAtTime(Math.max(40, f1), t0 + dur);
      const g = c.createGain();
      g.gain.setValueAtTime(.0001, t0);
      g.gain.exponentialRampToValueAtTime(vol, t0 + attack);
      g.gain.exponentialRampToValueAtTime(.0001, t0 + dur);
      s.connect(bq); bq.connect(g); g.connect(live.made.out);
      s.start(t0, Math.random() * 1.5); s.stop(t0 + dur + .04);
    } catch (e) { /* ignore */ }
  }
  /** 一个音（鸟叫用）：`f0→f1` 的滑音，带一点颤。 */
  function chirp({ f0 = 2400, f1 = 3000, dur = .09, vol = .10, at = 0, type = 'sine', vib = 0, vibRate = 0 }) {
    const c = context();
    if (!c || !live) return;
    try {
      const t0 = c.currentTime + at;
      const o = c.createOscillator(); o.type = type;
      o.frequency.setValueAtTime(f0, t0);
      o.frequency.exponentialRampToValueAtTime(Math.max(60, f1), t0 + dur);
      if (vib) {
        const l = c.createOscillator(); l.frequency.value = vibRate;
        const lg = c.createGain(); lg.gain.value = vib;
        l.connect(lg); lg.connect(o.frequency); l.start(t0); l.stop(t0 + dur + .04);
      }
      const g = c.createGain();
      g.gain.setValueAtTime(.0001, t0);
      g.gain.exponentialRampToValueAtTime(vol, t0 + .012);
      g.gain.exponentialRampToValueAtTime(.0001, t0 + dur);
      o.connect(g); g.connect(live.made.out);
      o.start(t0); o.stop(t0 + dur + .04);
    } catch (e) { /* ignore */ }
  }
  /** 远雷：闷、低、慢（`blip` 加长版 + 一条低频滑音）。 */
  function thunder() {
    blip({ type: 'lowpass', f0: 260, f1: 70, q: .4, dur: 2.4, vol: .16, attack: .5 });
    chirp({ type: 'sine', f0: 62, f1: 34, dur: 2.1, vol: .09, vib: 3, vibRate: 1.4 });
  }
  /**
   * 到点了：按天气做一次点缀。`cfg.spark` 决定做哪种；返回**做了几个音**（0 = 这种天气没有点缀）。
   * 返回值是给自检和诊断用的：`follow()` 把它加起来，调用方就能知道"这一段时间到底响没响"。
   */
  function spark(cfg, now) {
    let n = 0;
    switch (cfg.spark) {
      case 'drop': {                       // 打在玻璃上的雨滴：短、脆、左右声道随机
        const k = Math.random() < .25 ? 2 : 1;
        for (let i = 0; i < k; i += 1) {
          blip({ type: 'bandpass', f0: R(1600, 5200), f1: R(500, 1400), q: R(1.5, 5), dur: R(.03, .07), vol: R(.05, .16), at: i * .05 });
          n += 1;
        }
        break;
      }
      case 'rustle': {                     // 一片叶子擦过地面/空气：一串很轻的沙沙
        for (let i = 0; i < 3; i += 1) {
          blip({ type: 'bandpass', f0: R(2200, 4600), f1: R(900, 2000), q: R(.8, 2), dur: R(.05, .12), vol: R(.03, .07), at: i * .07 });
          n += 1;
        }
        break;
      }
      case 'gust': {                       // 一阵风紧了一下（不是点缀，是"包络"的补刀）
        blip({ type: 'lowpass', f0: R(500, 900), f1: R(180, 320), q: .5, dur: R(.7, 1.6), vol: R(.05, .10), attack: .3 });
        n += 1;
        break;
      }
      case 'bird': {                       // 一串鸟叫（樱花天的标志）
        const base = R(2100, 3000);
        const k = 2 + Math.floor(Math.random() * 3);
        for (let i = 0; i < k; i += 1) {
          chirp({ f0: base * R(.9, 1.1), f1: base * R(1.15, 1.5), dur: R(.05, .11), vol: R(.05, .09), at: i * R(.09, .16) });
          n += 1;
        }
        break;
      }
      default: break;
    }
    void now;
    return n;
  }

  function boot() {
    if (booted) return;
    booted = true;
    when = { startedAt: 0, next: 0, thunderAt: 0 };
  }

  const api = {
    /**
     * 用户手势之后调一次（页面在 `sfx.unlock()` 旁边一起调）。**只解锁，不出声** ——
     * 出不出声由 `follow()`/`switchTo()` 按当前天气决定。
     */
    unlock() {
      unlocked = true;
      const c = context();
      if (c && c.state === 'suspended' && enabled()) c.resume().catch(() => {});
    },
    /** 跟她的音效共用一个开关（`prefs.sound`）。关掉会 `suspend()`，不是"挂在那里零增益"。 */
    setEnabled(v) {
      on = !!v;
      if (!ctx || !master) return;
      try {
        const c = ctx;
        master.gain.cancelScheduledValues(c.currentTime);
        master.gain.setTargetAtTime(on ? 1 : 0, c.currentTime, .25);
        if (on && enabled()) ctx.resume().catch(() => {});
        else if (!on) setTimeout(() => { if (!on && ctx && ctx.state === 'running') ctx.suspend().catch(() => {}); }, 600);
      } catch (e) { /* ignore */ }
    },
    /**
     * 每帧调一次（页面在 `stepWeather` 里）。负责"到点该响就响"那部分：
     * 连续底噪归 `switchTo()` 管，这里只做**点缀的排期**（雨滴、落叶、鸟叫、远雷）。
     * 返回这一帧**放了几个音**（诊断/自检用；正式调用忽略返回值）。
     */
    follow(modeName, dt, now) {
      if (!enabled()) return 0;
      const name = TRACKS[modeName] ? modeName : null;
      if (name !== mode) { mode = name || 'off'; api._apply(); }
      if (!live || !name) return 0;
      const cfg = TRACKS[name];
      boot();
      let played = 0;
      if (!when.startedAt) when.startedAt = now;
      if (!when.next) when.next = now + R(cfg.every[0], cfg.every[1]);
      if (now >= when.next) {
        when.next = now + R(cfg.every[0], cfg.every[1]);
        played += spark(cfg, now);
      }
      if (cfg.thunder) {
        if (!when.thunderAt) when.thunderAt = now + R(cfg.thunder[0], cfg.thunder[1]);
        if (now >= when.thunderAt) {
          when.thunderAt = now + R(cfg.thunder[0], cfg.thunder[1]);
          thunder();
          played += 2;                        // 远雷 = 一声闷响 + 一条低频滑音
        }
      }
      void dt;
      return played;
    },
    /** 直接把环境音切到某种天气（不经过每帧的 `follow`；页面切天气时可以立刻叫一次）。 */
    switchTo(modeName) {
      mode = TRACKS[modeName] ? modeName : 'off';
      api._apply();
    },
    _apply() {
      const cfg = TRACKS[mode];
      if (!enabled() || !cfg) { teardown(); when.next = 0; when.thunderAt = 0; return; }
      const c = context();
      if (!c) return;
      if (live && live.name === mode) {
        try { live.made.out.gain.setTargetAtTime(cfg.vol, c.currentTime, .5); } catch (e) { /* ignore */ }
        return;
      }
      teardown();
      const made = build(cfg);
      if (!made) return;
      live = { name: mode, made, cfg };
      try { made.out.gain.setTargetAtTime(cfg.vol, c.currentTime, 1.2); } catch (e) { /* ignore */ }
      when.next = 0; when.thunderAt = 0;
    },
    /** 诊断用：字号（`off` / 天气名 / `failed`）。 */
    state: () => ({ on, unlocked, mode, live: !!live, ctx: ctx ? ctx.state : 'none', failed }),
  };
  return api;
}
