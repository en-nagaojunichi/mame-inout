import { test, expect, type Page } from "@playwright/test";

const createdAt = "2026-11-07T00:00:00.000Z";
const device = {
  id: "0a4baad3-c930-4af5-a95c-3a79f1c69ac6", name: "入口の受付スマートフォン", status: "PENDING",
  confirmationCode: "1A2B3C4D", applicationExpiresAt: "2026-11-07T01:00:00.000Z", expiresAt: null, approvedAt: null, lastUsedAt: null, createdAt,
};

async function mockSettings(page: Page, recentAuth = () => true, currentUserId = () => "demo-admin", names = () => ({ admin: "動作確認の管理者", device: device.name })) {
  await page.route("**/api/admin/me", (route) => route.fulfill({ json: { user: { id: currentUserId(), name: names().admin, email: "demo@example.test", emailVerified: false }, database: "connected" } }));
  await page.route("**/api/admin/security", (route) => route.fulfill({ json: {
    currentUserId: currentUserId(), recoveryConfigured: true, recentAuth: recentAuth(),
    passkeys: [{ id: "first", name: "個人のスマートフォン", createdAt, lastUsedAt: createdAt }, { id: "second", name: "予備のパスキー", createdAt, lastUsedAt: null }],
    admins: [{ id: "demo-admin", name: names().admin, email: "demo@example.test", emailVerified: false, status: "ACTIVE" }],
  } }));
  await page.route("**/api/admin/devices", (route) => route.fulfill({ json: { items: [{ ...device, name: names().device }], nextCursor: null } }));
}

async function mockPasskeyAuthentication(page: Page, onVerified?: () => void) {
  const calls = { prompts: 0, verified: 0, cancel: false };
  await page.exposeFunction("recordPasskeyPrompt", () => { calls.prompts++; return calls.cancel; });
  await page.addInitScript(() => {
    const testWindow = window as typeof window & { recordPasskeyPrompt: () => Promise<boolean> };
    // 認証器の呼出しだけを観測するUI試験。署名検証と実機パスキーの試験は別に行う。
    Object.defineProperty(navigator.credentials, "get", { configurable: true, value: async () => {
      if (await testWindow.recordPasskeyPrompt()) throw new DOMException("利用者がキャンセルしました。", "NotAllowedError");
      return {
        id: "AQ", rawId: new Uint8Array([1]).buffer, type: "public-key", authenticatorAttachment: "platform",
        response: { authenticatorData: new ArrayBuffer(37), clientDataJSON: new ArrayBuffer(1), signature: new ArrayBuffer(1), userHandle: null },
        getClientExtensionResults: () => ({}),
      };
    } });
  });
  await page.route("**/api/auth/passkey/generate-authenticate-options", (route) => route.fulfill({ json: {
    challenge: "AQIDBA", rpId: new URL(route.request().url()).hostname, userVerification: "required", allowCredentials: [],
  } }));
  await page.route("**/api/auth/passkey/verify-authentication", (route) => {
    calls.verified++; onVerified?.();
    return route.fulfill({ json: { ok: true } });
  });
  return calls;
}

// 架空のAPI応答で画面とモーダルを検査する。認証・排他・実機の検証結果とは分ける。
test("管理設定の確認をモーダルで示し、Tab・Escape・フォーカス復帰を守る", async ({ page }) => {
  await mockSettings(page);
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "自分の設定", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "パスキー", exact: true })).toBeVisible();
  const rename = page.getByRole("button", { name: /名前を変更.*個人のスマートフォン/ });
  await rename.click();
  const modal = page.getByRole("dialog", { name: "パスキーの名前を変更" });
  await expect(modal).toBeVisible();
  await expect(modal.getByRole("button", { name: "キャンセル" })).toBeFocused();
  for (let index = 0; index < 8; index++) {
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.activeElement?.closest("dialog") !== null)).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(modal).not.toBeVisible();
  await expect(rename).toBeFocused();
  await page.goto("/settings/devices");
  await page.getByRole("button", { name: /承認.*入口の受付スマートフォン/ }).click();
  const approval = page.getByRole("dialog", { name: "受付端末を承認" });
  await expect(approval.getByText("1A2B3C4D", { exact: true })).toBeVisible();
  await expect(approval.getByLabel("有効期間（日）")).toHaveValue("30");
  await page.keyboard.press("Escape");
  await page.screenshot({ path: "test-results/settings-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "test-results/settings-mobile.png", fullPage: true });
});

