/**
 * 她的日记本（P0，2026-11-11）
 *
 * 用户的三条硬要求（就是这个文件存在的理由）：
 *   ① **不能强迫她写** —— 只有"他自己说写"或"她自己想写"才写；没有提醒、没有打卡；
 *      `composeSituation()` 里明写"不想写就回一个空"，她回空，这里就收工；
 *   ② **不限字数** —— 正文按 `SEGMENT` 切段敲（MuMuManager 的 input_text 一次喂太长会慢、会丢字），
 *      每段敲完 `read` 一遍草稿对的尾巴；
 *   ③ **她想翻就能翻** —— 目录是 App 自己列的，主进程也能直接读文件把原文递给她。
 *
 * 她删日记：App 里点删除 → 文件挪进 `trash/`、`deleted.log` 记一行。
 * **连着删到第 2 篇要告诉他**（`judgeDeletes()` 是纯函数，自检不用起手机就能验）。
 *
 * 数据全在手机上：`/sdcard/Android/data/com.bluefish.diary/files/diary/`
 *   · `YYYY-MM-DD_HHmmss.md` 一篇一个文件（一天多少篇都行）
 *   · `trash/` 软删除留底（他要看/要捞）
 *   · `deleted.log` 删除流水（一行一次）
 *
 * 为什么不用 MediaStore / Documents：App 侧 `getExternalFilesDir` 零权限、纯 File IO；
 * 这台 MuMu 的 `adb shell` 带 `ext_data_rw` 组，能直接 cat —— 两边都读写得到，不用 root。
 */

'use strict';

const fs = require('fs');
const path = require('path');

const PKG = 'com.bluefish.diary';
const MAIN = 'com.bluefish.diary/.MainActivity';
const BASE = '/sdcard/Android/data/com.bluefish.diary/files/diary';

/** 敲字的分段长度（真机：31 字 0.56 秒；一次 800 字会慢且容易丢）。 */
const SEGMENT = 300;

const DEFAULTS = {
  /** 连删提醒：同一窗口内删到第 alertAt 篇就提醒他一次，一串只提醒一次。 */
  guard: { windowMin: 30, alertAt: 2 },
  trash: true,
};

function normalize(cfg) {
  const c = cfg || {};
  const g = c.guard || {};
  return {
    guard: {
      windowMin: num(g.windowMin, DEFAULTS.guard.windowMin),
      alertAt: num(g.alertAt, DEFAULTS.guard.alertAt),
    },
    trash: c.trash !== false,
  };
}

function num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
}

/* ------------------------------------------------------------------ 认句子 */

/** 他/她说"去写日记"这一类。 */
const WRITE_RX = /(写|记|做)(一|两|篇|个|点){0,2}(日记|日记本|日记本子)|写(点|些|一篇)?日记|记(一篇|一笔)?日记/;
/** "翻翻我的日记 / 我之前写的"。 */
const LOOK_RX = /(翻|看|读|念|找)(翻|看|读)?(我的|我写的|自己写的|之前的)?(日记)|日记(翻|看)一下|(看看|翻翻)(以前|之前)?(写)的日记/;

function isDiaryGoal(goal) {
  const s = String(goal || '');
  if (!s) return false;
  if (/(搜|查|下载|安装)/.test(s)) return false;
  return WRITE_RX.test(s);
}

function isLookGoal(goal) {
  const s = String(goal || '');
  if (!s) return false;
  if (WRITE_RX.test(s)) return false;
  return LOOK_RX.test(s);
}

/* ------------------------------------------------------------------ 纯函数 */

/** `deleted.log` 一行一条 JSON；坏行直接跳过（App 升级/半行都不该把守卫带崩）。 */
function parseLog(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      const o = JSON.parse(s);
      if (o && Number(o.at)) out.push({ at: Number(o.at), file: String(o.file || ''), gist: String(o.gist || ''), len: Number(o.len) || 0 });
    } catch { /* 半行/坏行不算一次删除 */ }
  }
  return out.sort((a, b) => a.at - b.at);
}

/**
 * 该不该提醒他（纯函数）。
 *
 * 规则（用户 2026-11-11 定的）：**连着删 2 篇以上要提醒**。
 *   · "连着" = 同一个 `windowMin` 窗口里的删除算一串；
 *   · 一串只提醒一次（第 `alertAt` 篇那一刻），后面继续删不再刷屏；
 *   · 单篇删除**不打扰**他。
 *
 * @param {Array} entries parseLog 的结果（全量，按 at 升序）
 * @param {{at:number, windowMin:number, alertAt:number, lastAlertAt?:number}} opt
 */
