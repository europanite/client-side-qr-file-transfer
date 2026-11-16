/** Versioned, all-local file-over-QR protocol. Never transmits over a network. */
export const MAGIC = 'QRF3';
// Keep each QR sparse enough for an ordinary laptop webcam to resolve.
export const CHUNK_BYTES = 48;
export const META_BYTES = 48;
export const MAX_METADATA_PARTS = 20;
export const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const HEADER_INTERVAL = 64;
export const MAX_NAME_BYTES = 120;
export const MAX_MIME_BYTES = 100;

export type HeaderFrame = {
  kind: 'header'; id: string; senderId: string; total: number; size: number;
  sha256: string; name: string; mime: string;
};
export type MetadataFrame = {
  kind: 'metadata'; id: string; senderId: string; index: number; total: number; bytes: Uint8Array;
};
export type DataFrame = {
  kind: 'data'; id: string; senderId: string; index: number; total: number; bytes: Uint8Array;
};
export type Frame = MetadataFrame | DataFrame;
export type AckFrame = {
  id: string; senderId: string; kind: 'metadata' | 'data'; index: number; total: number; crc: string;
};
// Each QRF3 frame carries a sender header: version | S | sender-id | kind | transfer-id.
// Header fields and payload share a CRC32; it prevents accidental frame mixups,
// but the sender ID is public and does NOT authenticate a human or device.
export const ACK_MAGIC = 'QRA2';

function frameCrc(frame: Frame): string {
  const kind = frame.kind === 'metadata' ? 'M' : 'D';
  const prefix = encoder.encode([MAGIC, 'S', frame.senderId, kind, frame.id,
    frame.index, frame.total].join('|') + '|');
  const joined = new Uint8Array(prefix.length + frame.bytes.length);
  joined.set(prefix);
  joined.set(frame.bytes, prefix.length);
  return crc32(joined);
}

export function encodeAck(frame: Frame): string {
  return [ACK_MAGIC, 'S', frame.senderId, frame.id, frame.kind === 'metadata' ? 'M' : 'D',
    frame.index, frame.total, frameCrc(frame)].join('|');
}
export function decodeAck(raw: string): AckFrame {
  assert(raw.length <= 100, 'ACK QR too large');
  const parts = raw.split('|');
  assert(parts.length === 8 && parts[0] === ACK_MAGIC && parts[1] === 'S', 'Not a QRA2 acknowledgement');
  assert(/^[0-9a-f]{12}$/.test(parts[2]), 'Invalid ACK sender ID');
  assert(/^[0-9a-f]{12}$/.test(parts[3]), 'Invalid ACK transfer ID');
  assert(parts[4] === 'M' || parts[4] === 'D', 'Invalid ACK kind');
  const limit = parts[4] === 'M' ? MAX_METADATA_PARTS : Math.ceil(MAX_FILE_BYTES / CHUNK_BYTES);
  const total = parseInteger(parts[6], 1, limit);
  const index = parseInteger(parts[5], 0, total - 1);
  assert(/^[0-9a-f]{8}$/.test(parts[7]), 'Invalid ACK CRC');
  return { senderId: parts[2], id: parts[3], kind: parts[4] === 'M' ? 'metadata' : 'data',
    index, total, crc: parts[7] };
}
export function ackMatchesFrame(ack: AckFrame, frame: Frame): boolean {
  return ack.senderId === frame.senderId && ack.id === frame.id && ack.kind === frame.kind &&
    ack.index === frame.index && ack.total === frame.total &&
    ack.crc === frameCrc(frame);
}
export type FrameStep = { kind: 'metadata'; index: number } | { kind: 'data'; index: number };
export type Prepared = { header: HeaderFrame; bytes: Uint8Array; metadata: Uint8Array };
export type Receiver = {
  id: string | null; senderId: string | null; total: number | null; header: HeaderFrame | null;
  metadata: Record<number, Uint8Array>; metadataTotal: number | null;
  chunks: Record<number, Uint8Array>; received: number;
  lastQR: string | null; lastLabel: string | null;
  lastAckQR: string | null; lastAckLabel: string | null;
  history: { qr: string; label: string }[];
  notice: string;
};

export const emptyReceiver = (): Receiver => ({
  id: null, senderId: null, total: null, header: null, metadata: {}, metadataTotal: null,
  chunks: {}, received: 0,
  lastQR: null, lastLabel: null, lastAckQR: null, lastAckLabel: null,
  history: [], notice: 'Ready for QR codes',
});

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function bytesToBase64(bytes: Uint8Array): string {
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
function headerBytes(h: HeaderFrame): Uint8Array {
  // Array saves repeated JSON property names on every transfer.
  return encoder.encode(JSON.stringify([h.size, h.sha256, h.name, h.mime, h.senderId]));
}
export function metadataPartCount(prepared: Prepared): number {
  return Math.ceil(prepared.metadata.length / META_BYTES);
}
export async function prepareFile(file: Pick<File, 'name' | 'type' | 'arrayBuffer' | 'size'>,
  senderId: string = hex(crypto.getRandomValues(new Uint8Array(6)))): Promise<Prepared> {
  assert(/^[0-9a-f]{12}$/.test(senderId), 'Invalid sender ID');
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
    kind: 'header', id, senderId, total, size: bytes.length,
    sha256: await sha256(bytes), name, mime,
  };
  const metadata = headerBytes(header);
  assert(metadata.length <= META_BYTES * MAX_METADATA_PARTS, 'Metadata is too long');
  return { header, bytes, metadata };
}

