/**
 * 自检区域：情绪识别
 * 从原 `test\smoke.cjs` 切出来的，**代码一字未改**（只把裸模块名换成 `ctx.*`）。
 * 单跑：`node test\smoke.cjs tone`
 */
module.exports = {
  name: "情绪识别",
  tags: ['tone', '情绪'],
  async run(ctx) {
    /** 区域文件里保持原样的模块名：从 ctx 上解构出来（属性名 'pet:' 之类因此不受影响）。 */
    const { __mark, FILES, fs, path, pathToFileURL, http, pet, lines, llm, store, checkLines, pageAreas, pageStages, pageGrabParts,
      textsOf, textsFilled, base, port, WebSocket, ok } = ctx;
    /* ---------- 2d. 本地情绪识别（不花 token 的那一层"懂你"） ---------- */
    /**
     * 关键词表就是产品行为：改 `TONE` 的顺序 = 改优先级。所以这里既验"认得出来"，
     * 也验**容易混淆的那几句**答对（"今天累死了"必须算累，不能因为有个"好"字算开心）。
     */
    ok('情绪：认出"累"', pet.readTone('今天好累啊') === 'tired' && pet.readTone('加班到十点') === 'tired');
    ok('情绪：累优先于开心（"累死了，总算搞定了"）', pet.readTone('累死了，总算搞定了') === 'tired');
    ok('情绪：认出"难过"', pet.readTone('有点难过') === 'sad');
    ok('情绪：认出"生气"', pet.readTone('气死我了') === 'angry');
    ok('情绪：认出"谢谢"和"夸它"', pet.readTone('谢谢你') === 'thanks' && pet.readTone('你好可爱') === 'praise');
    ok('情绪：认出"关心它"和"开心"', pet.readTone('你没事吧') === 'worried' && pet.readTone('哈哈哈太好了') === 'happy');
    ok('情绪：普通的话读不出情绪（读不出是常态）', pet.readTone('今天几号') === '' && pet.readTone('') === '');
    ok('情绪：每个关键词桶都有台词，而且键跟 TONE 对得上',
      pet.TONE.every(([name]) => Array.isArray(lines.emotion?.[name]) && lines.emotion[name].length > 0)
      && Object.keys(lines.emotion || {}).every((k) => pet.TONE.some(([n]) => n === k)));
    ok('情绪：听出来的情绪会变成给模型的一句提示', /累/.test(pet.readTone('好累') ? '用户听起来很累' : ''));
  },
};
