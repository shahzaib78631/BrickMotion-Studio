import { create } from 'zustand';
import type { Projection } from '../render/studio';
import type { ViewState } from '../render/viewPresets';

/** Blender-style viewport view state, shared by the label, gizmo and View menu. */
type ViewStateStore = {
  /** the preset the camera sits on, or 'user' once it has been orbited off one */
  view: ViewState;
  projection: Projection;
  /** local view (Numpad /): only the selected pieces are shown */
  local: boolean;
  /** what was hidden before local view was entered, restored on exit */
  savedHidden: string[];
  /** the model local view was entered for; the saved set only restores there */
  savedModel: string;
};

export const useViewState = create<ViewStateStore>(() => ({
  view: 'user',
  projection: 'perspective',
  local: false,
  savedHidden: [],
  savedModel: '',
}));

/** "Front Orthographic", "User Perspective", … like Blender's viewport text. */
export function viewLabel(view: ViewState, projection: Projection): string {
  const names: Record<ViewState, string> = { front: 'Front', back: 'Back', right: 'Right', left: 'Left', top: 'Top', bottom: 'Bottom', user: 'User' };
  return `${names[view]} ${projection === 'ortho' ? 'Orthographic' : 'Perspective'}`;
}
