import { createHmac, timingSafeEqual } from "node:crypto";
import { statfs } from "node:fs/promises";
import {
  deletionInputSchema, deletionPreviewSchema, deletionStatusSchema, privacyResponseSchema, diagnosticsResponseSchema,
  retentionPreviewInputSchema, retentionPreviewSchema, retentionUpdateInputSchema,
  type DeletionInput, type DeletionStatus, type RetentionUpdateInput,
} from "@mame/contracts";
import { z } from "zod";
import type { Prisma } from "./generated/prisma/client.js";
import type { Database } from "./db.js";
import type { Config } from "./config.js";
import { AttendanceError } from "./attendance-rules.js";
import { assertAdministrator, identityClock, type AdminActor } from "./identity.js";

type Tx = Prisma.TransactionClient;
const transactionOptions = { maxWait: 15_000, timeout: 15_000 };
const missing = () => new AttendanceError("PERSON_NOT_FOUND", 404, "対象の利用者が見つかりません。");
const conflict = () => new AttendanceError("VERSION_CONFLICT", 409, "ほかの操作で変更されています。表示を更新してから、もう一度確認してください。");
const expired = () => new AttendanceError("PREVIEW_EXPIRED", 409, "削除予定の確認内容が変わったか、5分が過ぎました。対象件数をもう一度確認してください。");
const invalid = () => new AttendanceError("INVALID_INPUT", 422, "保存日数と確認内容を確認してください。");
const uuid = z.uuid();

export async function retentionCounts(tx: Tx, cutoff: Date) {
  // 期限だけでは未退室を消さない。取消済みは取消時刻、退室済みは退室時刻から数える。
  const completed = { OR: [{ canceledAt: { lt: cutoff } }, { canceledAt: null, exitedAt: { lt: cutoff } }] };
  const [visits, revisions, auditEvents, openVisits] = await Promise.all([
    tx.attendanceVisit.count({ where: completed }),
    tx.attendanceRevision.count({ where: { visit: completed } }),
    tx.auditEvent.count({ where: { createdAt: { lt: cutoff } } }),
    tx.attendanceVisit.count({ where: { exitedAt: null, canceledAt: null } }),
  ]);
  return { visits, revisions, auditEvents, openVisits };
}

function status(instruction: { operationId: string; personId: string; requestedAt: Date; progress: { completedAt: Date | null; errorCode: string | null } | null }): DeletionStatus {
  return deletionStatusSchema.parse({ operationId: instruction.operationId, personId: instruction.personId,
    requestedAt: instruction.requestedAt.toISOString(), state: instruction.progress?.completedAt ? "COMPLETED" : "PENDING",
    completedAt: instruction.progress?.completedAt?.toISOString() ?? null, errorCode: instruction.progress?.errorCode ?? null });
}

export async function getPrivacy(db: Database, actor: AdminActor) {
  return db.$transaction(async (tx) => {
    await assertAdministrator(tx, actor, false);
    const retention = await tx.retentionPolicy.findUniqueOrThrow({ where: { id: 1 } });
    const pending = await tx.deletionInstruction.findMany({ where: { OR: [{ progress: null }, { progress: { completedAt: null } }] },
      orderBy: { sequence: "desc" }, include: { progress: true }, take: 100 });
    const completed = pending.length < 100 ? await tx.deletionInstruction.findMany({ where: { progress: { completedAt: { not: null } } },
      orderBy: { sequence: "desc" }, include: { progress: true }, take: 100 - pending.length }) : [];
    const pendingCount = await tx.deletionInstruction.count({ where: { OR: [{ progress: null }, { progress: { completedAt: null } }] } });
    return privacyResponseSchema.parse({ retention: { days: retention.days, version: retention.version, backupRetentionDays: retention.backupRetentionDays,
      lastRunAt: retention.lastRunAt?.toISOString() ?? null, lastDeletedVisits: retention.lastDeletedVisits, lastDeletedAuditEvents: retention.lastDeletedAuditEvents },
      deletions: [...pending, ...completed].map(status), pendingCount });
  }, { ...transactionOptions, isolationLevel: "RepeatableRead" });
}

