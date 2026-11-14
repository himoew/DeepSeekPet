/**
 * OneBot v11 传输层 —— 收 QQ 消息、发 QQ 消息、报"正在输入"。
 *
 * 只做传输，不做"该不该回"（那是 `companion-wake.cjs`）和"回什么"
 * （那是 `companion-brain.cjs`）。这样以后换网关（NapCat / SnowLuma / Lagrange）
 * 或者换平台（微信 / Telegram），上面两层都不用动。
 *
 * 连接方式：
 *   · WebSocket：收事件（NapCat/SnowLuma 的正向 WS，一般 3001）
 *   · HTTP：调 API 发消息（一般 3000）；HTTP 没配时才退回 WS 调用
 *
 * 安全：只连 127.0.0.1（配置里写别的地址也由用户自己负责）；token 只放请求头，
 * 不写日志。
 */
const { WebSocket } = require('ws');

/** 把 OneBot 的消息段拼成纯文本。 */
function segsToText(segs) {
  if (!Array.isArray(segs)) return String(segs || '');
  const out = [];
  for (const s of segs) {
    if (!s) continue;
    switch (s.type) {
      case 'text': out.push(s.data?.text || ''); break;
      case 'at': out.push(`@${s.data?.qq || ''}`); break;
      case 'image': out.push('[图片]'); break;
      case 'face': out.push('[表情]'); break;
      case 'mface': out.push('[表情]'); break;
      case 'record': out.push('[语音]'); break;
      case 'video': out.push('[视频]'); break;
      case 'reply': break;              // 引用单独处理
      default: break;
    }
  }
  return out.join('').trim();
}

/**
 * ★ 2026-11-05：**去掉正文开头的"昵称："**。
 *
 * 真机：他发来的每一条正文都长成 `✏️：我回来了`（`✏️` 是他的 QQ 昵称，见 `people.json`
 * 里那句「QQ 昵称是 ✏️，别拿昵称当名字」）。实测 994/1153 轮都带着它 —— 而这条前缀会
 * 一路跟着进她的回看（messages）、证词（`evidence.quote`）、BM25 检索词，
 * 等于每句话前面都多贴一个跟他无关的符号。
 *
 * ⚠️ 只剥**发送者自己的名字**，而且**剥完是空的就不剥**（万一有人整条只发了个"昵称："）。
 * 昵称里可能有正则元字符，所以用 startsWith 而不是拼正则。
 * ⚠️ 2026-11-05 第二次踩：`card`（群名片）和 `nickname` **不是一回事** —— 他有群名片"小主"、
 * 昵称"✏️"，只拿第一个名字去剥等于没剥（20:50 那条 `✏️：想象一下你的小手` 就是这么漏的）。
 * 所以这里收**一串**候选名字，逐个剥。
 */
function stripNamePrefix(text, name) {
  const t = String(text || '');
  const names = (Array.isArray(name) ? name : [name])
    .map((n) => String(n || '').trim())
    .filter((n) => n && n.length <= 24);
  let out = t;
  for (const n of names) {
    for (const sep of ['：', ':']) {
      const head = `${n}${sep}`;
      if (out.startsWith(head)) {
        const rest = out.slice(head.length).replace(/^\s+/, '');
        out = rest || out;
      }
    }
  }
  return out;
}

/** 字符串形式的 CQ 码（有些网关会把 message 给成字符串）。 */function cqToText(raw) {
  return String(raw || '')
    .replace(/\[CQ:at,qq=([^,\]]+)[^\]]*\]/g, (_m, qq) => `@${qq}`)
    .replace(/\[CQ:image[^\]]*\]/g, '[图片]')
    .replace(/\[CQ:face[^\]]*\]/g, '[表情]')
    .replace(/\[CQ:record[^\]]*\]/g, '[语音]')
    .replace(/\[CQ:[^\]]*\]/g, '')
    .trim();
}

/** 数字 id 尽量发数字（NapCat 对字符串 id 有时不认）。 */
const idNum = (v) => (/^\d+$/.test(String(v)) ? Number(v) : v);

