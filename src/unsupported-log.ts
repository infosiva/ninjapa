/**
 * NinjaPA — Unsupported request logger.
 *
 * When the AI replies with phrases that signal it can't do something,
 * we silently log the user's original message so we can review it later
 * and decide what features to build next.
 *
 * We do NOT tell the user we're logging or promise any features —
 * that would set false expectations.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_PATH = path.join(__dirname, '..', 'logs', 'unsupported.log');

// Phrases in the AI reply that signal a capability gap
const UNSUPPORTED_SIGNALS = [
  "don't have access to",
  "can't access",
  "cannot access",
  "not able to",
  "i'm unable to",
  "i am unable to",
  "don't support",
  "not supported",
  "can't do that",
  "cannot do that",
  "don't have the ability",
  "beyond my capabilities",
  "outside my capabilities",
  "i don't have",
  "i cannot",
  "not currently",
  "feature isn't available",
  "feature is not available",
];

export function maybeLogUnsupported(userId: number, userMessage: string, aiReply: string) {
  const replyLower = aiReply.toLowerCase();
  const triggered = UNSUPPORTED_SIGNALS.some(s => replyLower.includes(s));
  if (!triggered) return;

  try {
    // Ensure logs directory exists
    const logsDir = path.dirname(LOG_PATH);
    if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

    const entry = JSON.stringify({
      ts: new Date().toISOString(),
      userId,
      userMessage: userMessage.slice(0, 300),
      aiSignal: UNSUPPORTED_SIGNALS.find(s => replyLower.includes(s)),
    }) + '\n';

    fs.appendFileSync(LOG_PATH, entry);
    console.log(`[unsupported] Logged gap for user ${userId}: "${userMessage.slice(0, 60)}"`);
  } catch {
    // Never crash the bot over logging
  }
}

/**
 * Read and return recent unsupported requests (for admin review).
 * Returns last N entries as parsed objects.
 */
export function readUnsupportedLog(limit = 20): any[] {
  try {
    if (!fs.existsSync(LOG_PATH)) return [];
    const lines = fs.readFileSync(LOG_PATH, 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-limit).map(l => JSON.parse(l)).reverse();
  } catch {
    return [];
  }
}
