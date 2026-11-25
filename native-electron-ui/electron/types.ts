export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface EngineInfo {
  available: boolean;
  version: string;
  ldrawDir: string;
  metalAvailable: boolean;
  addonError?: string;
  cliAvailable: {
    bm: boolean;
    bmshot: boolean;
    bmexport: boolean;
  };
}

export interface NativeOpenResult {
  ok: boolean;
  error: string;
  warnings: string;
  generation: number;
  title: string;
  pieceCount: number;
  imported: boolean;
}

export interface NativePieceInfo {
  piece: number;
  part: string;
  description: string;
  colorName: string;
  color: number;
  step: number;
  submodelPath: string;
  inSharedSubmodel: boolean;
  position: Vec3;
}

export interface NativeSnapshot {
  version: number;
  generation: number;
  title: string;
  pieces: number;
  selection: number[];
  selected: NativePieceInfo[];
  undoName: string;
  redoName: string;
  dirty: boolean;
  hidden: number;
  focus: string;
}

export interface NativeChanged {
  structure: boolean;
  keyframesOnly: boolean;
  moved: number[];
  recolored: number[];
  removed: number[];
  version: number;
  refused: string;
}

export interface NativeOutlineRow {
  id: string;
  def: string;
  name: string;
  group: string;
  depth: number;
  parent: number;
  pieces: number;
  uses: number;
  shared: boolean;
  unused: boolean;
}

export interface NativeStepRow {
  index: number;
  title: string;
  notes: string;
  pauseAfter: number;
  pinOrder: boolean;
  automatic: boolean;
  items: number;
  pieces: number;
  submodels: number;
}

export interface NativeColorInfo {
  code: number;
  name: string;
  rgb: number;
  alpha: number;
  group: number;
}

export interface NativePartMatch {
  name: string;
  description: string;
  category: string;
}

export interface NativeViewportPreferences {
  edges?: boolean;
  floor?: boolean;
  shadows?: boolean;
  ambientOcclusion?: boolean;
  autoPlan?: boolean;
}

export type NativeViewStyle = 'shaded' | 'clay' | 'wireframe';
export type NativeViewPreset = 'front' | 'back' | 'right' | 'left' | 'top' | 'bottom';

export interface NativeFrameResult {
  width: number;
  height: number;
  needsMore: boolean;
  rgba: Uint8Array;
}

export interface NativeCameraState {
  yaw: number;
  pitch: number;
  distance: number;
  target: Vec3;
  orthographic: boolean;
  verticalFOV: number;
  zoomPercent: number;
}

export interface NativePlaybackState {
  seconds: number;
  duration: number;
  playing: boolean;
  waitingToPlay: boolean;
  atRest: boolean;
  stale: boolean;
  planState: 'idle' | 'planning' | 'ready' | 'failed';
  planStage: 'waiting' | 'solving' | 'checking-flights' | 'preparing' | 'standard-preview';
  planError: string;
  version: number;
}

export interface NativeBuildFlightRow {
  piece: number;
  step: number;
  depth: number;
  color: number;
  start: number;
  end: number;
  name: string;
  flag: string;
  blocker: string;
  independent: boolean;
}

export interface NativeBuildTimeline {
  version: number;
  duration: number;
  framesPerSecond: number;
  buildStart: number;
  buildEnd: number;
  planningMilliseconds: number;
  reusedMoves: number;
  standardPreview: boolean;
  flights: NativeBuildFlightRow[];
  notes: string[];
}

export interface NativeAssemblyReport {
  error: string;
  connectedCount: number;
  rigidCount: number;
  touchingCount: number;
  withoutConnectorsCount: number;
  jointCount: number;
  joints: Array<{ a: number; b: number; type: string; mateCount: number }>;
  overlaps: Array<{ a: number; b: number; duplicate: boolean }>;
}

export interface NativeMotionAuditResult {
  testedFrames: number;
  stride: number;
  intervals: number;
  error: string;
  contacts: Array<{
    a: number;
    b: number;
    firstFrame: number;
    lastFrame: number;
    part: string;
    blocker: string;
  }>;
}

export interface NativeFileOpenResponse {
  canceled: boolean;
  filePath?: string;
  fileName?: string;
  content?: string;
  isBinary?: boolean;
  base64?: string;
}

export interface NativeFileSaveResponse {
  canceled: boolean;
  filePath?: string;
}

export interface NativeCliResult {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  outputPath?: string;
}

export type NativeMenuAction =
  | 'file:new'
  | 'file:open'
  | 'file:save'
  | 'file:save-as'
  | 'file:export-mpd'
  | 'file:export-video'
  | 'file:export-native-still'
  | 'file:export-native-sound'
  | 'edit:undo'
  | 'edit:redo'
  | 'view:fit'
  | 'view:toggle-theme'
  | 'view:renderer-metal'
  | 'view:renderer-webgl'
  | 'view:preset-front'
  | 'view:preset-back'
  | 'view:preset-left'
  | 'view:preset-right'
  | 'view:preset-top'
  | 'view:preset-bottom'
  | 'workspace:build'
  | 'workspace:animate'
  | 'engine:inspect'
  | 'engine:plan';

