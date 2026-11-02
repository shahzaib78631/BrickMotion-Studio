/**
 * Whether a pointer press belongs to the transform gizmo.
 *
 * TransformControls keeps the handle under the pointer in `axis`, but it only refreshes that
 * on pointer movement — and then again inside its own `pointerdown`, which runs *after* the
 * viewport's capture handler (the capture handler has to run first so the orbit controls never
 * see the press). So a press cannot be judged from `axis` alone: it gets measured here, with
 * the same ray and the same handle pickers TransformControls would use. Without that, a press
 * on a rotation ring picked the brick behind the ring — moving the selection out from under
 * the gesture — and a press on a bare part of the ring started a selection box instead of a
 * rotation.
 */
export type HandleControls = {
  enabled: boolean;
  dragging: boolean;
  axis: string | null;
  /** three's own typings call this a DOM PointerEvent; TransformControls reads only x and y off it. */
  pointerHover(pointer: PointerEvent): void;
};

export function pressOnHandle(controls: HandleControls | null | undefined, ndc: { x: number; y: number }): boolean {
  // a gizmo that is hidden, locked, or already turning cannot take the press
  if (!controls || !controls.enabled || controls.dragging) return false;
  controls.pointerHover(ndc as unknown as PointerEvent);
  return !!controls.axis;
}
