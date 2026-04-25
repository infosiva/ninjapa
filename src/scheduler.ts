/**
 * NinjaPA Scheduler — fires reminders at the right time.
 * On startup: loads all active reminders from DB and schedules them.
 * On new reminder: call scheduleReminder() to register it live.
 */
import cron from 'node-cron';
import { getAllActiveReminders, markReminderFired, deactivateReminder } from './db.js';
import { checkAllFlightWatches } from './tools/flights.js';
import { runDigestHeartbeat } from './digest.js';

type NotifyFn = (userId: number, message: string) => void;

// Registered cron tasks keyed by reminder ID
const activeTasks = new Map<number, cron.ScheduledTask>();

let _notify: NotifyFn = () => {};

export function setNotifier(fn: NotifyFn) {
  _notify = fn;
}

export function scheduleReminder(reminder: {
  id: number; user_id: number; message: string;
  type: string; once_at: string | null; cron_expr: string | null; active: number;
}) {
  if (!reminder.active) return;

  // Cancel existing task if re-scheduling
  activeTasks.get(reminder.id)?.stop();

  if (reminder.type === 'once' && reminder.once_at) {
    const fireAt = new Date(reminder.once_at);
    const now = new Date();
    const delay = fireAt.getTime() - now.getTime();

    if (delay <= 0) {
      console.log(`[scheduler] Reminder #${reminder.id} is in the past — skipping`);
      deactivateReminder(reminder.id);
      return;
    }

    const timeout = setTimeout(() => {
      _notify(reminder.user_id, `⏰ *Reminder:* ${reminder.message}`);
      markReminderFired(reminder.id);
      deactivateReminder(reminder.id);
      activeTasks.delete(reminder.id);
    }, delay);

    // Store as a pseudo-task for cancellation
    activeTasks.set(reminder.id, {
      stop: () => clearTimeout(timeout),
    } as any);

    console.log(`[scheduler] One-shot reminder #${reminder.id} set for ${fireAt.toISOString()}`);

  } else if (reminder.type === 'recurring' && reminder.cron_expr) {
    if (!cron.validate(reminder.cron_expr)) {
      console.warn(`[scheduler] Invalid cron for reminder #${reminder.id}: ${reminder.cron_expr}`);
      return;
    }

    const task = cron.schedule(reminder.cron_expr, () => {
      _notify(reminder.user_id, `⏰ *Reminder:* ${reminder.message}`);
      markReminderFired(reminder.id);
    });

    activeTasks.set(reminder.id, task);
    console.log(`[scheduler] Recurring reminder #${reminder.id} cron: ${reminder.cron_expr}`);
  }
}

export function cancelScheduledReminder(reminderId: number) {
  activeTasks.get(reminderId)?.stop();
  activeTasks.delete(reminderId);
}

// ── Boot: load all active reminders from DB ───────────────────────────────────
export function startScheduler(notify: NotifyFn) {
  setNotifier(notify);

  const reminders = getAllActiveReminders();
  console.log(`[scheduler] Loading ${reminders.length} active reminders...`);
  reminders.forEach(scheduleReminder);

  // Daily flight price check at 8 AM UTC
  cron.schedule('0 8 * * *', () => {
    console.log('[scheduler] Running daily flight price checks...');
    checkAllFlightWatches((userId, msg) => notify(userId, msg));
  });

  // Digest heartbeat — runs every 30 min, sends morning/evening/weekly/nudge
  // at the right local time per user
  cron.schedule('*/30 * * * *', () => {
    runDigestHeartbeat(notify).catch(e => console.error('[digest] Heartbeat error:', e));
  });

  console.log('[scheduler] Ready. Digest heartbeat every 30 min.');
}
