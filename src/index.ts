import { loadConfig } from './config/env.js';
import { logger, errorInfo } from './modules/logger/logger.js';
import {
    checkTelegramConnection,
    describeError,
} from './modules/telegram/client.js';

async function main(): Promise<void> {
    const config = loadConfig();

    await checkTelegramConnection(config);
}

main().catch((error: unknown) => {
    logger.technical('error', 'app.failed', errorInfo(error));
    logger.notice('Помилка: ' + describeError(error));
    process.exitCode = 1;
});
