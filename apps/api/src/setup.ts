import { createHash, randomBytes, randomUUID } from "node:crypto";
import { APIError } from "better-auth/api";
import type { Prisma } from "./generated/prisma/client.js";
import type { Database } from "./db.js";

export const setupCookie = "mame_setup";
export const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export const newToken = () => randomBytes(32).toString("base64url");

export function setupToken(headers?: Headers) {
  return headers?.get("cookie")?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${setupCookie}=`))?.slice(setupCookie.length + 1) ?? "";
}

export async function loadAttempt(db: Prisma.TransactionClient, headers?: Headers) {
  const token = setupToken(headers);
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new APIError("FORBIDDEN", { message: "初期設定をやり直してください。" });
  const [attempt, state] = await Promise.all([
    db.setupAttempt.findUnique({ where: { tokenHash: hash(token) } }),
    db.setupState.findUnique({ where: { id: 1 } }),
  ]);
  if (!attempt || attempt.expiresAt <= new Date() || !state || state.completedAt ||
      !state.expiresAt || state.expiresAt <= new Date() || state.codeHash !== attempt.codeHash) {
    throw new APIError("FORBIDDEN", { message: "初期設定の有効期限が切れたか、すでに完了しています。" });
  }
  return attempt;
}

export async function beginSetup(db: Database, input: { code: string; name: string; email: string }) {
  const state = await db.setupState.findUnique({ where: { id: 1 } });
  if (!state || state.completedAt || !state.expiresAt || state.expiresAt <= new Date() || state.codeHash !== hash(input.code)) return null;
  const token = newToken();
  await db.setupAttempt.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  await db.setupAttempt.create({ data: {
    tokenHash: hash(token), codeHash: state.codeHash, userId: randomUUID(), name: input.name, email: input.email.toLowerCase(),
    expiresAt: new Date(Math.min(Date.now() + 5 * 60_000, state.expiresAt.getTime())),
  } });
  return token;
}

export async function completeSetup(tx: Prisma.TransactionClient, headers: Headers | undefined, userId: string) {
  // 全候補が同じ1行をロックし、コード消費・管理者・パスキー・セッションを同時に確定する。
  await tx.$queryRaw`SELECT id FROM "SetupState" WHERE id = 1 FOR UPDATE`;
  const attempt = await loadAttempt(tx, headers);
  if (attempt.userId !== userId) throw new APIError("FORBIDDEN", { message: "初期設定の申請が一致しません。" });
  await tx.user.create({ data: { id: attempt.userId, name: attempt.name, email: attempt.email, role: "ADMIN" } });
  await tx.setupState.update({ where: { id: 1 }, data: { completedAt: new Date(), codeHash: null, expiresAt: null } });
  await tx.setupAttempt.deleteMany();
}
