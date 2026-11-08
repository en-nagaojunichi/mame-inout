import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { deviceApplyInputSchema, deviceApprovalInputSchema, deviceNameInputSchema, type DeviceSummary } from "@mame/contracts";
import type { Prisma } from "./generated/prisma/client.js";
import type { Config } from "./config.js";
import type { Database } from "./db.js";
import { AttendanceError } from "./attendance.js";
import { assertAdministrator, type AdminActor } from "./identity.js";
import { hash, newToken } from "./setup.js";

type Tx = Prisma.TransactionClient;
const transactionOptions = { isolationLevel: "ReadCommitted" as const, timeout: 15000 };
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const DEVICE_APPLICATION_MS = 10 * 60_000;
const denied = () => new AttendanceError("APPLICATION_DENIED", 401, "このブラウザの申請を確認できません。受付端末の申請をやり直してください。");
const unavailable = () => new AttendanceError("DEVICE_UNAVAILABLE", 409, "この端末は利用できません。状態を確認して管理者へ連絡してください。");
const invalid = () => new AttendanceError("INVALID_INPUT", 422, "端末名と有効期間を確認してください。");

async function clock(tx: Tx) {
  return (await tx.$queryRaw<{ value: Date }[]>`SELECT clock_timestamp() AS value`)[0]!.value;
}

async function lockDevice(tx: Tx, id: string) {
  if (!uuidPattern.test(id)) throw invalid();
  // 打刻処理も同じ端末行をロックするため、失効完了後に古いCookieを受理しない。
  await tx.$queryRaw`SELECT id FROM "ReceptionDevice" WHERE id = ${id}::uuid FOR UPDATE`;
  const device = await tx.receptionDevice.findUnique({ where: { id } });
  if (!device) throw new AttendanceError("NOT_FOUND", 404, "対象の受付端末が見つかりません。");
  return device;
}

async function applicationByToken(tx: Tx, token: string) {
  if (!tokenPattern.test(token)) throw denied();
  const application = await tx.receptionApplication.findUnique({ where: { tokenHash: hash(token) } });
  if (!application) throw denied();
  return application;
}

type Device = Awaited<ReturnType<typeof lockDevice>>;
type Application = Awaited<ReturnType<typeof applicationByToken>>;

function summary(device: Device, application: Application | null, now: Date): DeviceSummary {
  const expired = device.status === "APPROVED"
    ? !device.expiresAt || device.expiresAt <= now
    : device.status === "PENDING" && application !== null && application.expiresAt <= now;
  return {
    id: device.id, name: device.name,
    status: expired ? "EXPIRED" : device.status as DeviceSummary["status"],
    confirmationCode: application && application.expiresAt > now && device.status === "PENDING" ? application.confirmationCode : null,
    applicationExpiresAt: application?.expiresAt.toISOString() ?? null,
    expiresAt: device.expiresAt?.toISOString() ?? null, approvedAt: device.approvedAt?.toISOString() ?? null,
    lastUsedAt: device.lastUsedAt?.toISOString() ?? null, createdAt: device.createdAt.toISOString(),
  };
}

export async function applyDevice(db: Database, input: { name: string }) {
  const parsed = deviceApplyInputSchema.safeParse(input);
  if (!parsed.success) throw invalid();
  const token = newToken();
  // 短い照合コードの衝突だけを再試行し、DB障害や制約違反を無制限に繰り返さない。
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await db.$transaction(async (tx) => {
        const now = await clock(tx);
        const device = await tx.receptionDevice.create({ data: { id: randomUUID(), name: parsed.data.name } });
        const application = await tx.receptionApplication.create({ data: {
          tokenHash: hash(token), deviceId: device.id, confirmationCode: randomBytes(4).toString("hex").toUpperCase(),
          createdAt: now, expiresAt: new Date(now.getTime() + DEVICE_APPLICATION_MS),
        } });
        await tx.auditEvent.create({ data: { action: "DEVICE_APPLIED", actorType: "SYSTEM", deviceId: device.id } });
        return { token, body: { device: summary(device, application, now), claimed: false } };
      }, transactionOptions);
    } catch (cause) {
      const error = cause as { code?: string; meta?: { target?: unknown } };
      if (error.code !== "P2002" || !JSON.stringify(error.meta?.target ?? "").includes("confirmationCode")) throw cause;
    }
  }
  throw new AttendanceError("UNAVAILABLE", 503, "申請を準備できませんでした。時間をおいてお試しください。");
}

export async function getDeviceApplication(db: Database, token: string) {
  return db.$transaction(async (tx) => {
    const application = await applicationByToken(tx, token);
    const now = await clock(tx);
    if (application.expiresAt <= now) throw denied();
    const device = await tx.receptionDevice.findUniqueOrThrow({ where: { id: application.deviceId } });
    return { device: summary(device, application, now), claimed: Boolean(application.claimedAt) };
  }, transactionOptions);
}

