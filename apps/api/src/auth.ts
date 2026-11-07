import { AsyncLocalStorage } from "node:async_hooks";
import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { passkey } from "@better-auth/passkey";
import { prismaAdapter } from "@better-auth/prisma-adapter";
import type { Prisma } from "./generated/prisma/client.js";
import type { Config } from "./config.js";
import type { Database } from "./db.js";
import { completeSetup, loadAttempt } from "./setup.js";

export function createAuth(db: Database, config: Config) {
  const registrationTransaction = new AsyncLocalStorage<Prisma.TransactionClient>();
  const factory = prismaAdapter(db, { provider: "postgresql" });
  const database: typeof factory = (options) => {
    const adapter = factory(options);
    // ライブラリのパスキー/セッション保存と自作の初期設定処理を同じ接続に束ねる。
    adapter.transaction = (callback) => db.$transaction((tx) => registrationTransaction.run(tx, () =>
      callback(prismaAdapter(tx, { provider: "postgresql" })(options))), { timeout: 15000 });
    return adapter;
  };
  return betterAuth({
    appName: "MameInOut", baseURL: config.origin, basePath: "/api/auth", secret: config.secret,
    trustedOrigins: [config.origin], database,
    emailAndPassword: { enabled: false },
    user: { additionalFields: { role: { type: "string", required: true, defaultValue: "ADMIN", input: false } } },
    session: { expiresIn: 30 * 60, disableSessionRefresh: true, cookieCache: { enabled: false } },
    advanced: { useSecureCookies: config.secure, defaultCookieAttributes: { httpOnly: true, sameSite: "lax", secure: config.secure } },
    // Hono側でDBに永続化した試行制限を適用し、プロセス再起動でリセットしない。
    rateLimit: { enabled: false },
    logger: { disabled: true },
    telemetry: { enabled: false },
    plugins: [passkey({
      rpID: config.rpID, rpName: "MameInOut", origin: config.origin,
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
      registration: {
        requireSession: false,
        resolveUser: async ({ ctx }) => {
          const attempt = await loadAttempt(db, ctx.headers);
          return { id: attempt.userId, name: attempt.email, displayName: attempt.name };
        },
        afterVerification: async ({ ctx, user }) => {
          const tx = registrationTransaction.getStore();
          if (!tx) throw new APIError("FORBIDDEN", { message: "初期設定をやり直してください。" });
          await completeSetup(tx, ctx.headers, user.id);
        },
      },
    })],
  });
}
