/**
 * 拖动逻辑的离线推演：用最小 DOM 桩把 ball.js 跑起来，模拟"抓住球拖 1 秒再松手"，
 * 看它到底会不会乱弹。只为定位"抓住拖动时一直乱弹"这个 bug，不进仓库。
 */
const el = () => ({
  id: 'fx', tagName: 'g', attrs: {}, children: { length: 1 },
  appendChild() {}, setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k]; },
  querySelector() { return null; }, parentNode: { appendChild() {} },
});
globalThis.document = { createElementNS: () => el() };
globalThis.petHost = { report: () => {} };
let clock = 0;
globalThis.performance = { now: () => clock };
globalThis.setTimeout = globalThis.setTimeout;

(async () => {
  const { createBall } = await import('file:///' + process.argv[2].replace(/\\/g, '/') + '/web/ball.js');
  const b = createBall({
    fxG: el(), sfx: {},
    stage: { bounds: () => ({ W: 1280, H: 760, floorY: 758, minX: 0, maxX: 1280 }), pet: () => ({ x: 100, faceVis: 1 }) },
  });
  b.setOn(true, { fromLeft: false });
  for (let i = 0; i < 120; i += 1) { b.step(1 / 60); clock += 1000 / 60; }   // 先让它落地停稳
  console.log('停稳后:', JSON.stringify(b.state));

  // 抓住球，沿一条曲线拖 1 秒（每帧移动 ~8px），每帧都 step（模拟真机）
  let x = b.x, y = 400;
  b.drag(x, y); b.setDragging(true);
  const trail = [];
  for (let i = 0; i < 60; i += 1) {
    clock += 1000 / 60;
    x += 8 * Math.sin(i / 6);          // 左右摆动（像人手抖）
    y -= 6;                            // 缓慢上提
    if (y < 200) y = 200;
    b.drag(x, y);
    b.step(1 / 60);
    if (i % 10 === 0) trail.push({ i, ...b.state });
  }
  console.log('拖动中每 10 帧:', JSON.stringify(trail, null, 0));
  b.setDragging(false);
  // 松手后 1 秒
  const after = [];
  for (let i = 0; i < 60; i += 1) { clock += 1000 / 60; b.step(1 / 60); if (i % 20 === 0) after.push({ i, ...b.state }); }
  console.log('松手后每 20 帧:', JSON.stringify(after, null, 0));
})();
