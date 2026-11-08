import {
  ATTENDANCE_CSV_LIMIT, attendanceDetailResponseSchema, attendanceHistoryResponseSchema, dashboardResponseSchema, presenceResponseSchema,
  type AttendanceCsvQuery, type AttendanceHistoryItem, type AttendanceQuery, type PresenceQuery,
} from "@mame/contracts";
import { Prisma } from "./generated/prisma/client.js";
import type { Database } from "./db.js";
import { AttendanceError, facilityDateTime } from "./attendance-rules.js";
import { assertAdministrator, identityClock, type AdminActor } from "./identity.js";
import { hash } from "./setup.js";

type Tx = Prisma.TransactionClient;
type VisitRow = {
  id: string; personId: string; displayName: string; affiliation: string | null; code: string | null;
  enteredAt: Date; exitedAt: Date | null; canceledAt: Date | null; version: number; source: "RECEPTION" | "MANUAL"; corrected: boolean;
};
const snapshotOptions = { isolationLevel: "RepeatableRead", maxWait: 15_000, timeout: 15_000 } as const;
const tables = Prisma.sql`FROM "AttendanceVisit" v JOIN "Person" p ON p.id = v."personId" JOIN "Facility" f ON f.id = p."facilityId"`;
// 通常の退室でもversionが増えるため、訂正有無は追記された訂正履歴で判定する。
const corrected = Prisma.sql`EXISTS (SELECT 1 FROM "AttendanceRevision" r WHERE r."visitId" = v.id AND r.before <> '{"state":"absent"}'::jsonb)`;
const columns = Prisma.sql`v.id, p.id AS "personId", p."displayName", p.affiliation, p.code, v."enteredAt", v."exitedAt", v."canceledAt", v.version, v.source, ${corrected} AS corrected`;
const missing = () => new AttendanceError("VISIT_NOT_FOUND", 404, "対象の入退出記録が見つかりません。");
const invalidCursor = () => new AttendanceError("PAGE_CHANGED", 409, "一覧の状態が変わりました。最初から更新してください。");

function searchWhere(query: { q?: string }) {
  // LIKEのワイルドカードを検索指定として解釈せず、入力された文字を探す。
  if (!query.q) return Prisma.empty;
  const value = `%${query.q.replace(/[\\%_]/g, "\\$&")}%`;
  return Prisma.sql`AND (p."displayName" ILIKE ${value} OR p."phoneticName" ILIKE ${value} OR p.affiliation ILIKE ${value} OR p.code ILIKE ${value})`;
}

function historyWhere(query: AttendanceCsvQuery) {
  const status = query.status === "canceled" ? Prisma.sql`v."canceledAt" IS NOT NULL`
    : query.status === "inside" ? Prisma.sql`v."canceledAt" IS NULL AND v."exitedAt" IS NULL`
      : query.status === "completed" ? Prisma.sql`v."canceledAt" IS NULL AND v."exitedAt" IS NOT NULL` : Prisma.sql`v."canceledAt" IS NULL`;
  // 日付境界は施設TZでPostgreSQLに計算させ、端末のTZや夏時間によるずれを避ける。
  return Prisma.sql`p."facilityId" = 1 AND ${status} ${searchWhere(query)}
    ${query.personId ? Prisma.sql`AND p.id = ${query.personId}::uuid` : Prisma.empty}
    ${query.affiliation ? Prisma.sql`AND p.affiliation ILIKE ${`%${query.affiliation.replace(/[\\%_]/g, "\\$&")}%`}` : Prisma.empty}
    ${query.source !== "all" ? Prisma.sql`AND v.source = ${query.source}` : Prisma.empty}
    ${query.corrected === "true" ? Prisma.sql`AND ${corrected}` : query.corrected === "false" ? Prisma.sql`AND NOT ${corrected}` : Prisma.empty}
    ${query.from ? Prisma.sql`AND v."enteredAt" >= (${query.from}::date::timestamp AT TIME ZONE f."timeZone")` : Prisma.empty}
    ${query.to ? Prisma.sql`AND v."enteredAt" < ((${query.to}::date + 1)::timestamp AT TIME ZONE f."timeZone")` : Prisma.empty}`;
}

function needsReview(asOf: Date) {
  // 長時間と日跨ぎは確認対象を示すだけで、未退室の状態や時刻を変更しない。
  return Prisma.sql`(v."enteredAt" <= (${asOf}::timestamptz - interval '12 hours')
    OR (v."enteredAt" AT TIME ZONE f."timeZone")::date < (${asOf}::timestamptz AT TIME ZONE f."timeZone")::date)`;
}

function historyItem(row: VisitRow): AttendanceHistoryItem {
  return { id: row.id, person: { id: row.personId, displayName: row.displayName, affiliation: row.affiliation }, enteredAt: row.enteredAt.toISOString(),
    exitedAt: row.exitedAt?.toISOString() ?? null, canceledAt: row.canceledAt?.toISOString() ?? null, version: row.version, source: row.source, corrected: row.corrected };
}

