#!/usr/bin/env node
/**
 * 手动摸手机的命令行（P0 调试用）。她把手机用起来之前，先用这个确认通道通。
 *
 *   node tools/phone.cjs status                 # 连没连上、开的什么 App
 *   node tools/phone.cjs obs                    # 看一眼：动作表（给模型看的就是这个）
 *   node tools/phone.cjs obs --shot --json      # 连截图一起，输出 JSON
 *   node tools/phone.cjs tap n3                 # 按语义点，默认验证界面变没变
 *   node tools/phone.cjs tap 360 640            # 坐标兜底
 *   node tools/phone.cjs swipe up               # up/down/left/right
 *   node tools/phone.cjs text "晚上好"           # 中文走 MuMuManager
 *   node tools/phone.cjs key back
 *   node tools/phone.cjs launch 设置
 *   node tools/phone.cjs shot --out out.png
 *   node tools/phone.cjs probe                  # 全链路自检（连、看、点、截）
 *
 * 环境变量：DSP_MUMU_HOME / DSP_MUMU_SERIAL / DSP_MUMU_ADB（一般不用设，会自动找）
 *
 * ★ 2026-10-30 新增：doctor（认路径）/ up（拉起模拟器）/ show（露窗口摆竖屏）。
 * 用户重装绿色版 MuMu 之后，路径从 `shell\` 变成 `nx_main\`，第 3 挡就是在这里静默失败的。
 */
const fs = require('node:fs');
const path = require('node:path');
const { PhoneAdb } = require('../resources/app/phone-adb.cjs');

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { out[key] = next; i++; } else out[key] = true;
    } else out._.push(a);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0] || 'status';
const phone = new PhoneAdb({
  home: args.home || undefined,
  serial: args.serial || undefined,
  maxNodes: args.max ? Number(args.max) : undefined,
});

const json = !!args.json;
const say = (x) => (json ? console.log(JSON.stringify(x, null, 2)) : console.log(x));

async function status() {
  const st = await phone.state();
  if (json) return say(st);
  if (!st.online) return say(`连不上 ${st.serial || '（没定下来）'}。模拟器开了吗？node tools\\phone.cjs doctor 看路径`);
  say(`在线 ${st.serial} · Android ${st.booted ? '启动完' : '还在启动'} · ${st.screen.width}x${st.screen.height}@${st.screen.density}dpi · 当前 ${st.app.name || '?'}${st.app.package ? `（${st.app.package}）` : ''}`);
}

/**
 * ★ 2026-10-30：自检"这台机器上到底认不认得出 MuMu"。
 * 用户重装绿色版之后路径变了（`shell\` → `nx_main\`），第 3 挡就是在这里静默失败的。
 */
async function doctor() {
  const d = await phone.doctor();
  if (json) return say(d);
  const p = d.paths;
  say([
    `安装目录: ${p.home || '（没找到）'}${p.found ? '' : '  ← 填 config\\companion.json 的 phone.home，或设 DSP_MUMU_HOME'}`,
    `版本    : ${p.version || '?'}${p.series ? `（series ${p.series}）` : ''}      扫了 ${p.scanned} 个候选路径`,
    `adb     : ${p.adb || '（没有）'}${d.adbVersion ? ` · ${d.adbVersion}` : ''}`,
    `manager : ${p.manager || '（没有）'}`,
    `player  : ${p.player || '（没有）'}`,
    `device  : ${p.device || '（没有）'}`,
    `serial  : ${p.serial || '（还没有）'}`,
    `运行    : ${d.running?.running ? '在跑' : '没在跑'}${d.running?.stale ? '（状态是陈旧的，会照样去启动）' : ''}` +
      `${d.running?.port ? ` · 端口 ${d.running.port}` : ''}${d.running?.pid ? ` · pid ${d.running.pid}` : ''}`,
    `设备    : ${d.online ? `在线${d.booted ? ' · 已启动' : ' · 还在启动'}` : '连不上'}`,
    d.screen ? `屏幕    : ${d.screen.width}x${d.screen.height}@${d.screen.density || '?'}dpi` : '',
    d.app ? `当前    : ${d.app.name || '?'}（${d.app.package || '?'}）` : '',
  ].filter(Boolean).join('\n'));
  if (d.notes.length) say(`\n注意：\n  - ${d.notes.join('\n  - ')}`);
  return d;
}

/** 拉起模拟器 + 等 Android 起来（页面上"开机中"那几十秒干的就是这件事）。 */
async function up() {
  const t0 = Date.now();
  const r = await phone.launchPlayer({ onTick: (t) => say(`  · 启动：${t.via || t.stage || ''}`) });
  if (!r.ok) return say(`✗ ${r.msg}\n  试过：${(r.tried || []).map((x) => `${x.via}${x.ok ? '' : `(${x.msg})`}`).join(' / ') || '无'}`);
  say(`  · 进程/端口就绪（${r.via}）`);
  const boot = await phone.waitBoot({
    timeoutMs: 180000,
    onTick: (t) => { if (t.n % 4 === 1) say(`  · 等 Android… ${Math.round(t.ms / 1000)}s`); },
  });
  if (!boot.ok) return say(`✗ Android 没起来：${boot.error}`);
  say(`✓ 起来了（总共 ${Math.round((Date.now() - t0) / 1000)}s）`);
}

