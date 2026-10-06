/**
 * 从 Coopanion 抽出来的资源需要动六处，由 tools\extract-pet.ps1 调用：
 *
 *   node tools\patch-assets.mjs <pet-app.js> <model.json> <pet-host.cjs> <figure.js> <pet.html>
 *
 * 写成独立文件而不是 PowerShell 里的 `node -e "..."`：内联脚本要穿过
 * PowerShell 的原生命令行引号处理，那个过程会把双引号弄坏（实测会报
 * `SyntaxError: Unexpected token 'const'`）。文件没有这个问题。
 *
 * 这里是我们对上游 JavaScript/HTML 改动的**唯一出处**。除此之外 pet-app.js / pet-core.js /
 * rig.js 都跟 Coopanion 一模一样——**注意**：pet-app.js 和 pet-core.js 后来还各多了几处改动
 * （语音并行播放、部位判定、抚摸状态机、按部位拖拽、目光跟随…），**那些还没搬进来**，
 * 见交接文档第 4 节。这份脚本现在只管下面这六处。
 *
 * ★ **想再加一处改动时的规矩**：**给新改动单独一次 `edit()` 调用、用自己的 marker**。
 *   `edit()` 是按 marker **整个文件**跳过的：如果把新的 pair 塞进已有那次调用里，
 *   那么"已经补过前面那几处"的文件会整段跳过，**新改动会静默丢失**。
 *   单独一次调用（不同 marker）就没这个问题：上游文件两处都会补，补过的会各自跳过。
 */
import fs from 'node:fs';

const [, , appJs, modelJson, hostCjs, figureJs, petHtml] = process.argv;
if (!appJs || !modelJson || !hostCjs || !figureJs || !petHtml) {
  console.error('用法: node tools\\patch-assets.mjs <pet-app.js> <model.json> <pet-host.cjs> <figure.js> <pet.html>');
  process.exit(2);
}

/** 每处改动：先在文件里找 `from`，找不到就说明上游变了，整体报错退出。 */
function edit(file, label, pairs, marker) {
  let src = fs.readFileSync(file, 'utf8');
  if (src.includes(marker)) {
    console.log(`  ${label} 已经改过，跳过`);
    return;
  }
  const before = src;
  for (const [from, to] of pairs) src = src.replace(from, to);
  if (src === before) {
    console.error(`  ${label} 跟上游对不上，没改动（上游可能改过这段）`);
    process.exit(1);
  }
  fs.writeFileSync(file, src);
}

/* ---------- 1. pet-app.js：指针诊断日志改成默认关 ---------- */
// 上游每秒往运行日志写一行 `[pointer] {...}`，而且没有开关；真报错会被埋掉。
// 排查点击穿透时它很有用，所以是收起来而不是删掉：页面地址加 ?diag=1 就回来。
edit(appJs, 'pet-app.js', [
  ['const diag = { move: null,',
    "const POINTER_DIAG = new URLSearchParams(location.search).has('diag');\nconst diag = { move: null,"],
  ['function logPointer(event, by) {\n  const now =',
    'function logPointer(event, by) {\n  if (!POINTER_DIAG) return;\n  const now ='],
], 'POINTER_DIAG');
console.log('  pet-app.js：指针诊断日志改成默认关闭，?diag=1 打开');

/* ---------- 2. model.json：只留 deepseek 配色 ---------- */
// figure.js 用 `schemes` 列表里的第一项作为"原版"，贴图从 tex\ 和 feat\ 根目录取；
// 其余配色在 schemes\<id>\ 下，不复制，所以这里也要把它们从列表里去掉。
{
  const model = JSON.parse(fs.readFileSync(modelJson, 'utf8'));
  const schemes = (model.schemes || []).map((s) => s.id);
  model.schemes = (model.schemes || []).filter((s) => s.id === 'deepseek');
  if (!model.schemes.length) {
    console.error('  model.json 里没有 deepseek 配色');
    process.exit(1);
  }
  fs.writeFileSync(modelJson, `${JSON.stringify(model, null, 2)}\n`);
  console.log(`  model.json 配色：${schemes.join(',')} -> ${model.schemes.map((s) => s.id).join(',')}`);
}

/* ---------- 3. pet-host.cjs：托盘菜单 ---------- */
// 上游的「装扮…」打开 /dress，而这一版没有装扮页，点了是 404 —— 换成两个真能用的：
// 设置窗口和日志文件。改动仅限托盘菜单和 runPetHost 的收参，窗口宿主本身没动。
edit(hostCjs, 'pet-host.cjs', [
  ['function runPetHost({ url, parentPid = 0, tray: withTray = true }) {',
    'function runPetHost({ url, parentPid = 0, tray: withTray = true, openSettings = null, openLog = null }) {'],
  ["      { label: '装扮…', click: () => openDress() },\n",
    "      { label: '设置…', click: () => { if (openSettings) openSettings(); } },\n" +
    "      { label: '打开日志', click: () => { if (openLog) openLog(); } },\n"],
], "label: '设置…'");
console.log('  pet-host.cjs：托盘「装扮…」（点了 404）换成「设置…」和「打开日志」');

