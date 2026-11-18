import { logger, Logger, errorInfo, type MessageLog, type Explanation } from '../logger/logger.js';
import type { GeminiService } from '../ai/gemini.js';
import { loadBooking, slotIsFuture, type Booking } from './config.js';
import { AGENT_PROMPT, REVIEW_PROMPT } from './prompt.js';

export type State = 'IDLE' | 'NEGOTIATING' | 'NEEDS_INPUT' |
  'CONFIRMING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
type Field = 'restaurant' | 'name' | 'phone' | 'email' | 'other';
export interface Arrival { runId: number; revision: number; mayConfirm: boolean }
export interface Receipt extends Arrival { text: string; audit: MessageLog }
type Entry = { source: 'owner' | 'manager' | 'assistant' | 'system'; text: string };
type Decision = {
  action: 'SEND' | 'NEEDS_INPUT' | 'CONFIRMED' | 'UNAVAILABLE';
  messageKey: string;
  message: string;
  field: 'name' | 'phone' | 'email' | 'restaurant' | 'other' | 'none';
  question: string;
  restaurantName?: string;
  restaurantEvidence?: string;
};
const active = new Set<State>(['NEGOTIATING', 'NEEDS_INPUT', 'CONFIRMING']);
const transitions: Record<State, State[]> = {
  IDLE: ['NEGOTIATING', 'FAILED'],
  NEGOTIATING: ['NEEDS_INPUT', 'CONFIRMING', 'COMPLETED', 'FAILED', 'CANCELLED'],
  NEEDS_INPUT: ['NEGOTIATING', 'CONFIRMING', 'FAILED', 'CANCELLED'],
  CONFIRMING: ['NEGOTIATING', 'NEEDS_INPUT', 'COMPLETED', 'FAILED', 'CANCELLED'],
  COMPLETED: [], FAILED: [], CANCELLED: [],
};

// A bare yes needs a preceding full summary; natural explicit bookings also work.
function explicitYes(text: string): boolean {
  if (/\b(?:but|if|unless|maybe|might|should|could|would|not|no|deposit|payment|available|availability|pending|after|once|upon|provided|tomorrow)\b|subject to|\?/i.test(text)) return false;
  return /^(?:yes|confirmed|booked)[.!\s]*$/i.test(text.trim()) ||
    /\b(?:confirmed|booked|booking is confirmed|reservation is confirmed)\b/i.test(text);
}

export class BookingAgent {
  private state: State = 'IDLE';
  private booking?: Booking;
  private personal: Partial<Record<'name' | 'phone' | 'email', string>> = {};
  private journal: Entry[] = [];
  private waiting: Field | undefined;
  private resume: State = 'NEGOTIATING';
  private abort = new AbortController();
  private confirmationReady = false;
  private managerConfirmed = false;
  private turns = 0;
  private lastError = '';
  private version = 0;
  private revision = 0;
  private bookingSessionId: string | null = null;
  private readonly pendingMessages = new Map<number, MessageLog>();
  private ownerInput: { field: string; value: string } | undefined;
  private requireOwnerConsent = false;
  private retryContext: { managerText: string; mayConfirm: boolean } | undefined;

  constructor(
    private readonly gemini: GeminiService,
    private readonly send: (text: string, isCurrent?: () => boolean) => Promise<'text' | void>,
    private readonly describeError: (error: unknown) => string,
    private readonly log: (text: string) => void = logger.notice,
    private readonly now: () => Date = () => new Date(),
    private readonly audit: Logger = logger,
  ) {}

  get sessionId(): string | null { return this.bookingSessionId; }
  get currentState(): State { return this.state; }
  get running(): boolean { return active.has(this.state); }
  get runId(): number { return this.version; }
  get canConfirm(): boolean {
    return this.state === 'CONFIRMING' && this.confirmationReady;
  }

  status(): void {
    this.log(JSON.stringify({
      state: this.state, booking: this.booking,
      needsInput: this.waiting, entries: this.journal.length,
      knownPersonalFields: Object.keys(this.personal),
      managerConfirmed: this.managerConfirmed, lastError: this.lastError,
    }, null, 2));
  }

