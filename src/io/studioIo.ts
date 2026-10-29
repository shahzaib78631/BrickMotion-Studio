/**
 * Import a BrickLink Studio .io model without uploading it or introducing a
 * runtime ZIP dependency. Studio's format is a ZIP holding model.ldr; some
 * Studio exports use legacy PKZIP encryption with the public format password
 * "soho0909". Only that format (and regular ZIP) is supported here.
 *
 * The central directory is authoritative for offsets, sizes and CRCs; ZIP64,
 * split archives and AES are deliberately rejected. Output is bounded even
 * when the input advertises an implausibly small decompressed size.
 */
const MAX_ARCHIVE_BYTES = 96 * 1024 * 1024;
const MAX_MODEL_BYTES = 32 * 1024 * 1024;
const MAX_ENTRIES = 12000;
const FORMAT_PASSWORD = 'soho0909';
const decoder = new TextDecoder('utf-8', { fatal: false });

const checksumTable = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let crc = i;
  for (let b = 0; b < 8; b++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  checksumTable[i] = crc >>> 0;
}
function updateCrc(crc: number, byte: number): number {
  return ((crc >>> 8) ^ checksumTable[(crc ^ byte) & 255]) >>> 0;
}
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const b of bytes) crc = updateCrc(crc, b);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Decode traditional ZIP crypto, which still appears in Studio .io models. */
function decryptTraditional(input: Uint8Array, expectedCrc: number, checkTime: number, descriptor: boolean): Uint8Array {
  const keys = [0x12345678, 0x23456789, 0x34567890];
  const advance = (byte: number) => {
    keys[0] = updateCrc(keys[0], byte);
    keys[1] = (Math.imul((keys[1] + (keys[0] & 255)) >>> 0, 134775813) + 1) >>> 0;
    keys[2] = updateCrc(keys[2], keys[1] >>> 24);
  };
  for (const ch of FORMAT_PASSWORD) advance(ch.charCodeAt(0));
  if (input.length < 12) throw new Error('Studio archive contains an invalid encrypted model.');
  const out = new Uint8Array(input.length - 12);
  let check = 0;
  for (let i = 0; i < input.length; i++) {
    const temp = (keys[2] | 2) >>> 0;
    const value = input[i] ^ ((Math.imul(temp, temp ^ 1) >>> 8) & 255);
    advance(value);
    if (i < 12) {
      if (i === 11) check = value;
    } else out[i - 12] = value;
  }
  const expected = descriptor ? ((checkTime >>> 8) & 255) : ((expectedCrc >>> 24) & 255);
  if (check !== expected) throw new Error('Cannot decrypt this Studio model. Only standard .io encryption is supported.');
  return out;
}

async function inflateBounded(bytes: Uint8Array, size: number): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined')
    throw new Error('Your browser cannot extract compressed Studio .io models. Export an LDraw .ldr or .mpd file from Studio instead.');
  let stream: ReadableStream<Uint8Array>;
  try {
    stream = new Blob([new Uint8Array(bytes)]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  } catch {
    throw new Error('This browser does not support ZIP deflate. Export an LDraw .ldr or .mpd file from Studio instead.');
  }
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.length;
      if (total > MAX_MODEL_BYTES || total > size) throw new Error('Studio model expands past its declared size or the 32 MB safety limit.');
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
  return out;
}

type ZipEntry = { name: string; flags: number; method: number; crc: number; size: number; compressed: number; offset: number; time: number };

/** Read Studio model.ldr (also accepts unencrypted conventional .io archives). */
export async function readStudioIo(input: ArrayBuffer | Uint8Array): Promise<string> {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length > MAX_ARCHIVE_BYTES) throw new Error('Studio .io archive exceeds the 96 MB import limit.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (i: number) => view.getUint16(i, true);
  const u32 = (i: number) => view.getUint32(i, true);
  // ZIP's EOCD may carry a 64 KB comment. Scan backwards within that bound.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
    if (u32(i) === 0x06054b50 && i + 22 + u16(i + 20) === bytes.length) { eocd = i; break; }
  }
  if (eocd === -1) throw new Error('This .io file is not a supported BrickLink Studio ZIP archive.');
  if (u16(eocd + 4) || u16(eocd + 6) || u16(eocd + 8) !== u16(eocd + 10))
    throw new Error('Split ZIP archives cannot be imported.');
  const count = u16(eocd + 10);
  const directorySize = u32(eocd + 12);
  const directoryOffset = u32(eocd + 16);
  if (count === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff || count > MAX_ENTRIES)
    throw new Error('ZIP64 or unusually large Studio .io archives are not supported.');
  if (directoryOffset + directorySize > eocd) throw new Error('Studio archive has an invalid directory.');
  const entries: ZipEntry[] = [];
  let at = directoryOffset;
  for (let i = 0; i < count; i++) {
    if (at + 46 > eocd || u32(at) !== 0x02014b50) throw new Error('Studio archive has a damaged directory entry.');
    const nameLength = u16(at + 28), extra = u16(at + 30), comment = u16(at + 32);
    const end = at + 46 + nameLength + extra + comment;
    if (end > eocd) throw new Error('Studio archive directory entry extends past its bounds.');
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    entries.push({ name, flags: u16(at + 8), method: u16(at + 10), time: u16(at + 12), crc: u32(at + 16), compressed: u32(at + 20), size: u32(at + 24), offset: u32(at + 42) });
    at = end;
  }
  // Prefer the exact Studio standard over similarly named backups or submodels.
  const entry = entries.find(e => e.name.toLowerCase() === 'model.ldr')
    ?? entries.find(e => /(^|\/)model\.(ldr|mpd)$/i.test(e.name));
  if (!entry) throw new Error('No model.ldr found inside the Studio .io file. Export as LDraw .ldr or .mpd instead.');
  if (entry.size > MAX_MODEL_BYTES || entry.compressed > MAX_ARCHIVE_BYTES)
    throw new Error('Studio model exceeds the import safety limits.');
  if (entry.flags & 0x40) throw new Error('Strong encrypted Studio ZIP archives are not supported.');
  if (entry.method !== 0 && entry.method !== 8)
    throw new Error(`ZIP compression method ${entry.method} is not supported. Export as LDraw instead.`);
  if (entry.offset + 30 > directoryOffset || u32(entry.offset) !== 0x04034b50)
    throw new Error('Studio archive has a damaged model header.');
  const dataAt = entry.offset + 30 + u16(entry.offset + 26) + u16(entry.offset + 28);
  if (dataAt + entry.compressed > bytes.length || dataAt + entry.compressed > directoryOffset)
    throw new Error('Studio archive contains a truncated model.');
  let payload = bytes.subarray(dataAt, dataAt + entry.compressed);
  if (entry.flags & 1) payload = decryptTraditional(payload, entry.crc, entry.time, !!(entry.flags & 8));
  let plain: Uint8Array;
  if (entry.method === 0) plain = payload;
  else plain = await inflateBounded(payload, entry.size);
  if (plain.length !== entry.size || crc32(plain) !== entry.crc)
    throw new Error('Studio model failed its ZIP integrity check (length or CRC).');
  const text = decoder.decode(plain).replace(/^\uFEFF/, '');
  if (!/^\s*[0-5]\s/m.test(text)) throw new Error('The extracted Studio model is not an LDraw file.');
  return text;
}
