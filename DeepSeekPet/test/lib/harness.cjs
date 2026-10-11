/**
 * 自检骨架（2026-10-11 拆分）。
 *
 * **为什么拆**：原来 `smoke.cjs` 是一个 2700 行的顺序脚本，372 项全跑要 **166 秒** ——
 * 实测慢的不是"检查多"，而是**6 个区域各自在等真实的墙钟时间**（气泡间隔、静默期、模型往返）。
 * 所以改一处小地方也得等两三分钟，没法"只跑我改的那一块"。
 *
 * **现在长这样**：
 *   · `lib/harness.cjs`（本文件）：临时目录、`ok()`、计数、区域清单、加载器。
 *   · `regions\NN-名字.cjs`：**一个区域一个文件**，互不依赖，可以单独跑（各自一个 Node 进程）。
 *   · `smoke.cjs`：把区域按顺序拼起来 —— `node test\smoke.cjs` 全部，
 *     `node test\smoke.cjs 天气` 只跑名字/标签里带"天气"的，`--list` 列出来。
 *
 * 约定：区域文件导出一个 `{ name, tags, run(ctx) }`。**`ctx` 里没有 `fs` / `path` 之外的魔法**，
 * 区域之间不许共享可变量（原来共享的那几个 `let` 已经跟着各自区域搬走了）。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { pathToFileURL } = require('node:url');

/** 应用本体（`resources\app`）与工作区根。 */
const app = path.join(__dirname, '..', '..', 'resources', 'app');
const root = path.join(__dirname, '..', '..');

/**
 * 配置与日志都指到临时目录 —— 必须在**加载任何应用模块之前**设好：
 * `llm.cjs` / `log.cjs` 在加载时就决定各自的目录（`pet.cjs` 也在那时读自动说话的间隔）。
 * 这样自检既不碰用户真实的 `settings.json`，也不会把假模型流量写进桌宠自己的 `pet.log`。
 */
const CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dsp-test-'));
process.env.DSP_CONFIG_DIR = CONFIG_DIR;
process.env.DSP_LOG_DIR = CONFIG_DIR;
// 自动说话默认一分钟一次、静默期也是一分钟，自检等不起：都压短
process.env.DSP_AUTO_CHAT_MS = '3500';
process.env.DSP_AUTO_CHAT_QUIET_MS = '8000';

/** 应用模块**按需**加载（区域用什么装什么；免得一个区域的自检把别人的模块也拉起来）。 */
const mods = {};
function mod(name) {
  if (!mods[name]) mods[name] = require(path.join(app, `${name}.cjs`));
  return mods[name];
}

