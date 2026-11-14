/**
 * 她的耳朵 —— 用**火山方舟 `doubao-seed-2-1-lite` 的音频理解**把语音转成文字 + 语气。
 *
 * 2026-11-02 新加。用户刚在 `http://localhost:8777/` 那个测试页上把这条路验通：
 * 录音 → 16k 单声道 WAV → Ark `chat/completions` 的 `input_audio` → 模型照提示词回 JSON。
 *
 * 这一支要同时喂两条路（所以独立成一个模块，别塞进 companion.cjs / pet.cjs）：
 *   · **QQ**：`get_record` 把语音条转成 mp3 → 这里转写 → 当成他"说"的话交给大脑；
 *   · **桌宠**：麦克风 16k PCM → 本文件末尾的 `MicAsr` 按"静音 ≥700ms"分段 → 这里转写。
 *
 * 三个设计约束（都是被上游行为逼出来的）：
 *   1. **不是流式**：Ark 一次吃一整段音频。所以麦克风必须自己切句（VAD），QQ 那边本来就是一个文件。
 *   2. **转写要"榨干"**：默认提示词要求逐字转写（含口头禅/停顿/没听清的字）+ 情绪/语气/语速/音量/
 *      背景声/一句话概括。她回话时用得上"他是什么语气说的"，而不只是字面。
 *   3. **配置单独一个文件**：`config/voice-asr.json`。`companion.json` 那边有它自己的保存逻辑，
 *      两边都写同一个文件的话，谁后保存谁把对方刚改的 Key 静默顶掉。
 *
 * 自检：`test/regions/21-voice-asr.cjs`（纯逻辑，不联网；`transcribe` 接受假 `fetch`）。
 */
const path = require('node:path');
const llm = require('./llm.cjs');
const store = require('./store.cjs');

/** ASR 的配置文件（和 companion.json / settings.json 分开，见文件头第 3 条）。 */
const CONFIG_FILE = path.join(llm.CONFIG_DIR, 'voice-asr.json');

/** 测试页上验通的那一套（2026-11-02）。Key 留空，由部署时写进 config\voice-asr.json。 */
const DEFAULTS = {
  enabled: true,
  ark: {
    endpoint: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions',
    /**
     * 方舟的 API Key。**别把 Key 写死在这个文件里**（仓库会同步到 GitHub）——
     * 部署时写进 `config\voice-asr.json`，或者以后在「音色」窗口里填。
     */
    apiKey: '',
    /** 测试页验通的模型 ID。报"模型不存在"就换成控制台的 `ep-xxxx` 接入点。 */
    model: 'doubao-seed-2-1-lite-260915',
    timeoutMs: 90000,
    /** 深度思考：更细但慢约 20 秒。默认关（听一句话不值得等 20 秒）。 */
    thinking: false,
    temperature: 0.1,
  },
  /**
   * 收到语音之后怎么回（QQ 那条路）。
   *   · free   —— **她自己决定**（默认）：用户 2026-11-02 明确说过"我用 QQ 发的语音，
   *               她回文字还是回语音全凭她自己意愿"。所以这里**不强制**，照旧按
   *               `companion-voice.decide()` 的递话筒 + 她自己写的 `[语音]` 走。
   *   · always —— 每条都用语音回（"语音对讲 / 打电话"那种模式；OneBot 没有真正的
   *               通话接口，只能一来一回地发语音条）。
   *   · never  —— 她永远打字回。
   */
  reply: { voice: 'free' },
  /** 麦克风分句（桌宠那条路）。阈值是 int16 归一化后的 RMS，0~1。 */
  mic: {
    threshold: 0.01,
    silenceMs: 700,
    minSpeechMs: 350,
    maxSegmentMs: 20000,
    prerollMs: 250,
  },
  /** QQ 语音条：一轮最多听几条、单条最多多少字节（Ark 的 base64 上限按 34MB 算）。 */
  qq: { maxRecords: 2, maxBytes: 12 * 1024 * 1024 },
};

