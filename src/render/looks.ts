/** Scenes (backdrop, floor and lighting) and brick materials. Pure data, shared by
 * the viewport, the preview, MP4 export and still capture so they always agree. */

/** A scene preset: the studio around the model. */
export type StudioLook = 'soft' | 'classic' | 'white' | 'dark' | 'warm' | 'sky' | 'night' | 'chroma'
  | 'photo-grey' | 'slate-blue' | 'porcelain' | 'sage' | 'sandstone' | 'graphite'
  | 'lavender' | 'render-grey' | 'steel-grey' | 'powder-blue' | 'mint' | 'peach' | 'blush' | 'butter' | 'cobalt';
/** What the model stands on. 'auto' is the scene's own choice. */
export type FloorSurface = 'auto' | 'shadow' | 'sweep' | 'reflective' | 'matte' | 'wood' | 'concrete' | 'none';
/** How the plastic itself responds to light. */
export type BrickFinish = 'studio' | 'render' | 'soft-touch' | 'glossy' | 'satin' | 'matte' | 'pearl' | 'clay';
/** A fine surface detail drawn on every part (procedural: it moves with the part). */
export type BrickTexture = 'none' | 'grain' | 'worn' | 'speckle' | 'glitter';

export type Materials = { finish: BrickFinish; texture: BrickTexture; floor: FloorSurface; /** raised LEGO logo on studs */ studLogos: boolean; /** 'high': smooth 48-segment curves and real rounded edges in the geometry */ detail?: 'standard' | 'high'; /** a thin highlight on convex edges, like moulded rounded corners */ roundedEdges: boolean; /** ambient occlusion: on/off, and overrides of the scene's own strength and reach */ ao: AOChoice;
  /** soft blurred shadow pooled under the model, 0–1 */ contactShadows: number;
  /** what the plastic reflects and is lit by */ environment: EnvironmentId;
  /** colours that give off light (lamps, windows): in the viewport and as light sources in path tracing */ glow: GlowChoice;
  /** transparent parts: 'clear' refracts light like real glass in path-traced renders */ glass: GlassLook;
  /** depth of field for final renders and MP4 export */ lens: LensChoice;
  /** the floor colour of the curved sweep and the matte table (sRGB hex); null: the scene's own */
  floorColor?: string | null;
  /** how big the curved sweep's bend is, 0 (a tight corner) to 1 (a long, soft curve) */
  sweepCurve?: number };
/** Light-up parts, by LDraw colour code. `strength` scales how bright they glow. */
export type GlowChoice = { colors: number[]; strength: number };
export const GLOW_STRENGTH_RANGE = [0.25, 4] as const;
export type GlassLook = 'soft' | 'clear';
export const GLASS_LOOKS: { id: GlassLook; label: string; hint: string }[] = [
  { id: 'soft', label: 'Soft', hint: 'Frosted, partly see-through: the same everywhere' },
  { id: 'clear', label: 'Clear', hint: 'Real refracting glass in path-traced renders and videos' },
];
/** Background blur: off, or how wide the blur gets (see LENS_BLUR_PX). */
export type LensBlur = 'off' | 'subtle' | 'medium' | 'strong';
/** `focus`: where the sharp plane sits, 0 = the nearest point of the model, 1 = the farthest. */
export type LensChoice = { blur: LensBlur; focus: number };
export const LENS_BLURS: { id: LensBlur; label: string; hint: string }[] = [
  { id: 'off', label: 'Off', hint: 'Everything sharp' },
  { id: 'subtle', label: 'Subtle', hint: 'A slight softening away from the focus' },
  { id: 'medium', label: 'Medium', hint: 'Product-shot blur' },
  { id: 'strong', label: 'Strong', hint: 'Macro lens: a shallow sharp band' },
];
/** Largest blur radius in pixels on a 1080-pixel-tall frame (scaled with the frame). */
export const LENS_BLUR_PX: Record<LensBlur, number> = { off: 0, subtle: 5, medium: 10, strong: 18 };
/** Lighting environments: the built-in grey room, or HDR photos (see public/hdri/CREDITS.txt). */
/** `gain` brings each photo's average brightness (measured over the sphere) near the studio room's, so switching keeps the exposure; Night stays a little darker. */
export const ENVIRONMENTS = [
  { id: 'room', label: 'Studio room', hint: 'Neutral grey room, generated in the browser', file: null, gain: 1 },
  { id: 'studio', label: 'Photo studio', hint: 'Softboxes in a white photo studio', file: 'studio_small_09_1k.hdr', gain: 0.88 },
  { id: 'city', label: 'City', hint: 'Bright city street: lively, varied reflections', file: 'potsdamer_platz_1k.hdr', gain: 1.34 },
  { id: 'sunset', label: 'Sunset', hint: 'Warm low sun, long golden highlights', file: 'venice_sunset_1k.hdr', gain: 1.5 },
  { id: 'night', label: 'Night', hint: 'Dark sky with scattered lights: moody, glossy', file: 'dikhololo_night_1k.hdr', gain: 6.5 },
  { id: 'warehouse', label: 'Warehouse', hint: 'Large windows and industrial light', file: 'empty_warehouse_01_1k.hdr', gain: 0.96 },
] as const;
export type EnvironmentId = (typeof ENVIRONMENTS)[number]['id'];
/** Ambient occlusion. `strength` (0–1.5) and `radius` (studs) are null to use the scene's own values. */
export type AOChoice = { enabled: boolean; strength: number | null; radius: number | null };
export const AO_STRENGTH_RANGE = [0, 1.5] as const;
export const AO_RADIUS_RANGE = [0.1, 1.5] as const;
/** The occlusion a scene ends up with once the user's choice is applied. */
export function aoFor(look: StudioLook, choice: AOChoice): { intensity: number; radius: number } {
  const scene = sceneOf(look);
  return {
    intensity: choice.enabled ? choice.strength ?? scene.ao ?? 0 : 0,
    radius: choice.radius ?? scene.aoRadius ?? 0.45,
  };
}
export const DEFAULT_MATERIALS: Materials = { finish: 'studio', texture: 'none', floor: 'auto', studLogos: true, detail: 'standard', roundedEdges: true, ao: { enabled: true, strength: null, radius: null }, contactShadows: 0.5, environment: 'room', glow: { colors: [], strength: 1.5 }, glass: 'soft', lens: { blur: 'off', focus: 0.4 }, floorColor: null, sweepCurve: 0.6 };

