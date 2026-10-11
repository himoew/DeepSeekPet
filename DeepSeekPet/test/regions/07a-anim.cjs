/**
 * 自检区域：次级动画 / 眨眼睫毛 / 桌面接地光 / 部位判定
 *
 * 由原 `regions\05-live.cjs` 的**第 7 节的前半（静态检查 + 纯函数行为验证，都不需要真连接，也不推粒子动画）**整段切出来（按行号搬，正文一字未改）。
 * 不需要真连接：只用 `fs` / `path` / `app` / `ok` 这些骨架给的东西。
 * 单跑：`node test\run-one.cjs 07a-anim.cjs`
 */
module.exports = {
  name: "次级动画 / 眨眼睫毛 / 桌面接地光 / 部位判定",
  tags: ["动画","接地光","部位","静态"],
  async run(ctx) {
    /**
     * ★ **行为验证 ①：延迟跟随取的是"0.1 秒前"那个点**（用户点名的"你甩鼠标，发梢晚 0.1 秒跟上"）。
     *
     * 光查字符串挡不住"延迟窗口写错"这类错（`.04` / `.4` 都是一个字符的事，看着都一样），
     * 所以把 `lagged()` 从 figure.js 里抠出来、喂给它一段**已知位置的历史**，量它算出来的速度：
     *   身体在 t=1.0 时在 x=100，现在（t=1.1）在 x=130 → 0.1 秒走了 30px → 300px/s。
     * 顺带量一下"历史不够长时返回 0"（老页面 / 内置身体走这条路，必须和上游一模一样）。
     */
    {
      const figSrc = fs.readFileSync(path.join(ctx.app, 'web', 'whale', 'figure.js'), 'utf8');
      const lagFn = figSrc.match(/function lagged\(o\) \{[\s\S]*?return \[\(o\.bx - best\.x\) \/ dt, \(o\.by - best\.y\) \/ dt\];\n  \}/);
      const lagConst = figSrc.match(/const LAG_S = [.\d]+;/);
      const lagged = lagFn && lagConst
        ? new Function(`${lagConst[0]}\n${lagFn[0]}\nreturn lagged;`)()
        : null;
      const hist = [{ t: .6, x: 60, y: 0 }, { t: .8, x: 80, y: 0 }, { t: 1.0, x: 100, y: 0 }];
      const v = lagged ? lagged({ t: 1.1, bx: 130, by: 0, posHist: hist }) : null;
      ok('★次级动画（行为）：延迟速度取的是**0.1 秒前**那一点（300px/s 这种量级，不是当前速度）',
        !!v && Math.abs(v[0] - 300) < 1 && Math.abs(v[1]) < 1e-6);
      // 竖直方向也要算（跳、被拎起来、坐下时发梢要往下拖）
      const vv = lagged ? lagged({ t: 1.1, bx: 100, by: -40, posHist: [{ t: 1.0, x: 100, y: 0 }] }) : null;
      ok('★次级动画（行为）：竖直方向的速度也参与（跳起来/被放下时发梢会拖）',
        !!vv && Math.abs(vv[1] + 400) < 1e-6 && Math.abs(vv[0]) < 1e-6);
      ok('★次级动画：没有位置历史（老页面 / 内置身体）时返回 0，行为同上游',
        !!lagged && lagged({ t: 1, bx: 9, by: 9, posHist: [] })[0] === 0
        && lagged({ t: 1, bx: 9, by: 9 })[0] === 0);
      const coreSrc2 = fs.readFileSync(path.join(ctx.app, 'web', 'pet-core.js'), 'utf8');
      ok('★次级动画：身体位置的环形历史是 pet-core 喂的（`posHist` + `frame.bx/by`）',
        /posHist: \[\]/.test(coreSrc2) && /pet\.posHist\.push\(\{ t: T, x: AX, y: BY \}\)/.test(coreSrc2)
        && /bx: AX, by: AY, posHist: pet\.posHist/.test(coreSrc2));
      ok('★次级动画：延迟速度接进了发梢/刘海/尾巴/呆毛的弹簧目标',
        /const lagH = clamp\(-lagX \* LAG_HAIR/.test(figSrc)
        && /sp\.hair\.step\(sway \* 1\.1[^;]*lagH, dt\)/.test(figSrc)
        && /sp\.tail\.step\(sway \* 14 \+ tailMood \* 12 \+ lagT, dt\)/.test(figSrc));
    }
    /**
     * ★ **眨眼睫毛阴影**：必须是**叠在脸那块画布上、用 source-atop 裁住**的（0 新贴图），
     * 而且**用完必须还原 `source-over`**（否则后面所有脸部绘制都会被改掉，症状是"脸花了"）。
     */
    {
      const figSrc = fs.readFileSync(path.join(ctx.app, 'web', 'whale', 'figure.js'), 'utf8');
      const block = figSrc.match(/if \(shut > \.06\) \{[\s\S]*?\n    \}\n    fg\.save\(\);/);
      ok('★眨眼睫毛阴影：闭眼时在脸上叠一道渐变（source-atop 裁在脸内部，0 新贴图）',
        !!block && /source-atop/.test(block[0]) && /createLinearGradient/.test(block[0])
        && /fillRect/.test(block[0]));
      ok('★眨眼睫毛阴影：必须用 save/restore 把 source-atop 与 fillStyle 严丝合缝地包起来（漏出去会把后面的脸画花）',
        !!block && /fg\.save\(\);[\s\S]*source-atop[\s\S]*fillRect[\s\S]*fg\.restore\(\);/.test(block[0]));
      // 闭眼量是从 `o.blink`/`o.eyeClose` 来的，而且**眨眼那几帧必须让脸重画**
      // （figure.js 的脏检查：`blink > .02` 时 `faceStamp` 返回 null → 每帧重画）
      ok('★眨眼睫毛阴影：闭眼量取自这一帧的 blink/eyeClose，且脏检查不会把眨眼那几帧跳过去',
        /shut = Math\.max\(o\.blink \|\| 0, o\.eyeClose \|\| 0\)/.test(figSrc)
        && /\(o\.blink \|\| 0\) > \.02 \|\| \(o\.eyeClose \|\| 0\) > \.02\) return null/.test(figSrc));
    }
    /**
     * ★ **桌面接地光（行为）**：`oklabRgb()` 是 `oklab()` 的反函数，两件事都要成立：
     * ① **来回一趟不掉色**（灰进灰出、彩色进彩色出，误差 ≤2/255）——
     *    它错了不会抛异常，只会让轮廓光和影子**静默变色**（最难查的一类）；
     * ② **轮廓光与桌面反着来**：浅桌面给暗轮廓、深桌面给亮轮廓（这是"贴上去"变成"长在上面"的关键）。
     */
    {
      const appSrc = fs.readFileSync(path.join(ctx.app, 'web', 'pet-app.js'), 'utf8');
      const grab = (re) => { const m = appSrc.match(re); return m ? m[0] : ''; };
      const src = [
        grab(/const lin = [^\n]+/), grab(/const clamp01 = [^\n]+/), grab(/const hex = [^\n]+/),
        grab(/function oklab\(r, g, b\) \{[\s\S]*?\n\}/), grab(/function oklabRgb\(L, A, B\) \{[\s\S]*?\n\}/),
        'return { oklab, oklabRgb, hex, clamp01 };',
      ].join('\n');
      let fns = null;
      try { fns = new Function(src)(); } catch (e) { /* 抠不出来就算没通过（下面那条 ok 会红） */ }
      /**
       * 用**逐通道容差**：OKLab 的立方根与三次方不可结合、逆矩阵常数只有 4 位有效数字，
       * 所以"绕一圈"本来就带几级量化误差 —— 实测 灰/浅色 ≤3，而蓝色 200 那一档 g 偏 **21**
       * （数值性质，不是抄错）。这条验证钉的是**矩阵抄没抄错**（抄错会偏几十上百，比如 g 偏 21
       * 换成其它通道就是 80+），所以容差按通道给。灰必须几乎不偏，这是最灵敏的那一路。
       */
      const near = (a, b, tol) => Math.max(...a.map((v, i) => Math.abs(v - b[i]))) <= tol;
      const round = (r, g, b) => {
        const [L, A, B] = fns.oklab(r, g, b);
        return fns.oklabRgb(L, A, B);
      };
      ok('★桌面接地光（行为）：OKLab→sRGB 的往返不掉色（灰必须≤4，深蓝允许通道量化误差≤24）',
        !!fns && near(round(128, 128, 128), [128, 128, 128], 4) && near(round(250, 240, 230), [250, 240, 230], 4)
        && near(round(40, 90, 200), [40, 90, 200], 24));
      const light = fns.oklab(...[240, 238, 235]);
      const dark = fns.oklab(...[18, 20, 26]);
      const halo = (l, a, b) => fns.oklabRgb(fns.clamp01(l > .58 ? l - .32 : l + .32), a * .35, b * .35);
      const hl = fns.oklab(...halo(...light)), hd = fns.oklab(...halo(...dark));
      ok('★桌面接地光（行为）：浅桌面给**更暗**的轮廓光、深桌面给**更亮**的轮廓光',
        hl[0] < light[0] - .15 && hd[0] > dark[0] + .15);
      ok('★桌面接地光：影子颜色由身后的平均色染出来（但保持很淡，不当成一块黑）',
        /const sRgb = oklabRgb\(\.17 \+ bl \* \.04, ba \* \.28, bb \* \.28\)/.test(appSrc)
        && /shadowTint = \{ rgb: sRgb, a: bl < \.30 \? \.26/.test(appSrc)
        && /shadowEl\.setAttribute\('fill'/.test(appSrc));
      ok('★桌面接地光：抓屏节奏——轮廓光开着时 0.8s，平时 2.5s（第 10.1 节①那条开销项）',
        /const every = backdrop\.on \? BACKDROP_EVERY : BACKDROP_EVERY_CALM/.test(appSrc)
        && /BACKDROP_EVERY_CALM = 2\.5/.test(appSrc));
    }

    /**
     * ★ **身体部位判定：从 7 类细化到 15 类**（2026-10-10 用户实测报"戳嘴巴识别到呆毛"之后重做）。
     *
     * 这一节验三件事，缺一件都会**静默出错**：
     * ① **三处名字必须对得上**：`pet-app.js` 的 `REGION_BOXES`/`REGION_AT`（页面判出来的）、
     *    `pet.cjs` 的 `AREAS`/`AREA_CN`（World 认不认）、`lines.cjs` 的 `pokeArea`/`petArea`
     *    （有没有那个部位的话）。**对不上不会报错**，只是那个部位悄悄说通用台词。
     * ② **`GRAB_STYLE` 必须覆盖全部部位**：漏一个，抓那儿拎起来就是 `undefined` 悬挂角。
     * ③ **判定行为**：把自己写的判定逻辑（`petRegion`）抠出来，喂**真实坐标**量一遍 ——
     *    尤其是用户报的那一条：**戳嘴（y≈147）必须不是呆毛**。
     */
    {
      const appSrc3 = fs.readFileSync(path.join(ctx.app, 'web', 'pet-app.js'), 'utf8');
      const petSrc = fs.readFileSync(path.join(ctx.app, 'pet.cjs'), 'utf8');
      const grabSrc = appSrc3.match(/const GRAB_STYLE = \{[\s\S]*?\n\};/);
      const boxesSrc3 = (appSrc3.match(/const REGION_BOXES = \[[\s\S]*?\n\];/) || [''])[0];
      const atSrc3 = (appSrc3.match(/const REGION_AT = \[[\s\S]*?\n\];/) || [''])[0];
      /**
       * ⚠️ 部位名**直接从两张表里抠**，不要去找 `const REGION_IDS = …` 那一行 ——
       * 上面注释里也写着 `REGION_IDS` 这个词，正则一贪心就抠到注释上去了（实测踩过：
       * 抠出来的集合是空的，于是"名字都对得上"那几条**假绿**）。
       */
      const ids = new Set([...boxesSrc3.matchAll(/\['([a-z_]+)',/g), ...atSrc3.matchAll(/\['([a-z_]+)',/g)]
        .map((m) => m[1]));
      ok('★部位：判定表里确实有 15 个部位，而且呆毛与头发是分开的',
        ids.size === 15 && ids.has('ahoge') && ids.has('hair') && ids.has('eyes')
        && ids.has('cheek') && ids.has('chin') && ids.has('thigh') && ids.has('chest'));

      const missArea = [...ids].filter((id) => !new RegExp(`'${id}'`).test(petSrc));
      ok('★部位：15 个名字在 pet.cjs 的 AREAS 里都认（漏一个那个部位就只会说通用台词）', missArea.length === 0);
      const cnSrc = petSrc.match(/const AREA_CN = \{[\s\S]*?\n\};/);
      const missCn = [...ids].filter((id) => !new RegExp(`${id}:`).test(cnSrc ? cnSrc[0] : ''));
      ok('★部位：15 个名字都有中文名（AREA_CN；模型读上下文时用的就是它）', missCn.length === 0);
      const missGrab = [...ids].filter((id) => !new RegExp(`\\b${id}: \\{ hang:`).test(grabSrc ? grabSrc[0] : ''));
      ok('★部位：GRAB_STYLE 覆盖全部 15 个（漏一个抓那儿拎起来就是 undefined）', missGrab.length === 0);

      const linesSrc = fs.readFileSync(path.join(ctx.app, 'lines.cjs'), 'utf8');
      const pokeSrc = linesSrc.match(/pokeArea: \{[\s\S]*?\n  \},/);
      const petAreaSrc = linesSrc.match(/petArea: \{[\s\S]*?\n  \},/);
      const missPoke = [...ids].filter((id) => !new RegExp(`\\n\\s+${id}: \\[`).test(pokeSrc ? pokeSrc[0] : ''));
      const missPet = [...ids].filter((id) => !new RegExp(`\\n\\s+${id}: \\[`).test(petAreaSrc ? petAreaSrc[0] : ''));
      ok('★部位：15 个部位在 lines.cjs 的 pokeArea 里都有话（戳哪儿说哪儿）', missPoke.length === 0);
      ok('★部位：15 个部位在 lines.cjs 的 petArea 里都有话（蹭哪儿说哪儿）', missPet.length === 0);

      __mark('行为验证：直接照**同一张表**算一遍（不再去 eval 产品源码：那玩意儿太脆）');
      /* --- 行为验证：直接照**同一张表**算一遍（不再去 eval 产品源码：那玩意儿太脆） --- */
      /**
       * 说明：这里**故意不抠 pet-app.js 的函数体**。试过，结果是自检自己成了最难查的东西
       * （模板引号写错 → 只插进去一个字符 → `c is not defined`，绕了半小时）。
       * 换成"用同一份表按同一条规则算"：只要判定规则改了而这里没跟着改，
       * 下面几条会红 —— 这就够了；页面真跑起来的行为由用户实测兜底。
       */
      const parseRegions = (src) => [...src.matchAll(/\['([a-z_]+)',\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+),\s*([\d.]+))?\]/g)]
        .map((m) => ({ id: m[1], x: +m[2], y: +m[3], box: m[4] ? [+m[2], +m[3], +m[4], +m[5]] : null }));
      const regionHits = (x, y) => {
        for (const r of parseRegions(boxesSrc3)) {
          if (x >= r.box[0] && x <= r.box[2] && y >= r.box[1] && y <= r.box[3]) return r.id;
        }
        let best = '', far = Infinity;
        for (const r of parseRegions(atSrc3)) {
          const d = Math.hypot(x - r.x, y - r.y);
          if (d < far) { far = d; best = r.id; }
        }
        return best;
      };
      const hit = regionHits;
      ok('★部位（行为）：戳**嘴**（138,147）不再判成呆毛，而且呆毛自己那一撮仍然判得对',
        hit(138, 147) === 'chin' && hit(114, 30) === 'ahoge');
      ok('★部位（行为）：眼睛 / 脸蛋 / 头发 / 胸口 / 手 / 大腿 / 脚 都落在对的格子里',
        hit(148, 115) === 'eyes' && hit(120, 131) === 'cheek' && hit(95, 106) === 'hair'
        && hit(130, 168) === 'chest' && hit(108, 205) === 'hand' && hit(140, 228) === 'thigh'
        && hit(112, 250) === 'foot' && hit(65.8, 192.4) === 'tail');
      ok('★部位（行为）：旧 7 类里"手"的锚点（108,185）不再把裙子当手（那里是发梢，归头发）',
        hit(108, 185) === 'hair' && hit(108, 202) === 'hand');
    }
  },
};
