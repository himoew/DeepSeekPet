/**
 * 协议、台词库、设置与模型调用的自检 —— 不需要 Electron，任意 Node ≥ 20 都能跑。
 *
 *   node test\smoke.cjs
 *
 * 模型那一节会起一个**假的 OpenAI 兼容端点**（本机 127.0.0.1），把配置指过去，
 * 于是整条链路 —— 设置 → llm.chat → 切成气泡 → 说出口 —— 都在测试范围内，
 * 而且不会碰你真实的 config\settings.json（配置目录被指到一个临时目录）。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { pathToFileURL } = require('node:url');

// 必须在 require 应用模块之前：llm.cjs 和 log.cjs 在加载时就决定各自的目录，
// pet.cjs 也在这时读「自动说话」的间隔。
// 配置和日志都指到临时目录，这样自检既不碰你真实的 settings.json，
// 也不会把它那一堆假模型流量写进桌宠自己的 data\pet.log（不然真出问题时会被埋掉）。
const CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dsp-test-'));
process.env.DSP_CONFIG_DIR = CONFIG_DIR;
process.env.DSP_LOG_DIR = CONFIG_DIR;
// 自动说话默认一分钟一次、静默期也是一分钟，自检等不起：都压短
process.env.DSP_AUTO_CHAT_MS = '3500';
process.env.DSP_AUTO_CHAT_QUIET_MS = '8000';

const app = path.join(__dirname, '..', 'resources', 'app');
const { startServer } = require(path.join(app, 'server.cjs'));
const pet = require(path.join(app, 'pet.cjs'));
const lines = require(path.join(app, 'lines.cjs'));
const llm = require(path.join(app, 'llm.cjs'));
const store = require(path.join(app, 'store.cjs'));
const { WebSocket } = require(path.join(app, 'node_modules', 'ws'));

let passed = 0;
const ok = (name, cond) => {
  if (!cond) throw new Error(`FAIL ${name}`);
  passed += 1;
  console.log(`  ok  ${name}`);
};

/** 页面会去取的每一个文件。 */
const FILES = [
  ['/pet', 'text/html'],
  ['/settings', 'text/html'],
  ['/api/avatar', 'image/png'],
  ['/web/pet.css', 'text/css'],
  ['/web/pet-app.js', 'text/javascript'],
  ['/web/pet-core.js', 'text/javascript'],
  ['/web/fx.js', 'text/javascript'],
  ['/web/ambience.js', 'text/javascript'],
  ['/web/rig/rig.js', 'text/javascript'],
  ['/web/whale/figure.js', 'text/javascript'],
  ['/web/whale/model.json', 'application/json'],
  ['/web/whale/tex/face.png', 'image/png'],
  ['/web/whale/feat/happy_mouth.png', 'image/png'],
];

/** 身体认识的所有表情与动作；台词里的 actions 只能从这里面挑。 */
const ACTIONS = new Set([
  ...'neutral happy wink love shy surprised angry sad sleepy thinking'.split(' '),
  ...'stand jump hop look turn nod shake spin sit sleep dizzy walk run'.split(' '),
]);

/**
 * 台词库：每一项都要有非空 text，动作名都要认识。
 *
 * ⚠️ **两件事容易被这里"误伤"，都是 2026-10-10 部位细化时踩到的**：
 *  ① 台词库里**可以有不那么"台词"的叶子**，比如 `petAreaFallback`（`{ ahoge: 'hair', … }`
 *     这种纯映射）—— 它里面的值是**字符串**，不是 `{text}`，旧版会报"没有 text"。
 *     所以只对**对象**继续往下查，字符串之类的直接认。
 *  ② 展开运算符（`...someObject`）会**造出循环引用**，递归遍历会当场栈溢出
 *     （症状是没有栈的 `Maximum call stack size exceeded`）——所以这里用 `seen` 挡一道，
 *     万一以后真出现循环，自检给出人话而不是把进程打死。
 */
function checkLines(node, trail, problems, count, seen = new Set()) {
  if (Array.isArray(node)) {
    if (!node.length) problems.push(`${trail} 是空数组`);
    node.forEach((item, i) => {
      count.n += 1;
      if (!item || typeof item.text !== 'string' || !item.text.trim()) problems.push(`${trail}[${i}] 没有 text`);
      for (const a of (item && item.actions) || []) {
        if (!ACTIONS.has(a)) problems.push(`${trail}[${i}] 未知动作 "${a}"`);
      }
      // 选项：只有「它会问你」那几条有（`ask`）。`label` 是卡片上写的、`reply` 是选完回的那句，
      // 两个都要有——少了任何一个，点了选项之后它就是沉默，而且不会报错。
      for (const [j, o] of ((item && item.options) || []).entries()) {
        const at = `${trail}[${i}].options[${j}]`;
        if (!o || typeof o.label !== 'string' || !o.label.trim()) problems.push(`${at} 没有 label`);
        if (!o || typeof o.reply !== 'string' || !o.reply.trim()) problems.push(`${at} 没有 reply`);
        for (const a of (o && o.actions) || []) {
          if (!ACTIONS.has(a)) problems.push(`${at} 未知动作 "${a}"`);
        }
      }
    });
    return;
  }
  if (node === null || typeof node !== 'object') return;
  if (seen.has(node)) { problems.push(`${trail} 里出现了循环引用（展开运算符造成的），自检没法查完`); return; }
  seen.add(node);
  for (const [k, v] of Object.entries(node)) checkLines(v, `${trail}.${k}`, problems, count, seen);
}

/**
 * 页面里那两张部位判定表（pet-app.js 的 `REGION_BOXES` + `REGION_AT`）用到的部位名。
 * 拿来和台词桶对一下：**页面改了名字、台词没跟上**的话，World 会静默退回通用台词，
 * 这种错从日志里看不出来（它照常说，只是不说那个部位的），所以在这里挡一道。
 *
 * ⚠️ **两张表都要抠**（2026-10-10 部位细化后有了矩形表），而且**不能靠"从 A 切到 B"**
 * —— 那样中间只要插进来别的代码（比如 `petLocal()`），函数名就会被当成部位名读进来，
 * 后面几条"名字对得上"的检查会一起崩（实测：`Maximum call stack size exceeded`，
 * 而真正的错是"部位集合里混进了 `petLocal`"）。现在只认 `['名字',` 这个形状。
 */
