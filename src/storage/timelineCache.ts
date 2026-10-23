import { del, get, set } from 'idb-keyval';
import type { EncodedTimeline } from '../anim/timelineData';
import type { Plan } from '../plan/types';

/** Bump when the planner's output changes, so stale timelines are planned again. */
export const TIMELINE_CACHE_VERSION = 2;
const MAX_ENTRIES = 40;
const INDEX = 'timelines:index';
const entryKey = (k: string) => `timeline:${k}`;

/** Everything a planned timeline depends on. Same inputs → same timeline. */
export type TimelineInputs = { plan: Plan; model: string; opts: string; shadow: boolean };

/** A stable fingerprint of the inputs (SHA-256, hex). */
export async function timelineFingerprint(inputs: TimelineInputs): Promise<string> {
  const text = JSON.stringify({ v: TIMELINE_CACHE_VERSION, model: inputs.model, opts: inputs.opts, shadow: inputs.shadow, plan: inputs.plan });
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

type IndexEntry = { key: string; usedAt: number };
const readIndex = async () => (await get<IndexEntry[]>(INDEX)) ?? [];

export async function getCachedTimeline(key: string): Promise<EncodedTimeline | null> {
  const hit = (await get<EncodedTimeline>(entryKey(key))) ?? null;
  if (hit) await set(INDEX, [...(await readIndex()).filter((e) => e.key !== key), { key, usedAt: Date.now() }]);
  return hit;
}

/** Stores a timeline and forgets the least recently used ones beyond MAX_ENTRIES. */
export async function putCachedTimeline(key: string, timeline: EncodedTimeline): Promise<void> {
  await set(entryKey(key), timeline);
  const index = [...(await readIndex()).filter((e) => e.key !== key), { key, usedAt: Date.now() }].sort((a, b) => b.usedAt - a.usedAt);
  for (const old of index.slice(MAX_ENTRIES)) await del(entryKey(old.key));
  await set(INDEX, index.slice(0, MAX_ENTRIES));
}
