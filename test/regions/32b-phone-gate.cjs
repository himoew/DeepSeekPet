/**
 * 自检区域：手机前门（`phone-gate`，2026-11-12）
 *
 * 用户的原话：「我说一句'回到桌面打开日记本'必须要设定好吗？」
 * 答：不需要 —— 只要判得出"这一句是不是让她用手机"，就把**原句**交给她。
 *
 * 这一区盯三件事：
 *   ① 正向：认不出句式的"打开某个 App"也要放行（这是以前 miss 掉的那一类）；
 *   ② 反向：**24 句一条都不许排**（问句/否定/过去/转述/陈述/假设/未来/陪他/元讨论/器物）；
 *   ③ 守卫只有一份（`phone-intent.guardReason`），`LOOK_TAIL` 和 gate 都走它。
 *
 * 单跑：`node test\run-one.cjs 32b-phone-gate.cjs`
 */
module.exports = {
  name: '她的手机·前门（这句话是不是让她用手机）',
  tags: ['companion', 'phone', '手机', 'gate', '前门'],
  async run(ctx) {
    const { ok } = ctx;
    const gateMod = ctx.mod('phone-gate');
    const intent = ctx.mod('phone-intent');
    const owner = { isOwner: true, isGroup: false };
    const g = (text, extra = {}) => gateMod.gate(text, { ...owner, ...extra });

    /* ---------- 1. 正向：认不出句式也要放行 ---------- */

    /**
     * 这几句在 11-12 之前**一句都排不上**（`ownerCommands` 的白名单里没有"菜谱/天气/地图"）：
     *   「打开菜谱看看」→ 她嘴上说"我这就去"，手机一动不动。
     */
    const yes = [
      ['打开菜谱看看', '打开菜谱看看'],
      ['帮我打开菜谱', '打开菜谱'],
      ['打开菜谱看看有什么', '打开菜谱看看有什么'],
      ['去B站搜红烧肉', '去B站搜红烧肉'],
      ['去设置把亮度调暗一点', '去设置把亮度调暗一点'],
      ['帮我把壁纸换了', '把壁纸换了'],
      ['点开那个蓝色的图标', '点开那个蓝色的图标'],
      ['重新看看桌面就能看到了', '重新看看桌面就能看到了'],
      ['打开文件管理器看看有什么', '打开文件管理器看看有什么'],
    ];
    for (const [say, goal] of yes) {
      const r = g(say);
      ok(`前门：放行「${say}」`, r.kind === 'task' && r.goal === goal && r.confidence >= 0.7);
    }
    ok('前门：P2（打开一个词）置信度 0.9', g('打开菜谱看看').confidence === 0.9 && g('打开菜谱看看').why === 'P2');
    ok('前门：P3（手机线索 + 动作）0.7', g('重新看看桌面就能看到了').confidence === 0.7 && g('重新看看桌面就能看到了').why === 'P3');
    ok('前门：宾语尾巴里的"什么"不算问句（否则连"打开菜谱看看有什么"都排不上）',
      g('打开菜谱看看有什么').kind === 'task');
    ok('前门：一句话里两件，第二件也要能认（「回桌面，点开那个蓝色的图标」）',
      g('回桌面，点开那个蓝色的图标').kind === 'task'
      && /蓝色的图标/.test(g('回桌面，点开那个蓝色的图标').goal));

    /* ---------- 2. 反向：24 句一条都不许排（★ 全部来自真机/审计） ---------- */

    /**
     * ⚠️ 这张表**比正例重要**：他真说过的、会让手机乱动的说法都在这里
     * （`docs\陪伴模式\她玩手机-通用智能-方案-2026-11-12.md` §7.2）。
     */
    const no = [
      '别打开相册',
      '先别打开日记本',
      '刚才你打开相册了吗',
      '你刚才打开相册了吗',
      '你说打开日记本',
      '你说过打开相册',
      '我让你打开相册',
      '我教你打开设置',
      '为什么打开相册这么慢',
      '我不太会打开设置',
      '你觉得打开相册怎么样',
      '打开相册是什么意思',
      '我上次打开相册是昨天',
      '如果打开相册会怎样',
      '你明天打开相册看看',
      '学你的，你写日记也这样',
      '你刚返回卡了',
      '你玩手机还是不太会',
      '这手机怎么这么卡',
      '你帮我看看这个代码',
      '把灯打开',
      '让我看看你的手机',
      '你手机的触发机制是什么',
      '陪我看会儿手机',
    ];
    for (const say of no) {
      const r = g(say);
      ok(`前门：不误排「${say}」`, r.kind === 'none' && r.goal === '');
    }
    ok('前门：26 条反例里没有一条被排成任务（0 误排）', no.every((s) => g(s).kind === 'none'));

    /* ---------- 3. 为什么被挡（日志/审计要说得出来） ---------- */

    ok('原因：否定/问句走 blocked', g('别打开相册').why === 'blocked' && g('刚才你打开相册了吗').why === 'blocked');
    ok('原因：假设', g('如果打开相册会怎样').why === 'hypothetical');
    ok('原因：未来', g('你明天打开相册看看').why === 'future');
    ok('原因：过去（单字「刚」）', g('你刚返回卡了').why === 'past');
    ok('原因：陪他', g('陪我看会儿手机').why === 'together');
    ok('原因：要手机（不是用手机）', g('让我看看你的手机').why === 'look-at-her-phone');
    ok('原因：已经由 ownerCommands 认过了（不重复排）', g('打开相册').why === 'already-commanded');

    /* ---------- 4. near-miss：只记账、不改行为 ---------- */

    const nm = g('你帮我看看这个代码');
    ok('near-miss：没有手机线索的不记（不占账）', nm.near === false);
    const nm2 = g('你看看手机怎么这么卡');
    ok('near-miss：有手机线索 + 动作词被挡下的才记', nm2.kind === 'none' && nm2.near === true);
    const line = gateMod.auditLine('你看看手机怎么这么卡', nm2, 1794490000000);
    ok('near-miss：一行 JSON（时间/原话/原因）', (() => {
      try {
        const o = JSON.parse(line);
        return o.at === 1794490000000 && /手机/.test(o.text) && !!o.why;
      } catch { return false; }
    })());

    /* ---------- 5. 配置：一个开关就能回滚 ---------- */

    ok('配置：默认开', gateMod.DEFAULTS.enabled === true && gateMod.cfg({}).enabled === true);
    ok('配置：P0 不接模型（模型判"是不是任务"本身要一次调用）', gateMod.DEFAULTS.model === false);
    ok('配置：`enabled:false` 完全退回老行为', gateMod.gate('打开菜谱看看', { ...owner, cfg: { enabled: false } }).kind === 'none');
    ok('配置：非主人 / 群聊一律不排',
      gateMod.gate('打开菜谱看看', { isOwner: false }).kind === 'none'
      && gateMod.gate('打开菜谱看看', { isOwner: true, isGroup: true }).kind === 'none');
    ok('配置：太长的不当指令', gateMod.gate('打开菜谱看看'.repeat(20), owner).kind === 'none');
    ok('配置：maxLen 可配（太小的值会被夹到 20，别把正常指令挡掉）',
      gateMod.cfg({ maxLen: 200 }).maxLen === 200 && gateMod.cfg({ maxLen: 5 }).maxLen === 20);

    /* ---------- 6. 守卫只有一份（和 LOOK_TAIL / 扫动作同一套） ---------- */

    ok('守卫：`guardReason` 是导出给所有"补一句"的地方用的', typeof intent.guardReason === 'function');
    ok('守卫：陈述（也/这样）挡在扫动作之前',
      intent.ownerCommands('学你的，你写日记也这样').length === 0);
    ok('守卫：`LOOK_TAIL` 也过同一套（「别打开相册」不排）', intent.ownerCommands('别打开相册').length === 0);
    ok('守卫：防回归 —— 21:51 那句仍然认得出',
      intent.ownerCommands('现在试试去手机桌面看我给你写的日记，这次应该没问题了').length === 1);
    ok('守卫：宾语尾巴只给 gate 开口子，问句仍然挡',
      intent.guardReason('打开菜谱看看有什么', { allowGoalTail: true }) === ''
      && intent.guardReason('打开相册是什么意思', { allowGoalTail: true }) !== '');
  },
};
