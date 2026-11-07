import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { setCookie } from "hono/cookie";
import { setupInputSchema } from "@mame/contracts";
import type { Config } from "./config.js";
import type { Database } from "./db.js";
import { createAuth } from "./auth.js";
import { beginSetup, setupCookie } from "./setup.js";
import { allowAttempt } from "./rate-limit.js";

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
  app.use("*", bodyLimit({ maxSize: 32 * 1024, onError: (c) => c.json(error("INPUT_TOO_LARGE", "入力が長すぎます。"), 413) }));
  app.onError(() => new Response(JSON.stringify(error("UNAVAILABLE", "処理を完了できませんでした。時間をおいて再度お試しください。")), {
    status: 503, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  }));
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
    const response = await auth.handler(c.req.raw);
    if (!response.ok) {
      return c.json(error("AUTH_FAILED", "認証できませんでした。もう一度お試しください。"), response.status === 401 ? 401 : 400);
    }
    // ライブラリのResponseにも明示し、チャレンジとCookieを共有キャッシュへ保存させない。
    const headers = new Headers(response.headers);
    headers.set("Cache-Control", "no-store");
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("Referrer-Policy", "no-referrer");
    // セッション値や認証データ全体をJSONに複製せず、Cookieと必要なチャレンジだけを返す。
    if (c.req.method === "POST") {
      headers.delete("Content-Length"); headers.set("Content-Type", "application/json");
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
    }
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  });
  app.get("/api/admin/me", async (c) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json(error("UNAUTHENTICATED", "パスキーでログインしてください。"), 401);
    if (session.user.role !== "ADMIN") return c.json(error("FORBIDDEN", "管理者の権限が必要です。"), 403);
    await db.$queryRaw`SELECT 1`;
    return c.json({ user: { id: session.user.id, name: session.user.name, email: session.user.email, emailVerified: session.user.emailVerified }, database: "connected" });
  });
  app.notFound((c) => c.json(error("NOT_FOUND", "この操作は利用できません。"), 404));
  return app;
}
