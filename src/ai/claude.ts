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

const defaultClient = (apiKey: string) => new Anthropic({ apiKey, dangerouslyAllowBrowser: true });

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
    if (e instanceof APIUserAbortError || args.signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    if (e instanceof AuthenticationError) throw new AiError('auth', 'Claude rejected the API key. Check it in Settings.');
    if (e instanceof APIConnectionError) throw new AiError('network', 'Could not reach the Claude API. Check your connection.');
    if (e instanceof APIError) throw new AiError('network', e.message);
    throw e;
  }
  if (msg.stop_reason === 'refusal') throw new AiError('refusal', 'Claude declined this request. Try a different idea.');
  if (msg.stop_reason === 'max_tokens') throw new AiError('truncated', 'The plan was too long and got cut off. Ask for fewer pieces.');
  const text = msg.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new AiError('invalid', 'Claude returned something that is not valid JSON.');
  }
  const parsed = AiPlanSchema.safeParse(json);
  if (!parsed.success) throw new AiError('invalid', `The plan did not match the expected format: ${parsed.error.issues[0]?.message ?? ''}`);
  return aiPlanToPlan(parsed.data);
}
