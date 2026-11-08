import { createHash, randomUUID } from "node:crypto";
import {
  attendanceRecordInputSchema, attendanceResultSchema, correctVisitInputSchema, manualVisitInputSchema,
  visitDtoSchema,
  type AttendanceRecordInput, type AttendanceResult, type AttendanceTicket, type AttendanceRequestResult,
  type ManualVisitInput, type CorrectVisitInput,
} from "@mame/contracts";
import type { Prisma } from "./generated/prisma/client.js";
import type { Database } from "./db.js";
import { AttendanceError, assertVisitTimes, attendanceOutcome, facilityDateTime, intervalsOverlap } from "./attendance-rules.js";
import { assertAdministrator, type AdminActor } from "./identity.js";

export { AttendanceError } from "./attendance-rules.js";
export type ReceptionActor = { deviceId: string; credentialId: string };
export type { AdminActor } from "./identity.js";
type Tx = Prisma.TransactionClient;
type Visit = { id: string; personId: string; enteredAt: Date; exitedAt: Date | null; canceledAt: Date | null; version: number };
export type VisitDto = { id: string; personId: string; enteredAt: string; exitedAt: string | null; canceledAt: string | null; version: number };

export const ATTENDANCE_ACCEPT_MS = 5 * 60_000;
export const ATTENDANCE_RESULT_MS = 24 * 60 * 60_000;
const transactionOptions = { isolationLevel: "ReadCommitted", maxWait: 15_000, timeout: 15_000 } as const;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const unauthorized = () => new AttendanceError("RECEPTION_UNAUTHENTICATED", 401, "受付端末の承認と有効期限を管理者に確認してください。");
const expired = () => new AttendanceError("REQUEST_EXPIRED", 410, "この受付要求の有効期限が切れています。状態を確認してから新しく読み取ってください。");

async function clock(tx: Tx): Promise<Date> {
  const rows = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
  const now = rows[0]?.now;
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new AttendanceError("UNAVAILABLE", 503, "時刻を確認できません。時間をおいて再度お試しください。");
  return now;
}

async function receptionState(tx: Tx, actor: ReceptionActor, now: Date) {
  const credential = await tx.receptionCredential.findUnique({ where: { id: actor.credentialId }, include: { device: true } });
  if (!credential || credential.deviceId !== actor.deviceId || credential.revokedAt || credential.expiresAt <= now ||
      credential.device.status !== "APPROVED" || credential.device.revokedAt || !credential.device.approvedAt ||
      credential.device.approvedAt > now || !credential.device.expiresAt || credential.device.expiresAt <= now) throw unauthorized();
  return credential.device;
}

async function lockReception(tx: Tx, actor: ReceptionActor) {
  if (!uuid.test(actor.deviceId) || !uuid.test(actor.credentialId)) throw unauthorized();
  // 失効操作と競合する共有ロックを保持する。lastUsedAtの更新でロック昇格させない。
  await tx.$queryRaw`SELECT id FROM "ReceptionDevice" WHERE id = ${actor.deviceId}::uuid FOR SHARE`;
  await tx.$queryRaw`SELECT id FROM "ReceptionCredential" WHERE id = ${actor.credentialId}::uuid FOR SHARE`;
  return receptionState(tx, actor, await clock(tx));
}

async function lockAdmin(tx: Tx, actor: AdminActor): Promise<void> {
  // HTTPでの検査後に失効や期限切れが起きても、書き込みTxの中で拒否する。
  await assertAdministrator(tx, actor);
}

async function lockPerson(tx: Tx, personId: string) {
  if (!uuid.test(personId)) throw new AttendanceError("PERSON_NOT_FOUND", 404, "対象の利用者が見つかりません。");
  // 通常受付・手動追加・訂正・停止が必ずこの親行を共有し、別端末からの変更も直列化する。
  await tx.$queryRaw`SELECT id FROM "Person" WHERE id = ${personId}::uuid FOR UPDATE`;
  const person = await tx.person.findUnique({ where: { id: personId } });
  if (!person || person.facilityId !== 1) throw new AttendanceError("PERSON_NOT_FOUND", 404, "対象の利用者が見つかりません。");
  return person;
}

async function timeZone(tx: Tx, facilityId: number): Promise<string> {
  const facility = await tx.facility.findUnique({ where: { id: facilityId } });
  if (!facility) throw new AttendanceError("UNAVAILABLE", 503, "施設の設定を確認できません。管理者に確認してください。");
  try { facilityDateTime(new Date(0), facility.timeZone); } catch {
    throw new AttendanceError("UNAVAILABLE", 503, "施設のタイムゾーンを確認できません。管理者に確認してください。");
  }
  return facility.timeZone;
}