/**
 * ★ 2026-11-01：**OneBot 的 `time` 统一成毫秒，而且不许跑到未来**。
 *
 * 协议里 `time` 是**秒**，但有些实现（或转发的第三方网关）给的是毫秒。
 * 原来这里是 `(ev.time || Date.now()/1000) * 1000` —— 收到毫秒就直接乘成 5 万年以后，
 * 于是 `presence` 的"对方刚说完话"闸门（`at - lastUserAt < 3 分钟`）**永远成立**：
 * 她再也不会主动开口，而且一条错都不会报。反过来，如果本机时钟比网关慢，
 * `ev.time` 落在未来同样会把闸门焊死。
 * 所以：> 1e12 当毫秒；落在未来超过 1 分钟的当"现在"。
 */
function normalizeTime(raw, now = Date.now()) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return now;
  const ms = n > 1e12 ? n : n * 1000;
  return ms > now + 60_000 ? now : ms;
}

/**
 * ★ 2026-10-26：把图片段单独留下来（以前只拼成 `[图片]`，URL 直接丢了）。
 * 一条消息里可能有多张；`url` 是 QQ 的 CDN 地址（能直接下载），`file` 可能是本地缓存名。
 * 只收这两种能拿到字节的字段，其余（表情包 mface 等）先不在这里展开。
 */
function segsToImages(segs) {
  if (!Array.isArray(segs)) return [];
  return segs
    .filter((s) => s && s.type === 'image')
    .map((s) => ({
      url: String(s.data?.url || ''),
      file: String(s.data?.file || ''),
      summary: String(s.data?.summary || ''),
    }))
    .filter((x) => x.url || x.file);
}

/** 字符串形式 CQ 码里的图片（有的网关把 message 直接给成字符串）。 */
function cqToImages(raw) {
  const out = [];
  const text = String(raw || '');
  const re = /\[CQ:image,([^\]]*)\]/g;
  let m;
  while ((m = re.exec(text))) {
    const attrs = {};
    for (const piece of m[1].split(',')) {
      const i = piece.indexOf('=');
      if (i > 0) attrs[piece.slice(0, i)] = piece.slice(i + 1);
    }
    if (attrs.url || attrs.file) out.push({ url: attrs.url || '', file: attrs.file || '', summary: attrs.summary || '' });
  }
  return out;
}

/**
 * ★ 2026-11-02：**把语音条（record 段）单独留下来**。
 *
 * 以前 `segsToText` 只把它拼成一个 `[语音]` 占位符，音频本身直接扔了 ——
 * 于是她永远"听不见"他发的语音。现在留下三样：
 *   · `file`  —— NapCat 的**文件令牌**（里面编了 msgId/elementId），`get_record` 认它；
 *   · `url`   —— ptt 地址（可能为空、也可能过期，只作兜底）；
 *   · `seconds` —— 有的网关会给时长。
 *
 * `get_record` 的用法见 `companion.cjs` 的 `recordBytes()`。
 */
function segsToRecords(segs) {
  if (!Array.isArray(segs)) return [];
  return segs
    .filter((s) => s && s.type === 'record')
    .map((s) => ({
      file: String(s.data?.file || ''),
      url: String(s.data?.url || ''),
      fileSize: Number(s.data?.file_size || 0) || 0,
      seconds: Number(s.data?.duration || s.data?.seconds || 0) || 0,
      name: String(s.data?.name || s.data?.file_name || ''),
    }))
    .filter((x) => x.file || x.url);
}

/** 字符串形式 CQ 码里的语音条（`[CQ:record,file=…]`）。 */
function cqToRecords(raw) {
  const out = [];
  const text = String(raw || '');
  const re = /\[CQ:record,([^\]]*)\]/g;
  let m;
  while ((m = re.exec(text))) {
    const attrs = {};
    for (const piece of m[1].split(',')) {
      const i = piece.indexOf('=');
      if (i > 0) attrs[piece.slice(0, i)] = piece.slice(i + 1);
    }
    if (attrs.file || attrs.url) {
      out.push({
        file: attrs.file || '',
        url: attrs.url || '',
        fileSize: Number(attrs.file_size || 0) || 0,
        seconds: Number(attrs.duration || 0) || 0,
        name: attrs.name || '',
      });
    }
  }
  return out;
}

/**
 * ★ 2026-10-26：**QQ 商城表情**（mface）也单独留下来。
 * 它没有"图片 URL"，只有 `emoji_package_id / emoji_id / key` 三件套；
 * 拿到之后可以原样发回去（`sendMface`），这也是"她能把别人发的表情收下来再发"的唯一稳办法。
 */