const SAMPLE_RATE = 16000;
const clamp = (v, lo, hi, def) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
};

/** 把一份（可能残缺/越界的）配置修成能用的。 */
function normalize(raw = {}) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const a = { ...DEFAULTS.ark, ...(r.ark && typeof r.ark === 'object' ? r.ark : {}) };
  const m = { ...DEFAULTS.mic, ...(r.mic && typeof r.mic === 'object' ? r.mic : {}) };
  const q = { ...DEFAULTS.qq, ...(r.qq && typeof r.qq === 'object' ? r.qq : {}) };

  a.endpoint = String(a.endpoint || DEFAULTS.ark.endpoint).trim() || DEFAULTS.ark.endpoint;
  a.apiKey = String(a.apiKey || '').trim();
  a.model = String(a.model || DEFAULTS.ark.model).trim() || DEFAULTS.ark.model;
  a.timeoutMs = clamp(a.timeoutMs, 5000, 300000, DEFAULTS.ark.timeoutMs);
  a.thinking = a.thinking === true;
  a.temperature = clamp(a.temperature, 0, 1, DEFAULTS.ark.temperature);

  m.threshold = clamp(m.threshold, 0.001, 0.2, DEFAULTS.mic.threshold);
  m.silenceMs = clamp(m.silenceMs, 200, 5000, DEFAULTS.mic.silenceMs);
  m.minSpeechMs = clamp(m.minSpeechMs, 100, 10000, DEFAULTS.mic.minSpeechMs);
  m.maxSegmentMs = clamp(m.maxSegmentMs, 2000, 120000, DEFAULTS.mic.maxSegmentMs);
  m.prerollMs = clamp(m.prerollMs, 0, 1500, DEFAULTS.mic.prerollMs);

  q.maxRecords = clamp(q.maxRecords, 1, 5, DEFAULTS.qq.maxRecords);
  q.maxBytes = clamp(q.maxBytes, 200_000, 30 * 1024 * 1024, DEFAULTS.qq.maxBytes);

  return {
    enabled: r.enabled !== false,
    ark: a,
    reply: { voice: ['free', 'always', 'never'].includes(r.reply?.voice) ? r.reply.voice : DEFAULTS.reply.voice },
    mic: m,
    qq: q,
  };
}

/** 读配置（每次现读：改完 `config\voice-asr.json` 不用重启）。 */
function settings() {
  return normalize(store.readJson(CONFIG_FILE) || {});
}

/** 深合并 + 落盘（设置页/脚本改 Key 用）。返回写进去的完整配置。 */
function save(patch = {}) {
  const base = store.readJson(CONFIG_FILE) || {};
  const merged = normalize(merge(base, patch || {}));
  const err = store.writeJson(CONFIG_FILE, merged);
  if (err) throw err;
  return merged;
}

function merge(a, b) {
  if (!b || typeof b !== 'object') return b === undefined ? a : b;
  const out = Array.isArray(a) ? [...a] : { ...(a && typeof a === 'object' ? a : {}) };
  for (const [k, v] of Object.entries(b)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? merge(out[k], v) : v;
  }
  return out;
}

/** 有没有能用的 Key（本地判断：不联网、不花钱）。 */
function ready(cfg) {
  const c = cfg && cfg.ark ? cfg : normalize(cfg);
  return !!(c.enabled && c.ark.apiKey);
}

/**
 * 给模型的"榨干"提示词。
 *
 * `detail` 越大越啰嗦；`context` 可以塞一句"这是 QQ 里发来的、他那头可能有嘈杂声"，
 * 让它别把背景电视声当成他说的字。
 */
