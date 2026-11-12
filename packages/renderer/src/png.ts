export interface PngSize {
  width: number;
  height: number;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const IHDR_TYPE = [0x49, 0x48, 0x44, 0x52];

/** Read dimensions from the IHDR chunk at the start of a PNG buffer. */
export function readPngSize(buffer: Uint8Array): PngSize {
  if (buffer.length < 24) throw new Error(`PNG is too short (${buffer.length} bytes)`);
  for (let index = 0; index < PNG_SIGNATURE.length; index++) {
    if (buffer[index] !== PNG_SIGNATURE[index]) throw new Error("invalid PNG signature");
  }
  for (let index = 0; index < IHDR_TYPE.length; index++) {
    if (buffer[12 + index] !== IHDR_TYPE[index]) throw new Error("PNG does not start with IHDR");
  }
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  if (view.getUint32(8) !== 13) throw new Error("PNG IHDR length is not 13");
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (width === 0 || height === 0) throw new Error(`PNG has empty dimensions ${width}x${height}`);
  return { width, height };
}

/** Fail unless the decoded PNG itself is exactly the expected size. */
export function assertPngSize(
  buffer: Uint8Array,
  expectedWidth: number,
  expectedHeight: number,
): PngSize {
  const size = readPngSize(buffer);
  if (size.width !== expectedWidth || size.height !== expectedHeight) {
    throw new Error(
      `PNG is ${size.width}x${size.height}, expected ${expectedWidth}x${expectedHeight}`,
    );
  }
  return size;
}
