/**
 * 她的手机 · 弹窗 / 广告层（2026-11-02）
 *
 * 用户原话：「使用的时候经常会被莫名其妙的广告或者弹窗给卡住然后不知道继续操作」。
 *
 * 这一层只做一件事：**在问模型之前，看一眼这一屏有没有"挡路的东西"，有就自己点掉。**
 *
 * 为什么不用视觉模型分类（别的方案常这么建议）：
 *   · 这些字**就在控件树里**（`text` / `content-desc`）——「跳过 5s」「不允许」「以后再说」
 *     「继续在浏览器」「立即更新」全是字面，字符串匹配就够了；
 *   · 每一步发一张图问一次，12 步就是 12 次调用、+24 秒 —— 而这一步的成本是 **0 token**。
 *
 * 为什么**必须**同时看到「信号词」和「关闭词」才动手：
 *   只看到「关闭」就点，会把正常表单里的「取消」按掉；
 *   只看到「登录」就点，会把 App 自己的登录入口按掉（B 站首页右上角就有一个）。
 *   两个都在、而且关闭词是个**小块**，才当作弹窗。
 *
 * ⚠️ 安全底线：**只点"否定/退出"那一侧的词**（白名单）。
 *   任何带「允许 / 安装 / 下载 / 支付 / 购买 / 开通 / 同意」的节点一律不点 ——
 *   模型判断错了只是多走一步，这里点错了是真花钱。
 *
 * ⚠️ 这个文件是**纯函数**：不碰 adb、不认识 PhoneAgent。执行在 `phone-agent.popups()` 里，
 *   自检可以直接喂假的 `obs`（见 `test/regions/17-phone.cjs`）。
 */

/** 只会往"退出/否定"那一侧走的词。**不要往里加正向词。** */
const CLOSE_RX = /^(?:不允许|拒绝|取消|关闭|跳过(?:广告)?|以后再说|下次再说|暂不|暂不开启|残忍拒绝|不感兴趣|我知道了|忽略|留在网页|继续在浏览器|随便看看|返回|^[×xX✕✖✖︎])$/;
/** 一行里可能不止一个词（"跳过 5s" / "关闭广告"），所以第二种判据是"包含"。 */
const CLOSE_ANY = /(不允许|拒绝|取消|关闭|跳过|以后再说|下次再说|暂不|残忍拒绝|不感兴趣|我知道了|留在网页|继续在浏览器|随便看看)/;
/** 正向词：关掉页面**绝不能**点这些。 */
const NEVER_TAP = /(支付|付款|购买|下单|开通|充值|转账|删除|卸载|安装|下载|允许|同意|确定|登录|注册|关注|订阅|领取|分享|发送|发布|继续安装)/;
/**
 * ★ 2026-11-02：**这些"关闭"是在关别的东西，不是在关弹窗**。
 *
 * 真机上的坑：视频页右上角有「关闭弹幕」，而整块播放器也占满了屏 ——
 * 不挡这一下，她就会去点"关闭弹幕"（看着像关了弹窗，其实只是把弹幕关了）。
 */
const BENIGN = /(弹幕|画质|倍速|音量|清晰度|字幕|投屏|缓存|自动播放|连播|全屏|小窗)/;

/**
 * 弹窗类别。`wall` = 这一类反复出现时不该硬刚（登录墙/广告墙）。
 * 顺序有意义：先判"更具体"的，再判"更泛"的。
 */
