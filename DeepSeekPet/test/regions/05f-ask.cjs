/**
 * 自检区域：真连一遍·选择卡（摸够了会问你）
 *
 * 由原 `regions\05-live.cjs` 的**第 5b-3 节**整段切出来（按行号搬，正文一字未改）。
 * 共用连接与 helper（`ws` / `fromPet` / `init` / `waitFor` / `nextReply` / `drain` /
 * `touchSay` …）由 `lib\live.cjs` 提供 —— 单跑这一个区域时它会自己连、自己等 init。
 * 单跑：`node test\run-one.cjs 05f-ask.cjs`
 */
module.exports = {
  name: "真连一遍·选择卡（摸够了会问你）",
  tags: ["live","联调","选择卡","问"],
  async run(ctx) {
    await ctx.live.ensure();   // 共用连接（第一个用到它的区域负责连上，并抓下 init）
    __mark('5b-3. 它会问你：摸够几下就举一张选择卡，选完它照着你选的做');
    /* ---------- 5b-3. 它会问你：摸够几下就举一张选择卡，选完它照着你选的做 ---------- */
    await drain();
    for (let i = 0; i < 4; i += 1) ws.send(JSON.stringify({ t: 'touch', kind: 'pet' }));
    const card = await waitFor('选择卡', () => fromPet.find((m) => m.t === 'ask'), 15000);
    ok(`摸够四下它会问一句（${card.question}）`, typeof card.question === 'string' && card.question.length > 0);
    ok('卡上带着选项（页面拿它画按钮）', Array.isArray(card.options) && card.options.length >= 2);
    const q = lines.ask.find((x) => x.text === card.question);
    ok('卡片上的问题来自台词库', !!q && card.options.length === q.options.length);
    // 挑一个**不带 quiet** 的选项：安静会让后面几节（自动说话）测不出东西来
    const pick2 = q.options.findIndex((o) => !o.quiet);
    ok('选项文字和台词库一一对上', pick2 >= 0 && card.options[pick2] === q.options[pick2].label);

    // **卡片举着的时候不许再有别的话出去**：页面见到任何一句 `say` 都会把卡收掉（dropAsks）。
    // 这条是被真机日志抓出来的——实测卡片 08:39:31 发出去，08:39:32 就有一句"蹭"的回话把它顶掉，
    // 屏幕上只闪了一下，用户以为"从来没触发过"。所以：卡举着时摸它=不出声（表情/音效照旧）。
    fromPet.length = 0;
    for (let i = 0; i < 3; i += 1) ws.send(JSON.stringify({ t: 'touch', kind: 'pet' }));
    await new Promise((r) => setTimeout(r, 2500));
    ok(`卡片举着时它不冒别的气泡（收到 ${ownSays().length} 个）`, ownSays().length === 0);

    fromPet.length = 0;
    ws.send(JSON.stringify({ t: 'answer', askId: card.id, index: pick2 }));
    const chose = await nextReply('askReply', 9000);
    ok(`选了之后它照着答一句（${chose.beats[0].text}）`, chose.beats[0].text === q.options[pick2].reply);

    // 连续拖放（抓-放的"抛物线"）：同类合并 + 排队上限，最多两个气泡，不会攒一长串
    fromPet.length = 0;
    for (let i = 0; i < 4; i += 1) {
      ws.send(JSON.stringify({ t: 'touch', kind: 'grab' }));
      ws.send(JSON.stringify({ t: 'touch', kind: 'drop' }));
    }
    await new Promise((r) => setTimeout(r, 9000));
    // 只数**抓/放**的回话（`tag` 就是操作名）：这一段要验的是"同类合并 + 排队上限"，
    // 数上发呆话或者上一节还在路上的回答都会让"最多两个"这条随机红。
    const grabDrop = says().filter((m) => m.tag === 'grab' || m.tag === 'drop');
    ok(`连续抓放四次最多两个气泡（收到 ${grabDrop.length} 个：${grabDrop.map((m) => m.beats.map((b) => b.text).join('+')).join(' | ')}）`,
      grabDrop.length <= 2);
    ok('抓放的气泡都是抓/放的台词',
      grabDrop.every((m) => textsOf(lines.grab, lines.drop).includes(m.beats[0].text)));

    // 暂停 / 恢复：要说一声，并且把菜单按钮换成"继续"
    fromPet.length = 0;
    ws.send(JSON.stringify({ t: 'control', action: 'pause' }));
    const hushed = await nextReply('control', 8000);
    ok('暂停时会说一句', textsOf(lines.hush).includes(hushed.beats[0].text));
    ok('暂停后菜单按钮变成"已暂停"', fromPet.some((m) => m.t === 'prefs' && m.bot?.paused === true));
    fromPet.length = 0;
    ws.send(JSON.stringify({ t: 'control', action: 'resume' }));
    const resumed = await nextReply('control', 8000);
    ok('恢复时也会说一句', textsOf(lines.back).includes(resumed.beats[0].text));

  },
};
