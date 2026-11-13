import { useEffect, useState } from 'react';

export function PartsUpdatePrompt() {
  const [available, setAvailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    let checking = false;
    const controller = new AbortController();
    const check = async () => {
      if (checking) return;
      checking = true;
      try {
        const response = await fetch('/api/parts-update', { cache: 'no-store', signal: controller.signal });
        if (!response.ok) return;
        const status = await response.json();
        if (active && status.available) setAvailable(true);
      } catch { /* Retry on focus or the next scheduled check when offline. */ }
      finally { checking = false; }
    };
    void check();
    const timer = window.setInterval(() => void check(), 60 * 60 * 1000);
    window.addEventListener('focus', check);
    return () => { active = false; controller.abort(); window.clearInterval(timer); window.removeEventListener('focus', check); };
  }, []);
  const update = async () => {
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/parts-update', { method: 'POST' });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Parts update failed');
      setDone(true);
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  if (!available) return null;
  return <div role="dialog" aria-modal="true" aria-label="Parts library update" style={{ position: 'fixed', inset: 0, zIndex: 10000, background: '#0009', display: 'grid', placeItems: 'center' }}>
    <div style={{ background: 'var(--panel, #252830)', color: 'var(--text, #fff)', padding: 24, borderRadius: 12, maxWidth: 420 }}>
      <h2>{done ? 'Parts library updated' : 'Parts update available'}</h2>
      <p>{done ? 'Reload to use the updated parts catalog. Save your project before reloading.' : busy ? 'Downloading and rebuilding the parts catalog. This can take a few minutes.' : 'A newer LDraw parts library is available. Download and install it now?'}</p>
      {error && <p role="alert">{error}</p>}
      {done ? <><button onClick={() => window.location.reload()}>Reload</button> <button onClick={() => setAvailable(false)}>Later</button></> : <><button disabled={busy} onClick={() => void update()}>{busy ? 'Updating…' : 'Update parts'}</button> <button disabled={busy} onClick={() => setAvailable(false)}>Later</button></>}
    </div>
  </div>;
}
