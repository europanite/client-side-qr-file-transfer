/** Versioned, all-local file-over-QR protocol. Never transmits over a network. */
export const MAGIC = 'QRF1';
export const CHUNK_BYTES = 384;
export const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const HEADER_INTERVAL = 16;
export const MAX_NAME_BYTES = 120;
export const MAX_MIME_BYTES = 100;

export type HeaderFrame = {
  kind: 'header'; id: string; total: number; size: number;
  sha256: string; name: string; mime: string;
};
export type DataFrame = {
  kind: 'data'; id: string; index: number; total: number; bytes: Uint8Array;
};
export type Frame = HeaderFrame | DataFrame;
export type FrameStep = { kind: 'header' } | { kind: 'data'; index: number };
export type Prepared = { header: HeaderFrame; bytes: Uint8Array };
export type Receiver = {
  id: string | null; total: number | null; header: HeaderFrame | null;
  chunks: Record<number, Uint8Array>; received: number;
  lastQR: string | null; lastLabel: string | null;
  history: { qr: string; label: string }[];
  notice: string;
};

export const emptyReceiver = (): Receiver => ({
  id: null, total: null, header: null, chunks: {}, received: 0,
  lastQR: null, lastLabel: null, history: [], notice: 'Ready for QR codes',
});

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function bytesToBase64(bytes: Uint8Array): string {
  // Frames are small by design, so browser btoa's string limit is not approached.
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function base64ToBytes(encoded: string, limit: number): Uint8Array {
  assert(/^[A-Za-z0-9_-]*$/.test(encoded), 'Invalid base64url');
  assert(encoded.length <= Math.ceil(limit / 3) * 4 + 2, 'Encoded field too large');
  const raw = atob(encoded.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - encoded.length % 4) % 4));
  assert(raw.length <= limit, 'Decoded field too large');
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
export async function sha256(bytes: Uint8Array): Promise<string> {
  // Use a standalone ArrayBuffer to satisfy current WebCrypto BufferSource typing.
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', buffer)));
}
export function crc32(bytes: Uint8Array): string {
  let crc = 0xffffffff;
  for (const value of bytes) {
    crc ^= value;
    for (let k = 0; k < 8; k += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0');
}
function safeFilename(name: string): string {
  return name.replace(/[\\/\x00-\x1f\x7f]/g, '_').trim() || 'received.bin';
}

export async function prepareFile(file: Pick<File, 'name' | 'type' | 'arrayBuffer' | 'size'>): Promise<Prepared> {
  assert(file.size <= MAX_FILE_BYTES, `File exceeds ${MAX_FILE_BYTES / 1024 / 1024} MiB limit`);
  const name = safeFilename(file.name);
  const mime = file.type || 'application/octet-stream';
  assert(encoder.encode(name).length <= MAX_NAME_BYTES, 'Filename is too long (120 UTF-8 bytes max)');
  assert(encoder.encode(mime).length <= MAX_MIME_BYTES, 'MIME type is too long');
  const bytes = new Uint8Array(await file.arrayBuffer());
  assert(bytes.length === file.size, 'File size changed while reading');
  const total = Math.max(1, Math.ceil(bytes.length / CHUNK_BYTES));
  const id = hex(crypto.getRandomValues(new Uint8Array(6)));
  const header: HeaderFrame = {
    kind: 'header', id, total, size: bytes.length,
    sha256: await sha256(bytes), name, mime,
  };
  return { header, bytes };
}

export function encodeHeader(h: HeaderFrame): string {
  return [MAGIC, 'H', h.id, h.total, h.size, h.sha256,
    bytesToBase64(encoder.encode(h.name)), bytesToBase64(encoder.encode(h.mime))].join('|');
}
export function encodeData(prepared: Prepared, index: number): string {
  assert(Number.isInteger(index) && index >= 0 && index < prepared.header.total, 'Invalid data index');
  const bytes = prepared.bytes.slice(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES);
  return [MAGIC, 'D', prepared.header.id, index, prepared.header.total, crc32(bytes), bytesToBase64(bytes)].join('|');
}
export function buildSequence(total: number): FrameStep[] {
  assert(Number.isInteger(total) && total >= 1 && total <= Math.ceil(MAX_FILE_BYTES / CHUNK_BYTES), 'Invalid frame count');
  const steps: FrameStep[] = [{ kind: 'header' }];
  for (let index = 0; index < total; index += 1) {
    if (index !== 0 && index % HEADER_INTERVAL === 0) steps.push({ kind: 'header' });
    steps.push({ kind: 'data', index });
  }
  return steps;
}
export function encodeStep(prepared: Prepared, step: FrameStep): string {
  return step.kind === 'header' ? encodeHeader(prepared.header) : encodeData(prepared, step.index);
}
function parseInteger(value: string, lower: number, upper: number): number {
  assert(/^(0|[1-9][0-9]*)$/.test(value), 'Invalid integer');
  const parsed = Number(value);
  assert(Number.isSafeInteger(parsed) && parsed >= lower && parsed <= upper, 'Integer out of bounds');
  return parsed;
}
export function decodeFrame(qr: string): Frame {
  assert(qr.length <= 2048, 'QR payload too large');
  const parts = qr.split('|');
  assert(parts[0] === MAGIC, 'Not a QRF1 frame');
  assert(parts[2] !== undefined && /^[0-9a-f]{12}$/.test(parts[2]), 'Invalid transfer ID');
  const id = parts[2];
  const maxTotal = Math.ceil(MAX_FILE_BYTES / CHUNK_BYTES);
  if (parts[1] === 'H') {
    assert(parts.length === 8, 'Malformed header');
    const total = parseInteger(parts[3], 1, maxTotal);
    const size = parseInteger(parts[4], 0, MAX_FILE_BYTES);
    assert(total === Math.max(1, Math.ceil(size / CHUNK_BYTES)), 'Header chunk count does not match file size');
    assert(/^[0-9a-f]{64}$/.test(parts[5]), 'Invalid SHA-256');
    const name = safeFilename(decoder.decode(base64ToBytes(parts[6], MAX_NAME_BYTES)));
    const mime = decoder.decode(base64ToBytes(parts[7], MAX_MIME_BYTES)) || 'application/octet-stream';
    return { kind: 'header', id, total, size, sha256: parts[5], name, mime };
  }
  assert(parts[1] === 'D' && parts.length === 7, 'Malformed data frame');
  const total = parseInteger(parts[4], 1, maxTotal);
  const index = parseInteger(parts[3], 0, total - 1);
  assert(/^[0-9a-f]{8}$/.test(parts[5]), 'Invalid CRC32');
  const bytes = base64ToBytes(parts[6], CHUNK_BYTES);
  assert(index === total - 1 || bytes.length === CHUNK_BYTES, 'Non-final chunk is short');
  assert(crc32(bytes) === parts[5], 'Data checksum mismatch');
  return { kind: 'data', id, total, index, bytes };
}

export function acceptFrame(state: Receiver, frame: Frame, raw: string): Receiver {
  if (state.id && state.id !== frame.id) {
    return { ...state, notice: 'Different transfer detected. Reset receiver to switch files.' };
  }
  if (state.total !== null && state.total !== frame.total) {
    return { ...state, notice: 'Conflicting frame count; ignored.' };
  }
  if (frame.kind === 'header') {
    if (state.header && JSON.stringify(state.header) !== JSON.stringify(frame)) {
      return { ...state, notice: 'Conflicting metadata; ignored.' };
    }
    if (state.header) return state;
    return { ...state, id: frame.id, total: frame.total, header: frame,
      lastQR: raw, lastLabel: 'Metadata',
      history: [...state.history.slice(-7), { qr: raw, label: 'Metadata' }],
      notice: 'File metadata received' };
  }
  if (state.chunks[frame.index]) return state; // deduplicate cycles
  return { ...state, id: frame.id, total: frame.total,
    chunks: { ...state.chunks, [frame.index]: frame.bytes }, received: state.received + 1,
    lastQR: raw, lastLabel: `Chunk ${frame.index + 1} / ${frame.total}`,
    history: [...state.history.slice(-7), { qr: raw, label: `Chunk ${frame.index + 1}` }],
    notice: `Received chunk ${frame.index + 1} / ${frame.total}` };
}
export function missingIndices(state: Receiver): number[] {
  if (state.total === null) return [];
  const missing: number[] = [];
  for (let i = 0; i < state.total; i += 1) if (!state.chunks[i]) missing.push(i);
  return missing;
}
export function isComplete(state: Receiver): boolean {
  return state.header !== null && state.received === state.header.total;
}
export async function assemble(state: Receiver): Promise<{ blob: Blob; name: string }> {
  assert(isComplete(state) && state.header, 'File is incomplete or metadata is missing');
  const header = state.header;
  const output = new Uint8Array(header.size);
  for (let index = 0; index < header.total; index += 1) {
    const chunk = state.chunks[index];
    assert(chunk, `Missing chunk ${index}`);
    const expected = index === header.total - 1 ? header.size - index * CHUNK_BYTES : CHUNK_BYTES;
    assert(chunk.length === expected, `Invalid chunk size at ${index}`);
    output.set(chunk, index * CHUNK_BYTES);
  }
  assert(await sha256(output) === header.sha256, 'SHA-256 verification failed. Do not use this file.');
  const blob = new Blob([output], { type: header.mime });
  return { blob, name: header.name };
}
