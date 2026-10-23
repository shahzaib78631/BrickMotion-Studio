import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Ic, type IconName } from './icons';
import type { MenuItem } from './Toolbar';

/** A menu entry that opens a list beside the menu. */
export type SubMenu = { icon: IconName; label: string; items: ContextItem[]; disabled?: boolean };
export type ContextItem = MenuItem | { heading: string } | SubMenu;

const isSubMenu = (it: ContextItem): it is SubMenu => typeof it === 'object' && 'items' in it;

/** One menu panel at a screen point, kept inside the window; `flipX` is where it goes if it does not fit on the right. */
function Panel({
  x,
  y,
  flipX,
  items,
  label,
  onPick,
  onBack,
  autoFocus,
}: {
  x: number;
  y: number;
  flipX?: number;
  items: ContextItem[];
  label: string;
  onPick(run: () => void): void;
  onBack?(): void;
  autoFocus: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  const [sub, setSub] = useState<{ index: number; x: number; y: number; flipX: number; focus: boolean } | null>(null);
  useLayoutEffect(() => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    const fitsRight = x + r.width <= window.innerWidth - 8;
    const left = fitsRight || flipX === undefined ? Math.min(x, window.innerWidth - r.width - 8) : flipX - r.width;
    setPos({ left: Math.max(8, left), top: Math.max(8, Math.min(y, window.innerHeight - r.height - 8)) });
    // a long list (every step of a big model) opens at the current entry
    const cur = ref.current?.querySelector<HTMLElement>('[aria-current="true"]');
    if (cur && ref.current) ref.current.scrollTop = cur.offsetTop - ref.current.clientHeight / 2 + cur.offsetHeight / 2;
  }, [x, y, flipX]);
  useEffect(() => {
    if (autoFocus) ref.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
  }, [autoFocus]);

  const openSub = (index: number, el: HTMLElement, focus: boolean) => {
    const r = el.getBoundingClientRect();
    const menu = ref.current!.getBoundingClientRect();
    setSub({ index, x: menu.right - 4, y: r.top - 5, flipX: menu.left + 4, focus });
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    const buttons = [...ref.current!.querySelectorAll<HTMLButtonElement>(':scope > button:not(:disabled)')];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      const next = buttons[(at + (e.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length];
      next?.focus();
    } else if (e.key === 'ArrowRight' && at >= 0) {
      const index = Number(buttons[at].dataset.index);
      if (isSubMenu(items[index])) {
        e.preventDefault();
        e.stopPropagation();
        openSub(index, buttons[at], true);
      }
    } else if (e.key === 'ArrowLeft' && onBack) {
      e.preventDefault();
      e.stopPropagation();
      onBack();
    }
  };
  const open = sub && items[sub.index];
  return (
    <>
      <div ref={ref} className="nx-menu bm-context" role="menu" aria-label={label} style={pos} onKeyDown={onKeyDown}>
        {items.map((it, i) =>
          it === 'sep' ? (
            <hr key={i} />
          ) : 'heading' in it ? (
            <div key={i} className="bm-context-heading">{it.heading}</div>
          ) : isSubMenu(it) ? (
            <button
              key={i}
              data-index={i}
              role="menuitem"
              aria-haspopup="menu"
              aria-expanded={sub?.index === i}
              className={sub?.index === i ? 'open' : ''}
              disabled={it.disabled}
              onMouseEnter={(e) => openSub(i, e.currentTarget, false)}
              onClick={(e) => openSub(i, e.currentTarget, true)}
            >
              <Ic name={it.icon} />
              <span>{it.label}</span>
              <Ic name="right" />
            </button>
          ) : (
            <button
              key={i}
              data-index={i}
              role="menuitem"
              className={it.danger ? 'danger' : ''}
              aria-current={it.current || undefined}
              disabled={it.disabled}
              onMouseEnter={() => setSub(null)}
              onClick={() => onPick(it.onClick)}
            >
              <Ic name={it.icon} />
              <span>{it.label}</span>
              {it.hint && <kbd>{it.hint}</kbd>}
            </button>
          ),
        )}
      </div>
      {sub && open && isSubMenu(open) && (
        <Panel
          key={sub.index}
          x={sub.x}
          y={sub.y}
          flipX={sub.flipX}
          items={open.items}
          label={open.label}
          onPick={onPick}
          autoFocus={sub.focus}
          onBack={() => {
            const btn = ref.current?.querySelector<HTMLButtonElement>(`button[data-index="${sub.index}"]`);
            setSub(null);
            btn?.focus();
          }}
        />
      )}
    </>
  );
}

/** A right-click menu at a screen point, kept inside the window. Escape or a click outside closes it. */
export function ContextMenu({ x, y, items, label, onClose }: { x: number; y: number; items: ContextItem[]; label: string; onClose(): void }) {
  const ref = useRef<HTMLDivElement>(null);
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
  return (
    <div ref={ref} style={{ display: 'contents' }} onContextMenu={(e) => e.preventDefault()}>
      <Panel
        x={x}
        y={y}
        items={items}
        label={label}
        autoFocus
        onPick={(run) => {
          onClose();
          run();
        }}
      />
    </div>
  );
}
