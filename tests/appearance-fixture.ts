import { deflateSync } from "node:zlib";

// 外部画像や個人の画像を使わず、試験に必要な最小のPNGを組み立てる。
export function pngChunk(type: string, data: Uint8Array = Buffer.alloc(0)) {
  const name = Buffer.from(type), size = Buffer.alloc(4), checksum = Buffer.alloc(4);
  size.writeUInt32BE(data.length);
  let crc = 0xffffffff;
  for (const byte of Buffer.concat([name, data])) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([size, name, data, checksum]);
}

export function pngFixture(options: { width?: number; height?: number; filter?: number; depth?: number; interlace?: number; beforeData?: Buffer[]; compressed?: Buffer } = {}) {
  const width = options.width ?? 1, height = options.height ?? 1;
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = options.depth ?? 8; header[9] = 6; header[12] = options.interlace ?? 0;
  const rows = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) rows[y * (width * 4 + 1)] = options.filter ?? 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk("IHDR", header), ...(options.beforeData ?? []), pngChunk("IDAT", options.compressed ?? deflateSync(rows)), pngChunk("IEND")]);
}
