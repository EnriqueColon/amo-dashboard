/**
 * Minimal OpenAI Chat Completions streaming client (no SDK — one fetch, the
 * same way collector/extract_pdfs.py talks to the API). Yields text deltas as
 * they arrive and assembles tool calls from their streamed fragments.
 *
 * Configuration (process.env):
 *   OPENAI_API_KEY                 required
 *   OPENAI_CHAT_MODEL              default 'gpt-6-astra' (OpenAI's flagship, Sept 2026)
 *   OPENAI_CHAT_REASONING_EFFORT   low | medium | high | xhigh | max | none (default medium;
 *                                  'none' omits the parameter, for models that reject it)
 *   OPENAI_BASE_URL                default https://api.openai.com/v1 (an OpenAI-compatible
 *                                  gateway or a local mock for testing)
 */

export const DEFAULT_CHAT_MODEL = 'gpt-6-astra';
function chatUrl(): string {
  const base = (process.env.OPENAI_BASE_URL ?? '').trim().replace(/\/+$/, '') || 'https://api.openai.com/v1';
  return `${base}/chat/completions`;
}
const REQUEST_TIMEOUT_MS = 180_000;

export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export type StreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_calls'; calls: ToolCall[] }
  | { type: 'done'; finishReason: string | null; usage: Usage | null };

export interface Usage { prompt_tokens: number; completion_tokens: number; total_tokens: number }

export function chatConfig(): { apiKey: string; model: string; reasoningEffort: string | null } | null {
  const apiKey = (process.env.OPENAI_API_KEY ?? '').trim();
  if (!apiKey) return null;
  const model = (process.env.OPENAI_CHAT_MODEL ?? '').trim() || DEFAULT_CHAT_MODEL;
  const effRaw = (process.env.OPENAI_CHAT_REASONING_EFFORT ?? 'medium').trim().toLowerCase();
  const reasoningEffort = effRaw === 'none' || effRaw === '' ? null : effRaw;
  return { apiKey, model, reasoningEffort };
}

export class OpenAIError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

/**
 * One streamed completion. Resolves when the stream ends; tool calls (if any)
 * are emitted as a single 'tool_calls' event once fully assembled.
 */
export async function* streamChatCompletion(opts: {
  messages: ChatMessage[];
  tools: unknown[];
  /** 'none' forces a final text answer (used on the last allowed round). */
  toolChoice?: 'auto' | 'none';
  signal?: AbortSignal;
}): AsyncGenerator<StreamEvent> {
  const cfg = chatConfig();
  if (!cfg) throw new OpenAIError('OPENAI_API_KEY is not set', 503);

  const body: Record<string, unknown> = {
    model: cfg.model,
    messages: opts.messages,
    tools: opts.tools,
    tool_choice: opts.toolChoice ?? 'auto',
    parallel_tool_calls: true,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (cfg.reasoningEffort) body.reasoning_effort = cfg.reasoningEffort;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  opts.signal?.addEventListener('abort', onAbort);

  try {
    const res = await fetch(chatUrl(), {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok || !res.body) {
      let msg = `OpenAI HTTP ${res.status}`;
      try { const j: any = await res.json(); if (j?.error?.message) msg = `OpenAI: ${j.error.message}`; } catch { /* keep default */ }
      throw new OpenAIError(msg, res.status === 401 || res.status === 429 ? res.status : 502);
    }

    // Tool-call fragments arrive keyed by index; arguments stream as pieces.
    const pending = new Map<number, ToolCall>();
    let finishReason: string | null = null;
    let usage: Usage | null = null;

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        let chunk: any;
        try { chunk = JSON.parse(data); } catch { continue; }
        if (chunk.usage) usage = chunk.usage;
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) finishReason = choice.finish_reason;
        const delta = choice.delta ?? {};
        if (typeof delta.content === 'string' && delta.content.length) {
          yield { type: 'text', delta: delta.content };
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const idx: number = tc.index ?? 0;
            let cur = pending.get(idx);
            if (!cur) {
              cur = { id: tc.id ?? `call_${idx}`, type: 'function', function: { name: '', arguments: '' } };
              pending.set(idx, cur);
            }
            if (tc.id) cur.id = tc.id;
            if (tc.function?.name) cur.function.name += tc.function.name;
            if (tc.function?.arguments) cur.function.arguments += tc.function.arguments;
          }
        }
      }
    }

    if (pending.size) {
      const calls = Array.from(pending.entries()).sort((a, b) => a[0] - b[0]).map(([, c]) => c);
      yield { type: 'tool_calls', calls };
    }
    yield { type: 'done', finishReason, usage };
  } catch (err: any) {
    if (err instanceof OpenAIError) throw err;
    if (err?.name === 'AbortError') {
      throw new OpenAIError(opts.signal?.aborted ? 'Request cancelled' : 'OpenAI request timed out', 504);
    }
    throw new OpenAIError(`OpenAI unreachable: ${err?.message ?? String(err)}`, 502);
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
}