/**
 * 一个假的 OpenAI 兼容端点：记下收到的请求，回固定的一句话。
 * 模型名决定它怎么回答：
 *   · `fail-me`    → 401（考"报错说人话"）
 *   · `slow-model` → 第一次故意慢 4.1 秒（模拟模型加载，考冷/热分开报）
 *   · `vary-model` → 每次换一句（自动说话要能换花样才算正常）
 *   · `same-model` → 永远同一句（考"太像就别再说"）
 *   · `echo-model` → 照抄（考"别让它说'系统提示我…'"）
 *   · `repeat-model` → 永远一句谁都没说过的话（考防重复）
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

/** 一起跑：起服务 + 假模型端点 + 报告。关闭时把临时目录和语音 worker 都收干净。 */
function run(regions, { pick = null, note = '' } = {}) {
  const chosen = pick ? regions.filter(pick) : regions;
  return (async () => {
    const { startServer } = mod('server');
    const { server, port } = await startServer();
    const base = `http://127.0.0.1:${port}`;
    const state = { passed: 0, failed: 0, ran: [] };
    const ok = (name, cond) => {
      if (!cond) throw new Error(`FAIL ${name}`);
      state.passed += 1;
      console.log(`  ok  ${name}${process.env.DSP_SMOKE_REGION ? `\t[${current}]` : ''}`);
    };
    /** 假模型端点**谁来用谁来起**（用不到的区域不该平白多一个 http server）。 */
    let stub = null;
    let current = '(启动)';
    const ensureStub = async () => (stub || (stub = await stubModel()));
    const ctx = {
      app, root, CONFIG_DIR, ok, state, base, port, fs, path, http, pathToFileURL,
      checkLines, pageAreas, pageStages, pageGrabParts, textsOf, textsFilled, ACTIONS, FILES,
      /**
       * 原文件每个区域开头都有一句 `__mark('…')`（那时是用来量各区域耗时的）。
       * 现在耗时由骨架按区域打（`DSP_SMOKE_TIME=1`），所以这里保留成**空实现**：
       * 区域代码一个字都不用改，也不会报 `__mark is not defined`。
       */
      __mark: () => {},
      /** 页面 WebSocket 客户端（区域 5 用真连接跑往返）。 */
      WebSocket: require(path.join(app, 'node_modules', 'ws')).WebSocket,
      /** 假模型端点：`const stub = await ctx.ensureStub()`。 */
      ensureStub,
      mod,
      /** 台词库 / 桌宠世界 / 模型客户端：常用，直接给（还是惰性）。 */
      get lines() { return mod('lines'); },
      get pet() { return mod('pet'); },
      get llm() { return mod('llm'); },
      get store() { return mod('store'); },
      /** `import('file://…?bust')` 的包装：ESM 页面模块每次都要拿到**新的模块实例**。 */
      importFresh: (rel) => import(`${pathToFileURL(path.join(app, rel)).href}?smoke=${Date.now()}`),
    };
    try {
      exposeGlobals(ctx);
      for (const r of chosen) {
        current = r.name;
        const t0 = Date.now();
        await r.run(ctx);
        state.ran.push(r.name);
        if (process.env.DSP_SMOKE_TIME) {
          console.log(`  [耗时] ${r.name} ${((Date.now() - t0) / 1000).toFixed(1)}s`);
        }
      }
    } finally {
      try { mod('tts').close(); } catch (e) { /* 没装语音时没有 worker，无所谓 */ }
      if (stub) stub.server.close();
      server.close();
      fs.rmSync(CONFIG_DIR, { recursive: true, force: true });
    }
    console.log(`\n${state.passed} 项全部通过${note ? `（${note}）` : ''}`);
    return { passed: state.passed, ran: state.ran };
  })();
}

/** 区域清单：`regions\*.cjs`，按文件名里的序号排。 */
function listRegions(dir) {
  const files = fs.readdirSync(dir).filter((f) => /\.cjs$/.test(f) && !f.startsWith('_')).sort();
  return files.map((f) => {
    const r = require(path.join(dir, f));
    return { ...r, file: f };
  });
}

/** 区域选择器：`node test\smoke.cjs 天气 ball` → 名字或标签里含任一个词就选中。 */
function selector(words) {
  if (!words.length) return null;
  return (r) => {
    const hay = `${r.name} ${(r.tags || []).join(' ')} ${r.file || ''}`.toLowerCase();
    return words.some((w) => hay.includes(w.toLowerCase()));
  };
}

/** 命令行：`--list` 就打印清单并退出。 */
function cli({ regions, runAll, title }) {
  const argv = process.argv.slice(2);
  if (argv.includes('--list') || argv.includes('-l')) {
    console.log(title);
    for (const r of regions) console.log(`  ${(r.tags || []).join(',') || '-'}\t${r.name}`);
    return Promise.resolve(null);
  }
  const pick = selector(argv.filter((a) => !a.startsWith('-')));
  const note = pick ? `只跑了 ${regions.filter(pick).length}/${regions.length} 个区域` : '';
  if (pick && !regions.some(pick)) {
    console.error(`没有匹配的区域：${argv.join(' ')}（用 --list 看清单）`);
    process.exit(2);
  }
  return runAll(pick, note);
}

/**
 * 区域超时兜底：某些区域在等真实计时器，机器忙的时候会拖。
 * 超时不是"失败"，但也别让整个自检挂着不走。
 */
function withTimeout(p, ms, what) {
  return Promise.race([
    p,
    new Promise((_, rej) => { const t = setTimeout(() => rej(new Error(`区域超时（${ms / 1000}s）：${what}`)), ms); t.unref?.(); }),
  ]);
}

/* ---------- 区域共用的小工具（原来写在 smoke.cjs 的顶部，现在归这里） ---------- */

