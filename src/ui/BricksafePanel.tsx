import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  allFileLinks, bricksafeScan, bricksafeStatus, bricksafeStop, fileExtension, fileName, filterPages,
  pageLabel, usedExtensions, type BricksafeStatus,
} from '../state/bricksafe';
import { Ic } from './icons';
import { PaneHead } from './PaneHead';

const TARGETS = [25, 50, 100, 250];

/** `2026-11-10T18:35:04+00:00` → `18:35`. */
function clockTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

const Link = ({ href, children, title }: { href: string; children: React.ReactNode; title?: string }) => (
  <a href={href} target="_blank" rel="noreferrer noopener" title={title ?? href}>{children}</a>
);

/** Finds Bricksafe pages that publish model files, and lists them with clickable links. */
export function BricksafePanel() {
  const [status, setStatus] = useState<BricksafeStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [target, setTarget] = useState(100);
  const [query, setQuery] = useState('');
  const [extensions, setExtensions] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setStatus(await bricksafeStatus());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  // follow a running scan: the bridge reads the script's results file on every call
  useEffect(() => {
    if (!status?.running) return;
    const id = setInterval(() => void refresh(), 3000);
    return () => clearInterval(id);
  }, [status?.running, refresh]);

  const pages = useMemo(() => status?.result?.pages ?? [], [status]);
  const shown = useMemo(() => filterPages(pages, query, extensions), [pages, query, extensions]);
  const available = useMemo(() => usedExtensions(pages), [pages]);
  const fileCount = useMemo(() => shown.reduce((n, p) => n + p.files.length, 0), [shown]);

  const act = async (work: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await work();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const copyLinks = () => {
    void navigator.clipboard.writeText(allFileLinks(shown).join('\n')).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }, () => setError('Could not copy to the clipboard.'));
  };

  const running = status?.running === true;
  const ready = status?.ready === true;
  const result = status?.result ?? null;
  const updated = clockTime(result?.updatedAt ?? '');

  return (
    <div className="nx-pane">
      <PaneHead id="bricksafe" title="Bricksafe models" count={pages.length ? pages.length.toLocaleString() : undefined}
        help="Finds Bricksafe pages that publish LEGO model files (.io, .ldr, .mpd, .lxf). Page and file names open in a new tab. The scan runs on the dev server, so it needs the app started with npm run dev." />

      <div className="bm-bricksafe-controls">
        {running
          ? <button className="nx-btn" disabled={busy} onClick={() => void act(bricksafeStop)}><Ic name="x" /> Stop</button>
          : <button className="nx-btn" disabled={busy || !ready} onClick={() => void act(() => bricksafeScan(target))}><Ic name="search" /> Find models</button>}
        <select aria-label="How many pages to find" value={target} disabled={running} onChange={(e) => setTarget(Number(e.target.value))}>
          {TARGETS.map((n) => <option key={n} value={n}>{n} pages</option>)}
        </select>
      </div>

      {!status && !error && <p className="nx-hint">Checking the finder…</p>}
      {error && <p className="nx-hint bm-bricksafe-error">{error}</p>}
      {status && !ready && !error && <p className="nx-hint">{status.message ?? 'The finder is not available on this server.'}</p>}

      {running && (
        <p className="nx-hint bm-bricksafe-live">
          Scanning · {result?.found ?? 0}/{target} pages{result?.rounds ? ` · round ${result.rounds}` : ''}…
        </p>
      )}

      {pages.length > 0 && (
        <>
          <input type="search" aria-label="Filter pages and files" placeholder="Filter pages and files…" value={query} onChange={(e) => setQuery(e.target.value)} />
          <div className="bm-bricksafe-exts" role="group" aria-label="File types">
            {available.map((ext) => {
              const on = extensions.includes(ext);
              return (
                <button key={ext} className={`bm-chip ${on ? 'on' : ''}`} aria-pressed={on}
                  onClick={() => setExtensions(on ? extensions.filter((x) => x !== ext) : [...extensions, ext])}>
                  .{ext}
                </button>
              );
            })}
          </div>
          <div className="nx-sub bm-bricksafe-summary" title={updated ? `Updated ${updated}` : undefined}>
            <span>
              {shown.length} page{shown.length === 1 ? '' : 's'} · {fileCount} file{fileCount === 1 ? '' : 's'}
            </span>
            <button className="nx-link bm-bricksafe-copy" onClick={copyLinks} disabled={!fileCount}>
              <Ic name="copy" /> {copied ? 'Copied' : 'Copy links'}
            </button>
          </div>
          <ul className="bm-bricksafe-list">
            {shown.map((page) => (
              <li key={page.url} className="bm-bricksafe-page">
                <div className="bm-bricksafe-head">
                  <Link href={page.url}>{pageLabel(page.url)}</Link>
                  <span className="bm-bricksafe-count" title={`${page.files.length} file${page.files.length === 1 ? '' : 's'} on this page`}>{page.files.length}</span>
                </div>
                <ul className="bm-bricksafe-files">
                  {page.files.map((file) => (
                    <li key={file}>
                      <Link href={file}>{fileName(file)}</Link>
                      <span className="bm-bricksafe-ext">.{fileExtension(file)}</span>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
            {shown.length === 0 && <p className="nx-hint">No page matches.</p>}
          </ul>
        </>
      )}

      {ready && !running && pages.length === 0 && !error && (
        <p className="nx-hint">No results yet. <b>Find models</b> searches Bricksafe for pages that publish model files.</p>
      )}
    </div>
  );
}
