import { useState, type ReactNode } from 'react';
import { Ic } from './icons';

const HELP_KEY = 'bm-help-open';

function readOpen(id: string): boolean {
  try {
    return (JSON.parse(localStorage.getItem(HELP_KEY) ?? '[]') as string[]).includes(id);
  } catch {
    return false;
  }
}

function saveOpen(id: string, open: boolean) {
  try {
    const list = (JSON.parse(localStorage.getItem(HELP_KEY) ?? '[]') as string[]).filter((x) => x !== id);
    localStorage.setItem(HELP_KEY, JSON.stringify(open ? [...list, id] : list));
  } catch {
    /* private window: just don't remember */
  }
}

/**
 * A side panel's header bar: title, optional count, optional actions on the right, and
 * an ⓘ button that shows the panel's how-to text (hidden by default, remembered per panel).
 */
export function PaneHead({ id, title, count, help, children }: { id: string; title: ReactNode; count?: ReactNode; help?: ReactNode; children?: ReactNode }) {
  const [open, setOpen] = useState(() => readOpen(id));
  const toggle = () => {
    setOpen(!open);
    saveOpen(id, !open);
  };
  return (
    <>
      <div className="nx-pane-head">
        <h3>
          {title}
          {count !== undefined && <span className="nx-count">{count}</span>}
        </h3>
        <div className="bm-head-actions">
          {children}
          {help && (
            <button className={`nx-icon bm-help-btn ${open ? 'on' : ''}`} aria-label="How this panel works" aria-expanded={open} title="How this panel works" onClick={toggle}>
              <Ic name="info" />
            </button>
          )}
        </div>
      </div>
      {help && open && <div className="bm-pane-help">{help}</div>}
    </>
  );
}

/** A quiet "Tips" toggle that shows how-to text in place (closed by default, remembered). */
export function HelpNote({ id, children }: { id: string; children: ReactNode }) {
  const [open, setOpen] = useState(() => readOpen(id));
  return (
    <div className="bm-help-note">
      <button className="nx-link" aria-expanded={open} onClick={() => { setOpen(!open); saveOpen(id, !open); }}>
        <Ic name="info" /> {open ? 'Hide tips' : 'Tips'}
      </button>
      {open && <div className="bm-pane-help">{children}</div>}
    </div>
  );
}
