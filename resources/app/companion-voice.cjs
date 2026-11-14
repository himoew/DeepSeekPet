/**
 * 她的声音 —— 直接把一句话交给**火山「豆包语音合成 1.0」**（openspeech v3）合成 mp3，
 * 再交给 OneBot 当 QQ 语音发出去。
 *
 * ★ 2026-11-01 上午：原先这里是打本机 7860 的预览台（`/api/tts`）。用户把那个窗口一关，
 * 语音就整条哑了（界面上写着"7860 没开"），所以把 1.0 的合成逻辑整段搬进桌宠：
 * 请求体、请求头、一行一个 JSON 的流式回包解析，全部在这里，不再依赖那个页面。
 * Key 存在 `config\companion.json` 的 `voice.tts.apiKey`，只有 1.0 支持混音（2.0 回空音频）。
 *
 * 音色方案是**写死**的（用户 2026-11-01 调好、并且听过样音的那套内置预设）：
 *   佩奇猪 40 + 撒娇学妹 20 + 魅力女友 40；语速 -5、音量 0、音调 +2。
 * 设置页只暴露四个旋钮：语速 / 音量 / 音色（音调）/ 情感。
 *
 * ★ 2026-11-01 实测（deepseek-chat + 她真实角色卡）：让她自己决定"要不要发语音"，
 * 40 多次里几乎一次都不发（连"想我没/抱抱/晚安"都打字）。但只要系统说
 * "这一条先用语音说一句，再打字"，她 3/3 照做，而且内容是她自己的。
 * 所以 `decide()` 是"递话筒"：由场景决定这一条能不能用声音，说什么仍由她写。
 */
const crypto = require('node:crypto');

const DEFAULT_MIX = [
  { speaker: 'zh_female_peiqi_mars_bigtts', factor: 40 },
  { speaker: 'zh_female_yuanqinvyou_moon_bigtts', factor: 20 },
  { speaker: 'zh_female_meilinvyou_moon_bigtts', factor: 40 },
];

const DEFAULTS = {
  /**
   * 总开关。**默认开**（用户 2026-11-01 上午："默认开启语音"）——
   * 但没配 Key 的时候 `decide()` 照样不发、能力提示也不出现，不会假装有嗓子。
   */
  enabled: true,
  /** auto = 有由头时递话筒；tag = 只认她自己写的 [语音]。 */
  mode: 'auto',
  /** 群里默认不发（语音在群里很打扰）。 */
  allowGroups: false,
  /**
   * 火山「豆包语音合成 1.0」直连。
   *
   * ★ 2026-11-01 上午：原来这里叫 `baseUrl`，指向本机 7860 的预览台（`/api/tts`）。
   * 用户关了那个窗口，语音就整条哑了（设置页显示"7860 没开"）——所以把 1.0 的
   * 合成逻辑搬进桌宠，直连 openspeech，不再依赖那个页面。
   * 只有 1.0 支持混音（2.0 会回 EMPTY_AUDIO），所以 resourceId 写死 1.0。
   */
  tts: {
    endpoint: 'https://openspeech.bytedance.com/api/v3/tts/unidirectional',
    /** 火山控制台的 API Key。存在 `config\companion.json` 里，设置页可改。 */
    apiKey: '',
    timeoutMs: 30000,
    uid: 'blue-fish-deskpet',
    speaker: 'custom_mix_bigtts',
    resourceId: 'seed-tts-1.0',
    mix: DEFAULT_MIX,
    format: 'mp3',
    sampleRate: 24000,
    /** 下面四个是设置页能调的（和预览台同名）。 */
    speechRate: -5,
    loudnessRate: 0,
    pitch: 2,
    emotion: '',
    emotionScale: 4,
    /** 一条语音最多念多少字：超过就退回文字，别让 QQ 语音条太长。 */
    maxChars: 120,
  },
  /**
   * 什么时候递话筒。**没有每日上限、也没有间隔**（用户 2026-11-01：
   * "20 分钟那种间隔给我去掉，她想说就说"）—— 只剩"这一条要不要用声音"的概率。
   */
  stage: {
    nightFrom: 21.5,        // 21:30
    nightTo: 2,             // 到凌晨 2 点
    minGapMin: 0,           // 0 = 不卡间隔
    minTextBetween: 0,      // 0 = 不要求中间先打几条字
    chanceNight: 0.3,
    chanceCue: 0.35,
    chanceNormal: 0.04,
    chanceSpontaneous: 0.7,
  },
};

