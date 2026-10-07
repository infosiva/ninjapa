/**
 * NinjaPA — AI Brain with tool-use via universal LLM provider.
 *
 * Uses llm.ts which tries: Groq → Gemini → Cerebras → NVIDIA → Anthropic
 * Tool-use (add task, set reminder, etc.) works across all providers.
 */
import { llmCall, LLMMessage, LLMTool, ToolCall } from './llm.js';
import { getHistory, appendHistory, getUser } from './db.js';
import { tool_add_task, tool_list_tasks, tool_complete_task, tool_delete_task } from './tools/tasks.js';
import { tool_add_reminder, tool_list_reminders, tool_cancel_reminder } from './tools/reminders.js';
import { tool_save_note, tool_search_notes, tool_list_notes } from './tools/notes.js';
import { tool_generate_invoice, tool_list_invoices } from './tools/invoices.js';
import { tool_watch_flight, tool_list_flight_watches } from './tools/flights.js';
import { tool_set_profile, tool_get_profile, tool_create_diet_plan, tool_plan_trip, tool_set_timezone } from './tools/profile.js';
import { tool_find_local_service, checkPlacesQuotaAndNotify } from './tools/local-search.js';
import { tool_get_weather } from './tools/weather.js';

// Notify function injected at startup (set via setNotifier)
let _notify: ((userId: number, msg: string) => void) | undefined;
export function setNotifier(fn: (userId: number, msg: string) => void) {
  _notify = fn;
}

