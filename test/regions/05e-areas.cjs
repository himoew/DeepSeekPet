/**
 * 自检区域：真连一遍·部位（戳/蹭说哪儿的话）
 *
 * 由原 `regions\05-live.cjs` 的**第 5b-2 节**整段切出来（按行号搬，正文一字未改）。
 * 共用连接与 helper（`ws` / `fromPet` / `init` / `waitFor` / `nextReply` / `drain` /
 * `touchSay` …）由 `lib\live.cjs` 提供 —— 单跑这一个区域时它会自己连、自己等 init。
 * 单跑：`node test\run-one.cjs 05e-areas.cjs`
 */
module.exports = {
  name: "真连一遍·部位（戳/蹭说哪儿的话）",
  tags: ["live","联调","部位","戳","蹭"],
  async run(ctx) {
    await ctx.live.ensure();   // 共用连接（第一个用到它的区域负责连上，并抓下 init）
    __mark('5b-2. 部位：戳/蹭在**身上哪个地方**，就说那个地方的话');
    /* ---------- 5b-2. 部位：戳/蹭在**身上哪个地方**，就说那个地方的话 ---------- */
    // 部位是**页面**判的（pet-app.js 的 REGION_BOXES/REGION_AT，照 whale\model.json 的部件框量出来），
    // 跟着 touch 一起报上来；World 只认名字。所以这里直接按页面的口吻发 `at`。
    // ★ 2026-10-10 名字细化了：头发是 `hair`（原来叫 `head`）、肚子是 `belly`（原来叫 `body`）、
    //   裙子是 `skirt`（原来叫 `low`）。
    //
    // ⚠️ **顺序有讲究，别随手调**：`state.card` 一举起来，它**一句话都不说**（`if (state.card) break`），
    //   而"摸头"那一族（呆毛/头发/眼睛/脸蛋/下巴）每下算**两下**好感，攒够 `ASK_AFTER_PETS`（3）就举卡。
    //   所以"页面没报部位 → 通用蹭"这条必须**排在最前**：那时上一节刚把好感清零（它测过举卡），
    //   这一下只算 1 点、绝不会举卡。反过来排在后面的话，前面几下戳头发 + 蹭下巴早把卡举起来了，
    //   这一条就**永远等不到气泡**（实测报的是"等不到 tag=pet 的回话（收到 prefs | act | ask）"）。
    await drain();
    const plainPet = await touchOwnSay('pet');
    ok('页面没报部位时退回通用的「蹭」', textsOf(lines.pet).includes(plainPet.beats[0].text));
    const headPoke = await touchOwnSay('poke', { at: 'hair' });
    ok('戳头发说的是「头发」那一桶', textsOf(lines.pokeArea.hair).includes(headPoke.beats[0].text));
    const bellyPoke = await touchOwnSay('poke', { at: 'belly' });
    ok('换到肚子戳就换一桶话', textsOf(lines.pokeArea.belly).includes(bellyPoke.beats[0].text));
    const ahogePoke = await touchOwnSay('poke', { at: 'ahoge' });
    ok('戳呆毛说的是「呆毛」那一桶（用户报的那条 bug 的正解）',
      textsOf(lines.pokeArea.ahoge).includes(ahogePoke.beats[0].text));
    const hairAgain = await touchOwnSay('poke', { at: 'hair' });
    ok('再戳回头发还算"新的一下"（不是「又戳」）', textsOf(lines.pokeArea.hair).includes(hairAgain.beats[0].text));
    const tailPet = await touchOwnSay('pet', { at: 'tail' });
    ok('蹭尾巴说的是「尾巴」那一桶', textsOf(lines.petArea.tail).includes(tailPet.beats[0].text));
    const chinPet = await touchOwnSay('pet', { at: 'chin' });
    ok('蹭下巴说的是「下巴」那一桶（小部位也有自己的话）',
      textsOf(lines.petArea.chin).includes(chinPet.beats[0].text));

  },
};
