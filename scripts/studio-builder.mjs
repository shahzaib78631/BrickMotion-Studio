import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const venv = join(root, 'python', '.venv', 'bin', 'python');
const python = process.env.INSTRUCTIONS_PYTHON ?? (existsSync(venv) ? venv : 'python3');
const args = process.argv.slice(2);
const child = spawn(python, ['-u', '-m', 'studio_builder', ...(args.length ? args : ['serve'])], {
  cwd: process.cwd(), stdio: 'inherit',
  env: { ...process.env, PYTHONPATH: [join(root, 'python'), process.env.PYTHONPATH].filter(Boolean).join(':') },
});
child.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
child.on('exit', (code) => { process.exitCode = code ?? 1; });
process.on('SIGINT', () => child.kill('SIGINT'));
process.on('SIGTERM', () => child.kill('SIGTERM'));