type RGB = readonly [number, number, number];
/** Relative direction from the subject towards each studio light (Y is up). */
export type LightDirection = readonly [number, number, number];
export type ScenePreset = {
  id: StudioLook;
  label: string;
  hint: string;
  /** Photo and render presets are separated in the chooser but use the same rendering path. */
  collection?: 'photo' | 'render';
  /** Screen-space backdrop: bottom (0) to top (1) colour stops, sRGB bytes. */
  stops: readonly { at: number; rgb: RGB }[];
  /** An optional soft pool of light on the backdrop (0..1 screen coordinates, top-left origin). */
  spot?: { x: number; y: number; radius: number; rgb: RGB };
  /** The floor colour of matte, wood-tinted and reflective floors (sRGB hex). */
  floorColor: string;
  /** Floor used when the material's floor is 'auto'. */
  floor: Exclude<FloorSurface, 'auto'>;
  shadowColor: string;
  shadowOpacity: number;
  hemi: number;
  hemiGround: string;
  key: number;
  keyColor: string;
  /** Directional studio rig: lights follow the subject's bounds as it moves. */
  keyDirection?: LightDirection;
  fill: number;
  fillColor?: string;
  fillDirection?: LightDirection;
  /** Optional non-shadow-casting edge light, opposite the key. */
  rim?: number;
  rimColor?: string;
  rimDirection?: LightDirection;
  env: number;
  exposure: number;
  /** How strongly a reflective floor mirrors the model. */
  reflection: number;
  /** Ambient occlusion strength (0..1): soft darkening where parts meet the floor and each other. */
  ao?: number;
  /** How far that darkening reaches, in studs. */
  aoRadius?: number;
  /** Key-light shadow blur in shadow-map texels (default 4). */
  shadowSoftness?: number;
  /** false: picking this scene switches the edge-lines toggle off (the toggle still decides). */
  outlines?: boolean;
};

