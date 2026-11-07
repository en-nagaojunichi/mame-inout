import { AsyncLocalStorage } from "node:async_hooks";
import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { passkey } from "@better-auth/passkey";
import { prismaAdapter } from "@better-auth/prisma-adapter";
import type { Prisma } from "./generated/prisma/client.js";
import type { Config } from "./config.js";
import type { Database } from "./db.js";
import { completeRegistration, resolveRegistration, identityClock, validateAdminSession, registrationToken } from "./identity.js";
import { hash } from "./setup.js";

type Ceremony = { tx: Prisma.TransactionClient; currentSessionId?: string; credentialId?: string };
class RollbackResponse extends Error {
  constructor(readonly response: Response) { super("認証の保存を取り消します。"); }
}

export function createAuth(db: Database, config: Config) {
  const ceremony = new AsyncLocalStorage<Ceremony>();
  const factory = prismaAdapter(db, { provider: "postgresql" });
  const database: typeof factory = (options) => {
    const adapter = factory(options);
    adapter.transaction = async (callback) => {
      const current = ceremony.getStore();
      if (current) return callback(routed);
      return db.$transaction((tx) => ceremony.run({ tx }, () =>
        callback(routed)), { timeout: 15_000 });
    };
    // 認証ライブラリの読み書きも自作処理と同じ接続へ向け、復旧・失効との競合を防ぐ。
    const routed = new Proxy(adapter, { get(target, key) {
      const value = Reflect.get(target, key);
      if (key === "transaction" || typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const state = ceremony.getStore();
        const input = args[0] as { model?: string } | undefined;
        // チャレンジの単回消費は認証失敗のロールバックに巻き戻さず、再使用を拒否する。
        const connection = input?.model === "verification" ? db : state?.tx ?? db;
        const selected = prismaAdapter(connection, { provider: "postgresql" })(options);
        return Reflect.get(selected, key).apply(selected, args);
      };
    } });
    return routed;
  };
  const auth = betterAuth({
    appName: "MameInOut", baseURL: config.origin, basePath: "/api/auth", secret: config.secret,
    trustedOrigins: [config.origin], database,
    emailAndPassword: { enabled: false },
    user: { additionalFields: { role: { type: "string", required: true, defaultValue: "ADMIN", input: false } } },
    session: { expiresIn: 12 * 60 * 60, disableSessionRefresh: true, cookieCache: { enabled: false },
      additionalFields: { lastActivityAt: { type: "date", input: false }, authenticatedAt: { type: "date", input: false }, passkeyId: { type: "string", input: false } } },
    databaseHooks: { session: { create: { before: async (session) => {
      const state = ceremony.getStore();
      if (!state?.credentialId) throw new APIError("FORBIDDEN", { message: "パスキーで本人確認してください。" });
      const key = await state.tx.passkey.findUnique({ where: { credentialID: state.credentialId }, include: { user: true } });
      if (!key || key.userId !== session.userId || key.user.role !== "ADMIN" || key.user.status !== "ACTIVE") {
        throw new APIError("FORBIDDEN", { message: "このパスキーは利用できません。" });
      }
      const now = await identityClock(state.tx);
      return { data: { ...session, lastActivityAt: now, authenticatedAt: now, passkeyId: key.id } };
    } } } },
    advanced: { useSecureCookies: config.secure, defaultCookieAttributes: { httpOnly: true, sameSite: "lax", secure: config.secure } },
    rateLimit: { enabled: false }, logger: { disabled: true }, telemetry: { enabled: false },
    plugins: [passkey({
      rpID: config.rpID, rpName: "MameInOut", origin: config.origin,
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
      registration: {
        requireSession: false,
        resolveUser: async ({ ctx }) => resolveRegistration(db, ctx.headers),
        afterVerification: async ({ ctx, user, verification }) => {
          const state = ceremony.getStore();
          if (!state) throw new APIError("FORBIDDEN", { message: "登録をやり直してください。" });
          await completeRegistration(state.tx, ctx.headers, user.id, state.currentSessionId);
          if (!verification.registrationInfo) throw new APIError("FORBIDDEN", { message: "パスキーを検証できませんでした。" });
          state.credentialId = verification.registrationInfo.credential.id;
        },
      },
      authentication: { afterVerification: async ({ clientData }) => {
        const state = ceremony.getStore();
        if (!state) throw new APIError("FORBIDDEN", { message: "ログインをやり直してください。" });
        const key = await state.tx.passkey.findUnique({ where: { credentialID: clientData.id }, include: { user: true } });
        if (!key || key.user.role !== "ADMIN" || key.user.status !== "ACTIVE") throw new APIError("FORBIDDEN", { message: "このパスキーは利用できません。" });
        if (state.currentSessionId) {
          const previous = await state.tx.session.findUnique({ where: { id: state.currentSessionId } });
          if (previous && previous.userId !== key.userId) throw new APIError("FORBIDDEN", { message: "ログイン中の管理者のパスキーを選んでください。" });
        }
        state.credentialId = key.credentialID;
        await state.tx.passkey.update({ where: { id: key.id }, data: { lastUsedAt: await identityClock(state.tx) } });
      } },
    })],
  });
  return Object.assign(auth, {
    async handleAtomic(request: Request) {
      const path = new URL(request.url).pathname;
      if (!path.endsWith("verify-registration") && !path.endsWith("verify-authentication")) return auth.handler(request);
      const input = await request.clone().json().catch(() => null);
      try {
        return await db.$transaction(async (tx) => {
          const state: Ceremony = { tx };
          return ceremony.run(state, async () => {
            const previous = await auth.api.getSession({ headers: request.headers });
            if (previous) state.currentSessionId = previous.session.id;
            if (path.endsWith("verify-authentication") && typeof input?.response?.id === "string") {
              const candidate = await tx.passkey.findUnique({ where: { credentialID: input.response.id } });
              // 認証・復旧・パスキー失効は同じUser行を先にロックする。
              if (candidate) await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${candidate.userId} FOR UPDATE`;
            }
            const response = await auth.handler(request);
            if (!response.ok) throw new RollbackResponse(response);
            if (state.currentSessionId) await tx.session.deleteMany({ where: { id: state.currentSessionId } });
            return response;
          });
        }, { timeout: 15_000, maxWait: 15_000 });
      } catch (cause) {
        if (cause instanceof RollbackResponse) return cause.response;
        throw cause;
      }
    },
    async validateRegistrationSource(headers: Headers) {
      const session = await auth.api.getSession({ headers });
      if (session) {
        await validateAdminSession(db, session.session.id, true);
        const target = await resolveRegistration(db, headers);
        if (target.id !== session.user.id) throw new APIError("FORBIDDEN", { message: "ログイン中の管理者に登録してください。" });
      } else {
        await resolveRegistration(db, headers);
        const token = registrationToken(headers);
        if (token) {
          const attempt = await db.registrationAttempt.findUnique({ where: { tokenHash: hash(token) } });
          if (attempt?.kind === "ADD") throw new APIError("FORBIDDEN", { message: "再ログインして追加してください。" });
        }
      }
    },
  });
}