// ── Tool Definitions (OpenAI function-calling schema) ─────────────────────────
const TOOLS: LLMTool[] = [
  {
    type: 'function',
    function: {
      name: 'add_task',
      description: "Add a task or to-do item to the user's task list.",
      parameters: {
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
  },
  {
    type: 'function',
    function: {
      name: 'list_tasks',
      description: "List the user's tasks.",
      parameters: {
        type: 'object',
        properties: {
          include_completed: { type: 'boolean', description: 'Include completed tasks' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'complete_task',
      description: 'Mark a task as done/completed.',
      parameters: {
        type: 'object',
        properties: {
          task_id: { type: 'number', description: 'ID of the task' },
          search_title: { type: 'string', description: 'Search by title if ID unknown' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_task',
      description: 'Delete a task permanently.',
      parameters: {
        type: 'object',
        properties: { task_id: { type: 'number' } },
        required: ['task_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'add_reminder',
      description: 'Schedule a reminder — either one-time or recurring.',
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'What to remind the user about' },
          type: { type: 'string', enum: ['once', 'recurring'] },
          once_at: { type: 'string', description: 'ISO 8601 datetime for one-shot reminder' },
          cron_expr: { type: 'string', description: 'Cron expression for recurring (e.g. "0 9 * * *")' },
          schedule_label: { type: 'string', description: 'Human label e.g. "every 45 minutes"' },
        },
        required: ['message', 'type'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_reminders',
      description: 'List all active reminders for the user.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cancel_reminder',
      description: 'Cancel/stop an active reminder.',
      parameters: {
        type: 'object',
        properties: { reminder_id: { type: 'number' } },
        required: ['reminder_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'save_note',
      description: 'Save a quick note. Use for anything the user wants to remember.',
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'The note content' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags' },
        },
        required: ['content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_notes',
      description: 'Search saved notes.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_notes',
      description: 'List recent notes.',
      parameters: {
        type: 'object',
        properties: { limit: { type: 'number', description: 'Max notes to return (default 10)' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'generate_invoice',
      description: 'Generate a professional PDF invoice and send it to the user.',
      parameters: {
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
          },
          currency: { type: 'string', description: 'GBP, USD, EUR, INR (default GBP)' },
          tax_pct: { type: 'number', description: 'Tax percentage (0 if none)' },
          due_days: { type: 'number', description: 'Payment due in N days (default 30)' },
        },
        required: ['client_name', 'items'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_invoices',
      description: 'List recent invoices.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'watch_flight',
      description: 'Set up a flight price alert.',
      parameters: {
        type: 'object',
        properties: {
          origin: { type: 'string' },
          destination: { type: 'string' },
          max_price: { type: 'number' },
          currency: { type: 'string' },
          travel_date: { type: 'string' },
        },
        required: ['origin', 'destination', 'max_price'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_flight_watches',
      description: 'List active flight price watches.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_profile',
      description: 'Save user profile info — name, age, weight, email, company, address, etc.',
      parameters: {
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
          dietary_preference: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_profile',
      description: "Get the user's saved profile.",
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_diet_plan',
      description: 'Generate a personalised 7-day diet plan.',
      parameters: {
        type: 'object',
        properties: {
          age: { type: 'number' },
          weight_kg: { type: 'number' },
          height_cm: { type: 'number' },
          goal: { type: 'string' },
          dietary_preference: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'plan_trip',
      description: 'Generate a detailed travel itinerary.',
      parameters: {
        type: 'object',
        properties: {
          destination: { type: 'string' },
          duration_days: { type: 'number' },
          budget: { type: 'string' },
          travel_style: { type: 'string' },
          start_date: { type: 'string' },
        },
        required: ['destination', 'duration_days'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_local_service',
      description: 'Find local tradespeople or service providers near the user — plumbers, handymen, electricians, cleaners, builders, etc. Returns rated results with reviews.',
      parameters: {
        type: 'object',
        properties: {
          service: { type: 'string', description: 'Type of trade or service e.g. "handyman", "plumber", "electrician", "cleaner"' },
          location: { type: 'string', description: 'Town, city or postcode e.g. "Manchester", "London SW1", "Birmingham"' },
        },
        required: ['service', 'location'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_timezone',
      description: "Set the user's timezone so reminders and times are correct.",
      parameters: {
        type: 'object',
        properties: {
          timezone: { type: 'string', description: 'IANA timezone name e.g. Asia/Kolkata' },
        },
        required: ['timezone'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_weather',
      description: 'Get current weather and 3-day forecast for any city or location.',
      parameters: {
        type: 'object',
        properties: {
          location: { type: 'string', description: 'City or location name e.g. "London", "Manchester", "Chennai"' },
          timezone: { type: 'string', description: "User's IANA timezone e.g. Europe/London" },
        },
        required: ['location'],
      },
    },
  },
];

// ── Tool executor ─────────────────────────────────────────────────────────────
async function executeTool(userId: number, name: string, args: any): Promise<any> {
  switch (name) {
    case 'add_task':            return tool_add_task(userId, args);
    case 'list_tasks':          return tool_list_tasks(userId, args);
    case 'complete_task':       return tool_complete_task(userId, args);
    case 'delete_task':         return tool_delete_task(userId, args);
    case 'add_reminder':        return tool_add_reminder(userId, args);
    case 'list_reminders':      return tool_list_reminders(userId);
    case 'cancel_reminder':     return tool_cancel_reminder(userId, args);
    case 'save_note':           return tool_save_note(userId, args);
    case 'search_notes':        return tool_search_notes(userId, args);
    case 'list_notes':          return tool_list_notes(userId, args);
    case 'generate_invoice':    return tool_generate_invoice(userId, args);
    case 'list_invoices':       return tool_list_invoices(userId);
    case 'watch_flight':        return tool_watch_flight(userId, args);
    case 'list_flight_watches': return tool_list_flight_watches(userId);
    case 'set_profile':         return tool_set_profile(userId, args);
    case 'get_profile':         return tool_get_profile(userId);
    case 'create_diet_plan':    return tool_create_diet_plan(userId, args);
    case 'plan_trip':           return tool_plan_trip(userId, args);
    case 'set_timezone':        return tool_set_timezone(userId, args);
    case 'find_local_service':  return tool_find_local_service(userId, args, _notify);
    case 'get_weather':         return tool_get_weather(userId, args);
    default: return { error: `Unknown tool: ${name}` };
  }
}

// ── System prompt ─────────────────────────────────────────────────────────────
function buildSystemPrompt(user: any): string {
  const profile = JSON.parse(user?.profile ?? '{}');
  const tz = user?.timezone ?? 'Europe/London';
  const now = new Date().toLocaleString('en-GB', { timeZone: tz });

  return `You are NinjaPA — a sharp, capable, no-nonsense personal AI assistant delivered via Telegram.

Current time (${tz}): ${now}
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
- Local services: find plumbers, handymen, electricians, cleaners near any location with reviews
- Weather: current conditions + 3-day forecast for any city (use get_weather tool)
- Profile: remember user details so they never repeat themselves

When generating diet plans or travel plans: write them directly in your response — don't just say "here's the plan", actually provide it fully.

Keep responses concise. When a tool is called, acknowledge it with one short sentence then add any helpful context.`;
}

// ── Main entrypoint ───────────────────────────────────────────────────────────
export async function processMessage(
  userId: number,
  userMessage: string,
): Promise<{ text: string; pdfPath?: string }> {
  const user = getUser(userId);
  const history = getHistory(userId);

  appendHistory(userId, 'user', userMessage);

  // Build conversation history in OpenAI format
  const messages: LLMMessage[] = [
    ...history.map(h => ({ role: h.role as 'user' | 'assistant', content: h.content })),
    { role: 'user', content: userMessage },
  ];

  let pdfPath: string | undefined;
  let finalText = '';
  const MAX_ITERATIONS = 5;

  // ── Agentic loop: LLM → tool call → result → LLM again ───────────────────
  let response = await llmCall({
    messages,
    tools: TOOLS,
    system: buildSystemPrompt(user),
  });

  let iterations = 0;
  while (response.toolCalls?.length && iterations < MAX_ITERATIONS) {
    iterations++;

    // Add assistant message with tool calls to history
    messages.push({
      role: 'assistant',
      content: response.content || null,
      tool_calls: response.toolCalls,
    } as LLMMessage);

    // Execute each tool and collect results
    const toolResults: LLMMessage[] = [];
    for (const tc of response.toolCalls) {
      const args = JSON.parse(tc.function.arguments || '{}');
      console.log(`[NinjaPA] Tool call: ${tc.function.name}`, args);

      let result: any;
      try {
        result = await executeTool(userId, tc.function.name, args);
      } catch (err: any) {
        result = { error: err.message ?? 'Tool execution failed' };
      }
      console.log(`[NinjaPA] Tool result:`, result);

      if (tc.function.name === 'generate_invoice' && result.pdf_path) {
        pdfPath = result.pdf_path;
      }

      toolResults.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: JSON.stringify(result),
      } as LLMMessage);
    }

    messages.push(...toolResults);

    response = await llmCall({
      messages,
      tools: TOOLS,
      system: buildSystemPrompt(user),
    });
  }

  finalText = response.content;

  if (finalText) appendHistory(userId, 'assistant', finalText);

  return { text: finalText || 'Done.', pdfPath };
}
