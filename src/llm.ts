/**
 * NinjaPA — Universal LLM Provider with automatic fallback.
 *
 * Chain (free → paid):
 *   1. Groq      — llama-3.3-70b  (free, fast, tool-use ✓)
 *   2. Gemini    — gemini-2.5-flash               (free, 1M ctx, tool-use ✓)
 *   3. Cerebras  — qwen-3-235b / gpt-oss-120b     (free, ultra-fast, tool-use ✓)
 *   4. NVIDIA    — llama-3.3-70b-instruct         (free tier, tool-use ✓)
 *   5. OpenAI    — gpt-4o-mini                    (paid, cheap fallback)
 *   6. Anthropic — claude-haiku                   (paid, last resort)
 *
 * All free providers are OpenAI-API-compatible — one SDK, five providers.
 * Tool-use works across all of them using the OpenAI function-calling schema.
 */

import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';

// ── Provider configs ──────────────────────────────────────────────────────────

interface Provider {
  name: string;
  envKey: string;
  baseURL: string;
  model: string;
  supportsTools: boolean;
}

const PROVIDERS: Provider[] = [
  // ── Free tier providers ────────────────────────────────────────────────────
  {
    name: 'Groq',
    envKey: 'GROQ_API_KEY',
    baseURL: 'https://api.groq.com/openai/v1',
    model: process.env.GROQ_MODEL ?? 'qwen/qwen3.8-27b',
    supportsTools: true,
  },
  {
    name: 'Gemini',
    envKey: 'GEMINI_API_KEY',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: process.env.GEMINI_MODEL ?? 'gemini-2.5-flash',
    supportsTools: true,
  },
  {
    name: 'Cerebras',
    envKey: 'CEREBRAS_API_KEY',
    baseURL: 'https://api.cerebras.ai/v1',
    model: process.env.CEREBRAS_MODEL ?? 'gpt-oss-120b',
    supportsTools: true,
  },
  {
    name: 'NVIDIA',
    envKey: 'NVIDIA_API_KEY',
    baseURL: 'https://integrate.api.nvidia.com/v1',
    model: process.env.NVIDIA_MODEL ?? 'meta/llama-3.3-70b-instruct',
    supportsTools: true,
  },
  // ── Paid fallback (only if all free tiers exhausted) ──────────────────────
  {
    name: 'OpenAI',
    envKey: 'OPENAI_API_KEY',
    baseURL: 'https://api.openai.com/v1',
    model: process.env.OPENAI_MODEL ?? 'gpt-4o-mini',
    supportsTools: true,
  },
];

// ── Type aliases ──────────────────────────────────────────────────────────────

export type LLMMessage = OpenAI.ChatCompletionMessageParam;

// Use plain objects so we avoid the ChatCompletionCustomTool union issue
export interface LLMTool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, any>;
  };
}

// Minimal tool-call shape we use internally (avoids OpenAI union type issues)
export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface LLMResponse {
  content: string;
  toolCalls?: ToolCall[];
  provider: string;
  model: string;
}

// ── Main call with automatic fallback ─────────────────────────────────────────

