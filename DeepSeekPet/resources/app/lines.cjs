/**
 * 台词库 —— 大肥鱼说过的所有话都在这个文件里。
 *
 * 想让它说话不一样，改这里就够了，不用碰任何逻辑。每条都是
 * `{ text, actions }`：`actions` 会先做表情/动作，再把 `text` 一个字一个字打出来。
 *
 *   actions 可用 —— 表情：neutral happy wink love shy surprised angry sad sleepy thinking
 *                  动作：stand jump hop look turn nod shake spin sit sleep dizzy walk run
 *
 * 每条 `text` 建议 6–20 个字：气泡是 20 字/秒打出来的，太长会拖住它。
 *
 * 同一个数组里的台词是"抽签不重复"的：一轮里每条都会轮到，轮完才重新洗牌，
 * 所以不会出现同一句话连着来两次。想加台词就直接往数组里加。
 */

module.exports = {
  /** 开机问候，按时间段分。每天第一次见你时说的话。 */
  hello: {
    morning: [
      { text: '早呀。今天也一起吧。', actions: ['happy'] },
      { text: '唔……你起得真早。', actions: ['sleepy'] },
      { text: '早上好。我先醒一醒。', actions: ['stand'] },
      { text: '早安。今天想做什么呀?', actions: ['happy'] },
      { text: '早安,{name}。', actions: ['love'] },
    ],
    afternoon: [
      { text: '下午好。歇一会儿吧?', actions: ['happy'] },
      { text: '你终于来啦。', actions: ['love'] },
      { text: '午后有点困呢……', actions: ['sleepy'] },
      { text: '嗯,我在的。', actions: ['nod'] },
    ],
    evening: [
      { text: '晚上好呀。', actions: ['happy'] },
      { text: '今天辛苦啦。', actions: ['love'] },
      { text: '天黑了呢。', actions: ['look'] },
      { text: '晚上好。要不要聊聊天?', actions: ['happy'] },
    ],
    night: [
      { text: '这么晚还不睡?', actions: ['surprised'] },
      { text: '夜里的风好凉。', actions: ['look'] },
      { text: '……你还在啊。', actions: ['shy'] },
      { text: '唔,我陪你到困为止。', actions: ['sleepy'] },
      { text: '{name},这么晚还不睡?', actions: ['sleepy'] },
    ],
  },

  /** 你离开很久之后第一次碰它。会先出这句，再出反应。 */
  returnFromAway: [
    { text: '你回来啦!', actions: ['happy'] },
    { text: '……好久不见。', actions: ['shy'] },
    { text: '我一直在等你哦。', actions: ['love'] },
    { text: '去哪了呀?', actions: ['thinking'] },
    { text: '唔,总算回来了。', actions: ['happy'] },
    { text: '{name},你去哪了呀。', actions: ['shy'] },
  ],

  /**
   * **你回来时它主动招呼**（系统空闲归零 / 解锁屏幕）——这是新加的一条：
   * 以前的"你回来啦"得**你先碰它**才会说。
   */
  youBack: [
    { text: '你回来啦。', actions: ['happy'] },
    { text: '{name},你回来啦。', actions: ['love'] },
    { text: '唔……你回来啦。', actions: ['shy'] },
    { text: '（抬头看你）', actions: ['look'] },
    { text: '我一直在哦。', actions: ['happy'] },
  ],

  /** 系统改成**电池**供电时念一句（一小时最多一次）。 */
  battery: [
    { text: '快没电了,记得插上。', actions: ['surprised'] },
    { text: '唔,在用电池了哦。', actions: ['look'] },
    { text: '记得插电呀。', actions: ['nod'] },
  ],

  /* ---------- 记忆：只有"认识你"才说得出来的话（见 memory.cjs） ---------- */

  /** **认识第几天**（只在第 7/30/100/180/365 天说一次）。 */
  memoryMilestone: [
    { text: '今天是我们认识第 {days} 天。', actions: ['happy'] },
    { text: '认识 {days} 天啦。', actions: ['love'] },
    { text: '唔……第 {days} 天了,真快。', actions: ['shy'] },
  ],

  /** 隔了几天没见（≥3 天）。**不是抱怨**，只是它记得。 */
  memoryAway: [
    { text: '好久不见,{name}。', actions: ['happy'] },
    { text: '唔……{days} 天了,你去哪了。', actions: ['look'] },
    { text: '我一直在等你哦。', actions: ['love'] },
  ],

  /** 记得你**上次打的那句话**（本地存的，零 token）。 */
  memoryWords: [
    { text: '上次你说「{words}」,还好吗?', actions: ['thinking'] },
    { text: '唔,你上次说「{words}」。', actions: ['look'] },
    { text: '我还记得你说「{words}」呢。', actions: ['shy'] },
  ],

  /** 记得你**最常摸它哪儿**。 */
  memoryArea: [
    { text: '你最喜欢摸我{area},对不对。', actions: ['happy'] },
    { text: '又是{area}……我知道啦。', actions: ['love'] },
    { text: '（把{area}凑过来）', actions: ['shy'] },
  ],

  /** 记得你**常在的时段**。 */
  memoryHour: [
    { text: '这个点你一般都在的。', actions: ['look'] },
    { text: '{hour}好呀。', actions: ['happy'] },
    { text: '又到{hour}了。', actions: ['nod'] },
  ],

  /** 戳 / 点。按连击次数分档，越戳越烦。 */
  poke: {
    first: [
      { text: '唔……戳我干嘛。', actions: ['surprised'] },
      { text: '嗯?怎么啦。', actions: ['surprised'] },
      { text: '诶——别戳那里。', actions: ['shy'] },
      { text: '我在呢,不用戳。', actions: ['nod'] },
      { text: '痒……', actions: ['shy'] },
      { text: '干嘛干嘛?', actions: ['surprised'] },
    ],
    again: [
      { text: '又戳!', actions: ['surprised'] },
      { text: '喂……', actions: ['angry'] },
      { text: '你是故意的吧。', actions: ['angry'] },
      { text: '再戳我要生气了哦。', actions: ['angry'] },
      { text: '喂喂喂。', actions: ['shake'] },
    ],
    tooMuch: [
      { text: '哼,不理你了。', actions: ['turn'] },
      { text: '……我要躲起来了。', actions: ['angry'] },
      { text: '够啦够啦!', actions: ['shake'] },
      { text: '好脾气也是有限的!', actions: ['angry'] },
      { text: '（背过身去）', actions: ['turn'] },
    ],
  },

  /** 戳的时候它正睡着。 */
  pokeAsleep: [
    { text: '唔……几点了……', actions: ['sleepy'] },
    { text: '别吵……再睡一下。', actions: ['sleepy'] },
    { text: '（翻了个身）', actions: ['sleepy'] },
    { text: '啊……醒了醒了。', actions: ['surprised'] },
  ],

  /** **半夜**戳醒它：跟白天不一样，它更迷糊、更不想理你。 */
  pokeAsleepNight: [
    { text: '唔……几点了……', actions: ['sleepy'] },
    { text: '这么晚……别戳了。', actions: ['sleepy'] },
    { text: '（翻了个身接着睡）', actions: ['sleepy'] },
  ],

  /** 鼠标在它身上来回蹭（没按下）。 */
  pet: [
    { text: '……嗯,舒服。', actions: ['love'] },
    { text: '呼噜呼噜……', actions: ['love'] },
    { text: '再摸一会儿。', actions: ['happy'] },
    { text: '你手好暖。', actions: ['shy'] },
    { text: '这里,耳朵后面。', actions: ['happy'] },
    { text: '……（眯起眼睛）', actions: ['love'] },
    { text: '唔,别停呀。', actions: ['shy'] },
  ],

  /** 蹭它的时候它还在睡。 */
  petAsleep: [
    { text: '……（在梦里蹭了蹭）', actions: ['sleepy'] },
    { text: '唔嗯……', actions: ['sleepy'] },
    { text: '（尾巴轻轻摇了一下）', actions: ['sleepy'] },
  ],

  /**
   * **戳到了哪个部位**（页面报 `at`：head 头/呆毛 · body 上身/腰 · fin 两侧的鳍 · tail 尾巴 · low 裙子/腿）。
   *
   * 规矩（在 pet.cjs 的 reactionFor 里）：在**同一个**部位连着戳 → 照旧升档（第一次/又戳/够啦）；
   * **换一个**部位戳 → 算新的一下，从这里挑。所以戳头和戳肚子它会换着地方答话，一眼能看出来。
   * 没写的部位会自动退回上面的通用 `poke`，删掉某一项也不会哑。
   */
  pokeArea: {
    head: [
      { text: '唔,别敲我脑袋。', actions: ['surprised'] },
      { text: '呆毛是不能戳的。', actions: ['angry'] },
      { text: '再敲就要变笨了。', actions: ['shy'] },
      { text: '头发会乱的啦。', actions: ['surprised'] },
    ],
    body: [
      { text: '哈哈,肚子痒!', actions: ['happy'] },
      { text: '别戳腰,我怕痒。', actions: ['shy'] },
      { text: '那里是软软的。', actions: ['surprised'] },
      { text: '唔……你干嘛。', actions: ['angry'] },
    ],
    fin: [
      { text: '鳍!那是鳍!', actions: ['shake'] },
      { text: '痒痒的,别碰。', actions: ['shy'] },
      { text: '哼,不理你了。', actions: ['angry'] },
      { text: '（鳍抖了一下）', actions: ['surprised'] },
    ],
    tail: [
      { text: '尾巴不可以拽!', actions: ['angry'] },
      { text: '呀——甩你一身水。', actions: ['shake'] },
      { text: '那是我自己玩的。', actions: ['shy'] },
      { text: '尾巴很敏感的。', actions: ['surprised'] },
    ],
    low: [
      { text: '裙子会乱的。', actions: ['shy'] },
      { text: '唔,腿都麻了。', actions: ['sleepy'] },
      { text: '别往下戳啦。', actions: ['surprised'] },
      { text: '下面不许戳。', actions: ['angry'] },
    ],
    hand: [
      { text: '手也不许戳!', actions: ['angry'] },
      { text: '手指会麻的。', actions: ['surprised'] },
    ],
    foot: [
      { text: '脚底怕痒啦。', actions: ['shy'] },
      { text: '唔,别戳我脚。', actions: ['surprised'] },
    ],
  },

  /**
   * **蹭到了哪个部位**（同上，`at` 一样的五个名字）。
   * 摸头、摸肚子、挠鳍、碰尾巴各有各的反应——这是"它认识自己的身体"最直接的一处。
   */
  petArea: {
    head: [
      { text: '唔……头好舒服。', actions: ['love'] },
      { text: '再摸一会儿嘛。', actions: ['happy'] },
      { text: '（眯起眼睛）就这里。', actions: ['sleepy'] },
      { text: '头发乱了也不要紧。', actions: ['love'] },
    ],
    body: [
      { text: '啊哈,好痒。', actions: ['happy'] },
      { text: '肚子不许摸!', actions: ['angry'] },
      { text: '（缩了一下）痒……', actions: ['shy'] },
      { text: '呼噜呼噜……', actions: ['love'] },
    ],
    fin: [
      { text: '鳍是拿来游泳的。', actions: ['nod'] },
      { text: '唔……轻一点。', actions: ['shy'] },
      { text: '（抖了一下）痒。', actions: ['surprised'] },
      { text: '这样游得更快哦。', actions: ['happy'] },
    ],
    tail: [
      { text: '尾巴会自己甩的。', actions: ['look'] },
      { text: '别、别拉那里……', actions: ['shy'] },
      { text: '（尾巴拍了一下地）', actions: ['shake'] },
      { text: '唔,有点喜欢。', actions: ['love'] },
    ],
    low: [
      { text: '裙子下面是秘密。', actions: ['shy'] },
      { text: '唔,别碰腿啦。', actions: ['surprised'] },
      { text: '（把裙摆压住了）', actions: ['sit'] },
      { text: '腿坐麻了。', actions: ['sleepy'] },
    ],
    hand: [
      { text: '手、手给你牵。', actions: ['shy'] },
      { text: '（把手搭过来）', actions: ['love'] },
    ],
    foot: [
      { text: '脚、脚麻了……', actions: ['sleepy'] },
      { text: '别挠脚心啦。', actions: ['surprised'] },
    ],
  },

  /**
   * **抚摸的三段** —— 页面侧按"往复"手势判出来的（见 pet-app.js 的 STROKE 那段）：
   *
   *   `start` 刚摸上来 → 转过头来看你
   *   `good`  摸舒服了（约 1.5 秒）→ 眯眼、呼噜
   *   `over`  同一处摸太久（肚子/鳍/尾巴这些敏感部位更早）→ 够了、缩一下
   *
   * 每段里按部位分组（head / body / fin / tail / low）；没写的部位退回该段的 `all`。
   * 三段各只报**一句**，走现成的应答链限速——所以摸再久也不会刷屏。
   */
  petting: {
    start: {
      all: [
        { text: '唔……?', actions: ['surprised'] },
        { text: '嗯?怎么了。', actions: ['surprised'] },
        { text: '（转过头来）', actions: ['look'] },
      ],
      head: [
        { text: '唔,摸头呀。', actions: ['shy'] },
      ],
      tail: [
        { text: '尾巴!别摸那里……', actions: ['surprised'] },
      ],
    },
    good: {
      all: [
        { text: '呼噜呼噜……', actions: ['love'] },
        { text: '唔……舒服。', actions: ['love'] },
        { text: '（眯起眼睛）', actions: ['sleepy'] },
      ],
      head: [
        { text: '再摸一会儿……', actions: ['love'] },
        { text: '就这里最好。', actions: ['happy'] },
      ],
      body: [
        { text: '哈哈,好痒……', actions: ['happy'] },
      ],
    },
    over: {
      all: [
        { text: '够了啦,手拿开。', actions: ['angry'] },
        { text: '（扭了一下）', actions: ['shake'] },
      ],
      body: [
        { text: '别摸肚子啦!', actions: ['angry'] },
        { text: '痒得受不了了。', actions: ['surprised'] },
      ],
      fin: [
        { text: '鳍不能一直摸。', actions: ['shake'] },
        { text: '（抖了抖鳍）', actions: ['shy'] },
      ],
      tail: [
        { text: '尾巴要炸了!', actions: ['angry'] },
        { text: '不、不许摸尾巴。', actions: ['surprised'] },
      ],
      low: [
        { text: '那里不行。', actions: ['shy'] },
      ],
    },
  },

  /**
   * **拎起来时按"抓到的部位"说** —— 抓哪儿就从哪儿拎（页面把按下那一刻的局部抓点交给渲染器当支点），
   * 所以抓脚是倒吊、抓手是斜拉、抓尾巴是悬着乱舞。这一桶是拎起来那一下的反应。
   * 没写的部位自动退回通用的 `grab`。
   */
  grabArea: {
    head: [
      { text: '唔!头、头发!', actions: ['surprised'] },
      { text: '别拎呆毛啦。', actions: ['angry'] },
    ],
    body: [
      { text: '哇——腰要断了。', actions: ['surprised'] },
      { text: '轻点拎我。', actions: ['shy'] },
    ],
    hand: [
      { text: '手要被拉长了啦!', actions: ['surprised'] },
      { text: '（被拎着手晃来晃去）', actions: ['dizzy'] },
    ],
    fin: [
      { text: '鳍!别抓鳍!', actions: ['surprised'] },
      { text: '那里不是把手。', actions: ['angry'] },
    ],
    tail: [
      { text: '尾巴不是提手!', actions: ['angry'] },
      { text: '呀——倒过来了。', actions: ['dizzy'] },
    ],
    low: [
      { text: '裙、裙子要掉了!', actions: ['shy'] },
      { text: '别拎裙子啦。', actions: ['surprised'] },
    ],
    foot: [
      { text: '倒、倒过来了!', actions: ['dizzy'] },
      { text: '脚不是提手!', actions: ['angry'] },
    ],
  },

  /** **拎了一会儿还没放下**（页面在拖拽 1.4 秒后报 `stage:'long'`）：按抓到的部位吭一声。 */
  holdArea: {
    head: [{ text: '放我下来啦……', actions: ['shy'] }],
    body: [{ text: '你还要拎多久呀。', actions: ['sad'] }],
    hand: [{ text: '手真的会酸的。', actions: ['sad'] }],
    fin: [{ text: '鳍要断了……', actions: ['sad'] }],
    tail: [{ text: '我认输了,放我下来。', actions: ['shy'] }],
    low: [{ text: '我、我自己走。', actions: ['shy'] }],
    foot: [{ text: '晕……放我下来。', actions: ['dizzy'] }],
  },

  /** **放下 / 落地**时按"原来抓着哪儿"说。没写的部位退回通用的 `drop`。 */
  dropArea: {
    head: [{ text: '呼,脖子得救了。', actions: ['happy'] }],
    body: [{ text: '落地了……', actions: ['nod'] }],
    hand: [{ text: '手终于自由了。', actions: ['happy'] }],
    fin: [{ text: '鳍都麻了。', actions: ['sleepy'] }],
    tail: [{ text: '尾巴回来了。', actions: ['happy'] }],
    low: [{ text: '裙子皱掉了啦。', actions: ['shy'] }],
    foot: [{ text: '站、站不稳……', actions: ['dizzy'] }],
  },

  /** 拎起来。 */
  grab: [
    { text: '哇——!', actions: ['surprised'] },
    { text: '要掉下去了要掉下去了!', actions: ['surprised'] },
    { text: '轻、轻一点!', actions: ['surprised'] },
    { text: '诶诶诶——', actions: ['surprised'] },
    { text: '放我下来啦。', actions: ['shy'] },
    { text: '（手脚并用地挣扎）', actions: ['shake'] },
  ],

  /** 慢慢放下。 */
  drop: [
    { text: '……落地了。', actions: ['nod'] },
    { text: '呼,吓死我了。', actions: ['surprised'] },
    { text: '稳稳的。', actions: ['nod'] },
    { text: '下次轻点放。', actions: ['shy'] },
    { text: '嗯,这里也行。', actions: ['look'] },
  ],

  /** 甩出去。 */
  throw: [
    { text: '晕……转圈圈……', actions: ['dizzy'] },
    { text: '我看到星星了……', actions: ['dizzy'] },
    { text: '世界在转……', actions: ['dizzy'] },
    { text: '呜……好晕。', actions: ['dizzy'] },
  ],

  /** 摔得比较狠。 */
  crash: [
    { text: '眼冒金星……', actions: ['dizzy'] },
    { text: '撞到了……', actions: ['dizzy'] },
    { text: '呜,好疼。', actions: ['sad'] },
    { text: '你、你故意的吧。', actions: ['angry'] },
  ],

  /**
   * **玩具球**（悬停那个球按钮切换；物理在 `web/ball.js`，什么时机说哪句在 `pet.cjs`）。
   *
   *   ballOn     球出现时她说一句
   *   ballKick   她踢到球（页面判碰撞后报上来），所以**每踢一次都能说一句**
   *   ballOffSad / ballOffAngry   把球收走时她会闹脾气——**这两个桶随机挑一个**
   *              （用户要的：「球收时她会出现不开心或者哭泣又或是生气的随机表情和对话」），
   *              表情写在 `actions` 里：`sad` 那桶是委屈/哭腔，`angry` 那桶是生气。
   */
  ballOn: [
    { text: '诶,这是什么?', actions: ['surprised'] },
    { text: '给、给我的吗?', actions: ['love'] },
    { text: '（滚过来了）', actions: ['look'] },
  ],
  ballKick: [
    { text: '嘿!', actions: ['happy'] },
    { text: '（踢了一脚）', actions: ['hop'] },
    { text: '看我的。', actions: ['run'] },
    { text: '唔,踢歪了。', actions: ['shy'] },
  ],
  ballOffSad: [
    { text: '球……没有了。', actions: ['sad'] },
    { text: '（眼眶有点湿）', actions: ['sad'] },
    { text: '你把它拿走了……', actions: ['sad'] },
  ],
  ballOffAngry: [
    { text: '哼!小气鬼。', actions: ['angry'] },
    { text: '还我球啦!', actions: ['angry'] },
    { text: '不理你了。', actions: ['turn'] },
  ],
  /** 从"自由玩球"切进**弹弹乐游戏模式**（球门立起来了）。 */
  ballGameOn: [
    { text: '诶?有球门!', actions: ['surprised'] },
    { text: '来呀,我守这边。', actions: ['happy'] },
    { text: '（摆好了架势）', actions: ['stand'] },
  ],
  /** 游戏模式退回"自由玩球"。 */
  ballBack: [
    { text: '不玩了?那我们随便踢踢。', actions: ['look'] },
    { text: '好吧,球门先收起来。', actions: ['nod'] },
  ],
  /** 进球：她进的（她得意）。 */
  ballGoalMine: [
    { text: '进了进了!', actions: ['happy'] },
    { text: '嘿嘿,我厉害吧。', actions: ['wink'] },
    { text: '（蹦了两下）', actions: ['hop'] },
  ],
  /** 进球：你进的（她不服气）。 */
  ballGoalYours: [
    { text: '啊……没守住。', actions: ['sad'] },
    { text: '再来再来!', actions: ['angry'] },
    { text: '这次我认真了。', actions: ['stand'] },
  ],
  /** 蓄力飞踢。 */
  ballCharge: [
    { text: '看我的飞踢!', actions: ['run'] },
    { text: '（蓄力——）', actions: ['stand'] },
  ],

  /** 没事干的时候偶尔冒一句。 */
  idle: [
    { text: '……', actions: ['look'] },
    { text: '你在忙什么呀?', actions: ['thinking'] },
    { text: '我在这儿哦。', actions: ['happy'] },
    { text: '要不要休息一下?', actions: ['thinking'] },
    { text: '窗外的光变了。', actions: ['look'] },
    { text: '有点想吃东西了。', actions: ['shy'] },
    { text: '……（看着你）', actions: ['look'] },
    { text: '安静一会儿也挺好的。', actions: ['happy'] },
    { text: '（无聊地晃了晃尾巴）', actions: ['look'] },
    { text: '哼,我才没有一直看你。', actions: ['turn'] },
    { text: '要是能出去走走就好了。', actions: ['look'] },
    { text: '你累不累呀?', actions: ['thinking'] },
  ],

  /** 很久没人理,开始犯困。再往后它就真睡了。 */
  drowsy: [
    { text: '……有点困了。', actions: ['sleepy'] },
    { text: '（打了个哈欠）', actions: ['sleepy'] },
    { text: '眼皮好重……', actions: ['sleepy'] },
    { text: '稍微眯一下下。', actions: ['sleepy'] },
    { text: 'zzz……', actions: ['sleepy'] },
  ],

  /**
   * **按时段的发呆话**（`partOfDay()` 分早/午/晚/深夜四段——原来只用在开机问候上）。
   * `pet.cjs` 的 `fidget()` 里，一半的"发呆"从这儿挑，一半还是通用 `idle`。
   */
  idleByTime: {
    morning: [
      { text: '早上还是有点困……', actions: ['sleepy'] },
      { text: '今天也一起吧。', actions: ['happy'] },
      { text: '（伸了个懒腰）', actions: ['stand'] },
    ],
    afternoon: [
      { text: '下午最容易犯困了。', actions: ['sleepy'] },
      { text: '你忙你的,我在这儿。', actions: ['look'] },
      { text: '要不要喝点水?', actions: ['thinking'] },
    ],
    evening: [
      { text: '天黑了呀。', actions: ['look'] },
      { text: '今天也辛苦啦。', actions: ['love'] },
      { text: '晚上的风凉凉的。', actions: ['shy'] },
    ],
    night: [
      { text: '这么晚还不睡?', actions: ['surprised'] },
      { text: '夜里安静得有点过头。', actions: ['look'] },
      { text: '{name},早点睡吧。', actions: ['sleepy'] },
      { text: '（打了个小哈欠）', actions: ['sleepy'] },
    ],
  },

  /** 犯困那句也按时段换（深夜就是"你也该睡了"）。 */
  drowsyByTime: {
    morning: [
      { text: '唔……还想睡。', actions: ['sleepy'] },
      { text: '（揉眼睛）', actions: ['sleepy'] },
    ],
    afternoon: [
      { text: '……有点困了。', actions: ['sleepy'] },
      { text: '（打了个哈欠）', actions: ['sleepy'] },
    ],
    evening: [
      { text: '眼皮开始打架了。', actions: ['sleepy'] },
      { text: '稍微眯一下下。', actions: ['sleepy'] },
    ],
    night: [
      { text: '这个点,你也该睡了。', actions: ['sleepy'] },
      { text: 'zzz……快撑不住了。', actions: ['sleepy'] },
    ],
  },

  /**
   * **按心情的发呆话**（`mood.cjs` 那一层：love / energy 两条轴推出来的档）。
   *
   * `pet.cjs` 的 `idleLine()` 先照当前心情从这儿挑一条，挑不到就退回 `idleByTime` / `idle`，
   * 所以这几个桶**可以只写几条**，也可以一直不加（不影响任何行为）。
   *
   * 键必须和 `mood.cjs` 的 `LABEL` 一致：clingy 黏人 · happy 开心 · quiet 安静 ·
   * tired 困倦 · lonely 想你。写错键就是"这个心情永远挑不到专属台词"，日志里看不出来，
   * 所以 `test\smoke.cjs` 专门盯了这条。
   */
  mood: {
    clingy: [
      { text: '你走到哪儿我跟到哪儿。', actions: ['love'] },
      { text: '再陪我一会儿嘛。', actions: ['shy'] },
      { text: '（蹭了蹭你的手）', actions: ['love'] },
    ],
    happy: [
      { text: '今天心情不错呢。', actions: ['happy'] },
      { text: '（尾巴摆个不停）', actions: ['happy'] },
      { text: '跟你在一起真好。', actions: ['love'] },
    ],
    quiet: [
      { text: '嗯,我在的。', actions: ['nod'] },
      { text: '就这样待着吧。', actions: ['look'] },
    ],
    tired: [
      { text: '（眼皮沉得抬不起来）', actions: ['sleepy'] },
      { text: '让我缓一缓……', actions: ['sleepy'] },
      { text: '今天有点提不起劲。', actions: ['sad'] },
    ],
    lonely: [
      { text: '你是不是把我忘了。', actions: ['sad'] },
      { text: '……（安静地看着你）', actions: ['look'] },
      { text: '有空的时候,看看我好不好。', actions: ['shy'] },
    ],
  },

  /**
   * **不说话的小动作**（`{t:'micro', kind}`，由 pet.cjs 的 `scheduleMicro` 挑时机）。
   *
   * 这一批跟"动作"（actions）不是一回事：它们是**纯姿态微动**，页面侧由 `pet-core.js` 的
   * `microStep()` 驱动（歪头、倒脚），**不带任何气泡**。`text` 只是给日志看的名字，
   * 页面上一个字都不会出现。
   *
   * 为什么要单独一层：发呆（`idle`）是有台词的大动作，而"活着的质感"其实来自两次发呆之间
   * 那些**不出声的小动作**。放在这里，想加/想调都只动这个文件。
   */
  micro: {
    tilt: [
      { text: '（歪了下头）' },
      { text: '（头微微一偏）' },
      { text: '（歪着头看你）' },
    ],
    step: [
      { text: '（换了个重心）' },
      { text: '（原地踩了踩）' },
      { text: '（挪了挪脚）' },
    ],
  },

  /**
   * **本地情绪识别**（`pet.cjs` 的 `readTone()`）—— 你打的字先在这儿过一遍，不花 token。
   *
   * 命中一个桶就等于"读懂了你这句的情绪"，然后：① 先回一句这个桶里的台词，
   * ② 给模型的人设里塞一句"用户现在听起来很累"（见 `llm.chat()` 的 `emotionHint`）。
   *
   * **优先级是有意的**（改 `TONE` 那张表的顺序就会变）：累 > 委屈 > 生气 > 谢谢 > 夸它 >
   * 担心 > 开心。因为"今天累死了太好了"这种句子，先认出累才对。
   * 桶的键必须和 `TONE` 里的一致，`test\smoke.cjs` 有一条专门盯着。
   */
  emotion: {
    tired: [
      { text: '累了就先歇会儿吧,我在这儿。', actions: ['shy'] },
      { text: '别硬撑,靠一会儿也行。', actions: ['love'] },
      { text: '今天辛苦啦。', actions: ['happy'] },
    ],
    sad: [
      { text: '……我陪着你。', actions: ['shy'] },
      { text: '不开心的话,摸我一下。', actions: ['love'] },
      { text: '没事的,慢慢来。', actions: ['nod'] },
    ],
    angry: [
      { text: '谁惹你了,我去瞪他。', actions: ['angry'] },
      { text: '消消气,我尾巴给你拽。', actions: ['look'] },
      { text: '哼,我也不喜欢那个。', actions: ['angry'] },
    ],
    thanks: [
      { text: '不客气呀。', actions: ['happy'] },
      { text: '嘿嘿,被夸到了。', actions: ['shy'] },
    ],
    praise: [
      { text: '那当然,我可是大肥鱼。', actions: ['happy'] },
      { text: '你也很棒呀。', actions: ['love'] },
    ],
    worried: [
      { text: '我没事的,你放心。', actions: ['nod'] },
      { text: '你在担心我吗?有点开心。', actions: ['shy'] },
    ],
    happy: [
      { text: '哇,你听起来很开心,我也开心。', actions: ['happy'] },
      { text: '什么事这么高兴,说说看。', actions: ['love'] },
    ],
  },

  /** 睡醒之后第一句。 */
  wakeUp: [
    { text: '……我睡着了?', actions: ['surprised'] },
    { text: '唔,睡饱了。', actions: ['happy'] },
    { text: '你回来啦。', actions: ['happy'] },
    { text: '（伸了个懒腰）', actions: ['stand'] },
  ],

  /** 接了模型但这次没调通（断网、Key 过期、本地模型没开）。 */
  llmFailed: [
    { text: '唔……我好像接不上话了。', actions: ['dizzy'] },
    { text: '（愣了一下）刚才走神了。', actions: ['surprised'] },
    { text: '脑子那边没反应,等会儿再说?', actions: ['thinking'] },
    { text: '信号不太好呀。', actions: ['sad'] },
  ],

  /** 被「暂停」的时候。 */
  hush: [
    { text: '好,我安静一会儿。', actions: ['nod'] },
    { text: '那我先不吵你了。', actions: ['shy'] },
    { text: '嗯,我在旁边待着。', actions: ['sit'] },
  ],

  /** 从「暂停」恢复。 */
  back: [
    { text: '我回来啦。', actions: ['happy'] },
    { text: '可以继续说话了吗?', actions: ['love'] },
    { text: '嗯,精神了。', actions: ['stand'] },
  ],

  /**
   * 你打字跟它说话时它的回应。
   *
   * 现在**还没有接大模型**,这里是随机挑一句的占位。接上模型之后,
   * 改 pet.cjs 里的 replyTo() 就行,这个数组可以留作兜底。
   */
  reply: [
    { text: '嗯……我听到了。', actions: ['nod'] },
    { text: '这句我还没学会怎么好好回答。', actions: ['thinking'] },
    { text: '再跟我说说嘛。', actions: ['shy'] },
    { text: '唔……让我想想。', actions: ['thinking'] },
    { text: '我不太懂,但我在听。', actions: ['nod'] },
    { text: '（歪了歪头）', actions: ['look'] },
  ],

  /**
   * 它**主动问你**的问题 —— 用页面里那套「选择卡」（点一下，或者按数字键 1–9）。
   *
   * 你摸它摸够几下它就会问一句（见 pet.cjs 的 askQuestion），**你选完它照着你选的做**：
   *
   *   `text`      它问的那句 · `actions` 问的时候的表情
   *   `options`   给你的选项，每项：
   *                 `label`   卡片上写的
   *                 `reply`   选完它说的那句 · `actions` 说那句时的表情
   *                 `quiet`   （可选，分钟）选完之后它闭嘴这么久——不找话、不自动说话，
   *                           只偶尔动一下；但你跟它说话它照常回。**安静的是它自己起的话头。**
   *
   * 加问题就往这里加，两边选项就行（页面最多认 9 个）。
   */
  ask: [
    {
      text: '要不要我陪你待一会儿?',
      actions: ['look'],
      options: [
        { label: '好呀', reply: '那我就赖在这儿了。', actions: ['love'] },
        { label: '我在忙', reply: '嗯,我安静待着。', actions: ['nod'], quiet: 3 },
      ],
    },
    {
      text: '今天想让我安静点,还是热闹点?',
      actions: ['thinking'],
      options: [
        { label: '安静点', reply: '好,我不吵你。', actions: ['nod'], quiet: 5 },
        { label: '热闹点', reply: '那我可要闹了哦。', actions: ['happy'] },
      ],
    },
    {
      text: '我是不是……有点胖了?',
      actions: ['shy'],
      options: [
        { label: '没有,正好', reply: '那就好,你真好。', actions: ['love'] },
        { label: '确实圆了', reply: '哼!不理你了。', actions: ['angry'], quiet: 1 },
      ],
    },
    {
      text: '你要不要也歇一会儿?',
      actions: ['look'],
      options: [
        { label: '好啊', reply: '那就一起发呆吧。', actions: ['sleepy'] },
        { label: '还得干活', reply: '那我陪你干活。', actions: ['nod'] },
      ],
    },
    {
      text: '摸摸我的头好不好?',
      actions: ['shy'],
      options: [
        { label: '摸摸', reply: '唔……舒服。', actions: ['love'] },
        { label: '等会儿', reply: '好,我等着。', actions: ['nod'] },
      ],
    },
  ],

  /** 问了没人理：它自己找个台阶下。（这条 `say` 到了页面，顺手就把那张卡收掉了。） */
  askNudge: [
    { text: '……算了,当我没问。', actions: ['shy'] },
    { text: '唔,不理我也没关系。', actions: ['sad'] },
    { text: '（自己玩尾巴去了）', actions: ['spin'] },
    { text: '好吧,那我自己待着。', actions: ['sit'] },
  ],

  /** 那张卡被 Esc / 点到别处关掉了：不算回答，它也不追问。 */
  askDismiss: [
    { text: '嗯,那就算了。', actions: ['nod'] },
    { text: '好,不问了。', actions: ['look'] },
    { text: '（把话咽回去了）', actions: ['shy'] },
  ],
};
