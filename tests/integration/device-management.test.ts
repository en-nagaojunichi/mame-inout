import { afterAll, describe, expect, it } from "vitest";
import { createHmac, randomUUID } from "node:crypto";
import { createDatabase, type Database } from "../../apps/api/src/db.js";
import { loadConfig } from "../../apps/api/src/config.js";
import { createApp } from "../../apps/api/src/app.js";
import { hash, newToken } from "../../apps/api/src/setup.js";
import { authenticateReception } from "../../apps/api/src/attendance.js";
import { applicationCookieName } from "../../apps/api/src/device-routes.js";
import { receptionCookieName } from "../../apps/api/src/authorization.js";
import { applyDevice, approveDevice, claimDevice, getDeviceApplication, rejectDevice, renameDevice, revokeDevice } from "../../apps/api/src/device-management.js";

if (!/^mame-inout-test(?:-|$)/.test(process.env.TEST_PROJECT ?? "")) throw new Error("独立したテスト用Composeプロジェクトが必要です。");
const config = loadConfig();
const db = createDatabase(config);
const app = createApp(db, config);
const createdUsers: string[] = [];
const createdDevices: string[] = [];
const createdPeople: string[] = [];

afterAll(async () => {
  await db.attendanceRequest.deleteMany({ where: { deviceId: { in: createdDevices } } });
  await db.attendanceVisit.deleteMany({ where: { personId: { in: createdPeople } } });
  await db.person.deleteMany({ where: { id: { in: createdPeople } } });
  await db.receptionDevice.deleteMany({ where: { id: { in: createdDevices } } });
  await db.user.deleteMany({ where: { id: { in: createdUsers } } });
  await db.$disconnect();
});

async function administrator(role = "ADMIN") {
  try {
    const user = await db.user.create({ data: { id: randomUUID(), name: "端末承認の確認者", email: `${randomUUID()}@example.test`, role } });
    createdUsers.push(user.id);
    const token = newToken();
    const session = await db.session.create({ data: { id: randomUUID(), userId: user.id, token,
      expiresAt: new Date(Date.now() + 300_000), authenticatedAt: new Date() } });
    const signature = createHmac("sha256", config.secret).update(token).digest("base64");
    return { actor: { userId: user.id, sessionId: session.id },
      cookie: `${config.secure ? "__Secure-" : ""}better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}` };
  } catch {
    throw new Error("端末管理テスト用の管理者を作成できませんでした。");
  }
}

async function application() {
  const result = await applyDevice(db, { name: "確認用の受付スマホ" });
  createdDevices.push(result.body.device.id);
  return { ...result, cookie: `${applicationCookieName(config.secure)}=${result.token}`, id: result.body.device.id };
}

async function resultCode(action: () => Promise<unknown>) {
  try { await action(); return null; } catch (cause) {
    const error = cause as { code?: unknown };
    return typeof error.code === "string" ? error.code : "UNEXPECTED_ERROR";
  }
}

function api(path: string, cookie?: string, body?: unknown, origin = config.origin) {
  return app.request(path, { ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
    headers: { origin, "X-Mame-Client-IP": `device-test-${randomUUID()}`, ...(cookie ? { cookie } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }) } });
}

function withoutNameAndUpdateTime(value: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "name" && key !== "updatedAt"));
}

