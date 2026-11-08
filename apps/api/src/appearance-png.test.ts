import { describe, expect, it } from "vitest";
import { deflateSync } from "node:zlib";
import { appearanceInputSchema } from "@mame/contracts";
import { validateAppearancePng } from "./appearance-png.js";
import { pngChunk, pngFixture } from "../../../tests/appearance-fixture.js";

const validate = (bytes: Buffer) => validateAppearancePng(bytes.toString("base64"));

describe("表示画像の内容検証", () => {
  it("標準PNGと上限寸法のPNGを受理する", () => {
    for (const bytes of [pngFixture(), pngFixture({ width: 256, height: 256 })]) expect(validate(bytes).equals(bytes)).toBe(true);
  });
  it("テキスト等のメタデータは保存対象から除く", () => {
    const plain = pngFixture();
    const withMetadata = pngFixture({ beforeData: [pngChunk("tEXt", Buffer.from("comment\0not-for-storage"))] });
    expect(validate(withMetadata).equals(plain)).toBe(true);
  });
  it("偽の署名・CRC改変・途中切断・末尾追加を拒否する", () => {
    const bytes = pngFixture(), corrupt = Buffer.from(bytes); corrupt[33] = corrupt[33]! ^ 1;
    for (const input of [Buffer.from("not-png"), corrupt, bytes.subarray(0, bytes.length - 1), Buffer.concat([bytes, Buffer.from("x")])]) expect(() => validate(input)).toThrow();
  });
  it("寸法・ビット深度・インターレースの対応範囲外を拒否する", () => {
    for (const bytes of [pngFixture({ width: 0 }), pngFixture({ width: 257 }), pngFixture({ height: 257 }), pngFixture({ depth: 16 }), pngFixture({ interlace: 1 })]) expect(() => validate(bytes)).toThrow();
  });
  it("動画・未知の必須チャンク・不正なチャンク名を拒否する", () => {
    for (const type of ["acTL", "ZZZZ", "tesT", "t\u00c5Xt"]) expect(() => validate(pngFixture({ beforeData: [pngChunk(type)] }))).toThrow();
  });
  it("展開データの長さと走査線フィルターを検査する", () => {
    for (const bytes of [pngFixture({ compressed: deflateSync(Buffer.alloc(4)) }), pngFixture({ compressed: deflateSync(Buffer.alloc(6)) }), pngFixture({ compressed: Buffer.from("invalid") }), pngFixture({ filter: 5 })]) expect(() => validate(bytes)).toThrow();
  });
  it("展開爆弾と64KBを超えた入力を拒否する", () => {
    expect(() => validate(pngFixture({ compressed: deflateSync(Buffer.alloc(2_000_000)) }))).toThrow();
    expect(() => validate(pngFixture({ beforeData: [pngChunk("tEXt", Buffer.alloc(65_536))] }))).toThrow();
  });
  it("正規でないbase64とデータURLを受け付けない", () => {
    const bytes = pngFixture();
    for (const text of [bytes.toString("base64") + "\n", `data:image/png;base64,${bytes.toString("base64")}`, "!!!!"]) expect(() => validateAppearancePng(text)).toThrow();
  });
  it("表示設定は名前と画像の更新契約だけを受け付ける", () => {
    expect(appearanceInputSchema.safeParse({ displayName: "  施設の受付  ", expectedVersion: 1 }).data?.displayName).toBe("施設の受付");
    for (const input of [{ displayName: " ", expectedVersion: 1 }, { displayName: "名".repeat(65), expectedVersion: 1 }, { displayName: "名\n前", expectedVersion: 1 }, { displayName: "名前", expectedVersion: 0 }, { displayName: "名前", expectedVersion: 1, origin: "https://example.invalid" }, { displayName: "名前", expectedVersion: 1, iconPng: "data:image/png;base64,aaa" }]) expect(appearanceInputSchema.safeParse(input).success).toBe(false);
  });
});
