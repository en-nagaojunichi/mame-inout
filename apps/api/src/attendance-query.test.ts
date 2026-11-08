import { describe, expect, it, vi } from "vitest";
import { csvCell, exportAttendanceCsv } from "./attendance-query.js";
import type { Database } from "./db.js";

// DBの認可・同一スナップショットは結合試験に残し、ここではCSVの出力契約を固定する。
vi.mock("./identity.js", () => ({ assertAdministrator: async () => {}, identityClock: async () => new Date("2026-11-01T07:00:00Z") }));

describe("表計算ソフト向けCSVセルの安全性", () => {
  it("引用符・カンマ・改行をCSVの一つのセルとして保持する", () => {
    expect(csvCell('所属,"確認"\n次行')).toBe('"所属,""確認""\n次行"');
    expect(csvCell("")).toBe('""');
    expect(csvCell("山田 太郎")).toBe('"山田 太郎"');
  });

  it("数式・空白の後の数式・制御文字を文字列として固定する", () => {
    for (const value of ["=1+1", "+SUM(A1)", "-2+3", "@SUM(A1)", "  =HYPERLINK(\"x\")", "\t=1", "\r=1", "\n=1", "\t通常文字"]) {
      expect(csvCell(value).startsWith('"\'')).toBe(true);
    }
    expect(csvCell("名前=通常文字")).toBe('"名前=通常文字"');
  });

  it("夏時間の重複・欠落時刻でもCSVの全列・引用・BOM・改行を変えない", async () => {
    const rows = [
      { id: "visit-1", personId: "person-1", displayName: '=合成,"確認"', affiliation: "施設\n受付", code: "-001",
        enteredAt: new Date("2026-11-01T05:30:00Z"), exitedAt: new Date("2026-11-01T06:30:00Z"), canceledAt: null, version: 1, source: "MANUAL", corrected: true },
      { id: "visit-2", personId: "person-2", displayName: "通常", affiliation: null, code: null,
        enteredAt: new Date("2026-03-08T06:59:59Z"), exitedAt: new Date("2026-03-08T07:00:00Z"), canceledAt: new Date("2026-03-09T00:00:00Z"), version: 2, source: "RECEPTION", corrected: false },
    ];
    const tx = { $queryRaw: async () => rows, facility: { findUniqueOrThrow: async () => ({ timeZone: "America/New_York" }) }, auditEvent: { create: async () => ({}) } };
    const db = { $transaction: async (read: (transaction: typeof tx) => Promise<string>) => read(tx) } as unknown as Database;
    const csv = await exportAttendanceCsv(db, { userId: "csv-test", sessionId: "csv-test" }, { status: "all", source: "all", corrected: "all" });
    expect(csv).toBe('\uFEFF"利用者ID","表示名","所属","利用者コード","入室日時","退室日時","状態","記録方法","訂正有無","タイムゾーン","取得日時","記録ID"\r\n' +
      '"person-1","\'=合成,""確認""","施設\n受付","\'-001","2026-11-01 01:30:00","2026-11-01 01:30:00","退室済み","手動","訂正あり","America/New_York","2026-11-01 02:00:00","visit-1"\r\n' +
      '"person-2","通常","","","2026-03-08 01:59:59","2026-03-08 03:00:00","取消","QR受付","訂正なし","America/New_York","2026-11-01 02:00:00","visit-2"\r\n');
    expect(rows[0]!.enteredAt.toISOString()).toBe("2026-11-01T05:30:00.000Z");
    expect(rows[0]!.exitedAt.toISOString()).toBe("2026-11-01T06:30:00.000Z");
  });
});
