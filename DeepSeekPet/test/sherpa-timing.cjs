/**
 * 把"进程启动 + 模型加载"和"引擎内合成"分开计时：同一句话连跑几次看差异。
 * （sherpa 的 CLI 每次都要重新加载模型——这决定了延迟方案。）
 *
 *   node test\sherpa-timing.cjs <tts.exe> <model-dir> <out.wav>
 */
const { spawn } = require('node:child_process');
const path = require('node:path');

const [exe, dir, out] = process.argv.slice(2);
const p = (f) => path.join(dir, f);
const args = (text) => [
  `--vits-model=${p('zh_CN-chaowen-medium.onnx')}`,
  `--vits-tokens=${p('tokens.txt')}`,
  `--vits-lexicon=${p('lexicon.txt')}`,
  `--tts-rule-fsts=${p('date.fst')},${p('number.fst')},${p('phone.fst')}`,
  `--output-filename=${out}`,
  text,
];

const run = (text) => new Promise((resolve) => {
  const t0 = Date.now();
  const c = spawn(exe, args(text), { stdio: ['ignore', 'pipe', 'pipe'], cwd: dir });
  let log = '';
  c.stdout.on('data', (d) => { log += d; });
  c.stderr.on('data', (d) => { log += d; });
  c.on('close', () => {
    const eng = (log.match(/Elapsed seconds: ([\d.]+)/) || [])[1];
    const aud = (log.match(/Audio duration: ([\d.]+)/) || [])[1];
    resolve({ wall: Date.now() - t0, eng: eng ? Math.round(eng * 1000) : null, aud: aud ? Math.round(aud * 1000) : null });
  });
});

(async () => {
  for (let i = 1; i <= 3; i += 1) {
    const r = await run('晚上好呀。我是大肥鱼。');
    console.log(`第 ${i} 次：总 ${r.wall}ms | 引擎内合成 ${r.eng}ms | 音频 ${r.aud}ms | 进程启动+模型加载 ≈ ${r.wall - r.eng}ms`);
  }
  process.exit(0);
})();
