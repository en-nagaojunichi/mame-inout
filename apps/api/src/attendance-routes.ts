import { Hono } from "hono";
import {
  attendanceHistoryResponseSchema, attendanceQuerySchema, attendanceRecordInputSchema, attendanceResultSchema,
  attendanceRequestResultSchema, attendanceTicketSchema, emptyRequestSchema,
  facilityResponseSchema, pageQuerySchema, peopleResponseSchema, presenceResponseSchema,
} from "@mame/contracts";
import { z } from "zod";
import type { Database } from "./db.js";
import type { Authorization } from "./authorization.js";
import { AttendanceError, getAttendanceRequest, issueAttendanceRequest, recordAttendance } from "./attendance.js";
import { allowAttempt } from "./rate-limit.js";

const invalidInput = () => new AttendanceError("INVALID_INPUT", 422, "入力内容を確認して、もう一度お試しください。");
const personFields = { id: true, displayName: true, phoneticName: true, affiliation: true, code: true, status: true } as const;
const visitPersonFields = { id: true, displayName: true, affiliation: true } as const;
const page = <T extends { id: string }>(rows: T[], limit: number) => ({ items: rows.slice(0, limit), nextCursor: rows.length > limit ? rows[limit - 1]!.id : null });

export function createAttendanceRoutes(db: Database, access: Authorization) {
  const routes = new Hono();
  routes.get("/api/admin/facility", async (c) => {
    await access.admin(c);
    const facility = await db.facility.findUniqueOrThrow({ where: { id: 1 }, select: { id: true, name: true, timeZone: true } });
    return c.json(facilityResponseSchema.parse(facility));
  });
  routes.get("/api/admin/people", async (c) => {
    await access.admin(c);
    const query = pageQuerySchema.safeParse(c.req.query());
    if (!query.success) throw invalidInput();
    const { limit, cursor } = query.data;
    // 一覧の上限をサーバーで固定し、QR資格や認証資格の列は取得しない。
    const people = await db.person.findMany({ where: { facilityId: 1, ...(cursor ? { id: { gt: cursor } } : {}) }, select: personFields, orderBy: { id: "asc" }, take: limit + 1 });
    return c.json(peopleResponseSchema.parse(page(people, limit)));
  });
  routes.get("/api/admin/presence", async (c) => {
    await access.admin(c);
    const query = pageQuerySchema.safeParse(c.req.query());
    if (!query.success) throw invalidInput();
    const { limit, cursor } = query.data;
    const [facility, rows] = await Promise.all([
      db.facility.findUniqueOrThrow({ where: { id: 1 }, select: { timeZone: true } }),
      db.attendanceVisit.findMany({ where: { exitedAt: null, canceledAt: null, person: { facilityId: 1 }, ...(cursor ? { id: { gt: cursor } } : {}) }, include: { person: { select: visitPersonFields } }, orderBy: { id: "asc" }, take: limit + 1 }),
    ]);
    // 行の取得後に計測し、取得中の入室時刻が最終取得時刻より未来にならないようにする。
    const clock = await db.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
    const asOf = clock[0]!.now;
    const result = page(rows, limit);
    return c.json(presenceResponseSchema.parse({ label: "記録上の在室者", timeZone: facility.timeZone, asOf: asOf.toISOString(), nextCursor: result.nextCursor,
      items: result.items.map((visit) => ({ id: visit.id, person: visit.person, enteredAt: visit.enteredAt.toISOString(), version: visit.version,
        elapsedSeconds: Math.max(0, Math.floor((asOf.getTime() - visit.enteredAt.getTime()) / 1000)),
        // 長時間・日跨ぎは要確認表示だけにし、時刻や在室状態を勝手に確定しない。
        needsReview: asOf.getTime() - visit.enteredAt.getTime() >= 12 * 60 * 60 * 1000 })) }));
  });
  routes.get("/api/admin/attendance", async (c) => {
    await access.admin(c);
    const query = attendanceQuerySchema.safeParse(c.req.query());
    if (!query.success) throw invalidInput();
    const { limit, cursor, personId } = query.data;
    const [facility, rows] = await Promise.all([
      db.facility.findUniqueOrThrow({ where: { id: 1 }, select: { timeZone: true } }),
      db.attendanceVisit.findMany({ where: { person: { facilityId: 1 }, ...(personId ? { personId } : {}), ...(cursor ? { id: { gt: cursor } } : {}) }, include: { person: { select: visitPersonFields } }, orderBy: { id: "asc" }, take: limit + 1 }),
    ]);
    const result = page(rows, limit);
    return c.json(attendanceHistoryResponseSchema.parse({ timeZone: facility.timeZone, nextCursor: result.nextCursor,
      items: result.items.map((visit) => ({ id: visit.id, person: visit.person, enteredAt: visit.enteredAt.toISOString(), exitedAt: visit.exitedAt?.toISOString() ?? null,
        canceledAt: visit.canceledAt?.toISOString() ?? null, version: visit.version, source: visit.source })) }));
  });
  routes.use("/api/reception/*", async (c, next) => {
    const actor = await access.reception(c);
    if (!await allowAttempt(db, "reception", actor.deviceId, 120, 60)) {
      c.header("Retry-After", "60");
      return c.json({ code: "RATE_LIMITED", message: "操作が続いています。1分ほど待ってからお試しください。" }, 429);
    }
    await next();
  });
  routes.post("/api/reception/requests", async (c) => {
    const actor = await access.reception(c);
    if (!emptyRequestSchema.safeParse(await c.req.json().catch(() => null)).success) throw invalidInput();
    return c.json(attendanceTicketSchema.parse(await issueAttendanceRequest(db, actor)), 201);
  });
  routes.post("/api/reception/records", async (c) => {
    const actor = await access.reception(c);
    const input = attendanceRecordInputSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) throw invalidInput();
    const result = await recordAttendance(db, actor, input.data);
    return c.json(attendanceResultSchema.parse(result.body), result.status);
  });
  routes.get("/api/reception/requests/:id", async (c) => {
    const actor = await access.reception(c);
    const id = z.uuid().safeParse(c.req.param("id"));
    if (!id.success) throw invalidInput();
    return c.json(attendanceRequestResultSchema.parse(await getAttendanceRequest(db, actor, id.data)));
  });
  return routes;
}