function buildPrompt({ detail = true, context = '' } = {}) {
  const ctx = String(context || '').trim();
  const head = `你在替一个桌宠"听懂"主人发来的一段语音。${ctx ? `背景：${ctx}。` : ''}`;
  if (!detail) {
    return `${head}只输出一个 JSON：{"text":"逐字转写","emotion":"情绪","tone":"语气"}`;
  }
  return `${head}
请把这段音频**完整、逐字**转写成文字，再判断他是怎么说的。只输出一个 JSON 对象，不要 markdown 代码块，不要任何解释：
{"text":"逐字转写","emotion":"情绪档位","tone":"语气的一句话描述","rate":"语速","volume":"音量","background":"背景声","summary":"一句话概括","uncertain":["听不准的词"]}
要求：
1. text 必须完整，不要把转写换成概括；口头禅（嗯/那个/就是）、语气词、结巴都要保留；停顿时写「…」；真的听不清的字写「□」，不要猜着补。
2. 方言、口音按**发音**写，不要"纠正"成书面语；中英混说就照原样混着写。
3. 如果是在唱歌，text 以「[唱]」开头；有笑声/叹气/哭腔，在 tone 里说。
4. emotion 只能是这几个之一：高兴 / 平静 / 难过 / 生气 / 焦急 / 疲惫 / 撒娇 / 无奈 / 惊讶 / 害羞 / 其他。
5. rate 只能是：很慢 / 偏慢 / 正常 / 偏快 / 很快。volume 只能是：很小 / 偏小 / 正常 / 偏大 / 很大。
6. background 写实际听到的（如"电视声""风声""键盘声"），没有就写"无"。
7. summary 用一句话说他**想干什么**（例："让我早点睡"），不要复述原文。
8. 音频里没有人说话、或噪声太大听不出内容时，text 留空字符串，emotion 写"其他"，tone 写"听不清"。`;
}

/** 一次请求的 body（测试页那一套，字段逐个对齐）。 */
function buildBody(cfg, { audio, format = 'mp3', prompt } = {}) {
  const c = cfg && cfg.ark ? cfg : normalize(cfg);
  const body = {
    model: c.ark.model,
    temperature: c.ark.temperature,
    messages: [{
      role: 'user',
      content: [
        { type: 'input_audio', input_audio: { data: String(audio || ''), format: String(format || 'mp3').replace(/^\./, '') } },
        { type: 'text', text: String(prompt || buildPrompt()) },
      ],
    }],
  };
  // 测试页量过：默认会先"想"，小 max_tokens 时内容为空 —— 除非明确要深度思考，一律关掉
  if (!c.ark.thinking) body.thinking = { type: 'disabled' };
  return body;
}

/** 去掉模型偶尔包的 ```json 围栏，并压掉多余空白。 */
function cleanText(s) {
  return String(s || '')
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
}

/**
 * 把模型回的那段文本解析成我们要的字段。
 * 模型不听话（没给 JSON / JSON 坏了）时**退回"整段就是转写"** —— 宁可丢语气，不能丢话。
 */
function parseModelText(raw) {
  const text = cleanText(raw);
  const out = { text: '', emotion: '', tone: '', rate: '', volume: '', background: '', summary: '', uncertain: [], raw: text };
  if (!text) return out;

  const body = (() => {
    try { return JSON.parse(text); } catch { /* 下面再试 */ }
    const i = text.indexOf('{');
    const j = text.lastIndexOf('}');
    if (i >= 0 && j > i) {
      try { return JSON.parse(text.slice(i, j + 1)); } catch { /* 真坏了 */ }
    }
    return null;
  })();

  if (body && typeof body === 'object') {
    const pick = (...keys) => {
      for (const k of keys) {
        const v = body[k];
        if (typeof v === 'string' && v.trim()) return v.trim();
      }
      return '';
    };
    out.text = pick('text', 'transcript', 'content', '转写', '文本');
    out.emotion = pick('emotion', '情绪');
    out.tone = pick('tone', '语气');
    out.rate = pick('rate', '语速');
    out.volume = pick('volume', '音量');
    out.background = pick('background', '背景声', 'background_noise');
    out.summary = pick('summary', '概括', 'gist');
    const unc = body.uncertain ?? body['听不准的词'];
    out.uncertain = Array.isArray(unc) ? unc.map((x) => String(x)).filter(Boolean).slice(0, 20) : [];
    // JSON 里 text 是空的（没人说话）时，不要把整段 JSON 当转写
    return out;
  }

  // 不是 JSON：整段就是转写
  out.text = text;
  return out;
}