export async function getDiagnostics(db: Database, actor: AdminActor, config: Config) {
  return db.$transaction(async (tx) => {
    await assertAdministrator(tx, actor, false);
    const [state, policy, pendingDeletions, storage] = await Promise.all([
      tx.privacyState.findUniqueOrThrow({ where: { id: 1 } }), tx.retentionPolicy.findUniqueOrThrow({ where: { id: 1 } }),
      tx.deletionInstruction.count({ where: { OR: [{ progress: null }, { progress: { completedAt: null } }] } }),
      statfs("/").catch(() => null),
    ]);
    return diagnosticsResponseSchema.parse({ checkedAt: (await identityClock(tx)).toISOString(), origin: config.origin,
      https: config.secure, database: "connected", passkey: { rpId: config.rpID, userVerification: "required" },
      disk: storage ? { availableBytes: storage.bavail * storage.bsize, totalBytes: storage.blocks * storage.bsize, scope: "container" } : null,
      backup: { lastCompletedAt: state.lastBackupAt?.toISOString() ?? null, externalConfirmed: state.backupExternalConfirmed, retentionDays: policy.backupRetentionDays },
      privacy: { pendingDeletions, lastRetentionRunAt: policy.lastRunAt?.toISOString() ?? null } });
  }, { ...transactionOptions, isolationLevel: "RepeatableRead" });
}

const confirmationSchema = z.object({
  actorId: z.string(), days: z.number().int(), version: z.number().int(), cutoff: z.iso.datetime(), issuedAt: z.iso.datetime(),
  visits: z.number().int(), revisions: z.number().int(), auditEvents: z.number().int(), openVisits: z.number().int(),
}).strict();
const sign = (secret: string, value: string) => createHmac("sha256", secret).update(`retention-preview-v1:${value}`).digest("base64url");
export async function previewRetention(db: Database, actor: AdminActor, input: { days: number }, secret: string) {
  const parsed = retentionPreviewInputSchema.safeParse(input);
  if (!parsed.success) throw invalid();
  return db.$transaction(async (tx) => {
    await assertAdministrator(tx, actor, false);
    const policy = await tx.retentionPolicy.findUniqueOrThrow({ where: { id: 1 } });
    const now = await identityClock(tx), cutoff = new Date(now.getTime() - parsed.data.days * 86_400_000);
    const counts = await retentionCounts(tx, cutoff);
    const value = Buffer.from(JSON.stringify({ actorId: actor.userId, days: parsed.data.days, version: policy.version,
      cutoff: cutoff.toISOString(), issuedAt: now.toISOString(), ...counts })).toString("base64url");
    return retentionPreviewSchema.parse({ days: parsed.data.days, expectedVersion: policy.version, cutoff: cutoff.toISOString(), ...counts,
      confirmationToken: `${value}.${sign(secret, value)}` });
  }, { ...transactionOptions, isolationLevel: "RepeatableRead" });
}

function readConfirmation(token: string, secret: string) {
  const [value, signature, extra] = token.split(".");
  if (!value || !signature || extra !== undefined) throw expired();
  const expected = Buffer.from(sign(secret, value)), actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw expired();
  try { return confirmationSchema.parse(JSON.parse(Buffer.from(value, "base64url").toString("utf8"))); }
  catch { throw expired(); }
}

export async function updateRetention(db: Database, actor: AdminActor, input: RetentionUpdateInput, secret: string) {
  const parsed = retentionUpdateInputSchema.safeParse(input);
  if (!parsed.success) throw invalid();
  const confirmed = readConfirmation(parsed.data.confirmationToken, secret);
  if (confirmed.actorId !== actor.userId || confirmed.days !== parsed.data.days || confirmed.version !== parsed.data.expectedVersion) throw expired();
  await db.$transaction(async (tx) => {
    await assertAdministrator(tx, actor);
    await tx.$queryRaw`SELECT id FROM "RetentionPolicy" WHERE id = 1 FOR UPDATE`;
    await assertAdministrator(tx, actor);
    const now = await identityClock(tx), issuedAt = new Date(confirmed.issuedAt);
    if (issuedAt > now || now.getTime() - issuedAt.getTime() > 300_000) throw expired();
    const policy = await tx.retentionPolicy.findUniqueOrThrow({ where: { id: 1 } });
    if (policy.version !== parsed.data.expectedVersion) throw conflict();
    const counts = await retentionCounts(tx, new Date(confirmed.cutoff));
    if (Object.entries(counts).some(([key, value]) => value !== confirmed[key as keyof typeof counts])) throw expired();
    if (policy.days === parsed.data.days) return;
    await tx.retentionPolicy.update({ where: { id: 1 }, data: { days: parsed.data.days, version: { increment: 1 } } });
    await tx.auditEvent.create({ data: { action: "RETENTION_UPDATED", actorType: "ADMIN", actorUserId: actor.userId,
      details: { previousDays: policy.days, days: parsed.data.days, preview: counts, cutoff: confirmed.cutoff } } });
  }, transactionOptions);
  return getPrivacy(db, actor);
}

