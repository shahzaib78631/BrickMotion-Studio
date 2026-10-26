// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { assemble, type Assembly } from '../../src/model/assemble';
import type { Plan } from '../../src/plan/types';
import { useStudio } from '../../src/state/store';
import type { ModelState } from '../../src/state/useModel';
import { PartsDialog } from '../../src/ui/PartsDialog';
import { fixtureColors, fixtureMetrics } from '../helpers/fixtureMetrics';

// Rows show a thumbnail; drawing one needs WebGL and the part library over HTTP,
// neither of which a DOM-only test has.
vi.mock('../../src/render/thumbnails', () => ({ getThumbnail: () => Promise.resolve('') }));

const piece = (id: string, x = 0) => ({ id, part: '3001', color: 4, x, y: 0, z: 0, rot: 0 as const });
const fixture = (): Plan => ({
  format: 'brickmotion-plan',
  version: 1,
  name: 't',
  submodels: { engine: { steps: [{ pieces: [piece('e1')] }] } },
  steps: [
    { pieces: [piece('a', 0)] },
    { pieces: [piece('b', 4), piece('c', 8)] },
    { pieces: [{ id: 's', submodel: 'engine', x: 0, y: 0, z: 0, rot: 0 }] },
  ],
});

let assembled: Assembly;
let model: ModelState;

beforeEach(async () => {
  const plan = fixture();
  const metrics = await fixtureMetrics();
  useStudio.getState().setPlan(plan, { resetHistory: true });
  useStudio.getState().setEditingModel('');
  assembled = assemble(plan, metrics, fixtureColors);
  model = { plan, assembly: assembled, view: assembled, viewPlan: plan, warnings: [], ready: true };
});
afterEach(cleanup);

const renderDialog = () => render(<PartsDialog model={model} onClose={() => undefined} />);
const ids = () => [...useStudio.getState().selection.ids].sort();

test('lists each step with its parts grouped by part and colour', () => {
  renderDialog();
  expect(screen.getByRole('dialog', { name: 'Parts of Main model' })).toBeTruthy();
  expect(screen.getByLabelText('Select 3001 (1)')).toBeTruthy();
  expect(screen.getByLabelText('Select 3001 (2)')).toBeTruthy();
  expect(screen.getByText('Submodel · engine')).toBeTruthy();
});

test('ticking a part row selects every piece of that part', () => {
  renderDialog();
  fireEvent.click(screen.getByLabelText('Select 3001 (2)'));
  expect(ids()).toEqual(['b', 'c']);
});

test('a part row expands to its individual pieces', () => {
  renderDialog();
  fireEvent.click(screen.getByRole('button', { name: /individual 3001 pieces/ }));
  fireEvent.click(screen.getByLabelText('Select piece c'));
  expect(ids()).toEqual(['c']);
});

test('groups the selection and ungroups it again', () => {
  renderDialog();
  fireEvent.click(screen.getByLabelText('Select 3001 (2)'));
  fireEvent.click(screen.getByRole('button', { name: 'Group' }));
  const grouped = useStudio.getState().plan.steps[1].pieces;
  expect(grouped.every((item) => item.assembly?.group === 'Group 1')).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Ungroup' }));
  expect(useStudio.getState().plan.steps[1].pieces.some((item) => item.assembly?.group)).toBe(false);
});

test('moves the selection to another step and drops the emptied step', () => {
  renderDialog();
  fireEvent.click(screen.getByLabelText('Select 3001 (1)'));
  fireEvent.change(screen.getByLabelText('Move selected parts to step'), { target: { value: 'step:1' } });
  expect(useStudio.getState().plan.steps.map((step) => step.pieces.map((item) => item.id))).toEqual([['b', 'c', 'a'], ['s']]);
});