export async function claimDevice(db: Database, config: Pick<Config, "secret">, applicationToken: string) {
  return db.$transaction(async (tx) => {
    const candidate = await applicationByToken(tx, applicationToken);
    const device = await lockDevice(tx, candidate.deviceId);
    await tx.$queryRaw`SELECT "tokenHash" FROM "ReceptionApplication" WHERE "tokenHash" = ${candidate.tokenHash} FOR UPDATE`;
    const application = await applicationByToken(tx, applicationToken);
    const now = await clock(tx);
    if (application.expiresAt <= now) throw denied();
    if (device.status !== "APPROVED" || device.revokedAt || !device.approvedAt || device.approvedAt > now || !device.expiresAt || device.expiresAt <= now) throw unavailable();
    // Cookieだけ届かなかった再送にも同じ資格を返す。生値は保存せず、用途を分けたHMACで再構成する。
    const token = createHmac("sha256", config.secret).update(`mame-inout:device-claim:v1:${applicationToken}`).digest("base64url");
    const credential = await tx.receptionCredential.findUnique({ where: { tokenHash: hash(token) } });
    if (application.claimedAt) {
      if (!credential || credential.deviceId !== device.id || credential.revokedAt || credential.expiresAt <= now) throw unavailable();
      return { token, expiresAt: credential.expiresAt };
    }
    if (credential) throw unavailable();
    await tx.receptionCredential.create({ data: { id: randomUUID(), deviceId: device.id, tokenHash: hash(token), expiresAt: device.expiresAt, createdAt: now } });
    await tx.receptionApplication.update({ where: { tokenHash: application.tokenHash }, data: { claimedAt: now } });
    await tx.auditEvent.create({ data: { action: "DEVICE_CLAIMED", actorType: "RECEPTION", deviceId: device.id } });
    return { token, expiresAt: device.expiresAt };
  }, transactionOptions);
}

export async function listDevices(db: Database, query: { limit: number; cursor?: string }) {
  const rows = await db.receptionDevice.findMany({ where: { facilityId: 1, ...(query.cursor ? { id: { gt: query.cursor } } : {}) },
    include: { application: true }, orderBy: { id: "asc" }, take: query.limit + 1 });
  const now = await clock(db);
  return { items: rows.slice(0, query.limit).map((device) => summary(device, device.application, now)),
    nextCursor: rows.length > query.limit ? rows[query.limit - 1]!.id : null };
}

export async function getCurrentDevice(db: Database, deviceId: string) {
  const device = await db.receptionDevice.findUniqueOrThrow({ where: { id: deviceId } });
  return { device: summary(device, null, await clock(db)), claimed: true };
}

export async function renameDevice(db: Database, actor: AdminActor, deviceId: string, input: { name: string }) {
  const parsed = deviceNameInputSchema.safeParse(input);
  if (!parsed.success) throw new AttendanceError("INVALID_INPUT", 422, "端末名を1〜100文字で入力してください。");
  return db.$transaction(async (tx) => {
    // 名前だけの変更では追加の本人確認を求めず、管理者の失効は同じUser→端末の順序で再検査する。
    await assertAdministrator(tx, actor, false);
    const device = await lockDevice(tx, deviceId);
    await assertAdministrator(tx, actor, false);
    if (device.name === parsed.data.name) return { ok: true as const };
    // 状態・承認期限・申請コード・資格は変えず、既存Cookieと過去の入退出の紐付けを保持する。
    await tx.receptionDevice.update({ where: { id: device.id }, data: { name: parsed.data.name } });
    await tx.auditEvent.create({ data: { action: "DEVICE_RENAMED", actorType: "ADMIN", actorUserId: actor.userId, deviceId: device.id } });
    return { ok: true as const };
  }, transactionOptions);
}

export async function approveDevice(db: Database, actor: AdminActor, deviceId: string, input: { expiresInDays: number }) {
  const parsed = deviceApprovalInputSchema.safeParse(input);
  if (!parsed.success) throw invalid();
  return db.$transaction(async (tx) => {
    await assertAdministrator(tx, actor);
    const device = await lockDevice(tx, deviceId);
    await tx.$queryRaw`SELECT "tokenHash" FROM "ReceptionApplication" WHERE "deviceId" = ${device.id}::uuid FOR UPDATE`;
    const application = await tx.receptionApplication.findUnique({ where: { deviceId: device.id } });
    // 端末・申請のロック待ちの間に再認証期限を越えた場合も、重要操作を確定しない。
    await assertAdministrator(tx, actor);
    const now = await clock(tx);
    if (device.status !== "PENDING" || !application || application.expiresAt <= now) throw unavailable();
    const expiresAt = new Date(now.getTime() + parsed.data.expiresInDays * 86_400_000);
    await tx.receptionDevice.update({ where: { id: device.id }, data: { status: "APPROVED", approvedAt: now, approvedById: actor.userId, expiresAt } });
    await tx.auditEvent.create({ data: { action: "DEVICE_APPROVED", actorType: "ADMIN", actorUserId: actor.userId, deviceId: device.id,
      details: { expiresAt: expiresAt.toISOString() } } });
    return { ok: true as const };
  }, transactionOptions);
}

export async function rejectDevice(db: Database, actor: AdminActor, deviceId: string) {
  return db.$transaction(async (tx) => {
    await assertAdministrator(tx, actor);
    const device = await lockDevice(tx, deviceId);
    await assertAdministrator(tx, actor);
    if (device.status !== "PENDING") throw unavailable();
    await tx.receptionDevice.update({ where: { id: device.id }, data: { status: "REJECTED" } });
    await tx.auditEvent.create({ data: { action: "DEVICE_REJECTED", actorType: "ADMIN", actorUserId: actor.userId, deviceId: device.id } });
    return { ok: true as const };
  }, transactionOptions);
}

export async function revokeDevice(db: Database, actor: AdminActor, deviceId: string) {
  return db.$transaction(async (tx) => {
    await assertAdministrator(tx, actor);
    const device = await lockDevice(tx, deviceId);
    await assertAdministrator(tx, actor);
    const now = await clock(tx);
    if (device.status === "REVOKED") return { ok: true as const };
    await tx.receptionDevice.update({ where: { id: device.id }, data: { status: "REVOKED", revokedAt: now } });
    await tx.receptionCredential.updateMany({ where: { deviceId: device.id, revokedAt: null }, data: { revokedAt: now } });
    await tx.auditEvent.create({ data: { action: "DEVICE_REVOKED", actorType: "ADMIN", actorUserId: actor.userId, deviceId: device.id } });
    return { ok: true as const };
  }, transactionOptions);
}
