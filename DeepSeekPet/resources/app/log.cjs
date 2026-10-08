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

function stamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 23);
}

function write(line) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(file) && fs.statSync(file).size > MAX_BYTES) fs.writeFileSync(file, '');
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
  info: (msg) => write(`INFO  ${msg}`),
  warn: (msg) => write(`WARN  ${msg}`),
  error: (msg) => write(`ERROR ${msg}`),
  fatal: (msg, err) => write(`FATAL ${msg}\n${(err && err.stack) || String(err)}`),
};
