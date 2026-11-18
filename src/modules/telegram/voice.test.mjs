import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import bigInt from 'big-integer';
import { Api } from 'teleproto';
import { BookingAgent as RealAgent } from '../../../dist/modules/agent/agent.js';
import { Logger } from '../../../dist/modules/logger/logger.js';
import { deliverVoice, voiceDocument } from '../../../dist/modules/telegram/voice.js';
import { VoiceError } from '../../../dist/modules/ai/voice.js';

const signal = new AbortController().signal;
const target = new Api.User({ id: bigInt(42) });
const audio = { data: Buffer.from('OggSOpusHead'), duration: 2 };
const speech = { pcm: Buffer.alloc(480), sampleRate: 24000 };
const quiet = () => new Logger({ files: false, console: false });
function voiceMessage(duration = 2, size = 20) {
  return { media: new Api.MessageMediaDocument({ document: new Api.Document({
    id: bigInt(1), accessHash: bigInt(1), fileReference: Buffer.alloc(0), date: 0,
    mimeType: 'audio/ogg', size: bigInt(size), dcId: 1,
    attributes: [new Api.DocumentAttributeAudio({ voice: true, duration })],
  }) }) };
}

test('detects only Telegram voice notes and rejects oversized or long recordings', () => {
  assert.ok(voiceDocument(voiceMessage()));
  assert.equal(voiceDocument({ media: {} }), undefined);
  const ordinary = voiceMessage();
  ordinary.media.document.attributes[0].voice = false;
  assert.equal(voiceDocument(ordinary), undefined);
  assert.throws(() => voiceDocument(voiceMessage(181)), /VOICE_SIZE/);
  assert.throws(() => voiceDocument(voiceMessage(1, 11 * 1024 * 1024)), /VOICE_SIZE/);
});

test('uploads as OGG Telegram Voice with explicit voice attribute and duration', async () => {
  let upload;
  const client = { sendFile: async (to, params) => { assert.equal(to, target); upload = params; } };
  assert.equal(await deliverVoice(client, target, { synthesise: async () => speech }, async () => audio,
    'Thank you', signal, quiet(), null), 'voice');
  assert.equal(upload.voiceNote, true);
  assert.equal(upload.forceDocument, false);
  assert.equal(upload.file.name, 'reply.ogg');
  assert.equal(upload.attributes[0].voice, true);
  assert.equal(upload.attributes[0].duration, 2);
  assert.equal(upload.caption, '');
});

test('generation/conversion failure falls back; uncertain upload failure does not duplicate delivery', async () => {
  let uploads = 0;
  const client = { sendFile: async () => { uploads++; throw new Error('UNCERTAIN_DELIVERY'); } };
  const bad = async () => { throw new Error('failure'); };
  assert.equal(await deliverVoice(client, target, { synthesise: bad }, async () => audio,
    'Hello', signal, quiet(), null), 'text');
  assert.equal(await deliverVoice(client, target, { synthesise: async () => speech }, bad,
    'Hello', signal, quiet(), null), 'text');
  assert.equal(uploads, 0);
  await assert.rejects(deliverVoice(client, target, { synthesise: async () => speech }, async () => audio,
    'Hello', signal, quiet(), null), /UNCERTAIN_DELIVERY/);
  assert.equal(uploads, 1);
});

test('fallback diagnostics distinguish TTS HTTP error from missing FFmpeg without leaking content', async () => {
  const rows = [];
  const audit = new Logger({ files: false, color: false, output: line => rows.push(JSON.parse(line)) });
  const client = { sendFile: async () => assert.fail('must not upload') };
  await deliverVoice(client, target, { synthesise: async () => { throw new VoiceError('VOICE_BAD_REQUEST', 'test-tts', 400); } },
    async () => assert.fail('must not convert'), 'PRIVATE_SPEECH', signal, audit, null);
  await deliverVoice(client, target, { synthesise: async () => speech },
    async () => { throw new Error('VOICE_FFMPEG_NOT_FOUND'); }, 'PRIVATE_SPEECH', signal, audit, null);
  assert.equal(rows[0].data.stage, 'tts');
  assert.equal(rows[0].data.errorCode, 'VOICE_BAD_REQUEST');
  assert.equal(rows[0].data.status, 400);
  assert.equal(rows[0].data.model, 'test-tts');
  assert.equal(rows[1].data.stage, 'ffmpeg');
  assert.equal(rows[1].data.errorCode, 'VOICE_FFMPEG_NOT_FOUND');
  assert.ok(!JSON.stringify(rows).includes('PRIVATE_SPEECH'));
});

