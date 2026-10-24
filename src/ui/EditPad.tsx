import { runCommand } from '../state/editing';
import { commandForKey, type Command } from '../state/keymap';
import { Ic, type IconName } from './icons';

const key = (k: string) => ({ key: k, shiftKey: false, metaKey: false, ctrlKey: false });

/** On-screen editing for the selection: move (relative to the camera), raise, lower, rotate, duplicate, delete. */
export function EditPad({ azimuth }: { azimuth(): number }) {
  const run = (k: string) => {
    const cmd = commandForKey(key(k), azimuth());
    if (cmd) runCommand(cmd);
  };
  const btn = (icon: IconName, label: string, onClick: () => void, cls = '') => (
    <button className={`nx-icon bm-pad-btn ${cls}`} aria-label={label} title={label} onClick={onClick}>
      <Ic name={icon} />
    </button>
  );
  const cmd = (c: Command) => () => runCommand(c);
  return (
    <div className="bm-pad">
      <div className="nx-sub">Move</div>
      <div className="bm-pad-grid">
        <div className="bm-dpad">
          <span />
          {btn('arrowUp', 'Move away', () => run('ArrowUp'))}
          <span />
          {btn('arrowLeft', 'Move left', () => run('ArrowLeft'))}
          <span className="bm-dpad-mid" />
          {btn('arrowRight', 'Move right', () => run('ArrowRight'))}
          <span />
          {btn('arrowDown', 'Move closer', () => run('ArrowDown'))}
          <span />
        </div>
        <div className="bm-updown">
          {btn('raise', 'Raise one plate', () => run('PageUp'))}
          {btn('lower', 'Lower one plate', () => run('PageDown'))}
        </div>
      </div>
      <div className="bm-pad-row">
        <button className="nx-btn nx-sm" aria-label="Rotate 90°" title="Rotate 90° (R)" onClick={cmd({ kind: 'rotate' })}>
          <Ic name="rotate" /> Rotate
        </button>
        <button className="nx-btn nx-sm" aria-label="Duplicate" title="Duplicate (⌘D)" onClick={cmd({ kind: 'duplicate' })}>
          <Ic name="copy" /> Duplicate
        </button>
        <button className="nx-btn nx-sm danger" aria-label="Delete" title="Delete (Delete)" onClick={cmd({ kind: 'delete' })}>
          <Ic name="trash" /> Delete
        </button>
      </div>
    </div>
  );
}
