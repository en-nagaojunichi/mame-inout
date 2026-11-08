import { Hono } from "hono";
import { readJson } from "./request-input.js";
import { deletionInputSchema, retentionPreviewInputSchema, retentionUpdateInputSchema } from "@mame/contracts";
import type { Authorization } from "./authorization.js";
import type { Config } from "./config.js";
import type { Database } from "./db.js";
import { AttendanceError } from "./attendance-rules.js";
import { getPrivacy, getDiagnostics, previewDeletion, previewRetention, requestDeletion, updateRetention } from "./privacy.js";

export function createPrivacyRoutes(db: Database, config: Config, access: Authorization) {
  const routes = new Hono();
  routes.get("/api/admin/privacy", async (c) => c.json(await getPrivacy(db, await access.admin(c))));
  routes.get("/api/admin/diagnostics", async (c) => c.json(await getDiagnostics(db, await access.admin(c), config)));
  routes.post("/api/admin/privacy/retention-preview", async (c) => {
    const actor = await access.admin(c), parsed = retentionPreviewInputSchema.safeParse(await readJson(c));
    if (!parsed.success) throw new AttendanceError("INVALID_INPUT", 422, "保存日数は1〜3650日で入力してください。");
    return c.json(await previewRetention(db, actor, parsed.data, config.secret));
  });
  routes.put("/api/admin/privacy/retention", async (c) => {
    const actor = await access.recentAdmin(c), parsed = retentionUpdateInputSchema.safeParse(await readJson(c));
    if (!parsed.success) throw new AttendanceError("INVALID_INPUT", 422, "保存日数と確認内容を確認してください。");
    return c.json(await updateRetention(db, actor, parsed.data, config.secret));
  });
  routes.get("/api/admin/people/:id/deletion-preview", async (c) => c.json(await previewDeletion(db, await access.admin(c), c.req.param("id"))));
  routes.post("/api/admin/people/:id/deletion", async (c) => {
    const actor = await access.recentAdmin(c), parsed = deletionInputSchema.safeParse(await readJson(c));
    if (!parsed.success) throw new AttendanceError("INVALID_INPUT", 422, "利用者の変更状態を確認してください。");
    const result = await requestDeletion(db, actor, c.req.param("id"), parsed.data);
    return c.json(result, result.state === "COMPLETED" ? 200 : 202);
  });
  return routes;
}