/**
 * 真正去转写一段音频。
 *
 * @param {object} cfg  `normalize()` 的结果（也接受原始配置）
 * @param {{audio:string, format?:string, prompt?:string, fetchImpl?:Function, context?:string}} opts
 * @returns {Promise<{ok:boolean, text?:string, emotion?:string, tone?:string, rate?:string,
 *   volume?:string, background?:string, summary?:string, uncertain?:string[], ms?:number,
 *   usage?:object, raw?:string, error?:string}>}
 */
async function transcribe(cfg, { audio, format = 'mp3', prompt, fetchImpl = null, context = '' } = {}) {
  const c = cfg && cfg.ark ? cfg : normalize(cfg);
  if (!c.enabled) return { ok: false, error: '语音识别功能关着（config\\voice-asr.json → enabled）' };
  if (!c.ark.apiKey) return { ok: false, error: '还没填方舟 API Key（config\\voice-asr.json → ark.apiKey）' };
  const data = String(audio || '');
  if (!data) return { ok: false, error: '没有收到音频' };
  if (data.length * 0.75 > c.qq.maxBytes) {
    return { ok: false, error: `音频太大（约 ${Math.round(data.length * 0.75 / 1024 / 1024)}MB）` };
  }

  const f = typeof fetchImpl === 'function' ? fetchImpl : fetch;
  const t0 = Date.now();
  let res;
  let raw = '';
  try {
    res = await f(c.ark.endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${c.ark.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(buildBody(c, { audio: data, format, prompt: prompt || buildPrompt({ context }) })),
      signal: AbortSignal.timeout(c.ark.timeoutMs),
    });
    raw = await res.text();
  } catch (err) {
    const why = err?.name === 'TimeoutError'
      ? `语音识别等太久了（${Math.round(c.ark.timeoutMs / 1000)} 秒）`
      : (err?.cause?.code === 'ENOTFOUND' ? '连不上方舟（检查网络 / 代理）' : `连不上方舟（${err.message}）`);
    return { ok: false, error: why };
  }
  const ms = Date.now() - t0;

  let payload = null;
  try { payload = JSON.parse(raw); } catch { /* 下面报 */ }
  if (!payload) return { ok: false, error: '方舟返回的不是 JSON', detail: raw.slice(0, 600), ms };

  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    const err = payload?.error;
    const why = err ? `${err.code || ''} ${err.message || ''}`.trim() : `HTTP ${res.status}`;
    return { ok: false, error: `语音识别失败：${why}`, detail: raw.slice(0, 1200), ms };
  }

  const parsed = parseModelText(content);
  return {
    ok: true,
    ...parsed,
    ms,
    usage: payload.usage || null,
    model: payload.model || c.ark.model,
  };
}

/**
 * "他是用语音说的，听起来…" —— 只取语气的那一小句（不含转写本身，转写已经在正文里了）。
 * 桌宠那条路把它拼进 `ask()` 的处境，QQ 那条路用 `companion.cjs` 的 `voiceSituation`。
 */
function toneNote(r) {
  const bits = [];
  if (r?.emotion && !['平静', '其他'].includes(r.emotion)) bits.push(r.emotion);
  if (r?.tone) bits.push(r.tone);
  if (r?.rate && r.rate !== '正常') bits.push(`语速${r.rate}`);
  if (r?.volume && r.volume !== '正常') bits.push(`音量${r.volume}`);
  if (r?.background && r.background !== '无') bits.push(`背景有${r.background}`);
  return bits.length ? `（他是用语音说的，听起来：${bits.join('、')}）` : '（他是用语音说的）';
}

