/** Exercise exported independent profiles against the native mating solver.
 * These are regression fixtures, not physical fit or library coverage certification. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createReadStream, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import type { Snap } from '../src/ldraw/shadow';

const directory = resolve(process.argv[2] ?? '.cache/measurements');
type Row = { id: string; connectors: Snap[]; frames: { definitions: { frame: { m: number[] } }[]; issues: string[] } };
const wanted = new Set(['2780', '3700', '3937', '3938']);
const rows = new Map<string, Row>(), hashes: Record<string, string> = {};
for await (const line of createInterface({ input: createReadStream(resolve(directory, 'reference-library.jsonl')), crlfDelay: Infinity })) {
  const row = JSON.parse(line) as Row;
  if (!wanted.has(row.id)) continue;
  if (rows.has(row.id) || row.frames.issues.length) throw new Error(`Invalid fixture source: ${row.id}`);
  rows.set(row.id, row);
  hashes[row.id] = createHash('sha256').update(line).digest('hex');
}
const num = (n: number) => { if (!Number.isFinite(n)) throw new Error('Non-finite fixture value'); return String(n); };
const vec = (v: number[]) => { if (v.length !== 3) throw new Error('Invalid vector'); return `{${v.map(num).join(',')}}`; };
function connector(id: string, select: (c: Snap) => boolean): string {
  const row = rows.get(id);
  if (!row) throw new Error(`Missing fixture part: ${id}`);
  const matches = row.connectors.map((c, i) => ({ c, i })).filter(({ c }) => select(c));
  if (matches.length !== 1) throw new Error(`Ambiguous fixture connector: ${id}`);
  const { c, i } = matches[0], m = row.frames.definitions[i].frame.m;
  if (!['cyl', 'fgr'].includes(c.kind)) throw new Error('Unsupported fixture kind');
  const caps = (c.caps ?? 'one').toLowerCase();
  if (!['none', 'one', 'two', 'a', 'b'].includes(caps)) throw new Error(`Unsupported caps: ${caps}`);
  const openStart = caps === 'none' || caps === 'b' || (caps === 'one' && c.gender === 'F');
  const openEnd = caps === 'none' || caps === 'a' || (caps === 'one' && c.gender === 'M');
  const profile = (c.sections ?? []).map(s => {
    if (!/^[RASLT_]+$/.test(s.shape)) throw new Error(`Unsupported section: ${s.shape}`);
    const shape = s.shape.replaceAll('_', '');
    if (shape.length !== 1) throw new Error(`Unsupported section: ${s.shape}`);
    return `{'${shape}',${num(s.radius)},${num(s.start)},${num(s.length)}}`;
  }).join(',');
  return `[]{ Connector c;
    c.kind=SnapKind::${c.kind === 'cyl' ? 'Cyl' : 'Finger'};
    c.gender=Gender::${c.gender === 'M' ? 'Male' : 'Female'};
    c.start=${vec(c.start)}; c.axis=${vec(c.axis)};
    c.side=normalized(Vec3${vec([m[0], m[3], m[6]])});
    c.length=${num(c.length)}; c.radius=${num(c.radius)};
    c.slide=${!!c.slide}; c.openStart=${openStart}; c.openEnd=${openEnd};
    c.profile={${profile}}; c.seq={${(c.seq ?? []).map(num).join(',')}};
    c.group=${JSON.stringify(c.group ?? '')}; return c; }()`;
}
const generated = `#include <iostream>
#include "bm/connect/mate.h"
using namespace bm; using namespace bm::connect;
// A rigid rotation mapping the pin's X axis onto the brick hole's Z axis.
Vec3 rotate(Vec3 p) { return {-p.z,p.y,p.x}; }
Connector pinAt(Connector c, double z) {
  c.start=rotate(c.start)+Vec3{0,10,z}; c.axis=rotate(c.axis); c.side=rotate(c.side); return c;
}
int main() {
  const Connector pin=${connector('2780', c => c.kind === 'cyl' && c.gender === 'M')};
  const Connector hole=${connector('3700', c => c.id === 'connhole')};
  const Connector base=${connector('3937', c => c.kind === 'fgr')};
  const Connector top=${connector('3938', c => c.kind === 'fgr')};
  int failures=0;
  auto check=[&](const char* name, const Connector& a, const Connector& b, bool expected, bool slides) {
    const auto result=mate(a,b), reverse=mate(b,a);
    bool pass=result.has_value()==expected && reverse.has_value()==expected;
    if (expected && result && reverse) pass=pass && result->freedom.rotates && !result->freedom.ball &&
      result->freedom.slides==slides && reverse->freedom.rotates && reverse->freedom.slides==slides;
    std::cout << name << " " << (pass?"PASS":"FAIL") << "\\n";
    if (!pass) { ++failures; std::cerr << whyNot(a,b) << "\\n"; }
  };
  check("pin-near-mouth",pinAt(pin,-10),hole,true,true);
  check("pin-far-mouth",pinAt(pin,10),hole,true,true);
  check("pin-collar-in-bore",pinAt(pin,0),hole,false,false);
  auto offset=pinAt(pin,-10); offset.start.x+=5;
  check("pin-off-axis",offset,hole,false,false);
  check("hinge-complementary-fingers",base,top,true,false);
  check("hinge-two-bases",base,base,false,false);
  auto far=top; far.start.x+=50;
  check("hinge-disjoint",base,far,false,false);
  auto wrong=top; wrong.axis={0,1,0}; wrong.side={1,0,0};
  check("hinge-crossed-axes",base,wrong,false,false);
  return failures?1:0;
}
`;
const build = resolve(directory, 'mate-fixtures');
mkdirSync(build, { recursive: true });
const source = resolve(build, 'independent-mates.cpp'), executable = resolve(build, 'independent-mates');
writeFileSync(source, generated);
execFileSync('c++', ['-std=c++17', '-O2', '-I', resolve('native/core/include'), source,
  resolve('native/core/src/connect/mate.cpp'), '-o', executable], { stdio: 'inherit' });
let output = '', passed = false;
try { output = execFileSync(executable, [], { encoding: 'utf8' }); passed = true; }
catch (error) { output = String((error as { stdout?: unknown }).stdout ?? error); }
const manifest = JSON.parse(readFileSync(resolve(directory, 'reference-library.jsonl.manifest.json'), 'utf8'));
writeFileSync(resolve(directory, 'mating-regressions.json'), JSON.stringify({
  status: passed ? 'passed' : 'failed', fullCoverage: false, fixtures: 8, output,
  reference: manifest.reference, interpretation: manifest.interpretation, sourceRows: hashes,
  generatedSourceHash: createHash('sha256').update(generated).digest('hex'),
  solverSources: Object.fromEntries(['native/core/src/connect/mate.cpp', 'native/core/include/bm/connect/mate.h',
    'native/core/include/bm/connect/connectors.h', 'native/core/include/bm/connect/tolerances.h', 'native/core/include/bm/math.h']
    .map(path => [path, createHash('sha256').update(readFileSync(resolve(path))).digest('hex')])),
  limitations: ['Native solver regressions only', 'No mesh collision or insertion sweep check',
    'No physical fit validation', 'Other parts and connector families remain unvalidated'],
}, null, 2) + '\n');
console.log(output);
if (!passed) process.exitCode = 1;
