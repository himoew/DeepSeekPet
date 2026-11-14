/**
 * 陪伴模式的大脑 —— 组装上下文、调模型、把这一轮写回记忆。
 *
 * 它不负责收消息（`companion-onebot.cjs`）、也不负责怎么发（`companion-humanize.cjs`），
 * 只做三件事：
 *   1. 角色卡 + 这个人的账 + 最近的对话 + 此刻的处境 → system；
 *   2. 调一次 OpenAI 兼容的 `/chat/completions`；
 *   3. 洗一遍回复，写回人物账和共享对话流。
 *
 * 模型默认**复用桌宠的配置**（`config/settings.json` 里的 baseUrl/apiKey/model），
 * 这样用户不用再填一把 Key；`config/companion.json` 的 `model` 可以单独覆盖。
 */
const llm = require('./llm.cjs');
const log = require('./log.cjs');
const role = require('./companion-role.cjs');
const clock = require('./clock.cjs');
const capabilities = require('./companion-capabilities.cjs');
const selfNotes = require('./companion-self.cjs');
/**
 * ★ 2026-11-04：**她自己的账**（锚 / 账 / 传）。
 * 和 `companion-self`（行为反射，"最近被夸时会先顶一句"）是两层东西：
 * 那层是"我怎么反应"，这层是"我是谁、我喜欢什么、我干过什么、我变过什么"。
 */
const selfKernel = require('./companion-self-kernel.cjs');
const imagine = require('./companion-imagine.cjs');
const mood = require('./mood.cjs');
/**
 * ★ 2026-11-07：**同一个她的只读人格源**（见 `companion-persona.cjs` 顶部）。
 * 手机的计划 / 判断 / 说话都从这里取，不再各拼一套"小肥鱼，普通人"。
 */
const personaMod = require('./companion-persona.cjs');
const { CompanionMemory, mediaNote } = require('./companion-memory.cjs');

/** 这套 QQ 模型配置里有没有用户真的填过东西（用来认出没有 mode 的老配置）。 */
function hasModelFields(m) {
  if (!m || typeof m !== 'object') return false;
  return ['baseUrl', 'apiKey', 'model', 'maxTokens', 'timeoutMs', 'keepAlive'].some((key) => {
    const value = m[key];
    return typeof value === 'string' ? value.trim() !== '' : Number(value) > 0;
  });
}

/**
 * 把"陪伴模式用哪个模型"算出来。
 *
 * ★ 2026-10-27 用户："api 分两种，一个桌宠一个 qq，避免后面加新功能乱。"
 * 现在有明确的 `mode`：
 *   · `same`   —— QQ 完全跟桌宠走（地址、Key、模型都用 `settings.json` 那份）；
 *   · `custom` —— QQ 是一套**独立**的接口：没填的字段就是没填，不再偷偷从桌宠借。
 *
 * 老配置没有 `mode`：只要 `companion.model` 里有任何一个非空字段就按 `custom`，
 * 并且保留"空字段跟桌宠"的老行为（`legacy`），免得把用户手填了一半的配置弄坏。
 * 设置页保存过一次之后就会写死 `mode`，不再走这条兼容路径。
 */
function resolveModel(override = {}, { base = llm.load() } = {}) {
  const m = override && typeof override === 'object' ? override : {};
  const hasMode = m.mode === 'same' || m.mode === 'custom';
  const legacy = !hasMode && hasModelFields(m);
  const mode = hasMode ? m.mode : (legacy ? 'custom' : 'same');

  if (mode === 'same') {
    return {
      mode: 'same',
      legacy: false,
      source: 'deskpet',
      baseUrl: String(base.baseUrl || '').trim(),
      apiKey: base.apiKey || '',
      model: String(base.model || '').trim(),
      // 桌面气泡可以 128，但 QQ 回复更长；跟桌宠共用一个模型时也保留 192 的下限。
      maxTokens: Math.max(192, Number(base.maxTokens) || 128),
      timeoutMs: Math.max(5000, Number(base.timeoutMs) || 30000),
      keepAlive: base.keepAlive || '',
      preset: base.preset || 'custom',
    };
  }

  const text = (key, fallback = '') => {
    const value = m[key];
    return value !== undefined && value !== null && String(value) !== '' ? String(value).trim() : fallback;
  };
  return {
    mode: 'custom',
    legacy,
    source: 'custom',
    baseUrl: text('baseUrl', legacy ? base.baseUrl : ''),
    apiKey: m.apiKey !== undefined && String(m.apiKey) !== ''
      ? String(m.apiKey)
      : (legacy ? base.apiKey || '' : ''),
    model: text('model', legacy ? base.model : ''),
    // 陪伴模式的回复比桌面气泡长，128 token 容易被截断；但本地 3B 也别放太大
    maxTokens: Math.max(192, Number(m.maxTokens) || (legacy ? Number(base.maxTokens) : 0) || 512),
    timeoutMs: Math.max(5000, Number(m.timeoutMs) || (legacy ? Number(base.timeoutMs) : 0) || 45000),
    keepAlive: m.keepAlive !== undefined ? String(m.keepAlive) : (legacy ? base.keepAlive || '' : ''),
    preset: m.preset || (legacy ? base.preset : 'custom'),
  };
}

