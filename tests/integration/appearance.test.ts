import { afterAll, describe, expect, it } from "vitest";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { deflateSync } from "node:zlib";
import { createDatabase, type Database } from "../../apps/api/src/db.js";
import { loadConfig } from "../../apps/api/src/config.js";
import { createApp } from "../../apps/api/src/app.js";
import { getAppearance, updateAppearance } from "../../apps/api/src/appearance.js";
import { hash, newToken } from "../../apps/api/src/setup.js";
import { pngChunk, pngFixture } from "../appearance-fixture.js";

if (!/^mame-inout-test(?:-|$)/.test(process.env.TEST_PROJECT ?? "")) throw new Error("独立したテスト用Composeプロジェクトが必要です。");
const config = loadConfig(), db = createDatabase(config), app = createApp(db, config);
const users: string[] = [], devices: string[] = [];
afterAll(async () => {
  // 専用試験DBの表示設定だけを既定へ戻し、他の機能試験へ編集値を持ち越さない。
  await db.appearance.update({ where: { id: 1 }, data: { displayName: "入退出管理システム", icon: null, favicon: null } });
  await db.receptionDevice.deleteMany({ where: { id: { in: devices } } });
  await db.user.deleteMany({ where: { id: { in: users } } }); await db.$disconnect();
});
async function admin(role = "ADMIN") {
  const user = await db.user.create({ data: { id: randomUUID(), name: "表示設定の試験管理者", email: `${randomUUID()}@example.test`, role } }); users.push(user.id);
  const token = newToken();
  const session = await db.session.create({ data: { id: randomUUID(), userId: user.id, token, expiresAt: new Date(Date.now() + 600_000), authenticatedAt: new Date(Date.now() - 360_000) } });
  const signature = createHmac("sha256", config.secret).update(token).digest("base64");
  return { actor: { userId: user.id, sessionId: session.id }, cookie: `${config.secure ? "__Secure-" : ""}better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}` };
}
async function reception() {
  const token = newToken();
  const device = await db.receptionDevice.create({ data: { name: "表示試験受付", status: "APPROVED", approvedAt: new Date(), expiresAt: new Date(Date.now() + 600_000) } }); devices.push(device.id);
  await db.receptionCredential.create({ data: { deviceId: device.id, tokenHash: hash(token), expiresAt: device.expiresAt! } });
  return `${config.secure ? "__Secure-mame-reception" : "mame_reception"}=${token}`;
}
function request(path: string, cookie?: string, body?: unknown, method = body === undefined ? "GET" : "PUT", origin = config.origin) {
  return app.request(path, { method, headers: { origin, ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

describe("表示設定の保存と配信", () => {
  it("未認証でも公開表示だけを返し、認証や名簿を含めない", async () => {
    const response = await request("/api/appearance"), data = await response.json();
    expect(response.status).toBe(200);
    expect(Object.keys(data).sort()).toEqual(["displayName", "version", "iconUrl", "faviconUrl", "customIcon", "customFavicon"].sort());
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it("既定アイコンはローカルの制限されたSVGで配信する", async () => {
    await db.appearance.update({ where: { id: 1 }, data: { icon: null, favicon: null } });
    const response = await request("/api/appearance/icon?v=1");
    expect(response.status).toBe(200); expect(response.headers.get("content-type")).toContain("image/svg+xml");
    expect(response.headers.get("content-security-policy")).toContain("sandbox");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(await response.text()).toContain('viewBox="0 0 64 64"');
  });
  it("管理者の読取と更新を、未認証・受付資格・他役割から保護する", async () => {
    const other = await admin("VIEWER"), desk = await reception();
    const current = await getAppearance(db);
    for (const cookie of [undefined, desk, other.cookie]) {
      for (const body of [undefined, { expectedVersion: current.version, displayName: "未許可" }]) {
        expect((await request("/api/admin/appearance", cookie, body)).status).toBe(cookie ? 403 : 401);
      }
    }
    expect((await getAppearance(db)).version).toBe(current.version);
  });
  it("通常ログインで表示名を変更でき、セッションと認証情報を維持する", async () => {
    const manager = await admin(), before = await getAppearance(db);
    const response = await request("/api/admin/appearance", manager.cookie, { expectedVersion: before.version, displayName: "  教室の入退出  " });
    expect(response.status).toBe(200); expect((await response.json()).displayName).toBe("教室の入退出");
    expect((await request("/api/admin/me", manager.cookie)).status).toBe(200);
    expect(await db.session.count({ where: { id: manager.actor.sessionId } })).toBe(1);
    expect((await getAppearance(db)).version).toBe(before.version + 1);
  });
  it("PNGをDBへ保存し、付加メタデータを取り除いて同じPNGを配信する", async () => {
    const manager = await admin(), before = await getAppearance(db);
    const plain = pngFixture(), metadata = pngFixture({ beforeData: [pngChunk("tEXt", Buffer.from("comment\0do-not-save"))] });
    const saved = await updateAppearance(db, manager.actor, { displayName: before.displayName, expectedVersion: before.version, iconPng: metadata.toString("base64"), faviconPng: plain.toString("base64") });
    expect(saved.customIcon && saved.customFavicon).toBe(true);
    for (const path of [saved.iconUrl, saved.faviconUrl]) {
      const response = await request(path);
      expect(response.headers.get("content-type")).toBe("image/png"); expect(response.headers.get("cache-control")).toBe("no-store");
      expect(Buffer.from(await response.arrayBuffer()).equals(plain)).toBe(true);
    }
    const row = await db.appearance.findUniqueOrThrow({ where: { id: 1 } });
    expect(Buffer.from(row.icon!).equals(plain)).toBe(true);
  });
  it("画像の省略で既存値を保持し、nullの明示で既定へ戻せる", async () => {
    const manager = await admin(); const before = await getAppearance(db);
    const png = pngFixture().toString("base64");
    const first = await updateAppearance(db, manager.actor, { displayName: "画像の保持", expectedVersion: before.version, iconPng: png, faviconPng: png });
    const second = await updateAppearance(db, manager.actor, { displayName: "名前だけ変更", expectedVersion: first.version });
    expect(second.customIcon && second.customFavicon).toBe(true);
    const third = await updateAppearance(db, manager.actor, { displayName: "入退出管理システム", expectedVersion: second.version, iconPng: null, faviconPng: null });
    expect(third.customIcon || third.customFavicon).toBe(false);
  });
  it("表示設定だけは通常の32KBを超えるPNG2枚の要求を受け付ける", async () => {
    const manager = await admin(), before = await getAppearance(db);
    const rows = randomBytes((64 * 4 + 1) * 64);
    for (let y = 0; y < 64; y++) rows[y * (64 * 4 + 1)] = 0;
    const png = pngFixture({ width: 64, height: 64, compressed: deflateSync(rows) }).toString("base64");
    const input = { displayName: "画像の上限確認", expectedVersion: before.version, iconPng: png, faviconPng: png };
    expect(Buffer.byteLength(JSON.stringify(input))).toBeGreaterThan(32 * 1024);
    expect((await request("/api/admin/appearance", manager.cookie, input)).status).toBe(200);
    expect((await request("/api/setup/begin", undefined, { invalid: "x".repeat(40_000) }, "POST")).status).toBe(413);
  });
  it("古い版と同時編集を拒否し、片方の変更だけを確定する", async () => {
    const a = await admin(), b = await admin(), current = await getAppearance(db);
    const results = await Promise.all([a, b].map((manager) => request("/api/admin/appearance", manager.cookie, { expectedVersion: current.version, displayName: "同時更新" })));
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    expect((await getAppearance(db)).version).toBe(current.version + 1);
  });
  it("失効したセッションと不正Originでは設定を保存しない", async () => {
    const manager = await admin(), current = await getAppearance(db);
    const input = { displayName: "不正更新", expectedVersion: current.version };
    expect((await request("/api/admin/appearance", manager.cookie, input, "PUT", "https://example.invalid")).status).toBe(403);
    await db.session.delete({ where: { id: manager.actor.sessionId } });
    expect((await request("/api/admin/appearance", manager.cookie, input)).status).toBe(401);
    expect((await getAppearance(db)).version).toBe(current.version);
  });
  it("偽画像・空名・追加項目・大きな要求を拒否する", async () => {
    const manager = await admin(), current = await getAppearance(db);
    for (const extra of [{ displayName: " " }, { iconPng: Buffer.from("not-png").toString("base64") }, { arbitraryField: "extra" }, { expectedVersion: 0 }]) {
      expect((await request("/api/admin/appearance", manager.cookie, { displayName: "表示設定", expectedVersion: current.version, ...extra })).status).toBe(422);
    }
    expect((await request("/api/admin/appearance", manager.cookie, { displayName: "x".repeat(200_000), expectedVersion: current.version })).status).toBe(413);
    expect((await getAppearance(db)).version).toBe(current.version);
  });
  it("監査保存失敗では画像・名前・更新版をすべてロールバックする", async () => {
    const manager = await admin(), before = await db.appearance.findUniqueOrThrow({ where: { id: 1 } });
    const failing = db.$extends({ query: { auditEvent: { async create() { throw new Error("監査失敗の試験"); } } } }) as unknown as Database;
    await expect(updateAppearance(failing, manager.actor, { expectedVersion: before.version, displayName: "失敗", iconPng: pngFixture().toString("base64") })).rejects.toThrow();
    const after = await db.appearance.findUniqueOrThrow({ where: { id: 1 } });
    expect(after).toEqual(before);
  });
  it("監査は更新版と対象だけを保存し、名前・画像原文を複製しない", async () => {
    const manager = await admin(), before = await getAppearance(db), png = pngFixture().toString("base64");
    await updateAppearance(db, manager.actor, { expectedVersion: before.version, displayName: "監査へ複製しない名前", faviconPng: png });
    const event = await db.auditEvent.findFirstOrThrow({ where: { actorUserId: manager.actor.userId, action: "APPEARANCE_UPDATED" } });
    expect(event.details).toEqual({ version: before.version + 1, fields: ["displayName", "favicon"] });
    expect(JSON.stringify(event.details)).not.toContain(png);
  });
});
