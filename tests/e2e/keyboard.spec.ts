import { test, expect } from "@playwright/test";

// 架空のAPI応答で画面とフォーカスだけを検査する。実DB・パスキー・実機の認証検証は別に行う。
test("初回読込はフォーカスを奪わず、登録フォームをキーボードで操作できる", async ({ page }) => {
  await page.route("**/api/admin/me", (route) => route.fulfill({ status: 401, json: { code: "UNAUTHENTICATED" } }));
  await page.route("**/api/setup/status", (route) => route.fulfill({ json: { completed: false } }));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "最初の管理者を登録" })).toBeVisible();
  await expect(page.locator("body")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "本文へ移動" })).toBeFocused();
  for (const label of ["設定コード", "表示名", "メールアドレス"]) {
    await page.keyboard.press("Tab");
    await expect(page.getByLabel(label, { exact: true })).toBeFocused();
  }
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "パスキーを登録", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("設定コード", { exact: true })).toBeFocused();
});

test("失敗・状態再確認・ログアウトの結果から次の操作へTabで進める", async ({ page }) => {
  let authenticated = false;
  await page.route("**/api/admin/me", (route) => authenticated
    ? route.fulfill({ json: { user: { id: "keyboard-check", name: "動作確認の管理者", email: "demo@example.test", emailVerified: false }, database: "connected" } })
    : route.fulfill({ status: 401, json: { code: "UNAUTHENTICATED" } }));
  await page.route("**/api/setup/status", (route) => route.fulfill({ json: { completed: true } }));
  await page.route("**/api/auth/passkey/generate-authenticate-options", (route) => route.fulfill({ status: 503, json: { code: "UNAVAILABLE" } }));
  await page.route("**/api/auth/sign-out", (route) => { authenticated = false; return route.fulfill({ json: { ok: true } }); });
  await page.goto("/");
  const login = page.getByRole("button", { name: "パスキーでログイン", exact: true });
  await expect(login).toBeVisible();
  await expect(page.locator("body")).toBeFocused();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(login).toBeFocused();
  await page.keyboard.press("Space");
  await expect(page.locator('.auth-panel [role="alert"]')).toBeFocused();
  await expect(page.locator('.auth-panel [role="alert"]')).toHaveText("ログインは完了していません。パスキーを選び直してお試しください。");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "状態を再確認", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "パスキーでログイン", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(login).toBeFocused();

  // サーバーの状態変化を架空応答で表し、画面の成功遷移に限って検査する。
  await page.keyboard.press("Space");
  await expect(page.locator('.auth-panel [role="alert"]')).toBeFocused();
  authenticated = true;
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "接続を確認できました", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "ログアウト", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator('.auth-panel [role="status"]')).toHaveText("ログアウトしました。");
  await expect(page.locator('.auth-panel [role="status"]')).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(login).toBeFocused();
});

test("処理中に別の場所へ移したフォーカスを結果表示で奪わない", async ({ page }) => {
  let finishRequest!: () => void;
  const waiting = new Promise<void>((resolve) => { finishRequest = resolve; });
  await page.route("**/api/admin/me", (route) => route.fulfill({ status: 401, json: { code: "UNAUTHENTICATED" } }));
  await page.route("**/api/setup/status", (route) => route.fulfill({ json: { completed: true } }));
  await page.route("**/api/auth/passkey/generate-authenticate-options", async (route) => {
    await waiting;
    await route.fulfill({ status: 503, json: { code: "UNAVAILABLE" } });
  });
  await page.goto("/");
  const login = page.getByRole("button", { name: "パスキーでログイン", exact: true });
  await expect(login).toBeVisible();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "認証を確認しています…", exact: true })).toBeDisabled();
  const skip = page.getByRole("link", { name: "本文へ移動" });
  await skip.focus();
  finishRequest();
  await expect(page.locator('.auth-panel [role="alert"]')).toBeVisible();
  await expect(login).toBeEnabled();
  await expect(skip).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "状態を再確認", exact: true })).toBeFocused();
});