async function personPreview(tx: Tx, id: string) {
  if (!uuid.safeParse(id).success) throw missing();
  const person = await tx.person.findUnique({ where: { id } });
  if (!person || person.facilityId !== 1) throw missing();
  if (person.status === "DELETED") throw new AttendanceError("PERSON_UNAVAILABLE", 409, "この利用者の個人情報は削除済みです。処理結果は保存と削除の画面で確認してください。");
  if (await tx.deletionInstruction.findUnique({ where: { personId: id }, select: { operationId: true } })) {
    throw new AttendanceError("DELETION_PENDING", 409, "削除指示はすでに受け付けています。保存と削除の画面で処理状態を確認してください。");
  }
  const [visits, revisions, openVisits, policy] = await Promise.all([
    tx.attendanceVisit.count({ where: { personId: id } }), tx.attendanceRevision.count({ where: { visit: { personId: id } } }),
    tx.attendanceVisit.count({ where: { personId: id, exitedAt: null, canceledAt: null } }),
    tx.retentionPolicy.findUniqueOrThrow({ where: { id: 1 } }),
  ]);
  return deletionPreviewSchema.parse({ personId: id, version: person.version, displayName: person.displayName,
    visits, revisions, openVisits, backupRetentionDays: policy.backupRetentionDays });
}
export async function previewDeletion(db: Database, actor: AdminActor, id: string) {
  return db.$transaction(async (tx) => {
    await assertAdministrator(tx, actor, false);
    return personPreview(tx, id);
  }, { ...transactionOptions, isolationLevel: "RepeatableRead" });
}

export async function requestDeletion(db: Database, actor: AdminActor, id: string, input: DeletionInput) {
  const parsed = deletionInputSchema.safeParse(input);
  if (!parsed.success || !uuid.safeParse(id).success) throw invalid();
  return db.$transaction(async (tx) => {
    await assertAdministrator(tx, actor);
    // 全指示の世代を直列化してから利用者をロックし、外部台帳に連続した接頭列を渡す。
    await tx.$queryRaw`SELECT id FROM "PrivacyState" WHERE id = 1 FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "Person" WHERE id = ${id}::uuid FOR UPDATE`;
    await assertAdministrator(tx, actor);
    const prior = await tx.deletionInstruction.findUnique({ where: { operationId: parsed.data.operationId }, include: { progress: true } });
    if (prior) {
      if (prior.personId !== id) throw new AttendanceError("REQUEST_CONFLICT", 409, "同じ処理IDで別の利用者を削除できません。");
      return status(prior);
    }
    if (await tx.deletionInstruction.findUnique({ where: { personId: id } })) {
      throw new AttendanceError("DELETION_PENDING", 409, "この利用者の削除はすでに受け付けています。保存と個人情報の画面で処理状況を確認してください。");
    }
    const person = await tx.person.findUnique({ where: { id } });
    if (!person || person.facilityId !== 1) throw missing();
    if (person.version !== parsed.data.expectedVersion) throw conflict();
    if (person.status === "DELETED") throw new AttendanceError("PERSON_UNAVAILABLE", 409, "この利用者の個人情報は削除済みです。");
    if ((await personPreview(tx, id)).openVisits) throw new AttendanceError("PERSON_INSIDE", 409, "入室中の記録があります。退室の訂正または誤記録の取消を先に行ってください。");
    const now = await identityClock(tx);
    const state = await tx.privacyState.update({ where: { id: 1 }, data: { generation: { increment: 1 } } });
    const instruction = await tx.deletionInstruction.create({ data: { operationId: parsed.data.operationId, sequence: state.generation, personId: id, requestedAt: now }, include: { progress: true } });
    // 外部保管中に受付・再編集されないよう停止するが、消去完了とは表示しない。
    await tx.person.update({ where: { id }, data: { status: "SUSPENDED", version: { increment: 1 } } });
    await tx.qrCredential.updateMany({ where: { personId: id, revokedAt: null }, data: { revokedAt: now } });
    await tx.auditEvent.create({ data: { action: "PERSON_DELETION_REQUESTED", actorType: "ADMIN", actorUserId: actor.userId, personId: id,
      details: { operationId: instruction.operationId, sequence: instruction.sequence } } });
    return status(instruction);
  }, transactionOptions);
}
