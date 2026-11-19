/** Refresh the geometry work queue from the current full reference export. */
import { createReadStream, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';

const directory = resolve(process.argv[2] ?? '.cache/measurements');
const inventory = JSON.parse(readFileSync(resolve(directory, 'coverage.json'), 'utf8'));
const expected = new Set<string>(inventory.parts.map((p: { id: string }) => p.id));
const seen = new Set<string>(), ids: string[] = [];
for await (const line of createInterface({ input: createReadStream(resolve(directory, 'reference-library.jsonl')), crlfDelay: Infinity })) {
  const row = JSON.parse(line);
  if (!expected.has(row.id) || seen.has(row.id)) throw new Error(`Unexpected or duplicate reference row: ${row.id}`);
  seen.add(row.id);
  if (!row.connectors.length) ids.push(row.id);
}
if (seen.size !== expected.size) throw new Error('Reference export does not cover the frozen inventory');
writeFileSync(resolve(directory, 'unreferenced-ids.json'), JSON.stringify(ids.sort(), null, 2) + '\n');
console.log(JSON.stringify({ unreferencedParts: ids.length }));
