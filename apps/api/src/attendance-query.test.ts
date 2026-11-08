import { describe, expect, it } from "vitest";
import { csvCell } from "./attendance-query.js";

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
});