async function requestRow(tx: Tx, actor: ReceptionActor, id: string) {
  if (!uuid.test(id)) throw new AttendanceError("INVALID_INPUT", 422, "受付要求の形式を確認してください。");
  await tx.$queryRaw`SELECT id FROM "AttendanceRequest" WHERE id = ${id}::uuid FOR UPDATE`;
  const request = await tx.attendanceRequest.findUnique({ where: { id } });
  // 未知のIDをここで作らないため、保持終了後の再送が新しい打刻になることはない。
  if (!request) throw expired();
  if (request.deviceId !== actor.deviceId) throw new AttendanceError("NOT_FOUND", 404, "この受付端末の要求が見つかりません。");
  return request;
}

function storedResult(response: unknown): AttendanceResult {
  const parsed = attendanceResultSchema.safeParse(response);
  if (!parsed.success) throw new AttendanceError("UNAVAILABLE", 503, "受付結果を確認できません。管理者に確認してください。");
  return parsed.data;
}

function visitDto(visit: Visit): VisitDto {
  return { id: visit.id, personId: visit.personId, enteredAt: visit.enteredAt.toISOString(), exitedAt: visit.exitedAt?.toISOString() ?? null,
    canceledAt: visit.canceledAt?.toISOString() ?? null, version: visit.version };
}

async function assertNoOverlap(tx: Tx, personId: string, enteredAt: Date, exitedAt: Date | null, exceptId?: string): Promise<void> {
  if (exitedAt?.getTime() === enteredAt.getTime()) return;
  const visits = await tx.attendanceVisit.findMany({ where: { personId, canceledAt: null,
    ...(exceptId ? { id: { not: exceptId } } : {}), ...(exitedAt ? { enteredAt: { lt: exitedAt } } : {}),
    OR: [{ exitedAt: null }, { exitedAt: { gt: enteredAt } }],
  },
    select: { enteredAt: true, exitedAt: true } });
  if (visits.some((visit) => intervalsOverlap({ enteredAt, exitedAt }, visit))) {
    throw new AttendanceError("VISIT_OVERLAP", 409, "ほかの在室記録と時刻が重なっています。記録を確認してください。");
  }
}

export async function authenticateReception(db: Database, token: string): Promise<ReceptionActor | null> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const rows = await db.$queryRaw<ReceptionActor[]>`
    SELECT c.id AS "credentialId", c."deviceId" AS "deviceId"
    FROM "ReceptionCredential" c JOIN "ReceptionDevice" d ON d.id = c."deviceId"
    WHERE c."tokenHash" = ${hash(token)} AND c."revokedAt" IS NULL AND c."expiresAt" > clock_timestamp()
      AND d.status = 'APPROVED' AND d."revokedAt" IS NULL AND d."approvedAt" <= clock_timestamp()
      AND d."expiresAt" > clock_timestamp()`;
  const actor = rows[0];
  if (!actor) return null;
  // 共有ロック中に更新へ昇格させず、業務Txを始める前に最終利用を記録する。
  const touched = await db.receptionDevice.updateMany({ where: { id: actor.deviceId, status: "APPROVED", revokedAt: null,
    expiresAt: { gt: new Date() } }, data: { lastUsedAt: new Date() } });
  return touched.count ? actor : null;
}

export async function issueAttendanceRequest(db: Database, actor: ReceptionActor): Promise<AttendanceTicket> {
  return db.$transaction(async (tx) => {
    await lockReception(tx, actor);
    const now = await clock(tx);
    await receptionState(tx, actor, now);
    const request = await tx.attendanceRequest.create({ data: { id: randomUUID(), deviceId: actor.deviceId, issuedAt: now,
      acceptUntil: new Date(now.getTime() + ATTENDANCE_ACCEPT_MS), resultUntil: new Date(now.getTime() + ATTENDANCE_RESULT_MS) } });
    return { requestId: request.id, acceptUntil: request.acceptUntil.toISOString(), resultUntil: request.resultUntil.toISOString() };
  }, transactionOptions);
}

