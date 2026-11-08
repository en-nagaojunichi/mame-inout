import { randomUUID } from "node:crypto";
import type { Prisma } from "./generated/prisma/client.js";
import type { Database } from "./db.js";
import { AttendanceError } from "./attendance-rules.js";
import { hash, newToken, loadAttempt, completeSetup } from "./setup.js";

type Tx = Prisma.TransactionClient;
export type AdminActor = { userId: string; sessionId: string };
const options = { timeout: 15_000, maxWait: 15_000 };
export const registrationCookieName = (secure: boolean) => secure ? "__Secure-mame-registration" : "mame_registration";
const denied = () => new AttendanceError("REGISTRATION_DENIED", 403, "コードが無効か、有効期限が切れています。発行した管理者に確認してください。");
export const registrationToken = (headers?: Headers) => {
  const cookies = headers?.get("cookie")?.split(";").map((part) => part.trim()) ?? [];
  return cookies.find((part) => part.startsWith("__Secure-mame-registration="))?.slice(27) ??
    cookies.find((part) => part.startsWith("mame_registration="))?.slice(18) ?? "";
};

export async function identityClock(tx: Tx) {
  const rows = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
  return rows[0]!.now;
}

async function checkSession(tx: Tx, actor: AdminActor, recent: boolean) {
  const now = await identityClock(tx);
  const session = await tx.session.findUnique({ where: { id: actor.sessionId }, include: { user: true } });
  if (!session || session.userId !== actor.userId || session.expiresAt <= now ||
      session.createdAt.getTime() <= now.getTime() - 12 * 60 * 60_000 ||
      session.lastActivityAt.getTime() <= now.getTime() - 30 * 60_000 || session.user.status !== "ACTIVE") {
    throw new AttendanceError("UNAUTHENTICATED", 401, "ログインの有効期限が切れています。パスキーでログインしてください。");
  }
  if (session.user.role !== "ADMIN") throw new AttendanceError("FORBIDDEN", 403, "管理者の権限が必要です。");
  if (recent && (!session.authenticatedAt || session.authenticatedAt.getTime() <= now.getTime() - 5 * 60_000)) {
    throw new AttendanceError("REAUTH_REQUIRED", 403, "この操作には、もう一度パスキーでの本人確認が必要です。");
  }
  return session;
}

