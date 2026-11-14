/**
 * 她的手机 · 滚动层（2026-11-02，第一批 C）
 *
 * 用户原话：「她不知道什么时候下滑，我告诉她下滑后她不知道下滑途中停止，
 * 去看自己想看的东西」。
 *
 * 旧行为只有一件事：`swipe up` 一划就是 **0.5 屏 / 300 ms**（≈2100 px/s，必然甩出去），
 * 划完才看一屏。于是**被划过的东西她一件都没看见过**，也没法"落到一半停住"。
 *
 * 这一层把"滚动"从一个**动作**改成一段**过程**：
 *
 *   小步滑（列表 0.32 屏 / 650 ms，基本不甩）→ 立刻看这一屏 → 值不值得停？
 *     值得 → 停在这里，把"我为什么停"写进下一步的 prompt
 *     不值得 → 再滑一小步 ……（最多 6 屏 / 2 次视觉判断）
 *
 * ⚠️ **不能全局改慢**：B 站竖屏故事流是 ViewPager2，靠 fling 吸附到下一条；
 *    慢滑会停在两条视频中间（半屏脸），后面每一步判断全错。所以滑多远**按容器分档**。
 *
 * ⚠️ 这个文件是**纯函数**：不碰 adb、不认识 PhoneAgent（`goalNouns` 用的时候才 require，
 *    因为它和 `phone-agent` 互相引用）。执行在 `phone-agent.scan()` 里。
 */

/**
 * 她会多看一眼的东西（和 `phone-agent.DEFAULTS.taste` 同源：
 * "爱看热闹、爱听人说话；对猫、小动物和吃的东西会多看一眼"）。
 * 想改她的口味就改这一行 —— 这是"看到想看的就停"里"想看的"的定义。
 */
const INTEREST = [
  '猫', '小猫', '狗', '小动物', '鱼', '尾巴', '翅膀',
  '吃', '好吃', '美食', '做饭', '零食',
  '搞笑', '沙雕', '可爱', '萌', '表情包', '漫画', '动画',
  '手工', '游戏', '音乐', '电影', '故事',
];

/** 竖屏故事流 / 播放器：**必须甩**，靠 fling 吸附到下一条。 */
const PAGER_ACT = /StoryVideo|PlayerActivity|UnitedBizDetails|VideoDetail/i;
/** 相册：横向换照片。 */
const GALLERY_PKG = /gallery3d/i;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const textOf = (n) => `${String(n && n.text || '')} ${String(n && n.desc || '')}`.replace(/\s+/g, ' ').trim();

/**
 * 这一屏该怎么滑。
 *
 * | 容器 | 跨度 | 时长 | 效果 |
 * |---|---|---|---|
 * | 列表（默认） | 0.32 屏 | 650 ms | ≈630 px/s，**基本不甩**，停在哪就是哪 |
 * | 竖屏流/播放器 | 0.55 屏 | 240 ms | 保持甩动，pager 才会吸附 |
 * | 相册照片页 | 0.45 屏 | 400 ms | 换一张 |
 *
 * @returns {{span:number, ms:number, kind:string}}
 */
function profileOf(obs) {
  const act = String(obs && obs.app && obs.app.activity || '');
  const pkg = String(obs && obs.app && obs.app.package || '');
  if (PAGER_ACT.test(act)) return { span: 0.55, ms: 240, kind: 'pager' };
  if (GALLERY_PKG.test(pkg)) return { span: 0.45, ms: 400, kind: 'gallery' };
  return { span: 0.32, ms: 650, kind: 'list' };
}

/** 这一屏上"能读的字"（标题、正文、按钮），去重、去导航词。 */
const NAV = /^(返回|首页|我的|消息|动态|会员|直播|推荐|热门|关注|综合|排序|筛选|搜索|登录|注册|设置|更多|分享|收藏|评论|赞|投币|转发|关注|已关注|取消|确定|关闭|跳过)$/;
function textsOf(obs) {
  const out = [];
  for (const n of (obs && obs.nodes) || []) {
    const t = textOf(n);
    if (t.length < 2) continue;
    if (NAV.test(t)) continue;
    out.push(t.slice(0, 60));
  }
  return out;
}

