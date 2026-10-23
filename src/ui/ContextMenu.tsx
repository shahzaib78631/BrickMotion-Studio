import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Ic } from './icons';
import type { MenuItem } from './Toolbar';

export type ContextItem = MenuItem | { heading: string };

/** A right-click menu at a screen point, kept inside the window. Escape or a click outside closes it. */
export function ContextMenu({ x, y, items, label, onClose }: { x: number; y: number; items: ContextItem[]; label: string; onClose(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  useLayoutEffect(() => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    setPos({ left: Math.max(8, Math.min(x, window.innerWidth - r.width - 8)), top: Math.max(8, Math.min(y, window.innerHeight - r.height - 8)) });
  }, [x, y]);
  useEffect(() => {
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== 'Escape') return;
      if (!(e instanceof KeyboardEvent) && e.target instanceof Node && ref.current?.contains(e.target)) return;
      onClose();
    };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', close);
    window.addEventListener('blur', onClose);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', close);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose]);
  useEffect(() => ref.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus(), []);
  return (
    <div ref={ref} className="nx-menu bm-context" role="menu" aria-label={label} style={pos} onContextMenu={(e) => e.preventDefault()}>
      {items.map((it, i) =>
        it === 'sep' ? (
          <hr key={i} />
        ) : 'heading' in it ? (
          <div key={i} className="bm-context-heading">{it.heading}</div>
        ) : (
          <button key={i} role="menuitem" disabled={it.disabled} onClick={() => { onClose(); it.onClick(); }}>
            <Ic name={it.icon} />
            <span>{it.label}</span>
            {it.hint && <kbd>{it.hint}</kbd>}
          </button>
        ),
      )}
    </div>
  );
}
