/**
 * NinjaPA — Telegram Bot handlers.
 * Multi-user: every message is isolated by ctx.from.id.
 */
import { Telegraf, Context, Markup } from 'telegraf';
import { message } from 'telegraf/filters';
import fs from 'fs';
import { db, upsertUser, getUser, getDailyUsage, incrementDailyUsage, touchLastActive, listTasks, completeTask, deleteTask, listReminders, cancelReminder, setUserTimezone } from './db.js';
import { processMessage } from './ai.js';
import { cancelScheduledReminder } from './scheduler.js';
import { find as findTimezone } from 'geo-tz';
import { transcribeVoiceMessage } from './voice.js';
import { maybeLogUnsupported, readUnsupportedLog } from './unsupported-log.js';

const FREE_DAILY_LIMIT = parseInt(process.env.FREE_TASKS_PER_DAY ?? '10');
const WARN_AT = FREE_DAILY_LIMIT - 2; // warn 2 messages before the wall

// ── Rate limiting ─────────────────────────────────────────────────────────────
function isAllowed(userId: number): boolean {
  const adminIds = (process.env.ADMIN_USER_IDS ?? '').split(',').map(s => parseInt(s.trim())).filter(Boolean);
  if (adminIds.includes(userId)) return true;
  const user = getUser(userId);
  if (user?.plan === 'pro') return true;
  return getDailyUsage(userId) < FREE_DAILY_LIMIT;
}

function usageWarning(userId: number): string | null {
  const adminIds = (process.env.ADMIN_USER_IDS ?? '').split(',').map(s => parseInt(s.trim())).filter(Boolean);
  if (adminIds.includes(userId)) return null;
  const user = getUser(userId);
  if (user?.plan === 'pro') return null;
  const used = getDailyUsage(userId);
  const remaining = FREE_DAILY_LIMIT - used;
  if (remaining <= 2 && remaining > 0) {
    return `\n\n_⚡ ${remaining} free message${remaining === 1 ? '' : 's'} left today — /upgrade for unlimited_`;
  }
  return null;
}

// ── /today — daily overview ───────────────────────────────────────────────────
async function sendTodayOverview(ctx: Context, userId: number) {
  const now = new Date();
  const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59).getTime();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();

  const allTasks = listTasks(userId, false);
  const overdue = allTasks.filter(t => t.due_at && t.due_at < now.getTime());
  const dueToday = allTasks.filter(t => t.due_at && t.due_at >= todayStart && t.due_at <= todayEnd);
  const noDue = allTasks.filter(t => !t.due_at).slice(0, 3);

  const reminders = listReminders(userId).filter(r => r.once_at && r.once_at >= now.getTime() && r.once_at <= todayEnd);

  const priorityEmoji: Record<string, string> = { high: '🔴', medium: '🟡', low: '🟢' };

  let text = `🗓️ *Your Day — ${now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short' })}*\n\n`;

  if (overdue.length > 0) {
    text += `⚠️ *Overdue (${overdue.length})*\n`;
    overdue.slice(0, 4).forEach(t => {
      const daysAgo = Math.floor((now.getTime() - t.due_at!) / 86400000);
      text += `${priorityEmoji[t.priority] ?? '🟡'} ${t.title} _(${daysAgo}d ago)_\n`;
    });
    text += '\n';
  }

  if (dueToday.length > 0) {
    text += `📌 *Due Today (${dueToday.length})*\n`;
    dueToday.forEach(t => {
      const time = new Date(t.due_at!).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
      text += `${priorityEmoji[t.priority] ?? '🟡'} ${t.title} _@ ${time}_\n`;
    });
    text += '\n';
  }

  if (reminders.length > 0) {
    text += `⏰ *Reminders Today (${reminders.length})*\n`;
    reminders.forEach(r => {
      const time = new Date(r.once_at!).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
      text += `• ${r.message} _@ ${time}_\n`;
    });
    text += '\n';
  }

  if (noDue.length > 0 && overdue.length === 0 && dueToday.length === 0) {
    text += `📋 *Upcoming Tasks*\n`;
    noDue.forEach(t => { text += `${priorityEmoji[t.priority] ?? '🟡'} ${t.title}\n`; });
    text += '\n';
  }

  if (overdue.length === 0 && dueToday.length === 0 && reminders.length === 0) {
    text += `✅ Nothing due today — you're all clear!\n\n`;
  }

  const total = allTasks.length;
  text += `_${total} task${total === 1 ? '' : 's'} total in your list_`;

  const buttons = [];
  if (overdue.length > 0 || dueToday.length > 0) {
    buttons.push([Markup.button.callback('📋 View all tasks', 'show_tasks')]);
  }
  if (reminders.length > 0) {
    buttons.push([Markup.button.callback('⏰ View reminders', 'show_reminders')]);
  }

  const keyboard = buttons.length > 0 ? Markup.inlineKeyboard(buttons) : undefined;
  if (keyboard) {
    await ctx.replyWithMarkdown(text, keyboard);
  } else {
    await ctx.replyWithMarkdown(text);
  }
}

