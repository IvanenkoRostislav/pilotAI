import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Logger, errorInfo } from '../../../dist/modules/logger/logger.js';

function fixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'pilotai-logger-'));
  t.after(() => {
    const target = resolve(root);
    assert.equal(target.startsWith(resolve(tmpdir()) + '\\') || target.startsWith(resolve(tmpdir()) + '/'), true);
    assert.match(target.split(/[\\/]/).at(-1), /^pilotai-logger-/);
    rmSync(target, { recursive: true, force: true });
  });
  const lines = [];
  const directory = join(root, 'logs');
  const logger = new Logger({ directory, color: false, output: (line) => lines.push(line),
    now: () => new Date('2026-11-17T12:34:56.000Z'), ...options });
  return { root, directory, logger, lines,
    rows: (channel) => readFileSync(join(directory, channel + '-2026-11-17.jsonl'), 'utf8')
      .trim().split('\n').map((line) => JSON.parse(line)) };
}

const summary = { understood: 'Manager requested confirmation', decision: 'confirm', state: 'CONFIRMING' };

test('creates logs directory and separates technical events from message decisions', (t) => {
  const f = fixture(t);
  const id = f.logger.newBookingId();
  f.logger.technical('info', 'booking.started', {}, id);
  f.logger.message({ bookingSessionId: id, direction: 'IN', text: 'Hello' }).finish(summary);
  assert.deepEqual(readdirSync(f.directory).sort(), ['agent-2026-11-17.jsonl', 'technical-2026-11-17.jsonl']);
  const row = f.rows('agent')[0];
  assert.deepEqual(Object.keys(row).sort(), ['bookingSessionId', 'decision', 'direction', 'event', 'sender', 'messageType', 'state', 'text', 'timestamp', 'understood'].sort());
  assert.equal(row.timestamp, '2026-11-17T12:34:56.000Z');
  assert.equal(row.bookingSessionId, id);
  assert.equal(row.decision, 'confirm');
  assert.equal(f.rows('technical')[0].event, 'booking.started');
});

test('one physical JSON line per message; completion and flushing are idempotent', (t) => {
  const f = fixture(t);
  const ticket = f.logger.message({ bookingSessionId: f.logger.newBookingId(), direction: 'OUT',
    text: 'Hello\nWorld\u001b[31m', trustedText: true });
  ticket.finish(summary);
  ticket.finish({ ...summary, decision: 'duplicate' });
  f.logger.flush({ ...summary, decision: 'duplicate_flush' });
  assert.equal(f.rows('agent').length, 1);
  assert.equal(f.rows('agent')[0].text, 'Hello\nWorld');
  assert.equal(readFileSync(join(f.directory, 'agent-2026-11-17.jsonl'), 'utf8').includes('\u001b'), false);
});