export const SCENES: readonly ScenePreset[] = [
  // Seamless tabletop looks inspired by overhead brick-part photography. Their
  // shadows come from the real directional key light, not a painted image.
  { id: 'photo-grey', label: 'Reference grey', hint: 'Mid-grey tabletop, angled softbox and short contact shadows', collection: 'photo',
    stops: [{ at: 0, rgb: [153, 155, 158] }, { at: 0.55, rgb: [160, 162, 165] }, { at: 1, rgb: [171, 173, 175] }],
    floorColor: '#a0a2a5', floor: 'shadow', shadowColor: '#25282c', shadowOpacity: 0.39,
    hemi: 0.95, hemiGround: '#b3b6b9', key: 2.5, keyColor: '#fffdfa', keyDirection: [-0.85, 1.9, 0.95],
    fill: 0.52, fillColor: '#e8efff', fillDirection: [1.1, 1.4, -0.45], rim: 0.26, rimColor: '#ffffff', rimDirection: [0.5, 1.2, -1.1],
    env: 0.7, exposure: 1, reflection: 0.1,
    ao: 0.65, aoRadius: 0.45, shadowSoftness: 6 },
  { id: 'slate-blue', label: 'Slate blue', hint: 'Blue paper backdrop with cool fill and sculpted shadows', collection: 'photo',
    stops: [{ at: 0, rgb: [72, 89, 121] }, { at: 0.6, rgb: [79, 96, 129] }, { at: 1, rgb: [89, 108, 142] }],
    floorColor: '#506282', floor: 'shadow', shadowColor: '#101b2f', shadowOpacity: 0.43,
    hemi: 0.7, hemiGround: '#526985', key: 2.85, keyColor: '#fff7e8', keyDirection: [-0.9, 1.6, 0.7],
    fill: 0.5, fillColor: '#dceaff', fillDirection: [1.15, 1.1, -0.4], rim: 0.75, rimColor: '#c9ddff', rimDirection: [0.6, 1.4, -1.1],
    env: 0.55, exposure: 1.06, reflection: 0.08,
    ao: 0.65, aoRadius: 0.45, shadowSoftness: 6 },
  { id: 'porcelain', label: 'Porcelain', hint: 'Light neutral sweep with high-key diffused illumination', collection: 'photo',
    stops: [{ at: 0, rgb: [207, 208, 207] }, { at: 0.55, rgb: [221, 221, 219] }, { at: 1, rgb: [232, 231, 228] }],
    floorColor: '#d9d9d6', floor: 'shadow', shadowColor: '#3c3d3f', shadowOpacity: 0.28,
    hemi: 1.15, hemiGround: '#d1d0d0', key: 2.25, keyColor: '#ffffff', keyDirection: [-0.6, 2, 0.7],
    fill: 0.72, fillColor: '#f3f5ff', fillDirection: [1.2, 1.5, -0.35], rim: 0.28, rimColor: '#ffffff', rimDirection: [0.4, 1.3, -1.2],
    env: 0.85, exposure: 0.98, reflection: 0.1,
    ao: 0.65, aoRadius: 0.45, shadowSoftness: 6 },
  { id: 'sage', label: 'Sage paper', hint: 'Muted olive backdrop with clean daylight and soft edge light', collection: 'photo',
    stops: [{ at: 0, rgb: [150, 157, 138] }, { at: 0.55, rgb: [170, 177, 155] }, { at: 1, rgb: [191, 196, 177] }],
    floorColor: '#abb39e', floor: 'shadow', shadowColor: '#333a30', shadowOpacity: 0.36,
    hemi: 0.9, hemiGround: '#b0b7a4', key: 2.6, keyColor: '#fff8e9', keyDirection: [-0.85, 1.7, 1.15],
    fill: 0.55, fillColor: '#e2efff', fillDirection: [1, 1.2, -0.6], rim: 0.3, rimColor: '#f2ffe5', rimDirection: [0.7, 1.3, -1],
    env: 0.7, exposure: 1.02, reflection: 0.08,
    ao: 0.65, aoRadius: 0.45, shadowSoftness: 6 },
  { id: 'sandstone', label: 'Warm catalog', hint: 'Beige tabletop with a warm key and subtle cool bounce', collection: 'photo',
    stops: [{ at: 0, rgb: [193, 175, 153] }, { at: 0.55, rgb: [211, 196, 174] }, { at: 1, rgb: [224, 213, 193] }],
    floorColor: '#d4c2a9', floor: 'shadow', shadowColor: '#493827', shadowOpacity: 0.34,
    hemi: 0.82, hemiGround: '#c7b69d', key: 2.75, keyColor: '#ffe6c5', keyDirection: [-1.1, 1.65, 0.55],
    fill: 0.55, fillColor: '#e3eeff', fillDirection: [0.9, 1.3, -0.8], rim: 0.32, rimColor: '#fff4d8', rimDirection: [0.65, 1.1, -1.25],
    env: 0.65, exposure: 1, reflection: 0.08,
    ao: 0.65, aoRadius: 0.45, shadowSoftness: 6 },
  { id: 'graphite', label: 'Graphite', hint: 'Dark matte editorial set with bright rim separation', collection: 'photo',
    stops: [{ at: 0, rgb: [54, 59, 68] }, { at: 0.5, rgb: [47, 53, 62] }, { at: 1, rgb: [37, 43, 52] }],
    spot: { x: 0.47, y: 0.38, radius: 0.86, rgb: [77, 84, 97] },
    floorColor: '#343b45', floor: 'shadow', shadowColor: '#080b12', shadowOpacity: 0.58,
    hemi: 0.35, hemiGround: '#303b48', key: 3.25, keyColor: '#fff3e4', keyDirection: [-1.0, 1.6, 0.6],
    fill: 0.22, fillColor: '#d0e4ff', fillDirection: [1.1, 1.1, 0], rim: 1.05, rimColor: '#b7d6ff', rimDirection: [0.7, 1.1, -1.2],
    env: 0.4, exposure: 1.07, reflection: 0.1,
    ao: 0.65, aoRadius: 0.45, shadowSoftness: 6 },
  // Pastel seamless render looks: a large overhead softbox, short soft contact
  // shadows tinted by the backdrop and a bright environment for broad highlights.
  { id: 'lavender', label: 'Lavender', hint: 'Saturated lilac sweep with tinted overhead shadows', collection: 'render',
    stops: [{ at: 0, rgb: [146, 124, 228] }, { at: 0.6, rgb: [152, 131, 232] }, { at: 1, rgb: [158, 138, 236] }],
    floorColor: '#9883e8', floor: 'shadow', shadowColor: '#2f1d74', shadowOpacity: 0.32,
    hemi: 1.0, hemiGround: '#a493ee', key: 2.3, keyColor: '#ffffff', keyDirection: [-0.35, 2.4, 0.55],
    fill: 0.55, fillColor: '#ffffff', fillDirection: [1, 1.6, 0.2], rim: 0.3, rimColor: '#ffffff', rimDirection: [0.3, 1.4, -1.2],
    env: 0.9, exposure: 1.0, reflection: 0.08,
    ao: 0.9, aoRadius: 0.5, shadowSoftness: 9, outlines: false },
  { id: 'render-grey', label: 'Render grey', hint: 'Cool light grey seamless with soft overhead light', collection: 'render',
    stops: [{ at: 0, rgb: [172, 174, 179] }, { at: 0.6, rgb: [178, 180, 185] }, { at: 1, rgb: [184, 186, 191] }],
    floorColor: '#b2b4b9', floor: 'shadow', shadowColor: '#2a2d33', shadowOpacity: 0.3,
    hemi: 1.0, hemiGround: '#c4c6cb', key: 2.3, keyColor: '#ffffff', keyDirection: [-0.35, 2.4, 0.55],
    fill: 0.55, fillColor: '#ffffff', fillDirection: [1, 1.6, 0.2], rim: 0.3, rimColor: '#ffffff', rimDirection: [0.3, 1.4, -1.2],
    env: 0.9, exposure: 1.0, reflection: 0.08,
    ao: 0.9, aoRadius: 0.5, shadowSoftness: 9, outlines: false },
  { id: 'steel-grey', label: 'Steel grey', hint: 'Mid cool grey seamless, a touch darker and crisper', collection: 'render',
    stops: [{ at: 0, rgb: [156, 158, 164] }, { at: 0.6, rgb: [161, 163, 169] }, { at: 1, rgb: [166, 168, 174] }],
    floorColor: '#a1a3a9', floor: 'shadow', shadowColor: '#1f2229', shadowOpacity: 0.34,
    hemi: 1.0, hemiGround: '#b3b5bb', key: 2.4, keyColor: '#ffffff', keyDirection: [-0.35, 2.4, 0.55],
    fill: 0.55, fillColor: '#ffffff', fillDirection: [1, 1.6, 0.2], rim: 0.3, rimColor: '#ffffff', rimDirection: [0.3, 1.4, -1.2],
    env: 0.9, exposure: 1.0, reflection: 0.08,
    ao: 0.9, aoRadius: 0.5, shadowSoftness: 9, outlines: false },
  { id: 'powder-blue', label: 'Powder blue', hint: 'Soft sky-blue sweep for bright, airy shots', collection: 'render',
    stops: [{ at: 0, rgb: [150, 190, 235] }, { at: 0.6, rgb: [159, 197, 238] }, { at: 1, rgb: [168, 204, 242] }],
    floorColor: '#9fc5ee', floor: 'shadow', shadowColor: '#17345e', shadowOpacity: 0.3,
    hemi: 1.0, hemiGround: '#b5d3f4', key: 2.3, keyColor: '#ffffff', keyDirection: [-0.35, 2.4, 0.55],
    fill: 0.55, fillColor: '#ffffff', fillDirection: [1, 1.6, 0.2], rim: 0.3, rimColor: '#ffffff', rimDirection: [0.3, 1.4, -1.2],
    env: 0.9, exposure: 1.0, reflection: 0.08,
    ao: 0.9, aoRadius: 0.5, shadowSoftness: 9, outlines: false },
  { id: 'mint', label: 'Mint', hint: 'Fresh pastel green seamless', collection: 'render',
    stops: [{ at: 0, rgb: [152, 214, 190] }, { at: 0.6, rgb: [161, 220, 197] }, { at: 1, rgb: [170, 226, 204] }],
    floorColor: '#a1dcc5', floor: 'shadow', shadowColor: '#14503a', shadowOpacity: 0.28,
    hemi: 1.0, hemiGround: '#b8e8d4', key: 2.3, keyColor: '#ffffff', keyDirection: [-0.35, 2.4, 0.55],
    fill: 0.55, fillColor: '#ffffff', fillDirection: [1, 1.6, 0.2], rim: 0.3, rimColor: '#ffffff', rimDirection: [0.3, 1.4, -1.2],
    env: 0.9, exposure: 1.0, reflection: 0.08,
    ao: 0.9, aoRadius: 0.5, shadowSoftness: 9, outlines: false },
  { id: 'peach', label: 'Peach', hint: 'Warm pastel orange with soft warm bounce', collection: 'render',
    stops: [{ at: 0, rgb: [242, 184, 156] }, { at: 0.6, rgb: [245, 191, 165] }, { at: 1, rgb: [248, 198, 174] }],
    floorColor: '#f5bfa5', floor: 'shadow', shadowColor: '#6a2c12', shadowOpacity: 0.28,
    hemi: 1.0, hemiGround: '#f8cdb6', key: 2.2, keyColor: '#fff6ee', keyDirection: [-0.35, 2.4, 0.55],
    fill: 0.55, fillColor: '#fff0e4', fillDirection: [1, 1.6, 0.2], rim: 0.3, rimColor: '#ffffff', rimDirection: [0.3, 1.4, -1.2],
    env: 0.9, exposure: 0.98, reflection: 0.08,
    ao: 0.9, aoRadius: 0.5, shadowSoftness: 9, outlines: false },
  { id: 'blush', label: 'Blush pink', hint: 'Pastel pink sweep for playful sets', collection: 'render',
    stops: [{ at: 0, rgb: [238, 168, 192] }, { at: 0.6, rgb: [242, 176, 199] }, { at: 1, rgb: [246, 184, 206] }],
    floorColor: '#f2b0c7', floor: 'shadow', shadowColor: '#6b1838', shadowOpacity: 0.28,
    hemi: 1.0, hemiGround: '#f6c4d6', key: 2.2, keyColor: '#ffffff', keyDirection: [-0.35, 2.4, 0.55],
    fill: 0.55, fillColor: '#ffffff', fillDirection: [1, 1.6, 0.2], rim: 0.3, rimColor: '#ffffff', rimDirection: [0.3, 1.4, -1.2],
    env: 0.9, exposure: 0.98, reflection: 0.08,
    ao: 0.9, aoRadius: 0.5, shadowSoftness: 9, outlines: false },
  { id: 'butter', label: 'Butter yellow', hint: 'Pale warm yellow seamless', collection: 'render',
    stops: [{ at: 0, rgb: [240, 218, 140] }, { at: 0.6, rgb: [244, 224, 151] }, { at: 1, rgb: [247, 230, 162] }],
    floorColor: '#f4e097', floor: 'shadow', shadowColor: '#6a5410', shadowOpacity: 0.26,
    hemi: 1.0, hemiGround: '#f6e6aa', key: 2.15, keyColor: '#fffaf0', keyDirection: [-0.35, 2.4, 0.55],
    fill: 0.55, fillColor: '#fff8e6', fillDirection: [1, 1.6, 0.2], rim: 0.3, rimColor: '#ffffff', rimDirection: [0.3, 1.4, -1.2],
    env: 0.9, exposure: 0.97, reflection: 0.08,
    ao: 0.9, aoRadius: 0.5, shadowSoftness: 9, outlines: false },
  { id: 'cobalt', label: 'Cobalt', hint: 'Bold saturated blue backdrop for strong contrast', collection: 'render',
    stops: [{ at: 0, rgb: [52, 92, 214] }, { at: 0.6, rgb: [58, 99, 221] }, { at: 1, rgb: [64, 106, 228] }],
    floorColor: '#3a63dd', floor: 'shadow', shadowColor: '#06154c', shadowOpacity: 0.4,
    hemi: 0.85, hemiGround: '#5a7ee0', key: 2.6, keyColor: '#ffffff', keyDirection: [-0.35, 2.4, 0.55],
    fill: 0.55, fillColor: '#ffffff', fillDirection: [1, 1.6, 0.2], rim: 0.3, rimColor: '#ffffff', rimDirection: [0.3, 1.4, -1.2],
    env: 0.9, exposure: 1.04, reflection: 0.08,
    ao: 0.9, aoRadius: 0.5, shadowSoftness: 9, outlines: false },
  { id: 'soft', label: 'Soft studio', hint: 'Neutral grey, soft contact shadows',
    stops: [{ at: 0, rgb: [172, 171, 180] }, { at: 0.3, rgb: [179, 178, 187] }, { at: 0.58, rgb: [184, 183, 192] }, { at: 0.83, rgb: [199, 198, 207] }, { at: 1, rgb: [207, 206, 214] }],
    floorColor: '#b8b7c0', floor: 'shadow', shadowColor: '#262630', shadowOpacity: 0.42,
    hemi: 0.85, hemiGround: '#c5c6ce', key: 2.35, keyColor: '#ffffff', fill: 0.38, env: 0.75, exposure: 1, reflection: 0.3 },
  { id: 'classic', label: 'Bright studio', hint: 'Plain light backdrop, lit floor',
    stops: [{ at: 0, rgb: [237, 237, 239] }, { at: 1, rgb: [237, 237, 239] }],
    floorColor: '#ededef', floor: 'matte', shadowColor: '#262630', shadowOpacity: 0.42,
    hemi: 1.1, hemiGround: '#c5c6ce', key: 2.2, keyColor: '#ffffff', fill: 0, env: 0.6, exposure: 1.05, reflection: 0.25 },
  { id: 'white', label: 'White seamless', hint: 'Product-shot white with a glossy floor',
    stops: [{ at: 0, rgb: [238, 238, 241] }, { at: 0.55, rgb: [246, 246, 248] }, { at: 1, rgb: [252, 252, 253] }],
    floorColor: '#f3f3f5', floor: 'reflective', shadowColor: '#30303a', shadowOpacity: 0.3,
    hemi: 1.05, hemiGround: '#dcdce2', key: 2.1, keyColor: '#ffffff', fill: 0.45, env: 0.85, exposure: 1.04, reflection: 0.22 },
  { id: 'dark', label: 'Dark spotlight', hint: 'Charcoal backdrop with a pool of light',
    stops: [{ at: 0, rgb: [60, 61, 66] }, { at: 0.5, rgb: [42, 43, 48] }, { at: 1, rgb: [30, 31, 35] }],
    spot: { x: 0.62, y: 0.3, radius: 0.75, rgb: [150, 151, 158] },
    floorColor: '#55565c', floor: 'reflective', shadowColor: '#08080a', shadowOpacity: 0.55,
    hemi: 0.45, hemiGround: '#3a3b40', key: 3.1, keyColor: '#fff6ec', fill: 0.25, env: 0.45, exposure: 1.05, reflection: 0.34 },
  { id: 'warm', label: 'Warm paper', hint: 'Soft beige, gentle warm light',
    stops: [{ at: 0, rgb: [226, 214, 196] }, { at: 0.6, rgb: [236, 227, 212] }, { at: 1, rgb: [245, 239, 228] }],
    floorColor: '#e4d8c6', floor: 'shadow', shadowColor: '#3b2e22', shadowOpacity: 0.38,
    hemi: 0.95, hemiGround: '#d7c8b0', key: 2.25, keyColor: '#fff1dc', fill: 0.3, env: 0.7, exposure: 1.02, reflection: 0.25 },
  { id: 'sky', label: 'Sky blue', hint: 'Fresh light-blue gradient',
    stops: [{ at: 0, rgb: [176, 203, 230] }, { at: 0.55, rgb: [203, 222, 241] }, { at: 1, rgb: [231, 240, 250] }],
    floorColor: '#c3d7ec', floor: 'shadow', shadowColor: '#1d2c40', shadowOpacity: 0.36,
    hemi: 0.95, hemiGround: '#b9cbe0', key: 2.2, keyColor: '#ffffff', fill: 0.4, env: 0.75, exposure: 1.02, reflection: 0.25 },
  { id: 'night', label: 'Midnight', hint: 'Deep navy with a cool spotlight',
    stops: [{ at: 0, rgb: [26, 32, 52] }, { at: 0.5, rgb: [17, 21, 36] }, { at: 1, rgb: [11, 13, 24] }],
    spot: { x: 0.5, y: 0.35, radius: 0.7, rgb: [70, 86, 128] },
    floorColor: '#28304a', floor: 'reflective', shadowColor: '#03040a', shadowOpacity: 0.6,
    hemi: 0.4, hemiGround: '#1f2538', key: 3.0, keyColor: '#e8eeff', fill: 0.35, env: 0.4, exposure: 1.08, reflection: 0.36 },
  { id: 'chroma', label: 'Green screen', hint: 'Flat chroma green for compositing, no floor',
    stops: [{ at: 0, rgb: [0, 177, 64] }, { at: 1, rgb: [0, 177, 64] }],
    floorColor: '#00b140', floor: 'none', shadowColor: '#000000', shadowOpacity: 0,
    hemi: 1.0, hemiGround: '#c5c6ce', key: 2.2, keyColor: '#ffffff', fill: 0.38, env: 0.75, exposure: 1, reflection: 0 },
];

