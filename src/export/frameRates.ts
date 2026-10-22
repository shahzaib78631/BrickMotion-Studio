/** Common cinematic, broadcast and high-frame-rate MP4 output presets. */
export const FPS_OPTIONS = [24, 25, 30, 48, 50, 60, 90, 120] as const;
export type ExportFps = (typeof FPS_OPTIONS)[number];
export const isExportFps = (value: number): value is ExportFps => FPS_OPTIONS.some((fps) => fps === value);
