import { Hono } from "hono";
import { readJson } from "./request-input.js";
import {
  attendanceCsvQuerySchema, attendancePatchInputSchema, attendanceQuerySchema, attendanceRecordInputSchema, attendanceResultSchema,
  attendanceRequestResultSchema, attendanceTicketSchema, emptyRequestSchema,
  facilityResponseSchema, manualVisitRequestInputSchema, pageQuerySchema, presenceQuerySchema, visitDtoSchema,
} from "@mame/contracts";
import { z } from "zod";
import type { Database } from "./db.js";
import type { Authorization } from "./authorization.js";
import { AttendanceError, correctAttendanceVisit, createManualVisit, getAttendanceRequest, issueAttendanceRequest, recordAttendance } from "./attendance.js";
import { allowAttempt } from "./rate-limit.js";
import { exportAttendanceCsv, getAttendanceDetail, getDashboard, listAttendance, listPresence } from "./attendance-query.js";

const invalidInput = () => new AttendanceError("INVALID_INPUT", 422, "入力内容を確認して、もう一度お試しください。");

export function createAttendanceRoutes(db: Database, access: Authorization) {
  const routes = new Hono();
  routes.get("/api/admin/facility", async (c) => {
    await access.admin(c);
    const facility = await db.facility.findUniqueOrThrow({ where: { id: 1 }, select: { id: true, name: true, timeZone: true } });
    return c.json(facilityResponseSchema.parse(facility));
  });
  routes.get("/api/admin/dashboard", async (c) => c.json(await getDashboard(db, await access.admin(c))));
  routes.get("/api/admin/presence", async (c) => {
    const actor = await access.admin(c);
    const query = presenceQuerySchema.safeParse(c.req.query());
    if (!query.success) throw invalidInput();
    return c.json(await listPresence(db, actor, query.data));
  });
  routes.get("/api/admin/attendance", async (c) => {
    const actor = await access.admin(c);
    const query = attendanceQuerySchema.safeParse(c.req.query());
    if (!query.success) throw invalidInput();
    return c.json(await listAttendance(db, actor, query.data));
  });
  routes.post("/api/admin/attendance", async (c) => {
    const actor = await access.recentAdmin(c);
    const input = manualVisitRequestInputSchema.safeParse(await readJson(c));
    if (!input.success) throw invalidInput();
    return c.json(visitDtoSchema.parse(await createManualVisit(db, actor, input.data)), 201);
  });
  routes.get("/api/admin/attendance.csv", async (c) => {
    const actor = await access.recentAdmin(c);
    const query = attendanceCsvQuerySchema.safeParse(c.req.query());
    if (!query.success) throw invalidInput();
    if (!await allowAttempt(db, "attendance-csv", actor.userId, 10, 60)) {
      c.header("Retry-After", "60");
      return c.json({ code: "RATE_LIMITED", message: "CSVの出力が続いています。1分ほど待ってからお試しください。" }, 429);
    }
    c.header("Content-Type", "text/csv; charset=utf-8");
    c.header("Content-Disposition", 'attachment; filename="attendance.csv"');
    return c.body(await exportAttendanceCsv(db, actor, query.data));
  });
  routes.get("/api/admin/attendance/:id", async (c) => {
    const actor = await access.admin(c);
    const id = z.uuid().safeParse(c.req.param("id"));
    const query = pageQuerySchema.safeParse(c.req.query());
    if (!id.success || !query.success) throw invalidInput();
    return c.json(await getAttendanceDetail(db, actor, id.data, query.data));
  });
  routes.patch("/api/admin/attendance/:id", async (c) => {
    const actor = await access.recentAdmin(c);
    const id = z.uuid().safeParse(c.req.param("id"));
    const input = attendancePatchInputSchema.safeParse(await readJson(c));
    if (!id.success || !input.success) throw invalidInput();
    return c.json(visitDtoSchema.parse(await correctAttendanceVisit(db, actor, { ...input.data, visitId: id.data })));
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
    if (!emptyRequestSchema.safeParse(await readJson(c)).success) throw invalidInput();
    return c.json(attendanceTicketSchema.parse(await issueAttendanceRequest(db, actor)), 201);
  });
  routes.post("/api/reception/records", async (c) => {
    const actor = await access.reception(c);
    const input = attendanceRecordInputSchema.safeParse(await readJson(c));
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