function encodeFragment(kind: 'M' | 'D', senderId: string, id: string,
  index: number, total: number, bytes: Uint8Array): string {
  const frame = { kind: kind === 'M' ? 'metadata' : 'data', senderId, id, index, total, bytes } as Frame;
  return [MAGIC, 'S', senderId, kind, id, index, total, frameCrc(frame), bytesToBase64(bytes)].join('|');
}
export function encodeHeader(prepared: Prepared, index: number): string {
  const total = metadataPartCount(prepared);
  assert(Number.isInteger(index) && index >= 0 && index < total, 'Invalid metadata index');
  return encodeFragment('M', prepared.header.senderId, prepared.header.id, index, total,
    prepared.metadata.slice(index * META_BYTES, (index + 1) * META_BYTES));
}
export function encodeData(prepared: Prepared, index: number): string {
  assert(Number.isInteger(index) && index >= 0 && index < prepared.header.total, 'Invalid data index');
  const bytes = prepared.bytes.slice(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES);
  return encodeFragment('D', prepared.header.senderId, prepared.header.id, index, prepared.header.total, bytes);
}
export function buildSequence(total: number, metadataParts: number): FrameStep[] {
  assert(Number.isInteger(total) && total >= 1 && total <= Math.ceil(MAX_FILE_BYTES / CHUNK_BYTES), 'Invalid frame count');
  assert(Number.isInteger(metadataParts) && metadataParts >= 1 && metadataParts <= MAX_METADATA_PARTS, 'Invalid metadata part count');
  const steps: FrameStep[] = [];
  const addMetadata = () => {
    for (let index = 0; index < metadataParts; index += 1) steps.push({ kind: 'metadata', index });
  };
  addMetadata();
  for (let index = 0; index < total; index += 1) {
    if (index !== 0 && index % HEADER_INTERVAL === 0) addMetadata();
    steps.push({ kind: 'data', index });
  }
  return steps;
}
export function encodeStep(prepared: Prepared, step: FrameStep): string {
  return step.kind === 'metadata' ? encodeHeader(prepared, step.index) : encodeData(prepared, step.index);
}
function parseInteger(value: string, lower: number, upper: number): number {
  assert(/^(0|[1-9][0-9]*)$/.test(value), 'Invalid integer');
  const parsed = Number(value);
  assert(Number.isSafeInteger(parsed) && parsed >= lower && parsed <= upper, 'Integer out of bounds');
  return parsed;
}
export function decodeFrame(qr: string): Frame {
  assert(qr.length <= 180, 'QR payload too large');
  const parts = qr.split('|');
  assert(parts[0] === MAGIC, 'Not a QRF3 frame');
  assert(parts.length === 9 && parts[1] === 'S', 'Malformed QR frame or sender header');
  assert(/^[0-9a-f]{12}$/.test(parts[2]), 'Invalid sender ID');
  assert(/^[0-9a-f]{12}$/.test(parts[4]), 'Invalid transfer ID');
  const isMetadata = parts[3] === 'M';
  assert(isMetadata || parts[3] === 'D', 'Invalid frame kind');
  const limit = isMetadata ? MAX_METADATA_PARTS : Math.ceil(MAX_FILE_BYTES / CHUNK_BYTES);
  const total = parseInteger(parts[6], 1, limit);
  const index = parseInteger(parts[5], 0, total - 1);
  assert(/^[0-9a-f]{8}$/.test(parts[7]), 'Invalid frame CRC32');
  const maxBytes = isMetadata ? META_BYTES : CHUNK_BYTES;
  const bytes = base64ToBytes(parts[8], maxBytes);
  assert(index === total - 1 || bytes.length === maxBytes, 'Non-final chunk is short');
  assert(!isMetadata || bytes.length > 0, 'Empty metadata part');
  const frame: Frame = { kind: isMetadata ? 'metadata' : 'data', senderId: parts[2],
    id: parts[4], total, index, bytes } as Frame;
  assert(frameCrc(frame) === parts[7], 'Frame/header checksum mismatch');
  return frame;
}

