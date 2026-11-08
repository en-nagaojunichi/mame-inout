import { Hono } from "hono";
import type { Database } from "./db.js";
import type { Authorization } from "./authorization.js";
import { appearanceInputSchema } from "@mame/contracts";
import { AttendanceError } from "./attendance-rules.js";
import { defaultAppearanceSvg, getAppearance, updateAppearance } from "./appearance.js";

export function createAppearanceRoutes(db: Database, access: Authorization) {
  const routes = new Hono();
  // 公開するのは名称と表示画像だけ。管理者・施設・名簿の情報は含めない。
  routes.get("/api/appearance", async (c) => c.json(await getAppearance(db)));
  routes.get("/api/admin/appearance", async (c) => { await access.admin(c); return c.json(await getAppearance(db)); });
  routes.put("/api/admin/appearance", async (c) => {
    const actor = await access.admin(c);
    const input = appearanceInputSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) throw new AttendanceError("INVALID_INPUT", 422, "表示名・画像と更新状態を確認してください。");
    return c.json(await updateAppearance(db, actor, input.data));
  });
  for (const kind of ["icon", "favicon"] as const) routes.get(`/api/appearance/${kind}`, async (c) => {
    const row = await db.appearance.findUniqueOrThrow({ where: { id: 1 }, select: { icon: true, favicon: true } });
    const bytes = row[kind];
    c.header("Content-Type", bytes ? "image/png" : "image/svg+xml; charset=utf-8");
    c.header("Content-Security-Policy", "default-src 'none'; sandbox");
    c.header("Cross-Origin-Resource-Policy", "same-origin");
    // 版付きURLとno-storeで、保存直後に古いファビコンを再利用させない。
    c.header("Cache-Control", "no-store");
    return c.body(bytes ? Buffer.from(bytes) : defaultAppearanceSvg);
  });
  return routes;
}