/**
 * 记"这一屏看过什么"，顺手告诉调用方**这一屏有没有新东西**。
 *
 * 两个用处：① 别在同一个地方来回滚；② 连续两屏都没新词 = 到底了 / 滑不动了。
 *
 * @param {object} obs
 * @param {Set} seen        跨屏累积（调用方持有，最多留 200 条）
 * @param {object} [prev]   上一屏（用来算"重合度"）
 * @returns {{count:number, ratio:number}} count = 新词数，ratio = 和上一屏的重合度（0~1）
 */
function newTexts(obs, seen, prev = null) {
  const now = textsOf(obs);
  let added = 0;
  for (const t of now) {
    if (seen.has(t)) continue;
    seen.add(t);
    added += 1;
    if (seen.size > 200) {
      /** 只留最近的一批（Set 保持插入顺序，删最早的那个）。 */
      const first = seen.values().next().value;
      seen.delete(first);
    }
  }
  let ratio = 0;
  if (prev) {
    const before = new Set(textsOf(prev));
    if (now.length && before.size) {
      const same = now.filter((t) => before.has(t)).length;
      ratio = same / now.length;
    }
  }
  return { count: added, ratio };
}

/**
 * 这一屏值不值得**停下来**。
 *
 * 判据全是"具体的东西"，不是"这一屏像内容"（那种判据在列表上会每屏都成立，等于没判）：
 *   ① 在找某个词（`scrollto`）→ 出现就停；
 *   ② 目标里的名词出现了（借用 `phone-agent` 的同义词表）；
 *   ③ 命中她的兴趣词（`INTEREST`）。
 * 自绘/纯图的屏由调用方走"视觉兜底"（一条滚动手势最多 2 次）。
 *
 * @returns {{stop:boolean, why:string}}
 */
function verdict(obs, { goal = '', target = '', screen = null } = {}) {
  const nodes = (obs && obs.nodes) || [];
  if (!nodes.length) return { stop: false, why: '', kind: '' };
  const blob = `${obs?.app?.name || ''} ${obs?.app?.package || ''} ${nodes.map(textOf).join(' ')}`;

  const want = String(target || '').trim();
  if (want && blob.includes(want)) return { stop: true, why: `看到「${want}」了`, kind: 'target' };

  // 目标里的名词（图库/视频/搜索…）—— 和 done 断言用同一张同义词表
  try {
    const { goalNouns, screenHasGoal } = require('./phone-agent.cjs');
    const nouns = goalNouns(goal);
    if (nouns.length && screenHasGoal(blob, nouns, { onHome: /launcher|lawnchair/i.test(obs?.app?.package || '') })) {
      return { stop: true, why: `这一屏有「${nouns[0]}」`, kind: 'goal' };
    }
  } catch { /* 互相引用的边界：拿不到就只按兴趣词判 */ }

  const hit = INTEREST.find((w) => blob.includes(w));
  if (hit && !want) return { stop: true, why: `看到「${hit}」了`, kind: 'interest' };
  return { stop: false, why: '', kind: '' };
}

/**
 * "这是在找东西"的目标 —— 这种目标允许"屏变了就算前进"（`phone-agent.judge` 用）。
 * 注意：**滑动本身不算**目标近了，所以它永远不写进 `hints.json`。
 */
function isLooking(goal) {
  return /(滑|翻|逛|看看|浏览|找|挑)/.test(String(goal || ''));
}

module.exports = {
  INTEREST, PAGER_ACT, GALLERY_PKG,
  profileOf, textsOf, newTexts, verdict, isLooking, clamp,
};
