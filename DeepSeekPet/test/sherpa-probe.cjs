/**
 * 实测 sherpa-onnx 的离线 TTS（中文 piper 模型：tokens + lexicon + 三个规则 FST）。
 *
 *   node test\sherpa-probe.cjs <tts.exe> <model-dir> <out.wav> [文本]
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const [exe, dir, out, ...rest] = process.argv.slice(2);
if (!exe || !dir || !out) {
  console.error('用法: node test\\sherpa-probe.cjs <tts.exe> <model-dir> <out.wav> [文本]');
  process.exit(2);
}
const text = rest.join(' ') || '晚上好呀。我是大肥鱼，今天也一起吧。';
const p = (f) => path.join(dir, f);

const args = [
  `--vits-model=${p('zh_CN-chaowen-medium.onnx')}`,
  `--vits-tokens=${p('tokens.txt')}`,
  `--vits-lexicon=${p('lexicon.txt')}`,
  `--tts-rule-fsts=${p('date.fst')},${p('number.fst')},${p('phone.fst')}`,
  `--output-filename=${out}`,
  '--num-threads=4',
  text,
];

const t0 = Date.now();
// cwd 设在模型目录：sherpa 的报错里提到过相对路径，省得路径里的空格/单引号来回转义
const child = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'], cwd: dir });
let log = '';
child.stdout.on('data', (c) => { log += c.toString(); });
child.stderr.on('data', (c) => { log += c.toString(); });
child.on('error', (e) => { console.error('spawn 失败:', e.message); process.exit(1); });
const guard = setTimeout(() => { child.kill(); console.error('超时 60s，已终止'); }, 60000);
child.on('close', (code) => {
  clearTimeout(guard);
  console.log(`退出码 ${code} · 耗时 ${Date.now() - t0}ms`);
  // 完整日志落到文件里：这个二进制的报错行不一定匹配下面的过滤条件
  fs.writeFileSync(path.join(process.cwd(), 'sherpa-last.log'), log);
  console.log('--- 原始输出（前 20 行）---');
  console.log(log.trim().split('\n').slice(0, 20).join('\n') || '（一个字都没有）');
  if (fs.existsSync(out)) {
    const bytes = fs.statSync(out).size;
    console.log(`输出 ${(bytes / 1024).toFixed(1)} KB ≈ ${Math.round((bytes - 44) / (22050 * 2) * 1000)}ms 音频`);
  } else {
    console.log('没有输出文件');
  }
  process.exit(0);
});
