/**
 * NinjaPA — AI Brain with Claude tool-use.
 * Claude reads the user message, decides which tool to call,
 * executes it, then writes the final response.
 *
 * Provider order: Groq (free) → Gemini (free) → Anthropic (paid)
 * Tool-use requires Anthropic for structured tool calls.
 * Groq/Gemini used for simple conversational responses.
 */
import Anthropic from '@anthropic-ai/sdk';
import { getHistory, appendHistory, getUser } from './db.js';
import { tool_add_task, tool_list_tasks, tool_complete_task, tool_delete_task } from './tools/tasks.js';
import { tool_add_reminder, tool_list_reminders, tool_cancel_reminder } from './tools/reminders.js';
import { tool_save_note, tool_search_notes, tool_list_notes } from './tools/notes.js';
import { tool_generate_invoice, tool_list_invoices } from './tools/invoices.js';
import { tool_watch_flight, tool_list_flight_watches } from './tools/flights.js';
import { tool_set_profile, tool_get_profile, tool_create_diet_plan, tool_plan_trip, tool_set_timezone } from './tools/profile.js';

// ── Tool Definitions (JSON Schema for Claude) ─────────────────────────────────
const TOOLS: Anthropic.Tool[] = [
  {
    name: 'add_task',
    description: 'Add a task or to-do item to the user\'s task list.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short title of the task' },
        description: { type: 'string', description: 'Optional longer description' },
        priority: { type: 'string', enum: ['low', 'medium', 'high'] },
        due_at: { type: 'string', description: 'ISO 8601 datetime when task is due' },
      },
      required: ['title'],
    },
  },
  {
    name: 'list_tasks',
    description: 'List the user\'s tasks.',
    input_schema: {
      type: 'object',
      properties: {
        include_completed: { type: 'boolean', description: 'Include completed tasks' },
      },
    },
  },
  {
    name: 'complete_task',
    description: 'Mark a task as done/completed.',
    input_schema: {
      type: 'object',
      properties: {
        task_id: { type: 'number', description: 'ID of the task' },
        search_title: { type: 'string', description: 'Search by title if ID unknown' },
      },
    },
  },
  {
    name: 'delete_task',
    description: 'Delete a task permanently.',
    input_schema: {
      type: 'object',
      properties: { task_id: { type: 'number' } },
      required: ['task_id'],
    },
  },
  {
    name: 'add_reminder',
    description: 'Schedule a reminder — either one-time or recurring. Use for standup alerts, medication, drink water, etc.',
    input_schema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'What to remind the user about' },
        type: { type: 'string', enum: ['once', 'recurring'] },
        once_at: { type: 'string', description: 'ISO 8601 datetime for one-shot reminder' },
        cron_expr: { type: 'string', description: 'Cron expression for recurring (e.g. "0 9 * * *")' },
        schedule_label: { type: 'string', description: 'Human label e.g. "every 45 minutes" or "every morning"' },
      },
      required: ['message', 'type'],
    },
  },
  {
    name: 'list_reminders',
    description: 'List all active reminders for the user.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'cancel_reminder',
    description: 'Cancel/stop an active reminder.',
    input_schema: {
      type: 'object',
      properties: { reminder_id: { type: 'number' } },
      required: ['reminder_id'],
    },
  },
  {
    name: 'save_note',
    description: 'Save a quick note. Use for anything the user wants to remember.',
    input_schema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The note content' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags' },
      },
      required: ['content'],
    },
  },
  {
    name: 'search_notes',
    description: 'Search saved notes.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  },
  {
    name: 'list_notes',
    description: 'List recent notes.',
    input_schema: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'Max notes to return (default 10)' } },
    },
  },
  {
    name: 'generate_invoice',
    description: 'Generate a professional PDF invoice and send it to the user.',
    input_schema: {
      type: 'object',
      properties: {
        client_name: { type: 'string' },
        client_email: { type: 'string' },
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              description: { type: 'string' },
              qty: { type: 'number' },
              rate: { type: 'number' },
            },
            required: ['description', 'qty', 'rate'],
          },
          description: 'Line items — each with description, qty, rate',
        },
        currency: { type: 'string', description: 'GBP, USD, EUR, INR (default GBP)' },
        tax_pct: { type: 'number', description: 'Tax percentage (0 if none)' },
        due_days: { type: 'number', description: 'Payment due in N days (default 30)' },
      },
      required: ['client_name', 'items'],
    },
  },
  {
    name: 'list_invoices',
    description: 'List recent invoices.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'watch_flight',
    description: 'Set up a flight price alert. NinjaPA checks daily and notifies when the price drops below the threshold.',
    input_schema: {
      type: 'object',
      properties: {
        origin: { type: 'string', description: 'Origin airport or city (e.g. LHR, London)' },
        destination: { type: 'string', description: 'Destination airport or city (e.g. MAA, Chennai)' },
        max_price: { type: 'number', description: 'Alert when price drops below this' },
        currency: { type: 'string', description: 'Currency (default GBP)' },
        travel_date: { type: 'string', description: 'Preferred travel date YYYY-MM-DD (optional)' },
      },
      required: ['origin', 'destination', 'max_price'],
    },
  },
  {
    name: 'list_flight_watches',
    description: 'List active flight price watches.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'set_profile',
    description: 'Save user profile info — name, age, weight, email, company, address, etc.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        age: { type: 'number' },
        weight_kg: { type: 'number' },
        height_cm: { type: 'number' },
        email: { type: 'string' },
        company_name: { type: 'string' },
        address: { type: 'string' },
        default_currency: { type: 'string' },
        fitness_goal: { type: 'string' },
        dietary_preference: { type: 'string', description: 'vegetarian, vegan, non-veg, etc.' },
      },
    },
  },
  {
    name: 'get_profile',
    description: 'Get the user\'s saved profile.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'create_diet_plan',
    description: 'Generate a personalised 7-day diet plan based on age, weight, goals.',
    input_schema: {
      type: 'object',
      properties: {
        age: { type: 'number' },
        weight_kg: { type: 'number' },
        height_cm: { type: 'number' },
        goal: { type: 'string', description: 'lose weight, gain muscle, maintain, etc.' },
        dietary_preference: { type: 'string' },
      },
    },
  },
  {
    name: 'plan_trip',
    description: 'Generate a detailed travel itinerary.',
    input_schema: {
      type: 'object',
      properties: {
        destination: { type: 'string' },
        duration_days: { type: 'number' },
        budget: { type: 'string', description: 'e.g. £2000' },
        travel_style: { type: 'string', description: 'adventure, relaxed, cultural, food' },
        start_date: { type: 'string', description: 'YYYY-MM-DD' },
      },
      required: ['destination', 'duration_days'],
    },
  },
  {
    name: 'set_timezone',
    description: 'Set the user\'s timezone so reminders and times are correct. Call this when a user mentions their location or timezone.',
    input_schema: {
      type: 'object',
      properties: {
        timezone: { type: 'string', description: 'IANA timezone name e.g. Asia/Kolkata, America/New_York, Europe/London, Asia/Singapore' },
      },
      required: ['timezone'],
    },
  },
];