function segsToMfaces(segs) {
  if (!Array.isArray(segs)) return [];
  return segs
    .filter((s) => s && s.type === 'mface')
    .map((s) => ({
      emojiPackageId: Number(s.data?.emoji_package_id || s.data?.emojiPackageId || 0),
      emojiId: String(s.data?.emoji_id || s.data?.emojiId || ''),
      key: String(s.data?.key || s.data?.emojiKey || ''),
      summary: String(s.data?.summary || s.data?.faceName || ''),
    }))
    .filter((x) => x.emojiId && x.key);
}

class OneBotClient {
  /**
   * @param {object} opts
   * @param {string} opts.wsUrl
   * @param {string} [opts.httpUrl]
   * @param {string} [opts.accessToken]
   * @param {(msg:object)=>void} opts.onMessage
   * @param {(st:object)=>void} [opts.onStatus]
   * @param {(msg:object)=>void} [opts.onQuoteCheck]  引用查清之后回填（见 `#checkQuote`）
   */
  constructor({ wsUrl, httpUrl = '', accessToken = '', onMessage, onStatus, onQuoteCheck }) {
    this.wsUrl = wsUrl;
    this.httpUrl = String(httpUrl || '').replace(/\/+$/, '');
    this.accessToken = accessToken || '';
    this.onMessage = onMessage;
    this.onStatus = onStatus || (() => {});
    this.onQuoteCheck = onQuoteCheck || (() => {});
    this.selfId = '';
    this.ws = null;
    this.connected = false;
    this.stopped = false;
    this.retry = 0;
    this.timer = null;
    this.pending = new Map();
    this.seq = 0;
    /**
     * ★ 2026-11-03：**心跳看门狗**。
     *
     * NapCat 的 WS 每 30 秒发一条 `meta_event/heartbeat`（onebot11 配置里 `heartInterval: 30000`，
     * 实测 18ms / 32s / 62s 各一条）。如果那条连接已经被掐死、TCP 还挂着 ESTABLISHED
     * （账号掉线重连之后真会这样），`connected` 会一直是 true、`close` 永远不来 ——
     * 表现就是"QQ 静悄悄地一条都不回"，日志里什么都没有。
     *
     * 所以：90 秒一条事件都没有 = 这条连接死了，主动 terminate 让上面那套退避重连。
     */
    this.lastEventAt = Date.now();
    this.watchdog = null;
  }

