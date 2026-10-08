/**
 * 小 JSON 文件的读与写 —— 全项目**唯一**一处落盘实现。
 *
 * 为什么值得单独一个文件：原来 mood / memory / dress / voice.json / llm / pet-pos 各写一份
 * `fs.writeFileSync(JSON.stringify(…))`，于是几处都有同一个问题：
 * **直接覆写目标文件** —— 写到一半崩溃/掉电就留下半截 JSON；而读它的一方只会"退回默认值"，
 * 紧接着一次保存就把用户真实的数据（API Key、人设、心情、记忆）静默顶掉。
 * 配置那次实测踩过，靠动手前的一份 `.bak` 才救回来（见 HANDOVER 第 8 节 18）。
 *
 * 这里统一成**先写临时文件再改名**：`rename` 在同一个目录内是原子的，
 * 所以目标文件要么是完整的旧内容、要么是完整的新内容，不存在"半截"。
 *
 * 读：剥掉开头的 BOM（PowerShell 的 `Set-Content -Encoding utf8`、记事本另存为都会加，
 * 而且**重复写一次就多一个**），解析失败一律返回 `null` —— **退回什么默认值由调用方决定**，
 * 这里不做任何"帮你补全"的事（那正是上面那个坑的另一半）。
 */
const fs = require('node:fs');
const path = require('node:path');

/** 读一个 JSON 文件。文件不在 / 读不动 / 不是合法 JSON，一律返回 null。 */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^[\uFEFF\s]+/, ''));
  } catch {
    return null;
  }
}

/**
 * 原子写一个 JSON 文件（缩进 2 + 末尾换行，方便用户自己打开看）。
 * **成功返回 `null`，失败返回那个 Error** —— 调用方按自己的方式记日志（有的是 warn，
 * 有的只是安静地算了），所以这里不打印任何东西。
 *
 * 临时文件名固定为 `<文件>.tmp`：写它的都是同一个进程里的同步调用，不会并发。
 */
function writeJson(file, data) {
  const tmp = `${file}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
    fs.renameSync(tmp, file);
    return null;
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* 临时文件没建起来就算了 */ }
    return err;
  }
}

module.exports = { readJson, writeJson };
