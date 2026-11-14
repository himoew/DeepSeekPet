/**
 * The one log: <app>\data\pet.log, truncated once it passes half a megabyte
 * so the latest run is always the readable part.
 *
 * The path follows the *app*, not `process.execPath`: the pet may be started by
 * its own bundled runtime or by an external Coopanion install, and its data has
 * to stay with the app either way. (`__dirname` is `<app>\resources\app`.)
 *
 * `DSP_LOG_DIR` sends it somewhere else — `test\smoke.cjs` uses that so its fake
 * model traffic does not land in the pet's own log and bury the real thing.
 */
const fs = require('node:fs');
const path = require('node:path');

const dir = process.env.DSP_LOG_DIR || path.join(__dirname, '..', '..', 'data');
const file = path.join(dir, 'pet.log');
const MAX_BYTES = 512 * 1024;

const pad = (n, w = 2) => String(n).padStart(w, '0');

/**
 * ★ 2026-11-01：**本地时间**，末尾带时区偏移。
 *
 * 原来是 `new Date().toISOString()` —— 那是 **UTC**，在这台机器上比本地慢 8 小时。
 * 查"她为什么把早上说成大半夜"的时候，日志里 `[2026-11-01 00:35]` 其实是早上 08:35，
 * 一眼看过去"大半夜"还完全正确，把判断带沟里了（这次就是这么被坑的）。
 * 现在写成 `2026-11-01 08:35:42.031 +08:00`，跟聊天记录、跟你的直觉一样。
 */
function stamp() {
  const d = new Date();
  const off = -d.getTimezoneOffset();          // 分钟；东八区 = 480
  const sign = off >= 0 ? '+' : '-';
  const a = Math.abs(off);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
    + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)} `
    + `${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

/**
 * ★ 2026-11-01：**超过 512KB 轮转，不要清空**。
 *
 * 原来是 `writeFileSync(file, '')`：正好出事的那一段日志被自己吃掉，
 * 第二天查"她为什么哑了"只剩空白。（`pet-host.cjs` 早就是 `.1` 轮转了，这里抄它。）
 */
function rotateIfNeeded(limit = MAX_BYTES) {
  try {
    if (!fs.existsSync(file) || fs.statSync(file).size <= limit) return false;
    try { fs.renameSync(file, `${file}.1`); } catch { try { fs.writeFileSync(file, ''); } catch { return false; } }
    return true;
  } catch {
    return false;
  }
}

function write(line) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    rotateIfNeeded();
    fs.appendFileSync(file, `[${stamp()}] ${line}\n`);
  } catch {
    // a pet must not die because its log could not be written
  }
  try {
    if (process.stdout && process.stdout.writable) process.stdout.write(`${line}\n`);
  } catch {
    // no console attached (started from Explorer): the file is enough
  }
}

module.exports = {
  file,
  maxBytes: MAX_BYTES,
  rotateIfNeeded,
  info: (msg) => write(`INFO  ${msg}`),
  warn: (msg) => write(`WARN  ${msg}`),
  error: (msg) => write(`ERROR ${msg}`),
  fatal: (msg, err) => write(`FATAL ${msg}\n${(err && err.stack) || String(err)}`),
};
