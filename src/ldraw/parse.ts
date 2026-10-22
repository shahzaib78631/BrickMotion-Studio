/** Row-major 3x3 rotation/scale matrix (LDraw a..i). */
export type Mat3 = [number, number, number, number, number, number, number, number, number];
export type Vec3 = [number, number, number];

export type LDrawCmd =
  | { t: 'ref'; color: number; pos: Vec3; m: Mat3; file: string; invert: boolean }
  | { t: 'tri' | 'quad'; color: number; pts: number[] }
  | { t: 'step' }
  | { t: 'bfc'; cert?: 'CCW' | 'CW' | 'NOCERTIFY'; winding?: 'CCW' | 'CW'; clip?: boolean };

export type LDrawFile = { name: string; description: string; category?: string; cmds: LDrawCmd[] };

export function normalizeName(file: string): string {
  return file.trim().replace(/\\/g, '/').toLowerCase();
}

function parseBfc(rest: string[]): LDrawCmd | null {
  const words = rest.map((w) => w.toUpperCase());
  const cmd: { t: 'bfc'; cert?: 'CCW' | 'CW' | 'NOCERTIFY'; winding?: 'CCW' | 'CW'; clip?: boolean } = { t: 'bfc' };
  if (words[0] === 'NOCERTIFY') return { t: 'bfc', cert: 'NOCERTIFY' };
  if (words[0] === 'CERTIFY') {
    cmd.cert = words[1] === 'CW' ? 'CW' : 'CCW';
    return cmd;
  }
  for (const w of words) {
    if (w === 'CW' || w === 'CCW') cmd.winding = w;
    else if (w === 'CLIP') cmd.clip = true;
    else if (w === 'NOCLIP') cmd.clip = false;
  }
  return cmd.winding || cmd.clip !== undefined ? cmd : null;
}

export function parseLDraw(text: string, name = 'main.ldr'): LDrawFile {
  const file: LDrawFile = { name: normalizeName(name), description: '', cmds: [] };
  let invertNext = false;
  let sawFirstLine = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const tok = line.split(/\s+/);
    const type = tok[0];
    if (type === '0') {
      const rest = tok.slice(1);
      if (!sawFirstLine) {
        sawFirstLine = true;
        if (rest.length && !rest[0].startsWith('!') && !['BFC', 'STEP', 'FILE', 'Name:'].includes(rest[0])) {
          file.description = rest.join(' ');
          continue;
        }
      }
      const key = rest[0]?.toUpperCase();
      if (key === 'STEP') file.cmds.push({ t: 'step' });
      else if (key === '!CATEGORY') file.category = rest.slice(1).join(' ');
      else if (key === 'BFC') {
        if (rest[1]?.toUpperCase() === 'INVERTNEXT') invertNext = true;
        else {
          const b = parseBfc(rest.slice(1));
          if (b) file.cmds.push(b);
        }
      }
      continue;
    }
    sawFirstLine = true;
    const n = tok.map(Number);
    if (type === '1' && tok.length >= 15) {
      file.cmds.push({
        t: 'ref',
        color: n[1],
        pos: [n[2], n[3], n[4]],
        m: [n[5], n[6], n[7], n[8], n[9], n[10], n[11], n[12], n[13]],
        file: normalizeName(tok.slice(14).join(' ')),
        invert: invertNext,
      });
      invertNext = false;
    } else if (type === '3' && tok.length >= 11) {
      file.cmds.push({ t: 'tri', color: n[1], pts: n.slice(2, 11) });
    } else if (type === '4' && tok.length >= 14) {
      file.cmds.push({ t: 'quad', color: n[1], pts: n.slice(2, 14) });
    }
  }
  return file;
}

/** Splits a multi-part document (MPD) into its files. Keys are lower-cased. */
export function parseMpd(text: string): { main: string; files: Map<string, LDrawFile>; raw: Map<string, string> } {
  const files = new Map<string, LDrawFile>();
  const raw = new Map<string, string>();
  const lines = text.split(/\r?\n/);
  let current: { name: string; lines: string[] } | null = null;
  const blocks: { name: string; lines: string[] }[] = [];
  for (const line of lines) {
    const m = /^\s*0\s+FILE\s+(.+?)\s*$/i.exec(line);
    if (m) {
      current = { name: normalizeName(m[1]), lines: [] };
      blocks.push(current);
      continue;
    }
    if (/^\s*0\s+NOFILE\b/i.test(line)) {
      current = null;
      continue;
    }
    if (/^\s*0\s+!DATA\b/i.test(line)) {
      current = null; // embedded binary data (textures) is not supported
      continue;
    }
    current?.lines.push(line);
  }
  if (blocks.length === 0) {
    files.set('main.ldr', parseLDraw(text, 'main.ldr'));
    raw.set('main.ldr', text);
    return { main: 'main.ldr', files, raw };
  }
  for (const b of blocks)
    if (!files.has(b.name)) {
      const t = b.lines.join('\n');
      files.set(b.name, parseLDraw(t, b.name));
      raw.set(b.name, t);
    }
  return { main: blocks[0].name, files, raw };
}
