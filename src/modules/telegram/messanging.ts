import { logger, Logger, errorInfo } from '../logger/logger.js';
import { createInterface } from 'node:readline';
import { Api, type TelegramClient } from 'teleproto';
import { NewMessage, type NewMessageEvent } from 'teleproto/events';
import type { GeminiService } from '../ai/gemini.js';
import { BookingAgent, type Arrival } from '../agent/agent.js';

export async function runMessaging(
  client: TelegramClient,
  targetUsername: string,
  describeError: (error: unknown) => string,
  gemini: GeminiService,
  audit: Logger = logger,
): Promise<void> {
  const target = await client.getEntity('@' + targetUsername).catch((error: unknown) => {
    if (error instanceof Error &&
        (error.message.startsWith('No user has "') ||
         error.message.startsWith('Cannot find any entity corresponding to '))) {
      throw new Error('TARGET_NOT_FOUND');
    }
    throw error;
  });
  if (!(target instanceof Api.User)) throw new Error('TARGET_NOT_USER');
  if (target.self) throw new Error('TARGET_IS_SELF');

  const targetId = target.id.toString();
  const events = new NewMessage({
    incoming: true, chats: [target.id], fromUsers: [target.id],
  });
  await events.resolve(client);
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  let stopping = false;
  let chatEnabled = false;
  let epoch = 0;
  let pending = Promise.resolve();
  const seenMessages = new Set<number>();
  let chatAbort = new AbortController();
  let resolveStop!: () => void;
  const stopped = new Promise<void>((resolve) => { resolveStop = resolve; });

  async function sendText(text: string, source: 'manual' | 'chat' | 'agent' | 'notice' = 'manual'): Promise<void> {
    if (stopping) throw new Error('AGENT_STOPPED');
    if (!text.trim() || text.length > 4000) throw new Error('MESSAGE_EMPTY');
    try {
      await client.sendMessage(target, {
        message: text, formattingEntities: [], linkPreview: false,
      });
    } catch (error) {
      if (source !== 'agent') audit.technical('error', 'telegram.send_failed', errorInfo(error), agent.sessionId);
      throw error;
    }
    if (source !== 'agent') audit.message({
      bookingSessionId: agent.sessionId, direction: 'OUT', text, retainText: true,
    }).finish({
      understood: source === 'notice' ? 'Повідомлено, що підтримується лише текст.' :
        source === 'chat' ? 'Відповідь звичайного чату надіслано.' : 'Користувач дав ручну команду надсилання.',
      decision: source === 'notice' ? 'request_text' : source === 'chat' ? 'chat_reply' : 'manual_send',
      state: agent.currentState,
    });
  }

  async function reply(text: string, source: 'chat' | 'agent', isCurrent: () => boolean = () => true): Promise<'text'> {
    if (!isCurrent()) throw new Error('AGENT_SUPERSEDED');
    await sendText(text, source);
    return 'text';
  }

  const agent = new BookingAgent(gemini, (text, isCurrent) => reply(text, 'agent', isCurrent), describeError, audit.notice, undefined, audit);

  // Serial work queue; manager messages are recorded before they enter it.
  function enqueue(task: () => Promise<void>): void {
    pending = pending.then(async () => {
      if (!stopping) await task();
    }).catch((error: unknown) => {
      if (!stopping) {
        audit.technical('error', 'telegram.task_failed', errorInfo(error), agent.sessionId);
        audit.notice('Помилка: ' + describeError(error));
      }
    });
  }

  function disableChat(): void {
    epoch += 1;
    chatEnabled = false;
    chatAbort.abort();
    chatAbort = new AbortController();
  }

  function quit(): void {
    if (stopping) return;
    disableChat();
    agent.cancel();
    stopping = true;
    resolveStop();
  }

  function onMessage(event: NewMessageEvent): void {
    const message = event.message;
    if (stopping || !event.isPrivate || message.out ||
        event.chatId?.toString() !== targetId ||
        message.senderId?.toString() !== targetId) return;
    if (typeof message.id === 'number') {
      if (seenMessages.has(message.id)) return;
      seenMessages.add(message.id);
      if (seenMessages.size > 2000) seenMessages.delete(seenMessages.values().next().value!);
    }
    const attachment = Boolean(message.media &&
      (!Api.MessageMediaWebPage || !(message.media instanceof Api.MessageMediaWebPage)));
    if (!message.message?.trim() || attachment) {
      audit.message({ bookingSessionId: agent.sessionId, direction: 'IN',
        text: '[MEDIA OR EMPTY MESSAGE]', trustedText: true, messageType: attachment ? 'MEDIA' : 'TEXT',
      }).finish({ understood: 'Нетекстове або порожнє повідомлення.',
        decision: attachment ? 'request_text' : 'ignored_empty', state: agent.currentState });
      if (attachment && (agent.running || chatEnabled)) {
        const currentEpoch = epoch;
        enqueue(async () => {
          if (!stopping && currentEpoch === epoch && (agent.running || chatEnabled)) {
            await sendText('Please send your message as text. I can only read and reply to text messages.', 'notice');
          }
        });
      }
      return;
    }
    const arrival = agent.reserveIncoming();
    acceptText(message.message, arrival);
  }

  function acceptText(text: string, arrival?: Arrival): void {
    const receipt = agent.observe(text, arrival);
    if (receipt) {
      enqueue(() => agent.receive(receipt));
      return;
    }
    const incoming = audit.message({ bookingSessionId: agent.sessionId, direction: 'IN', text, retainText: true });
    if (!chatEnabled) {
      incoming.finish({ understood: 'Автоматичні відповіді вимкнено.',
        decision: 'ignored', state: agent.currentState });
      return;
    }
    const currentEpoch = epoch;
    enqueue(async () => {
      let decision = 'cancelled';
      let understood = 'Обробку звичайного чату зупинено.';
      try {
        if (!chatEnabled || currentEpoch !== epoch || agent.running) return;
        const reply = await gemini.generateReply(text, chatAbort.signal);
        if (stopping || !chatEnabled || currentEpoch !== epoch || agent.running) return;
        await sendReply(reply.text);
        gemini.rememberExchange(text, reply.content);
        decision = 'chat_reply';
        understood = 'Повідомлення оброблено звичайним чатом; відповідь доставлено.';
      } catch (error) {
        decision = String(errorInfo(error).errorCode);
        understood = 'Відповідь звичайного чату не доставлено.';
        throw error;
      } finally {
        incoming.finish({ understood, decision, state: agent.currentState });
      }
    });
  }

  async function sendReply(text: string): Promise<void> { await reply(text, 'chat'); }

  function onLine(line: string): void {
    const command = line.trim();
    if (command === '/quit') { quit(); return; }
    if (command === '/stop') {
      disableChat();
      agent.cancel();
      return;
    }
    if (command === '/status') { agent.status(); return; }
    if (command === '/book') {
      if (agent.running) {
        enqueue(() => agent.start());
        return;
      }
      disableChat();
      const currentEpoch = epoch;
      enqueue(async () => {
        if (currentEpoch === epoch) await agent.start();
      });
      return;
    }
    if (command.startsWith('/input ')) {
      const match = /^\/input\s+(restaurant|name|phone|email|other)\s+(.+)$/.exec(command);
      if (!match) {
        audit.notice('Формат: /input restaurant|name|phone|email|other значення');
        return;
      }
      const field = match[1]!;
      const value = match[2]!;
      enqueue(() => agent.input(field, value));
      return;
    }
    if (command === '/chat on' || command === '/chat off') {
      if (agent.running) {
        audit.notice('Спершу зупини бронювання через /stop.');
        return;
      }
      disableChat();
      chatEnabled = command === '/chat on';
      audit.notice('Звичайний Gemini-чат: ' + (chatEnabled ? 'ON' : 'OFF'));
      return;
    }
    if (command === '/reset') {
      if (agent.running) {
        audit.notice('Контекст активного бронювання не очищається. Використай /stop.');
        return;
      }
      enqueue(async () => { gemini.reset(); audit.notice('Контекст звичайного чату очищено.'); });
      return;
    }
    if (line.startsWith('/send ')) {
      if (agent.running) {
        audit.notice('Під час бронювання ручне надсилання вимкнено.');
        return;
      }
      const currentEpoch = epoch;
      enqueue(async () => {
        if (!agent.running && currentEpoch === epoch) await sendText(line.slice(6));
      });
      return;
    }
    audit.notice('/book, /status, /stop, /input поле значення, /chat on|off, /send текст, /reset, /quit');
  }

  try {
    client.addEventHandler(onMessage, events);
    terminal.on('line', onLine);
    terminal.once('close', quit);
    terminal.on('SIGINT', quit);
    process.once('SIGINT', quit);
    process.once('SIGTERM', quit);
    audit.technical('info', 'telegram.ready', { targetConfigured: true });
    audit.notice('IDLE. Автовідповіді вимкнено. /book запускає бронювання; /chat on — звичайний чат.');
    audit.notice('Підтримуються лише текстові повідомлення.');
    audit.notice('/status — стан; /stop — зупинити агента; /quit — завершити програму.');
    await stopped;
  } finally {
    if (!stopping) quit();
    client.removeEventHandler(onMessage, events);
    terminal.removeListener('line', onLine);
    terminal.removeListener('close', quit);
    terminal.removeListener('SIGINT', quit);
    terminal.close();
    process.removeListener('SIGINT', quit);
    process.removeListener('SIGTERM', quit);
    await pending;
    audit.flush({ understood: 'Програму завершено.', decision: 'shutdown', state: agent.currentState });
    audit.technical('info', 'app.stopped', {}, agent.sessionId);
  }
}