describe("受付端末の申請と元ブラウザへの資格配布", () => {
  it("申請秘密はハッシュだけを保存し、確認コードでは状態確認も資格取得もできない", async () => {
    const target = await application();
    const stored = await db.receptionApplication.findUniqueOrThrow({ where: { deviceId: target.id } });
    expect(stored.tokenHash === hash(target.token)).toBe(true);
    expect(target.body.device.confirmationCode).toMatch(/^[0-9A-F]{8}$/);
    expect((await getDeviceApplication(db, target.token)).device.status).toBe("PENDING");
    expect(await resultCode(() => getDeviceApplication(db, target.body.device.confirmationCode!))).toBe("APPLICATION_DENIED");
    expect(await resultCode(() => claimDevice(db, config, target.body.device.confirmationCode!))).toBe("APPLICATION_DENIED");
    expect(await resultCode(() => claimDevice(db, config, newToken()))).toBe("APPLICATION_DENIED");
    expect(await resultCode(() => claimDevice(db, config, target.token))).toBe("DEVICE_UNAVAILABLE");
    expect(Object.keys(target.body.device)).not.toContain("tokenHash");
  });

  it("承認後の同時受取と応答消失後の再送は同じ資格1件になり、他ブラウザへ渡らない", async () => {
    const admin = await administrator();
    const target = await application();
    await approveDevice(db, admin.actor, target.id, { expiresInDays: 30 });
    // GETによる状態確認で資格を発行せず、明示的なPOSTの受取まで待つ。
    expect((await api("/api/devices/application", target.cookie)).status).toBe(200);
    expect((await api("/api/devices/claim", target.cookie)).status).toBe(404);
    expect(await db.receptionCredential.count({ where: { deviceId: target.id } })).toBe(0);
    expect((await db.receptionApplication.findUniqueOrThrow({ where: { deviceId: target.id } })).claimedAt).toBeNull();
    const [first, second] = await Promise.all([claimDevice(db, config, target.token), claimDevice(db, config, target.token)]);
    expect(first.token === second.token).toBe(true);
    const replay = await claimDevice(db, config, target.token);
    expect(first.token === replay.token).toBe(true);
    expect(await db.receptionCredential.count({ where: { deviceId: target.id } })).toBe(1);
    expect(await db.auditEvent.count({ where: { deviceId: target.id, action: "DEVICE_CLAIMED" } })).toBe(1);
    expect(await resultCode(() => claimDevice(db, { secret: newToken() }, target.token))).toBe("DEVICE_UNAVAILABLE");
    expect(await db.receptionCredential.count({ where: { deviceId: target.id } })).toBe(1);
    expect(Boolean(await authenticateReception(db, first.token))).toBe(true);
    expect((await getDeviceApplication(db, target.token)).claimed).toBe(true);
    expect((await api("/api/devices/claim", undefined, {})).status).toBe(401);
    expect((await api("/api/devices/claim", `${applicationCookieName(config.secure)}=${newToken()}`, {})).status).toBe(401);
  });

  it("同じ申請の承認と拒否を競合させても一方だけが確定する", async () => {
    const admin = await administrator();
    const target = await application();
    const results = await Promise.all([
      resultCode(() => approveDevice(db, admin.actor, target.id, { expiresInDays: 7 })),
      resultCode(() => rejectDevice(db, admin.actor, target.id)),
    ]);
    expect(results.filter((result) => result === null)).toHaveLength(1);
    expect(results.filter((result) => result === "DEVICE_UNAVAILABLE")).toHaveLength(1);
    expect(await db.auditEvent.count({ where: { deviceId: target.id, action: { in: ["DEVICE_APPROVED", "DEVICE_REJECTED"] } } })).toBe(1);
  });

  it("拒否・失効・期限切れでは既存Cookieと資格受取の再送を拒否する", async () => {
    const admin = await administrator();
    const rejected = await application();
    await rejectDevice(db, admin.actor, rejected.id);
    expect((await getDeviceApplication(db, rejected.token)).device.status).toBe("REJECTED");
    expect(await resultCode(() => claimDevice(db, config, rejected.token))).toBe("DEVICE_UNAVAILABLE");
    const target = await application();
    await approveDevice(db, admin.actor, target.id, { expiresInDays: 1 });
    const credential = await claimDevice(db, config, target.token);
    await revokeDevice(db, admin.actor, target.id);
    expect(await authenticateReception(db, credential.token)).toBeNull();
    expect(await resultCode(() => claimDevice(db, config, target.token))).toBe("DEVICE_UNAVAILABLE");
    expect((await api("/api/devices/current", `${receptionCookieName(config.secure)}=${credential.token}`)).status).toBe(401);
    const expired = await application();
    await approveDevice(db, admin.actor, expired.id, { expiresInDays: 1 });
    const oldCredential = await claimDevice(db, config, expired.token);
    await db.receptionDevice.update({ where: { id: expired.id }, data: { expiresAt: new Date(Date.now() - 60_000) } });
    expect(await authenticateReception(db, oldCredential.token)).toBeNull();
    expect(await resultCode(() => claimDevice(db, config, expired.token))).toBe("DEVICE_UNAVAILABLE");
  });

  it("申請の期限と承認の待機後の状態を再確認する", async () => {
    const admin = await administrator();
    const target = await application();
    const past = new Date(Date.now() - 60_000);
    await db.receptionApplication.update({ where: { deviceId: target.id }, data: { createdAt: new Date(past.getTime() - 60_000), expiresAt: past } });
    expect(await resultCode(() => getDeviceApplication(db, target.token))).toBe("APPLICATION_DENIED");
    expect(await resultCode(() => approveDevice(db, admin.actor, target.id, { expiresInDays: 1 }))).toBe("DEVICE_UNAVAILABLE");
    const pending = await application();
    await approveDevice(db, admin.actor, pending.id, { expiresInDays: 1 });
    let unlock!: () => void;
    let acquired!: () => void;
    const locked = new Promise<void>((resolve) => { acquired = resolve; });
    const release = new Promise<void>((resolve) => { unlock = resolve; });
    const blocker = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "ReceptionDevice" WHERE id = ${pending.id}::uuid FOR UPDATE`;
      acquired();
      await release;
      await tx.receptionDevice.update({ where: { id: pending.id }, data: { status: "REVOKED", revokedAt: new Date() } });
    });
    await locked;
    const claim = resultCode(() => claimDevice(db, config, pending.token));
    unlock();
    await blocker;
    expect(await claim).toBe("DEVICE_UNAVAILABLE");
    expect(await db.receptionCredential.count({ where: { deviceId: pending.id } })).toBe(0);
  });

  it("監査の保存に失敗すると承認・資格発行の両方をロールバックする", async () => {
    const admin = await administrator();
    const target = await application();
    let hookReached = false;
    const failing = db.$extends({ query: { auditEvent: { async create() { hookReached = true; throw new Error("監査保存失敗の検査"); } } } }) as unknown as Database;
    expect(await resultCode(() => approveDevice(failing, admin.actor, target.id, { expiresInDays: 1 }))).toBe("UNEXPECTED_ERROR");
    expect(hookReached).toBe(true);
    expect((await db.receptionDevice.findUniqueOrThrow({ where: { id: target.id } })).status).toBe("PENDING");
    await approveDevice(db, admin.actor, target.id, { expiresInDays: 1 });
    hookReached = false;
    expect(await resultCode(() => claimDevice(failing, config, target.token))).toBe("UNEXPECTED_ERROR");
    expect(hookReached).toBe(true);
    expect(await db.receptionCredential.count({ where: { deviceId: target.id } })).toBe(0);
    expect((await db.receptionApplication.findUniqueOrThrow({ where: { deviceId: target.id } })).claimedAt).toBeNull();
    const credential = await claimDevice(db, config, target.token);
    expect(Boolean(credential.token)).toBe(true);
    hookReached = false;
    expect(await resultCode(() => revokeDevice(failing, admin.actor, target.id))).toBe("UNEXPECTED_ERROR");
    expect(hookReached).toBe(true);
    expect(Boolean(await authenticateReception(db, credential.token))).toBe(true);
  });

  it("端末行のロック待ち中に再認証が古くなった場合は承認を確定しない", async () => {
    const admin = await administrator();
    const target = await application();
    let unlock!: () => void;
    let acquired!: () => void;
    const locked = new Promise<void>((resolve) => { acquired = resolve; });
    const release = new Promise<void>((resolve) => { unlock = resolve; });
    const blocker = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "ReceptionDevice" WHERE id = ${target.id}::uuid FOR UPDATE`;
      acquired();
      await release;
    }, { timeout: 15_000 });
    await locked;
    const approval = resultCode(() => approveDevice(db, admin.actor, target.id, { expiresInDays: 1 }));
    let observedWait = false;
    try {
      // 固定sleepで競合したと見なさず、実際に別接続がロックを待っていることを確認する。
      for (let i = 0; i < 50; i++) {
        const rows = await db.$queryRaw<{ waiting: boolean }[]>`
          SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE usename = current_user
            AND wait_event_type = 'Lock' AND query LIKE '%ReceptionDevice%' AND query LIKE '%FOR UPDATE%') AS waiting`;
        if (rows[0]?.waiting) { observedWait = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(observedWait).toBe(true);
      await db.session.update({ where: { id: admin.actor.sessionId }, data: { authenticatedAt: new Date(Date.now() - 6 * 60_000) } });
    } finally {
      unlock();
      await blocker;
    }
    expect(await approval).toBe("REAUTH_REQUIRED");
    expect((await db.receptionDevice.findUniqueOrThrow({ where: { id: target.id } })).status).toBe("PENDING");
  });
});

