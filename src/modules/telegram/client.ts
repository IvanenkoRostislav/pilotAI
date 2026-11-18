import { logger as appLogger } from '../logger/logger.js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';

import { TelegramClient, errors } from 'teleproto';
import { Logger, LogLevel } from 'teleproto/extensions/Logger';
import { StringSession } from 'teleproto/sessions';
import { runMessaging } from './messanging.js';

import { createGeminiService } from '../ai/gemini.js';
import { createVoiceService } from '../ai/voice.js';
import { createOpusConverter } from '../audio/opus.js';

const sessionDirectory = resolve('.sessions');
const sessionFile = resolve(sessionDirectory, 'telegram.session');

interface TelegramConfig {
    apiId: number;
    apiHash: string;
    targetUsername: string;
    geminiApiKey: string;
    geminiModel: string;
    transcriptionModel?: string;
    ttsModel?: string;
    ttsVoice?: string;
    ffmpegPath?: string;
}

async function loadSession(): Promise<string> {
    try {
        return (await readFile(sessionFile, 'utf8')).trim();
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return '';
        }

        throw new Error('SESSION_READ');
    }
}

async function saveSession(value: string): Promise<void> {
    if (!value) {
        throw new Error('SESSION_EMPTY');
    }

    try {
        await mkdir(sessionDirectory, {
        recursive: true,
        mode: 0o700,
        });

        await writeFile(sessionFile, value, {
        encoding: 'utf8',
        mode: 0o600,
        });
    } catch {
        throw new Error('SESSION_SAVE');
    }
}

export async function checkTelegramConnection(
    config: TelegramConfig,
): Promise<void> {
    const savedSession = await loadSession();

    let session: StringSession;

    try {
    session = new StringSession(savedSession);
    } catch {
    throw new Error('SESSION_INVALID');
    }

  // Прибираємо внутрішні логи бібліотеки:
  // секрети та повні об'єкти помилок не потраплятимуть у наш вивід.
    const logger = new Logger();
    logger.setLevel(LogLevel.NONE);

    const client = new TelegramClient(
    session,
    config.apiId,
    config.apiHash,
    {
        connectionRetries: 3,
        requestRetries: 2,
        floodSleepThreshold: 0,
        baseLogger: logger,
    },
    );

    let muted = false;

    const terminalOutput = new Writable({
    write(chunk, _encoding, callback) {
        if (!muted) {
        process.stdout.write(chunk);
        }

        callback();
    },
    });

    const readline = createInterface({
    input: process.stdin,
    output: terminalOutput,
    terminal: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    });

    async function ask(
    question: string,
    hidden = false,
    ): Promise<string> {
    if (hidden) {
        process.stdout.write(question);
        muted = true;
    }

    try {
        const answer = await readline.question(hidden ? '' : question);

      // Пароль не обрізаємо: пробіли можуть бути його частиною.
      return hidden ? answer : answer.trim();
    } finally {
      if (hidden) {
        muted = false;
        process.stdout.write('\n');
      }
    }
  }

  try {
    appLogger.notice(
      savedSession
        ? 'Підключення зі збереженою сесією...'
        : 'Перша авторизація в Telegram...',
    );

    await client.start({
      phoneNumber: () => ask('Номер телефону у форматі +380...: '),

      phoneCode: (_isCodeViaApp, info) => {
        if (info) {
          appLogger.notice(`Спосіб доставки коду: ${info.type}`);
        }

        return ask('Код входу: ', true);
      },

      password: () => ask('Пароль двоетапної перевірки: ', true),

      emailAddress: () => ask('Email для входу: '),

      // У Teleproto 1.233.0 callback приймає код як рядок.
      emailVerification: () => ask('Код із email: ', true),

      // Цей етап підтримує вхід лише в наявний акаунт.
      firstAndLastNames: async () => {
        throw new Error('ACCOUNT_NOT_REGISTERED');
      },

      onError: (error) => {
        // Явно завершуємо невдалу спробу авторизації.
        // Не запускаємо нескінченний цикл введення чи повторів.
        throw error;
      },
    });

    await saveSession(session.save());

    await client.getMe();
    appLogger.technical('info', 'telegram.connected', { authorized: true });
    appLogger.notice('Сесію збережено локально.');
    readline.close();

    // Ця функція працює до /quit або Ctrl+C.

    const gemini = createGeminiService({
    apiKey: config.geminiApiKey,
    model: config.geminiModel,
    });

    await runMessaging(
    client,
    config.targetUsername,
    describeError,
    gemini,
    appLogger,
    { service: createVoiceService({ apiKey: config.geminiApiKey,
        ...(config.transcriptionModel ? { transcriptionModel: config.transcriptionModel } : {}),
        ...(config.ttsModel ? { ttsModel: config.ttsModel } : {}),
        ...(config.ttsVoice ? { voice: config.ttsVoice } : {}) }),
      convert: createOpusConverter(config.ffmpegPath) },
    );


  } finally {
    readline.close();

    // Закриваємо з'єднання, не відкликаючи авторизацію.
    await client.destroy();
  }
}

