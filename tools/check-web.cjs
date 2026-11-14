/**
 * Syntax-only check of the page's ES modules: strip the import/export lines and compile the rest.
 * The pet page cannot be run outside Electron, so a compile is the cheapest way to catch a slip.
 *
 *   node tools\check-web.cjs
 */
const fs = require('node:fs');
const path = require('node:path');

const files = ['pet-app.js', 'pet-core.js'];
const dir = path.join(__dirname, '..', 'resources', 'app', 'web');
let bad = 0;
for (const f of files) {
  // import ... / export const ... / export { ... } 都要抹掉，否则 Function 不认这些语句
  const src = fs.readFileSync(path.join(dir, f), 'utf8')
    .replace(/^\s*import\s.*$/gm, (m) => `//${m}`)
    .replace(/^\s*export\s+/gm, '');
  try {
    // eslint-disable-next-line no-new-func
    new Function(src);
    console.log(`  ok  ${f}`);
  } catch (err) {
    console.error(`  FAIL ${f}: ${err.message}`);
    bad += 1;
  }
}
process.exit(bad ? 1 : 0);