describe("受付端末APIの認可と応答", () => {
  it("資格をJSONへ載せずCookieだけで配布し、管理APIへの権限を与えない", async () => {
    const admin = await administrator();
    const target = await application();
    const approval = await api(`/api/admin/devices/${target.id}/approve`, admin.cookie, { expiresInDays: 30 });
    expect(approval.status).toBe(200);
    const response = await api("/api/devices/claim", target.cookie, {});
    expect(response.status).toBe(200);
    expect(Object.keys(await response.json()).sort()).toEqual(["expiresAt", "ok"]);
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie.includes("HttpOnly")).toBe(true);
    expect(cookie.includes("SameSite=Strict")).toBe(true);
    expect(cookie.includes("Path=/api")).toBe(true);
    if (config.secure) expect(cookie.includes("Secure")).toBe(true);
    const reception = cookie.split(";")[0]!;
    expect((await api("/api/devices/current", reception)).status).toBe(200);
    expect((await api("/api/admin/devices", reception)).status).toBe(403);
    expect((await api(`/api/admin/devices/${target.id}/revoke`, reception, {})).status).toBe(403);
    expect((await api("/api/devices/current", admin.cookie)).status).toBe(401);
    expect((await api("/api/admin/devices")).status).toBe(401);
  });

  it("過大な一覧・余分な入力・不正Origin・無権限の承認を拒否する", async () => {
    const admin = await administrator();
    const target = await application();
    expect((await api("/api/admin/devices?limit=101", admin.cookie)).status).toBe(422);
    expect((await api(`/api/admin/devices/${target.id}/approve`, admin.cookie, { expiresInDays: 91 })).status).toBe(422);
    expect((await api(`/api/admin/devices/${target.id}/approve`, admin.cookie, { expiresInDays: 1, extra: true })).status).toBe(422);
    expect((await api(`/api/admin/devices/${target.id}/approve`, undefined, { expiresInDays: 1 })).status).toBe(401);
    expect((await api(`/api/admin/devices/${target.id}/approve`, admin.cookie, { expiresInDays: 1 }, "https://invalid.example")).status).toBe(403);
    expect((await api("/api/devices/apply", undefined, { name: "受付", extra: true })).status).toBe(422);
    expect((await api("/api/devices/claim", target.cookie, { confirmationCode: target.body.device.confirmationCode })).status).toBe(422);
    const response = await api("/api/admin/devices?limit=1", admin.cookie);
    expect(response.status).toBe(200);
    const body = await response.json() as { items: Record<string, unknown>[] };
    expect(body.items).toHaveLength(1);
    expect(Object.keys(body.items[0]!)).not.toContain("credentials");
    expect(Object.keys(body.items[0]!)).not.toContain("tokenHash");
  });

  it("申請の10分が過ぎても承認済みの受付資格は本来の期限まで確認できる", async () => {
    const admin = await administrator();
    const target = await application();
    await approveDevice(db, admin.actor, target.id, { expiresInDays: 1 });
    const credential = await claimDevice(db, config, target.token);
    const past = new Date(Date.now() - 60_000);
    await db.receptionApplication.update({ where: { deviceId: target.id }, data: { createdAt: new Date(past.getTime() - 60_000), expiresAt: past } });
    expect((await api("/api/devices/application", target.cookie)).status).toBe(401);
    const current = await api("/api/devices/current", `${receptionCookieName(config.secure)}=${credential.token}`);
    expect(current.status).toBe(200);
    const body = await current.json() as { device: { id: string; status: string; confirmationCode: string | null } };
    expect(body.device.id).toBe(target.id);
    expect(body.device.status).toBe("APPROVED");
    expect(body.device.confirmationCode).toBeNull();
  });

  it("古い再認証と失効済みセッションでは、受付端末を承認できない", async () => {
    const admin = await administrator();
    const target = await application();
    await db.session.update({ where: { id: admin.actor.sessionId }, data: { authenticatedAt: new Date(Date.now() - 6 * 60_000) } });
    const stale = await api(`/api/admin/devices/${target.id}/approve`, admin.cookie, { expiresInDays: 1 });
    expect(stale.status).toBe(403);
    expect((await stale.json() as { code: string }).code).toBe("REAUTH_REQUIRED");
    await db.session.delete({ where: { id: admin.actor.sessionId } });
    expect((await api(`/api/admin/devices/${target.id}/approve`, admin.cookie, { expiresInDays: 1 })).status).toBe(401);
    expect((await db.receptionDevice.findUniqueOrThrow({ where: { id: target.id } })).status).toBe("PENDING");
  });

  it("端末申請の試行制限を永続化し、上限後の追加申請を作らない", async () => {
    const ip = `device-rate-${randomUUID()}`;
    for (let i = 0; i < 5; i++) {
      const response = await app.request("/api/devices/apply", { method: "POST", body: JSON.stringify({ name: "試行制限確認の受付" }),
        headers: { origin: config.origin, "content-type": "application/json", "X-Mame-Client-IP": ip } });
      expect(response.status).toBe(201);
      if (i === 0) {
        const cookie = response.headers.get("set-cookie") ?? "";
        expect(cookie.includes("HttpOnly")).toBe(true);
        expect(cookie.includes("SameSite=Strict")).toBe(true);
        expect(cookie.includes("Max-Age=600")).toBe(true);
        expect(cookie.includes("Path=/api")).toBe(true);
      }
      const body = await response.json() as { device: { id: string } };
      createdDevices.push(body.device.id);
    }
    const otherProcess = createApp(db, config);
    const limited = await otherProcess.request("/api/devices/apply", { method: "POST", body: JSON.stringify({ name: "作成されない受付" }),
      headers: { origin: config.origin, "content-type": "application/json", "X-Mame-Client-IP": ip } });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("900");
  });
});

