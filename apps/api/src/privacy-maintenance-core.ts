import { z } from "zod";
import { deletionLedgerSchema, visitDtoSchema, type DeletionLedger } from "@mame/contracts";
import { Prisma } from "./generated/prisma/client.js";
import type { Database } from "./db.js";
import { identityClock } from "./identity.js";

type Tx = Prisma.TransactionClient;
const transactionOptions = { maxWait: 30_000, timeout: 120_000 };
const fail = () => new Error("削除台帳の世代・対象環境・指示の整合性を確認できません。外部公開を停止してください。");

async function authorize(tx: Tx) {
  const rows = await tx.$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
  if (rows[0]?.role !== "mame_maintenance") throw new Error("保持・削除には専用の運用DB資格が必要です。");
}
async function lock(tx: Tx) {
  await authorize(tx);
  await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(47116)`;
  await tx.$queryRaw`SELECT id FROM "PrivacyState" WHERE id = 1 FOR UPDATE`;
  return tx.privacyState.findUniqueOrThrow({ where: { id: 1 } });
}
function ledgerRows(rows: Array<{ sequence: number; operationId: string; personId: string; requestedAt: Date }>) {
  return rows.map((row) => ({ sequence: row.sequence, operationId: row.operationId, personId: row.personId, requestedAt: row.requestedAt.toISOString() }));
}
function sameInstruction(left: DeletionLedger["instructions"][number], right: DeletionLedger["instructions"][number]) {
  return left.sequence === right.sequence && left.operationId === right.operationId && left.personId === right.personId && left.requestedAt === right.requestedAt;
}

export async function exportDeletionLedger(db: Database): Promise<DeletionLedger> {
  return db.$transaction(async (tx) => {
    const state = await lock(tx);
    return deletionLedgerSchema.parse({ format: 1, deploymentId: state.deploymentId, generation: state.generation,
      instructions: ledgerRows(await tx.deletionInstruction.findMany({ orderBy: { sequence: "asc" } })) });
  }, transactionOptions);
}

// 自由記載や未知の追加項目を残さず、確かめられた日時等の訂正情報だけを保持する。
export function cleanRevisionSnapshot(value: Prisma.JsonValue, personId: string, visitId: string, before = false): Prisma.InputJsonValue | null {
  if (before && value && !Array.isArray(value) && typeof value === "object" && value.state === "absent") return { state: "absent" };
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const filtered = Object.fromEntries(["id", "personId", "enteredAt", "exitedAt", "canceledAt", "version"].map((key) => [key, value[key]]));
  const result = visitDtoSchema.safeParse(filtered);
  return result.success && result.data.personId === personId && result.data.id === visitId ? result.data : null;
}

async function erasePerson(tx: Tx, instruction: DeletionLedger["instructions"][number], restoring: boolean) {
  await tx.$queryRaw`SELECT id FROM "Person" WHERE id = ${instruction.personId}::uuid FOR UPDATE`;
  const person = await tx.person.findUnique({ where: { id: instruction.personId } });
  const now = await identityClock(tx);
  if (person) {
    // 直近の退室と競合しても、個人情報削除が在室履歴を消す操作にはならない。
    if (!restoring && await tx.attendanceVisit.findFirst({ where: { personId: person.id, exitedAt: null, canceledAt: null }, select: { id: true } })) {
      throw new Error("未退室の記録があるため削除を保留しました。管理者が在室状態を確認してください。");
    }
    await tx.qrCredential.deleteMany({ where: { personId: person.id } });
    // 確定応答に複製した表示名も消す。過去の要求IDは再発行せず、再送を新規打刻にしない。
    await tx.attendanceRequest.deleteMany({ where: { personId: person.id } });
    let cursor: string | undefined;
    while (true) {
      const revisions = await tx.attendanceRevision.findMany({ where: { visit: { personId: person.id }, ...(cursor ? { id: { gt: cursor } } : {}) },
        orderBy: { id: "asc" }, take: 100 });
      for (const revision of revisions) {
        const before = cleanRevisionSnapshot(revision.before, person.id, revision.visitId, true);
        const after = cleanRevisionSnapshot(revision.after, person.id, revision.visitId);
        if (!before || !after) {
          // 説明できない古い形式を偽の訂正前後で置き換えず、内容ごと削除する。
          await tx.attendanceRevision.delete({ where: { id: revision.id } });
        } else {
          await tx.attendanceRevision.update({ where: { id: revision.id }, data: { reason: "個人情報削除に伴い訂正理由を削除", before, after } });
        }
      }
      if (revisions.length < 100) break;
      cursor = revisions[revisions.length - 1]!.id;
    }
    await tx.auditEvent.updateMany({ where: { OR: [{ personId: person.id }, { visit: { personId: person.id } },
      { details: { path: ["filters", "personId"], equals: person.id } }] }, data: { details: {} } });
    // 自由検索のハッシュは氏名等から推測でき、対象IDとの対応も保証できないため一律に消す。
    // 件数や日付等の非個人条件は残し、誰を検索したかの複製を削除後へ持ち越さない。
    await tx.$executeRaw`UPDATE "AuditEvent" SET details =
      jsonb_set(jsonb_set(details, '{filters,searchHash}', 'null'::jsonb, false), '{filters,affiliationHash}', 'null'::jsonb, false)
      WHERE details #> '{filters,searchHash}' <> 'null'::jsonb OR details #> '{filters,affiliationHash}' <> 'null'::jsonb`;
    if (person.status !== "DELETED" || person.displayName !== "削除済み利用者" || person.phoneticName || person.affiliation || person.code) {
      await tx.person.update({ where: { id: person.id }, data: { displayName: "削除済み利用者", phoneticName: null,
        affiliation: null, code: null, status: "DELETED", version: { increment: 1 } } });
    }
  }
  const previous = await tx.deletionProgress.findUnique({ where: { operationId: instruction.operationId } });
  await tx.deletionProgress.upsert({ where: { operationId: instruction.operationId },
    create: { operationId: instruction.operationId, completedAt: now, lastAttemptAt: now },
    update: { completedAt: previous?.completedAt ?? now, lastAttemptAt: now, errorCode: null } });
  if (!previous?.completedAt) await tx.auditEvent.create({ data: { action: "PERSON_DELETION_COMPLETED", actorType: "SYSTEM",
    ...(person ? { personId: person.id } : {}), details: { operationId: instruction.operationId, sequence: instruction.sequence } } });
}