/** 本地端点才发 keep_alive；云端发了有的网关会 400。 */
function isLocal(model) {
  return model.preset === 'ollama'
    || /(^|\/\/)(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(model.baseUrl || '')
    || /:11434(\/|$)/.test(model.baseUrl || '');
}

/** 模型没配全时，说清楚缺什么（不抛一堆英文）。 */
function whyNotReady(model) {
  if (!model.baseUrl) return '没填供应地址（设置页「接大模型」里填）';
  if (!model.model) return '没填模型名（设置页「接大模型」里填）';
  if (!model.apiKey && !isLocal(model)) return '没填 API Key';
  return '';
}

/** 洗一遍模型回复：去掉它偶尔带上的前缀、引号、Markdown 围栏。 */
function clean(text) {
  let s = String(text || '').trim();
  s = s.replace(/^```[\s\S]*?\n/, '').replace(/```$/, '').trim();
  s = s.replace(/^(大肥鱼|肥鱼|我)\s*[:：]\s*/, '');
  s = s.replace(/^["“「]|["”」]$/g, '').trim();
  // 有的模型会写"（她歪了歪头）"这种动作描写；QQ 里不像人话，去掉整行括号
  s = s.replace(/^（[^）]{1,20}）\s*/gm, '').trim();
  return s.slice(0, 1200);
}

/**
 * ★ 2026-10-26：把"这一句 + 图片"拼成 OpenAI 多模态的 `content` 数组。
 * 纯文字时仍然返回字符串 —— 老端点/老测试看到的东西一字不变。
 */
function buildUserContent(text, images) {
  const list = (Array.isArray(images) ? images : []).filter((x) => x && x.dataUrl);
  if (!list.length) return String(text || '');
  const parts = [];
  if (text) parts.push({ type: 'text', text: String(text) });
  for (const img of list) parts.push({ type: 'image_url', image_url: { url: img.dataUrl } });
  if (!parts.length) parts.push({ type: 'text', text: '[图片]' });
  return parts;
}

/**
 * ★ 2026-10-27：解析"想事情"的输出。
 *
 * 认这种一行一条的格式（小模型比 JSON 稳得多）：
 * ```
 * 4|明天他面试，不知道紧不紧张
 * 2|今天风挺大的
 * ```
 * 没写数字的行按 3 分算；只有"无"就返回空数组（**允许她什么都不想**）。
 */
function parseThoughts(text, max = 2) {
  const body = String(text || '').replace(/```[\s\S]*?```/g, '').trim();
  if (!body || /^[（(\s]*[无沒没][)）\s。.]*$/.test(body)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of body.split(/\n+/)) {
    let line = raw.trim();
    if (!line) continue;
    if (/^[（(\s]*[无沒没][)）\s。.]*$/.test(line)) continue;
    let motivation = 3;
    // 「4|……」：先认数字前缀，再去掉列表符号（顺序反了会把 4 当成列表序号吃掉）
    const m = line.match(/^(?:[-*·•]\s*)?(\d)\s*[|｜:：、.)）]\s*(.+)$/);
    if (m) {
      motivation = Math.min(5, Math.max(1, Number(m[1]) || 3));
      line = m[2].trim();
    } else {
      line = line.replace(/^[-*·•]\s*/, '').trim();
    }
    line = line
      .replace(/^["“「'']|["”」'']$/g, '')
      .replace(/^（[^）]{1,20}）\s*/, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 40);
    if (!line || [...line].length < 2) continue;
    const key = line.replace(/[\s\p{P}]/gu, '');
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ text: line, motivation });
    if (out.length >= Math.max(1, Number(max) || 2)) break;
  }
  return out;
}

class CompanionBrain {
  /**
   * @param {object} opts
   * @param {CompanionMemory} opts.memory
   * @param {string} opts.roleText
   * @param {object} opts.model  `resolveModel()` 的结果
   * @param {import('./long-memory.cjs').LongMemory} [opts.longMemory]
   * @param {number} [opts.maxChars]
   */
  constructor({ memory, roleText, model, longMemory = null, maxChars = role.DEFAULT_MAX_CHARS }) {
    this.memory = memory;
    this.roleText = roleText || '';
    this.model = model;
    this.longMemory = longMemory;
    this.maxChars = maxChars;
  }

