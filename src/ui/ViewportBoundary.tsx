import { Component, Fragment, type ReactNode } from 'react';

type State = { error: Error | null; attempt: number };

const isWebGLFailure = (e: Error) => /webgl|context/i.test(e.message);

/**
 * Keeps the editor usable when the 3D view cannot start. The usual cause is the browser
 * blocking WebGL for this site after the graphics card was reset (a very heavy render
 * can do that); the rest of the app still works, and "Try again" remounts the view.
 */
export class ViewportBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null, attempt: 0 };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  render() {
    const { error, attempt } = this.state;
    // a keyed Fragment adds no element: the stage's `> .viewport` layout rules still apply
    if (!error) return <Fragment key={attempt}>{this.props.children}</Fragment>;
    return (
      <div className="bm-viewport-error" role="alert">
        <strong>The 3D view couldn&rsquo;t start</strong>
        {isWebGLFailure(error) ? (
          <p>
            The browser has turned off 3D graphics (WebGL) for this page, usually after the graphics card
            was reset by a very heavy render. Quit the browser completely and open it again to turn it back
            on. Your project is saved.
          </p>
        ) : (
          <p>{error.message}</p>
        )}
        <button className="nx-btn" onClick={() => this.setState({ error: null, attempt: attempt + 1 })}>Try again</button>
      </div>
    );
  }
}
