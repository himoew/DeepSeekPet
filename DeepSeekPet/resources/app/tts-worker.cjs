/**
 * 语音合成的工作线程：把 sherpa-onnx 的模型加载和合成都放到主线程之外。
 *
 * 为什么必须开线程：合成一句话要 0.3–2.9 秒的 CPU，全在 Node 主线程上会把整个桌宠卡住
 * （WebSocket 收发、气泡队列、空闲计时全停）。
 *
 * 消息协议（父线程 → 这里）：
 *   { id, text, speed }           合成一句
 *   { id, kind: 'warm' }          只加载模型，不做别的（启动时预热）
 * 这里回：{ id, ok: true, sampleRate, samples } 或 { id, ok: false, error, stack }
 * `samples` 是 Float32Array，用 transfer 送过去，不复制。
 *
 * 用哪套音色由 `workerData.voice` 给（`{ kind, sid, files }`，来自 tts-voice.cjs），
 * 这里**不认识**具体音色名字，只知道怎么按描述把模型装起来。
 */
const path = require('node:path');
const { parentPort, workerData } = require('node:worker_threads');

const V = workerData.voice || {};
const F = V.files || {};
const kind = V.kind || 'vits';

let tts = null;
let loadError = null;
let loading = null;
const queue = [];

/**
 * 加载模型。原生插件和两个 onnxruntime DLL 都在 sherpa-onnx-win-x64 里，
 * 而且它在 sherpa-onnx-node 的**同级目录**，所以 addon.js 自己就能找到；
 * PATH 只是保险（DLL 是运行时按名字加载的）。
 */
function load() {
  if (loading) return loading;
  loading = new Promise((resolve) => {
    try {
      const winPkg = path.join(workerData.moduleDir, '..', 'sherpa-onnx-win-x64');
      process.env.PATH = `${winPkg};${process.env.PATH}`;
      const sherpa = require(path.join(workerData.moduleDir, 'non-streaming-tts.js'));

      // 按音色描述拼模型配置。可选字段（lexicon / dictDir / dataDir / ruleFsts）
      // **只在真有的时候才放进去**：sherpa 拿到不存在的路径会直接抛，不是忽略。
      const k = V.knobs || {};
      const model = {};
      model[kind] = {
        model: F.model,
        tokens: F.tokens,
        ...(F.lexicon ? { lexicon: F.lexicon } : {}),
        ...(F.dictDir ? { dictDir: F.dictDir } : {}),
        ...(F.dataDir ? { dataDir: F.dataDir } : {}),
        // 中文的文本规则：日期、数字、电话号码，不给会读得很怪
        ...(F.ruleFsts && F.ruleFsts.length ? { ruleFsts: F.ruleFsts.join(',') } : {}),
        // **合成旋钮**（用户在语音编辑页调的）。这三个是 VITS 的模型级参数，
        // 只能在建 OfflineTts 时给，所以改它们要重建 worker（tts.cjs 的 reload() 就这么做）。
        //   noiseScale  小 = 稳（"忽大忽小"的元凶）
        //   noiseScaleW  小 = 音高平稳
        //   lengthScale 音素时长，配合 speed 决定黏不黏
        ...(Number.isFinite(k.noiseScale) ? { noiseScale: k.noiseScale } : {}),
        ...(Number.isFinite(k.noiseScaleW) ? { noiseScaleW: k.noiseScaleW } : {}),
        ...(Number.isFinite(k.lengthScale) ? { lengthScale: k.lengthScale } : {}),
      };

      tts = new sherpa.OfflineTts({
        model,
        numThreads: workerData.numThreads,
        provider: 'cpu',
        // 句间停顿放**这里**（配置级），不要放进 generate() 的 `generationConfig`：
        // 一旦请求里带了 `generationConfig`，sherpa 会走 `offlineTtsGenerateWithConfig`
        // 那条路，而**那条路不认 `speed`**——实测同一条长句 speed 从 0.6 到 2.0 全长 8.2 秒，
        // 语速滑杆完全失效。**这个坑很隐蔽：不报错，只是参数被静静忽略。**
        ...(Number.isFinite(k.silenceScale) ? { silenceScale: k.silenceScale } : {}),
      });
      resolve(tts);
    } catch (err) {
      loadError = err;
      resolve(null);
    }
  });
  return loading;
}

function synth(job) {
  if (!tts) {
    parentPort.postMessage({ id: job.id, ok: false, error: loadError ? loadError.message : '模型没加载' });
    return;
  }
  try {
    // **`enableExternalBuffer: false` 是必须的**，别删。
    // sherpa 默认（true）会把原生内存直接包成一个 Float32Array（零拷贝）。这个包法在
    // 打包进 Electron 后**一定失败**：Electron 44 带的是 V8 15.2，比纯 Node 24 的 V8 13.6
    // 新，新 V8 拒绝了那个外部分配，抛的是一句看起来毫不相干的
    //   Error: External buffers are not allowed
    // 于是每一句都合成失败、桌宠从此不出声（而且**只在 Electron 里**复现，命令行
    // `node test\smoke.cjs` 用纯 Node 跑永远是绿的——这个坑就是这么骗过自检的）。
    // 关掉它只是多一次内存拷贝（实测 1.2 秒的音频多花几十毫秒），换来的是真的能出声。
    //
    // 每次合成还可以带一份**临时**参数（`job.voice`）：语音编辑页"试听别的音色"用它，
    // 不动全局状态。`sid` 和 `speed` 是 generate() 级的，可以逐句改；
    // noiseScale 那三个是模型级的，只能靠重建 worker（见上面 model 那段）。
    const over = job.voice || {};
    const knobs = { ...(V.knobs || {}), ...(over.knobs || {}) };
    // **不要**在这里加 `generationConfig`——见上面 silenceScale 那段注释，加了 speed 就失效
    const audio = tts.generate({
      text: job.text,
      sid: Number.isInteger(over.sid) ? over.sid : (Number.isInteger(job.sid) ? job.sid : (V.sid || 0)),
      speed: job.speed || knobs.speed || 1,
      enableExternalBuffer: false,
    });
    const samples = Float32Array.from(audio.samples);
    parentPort.postMessage({ id: job.id, ok: true, sampleRate: audio.sampleRate, samples }, [samples.buffer]);
  } catch (err) {
    parentPort.postMessage({ id: job.id, ok: false, error: err.message, stack: err.stack });
  }
}

parentPort.on('message', (job) => {
  if (job.kind === 'warm') {
    load().then((m) => parentPort.postMessage({ id: job.id, ok: !!m, error: loadError && loadError.message }));
    return;
  }
  // 合成请求排成一条队：模型加载完之后才轮到它们（第一条会等加载）
  queue.push(job);
  load().then(() => {
    if (!tts) return;                       // 加载失败：让每条请求各自收到错误
    while (queue.length) synth(queue.shift());
  });
  if (loadError) {
    while (queue.length) synth(queue.shift());
  }
});
