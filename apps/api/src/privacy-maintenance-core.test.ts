import { describe, expect, it } from "vitest";
import { deletionLedgerSchema } from "@mame/contracts";
import { cleanRevisionSnapshot } from "./privacy-maintenance-core.js";

const personId = "91bcbce9-d3ac-44ad-b52c-aad8e753b95e", visitId = "5216aecd-7f70-45ef-aab2-1cacdf624bf5";
describe("復元用削除台帳と訂正情報の消去", () => {
  it("台帳には対象ID・指示時刻だけを認め、個人情報や欠番を拒否する", () => {
    const base = { format: 1, deploymentId: personId, generation: 1,
      instructions: [{ sequence: 1, operationId: visitId, personId, requestedAt: "2026-01-01T00:00:00.000Z" }] };
    expect(deletionLedgerSchema.safeParse(base).success).toBe(true);
    expect(deletionLedgerSchema.safeParse({ ...base, instructions: [{ ...base.instructions[0], name: "氏名" }] }).success).toBe(false);
    expect(deletionLedgerSchema.safeParse({ ...base, generation: 2 }).success).toBe(false);
    expect(deletionLedgerSchema.safeParse({ ...base, instructions: [{ ...base.instructions[0], sequence: 2 }] }).success).toBe(false);
  });
  it("正しい日時の前後情報だけを残し、複製された氏名・コードを除去する", () => {
    const snapshot = { id: visitId, personId, enteredAt: "2026-01-01T00:00:00.000Z", exitedAt: null, canceledAt: null, version: 1 };
    expect(cleanRevisionSnapshot({ ...snapshot, displayName: "削除する名前", qr: "保存禁止のQR" }, personId, visitId)).toEqual(snapshot);
    expect(cleanRevisionSnapshot({ state: "absent", name: "削除する名前" }, personId, visitId, true)).toEqual({ state: "absent" });
  });
  it("説明できない古い形式を架空の前後情報に置き換えない", () => {
    expect(cleanRevisionSnapshot({ name: "古い名前" }, personId, visitId)).toBeNull();
    expect(cleanRevisionSnapshot(null, personId, visitId)).toBeNull();
    expect(cleanRevisionSnapshot({ state: "absent" }, personId, visitId)).toBeNull();
  });
});
