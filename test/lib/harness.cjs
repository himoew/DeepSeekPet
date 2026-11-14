/**
 * 自检骨架（2026-10-11 拆分）。
 *
 * **为什么拆**：原来 `smoke.cjs` 是一个 2700 行的顺序脚本，372 项全跑要 **166 秒** ——
 * 实测慢的不是"检查多"，而是**6 个区域各自在等真实的墙钟时间**（气泡间隔、静默期、模型往返）。
 * 所以改一处小地方也得等两三分钟，没法"只跑我改的那一块"。
 *
 * **现在长这样**：
 *   · `lib/harness.cjs`（本文件）：临时目录、`ok()`、计数、区域清单、加载器、区域超时兜底。
 *   · `lib/live.cjs`：「真连一遍」那 7 个区域**共用的一条 WebSocket + 全套 helper**
 *     （`ws` / `fromPet` / `init` / `waitFor` / `nextReply` / `drain` / `touchSay` …）。
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
const live = require('./live.cjs');

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
/**
 * 自动说话默认一分钟一次、静默期也是一分钟，自检等不起：都压短。
 *
 * ★ 2026-11-01：**3.5 秒 / 8 秒 → 1.5 秒 / 3 秒**。
 * 原来 `05g-autochat` 把"等够两轮"写成 8000 / 12000 / 16000 三个**裸常量**，
 * 于是间隔压得再小也只省下等待里的零头 —— 那一区白白占了全量 30%（51.9s / 172s）。
 * 现在那一区改成**按这两个变量推导窗口**，所以这里的数值直接决定它的时长；
 * 三秒是 `05g` 里"静默期里不插嘴"那条断言的下界（它等的是静默期的一半）。
 *
 * ⚠️ 改这两个数要**同时**看 `regions\05g-autochat.cjs` 里的 `WINDOW_*` —— 它们是联动的。
 */
process.env.DSP_AUTO_CHAT_MS = '1500';
process.env.DSP_AUTO_CHAT_QUIET_MS = '3000';
/**
 * ★ 2026-10-26：自检**不许真的拉起 QQ/NapCat**。
 * `companion-gateway.cjs` 看到这个变量就只回状态、不 spawn（QQ 会弹窗、还会改本机登录态）。
 * 必须在这里设 —— 它要在任何应用模块被 require 之前生效。
 */
process.env.DSP_NO_GATEWAY = '1';
/**
 * ★ 2026-10-26：自检里的"图床"是 127.0.0.1 的假服务，而生产代码会拒绝内网图片（防 SSRF）。
 * 这个变量**只给自检**放开；`10`/`11` 区域会另有一条显式传 `allowPrivate:false` 的断言，
 * 证明生产默认仍然是拒绝的。
 */
process.env.DSP_MEDIA_ALLOW_PRIVATE = '1';
/**
 * ★ 2026-10-27：自检里默认**关掉自主说话**。别的区域在数"发了几条消息"，
 * 她要是自己冒一句，那些断言就会偶尔飘（实测全量跑撞到过一次）。
 * `16-presence.cjs` 自己显式打开，只在那里验。
 */
process.env.DSP_PRESENCE_OFF = '1';

/**
 * ★ 2026-11-01：**她的手机**在那两区里本来有 28 秒在等"界面缓过来"。
 *
 * 真机要等（浏览器/相册冷启动、系统动画），但自检的假 adb 是**同步返回**的，
 * 断言验的是"屏上有没有那个词 / 画面变没变 / 她有没有按顺序做那几件事"，
 * 跟等多久无关。所以这三个数只在这里压成 0，生产默认值一个都没改
 * （`phone-agent.cjs` 的 `searchPollMs` / `settleMs`、`phone-life.cjs` 的 `PREOPEN_MS`）。
 */
/**
 * ★ 2026-11-01：**她说话的气泡节奏**（`pet.cjs` 的 `sayGapMs()` / `typeCps()`）。
 *
 * 产品里两个气泡之间至少隔 1.2 秒、页面 20 字/秒打字 —— 这是"像人"的关键，
 * 但 `05a/05b/05e/05f` 每等一个气泡就要白等 1.2~1.55 秒，四区加起来 16 秒。
 * 断言验的是"哪一桶台词 / 合并了几条 / 卡上的选项"，跟等多久无关。
 *
 * ⚠️ `05d-touch.cjs` 有一条"气泡间隔 1.1~3.2 秒"**验的就是这个节奏**，
 * 所以它在自己那一段前后临时摘掉这两个变量、按默认值跑（见那个文件里的 `savedGap`）。
 * 改这里之前先看那一段。
 */
process.env.DSP_SAY_GAP_MS = '150';
process.env.DSP_TYPE_CPS = '200';

/**
 * ★ 2026-11-01：**别让"选择卡"在别的区域里提前问出来**（`pet.cjs` 的 `askAfterPets()`）。
 *
 * `05e`（部位）会连着蹭十几次，攒够 3 分就会举一张卡；卡一举着，`case 'touch'`
 * 就在 `if (state.card) break` 那里一句都不说了 —— 于是后面几条"这个部位说哪桶话"
 * 的断言全等不到气泡，`05f` 再摸也问不出新卡（实测全量跑就是这么红的）。
 * 所以默认把这个阈值调到摸不出来，**只有 `05f-ask.cjs` 自己按默认值 3 跑**
 * （它在自己那一段前后摘掉这个变量，见文件里的 `savedAsk`）。
 */
