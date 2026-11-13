const fs = require('fs');
const path = require('path');

function gallery(output, report) {
  const escape = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const base = path.basename(output, '.png');
  const camera = report.shared;
  const cards = report.steps.map((s) => `<article><h2>Step ${s.step}${s.turned ? ' · model turned over' : ''}</h2>${s.assembly ? `<p>${s.presentation === 'assembled' ? 'Assembled poses held fixed · ' : ''}Assembly: ${s.assembly.collisions.length} reported collision pairs · ${s.assembly.missingGeometry.length} missing meshes · new-part connector mates: ${s.assembly.newPartContacts.map((p) => p.mates.length).join(', ')}</p>` : ''}<p>Silhouette overlap ${(s.iou * 100).toFixed(1)}% · render → reference p90 ${s.renderToPic.p90?.toFixed(2) ?? 'n/a'} px · reference → render p90 ${s.picToRender.p90?.toFixed(2) ?? 'n/a'} px</p><a href="${encodeURIComponent(base)}-step-${s.step}.png"><img src="${encodeURIComponent(base)}-step-${s.step}.png" alt="Reference, Three.js render, edge overlay and silhouette difference for step ${s.step}" loading="lazy"></a></article>`).join('\n');
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Booklet ${escape(report.set)} · Three.js camera results</title><style>*{box-sizing:border-box}body{margin:0;background:#171a20;color:#e6e9ef;font:15px/1.6 system-ui,sans-serif}main{max-width:1450px;margin:auto;padding:32px}h1{font-size:30px;margin:0}p{color:#b3c0d2}a{color:#93cdff}article{margin-top:32px;border-top:1px solid #3b4554;padding-top:20px}article img{display:block;max-width:100%;height:auto;border:1px solid #3b4554}h2{margin:0;font-size:20px}.camera{background:#222e3e;padding:18px;border-radius:8px}</style><main><h1>Booklet ${escape(report.set)} · camera comparison</h1><p>Saved native-resolution renders from Three.js. The same camera is held across these steps; crop placement, model turnover and exploded-part offsets vary.</p><div class="camera">Yaw ${camera.yaw.toFixed(2)}° · pitch ${camera.pitch.toFixed(2)}° · roll ${camera.roll.toFixed(2)}° · ${camera.scale.toFixed(4)} px/LDU<br><a href="${encodeURIComponent(base)}.json">Download measured camera and offsets</a> · <a href="/booklet-camera.html?set=${encodeURIComponent(report.set)}&zoom=0.6">Run live fitter</a></div><p>Residual errors are shown below. These results do not establish pixel-perfect recovery. ${escape(report.limitations)}</p>${cards}</main></html>`;
  fs.writeFileSync(path.join(path.dirname(output), 'index.html'), html);
}
module.exports = gallery;
if (require.main === module) {
  const output = process.argv[2];
  if (!output) throw new Error('Usage: node scripts/booklet-camera-gallery.cjs output/booklet-camera/21065.png');
  gallery(output, JSON.parse(fs.readFileSync(output.replace(/\.png$/, '.json'), 'utf8')));
}