const CLASSES = [
  {
    id: 'perm',
    label: '权限框',
    pkg: /permissioncontroller|packageinstaller|com\.lbe\.security|miui\.permission/i,
    /**
     * Android 12 的真机写法是「要允许哔哩哔哩访问你的照片和视频吗？」+「允许 / 不允许」，
     * 有的机型只写「允许 XX 使用摄像头」。所以不光认「权限」两个字。
     */
    signal: /(权限|要允许|允许.{0,16}(访问|使用|获取|读取|打开)|访问你的|授权)/,
  },
  { id: 'mask', label: '全屏遮罩', mask: true },
  {
    id: 'ad',
    label: '广告',
    signal: /(跳过(?:广告)?|\d+\s*s\s*后?|广告|推广|赞助|赞助商|开屏|倒计时)/,
  },
  {
    id: 'openapp',
    label: '打开App',
    signal: /(打开.{0,8}(?:APP|App|app|客户端|应用)|继续在浏览器|下载.{0,6}(?:APP|App|客户端)|立即打开|打开看看|用App打开)/,
  },
  {
    id: 'install',
    label: '安装/下载',
    signal: /(安装|存在风险|安全下载|继续安装|正在下载|下载完成)/,
  },
  {
    id: 'login',
    label: '登录墙',
    wall: true,
    /**
     * ⚠️ 只认"**拦住去路**"的登录（B 站首页右上角那个「登录」按钮不算）。
     * 旧判据只要出现「登录」两个字，配上任何一个「关闭」都会动手 ——
     * 而视频页上恰好有「关闭弹幕」，那就点歪了。
     *
     * ★ 2026-11-02（真机 21:24 被卡）：B 站那个弹窗的标题是
     * **「登录注册解锁更多精彩内容」**，正文是「+86 请输入手机号 / 验证登录 / 账号密码 / 其他渠道」——
     * 旧词表里一个都不认（写的是"注册登录"，弹窗写的是"登录注册"），所以整层没触发。
     * 现在把这些真机上的说法都收进来。
     */
    signal: /(登录后|请先登录|一键登录|手机号登录|验证码登录|账号密码登录|注册登录|登录注册|注册解锁|解锁更多|登录才能|登录观看|登录查看|登录继续|请输入手机号|手机号验证|验证登录|账号密码|其他渠道)/,
  },
  { id: 'update', label: '更新提示', signal: /(版本更新|立即更新|发现新版本|新版本|升级到|建议更新)/ },
  { id: 'rate', label: '求好评', signal: /(好评|评价一下|给个评价|喜欢.{0,6}吗|用得怎么样)/ },
  { id: 'teen', label: '青少年模式', signal: /(青少年模式|未成年人)/ },
  { id: 'vip', label: '开通会员', signal: /(开通会员|立即开通|会员专享|解锁完整|升级会员|会员权益)/ },
];

/**
 * 哪几类允许点"没字的 ×"。
 * 信息流的「广告」卡片**不在**里面 —— 它的右上角是缩略图，点下去会开一个视频。
 */
for (const c of CLASSES) {
  if (['perm', 'login', 'install', 'update', 'rate', 'teen', 'vip'].includes(c.id)) c.icon = true;
}

const textOf = (n) => `${String(n && n.text || '')} ${String(n && n.desc || '')}`.replace(/\s+/g, ' ').trim();
function areaOf(n) {
  const b = n && n.bounds;
  if (!Array.isArray(b) || b.length < 4) return 0;
  return Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
}

/**
 * 这一屏上"能安全点掉弹窗"的节点，按"最像关闭键"排序。
 *
 * 排序：可点的优先 → 面积小的优先（关闭键永远是小块）→ 右上角优先
 * （`nx + (1-ny)` 越大越靠右上）。
 */
