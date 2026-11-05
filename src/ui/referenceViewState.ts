import { create } from 'zustand';

/** UI-only state of the reference images. The images themselves live in Plan.sceneSetup.images. */
export const useReferenceView = create<{ selectedId: string | null; mode: 'translate' | 'rotate' }>(() => ({
  selectedId: null, mode: 'translate',
}));