export async function assertAdministrator(tx: Tx, actor: AdminActor, recent = true) {
  // 失効・復旧・重要操作が同じ管理者行をロックし、待機後にもセッションを再検証する。
  await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${actor.userId} FOR UPDATE`;
  return checkSession(tx, actor, recent);
}

export async function validateAdminSession(db: Database, sessionId: string, recent = false) {
  return db.$transaction(async (tx) => {
    const session = await tx.session.findUnique({ where: { id: sessionId } });
    if (!session) throw new AttendanceError("UNAUTHENTICATED", 401, "パスキーでログインしてください。");
    const actor = { userId: session.userId, sessionId };
    const checked = await assertAdministrator(tx, actor, recent);
    // 期限切れを先に拒否するため、無操作期限を過ぎたCookieが操作で復活することはない。
    await tx.session.update({ where: { id: sessionId }, data: { lastActivityAt: await identityClock(tx) } });
    return { ...actor, name: checked.user.name, email: checked.user.email, emailVerified: checked.user.emailVerified };
  }, options);
}

async function audit(tx: Tx, action: string, actorUserId: string, targetId?: string) {
  await tx.auditEvent.create({ data: { action, actorType: "ADMIN", actorUserId, details: targetId ? { targetId } : {} } });
}

export async function issueInvitation(db: Database, actor: AdminActor, input: { name: string; email: string }) {
  return db.$transaction(async (tx) => {
    await assertAdministrator(tx, actor);
    if (await tx.user.findFirst({ where: { email: { equals: input.email, mode: "insensitive" } } })) throw new AttendanceError("EMAIL_IN_USE", 409, "このメールアドレスは登録済みです。");
    const code = newToken();
    const expiresAt = new Date((await identityClock(tx)).getTime() + 15 * 60_000);
    const invitation = await tx.adminInvitation.create({ data: { ...input, codeHash: hash(code), expiresAt, createdById: actor.userId } });
    await audit(tx, "ADMIN_INVITED", actor.userId, invitation.id);
    return { code, expiresAt: expiresAt.toISOString() };
  }, options);
}

async function validInvitation(tx: Tx, id: string) {
  const invitation = await tx.adminInvitation.findUnique({ where: { id }, include: { createdBy: true } });
  if (!invitation || invitation.usedAt || invitation.expiresAt <= await identityClock(tx) ||
      invitation.createdBy?.role !== "ADMIN" || invitation.createdBy.status !== "ACTIVE") throw denied();
  return invitation;
}

export async function beginInvitation(db: Database, input: { code: string }) {
  return db.$transaction(async (tx) => {
    const invitation = await tx.adminInvitation.findUnique({ where: { codeHash: hash(input.code) } });
    if (!invitation) throw denied();
    const checked = await validInvitation(tx, invitation.id);
    const token = newToken();
    const now = await identityClock(tx);
    await tx.registrationAttempt.create({ data: { tokenHash: hash(token), kind: "INVITE", userId: randomUUID(), invitationId: invitation.id,
      expiresAt: new Date(Math.min(now.getTime() + 5 * 60_000, invitation.expiresAt.getTime())) } });
    return { token, name: checked.name, email: checked.email };
  }, options);
}

export async function beginPasskeyAddition(db: Database, actor: AdminActor) {
  return db.$transaction(async (tx) => {
    const session = await assertAdministrator(tx, actor);
    const token = newToken();
    await tx.registrationAttempt.create({ data: { tokenHash: hash(token), kind: "ADD", userId: actor.userId, sessionId: actor.sessionId,
      version: session.user.authVersion, expiresAt: new Date((await identityClock(tx)).getTime() + 5 * 60_000) } });
    return token;
  }, options);
}

export async function generateRecoveryCodes(db: Database, actor: AdminActor) {
  return db.$transaction(async (tx) => {
    await assertAdministrator(tx, actor);
    const codes = Array.from({ length: 8 }, () => newToken());
    await tx.recoveryCode.deleteMany({ where: { userId: actor.userId } });
    await tx.registrationAttempt.deleteMany({ where: { userId: actor.userId, kind: "RECOVER" } });
    await tx.recoveryCode.createMany({ data: codes.map((code) => ({ codeHash: hash(code), userId: actor.userId })) });
    await audit(tx, "RECOVERY_CODES_REPLACED", actor.userId);
    return codes;
  }, options);
}

export async function beginRecovery(db: Database, input: { email: string; code: string }) {
  return db.$transaction(async (tx) => {
    // 旧版で大文字を含むメールを登録していても、同じ識別情報で復旧できるようにする。
    const user = await tx.user.findFirst({ where: { email: { equals: input.email, mode: "insensitive" } } });
    if (!user) throw denied();
    await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${user.id} FOR UPDATE`;
    const current = await tx.user.findUniqueOrThrow({ where: { id: user.id } });
    if (current.role !== "ADMIN" || current.status !== "ACTIVE") throw denied();
    const now = await identityClock(tx);
    const consumed = await tx.recoveryCode.updateMany({ where: { codeHash: hash(input.code), userId: user.id, usedAt: null }, data: { usedAt: now } });
    if (consumed.count !== 1) throw denied();
    const token = newToken();
    await tx.registrationAttempt.create({ data: { tokenHash: hash(token), kind: "RECOVER", userId: user.id, version: current.authVersion,
      expiresAt: new Date(now.getTime() + 5 * 60_000) } });
    await audit(tx, "ADMIN_RECOVERY_STARTED", user.id);
    return { token, name: current.name, email: current.email };
  }, options);
}

async function validRegistration(tx: Tx, headers?: Headers) {
  const token = registrationToken(headers);
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw denied();
  const attempt = await tx.registrationAttempt.findUnique({ where: { tokenHash: hash(token) } });
  if (!attempt || attempt.expiresAt <= await identityClock(tx)) throw denied();
  return attempt;
}

