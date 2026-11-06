import { create } from 'zustand';
import type { KeyRef } from '../anim/keyframes';

/**
 * Editing one piece's flight path. `request` is a piece whose clip was double-clicked in the
 * Build timeline: the Dope Sheet bakes its flight into keys (if it is not baked yet), opens
 * its channels and clears the request. The viewport then draws the path of the selected
 * baked piece; `hits` are the frames where that path goes through a built piece. `select` is
 * a set of keys the viewport picked (a path point): the Dope Sheet selects them and clears it.
 */
export type FlightEdit = {
  request: string | null;
  hits: ReadonlySet<number>;
  select: KeyRef[] | null;
  set(next: Partial<Pick<FlightEdit, 'request' | 'hits' | 'select'>>): void;
};
export const useFlightEdit = create<FlightEdit>((set) => ({
  request: null, hits: new Set(), select: null, set: (next) => set(next),
}));