  start() {
    this.stopped = false;
    this.#connect();
    this.#watch();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = null;
    clearInterval(this.watchdog);
    this.watchdog = null;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.resolve({ ok: false, error: '连接已关闭' });
    }
    this.pending.clear();
    try { this.ws?.close(); } catch { /* 已经断了 */ }
    this.ws = null;
    this.connected = false;
    this.onStatus({ connected: false, selfId: this.selfId, stopped: true });
  }

  #headers() {
    return this.accessToken ? { authorization: `Bearer ${this.accessToken}` } : {};
  }

  #connect() {
    if (this.stopped) return;
    let ws;
    try {
      ws = new WebSocket(this.wsUrl, { headers: this.#headers() });
    } catch (err) {
      this.onStatus({ connected: false, error: `OneBot 地址不对：${err.message}` });
      this.#schedule();
      return;
    }
    this.ws = ws;

    ws.on('open', () => {
      this.connected = true;
      this.retry = 0;
      this.lastEventAt = Date.now();          // 刚连上：看门狗从这里重新计时
      this.onStatus({ connected: true, selfId: this.selfId, wsUrl: this.wsUrl });
    });
    ws.on('message', (data) => {
      let ev;
      try { ev = JSON.parse(String(data)); } catch { return; }
      this.#handle(ev);
    });
    ws.on('error', (err) => {
      this.onStatus({ connected: false, error: `OneBot 连接出错：${err.message}` });
    });
    ws.on('close', () => {
      this.connected = false;
      this.ws = null;
      if (this.stopped) return;
      this.onStatus({ connected: false, selfId: this.selfId });
      this.#schedule();
    });
  }

  #schedule() {
    if (this.stopped) return;
    const ms = Math.min(30_000, 3_000 * (2 ** Math.min(this.retry, 4)));
    this.retry += 1;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.#connect(), ms);
    this.timer.unref?.();
  }

  /**
   * 心跳看门狗：连接看着还在、却 90 秒一条事件都没有 → 这条连接多半已经死了。
   * NapCat 每 30 秒一条 `meta_event/heartbeat`，90 秒 = 连丢三条。
   */
  #watch() {
    clearInterval(this.watchdog);
    this.watchdog = setInterval(() => {
      if (this.stopped || !this.connected || !this.ws) return;
      const idle = Date.now() - this.lastEventAt;
      if (idle < 90_000) return;
      this.onStatus({
        connected: false,
        selfId: this.selfId,
        wsUrl: this.wsUrl,
        error: `OneBot ${Math.round(idle / 1000)} 秒没有任何事件（连接像死了），自动重连`,
      });
      this.lastEventAt = Date.now();
      try {
        if (typeof this.ws.terminate === 'function') this.ws.terminate();
        else this.ws.close();
      } catch { /* 已经断了 */ }
    }, 20_000);
    this.watchdog.unref?.();
  }

  #handle(ev) {
    if (!ev || typeof ev !== 'object') return;
    this.lastEventAt = Date.now();          // 任何事件（含心跳/回执）都算"这条线还活着"
    // WS 调用的回执：`{status, retcode, data, echo}`
    if (ev.echo && this.pending.has(ev.echo)) {
      const p = this.pending.get(ev.echo);
      clearTimeout(p.timer);
      this.pending.delete(ev.echo);
      const ok = (ev.status === undefined || ev.status === 'ok') && (ev.retcode === undefined || ev.retcode === 0);
      p.resolve({ ok, data: ev.data, error: ok ? '' : (ev.message || ev.wording || `retcode=${ev.retcode}`) });
      return;
    }
    if (ev.post_type === 'meta_event' && ev.meta_event_type === 'lifecycle') {
      this.selfId = String(ev.self_id || '');
      this.onStatus({ connected: this.connected, selfId: this.selfId, wsUrl: this.wsUrl });
      return;
    }
    if (ev.post_type === 'message') {
      if (ev.self_id) this.selfId = String(ev.self_id);
      const msg = this.#normalizeMessage(ev);
      if (msg && msg.userId !== this.selfId) {
        /**
         * 引用是不是"引用了她"要再查一次 `get_msg`（见 `#checkQuote`）。
         * **先放后台**，别为了一个布尔值多等一次往返再收这条消息。
         */
        if (msg.replyTo) this.#checkQuote(msg);
        this.onMessage(msg);
      }
      return;
    }
    // 戳一戳：QQ 的"拍了拍"不是 message，是 notice
    if (ev.post_type === 'notice' && ev.notice_type === 'notify' && ev.sub_type === 'poke') {
      if (ev.self_id) this.selfId = String(ev.self_id);
      const target = String(ev.target_id || '');
      if (target && this.selfId && target !== this.selfId) return;
      const isGroup = !!ev.group_id;
      this.onMessage({
        key: isGroup ? `group:${ev.group_id}` : `private:${ev.user_id}`,
        isGroup,
        groupId: isGroup ? String(ev.group_id) : '',
        userId: String(ev.user_id || ''),
        name: String(ev.sender?.card || ev.sender?.nickname || ev.user_id || ''),
        text: '[戳一戳]',
        raw: ev,
        images: [],
        mfaces: [],
        isAtMe: false,
        isQuoteMe: false,
        isPoke: true,
        replyTo: '',
        messageId: String(ev.notice_seq || ''),
        time: Date.now(),
      });
    }
  }

  #normalizeMessage(ev) {
    const isGroup = ev.message_type === 'group';
    const segs = ev.message;
    const rawText = Array.isArray(segs) ? segsToText(segs) : cqToText(segs);
    const name = String(ev.sender?.card || ev.sender?.nickname || ev.user_id || '');
    /** 正文可能以**群名片**或**昵称**开头，两个都要试（真机踩过一次，见 `stripNamePrefix`）。 */
    const nameCands = [ev.sender?.card, ev.sender?.nickname].filter(Boolean);
    const images = Array.isArray(segs) ? segsToImages(segs) : cqToImages(segs);
    const mfaces = Array.isArray(segs) ? segsToMfaces(segs) : [];
    const records = Array.isArray(segs) ? segsToRecords(segs) : cqToRecords(segs);
    let atMe = false;
    let replyTo = '';
    if (Array.isArray(segs)) {
      for (const s of segs) {
        if (s?.type === 'at' && String(s.data?.qq) === this.selfId) atMe = true;
        if (s?.type === 'reply') replyTo = String(s.data?.id || '');
      }
    } else if (this.selfId && String(segs).includes(`[CQ:at,qq=${this.selfId}`)) {
      atMe = true;
    }
    return {
      key: isGroup ? `group:${ev.group_id}` : `private:${ev.user_id}`,
      isGroup,
      groupId: isGroup ? String(ev.group_id) : '',
      userId: String(ev.user_id || ''),
      name,
      text: stripNamePrefix(rawText, nameCands),
      raw: segs,
      images,
      mfaces,
      records,
      isAtMe: atMe,
      // 引用是不是"引用了她"要再查一次 get_msg（`#checkQuote`）；查清之前先当"不是"。
      isQuoteMe: false,
      isPoke: false,
      replyTo,
      messageId: String(ev.message_id || ''),
      time: normalizeTime(ev.time),
    };
  }

  /**
   * ★ 2026-11-01：**"她在引用回复你"这件事，她终于知道了**。
   *
   * 原来 `isQuoteMe` 恒 false（注释写着"要再查一次 get_msg，第一版不查"），于是
   * 群里你引用她的话回她，她只当是条普通群消息（`companion-wake` 里"引用她 = 在跟她说话"
   * 那条判断从来没生效过）。
   *
   * 为什么不 await：查一次是**多一次往返**，而收消息的路不该被它拖住。
   * 放后台查，拿到再叫 `onQuoteCheck` —— 上层把**已经进了合并窗口**的那条改掉
   * （窗口 1.5 秒，本机一次 `get_msg` 是毫秒级，赶得上）。
   * 引用的是别人的 → 什么都不做，`isQuoteMe` 保持 false。
   */
  #checkQuote(msg) {
    Promise.resolve()
      .then(() => this.call('get_msg', { message_id: idNum(msg.replyTo) }, 4000))
      .then((r) => {
        if (!r || !r.ok) return;
        const sender = String(r.data?.sender?.user_id ?? r.data?.sender?.id ?? '');
        if (!sender || !this.selfId) return;
        /**
         * 引的是别人也**照样回填**：上层要拿这次"查清了"去结束挂起
         * （`companion.cjs` 的 `applyQuoteCheck` 要把"等醒不醒"的那条放掉）。
         */
        if (sender === String(this.selfId)) msg.isQuoteMe = true;
        try { this.onQuoteCheck(msg); } catch { /* 上层自己兜 */ }
      })
      .catch(() => { /* 查不到就当没引用她 */ });
  }

  /** 调一个 OneBot API：优先 HTTP（NapCat 最稳），没配 HTTP 再走 WS。 */
  async call(action, params = {}, timeoutMs = 15_000) {
    if (this.httpUrl) return this.#callHttp(action, params, timeoutMs);
    return this.#callWs(action, params, timeoutMs);
  }

  async #callHttp(action, params, timeoutMs) {
    try {
      const res = await fetch(`${this.httpUrl}/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...this.#headers() },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text();
      let json;
      try { json = JSON.parse(text); } catch { json = { raw: text }; }
      const ok = res.ok && (json.status === undefined || json.status === 'ok')
        && (json.retcode === undefined || json.retcode === 0);
      return { ok, data: json?.data, error: ok ? '' : (json?.message || json?.wording || `HTTP ${res.status}`) };
    } catch (err) {
      return { ok: false, error: err.name === 'TimeoutError' ? 'OneBot 超时' : err.message };
    }
  }

  #callWs(action, params, timeoutMs) {
    if (!this.connected || !this.ws) return Promise.resolve({ ok: false, error: 'OneBot 还没连上' });
    const echo = `c${++this.seq}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        resolve({ ok: false, error: 'OneBot WS 调用超时' });
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(echo, { resolve, timer });
      try {
        this.ws.send(JSON.stringify({ action, params, echo }));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(echo);
        resolve({ ok: false, error: err.message });
      }
    });
  }

  /** 发一条纯文本。 */
  send(key, text) {
    const isGroup = String(key).startsWith('group:');
    const id = String(key).split(':')[1];
    return this.call(isGroup ? 'send_group_msg' : 'send_private_msg', isGroup
      ? { group_id: idNum(id), message: [{ type: 'text', data: { text: String(text) } }] }
      : { user_id: idNum(id), message: [{ type: 'text', data: { text: String(text) } }] });
  }

  /**
   * ★ 2026-10-26：发一张图。
   *
   * `file` 三种写法（OneBot v11 通用）：
   *   · `base64://<...>` —— 最稳，NapCat 的 `enableLocalFile2Url:false` 也能用；
   *   · `https://...`   —— 让网关自己去下（要求网关能访问外网）；
   *   · 本地绝对路径     —— 只有网关开了 `enableLocalFile2Url` 才认。
   * 表情包 / 自拍都走这里，不碰 QQ 的商城表情（mface）那套元数据。
   */
  sendImage(key, file, { summary = '' } = {}) {
    const isGroup = String(key).startsWith('group:');
    const id = String(key).split(':')[1];
    const data = { file: String(file), ...(summary ? { summary: String(summary) } : {}) };
    return this.call(isGroup ? 'send_group_msg' : 'send_private_msg', isGroup
      ? { group_id: idNum(id), message: [{ type: 'image', data }] }
      : { user_id: idNum(id), message: [{ type: 'image', data }] });
  }

  /**
   * ★ 2026-11-01：发一条**语音**。
   *
   * 传进来的音频是火山 1.0 合成的 mp3（base64，不带 `base64://` 前缀）。
   * NapCat 会自己转成 QQ 的 amr/ptt —— 实测 2026-11-01：18KB 的 mp3，
   * NapCat 4.18.41 收下后 `get_msg` 能看到 `record` 段、`format=amr`，约 1 秒。
   *
   * 用 `base64://` 而不是本地路径：NapCat 可能开着 `enableLocalFile2Url:false`，
   * 和表情/截图走同一条稳路。
   */
  sendRecord(key, audioBase64, { timeoutMs = 30_000 } = {}) {
    const isGroup = String(key).startsWith('group:');
    const id = String(key).split(':')[1];
    const data = { file: `base64://${String(audioBase64 || '')}` };
    if (!data.file || data.file === 'base64://') {
      return Promise.resolve({ ok: false, error: '语音是空的' });
    }
    return this.call(isGroup ? 'send_group_msg' : 'send_private_msg', isGroup
      ? { group_id: idNum(id), message: [{ type: 'record', data }] }
      : { user_id: idNum(id), message: [{ type: 'record', data }] }, timeoutMs);
  }

  /**
   * ★ 2026-10-26：发 QQ 商城表情（mface）。三件套是从收到的 mface 段里原样存的，
   * 所以"她收藏了别人发的表情"之后能再发出去；不需要下载图片，也不怕商城表情的加密资源。
   */
  sendMface(key, face, { summary = '' } = {}) {
    const isGroup = String(key).startsWith('group:');
    const id = String(key).split(':')[1];
    const data = {
      emoji_package_id: Number(face?.emojiPackageId || 0),
      emoji_id: String(face?.emojiId || ''),
      key: String(face?.key || ''),
      summary: String(summary || face?.summary || ''),
    };
    if (!data.emoji_id || !data.key) return Promise.resolve({ ok: false, error: 'mface 缺 emoji_id/key' });
    return this.call(isGroup ? 'send_group_msg' : 'send_private_msg', isGroup
      ? { group_id: idNum(id), message: [{ type: 'mface', data }] }
      : { user_id: idNum(id), message: [{ type: 'mface', data }] });
  }

  /** "正在输入…"（部分网关支持；不支持就静默失败）。 */
  setTyping(key, on) {
    const isGroup = String(key).startsWith('group:');
    const id = String(key).split(':')[1];
    return this.call('set_input_status', isGroup
      ? { group_id: idNum(id), event_type: on ? 1 : 0 }
      : { user_id: idNum(id), event_type: on ? 1 : 0 }, 4000).catch(() => ({ ok: false }));
  }
}

module.exports = {
  OneBotClient, segsToText, cqToText, segsToImages, cqToImages, segsToMfaces, segsToRecords, cqToRecords, normalizeTime,
  stripNamePrefix,
};