function parseHeader(state: Receiver): HeaderFrame {
  assert(state.metadataTotal !== null, 'Missing metadata');
  const blocks: Uint8Array[] = [];
  let length = 0;
  for (let i = 0; i < state.metadataTotal; i += 1) {
    const block = state.metadata[i];
    assert(block, 'Missing metadata part');
    blocks.push(block);
    length += block.length;
  }
  const complete = new Uint8Array(length);
  let offset = 0;
  for (const block of blocks) { complete.set(block, offset); offset += block.length; }
  const parsed: unknown = JSON.parse(decoder.decode(complete));
  assert(Array.isArray(parsed) && parsed.length === 5, 'Invalid metadata payload');
  const [size, sha, name, mime, senderId] = parsed;
  assert(Number.isSafeInteger(size) && size >= 0 && size <= MAX_FILE_BYTES, 'Invalid file size');
  assert(typeof sha === 'string' && /^[0-9a-f]{64}$/.test(sha), 'Invalid SHA-256');
  assert(typeof name === 'string' && encoder.encode(name).length <= MAX_NAME_BYTES, 'Invalid filename');
  assert(typeof mime === 'string' && encoder.encode(mime).length <= MAX_MIME_BYTES, 'Invalid MIME type');
  assert(typeof senderId === 'string' && /^[0-9a-f]{12}$/.test(senderId), 'Invalid metadata sender ID');
  assert(senderId === state.senderId, 'Metadata sender ID mismatch');
  return {
    kind: 'header', id: state.id!, senderId, size, total: Math.max(1, Math.ceil(size / CHUNK_BYTES)),
    sha256: sha, name: safeFilename(name), mime: mime || 'application/octet-stream',
  };
}
function remember(state: Receiver, frame: Frame, raw: string, label: string, notice: string): Receiver {
  return { ...state, lastQR: raw, lastLabel: label,
    lastAckQR: encodeAck(frame), lastAckLabel: label,
    history: [...state.history.slice(-7), { qr: raw, label }], notice };
}
function repeatAcknowledgement(state: Receiver, frame: Frame): Receiver {
  // Return an ACK for duplicate frames: a sender may have missed the first ACK.
  const lastAckQR = encodeAck(frame);
  if (state.lastAckQR === lastAckQR) return state;
  return { ...state, lastAckQR, lastAckLabel: `${frame.kind === 'metadata' ? 'Metadata' : 'Chunk'} ${frame.index + 1} / ${frame.total}` };
}
export function acceptFrame(state: Receiver, frame: Frame, raw: string): Receiver {
  if (state.senderId && state.senderId !== frame.senderId) {
    return { ...state, notice: 'Different sender detected. Reset receiver before accepting a new sender.' };
  }
  if (state.id && state.id !== frame.id) {
    return { ...state, notice: 'Different transfer detected. Reset receiver to switch files.' };
  }
  if (frame.kind === 'metadata') {
    if (state.metadataTotal !== null && state.metadataTotal !== frame.total) {
      return { ...state, notice: 'Conflicting metadata part count; ignored.' };
    }
    if (state.metadata[frame.index]) {
      // Do not ACK a complete-but-invalid metadata block on subsequent scans.
      if (!state.header && state.metadataTotal !== null &&
          Object.keys(state.metadata).length === state.metadataTotal) return state;
      return crc32(state.metadata[frame.index]) === crc32(frame.bytes)
        ? repeatAcknowledgement(state, frame) : { ...state, notice: 'Conflicting metadata part; ignored.' };
    }
    const next: Receiver = {
      ...state, id: frame.id, senderId: frame.senderId, metadataTotal: frame.total,
      metadata: { ...state.metadata, [frame.index]: frame.bytes },
    };
    const label = `Metadata ${frame.index + 1} / ${frame.total}`;
    if (Object.keys(next.metadata).length !== frame.total) {
      return remember(next, frame, raw, label, `Received metadata part ${frame.index + 1} / ${frame.total}`);
    }
    try {
      const header = parseHeader(next);
      if (next.total !== null && next.total !== header.total) {
        return { ...next, notice: 'Conflicting metadata/data frame count; ignored.' };
      }
      return remember({ ...next, total: header.total, header }, frame, raw, label, 'File metadata received');
    } catch (error) {
      return { ...next, notice: `Invalid metadata: ${String(error)}` };
    }
  }
  if (state.total !== null && state.total !== frame.total) {
    return { ...state, notice: 'Conflicting frame count; ignored.' };
  }
  if (state.chunks[frame.index]) {
    return crc32(state.chunks[frame.index]) === crc32(frame.bytes)
      ? repeatAcknowledgement(state, frame) : { ...state, notice: 'Conflicting chunk; ignored.' };
  }
  return remember({ ...state, id: frame.id, senderId: frame.senderId, total: frame.total,
    chunks: { ...state.chunks, [frame.index]: frame.bytes }, received: state.received + 1,
  }, frame, raw, `Chunk ${frame.index + 1} / ${frame.total}`,
  `Received chunk ${frame.index + 1} / ${frame.total}`);
}
export function missingIndices(state: Receiver): number[] {
  if (state.total === null) return [];
  const missing: number[] = [];
  for (let i = 0; i < state.total; i += 1) if (!state.chunks[i]) missing.push(i);
  return missing;
}
export function missingMetadataIndices(state: Receiver): number[] {
  if (state.metadataTotal === null) return [];
  const missing: number[] = [];
  for (let i = 0; i < state.metadataTotal; i += 1) if (!state.metadata[i]) missing.push(i);
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
