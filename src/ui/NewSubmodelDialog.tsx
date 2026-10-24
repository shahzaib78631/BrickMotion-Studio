import { useEffect, useRef, useState } from 'react';
import { availableSubmodelName } from '../plan/createSubmodel';
import type { Plan } from '../plan/types';
import { Ic } from './icons';

/** A compact editor modal, rather than a browser prompt: names are validated
 * before a single undoable hierarchy edit is committed. */
export function NewSubmodelDialog({ plan, count, onCreate, onClose }: {
  plan: Plan; count: number; onCreate(name: string): boolean; onClose(): void;
}) {
  const [name, setName] = useState(() => availableSubmodelName(plan));
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); input.current?.select(); }, []);
  const valid = name.trim() !== '' && name.trim().length <= 65 && !/[\\/]/.test(name) &&
    !(plan.submodels && Object.hasOwn(plan.submodels, name.trim())) && name.trim() !== plan.name;
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid) { setError('Choose a unique name (1–65 characters, no slashes).'); return; }
    if (onCreate(name.trim())) onClose();
    else setError('Cannot combine these pieces: check that they are still selected and do not attach to different external parents.');
  };
  return (
    <div className="bm-modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <form className="bm-submodel-dialog" role="dialog" aria-modal="true" aria-label="Create submodel"
        onSubmit={submit} onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); } }}>
        <div className="bm-submodel-dialog-top"><span className="bm-submodel-dialog-icon"><Ic name="box" /></span>
          <div><h3>Create submodel</h3><p>{count} selected pieces will become one editable assembly.</p></div>
          <button type="button" className="nx-icon" title="Cancel" aria-label="Close" onClick={onClose}><Ic name="x" /></button>
        </div>
        <label className="nx-field">Submodel name
          <input ref={input} type="text" maxLength={65} value={name} onChange={(e) => { setName(e.target.value); setError(''); }} aria-invalid={!!error} />
        </label>
        <p className="nx-fine">The pieces keep their exact positions and build order. Double-click the new submodel to edit its contents.</p>
        {error && <p className="bm-spot-error" role="alert">{error}</p>}
        <div className="bm-submodel-dialog-actions">
          <button type="button" className="nx-btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="nx-btn bm-spot-apply" disabled={!valid}><Ic name="check" /> Create submodel</button>
        </div>
      </form>
    </div>
  );
}
