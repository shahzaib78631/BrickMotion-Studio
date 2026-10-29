import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const PY_DIR = join(ROOT, 'python');

/** Runs the repo's Python (python/.venv, or INSTRUCTIONS_PYTHON / CORRECTOR_PYTHON) inside python/. */
export function runPython(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const venv = join(PY_DIR, '.venv', 'bin', 'python');
  const python = process.env.INSTRUCTIONS_PYTHON ?? process.env.CORRECTOR_PYTHON ?? (existsSync(venv) ? venv : 'python3');
  return new Promise((done) => {
    const child = spawn(python, args, { cwd: PY_DIR, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', (e) => done({ code: -1, stdout, stderr: stderr + String(e) }));
    child.on('close', (code) => done({ code: code ?? -1, stdout, stderr }));
  });
}
