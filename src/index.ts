/**
 * NinjaPA — Entry point.
 * Starts the Telegram bot and the reminder scheduler.
 */
import 'dotenv/config';
import { createBot, createNotifier } from './bot.js';
import { startScheduler } from './scheduler.js';

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error('❌ TELEGRAM_BOT_TOKEN is required. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('❌ ANTHROPIC_API_KEY is required.');
  process.exit(1);
}

console.log('🥷 NinjaPA starting...');

const bot = createBot(token);
const notify = createNotifier(bot);

// Start the reminder + flight scheduler
startScheduler(notify);

// Launch the bot (long polling)
bot.launch({
  dropPendingUpdates: true,
}).then(() => {
  console.log('🥷 NinjaPA is live and listening on Telegram.');
});

// Graceful shutdown
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
