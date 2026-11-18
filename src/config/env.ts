import dotenv from 'dotenv';


export function loadConfig() {
  const result = dotenv.config({ quiet: true });

  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;

    if (code !== 'ENOENT') {
      throw new Error('CONFIG_ENV_FILE');
    }
  }

  const apiIdText = process.env.TELEGRAM_API_ID?.trim() ?? '';
  const apiHash = process.env.TELEGRAM_API_HASH?.trim() ?? '';
  const apiId = Number(apiIdText);

  if (
    !/^\d+$/.test(apiIdText) ||
    !Number.isSafeInteger(apiId) ||
    apiId <= 0 ||
    apiId > 2_147_483_647
  ) {
    throw new Error('CONFIG_API_ID');
  }

  if (!/^[a-f0-9]{32}$/i.test(apiHash)) {
    throw new Error('CONFIG_API_HASH');
  }

  const targetUsername = (process.env.TARGET_USERNAME ?? '')
    .trim()
    .replace(/^@/, '');

  if (!/^[a-z][a-z0-9_]{3,31}$/i.test(targetUsername)) {
    throw new Error('CONFIG_TARGET_USERNAME');
  }

  const geminiApiKey = process.env.GEMINI_API_KEY?.trim() ?? '';
const geminiModel = process.env.GEMINI_MODEL?.trim() ?? '';

if (!geminiApiKey) {
  throw new Error('CONFIG_GEMINI_API_KEY');
}

if (!geminiModel) {
  throw new Error('CONFIG_GEMINI_MODEL');
}

return {
  apiId,
  apiHash,
  targetUsername,
  geminiApiKey,
  geminiModel,
  fallbackModel: process.env.GEMINI_FALLBACK_MODEL?.trim() || 'gemini-3.5-flash-lite',
};

}
