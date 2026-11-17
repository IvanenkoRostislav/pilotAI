import { loadConfig } from './config/env.js';
import {
    checkTelegramConnection,
    describeError,
} from './modules/telegram/client.js';

async function main(): Promise<void> {
    const config = loadConfig();

    await checkTelegramConnection(config);
}

main().catch((error: unknown) => {
    console.error('Помилка:', describeError(error));
    process.exitCode = 1;
});