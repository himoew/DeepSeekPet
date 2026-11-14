/**
 * 自检区域：她的声音（QQ 语音，2026-11-01 新增）
 *
 * 用户要的是"她自己想发就发、想打一半打一半"。实测（deepseek-chat + 真实角色卡）
 * 让她自己决定要不要发语音，40 多次几乎一次都不发；但只要跟她说"先用语音说一句，
 * 再打字"，她 3/3 都照做。所以这一块拆成两半验：
 *
 *   A. 纯逻辑（不联网）：什么时候递话筒、文本清洗、哪条说哪条打；
 *   B. 真发一遍（假 TTS + 假 OneBot）：请求体对不对、语音段真的走 `record`、
 *      合成失败会不会退回文字、节奏状态会不会记。
 *
 * 单跑：`node test\run-one.cjs 17-voice.cjs`
 */
module.exports = {
  name: '她的声音（QQ 语音）',
  tags: ['companion', 'voice', '语音', 'tts'],
  async run(ctx) {
    const { ok } = ctx;
    const V = ctx.mod('companion-voice');
    const { OneBotClient } = ctx.mod('companion-onebot');
    const caps = ctx.mod('companion-capabilities');

    /* ---------- A. 配置 ---------- */

    const d = V.normalize({});
    ok('语音：默认是开的（用户 2026-11-01："默认开启语音"）', d.enabled === true);
    ok('语音：只有明确写 false 才算关', V.normalize({ enabled: false }).enabled === false);
    ok('语音：默认直连火山 1.0（不再经过 7860 调音台）',
      d.tts.resourceId === 'seed-tts-1.0' && /openspeech\.bytedance\.com/.test(d.tts.endpoint)
      && !('baseUrl' in d.tts));
    ok('语音：没填 Key 就不算有嗓子', d.tts.apiKey === '');
    ok('语音：默认没有间隔（"20 分钟那种"已去掉，她想说就说）',
      d.stage.minGapMin === 0 && d.stage.minTextBetween === 0);
    ok('语音：默认混音是佩奇猪40 / 撒娇学妹20 / 魅力女友40',
      d.tts.mix.length === 3
      && d.tts.mix[0].factor === 40 && d.tts.mix[1].factor === 20 && d.tts.mix[2].factor === 40
      && d.tts.mix[1].speaker === 'zh_female_yuanqinvyou_moon_bigtts');
    const clamped = V.normalize({ tts: { speechRate: 999, pitch: -99, maxChars: 5, emotion: 'tender' } });
    ok('语音：四个旋钮越界会夹回去', clamped.tts.speechRate === 100 && clamped.tts.pitch === -12 && clamped.tts.maxChars === 20);
    ok('语音：情感原样保留', clamped.tts.emotion === 'tender');
    const broken = V.normalize({ tts: { mix: [{ speaker: 'x', factor: 0 }] } });
    ok('语音：混音坏掉时退回默认三路', broken.tts.mix.length === 3);

    /* ---------- B. 什么时候递话筒 ---------- */

    const base = { enabled: true, tts: { apiKey: 'test-key' } };
    const st = (over = {}) => ({ ...V.newState(Date.now()), textsSince: 99, ...over });
    const night = new Date(2026, 10, 1, 23, 0, 0).getTime();   // 23:00
    const day = new Date(2026, 10, 1, 15, 0, 0).getTime();     // 15:00

    ok('语音：没开就永远不递话筒', V.decide({ voice: { enabled: false }, text: '发条语音', now: night }).mode === 'none');
    ok('语音：没配 Key 也不递话筒（不假装有嗓子）',
      V.decide({ voice: { enabled: true, tts: {} }, text: '发条语音', now: night }).why === 'no-key');
    ok('语音：群里默认不发', V.decide({ voice: base, isGroup: true, text: '发条语音', now: night, state: st() }).why === 'group');
    ok('语音：他要听就直接整条说（不看时间/间隔）',
      V.decide({ voice: base, text: '发条语音听听', now: day, state: st({ lastVoiceAt: day - 60_000, textsSince: 0 }) }).mode === 'voice');
    ok('语音：默认不卡间隔 —— 刚发过、中间没隔文字，照样能再发',
      V.decide({ voice: base, text: '在吗', now: night, state: st({ lastVoiceAt: night - 60_000, textsSince: 0 }), rng: () => 0 }).mode === 'mixed');
    ok('语音：把 minGapMin 调回 20 仍然会拦（代码留着，只是默认不拦）',
      V.decide({ voice: { ...base, stage: { minGapMin: 20 } }, text: '在吗', now: night, state: st({ lastVoiceAt: night - 5 * 60_000 }) }).why === 'gap');
    ok('语音：minTextBetween 调回 2 也仍然会拦',
      V.decide({ voice: { ...base, stage: { minTextBetween: 2 } }, text: '在吗', now: night, state: st({ textsSince: 1 }) }).why === 'rhythm');
    ok('语音：夜里（23:00）掷到就会先说一句再打字',
      V.decide({ voice: base, text: '我回来了', now: night, state: st(), rng: () => 0 }).mode === 'mixed');
    ok('语音：白天普通一句基本不打扰',
      V.decide({ voice: base, text: '我回来了', now: day, state: st(), rng: () => 0.99 }).why === 'quiet');
    ok('语音：他说"好累"这种话，白天也会更容易用声音',
      V.decide({ voice: base, text: '今天好累啊', now: day, state: st(), rng: () => 0.2 }).mode === 'mixed');
    ok('语音：她自己主动开口，更可能整条说',
      V.decide({ voice: base, text: '想起你了', unsolicited: true, now: day, state: st(), rng: () => 0 }).mode === 'voice');
    ok('语音：跨零点的夜里也算夜里', V.isNight(1, 21.5, 2) && !V.isNight(3, 21.5, 2) && V.isNight(23, 21.5, 2));

    /* ---------- C. 文本清洗 ---------- */

    const cleaned = V.cleanForSpeech('[语音]想你了[表情:晚安] https://x.com 😀（笑）\n今天早点睡');
    ok('语音：标记 / 链接 / 括号动作 / emoji 都不会念出来',
      cleaned === '想你了 今天早点睡' || cleaned === '想你了 今天早点睡，' || !/语音|表情|https|😀|笑/.test(cleaned));
    ok('语音：只有标记时没有可念的字', V.cleanForSpeech('[语音][表情:晚安]') === '');
    ok('语音：换行并成逗号（一条语音，不分条）', V.cleanForSpeech('今天好累\n早点睡') === '今天好累，早点睡');

    /* ---------- D. 哪条说、哪条打 ---------- */

    const mix = V.buildSegments(['[语音]想你了', '今天早点睡'], 'none');
    ok('语音：她写 [语音] 的行按语音发，其余照常打字',
      mix.voice === 1 && mix.segments[0].kind === 'voice' && mix.segments[1].kind === 'text'
      && mix.segments[1].text === '今天早点睡');
    const allVoice = V.buildSegments(['今天有点累', '不想打字'], 'voice');
    ok('语音：递了"整条说"的话筒，几条并成一条语音',
      allVoice.voice === 1 && allVoice.segments.length === 1 && allVoice.segments[0].text === '今天有点累，不想打字');
    const longVoice = V.buildSegments(['第一句'.repeat(12), '第二句'.repeat(12)], 'voice', { maxChars: 30 });
    ok('语音：整条说太长时按她原来的分条退回文字（不并成一大段）',
      longVoice.voice === 0 && longVoice.segments.length === 2 && longVoice.segments.every((s) => s.kind === 'text'));
    const auto = V.buildSegments(['累了就躺会儿', '你呢今天怎么样'], 'mixed');
    ok('语音：递了混合话筒但她没写标记 → 第一句说、后面打字',
      auto.voice === 1 && auto.segments[0].kind === 'voice' && auto.segments[1].text === '你呢今天怎么样');
    const oneLine = V.buildSegments(['今天真的好累啊不想说话'], 'mixed');
    ok('语音：只有一行时不硬拆成语音', oneLine.voice === 0 && oneLine.segments[0].kind === 'text');
    const many = V.buildSegments(['[语音]一', '[语音]二', '[语音]三'], 'none');
    ok('语音：一条里最多两段语音，第三段退回文字', many.voice === 2 && many.segments[2].kind === 'text');
    const tooLong = V.buildSegments(['[语音]' + '累'.repeat(40)], 'none', { maxChars: 20 });
    ok('语音：太长的一句宁可打字，也不发念一半的语音', tooLong.voice === 0 && tooLong.segments[0].kind === 'text');
    const emptyTag = V.buildSegments(['[语音]', '你好'], 'none');
    ok('语音：空的 [语音] 行不会漏出标记', emptyTag.voice === 0 && !emptyTag.segments.some((s) => s.text.includes('[')));
    const off = V.buildSegments(['[语音]想你了'], 'none', { allowVoice: false });
    ok('语音：功能关着时 [语音] 只当文字，绝不合成',
      off.voice === 0 && off.segments[0].kind === 'text' && off.segments[0].text === '想你了');

    /* ---------- E. 请求体（火山 v3，2026-11-01 从预览台搬过来的契约） ---------- */

    const req = V.requestBody(V.normalize({
      tts: { apiKey: 'k', speechRate: -5, loudnessRate: 0, pitch: 2, emotion: 'lovey-dovey' },
    }), '你好');
    const rp = req.req_params;
    ok('语音：请求体是火山的 user / req_params 两层',
      !!req.user.uid && rp.text === '你好' && rp.speaker === 'custom_mix_bigtts'
      && rp.audio_params.format === 'mp3' && rp.audio_params.sample_rate === 24000
      && rp.audio_params.speech_rate === -5 && rp.audio_params.loudness_rate === 0);
    ok('语音：情感跟着进去', rp.audio_params.emotion === 'lovey-dovey' && rp.audio_params.emotion_scale >= 1);
    ok('语音：音调走 additions.post_process', JSON.parse(rp.additions).post_process.pitch === 2);
    ok('语音：混音比例换成加起来等于 1 的小数（1.0 才支持混音）',
      rp.mix_speaker.speakers.length === 3
      && Math.abs(rp.mix_speaker.speakers.reduce((a, s) => a + s.mix_factor, 0) - 1) < 1e-6
      && rp.mix_speaker.speakers[0].source_speaker === 'zh_female_peiqi_mars_bigtts');
    /**
     * ★ 2026-11-01：**1/1/1 这种配比也要凑成刚好 1**。
     * 注释早写了"最后一位用余数补平"，代码却没做 —— 每项四舍五入成 0.3333，
     * 加起来 0.9999，上游会拒。默认 40/20/40 恰好是 1.0，所以这个坑一直没露头。
     */
    const equalMix = V.requestBody(V.normalize({
      tts: {
        mix: [
          { speaker: 'zh_female_peiqi_mars_bigtts', factor: 1 },
          { speaker: 'zh_female_yuanqinvyou_moon_bigtts', factor: 1 },
          { speaker: 'zh_female_peiqi_mars_bigtts', factor: 1 },
        ],
      },
    }), '你好');
    const eqSpeakers = equalMix.req_params.mix_speaker.speakers;
    const eqSum = eqSpeakers.reduce((a, s) => a + s.mix_factor, 0);
    ok('语音：1/1/1 的配比也补成刚好 1（以前是 0.9999，上游会拒）',
      eqSpeakers.length === 3 && Math.abs(eqSum - 1) < 1e-9
      && eqSpeakers[2].mix_factor === 0.3334);
    const hdrs = V.requestHeaders(V.normalize({ tts: { apiKey: '我的key' } }));
    ok('语音：请求头带 Key + 资源号 1.0', hdrs['X-Api-Key'] === '我的key' && hdrs['X-Api-Resource-Id'] === 'seed-tts-1.0');

    /* ---------- E2. 中间那个 ID3（2026-11-01 真机：她发不出语音的真凶） ---------- */

    const id3Tag = () => {
      const body = Buffer.alloc(35);           // 预览台拼出来的每个 TSSE 头都是 45 字节
      body.write('TSSE', 0, 'latin1');
      const head = Buffer.alloc(10);
      head.write('ID3', 0, 'latin1');
      head[3] = 4; head[4] = 0;
      head[6] = (body.length >> 21) & 0x7f;
      head[7] = (body.length >> 14) & 0x7f;
      head[8] = (body.length >> 7) & 0x7f;
      head[9] = body.length & 0x7f;
      return Buffer.concat([head, body]);
    };
    const frame = (n) => { const b = Buffer.alloc(n); b.fill(0xaa); b[0] = 0xff; b[1] = 0xfb; return b; };
    const oneChunk = Buffer.concat([id3Tag(), frame(120)]);
    const twoChunkAudio = Buffer.concat([id3Tag(), frame(120), id3Tag(), frame(120)]);

    const same = V.cleanAudioBase64(oneChunk.toString('base64'));
    ok('语音：只有一段音频（单个 ID3 头）时一个字节都不动',
      same.stripped === 0 && same.audio === oneChunk.toString('base64'));
    const merged = V.cleanAudioBase64(twoChunkAudio.toString('base64'));
    const mergedBuf = Buffer.from(merged.audio, 'base64');
    ok('语音：两段拼在一起时，中间那个 ID3 头会被摘掉（NapCat 就是卡在这里）',
      merged.stripped === 1 && mergedBuf.length === twoChunkAudio.length - 45
      && mergedBuf.indexOf('ID3', 1) === -1);
    const fakeId3 = Buffer.concat([id3Tag(), Buffer.from('....ID3xx....')]);
    ok('语音：音频数据里偶然出现的 ID3 三个字母不会被误剪',
      V.cleanAudioBase64(fakeId3.toString('base64')).stripped === 0);
    ok('语音：wav 不做帧级处理', V.cleanAudioBase64(twoChunkAudio.toString('base64'), { format: 'wav' }).stripped === 0);

    /* ---------- F. 假火山 + 假 OneBot：真走一遍 ---------- */

    const seen = { tts: [], headers: [], onebot: [] };
    const fake = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        let json = null;
        try { json = JSON.parse(raw || '{}'); } catch { /* 留 null */ }
        if (req.method === 'POST' && req.url === '/tts') {
          seen.tts.push(json);
          seen.headers.push(req.headers);
          const text = json?.req_params?.text || '';
          // 上游是「一行一个 JSON」的流；失败时只有一行 message，没有 data
          if (text === '故意失败') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end('{"code":45002001,"message":"No readable text!"}\n');
            return;
          }
          if (text === '两句') {
            const chunk = Buffer.concat([id3Tag(), frame(120)]).toString('base64');
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(`{"code":0,"data":"${chunk}"}\n{"code":0,"data":"${chunk}"}\n`);
            return;
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(`{"code":0,"data":"${Buffer.from('fake-mp3').toString('base64')}"}\n`);
          return;
        }
        if (req.method === 'POST' && /^\/send_(private|group)_msg$/.test(req.url || '')) {
          seen.onebot.push({ url: req.url, body: json });
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 1 } }));
          return;
        }
        res.writeHead(404); res.end('no');
      });
    });
    const port = await new Promise((resolve) => fake.listen(0, '127.0.0.1', () => resolve(fake.address().port)));
    const baseUrl = `http://127.0.0.1:${port}`;
    try {
      const v = V.normalize({ enabled: true, tts: { apiKey: 'test-key', endpoint: `${baseUrl}/tts` } });
      const r = await V.synthesize(v, '[语音]想你了');
      ok('语音：合成本身能通（假火山按"一行一个 JSON"回了 mp3）',
        r.ok === true && r.audio === Buffer.from('fake-mp3').toString('base64'));
      ok('语音：发出去的文本已经洗过（不带 [语音]）', seen.tts[0]?.req_params?.text === '想你了');
      ok('语音：合成请求真的带上了 Key / 1.0 / 混音三路 / 旋钮',
        seen.headers[0]?.['x-api-key'] === 'test-key'
        && seen.headers[0]?.['x-api-resource-id'] === 'seed-tts-1.0'
        && seen.tts[0]?.req_params?.mix_speaker?.speakers.length === 3
        && seen.tts[0]?.req_params?.audio_params?.speech_rate === -5);

      const bad = await V.synthesize(v, '故意失败');
      ok('语音：上游失败会带人话原因回来', bad.ok === false && /No readable text/.test(bad.error));

      const noKey = await V.synthesize(V.normalize({ enabled: true, tts: { endpoint: `${baseUrl}/tts` } }), '你好');
      ok('语音：没填 Key 时不去打网络，直接说清楚', noKey.ok === false && /API Key/.test(noKey.error) && seen.tts.length === 2);

      const twoSentences = await V.synthesize(v, '两句');
      ok('语音：合成回来是多段拼的，会先洗掉中间那个 ID3 再发',
        twoSentences.ok === true && twoSentences.id3Stripped === 1
        && Buffer.from(twoSentences.audio, 'base64').indexOf('ID3', 1) === -1);

      const p = await V.probe(v);
      ok('语音：探活只看本地 Key（不联网、不花钱）', p.ok === true && p.resourceId === 'seed-tts-1.0');
      ok('语音：没 Key 时探活说人话', (await V.probe(V.normalize({ enabled: true, tts: {} }))).ok === false);

      const client = new OneBotClient({
        wsUrl: 'ws://127.0.0.1:1', httpUrl: baseUrl, onMessage: () => {},
      });
      const sent = await client.sendRecord('private:10000001', r.audio);
      ok('语音：OneBot 用 record 段发（base64://，NapCat 能直接转）',
        sent.ok === true && seen.onebot.length === 1
        && seen.onebot[0].body.message[0].type === 'record'
        && String(seen.onebot[0].body.message[0].data.file).startsWith('base64://'));

      const sendFail = await client.sendRecord('private:1', '');
      ok('语音：空音频不会真的发出去', sendFail.ok === false);
    } finally {
      await new Promise((resolve) => fake.close(resolve));
    }

    /* ---------- G. 节奏状态 ---------- */

    const s0 = V.newState(night);
    const s1 = V.noteText(s0, night + 1000);
    const s2 = V.noteVoice(s1, night + 2000);
    ok('语音：发文字会累计"隔了几条"，发语音会清零',
      s1.textsSince > s0.textsSince && s2.textsSince === 0 && s2.countToday === 1);
    const nextDay = V.rollDay(s2, night + 24 * 3600_000);
    ok('语音：跨天只清"今天几条"（没有每日上限，只是统计）', nextDay.countToday === 0 && nextDay.lastVoiceAt === s2.lastVoiceAt);

    /* ---------- H. 能力提示 ---------- */

    const hintTag = caps.buildCapabilityHints({
      platform: 'QQ',
      voice: { enabled: true, mode: 'none', maxChars: 120 },
    });
    ok('语音：没递话筒时告诉她可以自己写 [语音]', /\[语音\]/.test(hintTag));
    const hintMixed = caps.buildCapabilityHints({
      platform: 'QQ',
      voice: { enabled: true, mode: 'mixed', maxChars: 120 },
    });
    const hintVoice = caps.buildCapabilityHints({
      platform: 'QQ',
      voice: { enabled: true, mode: 'voice', maxChars: 120 },
    });
    ok('语音：递了混合话筒时给死格式（先用语音说一句，再打字）',
      /先用语音说一句/.test(hintMixed) && /\[语音\]/.test(hintMixed));
    /**
     * ★ 2026-11-01：**别让她先给"语音能不能用"打预防针**。
     *
     * 用户实测："她用语音的时候开头都会加一句不确定能不能用。"
     * 真机三条语音（`data\companion\turns.jsonl` 13:16 / 13:29 / 13:31）每条都先交代
     * "语音那是它那头的事""我不太顺手""得你这边先调好了才行"——**语音其实都发成功了**。
     * 所以她缺的不是嗓子，是一句"声音是你的"。
     */
    ok('语音：递话筒时明说"声音是你的、已经通了"',
      /声音是你的，已经通了/.test(hintMixed) && /声音是你的，已经通了/.test(hintVoice));
    ok('语音：点名不要说的那两件事（能不能发出去 / 谁那边调没调好）',
      /能不能发出去/.test(hintVoice) && /谁那边调没调好/.test(hintVoice));
    ok('语音：没递话筒那一轮不提"声音是你的"（她没有话筒，别替她假造条件）',
      !/声音是你的，已经通了/.test(hintTag));
    const hintDesk = caps.buildCapabilityHints({
      platform: '桌宠',
      voice: { enabled: true, mode: 'none', maxChars: 120 },
    });
    ok('语音：桌宠里不出现语音提示（只在 QQ 里发）', !/\[语音\]/.test(hintDesk));
  },
};