/* ---------- 4. figure.js：让呆毛和"耳朵"（脑侧那两片鳍）动起来 ---------- */
// 上游这两个部件的"活"只有一个很小的固定正弦（呆毛 ±2°、鳍 ±1.5°），在 113px 高的它身上
// 不到 1 个像素，看着就是死的。尾巴之所以活，是因为它多了一项"由情绪决定幅度和频率的振荡器"
// （`wagAmp * 13 * Math.sin(t * (4 + 5 * wagAmp))`）。这里把尾巴那一套抄给它们三个动作：
//   ① 情绪扇动：幅度跟脸的情绪走（跟尾巴共用 wagAmp / finMood）；
//   ② 看得见的闲置呼吸：呆毛 ±5°、两片鳍 ±4.5°/±4°（**原来那点幅度就是"看不见"的根源**）；
//   ③ 每约 10 秒抖一下"耳朵"（窄脉冲，直接加在弹簧外面才够脆）。
// 幅度全是手感：1° ≈ 它身上 0.3 像素，觉得太闹/太静就改这里的数字。
edit(figureJs, 'figure.js', [
  ['    const fins = sp.fins.step(finMood * 14 + sway * 10 + (face === \'angry\' ? 3 * Math.sin(t * 40) : 0), dt);',
   '    // 呆毛与鳍的"活着"：见 tools\\patch-assets.mjs 第 4 处（幅度都是手感，改数字即可）\n' +
   '    const finTwitch = Math.pow(Math.max(0, Math.sin(t * .6 + 1)), 16) * 7;   // 每约 10 秒抖一下"耳朵"\n' +
   '    const fins = sp.fins.step(finMood * 14 + sway * 10 + finMood * 3.5 * Math.sin(t * (3 + 4 * Math.abs(finMood))) + (face === \'angry\' ? 6 * Math.sin(t * 40) : 0), dt)\n' +
   '      + finTwitch;'],
  ['    const ahoge = sp.ahoge.step(-tiltVel * .12 + sway * 18 + (face === \'surprised\' ? -16 : 0) + (mode === \'sleep\' ? 22 : 0) - hairY * 12, dt);',
   '    const ahoge = sp.ahoge.step(-tiltVel * .12 + sway * 18 + (face === \'surprised\' ? -16 : 0) + (mode === \'sleep\' ? 22 : 0) - hairY * 12, dt)\n' +
   '      + wagAmp * 8 * Math.sin(t * (2.6 + 3 * wagAmp))    // 情绪摆：开心/被爱时晃得最欢（跟尾巴共用 wagAmp）\n' +
   '      + Math.sin(t * 1.5) * 5;                           // 闲置呼吸（原来 ±2°，等于没动）'],
  ['    st.ahoge = { a: ahoge * .5 + Math.sin(t * 2.1) * 2 };\n' +
   '    st.finNear = { a: fins + Math.sin(t * 1.4) * 1.5 };\n' +
   '    st.finFar = { a: -fins * .8 - Math.sin(t * 1.4) * 1.2 };',
   '    st.ahoge = { a: ahoge * .5 };\n' +
   '    st.finNear = { a: fins + Math.sin(t * 1.7) * 4.5 };\n' +
   '    st.finFar = { a: -fins * .8 - Math.sin(t * 1.9 + 1.1) * 4 };   // 两片不同频，看着才不像一个整体'],
], '呆毛与鳍的"活着"');
console.log('  figure.js：呆毛和「耳朵」加了情绪振荡器 + 看得见的闲置幅度');

/* ---------- 5. pet-host.cjs：窗口/托盘图标换成大肥鱼 + 应用名 ---------- */
// 上游的窗口和托盘图标都是 Cortico 的品牌（托盘那个甚至是代码画的 C 字），标题叫「Cortico 桌宠」。
// 这里换成我们自己的：窗口图标 web\app-icon.png、托盘 web\tray-icon.png（文件不在时那段手绘
// 图标仍然会兜底，所以不是删掉而是"优先用我们的"），标题/托盘提示改成 Blue Fish Deskpet。
edit(hostCjs, 'pet-host.cjs（图标与名字）', [
  ["    backgroundColor: '#00000000', title: 'Cortico 桌宠',",
    "    backgroundColor: '#00000000', title: 'Blue Fish Deskpet',\n" +
    "    icon: join(__dirname, 'web', 'app-icon.png'),"],
  ["  tray.setToolTip('Cortico 桌宠');",
    "  tray.setToolTip('Blue Fish Deskpet');"],
  ['function trayIcon() {\n  const mac = process.platform === \'darwin\';',
    'function trayIcon() {\n' +
    '  const ours = nativeImage.createFromPath(join(__dirname, \'web\', \'tray-icon.png\'));\n' +
    '  if (!ours.isEmpty()) return ours;\n' +
    '  const mac = process.platform === \'darwin\';'],
], "'tray-icon.png'");
console.log('  pet-host.cjs：窗口图标 / 托盘图标换成大肥鱼，应用名改成 Blue Fish Deskpet');

/* ---------- 6. pet.html：页面标题（任务栏上就显示这个） ---------- */
edit(petHtml, 'pet.html', [
  ['<title>Cortico 桌宠</title>', '<title>Blue Fish Deskpet</title>'],
], '<title>Blue Fish Deskpet</title>');
console.log('  pet.html：标题改成 Blue Fish Deskpet');
