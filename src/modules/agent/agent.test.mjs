import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { BookingAgent } from '../../../dist/modules/agent/agent.js';
import { londonClock, loadBooking } from '../../../dist/modules/agent/config.js';
import { Logger } from '../../../dist/modules/logger/logger.js';
import { fixtureMenu } from './fixtures.mjs';
import { bookingTimes, bookingCalendar } from '../../../dist/modules/agent/reply-policy.js';

let saved;
beforeEach(() => {
  saved = Object.fromEntries(['BOOKING_RESTAURANT', 'BOOKING_TIME', 'BOOKING_GUESTS', 'BOOKING_NAME', 'BOOKING_PHONE', 'BOOKING_EMAIL']
    .map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    BOOKING_RESTAURANT: 'Test Bistro', BOOKING_TIME: '17:00', BOOKING_GUESTS: '2',
  });
  for (const key of ['BOOKING_NAME', 'BOOKING_PHONE', 'BOOKING_EMAIL']) delete process.env[key];
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
      if (payload.review) return { text: JSON.stringify({ safe: options.review ? options.review(payload) : !/Booked tomorrow for five/.test(payload.review.message) }), content: {} };
      payload.menu = fixtureMenu(payload);
      if (payload.ownerInput && ['name', 'phone', 'email'].includes(payload.ownerInput.field)) {
        return { text: JSON.stringify({ ...send('details_' + payload.ownerInput.field),
          message: payload.menu['details_' + payload.ownerInput.field] }), content: {} };
      }
      if (payload.waiting && payload.waiting !== 'other' && payload.waiting !== 'time') {
        return { text: JSON.stringify({ ...send('reply'), message: payload.menu.reply }), content: {} };
      }
      calls.push(payload);
      assert.equal(settings.responseJsonSchema.type, 'object');
      const next = decisions.shift();
      if (next instanceof Error) throw next;
      let decision = typeof next === 'function' ? await next(payload, signal) : next;
      assert.ok(decision, 'Missing fake decision');
      if (typeof decision === 'string') return { text: decision, content: {} };
      decision = { ...decision, message: decision.message ??
        (decision.action === 'SEND' ? payload.menu[decision.messageKey] ?? '' : decision.action === 'CONFIRMED' ? payload.menu.final : '') };
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

test('manager follow-up cannot bypass owner consent to a deposit while paused', async () => {
  const s = setup([send('opening'), send('confirm'), { ...need('other'), message: 'I will check the deposit with the guest.' }, confirmed]);
  await s.agent.start();
  await s.receive('Available');
  await s.receive('A deposit is required.');
  await s.receive('Confirmed');
  assert.equal(s.status().state, 'NEEDS_INPUT');
  assert.equal(s.status().needsInput, 'other');
  assert.equal(s.status().managerConfirmed, false);
  assert.equal(s.outgoing.length, 3);
});

test('IDLE does not invoke Gemini or send', () => {
  const s = setup([]);
  assert.equal(s.agent.observe('Hello'), undefined);
  assert.equal(s.status().state, 'IDLE');
  assert.equal(s.calls.length + s.outgoing.length, 0);
});

test('configured restaurant can be echoed in the opening without manager evidence', async () => {
  for (const extra of [
    { restaurantName: 'Test Bistro' },
    { restaurantName: 'Test Bistro', restaurantEvidence: '' },
    { restaurantName: ' test bistro ', restaurantEvidence: 'Owner configuration' },
  ]) {
    const s = setup([{ ...send('opening'), ...extra }]);
    await s.agent.start();
    assert.equal(s.status().state, 'NEGOTIATING');
    assert.equal(s.outgoing.length, 1);
    assert.match(s.outgoing[0], /Test Bistro/);
    assert.equal(s.status().booking.restaurant, 'Test Bistro');
  }
});

test('opening still cannot invent or overwrite a restaurant name', async () => {
  for (const name of ['', 'Test Bistro']) {
    process.env.BOOKING_RESTAURANT = name;
    const s = setup([{ ...send('opening'), restaurantName: 'Invented Bistro', restaurantEvidence: 'Owner configuration' }]);
    await s.agent.start();
    assert.equal(s.status().lastError, 'AGENT_UNGROUNDED_RESTAURANT');
    assert.equal(s.outgoing.length, 0);
  }
});

test('review repair can echo the configured restaurant without a manager quotation', async () => {
  const s = setup([{ ...send('opening'), message: 'Reject this synthetic first draft.' },
    { ...send('opening'), restaurantName: 'Test Bistro', restaurantEvidence: '' }],
    { review: p => !p.review.message.includes('Reject this') });
  await s.agent.start();
  assert.equal(s.status().state, 'NEGOTIATING');
  assert.equal(s.outgoing.length, 1);
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

test('missing restaurant is learned from an explicit manager statement without owner intervention', async () => {
  process.env.BOOKING_RESTAURANT = '';
  const s = setup([send('opening'), { ...send('reply'),
    message: 'Thank you. May I book the table, please?',
    restaurantName: 'Manager Bistro', restaurantEvidence: 'This is Manager Bistro.' }]);
  await s.agent.start();
  assert.equal(s.status().state, 'NEGOTIATING');
  await s.receive('This is Manager Bistro.');
  assert.equal(s.status().booking.restaurant, 'Manager Bistro');
  assert.equal(s.status().state, 'NEGOTIATING');
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

test('premature bare confirmation triggers a generated clarification', async () => {
  const s = setup([send('opening'), confirmed, send('confirm')]);
  await s.agent.start();
  await s.receive('Confirmed');
  assert.equal(s.status().state, 'CONFIRMING');
  assert.equal(s.status().managerConfirmed, false);
});

test('qualified yes cannot complete even if model misclassifies it', async () => {
  const s = setup([send('opening'), send('confirm'), confirmed, send('confirm')]);
  await s.agent.start();
  await s.receive('Available');
  await s.receive('Yes, but at 17:30');
  assert.equal(s.status().state, 'CONFIRMING');
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

test('temporary API failure before the opening can be retried with book without losing the booking', async () => {
  const s = setup([new Error('GEMINI_UNAVAILABLE'), send('opening')]);
  await s.agent.start();
  const firstId = s.agent.sessionId;
  assert.equal(s.status().state, 'NEGOTIATING');
  assert.equal(s.status().lastError, 'GEMINI_UNAVAILABLE');
  assert.equal(s.outgoing.length, 0);
  await s.agent.start();
  assert.equal(s.agent.sessionId, firstId);
  assert.equal(s.status().state, 'NEGOTIATING');
  assert.equal(s.status().lastError, '');
  assert.equal(s.outgoing.length, 1);
});

test('temporary reviewer failure does not send or duplicate the opening', async () => {
  let failures = 1;
  const s = setup([send('opening'), send('opening')], { review: () => {
    if (failures--) throw new Error('GEMINI_NETWORK');
    return true;
  } });
  await s.agent.start();
  assert.equal(s.outgoing.length, 0);
  assert.equal(s.status().state, 'NEGOTIATING');
  await s.agent.start();
  assert.equal(s.outgoing.length, 1);
});

test('stop prevents retrying a failed AI call in the stopped booking', async () => {
  const s = setup([new Error('GEMINI_UNAVAILABLE')]);
  await s.agent.start();
  s.agent.cancel();
  await s.agent.start();
  assert.equal(s.status().state, 'CANCELLED');
  assert.equal(s.calls.length, 1);
  assert.equal(s.outgoing.length, 0);
});

test('manager refusal waits for an update instead of entering FAILED', async () => {
  const s = setup([send('opening'), { action: 'UNAVAILABLE', messageKey: 'none', field: 'none', question: '' }]);
  await s.agent.start();
  await s.receive('We have no tables at 17:00 today.');
  assert.equal(s.status().state, 'WAITING_AVAILABILITY');
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
  assert.equal(inbound[0].text, 'Private manager text');
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

test('AI generates a relevant reply to a statement without a question', async () => {
  const s = setup([send('opening'), { ...send('reply'),
    message: 'Lovely to meet you, Alex. Would you have a table for two at 17:00, please?' }]);
  await s.agent.start();
  await s.receive('My name is Alex.');
  assert.match(s.outgoing.at(-1), /Lovely to meet you, Alex/);
  assert.deepEqual(s.status().knownPersonalFields, []);
  assert.equal(s.status().state, 'NEGOTIATING');
});

test('manager statement receives a reply while owner name is still missing', async () => {
  const s = setup([send('opening'), { ...need('name'), message: 'One moment, please, I am checking the name.' }]);
  await s.agent.start();
  await s.receive('What name is the reservation under?');
  assert.match(s.outgoing.at(-1), /checking the name/);
  await s.receive('My name is Alex.');
  assert.equal(s.status().state, 'NEEDS_INPUT');
  assert.equal(s.status().needsInput, 'name');
  assert.equal(s.outgoing.length, 3);
});

test('configured guest details are available to the AI without inventing them', async () => {
  process.env.BOOKING_NAME = 'Configured Guest';
  process.env.BOOKING_PHONE = '+447700900001';
  const s = setup([send('opening'), send('details_name')]);
  await s.agent.start();
  await s.receive('Your name, please?');
  assert.match(s.outgoing.at(-1), /Configured Guest/);
  assert.equal(s.calls.at(-1).personal.phone, '+447700900001');
});

test('natural explicit booking confirmation can complete without requiring a magic word', async () => {
  const s = setup([send('opening'), confirmed]);
  await s.agent.start();
  await s.receive('Perfect. I have booked your table.');
  assert.equal(s.status().state, 'COMPLETED');
  assert.match(s.outgoing.at(-1), /2026-11-17, 17:00.*2 guests/);
});

test('final recap accepts natural English dates and 12-hour time without changing the booking', async () => {
  const s = setup([send('opening'), { ...confirmed,
    message: 'Thank you! A table for two at Test Bistro on 17th November 2026 at 5:00 pm is confirmed.' }]);
  await s.agent.start();
  await s.receive('I have booked a table for two at 5:00 pm.');
  assert.equal(s.status().state, 'COMPLETED');
});

test('uncertain availability cannot complete the booking', async () => {
  const s = setup([send('opening'), send('confirm'), confirmed, send('confirm')]);
  await s.agent.start();
  await s.receive('Available');
  await s.receive('That should be fine.');
  assert.notEqual(s.status().state, 'COMPLETED');
  assert.equal(s.status().managerConfirmed, false);
});

test('conflicting confirmation cannot complete even if both AI decisions claim it is confirmed', async () => {
  for (const text of ['I have booked your table at 18:00.', 'I have booked a table for three.',
    'Your reservation is confirmed for 2026-11-18.', 'Your table is booked at 6 pm.',
    'Your table is booked at half five.', 'Your table is booked at five thirty.']) {
    const s = setup([send('opening'), send('confirm'), confirmed, confirmed]);
    await s.agent.start();
    await s.receive('Available');
    await s.receive(text);
    assert.notEqual(s.status().state, 'COMPLETED');
    assert.equal(s.status().managerConfirmed, false);
  }
});

test('restaurant extraction must be grounded in manager text and cannot change a known restaurant', async () => {
  for (const known of ['', 'Test Bistro']) {
    process.env.BOOKING_RESTAURANT = known;
    const s = setup([send('opening'), { ...send('reply'), message: 'Thank you.',
      restaurantName: 'Invented Restaurant', restaurantEvidence: 'This is Invented Restaurant.' }]);
    await s.agent.start();
    await s.receive('We have a table.');
    assert.equal(s.status().lastError, 'AGENT_UNGROUNDED_RESTAURANT');
    assert.equal(s.outgoing.length, 1);
  }
});

test('unsafe AI reply is repaired once before sending', async () => {
  const s = setup([send('opening'), { ...send('reply'), message: 'The phone is 123456789.' },
    { ...need('phone'), message: 'I am checking the contact number, thank you.' }],
    { review: p => !p.review.message.includes('123456789') });
  await s.agent.start();
  await s.receive('May I have a phone number?');
  assert.equal(s.status().state, 'NEEDS_INPUT');
  assert.ok(s.outgoing.every(text => !text.includes('123456789')));
  assert.match(s.outgoing.at(-1), /checking the contact/);
});

test('technical prefix in an opening is regenerated even if the AI reviewer would approve it', async () => {
  const s = setup([{ ...send('opening'),
    message: 'londonNow. Hello, I would like to book a table for two at Test Bistro at 17:00.' },
    send('opening')], { review: () => true });
  await s.agent.start();
  assert.equal(s.status().state, 'NEGOTIATING');
  assert.equal(s.outgoing.length, 1);
  assert.ok(!s.outgoing[0].includes('londonNow'));
  assert.equal(s.calls[0].londonNow, undefined);
});

test('repeated internal metadata is never delivered after a repair', async () => {
  const s = setup([{ ...send('opening'), message: 'restaurantEvidence: Test Bistro. Hello.' },
    { ...send('opening'), message: 'firstContact: Hello, may I book?' }], { review: () => true });
  await s.agent.start();
  assert.equal(s.status().lastError, 'AGENT_UNSAFE_REPLY');
  assert.equal(s.outgoing.length, 0);
});

test('polite acknowledgement is sent before waiting for availability', async () => {
  const s = setup([send('opening'), { action: 'UNAVAILABLE', messageKey: 'reply', field: 'none',
    message: 'Thank you for checking. Have a lovely afternoon.', question: '' }]);
  await s.agent.start();
  await s.receive('We are fully booked today.');
  assert.equal(s.status().state, 'WAITING_AVAILABILITY');
  assert.match(s.outgoing.at(-1), /Thank you for checking/);
});

test('refusal stays open for questions and a newly available original table in the same session', async () => {
  const rows = [];
  const audit = new Logger({ files: false, color: false, output: line => rows.push(JSON.parse(line)) });
  const unavailable = { action: 'UNAVAILABLE', messageKey: 'reply', field: 'none', question: '',
    message: 'Thank you for checking. Please let me know if a table at 17:00 becomes available.' };
  const s = setup([send('opening'), unavailable,
    { ...send('reply'), message: 'Yes, I am an AI booking assistant arranging this reservation for the guest.' },
    { ...send('reply'), message: 'You have not told me your name yet.' }, send('confirm'), confirmed], { audit });
  await s.agent.start();
  const id = s.agent.sessionId;
  await s.receive('No tables at 17:00; 17:30 is the earliest.');
  assert.equal(s.status().state, 'WAITING_AVAILABILITY');
  assert.equal(s.agent.running, true);
  await s.receive('Am I chatting to a person or a bot?');
  assert.match(s.outgoing.at(-1), /AI booking assistant/);
  assert.equal(s.status().state, 'WAITING_AVAILABILITY');
  await s.receive('What is my name?');
  assert.match(s.outgoing.at(-1), /not told me your name/);
  await s.receive('Good news — a 5 o’clock table has just freed up for two at 17:00 today. Reference OR-1117.');
  assert.equal(s.status().state, 'CONFIRMING');
  assert.equal(s.agent.sessionId, id);
  assert.ok(s.calls.at(-1).transcript.some(e => e.text.includes('17:30 is the earliest')));
  assert.ok(s.calls.at(-1).transcript.some(e => e.text.includes('person or a bot')));
  await s.receive('Yes, confirmed.');
  assert.equal(s.status().state, 'COMPLETED');
  assert.match(s.outgoing.at(-1), /Test Bistro, London, 2026-11-17, 17:00.*2 guests/);
  const sent = s.outgoing.length;
  await s.receive('Thank you.');
  assert.equal(s.outgoing.length, sent);
  assert.equal(rows.filter(r => r.event === 'booking.started').length, 1);
  assert.equal(rows.filter(r => r.event === 'booking.finished').length, 1);
  assert.equal(rows.find(r => r.event === 'booking.finished').data.outcome, 'COMPLETED');
  assert.ok(rows.some(r => r.event === 'conversation.message' && r.state === 'WAITING_AVAILABILITY'));
});

test('repeated unavailability does not repeat closing messages or trigger autonomous polling', async () => {
  const unavailable = { action: 'UNAVAILABLE', messageKey: 'reply', field: 'none', question: '', message: 'Thank you for checking.' };
  const s = setup([send('opening'), unavailable, unavailable]);
  await s.agent.start();
  await s.receive('We are full.');
  await s.receive('Sorry, we are still full.');
  assert.equal(s.status().state, 'WAITING_AVAILABILITY');
  assert.equal(s.calls.length, 3);
  assert.equal(s.outgoing.length, 2);
});

test('stop while waiting prevents reactivation on later manager availability', async () => {
  const s = setup([send('opening'), { action: 'UNAVAILABLE', messageKey: 'none', field: 'none', question: '' }]);
  await s.agent.start();
  await s.receive('We have no tables.');
  s.agent.cancel();
  await s.receive('A table has just become available.');
  assert.equal(s.status().state, 'CANCELLED');
  assert.equal(s.calls.length, 2);
  assert.equal(s.outgoing.length, 1);
});

test('a table offered after the requested slot has passed cannot be booked', async () => {
  let now = new Date('2026-11-17T12:00:00Z');
  const s = setup([send('opening'), { action: 'UNAVAILABLE', messageKey: 'none', field: 'none', question: '' }], { now: () => now });
  await s.agent.start();
  await s.receive('No tables at 17:00.');
  now = new Date('2026-11-17T17:01:00Z');
  await s.receive('A table at 17:00 has become available.');
  assert.equal(s.status().state, 'FAILED');
  assert.equal(s.status().lastError, 'BOOKING_PAST');
  assert.equal(s.outgoing.length, 1);
});

test('restaurant time parser understands numeric and British alternatives without treating guests as hours', () => {
  assert.deepEqual(bookingTimes('Half five or six, please.', '17:00'), ['17:30', '18:00']);
  assert.deepEqual(bookingTimes('5:30 pm or 18:00', '17:00'), ['17:30', '18:00']);
  assert.deepEqual(bookingTimes('quarter to six or quarter past five', '17:00'), ['17:45', '17:15']);
  assert.deepEqual(bookingTimes('five thirty', '17:00'), ['17:30']);
  assert.deepEqual(bookingTimes('A table for two on 18 November 2026. Deposit £20 per person.', '17:00'), []);
  assert.deepEqual(bookingTimes('At 5:00 am, not at 5 pm.', '17:00'), ['05:00', '17:00']);
});

test('unapproved alternative in generated text is blocked even when the AI reviewer approves it', async () => {
  process.env.BOOKING_NAME = 'Synthetic Guest';
  const s = setup([send('opening'), { ...send('details_name'),
    message: 'The name is Synthetic Guest. Could we please go for the 5:30 pm slot?' },
    { ...need('time'), message: 'I will check the timing with the guest.', question: 'Do you approve 17:30 or 18:00?' },
    { ...send('reply'), message: 'I am still checking the timing with the guest.' }, send('confirm'), confirmed],
    { review: () => true });
  await s.agent.start();
  await s.receive('5 is fully booked, but I could do half five or six. What name, please?');
  assert.equal(s.status().needsInput, 'time');
  assert.equal(s.status().booking.time, '17:00');
  assert.deepEqual(s.status().alternativeTimes, ['17:30', '18:00']);
  assert.ok(s.outgoing.every(m => !/5:30|17:30|half five/i.test(m)));
  await s.agent.input('time', '18:30');
  assert.equal(s.status().needsInput, 'time');
  await s.agent.input('other', '17:30 works for me');
  assert.equal(s.status().booking.time, '17:00');
  await s.receive('Either works. Yes, confirmed for half five.');
  assert.equal(s.status().needsInput, 'time');
  assert.equal(s.status().booking.time, '17:00');
  await s.agent.input('time', '17:30');
  assert.equal(s.status().booking.time, '17:30');
  assert.equal(s.status().state, 'CONFIRMING');
  assert.equal(s.calls.at(-1).originalBooking.time, '17:00');
  assert.match(s.outgoing.at(-1), /17:30/);
  await s.receive('Yes, confirmed.');
  assert.equal(s.status().state, 'COMPLETED');
  assert.match(s.outgoing.at(-1), /17:30/);
});

test('an owner supplying only a name cannot approve a manager alternative', async () => {
  const s = setup([send('opening'), need('name')]);
  await s.agent.start();
  await s.receive('Only half five is available. What is your name?');
  await s.agent.input('name', 'Synthetic Guest');
  assert.equal(s.status().booking.time, '17:00');
  assert.deepEqual(s.status().alternativeTimes, ['17:30']);
  assert.match(s.outgoing.at(-1), /Synthetic Guest/);
  assert.ok(!s.outgoing.at(-1).includes('17:30'));
});

test('ambiguous acceptance of a later slot is blocked even without a time in the outgoing message', async () => {
  for (const message of ['Later works for us. Please book it.', 'We will take the later slot.',
    'Either would be lovely.', 'That works, thank you.']) {
    const s = setup([send('opening'), { ...send('reply'), message },
      { ...need('time'), message: 'I will check the timing with the guest.' }], { review: () => true });
    await s.agent.start();
    await s.receive('Only half five or six is available.');
    assert.equal(s.status().needsInput, 'time');
    assert.equal(s.status().booking.time, '17:00');
    assert.ok(!s.outgoing.includes(message));
  }
});

test('owner can decline alternatives without changing the original time or stopping the listener', async () => {
  const s = setup([send('opening'), { ...need('time'), message: 'I will check the timing with the guest.' },
    { action: 'UNAVAILABLE', messageKey: 'reply', field: 'none', question: '',
      message: 'Thank you for checking. We need 17:00; please let us know if a table becomes available.' }]);
  await s.agent.start();
  await s.receive('Only half five is available.');
  await s.agent.input('time', 'no');
  assert.equal(s.status().booking.time, '17:00');
  assert.equal(s.status().state, 'WAITING_AVAILABILITY');
  assert.equal(s.calls.at(-1).ownerInput.value, 'decline');
  assert.ok(s.outgoing.every(text => !/17:30|5:30/.test(text)));
});

test('greeting appears only on the first outgoing message', async () => {
  const s = setup([send('opening'), { ...send('reply'), message: 'Hello, thank you for checking.' },
    { ...send('reply'), message: 'Good afternoon! Hello, could you confirm availability, please?' }]);
  await s.agent.start();
  await s.receive('I will check.');
  await s.receive('One moment.');
  assert.match(s.outgoing[0], /^Good afternoon/);
  assert.equal(s.outgoing[1], 'Thank you for checking.');
  assert.equal(s.outgoing[2], 'Could you confirm availability, please?');
});

test('weekday comes from the actual London booking date and an incorrect weekday is repaired', async () => {
  assert.equal(bookingCalendar('2026-11-18').weekday, 'Wednesday');
  const londonDate = loadBooking(new Date('2026-07-01T23:30:00Z')).date;
  assert.equal(londonDate, '2026-07-02');
  assert.equal(bookingCalendar(londonDate).weekday, 'Thursday');
  const s = setup([{ ...send('opening'), message: 'Hello, a table for two on Tuesday 18 November 2026 at 17:00, please.' },
    { ...send('opening'), message: 'Hello, a table for two on Wednesday 18 November 2026 at 17:00, please.' }],
    { now: () => new Date('2026-11-18T12:00:00Z'), review: () => true });
  await s.agent.start();
  assert.equal(s.outgoing.length, 1);
  assert.match(s.outgoing[0], /Wednesday/);
  assert.ok(!s.outgoing[0].includes('Tuesday'));
  assert.equal(s.calls[0].calendar.weekday, 'Wednesday');
});

test('a generated claim to be human is rejected and replaced with truthful AI disclosure', async () => {
  const s = setup([send('opening'), { ...send('reply'), message: 'I am a human, not a bot.' },
    { ...send('reply'), message: 'Yes, I am an AI booking assistant arranging this on behalf of the guest.' }], { review: () => true });
  await s.agent.start();
  await s.receive('Out of curiosity, am I chatting to a person or a bot?');
  assert.equal(s.outgoing.length, 2);
  assert.match(s.outgoing.at(-1), /AI booking assistant/);
  assert.ok(s.outgoing.every(m => !m.includes('I am a human')));
});

test('deposit and card request pauses for the owner, rejects card input and prevents premature completion', async () => {
  const s = setup([send('opening'), { ...send('reply'), message: 'The deposit is fine. We will pay it.' },
    { ...need('other'), message: 'I cannot share card details here. I will check the deposit with the guest; could you send a secure payment link?' }, confirmed],
    { review: () => true });
  await s.agent.start();
  await s.receive('Before I finalise: we take a £20 per person deposit. Could you send me the card number and expiry date?');
  assert.equal(s.status().needsInput, 'other');
  assert.ok(s.outgoing.every(m => !m.includes('We will pay')));
  const calls = s.calls.length;
  for (const value of ['4111 1111 1111 1111 expiry 12/28', '12/28', '123']) {
    await s.agent.input('other', value);
  }
  assert.equal(s.calls.length, calls);
  assert.ok(!JSON.stringify(s.agent.context()).includes('4111'));
  assert.ok(!JSON.stringify(s.agent.context()).includes('12/28'));
  await s.receive('Your booking is confirmed.');
  assert.equal(s.status().state, 'NEEDS_INPUT');
  assert.equal(s.status().managerConfirmed, false);
});

test('approving a different deposit amount does not authorise the requested deposit', async () => {
  const s = setup([send('opening'), { ...need('other'), message: 'I will check the deposit with the guest.' },
    { ...send('reply'), message: 'Could you clarify the deposit amount, please?' }, confirmed]);
  await s.agent.start();
  await s.receive('A £20 per person deposit is required.');
  await s.agent.input('other', 'I approve a £10 deposit.');
  assert.equal(s.calls.at(-1).depositApproved, false);
  await s.receive('Your reservation is confirmed.');
  assert.equal(s.status().state, 'NEEDS_INPUT');
  assert.equal(s.status().managerConfirmed, false);
});

test('an explicit owner deposit approval can request a secure link without sending card data or claiming payment', async () => {
  const s = setup([send('opening'), { ...need('other'), message: 'I cannot share card details here. I will check with the guest.' },
    { ...send('reply'), message: 'Could you please send a secure payment link for the deposit?' }]);
  await s.agent.start();
  await s.receive('We need a £20 per person deposit. Please send the card number and expiry date.');
  await s.agent.input('other', 'I approve the £20 per person deposit. Please ask for a secure payment link.');
  assert.equal(s.calls.at(-1).depositApproved, true);
  assert.equal(s.status().managerConfirmed, false);
  assert.match(s.outgoing.at(-1), /secure payment link/);
  assert.ok(s.outgoing.every(m => !/4111|has been paid|we have paid/i.test(m)));
});
