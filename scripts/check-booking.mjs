// Synthetic conversation only: deliberately does not import/connect Telegram.
// --live opts in to real Gemini calls and consumes API quota.
import dotenv from 'dotenv';
import assert from 'node:assert/strict';
import { BookingAgent } from '../dist/modules/agent/agent.js';
import { createGeminiService } from '../dist/modules/ai/gemini.js';
import { Logger } from '../dist/modules/logger/logger.js';
import { Redactor } from '../dist/modules/logger/redact.js';
dotenv.config({ quiet: true });
if (!process.argv.includes('--live')) throw new Error('Pass --live to use Gemini quota for a synthetic conversation.');
Object.assign(process.env, { BOOKING_RESTAURANT: process.argv.includes('--configured') ? 'Smoke Test Bistro' : '', BOOKING_TIME: '17:00', BOOKING_GUESTS: '2' });
for (const key of ['BOOKING_NAME', 'BOOKING_PHONE', 'BOOKING_EMAIL']) delete process.env[key];
const audit = new Logger({ directory: 'output/booking-check', console: false });
const gemini = createGeminiService({ apiKey: process.env.GEMINI_API_KEY,
  fallbackModel: process.env.GEMINI_FALLBACK_MODEL,
  model: process.env.GEMINI_MODEL, audit });
if (process.argv.includes('--debug')) {
  const generate = gemini.generateReply;
  gemini.generateReply = async (...args) => {
    const result = await generate(...args);
    console.log('SYNTHETIC AI RESPONSE: ' + new Redactor().text(result.text));
    return result;
  };
}
const notices = [];
let delivered = 0;
const agent = new BookingAgent(gemini, async (text) => {
  delivered++;
  console.log('AGENT: ' + text);
  return 'text';
}, e => e.message, text => notices.push(text), () => new Date('2026-11-18T12:00:00Z'), audit);
const receive = async text => {
  console.log('SYNTHETIC MANAGER: ' + text);
  const receipt = agent.observe(text);
  assert.ok(receipt);
  await agent.receive(receipt);
};
try {
  await agent.start();
  assert.equal(agent.currentState, 'NEGOTIATING');
  assert.equal(delivered, 1, 'Opening was not generated and passed to the synthetic transport');
  if (process.argv.includes('--opening-only')) {
    console.log(JSON.stringify({ liveGemini: true, syntheticConversation: true,
      telegramConnected: false, openingGenerated: true }));
  } else {
  await receive('Good afternoon. This is Smoke Test Bistro in London. We have a table for two today at 17:00. What name should I put it under? My name is Alex.');
  assert.equal(agent.currentState, 'NEEDS_INPUT');
  await agent.input('name', 'Synthetic Guest');
  assert.equal(agent.currentState, 'NEGOTIATING');
  await receive('Thank you. That should be fine.');
  assert.notEqual(agent.currentState, 'COMPLETED');
  await receive('Your reservation is confirmed. I have booked a table for two at Smoke Test Bistro on 2026-11-18 at 17:00 London time.');
  assert.equal(agent.currentState, 'COMPLETED');
  console.log(JSON.stringify({ liveGemini: true, syntheticConversation: true, telegramConnected: false,
    state: agent.currentState, decisionLogs: 'output/booking-check/' }));
  }
} catch (error) {
  console.log(JSON.stringify({ passed: false, state: agent.currentState,
    errorCode: /^[A-Z_]+$/.test(error.message) ? error.message : 'CHECK_FAILED', notices }));
  process.exitCode = 1;
} finally {
  audit.flush({ understood: 'Synthetic check finished.', decision: 'check_finished', state: agent.currentState });
}
