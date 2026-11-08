import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { setCookie, generateCookie } from "hono/cookie";
import { setupInputSchema } from "@mame/contracts";
import type { Config } from "./config.js";
import type { Database } from "./db.js";
import { createAuth } from "./auth.js";
import { beginSetup, setupCookie } from "./setup.js";
import { allowAttempt } from "./rate-limit.js";
import { createAuthorization } from "./authorization.js";
import { createAttendanceRoutes } from "./attendance-routes.js";
import { AttendanceError } from "./attendance.js";
import { createIdentityRoutes } from "./identity-routes.js";
import { createDeviceRoutes } from "./device-routes.js";
import { createPeopleRoutes } from "./people-routes.js";
import { createAppearanceRoutes } from "./appearance-routes.js";
import { registrationCookieName } from "./identity.js";

const error = (code: string, message: string) => ({ code, message });
const authPaths = new Map([
  ["/api/auth/passkey/generate-register-options", "GET"],
  ["/api/auth/passkey/verify-registration", "POST"],
  ["/api/auth/passkey/generate-authenticate-options", "GET"],
  ["/api/auth/passkey/verify-authentication", "POST"],
  ["/api/auth/sign-out", "POST"],
]);

export function createApp(db: Database, config: Config) {
  const app = new Hono();
  const auth = createAuth(db, config);
  const access = createAuthorization(db, config, auth);
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    const origin = c.req.header("Origin");
    if ((origin && origin !== config.origin) || (!["GET", "HEAD"].includes(c.req.method) && origin !== config.origin)) {
      return c.json(error("ORIGIN_DENIED", "この画面からは操作できません。正しいURLを開いてください。"), 403);
    }
    if (c.req.header("Sec-Fetch-Site") === "cross-site") return c.json(error("ORIGIN_DENIED", "正しいURLを開いてください。"), 403);
    await next();
  });
  // 表示画像の更新だけ上限を広げ、認証や業務APIの入力上限は維持する。
  app.use("*", async (c, next) => bodyLimit({ maxSize: c.req.method === "PUT" && c.req.path === "/api/admin/appearance" ? 192 * 1024 : 32 * 1024,
    onError: (context) => context.json(error("INPUT_TOO_LARGE", "入力が長すぎます。画像の容量を小さくしてください。"), 413) })(c, next));
  app.onError((cause, c) => {
    // 準備済みのRetry-Afterも保ち、例外やDB接続情報は利用者へ返さない。
    c.header("Cache-Control", "no-store"); c.header("X-Content-Type-Options", "nosniff"); c.header("Referrer-Policy", "no-referrer");
    return cause instanceof AttendanceError ? c.json(error(cause.code, cause.message), cause.status)
      : c.json(error("UNAVAILABLE", "処理を完了できませんでした。時間をおいて再度お試しください。"), 503);
  });
  app.get("/api/health", async (c) => { await db.$queryRaw`SELECT 1`; return c.json({ status: "ok" }); });
  app.get("/api/setup/status", async (c) => {
    const state = await db.setupState.findUnique({ where: { id: 1 } });
    return c.json({ completed: Boolean(state?.completedAt) });
  });
  app.post("/api/setup/begin", async (c) => {
    // このヘッダーは入口プロキシが必ず上書きする。APIポートは直接公開しない。
    if (!await allowAttempt(db, "setup", c.req.header("X-Mame-Client-IP") ?? "local", 5, 900)) {
      c.header("Retry-After", "900"); return c.json(error("RATE_LIMITED", "試行が続いています。15分ほど待ってからお試しください。"), 429);
    }
    const input = setupInputSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json(error("INVALID_INPUT", "設定コード、表示名、メールアドレスを確認してください。"), 422);
    const token = await beginSetup(db, input.data);
    if (!token) return c.json(error("SETUP_DENIED", "設定コードが無効か、初期設定が完了しています。サーバー管理者に確認してください。"), 403);
    setCookie(c, setupCookie, token, { httpOnly: true, secure: config.secure, sameSite: "strict", path: "/api", maxAge: 300 });
    return c.json({ ok: true });
  });
  app.all("/api/auth/*", async (c) => {
    if (authPaths.get(c.req.path) !== c.req.method) return c.json(error("NOT_FOUND", "この操作は利用できません。"), 404);
    if (!await allowAttempt(db, "auth", c.req.header("X-Mame-Client-IP") ?? "local", 60, 60)) {
      c.header("Retry-After", "60"); return c.json(error("RATE_LIMITED", "1分ほど待ってからお試しください。"), 429);
    }
    if (c.req.path.endsWith("verify-registration")) {
      const input = await c.req.raw.clone().json().catch(() => null);
      if (input?.createSession !== true) return c.json(error("INVALID_INPUT", "初期設定画面から登録してください。"), 422);
    }
    if (c.req.path.endsWith("generate-register-options")) {
      try { await auth.validateRegistrationSource(c.req.raw.headers); }
      catch { return c.json(error("REGISTRATION_DENIED", "登録の許可が無効か、有効期限が切れています。設定画面からやり直してください。"), 403); }
    }
    const response = await auth.handleAtomic(c.req.raw);
    if (!response.ok) {
      return c.json(error("AUTH_FAILED", "認証できませんでした。もう一度お試しください。"), response.status === 401 ? 401 : 400);
    }
    // ライブラリのResponseにも明示し、チャレンジとCookieを共有キャッシュへ保存させない。
    const headers = new Headers(response.headers);
    headers.set("Cache-Control", "no-store");
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("Referrer-Policy", "no-referrer");
    if (c.req.path.endsWith("verify-registration")) {
      // 認証Responseと別のc.resにCookieを設定すると、Honoの後処理で認証Cookieを上書きする。
      // 削除するCookieも同じResponseに追加し、登録直後のログイン状態を保持する。
      for (const name of [registrationCookieName(config.secure), setupCookie]) {
        headers.append("Set-Cookie", generateCookie(name, "", { path: "/api", maxAge: 0, httpOnly: true, secure: config.secure, sameSite: "strict" }));
      }
    }
    // セッション値や認証データ全体をJSONに複製せず、Cookieと必要なチャレンジだけを返す。
    if (c.req.method === "POST") {
      headers.delete("Content-Length"); headers.set("Content-Type", "application/json");
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
    }
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  });
  app.get("/api/admin/me", async (c) => {
    const admin = await access.admin(c);
    await db.$queryRaw`SELECT 1`;
    return c.json({ user: { id: admin.userId, name: admin.name, email: admin.email, emailVerified: admin.emailVerified }, database: "connected" });
  });
  app.route("/", createAttendanceRoutes(db, access));
  app.route("/", createIdentityRoutes(db, config, access, auth));
  app.route("/", createDeviceRoutes(db, config, access));
  app.route("/", createPeopleRoutes(db, access));
  app.route("/", createAppearanceRoutes(db, access));
  app.notFound((c) => c.json(error("NOT_FOUND", "この操作は利用できません。"), 404));
  return app;
}
