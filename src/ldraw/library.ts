import { flattenPart, type FlatPart } from './flatten';
import { normalizeName, parseLDraw, type LDrawFile } from './parse';
import type { ShadowLookup, Snap } from './shadow';
import { embeddedPartId, sameGeometry } from './partAlias';
import { supplementarySnapsFor } from '../data/connectorLibrary';

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
  private remoteFiles = new Map<string, Promise<LDrawFile | null>>();
  private remoteResolved = new Map<string, LDrawFile | null>();
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

  /** Library-only fetch: inline copies must not shadow the geometry we compare against. */
  private fetchRemote(n: string): Promise<LDrawFile | null> {
    let p = this.remoteFiles.get(n);
    if (!p) {
      p = this.fetchFile(n).then((f) => {
        this.remoteResolved.set(n, f);
        return f;
      });
      this.remoteFiles.set(n, p);
    }
    return p;
  }

  private async preloadRemote(name: string, seen = new Set<string>()): Promise<LDrawFile | null> {
    const n = normalizeName(name);
    if (seen.has(n)) return this.remoteResolved.get(n) ?? null;
    seen.add(n);
    const f = await this.fetchRemote(n);
    if (f) {
      const refs = [...new Set(f.cmds.flatMap((c) => (c.t === 'ref' ? [c.file] : [])))];
      await Promise.all(refs.map((r) => this.preloadRemote(r, seen)));
    }
    return f;
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
        const rootName = `${key}.dat`;
        const root = await this.preload(rootName);
        if (!root) return null;
        const lookup = (n: string) => this.inline.get(n) ?? this.resolved.get(n) ?? null;
        const warn = (missing: string) => {
          if (!this.warned.has(missing)) {
            this.warned.add(missing);
            console.warn(`LDraw: missing sub-file ${missing}`);
          }
        };
        let flat = flattenPart(key, root, lookup, warn, this.shadow);
        // Embedded copies (e.g. "31039 - 13971.dat") are not library ids, so
        // their shadow and supplementary data is keyed to the part they copy.
        let alias: string | null = null;
        if (this.inline.has(rootName)) {
          const base = embeddedPartId(rootName);
          if (base && base !== key) {
            const baseRoot = await this.preloadRemote(`${base}.dat`);
            if (baseRoot) {
              const baseFlat = flattenPart(base, baseRoot, (n) => this.remoteResolved.get(n) ?? null, undefined, undefined);
              if (sameGeometry(flat, baseFlat)) {
                alias = base;
                if (this.shadow) {
                  const shadow = this.shadow;
                  const aliasShadow: ShadowLookup = (file) => shadow(file) ?? (normalizeName(file) === rootName ? shadow(`${base}.dat`) : null);
                  flat = flattenPart(key, root, lookup, warn, aliasShadow);
                }
              }
            }
          }
        }
        const extra = [...supplementarySnapsFor(key), ...(alias ? supplementarySnapsFor(alias) : [])];
        if (extra.length) {
          const snaps: Snap[] = flat.snaps ? [...flat.snaps] : [];
          // A shadow group is authoritative, including both of its genders.
          const keyOf = (s: Snap) => (s.group ?? '').toLowerCase() || `${s.kind}|${s.gender}`;
          const seen = new Set(snaps.map(keyOf));
          for (const snap of extra) {
            const k = keyOf(snap);
            if (seen.has(k)) continue;
            seen.add(k);
            snaps.push(snap);
          }
          flat = { ...flat, snaps };
        }
        return flat;
      })();
      this.parts.set(key, p);
    }
    return p;
  }
}
