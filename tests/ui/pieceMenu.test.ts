import { beforeAll, beforeEach, expect, test } from 'vitest';
import { useStudio } from '../../src/state/store';
import { findItem } from '../../src/plan/ops';
import type { Plan } from '../../src/plan/types';
import { emptyMenuItems, pieceMenuItems } from '../../src/ui/PieceMenu';
import type { ContextItem } from '../../src/ui/ContextMenu';
import { appPartsReady, useAppParts } from '../helpers/appParts';

const piece = (id: string, part: string, x: number) => ({ id, part, color: 4, x, y: 0, z: 0, rot: 0 as const });
const plan: Plan = {
  format: 'brickmotion-plan', version: 1, name: 't',
  steps: [{ pieces: [piece('scabbard', '19141', 0), piece('sword', '21459', 30)] }],
};

type Entry = { label: string; disabled?: boolean; onClick?: () => void };
/** the Fit entry, however the menu words it for this selection */
const fitItem = (items: readonly ContextItem[]): Entry | undefined => {
  for (const item of items) {
    if (typeof item !== 'object' || !('label' in item) || !String(item.label).startsWith('Fit together')) continue;
    return item as Entry;
  }
  return undefined;
};

beforeAll(async () => {
  if (appPartsReady) await useAppParts(['19141', '21459']);
}, 60_000);
beforeEach(() => {
  useStudio.getState().setPlan(plan, { resetHistory: true });
  useStudio.getState().select([]);
});

test('the piece menu fits the selected pieces together', async () => {
  if (!appPartsReady) return;
  useStudio.getState().select(['scabbard', 'sword']);
  const fit = fitItem(pieceMenuItems(['scabbard', 'sword']))!;
  expect(fit.disabled).toBeFalsy();
  fit.onClick?.();
  for (let i = 0; i < 200 && !('ldu' in (findItem(useStudio.getState().plan, '', 'sword')!.item as object)); i++) {
    await new Promise((settle) => setTimeout(settle, 5));
  }
  // the documented slot pose is off the stud grid: the piece keeps an exact LDU placement
  expect(findItem(useStudio.getState().plan, '', 'sword')!.item).toHaveProperty('ldu');
});

test('one piece is told to select the two first, and empty space offers it when two are selected', () => {
  useStudio.getState().select(['sword']);
  const one = fitItem(pieceMenuItems(['sword']))!;
  expect(one.label).toContain('select the two pieces first');
  expect(one.disabled).toBe(true);
  expect(fitItem(emptyMenuItems())).toBeUndefined();

  useStudio.getState().select(['scabbard', 'sword']);
  expect(fitItem(emptyMenuItems())?.disabled).toBeFalsy();
});
