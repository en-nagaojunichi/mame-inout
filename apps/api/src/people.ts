import {
  personInputSchema, personStatusInputSchema, personUpdateInputSchema, qrIssueInputSchema,
  type PeopleQuery, type PersonDetail, type PersonInput, type PersonStatusInput, type PersonUpdateInput,
} from "@mame/contracts";
import type { Prisma } from "./generated/prisma/client.js";
import type { Database } from "./db.js";
import { AttendanceError } from "./attendance-rules.js";
import { assertAdministrator, identityClock, type AdminActor } from "./identity.js";
import { hash, newToken } from "./setup.js";

type Tx = Prisma.TransactionClient;
const transactionOptions = { isolationLevel: "ReadCommitted" as const, maxWait: 15_000, timeout: 15_000 };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const summaryFields = { id: true, displayName: true, phoneticName: true, affiliation: true, code: true, status: true } as const;
const missing = () => new AttendanceError("PERSON_NOT_FOUND", 404, "対象の利用者が見つかりません。");
const invalid = () => new AttendanceError("INVALID_INPUT", 422, "名前・任意項目・更新状態を確認してください。");
const conflict = () => new AttendanceError("VERSION_CONFLICT", 409, "ほかの操作で利用者が更新されています。一覧を更新してから、もう一度操作してください。");

async function lockPerson(tx: Tx, id: string) {
  if (!uuid.test(id)) throw missing();
  // 受付・停止・訂正も同じ親行をロックし、QR変更と打刻の前後を確定させる。
  await tx.$queryRaw`SELECT id FROM "Person" WHERE id = ${id}::uuid FOR UPDATE`;
  const person = await tx.person.findUnique({ where: { id } });
  if (!person || person.facilityId !== 1) throw missing();
  return person;
}

async function detail(tx: Tx, id: string): Promise<PersonDetail> {
  const person = await tx.person.findUnique({ where: { id }, select: {
    ...summaryFields, version: true, createdAt: true, updatedAt: true,
    qrCredentials: { where: { revokedAt: null }, select: { id: true }, take: 1 },
  } });
  if (!person) throw missing();
  const { qrCredentials, ...fields } = person;
  return { ...fields, status: person.status as PersonDetail["status"], createdAt: person.createdAt.toISOString(), updatedAt: person.updatedAt.toISOString(),
    qrActive: qrCredentials.length > 0 };
}

async function audit(tx: Tx, actor: AdminActor, personId: string, action: string, version: number) {
  // 監査に氏名・コード・QR原文を複製せず、対象と更新版だけを記録する。
  await tx.auditEvent.create({ data: { action, actorType: "ADMIN", actorUserId: actor.userId, personId, details: { version } } });
}

async function mutate<T>(action: () => Promise<T>): Promise<T> {
  try { return await action(); }
  catch (cause) {
    // 利用者コードの同時登録もDBの一意制約で守り、SQLや入力値を応答へ含めない。
    if ((cause as { code?: unknown }).code === "P2002") throw new AttendanceError("PERSON_CODE_IN_USE", 409, "この利用者コードは使用されています。別のコードを入力してください。");
    throw cause;
  }
}

export async function listPeople(db: Database, query: PeopleQuery) {
  // %・_を検索構文にせず、入力した文字そのものを検索する。
  const search = query.q?.replace(/[\\%_]/g, "\\$&");
  const rows = await db.person.findMany({ where: { facilityId: 1,
    ...(query.cursor ? { id: { gt: query.cursor } } : {}), ...(query.status ? { status: query.status } : {}),
    ...(search ? { OR: ["displayName", "phoneticName", "affiliation", "code"].map((field) => ({ [field]: { contains: search, mode: "insensitive" } })) } : {}),
  }, select: summaryFields, orderBy: { id: "asc" }, take: query.limit + 1 });
  return { items: rows.slice(0, query.limit), nextCursor: rows.length > query.limit ? rows[query.limit - 1]!.id : null };
}

export async function getPerson(db: Database, actor: AdminActor, id: string) {
  return db.$transaction(async (tx) => {
    await assertAdministrator(tx, actor, false);
    await lockPerson(tx, id);
    await assertAdministrator(tx, actor, false);
    return detail(tx, id);
  }, transactionOptions);
}

export async function createPerson(db: Database, actor: AdminActor, input: PersonInput) {
  const parsed = personInputSchema.safeParse(input);
  if (!parsed.success) throw invalid();
  return mutate(() => db.$transaction(async (tx) => {
    await assertAdministrator(tx, actor, false);
    const person = await tx.person.create({ data: { ...parsed.data, facilityId: 1 } });
    await audit(tx, actor, person.id, "PERSON_CREATED", person.version);
    return detail(tx, person.id);
  }, transactionOptions));
}

