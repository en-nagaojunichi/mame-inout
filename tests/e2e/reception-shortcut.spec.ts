import { test, expect, type Locator, type Page } from "@playwright/test";

const adminName = "導線確認の管理者";

async function mockNavigation(page: Page, authenticated = true, administratorCount = 20) {
  const unexpected: string[] = [];
  const admins = Array.from({ length: administratorCount }, (_, index) => ({
    id: `navigation-admin-${index}`, name: `${adminName}${index + 1}`,
    email: `navigation-${index + 1}@example.test`, emailVerified: false, status: "ACTIVE",
  }));
  // 固定ボタンとモーダルの操作だけを架空応答で検査し、認証・DB・実端末の結果とは分ける。
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (value: unknown) => route.fulfill({ json: value });
    if (path === "/api/appearance") return json({ displayName: "入退出管理システム", version: 1, iconUrl: "/api/appearance/icon?v=1", faviconUrl: "/api/appearance/favicon?v=1", customIcon: false, customFavicon: false });
    if (path === "/api/appearance/icon" || path === "/api/appearance/favicon") return route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#2d6252"/></svg>' });
    if (path === "/api/admin/me") return authenticated
      ? json({ user: { ...admins[0] }, database: "connected" })
      : route.fulfill({ status: 401, json: { code: "UNAUTHENTICATED", message: "パスキーでログインしてください。" } });
    if (path === "/api/admin/security") return json({ currentUserId: admins[0].id, recentAuth: true, recoveryConfigured: true, passkeys: [], admins, adminsNextCursor: null });
    if (path === "/api/devices/current") return route.fulfill({ status: 401, json: { code: "DEVICE_REQUIRED", message: "受付端末の登録が必要です。" } });
    if (path === "/api/devices/application") return route.fulfill({ status: 404, json: { code: "APPLICATION_NOT_FOUND", message: "申請はありません。" } });
    unexpected.push(`${route.request().method()} ${path}`);
    return route.fulfill({ status: 503, json: { code: "UNEXPECTED_REQUEST", message: "想定外の要求です。" } });
  });
  return unexpected;
}

async function keyboardActivate(page: Page, target: Locator) {
  for (let index = 0; index < 100; index++) {
    await page.keyboard.press("Tab");
    if (await target.evaluate((element) => element === document.activeElement)) {
      await page.keyboard.press("Enter");
      return;
    }
  }
  throw new Error("QR受付のリンクへTabキーで到達できませんでした。");
}

for (const width of [320, 390, 1280]) {
  test(`${width}pxでQR受付への導線を右下に保ち、末尾の管理操作と印刷を妨げない`, async ({ page }) => {
    const unexpected = await mockNavigation(page);
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/settings/administrators");
    const shortcut = page.locator(".reception-shortcut");
    await expect(shortcut).toHaveAccessibleName("QR受付を開く");
    await expect(shortcut).toHaveAttribute("href", "/reception");
    await expect(shortcut).toBeVisible();
    const before = await shortcut.boundingBox();
    expect(before).not.toBeNull();
    expect(before!.width).toBeGreaterThanOrEqual(44);
    expect(before!.height).toBeGreaterThanOrEqual(44);
    expect(before!.x).toBeGreaterThanOrEqual(0);
    expect(width - before!.x - before!.width).toBeGreaterThanOrEqual(8);
    expect(width - before!.x - before!.width).toBeLessThanOrEqual(64);
    expect(844 - before!.y - before!.height).toBeGreaterThanOrEqual(8);
    expect(844 - before!.y - before!.height).toBeLessThanOrEqual(64);
    await expect(page.getByRole("main").getByRole("button", { name: /管理者を停止/ })).toHaveCount(20);
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    const after = await shortcut.boundingBox();
    expect(after!.x).toBeCloseTo(before!.x, 0);
    expect(after!.y).toBeCloseTo(before!.y, 0);
    const lastAction = page.getByRole("main").getByRole("button", { name: /管理者を停止/ }).last();
    await expect(lastAction).toBeInViewport();
    const action = await lastAction.boundingBox();
    // 最下部までスクロールしたとき、最後の操作に固定導線を重ねない余白がある。
    expect(action!.y + action!.height).toBeLessThanOrEqual(after!.y - 4);
    expect(await shortcut.evaluate((element) => {
      const box = element.getBoundingClientRect();
      return element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
    })).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    // 項目が少なく版表示が最初から見えるページでも、固定リンクへ重ねない。
    const shortPageUnexpected = await mockNavigation(page, true, 2);
    await page.reload();
    const version = page.locator(".app-version");
    await expect(version).toContainText("バージョン");
    await version.scrollIntoViewIfNeeded();
    const versionBox = await version.boundingBox(), shortcutBox = await shortcut.boundingBox();
    expect(versionBox).not.toBeNull();
    expect(shortcutBox).not.toBeNull();
    expect(versionBox!.x + versionBox!.width <= shortcutBox!.x || versionBox!.y + versionBox!.height <= shortcutBox!.y).toBe(true);
    await page.emulateMedia({ media: "print" });
    await expect(shortcut).not.toBeVisible();
    expect(unexpected).toEqual([]);
    expect(shortPageUnexpected).toEqual([]);
  });
}

