/**
 * NinjaPA — Telegram Bot handlers.
 * Multi-user: every message is isolated by ctx.from.id.
 */
import { Telegraf, Context, Markup } from 'telegraf';
import { message } from 'telegraf/filters';
import fs from 'fs';
import { upsertUser, getUser, getDailyUsage, incrementDailyUsage, touchLastActive, listTasks, completeTask, deleteTask, listReminders, cancelReminder, setUserTimezone } from './db.js';
import { processMessage } from './ai.js';
import { cancelScheduledReminder } from './scheduler.js';
import { find as findTimezone } from 'geo-tz';

const FREE_DAILY_LIMIT = parseInt(process.env.FREE_TASKS_PER_DAY ?? '10');

// ── Rate limiting ─────────────────────────────────────────────────────────────
function isAllowed(userId: number): boolean {
  const adminIds = (process.env.ADMIN_USER_IDS ?? '').split(',').map(s => parseInt(s.trim())).filter(Boolean);
  if (adminIds.includes(userId)) return true;
  const user = getUser(userId);
  if (user?.plan === 'pro') return true;
  return getDailyUsage(userId) < FREE_DAILY_LIMIT;
}

// ── Build the bot ─────────────────────────────────────────────────────────────
export function createBot(token: string) {
  const bot = new Telegraf(token);

  // ── /start ────────────────────────────────────────────────────────────────
  bot.start(async (ctx) => {
    const { id, username, first_name } = ctx.from;
    upsertUser(id, username, first_name);

    const locationKeyboard = Markup.keyboard([
      [Markup.button.locationRequest('📍 Share my location (sets timezone automatically)')],
    ]).resize().oneTime();

    await ctx.replyWithMarkdown(
      `👋 Hey ${first_name ?? 'there'}! I'm *NinjaPA* — your personal AI assistant.\n\n` +
      `📋 *Tasks & Reminders* — _"Remind me to call dentist tomorrow 3pm"_\n` +
      `📝 *Notes* — _"Note: client wants the design in blue"_\n` +
      `📄 *Invoices* — _"Invoice John £800 for web dev"_\n` +
      `✈️ *Flight Alerts* — _"Watch LHR to Chennai flights under £380"_\n` +
      `🥗 *Diet Plan* — _"I'm 38, 78kg, want to lose weight"_\n` +
      `🗺️ *Travel* — _"Plan a 5-day Tokyo trip, budget £2000"_\n` +
      `⏰ *Standup* — _"Remind me to stand up every 45 minutes"_\n\n` +
      `Just talk to me naturally — no commands needed.\n\n` +
      `💡 *One quick step:* share your location so reminders fire at the right local time 👇`,
      locationKeyboard
    );
  });

  // ── Location handler: auto-detect timezone ────────────────────────────────
  bot.on(message('location'), async (ctx) => {
    const { latitude, longitude } = ctx.message.location;
    const userId = ctx.from.id;
    upsertUser(userId, ctx.from.username, ctx.from.first_name);

    const zones = findTimezone(latitude, longitude);
    const tz = zones[0];

    if (!tz) {
      await ctx.reply('⚠️ Could not determine timezone from your location. Please type it instead, e.g. "My timezone is Asia/Kolkata".');
      return;
    }

    setUserTimezone(userId, tz);
    touchLastActive(userId);

    const localTime = new Date().toLocaleString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', timeZoneName: 'short' });

    await ctx.replyWithMarkdown(
      `✅ *Timezone set: ${tz}*\n` +
      `🕐 Your local time: ${localTime}\n\n` +
      `Your reminders and daily digest will now fire at the right time for you.\n\n` +
      `Let's go! 🥷`,
      Markup.removeKeyboard()
    );
  });

  // ── /help ─────────────────────────────────────────────────────────────────
  bot.help(async (ctx) => {
    await ctx.replyWithMarkdown(
      `*NinjaPA — Quick Reference*\n\n` +
      `*/tasks* — Task list with tap-to-complete buttons\n` +
      `*/reminders* — Active reminders with cancel buttons\n` +
      `*/notes* — Recent notes\n` +
      `*/profile* — Your saved profile\n` +
      `*/upgrade* — Pro plan details\n\n` +
      `Or just type naturally:\n` +
      `• _"Add task: review contracts by Friday"_\n` +
      `• _"Remind me to drink water every hour 9am-6pm"_\n` +
      `• _"Invoice Sarah £1200 for design work"_\n` +
      `• _"My timezone is Asia/Kolkata"_`
    );
  });

  // ── /tasks — interactive list with inline buttons ─────────────────────────
  bot.command('tasks', async (ctx) => {
    const userId = ctx.from.id;
    upsertUser(userId, ctx.from.username, ctx.from.first_name);
    await sendTaskList(ctx, userId);
  });

  // ── /reminders — interactive list with cancel buttons ────────────────────
  bot.command('reminders', async (ctx) => {
    const userId = ctx.from.id;
    upsertUser(userId, ctx.from.username, ctx.from.first_name);
    await sendReminderList(ctx, userId);
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
      `✅ Morning, noon & evening motivational quotes\n` +
      `✅ Priority AI response\n\n` +
      `Free plan: ${FREE_DAILY_LIMIT} messages/day, 2 invoices/month, 1 flight watch.\n\n` +
      `👉 Coming soon at ninjapa.app/upgrade`
    );
  });

  // ── Inline button: complete task ──────────────────────────────────────────
  bot.action(/^done_(\d+)_(\d+)$/, async (ctx) => {
    const taskId = parseInt(ctx.match[1]);
    const userId = parseInt(ctx.match[2]);
    if (ctx.from.id !== userId) return ctx.answerCbQuery('Not your task!');

    completeTask(userId, taskId);
    await ctx.answerCbQuery('✅ Done!');
    await sendTaskList(ctx, userId, ctx.callbackQuery.message?.message_id);
  });

  // ── Inline button: delete task ────────────────────────────────────────────
  bot.action(/^del_(\d+)_(\d+)$/, async (ctx) => {
    const taskId = parseInt(ctx.match[1]);
    const userId = parseInt(ctx.match[2]);
    if (ctx.from.id !== userId) return ctx.answerCbQuery('Not your task!');

    deleteTask(userId, taskId);
    await ctx.answerCbQuery('🗑️ Deleted');
    await sendTaskList(ctx, userId, ctx.callbackQuery.message?.message_id);
  });

  // ── Inline button: cancel reminder ────────────────────────────────────────
  bot.action(/^cancel_rem_(\d+)_(\d+)$/, async (ctx) => {
    const remId = parseInt(ctx.match[1]);
    const userId = parseInt(ctx.match[2]);
    if (ctx.from.id !== userId) return ctx.answerCbQuery('Not yours!');

    cancelReminder(userId, remId);
    cancelScheduledReminder(remId);
    await ctx.answerCbQuery('🚫 Reminder cancelled');
    await sendReminderList(ctx, userId, ctx.callbackQuery.message?.message_id);
  });

  // ── Main message handler ──────────────────────────────────────────────────
  bot.on(message('text'), async (ctx) => {
    const userId = ctx.from.id;
    upsertUser(userId, ctx.from.username, ctx.from.first_name);

    if (!isAllowed(userId)) {
      await ctx.reply(
        `⚡ You've hit your free daily limit (${FREE_DAILY_LIMIT} messages).\n\n` +
        'Upgrade to Pro for unlimited access: /upgrade'
      );
      return;
    }

    incrementDailyUsage(userId);
    touchLastActive(userId);
    await handleMessage(ctx, userId, ctx.message.text);
  });

  return bot;
}

