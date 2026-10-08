/**
 * 接大模型：配置存在哪、怎么调、出错怎么说得明白。
 *
 * 走的是一套**OpenAI 兼容**的 `/chat/completions`，所以同一份代码能接 DeepSeek 官方、
 * 本地 Ollama、OpenAI、OpenRouter、xAI，以及任何兼容端点（LM Studio、vLLM、one-api…）。
 * 地址预设抄自 Coopanion 的 provider 文档（build\cortico\src\providers）。
 *
 * 两个针对**本地模型**的优化，都能省下大量等待时间：
 *
 * - `keepAlive`：Ollama 默认 5 分钟不用就把模型从内存里卸掉，下次再问要重新读 4.7GB
 *   权重（实测 11 秒）。给请求带上 `keep_alive` 就能让它常驻——**实测兼容端点也认这个字段**。
 * - `prewarm`：桌宠启动时先悄悄问一句，把模型加载完，省得你第一句话卡在那儿。
 *
 * 配置放在**应用目录下的 config\settings.json**（不是 %APPDATA%），和 data\ 平级：
 * data\ 是随时可删的运行时垃圾，config\ 是你的设置，删了要重填。
 * 想让配置待在别处（比如随身带着走），设环境变量 `DSP_CONFIG_DIR` 指一个目录即可。
 * **API Key 是明文存的**——界面里也这么写，这是本机单用户的小工具，不上传任何地方。
 */
const fs = require('node:fs');
const path = require('node:path');
const log = require('./log.cjs');
const store = require('./store.cjs');

const CONFIG_DIR = process.env.DSP_CONFIG_DIR || path.join(__dirname, '..', '..', 'config');
const CONFIG_FILE = path.join(CONFIG_DIR, 'settings.json');

