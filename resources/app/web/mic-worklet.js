/**
 * 麦克风的采集端（AudioWorklet）。
 *
 * 页面 `pet-app.js` 的 `startMic()` 用 `new AudioWorkletNode(ctx, 'pet-mic')` 建它：
 * AudioContext 已经固定 **16000Hz**，所以这里拿到的就是 16k 单声道 Float32。
 *
 * 做两件事：
 *   ① 转成 **int16（PCM16LE）** —— WAV / 方舟都吃这个，带宽也砍一半；
 *   ② 攒够 **1024 个采样（64ms）** 才 `postMessage` 一次，别让 128 帧一个消息把
 *      WebSocket 刷成每秒 375 条（实测那样主进程光解析就占 CPU）。
 *
 * 页面收到的是 `ArrayBuffer`，直接 `ws.send(e.data)` 发成二进制帧；
 * 主进程那边（`pet.cjs`）认出二进制就交给 `companion-asr.cjs` 的 `MicAsr` 切句。
 */
class PetMic extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Int16Array(1024);
    this.n = 0;
  }

  process(inputs) {
    const input = inputs[0];
    const ch = input && input[0];
    if (!ch || !ch.length) return true;
    for (let i = 0; i < ch.length; i += 1) {
      // 夹到 [-1,1] 再转 int16：超过 1 的采样直接取边界，别让它回绕成爆音
      const s = ch[i] < -1 ? -1 : ch[i] > 1 ? 1 : ch[i];
      this.buf[this.n] = s < 0 ? s * 0x8000 : s * 0x7fff;
      this.n += 1;
      if (this.n >= 1024) {
        const out = this.buf.buffer;
        // 转移所有权（不复制），然后换一块新的继续写
        this.port.postMessage(out, [out]);
        this.buf = new Int16Array(1024);
        this.n = 0;
      }
    }
    return true;
  }
}

registerProcessor('pet-mic', PetMic);