export async function updatePerson(db: Database, actor: AdminActor, id: string, input: PersonUpdateInput) {
  const parsed = personUpdateInputSchema.safeParse(input);
  if (!parsed.success) throw invalid();
  return mutate(() => db.$transaction(async (tx) => {
    await assertAdministrator(tx, actor, false);
    const person = await lockPerson(tx, id);
    await assertAdministrator(tx, actor, false);
    if (person.version !== parsed.data.expectedVersion) throw conflict();
    if (person.status === "DELETED") throw new AttendanceError("PERSON_UNAVAILABLE", 409, "個人情報を削除した利用者は編集できません。");
    const changed = await tx.person.update({ where: { id }, data: {
      displayName: parsed.data.displayName, phoneticName: parsed.data.phoneticName, affiliation: parsed.data.affiliation,
      code: parsed.data.code, version: { increment: 1 },
    } });
    await audit(tx, actor, id, "PERSON_UPDATED", changed.version);
    return detail(tx, id);
  }, transactionOptions));
}

export async function setPersonStatus(db: Database, actor: AdminActor, id: string, input: PersonStatusInput) {
  const parsed = personStatusInputSchema.safeParse(input);
  if (!parsed.success) throw invalid();
  return db.$transaction(async (tx) => {
    await assertAdministrator(tx, actor);
    const person = await lockPerson(tx, id);
    await assertAdministrator(tx, actor);
    if (person.version !== parsed.data.expectedVersion) throw conflict();
    if (person.status === "DELETED") throw new AttendanceError("PERSON_UNAVAILABLE", 409, "個人情報を削除した利用者は再開できません。");
    if (person.status === parsed.data.status) return detail(tx, id);
    if (parsed.data.status === "SUSPENDED" && await tx.attendanceVisit.findFirst({ where: { personId: id, exitedAt: null, canceledAt: null }, select: { id: true } })) {
      throw new AttendanceError("PERSON_INSIDE", 409, "入室中のため利用停止できません。退室補正か誤記録の取消を先に行ってください。");
    }
    const now = await identityClock(tx);
    await tx.qrCredential.updateMany({ where: { personId: id, revokedAt: null }, data: { revokedAt: now } });
    const changed = await tx.person.update({ where: { id }, data: { status: parsed.data.status, version: { increment: 1 } } });
    await audit(tx, actor, id, parsed.data.status === "SUSPENDED" ? "PERSON_SUSPENDED" : "PERSON_RESUMED", changed.version);
    return detail(tx, id);
  }, transactionOptions);
}

export async function issuePersonQr(db: Database, actor: AdminActor, id: string, input: { expectedVersion: number }) {
  const parsed = qrIssueInputSchema.safeParse(input);
  if (!parsed.success) throw invalid();
  return db.$transaction(async (tx) => {
    await assertAdministrator(tx, actor);
    const person = await lockPerson(tx, id);
    await assertAdministrator(tx, actor);
    if (person.version !== parsed.data.expectedVersion) throw conflict();
    if (person.status !== "ACTIVE") throw new AttendanceError("PERSON_UNAVAILABLE", 409, "有効な利用者にだけQRを発行できます。利用状態を確認してください。");
    const now = await identityClock(tx);
    const qr = `mio1_${newToken()}`;
    await tx.qrCredential.updateMany({ where: { personId: id, revokedAt: null }, data: { revokedAt: now } });
    await tx.qrCredential.create({ data: { personId: id, tokenHash: hash(qr), issuedAt: now } });
    const changed = await tx.person.update({ where: { id }, data: { version: { increment: 1 } } });
    await audit(tx, actor, id, "PERSON_QR_ISSUED", changed.version);
    return { qr, personId: id, version: changed.version, issuedAt: now.toISOString() };
  }, transactionOptions);
}

export async function revokePersonQr(db: Database, actor: AdminActor, id: string, input: { expectedVersion: number }) {
  const parsed = qrIssueInputSchema.safeParse(input);
  if (!parsed.success) throw invalid();
  return db.$transaction(async (tx) => {
    await assertAdministrator(tx, actor);
    const person = await lockPerson(tx, id);
    await assertAdministrator(tx, actor);
    if (person.version !== parsed.data.expectedVersion) throw conflict();
    const revoked = await tx.qrCredential.updateMany({ where: { personId: id, revokedAt: null }, data: { revokedAt: await identityClock(tx) } });
    if (!revoked.count) return detail(tx, id);
    const changed = await tx.person.update({ where: { id }, data: { version: { increment: 1 } } });
    await audit(tx, actor, id, "PERSON_QR_REVOKED", changed.version);
    return detail(tx, id);
  }, transactionOptions);
}