/** 他明确要听语音的几种说法。命中就不过节奏闸门、也不掷骰子。 */
const ASKED = /发.{0,4}(?:条|个|段)?\s*(?:语音|声音)|语音(?:消息|回复)?|听你(?:说|说话|声音)|想听你说|说句话|说两句|开麦/;

/** 让人心里软一下的词。命中就把"这一条要不要用声音"的概率抬高。 */
const CUE = /想你|想我|爱你|喜欢你|抱抱|晚安|好累|累了|难受|委屈|不开心|难过|压力|失眠|睡不着|哭了|陪我|在吗/;

const clamp = (v, lo, hi, def) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
};

/** 把一份（可能残缺、可能越界的）配置修成能用的。 */
function normalize(raw = {}) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const t = { ...DEFAULTS.tts, ...(r.tts && typeof r.tts === 'object' ? r.tts : {}) };
  const s = { ...DEFAULTS.stage, ...(r.stage && typeof r.stage === 'object' ? r.stage : {}) };

  t.endpoint = String(t.endpoint || DEFAULTS.tts.endpoint).trim() || DEFAULTS.tts.endpoint;
  // Key 只去首尾空白：它不是一个能"猜"的东西，填错了就让上游回 401，别在这里瞎改
  t.apiKey = String(t.apiKey || '').trim();
  t.timeoutMs = clamp(t.timeoutMs, 3000, 60000, DEFAULTS.tts.timeoutMs);
  t.speaker = String(t.speaker || DEFAULTS.tts.speaker).trim() || DEFAULTS.tts.speaker;
  t.resourceId = String(t.resourceId || DEFAULTS.tts.resourceId).trim() || DEFAULTS.tts.resourceId;
  t.format = t.format === 'wav' ? 'wav' : 'mp3';
  t.sampleRate = clamp(t.sampleRate, 8000, 48000, 24000);
  t.speechRate = clamp(t.speechRate, -50, 100, DEFAULTS.tts.speechRate);
  t.loudnessRate = clamp(t.loudnessRate, -50, 100, DEFAULTS.tts.loudnessRate);
  t.pitch = clamp(t.pitch, -12, 12, DEFAULTS.tts.pitch);
  t.emotion = String(t.emotion || '').trim();
  t.emotionScale = clamp(t.emotionScale, 1, 5, DEFAULTS.tts.emotionScale);
  t.maxChars = clamp(t.maxChars, 20, 200, DEFAULTS.tts.maxChars);

  const mix = Array.isArray(t.mix) ? t.mix : [];
  const clean = mix
    .filter((m) => m && m.speaker)
    .slice(0, 3)
    .map((m) => ({ speaker: String(m.speaker), factor: clamp(m.factor, 0, 100, 0) }))
    .filter((m) => m.factor > 0);
  t.mix = clean.length >= (t.speaker === 'custom_mix_bigtts' ? 2 : 0)
    ? clean
    : DEFAULT_MIX.map((m) => ({ ...m }));

  s.nightFrom = clamp(s.nightFrom, 0, 24, DEFAULTS.stage.nightFrom);
  s.nightTo = clamp(s.nightTo, 0, 24, DEFAULTS.stage.nightTo);
  s.minGapMin = clamp(s.minGapMin, 0, 24 * 60, DEFAULTS.stage.minGapMin);
  s.minTextBetween = clamp(s.minTextBetween, 0, 20, DEFAULTS.stage.minTextBetween);
  s.chanceNight = clamp(s.chanceNight, 0, 1, DEFAULTS.stage.chanceNight);
  s.chanceCue = clamp(s.chanceCue, 0, 1, DEFAULTS.stage.chanceCue);
  s.chanceNormal = clamp(s.chanceNormal, 0, 1, DEFAULTS.stage.chanceNormal);
  s.chanceSpontaneous = clamp(s.chanceSpontaneous, 0, 1, DEFAULTS.stage.chanceSpontaneous);

  return {
    // 默认开：只有**明确**写成 false 才算关（老配置里没有这个字段 = 开）
    enabled: r.enabled !== false,
    mode: r.mode === 'tag' ? 'tag' : 'auto',
    allowGroups: r.allowGroups === true,
    tts: t,
    stage: s,
  };
}

