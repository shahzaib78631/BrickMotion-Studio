// Post-eval for scripts/verify-pathtrace.cjs: click "Measure reference difference" and return
// the RMSE it reports. The measurement reads the WebGPU canvas in-frame, which is why it must
// run through the page's own handler rather than a bare drawImage.
(async () => {
  document.getElementById('measure-reference').click();
  await new Promise((r) => setTimeout(r, 1200));
  return document.getElementById('comparison')?.textContent;
})()