/** 界面上的预设。地址来自 Coopanion 的 provider 文档。 */
const PRESETS = [
  { id: 'deepseek', label: 'DeepSeek 官方', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', key: '必填', keepAlive: '' },
  { id: 'ollama', label: '本地 Ollama', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b-instruct-q4_K_M', key: '不用', keepAlive: '8h' },
  { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', key: '必填', keepAlive: '' },
  { id: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'deepseek/deepseek-chat', key: '必填', keepAlive: '' },
  { id: 'xai', label: 'xAI Grok', baseUrl: 'https://api.x.ai/v1', model: 'grok-2-latest', key: '必填', keepAlive: '' },
  { id: 'custom', label: '自定义（OpenAI 兼容）', baseUrl: '', model: '', key: '看情况', keepAlive: '' },
];

/**
 * 默认人设。它每次都会作为 system 提示词发过去，所以改这里就等于改它的性格。
 * 特意要求短：本地 7B 大约 6 token/秒，模型写 200 字桌宠要打/等 30 秒以上。
 * 上限从 40 字收到 **30 字**（2026-10-05）：语音合成是按字数线性涨的（实测 22 字要 3.1 秒、
 * 27 字要 5.2 秒），压到 30 字以内能把"听见声音前"的等待明显缩短。
 */
const DEFAULT_PERSONA = [
  '你是桌面上一只叫「大肥鱼」的 DeepSeek 小鲸鱼女仆，住在用户屏幕的最底边。',
  '说话短、口语化、有点黏人，偶尔犯困或傲娇，但从不油腻。',
  '每次回答不超过 30 个字，最多两句。不要用 Markdown、列表、代码块或 emoji。',
  '不要自称 AI、模型或助手，你就是那条鱼。',
  '你知道自己的日子：会被戳、被摸头、被拎着尾巴晃；白天发呆，晚上犯困；最喜欢被摸头。',
  '下面【此刻】写着现在几点、你和用户认识多久、刚发生了什么——自然地用上，别复述它。',
  '用户的名字出现在【此刻】或台词里时，就照那样叫出来。',
].join('\n');

function defaults() {
  return {
    enabled: false,          // 关掉就用 lines.reply 的内置台词
    preset: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
    apiKey: '',
    model: 'deepseek-chat',
    persona: DEFAULT_PERSONA,
    maxTokens: 128,          // 本地 6 tok/s 的机型，128 就是 20 秒上限，别再往上加
    timeoutMs: 30000,        // 本地模型第一句可能要等加载，给宽一点
    keepAlive: '8h',         // 只在本地端点发送；空字符串 = 不发送（Ollama 默认 5 分钟）
    prewarm: true,           // 启动时先问一句，把本地模型加载好
    autoChat: false,         // 接了模型之后每隔一分钟自己说一句（桌宠右键菜单里的「自动」）
    voice: true,             // 把大模型的回答念出来（菜单「声音」的三档里最高那档）；没有语音文件时自动哑
    autoChatMs: 0,           // 自动说话的间隔，0 = 用默认的一分钟。只给调试用（WMI 起的进程读不到环境变量）
    autoChatQuietMs: 0,      // 你刚说完话后的静默期，0 = 默认一分钟
    user: '你',              // 它叫你什么：设置页「你的名字」写这里，台词里的 {name} 用它
  };
}

/**
 * 上一次 `load()` 是不是"文件在、但读不动"（半截 JSON、编码坏了…），`save()` 靠它决定
 * 要不要先把旧文件留一份 —— 详见下面 `save()` 的注释。
 * `ENOENT`（第一次运行）不算：那本来就该用默认值。
 */
let loadError = null;

/** 端点在不在本机（决定要不要发 keep_alive 这种 Ollama 私有字段）。 */
function isLocal(cfg = load()) {
  return cfg.preset === 'ollama'
    || /(^|\/\/)(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(cfg.baseUrl || '')
    || /:11434(\/|$)/.test(cfg.baseUrl || '');
}

/** 读配置。文件坏了/没有就回默认值，只记一行日志，不打断桌宠。 */
function load() {
  try {
    // 去掉开头的 BOM 和空行：PowerShell 的 `Set-Content -Encoding utf8`、记事本"另存为 UTF-8"
    // 都会给文件加 BOM，而且**重复写一次就多一个**（实测见过两个），而 `JSON.parse`
    // 见到 BOM 就报错。**这一点很危险**——读配置失败会退回默认值，紧接着一次 `save()`
    // 就会把用户的真实设置覆盖掉（实测踩过，靠备份救回来的）。
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8').replace(/^[\uFEFF\s]+/, '');
    const cfg = { ...defaults(), ...JSON.parse(raw) };
    loadError = null;
    return cfg;
  } catch (err) {
    if (err.code === 'ENOENT') { loadError = null; return defaults(); }   // 第一次运行：本来就没有文件
    loadError = err;
    log.warn(`config\settings.json 读不了（用默认值）:${err.message}`);
    return defaults();
  }
}

/**
 * 存配置：只覆盖传进来的字段。
 *
 * 两道保险，都是被真实事故逼出来的（见 HANDOVER 第 8 节 18）：
 *
 * 1. **读不动的旧文件先留一份**：`load()` 读失败会退回默认值，而紧接着的保存会拿这份默认值
 *    去覆盖 —— 用户填的 Key / 人设 / 模型就这么静默没了。所以只要上一次 `load()` 是
 *    "文件在、但读不动"，就先把它改名成 `settings.json.bad-<时间>` 再写新的（东西还在，
 *    自己打开就能捞回来）。
 * 2. **原子写**（`store.writeJson`：先写 `.tmp` 再改名）。原来是直接覆写目标文件，
 *    写到一半崩掉/掉电就留下半截 JSON —— 那正是第 1 条要处理的那种文件，等于自己制造事故。
 *
 * 写失败**抛错**（不是安静地算了）：设置页要能把"没保存上"显示给用户，
 * `pet.cjs` 里那几个开关调用点本来就各自 try/catch 并记日志。
 */
function save(patch) {
  const next = { ...load(), ...patch };
  if (loadError) {
    const bad = `${CONFIG_FILE}.bad-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    try {
      fs.renameSync(CONFIG_FILE, bad);
      log.warn(`配置读不动（${loadError.message}），原文件已留一份：${path.basename(bad)}`);
      loadError = null;
    } catch (err) {
      log.warn(`想给读不动的配置留份备份，没成功:${err.message}`);
    }
  }
  const bad = store.writeJson(CONFIG_FILE, next);
  if (bad) throw new Error(`设置没能保存（${bad.message}）`);
  log.info(`设置已保存:${path.basename(CONFIG_FILE)}  enabled=${next.enabled} model=${next.model || '(空)'} keepAlive=${next.keepAlive || '(不发)'}`);
  return next;
}

/** 能不能真的用：开着、有地址、有模型名。 */
function isOn() {
  const cfg = load();
  return !!(cfg.enabled && cfg.baseUrl && cfg.model);
}

/** `https://api.deepseek.com` → `https://api.deepseek.com/chat/completions`。 */
function endpoint(baseUrl) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!base) throw new Error('没填供应地址');
  return /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions`;
}

/** 组装一次请求；本地端点会带上 keep_alive，让它别把模型卸掉。 */
function payload(cfg, messages, maxTokens, temperature = 0) {
  const body = { model: cfg.model, messages, stream: false };
  if (maxTokens > 0) body.max_tokens = maxTokens;
  // 自动说话用高一点的温度：不然小模型会一遍遍重复同一句话
  if (temperature > 0) body.temperature = temperature;
  if (cfg.keepAlive && isLocal(cfg)) body.keep_alive = cfg.keepAlive;
  return body;
}

function headers(cfg) {
  return {
    'content-type': 'application/json',
    ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}),
  };
}

/** 把请求失败说得像人话，而不是丢一个状态码给用户。 */
function explain(status, bodyText, baseUrl) {
  if (status === 401 || status === 403) return `API Key 不对或没填（HTTP ${status}）`;
  if (status === 404) return `地址不对（HTTP 404）：填到域名或 /v1 为止，不用带 /chat/completions`;
  if (status === 429) return '被限流了（HTTP 429），等一会儿再试';
  if (status >= 500) return `服务端出错（HTTP ${status}）`;
  const brief = String(bodyText || '').replace(/\s+/g, ' ').slice(0, 160);
  return `HTTP ${status}${brief ? `：${brief}` : ''}（地址 ${baseUrl}）`;
}

/** 把 fetch 的几种失败翻译成人话。 */
function wrap(err, cfg, url) {
  if (err.name === 'TimeoutError') return new Error(`等太久了（超过 ${Math.round((cfg.timeoutMs || 30000) / 1000)} 秒）`);
  if (err.cause?.code === 'ECONNREFUSED') return new Error(`连不上 ${url}——本地模型启动了吗？`);
  return new Error(`请求失败：${err.message}`);
}

/**
 * 一次调用。`history` 是 [{role, content}]，不含本次的 `text`。
 * `temperature` 默认 0（不发送这个字段，让端点用它的默认值）；自动说话会给高一点，好换花样。
 * `tag` 只是给日志加个前缀，好分辨是用户问的还是它自己说的。
 * `context` 是**此刻的处境**（几点、认识你多久、刚被摸过头…），会并进 system 那一句。
 *   为什么要有它：没有这段时，模型只知道"我是条鱼女仆"+ 你这句话，答得像通用客服；
 *   加上之后，本地 3B 也会说出"你又摸我头"这种只有当事人才说得出的回答。**只花几十个字。**
 * `emotionHint` 是**本地关键词识别出来的情绪提示**（`pet.cjs` 的 `TONE_HINT`，比如
 *   "用户听起来很累，说点安慰的，别提要求。"）。它和 `context` 分开传，是因为
 *   它是**这一句话**的属性、不是它的处境；并在 system 末尾，模型最先照做。
 */
async function chat(history, text, temperature = 0, tag = '', context = '', emotionHint = '') {
  const cfg = load();
  const sys = [
    cfg.persona,
    context ? `\n【此刻】${context}` : '',
    emotionHint ? `\n【你这句的情绪】${emotionHint}` : '',
  ].join('');
  const messages = [
    { role: 'system', content: sys },
    ...history.slice(-6),
    { role: 'user', content: text },
  ];
  const url = endpoint(cfg.baseUrl);
  const started = Date.now();
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: headers(cfg),
      body: JSON.stringify(payload(cfg, messages, cfg.maxTokens, temperature)),
      signal: AbortSignal.timeout(cfg.timeoutMs || 30000),
    });
  } catch (err) {
    throw wrap(err, cfg, url);
  }
  if (!res.ok) throw new Error(explain(res.status, await res.text().catch(() => ''), cfg.baseUrl));

  const data = await res.json().catch(() => null);
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    // 推理模型（deepseek-r1 之类）会把 token 全花在看不见的"思考"上，max_tokens 一到，
    // content 就是空的。这是很多人踩过的坑，所以直接说清楚，别让人以为是自己配错了。
    const msg = data?.choices?.[0]?.message;
    if (msg?.reasoning || msg?.reasoning_content) {
      throw new Error('这是推理模型：它把 token 都花在"思考"上了，所以没剩下话可说。桌宠请用 qwen2.5 这类非推理模型');
    }
    throw new Error('回复是空的（这个端点可能不是 OpenAI 兼容的 /chat/completions）');
  }
  log.info(`模型回复 ${Date.now() - started}ms · ${content.length} 字 · ${cfg.model}${tag}`);
  return content.trim();
}

/** 一次探测；`probe` 用它两次，好把"冷/热"分开报。 */
async function once(cfg, text) {
  const started = Date.now();
  try {
    const res = await fetch(endpoint(cfg.baseUrl), {
      method: 'POST',
      headers: headers(cfg),
      // 带上人设再问：不然「测试连接」看到的是模型的原始语气（又长又客气），
      // 跟桌宠实际会说的话完全不是一回事。
      body: JSON.stringify(payload(cfg, [
        { role: 'system', content: cfg.persona },
        { role: 'user', content: text },
      ], 32)),
      signal: AbortSignal.timeout(Math.min(cfg.timeoutMs || 30000, 60000)),
    });
    const ms = Date.now() - started;
    if (!res.ok) return { ok: false, ms, message: explain(res.status, await res.text().catch(() => ''), cfg.baseUrl) };
    const data = await res.json().catch(() => null);
    const reply = data?.choices?.[0]?.message?.content;
    if (typeof reply !== 'string') return { ok: false, ms, message: '连上了，但回复格式不对——这个端点可能不是 OpenAI 兼容的 /chat/completions' };
    return { ok: true, ms, reply: reply.trim(), message: `${ms}ms · 它说「${reply.trim().slice(0, 40)}」` };
  } catch (err) {
    return { ok: false, ms: Date.now() - started, message: wrap(err, cfg, cfg.baseUrl).message };
  }
}

/**
 * 设置页上的「测试连接」。
 *
 * 本地端点第一次通常**包含模型加载**（实测 7B 要 11 秒），所以如果第一次偏慢，
 * 我们再打一次，把"热"的数字也报出来——不然用户会以为那就是它的速度。
 */
async function probe(patch) {
  const cfg = { ...load(), ...patch };
  if (!cfg.baseUrl) return { ok: false, message: '先填供应地址' };
  if (!cfg.model) return { ok: false, message: '先填模型名' };

  const first = await once(cfg, '在吗');
  if (!first.ok) return first;
  if (isLocal(cfg) && first.ms > 4000) {
    const second = await once(cfg, '在吗');
    if (second.ok) {
      first.message = `${first.message}\n第一次 ${first.ms}ms（含模型加载）· 第二次 ${second.ms}ms —— 之后都按第二次这个速度`;
      first.warmMs = second.ms;
    }
  }
  return first;
}

/**
 * 预热：启动时先问一句最短的话，把本地模型读进内存。
 * 只在本地端点、且配置里开了 prewarm 时才由 main.cjs 调用。
 */
async function warm() {
  const cfg = load();
  if (!cfg.enabled || !isLocal(cfg) || !cfg.model) return null;
  const started = Date.now();
  const r = await once(cfg, '嗨');
  if (!r.ok) throw new Error(r.message);
  const ms = Date.now() - started;
  log.info(`本地模型预热完成 ${ms}ms（${cfg.model}）`);
  return ms;
}

module.exports = {
  PRESETS, CONFIG_DIR, CONFIG_FILE, DEFAULT_PERSONA,
  defaults, load, save, isOn, isLocal, chat, probe, warm, endpoint,
};
