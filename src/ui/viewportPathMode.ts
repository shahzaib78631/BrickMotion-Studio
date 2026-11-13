import type { Studio } from '../render/studio';
import type { StudioPathRenderer } from '../render/studioPathRenderer';
import type { Palette } from '../render/looks';

/** Owns the second canvas; the original canvas keeps all pointer/editing controls. */
export class ViewportPathMode {
  private canvas = document.createElement('canvas');
  private status = document.createElement('output');
  private engine: StudioPathRenderer | null = null;
  private generation = 0;
  private active = false;
  private failed = false;
  private statusAt = 0;
  private originalStyle: { position: string; zIndex: string };

  constructor(private studio: Studio, private input: HTMLCanvasElement) {
    this.originalStyle = { position: input.style.position, zIndex: input.style.zIndex };
    Object.assign(this.canvas.style, { position: 'absolute', pointerEvents: 'none', zIndex: '0', display: 'none' });
    this.canvas.setAttribute('aria-label', 'Studio path viewport');
    this.status.setAttribute('role', 'status');
    Object.assign(this.status.style, { position: 'absolute', left: '12px', top: '90px', zIndex: '4', padding: '5px 9px', borderRadius: '6px', background: '#181818cc', color: '#fff', fontSize: '11px', pointerEvents: 'none', display: 'none' });
    input.before(this.canvas); input.parentElement!.append(this.status);
  }

  render(mode: 'live' | 'studio-path' | 'studio-hybrid', palette: Palette, frame?: { x: number; y: number; width: number; height: number }): boolean {
    if (mode === 'live') {
      if (this.active) this.stop();
      return false;
    }
    const bounds = this.input.getBoundingClientRect();
    const width = Math.max(1, Math.round(frame?.width ?? bounds.width));
    const height = Math.max(1, Math.round(frame?.height ?? bounds.height));
    if (!this.active) {
      this.active = true; this.failed = false;
      // A previous async initialization may still be finishing after a switch.
      // Give each generation its own canvas/context so its cleanup is isolated.
      const canvas = this.canvas.cloneNode(false) as HTMLCanvasElement;
      this.canvas.replaceWith(canvas); this.canvas = canvas;
      this.status.style.display = ''; this.status.textContent = 'Studio path · loading…';
      const generation = ++this.generation;
      void import('../render/studioPathRenderer').then(({ StudioPathRenderer }) => StudioPathRenderer.create(canvas, this.studio, { width, height, palette, samples: 64, interactive: true })).then((engine) => {
        if (generation !== this.generation) { engine.dispose(); return; }
        this.engine = engine;
      }).catch((error) => { if (generation === this.generation) this.fail(error); });
    }
    if (!this.engine || this.failed) return false;
    try {
      Object.assign(this.canvas.style, { display: 'block', left: `${frame?.x ?? 0}px`, top: `${frame?.y ?? 0}px`, width: `${frame?.width ?? bounds.width}px`, height: `${frame?.height ?? bounds.height}px` });
      this.input.style.position = 'relative'; this.input.style.zIndex = '1';
      this.engine.setHybrid(mode === 'studio-hybrid');
      this.engine.setSize(width, height); this.engine.setPalette(palette);
      this.engine.renderSample();
      this.studio.renderOverlay(frame);
      if (performance.now() - this.statusAt > 500) { this.status.textContent = this.engine.status; this.statusAt = performance.now(); }
      return true;
    } catch (error) { this.fail(error); return false; }
  }

  private fail(error: unknown): void {
    this.failed = true; this.engine?.dispose(); this.engine = null;
    this.canvas.style.display = 'none';
    Object.assign(this.input.style, this.originalStyle);
    this.status.textContent = `Studio path unavailable: ${error instanceof Error ? error.message : String(error)} · showing current viewport`;
  }
  private stop(): void {
    this.generation++; this.engine?.dispose(); this.engine = null; this.active = false;
    this.canvas.style.display = 'none'; this.status.style.display = 'none';
    Object.assign(this.input.style, this.originalStyle);
  }
  dispose(): void { this.stop(); this.canvas.remove(); this.status.remove(); }
}
