/** Recently added parts, newest first — the Parts panel's Recent tab. */
const KEY = 'bm.recentParts';
const MAX = 30;

export function recentPartIds(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x) : [];
  } catch {
    return [];
  }
}

export function recordRecentPart(id: string): void {
  if (!id) return;
  const next = [id, ...recentPartIds().filter((x) => x !== id)].slice(0, MAX);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable */
  }
}
