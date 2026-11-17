import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { BookingAgent } from '../../../dist/modules/agent/agent.js';
import { londonClock, loadBooking } from '../../../dist/modules/agent/config.js';

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
  }, (error) => error.message, (text) => logs.push(text), now);
  const status = () => { agent.status(); return JSON.parse(logs.at(-1)); };
  const receive = async (text) => {
    const receipt = agent.observe(text);
    if (receipt) await agent.receive(receipt);
  };
  return { agent, outgoing, calls, status, receive };
}

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