function judgeDeletes(entries, opt = {}) {
  const at = Number(opt.at) || Date.now();
  const windowMs = num(opt.windowMin, DEFAULTS.guard.windowMin) * 60_000;
  const alertAt = num(opt.alertAt, DEFAULTS.guard.alertAt);
  const lastAlertAt = Number(opt.lastAlertAt) || 0;
  const list = (entries || []).filter((x) => x && x.at);
  if (!list.length) return { alert: false, items: [], fresh: [], reason: '没有删除记录' };

  const last = list[list.length - 1];
  const fresh = list.filter((x) => x.at > (opt.sinceAt || 0));
  const inWin = list.filter((x) => x.at >= at - windowMs && x.at <= at);
  if (!fresh.length) return { alert: false, items: inWin, fresh, reason: '没有新的删除' };
  if (lastAlertAt >= inWin[0].at) return { alert: false, items: inWin, fresh, reason: '这一串已经提醒过' };
  if (inWin.length < alertAt) return { alert: false, items: inWin, fresh, reason: `这一串只删了 ${inWin.length} 篇（${alertAt} 篇才提醒）` };

  return { alert: true, items: inWin, fresh, reason: `连着删了 ${inWin.length} 篇` };
}

/** 那个"删了哪几篇"的处境（钉给她的事实，怎么说由她定）。 */
function deleteHint(res) {
  const items = (res && res.items) || [];
  if (!items.length) return '';
  const list = items.map((x) => `· ${fmtAt(x.at)}「${String(x.gist || '').slice(0, 30)}」`).join('\n');
  return `你刚在手机上删了自己的日记，这一串一共 ${items.length} 篇：\n${list}\n`
    + '（你跟我说过：连着删两篇以上要告诉你一声。怎么说随你，但这件事要说。）';
}

/** 写日记的处境：只有日期和"你自己决定"，**不给句式、不给字数**。 */
function composeSituation({ today, recent = [], reason = '' } = {}) {
  const head = `（你想在手机上的本子里写一篇。今天是 ${today || ''}。`;
  const tail = recent.length
    ? `你最近写过：${recent.slice(0, 2).map((x) => `「${String(x).slice(0, 24)}」`).join('、')}。`
    : '本子还是空的。';
  return `${head}${tail}${reason ? reason : ''}
直接写正文，别写标题、别写日期、别解释你在写什么；想写多长写多长，一句话也可以。
不想写就只回一个"不写"，那今天就不写。）`;
}

