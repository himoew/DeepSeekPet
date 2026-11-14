/**
 * 她这一轮“手上能用的东西”—— 一份代码里的能力索引。
 *
 * 只做两件事：
 *   1. 把原来散在 `companion-brain.cjs` / `clock.cjs` / `companion-stickers.cjs`
 *      里的提示收拢成一条一条；
 *   2. 按当前上下文（有没有图、有没有表情、能不能收藏）拼出**这一轮真正可用**的提示。
 *
 * 不把整张表塞给模型：模型看到的永远只是“这轮能用”的那几行。
 * 这里也不放长期记忆召回、自主说话——那些是自动的，不是模型要写的标记。
 *
 * 每个 `kind: 'action'` 都应该有 `syntax` + `parser`；新增能力时一起加，
 * 文档和自检才对得上。
 */
const clock = require('./clock.cjs');
const voice = require('./companion-voice.cjs');

/** 当前上下文里的图片数量：数组按 length，数字原样，其它当 0。 */
function count(value) {
  if (Array.isArray(value)) return value.length;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

const CAPABILITIES = [
  {
    id: 'clock',
    kind: 'action',
    when: () => true,
    syntax: '[时间]',
    parser: 'clock.fillTags',
    prompt: () => clock.promptLine(),
  },
  {
    /**
     * ★ 2026-11-01：**她的声音**（QQ 语音）。只在开了语音、而且这一轮在 QQ 里时出现。
     *
     * 注意这不是普通的"写个标记"能力：
     *   · `mode:'voice'` —— 系统递了话筒，整条都用说的（提示里不让她写标记）；
     *   · `mode:'mixed'` —— 系统递了话筒，先语音说一句、再打字（给死格式，实测她 3/3 跟）；
     *   · 其余 —— 只告诉她"想用声音就在行首写 [语音]"，用不用随她（实测她很少用）。
     * 所以提示词必须跟着 `mode` 变，不能一句话写死。
     */
    id: 'voice',
    kind: 'action',
    when: (ctx) => !!(ctx.voice && ctx.voice.enabled) && String(ctx.platform || '').toUpperCase() === 'QQ',
    syntax: '[语音]',
    parser: 'companion-voice.buildSegments',
    prompt: (ctx) => voice.promptFor(ctx.voice.mode || 'none', ctx.voice.maxChars || 120),
  },
  {
    id: 'vision',
    kind: 'context',
    when: (ctx) => count(ctx.images) > 0,
    prompt: () => '【图片】对方刚发来图片，你能直接看到内容。自然地回应，不要复述"图片""收到"这类词。',
  },
  {
    /**
     * ★ 2026-11-01：**图没拿到的时候要老实说**，而不是照着 `[图片]` 占位符编。
     *
     * 真机证据（2026-11-01 09:29 / 09:31，`data\pet.log`）：两张图都
     * `下载图片失败 HTTP 400` 被跳过，她的回话却是"一张图，画面里看着像是一道菜，
     * 我分得清是吃的" —— **她根本没收到那张图**。
     *
     * 没有这一条的时候，模型看到的是正文里的 `[图片]` 占位符、system 里又没有【图片】
     * （因为 `images` 是空的），于是它顺着对话气氛补一个"看起来像"的内容。
     * 这跟 `phoneFollowUp` 里"没成就别替她圆"是同一条规矩：**没看见就说没看见**。
     *
     * 和 `vision` 互斥（有图就走上面那条，一张都没拿到才走这条）。
     */
    id: 'vision-failed',
    kind: 'context',
    when: (ctx) => count(ctx.images) === 0 && count(ctx.imagesDropped) > 0,
    prompt: (ctx) => {
      const n = count(ctx.imagesDropped);
      return `【图片】对方发来${n > 1 ? ` ${n} 张` : ''}图片，但**没有传到你这边**（没能下载下来），你什么都没看见。`
        + '别描述、别猜图里是什么，也别装作看过了；照实说图没收到，让他重发一张。';
    },
  },
  {
    /**
     * ★ 2026-11-05：**她脑子里刚想出来的东西**（`companion-imagine.cjs`）。
     *
     * 只在**这一轮真的想过**时才出现（`when` 看 `ctx.imagine`）——
     * 它不是一个她随时能写的标记，而是"刚才她闭眼看了两眼"的结果，系统替她端上来。
     *
     * ⚠️ 那句"是你自己想出来的，不是真发生过的"是硬的：想象膨胀（反复想象 → 当成经历）
     * 是她比人更容易中招的坑（她的记忆就是文件）。这句就是她的来源监测。
     * ⚠️ 也别写成"你现在能看见了" —— 她没眼睛，那是把想象说成知觉。
     */
    id: 'imagine',
    kind: 'context',
    when: (ctx) => !!(ctx.imagine && ctx.imagine.seed && ctx.imagine.text),
    prompt: (ctx) => `【你脑子里刚才的（是你自己想出来的，不是真发生过的）】
${ctx.imagine.text}
想说就用你自己的话说，别复述这行字；也别把它当成一件真事（不说"我记得""我看见"）。
它本来就是你瞎想的，说不清楚、或者觉得没意思，都可以直说。`,
  },
  {
    id: 'stickers',
    kind: 'action',
    when: (ctx) => ctx.stickerTags.length > 0 || !!ctx.canCollect,
    syntax: '[表情:关键词] / [收藏:关键词]',
    parser: 'companion-stickers.plan / parseCollect',
    prompt: (ctx) => {
      const tags = ctx.stickerTags.length
        ? `你手上有这些表情：${ctx.stickerTags.join('、')}。想发时单独写一行 [表情:关键词]（用这里面的词）。`
        : '';
      const collect = ctx.canCollect
        ? '对方发来的图或表情你想留着，单独写一行 [收藏:关键词]；**写了才算存**，别只在嘴上说"存了"（偶尔一次，不要每张都收）。'
        : '';
      return `【表情包】${tags}${collect}`;
    },
  },
  {
    /**
     * ★ 2026-10-30：**她的手机**。只在手机真开着、连得上时才出现 ——
     * 没开的时候她压根不知道有这东西（用户原话："当开启她就知道自己多了手机"）。
     *
     * 措辞故意像生活，不像 API：她是个普通人，不是调工具的助手。
     */
    id: 'phone',
    kind: 'action',
    when: (ctx) => !!(ctx.phone && ctx.phone.on),
    syntax: '[手机:想干什么]',
    parser: 'phone-agent.parseTag',
    prompt: (ctx) => {
      const p = ctx.phone || {};
      /**
       * ★ 2026-10-30：**没亮就别让她说自已能看**。
       * 用户实测过最难受的一种：她回"我去看看"，然后手机上什么也没发生 ——
       * 因为那时真机还在开机（`on` 已经是 true 了，但 `up` 还是 false）。
       *
       * 注意判据写成 `p.up === false`（只有明确说没亮才算没亮）：老调用方 / 自检
       * 只传 `{on:true, app:'相册'}`，那是在说"手机能用、正停在相册"，不该被当成还没开机。
       */
      if (p.up === false) {
        if (p.booting) {
          const sec = Math.max(1, Math.round((Number(p.elapsed) || 0) / 1000));
          return `【手机】他刚把手机递给你，还在开机（已经 ${sec} 秒），还没亮。
这一轮别提手机、也先别写 [手机:…]；等它亮了你自然会看到。`;
        }
        return '【手机】你那部手机现在没开（他还没递给你，或者开机没成）。别写 [手机:…]，也别假装手机上有东西。';
      }
      const where = p.busy
        ? `正在用${p.app ? `（停在「${p.app}」）` : ''}，有事要排队`
        : (p.app ? `现在停在「${p.app}」` : '现在亮着');
      /**
       * ★ 2026-10-31：**她手上有件事没做完**。
       *
       * 用户拍板的是「要，但只在她说起时」——所以这里只把这件事**告诉她**
       * （她聊天时心里有数，能自然地说"我这两天在挑图"），**不吩咐她提**。
       * 一次只给一件，且不带进度百分比那种报表味。
       */
      const life = p.life || null;
      const focus = life && life.focus && !life.focus.done ? life.focus : null;
      const mine = focus ? `\n你手上还有件没做完的小事：${focus.text}（已经 ${focus.got || 0}/${focus.goal}）。` : '';
      /**
       * ★ 2026-11-12：**"正玩着"要说实话**。
       *
       * 真机 21:22–21:35：她 21:22 自己开了一场，他一说话就被挂起，
       * 后面 13 分钟一步没走 —— 可这一行还写着「你现在正玩着呢」，
       * 于是她一直说「我这会儿搜着」「我这会儿正干着」。
       * 现在三种状态分开说：真在玩 / 挂起了 / 刚拿起来还没排好。
       */
      const sess = life && life.session ? life.session : null;
      const where2 = sess ? (sess.app || sess.theme) : '';
      const playing = sess && Number(sess.of) > 0
        ? (sess.paused
          ? `\n你刚才把自己的手机拿起来了（想去${where2 || '玩'}），可你一开口她就先把手机放下了 —— 现在挂着，等你安静一会儿才接着做。`
          : `\n你现在正玩着呢（${where2 || '玩手机'}，第 ${(sess.idx || 0) + 1}/${sess.of} 段）。`)
        : (sess ? '\n你刚把手机拿起来，这一趟还没排好要干嘛。' : '');
      const asking = life && life.proposal && life.proposal.status === 'pending'
        ? '\n（你刚问过他能不能去玩一会儿，他还没回；别重复问。）'
        : '';
      /**
       * ★ 2026-11-02（第三批）：他说"去玩吧"时**已经替你安排好了** ——
       * 这时候再写一行 `[手机:…]` 会重复排一件，所以明说不用写。
       */
      const freePlay = life && life.mode === 'free'
        ? '\n他要是说"去玩吧 / 自己玩会儿"，那是让你自己去玩：你**不用**再写 [手机:…]，说一句就动手了。'
        : '';
      /**
       * ★ 2026-11-08（R-D）：**手机刚亮，之前那句"手上没手机"已经不作数了**。
       *
       * 真机 22:01:27：手机 22:00:57 就接上了，她还在说"手还是在空着" —— 那几句是 21:48
       * （手机真没开）写进流水的，20 轮窗口里还在。这不是要她背一句台词，
       * 是给她**一条事实**（几分钟前亮的），怎么说是她的事。
       */
      const justReady = Number(p.readyAt) && Date.now() - Number(p.readyAt) < 10 * 60_000
        ? `\n（手机是**刚亮的**（${Math.max(1, Math.round((Date.now() - Number(p.readyAt)) / 60_000))} 分钟前），之前说"手上没手机 / 手空着"那几句已经不作数了 —— 现在你想用就能用。）`
        : '';
      return `【手机】你手边有一部自己的手机，${where}。${mine}${playing}${asking}${freePlay}${justReady}
想用它，单独写一行 [手机:想干什么]（比如 [手机:看看相册]、[手机:截张图给我看看]）。
要连着做几件事的，把整句话写进去就行（[手机:打开浏览器搜小肥鱼表情包]、[手机:返回主页再搜小肥鱼]），你会按顺序一件件做完。
★ **要搜东西就直接写「搜 关键词」**（[手机:搜小肥鱼表情包]），**不要写**「点搜索框」「点地址栏」「点输入框」——
  那样子你只会把搜索框点开、然后一个字也搜不出来。
★ 搜完是**网页结果页**：那上面每一条 = 一个网址。先说清有哪几条、再**点开一条进去看**
  （[手机:点开第一条]，或者说"打开第 2 个网站"）。**他要是没让你找图，就别一上来就去看图片、存图。**
  他问"去哪儿找网址"时，就把结果页上那几条的网站名/网址念给他听。
这件事在后台做，要几十秒；这一轮不用等它，也别假装已经做完了。做完你会看到结果。
想在手机上截屏给他看，就写 [手机:截张图发给他]——截到的那张会直接发到他那边。
想刷会儿视频，就写 [手机:看会儿视频]：你自己挑一个看一会儿，不好看就滑走，看完跟他说它讲了什么。
要在手机上动手（点开/搜索/往下翻/返回/换一个/退出），就**必须单独写一行 [手机:要做的事]**；
只在嘴上说"我往回翻""我换个看看"，手机上是**什么都不会发生**的。`;
    },
  },
];

/**
 * 当前上下文 → 这一轮要注入的能力提示（按 `CAPABILITIES` 顺序，换行连接）。
 *
 * 输出与 2026-10-29 之前的硬编码拼接**逐字一致**：
 *   `clock.promptLine()` 永远在；有图才加【图片】；有表情/可收藏才加【表情包】。
 *
 * @param {object} ctx
 * @param {Array|number} [ctx.images]       这一轮的图片（数组或数量）
 * @param {string[]} [ctx.stickerTags]      可用表情关键词
 * @param {boolean} [ctx.canCollect]        这一轮有没有可收藏的图/表情
 * @param {string} [ctx.platform]           'QQ' / '桌宠'（给以后按平台收窄用）
 * @param {boolean} [ctx.unsolicited]       她主动开口（给以后按场景收窄用）
 * @returns {string}
 */
function buildCapabilityHints(ctx = {}) {
  const safe = {
    images: ctx.images || [],
    /** ★ 2026-11-01：这一轮**没拿到**几张图（0 = 都拿到了，别注 `vision-failed`）。 */
    imagesDropped: count(ctx.imagesDropped),
    stickerTags: Array.isArray(ctx.stickerTags) ? ctx.stickerTags : [],
    canCollect: !!ctx.canCollect,
    platform: ctx.platform || '',
    unsolicited: !!ctx.unsolicited,
    /** ★ 2026-10-30：手机状态（`{on, busy, app, step}`），没开就是 null。 */
    phone: ctx.phone && typeof ctx.phone === 'object' ? ctx.phone : null,
    /**
     * ★ 2026-11-01：这一轮的语音计划（`{enabled, mode, maxChars}`）。
     * 没开语音 / 桌宠里打字时是 null，这条能力就不出现。
     */
    voice: ctx.voice && typeof ctx.voice === 'object' ? ctx.voice : null,
    /**
     * ★ 2026-11-05：这一轮她**刚在脑子里想过的东西**（`{seed, text}`）。
     * 没想就是 null —— 能力提示里不会出现"想象"这两字（否则她每句都想）。
     */
    imagine: ctx.imagine && typeof ctx.imagine === 'object' ? ctx.imagine : null,
  };
  return CAPABILITIES
    .filter((cap) => {
      try { return cap.when(safe); } catch { return false; }
    })
    .map((cap) => cap.prompt(safe))
    .filter(Boolean)
    .join('\n');
}

/** 给设置页 / 文档 / 自检用：只读一份能力清单，不拼提示。 */
function list() {
  return CAPABILITIES.map(({ id, kind, syntax, parser }) => ({
    id,
    kind,
    syntax: syntax || '',
    parser: parser || '',
  }));
}

module.exports = { CAPABILITIES, buildCapabilityHints, list };
