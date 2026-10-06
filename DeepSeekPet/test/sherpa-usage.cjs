/**
 * 看 sherpa TTS 的用法：不带参数或带 --help 跑一下，把它的输出抓回来。
 * 它自己会等 stdin，所以用 no-arg 跑并给一个空的 stdin（立刻 EOF）。
 *
 *   node test\sherpa-usage.cjs <tts.exe> [--help]
 */
const { spawn } = require('node:child_process');

const [exe, ...more] = process.argv.slice(2);
const child = spawn(exe, more, { stdio: ['pipe', 'pipe', 'pipe'] });
let out = '';
child.stdout.on('data', (c) => { out += c.toString(); });
child.stderr.on('data', (c) => { out += c.toString(); });
const kill = setTimeout(() => { child.kill(); }, 15000);
child.on('close', (code) => {
  clearTimeout(kill);
  console.log(`退出码 ${code}\n${out.trim()}`);
  process.exit(0);
});
child.stdin.end('');            // 立刻 EOF：别让它等输入
