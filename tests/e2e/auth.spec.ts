import { readFile } from "node:fs/promises";
import { test, expect, type BrowserContext, type Page, type CDPSession } from "@playwright/test";
import { cookieMetadata, cookieName, maskSecretDisplays } from "./secret-displays";
import { runPeopleReceptionFlow } from "./people-reception-flow";
import { runHistoryAppearanceFlow } from "./history-appearance-flow";

// 実DBの初期登録は一度だけ行い、秘密値はメモリの中で次の検査へ渡す。
// 長い一本のテストに業務確認を継ぎ足さず、失敗した工程と時間予算を明確にする。
test.describe("実認証と日常操作", () => {
  test.describe.configure({ mode: "serial", timeout: 90_000 });
  let context: BrowserContext, page: Page, cdp: CDPSession, authenticatorId: string;
  let recoveryContext: BrowserContext, recoveryPage: Page;
  let issued: Awaited<ReturnType<typeof maskSecretDisplays>>;
  let initialCodes: string[];
  const blockedCookies: { name: string; reasons: string[] }[] = [];
  test.beforeAll(async ({ browser, baseURL }) => {
    context = await browser.newContext({ baseURL });
    page = await context.newPage();
  issued = await maskSecretDisplays(page);
  cdp = await context.newCDPSession(page);
  const registrationIds = new Set<string>();
  await cdp.send("Network.enable");
  cdp.on("Network.requestWillBeSent", (event) => { if (event.request.url.endsWith("/passkey/verify-registration")) registrationIds.add(event.requestId); });
  cdp.on("Network.responseReceivedExtraInfo", (event) => {
    if (!registrationIds.has(event.requestId)) return;
    for (const cookie of event.blockedCookies) blockedCookies.push({ name: cookieName(cookie.cookieLine), reasons: cookie.blockedReasons });
  });
  await cdp.send("WebAuthn.enable");
  ({ authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", { options: {
    protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true,
    isUserVerified: true, automaticPresenceSimulation: true,
  } }));
  });
  test.afterAll(async () => {
    await recoveryContext?.close();
    await context?.close();
  });
  test("初期登録・ログイン・ログアウト", async ({ browser, baseURL }, testInfo) => {
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
  const initialCodesResponse = page.waitForResponse((response) => response.url().endsWith("/api/admin/recovery-codes") && response.request().method() === "POST");
  await page.getByRole("button", { name: "パスキーを登録", exact: true }).click();
  const registration = await registrationRequest;
  const registeredHttp = await registration.response();
  await registeredHttp?.finished();
  // Cookie値を添付せず、ブラウザが受理しなかった理由と公開属性だけを診断に残す。
  await testInfo.attach("registration-cookie-metadata", { contentType: "application/json", body: Buffer.from(JSON.stringify({
    cookies: (await registeredHttp?.headersArray() ?? []).filter((header) => header.name.toLowerCase() === "set-cookie").map((header) => cookieMetadata(header.value)),
    blockedCookies,
    storedCookieNames: (await context.cookies()).map((cookie) => cookie.name),
  })) });
  expect(registeredHttp?.status()).toBe(200);
  expect((await context.cookies()).some((cookie) => cookie.name.endsWith("better-auth.session_token"))).toBe(true);
  const initialCodesHttp = await initialCodesResponse;
  const initialCodesBody = await initialCodesHttp.json();
  // 失敗の診断は固定コードと状態だけにし、復旧コード自体をassertの差分へ出さない。
  expect({ status: initialCodesHttp.status(), code: initialCodesBody.code ?? "SUCCESS" }).toEqual({ status: 200, code: "SUCCESS" });
  initialCodes = issued.recoveries[0] ?? [];
  if (!initialCodes || initialCodes.length !== 8) throw new Error("初期登録後の復旧コード発行を確認できませんでした。");
  await expect(page.getByRole("dialog", { name: "復旧コードを保存" })).toBeVisible();
  await page.getByRole("button", { name: "保存したので閉じる", exact: true }).click();
  await expect(page.getByRole("heading", { name: "管理ホーム", exact: true })).toBeVisible();
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
  await expect(page.getByRole("heading", { name: "管理ホーム", exact: true })).toBeVisible();
  expect((await context.request.post("/api/auth/passkey/verify-authentication", { headers: { Origin: baseURL! }, data: authentication.postDataJSON() })).status()).toBe(400);
  await page.getByRole("button", { name: "ログアウト", exact: true }).click();

  });
  test("不正なパスキー応答とチャレンジ再使用を拒否", async ({ baseURL }) => {
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

  // 署名の改ざんで失敗したチャレンジも消費し、元の正しい応答を再送して使い直せない。
  await cdp.send("WebAuthn.setResponseOverrideBits", { authenticatorId, isBadUV: false, isBogusSignature: false });
  let originalPayload: unknown;
  let originalCookie = "";
  await page.route("**/passkey/verify-authentication", async (route) => {
    const body = route.request().postDataJSON();
    originalPayload = structuredClone(body);
    originalCookie = (await route.request().allHeaders())["cookie"] ?? "";
    const signature = Buffer.from(body.response.response.signature, "base64url");
    signature[signature.length - 1] = signature[signature.length - 1]! ^ 1;
    body.response.response.signature = signature.toString("base64url");
    await route.continue({ postData: JSON.stringify(body) });
  });
  const failedSignature = page.waitForResponse((response) => response.url().endsWith("/passkey/verify-authentication"));
  await page.getByRole("button", { name: "パスキーでログイン", exact: true }).click();
  expect([400, 401]).toContain((await failedSignature).status());
  await page.unroute("**/passkey/verify-authentication");
  expect(Boolean(originalPayload)).toBe(true);
  expect(originalCookie.includes("better-auth-passkey=")).toBe(true);
  expect((await context.request.post("/api/auth/passkey/verify-authentication", { headers: { Origin: baseURL!, Cookie: originalCookie }, data: originalPayload })).status()).toBe(400);

  await page.getByRole("button", { name: "パスキーでログイン", exact: true }).click();
  await expect(page.getByRole("heading", { name: "管理ホーム", exact: true })).toBeVisible();

  });
  test("パスキー追加・名前変更と管理者の招待", async ({ browser, baseURL }) => {
  await page.getByRole("button", { name: "管理メニューを開く", exact: true }).click();
  await page.getByRole("link", { name: "自分の設定", exact: true }).click();
  await expect(page.getByRole("heading", { name: "自分の設定", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "パスキーを追加", exact: true }).click();
  const addModal = page.getByRole("dialog", { name: "パスキーを追加", exact: true });
  await addModal.getByLabel("パスキーの名前", { exact: true }).fill("予備のパスキー");
  // ログイン直後の認証を使い、空の認証器へ切り替えて別端末への追加を再現する。
  await cdp.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId });
  await cdp.send("WebAuthn.addVirtualAuthenticator", { options: {
    protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true,
    isUserVerified: true, automaticPresenceSimulation: true,
  } });
  await addModal.getByRole("button", { name: "追加", exact: true }).click();
  await expect(addModal).not.toBeVisible();
  await expect(page.getByRole("heading", { name: "予備のパスキー", exact: true })).toBeVisible();
  expect((await (await context.request.get("/api/admin/security")).json()).passkeys.length).toBe(2);
  await page.getByRole("button", { name: /名前を変更.*予備のパスキー/ }).click();
  const renameModal = page.getByRole("dialog", { name: "パスキーの名前を変更", exact: true });
  await renameModal.getByLabel("パスキーの名前", { exact: true }).fill("持ち歩き用の予備");
  await renameModal.getByRole("button", { name: "保存", exact: true }).click();
  await expect(renameModal).not.toBeVisible();
  await expect(page.getByRole("heading", { name: "持ち歩き用の予備", exact: true })).toBeVisible();

  await page.goto("/settings/administrators");
  await page.getByRole("button", { name: "管理者を招待", exact: true }).click();
  const inviteModal = page.getByRole("dialog", { name: "管理者を招待", exact: true });
  await inviteModal.getByLabel("招待する方の表示名", { exact: true }).fill("招待された管理者");
  await inviteModal.getByLabel("招待する方のメールアドレス", { exact: true }).fill("invited@example.test");
  const invitationResponse = page.waitForResponse((response) => response.url().endsWith("/api/admin/invitations"));
  await inviteModal.getByRole("button", { name: "招待", exact: true }).click();
  expect((await invitationResponse).status()).toBe(201);
  const invitation = issued.invitations[0];
  if (!invitation) throw new Error("管理者の招待コード発行を確認できませんでした。");
  await expect(page.getByRole("dialog", { name: "招待コードを控える", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "保存したので閉じる", exact: true }).click();
  const invitedContext = await browser.newContext({ baseURL });
  const invitedPage = await invitedContext.newPage();
  await maskSecretDisplays(invitedPage);
  const invitedCdp = await invitedContext.newCDPSession(invitedPage);
  await invitedCdp.send("WebAuthn.enable");
  await invitedCdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  await invitedPage.goto("/invite");
  await invitedPage.getByLabel("招待コード", { exact: true }).fill(invitation.code);
  await invitedPage.getByRole("button", { name: "新しいパスキーを登録", exact: true }).click();
  await expect(invitedPage.getByRole("dialog", { name: "復旧コードを保存", exact: true })).toBeVisible();
  await invitedPage.getByRole("button", { name: "保存したので閉じる", exact: true }).click();
  await expect(invitedPage.getByRole("heading", { name: "自分の設定", exact: true })).toBeVisible();
  expect((await invitedContext.request.get("/api/admin/me")).status()).toBe(200);
  expect((await (await invitedContext.request.get("/api/admin/security")).json()).admins.length).toBe(2);
  const usedInvitation = await browser.newContext({ baseURL });
  expect((await usedInvitation.request.post("/api/invitations/begin", { headers: { Origin: baseURL! }, data: { code: invitation.code } })).status()).toBe(403);
  await usedInvitation.close(); await invitedContext.close();


  });
  test("復旧後に旧資格を失効", async ({ browser, baseURL }) => {
  const beforeRecovery = await context.cookies();
  recoveryContext = await browser.newContext({ baseURL });
  recoveryPage = await recoveryContext.newPage();
  await maskSecretDisplays(recoveryPage);
  const recoveryCdp = await recoveryContext.newCDPSession(recoveryPage);
  await recoveryCdp.send("WebAuthn.enable");
  await recoveryCdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  await recoveryPage.goto("/recover");
  let recoveryBegins = 0;
  recoveryPage.on("request", (request) => { if (request.url().endsWith("/api/recovery/begin")) recoveryBegins++; });
  await recoveryPage.evaluate(() => {
    const original = navigator.credentials.create.bind(navigator.credentials);
    let canceled = false;
    navigator.credentials.create = async (options?: CredentialCreationOptions) => {
      if (!canceled) { canceled = true; throw new DOMException("認証をキャンセルしました。", "NotAllowedError"); }
      return original(options);
    };
  });
  await recoveryPage.getByLabel("管理者のメールアドレス", { exact: true }).fill("demo@example.test");
  await recoveryPage.getByLabel("復旧コード", { exact: true }).fill(initialCodes[0]!);
  await recoveryPage.getByRole("button", { name: "新しいパスキーを登録", exact: true }).click();
  await expect(recoveryPage.locator('.auth-panel [role="alert"]')).toHaveText("パスキーの登録は完了していません。端末の案内を確認して、もう一度お試しください。");
  expect((await recoveryContext.request.get("/api/admin/me")).status()).toBe(401);
  await recoveryPage.getByRole("button", { name: "新しいパスキーを登録", exact: true }).click();
  await expect(recoveryPage.getByRole("dialog", { name: "復旧コードを保存", exact: true })).toBeVisible();
  expect(recoveryBegins).toBe(1);
  await recoveryPage.getByRole("button", { name: "保存したので閉じる", exact: true }).click();
  await expect(recoveryPage.getByRole("heading", { name: "自分の設定", exact: true })).toBeVisible();
  expect((await recoveryContext.request.get("/api/admin/me")).status()).toBe(200);
  const recoveredSecurity = await (await recoveryContext.request.get("/api/admin/security")).json();
  expect(recoveredSecurity.passkeys.length).toBe(1);
  expect(recoveredSecurity.recoveryConfigured).toBe(true);
  const oldSession = await browser.newContext({ baseURL });
  await oldSession.addCookies(beforeRecovery);
  expect((await oldSession.request.get("/api/admin/me")).status()).toBe(401);
  await oldSession.close();
  const oldRecovery = await browser.newContext({ baseURL });
  expect((await oldRecovery.request.post("/api/recovery/begin", { headers: { Origin: baseURL! }, data: { email: "demo@example.test", code: initialCodes[1]! } })).status()).toBe(403);
  await oldRecovery.close();
  // 復旧前の端末に残るパスキーも、サーバー側で失効済みとして拒否する。
  await context.clearCookies();
  await page.goto("/");
  const oldPasskeyResponse = page.waitForResponse((response) => response.url().endsWith("/passkey/verify-authentication"));
  await page.getByRole("button", { name: "パスキーでログイン", exact: true }).click();
  expect([400, 401]).toContain((await oldPasskeyResponse).status());
  expect((await context.request.get("/api/admin/me")).status()).toBe(401);

  });
  test("承認した受付端末でQR入室・退室", async ({ browser, baseURL }) => {
  await runPeopleReceptionFlow(recoveryContext, browser, baseURL!);

  });
  test("履歴訂正・CSVと表示設定を保存", async ({ baseURL }) => {
  await runHistoryAppearanceFlow(recoveryPage, recoveryContext, baseURL!);

  });
});
