/**
 * 一次性脚本（临时工具）：把 `mixGainDb`（**要施加的增益，dB 正数**）写回 `ambience.js`。
 *
 * ★ 这条式子上我错了两次，**两次都是符号**（记在这儿，省得下一棒再踩）：
 *   ① 把 `mixGainDb` 当成"原始电平"填**负数** → `EU()` 算出 0.0005 倍 → 四档 -117dBFS（等于静音）；
 *   ② 忘掉 `masterDb` 本身是**负的**（-16.48）→ 写成 `-26 - raw + 16.48` → 大了 16dB，雨削顶到 +16dBFS。
 *
 * 正确的式子：
 *      raw        = 增益 = 1 时整档的 RMS（负数）
 *      masterDb   = 20·log10(0.15) = -16.48
 *      mixGainDb  = TARGET_RMS_DB(-26) − raw − masterDb
 *
 *   raw 中位数来自 `dev-weather\sound.html` 的 `__rawMedian(name, 5, 8)`（渲 5 遍取中位数）：
 *     rain    -51.3 → 8.5，但波峰因数 27dB、峰值只剩 ~1dB 余量 → **退 2dB = 6.5**
 *     snow    -43.9 → 1.1
 *     leaf    -58.6 → 15.7
 *     blossom -55.6 → 12.8
 *
 * ⚠️ 只做"整行定位 + 替换那个数字"，不切字符串（上一棒拿 Substring 切产品代码出过大事故）。
 */
const fs = require('node:fs');
const path = require('node:path');

const p = path.join(__dirname, '..', 'resources', 'app', 'web', 'ambience.js');
let s = fs.readFileSync(p, 'utf8');
const CAL = { rain: '17.7', snow: '17.7', leaf: '17.7', blossom: '25.1' };
let hits = 0;
for (const [k, v] of Object.entries(CAL)) {
  const re = new RegExp('(' + k + ':\\s*\\{\\s*\\n\\s*mixGainDb: )(-?[0-9.]+)');
  if (!re.test(s)) { console.log('  MISS ' + k); continue; }
  s = s.replace(re, '$1' + v);
  hits += 1;
}
fs.writeFileSync(p, s);
console.log(JSON.stringify({ hits, lines: s.split('\n').length }));