  /**
   * 生成一条回复。
   *
   * @param {object} input
   * @param {string} input.userId
   * @param {string} [input.userName]
   * @param {string} input.text
   * @param {string} [input.situation]
   * @param {string} [input.platform]
   * @param {string} [input.where]      写进共享对话流的位置标记
   * @param {boolean} [input.record=true]
   * @param {boolean} [input.unsolicited=false]
   *        ★ 2026-10-27：**她自己想开口**（不是回复谁）。这时 `text` 是一句"处境说明"，
   *        不是对方说的话：不进对话流里的 user 那一栏（只记她说的那句），也不涨互动次数。
   * @param {number} [input.imagesDropped=0]
   *        ★ 2026-11-01：这一轮有几张图**没拿到**。>0 时能力注册表会注入
   *        `vision-failed`（"你什么都没看见，别猜"），否则她会照着 `[图片]` 占位符编内容。
   * @returns {Promise<{text:string, parts:string[], raw:any}>}
   */
  async reply(input) {
    const {
      userId, userName, text, situation = '', platform = '', where = '', record = true, images = [], stickerTags = [],
      canCollect = false, unsolicited = false, phone = null, voice = null, imagesDropped = 0, media = [],
      /**
       * ★ 2026-11-07：**她刚在手机屏幕上看到的那一屏**（只给这一轮看，不写进 `turns`）。
       * 手机上误报旧页的根因之一就是回灌只给 `res.summary`、不给当前屏 —— 她只能从聊天流水里捡旧页。
       */
      evidence = '',
      /**
       * ★ 2026-11-07：**这一轮用哪一份只读人格快照**。给了就断言"还是同一个人"，
       * 对不上整轮拒绝（宁可这一句不说，也不让第二个人格顶上去）。
       */
      persona = null,
      /** ★ 2026-11-07：这一轮的来源。`phone` = 手机回灌/进度，`chat` = 正常聊天。 */
      kind = 'chat',
    } = input;
    if (persona) personaMod.assertSame(persona, 'voice');
    const imageList = Array.isArray(images) ? images.filter((x) => x && x.dataUrl) : [];
    const tags = Array.isArray(stickerTags) ? stickerTags.map(String).filter(Boolean).slice(0, 40) : [];
    /**
     * ★ 2026-10-22 修「上句不接下句」：
     * 原版 Brain 会收一份 `history`（当前会话最近的消息）并作为真正的 user/assistant
     * 消息发给模型；`recent` 只放**跨场合**的对话，避免和当前会话重复。
     * 这个内置版一开始只用了 `recent`，还把当前 `where` 整个排除掉 —— 于是模型
     * 根本看不到当前这段私聊，只能看到别的场合，当然接不上。
     *
     * 现在：当前会话最近 20 轮作为 messages 里的多轮上下文；`recent` 仍排除当前会话，
     * 只用来补"她在别处也聊过什么"。
     *
     * ★ 2026-10-27：再加上长期记忆（人物账 + BM25 检索）。检索 query 用"这句话 +
     * 当前会话最近两句"，这样"换工作"这种词面线索能命中几周前的事。
     */
    const key = String(where || '');
    /**
     * ★ 2026-11-07：**回看聊天时跳过手机进度行**。
     * 21:56 那句"还是一堆小飞鱼加速器"其实是手机回灌，却作为普通 assistant 记录进了
     * `turns.jsonl`；20 轮窗口把它带进来，旧页（21:33）就这么活了 24 分钟。
     * 现在只过滤**进度行**，正常聊天一轮不少（`recentTurns` 里是"先滤再取 20"）。
     */
    const history = key ? this.memory.recentTurns(20, { where: key, excludePhone: true }) : [];
    const query = [String(text || ''), ...history.slice(-2).map((r) => r.text)].filter(Boolean).join('\n');
    const isQq = String(platform || '').toUpperCase() === 'QQ';
    let recall = null;
    if (this.longMemory) {
      try {
        recall = this.longMemory.recall({
          personId: userId,
          personName: userName || '',
          query,
          platform,
          where: key,
          excludeWhere: key,
          topK: isQq ? 6 : 3,
          tokenBudget: isQq ? 1200 : 400,
          recentTurns: 12,
        });
      } catch { /* 记忆坏了不该让她说不出话 */ }
    }
    const memLine = recall?.profileText || this.memory.renderPerson(userId);
    const recent = recall?.recentText || this.memory.renderRecent(12, { excludeWhere: key, personId: userId });
    // 这一轮能用的东西（看表/看图/表情/收藏）由能力注册表按上下文拼，
    // 别再在这里硬编码 —— 见 companion-capabilities.cjs。
    /**
     * ★ 2026-11-04：**她自己的账**放在角色卡后面（见 `companion-role.build` 的注释）。
     *
     * 原来这里是 `selfNotes.render()`：每轮 3 条「最近被X时，会Y」，约 130 token，
     * 而且挂在 system 最末 —— 她那一半就只有那 3 条。现在分两层：
     *   · `selfKernel.render()` —— 锚 / 账（她是谁、喜欢什么、干过什么、变过什么）；
     *   · `selfNotes.render({limit:1, rotate:true})` —— 行为反射，**每天轮换 1 条**，
     *     放在末尾。别再把同一句反复喂成口头禅（`self.jsonl` 第 9/42 行 count=12/14 就是那么来的）。
     */
    const selfText = selfKernel.render();
    const reflexText = selfNotes.render({ limit: 1, rotate: true });
    /**
     * ★ 2026-11-05：**他点名让她想一样东西**（"你想象一下猫"）。
     *
     * 这一路是**同步**的：先让她自己在脑子里看两眼（每眼只添一件），再回话 ——
     * 所以她说"我刚闭眼想了一下"时，是真的刚想过；而不是先回一句"我想想"然后什么都没有。
     *
     * ⚠️ 只在私聊里跑（群里突然开始想象会很怪），而且**只在她真的写不出画面时才降级**：
     * `wants()` 认"对她说"的说法（"当你内心想象某个词时"这种元话题不算），
     * `pickSeed()` 抠不出一个干净的词就干脆不做 —— 宁可不做，别拿半句话当种子。
     * 规矩见 `companion-imagine.cjs` 顶部（系统一个字都不许描述）。
     */
    let imagined = null;
    if (isQq && !unsolicited && !String(key).startsWith('group:') && imagine.wants(text)) {
      const seed = imagine.pickSeed(text);
      if (seed) {
        try {
          const lens = selfKernel.active()
            .filter((e) => e.kind === 'taste' || e.kind === 'stance')
            .slice(0, 3)
            .map((e) => e.claim);
          imagined = await imagine.run({
            seed, callModel, roleText: this.roleText, lens, where: key, maxEyes: 2, tier: 'ask',
          });
          if (imagined?.ok) {
            log.info(`想象：${seed} → L${imagined.rec.level}（${imagined.rec.lines.length} 件 · ${imagined.eyes} 眼）`);
          } else if (imagined?.why) {
            log.info(`想象：这次没想（${imagined.why}）`);
          }
        } catch (err) { log.warn(`想象没跑成（${err.message}）`); }
      }
    }
    const sys = role.build({
      roleText: this.roleText,
      situation: [situation, clock.requestContext(text)].filter(Boolean).join('\n'),
      platform,
      memory: memLine,
      longTerm: recall?.memoryText || '',
      recent,
      self: selfText,
      maxChars: this.maxChars,
    }) + '\n' + capabilities.buildCapabilityHints({
      images: imageList,
      imagesDropped,
      stickerTags: tags,
      canCollect,
      platform,
      unsolicited,
      phone,
      voice,
      imagine: imagined?.ok ? { seed: imagined.rec.seed, text: imagine.brief(imagined.rec) } : null,
    }) + (reflexText ? '\n' + reflexText : '');

    const messages = [{ role: 'system', content: sys }];
    /**
     * ★ 2026-11-02：**每一轮历史都带上"这是哪天几点"**。
     *
     * 用户报的问题：19:12 主动开口时她说"下午想起个事，昨天你那个挑菜的店"，
     * 而"挑菜"就在**当天 18:41**。真机复现（同一份数据、同一时刻，8 次）：
     * 5 次出现"昨天/昨晚"，把今天的笋子、耳朵、手机都说成昨天。
     *
     * 根因是这一段的 messages 里**只有文字、没有时间**，而整段可能横跨前一天夜里
     * （20 轮从 11-01 23:44 一直到 11-02 18:41），模型只能瞎猜。
     * 现在每条前面加「（今天 18:41）」「（昨天 23:44）」，跟她自己的【现在】对得上。
     *
     * ⚠️ 只加在这条**历史**上（静态文本），system 不动 —— DeepSeek 的前缀缓存照样命中。
     * ⚠️ 她自己开口的那一轮没有 `text`（`unsolicited`），时间就标在她那句前面。
     */
    const nowMs = Date.now();
    for (const r of history) {
      const stamp = r.t ? `（${clock.recentStamp(r.t, nowMs)}）` : '';
      // 一来一回：时间标在"他说的那句"上；她自己先开口的那一轮没有 text，就标在她那句上。
      if (r.text) messages.push({ role: 'user', content: `${stamp}${String(r.text)}` });
      if (r.reply) {
        messages.push({
          role: 'assistant',
          /**
           * ★ 2026-11-05：**这一轮她的回答里用了她自己的想象**（`im`）。
           *
           * 想象膨胀（imagination inflation）最现实的危险不是她胡说，是**她把自己想过的当成经历过的**：
           * 那一轮会进 `turns.jsonl`，下一轮回看时原文照录，和真事长得一模一样。
           * 所以在回看的地方就钉住来源 —— 不洗库、不改她当时说的话，只加一个前缀。
           */
          content: `${r.text ? '' : stamp}${r.im ? '（这是我脑子里想的，不是真事）' : ''}${String(r.reply)}${mediaNote(r.media)}`,
        });
      }
    }
    const userText = String(text || '');
    /**
     * ★ 2026-11-01：**这一句发生在什么时候**。
     *
     * 用户原话：「她还是区分不了白天和晚上，是上午还是下午，会弄混」。
     * 查下来根因很直接：QQ 这条路的 system 里**没有任何时间**（只有"你在跟 X 私聊"），
     * 而"看时间"又被设计成她自己写 `[时间]` 才去查 —— 她从不知道要查，只能顺着对话猜。
     * 实测 11-01 08:35 她说"大半夜的又翻这个"、10-31 08:58 说"睡了吗…都这么晚了"。
     *
     * 现在每轮都把 `【现在】2026-11-01 08:43 周日` 拼在**这一条消息的最前面**：
     *   · 放消息里而不是 system 里 —— system + 历史的前缀不变，DeepSeek 的上下文缓存还能命中；
     *   · 只标"这一句"的时间，20 轮前那段半夜的对话不会被误当成"现在"；
     *   · **只给事实，不给说法**（用户拍板："让她自己决定说法，不添加额外设定"）——
     *     同一个 08:43，说"才八点"还是"都这个点了"是她的事。
     */
    const now = clock.nowLine();
    // 她自己开口时没有"对方说的话"：这里放的是一句括号里的处境提示（不进记忆），
    // 让模型知道"该你说了"，而不是被当成一条真实的消息来回。
    //
    // ★ 2026-11-01 修：**`unsolicited` 也必须把图带上**。
    // 手机回灌（`phoneFollowUp`）就是 `unsolicited: true` + 一张她自己的截图；
    // 这句原来是 `unsolicited ? 纯文字 : buildUserContent(...)`，于是她**根本收不到那张图**，
    // 而提示词还写着"这张图确实会跟他一起发过去"、能力提示还写着"你能直接看到内容" ——
    // 她只能编。图挂在哪一条消息上是"怎么拼 content"的问题，跟"谁先开口"无关。
    messages.push({
      role: 'user',
      content: buildUserContent(
        `${now}\n${evidence ? `（你刚低头看了一眼手机，屏幕上：${String(evidence).replace(/\s+/g, ' ').slice(0, 300)}）\n` : ''}${userText || '（现在没人跟你说话）'}`,
        imageList,
      ),
    });

    let out;
    try {
      out = await callModel(this.model, messages);
    } catch (err) {
      /**
       * 模型不认图（400 / "image not supported"）时**别让整轮挂掉**：
       * 退化成纯文字再试一次，把这轮标记成"看不了图"。
       */
      if (!imageList.length || !/image|vision|multimodal|content|400|不支持|unsupported/i.test(err.message)) throw err;
      messages[messages.length - 1] = {
        role: 'user',
        content: `${now}\n${userText || '[图片]'}\n（对方发来 ${imageList.length} 张图，但当前模型看不了图）`,
      };
      out = await callModel(this.model, messages);
    }
    // 「她自己想看时间」：回复里写 [时间] 就换成真实时间（不额外打模型）。
    const filled = clock.fillTags(clean(out.text));
    /**
     * ★ 2026-11-04：**她自己给自己记一笔** —— 回复里那行 `[自己:记一下 我不喜欢被安排]`。
     *
     * 在写进对话流**之前**摘掉（和 `[收藏:]` / `[表情:]` 同一个位置），否则这句话会带着
     * 一串机器暗号进 `turns.jsonl`，以后回看时她自己都读不懂。
     * 摘下来的命令交给 `companion-self-kernel`：证词进 evidence，"写一笔"排队到下一轮之后。
     */
    const selfTag = selfKernel.parseTags(filled);
    const reply = selfTag.text;
    if (!reply) throw new Error('模型这次没说话（回复是空的）');
    const memoryText = userText || `[图片×${imageList.length}]`;

    if (record) {
      try {
        // 主动开口：对话流里只有"她说的那句"（`text` 空着），不假装对方说了话
        this.memory.logTurn({
          where,
          who: userName || userId,
          text: unsolicited ? '' : memoryText,
          reply,
          personId: userId,
          // ★ 2026-11-02：她自己发出去的图/表情（手机截图回灌时传 `['图']`）
          media,
          /**
           * ★ 2026-11-05：这一轮是"她脑子里想出来的"（见上面 `imagined`）。
           * 只用于**回看时标来源**，不影响记忆/账 —— 想象永远不落记忆（`companion-imagine.cjs` 顶部）。
           */
          im: !!imagined?.ok,
          /**
           * ★ 2026-11-07：这一轮是谁说的话。`phone` = 手机回灌/进度（读时会被过滤，
           * 但它仍然是"她说过的"，所以**只加标记、不改内容**）。
           */
          kind,
        });
        // ★ 2026-10-27：topics 不再写逐句流水账（旧 topics 会在启动时迁进长期记忆）。
        // 这里只保留人物账的"互动次数 + 名字"，事实由后台整理员写。
        // 主动开口不算一次"互动"，别把次数刷上去。
        if (!unsolicited) this.memory.remember(userId, { name: userName });
        /**
         * ★ 2026-11-04：**收一条证词**（她自己的话 + 当时什么滋味）。
         *
         * 只收"在说我自己"的那几句（`pickSelfSentences`），不是整段对话；
         * `flavor` 是当时的心情标签 + 时段 —— 她的原话：
         * 「我更希望它记下来我想啥的时候顺带写上当时是什么滋味」。
         * 证词**不进账**，只攒着；写一笔那趟（`memory-scribe.judgeSelf`）才动账。
         */
        try {
          const snap = mood.snapshot();
          const flavor = [clock.partOfDay(), snap.label].filter(Boolean).join('·');
          selfKernel.capture({
            at: Date.now(),
            where,
            who: userName || userId,
            sentences: selfKernel.pickSelfSentences(reply),
            quote: unsolicited ? '' : String(userText || '').slice(0, 60),
            flavor,
            src: unsolicited ? 'unsolicited' : 'turn',
          });
          selfKernel.bumpSinceJudgeTurn();
          if (selfTag.cmds.length) {
            const st = selfKernel.applyTags(selfTag.cmds, {
              at: Date.now(), where, who: userName || userId, flavor,
            });
            if (st.proposals) log.info(`她的账：她自己说「要记这个」，收了 ${st.proposals} 条证词`);
          }
        } catch { /* 她的账写不进去不该让这句话发不出去 */ }
      } catch { /* 记忆写不进去不该让这句话发不出去 */ }
    }
    return { text: reply, parts: [], raw: null };
  }