// Keep the legacy fallback stable even though photographic presets lead the chooser.
export const sceneOf = (id: string | undefined): ScenePreset => SCENES.find((s) => s.id === id) ?? SCENES.find((s) => s.id === 'soft')!;
export const isStudioLook = (v: unknown): v is StudioLook => typeof v === 'string' && SCENES.some((s) => s.id === v);

export type FinishPreset = {
  id: BrickFinish; label: string; hint: string;
  roughness: number; clearcoat: number; clearcoatRoughness: number; metalness: number;
  /** Paint every opaque part this colour (a clay render). */
  tint?: string;
  iridescence?: number;
  /** Soft light that gathers at grazing angles (MeshPhysicalMaterial sheen). */
  sheen?: number;
};
export const FINISHES: readonly FinishPreset[] = [
  { id: 'studio', label: 'Studio plastic', hint: 'Soft, broad highlights', roughness: 0.42, clearcoat: 0.16, clearcoatRoughness: 0.36, metalness: 0 },
  { id: 'render', label: 'Render plastic', hint: 'Clean product-render ABS with broad soft highlights', roughness: 0.3, clearcoat: 0.45, clearcoatRoughness: 0.2, metalness: 0, sheen: 0.15 },
  { id: 'soft-touch', label: 'Soft-touch', hint: 'Low-sheen toy plastic with a velvety edge glow', roughness: 0.5, clearcoat: 0.12, clearcoatRoughness: 0.45, metalness: 0, sheen: 0.45 },
  { id: 'glossy', label: 'Glossy ABS', hint: 'New, shiny bricks', roughness: 0.2, clearcoat: 0.65, clearcoatRoughness: 0.08, metalness: 0 },
  { id: 'satin', label: 'Satin', hint: 'Between glossy and matte', roughness: 0.55, clearcoat: 0.06, clearcoatRoughness: 0.5, metalness: 0 },
  { id: 'matte', label: 'Matte', hint: 'No shine, flat colour', roughness: 0.86, clearcoat: 0, clearcoatRoughness: 1, metalness: 0 },
  { id: 'pearl', label: 'Pearlescent', hint: 'A soft rainbow sheen', roughness: 0.32, clearcoat: 0.5, clearcoatRoughness: 0.15, metalness: 0.25, iridescence: 0.55 },
  { id: 'clay', label: 'Clay render', hint: 'Every part one neutral colour', roughness: 0.9, clearcoat: 0, clearcoatRoughness: 1, metalness: 0, tint: '#dad7d1' },
];
export const finishOf = (id: string | undefined): FinishPreset => FINISHES.find((f) => f.id === id) ?? FINISHES[0];

