import assert from "node:assert/strict";
import test from "node:test";
import { assertPngSize, readPngSize } from "../../packages/renderer/src/png.js";

function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

test("reads dimensions from a PNG IHDR header", () => {
  assert.deepEqual(readPngSize(pngHeader(1280, 720)), { width: 1280, height: 720 });
});

test("accepts a PNG only when the decoded dimensions match", () => {
  const size = assertPngSize(pngHeader(1280, 720), 1280, 720);
  assert.deepEqual(size, { width: 1280, height: 720 });
  assert.throws(() => assertPngSize(pngHeader(2560, 1440), 1280, 720), /2560x1440/);
});

test("rejects short buffers and invalid signatures", () => {
  assert.throws(() => readPngSize(new Uint8Array(23)), /too short/);
  const badSignature = pngHeader(1280, 720);
  badSignature[1] = 0;
  assert.throws(() => readPngSize(badSignature), /signature/);
});

test("rejects a missing IHDR chunk or wrong chunk length", () => {
  const badType = pngHeader(1280, 720);
  badType[12] = 0;
  assert.throws(() => readPngSize(badType), /IHDR/);

  const badLength = pngHeader(1280, 720);
  new DataView(badLength.buffer).setUint32(8, 12);
  assert.throws(() => readPngSize(badLength), /length/);
});

test("rejects empty dimensions", () => {
  assert.throws(() => readPngSize(pngHeader(0, 720)), /empty dimensions/);
  assert.throws(() => readPngSize(pngHeader(1280, 0)), /empty dimensions/);
});
