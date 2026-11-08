import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config } from "./config.js";
import type { Database } from "./db.js";
import { createApp } from "./app.js";

// HTTP共通処理の検査では認証器・DBを代用し、DBを読む前の拒否と応答だけに絞る。
// 実Cookieの認可・期限・失効は、実PostgreSQLを使う結合試験で確認する。
vi.mock("./auth.js", () => ({ createAuth: () => ({ api: { getSession: async () => null } }) }));
const config: Config = {
  origin: "https://boundary.example.test", rpID: "boundary.example.test", secure: true, port: 3001,
  secret: "unit-only-auth-credential-never-published",
  database: { host: "test-database", port: 5432, database: "mame", user: "mame_app", password: "unit-only-db-credential", max: 10 },
};
function fixture() {
  const query = vi.fn().mockResolvedValue([{ count: 1 }]);
  const cleanup = vi.fn().mockResolvedValue({ count: 0 });
  const db = { $queryRaw: query, rateBucket: { deleteMany: cleanup } } as unknown as Database;
  return { app: createApp(db, config), query, cleanup };
}
function headers(response: Response) {
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(response.headers.has("access-control-allow-origin")).toBe(false);
  expect(response.headers.has("access-control-allow-credentials")).toBe(false);
  expect(response.headers.has("set-cookie")).toBe(false);
}
afterEach(() => vi.restoreAllMocks());

describe("API共通の要求境界", () => {
  it("JSONを名乗らない本文を形式エラーにし、既存の認可・未知経路の優先順位を守る", async () => {
    const { app } = fixture();
    for (const type of [undefined, "text/plain", "application/x-www-form-urlencoded", "multipart/form-data", "application/jsonp"]) {
      const response = await app.request("/api/setup/begin", { method: "POST", headers: {
        origin: config.origin, ...(type ? { "content-type": type } : {}),
      }, body: "{}" });
      expect(response.status, type ?? "未指定").toBe(415); headers(response);
      expect(await response.json()).toMatchObject({ code: "UNSUPPORTED_MEDIA_TYPE" });
    }
    const protectedResponse = await app.request("/api/admin/appearance", { method: "PUT", headers: { origin: config.origin, "content-type": "text/plain" }, body: "{}" });
    expect(protectedResponse.status).toBe(401); headers(protectedResponse);
    const missing = await app.request("/api/not-exposed", { method: "POST", headers: { origin: config.origin, "content-type": "text/plain" }, body: "{}" });
    expect(missing.status).toBe(404); headers(missing);
  });
  it("JSONの大文字表記・UTF-8指定を受理し、不正JSONは業務処理前に拒否する", async () => {
    const { app } = fixture();
    for (const type of ["application/json", "Application/JSON; charset=utf-8"]) {
      for (const body of ["{}", "{broken", "null", "[]"]) {
        const response = await app.request("/api/setup/begin", { method: "POST", headers: { origin: config.origin, "content-type": type }, body });
        expect(response.status).toBe(422); headers(response);
        expect(await response.json()).toMatchObject({ code: "INVALID_INPUT" });
      }
    }
  });
  it("32KiB境界を実バイトで守り、画像更新以外へ拡大した上限を適用しない", async () => {
    const { app } = fixture();
    for (const [size, status] of [[32 * 1024, 422], [32 * 1024 + 1, 413]] as const) {
      const response = await app.request("/api/setup/begin", { method: "POST", headers: { origin: config.origin, "content-type": "application/json" },
        body: "{}" + " ".repeat(size - 2) });
      expect(response.status).toBe(status); headers(response);
    }
    // 文字数が上限以下でも、UTF-8で32KiBを超えれば受理しない。
    const multibyte = await app.request("/api/setup/begin", { method: "POST", headers: { origin: config.origin, "content-type": "application/json" },
      body: JSON.stringify({ name: "あ".repeat(12_000) }) });
    expect(multibyte.status).toBe(413); headers(multibyte);
    for (const [size, status] of [[192 * 1024, 401], [192 * 1024 + 1, 413]] as const) {
      const response = await app.request("/api/admin/appearance", { method: "PUT", headers: { origin: config.origin, "content-type": "application/json" },
        body: "{}" + " ".repeat(size - 2) });
      expect(response.status).toBe(status); headers(response);
    }
  });
  it("書込みはOriginの省略・null・別ポート・接尾辞一致を拒否し、過大本文より先に止める", async () => {
    const { app, query } = fixture();
    for (const origin of [undefined, "null", "https://boundary.example.test:444", "https://boundary.example.test.attacker.test"]) {
      const response = await app.request("/api/setup/begin", { method: "POST", headers: {
        ...(origin ? { origin } : {}), "content-type": "application/json",
      }, body: "x".repeat(33_000) });
      expect(response.status).toBe(403); headers(response);
      expect(await response.json()).toMatchObject({ code: "ORIGIN_DENIED" });
    }
    expect(query).not.toHaveBeenCalled();
  });
  it("同じOriginを名乗ってもcross-site要求と外部プリフライトを許可しない", async () => {
    const { app, query } = fixture();
    const response = await app.request("/api/setup/begin", { method: "POST", headers: {
      origin: config.origin, "content-type": "application/json", "sec-fetch-site": "cross-site",
    }, body: "{}" });
    expect(response.status).toBe(403); headers(response);
    const preflight = await app.request("/api/admin/people", { method: "OPTIONS", headers: {
      origin: "https://attacker.example", "access-control-request-method": "POST", "access-control-request-headers": "content-type",
    } });
    expect(preflight.status).toBe(403); headers(preflight); expect(query).not.toHaveBeenCalled();
  });
  it("公開のGET・HEADと未知の経路でも共通ヘッダーを維持する", async () => {
    const { app } = fixture();
    for (const method of ["GET", "HEAD"]) {
      const response = await app.request("/api/health", { method });
      expect(response.status).toBe(200); headers(response);
      if (method === "GET") expect(await response.json()).toEqual({ status: "ok" });
      else expect(await response.text()).toBe("");
    }
    const missing = await app.request("/api/not-exposed");
    expect(missing.status).toBe(404); headers(missing);
  });
  it("DB例外や要求の秘密値を本文・応答ヘッダー・通常ログへ複製しない", async () => {
    const { app, query } = fixture();
    const sentinels = [config.secret, config.database.password, "unit-only-cookie", "unit-only-authorization", "unit-only-qr"];
    const spies = [vi.spyOn(console, "log"), vi.spyOn(console, "info"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")].map((spy) => spy.mockImplementation(() => {}));
    query.mockRejectedValueOnce(new Error(`database failure: ${sentinels.join(" ")}`));
    const response = await app.request("/api/health", { headers: { cookie: sentinels[2]!, authorization: sentinels[3]!, "x-test-qr": sentinels[4]! } });
    expect(response.status).toBe(503); headers(response);
    const output = await response.text() + JSON.stringify([...response.headers]) + JSON.stringify(spies.flatMap((spy) => spy.mock.calls));
    // 失敗レポートにも秘密値そのものを出さず、包含の真偽だけを比較する。
    expect(sentinels.some((value) => output.includes(value))).toBe(false);
  });
});