export const TEXTURES: readonly { id: BrickTexture; label: string; hint: string }[] = [
  { id: 'none', label: 'Smooth', hint: 'Clean, flawless surfaces' },
  { id: 'grain', label: 'Molded grain', hint: 'The fine texture of real injection-moulded parts' },
  { id: 'worn', label: 'Played-with', hint: 'Scuffs and dull patches' },
  { id: 'speckle', label: 'Speckled', hint: 'Granite-like dark speckles' },
  { id: 'glitter', label: 'Glitter', hint: 'Tiny sparkling flakes' },
];

export const FLOORS: readonly { id: FloorSurface; label: string; hint: string }[] = [
  { id: 'auto', label: 'Scene default', hint: 'Whatever the scene uses' },
  { id: 'shadow', label: 'Shadows only', hint: 'Seamless backdrop with contact shadows' },
  { id: 'sweep', label: 'Curved sweep', hint: 'The floor curves up into a back wall, like a product studio paper roll' },
  { id: 'reflective', label: 'Glossy reflective', hint: 'A soft mirror of the model' },
  { id: 'matte', label: 'Matte table', hint: 'A lit floor in the scene colour' },
  { id: 'wood', label: 'Wood', hint: 'Light oak planks' },
  { id: 'concrete', label: 'Concrete', hint: 'Smooth grey concrete' },
  { id: 'none', label: 'No floor', hint: 'No floor or shadows' },
];