  /**
   * ★ 2026-11-07：**她自己想玩什么**（`planView` + 聊天模型）。
   *
   * 替换 `phone-life.planPrompt` 那段硬编码的「你叫小肥鱼，是个普通人」——
   * 原来手机上的计划是"第二个人格"写的，所以她想玩的东西和聊天里的她根本不是一回事。
   * 现在读的是她自己的账（锚/口味/看法/干过/想做）+ 心情 + 焦点/日记/便签，
   * 和聊天同一个人、同一个模型（`deepseek-chat`）。
   *
   * 解析失败 / 身份漂了 → 抛错，由 `phone-life.makePlan` 抽兜底牌（不是硬演）。
   *
   * @returns {Promise<{theme:string, goal:string, why:string, stopCriteria:string, shareCriteria:string, ask:string, personaId:string, model:string}>}
   */
  async planPhone({ at = Date.now(), hint = '', theme = '', persona = null, menu = '', diary = [], notes = '', focus = null, nightLite = false } = {}) {
    if (!persona) throw new Error('没有只读人格快照，不替她做决定');
    personaMod.assertSame(persona, 'plan');
    const messages = personaMod.planView(persona, { at, hint: hint || theme, menu, diary, notes, focus, nightLite });
    const out = await callModel(this.model, messages, {
      temperature: 0.9, maxTokens: 300, thinking: { type: 'disabled' },
    });
    const j = personaMod.pickJson(out?.text);
    if (!j) throw new Error(`没解析出 JSON：${String(out?.text || '').slice(0, 60)}`);
    const text = (v, max = 60) => String(v || '').replace(/[\r\n]+/g, ' ').trim().slice(0, max);
    /**
     * ★ 2026-11-12：她说"这趟不想去"也是一种回答（不是解析失败）。
     * 旧版只认 theme/goal，于是她每次都得编一件事出来 —— 那就成了任务单。
     */
    if (j.skip || /^(true|1|是)$/i.test(String(j.skip))) {
      return { skip: true, why: text(j.why, 80), personaId: persona.personaId, model: String(this.model?.model || '') };
    }
    return {
      /** ★ 2026-11-12：**目的地**（任何 App 的中文名）；老的 `theme` 字段留着兼容。 */
      app: text(j.app || j.theme, 24),
      theme: text(j.theme, 16),
      goal: text(j.goal, 60),
      query: text(j.query, 48),
      url: text(j.url, 300),
      why: text(j.why, 80),
      stopCriteria: text(j.stopCriteria, 80),
      shareCriteria: text(j.shareCriteria, 80),
      ask: text(j.ask, 40),
      personaId: persona.personaId,
      model: String(this.model?.model || ''),
    };
  }