// ── Build the bot ─────────────────────────────────────────────────────────────
export function createBot(token: string) {
  const bot = new Telegraf(token);

  // ── /start ────────────────────────────────────────────────────────────────
  bot.start(async (ctx) => {
    const { id, username, first_name } = ctx.from;
    upsertUser(id, username, first_name);
    const name = first_name ?? 'there';

    // Message 1 — warm welcome + what NinjaPA is
    await ctx.replyWithMarkdown(
      `👋 Hey *${name}!* Welcome to *NinjaPA* — your personal AI assistant.\n\n` +
      `I'm here to make your day easier. Think of me as a smart PA that lives in Telegram — ` +
      `always on, always ready, no app to open.\n\n` +
      `🗣️ *Just talk to me naturally.* You don't need to learn any commands.\n` +
      `Say things like you'd say to a real assistant:\n\n` +
      `_"Remind me to pick up the kids at 3pm"_\n` +
      `_"What's the weather in London tomorrow?"_\n` +
      `_"Add task: send invoice to Sarah by Friday"_\n` +
      `_"Find a handyman near Manchester"_\n\n` +
      `I'll understand and get it done. ✅`
    );

    // Message 2 — simple "think of me as..." framing, not a feature list
    await ctx.replyWithMarkdown(
      `🥷 *Think of me like this:*\n\n` +
      `If you think it — just tell me.\n\n` +
      `Need to remember something? _Tell me._\n` +
      `Need a reminder? _Tell me._\n` +
      `Need to send an invoice? _Tell me._\n` +
      `Want to know the weather or find a tradesperson? _Tell me._\n` +
      `Planning a trip or a diet? _Tell me._\n\n` +
      `I handle tasks, reminders, notes, invoices, flights, weather, local services, diet plans and travel — ` +
      `all from a single chat, by voice or text.\n\n` +
      `No forms. No apps. Just say it. 💬`
    );

    // Message 3 — location setup (the action step)
    const locationKeyboard = Markup.keyboard([
      [Markup.button.locationRequest('📍 Share my location')],
      ['⏭️ Skip for now'],
    ]).resize().oneTime();

    await ctx.reply(
      `📍 One last thing — share your location so reminders fire at exactly the right time for you.\n\n` +
      `(I only use it to detect your timezone — nothing else is stored.)`,
      locationKeyboard
    );
  });

  // ── Skip location button ──────────────────────────────────────────────────
  bot.hears('⏭️ Skip for now', async (ctx) => {
    await ctx.reply(
      `No problem! You can always share it later or type your timezone:\n_"My timezone is Europe/London"_\n\nReady when you are — just type or tap /menu 🥷`,
      Markup.removeKeyboard()
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

  // ── Voice message handler ─────────────────────────────────────────────────
  bot.on(message('voice'), async (ctx) => {
    const userId = ctx.from.id;
    upsertUser(userId, ctx.from.username, ctx.from.first_name);

    if (!isAllowed(userId)) {
      await ctx.reply(`⚡ You've hit your free daily limit (${FREE_DAILY_LIMIT} messages).\n\nUpgrade to Pro for unlimited access: /upgrade`);
      return;
    }

    const groqKey = process.env.GROQ_API_KEY;
    if (!groqKey) {
      await ctx.reply('⚠️ Voice transcription is not configured. Please type your message instead.');
      return;
    }

    incrementDailyUsage(userId);
    touchLastActive(userId);

    // Keep typing indicator alive during transcription + AI processing
    let typingAlive = true;
    const keepTyping = async () => {
      while (typingAlive) {
        await ctx.sendChatAction('typing').catch(() => {});
        await new Promise(r => setTimeout(r, 4000));
      }
    };
    keepTyping();

    try {
      const fileId = ctx.message.voice.file_id;
      const transcript = await transcribeVoiceMessage(bot, fileId);

      if (!transcript) {
        typingAlive = false;
        await ctx.reply("🎤 I couldn't make out that voice note — background noise or too short? Try again or type it.");
        return;
      }

      console.log(`[voice] User ${userId} said: "${transcript}"`);

      // Process as if the user typed the transcript
      const { text: reply, pdfPath } = await processMessage(userId, transcript);
      typingAlive = false;

      // Show transcript + response together
      const warn = usageWarning(userId);
      const combined = `🎤 _"${transcript}"_\n\n${reply}${warn ?? ''}`;

      if (pdfPath && fs.existsSync(pdfPath)) {
        await ctx.replyWithDocument({ source: pdfPath }, { caption: '📄 Your invoice is ready.' });
      }

      const chunks = splitMessage(combined, 4000);
      for (const chunk of chunks) {
        await ctx.replyWithMarkdown(chunk).catch(() => ctx.reply(chunk));
      }
    } catch (err: any) {
      typingAlive = false;
      console.error('[bot] Voice error:', err);
      await ctx.reply('⚡ Voice note failed — try again or just type your message.');
    }
  });

  // ── /help ─────────────────────────────────────────────────────────────────
  bot.help(async (ctx) => {
    await ctx.replyWithMarkdown(
      `*NinjaPA — Quick Reference*\n\n` +
      `*/today* — Daily overview: overdue, due today, reminders\n` +
      `*/menu* — Quick-access buttons for everything\n` +
      `*/tasks* — Task list with tap-to-complete buttons\n` +
      `*/reminders* — Active reminders with snooze & cancel\n` +
      `*/notes* — Recent notes\n` +
      `*/weather* — Current weather + 3-day forecast\n` +
      `*/profile* — Your saved profile\n` +
      `*/upgrade* — Pro plan details\n\n` +
      `Or just type naturally:\n` +
      `• _"Remind me at 3pm to call dentist"_\n` +
      `• _"Add task: review contracts by Friday"_\n` +
      `• _"Invoice Sarah £1200 for design work"_\n` +
      `• _"What's the weather in London?"_\n` +
      `• _"Find a plumber in Manchester"_`
    );
  });

  // ── /today — daily overview ───────────────────────────────────────────────
  bot.command('today', async (ctx) => {
    const userId = ctx.from.id;
    upsertUser(userId, ctx.from.username, ctx.from.first_name);
    await sendTodayOverview(ctx, userId);
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

  // ── /menu — persistent shortcut keyboard ─────────────────────────────────
  bot.command('menu', async (ctx) => {
    const keyboard = Markup.keyboard([
      ['🗓️ Today', '📋 My tasks'],
      ['⏰ My reminders', '📝 My notes'],
      ['🌤️ Weather', '📄 Invoices'],
      ['👤 My profile', '❓ Help'],
    ]).resize();
    await ctx.reply('What would you like to do?', keyboard);
  });

  // Handle menu keyboard button taps
  bot.hears('🗓️ Today', async (ctx) => {
    const userId = ctx.from.id;
    upsertUser(userId, ctx.from.username, ctx.from.first_name);
    await sendTodayOverview(ctx, userId);
  });
  bot.hears('📋 My tasks', async (ctx) => {
    const userId = ctx.from.id;
    upsertUser(userId, ctx.from.username, ctx.from.first_name);
    await sendTaskList(ctx, userId);
  });
  bot.hears('⏰ My reminders', async (ctx) => {
    const userId = ctx.from.id;
    upsertUser(userId, ctx.from.username, ctx.from.first_name);
    await sendReminderList(ctx, userId);
  });
  bot.hears('🌤️ Weather', async (ctx) => {
    const userId = ctx.from.id;
    upsertUser(userId, ctx.from.username, ctx.from.first_name);
    const user = getUser(userId);
    const profile = JSON.parse(user?.profile ?? '{}');
    const loc = profile.location ?? profile.city ?? profile.address?.split(',')[0];
    if (loc) {
      if (!isAllowed(userId)) { await ctx.reply('Daily limit reached. /upgrade for unlimited.'); return; }
      incrementDailyUsage(userId); touchLastActive(userId);
      await handleMessage(ctx, userId, `Weather in ${loc}`);
    } else {
      await ctx.reply('Which city? e.g. "Weather in London"');
    }
  });
  bot.hears('📝 My notes', async (ctx) => {
    const userId = ctx.from.id;
    upsertUser(userId, ctx.from.username, ctx.from.first_name);
    if (!isAllowed(userId)) { await ctx.reply('Daily limit reached. /upgrade for unlimited.'); return; }
    incrementDailyUsage(userId); touchLastActive(userId);
    await handleMessage(ctx, userId, 'List my recent notes');
  });
  bot.hears('📄 Invoices', async (ctx) => {
    const userId = ctx.from.id;
    upsertUser(userId, ctx.from.username, ctx.from.first_name);
    if (!isAllowed(userId)) { await ctx.reply('Daily limit reached. /upgrade for unlimited.'); return; }
    incrementDailyUsage(userId); touchLastActive(userId);
    await handleMessage(ctx, userId, 'List my invoices');
  });
  bot.hears('✈️ Flight watches', async (ctx) => {
    const userId = ctx.from.id;
    upsertUser(userId, ctx.from.username, ctx.from.first_name);
    if (!isAllowed(userId)) { await ctx.reply('Daily limit reached. /upgrade for unlimited.'); return; }
    incrementDailyUsage(userId); touchLastActive(userId);
    await handleMessage(ctx, userId, 'List my flight watches');
  });
  bot.hears('👤 My profile', async (ctx) => {
    const userId = ctx.from.id;
    upsertUser(userId, ctx.from.username, ctx.from.first_name);
    if (!isAllowed(userId)) { await ctx.reply('Daily limit reached. /upgrade for unlimited.'); return; }
    incrementDailyUsage(userId); touchLastActive(userId);
    await handleMessage(ctx, userId, 'Show my profile');
  });
  bot.hears('❓ Help', async (ctx) => {
    await ctx.replyWithMarkdown(
      `*NinjaPA — Quick Reference*\n\n` +
      `*/menu* — Show the quick-access menu\n` +
      `*/tasks* — Task list with tap-to-complete buttons\n` +
      `*/reminders* — Active reminders with cancel buttons\n` +
      `*/notes* — Recent notes\n` +
      `*/weather* — Current weather + 3-day forecast\n` +
      `*/profile* — Your saved profile\n` +
      `*/upgrade* — Pro plan details\n\n` +
      `Or just type naturally:\n` +
      `• _"Remind me at 3pm to call dentist"_\n` +
      `• _"Add task: review contracts by Friday"_\n` +
      `• _"What's the weather in London?"_\n` +
      `• _"Find a plumber in Manchester"_\n` +
      `• _"Invoice Sarah £1200 for design work"_`
    );
  });

  // ── /weather ──────────────────────────────────────────────────────────────
  bot.command('weather', async (ctx) => {
    const userId = ctx.from.id;
    upsertUser(userId, ctx.from.username, ctx.from.first_name);
    const args = ctx.message.text.split(' ').slice(1).join(' ').trim();
    const location = args || (() => {
      const user = getUser(userId);
      const profile = JSON.parse(user?.profile ?? '{}');
      return profile.location ?? profile.city ?? profile.address?.split(',')[0];
    })();
    if (!location) {
      await ctx.reply('Please specify a location: /weather London  or save your location in your profile first.');
      return;
    }
    await handleMessage(ctx, userId, `What's the weather in ${location}?`);
  });

  // ── /gaps — admin only: show unsupported requests log ────────────────────
  bot.command('gaps', async (ctx) => {
    const adminIds = (process.env.ADMIN_USER_IDS ?? '').split(',').map(s => parseInt(s.trim())).filter(Boolean);
    if (!adminIds.includes(ctx.from.id)) {
      await ctx.reply("Sorry, I don't recognise that command. Try /help to see what I can do.");
      return;
    }

    const entries = readUnsupportedLog(15);
    if (entries.length === 0) {
      await ctx.reply('✅ No unsupported requests logged yet.');
      return;
    }

    let msg = `🔍 *Recent unsupported requests (${entries.length})*\n\n`;
    entries.slice(0, 10).forEach((e, i) => {
      const date = new Date(e.ts).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
      msg += `${i + 1}. _${date}_ · \`${e.userMessage.slice(0, 80)}\`\n`;
    });
    msg += `\n_Review these to decide what to build next._`;

    await ctx.replyWithMarkdown(msg);
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
      `Free plan: ${FREE_DAILY_LIMIT} messages/day, 2 invoices/month, 1 flight watch.`,
      Markup.inlineKeyboard([
        [Markup.button.url('⚡ Upgrade to Pro', 'https://ninjapa.app/upgrade')],
      ])
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

  // ── Inline button: snooze reminder 1 hour ────────────────────────────────
  bot.action(/^snooze_rem_(\d+)_(\d+)$/, async (ctx) => {
    const remId = parseInt(ctx.match[1]);
    const userId = parseInt(ctx.match[2]);
    if (ctx.from.id !== userId) return ctx.answerCbQuery('Not yours!');

    const rem = db.prepare('SELECT * FROM reminders WHERE id = ? AND user_id = ?').get(remId, userId) as any;
    if (!rem) { await ctx.answerCbQuery('Reminder not found'); return; }

    const newTime = (rem.once_at ?? Date.now()) + 3600000;
    db.prepare('UPDATE reminders SET once_at = ? WHERE id = ?').run(newTime, remId);
    cancelScheduledReminder(remId);

    const newTimeStr = new Date(newTime).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    await ctx.answerCbQuery(`⏱️ Snoozed to ${newTimeStr}`);
    await sendReminderList(ctx, userId, ctx.callbackQuery.message?.message_id);
  });

  // ── Inline button shortcuts from today/other views ────────────────────────
  bot.action('show_tasks', async (ctx) => {
    await ctx.answerCbQuery();
    await sendTaskList(ctx, ctx.from.id);
  });

  bot.action('show_reminders', async (ctx) => {
    await ctx.answerCbQuery();
    await sendReminderList(ctx, ctx.from.id);
  });

  bot.action('show_today', async (ctx) => {
    await ctx.answerCbQuery();
    await sendTodayOverview(ctx, ctx.from.id);
  });

  bot.action('show_notes_quick', async (ctx) => {
    await ctx.answerCbQuery();
    const userId = ctx.from.id;
    upsertUser(userId, ctx.from.username, ctx.from.first_name);
    await handleMessage(ctx, userId, 'List my recent notes');
  });

  // ── Main message handler ──────────────────────────────────────────────────
  bot.on(message('text'), async (ctx) => {
    const userId = ctx.from.id;
    upsertUser(userId, ctx.from.username, ctx.from.first_name);

    if (!isAllowed(userId)) {
      await ctx.reply(
        `⚡ You've hit your free daily limit (${FREE_DAILY_LIMIT} messages).\n\n` +
        `Upgrade to Pro for unlimited: /upgrade`,
        Markup.inlineKeyboard([
          [Markup.button.callback('⚡ View Pro plan', 'show_upgrade')],
        ])
      );
      return;
    }

    incrementDailyUsage(userId);
    touchLastActive(userId);
    await handleMessage(ctx, userId, ctx.message.text);
  });

  // ── Inline button: show upgrade ───────────────────────────────────────────
  bot.action('show_upgrade', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.replyWithMarkdown(
      `⚡ *NinjaPA Pro — £7.99/month*\n\n` +
      `✅ Unlimited messages\n` +
      `✅ Unlimited invoices\n` +
      `✅ Up to 10 flight watches\n` +
      `✅ Priority AI response`,
      Markup.inlineKeyboard([
        [Markup.button.url('⚡ Upgrade to Pro', 'https://ninjapa.app/upgrade')],
      ])
    );
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
  const visible = tasks.slice(0, 8);
  const hidden = tasks.length - visible.length;
  const buttons = visible.map(t => {
    const due = t.due_at ? ` · ${new Date(t.due_at).toLocaleDateString('en-GB')}` : '';
    const pr = priorityEmoji[t.priority] ?? '🟡';
    text += `${pr} *${t.title}*${due}\n`;
    return [
      Markup.button.callback(`✅ Done #${t.id}`, `done_${t.id}_${userId}`),
      Markup.button.callback(`🗑️`, `del_${t.id}_${userId}`),
    ];
  });
  if (hidden > 0) text += `\n_+ ${hidden} more — say "list all tasks" to see everything_\n`;

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
  const visible = reminders.slice(0, 8);
  const hidden = reminders.length - visible.length;
  const buttons = visible.map(r => {
    const schedule = r.once_at
      ? new Date(r.once_at).toLocaleString('en-GB')
      : (r.cron_expr ?? 'recurring');
    text += `• *${r.message}*\n  _${schedule}_\n\n`;
    const row = [Markup.button.callback(`🚫 Cancel #${r.id}`, `cancel_rem_${r.id}_${userId}`)];
    if (r.once_at && r.once_at > Date.now()) {
      row.unshift(Markup.button.callback(`⏱️ Snooze 1h`, `snooze_rem_${r.id}_${userId}`));
    }
    return row;
  });
  if (hidden > 0) text += `_+ ${hidden} more — say "list all reminders" to see everything_\n`;

  const keyboard = Markup.inlineKeyboard(buttons);

  if (editMessageId) {
    await (ctx as any).editMessageText(text, { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup });
  } else {
    await ctx.replyWithMarkdown(text, keyboard);
  }
}

// ── Context-aware quick reply buttons ────────────────────────────────────────
function quickReplyButtons(userText: string, aiReply: string, userId: number) {
  const lower = userText.toLowerCase();
  const replyLower = aiReply.toLowerCase();

  const createdTask = replyLower.includes('task') && (replyLower.includes('added') || replyLower.includes('created') || replyLower.includes('saved'));
  const createdReminder = replyLower.includes('reminder') && (replyLower.includes('set') || replyLower.includes('added') || replyLower.includes("i'll remind"));
  const createdNote = replyLower.includes('note') && (replyLower.includes('saved') || replyLower.includes('noted'));

  const buttons: ReturnType<typeof Markup.button.callback>[][] = [];

  if (createdTask) {
    buttons.push([
      Markup.button.callback('📋 View tasks', 'show_tasks'),
      Markup.button.callback('🗓️ Today', 'show_today'),
    ]);
  } else if (createdReminder) {
    buttons.push([
      Markup.button.callback('⏰ View reminders', 'show_reminders'),
      Markup.button.callback('🗓️ Today', 'show_today'),
    ]);
  } else if (createdNote) {
    buttons.push([Markup.button.callback('📝 View notes', 'show_notes_quick')]);
  }

  return buttons.length > 0 ? Markup.inlineKeyboard(buttons) : null;
}

// ── Shared message handler ────────────────────────────────────────────────────
async function handleMessage(ctx: Context, userId: number, text: string) {
  // Keep typing indicator alive during the entire AI round-trip (can take 5-15s with tool calls)
  let typingAlive = true;
  const keepTyping = async () => {
    while (typingAlive) {
      await ctx.sendChatAction('typing').catch(() => {});
      await new Promise(r => setTimeout(r, 4000)); // Telegram typing lasts ~5s, refresh every 4s
    }
  };
  keepTyping();

  try {
    const { text: reply, pdfPath } = await processMessage(userId, text);
    typingAlive = false;

    // Silently log if the AI couldn't do something — for future feature decisions
    maybeLogUnsupported(userId, text, reply);

    if (pdfPath && fs.existsSync(pdfPath)) {
      await ctx.replyWithDocument({ source: pdfPath }, { caption: '📄 Your invoice is ready.' });
    }

    if (reply) {
      const warn = usageWarning(userId);
      const fullText = reply + (warn ?? '');
      const chunks = splitMessage(fullText, 4000);

      // Add context-aware buttons to the last chunk only
      const keyboard = quickReplyButtons(text, reply, userId);

      for (let i = 0; i < chunks.length; i++) {
        const isLast = i === chunks.length - 1;
        if (isLast && keyboard) {
          await ctx.replyWithMarkdown(chunks[i], keyboard).catch(() => ctx.reply(chunks[i]));
        } else {
          await ctx.replyWithMarkdown(chunks[i]).catch(() => ctx.reply(chunks[i]));
        }
      }
    }
  } catch (err: any) {
    typingAlive = false;
    console.error('[bot] Error processing message:', err);
    await ctx.reply('⚡ Something went wrong — please try again. If it keeps failing, try rephrasing your message.');
  }
}

function splitMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  const lines = text.split('\n');
  let current = '';
  for (const line of lines) {
    const candidate = current ? current + '\n' + line : line;
    if (candidate.length > maxLen) {
      if (current) chunks.push(current);
      // Line itself longer than maxLen — hard split
      if (line.length > maxLen) {
        let start = 0;
        while (start < line.length) {
          chunks.push(line.slice(start, start + maxLen));
          start += maxLen;
        }
        current = '';
      } else {
        current = line;
      }
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
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