const has = <T extends string>(list: readonly { id: T }[], v: unknown): v is T => typeof v === 'string' && list.some((x) => x.id === v);
/** Accepts anything from storage and returns valid materials. */
export function sanitizeMaterials(v: unknown): Materials {
  const o = (v && typeof v === 'object' ? v : {}) as Partial<Record<keyof Materials, unknown>>;
  return {
    finish: has(FINISHES, o.finish) ? o.finish : DEFAULT_MATERIALS.finish,
    texture: has(TEXTURES, o.texture) ? o.texture : DEFAULT_MATERIALS.texture,
    floor: has(FLOORS, o.floor) ? o.floor : DEFAULT_MATERIALS.floor,
    studLogos: typeof o.studLogos === 'boolean' ? o.studLogos : DEFAULT_MATERIALS.studLogos,
    detail: o.detail === 'high' ? 'high' : 'standard',
    roundedEdges: typeof o.roundedEdges === 'boolean' ? o.roundedEdges : DEFAULT_MATERIALS.roundedEdges,
    ao: sanitizeAO(o.ao),
    contactShadows: clampOrNull(o.contactShadows, [0, 1]) ?? DEFAULT_MATERIALS.contactShadows,
    environment: ENVIRONMENTS.some((e) => e.id === o.environment) ? (o.environment as EnvironmentId) : DEFAULT_MATERIALS.environment,
    glow: sanitizeGlow(o.glow),
    glass: o.glass === 'clear' ? 'clear' : 'soft',
    lens: sanitizeLens(o.lens),
    floorColor: typeof o.floorColor === 'string' && /^#[0-9a-f]{6}$/i.test(o.floorColor) ? o.floorColor.toLowerCase() : null,
    sweepCurve: clampOrNull(o.sweepCurve, [0, 1]) ?? DEFAULT_MATERIALS.sweepCurve,
  };
}