async function harness(t, options = {}) {
  const terminal = new EventEmitter();
  terminal.close = () => terminal.emit('close');
  class NewMessage { async resolve() {} }
  class BookingAgent extends RealAgent {
    constructor(...args) { args[4] = () => new Date('2026-11-18T12:00:00Z'); super(...args); }
  }
  const old = Object.fromEntries(['BOOKING_RESTAURANT', 'BOOKING_TIME', 'BOOKING_GUESTS'].map(k => [k, process.env[k]]));
  Object.assign(process.env, { BOOKING_RESTAURANT: 'Test Bistro', BOOKING_TIME: '17:00', BOOKING_GUESTS: '2' });
  t.after(() => { for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  globalThis.voiceHarness = { terminal, NewMessage, BookingAgent };
  let source = await readFile(new URL('../../../dist/modules/telegram/messanging.js', import.meta.url), 'utf8');
  source = source.replace("import { createInterface } from 'node:readline';", 'const createInterface=()=>globalThis.voiceHarness.terminal;');
  source = source.replace(/import \{ NewMessage,? \} from 'teleproto\/events';/, 'const {NewMessage}=globalThis.voiceHarness;');
  source = source.replace("import { BookingAgent } from '../agent/agent.js';", 'const {BookingAgent}=globalThis.voiceHarness;');
  source = source.replace("'../logger/logger.js'", JSON.stringify(new URL('../../../dist/modules/logger/logger.js', import.meta.url).href));
  source = source.replace("'./voice.js'", JSON.stringify(new URL('../../../dist/modules/telegram/voice.js', import.meta.url).href));
  // data: modules need an absolute URL for third-party dependencies as well.
  source = source.replace("'teleproto'", JSON.stringify(import.meta.resolve('teleproto')));
  const { runMessaging } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64') + '#' + Math.random());
  const sent = [], payloads = [], rows = [], spoken = [], exchanges = [];
  let handler, nextTranscript = 'Available';
  const client = {
    getEntity: async () => target,
    addEventHandler: fn => { handler = fn; }, removeEventHandler: () => { handler = undefined; },
    sendMessage: async (_to, params) => { sent.push({ mode: 'text', text: params.message }); },
    sendFile: async (_to, params) => { sent.push({ mode: 'voice', params }); },
    downloadMedia: async () => Buffer.from('fake ogg'),
  };
  const decisions = [];
  const gemini = {
    async generateReply(_text, _signal, settings) {
      if (!settings) return { text: 'Ordinary chat response', content: { role: 'model', parts: [{ text: 'Ordinary chat response' }] } };
      const payload = JSON.parse(settings.contents[0].parts[0].text);
      payloads.push(payload);
      const key = decisions.shift() ?? 'opening';
      const action = key === 'confirmed' ? 'CONFIRMED' : ['name', 'other', 'missing_field'].includes(key) ? 'NEEDS_INPUT' : 'SEND';
      return { text: JSON.stringify({ action, messageKey: action === 'SEND' ? key : 'none',
        message: action === 'SEND' ? payload.menu[key] : '', field: ['name', 'other'].includes(key) ? key : 'none', question: '' }) };
    }, rememberExchange(text, content) { exchanges.push({ text, content }); }, reset() {},
  };
  const service = {
    transcribe: async () => options.transcribe ? options.transcribe() : nextTranscript,
    synthesise: async (text, abort) => {
      spoken.push(text);
      if (options.synthesise) return options.synthesise(text, abort);
      return speech;
    },
  };
  const running = runMessaging(client, 'test_user', e => e.message, gemini,
    new Logger({ files: false, color: false, output: line => rows.push(JSON.parse(line)) }),
    { service, convert: async () => audio });
  const flush = async () => { for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve)); };
  await flush();
  t.after(async () => { terminal.emit('line', '/quit'); await running; delete globalThis.voiceHarness; });
  return { sent, spoken, rows, payloads, decisions, exchanges, terminal, flush,
    async message(text, mode = 'text') {
      nextTranscript = text;
      handler({ isPrivate: true, chatId: bigInt(42), message: {
        out: false, senderId: bigInt(42), message: mode === 'text' ? text : '',
        ...(mode === 'voice' ? voiceMessage() : {}),
      } });
      await flush();
    } };
}

test('mixed text and voice booking shares context, logs transcripts and completes in matching modality', async t => {
  const h = await harness(t);
  h.decisions.push('opening', 'confirm', 'name', 'confirm', 'confirmed');
  h.terminal.emit('line', '/book'); await h.flush();
  assert.equal(h.sent[0].mode, 'text');
  await h.message('Available', 'voice');
  assert.equal(h.sent.at(-1).mode, 'voice');
  await h.message('What name should it be under?');
  h.terminal.emit('line', '/input name Alex Test'); await h.flush();
  assert.equal(h.sent.at(-1).mode, 'text');
  assert.match(h.sent.at(-1).text, /Alex Test/);
  await h.message('Please confirm the details', 'voice');
  assert.equal(h.sent.at(-1).mode, 'voice');
  await h.message('Confirmed', 'voice');
  assert.equal(h.sent.at(-1).mode, 'voice');
  assert.match(h.spoken.at(-1), /Booking confirmed: Test Bistro, London, 2026-11-18, 17:00.*2 guests/);
  assert.ok(h.payloads.at(-1).transcript.some(e => e.text === 'Available'));
  assert.ok(h.payloads.at(-1).transcript.some(e => e.text === 'What name should it be under?'));
  assert.ok(h.payloads.at(-1).transcript.some(e => e.text.includes('Alex Test')));
  const transcripts = h.rows.filter(row => row.event === 'voice.transcript');
  assert.equal(transcripts.filter(row => row.direction === 'IN').length, 3);
  assert.equal(transcripts.filter(row => row.direction === 'OUT').length, 3);
  assert.equal(h.rows.findLast(row => row.event === 'booking.finished').data.outcome, 'COMPLETED');
});

