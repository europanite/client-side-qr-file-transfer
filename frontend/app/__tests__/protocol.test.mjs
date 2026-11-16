import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import {
  acceptFrame, ackMatchesFrame, assemble, buildSequence, CHUNK_BYTES, META_BYTES, crc32,
  decodeAck, encodeAck,
  decodeFrame, emptyReceiver, encodeData, encodeHeader, encodeStep,
  HEADER_INTERVAL, isComplete, MAGIC, MAX_FILE_BYTES, metadataPartCount,
  missingIndices, missingMetadataIndices, prepareFile,
} from '../src/protocol.ts';

if (!globalThis.crypto) globalThis.crypto = webcrypto;
const file = (name, bytes, type = 'application/octet-stream') => new File([bytes], name, { type });
const scan = (state, code) => acceptFrame(state, decodeFrame(code), code);
function scanMetadata(prepared, indexes = Array.from({ length: metadataPartCount(prepared) }, (_, i) => i)) {
  let state = emptyReceiver();
  for (const index of indexes) state = scan(state, encodeHeader(prepared, index));
  return state;
}

test('round-trip Unicode filename, out-of-order metadata/data, and duplicates', async () => {
  const bytes = Uint8Array.from({ length: CHUNK_BYTES * 3 + 28 }, (_, i) => (i * 41) % 256);
  const prepared = await prepareFile(file('データ📁.bin', bytes));
  assert.equal(prepared.header.total, 4);
  assert.ok(metadataPartCount(prepared) > 1);
  let state = emptyReceiver();
  for (const idx of [3, 2, 2, 0, 1]) state = scan(state, encodeData(prepared, idx));
  assert.equal(state.received, 4);
  assert.equal(isComplete(state), false);
  for (const idx of Array.from({ length: metadataPartCount(prepared) }, (_, i) => i).reverse()) {
    state = scan(state, encodeHeader(prepared, idx));
  }
  assert.ok(isComplete(state));
  assert.deepEqual(missingIndices(state), []);
  assert.deepEqual(missingMetadataIndices(state), []);
  const recovered = await assemble(state);
  assert.equal(recovered.name, 'データ📁.bin');
  assert.deepEqual(new Uint8Array(await recovered.blob.arrayBuffer()), bytes);
});

test('all metadata parts are required, and can be received out of order', async () => {
  const prepared = await prepareFile(file('simple.txt', new Uint8Array([1, 2, 3])));
  const partCount = metadataPartCount(prepared);
  assert.ok(partCount >= 2);
  let state = scanMetadata(prepared, Array.from({ length: partCount - 1 }, (_, i) => partCount - i - 1));
  assert.equal(state.header, null);
  assert.deepEqual(missingMetadataIndices(state), [0]);
  state = scan(state, encodeHeader(prepared, 0));
  assert.equal(state.header.name, 'simple.txt');
  assert.ok(isComplete(scan(state, encodeData(prepared, 0))));
});

test('empty file round-trip', async () => {
  const prepared = await prepareFile(file('empty.bin', new Uint8Array()));
  const state = scan(scanMetadata(prepared), encodeData(prepared, 0));
  assert.equal((await assemble(state)).blob.size, 0);
});

test('CRC tampering is rejected before accepting data or metadata', async () => {
  const prepared = await prepareFile(file('a.bin', new Uint8Array([1, 2, 3])));
  for (const code of [encodeData(prepared, 0), encodeHeader(prepared, 0)]) {
    const parts = code.split('|');
    parts[7] = '00000000';
    assert.throws(() => decodeFrame(parts.join('|')), /checksum mismatch/);
  }
  assert.equal(crc32(new Uint8Array([1, 2, 3])), '55bc801d');
});

test('competing transfer IDs are rejected', async () => {
  const first = await prepareFile(file('first.bin', new Uint8Array([1])), 'abcdef012345');
  const second = await prepareFile(file('second.bin', new Uint8Array([2])), 'abcdef012345');
  const state = scan(scanMetadata(first), encodeData(second, 0));
  assert.equal(state.received, 0);
  assert.match(state.notice, /Different transfer/);
});

test('metadata repeats periodically without dense full-size header QR', async () => {
  const prepared = await prepareFile(file('long.bin', new Uint8Array(CHUNK_BYTES * (HEADER_INTERVAL + 1))));
  const parts = metadataPartCount(prepared);
  const steps = buildSequence(prepared.header.total, parts);
  assert.equal(steps.filter((s) => s.kind === 'metadata').length, parts * 2);
  assert.equal(steps.filter((s) => s.kind === 'data').length, HEADER_INTERVAL + 1);
  assert.ok(encodeStep(prepared, steps[0]).startsWith(`${MAGIC}|S|${prepared.header.senderId}|M|`));
  assert.equal(encodeStep(prepared, steps.at(-1)), encodeData(prepared, HEADER_INTERVAL));
});

test('each QR stays short even for the maximum Unicode filename', async () => {
  const bytes = new Uint8Array(CHUNK_BYTES * 2);
  const prepared = await prepareFile(file('あ'.repeat(40), bytes, 'application/octet-stream'));
  assert.equal(META_BYTES, 48);
  for (const frame of buildSequence(prepared.header.total, metadataPartCount(prepared))) {
    const qr = encodeStep(prepared, frame);
    assert.ok(qr.length <= 145, `Oversized QR: ${qr.length}`);
    assert.deepEqual(decodeFrame(qr).kind, frame.kind);
  }
});

