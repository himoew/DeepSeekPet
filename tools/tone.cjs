/**
 * 看它实际会怎么说话 —— 用当前配置（含人设）问你几句，把原文和耗时打出来。
 *
 *   node tools\tone.cjs                     问几句固定的
 *   node tools\tone.cjs "今天好累啊" "陪我聊天"   问你自己的
 *
 * 换完模型或改完人设跑一下，比在设置里点「测试连接」看得更清楚：这里是多轮对话，
 * 而且和桌宠走的是同一个函数（llm.chat）。不需要 Electron。
 */
const path = require('node:path');

const app = path.join(__dirname, '..', 'resources', 'app');
const llm = require(path.join(app, 'llm.cjs'));

const DEFAULT_PROMPTS = ['在吗', '今天好累啊', '那你说点开心的'];
const prompts = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_PROMPTS;

(async () => {
  const cfg = llm.load();
  console.log(`模型      ${cfg.model}`);
  console.log(`供应地址  ${cfg.baseUrl}${cfg.apiKey ? '  (带 Key)' : ''}`);
  console.log(`人设      ${cfg.persona.split('\n')[0]} …`);
  console.log(`参数      maxTokens=${cfg.maxTokens}  keepAlive=${cfg.keepAlive || '(不发)'}`);
  if (!llm.isOn()) {
    console.log('\n注意：配置里 enabled=false，桌宠现在用的是内置台词，不会问模型。');
  }
  console.log('─'.repeat(64));

  const history = [];
  for (const text of prompts) {
    const started = Date.now();
    try {
      const reply = await llm.chat(history, text);
      const ms = Date.now() - started;
      console.log(`你：${text}`);
      console.log(`它：${reply}`);
      console.log(`    ${(ms / 1000).toFixed(1)}s · ${reply.length} 字\n`);
      history.push({ role: 'user', content: text }, { role: 'assistant', content: reply });
    } catch (err) {
      console.log(`你：${text}`);
      console.log(`    ✗ ${err.message}\n`);
    }
  }
  const q = llm.load().quick ?? {};
  console.log('（第一次通常含模型加载，后面的才是它的真实速度）');
})().catch((err) => {
  console.error(`失败：${err.message}`);
  process.exit(1);
});
