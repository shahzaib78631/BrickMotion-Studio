/* Type checking and transpiling for the offline verify scripts.
 *
 * TypeScript 7 is a native compiler and no longer exposes the JavaScript
 * compiler API (`createProgram`, `transpileModule`), so type checking shells
 * out to the project's own tsc and transpiling uses the esbuild that Vite
 * already brings. The checks themselves are unchanged. */
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const localTsc = path.join(root, 'node_modules', '.bin', 'tsc');

/** Type-check project-relative files. Returns the diagnostics text, or '' when clean. */
function typecheck(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brickmotion-typecheck-'));
  try {
    const project = path.join(dir, 'tsconfig.json');
    fs.writeFileSync(project, JSON.stringify({
      compilerOptions: {
        target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler',
        strict: true, noEmit: true, skipLibCheck: true, types: [],
      },
      files: files.map((f) => path.join(root, f)),
    }));
    const run = fs.existsSync(localTsc)
      ? cp.spawnSync(localTsc, ['-p', project], { encoding: 'utf8' })
      : cp.spawnSync('npx', ['tsc', '-p', project], { encoding: 'utf8' });
    const text = `${run.stdout ?? ''}${run.stderr ?? ''}`.trim();
    return run.status === 0 ? '' : text || 'type check failed';
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Transpile one TypeScript source (project-relative or absolute) to CommonJS. Throws on a syntax error. */
function transpile(file) {
  const esbuild = require('esbuild');
  const full = path.isAbsolute(file) ? file : path.join(root, file);
  const name = path.relative(root, full) || full;
  try {
    return esbuild.transformSync(fs.readFileSync(full, 'utf8'), {
      loader: full.endsWith('.tsx') ? 'tsx' : 'ts', format: 'cjs', target: 'es2022', sourcefile: name,
    }).code;
  } catch (err) {
    throw new Error(`${name}: ${err.message}`);
  }
}

module.exports = { root, transpile, typecheck };