test('enforces file-size and filename limits', async () => {
  await assert.rejects(() => prepareFile(file('big.bin', new Uint8Array(MAX_FILE_BYTES + 1))), /exceeds/);
  await assert.rejects(() => prepareFile(file('あ'.repeat(50), new Uint8Array([2]))), /Filename is too long/);
});

test('file digest mismatch blocks reconstruction', async () => {
  const prepared = await prepareFile(file('checksum.bin', new Uint8Array([1, 3])));
  const finished = scan(scanMetadata(prepared), encodeData(prepared, 0));
  const changed = { ...finished, header: { ...finished.header, sha256: 'f'.repeat(64) } };
  await assert.rejects(() => assemble(changed), /SHA-256 verification failed/);
});

test('rejects malformed or outdated QRs', async () => {
  assert.throws(() => decodeFrame('irrelevant'), /Not a QRF3/);
  assert.throws(() => decodeFrame('QRF2|D|0123456789ab|0|1|00000000|AA'), /Not a QRF3/);
  assert.throws(() => decodeFrame('QRF3|S|not-an-id|D|0123456789ab|0|1|00000000|AA'), /Invalid sender ID/);
  assert.throws(() => decodeFrame('QRF3|S|123456789abc|D|not-an-id|0|1|00000000|AA'), /Invalid transfer ID/);
  assert.throws(() => decodeFrame('QRF3|S|123456789abc|D|0123456789ab|0|1|00000000|*'), /Invalid base64url/);
});


test('ACK QR matches only the exact transfer ID, frame kind, number and CRC', async () => {
  const prepared = await prepareFile(file('ack.bin', new Uint8Array(CHUNK_BYTES + 1).fill(123)));
  const code0 = encodeData(prepared, 0);
  const code1 = encodeData(prepared, 1);
  const frame0 = decodeFrame(code0);
  const ack = decodeAck(encodeAck(frame0));
  assert.ok(ackMatchesFrame(ack, frame0));
  assert.equal(ackMatchesFrame(ack, decodeFrame(code1)), false);
  assert.equal(ackMatchesFrame(ack, decodeFrame(encodeHeader(prepared, 0))), false);
  const second = await prepareFile(file('ack.bin', new Uint8Array(CHUNK_BYTES + 1).fill(123)));
  assert.equal(ackMatchesFrame(ack, decodeFrame(encodeData(second, 0))), false);
  assert.throws(() => decodeAck('QRA2|S|123456789abc|not-an-id|D|0|2|00000000'), /Invalid ACK transfer ID/);
  assert.throws(() => decodeAck('QRA2|S|123456789abc|0123456789ab|D|2|2|00000000'), /Integer out of bounds/);
});

test('Receiver shows ACK for accepted frames and retransmits ACK for duplicates', async () => {
  const prepared = await prepareFile(file('ack.bin', new Uint8Array([3, 7])));
  const first = encodeHeader(prepared, 0);
  const frame = decodeFrame(first);
  let receiver = acceptFrame(emptyReceiver(), frame, first);
  assert.equal(receiver.lastAckQR, encodeAck(frame));
  const next = encodeData(prepared, 0);
  receiver = acceptFrame(receiver, decodeFrame(next), next);
  assert.equal(receiver.lastAckQR, encodeAck(decodeFrame(next)));
  receiver = acceptFrame(receiver, frame, first);
  assert.equal(receiver.lastAckQR, encodeAck(frame));
  assert.equal(receiver.received, 1);
});

test('sender header persists across frames and rejects mixed sources', async () => {
  const sender = '0123456789ab';
  const fileA = await prepareFile(file('origin.bin', new Uint8Array(CHUNK_BYTES + 2).fill(42)), sender);
  const first = encodeData(fileA, 0);
  const decoded = decodeFrame(first);
  assert.equal(decoded.senderId, sender);
  assert.equal(first.split('|')[1], 'S');
  let receiver = scan(emptyReceiver(), first);
  assert.equal(receiver.senderId, sender);
  assert.equal(receiver.received, 1);
  // A header edit is not covered by the payload's old CRC alone: QRF3 rejects it.
  const edited = first.split('|');
  edited[2] = 'fedcba987654';
  assert.throws(() => decodeFrame(edited.join('|')), /checksum mismatch/);
  const anotherSender = await prepareFile(file('other.bin', new Uint8Array([8])), 'fedcba987654');
  // A valid QR from another origin with the same transfer ID stays isolated.

  anotherSender.header.id = fileA.header.id;
  const otherValid = encodeData(anotherSender, 0);
  receiver = scan(receiver, otherValid);
  assert.equal(receiver.received, 1);
  assert.match(receiver.notice, /Different sender/);
  const ack = decodeAck(encodeAck(decoded));
  assert.equal(ack.senderId, sender);
  assert.equal(ackMatchesFrame(ack, decodeFrame(otherValid)), false);
});

test('metadata sender header matches every frame and reconstructed metadata', async () => {
  const sender = '001122334455';
  const prepared = await prepareFile(file('bound.bin', new Uint8Array([2, 3])), sender);
  let state = scanMetadata(prepared);
  assert.equal(state.header.senderId, sender);
  assert.equal(state.senderId, sender);
  state = scan(state, encodeData(prepared, 0));
  assert.deepEqual(new Uint8Array(await (await assemble(state)).blob.arrayBuffer()), new Uint8Array([2, 3]));
});
