import { describe, expect, it } from 'vitest';
import { pressOnHandle, type HandleControls } from '../../src/ui/gizmoPress';

/** a stand-in for three's TransformControls: the axis is set only by the hover it is asked for */
const gizmo = (state: Partial<HandleControls> = {}) => {
  const asked: Array<{ x: number; y: number }> = [];
  const controls = {
    enabled: true,
    dragging: false,
    axis: null as string | null,
    pointerHover(pointer: PointerEvent) {
      const { x, y } = pointer as unknown as { x: number; y: number };
      asked.push({ x, y });
      controls.axis = x > 0.2 ? 'Y' : null;
    },
    ...state,
  };
  return { controls, asked };
};

describe('a press that belongs to the transform gizmo', () => {
  it('measures the press itself, not the axis hovered on the way to it', () => {
    const { controls, asked } = gizmo();
    expect(pressOnHandle(controls, { x: 0.5, y: 0 })).toBe(true);
    expect(controls.axis).toBe('Y');
    // the same pointer moved off the ring and pressed: that press picks a brick again
    expect(pressOnHandle(controls, { x: -0.5, y: 0 })).toBe(false);
    expect(controls.axis).toBeNull();
    expect(asked).toEqual([{ x: 0.5, y: 0 }, { x: -0.5, y: 0 }]);
  });

  it('never claims a press for a gizmo that is away, locked or already turning', () => {
    for (const state of [{ enabled: false }, { dragging: true }]) {
      const { controls, asked } = gizmo(state);
      expect(pressOnHandle(controls, { x: 0.5, y: 0 })).toBe(false);
      expect(asked).toHaveLength(0);
    }
    expect(pressOnHandle(null, { x: 0.5, y: 0 })).toBe(false);
    expect(pressOnHandle(undefined, { x: 0, y: 0 })).toBe(false);
  });
});
