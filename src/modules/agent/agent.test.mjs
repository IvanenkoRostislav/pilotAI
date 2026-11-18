import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { BookingAgent } from '../../../dist/modules/agent/agent.js';
import { londonClock, loadBooking } from '../../../dist/modules/agent/config.js';
import { Logger } from '../../../dist/modules/logger/logger.js';

let saved;
beforeEach(() => {
  saved = Object.fromEntries(['BOOKING_RESTAURANT', 'BOOKING_TIME', 'BOOKING_GUESTS']
    .map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    BOOKING_RESTAURANT: 'Test Bistro', BOOKING_TIME: '17:00', BOOKING_GUESTS: '2',
  });
});
afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

const send = (key) => ({ action: 'SEND', messageKey: key, field: 'none', question: '' });
const need = (field) => ({ action: 'NEEDS_INPUT', messageKey: 'none', field, question: 'Owner input needed' });
const confirmed = { action: 'CONFIRMED', messageKey: 'none', field: 'none', question: '' };

function setup(decisions, options = {}) {
  const outgoing = [], calls = [], logs = [];
  const gemini = {
    async generateReply(_text, signal, settings) {
      const payload = JSON.parse(settings.contents[0].parts[0].text);
      calls.push(payload);
      assert.equal(settings.responseJsonSchema.type, 'object');
      const next = decisions.shift();
      if (next instanceof Error) throw next;
      let decision = typeof next === 'function' ? await next(payload, signal) : next;
      assert.ok(decision, 'Missing fake decision');
      if (typeof decision === 'string') return { text: decision, content: {} };
      decision = { ...decision, message: decision.message ??
        (decision.action === 'SEND' ? payload.menu[decision.messageKey] ?? '' : '') };
      return { text: JSON.stringify(decision), content: { role: 'model', parts: [] } };
    },
  };
  const now = options.now ?? (() => new Date('2026-11-17T12:00:00Z'));
  const agent = new BookingAgent(gemini, async (text) => {
    if (options.failSend?.(text)) throw new Error('DELIVERY_UNCERTAIN');
    outgoing.push(text);
  }, (error) => error.message, (text) => logs.push(text), now,
    options.audit ?? new Logger({ files: false, console: false }));
  const status = () => { agent.status(); return JSON.parse(logs.at(-1)); };
  const receive = async (text) => {
    const receipt = agent.observe(text);
    if (receipt) await agent.receive(receipt);
  };
  return { agent, outgoing, calls, status, receive };
}

test('complete follow-up replaces general clarification with a specific owner name request', async () => {
  const s = setup([send('opening'), need('other'), need('name')]);
  await s.agent.start();
  await s.receive('Good afternoon. Yes, we have');
  assert.equal(s.status().needsInput, 'other');
  await s.receive('We have a table for two at 17:00. What name should it be under?');
  assert.equal(s.status().state, 'NEEDS_INPUT');
  assert.equal(s.status().needsInput, 'name');
  assert.equal(s.calls.length, 3);
  assert.ok(s.calls.at(-1).transcript.some(e => e.text === 'Good afternoon. Yes, we have'));
  await s.agent.input('name', 'Guest Owner');
  assert.equal(s.outgoing.at(-1), 'The name for the booking is Guest Owner. Thank you.');
});

test('manager follow-up can resolve ambiguity without owner input or changing booking parameters', async () => {
  const s = setup([send('opening'), need('other'), send('confirm'), confirmed]);
  await s.agent.start();
  await s.receive('We might have a table.');
  await s.receive('We have checked: two guests at 17:00 today at Test Bistro is available.');
  assert.equal(s.status().state, 'CONFIRMING');
  assert.equal(s.status().needsInput, undefined);
  assert.equal(s.status().booking.time, '17:00');
  await s.receive('Confirmed');
  assert.equal(s.status().state, 'COMPLETED');
});

test('manager cannot supply missing restaurant or bypass owner consent while paused', async () => {
  process.env.BOOKING_RESTAURANT = '';
  const missing = setup([]);
  await missing.agent.start();
  await missing.receive('Use My Bistro');
  assert.equal(missing.status().needsInput, 'restaurant');
  assert.equal(missing.calls.length, 0);
  process.env.BOOKING_RESTAURANT = 'Test Bistro';
  const s = setup([send('opening'), send('confirm'), need('other'), confirmed]);
  await s.agent.start();
  await s.receive('Available');
  await s.receive('A deposit is required.');
  await s.receive('Confirmed');
  assert.equal(s.status().state, 'NEEDS_INPUT');
  assert.equal(s.status().needsInput, 'other');
  assert.equal(s.status().managerConfirmed, false);
  assert.equal(s.outgoing.length, 2);
});