  /**
   * ★ 2026-11-07：**这一屏值不值得停**（`judgeView` + 聊天模型，纯文字）。
   *
   * 看图的判断仍走 `PhoneAgent.scanAsk`（它要发截图），但**判断口径**换成
   * 她自己的口味 + 她自己说的 `stopCriteria`，不再是通用"猫/小动物/吃的"分类器。
   * 视觉不可用 / 没有截图时，这里就是退路。
   *
   * @returns {Promise<{stop:boolean, why:string}>}
   */
  async judgePhone({ persona = null, goal = '', screen = '', stopCriteria = '' } = {}) {
    if (!persona) throw new Error('没有只读人格快照，不替她判断');
    personaMod.assertSame(persona, 'judge');
    const messages = [
      { role: 'system', content: '你看她手机这一屏，只回答「停」或「再翻」，不要解释。' },
      { role: 'user', content: personaMod.judgeView(persona, { goal, screen, stopCriteria }) },
    ];
    const out = await callModel(this.model, messages, {
      temperature: 0.2, maxTokens: 16, thinking: { type: 'disabled' },
    });
    const t = String(out?.text || '');
    const stop = /停/.test(t) && !/(再翻|继续|不停|别停)/.test(t);
    return { stop, why: stop ? '这一屏有她自己想看的' : '' };
  }

