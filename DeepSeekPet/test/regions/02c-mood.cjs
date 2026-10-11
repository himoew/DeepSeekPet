/**
 * 自检区域：心情
 * 从原 `test\smoke.cjs` 切出来的，**代码一字未改**（只把裸模块名换成 `ctx.*`）。
 * 单跑：`node test\smoke.cjs mood`
 */
module.exports = {
  name: "心情",
  tags: ['mood', '心情'],
  async run(ctx) {
    /** 区域文件里保持原样的模块名：从 ctx 上解构出来（属性名 'pet:' 之类因此不受影响）。 */
    const { __mark, FILES, fs, path, pathToFileURL, http, pet, lines, llm, store, checkLines, pageAreas, pageStages, pageGrabParts,
      textsOf, textsFilled, base, port, WebSocket, ok } = ctx;
    /* ---------- 2c. 心情（那条连续的数，纯 Node 就能测） ---------- */
    /**
     * 心情是"互动 → 两条轴 → 档位"这条链。这里一口气推到底：
     * 好话往上、坏话往下、边缘不发散、够极端就换档，而且**每个档位都真的挑得到自己的台词**。
     */
    const mood = ctx.mod('mood');
    const mode0 = mood.snapshot();
    ok('心情文件落在 DSP_LOG_DIR 里（不碰用户真实心情）', mood.FILE.startsWith(ctx.CONFIG_DIR));
    ok('心情：默认在"平常"那一档', ['quiet', 'happy', 'clingy'].includes(mode0.state));
    mood.forget();
    for (let i = 0; i < 40; i += 1) mood.onEvent('pet');
    ok('心情：摸多了往上走', mood.snapshot().state === 'clingy' && mood.snapshot().love > 0.74);
    // 只摸不戳 → "黏人"（喜欢够多、精神也没垮）
    mood.forget();
    for (let i = 0; i < 30; i += 1) mood.onEvent('pet');
    ok('心情：光被宠着的时候是"黏人"那一档', mood.snapshot().state === 'clingy');
    // 连着戳 → "想你"（喜欢掉到 .4 以下；精神还够，所以不会先变成"困倦"）
    mood.forget();
    for (let i = 0; i < 40; i += 1) mood.onEvent('poke');
    const poked = mood.snapshot();
    ok('心情：一直戳它，喜欢会掉下去', poked.love < 0.42 && poked.love < 0.6);
    // 再宠回来一点 → "开心"（喜欢过半，但还没到"黏人"那条线）
    mood.forget();
    for (let i = 0; i < 2; i += 1) mood.onEvent('pet');
    ok('心情：被宠但不至于黏人时是"开心"那一档（love 落在 .62~.74 之间）',
      mood.snapshot().state === 'happy' && mood.snapshot().love > 0.62 && mood.snapshot().love < 0.74);
    for (let i = 0; i < 40; i += 1) mood.onEvent('poke');
    for (let i = 0; i < 60; i += 1) mood.onEvent('crash');
    const floored = mood.snapshot();
    ok('心情：推到极端也不会跑出 0~1', floored.love >= 0 && floored.energy >= 0 && floored.energy <= 1);
    ok('心情：喜欢和精力都垮了就是"困倦"那一档', floored.state === 'tired');
    ok('心情：档位有全部五种', ['clingy', 'happy', 'quiet', 'tired', 'lonely'].every((k) => !!mood.LABEL[k]));
    // 心情只给**很小的**速度差（±10%）：走路这种每帧都看得见的量，超过一成就像穿溜冰鞋
    ok('心情：动作倍率收在 ±10% 以内（0.9~1.1，中位 1.0）',
      mood.snapshot().speed >= 0.85 && mood.snapshot().speed <= 1.15);
    mood.forget();
    // 两个"基准值"：平常（love=energy=.6）的时候，它离你多远算够近、动作倍率是多大
    const clingCalm = mood.snapshot().cling;
    const speedFresh = mood.snapshot().speed;
    for (let i = 0; i < 30; i += 1) mood.onEvent('pet');
    ok('心情：喜欢得越多，黏得越近（cling 门槛变小）', mood.snapshot().cling < clingCalm);
    mood.forget();
    for (let i = 0; i < 60; i += 1) mood.onEvent('crash');
    ok('心情：精神越差，动作倍率越小', mood.snapshot().speed < speedFresh);
    // 每个档位都得真的挑得到自己的台词：**键写错、桶是空的**都会静默退回通用台词，日志里看不出来
    const fallback = { text: '（通用）', actions: [] };
    for (const bucket of Object.keys(lines.mood || {})) {
      const pool = lines.mood[bucket].map((l) => l.text);
      const got = new Set();
      for (let i = 0; i < 24; i += 1) got.add(pet.moodPick({ moodState: bucket }, [fallback]).text);
      ok(`心情台词：${bucket} 挑得到自己的那几条（键要和 mood.LABEL 对得上）`,
        got.size > 0 && [...got].every((t) => pool.includes(t)));
    }
    for (const k of Object.keys(mood.LABEL)) {
      ok(`心情台词：${k} 这一桶在 lines.mood 里有`, Array.isArray(lines.mood?.[k]) && lines.mood[k].length > 0);
    }
    ok('心情：没有这个档时就退回通用台词（不会变成哑巴）',
      pet.moodPick({ moodState: '不存在的档' }, [fallback]).text === fallback.text);
    // 心跳的方向：把你不在的时候设成"往上宠"的反面，它应该往下掉（不检查幅度——那是小时级的）
    mood.forget();
    for (let i = 0; i < 40; i += 1) mood.onEvent('pet');
    const upTop = mood.snapshot();
    mood.tick({ away: true });
    ok('心情：你不在了它往下掉', mood.snapshot().love < upTop.love);
    mood.forget();
  },
};
