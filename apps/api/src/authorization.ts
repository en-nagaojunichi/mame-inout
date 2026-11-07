import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import type { Config } from "./config.js";
import type { Database } from "./db.js";
import type { createAuth } from "./auth.js";
import { AttendanceError, authenticateReception } from "./attendance.js";

export const receptionCookieName = (secure: boolean) => secure ? "__Secure-mame-reception" : "mame_reception";

export function createAuthorization(db: Database, config: Config, auth: ReturnType<typeof createAuth>) {
  const device = (c: Context) => authenticateReception(db, getCookie(c, receptionCookieName(config.secure)) ?? "");
  return {
    async admin(c: Context) {
      // 画面の表示状態を信頼せず、管理者の役割と失効を要求ごとにDBで確認する。
      const session = await auth.api.getSession({ headers: c.req.raw.headers });
      if (session) {
        if (session.user.role !== "ADMIN") throw new AttendanceError("FORBIDDEN", 403, "管理者の権限が必要です。");
        return { userId: session.user.id, name: session.user.name, email: session.user.email, emailVerified: session.user.emailVerified };
      }
      if (await device(c)) throw new AttendanceError("FORBIDDEN", 403, "この端末では管理者の情報を表示できません。");
      throw new AttendanceError("UNAUTHENTICATED", 401, "パスキーでログインしてください。");
    },
    async reception(c: Context) {
      // 管理者Cookieを持っていても、受付端末の資格の代わりにはしない。
      const actor = await device(c);
      if (actor) return actor;
      if (!getCookie(c, receptionCookieName(config.secure)) && await auth.api.getSession({ headers: c.req.raw.headers })) {
        throw new AttendanceError("FORBIDDEN", 403, "承認済みの受付端末から操作してください。");
      }
      throw new AttendanceError("UNAUTHENTICATED", 401, "受付端末の承認が必要です。管理者に確認してください。");
    },
  };
}
export type Authorization = ReturnType<typeof createAuthorization>;