export async function resolveRegistration(db: Database, headers?: Headers) {
  if (!registrationToken(headers)) {
    const attempt = await loadAttempt(db, headers);
    return { id: attempt.userId, name: attempt.email, displayName: attempt.name };
  }
  const attempt = await validRegistration(db, headers);
  if (attempt.kind === "INVITE" && attempt.invitationId) {
    const invitation = await validInvitation(db, attempt.invitationId);
    return { id: attempt.userId, name: invitation.email, displayName: invitation.name };
  }
  const user = await db.user.findUnique({ where: { id: attempt.userId } });
  if (!user || user.status !== "ACTIVE" || user.role !== "ADMIN" || user.authVersion !== attempt.version) throw denied();
  if (attempt.kind === "ADD") await checkSession(db, { userId: user.id, sessionId: attempt.sessionId ?? "" }, true);
  return { id: user.id, name: user.email, displayName: user.name };
}

export async function completeRegistration(tx: Tx, headers: Headers | undefined, userId: string, currentSessionId?: string) {
  if (!registrationToken(headers)) return completeSetup(tx, headers, userId);
  let attempt = await validRegistration(tx, headers);
  if (attempt.userId !== userId) throw denied();
  if (attempt.kind === "INVITE" && attempt.invitationId) {
    // 招待者の停止と招待の単回消費を直列化し、登録失敗時は消費も戻す。
    const candidate = await validInvitation(tx, attempt.invitationId);
    await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${candidate.createdById} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "AdminInvitation" WHERE id = ${candidate.id}::uuid FOR UPDATE`;
    const invitation = await validInvitation(tx, candidate.id);
    attempt = await validRegistration(tx, headers);
    if (await tx.user.findFirst({ where: { email: { equals: invitation.email, mode: "insensitive" } } })) {
      throw new AttendanceError("EMAIL_IN_USE", 409, "このメールアドレスは登録済みです。");
    }
    await tx.user.create({ data: { id: userId, name: invitation.name, email: invitation.email, role: "ADMIN" } });
    await tx.adminInvitation.update({ where: { id: invitation.id }, data: { usedAt: await identityClock(tx) } });
    await audit(tx, "ADMIN_INVITATION_ACCEPTED", userId, invitation.id);
  } else {
    await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId} FOR UPDATE`;
    attempt = await validRegistration(tx, headers);
    const user = await tx.user.findUnique({ where: { id: userId } });
    if (!user || user.role !== "ADMIN" || user.status !== "ACTIVE" || user.authVersion !== attempt.version) throw denied();
    if (attempt.kind === "ADD") {
      if (attempt.sessionId !== currentSessionId) throw denied();
      await assertAdministrator(tx, { userId, sessionId: attempt.sessionId ?? "" });
      if (await tx.passkey.count({ where: { userId } }) >= 20) {
        throw new AttendanceError("PASSKEY_LIMIT", 409, "パスキーは20件まで登録できます。使わないパスキーを失効してから追加してください。");
      }
      await audit(tx, "PASSKEY_ADDED", userId);
    } else if (attempt.kind === "RECOVER") {
      // 復旧が確定するまでは旧資格を保持し、確定時は新しいパスキーと同じTxで全失効する。
      await tx.session.deleteMany({ where: { userId } });
      await tx.passkey.deleteMany({ where: { userId } });
      await tx.recoveryCode.deleteMany({ where: { userId } });
      await tx.registrationAttempt.deleteMany({ where: { userId } });
      await tx.user.update({ where: { id: userId }, data: { authVersion: { increment: 1 } } });
      await audit(tx, "ADMIN_RECOVERED", userId);
    } else throw denied();
  }
  await tx.registrationAttempt.deleteMany({ where: { tokenHash: attempt.tokenHash } });
}

export async function renamePasskey(db: Database, actor: AdminActor, id: string, name: string) {
  await db.$transaction(async (tx) => {
    await assertAdministrator(tx, actor);
    const changed = await tx.passkey.updateMany({ where: { id, userId: actor.userId }, data: { name } });
    if (!changed.count) throw new AttendanceError("NOT_FOUND", 404, "パスキーが見つかりません。");
    await audit(tx, "PASSKEY_RENAMED", actor.userId, id);
  }, options);
}

export async function revokePasskey(db: Database, actor: AdminActor, id: string) {
  await db.$transaction(async (tx) => {
    await assertAdministrator(tx, actor);
    const key = await tx.passkey.findFirst({ where: { id, userId: actor.userId } });
    if (!key) throw new AttendanceError("NOT_FOUND", 404, "パスキーが見つかりません。");
    if (await tx.passkey.count({ where: { userId: actor.userId } }) <= 1) {
      throw new AttendanceError("LAST_PASSKEY", 409, "最後のパスキーは失効できません。先に別のパスキーを追加してください。");
    }
    await tx.passkey.delete({ where: { id } });
    // どのパスキーで作ったか不明な旧版セッションも、失効する側へ倒す。
    await tx.session.deleteMany({ where: { userId: actor.userId, OR: [{ passkeyId: id }, { passkeyId: null }] } });
    await audit(tx, "PASSKEY_REVOKED", actor.userId, id);
  }, options);
}

