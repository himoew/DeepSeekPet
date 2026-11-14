/**
 * 自检区域：**他这句话是不是"让她去玩手机"**（2026-11-12 新增）
 *
 * 旧版是 `phone-life.PLAY_RX` 一条裸正则，真机（11-10 ~ 11-12）撞出两类错：
 *   · 误触：「不偷**玩手机**了」「好**玩吧**」「你**玩手机**的触发机制」都开了一场；
 *   · 漏认：他真说的「**去吧**」（她上一句「我这就出去转转」）什么都不开。
 *
 * 这一区只验判断，不碰 adb / 模型：`phone-play.playIntent()` 是纯函数。
 * 单跑：`node test\run-one.cjs 32-play-intent.cjs`
 */
module.exports = {
  name: '她的手机（去玩触发）',
  tags: ['companion', 'phone', 'intent', 'play'],
  async run(ctx) {
    const { ok } = ctx;
    const P = ctx.mod('phone-play');

    const judge = (text, lastHerLine = '') => P.playIntent(text, { lastHerLine }).kind;

    /* ---------- 1. 命令式：真该开的 ---------- */

    ok('触发：去玩吧 → 开', judge('去玩吧') === 'play');
    ok('触发：你随便玩吧 → 开', judge('你随便玩吧') === 'play');
    ok('触发：去玩会儿手机 → 开', judge('去玩会儿手机') === 'play');
    ok('触发：你自己玩去 → 开', judge('你自己玩去') === 'play');
    ok('触发：拿手机玩去 → 开', judge('拿手机玩去') === 'play');
    ok('触发：玩手机吧 → 开', judge('玩手机吧') === 'play');
    ok('触发：你自由玩手机吧，想看什么自己搜 → 开（真机 11-11 19:50 那句）',
      judge('你自由玩手机吧，想看什么自己搜') === 'play');

    /* ---------- 2. 许可式：只有她上一句说要去才认 ---------- */

    ok('触发：去吧（她刚说"我这就出去转转"）→ 开',
      P.playIntent('去吧', { lastHerLine: '我这就出去转转，逛几个地方' }).kind === 'play');
    ok('触发：去吧（她上一句无关）→ 不开',
      P.playIntent('去吧', { lastHerLine: '今天天气不错' }).kind === 'none');
    ok('触发：去吧（没有上一句）→ 不开', judge('去吧') === 'none');
    ok('触发：行，去吧（她说过要去）→ 开',
      P.playIntent('行，去吧', { lastHerLine: '我去玩会儿' }).kind === 'play');
    ok('触发：去呗（她上一句是"我去翻翻相册"）→ 开',
      P.playIntent('去呗', { lastHerLine: '我去翻翻相册' }).kind === 'play');

    /* ---------- 3. 误触：真机撞过的四句，一句都不许认 ---------- */

    const MISTAKES = [
      ['我差点以为你真不偷玩手机了', '不偷玩手机'],
      ['怎么样，好玩吧', '好玩吧'],
      ['我现在有点好奇你玩手机的触发机制了', '玩手机的触发机制'],
      ['你玩手机还是不太会', '抱怨'],
    ];
    for (const [text, why] of MISTAKES) {
      ok(`触发：不许把「${text}」当成让她去玩（${why}）`, judge(text) === 'none');
    }
    ok('触发：问句不当命令（你是不是又在玩手机）', judge('你是不是又在玩手机') === 'none');
    ok('触发：过去时不当命令（昨天你玩了好久）', judge('昨天你玩了好久') === 'none');
    ok('触发：转述不当命令（你说去玩吧）', judge('你说去玩吧') === 'none');

    /* ---------- 4. 否定 / 陪他 ---------- */

    ok('触发：先别玩了不是"去玩"', judge('先别玩了') === 'none');
    ok('触发：陪我玩一会儿是叫她陪他，不是让她自己玩', judge('陪我玩一会儿') === 'none');
    ok('触发：一起玩也不是', judge('一起玩会儿手机吧') === 'none');

    /* ---------- 5. 边界 ---------- */

    ok('触发：超过 24 字的长句不认（那是聊天）',
      judge('你现在去把手机拿起来然后随便看看什么好玩的东西都行吧') === 'none');
    ok('触发：空字符串不认', judge('') === 'none');
    ok('触发：兼容老接口 looksLikePlay', P.looksLikePlay('去玩吧') === true && P.looksLikePlay('好玩吧') === false);
    ok('触发：判定带原因（便于日志）', P.playIntent('去吧', { lastHerLine: '我去转转' }).why === 'permission');
  },
};
