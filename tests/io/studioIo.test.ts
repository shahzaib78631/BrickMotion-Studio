import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { readStudioIo } from '../../src/io/studioIo';

// Real small ZIP archives generated with the standard 'zip' utility; the
// encrypted fixture uses the format-defined Studio password, not user data.
const fixture = async (name: string): Promise<Uint8Array> =>
  new Uint8Array(await readFile(new URL(`./fixtures/${name}.io`, import.meta.url)));

describe('BrickLink Studio .io import', () => {
  for (const kind of ['plain', 'stored', 'encrypted']) {
    it(`opens ${kind} model.ldr`, async () => {
      const ldraw = await readStudioIo(await fixture(kind));
      expect(ldraw).toContain('3001.dat');
      expect(ldraw).toMatch(/^0 Name:/);
    });
  }
  it('refuses an archive encrypted with a different password', async () => {
    await expect(readStudioIo(await fixture('badpass'))).rejects.toThrow(/decrypt|integrity/i);
  });
  it('reports a missing model.ldr clearly', async () => {
    await expect(readStudioIo(await fixture('no-model'))).rejects.toThrow(/model\.ldr/i);
  });
  it('rejects invalid ZIP data and excessive sizes', async () => {
    await expect(readStudioIo(new TextEncoder().encode('not a ZIP'))).rejects.toThrow(/not a supported/i);
    await expect(readStudioIo(new Uint8Array(96 * 1024 * 1024 + 1))).rejects.toThrow(/96 MB/i);
  });
  it('verifies CRC rather than accepting corrupt model geometry', async () => {
    const input = await fixture('stored');
    const needle = new TextEncoder().encode('3001.dat');
    let position = -1;
    for (let i = 0; i <= input.length - needle.length; i++) {
      if (needle.every((b, j) => input[i + j] === b)) { position = i; break; }
    }
    expect(position).toBeGreaterThan(0);
    input[position] ^= 1;
    await expect(readStudioIo(input)).rejects.toThrow(/integrity/i);
  });
});
