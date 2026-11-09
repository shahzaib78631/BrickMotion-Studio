import { AiError } from './claude';

/**
 * Claude through the dev server's bridge (scripts/claude-bridge.ts), which runs the local
 * Claude Code CLI with the user's own Claude login: no API key needed. It is there only
 * while `npm run dev` runs.
 */

const URL = '/api/claude';

let ready: Promise<boolean> | null = null;

/** Whether the bridge is there and the CLI works (checked once per page load). */
export function bridgeAvailable(): Promise<boolean> {
  ready ??= fetch(URL)
    .then(async (r) => r.ok && (r.headers.get('content-type') ?? '').includes('application/json') && (await r.json()).ready === true)
    .catch(() => false);
  return ready;
}

/** The CLI's short model names, for an API model id ('claude-sonnet-5-5' → 'sonnet'). */
export function cliModel(model: string): string {
  return /opus/.test(model) ? 'opus' : /haiku/.test(model) ? 'haiku' : /fable/.test(model) ? 'fable' : 'sonnet';
}

export type BridgeAsk = {
  system: string;
  prompt: string;
  /** JSON schema the answer must match */
  schema: object;
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  signal?: AbortSignal;
};

/** One answer from Claude, as JSON matching the schema. */
export async function askBridge(a: BridgeAsk): Promise<{ output: unknown; cost?: number }> {
  let r: Response;
  try {
    r = await fetch(URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ system: a.system, prompt: a.prompt, schema: a.schema, model: cliModel(a.model ?? 'sonnet'), effort: a.effort }),
      signal: a.signal,
    });
  } catch (e) {
    if (a.signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    throw new AiError('network', `Could not reach the Claude bridge: ${e instanceof Error ? e.message : String(e)}`);
  }
  const body = (await r.json().catch(() => ({}))) as { ok?: boolean; output?: unknown; cost?: number; message?: string };
  if (!r.ok || !body.ok) throw new AiError('network', body.message ? `Claude: ${body.message}` : `The Claude bridge answered ${r.status}.`);
  return { output: body.output, cost: body.cost };
}
