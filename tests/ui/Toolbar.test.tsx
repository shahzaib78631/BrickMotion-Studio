// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { useStudio } from '../../src/state/store';
import { Toolbar } from '../../src/ui/Toolbar';

afterEach(cleanup);
const noop = () => {};

test('the tool group switches between Select and Move', () => {
  render(<Toolbar theme="light" onTheme={noop} onProjects={noop} onAbout={noop} onExportVideo={noop} canPreview />);
  fireEvent.click(screen.getByRole('radio', { name: 'Move tool' }));
  expect(useStudio.getState().tool).toBe('move');
  expect(screen.getByRole('radio', { name: 'Move tool' }).getAttribute('aria-checked')).toBe('true');
  fireEvent.click(screen.getByRole('radio', { name: 'Select tool' }));
  expect(useStudio.getState().tool).toBe('select');
});
