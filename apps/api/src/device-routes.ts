import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import {
  deviceApplyInputSchema, deviceApplicationResponseSchema, deviceApprovalInputSchema,
  deviceClaimResponseSchema, deviceNameInputSchema, devicePageQuerySchema, devicesResponseSchema, emptyRequestSchema,
} from "@mame/contracts";
import type { Config } from "./config.js";
import type { Database } from "./db.js";
import { receptionCookieName, type Authorization } from "./authorization.js";
import { AttendanceError, authenticateReception } from "./attendance.js";
import { allowAttempt } from "./rate-limit.js";
import { applyDevice, approveDevice, claimDevice, DEVICE_APPLICATION_MS, getCurrentDevice, getDeviceApplication, listDevices, rejectDevice, renameDevice, revokeDevice } from "./device-management.js";

export const applicationCookieName = (secure: boolean) => secure ? "__Secure-mame-device-application" : "mame_device_application";
const invalid = () => new AttendanceError("INVALID_INPUT", 422, "入力内容を確認して、もう一度お試しください。");

export function createDeviceRoutes(db: Database, config: Config, access: Authorization) {
  const routes = new Hono();
  const applicationToken = (c: Parameters<typeof getCookie>[0]) => getCookie(c, applicationCookieName(config.secure)) ?? "";
  routes.use("/api/devices/*", async (c, next) => {
    const ip = c.req.header("X-Mame-Client-IP") ?? "local";
    const isApply = c.req.path === "/api/devices/apply";
    if (!await allowAttempt(db, isApply ? "device-apply" : "device-application", ip, isApply ? 5 : 60, isApply ? 900 : 60)) {
      c.header("Retry-After", isApply ? "900" : "60");
      return c.json({ code: "RATE_LIMITED", message: "操作が続いています。しばらく待ってからお試しください。" }, 429);
    }
    await next();
  });
  routes.post("/api/devices/apply", async (c) => {
    const input = deviceApplyInputSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) throw invalid();
    const result = await applyDevice(db, input.data);
    setCookie(c, applicationCookieName(config.secure), result.token, {
      httpOnly: true, secure: config.secure, sameSite: "strict", path: "/api", maxAge: DEVICE_APPLICATION_MS / 1000,
    });
    return c.json(deviceApplicationResponseSchema.parse(result.body), 201);
  });
  routes.get("/api/devices/application", async (c) => c.json(deviceApplicationResponseSchema.parse(await getDeviceApplication(db, applicationToken(c)))));
  routes.get("/api/devices/current", async (c) => {
    const actor = await authenticateReception(db, getCookie(c, receptionCookieName(config.secure)) ?? "");
    if (!actor) throw new AttendanceError("DEVICE_UNAUTHENTICATED", 401, "このブラウザには有効な受付端末の登録がありません。");
    return c.json(deviceApplicationResponseSchema.parse(await getCurrentDevice(db, actor.deviceId)));
  });
  routes.post("/api/devices/claim", async (c) => {
    if (!emptyRequestSchema.safeParse(await c.req.json().catch(() => null)).success) throw invalid();
    const result = await claimDevice(db, config, applicationToken(c));
    // 資格はJSONに含めず、管理者ログインとは独立したHttpOnly Cookieだけで渡す。
    setCookie(c, receptionCookieName(config.secure), result.token, {
      httpOnly: true, secure: config.secure, sameSite: "strict", path: "/api", expires: result.expiresAt,
    });
    return c.json(deviceClaimResponseSchema.parse({ ok: true, expiresAt: result.expiresAt.toISOString() }));
  });
  routes.get("/api/admin/devices", async (c) => {
    await access.admin(c);
    const query = devicePageQuerySchema.safeParse(c.req.query());
    if (!query.success) throw invalid();
    return c.json(devicesResponseSchema.parse(await listDevices(db, query.data)));
  });
  routes.post("/api/admin/devices/:id/name", async (c) => {
    const actor = await access.admin(c);
    if (!await allowAttempt(db, "device-management", actor.userId, 30, 60)) {
      c.header("Retry-After", "60");
      return c.json({ code: "RATE_LIMITED", message: "操作が続いています。1分ほど待ってからお試しください。" }, 429);
    }
    const id = z.uuid().safeParse(c.req.param("id"));
    const input = deviceNameInputSchema.safeParse(await c.req.json().catch(() => null));
    if (!id.success || !input.success) throw invalid();
    return c.json(await renameDevice(db, actor, id.data, input.data));
  });
  for (const action of ["approve", "reject", "revoke"] as const) {
    routes.post(`/api/admin/devices/:id/${action}`, async (c) => {
      const actor = await access.recentAdmin(c);
      if (!await allowAttempt(db, "device-management", actor.userId, 30, 60)) {
        c.header("Retry-After", "60");
        return c.json({ code: "RATE_LIMITED", message: "操作が続いています。1分ほど待ってからお試しください。" }, 429);
      }
      const id = z.uuid().safeParse(c.req.param("id"));
      if (!id.success) throw invalid();
      const body = await c.req.json().catch(() => null);
      if (action === "approve") {
        const input = deviceApprovalInputSchema.safeParse(body);
        if (!input.success) throw invalid();
        return c.json(await approveDevice(db, actor, id.data, input.data));
      }
      if (!emptyRequestSchema.safeParse(body).success) throw invalid();
      return c.json(action === "reject" ? await rejectDevice(db, actor, id.data) : await revokeDevice(db, actor, id.data));
    });
  }
  return routes;
}
