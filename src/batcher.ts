/**
 * NinjaPA — Message Batcher.
 *
 * Problem: if 2 reminders fire within seconds of each other, the user gets
 * spammed with separate messages. This batcher holds outgoing messages for
 * a short window (2 seconds) and flushes them as one combined message.
 *
 * Also enforces a minimum gap of 3 seconds between any two messages to the
 * same user — prevents the AI from sending "I'm doing X" then "Done!" as
 * two separate sends (that behaviour is fixed in bot.ts, but this is the
 * safety net at the notify layer).
 */

type NotifyFn = (userId: number, message: string) => void;

const BATCH_WINDOW_MS = 2000;  // hold for 2s, then flush combined
const MIN_GAP_MS = 3000;       // never send to same user faster than 3s

interface Pending {
  messages: string[];
  timer: ReturnType<typeof setTimeout>;
}

export function createBatcher(send: NotifyFn): NotifyFn {
  const pending = new Map<number, Pending>();
  const lastSent = new Map<number, number>();

  function flush(userId: number) {
    const p = pending.get(userId);
    if (!p) return;
    pending.delete(userId);

    const combined = p.messages.join('\n\n─────────────\n\n');
    const now = Date.now();
    const last = lastSent.get(userId) ?? 0;
    const wait = Math.max(0, MIN_GAP_MS - (now - last));

    setTimeout(() => {
      send(userId, combined);
      lastSent.set(userId, Date.now());
    }, wait);
  }

  return function batchedNotify(userId: number, message: string) {
    const existing = pending.get(userId);
    if (existing) {
      // Already batching — append and reset the timer
      clearTimeout(existing.timer);
      existing.messages.push(message);
      existing.timer = setTimeout(() => flush(userId), BATCH_WINDOW_MS);
    } else {
      // First message in this batch window
      pending.set(userId, {
        messages: [message],
        timer: setTimeout(() => flush(userId), BATCH_WINDOW_MS),
      });
    }
  };
}
