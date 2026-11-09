import Anthropic, { APIConnectionError, APIError, APIUserAbortError, AuthenticationError } from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { Plan } from '../plan/types';
import { aiPlanToPlan, AiPlanSchema } from './schema';

export type AiErrorKind = 'refusal' | 'truncated' | 'invalid' | 'network' | 'auth';

export class AiError extends Error {
  constructor(
    public kind: AiErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'AiError';
  }
}

export const AI_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1'] as const;

/** The SDK's errors as the app's: cancelled, bad key, no connection. */
export function aiErrorFrom(e: unknown, signal?: AbortSignal): unknown {
  if (e instanceof APIUserAbortError || signal?.aborted) return new DOMException('Cancelled', 'AbortError');
  if (e instanceof AuthenticationError) return new AiError('auth', 'Claude rejected the API key. Check it in Settings.');
  if (e instanceof APIConnectionError) return new AiError('network', 'Could not reach the Claude API. Check your connection.');
  if (e instanceof APIError) return new AiError('network', e.message);
  return e;
}

/** Stop reasons that leave no usable answer. */
export function checkStop(msg: { stop_reason: string | null }, tooLong: string): void {
  if (msg.stop_reason === 'refusal') throw new AiError('refusal', 'Claude declined this request. Try a different idea.');
  if (msg.stop_reason === 'max_tokens') throw new AiError('truncated', tooLong);
}

/** The reply's text, parsed as JSON. */
export function jsonText(msg: { content: { type: string; text?: string }[] }): unknown {
  const text = msg.content.flatMap((b) => (b.type === 'text' && b.text !== undefined ? [b.text] : [])).join('');
  try {
    return JSON.parse(text);
  } catch {
    throw new AiError('invalid', 'Claude returned something that is not valid JSON.');
  }
}

export const defaultClient = (apiKey: string) => new Anthropic({ apiKey, dangerouslyAllowBrowser: true });

export async function generatePlan(
  args: { apiKey: string; model: string; system: string; user: string; signal?: AbortSignal },
  deps: { createClient?: (apiKey: string) => Anthropic } = {},
): Promise<Plan> {
  const client = (deps.createClient ?? defaultClient)(args.apiKey);
  let msg;
  try {
    const stream = client.beta.messages.stream(
      {
        model: args.model,
        max_tokens: 64000,
        thinking: { type: 'adaptive' },
        output_config: { effort: 'high', format: zodOutputFormat(AiPlanSchema) },
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        system: args.system,
        messages: [{ role: 'user', content: args.user }],
      },
      { signal: args.signal },
    );
    msg = await stream.finalMessage();
  } catch (e) {
    throw aiErrorFrom(e, args.signal);
  }
  checkStop(msg, 'The plan was too long and got cut off. Ask for fewer pieces.');
  const json = jsonText(msg);
  const parsed = AiPlanSchema.safeParse(json);
  if (!parsed.success) throw new AiError('invalid', `The plan did not match the expected format: ${parsed.error.issues[0]?.message ?? ''}`);
  return aiPlanToPlan(parsed.data);
}
