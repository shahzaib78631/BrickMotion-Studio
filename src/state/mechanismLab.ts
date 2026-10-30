/** Ephemeral, opt-in mechanism exploration. Never saved to a project. */
import { create } from 'zustand';
import type { MechanismProgram } from '../anim/motion/v4/mechanismProgram';
import type { SpatialLinkagePreview } from '../anim/motion/spatial/spatialAdapter';
import type { ShiftOverride } from '../anim/motion/gearbox/shiftPlayback';

export type MechanismLabState = {
  active: boolean;
  program: MechanismProgram | null;
  /** V6 spatial constraint preview, mutually exclusive with V4/V5 programs. */
  spatial: SpatialLinkagePreview | null;
  model: string;
  position: number;
  amplitude: number;
  rpm: number;
  playing: boolean;
  /** Extra V5 motor locks, keyed by mechanism joint ID. */
  additionalInputs: Readonly<Record<string, number>>;
  /** Optional interactive engagement overrides for V5 clutches. */
  engagements: Readonly<Record<string, boolean>>;
  /** A gearbox gear chosen by hand, in place of the program's shift track. */
  shift: ShiftOverride | null;
  /** The gearbox mode the viewport last drew ('neutral' while dogs wait to line up). */
  gear: string;
  error: string;
  start(model: string, program: MechanismProgram, amplitude: number): void;
  startSpatial(model: string, preview: SpatialLinkagePreview, amplitude: number): void;
  stop(): void;
  setPosition(value: number): void;
  setAmplitude(value: number): void;
  setRpm(value: number): void;
  setPlaying(value: boolean): void;
  setAdditionalInput(id: string, value: number | null): void;
  setEngagement(id: string, engaged: boolean): void;
  setShift(shift: ShiftOverride | null): void;
  setError(message: string): void;
};
export const useMechanismLab = create<MechanismLabState>((set) => ({
  active: false, program: null, spatial: null, model: '', position: 0,
  amplitude: Math.PI / 12, rpm: 15, playing: false, error: '', additionalInputs: {}, engagements: {}, shift: null, gear: '',
  start: (model, program, amplitude) => set({
    model, program, spatial: null, amplitude, position: 0, active: true, playing: false, error: '', additionalInputs: {}, engagements: {}, shift: null, gear: '',
  }),
  startSpatial: (model, spatial, amplitude) => set({
    model, spatial, program: null, amplitude, position: 0, active: true, playing: false, error: '', additionalInputs: {}, engagements: {}, shift: null, gear: '',
  }),
  stop: () => set({ active: false, playing: false, position: 0, error: '', additionalInputs: {}, engagements: {}, shift: null, gear: '' }),
  setPosition: (position) => set({ position, playing: false, error: '' }),
  setAmplitude: (amplitude) => set({ amplitude, position: 0, playing: false, error: '' }),
  setRpm: (rpm) => set({ rpm }),
  setPlaying: (playing) => set({ playing, error: '' }),
  setAdditionalInput: (id, value) => set(state => {
    const validProgram=state.program?.joints.some(j=>j.id===id&&id!==state.program?.driver.joint);
    const validSpatial=state.spatial?.model.constraints.some(j=>j.id===id&&
      (j.kind==='hinge'||j.kind==='slider')&&id!==state.spatial?.driver);
    if(!validProgram&&!validSpatial)return {};
    const additionalInputs = { ...state.additionalInputs };
    if (value === null) delete additionalInputs[id];
    else if (Number.isFinite(value)) additionalInputs[id] = value;
    return { additionalInputs, playing: false, error: '' };
  }),
  setEngagement: (id, engaged) => set(state => {
    if(!state.program?.transmissions?.some(t=>t.kind==='clutch'&&t.id===id))return {};
    return {engagements:{...state.engagements,[id]:engaged},playing:false,error:''};
  }),
  setShift: (shift) => set({ shift, error: '' }),
  setError: (error) => set({ error, playing: false }),
}));
