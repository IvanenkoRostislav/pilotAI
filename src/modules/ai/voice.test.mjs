import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVoiceService } from '../../../dist/modules/ai/voice.js';

const signal = new AbortController().signal;
const response = (parts, text) => ({ candidates: [{ finishReason: 'STOP', content: { parts } }], text });
test('transcription sends inline OGG to Gemini without replying or adding chat history', async () => {
  let request;
  const service = createVoiceService({ apiKey: 'fake' }, async (params) => {
    request = params;
    return response([{ text: 'A table is available.' }], ' A table is available. ');
  });
  assert.equal(await service.transcribe(Buffer.from('ogg'), signal), 'A table is available.');
  assert.equal(request.model, 'gemini-3.1-flash-lite');
  assert.equal(request.contents[0].parts[1].inlineData.mimeType, 'audio/ogg');
  assert.equal(request.contents[0].parts[1].inlineData.data, Buffer.from('ogg').toString('base64'));
  assert.equal(request.config.abortSignal, signal);
});

test('TTS requests exact text, British accent and chosen voice; combines PCM parts', async () => {
  let request;
  const pcm = Buffer.alloc(4800);
  const service = createVoiceService({ apiKey: 'fake', voice: 'Puck' }, async (params) => {
    request = params;
    return response([1, 2].map(() => ({ inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: pcm.toString('base64') } })));
  });
  const speech = await service.synthesise('Thank you for confirming.', signal);
  assert.equal(speech.sampleRate, 24000);
  assert.equal(speech.pcm.length, pcm.length * 2);
  assert.match(request.contents[0].parts[0].text, /British English \(en-GB\)/);
  assert.match(request.contents[0].parts[0].text, /Thank you for confirming\./);
  assert.deepEqual(request.config.responseModalities, ['AUDIO']);
  assert.equal(request.config.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Puck');
});

test('empty, blocked, truncated and invalid audio responses fail closed', async () => {
  for (const value of [response([], ''), { candidates: [{ finishReason: 'MAX_TOKENS' }] },
    { promptFeedback: { blockReason: 'SAFETY' } }]) {
    const service = createVoiceService({ apiKey: 'fake' }, async () => value);
    await assert.rejects(service.transcribe(Buffer.from('ogg'), signal), /VOICE_/);
    await assert.rejects(service.synthesise('Hello', signal), /VOICE_/);
  }
  const service = createVoiceService({ apiKey: 'fake' }, async () => response([
    { inlineData: { mimeType: 'audio/mp3', data: 'AAAA' } },
  ]));
  await assert.rejects(service.synthesise('Hello', signal), /VOICE_AUDIO/);
  await assert.rejects(service.transcribe(Buffer.alloc(11 * 1024 * 1024), signal), /VOICE_SIZE/);
});

test('429 cooldown is isolated by model; provider secrets are not leaked', async () => {
  let calls = 0;
  const service = createVoiceService({ apiKey: 'fake' }, async (params) => {
    calls++;
    if (params.model.includes('tts')) throw Object.assign(new Error('SECRET_REQUEST'), { status: 429 });
    return response([{ text: 'Confirmed' }], 'Confirmed');
  });
  await assert.rejects(service.synthesise('Hello', signal), /VOICE_RATE_LIMIT/);
  await assert.rejects(service.synthesise('Hello', signal), /VOICE_COOLDOWN/);
  assert.equal(await service.transcribe(Buffer.from('ogg'), signal), 'Confirmed');
  assert.equal(calls, 2);
});

test('provider failures keep HTTP status and model while excluding raw error details', async () => {
  const expected = { 400: 'VOICE_BAD_REQUEST', 401: 'VOICE_AUTH', 403: 'VOICE_AUTH',
    404: 'VOICE_MODEL', 429: 'VOICE_RATE_LIMIT', 503: 'VOICE_UNAVAILABLE' };
  for (const [statusText, code] of Object.entries(expected)) {
    const status = Number(statusText);
    const service = createVoiceService({ apiKey: 'fake', ttsModel: 'test-tts' }, async () => {
      throw Object.assign(new Error('PRIVATE_REQUEST_AND_KEY'), { status, request: 'PRIVATE_AUDIO' });
    });
    await assert.rejects(service.synthesise('Hello', signal), error => {
      assert.equal(error.message, code);
      assert.equal(error.status, status);
      assert.equal(error.model, 'test-tts');
      assert.ok(!JSON.stringify(error).includes('PRIVATE'));
      assert.equal(error.cause, undefined);
      return true;
    });
  }
});

test('abort prevents audio requests', async () => {
  const aborted = AbortSignal.abort();
  const service = createVoiceService({ apiKey: 'fake' }, async () => assert.fail('must not call API'));
  await assert.rejects(service.synthesise('Hello', aborted));
});