function closers(obs, { screen } = {}) {
  const nodes = Array.isArray(obs && obs.nodes) ? obs.nodes : [];
  const scr = screen || (obs && obs.screen) || {};
  const sw = Number(scr.width) || 720;
  const sh = Number(scr.height) || 1280;
  const screenArea = sw * sh;
  const out = [];
  for (const n of nodes) {
    const t = textOf(n);
    if (!t || t.length > 24) continue;                 // 关闭键不会是一行 40 字的正文
    const t2 = t.replace(/不允许/g, '');                 // 「不允许」里的「允许」不算正向词
    if (!(CLOSE_RX.test(t) || CLOSE_ANY.test(t))) continue;
    if (NEVER_TAP.test(t2)) continue;
    if (BENIGN.test(t)) continue;                        // 「关闭弹幕」不是关弹窗
    const a = areaOf(n);
    if (a && a > screenArea * 0.25) continue;          // 大块多半是整页容器，不是关闭键
    const b = n.bounds || [0, 0, sw, sh];
    const nx = (b[0] + b[2]) / 2 / sw;
    const ny = (b[1] + b[3]) / 2 / sh;
    out.push({ node: n, text: t, area: a, clickable: !!n.clickable, corner: nx + (1 - ny) });
  }
  out.sort((x, y) => {
    if (x.clickable !== y.clickable) return x.clickable ? -1 : 1;
    if (x.area !== y.area) return x.area - y.area;
    return y.corner - x.corner;
  });
  return out;
}

/** 每一类"最像关闭键"的那个词（点歪了的代价比多问一次模型大）。 */
const PREFER = {
  ad: /跳过|关闭广告|关闭/,
  openapp: /继续在浏览器|留在网页|取消|关闭/,
  perm: /不允许|拒绝/,
  login: /以后再说|跳过|随便看看|关闭/,
  install: /取消|以后再说|关闭/,
  update: /以后再说|暂不|关闭/,
  rate: /以后再说|关闭/,
  vip: /关闭|取消/,
  teen: /我知道了|关闭/,
  mask: /^(关闭|关闭广告|跳过|跳过广告|×|X)$/,
};

/**
 * ★ 2026-11-02（真机 21:24 被卡那一屏）：**右上角那个 × 往往一个字的都没有。**
 *
 * B 站那个「登录注册解锁更多精彩内容」弹窗，关闭键是一个**没有 text / content-desc 的图标**，
 * 于是 `closers()`（只认字）一个都挑不出来，整层就不动手 —— 她只能等你说话。
 * 这里补一条：**在有对话框的情况下**，允许点它右上角那个"小空白块"。
 *
 * 安全边界（很重要，别放宽）：
 *   · 只在"这一屏已经有弹窗信号"时才会走到这里（调用方保证）；
 *   · 对话框本体必须**比屏幕窄**（`bw < 屏宽 0.92`）—— 满屏的卡片/信息流不算对话框，
 *     否则列表里每张卡的右上角缩略图都会被当成关闭键；
 *   · 只认 `clickable`、面积 < 屏 5%、并且落在对话框右上角那一块里的节点。
 */
function iconCloser(obs, { screen } = {}) {
  const nodes = Array.isArray(obs && obs.nodes) ? obs.nodes : [];
  const scr = screen || (obs && obs.screen) || {};
  const sw = Number(scr.width) || 720;
  const sh = Number(scr.height) || 1280;
  const screenArea = sw * sh;

  const box = nodes
    .filter((n) => Array.isArray(n.bounds) && n.bounds.length === 4)
    .map((n) => ({ n, a: areaOf(n), b: n.bounds }))
    .filter((x) => {
      const bw = x.b[2] - x.b[0];
      const bh = x.b[3] - x.b[1];
      return x.a >= screenArea * 0.18 && x.a <= screenArea * 0.97
        && bw <= sw * 0.92 && bh <= sh * 0.95;
    })
    .sort((x, y) => y.a - x.a)[0];
  if (!box) return null;

  const [bx1, by1, bx2, by2] = box.b;
  const bw = bx2 - bx1;
  const bh = by2 - by1;
  const hit = nodes.find((n) => {
    if (!n.clickable || !Array.isArray(n.bounds)) return false;
    const t = textOf(n);
    if (t && !/^[×xX✕✖]+$/.test(t)) return false;      // 有字的走 closers()，这里只补"没字的"
    const a = areaOf(n);
    if (!a || a > screenArea * 0.05) return false;
    const cx = (n.bounds[0] + n.bounds[2]) / 2;
    const cy = (n.bounds[1] + n.bounds[3]) / 2;
    return cx > bx1 + bw * 0.55 && cx < bx2 && cy > by1 - 12 && cy < by1 + bh * 0.35;
  });
  return hit ? { node: hit, text: '×', area: areaOf(hit), clickable: true, corner: 2 } : null;
}

