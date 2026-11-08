import { beforeEach, afterAll, describe, expect, it } from "vitest";
import { createHmac, randomUUID } from "node:crypto";
import { createDatabase } from "../../apps/api/src/db.js";
import { loadConfig } from "../../apps/api/src/config.js";
import { createApp } from "../../apps/api/src/app.js";
import { createAuth } from "../../apps/api/src/auth.js";
import { beginSetup, completeSetup, hash, newToken } from "../../apps/api/src/setup.js";

// テスト用の独立Composeプロジェクト以外で認証データを初期化しない。
if (!/^mame-inout-test(?:-|$)/.test(process.env.TEST_PROJECT ?? "")) throw new Error("独立したテスト用Composeプロジェクトが必要です。");
const config = loadConfig();
const db = createDatabase(config);
const app = createApp(db, config);
const code = newToken();
async function reset() {
  await db.session.deleteMany(); await db.passkey.deleteMany(); await db.user.deleteMany();
  await db.verification.deleteMany(); await db.setupAttempt.deleteMany(); await db.rateBucket.deleteMany();
  await db.setupState.update({ where: { id: 1 }, data: { completedAt: null, codeHash: hash(code), expiresAt: new Date(Date.now() + 900_000) } });
}
beforeEach(reset);
afterAll(async () => { await reset(); await db.$disconnect(); });
const headers = (token: string) => new Headers({ cookie: `mame_setup=${token}` });