/** The floor colour in use: the one picked in Materials, else the scene's. */
export const floorColorOf = (look: StudioLook | undefined, materials: Partial<Materials> | undefined): string =>
  materials?.floorColor ?? sceneOf(look ?? 'soft').floorColor;

/** Floors that take the picked floor colour (the others show the backdrop, a texture or a mirror). */
export const takesFloorColor = (kind: FloorSurface) => kind === 'sweep' || kind === 'matte';
function sanitizeGlow(v: unknown): GlowChoice {
  const o = (v && typeof v === 'object' ? v : {}) as Partial<Record<keyof GlowChoice, unknown>>;
  const colors = Array.isArray(o.colors) ? [...new Set(o.colors.filter((c): c is number => Number.isInteger(c)))] : [];
  return { colors, strength: clampOrNull(o.strength, GLOW_STRENGTH_RANGE) ?? DEFAULT_MATERIALS.glow.strength };
}
function sanitizeLens(v: unknown): LensChoice {
  const o = (v && typeof v === 'object' ? v : {}) as Partial<Record<keyof LensChoice, unknown>>;
  return {
    blur: LENS_BLURS.some((b) => b.id === o.blur) ? (o.blur as LensBlur) : DEFAULT_MATERIALS.lens.blur,
    focus: clampOrNull(o.focus, [0, 1]) ?? DEFAULT_MATERIALS.lens.focus,
  };
}
const clampOrNull = (v: unknown, [lo, hi]: readonly [number, number]): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : null;
function sanitizeAO(v: unknown): AOChoice {
  const o = (v && typeof v === 'object' ? v : {}) as Partial<Record<keyof AOChoice, unknown>>;
  return {
    enabled: typeof o.enabled === 'boolean' ? o.enabled : DEFAULT_MATERIALS.ao.enabled,
    strength: clampOrNull(o.strength, AO_STRENGTH_RANGE),
    radius: clampOrNull(o.radius, AO_RADIUS_RANGE),
  };
}
export const floorFor = (look: StudioLook, floor: FloorSurface): Exclude<FloorSurface, 'auto'> =>
  floor === 'auto' ? sceneOf(look).floor : floor;

