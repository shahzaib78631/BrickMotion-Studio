/**
 * The Bricksafe finder (scripts/find_bricksafe_models.py) through the dev server's bridge
 * (scripts/bricksafe-bridge.ts). The scrape runs server-side, so it is available only while
 * `npm run dev` runs; the panel shows a hint when the bridge is missing.
 */

const ENDPOINT = '/api/bricksafe';

export type BricksafePage = { url: string; extensions: string[]; files: string[] };
export type BricksafeResult = {
  target: number;
  found: number;
  candidates: number;
  rounds: number;
  updatedAt: string;
  complete: boolean;
  pages: BricksafePage[];
};
export type BricksafeStatus = { ready: boolean; message?: string; running: boolean; result: BricksafeResult | null; log: string[] };

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** Keeps only what the panel can show; the results file is written by another process. */
export function sanitizeResult(raw: unknown): BricksafeResult | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const pages: BricksafePage[] = [];
  for (const entry of Array.isArray(o.pages) ? o.pages : []) {
    if (!entry || typeof entry !== 'object') continue;
    const p = entry as Record<string, unknown>;
    if (typeof p.url !== 'string' || !p.url) continue;
    const files = strings(p.files);
    if (!files.length) continue;
    pages.push({ url: p.url, extensions: strings(p.extensions), files });
  }
  return {
    target: num(o.target), found: num(o.found), candidates: num(o.candidates), rounds: num(o.rounds),
    updatedAt: typeof o.updatedAt === 'string' ? o.updatedAt : '', complete: o.complete === true, pages,
  };
}

function sanitizeStatus(raw: unknown): BricksafeStatus {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    ready: o.ready === true,
    message: typeof o.message === 'string' ? o.message : undefined,
    running: o.running === true,
    result: sanitizeResult(o.result),
    log: strings(o.log),
  };
}

async function call(init?: RequestInit): Promise<BricksafeStatus & { ok?: boolean }> {
  const r = await fetch(ENDPOINT, init).catch((e: unknown) => {
    throw new Error(`Could not reach the dev server: ${e instanceof Error ? e.message : String(e)}`);
  });
  // an unknown /api route falls back to index.html, so insist on JSON
  if (!r.ok || !(r.headers.get('content-type') ?? '').includes('application/json')) {
    throw new Error(`The Bricksafe bridge is not available (answered ${r.status}). Run the app with "npm run dev".`);
  }
  return sanitizeStatus(await r.json());
}

export const bricksafeStatus = () => call();
export const bricksafeScan = (target?: number) =>
  call({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'scan', target }) });
export const bricksafeStop = () =>
  call({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'stop' }) });

/** The file extension a model URL ends in, lower-case, without the dot. */
export function fileExtension(url: string): string {
  const name = (url.split(/[?#]/)[0] ?? '').split('/').pop() ?? '';
  const m = /\.([a-z0-9]+)$/i.exec(name);
  return m ? m[1].toLowerCase() : '';
}

/** A page's readable name: its path under /pages/, decoded. */
export function pageLabel(url: string): string {
  try {
    const path = decodeURIComponent(new URL(url).pathname).replace(/^\/pages\//, '').replace(/\/+$/, '');
    return path || url;
  } catch {
    return url;
  }
}

/** A file's readable name: its last path segment, decoded. */
export function fileName(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname.split('/').pop() ?? url);
  } catch {
    return url;
  }
}

/** Every file URL in the pages, in order. */
export const allFileLinks = (pages: BricksafePage[]): string[] => pages.flatMap((p) => p.files);

/** Every extension present across the pages, most common first. */
export function usedExtensions(pages: BricksafePage[]): string[] {
  const counts = new Map<string, number>();
  for (const page of pages) for (const file of page.files) {
    const ext = fileExtension(file);
    if (ext) counts.set(ext, (counts.get(ext) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([ext]) => ext);
}

/** Pages matching the text (page or file URL) and carrying at least one of `extensions`. */
export function filterPages(pages: BricksafePage[], query: string, extensions: readonly string[]): BricksafePage[] {
  const q = query.trim().toLowerCase();
  const want = new Set(extensions);
  const out: BricksafePage[] = [];
  for (const page of pages) {
    if (q && !page.url.toLowerCase().includes(q) && !page.files.some((f) => f.toLowerCase().includes(q))) continue;
    const files = want.size ? page.files.filter((f) => want.has(fileExtension(f))) : page.files;
    if (!files.length) continue;
    out.push({ url: page.url, extensions: page.extensions, files });
  }
  return out;
}
