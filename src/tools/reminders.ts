import { addReminder, listReminders, cancelReminder } from '../db.js';
import { scheduleReminder } from '../scheduler.js';

// Convert natural-language time hints into cron expressions
// Claude handles the natural language — this just maps simple patterns
export function toCronExpr(schedule: string): string {
  const s = schedule.toLowerCase().trim();
  // Common patterns
  if (s === 'daily' || s === 'every day') return '0 9 * * *';
  if (s === 'every morning' || s === 'morning') return '0 8 * * *';
  if (s === 'every evening' || s === 'evening') return '0 18 * * *';
  if (s === 'every hour') return '0 * * * *';
  if (s === 'every 30 minutes' || s === 'every 30 mins') return '*/30 * * * *';
  if (s === 'every 45 minutes' || s === 'every 45 mins') return '*/45 * * * *';
  if (s === 'every monday' || s === 'weekly') return '0 9 * * 1';
  if (s.startsWith('every weekday')) return '0 9 * * 1-5';
  if (s.startsWith('every weekend')) return '0 10 * * 6,0';
  // Return as-is if looks like a cron already
  return schedule;
}

export async function tool_add_reminder(userId: number, args: {
  message: string;
  type: 'once' | 'recurring';
  once_at?: string;       // ISO datetime for one-shot
  cron_expr?: string;     // cron for recurring
  schedule_label?: string; // natural label e.g. "every morning"
}) {
  const cronExpr = args.cron_expr ?? (args.schedule_label ? toCronExpr(args.schedule_label) : undefined);

  const result = addReminder(userId, args.message, {
    type: args.type,
    once_at: args.once_at,
    cron_expr: cronExpr,
  });

  const reminderId = (result as any).lastInsertRowid as number;

  // Register with live scheduler immediately
  scheduleReminder({
    id: reminderId,
    user_id: userId,
    message: args.message,
    type: args.type,
    once_at: args.once_at ?? null,
    cron_expr: cronExpr ?? null,
    active: 1,
  });

  return {
    success: true,
    reminder_id: reminderId,
    message: args.message,
    type: args.type,
    schedule: args.once_at ?? cronExpr ?? args.schedule_label,
  };
}

export async function tool_list_reminders(userId: number) {
  const reminders = listReminders(userId);
  if (reminders.length === 0) return { reminders: [], message: 'No active reminders.' };
  return {
    reminders: reminders.map(r => ({
      id: r.id,
      message: r.message,
      type: r.type,
      schedule: r.once_at ?? r.cron_expr,
      last_fired: r.last_fired,
    })),
  };
}

export async function tool_cancel_reminder(userId: number, args: { reminder_id: number }) {
  cancelReminder(userId, args.reminder_id);
  return { success: true, message: `Reminder #${args.reminder_id} cancelled.` };
}
