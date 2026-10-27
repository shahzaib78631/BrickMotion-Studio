import type { CSSProperties, ReactNode } from 'react';
import { useAppSettings } from '../state/appSettings';
import { FINISHES, FLOORS, SCENES, TEXTURES, finishOf, sceneOf, type FloorSurface, type Materials, type ScenePreset } from '../render/looks';

const css = (rgb: readonly number[]) => `rgb(${rgb.join(',')})`;
/** The backdrop as CSS: the same stops (and pool of light) the renderer uses. */
function sceneBackground(scene: ScenePreset): string {
  const stops = [...scene.stops].reverse().map((s) => `${css(s.rgb)} ${Math.round((1 - s.at) * 100)}%`).join(', ');
  const linear = `linear-gradient(180deg, ${stops})`;
  if (!scene.spot) return linear;
  const { x, y, radius, rgb } = scene.spot;
  return `radial-gradient(ellipse ${radius * 100}% ${radius * 80}% at ${x * 100}% ${y * 100}%, ${css(rgb)}, transparent 100%), ${linear}`;
}

/** A brick-red ball lit like each finish. */
function finishBall(id: string): CSSProperties {
  const f = finishOf(id);
  const base = f.tint ?? '#b3261e';
  const spec = Math.round(255 * (0.35 + f.clearcoat * 0.6));
  const size = Math.round(18 + f.roughness * 55);
  const sheen = f.iridescence ? `, conic-gradient(from 200deg at 60% 60%, #ffd6f566, #b7f0ff66, #fff6b766, #ffd6f566)` : '';
  return {
    background: `radial-gradient(circle at 34% 30%, rgba(${spec},${spec},${spec},${0.55 + f.clearcoat * 0.4}) 0, transparent ${size}%)${sheen}, radial-gradient(circle at 50% 55%, ${base} 0, color-mix(in srgb, ${base} 55%, #000) 100%)`,
  };
}

const TEXTURE_SWATCH: Record<string, string> = {
  none: 'linear-gradient(135deg, #c7362b, #9e2219)',
  grain: 'repeating-radial-gradient(circle at 30% 40%, #b52c22 0 1px, #a8271e 1px 2px)',
  worn: 'radial-gradient(circle at 30% 30%, #c46b63 0 12%, transparent 30%), linear-gradient(120deg, transparent 45%, #d8857d 46% 48%, transparent 49%), linear-gradient(135deg, #b9332a, #8f2018)',
  speckle: 'radial-gradient(circle at 20% 30%, #3b0e0a 0 4%, transparent 5%), radial-gradient(circle at 65% 60%, #3b0e0a 0 5%, transparent 6%), radial-gradient(circle at 80% 20%, #3b0e0a 0 3%, transparent 4%), radial-gradient(circle at 40% 80%, #3b0e0a 0 4%, transparent 5%), linear-gradient(135deg, #c7362b, #9e2219)',
  glitter: 'radial-gradient(circle at 25% 35%, #fff 0 3%, transparent 4%), radial-gradient(circle at 70% 25%, #fff 0 2%, transparent 3%), radial-gradient(circle at 55% 70%, #ffe 0 3%, transparent 4%), radial-gradient(circle at 15% 80%, #fff 0 2%, transparent 3%), linear-gradient(135deg, #c7362b, #9e2219)',
};
const FLOOR_SWATCH: Record<FloorSurface, string> = {
  auto: 'linear-gradient(180deg, #d9d9df 50%, #c9c9d0 50%)',
  shadow: 'radial-gradient(ellipse 45% 18% at 50% 70%, #00000055, transparent), linear-gradient(180deg, #d2d2d8, #c4c4cc)',
  reflective: 'linear-gradient(180deg, #e6e6ea 52%, #f4f4f7 52%), linear-gradient(0deg, #b3261e33, transparent)',
  matte: 'linear-gradient(180deg, #ececef 50%, #dcdce0 50%)',
  wood: 'repeating-linear-gradient(0deg, #c9a172 0 9px, #b98f60 9px 10px), repeating-linear-gradient(90deg, #00000008 0 2px, transparent 2px 5px)',
  concrete: 'radial-gradient(circle at 30% 40%, #9d9d99 0 2%, transparent 3%), radial-gradient(circle at 70% 70%, #a4a4a0 0 2%, transparent 3%), linear-gradient(135deg, #b9b9b5, #a9a9a5)',
  none: 'repeating-conic-gradient(#e9e9ee 0 25%, #fff 0 50%) 0 0 / 12px 12px',
};