/** 露窗口并摆成竖屏（页面第 3 挡做的事）；--dpr 传显示缩放，默认 1。 */
async function show() {
  const box = {
    x: Number(args.x) || 700, y: Number(args.y) || 40,
    width: Number(args.w) || 420, height: Number(args.h) || 720,
  };
  const shown = await phone.showWindow();
  if (!shown.ok) return say(`✗ 露不出来：${shown.msg || '?'}`);
  const fit = await phone.fitWindow(box, { dpr: Number(args.dpr) || 1 });
  say(`✓ 窗口 ${fit.box ? `${fit.box.width}x${fit.box.height}@${fit.box.x},${fit.box.y}` : '（读不到矩形）'}`
    + `${fit.ok ? '（尺寸对上了）' : '（MuMu 没完全接受尺寸）'}`);
}

async function obs() {
  const o = await phone.observe({ shot: !!args.shot });
  if (json) {
    const copy = { ...o };
    if (copy.shot && copy.shot.png) copy.shot = { ...copy.shot, png: `<${copy.shot.bytes} bytes>` };
    return say(copy);
  }
  if (!o.ok) return say(`看不了：${o.error}`);
  say(`${o.app.name || '?'}（${o.app.package || '?'}）· ${o.count} 项 · ${o.chars} 字 · dump ${o.ms.dump}ms · hash ${o.hash.slice(0, 8)}`);
  say(o.table || '（这一屏没有可点的东西）');
  if (o.thin) say(`⚠ ${o.hint}`);
  if (o.shot?.file) say(`截图：${o.shot.file}（${(o.shot.bytes / 1024).toFixed(0)} KB）`);
}

async function tap() {
  const a = args._[1];
  const b = args._[2];
  if (a && b && /^\d+$/.test(a) && /^\d+$/.test(b)) {
    const r = await phone.tapXY(Number(a), Number(b));
    return say(r);
  }
  if (!a) return say('用法：tap n3  或  tap 360 640');
  const r = await phone.tap(a, { verify: args.verify !== false });
  if (!r.ref) return say(json ? r : `✗ ${r.msg || '没点成'}`);
  say(json ? r : `${r.ok ? '✓' : '✗'} 点了 ${r.ref}「${r.label || ''}」→ ${r.changed === false ? '界面没变' : '界面变了'}（${r.verifiedMs ?? r.ms}ms）${r.hint ? '\n  ' + r.hint : ''}`);
}

async function swipe() {
  const r = await phone.swipeDir(args._[1] || 'up', { ms: Number(args.ms) || 300 });
  say(r);
}

async function text() {
  const r = await phone.text(args._[1] || '');
  say(json ? r : `${r.ok ? '✓' : '✗'} 输入（${r.ms}ms）${r.ok ? '' : '：' + r.msg}`);
}

async function key() {
  const r = await phone.key(args._[1] || 'back');
  say(r);
}

async function launch() {
  const r = await phone.launch(args._[1] || '');
  say(json ? r : `${r.ok ? '✓' : '✗'} 打开 ${r.pkg}（${r.ms}ms）${r.ok ? '' : '：' + r.msg}`);
}

async function shot() {
  const out = args.out ? path.resolve(args.out) : '';
  const r = await phone.screenshot({ save: out ? path.dirname(out) : path.join(__dirname, '..', 'data', 'phone'), name: out ? path.basename(out) : '' });
  if (!r.ok) return say({ ok: false, error: r.error });
  say(json ? { ok: true, file: r.file, bytes: r.bytes, hash: r.hash, ms: r.ms } : `✓ 截图 ${r.file}（${(r.bytes / 1024).toFixed(0)} KB，${r.ms}ms）`);
}

/** 全链路：接 → 看 → 点一个最稳的项 → 截 → 报时。 */
async function probe() {
  const t0 = Date.now();
  const conn = await phone.connect();
  const st = await phone.state();
  const o = await phone.observe({ shot: true });
  const s = await phone.screenshot();
  const lines = [
    `adb: ${conn.ok ? '连上' : '没连上'}（${conn.ms}ms）`,
    `设备: ${st.online ? '在线' : '离线'} · ${st.booted ? '已启动' : '未启动'} · ${st.screen.width}x${st.screen.height}`,
    `观测: ${o.ok ? `${o.count} 项 / ${o.chars} 字 / ${o.ms.dump}ms / hash ${o.hash.slice(0, 8)}` : o.error}`,
    `截图: ${s.ok ? `${(s.bytes / 1024).toFixed(0)} KB / ${s.ms}ms` : s.error}`,
    `总计: ${Date.now() - t0}ms`,
  ];
  if (o.ok && o.nodes.length) {
    const t = await phone.tap(o.nodes[0].ref, { verify: true });
    lines.push(`试点: ${t.ok ? '成功' : '没成'}（${t.ref}「${(t.label || '').slice(0, 20)}」→ ${t.changed === false ? '界面没变' : '变了'}，${t.verifiedMs ?? t.ms}ms）`);
  }
  say(lines.join('\n'));
  if (json) say({ conn, st, obs: { ...o, shot: undefined, nodes: o.nodes?.length }, shot: { ok: s.ok, bytes: s.bytes, ms: s.ms } });
}

const table = { status, obs, tap, swipe, text, key, launch, shot, probe, doctor, up, show };
(async () => {
  const fn = table[cmd];
  if (!fn) {
    console.log('可用：' + Object.keys(table).join(' / '));
    process.exit(2);
  }
  try {
    await fn();
  } catch (err) {
    console.error(`出错了：${err.message}`);
    process.exit(1);
  }
})();
