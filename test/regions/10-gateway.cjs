/**
 * 自检区域：QQ 网关管家（2026-10-26 新增）。
 *
 * 这一区**不碰真 QQ、不拉起 NapCat**（`DSP_NO_GATEWAY=1` 兜底，这里再显式注入假
 * `spawn` / `execFile` / `probe`），只验四件事：
 *   A. 纯逻辑：目录检查、webui.json、token 口令、拉起命令、二维码读取、退避；
 *   B. WebUI 客户端：登录换 credential、带 Bearer 调 `/api/QQLogin/*`、401 后自动重登；
 *   C. 状态机：没端口 → 拉起 → 等扫码（有码/有快速登录账号）→ 已登录 → 停止；
 *   D. 接线：陪伴状态里带 gateway；设置页/小手机里有二维码的位置。
 *
 * 单跑：`node test\run-one.cjs 10-gateway.cjs`
 */
module.exports = {
  name: 'QQ 网关管家',
  tags: ['companion', 'gateway', '网关', 'qq'],
  async run(ctx) {
    const { ok, fs, path, http } = ctx;
    const crypto = require('node:crypto');
    const g = ctx.mod('companion-gateway');

    /* ---------- A. 纯逻辑 ---------- */

    const dir = path.join(ctx.CONFIG_DIR, 'napcat-fixture');
    fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'cache'), { recursive: true });
    ok('目录检查：空目录会被标成缺文件', !g.checkDir(dir).ok && g.checkDir(dir).missing.length === 6);

    for (const f of ['NapCatWinBootMain.exe', 'QQ.exe', 'NapCatWinBootHook.dll', 'napcat.mjs', 'qqnt.json', 'loadNapCat.js']) {
      fs.writeFileSync(path.join(dir, f), 'x');
    }
    ok('目录检查：六个文件齐了就算可用', g.checkDir(dir).ok && g.checkDir(dir).missing.length === 0);

    const webuiFile = path.join(dir, 'config', 'webui.json');
    fs.writeFileSync(webuiFile, JSON.stringify({ host: '::', port: 6099, token: 'tok-123' }));
    const conf = g.readWebuiConfig(dir);
    ok('WebUI 配置：端口和 token 读得到', conf.ok && conf.port === 6099 && conf.token === 'tok-123');
    ok('WebUI 配置：host 是 :: 时也只连 127.0.0.1', conf.host === '127.0.0.1');
    ok('WebUI 配置：文件不在会说人话（不抛）', !g.readWebuiConfig(path.join(dir, 'nope')).ok);

    // NapCat 的口令是 sha256(token + ".napcat")，解包 napcat.mjs 看到的
    ok('登录口令：sha256(token + ".napcat")',
      g.hashToken('tok-123') === crypto.createHash('sha256').update('tok-123.napcat').digest('hex'));

    const cmd = g.buildLaunch({ dir, uin: '10001' });
    ok('拉起命令：用启动器 + 注入 hook + -q 小号',
      cmd.exe.endsWith('NapCatWinBootMain.exe')
      && cmd.args[0].endsWith('QQ.exe')
      && cmd.args[1].endsWith('NapCatWinBootHook.dll')
      && cmd.args.slice(2).join(' ') === '-q 10001');
    ok('拉起命令：清掉 ELECTRON_RUN_AS_NODE（否则 QQ 静默不启动）', !('ELECTRON_RUN_AS_NODE' in cmd.env));
    ok('拉起命令：五个 NAPCAT_* 变量齐全',
      ['NAPCAT_PATCH_PACKAGE', 'NAPCAT_LOAD_PATH', 'NAPCAT_INJECT_PATH', 'NAPCAT_LAUNCHER_PATH', 'NAPCAT_MAIN_PATH']
        .every((k) => !!cmd.env[k]));
    ok('拉起命令：工作目录就是 NapCat 目录', path.resolve(cmd.cwd) === path.resolve(dir));
    ok('拉起命令：不填 QQ 号就不带 -q', g.buildLaunch({ dir }).args.length === 2);

    const wrap = g.buildWrapper(cmd);
    ok('拉起命令：包一层隐藏控制台（powershell -WindowStyle Hidden + chcp 65001）',
      wrap.exe === 'powershell.exe'
      && wrap.args.join(' ').includes('-WindowStyle Hidden')
      && wrap.args.join(' ').includes('chcp 65001')
      && wrap.args.join(' ').includes("'-q' '10001'"));

    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(200, 7)]);
    fs.writeFileSync(path.join(dir, 'cache', 'qrcode.png'), png);
    const qr = g.readQr(dir);
    ok('二维码：从 cache\\qrcode.png 读成 data URL', qr && qr.dataUrl.startsWith('data:image/png;base64,') && qr.at > 0);
    ok('二维码：没有文件就是 null（不抛）', g.readQr(path.join(ctx.CONFIG_DIR, 'none')) === null);

    const backoff = [0, 1, 2, 3, 4, 5, 6, 9].map((n) => g.backoffMs(n));
    ok('退避：单调不降、最短 5 秒、最长 5 分钟',
      backoff.every((v, i) => v >= 5000 && (i === 0 || v >= backoff[i - 1])) && backoff.at(-1) === 300000);

    /* ---------- B. WebUI 客户端（假 NapCat） ---------- */

    /**
     * 假 WebUI：`/api/auth/login` 核对 hash 后发 credential；
     * 其余 `/api/QQLogin/*` 必须带 `Bearer <当前 credential>`，否则 401。
     * `status` 是可变对象，测试中途改它来模拟"扫码/登录成功"。
     */
    const status = { isLogin: false, online: false, loginPhase: 'waiting_qrcode', loginError: '' };
    let logins = 0;
    let cred = '';
    let authHeader = '';
    const calls = [];
    /**
     * ★ 2026-10-31：真 NapCat 在凭据失效时**HTTP 还是 200**，只在 body 里回
     * `{code:-1, message:"Unauthorized"}`。这两个开关让假服务器也这么演。
     */
    let bodyAuthMode = false;      // 凭据不对 → HTTP 200 + body Unauthorized
    let alwaysUnauthorized = false; // 连重登都不给凭据（模拟 NapCat 换了密钥）
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        const body = text ? JSON.parse(text) : {};
        const send = (code, data, httpStatus = 200) => {
          res.writeHead(httpStatus, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ code, message: code ? 'err' : 'success', data }));
        };
        const sendMsg = (code, message, httpStatus = 200) => {
          res.writeHead(httpStatus, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ code, message, data: null }));
        };
        if (req.url === '/api/auth/login') {
          if (alwaysUnauthorized) return sendMsg(-1, 'Unauthorized');
          if (body.hash !== g.hashToken('tok-123')) return send(1, null, 200);
          logins += 1;
          cred = `cred-${logins}`;
          return send(0, { Credential: cred });
        }
        const route = String(req.url || '').replace('/api/QQLogin/', '');
        authHeader = req.headers.authorization || '';
        if (alwaysUnauthorized) return sendMsg(-1, 'Unauthorized');
        if (authHeader !== `Bearer ${cred}` || !cred) {
          return bodyAuthMode ? sendMsg(-1, 'Unauthorized') : send(401, null, 401);
        }
        calls.push(route);
        if (route === 'CheckLoginStatus') return send(0, { ...status });
        if (route === 'GetQQLoginInfo') return send(0, { uin: '10001', nick: '小鱼', avatarUrl: 'https://x/a.png' });
        if (route === 'GetQuickLoginListNew') return send(0, [{ uin: '10001', nickName: '小鱼' }]);
        if (route === 'RefreshQRcode') return send(0, { qrcodeurl: 'https://q' });
        if (route === 'SetQuickLogin') return send(0, null);
        return send(2, null);
      });
    });
    const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
    // 状态机要按 WebUI 的端口探活，所以 fixture 里的 webui.json 改成假服务的端口
    fs.writeFileSync(webuiFile, JSON.stringify({ host: '::', port, token: 'tok-123' }));

    const client = new g.WebuiClient({ port, token: 'tok-123', request: g.httpJson });
    const st1 = await client.call('CheckLoginStatus');
    ok('客户端：先登录换 credential，再带 Bearer 调接口',
      st1.loginPhase === 'waiting_qrcode' && authHeader === 'Bearer cred-1');
    const quick = await client.call('GetQuickLoginListNew');
    ok('客户端：快速登录名单拿得到（uin + 昵称）', quick[0].uin === '10001' && quick[0].nickName === '小鱼');

    status.isLogin = true;
    status.online = true;
    status.loginPhase = 'done';
    const st2 = await client.call('CheckLoginStatus');
    ok('客户端：登录态/在线态跟着 NapCat 变', st2.isLogin === true && st2.online === true);
    const info = await client.call('GetQQLoginInfo');
    ok('客户端：昵称和头像拿得到', info.nick === '小鱼' && info.avatarUrl.startsWith('https://'));

    // 服务端把 credential 换掉 → 客户端吃 401 后应该自己重登一次再成功
    cred = 'stale';
    const st3 = await client.call('CheckLoginStatus');
    ok('客户端：401 后自动重登并重试', st3.isLogin === true && logins === 2);

    /* ---------- B2. ★ 2026-10-31：NapCat 说 Unauthorized 的真样子 ---------- */

    ok('凭据失效：HTTP 200 + body 里 Unauthorized 也认',
      g.isAuthFailure({ status: 200, json: { code: -1, message: 'Unauthorized' } }) === true);
    ok('凭据失效：HTTP 401/403 还认', g.isAuthFailure({ status: 401, json: {} }) === true && g.isAuthFailure({ status: 403 }) === true);
    ok('凭据失效：普通业务错误不算（别把"没登录"当凭据问题）',
      g.isAuthFailure({ status: 200, json: { code: 1, message: '参数不对' } }) === false);

    // 真机上的样子：iPhone 上登录过一次之后，旧凭据作废，NapCat 回 HTTP 200 + code -1 "Unauthorized"。
    // 旧代码只认 HTTP 401，于是手里那份死凭据要拖到 50 分钟缓存过期——期间刷新二维码/快速登录全废。
    bodyAuthMode = true;
    cred = 'stale-2';
    const st4 = await client.call('CheckLoginStatus');
    ok('客户端：body 里回 Unauthorized 也能自愈（重登 + 重试）', st4.isLogin === true && logins === 3);
    bodyAuthMode = false;

    /* ---------- C. 状态机（假 spawn / 假探活） ---------- */

    const ports = new Set();
    const spawns = [];
    const fakeSpawn = (exe, args, opts) => {
      spawns.push({ exe, args, opts });
      return { on() {}, unref() {}, pid: 4242 };
    };
    const gw = g.create({
      getConfig: () => ({ dir, uin: '10001', autoStart: true, pollMs: 60 }),
      onChange: () => {},
      deps: {
        allowLaunch: true,
        probePort: async (p) => ports.has(p),
        spawn: fakeSpawn,
        execFile: (_f, _a, _o, cb) => { if (cb) cb(); },
        httpJson: g.httpJson,
      },
    });

    await gw.start();
    ok('状态机：两个口都没开时，会按配置拉起 NapCat',
      spawns.length === 1
      && spawns[0].exe.endsWith('powershell.exe')
      && spawns[0].args.join(' ').includes("'-q' '10001'")
      && spawns[0].opts.windowsHide === false
      && !spawns[0].opts.detached
      && gw.publicState().phase === 'starting');

    ports.add(port);
    status.isLogin = false;
    status.online = false;
    status.loginPhase = 'waiting_qrcode';
    const s1 = await gw.peek();
    ok('状态机：等扫码时显示二维码 + 本机账号',
      s1.phase === 'waiting_qrcode' && s1.qrAvailable && s1.quickList.length === 1 && s1.needsLogin);

    ports.add(3001);
    status.isLogin = true;
    status.online = true;
    status.loginPhase = 'done';
    const s2 = await gw.peek();
    ok('状态机：登录 + OneBot 都在 → 已就绪，带昵称/QQ 号',
      s2.phase === 'ready' && s2.selfId === '10001' && s2.nick === '小鱼' && s2.onebot === true && !s2.needsLogin);

    /**
     * ★ 2026-11-03：**NapCat 说"掉线"的真形状是 `isOffline`，不是 `online`**
     * （解包 napcat.mjs 的 `CheckLoginStatus` 看来的：isLogin = 登录着 且 online，
     * isOffline = 登录着 但 offline）。旧代码读 `st.online` 永远是 undefined，
     * 于是登录着也一直报"不在线"，掉线那 1 分钟还会把 QQ 号/昵称清空。
     */
    status.isLogin = false;
    status.isOffline = true;
    status.loginPhase = 'reconnecting';
    const s2b = await gw.peek();
    ok('掉线（isOffline:true）：仍算已登录账号，只是不在线、等它重连',
      s2b.isLogin === true && s2b.online === false && s2b.phase === 'starting'
      && s2b.selfId === '10001' && s2b.nick === '小鱼' && !s2b.needsLogin);
    status.isOffline = false;
    status.isLogin = true;
    status.online = true;
    status.loginPhase = 'done';
    const s2c = await gw.peek();
    ok('掉线之后回来：又变回已就绪、在线', s2c.online === true && s2c.phase === 'ready');

    await gw.stop();
    ok('状态机：停止 → 关进程、清二维码、回到 off', gw.publicState().phase === 'off' && !gw.publicState().running);

    // 停止之后端口都没了（假的）；再启动应该重新拉一次，而不是"接管"
    ports.clear();
    // 桌宠退出只 suspend，不杀 QQ（用户 2026-10-26 定的）
    await gw.start();
    gw.suspend();
    ok('状态机：suspend 只停 watchdog（QQ 继续挂着）', gw.publicState().enabled === false && spawns.length === 2);
    await gw.stop();

    /* ---------- C2. ★ 2026-10-31：凭据坏了，二维码也必须亮出来 ---------- */

    /**
     * 用户实测原话：「qq 登录失败了…现在二维码也没出现，重新登录也没用」。
     * 复现：NapCat 那边凭据全废（HTTP 200 + body Unauthorized），
     * 旧代码 `readLogin` 一抛错就直接 return，`state.qr` 永远是空 → 面板一直"等 NapCat 生成二维码…"。
     * 现在要求：**报错照报，码照给**（码是 NapCat 自己写到 cache\\qrcode.png 的，读它不需要凭据）。
     */
    alwaysUnauthorized = true;
    ports.add(port);
    let gw2Spawn = 0;
    const gw2 = g.create({
      getConfig: () => ({ dir, autoStart: true, pollMs: 60 }),
      deps: {
        allowLaunch: true,
        probePort: async (p) => ports.has(p),
        spawn: () => { gw2Spawn += 1; return { on() {}, unref() {}, pid: 1 }; },
        execFile: (_f, _a, _o, cb) => { if (cb) cb(); },
        httpJson: g.httpJson,
      },
    });
    await gw2.start();
    const s3 = await gw2.peek();
    ok('凭据坏了：错误照报（Unauthorized）', /Unauthorized/i.test(s3.lastError));
    ok('凭据坏了：二维码照样给出来（这就是用户要的）', s3.qrAvailable === true && !!(s3.qr && s3.qr.dataUrl));
    ok('凭据坏了：阶段是 login_error，不是一直"等生成"', s3.phase === 'login_error' && s3.needsLogin === true);
    ok('凭据坏了：不该乱重启（只接管了已经在跑的）', gw2Spawn === 0);
    await gw2.stop();
    alwaysUnauthorized = false;
    ports.delete(port);

    server.close();

    /* ---------- D. 接线 ---------- */

    const comp = ctx.mod('companion');
    const cs = comp.publicState();
    ok('陪伴状态里带网关卡（阶段 / 是否需要登录 / 二维码）',
      !!cs.gateway && typeof cs.gateway.phase === 'string' && 'needsLogin' in cs.gateway && 'qrAvailable' in cs.gateway);
    ok('网关默认跟随桌宠启动，且退出不关 QQ',
      g.DEFAULTS.autoStart === true && g.DEFAULTS.keepAlive === true);

    const settingsHtml = fs.readFileSync(path.join(ctx.app, 'web', 'settings.html'), 'utf8');
    ok('设置页有「QQ 连接」卡：二维码、快速登录、三个按钮',
      settingsHtml.includes('id="gatewayCard"') && settingsHtml.includes('id="gQr"')
      && settingsHtml.includes('id="gQuick"') && settingsHtml.includes('gatewayState'));
    const petHtml = fs.readFileSync(path.join(ctx.app, 'web', 'pet.html'), 'utf8');
    ok('小手机里有登录二维码区（刷新 / 打开设置）',
      petHtml.includes('id="phoneLogin"') && petHtml.includes('id="phoneQr"')
      && petHtml.includes('id="phoneRefresh"') && petHtml.includes('id="phoneSettings"'));
  },
};
