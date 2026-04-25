/**
 * NinjaPA — Daily Digest System
 *
 * Runs on a 30-min heartbeat. For each user it checks their local time
 * and sends the right message at the right moment:
 *
 *   8:00 am  → Morning digest (tasks, overdue, reminders, flights)
 *   5:00 pm  → Evening check-in (how was your day?)
 *   Sun 6pm  → Weekly review (completed, invoiced, pending)
 *   Inactive → Re-engagement nudge after 3 days silence
 */

import {
  getAllUsers, getTasksDueToday, getOverdueTasks, listTasks,
  listReminders, listFlightWatches, getCompletedThisWeek,
  getInvoicesTotalThisMonth, getUsersInactiveForDays,
  markDigestSent, markWeeklyReviewSent,
} from './db.js';

type NotifyFn = (userId: number, message: string) => void;

// ── Timezone helpers ──────────────────────────────────────────────────────────
function localHour(tz: string): number {
  const h = parseInt(new Date().toLocaleString('en-US', { timeZone: tz, hour: 'numeric', hour12: false }));
  return h === 24 ? 0 : h;
}

function localDate(tz: string): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: tz }); // YYYY-MM-DD
}

function localDayOfWeek(tz: string): number {
  return parseInt(new Date().toLocaleString('en-US', { timeZone: tz, weekday: 'numeric' as any }))
    || new Date(new Date().toLocaleString('en-US', { timeZone: tz })).getDay();
}