test('IDLE does not invoke Gemini or send', () => {
  const s = setup([]);
  assert.equal(s.agent.observe('Hello'), undefined);
  assert.equal(s.status().state, 'IDLE');
  assert.equal(s.calls.length + s.outgoing.length, 0);
});

test('London date, winter offset and summer midnight rollover', () => {
  assert.deepEqual(londonClock(new Date('2026-07-01T23:30:00Z')),
    { date: '2026-07-02', time: '00:30' });
  assert.deepEqual(londonClock(new Date('2026-11-17T12:00:00Z')),
    { date: '2026-11-17', time: '12:00' });
  assert.equal(loadBooking(new Date('2026-07-01T23:30:00Z')).date, '2026-07-02');
});

test('past slot fails without sending or silently moving to tomorrow', async () => {
  const s = setup([], { now: () => new Date('2026-11-17T17:00:00Z') });
  await s.agent.start();
  assert.equal(s.status().state, 'FAILED');
  assert.equal(s.status().lastError, 'BOOKING_PAST');
  assert.equal(s.calls.length + s.outgoing.length, 0);
});

test('missing restaurant requires owner input before first Gemini message', async () => {
  process.env.BOOKING_RESTAURANT = '';
  const s = setup([send('opening')]);
  await s.agent.start();
  assert.equal(s.status().state, 'NEEDS_INPUT');
  assert.equal(s.calls.length, 0);
  await s.agent.input('restaurant', 'Owner Supplied Restaurant');
  assert.equal(s.status().state, 'NEGOTIATING');
  assert.match(s.outgoing[0], /Owner Supplied Restaurant/);
});

test('personal details come from console; messages while paused remain in context', async () => {
  const s = setup([send('opening'), need('name'), send('confirm')]);
  await s.agent.start();
  await s.receive('What name should it be under?');
  assert.equal(s.status().state, 'NEEDS_INPUT');
  await s.receive('We also need email.');
  assert.ok(s.agent.context().some((entry) => entry.text.includes('also need')));
  await s.agent.input('phone', '+440000000000');
  assert.equal(s.status().state, 'NEEDS_INPUT');
  await s.agent.input('name', 'Alex Test');
  assert.equal(s.outgoing.at(-1), 'The name for the booking is Alex Test. Thank you.');
  assert.equal(s.calls.length, 2, 'The model cannot skip delivery and jump to confirmation');
  assert.equal(s.status().state, 'NEGOTIATING');
  assert.deepEqual(s.status().knownPersonalFields, ['name']);
});

test('requested phone and email are delivered before any further model decision', async () => {
  for (const [field, value] of [['phone', '+447700900000'], ['email', 'alex@example.com']]) {
    const s = setup([send('opening'), need(field), send('confirm')]);
    await s.agent.start();
    await s.receive('Please provide your ' + field);
    await s.agent.input(field, value);
    assert.equal(s.outgoing.at(-1), 'The ' + field + ' for the booking is ' + value + '. Thank you.');
    assert.equal(s.calls.length, 2);
    assert.equal(s.agent.canConfirm, false);
  }
});

test('missing NEEDS_INPUT field is repaired once and owner supplies guest name, not manager name', async () => {
  const s = setup([send('opening'), need('none'), need('name')]);
  await s.agent.start();
  await s.receive('Hello, what is your name? I am Alex.');
  assert.equal(s.status().state, 'NEEDS_INPUT');
  assert.equal(s.status().needsInput, 'name');
  assert.equal(s.calls.length, 3);
  assert.match(s.calls.at(-1).decisionFeedback, /field none/);
  assert.deepEqual(s.status().knownPersonalFields, []);
  assert.equal(s.outgoing.length, 1);
  await s.agent.input('name', 'Guest Owner');
  assert.equal(s.outgoing.at(-1), 'The name for the booking is Guest Owner. Thank you.');
  assert.equal(s.status().state, 'NEGOTIATING');
});

test('repeated missing input field pauses for owner review without looping or failing', async () => {
  const s = setup([send('opening'), need('none'), need('none')]);
  await s.agent.start();
  await s.receive('We need some details.');
  assert.equal(s.status().state, 'NEEDS_INPUT');
  assert.equal(s.status().needsInput, 'other');
  assert.equal(s.calls.length, 3);
  assert.equal(s.outgoing.length, 1);
  assert.equal(s.status().managerConfirmed, false);
});