/** 把模型那一坨清成"正文"：去掉标签、括号里的旁白、围栏、项目符号。 */
function cleanBody(text) {
  let s = String(text || '');
  s = s.replace(/\[(?:手机|表情|语音|自己|收藏)[^\]]*\]/g, '');
  s = s.replace(/```[\s\S]*?```/g, (m) => m.replace(/```/g, ''));
  s = s.replace(/^\s*#+\s*/gm, '');
  s = s.replace(/^\s*[-*·]\s+/gm, '');
  s = s.replace(/（[^）]{0,40}）/g, '');
  s = s.replace(/\([^)]{0,40}\)/g, '');
  s = s.split('\n').map((x) => x.trim()).filter(Boolean).join('\n');
  return s.trim();
}

/** 她是不是"今天不想写"。 */
function saysNo(body) {
  const s = String(body || '').trim();
  if (!s) return true;
  return /^(?:不写|不想写|算了|今天不写|不写了|跳过)$/.test(s) || (s.length <= 6 && /不写|不想/.test(s));
}

/** 长正文切段（不改字，只切）。 */
function segments(body, size = SEGMENT) {
  const s = String(body || '');
  const n = Math.max(20, Number(size) || SEGMENT);
  const out = [];
  for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n));
  return out.length ? out : [''];
}

/** 写完之后核对：首页第一条里该有正文开头那几个字。 */
function verifyWritten(rows, body) {
  const want = String(body || '').replace(/\s+/g, '').slice(0, 10);
  if (!want) return false;
  const hit = (rows || []).find((r) => String(r || '').replace(/\s+/g, '').includes(want));
  return !!hit;
}

function fmtAt(at) {
  const d = new Date(Number(at) || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function todayKey(at = Date.now()) {
  const d = new Date(at);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** `2026-11-11 周三`（给她看的日期，和她手机上那行一模一样）。 */
function todayLine(at = Date.now()) {
  return `${todayKey(at)} ${['周日', '周一', '周二', '周三', '周四', '周五', '周六'][new Date(at).getDay()]}`;
}

/* ------------------------------------------------------------------ 读手机 */

async function sh(adb, cmd, timeout = 15000) {
  const r = await adb.sh(cmd, { timeout });
  return `${(r && r.out) || ''}${(r && r.err) || ''}`;
}

/** 目录里有哪些篇（一次 shell，别一篇一个请求）。 */
async function list(adb) {
  const raw = await sh(adb, `cd ${BASE} 2>/dev/null && for f in *.md; do echo "@@$f"; head -n 2 "$f"; done`);
  const out = [];
  let cur = null;
  for (const line of String(raw || '').split('\n')) {
    if (line.startsWith('@@')) {
      if (cur) out.push(cur);
      const name = line.slice(2).trim();
      cur = { name, head: '', gist: '' };
      continue;
    }
    if (!cur) continue;
    const t = line.trim();
    if (!t) continue;
    if (!cur.head) { cur.head = t.replace(/^#\s*/, ''); continue; }
    if (!cur.gist) cur.gist = t;
  }
  if (cur) out.push(cur);
  return out.sort((a, b) => b.name.localeCompare(a.name));
}

async function readEntry(adb, name) {
  if (!name) return '';
  return sh(adb, `cat ${BASE}/${String(name).replace(/[^\w.\-]/g, '')}`);
}

async function statusOf(adb, at = Date.now()) {
  const rows = await list(adb);
  const today = todayKey(at);
  const todays = rows.filter((r) => r.name.startsWith(today));
  return {
    rows,
    count: rows.length,
    todayCount: todays.length,
    wroteToday: todays.length > 0,
    lastToday: todays[0] || null,
    gists: rows.slice(0, 5).map((r) => `  ${r.head || ''}  ${r.gist || ''}`.trim()),
  };
}

async function deleteLog(adb) {
  return parseLog(await sh(adb, `cat ${BASE}/deleted.log 2>/dev/null`));
}

/* ------------------------------------------------------------------ 写手机 */

function findNode(obs, pred) {
  const nodes = (obs && obs.nodes) || [];
  for (const n of nodes) if (pred(n)) return n;
  return null;
}

async function tapNode(adb, node, why) {
  if (!node || !node.center) return false;
  await adb.tapXY(node.center[0], node.center[1]);
  return true;
}

async function waitFor(adb, pred, { tries = 10, gap = 250 } = {}) {
  for (let i = 0; i < tries; i++) {
    const obs = await adb.observe().catch(() => null);
    if (obs && obs.ok) {
      const hit = findNode(obs, pred);
      if (hit) return { obs, node: hit };
    }
    await new Promise((r) => setTimeout(r, gap));
  }
  return { obs: null, node: null };
}

/**
 * 把一篇正文敲进本子：开 App → 点「写」→ 点输入框 → 分段敲 → 点「保存」→ 回读核对。
 * @returns {{ok:boolean, verified:boolean, steps:number, why?:string, body?:string}}
 */
async function push(adb, body, { log = () => {} } = {}) {
  const text = cleanBody(body);
  if (!text) return { ok: false, verified: false, steps: 0, why: '正文是空的' };
  let steps = 0;

  const launch = await adb.launch(PKG);
  steps += 1;
  if (!launch || !launch.ok) return { ok: false, verified: false, steps, why: `没打开本子（${(launch && launch.msg) || '?'}）` };

  const w = await waitFor(adb, (n) => String(n.text || '') === '写');
  steps += 1;
  if (!w.node) return { ok: false, verified: false, steps, why: '本子上没看到「写」' };
  await tapNode(adb, w.node);
  steps += 1;

  const box = await waitFor(adb, (n) => /EditText/.test(String(n.class || '')));
  steps += 1;
  if (!box.node) return { ok: false, verified: false, steps, why: '写作那一屏没看到输入框' };
  await tapNode(adb, box.node);
  steps += 1;

  const parts = segments(text);
  for (let i = 0; i < parts.length; i++) {
    const r = await adb.text(parts[i]);
    steps += 1;
    if (!r || !r.ok) return { ok: false, verified: false, steps, why: `第 ${i + 1} 段没敲进去（${(r && r.msg) || '?'}）` };
    log(`手机：日记第 ${i + 1}/${parts.length} 段敲好了（${parts[i].length} 字）`);
    if (i < parts.length - 1) {
      const tail = parts[i].slice(-6);
      const chk = await waitFor(adb, (n) => /EditText/.test(String(n.class || '')) && String(n.text || '').includes(tail), { tries: 6, gap: 200 });
      steps += 1;
      if (!chk.node) return { ok: false, verified: false, steps, why: `第 ${i + 1} 段敲完没在框里看见` };
    }
  }

  const sv = await waitFor(adb, (n) => String(n.text || '') === '保存');
  steps += 1;
  if (!sv.node) return { ok: false, verified: false, steps, why: '没看到「保存」' };
  await tapNode(adb, sv.node);
  steps += 1;

  const back = await waitFor(adb, (n) => String(n.text || '') === '写', { tries: 12, gap: 250 });
  steps += 1;
  if (!back.node) return { ok: false, verified: false, steps, why: '保存后没回到本子那一屏' };

  const rows = ((back.obs && back.obs.nodes) || []).map((n) => String(n.text || ''));
  const verified = verifyWritten(rows, text);
  if (!verified) return { ok: true, verified: false, steps, why: '存了，但首页第一条对不上正文' };
  return { ok: true, verified: true, steps, body: text };
}

/* ------------------------------------------------------------------ 导出 */

module.exports = {
  PKG, MAIN, BASE, SEGMENT, DEFAULTS, normalize,
  isDiaryGoal, isLookGoal,
  parseLog, judgeDeletes, deleteHint, composeSituation, cleanBody, saysNo, segments, verifyWritten,
  fmtAt, todayKey, todayLine,  list, readEntry, statusOf, deleteLog, push,
};