describe("実PostgreSQLと認証境界", () => {
  it("認証ライブラリのチャレンジ消費が期限切れと同時再使用を拒否する", async () => {
    const context = await createAuth(db, config).$context;
    const expired = newToken();
    await context.internalAdapter.createVerificationValue({ identifier: expired, value: "test-only", expiresAt: new Date(0) });
    expect(await context.internalAdapter.consumeVerificationValue(expired)).toBeNull();
    const valid = newToken();
    await context.internalAdapter.createVerificationValue({ identifier: valid, value: "test-only", expiresAt: new Date(Date.now() + 60000) });
    const results = await Promise.all([context.internalAdapter.consumeVerificationValue(valid), context.internalAdapter.consumeVerificationValue(valid)]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });
  it("有効セッションでも役割違反は403、期限切れと失効後は401を返す", async () => {
    const user = await db.user.create({ data: { id: randomUUID(), name: "認可確認", email: "permission@example.test", role: "RECEPTION" } });
    const token = newToken();
    const session = await db.session.create({ data: { id: randomUUID(), userId: user.id, token, expiresAt: new Date(Date.now() + 60000) } });
    // Better Authが使う署名形式でテスト資格を作り、DB状態の変更が毎回認可へ反映するか確認する。
    const signature = createHmac("sha256", config.secret).update(token).digest("base64");
    const cookie = `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`;
    const request = () => app.request("/api/admin/me", { headers: { cookie } });
    expect((await request()).status).toBe(403);
    await db.user.update({ where: { id: user.id }, data: { role: "ADMIN" } });
    expect((await request()).status).toBe(200);
    await db.session.update({ where: { id: session.id }, data: { expiresAt: new Date(0) } });
    expect((await request()).status).toBe(401);
    await db.session.deleteMany({ where: { id: session.id } });
    expect((await request()).status).toBe(401);
  });
  it("通常APIは必要な読書きだけができ、DDL・管理・移行記録の変更を拒否する", async () => {
    expect(await db.setupState.count()).toBe(1);
    await expect(db.$executeRawUnsafe('CREATE TABLE forbidden_probe (id integer)')).rejects.toThrow();
    await expect(db.$executeRawUnsafe('CREATE ROLE forbidden_probe')).rejects.toThrow();
    await expect(db.$executeRawUnsafe('DELETE FROM "SchemaMigration"')).rejects.toThrow();
  });
  it("未認証・不正Origin・自由登録・過大入力を拒否する", async () => {
    expect((await app.request("/api/admin/me")).status).toBe(401);
    expect((await app.request("/api/setup/begin", { method: "POST", headers: { origin: "https://invalid.example" } })).status).toBe(403);
    expect((await app.request("/api/setup/begin", { method: "POST" })).status).toBe(403);
    expect((await app.request("/api/auth/sign-up/email", { method: "POST", headers: { origin: config.origin } })).status).toBe(404);
    expect((await app.request("/api/setup/begin", { method: "POST", headers: { origin: config.origin }, body: "x".repeat(33000) })).status).toBe(413);
    const response = await app.request("/api/health");
    expect(await response.json()).toEqual({ status: "ok" });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it("登録と認証のチャレンジ応答は保存禁止とし、必要なCookieを保持する", async () => {
    const token = await beginSetup(db, { code, name: "検証管理者", email: "admin@example.test" });
    expect(Boolean(token)).toBe(true);
    for (const path of ["generate-register-options", "generate-authenticate-options"]) {
      const response = await app.request(`/api/auth/passkey/${path}`, { headers: headers(token!) });
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      // 生のCookieやチャレンジを、失敗時の差分・診断出力へ含めない。
      const challengeCookie = response.headers.getSetCookie().find((cookie) =>
        cookie.startsWith(`${config.secure ? "__Secure-" : ""}better-auth.better-auth-passkey=`));
      expect(Boolean(challengeCookie)).toBe(true);
      expect(/;\s*HttpOnly(?:;|$)/i.test(challengeCookie ?? "")).toBe(true);
      expect(/;\s*SameSite=Lax(?:;|$)/i.test(challengeCookie ?? "")).toBe(true);
      expect(/;\s*Secure(?:;|$)/i.test(challengeCookie ?? "")).toBe(config.secure);
      const options = await response.json() as { challenge?: unknown };
      expect(typeof options.challenge).toBe("string");
      expect(typeof options.challenge === "string" && options.challenge.length > 0).toBe(true);
    }
  });
  it("誤コード・期限切れ・完了後を拒否し、検証前にUserを作らない", async () => {
    const input = { code, name: "検証管理者", email: "admin@example.test" };
    expect(await beginSetup(db, { ...input, code: newToken() })).toBeNull();
    expect(await beginSetup(db, input)).toBeTruthy();
    expect(await db.user.count()).toBe(0);
    await db.setupState.update({ where: { id: 1 }, data: { expiresAt: new Date(0) } });
    expect(await beginSetup(db, input)).toBeNull();
    await db.setupState.update({ where: { id: 1 }, data: { completedAt: new Date(), expiresAt: new Date(Date.now() + 10000) } });
    expect(await beginSetup(db, input)).toBeNull();
  });
  it("初期設定で入力した大文字メールは小文字に正規化して保存する", async () => {
    const token = await beginSetup(db, { code, name: "メール表記の確認", email: "Legacy.Admin@EXAMPLE.TEST" });
    expect(Boolean(token)).toBe(true);
    const attempt = await db.setupAttempt.findUniqueOrThrow({ where: { tokenHash: hash(token!) } });
    expect(attempt.email).toBe("legacy.admin@example.test");
  });
  it("同時に確定しても管理者は1人で、使用済みコードを再利用できない", async () => {
    const a = await beginSetup(db, { code, name: "候補A", email: "a@example.test" });
    const b = await beginSetup(db, { code, name: "候補B", email: "b@example.test" });
    const attempts = await db.setupAttempt.findMany();
    const results = await Promise.allSettled([a!, b!].map((token) => db.$transaction(async (tx) => {
      const attempt = attempts.find((item) => item.tokenHash === hash(token))!;
      await completeSetup(tx, headers(token), attempt.userId);
    })));
    expect(results.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(await db.user.count()).toBe(1);
    expect((await db.setupState.findUniqueOrThrow({ where: { id: 1 } })).codeHash).toBeNull();
    expect(await beginSetup(db, { code, name: "候補C", email: "c@example.test" })).toBeNull();
  });
  it("パスキー保存に相当する後続処理が失敗したら管理者とコード消費を戻す", async () => {
    const token = (await beginSetup(db, { code, name: "候補A", email: "a@example.test" }))!;
    const attempt = await db.setupAttempt.findUniqueOrThrow({ where: { tokenHash: hash(token) } });
    await expect(db.$transaction(async (tx) => {
      await completeSetup(tx, headers(token), attempt.userId);
      throw new Error("保存失敗を注入");
    })).rejects.toThrow("保存失敗");
    expect(await db.user.count()).toBe(0);
    expect((await db.setupState.findUniqueOrThrow({ where: { id: 1 } })).codeHash).toBe(hash(code));
  });
  it("初期登録の連続試行をDBで制限する", async () => {
    const statuses = [];
    for (let i = 0; i < 6; i++) statuses.push((await app.request("/api/setup/begin", {
      method: "POST", headers: { origin: config.origin, "content-type": "application/json" },
      body: JSON.stringify({ code: newToken(), name: "候補", email: "test@example.test" }),
    })).status);
    expect(statuses).toEqual([403, 403, 403, 403, 403, 429]);
  });
});
