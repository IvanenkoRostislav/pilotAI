import { logger, Logger, errorInfo, type MessageLog, type Explanation } from '../logger/logger.js';
import type { GeminiService } from '../ai/gemini.js';
import { loadBooking, slotIsFuture, type Booking } from './config.js';
import { AGENT_PROMPT } from './prompt.js';

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
  field: 'name' | 'phone' | 'email' | 'other' | 'none';
  question: string;
};
const active = new Set<State>(['NEGOTIATING', 'NEEDS_INPUT', 'CONFIRMING']);
const transitions: Record<State, State[]> = {
  IDLE: ['NEGOTIATING', 'FAILED'],
  NEGOTIATING: ['NEEDS_INPUT', 'CONFIRMING', 'FAILED', 'CANCELLED'],
  NEEDS_INPUT: ['NEGOTIATING', 'CONFIRMING', 'FAILED', 'CANCELLED'],
  CONFIRMING: ['NEGOTIATING', 'NEEDS_INPUT', 'COMPLETED', 'FAILED', 'CANCELLED'],
  COMPLETED: [], FAILED: [], CANCELLED: [],
};

// Accept only an unqualified acknowledgement to our preceding full summary.
function explicitYes(text: string): boolean {
  return /^(?:yes[,!\.\s]*)?(?:confirmed|booked|booking confirmed|reservation confirmed|your booking is confirmed)[.!\s]*$/i.test(text.trim()) ||
    /^yes[.!\s]*$/i.test(text.trim());
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

  constructor(
    private readonly gemini: GeminiService,
    private readonly send: (text: string, isCurrent?: () => boolean) => Promise<void>,
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
    // Model questions can echo personal data; only a safe field description is logged.
    this.log(field === 'other' ? 'Потрібне уточнення. Перевір останнє повідомлення менеджера в Telegram.' :
      'Потрібне поле: ' + field);
    this.audit.technical('info', 'agent.input_required', { field }, this.sessionId);
    this.log('Введи /input ' + field + ' значення або /stop.');
    if (field === 'other') {
      this.log('Дата, час і кількість гостей заблоковані. Для зміни: /stop, нова конфігурація і перезапуск.');
    }
  }

  async start(): Promise<void> {
    if (this.state !== 'IDLE') {
      this.log('У цьому запуску вже є спроба бронювання. Використай /status.');
      return;
    }
    this.version += 1;
    this.bookingSessionId = this.audit.newBookingId();
    this.audit.technical('info', 'booking.started', {}, this.sessionId);
    this.abort = new AbortController();
    try {
      this.booking = loadBooking(this.now());
      this.audit.rememberPrivate(this.booking.restaurant);
      this.ensureFuture();
      this.move('NEGOTIATING');
      this.journal.push({ source: 'owner', text: '/book: ' + JSON.stringify(this.booking) });
      if (!this.booking.restaurant) {
        this.need('restaurant', 'Укажи назву ресторану в Лондоні, якому відповідає TARGET_USERNAME.');
        return;
      }
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

    if (field === 'name' || field === 'phone' || field === 'email') {
      // The manager requested this field and the owner supplied it explicitly.
      // Deliver it before the model can advance to booking confirmation.
      this.confirmationReady = false;
      this.move('NEGOTIATING');
      const version = this.version;
      try {
        await this.sendChecked(
          'The ' + field + ' for the booking is ' + value + '. Thank you.',
          version,
          { understood: 'Менеджер запросив поле ' + field + '; користувач надав значення.',
            decision: 'provide_' + field },
        );
      } catch (error) {
        if (version === this.version && this.running && !(error instanceof Error && error.message === 'AGENT_SUPERSEDED')) this.fail(error);
      }
      return;
    }

    this.move(this.resume);
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
      bookingSessionId: this.sessionId, direction: 'IN', text,
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
      if (this.state === 'NEEDS_INPUT' && this.waiting === 'other') {
        // A later manager message may resolve an incomplete/ambiguous reply.
        // Re-evaluate it with the full transcript; never treat it as owner consent.
        this.audit.technical('info', 'agent.input_reassessed', { field: 'other' }, this.sessionId);
        this.waiting = undefined;
        this.move(this.resume);
      }
      if (this.state === 'NEEDS_INPUT') {
        receipt.audit.finish({ understood: 'Повідомлення збережено; потрібне введення користувача.',
          decision: 'wait_for_owner', state: this.state });
        this.log('[AGENT] Повідомлення збережено; очікується введення в консолі.');
        return;
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

  private menu(): Record<string, string> {
    const b = this.booking!;
    const details = b.restaurant + ', London, ' + b.date +
      ' at ' + b.time + ' (Europe/London), ' + b.guests + ' guests';
    const first = !this.journal.some((entry) => entry.source === 'assistant');
    if (first) return {
      opening: 'Good afternoon. May I enquire about a table for ' + b.guests +
        ' at ' + b.restaurant + ' in London on ' + b.date +
        ' at ' + b.time + ' London time, please?',
      opening_polite: 'Hello. I would like to book a table for ' + b.guests +
        ' at ' + b.restaurant + ', London, on ' + b.date +
        ' at ' + b.time + ' London time. Would that be possible, please?',
    };
    const menu: Record<string, string> = {
      repeat: 'We would still like the following: ' + details +
        '. Is that exact booking available, please?',
      confirm: 'Could you please confirm this exact booking: ' + details +
        '? Please reply "Confirmed" only if all these details are correct.',
    };
    for (const field of ['name', 'phone', 'email'] as const) {
      if (this.personal[field]) {
        menu['details_' + field] = 'The ' + field + ' for the booking is ' +
          this.personal[field] + '. Thank you.';
      }
    }
    return menu;
  }

  private async step(managerText = '', mayConfirm = false, incoming?: MessageLog): Promise<void> {
    let explanation = { understood: 'Повідомлення не вдалося обробити.', decision: 'processing_failed' };
    const version = this.version;
    const revision = this.revision;
    try {
      this.ensureFuture();
      if (++this.turns > 40) throw new Error('AGENT_TURN_LIMIT');
      const menu = this.menu();
      const keys = Object.keys(menu);
      const schema = {
        type: 'object', additionalProperties: false,
        properties: {
          action: { type: 'string', enum: ['SEND', 'NEEDS_INPUT', 'CONFIRMED', 'UNAVAILABLE'] },
          messageKey: { type: 'string', enum: [...keys, 'none'] },
          message: { type: 'string', enum: [...Object.values(menu), ''] },
          field: { type: 'string', enum: ['name', 'phone', 'email', 'other', 'none'] },
          question: { type: 'string' },
        },
        required: ['action', 'messageKey', 'message', 'field', 'question'],
      };
      const generate = (feedback = '') => this.gemini.generateReply(
        'Choose the next booking action.', this.abort.signal, {
          systemInstruction: AGENT_PROMPT,
          contents: [{
            role: 'user', parts: [{ text: JSON.stringify({
              booking: this.booking, personal: this.personal,
              state: this.state, transcript: this.journal,
              firstContact: keys.includes('opening'),
              mayConfirm: mayConfirm && this.canConfirm, menu,
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
            ![...keys, 'none'].includes(decision.messageKey) ||
            !['name', 'phone', 'email', 'other', 'none'].includes(decision.field) ||
            typeof decision.message !== 'string' ||
            (decision.action === 'SEND' ? decision.message !== menu[decision.messageKey] : decision.message !== '') ||
            typeof decision.question !== 'string' || decision.question.length > 500) {
          throw new Error('AGENT_DECISION');
        }
        return decision;
      };
      let d = parseDecision((await generate()).text);
      if (d.action === 'NEEDS_INPUT' && d.field === 'none' && !keys.includes('opening') &&
          this.running && version === this.version && revision === this.revision) {
        this.audit.technical('warn', 'agent.decision_repair', { reason: 'missing_input_field' }, this.sessionId);
        d = parseDecision((await generate(
          'Your previous decision was NEEDS_INPUT with field none. That combination is invalid. ' +
          'Read the latest manager message in the transcript and choose name, phone, email, or other. ' +
          'A manager introducing themselves does not supply the guest name. ' +
          'Return the next decision using the same booking parameters and message menu.',
        )).text);
        // A repeated missing field requires owner review, never fabricated data
        // or a fatal shutdown of an otherwise valid booking conversation.
        if (d.action === 'NEEDS_INPUT' && d.field === 'none') d = { ...d, field: 'other' };
      }
      if (!this.running || version !== this.version || revision !== this.revision) {
        explanation = { understood: 'Рішення застаріло або роботу зупинено.', decision: 'superseded' };
        return;
      }
      this.ensureFuture();
      explanation = this.explain(d);
      this.journal.push({ source: 'system', text: 'Decision: ' + JSON.stringify(d) });
      if (keys.includes('opening') && d.action !== 'SEND') throw new Error('AGENT_DECISION');
      if (d.action === 'NEEDS_INPUT') {
        if (d.field === 'none') throw new Error('AGENT_DECISION');
        this.need(d.field, d.question || 'Потрібне уточнення користувача.');
        return;
      }
      if (d.action === 'UNAVAILABLE') throw new Error('BOOKING_UNAVAILABLE');
      if (d.action === 'CONFIRMED') {
        if (!mayConfirm || !this.canConfirm || !explicitYes(managerText)) {
          explanation = { understood: 'Підтвердження не пройшло перевірку всіх параметрів.',
            decision: 'request_owner_verification' };
          this.need('other', 'Немає однозначного підтвердження всіх параметрів. Перевір чат.');
          return;
        }
        this.managerConfirmed = true;
        const b = this.booking!;
        await this.sendChecked('Thank you for confirming. Booking confirmed: ' +
          b.restaurant + ', London, ' + b.date + ', ' + b.time +
          ' (Europe/London), ' + b.guests + ' guests.', version, explanation);
        if (version !== this.version || !this.running) return;
        this.move('COMPLETED');
        incoming?.finish({ ...explanation, state: this.state });
        this.finishPending('booking_completed');
        this.audit.technical('info', 'booking.finished', { outcome: 'COMPLETED' }, this.sessionId);
        this.log('Бронювання підтверджено. Автоматичні відповіді припинено.');
        return;
      }
      const message = menu[d.messageKey];
      if (!message) throw new Error('AGENT_DECISION');
      this.confirmationReady = false;
      this.move(d.messageKey === 'confirm' ? 'CONFIRMING' : 'NEGOTIATING');
      await this.sendChecked(d.message, version, explanation);
      if (version === this.version && this.running) {
        this.confirmationReady = d.messageKey === 'confirm';
      }
    } catch (error) {
      if (error instanceof Error && error.message === 'AGENT_SUPERSEDED') {
        explanation = { understood: 'New input arrived during speech generation.', decision: 'superseded' };
        return;
      }
      if (version === this.version && this.running) {
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
    this.ensureFuture();
    const revision = this.revision;
    try { await this.send(text, () => version === this.version && revision === this.revision && this.running); }
    catch (error) {
      if (error instanceof Error && error.message === 'AGENT_SUPERSEDED') throw error;
      this.audit.technical('error', 'telegram.send_failed', errorInfo(error), this.sessionId);
      throw error;
    }
    this.audit.message({
      bookingSessionId: this.sessionId, direction: 'OUT', text, trustedText: true,
    }).finish({ ...explanation, state: this.state });
    // Log completed delivery even if /stop arrived while Telegram was sending.
    this.journal.push({ source: 'assistant', text });
  }
}
