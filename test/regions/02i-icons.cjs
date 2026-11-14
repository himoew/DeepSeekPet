/**
 * 自检区域：图标与名字
 * 从原 `test\smoke.cjs` 切出来的，**代码一字未改**（只把裸模块名换成 `ctx.*`）。
 * 单跑：`node test\smoke.cjs icon`
 */
module.exports = {
  name: "图标与名字",
  tags: ['icon', '图标'],
  async run(ctx) {
    const { __mark, FILES, fs, path, pathToFileURL, http, pet, lines, llm, store, checkLines, pageAreas, pageStages, pageGrabParts,
      textsOf, textsFilled, base, port, WebSocket, ok } = ctx;
    /** 部位桶的三张对照表（原来定义在 2 那一块里）。 */
    const AREA_BUCKETS = {
      pokeArea: (A) => A.every((k) => lines.pokeArea[k]?.length),
      petArea: (A) => A.every((k) => lines.petArea[k]?.length),
      grabLike: (A) => ['grabArea', 'holdArea', 'dropArea'].every((b) => A.every((k) => lines[b]?.[k]?.length)),
    };
    /* ---------- 2i. 图标与名字（顺带盯住"补丁有没有落到位"） ---------- */
    
    for (const f of ['app-icon.png', 'tray-icon.png', 'avatar.png', 'icon-source.png']) {
      ok(`图标文件在（web\\${f}）`, ctx.fs.existsSync(path.join(ctx.app, 'web', f)));
    }
    const pkg = JSON.parse(fs.readFileSync(path.join(ctx.app, 'package.json'), 'utf8'));
    ok('产品名是 Blue Fish Deskpet', pkg.productName === 'Blue Fish Deskpet' && pkg.name === 'blue-fish-deskpet');
    // main.cjs 靠这个字面量认出"哪个窗口是设置窗"，跟 settings.cjs 里的标题必须**一字不差**，
    // 否则重复启动时会把设置窗当成桌宠叫出来（或者找不到窗口）。
    const mainSrc = fs.readFileSync(path.join(ctx.app, 'main.cjs'), 'utf8');
    const setSrc = fs.readFileSync(path.join(ctx.app, 'settings.cjs'), 'utf8');
    const setTitle = (setSrc.match(/title: '([^']*· 设置)'/) || [])[1] || '';
    ok('找桌宠窗口用的标题跟设置窗标题一致', setTitle !== '' && mainSrc.includes(`!== '${setTitle}'`));
    // 上游文件上的六处改动是 extract-pet.ps1 抽资源时由 tools\patch-assets.mjs 套上的，
    // 这里逐条确认它们**现在真的在**。同时这也盯住 patch-assets.mjs 的 marker：
    // marker 必须真的出现在对应文件里，否则那个文件永远不会被"跳过"、重跑时会直接报错。
    const PATCH_FILES = { appJs: 'web/pet-app.js', hostCjs: 'pet-host.cjs', figureJs: 'web/whale/figure.js', petHtml: 'web/pet.html' };
    const patcher = fs.readFileSync(path.join(ctx.root, 'tools', 'patch-assets.mjs'), 'utf8');
    // marker 有单引号写的也有双引号写的（里面带 ' 的只能用双引号），两种都要认
    const edits = [...patcher.matchAll(/edit\((\w+),\s*'[^']*',\s*\[[\s\S]*?\],\s*(?:'([^']*)'|"([^"]*)")\)/g)]
      .map((m) => [m[1], m[2] ?? m[3]]);
    const markerBad = edits.filter(([v, marker]) => {
      const rel = PATCH_FILES[v];
      return !rel || !fs.readFileSync(path.join(ctx.app, rel), 'utf8').includes(marker);
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
  },
};