test('makes a submodel from the selection', () => {
  renderDialog();
  fireEvent.click(screen.getByLabelText('Select 3001 (1)'));
  fireEvent.click(screen.getByLabelText('Select 3001 (2)'));
  fireEvent.click(screen.getByRole('button', { name: /Make submodel/ }));
  fireEvent.change(screen.getByLabelText('Submodel name'), { target: { value: 'chassis' } });
  fireEvent.click(screen.getByRole('button', { name: /Create submodel/ }));
  const plan = useStudio.getState().plan;
  expect(Object.keys(plan.submodels ?? {})).toContain('chassis');
  expect(plan.steps.some((step) => step.pieces.some((item) => 'submodel' in item && item.submodel === 'chassis'))).toBe(true);
});

test('opens a submodel so its own parts can be browsed', () => {
  renderDialog();
  fireEvent.click(screen.getByRole('button', { name: 'Open engine' }));
  expect(useStudio.getState().editingModel).toBe('engine');
  expect(screen.getByRole('dialog', { name: 'Parts of engine' })).toBeTruthy();
  expect(screen.getByLabelText('Select 3001 (1)')).toBeTruthy();
});

// -- drag and drop -----------------------------------------------------------------

/** The HTML5 DataTransfer surface the dialog's handlers use. */
class Transfer {
  private data = new Map<string, string>();
  dropEffect = 'none';
  effectAllowed = 'all';
  setData(type: string, value: string) { this.data.set(type, value); }
  getData(type: string) { return this.data.get(type) ?? ''; }
  get types() { return [...this.data.keys()]; }
}

const dragEvent = (el: Element, type: string, transfer: Transfer) => {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: transfer });
  el.dispatchEvent(event);
};
const dragTo = (source: Element, target: Element) => {
  const transfer = new Transfer();
  dragEvent(source, 'dragstart', transfer);
  dragEvent(target, 'dragover', transfer);
  dragEvent(target, 'drop', transfer);
};
const row = (label: string) => screen.getByLabelText(label).closest('li')!;
const submodelRow = () => screen.getByText('Submodel · engine').closest('li')!;

test('dragging a part onto a submodel moves it into that submodel and follows it', () => {
  renderDialog();
  dragTo(row('Select 3001 (1)'), submodelRow());
  const plan = useStudio.getState().plan;
  expect(plan.submodels!.engine.steps[0].pieces.map((item) => item.id)).toEqual(['e1', 'a']);
  expect(plan.steps.flatMap((step) => step.pieces).some((item) => item.id === 'a')).toBe(false);
  expect(useStudio.getState().editingModel).toBe('engine');
  expect(useStudio.getState().selection.ids).toEqual(['a']);
});

test('dragging a part onto the parent crumb extracts it into that model', () => {
  renderDialog();
  fireEvent.click(screen.getByRole('button', { name: 'Open engine' }));
  const crumb = screen.getByRole('button', { name: 'Main model' }).closest('span')!;
  dragTo(row('Select 3001 (1)'), crumb);
  const plan = useStudio.getState().plan;
  expect(plan.steps.flatMap((step) => step.pieces).some((item) => item.id === 'e1')).toBe(true);
  expect(plan.submodels!.engine.steps.flatMap((step) => step.pieces)).toHaveLength(0);
  expect(useStudio.getState().editingModel).toBe('');
});

test('the Move-to selector lists other models and moves the selection there', () => {
  renderDialog();
  fireEvent.click(screen.getByLabelText('Select 3001 (1)'));
  const select = screen.getByLabelText('Move selected parts to step') as HTMLSelectElement;
  const values = [...select.options].map((option) => option.value);
  expect(values).toContain('model:engine');
  expect(values).toContain('sub:engine');
  fireEvent.change(select, { target: { value: 'model:engine' } });
  expect(useStudio.getState().plan.submodels!.engine.steps[0].pieces.map((item) => item.id)).toEqual(['e1', 'a']);
});

test('Extract all replaces a submodel use with its parts', () => {
  renderDialog();
  fireEvent.click(screen.getByRole('button', { name: 'Extract engine into Main model' }));
  const plan = useStudio.getState().plan;
  expect(plan.steps[2].pieces.map((item) => item.id)).toEqual(['e1']);
  expect(plan.steps[2].pieces.some((item) => 'submodel' in item)).toBe(false);
  expect(plan.submodels?.engine).toBeUndefined();
});