export function describeError(error: unknown): string {
  const messages: Record<string, string> = {
    VOICE_API: 'Помилка Gemini Audio. Перевір доступ до моделей та квоти.',
    VOICE_RATE_LIMIT: 'Вичерпано квоту Gemini Audio; пауза 60 секунд.',
    VOICE_FFMPEG: 'Не вдалося конвертувати аудіо. Перевір FFmpeg.',
    BOOKING_CONFIG: 'Некоректні BOOKING_RESTAURANT, BOOKING_TIME або BOOKING_GUESTS.',
    BOOKING_PAST: 'Час бронювання за Europe/London уже настав або минув. Нову дату автоматично не обрано.',
    BOOKING_UNAVAILABLE: 'Менеджер відмовив у бронюванні на задані параметри.',
    AGENT_TRANSITION: 'Недозволений перехід стану агента.',
    AGENT_DECISION: 'Gemini повернув некоректне або недозволене рішення. Автовідповіді зупинено.',
    AGENT_TURN_LIMIT: 'Досягнуто ліміту 40 рішень. Повний контекст збережено в RAM.',
    AGENT_STOPPED: 'Програму зупинено.',
    CONFIG_ENV_FILE: 'Не вдалося прочитати файл .env.',
    CONFIG_API_ID: 'Перевір TELEGRAM_API_ID: потрібне додатне ціле число.',
    CONFIG_API_HASH: 'Перевір TELEGRAM_API_HASH: потрібні 32 hex-символи.',
    SESSION_READ: 'Не вдалося прочитати локальний файл сесії.',
    SESSION_SAVE: 'Не вдалося зберегти сесію. Перевір права на .sessions/.',
    SESSION_EMPTY: 'Telegram не повернув сесію для збереження.',
    SESSION_INVALID: 'Файл сесії пошкоджений. Перейменуй його та увійди знову.',
    ACCOUNT_NOT_REGISTERED: 'Для цього номера немає наявного акаунта Telegram.',
    API_ID_INVALID: 'Telegram відхилив API ID або API Hash.',
    PHONE_NUMBER_INVALID: 'Неправильний формат номера телефону.',
    PHONE_NUMBER_BANNED: 'Telegram заблокував цей номер телефону.',
    PHONE_CODE_INVALID: 'Неправильний код входу. Запусти програму ще раз.',
    PHONE_CODE_EXPIRED: 'Код входу прострочений. Запусти програму ще раз.',
    PHONE_CODE_EMPTY: 'Код входу не може бути порожнім.',
    PASSWORD_HASH_INVALID: 'Неправильний пароль двоетапної перевірки.',
    SESSION_REVOKED: 'Сесію відкликано. Перейменуй файл сесії та увійди знову.',
    SESSION_EXPIRED: 'Сесія прострочена. Перейменуй файл сесії та увійди знову.',
    AUTH_KEY_UNREGISTERED: 'Сесія більше не авторизована. Потрібен повторний вхід.',
    AUTH_KEY_DUPLICATED: 'Сесію скасовано через одночасне використання. Увійди знову.',
    USER_DEACTIVATED: 'Акаунт Telegram деактивовано.',
    USER_DEACTIVATED_BAN: 'Акаунт Telegram заблоковано.',
    AUTH_USER_CANCEL: 'Авторизацію скасовано.',
    CONFIG_TARGET_USERNAME:
    'Вкажи TARGET_USERNAME як username без посилання t.me.',

    TARGET_NOT_USER:
    'TARGET_USERNAME має належати користувачу, а не групі чи каналу.',

    TARGET_IS_SELF:
    'Для перевірки потрібен інший акаунт, а не власний username.',

    MESSAGE_EMPTY:
    'Не можна надіслати порожнє повідомлення.',

    USERNAME_INVALID:
    'Некоректний Telegram username.',

    USERNAME_NOT_OCCUPIED:
    'Користувача з таким username не знайдено.',

    USER_PRIVACY_RESTRICTED:
    'Налаштування приватності не дозволяють виконати дію.',

    USER_IS_BLOCKED:
    'Telegram повідомляє про блокування співрозмовника.',

    YOU_BLOCKED_USER:
    'Цей співрозмовник заблокований у твоєму акаунті.',

    CHAT_WRITE_FORBIDDEN:
    'Telegram заборонив надсилання в цей чат.',

    PEER_FLOOD:
    'Telegram обмежив надсилання. Зупини агента і повтори пізніше.',

    MESSAGE_TOO_LONG:
    'Повідомлення перевищує дозволену Telegram довжину.',
    TARGET_NOT_FOUND:
    'Не знайдено користувача за TARGET_USERNAME. Перевір його username в Telegram.',
    CONFIG_GEMINI_API_KEY:
    'Заповни GEMINI_API_KEY у .env.',

    CONFIG_GEMINI_MODEL:
    'Заповни GEMINI_MODEL у .env.',

    GEMINI_INPUT:
    'Gemini: текст має містити від 1 до 4096 символів.',

    GEMINI_RATE_LIMIT:
    'Gemini: перевищено ліміт або квоту (429). Пауза 60 с; перевір квоти в AI Studio.',

    GEMINI_COOLDOWN:
    'Gemini: триває пауза після 429. Це повідомлення не оброблено.',

    GEMINI_AUTH:
    'Gemini: ключ недійсний або не має потрібного доступу (401/403).',

    GEMINI_MODEL:
    'Gemini: модель не знайдена або недоступна (404). Перевір GEMINI_MODEL.',

    GEMINI_BILLING:
    'Gemini: перевір баланс і налаштування оплати (402).',

    GEMINI_BAD_REQUEST:
    'Gemini: некоректний запит, ключ або параметри моделі (400).',

    GEMINI_UNAVAILABLE:
    'Gemini: сервіс тимчасово недоступний (408 або 5xx).',

    GEMINI_API:
    'Gemini: помилка API. Деталі запиту приховано.',

    GEMINI_NETWORK:
    'Gemini: мережева помилка або таймаут.',

    GEMINI_BLOCKED:
    'Gemini не повернув завершеної дозволеної текстової відповіді.',

    GEMINI_TRUNCATED:
    'Gemini: відповідь обірвана через ліміт токенів; її не надіслано.',

    GEMINI_EMPTY:
    'Gemini повернув порожню відповідь.',

    GEMINI_REPLY_TOO_LONG:
    'Gemini: відповідь завелика для одного Telegram-повідомлення.',

    GEMINI_CANCELLED:
    'Запит Gemini скасовано.',
  };

  if (error instanceof errors.FloodWaitError) {
    return `Telegram обмежив спроби. Повтори через ${error.seconds} с.`;
  }

  if (error instanceof errors.RPCError) {
    return messages[error.errorMessage] ??
      'Telegram повернув помилку API. Повні дані помилки приховано.';
  }

  if (error instanceof Error && messages[error.message]) {
    return messages[error.message]!;
  }

  return 'Не вдалося завершити перевірку. Перевір мережу та доступ до Telegram.';
}
