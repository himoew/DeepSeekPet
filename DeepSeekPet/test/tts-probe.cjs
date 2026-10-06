/**
 * 实测 tts.cjs：可用性、预热、合成耗时、缓存命中。
 *
 *   node test\tts-probe.cjs
 */
const path = require('node:path');
const fs = require('node:fs');

const tts = require(path.join(__dirname, '..', 'resources', 'app', 'tts.cjs'));

console.log('可用:', tts.available(), tts.available() ? '' : '—— ' + tts.why());
if (!tts.available()) process.exit(1);

const t0 = Date.now();
tts.warm();
console.log('已请求预热（后台加载模型）');

(async () => {
  for (const [i, text] of ['你好呀。', '晚上好呀。我是大肥鱼，今天也一起吧。', '你好呀。'].entries()) {
    const at = Date.now();
    const r = await tts.speak(text);
    if (!r) { console.log(`第 ${i + 1} 句失败`); continue; }
    const sec = ((r.wav.length - 44) / 2 / 22050).toFixed(2);
    console.log(`第 ${i + 1} 句「${text}」→ 耗时 ${Date.now() - at}ms（合成 ${r.ms}ms）· ${sec}s 音频 · ${(r.wav.length / 1024).toFixed(0)}KB`);
    if (i === 0) fs.writeFileSync(path.join(__dirname, '..', 'tools', 'tts', 'sample-tts-module.wav'), r.wav);
  }
  console.log(`总耗时 ${Date.now() - t0}ms`);
  tts.close();
  process.exit(0);
})();