test('TTS failure sends original agent reply as text without losing context', async t => {
  const h = await harness(t, { synthesise: async () => { throw new Error('VOICE_API'); } });
  h.decisions.push('opening', 'confirm');
  h.terminal.emit('line', '/book'); await h.flush();
  await h.message('Available', 'voice');
  assert.equal(h.sent.length, 2);
  assert.equal(h.sent[1].mode, 'text');
  assert.match(h.sent[1].text, /Could you please confirm/);
  assert.ok(h.rows.some(r => r.event === 'voice.text_fallback'));
});

test('voice asking guest name repairs invalid field and resumes with a voice reply after console input', async t => {
  const h = await harness(t);
  h.decisions.push('opening', 'missing_field', 'name');
  h.terminal.emit('line', '/book'); await h.flush();
  await h.message('Hello, what is your name? I am Alex.', 'voice');
  assert.equal(h.sent.length, 1);
  assert.ok(h.rows.some(row => row.event === 'agent.decision_repair'));
  assert.ok(h.rows.some(row => row.event === 'agent.input_required' && row.data.field === 'name'));
  assert.ok(!h.rows.some(row => row.event === 'booking.finished'));
  h.terminal.emit('line', '/input name Guest Owner'); await h.flush();
  assert.equal(h.sent.at(-1).mode, 'voice');
  assert.equal(h.spoken.at(-1), 'The name for the booking is Guest Owner. Thank you.');
});

test('complete second voice is reanalysed while waiting for general clarification', async t => {
  const h = await harness(t);
  h.decisions.push('opening', 'other', 'name');
  h.terminal.emit('line', '/book'); await h.flush();
  await h.message('Good afternoon. Yes, we have', 'voice');
  assert.ok(h.rows.some(row => row.event === 'agent.input_required' && row.data.field === 'other'));
  await h.message('We have a table. What name should the booking be under?', 'voice');
  assert.ok(h.rows.some(row => row.event === 'agent.input_reassessed'));
  assert.ok(h.rows.some(row => row.event === 'agent.input_required' && row.data.field === 'name'));
  h.terminal.emit('line', '/input name Guest Owner'); await h.flush();
  assert.equal(h.sent.at(-1).mode, 'voice');
  assert.equal(h.spoken.at(-1), 'The name for the booking is Guest Owner. Thank you.');
});

test('stop during TTS prevents both late voice upload and text fallback', async t => {
  let resolveSpeech;
  const h = await harness(t, { synthesise: () => new Promise(resolve => { resolveSpeech = resolve; }) });
  h.decisions.push('opening', 'confirm');
  h.terminal.emit('line', '/book'); await h.flush();
  await h.message('Available', 'voice');
  assert.ok(resolveSpeech);
  h.terminal.emit('line', '/stop');
  resolveSpeech(speech); await h.flush();
  assert.equal(h.sent.length, 1);
});

test('transcription failure does not invent text or call the booking planner', async t => {
  const h = await harness(t, { transcribe: async () => { throw new Error('VOICE_API'); } });
  h.decisions.push('opening');
  h.terminal.emit('line', '/book'); await h.flush();
  await h.message('unintelligible', 'voice');
  assert.equal(h.sent.length, 1);
  assert.equal(h.payloads.length, 1);
  assert.ok(h.rows.some(r => r.event === 'voice.input_failed'));
});

test('ordinary chat starts in text and then mirrors text/voice in one shared history', async t => {
  const h = await harness(t);
  h.terminal.emit('line', '/chat on');
  await h.message('First voice', 'voice');
  assert.equal(h.sent[0].mode, 'text');
  await h.message('Second voice', 'voice');
  assert.equal(h.sent[1].mode, 'voice');
  await h.message('Then text');
  assert.equal(h.sent[2].mode, 'text');
  assert.deepEqual(h.exchanges.map(e => e.text), ['First voice', 'Second voice', 'Then text']);
});

test('new manager input during TTS suppresses stale voice and continues the booking', async t => {
  let resolveSpeech;
  const h = await harness(t, { synthesise: () => new Promise(resolve => { resolveSpeech = resolve; }) });
  h.decisions.push('opening', 'confirm', 'name');
  h.terminal.emit('line', '/book'); await h.flush();
  await h.message('Available', 'voice');
  assert.ok(resolveSpeech);
  await h.message('Actually, we need your name first');
  resolveSpeech(speech); await h.flush();
  assert.equal(h.sent.length, 1, 'outdated spoken confirmation must not be uploaded');
  assert.ok(h.rows.some(r => r.event === 'agent.state_changed' && r.data.to === 'NEEDS_INPUT'));
  assert.ok(!h.rows.some(r => r.event === 'booking.finished'));
});
