/**
 * 她手机上的 App 知识（P3，2026-11-06）
 *
 * 只写**这台机器上真有的** App（2026-11-06 实测的包名）：
 *   `mark.via`（Via 浏览器）· `com.android.gallery3d`（相册）· `app.lawnchair`（桌面）
 *   · `com.android.settings`（设置）· `com.lenovo.leos.appstore`（联想应用商店）
 *   · `tv.danmaku.bili`（哔哩哔哩）
 *
 * 每条只放三样东西：
 *   `can`  在这个 App 里她**能做什么**（一两句，像人话，不像 API）
 *   `tips` 这个 App 的**硬常识**（哪儿是搜索框、哪儿别点、卡了怎么退）
 *   `hintInWhere` 这件事是不是已经由 `whereAmI()` 说过了（说过了就别重复占 token）
 *
 * 菜单是**按这一屏推出来的**（有没有输入框、有没有底栏、是不是网格），不是写死的剧本 ——
 * 所以她换一个 App、换一个页面，仍然拿得到"我能在这儿干什么"。
 */

'use strict';

const APPS = {
  'mark.via': {
    name: '浏览器',
    kind: 'browser',
    can: ['搜东西', '读这一页', '打开第几条', '往下翻', '点开一条', '挑图存图', '返回'],
    tips: [
      '最上面那条是地址/搜索栏：tap 它 → text 关键词 → key enter',
      /**
       * ★ 2026-11-08（用户：「每一 条对应一个网址，网址的内容就是看到的网页」）：
       * 结果页**不是一个网站**，是列表；每一条 = 一个网址；点标题才进那个网站。
       * `open N` 就是"打开第 N 条"，`taptext 网页` 只是切搜索类型。
       */
      '结果页先 read：每一条 = 一个网址（域名那行），标题下面几行是搜索站的摘要，不是那网站的内容',
      '要进哪条网站就 open 1 / open 2（点的是那条的标题）；顶上那排「网页 / 图片 / 视频」只是切搜索类型，点了不会打开网站',
    ],
    hintInWhere: true,
  },
  'com.android.gallery3d': {
    name: '相册',
    kind: 'gallery',
    can: ['翻照片', '挑一张', '看大图', '截一张发给他'],
    tips: ['整页是自绘的：卡片可能不在控件树里，用 tapxy 按画面位置点', '想看更多就 scroll down 3'],
    hintInWhere: true,
  },
  'app.lawnchair': {
    name: '桌面',
    kind: 'launcher',
    can: ['打开某个 App'],
    tips: ['用 launch 写 App 名开它（浏览器 / 相册 / 设置），别在桌面上乱点'],
    hintInWhere: true,
  },
  'com.android.settings': {
    name: '设置',
    kind: 'settings',
    can: ['进下一级', '拨开关', '返回'],
    tips: ['开关就是那个带"开/关"的条目：tap 它，然后 read 看它变没变', '别在设置里乱改网络/账号，改亮度音量可以'],
    hintInWhere: false,
  },
  'com.lenovo.leos.appstore': {
    name: '应用商店',
    kind: 'store',
    can: ['搜 App', '看详情'],
    tips: ['**装东西要先请示**：看到"安装"别点，done 说清楚你想装什么', '搜到详情页就够了，别往下翻广告'],
    hintInWhere: false,
  },
  /**
   * ★ 2026-11-11：**她自己的本子**（用户：「不能强迫她写，只让她知道打开手机时她能去写」）。
   *
   * 这台机器上原本**一个能写字的地方都没有**（50 个包，0 个记事本；能编辑纯文本的 App 也是 0），
   * 所以这个 App 是专门给她做的：三屏、没有模板、不限字数、删了还能翻回来（`.trash/`）。
   * `can` 里只写"她能干什么"，**不写"今天该写了"** —— 那会变成任务。
   */
  'com.bluefish.diary': {
    name: '她的日记本',
    kind: 'diary',
    can: ['写一篇', '翻以前的', '读一篇', '删掉一篇'],
    tips: [
      '这个本子是你自己的：想写再写，不写也没人问；写得再短也算一篇',
      '顶上那行是"今天写没写"；想写就点右下角「写」，一天写多少篇都行',
      '写完点右上角「保存」，回到本子看一眼第一条是不是你刚写的',
      '要删就在看的那一篇右上角点「删除」，会再问你一次（删了 / 算了）',
    ],
    hintInWhere: true,
  },
  'tv.danmaku.bili': {    name: '哔哩哔哩',
    kind: 'video',
    can: ['搜视频', '看一会儿', '往下翻', '换一个', '返回'],
    tips: ['顶上那条是搜索框：tap → text 关键词 → key enter', '搜索结果的卡片带时长（像 3:35），点它就进视频'],
    hintInWhere: true,
  },
};

