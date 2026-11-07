import { describe, expect, it } from "vitest";
import { assertVisitTimes, attendanceOutcome, facilityDateTime, intervalsOverlap } from "./attendance-rules.js";

const date = (value: string) => new Date(value);
const now = date("2026-11-07T12:00:00Z");

describe("入退出の業務ルール", () => {
  it("入退室モードと現在の状態を使い、自動で交互に切り替えない", () => {
    expect(attendanceOutcome("IN", false)).toBe("RECORDED");
    expect(attendanceOutcome("IN", true)).toBe("ALREADY_INSIDE");
    expect(attendanceOutcome("OUT", true)).toBe("RECORDED");
    expect(attendanceOutcome("OUT", false)).toBe("NOT_INSIDE");
  });

  it("未来・逆転・無効な日時を拒否し、同時刻の入退室を許可する", () => {
    expect(() => assertVisitTimes(now, now, now)).not.toThrow();
    expect(() => assertVisitTimes(now, null, now)).not.toThrow();
    expect(() => assertVisitTimes(new Date(now.getTime() + 1), null, now)).toThrow();
    expect(() => assertVisitTimes(now, new Date(now.getTime() - 1), now)).toThrow();
    expect(() => assertVisitTimes(now, new Date(now.getTime() + 1), now)).toThrow();
    expect(() => assertVisitTimes(new Date("invalid"), null, now)).toThrow();
  });

  it("過去の未退室は日を跨いでも継続中の区間として扱う", () => {
    expect(intervalsOverlap({ enteredAt: date("2026-11-05T23:00:00Z"), exitedAt: null },
      { enteredAt: date("2026-11-07T01:00:00Z"), exitedAt: null })).toBe(true);
  });

  it("隣接区間を許可し、包含・交差・未退室との重複を拒否する", () => {
    const a = { enteredAt: date("2026-11-07T01:00:00Z"), exitedAt: date("2026-11-07T02:00:00Z") };
    expect(intervalsOverlap(a, { enteredAt: a.exitedAt, exitedAt: null })).toBe(false);
    expect(intervalsOverlap(a, { enteredAt: date("2026-11-07T00:00:00Z"), exitedAt: date("2026-11-07T03:00:00Z") })).toBe(true);
    expect(intervalsOverlap(a, { enteredAt: date("2026-11-07T01:30:00Z"), exitedAt: null })).toBe(true);
    expect(intervalsOverlap(a, { enteredAt: date("2026-11-07T00:00:00Z"), exitedAt: date("2026-11-07T01:00:00Z") })).toBe(false);
  });

  it("長さゼロの終了済み区間を重複とは扱わない", () => {
    const point = date("2026-11-07T01:00:00Z");
    expect(intervalsOverlap({ enteredAt: point, exitedAt: point },
      { enteredAt: date("2026-11-07T00:00:00Z"), exitedAt: null })).toBe(false);
  });

  it("UTCの保存値を変更せず、施設の日時で日跨ぎを表示する", () => {
    const value = date("2026-11-07T16:00:00Z");
    expect(facilityDateTime(value, "Asia/Tokyo")).toBe("2026-11-08 01:00:00");
    expect(facilityDateTime(value, "UTC")).toBe("2026-11-07 16:00:00");
    expect(value.toISOString()).toBe("2026-11-07T16:00:00.000Z");
  });

  it("施設の夏時間切り替えを日時表示へ反映する", () => {
    expect(facilityDateTime(date("2026-11-01T05:30:00Z"), "America/New_York")).toBe("2026-11-01 01:30:00");
    expect(facilityDateTime(date("2026-11-01T06:30:00Z"), "America/New_York")).toBe("2026-11-01 01:30:00");
  });

  it("不正な施設タイムゾーンと表示日時を拒否する", () => {
    expect(() => facilityDateTime(now, "Unknown/Facility")).toThrow();
    expect(() => facilityDateTime(new Date("invalid"), "UTC")).toThrow();
  });
});
