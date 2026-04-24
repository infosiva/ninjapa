/**
 * NinjaPA — Telegram Bot handlers.
 * Multi-user: every message is isolated by ctx.from.id.
 */
import { Telegraf, Context } from 'telegraf';
import { message } from 'telegraf/filters';
import fs from 'fs';
import { upsertUser, getUser } from './db.js';
import { processMessage } from './ai.js';

const FREE_DAILY_LIMIT = parseInt(process.env.FREE_TASKS_PER_DAY ?? '10');

// Simple in-memory rate limiter (resets each day via process restart or cron)
const dailyUsage = new Map<number, number>();

function isAllowed(userId: number): boolean {
  const adminIds = (process.env.ADMIN_USER_IDS ?? '').split(',').map(s => parseInt(s.trim())).filter(Boolean);
  if (adminIds.includes(userId)) return true;

  const user = getUser(userId);
  if (user?.plan === 'pro') return true;

  const used = dailyUsage.get(userId) ?? 0;
  return used < FREE_DAILY_LIMIT;
}

function incrementUsage(userId: number) {
  dailyUsage.set(userId, (dailyUsage.get(userId) ?? 0) + 1);
}

// Reset daily usage at midnight
import cron from 'node-cron';
cron.schedule('0 0 * * *', () => {
  dailyUsage.clear();
  console.log('[bot] Daily usage reset.');
});

// ── Build the bot ─────────────────────────────────────────────────────────────
export function createBot(token: string) {
  const bot = new Telegraf(token);

  // ── /start ────────────────────────────────────────────────────────────────
  bot.start(async (ctx) => {
    const { id, username, first_name } = ctx.from;
    upsertUser(id, username, first_name);

    await ctx.replyWithMarkdown(
      `👋 Hey ${first_name ?? 'there'}! I'm *NinjaPA* — your personal AI assistant.\n\n` +
      `Here's what I can do for you:\n\n` +
      `📋 *Tasks & Reminders*\n` +
      `_"Remind me to call dentist tomorrow at 3pm"_\n` +
      `_"Add review contracts to my task list"_\n\n` +
      `📝 *Notes*\n` +
      `_"Note: client wants the design in blue"_\n\n` +
      `📄 *Invoices*\n` +
      `_"Invoice John Smith £800 for web development"_\n\n` +
      `✈️ *Flight Alerts*\n` +
      `_"Watch London to Chennai flights under £380"_\n\n` +
      `🥗 *Diet Plan*\n` +
      `_"I'm 38, 78kg, want to lose weight — create a diet plan"_\n\n` +
      `🗺️ *Travel Planning*\n` +
      `_"Plan a 5-day trip to Tokyo, budget £2000"_\n\n` +
      `⏰ *Standup Reminders*\n` +
      `_"Remind me to stand up every 45 minutes 9am to 6pm"_\n\n` +
      `Just talk to me naturally — no commands needed. Let's go! 🥷`
    );
  });

  // ── /help ─────────────────────────────────────────────────────────────────
  bot.help(async (ctx) => {
    await ctx.replyWithMarkdown(
      `*NinjaPA Commands*\n\n` +
      `Just type naturally. Examples:\n\n` +
      `• _"What are my tasks?"_\n` +
      `• _"Mark dentist appointment done"_\n` +
      `• _"Show my notes"_\n` +
      `• _"List my flight watches"_\n` +
      `• _"Show my profile"_\n` +
      `• _"What reminders do I have?"_\n\n` +
      `*/upgrade* — See Pro plan features\n` +
      `*/profile* — View your saved profile\n` +
      `*/tasks* — List pending tasks\n` +
      `*/notes* — List recent notes`
    );
  });

  // ── /tasks shortcut ───────────────────────────────────────────────────────
  bot.command('tasks', async (ctx) => {
    const userId = ctx.from.id;
    upsertUser(userId, ctx.from.username, ctx.from.first_name);
    await handleMessage(ctx, userId, 'List my pending tasks');
  });

  // ── /notes shortcut ───────────────────────────────────────────────────────
  bot.command('notes', async (ctx) => {
    const userId = ctx.from.id;
    upsertUser(userId, ctx.from.username, ctx.from.first_name);
    await handleMessage(ctx, userId, 'List my recent notes');
  });

  // ── /profile ──────────────────────────────────────────────────────────────
  bot.command('profile', async (ctx) => {
    const userId = ctx.from.id;
    upsertUser(userId, ctx.from.username, ctx.from.first_name);
    await handleMessage(ctx, userId, 'Show my profile');
  });

  // ── /upgrade ──────────────────────────────────────────────────────────────
  bot.command('upgrade', async (ctx) => {
    await ctx.replyWithMarkdown(
      `⚡ *NinjaPA Pro — £7.99/month*\n\n` +
      `✅ Unlimited tasks & reminders\n` +
      `✅ Unlimited invoice generation\n` +
      `✅ Up to 10 active flight watches\n` +
      `✅ Unlimited notes\n` +
      `✅ Diet plans + meal reminders\n` +
      `✅ Full travel planning\n` +
      `✅ Priority AI response\n\n` +
      `Free plan: 10 messages/day, 2 invoices/month, 1 flight watch.\n\n` +
      `👉 [Upgrade now](https://ninjapa.app/upgrade) ← coming soon`
    );
  });

  // ── Main message handler ──────────────────────────────────────────────────
  bot.on(message('text'), async (ctx) => {
    const userId = ctx.from.id;
    upsertUser(userId, ctx.from.username, ctx.from.first_name);

    if (!isAllowed(userId)) {
      await ctx.reply(
        '⚡ You\'ve hit your free daily limit (10 messages).\n\n' +
        'Upgrade to Pro for unlimited access: /upgrade'
      );
      return;
    }

    incrementUsage(userId);
    await handleMessage(ctx, userId, ctx.message.text);
  });

  return bot;
}

// ── Shared message handler ────────────────────────────────────────────────────
async function handleMessage(ctx: Context, userId: number, text: string) {
  // Show typing indicator
  await ctx.sendChatAction('typing');

  try {
    const { text: reply, pdfPath } = await processMessage(userId, text);

    // Send PDF if an invoice was generated
    if (pdfPath && fs.existsSync(pdfPath)) {
      await ctx.replyWithDocument({ source: pdfPath }, { caption: '📄 Your invoice is ready.' });
    }

    // Send text response (split if over Telegram's 4096 char limit)
    if (reply) {
      const chunks = splitMessage(reply, 4000);
      for (const chunk of chunks) {
        await ctx.replyWithMarkdown(chunk);
      }
    }
  } catch (err: any) {
    console.error('[bot] Error processing message:', err);
    await ctx.reply('⚡ Something went wrong. Please try again in a moment.');
  }
}

function splitMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let i = 0;
  while (i < text.length) {
    chunks.push(text.slice(i, i + maxLen));
    i += maxLen;
  }
  return chunks;
}

// ── Notify helper (used by scheduler) ────────────────────────────────────────
export function createNotifier(bot: Telegraf) {
  return (userId: number, message: string) => {
    bot.telegram.sendMessage(userId, message, { parse_mode: 'Markdown' }).catch(err => {
      console.error(`[notifier] Failed to send to ${userId}:`, err.message);
    });
  };
}
