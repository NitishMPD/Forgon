import { inflateSync } from 'node:zlib';
import { ProjectIOError } from '@forgon/project-io/node';

function requireFile(value: unknown, message: string): asserts value {
  if (!value) throw new ProjectIOError('INVALID_DOCUMENT', message);
}
function dimensions(width: number, height: number): void {
  requireFile(width > 0 && height > 0 && width <= 16384 && height <= 16384 && width * height <= 16_777_216, 'Image dimensions exceed import bounds');
}
function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
function png(bytes: Buffer): void {
  requireFile(bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')), 'Invalid PNG signature');
  let offset = 8; let header = false; let ended = false; let dataEnded = false; let width = 0; let height = 0; let channels = 0;
  const data: Buffer[] = [];
  while (offset < bytes.length) {
    requireFile(offset + 12 <= bytes.length, 'Truncated PNG chunk');
    const size = bytes.readUInt32BE(offset); const end = offset + 12 + size;
    requireFile(end <= bytes.length, 'PNG chunk exceeds file');
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    requireFile(/^[A-Za-z]{4}$/.test(type) && crc32(bytes.subarray(offset + 4, end - 4)) === bytes.readUInt32BE(end - 4), 'Invalid PNG chunk/CRC');
    requireFile(header || type === 'IHDR', 'PNG requires first IHDR');
    if (type === 'IHDR') {
      requireFile(!header && size === 13, 'Invalid PNG IHDR'); header = true;
      width = bytes.readUInt32BE(offset + 8); height = bytes.readUInt32BE(offset + 12); dimensions(width, height);
      channels = ({ 0: 1, 2: 3, 4: 2, 6: 4 } as Record<number, number>)[bytes[offset + 17]!] ?? 0;
      requireFile(bytes[offset + 16] === 8 && channels && bytes[offset + 18] === 0 && bytes[offset + 19] === 0 && bytes[offset + 20] === 0, 'Only noninterlaced 8-bit gray/RGB/RGBA PNG is supported');
    } else if (type === 'IDAT') { requireFile(!dataEnded, 'Noncontiguous PNG IDAT'); data.push(bytes.subarray(offset + 8, end - 4)); }
    else if (type === 'IEND') { requireFile(size === 0 && end === bytes.length && data.length, 'Invalid PNG IEND'); ended = true; }
    else { if (data.length) dataEnded = true; requireFile(type === 'PLTE' || type[0] === type[0]!.toLowerCase(), 'Unsupported critical PNG chunk'); }
    offset = end;
  }
  requireFile(ended, 'Missing PNG IEND');
  const row = width * channels + 1; const expected = row * height;
  const decoded = inflateSync(Buffer.concat(data), { maxOutputLength: expected });
  requireFile(decoded.length === expected, 'PNG scanline size mismatch');
  for (let y = 0; y < height; y++) requireFile(decoded[y * row]! <= 4, 'Invalid PNG scanline filter');
}
function jpeg(bytes: Buffer): void {
  requireFile(bytes.length > 4 && bytes.readUInt16BE(0) === 0xffd8, 'Invalid JPEG signature');
  let offset = 2; let frame = false; let scan = false; let ended = false;
  while (offset < bytes.length) {
    requireFile(bytes[offset++] === 0xff, 'Invalid JPEG marker');
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xd9) { ended = true; break; }
    requireFile(marker !== undefined && marker !== 0 && marker !== 0xd8 && !(marker >= 0xd0 && marker <= 0xd7) && offset + 2 <= bytes.length, 'Invalid JPEG marker segment');
    const length = bytes.readUInt16BE(offset);
    requireFile(length >= 2 && offset + length <= bytes.length, 'Truncated JPEG segment');
    if (marker === 0xc0 || marker === 0xc2) {
      requireFile(!frame && length >= 8 && bytes[offset + 2] === 8, 'Unsupported JPEG frame');
      const count = bytes[offset + 7]!; requireFile([1, 3, 4].includes(count) && length === 8 + 3 * count, 'Invalid JPEG component table');
      dimensions(bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3)); frame = true;
    }
    if (marker === 0xda) {
      requireFile(frame && length >= 6 && length === 6 + 2 * bytes[offset + 2]!, 'Invalid JPEG scan'); scan = true;
      offset += length;
      while (offset < bytes.length) {
        if (bytes[offset] !== 0xff) { offset++; continue; }
        const next = bytes[offset + 1];
        if (next === 0 || (next !== undefined && next >= 0xd0 && next <= 0xd7)) { offset += 2; continue; }
        break;
      }
    } else offset += length;
  }
  requireFile(frame && scan && ended && offset === bytes.length, 'JPEG requires frame, scan and final EOI');
}
function wav(bytes: Buffer): void {
  requireFile(bytes.length >= 44 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WAVE' && bytes.readUInt32LE(4) === bytes.length - 8, 'Invalid WAV RIFF header');
  let offset = 12; let align = 0; let data = -1;
  while (offset < bytes.length) {
    requireFile(offset + 8 <= bytes.length, 'Truncated WAV chunk');
    const type = bytes.toString('ascii', offset, offset + 4); const size = bytes.readUInt32LE(offset + 4); const start = offset + 8;
    requireFile(start + size + (size % 2) <= bytes.length, 'WAV chunk exceeds file');
    if (type === 'fmt ') {
      requireFile(!align && size >= 16, 'Invalid/duplicate WAV format');
      const format = bytes.readUInt16LE(start); const channels = bytes.readUInt16LE(start + 2); const rate = bytes.readUInt32LE(start + 4); const bits = bytes.readUInt16LE(start + 14);
      align = bytes.readUInt16LE(start + 12);
      requireFile(channels >= 1 && channels <= 8 && rate >= 8000 && rate <= 192000 && ((format === 1 && [8, 16, 24, 32].includes(bits)) || (format === 3 && bits === 32)) && align === channels * bits / 8 && bytes.readUInt32LE(start + 8) === rate * align, 'Unsupported/inconsistent WAV format');
    } else if (type === 'data') { requireFile(data === -1, 'Duplicate WAV data'); data = size; }
    offset = start + size + (size % 2);
  }
  requireFile(align && data > 0 && data % align === 0, 'Missing or misaligned WAV samples');
}
function glb(bytes: Buffer): void {
  requireFile(bytes.length >= 20 && bytes.toString('ascii', 0, 4) === 'glTF' && bytes.readUInt32LE(4) === 2 && bytes.readUInt32LE(8) === bytes.length, 'Invalid GLB v2 header');
  let offset = 12; let json: unknown; let binary = 0; let chunks = 0;
  while (offset < bytes.length) {
    requireFile(offset + 8 <= bytes.length, 'Truncated GLB chunk');
    const size = bytes.readUInt32LE(offset); const type = bytes.readUInt32LE(offset + 4); offset += 8;
    requireFile(size % 4 === 0 && offset + size <= bytes.length, 'Invalid GLB chunk length');
    if (chunks === 0) {
      requireFile(type === 0x4e4f534a && size <= 2 * 1024 * 1024, 'GLB requires bounded first JSON chunk');
      const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(offset, offset + size));
      // Bound nesting before parsing; glTF extensions remain inert metadata.
      let depth = 0; let quoted = false; let escaped = false;
      for (const char of source) { if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; } else if (char === '"') quoted = true; else if (char === '{' || char === '[') requireFile(++depth <= 64, 'GLB JSON nesting exceeds 64'); else if (char === '}' || char === ']') depth--; }
      json = JSON.parse(source);
    } else { requireFile(chunks === 1 && type === 0x004e4942, 'Only JSON and optional BIN GLB chunks supported'); binary = size; }
    chunks++; offset += size;
  }
  requireFile(json && typeof json === 'object' && !Array.isArray(json), 'Invalid glTF JSON');
  const doc = json as { asset?: { version?: unknown }; extensionsRequired?: unknown; buffers?: { byteLength: number }[];
    bufferViews?: { buffer: number; byteLength: number; byteOffset?: number }[]; images?: { bufferView: number; mimeType: string }[] };
  requireFile(doc.asset?.version === '2.0', 'Unsupported glTF asset version');
  const walk = (value: unknown): void => { if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) { requireFile(key !== 'uri', 'GLB URI resources are not supported; embed buffer/image bytes'); walk(child); } };
  walk(doc);
  requireFile(doc.extensionsRequired === undefined || (Array.isArray(doc.extensionsRequired) && doc.extensionsRequired.length === 0), 'Required glTF extensions are not supported');
  const buffers = doc.buffers ?? []; const views = doc.bufferViews ?? [];
  requireFile(Array.isArray(buffers) && buffers.length <= 1 && Array.isArray(views), 'Invalid glTF buffers');
  if (buffers.length) { const buffer = buffers[0]; requireFile(buffer && Number.isSafeInteger(buffer.byteLength) && buffer.byteLength > 0 && buffer.byteLength <= binary && binary - buffer.byteLength <= 3, 'GLB embedded buffer size mismatch'); }
  else requireFile(binary === 0, 'Unreferenced GLB BIN chunk');
  for (const view of views) requireFile(view && view.buffer === 0 && Number.isSafeInteger(view.byteLength) && view.byteLength > 0 && Number.isSafeInteger(view.byteOffset ?? 0) && (view.byteOffset ?? 0) >= 0 && (view.byteOffset ?? 0) + view.byteLength <= (buffers[0]?.byteLength ?? 0), 'glTF bufferView exceeds embedded buffer');
  requireFile(doc.images === undefined || Array.isArray(doc.images), 'Invalid glTF images');
  for (const image of doc.images ?? []) requireFile(image && Number.isSafeInteger(image.bufferView) && views[image.bufferView] && ['image/png', 'image/jpeg'].includes(image.mimeType), 'glTF images must use embedded PNG/JPEG bufferViews');
  // shortcut: validates the GLB container and resource bounds, use a full glTF validator before claiming semantic or GPU readiness.
}

export function validateAsset(bytes: Uint8Array, extension: string): 'model' | 'texture' | 'audio' {
  const buffer = Buffer.from(bytes);
  requireFile(buffer.length > 0 && buffer.length <= 32 * 1024 * 1024, 'Asset must contain 1 byte to 32 MiB');
  try {
    if (extension === '.glb') { glb(buffer); return 'model'; }
    if (extension === '.wav') { wav(buffer); return 'audio'; }
    if (extension === '.png') { png(buffer); return 'texture'; }
    if (extension === '.jpg' || extension === '.jpeg') { jpeg(buffer); return 'texture'; }
    throw new ProjectIOError('INVALID_DOCUMENT', 'Supported imports: GLB, PNG, JPEG, WAV. SVG and external glTF resources are refused');
  } catch (error) { if (error instanceof ProjectIOError) throw error; throw new ProjectIOError('INVALID_DOCUMENT', `Invalid ${extension} source: ${String(error)}`); }
}