export interface BrickMotionNativeAPI {
  isElectron: true;
  platform: string;

  // Engine status
  engineInfo(): Promise<EngineInfo>;

  // Native Session
  sessionNewBlank(): Promise<NativeOpenResult>;
  sessionOpenFile(filePath: string): Promise<NativeOpenResult>;
  sessionOpenBytes(bytes: string, virtualPath: string): Promise<NativeOpenResult>;
  sessionProjectBytes(): Promise<string>;
  sessionMpdBytes(): Promise<string>;
  sessionSnapshot(): Promise<NativeSnapshot>;
  sessionOutline(): Promise<NativeOutlineRow[]>;
  sessionSteps(): Promise<NativeStepRow[]>;
  sessionColors(): Promise<NativeColorInfo[]>;
  sessionSearchParts(query: string, limit?: number): Promise<NativePartMatch[]>;
  sessionUndo(): Promise<NativeChanged>;
  sessionRedo(): Promise<NativeChanged>;
  sessionSelect(pieces: number[], mode?: 'replace' | 'add' | 'toggle'): Promise<boolean>;
  sessionSelectAll(): Promise<boolean>;
  sessionSelectNone(): Promise<boolean>;
  sessionHide(pieces: number[]): Promise<boolean>;
  sessionShowAll(): Promise<boolean>;
  sessionRecolor(pieces: number[], colorCode: number): Promise<NativeChanged>;
  sessionRemove(pieces: number[]): Promise<NativeChanged>;
  sessionMove(pieces: number[], dx: number, dy: number, dz: number, continuing?: boolean): Promise<NativeChanged>;
  sessionFocus(path: string[]): Promise<NativeChanged>;

  // Native Metal Viewport
  viewportResize(width: number, height: number, scale: number): Promise<boolean>;
  viewportSetBackground(r: number, g: number, b: number): Promise<boolean>;
  viewportSetPreferences(prefs: NativeViewportPreferences): Promise<boolean>;
  viewportSetViewStyle(style: NativeViewStyle): Promise<boolean>;
  viewportSetOrthographic(enabled: boolean): Promise<boolean>;
  viewportRenderFrame(): Promise<NativeFrameResult>;
  viewportNeedsDraw(): Promise<boolean>;
  viewportOrbit(dx: number, dy: number): Promise<boolean>;
  viewportPan(dx: number, dy: number): Promise<boolean>;
  viewportZoom(factor: number): Promise<boolean>;
  viewportZoomToward(factor: number, x: number, y: number): Promise<boolean>;
  viewportFitAll(): Promise<boolean>;
  viewportFrameSelection(): Promise<boolean>;
  viewportCenterOnFloor(): Promise<boolean>;
  viewportViewPreset(preset: NativeViewPreset): Promise<boolean>;
  viewportCamera(): Promise<NativeCameraState>;
  viewportPick(x: number, y: number): Promise<number | null>;
  viewportMarquee(x0: number, y0: number, x1: number, y1: number, touching?: boolean): Promise<number[]>;

  // Native Planner & Playback
  viewportRequestPlan(): Promise<boolean>;
  viewportRegeneratePlan(standardPreview?: boolean): Promise<boolean>;
  viewportPlay(on: boolean): Promise<boolean>;
  viewportSeek(seconds: number): Promise<boolean>;
  viewportShowRest(): Promise<boolean>;
  viewportSetPlaybackRate(rate: number): Promise<boolean>;
  viewportSetPlaybackLoop(loop: boolean): Promise<boolean>;
  viewportSetDirectorPreview(directed: boolean): Promise<boolean>;
  viewportPlaybackState(): Promise<NativePlaybackState>;
  viewportBuildTimeline(): Promise<NativeBuildTimeline>;

  // Native Inspection & Audit
  inspectAssembly(selection?: number[], showAllJoints?: boolean, checkGeometry?: boolean): Promise<NativeAssemblyReport>;
  auditMotion(piece?: number): Promise<NativeMotionAuditResult>;

  // Native CLI tools (bmshot, bmexport, bm)
  renderNativeStill(options: {
    width?: number;
    height?: number;
    samples?: number;
    pathTrace?: boolean;
  }): Promise<NativeCliResult>;
  exportNativeSound(options: {
    style?: 'physics' | 'web';
    webPreset?: 'balanced' | 'product' | 'click' | 'soft' | 'synth';
  }): Promise<NativeCliResult>;
  exportNativeVideo(options: {
    width?: number;
    height?: number;
    fps?: number;
  }): Promise<NativeCliResult>;

  // Native Filesystem & Dialogs
  openFileDialog(): Promise<NativeFileOpenResponse>;
  saveFileDialog(options: {
    defaultPath?: string;
    filters?: Array<{ name: string; extensions: string[] }>;
    content: string;
    encoding?: 'utf8' | 'base64';
  }): Promise<NativeFileSaveResponse>;
  revealInFinder(filePath: string): Promise<void>;

  // Menu events from macOS menu bar
  onMenuAction(handler: (action: NativeMenuAction) => void): () => void;
}

declare global {
  interface Window {
    brickMotionNative?: BrickMotionNativeAPI;
  }
}
