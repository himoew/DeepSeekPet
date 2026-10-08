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

/** 台词库：每一项都要有非空 text，动作名都要认识。 */
function checkLines(node, trail, problems, count) {
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
  for (const [k, v] of Object.entries(node)) checkLines(v, `${trail}.${k}`, problems, count);
}

/**
 * 页面里那张部位判定表（pet-app.js 的 `REGION_AT`）用到的部位名。
 * 拿来和台词桶对一下：**页面改了名字、台词没跟上**的话，World 会静默退回通用台词，
 * 这种错从日志里看不出来（它照常说，只是不说那个部位的），所以在这里挡一道。
 */
function pageAreas() {
  const src = fs.readFileSync(path.join(app, 'web', 'pet-app.js'), 'utf8');
  const from = src.indexOf('const REGION_AT');
  const block = src.slice(from, src.indexOf('function petRegion', from));
  return [...new Set([...block.matchAll(/'([a-z]+)'/g)].map((m) => m[1]))].sort();
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
  return [...new Set([...block.matchAll(/^  ([a-z]+):/gm)].map((m) => m[1]))].sort();
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
    ok('配色只剩 deepseek 一套', model.schemes.length === 1 && model.schemes[0].id === 'deepseek');
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
    ok('心情：动作倍率在 0.5~1.4 之间（不会变成慢动作或者抽搐）',
      mood.snapshot().speed >= 0.5 && mood.snapshot().speed <= 1.4);
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

    /* ---------- 2d. 图标与名字（顺带盯住"补丁有没有落到位"） ---------- */
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

    // 部位：台词桶的名字必须和页面那张判定表（pet-app.js 的 REGION_AT）完全一致，
    // 否则台上报了 head、台词却没这一桶，就静默退回通用台词——那是很难发现的一类错。
    const AREA_KEYS = ['head', 'body', 'hand', 'fin', 'tail', 'low', 'foot'];
    ok('戳的部位台词七个部位都齐', AREA_KEYS.every((k) => lines.pokeArea[k]?.length));
    ok('蹭的部位台词七个部位都齐', AREA_KEYS.every((k) => lines.petArea[k]?.length));
    ok('拎起来 / 拎久了 / 放下 三桶都齐七个部位',
      ['grabArea', 'holdArea', 'dropArea'].every((b) => AREA_KEYS.every((k) => lines[b]?.[k]?.length)));
    ok('页面判定表里的部位名和台词桶一致', JSON.stringify(pageAreas()) === JSON.stringify([...AREA_KEYS].sort()));
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
    ok('第一次慢的话会再测一次，并分开报冷/热', slow.ok === true && /第一次.*第二次/s.test(slow.message));

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
    ok('init 只给这一版能兑现的悬停按钮', init.hoverButtons.every((b) => ['chat', 'auto', 'roam', 'theme', 'sound', 'hide'].includes(b)));
    // 悬停和右键菜单原来摆的是同一批动作，重复；现在悬停只留「对话」，其余全在菜单里。
    ok('悬停只留一个「对话」按钮（其余动作收进右键菜单）', init.hoverButtons.length === 1 && init.hoverButtons[0] === 'chat');
    ok('init 带上了右键菜单（controls + 设置按钮）', init.bot?.controls === true && init.bot.buttons.settings === true);
    ok('右键菜单去掉了没实现的装扮', init.bot.buttons.dress === false);

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

    /* ---------- 4c. 念出来：只有大模型的回答会出声 ---------- */
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
    // 部位是**页面**判的（pet-app.js 的 REGION_AT，按 whale\model.json 的 pivots 就近算），
    // 跟着 touch 一起报上来；World 只认名字。所以这里直接按页面的口吻发 `at`。
    await drain();
    const headPoke = await touchOwnSay('poke', { at: 'head' });
    ok('戳头说的是「头」那一桶', textsOf(lines.pokeArea.head).includes(headPoke.beats[0].text));
    const bodyPoke = await touchOwnSay('poke', { at: 'body' });
    ok('换到肚子戳就换一桶话', textsOf(lines.pokeArea.body).includes(bodyPoke.beats[0].text));
    const headAgain = await touchOwnSay('poke', { at: 'head' });
    ok('再戳回头部还算"新的一下"（不是「又戳」）', textsOf(lines.pokeArea.head).includes(headAgain.beats[0].text));
    const tailPet = await touchOwnSay('pet', { at: 'tail' });
    ok('蹭尾巴说的是「尾巴」那一桶', textsOf(lines.petArea.tail).includes(tailPet.beats[0].text));
    const plainPet = await touchOwnSay('pet');
    ok('页面没报部位时退回通用的「蹭」', textsOf(lines.pet).includes(plainPet.beats[0].text));

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
  fs.rmSync(CONFIG_DIR, { recursive: true, force: true });
  process.exit(1);
});