// ── Tool executor ─────────────────────────────────────────────────────────────
async function executeTool(userId: number, name: string, args: any): Promise<any> {
  switch (name) {
    case 'add_task':           return tool_add_task(userId, args);
    case 'list_tasks':         return tool_list_tasks(userId, args);
    case 'complete_task':      return tool_complete_task(userId, args);
    case 'delete_task':        return tool_delete_task(userId, args);
    case 'add_reminder':       return tool_add_reminder(userId, args);
    case 'list_reminders':     return tool_list_reminders(userId);
    case 'cancel_reminder':    return tool_cancel_reminder(userId, args);
    case 'save_note':          return tool_save_note(userId, args);
    case 'search_notes':       return tool_search_notes(userId, args);
    case 'list_notes':         return tool_list_notes(userId, args);
    case 'generate_invoice':   return tool_generate_invoice(userId, args);
    case 'list_invoices':      return tool_list_invoices(userId);
    case 'watch_flight':       return tool_watch_flight(userId, args);
    case 'list_flight_watches':return tool_list_flight_watches(userId);
    case 'set_profile':        return tool_set_profile(userId, args);
    case 'get_profile':        return tool_get_profile(userId);
    case 'create_diet_plan':   return tool_create_diet_plan(userId, args);
    case 'plan_trip':          return tool_plan_trip(userId, args);
    case 'set_timezone':       return tool_set_timezone(userId, args);
    default: return { error: `Unknown tool: ${name}` };
  }
}

