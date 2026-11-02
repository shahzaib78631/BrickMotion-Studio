import { beforeEach, expect, test } from 'vitest';
import { useStudio } from '../../src/state/store';

beforeEach(() => useStudio.setState({ gizmoEnabled: false, gizmoMode: 'translate' }));

test('the gizmo buttons are one toggle: the shown mode turns it off, another mode switches to it', () => {
  const g = () => useStudio.getState();
  g().toggleGizmo('translate');
  expect(g().gizmoEnabled).toBe(true);
  expect(g().gizmoMode).toBe('translate');
  g().toggleGizmo('rotate'); // a different mode: switch, stay on
  expect(g().gizmoEnabled).toBe(true);
  expect(g().gizmoMode).toBe('rotate');
  g().toggleGizmo('rotate'); // the mode already showing: put it away
  expect(g().gizmoEnabled).toBe(false);
  expect(g().gizmoMode).toBe('rotate'); // remembered for the next press
});

test('turning the gizmo on moves off aim mode, and off leaves aim alone', () => {
  useStudio.setState({ aimWay: true, gizmoEnabled: false });
  useStudio.getState().toggleGizmo('scale');
  expect(useStudio.getState().aimWay).toBe(false);
  expect(useStudio.getState().gizmoMode).toBe('scale');
  useStudio.setState({ aimWay: true });
  useStudio.getState().toggleGizmo('scale');
  expect(useStudio.getState().gizmoEnabled).toBe(false);
  expect(useStudio.getState().aimWay).toBe(true);
});
