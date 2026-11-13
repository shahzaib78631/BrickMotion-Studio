// Post-eval for scripts/verify-pathtrace.cjs: clip the screenshot to the render canvas.
// A WebGPU canvas read back with drawImage outside an animation frame returns empty, so the
// CDP clip is the reliable way to capture the render alone.
(async () => {
  const el = document.getElementById('gpu');
  const r = el.getBoundingClientRect();
  return { clip: { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height), scale: 1 } };
})()