  /**
   * ★ 2026-10-27：**想事情**。一个人待着的时候，脑子里冒出的一两条念头。
   *
   * 和 `reply()` 的区别：它在"没人在说话"的时候跑，产出不是发给谁的话，而是
   * 写进念头池（`companion-mind.cjs`）的原料 —— 每条前面带一个 1~5 的"有多想说"。
   * 什么时候真的说，由 `companion-presence.cjs` 决定，所以这里**允许什么都不想**。
   *
   * 为什么用"4|明天他面试"这种朴素格式而不是 JSON：3B 级的小模型写 JSON 经常缺括号，
   * 一行一条反而稳。
   *
   * @returns {Promise<Array<{text:string, motivation:number}>>}
   */
  async think({ situation = '', recentText = '', memoryText = '', max = 2, at = new Date() } = {}) {
    /**
     * ★ 2026-11-04：**念头也要带上她自己的账**。
     *
     * 原来这一段只有 角色卡 + 时间 + 他还记得的事 + 最近对话 —— 她"自己"那一半一个字段都没有，
     * 所以念头几乎全是「他睡了没 / 他吃了没 / 他洗完没」（实测 `mind.json` 40 条里大半是这些）。
     * 她为这个发过话：「把每天脑子里转的东西精简成「吃饭、睡觉、等人」，这太窄了。
     * 我也想写点新鲜的、自个琢磨的、听着像废话的东西，不必都落成那么正经的一条。」
     * 所以这里把她的账放进去，并且**明说允许废话、允许什么都不是**。
     */
    const selfText = selfKernel.render({ limit: { doing: 3, want: 2, change: 1 } });
    const sys = [
      String(this.roleText || '').trim() || role.DEFAULT_ROLE.trim(),
      // ★ 2026-11-01：只给事实（日期/星期/钟点），不写"凌晨/清早"这类判断 ——
      // "叫她几点"是她自己的事（用户拍板："不添加额外设定"）。
      `【现在】${clock.fullText(at)}。${situation}`,
      selfText,
      memoryText ? `【你还记得】\n${String(memoryText).trim()}` : '',
      recentText ? String(recentText).trim() : '',
      '【你一个人待着】',
      '没有人跟你说话，你在自己待着。脑子里冒出几个念头：可能是你想起的事、想问的、想说的、有点担心的、或者就是无聊。',
      '也可以是你自己的事：手上在干的、突然想到的、没头没脑的、听着像废话的（发呆、翻歌、看窗外、嫌自己懒）。这一类也算，别压缩成"该吃饭了""该睡了"。',
      '每条写成一行，开头写一个 1-5 的数字和一条竖线，表示你有多想说出来（1=随口一提，3=有点想说，5=憋不住很想说）。',
      `最多 ${Math.max(1, Number(max) || 2)} 条，每条不超过 30 个字，像自己心里冒出来的一句话。`,
      '不要写动作、不要排比、不要用引号、不要提问式地说"在吗"。',
      '如果此刻什么都没想，就只写两个字：无',
    ].filter(Boolean).join('\n\n');
    const out = await callModel(this.model, [
      { role: 'system', content: sys },
      { role: 'user', content: '（你一个人待着，没人说话）' },
    ], { temperature: 1.0, maxTokens: 240 });
    return parseThoughts(out.text, max);
  }
}