/**
 * 她手机上**真能去的几个地方**（2026-11-12 实测的包列表；这台机器就这些）。
 *
 * 为什么要有这张表：她"想去哪个 App"是开放的，但代码至少得知道
 * 中文名 ↔ 包名，才能替她先把 App 打开（0 调用、必成）。
 * 不在表里的名字也能试 —— `resolve()` 原样返回，`phone-adb.launch()` 认得包名。
 *
 * ★ 2026-11-12（P0）：**这里是"别名"的唯一数据源**。
 *
 * 以前三张表对不上：`APP_NAMES`（26 包/22 名）、`APP_LIST`（9 个）、`KNOWN_APPS`（19 个）。
 * 真机上他说的「B站」三张都没有 → `packagesFor()` 一个包都试不出来 → 「打不开「B站」」1 秒硬失败；
 * 「壁纸」「应用商店」也是同一类。现在 `phone-adb.packagesFor()` 直接查这里，
 * `APP_NAMES` 只留成兼容视图（老测试还在用它）。
 *
 * ⚠️ 新增一个 App **不是改程序**：往这张表加一行（label / pkg / can / aliases）就够了。
 */
const APP_LIST = [
  { label: '相册', pkg: 'com.android.gallery3d', can: '翻照片、挑一张、截一张', aliases: ['图库', '照片', '相簿'] },
  { label: '浏览器', pkg: 'mark.via', can: '搜东西、读一页、点开一条', aliases: ['Via', 'via', '网页'] },
  { label: '哔哩哔哩', pkg: 'tv.danmaku.bili', can: '搜视频、看一会儿、换一个', aliases: ['B站', 'b站', '小破站', '哔哩'] },
  { label: '她的日记本', pkg: 'com.bluefish.diary', can: '写一篇、翻以前的、删一篇', aliases: ['日记本', '日记', '本子'] },
  { label: '相机', pkg: 'com.android.camera2', can: '拍一张、看刚拍的', aliases: ['照相机'] },
  { label: '设置', pkg: 'com.android.settings', can: '调亮度、音量、壁纸', aliases: ['设定'] },
  { label: '文件', pkg: 'com.android.documentsui', can: '翻文件、看图片', aliases: ['文件管理器', '文档', '文件管理'] },
  /**
   * ★ 2026-11-12：**应用商店先试联想那个**。
   *
   * 机器的桌面图标写的就是「应用商店」= `com.lenovo.leos.appstore`；`com.android.vending`
   * 在老代码里是唯一候选，可 MuMu 上那个 Google 商店常常是个空壳（拉起成功、屏上是报错）。
   * `pre` 是"先试哪个"，后面的都算兜底。
   */
  { label: '应用商店', pkg: 'com.lenovo.leos.appstore', can: '搜 App、看详情（装不装她说了算）', aliases: ['商店', '应用市场', '应用中心'], pre: ['com.android.vending'] },
  { label: '壁纸', pkg: 'com.android.wallpaper', can: '换壁纸', aliases: ['壁纸与主题', '主题'] },
];

/**
 * ★ 2026-11-12：**找图标用的同义词**（是数据，不是程序）。
 *
 * 真机 Launcher（11-11 21:37 的 `_tmp/home2.xml`，`app.lawnchair`）上图标节点写的是
 * `应用商店 / 应用分身 / 哔哩哔哩 / 她的日记本 / 设置 / 图库 / 文件 / Via`，
 * 而他会说「相册」「浏览器」「B站」—— `surface.find('相册')` 在这台机器的桌面上**一个都找不到**。
 * 所以找图标时逐个试这些同义词；命中后把**屏幕上真实的那个字**记进 `apps.json`。
 */
const SCREEN_ALIASES = {
  相册: ['图库', '相册', '照片', '相簿'],
  图库: ['图库', '相册', '照片'],
  浏览器: ['Via', 'via', '浏览器', '网页', 'Chrome'],
  哔哩哔哩: ['哔哩哔哩', 'B站', 'b站', '小破站', '哔哩'],
  B站: ['哔哩哔哩', 'B站', '小破站', '哔哩'],
  日记本: ['她的日记本', '日记本', '日记', '本子'],
  她的日记本: ['她的日记本', '日记本', '日记', '本子'],
  文件: ['文件', '文件管理器', '文档'],
  文件管理器: ['文件', '文件管理器', '文档'],
  应用商店: ['应用商店', '商店', '应用市场', '应用中心'],
  设置: ['设置', '设定'],
  相机: ['相机', '照相机'],
  壁纸: ['壁纸', '壁纸与主题'],
};

/** 中文名 → 包名（认不出就原样返回：`launch` 也认包名）。 */
function resolve(name) {
  const k = String(name || '').trim();
  if (!k) return '';
  const hit = APP_LIST.find((a) => a.label === k) || APP_LIST.find((a) => a.label.includes(k) || k.includes(a.label));
  return hit ? hit.pkg : k;
}

