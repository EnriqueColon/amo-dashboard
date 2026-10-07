/**
 * "Ask the Data" — POST /api/chat
 *
 * A conversational interface over the AMO database. The browser sends the
 * visible conversation (user/assistant text only); this route rebuilds the
 * full prompt, runs the model in a tool-calling loop against server/chat/tools.ts,
 * and streams progress back as Server-Sent Events:
 *
 *   event: tool       {id, name, args, purpose?}         a tool call started
 *   event: tool_done  {id, ms, rows?, error?}             it finished
 *   event: delta      {text}                              answer text, as it streams
 *   event: done       {model, rounds, usage}              end of turn
 *   event: error      {message}                           fatal; the stream ends
 *
 * Registered inside registerRoutes (after app.use(checkAuth) in server/index.ts),
 * so it is login-gated like every other /api route. The OpenAI key never
 * reaches the browser. Nothing here is cached — a question should always see
 * the database as it is now.
 */

import type { Express, Request, Response } from 'express';
import { getDb } from '../db';
import { buildSystemPrompt } from './prompt';
import { TOOLS_BY_NAME, executeTool, serializeToolResult, toolDefinitions } from './tools';
import { chatConfig, streamChatCompletion, OpenAIError, type ChatMessage, type ToolCall, type Usage } from './openai';

const MAX_ROUNDS = 8;           // tool-call rounds per user turn
const MAX_HISTORY = 40;         // messages accepted from the client
const MAX_MESSAGE_CHARS = 8_000;

export const CHAT_UNCONFIGURED_MESSAGE =
  'Ask the Data is not configured — set OPENAI_API_KEY in the server environment and restart.';

export function warnIfChatUnconfigured(log: (msg: string, source?: string) => void) {
  if (!chatConfig()) log('WARNING: OPENAI_API_KEY not set — Ask the Data (/api/chat) will return 503 until configured', 'chat');
}

interface ClientMessage { role: 'user' | 'assistant'; content: string }

function parseClientMessages(raw: unknown): ClientMessage[] | string {
  if (!Array.isArray(raw) || raw.length === 0) return 'messages must be a non-empty array';
  if (raw.length > MAX_HISTORY) return `at most ${MAX_HISTORY} messages are accepted; start a new chat`;
  const out: ClientMessage[] = [];
  for (const m of raw) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string') {
      return 'each message needs role user|assistant and string content';
    }
    const content = m.content.trim();
    if (content.length > MAX_MESSAGE_CHARS) return `a message exceeds ${MAX_MESSAGE_CHARS} characters`;
    if (content) out.push({ role: m.role, content });
  }
  if (!out.length || out[out.length - 1].role !== 'user') return 'the last message must be from the user';
  return out;
}

function sse(res: Response, event: string, data: unknown) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function summarizeResult(result: unknown): { rows?: number; error?: string } {
  if (!result || typeof result !== 'object') return {};
  const r = result as any;
  const out: { rows?: number; error?: string } = {};
  if (typeof r.error === 'string') out.error = r.error;
  const arr = r.rows ?? r.matches;
  if (Array.isArray(arr)) out.rows = typeof r.row_count === 'number' ? r.row_count : arr.length;
  return out;
}

function addUsage(a: Usage | null, b: Usage | null): Usage | null {
  if (!a) return b; if (!b) return a;
  return { prompt_tokens: a.prompt_tokens + b.prompt_tokens, completion_tokens: a.completion_tokens + b.completion_tokens, total_tokens: a.total_tokens + b.total_tokens };
}

