import { afterAll, describe, expect, it } from "vitest";
import { createHmac, randomUUID } from "node:crypto";
import { deletionLedgerSchema, diagnosticsResponseSchema, privacyResponseSchema } from "@mame/contracts";
import { createDatabase, type Database } from "../../apps/api/src/db.js";
import { loadConfig, readSecret } from "../../apps/api/src/config.js";
import { createApp } from "../../apps/api/src/app.js";
import { newToken, hash } from "../../apps/api/src/setup.js";
import { createPerson, issuePersonQr, setPersonStatus, updatePerson } from "../../apps/api/src/people.js";
import { correctAttendanceVisit } from "../../apps/api/src/attendance.js";
import { getPrivacy, previewDeletion, previewRetention, requestDeletion, updateRetention } from "../../apps/api/src/privacy.js";
import {
  applyDeletionLedger, exportDeletionLedger, recordBackup, recordPrivacyFailure, restoreSecurity, runRetention,
} from "../../apps/api/src/privacy-maintenance-core.js";

// 本番資格や実在の利用者を扱わず、専用Composeの架空データだけで権限と復元を試験する。
if (!/^mame-inout-test(?:-|$)/.test(process.env.TEST_PROJECT ?? "")) throw new Error("独立したテスト用Composeプロジェクトが必要です。");
const config = loadConfig(), db = createDatabase(config), app = createApp(db, config);
const maintenance = createDatabase({ ...config, secret: "", database: { ...config.database, user: "mame_maintenance",
  password: readSecret(process.env.DB_MAINTENANCE_PASSWORD_FILE ?? "/run/secrets/db_maintenance_password") } });
const users: string[] = [];
// 試行制限の対象を別の検査ファイルと共用せず、拒否系を増やしても他の認可検査を妨げない。
const fixtureIp = `privacy-integration-${randomUUID()}`;
afterAll(async () => {
  await maintenance.retentionPolicy.update({ where: { id: 1 }, data: { days: 365 } });
  await db.user.deleteMany({ where: { id: { in: users } } });
  await db.$disconnect(); await maintenance.$disconnect();
});