  // Full context remains in RAM. Return a copy so callers cannot mutate it.
  context(): Entry[] { return structuredClone(this.journal); }

  private move(next: State): void {
    if (this.state === next) return;
    if (!transitions[this.state].includes(next)) throw new Error('AGENT_TRANSITION');
    const previous = this.state;
    this.state = next;
    this.audit.technical('info', 'agent.state_changed', { from: previous, to: next }, this.sessionId);
    this.journal.push({ source: 'system', text: 'State: ' + next });
    this.log('[AGENT] ' + next);
  }

  private fail(error: unknown): void {
    if (!this.running && this.state !== 'IDLE') return;
    this.lastError = this.describeError(error);
    this.confirmationReady = false;
    this.move('FAILED');
    this.audit.technical('error', 'agent.failed', errorInfo(error), this.sessionId);
    this.finishPending('booking_failed');
    this.audit.technical('error', 'booking.finished', {
      outcome: 'FAILED', managerConfirmed: this.managerConfirmed,
    }, this.sessionId);
    this.log(this.lastError);
    this.log('Автовідповіді вимкнено. Перед повторним запуском перевір чат вручну.');
  }

  private ensureFuture(): void {
    if (!this.booking || !slotIsFuture(this.booking, this.now())) {
      throw new Error('BOOKING_PAST');
    }
  }

  private need(field: Field, question: string): void {
    this.resume = this.state === 'CONFIRMING' ? 'CONFIRMING' : 'NEGOTIATING';
    this.waiting = field;
    this.move('NEEDS_INPUT');
    // The logger masks secrets and known personal details in owner questions.
    this.log(field === 'other' ? 'Потрібне уточнення. Перевір останнє повідомлення менеджера в Telegram.' :
      'Потрібне поле: ' + field);
    if (question) this.log(question);
    this.audit.technical('info', 'agent.input_required', { field }, this.sessionId);
    this.log('Введи /input ' + field + ' значення або /stop.');
    if (field === 'other') {
      this.log('Дата, час і кількість гостей заблоковані. Для зміни: /stop, нова конфігурація і перезапуск.');
    }
  }

