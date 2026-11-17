import type { GeminiService } from '../ai/gemini.js';
import { loadBooking, slotIsFuture, type Booking } from './config.js';
import { AGENT_PROMPT } from './prompt.js';

export type State = 'IDLE' | 'NEGOTIATING' | 'NEEDS_INPUT' |
  'CONFIRMING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
type Field = 'restaurant' | 'name' | 'phone' | 'email' | 'other';
export interface Receipt { runId: number; revision: number; mayConfirm: boolean; text: string }
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

  constructor(
    private readonly gemini: GeminiService,
    private readonly send: (text: string) => Promise<void>,
    private readonly describeError: (error: unknown) => string,
    private readonly log: (text: string) => void = console.log,
    private readonly now: () => Date = () => new Date(),
  ) {}

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
    this.state = next;
    this.journal.push({ source: 'system', text: 'State: ' + next });
    this.log('[AGENT] ' + next);
  }

  private fail(error: unknown): void {
    if (!this.running && this.state !== 'IDLE') return;
    this.lastError = this.describeError(error);
    this.confirmationReady = false;
    this.move('FAILED');
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
    this.log(question);
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
    this.abort = new AbortController();
    try {
      this.booking = loadBooking(this.now());
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
        );
      } catch (error) {
        if (version === this.version && this.running) this.fail(error);
      }
      return;
    }

    this.move(this.resume);
    await this.step();
  }

  observe(text: string): Receipt | undefined {
    if (!this.running) return undefined;
    this.journal.push({ source: 'manager', text });
    this.revision += 1;
    return { runId: this.version, revision: this.revision,
      mayConfirm: this.canConfirm, text };
  }

  async receive(receipt: Receipt): Promise<void> {
    if (!this.running || receipt.runId !== this.version ||
        receipt.revision !== this.revision) return;
    if (this.state === 'NEEDS_INPUT') {
      this.log('[AGENT] Повідомлення збережено; очікується введення в консолі.');
      return;
    }
    await this.step(receipt.text, receipt.mayConfirm);
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

  private async step(managerText = '', mayConfirm = false): Promise<void> {
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
      const result = await this.gemini.generateReply(
        'Choose the next booking action.', this.abort.signal, {
          systemInstruction: AGENT_PROMPT,
          contents: [{
            role: 'user', parts: [{ text: JSON.stringify({
              booking: this.booking, personal: this.personal,
              state: this.state, transcript: this.journal,
              firstContact: keys.includes('opening'),
              mayConfirm: mayConfirm && this.canConfirm, menu,
            }) }],
          }],
          responseJsonSchema: schema,
        },
      );
      if (!this.running || version !== this.version || revision !== this.revision) return;
      this.ensureFuture();
      let d: Decision;
      try { d = JSON.parse(result.text) as Decision; }
      catch { throw new Error('AGENT_DECISION'); }
      if (!d || !['SEND', 'NEEDS_INPUT', 'CONFIRMED', 'UNAVAILABLE'].includes(d.action) ||
          ![...keys, 'none'].includes(d.messageKey) ||
          !['name', 'phone', 'email', 'other', 'none'].includes(d.field) ||
          typeof d.message !== 'string' ||
          (d.action === 'SEND' ? d.message !== menu[d.messageKey] : d.message !== '') ||
          typeof d.question !== 'string' || d.question.length > 500) {
        throw new Error('AGENT_DECISION');
      }
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
          this.need('other', 'Немає однозначного підтвердження всіх параметрів. Перевір чат.');
          return;
        }
        this.managerConfirmed = true;
        const b = this.booking!;
        await this.sendChecked('Thank you for confirming. Booking confirmed: ' +
          b.restaurant + ', London, ' + b.date + ', ' + b.time +
          ' (Europe/London), ' + b.guests + ' guests.', version);
        if (version !== this.version || !this.running) return;
        this.move('COMPLETED');
        this.log('Бронювання підтверджено. Автоматичні відповіді припинено.');
        return;
      }
      const message = menu[d.messageKey];
      if (!message) throw new Error('AGENT_DECISION');
      this.confirmationReady = false;
      this.move(d.messageKey === 'confirm' ? 'CONFIRMING' : 'NEGOTIATING');
      await this.sendChecked(d.message, version);
      if (version === this.version && this.running) {
        this.confirmationReady = d.messageKey === 'confirm';
      }
    } catch (error) {
      if (version === this.version && this.running) this.fail(error);
    }
  }

  private async sendChecked(text: string, version: number): Promise<void> {
    if (version !== this.version || !this.running) return;
    this.ensureFuture();
    await this.send(text);
    // Log completed delivery even if /stop arrived while Telegram was sending.
    this.journal.push({ source: 'assistant', text });
  }
}
