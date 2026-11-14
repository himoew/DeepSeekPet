# 她的日记本（Android，单 App，无依赖）

她手机上那个三屏的极简本子。**不是日记软件**：没有标题、没有模板、没有字数、没有打卡。

```
屏 A 本子   2026-11-11 周三 / 今天还没写 / 每篇一行（日期 时间 + 开头一句）/ [写]
屏 B 写     整屏一个输入框 / 右上 [保存]（返回也存，空着不落盘）
屏 C 看一篇 右上 [删除] → 「删了 / 算了」
```

控件都带 `content-desc`（写给她看的句子），所以 `read` 一遍就懂 —— 这是"让 AI 理解"的全部手段。

## 数据

```
/sdcard/Android/data/com.bluefish.diary/files/diary/
  2026-11-11_210336.md     一篇一个文件（一天多少篇都行）
  trash/                   删掉的（软删，留底）
  deleted.log              一行一次：{"at":…,"file":…,"gist":…,"len":…}
```

- 用 `getExternalFilesDir`（零权限、纯 File IO）；这台 MuMu 的 `adb shell` 带 `ext_data_rw` 组，
  `adb shell cat` 直接读 → 主进程不用 root、不占步数。
- **不要**改用 `MediaStore` / `Documents`：Android 12 分区存储会多一层 URI，收益是零。
- 路径全 ASCII（中文路径在 adb shell 里要转义）。

## 怎么出包（不装 Android Studio、不用 Gradle）

工具链在仓库外层：`_android\{jdk,build-tools,platform}`（Temurin JDK 17 + build-tools r34 + platform-31，
约 290MB，来自清华 Adoptium 镜像和腾讯 AndroidSDK 镜像）。**它不进库**（`.gitignore` 里有 `_android/`）。

```powershell
powershell -ExecutionPolicy Bypass -File tools\diary-app\build.ps1
# 出包并装进模拟器：
powershell -ExecutionPolicy Bypass -File tools\diary-app\build.ps1 -Install
# 工具链在别处：
... -build.ps1 -Toolchain D:\somewhere\_android
```

步骤就是 `javac → d8 → aapt2 compile(res) → aapt2 link → 塞 classes.dex → zipalign → apksigner`，产物 `out/her-diary.apk`。

## 图标

`res/mipmap-{mdpi,hdpi,xhdpi,xxhdpi,xxxhdpi}/ic_launcher.png`（48/72/96/144/192）—— 用的是**她自己的头像**
（222×219 那张），居中裁成正方形再缩；清单里只有一句 `android:icon="@mipmap/ic_launcher"`。

换图标：新图放进来（正方形、≥192px），按同样尺寸覆盖这五个文件，重跑 `build.ps1 -Install`。
⚠️ 不做 adaptive icon（`mipmap-anydpi-v26`）：MuMu 的 Lawnchair 会自己给老式 PNG 套圆角，够用；
adaptive 要 108dp 画布 + 安全区，还得再多两层图。
⚠️ 改完 `res/` 一定要重跑 `aapt2 compile`（脚本里已经有了），否则 APK 里还是旧图标。

## 坑

1. **keystore 别丢**：`tools/diary-app/debug.keystore`（口令 `android`）。换一个就装不上
   （`INSTALL_FAILED_UPDATE_INCOMPATIBLE`），只能 `adb uninstall com.bluefish.diary` 重装 —— 那会把她的日记一起删掉。
2. **`build.ps1` 全 ASCII**：Windows PowerShell 读没有 BOM 的 .ps1 会按 ANSI 解，中文注释会把解析器弄崩。
   要写中文就存成 **带 BOM 的 UTF-8**。
3. **`keytool` / `d8` 会往 stderr 写进度**：所以脚本里 `$ErrorActionPreference='Continue'`，成败只看 `$LASTEXITCODE`。
4. 装包时 adb 会先试 *Incremental Install* 并报 `Incremental installation not allowed`，随后
   *Streamed Install* 成功 —— 那行异常是噪音，看最后的 `Success`。
5. 屏 B 的输入框在空的时候，`uiautomator dump` 里 `text` 会是 **hint**（"想写什么就写什么…"），
   不是空字符串 —— 判断"她写了没有"要看整段是不是 hint。

## 改了代码之后

```powershell
powershell -ExecutionPolicy Bypass -File tools\diary-app\build.ps1 -Install
node test\run-one.cjs 31-diary.cjs          # 纯逻辑那部分，0.5 秒
```

真机探针（需要沙箱外）：`node tools\_probe-diary.cjs "随便一句"` —— 它会开本子、敲字、保存、回读核对。