  async start(): Promise<void> {
    if (this.state !== 'IDLE') {
      if (this.running && this.retryContext) {
        const retry = this.retryContext;
        this.retryContext = undefined;
        this.lastError = '';
        await this.step(retry.managerText, retry.mayConfirm);
        return;
      }
      this.log('У цьому запуску вже є спроба бронювання. Використай /status.');
      return;
    }
    this.version += 1;
    this.bookingSessionId = this.audit.newBookingId();
    this.audit.technical('info', 'booking.started', {}, this.sessionId);
    this.abort = new AbortController();
    try {
      this.booking = loadBooking(this.now());
      for (const field of ['name', 'phone', 'email'] as const) {
        const value = process.env['BOOKING_' + field.toUpperCase()]?.trim();
        if (value) {
          if (value.length > 200 || /[\r\n]/.test(value) ||
            (field === 'phone' && !/^\+?[\d ()-]{6,30}$/.test(value)) ||
            (field === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))) throw new Error('BOOKING_CONFIG');
          this.personal[field] = value;
          this.audit.rememberPrivate(value);
        }
      }
      this.audit.rememberPrivate(this.booking.restaurant);
      this.ensureFuture();
      this.move('NEGOTIATING');
      this.journal.push({ source: 'owner', text: '/book: ' + JSON.stringify(this.booking) });
      await this.step();
    } catch (error) { this.fail(error); }
  }

  cancel(): void {
    if (!this.running) {
      this.log('Активного бронювання немає.');
      return;
    }
    this.abort.abort();
    this.version += 1;
    this.confirmationReady = false;
    this.move('CANCELLED');
    this.finishPending('cancelled');
    this.audit.technical('info', 'booking.finished', { outcome: 'CANCELLED' }, this.sessionId);
    this.log('Зупинено локально. Уже надіслані повідомлення та бронювання в ресторані не скасовано.');
  }

  async input(field: string, value: string): Promise<void> {
    if (this.state !== 'NEEDS_INPUT' || field !== this.waiting) {
      this.log('Немає запиту на це поле. Перевір /status.');
      return;
    }
    value = value.trim();
    if (!value || value.length > 200 || /[\r\n]/.test(value) ||
        (field === 'restaurant' && value.length > 100) ||
        (field === 'phone' && !/^\+?[\d ()-]{6,30}$/.test(value)) ||
        (field === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))) {
      this.log('Некоректне значення. Повтори /input або /stop.');
      return;
    }
    this.audit.rememberPrivate(value);
    this.audit.technical('info', 'agent.input_received', { field }, this.sessionId);
    this.journal.push({ source: 'owner', text: field + ': ' + value });
    if (field === 'restaurant') this.booking = { ...this.booking!, restaurant: value };
    if (field === 'name' || field === 'phone' || field === 'email') this.personal[field] = value;
    this.waiting = undefined;
    if (field === 'other') this.requireOwnerConsent = false;
    this.ownerInput = { field, value };
    this.confirmationReady = false;
    this.move('NEGOTIATING');
    await this.step();
  }

  reserveIncoming(): Arrival | undefined {
    if (!this.running) return undefined;
    this.revision += 1;
    return { runId: this.version, revision: this.revision, mayConfirm: this.canConfirm };
  }

  observe(text: string, arrival = this.reserveIncoming()): Receipt | undefined {
    if (!arrival || !this.running || arrival.runId !== this.version) return undefined;
    this.journal.push({ source: 'manager', text });
    const audit = this.audit.message({
      bookingSessionId: this.sessionId, direction: 'IN', text, retainText: true,
    });
    this.pendingMessages.set(arrival.revision, audit);
    return { ...arrival, text, audit };
  }

  async receive(receipt: Receipt): Promise<void> {
    try {
      if (!this.running || receipt.runId !== this.version) {
        receipt.audit.finish({ understood: 'Бронювання більше не активне.',
          decision: 'ignored', state: this.state });
        return;
      }
      if (receipt.revision !== this.revision) {
        receipt.audit.finish({ understood: 'Надійшло новіше повідомлення; текст збережено в RAM.',
          decision: 'superseded', state: this.state });
        return;
      }
      if (this.state === 'NEEDS_INPUT' && this.waiting === 'other' && !this.requireOwnerConsent) {
        // A later manager message may resolve an incomplete/ambiguous reply.
        // Re-evaluate it with the full transcript; never treat it as owner consent.
        this.audit.technical('info', 'agent.input_reassessed', { field: 'other' }, this.sessionId);
        this.waiting = undefined;
        this.move(this.resume);
      }
      await this.step(receipt.text, receipt.mayConfirm, receipt.audit);
    } finally {
      this.pendingMessages.delete(receipt.revision);
    }
  }

  private finishPending(decision: string): void {
    for (const audit of this.pendingMessages.values()) {
      audit.finish({ understood: 'Активну обробку припинено.', decision, state: this.state });
    }
    this.pendingMessages.clear();
  }

  private fullSummary(text: string): boolean {
    const b = this.booking!;
    const normalized = text.toLowerCase().replace(/(\d)(?:st|nd|rd|th)\b/g, '$1').replace(/\bof\s+/g, '').replace(/,/g, '');
    const longDate = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric' })
      .format(new Date(b.date + 'T12:00:00Z')).toLowerCase();
    const [hour, minute] = b.time.split(':').map(Number);
    const twelveHour = String(hour! % 12 || 12) + (minute ? ':' + String(minute).padStart(2, '0') : '(?::00)?');
    const timePattern = new RegExp('\\b' + twelveHour + '\\s*' + (hour! >= 12 ? 'p' : 'a') + '\\.?m\\.?\\b', 'i');
    return Boolean(b.restaurant) && text.toLowerCase().includes(b.restaurant.toLowerCase()) &&
      (text.includes(b.date) || normalized.includes(longDate)) && (text.includes(b.time) || timePattern.test(text)) &&
      new RegExp('\\b(?:' + b.guests + (b.guests === 2 ? '|two' : '') + ')\\b', 'i').test(text);
  }

  private conflicts(text: string): boolean {
    const b = this.booking!;
    for (const match of text.matchAll(/\b(\d{1,2}):([0-5]\d)\b(?!\s*[ap]\.?m)/gi)) {
      if (match[1]!.padStart(2, '0') + ':' + match[2] !== b.time) return true;
    }
    for (const match of text.matchAll(/\b(\d{1,2})(?::([0-5]\d))?\s*([ap])\.?m\.?/gi)) {
      const hour = Number(match[1]) % 12 + (match[3]!.toLowerCase() === 'p' ? 12 : 0);
      if (String(hour).padStart(2, '0') + ':' + (match[2] ?? '00') !== b.time) return true;
    }
    for (const match of text.matchAll(/\b\d{4}-\d{2}-\d{2}\b/g)) if (match[0] !== b.date) return true;
    const counts: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };
    for (const match of text.matchAll(/\b(?:table|party|booking|reservation) for (\d+|one|two|three|four|five|six)\b/gi)) {
      if ((counts[match[1]!.toLowerCase()] ?? Number(match[1])) !== b.guests) return true;
    }
    return false;
  }

  private payload() {
    return { booking: this.booking, personal: this.personal, state: this.state,
      transcript: this.journal, waiting: this.waiting, ownerInput: this.ownerInput,
      firstContact: !this.journal.some(e => e.source === 'assistant'),
      mayConfirm: this.canConfirm, requireOwnerConsent: this.requireOwnerConsent };
  }

  private learnRestaurant(decision: Decision): void {
    if (!decision.restaurantName) return;
    const name = decision.restaurantName.trim();
    const known = this.booking!.restaurant;
    if (known && name.toLowerCase() === known.toLowerCase()) {
      // Owner configuration/input is already a trusted source. The model may
      // echo this name without a manager quotation, including on first contact.
      return;
    }
    const evidence = decision.restaurantEvidence;
    if (known || !name || name.length > 100 || /[\r\n]/.test(name) ||
      typeof evidence !== 'string' || !evidence.trim() ||
      !evidence.toLowerCase().includes(name.toLowerCase()) ||
      !this.journal.some(e => e.source === 'manager' && e.text.includes(evidence))) {
      throw new Error('AGENT_UNGROUNDED_RESTAURANT');
    }
    this.booking = { ...this.booking!, restaurant: name };
  }

  private hasInternalText(message: string): boolean {
    return /\b(?:londonNow|restaurantEvidence|restaurantName|firstContact|decisionFeedback|bookingSessionId|ownerInput|messageKey|responseJsonSchema|systemInstruction)\b/i.test(message);
  }

  private async review(message: string, action: string): Promise<boolean> {
    // Never trust an AI-only review to catch copied implementation identifiers.
    if (this.hasInternalText(message)) return false;
    const result = await this.gemini.generateReply('Verify proposed reply.', this.abort.signal, {
      systemInstruction: REVIEW_PROMPT, bookingSessionId: this.sessionId,
      contents: [{ role: 'user', parts: [{ text: JSON.stringify({ ...this.payload(),
        review: { message, action } }) }] }],
      responseJsonSchema: { type: 'object', additionalProperties: false,
        properties: { safe: { type: 'boolean' } }, required: ['safe'] },
    });
    try { return JSON.parse(result.text).safe === true; } catch { return false; }
  }

  private async step(managerText = '', mayConfirm = false, incoming?: MessageLog): Promise<void> {
    let explanation = { understood: 'Повідомлення не вдалося обробити.', decision: 'processing_failed' };
    const version = this.version;
    const revision = this.revision;
    try {
      this.ensureFuture();
      if (++this.turns > 40) throw new Error('AGENT_TURN_LIMIT');
      this.retryContext = undefined;
      this.lastError = '';
      const firstContact = this.payload().firstContact;
      const keys = ['opening', 'opening_polite', 'reply', 'repeat', 'confirm',
        'details_name', 'details_phone', 'details_email', 'final', 'none'];
      const schema = {
        type: 'object', additionalProperties: false,
        properties: {
          action: { type: 'string', enum: firstContact ? ['SEND'] : ['SEND', 'NEEDS_INPUT', 'CONFIRMED', 'UNAVAILABLE'] },
          messageKey: { type: 'string', enum: keys },
          message: { type: 'string' },
          field: { type: 'string', enum: firstContact ? ['none'] : ['name', 'phone', 'email', 'restaurant', 'other', 'none'] },
          question: { type: 'string' },
          restaurantName: { type: 'string', ...(firstContact ? { enum: ['', this.booking!.restaurant].filter((v, i, values) => values.indexOf(v) === i) } : {}) },
          restaurantEvidence: { type: 'string' },
        },
        required: ['action', 'messageKey', 'message', 'field', 'question'],
      };
      const generate = (feedback = '') => this.gemini.generateReply(
        'Choose the next booking action.', this.abort.signal, {
          systemInstruction: AGENT_PROMPT,
          contents: [{
            role: 'user', parts: [{ text: JSON.stringify({
              ...this.payload(),
              mayConfirm: mayConfirm && this.canConfirm,
              decisionFeedback: feedback,
            }) }],
          }],
          responseJsonSchema: schema,
          bookingSessionId: this.sessionId,
        },
      );
      const parseDecision = (text: string): Decision => {
        let decision: Decision;
        try { decision = JSON.parse(text) as Decision; }
        catch { throw new Error('AGENT_DECISION'); }
        if (!decision || !['SEND', 'NEEDS_INPUT', 'CONFIRMED', 'UNAVAILABLE'].includes(decision.action) ||
            !keys.includes(decision.messageKey) ||
            !['name', 'phone', 'email', 'restaurant', 'other', 'none'].includes(decision.field) ||
            typeof decision.message !== 'string' ||
            decision.message.length > 3000 ||
            (decision.restaurantName !== undefined && typeof decision.restaurantName !== 'string') ||
            (decision.restaurantEvidence !== undefined && typeof decision.restaurantEvidence !== 'string') ||
            typeof decision.question !== 'string' || decision.question.length > 500) {
          throw new Error('AGENT_DECISION');
        }
        return decision;
      };
      let d = parseDecision((await generate()).text);
      const missingDetail = d.messageKey.startsWith('details_') ? d.messageKey.slice(8) as 'name' | 'phone' | 'email' : undefined;
      if (d.action === 'SEND' && missingDetail && !this.personal[missingDetail]) {
        this.audit.technical('warn', 'agent.decision_repair', { reason: 'unknown_guest_detail' }, this.sessionId);
        d = parseDecision((await generate('The guest ' + missingDetail + ' is UNKNOWN. ' +
          'The manager introducing themselves does NOT provide the guest details. Return NEEDS_INPUT, field ' +
          missingDetail + ', with a polite message that you are checking with the guest. Do not invent any value.')).text);
      }
      if (d.action === 'NEEDS_INPUT' && d.field === 'none' && !firstContact &&
          this.running && version === this.version && revision === this.revision) {
        this.audit.technical('warn', 'agent.decision_repair', { reason: 'missing_input_field' }, this.sessionId);
        d = parseDecision((await generate(
          'Your previous decision was NEEDS_INPUT with field none. That combination is invalid. ' +
          'Read the latest manager message in the transcript and choose name, phone, email, or other. ' +
          'A manager introducing themselves does not supply the guest name. ' +
          'Return the next decision using the same booking parameters.',
        )).text);
        // A repeated missing field requires owner review, never fabricated data
        // or a fatal shutdown of an otherwise valid booking conversation.
        if (d.action === 'NEEDS_INPUT' && d.field === 'none') d = { ...d, field: 'other' };
      }
      if (d.action === 'CONFIRMED' && !this.waiting && !this.requireOwnerConsent) {
        const explicit = explicitYes(managerText) && !this.conflicts(managerText) &&
          (mayConfirm || /\b(?:booked|reservation is confirmed|booking is confirmed)\b/i.test(managerText));
        if (!explicit || !this.fullSummary(d.message)) {
          d = parseDecision((await generate(explicit && this.booking!.restaurant ?
            'The booking is explicitly confirmed but your final recap is incomplete. Return CONFIRMED with restaurant, ISO date, HH:mm London time and guest count.' :
            'Do not mark this completed. Return SEND with a polite clarification to the manager: ask for the missing restaurant name or explicit confirmation of the original parameters. Do not accept alternatives.')).text);
        }
      }
      if (!this.running || version !== this.version || revision !== this.revision) {
        explanation = { understood: 'Рішення застаріло або роботу зупинено.', decision: 'superseded' };
        return;
      }
      this.ensureFuture();
      this.learnRestaurant(d);
      if (d.action === 'SEND' && d.messageKey.startsWith('details_') && !this.personal[d.messageKey.slice(8) as 'name' | 'phone' | 'email']) {
        throw new Error('AGENT_UNGROUNDED_DETAILS');
      }
      if (d.message && !(await this.review(d.message, d.action))) {
        this.audit.technical('warn', 'agent.reply_rejected', { action: d.action }, this.sessionId);
        // One repair only; no unbounded regeneration or unsafe delivery.
        d = parseDecision((await generate('The proposed reply failed factual/safety review. ' +
          'Generate a truthful customer-facing English reply only. Do not include internal field names or metadata. ' +
          'Never assert unknown facts or accept changed terms.')).text);
        if (!d.message || !(await this.review(d.message, d.action))) throw new Error('AGENT_UNSAFE_REPLY');
      }
      if (!this.running || version !== this.version || revision !== this.revision) return;
      // Recheck structural constraints after a review repair, too.
      this.learnRestaurant(d);
      if (d.action === 'SEND' && d.messageKey.startsWith('details_') && !this.personal[d.messageKey.slice(8) as 'name' | 'phone' | 'email']) throw new Error('AGENT_UNGROUNDED_DETAILS');
      if (this.ownerInput && ['name', 'phone', 'email', 'restaurant'].includes(this.ownerInput.field) &&
        !d.message.includes(this.ownerInput.value)) throw new Error('AGENT_OWNER_INPUT_NOT_DELIVERED');
      explanation = this.explain(d);
      this.journal.push({ source: 'system', text: 'Decision: ' + JSON.stringify(d) });
      if (firstContact && d.action !== 'SEND') throw new Error('AGENT_DECISION');
      if (d.action === 'NEEDS_INPUT') {
        if (d.field === 'none') throw new Error('AGENT_DECISION');
        const repeated = this.waiting === d.field;
        if (d.field === 'other' && /\b(?:deposit|pay|payment|charge|fee|card|credit|allerg\w*|prefer\w*|inside|outside)\b|[£$€]/i.test(managerText)) {
          this.requireOwnerConsent = true;
        }
        this.need(d.field, d.question || 'Потрібне уточнення користувача.');
        if (d.message && !repeated) await this.sendChecked(d.message, version, explanation);
        if (d.message) this.ownerInput = undefined;
        return;
      }
      if (d.action === 'UNAVAILABLE') {
        if (d.message) await this.sendChecked(d.message, version, explanation);
        throw new Error('BOOKING_UNAVAILABLE');
      }
      if (d.action === 'CONFIRMED') {
        if (this.waiting || this.requireOwnerConsent || !explicitYes(managerText) ||
          this.conflicts(managerText) || this.conflicts(d.message) ||
          (!mayConfirm && !/\b(?:booked|reservation is confirmed|booking is confirmed)\b/i.test(managerText)) ||
          !this.fullSummary(d.message)) {
          explanation = { understood: 'Підтвердження не пройшло перевірку всіх параметрів.',
            decision: 'request_owner_verification' };
          this.need('other', 'Немає однозначного підтвердження всіх параметрів. Перевір чат.');
          return;
        }
        this.managerConfirmed = true;
        await this.sendChecked(d.message, version, explanation);
        if (version !== this.version || !this.running) return;
        this.move('COMPLETED');
        incoming?.finish({ ...explanation, state: this.state });
        this.finishPending('booking_completed');
        this.audit.technical('info', 'booking.finished', { outcome: 'COMPLETED' }, this.sessionId);
        this.log('Бронювання підтверджено. Автоматичні відповіді припинено.');
        return;
      }
      if (!d.message.trim()) throw new Error('AGENT_DECISION');
      this.confirmationReady = false;
      if (!this.waiting) this.move(d.messageKey === 'confirm' ? 'CONFIRMING' : 'NEGOTIATING');
      await this.sendChecked(d.message, version, explanation);
      this.ownerInput = undefined;
      if (version === this.version && this.running) {
        this.confirmationReady = d.messageKey === 'confirm' && this.fullSummary(d.message);
      }
    } catch (error) {
      if (error instanceof Error && error.message === 'AGENT_SUPERSEDED') {
        explanation = { understood: 'New input arrived during speech generation.', decision: 'superseded' };
        return;
      }
      if (version === this.version && this.running) {
        const code = errorInfo(error).errorCode;
        if (code === 'GEMINI_UNAVAILABLE' || code === 'GEMINI_NETWORK') {
          this.lastError = String(code);
          this.retryContext = { managerText, mayConfirm };
          incoming?.finish({ understood: 'Gemini тимчасово недоступний; повідомлення збережено.',
            decision: 'await_retry', state: this.state });
          this.audit.technical('warn', 'agent.awaiting_retry', { errorCode: code }, this.sessionId);
          this.log('Gemini тимчасово недоступний після 3 спроб. Контекст збережено. Введи /book, щоб повторити AI-запит, або /stop.');
          return;
        }
        incoming?.finish({
          understood: explanation.understood,
          decision: String(errorInfo(error).errorCode),
          state: 'FAILED',
        });
        this.fail(error);
      }
    } finally {
      incoming?.finish({ ...explanation, state: this.state });
    }
  }

  private explain(d: Decision): Omit<Explanation, 'state'> {
    if (d.action === 'NEEDS_INPUT') return {
      understood: 'Потрібні відсутні дані або уточнення; поле: ' + d.field,
      decision: 'request_owner_input',
    };
    if (d.action === 'UNAVAILABLE') return {
      understood: 'Менеджер відмовив у бронюванні на задані параметри.',
      decision: 'booking_unavailable',
    };
    if (d.action === 'CONFIRMED') return {
      understood: 'Менеджер явно підтвердив попереднє повне зведення.',
      decision: 'complete_booking',
    };
    return {
      understood: d.messageKey === 'confirm' ? 'Потрібне явне підтвердження всіх параметрів.' :
        d.messageKey.startsWith('details_') ? 'Запитано раніше надані персональні дані.' :
        d.messageKey.startsWith('opening') ? 'Користувач запустив запит бронювання.' :
        'Потрібно уточнити доступність початкових параметрів.',
      decision: d.messageKey,
    };
  }

  private async sendChecked(
    text: string, version: number, explanation: Omit<Explanation, 'state'>,
  ): Promise<void> {
    if (version !== this.version || !this.running) return;
    if (this.hasInternalText(text)) throw new Error('AGENT_UNSAFE_REPLY');
    this.ensureFuture();
    const revision = this.revision;
    try { await this.send(text, () => version === this.version && revision === this.revision && this.running); }
    catch (error) {
      if (error instanceof Error && error.message === 'AGENT_SUPERSEDED') throw error;
      this.audit.technical('error', 'telegram.send_failed', errorInfo(error), this.sessionId);
      throw error;
    }
    this.audit.message({
      bookingSessionId: this.sessionId, direction: 'OUT', text, retainText: true,
      messageType: 'TEXT',
    }).finish({ ...explanation, state: this.state });
    // Log completed delivery even if /stop arrived while Telegram was sending.
    this.journal.push({ source: 'assistant', text });
  }
}
