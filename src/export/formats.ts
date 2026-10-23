/** Output frame shapes. The camera re-frames the build for each aspect ratio. */
export const VIDEO_FORMATS = {
  '9:16': { width: 1080, height: 1920, label: 'Vertical 9:16 · 1080×1920 (Reels, Shorts, TikTok)' },
  '4:5': { width: 1080, height: 1350, label: 'Portrait 4:5 · 1080×1350 (Instagram feed)' },
  '1:1': { width: 1080, height: 1080, label: 'Square 1:1 · 1080×1080' },
  '16:9': { width: 1920, height: 1080, label: 'Landscape 16:9 · 1920×1080 (YouTube)' },
} as const;
export type VideoFormat = keyof typeof VIDEO_FORMATS;
export const isVideoFormat = (v: unknown): v is VideoFormat => typeof v === 'string' && v in VIDEO_FORMATS;
export const formatAspect = (f: VideoFormat) => VIDEO_FORMATS[f].width / VIDEO_FORMATS[f].height;