test('stop during missing-field repair prevents late replies and preserves cancellation', async () => {
  let finish;
  const s = setup([send('opening'), need('none'), () => new Promise(resolve => { finish = resolve; })]);
  await s.agent.start();
  const working = s.receive('Your name?');
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  s.agent.cancel();
  finish(need('name'));
  await working;
  assert.equal(s.status().state, 'CANCELLED');
  assert.equal(s.outgoing.length, 1);
});

test('personal detail delivery failure stops the booking', async () => {
  const s = setup([send('opening'), need('name')], {
    failSend: (text) => text.startsWith('The name'),
  });
  await s.agent.start();
  await s.receive('Your name?');
  await s.agent.input('name', 'Alex Test');
  assert.equal(s.status().state, 'FAILED');
  assert.equal(s.status().lastError, 'DELIVERY_UNCERTAIN');
  assert.equal(s.calls.length, 2);
});

test('alternative time pauses without changing booking parameters', async () => {
  const s = setup([send('opening'), need('other')]);
  await s.agent.start();
  await s.receive('Only 17:30 is available.');
  assert.equal(s.status().state, 'NEEDS_INPUT');
  assert.equal(s.status().booking.time, '17:00');
  assert.equal(s.outgoing.length, 1);
});

test('full summary and explicit acknowledgement complete; then automatic silence', async () => {
  const s = setup([send('opening'), send('confirm'), confirmed]);
  await s.agent.start();
  await s.receive('Available');
  assert.equal(s.status().state, 'CONFIRMING');
  assert.match(s.outgoing.at(-1), /Test Bistro, London, 2026-11-17 at 17:00.*2 guests/);
  await s.receive('Yes, confirmed.');
  assert.equal(s.status().state, 'COMPLETED');
  assert.match(s.outgoing.at(-1), /Booking confirmed: Test Bistro, London, 2026-11-17, 17:00.*2 guests/);
  const count = s.outgoing.length;
  await s.receive('Anything else?');
  await s.agent.start();
  assert.equal(s.outgoing.length, count);
});

test('premature confirmation cannot complete before full parameter summary', async () => {
  const s = setup([send('opening'), confirmed]);
  await s.agent.start();
  await s.receive('Confirmed');
  assert.equal(s.status().state, 'NEEDS_INPUT');
  assert.equal(s.status().managerConfirmed, false);
});

test('qualified yes cannot complete even if model misclassifies it', async () => {
  const s = setup([send('opening'), send('confirm'), confirmed]);
  await s.agent.start();
  await s.receive('Available');
  await s.receive('Yes, but at 17:30');
  assert.equal(s.status().state, 'NEEDS_INPUT');
  assert.equal(s.status().managerConfirmed, false);
});

test('unknown personal data and unapproved generated text cannot be sent', async () => {
  const s = setup([send('opening'), send('details_name')]);
  await s.agent.start();
  await s.receive('Name?');
  assert.equal(s.status().state, 'FAILED');
  assert.equal(s.outgoing.length, 1);
  const malicious = setup([{ ...send('opening'), message: 'Booked tomorrow for five.' }]);
  await malicious.agent.start();
  assert.equal(malicious.status().state, 'FAILED');
  assert.equal(malicious.outgoing.length, 0);
});

test('malformed JSON fails closed with a diagnostic code', async () => {
  const s = setup(['not JSON']);
  await s.agent.start();
  assert.equal(s.status().lastError, 'AGENT_DECISION');
  assert.equal(s.outgoing.length, 0);
});

test('stop during generation aborts and prevents late outbound messages', async () => {
  let finish, signal;
  const s = setup([(_payload, inputSignal) => {
    signal = inputSignal;
    return new Promise((resolve) => { finish = resolve; });
  }]);
  const working = s.agent.start();
  s.agent.cancel();
  assert.equal(signal.aborted, true);
  finish(send('opening'));
  await working;
  assert.equal(s.status().state, 'CANCELLED');
  assert.equal(s.outgoing.length, 0);
});

test('new manager information invalidates an outdated pending reply', async () => {
  let finish;
  const s = setup([send('opening'), () => new Promise((resolve) => { finish = resolve; }), send('confirm')]);
  await s.agent.start();
  const working = s.agent.receive(s.agent.observe('Available'));
  const latest = s.agent.observe('Please confirm details');
  finish(send('repeat'));
  await working;
  assert.equal(s.outgoing.length, 1);
  await s.agent.receive(latest);
  assert.equal(s.status().state, 'CONFIRMING');
  assert.equal(s.outgoing.length, 2);
});