function greetingFor(tz: string): string {
  const h = localHour(tz);
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

// ── Digest already sent today? ────────────────────────────────────────────────
function digestSentToday(user: any): boolean {
  if (!user.last_digest_at) return false;
  const tz = user.timezone ?? 'Europe/London';
  const sentDate = new Date(user.last_digest_at).toLocaleDateString('en-CA', { timeZone: tz });
  return sentDate === localDate(tz);
}

function weeklyReviewSentThisWeek(user: any): boolean {
  if (!user.last_weekly_review_at) return false;
  const daysSince = (Date.now() - new Date(user.last_weekly_review_at).getTime()) / 864e5;
  return daysSince < 6;
}

// ── Priority emoji ────────────────────────────────────────────────────────────
const P: Record<string, string> = { high: '🔴', medium: '🟡', low: '🟢' };

// ── Morning Digest ────────────────────────────────────────────────────────────
function buildMorningDigest(user: any): string {
  const tz = user.timezone ?? 'Europe/London';
  const today = localDate(tz);
  const name = user.first_name ?? 'there';

  const dueToday   = getTasksDueToday(user.id, today);
  const overdue    = getOverdueTasks(user.id, today);
  const allPending = listTasks(user.id, false);
  const reminders  = listReminders(user.id);
  const flights    = listFlightWatches(user.id);
  const invoices   = getInvoicesTotalThisMonth(user.id);

  let msg = `🌅 *Good morning, ${name}!*\n`;
  msg += `_${new Date().toLocaleDateString('en-GB', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long' })}_\n`;
  msg += `─────────────────\n\n`;

  // Tasks due today
  if (dueToday.length > 0) {
    msg += `📋 *Due today (${dueToday.length})*\n`;
    dueToday.slice(0, 4).forEach(t => {
      msg += `  ${P[t.priority] ?? '🟡'} ${t.title}\n`;
    });
    if (dueToday.length > 4) msg += `  _+ ${dueToday.length - 4} more_\n`;
    msg += '\n';
  }

  // Overdue
  if (overdue.length > 0) {
    msg += `⚠️ *Overdue (${overdue.length})*\n`;
    overdue.slice(0, 3).forEach(t => {
      const daysAgo = Math.floor((Date.now() - new Date(t.due_at).getTime()) / 864e5);
      msg += `  • ${t.title} _(${daysAgo}d ago)_\n`;
    });
    msg += '\n';
  }

  // All pending (if nothing due today and nothing overdue, show a summary)
  if (dueToday.length === 0 && overdue.length === 0) {
    if (allPending.length > 0) {
      msg += `📋 *${allPending.length} pending task${allPending.length > 1 ? 's' : ''}*\n`;
      allPending.slice(0, 3).forEach(t => {
        msg += `  ${P[t.priority] ?? '🟡'} ${t.title}\n`;
      });
      msg += '\n';
    } else {
      msg += `✅ *No pending tasks — clean slate!*\n\n`;
    }
  }

  // Reminders
  if (reminders.length > 0) {
    msg += `⏰ *${reminders.length} active reminder${reminders.length > 1 ? 's' : ''}*\n\n`;
  }

  // Flights
  if (flights.length > 0) {
    msg += `✈️ *Flight watches*\n`;
    flights.forEach(f => {
      const price = f.last_price ? `£${f.last_price}` : 'checking...';
      const arrow = f.last_price && f.last_price <= f.max_price ? '✅ target hit!' : `target £${f.max_price}`;
      msg += `  ${f.origin}→${f.destination}: ${price} · ${arrow}\n`;
    });
    msg += '\n';
  }

  // Invoices this month
  if (invoices.count > 0) {
    msg += `📄 *This month:* ${invoices.count} invoice${invoices.count > 1 ? 's' : ''} · £${invoices.total.toLocaleString()}\n\n`;
  }

  // Closing line
  const closers = [
    'Make today count 💪',
    'You\'ve got this 🎯',
    'One task at a time 🥷',
    'Stay focused, stay sharp ⚡',
    'Let\'s make it a great one 🚀',
  ];
  msg += `_${closers[new Date().getDay() % closers.length]}_\n\n`;
  msg += `💬 Just type to get things done.`;

  return msg;
}

// ── Evening Check-in ──────────────────────────────────────────────────────────
function buildEveningCheckin(user: any): string {
  const tz = user.timezone ?? 'Europe/London';
  const today = localDate(tz);
  const name = user.first_name ?? 'there';

  const dueToday   = getTasksDueToday(user.id, today);
  const overdue    = getOverdueTasks(user.id, today);
  const allPending = listTasks(user.id, false);

  let msg = `🌆 *Evening check-in, ${name}!*\n\n`;

  if (dueToday.length > 0) {
    const done   = dueToday.filter(t => t.completed);
    const undone = dueToday.filter(t => !t.completed);
    if (done.length > 0)   msg += `✅ *${done.length} done today* — great work!\n`;
    if (undone.length > 0) msg += `⏳ *${undone.length} still pending* from today's list\n`;
    msg += '\n';
  } else if (overdue.length > 0) {
    msg += `⚠️ *${overdue.length} overdue task${overdue.length > 1 ? 's' : ''}* still waiting\n\n`;
  } else {
    msg += `✅ *All clear for today!* Nice work.\n\n`;
  }

  if (allPending.length > 0) {
    msg += `📋 *Tomorrow's prep — ${allPending.length} pending:*\n`;
    allPending.slice(0, 3).forEach(t => {
      msg += `  ${P[t.priority] ?? '🟡'} ${t.title}\n`;
    });
    if (allPending.length > 3) msg += `  _+ ${allPending.length - 3} more_\n`;
    msg += '\n';
  }

  msg += `_Time to recharge. See you tomorrow 🌙_`;
  return msg;
}

// ── Weekly Review ─────────────────────────────────────────────────────────────
function buildWeeklyReview(user: any): string {
  const name = user.first_name ?? 'there';

  const completed  = getCompletedThisWeek(user.id);
  const pending    = listTasks(user.id, false);
  const reminders  = listReminders(user.id);
  const invoices   = getInvoicesTotalThisMonth(user.id);
  const flights    = listFlightWatches(user.id);

  let msg = `📊 *Weekly Review — ${name}*\n`;
  msg += `_${new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}_\n`;
  msg += `─────────────────\n\n`;

  // Wins
  msg += `🏆 *This week's wins*\n`;
  if (completed.length > 0) {
    msg += `  ✅ ${completed.length} task${completed.length > 1 ? 's' : ''} completed\n`;
    completed.slice(0, 3).forEach(t => msg += `    • ${t.title}\n`);
    if (completed.length > 3) msg += `    _+ ${completed.length - 3} more_\n`;
  } else {
    msg += `  _No completed tasks this week_\n`;
  }
  if (invoices.count > 0) {
    msg += `  📄 £${invoices.total.toLocaleString()} invoiced (${invoices.count} invoice${invoices.count > 1 ? 's' : ''})\n`;
  }
  msg += '\n';

  // Still pending
  if (pending.length > 0) {
    const high = pending.filter(t => t.priority === 'high');
    msg += `📋 *Still pending (${pending.length})*\n`;
    if (high.length > 0) msg += `  🔴 ${high.length} high-priority\n`;
    pending.slice(0, 4).forEach(t => msg += `  ${P[t.priority] ?? '🟡'} ${t.title}\n`);
    if (pending.length > 4) msg += `  _+ ${pending.length - 4} more_\n`;
    msg += '\n';
  }

  // Active tools
  const tools: string[] = [];
  if (reminders.length > 0)  tools.push(`⏰ ${reminders.length} reminders running`);
  if (flights.length > 0)    tools.push(`✈️ ${flights.length} flight watch${flights.length > 1 ? 'es' : ''}`);
  if (tools.length > 0) {
    msg += tools.join('  ·  ') + '\n\n';
  }

  msg += `_What's the plan for next week? Tell me and I'll get it on the list 🥷_`;
  return msg;
}

// ── Re-engagement Nudge ───────────────────────────────────────────────────────
function buildNudge(user: any): string {
  const name = user.first_name ?? 'there';
  const pending  = listTasks(user.id, false);
  const overdue  = getOverdueTasks(user.id, localDate(user.timezone ?? 'Europe/London'));
  const flights  = listFlightWatches(user.id);

  let msg = `👋 *Hey ${name}, been a while!*\n\n`;
  msg += `Here's what's waiting for you:\n\n`;

  if (overdue.length > 0)  msg += `⚠️ *${overdue.length} overdue task${overdue.length > 1 ? 's' : ''}*\n`;
  if (pending.length > 0)  msg += `📋 *${pending.length} pending task${pending.length > 1 ? 's' : ''}*\n`;
  if (flights.length > 0)  msg += `✈️ *${flights.length} flight watch${flights.length > 1 ? 'es' : ''} active*\n`;

  if (pending.length === 0 && overdue.length === 0 && flights.length === 0) {
    msg += `_Your slate is clean — good time to plan something new._\n`;
  }

  msg += `\nAnything I can help with today? 🥷`;
  return msg;
}

// ── Main heartbeat — call every 30 minutes ────────────────────────────────────
export async function runDigestHeartbeat(notify: NotifyFn) {
  const users = getAllUsers();
  const now   = Date.now();

  for (const user of users) {
    const tz  = user.timezone ?? 'Europe/London';
    const h   = localHour(tz);
    const dow = new Date(new Date().toLocaleString('en-US', { timeZone: tz })).getDay(); // 0=Sun

    // ── Morning digest at 8am ──────────────────────────────────────────────
    if (h === 8 && !digestSentToday(user)) {
      try {
        notify(user.id, buildMorningDigest(user));
        markDigestSent(user.id);
        console.log(`[digest] Morning sent to ${user.id} (${tz})`);
      } catch (e) { console.error(`[digest] Error morning ${user.id}:`, e); }
    }

    // ── Evening check-in at 5pm ────────────────────────────────────────────
    if (h === 17) {
      // Use last_digest_at to also gate evening (track separately if needed — for now gate on hour only)
      // Only send if they had tasks or overdue (don't ping with nothing)
      const today   = localDate(tz);
      const dueT    = getTasksDueToday(user.id, today);
      const overdue = getOverdueTasks(user.id, today);
      if (dueT.length > 0 || overdue.length > 0) {
        try {
          notify(user.id, buildEveningCheckin(user));
          console.log(`[digest] Evening sent to ${user.id}`);
        } catch (e) { console.error(`[digest] Error evening ${user.id}:`, e); }
      }
    }

    // ── Weekly review — Sunday at 6pm ──────────────────────────────────────
    if (dow === 0 && h === 18 && !weeklyReviewSentThisWeek(user)) {
      try {
        notify(user.id, buildWeeklyReview(user));
        markWeeklyReviewSent(user.id);
        console.log(`[digest] Weekly review sent to ${user.id}`);
      } catch (e) { console.error(`[digest] Weekly review error ${user.id}:`, e); }
    }
  }

  // ── Re-engagement nudge — once per run, only for inactive users ────────────
  // Runs at noon UTC only (avoid spamming)
  const utcHour = new Date().getUTCHours();
  if (utcHour === 12) {
    const inactive = getUsersInactiveForDays(3);
    for (const user of inactive) {
      // Only nudge once every 7 days
      if (user.last_digest_at) {
        const daysSince = (now - new Date(user.last_digest_at).getTime()) / 864e5;
        if (daysSince < 7) continue;
      }
      try {
        notify(user.id, buildNudge(user));
        markDigestSent(user.id); // reuse field to track nudge time
        console.log(`[digest] Re-engagement sent to ${user.id}`);
      } catch (e) { console.error(`[digest] Nudge error ${user.id}:`, e); }
    }
  }
}
