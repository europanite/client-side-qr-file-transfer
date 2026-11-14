import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import {
  acceptFrame, assemble, buildSequence, CHUNK_BYTES, crc32,
  decodeFrame, emptyReceiver, encodeData, encodeHeader, encodeStep,
  isComplete, MAX_FILE_BYTES, missingIndices, prepareFile,
} from '../src/protocol.ts';

if (!globalThis.crypto) globalThis.crypto = webcrypto;
const file = (name, bytes, type = 'application/octet-stream') => new File([bytes], name, { type });

async function transfer(bytes, name = 'データ📁.bin') {
  const prepared = await prepareFile(file(name, bytes));
  let state = emptyReceiver();
  const header = encodeHeader(prepared.header);
  state = acceptFrame(state, decodeFrame(header), header);
  return { prepared, state };
}

test('round-trip Unicode filename, out-of-order data, and duplicates', async () => {
  const bytes = Uint8Array.from({ length: CHUNK_BYTES * 3 + 28 }, (_, i) => (i * 41) % 256);
  const { prepared, state: original } = await transfer(bytes);
  assert.equal(prepared.header.total, 4);
  let state = original;
  for (const idx of [3, 2, 2, 0, 1]) {
    const raw = encodeData(prepared, idx);
    state = acceptFrame(state, decodeFrame(raw), raw);
  }
  assert.equal(state.received, 4);
  assert.equal(state.lastLabel, 'Chunk 2 / 4');
  assert.deepEqual(missingIndices(state), []);
  assert.ok(isComplete(state));
  const recovered = await assemble(state);
  assert.equal(recovered.name, 'データ📁.bin');
  assert.deepEqual(new Uint8Array(await recovered.blob.arrayBuffer()), bytes);
});

test('can receive data before metadata', async () => {
  const prepared = await prepareFile(file('simple.txt', new Uint8Array([1, 2, 3])));
  const raw = encodeData(prepared, 0);
  let state = acceptFrame(emptyReceiver(), decodeFrame(raw), raw);
  assert.equal(state.received, 1);
  assert.equal(isComplete(state), false);
  const headerQR = encodeHeader(prepared.header);
  state = acceptFrame(state, decodeFrame(headerQR), headerQR);
  assert.equal(isComplete(state), true);
  assert.equal((await assemble(state)).name, 'simple.txt');
});

test('empty files round-trip using one empty data QR', async () => {
  const { prepared, state } = await transfer(new Uint8Array());
  const qr = encodeData(prepared, 0);
  const finished = acceptFrame(state, decodeFrame(qr), qr);
  assert.equal((await assemble(finished)).blob.size, 0);
});

test('CRC tampering is rejected before accepting data', async () => {
  const { prepared } = await transfer(new Uint8Array([1, 2, 3]));
  const qr = encodeData(prepared, 0);
  const parts = qr.split('|');
  parts[5] = '00000000';
  assert.throws(() => decodeFrame(parts.join('|')), /checksum mismatch/);
  assert.equal(crc32(new Uint8Array([1, 2, 3])), '55bc801d');
});

test('competing transfer IDs are rejected rather than silently merged', async () => {
  const one = await transfer(new Uint8Array([1]));
  const another = await transfer(new Uint8Array([2]));
  const qr = encodeData(another.prepared, 0);
  const mixed = acceptFrame(one.state, decodeFrame(qr), qr);
  assert.equal(mixed.received, 0);
  assert.match(mixed.notice, /Different transfer/);
});

test('missing indices and periodically repeated header', async () => {
  const { prepared, state } = await transfer(new Uint8Array(CHUNK_BYTES * 19));
  const steps = buildSequence(prepared.header.total);
  assert.equal(steps[0].kind, 'header');
  assert.equal(steps.filter((step) => step.kind === 'header').length, 2);
  assert.ok(encodeStep(prepared, steps[17]).startsWith('QRF1|H|'));
  assert.equal(missingIndices(state).length, 19);
});

test('enforces file-size and filename limits', async () => {
  await assert.rejects(() => prepareFile(file('big.bin', new Uint8Array(MAX_FILE_BYTES + 1))), /exceeds/);
  await assert.rejects(() => prepareFile(file('あ'.repeat(50), new Uint8Array([2]))), /Filename is too long/);
});

test('file digest mismatch blocks reconstruction', async () => {
  const { prepared, state } = await transfer(new Uint8Array([1, 3]));
  const raw = encodeData(prepared, 0);
  const finished = acceptFrame(state, decodeFrame(raw), raw);
  const changed = { ...finished, header: { ...finished.header, sha256: 'f'.repeat(64) } };
  await assert.rejects(() => assemble(changed), /SHA-256 verification failed/);
});

test('rejects malformed QR frames', async () => {
  assert.throws(() => decodeFrame('irrelevant'), /Not a QRF1/);
  assert.throws(() => decodeFrame('QRF1|D|123|0|1|00000000|a'), /Invalid transfer ID/);
  assert.throws(() => decodeFrame('QRF1|D|0123456789ab|0|1|00000000|*'), /Invalid base64url/);
});