async function snapshot<T>(db: Database, actor: AdminActor, recent: boolean, read: (tx: Tx, asOf: Date, timeZone: string) => Promise<T>) {
  return db.$transaction(async (tx) => {
    await assertAdministrator(tx, actor, recent);
    const facility = await tx.facility.findUniqueOrThrow({ where: { id: 1 }, select: { timeZone: true } });
    // このTxのスナップショット開始後に時刻を取得し、人数と行を同じDB状態から読む。
    const asOf = await identityClock(tx);
    return read(tx, asOf, facility.timeZone);
  }, snapshotOptions);
}

async function count(tx: Tx, where: Prisma.Sql) {
  const rows = await tx.$queryRaw<Array<{ count: number }>>(Prisma.sql`SELECT count(*)::integer AS count ${tables} WHERE ${where}`);
  return rows[0]!.count;
}

async function anchor(tx: Tx, id: string, where: Prisma.Sql) {
  const rows = await tx.$queryRaw<Array<{ id: string; enteredAt: Date }>>(Prisma.sql`SELECT v.id, v."enteredAt" ${tables} WHERE ${where} AND v.id = ${id}::uuid`);
  if (!rows[0]) throw invalidCursor();
  return rows[0];
}

export async function getDashboard(db: Database, actor: AdminActor) {
  return snapshot(db, actor, false, async (tx, asOf, timeZone) => {
    const rows = await tx.$queryRaw<Array<{ inside: number; needsReview: number; todayEntered: number; todayExited: number }>>(Prisma.sql`
      SELECT count(*) FILTER (WHERE v."exitedAt" IS NULL)::integer AS inside,
        count(*) FILTER (WHERE v."exitedAt" IS NULL AND ${needsReview(asOf)})::integer AS "needsReview",
        count(*) FILTER (WHERE (v."enteredAt" AT TIME ZONE f."timeZone")::date = (${asOf}::timestamptz AT TIME ZONE f."timeZone")::date)::integer AS "todayEntered",
        count(*) FILTER (WHERE (v."exitedAt" AT TIME ZONE f."timeZone")::date = (${asOf}::timestamptz AT TIME ZONE f."timeZone")::date)::integer AS "todayExited"
      ${tables} WHERE p."facilityId" = 1 AND v."canceledAt" IS NULL`);
    const recent = await tx.$queryRaw<VisitRow[]>(Prisma.sql`SELECT ${columns} ${tables} WHERE p."facilityId" = 1 AND v."canceledAt" IS NULL
      ORDER BY GREATEST(v."enteredAt", v."exitedAt") DESC, v.id DESC LIMIT 8`);
    return dashboardResponseSchema.parse({ timeZone, asOf: asOf.toISOString(), counts: rows[0], recent: recent.map(historyItem) });
  });
}

export async function listPresence(db: Database, actor: AdminActor, query: PresenceQuery) {
  return snapshot(db, actor, false, async (tx, asOf, timeZone) => {
    const where = Prisma.sql`p."facilityId" = 1 AND v."canceledAt" IS NULL AND v."exitedAt" IS NULL ${searchWhere(query)}
      ${query.review === "true" ? Prisma.sql`AND ${needsReview(asOf)}` : query.review === "false" ? Prisma.sql`AND NOT ${needsReview(asOf)}` : Prisma.empty}`;
    if (query.cursor) await anchor(tx, query.cursor, where);
    // 長く滞在している記録を先にし、同時刻はIDで順序を確定する。
    // DBのマイクロ秒をJS Dateへ丸めず、カーソルの境界もDB内で比較する。
    const after = query.cursor ? Prisma.sql`AND (v."enteredAt", v.id) > (SELECT a."enteredAt", a.id FROM "AttendanceVisit" a WHERE a.id = ${query.cursor}::uuid)` : Prisma.empty;
    const rows = await tx.$queryRaw<Array<VisitRow & { needsReview: boolean }>>(Prisma.sql`SELECT ${columns}, ${needsReview(asOf)} AS "needsReview"
      ${tables} WHERE ${where} ${after} ORDER BY v."enteredAt" ASC, v.id ASC LIMIT ${query.limit + 1}`);
    return presenceResponseSchema.parse({ label: "記録上の在室者", timeZone, asOf: asOf.toISOString(), total: await count(tx, where),
      nextCursor: rows.length > query.limit ? rows[query.limit - 1]!.id : null,
      items: rows.slice(0, query.limit).map((row) => ({ id: row.id, person: historyItem(row).person, enteredAt: row.enteredAt.toISOString(), version: row.version,
        elapsedSeconds: Math.max(0, Math.floor((asOf.getTime() - row.enteredAt.getTime()) / 1000)), needsReview: row.needsReview })) });
  });
}