function pageAreas() {
  const src = fs.readFileSync(path.join(app, 'web', 'pet-app.js'), 'utf8');
  const grab = (re) => (src.match(re) || [''])[0];
  const boxes = grab(/const REGION_BOXES = \[[\s\S]*?\n\];/);
  const anchors = grab(/const REGION_AT = \[[\s\S]*?\n\];/);
  return [...new Set([...boxes.matchAll(/\['([a-z]+)',/g), ...anchors.matchAll(/\['([a-z]+)',/g)]
    .map((m) => m[1]))].sort();
}

/** 台词桶里"每个部位一桶"的三张表（戳 / 蹭 / 抓+拎久+放下）。 */
const AREA_BUCKETS = {
  pokeArea: (A) => A.every((k) => lines.pokeArea[k]?.length),
  petArea: (A) => A.every((k) => lines.petArea[k]?.length),
  grabLike: (A) => ['grabArea', 'holdArea', 'dropArea'].every((b) => A.every((k) => lines[b]?.[k]?.length)),
};

/** 页面里抚摸三段的 `stage:` 名字（pet-app.js 直接写在 `send` 里），拿来和台词桶对一下。 */
function pageStages() {
  const src = fs.readFileSync(path.join(app, 'web', 'pet-app.js'), 'utf8');
  return [...new Set([...src.matchAll(/stage: '([a-z]+)'/g)].map((m) => m[1]))].sort();
}

/** 页面里"抓取风格表"（`GRAB_STYLE`：每个部位怎么挂）的部位名。 */
function pageGrabParts() {
  const src = fs.readFileSync(path.join(app, 'web', 'pet-app.js'), 'utf8');
  const from = src.indexOf('const GRAB_STYLE');
  const block = src.slice(from, src.indexOf('};', from));
  // ⚠️ 这里**不能**用"行首两个空格 + 名字"那种写法：表里**一行写了多个部位**
  // （`ahoge: {…}, hair: {…}, eyes: {…},`），按行首匹配会把同一行后面的那些全漏掉
  // —— 漏掉之后"抓取风格表的部位名和判定表一致"那条会**红得莫名其妙**。认 `名字: {` 这个形状即可。
  return [...new Set([...block.matchAll(/([a-z]+): \{/g)].map((m) => m[1]))].sort();
}

/** 若干组台词里的所有 text。 */
const textsOf = (...groups) => groups.flat().map((l) => l.text);
/**
 * 若干组台词里的所有 text，**先把占位符填掉**（用 `pet.fill`，跟生产同一套逻辑）。
 * 用到 {name} 的桶必须走这个：页面收到的是填好的文字，拿原文比会"随机"对不上。
 */
const textsFilled = (...groups) => groups.flat().map((l) => pet.fill(l, { name: '你', days: 1, area: '头', words: '', hour: '晚上' }).text);

/** 一个假的 OpenAI 兼容端点：记下收到的请求，回固定的一句话。
 *  模型名决定它怎么回答：
 *   · `fail-me`    → 401（考"报错说人话"）
 *   · `slow-model` → 第一次故意慢 4.1 秒（模拟模型加载）
 *   · `vary-model` → 每次换一句（自动说话要能换花样才算正常）
 *   · `same-model` → 永远同一句（考"太像就别再说"）
 *   · `echo-model` → 把提示词念出来（考"别让它说'系统提示我…'"）
 *   · `repeat-model` → 永远一句谁都没说过的话（考"第一句会说出来，第二句被防重复挡住"）
 */
function stubModel() {
  const seen = [];
  let slowOnce = true;
  let varied = 0;
  const VARIES = ['今天风挺软的。', '刚数了数尾巴上的纹路。', '想吃点甜的东西。', '你要不要歇一会儿。'];
  const CONTENT = {
    'echo-model': '收到啦,我是测试模型。',
    'same-model': '今天风挺软的。',
    'leak-model': '系统提示我要自己说一句。',
    'repeat-model': '阿巴阿巴阿巴。',
  };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body = null;
      try { body = JSON.parse(raw); } catch { /* 留 null */ }
      seen.push({ url: req.url, headers: req.headers, body });
      const fail = body?.model === 'fail-me';
      const slow = body?.model === 'slow-model' && slowOnce;
      if (slow) slowOnce = false;
      const answer = () => {
        res.writeHead(fail ? 401 : 200, { 'content-type': 'application/json' });
        let content = '收到啦,我是测试模型。';
        if (body?.model === 'vary-model') content = VARIES[varied++ % VARIES.length];
        else if (CONTENT[body?.model]) content = CONTENT[body?.model];
        res.end(JSON.stringify(fail
          ? { error: { message: 'bad key' } }
          : { choices: [{ message: { role: 'assistant', content } }] }));
      };
      if (slow) setTimeout(answer, 4100);
      else answer();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, seen, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

(async () => {
  const { server, port } = await startServer();
  const base = `http://127.0.0.1:${port}`;
  const stub = await stubModel();

  try {
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
      const dir = path.join(app, 'web/whale/schemes', sc.id);
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

    /* ---------- 2. 台词库 ---------- */
    const problems = [];
    const count = { n: 0 };
    checkLines(lines, 'lines', problems, count);
    ok(`台词库 ${count.n} 条全部合法（文字非空、动作名都认识）`, problems.length === 0);
    if (problems.length) console.log('      ' + problems.join('\n      '));

    ok('四个时段都有问候语', ['morning', 'afternoon', 'evening', 'night'].every((k) => lines.hello[k]?.length));
    ok('戳的三个档位都齐', lines.poke.first.length && lines.poke.again.length && lines.poke.tooMuch.length);
    ok('每个事件都有台词', ['grab', 'pet', 'petAsleep', 'drop', 'throw', 'crash', 'pokeAsleep',
      'drowsy', 'wakeUp', 'idle', 'reply', 'llmFailed', 'hush', 'back'].every((k) => Array.isArray(lines[k]) && lines[k].length));

    // 摸久了/半夜/回来招呼这些新桶
    ok('回来招呼 / 电池 / 半夜被戳醒 都有台词',
      lines.youBack?.length > 0 && lines.battery?.length > 0 && lines.pokeAsleepNight?.length > 0);
    ok('按时段的发呆话和犯困话四个时段都齐',
      ['morning', 'afternoon', 'evening', 'night'].every((k) => lines.idleByTime?.[k]?.length && lines.drowsyByTime?.[k]?.length));
    // 「叫你的名字」这条线：台词里有 {name}、设置页有这个输入框、配置里有默认值
    ok('台词里准备了 {name} 占位符',
      JSON.stringify(lines).includes('{name}'));
    ok('设置页有「你的名字」输入框',
      fs.readFileSync(path.join(app, 'web', 'settings.html'), 'utf8').includes('id="user"'));
    ok('配置默认值里有 user', llm.defaults().user === '你');

    /* ---------- 2b. 它的记忆（纯 Node 就能测） ---------- */
    const memory = require(path.join(app, 'memory.cjs'));
    const m0 = memory.touchSeen();
    ok('记忆：第一次见面就记下日期', /^\d{4}-\d{2}-\d{2}$/.test(m0.first) && m0.days >= 1);
    ok('记忆文件落在 DSP_LOG_DIR 里（不碰用户真实记忆）', memory.FILE.startsWith(CONFIG_DIR));
    ok('记忆：今天能说"记忆话"的额度是有限的', memory.canSayMemory() === true && memory.SAY_PER_DAY >= 1);
    memory.addTouch('pet', 'head');
    memory.addTouch('poke', 'head');
    memory.addTalk('今天有点累');
    memory.addPick(true);
    const m1 = memory.snapshot();
    ok('记忆：各项互动分开记数', m1.touch.pet === 1 && m1.touch.poke === 1 && m1.touch.grab === 0);
    ok('记忆：说过的话被记下来了', m1.talks === 1 && m1.words === '今天有点累');
    ok('记忆：选择卡的选择也记', m1.quiet === 1);
    for (let i = 0; i < 5; i += 1) memory.addTouch('pet', 'head');
    ok('记忆：摸够 5 次才敢说"你最喜欢摸头"', memory.snapshot().areaTop === 'head');
    memory.markSaid(); memory.markSaid();
    ok('记忆：说满额度当天就不再说了', memory.canSayMemory() === false);
    const mF = memory.forget();
    ok('记忆：清空之后从今天重新认识', mF.days === 1 && mF.talks === 0 && mF.touch.pet === 0);
    ok('记忆：认识第几天的台词都在', ['memoryMilestone', 'memoryAway', 'memoryWords', 'memoryArea', 'memoryHour']
      .every((k) => Array.isArray(lines[k]) && lines[k].length));

    /* ---------- 2c. 心情（那条连续的数，纯 Node 就能测） ---------- */
    /**
     * 心情是"互动 → 两条轴 → 档位"这条链。这里一口气推到底：
     * 好话往上、坏话往下、边缘不发散、够极端就换档，而且**每个档位都真的挑得到自己的台词**。
     */
    const mood = require(path.join(app, 'mood.cjs'));
    const mode0 = mood.snapshot();
    ok('心情文件落在 DSP_LOG_DIR 里（不碰用户真实心情）', mood.FILE.startsWith(CONFIG_DIR));
    ok('心情：默认在"平常"那一档', ['quiet', 'happy', 'clingy'].includes(mode0.state));
    mood.forget();
    for (let i = 0; i < 40; i += 1) mood.onEvent('pet');
    ok('心情：摸多了往上走', mood.snapshot().state === 'clingy' && mood.snapshot().love > 0.74);
    // 只摸不戳 → "黏人"（喜欢够多、精神也没垮）
    mood.forget();
    for (let i = 0; i < 30; i += 1) mood.onEvent('pet');
    ok('心情：光被宠着的时候是"黏人"那一档', mood.snapshot().state === 'clingy');
    // 连着戳 → "想你"（喜欢掉到 .4 以下；精神还够，所以不会先变成"困倦"）
    mood.forget();
    for (let i = 0; i < 40; i += 1) mood.onEvent('poke');
    const poked = mood.snapshot();
    ok('心情：一直戳它，喜欢会掉下去', poked.love < 0.42 && poked.love < 0.6);
    // 再宠回来一点 → "开心"（喜欢过半，但还没到"黏人"那条线）
    mood.forget();
    for (let i = 0; i < 2; i += 1) mood.onEvent('pet');
    ok('心情：被宠但不至于黏人时是"开心"那一档（love 落在 .62~.74 之间）',
      mood.snapshot().state === 'happy' && mood.snapshot().love > 0.62 && mood.snapshot().love < 0.74);
    for (let i = 0; i < 40; i += 1) mood.onEvent('poke');
    for (let i = 0; i < 60; i += 1) mood.onEvent('crash');
    const floored = mood.snapshot();
    ok('心情：推到极端也不会跑出 0~1', floored.love >= 0 && floored.energy >= 0 && floored.energy <= 1);
    ok('心情：喜欢和精力都垮了就是"困倦"那一档', floored.state === 'tired');
    ok('心情：档位有全部五种', ['clingy', 'happy', 'quiet', 'tired', 'lonely'].every((k) => !!mood.LABEL[k]));
    // 心情只给**很小的**速度差（±10%）：走路这种每帧都看得见的量，超过一成就像穿溜冰鞋
    ok('心情：动作倍率收在 ±10% 以内（0.9~1.1，中位 1.0）',
      mood.snapshot().speed >= 0.85 && mood.snapshot().speed <= 1.15);
    mood.forget();
    // 两个"基准值"：平常（love=energy=.6）的时候，它离你多远算够近、动作倍率是多大
    const clingCalm = mood.snapshot().cling;
    const speedFresh = mood.snapshot().speed;
    for (let i = 0; i < 30; i += 1) mood.onEvent('pet');
    ok('心情：喜欢得越多，黏得越近（cling 门槛变小）', mood.snapshot().cling < clingCalm);
    mood.forget();
    for (let i = 0; i < 60; i += 1) mood.onEvent('crash');
    ok('心情：精神越差，动作倍率越小', mood.snapshot().speed < speedFresh);
    // 每个档位都得真的挑得到自己的台词：**键写错、桶是空的**都会静默退回通用台词，日志里看不出来
    const fallback = { text: '（通用）', actions: [] };
    for (const bucket of Object.keys(lines.mood || {})) {
      const pool = lines.mood[bucket].map((l) => l.text);
      const got = new Set();
      for (let i = 0; i < 24; i += 1) got.add(pet.moodPick({ moodState: bucket }, [fallback]).text);
      ok(`心情台词：${bucket} 挑得到自己的那几条（键要和 mood.LABEL 对得上）`,
        got.size > 0 && [...got].every((t) => pool.includes(t)));
    }
    for (const k of Object.keys(mood.LABEL)) {
      ok(`心情台词：${k} 这一桶在 lines.mood 里有`, Array.isArray(lines.mood?.[k]) && lines.mood[k].length > 0);
    }
    ok('心情：没有这个档时就退回通用台词（不会变成哑巴）',
      pet.moodPick({ moodState: '不存在的档' }, [fallback]).text === fallback.text);
    // 心跳的方向：把你不在的时候设成"往上宠"的反面，它应该往下掉（不检查幅度——那是小时级的）
    mood.forget();
    for (let i = 0; i < 40; i += 1) mood.onEvent('pet');
    const upTop = mood.snapshot();
    mood.tick({ away: true });
    ok('心情：你不在了它往下掉', mood.snapshot().love < upTop.love);
    mood.forget();

    /* ---------- 2d. 本地情绪识别（不花 token 的那一层"懂你"） ---------- */
    /**
     * 关键词表就是产品行为：改 `TONE` 的顺序 = 改优先级。所以这里既验"认得出来"，
     * 也验**容易混淆的那几句**答对（"今天累死了"必须算累，不能因为有个"好"字算开心）。
     */
    ok('情绪：认出"累"', pet.readTone('今天好累啊') === 'tired' && pet.readTone('加班到十点') === 'tired');
    ok('情绪：累优先于开心（"累死了，总算搞定了"）', pet.readTone('累死了，总算搞定了') === 'tired');
    ok('情绪：认出"难过"', pet.readTone('有点难过') === 'sad');
    ok('情绪：认出"生气"', pet.readTone('气死我了') === 'angry');
    ok('情绪：认出"谢谢"和"夸它"', pet.readTone('谢谢你') === 'thanks' && pet.readTone('你好可爱') === 'praise');
    ok('情绪：认出"关心它"和"开心"', pet.readTone('你没事吧') === 'worried' && pet.readTone('哈哈哈太好了') === 'happy');
    ok('情绪：普通的话读不出情绪（读不出是常态）', pet.readTone('今天几号') === '' && pet.readTone('') === '');
    ok('情绪：每个关键词桶都有台词，而且键跟 TONE 对得上',
      pet.TONE.every(([name]) => Array.isArray(lines.emotion?.[name]) && lines.emotion[name].length > 0)
      && Object.keys(lines.emotion || {}).every((k) => pet.TONE.some(([n]) => n === k)));
    ok('情绪：听出来的情绪会变成给模型的一句提示', /累/.test(pet.readTone('好累') ? '用户听起来很累' : ''));

    /* ---------- 2e. 不说话的小动作（歪头 / 换重心 / 瞟一眼） ---------- */
    ok('微动作：三种都在台词库里留了名字（只有日志看得到）',
      ['tilt', 'step', 'look'].every((k) => k === 'look' || (Array.isArray(lines.micro?.[k]) && lines.micro[k].length > 0)));

    /* ---------- 2f. 服装接口（贴图以后再加，接口先占住） ---------- */
    const dress = require(path.join(app, 'dress.cjs'));
    const d0 = dress.list();
    ok('服装：记录文件落在 DSP_LOG_DIR 里（不碰用户真实选择）', dress.FILE.startsWith(CONFIG_DIR));
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
    const brokenPreview = dress.list().outfits.filter((o) => o.preview && !fs.existsSync(path.join(app, o.preview.replace(/^\//, ''))));
    ok(`服装：能穿的每一套都有换装页缩略图、且文件都在（${dress.list().outfits.filter((o) => o.ready).map((o) => o.label).join('、')}）`,
      noPreview.length === 0 && brokenPreview.length === 0);
    ok('服装：原版能穿（换装记录落盘）', dress.wear('original').ok === true && dress.list().current === 'original');
    ok('服装：没换装时不给页面发 skin 覆盖（她照旧出现）', dress.skinOverride() === null);
    ok('服装：清单里有预留格，看得见"以后要加什么"',
      dress.OUTFITS.some((o) => !o.ready) && dress.OUTFITS.some((o) => o.ready));
    // 切到未 ready 的套装要被弹回原版（手工改坏文件也不会让她穿成空白）。
    // 必须**清掉 require 缓存**再读一次 —— 不清的话拿到的是同一个模块实例、读的是内存里的值。
    const dressFile = require.resolve(path.join(app, 'dress.cjs'));
    fs.writeFileSync(dress.FILE, JSON.stringify({ current: 'outfit-02' }));
    delete require.cache[dressFile];
    const hard = require(dressFile);
    ok('服装：文件被手改成没贴图的那套，也会退回原版',
      hard.list().current === 'original' && hard.skinOverride() === null);
    hard.forget();
    delete require.cache[dressFile];
    require(dressFile);                               // 让后面的用例拿到干净的那份

    /* ---------- 2g. 玩具球（静态部分：台词桶 + 页面接线） ---------- */
    /**
     * 球最怕的不是"不好玩"，而是**把她弄坏**（本会话已经在她的绘制/帧循环上栽过两次）。
     * 所以这里除了台词，还盯两件结构性的事：
     *   ① 球的物理/绘制在**自己的文件**里（`web/ball.js`），不往 `pet-core` / `figure.js` 塞；
     *   ② 开关是 World 记着的（配置里 `ball`），并且**关掉时一定有话可说**（用户要的"闹脾气"）。
     */
    for (const k of ['ballOn', 'ballKick', 'ballOffSad', 'ballOffAngry']) {
      ok(`玩具球：${k} 这一桶在台词库里`, Array.isArray(lines[k]) && lines[k].length > 0);
    }
    ok('玩具球：收走时"委屈"和"生气"两套都有（随机挑，用户要的）',
      lines.ballOffSad.length > 0 && lines.ballOffAngry.length > 0);
    ok('玩具球：表情写在台词里（委屈用 sad、生气用 angry）',
      lines.ballOffSad.some((l) => (l.actions || []).includes('sad'))
      && lines.ballOffAngry.some((l) => (l.actions || []).includes('angry')));
    ok('玩具球：物理与绘制在自己的文件里（没往 pet-core / figure.js 里塞）',
      fs.existsSync(path.join(app, 'web', 'ball.js'))
      && !fs.readFileSync(path.join(app, 'web', 'pet-core.js'), 'utf8').includes('toy-ball')
      && !fs.readFileSync(path.join(app, 'web', 'whale', 'figure.js'), 'utf8').includes('toy-ball'));
    const appSrc = fs.readFileSync(path.join(app, 'web', 'pet-app.js'), 'utf8');
    ok('玩具球：页面把它接进帧循环（step + draw 各一处）',
      /ball\.step\(dt\)/.test(appSrc) && /ball\.draw\(\)/.test(appSrc));
    ok('玩具球：页面会把"踢到了"报给 World',
      /t: 'ballKick'/.test(appSrc) && /case 'ballKick'/.test(fs.readFileSync(path.join(app, 'pet.cjs'), 'utf8')));
    ok('球/游戏模式：三态开关存进配置（重启后还在）',
      fs.readFileSync(path.join(app, 'llm.cjs'), 'utf8').includes("ballMode: 'off'")
      && fs.readFileSync(path.join(app, 'pet.cjs'), 'utf8').includes('llm.save({ ballMode: want })'));
    /**
     * **特效那一层不许被整层重写**（这条是为一次真实翻车加的）。
     *
     * `pet-core` 的粒子原来写 `fxG.innerHTML = …` —— 那是**把 `#fx` 里所有子节点换掉**。
     * 玩具球也挂在 `#fx` 下，于是"球刚画上就被抹掉"：球开了却看不见，
     * 而页面不抛错、World 那边一切正常（对话、表情、闹脾气全都有）。
     * 现在粒子写自己的子层 `#fxCore`，`#fx` 留给别的绘制者。
     */
    const htmlSrc = fs.readFileSync(path.join(app, 'web', 'pet.html'), 'utf8');
    const coreSrc = fs.readFileSync(path.join(app, 'web', 'pet-core.js'), 'utf8');
    ok('特效层分成两层：#fx 里装 #fxCore（她的粒子）', /id="fx"[\s\S]{0,120}id="fxCore"/.test(htmlSrc));
    /**
     * ★ **天气粒子单独一张画布**（2026-10-11 换的，用户实测"特效会导致卡顿"）。
     *
     * 为什么必须由自检盯着：这张 canvas 要是没进 HTML、或者 CSS 忘了 `pointer-events:none`，
     * 结果是"粒子全都不见了"或者"整张桌面的点击都被挡住"——**两种都不抛错**。
     * 连带盯住"粒子没退回 SVG"：`#fxCore` 那一层只剩她自己的爱心/眼泪/z/尘土。
     */
    const cssSrc = fs.readFileSync(path.join(app, 'web', 'pet.css'), 'utf8');
    const fxSrc = fs.readFileSync(path.join(app, 'web', 'fx.js'), 'utf8');
    const appSrcFx = fs.readFileSync(path.join(app, 'web', 'pet-app.js'), 'utf8');
    ok('★天气粒子（结构）：`pet.html` 里有粒子画布 `#fxCanvas`，而且 CSS 里 `pointer-events:none`',
      /<canvas[^>]*id="fxCanvas"/.test(htmlSrc) && /#fxCanvas\{[^}]*pointer-events:none/.test(cssSrc));
    ok('★天气粒子（结构）：粒子层不再走 SVG —— `fx.js` 不写 `innerHTML`，页面也不再给它 `#fxCore`',
      !/\.innerHTML\s*=/.test(fxSrc) && /canvas:\s*\$\('#fxCanvas'\)/.test(appSrcFx));
    /**
     * ★ **环境音的接线**（2026-10-11 新增）：`web\ambience.js` 要真的被页面用起来。
     * 三条缺一不可：① 创建；② 用户手势解锁；③ 跟音效开关一起开关（关掉时它自己 suspend）。
     * 漏掉任意一条都**不报错**，只会"天气永远没声音"。
     */
    ok('★天气音效（结构）：页面创建了环境音 + 跟着用户手势解锁 + 跟音效开关一起开关',
      /createAmbience\(/.test(appSrcFx) && /ambience\.unlock\(\)/.test(appSrcFx)
      && /ambience\.setEnabled\(ambienceOn\(\)\)/.test(appSrcFx));
    ok('★天气音效（结构）：切天气时把环境音一起切过去（`setWeather` 里调 `ambience.switchTo`）',
      /ambience\.switchTo\(/.test(appSrcFx));
    /**
     * ★ **天气音效的"单独开关"**（2026-10-11 用户："给天气音效一个单独开关，加在右键小肥鱼后的
     * 栏位里，不显示在浮窗"）。四条：
     *   ① 页面有 `weatherSound` 这个偏好，且**只出现在右键菜单**（`hoverButtons` 里不写它）；
     *   ② 真正出声 = **总闸 `sound` × 它自己**（`ambienceOn()`）—— 单独开关不能绕过总闸；
     *   ③ 切它要报给 World（`{t:'prefs', weatherSound}`），World 那边存进 settings.json；
     *   ④ World 的 `INIT` 要把它读出来（不然重启后回到默认，用户会以为开关没记住）。
     */
    const petSrc = fs.readFileSync(path.join(app, 'pet.cjs'), 'utf8');
    const llmSrc = fs.readFileSync(path.join(app, 'llm.cjs'), 'utf8');
    ok('★天气音效（结构）：页面有独立的 `weatherSound` 开关，而且是「总闸 × 它自己」两层'
      + '（单独开它不该绕过"声音：关"）',
    /weatherSound: true/.test(appSrcFx) && /function ambienceOn\(\)\s*\{[^}]*prefs\.sound && prefs\.weatherSound/.test(appSrcFx)
      && /ambience\.setEnabled\(ambienceOn\(\)\)/.test(appSrcFx));
    ok('★天气音效（结构）：这个开关只在右键菜单里（`hoverButtons` 不含它、`ACTIONS` 里有它）',
      !/hoverButtons:\s*\[[^\]]*weatherSound/.test(petSrc) && /^\s{2}weatherSound: \{/m.test(appSrcFx));
    ok('★天气音效（结构）：切开关会报给 World，World 存进 settings.json（重启后还在）',
      /send\(\{ t: 'prefs', weatherSound: prefs\.weatherSound \}\)/.test(appSrcFx)
      && /llm\.save\(\{ weatherSound: state\.weatherSound \}\)/.test(petSrc)
      && /weatherSound: llm\.load\(\)\.weatherSound !== false/.test(petSrc)
      && /weatherSound: true,/.test(llmSrc));
    /**
     * **模块求值顺序**：`pet-app.js` 里有些代码在**模块加载时就会执行**（不只是被调用时），
     * 比如 `syncGameFlag()`、`for (const b of BUTTONS)` 之类。如果它引用的 `const` 声明在后面，
     * 就是 `Cannot access 'X' before initialization` → **整个页面脚本挂掉**（她完全不出来）。
     *
     * 这条守卫为一次真实翻车加的：我把 `flags` 声明写在文件后面，而 `syncGameFlag()` 在前面，
     * 部署后页面日志里当场就是这个错。静态检查一下这个顺序，别等部署了才发现。
     */
    {
      const appSrc2 = fs.readFileSync(path.join(app, 'web', 'pet-app.js'), 'utf8');
      const declAt = appSrc2.indexOf('const flags = ');
      const callAt = appSrc2.indexOf('syncGameFlag();');
      ok('pet-app：模块加载期就用到的状态，声明必须在调用之前（TDZ 会让整页挂掉）',
        declAt > 0 && callAt > 0 && declAt < callAt);
    }
    ok('pet-core 的粒子只写 #fxCore，不整层重写 #fx（否则会把球抹掉）',
      !/fxG\.innerHTML\s*=/.test(coreSrc) && /fxCore\.innerHTML\s*=/.test(coreSrc));
    ok('玩具球挂在 #fx 下（跟粒子同一层但不同子节点）',
      /fxG\.appendChild/.test(fs.readFileSync(path.join(app, 'web', 'ball.js'), 'utf8')));
    /**
     * **静止之后不许再弹**（这条是为用户实测到的"静止时一直有弹地面异响"加的）。
     *
     * 老写法：`if (st.vy > 40) 反弹`，而弹起速度是 `40 × 0.55 = 22` —— 22px/s 不到一帧就被
     * 重力拉回地面，于是**每帧都判成一次撞地**，音效限流之后仍变成每秒 8 次的连续闷响。
     * 修法有三件，缺一不可：① 能弹的门槛（110）远高于静止门槛（45）；
     * ② 够慢就**一次性趴下**并进 `resting`；③ `resting` 状态**直接跳过物理**（不受重力、不出声）。
     */
    const ballSrc = fs.readFileSync(path.join(app, 'web', 'ball.js'), 'utf8');
    const num = (name) => Number((ballSrc.match(new RegExp(`const ${name} = ([\\d.]+)`)) || [])[1]);
    ok('玩具球：能弹的门槛远高于静止门槛（否则会每帧弹一次）',
      num('BOUNCE_MIN_VY') > num('REST_VY') * 1.5 && num('REST_VY') > 0);
    /**
     * 静止 = 跳过物理（不受重力、不出声）。
     * 但**仍然要判两件接触**：她撞上来、鼠标扫过来 —— 否则球停住之后就"死"了，
     * 球拍模式里就变成"球停在那一动不动，扫它也没反应"。
     * ③ **还要把这一帧报给游戏**（`hookGame`）：少了它，球一停游戏就一帧都收不到
     *    → 她收不到走路指令 → 用户实测的"复位后她不踢"（见 2g-5 第 ⑦ 条）。
     */
    const restingBody = (() => {
      const at = ballSrc.indexOf('if (st.resting) {');
      if (at < 0) return '';
      const open = ballSrc.indexOf('{', at);
      let d = 0;
      for (let i = open; i < ballSrc.length; i += 1) {
        if (ballSrc[i] === '{') d += 1;
        else if (ballSrc[i] === '}') { d -= 1; if (!d) return ballSrc.slice(open, i + 1); }
      }
      return '';
    })();
    ok('玩具球：静止状态跳过物理，但仍然判"她撞上"和"鼠标扫到"，并且照常把这一帧报给游戏（钩子）',
      /kickIfTouching\(\)/.test(restingBody) && /paddleIfTouching\(\)/.test(restingBody)
      && /hookGame\(/.test(restingBody) && /return;/.test(restingBody));
    ok('玩具球：够慢就一次性趴下（vy 归零 + resting）',
      /else if \(Math\.abs\(st\.vy\) <= REST_VY/.test(ballSrc) && /st\.resting = true;/.test(ballSrc));
    // 帧率：球在动 / 正被拖着时必须按 60fps（原来只有 30fps，抓着像卡住）
    ok('玩具球：在动或被拖着时按 60fps（"抓球很卡"的修法）',
      /ball\.busy/.test(appSrc) && /get busy\(\)/.test(ballSrc) && /setBallDrag|ball\.setDragging\(/.test(appSrc));

    /* ---------- 2g-2. 玩具球：把它真跑起来（动态检查 + 物理推演） ---------- */
    /**
     * 静态检查证明不了"画出来了"，也证明不了"拖着不乱弹"。所以这里用最小 DOM 桩
     * **把 `web/ball.js` 真的 import 起来跑**：
     *   ① 构造时只用 `createElementNS`（**`innerHTML` 在 SVG 元素上按 HTML 解析，
     *      `<circle>` 会落进 HTML 命名空间 → 元素在 DOM 里但一个像素都不画**，这个坑实测踩过）；
     *   ② 落地后 6 秒内必须**停稳**（不是每帧都在弹）；
     *   ③ 拖着的一秒里不许有速度残留（"抓住拖动一直乱弹直到飞走"就是这么来的）。
     */
    const nsCalls = [];
    const fakeEl = () => ({
      attrs: {},
      children: { length: 1 },
      appendChild() {},
      setAttribute(k, v) { this.attrs[k] = v; },
      getAttribute(k) { return this.attrs[k]; },
      querySelector() { return null; },
      getBoundingClientRect: () => ({ width: 0, height: 0 }),
      set innerHTML(v) { this._html = v; },
      get innerHTML() { return this._html; },
      parentNode: { appendChild() {} },
    });
    const hadDoc = Object.prototype.hasOwnProperty.call(globalThis, 'document');
    const hadHost = Object.prototype.hasOwnProperty.call(globalThis, 'petHost');
    globalThis.document = { createElementNS: (ns, tag) => { nsCalls.push(ns); return fakeEl(); } };
    globalThis.petHost = { report: () => {} };
    try {
      const { createBall } = await import(`${pathToFileURL(path.join(app, 'web', 'ball.js')).href}?smoke=${Date.now()}`);
      const fakeG = fakeEl();
      /**
       * 给球一个**游戏钩子**（就是 `web/game.js` 那种用法）：它每帧会调 `s.setAim(...)`。
       * 这一条是为一个真实报错加的：`setAim` 一度只在"返回对象"里写了、内部没有这个函数，
       * 于是钩子一调就 `ReferenceError: setAim is not defined`（帧循环被它打断）。
       * 自检当时没传钩子，所以**没抓到** —— 现在传了。
       */
      const aimCalls = [];
      const ball = createBall({
        fxG: fakeG, sfx: {},
        stage: { bounds: () => ({ W: 1280, H: 760, floorY: 758, minX: 0, maxX: 1280 }), pet: () => ({ x: 100, faceVis: 1 }) },
        game: { onStep: (s) => { s.setAim({ x: 1, power: 1.5 }); aimCalls.push(1); }, onKick: () => {} },
      });
      // 挂载是**惰性**的：第一次开球才建元素（所以先 setOn 再断言）
      ball.setOn(true, { fromLeft: false });
      ok('玩具球：SVG 元素用 createElementNS 造（用 innerHTML 会画不出来）',
        nsCalls.length >= 4 && nsCalls.every((n) => n === 'http://www.w3.org/2000/svg'));
      for (let i = 0; i < 360; i += 1) ball.step(1 / 60);
      ok('玩具球：落地后 6 秒内停稳（不再每帧弹一下）', ball.resting === true && ball.state.vx === 0 && ball.state.vy === 0);
      // 拖着走一秒：位置跟手、速度必须是 0（物理这一帧被跳过）
      ball.setDragging(true);
      let dx = ball.x;
      for (let i = 0; i < 60; i += 1) { dx += 8 * Math.sin(i / 6); ball.drag(dx, 300 + i); ball.step(1 / 60); }
      const mid = ball.state;
      ok('玩具球：拖着的时候物理停手（位置跟手、没有速度残留）',
        mid.dragging === true && mid.vx === 0 && mid.vy === 0);
      ball.setDragging(false);
      for (let i = 0; i < 30; i += 1) ball.step(1 / 60);
      ok('玩具球：松手后它自己往下掉（回落到地面方向）', ball.state.y > 300);
      ok('玩具球：游戏钩子每帧能回调 setAim（曾经它不是函数、钩子一调就炸）',
        aimCalls.length >= 30);
      /**
       * **跳起来用头顶**（用户要的："她的脑袋应该也有碰撞体积，后面她可以跳起来接回来"）。
       * 这里让她腾空（`feetY` 高于地面），把球放到头顶那一片里，看球会不会被**往外顶**。
       *
       * ⚠️ 高度要对上 `ball.js` 的 `headBox()`：箱子挂在**脚底往上 60~150**。
       * 她腾空 40px → 箱子覆盖离地 100~190，所以球放 150。
       * （老版本箱子挂在脚底上下 −30~+60，测试里放的是"离地 70"—— 箱子挪到头之后那个高度就是脚边了。）
       */
      {
        const B2 = { W: 1280, H: 760, floorY: 758, minX: 0, maxX: 1280, S: 0.42 };
        const air = { x: 640, faceVis: -1, feetY: B2.floorY - 40 };   // 腾空 40px、朝左
        let headEvents = 0;
        const b2 = createBall({
          fxG: fakeEl(), sfx: {},
          stage: { bounds: () => B2, pet: () => air },
          onEvent: (k) => { if (k === 'ballHead') headEvents += 1; },
          game: { onStep: (s) => s.setAim({ x: 1, power: 1 }), onKick: () => {} },
        });
        b2.setOn(true, { fromLeft: false });
        b2.placeAt(640 / B2.W, B2.floorY - 150, { since: 0 });   // 塞进头顶那片（箱子在脚底上方 60~150）
        for (let i = 0; i < 3; i += 1) b2.step(1 / 60);
        /**
         * 判据要写对：头球是**朝踢腿的反方向**顶出去的（她朝左 → 球被顶向右）。
         * 而普通踢腿是"从她的中心往外推"，她朝左时球在右侧 → 球会被推**向右**（同向）。
         * 所以"球向左"只能来自头球。**别断言 vx>0** —— 球飞出去撞墙反弹后 vx 会变负（我踩过）。
         * （第一帧 `aim` 还没被游戏钩子设上，头球走的是"按她朝向"的兜底方向 → 朝左。）
         */
        ok('玩具球：她腾空时脑袋有碰撞体积（球被朝踢腿的反方向顶出去）',
          headEvents > 0 && b2.state.x < 640);
        // 落地之后头就不该再顶球（站在地上时头不算碰撞体）—— 球就放在箱子那个高度上
        air.feetY = B2.floorY;
        const before = headEvents;
        b2.placeAt(640 / B2.W, B2.floorY - 150, { since: 0 });
        for (let i = 0; i < 3; i += 1) b2.step(1 / 60);
        ok('玩具球：她落地后脑袋就不再顶球（只在她腾空时算）', headEvents === before);
      }
    ok('玩具球：球的外观是贴图 web/ball.png，而且那张图真的在',
      fs.existsSync(path.join(app, 'web', 'ball.png'))
      && /ball\.png/.test(ballSrc)
      && fs.statSync(path.join(app, 'web', 'ball.png')).size > 4000);
    /**
     * **指针捕获之后，事件只到被捕获的元素**（不再冒泡到 `document`）。
     * 拖动原本只挂在 `document` 上，于是"球只在按下/松手附近跟一下、中间全丢"，
     * 松手的速度时有时无（用户实测："丢不出去，时好时坏"）。
     * 所以 `stage` 那一层必须**自己**有 pointermove 与 pointerup。
     */
    ok('玩具球：stage 自己监听 pointermove（指针捕获后事件不冒泡到 document）',
      /stage\.addEventListener\('pointermove'/.test(appSrc));
    ok('玩具球：stage 自己监听 pointerup（在被捕获的那一层松手）',
      /stage\.addEventListener\('pointerup'/.test(appSrc));
    ok('玩具球：丢出去的速度按"最近 100ms 的位移"算（停一下再松手也能丢）',
      /velocityNow/.test(ballSrc) && /100/.test(ballSrc.match(/const samples[\s\S]{0,600}/)?.[0] || ''));
    /* ---------- 2g-3. 弹弹乐（web/game.js）：进球不会死循环 ---------- */
    /**
     * 用户实测：「把球扔到网里又卡死」。根因是**进球判定没有冷静期**：
     * 球停在门里 → 判进球 → 开球（球还在门的横坐标范围内）→ 又判进球 …… 每帧一次，页面就卡死
     * （症状：**人物不动、但语音还在响** —— 语音在 worker 里，主线程卡住它照样出声）。
     *
     * 这条用例把 `web/game.js` 真的跑起来：把球塞进门里，推进 5 秒，断言
     *   ① 只算了一个球、② 球被挪出了门框。
     */
    try {
      const { createGame } = await import(`${pathToFileURL(path.join(app, 'web', 'game.js')).href}?smoke=${Date.now()}`);
      const B = { W: 1280, H: 760, floorY: 758, minX: 0, maxX: 1280, S: 0.42 };
      const ballStub = {
        on: false, x: 640, y: 745, releasedAt: 0, lastRelease: 0,
        // 速度必须是 0：新版的"来球预判"会看 `vx/vy`，球桩缺这两个字段的话会被当成来球、
        // 于是她一直在跳（自检就是这么抓到行为变化的）
        vx: 0, vy: 0, resting: true,
        setOn() { this.on = true; },
        setAim() {},
        placeAt(fx) { this.x = B.minX + fx * B.W; this.y = B.floorY - 13; },
      };
      const events = [];
      /** 记下她收到的走路指令（用来验证"跑"与"回防"）。 */
      const walkLog = [];
      const game = createGame({
        fxG: fakeEl(), ball: ballStub, sfx: {},
        control: {
          bounds: () => B, pet: () => ({ x: 900, faceVis: 1 }),
          walkTo: (x, run) => walkLog.push({ x: x * B.W, run: !!run }),
          jump() {}, act() {},
        },
        onEvent: (k, d) => events.push({ k, d }),
      });
      game.setMode('game');
      /** 一帧（`y` 可以临时覆盖，用来把球塞进门里）。 */
      const frame = (y) => game.onStep({
        dt: 1 / 60, x: ballStub.x, y: y === undefined ? ballStub.y : y,
        vx: 0, vy: 0, resting: true, dragging: false, floorY: B.floorY, R: 13,
      });
      // 先让开球后的"冷静期"（350ms）过去：这一段的球还站在门前，不该算进球
      for (let i = 0; i < 30; i += 1) frame();
      const before = events.filter((e) => e.k === 'goal').length;
      ok('弹弹乐：开球后的冷静期内不会误判进球', before === 0);

      const gr = game.goalRect(game.defence);           // 她守哪边是随机的：塞她那个门
      ballStub.x = (gr.x0 + gr.x1) / 2;
      const inGoal = gr.yTop + 10;                      // 门框以内的高度
      for (let i = 0; i < 180; i += 1) {
        /**
         * 合成测试跑得比真实时间快得多：每帧把"开球冷静期"和"计分冷却"重置，
         * 才是**真的在测"球停在门里会不会被反复判进球"**（否则它只是被冷静期挡着）。
         * ⚠️ 注意别再重置 `scoredThisRelease` —— 那个字段已经不用了，
         * 而它**正是"第一次进球之后再也不计分"那个 bug 的载体**（见下面第二条断言）。
         */
        game.debug.noGoal = 0;
        game.debug.scoreCool = 0;
        frame(inGoal);
      }
      const goals = events.filter((e) => e.k === 'goal').length;
      ok('弹弹乐：把球塞进门里只算一个球（不会每帧都判进球 → 卡死）', goals === 1);
      /**
       * ★ **第二个球也必须算**（用户实测："依旧没有复位功能"）。
       * 上一版用一个"本次松手只算一次"的标志防连算，可比赛模式是**扫球、不松手**，
       * 于是那个标志**第一次进球后就永远是 true**，后面的球一个都不算 —— 球自然也不复位。
       * 这条断言专门盯这个：把球挪出去、再塞进来一次，比分必须再涨一分。
       */
      {
        /**
         * 三段写清楚，别让"球刚被自动开走"的那一帧混进来：
         *   ① 先把球挪到**远离两个门**的中场（这一帧不该算分）
         *   ② 再塞进她守的那个门 → 第二个球（`goals2 === 2`）
         */
        const scoredSide = events.filter((e) => e.k === 'goal').slice(-1)[0].d.side;
        /**
         * ⚠️ 现在进球有 **1 秒庆祝**（`CELEBRATE_MS`，球冻在网里），合成测试跑得比真实时间快
         * → 不先把庆祝走完，后面每一步都会被"庆祝中"挡掉。拨到过去再走一帧 = 庆祝结束、开球。
         */
        game.debug.celebrateUntil = performance.now() - 1;
        frame(B.floorY - 13);
        const grAway = game.goalRect(1 - scoredSide);
        ballStub.x = B.W * 0.5;                       // 中场：离两个门都很远
        game.debug.noGoal = 0; game.debug.scoreCool = 0;
        frame(B.floorY - 13);
        const goalsMid = events.filter((e) => e.k === 'goal').length;
        ballStub.x = (grAway.x0 + grAway.x1) / 2;     // 塞进**另一个**门
        game.debug.noGoal = 0; game.debug.scoreCool = 0;
        frame(B.floorY - 13);
        const after2 = events.filter((e) => e.k === 'goal').length;
        if (!(goalsMid === 1 && after2 === 2)) {
          console.log(`      [GOALFAIL] goalsMid=${goalsMid} after2=${after2} ballX=${Math.round(ballStub.x)} scoredSide=${scoredSide} score=${JSON.stringify(game.score)}`);
        }
        ok('弹弹乐：★第一个球之后，第二个球照样算（比分不会卡在第一次）',
          goalsMid === 1 && after2 === 2);
      }      /**
       * 进球之后球要挪到门框外面 —— 但**现在是"庆祝 1 秒后才开球"**：
       * 合成测试跑得比真实时间快，所以得把庆祝截止时刻拨到过去，再走一帧，开球才会发生。
       */
      game.debug.celebrateUntil = performance.now() - 1;
      frame(B.floorY - 13);
      const gr2 = game.goalRect(game.defence);
      ok('弹弹乐：★庆祝走完才开球，球被放到门框外面（否则下一帧又判一次）',
        ballStub.x < gr2.x0 || ballStub.x > gr2.x1);
      ok('弹弹乐：进球会通知 World（带比分）',
        events.some((e) => e.k === 'goal' && Array.isArray(e.d.score) && e.d.score.some((n) => n > 0)));
      // 球门要"守得住"：高度不超过她身高的一倍半、宽度小于窗口的十分之一
      ok('弹弹乐：球门尺寸按"她守得住"定（高 ≤144px、宽 <10% 窗口）',
        game.goalRect(0).yBottom - game.goalRect(0).yTop <= 144 && (gr2.x1 - gr2.x0) < B.W * 0.10);
      /**
       * 跑动 + 回防：**用一个全新实例、只开球模式、不判进球**来测，彻底躲开前面那些状态
       * （进球会把球自动开走、把比分改掉，之前就是被这个害得"偶发失败"）。
       *   · 球在对面但还追得上 → 她追
       *   · 球深在对面门口（追不上）→ 她跑回自己半场
       */
      /**
       * 走位决策用**纯函数 `game.plan()`** 来测（不再模拟整局）。
       *
       * 为什么换写法：原来这段是"摆一颗球 → 跑一帧 onStep → 看她的走路指令"，
       * 结果被三样东西轮流搅坏 —— 进球判定把球自动开走、开球冷静期吞掉整帧、320ms 节流吞掉指令。
       * 我为此调了十几轮，每轮"失败细节"都不一样（这才是真正的浪费时间）。
       * `plan()` 没有副作用，测起来是确定的。
       */
      for (const def of [0, 1]) {
        const side = def === 0 ? '左' : '右';
        const herHalfX = def === 0 ? B.W * 0.25 : B.W * 0.75;   // 她半场里的一个点
        const oppHalfX = def === 0 ? B.W * 0.75 : B.W * 0.25;   // 对面半场里的一个点
        const midBall = def === 0 ? B.W * 0.55 : B.W * 0.45;    // 对面半场、但**她够得着**（离她 < 34% 窗口）
        const deepBall = def === 0 ? B.W * 0.94 : B.W * 0.06;   // 贴着对面那个门（追不上）

        const inHer = game.plan(herHalfX, 900, def);
        ok(`弹弹乐：球在她半场时她冲过去抢（她守${side}）`, inHer.why === 'intercept' && inHer.x === herHalfX);
        const chase = game.plan(midBall, 900, def);
        ok(`弹弹乐：球在对面但够得着时她继续追（她守${side}）`, chase.why === 'chase' && chase.x === midBall);
        const back = game.plan(deepBall, 900, def);
        const myGoalX = def === 0 ? 0 : B.W;
        ok(`弹弹乐：球贴到对面门口（追不上）时她回自己半场（她守${side}）`,
          back.why === 'defend' && back.run === true && Math.abs(back.x - myGoalX) < B.W * 0.5);
        /**
         * **"在比赛"的三条新保证**（用户要的"抢球/得分/回防均衡"）：
         *   · 球在对面中场、她够不着 → **压到中线附近**（不是缩在门前）
         *   · 她**永远在跑**（没有"站着看"这一档）
         *   · 落后时站得**更靠前**（紧迫度把回防线往前推）
         */
        /**
         * "压上"这一档要**她在自己的回防位置**时才成立（在 x=900 那个位置，"够不着但球在中场"
         * 的区间跟"追球"重叠，测不出区别）。所以这里把她放在门前：
         * 守左 → 她 ≈0.1W；球在对面半场又不贴对面门 → 0.58W，这样 `dSelf` 足够大、`dOpp` 也足够大。
         */
        const guardX = def === 0 ? B.W * 0.10 : B.W * 0.90;
        const pressBall = def === 0 ? B.W * 0.58 : B.W * 0.42;
        const press = game.plan(pressBall, guardX, def);
        const pressWant = def === 0 ? B.W * 0.42 : B.W * 0.58;
        ok(`弹弹乐：够不着时她压到中线附近等（不是缩回门前，她守${side}）`,
          press.why === 'press' && Math.abs(press.x - pressWant) < 40);
        const calm = game.plan(deepBall, 900, def, 0);
        const urgent = game.plan(deepBall, 900, def, 1);
        ok(`弹弹乐：落后时她压得更靠前（紧迫度生效，她守${side}）`,
          Math.abs(urgent.x - myGoalX) > Math.abs(calm.x - myGoalX) + 20);
        ok(`弹弹乐：四档决策她永远在跑（没有站着看这一档，她守${side}）`,
          [inHer, chase, back, press].every((p) => p.run === true));
      }    } catch (err) {
      // 2g-3 自己的兜底：它抛错也算一条失败（别把整份自检带崩）
      ok(`弹弹乐：进球与三态切换（不抛错）—— 实际抛了 ${err && err.message}`, false);
      console.log(`      弹弹乐那段抛错的堆栈：${((err && err.stack) || '').split('\n').slice(0, 4).join(' | ')}`);
    }
  } finally {
    // 这一段（2g）用完就把 DOM 桩收掉，别影响后面的检查
    if (hadDoc) delete globalThis.document; else delete globalThis.document;
    if (hadHost) delete globalThis.petHost; else delete globalThis.petHost;
  }

  /* ---------- 2g-4. 球拍模式：比赛模式里球不能抓、只能打 ---------- */
  /**
   * 用户的想法：**"在比赛模式里球不能抓，只能被鼠标打回去"**。
   * 这一条正好治了赖皮 —— 不能把球拎到门口再放下，只能隔着场地抽进网。
   *
   * 这一段自己准备 DOM 桩（上面那个 `finally` 已经把 2g 的桩收掉了）。
   */
  try {
    if (typeof document === 'undefined') globalThis.document = { createElementNS: () => fakeEl() };
    if (typeof petHost === 'undefined') globalThis.petHost = { report: () => {} };
    try {
      const { createBall } = await import(`${pathToFileURL(path.join(app, 'web', 'ball.js')).href}?smoke=${Date.now()}`);
      const { createGame } = await import(`${pathToFileURL(path.join(app, 'web', 'game.js')).href}?smoke=${Date.now()}`);
      const B = { W: 1280, H: 760, floorY: 758, minX: 0, maxX: 1280, S: 0.42 };
      const pet = { x: 900, faceVis: 1, feetY: B.floorY };
      const ball = createBall({
        fxG: fakeEl(), sfx: {},
        stage: { bounds: () => B, pet: () => pet },
        onEvent: () => {},
        game: { onStep: null, onKick: () => {} },
      });
      const game = createGame({
        fxG: fakeEl(), ball, sfx: {},
        control: { bounds: () => B, pet: () => pet, walkTo() {}, jump() {}, act() {} },
        onEvent: () => {},
      });
      ball.setOn(true, { fromLeft: false });
      game.setMode('game');                    // 先切模式（球拍模式在这里被打开）
      /**
       * ⚠️ 摆球的位置很讲究：`placeAt(0.5, 'floor')` 的高度是**低于门框**的，
       * 而"球在门框高度以下且落在门柱之间"就是进球 —— 我摆球的那一下会被算成进球、球被自动开走
       * （自检就是这么反复"偶发失败"的，真原因跟随机无关）。所以这里用**门框以上的高度**摆球。
       */
      ball.placeAt(0.5, B.floorY - 300, { since: 0 });
      const cx = ball.x, cy = ball.y;
      ok('球拍模式：比赛模式里抓不住球（hitTest 失效）', ball.grabable === false && ball.hitTest(cx, cy) === false);
      ok('球拍模式：抓不住，但仍然"够得着"（不然打不着）', ball.near(cx, cy) === true);
      ball.placeAt(0.5, B.floorY - 300, { since: 0 });
      const beforeX = ball.x;
      /**
       * **轻点也要能打**（用户实测：他只是"点"了一下球、鼠标速度 2px/s，
       * 我最初判"推不动" → 完全没反应）。所以现在的判据是"轻点给一个**小**力度"，
       * 而不是"给 0"。真正防赖皮靠的是 `hitTest` 永远不通过（球拖不走），不是靠"推不动"。
       */
      const tap = ball.swat({ x: 40, y: 0 }, 2);
      ok('球拍模式：轻轻点一下也能把球推出去（实测两轮定下来的手感）',
        tap >= 300 && ball.state.vx !== 0);
      // 而且球**不能被拖着走**：拖动接口在球拍模式下不生效（grabable=false 时 drag 也只当没抓住）
      ball.placeAt(0.5, B.floorY - 300, { since: 0 });
      ok('球拍模式：球不会被"抓住拖着走"（防赖皮的真正保障）',
        ball.grabable === false && ball.hitTest(ball.x, ball.y) === false && Math.abs(ball.x - beforeX) < 1);
      ball.placeAt(0.5, B.floorY - 300, { since: 0 });
      const fast = ball.swat({ x: 1, y: -0.2 }, 1200);     // 用力抽：球飞出去
      ok('球拍模式：甩得快球就被打出去（而且比轻点更猛）',
        fast > 300 && fast > tap && ball.state.vx > 0 && ball.state.resting === false);

      /**
       * ★ **核心机制：鼠标扫过球就踢（不需要点击）**。
       *
       * 这是用户实测后定的新模型（原话："鼠标接触球就跟小人踢出去一样的状态"）。
       * 判据：把光标从球的一侧"扫"到另一侧，**一帧之内**球就该被踢出去、方向跟着扫动方向。
       * 这里用两次 `setCursor` 造出"上一帧 → 这一帧"的扫掠线段，再走一帧物理。
       */
      ball.placeAt(0.5, 'floor', { since: 0 });
      const kx = ball.x, ky = ball.y;
      // 左 → 右扫过球（用真实时间戳，让球自己算扫掠速度）
      const t0 = performance.now();
      ball.setCursor(kx - 60, ky, t0);
      ball.setCursor(kx + 60, ky, t0 + 16);
      for (let i = 0; i < 3; i += 1) ball.step(1 / 60);
      ok('球拍模式：★鼠标扫过球就把它踢出去（不需要点击）',
        ball.state.vx > 50 && ball.state.resting === false);
      ok('球拍模式：★踢出去的方向跟着鼠标扫动的方向（往右扫 → 往右飞）', ball.state.vx > 0);
      game.setMode('ball');
      ok('球拍模式：回到自由玩球时又能抓了', ball.grabable === true);
      game.setMode('off');
    } catch (err) {
      ok(`球拍模式：抓/打的行为（不抛错）—— 实际抛了 ${err && err.message}`, false);
    }
  } finally {
    if (hadDoc) delete globalThis.document; else delete globalThis.document;
    if (hadHost) delete globalThis.petHost; else delete globalThis.petHost;
  }

  /* ---------- 2g-5. 弹弹乐：头球 / 计分方向 / 地面滚动 / 球拍方向（用户实测报的四件事） ---------- */
  /**
   * 这一批全是"用户实测报上来的现象"，而且**原来一条动态检查都没有**：
   *
   *   · "桌宠一直无法头球" —— `pet-app.js` 给 `ctl.act` 传的是**数组**，
   *     而 `pet-core` 的 `act` 是 `switch (字符串)` → 落 `default: return false`，
   *     她**一次都没跳过** → `pet.fy` 永远在地面 → `ball.js` 的 `headBox()` 恒 null。
   *   · "球进她的门却算她得分" —— `scorer = 1 - side` 只在"她守右边"时对，
   *     而守哪边是开局掷硬币 → 一半的球局计分是反的。
   *   · "球一沾地就停死" —— 地面摩擦写成了"每帧乘 0.86"，等于每秒乘 60 次（实测只滚 46px）。
   *   · "往右慢扫球往左滚" —— 短扫动的兜底方向取的是"手在球的哪一侧"，跟你的移动方向无关。
   */
  try {
    if (typeof document === 'undefined') globalThis.document = { createElementNS: () => fakeEl() };
    if (typeof petHost === 'undefined') globalThis.petHost = { report: () => {} };
    try {
      const B = { W: 1280, H: 760, floorY: 758, minX: 0, maxX: 1280, S: 0.42 };
      const W = B.W;
      // 这一段自己 import（前面那些块的 `const { createBall }` 是各自块里的作用域）
      const { createBall } = await import(`${pathToFileURL(path.join(app, 'web', 'ball.js')).href}?smoke=${Date.now()}`);
      const { createGame } = await import(`${pathToFileURL(path.join(app, 'web', 'game.js')).href}?smoke=${Date.now()}`);

      /* --- ① 跳跃指令必须是字符串（她真的能被叫起来跳） --- */
      ok('弹弹乐：★跳跃指令传的是字符串 `ctl.act(\'jump\')`（传数组会被 act 的 switch 丢掉，她一次都跳不起来）',
        /jump:\s*\(\)\s*=>\s*ctl\.act\('jump'\)/.test(appSrc));
      /**
       * 她"罚站"那条：`return`（不走位）必须**只在真的起跳/已经在空中**时发生。
       * 老写法只要 `canHead` 成立就 return，而那时 jump 是空操作 → 球一来她站着不动。
       */
      const gameSrc2 = fs.readFileSync(path.join(app, 'web', 'game.js'), 'utf8');
      ok('弹弹乐：★"能不能顶到球"不再直接吞掉走位（只在真跳起来或已在空中时才停下）',
        /if \(canHead && \(jumped \|\| sheAir\)\) return;/.test(gameSrc2));
      ok('弹弹乐：球拍的"自家门"护栏换到了她进攻的那一侧（原来护的是你要打的门，你一挥就被掉头）',
        /const ownGoalX = b\.minX \+ aim\.x \* \(b\.maxX - b\.minX\)/.test(
          fs.readFileSync(path.join(app, 'web', 'ball.js'), 'utf8')));

      /* --- ② 头箱位置：球在"她头上那片"才算法头球，在她脚边不算 --- */
      const mkBall = ({ pet, heads }) => createBall({
        fxG: fakeEl(), sfx: {},
        stage: { bounds: () => B, pet: () => pet },
        onEvent: (k, d) => { if (k === 'ballHead') heads.push(d); },
        game: null,
      });
      {
        // 她腾空 40px：头箱覆盖离地 100~190（脚底往上 60~150）
        const air = { x: 640, faceVis: 1, feetY: B.floorY - 40 };
        const headsHi = [];
        const bHi = mkBall({ pet: air, heads: headsHi });
        bHi.setOn(true, { fromLeft: true });
        bHi.placeAt(0.5, B.floorY - 150, { since: 0 });
        for (let i = 0; i < 3; i += 1) bHi.step(1 / 60);
        ok('弹弹乐：★球飞到她头顶那一片（她腾空 40px、球离地 150px）→ 判成头球',
          headsHi.length >= 1 && headsHi[0].high >= 100);

        const headsLo = [];
        const bLo = mkBall({ pet: air, heads: headsLo });
        bLo.setOn(true, { fromLeft: true });
        bLo.placeAt(0.5, B.floorY - 30, { since: 0 });
        for (let i = 0; i < 3; i += 1) bLo.step(1 / 60);
        ok('弹弹乐：★球在她脚边（离地 30px、她腾空 40px）→ 不算头球（那是"踢"，不是"顶"）',
          headsLo.length === 0);
      }

      /* --- ③ 头球端到端：真 ball.js + 真 game.js + 一个"会跳的她"（照 pet-core 抄的模型） --- */
      {
        /** 照 `pet-core.js` 抄：act('jump') → 蹲 0.16s → vy=-720、空中重力 2300 → 落地。 */
        const simPet = (x) => ({
          x, x0: x, maxDx: 0, fy: B.floorY, vy: 0, mode: 'idle', modeT: 0, target: x,
          busy() { return this.mode === 'air' || this.mode === 'crouch' || this.mode === 'drag'; },
          walkTo(x2) { if (this.busy()) return false; this.target = Math.max(24, Math.min(W - 24, x2)); this.mode = 'run'; return true; },
          act(a) {
            if (this.busy()) return false;
            if (a === 'jump') { this.mode = 'crouch'; this.modeT = 0; return true; }
            return false;
          },
          step(dt) {
            this.modeT += dt;
            if (this.mode === 'crouch') { if (this.modeT > 0.16) { this.vy = -720; this.mode = 'air'; this.modeT = 0; } }
            else if (this.mode === 'air') {
              this.vy += 2300 * dt; this.fy += this.vy * dt;
              if (this.fy >= B.floorY && this.vy > 0) { this.fy = B.floorY; this.vy = 0; this.mode = 'idle'; }
            } else if (this.mode === 'run') {
              const d = this.target - this.x, s = Math.sign(d) * Math.min(250, Math.abs(d) * 6 + 20) * dt;
              if (Math.abs(d) <= Math.abs(s)) { this.x = this.target; this.mode = 'idle'; } else this.x += s;
            }
            this.maxDx = Math.max(this.maxDx, Math.abs(this.x - this.x0));
          },
        });
        // 注意：`Math.random` 里还有 defence 的随机，**不能全局 stub**（会把下面那个 do/while 冻死）。
        // 头球骰子走 `gm.debug.headForce`（自检专用开关）。
        const headRun = (def, vx, vy, force) => {
          const pet = simPet(def === 0 ? W * 0.28 : W * 0.72);
          const heads = [];
          const bl = createBall({
            fxG: fakeEl(), sfx: {},
            stage: { bounds: () => B, pet: () => ({ x: pet.x, faceVis: 1, feetY: pet.fy }) },
            onEvent: (k, d) => { if (k === 'ballHead') heads.push(d); },
            game: { onStep: (s) => gm.onStep(s), onKick: (i) => gm.onKick(i) },
          });
          const gm = createGame({
            fxG: fakeEl(), ball: bl, sfx: {},
            control: {
              bounds: () => B, pet: () => ({ x: pet.x, faceVis: 1, feetY: pet.fy }),
              walkTo: (x) => pet.walkTo(x * W), jump: () => pet.act('jump'), act: (a) => pet.act(a),
              move: () => ({ mode: pet.mode, speed: 200, target: pet.target, feetY: pet.fy }),
            },
            onEvent: () => {},
          });
          bl.setOn(true, { fromLeft: true });
          // 有界（别写成 while，自检卡死比断言失败难查得多）
          for (let i = 0; i < 60 && gm.defence !== def; i += 1) { gm.setMode('off'); gm.setMode('game'); }
          gm.debug.headForce = force;
          bl.placeAt(0.62, B.floorY - 13, { vx, vy, since: 0 });
          gm.debug.noGoal = performance.now() + 9e9;      // 这一轮不关心进球
          gm.debug.scoreCool = performance.now() + 9e9;
          for (let f = 0; f < 200; f += 1) { pet.step(1 / 60); bl.step(1 / 60); }
          return { heads, mode: pet.mode, x: pet.x, maxDx: pet.maxDx };
        };
        const r1 = headRun(0, -500, -550, true);      // 判定"顶"
        const r2 = headRun(0, -600, -750, true);
        const rNo = headRun(0, -500, -550, false);    // 判定"不顶"
        ok('弹弹乐：★端到端——高球飞过来，她**真的会跳、而且真的顶到**（球从她头顶那片弹回去）',
          r1.heads.length + r2.heads.length >= 1
          && r1.heads.concat(r2.heads).every((h) => h.high >= 100));
        /**
         * ★ **判定"不顶"的时候她不许罚站**：这一球她顶不到，但她要继续跑
         * （玩家的活路：快球 / 反方向 / 趁她腾空）。
         * 判据用**整段里她离起点最远**跑了多少，而不是"结束时在哪" ——
         * 结束位置取决于她最后停在哪个走位档上（`press` 会停在中线），不稳。
         */
        ok(`弹弹乐：★判定"不顶"时她照常追球、不跳（这一球顶不到 = 你能打过去）—— 头球 ${rNo.heads.length} 次、她最远跑到 ${Math.round(rNo.maxDx)}px`,
          rNo.heads.length === 0 && rNo.maxDx > 40);
      }

      /* --- ④ 计分方向：球进她守的门 = 你得分（两个 defence 都要对） --- */
      {
        const touches = [];
        const paddleTouches = [];
        const freezes = [];
        const stub = {
          on: true, x: W * 0.5, y: B.floorY - 13, vx: 0, vy: 0, resting: true, dragging: false,
          releasedAt: 0, lastRelease: 0,
          setOn() {}, setAim() {}, setGrabable() {}, setHerTouch(on) { touches.push(!!on); },
          setPaddleTouch(on) { paddleTouches.push(!!on); },
          setFrozen(on) { freezes.push(!!on); }, setCelebrate() {},
          placeAt(fx) { stub.x = B.minX + fx * W; },
        };
        const ev = [];
        const gm = createGame({
          fxG: fakeEl(), ball: stub, sfx: {},
          control: {
            bounds: () => B, pet: () => ({ x: W * 0.5, faceVis: 1, feetY: B.floorY }),
            walkTo() {}, jump() {}, act() {}, move: () => ({ mode: 'idle', speed: 0, feetY: B.floorY }),
          },
          onEvent: (k, d) => ev.push({ k, d }),
        });
        const frame = (x) => gm.onStep({
          dt: 1 / 60, x, y: B.floorY - 30, vx: 0, vy: 0, resting: false, dragging: false, floorY: B.floorY, R: 13,
        });
        /** 庆祝（1 秒）走完：合成测试跑得比真实时间快，把截止时刻拨到过去再走一帧，开球才会发生。 */
        const endCelebrate = (x) => { gm.debug.celebrateUntil = performance.now() - 1; frame(x); };
        for (const def of [0, 1]) {
          for (let i = 0; i < 60 && gm.defence !== def; i += 1) { gm.setMode('off'); gm.setMode('game'); }
          gm.debug.score[0] = 0; gm.debug.score[1] = 0;
          gm.debug.noGoal = 0; gm.debug.scoreCool = 0;
          const gr = gm.goalRect(def);
          stub.x = (gr.x0 + gr.x1) / 2;
          ev.length = 0;
          frame(stub.x);
          const goal = ev.find((e) => e.k === 'goal');
          ok(`弹弹乐：★球进她守的门（defence=${def}）算**你**得分`,
            !!goal && goal.d.scorer === 0 && goal.d.score[0] === 1 && goal.d.score[1] === 0);
          /**
           * ★ **进球那一刻球被冻在网里**（庆祝 1 秒的第一条）：不再"同一帧就把球挪走"。
           * 用户的原话"得分我们还没弄"里就包括这个 —— 原来进球你根本看不见球进网。
           */
          ok('弹弹乐：★进球那一刻球被冻在网里（庆祝 1 秒里谁都不碰它）',
            freezes[freezes.length - 1] === true && Math.abs(stub.x - (gr.x0 + gr.x1) / 2) < 2);
          endCelebrate(stub.x);                            // 庆祝走完才开球
        }
        // 反过来：球进你自己的门，她得分
        for (let i = 0; i < 60 && gm.defence !== 0; i += 1) { gm.setMode('off'); gm.setMode('game'); }
        gm.debug.score[0] = 0; gm.debug.score[1] = 0;
        gm.debug.noGoal = 0; gm.debug.scoreCool = 0;
        const grMine = gm.goalRect(1);
        stub.x = (grMine.x0 + grMine.x1) / 2;
        ev.length = 0;
        frame(stub.x);
        const own = ev.find((e) => e.k === 'goal');
        ok('弹弹乐：★球进**你自家**的门，算她得分（"进谁的网、对面得一分"）',
          !!own && own.d.scorer === 1 && own.d.score[1] === 1);
        endCelebrate(stub.x);                              // 庆祝走完才开球
        /**
         * ★ **复位点回到"失球那侧门前"**（用户定的规则 + 他后来的确认）。
         * 球要落在门框**外面**（落在门里下一帧又判进球 → 卡死），且离那个门不远（≈128px）。
         * 注意：真正防"她刚进完球又原地一脚"的是 `RETREAT_MS`（进球方退回自己半场），不是复位点。
         */
        const lastGoalSide = own.d.side;
        const grSide = gm.goalRect(lastGoalSide);
        const outside = stub.x < grSide.x0 - 1 || stub.x > grSide.x1 + 1;
        const nearBy = Math.min(Math.abs(stub.x - grSide.x0), Math.abs(stub.x - grSide.x1)) < 200;
        ok(`弹弹乐：★复位点回到"失球那侧门前"（球在 ${Math.round(stub.x)}px、那个门 ${Math.round(grSide.x0)}~${Math.round(grSide.x1)}px）`,
          outside && nearBy);
        /**
         * ★ **进球方退回自己半场**（用户定的规则，`RETREAT_MS`）：
         *   · 她进球 → 关掉她的"碰球"（`setHerTouch(false)`）→ 球归你开，不会被原地再捅一脚；
         *   · 你碰到球（`onKick({by:'player'})`）→ 立刻还给她 → 她回来抢。
         * 没有这条，真机日志里她一分钟能刷 23 个球。
         */
        touches.length = 0;
        for (let i = 0; i < 60 && gm.defence !== 0; i += 1) { gm.setMode('off'); gm.setMode('game'); }
        gm.debug.score[0] = 0; gm.debug.score[1] = 0;
        gm.debug.noGoal = 0; gm.debug.scoreCool = 0;
        const grHer = gm.goalRect(1 - gm.defence);          // 她进攻的那个门
        stub.x = (grHer.x0 + grHer.x1) / 2;
        ev.length = 0;
        frame(stub.x);
        const mine = ev.find((e) => e.k === 'goal');
        ok('弹弹乐：★她进球之后，她的"碰球"当场关掉（要退回自己半场，不能原地再捅一脚）',
          !!mine && mine.d.scorer === 1 && touches[touches.length - 1] === false);
        gm.onKick({ x: stub.x, power: 400, by: 'player' });   // 你开球了
        ok('弹弹乐：★你碰到球之后，立刻把"碰球"还给她（否则球在你脚下、她站自己半场，游戏就死了）',
          touches[touches.length - 1] === true);
        endCelebrate(stub.x);                              // ★ 她那个球的庆祝也要走完，否则下一帧都在庆祝里
        /**
         * ★ **开球权**（`KICKOFF_HOLD_MS`，用户定的方案 a）：**你进球之后，你的球拍 1.5 秒内碰不到这颗球**
         * —— 否则你可以守在她门口把复位球一扫再进（真机实测比分一度 你30:她14，一半是这么刷的）。
         * 她碰到球（或等超时）就还给你。
         */
        paddleTouches.length = 0;
        for (let i = 0; i < 60 && gm.defence !== 0; i += 1) { gm.setMode('off'); gm.setMode('game'); }
        gm.debug.score[0] = 0; gm.debug.score[1] = 0;
        gm.debug.noGoal = 0; gm.debug.scoreCool = 0;
        const grYourGoal = gm.goalRect(gm.defence);        // 你的球门 = 她守的那个
        stub.x = (grYourGoal.x0 + grYourGoal.x1) / 2;
        ev.length = 0;
        frame(stub.x);
        const yours = ev.find((e) => e.k === 'goal');
        ok(`弹弹乐：★你进球之后，你的球拍当场被关掉（开球权给她，防"门口刷分"）—— scorer=${yours ? yours.d.scorer : '没进球'} · 球拍最后=${paddleTouches[paddleTouches.length - 1]} · 球在 ${Math.round(stub.x)}px`,
          !!yours && yours.d.scorer === 0 && paddleTouches[paddleTouches.length - 1] === false);
        /**
         * ★ **她碰到球不再立刻解禁**（用户实测："她开的第一球我刷分的概率超级高"）：
         * 复位点就在她门口、也是你的射门点，而"她一碰就还给你"实测 **20ms 就还了** → 你一扫又进。
         * 现在按**位置**解禁：球离开她的防区（`KICKOFF_CLEAR` 个窗口宽 ≈ 384px）才还给你。
         */
        gm.onKick({ x: stub.x, power: 500 });              // 她来开球了（她碰到球 → 不带 by）
        ok('弹弹乐：★她碰到球**不再**立刻解禁（那正是"门口刷分"的来源）',
          paddleTouches[paddleTouches.length - 1] === false);
        endCelebrate(stub.x);                              // 庆祝走完 → 开球
        stub.x = W * 0.5;                                  // 球被她踢到中场 = 离开她的防区
        frame(stub.x);
        ok('弹弹乐：★球离开她的防区之后，开球权才还给你（实测按位置解禁）',
          paddleTouches[paddleTouches.length - 1] === true);
      }

      /* --- ⑧ 得分：比分牌 / 进球庆祝 / 进球音 / 心情（用户："得分我们还没弄"） --- */
      {
        const gsrc = fs.readFileSync(path.join(app, 'web', 'game.js'), 'utf8');
        const cssSrc = fs.readFileSync(path.join(app, 'web', 'pet.css'), 'utf8');
        const coreSrc = fs.readFileSync(path.join(app, 'web', 'pet-core.js'), 'utf8');
        const htmlSrc = fs.readFileSync(path.join(app, 'web', 'pet.html'), 'utf8');
        ok('弹弹乐：★比分牌画在场上（顶部居中的 `toy-score`，分数每帧写在 draw 里）',
          /toy-score/.test(gsrc) && /scoreYou\.textContent/.test(gsrc) && /\.toy-score-bg\{/.test(cssSrc));
        ok('弹弹乐：★进球有庆祝段（`CELEBRATE_MS`：球冻在网里 + 门上方弹大字 + 门白闪抖动 + 窗口内圈发光）',
          /const CELEBRATE_MS = \d+/.test(gsrc) && /setFrozen\?\.\(true\)/.test(gsrc)
          && /toy-goal-text/.test(gsrc) && /toy-goal-shake/.test(cssSrc)
          && /#goalGlow/.test(cssSrc) && /id="goalGlow"/.test(htmlSrc));
        /**
         * ★ **进球音效以前根本不存在**：`game.js` 一直在调 `sfx?.goal?.()`，
         * 而 pet-core 的 `sfx` 里没有这个方法 —— 可选链让它静静地什么都不做（=进球没声音）。
         */
        ok('弹弹乐：★进球音效真的存在（`goal` 上行 / `concede` 下行，都在 pet-core 的 sfx 里）',
          /^ {4}goal\(\) \{/m.test(coreSrc) && /^ {4}concede\(\) \{/m.test(coreSrc));
        /**
         * ★ **输赢意识的第一小步**：进球/失球轻轻推一下她的心情（数值很小 —— 一局十几个球也不会推到底）。
         * 动态那半条用**方向**断言（`clamp01` 会让"已经满了"时不动）：
         * 进球之后 love 不低于原来；再失球之后不高于进球之后。
         */
        const moodBefore = mood.snapshot().love;
        mood.onEvent('goal');
        const moodGoal = mood.snapshot().love;
        mood.onEvent('concede');
        const moodCon = mood.snapshot().love;
        ok(`弹弹乐：★进球/失球真的会推动心情（love ${moodBefore.toFixed(3)} → 进球 ${moodGoal.toFixed(3)} → 失球 ${moodCon.toFixed(3)}）`,
          moodGoal >= moodBefore && moodCon <= moodGoal
          && /goal: \{ love: \+0?\.0/.test(fs.readFileSync(path.join(app, 'mood.cjs'), 'utf8')));
      }

      /* --- ⑨ 她的实力旋钮（用户："比分差距还是有点大……改成 65 左右，或者想办法提升她的胜率"） --- */
      {
        const gsrc = fs.readFileSync(path.join(app, 'web', 'game.js'), 'utf8');
        const coreSrc2 = fs.readFileSync(path.join(app, 'web', 'pet-core.js'), 'utf8');
        ok('弹弹乐：★头球率 65%（`HEAD_HARD`，用户定的；真机量到过 54.8%）',
          /const HEAD_HARD = 0\.65/.test(gsrc));
        /**
         * ★ **她追球带提前量**：原来 `goTo(s.x)` 只追"球现在在哪"，而她 250px/s、球 300~700px/s
         * → 永远差一截（这正是 `你27 : 她8` 的主因）。现在追 `leadX`（球 + 0.25 秒）。
         */
        ok('弹弹乐：★她追球带提前量（`CHASE_LEAD_S`；球停着时提前量自动为 0）',
          /const CHASE_LEAD_S = 0?\.\d+/.test(gsrc)
          && /goTo\(leadX, firstTouch, true\)/.test(gsrc) && /plan\(leadX,/.test(gsrc));
        ok('弹弹乐：★比赛里给她一点跑速加成，**离开比赛自动回 1**（不然桌面上溜达也会变快）',
          /setRaceBoost\(k\) \{/.test(coreSrc2) && /250 \* raceBoost/.test(coreSrc2)
          && /setRaceBoost\(mode === 'game' \? RACE_BOOST : 1\)/.test(appSrc));
      }

      /* --- ⑩ 右键菜单：按钮点不动 + 菜单头是上游形象（用户实测报的） --- */
      {
        const appSrc2 = fs.readFileSync(path.join(app, 'web', 'pet-app.js'), 'utf8');
        /**
         * ★ **"菜单里的按钮全部失效"的根因**：窗口拿鼠标的判定原来只量 `#tools`，
         * 而菜单一开 `#tools` 就被隐藏（`tools.hidden = !(… && menu.hidden …)`）；
         * 菜单又开在光标**上方**，所以往上移进菜单时必然判成"不在按钮上"
         * → 页面把鼠标还给桌面 → 点击穿透，一个都点不动。
         */
        ok('★右键菜单：拿鼠标的判定必须把**菜单**也算进去（原来只量 #tools，而菜单一开 tools 就隐藏）',
          /function overUI\(p\)/.test(appSrc2) && /\[tools, menu\]/.test(appSrc2)
          && /if \(overUI\(p\)\) return true;/.test(appSrc2) && !/if \(overTools\(p\)\) return true;/.test(appSrc2));
        /**
         * ★ **菜单头的头像**：`pet.cjs` 的 `INIT.bot` 里**没有 `avatar` 字段**，
         * 所以旧代码 `bot.avatar ? <img …> : mini(…)` 永远走 else —— 画的是内置的**上游 Coo**。
         * 现在默认就是小肥鱼（`/api/avatar` = `web\avatar.png`），只有图加载失败才退回 SVG。
         */
        ok('★菜单头像是我们的小肥鱼（`/api/avatar`），不再取决于有没有 `bot.avatar`',
          /const av = head\.querySelector\('\.m-avatar'\)/.test(appSrc2)
          && /av\.innerHTML = `<img alt="" src="\/api\/avatar/.test(appSrc2)
          && /avImg\.addEventListener\('error'/.test(appSrc2));
        /**
         * **行为验证**（不只查字符串）：把 `overUI` 抠出来，喂给它假的 `tools` / `menu` 量一下 ——
         * 菜单打开时，光标落在菜单矩形里必须为 true（= 窗口会拿鼠标，按钮才点得动），
         * 落在外面的空地上必须为 false（不然整个桌面都被窗口挡住、点不了别的）。
         */
        const overSrc = appSrc2.match(/function overUI\(p\) \{[\s\S]*?\n\}/);
        const elAt = (rect, hidden) => ({ hidden, getBoundingClientRect: () => rect });
        const over = (menuOpen, x, y) => new Function('tools', 'menu', 'document',
          `${overSrc[0]}; return overUI({ x: ${x}, y: ${y} });`)(
          elAt({ left: 0, top: 0, right: 60, bottom: 40, width: 60 }, true),
          elAt({ left: 100, top: 100, right: 260, bottom: 300, width: 160 }, !menuOpen),
          { elementFromPoint: () => null });
        ok('★右键菜单（行为）：光标在菜单矩形里 → 收鼠标；在空地上 → 放过去（菜单开着也成立）',
          !!overSrc && over(true, 180, 200) === true && over(true, 20, 300) === false && over(false, 180, 200) === false);
      }

      /* --- ⑤ 球在地上要能滚（不是一沾地就停死） --- */
      {
        const bl = createBall({
          fxG: fakeEl(), sfx: {},
          // 她站在球**后面**（x=60、脸朝右 → 碰撞盒右沿 112 < 球左沿 115），这样这一条量的是纯滚动
          stage: { bounds: () => B, pet: () => ({ x: 60, faceVis: 1 }) },
          game: null,
        });
        bl.setOn(true, { fromLeft: true });
        bl.placeAt(0.1, 'floor', { vx: 400, since: 0 });
        const x0 = bl.x;
        let n = 0;
        while (n < 300 && !bl.resting) { bl.step(1 / 60); n += 1; }
        const rolled = Math.round(bl.x - x0);
        ok(`玩具球：★贴地 400px/s 要能滚起来（实测滚了 ${rolled}px；原来每帧乘一次 0.86，只滚 46px）`,
          rolled > 200);
      }

      /* --- ⑥ 球拍方向：往右扫 → 往右飞（慢扫、以及"她守右边"那一半都要对） --- */
      {
        /** 慢扫：光标每帧 10px 往右，第一次接触时手还在球心左侧。 */
        const sweepRightSlow = ({ ballFx, aimX }) => {
          const bl = createBall({
            fxG: fakeEl(), sfx: {},
            stage: { bounds: () => B, pet: () => ({ x: 640, faceVis: 1, feetY: B.floorY }) },
            game: null,
          });
          bl.setOn(true, { fromLeft: true });
          bl.setGrabable(false);
          bl.setAim({ x: aimX, power: 1 });
          bl.placeAt(ballFx, 'floor', { since: 0 });
          const bx = bl.x, by = bl.y;
          let t = 1000;
          const send = (dx) => { t += 1000 / 60; bl.setCursor(bx + dx, by, t); bl.step(1 / 60); };
          for (let dx = -120; dx < -40; dx += 10) send(dx);        // 慢慢靠近（每帧 10px = 600px/s，够慢）
          for (let dx = -40; dx <= -10; dx += 10) send(dx);        // 接触那几帧：手仍在球心左侧
          return bl.state.vx;
        };
        // 她守右（aim.x=0）：这是原来一定会被"自家门护栏"掉头的那一半
        const vx1 = sweepRightSlow({ ballFx: 0.8, aimX: 0 });
        ok(`弹弹乐：★往右慢扫 → 球往右滚（原来"手还在球心左边"就把球往左推；实测 vx=${Math.round(vx1)}）`,
          vx1 > 0);
        const vx2 = sweepRightSlow({ ballFx: 0.5, aimX: 1 });
        ok(`弹弹乐：★往右慢扫（另一半场）也往右滚（实测 vx=${Math.round(vx2)}）`, vx2 > 0);
        /** 护栏仍然要在**自家门口那一小块**起作用：球就在自家门线前，往门里扫要被掰回来。 */
        const vx3 = (() => {
          const bl = createBall({
            fxG: fakeEl(), sfx: {},
            stage: { bounds: () => B, pet: () => ({ x: 640, faceVis: 1, feetY: B.floorY }) },
            game: null,
          });
          bl.setOn(true, { fromLeft: true });
          bl.setGrabable(false);
          bl.setAim({ x: 1, power: 1 });                 // 她进攻右门 → 你家门在右边
          bl.placeAt(0.94, 'floor', { since: 0 });       // 站在自家门线前那一小块（0.18W 之内）
          const bx = bl.x, by = bl.y;
          let t = 2000;
          const send = (dx) => { t += 1000 / 60; bl.setCursor(bx + dx, by, t); bl.step(1 / 60); };
          for (let dx = -120; dx < -70; dx += 10) send(dx);
          for (let dx = -70; dx <= -40; dx += 10) send(dx);   // 往右扫 = 往自家门里扫
          return bl.state.vx;
        })();
        ok(`弹弹乐：自家门口往门里扫仍然会被掰回来（防乌龙；实测 vx=${Math.round(vx3)}）`, vx3 < 0);
      }

      /* --- ⑦ ★ 球**停着**的时候，游戏也必须每帧收到帧（否则她收不到走路指令 →"复位后她不踢"） --- */
      /**
       * 真因：`ball.js` 的静止分支原来直接 `return`，而 `game.onStep` 那个钩子写在函数**末尾**
       * → 球一停，游戏一帧都收不到 → 她收不到任何走路指令。
       * 而**开球就是把球静止放在地上**（`placeAt(..., 'floor')`）——所以"复位后她有时不踢"
       * 只在"她恰好站在球边上"时才踢得到（`kickIfTouching` 在静止分支里照常跑），离得远就永远站着。
       */
      {
        let hooked = 0;
        const bl = createBall({
          fxG: fakeEl(), sfx: {},
          stage: { bounds: () => B, pet: () => ({ x: 400, faceVis: 1, feetY: B.floorY }) },
          game: { onStep: () => { hooked += 1; }, onKick: () => {} },
        });
        bl.setOn(true, { fromLeft: true });
        bl.placeAt(0.6, 'floor', { since: 0 });         // 开球就是这么摆的：静止、离她 368px
        const wasResting = bl.state.resting === true;
        for (let i = 0; i < 30; i += 1) bl.step(1 / 60);
        ok(`弹弹乐：★球**停着**的时候游戏照样每帧收到（30 帧收到 ${hooked} 次，摆好时 resting=${wasResting}）—— 少了这条，开球后她收不到走路指令就不去踢`,
          wasResting && hooked >= 30);
      }
    } catch (err) {
      ok(`弹弹乐：头球/计分/滚动/球拍方向（不抛错）—— 实际抛了 ${err && err.message}`, false);
    }
  } finally {
    if (hadDoc) delete globalThis.document; else delete globalThis.document;
    if (hadHost) delete globalThis.petHost; else delete globalThis.petHost;
  }


  /* ---------- 2h. 页面代码里的"跨函数引用"（纯 Node 也能盯住的致命笔误） ---------- */
    /**
     * **这条是为一次真实翻车加的**：`microK` 在 `step()` 里声明，却被 `render()` 用了 ——
     * 而 `render()` 是在**帧循环**里被调的，所以它每一帧抛 `ReferenceError`，
     * **整条帧循环当场死掉**：她停在最后一帧、不再动、也不再接鼠标。
     * 症状（"坐着不动、点也没反应"）跟"卡死"一模一样，而 `node --check` 语法完全通过、
     * 主进程日志也一切正常 —— 只有页面里的异常才知道。
     *
     * 所以这里做一条**静态作用域检查**：把 pet-core 里 `render()` 的函数体切出来，
     * 断言它不引用那些"只在别的函数里声明"的名字。
     */
    /** 从 `function name(` 起，按大括号配对切出函数体。 */
    const bodyOf = (src, name) => {
      const at = src.indexOf(`function ${name}(`);
      if (at < 0) return null;
      const open = src.indexOf('{', at);
      let depth = 0;
      for (let i = open; i < src.length; i += 1) {
        if (src[i] === '{') depth += 1;
        else if (src[i] === '}') { depth -= 1; if (!depth) return src.slice(open, i + 1); }
      }
      return null;
    };
    const renderBody = bodyOf(coreSrc, 'render');
    const stepBody = bodyOf(coreSrc, 'step');
    ok('pet-core：render() 切得出来（切不出来说明函数被人重命名了，这条守卫会失效）', !!renderBody && renderBody.length > 500);
    ok('pet-core：step() 切得出来', !!stepBody && stepBody.length > 500);
    /** 剥掉注释再查：注释里写 `microK`（比如解释这个坑）不算引用。 */
    const codeOnly = (s) => String(s || '').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
    const renderCode = codeOnly(renderBody);
    // `microK` 是 step 的局部变量，render 里用了就是 ReferenceError（每帧一次、帧循环死）
    ok('pet-core：render() 不引用 step() 的局部变量 microK（曾经因此整条帧循环死掉）',
      !!renderCode && !/(?<![A-Za-z_$.])microK(?![A-Za-z_$])/.test(renderCode));
    // render 里用到的每个 micro/mood 名字，都必须是 createPet 作用域里的变量
    // （`microTilt:` 这种**对象键名**不算引用，排除掉）
    const names = [...new Set(renderCode.match(/(?<![A-Za-z_$.])(micro[A-Za-z]*|mood)(?![A-Za-z_$])/g) || [])]
      .filter((n) => {
        const at = renderCode.indexOf(n);
        return renderCode[at + n.length] !== ':';
      });
    const declaredAtTop = ['microState', 'mood'];
    ok(`pet-core：render() 引用的变量都在作用域内（${names.join('/') || '无'}）`,
      names.every((n) => declaredAtTop.includes(n) || renderCode.includes(`const ${n}`) || renderCode.includes(`let ${n}`)));
    // 前端入口必须挂上全局错误捕获（这次就是靠它才看见 microK 的）
    ok('页面入口导入了诊断模块（全局错误捕获）',
      /from '\.\/diag\.js'/.test(fs.readFileSync(path.join(app, 'web', 'pet-app.js'), 'utf8')));
    ok('诊断模块真的装了 error / unhandledrejection 监听',
      /addEventListener\('error'/.test(fs.readFileSync(path.join(app, 'web', 'diag.js'), 'utf8'))
      && /addEventListener\('unhandledrejection'/.test(fs.readFileSync(path.join(app, 'web', 'diag.js'), 'utf8')));

    /* ---------- 2i. 图标与名字（顺带盯住"补丁有没有落到位"） ---------- */
    const root = path.join(__dirname, '..');
    for (const f of ['app-icon.png', 'tray-icon.png', 'avatar.png', 'icon-source.png']) {
      ok(`图标文件在（web\\${f}）`, fs.existsSync(path.join(app, 'web', f)));
    }
    const pkg = JSON.parse(fs.readFileSync(path.join(app, 'package.json'), 'utf8'));
    ok('产品名是 Blue Fish Deskpet', pkg.productName === 'Blue Fish Deskpet' && pkg.name === 'blue-fish-deskpet');
    // main.cjs 靠这个字面量认出"哪个窗口是设置窗"，跟 settings.cjs 里的标题必须**一字不差**，
    // 否则重复启动时会把设置窗当成桌宠叫出来（或者找不到窗口）。
    const mainSrc = fs.readFileSync(path.join(app, 'main.cjs'), 'utf8');
    const setSrc = fs.readFileSync(path.join(app, 'settings.cjs'), 'utf8');
    const setTitle = (setSrc.match(/title: '([^']*· 设置)'/) || [])[1] || '';
    ok('找桌宠窗口用的标题跟设置窗标题一致', setTitle !== '' && mainSrc.includes(`!== '${setTitle}'`));
    // 上游文件上的六处改动是 extract-pet.ps1 抽资源时由 tools\patch-assets.mjs 套上的，
    // 这里逐条确认它们**现在真的在**。同时这也盯住 patch-assets.mjs 的 marker：
    // marker 必须真的出现在对应文件里，否则那个文件永远不会被"跳过"、重跑时会直接报错。
    const PATCH_FILES = { appJs: 'web/pet-app.js', hostCjs: 'pet-host.cjs', figureJs: 'web/whale/figure.js', petHtml: 'web/pet.html' };
    const patcher = fs.readFileSync(path.join(root, 'tools', 'patch-assets.mjs'), 'utf8');
    // marker 有单引号写的也有双引号写的（里面带 ' 的只能用双引号），两种都要认
    const edits = [...patcher.matchAll(/edit\((\w+),\s*'[^']*',\s*\[[\s\S]*?\],\s*(?:'([^']*)'|"([^"]*)")\)/g)]
      .map((m) => [m[1], m[2] ?? m[3]]);
    const markerBad = edits.filter(([v, marker]) => {
      const rel = PATCH_FILES[v];
      return !rel || !fs.readFileSync(path.join(app, rel), 'utf8').includes(marker);
    });
    ok(`patch-assets.mjs 的 ${edits.length} 处编辑的 marker 都在对应文件里`
      + (markerBad.length ? `（缺：${markerBad.map(([v, m]) => `${v}=${JSON.stringify(m)}`).join(' ')}）` : ''),
      edits.length >= 5 && markerBad.length === 0);

    // 部位：台词桶的名字必须和页面那两张判定表（pet-app.js 的 REGION_BOXES + REGION_AT）完全一致，
    // 否则台上报了 hair、台词却没这一桶，就静默退回通用台词——那是很难发现的一类错。
    // ★ 2026-10-10 从 7 类细化到 15 类：这里不再写死名单，**以页面那两张表为准**。
    const AREA_KEYS = pageAreas();
    ok(`部位一共 ${AREA_KEYS.length} 类（呆毛/头发/眼睛/脸蛋/下巴/脖子/胸口/肚子/腰/裙子/手/鳍/尾巴/大腿/脚）`,
      AREA_KEYS.length === 15);
    ok('戳的部位台词十五个部位都齐', AREA_BUCKETS.pokeArea(AREA_KEYS));
    ok('蹭的部位台词十五个部位都齐', AREA_BUCKETS.petArea(AREA_KEYS));
    ok('拎起来 / 拎久了 / 放下 三桶都齐十五个部位', AREA_BUCKETS.grabLike(AREA_KEYS));
    ok('页面判定表里的部位名和台词桶一致（两边都是同一张单子）',
      AREA_KEYS.every((k) => lines.pokeArea[k] && lines.petArea[k]));
    // 抓取风格表（哪个部位怎么挂）的键必须和判定表一模一样，否则那个部位会静默变成"竖直垂着"
    ok('页面抓取风格表的部位名和判定表一致', JSON.stringify(pageGrabParts()) === JSON.stringify(pageAreas()));

    // 抚摸三段：页面用 `stage: 'start' | 'good' | 'over'` 报给 World，桶的名字必须对得上。
    // 对不上就**静默退回通用的「蹭」**（照常说，只是不说那一段的话），日志里看不出来。
    // 页面里还有一个 `stage:'long'`，那是拖拽的"拎久了"（走 grabArea/holdArea 那条线），所以一起列上。
    const STAGE_KEYS = ['start', 'good', 'over'];
    ok('抚摸三段都有台词', STAGE_KEYS.every((k) => lines.petting[k]?.all?.length));
    ok('页面里的 stage 字面量和台词桶/拎久了 对得上',
      JSON.stringify(pageStages()) === JSON.stringify([...STAGE_KEYS, 'long'].sort()));

    // 它会问你：问题和选项都要齐（选项要能对上"回哪句"）
    ok('有问题可以问', lines.ask.length >= 2 && lines.ask.every((q) => q.options?.length >= 2));
    ok('问不出结果时也有台阶下', lines.askNudge.length > 0 && lines.askDismiss.length > 0);

    const probe = ['a', 'b', 'c', 'd', 'e'].map((t) => ({ text: t }));
    const round1 = Array.from({ length: 5 }, () => pet.next(probe).text);
    const round2 = Array.from({ length: 5 }, () => pet.next(probe).text);
    ok(`抽签一轮内不重复（${round1.join('')}）`, new Set(round1).size === 5);
    ok(`第二轮同样不重复（${round2.join('')}）`, new Set(round2).size === 5);
    ok('两轮之间不会同一句连着出现', round2[0] !== round1[4]);
    ok('空数组不炸', pet.next([]) === null && pet.next(undefined) === null);
    ok('时段判定返回四段之一', ['morning', 'afternoon', 'evening', 'night'].includes(pet.partOfDay()));

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
    ok('配置写在临时目录里', llm.CONFIG_FILE.startsWith(CONFIG_DIR));

    /* ---------- 3b. 配置损坏不能把用户的东西静默顶掉（2026-10-08 的守卫） ---------- */
    // 这条守的是一个真事故：读配置失败 → 退回默认值 → 紧接着一次保存就把用户的 Key/人设
    // 覆盖掉（HANDOVER 第 8 节 18）。现在的规矩是：坏文件先留一份，再写新的；而且写入是原子的。
    {
      const keep = llm.load();
      fs.writeFileSync(llm.CONFIG_FILE, '{"apiKey":"SECRET","person');     // 写一半崩掉的样子
      ok('配置坏了会退回默认值（不抛）', llm.load().apiKey === '');
      llm.save({ model: 'after-broken' });
      const bads = fs.readdirSync(CONFIG_DIR).filter((f) => f.startsWith('settings.json.bad-')).sort();
      ok('坏掉的配置会先留一份（settings.json.bad-*）', bads.length >= 1);
      ok('留档里用户的数据还在', bads.length > 0 && fs.readFileSync(path.join(CONFIG_DIR, bads.at(-1)), 'utf8').includes('SECRET'));
      ok('坏文件之后还能正常保存', llm.load().model === 'after-broken');
      ok('原子写没有留下 .tmp', !fs.existsSync(`${llm.CONFIG_FILE}.tmp`));
      llm.save(keep);
      ok('store.readJson 读不到就给 null', store.readJson(path.join(CONFIG_DIR, 'nope.json')) === null);
      ok('store.writeJson 失败返回 Error（不抛）', store.writeJson(path.join(llm.CONFIG_FILE, 'x.json'), { a: 1 }) instanceof Error);
    }

    /* ---------- 4. 拿假端点跑一遍模型调用 ---------- */
    llm.save({ enabled: true, baseUrl: stub.url, apiKey: 'test-key', model: 'test-model', maxTokens: 64, persona: '你是测试用的人设。' });
    ok('填好之后 isOn 为真', llm.isOn());

    const probed = await llm.probe(llm.load());
    ok(`测试连接通了（${probed.ms}ms）`, probed.ok === true);
    ok('测试连接会带上人设（不然看到的是模型的原始语气）',
      stub.seen.at(-1).body.messages?.[0]?.role === 'system'
      && stub.seen.at(-1).body.messages[0].content.includes('测试用的人设'));

    const answer = await llm.chat([], '在吗');
    ok('chat 拿到回复', answer === '收到啦,我是测试模型。');
    const req = stub.seen.at(-1);
    ok('请求带上了 Authorization', req.headers.authorization === 'Bearer test-key');
    ok('请求带上了模型名', req.body.model === 'test-model');
    ok('请求把人设放在 system', req.body.messages[0].role === 'system' && req.body.messages[0].content.includes('测试用的人设'));
    ok('请求带上了 max_tokens', req.body.max_tokens === 64);
    ok('请求路径是 /chat/completions', req.url === '/chat/completions');
    ok('普通提问不带 temperature（用端点自己的默认值）', req.body.temperature === undefined);

    const bad = await llm.probe({ ...llm.load(), model: 'fail-me' });
    ok('Key 不对时说得是人话', bad.ok === false && bad.message.includes('API Key'));

    /* ---------- 4b. 本地模型的两个优化：常驻与冷/热分开报 ---------- */
    ok('认出本地端点（127.0.0.1）', llm.isLocal({ preset: 'custom', baseUrl: 'http://127.0.0.1:8080/v1' }));
    ok('认出本地端点（localhost）', llm.isLocal({ preset: 'custom', baseUrl: 'http://localhost:11434/v1' }));
    ok('认出 ollama 预设（哪怕在别的机器上）', llm.isLocal({ preset: 'ollama', baseUrl: 'http://10.0.0.9:11434/v1' }));
    ok('云端不算本地', !llm.isLocal({ preset: 'deepseek', baseUrl: 'https://api.deepseek.com' }));

    llm.save({ enabled: true, preset: 'ollama', baseUrl: stub.url, model: 'test-model', keepAlive: '8h' });
    stub.seen.length = 0;
    await llm.chat([], '在吗');
    ok('本地端点会带上 keep_alive', stub.seen.at(-1).body.keep_alive === '8h');

    llm.save({ keepAlive: '' });
    stub.seen.length = 0;
    await llm.chat([], '在吗');
    ok('keepAlive 留空就不发这个字段', stub.seen.at(-1).body.keep_alive === undefined);

    llm.save({ keepAlive: '8h' });
    const warmed = await llm.warm();
    ok(`预热会真的先问一句（${warmed}ms）`, typeof warmed === 'number' && warmed >= 0);

    const slow = await llm.probe({ ...llm.load(), model: 'slow-model' });
    ok('第一次慢的话会再测一次，并分开报冷/热',
      slow.ok === true && /第一次.*第二次/s.test(slow.message));

    llm.save({ enabled: false });

    /* ---------- 5. 连上之后的反应 ---------- */
    let fromPet = [];
    let ws = new WebSocket(`ws://127.0.0.1:${port}/socket?role=pet&host=window`);
    // `at` 记下收到的时刻，用来断言"两个气泡之间隔了多久"
    ws.on('message', (raw) => fromPet.push(Object.assign(JSON.parse(raw.toString()), { at: Date.now() })));
    // `pick` 直接返回想要的那条消息（别用 Array.find 配一个忽略参数的谓词：
    // find 会把元素当参数传进去，谓词却只看全局计数，于是会返回错的那一条）。
    /**
     * 等一条消息。失败时报出**收到了什么**，而且说得尽量细：
     * 气泡要带上它的 `kind` / `tag` / 文本 / 相对第一条消息的毫秒数 ——
     * "等不到"这种红最难查的就是"到底是谁先冒出来把它挡了"，
     * 而 `tag` 正好能一眼看出是不是计时器自己开的口（见下面 isSelfTalk）。
     */
    const waitFor = (what, pick, ms = 6000) => new Promise((resolve, reject) => {
      const deadline = Date.now() + ms;
      const t0 = fromPet[0]?.at || Date.now();
      const dump = () => fromPet.map((m) => {
        const dt = `+${(m.at || Date.now()) - t0}ms`;
        if (m.t !== 'say') return `${m.t}@${dt}`;
        const text = (m.beats || []).map((b) => b.text).join('+');
        return `say@${dt}{kind=${m.kind},tag=${m.tag || '-'}}:${text}`;
      }).join(' | ');
      const tick = () => {
        const hit = pick();
        if (hit) return resolve(hit);
        if (Date.now() > deadline) return reject(new Error(`等不到 ${what}（收到 ${dump()}）`));
        setTimeout(tick, 20);
      };
      tick();
    });
    const says = () => fromPet.filter((m) => m.t === 'say');
    /**
     * 数气泡时**要排掉它自己主动说的那些话**（发呆 / 犯困 / 记忆话）：它们由 `fidget`
     * 定时器冒出来，跟被测的那条路（自动说话 / 静默期 / 连点合并…）毫无关系。
     *
     * 不排掉的话，**任何"等 N 秒、数气泡"的断言都会随机红一次**：`IDLE_MIN_MS` 是 35 秒起，
     * 而整轮自检要跑几分钟，总有几秒会撞上它。实测撞过好几次：
     * 「要是能出去走走就好了。」·「早上还是有点困……」（第 1.15 节加的按时段发呆话）·
     * 记忆话（第 1.16 节加的）——**每加一批"它自己会开口"的台词，这里就要跟着加一批**，
     * 否则自检就会变成随机红。**排的时候按"模板渲染后"排**（见下面 templateRe），
     * 拿模板字面量去比是排不掉的 —— 这个坑让上一轮自检卡了很久。
     * 交接文档第 1.10 / 1.11 节记的就是这个，
     * **修这里，别去动 `pet.cjs` 的定时器逻辑** —— 那正是第 1.8 节 ④
     * "自检写错了却去改产品代码"的教训。
     *
     * ⚠️ **别把 `lines.llmFailed` 也塞进来**：那句是"模型挂了"这条被测路径的**应答**，
     * 自检里专门有一条断言它（第 5 节「模型出错时退回内置台词」）。把它当成自说自话排掉，
     * 那条断言就永远等不到气泡 —— 实测踩过（`等不到 下一个气泡（收到 thinking,thinking,say）`）。
     * 只有"定时器自己冒出来的话"才是自说自话：发呆 / 犯困 / 记忆。
     */
    const SELF_TALK_TAGS = new Set(['idle', 'drowsy', 'memory']);
    const SELF_TALK = [
      lines.idle, lines.drowsy,
      ...Object.values(lines.idleByTime || {}),
      ...Object.values(lines.drowsyByTime || {}),
      lines.memoryWords, lines.memoryArea, lines.memoryHour,
      lines.memoryMilestone, lines.memoryAway,
    ];
    /**
     * 文本兜底：台词库里存的是**模板**（`我还记得你说「{words}」呢。`），气泡里是**渲染后**的
     * 文本（`我还记得你说「慢慢来」呢。`）—— 直接比字符串一条都排不掉，实测就是这里把
     * 「抓放的气泡都是抓/放的台词」弄红的（那句记忆话被当成抓放的回话）。
     * 所以按模板把每个 `{占位符}` 编译成通配，模板没变的（发呆/犯困话）走原样包含。
     * （主判据已经是 `say.tag`，这里是"万一是老协议/新加的定时器台词"时的第二道网。）
     */
    const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const templateRe = (text) => new RegExp('^' + escapeRe(text).replace(/\\\{[a-zA-Z]+\\\}/g, '.*') + '$');
    const SELF_RE = textsOf(...SELF_TALK.filter(Boolean)).map(templateRe);
    /**
     * 这句话是不是"它自己冒出来的"（不是对我这次操作的应答）。
     *
     * **主判据是 `say.tag`**（`idle` / `drowsy` / `memory`）—— 那是应答链里本来就有的出处标记，
     * 比文本可靠：台词带 `{words}`/`{area}`/`{hour}` 时气泡里是渲染后的文本，文本比对排不掉。
     * 文本那套留着当兜底（老协议没有 tag 时仍然能排掉大部分），两条都命中才算。
     */
    const isSelfTalk = (m) => SELF_TALK_TAGS.has(m.tag) || SELF_RE.some((re) => re.test(m.beats[0].text));
    const ownSays = () => says().filter((m) => !isSelfTalk(m));
    /** 断言信息里带上"收到的是哪几句"，下次红了能一眼看清是谁冒出来的。 */
    const ownTexts = () => ownSays().map((s) => s.beats.map((b) => b.text).join('+')).join(' | ');
    /**
     * 等到"下一个气泡"，但**只认它对我的操作做出的回话**（`ownSays`）。
     *
     * 为什么不能拿 `says()` 直接数：发呆/犯困/记忆话跟被测的那条路无关，却会**抢在**
     * 我这句回话前面冒出来（实测：「戳头说的是『头』那一桶」那次被一句记忆话
     * `我还记得你说「慢慢来」呢。` 抢走，报"等不到 这一下的回话"）。
     * 排空之后从零开始等，所以不用记下标。
     */
    const nextSay = (ms = 6000) => waitFor('下一个气泡', () => ownSays()[0], ms);
    /**
     * 只等**某个出处**的那条回话（`say.tag`）。
     *
     * 为什么需要它：`nextSay` 认的是"第一条不是自说自话的气泡"，而**上一节排队的回答**
     * 可能这一秒才轮到（应答链一条气泡要占 0.8~2 秒），于是它被当成这一节的回话，
     * 断言就红了（实测：「模型出错时退回内置台词」那次收到的是上一节 `tag=answer` 的
     * 模型回答，而断言在等 `llmFailed`）。按 tag 等就完全没有这个歧义。
     */
    const nextReply = (tag, ms = 8000) => waitFor(`tag=${tag} 的回话`, () => says().find((m) => m.tag === tag), ms);
    /**
     * 等到"没有新消息进来"再往下走，然后清空 `fromPet`。
     *
     * 为什么需要它：**语音合成要 2~3 秒**，上一节排出去的那条回复可能还在路上，
     * 于是它会落进下一节那段"固定等 N 秒、数气泡"的窗口里，把断言弄红。
     * 实测（女声换好之后）"念提示词的句子不冒泡"和"第二下升到又戳"就这样间歇性失败过。
     * 与其把窗口调得更长，不如在开始计数前**先排空**：这才是"只数这一节的东西"。
     */
    const drain = async (quietMs = 1200, maxMs = 20000) => {
      const deadline = Date.now() + maxMs;
      let last = fromPet.length, lastChange = Date.now();
      for (;;) {
        await new Promise((r) => setTimeout(r, 300));
        if (fromPet.length !== last) { last = fromPet.length; lastChange = Date.now(); }
        if (Date.now() - lastChange >= quietMs) break;
        if (Date.now() > deadline) break;      // 一直有动静就别死等，交给断言去报
      }
      fromPet.length = 0;
    };

    await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });

    const init = await waitFor('init', () => fromPet.find((m) => m.t === 'init'));
    ok('init 带的是大肥鱼', init.skin.figure === 'whale' && init.skin.scheme === 'deepseek');
    ok('init 只给这一版能兑现的悬停按钮', init.hoverButtons.every((b) => ['chat', 'game', 'weather', 'auto', 'roam', 'theme', 'sound', 'hide'].includes(b)));
    // 悬停和右键菜单原来摆的是同一批动作，重复；现在悬停只留要紧的几个。
    // ★ 2026-10-10 用户点名加了天气："做成一个悬浮开关就放在足球按钮的下面" ——
    //   所以顺序是 对话 / 球 / 天气（球的下面就是天气）。
    ok('悬停是「对话」+「球」+「天气」三个按钮，天气排在球的下面',
      init.hoverButtons.length === 3 && init.hoverButtons[0] === 'chat'
      && init.hoverButtons[1] === 'game' && init.hoverButtons[2] === 'weather');
    ok('球/游戏模式默认是关的（要你自己点开）', init.ballMode === 'off');
    ok('天气默认是关的（不点就什么粒子都不飘）', init.weather === 'off');
    ok('init 带上了右键菜单（controls + 设置按钮）', init.bot?.controls === true && init.bot.buttons.settings === true);
    // 「换装…」现在是**真的有窗口**的（第 2f 节那一套：接口先占住，贴图以后再加），
    // 所以这里从"去掉了装扮"改成"装扮按钮在、而且服务里真的有 /dress 那一页"。
    ok('右键菜单里有「换装…」（服装接口已接上）', init.bot.buttons.dress === true);
    ok('服装页真的存在（不是写了个点不动的按钮）',
      fs.existsSync(path.join(app, 'web', 'dress.html'))
      && fs.readFileSync(path.join(app, 'server.cjs'), 'utf8').includes("'/dress': 'dress.html'"));

    ws.send(JSON.stringify({ t: 'hello', screen: { w: 1920, h: 1080 }, host: 'window' }));

    const hello = await waitFor('开机问候', () => says()[0], 8000);
    ok(`开机问候来自当前时段（${pet.partOfDay()}）`, textsFilled(lines.hello[pet.partOfDay()]).includes(hello.beats[0].text));

    // 没开模型：走内置台词
    fromPet.length = 0;
    ws.send(JSON.stringify({ t: 'text', text: '你好呀' }));
    const builtin = await nextReply('reply');
    ok('没接模型时用内置台词', builtin.beats.some((b) => textsOf(lines.reply).includes(b.text)));

    // 开了模型：走假端点
    llm.save({ enabled: true, baseUrl: stub.url, apiKey: 'test-key', model: 'test-model', maxTokens: 64, persona: '你是测试用的人设。' });
    fromPet.length = 0;
    ws.send(JSON.stringify({ t: 'text', text: '在吗' }));
    const spoken = await nextReply('answer', 15000);
    ok('接了模型就用模型的回答', spoken.beats.some((b) => b.text.includes('我是测试模型')));
    // 给模型的 system 里必须带上【此刻】（几点 / 认识多久 / 刚发生了什么）——
    // 没有它，本地小模型对"自己的处境"一无所知，答得像通用客服。
    ok('给模型的 system 里带了【此刻】的处境',
      stub.seen.length > 0 && String(stub.seen.at(-1)?.body?.messages?.[0]?.content).includes('【此刻】'));
    ok('等模型时点亮思考表情', fromPet.some((m) => m.t === 'thinking' && m.on === true));
    ok('回答完关掉思考表情', fromPet.some((m) => m.t === 'thinking' && m.on === false));

    // 语音（装了的话）在后台先热起来：模型加载约 9 秒，第一次真要说的时候不该还在读权重。
    // 断言里凡是等气泡的地方都留够了这个时间（`nextSay(15000)`）。
    const tts = require(path.join(app, 'tts.cjs'));
    // `warm()` **必须返回 Promise**：main.cjs 写的是 `tts.warm().catch(...)`，
    // 返回 undefined 的话启动时直接 TypeError → 弹「启动失败」框 → app.exit(1)，
    // 桌宠根本起不来（实测踩过，而且只在语音文件齐了的机器上才炸）。
    if (tts.available()) {
      const warmed = tts.warm();
      ok('warm() 返回 Promise（main.cjs 要 .catch 它）', !!warmed && typeof warmed.then === 'function');
      warmed.catch(() => {});
    }

    /* ---------- 4c. 球与弹弹乐：三态开关 + 进球 + 蓄力，走完整往返 ---------- */
    /**
     * 静态守卫（2g）只能证明"代码在"，证明不了"这条链通"。这里连上真 World 走一遍：
     *   出球 → `ballOn`；踢到 → `ballKick`；进游戏 → `ballGameOn`；进球 → `ballGoal`；
     *   蓄力 → `ballCharge`；收走 → 委屈或生气。
     */
    fromPet.length = 0;
    ws.send(JSON.stringify({ t: 'ballMode', mode: 'ball' }));
    const onSay = await nextReply('ballOn');
    ok('球：出球时她会说一句（ballOn）', !!onSay);

    fromPet.length = 0;
    ws.send(JSON.stringify({ t: 'ballKick', at: 0.42 }));
    const kickSay = await nextReply('ballKick');
    ok('球：踢到球她会说一句（ballKick）', !!kickSay);

    fromPet.length = 0;
    ws.send(JSON.stringify({ t: 'ballMode', mode: 'game' }));
    const gameSay = await nextReply('ballGameOn');
    ok('弹弹乐：进游戏模式她会招呼一声（ballGameOn）', !!gameSay);

    fromPet.length = 0;
    ws.send(JSON.stringify({ t: 'ballGoal', scorer: 1, score: [0, 1], defence: 1 }));
    const goalMine = await nextReply('ballGoal');
    ok('弹弹乐：她进球她会得意（ballGoalMine）',
      !!goalMine && goalMine.beats.some((b) => textsOf(lines.ballGoalMine).includes(b.text)));

    fromPet.length = 0;
    ws.send(JSON.stringify({ t: 'ballGoal', scorer: 0, score: [1, 1], defence: 1 }));
    const goalYours = await nextReply('ballGoal');
    ok('弹弹乐：你进球她不服气（ballGoalYours）',
      !!goalYours && goalYours.beats.some((b) => textsOf(lines.ballGoalYours).includes(b.text)));

    fromPet.length = 0;
    ws.send(JSON.stringify({ t: 'ballCharge' }));
    const chargeSay = await nextReply('ballCharge');
    ok('弹弹乐：蓄力飞踢会喊一声（ballCharge）', !!chargeSay);

    fromPet.length = 0;
    ws.send(JSON.stringify({ t: 'ballMode', mode: 'off' }));
    const offSay = await nextReply('ballOff');
    // 收走时是"委屈 / 生气"随机一套，两句都要能在台词库里找到出处
    const offPool = [...textsOf(lines.ballOffSad), ...textsOf(lines.ballOffAngry)];
    ok('球：收走时她会闹脾气（委屈或生气，随机）',
      !!offSay && offSay.beats.some((b) => offPool.includes(b.text)));
    ok('球：收走那一下带了表情（sad 或 angry）',
      !!offSay && offSay.beats.some((b) => ['sad', 'angry', 'turn'].some((a) => (b.actions || []).includes(a))));

    /* ---------- 4d. 念出来：只有大模型的回答会出声 ---------- */
    // 语音文件（vendor\tts）在就测，不在就跳过——自检不该因为没装语音而红
    ok(`init 报告了语音开关（voice=${init.voice}）`, typeof init.voice === 'boolean');
    if (!tts.available()) {
      console.log(`      （语音没装：${tts.why()}——跳过念出来的检查）`);
      ok('没装语音时 init 说不要念', init.voice === false);
    } else {
      ok('语音文件齐了，init 默认要念（接模型时语音默认开）', init.voice === true);
      // **换一条新连接**再测语音。服务端"上一句还在想"时会把新的那句留成 pending，
      // 上一节留下的 pending 会飘进这一节（实测折腾了好几轮）；新连接状态是干净的。
      ws.close();
      await new Promise((r) => setTimeout(r, 300));
      fromPet = [];
      ws = new WebSocket(`ws://127.0.0.1:${port}/socket?role=pet&host=window`);
      ws.on('message', (raw) => fromPet.push(Object.assign(JSON.parse(raw.toString()), { at: Date.now() })));
      await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
      await waitFor('新连接的 init', () => fromPet.find((m) => m.t === 'init'), 8000);
      await new Promise((r) => setTimeout(r, 3000));        // 让开机问候先说完

      const voices = () => fromPet.filter((m) => m.t === 'voice');
      /** 带音频的那些 voice 消息（"这句不念"时根本不会再发 voice 了）。 */
      const audios = () => voices().filter((m) => m.wav);
      const wavOf = (m) => Buffer.from(m.wav || '', 'base64');
      /**
       * 一条 model 回答该有的样子：**先**一条带 voice 标记的气泡，**后**一条带 wav 的 voice。
       *
       * 顺序是"并行改造"之后定下来的：气泡不再等合成，所以文字先出、语音随后到。
       * （改造前是反过来：`voice` 在前，因为服务端会先 await 合成再发 say。）
       */
      const speech = () => {
        const si = says().map((s, i) => (s.voice ? fromPet.indexOf(s) : -1)).filter((i) => i >= 0).pop();
        const vi = fromPet.map((m, i) => (m.t === 'voice' && m.wav ? i : -1)).filter((i) => i >= 0).pop();
        if (vi === undefined || si === undefined || vi < si) return null;
        return { v: fromPet[vi], s: fromPet[si] };
      };

      llm.save({ model: 'vary-model' });
      fromPet.length = 0;
      ws.send(JSON.stringify({ t: 'text', text: '在吗' }));
      const say1 = await nextReply('answer', 20000);
      const got1 = await waitFor('气泡先到、语音随后', () => speech(), 40000).catch((e) => {
        const dump = fromPet.map((m) => (m.t === 'say' ? `say{voice=${m.voice}}` : m.t === 'voice' ? `voice{wav=${(m.wav || '').length}}` : m.t)).join(' ');
        throw new Error(`${e.message}\n      实际: ${dump}`);
      });
      // **要断言 `got1.s`，不要断言 `say1`**：`say1` 是"这一刻之后收到的第一条气泡"，
      // 开机问候（2 秒后那条 line）经常抢在前面，而问候本来就不该带 voice——
      // 拿它来验"要念"必然红。上一个会话就在这上面耗了很久：它以为是产品的 bug，
      // 反复改 pet.cjs 的出话顺序去迁就这个断言，越改越坏。真正该看的是**那条带
      // 语音的气泡**（`got1.s` 由 speech() 挑出来，保证它后面真的有音频）。
      ok('模型回答的气泡标了"要念"', got1.s.voice === true,
        `（这一条气泡 voice=${got1.s.voice}；顺带一提第一条是 voice=${say1.voice}）`);
      // 并行改造之后是"气泡先出、语音随后到"（以前反过来）。
      // 这条断言的意义在于：**气泡不被合成挡住**——文字该立刻出来。
      ok('气泡先到、语音随后到（文字不被合成挡住）',
        fromPet.indexOf(got1.s) < fromPet.indexOf(got1.v));
      ok('音频带上了采样率', got1.v.rate === 22050 || typeof got1.v.rate === 'number');
      const wav = wavOf(got1.v);
      ok(`音频是合法 WAV（RIFF/WAVE，${(wav.length / 1024).toFixed(0)}KB）`,
        wav.toString('ascii', 0, 4) === 'RIFF' && wav.toString('ascii', 8, 12) === 'WAVE' && wav.length > 44);

      // 缓存直接量 tts.speak 本身：同一条过协议去测会被上一句还在路上的请求搅乱
      // （服务端的 pending 会让"下一次"其实早就在合成中）
      const text = '收到啦,我是测试模型。';
      const first = await tts.speak(text);
      const cacheAt = Date.now();
      const second = await tts.speak(text);
      ok(`同一句话第二次走缓存（${Date.now() - cacheAt}ms，${first.wav.length} 字节）`,
        !!second && second.ms === 0 && second.wav.equals(first.wav));
      const other = await tts.speak('换一句不一样的话。');
      ok('换一句话就要重新合成', !!other && other.ms > 0 && !other.wav.equals(first.wav));

      // 内置台词（戳它）不出声：那些本来就是音效
      await new Promise((r) => setTimeout(r, 2500));
      fromPet.length = 0;
      ws.send(JSON.stringify({ t: 'touch', kind: 'poke' }));
      await nextReply('poke', 8000);
      await new Promise((r) => setTimeout(r, 1500));
      ok('内置台词不念（戳它只有音效）', voices().length === 0);

      // 关掉语音：气泡不再标"要念"
      ws.send(JSON.stringify({ t: 'prefs', voice: 'off' }));
      await new Promise((r) => setTimeout(r, 300));
      ok('关掉语音会存进配置', llm.load().voice === false);
      await new Promise((r) => setTimeout(r, 3000));        // 让关之前那句做完
      await new Promise((r) => setTimeout(r, 8000));        // 再等一轮，把所有在飞的都等干净
      fromPet.length = 0;
      const sentAt = Date.now();
      ws.send(JSON.stringify({ t: 'text', text: '这句以前没问过' }));
      const quiet = await nextReply('answer', 20000);
      await new Promise((r) => setTimeout(r, 1500));
      // 关掉之后：气泡不标"要念"，也**不再有任何 voice 消息**。
      // （并行改造之后服务端不再发"不带 wav 的 voice 占位信号"了——那条信号是给
      //  以前"等语音才打字"的页面用的；现在页面根本不等，服务端也就不用发。）
      const voiceDump = fromPet.map((m) => `${m.t}${m.voice ? '(voice)' : ''}@+${(m.at - sentAt)}ms`).join(' ');
      ok(`关了之后气泡不再要念，也没有音频（气泡 voice=${quiet.voice} / 音频 ${audios().length} 条 [${voiceDump}]）`,
        !quiet.voice && audios().length === 0);

      // 打开：又念了
      ws.send(JSON.stringify({ t: 'prefs', voice: 'voice' }));
      await new Promise((r) => setTimeout(r, 300));
      ok('再打开会存进配置', llm.load().voice === true);
      await new Promise((r) => setTimeout(r, 2500));
      fromPet.length = 0;
      ws.send(JSON.stringify({ t: 'text', text: '在吗' }));
      const back = await nextReply('answer', 15000);
      ok('重新打开后又会念', back.voice === true && !!(await waitFor('重新打开后的语音', () => voices().length >= 1, 30000)));
    }

    // 模型挂了：退回内置的"接不上话"
    llm.save({ model: 'fail-me' });
    fromPet.length = 0;
    ws.send(JSON.stringify({ t: 'text', text: '你还在吗' }));
    const failed = await nextReply('answer', 8000);
    ok('模型出错时退回内置台词', textsOf(lines.llmFailed).includes(failed.beats[0].text));
    ok('模型回答跟时刻无关，不会因为等得久被丢掉', failed.kind === 'line');

    // 模型慢（冷启动 4.1 秒）：回答照样会说，而且进队列就立刻出去，不隔 1.2 秒
    llm.save({ model: 'slow-model' });
    fromPet.length = 0;
    const askedAt = Date.now();
    ws.send(JSON.stringify({ t: 'text', text: '慢慢来' }));
    const slowSay = await nextReply('answer', 9000);
    ok('模型慢慢回来时回答照样说出口', slowSay.beats.some((b) => b.text.includes('我是测试模型')));
    ok(`模型回答直接出去，不再等一个间隔（${slowSay.at - askedAt}ms）`, slowSay.at - askedAt < 3000);
    llm.save({ enabled: false });

    // 蹭睡着的它
    fromPet.length = 0;
    ws.send(JSON.stringify({ t: 'touch', kind: 'pet', asleep: true }));
    const dreaming = await nextReply('pet', 8000);
    ok('蹭睡着的它会用"做梦"的台词', textsOf(lines.petAsleep).includes(dreaming.beats[0].text));

    /* ---------- 5b. 连点/连续拖拽：气泡会合并、会过期，停手就安静 ---------- */
    /**
     * 发一次操作，等它**这个操作**的回话（`say.tag` 就是操作名：`poke` / `pet` / `grab` …）。
     *
     * 为什么按 tag 等，而不是"等下一个气泡"：这条路上有两件跟被测无关的事会抢位 ——
     * ① 计时器自己冒的发呆/记忆话；② **上一节排队的回答**（应答链一条气泡要占 0.8~2 秒，
     * 上一节问的那句话可能这一秒才轮到）。实测这两种都让"回的是哪一桶台词"随机红过。
     */
    const touchSay = async (kind, extra = {}) => { fromPet.length = 0; ws.send(JSON.stringify({ t: 'touch', kind, ...extra })); return nextReply(kind, 8000); };
    const touchOwnSay = touchSay;

    // 先甩一下，把应答链的空档走完：下面的断言都从这里干净的起点算起
    await touchSay('throw');

    // 连戳五下：**一个**气泡（第五下的档位），不能一下一个、说完还接着弹
    fromPet.length = 0;
    for (let i = 0; i < 5; i += 1) ws.send(JSON.stringify({ t: 'touch', kind: 'poke' }));
    const pokes = [await nextReply('poke', 8000)];
    const seen = ownSays().length;
    await new Promise((r) => setTimeout(r, 1200));      // 再等一会儿，看有没有第二、第三个冒出来
    pokes.push(...ownSays().slice(seen));
    ok(`连戳五下只出一个气泡（收到 ${pokes.length} 个：${pokes.map((m) => m.beats.map((b) => b.text).join('+')).join(' | ')}）`, pokes.length === 1);
    ok('连戳五下的档位照样升到「戳太多」', textsOf(lines.poke.tooMuch).includes(pokes[0].beats[0].text));
    ok('触发类气泡带 react 标记（页面据此丢掉过期的）', pokes.every((m) => m.kind === 'react'));
    ok('每一下都配了表情或动作', pokes.every((m) => (m.beats[0].actions || []).length > 0));

    // 点一下、停一下再点：1.5 秒一下属于"自己一下一下点"，不合并，档位要升
    // 同样先排空上一节（连戳五下）在路上的气泡，否则它会被算进 spaced[0]，
    // 把整条"第一次/又戳/又戳"的档位串位（实测就这样间歇性红过）
    await drain();
    const spaced = [];
    for (let i = 0; i < 3; i += 1) {
      spaced.push(await touchOwnSay('poke'));
      await new Promise((r) => setTimeout(r, 1400));
    }
    ok('1.5 秒一下不会被合并，三下三个气泡', spaced.length === 3);
    ok('第一下是"第一次戳"', textsOf(lines.poke.first).includes(spaced[0].beats[0].text));
    ok('第二下升到"又戳"', textsOf(lines.poke.again).includes(spaced[1].beats[0].text));
    ok('第三下还是"又戳"', textsOf(lines.poke.again).includes(spaced[2].beats[0].text));

    // 气泡之间有间隔：不会一口气连珠炮；停手之后也不再冒出来
    ok('气泡间隔在 1.1–3.2 秒之间（不急不挤，也不拖）',
      spaced.slice(1).every((m, i) => m.at - spaced[i].at > 1100 && m.at - spaced[i].at < 3200));
    fromPet.length = 0;
    await new Promise((r) => setTimeout(r, 2500));
    ok('停手之后气泡就停了（不会再冒出来）', ownSays().length === 0);

    /* ---------- 5b-2. 部位：戳/蹭在**身上哪个地方**，就说那个地方的话 ---------- */
    // 部位是**页面**判的（pet-app.js 的 REGION_BOXES/REGION_AT，照 whale\model.json 的部件框量出来），
    // 跟着 touch 一起报上来；World 只认名字。所以这里直接按页面的口吻发 `at`。
    // ★ 2026-10-10 名字细化了：头发是 `hair`（原来叫 `head`）、肚子是 `belly`（原来叫 `body`）、
    //   裙子是 `skirt`（原来叫 `low`）。
    //
    // ⚠️ **顺序有讲究，别随手调**：`state.card` 一举起来，它**一句话都不说**（`if (state.card) break`），
    //   而"摸头"那一族（呆毛/头发/眼睛/脸蛋/下巴）每下算**两下**好感，攒够 `ASK_AFTER_PETS`（3）就举卡。
    //   所以"页面没报部位 → 通用蹭"这条必须**排在最前**：那时上一节刚把好感清零（它测过举卡），
    //   这一下只算 1 点、绝不会举卡。反过来排在后面的话，前面几下戳头发 + 蹭下巴早把卡举起来了，
    //   这一条就**永远等不到气泡**（实测报的是"等不到 tag=pet 的回话（收到 prefs | act | ask）"）。
    await drain();
    const plainPet = await touchOwnSay('pet');
    ok('页面没报部位时退回通用的「蹭」', textsOf(lines.pet).includes(plainPet.beats[0].text));
    const headPoke = await touchOwnSay('poke', { at: 'hair' });
    ok('戳头发说的是「头发」那一桶', textsOf(lines.pokeArea.hair).includes(headPoke.beats[0].text));
    const bellyPoke = await touchOwnSay('poke', { at: 'belly' });
    ok('换到肚子戳就换一桶话', textsOf(lines.pokeArea.belly).includes(bellyPoke.beats[0].text));
    const ahogePoke = await touchOwnSay('poke', { at: 'ahoge' });
    ok('戳呆毛说的是「呆毛」那一桶（用户报的那条 bug 的正解）',
      textsOf(lines.pokeArea.ahoge).includes(ahogePoke.beats[0].text));
    const hairAgain = await touchOwnSay('poke', { at: 'hair' });
    ok('再戳回头发还算"新的一下"（不是「又戳」）', textsOf(lines.pokeArea.hair).includes(hairAgain.beats[0].text));
    const tailPet = await touchOwnSay('pet', { at: 'tail' });
    ok('蹭尾巴说的是「尾巴」那一桶', textsOf(lines.petArea.tail).includes(tailPet.beats[0].text));
    const chinPet = await touchOwnSay('pet', { at: 'chin' });
    ok('蹭下巴说的是「下巴」那一桶（小部位也有自己的话）',
      textsOf(lines.petArea.chin).includes(chinPet.beats[0].text));

    /* ---------- 5b-3. 它会问你：摸够几下就举一张选择卡，选完它照着你选的做 ---------- */
    await drain();
    for (let i = 0; i < 4; i += 1) ws.send(JSON.stringify({ t: 'touch', kind: 'pet' }));
    const card = await waitFor('选择卡', () => fromPet.find((m) => m.t === 'ask'), 15000);
    ok(`摸够四下它会问一句（${card.question}）`, typeof card.question === 'string' && card.question.length > 0);
    ok('卡上带着选项（页面拿它画按钮）', Array.isArray(card.options) && card.options.length >= 2);
    const q = lines.ask.find((x) => x.text === card.question);
    ok('卡片上的问题来自台词库', !!q && card.options.length === q.options.length);
    // 挑一个**不带 quiet** 的选项：安静会让后面几节（自动说话）测不出东西来
    const pick2 = q.options.findIndex((o) => !o.quiet);
    ok('选项文字和台词库一一对上', pick2 >= 0 && card.options[pick2] === q.options[pick2].label);

    // **卡片举着的时候不许再有别的话出去**：页面见到任何一句 `say` 都会把卡收掉（dropAsks）。
    // 这条是被真机日志抓出来的——实测卡片 08:39:31 发出去，08:39:32 就有一句"蹭"的回话把它顶掉，
    // 屏幕上只闪了一下，用户以为"从来没触发过"。所以：卡举着时摸它=不出声（表情/音效照旧）。
    fromPet.length = 0;
    for (let i = 0; i < 3; i += 1) ws.send(JSON.stringify({ t: 'touch', kind: 'pet' }));
    await new Promise((r) => setTimeout(r, 2500));
    ok(`卡片举着时它不冒别的气泡（收到 ${ownSays().length} 个）`, ownSays().length === 0);

    fromPet.length = 0;
    ws.send(JSON.stringify({ t: 'answer', askId: card.id, index: pick2 }));
    const chose = await nextReply('askReply', 9000);
    ok(`选了之后它照着答一句（${chose.beats[0].text}）`, chose.beats[0].text === q.options[pick2].reply);

    // 连续拖放（抓-放的"抛物线"）：同类合并 + 排队上限，最多两个气泡，不会攒一长串
    fromPet.length = 0;
    for (let i = 0; i < 4; i += 1) {
      ws.send(JSON.stringify({ t: 'touch', kind: 'grab' }));
      ws.send(JSON.stringify({ t: 'touch', kind: 'drop' }));
    }
    await new Promise((r) => setTimeout(r, 9000));
    // 只数**抓/放**的回话（`tag` 就是操作名）：这一段要验的是"同类合并 + 排队上限"，
    // 数上发呆话或者上一节还在路上的回答都会让"最多两个"这条随机红。
    const grabDrop = says().filter((m) => m.tag === 'grab' || m.tag === 'drop');
    ok(`连续抓放四次最多两个气泡（收到 ${grabDrop.length} 个：${grabDrop.map((m) => m.beats.map((b) => b.text).join('+')).join(' | ')}）`,
      grabDrop.length <= 2);
    ok('抓放的气泡都是抓/放的台词',
      grabDrop.every((m) => textsOf(lines.grab, lines.drop).includes(m.beats[0].text)));

    // 暂停 / 恢复：要说一声，并且把菜单按钮换成"继续"
    fromPet.length = 0;
    ws.send(JSON.stringify({ t: 'control', action: 'pause' }));
    const hushed = await nextReply('control', 8000);
    ok('暂停时会说一句', textsOf(lines.hush).includes(hushed.beats[0].text));
    ok('暂停后菜单按钮变成"已暂停"', fromPet.some((m) => m.t === 'prefs' && m.bot?.paused === true));
    fromPet.length = 0;
    ws.send(JSON.stringify({ t: 'control', action: 'resume' }));
    const resumed = await nextReply('control', 8000);
    ok('恢复时也会说一句', textsOf(lines.back).includes(resumed.beats[0].text));

    /* ---------- 5c. 自动说话：接了模型之后它自己找话说（右键菜单里的「自动」） ---------- */
    // 这一节把间隔压到 3.5 秒、静默期压到 8 秒（见文件顶部），默认值都是一分钟。
    /**
     * 这一节只数**自动说话**那条路（`say.tag === 'auto'`，产品里就这一个出处）。
     * 比"数所有气泡再排掉自说自话"精确得多：发呆/记忆话是有没有都无所谓，
     * 但**自动说话该安静的时候多说了一句**才是真 bug —— 断言要能分清这两者。
     */
    const autoSays = () => says().filter((m) => m.tag === 'auto');
    const autoTexts = () => autoSays().map((s) => s.beats.map((b) => b.text).join('+')).join(' | ');
    ok('默认不开自动说话', llm.defaults().autoChat === false);
    ok('init 里带上了 autoChat 开关（按钮要按它显示亮不亮）', init.autoChat === false);

    // 关着的时候：等两轮也不出声
    llm.save({ enabled: true, baseUrl: stub.url, apiKey: 'test-key', model: 'test-model', maxTokens: 64 });
    fromPet.length = 0;
    await new Promise((r) => setTimeout(r, 8000));
    ok(`关着自动说话时它不自己出声（收到 ${autoSays().length} 个：${autoTexts()}）`, autoSays().length === 0);

    // 打开：页面发一条 prefs，服务器存进配置并开始自己说话
    ws.send(JSON.stringify({ t: 'prefs', autoChat: true }));
    await new Promise((r) => setTimeout(r, 300));
    ok('服务器把自动说话的开关存进了配置', llm.load().autoChat === true);
    // 端点故意每次换一句：自动说话应该原样说出来
    llm.save({ model: 'vary-model' });
    const auto1 = await nextReply('auto', 9000);
    ok('打开之后它自己说了一句', auto1.kind === 'line' && auto1.beats[0].text.length > 0);
    // 自动说话那条路不带历史：模型只应收到 system + 那一句提示词
    const autoReq = stub.seen.at(-1);
    ok('自动说话只发人设 + 提示词，不把以前的对话塞进去',
      autoReq.body.messages.length === 2 && autoReq.body.messages[0].role === 'system');
    // 高温度是为了让它别一遍遍重复同一句；普通提问不带这个字段，用端点自己的默认值
    ok(`自动说话带上了温度 ${autoReq.body.temperature}`,
      typeof autoReq.body.temperature === 'number' && autoReq.body.temperature > 0.5);

    // 端点开始复读：跟上一句太像的就重问，重问还是那句就干脆不说
    // repeat-model 永远回一句谁都没说过的话：第一次该说出来，第二次开始就被防重复挡住
    llm.save({ model: 'repeat-model' });
    fromPet.length = 0;
    await nextReply('auto', 20000);
    ok('复读的模型第一句会说出来', autoSays().length === 1);
    const seenFirst = autoSays().length;
    fromPet.length = 0;                      // 从这里开始只数"第二句"
    await new Promise((r) => setTimeout(r, 12000));   // 够两轮自动说话的间隔
    const extra1 = autoSays().length ? `：${autoTexts()}` : '';
    ok(`第二句一模一样时它宁可不说话（收到 ${autoSays().length} 个气泡${extra1}）`, autoSays().length === 0 && seenFirst === 1);
    ok('重问时会在提示词里要求换个话题',
      stub.seen.slice(-6).some((s) => s.body.messages.at(-1).content.includes('换个话题')));

    // 模型把提示词/人设念出来（"系统提示我…"）：这种一句都不要
    // 先把上一节在路上的气泡排空再计数——否则会把它算成这一节冒出来的（见 drain 的注释）
    await drain();
    llm.save({ model: 'leak-model' });
    await new Promise((r) => setTimeout(r, 16_000));
    const extra2 = autoSays().length ? `：${autoTexts()}` : '';
    ok(`念提示词的句子不冒泡（收到 ${autoSays().length} 个气泡${extra2}）`, autoSays().length === 0);

    // 你刚跟它说过话的静默期里，它不插嘴
    llm.save({ model: 'test-model' });
    ws.send(JSON.stringify({ t: 'text', text: '在吗' }));
    const answered = await nextReply('answer', 9000);
    ok('打字问它会照常回答', answered.beats.some((b) => b.text.includes('我是测试模型')));
    // 先把它自己排的、还在路上的气泡等干净再开始数——否则上一节/这条回答的余波
    // 会落进这 3 秒里被当成"插嘴"（实测就这么间歇性红过；语音合成 2~3 秒会放大这个窗口）
    await drain(1500, 15000);
    const afterAnswer = autoSays().length;
    await new Promise((r) => setTimeout(r, 3000));
    ok(`刚说完话的静默期里它不插嘴（静默期 8 秒，3 秒内收到 ${autoSays().length - afterAnswer} 个）`,
      autoSays().length === afterAnswer);

    // 静默期过了它会自己接着说（换一家会说新话的端点，免得卡在"太像"那条规矩上）
    fromPet.length = 0;
    llm.save({ model: 'vary-model' });
    const autoAgain = await nextReply('auto', 12_000);
    ok('静默期过了它自己接着说', autoAgain.kind === 'line' && autoAgain.beats[0].text.length > 0);
    llm.save({ model: 'test-model' });

    // 关掉：页面再发一条 prefs，配置跟着改
    ws.send(JSON.stringify({ t: 'prefs', autoChat: false }));
    await new Promise((r) => setTimeout(r, 300));
    ok('关掉之后配置也跟着改', llm.load().autoChat === false);
    llm.save({ enabled: false });

    /* ---------- 6. 切句与表情的纯函数 ---------- */
    ok('长回复被切成最多 3 个气泡', pet.beatsFor('一。二。三。四。五。').length === 3);
    ok('切句时最多留三段（多的并进第三段）',
      pet.beatsFor('一。二。三。四。五。').map((b) => b.text).join('') === '一。二。三。四。五。');
    ok('单句就一个气泡', pet.beatsFor('只有一句话。').length === 1);
    ok('第一句带表情、后面不带', (() => {
      const b = pet.beatsFor('一。二。');
      return (b[0].actions || []).length === 1 && b[1].actions === undefined;
    })());
    ok('空回复不产生气泡', pet.beatsFor('   ') === null);
    ok('问句配思考表情', pet.moodOf('这样吗?') === 'thinking');
    ok('感叹配开心', pet.moodOf('太好了!') === 'happy');
    ok('道歉配害羞', pet.moodOf('抱歉,我不行。') === 'shy');

    /* ---------- 7. 次级动画与桌面接地光（2026-10-10 新做的那两批） ---------- */
    /**
     * ★ **行为验证 ①：延迟跟随取的是"0.1 秒前"那个点**（用户点名的"你甩鼠标，发梢晚 0.1 秒跟上"）。
     *
     * 光查字符串挡不住"延迟窗口写错"这类错（`.04` / `.4` 都是一个字符的事，看着都一样），
     * 所以把 `lagged()` 从 figure.js 里抠出来、喂给它一段**已知位置的历史**，量它算出来的速度：
     *   身体在 t=1.0 时在 x=100，现在（t=1.1）在 x=130 → 0.1 秒走了 30px → 300px/s。
     * 顺带量一下"历史不够长时返回 0"（老页面 / 内置身体走这条路，必须和上游一模一样）。
     */
    {
      const figSrc = fs.readFileSync(path.join(app, 'web', 'whale', 'figure.js'), 'utf8');
      const lagFn = figSrc.match(/function lagged\(o\) \{[\s\S]*?return \[\(o\.bx - best\.x\) \/ dt, \(o\.by - best\.y\) \/ dt\];\n  \}/);
      const lagConst = figSrc.match(/const LAG_S = [.\d]+;/);
      const lagged = lagFn && lagConst
        ? new Function(`${lagConst[0]}\n${lagFn[0]}\nreturn lagged;`)()
        : null;
      const hist = [{ t: .6, x: 60, y: 0 }, { t: .8, x: 80, y: 0 }, { t: 1.0, x: 100, y: 0 }];
      const v = lagged ? lagged({ t: 1.1, bx: 130, by: 0, posHist: hist }) : null;
      ok('★次级动画（行为）：延迟速度取的是**0.1 秒前**那一点（300px/s 这种量级，不是当前速度）',
        !!v && Math.abs(v[0] - 300) < 1 && Math.abs(v[1]) < 1e-6);
      // 竖直方向也要算（跳、被拎起来、坐下时发梢要往下拖）
      const vv = lagged ? lagged({ t: 1.1, bx: 100, by: -40, posHist: [{ t: 1.0, x: 100, y: 0 }] }) : null;
      ok('★次级动画（行为）：竖直方向的速度也参与（跳起来/被放下时发梢会拖）',
        !!vv && Math.abs(vv[1] + 400) < 1e-6 && Math.abs(vv[0]) < 1e-6);
      ok('★次级动画：没有位置历史（老页面 / 内置身体）时返回 0，行为同上游',
        !!lagged && lagged({ t: 1, bx: 9, by: 9, posHist: [] })[0] === 0
        && lagged({ t: 1, bx: 9, by: 9 })[0] === 0);
      const coreSrc2 = fs.readFileSync(path.join(app, 'web', 'pet-core.js'), 'utf8');
      ok('★次级动画：身体位置的环形历史是 pet-core 喂的（`posHist` + `frame.bx/by`）',
        /posHist: \[\]/.test(coreSrc2) && /pet\.posHist\.push\(\{ t: T, x: AX, y: BY \}\)/.test(coreSrc2)
        && /bx: AX, by: AY, posHist: pet\.posHist/.test(coreSrc2));
      ok('★次级动画：延迟速度接进了发梢/刘海/尾巴/呆毛的弹簧目标',
        /const lagH = clamp\(-lagX \* LAG_HAIR/.test(figSrc)
        && /sp\.hair\.step\(sway \* 1\.1[^;]*lagH, dt\)/.test(figSrc)
        && /sp\.tail\.step\(sway \* 14 \+ tailMood \* 12 \+ lagT, dt\)/.test(figSrc));
    }
    /**
     * ★ **眨眼睫毛阴影**：必须是**叠在脸那块画布上、用 source-atop 裁住**的（0 新贴图），
     * 而且**用完必须还原 `source-over`**（否则后面所有脸部绘制都会被改掉，症状是"脸花了"）。
     */
    {
      const figSrc = fs.readFileSync(path.join(app, 'web', 'whale', 'figure.js'), 'utf8');
      const block = figSrc.match(/if \(shut > \.06\) \{[\s\S]*?\n    \}\n    fg\.save\(\);/);
      ok('★眨眼睫毛阴影：闭眼时在脸上叠一道渐变（source-atop 裁在脸内部，0 新贴图）',
        !!block && /source-atop/.test(block[0]) && /createLinearGradient/.test(block[0])
        && /fillRect/.test(block[0]));
      ok('★眨眼睫毛阴影：必须用 save/restore 把 source-atop 与 fillStyle 严丝合缝地包起来（漏出去会把后面的脸画花）',
        !!block && /fg\.save\(\);[\s\S]*source-atop[\s\S]*fillRect[\s\S]*fg\.restore\(\);/.test(block[0]));
      // 闭眼量是从 `o.blink`/`o.eyeClose` 来的，而且**眨眼那几帧必须让脸重画**
      // （figure.js 的脏检查：`blink > .02` 时 `faceStamp` 返回 null → 每帧重画）
      ok('★眨眼睫毛阴影：闭眼量取自这一帧的 blink/eyeClose，且脏检查不会把眨眼那几帧跳过去',
        /shut = Math\.max\(o\.blink \|\| 0, o\.eyeClose \|\| 0\)/.test(figSrc)
        && /\(o\.blink \|\| 0\) > \.02 \|\| \(o\.eyeClose \|\| 0\) > \.02\) return null/.test(figSrc));
    }
    /**
     * ★ **桌面接地光（行为）**：`oklabRgb()` 是 `oklab()` 的反函数，两件事都要成立：
     * ① **来回一趟不掉色**（灰进灰出、彩色进彩色出，误差 ≤2/255）——
     *    它错了不会抛异常，只会让轮廓光和影子**静默变色**（最难查的一类）；
     * ② **轮廓光与桌面反着来**：浅桌面给暗轮廓、深桌面给亮轮廓（这是"贴上去"变成"长在上面"的关键）。
     */
    {
      const appSrc = fs.readFileSync(path.join(app, 'web', 'pet-app.js'), 'utf8');
      const grab = (re) => { const m = appSrc.match(re); return m ? m[0] : ''; };
      const src = [
        grab(/const lin = [^\n]+/), grab(/const clamp01 = [^\n]+/), grab(/const hex = [^\n]+/),
        grab(/function oklab\(r, g, b\) \{[\s\S]*?\n\}/), grab(/function oklabRgb\(L, A, B\) \{[\s\S]*?\n\}/),
        'return { oklab, oklabRgb, hex, clamp01 };',
      ].join('\n');
      let fns = null;
      try { fns = new Function(src)(); } catch (e) { /* 抠不出来就算没通过（下面那条 ok 会红） */ }
      /**
       * 用**逐通道容差**：OKLab 的立方根与三次方不可结合、逆矩阵常数只有 4 位有效数字，
       * 所以"绕一圈"本来就带几级量化误差 —— 实测 灰/浅色 ≤3，而蓝色 200 那一档 g 偏 **21**
       * （数值性质，不是抄错）。这条验证钉的是**矩阵抄没抄错**（抄错会偏几十上百，比如 g 偏 21
       * 换成其它通道就是 80+），所以容差按通道给。灰必须几乎不偏，这是最灵敏的那一路。
       */
      const near = (a, b, tol) => Math.max(...a.map((v, i) => Math.abs(v - b[i]))) <= tol;
      const round = (r, g, b) => {
        const [L, A, B] = fns.oklab(r, g, b);
        return fns.oklabRgb(L, A, B);
      };
      ok('★桌面接地光（行为）：OKLab→sRGB 的往返不掉色（灰必须≤4，深蓝允许通道量化误差≤24）',
        !!fns && near(round(128, 128, 128), [128, 128, 128], 4) && near(round(250, 240, 230), [250, 240, 230], 4)
        && near(round(40, 90, 200), [40, 90, 200], 24));
      const light = fns.oklab(...[240, 238, 235]);
      const dark = fns.oklab(...[18, 20, 26]);
      const halo = (l, a, b) => fns.oklabRgb(fns.clamp01(l > .58 ? l - .32 : l + .32), a * .35, b * .35);
      const hl = fns.oklab(...halo(...light)), hd = fns.oklab(...halo(...dark));
      ok('★桌面接地光（行为）：浅桌面给**更暗**的轮廓光、深桌面给**更亮**的轮廓光',
        hl[0] < light[0] - .15 && hd[0] > dark[0] + .15);
      ok('★桌面接地光：影子颜色由身后的平均色染出来（但保持很淡，不当成一块黑）',
        /const sRgb = oklabRgb\(\.17 \+ bl \* \.04, ba \* \.28, bb \* \.28\)/.test(appSrc)
        && /shadowTint = \{ rgb: sRgb, a: bl < \.30 \? \.26/.test(appSrc)
        && /shadowEl\.setAttribute\('fill'/.test(appSrc));
      ok('★桌面接地光：抓屏节奏——轮廓光开着时 0.8s，平时 2.5s（第 10.1 节①那条开销项）',
        /const every = backdrop\.on \? BACKDROP_EVERY : BACKDROP_EVERY_CALM/.test(appSrc)
        && /BACKDROP_EVERY_CALM = 2\.5/.test(appSrc));
    }

    /**
     * ★ **身体部位判定：从 7 类细化到 15 类**（2026-10-10 用户实测报"戳嘴巴识别到呆毛"之后重做）。
     *
     * 这一节验三件事，缺一件都会**静默出错**：
     * ① **三处名字必须对得上**：`pet-app.js` 的 `REGION_BOXES`/`REGION_AT`（页面判出来的）、
     *    `pet.cjs` 的 `AREAS`/`AREA_CN`（World 认不认）、`lines.cjs` 的 `pokeArea`/`petArea`
     *    （有没有那个部位的话）。**对不上不会报错**，只是那个部位悄悄说通用台词。
     * ② **`GRAB_STYLE` 必须覆盖全部部位**：漏一个，抓那儿拎起来就是 `undefined` 悬挂角。
     * ③ **判定行为**：把自己写的判定逻辑（`petRegion`）抠出来，喂**真实坐标**量一遍 ——
     *    尤其是用户报的那一条：**戳嘴（y≈147）必须不是呆毛**。
     */
    {
      const appSrc3 = fs.readFileSync(path.join(app, 'web', 'pet-app.js'), 'utf8');
      const petSrc = fs.readFileSync(path.join(app, 'pet.cjs'), 'utf8');
      const grabSrc = appSrc3.match(/const GRAB_STYLE = \{[\s\S]*?\n\};/);
      const boxesSrc3 = (appSrc3.match(/const REGION_BOXES = \[[\s\S]*?\n\];/) || [''])[0];
      const atSrc3 = (appSrc3.match(/const REGION_AT = \[[\s\S]*?\n\];/) || [''])[0];
      /**
       * ⚠️ 部位名**直接从两张表里抠**，不要去找 `const REGION_IDS = …` 那一行 ——
       * 上面注释里也写着 `REGION_IDS` 这个词，正则一贪心就抠到注释上去了（实测踩过：
       * 抠出来的集合是空的，于是"名字都对得上"那几条**假绿**）。
       */
      const ids = new Set([...boxesSrc3.matchAll(/\['([a-z_]+)',/g), ...atSrc3.matchAll(/\['([a-z_]+)',/g)]
        .map((m) => m[1]));
      ok('★部位：判定表里确实有 15 个部位，而且呆毛与头发是分开的',
        ids.size === 15 && ids.has('ahoge') && ids.has('hair') && ids.has('eyes')
        && ids.has('cheek') && ids.has('chin') && ids.has('thigh') && ids.has('chest'));

      const missArea = [...ids].filter((id) => !new RegExp(`'${id}'`).test(petSrc));
      ok('★部位：15 个名字在 pet.cjs 的 AREAS 里都认（漏一个那个部位就只会说通用台词）', missArea.length === 0);
      const cnSrc = petSrc.match(/const AREA_CN = \{[\s\S]*?\n\};/);
      const missCn = [...ids].filter((id) => !new RegExp(`${id}:`).test(cnSrc ? cnSrc[0] : ''));
      ok('★部位：15 个名字都有中文名（AREA_CN；模型读上下文时用的就是它）', missCn.length === 0);
      const missGrab = [...ids].filter((id) => !new RegExp(`\\b${id}: \\{ hang:`).test(grabSrc ? grabSrc[0] : ''));
      ok('★部位：GRAB_STYLE 覆盖全部 15 个（漏一个抓那儿拎起来就是 undefined）', missGrab.length === 0);

      const linesSrc = fs.readFileSync(path.join(app, 'lines.cjs'), 'utf8');
      const pokeSrc = linesSrc.match(/pokeArea: \{[\s\S]*?\n  \},/);
      const petAreaSrc = linesSrc.match(/petArea: \{[\s\S]*?\n  \},/);
      const missPoke = [...ids].filter((id) => !new RegExp(`\\n\\s+${id}: \\[`).test(pokeSrc ? pokeSrc[0] : ''));
      const missPet = [...ids].filter((id) => !new RegExp(`\\n\\s+${id}: \\[`).test(petAreaSrc ? petAreaSrc[0] : ''));
      ok('★部位：15 个部位在 lines.cjs 的 pokeArea 里都有话（戳哪儿说哪儿）', missPoke.length === 0);
      ok('★部位：15 个部位在 lines.cjs 的 petArea 里都有话（蹭哪儿说哪儿）', missPet.length === 0);

      /* --- 行为验证：直接照**同一张表**算一遍（不再去 eval 产品源码：那玩意儿太脆） --- */
      /**
       * 说明：这里**故意不抠 pet-app.js 的函数体**。试过，结果是自检自己成了最难查的东西
       * （模板引号写错 → 只插进去一个字符 → `c is not defined`，绕了半小时）。
       * 换成"用同一份表按同一条规则算"：只要判定规则改了而这里没跟着改，
       * 下面几条会红 —— 这就够了；页面真跑起来的行为由用户实测兜底。
       */
      const parseRegions = (src) => [...src.matchAll(/\['([a-z_]+)',\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+),\s*([\d.]+))?\]/g)]
        .map((m) => ({ id: m[1], x: +m[2], y: +m[3], box: m[4] ? [+m[2], +m[3], +m[4], +m[5]] : null }));
      const regionHits = (x, y) => {
        for (const r of parseRegions(boxesSrc3)) {
          if (x >= r.box[0] && x <= r.box[2] && y >= r.box[1] && y <= r.box[3]) return r.id;
        }
        let best = '', far = Infinity;
        for (const r of parseRegions(atSrc3)) {
          const d = Math.hypot(x - r.x, y - r.y);
          if (d < far) { far = d; best = r.id; }
        }
        return best;
      };
      const hit = regionHits;
      ok('★部位（行为）：戳**嘴**（138,147）不再判成呆毛，而且呆毛自己那一撮仍然判得对',
        hit(138, 147) === 'chin' && hit(114, 30) === 'ahoge');
      ok('★部位（行为）：眼睛 / 脸蛋 / 头发 / 胸口 / 手 / 大腿 / 脚 都落在对的格子里',
        hit(148, 115) === 'eyes' && hit(120, 131) === 'cheek' && hit(95, 106) === 'hair'
        && hit(130, 168) === 'chest' && hit(108, 205) === 'hand' && hit(140, 228) === 'thigh'
        && hit(112, 250) === 'foot' && hit(65.8, 192.4) === 'tail');
      ok('★部位（行为）：旧 7 类里"手"的锚点（108,185）不再把裙子当手（那里是发梢，归头发）',
        hit(108, 185) === 'hair' && hit(108, 202) === 'hand');
    }

    /**
     * ★ **天气粒子的轨迹、铺满、形状**（2026-10-10 重写之后加的；2026-10-11 换成 canvas 之后改写）。
     *
     * 为什么要它：用户实测报过三件事 —— ① "只有左半边有粒子"；② "像五毛特效，不模拟现实轨迹"；
     * ③ "樱花和落叶还是不够像"。这三条**都不会抛错**（粒子少、轨迹假、形状丑，代码照样跑），
     * 所以在自检里量出来：
     *   · **铺满**：雪在 1280 宽上要跨过大半个宽度（留 120px 余量，因为边缘允许出画）；
     *   · **够密**：雨不能只有十几条（真实的雨是同屏两三百条的量级，我们按性能砍到一百多）；
     *   · **翻滚**：叶子/花瓣要真的用 `|cos|` 压扁（侧立时变窄 = 叶子，不是纸屑）；
     *   · **形状**：花瓣的几何量（缺口深度/最宽处/根宽）+ 叶子的"脉够不够多"（≥8 笔）；
     *   · **真的画到画布上**：canvas 版最容易"沉默失败"的一处 —— 形状算得再对，
     *     贴图没 `drawImage` 就是一片空白，所以这里连 `stroke/fill/drawImage` 的调用数一起数。
     *
     * ⚠️ 这套断言**必须跟着渲染方式走**：粒子从 SVG 换成 canvas 之后，
     * 原来查 `innerHTML` 里 `<path d=`/`scale(` 的写法就全废了（会变成"绿着但什么都没测"）。
     * 现在查的是 `fx.stats()`（fx.js 里那份"这一帧画了什么"的清单）和录制用的假画布。
     */
    {
      /**
       * 假画布：`getContext('2d')` 给一个**记账用**的 2D 上下文 ——
       * 每个方法都能调用（记录调用次数）、`createLinearGradient` 给一个带 `addColorStop` 的对象。
       * 这样"贴图烘出来了吗"就有据可查。
       */
      /**
       * ★ **一个"能真的留下像素"的假 2D 上下文**（只有自检用）。
       *
       * 为什么要它：粒子层换 canvas 之后，最容易**静默失效**的地方是贴图 —— 一张全透明的贴图
       * `drawImage` 出去完全合法、不报错，表现是"粒子一颗都看不见"（本轮抓到的就是这个：
       * 形状参数被传成了 `'n'`，路径里全是 `NaN`，`fill()` 什么都不画）。
       * 只数调用次数抓不住它，所以这里按调用的包围盒往像素缓冲里写 alpha（渐变就当实色），
       * 之后 `sprites()` 用 `getImageData` 数不透明像素 —— "贴图里有没有肉"就成了可测的数。
       */
      let ctxStrokes = 0;
      function FakeCtx(cv) {
        this.cv = cv;
        this.t = [1, 0, 0, 1, 0, 0];
        this.a = 1;
        this.fs = '#888'; this.ss = '#888'; this.lw = 1;
        this.path = [];
        this.pts = [];
      }
      FakeCtx.prototype = {
        clearRect(x, y, w, h) {
          const d = this.cv._buf; if (!d) return;
          for (let yy = Math.max(0, Math.floor(y)); yy < Math.min(this.cv.height, Math.ceil(y + h)); yy += 1) {
            for (let xx = Math.max(0, Math.floor(x)); xx < Math.min(this.cv.width, Math.ceil(x + w)); xx += 1) d[(yy * this.cv.width + xx) * 4 + 3] = 0;
          }
        },
        _buf() { const c = this.cv; if (!c._buf || c._buf.length !== c.width * c.height * 4) c._buf = new Uint8ClampedArray(c.width * c.height * 4); return c._buf; },
        _tf(x, y) { const [a, b, c2, d, e, f] = this.t; return [a * x + c2 * y + e, b * x + d * y + f]; },
        setTransform(a, b, c2, d, e, f) { this.t = [a, b, c2, d, e, f]; },
        // ⚠️ 变换统一**左乘**（`t = t · m`）—— 和 `rotate` 用同一套约定，否则 `translate` 之后
        // 画出来的东西会跑到画布外（自检量到的 ink 就变成"只有描边"的假象）
        rotate(r) { const [a, b, c2, d, e, f] = this.t, co = Math.cos(r), si = Math.sin(r); this.t = [a * co + c2 * si, b * co + d * si, a * -si + c2 * co, b * -si + d * co, e, f]; },
        translate(x, y) { const t = this.t; this.t = [t[0], t[1], t[2], t[3], t[4] + t[0] * x + t[2] * y, t[5] + t[1] * x + t[3] * y]; },
        scale(x, y) { const t = this.t; this.t = [t[0] * x, t[1] * x, t[2] * y, t[3] * y, t[4], t[5]]; },
        getTransform() { return { a: this.t[0], b: this.t[1], c: this.t[2], d: this.t[3], e: this.t[4], f: this.t[5] }; },
        save() { this._saved = (this._saved || []).concat([[this.t.slice(), this.a]]); },
        restore() { const s = this._saved && this._saved.pop(); if (s) { this.t = s[0]; this.a = s[1]; } },
        beginPath() { this.pts = []; }, closePath() {}, clip() {},
        moveTo(x, y) { this.pts.push(this._tf(x, y)); }, lineTo(x, y) { this.pts.push(this._tf(x, y)); },
        bezierCurveTo(x1, y1, x2, y2, x3, y3) {
          const p0 = this.pts[this.pts.length - 1] || this._tf(0, 0);
          const P = [p0, this._tf(x1, y1), this._tf(x2, y2), this._tf(x3, y3)];
          for (let i = 1; i <= 12; i += 1) {
            const t = i / 12, u = 1 - t;
            this.pts.push([
              u * u * u * P[0][0] + 3 * u * u * t * P[1][0] + 3 * u * t * t * P[2][0] + t * t * t * P[3][0],
              u * u * u * P[0][1] + 3 * u * u * t * P[1][1] + 3 * u * t * t * P[2][1] + t * t * t * P[3][1],
            ]);
          }
        },
        quadraticCurveTo(x1, y1, x2, y2) { this.bezierCurveTo(x1, y1, x1, y1, x2, y2); },
        arc(x, y, r) { for (let i = 0; i <= 12; i += 1) this.pts.push(this._tf(x + Math.cos(i / 12 * 6.283) * r, y + Math.sin(i / 12 * 6.283) * r)); },
        ellipse(x, y, rx, ry) { for (let i = 0; i <= 12; i += 1) this.pts.push(this._tf(x + Math.cos(i / 12 * 6.283) * rx, y + Math.sin(i / 12 * 6.283) * ry)); },
        rect(x, y, w, h) { this.pts.push(this._tf(x, y), this._tf(x + w, y), this._tf(x + w, y + h), this._tf(x, y + h)); },
        _box() {
          if (!this.pts.length) return null;
          let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
          for (const [px, py] of this.pts) { if (px < x0) x0 = px; if (px > x1) x1 = px; if (py < y0) y0 = py; if (py > y1) y1 = py; }
          return [x0, y0, x1, y1];
        },
        _paint(box, alpha, col) {
          if (!box) return;
          const d = this._buf(), W = this.cv.width, H = this.cv.height;
          const [r, g, b] = (col || '#888888').match(/\d+/g)?.map(Number) || [136, 136, 136];
          for (let yy = Math.max(0, Math.floor(box[1])); yy <= Math.min(H - 1, Math.ceil(box[3])); yy += 1) {
            for (let xx = Math.max(0, Math.floor(box[0])); xx <= Math.min(W - 1, Math.ceil(box[2])); xx += 1) {
              d[(yy * W + xx) * 4] = r; d[(yy * W + xx) * 4 + 1] = g; d[(yy * W + xx) * 4 + 2] = b;
              d[(yy * W + xx) * 4 + 3] = Math.round(255 * Math.min(1, alpha));
            }
          }
        },
        fill() { this._paint(this._box(), this.a, typeof this.fs === 'string' ? this.fs : (this.fs._c || '#888888')); },
        stroke() {
          ctxStrokes += 1;
          const b = this._box();
          if (b) { const p = this.lw / 2; this._paint([b[0] - p, b[1] - p, b[2] + p, b[3] + p], this.a, typeof this.ss === 'string' ? this.ss : '#888888'); }
        },
        fillText() {},
        drawImage(img, dx, dy) {
          if (!img || !img._buf) return;
          const d = this._buf(), W = this.cv.width, H = this.cv.height;
          for (let y = 0; y < img.height; y += 1) {
            const ty = Math.round(dy + y); if (ty < 0 || ty >= H) continue;
            for (let x = 0; x < img.width; x += 1) {
              const tx = Math.round(dx + x); if (tx < 0 || tx >= W) continue;
              const si = (y * img.width + x) * 4, di = (ty * W + tx) * 4;
              const sa = img._buf[si + 3] / 255; if (sa <= 0) continue;
              const da = d[di + 3] / 255, oa = sa + da * (1 - sa);
              d[di] = (img._buf[si] * sa + d[di] * da * (1 - sa)) / (oa || 1);
              d[di + 1] = (img._buf[si + 1] * sa + d[di + 1] * da * (1 - sa)) / (oa || 1);
              d[di + 2] = (img._buf[si + 2] * sa + d[di + 2] * da * (1 - sa)) / (oa || 1);
              d[di + 3] = Math.round(oa * 255);
            }
          }
        },
        getImageData(x, y, w, h) {
          const d = this._buf(), out = new Uint8ClampedArray(w * h * 4);
          for (let yy = 0; yy < h; yy += 1) for (let xx = 0; xx < w; xx += 1) {
            const si = ((y + yy) * this.cv.width + (x + xx)) * 4, di = (yy * w + xx) * 4;
            if (si >= 0 && si + 3 < d.length) for (let k = 0; k < 4; k += 1) out[di + k] = d[si + k];
          }
          return { data: out, width: w, height: h };
        },
        createLinearGradient: (...a) => { const g = { stops: [], addColorStop(p, c) { this.stops.push([p, c]); } }; void a; return g; },
        createRadialGradient: () => ({ addColorStop() {} }),
        createPattern: () => null,
      };
      Object.defineProperty(FakeCtx.prototype, 'fillStyle', { set(v) { this.fs = v; }, get() { return this.fs; } });
      Object.defineProperty(FakeCtx.prototype, 'strokeStyle', { set(v) { this.ss = v; }, get() { return this.ss; } });
      Object.defineProperty(FakeCtx.prototype, 'globalAlpha', { set(v) { this.a = v; }, get() { return this.a; } });
      for (const k of ['lineWidth', 'globalCompositeOperation', 'font', 'textAlign', 'textBaseline', 'lineCap', 'lineJoin', 'filter']) {
        Object.defineProperty(FakeCtx.prototype, k, { set(v) { this['_' + k] = v; }, get() { return this['_' + k]; } });
      }
      // mock 里读渐变时不用取色（`ink` 只看 alpha，颜色取兜底灰就够）
      const fakeCanvas = () => {
        const c = { width: 1, height: 1, style: {}, getBoundingClientRect: () => ({ x: 0, y: 0, width: 1, height: 1 }) };
        c.getContext = (kind) => (kind === '2d' ? (c._ctx = c._ctx || new FakeCtx(c)) : null);
        return c;
      };
      const stubEl = () => ({ width: 1, height: 1, style: {}, getBoundingClientRect: () => ({ x: 0, y: 0, width: 1, height: 1 }), getContext: () => null });
      const savedWin = globalThis.window, savedDoc = globalThis.document;
      globalThis.window = globalThis;
      globalThis.document = {
        createElementNS: stubEl,
        createElement: (tag) => (tag === 'canvas' ? fakeCanvas() : stubEl()),
        querySelector: () => null,
        addEventListener() {},
        documentElement: {},
      };
      globalThis.Path2D = globalThis.Path2D || class { constructor(d) { this.d = d; } };
      let fxMod = null;
      try { fxMod = await import(pathToFileURL(path.join(app, 'web', 'fx.js')).href); } catch (e) { fxMod = null; }
      const canvas = fakeCanvas();
      const wrapper = { value: canvas };
      const fx = fxMod ? fxMod.createFx({
        ctl: { bounds: { W: 1280, H: 760 } },
        canvas,
        // 贴图/主画布的 2D 上下文都由 `fakeCanvas` 给（它会把像素真的写进缓冲，`ink` 才能量）
        onCtx: (g) => { wrapper.value = canvas; return g; },
      }) : null;
      const run = (kind, secs) => {
        for (let f = 1; f <= secs * 60; f += 1) fx.frame(1 / 60, f / 60, kind);
        return { xs: fx.xs() || [], n: fx.count, st: fx.stats(), kinds: fx.kinds() };
      };
      const snow = fx ? run('snow', 40) : null;
      ok('★天气粒子（行为）：雪要铺满整个窗口宽度（不是只落在左半边）',
        !!snow && snow.xs[0] < 120 && snow.xs[1] > 1160 && snow.n > 30);
      const rain = fx ? run('rain', 10) : null;
      ok('★天气粒子（行为）：雨要够密（同屏一百条以上）而且落到底会溅落',
        !!rain && rain.n > 95 && rain.st.meta.splash > 0 && rain.st.meta.byKind.rain > 80);
      const leaf = fx ? run('leaf', 40) : null;
      ok('★天气粒子（行为）：落叶/花瓣用 `scaleX = |cos|` 做翻滚（侧立时会变窄 = 不是纸屑）',
        !!leaf && leaf.n > 12 && leaf.st.meta.minSpin <= .35 && leaf.st.meta.maxSpin >= .9
        && leaf.st.list.every((q) => q.sx >= .1 && q.sx <= 1));
      const blos = fx ? run('blossom', 60) : null;
      ok('★天气粒子（行为）：樱花是**单花瓣**（不是整朵大花）+ 尺寸小（7~16px）',
        !!blos && blos.st.meta.maxLen > 5 && blos.st.meta.maxLen < 17
        && blos.st.meta.byKind.blossom > 8
        && blos.st.list.some((q) => q.shape === 'petal'));
      /**
       * 花瓣/叶子的几何量：这几条是"像不像"的**唯一**判据（不是"我觉得像"）。
       * 量的是**真路径采样**（`samplePath`），不是锚点；三个关键量：
       *   ① 缺口深度 ≥ 0.03（尖端那个小凹）；② 最宽处 0.18~0.30 半宽；
       *   ③ 根部比最宽处窄（细根）；④ 宽长比 0.35~0.8（太瘦像柳叶、太胖像瓜子）；
       *   ⑤ 形状收在单位方框里 —— 否则贴图会把它裁掉（用户实测报过："花瓣少了三分之一"）。
       */
      const met = fxMod && fxMod.PETAL_METRICS;
      ok('★天气粒子（形状）：花瓣 = 细根 + 两侧鼓 + 尖端浅凹口，且宽长比像花瓣（几何量，不是"我觉得像"）'
        + ' [w=' + (met && met.w) + ' h=' + (met && met.h) + ' 缺口=' + (met && met.notchDepth) + ' 根宽=' + (met && met.rootWidth) + ']',
      !!met && met.notchDepth >= .03 && met.maxWidth >= .18 && met.maxWidth <= .30
        && met.rootWidth < met.maxWidth * .8 && met.aspect >= .35 && met.aspect <= .8 && met.inUnitBox);
      const lmet = fxMod && fxMod.LEAF_METRICS;
      ok('★天气粒子（形状）：叶子 = 宽叶身 + 窄叶柄（`stemWidth` ≤ 0.12），而且形状完整落在单位方框里'
        + ' [w=' + (lmet && lmet.w) + ' 柄宽=' + (lmet && lmet.stemWidth) + ']',
      !!lmet && lmet.maxWidth >= .25 && lmet.stemWidth <= .12 && lmet.inUnitBox);
      const spritePaints = (list, shape) => list.filter((q) => q.shape === shape).length;
      ok('★天气粒子（形状）：叶子有主脉 + 每侧 3 条侧脉（贴图里 ≥ 8 笔 stroke，不是一片光叶子）',
        !!leaf && ctxStrokes >= 8 && spritePaints(leaf.st.list, 'leaf') > 0);
      ok('★天气粒子（形状）：樱花花瓣的贴图里也有脉/描边（≥ 3 笔 stroke）',
        !!blos && ctxStrokes >= 3);
      /**
       * ★★ **贴图里必须真的有"肉"**（2026-10-11 加，为一次真实事故）。
       *
       * 事故：`sprite()` 把缓存用的变体名（`'n'`/`'w'`）当成**形状参数**传给了
       * `petalPath()`，于是 `'n' * 1 → NaN`，路径变成 `CNaN NaN …` ——
       * **Path2D 里全是 NaN 时 `fill()` 什么都不画、也不抛错**，画出来只剩描边和一条高光，
       * 看着像"月牙划痕"。断言"贴图的不透明像素占比 ≥ 5%"当场就能抓住它
       * （花瓣形状大概占方框的 25%，只剩描边时不到 3%）。
       */
      /**
       * ★★ **形状路径里不许出现 NaN**（2026-10-11 加，为一次真实事故）。
       *
       * 事故：`sprite()` 把缓存用的变体名（`'n'`/`'w'`）当成**形状参数**传给了 `petalPath()`，
       * 于是 `'n' * 1 → NaN`，路径变成 `CNaN NaN …` —— **Path2D 里全是 NaN 时 `fill()` 什么都不画、
       * 也不抛错**，画出来只剩描边和一条高光，看着像"月牙划痕"。这一条把"路径里有没有非数"
       * 直接量出来，是那次 bug 的**精确**回归防线（不依赖任何假画布的画法）。
       */
      const m6 = fxMod && fxMod.PETAL_METRICS;
      const numKeys = ['maxWidth', 'rootWidth', 'tipY', 'notchY', 'notchDepth', 'aspect', 'w', 'h'];
      ok('★天气粒子（形状）：形状参数不许出 NaN（花瓣的几何量全是有限数，`inUnitBox` 为真）'
        + ' [' + numKeys.map((k) => k + '=' + (m6 && m6[k])).join(' ') + ']',
      !!m6 && numKeys.every((k) => Number.isFinite(m6[k])) && m6.inUnitBox === true);
      /**
       * 贴图里要有"肉"：花瓣/叶子的贴图**实心面积 ≥ 15% 方框**。
       * 只查这两种（花的贴图是五片旋转叠加，假画布的包围盒画法对它偏保守，不适合当硬门槛）——
       * 而"只剩描边"时这一比例会掉到 3% 以下，所以门槛是有区分度的。
       */
      const spr = fx ? fx.sprites() : [];
      const pk = spr.filter((s) => /^p\|/.test(s.key));
      const lk = spr.filter((s) => /^l\|/.test(s.key));
      const ratio = (s) => s.ink / (s.box[0] * s.box[1]);
      ok('★天气粒子（形状）：花瓣/叶子贴图里有实心面积（不透明像素 ≥ 15% 方框；全 NaN 路径只剩描边时抓得住）'
        + ' [花瓣最差 ' + (pk.length ? Math.min(...pk.map(ratio)).toFixed(3) : 'n/a')
        + ' 叶子最差 ' + (lk.length ? Math.min(...lk.map(ratio)).toFixed(3) : 'n/a') + ']',
      pk.length > 0 && lk.length > 0 && pk.every((s) => ratio(s) > .15) && lk.every((s) => ratio(s) > .15));
      ok('★天气粒子（行为）：这一帧真的**画到了画布上**（贴图 drawImage 的调用数 > 0）',
        !!leaf && !!wrapper.value && leaf.st.meta.callImage > 0);
      ok('★天气粒子（行为）：粒子**不再走 SVG**（`innerHTML` 那套会每秒重建上万个 DOM 节点）',
        !!leaf && leaf.st.meta.callStroke >= 0 && !/\.innerHTML\s*=/.test(String(fxMod.createFx)));
      globalThis.window = savedWin; globalThis.document = savedDoc;
    }

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
        createBufferSource() { rec.sources += 1; return node({ buffer: null, loop: false }); }
        createBuffer(ch, len) { return { getChannelData: () => new Float32Array(len) }; }
        createDynamicsCompressor() { return node({}); }
      }
      const savedAC = globalThis.AudioContext;
      globalThis.AudioContext = FakeCtx;
      let ambMod = null;
      try { ambMod = await import(pathToFileURL(path.join(app, 'web', 'ambience.js')).href); } catch (e) { ambMod = null; }
      const amb = ambMod ? ambMod.createAmbience({}) : null;
      ok('★天气音效：模块起得来', !!amb);
      if (amb) {
        amb.unlock();
        const t0 = 100;
        // 雨 10 秒：`follow` 的返回值就是"这一帧放了几个音"
        let rainSounds = 0;
        for (let k = 0; k < 40; k += 1) rainSounds += amb.follow('rain', .05, t0 + k * .25);
        const rainOsc = rec.created.length;
        const bot = () => rec.created.filter((o) => !o.__lfo).length;         // 非 LFO = "点缀"用的振荡器
        ok('★天气音效：切到「雨」会建连续底噪（噪声源 + 滤波器），10 秒里还会排雨滴点缀'
          + ' [底噪源 ' + rec.sources + ' · 滤波器 ' + rec.filters + ' · 点缀 ' + rainSounds + ' 个]',
        rec.sources >= 2 && rec.filters >= 2 && rainOsc >= 1 && rainSounds >= 1);
        const before = bot();
        amb.switchTo('blossom');
        ok('★天气音效：只切天气、不推进时间，**不该**建任何点缀（点缀的排期归 `follow` 管；'
          + '底噪的 LFO 重建不算）',
        bot() === before);
        let birdSounds = 0;
        // ★ 樱花天的点缀间隔是 6~16 秒（随机），所以这里**推 50 秒**——不然"这 10 秒里正好没鸟"
        //   会让自检偶发 FAIL（定时随机的断言必须给足时间，别让它变成掷骰子）
        for (let k = 0; k < 200; k += 1) birdSounds += amb.follow('blossom', .05, t0 + 400 + k * .25);
        ok('★天气音效：樱花天的点缀是鸟叫（滑音振荡器），跟"雨的雨滴"不是一回事'
          + ' [点缀 ' + birdSounds + ' 个]',
        bot() > before && birdSounds >= 1 && rec.created.filter((o) => !o.__lfo).slice(before).some((o) => o.type === 'sine'));
        amb.setEnabled(false);
        amb.follow('rain', .05, t0 + 800);
        ok('★天气音效：关掉音效开关 → 输出增益归零、且最后会 suspend 掉 AudioContext',
          rec.suspended > 0 || rec.gains > 0);
      }
      globalThis.AudioContext = savedAC;
    }

    ws.close();
  } finally {
    server.close();
    stub.server.close();
    // 语音的工作线程必须在这里收掉：`tts.warm()` 起的那个 worker 会让 Node 的事件循环
    // 一直活着，自检就算全绿也**永远不退出**——命令行看着就是"卡住了"（实测就在这上面
    // 白等过 8 分钟：131 项全通过，进程却挂着不走）。这里收不干净的话，下面的
    // `process.exit(0)` 兜底。
    try { tts.close(); } catch (e) { /* 没装语音时没有 worker，无所谓 */ }
    fs.rmSync(CONFIG_DIR, { recursive: true, force: true });
  }

  console.log(`\n${passed} 项全部通过`);
  // 明确的成功退出码：让 `node test\smoke.cjs; if ($?)` 这种用法立刻拿到结果，
  // 不用再等事件循环自己空下来。
  process.exit(0);
})().catch((err) => {
  console.error(`\n${err.message}`);
  if (process.env.DSP_SMOKE_TRACE) console.error((err && err.stack) || '(no stack)');
  fs.rmSync(CONFIG_DIR, { recursive: true, force: true });
  process.exit(1);
});
