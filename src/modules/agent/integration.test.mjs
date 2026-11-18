import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import * as sdk from '@google/genai';
import { Logger } from '../../../dist/modules/logger/logger.js';

const loggerModule = new URL('../../../dist/modules/logger/logger.js', import.meta.url).href;

test('Gemini agent options isolate booking context and preserve ordinary chat', async () => {
  const requests = [];
  let failureStatus = 0;
  const nextStatuses = [];
  class FakeGoogleGenAI {
    constructor() {
      this.models = { generateContent: async (request) => {
        requests.push(request);
        const status = nextStatuses.length ? nextStatuses.shift() : failureStatus;
        if (status) throw new sdk.ApiError({ status, message: 'PRIVATE_API_REQUEST_BODY' });
        return { candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ text: 'Reply' }] } }], text: 'Reply' };
      } };
    }
  }
  globalThis.pilotGeminiTest = { ...sdk, GoogleGenAI: FakeGoogleGenAI };
  let source = await readFile(new URL('../../../dist/modules/ai/gemini.js', import.meta.url), 'utf8');
  source = source.replace(/import .* from '@google\/genai';/,
    'const {ApiError,FinishReason,GoogleGenAI}=globalThis.pilotGeminiTest;');
  source = source.replace(/import .* from '.\/system-prompt.js';/, 'const SYSTEM_PROMPT="Ordinary chat";');
  source = source.replace("'../logger/logger.js'", JSON.stringify(loggerModule));
  const { createGeminiService } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  const events = [];
  const audit = new Logger({ files: false, color: false, output: (line) => events.push(JSON.parse(line)) });
  const service = createGeminiService({ apiKey: 'fake', model: 'gemini-3.1-flash-lite', audit, retryDelayMs: 0 });
  const signal = new AbortController().signal;
  const reply = await service.generateReply('My name is Alex', signal);
  service.rememberExchange('My name is Alex', reply.content);
  const contents = [{ role: 'user', parts: [{ text: 'Full booking context' }] }];
  await service.generateReply('Choose action', signal, {
    systemInstruction: 'Agent prompt', contents, responseJsonSchema: { type: 'object' },
  });
  assert.deepEqual(requests.at(-1).contents, contents);
  assert.equal(requests.at(-1).config.systemInstruction, 'Agent prompt');
  assert.equal(requests.at(-1).config.responseMimeType, 'application/json');
  await service.generateReply('My name?', signal);
  assert.equal(requests.at(-1).contents.length, 3);
  assert.equal(requests.at(-1).config.systemInstruction, 'Ordinary chat');
  assert.equal(requests.at(-1).config.responseMimeType, undefined);
  const bookingSessionId = audit.newBookingId();
  nextStatuses.push(503, 0);
  const beforeRetry = requests.length;
  await service.generateReply('recover from temporary 503', signal, { bookingSessionId });
  assert.equal(requests.length - beforeRetry, 2);
  assert.equal(requests[beforeRetry].model, 'gemini-3.1-flash-lite');
  assert.equal(requests[beforeRetry + 1].model, 'gemini-3.5-flash-lite');
  failureStatus = 503;
  await assert.rejects(service.generateReply('test', signal, { bookingSessionId }), { message: 'GEMINI_UNAVAILABLE' });
  failureStatus = 429;
  await assert.rejects(service.generateReply('test', signal, { bookingSessionId }), { message: 'GEMINI_RATE_LIMIT' });
  assert.deepEqual(events.filter((row) => row.event === 'gemini.api_error').map((row) => row.data.status), [503, 503, 503, 503, 429]);
  assert.equal(events.filter(row => row.event === 'gemini.retry').length, 3);
  assert.equal(events.every((row) => row.bookingSessionId === bookingSessionId), true);
  assert.equal(JSON.stringify(events).includes('PRIVATE_API_REQUEST_BODY'), false);
  delete globalThis.pilotGeminiTest;
});

test('Telegram command wiring: startup silence, filters, chat, book and immediate stop', async () => {
  const terminal = new EventEmitter();
  terminal.close = () => terminal.emit('close');
  let starts = 0, received = 0, calls = 0;
  const sent = [];
  class User { constructor() { this.id = 42; this.self = false; } }
  class NewMessage { async resolve() {} }
  class FakeAgent {
    running = false;
    async start() { starts++; this.running = true; }
    cancel() { this.running = false; }
    status() {}
    observe(text) { return this.running ? { text } : undefined; }
    reserveIncoming() { return undefined; }
    async receive() { received++; }
    async input() {}
  }
  globalThis.pilotMessagingTest = { terminal, Api: { User }, NewMessage, BookingAgent: FakeAgent };
  let source = await readFile(new URL('../../../dist/modules/telegram/messanging.js', import.meta.url), 'utf8');
  source = source.replace("import { createInterface } from 'node:readline';", 'const createInterface=()=>globalThis.pilotMessagingTest.terminal;');
  source = source.replace("import { Api } from 'teleproto';", 'const {Api}=globalThis.pilotMessagingTest;');
  source = source.replace(/import \{ NewMessage,? \} from 'teleproto\/events';/, 'const {NewMessage}=globalThis.pilotMessagingTest;');
  source = source.replace("import { BookingAgent } from '../agent/agent.js';", 'const {BookingAgent}=globalThis.pilotMessagingTest;');
  source = source.replace("'../logger/logger.js'", JSON.stringify(loggerModule));
  const { runMessaging } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  let handler;
  const client = {
    getEntity: async () => new User(), addEventHandler: (fn) => { handler = fn; },
    removeEventHandler: () => { handler = undefined; },
    sendMessage: async (_target, params) => { sent.push(params.message); return { id: sent.length }; },
  };
  const gemini = {
    generateReply: async () => { calls++; return { text: 'Model reply', content: {} }; },
    rememberExchange() {}, reset() {},
  };
  const running = runMessaging(client, 'test_user', (error) => error.message, gemini,
    new Logger({ files: false, console: false }));
  const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve)); };
  let messageId = 0;
  const event = (message = {}) => ({ isPrivate: true, chatId: 42,
    message: { out: false, senderId: 42, message: 'Hello', id: ++messageId, ...message } });
  await flush();
  handler(event());
  await flush();
  assert.equal(calls + sent.length, 0);
  terminal.emit('line', '/chat on');
  handler(event());
  handler(event({ out: true }));
  handler(event({ senderId: 99 }));
  handler({ ...event(), isPrivate: false });
  await flush();
  assert.equal(calls, 1);
  assert.deepEqual(sent, ['Model reply']);
  terminal.emit('line', '/book');
  terminal.emit('line', '/stop');
  await flush();
  assert.equal(starts, 0);
  terminal.emit('line', '/book');
  await flush();
  assert.equal(starts, 1);
  handler(event());
  await flush();
  assert.equal(received, 1);
  terminal.emit('line', '/send forbidden while booking');
  await flush();
  assert.equal(sent.length, 1);
  terminal.emit('line', '/stop');
  handler(event());
  await flush();
  assert.equal(calls, 1);
  terminal.emit('line', '/quit');
  await running;
  assert.equal(handler, undefined);
  delete globalThis.pilotMessagingTest;
});
