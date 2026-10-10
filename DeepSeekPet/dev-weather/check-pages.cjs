/**
 * ============================================================================
 * 把 dev-weather 里几个页面的 `<script>` 抽出来做语法检查（临时工具）
 * ============================================================================
 *
 * ★ **为什么值得单独一个工具**：2026-10-11 这一棒里，两个验收页各被**一个反引号**写死过
 *   （模板字符串里的 `` ` `` 提前把字符串收了尾）。浏览器只会在控制台说一句
 *   "Unexpected identifier"，而**页面上什么都不显示** —— 表现就是"页面是空的、什么都没说"，
 *   跟"特效没接上"长得一模一样，非常费时间。
 *
 * 现在一条命令扫全部：
 *     node dev-weather\check-pages.cjs
 *
 * 它只读文件、写一个临时 .mjs 到系统临时目录，退出码非 0 = 有页面写坏了。
 */
const fs = require('node:fs');
const path = require('node:path');

const here = __dirname;
const pages = fs.readdirSync(here).filter((f) => f.endsWith('.html'));
let bad = 0;

/**
 * ★ **不用 `child_process` 跑 `node --check`**（2026-10-11 踩到）：这个工作区的沙箱**不允许
 * 子进程的管道 stdio**（`spawnSync ... EPERM`），所以"把脚本写出去再让另一个 node 检查"这条路走不通。
 * 也**不用 `vm.SourceTextModule`**：它要 `--experimental-vm-modules`，默认拿不到（同样报错）。
 *
 * 改用 `new Function()`：它在**编译期**就能把语法错误抛出来，跟 `--check` 是同一件事。
 * ⚠️ 唯一的差别是模块语法（`import` / `export`）在函数体里不合法，所以先把**顶格的**
 * `import …` / `export …` 行剥掉再编译 —— 我们要抓的是"字符串引号配错、括号不闭合"这类
 * **真错误**（这一棒里两个页面就是各被一个反引号写死的），剥掉 import/export 不影响抓它们。
 */
function syntaxErrorOf(src, isModule) {
  let body = src;
  if (isModule) {
    body = src.replace(/^[ \t]*import\s+[^\n]*?from\s*['"][^'"]+['"]\s*;?[ \t]*$/gm, '')
      .replace(/^[ \t]*import\s*['"][^'"]+['"]\s*;?[ \t]*$/gm, '')
      .replace(/^[ \t]*export\s+(?=\{)/gm, '');
  }
  try {
    // eslint-disable-next-line no-new-func
    new Function(body);
    return null;
  } catch (e) { return e; }
}

for (const p of pages) {
  const src = fs.readFileSync(path.join(here, p), 'utf8');
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m, i = 0, count = 0;
  while ((m = re.exec(src))) {
    i += 1;
    const attrs = m[1] || '';
    const js = m[2];
    if (!js.trim()) continue;
    if (/\bsrc\s*=/.test(attrs)) continue;              // 外链脚本没有内联代码
    count += 1;
    const e = syntaxErrorOf(js, /type\s*=\s*["']module["']/.test(attrs));
    if (e) {
      bad += 1;
      console.log(`  FAIL ${p} <script#${i}>${/module/.test(attrs) ? ' [module]' : ''}\n    ${(e && e.message) || e}`);
    }
  }
  console.log(`  ${count ? 'ok  ' : 'skip'} ${p}（${count} 段内联脚本）`);
}
console.log(bad ? `\n${bad} 段脚本语法不过关 —— 先修，别去浏览器里找。` : '\n所有页面的内联脚本语法都通过。');
process.exit(bad ? 1 : 0);