export async function listAttendance(db: Database, actor: AdminActor, query: AttendanceQuery) {
  return snapshot(db, actor, false, async (tx, asOf, timeZone) => {
    const where = historyWhere(query);
    if (query.cursor) await anchor(tx, query.cursor, where);
    const after = query.cursor ? Prisma.sql`AND (v."enteredAt", v.id) < (SELECT a."enteredAt", a.id FROM "AttendanceVisit" a WHERE a.id = ${query.cursor}::uuid)` : Prisma.empty;
    const rows = await tx.$queryRaw<VisitRow[]>(Prisma.sql`SELECT ${columns} ${tables} WHERE ${where} ${after} ORDER BY v."enteredAt" DESC, v.id DESC LIMIT ${query.limit + 1}`);
    return attendanceHistoryResponseSchema.parse({ timeZone, asOf: asOf.toISOString(), total: await count(tx, where),
      nextCursor: rows.length > query.limit ? rows[query.limit - 1]!.id : null, items: rows.slice(0, query.limit).map(historyItem) });
  });
}

export async function getAttendanceDetail(db: Database, actor: AdminActor, id: string, query: { limit: number; cursor?: string }) {
  return snapshot(db, actor, false, async (tx, asOf, timeZone) => {
    const rows = await tx.$queryRaw<VisitRow[]>(Prisma.sql`SELECT ${columns} ${tables} WHERE p."facilityId" = 1 AND v.id = ${id}::uuid`);
    const row = rows[0];
    if (!row) throw missing();
    const next = query.cursor ? await tx.attendanceRevision.findFirst({ where: { id: query.cursor, visitId: id }, select: { id: true } }) : null;
    if (query.cursor && !next) throw invalidCursor();
    const after = next ? Prisma.sql`AND (r."createdAt", r.id) < (SELECT a."createdAt", a.id FROM "AttendanceRevision" a WHERE a.id = ${next.id}::uuid)` : Prisma.empty;
    const revisions = await tx.$queryRaw<Array<{ id: string; actorName: string | null; reason: string; before: Prisma.JsonValue; after: Prisma.JsonValue; createdAt: Date }>>(Prisma.sql`
      SELECT r.id, u.name AS "actorName", r.reason, r.before, r.after, r."createdAt" FROM "AttendanceRevision" r
      LEFT JOIN "User" u ON u.id = r."actorUserId" WHERE r."visitId" = ${id}::uuid ${after}
      ORDER BY r."createdAt" DESC, r.id DESC LIMIT ${query.limit + 1}`);
    return attendanceDetailResponseSchema.parse({ timeZone, asOf: asOf.toISOString(), visit: { ...historyItem(row), personId: row.personId },
      nextCursor: revisions.length > query.limit ? revisions[query.limit - 1]!.id : null,
      revisions: revisions.slice(0, query.limit).map((revision) => ({ id: revision.id, actorName: revision.actorName,
        reason: revision.reason, before: revision.before, after: revision.after, createdAt: revision.createdAt.toISOString() })) });
  });
}

export function csvCell(value: string) {
  // 引用符だけでは表計算の数式実行を防げないため、危険な先頭文字は文字列に固定する。
  const safe = /^(?:[\u0000-\u0020]*[=+\-@]|[\t\r\n])/.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}

export async function exportAttendanceCsv(db: Database, actor: AdminActor, query: AttendanceCsvQuery) {
  return snapshot(db, actor, true, async (tx, asOf, timeZone) => {
    const rows = await tx.$queryRaw<VisitRow[]>(Prisma.sql`SELECT ${columns} ${tables} WHERE ${historyWhere(query)} ORDER BY v."enteredAt" DESC, v.id DESC LIMIT ${ATTENDANCE_CSV_LIMIT + 1}`);
    if (rows.length > ATTENDANCE_CSV_LIMIT) throw new AttendanceError("CSV_LIMIT_EXCEEDED", 422, "一度に出力できるのは10,000件までです。日付や利用者で絞り込んでください。");
    await assertAdministrator(tx, actor);
    // 自由検索語や所属の原文を複製せず、同じ検索を照合できるハッシュと非個人の条件を残す。
    await tx.auditEvent.create({ data: { action: "ATTENDANCE_CSV_EXPORTED", actorType: "ADMIN", actorUserId: actor.userId, details: { count: rows.length,
      filters: { personId: query.personId ?? null, from: query.from ?? null, to: query.to ?? null, status: query.status, source: query.source, corrected: query.corrected,
        searchHash: query.q ? hash(query.q) : null, affiliationHash: query.affiliation ? hash(query.affiliation) : null } } } });
    const lines = [["利用者ID", "表示名", "所属", "利用者コード", "入室日時", "退室日時", "状態", "記録方法", "訂正有無", "タイムゾーン", "取得日時", "記録ID"]];
    for (const row of rows) lines.push([row.personId, row.displayName, row.affiliation ?? "", row.code ?? "", facilityDateTime(row.enteredAt, timeZone),
      row.exitedAt ? facilityDateTime(row.exitedAt, timeZone) : "", row.canceledAt ? "取消" : row.exitedAt ? "退室済み" : "在室中", row.source === "MANUAL" ? "手動" : "QR受付", row.corrected ? "訂正あり" : "訂正なし", timeZone,
      facilityDateTime(asOf, timeZone), row.id]);
    return `\uFEFF${lines.map((line) => line.map(csvCell).join(",")).join("\r\n")}\r\n`;
  });
}