// ── System prompt ─────────────────────────────────────────────────────────────
function buildSystemPrompt(user: any): string {
  const profile = JSON.parse(user?.profile ?? '{}');
  const tz = user?.timezone ?? 'Europe/London';
  const now = new Date().toLocaleString('en-GB', { timeZone: tz });

  return `You are NinjaPA — a sharp, capable, no-nonsense personal AI assistant delivered via Telegram.

Current time (London): ${now}
User: ${user?.first_name ?? 'there'} | Plan: ${user?.plan ?? 'free'}
${profile.age ? `Age: ${profile.age}` : ''}${profile.weight_kg ? ` | Weight: ${profile.weight_kg}kg` : ''}${profile.fitness_goal ? ` | Goal: ${profile.fitness_goal}` : ''}

Your personality:
- Efficient and direct — never waffle
- Friendly but professional, like a great EA
- Always confirm what you've done, briefly
- Use Telegram markdown (*bold*, _italic_, bullet points)
- Use relevant emojis sparingly for clarity (✅ ⏰ 📄 ✈️ 📝)

Your capabilities (use tools when relevant):
- Tasks: add, list, complete, delete
- Reminders: one-time and recurring (standup, medication, etc.)
- Notes: save and search
- Invoices: generate professional PDF invoices
- Flights: watch prices and alert when they drop
- Diet plans: personalised 7-day plans with daily meal reminders
- Travel planning: detailed day-by-day itineraries
- Profile: remember user details so they never repeat themselves

When generating diet plans or travel plans: write them directly in your response in a well-formatted way — don't just say "here's the plan", actually provide it fully.

Keep responses concise. When a tool is called, acknowledge it with one short sentence then add any helpful context.`;
}

// ── Main entrypoint ───────────────────────────────────────────────────────────
export async function processMessage(
  userId: number,
  userMessage: string,
): Promise<{ text: string; pdfPath?: string }> {
  const user = getUser(userId);
  const history = getHistory(userId);

  // Save user message to history
  appendHistory(userId, 'user', userMessage);

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

  const messages: Anthropic.MessageParam[] = [
    ...history.map(h => ({ role: h.role as 'user' | 'assistant', content: h.content })),
    { role: 'user', content: userMessage },
  ];

  let pdfPath: string | undefined;
  let finalText = '';

  const MODEL = process.env.CLAUDE_MODEL ?? 'claude-haiku-4-5-20251001';
  const MAX_ITERATIONS = 5;

  // ── Agentic loop: Claude → tool call → result → Claude again ─────────────
  let response = await client.messages.create({
    model: MODEL,
    max_tokens: 2048,
    system: buildSystemPrompt(user),
    tools: TOOLS,
    messages,
  });

  let iterations = 0;
  while (response.stop_reason === 'tool_use' && iterations < MAX_ITERATIONS) {
    iterations++;
    const assistantMsg: Anthropic.MessageParam = { role: 'assistant', content: response.content };
    messages.push(assistantMsg);

    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;

      console.log(`[NinjaPA] Tool call: ${block.name}`, block.input);
      let result: any;
      try {
        result = await executeTool(userId, block.name, block.input);
      } catch (err: any) {
        result = { error: err.message ?? 'Tool execution failed' };
      }
      console.log(`[NinjaPA] Tool result:`, result);

      // Capture PDF path if invoice was generated
      if (block.name === 'generate_invoice' && result.pdf_path) {
        pdfPath = result.pdf_path;
      }

      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: JSON.stringify(result),
      });
    }

    messages.push({ role: 'user', content: toolResults });

    response = await client.messages.create({
      model: MODEL,
      max_tokens: 2048,
      system: buildSystemPrompt(user),
      tools: TOOLS,
      messages,
    });
  }

  // Extract final text
  for (const block of response.content) {
    if (block.type === 'text') finalText += block.text;
  }

  // Save assistant response to history
  if (finalText) appendHistory(userId, 'assistant', finalText);

  return { text: finalText || 'Done.', pdfPath };
}