test('API failure enters FAILED without further automatic calls', async () => {
  const s = setup([new Error('GEMINI_RATE_LIMIT')]);
  await s.agent.start();
  assert.equal(s.status().state, 'FAILED');
  assert.equal(s.status().lastError, 'GEMINI_RATE_LIMIT');
  await s.receive('Hello');
  assert.equal(s.calls.length, 1);
});

test('definitive manager refusal enters FAILED', async () => {
  const s = setup([send('opening'), { action: 'UNAVAILABLE', messageKey: 'none', field: 'none', question: '' }]);
  await s.agent.start();
  await s.receive('We have no tables at 17:00 today.');
  assert.equal(s.status().state, 'FAILED');
  assert.equal(s.outgoing.length, 1);
});

test('failed final recap preserves manager confirmation without claiming delivery success', async () => {
  const s = setup([send('opening'), send('confirm'), confirmed], {
    failSend: (text) => text.startsWith('Thank you for confirming.'),
  });
  await s.agent.start();
  await s.receive('Available');
  await s.receive('Confirmed');
  assert.equal(s.status().state, 'FAILED');
  assert.equal(s.status().managerConfirmed, true);
  await s.agent.start();
  assert.equal(s.calls.length, 3);
});

test('booking audit records one row per message with a single UUID and redacted personal data', async () => {
  const rows = [];
  const audit = new Logger({ files: false, color: false, output: (line) => rows.push(JSON.parse(line)) });
  const s = setup([send('opening'), need('name'), send('confirm'), confirmed], { audit });
  await s.agent.start();
  await s.receive('What name should it be under?');
  await s.agent.input('name', 'Alex Private');
  await s.receive('Please confirm all details');
  await s.receive('Confirmed');
  const messages = rows.filter((row) => row.event === 'conversation.message');
  assert.equal(messages.length, 7);
  assert.equal(messages.filter((row) => row.direction === 'IN').length, 3);
  assert.equal(messages.filter((row) => row.direction === 'OUT').length, 4);
  assert.equal(new Set(messages.map((row) => row.bookingSessionId)).size, 1);
  assert.match(messages[0].bookingSessionId, /^[0-9a-f-]{36}$/);
  assert.equal(messages.find((row) => row.decision === 'request_owner_input').state, 'NEEDS_INPUT');
  assert.equal(messages.filter((row) => row.direction === 'IN').at(-1).state, 'COMPLETED');
  assert.equal(rows.filter((row) => row.event === 'booking.started').length, 1);
  assert.equal(rows.filter((row) => row.event === 'booking.finished').length, 1);
  assert.equal(rows.find((row) => row.event === 'booking.finished').data.outcome, 'COMPLETED');
  assert.equal(JSON.stringify(rows).includes('Alex Private'), false);
  assert.equal(JSON.stringify(rows).includes('Test Bistro'), false);
});

test('pending inbound audit is finalized once when /stop interrupts a model request', async () => {
  const rows = [];
  let finish;
  const audit = new Logger({ files: false, color: false, output: (line) => rows.push(JSON.parse(line)) });
  const s = setup([send('opening'), () => new Promise((resolve) => { finish = resolve; })], { audit });
  await s.agent.start();
  const processing = s.agent.receive(s.agent.observe('Private manager text'));
  s.agent.cancel();
  finish(send('confirm'));
  await processing;
  audit.flush({ understood: 'Shutdown', decision: 'shutdown', state: 'CANCELLED' });
  const inbound = rows.filter((row) => row.event === 'conversation.message' && row.direction === 'IN');
  assert.equal(inbound.length, 1);
  assert.equal(inbound[0].decision, 'cancelled');
  assert.equal(inbound[0].state, 'CANCELLED');
  assert.equal(JSON.stringify(rows).includes('Private manager text'), false);
  assert.equal(rows.filter((row) => row.event === 'conversation.message' && row.direction === 'OUT').length, 1);
});

test('superseded incoming messages each retain exactly one audit row', async () => {
  const rows = [];
  let finish;
  const audit = new Logger({ files: false, color: false, output: (line) => rows.push(JSON.parse(line)) });
  const s = setup([send('opening'), () => new Promise((resolve) => { finish = resolve; }), send('confirm')], { audit });
  await s.agent.start();
  const working = s.agent.receive(s.agent.observe('Available'));
  const latest = s.agent.observe('Please confirm');
  finish(send('repeat'));
  await working;
  await s.agent.receive(latest);
  const inbound = rows.filter((row) => row.event === 'conversation.message' && row.direction === 'IN');
  assert.equal(inbound.length, 2);
  assert.equal(inbound[0].decision, 'superseded');
  assert.equal(inbound[1].decision, 'confirm');
  assert.equal(s.outgoing.length, 2);
});
