import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import bigInt from 'big-integer';
import { Api } from 'teleproto';
import { BookingAgent as RealAgent } from '../../../dist/modules/agent/agent.js';
import { Logger } from '../../../dist/modules/logger/logger.js';
import { fixtureMenu } from '../agent/fixtures.mjs';

async function harness(t) {
  const terminal = new EventEmitter();
  terminal.close = () => terminal.emit('close');
  class NewMessage { async resolve() {} }
  class BookingAgent extends RealAgent {
    constructor(...args) { args[4] = () => new Date('2026-11-18T12:00:00Z'); super(...args); }
  }
  const keys = ['BOOKING_RESTAURANT', 'BOOKING_TIME', 'BOOKING_GUESTS', 'BOOKING_NAME', 'BOOKING_PHONE', 'BOOKING_EMAIL'];
  const old = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  Object.assign(process.env, { BOOKING_RESTAURANT: 'Test Bistro', BOOKING_TIME: '17:00', BOOKING_GUESTS: '2' });
  for (const key of keys.slice(3)) delete process.env[key];
  t.after(() => { for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  globalThis.textHarness = { terminal, NewMessage, BookingAgent };
  let source = await readFile(new URL('../../../dist/modules/telegram/messanging.js', import.meta.url), 'utf8');
  source = source.replace("import { createInterface } from 'node:readline';", 'const createInterface=()=>globalThis.textHarness.terminal;');
  source = source.replace(/import \{ NewMessage,? \} from 'teleproto\/events';/, 'const {NewMessage}=globalThis.textHarness;');
  source = source.replace("import { BookingAgent } from '../agent/agent.js';", 'const {BookingAgent}=globalThis.textHarness;');
  source = source.replace("'../logger/logger.js'", JSON.stringify(new URL('../../../dist/modules/logger/logger.js', import.meta.url).href));
  source = source.replace("'teleproto'", JSON.stringify(import.meta.resolve('teleproto')));
  const { runMessaging } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64') + '#' + Math.random());
  const target = new Api.User({ id: bigInt(42) });
  const sent = [], payloads = [], decisions = [], rows = [];
  let handler, messageId = 0;
  const client = {
    getEntity: async () => target,
    addEventHandler: fn => { handler = fn; }, removeEventHandler: () => { handler = undefined; },
    sendMessage: async (_to, params) => { sent.push(params.message); },
    downloadMedia: async () => assert.fail('Text-only runtime must never download media'),
    sendFile: async () => assert.fail('Text-only runtime must never upload audio or files'),
  };
  const gemini = {
    async generateReply(_text, _signal, settings) {
      const payload = JSON.parse(settings.contents[0].parts[0].text);
      if (payload.review) return { text: '{"safe":true}', content: {} };
      assert.match(settings.systemInstruction, /text messages only/);
      assert.equal('voiceRequested' in settings.responseJsonSchema.properties, false);
      payloads.push(payload);
      const menu = fixtureMenu(payload);
      const key = payload.ownerInput ? 'details_' + payload.ownerInput.field : decisions.shift();
      assert.ok(key, 'Missing mocked AI decision');
      const decision = typeof key === 'object' ? key : key === 'confirmed' ?
        { action: 'CONFIRMED', messageKey: 'final', message: menu.final, field: 'none', question: '' } : key === 'name' ?
        { action: 'NEEDS_INPUT', messageKey: 'none', message: 'One moment, please, I am checking the name.', field: 'name', question: 'What name should I use?' } :
        { action: 'SEND', messageKey: key, message: menu[key], field: 'none', question: '' };
      return { text: JSON.stringify(decision), content: {} };
    }, rememberExchange() {}, reset() {},
  };
  const running = runMessaging(client, 'test_user', e => e.message, gemini,
    new Logger({ files: false, color: false, output: line => rows.push(JSON.parse(line)) }));
  const flush = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };
  await flush();
  t.after(async () => { terminal.emit('line', '/quit'); await running; delete globalThis.textHarness; });
  return { sent, payloads, decisions, rows, terminal, flush,
    async message(text, media, id = ++messageId) {
      handler({ isPrivate: true, chatId: bigInt(42), message: {
        out: false, senderId: bigInt(42), message: text, id, ...(media ? { media } : {}),
      } });
      await flush();
    } };
}

test('complete text booking sends the opening, waits for owner data, confirms and then stops', async t => {
  const h = await harness(t);
  h.decisions.push('opening', 'name', 'confirm', 'confirmed');
  h.terminal.emit('line', '/book'); await h.flush();
  assert.match(h.sent[0], /table for 2/);
  await h.message('Available. What name should it be under?');
  h.terminal.emit('line', '/input name Synthetic Guest'); await h.flush();
  assert.match(h.sent.at(-1), /Synthetic Guest/);
  await h.message('Please confirm all details.');
  await h.message('Your reservation is confirmed.');
  assert.match(h.sent.at(-1), /Booking confirmed: Test Bistro, London, 2026-11-18, 17:00.*2 guests/);
  const count = h.sent.length;
  await h.message('Thank you.');
  assert.equal(h.sent.length, count);
  assert.equal(h.rows.findLast(r => r.event === 'booking.finished').data.outcome, 'COMPLETED');
  assert.ok(h.rows.filter(r => r.event === 'conversation.message').every(r => r.messageType === 'TEXT'));
});

test('voice/attachments ask for text without AI or downloads; a later text continues the booking', async t => {
  const h = await harness(t);
  h.decisions.push('opening', 'confirm');
  h.terminal.emit('line', '/book'); await h.flush();
  await h.message('', { className: 'MessageMediaDocument' });
  assert.match(h.sent.at(-1), /Please send your message as text/);
  assert.equal(h.payloads.length, 1);
  await h.message('We have a table available.');
  assert.equal(h.payloads.length, 2);
  assert.match(h.sent.at(-1), /Could you please confirm/);
  assert.ok(h.rows.some(r => r.event === 'conversation.message' && r.messageType === 'MEDIA'));
});

test('a request for audio still receives only a text reply', async t => {
  const h = await harness(t);
  h.decisions.push('opening', { action: 'SEND', messageKey: 'reply', field: 'none', question: '',
    message: 'I can only reply in text. Could you confirm availability, please?' });
  h.terminal.emit('line', '/book'); await h.flush();
  await h.message('Please reply with a voice message.');
  assert.match(h.sent.at(-1), /only reply in text/);
  assert.ok(h.rows.filter(r => r.event === 'conversation.message').every(r => r.messageType === 'TEXT'));
});

test('duplicate text updates produce only one reply', async t => {
  const h = await harness(t);
  h.decisions.push('opening', 'confirm');
  h.terminal.emit('line', '/book'); await h.flush();
  await h.message('Available', undefined, 99);
  await h.message('Available', undefined, 99);
  assert.equal(h.sent.length, 2);
  assert.equal(h.payloads.length, 2);
});

test('text containing a link preview is processed as text', async t => {
  const h = await harness(t);
  h.decisions.push('opening', 'confirm');
  h.terminal.emit('line', '/book'); await h.flush();
  const preview = new Api.MessageMediaWebPage({ webpage: new Api.WebPageEmpty({ id: bigInt(1) }) });
  await h.message('Available; our menu is https://example.com.', preview);
  assert.equal(h.payloads.length, 2);
  assert.match(h.sent.at(-1), /Could you please confirm/);
});
