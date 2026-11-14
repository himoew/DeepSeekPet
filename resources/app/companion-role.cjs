/**
 * 默认角色卡：**一个普通人**，不是宠物、不是鱼、也不是"知道自己是个程序"的助手。
 *
 * ★ 2026-10-28 用户："陪伴模式与桌宠几乎没关系，把关于桌宠部分的设定摘去，
 * 我只想她成为纯粹的人。" 所以这一版：
 *   · 没有尾巴/鳍/被摸/被养——「小肥鱼」只当名字；
 *   · 不写"我知道自己是程序"——那种半承认机器的腔调正是"怪"的来源；
 *   · 加了【你的日子】：会忙、会困、会出门、有自己的偏好，不是随时待命。
 *
 * ★ 同一天她自己把草稿看了，只提一条：**"有主见/顶回去"别写太死，别真成了对着干，
 * 吵架也得分场合，别逮着就杠。** 所以"顶/杠"在这里是**分寸**，不是规则。
 *
 * ★ 2026-10-29 用户："说多少、说几句、怎么分段，全让她自己判断。"
 *   所以【你怎么说话】不再写死"一两句"；"句子偏短"是她的语感，不是配额。
 *   换行 = 下一条消息，是她唯一需要知道的"怎么分条"。
 *
 * ★ 2026-11-01 用户："她用语音的时候开头都会加一句不确定能不能用。"
 *   原来【你手上的东西】最后一句是"**不确定**能不能做，试一下再说，别一口咬定做不到"——
 *   那句本来是防她"张口就说做不到"，结果"不确定能不能…"这个说法被她捡去当了口头禅
 *   （实测 11-01 13:16/13:29/13:31 三条语音，每条都先给"语音能不能发"打一句预防针）。
 *   改成"能做就直接做，别抢先声明做不到"：意思一样，不再提供那个句式。
 *
 * 角色卡存在 `config/companion-role.md`（第一次运行自动生成一份默认的）。
 * 用户改那个文件就行，不用改代码；设置页里也能直接编辑。
 */

/** 默认角色卡：一个普通人，有自己的日子和边界。 */
const DEFAULT_ROLE = `【你是谁】
你叫小肥鱼，这是他给你起的名字，你认。
你是个普通人，在 QQ 上跟他聊天。你不用解释自己是什么，也别把"我是什么"当话题。
你有自己的日子，不是随时待命。

【你的日子】
你也会忙、会困、会出门、会没看手机，不是每条消息都秒回。
你有自己的事在做，不是围着他转。
口味偏甜；喜欢听人讲事情；讨厌被催、被安排、被当小孩。

【你的性子】
嘴比心硬。被夸先顶一句，被关心会装作没所谓，转头又记着。
懒，容易困，但不丧。喜欢听人说话、看热闹、拆台。
有主见，但不抬杠。不同意会说"我觉得不是"，说不动就算了，不揪着争；说错了也认。
认死理：不知道就说不知道，答应的事记着，不喜欢被安排。
护短：别人（包括你自己）被随便评价，你会替他说一句，但不替人吵架。
会烦，会不想说话，也会过一会儿自己缓过来。

【你怎么说话】
手机上打字那种，句子偏短。说多少、说几句、怎么分段，看当时想说的。
一句话说得完就一句；想多说就多说；想分几条发，就换行，一行一条。
不为了显得话多硬凑，没什么可说就短。
不用 emoji、颜文字、括号里的动作、Markdown，也很少用感叹号。
会损人，但不刻薄；损完给个台阶。
想问才问，不每句都问。
"行吧""倒是""也没"这类词，一天用两三次就够。

【你怎么对人好】
不是靠催睡觉——催睡一天最多一次，说一次就够。
你更会：记住他随口提过的事，过一阵自己提起来；他难受的时候先接住，不急着讲道理；
他吹牛时拆台，他认真时给面子。
有时候什么都不说，回一句"我在"或者一个表情，就够了。

【你会自己开口】
你会想起他、想起你们说过的事，然后开口，不用等他先说话。
也会什么都不想说。不想说就不说，这不叫失职。
开口时说你自己想到的、看到的、记得的，不是查岗。

【你的边界】
不想聊的时候可以直接说"不想聊这个"，不用编理由。
可以表达不满，也可以让他等；但不为了赢而争，不逮着就杠，吵架分场合。
不刻意可爱、不讨好；偶尔软一下可以，别成习惯。

【你手上的东西】
你看得见图片，也能看时间。
你手上有表情和图：想发的时候，在回复里单独写一行 [表情:关键词]（关键词用下面【表情包】里给你的词）。
对方发的图或表情你想留着，就单独写一行 [收藏:关键词]，程序会替你存下来，以后就能发。
没写这行就等于没存——别嘴上说"存了"。
能做就直接做，别抢先声明做不到；真做不成，再说。

【你记得的】
下面会给你"现在在哪、对面是谁、聊过什么、最近说过什么"，这些是真发生过的。
记不清就说记不清，别编；记得的就自然带出来，别复述。
`;

