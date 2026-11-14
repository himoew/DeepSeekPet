#!/usr/bin/env node
/**
 * 人物账整理：把 traits/facts 里的近义重复合并掉（保留更具体的那句）。
 *
 * 背景：以前只挡"完全同一句"，于是真机上同时出现过
 *   「尊重对方自主性」和「尊重对方自主性，不把对方当桌宠」。
 * 现在 `CompanionMemory.applyProfile/remember` 写入时就会合并；这个工具用来
 * 清理**已经写进去**的历史重复，也可以每月巡账时跑一次。
 *
 * 用法：
 *   node tools\memory-compact.cjs                                   # 只看会合并几处
 *   node tools\memory-compact.cjs --apply                           # 真改（先备份 people.json）
 *   node tools\memory-compact.cjs --apply --data D:\pet\DeepSeekPet\data\companion
 */
const fs = require('node:fs');
const path = require('node:path');

const APP = path.resolve(__dirname, '..', 'resources', 'app');
const { CompanionMemory } = require(path.join(APP, 'companion-memory.cjs'));

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const noBackup = args.includes('--no-backup');
const dataArg = args.indexOf('--data');
const dataDir = dataArg >= 0 && args[dataArg + 1]
  ? path.resolve(args[dataArg + 1])
  : path.resolve(__dirname, '..', 'data', 'companion');

const peopleFile = path.join(dataDir, 'people.json');
if (!fs.existsSync(peopleFile)) {
  console.error(`people.json 不存在：${peopleFile}`);
  process.exit(2);
}

const memory = new CompanionMemory({ dir: dataDir });
const all = memory.allPeople();

console.log(`人物账：${peopleFile}`);
for (const [id, person] of Object.entries(all)) {
  const t = (person.traits || []).length;
  const f = (person.facts || []).length;
  console.log(`  ${person.name || id}（${id}）：${t} traits / ${f} facts`);
}

// dry-run 时只算不写（compactAll 的 apply:false）
if (!apply) {
  const merged = memory.compactAll({ apply: false });
  console.log(`\n可合并：${merged} 处（dry-run，没有动 people.json）`);
  console.log('确认无误后加 --apply。');
  process.exit(0);
}

if (!noBackup) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backup = path.join(dataDir, `people.json.bak-${stamp}`);
  fs.copyFileSync(peopleFile, backup);
  console.log(`\n已备份：${backup}`);
}
const merged = memory.compactAll();
const after = memory.allPeople();
console.log(`\n合并：${merged} 处`);
for (const [id, person] of Object.entries(after)) {
  console.log(`  ${person.name || id}：${(person.traits || []).length} traits / ${(person.facts || []).length} facts`);
}
if (!merged) console.log('（没有可合并的）');
