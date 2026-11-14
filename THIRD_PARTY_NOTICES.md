# 第三方声明

这个包**不带** Electron 运行时、本地语音模型、NapCat（QQ 网关）和安卓模拟器：
前两个由 `tools\setup-runtime.ps1` / `tools\setup-tts.ps1` 下载，后两个由用户自己安装。
下面是随包的东西、运行时会去取的东西，以及各自的许可。

## 不随包、自己装或自己申请的

| 东西 | 从哪来 | 许可 |
|---|---|---|
| Electron 44.4.4 | `tools\setup-runtime.ps1` 下官方 zip 并按 `SHASUMS256.txt` 校验（GitHub / npmmirror） | MIT；里面的 Chromium 与依赖各随其许可 |
| sherpa-onnx + 音色模型 | `tools\setup-tts.ps1`（npm registry + k2-fsa releases），**可选** | Apache-2.0（含 onnxruntime，MIT）；音色模型见下 |
| NapCat（QQ 网关） | <https://github.com/NapNeko/NapCatQQ>，**可选** | AGPL-3.0 —— 它是独立程序，本包不链接也不修改它 |
| MuMu 模拟器 12 | <https://mumu.163.com>，**可选** | 网易的专有软件，按它的用户协议使用 |
| 火山「豆包语音合成 1.0」/ 方舟语音识别 | 自己申请 API Key，**可选** | 商业服务，按火山引擎的条款与计费 |

## 识别运行库

[sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) 的 Node 插件 `sherpa-onnx-node` 1.13.8 与各平台的
预编译包(`sherpa-onnx-win-x64`、`sherpa-onnx-darwin-arm64`、`sherpa-onnx-darwin-x64` 等),随 npm 依赖安装。
Apache-2.0;其中的 onnxruntime 为 MIT。

## 模型

FunASR 的 SenseVoiceSmall(FunAudioLLM,通义实验室)经 k2-fsa 转成 sherpa-onnx 用的 int8 ONNX,
放在 `<模型根>/desktop-pet/sensevoice-small-int8-2024-07-17/`,按固定的 SHA-256 校验。

| 文件 | 来源(按顺序尝试) | 许可 |
|---|---|---|
| `model.int8.onnx`、`tokens.txt` | [ModelScope pengzhendong/sherpa-onnx-sense-voice-zh-en-ja-ko-yue](https://modelscope.cn/models/pengzhendong/sherpa-onnx-sense-voice-zh-en-ja-ko-yue),再 [Hugging Face csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17](https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17) | [FunASR 模型开源协议](https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE) |

## 桌宠窗口

Electron 44.4.4,从 [electron/electron releases](https://github.com/electron/electron/releases/tag/v44.4.4)
取到 `<运行时根>/electron/44.4.4/`,或使用内嵌应用自带的那份。MIT;其中 Chromium 与依赖各随其许可。

## DeepSeek 大肥鱼形象

`web/whale/` 的贴图由 ChatGPT(OpenAI 的图像模型)按参考图生成后拆件:角色原设为「溟月」(上善无形),
DeepSeek 女仆装二创参考 ZipZipPipe。围裙上的标志是 DeepSeek、OpenAI、Anthropic(Claude)、Google(Gemini)、
阿里云(通义千问)、月之暗面(Kimi)、MiniMax 的商标图形,归各自的公司所有,只用来标明配色对应哪一家,
与这些公司没有关联,也不代表其认可。

这些贴图不在本包的 AGPL 授权范围内。它们随 Coopanion 分发,想在别处使用请自行确认原设与各家标志的权利。

## 其他运行时依赖

- `ws`:MIT
- `opencc-js`(繁简转换):MIT AND Apache-2.0

## 本包的许可

AGPL-3.0-or-later,见 [`LICENSE`](LICENSE);`web/whale/` 的贴图除外,见上。
并入 Coopanion 之前的版本(独立仓库 `Pal-AI-Lab/cortico-world-desktop-pet` 里的历史)是 MIT。