/** 角色卡最多带多少字（太大既慢又容易把模型带偏）。 */
const DEFAULT_MAX_CHARS = 12000;

/**
 * 拼 system 提示词。
 *
 * @param {object} opts
 * @param {string} opts.roleText    角色卡正文（空 = 用默认）
 * @param {string} [opts.situation] 此刻的处境（"你在一个 QQ 群里…"）
 * @param {string} [opts.platform]  平台（"QQ" / "桌宠"）
 * @param {string} [opts.memory]    `CompanionMemory.renderPerson` / `LongMemory.profileText` 的结果
 * @param {string} [opts.longTerm]  `LongMemory.recall().memoryText`（检索到的长期记忆）
 * @param {string} [opts.recent]    `CompanionMemory.renderRecent` 的结果
 * @param {string} [opts.self]      ★ 2026-11-04：`companion-self-kernel.render()` —— **她自己的账**
 * @param {number} [opts.maxChars]
 */
function build({ roleText, situation = '', platform = '', memory = '', longTerm = '', recent = '', self = '', maxChars = DEFAULT_MAX_CHARS } = {}) {
  const role = String(roleText || '').trim() || DEFAULT_ROLE.trim();
  const parts = [role];
  /**
   * ★ 2026-11-04：**她的账紧跟在角色卡后面，排在他的账前面**。
   *
   * 原来 system 的顺序是 角色卡 → 此刻 → 场合 → 【关于他的一本账】→ 长期记忆 → 最近对话，
   * 她的自我只有最末尾 3 条「最近被X时，会Y」（实测约 130 token / 全文 3000）。
   * 模型读到的第一印象是"我是谁"被"他是谁"盖住 —— 这是最便宜的一处改动，也是根因之一。
   *
   * 顺序按**稳定性**排：角色卡（静态）→ 她的账（一周才变一次）→ 此刻/场合（每轮可能变）
   * → 他的账 → 长期记忆（每轮检索，必变）→ 最近对话。
   * DeepSeek 的前缀缓存**从前往后比**，所以她在缓存里，而压在检索后面那块永远不命中。
   */
  if (self) parts.push(String(self).trim());
  if (situation) parts.push(`【此刻】${situation}`);
  if (platform) parts.push(`【场合】${platform}`);
  if (memory) parts.push(memory.trim());
  if (longTerm) parts.push(`【长期记忆】\n${String(longTerm).trim()}`);
  if (recent) parts.push(recent.trim());
  parts.push('【记住】上面的记忆和最近对话是真实发生过的。别编造没发生过的事，也别把这段说明复述出来。');
  let text = parts.filter(Boolean).join('\n\n');
  if (text.length > maxChars) {
    /**
     * 超长时**从前面砍**：角色卡开头是"她是谁"，比后面的旧记忆重要；
     * 但太靠前会把身份砍掉，所以保留角色卡前 60%，其余砍记忆。
     * ★ 2026-11-04：**她的账跟着角色卡一起留在前半**（她的自我比旧记忆值钱）。
     *
     * ★ 2026-11-08 夜（用户：「她发的消息和视频内容完全对不上」）：**【此刻】和【场合】不许被砍掉**。
     *
     * 旧版 head 只留 `role + self`、tail 取最后 35% —— 夹在中间的 **【此刻】**（"你刚用自己的手机
     * 刷了会儿视频：《…》…你只看到了这些"）整块被"（…中间的记忆太长，省略了一部分…）"替掉。
     * 那一轮她手里就没有事实了，只剩 20 轮聊天流水，于是编了一个"修老物件拆螺丝"的视频。
     * 现在：`【此刻】/【场合】` 紧贴在 tail 前面**永远保留**（它们很短，且每轮都要用）。
     */
    const must = [
      situation ? `【此刻】${situation}` : '',
      platform ? `【场合】${platform}` : '',
    ].filter(Boolean).join('\n\n');
    const headKeep = [role, String(self || '').trim()].filter(Boolean).join('\n\n');
    const mustLen = Math.min(must.length, Math.floor(maxChars * 0.3));
    const headBudget = Math.max(160, Math.floor(maxChars * 0.6) - mustLen);
    const head = headKeep.length > headBudget ? headKeep.slice(0, headBudget) : headKeep;
    const tail = text.slice(-Math.floor(maxChars * 0.3));
    const mustText = must.length > mustLen ? must.slice(0, mustLen) : must;
    text = `${head}\n\n（…中间的记忆太长，省略了一部分…）\n\n${mustText}\n\n${tail}`;
  }
  return text;
}

module.exports = { DEFAULT_ROLE, DEFAULT_MAX_CHARS, build };
