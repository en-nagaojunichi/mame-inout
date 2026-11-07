import { readFile } from "node:fs/promises";
import { test, expect } from "@playwright/test";

test("初期登録からパスキーログイン・ログアウトまで", async ({ page, context, browser, baseURL }) => {
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", { options: {
    protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true,
    isUserVerified: true, automaticPresenceSimulation: true,
  } });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "最初の管理者を登録" })).toBeVisible();
  await page.screenshot({ path: "test-results/setup-desktop.png", fullPage: true });
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "本文へ移動" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("設定コード", { exact: true })).toBeFocused();
  const code = (await readFile(process.env.E2E_SETUP_CODE_FILE ?? "secrets/e2e-setup-code", "utf8")).trim();
  await page.getByLabel("設定コード", { exact: true }).fill(code);
  await page.getByLabel("表示名", { exact: true }).fill("動作確認の管理者");
  await page.getByLabel("メールアドレス", { exact: true }).fill("demo@example.test");
  const registrationRequest = page.waitForRequest((request) => request.url().endsWith("/passkey/verify-registration"));
  await page.getByRole("button", { name: "パスキーを登録", exact: true }).click();
  const registration = await registrationRequest;
  await expect(page.getByRole("heading", { name: "接続を確認できました" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "接続を確認できました" })).toBeFocused();
  expect((await context.request.get("/api/admin/me")).status()).toBe(200);
  expect((await context.request.get("/api/admin/me")).headers()["cache-control"]).toBe("no-store");
  const me = await (await context.request.get("/api/admin/me")).json();
  expect(me.user.emailVerified).toBe(false);
  expect(me).not.toHaveProperty("session");
  expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }))).toEqual({ local: 0, session: 0 });

  const anonymous = await browser.newContext({ baseURL });
  expect((await anonymous.request.get("/api/admin/me")).status()).toBe(401);
  await anonymous.close();
  expect((await context.request.post("/api/auth/sign-out", { headers: { Origin: "https://foreign.example" } })).status()).toBe(403);
  // 検証済みのチャレンジを再送しても、パスキーや管理者を追加できない。
  expect((await context.request.post("/api/auth/passkey/verify-registration", { headers: { Origin: baseURL! }, data: registration.postDataJSON() })).status()).toBe(400);
  expect((await context.request.post("/api/setup/begin", { headers: { Origin: baseURL! }, data: { code, name: "別の候補", email: "other@example.test" } })).status()).toBe(403);

  await page.screenshot({ path: "test-results/auth-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: "test-results/auth-mobile.png", fullPage: true });
  const oldCookies = await context.cookies();
  await page.getByRole("button", { name: "ログアウト", exact: true }).click();
  await expect(page.getByRole("button", { name: "パスキーでログイン", exact: true })).toBeVisible();
  await page.screenshot({ path: "test-results/login-mobile.png", fullPage: true });
  expect((await context.request.get("/api/admin/me")).status()).toBe(401);
  const stale = await browser.newContext({ baseURL });
  await stale.addCookies(oldCookies);
  expect((await stale.request.get("/api/admin/me")).status()).toBe(401);
  await stale.close();

  const authenticationRequest = page.waitForRequest((request) => request.url().endsWith("/passkey/verify-authentication"));
  await page.getByRole("button", { name: "パスキーでログイン", exact: true }).click();
  const authentication = await authenticationRequest;
  await expect(page.getByRole("heading", { name: "接続を確認できました" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "接続を確認できました" })).toBeFocused();
  expect((await context.request.post("/api/auth/passkey/verify-authentication", { headers: { Origin: baseURL! }, data: authentication.postDataJSON() })).status()).toBe(400);
  await page.getByRole("button", { name: "ログアウト", exact: true }).click();
  for (const invalid of ["uv", "signature", "origin", "rpid"]) {
    // ブラウザ内の待機状態ではなく、署名応答をサーバーが拒否したことを確認する。
    await cdp.send("WebAuthn.setResponseOverrideBits", { authenticatorId, isBadUV: invalid === "uv", isBogusSignature: invalid === "signature" });
    if (invalid === "origin" || invalid === "rpid") {
      await page.route("**/passkey/verify-authentication", async (route) => {
        const body = route.request().postDataJSON();
        if (invalid === "origin") {
          const client = JSON.parse(Buffer.from(body.response.response.clientDataJSON, "base64url").toString());
          client.origin = "https://foreign.example";
          body.response.response.clientDataJSON = Buffer.from(JSON.stringify(client)).toString("base64url");
        } else {
          const data = Buffer.from(body.response.response.authenticatorData, "base64url");
          data.fill(0, 0, 32);
          body.response.response.authenticatorData = data.toString("base64url");
        }
        await route.continue({ postData: JSON.stringify(body) });
      });
    }
    const rejected = page.waitForResponse((response) => response.url().endsWith("/passkey/verify-authentication"));
    await page.getByRole("button", { name: "パスキーでログイン", exact: true }).click();
    const response = await rejected;
    expect([400, 401], invalid).toContain(response.status());
    expect((await response.json()).code).toBe("AUTH_FAILED");
    await expect(page.getByText("ログインは完了していません。パスキーを選び直してお試しください。", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "パスキーでログイン", exact: true })).toBeEnabled();
    expect((await context.request.get("/api/admin/me")).status()).toBe(401);
    await page.unroute("**/passkey/verify-authentication");
  }
  await page.screenshot({ path: "test-results/error-mobile.png", fullPage: true });
});