/** 给人看的一句话（写日志 / 塞进处境都用它）。 */
function describe(r, { maxChars = 180 } = {}) {  if (!r || !r.ok) return '';
  const bits = [];
  if (r.emotion && r.emotion !== '平静') bits.push(r.emotion);
  if (r.tone) bits.push(r.tone);
  if (r.rate && r.rate !== '正常') bits.push(`语速${r.rate}`);
  if (r.volume && r.volume !== '正常') bits.push(`音量${r.volume}`);
  if (r.background && r.background !== '无') bits.push(`背景有${r.background}`);
  const text = String(r.text || '').trim();
  if (!text) return `（语音里没听清内容${bits.length ? `；${bits.join('、')}` : ''}）`;
  const cut = [...text].length > maxChars ? `${[...text].slice(0, maxChars).join('')}…` : text;
  return bits.length ? `（语音：${cut}｜听起来${bits.join('、')}）` : `（语音：${cut}）`;
}

/** int16 PCM → 16k 单声道 WAV（Ark 的 input_audio 直接吃 base64 wav）。 */
function pcm16ToWav(pcm, sampleRate = SAMPLE_RATE) {
  const src = Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm || []);
  const size = src.length - (src.length % 2);          // 半截采样不要
  const buf = Buffer.alloc(44 + size);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + size, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);                            // fmt 块大小
  buf.writeUInt16LE(1, 20);                             // PCM
  buf.writeUInt16LE(1, 22);                             // 单声道
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);                // byte rate
  buf.writeUInt16LE(2, 32);                             // block align
  buf.writeUInt16LE(16, 34);                            // 位深
  buf.write('data', 36);
  buf.writeUInt32LE(size, 40);
  src.copy(buf, 44, 0, size);
  return buf;
}

/** 一段 int16 PCM 的 RMS（0~1）。VAD 的唯一判据。 */
function rms(pcm) {
  const buf = Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm || []);
  const n = Math.floor(buf.length / 2);
  if (!n) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const s = buf.readInt16LE(i * 2) / 32768;
    sum += s * s;
  }
  return Math.sqrt(sum / n);
}

/** 一段音频的首部特征（QQ 那边 `get_record` 偶尔只给 url 时用）。 */
function sniffAudioFormat(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
  if (b.length < 4) return '';
  if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) return 'mp3';            // ID3
  if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return 'mp3';                   // 帧同步
  if (b.slice(0, 4).toString('latin1') === 'RIFF') return 'wav';
  if (b.slice(0, 4).toString('latin1') === 'OggS') return 'ogg';
  if (b.slice(4, 8).toString('latin1') === 'ftyp') return 'm4a';
  if (b.slice(0, 5).toString('latin1') === '#!AMR') return 'amr';
  if (b[0] === 0x02 && b.slice(1, 9).toString('latin1') === '#!SILK_V') return 'silk';
  if (b.slice(0, 3).toString('latin1') === 'ID3') return 'mp3';
  return '';
}

/**
 * 麦克风的"切句器"。
 *
 * 页面把 16k 单声道 int16 PCM 一小块一小块送进来（`mic-worklet.js`，约 64ms 一块）。
 * 这里不联网、不碰 UI，只做三件事：
 *   ① 攒 250ms 的"预录"，这样开口第一个字不会被切掉；
 *   ② 声音停下 ≥ `silenceMs` 就把这一段吐出去（`onSegment`）；
 *   ③ 太长（`maxSegmentMs`）强制断开，免得一个人说个不停永远不吐。
 *
 * 为什么要自己切：`doubao-seed-2-1-lite` **不是流式**，一次只吃一整段音频。
 * 所以"实时的感觉"全靠这里切得好（用户 2026-11-02："可能需要分段式识别，这个不是流式模型"）。
 */
class MicAsr {
  constructor({ asr, onPhase, onSegment, onError, now = () => Date.now() } = {}) {
    this.cfg = asr && asr.mic ? asr : normalize(asr);
    this.onPhase = onPhase || (() => {});
    this.onSegment = onSegment || (() => {});
    this.onError = onError || (() => {});
    this.now = now;
    this.reset();
  }

  reset() {
    this.frames = [];          // 当前这一段（含预录）
    this.pre = [];             // 开口前的滚动预录
    this.preMs = 0;
    this.speaking = false;
    this.startedAt = 0;
    this.lastVoiceAt = 0;
    this.speechMs = 0;
    this.muteUntil = 0;
  }

