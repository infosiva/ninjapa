/**
 * NinjaPA — Entry point.
 * Starts the Telegram bot and the reminder scheduler.
 */
import 'dotenv/config';
import { createBot, createNotifier } from './bot.js';
import { startScheduler } from './scheduler.js';
import { createBatcher } from './batcher.js';
import { setNotifier } from './ai.js';

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error('❌ TELEGRAM_BOT_TOKEN is required. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

// Check at least one AI provider is configured
const hasAnyProvider = !!(
  process.env.GROQ_API_KEY ||
  process.env.GEMINI_API_KEY ||
  process.env.CEREBRAS_API_KEY ||
  process.env.NVIDIA_API_KEY ||
  process.env.ANTHROPIC_API_KEY
);
if (!hasAnyProvider) {
  console.error('❌ No AI provider configured. Set at least one of: GROQ_API_KEY, GEMINI_API_KEY, CEREBRAS_API_KEY, NVIDIA_API_KEY, ANTHROPIC_API_KEY');
  process.exit(1);
}
const configured = ['GROQ_API_KEY','GEMINI_API_KEY','CEREBRAS_API_KEY','NVIDIA_API_KEY','ANTHROPIC_API_KEY']
  .filter(k => !!process.env[k]).map(k => k.replace('_API_KEY',''));
console.log(`🔑 AI providers: ${configured.join(' → ')}`);


console.log('🥷 NinjaPA starting...');

const bot = createBot(token);
const rawNotify = createNotifier(bot);

// Wrap with batcher — batches rapid-fire messages into one, enforces 3s gap
const notify = createBatcher(rawNotify);

// Inject notifier into AI layer so tools can alert admin (quota warnings etc.)
setNotifier(notify);

// Start the reminder + flight + digest scheduler
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
