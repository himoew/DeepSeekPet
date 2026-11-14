/**
 * 自检区域：**QQ 昵称前缀**（`companion-onebot.stripNamePrefix`，2026-11-05）
 *
 * 真机：他发来的每条正文都长成 `✏️：我回来了`（`✏️` 是他的 QQ 昵称），
 * 实测 **994 / 1153 轮**带着它，而它会一路进她的回看（messages）、证词（`evidence.quote`）、
 * BM25 的检索词。用户在 2026-11-05 看过日志后确认："安全的，那就删"。
 *
 * 这一区验三件事：
 *   ① 只剥**发送者自己的名字**（别人名字开头的话不动）；
 *   ② 剥完是空的就**不剥**（别把他唯一那句话变成空串）；
 *   ③ 入站那条路上**真的接上了**（源代码守卫，防止以后被人删掉）。
 *
 * 纯逻辑，0.2 秒：`node test\run-one.cjs 25-nick-prefix.cjs`
 */
module.exports = {
  name: 'QQ 昵称前缀（正文开头的「✏️：」）',
  tags: ['onebot', 'nickname', '前缀', 'qq'],
  async run(ctx) {
    const { ok } = ctx;
    const onebot = ctx.mod('companion-onebot');
    const strip = onebot.stripNamePrefix;

    ok('昵称前缀：把他的昵称 + 全角冒号剥掉', strip('✏️：我回来了', '✏️') === '我回来了');
    ok('昵称前缀：半角冒号也认', strip('✏️:今天吃什么', '✏️') === '今天吃什么');
    ok('昵称前缀：没有前缀就一个字都不动', strip('我回来了', '✏️') === '我回来了');
    ok('昵称前缀：别人名字开头的话不动（群里不能乱剥）',
      strip('小主：我回来了', '✏️') === '小主：我回来了');
    ok('昵称前缀：剥完是空的就保留原文（别把唯一那句话弄没）',
      strip('✏️：', '✏️') === '✏️：' && strip('✏️：   ', '✏️') === '✏️：   ');
    ok('昵称前缀：昵称里有正则元字符也不炸（用 startsWith，不拼正则）',
      strip('a.b：你好', 'a.b') === '你好' && strip('a.b：你好', 'aXb') === 'a.b：你好');
    /**
     * ★ 2026-11-05 第二次真机：他有**群名片"小主" + 昵称"✏️"**，只拿第一个名字去剥等于没剥
     * （20:50 那条 `✏️：想象一下你的小手` 就是这么漏进来的）。现在收一串候选名字。
     */
    ok('昵称前缀：名片和昵称不一样时，两个都要试',
      strip('✏️：想象一下你的小手', ['小主', '✏️']) === '想象一下你的小手');

    const src = fs.readFileSync(path.join(app, 'companion-onebot.cjs'), 'utf8');
    ok('昵称前缀：入站那条路上真的接上了（不是只加了个没用到的函数）',
      src.includes('text: stripNamePrefix(rawText, nameCands)'));
    ok('昵称前缀：候选名字是【名片 + 昵称】两个（别只取 card）',
      src.includes('[ev.sender?.card, ev.sender?.nickname]'));
    ok('昵称前缀：只剥 text，不碰别人 / 不碰她自己的话',
      !/stripNamePrefix\([^)]*reply/.test(src));
  },
};
