/**
 * 自检区域：真连一遍·球与弹弹乐往返
 *
 * 由原 `regions\05-live.cjs` 的**第 4c 节**整段切出来（按行号搬，正文一字未改）。
 * 共用连接与 helper（`ws` / `fromPet` / `init` / `waitFor` / `nextReply` / `drain` /
 * `touchSay` …）由 `lib\live.cjs` 提供 —— 单跑这一个区域时它会自己连、自己等 init。
 * 单跑：`node test\run-one.cjs 05b-ball-live.cjs`
 */
module.exports = {
  name: "真连一遍·球与弹弹乐往返",
  tags: ["live","联调","ball","球"],
  async run(ctx) {
    await ctx.live.ensure();   // 共用连接（第一个用到它的区域负责连上，并抓下 init）
    __mark('4c. 球与弹弹乐：三态开关 + 进球 + 蓄力，走完整往返');
    /* ---------- 4c. 球与弹弹乐：三态开关 + 进球 + 蓄力，走完整往返 ---------- */
    /**
     * 静态守卫（2g）只能证明"代码在"，证明不了"这条链通"。这里连上真 World 走一遍：
     *   出球 → `ballOn`；踢到 → `ballKick`；进游戏 → `ballGameOn`；进球 → `ballGoal`；
     *   蓄力 → `ballCharge`；收走 → 委屈或生气。
     */
    fromPet.length = 0;
    ws.send(JSON.stringify({ t: 'ballMode', mode: 'ball' }));
    const onSay = await nextReply('ballOn');
    ok('球：出球时她会说一句（ballOn）', !!onSay);

    fromPet.length = 0;
    ws.send(JSON.stringify({ t: 'ballKick', at: 0.42 }));
    const kickSay = await nextReply('ballKick');
    ok('球：踢到球她会说一句（ballKick）', !!kickSay);

    fromPet.length = 0;
    ws.send(JSON.stringify({ t: 'ballMode', mode: 'game' }));
    const gameSay = await nextReply('ballGameOn');
    ok('弹弹乐：进游戏模式她会招呼一声（ballGameOn）', !!gameSay);

    fromPet.length = 0;
    ws.send(JSON.stringify({ t: 'ballGoal', scorer: 1, score: [0, 1], defence: 1 }));
    const goalMine = await nextReply('ballGoal');
    ok('弹弹乐：她进球她会得意（ballGoalMine）',
      !!goalMine && goalMine.beats.some((b) => textsOf(lines.ballGoalMine).includes(b.text)));

    fromPet.length = 0;
    ws.send(JSON.stringify({ t: 'ballGoal', scorer: 0, score: [1, 1], defence: 1 }));
    const goalYours = await nextReply('ballGoal');
    ok('弹弹乐：你进球她不服气（ballGoalYours）',
      !!goalYours && goalYours.beats.some((b) => textsOf(lines.ballGoalYours).includes(b.text)));

    fromPet.length = 0;
    ws.send(JSON.stringify({ t: 'ballCharge' }));
    const chargeSay = await nextReply('ballCharge');
    ok('弹弹乐：蓄力飞踢会喊一声（ballCharge）', !!chargeSay);

    fromPet.length = 0;
    ws.send(JSON.stringify({ t: 'ballMode', mode: 'off' }));
    const offSay = await nextReply('ballOff');
    // 收走时是"委屈 / 生气"随机一套，两句都要能在台词库里找到出处
    const offPool = [...textsOf(lines.ballOffSad), ...textsOf(lines.ballOffAngry)];
    ok('球：收走时她会闹脾气（委屈或生气，随机）',
      !!offSay && offSay.beats.some((b) => offPool.includes(b.text)));
    ok('球：收走那一下带了表情（sad 或 angry）',
      !!offSay && offSay.beats.some((b) => ['sad', 'angry', 'turn'].some((a) => (b.actions || []).includes(a))));

  },
};