test("メニューと確認モーダルを優先し、閉じた後はキーボードだけで同じサイトの受付を開ける", async ({ page }) => {
  const unexpected = await mockNavigation(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/settings/administrators");
  const shortcut = page.locator(".reception-shortcut");
  await expect(shortcut).toBeVisible();
  const menuButton = page.getByRole("button", { name: "管理メニューを開く", exact: true });
  await menuButton.click();
  await expect(page.getByRole("dialog", { name: "管理メニュー", exact: true })).toBeVisible();
  await expect(shortcut).not.toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menuButton).toBeFocused();
  await expect(shortcut).toBeVisible();
  const opener = page.getByRole("main").getByRole("button", { name: new RegExp(`名前を変更.*${adminName}1$`) });
  await opener.click();
  const modal = page.getByRole("dialog", { name: "管理者の名前を変更", exact: true });
  await expect(modal).toBeVisible();
  await expect(modal.getByLabel("管理者の名前", { exact: true })).toHaveValue(`${adminName}1`);
  await expect(modal).not.toContainText("メールアドレスやログイン方法はそのままです");
  const currentUrl = page.url();
  const floatingBox = await shortcut.boundingBox();
  if (floatingBox) await page.mouse.click(floatingBox.x + floatingBox.width / 2, floatingBox.y + floatingBox.height / 2);
  await expect(page).toHaveURL(currentUrl);
  await expect(modal).toBeVisible();
  await shortcut.evaluate((element) => (element as HTMLElement).focus());
  expect(await modal.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  for (let index = 0; index < 6; index++) {
    await page.keyboard.press("Tab");
    expect(await modal.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(opener).toBeFocused();
  await expect(page.getByRole("main").locator(".item-meta .small-label")).toHaveCount(0);
  await expect(page.getByText("管理者の画面", { exact: true })).toHaveCount(0);
  await expect(page.getByText("開発中の検証版です。動作確認用の情報を使用してください。", { exact: true })).toHaveCount(0);
  const origin = new URL(currentUrl).origin;
  await keyboardActivate(page, shortcut);
  await expect(page).toHaveURL(`${origin}/reception`);
  await expect(page.getByRole("heading", { name: "QR受付", level: 1, exact: true })).toBeVisible();
  await expect(page.getByRole("main")).toContainText("受付端末");
  await expect(shortcut).toHaveCount(0);
  expect(unexpected).toEqual([]);
});

test("管理者としてログインしていない画面には固定の受付導線を出さない", async ({ page }) => {
  const unexpected = await mockNavigation(page, false);
  await page.goto("/settings/administrators");
  await expect(page.getByRole("heading", { name: "管理者のログインが必要です", exact: true })).toBeVisible();
  await expect(page.locator(".reception-shortcut")).toHaveCount(0);
  expect(unexpected).toEqual([]);
});