export function Section({ title, value, children }: { title: string; value?: string; children: ReactNode }) {
  return (
    <details className="nx-group bm-vsec bm-mat-sec" open>
      <summary>{title}{value && <span className="bm-vsec-val">{value}</span>}</summary>
      {children}
    </details>
  );
}

export function Card({ selected, label, hint, swatch, onClick }: { selected: boolean; label: string; hint: string; swatch: ReactNode; onClick(): void }) {
  return (
    <button className={`bm-mat-card${selected ? ' selected' : ''}`} aria-pressed={selected} title={hint} onClick={onClick}>
      {swatch}
      <span className="bm-mat-label">{label}</span>
    </button>
  );
}

/** Materials: the scene around the model, how the plastic looks and the floor. The viewport, preview, MP4 and stills all use these. */
export function MaterialsPanel() {
  const s = useAppSettings();
  const m = s.materials;
  const setMaterials = (patch: Partial<Materials>) => s.set({ materials: { ...m, ...patch } });
  const scene = sceneOf(s.studioLook);
  return (
    <div className="nx-pane bm-materials" aria-label="Materials">
      <div className="nx-pane-head"><h3>Materials</h3></div>

      <Section title="Scene" value={scene.label}>
        <div className="nx-sub">Photo tabletop scenes</div>
        <div className="bm-mat-grid bm-mat-scenes">
          {SCENES.filter((sc) => sc.collection === 'photo').map((sc) => (
            <Card key={sc.id} selected={s.studioLook === sc.id} label={sc.label} hint={sc.hint} onClick={() => s.set({ studioLook: sc.id })}
              swatch={<span className="bm-mat-swatch bm-mat-scene bm-mat-photo-scene" style={{ background: sceneBackground(sc) }}>
                <em className="bm-photo-part-a" /><em className="bm-photo-part-b" /><em className="bm-photo-part-c" />
              </span>} />
          ))}
        </div>
        <div className="nx-sub">Classic studio scenes</div>
        <div className="bm-mat-grid bm-mat-scenes">
          {SCENES.filter((sc) => sc.collection !== 'photo').map((sc) => (
            <Card key={sc.id} selected={s.studioLook === sc.id} label={sc.label} hint={sc.hint} onClick={() => s.set({ studioLook: sc.id })}
              swatch={<span className="bm-mat-swatch bm-mat-scene" style={{ background: sceneBackground(sc) }}><i style={{ background: sc.floor === 'none' ? 'transparent' : sc.floorColor }} /></span>} />
          ))}
        </div>
        <span className="nx-hint">{scene.hint}. Photo scenes include a directional key, a color-tuned fill and a rim light. Custom Scene lights can replace this rig.</span>
      </Section>

      <Section title="Brick finish" value={finishOf(m.finish).label}>
        <div className="bm-mat-grid">
          {FINISHES.map((f) => (
            <Card key={f.id} selected={m.finish === f.id} label={f.label} hint={f.hint} onClick={() => setMaterials({ finish: f.id })}
              swatch={<span className="bm-mat-swatch bm-mat-ball" style={finishBall(f.id)} />} />
          ))}
        </div>
        <span className="nx-hint">Transparent, chrome and rubber parts keep their own surface.</span>
      </Section>

      <Section title="Surface texture" value={TEXTURES.find((t) => t.id === m.texture)?.label}>
        <div className="bm-mat-grid">
          {TEXTURES.map((t) => (
            <Card key={t.id} selected={m.texture === t.id} label={t.label} hint={t.hint} onClick={() => setMaterials({ texture: t.id })}
              swatch={<span className="bm-mat-swatch" style={{ background: TEXTURE_SWATCH[t.id] }} />} />
          ))}
        </div>
        <span className="nx-hint">Textures are drawn on each part and move with it. Look closely: they are meant to be subtle.</span>
      </Section>

      <Section title="Floor" value={FLOORS.find((f) => f.id === m.floor)?.label}>
        <div className="bm-mat-grid">
          {FLOORS.map((f) => (
            <Card key={f.id} selected={m.floor === f.id} label={f.label} hint={f.hint} onClick={() => setMaterials({ floor: f.id })}
              swatch={<span className="bm-mat-swatch" style={{ background: FLOOR_SWATCH[f.id] }} />} />
          ))}
        </div>
      </Section>

    </div>
  );
}