process.env.DSP_ASK_AFTER_PETS = '999';

process.env.DSP_PHONE_SEARCH_POLL_MS = '0';
process.env.DSP_PHONE_SETTLE_MS = '0';
process.env.DSP_PHONE_PREOPEN_MS = '0';

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
  /**
   * ★ 2026-11-03：`flaky-model` 前 5 次回 503，第 6 次才说话。
   * 用来验"模型抖一下时，QQ 那条会自动补发这一句"（第一轮 4 次全挂 → 补发 → 接上）。
   */
  let flakyLeft = 5;
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
      /**
       * ★ 2026-11-01：`at` 是**收到这一笔的时刻**。有些断言验的是"先后顺序"
       * （比如"调模型之前就点了正在输入"），只比数组下标不够（两个端点不在一个数组里）。
       */
      seen.push({ url: req.url, headers: req.headers, body, at: Date.now() });
      const fail = body?.model === 'fail-me';
      const slow = body?.model === 'slow-model' && slowOnce;
      const flaky = body?.model === 'flaky-model' && flakyLeft > 0;
      if (flaky) flakyLeft -= 1;
      if (slow) slowOnce = false;
      const answer = () => {
        if (flaky) {
          res.writeHead(503, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Service is too busy. We advise users to temporarily switch LLM.' } }));
          return;
        }
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
    const state = { passed: 0, ran: [] };
    const ok = (name, cond) => {
      if (!cond) throw new Error(`FAIL ${name}`);
      state.passed += 1;
      console.log(`  ok  ${name}${process.env.DSP_SMOKE_REGION ? `\t[${current}]` : ''}`);
    };
    /** 假模型端点**谁来用谁来起**（用不到的区域不该平白多一个 http server）。 */
    let stub = null;
    let current = '(启动)';
    const ensureStub = async () => (stub || (stub = await stubModel()));
    /**
     * 每个区域的**超时兜底**（`DSP_SMOKE_TIMEOUT_MS` 可调，默认 6 分钟）。
     *
     * 为什么要有：有些区域在等真实的计时器（气泡间隔、静默期、模型往返），机器一忙就会拖；
     * 而"某个区域卡住"跟"自检很慢"在命令行上看起来一模一样。超时**不算失败**（它自己会报
     * 哪个区域超时了），但也别让整个自检无限挂着不走。
     */
    const REGION_TIMEOUT_MS = Number(process.env.DSP_SMOKE_TIMEOUT_MS || 6 * 60 * 1000);
    const ctx = {
      app, root, CONFIG_DIR, ok, state, base, port, fs, path, http, pathToFileURL,
      checkLines, pageAreas, pageStages, pageGrabParts, textsOf, textsFilled, ACTIONS, FILES,
      /**
       * `__mark('…')` 是**拆分那一棒自己加的**埋点（用来量各节耗时），不是原文自带的东西 ——
       * 存档 `smoke.full.cjs` 里一个都没有。现在耗时由骨架**按区域**打（`DSP_SMOKE_TIME=1`），
       * 所以这里留个空实现：`02g5` 里还留着几个 `__mark`，不实现它会报 `__mark is not defined`。
       */
      __mark: () => {},
      /** 页面 WebSocket 客户端（区域 5 用真连接跑往返）。 */
      WebSocket: require(path.join(app, 'node_modules', 'ws')).WebSocket,
      /** 假模型端点：`const stub = await ctx.ensureStub()`。 */
      ensureStub,
      mod,
      /**
       * 「真连一遍」那 7 个区域共用的一条连接 + 全套 helper（见 `lib\live.cjs`）。
       * 区域文件第一行写 `await ctx.live.ensure();` 就拿到了（`ws` / `fromPet` / `init` /
       * `waitFor` / `nextReply` / `drain` / `touchSay` … 都由它挂成全局）。
       */
      live: {
        ensure: () => live.ensure(ctx),
        close: live.close,
        get state() { return live.state; },
      },
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
      live.install(ctx);
      for (const r of chosen) {
        current = r.name;
        const t0 = Date.now();
        await withTimeout(r.run(ctx), REGION_TIMEOUT_MS, r.name);
        state.ran.push(r.name);
        if (process.env.DSP_SMOKE_TIME) {
          console.log(`  [耗时] ${r.name} ${((Date.now() - t0) / 1000).toFixed(1)}s`);
        }
      }
    } finally {
      live.close();
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

/**
 * 区域超时兜底（`run()` 里真的接上了，默认 6 分钟，`DSP_SMOKE_TIMEOUT_MS` 可调）：
 * 某些区域在等真实计时器，机器忙的时候会拖；而"卡住"和"慢"在命令行上看着一模一样。
 * 超时不是"失败"，但也别让整个自检无限挂着不走 —— 报出是哪个区域就够定位了。
 */
function withTimeout(p, ms, what) {
  let timer = null;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise((_, rej) => {
      timer = setTimeout(() => rej(new Error(`区域超时（${ms / 1000}s）：${what}`)), ms);
      timer.unref?.();
    }),
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
  app, root, CONFIG_DIR, mod, run, listRegions, selector, withTimeout,
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
