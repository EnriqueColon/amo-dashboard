/**
 * POST /api/chat and read its Server-Sent Events. Shared by the Ask the Data
 * page (a normal turn) and the table-row "Ask about this row" expansion (a
 * scoped follow-up rendered inside the table).
 */

export interface ChatHistoryMessage { role: 'user' | 'assistant'; content: string }

export interface ToolStep {
  id: string;
  name: string;
  args: Record<string, unknown>;
  purpose?: string;
  ms?: number;
  rows?: number;
  error?: string;
  result?: unknown;
  done: boolean;
}

export interface ChatUsage { prompt_tokens: number; completion_tokens: number; total_tokens: number }
export interface ChatMeta { model: string; rounds: number; usage: ChatUsage | null }

export interface ChatStreamHandlers {
  onDelta: (text: string) => void;
  onTool: (step: ToolStep) => void;
  onToolDone: (id: string, patch: Partial<ToolStep>) => void;
  onDone: (meta: ChatMeta) => void;
  onError: (message: string) => void;
}

export async function streamChat(
  body: { county: string; messages: ChatHistoryMessage[] },
  signal: AbortSignal,
  h: ChatStreamHandlers,
): Promise<void> {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    let msg = `${res.status} ${res.statusText}`;
    try { const j = await res.json(); if (j?.error) msg = j.error; } catch { /* ignore */ }
    throw new Error(msg);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      let event = 'message';
      let data = '';
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      if (!data) continue;
      let payload: any;
      try { payload = JSON.parse(data); } catch { continue; }

      if (event === 'delta') h.onDelta(payload.text);
      else if (event === 'tool') h.onTool({ id: payload.id, name: payload.name, args: payload.args ?? {}, purpose: payload.purpose, done: false });
      else if (event === 'tool_done') h.onToolDone(payload.id, { done: true, ms: payload.ms, rows: payload.rows, error: payload.error, result: payload.result });
      else if (event === 'done') h.onDone({ model: payload.model, rounds: payload.rounds, usage: payload.usage });
      else if (event === 'error') h.onError(payload.message);
    }
  }
}