export async function llmCall(opts: {
  messages: LLMMessage[];
  tools?: LLMTool[];
  system?: string;
  maxTokens?: number;
}): Promise<LLMResponse> {
  const { messages, tools, system, maxTokens = 2048 } = opts;

  // Build full message array with system prefix
  const fullMessages: LLMMessage[] = system
    ? [{ role: 'system', content: system }, ...messages]
    : messages;

  const errors: string[] = [];

  // ── Try each free provider in order ────────────────────────────────────────
  for (const p of PROVIDERS) {
    const apiKey = process.env[p.envKey];
    if (!apiKey) continue; // skip if key not configured

    try {
      const client = new OpenAI({ apiKey, baseURL: p.baseURL });

      const reqParams: any = {
        model: p.model,
        messages: fullMessages,
        max_tokens: maxTokens,
      };

      if (tools && tools.length > 0 && p.supportsTools) {
        reqParams.tools = tools;
        reqParams.tool_choice = 'auto';
      }

      const resp = await client.chat.completions.create(reqParams);
      const choice = resp.choices[0];

      console.log(`[llm] ✓ ${p.name} (${p.model})`);

      const rawToolCalls = (choice.message as any).tool_calls as ToolCall[] | undefined;
      return {
        content: choice.message.content ?? '',
        toolCalls: rawToolCalls?.length ? rawToolCalls : undefined,
        provider: p.name,
        model: p.model,
      };
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      console.warn(`[llm] ✗ ${p.name}: ${msg.slice(0, 120)}`);
      errors.push(`${p.name}: ${msg.slice(0, 80)}`);
    }
  }

  // ── Final fallback: Anthropic (paid) ───────────────────────────────────────
  // Skip if explicitly disabled (e.g. credit exhausted)
  const skipAnthropic = process.env.ANTHROPIC_DISABLED === '1';
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (anthropicKey && !skipAnthropic) {
    try {
      const anthropic = new Anthropic({ apiKey: anthropicKey });
      const model = process.env.CLAUDE_MODEL ?? 'claude-haiku-4-5-20251001';

      // Convert OpenAI-style tools → Anthropic tools
      const anthropicTools: Anthropic.Tool[] | undefined = tools?.map(t => ({
        name: t.function.name,
        description: t.function.description ?? '',
        input_schema: t.function.parameters as Anthropic.Tool['input_schema'],
      }));

      // Convert messages — tool results need special handling
      const anthropicMessages: Anthropic.MessageParam[] = [];
      for (const m of messages) {
        if (m.role === 'system') continue;
        if (m.role === 'tool') {
          // tool result — attach to previous user message or create new one
          const last = anthropicMessages[anthropicMessages.length - 1];
          const block: Anthropic.ToolResultBlockParam = {
            type: 'tool_result',
            tool_use_id: (m as any).tool_call_id ?? 'unknown',
            content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
          };
          if (last?.role === 'user' && Array.isArray(last.content)) {
            (last.content as any[]).push(block);
          } else {
            anthropicMessages.push({ role: 'user', content: [block] });
          }
          continue;
        }
        if (m.role === 'assistant' && (m as any).tool_calls?.length) {
          const toolUseBlocks: Anthropic.ToolUseBlockParam[] = ((m as any).tool_calls as ToolCall[]).map(tc => ({
            type: 'tool_use',
            id: tc.id,
            name: tc.function.name,
            input: JSON.parse(tc.function.arguments || '{}'),
          }));
          const textContent = typeof m.content === 'string' && m.content
            ? [{ type: 'text' as const, text: m.content }, ...toolUseBlocks]
            : toolUseBlocks;
          anthropicMessages.push({ role: 'assistant', content: textContent });
          continue;
        }
        anthropicMessages.push({
          role: m.role as 'user' | 'assistant',
          content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
        });
      }

      const resp = await anthropic.messages.create({
        model,
        max_tokens: maxTokens,
        system,
        tools: anthropicTools,
        messages: anthropicMessages,
      });

      console.log(`[llm] ✓ Anthropic (${model})`);

      // Convert Anthropic response → unified format
      let content = '';
      const toolCalls: ToolCall[] = [];

      for (const block of resp.content) {
        if (block.type === 'text') content += block.text;
        if (block.type === 'tool_use') {
          toolCalls.push({
            id: block.id,
            type: 'function',
            function: {
              name: block.name,
              arguments: JSON.stringify(block.input),
            },
          });
        }
      }

      return {
        content,
        toolCalls: toolCalls.length ? toolCalls : undefined,
        provider: 'Anthropic',
        model,
      };
    } catch (err: any) {
      errors.push(`Anthropic: ${err?.message?.slice(0, 80)}`);
    }
  }

  throw new Error(`All AI providers failed:\n${errors.join('\n')}`);
}
