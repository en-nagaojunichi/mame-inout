import { Hono } from "hono";
import { readJson } from "./request-input.js";
import { z } from "zod";
import {
  peopleQuerySchema, peopleResponseSchema, personDetailSchema, personInputSchema, personStatusInputSchema,
  personUpdateInputSchema, qrIssueInputSchema, qrIssueResponseSchema,
} from "@mame/contracts";
import type { Database } from "./db.js";
import type { Authorization } from "./authorization.js";
import { AttendanceError } from "./attendance-rules.js";
import { allowAttempt } from "./rate-limit.js";
import { createPerson, getPerson, issuePersonQr, listPeople, revokePersonQr, setPersonStatus, updatePerson } from "./people.js";

const invalid = () => new AttendanceError("INVALID_INPUT", 422, "入力内容を確認して、もう一度お試しください。");
const personId = (value: string) => {
  const parsed = z.uuid().safeParse(value);
  if (!parsed.success) throw invalid();
  return parsed.data;
};

export function createPeopleRoutes(db: Database, access: Authorization) {
  const routes = new Hono();
  routes.use("/api/admin/people*", async (c, next) => {
    // 名簿の読取と変更にも共通の上限を持たせ、受付端末資格では入口から拒否する。
    const actor = await access.admin(c);
    if (!await allowAttempt(db, "people-management", actor.userId, 120, 60)) {
      c.header("Retry-After", "60");
      return c.json({ code: "RATE_LIMITED", message: "操作が続いています。1分ほど待ってからお試しください。" }, 429);
    }
    await next();
  });
  routes.get("/api/admin/people", async (c) => {
    const query = peopleQuerySchema.safeParse(c.req.query());
    if (!query.success) throw invalid();
    return c.json(peopleResponseSchema.parse(await listPeople(db, query.data)));
  });
  routes.post("/api/admin/people", async (c) => {
    const actor = await access.admin(c);
    const input = personInputSchema.safeParse(await readJson(c));
    if (!input.success) throw invalid();
    return c.json(personDetailSchema.parse(await createPerson(db, actor, input.data)), 201);
  });
  routes.get("/api/admin/people/:id", async (c) => {
    const actor = await access.admin(c);
    return c.json(personDetailSchema.parse(await getPerson(db, actor, personId(c.req.param("id")))));
  });
  routes.patch("/api/admin/people/:id", async (c) => {
    const actor = await access.admin(c);
    const input = personUpdateInputSchema.safeParse(await readJson(c));
    if (!input.success) throw invalid();
    return c.json(personDetailSchema.parse(await updatePerson(db, actor, personId(c.req.param("id")), input.data)));
  });
  routes.put("/api/admin/people/:id/status", async (c) => {
    const actor = await access.recentAdmin(c);
    const input = personStatusInputSchema.safeParse(await readJson(c));
    if (!input.success) throw invalid();
    return c.json(personDetailSchema.parse(await setPersonStatus(db, actor, personId(c.req.param("id")), input.data)));
  });
  routes.post("/api/admin/people/:id/qr-credentials", async (c) => {
    const actor = await access.recentAdmin(c);
    const input = qrIssueInputSchema.safeParse(await readJson(c));
    if (!input.success) throw invalid();
    return c.json(qrIssueResponseSchema.parse(await issuePersonQr(db, actor, personId(c.req.param("id")), input.data)), 201);
  });
  routes.delete("/api/admin/people/:id/qr-credentials/current", async (c) => {
    const actor = await access.recentAdmin(c);
    const input = qrIssueInputSchema.safeParse(await readJson(c));
    if (!input.success) throw invalid();
    return c.json(personDetailSchema.parse(await revokePersonQr(db, actor, personId(c.req.param("id")), input.data)));
  });
  return routes;
}