export async function applyDeletionLedger(db: Database, input: unknown, restoring = false) {
  const ledger = deletionLedgerSchema.parse(input);
  return db.$transaction(async (tx) => {
    const state = await lock(tx);
    if (state.deploymentId !== ledger.deploymentId || (restoring && state.generation > ledger.generation)) throw fail();
    const existing = ledgerRows(await tx.deletionInstruction.findMany({ orderBy: { sequence: "asc" } }));
    // 接頭列の一致が外部最新保管の前提。古いDBから別の指示を作った分岐を検知する。
    if (existing.length !== state.generation || existing.some((row, index) => row.sequence !== index + 1)) throw fail();
    for (const local of existing) {
      const external = ledger.instructions[local.sequence - 1];
      if (external && !sameInstruction(local, external)) throw fail();
      if (!external && (restoring || local.sequence <= ledger.generation)) throw fail();
    }
    if (!restoring && ledger.generation > state.generation) throw fail();
    if (restoring) {
      for (const instruction of ledger.instructions.slice(existing.length)) {
        await tx.deletionInstruction.create({ data: { ...instruction, requestedAt: new Date(instruction.requestedAt) } });
      }
      if (state.generation !== ledger.generation) await tx.privacyState.update({ where: { id: 1 }, data: { generation: ledger.generation } });
    }
    let processed = 0;
    for (const instruction of ledger.instructions) {
      const progress = await tx.deletionProgress.findUnique({ where: { operationId: instruction.operationId } });
      if (restoring || !progress?.completedAt) { await erasePerson(tx, instruction, restoring); processed++; }
    }
    return { generation: ledger.generation, processed, pending: Math.max(0, state.generation - ledger.generation) };
  }, transactionOptions);
}

