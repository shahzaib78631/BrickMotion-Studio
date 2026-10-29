// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, expect, test } from 'vitest';
import type { Plan } from '../../src/plan/types';
import { useStudio } from '../../src/state/store';
import { Toolbar } from '../../src/ui/Toolbar';

const plan: Plan = {
  format: 'brickmotion-plan',
  version: 1,
  name: 't',
  steps: [{ pieces: [{ id: 'a', part: '3001', color: 4, x: 0, y: 0, z: 0, rot: 0 }] }],
};
const noop = () => {};

beforeAll(() => useStudio.getState().setPlan(plan, { resetHistory: true }));
afterEach(cleanup);

test('renders the global bar with a project name and the command palette', () => {
  render(<Toolbar theme="light" onTheme={noop} onProjects={noop} onTemplates={noop} onAbout={noop}
    onExportVideo={noop} canPreview onNavigate={noop} />);
  expect((screen.getByLabelText('Project name') as HTMLInputElement).value).toBe('t');
  expect(screen.getByLabelText('Search or run a command (Command K)')).toBeTruthy();
});