  /** 她那句语音还在放：这段时间的麦克风一律当噪声（防自问自答）。 */
  muteFor(ms) {
    this.muteUntil = Math.max(this.muteUntil, this.now() + Math.max(0, Number(ms) || 0));
    this.#drop();
  }

  /**
   * ★ 2026-11-02：页面上那卷音频**真的放完了**（`{t:'voiceEnd'}`）——立刻把耳朵放开。
   * `muteFor()` 给的只是按字数估的"最多捂这么久"，估长了会让她听完还愣半秒。
   */
  unmute() {
    this.muteUntil = 0;
  }

  /** 外部打断（比如她开始说话）：把半句丢掉。 */
  cancel() {
    this.#drop();
    this.onPhase({ phase: 'none' });
  }

  /** 手动结束当前这一段（页面上的"长按说完"）。 */
  commit() {
    if (!this.speaking) return false;
    return this.#emit('commit');
  }

  #drop() {
    this.frames = [];
    this.pre = [];
    this.preMs = 0;
    this.speaking = false;
    this.speechMs = 0;
    this.startedAt = 0;
  }

  #emit(why) {
    const ms = this.frames.reduce((n, f) => n + f.ms, 0);
    const pcm = Buffer.concat(this.frames.map((f) => f.buf));
    const long = Number(this.speechMs) || 0;
    this.#drop();
    if (long < this.cfg.mic.minSpeechMs || ms < 200) {
      this.onPhase({ phase: 'none' });
      return false;
    }
    this.onPhase({ phase: 'segment', ms, why });
    try {
      this.onSegment(pcm, { ms, why, speechMs: long, wav: pcm16ToWav(pcm, SAMPLE_RATE) });
    } catch (err) { this.onError(err); }
    return true;
  }

  /**
   * 送一块 PCM 进来。
   * @param {Buffer} pcm 16k / 单声道 / int16le
   * @param {number} [at]
   * @returns {{level:number, speaking:boolean}}
   */
  push(pcm, at = this.now()) {
    const buf = Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm || []);
    if (buf.length < 2) return { level: 0, speaking: false };
    const ms = (buf.length / 2 / SAMPLE_RATE) * 1000;
    if (at < this.muteUntil) { if (this.speaking) this.#drop(); return { level: 0, speaking: false }; }

    const level = rms(buf);
    const thr = this.cfg.mic.threshold;

    // 正在说：续上
    if (this.speaking) {
      this.frames.push({ buf, ms });
      if (level >= thr * 0.55) {
        this.lastVoiceAt = at;
        this.speechMs += ms;
      }
      const total = this.frames.reduce((n, f) => n + f.ms, 0);
      if (at - this.lastVoiceAt >= this.cfg.mic.silenceMs) { this.#emit('silence'); return { level, speaking: false }; }
      if (total >= this.cfg.mic.maxSegmentMs) { this.#emit('max'); return { level, speaking: false }; }
      return { level, speaking: true };
    }

    // 还没开口：滚一份预录
    this.pre.push({ buf, ms });
    this.preMs += ms;
    while (this.preMs > this.cfg.mic.prerollMs && this.pre.length > 1) {
      this.preMs -= this.pre[0].ms;
      this.pre.shift();
    }

    // 过阈值 = 开口
    if (level >= thr) {
      this.speaking = true;
      this.startedAt = at;
      this.lastVoiceAt = at;
      this.speechMs = ms;
      this.frames = [...this.pre];
      this.pre = [];
      this.preMs = 0;
      this.onPhase({ phase: 'start', level });
      return { level, speaking: true };
    }
    return { level, speaking: false };
  }
}

module.exports = {
  CONFIG_FILE, DEFAULTS, SAMPLE_RATE,
  normalize, settings, save, merge, ready,
  buildPrompt, buildBody, cleanText, parseModelText, transcribe, describe, toneNote,
  pcm16ToWav, rms, sniffAudioFormat, MicAsr,
};