/** 页面会去取的每一个文件（区域 1 用它逐个取回来看类型）。 */
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
 * ⚠️ **两件事容易被这里"误伤"**（2026-10-10 部位细化时踩到的）：
 *  ① 台词库里**可以有不那么"台词"的叶子**，比如 `petAreaFallback`（`{ ahoge: 'hair', … }`
 *     这种纯映射）—— 它里面的值是**字符串**，不是 `{text}`，旧版会报"没有 text"。所以只对**对象**继续往下查。
 *  ② 展开运算符（`...someObject`）会**造出循环引用**，递归遍历会当场栈溢出
 *     （症状是没有栈的 `Maximum call stack size exceeded`）—— 所以用 `seen` 挡一道。
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
 * 拿来和台词桶对一下：**页面改了名字、台词没跟上**的话，World 会静默退回通用台词。
 * ⚠️ 只认 `['名字',` 这个形状，**别用"从 A 切到 B"**（中间插进别的函数名会被当成部位名）。
 */
function pageAreas() {
  const src = fs.readFileSync(path.join(app, 'web', 'pet-app.js'), 'utf8');
  const grab = (re) => (src.match(re) || [''])[0];
  const boxes = grab(/const REGION_BOXES = \[[\s\S]*?\n\];/);
  const anchors = grab(/const REGION_AT = \[[\s\S]*?\n\];/);
  return [...new Set([...boxes.matchAll(/\['([a-z]+)',/g), ...anchors.matchAll(/\['([a-z]+)',/g)]
    .map((m) => m[1]))].sort();
}

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
  // ⚠️ 不能用"行首两个空格 + 名字"：表里**一行写了多个部位**，那样会漏掉同一行后面的
  return [...new Set([...block.matchAll(/([a-z]+): \{/g)].map((m) => m[1]))].sort();
}

/** 若干组台词里的所有 text。 */
function textsOf(...groups) { return groups.flat().map((l) => l.text); }
/** 同上，但**先把占位符填掉**（用 `pet.fill`，跟生产同一套逻辑）。 */
function textsFilled(...groups) {
  return groups.flat().map((l) => mod('pet').fill(l, { name: '你', days: 1, area: '头', words: '', hour: '晚上' }).text);
}

module.exports = {
  app, root, CONFIG_DIR, mod, run, listRegions, selector, cli, withTimeout,
  checkLines, pageAreas, pageStages, pageGrabParts, textsOf, textsFilled, ACTIONS, FILES,
  stubModel,
};

/**
 * ★ **把"每个区域都要的东西"挂成全局**（2026-10-11 补）。
 *
 * 为什么：区域文件是从原来那个 2700 行脚本**按行切**出来的，它们的代码里到处是裸名字
 * （`fs` / `path` / `pet` / `lines` / `ok` / `base` / `port` / `WebSocket` / `__mark` …）。
 * 一开始我让每个区域文件顶部自己 `const { … } = ctx;` —— 结果是**每切一次就要维护一次解构列表**，
 * 而且要求每个区域把自己依赖的每一样都列全（实测漏一个就是一个 `xxx is not defined`）。
 *
 * 现在改成在骨架里**一次性挂好**：区域文件里的裸名字照原样就能解析（`run(ctx)` 里也照样能用 `ctx`）。
 * 应用模块用 **getter 惰性加载**（`globalThis.pet` 不碰就不加载），所以"只跑一小块"依然很快。
 */
function exposeGlobals(ctx) {
  Object.assign(globalThis, {
    fs, path, http, pathToFileURL, app, root, CONFIG_DIR,
    FILES, ACTIONS, checkLines, pageAreas, pageStages, pageGrabParts, textsOf, textsFilled,
    base: ctx.base, port: ctx.port,
    WebSocket: ctx.WebSocket,
    ok: ctx.ok,
    /** 原来写在每个区域开头的计时标记：现在耗时由骨架按区域打，这里留个空实现。 */
    __mark: () => {},
    /** 假模型端点（用到才起）：`const stub = await ensureStub();` */
    ensureStub: ctx.ensureStub,
  });
  for (const name of ['pet', 'lines', 'llm', 'store', 'memory', 'mood', 'dress']) {
    if (Object.prototype.hasOwnProperty.call(globalThis, name)) continue;
    Object.defineProperty(globalThis, name, { get: () => mod(name), configurable: true });
  }
}

module.exports.exposeGlobals = exposeGlobals;