export async function renameAdministrator(db: Database, actor: AdminActor, id: string, name: string) {
  await db.$transaction(async (tx) => {
    // 相互の名前変更と管理者停止を同じ順序でロックし、別々の管理者行での待ち合いを防ぐ。
    await tx.$queryRaw`SELECT id FROM "SetupState" WHERE id = 1 FOR UPDATE`;
    await assertAdministrator(tx, actor, false);
    await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${id} FOR UPDATE`;
    // 対象のロック待機中に期限が切れた場合も拒否する。表示名の変更だけでは再認証を要求しない。
    await assertAdministrator(tx, actor, false);
    const target = await tx.user.findUnique({ where: { id } });
    if (!target || target.role !== "ADMIN") throw new AttendanceError("NOT_FOUND", 404, "管理者が見つかりません。");
    await tx.user.update({ where: { id }, data: { name } });
    // 監査には対象IDだけを残し、個人名や認証資格を複製しない。
    await audit(tx, "ADMIN_RENAMED", actor.userId, id);
  }, options);
}

export async function disableAdministrator(db: Database, actor: AdminActor, id: string) {
  await db.$transaction(async (tx) => {
    // 対象が異なる同時停止でも、最後の有効管理者を残す共通ロックを先に取る。
    await tx.$queryRaw`SELECT id FROM "SetupState" WHERE id = 1 FOR UPDATE`;
    await assertAdministrator(tx, actor);
    await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${id} FOR UPDATE`;
    await assertAdministrator(tx, actor);
    const target = await tx.user.findUnique({ where: { id } });
    if (!target || target.role !== "ADMIN") throw new AttendanceError("NOT_FOUND", 404, "管理者が見つかりません。");
    if (target.status !== "ACTIVE") return;
    if (await tx.user.count({ where: { role: "ADMIN", status: "ACTIVE" } }) <= 1) {
      throw new AttendanceError("LAST_ADMIN", 409, "最後の有効な管理者は停止できません。先に別の管理者を登録してください。");
    }
    await tx.user.update({ where: { id }, data: { status: "DISABLED", authVersion: { increment: 1 } } });
    await tx.session.deleteMany({ where: { userId: id } });
    await tx.passkey.deleteMany({ where: { userId: id } });
    await tx.recoveryCode.deleteMany({ where: { userId: id } });
    await tx.registrationAttempt.deleteMany({ where: { userId: id } });
    await audit(tx, "ADMIN_DISABLED", actor.userId, id);
  }, options);
}

export async function getSecurity(db: Database, actor: AdminActor, adminsCursor?: string) {
  return db.$transaction(async (tx) => {
    const session = await assertAdministrator(tx, actor, false);
    const [keys, recoveryCount, admins] = await Promise.all([
      tx.passkey.findMany({ where: { userId: actor.userId }, orderBy: { createdAt: "asc" }, select: { id: true, name: true, createdAt: true, lastUsedAt: true } }),
      tx.recoveryCode.count({ where: { userId: actor.userId, usedAt: null } }),
      tx.user.findMany({ where: { role: "ADMIN", ...(adminsCursor ? { id: { gt: adminsCursor } } : {}) }, orderBy: { id: "asc" }, take: 101, select: { id: true, name: true, email: true, emailVerified: true, status: true } }),
    ]);
    return { currentUserId: actor.userId, passkeys: keys.map((key) => ({ ...key, createdAt: key.createdAt.toISOString(), lastUsedAt: key.lastUsedAt?.toISOString() ?? null })),
      recoveryConfigured: recoveryCount > 0, recentAuth: Boolean(session.authenticatedAt && session.authenticatedAt.getTime() > (await identityClock(tx)).getTime() - 5 * 60_000),
      admins: admins.slice(0, 100), adminsNextCursor: admins.length > 100 ? admins[99]!.id : null };
  }, options);
}