export async function recordAttendance(db: Database, actor: ReceptionActor, input: AttendanceRecordInput): Promise<{ status: 200 | 409; body: AttendanceResult }> {
  const parsed = attendanceRecordInputSchema.safeParse(input);
  if (!parsed.success) throw new AttendanceError("INVALID_INPUT", 422, "読み取った内容と入退室モードを確認してください。");
  const value = parsed.data;
  // QR生値はハッシュの計算にだけ使い、DBや診断出力には保存しない。
  const payloadHash = hash(JSON.stringify([value.mode, value.qr]));
  const qrHash = hash(value.qr);
  return db.$transaction(async (tx) => {
    const device = await lockReception(tx, actor);
    const request = await requestRow(tx, actor, value.requestId);
    let now = await clock(tx);
    await receptionState(tx, actor, now);
    if (request.resultUntil <= now) throw expired();
    if (request.completedAt) {
      if (request.payloadHash !== payloadHash) throw new AttendanceError("REQUEST_CONFLICT", 409, "同じ受付要求に別の内容は送信できません。新しく読み取ってください。");
      if (request.httpStatus !== 200 && request.httpStatus !== 409) throw new AttendanceError("UNAVAILABLE", 503, "受付結果を確認できません。管理者に確認してください。");
      return { status: request.httpStatus, body: storedResult(request.response) };
    }
    if (request.acceptUntil <= now) throw expired();
    const zone = await timeZone(tx, device.facilityId);
    let result: AttendanceResult = { requestId: request.id, mode: value.mode, outcome: "QR_INVALID",
      message: "このQRは利用できません。管理者に確認してください。", recordedAt: null, person: null, timeZone: zone };
    let personId: string | null = null;
    let visitId: string | null = null;
    const candidate = await tx.qrCredential.findUnique({ where: { tokenHash: qrHash } });
    if (candidate && !candidate.revokedAt && candidate.issuedAt <= now) {
      const person = await lockPerson(tx, candidate.personId);
      // ロック待ちの間のQR再発行・停止・失効と、受付要求や端末資格の期限を再検査する。
      now = await clock(tx);
      await receptionState(tx, actor, now);
      if (request.acceptUntil <= now || request.resultUntil <= now) throw expired();
      const qr = await tx.qrCredential.findUnique({ where: { id: candidate.id } });
      if (qr && qr.personId === person.id && qr.tokenHash === qrHash && !qr.revokedAt && qr.issuedAt <= now && person.facilityId === device.facilityId) {
        personId = person.id;
        if (person.status !== "ACTIVE") {
          result = { ...result, outcome: "PERSON_UNAVAILABLE", message: "この利用者は受付できません。管理者に確認してください。" };
        } else {
          const open = await tx.attendanceVisit.findFirst({ where: { personId: person.id, exitedAt: null, canceledAt: null } });
          const outcome = attendanceOutcome(value.mode, Boolean(open));
          result = { ...result, outcome, person: { displayName: person.displayName }, message: outcome === "ALREADY_INSIDE"
            ? "すでに入室中です。退室する場合は退室モードに切り替えてください。" : "入室記録がありません。管理者に確認してください。" };
          if (outcome === "RECORDED") {
            if (value.mode === "IN") {
              await assertNoOverlap(tx, person.id, now, null);
              const visit = await tx.attendanceVisit.create({ data: { personId: person.id, enteredAt: now, source: "RECEPTION", createdByDeviceId: device.id } });
              visitId = visit.id;
            } else {
              if (!open) throw new AttendanceError("UNAVAILABLE", 503, "在室状態を確認できません。再確認してください。");
              assertVisitTimes(open.enteredAt, now, now);
              await assertNoOverlap(tx, person.id, open.enteredAt, now, open.id);
              await tx.attendanceVisit.update({ where: { id: open.id }, data: { exitedAt: now, version: { increment: 1 } } });
              visitId = open.id;
            }
            result = { ...result, recordedAt: now.toISOString(), message: value.mode === "IN" ? "入室を記録しました。" : "退室を記録しました。" };
          }
        }
      }
    }
    const status = result.outcome === "RECORDED" ? 200 : 409;
    await tx.attendanceRequest.update({ where: { id: request.id }, data: { payloadHash, httpStatus: status, response: json(result), completedAt: now, personId } });
    await tx.auditEvent.create({ data: { action: status === 200 ? "ATTENDANCE_RECORDED" : "ATTENDANCE_REJECTED", actorType: "RECEPTION", deviceId: device.id, personId, visitId, requestId: request.id,
      details: { mode: value.mode, outcome: result.outcome } } });
    return { status, body: result };
  }, transactionOptions);
}

