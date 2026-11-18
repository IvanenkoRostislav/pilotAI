import { appendFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Redactor } from './redact.js';

export interface Explanation {
  understood: string;
  decision: string;
  state: string;
}
interface Message {
  bookingSessionId: string | null;
  direction: 'IN' | 'OUT';
  text: string;
  // Only code-validated booking phrases may opt in; arbitrary text is omitted.
  trustedText?: boolean;
  retainText?: boolean;
  messageType?: 'TEXT' | 'MEDIA';
}
export interface MessageLog {
  finish(explanation: Explanation): void;
}
interface Options {
  directory?: string;
  console?: boolean;
  files?: boolean;
  color?: boolean;
  output?: (line: string) => void;
  now?: () => Date;
}
type Level = 'info' | 'warn' | 'error';
const colors: Record<string, string> = {
  info: '\u001b[36m', warn: '\u001b[33m', error: '\u001b[31m',
  IN: '\u001b[35m', OUT: '\u001b[32m',
};

export function errorInfo(error: unknown): Record<string, unknown> {
  const value = error as { name?: unknown; message?: unknown; code?: unknown; status?: unknown } | null;
  const code = typeof value?.message === 'string' &&
    /^(?:GEMINI|BOOKING|AGENT|CONFIG|SESSION|MESSAGE|VOICE)_[A-Z0-9_]+$/.test(value.message)
    ? value.message : 'UNEXPECTED_ERROR';
  return {
    errorCode: code,
    ...(typeof value?.status === 'number' && value.status >= 100 && value.status <= 599
      ? { status: value.status } : {}),
    ...(typeof value?.code === 'string' && /^E[A-Z]{2,20}$/.test(value.code)
      ? { systemCode: value.code } : {}),
  };
}

export class Logger {
  private readonly redactor = new Redactor();
  private readonly pending = new Set<(explanation: Explanation) => void>();
  private readonly directory: string;
  private readonly clock: () => Date;
  private readonly output: (line: string) => void;
  private diskWarning = false;

  constructor(private readonly options: Options = {}) {
    this.directory = resolve(options.directory ?? 'logs');
    this.clock = options.now ?? (() => new Date());
    this.output = options.output ?? ((line) => { process.stdout.write(line + '\n'); });
  }

  newBookingId(): string { return randomUUID(); }
  rememberPrivate(value: string): void { this.redactor.remember(value); }

  notice = (message: string): void => {
    this.technical('info', 'console.notice', { message });
  };

  technical(
    level: Level, event: string, data: Record<string, unknown> = {},
    bookingSessionId: string | null = null,
  ): void {
    const timestamp = this.clock().toISOString();
    this.write('technical', {
      timestamp, level, event: this.redactor.text(event),
      bookingSessionId: this.sessionId(bookingSessionId),
      data: this.redactor.data(data),
    }, timestamp, level);
  }

  message(message: Message): MessageLog {
    const timestamp = this.clock().toISOString();
    let finished = false;
    const finish = (explanation: Explanation): void => {
      if (finished) return;
      finished = true;
      this.pending.delete(finish);
      this.write('agent', {
        timestamp, event: 'conversation.message',
        bookingSessionId: this.sessionId(message.bookingSessionId),
        direction: message.direction,
        sender: message.direction === 'IN' ? 'manager' : 'agent',
        messageType: message.messageType ?? 'TEXT',
        text: message.retainText ? this.redactor.text(message.text) :
          this.redactor.conversation(message.text, message.trustedText === true),
        understood: this.redactor.text(explanation.understood),
        decision: this.redactor.text(explanation.decision),
        state: ['IDLE', 'NEGOTIATING', 'NEEDS_INPUT', 'CONFIRMING', 'COMPLETED', 'FAILED', 'CANCELLED'].includes(explanation.state)
          ? explanation.state : 'UNKNOWN',
      }, timestamp, message.direction);
    };
    this.pending.add(finish);
    return { finish };
  }

  // Finish outstanding rows once; used when the app exits or work is cancelled.
  flush(explanation: Explanation): void {
    for (const finish of [...this.pending]) finish(explanation);
  }

  private sessionId(value: string | null): string | null {
    return value && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
      ? value : null;
  }

  private write(channel: 'technical' | 'agent', record: object, timestamp: string, color: string): void {
    const line = JSON.stringify(record);
    if (this.options.files !== false) {
      try {
        mkdirSync(this.directory, { recursive: true, mode: 0o700 });
        appendFileSync(resolve(this.directory, channel + '-' + timestamp.slice(0, 10) + '.jsonl'),
          line + '\n', { encoding: 'utf8', mode: 0o600 });
      } catch {
        if (!this.diskWarning) {
          this.diskWarning = true;
          this.emit(JSON.stringify({
            timestamp, level: 'error', event: 'logger.write_failed',
            data: { message: 'File logging unavailable; application continues with console logging.' },
          }), 'error');
        }
      }
    }
    this.emit(line, color);
  }

  private emit(line: string, color: string): void {
    if (this.options.console === false) return;
    const useColor = this.options.color ?? (Boolean(process.stdout.isTTY) && !('NO_COLOR' in process.env));
    try { this.output(useColor ? (colors[color] ?? colors.info) + line + '\u001b[0m' : line); }
    catch { /* A failed log sink must not interrupt a booking. */ }
  }
}

export const logger = new Logger();
