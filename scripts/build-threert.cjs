#!/usr/bin/env node
// Build the genuine upstream browser engine. No renderer/shader substitutions.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const source = path.join(root, '.cache/ThreeRT');
const revision = '10fdc7738835d5b4c19438141fe28009a1d66d6b';
const run = (command, args, cwd = source) => execFileSync(command, args, { cwd, stdio: 'inherit', env: { ...process.env, CARGO_BUILD_JOBS: process.env.CARGO_BUILD_JOBS || '2' } });
fs.mkdirSync(path.dirname(source), { recursive: true });
if (!fs.existsSync(source)) {
  run('git', ['clone', '--no-checkout', 'https://github.com/meshy-dev/ThreeRT.git', source], root);
  run('git', ['checkout', '--detach', revision]);
}
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim();
if (head !== revision) throw new Error(`ThreeRT checkout must be ${revision}; found ${head}. Use a separate checkout or check out the pinned revision.`);
// Host lifecycle only. Upstream exposes a single global engine but no teardown.
// Retain its exact rendering algorithms and provide explicit resource ownership.
const host = fs.readFileSync(path.join(root, 'src/render/threert/host.rs'), 'utf8');
const entry = path.join(source, 'renderer/web/src/lib.rs');
const original = execFileSync('git', ['show', 'HEAD:renderer/web/src/lib.rs'], { cwd: source, encoding: 'utf8' });
const current = fs.readFileSync(entry, 'utf8');
const marker = '// BrickMotion host additions; upstream rendering and shaders are unchanged.';
if (current !== original && current !== original + '\n' + host && !current.startsWith(original + '\n' + marker)) throw new Error('ThreeRT web entry has unrecognized local changes; refusing to overwrite it.');
fs.writeFileSync(entry, original + '\n' + host);
run('cargo', ['+1.100.0', 'build', '--release', '--locked', '--target', 'wasm32-unknown-unknown', '--manifest-path', 'renderer/web/Cargo.toml']);
const cachedBindgen = path.join(root, '.cache/threert-tools/wasm-bindgen-0.2.130-aarch64-apple-darwin/wasm-bindgen');
const bindgen = process.env.WASM_BINDGEN || (fs.existsSync(cachedBindgen) ? cachedBindgen : 'wasm-bindgen');
if (execFileSync(bindgen, ['--version'], { encoding: 'utf8' }).trim() !== 'wasm-bindgen 0.2.130') throw new Error('Install wasm-bindgen-cli 0.2.130 and set WASM_BINDGEN to its executable.');
const out = path.join(root, 'public/threert');
fs.mkdirSync(out, { recursive: true });
run(bindgen, ['--target', 'web', '--no-typescript', '--out-dir', out, 'renderer/web/target/wasm32-unknown-unknown/release/threert_web.wasm']);
fs.copyFileSync(path.join(source, 'LICENSE'), path.join(out, 'LICENSE'));
const crypto = require('node:crypto');
const hashes = {};
for (const name of ['threert_web.js', 'threert_web_bg.wasm']) hashes[name] = crypto.createHash('sha256').update(fs.readFileSync(path.join(out, name))).digest('hex');
fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify({ repository: 'https://github.com/meshy-dev/ThreeRT', revision, rust: '1.100.0', wasmBindgen: '0.2.130', patch: 'src/render/threert/host.rs (lifecycle and submission backpressure only)', hostSha256: crypto.createHash('sha256').update(host).digest('hex'), sha256: hashes }, null, 2) + '\n');