async function admin(recent = true, role = "ADMIN") {
  const user = await db.user.create({ data: { id: randomUUID(), name: "保存検証の管理者", email: `${randomUUID()}@example.test`, role } });
  users.push(user.id);
  const token = newToken();
  const session = await db.session.create({ data: { id: randomUUID(), userId: user.id, token, expiresAt: new Date(Date.now() + 600_000),
    authenticatedAt: new Date(Date.now() - (recent ? 0 : 360_000)) } });
  const signature = createHmac("sha256", config.secret).update(token).digest("base64");
  return { actor: { userId: user.id, sessionId: session.id }, cookie: `${config.secure ? "__Secure-" : ""}better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}` };
}
async function person(actor: Awaited<ReturnType<typeof admin>>["actor"]) {
  return createPerson(db, actor, { displayName: `消去検証-${randomUUID()}`, phoneticName: "よみがな", affiliation: "削除対象の所属", code: randomUUID() });
}
async function visit(personId: string, exitedAt: Date | null = new Date("2024-01-01T01:00:00Z"), enteredAt = new Date("2024-01-01T00:00:00Z"), canceledAt?: Date) {
  return db.attendanceVisit.create({ data: { personId, enteredAt, exitedAt, ...(canceledAt ? { canceledAt } : {}) } });
}
async function intent(actor: Awaited<ReturnType<typeof admin>>["actor"]) {
  const target = await person(actor), operationId = randomUUID();
  const result = await requestDeletion(db, actor, target.id, { operationId, expectedVersion: target.version });
  return { target, result };
}
function api(path: string, cookie?: string, body?: unknown, method = body === undefined ? "GET" : "POST", origin = config.origin) {
  return app.request(path, { method, headers: { origin, "X-Mame-Client-IP": fixtureIp, ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function errorCode(action: () => Promise<unknown>) {
  try { await action(); return null; } catch (cause) { return (cause as { code?: unknown }).code ?? "ERROR"; }
}

describe("保存期間の確認と権限", () => {
  it("未認証・受付・権限違いで保存設定と診断を取得できない", async () => {
    const outsider = await admin(true, "RECEPTION");
    for (const path of ["/api/admin/privacy", "/api/admin/diagnostics"]) {
      expect((await api(path)).status).toBe(401);
      expect((await api(path, outsider.cookie)).status).toBe(403);
    }
  });
  it("保持設定・保留・診断を実行時スキーマで返し、秘密・台帳識別子を含めない", async () => {
    const manager = await admin();
    const privacy = await api("/api/admin/privacy", manager.cookie);
    expect(privacy.status).toBe(200); privacyResponseSchema.parse(await privacy.json());
    const response = await api("/api/admin/diagnostics", manager.cookie), value = await response.json();
    const result = diagnosticsResponseSchema.parse(value);
    expect(result.origin).toBe(config.origin); expect(result.database).toBe("connected");
    expect(result.passkey).toEqual({ rpId: config.rpID, userVerification: "required" });
    expect(response.headers.get("cache-control")).toBe("no-store");
    const serialized = JSON.stringify(value);
    expect(serialized.includes(config.secret)).toBe(false); expect(serialized.includes(config.database.password)).toBe(false);
    expect(serialized.includes("deploymentId")).toBe(false); expect(serialized.includes("db_maintenance_password")).toBe(false);
  });
  it("プレビューは終了・取消済みを対象にし、未退室を保護する", async () => {
    const manager = await admin(), target = await person(manager.actor);
    await visit(target.id); await visit(target.id, null);
    await visit(target.id, null, new Date("2023-01-01T00:00:00Z"), new Date("2023-01-02T00:00:00Z"));
    const preview = await previewRetention(db, manager.actor, { days: 365 }, config.secret);
    expect(preview.visits).toBeGreaterThanOrEqual(2); expect(preview.openVisits).toBeGreaterThanOrEqual(1);
    expect(preview.confirmationToken.length).toBeGreaterThan(20);
  });
  it("保存期間は1〜3650日を受理し、範囲外・追加項目を拒否する", async () => {
    const manager = await admin();
    for (const days of [0, -1, 3651, 1.5]) expect((await api("/api/admin/privacy/retention-preview", manager.cookie, { days })).status).toBe(422);
    expect((await api("/api/admin/privacy/retention-preview", manager.cookie, { days: 1, unsafe: true })).status).toBe(422);
    for (const days of [1, 3650]) expect((await api("/api/admin/privacy/retention-preview", manager.cookie, { days })).status).toBe(200);
  });
  it("期間短縮の保存は再認証を要求する", async () => {
    const manager = await admin(false), preview = await previewRetention(db, manager.actor, { days: 30 }, config.secret);
    const response = await api("/api/admin/privacy/retention", manager.cookie, { days: 30, expectedVersion: preview.expectedVersion, confirmationToken: preview.confirmationToken }, "PUT");
    expect(response.status).toBe(403); expect((await response.json() as { code: string }).code).toBe("REAUTH_REQUIRED");
  });
  it("確認トークンの改変・別管理者による流用を拒否する", async () => {
    const manager = await admin(), other = await admin(), preview = await previewRetention(db, manager.actor, { days: 364 }, config.secret);
    const data = { days: 364, expectedVersion: preview.expectedVersion, confirmationToken: preview.confirmationToken };
    expect(await errorCode(() => updateRetention(db, other.actor, data, config.secret))).toBe("PREVIEW_EXPIRED");
    expect(await errorCode(() => updateRetention(db, manager.actor, { ...data, confirmationToken: `X${data.confirmationToken}` }, config.secret))).toBe("PREVIEW_EXPIRED");
    expect(await errorCode(() => updateRetention(db, manager.actor, { ...data, days: 363 }, config.secret))).toBe("PREVIEW_EXPIRED");
  });
  it("確認後の対象増減を拒否し、新しい確認で日数と監査を同時に保存する", async () => {
    const manager = await admin(), target = await person(manager.actor), preview = await previewRetention(db, manager.actor, { days: 360 }, config.secret);
    await visit(target.id);
    expect(await errorCode(() => updateRetention(db, manager.actor, { days: 360, expectedVersion: preview.expectedVersion, confirmationToken: preview.confirmationToken }, config.secret))).toBe("PREVIEW_EXPIRED");
    const refreshed = await previewRetention(db, manager.actor, { days: 360 }, config.secret);
    const saved = await updateRetention(db, manager.actor, { days: 360, expectedVersion: refreshed.expectedVersion, confirmationToken: refreshed.confirmationToken }, config.secret);
    expect(saved.retention.days).toBe(360); expect(saved.retention.version).toBe(refreshed.expectedVersion + 1);
    expect(await db.auditEvent.count({ where: { action: "RETENTION_UPDATED", actorUserId: manager.actor.userId } })).toBe(1);
  });
  it("古い設定版の確認を拒否する", async () => {
    const manager = await admin(), first = await previewRetention(db, manager.actor, { days: 350 }, config.secret);
    const second = await previewRetention(db, manager.actor, { days: 351 }, config.secret);
    await updateRetention(db, manager.actor, { days: 350, expectedVersion: first.expectedVersion, confirmationToken: first.confirmationToken }, config.secret);
    expect(await errorCode(() => updateRetention(db, manager.actor, { days: 351, expectedVersion: second.expectedVersion, confirmationToken: second.confirmationToken }, config.secret))).toBe("VERSION_CONFLICT");
  });
});

describe("外部保管前の削除保留", () => {
  it("削除プレビューで対象と残る履歴件数を確認でき、在室中は申請できない", async () => {
    const manager = await admin(), target = await person(manager.actor);
    await visit(target.id, null);
    const preview = await previewDeletion(db, manager.actor, target.id);
    expect(preview.displayName).toBe(target.displayName); expect(preview.openVisits).toBe(1); expect(preview.visits).toBe(1);
    expect(await errorCode(() => requestDeletion(db, manager.actor, target.id, { operationId: randomUUID(), expectedVersion: target.version }))).toBe("PERSON_INSIDE");
    expect(await db.deletionInstruction.findUnique({ where: { personId: target.id } })).toBeNull();
  });
  it("申請直後は保留として氏名を保持し、QR失効・利用停止だけを確定する", async () => {
    const manager = await admin(), target = await person(manager.actor), issued = await issuePersonQr(db, manager.actor, target.id, { expectedVersion: target.version });
    const response = await api(`/api/admin/people/${target.id}/deletion`, manager.cookie, { operationId: randomUUID(), expectedVersion: issued.version });
    expect(response.status).toBe(202); const result = await response.json() as { state: string; completedAt: string | null };
    expect(result.state).toBe("PENDING"); expect(result.completedAt).toBeNull();
    const stored = await db.person.findUniqueOrThrow({ where: { id: target.id } });
    expect(stored.status).toBe("SUSPENDED"); expect(stored.displayName).toBe(target.displayName);
    expect(await db.qrCredential.count({ where: { personId: target.id, revokedAt: null } })).toBe(0);
  });
  it("保留中の編集・再開・記録訂正を禁止する", async () => {
    const manager = await admin(), target = await person(manager.actor), recorded = await visit(target.id);
    await requestDeletion(db, manager.actor, target.id, { operationId: randomUUID(), expectedVersion: target.version });
    const stored = await db.person.findUniqueOrThrow({ where: { id: target.id } });
    expect(await errorCode(() => setPersonStatus(db, manager.actor, target.id, { expectedVersion: stored.version, status: "ACTIVE" }))).toBe("DELETION_PENDING");
    expect(await errorCode(() => updatePerson(db, manager.actor, target.id, { displayName: "変更後", expectedVersion: stored.version }))).toBe("DELETION_PENDING");
    expect(await errorCode(() => correctAttendanceVisit(db, manager.actor, { visitId: recorded.id, expectedVersion: recorded.version, enteredAt: recorded.enteredAt.toISOString(),
      exitedAt: recorded.exitedAt!.toISOString(), cancel: false, reason: "変更" }))).toBe("PERSON_UNAVAILABLE");
  });
  it("同じ要求の再試行は最初の指示を返し、別対象や二重指示を拒否する", async () => {
    const manager = await admin(), { target, result } = await intent(manager.actor), other = await person(manager.actor);
    expect(await requestDeletion(db, manager.actor, target.id, { operationId: result.operationId, expectedVersion: target.version })).toEqual(result);
    expect(await errorCode(() => requestDeletion(db, manager.actor, other.id, { operationId: result.operationId, expectedVersion: other.version }))).toBe("REQUEST_CONFLICT");
    expect(await errorCode(() => requestDeletion(db, manager.actor, target.id, { operationId: randomUUID(), expectedVersion: target.version }))).toBe("DELETION_PENDING");
    expect(await errorCode(() => previewDeletion(db, manager.actor, target.id))).toBe("DELETION_PENDING");
  });
  it("同時削除申請でも世代の欠番・二重指示を作らない", async () => {
    const left = await admin(), right = await admin(), target = await person(left.actor), operationId = randomUUID();
    const requests = await Promise.all([left, right].map((manager) => requestDeletion(db, manager.actor, target.id, { operationId, expectedVersion: target.version })));
    expect(requests[0]).toEqual(requests[1]);
    deletionLedgerSchema.parse(await exportDeletionLedger(maintenance));
    expect(await db.deletionInstruction.count({ where: { personId: target.id } })).toBe(1);
  });
  it("再認証・正しいOrigin・古い利用者版をサーバーで検証する", async () => {
    const manager = await admin(false), target = await person(manager.actor), input = { operationId: randomUUID(), expectedVersion: target.version };
    expect((await api(`/api/admin/people/${target.id}/deletion`, manager.cookie, input)).status).toBe(403);
    const fresh = await admin();
    expect((await api(`/api/admin/people/${target.id}/deletion`, fresh.cookie, input, "POST", "https://other.example")).status).toBe(403);
    expect(await errorCode(() => requestDeletion(db, fresh.actor, target.id, { ...input, expectedVersion: target.version + 1 }))).toBe("VERSION_CONFLICT");
  });
  it("監査保存の失敗で指示・世代・利用停止をまとめて取り消す", async () => {
    const manager = await admin(), target = await person(manager.actor), before = await db.privacyState.findUniqueOrThrow({ where: { id: 1 } });
    const failing = db.$extends({ query: { auditEvent: { async create() { throw new Error("監査失敗を試験します。"); } } } }) as unknown as Database;
    await expect(requestDeletion(failing, manager.actor, target.id, { operationId: randomUUID(), expectedVersion: target.version })).rejects.toThrow();
    expect((await db.privacyState.findUniqueOrThrow({ where: { id: 1 } })).generation).toBe(before.generation);
    expect((await db.person.findUniqueOrThrow({ where: { id: target.id } })).status).toBe("ACTIVE");
    expect(await db.deletionInstruction.findUnique({ where: { personId: target.id } })).toBeNull();
  });
});

describe("専用権限による台帳再適用と保持処理", () => {
  it("通常APIに指示変更・削除確定・監査訂正・DDL権限を与えない", async () => {
    await expect(exportDeletionLedger(db)).rejects.toThrow("専用");
    for (const sql of ['UPDATE "DeletionInstruction" SET sequence = sequence WHERE false', 'DELETE FROM "DeletionInstruction" WHERE false',
      'UPDATE "DeletionProgress" SET "completedAt" = now() WHERE false', 'UPDATE "AttendanceRevision" SET reason = reason WHERE false',
      'DELETE FROM "AttendanceRevision" WHERE false', 'UPDATE "AuditEvent" SET details = details WHERE false',
      'UPDATE "PrivacyState" SET "deploymentId" = "deploymentId" WHERE false', 'CREATE TABLE privacy_forbidden (id int)']) {
      await expect(db.$executeRawUnsafe(sql)).rejects.toThrow();
    }
    await expect(maintenance.$executeRawUnsafe('CREATE TABLE privacy_maintenance_forbidden (id int)')).rejects.toThrow();
    await expect(maintenance.$executeRawUnsafe('DELETE FROM "SchemaMigration" WHERE false')).rejects.toThrow();
  });
  it("外部保管失敗を保留で記録し、個人情報の消去は進めない", async () => {
    const manager = await admin(), { target, result } = await intent(manager.actor);
    await recordPrivacyFailure(maintenance, { errorCode: "EXTERNAL_STORAGE_UNAVAILABLE" });
    const status = (await getPrivacy(db, manager.actor)).deletions.find((row) => row.operationId === result.operationId)!;
    expect(status.state).toBe("PENDING"); expect(status.errorCode).toBe("EXTERNAL_STORAGE_UNAVAILABLE");
    expect((await db.person.findUniqueOrThrow({ where: { id: target.id } })).displayName).toBe(target.displayName);
  });
  it("外部保管済みの指示に従い関連データを消去し、完了後の再試行も同じ結果を返す", async () => {
    const manager = await admin(), target = await person(manager.actor), recorded = await visit(target.id);
    const snapshot = { id: recorded.id, personId: target.id, enteredAt: recorded.enteredAt.toISOString(), exitedAt: recorded.exitedAt!.toISOString(), canceledAt: null, version: recorded.version };
    await db.attendanceRevision.create({ data: { visitId: recorded.id, actorUserId: manager.actor.userId, reason: target.displayName,
      before: { ...snapshot, duplicatedName: target.displayName }, after: { ...snapshot, duplicatedCode: target.code } } });
    const searchAudit = await db.auditEvent.create({ data: { action: "ATTENDANCE_CSV_EXPORTED", actorType: "ADMIN", actorUserId: manager.actor.userId,
      details: { count: 1, filters: { searchHash: hash(target.displayName), affiliationHash: hash(target.affiliation!), from: "2024-01-01" } } } });
    const device = await db.receptionDevice.create({ data: { name: "個人情報の複製試験", status: "PENDING" } });
    const issuedAt = new Date(), acceptUntil = new Date(issuedAt.getTime() + 60_000), resultUntil = new Date(issuedAt.getTime() + 600_000);
    const receipt = await db.attendanceRequest.create({ data: { deviceId: device.id, personId: target.id, issuedAt, acceptUntil, resultUntil,
      payloadHash: hash(newToken()), completedAt: issuedAt, httpStatus: 200, response: { person: { displayName: target.displayName } } } });
    const qr = await issuePersonQr(db, manager.actor, target.id, { expectedVersion: target.version });
    const request = await requestDeletion(db, manager.actor, target.id, { operationId: randomUUID(), expectedVersion: qr.version });
    const ledger = await exportDeletionLedger(maintenance);
    expect(JSON.stringify(ledger).includes(target.displayName)).toBe(false); expect(JSON.stringify(ledger).includes(qr.qr)).toBe(false);
    await applyDeletionLedger(maintenance, ledger);
    const deleted = await db.person.findUniqueOrThrow({ where: { id: target.id } });
    expect([deleted.displayName, deleted.phoneticName, deleted.affiliation, deleted.code, deleted.status]).toEqual(["削除済み利用者", null, null, null, "DELETED"]);
    expect(await db.qrCredential.count({ where: { personId: target.id } })).toBe(0);
    expect(await db.attendanceRequest.findUnique({ where: { id: receipt.id } })).toBeNull();
    expect((await db.auditEvent.findUniqueOrThrow({ where: { id: searchAudit.id } })).details).toEqual({ count: 1,
      filters: { searchHash: null, affiliationHash: null, from: "2024-01-01" } });
    const revision = await db.attendanceRevision.findFirstOrThrow({ where: { visitId: recorded.id } });
    expect(revision.before).toEqual(snapshot); expect(revision.after).toEqual(snapshot); expect(revision.reason).not.toContain(target.displayName);
    const response = await requestDeletion(db, manager.actor, target.id, { operationId: request.operationId, expectedVersion: target.version });
    expect(response.state).toBe("COMPLETED"); expect(response.errorCode).toBeNull();
    expect(await errorCode(() => previewDeletion(db, manager.actor, target.id))).toBe("PERSON_UNAVAILABLE");
    expect((await applyDeletionLedger(maintenance, ledger)).processed).toBe(0);
  });
  it("外部台帳の対象環境・分岐・欠番を拒否し、消去を確定しない", async () => {
    const manager = await admin(), { target } = await intent(manager.actor), ledger = await exportDeletionLedger(maintenance);
    await expect(applyDeletionLedger(maintenance, { ...ledger, deploymentId: randomUUID() })).rejects.toThrow();
    await expect(applyDeletionLedger(maintenance, { ...ledger, instructions: ledger.instructions.slice(1) })).rejects.toThrow();
    const forked = structuredClone(ledger); forked.instructions[forked.instructions.length - 1]!.personId = randomUUID();
    await expect(applyDeletionLedger(maintenance, forked)).rejects.toThrow();
    expect((await db.person.findUniqueOrThrow({ where: { id: target.id } })).status).toBe("SUSPENDED");
  });
  it("書出し後に増えた指示は完了扱いせず保留に残す", async () => {
    const manager = await admin(); await intent(manager.actor);
    const ledger = await exportDeletionLedger(maintenance), newer = await intent(manager.actor);
    const applied = await applyDeletionLedger(maintenance, ledger);
    expect(applied.pending).toBe(1);
    expect((await getPrivacy(db, manager.actor)).deletions.find((item) => item.operationId === newer.result.operationId)!.state).toBe("PENDING");
    expect((await db.person.findUniqueOrThrow({ where: { id: newer.target.id } })).displayName).toBe(newer.target.displayName);
  });
  it("消去途中のDB失敗をロールバックし、同じ外部台帳から再開する", async () => {
    const manager = await admin(), { target } = await intent(manager.actor), ledger = await exportDeletionLedger(maintenance);
    const failing = maintenance.$extends({ query: { person: { async update() { throw new Error("消去途中の失敗を試験します。"); } } } }) as unknown as Database;
    await expect(applyDeletionLedger(failing, ledger)).rejects.toThrow();
    expect((await db.person.findUniqueOrThrow({ where: { id: target.id } })).status).toBe("SUSPENDED");
    await applyDeletionLedger(maintenance, ledger);
    expect((await db.person.findUniqueOrThrow({ where: { id: target.id } })).status).toBe("DELETED");
  });
  it("復元時は古い台帳を拒否し、DBにまだない最新指示を取り込んで再消去する", async () => {
    const manager = await admin(), old = await exportDeletionLedger(maintenance), target = await person(manager.actor);
    const open = await visit(target.id, null);
    const current = await exportDeletionLedger(maintenance), operationId = randomUUID();
    const latest = { ...current, generation: current.generation + 1, instructions: [...current.instructions,
      { operationId, personId: target.id, sequence: current.generation + 1, requestedAt: new Date().toISOString() }] };
    await applyDeletionLedger(maintenance, latest, true);
    expect((await db.person.findUniqueOrThrow({ where: { id: target.id } })).status).toBe("DELETED");
    expect((await db.attendanceVisit.findUniqueOrThrow({ where: { id: open.id } })).exitedAt).toBeNull();
    const correction = { visitId: open.id, expectedVersion: open.version, enteredAt: open.enteredAt.toISOString(),
      exitedAt: null, cancel: false, reason: target.displayName };
    expect(await errorCode(() => correctAttendanceVisit(db, manager.actor, correction))).toBe("PERSON_UNAVAILABLE");
    await correctAttendanceVisit(db, manager.actor, { ...correction, exitedAt: "2024-01-01T01:00:00.000Z" });
    const revision = await db.attendanceRevision.findFirstOrThrow({ where: { visitId: open.id } });
    expect(revision.reason).toBe("削除済み利用者の記録を確認して訂正");
    expect(JSON.stringify(revision).includes(target.displayName)).toBe(false);
    expect(await db.deletionInstruction.findUnique({ where: { operationId } })).not.toBeNull();
    await expect(applyDeletionLedger(maintenance, old, true)).rejects.toThrow();
    expect((await exportDeletionLedger(maintenance)).generation).toBe(latest.generation);
  });
  it("保持処理は終了済みだけを削除し、長期未退室・最近の退室を保持する", async () => {
    const manager = await admin(), target = await person(manager.actor);
    const old = await visit(target.id), open = await visit(target.id, null, new Date("2022-01-01T00:00:00Z"));
    const recent = await visit(target.id, new Date(), new Date(Date.now() - 1000));
    await db.attendanceRevision.create({ data: { visitId: old.id, reason: "保持期限の対象", before: {}, after: {} } });
    await db.auditEvent.create({ data: { action: "RETENTION_FIXTURE", actorType: "SYSTEM", personId: target.id, createdAt: new Date("2020-01-01T00:00:00Z") } });
    const result = await runRetention(maintenance);
    expect(result.visits).toBeGreaterThan(0); expect(result.revisions).toBeGreaterThan(0);
    expect(await db.attendanceVisit.findUnique({ where: { id: old.id } })).toBeNull();
    expect(await db.attendanceVisit.findUnique({ where: { id: open.id } })).not.toBeNull();
    expect(await db.attendanceVisit.findUnique({ where: { id: recent.id } })).not.toBeNull();
    expect(await db.auditEvent.count({ where: { action: "RETENTION_FIXTURE", personId: target.id } })).toBe(0);
    expect((await runRetention(maintenance)).visits).toBe(0);
  });
  it("保持処理の途中失敗で履歴・訂正履歴・実行結果を取り消す", async () => {
    const manager = await admin(), target = await person(manager.actor), old = await visit(target.id);
    const revision = await db.attendanceRevision.create({ data: { visitId: old.id, reason: "途中失敗", before: {}, after: {} } });
    const failing = maintenance.$extends({ query: { attendanceVisit: { async deleteMany() { throw new Error("期限削除の途中失敗を試験します。"); } } } }) as unknown as Database;
    await expect(runRetention(failing)).rejects.toThrow();
    expect(await db.attendanceVisit.findUnique({ where: { id: old.id } })).not.toBeNull();
    expect(await db.attendanceRevision.findUnique({ where: { id: revision.id } })).not.toBeNull();
  });
  it("外部保管の成功記録だけが診断へ反映され、未来・古い成功結果を拒否する", async () => {
    const manager = await admin(), completedAt = new Date(Date.now() - 500).toISOString();
    await recordBackup(maintenance, { completedAt, retentionDays: 30 });
    const response = await api("/api/admin/diagnostics", manager.cookie), diagnostics = diagnosticsResponseSchema.parse(await response.json());
    expect(diagnostics.backup).toEqual({ lastCompletedAt: completedAt, externalConfirmed: true, retentionDays: 30 });
    await expect(recordBackup(maintenance, { completedAt: new Date(Date.now() + 60_000).toISOString(), retentionDays: 30 })).rejects.toThrow();
    await expect(recordBackup(maintenance, { completedAt: new Date(Date.now() - 172_800_000).toISOString(), retentionDays: 30 })).rejects.toThrow();
  });
  it("復元安全化前に未完了の削除を拒否し、再適用後は全旧資格を失効する", async () => {
    const manager = await admin(); await intent(manager.actor);
    await expect(restoreSecurity(maintenance)).rejects.toThrow("未完了");
    await applyDeletionLedger(maintenance, await exportDeletionLedger(maintenance), true);
    const device = await db.receptionDevice.create({ data: { name: "復元前端末", status: "APPROVED", approvedAt: new Date(), expiresAt: new Date(Date.now() + 600_000) } });
    await db.receptionCredential.create({ data: { deviceId: device.id, tokenHash: hash(newToken()), expiresAt: new Date(Date.now() + 600_000) } });
    await db.recoveryCode.create({ data: { codeHash: hash(newToken()), userId: manager.actor.userId } });
    await restoreSecurity(maintenance);
    expect(await db.session.count()).toBe(0); expect(await db.passkey.count()).toBe(0); expect(await db.recoveryCode.count()).toBe(0);
    expect(await db.qrCredential.count()).toBe(0);
    expect((await db.receptionDevice.findUniqueOrThrow({ where: { id: device.id } })).status).toBe("REVOKED");
    expect(await db.receptionCredential.count({ where: { revokedAt: null } })).toBe(0);
  });
});
