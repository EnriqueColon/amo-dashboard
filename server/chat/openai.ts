/**
 * Minimal OpenAI **Responses API** streaming client (no SDK — one fetch, the
 * same way collector/extract_pdfs.py talks to the API).
 *
 * Why Responses and not Chat Completions: GPT-6 Astra (and GPT-6.1 Sol)
 * refuse function tools together with reasoning on /v1/chat/completions —
 * the first real production call on 7 Oct 2026 came back with exactly that
 * error. Reasoning models also require the reasoning items they emit alongside
 * tool calls to be passed back with the tool outputs; chaining each round with
 * `previous_response_id` makes the API carry that state itself.
 *
 * Configuration (process.env):
 *   OPENAI_API_KEY                 required
 *   OPENAI_CHAT_MODEL              default 'gpt-6-astra' (OpenAI's flagship, Sept 2026)
 *   OPENAI_CHAT_REASONING_EFFORT   low | medium | high | xhigh | max | none (default medium;
 *                                  'none' omits the reasoning parameter entirely)
 *   OPENAI_BASE_URL                default https://api.openai.com/v1 (an OpenAI-compatible
 *                                  gateway or a local mock for testing)
 */

export const DEFAULT_CHAT_MODEL = 'gpt-6-astra';
const REQUEST_TIMEOUT_MS = 180_000;

function responsesUrl(): string {
  const base = (process.env.OPENAI_BASE_URL ?? '').trim().replace(/\/+$/, '') || 'https://api.openai.com/v1';
  return `${base}/responses`;
}

/** Items accepted in `input`. The first round sends the conversation; later rounds send tool outputs. */
export type InputItem =
  | { role: 'user' | 'assistant'; content: string }
  | { type: 'function_call_output'; call_id: string; output: string };

export interface ToolCall {
  /** The model's call_id — echoed back in function_call_output. */
  callId: string;
  name: string;
  arguments: string;
}

export interface Usage { prompt_tokens: number; completion_tokens: number; total_tokens: number }

export type StreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_calls'; calls: ToolCall[] }
  | { type: 'done'; responseId: string | null; status: string | null; usage: Usage | null };

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
 * One streamed response. Resolves when the stream ends; tool calls (if any)
 * are emitted as a single 'tool_calls' event once their arguments are final.
 */
export async function* streamResponse(opts: {
  instructions: string;
  input: InputItem[];
  tools: unknown[];
  /** Chain onto the previous round so the API carries reasoning + tool-call state. */
  previousResponseId?: string | null;
  /** 'none' forces a final text answer (used on the last allowed round). */
  toolChoice?: 'auto' | 'none';
  signal?: AbortSignal;
}): AsyncGenerator<StreamEvent> {
  const cfg = chatConfig();
  if (!cfg) throw new OpenAIError('OPENAI_API_KEY is not set', 503);

  const body: Record<string, unknown> = {
    model: cfg.model,
    instructions: opts.instructions,
    input: opts.input,
    tools: opts.tools,
    tool_choice: opts.toolChoice ?? 'auto',
    parallel_tool_calls: true,
    stream: true,
    store: true, // required for previous_response_id chaining
  };
  if (opts.previousResponseId) body.previous_response_id = opts.previousResponseId;
  if (cfg.reasoningEffort) body.reasoning = { effort: cfg.reasoningEffort };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  opts.signal?.addEventListener('abort', onAbort);

  try {
    const res = await fetch(responsesUrl(), {
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

    // function_call items arrive as output_item.added, then argument deltas
    // keyed by item_id, then function_call_arguments.done with the final JSON.
    const pending = new Map<string, ToolCall>();
    let responseId: string | null = null;
    let status: string | null = null;
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
        if (!line.startsWith('data:')) continue; // 'event:' lines duplicate ev.type; ignore
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        let ev: any;
        try { ev = JSON.parse(data); } catch { continue; }

        switch (ev.type) {
          case 'response.output_text.delta':
            if (typeof ev.delta === 'string' && ev.delta.length) yield { type: 'text', delta: ev.delta };
            break;
          case 'response.output_item.added':
            if (ev.item?.type === 'function_call') {
              pending.set(ev.item.id, { callId: ev.item.call_id, name: ev.item.name ?? '', arguments: ev.item.arguments ?? '' });
            }
            break;
          case 'response.function_call_arguments.delta': {
            const cur = pending.get(ev.item_id);
            if (cur && typeof ev.delta === 'string') cur.arguments += ev.delta;
            break;
          }
          case 'response.function_call_arguments.done': {
            const cur = pending.get(ev.item_id);
            if (cur) {
              if (typeof ev.arguments === 'string') cur.arguments = ev.arguments;
              if (typeof ev.name === 'string' && ev.name) cur.name = ev.name;
            }
            break;
          }
          case 'response.output_item.done':
            // Safety net: a function_call item completing without the
            // arguments.done event (seen on some gateways) still gets its final
            // arguments from the item itself.
            if (ev.item?.type === 'function_call') {
              const cur = pending.get(ev.item.id);
              if (cur) {
                if (typeof ev.item.arguments === 'string' && ev.item.arguments) cur.arguments = ev.item.arguments;
                if (ev.item.call_id) cur.callId = ev.item.call_id;
                if (ev.item.name) cur.name = ev.item.name;
              } else {
                pending.set(ev.item.id, { callId: ev.item.call_id, name: ev.item.name ?? '', arguments: ev.item.arguments ?? '' });
              }
            }
            break;
          case 'response.completed':
          case 'response.incomplete':
            responseId = ev.response?.id ?? responseId;
            status = ev.response?.status ?? (ev.type === 'response.completed' ? 'completed' : 'incomplete');
            if (ev.response?.usage) {
              const u = ev.response.usage;
              usage = { prompt_tokens: u.input_tokens ?? 0, completion_tokens: u.output_tokens ?? 0, total_tokens: u.total_tokens ?? ((u.input_tokens ?? 0) + (u.output_tokens ?? 0)) };
            }
            break;
          case 'response.failed':
            throw new OpenAIError(`OpenAI: ${ev.response?.error?.message ?? 'response failed'}`, 502);
          case 'error':
            throw new OpenAIError(`OpenAI: ${ev.message ?? ev.error?.message ?? 'stream error'}`, 502);
          default:
            break; // created, in_progress, reasoning summaries, content parts, etc.
        }
      }
    }

    if (pending.size) yield { type: 'tool_calls', calls: Array.from(pending.values()) };
    yield { type: 'done', responseId, status, usage };
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
