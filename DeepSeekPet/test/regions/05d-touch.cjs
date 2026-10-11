/**
 * 自检区域：真连一遍·连点与连拖（气泡合并/过期）
 *
 * 由原 `regions\05-live.cjs` 的**第 5b 节**整段切出来（按行号搬，正文一字未改）。
 * 共用连接与 helper（`ws` / `fromPet` / `init` / `waitFor` / `nextReply` / `drain` /
 * `touchSay` …）由 `lib\live.cjs` 提供 —— 单跑这一个区域时它会自己连、自己等 init。
 * 单跑：`node test\run-one.cjs 05d-touch.cjs`
 */
module.exports = {
  name: "真连一遍·连点与连拖（气泡合并/过期）",
  tags: ["live","联调","气泡","连点"],
  async run(ctx) {
    await ctx.live.ensure();   // 共用连接（第一个用到它的区域负责连上，并抓下 init）
    // 先甩一下，把应答链的空档走完：下面的断言都从这里干净的起点算起
    await touchSay('throw');

    // 连戳五下：**一个**气泡（第五下的档位），不能一下一个、说完还接着弹
    fromPet.length = 0;
    for (let i = 0; i < 5; i += 1) ws.send(JSON.stringify({ t: 'touch', kind: 'poke' }));
    const pokes = [await nextReply('poke', 8000)];
    const seen = ownSays().length;
    await new Promise((r) => setTimeout(r, 1200));      // 再等一会儿，看有没有第二、第三个冒出来
    pokes.push(...ownSays().slice(seen));
    ok(`连戳五下只出一个气泡（收到 ${pokes.length} 个：${pokes.map((m) => m.beats.map((b) => b.text).join('+')).join(' | ')}）`, pokes.length === 1);
    ok('连戳五下的档位照样升到「戳太多」', textsOf(lines.poke.tooMuch).includes(pokes[0].beats[0].text));
    ok('触发类气泡带 react 标记（页面据此丢掉过期的）', pokes.every((m) => m.kind === 'react'));
    ok('每一下都配了表情或动作', pokes.every((m) => (m.beats[0].actions || []).length > 0));

    // 点一下、停一下再点：1.5 秒一下属于"自己一下一下点"，不合并，档位要升
    // 同样先排空上一节（连戳五下）在路上的气泡，否则它会被算进 spaced[0]，
    // 把整条"第一次/又戳/又戳"的档位串位（实测就这样间歇性红过）
    await drain();
    const spaced = [];
    for (let i = 0; i < 3; i += 1) {
      const sentAt = Date.now();
      spaced.push(await touchOwnSay('poke'));
      /**
       * ★ **2026-10-11 复核修**：按"**下一次点**"的节奏算，而不是"等回话再等 1.4 秒"。
       *
       * 产品的连击窗口是 `POKE_COMBO_MS = 2500`（`pet.cjs` 第 317 / 947 行），而且量的是
       * **两次 `touch` 到达的间隔**。原来这里是"`await` 回话之后再 `sleep(1400)`" ——
       * 真实间隔 = **回话时间 + 1400ms**，只要回话超过 1.1 秒就越过 2500ms，产品把它当成
       * "新的一下"（回 `poke.first`，比如那句「痒……」），断言「第二下升到又戳」当场就红。
       * **装了语音的那份（`D:\pet`）尤其容易踩**：回话要排队等气泡节奏，慢一点就过界
       * （实测部署目录里红过一次，工作区不装语音时不容易碰到）。
       * 改成"距这次按下 1.4 秒"之后，节奏由**测试自己**控制 —— 这也正是这条断言原本的意思
       * （注释写的就是"1.5 秒一下"）；**断言与产品逻辑一个字没改**，只改"什么时候按下第二次"。
       */
      const rest = 1400 - (Date.now() - sentAt);
      if (rest > 0) await new Promise((r) => setTimeout(r, rest));
    }
    ok('1.5 秒一下不会被合并，三下三个气泡', spaced.length === 3);
    ok('第一下是"第一次戳"', textsOf(lines.poke.first).includes(spaced[0].beats[0].text));
    ok('第二下升到"又戳"', textsOf(lines.poke.again).includes(spaced[1].beats[0].text));
    ok('第三下还是"又戳"', textsOf(lines.poke.again).includes(spaced[2].beats[0].text));

    // 气泡之间有间隔：不会一口气连珠炮；停手之后也不再冒出来
    ok('气泡间隔在 1.1–3.2 秒之间（不急不挤，也不拖）',
      spaced.slice(1).every((m, i) => m.at - spaced[i].at > 1100 && m.at - spaced[i].at < 3200));
    fromPet.length = 0;
    await new Promise((r) => setTimeout(r, 2500));
    ok('停手之后气泡就停了（不会再冒出来）', ownSays().length === 0);

  },
};
