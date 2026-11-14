#!/usr/bin/env node
/**
 * 一次性清洗：把"逐句流水账 / 工程细节"从长期记忆里挪进 archive/legacy/。
 *
 * 背景（2026-10-30 评审）：
 *   - 2026-10-27 迁移把 people.json 的旧 topics 整批转成了长期记忆，内容基本是
 *     `✏️：再试试 → 行，再试一次。` 这种逐句对话，等于把聊天记录抄了一份；
 *   - 另有少量条目在记功能/模块/API/桌宠这类工程细节，不是"他的稳定信息"。
 *   它们会挤占检索预算（桌宠只有 400 token），也会让"回忆"变成"复读"。
 *
 * 安全：
 *   - 默认 dry-run，只打印；加 `--apply` 才真的移动；
 *   - 移动 = 改名到 `memory/archive/legacy/`，**不删**；
 *   - 动手前把 `data/companion/` 备份到 `data/companion/backups/memory-<时间>/`。
 *
 * 用法：
 *   node tools\memory-prune.cjs                       # 看会清哪些
 *   node tools\memory-prune.cjs --apply               # 真移（先自动备份）
 *   node tools\memory-prune.cjs --apply --data D:\pet\DeepSeekPet\data\companion
 */
const fs = require('node:fs');
const path = require('node:path');

const APP = path.resolve(__dirname, '..', 'resources', 'app');
const { CompanionMemory } = require(path.join(APP, 'companion-memory.cjs'));
const { LongMemory } = require(path.join(APP, 'long-memory.cjs'));

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const noBackup = args.includes('--no-backup');
const dataArg = args.indexOf('--data');
const dataDir = dataArg >= 0 && args[dataArg + 1]
  ? path.resolve(args[dataArg + 1])
  : path.resolve(__dirname, '..', 'data', 'companion');

if (!fs.existsSync(dataDir)) {
  console.error(`数据目录不存在：${dataDir}`);
  process.exit(2);
}

/** 工程/功能类词：出现在长期记忆正文里，多半不是"他这个人"的稳定信息。 */
const ENGINEERING = /API|接口|自检|部署|网关|模块|代码|项目进度|桌宠|陪伴模式|重复记忆|记忆机制|功能/;

function reasonOf(entry) {
  if (entry.source === 'migrated') return '迁移流水账';
  if (String(entry.body).includes('→')) return '逐句对话';
  if (ENGINEERING.test(entry.body)) return '工程细节';
  return '';
}

function backup() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dir = path.join(dataDir, 'backups', `memory-${stamp}`);
  fs.mkdirSync(dir, { recursive: true });
  const memoryDir = path.join(dataDir, 'memory');
  if (fs.existsSync(memoryDir)) fs.cpSync(memoryDir, path.join(dir, 'memory'), { recursive: true });
  for (const name of ['people.json', 'memory-state.json', 'self.jsonl']) {
    const from = path.join(dataDir, name);
    if (fs.existsSync(from)) fs.copyFileSync(from, path.join(dir, name));
  }
  return dir;
}

const memory = new CompanionMemory({ dir: dataDir });
const longMemory = new LongMemory({ dir: dataDir, memory, log: { info() {}, warn() {} } }).init();

const rows = longMemory.list()
  .map((entry) => ({ entry, reason: reasonOf(entry) }))
  .filter((row) => row.reason);

console.log(`数据目录：${dataDir}`);
console.log(`现有长期记忆：${longMemory.list().length} 条；命中清洗规则：${rows.length} 条\n`);
console.log('原因             kind     importance  正文');
console.log('---------------  ------   ----------  ----------------------------------------');
for (const { entry, reason } of rows) {
  const preview = String(entry.body).replace(/\s+/g, ' ').slice(0, 44);
  console.log(`${reason.padEnd(15)}  ${String(entry.kind).padEnd(6)}   ${String(entry.importance).padEnd(9)}  ${preview}`);
}

if (!apply) {
  console.log('\n这是 dry-run，没有动任何文件。确认无误后加 --apply。');
  process.exit(0);
}
if (!rows.length) {
  console.log('\n没有需要清洗的条目。');
  process.exit(0);
}

if (!noBackup) {
  const dir = backup();
  console.log(`\n已备份到：${dir}`);
}

const ids = new Set(rows.map((row) => row.entry.id));
const result = longMemory.prune((entry) => ids.has(entry.id));
const stats = longMemory.stats();
console.log(`\n已移入 ${result.dir}：${result.moved} 条（不删）。`);
console.log(`剩余：${stats.count} 条 / ${stats.tokens} token；分类 ${JSON.stringify(stats.byKind)}`);
