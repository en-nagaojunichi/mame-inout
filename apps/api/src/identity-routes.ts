import { Hono, type Context } from "hono";
import { setCookie } from "hono/cookie";
import { z } from "zod";
import {
  identityEmptyInputSchema, invitationInputSchema, invitationBeginInputSchema, recoveryBeginInputSchema,
  passkeyNameInputSchema, administratorNameInputSchema, securityResponseSchema, recoveryCodesResponseSchema, invitationResponseSchema,
} from "@mame/contracts";
import type { Database } from "./db.js";
import type { Config } from "./config.js";
import type { Authorization } from "./authorization.js";
import type { createAuth } from "./auth.js";
import { AttendanceError } from "./attendance-rules.js";
import { allowAttempt } from "./rate-limit.js";
import {
  beginInvitation, beginRecovery, beginPasskeyAddition, generateRecoveryCodes, getSecurity, issueInvitation,
  renamePasskey, revokePasskey, renameAdministrator, disableAdministrator, registrationCookieName,
} from "./identity.js";

async function input<T>(c: Context, schema: z.ZodType<T>) {
  const parsed = schema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new AttendanceError("INVALID_INPUT", 422, "入力内容を確認してください。");
  return parsed.data;
}

export function createIdentityRoutes(db: Database, config: Config, access: Authorization, auth: ReturnType<typeof createAuth>) {
  const app = new Hono();
  const limited = async (c: Context, scope: string, limit: number, seconds: number) => {
    if (!await allowAttempt(db, scope, c.req.header("X-Mame-Client-IP") ?? "local", limit, seconds)) {
      c.header("Retry-After", String(seconds));
      throw new AttendanceError("RATE_LIMITED", 429, "試行が続いています。時間をおいて再度お試しください。");
    }
  };
  const setRegistration = (c: Context, token: string) => setCookie(c, registrationCookieName(config.secure), token,
    { httpOnly: true, secure: config.secure, sameSite: "strict", path: "/api", maxAge: 300 });
  app.use("/api/admin/*", async (c, next) => {
    if (c.req.method === "POST") await limited(c, "identity-admin", 30, 60);
    await next();
  });
  app.get("/api/admin/security", async (c) => {
    const actor = await access.admin(c);
    const query = z.strictObject({ adminsCursor: z.string().min(1).max(128).optional() }).safeParse(c.req.query());
    if (!query.success) throw new AttendanceError("INVALID_INPUT", 422, "一覧の指定を確認してください。");
    return c.json(securityResponseSchema.parse(await getSecurity(db, actor, query.data.adminsCursor)));
  });
  app.post("/api/admin/passkeys/begin", async (c) => {
    await input(c, identityEmptyInputSchema);
    setRegistration(c, await beginPasskeyAddition(db, await access.recentAdmin(c)));
    return c.json({ ok: true });
  });
  app.post("/api/admin/passkeys/:id/name", async (c) => {
    const body = await input(c, passkeyNameInputSchema);
    await renamePasskey(db, await access.recentAdmin(c), c.req.param("id"), body.name);
    return c.json({ ok: true });
  });
  app.post("/api/admin/passkeys/:id/revoke", async (c) => {
    await input(c, identityEmptyInputSchema);
    await revokePasskey(db, await access.recentAdmin(c), c.req.param("id"));
    return c.json({ ok: true });
  });
  app.post("/api/admin/recovery-codes", async (c) => {
    await input(c, identityEmptyInputSchema);
    return c.json(recoveryCodesResponseSchema.parse({ codes: await generateRecoveryCodes(db, await access.recentAdmin(c)) }));
  });
  app.post("/api/admin/invitations", async (c) => {
    const body = await input(c, invitationInputSchema);
    return c.json(invitationResponseSchema.parse(await issueInvitation(db, await access.recentAdmin(c), body)), 201);
  });
  app.post("/api/admin/administrators/:id/name", async (c) => {
    const body = await input(c, administratorNameInputSchema);
    await renameAdministrator(db, await access.admin(c), c.req.param("id"), body.name);
    return c.json({ ok: true });
  });
  app.post("/api/admin/administrators/:id/disable", async (c) => {
    await input(c, identityEmptyInputSchema);
    await disableAdministrator(db, await access.recentAdmin(c), c.req.param("id"));
    return c.json({ ok: true });
  });
  for (const kind of ["invitations", "recovery"] as const) {
    app.post(`/api/${kind}/begin`, async (c) => {
      await limited(c, kind, 5, 900);
      if (await auth.api.getSession({ headers: c.req.raw.headers })) throw new AttendanceError("SIGN_OUT_REQUIRED", 403, "先にログアウトしてから、この画面を開き直してください。");
      const started = kind === "invitations"
        ? await beginInvitation(db, await input(c, invitationBeginInputSchema))
        : await beginRecovery(db, await input(c, recoveryBeginInputSchema));
      setRegistration(c, started.token);
      return c.json({ ok: true, name: started.name, email: started.email });
    });
  }
  return app;
}
