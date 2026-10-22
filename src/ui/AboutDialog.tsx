export function AboutDialog({ onClose }: { onClose(): void }) {
  return (
    <div className="dialog-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-label="About">
        <h2>About BrickMotion Studio</h2>
        <p>Design brick-built sets, or let Claude dream them up, then export a 9:16 build animation for social media.</p>
        <h3>Credits</h3>
        <ul>
          <li>
            Parts geometry: the{' '}
            <a href="https://library.ldraw.org/" target="_blank" rel="noreferrer">
              LDraw parts library
            </a>
            , licensed under{' '}
            <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noreferrer">
              CC BY 4.0
            </a>{' '}
            (ldraw.org).
          </li>
          <li>
            Part names and categories:{' '}
            <a href="https://rebrickable.com/" target="_blank" rel="noreferrer">
              Rebrickable.com
            </a>
            .
          </li>
          <li>Video encoding: Mediabunny. 3D: three.js.</li>
        </ul>
        <p className="muted small">LEGO® is a trademark of the LEGO Group, which does not sponsor or endorse this app.</p>
        <div className="actions">
          <button className="primary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
