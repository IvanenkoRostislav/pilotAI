import { createInterface } from 'node:readline';
import { Api, type TelegramClient } from 'teleproto';
import { NewMessage, type NewMessageEvent } from 'teleproto/events';
import type { GeminiService } from '../ai/gemini.js';
import { BookingAgent } from '../agent/agent.js';

export async function runMessaging(
  client: TelegramClient,
  targetUsername: string,
  describeError: (error: unknown) => string,
  gemini: GeminiService,
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
  const label = '@' + targetUsername;
  const events = new NewMessage({
    incoming: true, chats: [target.id], fromUsers: [target.id],
  });
  await events.resolve(client);
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  let stopping = false;
  let chatEnabled = false;
  let epoch = 0;
  let pending = Promise.resolve();
  let chatAbort = new AbortController();
  let resolveStop!: () => void;
  const stopped = new Promise<void>((resolve) => { resolveStop = resolve; });

  async function sendText(text: string): Promise<void> {
    if (stopping) throw new Error('AGENT_STOPPED');
    if (!text.trim() || text.length > 4000) throw new Error('MESSAGE_EMPTY');
    const sent = await client.sendMessage(target, {
      message: text, formattingEntities: [], linkPreview: false,
    });
    console.log('[OUT ' + label + ' #' + sent.id + '] ' + JSON.stringify(text));
  }

  const agent = new BookingAgent(gemini, sendText, describeError);

  // Serial work queue; manager messages are recorded before they enter it.
  function enqueue(task: () => Promise<void>): void {
    pending = pending.then(async () => {
      if (!stopping) await task();
    }).catch((error: unknown) => {
      if (!stopping) console.error('Помилка:', describeError(error));
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
    const text = message.message;
    if (!text?.trim() || message.media) {
      console.log('[IN ' + label + '] Нетекстове повідомлення пропущено.');
      return;
    }
    console.log('[IN ' + label + ' #' + message.id + '] ' + JSON.stringify(text));

    const receipt = agent.observe(text);
    if (receipt) {
      enqueue(() => agent.receive(receipt));
      return;
    }
    if (!chatEnabled) return;

    const currentEpoch = epoch;
    enqueue(async () => {
      if (!chatEnabled || currentEpoch !== epoch || agent.running) return;
      const reply = await gemini.generateReply(text, chatAbort.signal);
      if (stopping || !chatEnabled || currentEpoch !== epoch || agent.running) return;
      await sendText(reply.text);
      gemini.rememberExchange(text, reply.content);
    });
  }

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
        console.log('Формат: /input restaurant|name|phone|email|other значення');
        return;
      }
      const field = match[1]!;
      const value = match[2]!;
      enqueue(() => agent.input(field, value));
      return;
    }
    if (command === '/chat on' || command === '/chat off') {
      if (agent.running) {
        console.log('Спершу зупини бронювання через /stop.');
        return;
      }
      disableChat();
      chatEnabled = command === '/chat on';
      console.log('Звичайний Gemini-чат: ' + (chatEnabled ? 'ON' : 'OFF'));
      return;
    }
    if (command === '/reset') {
      if (agent.running) {
        console.log('Контекст активного бронювання не очищається. Використай /stop.');
        return;
      }
      enqueue(async () => { gemini.reset(); console.log('Контекст звичайного чату очищено.'); });
      return;
    }
    if (line.startsWith('/send ')) {
      if (agent.running) {
        console.log('Під час бронювання ручне надсилання вимкнено.');
        return;
      }
      const currentEpoch = epoch;
      enqueue(async () => {
        if (!agent.running && currentEpoch === epoch) await sendText(line.slice(6));
      });
      return;
    }
    console.log('/book, /status, /stop, /input поле значення, /chat on|off, /send текст, /reset, /quit');
  }

  try {
    client.addEventHandler(onMessage, events);
    terminal.on('line', onLine);
    terminal.once('close', quit);
    terminal.on('SIGINT', quit);
    process.once('SIGINT', quit);
    process.once('SIGTERM', quit);
    console.log('Співрозмовник: ' + label + ' (ID ' + targetId + ')');
    console.log('IDLE. Автовідповіді вимкнено. /book запускає бронювання; /chat on — звичайний чат.');
    console.log('/status — стан; /stop — зупинити агента; /quit — завершити програму.');
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
  }
}
