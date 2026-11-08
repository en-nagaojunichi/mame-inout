import { describe, expect, it } from "vitest";
import { elapsedLabel, inputTimeToUtc, localTimeInput } from "./attendance-display";

describe("施設の時計による日時入力", () => {
  it("端末に依存せず東京の時刻をUTCへ変換する", () => {
    expect(inputTimeToUtc("2026-11-08T09:15", "Asia/Tokyo")).toBe("2026-11-08T00:15:00.000Z");
    expect(localTimeInput("2026-11-08T00:15:30.123Z", "Asia/Tokyo")).toBe("2026-11-08T09:15:30.123");
  });
  it("編集していない元のミリ秒と重複時刻の解釈を保持する", () => {
    const original = "2026-11-01T05:30:00.123Z";
    expect(inputTimeToUtc(localTimeInput(original, "America/New_York"), "America/New_York", original)).toBe(original);
  });
  it("夏時間で存在しない時刻と二重になる時刻を拒否する", () => {
    expect(() => inputTimeToUtc("2026-03-08T02:30", "America/New_York")).toThrow();
    expect(() => inputTimeToUtc("2026-11-01T01:30", "America/New_York")).toThrow();
  });
  it("丸められた架空の日付と不完全な入力を拒否する", () => {
    expect(() => inputTimeToUtc("2026-02-30T09:15", "Asia/Tokyo")).toThrow();
    expect(() => inputTimeToUtc("", "Asia/Tokyo")).toThrow();
  });
  it("30分単位の時差も扱う", () => {
    expect(inputTimeToUtc("2026-11-08T09:30:00", "Asia/Kolkata")).toBe("2026-11-08T04:00:00.000Z");
    expect(elapsedLabel(3670)).toBe("1時間1分");
  });
});
