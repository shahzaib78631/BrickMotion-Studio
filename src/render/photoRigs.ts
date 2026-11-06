import type { SceneLight, XYZ } from './sceneSetup';
import { freshSceneId } from './sceneSetup';
import type { StudioLook, LightDirection } from './looks';

/** Editable studio lighting rigs. The positions are relative to the current
 * orbit target and model scale, not fixed points that miss large assemblies. */
type RigSource = {
  name: string;
  type: 'sun' | 'ambient';
  direction: LightDirection;
  intensity: number;
  color: string;
  shadow?: boolean;
};
export type PhotoRigId = 'softbox' | 'slate' | 'catalog' | 'dramatic' | 'building' | 'mechanic' | 'default';
export type PhotoRig = { id: PhotoRigId; label: string; hint: string; look: StudioLook; lamps: readonly RigSource[] };
export const PHOTO_RIGS: readonly PhotoRig[] = [
  { id: 'softbox', label: 'Grey softbox', hint: 'Balanced key, neutral bounce and clean tabletop shadows', look: 'photo-grey', lamps: [
    { name: 'Softbox key', type: 'sun', direction: [-0.85, 1.9, 0.95], intensity: 2.5, color: '#fffdfa', shadow: true },
    { name: 'Cool bounce', type: 'sun', direction: [1.1, 1.4, -0.45], intensity: 0.52, color: '#e8efff' },
    { name: 'Soft rim', type: 'sun', direction: [0.5, 1.2, -1.1], intensity: 0.26, color: '#ffffff' },
    { name: 'Ambient bounce', type: 'ambient', direction: [0, 1, 0], intensity: 0.35, color: '#ffffff' },
  ] },
  { id: 'slate', label: 'Blue editorial', hint: 'Warm side key and blue edge light for dramatic part definition', look: 'slate-blue', lamps: [
    { name: 'Warm key', type: 'sun', direction: [-0.9, 1.6, 0.7], intensity: 2.85, color: '#fff7e8', shadow: true },
    { name: 'Blue fill', type: 'sun', direction: [1.15, 1.1, -0.4], intensity: 0.5, color: '#dceaff' },
    { name: 'Blue rim', type: 'sun', direction: [0.6, 1.4, -1.1], intensity: 0.75, color: '#c9ddff' },
    { name: 'Ambient bounce', type: 'ambient', direction: [0, 1, 0], intensity: 0.22, color: '#e6f0ff' },
  ] },
  { id: 'catalog', label: 'Warm catalog', hint: 'Large warm key with soft, slightly cool fill', look: 'sandstone', lamps: [
    { name: 'Warm key', type: 'sun', direction: [-1.1, 1.65, 0.55], intensity: 2.75, color: '#ffe6c5', shadow: true },
    { name: 'Cool bounce', type: 'sun', direction: [0.9, 1.3, -0.8], intensity: 0.55, color: '#e3eeff' },
    { name: 'Warm edge', type: 'sun', direction: [0.65, 1.1, -1.25], intensity: 0.32, color: '#fff4d8' },
    { name: 'Ambient bounce', type: 'ambient', direction: [0, 1, 0], intensity: 0.3, color: '#fff1df' },
  ] },
  { id: 'dramatic', label: 'Dark rim light', hint: 'Strong angled key and bright edge for a moody product shot', look: 'graphite', lamps: [
    { name: 'Focused key', type: 'sun', direction: [-1, 1.6, 0.6], intensity: 3.25, color: '#fff3e4', shadow: true },
    { name: 'Dim fill', type: 'sun', direction: [1.1, 1.1, 0], intensity: 0.22, color: '#d0e4ff' },
    { name: 'Cool rim', type: 'sun', direction: [0.7, 1.1, -1.2], intensity: 1.05, color: '#b7d6ff' },
    { name: 'Ambient bounce', type: 'ambient', direction: [0, 1, 0], intensity: 0.14, color: '#cedcef' },
  ] },
  // The BrickLink Studio rigs: decoded from PhotoRealisticRenderer/mac/settings_camera_light.xml
  // (Cycles sun lights: direction = −Z column of the preset transform, converted to Y-up).
  { id: 'default', label: 'BrickLink · default', hint: "EyeSight's DEFAULT set: a small hard key, broad fill and rim over a teal studio", look: 'eyesight', lamps: [
    { name: 'Hard key', type: 'sun', direction: [-0.57, 0.5, -0.65], intensity: 2.4, color: '#ffffff', shadow: true },
    { name: 'Broad fill', type: 'sun', direction: [0.88, 0.34, 0.35], intensity: 1.3, color: '#ffffff' },
    { name: 'Soft rim', type: 'sun', direction: [-0.61, 0.65, 0.45], intensity: 0.9, color: '#ffffff' },
    { name: 'Ambient', type: 'ambient', direction: [0, 1, 0], intensity: 0.35, color: '#ffffff' },
  ] },
  { id: 'building', label: 'BrickLink · building', hint: "EyeSight's BUILD set: four equal softboxes, front-left strongest", look: 'eyesight', lamps: [
    { name: 'Front-left softbox', type: 'sun', direction: [-0.61, 0.65, 0.45], intensity: 2.8, color: '#ffffff', shadow: true },
    { name: 'Front-right softbox', type: 'sun', direction: [0.61, 0.78, 0.15], intensity: 1.2, color: '#ffffff' },
    { name: 'Rear-left softbox', type: 'sun', direction: [-0.57, 0.5, -0.65], intensity: 1.0, color: '#ffffff' },
    { name: 'Ambient', type: 'ambient', direction: [0, 1, 0], intensity: 0.3, color: '#ffffff' },
  ] },
  { id: 'mechanic', label: 'BrickLink · mechanic', hint: "EyeSight's MECHANIC set: subdued main light, broad fill and a grey rim", look: 'eyesight', lamps: [
    { name: 'Main key', type: 'sun', direction: [-0.5, 0.37, 0.79], intensity: 1.6, color: '#ffffff', shadow: true },
    { name: 'Broad fill', type: 'sun', direction: [-0.6, 0.13, 0.79], intensity: 0.8, color: '#ffffff' },
    { name: 'Grey rim', type: 'sun', direction: [-0.51, 0.38, -0.77], intensity: 0.5, color: '#8a8a8a' },
    { name: 'Ambient', type: 'ambient', direction: [0, 1, 0], intensity: 0.4, color: '#ffffff' },
  ] },
];

/** Builds fresh light IDs for a project; the camera list and camera region stay
 * untouched when a rig is installed. Distances are in the scene's LDraw units. */
export function createPhotoRigLights(rigId: PhotoRigId, focus: XYZ, radius: number): SceneLight[] {
  const rig = PHOTO_RIGS.find((p) => p.id === rigId);
  if (!rig) throw new Error(`Unknown photo rig: ${rigId}`);
  const scale = Math.max(20, Math.min(10000, Number.isFinite(radius) ? radius : 20)) * 3;
  return rig.lamps.map((lamp) => {
    const norm = Math.hypot(...lamp.direction) || 1;
    const position = lamp.direction.map((coord, i) => focus[i] + coord / norm * scale) as XYZ;
    return {
      kind: 'light', id: freshSceneId(), name: lamp.name, type: lamp.type,
      position, target: [...focus] as XYZ, color: lamp.color,
      intensity: lamp.intensity, angle: 40, distance: 0,
      castShadow: lamp.shadow === true, enabled: true,
    };
  });
}
