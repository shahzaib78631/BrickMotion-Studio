import { closeSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { measureIndependentPart } from './lib/independent-measurements';

const root = resolve(process.argv[2] ?? 'public/ldraw');
const directory = resolve(process.argv[3] ?? '.cache/measurements');
const inventory = JSON.parse(readFileSync(resolve(directory, 'coverage.json'), 'utf8'));
mkdirSync(directory, { recursive: true });
const output = resolve(directory, 'geometry-index.jsonl');
const fd = openSync(output + '.tmp', 'w');
let indexed = 0, unresolved = 0;
try {
  for (const [i, item] of inventory.parts.entries()) {
    try {
      const row = measureIndependentPart(root, item.id, undefined, false);
      for (const [name, hash] of Object.entries(row.sources)) {
        if (inventory.sources[name] !== hash) throw new Error(`Geometry differs from frozen inventory: ${name}`);
      }
      const signature = row.measurements?.geometrySignature;
      if (signature) indexed++; else unresolved++;
      writeSync(fd, JSON.stringify({ id: row.id, signature, status: row.status, issues: row.issues,
        inventoryHash: inventory.inventoryHash,
        sourceDigest: createHash('sha256').update(JSON.stringify(row.sources)).digest('hex') }) + '\n');
    } catch (error) {
      unresolved++;
      writeSync(fd, JSON.stringify({ id: item.id, status: 'error', issues: [String(error)], inventoryHash: inventory.inventoryHash }) + '\n');
    }
    if ((i + 1) % 1000 === 0) console.log(`Indexed ${i + 1}/${inventory.parts.length}`);
  }
} finally { closeSync(fd); }
renameSync(output + '.tmp', output);
console.log(JSON.stringify({ indexed, unresolved, output }));
if (unresolved) process.exitCode = 2;