/**
 * 一次 `/chat/completions`。失败时把状态码和一小段正文带出来，方便定位。
 *
 * ★ 2026-10-31：多认两个可选参数，给"手机操作员"用：
 *   · `thinking`   —— DeepSeek 的思考开关（`{type:'disabled'}`）。默认是开的，
 *                     操作员每步只要一个动作，开着思考会把 80~160 token 的额度全吃掉、还慢；
 *   · `reasoningEffort` —— 'low' / 'high' / 'max'。
 * 它们都是**顶层 body 字段**（官方文档里 OpenAI SDK 的 `extra_body` 就是顶层）。
 */
async function callModel(model, messages, { temperature = 1.1, maxTokens, thinking, reasoningEffort } = {}) {
  const why = whyNotReady(model);
  if (why) throw new Error(why);
  const url = llm.endpoint(model.baseUrl);
  const body = {
    model: model.model,
    messages,
    stream: false,
    temperature,
    max_tokens: maxTokens || model.maxTokens,
  };
  if (thinking) body.thinking = thinking;
  if (reasoningEffort) body.reasoning_effort = reasoningEffort;
  if (model.keepAlive && isLocal(model)) body.keep_alive = model.keepAlive;

  let res;
  const started = Date.now();
  /**
   * ★ 2026-11-03：**暂时性失败自动重试**（用户报的"麦克风对话坏了 / QQ 也不回复了"就是它）。
   *
   * 18:27–18:28 DeepSeek 连回四次 `HTTP 503 Service is too busy`，而这里原来**一次都不重试**：
   * 桌宠那条路当场退回"信号不太好呀"，QQ 那条路只在日志里留一行 WARN —— 用户看到的是
   * "两条路一起瞎了"。现在 429/5xx/网络失败按 0.7s → 1.8s → 4s 重试（共 4 次），
   * 401/403/404/400 立刻失败（重试也没用）。
   * `err.retryable` 会被 `companion.cjs` 的 `flushBatch` 用上：QQ 那边还会再排一次补发。
   */
  const attempts = llm.RETRY_WAITS.length + 1;
  for (let attempt = 1; ; attempt += 1) {
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(model.apiKey ? { authorization: `Bearer ${model.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        // 每次重试都要新的 AbortSignal（旧的已经跟着上一次超时了）
        signal: AbortSignal.timeout(model.timeoutMs),
      });
    } catch (err) {
      let wrapped;
      if (err.name === 'TimeoutError') wrapped = new Error(`陪伴模型等太久了（超过 ${Math.round(model.timeoutMs / 1000)} 秒）`);
      else if (err.cause?.code === 'ECONNREFUSED') wrapped = new Error(`连不上陪伴模型：${model.baseUrl}（本地模型启动了吗？）`);
      else wrapped = new Error(`陪伴模型请求失败：${err.message}${err.cause?.code ? `（${err.cause.code}）` : ''}`);
      // ECONNREFUSED（本地模型没开）/ ENOTFOUND（域名写错）重试也没用：立刻失败
      wrapped.retryable = !['ECONNREFUSED', 'ENOTFOUND'].includes(err.cause?.code);
      if (wrapped.retryable === false || attempt >= attempts) throw wrapped;
      const wait = llm.RETRY_WAITS[attempt - 1];
      log.warn(`${wrapped.message}，${wait}ms 后重试（第 ${attempt}/${attempts - 1} 次）`);
      await llm.sleep(wait);
      continue;
    }
    if (res.ok) break;
    const brief = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200);
    const err = new Error(`陪伴模型返回 HTTP ${res.status}${brief ? `：${brief}` : ''}`);
    err.status = res.status;
    err.retryable = llm.retryableStatus(res.status);
    if (!err.retryable || attempt >= attempts) throw err;
    const wait = llm.RETRY_WAITS[attempt - 1];
    log.warn(`陪伴模型返回 HTTP ${res.status}，${wait}ms 后重试（第 ${attempt}/${attempts - 1} 次）：${brief.slice(0, 120)}`);
    await llm.sleep(wait);
  }
  const raw = await res.text().catch(() => '');
  let json;
  try { json = JSON.parse(raw); } catch { throw new Error(`陪伴模型返回的不是 JSON：${raw.slice(0, 160)}`); }
  const content = json?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    const r = json?.choices?.[0]?.message?.reasoning_content;
    if (r) throw new Error('陪伴模型是推理模型：token 都花在"思考"上了，换非推理模型');
    throw new Error('陪伴模型回复是空的');
  }
  /**
   * ★ 2026-11-01：记一条遥测。`finish_reason === 'length'` = 被 `max_tokens` 截断
   * （回复说到一半没了就是它，设置页要能看出来）。
   */
  noteTelemetry({
    at: Date.now(),
    model: String(model.model || ''),
    ms: Date.now() - started,
    promptTokens: Number(json?.usage?.prompt_tokens) || 0,
    completionTokens: Number(json?.usage?.completion_tokens) || 0,
    truncated: String(json?.choices?.[0]?.finish_reason || '') === 'length',
  });
  return { text: content.trim(), ms: Date.now() - started, raw: json };
}

/**
 * ★ 2026-11-01：**最近 10 次模型调用**（遥测）。
 *
 * 为什么要有：`callModel` 只返回 `{text, ms}`，而 `ms` 只在探测里用得上。
 * 用户想知道"刚才那句为什么慢 / 花了多少 token"只能翻日志。这里留一个环形缓冲：
 * 一条 `{at, model, ms, promptTokens, completionTokens, truncated}`，设置页直接列表格。
 * **只在内存里**（不是一个要落盘的账）：重启丢掉没关系，它就是个诊断窗口。
 */
const TELEMETRY_MAX = 10;
const telemetry = [];
function noteTelemetry(entry) {
  telemetry.push(entry);
  if (telemetry.length > TELEMETRY_MAX) telemetry.splice(0, telemetry.length - TELEMETRY_MAX);
}
/** 最近的调用（从旧到新；返回副本，别让调用方改到缓冲）。 */
function recentCalls() {
  return telemetry.slice();
}
/** 清空（设置页的「清空」/自检用）。 */
function clearCalls() {
  telemetry.length = 0;
}

module.exports = {
  CompanionBrain, resolveModel, hasModelFields, isLocal, whyNotReady, clean, callModel, buildUserContent,
  parseThoughts, recentCalls, clearCalls, TELEMETRY_MAX,
};