/**
 * 名字 / 别名 → **要试的包列表**（按优先级）。
 *
 * 这是 `phone-adb.packagesFor()` 的数据源：同一件事只查一份表，
 * 所以不会再出现"`APP_LIST` 里有壁纸、`APP_NAMES` 里没有 → 打不开"。
 */
function packagesFor(spec) {
  const key = String(spec || '').trim();
  if (!key) return [];
  if (/^[a-z][\w.]*\.[\w.]+$/i.test(key)) return [key];
  const out = [];
  const push = (p) => { if (p && !out.includes(p)) out.push(p); };
  const at = (a) => {
    for (const p of (a.pre || [])) push(p);
    push(a.pkg);
  };
  const exact = APP_LIST.filter((a) => a.label === key);
  const alias = APP_LIST.filter((a) => (a.aliases || []).includes(key));
  const loose = APP_LIST.filter((a) => a.label.includes(key) || key.includes(a.label));
  for (const a of [...exact, ...alias, ...loose]) at(a);
  if (out.length) return out;
  /** 包名里的那一截（"Via" / "bili"）：当子串兜一次。 */
  const k = key.toLowerCase();
  for (const a of APP_LIST) if (a.pkg.toLowerCase().includes(k)) push(a.pkg);
  return out;
}

/**
 * 给计划层看的菜单（一行一个，带"在那儿能干什么"）。
 * @param {Array<{label?:string, pkg?:string}>} learned `apps.json` 学到的（只为"她自己想去"也能看见）
 */
function menu(learned = null) {
  const lines = APP_LIST.map((a) => `- ${a.label}：${a.can}`);
  const known = new Set(APP_LIST.map((a) => a.label));
  const extra = [];
  for (const it of (Array.isArray(learned) ? learned : [])) {
    const label = String((it && it.label) || '').trim();
    if (!label || known.has(label) || extra.length >= 6) continue;
    known.add(label);
    extra.push(`- ${label}：在这台手机上（自己找进去的）`);
  }
  return [...lines, ...extra].join('\n');
}

/** 按包名找 App 知识（认不全就是 null，别硬套）。 */
function lookup(pkg) {
  const p = String(pkg || '');
  if (!p) return null;
  if (APPS[p]) return { pkg: p, ...APPS[p] };
  const hit = Object.keys(APPS).find((k) => p.includes(k.split('.').pop()));
  return hit ? { pkg: hit, ...APPS[hit] } : null;
}

/** 这个 App 的硬常识（`whereAmI` 已经说过的就不再重复）。 */
function tipFor(pkg) {
  const app = lookup(pkg);
  if (!app || app.hintInWhere) return '';
  return app.tips && app.tips.length ? app.tips.join('；') : '';
}

/**
 * 这一屏能做什么（按 role/region 推，不写死剧本）。
 * 返回一行 `【这一屏能做什么】…`，推不出来就返回空串（别占 token）。
 */
function menuFor(obs, surface) {
  if (!surface || typeof surface.enrich !== 'function') return '';
  const nodes = surface.enrich((obs && obs.nodes) || [], obs && obs.screen);
  if (!nodes.length) return '';
  const app = lookup(obs && obs.app && obs.app.package);
  const hasInput = nodes.some((n) => n.role === 'input');
  const tabs = nodes.filter((n) => n.region === 'tabbar' && n.text);
  const rows = nodes.filter((n) => n.region === 'content' && n.text).length;
  const images = nodes.filter((n) => n.role === 'image').length;
  const switches = nodes.filter((n) => n.role === 'switch' || n.checkable).length;
  const thin = !!(obs && obs.thin);

  const can = [];
  if (hasInput) can.push('点它打字（tap → text → key enter）');
  if (rows >= 2) can.push('先 read 看清这一页有哪些内容');
  if (rows >= 1) can.push('点第几个（tap nN）');
  if (switches >= 1) can.push('拨开关（tap 那个条目，再 read 核对）');
  if (images >= 3 || (thin && rows <= 1)) can.push('这屏像图片/网格：scroll down 3 往下翻，要挑就 tapxy 点画面位置');
  if (tabs.length >= 2) can.push(`切页面：底部有 ${tabs.map((t) => t.text).join(' / ')}`);
  can.push('返回（key back）');
  if (!can.length) return '';

  const head = app ? `${app.name}：` : '';
  return `【这一屏能做什么】${head}${can.join(' · ')}`;
}

/**
 * 她在这个 App 里"最该先做的那一步"（给 `read` 之前用，挑一件就行）。
 * 不是命令，是建议；拿不到就返回空串。
 */
function firstMoveFor(obs, surface) {
  const menu = menuFor(obs, surface);
  if (!menu) return '';
  const m = /【这一屏能做什么】[^：]*：?([^·]+)/.exec(menu);
  return m ? m[1].trim() : '';
}

module.exports = {
  APPS, APP_LIST, SCREEN_ALIASES, resolve, packagesFor, menu, lookup, tipFor, menuFor, firstMoveFor,
};
