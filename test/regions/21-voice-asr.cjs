/**
 * 自检区域：她的耳朵（语音识别，2026-11-02 新增）
 *
 * 这一区**不联网、不开麦克风**，只验"契约"和"切句"：
 *   A. 配置：默认值 / 夹范围 / 单独存 `voice-asr.json`（不能和 companion.json 互相覆盖）；
 *   B. 请求体：方舟 `input_audio` 的结构、`thinking` 默认关、模型 ID；
 *   C. 解析：JSON / ```json 围栏 / 前面带废话 / 干脆不是 JSON 四种回法都要能吐出文字；
 *   D. 音频小工具：PCM→WAV 的头、RMS、格式识别；
 *   E. 真发一遍（假 fetch）：鉴权头、超时/HTTP 错误怎么变成一句人话；
 *   F. 麦克风切句（MicAsr）：静音不出段、说完一句出段、太短丢掉、太长强制吐、被她自己的声音捂耳朵；
 *   G. QQ：record 段（数组和 CQ 码两种）都要被留下来。
 *
 * 真接口怎么验：部署后 `node tools\_probe-asr.cjs`（那个会真的调一次方舟）。
 * 单跑：`node test\run-one.cjs 21-voice-asr.cjs`
 */
module.exports = {
  name: '她的耳朵（语音识别）',
  tags: ['companion', 'voice', 'asr', '语音识别'],
  async run(ctx) {
    const { ok } = ctx;
    const A = ctx.mod('companion-asr');
    const ob = ctx.mod('companion-onebot');

    /* ---------- A. 配置 ---------- */

    const d = A.normalize({});
    ok('语音识别：默认开着', d.enabled === true);
    ok('语音识别：默认模型是测试页验通的 doubao-seed-2-1-lite-260915', d.ark.model === 'doubao-seed-2-1-lite-260915');
    ok('语音识别：默认不吃深度思考（等 20 秒听一句话不值得）', d.ark.thinking === false);
    ok('语音识别：没填 Key 时 ready() 是 false（不假装能听）', d.ark.apiKey === '' && A.ready(d) === false);
    ok('语音识别：默认收到语音后**不替她决定**（回文字还是语音随她）', d.reply.voice === 'free');
    const bad = A.normalize({
      ark: { timeoutMs: 1, temperature: 9 },
      reply: { voice: 'sometimes' },
      mic: { threshold: 9, silenceMs: 1, minSpeechMs: 1, maxSegmentMs: 999999, prerollMs: -5 },
      qq: { maxRecords: 99, maxBytes: 1 },
    });
    ok('语音识别：越界的旋钮都夹回去',
      bad.ark.timeoutMs === 5000 && bad.ark.temperature === 1
      && bad.mic.threshold === 0.2 && bad.mic.silenceMs === 200 && bad.mic.minSpeechMs === 100
      && bad.mic.maxSegmentMs === 120000 && bad.mic.prerollMs === 0
      && bad.qq.maxRecords === 5 && bad.qq.maxBytes === 200_000);
    ok('语音识别：reply.voice 只认 free/always/never（老配置里的 auto 归到 free）',
      bad.reply.voice === 'free' && A.normalize({ reply: { voice: 'always' } }).reply.voice === 'always'
      && A.normalize({ reply: { voice: 'never' } }).reply.voice === 'never');
    ok('语音识别：只有明确写 false 才算关', A.normalize({ enabled: false }).enabled === false);

    // 单独一个配置文件：写进去能读回来，而且不在 companion.json 里
    const saved = A.save({ ark: { apiKey: 'test-ark-key' } });
    ok('语音识别：Key 存在单独的 voice-asr.json 里',
      saved.ark.apiKey === 'test-ark-key' && A.CONFIG_FILE.endsWith('voice-asr.json')
      && A.CONFIG_FILE.startsWith(ctx.CONFIG_DIR));
    ok('语音识别：写进去之后 settings() 读得到（改完不用重启）',
      A.settings().ark.apiKey === 'test-ark-key' && A.ready(A.settings()) === true);
    ok('语音识别：保存是深合并，别把别的默认值冲掉',
      A.settings().mic.silenceMs === d.mic.silenceMs && A.settings().ark.model === d.ark.model);

    /* ---------- B. 请求体 ---------- */

    const prompt = A.buildPrompt();
    ok('语音识别：提示词要"逐字转写"而不是"概括"', /逐字/.test(prompt) && !/只要概括/.test(prompt));
    ok('语音识别：提示词要求情绪 / 语气 / 语速 / 音量 / 背景 / 概括',
      ['emotion', 'tone', 'rate', 'volume', 'background', 'summary'].every((k) => prompt.includes(`"${k}"`)));
    ok('语音识别：提示词交代了"听不清就写 □，不要猜"', /听不清/.test(prompt) && /□/.test(prompt));
    ok('语音识别：context 会写进提示词（QQ 语音条可能有噪声）',
      A.buildPrompt({ context: '来自 QQ 的语音条' }).includes('来自 QQ 的语音条'));

    const cfg = A.normalize({ ark: { apiKey: 'k' } });
    const body = A.buildBody(cfg, { audio: 'QUJD', format: '.wav' });
    ok('语音识别：请求体是 chat/completions 那一套（audio + text 两段）',
      body.model === cfg.ark.model && body.temperature === 0.1
      && body.messages[0].content.length === 2
      && body.messages[0].content[0].type === 'input_audio'
      && body.messages[0].content[0].input_audio.data === 'QUJD'
      && body.messages[0].content[0].input_audio.format === 'wav'
      && body.messages[0].content[1].type === 'text');
    ok('语音识别：默认 thinking:{type:"disabled"}（测试页量过：不关会先想）',
      body.thinking && body.thinking.type === 'disabled');
    ok('语音识别：想开深度思考时就不带 thinking 字段',
      !('thinking' in A.buildBody(A.normalize({ ark: { thinking: true } }), { audio: 'QQ==' })));

    /* ---------- C. 解析模型回复 ---------- */

    const j = A.parseModelText(JSON.stringify({
      text: '今天有点累…早点睡吧', emotion: '疲惫', tone: '压着声音', rate: '偏慢',
      volume: '偏小', background: '键盘声', summary: '让我早点睡', uncertain: ['累', '睡吧'],
    }));
    ok('语音识别：标准 JSON 全字段都解析出来',
      j.text === '今天有点累…早点睡吧' && j.emotion === '疲惫' && j.tone === '压着声音'
      && j.rate === '偏慢' && j.volume === '偏小' && j.background === '键盘声'
      && j.summary === '让我早点睡' && j.uncertain.length === 2);
    const fence = A.parseModelText('```json\n{"text":"听见了","emotion":"高兴"}\n```');
    ok('语音识别：包了 ```json 围栏也认', fence.text === '听见了' && fence.emotion === '高兴');
    const chatty = A.parseModelText('好的，结果如下：{"text":"嗯嗯","tone":"敷衍"} 以上。');
    ok('语音识别：前面带一句废话也把 JSON 抠出来', chatty.text === '嗯嗯' && chatty.tone === '敷衍');
    const plain = A.parseModelText('他说今天不想吃饭');
    ok('语音识别：模型不按格式回时，整段当转写（宁可丢语气别丢话）', plain.text === '他说今天不想吃饭');
    const silent = A.parseModelText('{"text":"","emotion":"其他","tone":"听不清"}');
    ok('语音识别：没人说话时 text 是空串，不是整段 JSON',
      silent.text === '' && silent.tone === '听不清');
    ok('语音识别：cleanText 只剥围栏，不动正文',
      A.cleanText('```json\n{"a":1}\n```') === '{"a":1}' && A.cleanText(' 你好 ') === '你好');

    /* ---------- D. 音频小工具 ---------- */

    const pcm = Buffer.alloc(16_000 * 2 * 2);           // 2 秒 16k 单声道
    for (let i = 0; i < 16_000 * 2; i++) {
      pcm.writeInt16LE(Math.round(Math.sin((i / 16_000) * 2 * Math.PI * 440) * 0.3 * 32767), i * 2);
    }
    const wav = A.pcm16ToWav(pcm);
    ok('语音识别：WAV 头对（RIFF/WAVE/16k/单声道/16bit）',
      wav.slice(0, 4).toString() === 'RIFF' && wav.slice(8, 12).toString() === 'WAVE'
      && wav.readUInt16LE(22) === 1 && wav.readUInt32LE(24) === 16000
      && wav.readUInt16LE(34) === 16 && wav.slice(36, 40).toString() === 'data');
    ok('语音识别：WAV 的长度字段跟着 PCM 走',
      wav.readUInt32LE(40) === pcm.length && wav.readUInt32LE(4) === pcm.length + 36
      && wav.length === pcm.length + 44);
    ok('语音识别：半截采样不会被写进 WAV', A.pcm16ToWav(Buffer.alloc(101)).length === 44 + 100);
    ok('语音识别：静音的 RMS 是 0', A.rms(Buffer.alloc(3200)) === 0);
    const level = A.rms(pcm);
    ok('语音识别：0.3 振幅正弦的 RMS 约 0.21（够过默认阈值 0.01）', level > 0.19 && level < 0.23);
    ok('语音识别：认得出 mp3 / wav / m4a / amr 的头',
      A.sniffAudioFormat(Buffer.from('ID3\x03\x00\x00\x00', 'latin1')) === 'mp3'
      && A.sniffAudioFormat(wav) === 'wav'
      && A.sniffAudioFormat(Buffer.from('\x00\x00\x00\x18ftypM4A ', 'latin1')) === 'm4a'
      && A.sniffAudioFormat(Buffer.from('#!AMR\n', 'latin1')) === 'amr');
    ok('语音识别：认不出的头不硬猜', A.sniffAudioFormat(Buffer.from('abcd')) === '');

    /* ---------- E. 真发一遍（假 fetch） ---------- */

    const seen = [];
    const fakeOk = async (url, init) => {
      seen.push({ url, init });
      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({
          model: 'doubao-seed-2-1-lite-260915',
          choices: [{ message: { content: JSON.stringify({ text: '你说什么', emotion: '高兴', tone: '笑着说' }) } }],
          usage: { prompt_tokens: 120, completion_tokens: 20 },
        }),
      };
    };
    const good = A.transcribe(cfg, { audio: 'QUJD', format: 'mp3', fetchImpl: fakeOk });
    const goodR = await good;
    ok('语音识别：成功的调用返回文字 + 情绪',
      goodR.ok === true && goodR.text === '你说什么' && goodR.emotion === '高兴' && goodR.tone === '笑着说');
    ok('语音识别：用了 Bearer 鉴权，打到 ark 的 chat/completions',
      /^Bearer k$/.test(seen[0].init.headers.authorization)
      && /ark\.cn-beijing\.volces\.com\/api\/v3\/chat\/completions$/.test(seen[0].url));
    ok('语音识别：usage / 模型名 / 耗时都带回来',
      goodR.usage?.prompt_tokens === 120 && goodR.model === 'doubao-seed-2-1-lite-260915' && goodR.ms >= 0);

    const r401 = await A.transcribe(cfg, {
      audio: 'QUJD',
      fetchImpl: async () => ({
        ok: false, status: 401,
        text: async () => JSON.stringify({ error: { code: 'AuthenticationError', message: 'invalid api key' } }),
      }),
    });
    ok('语音识别：Key 错了会说人话（AuthenticationError），不是静默失败',
      r401.ok === false && /AuthenticationError/.test(r401.error || '') && /invalid api key/.test(r401.error || ''));
    const rHtml = await A.transcribe(cfg, {
      audio: 'QUJD',
      fetchImpl: async () => ({ ok: true, status: 200, text: async () => '<html>502</html>' }),
    });
    ok('语音识别：上游回网页/坏 JSON 时明确失败', rHtml.ok === false && /不是 JSON/.test(rHtml.error || ''));
    const noKey = await A.transcribe(A.normalize({}), { audio: 'QUJD', fetchImpl: fakeOk });
    ok('语音识别：没 Key 直接拒绝，不发请求', noKey.ok === false && /Key/.test(noKey.error || ''));
    const noAudio = await A.transcribe(cfg, { audio: '', fetchImpl: fakeOk });
    ok('语音识别：没音频直接拒绝', noAudio.ok === false && /没有收到音频/.test(noAudio.error || ''));

    /* ---------- F. 给模型看的语气小句 ---------- */

    ok('语音识别：describe() 把"听到什么 + 怎么说的"合成一句',
      /语音：/.test(A.describe(goodR)) && /高兴/.test(A.describe(goodR)) && /笑着说/.test(A.describe(goodR)));
    ok('语音识别：toneNote() 只带语气，不重复正文',
      !A.toneNote(goodR).includes('你说什么') && /高兴/.test(A.toneNote(goodR)));
    ok('语音识别：平静 / 正常这些默认档不啰嗦',
      A.toneNote({ emotion: '平静', rate: '正常', volume: '正常', background: '无' }) === '（他是用语音说的）');
    ok('语音识别：没听出内容时 describe 会如实说',
      /没听清/.test(A.describe({ ok: true, text: '', tone: '听不清' })));

    /* ---------- G. 麦克风切句 ---------- */

    let clock = 1_000_000;
    const events = [];
    const segs = [];
    const asrCfg = A.normalize({ mic: { threshold: 0.01, silenceMs: 700, minSpeechMs: 350, maxSegmentMs: 2000, prerollMs: 250 } });
    const mic = new A.MicAsr({
      asr: asrCfg,
      now: () => clock,
      onPhase: (p) => events.push(p.phase),
      onSegment: (buf, info) => segs.push({ buf, info }),
    });
    const SPEECH = Math.round(0.2 * 32767);
    const loud = Buffer.alloc(2048);
    for (let i = 0; i < 1024; i++) loud.writeInt16LE(i % 2 ? SPEECH : -SPEECH, i * 2);
    const hush = Buffer.alloc(2048);

    clock += 1000;
    mic.push(loud, clock);                    // 一小段噪声（还没到 350ms 口播）
    ok('语音识别：只"啊"一下就停（< minSpeechMs）不算一句话', segs.length === 0);
    for (let i = 0; i < 14; i++) { mic.push(hush, clock); clock += 64; }  // 静音 896ms → 判定说完
    ok('语音识别：噪声之后回到静音，不会吐段（太短直接丢）', segs.length === 0 && mic.speaking === false);

    clock += 1000;
    for (let i = 0; i < 8; i++) { mic.push(loud, clock); clock += 64; }   // 512ms 说话
    ok('语音识别：开口会先报 start（页面显示"正在听"）', events.includes('start') && mic.speaking === true);
    ok('语音识别：说话过程中不会提前吐段', segs.length === 0);
    for (let i = 0; i < 12; i++) { mic.push(hush, clock); clock += 64; }  // 768ms 静音
    ok('语音识别：静音 ≥700ms 就判定这句说完了，吐一段',
      segs.length === 1 && events.includes('segment') && mic.speaking === false);
    const first = segs[0];
    ok('语音识别：吐出来的是带 WAV 头的 16k 音频，时长对得上',
      first.buf.length > 0 && A.pcm16ToWav(first.buf).readUInt32LE(24) === 16000
      && Math.abs(first.info.ms - 1280) < 200);               // 250ms 预录 + 512ms 说话 + …
    ok('语音识别：预录把开口前那 250ms 也带上了（第一个字不会被切掉）',
      first.info.ms >= 512 + 200);

    segs.length = 0;
    clock += 2000;
    mic.push(loud, clock); clock += 64;
    mic.push(hush, clock); clock += 64;
    ok('语音识别：太短的一句（100ms）还是会被丢掉', segs.length === 0);

    // 太长：连说 2.2 秒（配置上限 2 秒）→ 强制吐一段，不等静音
    segs.length = 0;
    clock += 2000;
    for (let i = 0; i < 40; i++) { mic.push(loud, clock); clock += 64; }
    ok('语音识别：说个不停时按 maxSegmentMs 强制断开（不会永远不吐）',
      segs.length >= 1 && segs[0].info.why === 'max');

    // 她自己在说话：捂上耳朵
    segs.length = 0;
    clock += 5000;
    mic.muteFor(1000);
    for (let i = 0; i < 10; i++) { mic.push(loud, clock); clock += 64; }
    ok('语音识别：她那句语音还在放的时候，麦克风听到的一切都不算（防自问自答）', segs.length === 0);
    clock += 1200;
    for (let i = 0; i < 8; i++) { mic.push(loud, clock); clock += 64; }
    for (let i = 0; i < 12; i++) { mic.push(hush, clock); clock += 64; }
    ok('语音识别：捂完耳朵后照常能听', segs.length === 1);

    // 页面报"念完了" → 立刻放开（不用等按字数估的那段）
    segs.length = 0;
    clock += 3000;
    mic.muteFor(20_000);
    for (let i = 0; i < 10; i++) { mic.push(loud, clock); clock += 64; }
    const muted = segs.length;
    mic.unmute();
    for (let i = 0; i < 8; i++) { mic.push(loud, clock); clock += 64; }
    for (let i = 0; i < 12; i++) { mic.push(hush, clock); clock += 64; }
    ok('语音识别：页面报"念完了"就立刻放开耳朵（估的时间还没到）',
      muted === 0 && segs.length === 1);

    // 手动"说完了"
    segs.length = 0;
    clock += 3000;
    for (let i = 0; i < 8; i++) { mic.push(loud, clock); clock += 64; }
    const committed = mic.commit();
    ok('语音识别：长按"说完了"立刻吐段，不等静音判定', committed === true && segs.length === 1 && segs[0].info.why === 'commit');

    /* ---------- H. QQ：把语音条留下来 ---------- */

    const segsArr = ob.segsToRecords([
      { type: 'text', data: { text: '听' } },
      { type: 'record', data: { file: 'abc.amr', url: 'https://x/y', file_size: 1234 } },
      { type: 'record', data: { file: '' } },
      { type: 'image', data: { url: 'https://x/p.png' } },
    ]);
    ok('语音识别：QQ 的 record 段被留下来（file 令牌给 get_record 用）',
      segsArr.length === 1 && segsArr[0].file === 'abc.amr' && segsArr[0].url === 'https://x/y' && segsArr[0].fileSize === 1234);
    const cqRecs = ob.cqToRecords('[CQ:record,file=abc.amr,url=https://x/y] 听一下 [CQ:image,file=a.png]');
    ok('语音识别：字符串形式的 CQ 码也认', cqRecs.length === 1 && cqRecs[0].file === 'abc.amr');
    ok('语音识别：没有 file 也没有 url 的 record 段不硬留', ob.segsToRecords([{ type: 'record', data: {} }]).length === 0);

    /* ---------- I. 处境里的那句话（"回文字还是回语音由她自己决定"） ---------- */

    const C = ctx.mod('companion');
    const items = [{
      voiceMeta: {
        lines: [{ text: '今天有点累', emotion: '疲惫', tone: '压着声音', rate: '偏慢', volume: '偏小', background: '无', summary: '想早点睡' }],
        failed: 1,
      },
    }];
    const freeHint = C.asr.situationFor(items);
    ok('语音识别：处境里写明"他是用语音说的"+语气', /用语音/.test(freeHint) && /疲惫/.test(freeHint) && /压着声音/.test(freeHint));
    ok('语音识别：默认（free）明说"回文字还是回语音由她自己决定"',
      /也可以打字/.test(freeHint) && /你自己的意思/.test(freeHint));
    ok('语音识别：有语音没听清时提醒"别装作听见了"', /没听清/.test(freeHint) && /别装作听见了/.test(freeHint));
    ok('语音识别：没有语音的一批返回空串（不污染普通回复）', C.asr.situationFor([{ text: '你好' }]) === '');

    A.save({ reply: { voice: 'always' } });
    ok('语音识别：切成 always 之后，处境里改口"这一条用语音回"',
      /用语音回/.test(C.asr.situationFor(items)) && !/也可以打字/.test(C.asr.situationFor(items)));
    A.save({ reply: { voice: 'free' } });

    /* ---------- J. 桌宠里她回话的语音开关（2026-11-02 用户："在音色里加开关"） ---------- */

    const P = ctx.mod('pet');
    const L = ctx.mod('llm');
    ok('桌宠回话：设置里默认是开的（deskVoice）', L.defaults().deskVoice === true);
    ok('桌宠回话：默认开 —— 不再被 QQ 的 bubbleVoice 一起关掉',
      P.deskVoiceOn({}) === true && P.deskVoiceOn({ deskVoice: true }) === true);
    ok('桌宠回话：只有明确关掉才不出声', P.deskVoiceOn({ deskVoice: false }) === false);
    ok('桌宠回话：这一格和 QQ 的 bubbleVoice 是两个键（互不影响）',
      'deskVoice' in L.defaults() && !('bubbleVoice' in L.defaults()));
    ok('桌宠回话：默认用火山 1.0（很快；没 Key 时 pet.cjs 会自动退回本机音色）',
      L.defaults().deskVoiceKit === 'cloud');
  },
};