export function registerChatRoutes(app: Express) {
  const db = getDb();
  const latestDate = db.prepare(`SELECT MAX(rec_date) AS d FROM assignments WHERE rec_date IS NOT NULL AND rec_date <> ''`);

  app.get('/api/chat/config', (_req: Request, res: Response) => {
    const cfg = chatConfig();
    res.json({
      configured: !!cfg,
      model: cfg?.model ?? null,
      reasoning_effort: cfg?.reasoningEffort ?? null,
      tools: Array.from(TOOLS_BY_NAME.keys()),
      message: cfg ? null : CHAT_UNCONFIGURED_MESSAGE,
    });
  });

  app.post('/api/chat', async (req: Request, res: Response) => {
    const cfg = chatConfig();
    if (!cfg) { res.status(503).json({ error: CHAT_UNCONFIGURED_MESSAGE }); return; }

    const parsed = parseClientMessages(req.body?.messages);
    if (typeof parsed === 'string') { res.status(400).json({ error: parsed }); return; }

    const countyRaw = String(req.body?.county ?? '').trim().toUpperCase();
    const county = countyRaw === 'BROWARD' || countyRaw === 'ALL' ? countyRaw : 'MIAMI-DADE';

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    // Abort the OpenAI call if the browser goes away mid-stream (Stop button,
    // closed tab). Listened on `res`, not `req`: since Node 16 the request's
    // 'close' fires as soon as its body has been consumed — i.e. immediately
    // after express.json() — which would cancel every chat before it started.
    const abort = new AbortController();
    res.on('close', () => { if (!res.writableFinished) abort.abort(); });

    const dataThrough = (latestDate.get() as any)?.d ?? undefined;
    const messages: ChatMessage[] = [
      { role: 'system', content: buildSystemPrompt({ county, today: new Date().toISOString().slice(0, 10), dataThrough }) },
      ...parsed.map(m => ({ role: m.role, content: m.content }) as ChatMessage),
    ];
    const tools = toolDefinitions();

    let usage: Usage | null = null;
    let rounds = 0;
    const t0 = Date.now();
    const toolLog: string[] = [];

    try {
      for (let round = 0; round < MAX_ROUNDS; round++) {
        rounds = round + 1;
        const last = round === MAX_ROUNDS - 1;
        let text = '';
        let calls: ToolCall[] = [];
        let finishReason: string | null = null;

        for await (const ev of streamChatCompletion({ messages, tools, toolChoice: last ? 'none' : 'auto', signal: abort.signal })) {
          if (ev.type === 'text') { text += ev.delta; sse(res, 'delta', { text: ev.delta }); }
          else if (ev.type === 'tool_calls') calls = ev.calls;
          else if (ev.type === 'done') { usage = addUsage(usage, ev.usage); finishReason = ev.finishReason; }
        }

        if (!calls.length) {
          // A stream that closed without a finish_reason and without content is
          // an upstream failure (dropped connection, proxy reset), not an answer.
          if (!text && !finishReason) throw new OpenAIError('OpenAI returned an empty response — please try again', 502);
          break;
        }

        messages.push({ role: 'assistant', content: text || null, tool_calls: calls });
        for (const call of calls) {
          if (abort.signal.aborted) break;
          let args: any = {};
          try { args = JSON.parse(call.function.arguments || '{}'); } catch { /* reported by executeTool */ }
          sse(res, 'tool', { id: call.id, name: call.function.name, args, purpose: typeof args?.purpose === 'string' ? args.purpose : undefined });
          const { result, ms } = executeTool(db, call.function.name, call.function.arguments);
          const summary = summarizeResult(result);
          toolLog.push(`${call.function.name}(${ms}ms${summary.rows !== undefined ? `, ${summary.rows} rows` : ''}${summary.error ? ', error' : ''})`);
          sse(res, 'tool_done', { id: call.id, ms, ...summary });
          messages.push({ role: 'tool', tool_call_id: call.id, content: serializeToolResult(result) });
        }
        if (abort.signal.aborted) break;
      }

      sse(res, 'done', { model: cfg.model, rounds, usage });
      console.log(`[chat] ${cfg.model} rounds=${rounds} tokens=${usage?.total_tokens ?? '?'} (${usage?.prompt_tokens ?? '?'} in / ${usage?.completion_tokens ?? '?'} out) ${Date.now() - t0}ms tools=[${toolLog.join(', ')}]`);
    } catch (err: any) {
      if (abort.signal.aborted) { /* client went away — nothing to report */ }
      else {
        const message = err instanceof OpenAIError ? err.message : `Chat failed: ${err?.message ?? String(err)}`;
        console.error('[chat] error:', message);
        sse(res, 'error', { message });
      }
    } finally {
      res.end();
    }
  });
}