test('masks known names, env secrets, nested credentials, email, phone and auth sessions', (t) => {
  const f = fixture(t);
  const oldKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'AIzaFakeSecretKeyForLoggingTests123456';
  t.after(() => { if (oldKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = oldKey; });
  f.logger.rememberPrivate('Alex Private');
  f.logger.technical('error', 'test.failure', {
    nested: { apiKey: 'not-to-be-logged', sessionId: 'short-auth-session', name: 'Unknown Private' },
    error: new Error('key=' + process.env.GEMINI_API_KEY),
  });
  f.logger.message({ bookingSessionId: 'short-auth-session', direction: 'OUT', trustedText: true,
    text: 'Alex Private alex@example.com +447700900000 ' + process.env.GEMINI_API_KEY + ' ' + 'a'.repeat(100),
  }).finish(summary);
  const all = readdirSync(f.directory).map((name) => readFileSync(join(f.directory, name), 'utf8')).join('') + f.lines.join('');
  for (const secret of ['Alex Private', 'alex@example.com', '+447700900000', process.env.GEMINI_API_KEY,
    'not-to-be-logged', 'short-auth-session', 'Unknown Private', 'a'.repeat(100)]) {
    assert.equal(all.includes(secret), false, 'Secret leaked: ' + secret.slice(0, 8));
  }
  assert.equal(f.rows('agent')[0].bookingSessionId, null);
  assert.match(all, /REDACTED/);
});

test('arbitrary message content is omitted, including otherwise undetectable personal data', (t) => {
  const f = fixture(t);
  f.logger.message({ bookingSessionId: null, direction: 'IN', text: 'John Smith at 10 Private Lane' }).finish(summary);
  assert.equal(f.rows('agent')[0].text, '[REDACTED: free-form message]');
  assert.equal(f.lines.join('').includes('Private Lane'), false);
});

test('only explicitly safe short phrases can retain untrusted plaintext', (t) => {
  const f = fixture(t);
  f.logger.message({ bookingSessionId: null, direction: 'IN', text: 'Confirmed.' }).finish(summary);
  f.logger.message({ bookingSessionId: null, direction: 'IN', text: 'Confirmed. John Smith' }).finish(summary);
  assert.equal(f.rows('agent')[0].text, 'Confirmed.');
  assert.equal(f.rows('agent')[1].text, '[REDACTED: free-form message]');
});

test('ANSI colours are console-only and can be disabled', (t) => {
  const f = fixture(t, { color: true });
  f.logger.technical('warn', 'test.warning');
  assert.match(f.lines[0], /^\u001b\[33m/);
  assert.equal(readFileSync(join(f.directory, 'technical-2026-11-17.jsonl'), 'utf8').includes('\u001b'), false);
  const plain = fixture(t, { color: false });
  plain.logger.technical('info', 'test.plain');
  assert.doesNotThrow(() => JSON.parse(plain.lines[0]));
});

test('pending messages flush exactly once on shutdown and retain receipt timestamp', (t) => {
  let now = new Date('2026-11-17T12:34:56.000Z');
  const f = fixture(t, { now: () => now });
  const ticket = f.logger.message({ bookingSessionId: null, direction: 'IN', text: 'secret input' });
  now = new Date('2026-11-18T00:00:01.000Z');
  f.logger.flush({ ...summary, decision: 'shutdown', state: 'CANCELLED' });
  ticket.finish(summary);
  assert.equal(f.rows('agent').length, 1);
  assert.equal(f.rows('agent')[0].timestamp, '2026-11-17T12:34:56.000Z');
  assert.equal(f.rows('agent')[0].decision, 'shutdown');
});

test('technical files rotate by UTC date and circular objects are handled', (t) => {
  let now = new Date('2026-11-17T23:59:59.000Z');
  const f = fixture(t, { now: () => now });
  const circular = {}; circular.self = circular;
  f.logger.technical('info', 'test.before', { circular });
  now = new Date('2026-11-18T00:00:00.000Z');
  f.logger.technical('info', 'test.after');
  assert.deepEqual(readdirSync(f.directory).sort(), ['technical-2026-11-17.jsonl', 'technical-2026-11-18.jsonl']);
  assert.equal(f.rows('technical')[0].data.circular.self, '[CIRCULAR]');
});

test('file sink failure warns once, exposes no filesystem error and never interrupts work', (t) => {
  const f = fixture(t);
  const invalidDirectory = join(f.root, 'file-instead-of-directory');
  writeFileSync(invalidDirectory, 'test');
  const lines = [];
  const logger = new Logger({ directory: invalidDirectory, color: false, output: (line) => lines.push(line) });
  assert.doesNotThrow(() => {
    logger.technical('info', 'booking.started');
    logger.technical('info', 'booking.finished');
  });
  const rows = lines.map((line) => JSON.parse(line));
  assert.equal(rows.filter((row) => row.event === 'logger.write_failed').length, 1);
  assert.equal(rows.filter((row) => row.event.startsWith('booking.')).length, 2);
  assert.equal(lines.join('').includes(invalidDirectory), false);
});

test('API error metadata does not include error message, request, stack or credentials', () => {
  const error = Object.assign(new Error('secret request body'), { status: 503, request: { apiKey: 'secret' } });
  assert.deepEqual(errorInfo(error), { errorCode: 'UNEXPECTED_ERROR', status: 503 });
  assert.deepEqual(errorInfo(new Error('GEMINI_RATE_LIMIT')), { errorCode: 'GEMINI_RATE_LIMIT' });
});

test('text messages retain conversation content while masking known private values and contact details', (t) => {
  const f = fixture(t);
  f.logger.rememberPrivate('Alex Private');
  const id = f.logger.newBookingId();
  f.logger.message({ bookingSessionId: id, direction: 'IN', retainText: true,
    text: 'Please book for Alex Private, alex@example.com, +447700900000' }).finish(summary);
  f.logger.message({ bookingSessionId: id, direction: 'OUT', retainText: true,
    text: 'Thank you for confirming.' }).finish(summary);
  const rows = f.rows('agent');
  assert.equal(rows[0].event, 'conversation.message');
  assert.equal(rows[0].bookingSessionId, id);
  assert.match(rows[0].text, /Please book for/);
  assert.ok(!JSON.stringify(rows).includes('Alex Private'));
  assert.ok(!JSON.stringify(rows).includes('alex@example.com'));
  assert.ok(!JSON.stringify(rows).includes('+447700900000'));
  assert.equal(rows[1].text, 'Thank you for confirming.');
});
