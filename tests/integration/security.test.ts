import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHmac, randomUUID } from "node:crypto";
import { createApp } from "../../apps/api/src/app.js";
import { createDatabase } from "../../apps/api/src/db.js";
import { loadConfig } from "../../apps/api/src/config.js";
import { receptionCookieName } from "../../apps/api/src/authorization.js";
import { hash, newToken } from "../../apps/api/src/setup.js";

// HTTP横断の試験も、使い捨ての専用DB以外では実行しない。
if (!/^mame-inout-test(?:-|$)/.test(process.env.TEST_PROJECT ?? "")) throw new Error("独立したテスト用Composeプロジェクトが必要です。");
const config = loadConfig(), db = createDatabase(config), app = createApp(db, config);
const users: string[] = [], devices: string[] = [];
const id = "00000000-0000-4000-8000-000000000007";
type ProtectedRoute = { method: string; template: string; body?: unknown };
const adminRoutes: ProtectedRoute[] = [
  ...["/me", "/facility", "/dashboard", "/presence", "/attendance", "/attendance.csv", "/attendance/:id", "/security", "/devices", "/people", "/people/:id", "/appearance", "/privacy", "/diagnostics", "/people/:id/deletion-preview"]
    .map((path) => ({ method: "GET", template: `/api/admin${path}` })),
  ...["/passkeys/begin", "/passkeys/:id/revoke", "/recovery-codes", "/administrators/:id/disable", "/devices/:id/reject", "/devices/:id/revoke"]
    .map((path) => ({ method: "POST", template: `/api/admin${path}`, body: {} })),
  ...["/passkeys/:id/name", "/administrators/:id/name", "/devices/:id/name"]
    .map((path) => ({ method: "POST", template: `/api/admin${path}`, body: { name: "境界確認" } })),
  { method: "POST", template: "/api/admin/invitations", body: { name: "境界確認", email: "security@example.test" } },
  { method: "POST", template: "/api/admin/devices/:id/approve", body: { expiresInDays: 30 } },
  { method: "POST", template: "/api/admin/people", body: { displayName: "作成されない利用者" } },
  { method: "PATCH", template: "/api/admin/people/:id", body: { displayName: "変更されない利用者", expectedVersion: 1 } },
  { method: "PUT", template: "/api/admin/people/:id/status", body: { status: "ACTIVE", expectedVersion: 1 } },
  { method: "POST", template: "/api/admin/people/:id/qr-credentials", body: { expectedVersion: 1 } },
  { method: "DELETE", template: "/api/admin/people/:id/qr-credentials/current", body: { expectedVersion: 1 } },
  { method: "POST", template: "/api/admin/attendance", body: { requestId: id, personId: id, enteredAt: "2024-01-01T00:00:00Z", exitedAt: "2024-01-01T01:00:00Z", reason: "拒否検査" } },
  { method: "PATCH", template: "/api/admin/attendance/:id", body: { expectedVersion: 1, enteredAt: "2024-01-01T00:00:00Z", exitedAt: "2024-01-01T01:00:00Z", cancel: false, reason: "拒否検査" } },
  { method: "PUT", template: "/api/admin/appearance", body: { displayName: "保存されない表示名", expectedVersion: 1 } },
  { method: "POST", template: "/api/admin/privacy/retention-preview", body: { days: 365 } },
  { method: "PUT", template: "/api/admin/privacy/retention", body: { days: 365, expectedVersion: 1, confirmationToken: "not-a-confirmation" } },
  { method: "POST", template: "/api/admin/people/:id/deletion", body: { operationId: id, expectedVersion: 1 } },
];
function request(route: ProtectedRoute, cookie?: string, contentType = "application/json") {
  return app.request(route.template.replace(":id", id), { method: route.method,
    headers: { origin: config.origin, "X-Mame-Client-IP": `security-${randomUUID()}`, ...(cookie ? { cookie } : {}),
      ...(route.body === undefined ? {} : { "content-type": contentType }) },
    ...(route.body === undefined ? {} : { body: JSON.stringify(route.body) }) });
}
function protectedHeaders(response: Response) {
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(response.headers.has("set-cookie")).toBe(false);
}
async function administrator(role = "ADMIN") {
  const user = await db.user.create({ data: { id: randomUUID(), name: "HTTP境界の検査者", email: `${randomUUID()}@example.test`, role } });
  users.push(user.id);
  const token = newToken(), signature = createHmac("sha256", config.secret).update(token).digest("base64");
  const session = await db.session.create({ data: { id: randomUUID(), userId: user.id, token,
    expiresAt: new Date(Date.now() + 3_600_000), authenticatedAt: new Date() } });
  return { user, session, cookie: `${config.secure ? "__Secure-" : ""}better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}` };
}
let manager: Awaited<ReturnType<typeof administrator>>, outsider: Awaited<ReturnType<typeof administrator>>, receptionCookie: string;
beforeAll(async () => {
  try {
    manager = await administrator(); outsider = await administrator("RECEPTION");
    const expiresAt = new Date(Date.now() + 3_600_000), token = newToken();
    const device = await db.receptionDevice.create({ data: { name: "横断認可用受付", status: "APPROVED", approvedAt: new Date(), approvedById: manager.user.id, expiresAt } });
    devices.push(device.id);
    await db.receptionCredential.create({ data: { deviceId: device.id, tokenHash: hash(token), expiresAt } });
    receptionCookie = `${receptionCookieName(config.secure)}=${token}`;
  } catch { throw new Error("HTTP境界のテスト資格を準備できませんでした。"); }
});
afterAll(async () => {
  await db.attendanceRequest.deleteMany({ where: { deviceId: { in: devices } } });
  await db.receptionDevice.deleteMany({ where: { id: { in: devices } } });
  await db.user.deleteMany({ where: { id: { in: users } } });
  await db.$disconnect();
});

