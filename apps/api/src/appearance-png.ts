import { inflateSync } from "node:zlib";
import { appearanceImageMaxBytes, appearanceImageMaxSide } from "@mame/contracts";
import { AttendanceError } from "./attendance-rules.js";

const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const invalid = () => new AttendanceError("INVALID_IMAGE", 422, "画像を確認してください。256×256ピクセル以下・64KB以下のPNGを使用できます。");

// MIME名や拡張子だけを信頼せず、PNGの構造・CRC・展開サイズを確認する。
function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function validateAppearancePng(base64: string): Buffer {
  try {
    const bytes = Buffer.from(base64, "base64");
    if (bytes.toString("base64") !== base64 || bytes.length > appearanceImageMaxBytes || !bytes.subarray(0, 8).equals(signature)) throw invalid();
    let offset = 8, width = 0, height = 0, color = -1, channels = 0;
    let paletteEntries = 0, ended = false, sawData = false, dataEnded = false, transparency = false;
    const kept: Buffer[] = [signature], compressed: Buffer[] = [];
    while (offset < bytes.length) {
      if (offset + 12 > bytes.length || ended) throw invalid();
      const length = bytes.readUInt32BE(offset), end = offset + length + 12;
      if (end > bytes.length) throw invalid();
      const typeBytes = bytes.subarray(offset + 4, offset + 8), type = typeBytes.toString("latin1"), data = bytes.subarray(offset + 8, end - 4);
      if (!/^[A-Za-z]{4}$/.test(type) || (typeBytes[2]! & 32) !== 0 || crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) throw invalid();
      if (offset === 8 && type !== "IHDR") throw invalid();
      if (type === "IHDR") {
        if (width || length !== 13) throw invalid();
        width = data.readUInt32BE(0); height = data.readUInt32BE(4); color = data[9]!;
        channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[color] ?? 0;
        // ブラウザで変換した8bit・非インターレースPNGに揃え、複雑な展開や動画を持ち込まない。
        if (!width || !height || width > appearanceImageMaxSide || height > appearanceImageMaxSide || data[8] !== 8 || !channels || data[10] !== 0 || data[11] !== 0 || data[12] !== 0) throw invalid();
      } else if (type === "PLTE") {
        if (sawData || paletteEntries || !length || length % 3 || length > 768 || color === 0 || color === 4) throw invalid();
        paletteEntries = length / 3;
      } else if (type === "tRNS") {
        if (sawData || transparency || (color === 3 ? !paletteEntries || length < 1 || length > paletteEntries : color === 0 ? length !== 2 : color === 2 ? length !== 6 : true)) throw invalid();
        transparency = true;
      } else if (type === "IDAT") {
        if (dataEnded || (color === 3 && !paletteEntries)) throw invalid();
        sawData = true; compressed.push(data);
      } else if (type === "IEND") {
        if (length || !sawData) throw invalid();
        ended = true;
      } else {
        if ((typeBytes[0]! & 32) === 0 || ["acTL", "fcTL", "fdAT"].includes(type)) throw invalid();
        if (sawData) dataEnded = true;
      }
      // テキストやEXIF等の付加情報は保存・配信せず、描画に必要なチャンクだけを残す。
      if (["IHDR", "PLTE", "tRNS", "IDAT", "IEND"].includes(type)) kept.push(bytes.subarray(offset, end));
      offset = end;
    }
    if (!ended) throw invalid();
    const stride = width * channels + 1, expected = stride * height;
    const packed = Buffer.concat(compressed);
    // Nodeのinfo有効時の戻り値は型定義のBufferと異なるため、この呼出しにだけ形を限定する。
    const unpacked = inflateSync(packed, { maxOutputLength: expected + 1, info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    // PNGの圧縮領域に別のファイルや余剰データを隠して保存できないよう、全入力の消費も確認する。
    if (unpacked.engine.bytesWritten !== packed.length) throw invalid();
    const pixels = unpacked.buffer;
    if (pixels.length !== expected) throw invalid();
    for (let row = 0; row < height; row++) if (pixels[row * stride]! > 4) throw invalid();
    return Buffer.concat(kept);
  } catch { throw invalid(); }
}
