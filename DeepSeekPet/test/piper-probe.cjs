/**
 * 实测 Piper：把中文写进 piper.exe 的 stdin（UTF-8），量一下合成耗时和产物大小。
 * 这就是将来 pet.cjs 要用的调用方式，所以在这里先验证它能不能跑通。
 *
 *   node test\piper-probe.cjs <piper.exe> <model.onnx> <out.wav> "要说的话"
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');

const [exe, model, out, ...rest] = process.argv.slice(2);
const text = rest.join(' ') || '晚上好呀。我是大肥鱼，今天也一起吧。';

const t0 = Date.now();
const child = spawn(exe, ['--model', model, '--output_file', out], { stdio: ['pipe', 'pipe', 'pipe'] });
let err = '';
child.stderr.on('data', (c) => { err += c.toString(); });
child.stdout.on('data', () => {});
child.on('error', (e) => { console.error('spawn 失败:', e.message); process.exit(1); });
child.on('close', (code) => {
  const ms = Date.now() - t0;
  console.log(`piper 退出码 ${code} · 耗时 ${ms}ms`);
  if (err.trim()) console.log('stderr:', err.trim().split('\n').slice(0, 3).join('\n'));
  if (fs.existsSync(out)) {
    const bytes = fs.statSync(out).size;
    console.log(`输出 ${(bytes / 1024).toFixed(1)} KB ≈ ${Math.round((bytes - 44) / (22050 * 2) * 1000)}ms 音频`);
  } else {
    console.log('没有输出文件');
  }
  process.exit(code === 0 ? 0 : 1);
});
child.stdin.end(text, 'utf8');
