/**
 * 自检区域：她的手机·App 知识（P3，2026-11-06）
 *
 * 验的是"这一屏能做什么"这份菜单：按 role/region 推出来，不是写死的剧本；
 * 而且**只写这台机器上真有的 App**（认不出就不套）。
 *
 * 单跑：`node test\run-one.cjs 28-phone-apps.cjs`
 */
module.exports = {
  name: '她的手机·App 知识（这一屏能做什么）',
  tags: ['companion', 'phone', '手机', 'apps'],
  async run(ctx) {
    const { ok } = ctx;
    const fs = require('node:fs');
    const path = require('node:path');
    const os = require('node:os');
    const apps = ctx.mod('phone-apps');
    const surface = ctx.mod('phone-surface');
    const agentMod = ctx.mod('phone-agent');

    const N = (text, extra = {}) => ({
      ref: 'n0', text, desc: '', class: 'TextView', clickable: false, editable: false,
      scrollable: false, checkable: false, checked: false, enabled: true,
      bounds: [0, 400, 700, 460], center: [350, 430], pkg: 'x', ...extra,
    });
    const screen = { width: 720, height: 1280 };
    const obsWith = (nodes, extra = {}) => ({ app: { package: 'mark.via', name: '浏览器' }, screen, nodes, thin: false, ...extra });

    /* ---------- 1. 认 App（只认这台机器上真有的） ---------- */

    ok('认 App：Via', apps.lookup('mark.via')?.name === '浏览器');
    ok('认 App：相册', apps.lookup('com.android.gallery3d')?.name === '相册');
    ok('认 App：设置', apps.lookup('com.android.settings')?.name === '设置');
    ok('认 App：商店', apps.lookup('com.lenovo.leos.appstore')?.name === '应用商店');
    ok('认 App：不认识的返回 null（不硬套）', apps.lookup('com.unknown.thing') === null);

    /* ---------- 2. 硬常识：说过的不重复，没说的给一条 ---------- */

    ok('常识：浏览器已经由"你在哪"说过，不再重复', apps.tipFor('mark.via') === '');
    ok('常识：设置给一条（开关 + 别乱改）', /开关/.test(apps.tipFor('com.android.settings')));
    ok('常识：商店写死"装东西要先请示"', /先请示/.test(apps.tipFor('com.lenovo.leos.appstore')));

    /* ---------- 3. 菜单：按这一屏推 ---------- */

    const inputScreen = obsWith([N('搜索框', { class: 'EditText', editable: true })]);
    ok('菜单：有输入框 → 会告诉她能打字', /打字/.test(apps.menuFor(inputScreen, surface)));

    const listScreen = obsWith([
      N('第一条', { ref: 'n1' }), N('第二条', { ref: 'n2' }), N('第三条', { ref: 'n3' }),
    ]);
    ok('菜单：有列表 → 先 read 再点', /read/.test(apps.menuFor(listScreen, surface)));

    const tabScreen = obsWith([
      N('首页', { ref: 'n1', clickable: true, bounds: [0, 1180, 180, 1280] }),
      N('动态', { ref: 'n2', clickable: true, bounds: [180, 1180, 360, 1280] }),
      N('我的', { ref: 'n3', clickable: true, bounds: [360, 1180, 540, 1280] }),
    ]);
    ok('菜单：有底栏 → 说得出切页面', /切页面/.test(apps.menuFor(tabScreen, surface)) && /首页/.test(apps.menuFor(tabScreen, surface)));

    const gridScreen = obsWith([N('', { class: 'ImageView' }), N('', { class: 'ImageView' }), N('', { class: 'ImageView' })], { thin: true });
    const gridMenu = apps.menuFor(gridScreen, surface);
    ok('菜单：像网格 → 告诉她往下翻 / 按位置点', /网格/.test(gridMenu) && /scroll/.test(gridMenu));

    const switchScreen = obsWith([N('蓝牙', { class: 'Switch', checkable: true, checked: false })]);
    ok('菜单：有开关 → 告诉她拨一下再核对', /开关/.test(apps.menuFor(switchScreen, surface)));

    ok('菜单：空屏不占 token', apps.menuFor({ app: {}, nodes: [] }, surface) === '');

    /* ---------- 4. 接线：菜单真的进了 prompt ---------- */

    const phone = {
      async state() { return { online: true, booted: true, screen, app: { package: 'com.android.settings', name: '设置' } }; },
      async observe() {
        return {
          ok: true, app: { name: '设置', package: 'com.android.settings' }, screen,
          nodes: [N('蓝牙', { ref: 'n0', class: 'Switch', checkable: true })],
          table: 'n0 蓝牙', hash: 'h-set', count: 1, more: 0, thin: false,
        };
      },
      async tap() { return { ok: true, changed: true }; },
      async tapXY() { return { ok: true }; },
      async swipeDir() { return { ok: true, changed: true }; },
      async text() { return { ok: true }; },
      async key() { return { ok: true }; },
      async openUrl() { return { ok: true }; },
      async launch() { return { ok: true }; },
      async waitChange() { return { changed: false }; },
      async focusApp() { return 'com.android.settings'; },
      async screenshot() { return { ok: false }; },
    };
    const calls = [];
    const agent = new agentMod.PhoneAgent({
      adb: phone,
      model: { model: 'stub', baseUrl: 'http://127.0.0.1:1', maxTokens: 80, timeoutMs: 5000 },
      callModel: async (m, messages) => {
        calls.push(messages);
        return { text: calls.length === 1 ? 'read' : 'done 看过了' };
      },
      dir: fs.mkdtempSync(path.join(os.tmpdir(), 'dsp-apps-')),
      rescue: { enabled: false },
      web: null,
    });
    await new Promise((resolve) => {
      const orig = agent.emit;
      agent.emit = (ev) => { orig(ev); if (ev.kind === 'done' || ev.kind === 'fail') resolve(ev); };
      agent.enqueue({ goal: '看看设置里有什么', by: 'her', key: 'private:1' });
    });
    const prompt = JSON.stringify(calls[0] || []);
    ok('接线：prompt 里有「这一屏能做什么」', prompt.includes('这一屏能做什么'));
    ok('接线：prompt 里有设置那条常识（开关）', prompt.includes('开关'));

    /* ---------- 5. 别名只有一份数据源（★ 2026-11-12） ---------- */

    /**
     * 以前三张表对不上：`APP_NAMES`（26 包/22 名）· `APP_LIST`（9 个）· `KNOWN_APPS`（19 个）。
     * 真机上他说的「B站」三张都没有 → `packagesFor('B站')` 空 → 「打不开「B站」」1 秒硬失败。
     */
    const adbMod = ctx.mod('phone-adb');
    ok('别名：B站/小破站 → 哔哩哔哩那个包', apps.packagesFor('B站')[0] === 'tv.danmaku.bili'
      && apps.packagesFor('小破站')[0] === 'tv.danmaku.bili');
    ok('别名：壁纸（旧 APP_NAMES 里根本没有这个包）', apps.packagesFor('壁纸')[0] === 'com.android.wallpaper');
    ok('别名：文件管理器 → documentsui', apps.packagesFor('文件管理器')[0] === 'com.android.documentsui');
    ok('别名：应用商店两个都试（联想那个排前面）',
      apps.packagesFor('应用商店').includes('com.lenovo.leos.appstore')
      && apps.packagesFor('应用商店').includes('com.android.vending'));
    ok('别名：`phone-adb.packagesFor` 查的是同一份表（不再各写一套）',
      JSON.stringify(adbMod.packagesFor('B站')) === JSON.stringify(apps.packagesFor('B站')));
    ok('别名：认不出的名字仍然返回空（上层会去看屏幕，不再报"不认识"）',
      apps.packagesFor('菜谱').length === 0);
    ok('同义词：相册 ↔ 图库 / 浏览器 ↔ Via / B站 ↔ 哔哩哔哩',
      apps.SCREEN_ALIASES['相册'].includes('图库')
      && apps.SCREEN_ALIASES['浏览器'].includes('Via')
      && apps.SCREEN_ALIASES['B站'].includes('哔哩哔哩'));

    /* ---------- 6. 菜单：学过的 App 也要进她自己的菜单（★ 2026-11-12） ---------- */

    ok('菜单：学过的「菜谱」进得来（学习不只帮"他叫她开"）',
      /菜谱/.test(apps.menu([{ label: '菜谱', pkg: 'com.bluefish.cook' }])));
    ok('菜单：表里已有的不重复列', apps.menu([{ label: '相册', pkg: 'com.android.gallery3d' }])
      === apps.menu());
    ok('菜单：不传也照旧（老调用点不用改）', apps.menu().includes('- 相册：'));
  },
};