describe("全管理APIの認可マトリクス", () => {
  it("追加・削除された管理経路をマトリクスの点検漏れにしない", () => {
    const actual = app.routes.filter((route) => route.path.startsWith("/api/admin/") && route.method !== "ALL" && !route.path.includes("*"))
      .map((route) => `${route.method} ${route.path}`).sort();
    expect(adminRoutes.map((route) => `${route.method} ${route.template}`).sort()).toEqual(actual);
  });
  for (const kind of ["未認証", "受付端末Cookie", "管理者以外のセッション"] as const) {
    it(`${kind}で名簿・履歴・CSV・設定を取得変更できない`, async () => {
      const cookie = kind === "未認証" ? undefined : kind === "受付端末Cookie" ? receptionCookie : outsider.cookie;
      const expected = kind === "未認証" ? 401 : 403;
      const before = { people: await db.person.count(), visits: await db.attendanceVisit.count(), deletion: await db.deletionInstruction.count(),
        appearance: await db.appearance.findUniqueOrThrow({ where: { id: 1 } }), policy: await db.retentionPolicy.findUniqueOrThrow({ where: { id: 1 } }) };
      for (const route of adminRoutes) {
        const response = await request(route, cookie);
        expect(response.status, `${route.method} ${route.template}`).toBe(expected); protectedHeaders(response);
        // 失敗差分にCookie・DB資格・QRなどの値を複製しない。
        const body = await response.text();
        expect([config.secret, config.database.password, cookie].some((value) => value && body.includes(value))).toBe(false);
      }
      expect({ people: await db.person.count(), visits: await db.attendanceVisit.count(), deletion: await db.deletionInstruction.count(),
        appearance: await db.appearance.findUniqueOrThrow({ where: { id: 1 } }), policy: await db.retentionPolicy.findUniqueOrThrow({ where: { id: 1 } }) }).toEqual(before);
    });
  }
  it("形式エラーでも、認可が先の経路では未認証と受付権限違反を先に拒否する", async () => {
    for (const route of adminRoutes.filter((route) => route.body !== undefined && !["/api/admin/passkeys", "/api/admin/recovery-codes", "/api/admin/invitations", "/api/admin/administrators"].some((prefix) => route.template.startsWith(prefix)))) {
      expect((await request(route, undefined, "text/plain")).status, route.template).toBe(401);
      expect((await request(route, receptionCookie, "text/plain")).status, route.template).toBe(403);
    }
  });
});

describe("実Cookieと入力境界", () => {
  it("管理者と受付端末でもJSON以外の本文から業務変更を行わない", async () => {
    const before = { people: await db.person.count(), requests: await db.attendanceRequest.count(), appearance: await db.appearance.findUniqueOrThrow({ where: { id: 1 } }) };
    const routes = adminRoutes.filter((route) => ["/api/admin/people", "/api/admin/appearance", "/api/admin/privacy/retention-preview"].includes(route.template) && route.body !== undefined);
    for (const route of routes) {
      const response = await request(route, manager.cookie, "text/plain");
      expect(response.status, route.template).toBe(415); protectedHeaders(response);
    }
    const response = await request({ method: "POST", template: "/api/reception/requests", body: {} }, receptionCookie, "text/plain");
    expect(response.status).toBe(415); protectedHeaders(response);
    expect({ people: await db.person.count(), requests: await db.attendanceRequest.count(), appearance: await db.appearance.findUniqueOrThrow({ where: { id: 1 } }) }).toEqual(before);
  });
  it("管理者Cookieを受付資格に転用できず、失効した受付Cookieも既存APIから拒否する", async () => {
    const route = { method: "POST", template: "/api/reception/requests", body: {} };
    expect((await request(route, manager.cookie)).status).toBe(403);
    await db.receptionCredential.updateMany({ where: { deviceId: { in: devices } }, data: { revokedAt: new Date() } });
    try {
      const response = await request(route, receptionCookie);
      expect(response.status).toBe(401); protectedHeaders(response);
    } finally { await db.receptionCredential.updateMany({ where: { deviceId: { in: devices } }, data: { revokedAt: null } }); }
  });
  it("無操作・絶対期限・失効が別モジュールのAPIへも直ちに反映する", async () => {
    const probes = adminRoutes.filter((route) => ["/api/admin/me", "/api/admin/appearance", "/api/admin/diagnostics"].includes(route.template) && route.method === "GET");
    for (const expiry of [
      { lastActivityAt: new Date(Date.now() - 31 * 60_000) },
      { createdAt: new Date(Date.now() - 13 * 3_600_000) },
      { expiresAt: new Date(Date.now() - 60_000) },
    ]) {
      // ライブラリが期限切れ行を掃除しても、別の期限条件・明示失効の試験へ影響させない。
      const expired = await administrator();
      await db.session.update({ where: { id: expired.session.id }, data: expiry });
      for (const route of probes) { const response = await request(route, expired.cookie); expect(response.status).toBe(401); protectedHeaders(response); }
    }
    const revoked = await administrator();
    for (const route of probes) expect((await request(route, revoked.cookie)).status).toBe(200);
    // 実在していて利用可能な別セッションを削除し、その同じCookieの拒否を確認する。
    await db.session.delete({ where: { id: revoked.session.id } });
    for (const route of probes) { const response = await request(route, revoked.cookie); expect(response.status).toBe(401); protectedHeaders(response); }
  });
});
