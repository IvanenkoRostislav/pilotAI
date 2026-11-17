import { createInterface } from 'node:readline';
import type { GeminiService } from '../ai/gemini.js';

import { Api, type TelegramClient } from 'teleproto';
import {
  NewMessage,
  type NewMessageEvent,
} from 'teleproto/events';

export async function runMessaging(
  client: TelegramClient,
  targetUsername: string,
  describeError: (error: unknown) => string,
  gemini: GeminiService,
): Promise<void> {
  console.log('Пошук співрозмовника за TARGET_USERNAME...');

const target = await client
  .getEntity('@' + targetUsername)
  .catch((error: unknown) => {
    if (
      error instanceof Error &&
      (
        error.message.startsWith('No user has "') ||
        error.message.startsWith(
          'Cannot find any entity corresponding to ',
        )
      )
    ) {
      throw new Error('TARGET_NOT_FOUND');
    }

    throw error;
  });

console.log('Співрозмовника знайдено.');

  if (!(target instanceof Api.User)) {
    throw new Error('TARGET_NOT_USER');
  }

  if (target.self) {
    throw new Error('TARGET_IS_SELF');
  }

  const targetId = target.id.toString();
  const label = '@' + targetUsername;

  const eventBuilder = new NewMessage({
  incoming: true,
  chats: [target.id],
  fromUsers: [target.id],
});
  console.log('Налаштування фільтра повідомлень...');
  // Перевіряємо налаштування фільтра перед початком роботи.
  await eventBuilder.resolve(client);
  console.log('Фільтр повідомлень готовий.');

  const terminal = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  let stopping = false;
  let pending: Promise<void> = Promise.resolve();
  let queued = 0;

  const shutdown = new AbortController();
  let resolveStop!: () => void;

  const stopped = new Promise<void>((resolve) => {
    resolveStop = resolve;
  });

  function stop(): void {
  if (stopping) return;

  stopping = true;
  shutdown.abort();
  resolveStop();
  }

  // Echo та ручне надсилання виконуються послідовно.
  function enqueue(task: () => Promise<void>): void {
  if (stopping) return;

  if (queued >= 10) {
    console.error(
      'Черга заповнена. Повідомлення пропущено.',
    );
    return;
  }

  queued += 1;

  pending = pending
    .then(async () => {
      if (!stopping) {
        await task();
      }
    })
    .catch((error: unknown) => {
      if (!stopping) {
        console.error(
          'Помилка повідомлення:',
          describeError(error),
        );
      }
    })
    .finally(() => {
      queued -= 1;
    });
}

  async function sendText(text: string): Promise<void> {
    if (!text.trim()) {
      throw new Error('MESSAGE_EMPTY');
    }

    const sent = await client.sendMessage(target, {
      message: text,

      // Порожній список вимикає розбір Markdown:
      // наприклад, **текст** передається буквально.
      formattingEntities: [],
      linkPreview: false,
    });

    console.log(
      '[OUT ' + label + ' #' + sent.id + '] ' +
      JSON.stringify(text),
    );
  }

  function onMessage(event: NewMessageEvent): void {
    const message = event.message;

    if (
      stopping ||
      !event.isPrivate ||
      message.out ||
      event.chatId?.toString() !== targetId ||
      message.senderId?.toString() !== targetId
    ) {
      return;
    }

    const text = message.message;

    // На цьому етапі обробляємо лише текст.
    // Медіа, включно з підписами, пропускаємо.
    if (!text?.trim() || message.media) {
      console.log(
        '[IN ' + label + '] Нетекстове повідомлення пропущено.',
      );
      return;
    }

    console.log(
      '[IN ' + label + ' #' + message.id + '] ' +
      JSON.stringify(text),
    );

    enqueue(async () => {
  const reply = await gemini.generateReply(
    text,
    shutdown.signal,
  );

  if (stopping) return;

  await sendText(reply.text);

  // Зберігаємо лише успішно доставлену пару реплік.
  gemini.rememberExchange(text, reply.content);
});
  }

  function onLine(line: string): void {
    if (line.trim() === '/reset') {
    enqueue(async () => {
      gemini.reset();
      console.log('Контекст діалогу очищено.');
    });
    return;
  }
    if (line.trim() === '/quit') {
      stop();
      return;
    }

    if (line.startsWith('/send ')) {
      enqueue(() => sendText(line.slice(6)));
      return;
    }

    console.log('Команди: /send текст або /quit');
  }

  try {
    client.addEventHandler(onMessage, eventBuilder);

    terminal.on('line', onLine);
    terminal.once('close', stop);
    terminal.on('SIGINT', stop);

    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);

    console.log(
      'Співрозмовник: ' + label + ' (ID ' + targetId + ')',
    );
    console.log(
  'Gemini увімкнено. Вхідний текст отримає відповідь моделі.',
  );
    console.log(
  'Команди: /send текст, /reset або /quit',
  );

    await stopped;
  } finally {
    stopping = true;

    client.removeEventHandler(onMessage, eventBuilder);

    terminal.removeListener('line', onLine);
    terminal.removeListener('SIGINT', stop);
    terminal.removeListener('close', stop);
    terminal.close();

    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);

    // Завершуємо поточне надсилання перед закриттям клієнта.
    // Ще не розпочаті завдання черги будуть пропущені.
    await pending;
  }
}