/** 本地日期（用于"今天发了几条"的统计；不是限额）。 */
function dayKey(at = Date.now()) {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function newState(at = Date.now()) {
  return { v: 1, day: dayKey(at), countToday: 0, lastVoiceAt: 0, lastTextAt: 0, textsSince: 99 };
}

/** 跨天了就把计数清零；其余字段原样。 */
function rollDay(state, at = Date.now()) {
  const s = state && typeof state === 'object' ? { ...state } : newState(at);
  const day = dayKey(at);
  if (s.day !== day) {
    s.day = day;
    s.countToday = 0;
  }
  return s;
}

/** 发了一条普通文字回复：离上一条语音又远了一步。 */
function noteText(state, at = Date.now()) {
  const s = rollDay(state, at);
  s.lastTextAt = at;
  s.textsSince = Math.min(999, Number(s.textsSince) || 0) + 1;
  return s;
}

/** 真的发出去一条语音。 */
function noteVoice(state, at = Date.now()) {
  const s = rollDay(state, at);
  s.lastVoiceAt = at;
  s.countToday = (Number(s.countToday) || 0) + 1;
  s.textsSince = 0;
  return s;
}

function hourFloat(at) {
  const d = new Date(at);
  return d.getHours() + d.getMinutes() / 60;
}

/** from/to 支持跨零点（21.5 → 2）。 */
function isNight(hour, from = 21.5, to = 2) {
  return from <= to ? (hour >= from && hour < to) : (hour >= from || hour < to);
}

function askedForVoice(text) {
  return ASKED.test(String(text || ''));
}

/**
 * 这一条要不要递话筒。
 *
 * @returns {{mode:'none'|'mixed'|'voice', why:string, p?:number}}
 *   · voice —— 整条都用说的（他要听 / 她自己想开口）
 *   · mixed —— 先说一句、再打字（夜里的由头）
 *   · none  —— 照常打字
 */
function decide({ voice, text = '', isGroup = false, unsolicited = false, now = Date.now(), state, rng = Math.random } = {}) {
  const v = normalize(voice);
  if (!v.enabled) return { mode: 'none', why: 'disabled' };
  // 没配 Key 就等于没有嗓子：不递话筒、不给提示，别让她以为说了就有人听见
  if (!v.tts.apiKey) return { mode: 'none', why: 'no-key' };
  if (isGroup && !v.allowGroups) return { mode: 'none', why: 'group' };

  const st = rollDay(state, now);
  if (askedForVoice(text)) return { mode: 'voice', why: 'asked' };

  /**
   * 节奏闸门默认全是 0（2026-11-01 用户："她想说就说，把间隔去掉"）。
   * 代码留着是为了以后想收紧时只改配置；`minGapMin=0` / `minTextBetween=0` 时
   * 这两条永远不成立，等于没有闸门。
   */
  if (!unsolicited) {
    const gapMin = (now - (Number(st.lastVoiceAt) || 0)) / 60000;
    if (v.stage.minGapMin > 0 && gapMin < v.stage.minGapMin) return { mode: 'none', why: 'gap', gapMin };
    if (v.stage.minTextBetween > 0 && (Number(st.textsSince) || 0) < v.stage.minTextBetween) {
      return { mode: 'none', why: 'rhythm', textsSince: Number(st.textsSince) || 0 };
    }
  }

  const night = isNight(hourFloat(now), v.stage.nightFrom, v.stage.nightTo);
  const cue = CUE.test(String(text || ''));
  let p = v.stage.chanceNormal;
  if (night) p = Math.max(p, v.stage.chanceNight);
  if (cue) p = Math.max(p, v.stage.chanceCue);
  if (unsolicited) p = Math.max(p, v.stage.chanceSpontaneous);

  if (rng() >= p) return { mode: 'none', why: night ? 'night-quiet' : 'quiet', p };
  return {
    mode: unsolicited ? 'voice' : 'mixed',
    why: unsolicited ? 'spontaneous' : (cue ? 'cue' : (night ? 'night' : 'chance')),
    p,
  };
}

/**
 * ★ 2026-11-01：递话筒时固定加的一句（下面 `promptFor` 用它）。
 *
 * 只陈述"声音是她的、已经通了"，并点名不要说那两件事 ——
 * 不写"别紧张""别道歉"这种泛泛的话，免得她开始表演"不紧张"。
 */
const VOICE_READY = '声音是你的，已经通了：别提"能不能发出去"，也别提"谁那边调没调好"，直接说你要说的。';

/**
 * 模型这一轮看到的技术提示。由能力注册表调用（`companion-capabilities.cjs`）。
 *
 * `voice` 模式**不让她写标记**：整条都是说的，她只管写话。
 * `mixed` 模式给死格式 —— 实测这种写法她 3/3 都跟。
 *
 * ★ 2026-11-01：**先给一句"声音是你的"，否则她会自己给语音打预防针**。
 *
 * 用户实测（`data\companion\turns.jsonl`，11-01 13:16 / 13:29 / 13:31 三条语音）：
 * 每条开头都是一句关于"语音到底能不能发"的交代 ——
 * 「语音那是它那头的事，我说得出它发不发得成，我也管不着」
 * 「语音这个我不太顺手，打字还行」
 * 「也得你这边先调好了才行」，然后才是内容。
 *
 * 根因不是语音坏了：那三条都合成成功、`陪伴：语音 →` 都发出去了。是**没人在提示里
 * 告诉她"嗓子已经是她的"** —— 她只能从 10-31～11-01 那段"他一直在调语音、有时收不到"
 * 的对话里推，于是把"发不发得成"当成了每次都得交代一遍的事。
 * 所以两种递话筒的提示里都明说：别提这些，直接说话。
 */
function promptFor(mode, maxChars = 120) {
  const n = Math.max(20, Number(maxChars) || 120);
  if (mode === 'voice') {
    return `【这条怎么发】整条用说的。${VOICE_READY}一两句，${n} 字以内；不要写 [语音] 这类标记。`;
  }
  if (mode === 'mixed') {
    return `【这条怎么发】先用语音说一句，再打字。${VOICE_READY}
格式必须是这样：
[语音]你要用声音说的那一句
然后另起一行，写你要打字的内容。
语音那一句一两句、${n} 字以内；不要写"好的"。`;
  }
  return `【语音】你想用声音说话的时候，在那一行开头写 [语音]，后面接要说的话；其余照常打字。`;
}

/**
 * 把 TTS 不该念的东西去掉：标记、CQ 码、链接、Markdown、括号里的动作、emoji。
 * 换行并成逗号（语音是一条，不是分条）。
 */
function cleanForSpeech(text) {
  let s = String(text || '').replace(/\r\n?/g, '\n');
  s = s.replace(/[\[【](?:语音|表情|收藏|手机|时间|图片|戳一戳)[^\]】]*[\]】]/g, ' ');
  s = s.replace(/\[CQ:[^\]]*\]/g, ' ');
  s = s.replace(/https?:\/\/\S+/g, ' ');
  s = s.replace(/[*_`#>|~]/g, ' ');
  s = s.replace(/（[^）]{0,24}）/g, ' ');
  s = s.replace(/\([^)]{0,24}\)/g, ' ');
  s = s.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}]/gu, '');
  s = s.replace(/\n+/g, '，').replace(/\s+/g, ' ');
  s = s.replace(/[，,]{2,}/g, '，');
  s = s.replace(/\s+([，。！？、；：])/g, '$1');
  s = s.replace(/^[，。！？、；：\s]+|[，。！？、；：\s]+$/g, '');
  return s.trim();
}

/** 去掉行首/行中的 [语音] 标记，留给"退回文字"用。 */
function stripTags(text) {
  return String(text || '').replace(/[\[【]语音[\]】]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * 把"她已经分好的几条"变成"哪条说、哪条打"。
 *
 * @param {string[]} parts  `companion-humanize.split()` 切好的若干条
 * @param {'none'|'mixed'|'voice'} mode  这一轮递话筒的方式
 * @returns {{segments:Array<{kind:'text'|'voice',text:string,speak?:string}>, voice:number, text:string, why:string}}
 */
function buildSegments(parts, mode = 'none', { maxVoice = 2, maxChars = 120, allowVoice = true } = {}) {
  const list = (Array.isArray(parts) ? parts : [parts]).map((s) => String(s || '').trim()).filter(Boolean);
  if (!list.length) return { segments: [], voice: 0, text: '', why: 'empty' };

  /** 语音功能没开：`[语音]` 只当普通文字摘掉，绝不合成/发送。 */
  if (!allowVoice) {
    const segs = list.map((t) => ({ kind: 'text', text: stripTags(t) })).filter((s) => s.text);
    return { segments: segs, voice: 0, text: segs.map((s) => s.text).join('\n'), why: 'disabled' };
  }

  /** 整条都说：把她的几条并成一条语音（换行变逗号，不然 TTS 会一顿一顿）。 */
  if (mode === 'voice') {
    const all = stripTags(list.join('，'));
    const speak = cleanForSpeech(all);
    if (!speak || [...speak].length > maxChars) {
      // 念不了就按她原来的分条退回文字，别把几条并成一大段
      const segs = list.map((t) => ({ kind: 'text', text: stripTags(t) })).filter((s) => s.text);
      return { segments: segs, voice: 0, text: segs.map((s) => s.text).join('\n'), why: 'too-long' };
    }
    return { segments: [{ kind: 'voice', text: all, speak }], voice: 1, text: all, why: 'voice' };
  }

  const segs = [];
  const voiceCount = () => segs.reduce((n, s) => n + (s.kind === 'voice' ? 1 : 0), 0);
  for (const line of list) {
    const m = line.match(/^[\[【]语音[\]】]\s*([\s\S]*)$/);
    if (m && m[1].trim() && voiceCount() < maxVoice) {
      segs.push({ kind: 'voice', text: m[1].trim(), speak: cleanForSpeech(m[1]) });
    } else {
      const t = stripTags(line);
      if (t) segs.push({ kind: 'text', text: t });
    }
  }

  /**
   * 递了话筒但她没写标记：把第一行当语音、后面的照发文字。
   * 只在她确实分了两行以上、第一行不像小作文时这么做 —— 否则整条打字更稳。
   */
  let why = mode;
  if (mode === 'mixed' && voiceCount() === 0 && list.length >= 2) {
    const first = cleanForSpeech(list[0]);
    if (first && [...first].length <= Math.min(80, maxChars)) {
      const rest = list.slice(1).map(stripTags).filter(Boolean);
      const rebuilt = [{ kind: 'voice', text: list[0], speak: first }];
      if (rest.length) rebuilt.push({ kind: 'text', text: rest.join('\n') });
      return { segments: rebuilt, voice: 1, text: [list[0], ...rest].join('\n'), why: 'auto-split' };
    }
  }

  /** 太长/空了的语音段退回文字，别让 QQ 里出现一条念一半的语音。 */
  const out = [];
  for (const s of segs) {
    if (s.kind !== 'voice') { out.push(s); continue; }
    const n = [...(s.speak || '')].length;
    if (!n || n > maxChars) {
      const t = stripTags(s.text);
      if (t) out.push({ kind: 'text', text: t });
      why = 'too-long';
      continue;
    }
    out.push(s);
  }
  return {
    segments: out,
    voice: out.reduce((n, s) => n + (s.kind === 'voice' ? 1 : 0), 0),
    text: out.map((s) => s.text).join('\n'),
    why,
  };
}

/**
 * 火山 v3 `/tts/unidirectional` 的请求体（2026-11-01 从预览台搬过来，字段逐个对齐）。
 *
 * 注意混音：只有 1.0 音色支持，`speaker` 固定 `custom_mix_bigtts`，比例要**小数**
 * （0.4 / 0.2 / 0.4），不是配置里那种 40/20/40 的整数权重。
 */
function requestBody(voice, text) {
  const t = normalize(voice).tts;
  const audio_params = {
    format: t.format,
    sample_rate: t.sampleRate,
    speech_rate: t.speechRate,
    loudness_rate: t.loudnessRate,
  };
  if (t.emotion) {
    audio_params.emotion = t.emotion;
    audio_params.emotion_scale = t.emotionScale;
  }
  const req_params = { text: String(text || ''), speaker: t.speaker, audio_params };
  // 音调（+2）走 additions.post_process，和预览台完全一样
  if (Number(t.pitch)) req_params.additions = JSON.stringify({ post_process: { pitch: Number(t.pitch) } });

  if (t.speaker === 'custom_mix_bigtts' && t.mix.length >= 2) {
    const total = t.mix.reduce((a, m) => a + m.factor, 0) || 1;
    req_params.speaker = 'custom_mix_bigtts';
    /**
     * 上游要的是加起来**等于 1** 的小数（1.0 才支持混音）。
     *
     * ★ 2026-11-01：**最后一位用余数补平**（以前注释这么写、代码没做）。
     * 每项单独四舍五入的话，1/1/1 会算出 0.3333×3 = 0.9999，上游直接拒
     * （默认 40/20/40 恰好是 1.0，所以这个坑一直没露头）。
     */
    const factors = t.mix.map((m) => Number((m.factor / total).toFixed(4)));
    const used = factors.slice(0, -1).reduce((a, v) => a + v, 0);
    factors[factors.length - 1] = Number((1 - used).toFixed(4));
    req_params.mix_speaker = {
      speakers: t.mix.map((m, i) => ({ source_speaker: m.speaker, mix_factor: factors[i] })),
    };
  }
  return { user: { uid: t.uid }, req_params };
}

/** 上游的请求头。`X-Api-Resource-Id` 决定用 1.0 还是 2.0。 */
function requestHeaders(voice) {
  const t = normalize(voice).tts;
  return {
    'content-type': 'application/json',
    'X-Api-Key': t.apiKey,
    'X-Api-Resource-Id': t.resourceId,
    'X-Api-Request-Id': crypto.randomUUID(),
    'X-Api-Connect-Id': crypto.randomUUID(),
    'X-Control-Require-Usage-Tokens-Return': '*',
  };
}

/**
 * 上游回的是「一行一个 JSON」的流：有些行只是 `{code,message}`，音频在 `data` 里（base64）。
 * 也兼容整体就是一个 JSON 的情况（报错时）。
 * @returns {{audio: Buffer[], codes:string[], message:string, sentences:string[]}}
 */
function parseUpstream(text) {
  const out = { audio: [], codes: [], message: '', sentences: [] };
  const body = String(text || '').trim();
  if (!body) return out;
  const lines = body.includes('\n') ? body.split('\n') : [body];
  for (const line of lines) {
    const s = line.trim();
    if (!s) continue;
    let o = null;
    try { o = JSON.parse(s); } catch { continue; }
    if (o.header) {
      if (o.header.code !== undefined) out.codes.push(String(o.header.code));
      if (o.header.message) out.message = out.message || String(o.header.message);
      continue;
    }
    if (o.code !== undefined) out.codes.push(String(o.code));
    if (o.message) out.message = out.message || String(o.message);
    if (o.data) out.audio.push(Buffer.from(String(o.data), 'base64'));
    if (o.sentence) out.sentences.push(String(o.sentence));
  }
  return out;
}

/**
 * ★ 2026-11-01 真机实测（不是推理）：她"明明想发语音却发不出去"的真凶在这里。
 *
 * 预览台把上游**一句一段**回来的音频直接 `Buffer.concat` 了，而每一段都自带一个
 * ID3v2 头。一句话只有一段 → 拼完是正常 mp3（2.56 秒那条就是这样发出去的）；
 * 两句话就有两段 → 文件中间又冒出一个 "ID3"，NapCat 转 silk 用的那个 ffmpeg 读到
 * 中间这个头就直接 `Failed to send audio packet: Invalid data found when processing input`，
 * 整条语音发不出去，`deliverToChat()` 只好退回文字。
 *
 * 这里只摘掉**从第二段起**的 ID3 头，音频帧一个字节都不动。同一段 14.2 秒录音：
 * 原样发 → 失败；摘掉中间那个头 → 一次发成功（`message_id` 正常返回）。
 */
function id3LengthAt(buf, i) {
  if (i < 0 || i + 10 > buf.length) return 0;
  if (buf[i] !== 0x49 || buf[i + 1] !== 0x44 || buf[i + 2] !== 0x33) return 0; // "ID3"
  const major = buf[i + 3];
  if (major < 2 || major > 4 || buf[i + 4] !== 0) return 0;
  const size = ((buf[i + 6] & 0x7f) << 21) | ((buf[i + 7] & 0x7f) << 14)
    | ((buf[i + 8] & 0x7f) << 7) | (buf[i + 9] & 0x7f);
  const end = i + 10 + size;
  if (size <= 0 || end > buf.length) return 0;
  // 头后面必须紧跟一个 mp3 帧同步字，才认它是"拼进来的"那个头 ——
  // 免得把音频数据里偶然出现的 ID3 三个字母当成标签剪掉。
  if (end + 1 < buf.length && buf[end] === 0xff && (buf[end + 1] & 0xe0) === 0xe0) return 10 + size;
  return 0;
}

/**
 * 把合成回来的 base64 洗成"只有一个 ID3 头"的干净 mp3。
 * wav 没有帧的概念、本来就干净的一律原样返回（`stripped: 0`）。
 * @returns {{audio:string, stripped:number}}
 */
function cleanAudioBase64(base64, { format = 'mp3' } = {}) {
  const audio = String(base64 || '');
  if (!audio || format !== 'mp3') return { audio, stripped: 0 };
  const buf = Buffer.from(audio, 'base64');
  if (buf.length < 16) return { audio, stripped: 0 };
  const keep = [];
  let from = 0;
  let stripped = 0;
  for (let i = 1; i < buf.length - 10; i++) {
    if (buf[i] !== 0x49) continue;
    const len = id3LengthAt(buf, i);
    if (!len) continue;
    keep.push(buf.subarray(from, i));
    from = i + len;
    stripped += 1;
    i = from - 1;
  }
  if (!stripped) return { audio, stripped: 0 };
  keep.push(buf.subarray(from));
  return { audio: Buffer.concat(keep).toString('base64'), stripped };
}

/**
 * 合成一句话（直连火山 1.0，2026-11-01 起不再经过 7860 预览台）。
 * @returns {Promise<{ok:boolean, audio?:string, bytes?:number, ms?:number, mime?:string, text?:string, id3Stripped?:number, error?:string}>}
 */
async function synthesize(voice, text, { fetchImpl = fetch } = {}) {
  const v = normalize(voice);
  const spoken = cleanForSpeech(text);
  if (!spoken) return { ok: false, error: '没有可念的字' };
  if (!v.tts.apiKey) return { ok: false, error: '还没填火山 API Key（「音色」窗口 → 她的声音 → 高级）' };
  const t0 = Date.now();
  let res;
  let raw = '';
  try {
    res = await fetchImpl(v.tts.endpoint, {
      method: 'POST',
      headers: requestHeaders(v),
      body: JSON.stringify(requestBody(v, spoken)),
      signal: AbortSignal.timeout(v.tts.timeoutMs),
    });
    raw = await res.text();
  } catch (err) {
    const why = err?.name === 'TimeoutError'
      ? `语音合成等太久了（${Math.round(v.tts.timeoutMs / 1000)} 秒）`
      : (err?.cause?.code === 'ENOTFOUND'
        ? '连不上火山（检查网络 / 代理）'
        : `连不上火山 ${v.tts.endpoint}（${err.message}）`);
    return { ok: false, error: why };
  }
  const ms = Date.now() - t0;
  const parsed = parseUpstream(raw);
  if (!res.ok || !parsed.audio.length) {
    const why = parsed.message
      || (raw || '').replace(/\s+/g, ' ').slice(0, 140)
      || `HTTP ${res.status}`;
    return { ok: false, error: `语音合成失败：${why}${parsed.codes.length ? `（code ${parsed.codes.join('/')}）` : ''}` };
  }
  const clean = cleanAudioBase64(Buffer.concat(parsed.audio).toString('base64'), { format: v.tts.format });
  return {
    ok: true,
    audio: clean.audio,
    bytes: Buffer.from(clean.audio, 'base64').length,
    ms,
    mime: v.tts.format === 'wav' ? 'audio/wav' : 'audio/mpeg',
    text: spoken,
    id3Stripped: clean.stripped,
  };
}

/**
 * 能不能发语音。只看**本地**（有没有 Key），不联网、不花钱、不等 2.5 秒超时。
 * 真连不上火山时由 `synthesize()` 报那句人话，界面上照样看得到。
 */
async function probe(voice) {
  const v = normalize(voice);
  if (!v.tts.apiKey) return { ok: false, why: '还没填火山 API Key（「音色」窗口 → 她的声音 → 高级）' };
  if (!/^https?:\/\//i.test(v.tts.endpoint)) return { ok: false, why: `接口地址不对：${v.tts.endpoint}` };
  return { ok: true, keyed: true, endpoint: v.tts.endpoint, resourceId: v.tts.resourceId };
}

module.exports = {
  DEFAULTS, DEFAULT_MIX, ASKED, CUE,
  normalize, dayKey, newState, rollDay, noteText, noteVoice,
  hourFloat, isNight, askedForVoice, decide, promptFor,
  cleanForSpeech, stripTags, buildSegments,
  requestBody, requestHeaders, parseUpstream, synthesize, probe,
  id3LengthAt, cleanAudioBase64,
};
