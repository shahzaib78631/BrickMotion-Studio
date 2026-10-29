import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** One inventory line of a set, as the Rebrickable API gives it, with LDraw ids where Rebrickable knows them. */
export type SetPart = {
  element: string | null;
  part: string;
  ldrawPart: string;
  color: number | null;
  colorName: string;
  quantity: number;
  spare: boolean;
  image: string | null;
};

export type Resolved = { part: string; color: number | null; flags: string[] };

export type FetchJson = (url: string, headers: Record<string, string>) => Promise<unknown>;

const API = 'https://rebrickable.com/api/v3/lego/sets/';

const defaultFetchJson: FetchJson = async (url, headers) => {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`Rebrickable request failed (${res.status}) for ${url.replace(/\?.*$/, '')}`);
  return res.json();
};

type Page = { results?: unknown[]; next?: string | null };

async function fetchAll(url: string, apiKey: string, fetchJson: FetchJson): Promise<unknown[]> {
  const rows: unknown[] = [];
  let next: string | null | undefined = url;
  while (next) {
    const page = (await fetchJson(next, { Authorization: `key ${apiKey}` })) as Page;
    rows.push(...(page.results ?? []));
    next = page.next;
  }
  return rows;
}

type Row = {
  element_id?: string | null;
  quantity?: number;
  is_spare?: boolean;
  part?: { part_num?: string; part_img_url?: string | null; external_ids?: { LDraw?: string[] } };
  color?: { name?: string; external_ids?: { LDraw?: { ext_ids?: number[] } } };
};

export function toSetPart(row: unknown): SetPart {
  const r = row as Row;
  const part = r.part?.part_num ?? '';
  const color = r.color?.external_ids?.LDraw?.ext_ids?.[0];
  return {
    element: r.element_id ?? null,
    part,
    ldrawPart: r.part?.external_ids?.LDraw?.[0] ?? part,
    color: typeof color === 'number' ? color : null,
    colorName: r.color?.name ?? '',
    quantity: r.quantity ?? 0,
    spare: !!r.is_spare,
    image: r.part?.part_img_url ?? null,
  };
}

export async function fetchSetParts(setNum: string, apiKey: string, fetchJson: FetchJson = defaultFetchJson): Promise<SetPart[]> {
  const rows = await fetchAll(`${API}${setNum}/parts/?page_size=1000&inc_color_details=1`, apiKey, fetchJson);
  return rows.map(toSetPart);
}

export async function fetchSubSets(setNum: string, apiKey: string, fetchJson: FetchJson = defaultFetchJson): Promise<{ setNum: string; quantity: number }[]> {
  const rows = await fetchAll(`${API}${setNum}/sets/?page_size=1000`, apiKey, fetchJson);
  return rows.map((r) => {
    const s = r as { set_num?: string; quantity?: number };
    return { setNum: s.set_num ?? '', quantity: s.quantity ?? 1 };
  });
}

/** The set's own parts plus every sub-set's parts (times how many of that sub-set), merged by element. */
export async function fetchSetInventory(setNum: string, apiKey: string, fetchJson: FetchJson = defaultFetchJson): Promise<SetPart[]> {
  const merged = new Map<string, SetPart>();
  const add = (p: SetPart, times: number) => {
    const key = `${p.element ?? `${p.part}/${p.colorName}`}|${p.spare}`;
    const prev = merged.get(key);
    if (prev) prev.quantity += p.quantity * times;
    else merged.set(key, { ...p, quantity: p.quantity * times });
  };
  const visit = async (num: string, times: number, seen: string[]) => {
    for (const p of await fetchSetParts(num, apiKey, fetchJson)) add(p, times);
    for (const sub of await fetchSubSets(num, apiKey, fetchJson)) {
      if (!sub.setNum || seen.includes(sub.setNum)) continue;
      await visit(sub.setNum, times * sub.quantity, [...seen, sub.setNum]);
    }
  };
  await visit(setNum, 1, [setNum]);
  return [...merged.values()];
}

export function resolveSetPart(p: SetPart, hasPart: (id: string) => boolean): Resolved {
  const flags: string[] = [];
  let part = p.ldrawPart;
  if (!hasPart(part)) {
    const plain = part.replace(/pr\d+[a-z]?$/i, '');
    if (plain !== part && hasPart(plain)) {
      flags.push(`${part} not in LDraw library; using unprinted ${plain}`);
      part = plain;
    } else flags.push(`${part} not in LDraw library`);
  }
  if (p.color === null) flags.push(`colour ${p.colorName} has no LDraw id`);
  return { part, color: p.color, flags };
}

const KEY_HELP = 'Set REBRICKABLE_API_KEY (free key from rebrickable.com/users/<you>/settings/#api)';

/** The set's inventory, from the cache file when present, else from the API (key from the environment only). */
export async function loadSetParts(setNum: string, cacheFile: string): Promise<SetPart[]> {
  if (existsSync(cacheFile)) return JSON.parse(readFileSync(cacheFile, 'utf8')) as SetPart[];
  const key = process.env.REBRICKABLE_API_KEY?.trim();
  if (!key) throw new Error(KEY_HELP);
  const parts = await fetchSetInventory(setNum, key);
  mkdirSync(dirname(cacheFile), { recursive: true });
  writeFileSync(cacheFile, JSON.stringify(parts, null, 1));
  return parts;
}
