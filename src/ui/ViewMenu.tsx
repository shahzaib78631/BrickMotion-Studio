import { useEffect, useRef, useState } from 'react';
import type { ViewName } from '../render/viewPresets';
import { useStudio } from '../state/store';
import { Ic } from './icons';
import { viewportApi } from './viewportApi';
import { useViewState, viewLabel } from './viewState';

const VIEWS: { label: string; hint: string; view: ViewName }[] = [
  { label: 'Front', hint: '1', view: 'front' },
  { label: 'Back', hint: '⌃1', view: 'back' },
  { label: 'Right', hint: '3', view: 'right' },
  { label: 'Left', hint: '⌃3', view: 'left' },
  { label: 'Top', hint: '7', view: 'top' },
  { label: 'Bottom', hint: '⌃7', view: 'bottom' },
];

/** The compact View dropdown under the navigation gizmo: every view preset with
 * its shortcut, plus the Perspective/Orthographic toggle. */
export function ViewMenu() {
  const mode = useStudio((s) => s.mode);
  const projection = useViewState((s) => s.projection);
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== 'Escape') return;
      if (!(e instanceof KeyboardEvent) && e.target instanceof Node && (pop.current?.contains(e.target) || btn.current?.contains(e.target))) return;
      setOpen(false);
    };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', close);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', close);
    };
  }, [open]);

  if (mode !== 'edit') return null;
  const onKeyDown = (e: React.KeyboardEvent) => {
    const buttons = [...pop.current!.querySelectorAll<HTMLButtonElement>(':scope > button')];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      buttons[(at + (e.key === 'ArrowDown' ? 1 : buttons.length - 1) + buttons.length) % buttons.length]?.focus();
    }
  };
  const pick = (run: () => void) => {
    setOpen(false);
    run();
  };
  return (
    <>
      <button ref={btn} className={`bm-view-btn${open ? ' on' : ''}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Ic name="view" /> View <Ic name="chevron" />
      </button>
      {open && (
        <div ref={pop} className="nx-menu bm-view-pop" role="menu" aria-label="View" onKeyDown={onKeyDown}>
          {VIEWS.map((v) => (
            <button key={v.view} role="menuitem" onClick={() => pick(() => viewportApi.views?.snapTo(v.view))}>
              <Ic name="view" />
              <span>{v.label}</span>
              <kbd>{v.hint}</kbd>
            </button>
          ))}
          <hr />
          <button role="menuitem" aria-current={projection === 'perspective' || undefined} onClick={() => pick(() => viewportApi.views?.setProjection('perspective'))}>
            <Ic name="camera" />
            <span>Perspective</span>
            <kbd>5</kbd>
          </button>
          <button role="menuitem" aria-current={projection === 'ortho' || undefined} onClick={() => pick(() => viewportApi.views?.setProjection('ortho'))}>
            <Ic name="camera" />
            <span>Orthographic</span>
            <kbd>5</kbd>
          </button>
        </div>
      )}
    </>
  );
}

/** The current view name (e.g. "Front Orthographic"), like Blender, top-left. */
export function ViewLabel() {
  const mode = useStudio((s) => s.mode);
  const view = useViewState((s) => s.view);
  const projection = useViewState((s) => s.projection);
  if (mode !== 'edit') return null;
  return <div className="bm-view-label">{viewLabel(view, projection)}</div>;
}
