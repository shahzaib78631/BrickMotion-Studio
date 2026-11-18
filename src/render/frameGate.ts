/** Keep editor updates responsive without redrawing an unchanged heavy scene at
 * display refresh rate. A heartbeat covers async resources and external overlays
 * that do not expose revisions. Progressive path tracing always keeps sampling. */
export class FrameGate {
  private previous: readonly unknown[] = [];
  private renderedAt = -Infinity;
  private dirty = true;
  invalidate = (): void => { this.dirty = true; };
  shouldRender(now: number, dependencies: readonly unknown[], continuous = false): boolean {
    const changed = dependencies.length !== this.previous.length || dependencies.some((value, i) => value !== this.previous[i]);
    if (!continuous && !this.dirty && !changed && now - this.renderedAt < 250) return false;
    this.previous = dependencies;
    this.renderedAt = now;
    this.dirty = false;
    return true;
  }
}
