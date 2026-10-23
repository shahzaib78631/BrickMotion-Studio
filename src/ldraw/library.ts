import { flattenPart, type FlatPart } from './flatten';
import { normalizeName, parseLDraw, type LDrawFile } from './parse';
import type { ShadowLookup } from './shadow';

export type FetchText = (path: string) => Promise<string | null>;

/** Browser FetchText for the library served at /ldraw/. */
export const browserFetchText: FetchText = async (path) => {
  try {
    const res = await fetch('/ldraw/' + path);
    if (res.status !== 200) return null;
    const text = await res.text();
    // Vite's dev server answers unknown paths with index.html
    return text.trimStart().startsWith('<') ? null : text;
  } catch {
    return null;
  }
};

export class PartLibrary {
  private files = new Map<string, Promise<LDrawFile | null>>();
  private resolved = new Map<string, LDrawFile | null>();
  private parts = new Map<string, Promise<FlatPart | null>>();
  private inline = new Map<string, LDrawFile>();
  private warned = new Set<string>();

  constructor(private fetchText: FetchText, private shadow?: ShadowLookup) {}

  /** Connector metadata (LDCad shadow library) for parts flattened from now on. */
  setShadow(shadow: ShadowLookup | undefined): void {
    this.shadow = shadow;
    this.parts.clear();
  }

  addInline(files: Map<string, LDrawFile>): void {
    for (const [k, v] of files) {
      const n = normalizeName(k);
      this.inline.set(n, v);
      this.parts.delete(n.replace(/\.dat$/, ''));
    }
  }

  getFile(name: string): Promise<LDrawFile | null> {
    const n = normalizeName(name);
    const inl = this.inline.get(n);
    if (inl) return Promise.resolve(inl);
    let p = this.files.get(n);
    if (!p) {
      p = this.fetchFile(n).then((f) => {
        this.resolved.set(n, f);
        return f;
      });
      this.files.set(n, p);
    }
    return p;
  }

  private async fetchFile(n: string): Promise<LDrawFile | null> {
    for (const path of [`parts/${n}`, `p/${n}`, `models/${n}`, n]) {
      const text = await this.fetchText(path);
      if (text !== null) return parseLDraw(text, n);
    }
    return null;
  }

  /** Loads a file and all its sub-files (in parallel) into the resolved cache. */
  private async preload(name: string, seen = new Set<string>()): Promise<LDrawFile | null> {
    const n = normalizeName(name);
    if (seen.has(n)) return this.resolved.get(n) ?? this.inline.get(n) ?? null;
    seen.add(n);
    const f = await this.getFile(n);
    if (f) {
      const refs = [...new Set(f.cmds.flatMap((c) => (c.t === 'ref' ? [c.file] : [])))];
      await Promise.all(refs.map((r) => this.preload(r, seen)));
    }
    return f;
  }

  loadPart(id: string): Promise<FlatPart | null> {
    const key = normalizeName(id).replace(/\.dat$/, '');
    let p = this.parts.get(key);
    if (!p) {
      p = (async () => {
        const root = await this.preload(`${key}.dat`);
        if (!root) return null;
        return flattenPart(key, root, (n) => this.inline.get(n) ?? this.resolved.get(n) ?? null, (missing) => {
          if (!this.warned.has(missing)) {
            this.warned.add(missing);
            console.warn(`LDraw: missing sub-file ${missing}`);
          }
        }, this.shadow);
      })();
      this.parts.set(key, p);
    }
    return p;
  }
}