/** 全屏遮罩：一个节点盖住 ≥80% 的屏，而且这一屏几乎没有字（自绘广告 / 启动页）。 */
function isMask(obs, { screen } = {}) {
  const nodes = Array.isArray(obs && obs.nodes) ? obs.nodes : [];
  if (nodes.length < 2) return false;
  const scr = screen || (obs && obs.screen) || {};
  const screenArea = (Number(scr.width) || 720) * (Number(scr.height) || 1280);
  const big = nodes.filter((n) => areaOf(n) >= screenArea * 0.8);
  if (!big.length) return false;
  const words = nodes.filter((n) => textOf(n).length >= 2).length;
  return words <= 3;
}

/**
 * 这一屏有弹窗吗？
 *
 * @param {object} obs            `observe()` 的结果（只要 `nodes` / `screen` / `app`）
 * @param {object} [o]
 * @param {object} [o.screen]     这一屏的画幅（默认取 `obs.screen`）
 * @returns {{id:string,label:string,wall:boolean,node:object,text:string,why:string}|null}
 */
function scan(obs, { screen } = {}) {
  const nodes = Array.isArray(obs && obs.nodes) ? obs.nodes : [];
  if (!nodes.length) return null;
  const blob = nodes.map(textOf).join(' ');
  const pkg = String(obs && obs.app && obs.app.package || '');
  const close = closers(obs, { screen });
  /** 没有"有字的"关闭键时，先记下来 —— 有的弹窗只有一个没字的 ×（见 `iconCloser`）。 */
  const icon = close.length ? null : iconCloser(obs, { screen });
  if (!close.length && !icon) return null;
  const best = close[0] || icon;

  for (const c of CLASSES) {
    if (c.mask) {
      /**
       * 遮罩最容易误判（播放器整块画面也是"一大块 + 没几个字"）。
       * 所以它额外要求：关闭键在**右上角**，或者文字就是「关闭 / × / 跳过」——
       * 真实的全屏广告就是这样长的。
       */
      if (!isMask(obs, { screen })) continue;
      const pick = icon || close.find((x) => (PREFER.mask && PREFER.mask.test(x.text)) || x.corner >= 1.55);
      if (!pick) continue;
      return { id: c.id, label: c.label, wall: false, node: pick.node, text: pick.text, why: '整屏被盖住了' };
    }
    const hitPkg = c.pkg ? c.pkg.test(pkg) : false;
    const hitText = c.signal ? c.signal.test(blob) : false;
    if (!hitPkg && !hitText) continue;
    /**
     * 只有"对话框那几类"允许点没字的 × —— 信息流里"广告"卡片不算（它的右上角是缩略图）。
     */
    if (!close.length && !c.icon) continue;
    /**
     * 系统权限框可能只有图（没有"权限"两个字），所以 `pkg` 命中就够；
     * 其余类别必须文字命中 —— 光凭"屏上有个关闭键"不算。
     */
    const want = PREFER[c.id];
    const node = (want && close.find((x) => want.test(x.text))) || best;
    return {
      id: c.id,
      label: c.label,
      wall: !!c.wall,
      node: node.node,
      text: node.text,
      why: hitPkg && !hitText ? '系统弹窗' : `看到「${(c.signal.exec(blob) || [''])[0]}」`,
    };
  }
  return null;
}

/** 给日志/回灌用的一句人话。 */
function labelOf(id) {
  const c = CLASSES.find((x) => x.id === id);
  return c ? c.label : id;
}

module.exports = { scan, closers, iconCloser, isMask, labelOf, CLASSES, CLOSE_RX, CLOSE_ANY, NEVER_TAP, BENIGN, PREFER };
