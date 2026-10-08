/**
 * 服装 —— 先把**接口**接上，贴图以后再说。
 *
 * ## 为什么先做接口
 *
 * 用户明确说：「关于服装换色我觉得没必要，如果更换我希望是更多服装而非换色，
 * 但是服装涉及到更多的贴图，并且我们手上没有现成的素材，这样，我们可以在设置里把
 * 服装的接口接上，但先不要用上游原本的换色，等待我们后期更新全新服装。」
 *
 * 所以这里**故意不碰上游那 8 套配色**（`web\whale\schemes\` 没复制进仓库，`model.json`
 * 里也只剩 `deepseek` 一套）。这个模块只负责三件事：
 *
 *   1. **记**住你挑了哪一套（`data\dress.json`），重启后还在；
 *   2. 启动时把它交给页面（`pet.cjs` 的 `INIT.skin`，只有页面**认得**的套装才带出去）；
 *   3. 给"服装"页提供清单（`web\dress.html` 读 `list()`）。
 *
 * ## 加一套新服装要做什么（将来照这个来）
 *
 *   1. 贴图放进 `web\whale\`（自己一套目录，例如 `web\whale\outfits\<名字>\`）；
 *   2. 在 `web\whale\model.json` 里加一条（上游的格式就是 `schemes` 那一栏：
 *      `{ id, brand, label, accent, ready }`，贴图按 `id` 找）；
 *   3. 这个文件**一行都不用改** —— 它只存 `id`，认不认得出由页面决定
 *      （页面不认的 id 会退回原版，所以半成品也不会把她画成空白）。
 *
 * ## 为什么单独一个文件、不塞进 `settings.json`
 *
 * `settings.json` 是**你的设置**（接口、Key、人设），里面的字段是"配置"；
 * 而"她穿什么"更像"它自己的状态"（跟 `pet-pos.json` / `pet-mood.json` 一类），
 * 放在 `data\` 下、跟着 `DSP_LOG_DIR` 一起被隔离，自检就不会动到你真实的选择。
 */
const path = require('node:path');
const log = require('./log.cjs');
const store = require('./store.cjs');

/** 跟 pet-pos.json / pet-mood.json 做邻居（`log.file` 认 `DSP_LOG_DIR`）。 */
const FILE = path.join(path.dirname(log.file), 'dress.json');

/**
 * 现在能穿的套装。**这是我们自己的一份清单**，不是上游那份配色表。
 *
 * `id` 用 `original` 表示"她本来的样子"（对应 `model.json` 里的 `deepseek` 那一套），
 * 因为"原版"这个词在用户眼里是"不换装"，不该叫某个品牌名。
 *
 * `ready: false` 的意思是"这一套还没贴图"——页面上会列出来但**点不动**，
 * 这样"将来要加什么"是看得见的，而不是空空一片。
 */
const OUTFITS = [
  { id: 'original', label: '原版', note: '她本来的样子', ready: true, scheme: 'deepseek' },
  { id: 'outfit-01', label: '（预留）', note: '等你画好第一套新衣服，把贴图放进来就点得动了', ready: false, scheme: '' },
  { id: 'outfit-02', label: '（预留）', note: '同上：这一格是留给第二套的', ready: false, scheme: '' },
];

const byId = (id) => OUTFITS.find((o) => o.id === id) || null;

function blank() {
  return { current: 'original', at: '' };
}

let data = null;

function load() {
  if (data) return data;
  const raw = store.readJson(FILE) || {};      // 第一次就是没有文件；坏了也一样（下面一律回原版）
  const base = blank();
  const wanted = typeof raw.current === 'string' ? byId(raw.current) : null;
  data = {
    // **只认清单里"能穿"的那几套**：文件被手改坏了、或者那一套贴图还没做，
    // 一律回到原版 —— 页面那边还有第二道兜底（不认识的 scheme 会退回原版）。
    current: wanted && wanted.ready ? wanted.id : base.current,
    at: typeof raw.at === 'string' ? raw.at : base.at,
  };
  return data;
}

function save() {
  // 原子写（先写 `.tmp` 再改名）：掉电/崩溃不会留下半截 JSON —— 见 store.cjs
  const err = store.writeJson(FILE, load());
  if (err) log.warn(`服装没能存下来:${err.message}`);
}

/** 现在穿的这一套（永远返回一个有效项）。 */
function current() {
  return byId(load().current) || byId('original');
}

/** 换一套（`id` 不在清单里、或者`ready:false` 就拒绝并说明原因）。 */
function wear(id) {
  const want = byId(id);
  if (!want) return { ok: false, error: `没有这一套：${id}`, outfits: OUTFITS, current: current().id };
  if (!want.ready) return { ok: false, error: `「${want.label}」还没有贴图，穿不了`, outfits: OUTFITS, current: current().id };
  const d = load();
  if (d.current !== want.id) {
    d.current = want.id;
    d.at = new Date().toISOString();
    save();
    log.info(`换装：${want.label}（${want.id}）`);
  }
  return { ok: true, outfits: OUTFITS, current: want.id };
}

/** 给设置页/服装页看的清单 + 现在穿的（只读）。 */
function list() {
  const cur = current();
  return { outfits: OUTFITS, current: cur.id, label: cur.label, file: FILE };
}

/**
 * 启动时交给页面的那份 `skin`。
 *
 * **只带页面认得的 scheme**：不认的、或者还是原版，就返回 `null`，
 * 让 `pet.cjs` 用它的默认 SKIN（`figure: 'whale', scheme: 'deepseek'`）。
 * 这样"服装"这一层出任何问题都不会影响她能不能出现。
 */
function skinOverride() {
  const cur = current();
  if (!cur || cur.id === 'original' || !cur.scheme) return null;
  return { figure: 'whale', scheme: cur.scheme };
}

/** 忘掉（设置页「忘掉一切」时跟着复位；也可以单独用）。 */
function forget() {
  data = blank();
  save();
  return list();
}

module.exports = { OUTFITS, list, current, wear, skinOverride, forget, FILE };
