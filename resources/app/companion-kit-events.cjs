/**
 * 外部 `ai-companion-kit` 的事件尾巴 —— 只读 `data/events.jsonl`。
 *
 * 这是"路线 B 的只读兼容层"：如果用户已经在跑外部的 ai-companion-kit，
 * 桌宠不需要再当一次 QQ 机器人（会双回），只要把 kit 写出来的事件显示出来就行。
 * 内置模式（`adapter: "builtin"`）不用这个文件。
 *
 * JSONL 的读法：记**字节偏移量**增量读；只处理完整行，半行留到下一次。
 * 默认从文件末尾开始（`replayLast: 0`），避免一启动把昨天的聊天全弹一遍。
 */
const fs = require('node:fs');
const path = require('node:path');

const TYPES = new Set(['inbound', 'typing', 'outbound', 'outbound-failed']);

class KitEventTail {
  /**
   * @param {object} opts
   * @param {string} opts.file
   * @param {number} [opts.replayLast] 启动时回放最后几条（0 = 从末尾开始）
   * @param {(ev:object)=>void} opts.onEvent
   * @param {(st:object)=>void} [opts.onStatus]
   */
  constructor({ file, replayLast = 0, onEvent, onStatus }) {
    this.file = file;
    this.replayLast = Math.max(0, Number(replayLast) || 0);
    this.onEvent = onEvent;
    this.onStatus = onStatus || (() => {});
    this.offset = null;
    this.stopped = false;
    this.watcher = null;
    this.timer = null;
    this.seen = new Set();
    this.seenOrder = [];
  }

  start() {
    this.stopped = false;
    // 目录可能还不存在（kit 没启动）；先记一条状态，轮询会一直等它出现
    const dir = path.dirname(this.file);
    try {
      this.watcher = fs.watch(dir, { persistent: false }, (_evt, name) => {
        if (!name || name === path.basename(this.file)) this.read();
      });
      this.watcher.on('error', () => { /* 目录被删了；轮询还在 */ });
    } catch { /* 目录不存在，靠轮询 */ }
    this.read();
    this.timer = setInterval(() => this.read(), 1200);
    this.timer.unref?.();
  }

  stop() {
    this.stopped = true;
    clearInterval(this.timer);
    this.timer = null;
    try { this.watcher?.close(); } catch { /* 已经关了 */ }
    this.watcher = null;
  }

  /** 读一次；文件不在/没变化就安静地返回。 */
  read() {
    if (this.stopped) return;
    let st;
    try { st = fs.statSync(this.file); } catch {
      this.onStatus({ waiting: true, file: this.file });
      return;
    }
    if (!st.isFile()) return;

    if (this.offset === null) {
      if (this.replayLast > 0) {
        this.#replay();
        this.offset = st.size;
        return;
      }
      this.offset = st.size;
      this.onStatus({ waiting: false, file: this.file, size: st.size });
      return;
    }
    if (st.size < this.offset) this.offset = 0;       // 文件被清空/轮转
    if (st.size === this.offset) return;

    let buf;
    try {
      const fd = fs.openSync(this.file, 'r');
      try {
        buf = Buffer.alloc(st.size - this.offset);
        fs.readSync(fd, buf, 0, buf.length, this.offset);
      } finally { fs.closeSync(fd); }
    } catch { return; }

    // 只处理到最后一个换行；半行（含被截断的多字节字符）留到下一次
    const lastNl = buf.lastIndexOf(0x0a);
    if (lastNl < 0) return;
    const text = buf.toString('utf8', 0, lastNl);
    this.offset += lastNl + 1;
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (t) this.#accept(t);
    }
    this.onStatus({ waiting: false, file: this.file, size: st.size });
  }

  #replay() {
    let text = '';
    try { text = fs.readFileSync(this.file, 'utf8'); } catch { return; }
    const lines = text.split('\n').filter((l) => l.trim()).slice(-this.replayLast);
    for (const l of lines) this.#accept(l.trim());
  }

  #accept(line) {
    let ev;
    try { ev = JSON.parse(line); } catch { return; }
    if (!ev || !TYPES.has(ev.type)) return;
    const key = `${ev.at || 0}|${ev.type}|${ev.key || ''}|${ev.text || ''}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.seenOrder.push(key);
    if (this.seenOrder.length > 400) this.seen.delete(this.seenOrder.shift());
    const out = {
      type: ev.type,
      at: Number(ev.at) || Date.now(),
      key: String(ev.key || ''),
      isGroup: !!ev.isGroup || String(ev.key || '').startsWith('group:'),
      userId: String(ev.userId || ''),
      name: String(ev.name || ''),
      text: String(ev.text || ''),
      parts: Array.isArray(ev.parts) ? ev.parts.map(String).slice(0, 8) : undefined,
      atMe: !!ev.atMe,
      model: ev.model ? String(ev.model) : '',
      source: 'kit',
    };
    this.onEvent(out);
  }
}

module.exports = { KitEventTail, TYPES };
