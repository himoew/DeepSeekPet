/**
 * 页面侧的异常捕获与上报 —— **"她没画出来"这类问题唯一能留下线索的地方**。
 *
 * 为什么需要它（都是实测踩出来的）：
 *
 * 1. 主进程的 `console.log` 在 GUI 起来之后是**被丢掉的**，所以页面里的报错写进
 *    `pet.log`/`pet-host.log` 一行都不会有；
 * 2. 页面里的异常如果发生在**异步启动链**里，症状是"窗口在、日志全正常、屏幕上一个像素都没有"，
 *    光看日志完全查不出来（本会话就卡在这上面很久）；
 * 3. `console.error` 也不够：它只留一行文字，没有堆栈。
 *
 * 所以这里在**模块加载的第一时间**（比任何别的 import 都早）装上全局错误监听，
 * 通过 `petHost.report()` 把消息+堆栈送到主进程，由 pet-host.cjs 写进 `data\pet-host.log`。
 * 上报失败一律吞掉——诊断绝不能影响她本身。
 */
export function report(msg) {
  try {
    const host = globalThis.petHost;
    if (host && typeof host.report === 'function') host.report(String(msg).slice(0, 2000));
  } catch { /* 上报本身失败就算了 */ }
}

addEventListener('error', (e) => {
  const where = e.filename ? ` @${e.filename}:${e.lineno}:${e.colno}` : '';
  report(`[页面异常] ${e.message}${where}${e.error && e.error.stack ? `\n${e.error.stack}` : ''}`);
});

addEventListener('unhandledrejection', (e) => {
  const r = e.reason;
  report(`[未处理的 Promise] ${(r && (r.stack || r.message)) || r}`);
});

/** 关键节点也报一句，这样"走到哪一步断的"一眼看得出来。 */
export function boot(msg) {
  report(`[启动] ${msg}`);
}
