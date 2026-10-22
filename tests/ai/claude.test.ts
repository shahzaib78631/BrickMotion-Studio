import { AuthenticationError } from '@anthropic-ai/sdk';
import type Anthropic from '@anthropic-ai/sdk';
import { expect, test, vi } from 'vitest';
import { generatePlan } from '../../src/ai/claude';

const validText = JSON.stringify({
  name: 'Tug',
  description: 'small boat',
  steps: [{ pieces: [{ part: '3001', color: 'Red', x: 0, y: 0, z: 0, rot: 0 }] }],
  submodels: [],
});

const fakeClient = (msg: unknown, onStream?: (body: Record<string, unknown>) => void) =>
  ({
    beta: {
      messages: {
        stream: (body: Record<string, unknown>) => {
          onStream?.(body);
          return { finalMessage: async () => msg };
        },
      },
    },
  }) as unknown as Anthropic;

const args = { apiKey: 'k', model: 'claude-opus-5-5', system: 'sys', user: 'make a tug' };
const msg = (stop_reason: string, text: string) => ({ stop_reason, content: [{ type: 'thinking', thinking: '' }, { type: 'text', text }] });

test('max_tokens → truncated', async () => {
  await expect(generatePlan(args, { createClient: () => fakeClient(msg('max_tokens', '{')) })).rejects.toMatchObject({ kind: 'truncated' });
});

test('refusal → refusal', async () => {
  await expect(generatePlan(args, { createClient: () => fakeClient(msg('refusal', '')) })).rejects.toMatchObject({ kind: 'refusal' });
});

test('valid JSON → Plan, with the decided request shape', async () => {
  const seen = vi.fn();
  const plan = await generatePlan(args, { createClient: () => fakeClient(msg('end_turn', validText), seen) });
  expect(plan.format).toBe('brickmotion-plan');
  expect(plan.name).toBe('Tug');
  const body = seen.mock.calls[0][0];
  expect(body).toMatchObject({ model: 'claude-opus-5-5', thinking: { type: 'adaptive' }, fallbacks: 'default', betas: ['server-side-fallback-2026-07-01'], system: 'sys' });
  expect(body.output_config).toMatchObject({ effort: 'high' });
  expect(body.output_config.format).toBeTruthy();
});

test('broken JSON → invalid', async () => {
  await expect(generatePlan(args, { createClient: () => fakeClient(msg('end_turn', '{oops')) })).rejects.toMatchObject({ kind: 'invalid' });
});

test('a bad key → auth', async () => {
  const client = {
    beta: {
      messages: {
        stream: () => {
          throw new AuthenticationError(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, 'invalid x-api-key', new Headers());
        },
      },
    },
  } as unknown as Anthropic;
  await expect(generatePlan(args, { createClient: () => client })).rejects.toMatchObject({ kind: 'auth' });
});
