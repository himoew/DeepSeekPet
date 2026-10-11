/**
 * 自检区域：跨函数引用守卫
 *
 * **这条是为一次真实翻车加的**：`microK` 在 `step()` 里声明，却被 `render()` 用了 ——
 * 而 `render()` 是在**帧循环**里被调的，所以它每一帧抛 `ReferenceError`，
 * **整条帧循环当场死掉**：她停在最后一帧、不再动、也不再接鼠标。
 *
 * 所以这里做一条**静态作用域检查**：把 pet-core 里 `render()` 的函数体切出来，
 * 断言它不引用那些"只在别的函数里声明"的名字。
 *
 * 代码从原 `test\smoke.cjs` 的 2h 那一段**整段照抄**，一字未改。
 * 单跑：`node test\run-one.cjs 02h-crossref.cjs`
 */
module.exports = {
  name: '跨函数引用守卫',
  tags: ['guard', '守卫', 'pet-core'],
  async run(ctx) {
    /* 裸名字（fs / path / app / pet / lines / ok / base / port …）由骨架挂成全局了。 */
    const coreSrc = fs.readFileSync(path.join(app, 'web', 'pet-core.js'), 'utf8');

    /** 从 `function name(` 起，按大括号配对切出函数体。 */
    const bodyOf = (src, name) => {
      const at = src.indexOf(`function ${name}(`);
      if (at < 0) return null;
      const open = src.indexOf('{', at);
      let depth = 0;
      for (let i = open; i < src.length; i += 1) {
        if (src[i] === '{') depth += 1;
        else if (src[i] === '}') { depth -= 1; if (!depth) return src.slice(open, i + 1); }
      }
      return null;
    };
    const renderBody = bodyOf(coreSrc, 'render');
    const stepBody = bodyOf(coreSrc, 'step');
    ok('pet-core：render() 切得出来（切不出来说明函数被人重命名了，这条守卫会失效）', !!renderBody && renderBody.length > 500);
    ok('pet-core：step() 切得出来', !!stepBody && stepBody.length > 500);
    /** 剥掉注释再查：注释里写 `microK`（比如解释这个坑）不算引用。 */
    const codeOnly = (s) => String(s || '').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
    const renderCode = codeOnly(renderBody);
    // `microK` 是 step 的局部变量，render 里用了就是 ReferenceError（每帧一次、帧循环死）
    ok('pet-core：render() 不引用 step() 的局部变量 microK（曾经因此整条帧循环死掉）',
      !!renderCode && !/(?<![A-Za-z_$.])microK(?![A-Za-z_$])/.test(renderCode));
    // render 里用到的每个 micro/mood 名字，都必须是 createPet 作用域里的变量
    // （`microTilt:` 这种**对象键名**不算引用，排除掉）
    const names = [...new Set(renderCode.match(/(?<![A-Za-z_$.])(micro[A-Za-z]*|mood)(?![A-Za-z_$])/g) || [])]
      .filter((n) => {
        const at = renderCode.indexOf(n);
        return renderCode[at + n.length] !== ':';
      });
    const declaredAtTop = ['microState', 'mood'];
    ok(`pet-core：render() 引用的变量都在作用域内（${names.join('/') || '无'}）`,
      names.every((n) => declaredAtTop.includes(n) || renderCode.includes(`const ${n}`) || renderCode.includes(`let ${n}`)));
    // 前端入口必须挂上全局错误捕获（这次就是靠它才看见 microK 的）
    ok('页面入口导入了诊断模块（全局错误捕获）',
      /from '\.\/diag\.js'/.test(fs.readFileSync(path.join(app, 'web', 'pet-app.js'), 'utf8')));
    ok('诊断模块真的装了 error / unhandledrejection 监听',
      /addEventListener\('error'/.test(fs.readFileSync(path.join(app, 'web', 'diag.js'), 'utf8'))
      && /addEventListener\('unhandledrejection'/.test(fs.readFileSync(path.join(app, 'web', 'diag.js'), 'utf8')));
  },
};