test("直近に本人確認した管理者は、受付端末を承認するときにパスキーを再提示しない", async ({ page }) => {
  await mockSettings(page);
  const authentication = await mockPasskeyAuthentication(page);
  let approvalPosts = 0;
  await page.route(`**/api/admin/devices/${device.id}/approve`, (route) => {
    approvalPosts++;
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto("/settings/devices");
  await page.getByRole("button", { name: /承認.*入口の受付スマートフォン/ }).click();
  const modal = page.getByRole("dialog", { name: "受付端末を承認" });
  await modal.getByRole("button", { name: "承認", exact: true }).click();
  await expect(modal).not.toBeVisible();
  await expect(page.getByRole("status")).toHaveText("変更を保存しました。");
  expect({ prompts: authentication.prompts, verified: authentication.verified, approvalPosts }).toEqual({ prompts: 0, verified: 0, approvalPosts: 1 });
});

test("本人確認の期限が切れている場合は、パスキーで本人確認してから受付端末を承認する", async ({ page }) => {
  let recentAuth = false;
  await mockSettings(page, () => recentAuth);
  const authentication = await mockPasskeyAuthentication(page, () => { recentAuth = true; });
  let approvalPosts = 0;
  await page.route(`**/api/admin/devices/${device.id}/approve`, (route) => {
    approvalPosts++;
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto("/settings/devices");
  await page.getByRole("button", { name: /承認.*入口の受付スマートフォン/ }).click();
  const modal = page.getByRole("dialog", { name: "受付端末を承認" });
  await modal.getByRole("button", { name: "本人確認して承認", exact: true }).click();
  await expect(modal).not.toBeVisible();
  await expect(page.getByRole("status")).toHaveText("変更を保存しました。");
  expect({ prompts: authentication.prompts, verified: authentication.verified, approvalPosts }).toEqual({ prompts: 1, verified: 1, approvalPosts: 1 });
});

test("承認直前の本人確認期限切れでは自動再送せず、認証キャンセル後も承認済みと表示しない", async ({ page }) => {
  let recentAuth = true;
  await mockSettings(page, () => recentAuth);
  const authentication = await mockPasskeyAuthentication(page, () => { recentAuth = true; });
  let approvalPosts = 0;
  await page.route(`**/api/admin/devices/${device.id}/approve`, (route) => {
    approvalPosts++;
    if (approvalPosts === 1) {
      recentAuth = false;
      return route.fulfill({ status: 403, json: { code: "REAUTH_REQUIRED", message: "この操作には、もう一度パスキーでの本人確認が必要です。" } });
    }
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto("/settings/devices");
  await page.getByRole("button", { name: /承認.*入口の受付スマートフォン/ }).click();
  const modal = page.getByRole("dialog", { name: "受付端末を承認" });
  await modal.getByLabel("有効期間（日）").fill("7");
  await modal.getByRole("button", { name: "承認", exact: true }).click();
  await expect(modal.getByRole("alert")).toContainText("本人確認");
  const retry = modal.getByRole("button", { name: "本人確認して承認", exact: true });
  await expect(retry).toBeEnabled();
  await expect(modal.getByLabel("有効期間（日）")).toHaveValue("7");
  expect({ prompts: authentication.prompts, approvalPosts }).toEqual({ prompts: 0, approvalPosts: 1 });

  authentication.cancel = true;
  await retry.click();
  await expect(modal.getByRole("alert")).toContainText("本人確認は完了していません");
  await expect(retry).toBeEnabled();
  await expect(page.getByText("変更を保存しました。", { exact: true })).not.toBeVisible();
  expect({ prompts: authentication.prompts, verified: authentication.verified, approvalPosts }).toEqual({ prompts: 1, verified: 0, approvalPosts: 1 });

  authentication.cancel = false;
  await retry.click();
  await expect(modal).not.toBeVisible();
  await expect(page.getByRole("status")).toHaveText("変更を保存しました。");
  expect({ prompts: authentication.prompts, verified: authentication.verified, approvalPosts }).toEqual({ prompts: 2, verified: 1, approvalPosts: 2 });
});

test("設定表示後に本人確認が期限切れになった場合、パスキーを突然開かず確認操作を求める", async ({ page }) => {
  let recentAuth = true;
  await mockSettings(page, () => recentAuth);
  const authentication = await mockPasskeyAuthentication(page, () => { recentAuth = true; });
  let approvalPosts = 0;
  await page.route(`**/api/admin/devices/${device.id}/approve`, (route) => {
    approvalPosts++;
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto("/settings/devices");
  await page.getByRole("button", { name: /承認.*入口の受付スマートフォン/ }).click();
  const modal = page.getByRole("dialog", { name: "受付端末を承認" });
  await expect(modal.getByRole("button", { name: "承認", exact: true })).toBeEnabled();
  recentAuth = false;
  await modal.getByRole("button", { name: "承認", exact: true }).click();
  await expect(modal.getByRole("alert")).toContainText("本人確認");
  const retry = modal.getByRole("button", { name: "本人確認して承認", exact: true });
  await expect(retry).toBeEnabled();
  expect({ prompts: authentication.prompts, approvalPosts }).toEqual({ prompts: 0, approvalPosts: 0 });
  await retry.click();
  await expect(modal).not.toBeVisible();
  await expect(page.getByRole("status")).toHaveText("変更を保存しました。");
  expect({ prompts: authentication.prompts, verified: authentication.verified, approvalPosts }).toEqual({ prompts: 1, verified: 1, approvalPosts: 1 });
});

test("本人確認後に別の管理者へ変わった場合、元の確認内容で受付端末を承認しない", async ({ page }) => {
  let currentUserId = "demo-admin";
  let recentAuth = false;
  await mockSettings(page, () => recentAuth, () => currentUserId);
  const authentication = await mockPasskeyAuthentication(page, () => {
    currentUserId = "another-admin"; recentAuth = true;
  });
  let approvalPosts = 0;
  await page.route(`**/api/admin/devices/${device.id}/approve`, (route) => {
    approvalPosts++;
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto("/settings/devices");
  await page.getByRole("button", { name: /承認.*入口の受付スマートフォン/ }).click();
  const modal = page.getByRole("dialog", { name: "受付端末を承認" });
  await modal.getByRole("button", { name: "本人確認して承認", exact: true }).click();
  await expect(modal.getByRole("alert")).toHaveText("ログインしている管理者が変わりました。キャンセルして、一覧を更新してからやり直してください。");
  await expect(modal).toBeVisible();
  await expect(modal.getByRole("button", { name: /承認$/ })).toBeDisabled();
  await expect(modal.getByRole("button", { name: "キャンセル", exact: true })).toBeEnabled();
  await expect(page.getByText("変更を保存しました。", { exact: true })).not.toBeVisible();
  expect({ prompts: authentication.prompts, verified: authentication.verified, approvalPosts }).toEqual({ prompts: 1, verified: 1, approvalPosts: 0 });
});

for (const target of [
  { key: "admin", title: "管理者の名前を変更", label: "管理者の名前", before: "動作確認の管理者", after: "新しい管理者名", path: "/api/admin/administrators/demo-admin/name", status: "有効" },
  { key: "device", title: "QR受付端末の名前を変更", label: "端末名", before: device.name, after: "玄関のQR受付端末", path: `/api/admin/devices/${device.id}/name`, status: "承認待ち" },
] as const) {
  test(`${target.title}では、キャンセルと通信失敗で名前や状態を変えず、再認証せず再保存できる`, async ({ page }) => {
    const names = { admin: "動作確認の管理者", device: device.name };
    await mockSettings(page, () => false, () => "demo-admin", () => names);
    const authentication = await mockPasskeyAuthentication(page);
    const posts: { method: string; path: string; body: unknown }[] = [];
    await page.route("**/api/admin/**", (route) => {
      const request = route.request();
      if (request.method() !== "POST") return route.fallback();
      const path = new URL(request.url()).pathname;
      posts.push({ method: request.method(), path, body: request.postDataJSON() });
      // 保存に失敗しても画面の入力は保ち、再操作した要求だけを成功させる。
      if (posts.length === 1) return route.abort("failed");
      if (path !== target.path) return route.fulfill({ status: 404, json: { message: "対象の操作を確認できませんでした。" } });
      names[target.key] = target.after;
      return route.fulfill({ json: { ok: true } });
    });
    await page.goto(target.key === "admin" ? "/settings/administrators" : "/settings/devices");
    const rename = page.getByRole("button", { name: new RegExp(`名前を変更.*${target.before}`) });
    await rename.click();
    const modal = page.getByRole("dialog", { name: target.title, exact: true });
    const field = modal.getByLabel(target.label, { exact: true });
    await expect(field).toHaveValue(target.before);
    await field.fill("保存しない名前");
    await modal.getByRole("button", { name: "キャンセル", exact: true }).click();
    await expect(modal).not.toBeVisible();
    expect(posts).toHaveLength(0);
    await rename.click();
    await expect(field).toHaveValue(target.before);
    await field.fill(target.after);
    await modal.getByRole("button", { name: "保存", exact: true }).click();
    await expect(modal.getByRole("alert")).toHaveText("通信できませんでした。接続を確認して、もう一度お試しください。");
    await expect(field).toHaveValue(target.after);
    await expect(page.locator(".item-list h3").filter({ hasText: target.before })).toBeVisible();
    await expect(page.getByText("変更を保存しました。", { exact: true })).not.toBeVisible();
    await modal.getByRole("button", { name: "保存", exact: true }).click();
    await expect(modal).not.toBeVisible();
    await expect(page.getByRole("status")).toHaveText("変更を保存しました。");
    const saved = page.locator(".item-list > li").filter({ has: page.locator("h3").filter({ hasText: target.after }) });
    await expect(saved).toBeVisible();
    await expect(saved.locator("h3")).toContainText(target.status);
    if (target.key === "device") await expect(saved.getByText("1A2B3C4D", { exact: true })).toBeVisible();
    expect(posts).toEqual([
      { method: "POST", path: target.path, body: { name: target.after } },
      { method: "POST", path: target.path, body: { name: target.after } },
    ]);
    expect({ prompts: authentication.prompts, verified: authentication.verified }).toEqual({ prompts: 0, verified: 0 });
  });
}

test("受付端末の申請と承認確認で、資格受取に失敗した時は登録済みと表示しない", async ({ page }) => {
  let applied = false;
  let approved = false;
  let failedClaim = false;
  let credentialSaved = false;
  await page.route("**/api/devices/current", (route) => credentialSaved
    ? route.fulfill({ json: { device: { ...device, status: "APPROVED", expiresAt: "2026-12-07T00:00:00.000Z" }, claimed: true } })
    : route.fulfill({ status: 401, json: { code: "DEVICE_UNAUTHENTICATED" } }));
  await page.route("**/api/devices/application", (route) => applied
    ? route.fulfill({ json: { device: { ...device, status: approved ? "APPROVED" : "PENDING", expiresAt: approved ? "2026-12-07T00:00:00.000Z" : null }, claimed: false } })
    : route.fulfill({ status: 401, json: { code: "APPLICATION_DENIED" } }));
  await page.route("**/api/devices/apply", (route) => { applied = true; return route.fulfill({ status: 201, json: { device, claimed: false } }); });
  await page.route("**/api/devices/claim", (route) => {
    if (!failedClaim) { failedClaim = true; return route.fulfill({ status: 503, json: { message: "通信できませんでした。もう一度お試しください。" } }); }
    credentialSaved = true; return route.fulfill({ json: { ok: true, expiresAt: "2026-12-07T00:00:00.000Z" } });
  });
  await page.goto("/device");
  await expect(page.getByRole("heading", { name: "QR受付に使う端末を登録", exact: true })).toBeVisible();
  await expect(page.getByText("この画面では管理者のログインは不要です。管理者の個人用パスキーは、ここに登録しないでください。", { exact: true })).toBeVisible();
  await page.getByLabel("端末名", { exact: true }).fill(device.name);
  await page.getByRole("button", { name: "管理者へ承認を申請" }).click();
  await expect(page.getByText("承認を待っています", { exact: true })).toBeVisible();
  approved = true;
  await page.getByRole("button", { name: "承認の状態を確認" }).click();
  await expect(page.getByText("管理者が承認しました", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "このブラウザで利用を開始" }).click();
  await expect(page.getByText("通信できませんでした。もう一度お試しください。", { exact: true })).toBeVisible();
  await expect(page.getByText("このブラウザで登録済みです", { exact: true })).not.toBeVisible();
  await page.getByRole("button", { name: "このブラウザで利用を開始" }).click();
  await expect(page.getByText("このブラウザで登録済みです", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }))).toEqual({ local: 0, session: 0 });
});

test("申請の受取済みだけでは登録成功とせず、同じ資格を保存し直して現在の登録を照合する", async ({ page }) => {
  let credentialSaved = false;
  let claims = 0;
  const approvedDevice = { ...device, status: "APPROVED", expiresAt: "2099-12-07T00:00:00.000Z" };
  await page.route("**/api/devices/current", (route) => credentialSaved
    ? route.fulfill({ json: { device: approvedDevice, claimed: true } })
    : route.fulfill({ status: 401, json: { code: "DEVICE_UNAUTHENTICATED" } }));
  await page.route("**/api/devices/application", (route) => route.fulfill({ json: { device: approvedDevice, claimed: true } }));
  await page.route("**/api/devices/claim", (route) => { claims++; credentialSaved = claims >= 2; return route.fulfill({ json: { ok: true, expiresAt: approvedDevice.expiresAt } }); });
  await page.goto("/device");
  await expect(page.getByText(/同じ登録を受け取り直してください/)).toBeVisible();
  await expect(page.getByText("このブラウザで登録済みです", { exact: true })).not.toBeVisible();
  const claim = page.getByRole("button", { name: "このブラウザで利用を開始", exact: true });
  await claim.click();
  await expect(page.getByRole("link", { name: "QR受付を開く", exact: true })).not.toBeVisible();
  await claim.click();
  await expect(page.getByText("このブラウザで登録済みです", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "QR受付を開く", exact: true }).click();
  await expect(page.getByRole("button", { name: "カメラを起動", exact: true })).toBeVisible();
  expect(claims).toBe(2);
});

test("端末の状態を通信失敗で取得できない場合、新規申請を促さず登録状態の再確認を案内する", async ({ page }) => {
  let failed = true;
  await page.route("**/api/devices/current", (route) => failed ? route.abort("failed") : route.fulfill({ json: { device: { ...device, status: "APPROVED", expiresAt: "2099-12-07T00:00:00.000Z" }, claimed: true } }));
  await page.goto("/device");
  await expect(page.getByRole("heading", { name: "登録の状態を確認できません", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "管理者へ承認を申請", exact: true })).toHaveCount(0);
  failed = false;
  await page.getByRole("button", { name: "登録の状態を再確認", exact: true }).click();
  await expect(page.getByText("このブラウザで登録済みです", { exact: true })).toBeVisible();
});

test("招待・復旧の入力エラーではコードをURLや永続ストレージへ移さず、再試行できる", async ({ page }) => {
  const code = "a".repeat(43);
  for (const entry of ["invite", "recover"]) {
    await page.route(entry === "invite" ? "**/api/invitations/begin" : "**/api/recovery/begin", (route) => route.fulfill({ status: 403, json: { message: "コードが無効か、期限が切れています。管理者に確認してください。" } }));
    await page.goto(`/${entry}`);
    if (entry === "recover") await page.getByLabel("管理者のメールアドレス").fill("demo@example.test");
    const field = page.getByLabel(entry === "invite" ? "招待コード" : "復旧コード", { exact: true });
    await field.fill(code);
    await page.getByRole("button", { name: "新しいパスキーを登録" }).click();
    await expect(page.locator('.auth-panel [role="alert"]')).toHaveText("コードが無効か、期限が切れています。管理者に確認してください。");
    await expect(field).toHaveValue(code);
    expect(page.url()).not.toContain(code);
    expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }))).toEqual({ local: 0, session: 0 });
    await expect(page.getByRole("button", { name: "新しいパスキーを登録" })).toBeEnabled();
  }
});

test("復旧の入口で残ったログイン状態を終了し、コードを保持して再試行できる", async ({ page }) => {
  let signedOut = false;
  let attempts = 0;
  await page.route("**/api/recovery/begin", (route) => {
    attempts++;
    return signedOut
      ? route.fulfill({ status: 403, json: { message: "コードを確認してください。" } })
      : route.fulfill({ status: 403, json: { code: "SIGN_OUT_REQUIRED", message: "先にログアウトしてから、この画面を開き直してください。" } });
  });
  await page.route("**/api/auth/sign-out", (route) => { signedOut = true; return route.fulfill({ json: { ok: true } }); });
  await page.goto("/recover");
  await page.getByLabel("管理者のメールアドレス").fill("demo@example.test");
  await page.getByLabel("復旧コード", { exact: true }).fill("a".repeat(43));
  await page.getByRole("button", { name: "新しいパスキーを登録" }).click();
  await page.getByRole("button", { name: "このブラウザからログアウトして続ける" }).click();
  await expect(page.locator('.auth-panel [role="status"]')).toHaveText("このブラウザからログアウトしました。入力したコードで、もう一度パスキーの登録を始めてください。");
  await expect(page.getByLabel("復旧コード", { exact: true })).toHaveValue("a".repeat(43));
  await page.getByRole("button", { name: "新しいパスキーを登録" }).click();
  await expect(page.locator('.auth-panel [role="alert"]')).toHaveText("コードを確認してください。");
  expect(attempts).toBe(2);
});
