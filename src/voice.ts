/**
 * NinjaPA — Voice transcription via Groq Whisper.
 * Telegram sends voice notes as .ogg files — we download and transcribe them.
 * Groq Whisper is ~free ($0.04/hr audio, typical voice note < 30s = ~$0.0003).
 */
import fs from 'fs';
import path from 'path';
import https from 'https';
import { Telegraf } from 'telegraf';

/**
 * Download a Telegram file to a temp path and return that path.
 */
async function downloadTelegramFile(bot: Telegraf, fileId: string): Promise<string> {
  const file = await bot.telegram.getFile(fileId);
  const filePath = file.file_path;
  if (!filePath) throw new Error('No file path from Telegram');

  const token = (bot.telegram as any).token as string;
  const url = `https://api.telegram.org/file/bot${token}/${filePath}`;

  const tmpPath = path.join('/tmp', `ninjapa_voice_${Date.now()}.ogg`);

  await new Promise<void>((resolve, reject) => {
    const dest = fs.createWriteStream(tmpPath);
    https.get(url, (res) => {
      res.pipe(dest);
      dest.on('finish', () => { dest.close(); resolve(); });
    }).on('error', (e) => { fs.unlink(tmpPath, () => {}); reject(e); });
  });

  return tmpPath;
}

/**
 * Transcribe an audio file using Groq Whisper API.
 * Returns the transcript text.
 */
async function transcribeWithGroq(audioPath: string): Promise<string> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('GROQ_API_KEY not set');

  // Use Node built-in FormData + Blob — avoids multipart EOF bug with npm form-data + fetch
  const audioBuffer = fs.readFileSync(audioPath);
  const blob = new Blob([audioBuffer], { type: 'audio/ogg' });

  const form = new FormData();
  form.append('file', blob, 'voice.ogg');
  form.append('model', 'whisper-large-v3-turbo');
  form.append('response_format', 'json');
  // Prompt biases Whisper toward correct time/number recognition (common mishearing: "100" for "1")
  form.append('prompt', 'Reminder, task, note, 1 pm, 2 pm, 3 pm, 1 o\'clock, half past, quarter to, today, tomorrow, Monday, Tuesday, Wednesday, Thursday, Friday, Saturday, Sunday.');

  const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      // Do NOT set Content-Type — fetch sets it automatically with the correct boundary
    },
    body: form,
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Groq Whisper error: ${err}`);
  }

  const data = await response.json() as { text: string };
  return data.text?.trim() ?? '';
}

/**
 * Main entry: download + transcribe a Telegram voice message.
 * Returns the transcript string.
 */
export async function transcribeVoiceMessage(bot: Telegraf, fileId: string): Promise<string> {
  let tmpPath: string | undefined;
  try {
    tmpPath = await downloadTelegramFile(bot, fileId);
    const transcript = await transcribeWithGroq(tmpPath);
    return transcript;
  } finally {
    if (tmpPath) fs.unlink(tmpPath, () => {});
  }
}