// ── Task list with inline buttons ────────────────────────────────────────────
async function sendTaskList(ctx: Context, userId: number, editMessageId?: number) {
  const tasks = listTasks(userId, false);

  if (tasks.length === 0) {
    const text = '✅ *No pending tasks!* All clear.';
    if (editMessageId) {
      await (ctx as any).editMessageText(text, { parse_mode: 'Markdown' });
    } else {
      await ctx.replyWithMarkdown(text);
    }
    return;
  }

  const priorityEmoji: Record<string, string> = { high: '🔴', medium: '🟡', low: '🟢' };

  let text = `📋 *Pending Tasks (${tasks.length})*\n\n`;
  const buttons = tasks.slice(0, 8).map(t => {
    const due = t.due_at ? ` · ${new Date(t.due_at).toLocaleDateString('en-GB')}` : '';
    const pr = priorityEmoji[t.priority] ?? '🟡';
    text += `${pr} *${t.title}*${due}\n`;
    return [
      Markup.button.callback(`✅ Done #${t.id}`, `done_${t.id}_${userId}`),
      Markup.button.callback(`🗑️`, `del_${t.id}_${userId}`),
    ];
  });

  const keyboard = Markup.inlineKeyboard(buttons);

  if (editMessageId) {
    await (ctx as any).editMessageText(text, { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup });
  } else {
    await ctx.replyWithMarkdown(text, keyboard);
  }
}

// ── Reminder list with cancel buttons ────────────────────────────────────────
async function sendReminderList(ctx: Context, userId: number, editMessageId?: number) {
  const reminders = listReminders(userId);

  if (reminders.length === 0) {
    const text = '⏰ *No active reminders.*';
    if (editMessageId) {
      await (ctx as any).editMessageText(text, { parse_mode: 'Markdown' });
    } else {
      await ctx.replyWithMarkdown(text);
    }
    return;
  }

  let text = `⏰ *Active Reminders (${reminders.length})*\n\n`;
  const buttons = reminders.slice(0, 8).map(r => {
    const schedule = r.once_at
      ? new Date(r.once_at).toLocaleString('en-GB')
      : (r.cron_expr ?? 'recurring');
    text += `• *${r.message}*\n  _${schedule}_\n\n`;
    return [Markup.button.callback(`🚫 Cancel #${r.id}`, `cancel_rem_${r.id}_${userId}`)];
  });

  const keyboard = Markup.inlineKeyboard(buttons);

  if (editMessageId) {
    await (ctx as any).editMessageText(text, { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup });
  } else {
    await ctx.replyWithMarkdown(text, keyboard);
  }
}

// ── Shared message handler ────────────────────────────────────────────────────
async function handleMessage(ctx: Context, userId: number, text: string) {
  await ctx.sendChatAction('typing');

  try {
    const { text: reply, pdfPath } = await processMessage(userId, text);

    if (pdfPath && fs.existsSync(pdfPath)) {
      await ctx.replyWithDocument({ source: pdfPath }, { caption: '📄 Your invoice is ready.' });
    }

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

