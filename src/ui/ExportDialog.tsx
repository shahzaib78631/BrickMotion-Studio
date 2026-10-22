import { useEffect, useRef, useState } from 'react';
import type { Timeline } from '../anim/timeline';
import { canExportMp4, exportVideo, type LogoCorner } from '../export/exportVideo';
import type { Instance } from '../model/assemble';
import { createStudio } from '../render/studio';
import { safeFileName, saveBlob } from './download';

type Props = {
  name: string;
  timeline: Timeline;
  instances: Instance[];
  logo: { image: ImageBitmap; corner: LogoCorner } | null;
  onClose(): void;
};

export function ExportDialog({ name, timeline, instances, logo, onClose }: Props) {
  const [state, setState] = useState<'checking' | 'unsupported' | 'running' | 'done' | 'error'>('checking');
  const [progress, setProgress] = useState({ done: 0, total: 1 });
  const [error, setError] = useState('');
  const blob = useRef<Blob | null>(null);
  const abort = useRef<AbortController | null>(null);
  const fileName = `${safeFileName(name)}.mp4`;

  useEffect(() => {
    let alive = true;
    const ac = new AbortController();
    abort.current = ac;
    (async () => {
      if (!(await canExportMp4().catch(() => false))) return alive && setState('unsupported');
      if (!alive) return;
      setState('running');
      try {
        const b = await exportVideo(
          { timeline, instances, width: 1080, height: 1920, fps: 30, logo, signal: ac.signal, onProgress: (done, total) => alive && setProgress({ done, total }) },
          { createStudio },
        );
        if (!alive) return;
        blob.current = b;
        setState('done');
        saveBlob(fileName, b);
      } catch (e) {
        if (!alive || (e as Error).name === 'AbortError') return;
        setError((e as Error).message);
        setState('error');
      }
    })();
    return () => {
      alive = false;
      ac.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pct = Math.round((progress.done / progress.total) * 100);
  return (
    <div className="dialog-backdrop">
      <div className="dialog" role="dialog" aria-label="Export video">
        <h2>Export video</h2>
        {state === 'checking' && <p className="muted">Checking your browser…</p>}
        {state === 'unsupported' && <p className="error">Your browser can't encode MP4. Use Chrome.</p>}
        {state === 'running' && (
          <>
            <p className="muted">
              Rendering frame {progress.done} of {progress.total} (1080×1920, 30 fps)…
            </p>
            <div className="progress">
              <div style={{ width: `${pct}%` }} />
            </div>
          </>
        )}
        {state === 'done' && (
          <p>
            Saved <strong>{fileName}</strong> ({((blob.current?.size ?? 0) / 1e6).toFixed(1)} MB).
          </p>
        )}
        {state === 'error' && <p className="error">Export failed: {error}</p>}
        <div className="actions">
          {state === 'done' && <button onClick={() => blob.current && saveBlob(fileName, blob.current)}>Download again</button>}
          {state === 'running' ? (
            <button
              onClick={() => {
                abort.current?.abort();
                onClose();
              }}
            >
              Cancel
            </button>
          ) : (
            <button className="primary" onClick={onClose}>
              Close
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