export async function runRetention(db: Database) {
  return db.$transaction(async (tx) => {
    await lock(tx);
    await tx.$queryRaw`SELECT id FROM "RetentionPolicy" WHERE id = 1 FOR UPDATE`;
    const policy = await tx.retentionPolicy.findUniqueOrThrow({ where: { id: 1 } }), now = await identityClock(tx);
    const cutoff = new Date(now.getTime() - policy.days * 86_400_000);
    // 訂正と同じ親行のロックを取り、候補取得後に在室へ戻った記録を削除しない。
    await tx.$queryRaw`SELECT p.id FROM "Person" p WHERE EXISTS (
      SELECT 1 FROM "AttendanceVisit" v WHERE v."personId" = p.id AND
      (v."canceledAt" < ${cutoff} OR (v."canceledAt" IS NULL AND v."exitedAt" < ${cutoff}))) ORDER BY p.id FOR UPDATE`;
    const completed = { OR: [{ canceledAt: { lt: cutoff } }, { canceledAt: null, exitedAt: { lt: cutoff } }] };
    const revisions = await tx.attendanceRevision.deleteMany({ where: { visit: completed } });
    const visits = await tx.attendanceVisit.deleteMany({ where: completed });
    const auditEvents = await tx.auditEvent.deleteMany({ where: { createdAt: { lt: cutoff } } });
    const requests = await tx.attendanceRequest.deleteMany({ where: { resultUntil: { lte: now } } });
    await tx.retentionPolicy.update({ where: { id: 1 }, data: { lastRunAt: now, lastDeletedVisits: visits.count, lastDeletedAuditEvents: auditEvents.count } });
    await tx.auditEvent.create({ data: { action: "RETENTION_COMPLETED", actorType: "SYSTEM", details: {
      days: policy.days, cutoff: cutoff.toISOString(), visits: visits.count, revisions: revisions.count, auditEvents: auditEvents.count, requests: requests.count } } });
    return { visits: visits.count, revisions: revisions.count, auditEvents: auditEvents.count, requests: requests.count, cutoff: cutoff.toISOString() };
  }, transactionOptions);
}

export async function restoreSecurity(db: Database) {
  return db.$transaction(async (tx) => {
    await lock(tx);
    const pending = await tx.deletionInstruction.count({ where: { OR: [{ progress: null }, { progress: { completedAt: null } }] } });
    if (pending) throw new Error("未完了の削除指示があります。最新台帳を再適用してから認証を復旧してください。");
    const now = await identityClock(tx);
    // 古いバックアップの資格を復活させない。管理者はホストの復旧手順で本人を確認して再登録する。
    await tx.session.deleteMany(); await tx.passkey.deleteMany(); await tx.recoveryCode.deleteMany();
    await tx.registrationAttempt.deleteMany(); await tx.setupAttempt.deleteMany(); await tx.adminInvitation.deleteMany();
    await tx.verification.deleteMany(); await tx.receptionApplication.deleteMany(); await tx.qrCredential.deleteMany();
    await tx.receptionCredential.updateMany({ data: { revokedAt: now } });
    await tx.receptionDevice.updateMany({ data: { status: "REVOKED", revokedAt: now } });
    await tx.setupState.updateMany({ data: { codeHash: null, expiresAt: null } });
    await tx.auditEvent.create({ data: { action: "RESTORE_CREDENTIALS_REVOKED", actorType: "SYSTEM" } });
    return { revoked: true };
  }, transactionOptions);
}

const backupRecordSchema = z.object({ completedAt: z.iso.datetime(), retentionDays: z.number().int().min(1).max(3650) }).strict();
export async function recordBackup(db: Database, input: unknown) {
  const data = backupRecordSchema.parse(input);
  return db.$transaction(async (tx) => {
    await lock(tx);
    const now = await identityClock(tx), completedAt = new Date(data.completedAt);
    if (completedAt > now || now.getTime() - completedAt.getTime() > 86_400_000) throw new Error("バックアップ結果の日時を確認してください。");
    const state = await tx.privacyState.findUniqueOrThrow({ where: { id: 1 } });
    if (state.lastBackupAt && state.lastBackupAt > completedAt) throw new Error("新しいバックアップ結果を古い結果で上書きできません。");
    await tx.privacyState.update({ where: { id: 1 }, data: { lastBackupAt: completedAt, backupExternalConfirmed: true } });
    await tx.retentionPolicy.update({ where: { id: 1 }, data: { backupRetentionDays: data.retentionDays } });
    await tx.auditEvent.create({ data: { action: "BACKUP_EXTERNAL_CONFIRMED", actorType: "SYSTEM", details: { completedAt: data.completedAt, retentionDays: data.retentionDays } } });
    return { recorded: true };
  }, transactionOptions);
}

export async function recordPrivacyFailure(db: Database, input: unknown) {
  const parsed = z.object({ errorCode: z.enum(["EXTERNAL_STORAGE_UNAVAILABLE", "ERASURE_FAILED"]) }).strict().parse(input);
  return db.$transaction(async (tx) => {
    await lock(tx);
    const pending = await tx.deletionInstruction.findMany({ where: { OR: [{ progress: null }, { progress: { completedAt: null } }] }, select: { operationId: true } });
    const now = await identityClock(tx);
    for (const { operationId } of pending) await tx.deletionProgress.upsert({ where: { operationId },
      create: { operationId, lastAttemptAt: now, errorCode: parsed.errorCode }, update: { lastAttemptAt: now, errorCode: parsed.errorCode } });
    return { pending: pending.length };
  }, transactionOptions);
}
