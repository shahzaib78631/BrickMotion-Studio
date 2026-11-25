import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  NativePlaybackState,
  NativeViewPreset,
  NativeViewStyle,
} from '../../electron/types';

interface Props {
  theme: 'light' | 'dark';
  metalAvailable: boolean;
  onFallbackWebGL: () => void;
}

const VIEW_PRESETS: Array<{ id: NativeViewPreset; label: string }> = [
  { id: 'front', label: 'Front' },
  { id: 'back', label: 'Back' },
  { id: 'left', label: 'Left' },
  { id: 'right', label: 'Right' },
  { id: 'top', label: 'Top' },
  { id: 'bottom', label: 'Bottom' },
];

export function NativeMetalViewport({ theme, metalAvailable, onFallbackWebGL }: Props) {
  const api = window.brickMotionNative;
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const renderingRef = useRef(false);
  const dirtyRef = useRef(true);
  const dragRef = useRef<{
    mode: 'orbit' | 'pan';
    lastX: number;
    lastY: number;
    moved: boolean;
    startX: number;
    startY: number;
  } | null>(null);

  const [viewStyle, setViewStyle] = useState<NativeViewStyle>('shaded');
  const [ortho, setOrtho] = useState(false);
  const [edges, setEdges] = useState(true);
  const [floor, setFloor] = useState(true);
  const [shadows, setShadows] = useState(true);
  const [ao, setAo] = useState(true);
  const [playback, setPlayback] = useState<NativePlaybackState | null>(null);
  const [pickedPiece, setPickedPiece] = useState<number | null>(null);
  const [fps, setFps] = useState<number>(0);

  const markDirty = useCallback(() => {
    dirtyRef.current = true;
  }, []);

  // Sync theme background color into Metal viewport
  useEffect(() => {
    if (!api || !metalAvailable) return;
    const bg = theme === 'dark' ? [0.11, 0.12, 0.14] : [0.94, 0.95, 0.97];
    void api.viewportSetBackground(bg[0], bg[1], bg[2]).then(markDirty);
  }, [api, metalAvailable, theme, markDirty]);

  // Sync viewport display preferences
  useEffect(() => {
    if (!api || !metalAvailable) return;
    void api
      .viewportSetPreferences({ edges, floor, shadows, ambientOcclusion: ao, autoPlan: true })
      .then(markDirty);
  }, [api, metalAvailable, edges, floor, shadows, ao, markDirty]);

  // Resize observer
  useEffect(() => {
    if (!api || !metalAvailable || !hostRef.current) return;
    const el = hostRef.current;
    const applyResize = () => {
      const rect = el.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const pw = Math.max(2, Math.floor(rect.width * dpr));
      const ph = Math.max(2, Math.floor(rect.height * dpr));
      void api.viewportResize(pw, ph, dpr).then(markDirty);
    };
    applyResize();
    const ro = new ResizeObserver(applyResize);
    ro.observe(el);
    return () => ro.disconnect();
  }, [api, metalAvailable, markDirty]);

  // Main Metal render loop (driven by rAF; only renders when dirty, playing, or Metal wants another pass)
  useEffect(() => {
    if (!api || !metalAvailable) return;
    let cancelled = false;
    let rafId = 0;
    let lastFrameTs = performance.now();
    let frameCounter = 0;
    let fpsTick = performance.now();

    const pump = async () => {
      if (cancelled) return;
      if (!renderingRef.current) {
        const shouldDraw = dirtyRef.current || (await api.viewportNeedsDraw());
        if (shouldDraw && !cancelled) {
          renderingRef.current = true;
          dirtyRef.current = false;
          try {
            const frame = await api.viewportRenderFrame();
            if (!cancelled && frame.width > 0 && frame.height > 0 && canvasRef.current) {
              const canvas = canvasRef.current;
              if (canvas.width !== frame.width || canvas.height !== frame.height) {
                canvas.width = frame.width;
                canvas.height = frame.height;
              }
              const ctx = canvas.getContext('2d');
              if (ctx) {
                const pixels = new Uint8ClampedArray(frame.rgba.byteLength);
                pixels.set(frame.rgba);
                const imgData = new ImageData(pixels, frame.width, frame.height);
                ctx.putImageData(imgData, 0, 0);
              }
              frameCounter++;
              const now = performance.now();
              if (now - fpsTick >= 500) {
                setFps(Math.round((frameCounter * 1000) / (now - fpsTick)));
                frameCounter = 0;
                fpsTick = now;
              }
              lastFrameTs = now;
            }
            if (frame.needsMore) dirtyRef.current = true;
          } finally {
            renderingRef.current = false;
          }
        }
      }
      if (!cancelled) {
        // Keep polling playback state lightly while active
        if (performance.now() - lastFrameTs < 2000) {
          api.viewportPlaybackState().then((st) => {
            if (!cancelled) {
              setPlayback(st);
              if (st.playing || st.planState === 'planning') dirtyRef.current = true;
            }
          });
        }
        rafId = window.requestAnimationFrame(() => void pump());
      }
    };

    rafId = window.requestAnimationFrame(() => void pump());
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(rafId);
    };
  }, [api, metalAvailable]);

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!api || !metalAvailable) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const pan = e.button === 1 || e.shiftKey || e.metaKey;
    dragRef.current = {
      mode: pan ? 'pan' : 'orbit',
      lastX: e.clientX,
      lastY: e.clientY,
      startX: e.clientX,
      startY: e.clientY,
      moved: false,
    };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!api || !metalAvailable || !dragRef.current) return;
    const dx = e.clientX - dragRef.current.lastX;
    const dy = e.clientY - dragRef.current.lastY;
    if (Math.hypot(e.clientX - dragRef.current.startX, e.clientY - dragRef.current.startY) > 3) {
      dragRef.current.moved = true;
    }
    dragRef.current.lastX = e.clientX;
    dragRef.current.lastY = e.clientY;
    if (dragRef.current.mode === 'pan') {
      void api.viewportPan(dx, dy).then(markDirty);
    } else {
      void api.viewportOrbit(dx, dy).then(markDirty);
    }
  };

  const onPointerUp = async (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!api || !metalAvailable || !dragRef.current) return;
    const wasClick = !dragRef.current.moved;
    dragRef.current = null;
    if (wasClick && canvasRef.current) {
      const rect = canvasRef.current.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const piece = await api.viewportPick(x, y);
      setPickedPiece(piece);
      if (piece !== null) {
        await api.sessionSelect([piece], e.shiftKey ? 'toggle' : 'replace');
      } else if (!e.shiftKey) {
        await api.sessionSelectNone();
      }
      markDirty();
    }
  };

  const onWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    if (!api || !metalAvailable || !canvasRef.current) return;
    e.preventDefault();
    const rect = canvasRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const factor = Math.exp(-e.deltaY * 0.0022);
    void api.viewportZoomToward(factor, x, y).then(markDirty);
  };

  if (!api || !metalAvailable) {
    return (
      <div className="bm-metal-unavailable">
        <h3>Native Metal Viewport Unavailable</h3>
        <p>
          The native Metal GPU device is not available in this session. You can use the full WebGL viewport instead.
        </p>
        <button className="bm-metal-btn primary" onClick={onFallbackWebGL}>
          Switch to WebGL Viewport
        </button>
      </div>
    );
  }

  return (
    <div ref={hostRef} className="bm-metal-host">
      <canvas
        ref={canvasRef}
        className="bm-metal-canvas"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onWheel={onWheel}
        onContextMenu={(e) => e.preventDefault()}
      />

      {/* Top-left Metal HUD */}
      <div className="bm-metal-hud-top">
        <span className="bm-metal-pill">Metal GPU{fps > 0 ? ` · ${fps} fps` : ''}</span>
        {pickedPiece !== null && <span className="bm-metal-pill accent">Piece #{pickedPiece}</span>}
        <div className="bm-metal-group">
          {(['shaded', 'clay', 'wireframe'] as NativeViewStyle[]).map((st) => (
            <button
              key={st}
              className={`bm-metal-btn ${viewStyle === st ? 'active' : ''}`}
              onClick={() => {
                setViewStyle(st);
                void api.viewportSetViewStyle(st).then(markDirty);
              }}
            >
              {st[0].toUpperCase() + st.slice(1)}
            </button>
          ))}
        </div>
        <div className="bm-metal-group">
          <button
            className={`bm-metal-btn ${ortho ? 'active' : ''}`}
            onClick={() => {
              const next = !ortho;
              setOrtho(next);
              void api.viewportSetOrthographic(next).then(markDirty);
            }}
          >
            {ortho ? 'Ortho' : 'Persp'}
          </button>
          <button className={`bm-metal-btn ${edges ? 'active' : ''}`} onClick={() => setEdges((v) => !v)}>
            Edges
          </button>
          <button className={`bm-metal-btn ${shadows ? 'active' : ''}`} onClick={() => setShadows((v) => !v)}>
            Shadows
          </button>
          <button className={`bm-metal-btn ${ao ? 'active' : ''}`} onClick={() => setAo((v) => !v)}>
            AO
          </button>
          <button className={`bm-metal-btn ${floor ? 'active' : ''}`} onClick={() => setFloor((v) => !v)}>
            Floor
          </button>
        </div>
      </div>

      {/* Top-right View Presets */}
      <div className="bm-metal-hud-right">
        {VIEW_PRESETS.map((p) => (
          <button
            key={p.id}
            className="bm-metal-btn"
            onClick={() => void api.viewportViewPreset(p.id).then(markDirty)}
          >
            {p.label}
          </button>
        ))}
        <button className="bm-metal-btn" onClick={() => void api.viewportFitAll().then(markDirty)}>
          Fit
        </button>
      </div>

      {/* Bottom Native Playback Scrubber */}
      <div className="bm-metal-hud-bottom">
        <button
          className="bm-metal-btn primary"
          onClick={() => void api.viewportPlay(!(playback?.playing ?? false)).then(markDirty)}
        >
          {playback?.playing ? 'Pause' : 'Play Build'}
        </button>
        <button className="bm-metal-btn" onClick={() => void api.viewportShowRest().then(markDirty)}>
          Rest
        </button>
        <input
          type="range"
          min={0}
          max={Math.max(0.1, playback?.duration || 1)}
          step={0.02}
          value={playback?.seconds ?? 0}
          disabled={!playback || playback.duration <= 0}
          onChange={(e) => void api.viewportSeek(Number(e.target.value)).then(markDirty)}
          className="bm-metal-scrubber"
        />
        <span className="bm-metal-time">
          {(playback?.seconds ?? 0).toFixed(2)}s / {(playback?.duration ?? 0).toFixed(2)}s
        </span>
        {playback?.planState === 'planning' && (
          <span className="bm-metal-pill accent">Planning ({playback.planStage})…</span>
        )}
      </div>
    </div>
  );
}