describe("受付端末の名前だけを変更する", () => {
  it("再認証が古くても管理者は名前を変更でき、申請コードや期限を変えない", async () => {
    const admin = await administrator();
    const target = await application();
    await db.session.update({ where: { id: admin.actor.sessionId }, data: { authenticatedAt: new Date(Date.now() - 6 * 60_000) } });
    const before = await db.receptionDevice.findUniqueOrThrow({ where: { id: target.id } });
    const applicationBefore = await db.receptionApplication.findUniqueOrThrow({ where: { deviceId: target.id } });
    const response = await api(`/api/admin/devices/${target.id}/name`, admin.cookie, { name: "  正面入口の受付  " });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(response.headers.get("set-cookie")).toBeNull();
    const after = await db.receptionDevice.findUniqueOrThrow({ where: { id: target.id } });
    expect(after.name).toBe("正面入口の受付");
    expect(JSON.stringify(withoutNameAndUpdateTime(after)) === JSON.stringify(withoutNameAndUpdateTime(before))).toBe(true);
    // 失敗差分へ申請資格のハッシュやコードを出さず、同一性だけを比較する。
    expect(JSON.stringify(await db.receptionApplication.findUniqueOrThrow({ where: { deviceId: target.id } })) === JSON.stringify(applicationBefore)).toBe(true);
    expect(await db.receptionCredential.count({ where: { deviceId: target.id } })).toBe(0);
    expect((await getDeviceApplication(db, target.token)).device.name).toBe("正面入口の受付");
    expect(await db.auditEvent.count({ where: { deviceId: target.id, action: "DEVICE_RENAMED", actorUserId: admin.actor.userId } })).toBe(1);
  });

  it("承認済み端末の名前変更後も元のCookieと入室記録を保持し、同じ端末で退室できる", async () => {
    const admin = await administrator();
    const target = await application();
    await approveDevice(db, admin.actor, target.id, { expiresInDays: 1 });
    const credential = await claimDevice(db, config, target.token);
    const cookie = `${receptionCookieName(config.secure)}=${credential.token}`;
    const person = await db.person.create({ data: { displayName: "端末名変更の受付確認者" } });
    createdPeople.push(person.id);
    const qr = `mio1_${newToken()}`;
    await db.qrCredential.create({ data: { personId: person.id, tokenHash: hash(qr) } });
    const entryTicket = await api("/api/reception/requests", cookie, {});
    expect(entryTicket.status).toBe(201);
    const entry = await entryTicket.json() as { requestId: string };
    expect((await api("/api/reception/records", cookie, { requestId: entry.requestId, mode: "IN", qr })).status).toBe(200);
    const before = await db.receptionDevice.findUniqueOrThrow({ where: { id: target.id } });
    const credentialsBefore = await db.receptionCredential.findMany({ where: { deviceId: target.id } });
    const applicationBefore = await db.receptionApplication.findUniqueOrThrow({ where: { deviceId: target.id } });
    const visitBefore = await db.attendanceVisit.findFirstOrThrow({ where: { personId: person.id } });
    expect((await api(`/api/admin/devices/${target.id}/name`, admin.cookie, { name: "東側入口のQR受付" })).status).toBe(200);
    const after = await db.receptionDevice.findUniqueOrThrow({ where: { id: target.id } });
    expect(JSON.stringify(withoutNameAndUpdateTime(after)) === JSON.stringify(withoutNameAndUpdateTime(before))).toBe(true);
    expect(JSON.stringify(await db.receptionCredential.findMany({ where: { deviceId: target.id } })) === JSON.stringify(credentialsBefore)).toBe(true);
    expect(JSON.stringify(await db.receptionApplication.findUniqueOrThrow({ where: { deviceId: target.id } })) === JSON.stringify(applicationBefore)).toBe(true);
    expect(JSON.stringify(await db.attendanceVisit.findUniqueOrThrow({ where: { id: visitBefore.id } })) === JSON.stringify(visitBefore)).toBe(true);
    const current = await api("/api/devices/current", cookie);
    expect(current.status).toBe(200);
    expect((await current.json() as { device: { name: string } }).device.name).toBe("東側入口のQR受付");
    const exitTicket = await api("/api/reception/requests", cookie, {});
    expect(exitTicket.status).toBe(201);
    const exit = await exitTicket.json() as { requestId: string };
    const recorded = await api("/api/reception/records", cookie, { requestId: exit.requestId, mode: "OUT", qr });
    expect(recorded.status).toBe(200);
    expect((await recorded.json() as { outcome: string }).outcome).toBe("RECORDED");
    const visitAfter = await db.attendanceVisit.findUniqueOrThrow({ where: { id: visitBefore.id } });
    expect(visitAfter.createdByDeviceId).toBe(target.id);
    expect(visitAfter.enteredAt.getTime()).toBe(visitBefore.enteredAt.getTime());
    expect(visitAfter.exitedAt).not.toBeNull();
  });

  it("拒否・失効・期限切れの端末も名前だけを変更し、状態や資格を復活させない", async () => {
    const admin = await administrator();
    for (const status of ["REJECTED", "REVOKED", "EXPIRED"] as const) {
      const target = await application();
      if (status === "REJECTED") await rejectDevice(db, admin.actor, target.id);
      else {
        await approveDevice(db, admin.actor, target.id, { expiresInDays: 1 });
        if (status === "REVOKED") await revokeDevice(db, admin.actor, target.id);
        else await db.receptionDevice.update({ where: { id: target.id }, data: { expiresAt: new Date(Date.now() - 60_000) } });
      }
      const before = await db.receptionDevice.findUniqueOrThrow({ where: { id: target.id } });
      expect(await renameDevice(db, admin.actor, target.id, { name: "保管中の受付端末" })).toEqual({ ok: true });
      const after = await db.receptionDevice.findUniqueOrThrow({ where: { id: target.id } });
      expect(after.name).toBe("保管中の受付端末");
      expect(JSON.stringify(withoutNameAndUpdateTime(after)) === JSON.stringify(withoutNameAndUpdateTime(before))).toBe(true);
      expect((await getDeviceApplication(db, target.token)).device.status).toBe(status);
      expect(await resultCode(() => claimDevice(db, config, target.token))).toBe("DEVICE_UNAVAILABLE");
    }
  });

  it("空白・101文字・余分な状態指定と、未認証・受付だけ・失効済み管理者からの変更を拒否する", async () => {
    const admin = await administrator();
    const target = await application();
    const path = `/api/admin/devices/${target.id}/name`;
    for (const input of [{ name: "" }, { name: " \t " }, { name: "あ".repeat(101) }, { name: "受付", status: "APPROVED" }, { name: "受付", expiresInDays: 90 }]) {
      expect((await api(path, admin.cookie, input)).status).toBe(422);
    }
    expect((await api(path, admin.cookie, { name: "受付" }, "https://foreign.example")).status).toBe(403);
    expect((await api(path, undefined, { name: "受付" })).status).toBe(401);
    expect((await api(`/api/admin/devices/not-a-uuid/name`, admin.cookie, { name: "受付" })).status).toBe(422);
    expect((await api(`/api/admin/devices/${randomUUID()}/name`, admin.cookie, { name: "受付" })).status).toBe(404);
    expect((await api(path, admin.cookie, { name: "あ".repeat(100) })).status).toBe(200);
    await approveDevice(db, admin.actor, target.id, { expiresInDays: 1 });
    const credential = await claimDevice(db, config, target.token);
    const reception = `${receptionCookieName(config.secure)}=${credential.token}`;
    expect((await api(path, reception, { name: "受付からの変更" })).status).toBe(403);
    const nonAdmin = await administrator("VIEWER");
    expect((await api(path, nonAdmin.cookie, { name: "権限のない変更" })).status).toBe(403);
    await db.session.delete({ where: { id: admin.actor.sessionId } });
    expect((await api(path, admin.cookie, { name: "失効後の変更" })).status).toBe(401);
    expect((await db.receptionDevice.findUniqueOrThrow({ where: { id: target.id } })).name).toBe("あ".repeat(100));
  });

  it("名前変更と失効の同時操作でも名前と失効状態を両方保持する", async () => {
    const admin = await administrator();
    const target = await application();
    await approveDevice(db, admin.actor, target.id, { expiresInDays: 1 });
    const credential = await claimDevice(db, config, target.token);
    const before = await db.receptionDevice.findUniqueOrThrow({ where: { id: target.id } });
    const results = await Promise.all([
      resultCode(() => renameDevice(db, admin.actor, target.id, { name: "保管用に変更した受付" })),
      resultCode(() => revokeDevice(db, admin.actor, target.id)),
    ]);
    expect(results).toEqual([null, null]);
    const after = await db.receptionDevice.findUniqueOrThrow({ where: { id: target.id } });
    expect(after.name).toBe("保管用に変更した受付");
    expect(after.status).toBe("REVOKED");
    expect(after.approvedAt?.getTime()).toBe(before.approvedAt?.getTime());
    expect(after.expiresAt?.getTime()).toBe(before.expiresAt?.getTime());
    expect(await authenticateReception(db, credential.token)).toBeNull();
    expect(await db.auditEvent.count({ where: { deviceId: target.id, action: "DEVICE_RENAMED" } })).toBe(1);
    expect(await db.auditEvent.count({ where: { deviceId: target.id, action: "DEVICE_REVOKED" } })).toBe(1);
  });

  it("管理者行の待機中に利用停止された場合は名前を変更しない", async () => {
    const admin = await administrator();
    const target = await application();
    let unlock!: () => void;
    let acquired!: () => void;
    const locked = new Promise<void>((resolve) => { acquired = resolve; });
    const release = new Promise<void>((resolve) => { unlock = resolve; });
    const blocker = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${admin.actor.userId} FOR UPDATE`;
      acquired();
      await release;
      await tx.user.update({ where: { id: admin.actor.userId }, data: { status: "DISABLED" } });
    }, { timeout: 15_000 });
    await locked;
    const renaming = resultCode(() => renameDevice(db, admin.actor, target.id, { name: "確定しない変更" }));
    let observedWait = false;
    try {
      for (let i = 0; i < 50; i++) {
        const rows = await db.$queryRaw<{ waiting: boolean }[]>`
          SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE usename = current_user
            AND wait_event_type = 'Lock' AND query LIKE '%User%' AND query LIKE '%FOR UPDATE%') AS waiting`;
        if (rows[0]?.waiting) { observedWait = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(observedWait).toBe(true);
    } finally {
      unlock();
      await blocker;
    }
    expect(await renaming).toBe("UNAUTHENTICATED");
    expect((await db.receptionDevice.findUniqueOrThrow({ where: { id: target.id } })).name).toBe("確認用の受付スマホ");
    expect(await db.auditEvent.count({ where: { deviceId: target.id, action: "DEVICE_RENAMED" } })).toBe(0);
  });

  it("監査保存に失敗した名前変更はロールバックする", async () => {
    const admin = await administrator();
    const target = await application();
    let reached = false;
    const failing = db.$extends({ query: { auditEvent: { async create() { reached = true; throw new Error("名前変更の監査失敗検査"); } } } }) as unknown as Database;
    expect(await resultCode(() => renameDevice(failing, admin.actor, target.id, { name: "保存されない名前" }))).toBe("UNEXPECTED_ERROR");
    expect(reached).toBe(true);
    expect((await db.receptionDevice.findUniqueOrThrow({ where: { id: target.id } })).name).toBe("確認用の受付スマホ");
  });

  it("端末行の待機後に管理者セッションが期限切れなら名前変更を確定しない", async () => {
    const admin = await administrator();
    const target = await application();
    let unlock!: () => void;
    let acquired!: () => void;
    const locked = new Promise<void>((resolve) => { acquired = resolve; });
    const release = new Promise<void>((resolve) => { unlock = resolve; });
    const blocker = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "ReceptionDevice" WHERE id = ${target.id}::uuid FOR UPDATE`;
      acquired();
      await release;
    }, { timeout: 15_000 });
    await locked;
    const renaming = resultCode(() => renameDevice(db, admin.actor, target.id, { name: "期限切れで保存しない名前" }));
    let observedWait = false;
    try {
      for (let i = 0; i < 50; i++) {
        const rows = await db.$queryRaw<{ waiting: boolean }[]>`
          SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE usename = current_user
            AND wait_event_type = 'Lock' AND query LIKE '%ReceptionDevice%' AND query LIKE '%FOR UPDATE%') AS waiting`;
        if (rows[0]?.waiting) { observedWait = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(observedWait).toBe(true);
      await db.session.update({ where: { id: admin.actor.sessionId }, data: { expiresAt: new Date(Date.now() - 60_000) } });
    } finally {
      unlock();
      await blocker;
    }
    expect(await renaming).toBe("UNAUTHENTICATED");
    expect((await db.receptionDevice.findUniqueOrThrow({ where: { id: target.id } })).name).toBe("確認用の受付スマホ");
    expect(await db.auditEvent.count({ where: { deviceId: target.id, action: "DEVICE_RENAMED" } })).toBe(0);
  });
});