/** Backdrop pixels, RGBA, `width` × `height`, bottom row first (DataTexture order). */
export function scenePixels(scene: ScenePreset, width = 64, height = 128): Uint8Array {
  const px = new Uint8Array(width * height * 4);
  const stops = scene.stops;
  for (let y = 0; y < height; y++) {
    const t = height === 1 ? 0 : y / (height - 1); // 0 bottom, 1 top
    let next = 1;
    while (next < stops.length - 1 && t > stops[next].at) next++;
    const a = stops[Math.max(0, next - 1)], b = stops[Math.min(stops.length - 1, next)];
    const f = b.at === a.at ? 0 : Math.max(0, Math.min(1, (t - a.at) / (b.at - a.at)));
    for (let x = 0; x < width; x++) {
      const rgb = [0, 1, 2].map((c) => a.rgb[c] + (b.rgb[c] - a.rgb[c]) * f);
      if (scene.spot) {
        const u = width === 1 ? 0.5 : x / (width - 1);
        const v = 1 - t; // top-left origin, like the spot
        const d = Math.hypot(u - scene.spot.x, (v - scene.spot.y) * 1.25) / scene.spot.radius;
        const k = Math.max(0, 1 - d);
        const w = k * k * (3 - 2 * k);
        for (let c = 0; c < 3; c++) rgb[c] += (scene.spot.rgb[c] - rgb[c]) * w;
      }
      const o = (y * width + x) * 4;
      for (let c = 0; c < 3; c++) px[o + c] = Math.round(Math.max(0, Math.min(255, rgb[c])));
      px[o + 3] = 255;
    }
  }
  return px;
}