export async function getAttendanceRequest(db: Database, actor: ReceptionActor, requestId: string): Promise<AttendanceRequestResult> {
  return db.$transaction(async (tx) => {
    await lockReception(tx, actor);
    const request = await requestRow(tx, actor, requestId);
    const now = await clock(tx);
    await receptionState(tx, actor, now);
    if (request.resultUntil <= now || (!request.completedAt && request.acceptUntil <= now)) throw expired();
    return request.completedAt ? { state: "completed", result: storedResult(request.response) }
      : { state: "pending", acceptUntil: request.acceptUntil.toISOString() };
  }, transactionOptions);
}

export async function cleanupAttendanceRequests(db: Database): Promise<number> {
  const now = await clock(db);
  const result = await db.attendanceRequest.deleteMany({ where: { resultUntil: { lte: now } } });
  return result.count;
}

export async function createManualVisit(db: Database, admin: AdminActor, input: ManualVisitInput): Promise<VisitDto> {
  const parsed = manualVisitInputSchema.safeParse(input);
  if (!parsed.success) throw new AttendanceError("INVALID_INPUT", 422, "対象・日時・訂正理由を確認してください。");
  const value = parsed.data;
  try { return await db.$transaction(async (tx) => {
    await lockAdmin(tx, admin);
    const person = await lockPerson(tx, value.personId);
    await lockAdmin(tx, admin);
    const enteredAt = new Date(value.enteredAt), exitedAt = value.exitedAt === null ? null : new Date(value.exitedAt);
    if (value.requestId) {
      // 最初の変更履歴は追記専用なので、訂正後も最初に確定した応答と本文を照合できる。
      const previous = await tx.attendanceVisit.findUnique({ where: { id: value.requestId } });
      if (previous) {
        if (previous.source !== "MANUAL" || previous.createdByUserId !== admin.userId || previous.personId !== person.id) {
          throw new AttendanceError("REQUEST_CONFLICT", 409, "同じ追加要求に別の内容は送信できません。履歴を確認してください。");
        }
        const original = await tx.attendanceRevision.findFirst({ where: { visitId: previous.id, before: { equals: { state: "absent" } } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
        const response = visitDtoSchema.safeParse(original?.after);
        if (!original || !response.success || response.data.id !== previous.id || response.data.personId !== person.id || response.data.version !== 1 || response.data.canceledAt !== null) {
          throw new AttendanceError("UNAVAILABLE", 503, "最初の追加結果を確認できません。履歴を確認してください。");
        }
        if (original.actorUserId !== admin.userId || original.reason !== value.reason || response.data.enteredAt !== enteredAt.toISOString() || response.data.exitedAt !== (exitedAt?.toISOString() ?? null)) {
          throw new AttendanceError("REQUEST_CONFLICT", 409, "同じ追加要求に別の内容は送信できません。履歴を確認してください。");
        }
        return response.data;
      }
    }
    if (person.status !== "ACTIVE") throw new AttendanceError("PERSON_UNAVAILABLE", 409, "停止・削除済みの利用者には記録を追加できません。");
    const now = await clock(tx);
    assertVisitTimes(enteredAt, exitedAt, now);
    await assertNoOverlap(tx, person.id, enteredAt, exitedAt);
    const visit = await tx.attendanceVisit.create({ data: { ...(value.requestId ? { id: value.requestId } : {}), personId: person.id, enteredAt, exitedAt, source: "MANUAL", createdByUserId: admin.userId } });
    const after = visitDto(visit);
    await tx.attendanceRevision.create({ data: { visitId: visit.id, actorUserId: admin.userId, reason: value.reason, before: { state: "absent" }, after: json(after) } });
    await tx.auditEvent.create({ data: { action: "VISIT_CREATED_MANUALLY", actorType: "ADMIN", actorUserId: admin.userId, personId: person.id, visitId: visit.id, details: { version: visit.version } } });
    return after;
  }, transactionOptions); }
  catch (error) {
    // 別の利用者・管理者が同じIDを同時に確定しても、DBの一意制約を安全な競合応答へ変える。
    if ((error as { code?: unknown }).code === "P2002") throw new AttendanceError("REQUEST_CONFLICT", 409, "同じ追加要求に別の内容は送信できません。履歴を確認してください。");
    throw error;
  }
}

export async function correctAttendanceVisit(db: Database, admin: AdminActor, input: CorrectVisitInput): Promise<VisitDto> {
  const parsed = correctVisitInputSchema.safeParse(input);
  if (!parsed.success) throw new AttendanceError("INVALID_INPUT", 422, "対象・日時・更新版・訂正理由を確認してください。");
  const value = parsed.data;
  return db.$transaction(async (tx) => {
    await lockAdmin(tx, admin);
    const candidate = await tx.attendanceVisit.findUnique({ where: { id: value.visitId } });
    if (!candidate) throw new AttendanceError("VISIT_NOT_FOUND", 404, "対象の在室記録が見つかりません。");
    const person = await lockPerson(tx, candidate.personId);
    await lockAdmin(tx, admin);
    const deletion = await tx.deletionInstruction.findUnique({ where: { personId: person.id }, include: { progress: true } });
    if (deletion && !deletion.progress?.completedAt) {
      throw new AttendanceError("PERSON_UNAVAILABLE", 409, "個人情報の削除が処理待ちの利用者の記録は変更できません。");
    }
    const visit = await tx.attendanceVisit.findUnique({ where: { id: candidate.id } });
    if (!visit) throw new AttendanceError("VISIT_NOT_FOUND", 404, "対象の在室記録が見つかりません。");
    if (visit.personId !== person.id) throw new AttendanceError("VERSION_CONFLICT", 409, "記録の対象が更新されています。最新の状態を確認してください。");
    if (visit.version !== value.expectedVersion) throw new AttendanceError("VERSION_CONFLICT", 409, "ほかの操作で記録が更新されています。最新の状態を確認してください。");
    if (visit.canceledAt) throw new AttendanceError("VISIT_CANCELED", 409, "取消済みの記録は変更できません。必要な場合は理由を付けて新しく記録を追加してください。");
    const now = await clock(tx);
    const enteredAt = new Date(value.enteredAt), exitedAt = value.exitedAt === null ? null : new Date(value.exitedAt);
    assertVisitTimes(enteredAt, exitedAt, now);
    if (!value.cancel) {
      if (person.status !== "ACTIVE" && exitedAt === null) throw new AttendanceError("PERSON_UNAVAILABLE", 409, "停止・削除済みの利用者を在室状態には戻せません。");
      await assertNoOverlap(tx, person.id, enteredAt, exitedAt, visit.id);
    }
    const updated = await tx.attendanceVisit.update({ where: { id: visit.id }, data: { enteredAt, exitedAt,
      canceledAt: value.cancel ? (visit.canceledAt ?? now) : null, version: { increment: 1 } } });
    const after = visitDto(updated);
    // 復元で戻った未退室も管理者が確認して閉じられるようにする。削除済みの自由記載は再収集しない。
    const revisionReason = person.status === "DELETED" ? "削除済み利用者の記録を確認して訂正" : value.reason;
    await tx.attendanceRevision.create({ data: { visitId: visit.id, actorUserId: admin.userId, reason: revisionReason, before: json(visitDto(visit)), after: json(after) } });
    await tx.auditEvent.create({ data: { action: value.cancel ? "VISIT_CANCELED" : "VISIT_CORRECTED", actorType: "ADMIN", actorUserId: admin.userId,
      personId: person.id, visitId: visit.id, details: { previousVersion: visit.version, version: updated.version } } });
    return after;
  }, transactionOptions);
}

export async function suspendPerson(db: Database, admin: AdminActor, personId: string): Promise<void> {
  await db.$transaction(async (tx) => {
    await lockAdmin(tx, admin);
    const person = await lockPerson(tx, personId);
    await lockAdmin(tx, admin);
    if (await tx.attendanceVisit.findFirst({ where: { personId: person.id, exitedAt: null, canceledAt: null } })) {
      throw new AttendanceError("PERSON_INSIDE", 409, "入室中のため利用停止できません。退室補正か誤記録の取消を先に行ってください。");
    }
    if (person.status === "DELETED") throw new AttendanceError("PERSON_UNAVAILABLE", 409, "削除済みの利用者は変更できません。");
    if (person.status === "SUSPENDED") return;
    const now = await clock(tx);
    await tx.person.update({ where: { id: person.id }, data: { status: "SUSPENDED", version: { increment: 1 } } });
    await tx.qrCredential.updateMany({ where: { personId: person.id, revokedAt: null }, data: { revokedAt: now } });
    await tx.auditEvent.create({ data: { action: "PERSON_SUSPENDED", actorType: "ADMIN", actorUserId: admin.userId, personId: person.id, details: { status: "SUSPENDED" } } });
  }, transactionOptions);
}
